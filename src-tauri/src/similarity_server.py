#!/usr/bin/env python3
"""
similarity_server.py — LitAtlas llama.cpp similarity & LLM sidecar.

Protocol: newline-delimited JSON over stdin/stdout (Tauri sidecar stdio).

Requests:
  { "id": N, "method": "compute",           "params": { "papers": [...], "config": {...} } }
  { "id": N, "method": "compute_embedding", "params": { "paper": {...}, "config": {...} } }
  { "id": N, "method": "status" }
  { "id": N, "method": "list_models" }
  { "id": N, "method": "check_model",       "params": { "model": "<filename.gguf>" } }
  { "id": N, "method": "download_model",    "params": { "model": "<filename.gguf>", "repo_id": "<hf-repo>" } }
  { "id": N, "method": "validate_plugin",   "params": { "script_path": "..." } }

Responses:
  { "id": N, "ok": true,  "result": <any>   }
  { "id": N, "ok": false, "error":  "<str>" }

download_model also emits intermediate progress lines before the final reply:
  { "id": N, "ok": true, "progress": {
      "filename": str, "downloaded": int, "total": int, "pct": float } }

Models are GGUF files stored in LITATLAS_MODELS_DIR (set by Rust at launch).
  Embedding models: loaded with embedding=True (e.g. nomic-embed-text).
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
    from llama_cpp import Llama
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
except Exception as _import_err:
    sys.stdout.write(json.dumps({
        "id": 0, "ok": False,
        "error": f"Failed to load llama_cpp: {_import_err}"
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)


# ── User plugin ──────────────────────────────────────────────────────────────
#
# Users can extend LitAtlas with a custom similarity function by creating a
# Python file that defines the following entry point:
#
#   def similarity_fn(papers: list[dict], config: dict) -> list[dict]:
#       """
#       Returns list of { source_id, target_id, similarity, weight, edge_type }.
#       """
#
#   def compute_embedding_fn(paper: dict, config: dict) -> dict:
#       """
#       Returns { field_vectors: { field_name: [float, ...] }, dim: int }
#       """
#
# The path is passed via LitAtlas_PLUGIN_SCRIPT env var at startup.

def _log(fn_name: str, msg: str) -> None:
    """Write a structured status line to stderr (mirrored to litatlas.log by Rust)."""
    print(f"[LitAtlas][INFO] {fn_name}: {msg}", file=sys.stderr, flush=True)


_plugin_similarity_fn        = None
_plugin_compute_embedding_fn = None

def _load_plugin() -> None:
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
        print(f"[LitAtlas] ERROR loading plugin {script}:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)


# ── Models directory ──────────────────────────────────────────────────────────

def _models_dir() -> str:
    """Return the directory where GGUF model files are stored."""
    return os.environ.get(
        "LITATLAS_MODELS_DIR",
        os.path.join(os.path.expanduser("~"), ".litatlas", "models"),
    )


# ── Lazy-loaded llama.cpp models ──────────────────────────────────────────────

_embed_model      = None
_embed_model_path = None
_embed_model_lock = threading.Lock()

_gen_model      = None
_gen_model_path = None
_gen_model_lock = threading.Lock()

DEFAULT_EMBED_MODEL = "gemma-4-E2B-it-Q4_K_M.gguf"
DEFAULT_GEN_MODEL   = "gemma-4-E2B-it-Q4_K_M.gguf"
DEFAULT_MMPROJ      = "mmproj-F16.gguf"
DEFAULT_MODEL       = DEFAULT_EMBED_MODEL  # backward-compat alias

# Remap legacy or mistyped filenames that may be saved in similarity_config.json.
_FILENAME_ALIASES = {
    "Qwen3-VL-2B-Instruct-Q4_K_M.gguf":  "gemma-4-E2B-it-Q4_K_M.gguf",
    "Qwen3VL-2B-Instruct-Q4_K_M.gguf":   "gemma-4-E2B-it-Q4_K_M.gguf",
    "nomic-embed-text-v1.5.Q4_K_M.gguf":  "gemma-4-E2B-it-Q4_K_M.gguf",
}

# Companion files automatically downloaded alongside their parent model.
_MODEL_COMPANIONS = {
    DEFAULT_EMBED_MODEL: {
        "filename": DEFAULT_MMPROJ,
        "repo_id":  "unsloth/gemma-4-E2B-it-GGUF",
    },
}

def _get_embed_model(filename: str) -> "Llama":
    filename = _FILENAME_ALIASES.get(filename, filename)
    global _embed_model, _embed_model_path
    with _embed_model_lock:
        if _embed_model is not None and _embed_model_path == filename:
            return _embed_model
        path = os.path.join(_models_dir(), filename)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"Embedding model not found: {path}\n"
                "Download it first from the Similarity Settings panel."
            )
        print(f"[LitAtlas] Loading embed model: {path}", file=sys.stderr, flush=True)
        _embed_model      = Llama(model_path=path, embedding=True, pooling_type=3, n_ctx=0, verbose=False, n_gpu_layers=-1)
        _embed_model_path = filename
        return _embed_model


