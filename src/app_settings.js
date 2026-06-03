"use strict";


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
  if (!invoke) return {};
  try {
    return await invoke("get_app_config") ?? {};
  } catch (_) {
    return {};
  }
}

async function _saveConfig(cfg) {
  if (!invoke) return;
  await invoke("save_app_config", { config: cfg });
}

async function _loadDirs() {
  if (!invoke) return { data_dir: "" };
  try { return await invoke("get_dirs") ?? { data_dir: "" }; } catch (_) { return { data_dir: "" }; }
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

  const [cfg, dirs] = await Promise.all([_loadConfig(), _loadDirs()]);

  const currentFontPx = window.LitAtlas?.getUiFontSize?.() ?? 20;
  body.innerHTML = _buildHTML(cfg, currentFontPx, dirs);
  _wireTabNav(body);
  _wireEvents(body, cfg, dirs);
}

// ── Built-in models (must match similarity_server.py AVAILABLE_MODELS) ────────

// ── HTML builder ──────────────────────────────────────────────────────────────

function _buildHTML(cfg, currentFontPx, dirs) {
  return `
    <div class="app-cfg-tab-bar">
      <button class="app-cfg-tab-btn active" data-tab="api">API Keys</button>
      <button class="app-cfg-tab-btn" data-tab="display">Display</button>
      <button class="app-cfg-tab-btn" data-tab="advanced">Advanced</button>
    </div>

    <div class="app-cfg-tab-pane active" data-tab-pane="api">
      ${_buildApiTab(cfg, dirs)}
    </div>
    <div class="app-cfg-tab-pane" data-tab-pane="display">
      ${_buildDisplayTab(currentFontPx)}
    </div>
    <div class="app-cfg-tab-pane" data-tab-pane="advanced">
      ${_buildAdvancedTab()}
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

function _buildApiTab(cfg, dirs) {
  const dataDir = dirs?.data_dir ?? "";

  return `
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">OpenAI API Key</div>
      <div class="app-cfg-hint">
        Used for embedding models (<code>text-embedding-3-small/large</code>)
        and GPT-4o-mini for AI summary generation.
        Generate a key at <code>platform.openai.com/api-keys</code>.
      </div>
      <div class="app-cfg-script-row">
        <input id="app-cfg-openai-key" class="app-cfg-input"
               type="password" placeholder="sk-…"
               value="${_esc(cfg.openai_api_key ?? "")}" autocomplete="off" spellcheck="false">
        <button id="app-cfg-openai-key-show" class="btn" title="Show / hide key"
                style="flex-shrink:0">
          <i class="bi bi-eye"></i>
        </button>
      </div>
      <div class="app-cfg-script-actions">
        <button id="app-cfg-openai-key-save" class="btn btn-new-paper">Save Key</button>
        <button id="app-cfg-openai-key-clear" class="btn app-cfg-reset-btn"
                ${!cfg.openai_api_key ? "disabled" : ""}>Clear</button>
      </div>
      <div id="app-cfg-openai-key-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Model API Endpoint</div>
      <div class="app-cfg-hint">
        Base URL for the OpenAI-compatible API. Leave blank to use the default
        OpenAI endpoint. Set this for self-hosted models
        (Ollama, LM Studio, Azure OpenAI, etc.).
      </div>
      <div class="app-cfg-script-row">
        <input id="app-cfg-api-base-url" class="app-cfg-input"
               type="text" placeholder="https://api.openai.com/v1"
               value="${_esc(cfg.api_base_url ?? "")}" autocomplete="off" spellcheck="false">
      </div>
      <div class="app-cfg-script-actions">
        <button id="app-cfg-api-base-url-save" class="btn btn-new-paper">Save URL</button>
        <button id="app-cfg-api-base-url-test" class="btn">Test Connection</button>
        <button id="app-cfg-api-base-url-clear" class="btn app-cfg-reset-btn"
                ${!cfg.api_base_url ? "disabled" : ""}>Reset to Default</button>
      </div>
      <div id="app-cfg-api-base-url-status" class="app-cfg-status"></div>
      <div class="app-cfg-hint" style="margin-top:10px">
        Embedding Pooling — how token vectors are combined into one embedding.
        Required for generative models (e.g. llama.cpp with a chat model).
        Leave blank for dedicated embedding models.
      </div>
      <div class="app-cfg-script-row" style="gap:8px">
        <select id="app-cfg-api-pooling" class="app-cfg-input" style="flex:0 0 auto;width:auto">
          <option value=""    ${!cfg.api_pooling              ? "selected" : ""}>(default)</option>
          <option value="last"  ${ cfg.api_pooling==="last"   ? "selected" : ""}>last</option>
          <option value="mean"  ${ cfg.api_pooling==="mean"   ? "selected" : ""}>mean</option>
          <option value="cls"   ${ cfg.api_pooling==="cls"    ? "selected" : ""}>cls</option>
          <option value="none"  ${ cfg.api_pooling==="none"   ? "selected" : ""}>none</option>
        </select>
        <button id="app-cfg-api-pooling-save" class="btn btn-new-paper">Save</button>
      </div>
      <div id="app-cfg-api-pooling-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Anthropic API Key</div>
      <div class="app-cfg-hint">
        Used for AI summary generation via Claude (preferred over OpenAI for generation).
        Anthropic does not offer a public embedding API — similarity scoring
        always uses OpenAI embeddings.
        Generate a key at <code>console.anthropic.com/settings/keys</code>.
      </div>
      <div class="app-cfg-script-row">
        <input id="app-cfg-anthropic-key" class="app-cfg-input"
               type="password" placeholder="sk-ant-…"
               value="${_esc(cfg.anthropic_api_key ?? "")}" autocomplete="off" spellcheck="false">
        <button id="app-cfg-anthropic-key-show" class="btn" title="Show / hide key"
                style="flex-shrink:0">
          <i class="bi bi-eye"></i>
        </button>
      </div>
      <div class="app-cfg-script-actions">
        <button id="app-cfg-anthropic-key-save" class="btn btn-new-paper">Save Key</button>
        <button id="app-cfg-anthropic-key-clear" class="btn app-cfg-reset-btn"
                ${!cfg.anthropic_api_key ? "disabled" : ""}>Clear</button>
      </div>
      <div id="app-cfg-anthropic-key-status" class="app-cfg-status"></div>
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

// ── Advanced tab ──────────────────────────────────────────────────────────────

function _buildAdvancedTab() {
  return `
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

function _wireEvents(body, cfg, dirs) {
  _wireDisplayTab(body);
  _wireApiTab(body, cfg, dirs);
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

function _wireApiKeyField(body, cfg, idPrefix, cfgKey) {
  const input    = body.querySelector(`#app-cfg-${idPrefix}`);
  const showBtn  = body.querySelector(`#app-cfg-${idPrefix}-show`);
  const saveBtn  = body.querySelector(`#app-cfg-${idPrefix}-save`);
  const clearBtn = body.querySelector(`#app-cfg-${idPrefix}-clear`);
  const statusEl = body.querySelector(`#app-cfg-${idPrefix}-status`);

  showBtn?.addEventListener("click", () => {
    const hidden = input?.type === "password";
    if (input) input.type = hidden ? "text" : "password";
    if (showBtn) showBtn.innerHTML = hidden
      ? '<i class="bi bi-eye-slash"></i>'
      : '<i class="bi bi-eye"></i>';
  });
  saveBtn?.addEventListener("click", async () => {
    const val = input?.value.trim() ?? "";
    cfg[cfgKey] = val || null;
    try {
      await _saveConfig(cfg);
      _showStatus(statusEl, "✓ Key saved — takes effect on next engine start", "ok");
      if (clearBtn) clearBtn.disabled = !val;
    } catch (e) { _showStatus(statusEl, `✗ ${e}`, "err"); }
  });
  clearBtn?.addEventListener("click", async () => {
    if (input) input.value = "";
    cfg[cfgKey] = null;
    try {
      await _saveConfig(cfg);
      _showStatus(statusEl, "✓ Key cleared", "ok");
      if (clearBtn) clearBtn.disabled = true;
    } catch (e) { _showStatus(statusEl, `✗ ${e}`, "err"); }
  });
}

function _wireApiTab(body, cfg, dirs) {
  _wireApiKeyField(body, cfg, "openai-key",    "openai_api_key");
  _wireApiKeyField(body, cfg, "anthropic-key", "anthropic_api_key");

  // Model API Endpoint URL
  const urlInput    = body.querySelector("#app-cfg-api-base-url");
  const urlSaveBtn  = body.querySelector("#app-cfg-api-base-url-save");
  const urlTestBtn  = body.querySelector("#app-cfg-api-base-url-test");
  const urlClearBtn = body.querySelector("#app-cfg-api-base-url-clear");
  const urlStatus   = body.querySelector("#app-cfg-api-base-url-status");

  urlSaveBtn?.addEventListener("click", async () => {
    const val = urlInput?.value.trim() ?? "";
    cfg.api_base_url = val || null;
    try {
      await _saveConfig(cfg);
      _showStatus(urlStatus, "✓ URL saved — takes effect on next action", "ok");
      if (urlClearBtn) urlClearBtn.disabled = !val;
    } catch (e) { _showStatus(urlStatus, `✗ ${e}`, "err"); }
  });

  urlTestBtn?.addEventListener("click", async () => {
    const url = urlInput?.value.trim() ?? "";
    if (!url) { _showStatus(urlStatus, "✗ Enter a URL to test", "err"); return; }
    urlTestBtn.disabled = true;
    _showStatus(urlStatus, "Testing connection…", "");
    try {
      const apiKey = body.querySelector("#app-cfg-openai-key")?.value.trim() ?? cfg.openai_api_key ?? "";
      const res = await invoke("test_api_endpoint", { url, apiKey });
      if (res?.ok) {
        _showStatus(urlStatus, `✓ ${res.message}`, "ok");
      } else {
        _showStatus(urlStatus, `✗ ${res?.error ?? "Connection failed"}`, "err");
      }
    } catch (e) {
      _showStatus(urlStatus, `✗ ${e}`, "err");
    } finally {
      urlTestBtn.disabled = false;
    }
  });

  urlClearBtn?.addEventListener("click", async () => {
    if (urlInput) urlInput.value = "";
    cfg.api_base_url = null;
    try {
      await _saveConfig(cfg);
      _showStatus(urlStatus, "✓ Reset to default OpenAI endpoint", "ok");
      if (urlClearBtn) urlClearBtn.disabled = true;
    } catch (e) { _showStatus(urlStatus, `✗ ${e}`, "err"); }
  });

  // Embedding pooling
  const poolingSel    = body.querySelector("#app-cfg-api-pooling");
  const poolingSave   = body.querySelector("#app-cfg-api-pooling-save");
  const poolingStatus = body.querySelector("#app-cfg-api-pooling-status");
  poolingSave?.addEventListener("click", async () => {
    cfg.api_pooling = poolingSel?.value || null;
    try {
      await _saveConfig(cfg);
      _showStatus(poolingStatus, "✓ Pooling saved", "ok");
    } catch (e) { _showStatus(poolingStatus, `✗ ${e}`, "err"); }
  });

  body.querySelector("#app-cfg-data-dir-open")?.addEventListener("click", async () => {
    const path = dirs?.data_dir;
    if (!path || !invoke) return;
    try { await invoke("open_folder", { path }); } catch (_) {}
  });
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

// ── DOM wiring ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("app-settings-close")
    ?.addEventListener("click", closeAppSettings);
  document.getElementById("app-settings-backdrop")
    ?.addEventListener("click", closeAppSettings);
  document.getElementById("btn-app-settings")
    ?.addEventListener("click", openAppSettings);
});
