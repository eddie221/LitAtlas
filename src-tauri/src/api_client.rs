// src-tauri/src/api_client.rs
//
// Thin async wrappers around the OpenAI and Anthropic REST APIs, plus a
// synchronous PDF text extractor.  All embedding and generation calls in
// commands.rs go through these functions.

pub struct ApiKeys {
    pub openai:    String,
    pub anthropic: String,
    /// Custom base URL for OpenAI-compatible APIs (e.g. Ollama, LM Studio).
    /// Empty = use the default OpenAI endpoint.
    pub base_url:  String,
    /// Model name to use with the custom endpoint (e.g. "nomic-embed-text").
    /// Required when base_url is set. Set by the user in App Settings → API.
    pub model:     String,
    /// Pooling strategy sent in embedding requests (e.g. "last", "mean", "cls").
    /// Empty = omit the field (OpenAI default).
    pub pooling:   String,
}

pub const OPENAI_DEFAULT_BASE: &str = "https://api.openai.com/v1";

impl ApiKeys {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let cfg: serde_json::Value = std::fs::read_to_string(data_dir.join("app_config.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        Self {
            openai:    cfg["openai_api_key"].as_str().unwrap_or("").to_string(),
            anthropic: cfg["anthropic_api_key"].as_str().unwrap_or("").to_string(),
            base_url:  cfg["api_base_url"].as_str().unwrap_or("").trim_end_matches('/').to_string(),
            model:     cfg["api_model"].as_str().unwrap_or("").trim().to_string(),
            pooling:   cfg["api_pooling"].as_str().unwrap_or("").to_string(),
        }
    }

    /// True when at least one API source is configured.
    /// A custom base URL without a key is valid (e.g. keyless llama.cpp servers).
    pub fn has_any(&self) -> bool {
        !self.openai.is_empty() || !self.anthropic.is_empty() || !self.base_url.is_empty()
    }

    /// Returns the effective base URL (custom or OpenAI default).
    pub fn openai_base(&self) -> &str {
        if self.base_url.is_empty() { OPENAI_DEFAULT_BASE } else { &self.base_url }
    }
}

/// Compute an embedding vector via an API model.
/// `model_id` should be `"provider:model_name"` (e.g. `"openai:text-embedding-3-small"`).
/// When a custom base URL is configured, bare model names (no provider prefix) are
/// forwarded directly to the custom endpoint as OpenAI-compatible requests.
pub async fn embed(keys: &ApiKeys, model_id: &str, text: &str) -> Result<Vec<f32>, String> {
    if !keys.base_url.is_empty() {
        // Always derive the model from /v1/models when a custom endpoint is set.
        // The saved model ID in similarity_config may be stale (different model
        // loaded, or leftover prefix from the default OpenAI config).
        let models = list_models(&keys.openai, &keys.base_url).await
            .map_err(|e| format!("Could not list models from custom endpoint: {e}"))?;
        let model = models.into_iter().next()
            .ok_or_else(|| "No models available at the custom endpoint".to_string())?;
        crate::logger::log_info("api::embed", &format!("using model: {model}"));
        return openai_embed(&keys.openai, &keys.base_url, &model, text, &keys.pooling).await;
    }
    // No custom URL — route by provider prefix.
    if let Some((provider, model_name)) = model_id.split_once(':') {
        return match provider {
            "openai" => openai_embed(&keys.openai, OPENAI_DEFAULT_BASE, model_name, text, &keys.pooling).await,
            other    => Err(format!("Unsupported embedding provider: {other}")),
        };
    }
    Err(format!("Invalid model id '{model_id}' — expected 'provider:name' (e.g. 'openai:text-embedding-3-small')"))
}

/// Returns candidate URLs to try in order.
/// When base_url already ends with /v1, returns one URL.
/// Otherwise tries /v1/ first (standard for all OpenAI-compatible APIs),
/// then the root path as fallback for non-standard servers.
fn candidates(base_url: &str, path: &str) -> Vec<String> {
    if base_url.ends_with("/v1") {
        vec![format!("{base_url}/{path}")]
    } else {
        vec![
            format!("{base_url}/v1/{path}"),
            format!("{base_url}/api/{path}"),
        ]
    }
}

