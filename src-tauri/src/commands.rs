// src-tauri/src/commands.rs

use tauri::Manager;
use tauri::State;
use crate::AppState;
use crate::logger;
use crate::db::{
    self, EdgeInput, NewPaper, NewRelation,
    PaperFull, EdgeRow, HashtagRow, RelationRow, PaperAttribute,
};

type CmdResult<T> = Result<T, String>;

// ── Logging helper ────────────────────────────────────────────────────────────
//
// map_log_err!(fn_name) converts a Result's Err branch to String while also
// emitting a logger::log_error entry.  Use in place of .map_err(String::from):
//
//   db::get_all_papers(&pool).await.map_err(map_log_err!("get_papers"))
//
// A macro is used so the closure input type is inferred from context —
// avoids nested `impl Trait` and type mismatches with DB error types.
macro_rules! map_log_err {
    ($fn_name:expr) => {
        |e| {
            let msg = e.to_string();
            logger::log_error($fn_name, &msg);
            msg
        }
    };
}

// ── Papers ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_papers(s: State<'_, AppState>) -> CmdResult<Vec<PaperFull>> {
    logger::log_call("get_papers");
    db::get_all_papers(&s.pool()).await.map_err(map_log_err!("get_papers"))
}

#[tauri::command]
pub async fn get_paper(s: State<'_, AppState>, id: i64) -> CmdResult<PaperFull> {
    logger::log_call("get_paper");
    db::get_paper(&s.pool(), id).await.map_err(map_log_err!("get_paper"))
}

#[tauri::command]
pub async fn add_paper(s: State<'_, AppState>, paper: NewPaper) -> CmdResult<i64> {
    logger::log_call("add_paper");
    db::insert_paper(&s.pool(), paper).await.map_err(map_log_err!("add_paper"))
}

#[tauri::command]
pub async fn delete_paper(s: State<'_, AppState>, id: i64) -> CmdResult<()> {
    logger::log_call("delete_paper");
    db::delete_paper(&s.pool(), id).await.map_err(map_log_err!("delete_paper"))?;

    // ── Delete associated files ───────────────────────────────────────────
    // 1. PDF directory: projects/<slug>/pdfs/<id>/
    //    Contains the PDF file and possibly embedding.json (primary location).
    let pdf_dir = s.pdfs_dir().join(id.to_string());
    if pdf_dir.exists() {
        let _ = std::fs::remove_dir_all(&pdf_dir);
    }

    // 2. Fallback embedding: projects/<slug>/embeddings/<id>.json
    //    Written when no PDF dir exists at embedding-compute time.
    let fallback_embedding = s.projects_dir
        .join(s.current_slug())
        .join("embeddings")
        .join(format!("{id}.json"));
    if fallback_embedding.exists() {
        let _ = std::fs::remove_file(&fallback_embedding);
    }

    Ok(())
}

// ── Core fields ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn update_paper_core(
    s: State<'_, AppState>, id: i64,
    title: Option<String>, venue: Option<String>, year: Option<i64>,
) -> CmdResult<()> {
    logger::log_call("update_paper_core");
    db::update_paper_core(&s.pool(), id, title, venue, year)
        .await.map_err(map_log_err!("update_paper_core"))
}

#[tauri::command]
pub async fn save_notes(s: State<'_, AppState>, id: i64, notes: String) -> CmdResult<()> {
    logger::log_call("save_notes");
    db::save_notes(&s.pool(), id, &notes).await.map_err(map_log_err!("save_notes"))
}

#[tauri::command]
pub async fn save_pdf_path(s: State<'_, AppState>, id: i64, path: Option<String>) -> CmdResult<()> {
    logger::log_call("save_pdf_path");
    db::save_pdf_path(&s.pool(), id, path.as_deref()).await.map_err(map_log_err!("save_pdf_path"))
}

/// Remove the PDF file from disk and clear its path in the DB.
/// Deletes the entire per-paper PDF directory (projects/<slug>/pdfs/<id>/)
/// which also removes any cached embedding.json stored alongside the PDF.
/// Silently succeeds if no file exists — the DB path is always cleared.
#[tauri::command]
pub async fn delete_pdf_file(s: State<'_, AppState>, id: i64) -> CmdResult<()> {
    logger::log_call("delete_pdf_file");
    // 1. Clear the DB record first so the paper is never left pointing at a
    //    deleted file even if the filesystem removal fails.
    db::save_pdf_path(&s.pool(), id, None).await.map_err(map_log_err!("delete_pdf_file"))?;

    // 2. Remove the per-paper PDF directory.
    let pdf_dir = s.pdfs_dir().join(id.to_string());
    if pdf_dir.exists() {
        std::fs::remove_dir_all(&pdf_dir)
            .map_err(|e| format!("Failed to delete PDF directory: {e}"))?;
    }

    Ok(())
}

// ── Authors ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_authors(s: State<'_, AppState>, id: i64, authors: Vec<String>) -> CmdResult<()> {
    logger::log_call("set_authors");
    db::set_authors(&s.pool(), id, &authors).await.map_err(map_log_err!("set_authors"))
}

// ── Hashtags ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_hashtags(s: State<'_, AppState>) -> CmdResult<Vec<HashtagRow>> {
    logger::log_call("get_hashtags");
    db::get_all_hashtags(&s.pool()).await.map_err(map_log_err!("get_hashtags"))
}

#[tauri::command]
pub async fn set_tags(s: State<'_, AppState>, id: i64, tags: Vec<String>) -> CmdResult<()> {
    logger::log_call("set_tags");
    db::set_tags(&s.pool(), id, &tags).await.map_err(map_log_err!("set_tags"))
}

// ── Custom attributes ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_attributes(
    s: State<'_, AppState>, id: i64, attributes: Vec<PaperAttribute>,
) -> CmdResult<()> {
    logger::log_call("set_attributes");
    db::set_attributes(&s.pool(), id, &attributes).await.map_err(map_log_err!("set_attributes"))
}

#[tauri::command]
pub async fn upsert_attribute(
    s: State<'_, AppState>, id: i64, key: String, value: String, order: i64,
) -> CmdResult<()> {
    logger::log_call("upsert_attribute");
    db::upsert_attribute(&s.pool(), id, &key, &value, order)
        .await.map_err(map_log_err!("upsert_attribute"))
}

#[tauri::command]
pub async fn delete_attribute(s: State<'_, AppState>, id: i64, key: String) -> CmdResult<()> {
    logger::log_call("delete_attribute");
    db::delete_attribute(&s.pool(), id, &key).await.map_err(map_log_err!("delete_attribute"))
}

// ── Relations ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_relations(s: State<'_, AppState>, id: i64) -> CmdResult<Vec<RelationRow>> {
    logger::log_call("get_relations");
    db::get_relations_for_paper(&s.pool(), id).await.map_err(map_log_err!("get_relations"))
}

#[tauri::command]
pub async fn get_all_relations(s: State<'_, AppState>) -> CmdResult<Vec<RelationRow>> {
    logger::log_call("get_all_relations");
    db::get_all_relations(&s.pool()).await.map_err(map_log_err!("get_all_relations"))
}

#[tauri::command]
pub async fn add_relation(s: State<'_, AppState>, relation: NewRelation) -> CmdResult<i64> {
    logger::log_call("add_relation");
    db::add_relation(&s.pool(), relation).await.map_err(map_log_err!("add_relation"))
}

#[tauri::command]
pub async fn update_relation_note(
    s: State<'_, AppState>, id: i64, note: Option<String>,
) -> CmdResult<()> {
    logger::log_call("update_relation_note");
    db::update_relation_note(&s.pool(), id, note).await.map_err(map_log_err!("update_relation_note"))
}

#[tauri::command]
pub async fn delete_relation(s: State<'_, AppState>, id: i64) -> CmdResult<()> {
    logger::log_call("delete_relation");
    db::delete_relation(&s.pool(), id).await.map_err(map_log_err!("delete_relation"))
}

// ── Similarity edges ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_edges(s: State<'_, AppState>) -> CmdResult<Vec<EdgeRow>> {
    logger::log_call("get_edges");
    db::get_all_edges(&s.pool()).await.map_err(map_log_err!("get_edges"))
}

/// Return only the edges for one strategy engine ("js-cosine" or "hf-embeddings").
/// Called by graph.js on load and on every strategy switch so the canvas shows
/// only the active mode's edges without touching or recomputing the other set.
#[tauri::command]
pub async fn get_edges_by_source(
    s: State<'_, AppState>,
    source_type: String,
) -> CmdResult<Vec<EdgeRow>> {
    logger::log_call("get_edges_by_source");
    db::get_edges_by_source(&s.pool(), &source_type)
        .await.map_err(map_log_err!("get_edges_by_source"))
}

#[tauri::command]
pub async fn recompute_edges(s: State<'_, AppState>, edges: Vec<EdgeInput>) -> CmdResult<usize> {
    logger::log_call("recompute_edges");
    db::replace_all_edges(&s.pool(), edges).await.map_err(map_log_err!("recompute_edges"))
}