def _get_gen_model(filename: str) -> "Llama":
    filename = _FILENAME_ALIASES.get(filename, filename)
    global _gen_model, _gen_model_path
    with _gen_model_lock:
        if _gen_model is not None and _gen_model_path == filename:
            return _gen_model
        path = os.path.join(_models_dir(), filename)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"Generative model not found: {path}\n"
                "Download it first from the Similarity Settings panel."
            )
        print(f"[LitAtlas] Loading gen model: {path}", file=sys.stderr, flush=True)
        mmproj_path = os.path.join(_models_dir(), DEFAULT_MMPROJ)
        if os.path.isfile(mmproj_path):
            try:
                from llama_cpp.llama_chat_format import LlavaGemma3ChatHandler
                handler    = LlavaGemma3ChatHandler(clip_model_path=mmproj_path, verbose=False)
                _gen_model = Llama(model_path=path, chat_handler=handler, n_ctx=0, verbose=False, n_gpu_layers=-1)
                print(f"[LitAtlas] VL handler loaded (mmproj: {mmproj_path})", file=sys.stderr, flush=True)
            except Exception as _vl_err:
                print(f"[LitAtlas] VL handler failed ({_vl_err}), text-only fallback", file=sys.stderr, flush=True)
                _gen_model = Llama(model_path=path, n_ctx=0, verbose=False, chat_format="gemma", n_gpu_layers=-1)
        else:
            _gen_model = Llama(model_path=path, n_ctx=0, verbose=False, chat_format="gemma")
        _gen_model_path = filename
        return _gen_model


# ── PDF text extraction ───────────────────────────────────────────────────────

def _pdf_extract_text(pdf_path: str) -> str:
    try:
        import fitz
    except ImportError:
        print("[LitAtlas] WARNING: PyMuPDF not installed — pdf field skipped.", file=sys.stderr)
        return ""
    if not pdf_path or not os.path.isfile(pdf_path):
        return ""
    try:
        doc    = fitz.open(pdf_path)
        n_pages = len(doc)
        _log("_pdf_extract_text", f"extracting text from {n_pages} page(s) — {os.path.basename(pdf_path)}")
        texts  = [doc[i].get_text() for i in range(n_pages)]
        doc.close()
        return " ".join(texts).strip()
    except Exception as e:
        print(f"[LitAtlas] WARNING: pdf text extraction failed: {e}", file=sys.stderr)
        return ""


# ── PDF visual description (all pages) ───────────────────────────────────────

