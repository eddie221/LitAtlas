"use strict";
/**
 * projects.js
 *
 * Manages the left-hand project switcher sidebar.
 *
 * Each "project" is an independent SQLite database stored at:
 *   app_data_dir/projects/<slug>/litatlas.db
 *   app_data_dir/projects/<slug>/pdfs/
 *
 * Switching a project calls the Rust `switch_project` command which
 * hot-swaps the connection pool — no restart required.
 * After switching, the graph module reloads all papers + edges.
 */

const invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  (() => { throw new Error("Tauri not found"); })
);

// pgConfirm / pgAlert — same DOM modal used in paper-page.js
// (defined here so projects.js works standalone in the bundle)
function _pgDialog(title, message, showCancel) {
  return new Promise(resolve => {
    const backdrop  = document.getElementById("pg-dialog-backdrop");
    const titleEl   = document.getElementById("pg-dialog-title");
    const msgEl     = document.getElementById("pg-dialog-message");
    const okBtn     = document.getElementById("pg-dialog-ok");
    const cancelBtn = document.getElementById("pg-dialog-cancel");
    titleEl.textContent     = title;
    msgEl.textContent       = message;
    cancelBtn.style.display = showCancel ? "" : "none";
    backdrop.classList.add("open");
    function close(r) {
      backdrop.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(r);
    }
    const onOk = () => close(true), onCancel = () => close(false);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    function onKey(e) {
      if (e.key === "Enter")  { e.preventDefault(); close(true); }
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    }
    document.addEventListener("keydown", onKey);
  });
}
const pgConfirm = (msg, title) => _pgDialog(title || "Confirm", msg, true);
const pgAlert   = (msg, title) => _pgDialog(title || "Notice",  msg, false);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const sidebar   = document.getElementById("project-sidebar");
const toggleBtn = document.getElementById("sidebar-edge-toggle");
const listEl    = document.getElementById("project-list");
const newBtn    = document.getElementById("project-new-btn");
const newInput  = document.getElementById("project-new-input");
const newConfirm= document.getElementById("project-new-confirm");
const newCancel = document.getElementById("project-new-cancel");
const newRow    = document.getElementById("project-new-row");

// ── State ─────────────────────────────────────────────────────────────────────
let _projects      = [];
let _currentSlug   = "";
let _onSwitch      = null;   // callback(slug) provided by graph.js

export function onProjectSwitch(fn) { _onSwitch = fn; }

// ── Load & render ─────────────────────────────────────────────────────────────
export async function loadProjects() {
  try {
    [_projects, _currentSlug] = await Promise.all([
      invoke("list_projects"),
      invoke("get_current_project"),
    ]);
    renderList();
  } catch (err) {
    console.error("[Projects]", err);
  }
}

function renderList() {
  listEl.innerHTML = "";
  _projects.forEach(p => {
    const item = document.createElement("div");
    item.className = "proj-item" + (p.slug === _currentSlug ? " active" : "");
    item.dataset.slug = p.slug;

    // Name label (double-click to rename)
    const nameEl = document.createElement("span");
    nameEl.className = "proj-name";
    nameEl.textContent = p.name;
    nameEl.title = "Double-click to rename";
    nameEl.addEventListener("dblclick", () => startRename(item, p));

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "proj-del";
    delBtn.textContent = "✕";
    delBtn.title = "Delete project";
    delBtn.addEventListener("click", e => { e.stopPropagation(); confirmDelete(p); });

    item.appendChild(nameEl);
    item.appendChild(delBtn);
    item.addEventListener("click", () => switchTo(p.slug));
    listEl.appendChild(item);
  });
}

// ── Switch project ────────────────────────────────────────────────────────────
async function switchTo(slug) {
  if (slug === _currentSlug) return;
  const item = listEl.querySelector(`[data-slug="${slug}"]`);
  if (item) item.classList.add("switching");
  try {
    await invoke("switch_project", { slug });
    _currentSlug = slug;
    renderList();
    if (_onSwitch) await _onSwitch(slug);
  } catch (err) {
    console.error("[Projects] switch failed:", err);
    await pgAlert(`Failed to switch project: ${err}`, "Error");
  }
}

// ── Create project ────────────────────────────────────────────────────────────
newBtn.addEventListener("click", () => {
  newRow.style.display = "flex";
  newInput.value = "";
  newInput.focus();
  newBtn.style.display = "none";
});

newCancel.addEventListener("click", cancelNew);

newConfirm.addEventListener("click", async () => {
  const name = newInput.value.trim();
  if (!name) return;
  try {
    const entry = await invoke("create_project", { name });
    _projects.push(entry);
    renderList();
    cancelNew();
    // Auto-switch to newly created project
    await switchTo(entry.slug);
  } catch (err) {
    console.error("[Projects] create failed:", err);
    await pgAlert(`Failed to create project: ${err}`, "Error");
  }
});

newInput.addEventListener("keydown", e => {
  if (e.key === "Enter") newConfirm.click();
  if (e.key === "Escape") cancelNew();
});

function cancelNew() {
  newRow.style.display = "none";
  newBtn.style.display = "flex";
}

// ── Rename project ────────────────────────────────────────────────────────────
function startRename(itemEl, project) {
  const nameEl = itemEl.querySelector(".proj-name");
  const input  = document.createElement("input");
  input.className = "proj-rename-input";
  input.value = project.name;
  nameEl.replaceWith(input);
  input.focus(); input.select();

  const commit = async () => {
    const val = input.value.trim();
    if (val && val !== project.name) {
      try {
        await invoke("rename_project", { slug: project.slug, newName: val });
        project.name = val;
        const p = _projects.find(p => p.slug === project.slug);
        if (p) p.name = val;
      } catch (err) {
        console.error("[Projects] rename failed:", err);
      }
    }
    renderList();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { renderList(); }
  });
}

// ── Delete project ────────────────────────────────────────────────────────────
async function confirmDelete(project) {
  if (_projects.length <= 1) {
    await pgAlert("Cannot delete the last project.", "Cannot Delete");
    return;
  }
  if (!await pgConfirm(`Delete project "${project.name}"?\n\nAll papers and PDFs in this project will be permanently removed.`, "Delete Project")) return;
  try {
    await invoke("delete_project", { slug: project.slug });
    _projects = _projects.filter(p => p.slug !== project.slug);
    // If deleted the current project, switch to first remaining
    if (_currentSlug === project.slug && _projects.length > 0) {
      await switchTo(_projects[0].slug);
    } else {
      renderList();
    }
  } catch (err) {
    console.error("[Projects] delete failed:", err);
    await pgAlert(`Failed to delete project: ${err}`, "Error");
  }
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
let _open = true;

toggleBtn.addEventListener("click", () => {
  _open = !_open;
  sidebar.classList.toggle("collapsed", !_open);
  document.body.classList.toggle("sidebar-collapsed", !_open);
  toggleBtn.textContent = _open ? "‹" : "›";
  toggleBtn.title       = _open ? "Collapse sidebar" : "Expand sidebar";
});