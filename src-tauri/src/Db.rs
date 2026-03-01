// src-tauri/src/db.rs
//
// SQLite access layer via sqlx.
// Matches migrations/004_sqlite.sql.
//
// Key SQLite-vs-MySQL differences handled here:
//   • Pool type is SqlitePool, not MySqlPool
//   • INTEGER PRIMARY KEY → maps to i64 in sqlx (we expose it as i64 to JS)
//   • PRAGMA foreign_keys = ON is set on every new connection via connect_with()
//   • last_insert_rowid() returns i64
//   • INSERT OR IGNORE instead of INSERT IGNORE
//   • ON DUPLICATE KEY UPDATE → INSERT OR REPLACE / INSERT OR IGNORE

use std::str::FromStr;
use sqlx::{SqlitePool, sqlite::{SqliteConnectOptions, SqliteJournalMode}, ConnectOptions, FromRow};
use serde::{Deserialize, Serialize};

// ── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum DbError {
    Sqlx(sqlx::Error),
    NotFound(String),
    Json(serde_json::Error),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Sqlx(e)     => write!(f, "Database error: {e}"),
            DbError::NotFound(s) => write!(f, "Not found: {s}"),
            DbError::Json(e)     => write!(f, "JSON error: {e}"),
        }
    }
}
impl From<sqlx::Error>       for DbError { fn from(e: sqlx::Error)       -> Self { DbError::Sqlx(e) } }
impl From<serde_json::Error> for DbError { fn from(e: serde_json::Error)  -> Self { DbError::Json(e) } }
impl From<DbError>           for String  { fn from(e: DbError) -> Self { e.to_string() } }

// ── Internal DB row (mirrors v_papers columns exactly) ────────────────────────

#[derive(Debug, FromRow)]
struct PaperRow {
    id:              i64,
    title:           String,
    venue:           String,
    year:            i64,
    notes:           Option<String>,
    pdf_path:        Option<String>,
    authors:         Option<String>,   // "Last F., Last F."
    hashtags:        Option<String>,   // "#tag1,#tag2"
    attributes_json: Option<String>,   // JSON array [{key,value,order}]
}

// ── Custom attribute ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperAttribute {
    pub key:   String,
    pub value: String,
    pub order: i64,
}

// ── Public DTO ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperFull {
    pub id:         i64,
    pub title:      String,
    pub venue:      String,
    pub year:       i64,
    pub notes:      Option<String>,
    pub pdf_path:   Option<String>,
    pub authors:    Vec<String>,
    pub hashtags:   Vec<String>,
    pub attributes: Vec<PaperAttribute>,
}

fn split_csv(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default()
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn parse_attributes(json: Option<String>) -> Result<Vec<PaperAttribute>, serde_json::Error> {
    let raw = json.unwrap_or_else(|| "[]".into());
    if raw == "[]" || raw.is_empty() { return Ok(vec![]); }
    serde_json::from_str::<Vec<serde_json::Value>>(&raw).map(|arr| {
        arr.into_iter().filter_map(|v| {
            Some(PaperAttribute {
                key:   v.get("key")?.as_str()?.to_string(),
                value: v.get("value")?.as_str()?.to_string(),
                order: v.get("order").and_then(|o| o.as_i64()).unwrap_or(0),
            })
        }).collect()
    })
}

impl TryFrom<PaperRow> for PaperFull {
    type Error = DbError;
    fn try_from(r: PaperRow) -> Result<Self, DbError> {
        Ok(PaperFull {
            id:         r.id,
            title:      r.title,
            venue:      r.venue,
            year:       r.year,
            notes:      r.notes,
            pdf_path:   r.pdf_path,
            authors:    split_csv(r.authors),
            hashtags:   split_csv(r.hashtags),
            attributes: parse_attributes(r.attributes_json)?,
        })
    }
}

// ── Relation ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct RelationRow {
    pub id:            i64,
    pub source_id:     i64,
    pub target_id:     i64,
    pub relation_type: String,
    pub note:          Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewRelation {
    pub source_id:     i64,
    pub target_id:     i64,
    pub relation_type: String,
    pub note:          Option<String>,
}

// ── Hashtag ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct HashtagRow {
    pub id:   i64,
    pub name: String,
}

