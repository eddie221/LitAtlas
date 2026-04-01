// src-tauri/src/lib.rs

mod db;
mod commands;
mod logger;   // ← NEW: structured call/error logger

use commands::*;
use commands::PySidecar;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use sqlx::SqlitePool;
use std::fs;

// ── AppState ──────────────────────────────────────────────────────────────────

pub struct AppState {
    pub pool:         Mutex<SqlitePool>,
    pub projects_dir: PathBuf,
    pub current_slug: Mutex<String>,
    pub data_dir:     PathBuf,
    /// Live Python sidecar process.  None = not yet started (lazy init).
    /// Rust owns the full lifecycle — JS never talks to Python directly.
    pub sidecar:      Mutex<Option<PySidecar>>,
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
    /// Directory for the isolated Python venv used by the similarity sidecar.
    /// Created automatically on the first hf_* call via ensure_venv().
    /// Safe to delete — the app recreates it on next launch.
    pub fn venv_dir(&self) -> PathBuf {
        self.data_dir.join("similarity_venv")
    }
    /// Absolute path to similarity_server.py.
    ///
    /// Resolution order:
    ///   0. User override in app_data_dir/app_config.json["sidecar_script"]
    ///   1. app_data_dir/similarity_server.py  (bundled release copy)
    ///   2. <workspace_root>/similarity_server.py  (dev — next to src-tauri/)
    pub fn sidecar_script(&self) -> String {
        // 0. User override — respects custom script path set in App Settings.
        let app_cfg = self.data_dir.join("app_config.json");
        if let Ok(raw) = std::fs::read_to_string(&app_cfg) {
            if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(p) = cfg["sidecar_script"].as_str() {
                    let path = std::path::Path::new(p);
                    if !p.is_empty() && path.exists() {
                        return p.to_owned();
                    }
                }
            }
        }
        // 1. Bundled location (production)
        let bundled = self.data_dir.join("similarity_server.py");
        println!("{:?}", bundled);
        if bundled.exists() {
            return bundled.to_string_lossy().into_owned();
        }
        // 2. Dev location: two directories up from src-tauri/src/ == workspace root
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/similarity_server.py");
        println!("{:?}", dev);
        dev.to_string_lossy().into_owned()
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

            // ── Initialise logger ────────────────────────────────────────────
            // Must happen before any command can be invoked so the log file
            // path is known.  litatlas.log is appended across sessions;
            // delete it manually to reset (the app always appends, never truncates).
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
            const SIMILARITY_PY: &str = include_str!("./similarity_server.py");
            let script = data_dir.join("similarity_server.py");
            // Always write the embedded script so it exists on a fresh install and
            // stays up to date after app upgrades.
            fs::write(&script, SIMILARITY_PY).map_err(|e| format!("Failed to write eval script: {e}"))?;

            app.manage(AppState {
                pool:         Mutex::new(pool),
                projects_dir,
                current_slug: Mutex::new(first_slug),
                data_dir,
                sidecar:      Mutex::new(None), // started lazily on first hf_* call
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
            // Projects
            list_projects, create_project, rename_project,
            delete_project, switch_project, get_current_project,
            // HuggingFace similarity (Rust owns Python sidecar)
            hf_list_models, hf_sidecar_status,
            hf_check_model, hf_download_model,
            hf_get_paper_embedding, hf_compute_all_embeddings,
            hf_compute_edges_from_cache,
            hf_setup_status, hf_setup_venv,
            // Similarity config persistence
            get_similarity_config, save_similarity_config,
            // App config (custom sidecar path, custom models)
            get_app_config, save_app_config,
            pick_sidecar_script, get_sidecar_script_info,
            // Plugin validation
            hf_validate_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LitAtlas");
}