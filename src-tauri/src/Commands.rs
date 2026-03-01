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
//
// store_pdf_bytes(paper_id, filename, data_base64) → stored_path
//   Writes raw bytes (base64-encoded) into  pdfs/<paper_id>/<filename>
//   and persists the path to the DB.
//   This is the primary PDF upload path — it works in all Tauri/browser
//   environments because it never needs a source filesystem path.

#[tauri::command]
pub async fn store_pdf_bytes(
    s:            State<'_, AppState>,
    paper_id:     i64,
    filename:     String,
    data_base64:  String,
) -> CmdResult<String> {
    use std::io::Write;

    // Decode base64
    let bytes = base64_decode(&data_base64)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    // Sanitise the filename — keep only the last path component
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

    // Persist path to DB
    db::save_pdf_path(&s.pool(), paper_id, Some(&dest.to_string_lossy()))
        .await.map_err(String::from)?;

    Ok(dest.to_string_lossy().to_string())
}

// Minimal base64 decoder (avoids adding a crate dependency).
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    // Strip the optional data-URL prefix  "data:application/pdf;base64,"
    let b64 = if let Some(idx) = input.find("base64,") {
        &input[idx + 7..]
    } else {
        input
    };

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
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

// copy_pdf — kept for any legacy callers; tries a filesystem copy when the
// source path resolves to an existing file, otherwise returns an error that
// tells callers to use store_pdf_bytes instead.
#[tauri::command]
pub async fn copy_pdf(
    s:        State<'_, AppState>,
    paper_id: i64,
    src_path: String,
) -> CmdResult<String> {
    let src = std::path::Path::new(&src_path);

    if !src.exists() {
        return Err(format!(
            "Source file not found: \"{src_path}\". \
             Use store_pdf_bytes to upload from a browser file picker."
        ));
    }

    let filename = src.file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy()
        .to_string();

    let dest_dir = s.pdfs_dir().join(paper_id.to_string());
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create pdf dir: {e}"))?;

    let dest = dest_dir.join(&filename);
    std::fs::copy(src, &dest)
        .map_err(|e| format!("Failed to copy PDF: {e}"))?;

    db::save_pdf_path(&s.pool(), paper_id, Some(&dest.to_string_lossy()))
        .await.map_err(String::from)?;

    Ok(dest.to_string_lossy().to_string())
}

// get_pdf_url(paper_id) → convertFileSrc-ready path string (or empty if none)
#[tauri::command]
pub async fn get_pdf_url(s: State<'_, AppState>, paper_id: i64) -> CmdResult<String> {
    let paper = db::get_paper(&s.pool(), paper_id).await.map_err(String::from)?;
    Ok(paper.pdf_path.unwrap_or_default())
}

// read_pdf_bytes(paper_id) → base64-encoded PDF bytes (or error if not found)
// Used by the frontend to display PDFs via a blob: URL — avoids asset://
// protocol CSP/scope issues entirely.
#[tauri::command]
pub async fn read_pdf_bytes(s: State<'_, AppState>, paper_id: i64) -> CmdResult<String> {
    let paper = db::get_paper(&s.pool(), paper_id).await.map_err(String::from)?;
    let path = paper.pdf_path.ok_or("No PDF stored for this paper")?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Cannot read PDF at \"{path}\": {e}"))?;
    Ok(base64_encode(&bytes))
}

fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { CHARS[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[(n & 63) as usize] as char } else { '=' });
    }
    out
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
    let mut out = String::new(); let mut prev = ' ';
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
    // Ensure unique slug
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
    // Create folder + empty DB
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
    if projects.len() <= 1 {
        return Err("Cannot delete the last project".into());
    }
    projects.retain(|p| p.slug != slug);
    // Delete folder from disk
    let dir = s.projects_dir.join(&slug);
    let _ = std::fs::remove_dir_all(dir);
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