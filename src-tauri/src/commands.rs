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
    let pdf_dir = s.pdfs_dir().join(id.to_string());
    if pdf_dir.exists() {
        let _ = std::fs::remove_dir_all(&pdf_dir);
    }

    // 2. Embedding: projects/<slug>/embeddings/<id>.json
    let embedding = s.projects_dir
        .join(s.current_slug())
        .join("embeddings")
        .join(format!("{id}.json"));
    if embedding.exists() {
        let _ = std::fs::remove_file(&embedding);
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
pub async fn save_alias(s: State<'_, AppState>, id: i64, alias: Option<String>) -> CmdResult<()> {
    logger::log_call("save_alias");
    db::save_alias(&s.pool(), id, alias.as_deref()).await.map_err(map_log_err!("save_alias"))
}

#[tauri::command]
pub async fn save_pdf_path(s: State<'_, AppState>, id: i64, path: Option<String>) -> CmdResult<()> {
    logger::log_call("save_pdf_path");
    db::save_pdf_path(&s.pool(), id, path.as_deref()).await.map_err(map_log_err!("save_pdf_path"))
}

/// Remove the PDF file from disk and clear its path in the DB.
/// Removes the `pdf` field vector from embedding.json (other field vectors
/// remain intact). Deletes the PDF file(s) but keeps the per-paper directory
/// so that embedding.json persists. Silently succeeds if no file exists.
#[tauri::command]
pub async fn delete_pdf_file(s: State<'_, AppState>, id: i64) -> CmdResult<()> {
    logger::log_call("delete_pdf_file");
    // 1. Clear the DB record first.
    db::save_pdf_path(&s.pool(), id, None).await.map_err(map_log_err!("delete_pdf_file"))?;

    let pdf_dir = s.pdfs_dir().join(id.to_string());

    // 2. Remove the `pdf` key from the embedding cache so stale vectors are
    //    not used if a new PDF is uploaded later with a different model.
    let emb_path = s.projects_dir
        .join(s.current_slug())
        .join("embeddings")
        .join(format!("{id}.json"));
    if let Some(mut cache) = read_embedding_cache(&emb_path) {
        remove_pdf_field_from_cache(&mut cache);
        if let Ok(serialized) = serde_json::to_string(&cache) {
            let _ = std::fs::write(&emb_path, serialized);
        }
    }

    // 3. Delete the PDF directory entirely.
    if pdf_dir.exists() {
        let _ = std::fs::remove_dir_all(&pdf_dir);
    }

    Ok(())
}

fn remove_pdf_field_from_cache(cache: &mut serde_json::Value) {
    if let Some(models) = cache.get_mut("models").and_then(|m| m.as_object_mut()) {
        for entry in models.values_mut() {
            if let Some(fv) = entry.get_mut("field_vectors").and_then(|f| f.as_object_mut()) {
                fv.remove("pdf");
            }
        }
    }
}

// ── AI Summary (section .md files) ───────────────────────────────────────────

/// Read all per-section .md files for a paper.
/// Returns {filename → content} for every *.md file in the PDF directory
/// except the combined paper.md.  Falls back to {"paper.md": content} when
/// only the legacy combined file exists (no individual section files).
#[tauri::command]
pub fn read_paper_md(
    s:        State<'_, AppState>,
    paper_id: i64,
) -> CmdResult<std::collections::HashMap<String, String>> {
    logger::log_call("read_paper_md");
    let pdf_dir = s.pdfs_dir().join(paper_id.to_string());
    let mut files: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if !pdf_dir.exists() {
        return Ok(files);
    }
    if let Ok(rd) = std::fs::read_dir(&pdf_dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") { continue; }
            let name = path.file_name()
                .unwrap_or_default().to_string_lossy().to_string();
            if name == "paper.md" || name == "PDF_TEXT.md" { continue; }
            if let Ok(content) = std::fs::read_to_string(&path) {
                files.insert(name, content);
            }
        }
    }
    // Fallback: if no individual section files, return legacy paper.md.
    if files.is_empty() {
        let md_path = pdf_dir.join("paper.md");
        if md_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&md_path) {
                files.insert("paper.md".to_string(), content);
            }
        }
    }
    logger::log_info("read_paper_md",
        &format!("paper_id={paper_id} {} file(s)", files.len()));
    Ok(files)
}

