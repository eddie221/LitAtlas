// src-tauri/src/logger.rs
//
// Lightweight structured logger for LitAtlas.
//
// Every entry is a newline-delimited JSON object written to:
//   app_data_dir/litatlas.log
//
// Log format:
//   { "ts": "<ISO-8601>", "level": "INFO"|"ERROR", "fn": "<name>", "msg": "<detail>" }
//
// Usage:
//   use crate::logger;
//
//   // Log a function call (call at the top of every command)
//   logger::log_call("my_command");
//
//   // Log an error (call before returning Err)
//   logger::log_error("my_command", &err_string);
//
//   // Convenience wrapper: run a fallible closure and auto-log both entry + errors
//   let result = logger::traced("my_command", || { /* ... */ Ok(value) });
//
// The log path must be initialised once at app startup via logger::init(path).
// Writes are synchronised with a global Mutex so the logger is safe to call
// from any thread (including background embedding threads).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Global state ──────────────────────────────────────────────────────────────

static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

// ── Public API ────────────────────────────────────────────────────────────────

/// Initialise the logger with an absolute path.
/// Must be called once from `lib.rs` before any command is invoked.
pub fn init(path: PathBuf) {
    let mut guard = LOG_PATH.lock().unwrap();
    *guard = Some(path);
}

/// Record that a command was invoked.
///
/// Call at the very start of every `#[tauri::command]` function:
/// ```rust
/// logger::log_call("get_papers");
/// ```
pub fn log_call(fn_name: &str) {
    write_entry("INFO", fn_name, "called");
}

/// Record an error that occurred inside a command.
///
/// Call before returning `Err(...)` or whenever a recoverable error is handled:
/// ```rust
/// logger::log_error("get_papers", &e.to_string());
/// ```
pub fn log_error(fn_name: &str, message: &str) {
    write_entry("ERROR", fn_name, message);
}

/// Convenience: log entry + any `Err` produced by `f`, then return the result.
///
/// ```rust
/// logger::traced("my_fn", || {
///     do_something()?;
///     Ok(result)
/// })
/// ```
pub fn traced<T, F>(fn_name: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    log_call(fn_name);
    let result = f();
    if let Err(ref e) = result {
        log_error(fn_name, e);
    }
    result
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn write_entry(level: &str, fn_name: &str, message: &str) {
    let guard = match LOG_PATH.lock() {
        Ok(g) => g,
        Err(_) => return, // poisoned mutex — silently skip
    };

    let path = match guard.as_ref() {
        Some(p) => p,
        None => {
            // Logger not yet initialised — fall back to stderr so nothing is lost.
            eprintln!("[LitAtlas][{level}] {fn_name}: {message}");
            return;
        }
    };

    let ts    = timestamp_now();
    let line  = format!(
        "{{\"ts\":\"{ts}\",\"level\":\"{level}\",\"fn\":\"{fn_name}\",\"msg\":{}}}\n",
        serde_json::to_string(message).unwrap_or_else(|_| format!("\"{}\"", message))
    );

    // Mirror every entry to stderr so it is visible in dev console / Xcode logs.
    eprint!("[LitAtlas][{level}] {fn_name}: {message}");
    if !message.ends_with('\n') { eprintln!(); }

    // Append to the log file.  Open → write → close on every call so that
    // a crash mid-session never leaves the file handle open or data unflushed.
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Produce a UTC timestamp string: "2025-03-08T14:05:23Z"
fn timestamp_now() -> String {
    // std only — no chrono dependency required.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let s   = secs % 60;
    let m   = (secs / 60) % 60;
    let h   = (secs / 3600) % 24;
    let days = secs / 86400; // days since 1970-01-01

    // Gregorian calendar calculation (no external crate)
    let (y, mo, d) = days_to_ymd(days);

    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Algorithm: http://howardhinnant.github.io/date_algorithms.html
    days += 719468;
    let era  = days / 146097;
    let doe  = days % 146097;
    let yoe  = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y    = yoe + era * 400;
    let doy  = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp   = (5 * doy + 2) / 153;
    let d    = doy - (153 * mp + 2) / 5 + 1;
    let mo   = if mp < 10 { mp + 3 } else { mp - 9 };
    let y    = if mo <= 2 { y + 1 } else { y };
    (y, mo, d)
}