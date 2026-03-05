// src-tauri/src/commands.rs

use tauri::Manager;
use tauri::State;
use crate::AppState;
use crate::db::{
    self, EdgeInput, NewPaper, NewRelation,
    PaperFull, EdgeRow, HashtagRow, RelationRow, PaperAttribute,
};

type CmdResult<T> = Result<T, String>;

// ── Papers ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_papers(s: State<'_, AppState>) -> CmdResult<Vec<PaperFull>> {
    db::get_all_papers(&s.pool()).await.map_err(String::from)
}

#[tauri::command]
pub async fn get_paper(s: State<'_, AppState>, id: i64) -> CmdResult<PaperFull> {
    db::get_paper(&s.pool(), id).await.map_err(String::from)
}

#[tauri::command]
pub async fn add_paper(s: State<'_, AppState>, paper: NewPaper) -> CmdResult<i64> {
    db::insert_paper(&s.pool(), paper).await.map_err(String::from)
}

#[tauri::command]
pub async fn delete_paper(s: State<'_, AppState>, id: i64) -> CmdResult<()> {
    db::delete_paper(&s.pool(), id).await.map_err(String::from)?;

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
    db::update_paper_core(&s.pool(), id, title, venue, year)
        .await.map_err(String::from)
}

#[tauri::command]
pub async fn save_notes(s: State<'_, AppState>, id: i64, notes: String) -> CmdResult<()> {
    db::save_notes(&s.pool(), id, &notes).await.map_err(String::from)
}

#[tauri::command]
pub async fn save_pdf_path(s: State<'_, AppState>, id: i64, path: Option<String>) -> CmdResult<()> {
    db::save_pdf_path(&s.pool(), id, path.as_deref()).await.map_err(String::from)
}

// ── Authors ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_authors(s: State<'_, AppState>, id: i64, authors: Vec<String>) -> CmdResult<()> {
    db::set_authors(&s.pool(), id, &authors).await.map_err(String::from)
}

// ── Hashtags ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_hashtags(s: State<'_, AppState>) -> CmdResult<Vec<HashtagRow>> {
    db::get_all_hashtags(&s.pool()).await.map_err(String::from)
}

#[tauri::command]
pub async fn set_tags(s: State<'_, AppState>, id: i64, tags: Vec<String>) -> CmdResult<()> {
    db::set_tags(&s.pool(), id, &tags).await.map_err(String::from)
}

// ── Custom attributes ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_attributes(
    s: State<'_, AppState>, id: i64, attributes: Vec<PaperAttribute>,
) -> CmdResult<()> {
    db::set_attributes(&s.pool(), id, &attributes).await.map_err(String::from)
}

#[tauri::command]
pub async fn upsert_attribute(
    s: State<'_, AppState>, id: i64, key: String, value: String, order: i64,
) -> CmdResult<()> {
    db::upsert_attribute(&s.pool(), id, &key, &value, order)
        .await.map_err(String::from)
}

#[tauri::command]
pub async fn delete_attribute(s: State<'_, AppState>, id: i64, key: String) -> CmdResult<()> {
    db::delete_attribute(&s.pool(), id, &key).await.map_err(String::from)
}

// ── Relations ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_relations(s: State<'_, AppState>, id: i64) -> CmdResult<Vec<RelationRow>> {
    db::get_relations_for_paper(&s.pool(), id).await.map_err(String::from)
}

#[tauri::command]
pub async fn get_all_relations(s: State<'_, AppState>) -> CmdResult<Vec<RelationRow>> {
    db::get_all_relations(&s.pool()).await.map_err(String::from)
}

#[tauri::command]
pub async fn add_relation(s: State<'_, AppState>, relation: NewRelation) -> CmdResult<i64> {
    db::add_relation(&s.pool(), relation).await.map_err(String::from)
}

#[tauri::command]
pub async fn update_relation_note(
    s: State<'_, AppState>, id: i64, note: Option<String>,
) -> CmdResult<()> {
    db::update_relation_note(&s.pool(), id, note).await.map_err(String::from)
}

#[tauri::command]
pub async fn delete_relation(s: State<'_, AppState>, id: i64) -> CmdResult<()> {
    db::delete_relation(&s.pool(), id).await.map_err(String::from)
}

// ── Similarity edges ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_edges(s: State<'_, AppState>) -> CmdResult<Vec<EdgeRow>> {
    db::get_all_edges(&s.pool()).await.map_err(String::from)
}

#[tauri::command]
pub async fn recompute_edges(s: State<'_, AppState>, edges: Vec<EdgeInput>) -> CmdResult<usize> {
    db::replace_all_edges(&s.pool(), edges).await.map_err(String::from)
}