/// Rebuild the combined paper.md from all individual section files.
fn rebuild_paper_md(pdf_dir: &std::path::Path) {
    let mut entries: Vec<_> = std::fs::read_dir(pdf_dir)
        .into_iter().flatten().flatten()
        .filter(|e| {
            e.path().extension().and_then(|x| x.to_str()) == Some("md")
                && e.file_name().to_string_lossy() != "paper.md"
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());
    let combined: String = entries.iter()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter(|c| !c.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let _ = std::fs::write(pdf_dir.join("paper.md"), combined);
}

/// Persist user edits to a named section .md file and trigger re-embedding.
/// Also rebuilds the combined paper.md so downstream embedding stays in sync.
#[tauri::command]
pub fn save_paper_md(
    app:      tauri::AppHandle,
    s:        State<'_, AppState>,
    paper_id: i64,
    filename: String,
    content:  String,
) -> CmdResult<()> {
    logger::log_call("save_paper_md");
    let pdf_dir = s.pdfs_dir().join(paper_id.to_string());
    if !pdf_dir.exists() {
        return Err(format!(
            "PDF directory not found for paper {paper_id}. Upload a PDF first."
        ));
    }
    // Reject path traversal attempts.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    std::fs::write(pdf_dir.join(&filename), &content)
        .map_err(|e| format!("Failed to write {filename}: {e}"))?;
    rebuild_paper_md(&pdf_dir);
    logger::log_info("save_paper_md",
        &format!("paper_id={paper_id} saved {filename} ({} bytes), triggering re-embed",
            content.len()));
    embed_pdf_in_background(app, paper_id, s.pdfs_dir(), s.data_dir.clone(), false);
    Ok(())
}

/// Delete a single AI summary section file for a paper.
#[tauri::command]
pub fn delete_paper_md(
    s:        State<'_, AppState>,
    paper_id: i64,
    filename: String,
) -> CmdResult<()> {
    logger::log_call("delete_paper_md");
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }
    let pdf_dir = s.pdfs_dir().join(paper_id.to_string());
    let path    = pdf_dir.join(&filename);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete {filename}: {e}"))?;
        rebuild_paper_md(&pdf_dir);
        logger::log_info("delete_paper_md",
            &format!("paper_id={paper_id} deleted {filename}"));
    }
    Ok(())
}

/// Re-run AI summary generation for a paper (Steps 1 & 2 of embed_pdf_in_background).
/// Does not re-embed — only regenerates the MD section files.
#[tauri::command]
pub fn regenerate_paper_md(
    app:      tauri::AppHandle,
    s:        State<'_, AppState>,
    paper_id: i64,
) -> CmdResult<()> {
    logger::log_call("regenerate_paper_md");
    embed_pdf_in_background(app, paper_id, s.pdfs_dir(), s.data_dir.clone(), true);
    Ok(())
}

/// Open the folder that holds a paper's PDF and AI summary files.
#[tauri::command]
pub fn open_paper_folder(s: State<'_, AppState>, paper_id: i64) -> CmdResult<()> {
    logger::log_call("open_paper_folder");
    let pdf_dir = s.pdfs_dir().join(paper_id.to_string());
    std::fs::create_dir_all(&pdf_dir).ok();
    let path = pdf_dir.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "windows")]
    { std::process::Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "linux")]
    { std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?; }
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
    app:         tauri::AppHandle,
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
    embed_pdf_in_background(app, paper_id, s.pdfs_dir(), s.data_dir.clone(), true);
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
    app: tauri::AppHandle,
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
    embed_pdf_in_background(app, paper_id, s.pdfs_dir(), s.data_dir.clone(), true);
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
// HuggingFace / API similarity
// ═══════════════════════════════════════════════════════════════════════════════
//
// All embedding and generation calls go directly to cloud APIs (OpenAI /
// Anthropic) from Rust — no Python sidecar required.
// API keys are read from app_data_dir/app_config.json at call time.

use tauri::Emitter;


// ── Tauri commands ─────────────────────────────────────────────────────────────

/// Check whether the API key for the given model's provider is configured.
/// Returns { cached: bool, api: true }.
#[tauri::command]
pub fn hf_check_model(
    s:     State<'_, AppState>,
    model: String,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_check_model");
    let keys = crate::api_client::ApiKeys::load(&s.data_dir);
    let cached = if model.starts_with("openai:") {
        !keys.openai.is_empty()
    } else if model.starts_with("anthropic:") {
        !keys.anthropic.is_empty()
    } else {
        false
    };
    Ok(serde_json::json!({ "cached": cached, "api": true }))
}

/// Probe an arbitrary endpoint URL and report what was found.
/// Used by App Settings to validate the Model API Endpoint field.
/// `api_key` may be empty (for unauthenticated local servers).
#[tauri::command]
pub async fn test_api_endpoint(url: String, api_key: String) -> CmdResult<serde_json::Value> {
    logger::log_call("test_api_endpoint");
    if url.trim().is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "No URL provided." }));
    }
    match crate::api_client::test_endpoint(url.trim(), api_key.trim()).await {
        Ok(msg)  => Ok(serde_json::json!({ "ok": true,  "message": msg })),
        Err(err) => Ok(serde_json::json!({ "ok": false, "error":   err })),
    }
}

