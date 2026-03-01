"use strict";
/**
 * paper-page.js
 *
 * Full-screen paper page overlay with four tabs:
 *   Info        — title, venue, year, authors, hashtags, custom attributes
 *   Notes       — free-form notes, auto-saved to SQLite via Rust
 *   PDF         — local PDF file, path saved to SQLite via Rust
 *   Connections — similar papers grid
 *
 * All persistence goes through invoke() → Rust commands → sqlx → SQLite.
 * Paper ids are numbers (i64 rowid).
 */

import { colorForPaper, groupForPaper } from "./constant.js";
import { getPapersCache, getEdgesCache, setCurrentPaperCache, setCurrentConnectedCache, getCurrentPaperCache, state } from "./cache.js";
import { triggerEdgeRecompute, deselectNode, selectNode, refreshPaper, getConnected, attr, loadPdfIntoIframe } from "./graph.js";

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  (() => { throw new Error("Tauri not found"); })
);

// ── Custom dialog helpers ─────────────────────────────────────────────────────
// Tauri v2 blocks window.confirm / window.alert (always returns false / no-op).
// pgConfirm() and pgAlert() use a DOM modal instead.

function pgDialog(title, message, showCancel) {
  return new Promise(resolve => {
    const backdrop = document.getElementById("pg-dialog-backdrop");
    const titleEl  = document.getElementById("pg-dialog-title");
    const msgEl    = document.getElementById("pg-dialog-message");
    const okBtn    = document.getElementById("pg-dialog-ok");
    const cancelBtn= document.getElementById("pg-dialog-cancel");

    titleEl.textContent   = title;
    msgEl.textContent     = message;
    cancelBtn.style.display = showCancel ? "" : "none";
    backdrop.classList.add("open");

    function close(result) {
      backdrop.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    const onOk     = () => close(true);
    const onCancel = () => close(false);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);

    // Keyboard: Enter = OK, Escape = Cancel
    function onKey(e) {
      if (e.key === "Enter")  { e.preventDefault(); close(true); }
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      document.removeEventListener("keydown", onKey);
    }
    document.addEventListener("keydown", onKey);
  });
}

function pgConfirm(message, title) {
  return pgDialog(title || "Confirm", message, true);
}

function pgAlert(message, title) {
  return pgDialog(title || "Notice", message, false);
}

// ── PDF blob loader ───────────────────────────────────────────────────────────
// Reads PDF bytes via Rust (avoids asset:// protocol issues in Tauri v2) and
// sets the iframe src to a local blob URL.
let _ppPdfBlobUrl = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
let _saveTimer = null;
function debounce(fn, ms = 700) { clearTimeout(_saveTimer); _saveTimer = setTimeout(fn, ms); }

function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function setStatus(id, msg, color = "var(--accent)") {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.style.color = color; }
}
function clearStatus(id, ms = 2200) { setTimeout(() => setStatus(id, ""), ms); }

// ── Open / Close ──────────────────────────────────────────────────────────────

export function openPaperPage(paper, connected) {
  setCurrentPaperCache(paper);
  setCurrentConnectedCache(connected);
  renderPage(paper, connected);
  switchTab("info");
  document.getElementById("paper-page-overlay").classList.add("open");
}

function closePaperPage() {
  document.getElementById("paper-page-overlay").classList.remove("open");
  setCurrentPaperCache(null);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll(".pp-tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".pp-tab-pane").forEach(p =>
    p.classList.toggle("active", p.id === `pp-tab-${tab}`));
}

