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
import { computeEdges, computeEdgesForNewPaper, getDefaultConfig, setTagVocab, getTagVocab } from "./similarity.js";
import { loadProjects, onProjectSwitch } from "./projects.js";
import { attachTagAutocomplete } from "./tag-autocomplete.js";

// ── Tauri bridge ──────────────────────────────────────────────────────────────
const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  (() => { throw new Error("Tauri not found — run with `cargo tauri dev`"); })
);
const tauriListen = (
  window.__TAURI__?.event?.listen ??
  null
);

// ── Similarity config (loaded from Rust on boot, persisted on change) ─────────
let _simConfig = getDefaultConfig();

// ── LLM module enable state ───────────────────────────────────────────────────
// null = not yet checked, true = user opted in, false = user opted out
let _hfEnabled = null;

/// Apply LLM-enabled state.
/// The ⚙ Similarity button is always accessible (JS-cosine works without HF).
/// When disabled, only the HuggingFace strategy option inside the panel is
/// grayed out — communicated via window.LitAtlas.isHfEnabled().
function _applyHfEnabled(enabled) {
  _hfEnabled = enabled;
  // The ⚙ Similarity button itself stays enabled regardless — the panel
  // handles HF gating internally via isHfEnabled().
  const btn = document.getElementById("btn-sim-settings");
  if (btn) {
    btn.disabled = false;
    btn.title    = "Similarity Settings";
    btn.classList.remove("hf-disabled");
  }
}

export async function loadSimConfig() {
  try {
    const saved = await invoke("get_similarity_config");
    if (saved && typeof saved === "object") {
      _simConfig = { ...getDefaultConfig(), ...saved };
      // Restore the user's previous LLM choice (true/false/null)
      if (typeof saved.llm_enabled === "boolean") {
        _hfEnabled = saved.llm_enabled;
      }
    }
  } catch (e) {
    console.warn("[LitAtlas] Could not load similarity config:", e);
  }
}

export async function saveSimConfig(cfg) {
  _simConfig = { ...getDefaultConfig(), ...cfg };
  try {
    // Persist llm_enabled alongside the sim config so the choice survives restart
    await invoke("save_similarity_config", {
      config: { ..._simConfig, llm_enabled: _hfEnabled }
    });
  }
  catch (e) { console.warn("[LitAtlas] Could not save similarity config:", e); }
}

