"use strict";

// arxiv.js — arXiv discovery: modal UI + pseudo-node lifecycle.
//
// Flow:
//   1. Fetch results from arXiv (title + abstract + metadata) → render as a
//      review list inside the modal. Nothing hits the canvas yet.
//   2. User clicks "Add" on individual results (or "Add all"). For each,
//      we call `arxiv_score_abstract` — which embeds the abstract via the
//      same OpenAI embedding path a locally-uploaded PDF's abstract uses
//      — and returns the top matches against real papers.
//   3. The pseudo node is placed near its highest-scored real match and
//      linked to the top-N matches with dotted edges carrying the real
//      cosine similarity scores.

import {
  getPapersCache,
  setPseudoPapers, getPseudoPapers,
  setPseudoEdges,  getPseudoEdges,
} from "./cache.js";

const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.tauri?.invoke ?? null;

const TOP_N_EDGES_PER_PSEUDO = 3;

// Fetched-but-not-yet-added arXiv results, keyed by bare arXiv id.
let _fetched = new Map();

// Pagination state
let _pageStart = 0;         // arXiv `start` index of the current page
let _lastCount = 0;         // # results returned by the last fetch (before dedup)

// ── Modal open/close ─────────────────────────────────────────────────────────

function openModal() {
  document.getElementById("arxiv-modal")?.classList.add("open");
  document.getElementById("arxiv-modal-backdrop")?.classList.add("open");
  const dateInput = document.getElementById("arxiv-date");
  if (dateInput) {
    const today = todayISO();
    if (!dateInput.value || dateInput.value > today) dateInput.value = today;
    _refreshDateButton();
  }
}
function closeModal() {
  document.getElementById("arxiv-modal")?.classList.remove("open");
  document.getElementById("arxiv-modal-backdrop")?.classList.remove("open");
}

function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ── Fetch & render review list ───────────────────────────────────────────────

function _perPage() {
  return Math.max(1, parseInt(document.getElementById("arxiv-max")?.value, 10) || 30);
}

async function fetchAndShow() {
  _pageStart = 0;                                // reset paging on a fresh Fetch
  await runFetch();
}

async function fetchNextPage() { _pageStart += _perPage(); await runFetch(); }
async function fetchPrevPage() { _pageStart  = Math.max(0, _pageStart - _perPage()); await runFetch(); }

async function runFetch() {
  const statusEl  = document.getElementById("arxiv-modal-status");
  const fetchBtn  = document.getElementById("arxiv-fetch-btn");
  const prevBtn   = document.getElementById("arxiv-prev-btn");
  const nextBtn   = document.getElementById("arxiv-next-btn");
  const pageLabel = document.getElementById("arxiv-page-label");
  const category  = document.getElementById("arxiv-category")?.value;
  const today     = todayISO();
  let   date      = document.getElementById("arxiv-date")?.value || today;
  if (date > today) date = today;
  const max       = _perPage();

  if (!invoke) { _setStatus(statusEl, "✗ Tauri bridge unavailable", "err"); return; }
  if (!category) { _setStatus(statusEl, "✗ Pick a category", "err"); return; }

  fetchBtn.disabled = true;
  prevBtn.disabled  = nextBtn.disabled = true;
  _setStatus(statusEl, `Fetching (start=${_pageStart})…`, "");
  try {
    const results = await invoke("arxiv_fetch", { category, date, max, start: _pageStart });
    _lastCount = Array.isArray(results) ? results.length : 0;

    if (_lastCount === 0) {
      renderResults([]);
      _setStatus(statusEl, _pageStart === 0
        ? "No papers returned for that date."
        : "No more papers on this date.", "");
      pageLabel.textContent = "";
      prevBtn.disabled = _pageStart === 0;
      nextBtn.disabled = true;
      document.getElementById("arxiv-add-all-btn").disabled = true;
      return;
    }

    // Dedup against real papers (by title) and existing pseudo nodes (by id).
    const existingTitles = new Set(getPapersCache().map(p => (p.title||"").toLowerCase().trim()));
    const existingPseudo = new Set(getPseudoPapers().map(pp => pp.id));
    const filtered = results.filter(r =>
      !existingTitles.has((r.title || "").toLowerCase().trim())
      && !existingPseudo.has(`arxiv:${r.id}`)
    );
    _fetched = new Map(filtered.map(r => [r.id, r]));
    renderResults(filtered);
    _setStatus(statusEl,
      `✓ page ${Math.floor(_pageStart / max) + 1}: ${filtered.length} shown` +
      (results.length - filtered.length > 0 ? ` (${results.length - filtered.length} already in graph)` : ""),
      "ok");
    pageLabel.textContent = `#${_pageStart + 1}–${_pageStart + _lastCount}`;
    prevBtn.disabled = _pageStart === 0;
    // arXiv returned a full page → likely more available. If it returned fewer than requested, we've hit the end.
    nextBtn.disabled = _lastCount < max;
    document.getElementById("arxiv-add-all-btn").disabled = filtered.length === 0;
  } catch (e) {
    _setStatus(statusEl, `✗ ${e}`, "err");
    prevBtn.disabled = _pageStart === 0;
    nextBtn.disabled = false;
  } finally {
    fetchBtn.disabled = false;
  }
}