/// Test that the configured API endpoint is reachable.
/// Priority mirrors embed() / generate(): custom base_url → Anthropic → OpenAI.
/// Returns { ok: bool, provider: str, error?: str }.
#[tauri::command]
pub async fn check_api_connection(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("check_api_connection");
    let keys = crate::api_client::ApiKeys::load(&s.data_dir);

    if !keys.base_url.is_empty() {
        return match crate::api_client::openai_check(&keys.openai, &keys.base_url).await {
            Ok(())  => Ok(serde_json::json!({ "ok": true,  "provider": "custom" })),
            Err(e)  => Ok(serde_json::json!({ "ok": false, "provider": "custom", "error": e })),
        };
    }
    if !keys.anthropic.is_empty() {
        return match crate::api_client::anthropic_check(&keys.anthropic).await {
            Ok(())  => Ok(serde_json::json!({ "ok": true,  "provider": "anthropic" })),
            Err(e)  => Ok(serde_json::json!({ "ok": false, "provider": "anthropic", "error": e })),
        };
    }
    if !keys.openai.is_empty() {
        return match crate::api_client::openai_check(&keys.openai, crate::api_client::OPENAI_DEFAULT_BASE).await {
            Ok(())  => Ok(serde_json::json!({ "ok": true,  "provider": "openai" })),
            Err(e)  => Ok(serde_json::json!({ "ok": false, "provider": "openai", "error": e })),
        };
    }
    Ok(serde_json::json!({
        "ok":    false,
        "error": "No API key or endpoint configured. Add one in App Settings → API."
    }))
}

