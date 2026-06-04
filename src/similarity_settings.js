"use strict";


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

function _getSimConfig()                { return window.LitAtlas?.getSimConfig?.()    ?? {}; }
async function _saveSimConfig(cfg)      { return window.LitAtlas?.saveSimConfig?.(cfg); }
async function _recompute()             { return window.LitAtlas?.triggerEdgeRecompute?.(); }
async function _switchStrategy(strat)  { return window.LitAtlas?.switchEdgeStrategy?.(strat); }

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  null
);
// ── Known fields (must match Python AVAILABLE_FIELDS) ─────────────────────────
const FIELDS = [
  { key: "title",    label: "Title",        defaultWeight: 1.0 },
  { key: "abstract", label: "Abstract",     defaultWeight: 1.0 },
  { key: "hashtags", label: "Hashtags",     defaultWeight: 1.0 },
  { key: "venue",    label: "Venue",        defaultWeight: 1.0 },
  { key: "notes",    label: "Notes",        defaultWeight: 1.0 },
  { key: "year",     label: "Year",         defaultWeight: 1.0 },
  // PDF text field — text is extracted from the uploaded PDF with PyMuPDF and
  // embedded by Gemma. Papers without a PDF silently skip this field.
  { key: "pdf",      label: "PDF (text)", defaultWeight: 1.0,
    hint: "Requires an uploaded PDF. Text is extracted with PyMuPDF and embedded by the selected model. Papers without a PDF are encoded from text fields only." },
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
  {
    id:          "openai:text-embedding-3-small",
    label:       "OpenAI text-embedding-3-small",
    description: "Cloud embedding via OpenAI API. Requires OPENAI_API_KEY in App Settings.",
    size_mb:     0,
    gated:       false,
    type:        "api",
  },
  {
    id:          "openai:text-embedding-3-large",
    label:       "OpenAI text-embedding-3-large",
    description: "Higher-quality cloud embedding via OpenAI API. Requires OPENAI_API_KEY in App Settings.",
    size_mb:     0,
    gated:       false,
    type:        "api",
  },
];

// ── Active model list (updated each time the settings panel opens) ────────────
// Starts with built-ins; replaced with live API list when a custom URL is set.
let _currentModels = _BUILTIN_MODELS;

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
  const cfg   = _getSimConfig();
  const isHF  = cfg.strategy === "hf-embeddings";
  const hfOk  = window.LitAtlas?.isHfEnabled?.() === true;

  // Try to fetch the live model list from the custom API endpoint.
  // Falls back to built-ins if the endpoint is not configured or unreachable.
  _currentModels = _BUILTIN_MODELS;
  if (invoke) {
    try {
      const res = await invoke("list_api_models");
      if (res?.ok && Array.isArray(res.models) && res.models.length > 0) {
        _currentModels = res.models.map(id => ({
          id,
          label:       id,
          description: "Model served by your custom API endpoint",
          size_mb:     0,
          gated:       false,
          type:        "custom-endpoint",
        }));
      }
    } catch (_) {}
  }

  const body = panel.querySelector("#sim-settings-body");
  if (!body) return;
  body.innerHTML = buildHTML(cfg, _currentModels, isHF, hfOk);
  wireEvents(panel, cfg, _currentModels, hfOk);

  if (isHF && hfOk) {
    const sel = body.querySelector("#sim-model-select");
    await _refreshDownloadUI(body, sel?.value ?? cfg.model ?? _currentModels[0]?.id, _currentModels);
  }
}