#[tauri::command]
pub async fn append_edges(s: State<'_, AppState>, edges: Vec<EdgeInput>) -> CmdResult<usize> {
    db::append_edges(&s.pool(), edges).await.map_err(String::from)
}

// ── PDF storage ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn store_pdf_bytes(
    s:           State<'_, AppState>,
    paper_id:    i64,
    filename:    String,
    data_base64: String,
) -> CmdResult<String> {
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
        .await.map_err(String::from)?;
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
        .await.map_err(String::from)?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_pdf_url(s: State<'_, AppState>, paper_id: i64) -> CmdResult<String> {
    let paper = db::get_paper(&s.pool(), paper_id).await.map_err(String::from)?;
    Ok(paper.pdf_path.unwrap_or_default())
}

#[tauri::command]
pub async fn read_pdf_bytes(s: State<'_, AppState>, paper_id: i64) -> CmdResult<String> {
    let paper = db::get_paper(&s.pool(), paper_id).await.map_err(String::from)?;
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
    Ok(read_projects(&s))
}

#[tauri::command]
pub fn get_current_project(s: State<'_, AppState>) -> CmdResult<String> {
    Ok(s.current_slug())
}

#[tauri::command]
pub fn create_project(s: State<'_, AppState>, name: String) -> CmdResult<ProjectEntry> {
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
    let mut projects = read_projects(&s);
    if let Some(p) = projects.iter_mut().find(|p| p.slug == slug) {
        p.name = new_name;
    } else {
        return Err(format!("Project '{slug}' not found"));
    }
    write_projects(&s, &projects)
}

#[tauri::command]
pub fn delete_project(s: State<'_, AppState>, slug: String) -> CmdResult<()> {
    let mut projects = read_projects(&s);
    if projects.len() <= 1 { return Err("Cannot delete the last project".into()); }
    projects.retain(|p| p.slug != slug);
    let _ = std::fs::remove_dir_all(s.projects_dir.join(&slug));
    write_projects(&s, &projects)
}

#[tauri::command]
pub fn switch_project(s: State<'_, AppState>, slug: String) -> CmdResult<()> {
    let projects = read_projects(&s);
    if !projects.iter().any(|p| p.slug == slug) {
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
            eprintln!("[PaperGraph] Skipping {bin} — inside conda: {exe_path}");
            emit_progress(app, "find_python",
                &format!("Skipped {bin} (conda env — needs isolation)"), false);
            continue;
        }
        if !venv_prefix.is_empty() && exe_path.starts_with(&venv_prefix) {
            eprintln!("[PaperGraph] Skipping {bin} — inside venv: {exe_path}");
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
            eprintln!("[PaperGraph] Using Python: {exe_path}");
            return Ok(bin.to_string());
        }
    }

    Err("Python 3.8+ not found on PATH (every candidate was either missing or \
         inside an active conda / venv environment).\n\
         Install Python 3 from https://python.org and restart PaperGraph.".into())
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
// installing sentence-transformers avoids resolver bugs and improves download
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
        eprintln!("[PaperGraph] pip upgrade exited non-zero — continuing anyway");
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

// ── Process 5 of 5 : install sentence-transformers ───────────────────────────
//
// Checks whether the package is already importable first; if so the step is
// skipped entirely (fast path on every launch after the first).
// When installation IS needed, pip stdout and stderr are forwarded line-by-line
// as "venv://pip-log" events so the UI can render a live terminal.
fn step_install_deps(
    venv_dir: &std::path::Path,
    py_bin:   &std::path::Path,
    app:      &tauri::AppHandle,
) -> Result<(), String> {
    // Fast path: package already installed
    let already = Command::new(py_bin)
        .args(["-c", "import sentence_transformers; print(sentence_transformers.__version__)"])
        .stdout(Stdio::piped()).stderr(Stdio::null())
        .output()
        .map(|o| o.status.success()
            .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .unwrap_or(None);

    if let Some(ver) = already {
        emit_progress(app, "install_deps",
            &format!("sentence-transformers {ver} already installed — skipping"), false);
        return Ok(());
    }

    emit_progress(app, "install_deps",
        "Installing sentence-transformers (first time — may take a minute)…", false);

    let mut child = Command::new(venv_pip(venv_dir))
        .args([
            "install",
            "--no-color",
            "--progress-bar", "off",
            "sentence-transformers",
        ])
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
        return Err(
            "sentence-transformers installation failed.\n\
             Check the terminal log above for details.\n\
             Common causes: no internet connection, disk full, outdated pip.".into()
        );
    }

    // Confirm by importing and reading the installed version
    let ver = Command::new(py_bin)
        .args(["-c",
            "import sentence_transformers; print(sentence_transformers.__version__)"])
        .stdout(Stdio::piped()).stderr(Stdio::null()).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());

    emit_progress(app, "install_deps",
        &format!("sentence-transformers {ver} installed successfully"), false);
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
    // step_upgrade_pip(&py_bin, app)?;

    // 5 — Install sentence-transformers (no-op if already present)
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

    let mut child = Command::new(&python)
        .arg("-u")
        .arg(script)
        .env_remove("CONDA_PREFIX")
        .env_remove("CONDA_DEFAULT_ENV")
        .env_remove("VIRTUAL_ENV")
        .env_remove("VIRTUAL_ENV_PROMPT")
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
    eprintln!("[PaperGraph] Python sidecar started (pid {})", sc.child.id());
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
            eprintln!("[PaperGraph] Sidecar crashed — restarting…");
        }
        eprintln!("dead !!");
        *guard = Some(launch_sidecar(&s.sidecar_script(), &s.venv_dir(), app)?);
    }
    Ok(guard)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Quick check: is the Python venv ready and sentence-transformers installed?