def _pdf_vl_describe_all_pages(pdf_path: str, paper: dict) -> str:
    """
    Render every page as a PNG and ask the VL model to describe its content
    (text layout, figures, charts, tables, equations).
    Returns all per-page descriptions concatenated.
    """
    if not pdf_path or not os.path.isfile(pdf_path):
        return ""
    try:
        import fitz
        import base64
    except ImportError:
        print("[LitAtlas] WARNING: PyMuPDF not installed — VL page pass skipped.", file=sys.stderr)
        return ""
    try:
        gen_model = _get_gen_model(DEFAULT_GEN_MODEL)
    except Exception as e:
        print(f"[LitAtlas] WARNING: VL model unavailable — skipping visual pass: {e}", file=sys.stderr)
        return ""
    try:
        doc      = fitz.open(pdf_path)
        n_pages  = len(doc)
        title    = paper.get("title", "")
        _log("_pdf_vl_describe_all_pages", f"processing {n_pages} page(s) for '{title}'")
        descriptions = []
        for i in range(n_pages):
            try:
                _log("_pdf_vl_describe_all_pages", f"page {i + 1}/{n_pages}")
                pix     = doc[i].get_pixmap(matrix=fitz.Matrix(1.5, 1.5))
                img_b64 = base64.b64encode(pix.tobytes("png")).decode("utf-8")
                resp    = gen_model.create_chat_completion(
                    messages=[{"role": "user", "content": [
                        {"type": "image_url",
                         "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                        {"type": "text", "text": (
                            f"Page {i + 1} of the research paper '{title}'. "
                            "Describe all content visible on this page — body text, "
                            "figures, charts, tables, and equations — in 2-3 sentences."
                        )},
                    ]}],
                    max_tokens=200,
                )
                desc = resp["choices"][0]["message"]["content"].strip()
                if desc:
                    descriptions.append(f"[Page {i + 1}] {desc}")
            except Exception as e:
                print(f"[LitAtlas] WARNING: VL page {i + 1} failed: {e}", file=sys.stderr)
        doc.close()
        _log("_pdf_vl_describe_all_pages", f"done — {len(descriptions)} page description(s) produced")
        return " ".join(descriptions)
    except Exception as e:
        print(f"[LitAtlas] WARNING: VL all-pages extraction failed: {e}", file=sys.stderr)
        return ""


def _pdf_to_rich_text(pdf_path: str, paper: dict) -> str:
    """
    Combine full-text extraction (all pages) with VL descriptions of each page.
    This captures body text, figures, charts, tables, and equations in one string.
    """
    text    = _pdf_extract_text(pdf_path)
    visual  = _pdf_vl_describe_all_pages(pdf_path, paper)
    parts   = [p for p in [text, visual] if p]
    return " ".join(parts)


# ── Structured MD generation from PDF content ─────────────────────────────────

_MD_SECTIONS = ["summary", "motivation", "contribution", "method", "experiment"]

def _parse_md_sections(md_text: str) -> dict:
    """Parse # Section headers into {section_name_lower: content_text} dict."""
    import re
    sections: dict = {}
    current:  str | None = None
    lines:    list = []
    for line in md_text.splitlines():
        m = re.match(r'^#+\s+(.+)', line)
        if m:
            if current is not None:
                sections[current] = " ".join(lines).strip()
            current = m.group(1).strip().lower()
            lines   = []
        elif current is not None:
            stripped = line.strip()
            if stripped:
                lines.append(stripped)
    if current is not None:
        sections[current] = " ".join(lines).strip()
    return sections