/// Truncate a string to `max` chars for log previews.
fn trunc(s: &str, max: usize) -> &str {
    let end = s.char_indices().nth(max).map(|(i, _)| i).unwrap_or(s.len());
    &s[..end]
}

/// Returns true when a non-2xx body looks like the server is still loading its model.
/// LM Studio and llama.cpp both return 500 with "loading" or "model" in the body
/// during the cold-start window.
fn looks_like_loading(status: u16, body: &str) -> bool {
    if status != 500 && status != 503 { return false; }
    let b = body.to_lowercase();
    b.contains("loading") || b.contains("initializ") || b.contains("not ready")
        || b.contains("model") && (b.contains("load") || b.contains("start"))
        || body.is_empty() // bare 500 with no body is also typical of cold-start
}

const RETRY_MAX: u32     = 4;
const RETRY_DELAY_MS: u64 = 3_000;

pub async fn openai_embed(api_key: &str, base_url: &str, model: &str, text: &str, pooling: &str) -> Result<Vec<f32>, String> {
    // Require a key only for the default OpenAI endpoint; local servers may be keyless.
    if api_key.is_empty() && base_url == OPENAI_DEFAULT_BASE {
        return Err("No OpenAI API key configured".to_string());
    }
    let client  = reqwest::Client::new();
    let mut payload = serde_json::json!({ "input": text, "model": model });
    if !pooling.is_empty() {
        payload["pooling_type"] = serde_json::json!(pooling);
    }
    let payload = payload;
    let urls    = candidates(base_url, "embeddings");
    let mut last_err = String::new();

    crate::logger::log_info("api::embed", &format!(
        "POST embeddings url={} model={model} pooling={} input_chars={} input_preview={:?}",
        urls.first().map(String::as_str).unwrap_or("?"),
        if pooling.is_empty() { "(default)" } else { pooling },
        text.len(),
        trunc(text, 120),
    ));

    'url: for url in &urls {
        for attempt in 0..=RETRY_MAX {
            let req = client.post(url).json(&payload);
            let req = if !api_key.is_empty() { req.bearer_auth(api_key) } else { req };
            let resp = req.send().await.map_err(|e| format!("Request error: {e}"))?;
            let status = resp.status();

            if status.as_u16() == 404 {
                last_err = format!("404 Not Found at {url}");
                crate::logger::log_info("api::embed", &format!("404 at {url} — trying next"));
                continue 'url;
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                // Retry on cold-start 500/503 (model still loading).
                if looks_like_loading(status.as_u16(), &body) && attempt < RETRY_MAX {
                    crate::logger::log_info("api::embed", &format!(
                        "server not ready ({status}) attempt {}/{RETRY_MAX} — retrying in {RETRY_DELAY_MS}ms",
                        attempt + 1
                    ));
                    tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                    continue;
                }
                let err = if body.contains("Pooling type") && body.contains("none") {
                    "Embedding not supported: the loaded model is a generative/chat model \
                     with no pooling layer. Use a dedicated embedding model instead \
                     (e.g. nomic-embed-text, mxbai-embed-large, bge-small-en).".to_string()
                } else {
                    format!("Embedding API {status}: {body}")
                };
                crate::logger::log_error("api::embed", &err);
                return Err(err);
            }
            crate::logger::log_info("api::embed", &format!("{status} OK from {url}"));
            let v: serde_json::Value = resp.json().await
                .map_err(|e| format!("Response parse error: {e}"))?;
            return v["data"][0]["embedding"]
                .as_array()
                .ok_or_else(|| "Missing embedding in response".to_string())?
                .iter()
                .map(|x| x.as_f64()
                    .map(|f| f as f32)
                    .ok_or_else(|| "Non-numeric value in embedding".to_string()))
                .collect();
        }
    }
    crate::logger::log_error("api::embed", &last_err);
    Err(last_err)
}

