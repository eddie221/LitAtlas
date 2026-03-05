"use strict";

import { getDefaultConfig } from "./similarity.js";

/**
 * similarity_settings.js
 *
 * Renders the ⚙ Similarity settings panel.
 *
 * Model section behaviour:
 *   • On open / on model-select change → invoke("hf_check_model")
 *   • If cached      → green "✓ Downloaded" badge, Recompute enabled
 *   • If not cached  → amber "↓ Not downloaded" badge + size, Recompute disabled
 *                      "Download Model (N MB)" button appears
 *   • During download → live progress bar driven by venv://model-progress events
 *   • On error       → red badge + message + Retry button
 */

function _getSimConfig()           { return window.PaperGraph?.getSimConfig?.()    ?? {}; }
async function _saveSimConfig(cfg) { return window.PaperGraph?.saveSimConfig?.(cfg); }
async function _recompute()        { return window.PaperGraph?.triggerEdgeRecompute?.(); }

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  null
);
const tauriListen = window.__TAURI__?.event?.listen ?? null;

// ── Known fields (must match Python AVAILABLE_FIELDS) ─────────────────────────
const FIELDS = [
  { key: "title",    label: "Title",    defaultWeight: 1.0 },
  { key: "abstract", label: "Abstract", defaultWeight: 1.0 },
  { key: "hashtags", label: "Hashtags", defaultWeight: 1.0 },
  { key: "venue",    label: "Venue",    defaultWeight: 1.0 },
  { key: "notes",    label: "Notes",    defaultWeight: 1.0 },
  { key: "year",     label: "Year",     defaultWeight: 1.0 },
];

// ── Open / close ──────────────────────────────────────────────────────────────
export function openSimilaritySettings() {
  const panel = document.getElementById("sim-settings-panel");
  if (!panel) return;
  renderSettings(panel);
  panel.classList.add("open");
  document.getElementById("sim-settings-backdrop")?.classList.add("open");
}

export function closeSimilaritySettings() {
  document.getElementById("sim-settings-panel")?.classList.remove("open");
  document.getElementById("sim-settings-backdrop")?.classList.remove("open");
}

// ── Built-in model list (fallback when sidecar is not yet running) ─────────────
const _BUILTIN_MODELS = [
  { id: "sentence-transformers/all-MiniLM-L6-v2",
    label: "MiniLM-L6-v2 (fast, 384-dim)",
    description: "Lightweight and fast. Good for most cases.", size_mb: 80 },
  { id: "sentence-transformers/all-mpnet-base-v2",
    label: "MPNet-base-v2 (accurate, 768-dim)",
    description: "Higher accuracy, slower. Best for research quality.", size_mb: 420 },
  { id: "sentence-transformers/multi-qa-MiniLM-L6-cos-v1",
    label: "Multi-QA MiniLM (semantic search)",
    description: "Optimised for semantic similarity search.", size_mb: 80 },
  { id: "allenai/specter2_base",
    label: "SPECTER2 (academic papers)",
    description: "Trained on scientific paper citations. Best for academic similarity.", size_mb: 440 },
];

// ── Per-model cache status memo: modelId → true | false | null (unknown) ──────
const _cacheStatus = {};

async function _checkModelCached(modelId) {
  if (_cacheStatus[modelId] === true) return true;   // already confirmed
  if (!invoke) return null;
  try {
    const res = await invoke("hf_check_model", { model: modelId });
    _cacheStatus[modelId] = res?.cached === true;
    return _cacheStatus[modelId];
  } catch (_) {
    return null;   // sidecar not running — status unknown
  }
}

