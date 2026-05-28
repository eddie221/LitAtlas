"use strict";

import { refreshModelSelect } from "./similarity_settings.js";

/**
 * app_settings.js — App Settings panel (tabbed).
 *
 * Tabs
 * ────
 * Models   — model selection (updates similarity_config) + models-dir picker
 * Display  — font-size slider
 * API      — HuggingFace token + custom sidecar script
 * Advanced — custom HF models list + plugin contract reference
 */

function _getFontMaxSize() { return window.LitAtlas?.getUiFontSize_MAX?.() ?? 28; }
function _getFontMinSize() { return window.LitAtlas?.getUiFontSize_MIN?.() ?? 10; }

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  null
);

// ── Config I/O ────────────────────────────────────────────────────────────────

async function _loadConfig() {
  if (!invoke) return { sidecar_script: null, custom_models: [] };
  try {
    return await invoke("get_app_config") ?? { sidecar_script: null, custom_models: [] };
  } catch (_) {
    return { sidecar_script: null, custom_models: [] };
  }
}

async function _saveConfig(cfg) {
  if (!invoke) return;
  await invoke("save_app_config", { config: cfg });
}

async function _loadSimConfig() {
  if (!invoke) return {};
  try { return await invoke("get_similarity_config") ?? {}; } catch (_) { return {}; }
}

async function _saveSimConfig(simCfg) {
  if (!invoke) return;
  await invoke("save_similarity_config", { config: simCfg });
}

async function _loadDirs() {
  if (!invoke) return { data_dir: "", models_dir: "" };
  try { return await invoke("get_dirs") ?? { data_dir: "", models_dir: "" }; } catch (_) { return { data_dir: "", models_dir: "" }; }
}

// ── Open / close ──────────────────────────────────────────────────────────────

export function openAppSettings() {
  const panel = document.getElementById("app-settings-panel");
  if (!panel) return;
  panel.classList.add("open");
  document.getElementById("app-settings-backdrop")?.classList.add("open");
  _renderAppSettings(panel);
}

export function closeAppSettings() {
  document.getElementById("app-settings-panel")?.classList.remove("open");
  document.getElementById("app-settings-backdrop")?.classList.remove("open");
}

// ── Main render ───────────────────────────────────────────────────────────────

async function _renderAppSettings(panel) {
  const body = panel.querySelector("#app-settings-body");
  if (!body) return;
  body.innerHTML = `<div class="app-cfg-loading">Loading…</div>`;

  const [cfg, scriptInfo, simCfg, dirs] = await Promise.all([
    _loadConfig(),
    invoke
      ? invoke("get_sidecar_script_info").catch(() => ({ path: "(unknown)", is_custom: false }))
      : Promise.resolve({ path: "(unavailable)", is_custom: false }),
    _loadSimConfig(),
    _loadDirs(),
  ]);

  const customModels  = cfg.custom_models ?? [];
  const currentFontPx = window.LitAtlas?.getUiFontSize?.() ?? 20;
  body.innerHTML = _buildHTML(cfg, scriptInfo, customModels, currentFontPx, simCfg, dirs);
  _wireTabNav(body);
  _wireEvents(body, cfg, scriptInfo, customModels, simCfg, dirs);
}

// ── Built-in models (must match similarity_server.py AVAILABLE_MODELS) ────────

const _BUILTIN_MODELS = [
  {
    id:          "gemma-4-E2B-it-Q4_K_M.gguf",
    repo_id:     "unsloth/gemma-4-E2B-it-GGUF",
    label:       "Gemma 4 E2B Instruct (Q4_K_M)",
    description: "Multimodal: text embeddings + visual understanding of PDF pages.",
    size_mb:     1200,
    type:        "multimodal",
  },
  {
    id:          "nomic-embed-text-v1.5.Q4_K_M.gguf",
    repo_id:     "nomic-ai/nomic-embed-text-v1.5-GGUF",
    label:       "Nomic Embed Text v1.5 (Q4_K_M)",
    description: "Fast, high-quality text-only embeddings (~274 MB).",
    size_mb:     274,
    type:        "embedding",
  },
];

// ── HTML builder ──────────────────────────────────────────────────────────────

