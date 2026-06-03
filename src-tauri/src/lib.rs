// src-tauri/src/lib.rs

mod db;
mod commands;
mod logger;
mod api_client;

use commands::*;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use sqlx::SqlitePool;

// ── AppState ──────────────────────────────────────────────────────────────────

pub struct AppState {
    pub pool:         Mutex<SqlitePool>,
    pub projects_dir: PathBuf,
    pub current_slug: Mutex<String>,
    pub data_dir:     PathBuf,
}

impl AppState {
    pub fn pool(&self) -> SqlitePool {
        self.pool.lock().unwrap().clone()
    }
    pub fn current_slug(&self) -> String {
        self.current_slug.lock().unwrap().clone()
    }
    pub fn pdfs_dir(&self) -> PathBuf {
        self.projects_dir.join(self.current_slug()).join("pdfs")
    }
    pub fn projects_json(&self) -> PathBuf {
        self.data_dir.join("projects.json")
    }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
fn seed_db(pool: &SqlitePool) {
    let needs_seed = tauri::async_runtime::block_on(async {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='papers'"
        ).fetch_optional(pool).await.unwrap_or(None);
        row.is_none()
    });
    if !needs_seed { return; }

    let sql = include_str!("../migrations/004_sqlite.sql");
    tauri::async_runtime::block_on(async {
        for raw in sql.split(';') {
            let stmt: String = raw.lines()
                .map(|l| match l.find("--") { Some(p) => &l[..p], None => l })
                .collect::<Vec<_>>().join("\n");
            let stmt = stmt.trim();
            if stmt.is_empty() { continue; }
            if let Err(e) = sqlx::query(stmt).execute(pool).await {
                eprintln!("[LitAtlas] seed: {e}");
            }
        }
    });
}

/// Incremental migrations for existing databases.
/// Called after seed_db() — only adds columns/recreates views that are missing.
fn run_migrations(pool: &SqlitePool) {
    tauri::async_runtime::block_on(async {
        // Add alias column if it doesn't exist yet (idempotent).
        let _ = sqlx::query(
            "ALTER TABLE papers ADD COLUMN alias TEXT DEFAULT NULL"
        ).execute(pool).await;

        // Recreate v_papers so it always includes all current columns.
        let _ = sqlx::query("DROP VIEW IF EXISTS v_papers").execute(pool).await;
        let _ = sqlx::query(
            "CREATE VIEW v_papers AS
             SELECT
                 p.id, p.title, p.alias, p.venue, p.year, p.notes, p.pdf_path,
                 p.created_at, p.updated_at,
                 COALESCE(
                   (SELECT GROUP_CONCAT(pa.name, ', ')
                    FROM (SELECT name FROM paper_authors
                          WHERE paper_id = p.id ORDER BY position) pa),
                   ''
                 ) AS authors,
                 COALESCE(
                   (SELECT GROUP_CONCAT('#' || h.name, ',')
                    FROM (SELECT h2.name FROM hashtags h2
                          JOIN paper_tags pt ON pt.tag_id = h2.id
                          WHERE pt.paper_id = p.id ORDER BY h2.name) h),
                   ''
                 ) AS hashtags,
                 COALESCE(
                   (SELECT '[' || GROUP_CONCAT(
                               json_object('key', attr_key, 'value', attr_value, 'order', display_order)
                             , ',') || ']'
                    FROM (SELECT attr_key, attr_value, display_order FROM paper_attributes
                          WHERE paper_id = p.id ORDER BY display_order, attr_key)),
                   '[]'
                 ) AS attributes_json
             FROM papers p
             ORDER BY p.year ASC, p.id ASC"
        ).execute(pool).await;
    });
}

pub fn open_project(projects_dir: &PathBuf, slug: &str) -> SqlitePool {
    let proj = projects_dir.join(slug);
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::create_dir_all(proj.join("pdfs")).unwrap();
    let db_path = proj.join("LitAtlas.db");
    let pool = tauri::async_runtime::block_on(
        db::create_pool(&db_path.to_string_lossy())
    ).expect("Failed to open DB");
    seed_db(&pool);
    run_migrations(&pool);
    pool
}

// ── Boot ──────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).unwrap();

            logger::init(data_dir.join("litatlas.log"));
            logger::log_call("app::startup");

            let projects_dir = data_dir.join("projects");
            std::fs::create_dir_all(&projects_dir).unwrap();

            // Bootstrap projects.json on first launch
            let projects_json = data_dir.join("projects.json");
            if !projects_json.exists() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default().as_secs();
                let init = serde_json::json!([{
                    "id": "default", "name": "Default",
                    "slug": "default", "created_at": ts
                }]);
                std::fs::write(&projects_json,
                    serde_json::to_string_pretty(&init).unwrap()).unwrap();
            }

            // Open first project
            let raw = std::fs::read_to_string(&projects_json).unwrap_or("[]".into());
            let projects: Vec<serde_json::Value> =
                serde_json::from_str(&raw).unwrap_or_default();
            let first_slug = projects.first()
                .and_then(|p| p["slug"].as_str())
                .unwrap_or("default")
                .to_string();

            let pool = open_project(&projects_dir, &first_slug);

            app.manage(AppState {
                pool:         Mutex::new(pool),
                projects_dir,
                current_slug: Mutex::new(first_slug),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Papers
            get_papers, get_paper, add_paper, delete_paper,
            update_paper_core, save_notes, save_alias, save_pdf_path,
            // Authors / tags / attributes
            set_authors,
            get_hashtags, set_tags,
            set_attributes, upsert_attribute, delete_attribute,
            // Relations
            get_relations, get_all_relations, add_relation,
            update_relation_note, delete_relation,
            // Similarity edges (JS-cosine results committed here)
            get_edges, get_edges_by_source,
            recompute_edges, append_edges, replace_edges_by_source,
            // PDF
            copy_pdf, get_pdf_url, store_pdf_bytes, read_pdf_bytes,
            delete_pdf_file,
            // AI Summary (paper.md)
            read_paper_md, save_paper_md,
            // Projects
            list_projects, create_project, rename_project,
            delete_project, switch_project, get_current_project,
            // API-based similarity
            hf_list_models,
            hf_check_model, hf_download_model,
            check_api_connection,
            test_api_endpoint,
            list_api_models,
            hf_get_paper_embedding, hf_compute_all_embeddings,
            hf_compute_edges_from_cache,
            hf_setup_status, hf_setup_venv,
            // Similarity config persistence
            get_similarity_config, save_similarity_config,
            // App config
            get_app_config, save_app_config,
            // Filesystem utilities
            open_folder, get_dirs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LitAtlas");
}
