#!/usr/bin/env python3
"""
similarity_server.py — PaperGraph HuggingFace similarity sidecar.

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
import traceback
from typing import Any

# ── Lazy-loaded model ─────────────────────────────────────────────────────────
_model      = None
_model_name = None
_model_lock = threading.Lock()


def _get_model(model_name: str):
    global _model, _model_name
    with _model_lock:
        if _model is not None and _model_name == model_name:
            return _model
        try:
            from sentence_transformers import SentenceTransformer
            _model      = SentenceTransformer(model_name)
            _model_name = model_name
            return _model
        except Exception as e:
            raise RuntimeError(f"Failed to load model '{model_name}': {e}")


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
    """Filesystem-only cache check — never touches the network."""
    path = _model_snapshot_path(model_id)
    if path:
        ok(req_id, {"cached": True, "path": path})
    else:
        ok(req_id, {"cached": False})


# ── download_model ────────────────────────────────────────────────────────────

def handle_download_model(req_id: Any, model_id: str) -> None:
    """
    Download model_id via snapshot_download, emitting per-file progress JSON
    lines on stdout before the final reply so Rust can forward them as
    'venv://model-progress' Tauri events.
    """

    def _emit_prog(filename: str, downloaded: int, total: int) -> None:
        pct = round(downloaded / total * 100, 1) if total > 0 else 0.0
        sys.stdout.write(json.dumps({
            "id": req_id,
            "ok": True,
            "progress": {
                "filename":   os.path.basename(filename) or filename,
                "downloaded": downloaded,
                "total":      total,
                "pct":        pct,
            },
        }) + "\n")
        sys.stdout.flush()

    try:
        from huggingface_hub import snapshot_download
        import huggingface_hub.file_download as _fd

        _cur_file: list[str] = [""]

        class _ProgressShim:
            """Minimal tqdm shim that writes progress JSON instead of a bar."""
            def __init__(self, iterable=None, *, total=None, desc=None, **_kw):
                self._iter  = iterable
                self._total = int(total or 0)
                self._n     = 0
                if desc:
                    _cur_file[0] = str(desc)

            def __iter__(self):
                for item in (self._iter or []):
                    yield item

            def __enter__(self): return self
            def __exit__(self, *_): self.close()

            def update(self, n: int = 1) -> None:
                self._n += n
                _emit_prog(_cur_file[0] or model_id, self._n, self._total)

            def set_postfix(self, **_): pass
            def set_description(self, s="", **_):
                if s: _cur_file[0] = str(s)
            def close(self): pass

        # Patch tqdm in the two locations huggingface_hub uses it.
        _fd.tqdm = _ProgressShim  # type: ignore[attr-defined]
        try:
            import huggingface_hub.utils as _hu
            _hu.tqdm = _ProgressShim  # type: ignore[attr-defined]
        except (ImportError, AttributeError):
            pass

        local_path = snapshot_download(repo_id=model_id, repo_type="model")
        ok(req_id, {"path": local_path, "done": True})

    except Exception:
        err(req_id, f"Model download failed:\n{traceback.format_exc()}")


# ── Paper → text ──────────────────────────────────────────────────────────────

def _attr(paper: dict, key: str, fallback: str = "") -> str:
    for a in paper.get("attributes", []):
        if a.get("key") == key:
            return a.get("value", fallback)
    return fallback


def paper_to_text(paper: dict, fields: list, weights: dict) -> str:
    parts = []
    for field in fields:
        w    = max(1, round(weights.get(field, 1.0)))
        text = ""
        if field == "title":       text = paper.get("title", "")
        elif field == "abstract":  text = _attr(paper, "abstract")
        elif field == "venue":     text = paper.get("venue", "")
        elif field == "hashtags":  text = " ".join(t.lstrip("#") for t in paper.get("hashtags", []))
        elif field == "notes":     text = paper.get("notes", "") or ""
        elif field == "year":      text = str(paper.get("year", ""))
        else:                      text = _attr(paper, field)
        if text.strip():
            parts.extend([text.strip()] * w)
    return " ".join(parts) if parts else paper.get("title", "")


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
    { "id": "sentence-transformers/all-MiniLM-L6-v2",
      "label": "MiniLM-L6-v2 (fast, 384-dim)",
      "description": "Lightweight and fast. Good for most cases.", "size_mb": 80 },
    { "id": "sentence-transformers/all-mpnet-base-v2",
      "label": "MPNet-base-v2 (accurate, 768-dim)",
      "description": "Higher accuracy, slower. Best for research quality.", "size_mb": 420 },
    { "id": "sentence-transformers/multi-qa-MiniLM-L6-cos-v1",
      "label": "Multi-QA MiniLM (semantic search)",
      "description": "Optimised for semantic similarity search.", "size_mb": 80 },
    { "id": "allenai/specter2_base",
      "label": "SPECTER2 (academic papers)",
      "description": "Trained on scientific paper citations. Best for academic similarity.", "size_mb": 440 },
]

AVAILABLE_FIELDS = [
    { "key": "title",    "label": "Title",    "default_weight": 1.5 },
    { "key": "abstract", "label": "Abstract", "default_weight": 2.0 },
    { "key": "venue",    "label": "Venue",    "default_weight": 0.5 },
    { "key": "hashtags", "label": "Hashtags", "default_weight": 1.0 },
    { "key": "notes",    "label": "Notes",    "default_weight": 0.5 },
    { "key": "year",     "label": "Year",     "default_weight": 0.2 },
]


# ── Compute ───────────────────────────────────────────────────────────────────

def compute_embedding(paper: dict, config: dict) -> list:
    # with open('../daconfigta.json', 'w') as f:
    #     json.dump(config, f)
    # with open('../paper.json', 'w') as f:
    #     json.dump(paper, f)

    """
    Encode a single paper into a float vector and return it.
    Used to pre-compute and cache per-paper embeddings on disk.
    """
    model_name = config.get("model", "sentence-transformers/all-MiniLM-L6-v2")
    fields     = config.get("fields",    ["title", "abstract", "hashtags"])
    weights    = config.get("weights",   {})
    model      = _get_model(model_name)
    text       = paper_to_text(paper, fields, weights)
    vec        = model.encode([text], convert_to_numpy=True, show_progress_bar=False)[0]
    return vec.tolist()


def compute(papers: list, config: dict) -> list:
    model_name = config.get("model", "sentence-transformers/all-MiniLM-L6-v2")
    fields     = config.get("fields",    ["title", "abstract", "hashtags"])
    weights    = config.get("weights",   {})
    threshold  = float(config.get("threshold", 0.38))
    max_edges  = int(config.get("max_edges",   7))
    if not papers: return []
    model      = _get_model(model_name)

    # Use pre-computed embedding vectors when available (passed from Rust cache).
    # papers[i]["_embedding"] is set by Rust if a cached embedding.json exists
    # with a matching model+fields config.  Saves re-encoding unchanged papers.
    vecs = []
    texts_to_encode = []   # (index, text) pairs that need fresh encoding
    for i, p in enumerate(papers):
        cached_vec = p.get("_embedding")
        if isinstance(cached_vec, list) and len(cached_vec) > 0:
            vecs.append(cached_vec)
        else:
            vecs.append(None)
            texts_to_encode.append((i, paper_to_text(p, fields, weights)))

    if texts_to_encode:
        fresh = model.encode(
            [t for _, t in texts_to_encode],
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        for idx, (i, _) in enumerate(texts_to_encode):
            vecs[i] = fresh[idx].tolist()

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
        if   method == "status":         ok(req_id, {"ready": True, "loaded_model": _model_name, "python": sys.version})
        elif method == "list_models":    ok(req_id, {"models": AVAILABLE_MODELS, "fields": AVAILABLE_FIELDS})
        elif method == "check_model":    handle_check_model(req_id, params.get("model", ""))
        elif method == "download_model": handle_download_model(req_id, params.get("model", ""))
        elif method == "compute_embedding":
            # Encode a single paper and return its float vector.
            # Params: { paper: <PaperFull>, config: { model, fields, weights } }
            vec = compute_embedding(params.get("paper", {}), params.get("config", {}))
            ok(req_id, {"vector": vec, "dim": len(vec)})
        elif method == "compute":
            edges = compute(params.get("papers", []), params.get("config", {}))
            ok(req_id, {"edges": edges, "count": len(edges)})
        else:
            err(req_id, f"Unknown method: '{method}'")
    except Exception:
        err(req_id, traceback.format_exc())


def main() -> None:
    sys.stdout.write(json.dumps({"id": 0, "ok": True, "result": "ready"}) + "\n")
    sys.stdout.flush()
    for raw in sys.stdin:
        line = raw.strip()
        if line: handle(line)


if __name__ == "__main__":
    main()