/// Fetch the model list from the configured custom API endpoint.
/// Returns { ok: bool, models: [str], error?: str }.
/// Returns { ok: false, models: [] } when no custom endpoint is configured.
#[tauri::command]
pub async fn list_api_models(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("list_api_models");
    let keys = crate::api_client::ApiKeys::load(&s.data_dir);
    if keys.base_url.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "models": [] }));
    }
    match crate::api_client::list_models(&keys.openai, &keys.base_url).await {
        Ok(ids) => Ok(serde_json::json!({ "ok": true, "models": ids })),
        Err(e)  => Ok(serde_json::json!({ "ok": false, "models": [], "error": e })),
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

/// Current UTC time as an ISO 8601 string, e.g. "2026-03-28T12:34:56.789Z".
/// Used to stamp `written_at` inside embedding.json so staleness can be
/// detected by comparing against `papers.updated_at`.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let secs  = ms / 1000;
    let millis = ms % 1000;
    // Decompose unix seconds into calendar fields (no external crate needed).
    let (y, mo, d, h, mi, s) = unix_secs_to_ymd_hms(secs as u64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

fn unix_secs_to_ymd_hms(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let h  = (secs / 3600) % 24;
    let mi = (secs / 60)   % 60;
    let s  = secs % 60;
    let days = secs / 86400;
    // Shift epoch to 1 Mar 0000 for easy leap-year math (Gregorian).
    let z   = days + 719468;
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y   = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp  = (5*doy + 2) / 153;
    let d   = doy - (153*mp + 2)/5 + 1;
    let mo  = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if mo <= 2 { y + 1 } else { y };
    (y, mo, d, h, mi, s)
}

/// Returns true when the paper has been updated after the embedding was written,
/// or when the embedding predates this staleness-tracking feature (no `written_at`).
fn is_embedding_stale(paper_updated_at: &str, cache: &serde_json::Value) -> bool {
    match cache["written_at"].as_str() {
        Some(written) => paper_updated_at > written, // ISO 8601 lexicographic compare
        None          => true,                        // old format — treat as stale
    }
}

fn embedding_path_for_paper(s: &AppState, paper_id: i64) -> std::path::PathBuf {
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

/// Returns true when the cache covers every requested field with a stored vector.
///
/// This is a superset check: the cache may contain MORE fields than requested —
/// that is fine.  recompose_embedding selects only the relevant subset.
/// Weights are not compared — the cache stores raw per-field vectors so the
/// composite can be recomposed locally without re-encoding when weights change.
/// Extract the per-model embedding entry from a cache file.
/// Handles both formats:
///   New: { "models": { "<model>": { "field_vectors": {...}, "written_at": "..." } } }
///   Old: { "model": "<model>", "field_vectors": {...}, "written_at": "..." }
fn get_model_entry(cache: &serde_json::Value, model: &str) -> Option<serde_json::Value> {
    if let Some(models) = cache["models"].as_object() {
        return models.get(model).cloned();
    }
    if cache["model"].as_str() == Some(model) {
        return Some(cache.clone());
    }
    None
}

fn embedding_cache_matches(
    cache:  &serde_json::Value,
    model:  &str,
    fields: &[String],
) -> bool {
    let entry = match get_model_entry(cache, model) {
        Some(e) => e,
        None    => return false,
    };
    let fv = match entry["field_vectors"].as_object() {
        Some(m) => m,
        None    => return false,
    };
    fields.iter().all(|f| fv.contains_key(f.as_str()))
}


/// Merge `new_fv` into an existing embedding cache file and write it back.
///
/// If the file already exists and was written for the same model, its
/// field_vectors are preserved and the new ones are overlaid on top (new
/// vectors win, allowing stale individual fields to be refreshed while
/// keeping unrelated fields intact).  If the model differs, the old data
/// is discarded — field vectors from a different model are not comparable.
fn write_merged_embedding(
    path:       &std::path::Path,
    model:      &str,
    new_fv:     &serde_json::Value,
    written_at: &str,
) -> Result<(), String> {
    let existing = read_embedding_cache(path).unwrap_or_else(|| serde_json::json!({}));

    // Build models map, migrating old flat format on first write.
    let mut models: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    if let Some(existing_models) = existing["models"].as_object() {
        models.extend(existing_models.clone());
    } else if let Some(old_model) = existing["model"].as_str() {
        models.insert(old_model.to_string(), serde_json::json!({
            "field_vectors": existing["field_vectors"].clone(),
            "written_at":    existing["written_at"].clone(),
        }));
    }

    // Merge new vectors into this model's entry (new vectors win over old).
    let mut merged_fv: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    if let Some(current) = models.get(model) {
        if let Some(obj) = current["field_vectors"].as_object() {
            merged_fv.extend(obj.clone());
        }
    }
    if let Some(obj) = new_fv.as_object() {
        merged_fv.extend(obj.clone());
    }
    models.insert(model.to_string(), serde_json::json!({
        "field_vectors": serde_json::Value::Object(merged_fv),
        "written_at":    written_at,
    }));

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create embedding dir: {e}"))?;
    }
    let payload = serde_json::json!({ "models": serde_json::Value::Object(models) });
    serde_json::to_string(&payload)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(path, s).map_err(|e| e.to_string()))
        .map_err(|e| format!("Cannot write embedding: {e}"))
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
    let model = config["model"].as_str().unwrap_or("");
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if let Some(cache) = read_embedding_cache(&path) {
        if embedding_cache_matches(&cache, model, &fields) {
            let entry        = get_model_entry(&cache, model).unwrap_or_default();
            let field_vectors = entry["field_vectors"].clone();
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

// ── MD generation helpers ─────────────────────────────────────────────────────

fn parse_md_sections(text: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current_file: Option<String> = None;
    let mut current_lines: Vec<&str>    = Vec::new();
    for line in text.lines() {
        if let Some(fname) = line.strip_prefix("FILE: ") {
            if let Some(file) = current_file.take() {
                let body = current_lines.join("\n").trim().to_string();
                if !body.is_empty() { sections.push((file, body)); }
                current_lines.clear();
            }
            current_file = Some(fname.trim().to_string());
        } else if current_file.is_some() {
            current_lines.push(line);
        }
    }
    if let Some(file) = current_file {
        let body = current_lines.join("\n").trim().to_string();
        if !body.is_empty() { sections.push((file, body)); }
    }
    sections
}

/// Read the text that should be embedded for a given field from a paper.
fn field_text(
    field:   &str,
    paper:   &crate::db::PaperFull,
    pdf_dir: &std::path::Path,
) -> Option<String> {
    match field {
        "title"  => Some(paper.title.clone()),
        "abstract" => paper.attributes.iter()
            .find(|a| a.key == "abstract")
            .map(|a| a.value.clone())
            .filter(|s| !s.is_empty()),
        "hashtags" => {
            let t = paper.hashtags.join(", ");
            if t.is_empty() { None } else { Some(t) }
        }
        "notes" => paper.notes.clone().filter(|n| !n.is_empty()),
        "pdf"   => paper.pdf_path.as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| crate::api_client::extract_pdf_text(p).ok()),
        _ if field.starts_with("md_") => {
            let suffix = &field[3..];
            let uppercase = suffix.to_uppercase();
            // Try UPPERCASE.md first, then suffix.md.
            std::fs::read_to_string(pdf_dir.join(format!("{uppercase}.md"))).ok()
                .or_else(|| std::fs::read_to_string(pdf_dir.join(format!("{suffix}.md"))).ok())
        }
        _ => None,
    }
}

/// Generate per-section MD files for a paper using the best available API.
/// Writes Overview.md, Motivation.md, Contributions.md, Method.md,
/// Experiments.md, Limitations.md, Takeaways.md into `pdf_dir`.
fn generate_paper_md(
    paper:   &crate::db::PaperFull,
    pdf_dir: &std::path::Path,
    keys:    &crate::api_client::ApiKeys,
) {
    let pdf_text = paper.pdf_path.as_deref()
        .filter(|p| !p.is_empty())
        .and_then(|p| crate::api_client::extract_pdf_text(p).ok())
        .unwrap_or_default();

    let system = "You are an expert research assistant.\n\
        Read the provided PDF and generate a paper summary.\n\n\
        IMPORTANT OUTPUT FORMAT:\n\n\
        Your entire response MUST consist of a sequence of files.\n\n\
        Each file MUST begin with:\n\n\
        FILE: <filename>\n\n\
        Rules:\n\
        1. Output only file contents.\n\
        2. Do not wrap files in code blocks.\n\
        3. Do not add explanations before or after the files.\n\
        4. Every file must start with exactly: FILE: <filename>\n\
        5. Use Markdown formatting inside each file.\n\
        6. Use only information explicitly stated in the PDF.\n\
        7. If information is missing, write: Not specified in the paper.";

    let user = format!(
        "PDF content:\n{pdf}\n\n\
         Generate the following files:\n\n\
         FILE: Overview.md\n\
         Contents:\n\
         - Title\n\
         - Authors\n\
         - Venue\n\
         - Year\n\
         - Abstract-style summary (300-500 words)\n\n\
         FILE: Motivation.md\n\
         Contents:\n\
         - Problem statement\n\
         - Research gap\n\
         - Limitations of prior work\n\
         - Motivation\n\
         - Key observations\n\n\
         FILE: Contributions.md\n\
         Contents:\n\
         - Complete list of contributions\n\
         - Detailed explanation of each contribution\n\
         - Novelty compared with prior work\n\n\
         FILE: Method.md\n\
         Contents:\n\
         - Overall framework\n\
         - Architecture\n\
         - Mathematical formulations\n\
         - Loss functions\n\
         - Algorithms\n\
         - Training procedure\n\
         - Hyperparameters\n\
         - Implementation details\n\n\
         FILE: Experiments.md\n\
         Contents:\n\
         # Experimental Setup\n\
         ## Datasets\n\
         For every dataset: Name, Purpose, Number of samples (if provided), Task\n\
         ## Evaluation Metrics\n\
         ## Baselines\n\
         ## Tested Models\n\
         # Main Results\n\
         For EVERY table and figure containing quantitative results:\n\
         - Experiment name, Dataset, Metrics, Compared methods,\n\
           Exact numerical results, Authors conclusions\n\
         Include all reported performance numbers.\n\
         # Ablation Studies\n\
         For every ablation: Component changed, Settings, Results, Conclusions\n\
         # Qualitative Results\n\
         # Analysis\n\n\
         FILE: Limitations.md\n\
         Contents:\n\
         - Limitations explicitly mentioned by the authors\n\
         - Failure cases\n\
         - Future work\n\n\
         FILE: Takeaways.md\n\
         Contents:\n\
         - 5-10 key findings\n\
         - Important insights\n\
         - Practical implications\n\n\
         Reminder:\n\
         - Do not infer information.\n\
         - Do not use external knowledge.\n\
         - Report exact numbers whenever available.\n\
         - Preserve equations and notation when useful.",
        pdf = pdf_text,
    );

    let max_tokens = tauri::async_runtime::block_on(
        crate::api_client::get_max_output_tokens(keys)
    );
    logger::log_info("generate_paper_md",
        &format!("paper_id={} max_tokens={max_tokens}", paper.id));

    let response = match tauri::async_runtime::block_on(
        crate::api_client::generate(keys, system, &user, max_tokens)
    ) {
        Ok(r)  => r,
        Err(e) => { logger::log_error("generate_paper_md", &e); return; }
    };

    let _ = std::fs::create_dir_all(pdf_dir);
    for (filename, content) in parse_md_sections(&response) {
        let _ = std::fs::write(pdf_dir.join(&filename), &content);
    }
    rebuild_paper_md(pdf_dir);
    logger::log_info("generate_paper_md",
        &format!("paper_id={} MD written to {}", paper.id, pdf_dir.display()));
}

// All PDF-related field keys that carry per-paper content from the paper.md.
const PDF_EMBED_FIELDS: &[&str] = &[
    "pdf", "md_summary", "md_motivation", "md_contribution",
    "md_method", "md_methods", "md_experiment", "md_conclusion",
];

/// Embed a paper's fields in the background using cloud APIs.
///
/// * `generate_md` = true  — generate paper.md sections first (fresh upload flow).
/// * `generate_md` = false — skip generation, re-embed from existing .md files (edit flow).
fn embed_pdf_in_background(
    app:         tauri::AppHandle,
    paper_id:    i64,
    pdfs_dir:    std::path::PathBuf,
    data_dir:    std::path::PathBuf,
    generate_md: bool,
) {
    logger::log_info("embed_pdf_in_background",
        &format!("paper_id={paper_id} generate_md={generate_md} spawning"));
    std::thread::spawn(move || {
        let sim_cfg: serde_json::Value = std::fs::read_to_string(
            data_dir.join("similarity_config.json")
        )
        .ok()
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_else(|| serde_json::json!({}));

        let model = sim_cfg["model"]
            .as_str()
            .unwrap_or("openai:text-embedding-3-small")
            .to_string();

        let keys = crate::api_client::ApiKeys::load(&data_dir);

        let state = app.state::<AppState>();
        let paper = match tauri::async_runtime::block_on(
            crate::db::get_paper(&state.pool(), paper_id)
        ) {
            Ok(p)  => p,
            Err(e) => {
                logger::log_error("embed_pdf_in_background",
                    &format!("paper_id={paper_id} db error: {e}"));
                return;
            }
        };

        let pdf_dir = pdfs_dir.join(paper_id.to_string());

        // Step 1 — extract raw PDF text and store as PDF_TEXT.md (fresh upload only).
        // Runs regardless of API availability so the text is always persisted.
        if generate_md {
            if let Some(pdf_path) = paper.pdf_path.as_deref().filter(|p| !p.is_empty()) {
                match crate::api_client::extract_pdf_text(pdf_path) {
                    Ok(text) if !text.trim().is_empty() => {
                        let content = format!("# PDF Text\n\n{text}");
                        let out = pdf_dir.join("PDF_TEXT.md");
                        match std::fs::write(&out, &content) {
                            Ok(_) => {
                                rebuild_paper_md(&pdf_dir);
                                logger::log_info("embed_pdf_in_background",
                                    &format!("paper_id={paper_id} PDF_TEXT.md written ({} chars)", text.len()));
                            }
                            Err(e) => logger::log_error("embed_pdf_in_background",
                                &format!("paper_id={paper_id} write PDF_TEXT.md: {e}")),
                        }
                    }
                    Ok(_)  => logger::log_info("embed_pdf_in_background",
                        &format!("paper_id={paper_id} PDF text extraction returned empty")),
                    Err(e) => logger::log_error("embed_pdf_in_background",
                        &format!("paper_id={paper_id} PDF text extraction failed: {e}")),
                }
            }
        }

        // Step 2 — generate AI summary sections (fresh upload + API available).
        if generate_md && keys.has_any() {
            logger::log_info("embed_pdf_in_background",
                &format!("paper_id={paper_id} generating MD"));
            generate_paper_md(&paper, &pdf_dir, &keys);
        }

        // Step 2 — embed fields (only when HF strategy is active).
        if sim_cfg["strategy"].as_str() != Some("hf-embeddings") { return; }
        if !keys.has_any() { return; }

        let has_pdf = paper.pdf_path.as_deref().map(|p| !p.is_empty()).unwrap_or(false);

        let mut field_vectors: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for &field in PDF_EMBED_FIELDS.iter()
            .filter(|&&f| has_pdf || (f != "pdf" && !f.starts_with("md_")))
        {
            let text = match field_text(field, &paper, &pdf_dir) {
                Some(t) if !t.is_empty() => t,
                _ => continue,
            };
            match tauri::async_runtime::block_on(
                crate::api_client::embed(&keys, &model, &text)
            ) {
                Ok(vec) => {
                    field_vectors.insert(
                        field.to_string(),
                        serde_json::Value::Array(
                            vec.iter().map(|&v| serde_json::json!(v)).collect()
                        ),
                    );
                }
                Err(e) => logger::log_error("embed_pdf_in_background", &e),
            }
        }

        let emb_dir = pdfs_dir.parent()
            .map(|d| d.join("embeddings"))
            .unwrap_or_else(|| pdfs_dir.join("embeddings"));
        let _ = std::fs::create_dir_all(&emb_dir);
        let emb_path   = emb_dir.join(format!("{paper_id}.json"));
        let written_at = chrono_now_iso();
        let fv = serde_json::Value::Object(field_vectors);
        let _ = write_merged_embedding(&emb_path, &model, &fv, &written_at);
        logger::log_info("embed_pdf_in_background",
            &format!("paper_id={paper_id} embeddings written"));
    });
}

/// Re-encode every paper in the current project using cloud API embeddings.
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
    println!("config : {:?}", config);
    let model = config["model"]
        .as_str()
        .unwrap_or("openai:text-embedding-3-small")
        .to_string();
    let skip_fresh = config["skip_fresh"].as_bool().unwrap_or(false);
    logger::log_info("hf_compute_all_embeddings",
        &format!("model={model} skip_fresh={skip_fresh}"));

    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);

    let papers: Vec<crate::db::PaperFull> = {
        let pool = s.pool();
        tauri::async_runtime::block_on(crate::db::get_all_papers(&pool))
            .map_err(|e| e.to_string())?
    };

    let emb_dir = s.projects_dir.join(s.current_slug()).join("embeddings");
    std::fs::create_dir_all(&emb_dir).ok();

    let work: Vec<(crate::db::PaperFull, std::path::PathBuf, Vec<String>)> = papers
        .into_iter()
        .map(|paper| {
            let emb_path = emb_dir.join(format!("{}.json", paper.id));
            let has_pdf  = paper.pdf_path.as_deref().map(|p| !p.is_empty()).unwrap_or(false);
            let effective_fields: Vec<String> = fields.iter()
                .filter(|f| has_pdf || (*f != "pdf" && !f.starts_with("md_")))
                .cloned()
                .collect();
            (paper, emb_path, effective_fields)
        })
        .filter_map(|(paper, emb_path, eff_fields)| {
            if !skip_fresh { return Some((paper, emb_path, eff_fields)); }
            let cache = read_embedding_cache(&emb_path);
            let entry  = cache.as_ref().and_then(|c| get_model_entry(c, &model));
            match entry {
                Some(ref e) if !is_embedding_stale(&paper.updated_at, e) => {
                    let missing: Vec<String> = eff_fields.iter()
                        .filter(|f| e["field_vectors"].as_object()
                            .map(|m| !m.contains_key(f.as_str()))
                            .unwrap_or(true))
                        .cloned()
                        .collect();
                    if missing.is_empty() { None } else { Some((paper, emb_path, missing)) }
                }
                _ => Some((paper, emb_path, eff_fields)),
            }
        })
        .collect();

    let total = work.len();
    logger::log_info("hf_compute_all_embeddings",
        &format!("papers to encode: {total}"));

    let _ = app.emit("embedding://progress", serde_json::json!({
        "started": true,
        "total":   total,
    }));

    let data_dir = s.data_dir.clone();

    std::thread::spawn(move || {
        let keys = crate::api_client::ApiKeys::load(&data_dir);
        if !keys.has_any() {
            let _ = app.emit("embedding://error", serde_json::json!({
                "error": "No API key configured. Add an OpenAI key in App Settings."
            }));
            return;
        }

        let mut computed = 0usize;

        for (index, (paper, emb_path, paper_fields)) in work.iter().enumerate() {
            logger::log_info("hf_compute_all_embeddings", &format!(
                "[{}/{}] paper_id={} title={:?} fields={:?}",
                index + 1, total, paper.id, paper.title, paper_fields
            ));
            let _ = app.emit("embedding://progress", serde_json::json!({
                "paper_id": paper.id,
                "title":    &paper.title,
                "index":    index,
                "total":    total,
            }));

            let pdf_dir = emb_path.parent()
                .and_then(|p| p.parent())
                .map(|p| p.join("pdfs").join(paper.id.to_string()))
                .unwrap_or_else(|| std::path::PathBuf::from(""));

            let mut field_vectors: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
            for field in paper_fields {
                let text = match field_text(field, paper, &pdf_dir) {
                    Some(t) if !t.is_empty() => t,
                    _ => continue,
                };
                match tauri::async_runtime::block_on(
                    crate::api_client::embed(&keys, &model, &text)
                ) {
                    Ok(vec) => {
                        field_vectors.insert(
                            field.clone(),
                            serde_json::Value::Array(
                                vec.iter().map(|&v| serde_json::json!(v)).collect()
                            ),
                        );
                    }
                    Err(e) => {
                        let _ = app.emit("embedding://error", serde_json::json!({ "error": &e }));
                        logger::log_error("hf_compute_all_embeddings", &e);
                        return;
                    }
                }
            }

            let written_at = chrono_now_iso();
            let fv = serde_json::Value::Object(field_vectors);
            if let Err(e) = write_merged_embedding(emb_path, &model, &fv, &written_at) {
                let _ = app.emit("embedding://error", serde_json::json!({ "error": &e }));
                return;
            }
            computed += 1;
        }

        let _ = app.emit("embedding://progress", serde_json::json!({
            "done":     true,
            "total":    total,
            "computed": computed,
        }));
    });

    Ok(serde_json::json!({ "ok": true, "background": true, "total": total }))
}

#[tauri::command]
pub fn hf_compute_edges_from_cache(
    s:      State<'_, AppState>,
    papers: Vec<serde_json::Value>,
    config: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    logger::log_call("hf_compute_edges_from_cache");
    let model = config["model"].as_str().unwrap_or("");
    logger::log_info("hf_compute_edges_from_cache", &format!("papers={} model={model}", papers.len()));
    let fields: Vec<String> = config["fields"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["title".into(), "abstract".into(), "hashtags".into()]);
    let weights   = config.get("weights").cloned()
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let threshold = config["threshold"].as_f64().unwrap_or(0.38);
    let max_edges = config["max_edges"].as_u64().unwrap_or(7) as usize;
    // Build (paper_json, composite_vector) pairs.
    // Papers without a cache file, with a stale cache, or with a mismatched
    // model/fields are given None and produce no edges.
    let mut vecs: Vec<Option<Vec<f64>>> = Vec::with_capacity(papers.len());
    for paper in &papers {
        let id = match paper["id"].as_i64() { Some(v) => v, None => { vecs.push(None); continue; } };
        let updated_at = paper["updated_at"].as_str().unwrap_or("");
        let path = embedding_path_for_paper(&s, id);
        let cache_val  = read_embedding_cache(&path);
        let entry_opt  = cache_val.as_ref().and_then(|c| get_model_entry(c, model));
        let composite  = entry_opt
            .filter(|e| !is_embedding_stale(updated_at, e))
            .and_then(|e| recompose_embedding(&e["field_vectors"], &fields, &weights));
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
    logger::log_info("hf_compute_edges_from_cache", &format!("edges produced: {count}"));
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
        return Ok(serde_json::json!({ "openai_api_key": null, "anthropic_api_key": null }));
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
pub fn open_folder(path: String) -> CmdResult<()> {
    logger::log_call("open_folder");
    use std::process::Command;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    { Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "windows")]
    { Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "linux")]
    { Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}

/// Return key data-directory paths so the frontend can display and open them.
#[tauri::command]
pub fn get_dirs(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("get_dirs");
    Ok(serde_json::json!({
        "data_dir":   s.data_dir.to_string_lossy(),
    }))
}

/// Check per-paper AI readiness: embedding presence, PDF-field coverage, summary files.
/// Returns a summary count plus per-paper detail for the current project.
#[tauri::command]
pub fn get_papers_ai_status(s: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    logger::log_call("get_papers_ai_status");
    let pool         = s.pool();
    let pdfs_dir     = s.pdfs_dir();
    // Embeddings are stored at projects/<slug>/embeddings/<id>.json
    let embeddings_dir = s.projects_dir.join(s.current_slug()).join("embeddings");

    let rows: Vec<(i64, String)> = tauri::async_runtime::block_on(async {
        sqlx::query_as("SELECT id, title FROM papers ORDER BY id")
            .fetch_all(&pool).await
    }).map_err(|e| e.to_string())?;

    let mut papers = Vec::with_capacity(rows.len());
    let (mut n_emb, mut n_pdf_emb, mut n_summary) = (0usize, 0usize, 0usize);

    for (id, title) in &rows {
        // ── Embedding cache ───────────────────────────────────────────────────
        // Primary location: projects/<slug>/embeddings/<id>.json
        let emb_path = embeddings_dir.join(format!("{id}.json"));
        let (has_embedding, has_pdf_embedding) = if emb_path.exists() {
            let has_pdf = std::fs::read_to_string(&emb_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .map(|v| {
                    // New format: { "models": { "<model>": { "field_vectors": { "pdf": [...] } } } }
                    // Old format: { "model": "...", "field_vectors": { "pdf": [...] } }
                    let field_vectors = if let Some(models) = v["models"].as_object() {
                        models.values()
                            .find_map(|entry| entry.get("field_vectors").cloned())
                    } else {
                        v.get("field_vectors").cloned()
                    };
                    field_vectors
                        .and_then(|fv| fv["pdf"].as_array().map(|a| !a.is_empty()))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            (true, has_pdf)
        } else {
            (false, false)
        };

        // ── AI summary section files ──────────────────────────────────────────
        // Section .md files live alongside the PDF: projects/<slug>/pdfs/<id>/
        let pdf_dir = pdfs_dir.join(id.to_string());
        let has_summary = pdf_dir.exists() && std::fs::read_dir(&pdf_dir)
            .into_iter().flatten().flatten()
            .any(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.ends_with(".md")
                    && name != "paper.md"
                    && name != "PDF_TEXT.md"
            });

        if has_embedding     { n_emb     += 1; }
        if has_pdf_embedding { n_pdf_emb += 1; }
        if has_summary       { n_summary += 1; }

        papers.push(serde_json::json!({
            "id":                id,
            "title":             title,
            "has_embedding":     has_embedding,
            "has_pdf_embedding": has_pdf_embedding,
            "has_summary":       has_summary,
        }));
    }

    let total = rows.len();
    Ok(serde_json::json!({
        "papers": papers,
        "summary": {
            "total":                 total,
            "has_embedding":         n_emb,
            "has_pdf_embedding":     n_pdf_emb,
            "has_summary":           n_summary,
            "missing_embedding":     total - n_emb,
            "missing_pdf_embedding": total - n_pdf_emb,
            "missing_summary":       total - n_summary,
        }
    }))
}