/// Generate text using the best available API key.
/// Custom base_url takes priority; then Anthropic; then OpenAI default.
pub async fn generate(
    keys:       &ApiKeys,
    system:     &str,
    user:       &str,
    max_tokens: u32,
) -> Result<String, String> {
    // Custom endpoint — use configured model or fetch first available from /v1/models.
    if !keys.base_url.is_empty() {
        let model = if !keys.model.is_empty() {
            keys.model.clone()
        } else {
            let models = list_models(&keys.openai, &keys.base_url).await
                .map_err(|e| format!("No model configured and could not list models: {e}"))?;
            models.into_iter().next()
                .ok_or_else(|| "No models available at the custom endpoint".to_string())?
        };
        crate::logger::log_info("api::generate", &format!("using model: {model}"));
        return openai_generate(&keys.openai, &keys.base_url, &model, system, user, max_tokens).await;
    }
    if !keys.anthropic.is_empty() {
        return anthropic_generate(
            &keys.anthropic, "claude-haiku-4-5-20251001",
            system, user, max_tokens,
        ).await;
    }
    if !keys.openai.is_empty() {
        return openai_generate(
            &keys.openai, OPENAI_DEFAULT_BASE, "gpt-4o-mini",
            system, user, max_tokens,
        ).await;
    }
    Err("No API key configured for text generation".to_string())
}

async fn anthropic_generate(
    api_key:    &str,
    model:      &str,
    system:     &str,
    user:       &str,
    max_tokens: u32,
) -> Result<String, String> {
    crate::logger::log_info("api::generate", &format!(
        "POST https://api.anthropic.com/v1/messages model={model} max_tokens={max_tokens} \
         system_chars={} system_preview={:?} user_chars={} user_preview={:?}",
        system.len(), trunc(system, 120),
        user.len(),   trunc(user, 120),
    ));
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model":      model,
            "max_tokens": max_tokens,
            "system":     system,
            "messages":   [{ "role": "user", "content": user }],
        }))
        .send()
        .await
        .map_err(|e| format!("Anthropic request: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let err  = format!("Anthropic API {status}: {body}");
        crate::logger::log_error("api::generate", &err);
        return Err(err);
    }
    crate::logger::log_info("api::generate", &format!("{status} OK from anthropic"));
    let v: serde_json::Value = resp.json().await
        .map_err(|e| format!("Anthropic response parse: {e}"))?;
    v["content"][0]["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "Missing text in Anthropic response".to_string())
}

async fn openai_generate(
    api_key:    &str,
    base_url:   &str,
    model:      &str,
    system:     &str,
    user:       &str,
    max_tokens: u32,
) -> Result<String, String> {
    let client  = reqwest::Client::new();
    let payload = serde_json::json!({
        "model":      model,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user",   "content": user },
        ],
    });
    let urls = candidates(base_url, "chat/completions");
    let mut last_err = String::new();

    crate::logger::log_info("api::generate", &format!(
        "POST chat/completions url={} model={model} max_tokens={max_tokens} \
         system_chars={} system_preview={:?} user_chars={} user_preview={:?}",
        urls.first().map(String::as_str).unwrap_or("?"),
        system.len(), trunc(system, 120),
        user.len(),   trunc(user, 120),
    ));

    'url: for url in &urls {
        for attempt in 0..=RETRY_MAX {
            let req = client.post(url).json(&payload);
            let req = if !api_key.is_empty() { req.bearer_auth(api_key) } else { req };
            let resp = req.send().await.map_err(|e| format!("Chat request error: {e}"))?;

            let status = resp.status();
            if status.as_u16() == 404 {
                last_err = format!("404 Not Found at {url}");
                crate::logger::log_info("api::generate", &format!("404 at {url} — trying next"));
                continue 'url;
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                if looks_like_loading(status.as_u16(), &body) && attempt < RETRY_MAX {
                    crate::logger::log_info("api::generate", &format!(
                        "server not ready ({status}) attempt {}/{RETRY_MAX} — retrying in {RETRY_DELAY_MS}ms",
                        attempt + 1
                    ));
                    tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS)).await;
                    continue;
                }
                let err = format!("Chat API {status}: {body}");
                crate::logger::log_error("api::generate", &err);
                return Err(err);
            }
            crate::logger::log_info("api::generate", &format!("{status} OK from {url}"));
            let v: serde_json::Value = resp.json().await
                .map_err(|e| format!("Chat response parse error: {e}"))?;
            return v["choices"][0]["message"]["content"]
                .as_str()
                .map(String::from)
                .ok_or_else(|| "Missing content in chat response".to_string());
        }
    }
    crate::logger::log_error("api::generate", &last_err);
    Err(last_err)
}