async function _persistHfEnabled(val) {
  _hfEnabled = val;
  try {
    await invoke("save_similarity_config", {
      config: { ..._simConfig, llm_enabled: val }
    });
  } catch (e) { console.warn("[LitAtlas] Could not persist llm_enabled:", e); }
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
    const b64 = await invoke("read_pdf_bytes", { paperId });
    // Convert base64 → Uint8Array → Blob
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    _pdfBlobUrl = URL.createObjectURL(blob);
    iframe.src = _pdfBlobUrl;
    if (onStatus) onStatus(null); // clear status
    return true;
  } catch (err) {
    if (onStatus) onStatus("❌ " + err, "var(--accent3)");
    console.error("[LitAtlas] read_pdf_bytes failed:", err);
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
function _overlayEl() {
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
  return el;
}

function showOverlay(msg) {
  const el = _overlayEl();
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

// ── Venv setup overlay ────────────────────────────────────────────────────────
// Shown while Rust is creating the venv and installing sentence-transformers.
// Each step name maps to a human-readable label shown in a step list.
const _VENV_STEPS = [
  { key: "find_python",  label: "Locate system Python" },
  { key: "create_venv",  label: "Create isolated environment" },
  { key: "verify_venv",  label: "Verify environment" },
  { key: "upgrade_pip",  label: "Upgrade pip" },
  { key: "install_deps", label: "Install sentence-transformers" },
  { key: "starting",     label: "Start similarity engine" },
];

// Tracks which steps have completed so the list renders correctly as events arrive.
const _venvStepsDone   = new Set();
let   _venvCurrentStep = "";
let   _venvDetail      = "";

// Rolling pip / pip-upgrade log lines — capped to avoid DOM bloat.
const _pipLog    = [];
const _PIP_LOG_MAX = 120;

// Classify a pip output line for colour coding in the terminal widget.
function _pipLineClass(line) {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("failed") || l.includes("traceback")) return "venv-log-err";
  if (l.includes("warn")  || l.includes("notice"))                             return "venv-log-warn";
  if (l.startsWith("collecting") || l.startsWith("downloading") ||
      l.startsWith("installing") || l.startsWith("successfully"))              return "venv-log-ok";
  return "";
}

// Shared render function — called on every step change AND every pip-log line.
function _renderVenvOverlay() {
  const stepRows = _VENV_STEPS.map(s => {
    const done    = _venvStepsDone.has(s.key) && s.key !== _venvCurrentStep;
    const current = s.key === _venvCurrentStep;
    const icon    = done    ? "✓"
                  : current ? `<span class="venv-spin"></span>`
                  : "·";
    const color   = done ? "#c8ff00" : current ? "#e8eaf0" : "#3a3f50";
    return `<div style="display:flex;align-items:center;gap:10px;color:${color};
                         font-size:.7rem;padding:3px 0">
              <span style="width:14px;text-align:center;line-height:1">${icon}</span>
              <span>${s.label}</span>
            </div>`;
  }).join("");

  // Terminal log box — only shown when pip output exists.
  const showTerminal = _pipLog.length > 0;
  const logHTML = showTerminal
    ? `<div id="venv-terminal">
         <div id="venv-terminal-inner">${
           _pipLog.map(({ text, cls }) =>
             `<div class="venv-log-line ${cls}">${
               text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
             }</div>`
           ).join("")
         }<span class="venv-cursor"></span></div>
       </div>`
    : "";

  const el = _overlayEl();
  el.innerHTML = `
    <div style="font-family:'DM Serif Display',serif;font-size:1.6rem;color:#c8ff00">
      Paper<span style="color:#e8eaf0">Graph</span></div>
    <div style="font-size:.8rem;color:#9ca3af;margin-bottom:4px">
      Setting up similarity engine — first launch only</div>
    <div style="background:#0d0f14;border:1px solid #1e2230;border-radius:8px;
                padding:14px 20px;min-width:300px;text-align:left">
      ${stepRows}
    </div>
    <div style="font-size:.65rem;color:#6b7280;max-width:340px;line-height:1.7;
                margin-top:4px">${_venvDetail}</div>
    ${logHTML}
    <div style="width:28px;height:28px;border:2px solid #1e2230;
                border-top-color:#c8ff00;border-radius:50%;
                animation:_spin .75s linear infinite"></div>
    <style>
      @keyframes _spin  { to { transform: rotate(360deg); } }
      @keyframes _blink { 0%,100% { opacity:1; } 50% { opacity:0; } }
      .venv-spin {
        display:inline-block; width:10px; height:10px; border-radius:50%;
        border:2px solid #1e2230; border-top-color:#c8ff00;
        animation:_spin .75s linear infinite; vertical-align:middle;
      }
      #venv-terminal {
        width:380px; max-width:84vw;
        background:#050608; border:1px solid #141618; border-radius:6px;
        overflow:hidden; margin-top:2px;
      }
      #venv-terminal-inner {
        max-height:130px; overflow-y:auto; padding:8px 10px;
        scroll-behavior:smooth; font-family:'Space Mono',monospace;
      }
      #venv-terminal-inner::-webkit-scrollbar { width:3px; }
      #venv-terminal-inner::-webkit-scrollbar-thumb { background:#1a2a1a; border-radius:2px; }
      .venv-log-line {
        font-size:9px; line-height:1.65; color:#2e4a36;
        white-space:pre-wrap; word-break:break-all;
      }
      .venv-log-ok   { color:#00c878; }
      .venv-log-warn { color:#c8a000; }
      .venv-log-err  { color:#c84040; }
      .venv-cursor {
        display:inline-block; width:6px; height:10px;
        background:#00c87880; vertical-align:text-bottom;
        border-radius:1px; animation:_blink 1s step-end infinite;
      }
    </style>`;
  el.style.display = "flex";

  // Auto-scroll terminal to bottom after render.
  if (showTerminal) {
    requestAnimationFrame(() => {
      const inner = document.getElementById("venv-terminal-inner");
      if (inner) inner.scrollTop = inner.scrollHeight;
    });
  }
}

function _showVenvOverlay(step, detail) {
  _venvCurrentStep = step;
  _venvDetail      = detail;
  _venvStepsDone.add(step);
  _renderVenvOverlay();
}

// Register Tauri event listeners once on load.
// "venv://progress"     — step transitions emitted by the Rust orchestrator.
// "venv://pip-log"      — individual pip/pip-upgrade output lines (streamed).
// "venv://error"        — fatal error from background venv setup thread.
// "embedding://progress"— per-paper encoding progress from hf_compute_all_embeddings.
// "embedding://error"   — fatal error from background embedding thread.

// Callbacks registered by waitForVenvDone() / waitForEmbeddingDone() so they
// can resolve/reject when the background job finishes.
let _venvDoneResolve   = null;
let _venvDoneReject    = null;
let _embedDoneResolve  = null;
let _embedDoneReject   = null;

// Embedding progress state — mirrors the venv step pattern.
let _embedTotal    = 0;
let _embedIndex    = 0;
let _embedTitle    = "";

function _showEmbeddingOverlay() {
  const pct     = _embedTotal > 0 ? Math.round((_embedIndex / _embedTotal) * 100) : 0;
  const barFill = `width:${pct}%`;
  const el      = _overlayEl();
  el.innerHTML = `
    <div style="font-family:'DM Serif Display',serif;font-size:1.6rem;color:#c8ff00">
      Paper<span style="color:#e8eaf0">Graph</span></div>
    <div style="font-size:.8rem;color:#9ca3af;margin-bottom:4px">
      Re-encoding papers for similarity search</div>
    <div style="background:#0d0f14;border:1px solid #1e2230;border-radius:8px;
                padding:14px 20px;min-width:300px;text-align:left">
      <div style="font-size:.68rem;color:#e8eaf0;margin-bottom:8px;white-space:nowrap;
                  overflow:hidden;text-overflow:ellipsis;max-width:280px"
           title="${_embedTitle.replace(/"/g,'&quot;')}">${_embedTitle || "Starting…"}</div>
      <div style="background:#1a1d26;border-radius:4px;height:6px;overflow:hidden">
        <div style="background:#c8ff00;height:100%;border-radius:4px;transition:width .2s;${barFill}"></div>
      </div>
      <div style="font-size:.62rem;color:#6b7280;margin-top:6px;text-align:right">
        ${_embedIndex} / ${_embedTotal}</div>
    </div>
    <div style="width:28px;height:28px;border:2px solid #1e2230;
                border-top-color:#c8ff00;border-radius:50%;
                animation:_spin .75s linear infinite"></div>
    <style>@keyframes _spin{to{transform:rotate(360deg)}}</style>`;
  el.style.display = "flex";
}

if (tauriListen) {
  tauriListen("venv://progress", ({ payload }) => {
    const { step, detail, done } = payload;
    if (done) {
      _VENV_STEPS.forEach(s => _venvStepsDone.add(s.key));
      _venvCurrentStep = "";
      _renderVenvOverlay();
      setTimeout(() => {
        hideOverlay();
        if (_venvDoneResolve) { _venvDoneResolve(); _venvDoneResolve = _venvDoneReject = null; }
      }, 800);
    } else {
      _showVenvOverlay(step, detail);
    }
  });

  tauriListen("venv://error", ({ payload }) => {
    hideOverlay();
    if (_venvDoneReject) {
      _venvDoneReject(payload?.error ?? "Unknown venv error");
      _venvDoneResolve = _venvDoneReject = null;
    }
  });

  tauriListen("venv://pip-log", ({ payload }) => {
    const line = (payload?.line ?? "").trimEnd();
    if (!line) return;
    _pipLog.push({ text: line, cls: _pipLineClass(line) });
    if (_pipLog.length > _PIP_LOG_MAX) _pipLog.shift();
    if (_venvCurrentStep === "install_deps" || _venvCurrentStep === "upgrade_pip") {
      _renderVenvOverlay();
    }
  });

  tauriListen("embedding://progress", ({ payload }) => {
    if (payload?.done) {
      hideOverlay();
      if (_embedDoneResolve) { _embedDoneResolve(); _embedDoneResolve = _embedDoneReject = null; }
    } else if (!payload?.started) {
      _embedIndex = (payload?.index ?? 0) + 1;
      _embedTotal = payload?.total ?? _embedTotal;
      _embedTitle = payload?.title ?? _embedTitle;
      _showEmbeddingOverlay();
    }
  });

  tauriListen("embedding://error", ({ payload }) => {
    hideOverlay();
    if (_embedDoneReject) {
      _embedDoneReject(payload?.error ?? "Unknown embedding error");
      _embedDoneResolve = _embedDoneReject = null;
    }
  });
}

// Returns a promise that resolves when venv://progress { done } fires,
// or rejects on venv://error. Always set this up BEFORE calling invoke("hf_setup_venv").
function _waitForVenvDone() {
  return new Promise((resolve, reject) => {
    _venvDoneResolve = resolve;
    _venvDoneReject  = reject;
  });
}

// Returns a promise that resolves when embedding://progress { done } fires,
// or rejects on embedding://error. Set up BEFORE invoke("hf_compute_all_embeddings").
function _waitForEmbeddingDone() {
  return new Promise((resolve, reject) => {
    _embedDoneResolve = resolve;
    _embedDoneReject  = reject;
  });
}

// ── LLM consent dialog ───────────────────────────────────────────────────────
// Shown on every launch so the user can opt in/out of HF embeddings per session.
// • If the user says Yes and the venv is already ready → start/reuse sidecar.
// • If the user says Yes and the venv is missing → run full setup with progress UI.
// • If the user says No → HF strategy is locked; ⚙ Similarity still opens.
// Returns true if HF was successfully enabled, false otherwise.
async function _runLlmConsentFlow() {
  const agreed = await _showLlmConsentDialog();
  if (!agreed) {
    await _persistHfEnabled(false);
    _applyHfEnabled(false);
    return false;
  }

  // User said Yes — check whether the venv + sentence-transformers are already
  // in place so we can skip the (slow) install steps.
  let venvReady = false;
  try {
    const status = await invoke("hf_setup_status");
    venvReady = status?.ready === true;
  } catch (_) { /* treat as not ready */ }

  _venvStepsDone.clear();
  _venvCurrentStep = "";
  _venvDetail      = "";
  _pipLog.length   = 0;
  // Show the overlay BEFORE invoking so it's visible while the background
  // thread runs — the command now returns immediately.
  _renderVenvOverlay();

  try {
    // Register the done-promise BEFORE invoking to avoid any race.
    const venvDone = _waitForVenvDone();
    await invoke("hf_setup_venv");
    // hf_setup_venv returns immediately; wait for venv://progress { done } event.
    await venvDone;
    // Overlay is hidden by the event handler; proceed with enabling HF.
    await _persistHfEnabled(true);
    _applyHfEnabled(true);
    return true;
  } catch (err) {
    hideOverlay();
    await _showLlmErrorDialog(String(err));
    await _persistHfEnabled(false);
    _applyHfEnabled(false);
    return false;
  }
}

function _showLlmConsentDialog() {
  return new Promise(resolve => {
    const dlg = document.getElementById("llm-consent-dialog");
    if (!dlg) { resolve(false); return; }
    dlg.classList.add("open");
    const yes = document.getElementById("llm-consent-yes");
    const no  = document.getElementById("llm-consent-no");
    function close(r) {
      dlg.classList.remove("open");
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click",  onNo);
      resolve(r);
    }
    const onYes = () => close(true);
    const onNo  = () => close(false);
    yes.addEventListener("click", onYes);
    no.addEventListener("click",  onNo);
  });
}

function _showLlmErrorDialog(msg) {
  return new Promise(resolve => {
    const dlg = document.getElementById("llm-error-dialog");
    if (!dlg) { resolve(); return; }
    const msgEl = document.getElementById("llm-error-msg");
    if (msgEl) msgEl.textContent = msg;
    dlg.classList.add("open");
    const btn = document.getElementById("llm-error-ok");
    function close() {
      dlg.classList.remove("open");
      btn.removeEventListener("click", close);
      resolve();
    }
    btn.addEventListener("click", close);
  });
}

// ── Startup load ──────────────────────────────────────────────────────────────
async function loadFromDB() {
  showOverlay("Opening database…");
  try {
    // Load similarity config first so compute uses user's settings
    await loadSimConfig();
    _simConfig.strategy = "js-cosine";
    // ── LLM module consent ──────────────────────────────────────────────────
    // Ask on every launch whether the user wants HF active this session.
    // If the venv is already set up, saying Yes just enables it immediately
    // with no download/install step. Saying No keeps the ⚙ Similarity panel
    // accessible but locks the HuggingFace strategy option.
    try {
      hideOverlay();
      await _runLlmConsentFlow();
      showOverlay("Opening database…");
    } catch (e) {
      console.warn("[LitAtlas] LLM consent flow failed:", e);
      _applyHfEnabled(false);
    }

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
    console.error("[LitAtlas]", err);
  }
}

// ── Edge recomputation (full rebuild) ─────────────────────────────────────────
export async function triggerEdgeRecompute() {
  // Refresh tag vocabulary in case new hashtags were added since last load.
  const dbTags = await invoke("get_hashtags");
  setTagVocab(dbTags);

  if (_hfEnabled && _simConfig.strategy === "hf-embeddings") {
    // ── HF two-step recompute ──────────────────────────────────────────────
    const embCfg = {
      model:   _simConfig.model   ?? "sentence-transformers/all-MiniLM-L6-v2",
      fields:  _simConfig.fields  ?? ["title", "abstract", "hashtags"],
      weights: _simConfig.weights ?? {},
    };

    // Step 1: Re-encode all papers → write field_vectors to embedding.json.
    // Show the embedding progress overlay BEFORE invoking — the command now
    // returns immediately and streams per-paper progress via events.
    _embedIndex = 0;
    _embedTotal = getPapersCache().length;
    _embedTitle = "";
    _showEmbeddingOverlay();

    const embDone = _waitForEmbeddingDone();
    await invoke("hf_compute_all_embeddings", { config: embCfg });
    // Wait for embedding://progress { done } — overlay hides itself.
    await embDone;

    // Step 2: Load field_vectors from JSON, apply current weights in Rust,
    //         compute cosine similarity — zero Python in this step.
    showOverlay("Computing similarity edges…");
    const papers = getPapersCache().map(p => ({
      id: p.id, title: p.title, venue: p.venue, year: p.year,
      hashtags: p.hashtags, notes: p.notes, attributes: p.attributes,
    }));
    const edgeRes = await invoke("hf_compute_edges_from_cache", {
      papers,
      config: {
        ...embCfg,
        threshold: _simConfig.threshold ?? 0.30,
        max_edges: _simConfig.max_edges ?? 7,
      },
    });
    const computed = edgeRes.edges ?? [];
    await invoke("recompute_edges", { edges: computed });
  } else {
    // ── JS-cosine strategy ─────────────────────────────────────────────────
    const computed = await computeEdges(getPapersCache(), _simConfig);
    await invoke("recompute_edges", { edges: computed });
  }

  const fresh = await invoke("get_edges");
  setEdgesCache(fresh.map(adaptEdge));
  rebuildEdgeRefs();
  hideOverlay();
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
    console.warn("[LitAtlas] refreshPaper failed:", err);
  }
}

