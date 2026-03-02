/**
 * similarity.js  —  PaperGraph similarity engine (strategy pattern)
 *
 * Two strategies, swappable at runtime:
 *
 *   "js-cosine"     — Lightweight in-JS cosine engine.
 *                     Uses hashtags (tag-space vector) + custom attribution
 *                     attributes (author/institution overlap). No abstract.
 *
 *   "hf-embeddings" — HuggingFace sentence-transformers via Python sidecar.
 *                     User picks model + fields + weights.
 *
 * Public API:
 *   computeEdges(papers, config?)              → Promise<EdgeInput[]>
 *   computeEdgesForNewPaper(p, existing, cfg?) → Promise<EdgeInput[]>
 *   getDefaultConfig()                         → SimilarityConfig
 *   SIMILARITY_THRESHOLD, MAX_EDGES_PER_NODE
 */

// ── Weights ───────────────────────────────────────────────────────────────────
// JS-cosine strategy blends two sub-vectors:
//   TAG_WEIGHT        — one-hot hashtag presence (primary signal)
//   ATTRIBUTION_WEIGHT — Jaccard-style author/institution overlap (secondary signal)
const W_TAGS        = 0.70;

// ── Tag vocabulary (loaded from SQL hashtags table at runtime) ───────────────
// graph.js calls setTagVocab() after loading papers so the vector space always
// reflects the actual tags in the current project's database.
// The fallback list is used only if setTagVocab() has not been called yet.
let TAG_VOCAB = [
  "classification", "object-detection", "segmentation", "generative",
  "3d-vision", "self-supervised", "video", "depth-estimation", "optical-flow",
  "cnn", "transformer", "diffusion", "gan", "vae", "mlp", "nerf",
  "contrastive", "masked-autoencoder", "imagenet", "real-time",
];

/**
 * Replace the tag vocabulary with tags from the database.
 * Call this whenever the project changes or new tags are added.
 * Accepts HashtagRow[] ({ id, name }) or plain string[].
 */
