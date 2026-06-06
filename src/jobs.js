// ── Job queue for serial PDF processing ───────────────────────────────────────
// Each upload adds a job; they run one at a time so the local LLM / markitdown
// is never overloaded. Progress is tracked via "summary://progress" Tauri events.

const invoke      = window.__TAURI__?.core?.invoke;
const tauriListen = window.__TAURI__?.event?.listen;

// ── State ─────────────────────────────────────────────────────────────────────
// { id, paperId, title, status: 'waiting'|'processing'|'done'|'error', message }
const _jobs = [];
let _processing = false;

// ── Public API ────────────────────────────────────────────────────────────────
export function enqueueJob(paperId, title) {
  const job = { id: Date.now() + Math.random(), paperId, title, status: "waiting", message: "" };
  _jobs.push(job);
  _showPanel();
  _render();
  _processNext();
}

// ── Queue processor ───────────────────────────────────────────────────────────
async function _processNext() {
  if (_processing) return;
  const next = _jobs.find(j => j.status === "waiting");
  if (!next) return;

  _processing = true;
  next.status  = "processing";
  next.message = "Starting…";
  _render();

  let unlisten = null;

  try {
    // Subscribe to progress events BEFORE starting so we never miss "done".
    let resolveJob;
    const jobDone = new Promise(res => { resolveJob = res; });

    if (tauriListen) {
      unlisten = await tauriListen("summary://progress", ({ payload }) => {
        if (payload?.paper_id !== next.paperId) return;
        const s = payload?.status;
        if (s === "starting") {
          next.message = "Extracting PDF…";
        } else if (s === "summarizing") {
          next.message = "Generating AI summary…";
        } else if (s === "done") {
          next.status  = "done";
          next.message = "";
          resolveJob();
        } else if (s === "error") {
          next.status  = "error";
          next.message = payload?.error ?? "Unknown error";
          resolveJob();
        }
        _render();
      });
    }

    await invoke("embed_paper_pdf", { paperId: next.paperId });
    if (tauriListen) await jobDone;
    else { next.status = "done"; next.message = ""; }

  } catch (e) {
    next.status  = "error";
    next.message = String(e);
  }

  unlisten?.();
  _processing = false;
  _render();

  // Remove completed jobs after a short display delay, then run next.
  setTimeout(() => {
    if (next.status === "done") {
      const i = _jobs.indexOf(next);
      if (i !== -1) _jobs.splice(i, 1);
    }
    _render();
    _processNext();
  }, 3000);
}

// ── UI ────────────────────────────────────────────────────────────────────────
function _panel()  { return document.getElementById("job-panel"); }
function _btn()    { return document.getElementById("job-queue-btn"); }
function _badge()  { return document.getElementById("job-queue-badge"); }
function _list()   { return document.getElementById("job-list"); }

function _showPanel() {
  const p = _panel(), b = _btn();
  if (p) p.classList.add("visible");
  if (b) b.classList.add("has-jobs");
}

function _hidePanel() {
  const p = _panel(), b = _btn();
  if (p) p.classList.remove("visible");
  if (b) b.classList.remove("has-jobs");
}

function _render() {
  const listEl  = _list();
  const badgeEl = _badge();
  if (!listEl) return;

  const active  = _jobs.filter(j => j.status !== "done").length;
  if (badgeEl) badgeEl.textContent = active || "";

  if (!_jobs.length) {
    _hidePanel();
    return;
  }

  listEl.innerHTML = _jobs.map(j => {
    const cls  = j.status === "processing" ? "job-processing"
               : j.status === "done"       ? "job-done"
               : j.status === "error"      ? "job-error"
               :                             "job-waiting";
    const icon = j.status === "processing" ? `<span class="job-spinner"></span>`
               : j.status === "done"       ? `<i class="bi bi-check-circle-fill"></i>`
               : j.status === "error"      ? `<i class="bi bi-x-circle-fill"></i>`
               :                             `<i class="bi bi-clock"></i>`;
    const title = j.title.length > 38 ? j.title.slice(0, 36) + "…" : j.title;
    const msg   = j.message ? `<div class="job-msg">${j.message}</div>` : "";
    return `<div class="job-item ${cls}">${icon}<div class="job-info"><div class="job-title">${title}</div>${msg}</div></div>`;
  }).join("");
}

// ── Init (called once after DOM is ready) ─────────────────────────────────────
export function initJobPanel() {
  const btn   = _btn();
  const panel = _panel();

  if (btn) {
    btn.addEventListener("click", () => {
      if (panel) panel.classList.toggle("visible");
    });
  }

  const closeBtn = document.getElementById("job-panel-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (panel) panel.classList.remove("visible");
    });
  }
}