/// Verify the Anthropic API key is accepted by posting a minimal messages request.
pub async fn anthropic_check(api_key: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "hi" }],
        }))
        .send()
        .await
        .map_err(|e| format!("Network error reaching Anthropic: {e}"))?;
    let status = resp.status();
    // 200 or any 4xx other than 401/403 means the key was accepted (e.g. 529 overload)
    if status.is_success() || (status.is_client_error() && status != 401 && status != 403) {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    let msg  = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"));
    Err(msg)
}

/// Verify that an API endpoint is reachable by querying /models.
///
/// Uses candidates() so a base_url already ending in /v1 (e.g. http://host:1234/v1)
/// produces only one URL (http://host:1234/v1/models) rather than the double /v1/v1/models.
pub async fn openai_check(api_key: &str, base_url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    for url in candidates(base_url, "models") {
        let req = client.get(&url);
        let req = if !api_key.is_empty() { req.bearer_auth(api_key) } else { req };
        if let Ok(resp) = req.send().await {
            let s = resp.status();
            if s.is_success() {
                crate::logger::log_info("api::check", &format!("models OK at {url}"));
                return Ok(());
            }
            if s == 401 || s == 403 {
                let body = resp.text().await.unwrap_or_default();
                let msg  = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(String::from))
                    .unwrap_or_else(|| format!("HTTP {s}"));
                return Err(msg);
            }
            // 404 → try next candidate
        }
    }

    Err("Could not reach the server. Check the URL and that the server is running.".into())
}

/// Probe an API endpoint and return a human-readable status string.
///
/// Probe order (stops at first success — /health is tried first to avoid triggering model loading):
///   1. GET {url}/health      — liveness check, no model load (LM Studio, llama.cpp)
///   2. GET {url}/v1/health   — same with /v1 prefix
///   3. GET {url}/models      — OpenAI-compatible fallback (cloud APIs that have no /health)
///   4. GET {url}/v1/models   — same, for servers where user omitted /v1
pub async fn test_endpoint(url: &str, api_key: &str) -> Result<String, String> {
    let base = url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Probe /health — does not trigger model loading.
    // Strip /v1 to reach the server root (LM Studio health is at root, not /v1/health).
    let root = base.strip_suffix("/v1").unwrap_or(base);
    let mut health_urls = vec![
        format!("{root}/health"),
        format!("{base}/health"),
        format!("{base}/v1/health"),
    ];
    health_urls.dedup();
    for health_url in &health_urls {
        if let Ok(resp) = client.get(health_url).send().await {
            let s = resp.status();
            if s.is_success() {
                return Ok(format!("Server healthy · {health_url}"));
            }
            if s == 401 || s == 403 {
                return Err(format!("Unauthorized at {health_url}"));
            }
            // 404 → endpoint absent, try next
        }
    }

    // Helper: extract model IDs from an OpenAI-format /models response.
    fn model_summary(body: &str) -> String {
        let names: Vec<String> = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["data"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m["id"].as_str().map(String::from))
            .take(3)
            .collect();
        if names.is_empty() { "connected".into() } else { names.join(", ") }
    }

    // Probe /models — fallback for cloud APIs (OpenAI, etc.) that have no /health.
    for models_url in candidates(base, "models") {
        let req = client.get(&models_url);
        let req = if !api_key.is_empty() { req.bearer_auth(api_key) } else { req };
        if let Ok(resp) = req.send().await {
            let s = resp.status();
            if s.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Ok(format!("Connected · {}", model_summary(&body)));
            }
            if s == 401 || s == 403 {
                let body = resp.text().await.unwrap_or_default();
                let msg  = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(String::from))
                    .unwrap_or_else(|| format!("HTTP {s}"));
                return Err(msg);
            }
        }
    }

    Err("Could not reach the server. Check the URL and that the server is running.".into())
}

