// src-tauri/src/lib.rs

mod db;
mod commands;
mod logger;
mod api_client;
mod arxiv;

use commands::*;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use sqlx::SqlitePool;

// ── AppState ──────────────────────────────────────────────────────────────────

pub struct AppState {
    pub pool:              Mutex<SqlitePool>,
    pub projects_dir:      PathBuf,
    pub current_slug:      Mutex<String>,
    pub data_dir:          PathBuf,
    pub python_env_ready:  Arc<AtomicBool>,
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

impl Drop for AppState {
    fn drop(&mut self) {
        logger::log_call("app::shutdown");
        let pool = self.pool.lock().unwrap().clone();
        tauri::async_runtime::block_on(pool.close());
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

// ── Python environment setup ──────────────────────────────────────────────────

/// Verifies that `<data_dir>/.venv/bin/marker_single` is functional on every launch.
/// Runs in a background thread so startup is never blocked.
/// If marker is missing or broken, recreates the venv (if absent) and
/// reinstalls marker-pdf via pip.
fn ensure_python_env(
    app: tauri::AppHandle,
    data_dir: std::path::PathBuf,
    ready_flag: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        let (bin, marker_name) = ("Scripts", "marker_single.exe");
        #[cfg(not(target_os = "windows"))]
        let (bin, marker_name) = ("bin", "marker_single");

        let venv_dir = data_dir.join(".venv");
        let marker   = venv_dir.join(bin).join(marker_name);

        // Verify marker_single is actually executable, not just present on disk.
        let is_functional = std::process::Command::new(&marker)
            .arg("--help")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if is_functional {
            logger::log_info("python_env", "marker verified OK");
            ready_flag.store(true, Ordering::SeqCst);
            let _ = app.emit("summary://progress", serde_json::json!({
                "source": "python_env", "status": "ready"
            }));
            return;
        }

        logger::log_info("python_env", "marker not functional, setting up venv");
        let _ = app.emit("summary://progress", serde_json::json!({
            "source": "python_env", "status": "starting", "title": "Setting up Python environment…"
        }));

        // Find a marker-compatible Python (>= 3.10). Prefer 3.12 first because it
        // has the best binary-wheel coverage for marker-pdf's deps (Pillow, torch).
        // Picking 3.14/3.15 often forces a Pillow source build, which fails without
        // system libjpeg/zlib headers.
        // Packaged apps on macOS/Windows have a restricted PATH, so also probe
        // absolute paths for common Python install locations.
        let minors: [u8; 4] = [12, 13, 11, 10];
        let python: String = {
            #[cfg(target_os = "windows")]
            let candidates: Vec<String> = {
                let mut v: Vec<String> = Vec::new();
                for m in minors { v.push(format!("python3.{m}")); }
                v.extend(["py".into(), "python3".into(), "python".into()]);
                v
            };

            #[cfg(target_os = "macos")]
            let candidates: Vec<String> = {
                let mut v: Vec<String> = Vec::new();
                for m in minors {
                    for prefix in &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
                        v.push(format!("{prefix}/python3.{m}"));
                    }
                    v.push(format!("python3.{m}"));
                }
                for prefix in &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
                    v.push(format!("{prefix}/python3"));
                }
                v.push("python3".to_string());
                v
            };

            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            let candidates: Vec<String> = {
                let mut v: Vec<String> = Vec::new();
                for m in minors {
                    v.push(format!("/usr/bin/python3.{m}"));
                    v.push(format!("/usr/local/bin/python3.{m}"));
                    v.push(format!("python3.{m}"));
                }
                v.push("python3".to_string());
                v
            };

            let found = candidates.iter().find(|py| {
                std::process::Command::new(py.as_str())
                    .arg("--version")
                    .output()
                    .ok()
                    .and_then(|o| {
                        if !o.status.success() { return None; }
                        let raw = String::from_utf8_lossy(&o.stdout).to_string()
                            + &String::from_utf8_lossy(&o.stderr);
                        // "Python 3.13.5" → [3, 13, 5]
                        let ver: Vec<u32> = raw.split_whitespace()
                            .nth(1).unwrap_or("")
                            .split('.')
                            .filter_map(|x| x.parse().ok())
                            .collect();
                        if ver.len() >= 2 && (ver[0] > 3 || (ver[0] == 3 && ver[1] >= 10)) {
                            Some(())
                        } else {
                            None
                        }
                    })
                    .is_some()
            });

            match found {
                Some(py) => py.clone(),
                None => {
                    let msg = "No suitable Python found (>= 3.10 required, 3.12 preferred). \
                               Install Python 3.12 and restart the app.";
                    logger::log_error("python_env", msg);
                    let _ = app.emit("summary://progress", serde_json::json!({
                        "source": "python_env", "status": "error", "error": msg
                    }));
                    return;
                }
            }
        };
        logger::log_info("python_env", &format!("using {python} for venv"));