def _generate_md_from_paper(rich_text: str, paper: dict, pdf_dir: str) -> dict:
    """
    Ask the gen model to write structured section MD files from the paper content.
    Parses FILE: blocks from the LLM response, saves each as an individual .md file
    (lowercased filename) in pdf_dir, and also writes combined paper.md.
    Returns {filename: content} dict of all files written.
    """
    title   = paper.get("title", "")
    content = rich_text[:8000]  # guard against huge context windows
    _log("_generate_md_from_paper", f"generating structured MD for '{title}'")
    prompt = (
        f"You are analyzing the research paper: '{title}'.\n\n"
        f"Content:\n{content}\n\n"
        "Return plain text only using this exact repeated section format:\n\n"
        "FILE: Overview.md\n"
        "# Overview\n"
        "...\n\n"
        "FILE: MOTIVATION.md\n"
        "# Motivation\n"
        "...\n\n"
        "FILE: CONTRIBUTION.md\n"
        "# Contribution\n"
        "...\n\n"
        "FILE: METHOD.md\n"
        "# Method\n"
        "...\n\n"
        "FILE: EXPERIMENT.md\n"
        "# Experiment\n"
        "...\n\n"
        "Each section starts with `FILE: filename.md`; the lines after it are the "
        "content of that Markdown file until the next `FILE:` line. Each file "
        "filename should be the section name, not the original PDF name. The "
        "writer will place all files under a subfolder named after the PDF file. "
        "You decide how many Markdown files to create based on the PDF content. "
        "Create as many files as needed to preserve the PDF's important details, "
        "structure, and topic boundaries. Do not force a fixed number of files. "
        "Do not output reasoning, analysis, chain-of-thought, or tool calls. "
        "Output only the final FILE sections. "
        "Each file must contain specific information, not a duplicate summary. "
        "Split by semantic topic, chapter, concept, table group, action items, "
        "or other natural boundaries from the PDF. Preserve as much useful detail "
        "as possible while removing only obvious extraction noise and repetition. "
        "Preserve important headings, key ideas, decisions, definitions, action "
        "items, notable numbers, and tables when present. Represent tables in "
        "Markdown format when possible. Do not invent information. Use ASCII hyphens."
    )
    try:
        gen_model = _get_gen_model(DEFAULT_GEN_MODEL)
        resp      = gen_model.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=700,
        )
        md_text = resp["choices"][0]["message"]["content"].strip()

        # Parse FILE: blocks into {filename: content} dict (filenames lowercased)
        files: dict         = {}
        current_name: str | None = None
        current_lines: list = []
        for line in md_text.splitlines():
            if line.startswith("FILE:"):
                if current_name is not None:
                    files[current_name] = "\n".join(current_lines).strip()
                current_name  = line[5:].strip().lower()
                current_lines = []
            else:
                current_lines.append(line)
        if current_name is not None:
            files[current_name] = "\n".join(current_lines).strip()

        # Save individual section files
        os.makedirs(pdf_dir, exist_ok=True)
        for filename, file_content in files.items():
            try:
                with open(os.path.join(pdf_dir, filename), "w", encoding="utf-8") as f:
                    f.write(file_content)
            except Exception as e:
                print(f"[LitAtlas] WARNING: could not save {filename}: {e}", file=sys.stderr)

        # Write combined paper.md for backward compatibility
        combined = "\n\n".join(c for c in files.values() if c)
        try:
            with open(os.path.join(pdf_dir, "paper.md"), "w", encoding="utf-8") as f:
                f.write(combined)
        except Exception as e:
            print(f"[LitAtlas] WARNING: could not save paper.md: {e}", file=sys.stderr)

        _log("_generate_md_from_paper", f"saved {len(files)} section file(s) to {os.path.basename(pdf_dir)}")
        return files
    except Exception as e:
        print(f"[LitAtlas] WARNING: MD generation failed: {e}", file=sys.stderr)
        return {}


# ── GGUF model cache helpers ──────────────────────────────────────────────────

def _gguf_model_path(filename: str):
    """Return the full path if the GGUF file exists, else None."""
    path = os.path.join(_models_dir(), filename)
    return path if os.path.isfile(path) else None


# ── check_model ───────────────────────────────────────────────────────────────

def handle_check_model(req_id: Any, model_filename: str) -> None:
    path = _gguf_model_path(model_filename)
    if path:
        ok(req_id, {"cached": True, "path": path, "offline_ready": True})
    else:
        ok(req_id, {"cached": False, "offline_ready": False})


# ── download_model ────────────────────────────────────────────────────────────

_DOWNLOAD_MAX_RETRIES = 3
_DOWNLOAD_RETRY_DELAY = 5

