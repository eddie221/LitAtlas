#!/usr/bin/env python3
"""
similarity_server.py — PaperGraph HuggingFace similarity sidecar.

Protocol: newline-delimited JSON over stdin/stdout (Tauri sidecar stdio).

Request:
  { "id": <int>, "method": "compute", "params": { "papers": [...], "config": {...} } }
  { "id": <int>, "method": "status" }
  { "id": <int>, "method": "list_models" }

Response (success):
  { "id": <int>, "ok": true,  "result": <any> }

Response (error):
  { "id": <int>, "ok": false, "error": "<string>" }

Config schema:
  {
    "model":      "sentence-transformers/all-MiniLM-L6-v2",  // HF model id
    "fields":     ["title", "abstract", "venue", "hashtags", "notes", "year"],
    "weights":    { "title": 1.0, "abstract": 2.0, ... },
    "threshold":  0.38,
    "max_edges":  7
  }

Each paper in params.papers follows PaperFull shape:
  { "id": int, "title": str, "venue": str, "year": int,
    "notes": str|null, "hashtags": [str], "attributes": [{key,value,order}] }
"""

import sys
import json
import os
import math
import threading
import traceback
from typing import Any

# ── Lazy-loaded heavy imports ─────────────────────────────────────────────────
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


# ── Paper → text ──────────────────────────────────────────────────────────────

def _attr(paper: dict, key: str, fallback: str = "") -> str:
    for a in paper.get("attributes", []):
        if a.get("key") == key:
            return a.get("value", fallback)
    return fallback


def paper_to_text(paper: dict, fields: list[str], weights: dict[str, float]) -> str:
    """
    Build a weighted text string from a paper's fields.
    Each field is repeated proportionally to its weight (rounded to nearest int,
    minimum 1 repetition).  This lets a single text embedding reflect user priorities.
    """
    parts = []
    for field in fields:
        w = max(1, round(weights.get(field, 1.0)))
        text = ""
        if field == "title":
            text = paper.get("title", "")
        elif field == "abstract":
            text = _attr(paper, "abstract")
        elif field == "venue":
            text = paper.get("venue", "")
        elif field == "hashtags":
            text = " ".join(t.lstrip("#") for t in paper.get("hashtags", []))
        elif field == "notes":
            text = paper.get("notes", "") or ""
        elif field == "year":
            text = str(paper.get("year", ""))
        else:
            # Treat as a custom attribute key
            text = _attr(paper, field)

        if text.strip():
            parts.extend([text.strip()] * w)

    return " ".join(parts) if parts else paper.get("title", "")


# ── Cosine similarity ─────────────────────────────────────────────────────────

def cosine(a: list[float], b: list[float]) -> float:
    dot  = sum(x * y for x, y in zip(a, b))
    na   = math.sqrt(sum(x * x for x in a))
    nb   = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def edge_weight(sim: float) -> int:
    if sim >= 0.75: return 3
    if sim >= 0.55: return 2
    return 1


def edge_type(a: dict, b: dict) -> str:
    at = set(t.lstrip("#") for t in a.get("hashtags", []))
    bt = set(t.lstrip("#") for t in b.get("hashtags", []))
    if at & bt:
        return "same_tag"
    if a.get("venue") and a.get("venue") == b.get("venue"):
        return "same_venue"
    return "related"


# ── Core compute ──────────────────────────────────────────────────────────────

AVAILABLE_MODELS = [
    {
        "id":          "sentence-transformers/all-MiniLM-L6-v2",
        "label":       "MiniLM-L6-v2 (fast, 384-dim)",
        "description": "Lightweight and fast. Good for most cases.",
        "size_mb":     80,
    },
    {
        "id":          "sentence-transformers/all-mpnet-base-v2",
        "label":       "MPNet-base-v2 (accurate, 768-dim)",
        "description": "Higher accuracy, slower. Best for research quality.",
        "size_mb":     420,
    },
    {
        "id":          "sentence-transformers/multi-qa-MiniLM-L6-cos-v1",
        "label":       "Multi-QA MiniLM (semantic search)",
        "description": "Optimised for semantic similarity search.",
        "size_mb":     80,
    },
    {
        "id":          "allenai/specter2_base",
        "label":       "SPECTER2 (academic papers)",
        "description": "Trained on scientific paper citations. Best for academic similarity.",
        "size_mb":     440,
    },
]