// ── Re-compute edges for a single edited paper ───────────────────────────────
// Drops all edges touching paperId, computes fresh ones via the active
// similarity strategy, persists the merged set, then rebuilds canvas refs.
export async function recomputeEdgesForPaper(paperId) {
  const allPapers = getPapersCache();
  const paper     = allPapers.find(p => p.id === paperId);
  if (!paper) return;

  // 1. Compute new edges for this paper against all others
  const others   = allPapers.filter(p => p.id !== paperId);
  const newEdges = await computeEdgesForNewPaper(paper, others, _simConfig);

  // 2. Keep cached edges that don't involve this paper
  const retained = getEdgesCache()
    .filter(e => e.source !== paperId && e.target !== paperId)
    .map(e => ({
      source_id:  e.source,
      target_id:  e.target,
      similarity: e.similarity,
      weight:     e.weight,
      edge_type:  e.type,
    }));

  // 3. Atomic replace — retained edges + newly computed ones
  await invoke("recompute_edges", { edges: [...retained, ...newEdges] });

  // 4. Sync cache and rebuild canvas refs
  const fresh = await invoke("get_edges");
  setEdgesCache(fresh.map(adaptEdge));
  rebuildEdgeRefs();
  document.getElementById("stat-connections").textContent = getEdgesCache().length;
}