function _buildHTML(cfg, scriptInfo, customModels, currentFontPx, simCfg, dirs) {
  return `
    <div class="app-cfg-tab-bar">
      <button class="app-cfg-tab-btn active" data-tab="models">Models</button>
      <button class="app-cfg-tab-btn" data-tab="display">Display</button>
      <button class="app-cfg-tab-btn" data-tab="api">API</button>
      <button class="app-cfg-tab-btn" data-tab="advanced">Advanced</button>
    </div>

    <div class="app-cfg-tab-pane active" data-tab-pane="models">
      ${_buildModelsTab(cfg, simCfg, customModels, dirs)}
    </div>
    <div class="app-cfg-tab-pane" data-tab-pane="display">
      ${_buildDisplayTab(currentFontPx)}
    </div>
    <div class="app-cfg-tab-pane" data-tab-pane="api">
      ${_buildApiTab(cfg, scriptInfo)}
    </div>
    <div class="app-cfg-tab-pane" data-tab-pane="advanced">
      ${_buildAdvancedTab(customModels)}
    </div>`;
}

// ── Models tab ────────────────────────────────────────────────────────────────

function _buildModelsTab(cfg, simCfg, customModels, dirs) {
  const activeModel  = simCfg?.model ?? "gemma-4-E2B-it-Q4_K_M.gguf";
  const modelsDir    = cfg.models_dir || dirs.models_dir || "";
  const dataDir      = dirs.data_dir  || "";

  const allModels = [
    ..._BUILTIN_MODELS,
    ...customModels.map(m => ({ id: m.id, label: m.label || m.id, description: "", size_mb: m.size_mb ?? null, type: "custom" })),
  ];

  const modelCards = allModels.map(m => {
    const isActive = m.id === activeModel;
    return `
      <div class="app-cfg-model-card ${isActive ? "active" : ""}" data-model-id="${_esc(m.id)}">
        <div class="app-cfg-model-card-header">
          <div class="app-cfg-model-card-name">${_esc(m.label)}</div>
          ${m.size_mb ? `<div class="app-cfg-model-card-size">${m.size_mb} MB</div>` : ""}
        </div>
        ${m.description ? `<div class="app-cfg-model-card-desc">${_esc(m.description)}</div>` : ""}
        <div class="app-cfg-model-card-footer">
          <span class="app-cfg-model-card-type">${_esc(m.type)}</span>
          ${isActive
            ? `<span class="app-cfg-model-active-badge">Active</span>`
            : `<button class="btn app-cfg-model-select-btn" data-model-id="${_esc(m.id)}">Use this model</button>`}
        </div>
      </div>`;
  }).join("");

  return `
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Active Model</div>
      <div class="app-cfg-hint">
        Select which GGUF model is used for AI similarity. Download models from
        <em>Similarity Settings</em>. Changes take effect on the next edge recompute.
      </div>
      <div id="app-cfg-model-cards">${modelCards}</div>
      <div id="app-cfg-model-select-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Models Folder</div>
      <div class="app-cfg-hint">
        Where GGUF model files are stored. Leave blank to use the default location.
        Takes effect on next engine start.
      </div>
      <div class="app-cfg-dir-row">
        <input id="app-cfg-models-dir-input" class="app-cfg-input"
               type="text" placeholder="Default: ${_esc(dirs.models_dir)}"
               value="${_esc(cfg.models_dir ?? "")}" spellcheck="false">
        <button id="app-cfg-models-dir-open" class="btn app-cfg-folder-btn"
                title="Open models folder" data-path="${_esc(modelsDir)}">
          <i class="bi bi-folder2-open"></i>
        </button>
      </div>
      <div class="app-cfg-script-actions">
        <button id="app-cfg-models-dir-save" class="btn btn-new-paper">Apply</button>
        ${cfg.models_dir ? `<button id="app-cfg-models-dir-reset" class="btn app-cfg-reset-btn">↺ Reset to Default</button>` : ""}
      </div>
      <div id="app-cfg-models-dir-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">App Data Folder</div>
      <div class="app-cfg-hint">All LitAtlas data (projects, configs, embeddings) lives here.</div>
      <div class="app-cfg-dir-display">
        <span class="app-cfg-path-value" title="${_esc(dataDir)}">${_esc(_shortenPath(dataDir))}</span>
        <button class="btn app-cfg-folder-btn" id="app-cfg-data-dir-open"
                title="Open app data folder" data-path="${_esc(dataDir)}">
          <i class="bi bi-folder2-open"></i>
        </button>
      </div>
    </div>`;
}