function renderResults(results) {
  const list = document.getElementById("arxiv-results-list");
  if (!list) return;
  list.innerHTML = "";
  for (const r of results) {
    const div = document.createElement("div");
    div.className = "arxiv-result";
    div.dataset.arxivId = r.id;
    const meta = [
      r.authors?.length ? r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? ", …" : "") : null,
      (r.published || "").slice(0, 10),
      (r.categories || []).slice(0, 3).join(", "),
    ].filter(Boolean).join(" · ");
    div.innerHTML = `
      <div class="arxiv-result-row">
        <div class="arxiv-result-title"></div>
        <button class="btn btn-new-paper arxiv-add-one">Add</button>
      </div>
      <div class="arxiv-result-meta"></div>
      <div class="arxiv-result-abs" title="Click to expand"></div>`;
    div.querySelector(".arxiv-result-title").textContent = r.title;
    div.querySelector(".arxiv-result-meta").textContent  = meta;
    const absEl = div.querySelector(".arxiv-result-abs");
    absEl.textContent = r.summary || "(no abstract)";
    absEl.addEventListener("click", () => absEl.classList.toggle("expanded"));
    div.querySelector(".arxiv-add-one").addEventListener("click", async ev => {
      ev.stopPropagation();
      await addOne(r.id, div);
    });
    list.appendChild(div);
  }
}

// ── Add: embed abstract, score against real papers, drop pseudo node ─────────

async function addOne(arxivId, rowEl) {
  const paper = _fetched.get(arxivId);
  if (!paper || !invoke) return;
  const btn = rowEl?.querySelector(".arxiv-add-one");
  const statusEl = document.getElementById("arxiv-modal-status");
  if (btn) { btn.disabled = true; btn.textContent = "Embedding…"; }

  try {
    const matches = await invoke("arxiv_score_abstract", { abstract: paper.summary || paper.title });
    dropPseudoNode(paper, matches);
    if (rowEl) rowEl.classList.add("added");
    if (btn) btn.textContent = "Added";
    _setStatus(statusEl, `✓ Added "${_short(paper.title)}"`, "ok");
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Add"; }
    _setStatus(statusEl, `✗ ${e}`, "err");
  }
}

async function addAll() {
  const btn = document.getElementById("arxiv-add-all-btn");
  const statusEl = document.getElementById("arxiv-modal-status");
  btn.disabled = true;
  const rows = document.querySelectorAll(".arxiv-result:not(.added)");
  let ok = 0, fail = 0;
  for (const row of rows) {
    const id = row.dataset.arxivId;
    _setStatus(statusEl, `Embedding ${ok+fail+1}/${rows.length}…`, "");
    try { await addOne(id, row); ok++; }
    catch { fail++; }
  }
  _setStatus(statusEl, `✓ Added ${ok}${fail ? ` · ✗ ${fail} failed` : ""}`, ok ? "ok" : "err");
}

