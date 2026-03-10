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
import torch
import numpy as np
from qwen_vl_utils import process_vision_info

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


# ── Lazy-loaded sentence-transformer model ────────────────────────────────────
_model      = None
_model_name = None
_model_lock = threading.Lock()

# ── Lazy-loaded vision-language model (default and PDF field) ─────────────────
#
# Qwen3-VL-8B-Instruct is the default built-in model.  It handles all text
# fields via its language encoder and the "pdf" field by rendering pages as
# images.  Loaded lazily on the first embedding request and kept in memory
# for the lifetime of the process.
_vl_model      = None   # (processor, model) tuple
_vl_model_name = None
_vl_model_lock = threading.Lock()

VL_DEFAULT_MODEL = "Qwen/Qwen3-VL-2B-Instruct"
# Maximum pages rendered per PDF.  Qwen3-VL handles multi-image input well
# but memory grows with page count.  Adjust if needed.
PDF_MAX_PAGES = 8
# Resolution multiplier for fitz page rendering (1.5 → ~108 DPI, good balance)
PDF_RENDER_SCALE = 1.5

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
            from transformers import AutoTokenizer, AutoModel

            offline = _model_snapshot_path(model_name) is not None

            # Model not cached yet.
            if not offline and not allow_download:
                raise RuntimeError(
                    f"Model '{model_name}' is not cached locally and the app is "
                    f"in offline mode.  Connect to the internet and download the "
                    f"model first via the Similarity Settings panel."
                )

            kwargs = {"local_files_only": True} if offline else {}
            try:
                tokenizer = AutoTokenizer.from_pretrained(model_name, **kwargs)
                model     = AutoModel.from_pretrained(model_name, trust_remote_code=True, **kwargs)
                model.eval()
            except Exception as dl_err:
                # Distinguish a network failure from other errors so the user
                # gets a meaningful message when offline.
                err_str = str(dl_err).lower()
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



def _get_vl_model(model_name: str = VL_DEFAULT_MODEL, allow_download: bool = True):
    """
    Load a Qwen3-VL (or compatible) vision-language model as a
    (processor, model) tuple.

    Uses the same offline-safe strategy as _get_model():
      1. If a snapshot exists locally -> load with local_files_only=True.
      2. Otherwise attempt a network download (if allow_download=True).
    """
    global _vl_model, _vl_model_name
    with _vl_model_lock:
        if _vl_model is not None and _vl_model_name == model_name:
            
            return _vl_model
        try:
            from transformers import AutoProcessor, AutoModelForImageTextToText

            offline = _model_snapshot_path(model_name) is not None
            if not offline and not allow_download:
                raise RuntimeError(
                    f"VL model '{model_name}' is not cached locally and the app is "
                    f"in offline mode.  Download the model first via Similarity Settings."
                )

            kwargs = {"local_files_only": True} if offline else {}
            try:
                processor = AutoProcessor.from_pretrained(model_name, **kwargs)
                vl_model  = AutoModelForImageTextToText.from_pretrained(
                    model_name,
                    torch_dtype=torch.float16 if device != "cpu" else torch.float32,
                    trust_remote_code=True,
                    **kwargs,
                )
                vl_model.eval()
                vl_model.to(device)
            except Exception as dl_err:
                print(f"[LitAtlas] {dl_err}: checked", file=sys.stderr)
                err_str = str(dl_err).lower()
                if any(kw in err_str for kw in ("connection", "network", "timeout",
                                                  "offline", "unreachable", "resolve")):
                    raise RuntimeError(
                        f"Cannot download VL model '{model_name}': no internet connection."
                    ) from dl_err
                raise RuntimeError(f"Failed to load VL model '{model_name}': {dl_err}") from dl_err

            _vl_model      = (processor, vl_model)
            _vl_model_name = model_name
            return _vl_model

        # except RuntimeError:
        #     raise
        except Exception as e:
            print(f"[LitAtlas] {e}: checked", file=sys.stderr)
            raise RuntimeError(f"Failed to load VL model '{model_name}': {e}") from e