// ── Refresh the model <select> in an already-rendered panel ──────────────────
export async function refreshModelSelect(bodyOrPanel) {
  const body = bodyOrPanel?.id === "sim-settings-body"
    ? bodyOrPanel
    : bodyOrPanel?.querySelector("#sim-settings-body");
  if (!body) return;

  const cfg  = _getSimConfig();
  const isHF = cfg.strategy === "hf-embeddings";
  const hfOk = window.LitAtlas?.isHfEnabled?.() === true;

  if (isHF && hfOk) {
    const modelId = body.querySelector("#sim-model-select")?.value
                 ?? cfg.model ?? _currentModels[0]?.id;
    await _refreshDownloadUI(body, modelId, _currentModels);
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
    const hintHtml = f.hint
      ? `<div class="sim-field-hint">${f.hint}</div>`
      : "";
    return `
      <div class="sim-field-wrap">
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
        </div>
        ${hintHtml}
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
            <div class="sim-strat-name">Attributed Cosine</div>
            <div class="sim-strat-desc">Fast · No setup · Hashtags</div>
          </div>
        </button>
        <button class="sim-strat-btn ${isHF&&hfOk?"active":""} ${!hfOk?"hf-locked":""}"
                data-strat="hf-embeddings"
                ${!hfOk?'disabled title="AI features are disabled for this session — restart the app to enable"':''}>
          <span class="sim-strat-icon">😎</span>
          <div>
            <div class="sim-strat-name">AI mode</div>
            <div class="sim-strat-desc">${hfOk?"Deep embeddings via cloud API":"Requires API key in App Settings"}</div>
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
          <span class="sim-param-val" id="sim-thr-val">${(cfg.threshold??0.00).toFixed(2)}</span>
        </label>
        <input type="range" id="sim-thr-range" min="0.0" max="1.0" step="0.01"
               value="${cfg.threshold??0.00}">
      </div>
      <div class="sim-param-row">
        <label>Max edges per node
          <span class="sim-param-val" id="sim-max-val">${cfg.max_edges??7}</span>
        </label>
        <input type="range" id="sim-max-range" min="1" max="20" step="1"
               value="${cfg.max_edges??7}">
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
      </div>
    </div>`;
}

// ── Download area ─────────────────────────────────────────────────────────────

function _setModelDesc(body, models, modelId) {
  const m    = models.find(m => m.id === modelId);
  const desc = body.querySelector("#sim-model-desc");
  if (desc && m) {
    const sizeText = m.size_mb ? `  (~${m.size_mb} MB)` : "";
    desc.textContent = `${m.description}${sizeText}`;
  }
}

function _isApiModel(modelId) {
  return modelId.startsWith("openai:") || modelId.startsWith("anthropic:");
}

function _isCustomEndpointModel(modelId, models) {
  return models.find(m => m.id === modelId)?.type === "custom-endpoint";
}

async function _refreshDownloadUI(body, modelId, models) {
  const area         = body.querySelector("#sim-dl-area");
  const recomputeBtn = body.querySelector("#sim-recompute-btn");
  if (!area) return;

  _setModelDesc(body, models, modelId);

  // ── Custom API endpoint model: no download needed ─────────────────────────
  if (_isCustomEndpointModel(modelId, models)) {
    area.innerHTML = `
      <div class="sim-dl-row">
        <span class="sim-dl-badge sim-dl-ok">✓ Ready</span>
        <span class="sim-dl-hint">Served by your custom API endpoint</span>
      </div>`;
    if (recomputeBtn) recomputeBtn.disabled = false;
    return;
  }

  // ── OpenAI / Anthropic API model: show key status ─────────────────────────
  if (_isApiModel(modelId)) {
    area.innerHTML = `<div class="sim-dl-checking">Checking API key…</div>`;
    const hasKey = await _checkModelCached(modelId); // returns true if key is set
    if (hasKey === true) {
      area.innerHTML = `
        <div class="sim-dl-row">
          <span class="sim-dl-badge sim-dl-ok">✓ API key configured</span>
          <span class="sim-dl-hint">Ready to use — no local download needed</span>
        </div>`;
      if (recomputeBtn) recomputeBtn.disabled = false;
    } else {
      const provider = modelId.startsWith("openai:") ? "OpenAI" : "Anthropic";
      area.innerHTML = `
        <div class="sim-dl-row">
          <span class="sim-dl-badge sim-dl-needed">✗ No API key</span>
          <span class="sim-dl-hint">Set your ${provider} key in App Settings → API</span>
        </div>`;
      if (recomputeBtn) recomputeBtn.disabled = true;
    }
    return;
  }

  area.innerHTML = `
    <div class="sim-dl-row">
      <span class="sim-dl-badge sim-dl-unknown">? Status unknown</span>
      <span class="sim-dl-hint">Model type not recognised</span>
    </div>`;
  if (recomputeBtn) recomputeBtn.disabled = false;
}

function _showDialog(title, msg) {
  const backdrop = document.getElementById("pg-dialog-backdrop");
  const titleEl  = document.getElementById("pg-dialog-title");
  const msgEl    = document.getElementById("pg-dialog-message");
  const okBtn    = document.getElementById("pg-dialog-ok");
  const cancelBtn= document.getElementById("pg-dialog-cancel");
  if (!backdrop || !okBtn) return;
  if (titleEl)  titleEl.textContent  = title;
  if (msgEl)    msgEl.textContent    = msg;
  if (cancelBtn) cancelBtn.style.display = "none";
  backdrop.classList.add("open");
  function close() {
    backdrop.classList.remove("open");
    if (cancelBtn) cancelBtn.style.display = "";
    okBtn.removeEventListener("click", close);
  }
  okBtn.addEventListener("click", close);
}

function _showApiErrorDialog(msg) {
  _showDialog("API Connection Failed", msg);
}

async function _showAiStatusNotice() {
  let status;
  try { status = await invoke("get_papers_ai_status"); } catch { return; }
  const s = status?.summary;
  if (!s || s.total === 0) return;
  // Only notify if something is missing
  if (s.missing_embedding === 0 && s.missing_summary === 0) return;
  const lines = [
    `AI mode is active. Status for ${s.total} paper(s):`,
    "",
    `  Embeddings:      ${s.has_embedding} / ${s.total} ready`,
    `  PDF embeddings:  ${s.has_pdf_embedding} / ${s.total} ready`,
    `  AI summaries:    ${s.has_summary} / ${s.total} ready`,
    "",
    "Run \"Recompute\" to generate missing embeddings and summaries.",
  ];
  _showDialog("AI Mode — Paper Status", lines.join("\n"));
}

function wireEvents(panel, initialCfg, models, hfOk) {
  const body = panel.querySelector("#sim-settings-body");
  if (!body) return;
  const cfg = { ...initialCfg };

  // Strategy toggle
  body.querySelectorAll(".sim-strat-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      if (btn.dataset.strat === "hf-embeddings") {
        // Verify API connectivity before entering AI mode.
        const statusEl = body.querySelector("#sim-status");
        if (statusEl) { statusEl.textContent = "Checking API connection…"; statusEl.className = "sim-status-msg"; }
        let connOk = false;
        let connErr = "Unknown error";
        try {
          const res = await invoke("check_api_connection");
          connOk = res?.ok === true;
          if (!connOk) connErr = res?.error ?? "API check failed";
        } catch (e) {
          connErr = String(e);
        }
        if (statusEl) { statusEl.textContent = ""; statusEl.className = "sim-status-msg"; }
        if (!connOk) {
          _showApiErrorDialog(connErr);
          return; // Stay on current strategy
        }
      }
      cfg.strategy = btn.dataset.strat;
      body.querySelectorAll(".sim-strat-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.strat === cfg.strategy));
      body.querySelectorAll(".sim-hf-only").forEach(el =>
        el.classList.toggle("hidden", cfg.strategy !== "hf-embeddings"));
      if (cfg.strategy === "hf-embeddings") {
        const sel = body.querySelector("#sim-model-select");
        _refreshDownloadUI(body, sel?.value ?? cfg.model, models);
      }
      await _saveSimConfig(cfg);
      await _switchStrategy(cfg.strategy);
      if (cfg.strategy === "hf-embeddings") {
        await _showAiStatusNotice();
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