// ── Edge ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EdgeRow {
    pub source_id:  i64,
    pub target_id:  i64,
    pub similarity: f64,
    pub weight:     i64,
    pub edge_type:  String,
}

#[derive(Debug, Deserialize)]
pub struct EdgeInput {
    pub source_id:  i64,
    pub target_id:  i64,
    pub similarity: f64,
    pub weight:     i64,
    pub edge_type:  String,
}

// ── NewPaper ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct NewPaper {
    pub title:      String,
    pub authors:    Vec<String>,
    pub venue:      String,
    pub year:       i64,
    pub hashtags:   Vec<String>,
    pub attributes: Vec<PaperAttribute>,
}

// ── Connection pool ───────────────────────────────────────────────────────────

/// `db_path` — absolute path to the .sqlite file (resolved by lib.rs via
/// Tauri's app_data_dir).  The file is created automatically if absent.
pub async fn create_pool(db_path: &str) -> Result<SqlitePool, DbError> {
    let opts = SqliteConnectOptions::from_str(&format!("sqlite:{db_path}?mode=rwc"))
        .map_err(DbError::Sqlx)?
        .journal_mode(SqliteJournalMode::Wal)
        // Enable FK enforcement on every connection sqlx opens
        .pragma("foreign_keys", "ON")
        // Disable log spam for every query
        .disable_statement_logging();
    // println!("{}", &format!("sqlite:{db_path}?mode=rwc"));
    let pool = sqlx::pool::PoolOptions::<sqlx::Sqlite>::new()
        .max_connections(4)           // SQLite writer limit
        .connect_with(opts)
        .await
        .map_err(DbError::Sqlx)?;

    Ok(pool)
}

// ═══════════════════════════════════════════════════════════════════════════
// READ
// ═══════════════════════════════════════════════════════════════════════════

pub async fn get_all_papers(pool: &SqlitePool) -> Result<Vec<PaperFull>, DbError> {
    let rows: Vec<PaperRow> = sqlx::query_as("SELECT * FROM v_papers")
        .fetch_all(pool).await?;
    rows.into_iter().map(PaperFull::try_from).collect()
}

pub async fn get_paper(pool: &SqlitePool, id: i64) -> Result<PaperFull, DbError> {
    let row: Option<PaperRow> = sqlx::query_as("SELECT * FROM v_papers WHERE id = ?")
        .bind(id).fetch_optional(pool).await?;
    match row {
        Some(r) => PaperFull::try_from(r),
        None    => Err(DbError::NotFound(format!("paper {id}"))),
    }
}

pub async fn get_all_edges(pool: &SqlitePool) -> Result<Vec<EdgeRow>, DbError> {
    Ok(sqlx::query_as(
        "SELECT source_id, target_id, similarity, weight, edge_type
         FROM paper_edges ORDER BY similarity DESC"
    ).fetch_all(pool).await?)
}

pub async fn get_all_hashtags(pool: &SqlitePool) -> Result<Vec<HashtagRow>, DbError> {
    Ok(sqlx::query_as("SELECT id, name FROM hashtags ORDER BY name")
        .fetch_all(pool).await?)
}

pub async fn get_relations_for_paper(pool: &SqlitePool, id: i64) -> Result<Vec<RelationRow>, DbError> {
    Ok(sqlx::query_as(
        "SELECT id, source_id, target_id, relation_type, note
         FROM paper_relations
         WHERE source_id = ? OR target_id = ?
         ORDER BY relation_type"
    ).bind(id).bind(id).fetch_all(pool).await?)
}