def handle_download_model(req_id: Any, model_filename: str, repo_id: str) -> None:
    """
    Download a GGUF file from HuggingFace into LITATLAS_MODELS_DIR.
    Uses huggingface_hub.hf_hub_download with retry logic for transient errors.
    Auth errors are reported immediately (no retry).
    """
    from huggingface_hub import hf_hub_download

    models_dir = _models_dir()
    os.makedirs(models_dir, exist_ok=True)

    # Download companion files (e.g. mmproj) before the main model so the
    # completion event signals a fully usable model.
    companion = _MODEL_COMPANIONS.get(model_filename)
    if companion:
        comp_path = os.path.join(models_dir, companion["filename"])
        if not os.path.isfile(comp_path):
            print(
                f"[LitAtlas] download_model: fetching companion '{companion['filename']}'",
                file=sys.stderr, flush=True,
            )
            try:
                hf_hub_download(
                    repo_id=companion["repo_id"],
                    filename=companion["filename"],
                    local_dir=models_dir,
                )
            except Exception as comp_err:
                print(
                    f"[LitAtlas] WARNING: companion download failed: {comp_err}",
                    file=sys.stderr, flush=True,
                )

    t0       = time.monotonic()
    last_err = None

    for attempt in range(1, _DOWNLOAD_MAX_RETRIES + 1):
        try:
            print(
                f"[LitAtlas] download_model: attempt {attempt}/{_DOWNLOAD_MAX_RETRIES} "
                f"'{model_filename}' from '{repo_id}'",
                file=sys.stderr, flush=True,
            )
            path = hf_hub_download(
                repo_id=repo_id,
                filename=model_filename,
                local_dir=models_dir,
            )
            elapsed = time.monotonic() - t0
            print(
                f"[LitAtlas] download_model: '{model_filename}' completed in {elapsed:.1f}s",
                file=sys.stderr, flush=True,
            )
            ok(req_id, {"done": True, "path": path})
            return
        except Exception as exc:
            last_err = exc
            msg = str(exc)
            print(f"[LitAtlas] download_model error (attempt {attempt}): {msg}",
                  file=sys.stderr, flush=True)
            if any(kw in msg.lower() for kw in
                   ("401", "403", "gated", "authentication", "unauthorized", "restricted")):
                err(req_id, f"Download failed: {msg}")
                return
            if attempt < _DOWNLOAD_MAX_RETRIES:
                print(f"[LitAtlas] retrying in {_DOWNLOAD_RETRY_DELAY}s…",
                      file=sys.stderr, flush=True)
                time.sleep(_DOWNLOAD_RETRY_DELAY)

    err(req_id, f"Download failed after {_DOWNLOAD_MAX_RETRIES} attempts: {last_err}")


# ── Paper → field text ────────────────────────────────────────────────────────

def _attr(paper: dict, key: str, fallback: str = "") -> str:
    for a in paper.get("attributes", []):
        if a.get("key") == key:
            return a.get("value", fallback)
    return fallback


def _field_text(paper: dict, field: str) -> str:
    if field == "title":    return paper.get("title", "")
    if field == "abstract": return _attr(paper, "abstract")
    if field == "venue":    return paper.get("venue", "")
    if field == "hashtags": return " ".join(t.lstrip("#") for t in paper.get("hashtags", []))
    if field == "notes":    return paper.get("notes", "") or ""
    if field == "year":     return str(paper.get("year", ""))
    if field == "pdf":      return _pdf_extract_text(paper.get("pdf_path") or "")
    if field.startswith("md_"):
        pdf_path = paper.get("pdf_path") or ""
        if not pdf_path:
            return ""
        pdf_dir = os.path.dirname(pdf_path)
        section = field[3:]  # e.g. "summary" from "md_summary"
        # Try individual section file (lowercased, then capitalized, then uppercased)
        for fname in (f"{section}.md", f"{section.capitalize()}.md", f"{section.upper()}.md"):
            fpath = os.path.join(pdf_dir, fname)
            if os.path.isfile(fpath):
                try:
                    return open(fpath, encoding="utf-8").read().strip()
                except Exception:
                    pass
        # Fall back to parsing combined paper.md
        md_path = os.path.join(pdf_dir, "paper.md")
        if not os.path.isfile(md_path):
            return ""
        try:
            sections = _parse_md_sections(open(md_path, encoding="utf-8").read())
            return sections.get(section, "")
        except Exception:
            return ""
    return _attr(paper, field)


