// src-tauri/src/lib.rs

mod db;
mod commands;

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

// ── Seed + open helpers ───────────────────────────────────────────────────────

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
                eprintln!("[PaperGraph] seed: {e}");
            }
        }
    });
}

pub fn open_project(projects_dir: &PathBuf, slug: &str) -> SqlitePool {
    let proj = projects_dir.join(slug);
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::create_dir_all(proj.join("pdfs")).unwrap();
    let db_path = proj.join("papergraph.db");
    let pool = tauri::async_runtime::block_on(
        db::create_pool(&db_path.to_string_lossy())
    ).expect("Failed to open DB");
    seed_db(&pool);
    pool
}

// ── Boot ──────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).unwrap();

            let projects_dir = data_dir.join("projects");
            std::fs::create_dir_all(&projects_dir).unwrap();

            // Bootstrap projects.json if missing
            let projects_json = data_dir.join("projects.json");
            if !projects_json.exists() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default().as_secs();
                let init = serde_json::json!([{
                    "id":"default","name":"Default",
                    "slug":"default","created_at": ts
                }]);
                std::fs::write(&projects_json,
                    serde_json::to_string_pretty(&init).unwrap()).unwrap();
            }

            // Load first project
            let raw = std::fs::read_to_string(&projects_json).unwrap_or("[]".into());
            let projects: Vec<serde_json::Value> =
                serde_json::from_str(&raw).unwrap_or_default();
            let first_slug = projects.first()
                .and_then(|p| p["slug"].as_str())
                .unwrap_or("default").to_string();

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
            get_papers, get_paper, add_paper, delete_paper,
            update_paper_core, save_notes, save_pdf_path,
            set_authors,
            get_hashtags, set_tags,
            set_attributes, upsert_attribute, delete_attribute,
            get_relations, get_all_relations, add_relation,
            update_relation_note, delete_relation,
            get_edges, recompute_edges, append_edges,
            copy_pdf, get_pdf_url, store_pdf_bytes, read_pdf_bytes,
            list_projects, create_project, rename_project,
            delete_project, switch_project, get_current_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PaperGraph");
}