        // Remove any existing stale venv (e.g. created with old Python 3.9)
        // so it gets recreated with the newly found Python.
        if venv_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&venv_dir) {
                let msg = format!("failed to remove stale venv: {e}");
                logger::log_error("python_env", &msg);
                let _ = app.emit("summary://progress", serde_json::json!({
                    "source": "python_env", "status": "error", "error": msg
                }));
                return;
            }
        }

        let venv_str = venv_dir.to_string_lossy().to_string();
        let out = std::process::Command::new(python)
            .args(["-m", "venv", &venv_str])
            .output();

        match out {
            Err(e) => {
                let msg = format!("venv creation failed: {e}");
                logger::log_error("python_env", &msg);
                let _ = app.emit("summary://progress", serde_json::json!({
                    "source": "python_env", "status": "error", "error": msg
                }));
                return;
            }
            Ok(o) if !o.status.success() => {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                logger::log_error("python_env", &format!("venv creation failed: {msg}"));
                let _ = app.emit("summary://progress", serde_json::json!({
                    "source": "python_env", "status": "error", "error": format!("venv creation failed: {msg}")
                }));
                return;
            }
            _ => {}
        }

        // Upgrade pip first — older pip in a fresh venv can fail to discover
        // current wheel tags (e.g. Pillow's cp312 manylinux2_28 wheels), forcing
        // a source build that needs libjpeg/zlib headers.
        let pip = venv_dir.join(bin).join("pip");
        let _ = std::process::Command::new(&pip)
            .args(["install", "--upgrade", "pip"])
            .output();

        // Install or repair marker inside the venv.
        let out = std::process::Command::new(&pip)
            .args(["install", "marker-pdf"])
            .output();

        match out {
            Err(e) => {
                let msg = format!("pip install marker-pdf failed: {e}");
                logger::log_error("python_env", &msg);
                let _ = app.emit("summary://progress", serde_json::json!({
                    "status": "error", "error": msg
                }));
            }
            Ok(o) if !o.status.success() => {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                logger::log_error("python_env", &format!("pip install failed: {msg}"));
                let _ = app.emit("summary://progress", serde_json::json!({
                    "source": "python_env", "status": "error", "error": format!("pip install marker-pdf failed: {msg}")
                }));
            }
            Ok(_) => {
                logger::log_info("python_env", "marker installed successfully");
                ready_flag.store(true, Ordering::SeqCst);
                let _ = app.emit("summary://progress", serde_json::json!({
                    "source": "python_env", "status": "ready"
                }));
            }
        }
    });
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
            let python_env_ready = Arc::new(AtomicBool::new(false));

            app.manage(AppState {
                pool:             Mutex::new(pool),
                projects_dir,
                current_slug:     Mutex::new(first_slug),
                data_dir:         data_dir.clone(),
                python_env_ready: python_env_ready.clone(),
            });

            ensure_python_env(app.handle().clone(), data_dir, python_env_ready);
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
            delete_pdf_file, embed_paper_pdf,
            // AI Summary (paper.md)
            read_paper_md, save_paper_md,
            delete_paper_md, regenerate_paper_md, open_paper_folder,
            // Projects
            list_projects, create_project, rename_project,
            delete_project, switch_project, get_current_project,
            // API-based similarity
            hf_check_model,
            check_api_connection,
            test_api_endpoint,
            list_api_models,
            hf_get_paper_embedding, hf_compute_all_embeddings,
            hf_compute_edges_from_cache,
            validate_model,
            // Similarity config persistence
            get_similarity_config, save_similarity_config,
            // App config
            get_app_config, save_app_config,
            // Filesystem utilities
            open_folder, get_dirs,
            // AI status check
            get_papers_ai_status,
            // Python env readiness gate
            is_python_env_ready,
            // arXiv discovery
            arxiv_fetch, arxiv_download_pdf, arxiv_score_abstract,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LitAtlas");
}