export function setTagVocab(tags) {
  TAG_VOCAB = tags.map(t => (typeof t === "string" ? t : t.name).replace(/^#/, "").toLowerCase());
}

export function setAttrVocab(tags) {
  TAG_VOCAB = tags.map(t => (typeof t === "string" ? t : t.name).replace(/^#/, "").toLowerCase());
}

export function getTagVocab() { return [...TAG_VOCAB]; }

// Vector dim = TAG_VOCAB slots + 1 attribution scalar
export function getVectorDim() { return TAG_VOCAB.length + 1; }

// ── Thresholds ────────────────────────────────────────────────────────────────
export const SIMILARITY_THRESHOLD = 0.38;
export const MAX_EDGES_PER_NODE   = 7;

export function getDefaultConfig() {
  return {
    strategy:  "js-cosine",
    model:     "sentence-transformers/all-MiniLM-L6-v2",
    fields:    ["hashtags", "attribution"],
    weights:   { hashtags: 1.0},
    threshold: SIMILARITY_THRESHOLD,
    max_edges: MAX_EDGES_PER_NODE,
  };
}


// ── Attribution helpers ───────────────────────────────────────────────────────

/**
 * Extract a normalised set of attribution tokens from a paper.
 *
 * "attribution" is sourced from the paper's custom attributes whose key is
 * "attribution", "author", "authors", or "institution" (case-insensitive).
 * Values are split on commas/semicolons and lowercased so that
 * "He, K." and "he, k." are treated as the same token.
 *
 * Returns a Set<string>.
 */
// function _attributionTokens(paper) {
//   const tokens = new Set();
//   const ATTR_KEYS = new Set(["attribution", "author", "authors", "institution"]);
//   console.log("paper attr : ", paper.attributes)
//   for (const a of (paper.attributes ?? [])) {
//     console.log(a);
//     if (!ATTR_KEYS.has((a.key ?? "").toLowerCase())) continue;
//     const val = (a.value ?? "").trim();
//     if (!val) continue;
//     for (const part of val.split(/[,;]+/)) {
//       const t = part.trim().toLowerCase();
//       if (t) tokens.add(t);
//     }
//   }

//   // Also accept top-level `authors` field (array of strings or plain string)
//   const topAuthors = paper.authors ?? paper.author;
//   if (Array.isArray(topAuthors)) {
//     for (const a of topAuthors) {
//       const t = String(a).trim().toLowerCase();
//       if (t) tokens.add(t);
//     }
//   } else if (typeof topAuthors === "string" && topAuthors.trim()) {
//     for (const part of topAuthors.split(/[,;]+/)) {
//       const t = part.trim().toLowerCase();
//       if (t) tokens.add(t);
//     }
//   }

//   return tokens;
// }

/**
 * Jaccard similarity between two attribution token sets → [0, 1].
 * Returns 0 when both sets are empty (no signal) rather than 1.
 */
// function _jaccardAttribution(setA, setB) {
//   if (setA.size === 0 && setB.size === 0) return 0;
//   let inter = 0;
//   for (const t of setA) if (setB.has(t)) inter++;
//   const union = setA.size + setB.size - inter;
//   return union === 0 ? 0 : inter / union;
// }


// ── Encoding ──────────────────────────────────────────────────────────────────

/**
 * Encode a paper into a fixed-length Float64 vector suitable for cosine
 * similarity.
 *
 * Vector layout:
 *   [0 … TAG_VOCAB.length-1]  — Weighted hashtag one-hot  (weight √W_TAGS)
 *   [TAG_VOCAB.length]         — Attribution Jaccard scalar (weight √W_ATTRIBUTION)
 *                                NOTE: attribution is a *pairwise* measure so we
 *                                store the raw token set separately and inject the
 *                                scalar when building candidate pairs (see _jsEdges).
 *
 * For the cosine path we approximate by encoding each paper independently.
 * The attribution component is set to √W_ATTRIBUTION so that when two papers
 * share all authors the dot product contribution equals W_ATTRIBUTION and when
 * they share none it equals 0.  Actual Jaccard is computed pairwise below.
 */
export function encode(paper) {
  const dim = getVectorDim();
  const vec = new Float64Array(dim);

  // ── Hashtag sub-vector ──
  const ts = new Set((paper.hashtags ?? []).map(t => t.replace(/^#/, "").toLowerCase()));
  for (let i = 0; i < TAG_VOCAB.length; i++) {
    if (ts.has(TAG_VOCAB[i])) vec[i] = 1.0;
  }

  // ── Attribution sub-scalar (placeholder — refined pairwise in _jsEdges) ──
  // We use a binary "has attribution?" signal here so the encoding is
  // paper-independent.  The real Jaccard overlap is injected pairwise.
  // const attrTokens = _attributionTokens(paper);
  // vec[TAG_VOCAB.length] = attrTokens.size > 0 ? Math.sqrt(W_ATTRIBUTION) : 0;

  return { vec: Array.from(vec) };
}


// ── Cosine similarity ─────────────────────────────────────────────────────────
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Refined similarity that blends tag-cosine with pairwise attribution Jaccard.
 *
 * sim = W_TAGS * tagCosine(a, b) + W_ATTRIBUTION * jaccardAttribution(a, b)
 *
 * When a paper has no attribution data the attribution term contributes 0,
 * so tag similarity alone determines the score.
 */
function _blendedSim(encA, encB) {
  // Tag cosine: operate only on the TAG_VOCAB slice
  const tagSliceA = encA.vec.slice(0, TAG_VOCAB.length);
  const tagSliceB = encB.vec.slice(0, TAG_VOCAB.length);
  const tagSim    = cosine(tagSliceA, tagSliceB);

  // Attribution Jaccard
  // const attrSim = _jaccardAttribution(encA.attrTokens, encB.attrTokens);

  return tagSim //+ W_ATTRIBUTION * attrSim;
}


// ── Edge metadata ─────────────────────────────────────────────────────────────

export function edgeType(a, b) {
  const at = new Set((a.hashtags ?? []).map(t => t.replace(/^#/, "")));
  const bt = new Set((b.hashtags ?? []).map(t => t.replace(/^#/, "")));
  for (const t of at) if (bt.has(t)) return "same_tag";
  if ((a.venue ?? "") === (b.venue ?? "") && a.venue) return "same_venue";
  return "related";
}

export function edgeWeight(sim) { return sim >= 0.75 ? 3 : sim >= 0.55 ? 2 : 1; }


// ── JS-cosine engine ──────────────────────────────────────────────────────────

function _jsEdges(papers, thr, max) {
  const encs  = papers.map(encode);
  const cands = [];

  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const sim = _blendedSim(encs[i], encs[j]);
      // console.log(i, j, sim, thr);
      if (sim >= thr) {
        cands.push({
          source_id: papers[i].id,
          target_id: papers[j].id,
          similarity: sim,
          weight:     edgeWeight(sim),
          edge_type:  edgeType(papers[i], papers[j]),
          _i: i, _j: j,
        });
      }
    }
  }

  cands.sort((a, b) => b.similarity - a.similarity);
  // console.log("cands : ", cands);
  const cnt = new Array(papers.length).fill(0);
  const res = [];
  for (const e of cands) {
    if (cnt[e._i] < max && cnt[e._j] < max) {
      cnt[e._i]++;
      cnt[e._j]++;
      res.push({
        source_id:  e.source_id,
        target_id:  e.target_id,
        similarity: parseFloat(e.similarity.toFixed(6)),
        weight:     e.weight,
        edge_type:  e.edge_type,
      });
    }
  }
  // console.log("res : ", res);
  return res;
}

function _jsEdgesForNew(np, existing, thr, max) {
  const nEnc = encode(np);
  const edges = [];

  for (const o of existing) {
    if (o.id === np.id) continue;
    const sim = _blendedSim(nEnc, encode(o));
    if (sim >= thr) {
      edges.push({
        source_id:  np.id,
        target_id:  o.id,
        similarity: parseFloat(sim.toFixed(6)),
        weight:     edgeWeight(sim),
        edge_type:  edgeType(np, o),
      });
    }
  }

  edges.sort((a, b) => b.similarity - a.similarity);
  return edges.slice(0, max);
}


// ── HF-Embeddings strategy ────────────────────────────────────────────────────

const _invoke = (
  window.__TAURI__?.core?.invoke ??
  window.__TAURI__?.tauri?.invoke ??
  null
);

async function _hfEdges(papers, cfg) {
  if (!_invoke) throw new Error("Tauri invoke not available");
  const res = await _invoke("hf_compute_similarity", {
    papers,
    config: {
      model:     cfg.model     ?? "sentence-transformers/all-MiniLM-L6-v2",
      fields:    cfg.fields    ?? ["title", "abstract", "hashtags"],
      weights:   cfg.weights   ?? {},
      threshold: cfg.threshold ?? SIMILARITY_THRESHOLD,
      max_edges: cfg.max_edges ?? MAX_EDGES_PER_NODE,
    },
  });
  return res.edges ?? [];
}

async function _hfEdgesForNew(np, existing, cfg) {
  const all   = [...existing.filter(p => p.id !== np.id), np];
  const edges = await _hfEdges(all, cfg);
  return edges
    .filter(e => e.source_id === np.id || e.target_id === np.id)
    .slice(0, cfg.max_edges ?? MAX_EDGES_PER_NODE);
}


// ── Public API ────────────────────────────────────────────────────────────────

export async function computeEdges(papers, config = {}) {
  const c = { ...getDefaultConfig(), ...config };
  if (c.strategy === "hf-embeddings") return _hfEdges(papers, c);
  return _jsEdges(papers, c.threshold, c.max_edges);
}

export async function computeEdgesForNewPaper(newPaper, existing, config = {}) {
  const c = { ...getDefaultConfig(), ...config };
  if (c.strategy === "hf-embeddings") return _hfEdgesForNew(newPaper, existing, c);
  return _jsEdgesForNew(newPaper, existing, c.threshold, c.max_edges);
}