#[tauri::command]
pub async fn append_edges(s: State<'_, AppState>, edges: Vec<EdgeInput>) -> CmdResult<usize> {
    logger::log_call("append_edges");
    db::append_edges(&s.pool(), edges).await.map_err(map_log_err!("append_edges"))
}

/// Replace only the edges produced by a specific strategy engine, leaving all
/// edges from the other engine intact.
///
/// `source_type` must be either `"js-cosine"` or `"hf-embeddings"`.
/// All entries in `edges` are expected to carry the same `source_type`.
#[tauri::command]
pub async fn replace_edges_by_source(
    s: State<'_, AppState>,
    source_type: String,
    edges: Vec<EdgeInput>,
) -> CmdResult<usize> {
    logger::log_call("replace_edges_by_source");
    db::replace_edges_by_source(&s.pool(), &source_type, edges)
        .await.map_err(map_log_err!("replace_edges_by_source"))
}

// ── PDF storage ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn store_pdf_bytes(
    s:           State<'_, AppState>,
    paper_id:    i64,
    filename:    String,
    data_base64: String,
) -> CmdResult<String> {
    logger::log_call("store_pdf_bytes");
    use std::io::Write;
    let bytes = base64_decode(&data_base64)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("paper-{paper_id}.pdf"));
    let dest_dir = s.pdfs_dir().join(paper_id.to_string());
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create pdf dir: {e}"))?;
    let dest = dest_dir.join(&safe_name);
    let mut f = std::fs::File::create(&dest)
        .map_err(|e| format!("Failed to create file: {e}"))?;
    f.write_all(&bytes)
        .map_err(|e| format!("Failed to write PDF: {e}"))?;
    db::save_pdf_path(&s.pool(), paper_id, Some(&dest.to_string_lossy()))
        .await.map_err(map_log_err!("store_pdf_bytes"))?;
    Ok(dest.to_string_lossy().to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let b64 = if let Some(idx) = input.find("base64,") { &input[idx + 7..] } else { input };
    const TABLE: [i8; 256] = {
        let mut t = [-1i8; 256];
        let enc = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0usize;
        while i < enc.len() { t[enc[i] as usize] = i as i8; i += 1; }
        t
    };
    let bytes = b64.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for &b in bytes {
        if b == b'=' { break; }
        if b == b'\n' || b == b'\r' || b == b' ' { continue; }
        let v = TABLE[b as usize];
        if v < 0 { return Err(format!("Invalid base64 byte: {b}")); }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); }
    }
    Ok(out)
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n  = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[((n >>  6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[( n        & 63) as usize] as char } else { '=' });
    }
    out
}

#[tauri::command]
pub async fn copy_pdf(
    s: State<'_, AppState>, paper_id: i64, src_path: String,
) -> CmdResult<String> {
    logger::log_call("copy_pdf");
    let src = std::path::Path::new(&src_path);
    if !src.exists() {
        return Err(format!(
            "Source file not found: \"{src_path}\". \
             Use store_pdf_bytes to upload from a browser file picker."
        ));
    }
    let filename = src.file_name().ok_or("Invalid source path")?
        .to_string_lossy().to_string();
    let dest_dir = s.pdfs_dir().join(paper_id.to_string());
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create pdf dir: {e}"))?;
    let dest = dest_dir.join(&filename);
    std::fs::copy(src, &dest).map_err(|e| format!("Failed to copy PDF: {e}"))?;
    db::save_pdf_path(&s.pool(), paper_id, Some(&dest.to_string_lossy()))
        .await.map_err(map_log_err!("store_pdf_bytes"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_pdf_url(s: State<'_, AppState>, paper_id: i64) -> CmdResult<String> {
    logger::log_call("get_pdf_url");
    let paper = db::get_paper(&s.pool(), paper_id).await.map_err(map_log_err!("get_pdf_url"))?;
    Ok(paper.pdf_path.unwrap_or_default())
}

#[tauri::command]
pub async fn read_pdf_bytes(s: State<'_, AppState>, paper_id: i64) -> CmdResult<String> {
    logger::log_call("read_pdf_bytes");
    let paper = db::get_paper(&s.pool(), paper_id).await.map_err(map_log_err!("read_pdf_bytes"))?;
    let path  = paper.pdf_path.ok_or("No PDF stored for this paper")?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Cannot read PDF at \"{path}\": {e}"))?;
    Ok(base64_encode(&bytes))
}

// ── Project management ────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ProjectEntry {
    pub id:         String,
    pub name:       String,
    pub slug:       String,
    pub created_at: u64,
}