// ── Page render ───────────────────────────────────────────────────────────────
function renderPage(paper, connected) {
  const color = colorForPaper(paper);
  document.getElementById("pp-topic-badge").textContent = groupForPaper(paper);
  document.getElementById("pp-topic-badge").style.color = color;

  // Header title — inline edit
  const titleEl = document.getElementById("pp-main-title");
  titleEl.textContent = paper.title;
  titleEl.title = "Click to edit"; titleEl.style.cursor = "text";
  titleEl.onclick = () => makeHeaderEditable(titleEl, paper.title, async val => {
    if (!val || val === paper.title) return;
    await invoke("update_paper_core", { id: paper.id, title: val });
    paper.title = val;
    const cached = getPapersCache().find(p => p.id === paper.id);
    if (cached) cached.title = val;
    const node = state.nodes?.find(n => n.id === paper.id);
    if (node) node.title = val;
    titleEl.textContent = val;
  });

  // Header authors — inline edit (comma-separated → array)
  const authorsEl = document.getElementById("pp-main-authors");
  authorsEl.textContent = paper.authors.join(", ");
  authorsEl.title = "Click to edit"; authorsEl.style.cursor = "text";
  authorsEl.onclick = () => makeHeaderEditable(authorsEl, paper.authors.join(", "), async val => {
    if (!val) return;
    const arr = val.split(/,\s*/).map(a => a.trim()).filter(Boolean);
    await invoke("set_authors", { id: paper.id, authors: arr });
    paper.authors = arr;
    const cached = getPapersCache().find(p => p.id === paper.id);
    if (cached) cached.authors = arr;
    authorsEl.textContent = arr.join(", ");
  });

  renderInfoTab(paper);
  renderNotesTab(paper);
  renderConnectionsTab(connected);
}