function dropPseudoNode(paper, matches) {
  const real = getPapersCache();
  const matchLookup = new Map(matches.map(m => [Number(m.paper_id), Number(m.similarity)]));
  const scored = matches
    .map(m => ({ p: real.find(x => x.id === Number(m.paper_id)), sim: Number(m.similarity) }))
    .filter(x => x.p)
    .slice(0, TOP_N_EDGES_PER_PSEUDO);

  const anchor = scored[0]?.p ?? real[Math.floor(Math.random() * real.length)] ?? { x: 0, y: 0 };
  const angle = Math.random() * Math.PI * 2;
  const { x, y } = { x: (anchor.x ?? 0) + Math.cos(angle) * 80,
                     y: (anchor.y ?? 0) + Math.sin(angle) * 80 };

  const pseudoId = `arxiv:${paper.id}`;
  const node = {
    id:        pseudoId,
    title:     paper.title,
    authors:   paper.authors || [],
    year:      (paper.published || "").slice(0, 4),
    venue:     paper.categories?.[0] ?? "arXiv",
    hashtags:  paper.categories || [],
    summary:   paper.summary,
    abs_url:   paper.abs_url,
    pdf_url:   paper.pdf_url,
    published: paper.published,
    isPseudo:  true,
    x, y, vx: 0, vy: 0,
    radius: 18,
  };
  const newEdges = scored.map(({ p, sim }) => ({
    source_id: p.id, target_id: pseudoId, similarity: sim, isPseudo: true,
  }));

  setPseudoPapers([...getPseudoPapers(), node]);
  setPseudoEdges ([...getPseudoEdges(),  ...newEdges]);
  window.LitAtlas?.applyPseudoNodes?.();
}

function clearPseudo() {
  setPseudoPapers([]);
  setPseudoEdges([]);
  window.LitAtlas?.applyPseudoNodes?.();
  _setStatus(document.getElementById("arxiv-modal-status"), "Pseudo nodes cleared", "");
  // Un-mark rows that were added.
  document.querySelectorAll(".arxiv-result.added").forEach(row => {
    row.classList.remove("added");
    const btn = row.querySelector(".arxiv-add-one");
    if (btn) { btn.disabled = false; btn.textContent = "Add"; }
  });
}

// ── Popover (per-pseudo abstract + import) ───────────────────────────────────

let _activePseudo = null;

function openPseudoPopover(node) {
  _activePseudo = node;
  const pop = document.getElementById("arxiv-popover");
  if (!pop) return;
  document.getElementById("arxiv-pop-title").textContent = node.title;
  const meta = [
    node.authors?.length ? node.authors.slice(0, 4).join(", ") + (node.authors.length > 4 ? ", …" : "") : null,
    (node.published || "").slice(0, 10),
    (node.hashtags || []).slice(0, 3).join(", "),
  ].filter(Boolean).join(" · ");
  document.getElementById("arxiv-pop-meta").textContent = meta;
  document.getElementById("arxiv-pop-summary").textContent = node.summary || "(no abstract)";
  const link = document.getElementById("arxiv-pop-link");
  if (link) link.href = node.abs_url || "#";
  const statusEl = document.getElementById("arxiv-pop-status");
  if (statusEl) { statusEl.textContent = ""; statusEl.className = "arxiv-modal-status"; }
  pop.classList.add("open");
}

function closePopover() {
  document.getElementById("arxiv-popover")?.classList.remove("open");
  _activePseudo = null;
}

