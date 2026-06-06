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
import { triggerEdgeRecompute, deselectNode, selectNode, refreshPaper, recomputeEdgesForPaper, getConnected, attr, loadPdfIntoIframe } from "./graph.js";
import { getTagVocab } from "./similarity.js";
import { enqueueJob } from "./jobs.js";
import { attachTagAutocomplete } from "./tag-autocomplete.js";

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  (() => { throw new Error("Tauri not found"); })
);

// ── Embedding helpers ─────────────────────────────────────────────────────────

/**
 * Compute and cache the HF embedding for a single paper in the background.
 * Uses the current similarity config from window.LitAtlas if available,
 * falling back to sensible defaults.
 *
 * The embedding is saved next to the PDF as embedding.json and will be used
 * automatically by hf_compute_similarity to skip re-encoding.
 */

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

// Three-way dialog for PDF removal.
// Returns: true = delete from disk, false = unlink only, null = cancelled.
function _pgPdfRemoveDialog() {
  return new Promise(resolve => {
    const backdrop = document.getElementById("pg-dialog-backdrop");
    const titleEl  = document.getElementById("pg-dialog-title");
    const msgEl    = document.getElementById("pg-dialog-message");
    const okBtn    = document.getElementById("pg-dialog-ok");
    const cancelBtn= document.getElementById("pg-dialog-cancel");

    titleEl.textContent = "Remove PDF";
    msgEl.textContent   = "Do you want to delete the PDF file from disk, or just unlink it from this paper?";

    // Repurpose the OK button as "Delete file" and Cancel as "Unlink only",
    // then inject a third "Cancel" link.
    okBtn.textContent     = "Delete File";
    okBtn.style.background = "rgba(255,60,60,.15)";
    okBtn.style.borderColor= "rgba(255,60,60,.4)";
    okBtn.style.color      = "#ff7070";
    cancelBtn.textContent  = "Unlink Only";
    cancelBtn.style.display= "";

    // Inject a real cancel option below the buttons.
    const dismissLink = document.createElement("button");
    dismissLink.textContent = "Cancel";
    dismissLink.className   = "btn";
    dismissLink.style.cssText = "margin-top:6px;width:100%;font-size:.62rem;color:var(--text-secondary)";
    cancelBtn.parentNode.insertBefore(dismissLink, cancelBtn.nextSibling);

    backdrop.classList.add("open");

    function close(result) {
      backdrop.classList.remove("open");
      // Restore button defaults for future uses of the shared modal.
      okBtn.textContent      = "OK";
      okBtn.style.background = "";
      okBtn.style.borderColor= "";
      okBtn.style.color      = "";
      cancelBtn.textContent  = "Cancel";
      dismissLink.remove();
      okBtn.removeEventListener("click", onDelete);
      cancelBtn.removeEventListener("click", onUnlink);
      dismissLink.removeEventListener("click", onDismiss);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    const onDelete  = () => close(true);
    const onUnlink  = () => close(false);
    const onDismiss = () => close(null);
    okBtn.addEventListener("click", onDelete);
    cancelBtn.addEventListener("click", onUnlink);
    dismissLink.addEventListener("click", onDismiss);

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      document.removeEventListener("keydown", onKey);
    }
    document.addEventListener("keydown", onKey);
  });
}

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
  document.getElementById("pp-topic-badge").textContent = paper.venue + paper.year;//groupForPaper(paper);
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
    .map((a) => `
      <tr data-key="${esc(a.key)}" data-order="${a.order}">
        <td><input class="pp-input attr-key-input" value="${esc(a.key)}" style="width:100%"></td>
        <td><input class="pp-input attr-val-input" value="${esc(a.value)}" style="width:100%"></td>
        <td style="text-align:center">
          <button class="pp-btn pp-btn-danger attr-del-btn" style="padding:3px 8px;font-size:.55rem">✕</button>
        </td>
      </tr>`).join("");

  document.getElementById("pp-info-content").innerHTML = `
    <div class="pp-info-grid">
      <div class="pp-field pp-field-full">
        <label class="pp-label">Alias
          <span style="color:var(--text-dim);font-size:.55rem"> — shown on graph instead of title when set</span>
        </label>
        <input class="pp-input" id="ppi-alias" value="${esc(paper.alias ?? "")}" placeholder="Short label for the graph node…">
      </div>

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
          <span style="color:var(--text-dim);font-size:.55rem"> — space or comma separated</span>
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
      <button class="pp-btn pp-btn-accent" id="pp-save-info-btn">Save</button>
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

  // Hashtag autocomplete on the tags input
  const tagsInput = document.getElementById("ppi-tags");
  console.log("tagsInput : ", tagsInput);
  if (tagsInput) attachTagAutocomplete(tagsInput, getTagVocab);

  // Save button
  document.getElementById("pp-save-info-btn").addEventListener("click", async () => {
    setStatus("pp-info-status", "Saving…", "var(--text-secondary)");
    try {
      const year  = Number(document.getElementById("ppi-year").value)  || paper.year;
      const venue = document.getElementById("ppi-venue").value.trim();

      const alias = document.getElementById("ppi-alias").value.trim() || null;
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

      // Detect whether any embedding-relevant field changed.
      const contentChanged =
        year !== paper.year ||
        venue !== (paper.venue ?? "") ||
        JSON.stringify(hashtags.map(t => t.replace(/^#/,"")).sort()) !==
          JSON.stringify((paper.hashtags ?? []).map(t => t.replace(/^#/,"")).sort()) ||
        JSON.stringify(attributes.map(a => ({ k: a.key, v: a.value })).sort((a,b) => a.k < b.k ? -1 : 1)) !==
          JSON.stringify((paper.attributes ?? []).map(a => ({ k: a.key, v: a.value })).sort((a,b) => a.k < b.k ? -1 : 1));

      await invoke("update_paper_core", { id: paper.id, venue, year });
      await invoke("save_alias",        { id: paper.id, alias });
      await invoke("set_tags",          { id: paper.id, tags: hashtags });
      await invoke("set_attributes",    { id: paper.id, attributes });

      // Update alias on the graph node immediately
      const node = state.nodes?.find(n => n.id === paper.id);
      if (node) node.alias = alias;
      paper.alias = alias;
      const cachedPaper = getPapersCache().find(p => p.id === paper.id);
      if (cachedPaper) cachedPaper.alias = alias;

      // Update in-memory paper
      await refreshPaper(paper.id);
      const cached = getPapersCache().find(p => p.id === paper.id);
      if (cached) {
        Object.assign(paper, cached);
        // Refresh sidebar header badge
        document.getElementById("pp-topic-badge").textContent = paper.venue;//groupForPaper(paper);
        document.getElementById("pp-topic-badge").style.color = colorForPaper(paper);
      }

      // Recompute edges between this paper and all others (skip if only alias changed)
      if (contentChanged) {
        setStatus("pp-info-status", "Updating edges…", "var(--text-secondary)");
        try {
          await recomputeEdgesForPaper(paper.id);
        } catch (edgeErr) {
          console.warn("[PaperPage] Edge recompute failed:", edgeErr);
        }
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

const _KATEX_OPTS = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "$",  right: "$",  display: false },
    { left: "\\(", right: "\\)", display: false },
    { left: "\\[", right: "\\]", display: true },
  ],
  throwOnError: false,
};

function renderMathInEl(el) {
  if (window.renderMathInElement) window.renderMathInElement(el, _KATEX_OPTS);
}

// Safely render markdown — falls back to plain text if marked isn't loaded
function renderMd(text) {
  const preview = document.getElementById("pp-notes-preview");
  if (!preview) return;
  if (!text?.trim()) {
    preview.innerHTML = `<div class="md-empty">Nothing to preview yet.</div>`;
    return;
  }
  if (window.marked) {
    preview.innerHTML = window.marked.parse(text);
    renderMathInEl(preview);
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

  // Clone the file input to clear any previous onchange listener.
  // Use a shallow clone so the new element keeps the same id/accept attributes.
  const oldInput  = document.getElementById("pp-pdf-file-input");
  const fileInput = oldInput.cloneNode(false);
  oldInput.parentNode.replaceChild(fileInput, oldInput);

  // ── Picker: triggered by click on dropzone or file input ──────────────────
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) handlePdfPick(file, paper, dropzone, viewer, iframe, nameEl, statusEl);
  });
  dropzone.onclick = () => fileInput.click();

  // ── Drag-and-drop: use named handlers so we can remove them next render ───
  // Store handlers on the element so the next call can detach them first.
  if (dropzone._pgDragOver)  dropzone.removeEventListener("dragover",  dropzone._pgDragOver);
  if (dropzone._pgDragLeave) dropzone.removeEventListener("dragleave", dropzone._pgDragLeave);
  if (dropzone._pgDrop)      dropzone.removeEventListener("drop",      dropzone._pgDrop);

  dropzone._pgDragOver  = e => { e.preventDefault(); dropzone.classList.add("drag-over"); };
  dropzone._pgDragLeave = ()  => dropzone.classList.remove("drag-over");
  dropzone._pgDrop      = e  => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf")
      handlePdfPick(file, paper, dropzone, viewer, iframe, nameEl, statusEl);
  };

  dropzone.addEventListener("dragover",  dropzone._pgDragOver);
  dropzone.addEventListener("dragleave", dropzone._pgDragLeave);
  dropzone.addEventListener("drop",      dropzone._pgDrop);

  // ── Remove button ──────────────────────────────────────────────────────────
  removeBtn.onclick = async () => {
    // Ask whether to also delete the file from disk, or just unlink it.
    const deleteFile = await _pgPdfRemoveDialog();
    if (deleteFile === null) return; // cancelled

    if (deleteFile) {
      // Delete file from disk + clear DB path in one atomic Rust call.
      await invoke("delete_pdf_file", { id: paper.id });
    } else {
      // Unlink only — keep the file on disk, clear the DB reference.
      await invoke("save_pdf_path", { id: paper.id, path: null });
    }

    // Clear pdf_path on both the closure variable and the cache entry.
    // If refreshPaper() ran earlier it replaced the cache entry with a new
    // object, so cached !== paper — both must be cleared.
    paper.pdf_path = null;
    const cached = getPapersCache().find(p => p.id === paper.id);
    if (cached) cached.pdf_path = null;
    if (iframe.src.startsWith("blob:")) URL.revokeObjectURL(iframe.src);
    iframe.src = "";
    if (statusEl) statusEl.textContent = deleteFile ? "PDF deleted" : "PDF removed";
    showDropzone(dropzone, viewer);
  };

  // ── Load existing PDF or show dropzone ────────────────────────────────────
  if (paper.pdf_path) {
    showPdfFromPath(paper.pdf_path, viewer, dropzone, nameEl, statusEl);
    const filename = paper.pdf_path.split(/[/\\]/).pop();
    const loaded = await loadPdfIntoIframe(paper.id, iframe, (msg, color) => {
      if (!statusEl) return;
      if (msg === null) { statusEl.textContent = filename; statusEl.style.color = ""; }
      else              { statusEl.textContent = msg;      statusEl.style.color = color ?? ""; }
    });
    // If the file is gone (deleted externally or path stale), fall back to dropzone.
    if (!loaded) {
      paper.pdf_path = null;
      const c = getPapersCache().find(p => p.id === paper.id);
      if (c) c.pdf_path = null;
      showDropzone(dropzone, viewer);
    }
  } else {
    showDropzone(dropzone, viewer);
  }
}

// Read a File object as a base64 string (strips the data-URL prefix)
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const comma  = result.indexOf(",");
      resolve(comma !== -1 ? result.slice(comma + 1) : result);
    };
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

    // Add to the serial job queue — extracts PDF text, generates AI summary,
    // and computes embedding one paper at a time.
    enqueueJob(paper.id, paper.title);
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
  // Show viewer and load the picked file directly as a blob URL —
  // no round-trip to Rust needed, works immediately after upload.
  showPdfInFrame(file.name, viewer, dropzone, nameEl);
  if (iframe.src.startsWith("blob:")) URL.revokeObjectURL(iframe.src);
  const blob = new Blob([await file.arrayBuffer()], { type: "application/pdf" });
  iframe.src = URL.createObjectURL(blob);
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
    console.log("delete : ", paper);
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

// ── AI Summary tab ────────────────────────────────────────────────────────────
async function renderAiSummaryTab(paper) {
  const container = document.getElementById("pp-ai-summary-content");
  container.innerHTML = `<div class="pp-ai-summary-loading">Loading…</div>`;

  // Load section files: { filename → content }
  let files;
  try {
    files = await invoke("read_paper_md", { paperId: paper.id });
  } catch (e) {
    container.innerHTML =
      `<div class="pp-ai-summary-loading" style="color:var(--accent3)">Failed to load: ${e}</div>`;
    return;
  }

  const _TAB_ORDER = ["overview", "motivation", "contributions", "method", "experiments", "limitations", "takeaways"];
  const filenames = Object.keys(files).sort((a, b) => {
    const ai = _TAB_ORDER.indexOf(a.replace(/\.md$/i, "").toLowerCase());
    const bi = _TAB_ORDER.indexOf(b.replace(/\.md$/i, "").toLowerCase());
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (!filenames.length) {
    container.innerHTML = `<div class="pp-ai-summary-loading">${
      paper.pdf_path
        ? "Generating AI summary… (check back after embedding completes)"
        : "Upload a PDF to generate an AI summary."
    }</div>`;
    return;
  }

  // Build the section tab bar + panes
  const tabsHtml = filenames.map((fn, i) => {
    const label = fn.replace(/\.md$/i, "");
    return `<button class="pp-ai-section-tab${i === 0 ? " active" : ""}" data-file="${fn}">${label}</button>`;
  }).join("");

  container.innerHTML = `
    <div class="pp-ai-section-tabs">${tabsHtml}</div>
    <div class="pp-ai-summary-toolbar">
      <div class="pp-ai-toolbar-left">
        <button class="pp-ai-icon-btn" id="pp-ai-open-folder" title="Open folder">
          <i class="bi bi-folder2-open"></i>
        </button>
        <button class="pp-ai-icon-btn" id="pp-ai-regen-btn" title="Regenerate all sections">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
        <button class="pp-ai-icon-btn pp-ai-delete-btn" id="pp-ai-delete-btn" title="Delete this section">
          <i class="bi bi-trash3"></i>
        </button>
      </div>
      <div class="pp-ai-toolbar-right">
        <span id="pp-ai-summary-status" class="pp-ai-summary-status"></span>
        <button class="pp-notes-view-btn" id="pp-ai-view-edit">Edit</button>
        <button class="pp-notes-view-btn" id="pp-ai-view-split">Split</button>
        <button class="pp-notes-view-btn active" id="pp-ai-view-preview">Preview</button>
        <button class="btn pp-ai-save-btn" id="pp-ai-save-btn" disabled>Save</button>
      </div>
    </div>
    <div id="pp-ai-summary-panes" class="pp-notes-panes preview-only">
      <textarea id="pp-ai-textarea" style="font-family:monospace;font-size:0.85rem"></textarea>
      <div id="pp-ai-preview" class="pp-md-preview"></div>
    </div>`;

  const textarea  = container.querySelector("#pp-ai-textarea");
  const preview   = container.querySelector("#pp-ai-preview");
  const panesEl   = container.querySelector("#pp-ai-summary-panes");
  const statusEl  = container.querySelector("#pp-ai-summary-status");
  const saveBtn      = container.querySelector("#pp-ai-save-btn");
  const editBtn      = container.querySelector("#pp-ai-view-edit");
  const splitBtn     = container.querySelector("#pp-ai-view-split");
  const previewBtn   = container.querySelector("#pp-ai-view-preview");
  const openFolderBtn= container.querySelector("#pp-ai-open-folder");
  const regenBtn     = container.querySelector("#pp-ai-regen-btn");
  const deleteBtn    = container.querySelector("#pp-ai-delete-btn");

  function setStatus(msg, color) {
    statusEl.textContent = msg;
    statusEl.style.color = color ?? "";
  }

  function renderPreview() {
    const text = textarea.value || "";
    if (!text.trim()) {
      preview.innerHTML = `<div class="md-empty">Nothing to preview yet.</div>`;
      return;
    }
    if (window.marked) {
      const result = window.marked.parse(text);
      if (result && typeof result.then === "function") {
        result.then(html => { preview.innerHTML = html; renderMathInEl(preview); });
      } else {
        preview.innerHTML = result;
        renderMathInEl(preview);
      }
    } else {
      const pre = document.createElement("pre");
      pre.style.cssText = "white-space:pre-wrap;font-size:.75rem;line-height:1.85";
      pre.textContent = text;
      preview.replaceChildren(pre);
    }
  }

  // Track which file is active and whether it's been edited
  let activeFile = filenames[0];
  // Local edits buffer — keeps unsaved changes when switching tabs
  const edits = { ...files };

  function loadFile(fn) {
    activeFile = fn;
    textarea.value = edits[fn] ?? "";
    saveBtn.disabled = edits[fn] === files[fn];
    renderPreview();
    setStatus(edits[fn] !== files[fn] ? "Unsaved changes" : "", "var(--accent2)");
  }

  // Wire section tabs
  container.querySelectorAll(".pp-ai-section-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".pp-ai-section-tab")
        .forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadFile(btn.dataset.file);
    });
  });

  // View mode toggle
  function setViewMode(mode) {
    panesEl.className = "pp-notes-panes" + (mode === "edit" ? " edit-only" : mode === "preview" ? " preview-only" : "");
    editBtn.classList.toggle("active",    mode === "edit");
    splitBtn.classList.toggle("active",   mode === "split");
    previewBtn.classList.toggle("active", mode === "preview");
    if (mode !== "edit") renderPreview();
  }
  editBtn.addEventListener("click",    () => setViewMode("edit"));
  splitBtn.addEventListener("click",   () => setViewMode("split"));
  previewBtn.addEventListener("click", () => setViewMode("preview"));

  // Track edits — keep preview pane in sync if split view is active
  textarea.addEventListener("input", () => {
    edits[activeFile] = textarea.value;
    saveBtn.disabled = false;
    setStatus("Unsaved changes", "var(--accent2)");
    if (!panesEl.classList.contains("edit-only")) renderPreview();
  });

  // Save active section file
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    setStatus("Saving…", "var(--text-secondary)");
    try {
      await invoke("save_paper_md", {
        paperId:  paper.id,
        filename: activeFile,
        content:  textarea.value,
      });
      files[activeFile] = textarea.value;
      setStatus("✓ Saved — re-embedding in background", "var(--accent)");
    } catch (e) {
      saveBtn.disabled = false;
      setStatus(`✗ ${e}`, "var(--accent3)");
    }
  });

  // Open folder
  openFolderBtn.addEventListener("click", () => {
    invoke("open_paper_folder", { paperId: paper.id }).catch(e =>
      setStatus(`✗ ${e}`, "var(--accent3)")
    );
  });

  // Re-extract PDF via markitdown — runs through the serial job queue.
  regenBtn.addEventListener("click", async () => {
    regenBtn.disabled = true;
    setStatus("Queued…", "var(--text-secondary)");

    // Listen for progress so the status text and tab refresh still work
    // when this job is eventually dequeued and executed.
    const tauriListen = window.__TAURI__?.event?.listen;
    if (tauriListen) {
      let unlisten = null;
      unlisten = await tauriListen("summary://progress", async ({ payload }) => {
        if (payload?.paper_id !== paper.id) return;
        if (payload?.status === "starting") {
          setStatus("Extracting PDF…", "var(--text-secondary)");
        } else if (payload?.status === "summarizing") {
          setStatus("Generating AI summary…", "var(--text-secondary)");
        } else if (payload?.status === "done") {
          unlisten?.(); unlisten = null;
          await renderAiSummaryTab(paper);
        } else if (payload?.status === "error") {
          unlisten?.(); unlisten = null;
          setStatus(`✗ ${payload?.error ?? "unknown error"}`, "var(--accent3)");
          regenBtn.disabled = false;
        }
      });
    } else {
      regenBtn.disabled = false;
    }

    enqueueJob(paper.id, paper.title, "regenerate_paper_md");
  });

  // Delete active section file
  deleteBtn.addEventListener("click", async () => {
    if (!await pgConfirm(
      `Delete "${activeFile}"?\n\nThis cannot be undone.`,
      "Delete Section"
    )) return;
    deleteBtn.disabled = true;
    setStatus("Deleting…", "var(--text-secondary)");
    try {
      await invoke("delete_paper_md", { paperId: paper.id, filename: activeFile });
      // Re-render the whole tab so the deleted section tab disappears
      await renderAiSummaryTab(paper);
    } catch (e) {
      deleteBtn.disabled = false;
      setStatus(`✗ ${e}`, "var(--accent3)");
    }
  });

  // Load first file
  loadFile(filenames[0]);
}

// ── Wire overlay controls ─────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Configure marked once with options valid for v17+ (use() replaces deprecated
  // second-arg options passing that was removed in v9+).
  if (window.marked?.use) {
    window.marked.use({ breaks: true, gfm: true });
  }
  document.querySelectorAll(".pp-tab-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
      const p = getCurrentPaperCache();
      if (!p) return;
      if (btn.dataset.tab === "pdf")        renderPdfTab(p);
      if (btn.dataset.tab === "ai-summary") renderAiSummaryTab(p);
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