// ── Display tab ───────────────────────────────────────────────────────────────

function _buildDisplayTab(currentFontPx) {
  const pct = Math.round((currentFontPx / 20) * 100);
  return `
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Display</div>
      <div class="app-cfg-hint">
        Scales all text in the application — UI panels, labels, tooltips,
        and canvas node labels — uniformly.
      </div>
      <div class="app-cfg-row app-cfg-slider-row">
        <label class="app-cfg-slider-label" for="app-cfg-font-size">Font Size</label>
        <input id="app-cfg-font-size" type="range"
               class="app-cfg-slider" min="${_getFontMinSize()}" max="${_getFontMaxSize()}" step="1"
               value="${_esc(String(currentFontPx))}">
        <span id="app-cfg-font-size-val" class="app-cfg-slider-val">${pct}%</span>
        <button id="app-cfg-font-size-reset" class="btn app-cfg-reset-btn"
                title="Reset to default (100%)">↺</button>
      </div>
    </div>`;
}

// ── API tab ───────────────────────────────────────────────────────────────────

function _buildApiTab(cfg, scriptInfo) {
  const scriptPath = cfg.sidecar_script ?? "";
  const activePath = scriptInfo?.path ?? "(unknown)";
  const isCustom   = scriptInfo?.is_custom === true;

  return `
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">HuggingFace API Token</div>
      <div class="app-cfg-hint">
        Required to download gated models such as
        <code>google/gemma-3-1b-it</code>.
        Generate a token at <code>huggingface.co/settings/tokens</code>,
        accept the model license on the model page, then paste the token here.
        The token is stored locally and never sent anywhere except HuggingFace.
      </div>
      <div class="app-cfg-script-row">
        <input id="app-cfg-hf-token" class="app-cfg-input"
               type="password" placeholder="hf_…"
               value="${_esc(cfg.hf_token ?? "")}" autocomplete="off" spellcheck="false">
        <button id="app-cfg-hf-token-show" class="btn" title="Show / hide token"
                style="flex-shrink:0">
          <i class="bi bi-eye"></i>
        </button>
      </div>
      <div class="app-cfg-script-actions">
        <button id="app-cfg-hf-token-save" class="btn btn-new-paper">Save Token</button>
        <button id="app-cfg-hf-token-clear" class="btn app-cfg-reset-btn"
                ${!(cfg.hf_token) ? "disabled" : ""}>Clear</button>
      </div>
      <div id="app-cfg-hf-token-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Similarity Engine Script</div>
      <div class="app-cfg-hint">
        By default LitAtlas uses its bundled <code>similarity_server.py</code>.
        You can specify a custom script that implements your own
        <code>similarity_fn</code> and/or <code>compute_embedding_fn</code>.
        The change takes effect the next time the engine starts.
      </div>

      <div class="app-cfg-active-path">
        <span class="app-cfg-path-label">Active:</span>
        <span class="app-cfg-path-value ${isCustom ? "app-cfg-path-custom" : ""}"
              title="${_esc(activePath)}">${_esc(_shortenPath(activePath))}</span>
        ${isCustom
          ? `<span class="app-cfg-badge app-cfg-badge-custom">custom</span>`
          : `<span class="app-cfg-badge app-cfg-badge-default">default</span>`}
      </div>

      <div class="app-cfg-script-row">
        <input id="app-cfg-script-input" class="app-cfg-input"
               type="text" placeholder="Absolute path to similarity_server.py…"
               value="${_esc(scriptPath)}" spellcheck="false">
        <button id="app-cfg-check-btn" class="btn" ${!scriptPath ? "disabled" : ""}>Check</button>
      </div>

      <div id="app-cfg-validate-area" class="app-cfg-validate-area" style="display:none"></div>

      <div class="app-cfg-script-actions">
        <button id="app-cfg-validate-btn" class="btn" ${!scriptPath ? "disabled" : ""}>
          Validate Hooks
        </button>
        <button id="app-cfg-script-save-btn" class="btn btn-new-paper">
          Apply Script
        </button>
        ${isCustom ? `<button id="app-cfg-reset-btn" class="btn app-cfg-reset-btn">↺ Reset to Default</button>` : ""}
      </div>
      <div id="app-cfg-script-status" class="app-cfg-status"></div>
    </div>`;
}