function makeHeaderEditable(el, current, onSave) {
  el.onclick = null;
  const isTitle = el.id === "pp-main-title";
  const input = document.createElement("input");
  Object.assign(input.style, {
    background: "var(--bg)", border: "1px solid var(--accent2)",
    color: "var(--text-primary)",
    fontFamily: isTitle ? "'DM Serif Display',serif" : "'Space Mono',monospace",
    fontSize: isTitle ? "1.35rem" : "0.68rem",
    padding: "2px 6px", outline: "none", width: "100%",
  });
  input.value = current;
  el.textContent = "";
  el.appendChild(input);
  input.focus(); input.select();

  const commit = async () => {
    const val = input.value.trim();
    el.textContent = val || current;
    await onSave(val || current);
    el.style.cursor = "text";
    el.onclick = () => makeHeaderEditable(el, el.textContent, onSave);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
}

// ── Info tab ──────────────────────────────────────────────────────────────────
function renderInfoTab(paper) {
  // Build rows for the custom attributes table — exclude abstract (handled separately above)
  const attrRows = (paper.attributes ?? [])
    .filter(a => a.key !== "abstract")
    .sort((a, b) => a.order - b.order)
    .map((a, i) => `
      <tr data-key="${esc(a.key)}" data-order="${a.order}">
        <td><input class="pp-input attr-key-input" value="${esc(a.key)}" style="width:100%"></td>
        <td><input class="pp-input attr-val-input" value="${esc(a.value)}" style="width:100%"></td>
        <td style="text-align:center">
          <button class="pp-btn pp-btn-danger attr-del-btn" style="padding:3px 8px;font-size:.55rem">✕</button>
        </td>
      </tr>`).join("");

  document.getElementById("pp-info-content").innerHTML = `
    <div class="pp-info-grid">
      <div class="pp-field">
        <label class="pp-label">Year</label>
        <input class="pp-input" id="ppi-year" type="number" value="${paper.year}">
      </div>
      <div class="pp-field">
        <label class="pp-label">Venue</label>
        <input class="pp-input" id="ppi-venue" value="${esc(paper.venue)}">
      </div>

      <div class="pp-field pp-field-full">
        <label class="pp-label">Hashtags
          <span style="color:var(--text-dim);font-size:.55rem"> — space or comma separated, # optional</span>
        </label>
        <input class="pp-input" id="ppi-tags" value="${esc((paper.hashtags ?? []).join(" "))}">
      </div>

      <div class="pp-field pp-field-full">
          <label class="pp-label">Abstract
            <span style="color:var(--text-dim)"> — saved as a custom attribute</span>
          </label>
          <textarea class="pp-input pp-textarea" id="paper-abstract-edit" rows="5"
                    placeholder="Brief paper abstract…">${esc(attr(paper, "abstract", ""))}</textarea>
        </div>

      <div class="pp-section-divider" style="grid-column:1/-1">Custom Attributes</div>

      <div class="pp-field pp-field-full">
        <table style="width:100%;border-collapse:collapse" id="attr-table">
          <thead>
            <tr style="font-size:.58rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.1em">
              <th style="text-align:left;padding:0 0 6px;width:30%">Key</th>
              <th style="text-align:left;padding:0 0 6px">Value</th>
              <th style="width:36px"></th>
            </tr>
          </thead>
          <tbody id="attr-tbody">
            ${attrRows}
          </tbody>
        </table>
        <button class="pp-btn" id="attr-add-btn" style="margin-top:8px;font-size:.62rem">+ Add attribute</button>
      </div>

    </div>

    <div class="pp-save-row">
      <span id="pp-info-status" class="pp-save-status"></span>
      <button class="pp-btn pp-btn-accent" id="pp-save-info-btn">Save to SQLite</button>
    </div>`;

  // Wire add-attribute button
  document.getElementById("attr-add-btn").addEventListener("click", () => {
    const tbody = document.getElementById("attr-tbody");
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input class="pp-input attr-key-input" placeholder="key" style="width:100%"></td>
      <td><input class="pp-input attr-val-input" placeholder="value" style="width:100%"></td>
      <td style="text-align:center">
        <button class="pp-btn pp-btn-danger attr-del-btn" style="padding:3px 8px;font-size:.55rem">✕</button>
      </td>`;
    tbody.appendChild(row);
    wireDeleteButtons();
    row.querySelector(".attr-key-input").focus();
  });

  wireDeleteButtons();

  // Save button
  document.getElementById("pp-save-info-btn").addEventListener("click", async () => {
    setStatus("pp-info-status", "Saving…", "var(--text-secondary)");
    try {
      const year  = Number(document.getElementById("ppi-year").value)  || paper.year;
      const venue = document.getElementById("ppi-venue").value.trim();

      const rawTags = document.getElementById("ppi-tags").value.trim();
      const hashtags = rawTags
        ? rawTags.split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
                  .map(t => t.startsWith("#") ? t : "#" + t)
        : [];

      // Collect attribute table (abstract excluded from table, handled separately)
      const attributes = [...document.querySelectorAll("#attr-tbody tr")]
        .map((tr, i) => ({
          key:   tr.querySelector(".attr-key-input")?.value.trim() ?? "",
          value: tr.querySelector(".attr-val-input")?.value.trim() ?? "",
          order: i + 1,   // reserve order 0 for abstract
        }))
        .filter(a => a.key);

      // Always include abstract as order=0 attribute
      const abstractVal = document.getElementById("paper-abstract-edit")?.value.trim() ?? "";
      if (abstractVal) {
        attributes.unshift({ key: "abstract", value: abstractVal, order: 0 });
      }

      await invoke("update_paper_core", { id: paper.id, venue, year });
      await invoke("set_tags",          { id: paper.id, tags: hashtags });
      await invoke("set_attributes",    { id: paper.id, attributes });

      // Update in-memory paper
      await refreshPaper(paper.id);
      const cached = getPapersCache().find(p => p.id === paper.id);
      if (cached) {
        Object.assign(paper, cached);
        // Refresh sidebar header badge
        document.getElementById("pp-topic-badge").textContent = groupForPaper(paper);
        document.getElementById("pp-topic-badge").style.color = colorForPaper(paper);
      }

      setStatus("pp-info-status", "✓ Saved");
      clearStatus("pp-info-status");
    } catch (err) {
      setStatus("pp-info-status", "✗ Failed", "var(--accent3)");
      console.error("[PaperPage] save info failed:", err);
    }
  });
}

function wireDeleteButtons() {
  document.querySelectorAll(".attr-del-btn").forEach(btn => {
    btn.onclick = () => btn.closest("tr").remove();
  });
}

function updateWordCount(ta) {
  const el = ta ?? document.getElementById("pp-notes-textarea");
  const wc = el?.value.trim() ? el.value.trim().split(/\s+/).length : 0;
  const cnt = document.getElementById("pp-notes-count");
  if (cnt) cnt.textContent = `${wc} word${wc !== 1 ? "s" : ""}`;
}

function wrap(textarea, before, after) {
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  textarea.setRangeText(before + (textarea.value.slice(s, e) || "text") + after, s, e, "select");
  textarea.focus(); textarea.dispatchEvent(new Event("input"));
}

// ── Notes tab (markdown) ──────────────────────────────────────────────────────

// Safely render markdown — falls back to plain text if marked isn't loaded
function renderMd(text) {
  const preview = document.getElementById("pp-notes-preview");
  if (!preview) return;
  if (!text?.trim()) {
    preview.innerHTML = `<div class="md-empty">Nothing to preview yet.</div>`;
    return;
  }
  if (window.marked) {
    preview.innerHTML = window.marked.parse(text, { breaks: true, gfm: true });
  } else {
    // Fallback: pre-wrap plain text
    const pre = document.createElement("pre");
    pre.style.cssText = "white-space:pre-wrap;font-size:.75rem;line-height:1.85";
    pre.textContent = text;
    preview.innerHTML = "";
    preview.appendChild(pre);
  }
}

// View-mode state (shared across paper opens within session)
let _notesViewMode = "edit";

function applyViewMode(mode) {
  _notesViewMode = mode;
  const panes = document.getElementById("pp-notes-panes");
  if (!panes) return;
  panes.className = mode === "edit" ? "edit-only" : mode === "preview" ? "preview-only" : "";
  document.getElementById("pp-view-edit")?.classList.toggle("active", mode === "edit");
  document.getElementById("pp-view-split")?.classList.toggle("active", mode === "split");
  document.getElementById("pp-view-preview")?.classList.toggle("active", mode === "preview");
}

function renderNotesTab(paper) {
  const ta = document.getElementById("pp-notes-textarea");
  const fresh = ta.cloneNode(true);
  fresh.value = paper.notes ?? "";
  ta.parentNode.replaceChild(fresh, ta);

  updateWordCount(fresh);
  renderMd(fresh.value);
  applyViewMode(_notesViewMode);

  fresh.addEventListener("input", () => {
    updateWordCount(fresh);
    renderMd(fresh.value);
    setStatus("pp-notes-status", "Saving…", "var(--text-secondary)");
    debounce(async () => {
      try {
        await invoke("save_notes", { id: paper.id, notes: fresh.value });
        const cached = getPapersCache().find(p => p.id === paper.id);
        if (cached) cached.notes = fresh.value || null;
        setStatus("pp-notes-status", "✓ Saved");
        clearStatus("pp-notes-status");
        await refreshPaper(paper.id);
      } catch (err) {
        setStatus("pp-notes-status", "✗ Failed", "var(--accent3)");
        console.error("[PaperPage] save_notes failed:", err);
      }
    }, 800);
  });

  // View mode toggle buttons
  document.getElementById("pp-view-edit")?.addEventListener("click",    () => applyViewMode("edit"));
  document.getElementById("pp-view-split")?.addEventListener("click",   () => applyViewMode("split"));
  document.getElementById("pp-view-preview")?.addEventListener("click", () => applyViewMode("preview"));

  document.getElementById("pp-notes-clear").onclick = async () => {
    if (!await pgConfirm("Clear all notes for this paper?", "Clear Notes")) return;
    fresh.value = "";
    renderMd("");
    await invoke("save_notes", { id: paper.id, notes: "" });
    const cached = getPapersCache().find(p => p.id === paper.id);
    if (cached) cached.notes = null;
    updateWordCount(fresh);
    setStatus("pp-notes-status", "Cleared"); clearStatus("pp-notes-status");
  };

  document.getElementById("pp-notes-export").onclick = () => {
    const blob = new Blob([fresh.value], { type: "text/markdown" });
    const a = Object.assign(document.createElement("a"),
      { href: URL.createObjectURL(blob), download: `notes-${paper.id}.md` });
    a.click(); URL.revokeObjectURL(a.href);
  };

  document.getElementById("pp-notes-bold").onclick   = () => wrap(fresh, "**", "**");
  document.getElementById("pp-notes-italic").onclick = () => wrap(fresh, "_", "_");
  document.getElementById("pp-notes-head").onclick   = () => wrap(fresh, "## ", "");
  document.getElementById("pp-notes-code").onclick   = () => wrap(fresh, "`", "`");
}

async function renderPdfTab(paper) {
  const dropzone  = document.getElementById("pp-pdf-dropzone");
  const viewer    = document.getElementById("pp-pdf-viewer");
  const iframe    = document.getElementById("pp-pdf-iframe");
  const nameEl    = document.getElementById("pp-pdf-name");
  const statusEl  = document.getElementById("pp-pdf-db-status");
  const removeBtn = document.getElementById("pp-pdf-remove");
  const fileInput = document.getElementById("pp-pdf-file-input");
  if (paper.pdf_path) {
    showPdfFromPath(paper.pdf_path, viewer, dropzone, nameEl, statusEl);
    const filename = paper.pdf_path.split(/[/\\]/).pop();
    await loadPdfIntoIframe(paper.id, iframe, (msg, color) => {
      if (!statusEl) return;
      if (msg === null) {
        statusEl.textContent = filename;
        statusEl.style.color = "";
      } else {
        statusEl.textContent = msg;
        statusEl.style.color = color || "";
      }
    });
  }
  else{
    showDropzone(dropzone, viewer);
  }

  dropzone.onclick = () => fileInput.click();
  const freshInput = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(freshInput, fileInput);
  freshInput.onchange = () => {
    const file = freshInput.files[0];
    if (file) handlePdfPick(file, paper, dropzone, viewer, iframe, nameEl, statusEl);
  };
  dropzone.addEventListener("dragover",  e => { e.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", e => {
    e.preventDefault(); dropzone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf")
      handlePdfPick(file, paper, dropzone, viewer, iframe, nameEl, statusEl);
  });
  removeBtn.onclick = async () => {
    if (!await pgConfirm("Remove the PDF reference for this paper?", "Remove PDF")) return;
    await invoke("save_pdf_path", { id: paper.id, path: null });
    const cached = getPapersCache().find(p => p.id === paper.id);
    if (cached) cached.pdf_path = null;
    if (iframe.src.startsWith("blob:")) URL.revokeObjectURL(iframe.src);
    iframe.src = "";
    if (statusEl) statusEl.textContent = "PDF path removed";
    showDropzone(dropzone, viewer);
  };
}

// Read a File object as a base64 string (strips the data-URL prefix)
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result); // full data-URL; Rust strips prefix
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handlePdfPick(file, paper, dropzone, viewer, iframe, nameEl, statusEl) {
  if (statusEl) { statusEl.textContent = "Reading file…"; statusEl.style.color = "var(--text-secondary)"; }
  try {
    // Read the file bytes in JS — this works in all Tauri/browser environments
    // because it never relies on file.path (which browsers deliberately omit).
    const dataBase64 = await readFileAsBase64(file);

    if (statusEl) { statusEl.textContent = "Saving to project folder…"; }

    // store_pdf_bytes writes the bytes to projects/<slug>/pdfs/<paper_id>/<filename>
    // and updates the DB in one atomic Rust call.
    const storedPath = await invoke("store_pdf_bytes", {
      paperId:     paper.id,
      filename:    file.name,
      dataBase64,
    });

    paper.pdf_path = storedPath;
    const cached = getPapersCache().find(p => p.id === paper.id);
    if (cached) cached.pdf_path = storedPath;

    if (statusEl) {
      statusEl.textContent = `✓ ${storedPath.split(/[/\\]/).pop()}`;
      statusEl.style.color = "var(--accent)";
    }
  } catch (err) {
    console.error("[PaperPage] store_pdf_bytes failed:", err);
    // Last-resort fallback: just remember the original filename so the
    // paper isn't left in a broken state. Display will show "re-upload to view".
    try {
      await invoke("save_pdf_path", { id: paper.id, path: file.name });
      const cached = getPapersCache().find(p => p.id === paper.id);
      if (cached) cached.pdf_path = file.name;
    } catch (_) { /* ignore secondary failure */ }
    if (statusEl) {
      statusEl.textContent = `✗ ${err}`;
      statusEl.style.color = "var(--accent3)";
    }
  }
  // Always show the PDF in-frame using a local blob URL (no filesystem path needed)
  showPdfInFrame(file.name, viewer, dropzone, nameEl);
}

function showPdfFromPath(path, viewer, dropzone, nameEl, statusEl) {
  const convert = window.__TAURI__?.core?.convertFileSrc ?? window.__TAURI__?.tauri?.convertFileSrc;
  if (convert) {
    showPdfInFrame(path.split(/[/\\]/).pop(), viewer, dropzone, nameEl);
    if (statusEl) statusEl.textContent = path;
  } else {
    showDropzone(dropzone, viewer);
    if (statusEl) { statusEl.textContent = `Stored: ${path} — re-upload to view`; statusEl.style.color = "var(--text-secondary)"; }
  }
}

function showPdfViewerShell(viewer, dropzone, nameEl, filename) {
  dropzone.style.display = "none";
  viewer.style.display   = "flex";
  if (nameEl) nameEl.textContent = filename;
}

function showPdfInFrame(name, viewer, dropzone, nameEl) {
  dropzone.style.display = "none"; viewer.style.display = "flex";
  if (nameEl) nameEl.textContent = name;
}

export function showDropzone(dropzone, viewer) {
  dropzone.style.display = "flex"; viewer.style.display = "none";
}

// ── Connections tab ───────────────────────────────────────────────────────────
function renderConnectionsTab(connected) {
  const container = document.getElementById("pp-connections-list");
  if (!connected?.length) {
    container.innerHTML = `<div class="pp-empty">No connections above similarity threshold.</div>`;
    return;
  }
  container.innerHTML = connected.map(c => {
    const color   = colorForPaper(c.paper);
    const bar     = Math.round(c.sim * 100);
    const abstract = attr(c.paper, "abstract", "");
    return `
      <div class="pp-conn-card">
        <div class="pp-conn-header">
          <span class="pp-conn-topic" style="color:${color}">${esc(groupForPaper(c.paper))}</span>
          <span class="pp-conn-type">${c.type.replace(/_/g," ")}</span>
        </div>
        <div class="pp-conn-title">${esc(c.paper.title)}</div>
        <div class="pp-conn-authors">${esc(c.paper.authors.join(", "))} · ${c.paper.year} · ${esc(c.paper.venue)}</div>
        <div class="pp-conn-sim-row">
          <div class="pp-conn-sim-bar" style="width:${bar}%"></div>
          <span class="pp-conn-sim-label">sim ${c.sim.toFixed(3)}</span>
        </div>
        ${abstract ? `<div class="pp-conn-abstract">${esc(abstract)}</div>` : ""}
        <button class="pp-btn pp-btn-ghost pp-conn-open" data-id="${c.id}">Open Page →</button>
      </div>`;
  }).join("");

  container.querySelectorAll(".pp-conn-open").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = getPapersCache().find(p => p.id === Number(btn.dataset.id));
      if (target) openPaperPage(target, getConnected(target));
    });
  });
}

async function delectPaper() {
  const paper = getCurrentPaperCache();
    console.log(paper);
    if (!paper) return;
    if (!await pgConfirm(`Permanently delete "${paper.title}"?\n\nThis cannot be undone.`, "Delete Paper")) return;

    try {
      await invoke("delete_paper", { id: paper.id });

      const idx = getPapersCache().findIndex(p => p.id === paper.id);
      if (idx !== -1) getPapersCache().splice(idx, 1);
      const nodeIdx = state.nodes?.findIndex(n => n.id === paper.id);
      if (nodeIdx !== undefined && nodeIdx !== -1) state.nodes.splice(nodeIdx, 1);

      await triggerEdgeRecompute();

      document.getElementById("stat-papers").textContent      = getPapersCache().length;
      document.getElementById("stat-connections").textContent = getEdgesCache().length;

      closePaperPage();
      deselectNode();
    } catch (err) {
      await pgAlert(`Delete failed: ${err}`, "Error");
      console.error("[PaperPage] delete_paper failed:", err);
    }
}

// ── Wire overlay controls ─────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".pp-tab-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
      if (btn.dataset.tab === "pdf" && getCurrentPaperCache()) renderPdfTab(getCurrentPaperCache());
    }));

  document.getElementById("pp-close-btn").addEventListener("click", () => {
    console.log(getCurrentPaperCache());
    const cached = getPapersCache().find(p => p.id === getCurrentPaperCache().id);
    selectNode(cached);
    closePaperPage();
  });

  document.getElementById("pp-overlay-bg").addEventListener("click", () => {
    const cached = getPapersCache().find(p => p.id === getCurrentPaperCache().id);
    selectNode(cached);
    closePaperPage();
  });

  document.getElementById("pp-delete-btn-overview").addEventListener("click", delectPaper);
  document.getElementById("pp-delete-btn-detail").addEventListener("click", delectPaper);
});