fn read_projects(s: &AppState) -> Vec<ProjectEntry> {
    let raw = std::fs::read_to_string(s.projects_json()).unwrap_or("[]".into());
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_projects(s: &AppState, list: &[ProjectEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(s.projects_json(), json).map_err(|e| e.to_string())
}

fn slugify(name: &str) -> String {
    let s: String = name.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let mut out = String::new();
    let mut prev = ' ';
    for c in s.chars() {
        if c == '-' && prev == '-' { continue; }
        out.push(c); prev = c;
    }
    out.trim_matches('-').to_string()
}

#[tauri::command]
pub fn list_projects(s: State<'_, AppState>) -> CmdResult<Vec<ProjectEntry>> {
    logger::log_call("list_projects");
    Ok(read_projects(&s))
}

#[tauri::command]
pub fn get_current_project(s: State<'_, AppState>) -> CmdResult<String> {
    logger::log_call("get_current_project");
    Ok(s.current_slug())
}

#[tauri::command]
pub fn create_project(s: State<'_, AppState>, name: String) -> CmdResult<ProjectEntry> {
    logger::log_call("create_project");
    let mut projects = read_projects(&s);
    let base_slug = slugify(&name);
    let mut slug = base_slug.clone();
    let mut n = 2;
    while projects.iter().any(|p| p.slug == slug) {
        slug = format!("{base_slug}-{n}"); n += 1;
    }
    let entry = ProjectEntry {
        id:         slug.clone(),
        name,
        slug:       slug.clone(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
    };
    crate::open_project(&s.projects_dir, &slug);
    projects.push(entry.clone());
    write_projects(&s, &projects)?;
    Ok(entry)
}

#[tauri::command]
pub fn rename_project(s: State<'_, AppState>, slug: String, new_name: String) -> CmdResult<()> {
    logger::log_call("rename_project");
    let mut projects = read_projects(&s);
    if let Some(p) = projects.iter_mut().find(|p| p.slug == slug) {
        p.name = new_name;
    } else {
        logger::log_error("rename_project", "Project '{slug}' not found");
        return Err(format!("Project '{slug}' not found"));
    }
    write_projects(&s, &projects)
}

#[tauri::command]
pub fn delete_project(s: State<'_, AppState>, slug: String) -> CmdResult<()> {
    logger::log_call("delete_project");
    let mut projects = read_projects(&s);
    logger::log_error("delete_project", "Cannot delete the last project");
    if projects.len() <= 1 { return Err("Cannot delete the last project".into()); }
    projects.retain(|p| p.slug != slug);
    let _ = std::fs::remove_dir_all(s.projects_dir.join(&slug));
    write_projects(&s, &projects)
}

#[tauri::command]
pub fn switch_project(s: State<'_, AppState>, slug: String) -> CmdResult<()> {
    logger::log_call("switch_project");
    let projects = read_projects(&s);
    if !projects.iter().any(|p| p.slug == slug) {
        logger::log_error("switch_project", "Project '{slug}' not found");
        return Err(format!("Project '{slug}' not found"));
    }
    let new_pool = crate::open_project(&s.projects_dir, &slug);
    *s.pool.lock().unwrap()         = new_pool;
    *s.current_slug.lock().unwrap() = slug;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════════
// PYTHON SIDECAR — HuggingFace similarity
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Python process is spawned lazily on the first hf_* command and kept alive
// for the lifetime of the app.  Subsequent calls reuse the warm process so the
// model stays loaded in RAM.
//
// Wire protocol: newline-delimited JSON over stdin/stdout.
//
//   Request  → { "id": u64, "method": str, "params": any }
//   Success  ← { "id": u64, "ok": true,  "result": any  }
//   Failure  ← { "id": u64, "ok": false, "error":  str  }
//
// JS is completely unaware of Python; it calls invoke("hf_compute_similarity").

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Owns the live Python child process.
pub struct PySidecar {
    child:   Child,
    stdin:   ChildStdin,
    stdout:  BufReader<ChildStdout>,
    next_id: u64,
}

impl PySidecar {
    /// Send one JSON-RPC call and wait for the response.
    fn call(&mut self, method: &str, params: serde_json::Value)
        -> Result<serde_json::Value, String>
    {
        let id = self.next_id;
        self.next_id += 1;

        let mut req = serde_json::json!({
            "id": id, "method": method, "params": params
        }).to_string();
        req.push('\n');

        self.stdin.write_all(req.as_bytes())
            .map_err(|e| format!("sidecar write: {e}"))?;
        self.stdin.flush()
            .map_err(|e| format!("sidecar flush: {e}"))?;

        let mut line = String::new();
        self.stdout.read_line(&mut line)
            .map_err(|e| format!("sidecar read: {e}"))?;

        let v: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("sidecar parse: {e} — got: {line}"))?;

        if v["ok"].as_bool() != Some(true) {
            return Err(v["error"].as_str().unwrap_or("unknown error").to_string());
        }
        Ok(v["result"].clone())
    }

    fn is_alive(&mut self) -> bool {
        self.child.try_wait().map(|r| r.is_none()).unwrap_or(false)
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

use tauri::Emitter;

fn emit_progress(app: &tauri::AppHandle, step: &str, detail: &str, done: bool) {
    let _ = app.emit("venv://progress", serde_json::json!({
        "step":   step,
        "detail": detail,
        "done":   done,
    }));
}

/// Emit a pip install log line in real time.
/// Fires "venv://pip-log" with { line: str } so the frontend can stream it.
fn emit_pip_log(app: &tauri::AppHandle, line: &str) {
    let _ = app.emit("venv://pip-log", serde_json::json!({ "line": line }));
}

fn venv_python(venv_dir: &std::path::Path) -> std::path::PathBuf {
    if cfg!(target_os = "windows") {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    }
}

fn venv_pip(venv_dir: &std::path::Path) -> std::path::PathBuf {
    if cfg!(target_os = "windows") {
        venv_dir.join("Scripts").join("pip.exe")
    } else {
        venv_dir.join("bin").join("pip")
    }
}

// ── Process 1 of 5 : find a system Python 3.8+ ───────────────────────────────
//
// Scans well-known binary names on PATH, skipping any that resolve inside an
// active conda or venv prefix (those would break isolation).
// Emits granular status so the UI can show which candidate is being tried.
fn step_find_python(app: &tauri::AppHandle) -> Result<String, String> {
    let conda_prefix = std::env::var("CONDA_PREFIX").unwrap_or_default();
    let venv_prefix  = std::env::var("VIRTUAL_ENV").unwrap_or_default();

    emit_progress(app, "find_python", "Scanning PATH for Python 3.8+…", false);

    let candidates = [
        "python3.13","python3.12","python3.11",
        "python3.10","python3.9","python3.8",
        "python3","python",
    ];

    for &bin in &candidates {
        emit_progress(app, "find_python", &format!("Trying {bin}…"), false);

        let exe_out = Command::new(bin)
            .args(["-c", "import sys; print(sys.executable)"])
            .stdout(Stdio::piped()).stderr(Stdio::null()).output();

        let exe_path = match exe_out {
            Ok(o) if o.status.success() =>
                String::from_utf8_lossy(&o.stdout).trim().to_string(),
            _ => continue,   // binary not on PATH
        };

        if !conda_prefix.is_empty() && exe_path.starts_with(&conda_prefix) {
            eprintln!("[LitAtlas] Skipping {bin} — inside conda: {exe_path}");
            emit_progress(app, "find_python",
                &format!("Skipped {bin} (conda env — needs isolation)"), false);
            continue;
        }
        if !venv_prefix.is_empty() && exe_path.starts_with(&venv_prefix) {
            eprintln!("[LitAtlas] Skipping {bin} — inside venv: {exe_path}");
            emit_progress(app, "find_python",
                &format!("Skipped {bin} (active venv — needs isolation)"), false);
            continue;
        }

        let ver_ok = Command::new(bin)
            .args(["-c",
                "import sys; v=sys.version_info; \
                 assert v.major==3 and v.minor>=8, \
                 f'need 3.8+, got {v.major}.{v.minor}'"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false);

        if ver_ok {
            emit_progress(app, "find_python",
                &format!("Found {bin} → {exe_path}"), false);
            eprintln!("[LitAtlas] Using Python: {exe_path}");
            return Ok(bin.to_string());
        }
    }

    Err("Python 3.8+ not found on PATH (every candidate was either missing or \
         inside an active conda / venv environment).\n\
         Install Python 3 from https://python.org and restart LitAtlas.".into())
}

// ── Process 2 of 5 : create isolated venv ────────────────────────────────────
//
// Runs `<system_python> -m venv --clear <venv_dir>`.
// Skipped if the venv binary already exists (idempotent on subsequent launches).
fn step_create_venv(
    venv_dir:  &std::path::Path,
    system_py: &str,
    app:       &tauri::AppHandle,
) -> Result<(), String> {
    let py_bin = venv_python(venv_dir);

    if py_bin.exists() {
        emit_progress(app, "create_venv", "Existing environment found — skipping creation", false);
        return Ok(());
    }

    emit_progress(app, "create_venv",
        &format!("Creating venv at {}", venv_dir.display()), false);

    // println!("system_py : {}", system_py);    
    // println!("venv_dir : {}", venv_dir.display());
    let status = Command::new(system_py)
        .args(["-m", "venv", "--clear"])
        .arg(venv_dir)
        .status()
        .map_err(|e| format!("Failed to spawn venv process: {e}"))?;

    if !status.success() {
        return Err(format!(
            "Could not create venv at '{}'.\n\
             On Debian/Ubuntu you may need: sudo apt install python3-venv\n\
             On Fedora/RHEL: sudo dnf install python3-virtualenv",
            venv_dir.display()));
    }

    emit_progress(app, "create_venv",
        &format!("Venv created at {}", venv_dir.display()), false);
    Ok(())
}

// ── Process 3 of 5 : verify the venv is self-contained ───────────────────────
//
// Queries `sys.prefix` inside the venv Python and canonically compares it to
// venv_dir.  Catches the rare case where the binary exists but points elsewhere
// (e.g. a broken symlink left over from a partial install).
fn step_verify_venv(
    venv_dir: &std::path::Path,
    app:      &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    let py_bin = venv_python(venv_dir);
    
    emit_progress(app, "verify_venv",
        "Verifying venv isolation (sys.prefix check)…", false);

    let out = Command::new(&py_bin)
        .args(["-c", "import sys; print(sys.prefix)"])
        .stdout(Stdio::piped()).stderr(Stdio::null()).output()
        .map_err(|e| format!("Cannot query venv sys.prefix: {e}"))?;

    let reported_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let expected = venv_dir.canonicalize().unwrap_or_else(|_| venv_dir.to_path_buf());
    let reported = std::path::Path::new(&reported_str)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&reported_str));

    if reported != expected {
        return Err(format!(
            "Venv sanity check failed — prefix mismatch.\n\
             Expected : {}\n\
             Got      : {}\n\n\
             Delete '{}' and restart to recreate it.",
            expected.display(), reported.display(), venv_dir.display()));
    }

    // Also check the Python version inside the venv matches expectations
    let ver_out = Command::new(&py_bin)
        .args(["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"])
        .stdout(Stdio::piped()).stderr(Stdio::null()).output()
        .unwrap_or_else(|_| std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: vec![], stderr: vec![],
        });
    let ver_str = String::from_utf8_lossy(&ver_out.stdout).trim().to_string();
    emit_progress(app, "verify_venv",
        &format!("Venv OK — Python {ver_str} at {}", py_bin.display()), false);

    Ok(py_bin)
}

// ── Process 4 of 5 : upgrade pip inside the venv ─────────────────────────────
//
// A fresh venv ships with the pip version bundled into the Python installer,
// which may be months or years old.  Running `pip install --upgrade pip` before
// installing transformers avoids resolver bugs and improves download
// reliability.  This step streams its output exactly like the main install.
// Skipped if pip is already reasonably modern (≥ 23).
fn step_upgrade_pip(
    py_bin:   &std::path::Path,
    app:      &tauri::AppHandle,
) -> Result<(), String> {
    // Query current pip version — e.g. "24.0"
    let ver_out = Command::new(py_bin)
        .args(["-m", "pip", "--version"])
        .stdout(Stdio::piped()).stderr(Stdio::null()).output()
        .unwrap_or_else(|_| std::process::Output {
            status: std::process::ExitStatus::default(),
            stdout: vec![], stderr: vec![],
        });
    let ver_line = String::from_utf8_lossy(&ver_out.stdout).trim().to_string();
    // "pip 23.3.1 from /…" — parse the version number after "pip "
    let current_major: u32 = ver_line
        .strip_prefix("pip ")
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if current_major >= 23 {
        emit_progress(app, "upgrade_pip",
            &format!("pip {current_major} is current — skipping upgrade"), false);
        return Ok(());
    }

    emit_progress(app, "upgrade_pip",
        &format!("Upgrading pip (currently {ver_line})…"), false);

    let mut child = Command::new(py_bin)
        .args(["-m", "pip", "install", "--upgrade",
               "--no-color", "--progress-bar", "off",
               "pip"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("pip upgrade failed to start: {e}"))?;

    // Stream stderr on a background thread (pip writes warnings/progress there)
    let app_err = app.clone();
    let stderr  = BufReader::new(child.stderr.take().ok_or("no pip stderr")?);
    std::thread::spawn(move || {
        for line in stderr.lines().flatten() { emit_pip_log(&app_err, &line); }
    });

    // Stream stdout on the current thread
    let stdout = BufReader::new(child.stdout.take().ok_or("no pip stdout")?);
    for line in stdout.lines().flatten() { emit_pip_log(app, &line); }

    let status = child.wait()
        .map_err(|e| format!("pip upgrade wait failed: {e}"))?;

    if !status.success() {
        // Non-fatal: log a warning but do not abort the install
        eprintln!("[LitAtlas] pip upgrade exited non-zero — continuing anyway");
        emit_progress(app, "upgrade_pip",
            "pip upgrade failed (non-fatal) — continuing…", false);
    } else {
        // Re-query version to confirm the upgrade
        let new_ver = Command::new(py_bin)
            .args(["-m", "pip", "--version"])
            .stdout(Stdio::piped()).stderr(Stdio::null()).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        emit_progress(app, "upgrade_pip",
            &format!("pip upgraded → {new_ver}"), false);
    }

    // Small gap so the UI can show the "upgraded" message before moving on
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}

// ── Process 5 of 5 : install transformers + torch + einops + timm ────────────
//
// Checks EVERY required package individually so a partial install (e.g. torch
// present but einops missing) is detected and repaired.  Each package is probed
// by importing it; missing ones are collected into a list and installed together
// in a single pip invocation.  If all packages are present the step is skipped
// entirely (fast path on every launch after the first).
// When installation IS needed, pip stdout and stderr are forwarded line-by-line
// as "venv://pip-log" events so the UI can render a live terminal.
fn step_install_deps(
    venv_dir: &std::path::Path,
    py_bin:   &std::path::Path,
    app:      &tauri::AppHandle,
) -> Result<(), String> {
    // Each entry: (pip package name, python import name, version expression)
    // The version expression is embedded in the import probe so we can report
    // the installed version in the progress message.
    let required: &[(&str, &str, &str)] = &[
        ("transformers==4.57.0",    "transformers",    "transformers.__version__"),
        ("torch",           "torch",           "torch.__version__"),
        ("huggingface_hub", "huggingface_hub", "huggingface_hub.__version__"),
        ("einops",          "einops",          "einops.__version__"),
        ("timm",            "timm",            "timm.__version__"),
        ("PyMuPDF",         "PyMuPDF",         "PyMuPDF.__version__"),
        ("qwen-vl-utils",   "
        ",   "qwen-vl-utils.__version__")
    ];

    // Probe each package; build two lists: already-installed (for the log) and
    // missing (need to be installed).
    let mut missing: Vec<&str> = Vec::new();

    for (pip_name, import_name, version_expr) in required {
        let probe = format!("import {import_name}; print({version_expr})");
        let result = Command::new(py_bin)
            .args(["-c", &probe])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success());

        match result {
            Some(o) => {
                let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
                emit_progress(app, "install_deps",
                    &format!("✓ {pip_name} {ver} already installed"), false);
            }
            None => {
                emit_progress(app, "install_deps",
                    &format!("✗ {pip_name} not found — will install"), false);
                missing.push(pip_name);
            }
        }
    }

    // All packages present — nothing to do.
    if missing.is_empty() {
        emit_progress(app, "install_deps",
            "All requirements satisfied — skipping installation", false);
        return Ok(());
    }

    let missing_list = missing.join(", ");
    emit_progress(app, "install_deps",
        &format!("Installing missing packages: {missing_list} (may take a minute)…"), false);

    let mut child = Command::new(venv_pip(venv_dir))
        .args(["install", "--no-color", "--progress-bar", "off"])
        .args(&missing)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("pip install failed to start: {e}"))?;

    // stderr on a background thread — pip writes download progress there
    let app_err    = app.clone();
    let stderr_buf = BufReader::new(child.stderr.take().ok_or("no pip stderr")?);
    std::thread::spawn(move || {
        for line in stderr_buf.lines().flatten() { emit_pip_log(&app_err, &line); }
    });

    // stdout on the current thread
    let stdout_buf = BufReader::new(child.stdout.take().ok_or("no pip stdout")?);
    for line in stdout_buf.lines().flatten() { emit_pip_log(app, &line); }

    let status = child.wait()
        .map_err(|e| format!("pip install wait failed: {e}"))?;

    if !status.success() {
        return Err(format!(
            "Installation of [{missing_list}] failed.\n\
             Check the terminal log above for details.\n\
             Common causes:\n\
             • No internet connection — connect to the internet and try again.\n\
             • Disk full — free up space and retry.\n\
             • Outdated pip — will be upgraded automatically on the next attempt.\n\n\
             Note: once installed, the AI similarity features work fully offline.\n\
             Only the initial setup and model downloads require internet access."
        ));
    }

    // Confirm by re-probing every package that was just installed.
    let required_confirm: &[(&str, &str, &str)] = &[
        ("transformers",    "transformers",    "transformers.__version__"),
        ("torch",           "torch",           "torch.__version__"),
        ("huggingface_hub", "huggingface_hub", "huggingface_hub.__version__"),
        ("einops",          "einops",          "einops.__version__"),
        ("timm",            "timm",            "timm.__version__"),
    ];
    for (pip_name, import_name, version_expr) in required_confirm {
        if !missing.contains(pip_name) { continue; }
        let probe = format!("import {import_name}; print({version_expr})");
        let ver = Command::new(py_bin)
            .args(["-c", &probe])
            .stdout(Stdio::piped()).stderr(Stdio::null()).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".into());
        emit_progress(app, "install_deps",
            &format!("✓ {pip_name} {ver} installed successfully"), false);
    }
    Ok(())
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
//
// Calls each step in sequence.  Returns the path to the venv Python binary on
// success so `launch_sidecar` can spawn the server with the right interpreter.
fn ensure_venv(
    venv_dir: &std::path::Path,
    app:      &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    // 1 — Locate a suitable system Python
    let system_py = step_find_python(app)?;

    // 2 — Create the venv (no-op if it already exists)
    step_create_venv(venv_dir, &system_py, app)?;

    // 3 — Verify the venv is self-contained
    let py_bin = step_verify_venv(venv_dir, app)?;

    // 4 — Upgrade pip inside the venv
    step_upgrade_pip(&py_bin, app)?;

    // 5 — Install transformers + torch + einops + timm (no-op if already present)
    step_install_deps(venv_dir, &py_bin, app)?;

    Ok(py_bin)
}


fn launch_sidecar(
    script:   &str,
    venv_dir: &std::path::Path,
    app:      &tauri::AppHandle,
) -> Result<PySidecar, String> {
    emit_progress(app, "starting", "Starting similarity engine…", false);

    let python = ensure_venv(venv_dir, app)?;

    // Read the custom plugin script path from app_config.json (if set).
    // Pass it to the sidecar via the LitAtlas_PLUGIN_SCRIPT env var so
    // Python can load the user's similarity_fn / compute_embedding_fn hooks.
    let plugin_script: String = {
        // NOTE: we don't have &AppState here, only venv_dir.  Infer data_dir
        // as venv_dir's parent (similarity_venv is created directly inside data_dir).
        let data_dir = venv_dir.parent().unwrap_or(venv_dir);
        let cfg_path = data_dir.join("app_config.json");
        std::fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|cfg| cfg["sidecar_script"].as_str().map(String::from))
            .filter(|p| !p.is_empty() && std::path::Path::new(p).exists())
            .unwrap_or_default()
    };

    let mut child = Command::new(&python)
        .arg("-u")
        .arg(script)
        .env_remove("CONDA_PREFIX")
        .env_remove("CONDA_DEFAULT_ENV")
        .env_remove("VIRTUAL_ENV")
        .env_remove("VIRTUAL_ENV_PROMPT")
        .env("LitAtlas_PLUGIN_SCRIPT", &plugin_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar at '{script}': {e}"))?;

    let stdin  = child.stdin.take().ok_or("no sidecar stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("no sidecar stdout")?);

    let mut sc = PySidecar { child, stdin, stdout, next_id: 1 };

    let mut handshake = String::new();
    sc.stdout.read_line(&mut handshake)
        .map_err(|e| format!("sidecar handshake read: {e}"))?;

    let v: serde_json::Value = serde_json::from_str(handshake.trim())
        .map_err(|e| format!("sidecar handshake parse: {e}\ngot: {handshake}"))?;

    if v["ok"].as_bool() != Some(true) {
        return Err(format!("sidecar startup failed: {}", v["error"]));
    }

    emit_progress(app, "ready", "Similarity engine ready.", true);
    eprintln!("[LitAtlas] Python sidecar started (pid {})", sc.child.id());
    Ok(sc)
}

fn ensure_running<'a>(s: &'a AppState, app: &tauri::AppHandle) -> Result<std::sync::MutexGuard<'a, Option<PySidecar>>, String> {
    let mut guard = s.sidecar.lock().unwrap();
    let dead = match guard.as_mut() {
        None     => true,
        Some(sc) => !sc.is_alive(),
    };
    if dead {
        if guard.is_some() {
            eprintln!("[LitAtlas] Sidecar crashed — restarting…");
        }
        eprintln!("dead !!");
        *guard = Some(launch_sidecar(&s.sidecar_script(), &s.venv_dir(), app)?);
    }
    Ok(guard)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Quick check: is the Python venv ready and transformers installed?
///
/// Does NOT start the sidecar or trigger any installation — purely reads the
/// filesystem.  JS calls this on startup to decide whether to show the
/// "Enable LLM module?" prompt.
///
/// Returns: { ready: bool, reason?: str }
#[tauri::command]
pub fn hf_setup_status(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_setup_status");
    let py = venv_python(&s.venv_dir());
    if !py.exists() {
        return Ok(serde_json::json!({
            "ready":          false,
            "reason":         "venv not created yet",
            "cached_models":  serde_json::Value::Array(vec![]),
        }));
    }

    // Check every required package is importable — a partial install (e.g.
    // torch present but einops missing) should also report not-ready.
    let pkg_ok = std::process::Command::new(&py)
        .args(["-c", "import transformers, torch, huggingface_hub, einops, timm"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|st| st.success())
        .unwrap_or(false);

    if !pkg_ok {
        return Ok(serde_json::json!({
            "ready":         false,
            "reason":        "one or more required packages (transformers, torch, huggingface_hub, einops, timm) not installed",
            "cached_models": serde_json::Value::Array(vec![]),
        }));
    }

    // Scan the HuggingFace local cache for models that are available offline.
    // This uses the same snapshot-directory heuristic as the Python sidecar's
    // _model_snapshot_path(): a model is offline-ready when its snapshot dir
    // contains config.json.  We do this in Rust so JS gets the list without
    // needing to start the sidecar first.
    let mut known_models: Vec<String> = vec![
        "Qwen/Qwen3-VL-2B-Instruct".into(),
    ];

    // Merge custom models from app_config.json so user-defined models are
    // also scanned for offline availability.
    let app_cfg_path = s.data_dir.join("app_config.json");
    if let Ok(raw) = std::fs::read_to_string(&app_cfg_path) {
        if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(arr) = cfg["custom_models"].as_array() {
                for m in arr {
                    if let Some(id) = m["id"].as_str() {
                        if !known_models.iter().any(|k| k == id) {
                            known_models.push(id.to_string());
                        }
                    }
                }
            }
        }
    }

    let hf_cache = hf_cache_dir();
    let cached_models: Vec<serde_json::Value> = known_models.iter()
        .filter(|model_id| model_is_cached(&hf_cache, model_id))
        .map(|id| serde_json::json!(id))
        .collect();

    Ok(serde_json::json!({
        "ready":         true,
        "cached_models": cached_models,
    }))
}

/// Return the HuggingFace hub cache directory, respecting HF_HOME / XDG_CACHE_HOME.
/// Mirrors the logic in similarity_server.py: _hf_cache_dir().
fn hf_cache_dir() -> std::path::PathBuf {
    if let Ok(hf_home) = std::env::var("HF_HOME") {
        return std::path::PathBuf::from(hf_home).join("hub");
    }
    let cache_root = std::env::var("XDG_CACHE_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_next_home().join(".cache")
        });
    cache_root.join("huggingface").join("hub")
}

/// Cross-platform home directory (mirrors dirs::home_dir without the dep).
fn dirs_next_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Return true if model_id has at least one snapshot directory containing
/// config.json in the HuggingFace hub cache.  Mirrors _model_snapshot_path().
fn model_is_cached(hf_cache: &std::path::Path, model_id: &str) -> bool {
    let safe      = model_id.replace('/', "--");
    let snap_root = hf_cache.join(format!("models--{safe}")).join("snapshots");
    if !snap_root.is_dir() { return false; }
    std::fs::read_dir(&snap_root)
        .map(|entries| entries.flatten().any(|entry| {
            entry.path().join("config.json").is_file()
        }))
        .unwrap_or(false)
}

/// Set up (or repair) the Python venv and install transformers + torch + einops + timm.
///
/// Runs the full 5-step venv orchestrator: find Python → create venv →
/// verify → upgrade pip → install deps.  Emits "venv://progress" events
/// so the UI can show live progress.  Does NOT start the sidecar.
///
/// Called from JS after the user opts in to the LLM module.
///
/// Returns: { ok: true } on success, error string on failure.
// #[tauri::command]
// pub fn hf_setup_venv(
//     app: tauri::AppHandle,
//     s:   State<'_, AppState>,
// ) -> CmdResult<serde_json::Value> {
//     ensure_venv(&s.venv_dir(), &app)
//         .map(|_| serde_json::json!({ "ok": true }))
// }

#[tauri::command]
pub fn hf_setup_venv(
    app: tauri::AppHandle,
    s:   State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_setup_venv");
    // If a live sidecar is already running, reuse it — no second spawn.
    {
        let mut guard = s.sidecar.lock().unwrap();
        if let Some(sc) = guard.as_mut() {
            if sc.is_alive() {
                eprintln!("[LitAtlas] hf_setup_venv: sidecar already live — reusing.");
                emit_progress(&app, "ready", "Similarity engine ready.", true);
                return Ok(serde_json::json!({ "ok": true }));
            }
            // Dead sidecar — drop it before relaunching.
            eprintln!("[LitAtlas] hf_setup_venv: dead sidecar found — relaunching.");
            *guard = None;
        }
    }

    // Spawn setup on a background thread so the Tauri command returns
    // immediately and the JS event loop can process progress events.
    let script  = s.sidecar_script();
    let venv    = s.venv_dir();
    std::thread::spawn(move || {
        match launch_sidecar(&script, &venv, &app) {
            Ok(sc) => {
                let state = app.state::<AppState>();
                *state.sidecar.lock().unwrap() = Some(sc);
                // launch_sidecar already emits the "ready" done event
            }
            Err(e) => {
                eprintln!("[LitAtlas] hf_setup_venv background error: {e}");
                let _ = app.emit("venv://error", serde_json::json!({ "error": e }));
            }
        }
    });

    Ok(serde_json::json!({ "ok": true, "background": true }))
}

/// Compute similarity edges using a HuggingFace sentence-transformer model.
///
/// Called from JS as: invoke("hf_compute_similarity", { papers, config })
///
/// config shape:
///   { model, fields, weights, threshold, max_edges }
///
/// Returns: { edges: EdgeInput[], count: number }
///
/// Before sending to Python, cached embedding vectors are injected as
/// "_embedding" fields so the sidecar can skip re-encoding those papers.
#[tauri::command]
pub fn hf_compute_similarity(
    app:    tauri::AppHandle,
    s:      State<'_, AppState>,
    mut papers: Vec<serde_json::Value>,
    config: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_compute_similarity");
    // Inject any cached embeddings to avoid redundant encoding in Python
    let model = config["model"].as_str()
        .unwrap_or("Qwen/Qwen3-VL-2B-Instruct");
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);
    let weights = config.get("weights").cloned().unwrap_or(serde_json::Value::Object(Default::default()));
    inject_cached_embeddings(&s, &mut papers, model, &fields, &weights);

    let mut guard = ensure_running(&s, &app)?;
    guard.as_mut().unwrap()
        .call("compute", serde_json::json!({ "papers": papers, "config": config }))
}

/// Retrieve the list of supported models and fields from the sidecar.
///
/// Called from JS as: invoke("hf_list_models")
/// Returns: { models: [...], fields: [...] }
#[tauri::command]
pub fn hf_list_models(app: tauri::AppHandle, s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_list_models");
    let mut guard = ensure_running(&s, &app)?;
    guard.as_mut().unwrap().call("list_models", serde_json::Value::Null)
}

/// Check whether the sidecar is running and which model is currently loaded.
///
/// Called from JS as: invoke("hf_sidecar_status")
/// Returns: { running: bool, details?: { loaded_model, python } }
#[tauri::command]
pub fn hf_sidecar_status(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_sidecar_status");
    let mut guard = s.sidecar.lock().unwrap();
    let alive = guard.as_mut().map(|sc| sc.is_alive()).unwrap_or(false);
    if !alive {
        *guard = None;
        return Ok(serde_json::json!({ "running": false }));
    }
    match guard.as_mut().unwrap().call("status", serde_json::Value::Null) {
        Ok(v)  => Ok(serde_json::json!({ "running": true, "details": v })),
        Err(e) => Ok(serde_json::json!({ "running": true, "error": e })),
    }
}

// ── Model cache check + download ──────────────────────────────────────────────

/// Check whether a HuggingFace model is already cached locally.
/// Fast — the sidecar only inspects the filesystem, no network call.
///
/// Called from JS as: invoke("hf_check_model", { model })
/// Returns: { cached: bool, path?: str }
#[tauri::command]
pub fn hf_check_model(
    app:   tauri::AppHandle,
    s:     State<'_, AppState>,
    model: String,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_check_model");
    println!("hf_check_model");
    let mut guard = ensure_running(&s, &app)?;
    guard.as_mut().unwrap()
        .call("check_model", serde_json::json!({ "model": model }))
}

/// Download a HuggingFace model to the local cache, streaming per-file
/// progress as "venv://model-progress" Tauri events so the JS UI can
/// render a live progress bar.
///
/// The Python sidecar writes intermediate JSON lines:
///   { "id": N, "ok": true, "progress": { filename, downloaded, total, pct } }
/// …followed by the final reply:
///   { "id": N, "ok": true, "result": { path, done: true } }
///
/// This command returns immediately and does all blocking I/O on a background
/// thread so the sidecar mutex is not held for the full download duration.
/// Progress is forwarded as "venv://model-progress" Tauri events.
/// Completion is signalled via "venv://model-download-done":
///   { ok: true, model, path }   on success
///   { ok: false, model, error } on failure
///
/// Called from JS as: invoke("hf_download_model", { model })
/// Returns immediately: { ok: true, background: true }
#[tauri::command]
pub fn hf_download_model(
    app:   tauri::AppHandle,
    s:     State<'_, AppState>,
    model: String,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_download_model");
    // Send the request while we hold the lock, then release it before
    // entering the blocking read loop so other commands can proceed.
    let req_id = {
        let mut guard = ensure_running(&s, &app)?;
        let sc = guard.as_mut().unwrap();

        let id = sc.next_id;
        sc.next_id += 1;

        let mut req = serde_json::json!({
            "id": id,
            "method": "download_model",
            "params": { "model": model }
        }).to_string();
        req.push('\n');

        sc.stdin.write_all(req.as_bytes())
            .map_err(|e| format!("sidecar write: {e}"))?;
        sc.stdin.flush()
            .map_err(|e| format!("sidecar flush: {e}"))?;

        id   // guard is dropped here, releasing the mutex
    };

    // Move the blocking read loop to a background thread so this command
    // returns immediately and the sidecar mutex is free for other commands.
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        loop {
            // Re-acquire lock only long enough to read one line.
            let line = {
                let mut guard = match state.sidecar.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        let _ = app.emit("venv://model-download-done", serde_json::json!({
                            "ok": false, "model": &model,
                            "error": "sidecar mutex poisoned"
                        }));
                        return;
                    }
                };
                let sc = match guard.as_mut() {
                    Some(sc) => sc,
                    None => {
                        let _ = app.emit("venv://model-download-done", serde_json::json!({
                            "ok": false, "model": &model,
                            "error": "sidecar not running"
                        }));
                        return;
                    }
                };
                let mut buf = String::new();
                match sc.stdout.read_line(&mut buf) {
                    Ok(0) => {
                        let _ = app.emit("venv://model-download-done", serde_json::json!({
                            "ok": false, "model": &model,
                            "error": "sidecar closed stdout unexpectedly"
                        }));
                        return;
                    }
                    Err(e) => {
                        let _ = app.emit("venv://model-download-done", serde_json::json!({
                            "ok": false, "model": &model,
                            "error": format!("sidecar read: {e}")
                        }));
                        return;
                    }
                    Ok(_) => buf,
                }
                // guard is dropped here after each line read
            };

            let v: serde_json::Value = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(e) => {
                    let _ = app.emit("venv://model-download-done", serde_json::json!({
                        "ok": false, "model": &model,
                        "error": format!("sidecar parse: {e}")
                    }));
                    return;
                }
            };

            // Skip lines for other request IDs (shouldn't happen, but be safe).
            if v.get("id").and_then(|id| id.as_u64()) != Some(req_id) {
                continue;
            }

            // Intermediate progress — forward to JS and keep reading.
            if let Some(prog) = v.get("progress") {
                let _ = app.emit("venv://model-progress", prog);
                continue;
            }

            // Final reply.
            if v["ok"].as_bool() != Some(true) {
                let err = v["error"].as_str()
                    .unwrap_or("download failed").to_string();
                let _ = app.emit("venv://model-download-done", serde_json::json!({
                    "ok": false, "model": &model, "error": err
                }));
            } else {
                let _ = app.emit("venv://model-download-done", serde_json::json!({
                    "ok": true, "model": &model,
                    "path": v["result"]["path"]
                }));
            }
            return;
        }
    });

    Ok(serde_json::json!({ "ok": true, "background": true }))
}