def _pdf_to_images(pdf_path: str, max_pages: int = PDF_MAX_PAGES, scale: float = PDF_RENDER_SCALE):
    """
    Render PDF pages to PIL Images using PyMuPDF (fitz).

    Returns a list of PIL.Image objects (RGB), capped at max_pages.
    Raises RuntimeError if fitz or the PDF cannot be opened.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError(
            "PyMuPDF is not installed.  Add pymupdf to the venv requirements."
        )
    try:
        from PIL import Image as PILImage
        import io
    except ImportError:
        raise RuntimeError("Pillow is not installed in the similarity venv.")

    if not pdf_path or not os.path.isfile(pdf_path):
        raise RuntimeError(f"PDF not found at path: {pdf_path!r}")

    doc    = fitz.open(pdf_path)
    mat    = fitz.Matrix(scale, scale)
    images = []
    for page_idx in range(min(len(doc), max_pages)):
        page   = doc[page_idx]
        pix    = page.get_pixmap(matrix=mat, alpha=False)
        img    = PILImage.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        images.append(img)
    doc.close()
    return images


def _pdf_field_vector(pdf_path: str, model_name: str = VL_DEFAULT_MODEL) -> list:
    """
    Produce a single embedding vector for a PDF by:
      1. Rendering each page to an image with fitz.
      2. Passing all page images + a fixed extraction prompt to Qwen3-VL.
      3. Mean-pooling the last hidden state across the sequence dimension.
      4. L2-normalising the result.

    Returns a plain Python list of floats.
    """
    images = _pdf_to_images(pdf_path)
    
    if not images:
        raise RuntimeError("No pages could be rendered from the PDF.")

    # print(f"[LitAtlas] {model_name}: checked", file=sys.stderr)
    processor, vl_model = _get_vl_model(model_name)
    # print(f"[LitAtlas] after get model: checked", file=sys.stderr)

    # Build a multi-image chat message.
    question = "These are pages from an academic paper.  " \
                "Summarise the paper's topic, methodology, and key findings " \
                "in a single dense paragraph suitable for semantic similarity search."
    image_content = [{"type": "image", "image": img} for img in images]
    messages = [
        {
            "role": "user",
            "content": image_content + [
                {
                    "type": "text",
                    "text": (
                        question
                    ),
                }
            ],
        }
    ]
    # Apply chat template and prepare tensors.

    try:
        inputs = processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt"
        ).to(device)
    except Exception as e:
        # print(f"[LitAtlas] {e}: checked", file=sys.stderr)
        raise RuntimeError(f"Processor error for VL model '{model_name}': {e}") from e

    # print(f"[LitAtlas] before model: checked", file=sys.stderr)
    try:
        with torch.no_grad():
            outputs = vl_model(**inputs, output_hidden_states=True)
    except Exception as e:
        print(f"[LitAtlas] {e}: checked", file=sys.stderr)
        raise RuntimeError(f"Processor error for VL model '{model_name}': {e}") from e
    # print(f"[LitAtlas] {outputs.hidden_states[-1].shape}: checked", file=sys.stderr)
    # Mean-pool the last hidden layer (shape: 1 x seq_len x hidden_dim).
    last_hidden = outputs.hidden_states[-1]          # (1, T, D)
    attn_mask   = inputs.get("attention_mask")
    if attn_mask is not None:
        mask   = attn_mask.unsqueeze(-1).expand(last_hidden.size()).float()
        summed = torch.sum(last_hidden * mask, dim=1)
        counts = torch.clamp(mask.sum(dim=1), min=1e-9)
        pooled = (summed / counts).squeeze(0)        # (D,)
    else:
        pooled = last_hidden.mean(dim=1).squeeze(0)  # (D,)

    # L2-normalise.
    norm   = pooled.norm().clamp(min=1e-9)
    vector = (pooled / norm).detach().cpu().float().tolist()
    print(f"[LitAtlas] before return {len(vector)}: checked", file=sys.stderr)
    return vector


def _mean_pool(model_output, attention_mask):
    """
    Mean-pool token embeddings across the sequence dimension,
    masking out padding tokens, then L2-normalise each row.
    Returns a numpy array of shape (batch, dim).
    """
    token_embeddings = model_output.last_hidden_state            # (B, T, D)
    mask = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
    summed = torch.sum(token_embeddings * mask, dim=1)
    counts = torch.clamp(mask.sum(dim=1), min=1e-9)
    pooled = summed / counts                                      # (B, D)
    norms  = pooled.norm(dim=1, keepdim=True).clamp(min=1e-9)
    return (pooled / norms).detach().cpu().numpy()                # (B, D)


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

def handle_download_model(req_id: Any, model_id: str) -> None:
    """
    Download model_id using AutoTokenizer.from_pretrained /
    AutoModel.from_pretrained (via _get_model), which is HuggingFace's
    native download-and-cache mechanism.

    The model stays loaded in memory after this call so the first
    compute_embedding request is instant.  Elapsed wall-clock time is
    written to stderr.
    """
    try:
        t0 = time.monotonic()
        print(f"[LitAtlas] download_model: starting '{model_id}'", file=sys.stderr, flush=True)
        _get_model(model_id, allow_download=True)
        elapsed = time.monotonic() - t0
        print(
            f"[LitAtlas] download_model: '{model_id}' completed in {elapsed:.1f}s",
            file=sys.stderr, flush=True,
        )
        ok(req_id, {"done": True})
    except Exception:
        print(
            f"[LitAtlas] download_model: '{model_id}' failed\n{traceback.format_exc()}",
            file=sys.stderr, flush=True,
        )
        err(req_id, f"Model download failed:\n{traceback.format_exc()}")


# ── Paper → text ──────────────────────────────────────────────────────────────

def _attr(paper: dict, key: str, fallback: str = "") -> str:
    for a in paper.get("attributes", []):
        if a.get("key") == key:
            return a.get("value", fallback)
    return fallback


def _field_text(paper: dict, field: str) -> str:
    """Extract the raw text for one field from a paper dict.

    For the special "pdf" field this returns the file-system path stored in
    paper["pdf_path"] rather than text.  Callers that need actual text must
    check for the pdf field explicitly and route to _pdf_field_vector instead.
    """
    if field == "title":    return paper.get("title", "")
    if field == "abstract": return _attr(paper, "abstract")
    if field == "venue":    return paper.get("venue", "")
    if field == "hashtags": return " ".join(t.lstrip("#") for t in paper.get("hashtags", []))
    if field == "notes":    return paper.get("notes", "") or ""
    if field == "year":     return str(paper.get("year", ""))
    if field == "pdf":      return paper.get("pdf_path") or ""  # path, not text
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
        outputs = hf_model(**inputs)
    vecs = _mean_pool(outputs, inputs["attention_mask"])

    # Weighted sum
    dim       = vecs.shape[1]
    composite = [0.0] * dim
    for (_, _, w), vec in zip(items, vecs):
        for k in range(dim):
            composite[k] += w * float(vec[k])

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
    # ── Default built-in model ────────────────────────────────────────────────
    # Qwen3-VL-8B is the sole default model.  It handles both text fields
    # (via its language encoder) and the "pdf" field (page images via vision
    # encoder).  Requires the transformers ≥ 4.51 and a reasonably modern GPU
    # for comfortable throughput; CPU inference is slow but functional.
    { "id": VL_DEFAULT_MODEL,
      "label": "Qwen3-VL-2B (default)",
      "description": "Default vision-language model.  Handles all text fields and PDF page images.  Works best with a GPU.", "size_mb": 16000 },
]

AVAILABLE_FIELDS = [
    { "key": "title",    "label": "Title",    "default_weight": 1.5 },
    { "key": "abstract", "label": "Abstract", "default_weight": 2.0 },
    { "key": "venue",    "label": "Venue",    "default_weight": 0.5 },
    { "key": "hashtags", "label": "Hashtags", "default_weight": 1.0 },
    { "key": "notes",    "label": "Notes",    "default_weight": 0.5 },
    { "key": "year",     "label": "Year",     "default_weight": 0.2 },
    # ── Visual field ──────────────────────────────────────────────────────────
    # Requires Qwen3-VL-8B and a PDF uploaded for the paper.
    # Papers without a PDF silently skip this field during encoding.
    { "key": "pdf",      "label": "PDF (visual)", "default_weight": 2.0 },
]


# ── Compute ───────────────────────────────────────────────────────────────────

def _is_vl_model(model_name: str) -> bool:
    """
    Return True when model_name is a vision-language model that should be
    loaded via _get_vl_model() rather than _get_model().

    Currently identifies any model whose ID contains "-VL-" (case-insensitive),
    which covers Qwen2.5-VL-*, Qwen3-VL-*, and compatible models.
    """
    return "-vl-" in model_name.lower()


def _vl_text_embedding(texts: list, model_name: str) -> "np.ndarray":
    """
    Produce mean-pooled, L2-normalised embeddings for a batch of text strings
    using the VL model's language encoder (no images involved).

    The VL model receives each text as a plain user message.  The last hidden
    state is mean-pooled across the sequence dimension and L2-normalised, matching
    the strategy used for PDF page image embeddings.

    Returns a numpy array of shape (len(texts), hidden_dim).
    """
    import numpy as np
    processor, vl_model = _get_vl_model(model_name)

    # Build a minimal single-turn chat message for each text.
    vectors = []
    for text in texts:
        messages = [{"role": "user", "content": [{"type": "text", "text": text}]}]
        try:
            text_input = processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=False
            )
        except Exception:
            # Fallback: use raw text if chat template is unavailable.
            text_input = text

        inputs = processor(
            text=[text_input],
            return_tensors="pt",
            padding=True,
        ).to(device)

        with torch.no_grad():
            outputs = vl_model(**inputs, output_hidden_states=True)

        last_hidden = outputs.hidden_states[-1]          # (1, T, D)
        attn_mask   = inputs.get("attention_mask")
        if attn_mask is not None:
            mask   = attn_mask.unsqueeze(-1).expand(last_hidden.size()).float()
            summed = torch.sum(last_hidden * mask, dim=1)
            counts = torch.clamp(mask.sum(dim=1), min=1e-9)
            pooled = (summed / counts).squeeze(0)        # (D,)
        else:
            pooled = last_hidden.mean(dim=1).squeeze(0)  # (D,)

        norm   = pooled.norm().clamp(min=1e-9)
        vector = (pooled / norm).detach().cpu().float().numpy()
        vectors.append(vector)

    return np.stack(vectors, axis=0)


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

    When the selected model is a VL model (e.g. Qwen3-VL-8B), ALL fields —
    including text fields — are encoded via the VL model's language encoder so
    that text and PDF embeddings live in the same vector space.  The "pdf"
    field uses page images; all other fields use text-only prompts.
    """
    print("[LitAtlas] compute_embedding: called",
                  file=sys.stderr)
    # Delegate to user plugin if one was loaded at startup.
    if _plugin_compute_embedding_fn is not None:
        try:
            return _plugin_compute_embedding_fn(paper, config)
        except Exception:
            import traceback
            print("[LitAtlas] plugin compute_embedding_fn raised — falling back to built-in:",
                  file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    model_name = config.get("model", VL_DEFAULT_MODEL)
    fields     = config.get("fields", ["title", "abstract", "hashtags"])

    # vl_model may be passed as JSON null from Rust; treat that as "use default".
    vl_model_name = config.get("vl_model") or VL_DEFAULT_MODEL

    field_vectors = {}
    dim           = 0

    pdf_fields  = [f for f in fields if f == "pdf"]
    text_fields = [f for f in fields if f != "pdf"]

    # ── PDF field (visual embedding via VL model) ─────────────────────────────
    # Always routed through the VL model regardless of model_name selection.
    # Papers without a pdf_path silently skip this field.
    print(f"[LitAtlas] {pdf_fields}: checked", file=sys.stderr)
    if pdf_fields:
        print(f"[LitAtlas] {paper.get("pdf_path")}: checked", file=sys.stderr)
        pdf_path = (paper.get("pdf_path") or "").strip()
        if pdf_path:
            try:
                print(f"[LitAtlas] before _pdf_field_vector: checked", file=sys.stderr)
                pdf_vec = _pdf_field_vector(pdf_path, vl_model_name)
                # print(f"[LitAtlas] {pdf_vec}: checked", file=sys.stderr)
                field_vectors["pdf"] = pdf_vec
                if dim == 0:
                    dim = len(pdf_vec)
                print(
                    f"[LitAtlas] pdf field encoded for paper {paper.get('id')!r} "
                    f"({len(pdf_vec)}-dim)",
                    file=sys.stderr,
                )
            except Exception as e:
                print(f"[LitAtlas] {e}: checked", file=sys.stderr)
                print(
                    f"[LitAtlas] WARNING: pdf field encoding failed for paper "
                    f"{paper.get('id')!r} — skipping:\n" + traceback.format_exc(),
                    file=sys.stderr,
                )
        else:
            print(
                f"[LitAtlas] pdf field requested but no pdf_path for paper "
                f"{paper.get('id')!r} — skipping.",
                file=sys.stderr,
            )

    # ── Text fields ───────────────────────────────────────────────────────────
    # Route through VL model when model_name is a VL model so that text and PDF
    # embeddings share the same vector space.  Otherwise use the lightweight
    # sentence-transformer path (_get_model).
    if text_fields:
        items = []
        for field in text_fields:
            text = _field_text(paper, field).strip()
            if text:
                items.append((field, text))

        if not items and not field_vectors:
            # Absolute fallback: encode title so the paper always has something.
            title = paper.get("title", "").strip()
            items = [("title", title or "unknown")]

        if items:
            texts = [text for _, text in items]

            if _is_vl_model(model_name):
                # Use VL language encoder so text and PDF vectors are in the same space.
                vecs = _vl_text_embedding(texts, vl_model_name)   # (N, D) numpy
                text_dim = vecs.shape[1]
                if dim == 0:
                    dim = text_dim
                for (field, _), vec in zip(items, vecs):
                    field_vectors[field] = vec.tolist()
            else:
                # Legacy sentence-transformer path for non-VL models.
                model = _get_model(model_name)
                tokenizer, hf_model = model
                hf_model.to(device)
                inputs = tokenizer(
                    texts, padding=True, truncation=True, max_length=512, return_tensors="pt"
                ).to(device)
                with torch.no_grad():
                    outputs = hf_model(**inputs)
                vecs = _mean_pool(outputs, inputs["attention_mask"])
                text_dim = vecs.shape[1]
                if dim == 0:
                    dim = text_dim
                for (field, _), vec in zip(items, vecs):
                    field_vectors[field] = vec.tolist()

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

    model_name = config.get("model", VL_DEFAULT_MODEL)
    fields     = config.get("fields",    ["title", "abstract", "hashtags"])
    weights    = config.get("weights",   {})
    threshold  = float(config.get("threshold", 0.38))
    max_edges  = int(config.get("max_edges",   7))
    if not papers: return []
    model      = _get_model(model_name)

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
                "models":         models_annotated,
                "fields":         AVAILABLE_FIELDS,
                "vl_model":       VL_DEFAULT_MODEL,
                "loaded_vl_model": _vl_model_name,
            })
        elif method == "check_model":    handle_check_model(req_id, params.get("model", ""))
        elif method == "download_model": handle_download_model(req_id, params.get("model", ""))
        elif method == "compute_embedding":
            # Encode a single paper; returns { field_vectors, dim }.
            # Params: { paper: <PaperFull>, config: { model, fields } }
            result = compute_embedding(params.get("paper", {}), params.get("config", {}))
            ok(req_id, result)
        elif method == "compute":
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