// ── Main render ───────────────────────────────────────────────────────────────
async function renderSettings(panel) {
  const cfg    = _getSimConfig();
  const isHF   = cfg.strategy === "hf-embeddings";
  const hfOk   = window.PaperGraph?.isHfEnabled?.() === true;
  let   models = _BUILTIN_MODELS;
  console.log("hfOk : ", hfOk);
  const body = panel.querySelector("#sim-settings-body");
  if (!body) return;
  body.innerHTML = buildHTML(cfg, models, isHF, hfOk);
  wireEvents(panel, cfg, models, hfOk);

  // Check cache for the currently selected model.
  if (isHF) {
    // Async: refresh model list from live sidecar (non-blocking).
    if (invoke) {
      try {
        const res = await invoke("hf_list_models");
        if (res?.models?.length) {
          models = res.models;
          const sel = body.querySelector("#sim-model-select");
          if (sel) {
            const cur = sel.value;
            sel.innerHTML = models.map(m =>
              `<option value="${m.id}" ${m.id===cur?"selected":""}>${m.label}</option>`
            ).join("");
            _setModelDesc(body, models, sel.value);
          }
        }
      } catch (_) { /* use builtin list */ }
    }
    const modelId = body.querySelector("#sim-model-select")?.value
                 ?? cfg.model ?? _BUILTIN_MODELS[0].id;
    await _refreshDownloadUI(body, modelId, models);
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHTML(cfg, models, isHF, hfOk) {
  const weights   = cfg.weights ?? {};
  const selFields = new Set(cfg.fields ?? ["title","abstract","hashtags"]);

  const modelOptions = models.map(m =>
    `<option value="${m.id}" ${m.id===cfg.model?"selected":""}>${m.label}</option>`
  ).join("");

  // checkbox available
  const fieldRows = FIELDS.map(f => {
    const w     = weights[f.key] ?? f.defaultWeight;
    const check = selFields.has(f.key) ? "checked" : "";
    return `
      <div class="sim-field-row" data-field="${f.key}">
        <label class="sim-field-label">
          <input type="checkbox" class="sim-field-check" data-field="${f.key}" ${check}>
          <span>${f.label}</span>
        </label>
        <div class="sim-weight-wrap ${!selFields.has(f.key) ? "disabled" : ""}">
          <input type="range" class="sim-weight-range" data-field="${f.key}"
                 min="0.0" max="1" step="0.01" value="${w}"
                 ${!selFields.has(f.key) ? "disabled" : ""}>
          <span class="sim-weight-val" data-field="${f.key}">${w.toFixed(1)}</span>
        </div>
      </div>`;
  }).join("");

  // checkbox available
  // const fieldRows = FIELDS.map(f => {
  //   const w     = weights[f.key] ?? f.defaultWeight;
  //   const check = selFields.has(f.key) ? "checked" : "";
  //   return `
  //     <div class="sim-field-row" data-field="${f.key}">
  //       <label class="sim-field-label">
  //         <input type="checkbox" class="sim-field-check" data-field="${f.key}" ${check}>
  //         <span>${f.label}</span>
  //       </label>
  //       <div class="sim-weight-wrap ${!selFields.has(f.key) ? "disabled" : ""}">
  //         <input type="range" class="sim-weight-range" data-field="${f.key}"
  //                min="0.0" max="1" step="0.01" value="${w}"
  //                disabled >
  //         <span class="sim-weight-val" data-field="${f.key}">${w.toFixed(1)}</span>
  //       </div>
  //     </div>`;
  // }).join("");

  return `
    <!-- Strategy toggle -->
    <div class="sim-section">
      <div class="sim-section-title">Strategy</div>
      <div class="sim-strategy-row">
        <button class="sim-strat-btn ${!isHF?"active":""}" data-strat="js-cosine">
          <span class="sim-strat-icon">⚡</span>
          <div>
            <div class="sim-strat-name">Attributed Cosine</div>
            <div class="sim-strat-desc">Fast · No setup · Hashtags</div>
          </div>
        </button>
        <button class="sim-strat-btn ${isHF&&hfOk?"active":""} ${!hfOk?"hf-locked":""}"
                data-strat="hf-embeddings"
                ${!hfOk?'disabled title="AI features are disabled for this session — restart the app to enable"':''}>
          <span class="sim-strat-icon">😎</span>
          <div>
            <div class="sim-strat-name">MLLM Model</div>
            <div class="sim-strat-desc">${hfOk?"Deep embeddings · Requires Python":"Disabled this session · Restart to enable"}</div>
          </div>
        </button>
      </div>
    </div>

    <!-- HF Model picker -->
    <div class="sim-section sim-hf-only ${!isHF?"hidden":""}">
      <div class="sim-section-title">Model</div>
      <select id="sim-model-select" class="sim-select">${modelOptions}</select>
      <div id="sim-model-desc" class="sim-model-desc"></div>
      <!-- Download status widget — populated by _refreshDownloadUI() -->
      <div id="sim-dl-area"></div>
    </div>

    <!-- Fields & Weights -->
    <div class="sim-section sim-hf-only ${!isHF?"hidden":""}">
      <div class="sim-section-title">Fields &amp; Weights</div>
      <div class="sim-fields-hint">
        Select which fields influence similarity. Higher weight = more influence.
      </div>
      <div id="sim-fields-list">${fieldRows}</div>
    </div>

    <!-- Threshold + max-edges -->
    <div class="sim-section">
      <div class="sim-section-title">Threshold &amp; Connectivity</div>
      <div class="sim-param-row">
        <label>Min similarity
          <span class="sim-param-val" id="sim-thr-val">${(cfg.threshold??0.30).toFixed(2)}</span>
        </label>
        <input type="range" id="sim-thr-range" min="0.0" max="1.0" step="0.01"
               value="${cfg.threshold??0.38}">
      </div>
      <div class="sim-param-row">
        <label>Max edges per node
          <span class="sim-param-val" id="sim-max-val">${cfg.max_edges??7}</span>
        </label>
        <input type="range" id="sim-max-range" min="1" max="20" step="1"
               value="${cfg.max_edges??7}">
      </div>
    </div>

    <!-- Embedding cache (HF only) -->
    <div class="sim-section sim-hf-only ${!isHF?"hidden":""}">
      <div class="sim-section-title">Embedding Cache</div>
      <div class="sim-emb-hint">
        Pre-compute and store embedding vectors next to each paper's PDF.
        Cached embeddings are reused automatically during Recompute — papers
        with unchanged content are skipped, making repeated recomputes fast.
      </div>
      <div id="sim-emb-area">
        <!-- populated by _renderEmbeddingSection() -->
        <button id="sim-emb-btn" class="btn sim-emb-btn">
          ⚡ Cache All Embeddings
        </button>
      </div>
    </div>

    <!-- Status / actions -->
    <div class="sim-section">
      <div id="sim-status" class="sim-status-msg"></div>
      <div class="sim-action-row">
        <button id="sim-save-btn"      class="btn">Save Config</button>
        <button id="sim-recompute-btn" class="btn btn-new-paper">Recompute Graph</button>
      </div>
      <div class="sim-recompute-hint">
        Recomputing replaces all edges with the new similarity scores.
        HuggingFace strategy requires the selected model to be downloaded first.
      </div>
    </div>`;
}

// ── Download area ─────────────────────────────────────────────────────────────

function _fmtBytes(b) {
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b >= 1_000)     return `${(b / 1_000).toFixed(0)} KB`;
  return `${b} B`;
}

function _setModelDesc(body, models, modelId) {
  const m    = models.find(m => m.id === modelId);
  const desc = body.querySelector("#sim-model-desc");
  if (desc && m) desc.textContent = `${m.description}  (~${m.size_mb} MB)`;
}

async function _refreshDownloadUI(body, modelId, models) {
  const area         = body.querySelector("#sim-dl-area");
  const recomputeBtn = body.querySelector("#sim-recompute-btn");
  if (!area) return;

  _setModelDesc(body, models, modelId);
  area.innerHTML = `<div class="sim-dl-checking">Checking local cache…</div>`;

  const cached = await _checkModelCached(modelId);

  if (cached === true) {
    area.innerHTML = `
      <div class="sim-dl-row">
        <span class="sim-dl-badge sim-dl-ok">✓ Downloaded</span>
        <span class="sim-dl-hint">Model is available locally</span>
      </div>`;
    if (recomputeBtn) recomputeBtn.disabled = false;
    return;
  }

  if (cached === null) {
    // Sidecar not yet running — can't tell
    area.innerHTML = `
      <div class="sim-dl-row">
        <span class="sim-dl-badge sim-dl-unknown">? Status unknown</span>
        <span class="sim-dl-hint">Start the engine first to check</span>
      </div>`;
    if (recomputeBtn) recomputeBtn.disabled = false;
    return;
  }

  // Not downloaded — show download button
  const model = models.find(m => m.id === modelId) ?? { size_mb: "?" };
  area.innerHTML = `
    <div class="sim-dl-row">
      <span class="sim-dl-badge sim-dl-needed">↓ Not downloaded</span>
      <span class="sim-dl-hint">~${model.size_mb} MB required</span>
    </div>
    <button id="sim-dl-btn" class="btn sim-dl-btn">
      ↓ Download Model (${model.size_mb} MB)
    </button>`;
  if (recomputeBtn) recomputeBtn.disabled = true;

  area.querySelector("#sim-dl-btn")?.addEventListener("click", () =>
    _startDownload(body, modelId, models)
  );
}

async function _startDownload(body, modelId, models) {
  const area         = body.querySelector("#sim-dl-area");
  const recomputeBtn = body.querySelector("#sim-recompute-btn");
  if (!area || !invoke) return;

  // Show progress bar immediately
  area.innerHTML = `
    <div class="sim-dl-progress">
      <div class="sim-dl-progress-top">
        <span class="sim-dl-badge sim-dl-active">⬇ Downloading…</span>
        <span id="sim-dl-pct" class="sim-dl-pct">0%</span>
      </div>
      <div class="sim-dl-track"><div id="sim-dl-bar" class="sim-dl-bar" style="width:0%"></div></div>
      <div id="sim-dl-file" class="sim-dl-file">Connecting…</div>
      <div id="sim-dl-bytes" class="sim-dl-bytes"></div>
    </div>`;

  // Subscribe to per-file progress events
  // let _unlisten = null;
  // if (tauriListen) {
  //   _unlisten = await tauriListen("venv://model-progress", ({ payload }) => {
  //     const { filename, downloaded, total, pct } = payload ?? {};
  //     const bar   = document.getElementById("sim-dl-bar");
  //     const pctEl = document.getElementById("sim-dl-pct");
  //     const file  = document.getElementById("sim-dl-file");
  //     const bytes = document.getElementById("sim-dl-bytes");
  //     if (bar)   bar.style.width     = `${Math.min(pct ?? 0, 100)}%`;
  //     if (pctEl) pctEl.textContent   = `${(pct ?? 0).toFixed(1)}%`;
  //     if (file)  file.textContent    = filename ?? "";
  //     if (bytes && total > 0)
  //       bytes.textContent = `${_fmtBytes(downloaded)} / ${_fmtBytes(total)}`;
  //   });
  // }

  try {
    await invoke("hf_download_model", { model: modelId });
    _cacheStatus[modelId] = true;
    area.innerHTML = `
      <div class="sim-dl-row">
        <span class="sim-dl-badge sim-dl-ok">✓ Downloaded</span>
        <span class="sim-dl-hint">Model ready — click Recompute Graph to apply</span>
      </div>`;
    if (recomputeBtn) recomputeBtn.disabled = false;
  } catch (e) {
    const msg = String(e).slice(0, 300);
    area.innerHTML = `
      <div class="sim-dl-row">
        <span class="sim-dl-badge sim-dl-err">✗ Download failed</span>
      </div>
      <div class="sim-dl-errmsg">${msg}</div>
      <button id="sim-dl-retry" class="btn" style="margin-top:8px;font-size:.6rem">
        Retry
      </button>`;
    area.querySelector("#sim-dl-retry")?.addEventListener("click", () =>
      _startDownload(body, modelId, models)
    );
  }
}

// ── Embedding cache ───────────────────────────────────────────────────────────

async function _startEmbeddingCache(body, cfg) {
  const area   = body.querySelector("#sim-emb-area");
  const btn    = body.querySelector("#sim-emb-btn");
  if (!area || !invoke) return;

  // Disable button while running
  if (btn) btn.disabled = true;

  // Build progress UI
  area.innerHTML = `
    <div class="sim-emb-progress">
      <div class="sim-emb-progress-top">
        <span class="sim-dl-badge sim-dl-active">⚡ Caching embeddings…</span>
        <span id="sim-emb-count" class="sim-emb-count">0 / ?</span>
      </div>
      <div class="sim-dl-track">
        <div id="sim-emb-bar" class="sim-dl-bar" style="width:0%"></div>
      </div>
      <div id="sim-emb-paper" class="sim-emb-paper">Starting…</div>
    </div>`;

  let _unlisten = null;
  if (tauriListen) {
    _unlisten = await tauriListen("embedding://progress", ({ payload }) => {
      if (payload?.done) return; // handled after invoke resolves
      const bar    = document.getElementById("sim-emb-bar");
      const count  = document.getElementById("sim-emb-count");
      const paper  = document.getElementById("sim-emb-paper");
      const pct    = payload.total > 0
        ? Math.round((payload.index + 1) / payload.total * 100) : 0;
      if (bar)   bar.style.width    = `${pct}%`;
      if (count) count.textContent  = `${payload.index + 1} / ${payload.total}`;
      if (paper) {
        const icon = payload.skipped ? "↩" : "✓";
        const dim  = payload.skipped ? "color:var(--text-dim)" : "color:var(--accent)";
        paper.innerHTML = `<span style="${dim}">${icon}</span> ${payload.title ?? ""}`;
      }
    });
  }

  try {
    const config = {
      model:   cfg.model   ?? "sentence-transformers/all-MiniLM-L6-v2",
      fields:  getDefaultConfig().fields,
      weights: cfg.weights ?? {},
    };
    const result = await invoke("hf_compute_all_embeddings", { config });
    const { total = 0, computed = 0, skipped = 0 } = result ?? {};
    area.innerHTML = `
      <div class="sim-emb-done">
        <span class="sim-dl-badge sim-dl-ok">✓ Done</span>
        <span class="sim-dl-hint">${computed} computed, ${skipped} skipped (${total} total)</span>
      </div>
      <button id="sim-emb-btn" class="btn sim-emb-btn" style="margin-top:6px">
        ⚡ Cache All Embeddings
      </button>`;
    // Re-wire the fresh button
    area.querySelector("#sim-emb-btn")?.addEventListener("click", () => 
      _startEmbeddingCache(body, cfg)
    );
  } catch (e) {
    area.innerHTML = `
      <div class="sim-dl-row">
        <span class="sim-dl-badge sim-dl-err">✗ Failed</span>
        <span class="sim-dl-hint">${String(e).slice(0, 120)}</span>
      </div>
      <button id="sim-emb-btn" class="btn sim-emb-btn" style="margin-top:6px">
        ⚡ Retry
      </button>`;
    area.querySelector("#sim-emb-btn")?.addEventListener("click", () =>
      _startEmbeddingCache(body, cfg)
    );
  } finally {
    _unlisten?.();
  }
}


function wireEvents(panel, initialCfg, models, hfOk) {
  const body = panel.querySelector("#sim-settings-body");
  if (!body) return;
  const cfg = { ...initialCfg };

  // Strategy toggle — HF button is a no-op when HF is disabled this session
  body.querySelectorAll(".sim-strat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return; // HF locked
      cfg.strategy = btn.dataset.strat;
      body.querySelectorAll(".sim-strat-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.strat === cfg.strategy));
      body.querySelectorAll(".sim-hf-only").forEach(el =>
        el.classList.toggle("hidden", cfg.strategy !== "hf-embeddings"));
      if (cfg.strategy === "hf-embeddings") {
        const sel = body.querySelector("#sim-model-select");
        _refreshDownloadUI(body, sel?.value ?? cfg.model, models);
      }
    });
  });

  // Model select — recheck cache on change
  const modelSel = body.querySelector("#sim-model-select");
  if (modelSel) {
    _setModelDesc(body, models, modelSel.value);
    modelSel.addEventListener("change", async () => {
      cfg.model = modelSel.value;
      await _refreshDownloadUI(body, cfg.model, models);
    });
  }

  // Field checkboxes
  body.querySelectorAll(".sim-field-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const field = cb.dataset.field;
      const wrap  = cb.closest(".sim-field-row")?.querySelector(".sim-weight-wrap");
      const range = cb.closest(".sim-field-row")?.querySelector(".sim-weight-range");
      if (cb.checked) {
        cfg.fields = [...new Set([...(cfg.fields ?? []), field])];
        wrap?.classList.remove("disabled");
        if (range) range.disabled = false;
      } else {
        cfg.fields = (cfg.fields ?? []).filter(f => f !== field);
        wrap?.classList.add("disabled");
        if (range) range.disabled = true;
      }
    });
  });

  // Weight sliders
  body.querySelectorAll(".sim-weight-range").forEach(range => {
    range.addEventListener("input", () => {
      const field = range.dataset.field;
      const val   = parseFloat(range.value);
      cfg.weights = { ...(cfg.weights ?? {}), [field]: val };
      const lbl = body.querySelector(`.sim-weight-val[data-field="${field}"]`);
      if (lbl) lbl.textContent = val.toFixed(1);
    });
  });

  // Threshold
  const thrRange = body.querySelector("#sim-thr-range");
  const thrVal   = body.querySelector("#sim-thr-val");
  thrRange?.addEventListener("input", () => {
    cfg.threshold = parseFloat(thrRange.value);
    if (thrVal) thrVal.textContent = cfg.threshold.toFixed(2);
  });

  // Max edges
  const maxRange = body.querySelector("#sim-max-range");
  const maxVal   = body.querySelector("#sim-max-val");
  maxRange?.addEventListener("input", () => {
    cfg.max_edges = parseInt(maxRange.value);
    if (maxVal) maxVal.textContent = cfg.max_edges;
  });

  // Cache embeddings
  body.querySelector("#sim-emb-btn")?.addEventListener("click", () => 
    _startEmbeddingCache(body, cfg)
  );

  // Save
  const statusEl = body.querySelector("#sim-status");
  body.querySelector("#sim-save-btn")?.addEventListener("click", async () => {
    statusEl.textContent = "Saving…"; statusEl.className = "sim-status-msg";
    await _saveSimConfig(cfg);
    statusEl.textContent = "✓ Config saved"; statusEl.className = "sim-status-msg ok";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  });

  // Recompute
  body.querySelector("#sim-recompute-btn")?.addEventListener("click", async () => {
    statusEl.className = "sim-status-msg";
    const label = cfg.strategy === "hf-embeddings" ? "HuggingFace embeddings" : "JS cosine";
    statusEl.textContent = `Computing with ${label}…`;
    const btn = body.querySelector("#sim-recompute-btn");
    btn.disabled = true;
    try {
      await _saveSimConfig(cfg);
      await _recompute();
      statusEl.textContent = "✓ Graph edges recomputed";
      statusEl.className   = "sim-status-msg ok";
    } catch (e) {
      statusEl.textContent = `✗ ${e}`;
      statusEl.className   = "sim-status-msg err";
    } finally {
      btn.disabled = false;
      setTimeout(() => { if (statusEl.textContent.startsWith("✓")) statusEl.textContent = ""; }, 3000);
    }
  });
}

// ── DOM wiring ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("sim-settings-close")
    ?.addEventListener("click", closeSimilaritySettings);
  document.getElementById("sim-settings-backdrop")
    ?.addEventListener("click", closeSimilaritySettings);
  document.getElementById("btn-sim-settings")
    ?.addEventListener("click", openSimilaritySettings);
});