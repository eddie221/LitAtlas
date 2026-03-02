"use strict";
/**
 * graph.js
 *
 * Responsibilities:
 *   • Load papers and edges from SQLite via Rust invoke()
 *   • Compute similarity edges in JS and persist via Rust
 *   • Render a force-directed graph on Canvas
 *   • Handle all interaction: pan, zoom, drag, search, selection
 *
 * Data flow:
 *   SQLite ──► Rust get_papers / get_edges ──► JS (render)
 *   JS computeEdges() ──► Rust recompute_edges(edges) ──► SQLite
 *
 * Paper shape (from Rust PaperFull, ids are numbers):
 *   { id, title, venue, year, notes, pdf_path,
 *     authors: string[], hashtags: string[],
 *     attributes: [{key,value,order}] }
 */

import { colorForPaper, groupForPaper, nodeColorOverrides, COLOR_PALETTE } from "./constant.js";
import { setPapersCache, getPapersCache, setEdgesCache, getEdgesCache, state, setCurrentPaperCache } from "./cache.js";
import { openPaperPage, showDropzone } from "./paper-page.js";
import { computeEdges, computeEdgesForNewPaper, getDefaultConfig, setTagVocab } from "./similarity.js";
import { loadProjects, onProjectSwitch } from "./projects.js";

// ── Tauri bridge ──────────────────────────────────────────────────────────────
const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  (() => { throw new Error("Tauri not found — run with `cargo tauri dev`"); })
);

// ── Similarity config (loaded from Rust on boot, persisted on change) ─────────
let _simConfig = getDefaultConfig();

export async function loadSimConfig() {
  try {
    const saved = await invoke("get_similarity_config");
    if (saved && typeof saved === "object") {
      _simConfig = { ...getDefaultConfig(), ...saved };
    }
  } catch (e) {
    console.warn("[PaperGraph] Could not load similarity config:", e);
  }
}

export async function saveSimConfig(cfg) {
  _simConfig = { ...getDefaultConfig(), ...cfg };
  try { await invoke("save_similarity_config", { config: _simConfig }); }
  catch (e) { console.warn("[PaperGraph] Could not save similarity config:", e); }
}

export function getSimConfig() { return { ..._simConfig }; }

// ── PDF display helper ────────────────────────────────────────────────────────
// Instead of the broken asset:// protocol (Tauri v2 CSP/scope issues), we ask
// Rust to read the file bytes and return them as base64, then create a blob URL.
// This works regardless of asset protocol config and avoids all CSP problems.
let _pdfBlobUrl = null; // track so we can revoke the previous one

export async function loadPdfIntoIframe(paperId, iframe, onStatus) {
  // Revoke any previous blob URL to avoid memory leaks
  if (_pdfBlobUrl) { URL.revokeObjectURL(_pdfBlobUrl); _pdfBlobUrl = null; }

  if (onStatus) onStatus("Loading PDF…", "var(--text-secondary)");
  try {
    console.log("sss");
    const b64 = await invoke("read_pdf_bytes", { paperId });
    console.log("eee");
    // Convert base64 → Uint8Array → Blob
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    console.log("blob : ", blob);
    _pdfBlobUrl = URL.createObjectURL(blob);
    console.log("_pdfBlobUrl : ", _pdfBlobUrl);
    iframe.src = _pdfBlobUrl;
    if (onStatus) onStatus(null); // clear status
    return true;
  } catch (err) {
    if (onStatus) onStatus("❌ " + err, "var(--accent3)");
    console.error("[PaperGraph] read_pdf_bytes failed:", err);
    return false;
  }
}

// ── Helpers — extract custom attribute value from a paper ─────────────────────
export function attr(paper, key, fallback = "") {
  return paper.attributes?.find(a => a.key === key)?.value ?? fallback;
}

// ── Paper/edge adaptors ───────────────────────────────────────────────────────

function adaptPaper(r) {
  return {
    id:         Number(r.id),            // SQLite rowid → JS number
    title:      r.title      ?? "",
    venue:      r.venue      ?? "",
    year:       Number(r.year ?? 0),
    notes:      r.notes      ?? null,
    pdf_path:   r.pdf_path   ?? null,
    authors:    Array.isArray(r.authors)  ? r.authors  : [],
    hashtags:   Array.isArray(r.hashtags) ? r.hashtags : [],
    attributes: Array.isArray(r.attributes) ? r.attributes : [],
  };
}

function adaptEdge(r) {
  return {
    source:     Number(r.source_id),
    target:     Number(r.target_id),
    similarity: Number(r.similarity),
    weight:     Number(r.weight),
    type:       r.edge_type,
  };
}

