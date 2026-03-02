// src-tauri/src/commands.rs

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
    db::delete_paper(&s.pool(), id).await.map_err(String::from)
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

fn find_python() -> Result<String, String> {
    for bin in &["python3", "python"] {
        let ok = Command::new(bin)
            .arg("--version")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false);
        if ok { return Ok(bin.to_string()); }
    }
    Err("Python 3 not found on PATH. \
         Please install Python 3 and run: pip install sentence-transformers".into())
}

fn launch_sidecar(script: &str) -> Result<PySidecar, String> {
    let python = find_python()?;

    let mut child = Command::new(&python)
        .arg("-u")               // unbuffered stdout — essential for the protocol
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // Python errors surface in the Tauri dev console
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar at '{script}': {e}"))?;

    let stdin  = child.stdin.take().ok_or("no sidecar stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("no sidecar stdout")?);

    let mut sc = PySidecar { child, stdin, stdout, next_id: 1 };

    // Python emits one handshake line before entering the request loop:
    //   {"id": 0, "ok": true, "result": "ready"}
    let mut handshake = String::new();
    sc.stdout.read_line(&mut handshake)
        .map_err(|e| format!("sidecar handshake read: {e}"))?;

    let v: serde_json::Value = serde_json::from_str(handshake.trim())
        .map_err(|e| format!("sidecar handshake parse: {e}\ngot: {handshake}"))?;

    if v["ok"].as_bool() != Some(true) {
        return Err(format!("sidecar startup failed: {}", v["error"]));
    }

    eprintln!("[PaperGraph] Python sidecar started (pid {})", sc.child.id());
    Ok(sc)
}

/// Ensure the sidecar is running; (re)start it if it crashed or was never started.
fn ensure_running(s: &AppState) -> Result<std::sync::MutexGuard<'_, Option<PySidecar>>, String> {
    let mut guard = s.sidecar.lock().unwrap();
    let dead = match guard.as_mut() {
        None     => true,
        Some(sc) => !sc.is_alive(),
    };
    if dead {
        if guard.is_some() {
            eprintln!("[PaperGraph] Sidecar crashed — restarting…");
        }
        *guard = Some(launch_sidecar(&s.sidecar_script())?);
    }
    Ok(guard)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Compute similarity edges using a HuggingFace sentence-transformer model.
///
/// Called from JS as: invoke("hf_compute_similarity", { papers, config })
///
/// config shape:
///   { model, fields, weights, threshold, max_edges }
///
/// Returns: { edges: EdgeInput[], count: number }
#[tauri::command]
pub fn hf_compute_similarity(
    s:      State<'_, AppState>,
    papers: Vec<serde_json::Value>,
    config: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    let mut guard = ensure_running(&s)?;
    guard.as_mut().unwrap()
        .call("compute", serde_json::json!({ "papers": papers, "config": config }))
}

/// Retrieve the list of supported models and fields from the sidecar.
///
/// Called from JS as: invoke("hf_list_models")
/// Returns: { models: [...], fields: [...] }
#[tauri::command]
pub fn hf_list_models(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let mut guard = ensure_running(&s)?;
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