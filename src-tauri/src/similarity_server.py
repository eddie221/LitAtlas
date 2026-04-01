#!/usr/bin/env python3
"""
similarity_server.py — LitAtlas HuggingFace similarity sidecar.

Protocol: newline-delimited JSON over stdin/stdout (Tauri sidecar stdio).

Requests:
  { "id": N, "method": "compute",        "params": { "papers": [...], "config": {...} } }
  { "id": N, "method": "status" }
  { "id": N, "method": "list_models" }
  { "id": N, "method": "check_model",    "params": { "model": "<hf-model-id>" } }
  { "id": N, "method": "download_model", "params": { "model": "<hf-model-id>" } }

Responses:
  { "id": N, "ok": true,  "result": <any>   }
  { "id": N, "ok": false, "error":  "<str>" }

download_model also emits intermediate progress lines before the final reply:
  { "id": N, "ok": true, "progress": {
      "filename": str, "downloaded": int, "total": int, "pct": float } }
"""

import sys
import json
import os
import math
import threading
import time
import traceback
from typing import Any

try:
    import torch
    import numpy as np
except ImportError as _import_err:
    sys.stdout.write(json.dumps({
        "id": 0, "ok": False,
        "error": (
            f"Missing dependency: {_import_err}. "
            "Please re-run 'Setup AI Similarity' from the Similarity Settings panel "
            "to install the required packages."
        )
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)

if torch.cuda.is_available():
    device = "cuda"
elif torch.backends.mps.is_available():
    device = "mps"
else:
    device = "cpu"

# ── User plugin ──────────────────────────────────────────────────────────────
#
# Users can extend LitAtlas with a custom similarity function by creating a
# Python file that defines the following entry point:
#
#   def similarity_fn(papers: list[dict], config: dict) -> list[dict]:
#       """
#       Compute similarity edges for the given papers.
#
#       Parameters
#       ----------
#       papers : list[dict]
#           Each dict is a PaperFull record:
#             { id, title, venue, year, notes, hashtags: [str],
#               authors: [str], attributes: [{key, value, order}] }
#       config : dict
#           The current similarity config:
#             { model, fields, weights, threshold, max_edges, ... }
#           Plus any extra keys the user stored in their app config.
#
#       Returns
#       -------
#       list[dict]
#           Each dict must have:
#             { source_id: int, target_id: int,
#               similarity: float,       # 0.0 – 1.0
#               weight:     int,         # 1 | 2 | 3
#               edge_type:  str }        # "related" | "same_tag" | "same_venue" | ...
#       """
#
# The path to this file is passed at server startup via the environment
# variable LitAtlas_PLUGIN_SCRIPT (set by Rust before spawning the sidecar).
# If the variable is not set, or the file does not define `similarity_fn`,
# the default built-in implementation is used.
#
# Optional additional hooks (all have the same signature contract):
#
#   def compute_embedding_fn(paper: dict, config: dict) -> dict:
#       """
#       Compute per-field embedding vectors for a single paper.
#       Must return: { field_vectors: { field_name: [float, ...] }, dim: int }
#       If absent, the default HuggingFace implementation is used.
#       """

_plugin_similarity_fn        = None  # similarity_fn(papers, config) -> edges
_plugin_compute_embedding_fn = None  # compute_embedding_fn(paper, config) -> {field_vectors, dim}

def _load_plugin() -> None:
    """
    Load the user plugin script if LitAtlas_PLUGIN_SCRIPT is set.
    Called once at startup.  Errors are printed to stderr but never fatal —
    the server always falls back to the built-in implementation.
    """
    global _plugin_similarity_fn, _plugin_compute_embedding_fn
    script = os.environ.get("LitAtlas_PLUGIN_SCRIPT", "").strip()
    if not script:
        return
    if not os.path.isfile(script):
        print(f"[LitAtlas] WARNING: plugin script not found: {script}", file=sys.stderr)
        return
    try:
        import importlib.util
        spec   = importlib.util.spec_from_file_location("_pg_plugin", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if hasattr(module, "similarity_fn"):
            _plugin_similarity_fn = module.similarity_fn
            print(f"[LitAtlas] Loaded plugin similarity_fn from {script}", file=sys.stderr)
        if hasattr(module, "compute_embedding_fn"):
            _plugin_compute_embedding_fn = module.compute_embedding_fn
            print(f"[LitAtlas] Loaded plugin compute_embedding_fn from {script}", file=sys.stderr)
        if not hasattr(module, "similarity_fn") and not hasattr(module, "compute_embedding_fn"):
            print(
                f"[LitAtlas] WARNING: plugin {script} defines neither "
                f"'similarity_fn' nor 'compute_embedding_fn' — no hooks loaded.",
                file=sys.stderr,
            )
    except Exception:
        import traceback
        print(f"[LitAtlas] ERROR loading plugin {script}:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)


# ── Lazy-loaded text model ─────────────────────────────────────────────────────
_model      = None
_model_name = None
_model_lock = threading.Lock()

DEFAULT_MODEL = "google/gemma-3-1b-it"
# Maximum pages of a PDF to extract text from.
PDF_MAX_PAGES = 8

# if torch.cuda.is_available():
#     device = "cuda"
# elif torch.backends.mps.is_available():
#     device = "mps"
# else:
#     device = "cpu"
# print(f"Using {device} device")

def _get_model(model_name: str, allow_download: bool = True):
    """
    Load a HuggingFace model as a (tokenizer, model) tuple.

    Strategy (offline-safe):
      1. If the model is already cached locally, load it with
         local_files_only=True — works with no internet connection.
      2. If NOT cached and allow_download=True, attempt a normal download.
      3. If NOT cached and allow_download=False (or download fails because
         the network is unreachable), raise a clear offline error rather
         than a cryptic huggingface_hub exception.
    """
    global _model, _model_name
    with _model_lock:
        if _model is not None and _model_name == model_name:
            return _model
        try:
            from transformers import AutoTokenizer, Gemma3ForCausalLM

            offline = _model_snapshot_path(model_name) is not None

            # Model not cached yet.
            if not offline and not allow_download:
                raise RuntimeError(
                    f"Model '{model_name}' is not cached locally and the app is "
                    f"in offline mode.  Connect to the internet and download the "
                    f"model first via the Similarity Settings panel."
                )

            hf_token = os.environ.get("HUGGING_FACE_HUB_TOKEN") or None
            kwargs   = {"local_files_only": True} if offline else {}
            if hf_token:
                kwargs["token"] = hf_token
            try:
                tokenizer = AutoTokenizer.from_pretrained(model_name, padding_side = "left", **kwargs)
                model     = Gemma3ForCausalLM.from_pretrained(model_name, trust_remote_code=True, **kwargs)
                model.eval()
            except Exception as dl_err:
                err_str = str(dl_err).lower()
                # Auth / gated-model errors
                if any(kw in err_str for kw in ("401", "403", "gated", "access",
                                                 "authenticate", "restricted",
                                                 "token", "unauthorized")):
                    raise RuntimeError(
                        f"Cannot download model '{model_name}': authentication failed.\n"
                        f"This model may be gated. Set your HuggingFace API token in "
                        f"App Settings → HuggingFace Token, then try again."
                    ) from dl_err
                # Network / connectivity errors
                if any(kw in err_str for kw in ("connection", "network", "timeout",
                                                 "offline", "unreachable", "resolve")):
                    raise RuntimeError(
                        f"Cannot download model '{model_name}': no internet connection.\n"
                        f"Connect to the internet and try again, or download the model "
                        f"while online and it will be available offline afterwards."
                    ) from dl_err
                raise RuntimeError(f"Failed to load model '{model_name}': {dl_err}") from dl_err

            _model      = (tokenizer, model)
            _model_name = model_name
            return _model

        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Failed to load model '{model_name}': {e}") from e



def _pdf_extract_text(pdf_path: str, max_pages: int = PDF_MAX_PAGES) -> str:
    """
    Extract plain text from a PDF using PyMuPDF (fitz), up to max_pages.
    Returns a single string (page texts joined by spaces).
    Returns empty string if fitz is unavailable or the file cannot be opened.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("[LitAtlas] WARNING: PyMuPDF not installed — pdf field skipped.", file=sys.stderr)
        return ""
    if not pdf_path or not os.path.isfile(pdf_path):
        return ""
    try:
        doc   = fitz.open(pdf_path)
        texts = [doc[i].get_text() for i in range(min(len(doc), max_pages))]
        doc.close()
        return " ".join(texts).strip()
    except Exception as e:
        print(f"[LitAtlas] WARNING: pdf text extraction failed: {e}", file=sys.stderr)
        return ""


def _mean_pool(model_output, attention_mask):
    """
    Mean-pool token embeddings across the sequence dimension,
    masking out padding tokens, then L2-normalise each row.
    Returns a numpy array of shape (batch, dim).
    """
    token_embeddings = model_output.hidden_states[-1]            # (B, T, D)
    # # Sanitise model output — some models (e.g. Gemma on MPS) can emit NaN/Inf
    # # in hidden states due to numerical overflow; replace them with 0 so pooling
    # # and normalisation stay well-defined and JSON serialisation never produces
    # # bare NaN/Infinity tokens that serde_json rejects.
    # token_embeddings = torch.nan_to_num(token_embeddings, nan=0.0, posinf=0.0, neginf=0.0)
    # mask = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
    # summed = torch.sum(token_embeddings * mask, dim=1)
    # counts = torch.clamp(mask.sum(dim=1), min=1e-9)
    # pooled = summed / counts                                      # (B, D)
    # norms  = pooled.norm(dim=1, keepdim=True).clamp(min=1e-9)
    # result = (pooled / norms).detach().cpu()
    # # Final safety: nan_to_num again in case any residual NaN survived
    # return torch.nan_to_num(result, nan=0.0, posinf=0.0, neginf=0.0).numpy()  # (B, D)
    return token_embeddings[:, -1]


# ── HuggingFace cache helpers ─────────────────────────────────────────────────

def _hf_cache_dir() -> str:
    hf_home = os.environ.get("HF_HOME") or os.path.join(
        os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
        "huggingface",
    )
    return os.path.join(hf_home, "hub")


def _model_snapshot_path(model_id: str):
    """
    Return the snapshot directory for model_id if fully cached, else None.
    A model is cached when at least one snapshot directory contains config.json.
    """
    safe      = model_id.replace("/", "--")
    snap_root = os.path.join(_hf_cache_dir(), f"models--{safe}", "snapshots")
    if not os.path.isdir(snap_root):
        return None
    for snap in os.listdir(snap_root):
        candidate = os.path.join(snap_root, snap)
        if os.path.isfile(os.path.join(candidate, "config.json")):
            return candidate
    return None


# ── check_model ───────────────────────────────────────────────────────────────

def handle_check_model(req_id: Any, model_id: str) -> None:
    """
    Filesystem-only cache check — never touches the network.
    Returns { cached: bool, path?: str, offline_ready: bool }.
    offline_ready is True when the model can be loaded without a network
    connection (i.e. a complete snapshot exists in the HF cache).
    """
    path = _model_snapshot_path(model_id)
    if path:
        ok(req_id, {"cached": True, "path": path, "offline_ready": True})
    else:
        ok(req_id, {"cached": False, "offline_ready": False})


# ── download_model ────────────────────────────────────────────────────────────

_DOWNLOAD_MAX_RETRIES = 3
_DOWNLOAD_RETRY_DELAY = 5   # seconds between retries (network errors only)

def handle_download_model(req_id: Any, model_id: str) -> None:
    """
    Download model_id using AutoTokenizer.from_pretrained /
    AutoModel.from_pretrained (via _get_model), which is HuggingFace's
    native download-and-cache mechanism.

    Protection mechanism:
    • Auth / gated-model errors (401 / 403 / "gated") are reported immediately
      with a helpful message — no retries since a bad token won't fix itself.
    • Transient network errors are retried up to _DOWNLOAD_MAX_RETRIES times
      with a _DOWNLOAD_RETRY_DELAY-second pause between attempts.

    The model stays loaded in memory after this call so the first
    compute_embedding request is instant.  Elapsed wall-clock time is
    written to stderr.
    """
    t0       = time.monotonic()
    last_err: Exception | None = None

    for attempt in range(1, _DOWNLOAD_MAX_RETRIES + 1):
        try:
            print(
                f"[LitAtlas] download_model: attempt {attempt}/{_DOWNLOAD_MAX_RETRIES} '{model_id}'",
                file=sys.stderr, flush=True,
            )
            _get_model(model_id, allow_download=True)
            elapsed = time.monotonic() - t0
            print(
                f"[LitAtlas] download_model: '{model_id}' completed in {elapsed:.1f}s",
                file=sys.stderr, flush=True,
            )
            ok(req_id, {"done": True})
            return
        except RuntimeError as exc:
            last_err = exc
            msg = str(exc)
            print(f"[LitAtlas] download_model error (attempt {attempt}): {msg}",
                  file=sys.stderr, flush=True)
            # Auth errors — never retry, user must fix the token
            if any(kw in msg.lower() for kw in
                   ("authentication failed", "gated", "401", "403", "unauthorized")):
                err(req_id, msg)
                return
            # Network errors — wait and retry
            if attempt < _DOWNLOAD_MAX_RETRIES:
                print(f"[LitAtlas] download_model: retrying in {_DOWNLOAD_RETRY_DELAY}s…",
                      file=sys.stderr, flush=True)
                time.sleep(_DOWNLOAD_RETRY_DELAY)
        except Exception:
            last_err = None
            print(
                f"[LitAtlas] download_model: '{model_id}' failed\n{traceback.format_exc()}",
                file=sys.stderr, flush=True,
            )
            err(req_id, f"Model download failed:\n{traceback.format_exc()}")
            return

    err(req_id, f"Model download failed after {_DOWNLOAD_MAX_RETRIES} attempts:\n{last_err}")


# ── Paper → text ──────────────────────────────────────────────────────────────

def _attr(paper: dict, key: str, fallback: str = "") -> str:
    for a in paper.get("attributes", []):
        if a.get("key") == key:
            return a.get("value", fallback)
    return fallback


def _field_text(paper: dict, field: str) -> str:
    """Extract the text for one field from a paper dict.

    For the "pdf" field, text is extracted from the PDF file at pdf_path using
    PyMuPDF so it can be embedded by the same text model as all other fields.
    Papers without a pdf_path silently return an empty string and are skipped.
    """
    if field == "title":    return paper.get("title", "")
    if field == "abstract": return _attr(paper, "abstract")
    if field == "venue":    return paper.get("venue", "")
    if field == "hashtags": return " ".join(t.lstrip("#") for t in paper.get("hashtags", []))
    if field == "notes":    return paper.get("notes", "") or ""
    if field == "year":     return str(paper.get("year", ""))
    if field == "pdf":      return _pdf_extract_text(paper.get("pdf_path") or "")
    return _attr(paper, field)   # custom attribute key


def paper_embedding(paper: dict, fields: list, weights: dict, model) -> list:
    """
    Compute a paper's embedding as a weighted sum of per-field embeddings,
    then L2-normalise the result.

    Algorithm:
      1. For each enabled field, extract its text.
      2. Batch-encode all non-empty field texts in a single model.encode() call.
      3. Weighted-sum the resulting vectors using the user-defined weights.
      4. L2-normalise the composite vector so cosine similarity works correctly.

    This is semantically correct: each field's meaning lives in its own region
    of the embedding space, and the weight controls how much that region pulls
    the final vector.  Repeating concatenated text (the old approach) is a
    crude proxy — it shifts the distribution of tokens but doesn't cleanly
    decompose field contributions.

    Falls back to encoding just the title if every field is empty.
    """
    # Gather (field, text, weight) triples for non-empty fields
    items = []
    for field in fields:
        text = _field_text(paper, field).strip()
        if text:
            w = float(weights.get(field, 1.0))
            if w > 0:
                items.append((field, text, w))

    # Fallback: always include title with weight 1 if nothing else is available
    if not items:
        title = paper.get("title", "").strip()
        items = [("title", title or "unknown", 1.0)]

    # Batch encode all field texts at once (single GPU/CPU pass)
    texts = [text for _, text, _ in items]
    tokenizer, hf_model = model
    hf_model.to(device)
    inputs = tokenizer(texts, padding=True, truncation=True, max_length=512, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = hf_model(**inputs, output_hidden_states = True)
    vecs = _mean_pool(outputs, inputs["attention_mask"])

    # Weighted sum — skip any field whose encoded vector is effectively zero
    # (all-zero vectors arise when text was empty or NaN sanitisation zeroed out
    # a degenerate model output; including them would dilute the composite).
    dim       = vecs.shape[1]
    composite = [0.0] * dim
    for (_, _, w), vec in zip(items, vecs):
        sanitized = [0.0 if (math.isnan(float(vec[k])) or math.isinf(float(vec[k]))) else float(vec[k])
                     for k in range(dim)]
        if not any(v != 0.0 for v in sanitized):
            continue  # skip degenerate / empty-field vector
        for k, v in enumerate(sanitized):
            composite[k] += w * v

    # L2-normalise so downstream cosine() works correctly on these vectors
    norm = math.sqrt(sum(x * x for x in composite))
    if norm > 0:
        composite = [x / norm for x in composite]

    return composite


# ── Cosine / edge helpers ─────────────────────────────────────────────────────

def cosine(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(y * y for y in b))
    return 0.0 if (na == 0 or nb == 0) else dot / (na * nb)

def edge_weight(sim: float) -> int:
    return 3 if sim >= 0.75 else 2 if sim >= 0.55 else 1

def edge_type(a: dict, b: dict) -> str:
    at = set(t.lstrip("#") for t in a.get("hashtags", []))
    bt = set(t.lstrip("#") for t in b.get("hashtags", []))
    if at & bt: return "same_tag"
    if a.get("venue") and a.get("venue") == b.get("venue"): return "same_venue"
    return "related"


# ── Available models / fields ─────────────────────────────────────────────────

AVAILABLE_MODELS = [
    # Gemma-3-1B-IT is the sole built-in model.
    # It is a gated model — users must accept the license on HuggingFace and
    # set their API token in App Settings → HuggingFace Token before downloading.
    { "id": DEFAULT_MODEL,
      "label": "Gemma 3 1B IT (default)",
      "description": "Default text embedding model. Lightweight and fast. Supports all text fields and PDF text extraction. Requires a HuggingFace API token (gated model).",
      "size_mb": 2000,
      "gated": True },
]

AVAILABLE_FIELDS = [
    { "key": "title",    "label": "Title",    "default_weight": 1.5 },
    { "key": "abstract", "label": "Abstract", "default_weight": 2.0 },
    { "key": "venue",    "label": "Venue",    "default_weight": 0.5 },
    { "key": "hashtags", "label": "Hashtags", "default_weight": 1.0 },
    { "key": "notes",    "label": "Notes",    "default_weight": 0.5 },
    { "key": "year",     "label": "Year",     "default_weight": 0.2 },
    # PDF text is extracted with PyMuPDF and embedded like any other text field.
    # Papers without an uploaded PDF silently skip this field during encoding.
    { "key": "pdf",      "label": "PDF (text)", "default_weight": 2.0 },
]


# ── Compute ───────────────────────────────────────────────────────────────────


def compute_embedding(paper: dict, config: dict) -> dict:
    """
    Compute and return raw per-field embedding vectors for a single paper.

    Returns:
      {
        "field_vectors": { "<field>": [float, ...], ... },  # one raw vector per field
        "dim":           int,
      }

    No composite vector is returned here.  The composite is recomposed at query
    time by Rust (inject_cached_embeddings / recompose_embedding) using whatever
    weights the user currently has set.  This means embedding.json stays valid
    across weight changes — only a model or field-set change triggers re-encoding.

    The "pdf" field is handled by extracting text from the PDF with PyMuPDF and
    embedding it with the same text model as all other fields.  Papers without an
    uploaded PDF silently skip the "pdf" field.
    """
    print("[LitAtlas] compute_embedding: called", file=sys.stderr)
    # Delegate to user plugin if one was loaded at startup.
    if _plugin_compute_embedding_fn is not None:
        try:
            return _plugin_compute_embedding_fn(paper, config)
        except Exception:
            print("[LitAtlas] plugin compute_embedding_fn raised — falling back to built-in:",
                  file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    model_name    = config.get("model", DEFAULT_MODEL)
    fields        = config.get("fields", ["title", "abstract", "hashtags"])
    field_vectors = {}
    dim           = 0

    tokenizer, hf_model = _get_model(model_name)
    hf_model.to(device)

    items = []
    for field in fields:
        text = _field_text(paper, field).strip()
        inputs = tokenizer(text, max_length=512, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = hf_model(**inputs, output_hidden_states = True)
        vecs = _mean_pool(outputs, inputs["attention_mask"])
        dim  = vecs.shape[1]

        raw = vecs[0].tolist()
        field_vectors[field] = raw
        
    return {"field_vectors": field_vectors, "dim": dim}


def compute(papers: list, config: dict) -> list:
    # Delegate to user plugin if one was loaded at startup.
    if _plugin_similarity_fn is not None:
        try:
            return _plugin_similarity_fn(papers, config)
        except Exception:
            import traceback
            print("[LitAtlas] plugin similarity_fn raised an error — falling back to built-in:",
                  file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            # Fall through to built-in implementation below.

    model_name = config.get("model", DEFAULT_MODEL)
    fields     = config.get("fields",    ["title", "abstract", "hashtags"])
    weights    = config.get("weights",   {})
    threshold  = float(config.get("threshold", 0.38))
    max_edges  = int(config.get("max_edges",   7))
    if not papers: return []
    model      = _get_model(model_name)

    print(fields, file=sys.stderr)

    # Build composite embedding vectors for all papers.
    #
    # Rust's inject_cached_embeddings pre-processes the papers list before this
    # call: for each paper whose embedding.json is cached (model+fields match),
    # it recomposes the weighted composite from the stored raw field_vectors using
    # the *current* weights, then injects it as paper["_embedding"].
    #
    # Here we simply use those pre-recomposed vectors directly.  Papers without
    # a cache hit (new papers, or after a model/field change) are encoded fresh
    # via paper_embedding(), which applies weights during encoding.
    vecs             = []
    papers_to_encode = []   # (original_index, paper_dict) needing fresh encoding
    for i, p in enumerate(papers):
        cached_vec = p.get("_embedding")
        if isinstance(cached_vec, list) and len(cached_vec) > 0:
            vecs.append(cached_vec)
        else:
            vecs.append(None)
            papers_to_encode.append((i, p))

    for i, p in papers_to_encode:
        vecs[i] = paper_embedding(p, fields, weights, model).to(device)

    n = len(papers)
    candidates = []
    for i in range(n):
        for j in range(i + 1, n):
            sim = cosine(vecs[i], vecs[j])
            if sim >= threshold:
                candidates.append({
                    "source_id": papers[i]["id"], "target_id": papers[j]["id"],
                    "similarity": round(sim, 6), "weight": edge_weight(sim),
                    "edge_type": edge_type(papers[i], papers[j]),
                    "_i": i, "_j": j,
                })
    candidates.sort(key=lambda e: e["similarity"], reverse=True)
    edge_count = [0] * n
    result = []
    for e in candidates:
        i, j = e["_i"], e["_j"]
        if edge_count[i] < max_edges and edge_count[j] < max_edges:
            edge_count[i] += 1; edge_count[j] += 1
            result.append({k: e[k] for k in
                           ("source_id","target_id","similarity","weight","edge_type")})
    return result


# ── Plugin validation ────────────────────────────────────────────────────────

def _handle_validate_plugin(req_id, script_path: str) -> None:
    """
    Validate a plugin script without loading it permanently.
    Reports which hooks it exports and whether it can be imported cleanly.
    """
    if not script_path:
        ok(req_id, {"valid": False, "error": "No script path provided."})
        return
    if not os.path.isfile(script_path):
        ok(req_id, {"valid": False, "error": f"File not found: {script_path}"})
        return
    try:
        import importlib.util
        spec   = importlib.util.spec_from_file_location("_pg_plugin_validate", script_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        has_sim = hasattr(module, "similarity_fn")
        has_emb = hasattr(module, "compute_embedding_fn")
        ok(req_id, {
            "valid":               True,
            "has_similarity_fn":   has_sim,
            "has_embedding_fn":    has_emb,
        })
    except Exception:
        import traceback
        ok(req_id, {
            "valid": False,
            "error": traceback.format_exc(),
        })


# ── JSON-RPC helpers ──────────────────────────────────────────────────────────

def reply(req_id: Any, ok_flag: bool, key: str, val: Any) -> None:
    sys.stdout.write(json.dumps({"id": req_id, "ok": ok_flag, key: val}) + "\n")
    sys.stdout.flush()

def ok(req_id: Any, result: Any)   -> None: reply(req_id, True,  "result", result)
def err(req_id: Any, message: str) -> None: reply(req_id, False, "error",  message)


# ── Dispatcher ────────────────────────────────────────────────────────────────

def handle(line: str) -> None:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        err(None, f"JSON parse error: {e}"); return

    req_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params") or {}

    try:
        if   method == "status":
            offline_models = [m["id"] for m in AVAILABLE_MODELS
                              if _model_snapshot_path(m["id"]) is not None]
            ok(req_id, {
                "ready":          True,
                "loaded_model":   _model_name,
                "python":         sys.version,
                "offline_models": offline_models,
            })
        elif method == "list_models":
            models_annotated = [
                {**m, "cached": _model_snapshot_path(m["id"]) is not None}
                for m in AVAILABLE_MODELS
            ]
            ok(req_id, {
                "models":        models_annotated,
                "fields":        AVAILABLE_FIELDS,
                "default_model": DEFAULT_MODEL,
            })
        elif method == "check_model":    handle_check_model(req_id, params.get("model", ""))
        elif method == "download_model": handle_download_model(req_id, params.get("model", ""))
        elif method == "compute_embedding":
            # Encode a single paper; returns { field_vectors, dim }.
            # Params: { paper: <PaperFull>, config: { model, fields } }
            result = compute_embedding(params.get("paper", {}), params.get("config", {}))
            ok(req_id, result)
        elif method == "compute":
            print(params, file=sys.stderr)
            edges = compute(params.get("papers", []), params.get("config", {}))
            ok(req_id, {"edges": edges, "count": len(edges)})
        elif method == "validate_plugin":
            # Validate a plugin script without loading it permanently.
            # Params: { script_path: str }
            # Returns: { valid: bool, has_similarity_fn: bool, has_embedding_fn: bool, error?: str }
            _handle_validate_plugin(req_id, params.get("script_path", ""))
        else:
            err(req_id, f"Unknown method: '{method}'")
    except Exception:
        err(req_id, traceback.format_exc())


def main() -> None:
    # Load user plugin script (if LitAtlas_PLUGIN_SCRIPT env var is set).
    _load_plugin()
    sys.stdout.write(json.dumps({"id": 0, "ok": True, "result": "ready"}) + "\n")
    sys.stdout.flush()
    for raw in sys.stdin:
        line = raw.strip()
        if line: handle(line)


if __name__ == "__main__":
    main()