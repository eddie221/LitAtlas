"use strict";
/**
 * similarity-settings.js
 *
 * Renders the similarity settings panel (opened via ⚙ button in header).
 * Lets users:
 *   • Switch between js-cosine and hf-embeddings strategies
 *   • Pick a HuggingFace model
 *   • Toggle which fields contribute to similarity
 *   • Adjust per-field weights via sliders
 *   • Adjust threshold and max-edges
 *   • Trigger a full edge recompute with the new config
 *
 * Depends on graph.js exports: getSimConfig, saveSimConfig, triggerEdgeRecompute
 * These are wired up after DOMContentLoaded.
 */

// Re-exported from graph.js at runtime via window.PaperGraph bridge
function _getSimConfig()           { return window.PaperGraph?.getSimConfig?.()    ?? {}; }
async function _saveSimConfig(cfg) { return window.PaperGraph?.saveSimConfig?.(cfg); }
async function _recompute()        { return window.PaperGraph?.triggerEdgeRecompute?.(); }

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  null
);

// ── Known fields (must match Python AVAILABLE_FIELDS) ────────────────────────
const FIELDS = [
  { key: "title",    label: "Title",    defaultWeight: 1.5 },
  { key: "abstract", label: "Abstract", defaultWeight: 2.0 },
  { key: "hashtags", label: "Hashtags", defaultWeight: 1.0 },
  { key: "venue",    label: "Venue",    defaultWeight: 0.5 },
  { key: "notes",    label: "Notes",    defaultWeight: 0.5 },
  { key: "year",     label: "Year",     defaultWeight: 0.2 },
];

// ── Open / close ─────────────────────────────────────────────────────────────
export function openSimilaritySettings() {
  const panel = document.getElementById("sim-settings-panel");
  if (!panel) return;
  renderSettings(panel);
  panel.classList.add("open");
}

export function closeSimilaritySettings() {
  const panel = document.getElementById("sim-settings-panel");
  if (panel) panel.classList.remove("open");
}

// ── Render ────────────────────────────────────────────────────────────────────
async function renderSettings(panel) {
  const cfg = _getSimConfig();
  const isHF = cfg.strategy === "hf-embeddings";

  // Load model list from sidecar (non-blocking — shows spinner then fills in)
  let models = _BUILTIN_MODELS;
  const body = panel.querySelector("#sim-settings-body");
  if (!body) return;

  body.innerHTML = buildHTML(cfg, models, isHF);
  wireEvents(panel, cfg);

  // Async: try to load model list from running sidecar
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
          // Update description
          _updateModelDesc(body, models, sel.value);
        }
      }
    } catch (_) { /* sidecar not running — use builtin list */ }
  }
}

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

function buildHTML(cfg, models, isHF) {
  const weights = cfg.weights ?? {};
  const selFields = new Set(cfg.fields ?? ["title","abstract","hashtags"]);

  const modelOptions = models.map(m =>
    `<option value="${m.id}" ${m.id===cfg.model?"selected":""}>${m.label}</option>`
  ).join("");

  const fieldRows = FIELDS.map(f => {
    const w     = weights[f.key] ?? f.defaultWeight;
    const pct   = Math.round((w / 3) * 100);
    const check = selFields.has(f.key) ? "checked" : "";
    return `
      <div class="sim-field-row" data-field="${f.key}">
        <label class="sim-field-label">
          <input type="checkbox" class="sim-field-check" data-field="${f.key}" ${check}>
          <span>${f.label}</span>
        </label>
        <div class="sim-weight-wrap ${!selFields.has(f.key) ? "disabled" : ""}">
          <input type="range" class="sim-weight-range" data-field="${f.key}"
                 min="0.1" max="3" step="0.1" value="${w}"
                 ${!selFields.has(f.key) ? "disabled" : ""}>
          <span class="sim-weight-val" data-field="${f.key}">${w.toFixed(1)}</span>
        </div>
      </div>`;
  }).join("");

  return `
    <!-- Strategy toggle -->
    <div class="sim-section">
      <div class="sim-section-title">Strategy</div>
      <div class="sim-strategy-row">
        <button class="sim-strat-btn ${!isHF?"active":""}" data-strat="js-cosine">
          <span class="sim-strat-icon">⚡</span>
          <div>
            <div class="sim-strat-name">JS Cosine</div>
            <div class="sim-strat-desc">Fast · No setup · Year/venue/tags</div>
          </div>
        </button>
        <button class="sim-strat-btn ${isHF?"active":""}" data-strat="hf-embeddings">
          <span class="sim-strat-icon">🤗</span>
          <div>
            <div class="sim-strat-name">HuggingFace</div>
            <div class="sim-strat-desc">Deep embeddings · Requires Python</div>
          </div>
        </button>
      </div>
    </div>

    <!-- HF Model picker (only shown when HF selected) -->
    <div class="sim-section sim-hf-only ${!isHF?"hidden":""}">
      <div class="sim-section-title">Model</div>
      <select id="sim-model-select" class="sim-select">
        ${modelOptions}
      </select>
      <div id="sim-model-desc" class="sim-model-desc"></div>
      <div class="sim-pip-hint">
        Requires: <code>pip install sentence-transformers</code>
      </div>
    </div>

    <!-- Fields (only shown when HF selected) -->
    <div class="sim-section sim-hf-only ${!isHF?"hidden":""}">
      <div class="sim-section-title">Fields &amp; Weights</div>
      <div class="sim-fields-hint">
        Select which fields influence similarity. Higher weight = more influence.
      </div>
      <div id="sim-fields-list">
        ${fieldRows}
      </div>
    </div>

    <!-- Threshold + max edges (both strategies) -->
    <div class="sim-section">
      <div class="sim-section-title">Threshold &amp; Connectivity</div>
      <div class="sim-param-row">
        <label>Min similarity (Ignore the similarity below threshold)
          <span class="sim-param-val" id="sim-thr-val">${(cfg.threshold??0.38).toFixed(2)}</span>
        </label>
        <input type="range" id="sim-thr-range" min="0.1" max="0.95" step="0.01"
               value="${cfg.threshold??0.38}">
      </div>
      <div class="sim-param-row">
        <label>Max edges per node (Top-k)
          <span class="sim-param-val" id="sim-max-val">${cfg.max_edges??7}</span>
        </label>
        <input type="range" id="sim-max-range" min="1" max="20" step="1"
               value="${cfg.max_edges??7}">
      </div>
    </div>

    <!-- Status / recompute -->
    <div class="sim-section">
      <div id="sim-status" class="sim-status-msg"></div>
      <div class="sim-action-row">
        <button id="sim-save-btn" class="btn">Save Config</button>
        <button id="sim-recompute-btn" class="btn btn-new-paper">
          Recompute Graph
        </button>
      </div>
      <div class="sim-recompute-hint">
        Recomputing replaces all edges with the new similarity scores.
        This may take a moment for large libraries with HuggingFace.
      </div>
    </div>`;
}

