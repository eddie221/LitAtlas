"use strict";

/**
 * app_settings.js
 *
 * Renders the App Settings panel.
 *
 * Features
 * ────────
 * 1. Custom Sidecar Script
 *    • Shows the currently active similarity_server.py path.
 *    • "Browse…" opens a native file picker (invoke pick_sidecar_script).
 *    • "Validate" asks the running sidecar to inspect the chosen file for
 *      the required hooks (similarity_fn / compute_embedding_fn).
 *    • "Reset to Default" clears the override.
 *    • Changes take effect on next sidecar launch.
 *
 * 2. Custom Models
 *    • Lists user-defined HuggingFace model IDs alongside the built-ins.
 *    • "Add Model" row: model ID + label + size_mb.
 *    • Each entry can be removed individually.
 *    • Saved to app_config.json via save_app_config.
 *    • Picked up in Similarity Settings via hf_list_models.
 */

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

  const [cfg, scriptInfo] = await Promise.all([
    _loadConfig(),
    invoke
      ? invoke("get_sidecar_script_info").catch(() => ({ path: "(unknown)", is_custom: false }))
      : Promise.resolve({ path: "(unavailable)", is_custom: false }),
  ]);

  const customModels = cfg.custom_models ?? [];
  body.innerHTML = _buildHTML(cfg, scriptInfo, customModels);
  _wireEvents(body, cfg, scriptInfo, customModels);
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function _buildHTML(cfg, scriptInfo, customModels) {
  const scriptPath = cfg.sidecar_script ?? "";
  const activePath = scriptInfo?.path ?? "(unknown)";
  const isCustom   = scriptInfo?.is_custom === true;

  const modelRows = _buildModelListHTML(customModels);

  return `
    <!-- ── Section 1: Sidecar Script ── -->
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Similarity Engine Script</div>
      <div class="app-cfg-hint">
        By default PaperGraph uses its bundled <code>similarity_server.py</code>.
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
    </div>

    <!-- ── Section 2: Custom Models ── -->
    <div class="app-cfg-section">
      <div class="app-cfg-section-title">Custom HuggingFace Models</div>
      <div class="app-cfg-hint">
        Add any public HuggingFace sentence-transformer model by its Hub ID
        (e.g. <code>BAAI/bge-base-en-v1.5</code>).
        Custom models appear in the Similarity Settings model picker alongside
        the built-ins and are scanned for offline availability on startup.
      </div>

      <div id="app-cfg-model-list">${modelRows}</div>

      <div class="app-cfg-add-model-form">
        <div class="app-cfg-add-row">
          <input id="app-cfg-new-id"    class="app-cfg-input app-cfg-new-id"
                 type="text" placeholder="Model ID  e.g. BAAI/bge-base-en-v1.5">
          <input id="app-cfg-new-label" class="app-cfg-input app-cfg-new-label"
                 type="text" placeholder="Label (optional)">
          <input id="app-cfg-new-size"  class="app-cfg-input app-cfg-new-size"
                 type="number" placeholder="MB" min="1" max="99999">
          <button id="app-cfg-add-model-btn" class="btn btn-new-paper">Add</button>
        </div>
        <div id="app-cfg-model-status" class="app-cfg-status"></div>
      </div>
    </div>

    <!-- ── Section 3: Plugin Contract Reference ── -->
    <div class="app-cfg-section">
      <button class="app-cfg-toggle" id="app-cfg-contract-toggle">
        Plugin Contract Reference <span class="app-cfg-toggle-icon">▶</span>
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
          <code>compute_embedding_fn</code> is defined, PaperGraph uses
          your vectors with the built-in edge computation.
        </p>
      </div>
    </div>`;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function _wireEvents(body, cfg, scriptInfo, customModels) {
  const scriptInput  = body.querySelector("#app-cfg-script-input");
  const validateBtn  = body.querySelector("#app-cfg-validate-btn");
  const validateArea = body.querySelector("#app-cfg-validate-area");
  const saveBtn      = body.querySelector("#app-cfg-script-save-btn");
  const resetBtn     = body.querySelector("#app-cfg-reset-btn");
  const scriptStatus = body.querySelector("#app-cfg-script-status");

  const checkBtn = body.querySelector("#app-cfg-check-btn");

  const _updateBtns = () => {
    const hasVal = !!scriptInput?.value.trim();
    if (validateBtn) validateBtn.disabled = !hasVal;
    if (checkBtn)    checkBtn.disabled    = !hasVal;
  };
  scriptInput?.addEventListener("input", _updateBtns);

  // Check path — validates that the file exists and is readable
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

  // Validate
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

  // Apply script path
  saveBtn?.addEventListener("click", async () => {
    const path = scriptInput?.value.trim() ?? "";
    cfg.sidecar_script = path || null;
    try {
      await _saveConfig(cfg);
      _showStatus(scriptStatus, "✓ Saved — takes effect on next engine start", "ok");
      setTimeout(() => _renderAppSettings(body.closest("#app-settings-panel")), 1200);
    } catch (e) { _showStatus(scriptStatus, `✗ ${e}`, "err"); }
  });

  // Reset
  resetBtn?.addEventListener("click", async () => {
    cfg.sidecar_script = null;
    if (scriptInput) scriptInput.value = "";
    try {
      await _saveConfig(cfg);
      _showStatus(scriptStatus, "✓ Reset to default", "ok");
      setTimeout(() => _renderAppSettings(body.closest("#app-settings-panel")), 800);
    } catch (e) { _showStatus(scriptStatus, `✗ ${e}`, "err"); }
  });

  // Model list delete buttons
  const modelList   = body.querySelector("#app-cfg-model-list");
  const modelStatus = body.querySelector("#app-cfg-model-status");
  _wireModelDelButtons(modelList, customModels, cfg, modelStatus);

  // Add model
  const addBtn     = body.querySelector("#app-cfg-add-model-btn");
  const idInput    = body.querySelector("#app-cfg-new-id");
  const labelInput = body.querySelector("#app-cfg-new-label");
  const sizeInput  = body.querySelector("#app-cfg-new-size");

  const doAdd = async () => {
    const id    = idInput?.value.trim();
    const label = labelInput?.value.trim() || id;
    const size  = parseInt(sizeInput?.value ?? "0", 10) || null;
    if (!id) { _showStatus(modelStatus, "✗ Model ID is required.", "err"); return; }
    if (customModels.some(m => m.id === id)) {
      _showStatus(modelStatus, "Model already in list.", "warn"); return;
    }
    const entry = { id, label, ...(size ? { size_mb: size } : {}) };
    customModels.push(entry);
    cfg.custom_models = customModels;
    try {
      await _saveConfig(cfg);
      if (idInput)    idInput.value    = "";
      if (labelInput) labelInput.value = "";
      if (sizeInput)  sizeInput.value  = "";
      modelList.innerHTML = _buildModelListHTML(customModels);
      _wireModelDelButtons(modelList, customModels, cfg, modelStatus);
      _showStatus(modelStatus, `✓ Added ${id}`, "ok");
      setTimeout(() => { if (modelStatus) modelStatus.textContent = ""; }, 2000);
    } catch (e) {
      customModels.pop(); cfg.custom_models = customModels;
      _showStatus(modelStatus, `✗ ${e}`, "err");
    }
  };

  addBtn?.addEventListener("click", doAdd);
  idInput?.addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); });

  // Contract collapsible
  body.querySelector("#app-cfg-contract-toggle")?.addEventListener("click", () => {
    const contractBody = body.querySelector("#app-cfg-contract-body");
    const icon         = body.querySelector(".app-cfg-toggle-icon");
    contractBody?.classList.toggle("hidden");
    if (icon) icon.textContent = contractBody?.classList.contains("hidden") ? "▶" : "▼";
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
        ${m.label && m.label !== m.id ? `<span class="app-cfg-model-label">${_esc(m.label)}</span>` : ""}
        ${m.size_mb ? `<span class="app-cfg-model-size">${m.size_mb} MB</span>` : ""}
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