/// Return the maximum output tokens for the configured generation model.
///
/// * Custom endpoint  — queries `/v1/models` and reads `context_length` from
///   the first model entry (llama.cpp exposes this field).
/// * Anthropic key    — claude-haiku-4-5 hard limit is 8 192.
/// * OpenAI default   — gpt-4o-mini hard limit is 16 384.
pub async fn get_max_output_tokens(keys: &ApiKeys) -> u32 {
    if !keys.anthropic.is_empty() && keys.base_url.is_empty() {
        return 8_192;
    }
    if !keys.base_url.is_empty() {
        // Ask the server for the model's context_length.
        if let Ok(ctx) = fetch_context_length(&keys.openai, &keys.base_url).await {
            if ctx > 0 {
                crate::logger::log_info("api::max_tokens",
                    &format!("context_length={ctx} from {}", keys.base_url));
                return ctx;
            }
        }
        return 4_096; // conservative fallback for unknown local models
    }
    16_384 // gpt-4o-mini
}

async fn fetch_context_length(api_key: &str, base_url: &str) -> Result<u32, ()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build().map_err(|_| ())?;
    for url in candidates(base_url, "models") {
        let req  = client.get(&url);
        let req  = if !api_key.is_empty() { req.bearer_auth(api_key) } else { req };
        let resp = match req.send().await { Ok(r) => r, Err(_) => continue };
        if !resp.status().is_success() { continue; }
        let v: serde_json::Value = match resp.json().await { Ok(v) => v, Err(_) => continue };
        if let Some(ctx) = v["data"][0]["context_length"].as_u64() {
            return Ok(ctx as u32);
        }
    }
    Err(())
}

/// Fetch model IDs from an OpenAI-compatible /models endpoint.
pub async fn list_models(api_key: &str, base_url: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let urls = candidates(base_url, "models");
    crate::logger::log_info("api::list_models", &format!("GET {urls:?}"));
    for url in &urls {
        let req  = client.get(url);
        let req  = if !api_key.is_empty() { req.bearer_auth(api_key) } else { req };
        let resp = match req.send().await {
            Ok(r)  => r,
            Err(e) => { crate::logger::log_error("api::list_models", &format!("request error at {url}: {e}")); continue }
        };
        let status = resp.status();
        if status.as_u16() == 404 {
            crate::logger::log_info("api::list_models", &format!("404 at {url} — trying next"));
            continue;
        }
        if !status.is_success() {
            crate::logger::log_error("api::list_models", &format!("{status} at {url}"));
            continue;
        }
        let body = match resp.text().await {
            Ok(b)  => b,
            Err(e) => { crate::logger::log_error("api::list_models", &format!("read error: {e}")); continue }
        };
        crate::logger::log_info("api::list_models", &format!(
            "{status} OK from {url} — raw: {}", trunc(&body, 500)
        ));
        let v: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v)  => v,
            Err(e) => { crate::logger::log_error("api::list_models", &format!("parse error: {e}")); continue }
        };
        let ids: Vec<String> = v["data"]
            .as_array().unwrap_or(&vec![])
            .iter()
            .filter_map(|m| m["id"].as_str().map(String::from))
            .collect();
        crate::logger::log_info("api::list_models", &format!("models extracted: {ids:?}"));
        if !ids.is_empty() { return Ok(ids); }
    }
    let err = format!("Could not fetch model list from {base_url}");
    crate::logger::log_error("api::list_models", &err);
    Err(err)
}

/// Extract plain text from a PDF file using the pdf-extract crate.
pub fn extract_pdf_text(path: &str) -> Result<String, String> {
    pdf_extract::extract_text(path).map_err(|e| format!("PDF text extraction: {e}"))
}