# ── Embedding computation ─────────────────────────────────────────────────────

def _embed_text(embed_model: "Llama", text: str) -> list:
    """Embed a single text string; always return a flat float list."""
    vec = embed_model.embed(text or " ")
    # Per-token fallback (pooling_type not honoured) — take the last token.
    if vec and isinstance(vec[0], list):
        vec = vec[-1]
    return [float(v) for v in vec]


def paper_embedding(paper: dict, fields: list, weights: dict, embed_model: "Llama") -> list:
    """
    Weighted composite embedding for a paper, L2-normalised.
    Each field is embedded independently; vectors are weighted-summed.
    """
    items = []
    for field in fields:
        text = _field_text(paper, field).strip()
        if text:
            w = float(weights.get(field, 1.0))
            if w > 0:
                items.append((field, text, w))

    if not items:
        items = [("title", paper.get("title", "").strip() or "unknown", 1.0)]

    composite = None
    dim       = 0
    for _, text, w in items:
        vec = _embed_text(embed_model, text)
        if dim == 0:
            dim       = len(vec)
            composite = [0.0] * dim
        for k, v in enumerate(vec):
            if not (math.isnan(v) or math.isinf(v)):
                composite[k] += w * v

    if composite is None:
        return []

    norm = math.sqrt(sum(x * x for x in composite))
    if norm > 0:
        composite = [x / norm for x in composite]
    return composite


def compute_embedding(paper: dict, config: dict) -> dict:
    """
    Compute per-field embedding vectors for a single paper.
    Returns { field_vectors: { field: [float, ...] }, dim: int }.
    """
    if _plugin_compute_embedding_fn is not None:
        try:
            return _plugin_compute_embedding_fn(paper, config)
        except Exception:
            print("[LitAtlas] plugin compute_embedding_fn raised — falling back:",
                  file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    model_filename = config.get("model", DEFAULT_EMBED_MODEL)
    fields         = config.get("fields", ["title", "abstract", "hashtags"])
    _log("compute_embedding", f"paper='{paper.get('title', '')}' fields={fields} model={model_filename}")
    embed_model    = _get_embed_model(model_filename)

    pdf_path = paper.get("pdf_path") or ""

    # Resolve paper.md path (alongside the PDF).
    md_path   = os.path.join(os.path.dirname(pdf_path), "paper.md") if pdf_path else ""
    md_text   = ""
    md_loaded = False
    if md_path and os.path.isfile(md_path):
        try:
            md_text   = open(md_path, encoding="utf-8").read()
            md_loaded = True
            _log("compute_embedding", f"loaded paper.md ({len(md_text)} chars)")
        except Exception:
            pass

    # Rich text (raw PDF text + VL) is the fallback for pdf field when no MD exists.
    # Only run the expensive VL pass when actually needed.
    needs_raw_fallback = "pdf" in fields and not md_loaded
    rich_text = ""
    if needs_raw_fallback and pdf_path and os.path.isfile(pdf_path):
        try:
            import fitz as _fitz
            _doc = _fitz.open(pdf_path)
            _log("compute_embedding", f"pdf field fallback: {len(_doc)} page(s) → LLM")
            _doc.close()
        except Exception:
            pass
        rich_text = _pdf_to_rich_text(pdf_path, paper)

    field_vectors: dict = {}
    dim = 0
    for field in fields:
        if field == "pdf":
            # Prefer structured MD (already visually-informed) over raw extraction.
            text = md_text if md_loaded else rich_text
        elif field.startswith("md_"):
            text = _field_text(paper, field)
        else:
            text = _field_text(paper, field).strip()
        vec                  = _embed_text(embed_model, text or " ")
        field_vectors[field] = vec
        dim                  = len(vec)

    return {"field_vectors": field_vectors, "dim": dim}


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
    {
        "id":          "gemma-4-E2B-it-Q4_K_M.gguf",
        "repo_id":     "unsloth/gemma-4-E2B-it-GGUF",
        "label":       "Gemma 4 E2B Instruct (Q4_K_M)",
        "description": (
            "Multimodal model: text embeddings + visual understanding of PDF pages. "
            "Auto-downloads mmproj companion for vision support."
        ),
        "size_mb":     1200,
        "gated":       False,
        "type":        "multimodal",
    },
    {
        "id":          "nomic-embed-text-v1.5.Q4_K_M.gguf",
        "repo_id":     "nomic-ai/nomic-embed-text-v1.5-GGUF",
        "label":       "Nomic Embed Text v1.5 (Q4_K_M)",
        "description": "Fast, high-quality text-only embeddings (~274 MB).",
        "size_mb":     274,
        "gated":       False,
        "type":        "embedding",
    },
]