async function importActive() {
  const node = _activePseudo;
  if (!node || !invoke) return;
  const statusEl = document.getElementById("arxiv-pop-status");
  const importBtn = document.getElementById("arxiv-pop-import");
  importBtn.disabled = true;
  _setStatus(statusEl, "Adding paper…", "");

  try {
    const yearNum = parseInt((node.published || "").slice(0, 4), 10) || new Date().getFullYear();
    const newPaper = {
      title:    node.title,
      authors:  node.authors || [],
      venue:    node.venue || "arXiv",
      year:     yearNum,
      hashtags: (node.hashtags || []).map(t => t.startsWith("#") ? t : `#${t}`),
      attributes: [
        { key: "abstract", value: node.summary || "", order: 0 },
        { key: "arxiv_id", value: node.id.replace(/^arxiv:/, ""), order: 1 },
        { key: "arxiv_url", value: node.abs_url || "", order: 2 },
      ],
    };
    const newId = await invoke("add_paper", { paper: newPaper });

    _setStatus(statusEl, "Downloading PDF…", "");
    const b64 = await invoke("arxiv_download_pdf", { url: node.pdf_url });
    const filename = `${node.id.replace(/^arxiv:/, "")}.pdf`;
    await invoke("store_pdf_bytes", { paperId: newId, filename, dataBase64: b64 });

    _setStatus(statusEl, "✓ Imported — reloading graph", "ok");

    const remaining = getPseudoPapers().filter(p => p.id !== node.id);
    setPseudoPapers(remaining);
    setPseudoEdges(getPseudoEdges().filter(e => e.target_id !== node.id));

    await window.LitAtlas?.reloadGraph?.();
    window.LitAtlas?.applyPseudoNodes?.();
    setTimeout(closePopover, 600);
  } catch (e) {
    _setStatus(statusEl, `✗ ${e}`, "err");
  } finally {
    importBtn.disabled = false;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function _setStatus(el, msg, type) {
  if (!el) return;
  el.textContent = msg;
  el.className = `arxiv-modal-status ${type || ""}`.trim();
}

function _short(s, n = 48) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── DOM wiring ───────────────────────────────────────────────────────────────

// ── Custom calendar popover ──────────────────────────────────────────────────

let _calCursor = null;   // Date pointing at the first day of the month shown

function _refreshDateButton() {
  const btn = document.getElementById("arxiv-date-btn");
  const val = document.getElementById("arxiv-date")?.value;
  if (btn && val) {
    const d = new Date(val + "T00:00:00");
    btn.textContent = d.toLocaleDateString(undefined,
      { year: "numeric", month: "short", day: "numeric" });
  }
}

function openCalendar() {
  const pop = document.getElementById("arxiv-cal-popover");
  if (!pop) return;
  const val = document.getElementById("arxiv-date")?.value || todayISO();
  const [y, m] = val.split("-").map(Number);
  _calCursor = new Date(y, m - 1, 1);
  renderCalendar();
  pop.classList.add("open");
  document.getElementById("arxiv-cal-backdrop")?.classList.add("open");
}
function closeCalendar() {
  document.getElementById("arxiv-cal-popover")?.classList.remove("open");
  document.getElementById("arxiv-cal-backdrop")?.classList.remove("open");
}

function renderCalendar() {
  const grid  = document.getElementById("arxiv-cal-grid");
  const title = document.getElementById("arxiv-cal-title");
  const nextBtn = document.getElementById("arxiv-cal-next");
  if (!grid || !title || !_calCursor) return;

  title.textContent = _calCursor.toLocaleDateString(undefined,
    { month: "long", year: "numeric" });

  const today = new Date(); today.setHours(0,0,0,0);
  const todayStr = todayISO();
  const selectedStr = document.getElementById("arxiv-date")?.value;

  // Disable "next month" if the next month is entirely in the future.
  const nextMonthStart = new Date(_calCursor.getFullYear(), _calCursor.getMonth() + 1, 1);
  nextBtn.disabled = nextMonthStart > today;

  const monthStart = _calCursor;
  const firstDow   = monthStart.getDay();          // 0=Sun
  const daysInMonth = new Date(_calCursor.getFullYear(), _calCursor.getMonth() + 1, 0).getDate();
  const prevMonthDays = new Date(_calCursor.getFullYear(), _calCursor.getMonth(), 0).getDate();

  grid.innerHTML = "";
  // Leading days from previous month
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const cell = _makeDayCell(_calCursor.getFullYear(), _calCursor.getMonth() - 1, d, true, todayStr, selectedStr, today);
    grid.appendChild(cell);
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = _makeDayCell(_calCursor.getFullYear(), _calCursor.getMonth(), d, false, todayStr, selectedStr, today);
    grid.appendChild(cell);
  }
  // Trailing days: pad to 6 rows = 42 cells
  const total = firstDow + daysInMonth;
  const trailing = (7 - (total % 7)) % 7;
  for (let d = 1; d <= trailing; d++) {
    const cell = _makeDayCell(_calCursor.getFullYear(), _calCursor.getMonth() + 1, d, true, todayStr, selectedStr, today);
    grid.appendChild(cell);
  }
}

function _makeDayCell(year, month, day, otherMonth, todayStr, selectedStr, todayDate) {
  const dt   = new Date(year, month, day);
  const iso  = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "arxiv-cal-day";
  if (otherMonth)       cell.classList.add("other-month");
  if (iso === todayStr) cell.classList.add("today");
  if (iso === selectedStr) cell.classList.add("selected");
  if (dt > todayDate)   cell.classList.add("disabled");
  cell.textContent = String(day);
  cell.addEventListener("click", ev => {
    ev.stopPropagation();
    if (cell.classList.contains("disabled")) return;
    const hidden = document.getElementById("arxiv-date");
    if (hidden) hidden.value = iso;
    _refreshDateButton();
    closeCalendar();
  });
  return cell;
}

function _shiftMonth(delta) {
  if (!_calCursor) return;
  _calCursor = new Date(_calCursor.getFullYear(), _calCursor.getMonth() + delta, 1);
  renderCalendar();
}

// ── DOM wiring ───────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-arxiv-discover")?.addEventListener("click", openModal);
  document.getElementById("arxiv-modal-close")?.addEventListener("click", closeModal);
  document.getElementById("arxiv-modal-backdrop")?.addEventListener("click", closeModal);
  document.getElementById("arxiv-fetch-btn")?.addEventListener("click", fetchAndShow);
  document.getElementById("arxiv-prev-btn")?.addEventListener("click", fetchPrevPage);
  document.getElementById("arxiv-next-btn")?.addEventListener("click", fetchNextPage);
  document.getElementById("arxiv-add-all-btn")?.addEventListener("click", addAll);
  document.getElementById("arxiv-clear-btn")?.addEventListener("click", clearPseudo);
  document.getElementById("arxiv-pop-close")?.addEventListener("click", closePopover);
  document.getElementById("arxiv-pop-import")?.addEventListener("click", importActive);

  // Custom calendar
  document.getElementById("arxiv-date-btn")?.addEventListener("click", ev => {
    ev.stopPropagation();
    const pop = document.getElementById("arxiv-cal-popover");
    if (pop?.classList.contains("open")) closeCalendar(); else openCalendar();
  });
  document.getElementById("arxiv-cal-prev")?.addEventListener("click", () => _shiftMonth(-1));
  document.getElementById("arxiv-cal-next")?.addEventListener("click", () => _shiftMonth(+1));
  document.getElementById("arxiv-cal-close")?.addEventListener("click", closeCalendar);
  document.getElementById("arxiv-cal-backdrop")?.addEventListener("click", closeCalendar);

  if (window.LitAtlas) {
    window.LitAtlas.openPseudoPopover = openPseudoPopover;
  } else {
    setTimeout(() => {
      if (window.LitAtlas) window.LitAtlas.openPseudoPopover = openPseudoPopover;
    }, 50);
  }
});