// ── Per-paper embedding cache ─────────────────────────────────────────────────
//
// Embeddings are stored as JSON next to the PDF:
//   projects/<slug>/pdfs/<paper_id>/embedding.json
//
// File format:
//   { "model": "<hf-id>", "fields": [...], "vector": [f32...] }
//
// If no PDF has been uploaded for a paper, the embedding is stored in a
// fallback location:
//   projects/<slug>/embeddings/<paper_id>.json
//
// This means embeddings persist across PDF replacements and don't require a
// PDF to exist at all.

fn embedding_path_for_paper(s: &AppState, paper_id: i64) -> std::path::PathBuf {
    // Primary: alongside the PDF directory
    let pdf_sibling = s.pdfs_dir().join(paper_id.to_string()).join("embedding.json");
    if pdf_sibling.parent().map(|p| p.exists()).unwrap_or(false) {
        return pdf_sibling;
    }
    // Fallback: dedicated embeddings directory (created lazily)
    let embeddings_dir = s.projects_dir
        .join(s.current_slug())
        .join("embeddings");
    std::fs::create_dir_all(&embeddings_dir).ok();
    embeddings_dir.join(format!("{paper_id}.json"))
}

fn read_embedding_cache(path: &std::path::Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Check whether a cached embedding is reusable for the given model+fields.
///
/// Weights are intentionally NOT compared here — the cache stores raw per-field
/// vectors so that reweighting can be done locally in Rust without re-encoding.
/// Only a model or field-set change requires re-encoding from Python.
fn embedding_cache_matches(
    cache:  &serde_json::Value,
    model:  &str,
    fields: &[String],
) -> bool {
    if cache["model"].as_str() != Some(model) { return false; }
    let cached_fields: Vec<String> = cache["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    // println!("cached_field : {:?}", cached_fields);
    // println!("fields : {:?}", fields);
    cached_fields == fields
}

/// Check whether a cached embedding is reusable for the given model+fields.
///
/// Weights are intentionally NOT compared here — the cache stores raw per-field
/// vectors so that reweighting can be done locally in Rust without re-encoding.
/// Only a model or field-set change requires re-encoding from Python.
fn embedding_cache_in_matches(
    cache:  &serde_json::Value,
    model:  &str,
    fields: &[String],
) -> bool {
    if cache["model"].as_str() != Some(model) { return false; }
    let cached_fields: Vec<String> = cache["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    println!("cached_field : {:?}", cached_fields);
    println!("fields : {:?}", fields);
    for field in fields{
        if !cached_fields.contains(field){
            return false;
        }
    }
    return true;
}

/// Recompose a weighted composite vector from raw per-field vectors and
/// current weights, then L2-normalise it.
///
/// field_vectors: { "title": [f32...], "abstract": [f32...], ... }
/// weights:       { "title": 0.7, "abstract": 1.0, ... }  (missing key → 1.0)
///
/// Returns None if field_vectors is empty or malformed.
fn recompose_embedding(
    field_vectors: &serde_json::Value,
    fields:        &[String],
    weights:       &serde_json::Value,
) -> Option<Vec<f64>> {
    let fv_map = field_vectors.as_object()?;
    let mut composite: Vec<f64> = Vec::new();
    let mut any = false;
    // println!("fv_map {:?}", fv_map);
    for field in fields {
        let vec_val = match fv_map.get(field) { Some(v) => v, None => continue };
        let arr = match vec_val.as_array() { Some(a) => a, None => continue };
        let w = weights.get(field)
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0);
        if w == 0.0 { continue; }

        if composite.is_empty() {
            composite = vec![0.0; arr.len()];
        }
        for (k, v) in arr.iter().enumerate() {
            composite[k] += w * v.as_f64().unwrap_or(0.0);
        }
        any = true;
    }

    if !any || composite.is_empty() { return None; }

    // L2-normalise
    let norm: f64 = composite.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm > 0.0 {
        for x in &mut composite { *x /= norm; }
    }
    Some(composite)
}

/// Compute and persist the raw per-field embedding vectors for a single paper.
///
/// The JSON cache stores only model, fields, and field_vectors — no weights
/// and no composite vector.  This means the cache stays valid whenever only
/// the weights change; the composite is recomposed from field_vectors at query
/// time using the current weights (see inject_cached_embeddings).
///
/// The "pdf" field is always included so that a paper with a PDF gets a visual
/// embedding alongside its text fields.  Papers without a pdf_path silently
/// skip the pdf field in Python.
///
/// Called from JS as: invoke("hf_compute_paper_embedding", { paperId, config })
///
/// config shape: { model, fields, weights, vl_model? }
///
/// Returns: { paper_id, path, dim, cached: false }
#[tauri::command]
pub fn hf_compute_paper_embedding(
    app:      tauri::AppHandle,
    s:        State<'_, AppState>,
    paper_id: i64,
    config:   serde_json::Value,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_compute_paper_embedding");
    // Load the paper from DB so Python has all fields (title, abstract, hashtags, pdf_path…)
    let paper: serde_json::Value = {
        let pool   = s.pool();
        let p = tauri::async_runtime::block_on(
            crate::db::get_paper(&pool, paper_id)
        ).map_err(|e| e.to_string())?;
        serde_json::to_value(p).map_err(|e| e.to_string())?
    };

    let model  = config["model"].as_str().unwrap_or("Qwen/Qwen3-VL-2B-Instruct");

    // Always include "pdf" so papers with a PDF get a visual embedding.
    let mut fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);
    if !fields.iter().any(|f| f == "pdf") {
        fields.push("pdf".into());
    }

    // Forward vl_model override if provided; Python falls back to its own default otherwise.
    let py_config = serde_json::json!({
        "model":    model,
        "fields":   &fields,
        "weights":  config.get("weights").cloned().unwrap_or(serde_json::Value::Object(Default::default())),
        "vl_model": config.get("vl_model").cloned().unwrap_or(serde_json::Value::Null),
    });

    let mut guard = ensure_running(&s, &app)?;
    let result = guard.as_mut().unwrap()
        .call("compute_embedding", serde_json::json!({ "paper": paper, "config": py_config }))?;
    drop(guard);

    // Python returns { field_vectors: { "<field>": [f32, ...], ... }, dim: int }
    let field_vectors = result.get("field_vectors").cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let dim = result["dim"].as_u64().unwrap_or(0);

    // Persist — weights intentionally excluded so cache survives weight changes.
    let path = embedding_path_for_paper(&s, paper_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create embedding dir: {e}"))?;
    }
    let payload = serde_json::json!({
        "model":         model,
        "fields":        fields,
        "field_vectors": field_vectors,
        // NOTE: no "weights" key, no "vector" key — composite recomposed at query time.
    });
    std::fs::write(&path, serde_json::to_string(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Cannot write embedding: {e}"))?;

    Ok(serde_json::json!({
        "paper_id": paper_id,
        "path":     path.to_string_lossy(),
        "dim":      dim,
        "cached":   false,
    }))
}

/// Read cached raw per-field embedding vectors for a paper.
///
/// Returns field_vectors if model+fields match; the caller recomposes the
/// weighted composite using the current weights.
///
/// Called from JS as: invoke("hf_get_paper_embedding", { paperId, config })
/// Returns: { field_vectors: {...}, dim: number, hit: true } | { hit: false }
#[tauri::command]
pub fn hf_get_paper_embedding(
    s:        State<'_, AppState>,
    paper_id: i64,
    config:   serde_json::Value,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_get_paper_embedding");
    let path  = embedding_path_for_paper(&s, paper_id);
    let model = config["model"].as_str().unwrap_or("Qwen/Qwen3-VL-2B-Instruct");
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if let Some(cache) = read_embedding_cache(&path) {
        if embedding_cache_matches(&cache, model, &fields) {
            let field_vectors = cache["field_vectors"].clone();
            let dim = field_vectors.as_object()
                .and_then(|m| m.values().next())
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            return Ok(serde_json::json!({ "field_vectors": field_vectors, "dim": dim, "hit": true }));
        }
    }
    Ok(serde_json::json!({ "hit": false }))
}

/// Re-encode every paper in the current project unconditionally.
///
/// Called when the user presses "Cache All Embeddings" — always writes fresh
/// field_vectors for every paper regardless of any existing cache.  This
/// guarantees that the stored raw vectors are up-to-date before
/// hf_compute_edges_from_cache recomposes them with the current weights.
///
/// The "pdf" field is always included in the fields list so that papers which
/// have a PDF uploaded will have a visual embedding extracted via the VL model.
/// Papers without a pdf_path silently skip the pdf field in Python.
///
/// Progress events: { paper_id, title, index, total, done? }
///
/// Called from JS as: invoke("hf_compute_all_embeddings", { config })
/// Returns: { ok, background, total }
#[tauri::command]
pub fn hf_compute_all_embeddings(
    app:    tauri::AppHandle,
    s:      State<'_, AppState>,
    config: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_compute_all_embeddings");

    let model = config["model"].as_str()
        .unwrap_or("Qwen/Qwen3-VL-2B-Instruct")
        .to_string();

    // Always include "pdf" so papers with a PDF get a visual embedding.
    // Deduplicate in case the caller already included it.
    let mut fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);
    if !fields.iter().any(|f| f == "pdf") {
        fields.push("pdf".into());
    }

    // Load papers and pre-compute embedding paths synchronously before spawning
    // the background thread — avoids passing the non-Send State<'_> reference
    // across the thread boundary.
    let papers: Vec<crate::db::PaperFull> = {
        let pool = s.pool();
        tauri::async_runtime::block_on(crate::db::get_all_papers(&pool))
            .map_err(|e| e.to_string())?
    };

    // Pre-resolve each paper's embedding output path using the same logic as
    // embedding_path_for_paper(): prefer pdfs/<id>/embedding.json when the
    // per-paper PDF directory already exists, otherwise use
    // embeddings/<id>.json.  This must be done while we still hold State so
    // we can call pdfs_dir() / current_slug().
    let pdfs_dir     = s.pdfs_dir();
    let projects_dir = s.projects_dir.clone();
    let current_slug = s.current_slug();

    let embedding_paths: Vec<std::path::PathBuf> = papers.iter().map(|p| {
        let pdf_sibling = pdfs_dir.join(p.id.to_string()).join("embedding.json");
        if pdf_sibling.parent().map(|d| d.exists()).unwrap_or(false) {
            pdf_sibling
        } else {
            let emb_dir = projects_dir.join(&current_slug).join("embeddings");
            std::fs::create_dir_all(&emb_dir).ok();
            emb_dir.join(format!("{}.json", p.id))
        }
    }).collect();

    let total = papers.len();

    // Emit "started" immediately so the JS overlay appears before the thread runs.
    let _ = app.emit("embedding://progress", serde_json::json!({
        "started": true,
        "total":   total,
    }));

    // Build the config value that Python will receive — use the augmented fields
    // list (with "pdf" guaranteed) so Python encodes all relevant fields.
    let py_config = serde_json::json!({
        "model":     &model,
        "fields":    &fields,
        "weights":   config.get("weights").cloned().unwrap_or(serde_json::Value::Object(Default::default())),
        "vl_model":  config.get("vl_model").cloned().unwrap_or(serde_json::Value::Null),
    });

    // Spawn encoding loop on a background thread — command returns immediately
    // so Tauri can deliver per-paper progress events to the JS event loop.
    std::thread::spawn(move || {
        let mut computed = 0usize;

        for (index, (paper, emb_path)) in papers.iter().zip(embedding_paths.iter()).enumerate() {
            let _ = app.emit("embedding://progress", serde_json::json!({
                "paper_id": paper.id,
                "title":    &paper.title,
                "index":    index,
                "total":    total,
            }));

            let paper_val = match serde_json::to_value(paper.clone()) {
                Ok(v) => v,
                Err(e) => {
                    let _ = app.emit("embedding://error", serde_json::json!({ "error": e.to_string() }));
                    return;
                }
            };

            let state = app.state::<AppState>();
            let result = match ensure_running(&state, &app) {
                Ok(mut guard) => {
                    let r = guard.as_mut().unwrap().call(
                        "compute_embedding",
                        serde_json::json!({ "paper": paper_val, "config": &py_config }),
                    );
                    drop(guard);
                    match r {
                        Ok(v) => v,
                        Err(e) => {
                            let _ = app.emit("embedding://error", serde_json::json!({ "error": e }));
                            return;
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit("embedding://error", serde_json::json!({ "error": e }));
                    return;
                }
            };

            let field_vectors = result.get("field_vectors").cloned()
                .unwrap_or(serde_json::Value::Object(Default::default()));

            if let Some(parent) = emb_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let payload = serde_json::json!({
                "model":         &model,
                "fields":        &fields,
                "field_vectors": field_vectors,
            });
            if let Err(e) = serde_json::to_string(&payload)
                .map_err(|e| e.to_string())
                .and_then(|s| std::fs::write(emb_path, s).map_err(|e| e.to_string()))
            {
                let _ = app.emit("embedding://error", serde_json::json!({ "error": e }));
                return;
            }
            computed += 1;
        }

        // Final done event — JS resolves its waiting promise on this.
        let _ = app.emit("embedding://progress", serde_json::json!({
            "done":     true,
            "total":    total,
            "computed": computed,
        }));
    });

    // Return immediately — JS awaits embedding://progress { done: true }.
    Ok(serde_json::json!({ "ok": true, "background": true, "total": total }))
}

/// Compute similarity edges entirely from cached field_vectors on disk.
///
/// This is the second half of the recompute flow:
///   1. hf_compute_all_embeddings  — re-encodes every paper → writes field_vectors to JSON
///   2. hf_compute_edges_from_cache — reads JSON, applies current weights, computes cosines
///
/// No Python sidecar call is made here.  For every paper the function:
///   a. Reads its embedding.json
///   b. Recomposes the weighted composite with recompose_embedding()
///   c. Computes pairwise cosine similarity in Rust
///   d. Applies threshold and max-edges to produce the final edge list
///
/// Returns: { edges: [{ source_id, target_id, similarity, weight, edge_type }], count }
///
/// Called from JS as: invoke("hf_compute_edges_from_cache", { papers, config })
#[tauri::command]
pub fn hf_compute_edges_from_cache(
    s:      State<'_, AppState>,
    papers: Vec<serde_json::Value>,
    config: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_compute_edges_from_cache");
    let model = config["model"].as_str()
        .unwrap_or("Qwen/Qwen3-VL-2B-Instruct");
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);
    let weights   = config.get("weights").cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let threshold = config["threshold"].as_f64().unwrap_or(0.38);
    let max_edges = config["max_edges"].as_u64().unwrap_or(7) as usize;

    // Build (paper_json, composite_vector) pairs.
    // Papers without a cache file are given an empty vector and will produce
    // no edges — callers should ensure embeddings exist before calling this.
    let mut vecs: Vec<Option<Vec<f64>>> = Vec::with_capacity(papers.len());
    for paper in &papers {
        let id = match paper["id"].as_i64() { Some(v) => v, None => { vecs.push(None); continue; } };
        let path = embedding_path_for_paper(&s, id);
        // println!("{}", path.display());
        // println!("{:?}", read_embedding_cache(&path).filter(|cache| embedding_cache_in_matches(cache, model, &fields)));
        let composite = read_embedding_cache(&path)
            .filter(|cache| embedding_cache_in_matches(cache, model, &fields))
            .and_then(|cache| recompose_embedding(&cache["field_vectors"], &fields, &weights));
        vecs.push(composite);
    }
    println!("{:?}", vecs);
    // Pairwise cosine — identical edge-selection logic to the Python sidecar.
    let n = papers.len();
    let mut candidates: Vec<(usize, usize, f64)> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            let (Some(vi), Some(vj)) = (&vecs[i], &vecs[j]) else { continue };
            let sim = cosine_f64(vi, vj);
            if sim >= threshold {
                candidates.push((i, j, sim));
            }
        }
    }
    candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let mut edge_count = vec![0usize; n];
    let mut edges: Vec<serde_json::Value> = Vec::new();
    for (i, j, sim) in candidates {
        if edge_count[i] < max_edges && edge_count[j] < max_edges {
            edge_count[i] += 1;
            edge_count[j] += 1;
            let weight = if sim >= 0.75 { 3 } else if sim >= 0.55 { 2 } else { 1 };
            let etype  = edge_type_for(&papers[i], &papers[j]);
            edges.push(serde_json::json!({
                "source_id":   papers[i]["id"],
                "target_id":   papers[j]["id"],
                "similarity":  (sim * 1_000_000.0).round() / 1_000_000.0,
                "weight":      weight,
                "edge_type":   etype,
                "source_type": "hf-embeddings",
            }));
        }
    }

    let count = edges.len();
    Ok(serde_json::json!({ "edges": edges, "count": count }))
}

/// L2-normalised cosine similarity between two f64 slices.
fn cosine_f64(a: &[f64], b: &[f64]) -> f64 {
    let dot: f64 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let na:  f64 = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    let nb:  f64 = b.iter().map(|y| y * y).sum::<f64>().sqrt();
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

/// Edge type classification matching the Python sidecar logic.
fn edge_type_for(a: &serde_json::Value, b: &serde_json::Value) -> &'static str {
    let tags_a: std::collections::HashSet<String> = a["hashtags"]
        .as_array().map(|arr| arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim_start_matches('#').to_string()))
            .collect())
        .unwrap_or_default();
    let tags_b: std::collections::HashSet<String> = b["hashtags"]
        .as_array().map(|arr| arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.trim_start_matches('#').to_string()))
            .collect())
        .unwrap_or_default();
    if !tags_a.is_empty() && tags_a.intersection(&tags_b).next().is_some() {
        return "same_tag";
    }
    let venue_a = a["venue"].as_str().unwrap_or("");
    let venue_b = b["venue"].as_str().unwrap_or("");
    if !venue_a.is_empty() && venue_a == venue_b {
        return "same_venue";
    }
    "related"
}