AVAILABLE_FIELDS = [
    { "key": "title",           "label": "Title",            "default_weight": 1.5 },
    { "key": "abstract",        "label": "Abstract",         "default_weight": 2.0 },
    { "key": "venue",           "label": "Venue",            "default_weight": 0.5 },
    { "key": "hashtags",        "label": "Hashtags",         "default_weight": 1.0 },
    { "key": "notes",           "label": "Notes",            "default_weight": 0.5 },
    { "key": "year",            "label": "Year",             "default_weight": 0.2 },
    { "key": "pdf",             "label": "PDF (text+vision)","default_weight": 2.0 },
    { "key": "md_summary",      "label": "MD Summary",       "default_weight": 1.5 },
    { "key": "md_motivation",   "label": "MD Motivation",    "default_weight": 1.0 },
    { "key": "md_contribution", "label": "MD Contribution",  "default_weight": 1.5 },
    { "key": "md_method",       "label": "MD Method",        "default_weight": 1.0 },
    { "key": "md_experiment",   "label": "MD Experiment",    "default_weight": 0.8 },
]


# ── Compute (batch similarity) ────────────────────────────────────────────────

def compute(papers: list, config: dict) -> list:
    if _plugin_similarity_fn is not None:
        try:
            return _plugin_similarity_fn(papers, config)
        except Exception:
            print("[LitAtlas] plugin similarity_fn raised — falling back:",
                  file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    model_filename = config.get("model", DEFAULT_EMBED_MODEL)
    fields         = config.get("fields",    ["title", "abstract", "hashtags"])
    weights        = config.get("weights",   {})
    threshold      = float(config.get("threshold", 0.38))
    max_edges      = int(config.get("max_edges",   7))
    _log("compute", f"papers={len(papers)} model={model_filename} fields={fields} threshold={threshold}")
    if not papers:
        return []

    embed_model = _get_embed_model(model_filename)

    # Use pre-recomposed vectors injected by Rust (inject_cached_embeddings),
    # encode fresh only for papers without a cached _embedding.
    vecs             = []
    papers_to_encode = []
    for i, p in enumerate(papers):
        cached_vec = p.get("_embedding")
        if isinstance(cached_vec, list) and len(cached_vec) > 0:
            vecs.append(cached_vec)
        else:
            vecs.append(None)
            papers_to_encode.append((i, p))

    for i, p in papers_to_encode:
        vecs[i] = paper_embedding(p, fields, weights, embed_model)

    n          = len(papers)
    candidates = []
    for i in range(n):
        for j in range(i + 1, n):
            if not vecs[i] or not vecs[j]:
                continue
            sim = cosine(vecs[i], vecs[j])
            if sim >= threshold:
                candidates.append({
                    "source_id": papers[i]["id"], "target_id": papers[j]["id"],
                    "similarity": round(sim, 6), "weight": edge_weight(sim),
                    "edge_type":  edge_type(papers[i], papers[j]),
                    "_i": i, "_j": j,
                })
    candidates.sort(key=lambda e: e["similarity"], reverse=True)
    edge_count = [0] * n
    result     = []
    for e in candidates:
        i, j = e["_i"], e["_j"]
        if edge_count[i] < max_edges and edge_count[j] < max_edges:
            edge_count[i] += 1; edge_count[j] += 1
            result.append({k: e[k] for k in
                           ("source_id", "target_id", "similarity", "weight", "edge_type")})
    return result


# ── Plugin validation ─────────────────────────────────────────────────────────

def _handle_validate_plugin(req_id: Any, script_path: str) -> None:
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
        ok(req_id, {
            "valid":             True,
            "has_similarity_fn": hasattr(module, "similarity_fn"),
            "has_embedding_fn":  hasattr(module, "compute_embedding_fn"),
        })
    except Exception:
        ok(req_id, {"valid": False, "error": traceback.format_exc()})


# ── generate_paper_md handler ─────────────────────────────────────────────────

def handle_generate_paper_md(req_id: Any, paper: dict, config: dict) -> None:
    """
    Generate structured section MD files from the PDF using full-text extraction +
    VL page descriptions.  Each FILE: block from the LLM is saved as its own .md
    file in the paper's PDF directory; combined paper.md is also written.
    """
    pdf_path = paper.get("pdf_path") or ""
    if not pdf_path or not os.path.isfile(pdf_path):
        err(req_id, "No PDF file available for this paper")
        return
    pdf_dir   = os.path.dirname(pdf_path)
    _log("generate_paper_md", f"paper='{paper.get('title', '')}' → {pdf_dir}")
    rich_text = _pdf_to_rich_text(pdf_path, paper)
    files     = _generate_md_from_paper(rich_text, paper, pdf_dir)
    if not files:
        err(req_id, "MD generation failed — check model availability")
        return
    ok(req_id, {"pdf_dir": pdf_dir, "files": files})


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
    _log("handle", f"id={req_id} method={method}")

    try:
        if method == "status":
            cached = [m["id"] for m in AVAILABLE_MODELS if _gguf_model_path(m["id"])]
            ok(req_id, {
                "ready":              True,
                "loaded_embed_model": _embed_model_path,
                "loaded_gen_model":   _gen_model_path,
                "python":             sys.version,
                "offline_models":     cached,
            })

        elif method == "list_models":
            annotated = [{**m, "cached": _gguf_model_path(m["id"]) is not None}
                         for m in AVAILABLE_MODELS]
            ok(req_id, {
                "models":           annotated,
                "fields":           AVAILABLE_FIELDS,
                "default_model":    DEFAULT_EMBED_MODEL,
                "default_gen_model": DEFAULT_GEN_MODEL,
            })

        elif method == "check_model":
            handle_check_model(req_id, params.get("model", ""))

        elif method == "download_model":
            handle_download_model(
                req_id,
                params.get("model", ""),
                params.get("repo_id", ""),
            )

        elif method == "generate_paper_md":
            handle_generate_paper_md(req_id, params.get("paper", {}), params.get("config", {}))

        elif method == "compute_embedding":
            result = compute_embedding(params.get("paper", {}), params.get("config", {}))
            ok(req_id, result)

        elif method == "compute":
            edges = compute(params.get("papers", []), params.get("config", {}))
            ok(req_id, {"edges": edges, "count": len(edges)})

        elif method == "validate_plugin":
            _handle_validate_plugin(req_id, params.get("script_path", ""))

        else:
            err(req_id, f"Unknown method: '{method}'")

    except Exception:
        err(req_id, traceback.format_exc())


def main() -> None:
    _load_plugin()
    sys.stdout.write(json.dumps({"id": 0, "ok": True, "result": "ready"}) + "\n")
    sys.stdout.flush()
    for raw in sys.stdin:
        line = raw.strip()
        if line:
            handle(line)


if __name__ == "__main__":
    main()
