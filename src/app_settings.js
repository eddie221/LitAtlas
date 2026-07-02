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
      <div class="app-cfg-section-title">API Keys</div>
      <div class="app-cfg-hint" id="app-cfg-api-key-hint">
        Used for embedding models (<code>text-embedding-3-small/large</code>)
        and GPT-4o-mini for AI summary generation.
        Generate a key at <code>platform.openai.com/api-keys</code>.
      </div>
      <div class="app-cfg-script-row" style="gap:8px">
        <select id="app-cfg-api-key-provider" class="app-cfg-input"
                style="width:130px;flex:0 0 auto">
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
        <input id="app-cfg-api-key" class="app-cfg-input"
               type="password" placeholder="sk-…"
               value="${_esc(cfg.openai_api_key ?? "")}" autocomplete="off" spellcheck="false">
        <button id="app-cfg-api-key-show" class="btn" title="Show / hide key"
                style="flex-shrink:0">
          <i class="bi bi-eye"></i>
        </button>
      </div>
      <div class="app-cfg-script-actions">
        <button id="app-cfg-api-key-save" class="btn btn-new-paper">Save Key</button>
        <button id="app-cfg-api-key-clear" class="btn app-cfg-reset-btn"
                ${!cfg.openai_api_key ? "disabled" : ""}>Clear</button>
      </div>
      <div id="app-cfg-api-key-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">PDF Extraction Device</div>
      <div class="app-cfg-hint">
        Hardware used by marker for PDF→Markdown conversion.
        <b>Auto</b> picks MPS on Apple Silicon, CUDA if an NVIDIA GPU is detected,
        otherwise CPU. Change only if auto-detection misbehaves.
      </div>
      <div class="app-cfg-script-row" style="gap:8px">
        <select id="app-cfg-pdf-device" class="app-cfg-input" style="width:220px;flex:0 0 auto">
          ${["auto","mps","cuda","cpu"].map(v => {
            const cur = (cfg.pdf_extract_device ?? "auto");
            const label = { auto:"Auto-detect", mps:"MPS (Apple Silicon)", cuda:"CUDA (NVIDIA)", cpu:"CPU" }[v];
            return `<option value="${v}"${v===cur?" selected":""}>${label}</option>`;
          }).join("")}
        </select>
        <button id="app-cfg-pdf-device-save" class="btn btn-new-paper">Save</button>
      </div>
      <div id="app-cfg-pdf-device-status" class="app-cfg-status"></div>
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
    </div>

    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Summary Max Tokens</div>
      <div class="app-cfg-hint">
        Maximum output tokens for AI summary generation. Leave blank to use the
        provider default (16 384 for Anthropic, 16 384 for OpenAI).
      </div>
      <div class="app-cfg-script-row" style="gap:8px">
        <input id="app-cfg-summary-max-tokens" class="app-cfg-input"
               type="number" min="256" max="131072" step="256"
               placeholder="16384"
               value="${cfg.summary_max_tokens ?? ""}"
               style="width:120px;flex:0 0 auto">
        <button id="app-cfg-summary-max-tokens-save" class="btn btn-new-paper">Save</button>
        <button id="app-cfg-summary-max-tokens-clear" class="btn app-cfg-reset-btn"
                ${!cfg.summary_max_tokens ? "disabled" : ""}>Reset to Default</button>
      </div>
      <div id="app-cfg-summary-max-tokens-status" class="app-cfg-status"></div>
    </div>

    <div class="app-cfg-section" id="app-cfg-model-section"
         style="${cfg.api_base_url ? "" : "display:none"}">
      <div class="app-cfg-section-title">Model Selection</div>
      <div class="app-cfg-hint">
        Choose which models from your endpoint to use for embedding and summary.
      </div>
      <div class="app-cfg-script-actions" style="margin-bottom:8px">
        <button id="app-cfg-fetch-models" class="btn">Fetch Models</button>
        <span id="app-cfg-fetch-models-status" class="app-cfg-status" style="margin-left:8px"></span>
      </div>
      <div class="app-cfg-row" style="flex-direction:column;gap:8px">
        <div class="app-cfg-row" style="gap:8px;align-items:center">
          <label style="min-width:130px;font-size:0.8rem;color:var(--text-secondary)">Embedding Model</label>
          <select id="app-cfg-embedding-model" class="app-cfg-input" style="flex:1">
            <option value="">— fetch models first —</option>
          </select>
        </div>
        <div class="app-cfg-row" style="gap:8px;align-items:center">
          <label style="min-width:130px;font-size:0.8rem;color:var(--text-secondary)">Summary Model</label>
          <select id="app-cfg-summary-model" class="app-cfg-input" style="flex:1">
            <option value="">— fetch models first —</option>
          </select>
        </div>
      </div>
      <div class="app-cfg-script-actions" style="margin-top:8px">
        <button id="app-cfg-save-models" class="btn btn-new-paper" disabled>Save Model Selection</button>
      </div>
      <div id="app-cfg-model-status" class="app-cfg-status"></div>
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