AVAILABLE_FIELDS = [
    { "key": "title",    "label": "Title",    "default_weight": 1.5 },
    { "key": "abstract", "label": "Abstract", "default_weight": 2.0 },
    { "key": "venue",    "label": "Venue",    "default_weight": 0.5 },
    { "key": "hashtags", "label": "Hashtags", "default_weight": 1.0 },
    { "key": "notes",    "label": "Notes",    "default_weight": 0.5 },
    { "key": "year",     "label": "Year",     "default_weight": 0.2 },
]


def compute(papers: list[dict], config: dict) -> list[dict]:
    model_name = config.get("model", "sentence-transformers/all-MiniLM-L6-v2")
    fields     = config.get("fields",    ["title", "abstract", "hashtags"])
    weights    = config.get("weights",   {})
    threshold  = float(config.get("threshold", 0.38))
    max_edges  = int(config.get("max_edges",   7))

    if not papers:
        return []

    model = _get_model(model_name)

    # Build one text per paper
    texts = [paper_to_text(p, fields, weights) for p in papers]

    # Batch encode — returns numpy array
    embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)

    # Convert to plain Python lists for serialisation-free cosine calc
    vecs = [emb.tolist() for emb in embeddings]

    # Compute all pairwise similarities
    n = len(papers)
    candidates = []
    for i in range(n):
        for j in range(i + 1, n):
            sim = cosine(vecs[i], vecs[j])
            if sim >= threshold:
                candidates.append({
                    "source_id":  papers[i]["id"],
                    "target_id":  papers[j]["id"],
                    "similarity": round(sim, 6),
                    "weight":     edge_weight(sim),
                    "edge_type":  edge_type(papers[i], papers[j]),
                    "_i": i, "_j": j,
                })

    # Sort descending, apply per-node max_edges cap
    candidates.sort(key=lambda e: e["similarity"], reverse=True)
    edge_count = [0] * n
    result = []
    for e in candidates:
        i, j = e["_i"], e["_j"]
        if edge_count[i] < max_edges and edge_count[j] < max_edges:
            edge_count[i] += 1
            edge_count[j] += 1
            result.append({
                "source_id":  e["source_id"],
                "target_id":  e["target_id"],
                "similarity": e["similarity"],
                "weight":     e["weight"],
                "edge_type":  e["edge_type"],
            })

    return result


# ── JSON-RPC loop ─────────────────────────────────────────────────────────────

def reply(req_id: Any, ok: bool, payload_key: str, payload: Any) -> None:
    msg = {"id": req_id, "ok": ok, payload_key: payload}
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def ok(req_id: Any, result: Any) -> None:
    reply(req_id, True,  "result", result)


def err(req_id: Any, message: str) -> None:
    reply(req_id, False, "error",  message)


def handle(line: str) -> None:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        err(None, f"JSON parse error: {e}")
        return

    req_id = req.get("id")
    method = req.get("method", "")

    try:
        if method == "status":
            ok(req_id, {
                "ready":       True,
                "loaded_model": _model_name,
                "python":      sys.version,
            })

        elif method == "list_models":
            ok(req_id, {
                "models": AVAILABLE_MODELS,
                "fields": AVAILABLE_FIELDS,
            })

        elif method == "compute":
            params  = req.get("params", {})
            papers  = params.get("papers", [])
            config  = params.get("config", {})
            edges   = compute(papers, config)
            ok(req_id, {"edges": edges, "count": len(edges)})

        else:
            err(req_id, f"Unknown method: '{method}'")

    except Exception as e:
        err(req_id, traceback.format_exc())


def main() -> None:
    # Signal readiness to Rust
    sys.stdout.write(json.dumps({"id": 0, "ok": True, "result": "ready"}) + "\n")
    sys.stdout.flush()

    for raw in sys.stdin:
        line = raw.strip()
        if line:
            handle(line)


if __name__ == "__main__":
    main()