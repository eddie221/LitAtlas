// arXiv discovery: fetch recent papers by category + date from the public
// arXiv API (https://info.arxiv.org/help/api/index.html).
//
// The Atom feed has repeated <link> and <category> elements per entry.
// quick-xml's serde impl was flagging the second <link> as "duplicate field",
// so we parse the feed with an event-based reader instead — more code, but
// tolerant of order + unknown elements.

use serde::Serialize;
use quick_xml::events::Event;
use quick_xml::reader::Reader;

const ARXIV_QUERY_URL: &str = "https://export.arxiv.org/api/query";

#[derive(Debug, Serialize, Clone)]
pub struct ArxivPaper {
    pub id:          String,   // bare id, e.g. "2401.12345v1"
    pub title:       String,
    pub summary:     String,   // abstract
    pub authors:     Vec<String>,
    pub published:   String,   // ISO 8601
    pub categories:  Vec<String>,
    pub abs_url:     String,
    pub pdf_url:     String,
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/// Fetch papers in `category` submitted on `date` (YYYY-MM-DD).
/// Returns up to `max` entries starting at index `start`, newest first.
pub async fn fetch(category: &str, date: &str, max: u32, start: u32) -> Result<Vec<ArxivPaper>, String> {
    let (date_from, date_to) = parse_date_window(date)?;
    let search = format!(
        "cat:{cat} AND submittedDate:[{from} TO {to}]",
        cat = category, from = date_from, to = date_to,
    );

    let client = reqwest::Client::new();
    let resp = client.get(ARXIV_QUERY_URL)
        .query(&[
            ("search_query", search.as_str()),
            ("start",        start.to_string().as_str()),
            ("max_results",  &max.to_string()),
            ("sortBy",       "submittedDate"),
            ("sortOrder",    "descending"),
        ])
        .send().await
        .map_err(|e| format!("arxiv request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("arxiv returned HTTP {}", resp.status()));
    }
    let body = resp.text().await
        .map_err(|e| format!("arxiv body read failed: {e}"))?;

    parse_atom(&body)
}

// ── Event-based Atom parser ──────────────────────────────────────────────────

#[derive(Default)]
struct EntryBuf {
    id:         String,
    title:      String,
    summary:    String,
    published:  String,
    authors:    Vec<String>,
    // (href, rel, type)
    links:      Vec<(String, String, String)>,
    categories: Vec<String>,
}

fn parse_atom(xml: &str) -> Result<Vec<ArxivPaper>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut papers: Vec<ArxivPaper> = Vec::new();
    let mut in_entry = false;
    let mut in_author = false;
    let mut cur = EntryBuf::default();
    let mut cur_tag: Option<String> = None;
    let mut text_buf = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                if name == "entry" {
                    in_entry = true;
                    cur = EntryBuf::default();
                } else if in_entry {
                    if name == "author" {
                        in_author = true;
                    } else {
                        cur_tag = Some(name);
                        text_buf.clear();
                    }
                }
            }
            Ok(Event::Empty(e)) if in_entry => {
                let name = local_name(e.name().as_ref());
                if name == "link" {
                    let mut href = String::new();
                    let mut rel  = String::new();
                    let mut typ  = String::new();
                    for attr in e.attributes().flatten() {
                        let key = local_name(attr.key.as_ref());
                        let val = attr.unescape_value().unwrap_or_default().to_string();
                        match key.as_str() {
                            "href" => href = val,
                            "rel"  => rel  = val,
                            "type" => typ  = val,
                            _ => {}
                        }
                    }
                    cur.links.push((href, rel, typ));
                } else if name == "category" {
                    for attr in e.attributes().flatten() {
                        if local_name(attr.key.as_ref()) == "term" {
                            cur.categories.push(attr.unescape_value().unwrap_or_default().to_string());
                        }
                    }
                }
            }
            Ok(Event::Text(e)) if in_entry => {
                if let Ok(t) = e.unescape() {
                    text_buf.push_str(&t);
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref());
                if name == "entry" {
                    papers.push(build_paper(std::mem::take(&mut cur)));
                    in_entry = false;
                } else if in_entry {
                    // Author has a nested <name>; commit it on </name>.
                    if in_author && name == "name" {
                        cur.authors.push(clean_ws(&text_buf));
                        text_buf.clear();
                        cur_tag = None;
                    } else if name == "author" {
                        in_author = false;
                    } else if Some(&name) == cur_tag.as_ref() {
                        match name.as_str() {
                            "id"        => cur.id        = text_buf.trim().to_string(),
                            "title"     => cur.title     = clean_ws(&text_buf),
                            "summary"   => cur.summary   = clean_ws(&text_buf),
                            "published" => cur.published = text_buf.trim().to_string(),
                            _ => {}
                        }
                        text_buf.clear();
                        cur_tag = None;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("arxiv XML parse failed: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(papers)
}

fn local_name(qname: &[u8]) -> String {
    // Strip namespace prefix: "atom:title" -> "title", "arxiv:doi" -> "doi".
    let full = String::from_utf8_lossy(qname).to_string();
    full.rsplit(':').next().unwrap_or(&full).to_string()
}

fn build_paper(e: EntryBuf) -> ArxivPaper {
    let bare_id = e.id.rsplit('/').next().unwrap_or(&e.id).to_string();
    let abs_url = e.links.iter()
        .find(|(_, rel, typ)| rel == "alternate" || typ == "text/html")
        .map(|(h, _, _)| h.clone())
        .unwrap_or_else(|| format!("https://arxiv.org/abs/{bare_id}"));
    let pdf_url = e.links.iter()
        .find(|(_, _, typ)| typ == "application/pdf")
        .map(|(h, _, _)| h.clone())
        .unwrap_or_else(|| format!("https://arxiv.org/pdf/{bare_id}"));

    ArxivPaper {
        id:         bare_id,
        title:      e.title,
        summary:    e.summary,
        authors:    e.authors,
        published:  e.published,
        categories: e.categories,
        abs_url,
        pdf_url,
    }
}

fn clean_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Download `url` (expected to be an arXiv PDF endpoint) and return
/// the bytes as base64. We do the download in Rust so the webview
/// doesn't run into CORS / streaming oddities.
pub async fn download_pdf_base64(url: &str) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("refusing non-http URL: {url}"));
    }
    let resp = reqwest::Client::new()
        .get(url)
        .send().await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await
        .map_err(|e| format!("download body read failed: {e}"))?;
    Ok(b64_encode(&bytes))
}

fn b64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i+1] as u32) << 8) | (bytes[i+2] as u32);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >>  6) & 63) as usize] as char);
        out.push(CHARS[( n        & 63) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push('='); out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i+1] as u32) << 8);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >>  6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

/// "2024-01-15" → ("202401150000", "202401152359"). UTC bounds.
fn parse_date_window(date: &str) -> Result<(String, String), String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(format!("date must be YYYY-MM-DD, got '{date}'"));
    }
    let y: u32 = parts[0].parse().map_err(|_| format!("bad year in '{date}'"))?;
    let m: u32 = parts[1].parse().map_err(|_| format!("bad month in '{date}'"))?;
    let d: u32 = parts[2].parse().map_err(|_| format!("bad day in '{date}'"))?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(format!("invalid month/day in '{date}'"));
    }
    Ok((
        format!("{y:04}{m:02}{d:02}0000"),
        format!("{y:04}{m:02}{d:02}2359"),
    ))
}