/// Inject composite embedding vectors into a papers list before sending to sidecar.
///
/// For each paper whose embedding.json exists and matches model+fields, this
/// function recomposes the weighted composite from the stored raw field_vectors
/// using the *current* weights, then injects it as "_embedding".  Python will
/// use it directly via the cached-vector fast path and skip re-encoding.
///
/// Papers without a valid cache miss fall through to Python fresh-encoding.
///
/// Called internally by hf_compute_similarity.
fn inject_cached_embeddings(
    s:       &AppState,
    papers:  &mut Vec<serde_json::Value>,
    model:   &str,
    fields:  &[String],
    weights: &serde_json::Value,
) {
    for paper in papers.iter_mut() {
        let id = match paper["id"].as_i64() { Some(v) => v, None => continue };
        let path = embedding_path_for_paper(s, id);
        if let Some(cache) = read_embedding_cache(&path) {
            // Cache is valid when model+fields match; weights are applied fresh below.
            if embedding_cache_matches(&cache, model, fields) {
                if let Some(composite) = recompose_embedding(&cache["field_vectors"], fields, weights) {
                    let json_vec: Vec<serde_json::Value> = composite
                        .iter()
                        .map(|x| serde_json::json!(x))
                        .collect();
                    paper["_embedding"] = serde_json::Value::Array(json_vec);
                }
            }
        }
    }
}