pub async fn get_all_relations(pool: &SqlitePool) -> Result<Vec<RelationRow>, DbError> {
    Ok(sqlx::query_as(
        "SELECT id, source_id, target_id, relation_type, note
         FROM paper_relations ORDER BY source_id, relation_type"
    ).fetch_all(pool).await?)
}

// ═══════════════════════════════════════════════════════════════════════════
// WRITE
// ═══════════════════════════════════════════════════════════════════════════

pub async fn update_paper_core(
    pool:  &SqlitePool,
    id:    i64,
    title: Option<String>,
    venue: Option<String>,
    year:  Option<i64>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE papers SET
           title = COALESCE(?, title),
           venue = COALESCE(?, venue),
           year  = COALESCE(?, year)
         WHERE id = ?"
    )
    .bind(title).bind(venue).bind(year).bind(id)
    .execute(pool).await?;
    Ok(())
}

pub async fn save_notes(pool: &SqlitePool, id: i64, notes: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE papers SET notes = ? WHERE id = ?")
        .bind(notes).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn save_pdf_path(pool: &SqlitePool, id: i64, path: Option<&str>) -> Result<(), DbError> {
    sqlx::query("UPDATE papers SET pdf_path = ? WHERE id = ?")
        .bind(path).bind(id).execute(pool).await?;
    Ok(())
}

// ── Authors ───────────────────────────────────────────────────────────────────

pub async fn set_authors(pool: &SqlitePool, paper_id: i64, authors: &[String]) -> Result<(), DbError> {
    sqlx::query("DELETE FROM paper_authors WHERE paper_id = ?")
        .bind(paper_id).execute(pool).await?;
    for (i, name) in authors.iter().enumerate() {
        sqlx::query(
            "INSERT INTO paper_authors (paper_id, name, position) VALUES (?, ?, ?)"
        )
        .bind(paper_id).bind(name).bind((i + 1) as i64)
        .execute(pool).await?;
    }
    Ok(())
}

// ── Hashtags ──────────────────────────────────────────────────────────────────

async fn upsert_tag(pool: &SqlitePool, name: &str) -> Result<i64, DbError> {
    // INSERT OR IGNORE is SQLite's equivalent of INSERT IGNORE
    sqlx::query("INSERT OR IGNORE INTO hashtags (name) VALUES (?)")
        .bind(name).execute(pool).await?;
    let row: (i64,) = sqlx::query_as("SELECT id FROM hashtags WHERE name = ?")
        .bind(name).fetch_one(pool).await?;
    Ok(row.0)
}

pub async fn set_tags(pool: &SqlitePool, paper_id: i64, tags: &[String]) -> Result<(), DbError> {
    sqlx::query("DELETE FROM paper_tags WHERE paper_id = ?")
        .bind(paper_id).execute(pool).await?;
    for raw in tags {
        let name = raw.trim_start_matches('#').trim().to_lowercase();
        if name.is_empty() { continue; }
        let tag_id = upsert_tag(pool, &name).await?;
        sqlx::query("INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)")
            .bind(paper_id).bind(tag_id).execute(pool).await?;
    }
    Ok(())
}

// ── Custom attributes ─────────────────────────────────────────────────────────

pub async fn set_attributes(
    pool:     &SqlitePool,
    paper_id: i64,
    attrs:    &[PaperAttribute],
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM paper_attributes WHERE paper_id = ?")
        .bind(paper_id).execute(pool).await?;
    for (i, a) in attrs.iter().enumerate() {
        let order = if a.order != 0 { a.order } else { i as i64 };
        sqlx::query(
            "INSERT INTO paper_attributes (paper_id, attr_key, attr_value, display_order)
             VALUES (?, ?, ?, ?)"
        )
        .bind(paper_id).bind(&a.key).bind(&a.value).bind(order)
        .execute(pool).await?;
    }
    Ok(())
}

pub async fn upsert_attribute(
    pool:     &SqlitePool,
    paper_id: i64,
    key:      &str,
    value:    &str,
    order:    i64,
) -> Result<(), DbError> {
    // INSERT OR REPLACE honours the UNIQUE(paper_id, attr_key) constraint
    sqlx::query(
        "INSERT INTO paper_attributes (paper_id, attr_key, attr_value, display_order)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (paper_id, attr_key) DO UPDATE SET
           attr_value    = excluded.attr_value,
           display_order = excluded.display_order"
    )
    .bind(paper_id).bind(key).bind(value).bind(order)
    .execute(pool).await?;
    Ok(())
}

pub async fn delete_attribute(pool: &SqlitePool, paper_id: i64, key: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM paper_attributes WHERE paper_id = ? AND attr_key = ?")
        .bind(paper_id).bind(key).execute(pool).await?;
    Ok(())
}

// ── Paper CRUD ────────────────────────────────────────────────────────────────

pub async fn insert_paper(pool: &SqlitePool, p: NewPaper) -> Result<i64, DbError> {
    let result = sqlx::query(
        "INSERT INTO papers (title, venue, year) VALUES (?, ?, ?)"
    )
    .bind(&p.title).bind(&p.venue).bind(p.year)
    .execute(pool).await?;

    let new_id = result.last_insert_rowid();
    set_authors(pool, new_id, &p.authors).await?;
    set_tags(pool, new_id, &p.hashtags).await?;
    set_attributes(pool, new_id, &p.attributes).await?;
    Ok(new_id)
}

pub async fn delete_paper(pool: &SqlitePool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM papers WHERE id = ?")
        .bind(id).execute(pool).await?;
    Ok(())
}

// ── Relations ─────────────────────────────────────────────────────────────────

pub async fn add_relation(pool: &SqlitePool, r: NewRelation) -> Result<i64, DbError> {
    let res = sqlx::query(
        "INSERT INTO paper_relations (source_id, target_id, relation_type, note)
         VALUES (?, ?, ?, ?)"
    )
    .bind(r.source_id).bind(r.target_id).bind(&r.relation_type).bind(&r.note)
    .execute(pool).await?;
    Ok(res.last_insert_rowid())
}

pub async fn update_relation_note(pool: &SqlitePool, id: i64, note: Option<String>) -> Result<(), DbError> {
    sqlx::query("UPDATE paper_relations SET note = ? WHERE id = ?")
        .bind(note).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn delete_relation(pool: &SqlitePool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM paper_relations WHERE id = ?")
        .bind(id).execute(pool).await?;
    Ok(())
}

// ── Similarity edges ──────────────────────────────────────────────────────────

pub async fn replace_all_edges(pool: &SqlitePool, edges: Vec<EdgeInput>) -> Result<usize, DbError> {
    sqlx::query("DELETE FROM paper_edges").execute(pool).await?;
    let count = edges.len();
    for e in &edges {
        sqlx::query(
            "INSERT INTO paper_edges (source_id, target_id, similarity, weight, edge_type)
             VALUES (?, ?, ?, ?, ?)"
        )
        .bind(e.source_id).bind(e.target_id)
        .bind(e.similarity).bind(e.weight).bind(&e.edge_type)
        .execute(pool).await?;
    }
    Ok(count)
}

pub async fn append_edges(pool: &SqlitePool, edges: Vec<EdgeInput>) -> Result<usize, DbError> {
    let count = edges.len();
    for e in &edges {
        sqlx::query(
            "INSERT OR IGNORE INTO paper_edges
               (source_id, target_id, similarity, weight, edge_type)
             VALUES (?, ?, ?, ?, ?)"
        )
        .bind(e.source_id).bind(e.target_id)
        .bind(e.similarity).bind(e.weight).bind(&e.edge_type)
        .execute(pool).await?;
    }
    Ok(count)
}