// ── Advanced tab ──────────────────────────────────────────────────────────────

function _buildAdvancedTab(customModels) {
  const modelRows = _buildModelListHTML(customModels);
  return `
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Custom HuggingFace Models</div>
      <div class="app-cfg-hint">
        Add any public HuggingFace model by its Hub ID
        (e.g. <code>BAAI/bge-base-en-v1.5</code>).
        After adding, open Similarity Settings to download and use the model.
      </div>

      <div id="app-cfg-model-list">${modelRows}</div>

      <div class="app-cfg-add-model-form">
        <div class="app-cfg-add-row">
          <input id="app-cfg-new-id" class="app-cfg-input app-cfg-new-id"
                 type="text" placeholder="HuggingFace model name  e.g. BAAI/bge-base-en-v1.5"
                 spellcheck="false">
          <button id="app-cfg-add-model-btn" class="btn btn-new-paper">Add</button>
        </div>
        <div id="app-cfg-model-status" class="app-cfg-status"></div>
      </div>
    </div>

    <div class="app-cfg-section">
      <button class="app-cfg-toggle" id="app-cfg-contract-toggle">
        Plugin Contract Reference <span class="app-cfg-toggle-icon"><i class="bi bi-caret-right-fill"></i></span>
      </button>
      <div id="app-cfg-contract-body" class="app-cfg-contract hidden">
        <p class="app-cfg-hint">Your script can define either or both of these functions:</p>
        <pre class="app-cfg-code">def similarity_fn(papers: list[dict], config: dict) -> list[dict]:
    """
    papers: PaperFull list
      { id, title, venue, year, notes,
        hashtags: [str], authors: [str],
        attributes: [{key, value, order}] }

    config: { model, fields, weights, threshold, max_edges }

    Returns list of edges:
      { source_id: int, target_id: int,
        similarity: float,   # 0.0–1.0
        weight:     int,     # 1 | 2 | 3
        edge_type:  str }    # "related" | "same_tag" | ...
    """</pre>
        <pre class="app-cfg-code">def compute_embedding_fn(paper: dict, config: dict) -> dict:
    """
    paper:  single PaperFull dict
    config: { model, fields, weights }

    Returns:
      { field_vectors: { field_name: [float, ...] },
        dim: int }
    """</pre>
        <p class="app-cfg-hint">
          Both hooks are optional and independent. If only
          <code>compute_embedding_fn</code> is defined, LitAtlas uses
          your vectors with the built-in edge computation.
        </p>
      </div>
    </div>`;
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function _wireTabNav(body) {
  body.querySelectorAll(".app-cfg-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      body.querySelectorAll(".app-cfg-tab-btn").forEach(b => b.classList.remove("active"));
      body.querySelectorAll(".app-cfg-tab-pane").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      body.querySelector(`.app-cfg-tab-pane[data-tab-pane="${btn.dataset.tab}"]`)?.classList.add("active");
    });
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function _wireEvents(body, cfg, scriptInfo, customModels, simCfg, dirs) {
  _wireModelsTab(body, cfg, simCfg, customModels, dirs);
  _wireDisplayTab(body);
  _wireApiTab(body, cfg, scriptInfo);
  _wireAdvancedTab(body, cfg, customModels);
}

// ── Models tab events ─────────────────────────────────────────────────────────

function _wireModelsTab(body, cfg, simCfg, customModels, dirs) {
  const selectStatus  = body.querySelector("#app-cfg-model-select-status");
  const cardsContainer = body.querySelector("#app-cfg-model-cards");

  // Single delegated listener handles initial and dynamically-inserted buttons.
  cardsContainer?.addEventListener("click", async e => {
    const btn = e.target.closest(".app-cfg-model-select-btn");
    if (!btn) return;
    const modelId = btn.dataset.modelId;
    simCfg.model  = modelId;
    try {
      await _saveSimConfig(simCfg);
      // Refresh card UI to show new active model
      body.querySelectorAll(".app-cfg-model-card").forEach(card => {
        const isNowActive = card.dataset.modelId === modelId;
        card.classList.toggle("active", isNowActive);
        const footer   = card.querySelector(".app-cfg-model-card-footer");
        const existing = footer.querySelector(".app-cfg-model-active-badge, .app-cfg-model-select-btn");
        if (isNowActive) {
          existing?.remove();
          footer.insertAdjacentHTML("beforeend", `<span class="app-cfg-model-active-badge">Active</span>`);
        } else {
          existing?.remove();
          footer.insertAdjacentHTML("beforeend",
            `<button class="btn app-cfg-model-select-btn" data-model-id="${_esc(card.dataset.modelId)}">Use this model</button>`);
        }
      });
      _showStatus(selectStatus, `✓ Active model set to ${modelId}`, "ok");
      const simPanel = document.getElementById("sim-settings-panel");
      refreshModelSelect(simPanel).catch(() => {});
    } catch (e) { _showStatus(selectStatus, `✗ ${e}`, "err"); }
  });

  // Models dir input + open folder button
  const modelsDirInput  = body.querySelector("#app-cfg-models-dir-input");
  const modelsDirOpen   = body.querySelector("#app-cfg-models-dir-open");
  const modelsDirSave   = body.querySelector("#app-cfg-models-dir-save");
  const modelsDirReset  = body.querySelector("#app-cfg-models-dir-reset");
  const modelsDirStatus = body.querySelector("#app-cfg-models-dir-status");

  modelsDirOpen?.addEventListener("click", async () => {
    const path = modelsDirInput?.value.trim() || dirs.models_dir;
    if (!path || !invoke) return;
    try { await invoke("open_folder", { path }); } catch (e) { _showStatus(modelsDirStatus, `✗ ${e}`, "err"); }
  });
  // Keep the open-button path in sync as the user types
  modelsDirInput?.addEventListener("input", () => {
    if (modelsDirOpen) modelsDirOpen.dataset.path = modelsDirInput.value.trim() || dirs.models_dir;
  });

  modelsDirSave?.addEventListener("click", async () => {
    const path = modelsDirInput?.value.trim() ?? "";
    cfg.models_dir = path || null;
    try {
      await _saveConfig(cfg);
      _showStatus(modelsDirStatus, "✓ Saved — takes effect on next engine start", "ok");
    } catch (e) { _showStatus(modelsDirStatus, `✗ ${e}`, "err"); }
  });

  modelsDirReset?.addEventListener("click", async () => {
    cfg.models_dir = null;
    if (modelsDirInput) modelsDirInput.value = "";
    try {
      await _saveConfig(cfg);
      _showStatus(modelsDirStatus, "✓ Reset to default", "ok");
      setTimeout(() => _renderAppSettings(body.closest("#app-settings-panel")), 800);
    } catch (e) { _showStatus(modelsDirStatus, `✗ ${e}`, "err"); }
  });

  // App data dir open button
  body.querySelector("#app-cfg-data-dir-open")?.addEventListener("click", async () => {
    const path = dirs.data_dir;
    if (!path || !invoke) return;
    try { await invoke("open_folder", { path }); } catch (_) {}
  });
}

// ── Display tab events ────────────────────────────────────────────────────────

function _wireDisplayTab(body) {
  const fontSlider   = body.querySelector("#app-cfg-font-size");
  const fontValEl    = body.querySelector("#app-cfg-font-size-val");
  const fontResetBtn = body.querySelector("#app-cfg-font-size-reset");

  fontSlider?.addEventListener("input", () => {
    const px = parseInt(fontSlider.value, 10);
    if (fontValEl) fontValEl.textContent = Math.round((px / 20) * 100) + "%";
    window.LitAtlas?.setUiFontSize?.(px);
  });
  fontResetBtn?.addEventListener("click", () => {
    if (fontSlider) fontSlider.value = "20";
    if (fontValEl)  fontValEl.textContent = "100%";
    window.LitAtlas?.setUiFontSize?.(20);
  });
}

// ── API tab events ────────────────────────────────────────────────────────────

function _wireApiTab(body, cfg, scriptInfo) {
  // HF Token
  const hfTokenInput  = body.querySelector("#app-cfg-hf-token");
  const hfTokenShow   = body.querySelector("#app-cfg-hf-token-show");
  const hfTokenSave   = body.querySelector("#app-cfg-hf-token-save");
  const hfTokenClear  = body.querySelector("#app-cfg-hf-token-clear");
  const hfTokenStatus = body.querySelector("#app-cfg-hf-token-status");

  hfTokenShow?.addEventListener("click", () => {
    const isHidden = hfTokenInput?.type === "password";
    if (hfTokenInput) hfTokenInput.type = isHidden ? "text" : "password";
    if (hfTokenShow)  hfTokenShow.innerHTML = isHidden
      ? '<i class="bi bi-eye-slash"></i>'
      : '<i class="bi bi-eye"></i>';
  });
  hfTokenSave?.addEventListener("click", async () => {
    const token = hfTokenInput?.value.trim() ?? "";
    cfg.hf_token = token || null;
    try {
      await _saveConfig(cfg);
      _showStatus(hfTokenStatus, "✓ Token saved — takes effect on next engine start", "ok");
      if (hfTokenClear) hfTokenClear.disabled = !token;
    } catch (e) { _showStatus(hfTokenStatus, `✗ ${e}`, "err"); }
  });
  hfTokenClear?.addEventListener("click", async () => {
    if (hfTokenInput) hfTokenInput.value = "";
    cfg.hf_token = null;
    try {
      await _saveConfig(cfg);
      _showStatus(hfTokenStatus, "✓ Token cleared", "ok");
      if (hfTokenClear) hfTokenClear.disabled = true;
    } catch (e) { _showStatus(hfTokenStatus, `✗ ${e}`, "err"); }
  });

  // Sidecar script
  const scriptInput  = body.querySelector("#app-cfg-script-input");
  const validateBtn  = body.querySelector("#app-cfg-validate-btn");
  const validateArea = body.querySelector("#app-cfg-validate-area");
  const saveBtn      = body.querySelector("#app-cfg-script-save-btn");
  const resetBtn     = body.querySelector("#app-cfg-reset-btn");
  const scriptStatus = body.querySelector("#app-cfg-script-status");
  const checkBtn     = body.querySelector("#app-cfg-check-btn");

  const _updateBtns = () => {
    const hasVal = !!scriptInput?.value.trim();
    if (validateBtn) validateBtn.disabled = !hasVal;
    if (checkBtn)    checkBtn.disabled    = !hasVal;
  };
  scriptInput?.addEventListener("input", _updateBtns);

  checkBtn?.addEventListener("click", async () => {
    const path = scriptInput?.value.trim();
    if (!path || !invoke) return;
    _showValidate(validateArea, "Checking path…", "checking");
    try {
      const res = await invoke("pick_sidecar_script", { path });
      if (res?.readable) {
        _showValidate(validateArea, "✓ File found and readable", "ok");
      } else if (res?.exists) {
        _showValidate(validateArea, "✗ File exists but is not readable", "err");
      } else {
        _showValidate(validateArea, "✗ File not found at this path", "err");
      }
    } catch (e) { _showValidate(validateArea, `✗ ${e}`, "err"); }
  });

  validateBtn?.addEventListener("click", async () => {
    const path = scriptInput?.value.trim();
    if (!path || !invoke) return;
    _showValidate(validateArea, "Validating…", "checking");
    try {
      const res = await invoke("hf_validate_plugin", { scriptPath: path });
      if (res?.valid) {
        const hooks = [
          res.has_similarity_fn  && "similarity_fn",
          res.has_embedding_fn   && "compute_embedding_fn",
        ].filter(Boolean);
        const hookStr = hooks.length ? hooks.join(", ") : "no recognised hooks";
        _showValidate(validateArea, `✓ Valid — exports: ${hookStr}`, hooks.length ? "ok" : "warn");
      } else {
        _showValidate(validateArea, `✗ Invalid\n${res?.error ?? "Unknown error"}`, "err");
      }
    } catch (e) { _showValidate(validateArea, `✗ ${e}`, "err"); }
  });

  saveBtn?.addEventListener("click", async () => {
    const path = scriptInput?.value.trim() ?? "";
    cfg.sidecar_script = path || null;
    try {
      await _saveConfig(cfg);
      _showStatus(scriptStatus, "✓ Saved — takes effect on next engine start", "ok");
      setTimeout(() => _renderAppSettings(body.closest("#app-settings-panel")), 1200);
    } catch (e) { _showStatus(scriptStatus, `✗ ${e}`, "err"); }
  });

  resetBtn?.addEventListener("click", async () => {
    cfg.sidecar_script = null;
    if (scriptInput) scriptInput.value = "";
    try {
      await _saveConfig(cfg);
      _showStatus(scriptStatus, "✓ Reset to default", "ok");
      setTimeout(() => _renderAppSettings(body.closest("#app-settings-panel")), 800);
    } catch (e) { _showStatus(scriptStatus, `✗ ${e}`, "err"); }
  });
}

// ── Advanced tab events ───────────────────────────────────────────────────────

function _wireAdvancedTab(body, cfg, customModels) {
  const modelList   = body.querySelector("#app-cfg-model-list");
  const modelStatus = body.querySelector("#app-cfg-model-status");
  _wireModelDelButtons(modelList, customModels, cfg, modelStatus);

  const addBtn  = body.querySelector("#app-cfg-add-model-btn");
  const idInput = body.querySelector("#app-cfg-new-id");

  const doAdd = async () => {
    const id = idInput?.value.trim();
    if (!id) { _showStatus(modelStatus, "✗ Model ID is required.", "err"); return; }
    if (customModels.some(m => m.id === id)) {
      _showStatus(modelStatus, "Model already in list.", "warn"); return;
    }
    const label = id.includes("/") ? id.split("/").pop() : id;
    const entry = { id, label };
    customModels.push(entry);
    cfg.custom_models = customModels;
    try {
      await _saveConfig(cfg);
      if (idInput) idInput.value = "";
      modelList.innerHTML = _buildModelListHTML(customModels);
      _wireModelDelButtons(modelList, customModels, cfg, modelStatus);
      _showStatus(modelStatus, `✓ Added ${id}`, "ok");
      setTimeout(() => { if (modelStatus) modelStatus.textContent = ""; }, 2000);
      const simPanel = document.getElementById("sim-settings-panel");
      refreshModelSelect(simPanel).catch(() => {});
    } catch (e) {
      customModels.pop(); cfg.custom_models = customModels;
      _showStatus(modelStatus, `✗ ${e}`, "err");
    }
  };

  addBtn?.addEventListener("click", doAdd);
  idInput?.addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); });

  body.querySelector("#app-cfg-contract-toggle")?.addEventListener("click", () => {
    const contractBody = body.querySelector("#app-cfg-contract-body");
    const icon         = body.querySelector(".app-cfg-toggle-icon");
    contractBody?.classList.toggle("hidden");
    if (icon) icon.innerHTML = contractBody?.classList.contains("hidden")
      ? '<i class="bi bi-caret-right-fill"></i>'
      : '<i class="bi bi-caret-down-fill"></i>';
  });
}