///
/// Does NOT start the sidecar or trigger any installation — purely reads the
/// filesystem.  JS calls this on startup to decide whether to show the
/// "Enable LLM module?" prompt.
///
/// Returns: { ready: bool, reason?: str }
#[tauri::command]
pub fn hf_setup_status(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let py = venv_python(&s.venv_dir());
    if !py.exists() {
        return Ok(serde_json::json!({
            "ready": false,
            "reason": "venv not created yet"
        }));
    }
    // Quick import check — fast because Python binary already exists
    let ok = std::process::Command::new(&py)
        .args(["-c", "import sentence_transformers"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|st| st.success())
        .unwrap_or(false);

    if ok {
        Ok(serde_json::json!({ "ready": true }))
    } else {
        Ok(serde_json::json!({
            "ready": false,
            "reason": "sentence-transformers not installed"
        }))
    }
}

/// Set up (or repair) the Python venv and install sentence-transformers.
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
    // If a live sidecar is already running, reuse it — no second spawn.
    {
        let mut guard = s.sidecar.lock().unwrap();
        if let Some(sc) = guard.as_mut() {
            if sc.is_alive() {
                eprintln!("[PaperGraph] hf_setup_venv: sidecar already live — reusing.");
                emit_progress(&app, "ready", "Similarity engine ready.", true);
                return Ok(serde_json::json!({ "ok": true }));
            }
            // Dead sidecar — drop it before relaunching.
            eprintln!("[PaperGraph] hf_setup_venv: dead sidecar found — relaunching.");
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
                eprintln!("[PaperGraph] hf_setup_venv background error: {e}");
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
    // Inject any cached embeddings to avoid redundant encoding in Python
    let model = config["model"].as_str()
        .unwrap_or("sentence-transformers/all-MiniLM-L6-v2");
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
    let mut guard = ensure_running(&s, &app)?;
    guard.as_mut().unwrap().call("list_models", serde_json::Value::Null)
}

/// Check whether the sidecar is running and which model is currently loaded.
///
/// Called from JS as: invoke("hf_sidecar_status")
/// Returns: { running: bool, details?: { loaded_model, python } }
#[tauri::command]
pub fn hf_sidecar_status(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
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
/// This command reads those lines in a loop, forwarding progress events
/// until the final reply arrives.
///
/// Also emits "venv://progress" with step="download_model" so the full-screen
/// venv overlay shows the download step as active.
///
/// Called from JS as: invoke("hf_download_model", { model })
/// Returns (on success): { path: str, done: true }
#[tauri::command]
pub fn hf_download_model(
    app:   tauri::AppHandle,
    s:     State<'_, AppState>,
    model: String,
) -> CmdResult<serde_json::Value> {
    // Show the download step in the venv overlay immediately.
    // emit_progress(&app, "download_model",
    //     &format!("Downloading {}…", model), false);

    let mut guard = ensure_running(&s, &app)?;
    let sc = guard.as_mut().unwrap();

    // Build and send the JSON-RPC request manually (not via sc.call()) so we
    // can intercept the intermediate progress lines before the final reply.
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

    // Read lines until we receive the final reply.
    loop {
        let mut line = String::new();
        sc.stdout.read_line(&mut line)
            .map_err(|e| format!("sidecar read: {e}"))?;

        let v: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("sidecar parse: {e} — got: {line}"))?;

        // Intermediate progress notification — forward to JS and keep reading.
        if let Some(prog) = v.get("progress") {
            let _ = app.emit("venv://model-progress", prog);
            continue;
        }

        // Final reply.
        if v["ok"].as_bool() != Some(true) {
            return Err(v["error"].as_str()
                .unwrap_or("download failed").to_string());
        }
        return Ok(v["result"].clone());
    }
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
    // println!("cached_field : {:?}", cached_fields);
    // println!("fields : {:?}", fields);
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
/// Called from JS as: invoke("hf_compute_paper_embedding", { paperId, config })
///
/// config shape: { model, fields, weights }
///
/// Returns: { paper_id, path, dim, cached: false }
#[tauri::command]
pub fn hf_compute_paper_embedding(
    app:      tauri::AppHandle,
    s:        State<'_, AppState>,
    paper_id: i64,
    config:   serde_json::Value,
) -> CmdResult<serde_json::Value> {
    // Load the paper from DB so Python has all fields (title, abstract, hashtags…)
    let paper: serde_json::Value = {
        let pool   = s.pool();
        let p = tauri::async_runtime::block_on(
            crate::db::get_paper(&pool, paper_id)
        ).map_err(|e| e.to_string())?;
        serde_json::to_value(p).map_err(|e| e.to_string())?
    };

    let mut guard = ensure_running(&s, &app)?;
    let result = guard.as_mut().unwrap()
        .call("compute_embedding", serde_json::json!({ "paper": paper, "config": config }))?;
    drop(guard);

    // Python returns { field_vectors: { "<field>": [f32, ...], ... }, dim: int }
    let field_vectors = result.get("field_vectors").cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let dim = result["dim"].as_u64().unwrap_or(0);

    let model  = config["model"].as_str().unwrap_or("sentence-transformers/all-MiniLM-L6-v2");
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);

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
    let path  = embedding_path_for_paper(&s, paper_id);
    let model = config["model"].as_str().unwrap_or("sentence-transformers/all-MiniLM-L6-v2");
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
/// Called when the user presses "Recompute Graph" — always writes fresh
/// field_vectors for every paper regardless of any existing cache.  This
/// guarantees that the stored raw vectors are up-to-date before
/// hf_compute_edges_from_cache recomposes them with the current weights.
///
/// Progress events: { paper_id, title, index, total, done? }
///
/// Called from JS as: invoke("hf_compute_all_embeddings", { config })
/// Returns: { total, computed }
#[tauri::command]
pub fn hf_compute_all_embeddings(
    app:    tauri::AppHandle,
    s:      State<'_, AppState>,
    config: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    // Load papers and resolve paths synchronously before spawning the thread,
    // to avoid passing the State<'_> reference (non-Send) across thread boundary.
    let model = config["model"].as_str()
        .unwrap_or("sentence-transformers/all-MiniLM-L6-v2")
        .to_string();
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);

    let papers: Vec<crate::db::PaperFull> = {
        let pool = s.pool();
        tauri::async_runtime::block_on(crate::db::get_all_papers(&pool))
            .map_err(|e| e.to_string())?
    };

    let projects_dir = s.projects_dir.clone();
    let current_slug = s.current_slug();
    let total        = papers.len();

    // Emit "started" immediately so the JS overlay appears before the thread runs.
    let _ = app.emit("embedding://progress", serde_json::json!({
        "started": true,
        "total":   total,
    }));

    // Spawn encoding loop on a background thread — command returns immediately
    // so Tauri can deliver per-paper progress events to the JS event loop.
    std::thread::spawn(move || {
        let mut computed = 0usize;

        for (index, paper) in papers.iter().enumerate() {
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
                        serde_json::json!({ "paper": paper_val, "config": &config }),
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

            let path = projects_dir
                .join(&current_slug)
                .join("pdfs")
                .join(paper.id.to_string())
                .join("embedding.json");

            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let payload = serde_json::json!({
                "model":         &model,
                "fields":        &fields,
                "field_vectors": field_vectors,
            });
            if let Err(e) = serde_json::to_string(&payload)
                .map_err(|e| e.to_string())
                .and_then(|s| std::fs::write(&path, s).map_err(|e| e.to_string()))
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
    let model = config["model"].as_str()
        .unwrap_or("sentence-transformers/all-MiniLM-L6-v2");
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
        let composite = read_embedding_cache(&path)
            .filter(|cache| embedding_cache_in_matches(cache, model, &fields))
            .and_then(|cache| recompose_embedding(&cache["field_vectors"], &fields, &weights));
        vecs.push(composite);
    }

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
                "source_id":  papers[i]["id"],
                "target_id":  papers[j]["id"],
                "similarity": (sim * 1_000_000.0).round() / 1_000_000.0,
                "weight":     weight,
                "edge_type":  etype,
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
    let path = s.data_dir.join("similarity_config.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