// ── Similarity config persistence ─────────────────────────────────────────────
// app_data_dir/similarity_config.json — global preference, not per-project.

#[tauri::command]
pub fn get_similarity_config(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("get_similarity_config");
    let path = s.data_dir.join("similarity_config.json");
    if !path.exists() {
        return Ok(serde_json::Value::Null); // JS falls back to its built-in defaults
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_similarity_config(
    s:      State<'_, AppState>,
    config: serde_json::Value,
) -> CmdResult<()> {
    logger::log_call("save_similarity_config");
    let path = s.data_dir.join("similarity_config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
// ── Plugin validation ────────────────────────────────────────────────────────

/// Ask the running sidecar to validate a plugin script.
/// The sidecar imports the file and checks for `similarity_fn` and
/// `compute_embedding_fn` without permanently loading it.
///
/// Called from JS as: invoke("hf_validate_plugin", { scriptPath })
/// Returns: { valid: bool, has_similarity_fn: bool, has_embedding_fn: bool, error?: str }
#[tauri::command]
pub fn hf_validate_plugin(
    app:         tauri::AppHandle,
    s:           State<'_, AppState>,
    script_path: String,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_validate_plugin");
    let mut guard = ensure_running(&s, &app)?;
    guard.as_mut().unwrap()
        .call("validate_plugin", serde_json::json!({ "script_path": script_path }))
}

// ── App config persistence ────────────────────────────────────────────────────
// app_data_dir/app_config.json — stores user preferences that affect app
// behaviour across all projects: custom sidecar script path, custom HF models.
//
// Schema:
// {
//   "sidecar_script": "/path/to/my_similarity_server.py",  // optional override
//   "custom_models": [
//     { "id": "org/model-name", "label": "My Model", "description": "...", "size_mb": 200 }
//   ]
// }

#[tauri::command]
pub fn get_app_config(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("get_app_config");
    let path = s.data_dir.join("app_config.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "sidecar_script": null, "custom_models": [] }));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_app_config(
    s:      State<'_, AppState>,
    config: serde_json::Value,
) -> CmdResult<()> {
    logger::log_call("save_app_config");
    let path = s.data_dir.join("app_config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Validate that a user-supplied path points to a readable Python file.
/// Used by the App Settings panel before saving a custom sidecar script path.
///
/// Called from JS as: invoke("pick_sidecar_script", { path })
/// Returns: { path: str, exists: bool, readable: bool }
///
/// NOTE: Native file-picker dialogs require the tauri-plugin-dialog crate.
/// This lighter alternative simply validates a path the user typed or pasted
/// directly into the settings input, keeping the dependency surface minimal.
#[tauri::command]
pub fn pick_sidecar_script(path: String) -> CmdResult<serde_json::Value> {
    logger::log_call("pick_sidecar_script");
    let p = std::path::Path::new(&path);
    let exists   = p.exists();
    let readable = exists && std::fs::read(&p).is_ok();
    Ok(serde_json::json!({ "path": path, "exists": exists, "readable": readable }))
}

/// Return the resolved sidecar script path and whether it is a user override.
/// JS calls this to show which script is currently active.
///
/// Returns: { path: str, is_custom: bool }
#[tauri::command]
pub fn get_sidecar_script_info(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("get_sidecar_script_info");
    // Check for user override in app_config.json
    let cfg_path = s.data_dir.join("app_config.json");
    if cfg_path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&cfg_path) {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = cfg["sidecar_script"].as_str() {
                    if !p.is_empty() && std::path::Path::new(p).exists() {
                        return Ok(serde_json::json!({ "path": p, "is_custom": true }));
                    }
                }
            }
        }
    }
    Ok(serde_json::json!({
        "path":      s.sidecar_script(),
        "is_custom": false,
    }))
}