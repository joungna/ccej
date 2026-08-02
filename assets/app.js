/* =========================================================================
   CCEJ Press Knowledge Map — Network Edition
   Vanilla JS + D3 v7 force-directed network.
   - 모든 글이 하나의 공간에 산포 (월별 클러스터 제거)
   - 점 속에 대표 사진 (images.weserv.nl 썸네일 프록시, 실패 시 원본 → 색상)
   - 점 크기 = 본문 길이 비례
   - 태그 유사도(IDF 가중) 기반 링크로 연결, 지속적으로 살아 움직이는 시뮬레이션
   Data: ./data/search-index.json  (초기 노드)
         ./data/thumbs.json        (id → [대표이미지, 본문길이])
         ./data/posts.json         (상세 패널용, 지연 로드)
         ./data/months.json, ./data/tags.json (칩/필터)
   ========================================================================= */

(() => {
  "use strict";

  /* ----------------------------- Constants ------------------------------ */

  const DATA_BASE = "./data/";

  const CATEGORY_COLORS = {
    "정치": "#3b82f6",
    "경제": "#10b981",
    "부동산": "#f59e0b",
    "사회": "#8b5cf6",
    "도시": "#14b8a6",
    "통일": "#ef4444",
    "사법": "#6366f1",
    "소비자": "#ec4899",
    "국제": "#06b6d4",
    "기타": "#9ca3af",
  };
  const KNOWN_CATEGORIES = Object.keys(CATEGORY_COLORS).filter((c) => c !== "기타");

  const TYPE_ORDER = ["동영상", "이미지", "첨부파일", "보고서", "행사", "공지", "텍스트"];
  const TYPE_ICON = {
    "동영상": "🎬", "이미지": "🖼", "첨부파일": "📎", "보고서": "📄",
    "행사": "📅", "공지": "📢", "텍스트": "📝",
  };
  const ALL_TYPES = ["첨부파일", "이미지", "동영상", "행사", "공지", "보고서", "텍스트"];

  const WORLD_W = 2600;
  const WORLD_H = 1700;

  // 링크 생성 파라미터
  const EDGE_TAG_MAX_COUNT = 70;   // 이보다 흔한 태그는 쌍 생성에서 제외(허브 폭발 방지)
  const EDGES_PER_NODE = 3;        // 노드당 유지할 최대 링크 수 (유사도 상위)

  /* ------------------------------- State --------------------------------- */

  const state = {
    nodes: [],
    edges: [],
    adjacency: new Map(), // id -> Set(neighbor id)
    nodeById: new Map(),
    monthsMeta: null,
    tagsMeta: null,
    postsCache: null,
    postsPromise: null,
    postsLoaded: false,
    maxBodyLen: 300,
    filters: {
      year: "",
      months: new Set(),
      tags: new Set(),
      types: new Set(),
      keyword: "",
      hasAttachment: false,
      hasImage: false,
      hasVideo: false,
    },
    searchQuery: "",
    selectedId: null,
    hoverId: null,
    currentTransform: null,
    listBatchSize: 24,
    listRendered: 0,
    listItems: [],
  };

  let simulation, svg, zoomLayer, linksLayer, nodesLayer, zoomBehavior, dragBehavior;
  let linkSel = null;

  /* ------------------------------ DOM refs -------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const el = {
    tooltip: () => $("#tooltip"),
    searchInput: () => $("#search-input"),
    monthChips: () => $("#month-chips"),
    filterPanel: () => $("#filter-panel"),
    detailPanel: () => $("#detail-panel"),
    detailContent: () => $("#detail-content"),
    listPanel: () => $("#list-panel"),
    listContainer: () => $("#list-container"),
    listSentinel: () => $("#list-sentinel"),
    resultCount: () => $("#result-count"),
    postsStatus: () => $("#posts-status"),
    yearSelect: () => $("#filter-year"),
    typeChecks: () => document.querySelectorAll(".type-check"),
    boolChecks: () => document.querySelectorAll(".bool-check"),
    tagList: () => $("#tag-filter-list"),
    tagSearch: () => $("#tag-search"),
    resetBtn: () => $("#reset-filters"),
    mobileFilterToggle: () => $("#mobile-filter-toggle"),
    mobileListToggle: () => $("#mobile-list-toggle"),
    closeFilter: () => $("#close-filter"),
    closeDetail: () => $("#close-detail"),
    closeList: () => $("#close-list"),
    backdrop: () => $("#overlay-backdrop"),
  };

  /* ------------------------------ Utilities -------------------------------- */

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function normalizeCategory(catArr) {
    if (!Array.isArray(catArr)) return "기타";
    for (const c of catArr) {
      if (KNOWN_CATEGORIES.includes(c)) return c;
    }
    return "기타";
  }

  function pickTypeIcon(typeArr) {
    if (!Array.isArray(typeArr) || typeArr.length === 0) return "텍스트";
    for (const t of TYPE_ORDER) {
      if (typeArr.includes(t)) return t;
    }
    return typeArr[0];
  }

  // 대표 이미지 → 정사각 썸네일 프록시 URL
  function thumbUrl(u, size) {
    if (!u) return "";
    const clean = u.replace(/^https?:\/\//, "");
    return "https://images.weserv.nl/?url=" + encodeURIComponent(clean) +
      "&w=" + size + "&h=" + size + "&fit=cover&output=webp&q=75";
  }

  function bodyToHtml(body) {
    if (!body) return "<p class='text-gray-400'>본문이 없습니다.</p>";
    const escaped = escapeHtml(body);
    const lines = escaped.split(/\n/);
    let html = "";
    let inList = false;
    for (let raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (inList) { html += "</ul>"; inList = false; }
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        if (inList) { html += "</ul>"; inList = false; }
        const level = h[1].length === 1 ? 3 : h[1].length === 2 ? 4 : 5;
        html += `<h${level} class="text-gray-900">${h[2]}</h${level}>`;
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        if (!inList) { html += "<ul class='list-disc'>"; inList = true; }
        html += `<li>${line.replace(/^[-*]\s+/, "")}</li>`;
        continue;
      }
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${line}</p>`;
    }
    if (inList) html += "</ul>";
    return html || "<p class='text-gray-400'>본문이 없습니다.</p>";
  }

  /* ------------------------------ Data loading ------------------------------ */

  async function fetchJson(path) {
    const res = await fetch(DATA_BASE + path, { cache: "force-cache" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
  }

  function buildNodesFromSearchIndex(list) {
    return list.map((item) => {
      const category = normalizeCategory(item.category);
      const month = (item.date || "").slice(0, 7);
      // 초기 위치: 중앙 타원 내 랜덤 산포
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random());
      return {
        id: item.id,
        title: item.title || "(제목 없음)",
        date: item.date || "",
        month,
        year: (item.date || "").slice(0, 4),
        author: item.author || "",
        category,
        tags: item.tags || [],
        excerpt: item.body_excerpt || "",
        img: "",
        type: [],
        typeIcon: "텍스트",
        viewCount: 0,
        bodyLen: (item.body_excerpt || "").length,
        hasImage: false,
        hasAttachment: false,
        hasVideo: false,
        enriched: false,
        x: WORLD_W / 2 + Math.cos(a) * rr * WORLD_W * 0.33,
        y: WORLD_H / 2 + Math.sin(a) * rr * WORLD_H * 0.33,
      };
    });
  }

  // thumbs.json: { id: [imgUrl, bodyLen] }
  function applyThumbs(thumbs) {
    let maxLen = 300;
    for (const n of state.nodes) {
      const t = thumbs[n.id];
      if (!t) continue;
      n.img = t[0] || "";
      n.bodyLen = t[1] || n.bodyLen;
      if (n.bodyLen > maxLen) maxLen = n.bodyLen;
    }
    state.maxBodyLen = maxLen;
  }

  function enrichNodesWithPosts(postsArr) {
    const map = new Map();
    for (const p of postsArr) map.set(p.id, p);
    state.postsCache = map;
    for (const n of state.nodes) {
      const p = map.get(n.id);
      if (!p) continue;
      n.type = p.type || [];
      n.typeIcon = pickTypeIcon(p.type);
      n.viewCount = p.view_count || 0;
      n.hasImage = Array.isArray(p.images) && p.images.length > 0;
      n.hasAttachment = Array.isArray(p.attachments) && p.attachments.length > 0;
      n.hasVideo = Array.isArray(p.video_urls) && p.video_urls.length > 0;
      n.enriched = true;
    }
  }

  /* ------------------------------ Edges (태그 유사도) ------------------------------ */

  function buildEdges() {
    const nodes = state.nodes;
    const tagCount = {};
    nodes.forEach((n) => n.tags.forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));

    // 태그 → 노드 인덱스 역색인 (너무 흔한 태그 제외)
    const idx = {};
    nodes.forEach((n, i) => {
      n.tags.forEach((t) => {
        if (tagCount[t] >= 2 && tagCount[t] <= EDGE_TAG_MAX_COUNT) {
          (idx[t] = idx[t] || []).push(i);
        }
      });
    });

    // 쌍별 유사도 점수: 공유 태그의 IDF 가중 합
    const score = new Map();
    for (const t in idx) {
      const arr = idx[t];
      const w = 1 / Math.log2(1 + tagCount[t]);
      for (let a = 0; a < arr.length; a++) {
        for (let b = a + 1; b < arr.length; b++) {
          const k = arr[a] + "|" + arr[b];
          score.set(k, (score.get(k) || 0) + w);
        }
      }
    }

    // 노드별 후보 정렬 → 상위 EDGES_PER_NODE개 유지
    const byNode = Array.from({ length: nodes.length }, () => []);
    score.forEach((s, k) => {
      const sp = k.indexOf("|");
      const a = +k.slice(0, sp), b = +k.slice(sp + 1);
      byNode[a].push([b, s]);
      byNode[b].push([a, s]);
    });

    const chosen = new Set();
    const edges = [];
    byNode.forEach((cands, i) => {
      cands.sort((p, q) => q[1] - p[1]);
      let added = 0;
      for (const [j, s] of cands) {
        if (added >= EDGES_PER_NODE) break;
        const k = i < j ? i + "|" + j : j + "|" + i;
        if (chosen.has(k)) { added++; continue; }
        chosen.add(k);
        edges.push({ source: nodes[i].id, target: nodes[j].id, score: s });
        added++;
      }
    });

    // 고립 노드 fallback: 흔한 태그까지 포함해 가장 유사한 글 1개와 연결
    const connected = new Set();
    edges.forEach((e) => { connected.add(e.source); connected.add(e.target); });
    const fullIdx = {};
    nodes.forEach((n, i) => {
      n.tags.forEach((t) => {
        if (tagCount[t] >= 2) (fullIdx[t] = fullIdx[t] || []).push(i);
      });
    });
    nodes.forEach((n, i) => {
      if (connected.has(n.id)) return;
      const cand = new Map();
      n.tags.forEach((t) => {
        const arr = fullIdx[t];
        if (!arr) return;
        const w = 1 / Math.log2(1 + tagCount[t]);
        arr.forEach((j) => { if (j !== i) cand.set(j, (cand.get(j) || 0) + w); });
      });
      let best = -1, bestS = 0;
      cand.forEach((s, j) => { if (s > bestS) { bestS = s; best = j; } });
      if (best >= 0) {
        edges.push({ source: n.id, target: nodes[best].id, score: bestS });
        connected.add(n.id);
      }
    });

    // 인접 맵 (하이라이트용)
    const adj = new Map();
    edges.forEach((e) => {
      if (!adj.has(e.source)) adj.set(e.source, new Set());
      if (!adj.has(e.target)) adj.set(e.target, new Set());
      adj.get(e.source).add(e.target);
      adj.get(e.target).add(e.source);
    });
    state.adjacency = adj;
    state.edges = edges;
  }

  /* ------------------------------ Scales ------------------------------ */

  function radiusScale(bodyLen) {
    const maxLen = state.maxBodyLen || 300;
    const r = 8 + Math.sqrt(Math.max(bodyLen, 0) / maxLen) * 22;
    return Math.max(8, Math.min(30, r));
  }

  /* ------------------------------ Map rendering (D3) ------------------------------ */

  function initMap() {
    svg = d3.select("#map-svg");
    svg.attr("viewBox", `0 0 ${WORLD_W} ${WORLD_H}`).attr("preserveAspectRatio", "xMidYMid meet");

    zoomLayer = svg.append("g").attr("class", "zoom-layer");
    linksLayer = zoomLayer.append("g").attr("class", "links-layer");
    nodesLayer = zoomLayer.append("g").attr("class", "nodes-layer");

    zoomBehavior = d3.zoom()
      .scaleExtent([0.2, 14])
      .on("zoom", onZoom);
    svg.call(zoomBehavior);

    state.currentTransform = d3.zoomIdentity;

    const w = svg.node().clientWidth || 1000;
    const h = svg.node().clientHeight || 700;
    const initialScale = Math.min(w / WORLD_W, h / WORLD_H) * 1.35;
    const initialTransform = d3.zoomIdentity
      .translate(w / 2 - (WORLD_W / 2) * initialScale, h / 2 - (WORLD_H / 2) * initialScale)
      .scale(initialScale);
    svg.call(zoomBehavior.transform, initialTransform);

    dragBehavior = d3.drag()
      .on("start", dragStarted)
      .on("drag", dragged)
      .on("end", dragEnded);

    svg.on("pointermove", onPointerMove);
    svg.on("pointerleave", () => { hideTooltip(); clearHover(); });
    svg.on("click", onSvgClick);
  }

  function onZoom(event) {
    state.currentTransform = event.transform;
    zoomLayer.attr("transform", event.transform);
  }

  function dragStarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.25).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    const k = state.currentTransform ? state.currentTransform.k : 1;
    d.fx += event.dx / k;
    d.fy += event.dy / k;
  }
  function dragEnded(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  function buildSimulation() {
    simulation = d3.forceSimulation(state.nodes)
      .force("link", d3.forceLink(state.edges)
        .id((d) => d.id)
        .distance((e) => 60 + radiusScale(e.source.bodyLen) + radiusScale(e.target.bodyLen))
        .strength((e) => Math.min(0.65, 0.22 + e.score * 0.12)))
      .force("charge", d3.forceManyBody().strength(-90).distanceMax(560))
      .force("x", d3.forceX(WORLD_W / 2).strength(0.05))
      .force("y", d3.forceY(WORLD_H / 2).strength(0.075))
      .force("collide", d3.forceCollide((d) => radiusScale(d.bodyLen) + 3.5).strength(0.85))
      .velocityDecay(0.32)
      .alpha(1)
      .alphaDecay(0.016)
      .on("tick", ticked);

    // 은은한 상시 움직임: 주기적으로 살짝 데워서 네트워크가 계속 살아 움직이게
    setInterval(() => {
      if (document.hidden || !simulation) return;
      simulation.alphaTarget(0.018).restart();
      setTimeout(() => simulation && simulation.alphaTarget(0), 1600);
    }, 5200);
  }

  function renderLinks() {
    linkSel = linksLayer.selectAll("line.link")
      .data(state.edges)
      .join("line")
      .attr("class", "link");
  }

  function renderNodes() {
    const sel = nodesLayer.selectAll("g.node-group").data(state.nodes, (d) => d.id);

    const enter = sel.enter().append("g")
      .attr("class", "node-group")
      .attr("data-id", (d) => d.id)
      .call(dragBehavior);

    // 클립패스 (점 속 사진을 원형으로)
    enter.append("clipPath")
      .attr("id", (d) => `clip-${d.id}`)
      .append("circle")
      .attr("r", (d) => radiusScale(d.bodyLen));

    // 베이스 원 (카테고리 색 — 이미지 로드 전/실패 시 표시)
    enter.append("circle")
      .attr("class", "node-circle")
      .attr("r", (d) => radiusScale(d.bodyLen))
      .attr("fill", (d) => CATEGORY_COLORS[d.category] || CATEGORY_COLORS["기타"]);

    // 대표 사진
    enter.filter((d) => !!d.img)
      .append("image")
      .attr("class", "node-img")
      .attr("clip-path", (d) => `url(#clip-${d.id})`)
      .attr("x", (d) => -radiusScale(d.bodyLen))
      .attr("y", (d) => -radiusScale(d.bodyLen))
      .attr("width", (d) => radiusScale(d.bodyLen) * 2)
      .attr("height", (d) => radiusScale(d.bodyLen) * 2)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("href", (d) => thumbUrl(d.img, 120))
      .on("error", function (event, d) {
        const img = d3.select(this);
        if (!img.attr("data-fallback")) {
          img.attr("data-fallback", "1").attr("href", d.img); // 원본으로 재시도
        } else {
          img.remove(); // 색상 원만 표시
        }
      });

    // 카테고리 링
    enter.append("circle")
      .attr("class", "node-ring")
      .attr("r", (d) => radiusScale(d.bodyLen))
      .attr("fill", "none")
      .attr("stroke", (d) => CATEGORY_COLORS[d.category] || CATEGORY_COLORS["기타"]);

    sel.exit().remove();
  }

  function ticked() {
    nodesLayer.selectAll("g.node-group")
      .attr("transform", (d) => `translate(${d.x},${d.y})`);
    if (linkSel) {
      linkSel
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
    }
  }

  /* ------------------------------ Hover: tooltip + 이웃 하이라이트 ------------------------------ */

  function onPointerMove(event) {
    const target = event.target.closest(".node-group");
    if (!target) { hideTooltip(); clearHover(); return; }
    const id = target.getAttribute("data-id");
    const d = state.nodeById.get(id);
    if (!d) { hideTooltip(); clearHover(); return; }
    showTooltip(event, d);
    if (state.hoverId !== id) setHover(id);
  }

  function setHover(id) {
    state.hoverId = id;
    const neighbors = state.adjacency.get(id) || new Set();
    nodesLayer.selectAll("g.node-group")
      .classed("is-hover", (d) => d.id === id)
      .classed("is-neighbor", (d) => neighbors.has(d.id));
    if (linkSel) {
      linkSel.classed("hl", (e) => e.source.id === id || e.target.id === id);
    }
  }

  function clearHover() {
    if (!state.hoverId) return;
    state.hoverId = null;
    nodesLayer.selectAll("g.node-group").classed("is-hover", false).classed("is-neighbor", false);
    if (linkSel) linkSel.classed("hl", false);
  }

  function showTooltip(event, d) {
    const tt = el.tooltip();
    const nTags = (d.tags || []).slice(0, 4).map((t) => "#" + escapeHtml(t)).join(" ");
    tt.innerHTML = `
      <div class="bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg leading-snug">
        <div class="font-semibold mb-0.5 line-clamp-2">${escapeHtml(d.title)}</div>
        <div class="text-gray-300">${escapeHtml(d.date)} · ${escapeHtml(d.author)} · ${escapeHtml(d.category)}</div>
        ${nTags ? `<div class="text-gray-400 mt-0.5">${nTags}</div>` : ""}
      </div>`;
    tt.style.left = event.clientX + "px";
    tt.style.top = event.clientY + "px";
    tt.style.opacity = "1";
  }
  function hideTooltip() {
    const tt = el.tooltip();
    if (tt) tt.style.opacity = "0";
  }

  /* ------------------------------ Click / selection ------------------------------ */

  function onSvgClick(event) {
    const target = event.target.closest(".node-group");
    if (!target) return;
    const id = target.getAttribute("data-id");
    selectNode(id, true);
  }

  function selectNode(id, zoomTo) {
    state.selectedId = id;
    nodesLayer.selectAll("g.node-group")
      .classed("is-selected", (d) => d.id === id);
    if (zoomTo) focusNode(id);
    openDetailPanel(id);
  }

  function focusNode(id) {
    const d = state.nodeById.get(id);
    if (!d || !svg) return;
    const targetScale = Math.max(state.currentTransform.k, 2.4);
    const w = svg.node().clientWidth || 1000;
    const h = svg.node().clientHeight || 700;
    const transform = d3.zoomIdentity
      .translate(w / 2 - d.x * targetScale, h / 2 - d.y * targetScale)
      .scale(targetScale);
    svg.transition().duration(600).call(zoomBehavior.transform, transform);
  }

  /* ------------------------------ Detail panel ------------------------------ */

  async function ensurePosts() {
    if (state.postsLoaded) return state.postsCache;
    if (!state.postsPromise) {
      state.postsPromise = fetchJson("posts.json").then((arr) => {
        enrichNodesWithPosts(arr);
        state.postsLoaded = true;
        updatePostsStatus(true);
        applyFilters();
        return state.postsCache;
      }).catch((err) => {
        console.error(err);
        updatePostsStatus(false, true);
        throw err;
      });
    }
    return state.postsPromise;
  }

  function updatePostsStatus(loaded, error) {
    const s = el.postsStatus();
    if (!s) return;
    if (error) { s.textContent = "상세 데이터 로드 실패"; s.classList.add("text-red-500"); return; }
    if (loaded) {
      s.textContent = "";
      s.classList.add("hidden");
      el.boolChecks().forEach((c) => (c.disabled = false));
    } else {
      s.textContent = "상세 데이터 불러오는 중…";
      s.classList.remove("hidden");
    }
  }

  async function openDetailPanel(id) {
    const panel = el.detailPanel();
    const content = el.detailContent();
    panel.classList.remove("translate-x-full");
    if (window.innerWidth < 768) el.backdrop().classList.remove("hidden");
    content.innerHTML = renderDetailSkeleton();
    lucide.createIcons();

    let post = state.postsCache ? state.postsCache.get(id) : null;
    if (!post) {
      try {
        const map = await ensurePosts();
        post = map.get(id);
      } catch (e) {
        content.innerHTML = `<p class="text-red-500 p-4">게시물을 불러오지 못했습니다.</p>`;
        return;
      }
    }
    if (!post) {
      content.innerHTML = `<p class="text-gray-500 p-4">게시물을 찾을 수 없습니다.</p>`;
      return;
    }
    content.innerHTML = renderDetailContent(post);
    lucide.createIcons();
    wireRelatedCards(content);
  }

  function renderDetailSkeleton() {
    return `
      <div class="p-5 space-y-3">
        <div class="skeleton h-6 w-3/4 rounded"></div>
        <div class="skeleton h-4 w-1/2 rounded"></div>
        <div class="skeleton h-40 w-full rounded"></div>
        <div class="skeleton h-4 w-full rounded"></div>
        <div class="skeleton h-4 w-full rounded"></div>
        <div class="skeleton h-4 w-2/3 rounded"></div>
      </div>`;
  }

  function renderDetailContent(post) {
    const category = normalizeCategory(post.category);
    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS["기타"];
    const summary = Array.isArray(post.summary_3lines) ? post.summary_3lines : [];
    const images = Array.isArray(post.images) ? post.images : [];
    const attachments = Array.isArray(post.attachments) ? post.attachments : [];
    const tags = Array.isArray(post.tags) ? post.tags : [];
    const related = (post.related_ids || []).slice(0, 5)
      .map((rid) => state.nodeById.get(rid))
      .filter(Boolean);

    const imagesHtml = images.length ? `
      <div class="mb-5">
        <div class="text-xs font-semibold text-gray-500 mb-2">첨부 이미지</div>
        <div class="grid grid-cols-2 gap-2">
          ${images.map((src) => `
            <a href="${escapeHtml(src)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(src)}" loading="lazy" class="w-full h-28 object-cover rounded-lg border border-gray-200 bg-gray-50" onerror="this.style.display='none'">
            </a>`).join("")}
        </div>
      </div>` : "";

    const attachHtml = attachments.length ? `
      <div class="mb-5">
        <div class="text-xs font-semibold text-gray-500 mb-2">첨부파일</div>
        <ul class="space-y-1.5">
          ${attachments.map((a) => `
            <li>
              <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener"
                 class="flex items-center gap-2 text-sm text-blue-600 hover:underline break-all">
                <i data-lucide="download" class="w-3.5 h-3.5 shrink-0"></i>
                <span>${escapeHtml(a.name || "첨부파일")}</span>
              </a>
            </li>`).join("")}
        </ul>
      </div>` : "";

    const summaryHtml = summary.length ? `
      <div class="mb-5 bg-gray-50 border border-gray-200 rounded-xl p-4">
        <div class="text-xs font-semibold text-gray-500 mb-2">3줄 요약</div>
        <ol class="list-decimal list-inside space-y-1 text-sm text-gray-700">
          ${summary.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}
        </ol>
      </div>` : "";

    const tagsHtml = tags.length ? `
      <div class="mb-5 flex flex-wrap gap-1.5">
        ${tags.map((t) => `<span class="text-xs bg-gray-100 text-gray-600 rounded-full px-2.5 py-1">#${escapeHtml(t)}</span>`).join("")}
      </div>` : "";

    const relatedHtml = related.length ? `
      <div class="mt-6 border-t border-gray-200 pt-4">
        <div class="text-xs font-semibold text-gray-500 mb-2">관련 게시물</div>
        <div class="space-y-2">
          ${related.map((r) => `
            <div class="related-card cursor-pointer border border-gray-200 rounded-lg p-2.5 hover:border-gray-400 transition" data-id="${escapeHtml(r.id)}">
              <div class="flex items-center gap-1.5 mb-1">
                <span class="inline-block w-2 h-2 rounded-full" style="background:${CATEGORY_COLORS[r.category] || "#9ca3af"}"></span>
                <span class="text-[11px] text-gray-400">${escapeHtml(r.date)}</span>
              </div>
              <div class="text-sm text-gray-800 line-clamp-2">${escapeHtml(r.title)}</div>
            </div>`).join("")}
        </div>
      </div>` : "";

    return `
      <div class="p-5">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-xs font-semibold text-white rounded-full px-2.5 py-1" style="background:${color}">${escapeHtml(category)}</span>
          ${(post.type || []).map((t) => `<span class="text-xs text-gray-500">${TYPE_ICON[t] || ""} ${escapeHtml(t)}</span>`).join("")}
        </div>
        <h2 class="text-lg font-bold text-gray-900 leading-snug mb-2">${escapeHtml(post.title)}</h2>
        <div class="text-xs text-gray-500 mb-4 flex flex-wrap gap-x-3 gap-y-1">
          <span class="flex items-center gap-1"><i data-lucide="calendar" class="w-3.5 h-3.5"></i>${escapeHtml(post.date)}</span>
          <span class="flex items-center gap-1"><i data-lucide="user" class="w-3.5 h-3.5"></i>${escapeHtml(post.author)}</span>
          <span class="flex items-center gap-1"><i data-lucide="eye" class="w-3.5 h-3.5"></i>${(post.view_count || 0).toLocaleString()}</span>
        </div>
        ${summaryHtml}
        ${imagesHtml}
        <div class="text-xs font-semibold text-gray-500 mb-2">본문</div>
        <div class="post-body text-sm text-gray-700 leading-relaxed mb-5">${bodyToHtml(post.body)}</div>
        ${attachHtml}
        ${tagsHtml}
        <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener"
           class="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-gray-900 hover:bg-gray-700 rounded-lg px-4 py-2.5 transition">
          <i data-lucide="external-link" class="w-4 h-4"></i> 원문보기
        </a>
        ${relatedHtml}
      </div>`;
  }

  function wireRelatedCards(container) {
    container.querySelectorAll(".related-card").forEach((c) => {
      c.addEventListener("click", () => {
        const id = c.getAttribute("data-id");
        selectNode(id, true);
      });
    });
  }

  function closeDetailPanel() {
    el.detailPanel().classList.add("translate-x-full");
    el.backdrop().classList.add("hidden");
  }

  /* ------------------------------ Filters + search ------------------------------ */

  function nodeMatchesSearch(d, q) {
    if (!q) return true;
    const hay = (d.title + " " + d.excerpt + " " + d.tags.join(" ") + " " + d.author + " " + d.category).toLowerCase();
    return hay.includes(q);
  }

  function nodeMatchesFilters(d) {
    const f = state.filters;
    if (f.year && d.year !== f.year) return false;
    if (f.months.size && !f.months.has(d.month)) return false;
    if (f.tags.size) {
      const has = d.tags.some((t) => f.tags.has(t));
      if (!has) return false;
    }
    if (f.types.size) {
      const has = d.type.some((t) => f.types.has(t));
      if (!has) return false;
    }
    if (f.keyword) {
      const kw = f.keyword.toLowerCase();
      const hay = (d.title + " " + d.excerpt).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (f.hasAttachment && !d.hasAttachment) return false;
    if (f.hasImage && !d.hasImage) return false;
    if (f.hasVideo && !d.hasVideo) return false;
    return true;
  }

  function applyFilters() {
    const q = state.searchQuery.trim().toLowerCase();
    const hasActiveFilters = q || state.filters.year || state.filters.months.size ||
      state.filters.tags.size || state.filters.types.size || state.filters.keyword ||
      state.filters.hasAttachment || state.filters.hasImage || state.filters.hasVideo;

    let matchCount = 0;
    const matchedNodes = [];
    for (const d of state.nodes) {
      const passFilter = nodeMatchesFilters(d);
      const passSearch = nodeMatchesSearch(d, q);
      d._match = passFilter && passSearch;
      if (d._match) { matchCount++; matchedNodes.push(d); }
    }

    nodesLayer.selectAll("g.node-group")
      .classed("is-dim", (d) => hasActiveFilters && !d._match)
      .classed("is-match", (d) => hasActiveFilters && d._match && q)
      .classed("is-hidden", false);

    // 링크도 함께 흐리게: 양 끝이 모두 매칭될 때만 강조 유지
    if (linkSel) {
      linkSel.classed("is-dim", (e) => {
        if (!hasActiveFilters) return false;
        const s = typeof e.source === "object" ? e.source : state.nodeById.get(e.source);
        const t = typeof e.target === "object" ? e.target : state.nodeById.get(e.target);
        return !(s && t && s._match && t._match);
      });
    }

    el.resultCount().textContent = hasActiveFilters
      ? `${matchCount} / ${state.nodes.length}건 매칭`
      : `총 ${state.nodes.length}건`;

    state.listItems = hasActiveFilters ? matchedNodes : state.nodes.slice();
    state.listItems.sort((a, b) => (a.date < b.date ? 1 : -1));
    resetListView();

    if (q && matchedNodes.length) {
      fitToNodes(matchedNodes);
    }
    return matchedNodes;
  }

  function fitToNodes(nodesArr) {
    if (!svg || nodesArr.length === 0) return;
    const xs = nodesArr.map((d) => d.x);
    const ys = nodesArr.map((d) => d.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = svg.node().clientWidth || 1000;
    const h = svg.node().clientHeight || 700;
    const bw = Math.max(maxX - minX, 60);
    const bh = Math.max(maxY - minY, 60);
    const scale = Math.min(6, Math.max(0.35, Math.min(w / (bw + 160), h / (bh + 160))));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const transform = d3.zoomIdentity
      .translate(w / 2 - cx * scale, h / 2 - cy * scale)
      .scale(scale);
    svg.transition().duration(650).call(zoomBehavior.transform, transform);
  }

  /* ------------------------------ Month chips ------------------------------ */

  function renderMonthChips() {
    const months = state.monthsMeta._sorted_months.slice().reverse();
    const wrap = el.monthChips();
    wrap.innerHTML = months.map((m) => `
      <button type="button" class="month-chip flex-shrink-0 border border-gray-300 rounded-full px-3 py-1.5 text-xs font-medium text-gray-700 bg-white hover:border-gray-500"
        data-month="${m}">${m} <span class="text-gray-400">(${state.monthsMeta[m]})</span></button>
    `).join("") + `
      <button type="button" id="month-chip-all" class="month-chip active flex-shrink-0 border border-gray-900 rounded-full px-3 py-1.5 text-xs font-medium bg-gray-900 text-white">전체</button>
    `;
    wrap.prepend(document.getElementById("month-chip-all"));

    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest(".month-chip");
      if (!btn) return;
      wrap.querySelectorAll(".month-chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const m = btn.getAttribute("data-month");
      state.filters.months.clear();
      if (m) state.filters.months.add(m);
      const matched = applyFilters();
      if (m && matched.length) fitToNodes(matched);
    });
  }

  /* ------------------------------ Filter panel wiring ------------------------------ */

  function renderYearOptions() {
    const years = Array.from(new Set(state.nodes.map((d) => d.year))).sort();
    const sel = el.yearSelect();
    sel.innerHTML = `<option value="">전체 연도</option>` + years.map((y) => `<option value="${y}">${y}년</option>`).join("");
    sel.addEventListener("change", () => {
      state.filters.year = sel.value;
      applyFilters();
    });
  }

  function renderTagFilterList(filterText) {
    const tagsMeta = state.tagsMeta || {};
    let entries = Object.entries(tagsMeta);
    if (filterText) {
      const f = filterText.toLowerCase();
      entries = entries.filter(([name]) => name.toLowerCase().includes(f));
    }
    entries.sort((a, b) => b[1].count - a[1].count);
    entries = entries.slice(0, 120);
    const listEl = el.tagList();
    listEl.innerHTML = entries.map(([name, meta]) => `
      <button type="button" class="tag-pill ${state.filters.tags.has(name) ? "active" : ""} text-xs rounded-full px-2.5 py-1 bg-gray-100 text-gray-700 hover:bg-gray-200"
        data-tag="${escapeHtml(name)}">${escapeHtml(name)} <span class="opacity-60">${meta.count}</span></button>
    `).join("");
  }

  function wireTagFilter() {
    renderTagFilterList("");
    el.tagList().addEventListener("click", (e) => {
      const btn = e.target.closest(".tag-pill");
      if (!btn) return;
      const tag = btn.getAttribute("data-tag");
      if (state.filters.tags.has(tag)) state.filters.tags.delete(tag);
      else state.filters.tags.add(tag);
      btn.classList.toggle("active");
      applyFilters();
    });
    el.tagSearch().addEventListener("input", debounce((e) => {
      renderTagFilterList(e.target.value);
    }, 150));
  }

  function wireTypeFilter() {
    el.typeChecks().forEach((cb) => {
      cb.addEventListener("change", () => {
        const t = cb.value;
        if (cb.checked) state.filters.types.add(t);
        else state.filters.types.delete(t);
        applyFilters();
      });
    });
  }

  function wireBoolFilter() {
    el.boolChecks().forEach((cb) => {
      cb.addEventListener("change", () => {
        state.filters[cb.dataset.filter] = cb.checked;
        applyFilters();
      });
    });
  }

  function wireKeywordFilter() {
    const input = $("#filter-keyword");
    input.addEventListener("input", debounce((e) => {
      state.filters.keyword = e.target.value;
      applyFilters();
    }, 200));
  }

  function wireReset() {
    el.resetBtn().addEventListener("click", () => {
      state.filters = {
        year: "", months: new Set(), tags: new Set(), types: new Set(),
        keyword: "", hasAttachment: false, hasImage: false, hasVideo: false,
      };
      state.searchQuery = "";
      el.searchInput().value = "";
      el.yearSelect().value = "";
      $("#filter-keyword").value = "";
      el.typeChecks().forEach((cb) => (cb.checked = false));
      el.boolChecks().forEach((cb) => (cb.checked = false));
      renderTagFilterList("");
      el.tagSearch().value = "";
      document.querySelectorAll(".month-chip").forEach((b) => b.classList.remove("active"));
      document.getElementById("month-chip-all").classList.add("active");
      applyFilters();
    });
  }

  /* ------------------------------ Search wiring ------------------------------ */

  function wireSearch() {
    el.searchInput().addEventListener("input", debounce((e) => {
      state.searchQuery = e.target.value;
      applyFilters();
    }, 180));
  }

  /* ------------------------------ List view (infinite scroll) ------------------------------ */

  function resetListView() {
    state.listRendered = 0;
    el.listContainer().innerHTML = "";
    renderMoreListItems();
  }

  function renderMoreListItems() {
    const container = el.listContainer();
    const items = state.listItems;
    const next = items.slice(state.listRendered, state.listRendered + state.listBatchSize);
    if (next.length === 0) return;
    const frag = document.createDocumentFragment();
    next.forEach((d) => {
      const div = document.createElement("div");
      div.className = "list-item px-3 py-2.5 border-b border-gray-100 flex items-start gap-2.5" +
        (d.id === state.selectedId ? " is-selected" : "");
      div.dataset.id = d.id;
      const thumb = d.img
        ? `<img src="${escapeHtml(thumbUrl(d.img, 64))}" loading="lazy" class="w-9 h-9 rounded-full object-cover shrink-0 border" style="border-color:${CATEGORY_COLORS[d.category] || "#9ca3af"}" onerror="this.style.display='none'">`
        : `<span class="inline-block w-2.5 h-2.5 rounded-full mt-1 shrink-0" style="background:${CATEGORY_COLORS[d.category] || "#9ca3af"}"></span>`;
      div.innerHTML = `
        ${thumb}
        <div class="min-w-0">
          <div class="text-sm text-gray-800 clamp-2 leading-snug">${escapeHtml(d.title)}</div>
          <div class="text-[11px] text-gray-400 mt-0.5">${escapeHtml(d.date)} · ${escapeHtml(d.author)} · ${escapeHtml(d.category)}</div>
        </div>`;
      frag.appendChild(div);
    });
    container.appendChild(frag);
    state.listRendered += next.length;
  }

  function wireListView() {
    el.listContainer().addEventListener("click", (e) => {
      const item = e.target.closest(".list-item");
      if (!item) return;
      const id = item.dataset.id;
      el.listContainer().querySelectorAll(".list-item").forEach((n) => n.classList.remove("is-selected"));
      item.classList.add("is-selected");
      selectNode(id, true);
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) renderMoreListItems();
      });
    }, { root: el.listContainer(), threshold: 0.1 });
    observer.observe(el.listSentinel());
  }

  /* ------------------------------ Panel open/close + responsive ------------------------------ */

  function showBackdropIfMobile() {
    if (window.innerWidth < 768) el.backdrop().classList.remove("hidden");
  }

  function wirePanelToggles() {
    el.mobileFilterToggle().addEventListener("click", () => {
      el.filterPanel().classList.remove("translate-y-full");
      showBackdropIfMobile();
    });
    el.mobileListToggle().addEventListener("click", () => {
      el.listPanel().classList.remove("translate-y-full");
      showBackdropIfMobile();
    });
    el.closeFilter().addEventListener("click", closeAllOverlays);
    el.closeDetail().addEventListener("click", closeDetailPanel);
    el.closeList().addEventListener("click", () => {
      el.listPanel().classList.add("translate-y-full");
      el.backdrop().classList.add("hidden");
    });
    el.backdrop().addEventListener("click", closeAllOverlays);
  }

  function closeAllOverlays() {
    el.filterPanel().classList.add("translate-y-full");
    el.detailPanel().classList.add("translate-x-full");
    el.listPanel().classList.add("translate-y-full");
    el.backdrop().classList.add("hidden");
  }

  /* ------------------------------ Init ------------------------------ */

  async function init() {
    try {
      const [searchIndex, months, tags, thumbs] = await Promise.all([
        fetchJson("search-index.json"),
        fetchJson("months.json"),
        fetchJson("tags.json"),
        fetchJson("thumbs.json"),
      ]);
      state.monthsMeta = months;
      state.tagsMeta = tags;
      state.nodes = buildNodesFromSearchIndex(searchIndex);
      state.nodes.forEach((n) => state.nodeById.set(n.id, n));
      applyThumbs(thumbs);
      buildEdges();

      initMap();
      buildSimulation();
      renderLinks();
      renderNodes();

      renderMonthChips();
      renderYearOptions();
      wireTagFilter();
      wireTypeFilter();
      wireBoolFilter();
      wireKeywordFilter();
      wireReset();
      wireSearch();
      wireListView();
      wirePanelToggles();

      updatePostsStatus(false);
      applyFilters();

      lucide.createIcons();
      $("#loading-overlay").classList.add("hidden");

      ensurePosts().catch(() => {});
    } catch (err) {
      console.error(err);
      const loading = $("#loading-overlay");
      if (loading) {
        loading.innerHTML = `<div class="text-center text-red-500 p-6">데이터를 불러오는 중 오류가 발생했습니다.<br>${escapeHtml(err.message)}</div>`;
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