function _updateModelDesc(body, models, modelId) {
  const m    = models.find(m => m.id === modelId);
  const desc = body.querySelector("#sim-model-desc");
  if (desc && m) {
    desc.textContent = `${m.description} (~${m.size_mb} MB download on first use)`;
  }
}

function wireEvents(panel, initialCfg) {
  const body = panel.querySelector("#sim-settings-body");
  if (!body) return;

  // Live cfg snapshot we mutate as the user interacts
  const cfg = { ...initialCfg };

  // ── Strategy buttons ──
  body.querySelectorAll(".sim-strat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      cfg.strategy = btn.dataset.strat;
      body.querySelectorAll(".sim-strat-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.strat === cfg.strategy));
      body.querySelectorAll(".sim-hf-only").forEach(el =>
        el.classList.toggle("hidden", cfg.strategy !== "hf-embeddings"));
    });
  });

  // ── Model select ──
  const modelSel = body.querySelector("#sim-model-select");
  if (modelSel) {
    _updateModelDesc(body, _BUILTIN_MODELS, modelSel.value);
    modelSel.addEventListener("change", () => {
      cfg.model = modelSel.value;
      _updateModelDesc(body, _BUILTIN_MODELS, cfg.model);
    });
  }

  // ── Field checkboxes ──
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

  // ── Weight sliders ──
  body.querySelectorAll(".sim-weight-range").forEach(range => {
    range.addEventListener("input", () => {
      const field = range.dataset.field;
      const val   = parseFloat(range.value);
      cfg.weights = { ...(cfg.weights ?? {}), [field]: val };
      const label = body.querySelector(`.sim-weight-val[data-field="${field}"]`);
      if (label) label.textContent = val.toFixed(1);
    });
  });

  // ── Threshold ──
  const thrRange = body.querySelector("#sim-thr-range");
  const thrVal   = body.querySelector("#sim-thr-val");
  thrRange?.addEventListener("input", () => {
    cfg.threshold = parseFloat(thrRange.value);
    if (thrVal) thrVal.textContent = cfg.threshold.toFixed(2);
  });

  // ── Max edges ──
  const maxRange = body.querySelector("#sim-max-range");
  const maxVal   = body.querySelector("#sim-max-val");
  maxRange?.addEventListener("input", () => {
    cfg.max_edges = parseInt(maxRange.value);
    if (maxVal) maxVal.textContent = cfg.max_edges;
  });

  // ── Save ──
  const statusEl = body.querySelector("#sim-status");
  body.querySelector("#sim-save-btn")?.addEventListener("click", async () => {
    statusEl.textContent = "Saving…";
    statusEl.className   = "sim-status-msg";
    await _saveSimConfig(cfg);
    statusEl.textContent = "✓ Config saved";
    statusEl.className   = "sim-status-msg ok";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  });

  // ── Recompute ──
  body.querySelector("#sim-recompute-btn")?.addEventListener("click", async () => {
    statusEl.className   = "sim-status-msg";
    const stratLabel = cfg.strategy === "hf-embeddings" ? "HuggingFace embeddings" : "JS cosine";
    statusEl.textContent = `Computing with ${stratLabel}…`;

    const btn = body.querySelector("#sim-recompute-btn");
    btn.disabled = true;

    try {
      await _saveSimConfig(cfg);
      await _recompute();
      statusEl.textContent = "✓ Graph edges recomputed";
      statusEl.className   = "sim-status-msg ok";
    } catch (err) {
      statusEl.textContent = `✗ ${err}`;
      statusEl.className   = "sim-status-msg err";
      console.error("[SimSettings] recompute failed:", err);
    } finally {
      btn.disabled = false;
      setTimeout(() => { if (statusEl.textContent.startsWith("✓")) statusEl.textContent = ""; }, 3000);
    }
  });
}

// ── DOMContentLoaded wiring ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("sim-settings-close")
    ?.addEventListener("click", closeSimilaritySettings);

  document.getElementById("sim-settings-backdrop")
    ?.addEventListener("click", closeSimilaritySettings);

  document.getElementById("btn-sim-settings")
    ?.addEventListener("click", openSimilaritySettings);
});