const _API_KEY_PROVIDERS = {
  openai: {
    cfgKey: "openai_api_key",
    placeholder: "sk-…",
    hint: `Used for embedding models (<code>text-embedding-3-small/large</code>)
      and GPT-4o-mini for AI summary generation.
      Generate a key at <code>platform.openai.com/api-keys</code>.`,
  },
  anthropic: {
    cfgKey: "anthropic_api_key",
    placeholder: "sk-ant-…",
    hint: `Used for AI summary generation via Claude (preferred over OpenAI for generation).
      Anthropic does not offer a public embedding API — similarity scoring
      always uses OpenAI embeddings.
      Generate a key at <code>console.anthropic.com/settings/keys</code>.`,
  },
};

function _wireApiKeySection(body, cfg) {
  const providerSel = body.querySelector("#app-cfg-api-key-provider");
  const input       = body.querySelector("#app-cfg-api-key");
  const showBtn     = body.querySelector("#app-cfg-api-key-show");
  const saveBtn     = body.querySelector("#app-cfg-api-key-save");
  const clearBtn    = body.querySelector("#app-cfg-api-key-clear");
  const statusEl    = body.querySelector("#app-cfg-api-key-status");
  const hintEl      = body.querySelector("#app-cfg-api-key-hint");

  const currentCfgKey = () => _API_KEY_PROVIDERS[providerSel?.value]?.cfgKey;

  function _syncToProvider() {
    const meta = _API_KEY_PROVIDERS[providerSel.value];
    if (!meta) return;
    if (input) {
      input.value = cfg[meta.cfgKey] ?? "";
      input.placeholder = meta.placeholder;
      input.type = "password";
    }
    if (showBtn) showBtn.innerHTML = '<i class="bi bi-eye"></i>';
    if (hintEl) hintEl.innerHTML = meta.hint;
    if (clearBtn) clearBtn.disabled = !cfg[meta.cfgKey];
    if (statusEl) { statusEl.textContent = ""; statusEl.className = "app-cfg-status"; }
  }

  providerSel?.addEventListener("change", _syncToProvider);

  showBtn?.addEventListener("click", () => {
    const hidden = input?.type === "password";
    if (input) input.type = hidden ? "text" : "password";
    if (showBtn) showBtn.innerHTML = hidden
      ? '<i class="bi bi-eye-slash"></i>'
      : '<i class="bi bi-eye"></i>';
  });

  saveBtn?.addEventListener("click", async () => {
    const cfgKey = currentCfgKey();
    if (!cfgKey) return;
    const val = input?.value.trim() ?? "";
    cfg[cfgKey] = val || null;
    try {
      await _saveConfig(cfg);
      _showStatus(statusEl, "✓ Key saved — takes effect on next engine start", "ok");
      if (clearBtn) clearBtn.disabled = !val;
    } catch (e) { _showStatus(statusEl, `✗ ${e}`, "err"); }
  });

  clearBtn?.addEventListener("click", async () => {
    const cfgKey = currentCfgKey();
    if (!cfgKey) return;
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
  _wireApiKeySection(body, cfg);

  // PDF extraction device
  const pdfDevSel    = body.querySelector("#app-cfg-pdf-device");
  const pdfDevSave   = body.querySelector("#app-cfg-pdf-device-save");
  const pdfDevStatus = body.querySelector("#app-cfg-pdf-device-status");
  pdfDevSave?.addEventListener("click", async () => {
    cfg.pdf_extract_device = pdfDevSel?.value || "auto";
    try {
      await _saveConfig(cfg);
      _showStatus(pdfDevStatus, "✓ Device saved — applies to next PDF extraction", "ok");
    } catch (e) { _showStatus(pdfDevStatus, `✗ ${e}`, "err"); }
  });

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
      const modelSection = body.querySelector("#app-cfg-model-section");
      if (modelSection) modelSection.style.display = val ? "" : "none";
    } catch (e) { _showStatus(urlStatus, `✗ ${e}`, "err"); }
  });

  urlTestBtn?.addEventListener("click", async () => {
    const url = urlInput?.value.trim() ?? "";
    if (!url) { _showStatus(urlStatus, "✗ Enter a URL to test", "err"); return; }
    urlTestBtn.disabled = true;
    _showStatus(urlStatus, "Testing connection…", "");
    try {
      // Save the URL so check_api_connection reads the same config as AI mode does.
      cfg.api_base_url = url;
      await _saveConfig(cfg);
      if (urlClearBtn) urlClearBtn.disabled = false;
      const res = await invoke("check_api_connection");
      if (res?.ok) {
        _showStatus(urlStatus, `✓ Connected (${res.provider ?? "ok"})`, "ok");
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

  // Summary max tokens
  const maxTokInput  = body.querySelector("#app-cfg-summary-max-tokens");
  const maxTokSave   = body.querySelector("#app-cfg-summary-max-tokens-save");
  const maxTokClear  = body.querySelector("#app-cfg-summary-max-tokens-clear");
  const maxTokStatus = body.querySelector("#app-cfg-summary-max-tokens-status");
  maxTokSave?.addEventListener("click", async () => {
    const val = parseInt(maxTokInput?.value ?? "", 10);
    cfg.summary_max_tokens = Number.isFinite(val) && val > 0 ? val : null;
    try {
      await _saveConfig(cfg);
      _showStatus(maxTokStatus, "✓ Saved — takes effect on next summary generation", "ok");
      if (maxTokClear) maxTokClear.disabled = !cfg.summary_max_tokens;
    } catch (e) { _showStatus(maxTokStatus, `✗ ${e}`, "err"); }
  });
  maxTokClear?.addEventListener("click", async () => {
    if (maxTokInput) maxTokInput.value = "";
    cfg.summary_max_tokens = null;
    try {
      await _saveConfig(cfg);
      _showStatus(maxTokStatus, "✓ Reset to provider default", "ok");
      if (maxTokClear) maxTokClear.disabled = true;
    } catch (e) { _showStatus(maxTokStatus, `✗ ${e}`, "err"); }
  });

  body.querySelector("#app-cfg-data-dir-open")?.addEventListener("click", async () => {
    const path = dirs?.data_dir;
    if (!path || !invoke) return;
    try { await invoke("open_folder", { path }); } catch (_) {}
  });

  _wireModelSection(body, cfg);
}

function _wireModelSection(body, cfg) {
  const section       = body.querySelector("#app-cfg-model-section");
  const fetchBtn      = body.querySelector("#app-cfg-fetch-models");
  const fetchStatus   = body.querySelector("#app-cfg-fetch-models-status");
  const embSelect     = body.querySelector("#app-cfg-embedding-model");
  const sumSelect     = body.querySelector("#app-cfg-summary-model");
  const saveBtn       = body.querySelector("#app-cfg-save-models");
  const modelStatus   = body.querySelector("#app-cfg-model-status");
  if (!section || !invoke) return;

  function _populateSelect(sel, models, saved) {
    sel.innerHTML = models.map(m =>
      `<option value="${_esc(m)}"${m === saved ? " selected" : ""}>${_esc(m)}</option>`
    ).join("");
    if (saveBtn) saveBtn.disabled = false;
  }

  async function _fetchAndPopulate() {
    fetchStatus.textContent = "Fetching…";
    fetchStatus.className = "app-cfg-status";
    try {
      const res = await invoke("list_api_models");
      if (!res?.ok || !res.models?.length) {
        fetchStatus.textContent = `✗ ${res?.error ?? "No models returned"}`;
        fetchStatus.className = "app-cfg-status err";
        return;
      }
      const models = res.models;
      _populateSelect(embSelect, models, cfg.embedding_model ?? "");
      _populateSelect(sumSelect, models, cfg.summary_model   ?? "");
      fetchStatus.textContent = `${models.length} model${models.length !== 1 ? "s" : ""} loaded`;
      fetchStatus.className = "app-cfg-status ok";

      // Warn if saved models are no longer in the list
      const warnings = [];
      if (cfg.embedding_model && !models.includes(cfg.embedding_model))
        warnings.push(`Embedding model "${cfg.embedding_model}" not found`);
      if (cfg.summary_model && !models.includes(cfg.summary_model))
        warnings.push(`Summary model "${cfg.summary_model}" not found`);
      if (warnings.length)
        _showStatus(modelStatus, `⚠ ${warnings.join("; ")} — please re-select`, "err");
    } catch (e) {
      fetchStatus.textContent = `✗ ${e}`;
      fetchStatus.className = "app-cfg-status err";
    }
  }

  fetchBtn?.addEventListener("click", _fetchAndPopulate);

  saveBtn?.addEventListener("click", async () => {
    cfg.embedding_model = embSelect?.value ?? "";
    cfg.summary_model   = sumSelect?.value ?? "";
    try {
      await _saveConfig(cfg);
      _showStatus(modelStatus, "✓ Model selection saved", "ok");
    } catch (e) {
      _showStatus(modelStatus, `✗ ${e}`, "err");
    }
  });

  // Auto-fetch on open if endpoint is already configured and models were previously saved.
  if (cfg.api_base_url && (cfg.embedding_model || cfg.summary_model)) {
    _fetchAndPopulate();
  }
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