// ── Loading overlay ───────────────────────────────────────────────────────────
function showOverlay(msg) {
  let el = document.getElementById("pg-loading");
  if (!el) {
    el = document.createElement("div");
    el.id = "pg-loading";
    Object.assign(el.style, {
      position: "fixed", inset: "0", zIndex: "9999",
      background: "rgba(10,12,16,0.97)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "18px",
      fontFamily: "'Space Mono',monospace", color: "#e8eaf0",
      textAlign: "center", whiteSpace: "pre-wrap", padding: "40px",
    });
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div style="font-family:'DM Serif Display',serif;font-size:1.6rem;color:#c8ff00">
      Paper<span style="color:#e8eaf0">Graph</span></div>
    <div style="font-size:.75rem;color:#6b7280;max-width:380px;line-height:1.8">${msg}</div>
    <div style="width:36px;height:36px;border:2px solid #1e2230;
                border-top-color:#c8ff00;border-radius:50%;
                animation:_spin .75s linear infinite"></div>
    <style>@keyframes _spin{to{transform:rotate(360deg)}}</style>`;
  el.style.display = "flex";
}
function hideOverlay() {
  const el = document.getElementById("pg-loading");
  if (el) el.style.display = "none";
}

// ── Startup load ──────────────────────────────────────────────────────────────
async function loadFromDB() {
  showOverlay("Opening database…");
  try {
    // Load similarity config first so compute uses user's settings
    await loadSimConfig();

    showOverlay("Loading papers…");
    setPapersCache((await invoke("get_papers")).map(adaptPaper));

    // Sync tag vocabulary from DB so similarity vectors reflect the real tag set
    const dbTags = await invoke("get_hashtags");
    setTagVocab(dbTags);

    showOverlay("Loading similarity graph…");
    let rawEdges = await invoke("get_edges");

    if (rawEdges.length === 0) {
      const stratLabel = _simConfig.strategy === "hf-embeddings" ? "HuggingFace embeddings" : "cosine similarity";
      showOverlay(`First run — computing edges via ${stratLabel}…`);
      const computed = await computeEdges(getPapersCache(), _simConfig);
      await invoke("recompute_edges", { edges: computed });
      rawEdges = await invoke("get_edges");
    }

    setEdgesCache(rawEdges.map(adaptEdge));
    hideOverlay();
    initGraph();
  } catch (err) {
    showOverlay(`❌ Database error\n\n${err}`);
    console.error("[PaperGraph]", err);
  }
}

// ── Edge recomputation (full rebuild) ─────────────────────────────────────────
export async function triggerEdgeRecompute() {
  // Refresh vocab in case new tags were added since last load
  const dbTags = await invoke("get_hashtags");
  setTagVocab(dbTags);
  const computed = await computeEdges(getPapersCache(), _simConfig);
  await invoke("recompute_edges", { edges: computed });
  const fresh = await invoke("get_edges");
  setEdgesCache(fresh.map(adaptEdge));
  rebuildEdgeRefs();
  document.getElementById("stat-connections").textContent = getEdgesCache().length;
}

// ── Refresh a single paper from DB ───────────────────────────────────────────
export async function refreshPaper(id) {
  try {
    const updated = adaptPaper(await invoke("get_paper", { id }));
    const cache   = getPapersCache();
    const idx     = cache.findIndex(p => p.id === id);
    if (idx !== -1) {
      cache[idx] = updated;
      const node = state.nodes.find(n => n.id === id);
      if (node) { Object.assign(node, updated); node.radius = nodeRadius(updated); }
    }
  } catch (err) {
    console.warn("[PaperGraph] refreshPaper failed:", err);
  }
}

function rebuildEdgeRefs() {
  state.edges = getEdgesCache().map(e => ({
    ...e,
    sourceNode: state.nodes.find(n => n.id === e.source),
    targetNode: state.nodes.find(n => n.id === e.target),
  }));
  // console.log("Synchronize DB to app (state.edges) : ", state.edges);
}

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById("graph-canvas");
const ctx    = canvas.getContext("2d");

function resizeCanvas() {
  const c = document.getElementById("canvas-container");
  canvas.width        = c.offsetWidth  * devicePixelRatio;
  canvas.height       = c.offsetHeight * devicePixelRatio;
  canvas.style.width  = c.offsetWidth  + "px";
  canvas.style.height = c.offsetHeight + "px";
  ctx.scale(devicePixelRatio, devicePixelRatio);
  // console.log(canvas);

  draw();
}
window.addEventListener("resize", resizeCanvas);

// ── Graph init ────────────────────────────────────────────────────────────────
function nodeRadius(p) {
  // Size by citation count if available, otherwise uniform
  const inConnection = getEdgesCache().filter(n => n.target === p.id).length;
  const outConnection = getEdgesCache().filter(n => n.source === p.id).length;
  return 16 + (Math.log(Math.max(inConnection + outConnection, 1)) / Math.log(14000)) * 19;
}

function initGraph() {
  const W = canvas.width  / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  const papers = getPapersCache();

  state.nodes = papers.map((p, i) => {
    const angle = (i / papers.length) * Math.PI * 2;
    const r     = Math.min(W, H) * 0.32;
    return { ...p, x: W/2 + r*Math.cos(angle), y: H/2 + r*Math.sin(angle),
             vx: 0, vy: 0, radius: nodeRadius(p) };
  });

  rebuildEdgeRefs();

  const uniqueTags = new Set(papers.flatMap(p => p.hashtags.map(t => t.replace(/^#/, ""))));
  document.getElementById("stat-papers").textContent      = papers.length;
  document.getElementById("stat-connections").textContent = getEdgesCache().length;
  document.getElementById("stat-topics").textContent      = uniqueTags.size;

  loop();
}

// ── Similarity threshold (controlled by range bar) ────────────────────────────
let simThreshold = 0.38;

// ── Force simulation ──────────────────────────────────────────────────────────
const SIM = {
  repulsion: 7500, attraction: 0.036, centerForce: 0.016,
  damping: 0.82, idealBase: 170, running: true,
};
let tick = 0;

function simulationStep() {
  const W  = canvas.width  / devicePixelRatio;
  const H  = canvas.height / devicePixelRatio;
  const ns = state.nodes;

  ns.forEach(n => { n.fx = 0; n.fy = 0; });

  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      const f  = SIM.repulsion / (d*d);
      a.fx -= dx/d*f; a.fy -= dy/d*f;
      b.fx += dx/d*f; b.fy += dy/d*f;
    }
  }

  state.edges.forEach(e => {
    const a = e.sourceNode, b = e.targetNode;
    if (!a || !b) return;
    const dx   = b.x - a.x, dy = b.y - a.y;
    const d    = Math.sqrt(dx*dx + dy*dy) || 1;
    const ideal = SIM.idealBase * (1.6 - e.similarity);
    const f    = (d - ideal) * SIM.attraction;
    a.fx += dx/d*f; a.fy += dy/d*f;
    b.fx -= dx/d*f; b.fy -= dy/d*f;
  });

  ns.forEach(n => {
    n.fx += (W/2 - n.x) * SIM.centerForce;
    n.fy += (H/2 - n.y) * SIM.centerForce;
  });
  ns.forEach(n => {
    if (n === state.dragging) return;
    n.vx = (n.vx + n.fx) * SIM.damping;
    n.vy = (n.vy + n.fy) * SIM.damping;
    n.x  = Math.max(n.radius, Math.min(W - n.radius, n.x + n.vx));
    n.y  = Math.max(n.radius, Math.min(H - n.radius, n.y + n.vy));
  });
}

// ── Radial layout ─────────────────────────────────────────────────────────────
function applyRadialLayout() {
  const W = canvas.width  / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  // Group by first hashtag
  const groups = {};
  state.nodes.forEach(n => {
    const key = (n.hashtags?.[0] ?? "#other").replace(/^#/, "");
    (groups[key] ??= []).push(n);
  });
  const keys    = Object.keys(groups);
  const outerR  = Math.min(W, H) * 0.38;
  const innerR  = Math.min(W, H) * 0.14;

  keys.forEach((key, ki) => {
    const group = groups[key];
    const base  = (ki / keys.length) * Math.PI * 2 - Math.PI / 2;
    group.forEach((node, ni) => {
      const spread = group.length === 1 ? 0 : (ni / (group.length - 1) - 0.5) * 0.55;
      const r      = outerR - innerR * (ni % 2);
      node.x = W/2 + r * Math.cos(base + spread);
      node.y = H/2 + r * Math.sin(base + spread);
      node.vx = 0; node.vy = 0;
    });
  });
}

// ── Coordinate utils ──────────────────────────────────────────────────────────
function toWorld(sx, sy) {
  return { x: (sx - state.viewX) / state.scale, y: (sy - state.viewY) / state.scale };
}
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ── Draw ──────────────────────────────────────────────────────────────────────
function draw() {
  const W = canvas.width  / devicePixelRatio;
  const H = canvas.height / devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(state.viewX, state.viewY);
  ctx.scale(state.scale, state.scale);

  const q   = state.searchQuery.toLowerCase();
  const sel = state.selectedNode?.id;

  // Build set of node IDs connected to selected node (by edges passing threshold)
  const connectedIds = new Set();
  if (sel) {
    state.edges.forEach(e => {
      if (e.similarity < simThreshold) return;
      if (e.sourceNode?.id === sel) connectedIds.add(e.targetNode?.id);
      if (e.targetNode?.id === sel) connectedIds.add(e.sourceNode?.id);
    });
  }

  // Draw edges — only those meeting threshold; dim unrelated when a node is selected
  state.edges.forEach(e => {
    const a = e.sourceNode, b = e.targetNode;
    if (!a || !b) return;
    if (e.similarity < simThreshold) {
      return;  // threshold filter
    }
    let alpha;
    if (q) {
      // Search mode: only draw an edge if BOTH endpoints match the query.
      // This prevents edges from "leaking" to non-matching nodes.
      const aMatch = a.title.toLowerCase().includes(q)
        || a.authors.join(" ").toLowerCase().includes(q)
        || a.hashtags.join(" ").toLowerCase().includes(q);
      const bMatch = b.title.toLowerCase().includes(q)
        || b.authors.join(" ").toLowerCase().includes(q)
        || b.hashtags.join(" ").toLowerCase().includes(q);
      alpha = (aMatch && bMatch) ? 1 : 0;
    } else if (sel) {
      // Selection mode: only show edges directly connected to selected node
      alpha = (a.id === sel || b.id === sel) ? 1 : 0;
    } else {
      alpha = 1;
    }
    if (alpha > 0) drawEdge(e, alpha);
  });

  // Draw nodes — dim unrelated when a node is selected
  state.nodes.forEach(n => {
    const matchesSearch = !q
      || n.title.toLowerCase().includes(q)
      || n.authors.join(" ").toLowerCase().includes(q)
      || n.hashtags.join(" ").toLowerCase().includes(q);

    if (!matchesSearch) { drawNodeFaded(n); return; }

    if (sel && n.id !== sel && !connectedIds.has(n.id)) {
      drawNodeFaded(n);
    } else {
      drawNode(n);
    }
  });

  ctx.restore();
}

function edgeColor(type) {
  return type === "same_tag"   ? "rgba(200,255,0,.75)"  :
         type === "same_venue" ? "rgba(0,212,255,.65)"  :
                                 "rgba(100,120,180,.4)";
}

function drawEdge(e, alpha) {
  const a = e.sourceNode, b = e.targetNode;
  const hov = state.hoveredEdge === e;
  const cpx = (a.x + b.x)/2 - (b.y - a.y)*0.13;
  const cpy = (a.y + b.y)/2 + (b.x - a.x)*0.13;

  ctx.save();
  ctx.globalAlpha = hov ? 1 : alpha;
  ctx.strokeStyle = hov ? "#c8ff00" : edgeColor(e.type);
  ctx.lineWidth   = hov ? 2.5 : (e.weight >= 3 ? 2 : e.weight >= 2 ? 1.4 : 0.8);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
  ctx.stroke();
  if (hov) {
    ctx.fillStyle = "#c8ff00";
    ctx.font = "bold 9px 'Space Mono'";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(e.similarity.toFixed(2), (a.x+b.x)/2, (a.y+b.y)/2 - 8);
  }
  ctx.restore();
}

function drawNode(n) {
  const sel   = state.selectedNode?.id === n.id;
  const hov   = state.hoveredNode?.id  === n.id;
  const color = colorForPaper(n);
  const r     = n.radius;

  if (sel || hov) {
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = sel ? 28 : 16;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
  ctx.fillStyle   = sel ? color : color + "22";
  ctx.fill();
  ctx.strokeStyle = sel ? "#fff" : color;
  ctx.lineWidth   = sel ? 2.5 : 1.5;
  ctx.stroke();

  const label = n.title.length > 18 ? n.title.slice(0, 16) + "…" : n.title;
  ctx.fillStyle    = sel ? "#fff" : "#c8d0e0";
  ctx.font         = `${sel ? "bold " : ""}${Math.max(8, r*0.42)}px 'Space Mono'`;
  ctx.textAlign    = "center"; ctx.textBaseline = "top";
  ctx.fillText(label, n.x, n.y + r + 5);
}

function drawNodeFaded(n) {
  ctx.beginPath(); ctx.arc(n.x, n.y, n.radius, 0, Math.PI*2);
  ctx.fillStyle   = "rgba(17,19,24,.4)"; ctx.fill();
  ctx.strokeStyle = "rgba(40,48,70,.3)"; ctx.lineWidth = 1; ctx.stroke();
}

// ── Animation loop ────────────────────────────────────────────────────────────
function loop() {
  if (state.layoutMode === "force" && SIM.running) {
    simulationStep();
    tick++;
    if (tick > 280) SIM.damping = Math.max(0.58, SIM.damping - 0.0008);
  }
  draw();
  requestAnimationFrame(loop);
}

// ── Hit testing ───────────────────────────────────────────────────────────────
function nodeAt(sx, sy) {
  const { x, y } = toWorld(sx, sy);
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if ((x-n.x)**2 + (y-n.y)**2 <= (n.radius+5)**2) return n;
  }
  return null;
}

function edgeAt(sx, sy) {
  const { x, y } = toWorld(sx, sy);
  for (const e of state.edges) {
    const a = e.sourceNode, b = e.targetNode;
    if (!a || !b) continue;
    const cpx = (a.x+b.x)/2 - (b.y-a.y)*0.13;
    const cpy = (a.y+b.y)/2 + (b.x-a.x)*0.13;
    for (let t = 0; t <= 1; t += 0.05) {
      const bx = (1-t)**2*a.x + 2*(1-t)*t*cpx + t**2*b.x;
      const by = (1-t)**2*a.y + 2*(1-t)*t*cpy + t**2*b.y;
      if ((x-bx)**2 + (y-by)**2 < 72) return e;
    }
  }
  return null;
}

// ── Pointer events ────────────────────────────────────────────────────────────
let _mouseDownNode = null, _mouseDownPos = null;

canvas.addEventListener("mousedown", e => {
  const pos  = canvasPos(e);
  const node = nodeAt(pos.x, pos.y);
  _mouseDownNode = node; _mouseDownPos = pos;
  if (node) {
    state.dragging = node;
    const w = toWorld(pos.x, pos.y);
    state.dragOffX = node.x - w.x; state.dragOffY = node.y - w.y;
  } else {
    state.panning   = true;
    state.panStartX = pos.x - state.viewX;
    state.panStartY = pos.y - state.viewY;
  }
});

canvas.addEventListener("mousemove", e => {
  const pos = canvasPos(e);
  if (state.dragging) {
    const w = toWorld(pos.x, pos.y);
    state.dragging.x  = w.x + state.dragOffX;
    state.dragging.y  = w.y + state.dragOffY;
    state.dragging.vx = 0; state.dragging.vy = 0;
    return;
  }
  if (state.panning) {
    state.viewX = pos.x - state.panStartX;
    state.viewY = pos.y - state.panStartY;
    return;
  }

  state.hoveredNode = nodeAt(pos.x, pos.y);
  state.hoveredEdge = state.hoveredNode ? null : edgeAt(pos.x, pos.y);
  canvas.style.cursor = state.hoveredNode ? "pointer" : "grab";

  const tt = document.getElementById("tooltip");
  if (state.hoveredNode) {
    const n = state.hoveredNode;
    document.getElementById("tt-title").textContent = n.title;
    document.getElementById("tt-year").textContent  =
      `${n.year} · ${n.venue}`;
    
    document.getElementById("tt-tag").innerHTML = [
      ...n.hashtags
    ].map(b => b).join(", ");
    tt.style.display = "block";
    tt.style.left    = (e.clientX + 14) + "px";
    tt.style.top     = e.clientY + "px";
  } else {
    tt.style.display = "none";
  }
});

canvas.addEventListener("mouseup", e => {
  const pos     = canvasPos(e);
  const wasDrag = state.dragging;
  state.dragging = null; state.panning = false;
  canvas.style.cursor = "grab";
  document.getElementById("tooltip").style.display = "none";

  if (wasDrag && _mouseDownPos) {
    const dx = pos.x - _mouseDownPos.x, dy = pos.y - _mouseDownPos.y;
    if (dx*dx + dy*dy < 25) selectNode(wasDrag);
  } else if (!wasDrag) {
    const node = nodeAt(pos.x, pos.y);
    if (node) selectNode(node);
    else if (!edgeAt(pos.x, pos.y)) deselectNode();
  }
  _mouseDownNode = null; _mouseDownPos = null;
});

canvas.addEventListener("mouseleave", () => {
  document.getElementById("tooltip").style.display = "none";
});

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const f   = e.deltaY < 0 ? 1.1 : 0.91;
  const pos = canvasPos(e);
  state.viewX = pos.x - (pos.x - state.viewX) * f;
  state.viewY = pos.y - (pos.y - state.viewY) * f;
  state.scale = Math.max(0.15, Math.min(5, state.scale * f));
}, { passive: false });

// ── Detail panel ──────────────────────────────────────────────────────────────
export function selectNode(node) {
  setCurrentPaperCache(node);
  state.selectedNode = node;
  document.getElementById("detail-panel").classList.add("open");
  document.getElementById("detail-tag").textContent     = `— ${node.venue}`;
  document.getElementById("detail-title").textContent   = node.title;
  document.getElementById("detail-authors").textContent = node.authors.join(", ");

  // ── Node color picker ─────────────────────────────────────────────────────
  const swatchContainer = document.getElementById("node-color-swatches");
  const colorInput      = document.getElementById("node-color-custom");
  const resetBtn        = document.getElementById("node-color-reset");
  const currentColor    = colorForPaper(node);

  // Render preset swatches
  swatchContainer.innerHTML = COLOR_PALETTE.map(hex => `
    <button class="node-color-swatch${hex === currentColor ? " active" : ""}"
            style="background:${hex}" data-color="${hex}" title="${hex}"></button>
  `).join("");

  // Sync native color input to current color
  colorInput.value = currentColor.length === 7 ? currentColor : "#888888";

  function applyColor(hex) {
    nodeColorOverrides[node.id] = hex;
    colorInput.value = hex;
    // Update active swatch
    swatchContainer.querySelectorAll(".node-color-swatch").forEach(s =>
      s.classList.toggle("active", s.dataset.color === hex));
    // Update detail-tag accent colour
    document.getElementById("detail-tag").style.color = hex;
  }

  function resetColor() {
    delete nodeColorOverrides[node.id];
    const def = colorForPaper(node);
    colorInput.value = def.length === 7 ? def : "#888888";
    swatchContainer.querySelectorAll(".node-color-swatch").forEach(s =>
      s.classList.toggle("active", s.dataset.color === def));
    document.getElementById("detail-tag").style.color = "";
  }

  // Clone to remove stale listeners
  const freshInput = colorInput.cloneNode(true);
  colorInput.parentNode.replaceChild(freshInput, colorInput);
  freshInput.value = currentColor.length === 7 ? currentColor : "#888888";
  freshInput.addEventListener("input", e => applyColor(e.target.value));

  const freshReset = resetBtn.cloneNode(true);
  resetBtn.parentNode.replaceChild(freshReset, resetBtn);
  freshReset.addEventListener("click", resetColor);

  swatchContainer.addEventListener("click", e => {
    const swatch = e.target.closest(".node-color-swatch");
    if (swatch) applyColor(swatch.dataset.color);
  });

  // Build meta grid from custom attributes (skip abstract)
  const metaAttrs = (node.attributes ?? [])
    .filter(a => a.key !== "abstract")
    .sort((a, b) => a.order - b.order)
    .slice(0, 6);

  document.getElementById("detail-meta").innerHTML = [
    { label: "Year",  val: node.year},
    { label: "Venue", val: node.venue },
    { label: "Tags", val: node.hashtags }
  ].map(b => `<div class="meta-item">
    <div class="meta-label">${b.label}</div>
    <div class="meta-value">${b.val}</div>
  </div>`).join("");
  // ── Abstract / Notes toggle buttons ──────────────────────────────────────
  // Reset container and button states on every new node selection
  const container = document.getElementById("detail-container");
  container.innerHTML = "";

  // Clone buttons to wipe any previous event listeners
  ["abstract-btn", "note-btn", "sidebar-pdf-btn"].forEach(id => {
    const old = document.getElementById(id);
    if (!old) return;
    const fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
    fresh.classList.remove("active");
  });

  // Hide PDF viewer on new selection
  const sidebarPdfWrap = document.getElementById("sidebar-pdf-wrap");
  if (sidebarPdfWrap) sidebarPdfWrap.style.display = "none";

  let _activePanel = null;

  function togglePanel(type) {
    if (_activePanel === type) {
      container.innerHTML = "";
      if (sidebarPdfWrap) sidebarPdfWrap.style.display = "none";
      _activePanel = null;
      ["abstract-btn","note-btn","sidebar-pdf-btn"].forEach(id => {
        document.getElementById(id)?.classList.remove("active");
      });
      return;
    }
    _activePanel = type;
    ["abstract-btn","note-btn","sidebar-pdf-btn"].forEach(id => {
      document.getElementById(id)?.classList.remove("active");
    });

    if (type === "abstract") {
      const text = attr(node, "abstract", "<em style='color:var(--text-dim)'>No abstract available.</em>");
      container.innerHTML = `<div class="detail-panel-text">${window.marked.parse(text, { breaks: true, gfm: true })}</div>`;
      if (sidebarPdfWrap) sidebarPdfWrap.style.display = "none";
      document.getElementById("abstract-btn").classList.add("active");

    } else if (type === "notes") {
      const text = node.notes
        ? node.notes.replace(/\n/g, "<br>")
        : "<em style='color:var(--text-dim)'>No notes yet — open the paper page to add notes.</em>";
      container.innerHTML = `<div class="detail-panel-text">${window.marked.parse(text, { breaks: true, gfm: true })}</div>`;
      if (sidebarPdfWrap) sidebarPdfWrap.style.display = "none";
      document.getElementById("note-btn").classList.add("active");

    } else if (type === "pdf") {
      container.innerHTML = "";
      document.getElementById("sidebar-pdf-btn").classList.add("active");
      showSidebarPdf(node);
    }
  }

  document.getElementById("abstract-btn").addEventListener("click",  () => togglePanel("abstract"));
  document.getElementById("note-btn").addEventListener("click",      () => togglePanel("notes"));
  document.getElementById("sidebar-pdf-btn")?.addEventListener("click", () => togglePanel("pdf"));

  // "Open Paper Page" shortcut inside the sidebar PDF no-PDF placeholder
  document.getElementById("sidebar-pdf-open-page")?.addEventListener("click", () => {
    const connected = getConnected(node);
    openPaperPage(node, connected);
  });

  document.getElementById("attributes-meta").innerHTML = [
    ...metaAttrs.map(a => ({ label: a.key, val: a.value, hashtags: a.hashtags })),
  ].map(b => `<div class="meta-item">
    <div class="meta-label">${b.label}</div>
    <div class="meta-value">${b.val}</div>
  </div>`).join("");

  const connected = getConnected(node);
  const chips = document.getElementById("connection-chips");
  chips.innerHTML = "";
  connected.forEach(c => {
    const chip = document.createElement("span");
    chip.className = "connection-chip";
    const short = c.paper.title.length > 26 ? c.paper.title.slice(0,24) + "…" : c.paper.title;
    chip.innerHTML = `${short} <span style="color:var(--accent);font-size:.58rem">${c.sim.toFixed(2)}</span>`;
    chip.title = `${c.type.replace(/_/g," ")} · sim=${c.sim.toFixed(3)}`;
    chip.addEventListener("click", () => {
      const n = state.nodes.find(n => n.id === c.id);
      if (n) selectNode(n);
    });
    chips.appendChild(chip);
  });

  const oldBtn = document.getElementById("dp-open-page");
  const newBtn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(newBtn, oldBtn);
  newBtn.addEventListener("click", () => openPaperPage(node, connected));
}

export function deselectNode() {
  state.selectedNode = null;
  document.getElementById("detail-panel").classList.remove("open");
}

export function getConnected(node) {
  return getEdgesCache()
    .filter(e => e.source === node.id || e.target === node.id)
    .map(e => {
      const otherId = e.source === node.id ? e.target : e.source;
      return { id: otherId, sim: e.similarity, type: e.type,
               paper: getPapersCache().find(p => p.id === otherId) };
    })
    .filter(c => c.paper)
    .sort((a, b) => b.sim - a.sim);
}

document.getElementById("close-panel").addEventListener("click", deselectNode);

// ── Toolbar ───────────────────────────────────────────────────────────────────
document.getElementById("btn-force").addEventListener("click", () => {
  state.layoutMode = "force"; SIM.running = true; SIM.damping = 0.82; tick = 0;
  document.getElementById("btn-force").classList.add("active");
  document.getElementById("btn-radial").classList.remove("active");
});
document.getElementById("btn-radial").addEventListener("click", () => {
  state.layoutMode = "radial"; SIM.running = false; applyRadialLayout();
  document.getElementById("btn-radial").classList.add("active");
  document.getElementById("btn-force").classList.remove("active");
});
document.getElementById("btn-reset").addEventListener("click", () => {
  state.viewX = state.viewY = 0; state.scale = 1;
  SIM.damping = 0.82; tick = 0;
  if (state.layoutMode === "force") SIM.running = true; else applyRadialLayout();
});
document.getElementById("zoom-in").addEventListener("click",
  () => { state.scale = Math.min(5, state.scale * 1.2); });
document.getElementById("zoom-out").addEventListener("click",
  () => { state.scale = Math.max(0.15, state.scale * 0.83); });
document.getElementById("zoom-fit").addEventListener("click",
  () => { state.viewX = state.viewY = 0; state.scale = 1; });
document.getElementById("search-input").addEventListener("input",
  e => { state.searchQuery = e.target.value.trim(); });

// ── Similarity threshold range bar ───────────────────────────────────────────
(function wireThreshold() {
  const slider = document.getElementById("sim-threshold-range");
  const label  = document.getElementById("sim-threshold-value");
  if (!slider || !label) return;

  function update(val) {
    simThreshold = parseFloat(val);
    // _simConfig.threshold = simThreshold;
    label.textContent = simThreshold.toFixed(2);
    // Update visible edge count
    const visible = getEdgesCache().filter(e => e.similarity >= simThreshold).length;
    document.getElementById("stat-connections").textContent = visible;
  }

  slider.value = simThreshold;
  update(simThreshold);
  slider.addEventListener("input", e => update(e.target.value));
})();

document.addEventListener("keydown", e => {
  const overlay = document.getElementById("paper-page-overlay");
  const modal   = document.getElementById("new-paper-modal");
  if (e.key === "Escape") {
    if (modal?.classList.contains("open"))   { closeNewPaperModal(); return; }
    if (overlay?.classList.contains("open")) { return; }
    deselectNode();
    return;
  }
  if (overlay?.classList.contains("open") || modal?.classList.contains("open")) return;
  if (e.key === "+" || e.key === "=") state.scale = Math.min(5,    state.scale * 1.15);
  if (e.key === "-")                  state.scale = Math.max(0.15, state.scale * 0.87);
  if (e.key === "0") { state.scale = 1; state.viewX = state.viewY = 0; }
});

// ── New Paper modal ───────────────────────────────────────────────────────────
function openNewPaperModal() {
  document.getElementById("new-paper-modal").classList.add("open");
  document.getElementById("npm-title").focus();
}
function closeNewPaperModal() {
  document.getElementById("new-paper-modal").classList.remove("open");
  document.getElementById("npm-status").textContent = "";
  ["npm-title","npm-authors","npm-venue","npm-hashtags","npm-abstract"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("npm-year").value = String(new Date().getFullYear());
}

document.getElementById("btn-new-paper").addEventListener("click", openNewPaperModal);
document.getElementById("npm-close").addEventListener("click", closeNewPaperModal);
document.getElementById("npm-cancel-btn").addEventListener("click", closeNewPaperModal);
document.getElementById("new-paper-modal").addEventListener("click", e => {
  if (e.target === document.getElementById("new-paper-modal")) closeNewPaperModal();
});

document.getElementById("npm-submit-btn").addEventListener("click", async () => {
  const title   = document.getElementById("npm-title").value.trim();
  const authors = document.getElementById("npm-authors").value.trim();
  const statusEl = document.getElementById("npm-status");

  if (!title || !authors) {
    statusEl.textContent = "Title and at least one author are required.";
    statusEl.style.color = "var(--accent3)";
    return;
  }

  const rawTags    = document.getElementById("npm-hashtags").value.trim();
  const rawAbstract = document.getElementById("npm-abstract")?.value.trim() ?? "";
  const year        = Number(document.getElementById("npm-year").value) || new Date().getFullYear();
  const venue       = document.getElementById("npm-venue").value.trim();

  const hashtags   = rawTags
    ? rawTags.split(/[,\s]+/).map(t => t.trim()).filter(Boolean).map(t => t.startsWith("#") ? t : "#" + t)
    : [];

  const attributes = rawAbstract
    ? [{ key: "abstract", value: rawAbstract, order: 0 }]
    : [];

  const newPaper = {
    title,
    authors: authors.split(/,\s*/).map(a => a.trim()).filter(Boolean),
    venue,
    year,
    hashtags,
    attributes,
  };

  statusEl.textContent = "Saving…";
  statusEl.style.color = "var(--text-secondary)";

  try {
    // 1. Persist to SQLite — returns the new integer id
    const newId = await invoke("add_paper", { paper: newPaper });

    // 2. Compute similarity edges for this new paper
    statusEl.textContent = "Computing edges…";
    const existingPapers = getPapersCache();
    const tempPaper = { id: newId, year, venue, hashtags };
    const newEdges = await computeEdgesForNewPaper(tempPaper, existingPapers, _simConfig);
    if (newEdges.length > 0) {
      await invoke("append_edges", { edges: newEdges });
    }

    // 3. Reload from DB
    statusEl.textContent = "Syncing…";
    setPapersCache((await invoke("get_papers")).map(adaptPaper));
    setEdgesCache((await invoke("get_edges")).map(adaptEdge));

    // 4. Add node to running simulation
    const W = canvas.width  / devicePixelRatio;
    const H = canvas.height / devicePixelRatio;
    const fresh = getPapersCache().find(p => p.id === newId);
    if (fresh) {
      state.nodes.push({
        ...fresh,
        x: W/2 + (Math.random()-0.5)*80, y: H/2 + (Math.random()-0.5)*80,
        vx: (Math.random()-0.5)*4, vy: (Math.random()-0.5)*4,
        radius: nodeRadius(fresh),
      });
    }
    rebuildEdgeRefs();

    document.getElementById("stat-papers").textContent      = getPapersCache().length;
    document.getElementById("stat-connections").textContent = getEdgesCache().length;

    statusEl.textContent = `✓ "${title}" added — ${newEdges.length} edges`;
    statusEl.style.color = "var(--accent)";
    setTimeout(closeNewPaperModal, 1400);
  } catch (err) {
    statusEl.textContent = `✗ ${err}`;
    statusEl.style.color = "var(--accent3)";
    console.error("[PaperGraph] add_paper failed:", err);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
resizeCanvas();
loadFromDB();
// ── Reload graph (called when project switches) ───────────────────────────────
export async function reloadGraph() {
  deselectNode();
  state.nodes = []; state.edges = [];
  setPapersCache([]); setEdgesCache([]);
  await loadFromDB();
}

// ── Wire project switcher ─────────────────────────────────────────────────────
onProjectSwitch(async () => { await reloadGraph(); });
loadProjects();

// ── Sidebar PDF viewer (preview only — upload via Open Paper Page) ────────────
async function showSidebarPdf(node) {
  const wrap     = document.getElementById("sidebar-pdf-wrap");
  const iframe   = document.getElementById("sidebar-pdf-iframe");
  const status   = document.getElementById("sidebar-pdf-status");
  const dropzone = document.getElementById("sidebar-pdf-dropzone");
  if (!wrap) return;

  wrap.style.display = "flex";

  if (!node.pdf_path) {
    showDropzone(dropzone, iframe);
    iframe.src             = "";
    if (status) status.textContent = "No PDF — open the paper page to upload one.";
    return;
  }

  // Read PDF bytes from Rust and display via blob URL — avoids all asset://
  // protocol CSP/scope issues in Tauri v2.
  iframe.style.display   = "block";
  dropzone.style.display = "none";
  const filename = node.pdf_path.split(/[/\\]/).pop();
  if (status) { status.textContent = "Loading…"; status.style.color = "var(--text-secondary)"; }

  await loadPdfIntoIframe(node.id, iframe, (msg, color) => {
    if (!status) return;
    if (msg === null) {
      status.textContent = filename;
      status.style.color = "";
    } else {
      status.textContent = msg;
      status.style.color = color || "";
    }
  });
}

// ── window.PaperGraph bridge ──────────────────────────────────────────────────
// Exposes graph functions to non-module scripts (similarity-settings.js).
window.PaperGraph = {
  getSimConfig,
  saveSimConfig,
  triggerEdgeRecompute,
  reloadGraph,
};