function _wireModelDelButtons(modelList, customModels, cfg, statusEl) {
  modelList?.querySelectorAll(".app-cfg-model-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      customModels.splice(idx, 1);
      cfg.custom_models = customModels;
      try {
        await _saveConfig(cfg);
        modelList.innerHTML = _buildModelListHTML(customModels);
        _wireModelDelButtons(modelList, customModels, cfg, statusEl);
      } catch (e) { _showStatus(statusEl, `✗ ${e}`, "err"); }
    });
  });
}

function _buildModelListHTML(customModels) {
  if (!customModels.length)
    return `<div class="app-cfg-empty">No custom models added yet.</div>`;
  return customModels.map((m, i) => `
    <div class="app-cfg-model-row" data-idx="${i}">
      <div class="app-cfg-model-info">
        <code class="app-cfg-model-id">${_esc(m.id)}</code>
      </div>
      <button class="app-cfg-model-del" data-idx="${i}" title="Remove model">✕</button>
    </div>`).join("");
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _showStatus(el, msg, type) {
  if (!el) return;
  el.textContent = msg;
  el.className = `app-cfg-status ${type}`;
  if (type === "ok")
    setTimeout(() => { el.textContent = ""; el.className = "app-cfg-status"; }, 2500);
}

function _showValidate(el, msg, type) {
  if (!el) return;
  el.style.display = "block";
  el.className = `app-cfg-validate-area ${type}`;
  el.textContent = msg;
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _shortenPath(p) {
  if (!p || p.length <= 60) return p;
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 3) return p;
  return "…/" + parts.slice(-2).join("/");
}

/** Expose custom model list so similarity_settings.js can merge them. */
export async function getCustomModels() {
  const cfg = await _loadConfig();
  return cfg.custom_models ?? [];
}

// ── DOM wiring ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("app-settings-close")
    ?.addEventListener("click", closeAppSettings);
  document.getElementById("app-settings-backdrop")
    ?.addEventListener("click", closeAppSettings);
  document.getElementById("btn-app-settings")
    ?.addEventListener("click", openAppSettings);
});