function rebuildEdgeRefs() {
  state.edges = getEdgesCache().map(e => ({
    ...e,
    sourceNode: state.nodes.find(n => n.id === e.source),
    targetNode: state.nodes.find(n => n.id === e.target),
  }));
  _rebuildConnectedPairs();
}

// Set of "minId|maxId" strings for node pairs that share at least one edge.
// Used by simulationStep to boost repulsion between unconnected cross-group nodes.
let _connectedPairs = new Set();

function _rebuildConnectedPairs() {
  _connectedPairs = new Set();
  getEdgesCache().forEach(e => {
    const lo = Math.min(e.source, e.target);
    const hi = Math.max(e.source, e.target);
    _connectedPairs.add(`${lo}|${hi}`);
  });
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

  rebuildEdgeRefs(); // also rebuilds _connectedPairs

  const uniqueTags = new Set(papers.flatMap(p => p.hashtags.map(t => t.replace(/^#/, ""))));
  document.getElementById("stat-papers").textContent      = papers.length;
  document.getElementById("stat-connections").textContent = getEdgesCache().length;
  document.getElementById("stat-topics").textContent      = uniqueTags.size;

  loop();
}

// ── UI font size (app-wide, stored in localStorage) ──────────────────────────
// Controls html { font-size } so every rem-based value in the UI scales.
// Default 18 px; user range 10–22 px.
// Canvas node labels use the same scale factor relative to their node radius.

const _UI_FONT_DEFAULT = 18;
const _UI_FONT_MIN     = 10;
const _UI_FONT_MAX     = 28;


let _uiFontSize = Math.min(_UI_FONT_MAX,
  Math.max(_UI_FONT_MIN,
    parseFloat(localStorage.getItem("uiFontSize") ?? String(_UI_FONT_DEFAULT))
  )
);

function _applyUiFontSize(px) {
  _uiFontSize = Math.min(_UI_FONT_MAX, Math.max(_UI_FONT_MIN, Number(px) || _UI_FONT_DEFAULT));
  document.documentElement.style.fontSize = _uiFontSize + "px";
  localStorage.setItem("uiFontSize", _uiFontSize);
}

// Apply immediately on load so there's no flash of the browser default.
_applyUiFontSize(_uiFontSize);

export function setUiFontSize(px) { _applyUiFontSize(px); }
export function getUiFontSize()   { return _uiFontSize; }

export function getUiFontSize_MAX()   { return _UI_FONT_MAX; }
export function getUiFontSize_MIN()   { return _UI_FONT_MIN; }

// ── Similarity threshold (controlled by range bar) ────────────────────────────
let simThreshold = 0.38;

// ── Force simulation ──────────────────────────────────────────────────────────
const SIM = {
  repulsion: 7500, attraction: 0.036, centerForce: 0.016,
  damping: 0.82, idealBase: 170, running: true,
  // Extra repulsion multiplier applied between nodes that belong to different
  // primary-tag groups AND share no direct edge.  1 = no extra push.
  groupSeparation: 4.5,
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

      // Boost repulsion between nodes from different groups that share no edge.
      const sameGroup = (a.hashtags?.[0] ?? "") === (b.hashtags?.[0] ?? "");
      const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
      const connected = _connectedPairs.has(`${lo}|${hi}`);
      const sep = (!sameGroup && !connected) ? SIM.groupSeparation : 1;

      const f  = SIM.repulsion * sep / (d*d);
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

// ── Edge overlap helper ───────────────────────────────────────────────────────
// Returns the shared concepts between two paper nodes: tags, venue, year, authors.
function computeOverlap(a, b) {
  const tagsA = new Set((a.hashtags ?? []).map(t => t.replace(/^#/, "").toLowerCase()));
  const tagsB = new Set((b.hashtags ?? []).map(t => t.replace(/^#/, "").toLowerCase()));
  const sharedTags = [...tagsA].filter(t => tagsB.has(t));

  const venueA = (a.venue ?? "").trim();
  const venueB = (b.venue ?? "").trim();
  const sharedVenue = (venueA && venueA === venueB) ? venueA : null;

  const yearA = Number(a.year ?? 0);
  const yearB = Number(b.year ?? 0);
  const sharedYear = (yearA && yearA === yearB) ? yearA : null;

  const authsA = new Set((a.authors ?? []).map(s => s.trim().toLowerCase()));
  const authsB = new Set((b.authors ?? []).map(s => s.trim().toLowerCase()));
  // Preserve original casing from paper A
  const sharedAuthors = (a.authors ?? []).filter(s => authsB.has(s.trim().toLowerCase()));

  return { sharedTags, sharedVenue, sharedYear, sharedAuthors };
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
  const hovEdge = !sel ? state.hoveredEdge : null; // edge hover only when no node selected

  // Build set of node IDs connected to selected node (by edges passing threshold)
  const connectedIds = new Set();
  if (sel) {
    state.edges.forEach(e => {
      if (e.similarity < simThreshold) return;
      if (e.sourceNode?.id === sel) connectedIds.add(e.targetNode?.id);
      if (e.targetNode?.id === sel) connectedIds.add(e.sourceNode?.id);
    });
  }

  // Build set of the two endpoint node IDs for the hovered edge
  const hovEdgeEndpoints = new Set();
  if (hovEdge) {
    if (hovEdge.sourceNode) hovEdgeEndpoints.add(hovEdge.sourceNode.id);
    if (hovEdge.targetNode) hovEdgeEndpoints.add(hovEdge.targetNode.id);
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
      // Edge is visible only when BOTH endpoints match the active search fields
      alpha = (nodeMatchesSearch(a, q) && nodeMatchesSearch(b, q)) ? 1 : 0;
    } else if (sel) {
      // Selection mode: only show edges directly connected to selected node
      alpha = (a.id === sel || b.id === sel) ? 1 : 0;
    } else if (hovEdge) {
      // Edge hover mode: full alpha for the hovered edge, ghost everything else
      alpha = (e === hovEdge) ? 1 : 0.08;
    } else {
      alpha = 1;
    }
    if (alpha > 0) drawEdge(e, alpha);
  });

  // Draw nodes — dim unrelated when a node is selected or edge is hovered
  state.nodes.forEach(n => {
    const matchesSearch = nodeMatchesSearch(n, q);

    if (!matchesSearch) { drawNodeFaded(n); return; }

    if (sel && n.id !== sel && !connectedIds.has(n.id)) {
      drawNodeFaded(n);
    } else if (hovEdge && !hovEdgeEndpoints.has(n.id)) {
      // Dim all nodes that aren't the two endpoints of the hovered edge
      drawNodeFaded(n);
    } else {
      // Pass edgeHighlight=true for the two endpoint nodes
      drawNode(n, hovEdge ? hovEdgeEndpoints.has(n.id) : false);
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
    const _fontScale = getUiFontSize() / _UI_FONT_DEFAULT;
    ctx.font = `bold ${Math.max(12, _fontScale)}px 'Space Mono'`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(e.similarity.toFixed(3), (a.x+b.x)/2, (a.y+b.y)/2 - 8);
  }
  ctx.restore();
}

function drawNode(n, edgeHighlight = false) {
  const sel   = state.selectedNode?.id === n.id;
  const hov   = state.hoveredNode?.id  === n.id || edgeHighlight;
  const color = colorForPaper(n);
  const r     = n.radius;

  if (sel || hov) {
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = sel ? 28 : 18;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
  ctx.fillStyle   = (sel || edgeHighlight) ? color : color + "22";
  ctx.fill();
  ctx.strokeStyle = (sel || edgeHighlight) ? "#fff" : color;
  ctx.lineWidth   = (sel || edgeHighlight) ? 2.5 : 1.5;
  ctx.stroke();

  const label = n.title.length > 18 ? n.title.slice(0, 16) + "…" : n.title;
  ctx.fillStyle    = (sel || edgeHighlight) ? "#fff" : "#c8d0e0";
  const _fontScale = getUiFontSize() / _UI_FONT_DEFAULT;
  ctx.font         = `${(sel || edgeHighlight) ? "bold " : ""}${Math.max(16, r * 0.42 * _fontScale)}px 'Space Mono'`;
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
    if (e.similarity < simThreshold) continue;  // invisible edges are not interactive
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

  const tt     = document.getElementById("tooltip");
  const edgeTt = document.getElementById("edge-tooltip");

  if (state.hoveredNode) {
    // ── Node tooltip ──────────────────────────────────────────────────────
    const n = state.hoveredNode;
    document.getElementById("tt-title").textContent = n.title;
    document.getElementById("tt-year").textContent  = `${n.year} · ${n.venue}`;
    document.getElementById("tt-tag").innerHTML = (n.hashtags ?? []).join(", ");
    tt.style.display     = "block";
    tt.style.left        = (e.clientX + 14) + "px";
    tt.style.top         = e.clientY + "px";
    edgeTt.style.display = "none";

  } else if (state.hoveredEdge) {
    // ── Edge overlap tooltip ──────────────────────────────────────────────
    tt.style.display = "none";
    const edge = state.hoveredEdge;
    const nA   = edge.sourceNode;
    const nB   = edge.targetNode;
    if (nA && nB) {
      // Header
      document.getElementById("et-sim").textContent = `sim ${edge.similarity.toFixed(3)}`;
      const typeEl  = document.getElementById("et-type");
      const typeLabel = edge.type === "same_tag"   ? "same tag"
                      : edge.type === "same_venue" ? "same venue"
                      : "related";
      typeEl.textContent = typeLabel;
      typeEl.className   = edge.type === "same_tag"   ? "type-same-tag"
                         : edge.type === "same_venue" ? "type-same-venue"
                         : "type-related";

      // Paper titles
      const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
      document.getElementById("et-paper-a").textContent = trunc(nA.title, 32);
      document.getElementById("et-paper-b").textContent = trunc(nB.title, 32);

      // Overlapping concepts
      const { sharedTags, sharedVenue, sharedYear, sharedAuthors } = computeOverlap(nA, nB);

      const tagsRow    = document.getElementById("et-tags-row");
      const venueRow   = document.getElementById("et-venue-row");
      const yearRow    = document.getElementById("et-year-row");
      const authorsRow = document.getElementById("et-authors-row");
      const noOverlap  = document.getElementById("et-no-overlap");

      if (sharedTags.length > 0) {
        document.getElementById("et-tags").innerHTML =
          sharedTags.map(t => `<span class="et-chip">#${t}</span>`).join("");
        tagsRow.style.display = "flex";
      } else { tagsRow.style.display = "none"; }

      if (sharedVenue) {
        document.getElementById("et-venue").textContent = sharedVenue;
        venueRow.style.display = "flex";
      } else { venueRow.style.display = "none"; }

      if (sharedYear) {
        document.getElementById("et-year").textContent = sharedYear;
        yearRow.style.display = "flex";
      } else { yearRow.style.display = "none"; }

      if (sharedAuthors.length > 0) {
        document.getElementById("et-authors").innerHTML =
          sharedAuthors.map(a => `<span class="et-chip et-chip-author">${a}</span>`).join("");
        authorsRow.style.display = "flex";
      } else { authorsRow.style.display = "none"; }

      const hasOverlap = sharedTags.length > 0 || sharedVenue || sharedYear || sharedAuthors.length > 0;
      noOverlap.style.display = hasOverlap ? "none" : "block";

      // Position — nudge left if near right viewport edge
      const left = (e.clientX + 16 + 280 > window.innerWidth)
        ? e.clientX - 290 : e.clientX + 16;
      edgeTt.style.left    = left + "px";
      edgeTt.style.top     = (e.clientY - 10) + "px";
      edgeTt.style.display = "block";
    }

  } else {
    tt.style.display     = "none";
    edgeTt.style.display = "none";
  }
});

canvas.addEventListener("mouseup", e => {
  const pos     = canvasPos(e);
  const wasDrag = state.dragging;
  state.dragging = null; state.panning = false;
  canvas.style.cursor = "grab";
  document.getElementById("tooltip").style.display     = "none";
  document.getElementById("edge-tooltip").style.display = "none";

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
  document.getElementById("tooltip").style.display     = "none";
  document.getElementById("edge-tooltip").style.display = "none";
  state.hoveredEdge = null;
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
// ── Search field filter ──────────────────────────────────────────────────────
// Which fields to include when filtering by the search query.
// Toggled by the sf-pill buttons; all four active = search everything.
const _searchFields = new Set(["title", "authors", "tags", "venue"]);

// Returns true if node n matches the current query under the active field set.
function nodeMatchesSearch(n, q) {
  if (!q) return true;
  if (_searchFields.has("title")   && n.title.toLowerCase().includes(q))          return true;
  if (_searchFields.has("authors") && n.authors.join(" ").toLowerCase().includes(q)) return true;
  if (_searchFields.has("tags")    && n.hashtags.join(" ").toLowerCase().includes(q)) return true;
  if (_searchFields.has("venue")   && (n.venue ?? "").toLowerCase().includes(q))  return true;
  return false;
}

// Wire search field pill toggles
document.querySelectorAll(".sf-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    const field = btn.dataset.field;
    if (_searchFields.has(field)) {
      // Don't allow deselecting the last active pill
      if (_searchFields.size > 1) {
        _searchFields.delete(field);
        btn.classList.remove("active");
      }
    } else {
      _searchFields.add(field);
      btn.classList.add("active");
    }
  });
});

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

// Attach hashtag autocomplete to the new-paper modal input (once, at boot).
attachTagAutocomplete(document.getElementById("npm-hashtags"), getTagVocab);

document.getElementById("npm-submit-btn").addEventListener("click", async () => {
  const title   = document.getElementById("npm-title").value.trim();
  const authors = document.getElementById("npm-authors").value.trim();
  const statusEl = document.getElementById("npm-status");

  if (!title) {
    statusEl.textContent = "A title is required.";
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

    // 1b. Auto-compute embedding if HF module is enabled
    if (_hfEnabled && _simConfig.strategy === "hf-embeddings") {
      statusEl.textContent = "Computing embedding…";
      try {
        await invoke("hf_compute_paper_embedding", {
          paperId: newId,
          config:  _simConfig,
        });
      } catch (embErr) {
        // Non-fatal: log the error but continue adding the paper
        console.warn("[LitAtlas] Auto-embed failed:", embErr);
      }
    }

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
    console.error("[LitAtlas] add_paper failed:", err);
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

// ── window.LitAtlas bridge ──────────────────────────────────────────────────
// Exposes graph functions to non-module scripts (similarity-settings.js).
window.LitAtlas = {
  getSimConfig,
  saveSimConfig,
  triggerEdgeRecompute,
  recomputeEdgesForPaper,
  reloadGraph,
  isHfEnabled: () => _hfEnabled,
  enableHf:    () => _runLlmConsentFlow(),
  getUiFontSize,
  setUiFontSize,
  getUiFontSize_MAX,
  getUiFontSize_MIN,
};