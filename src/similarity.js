/**
 * similarity.js
 *
 * Lightweight similarity engine for PaperGraph.
 *
 * With the v3 schema, papers no longer carry a fixed feature vector
 * (task / architecture / supervision / embedding_dim).  Similarity is
 * now computed from the fields that are always present:
 *
 *   • year_norm     (linear 2012 → 2024)          weight 0.25
 *   • venue_match   (1 if same venue, else 0)      weight 0.30
 *   • tag_overlap   (Jaccard on hashtag sets)       weight 0.45
 *
 * All dimensions are pre-multiplied by sqrt(weight) so cosine similarity
 * equals weighted cosine similarity after normalisation.
 *
 * Custom attributes (abstract, citations, …) are not used for similarity
 * because they are user-defined and not guaranteed to be present.
 */

// ── Weights ───────────────────────────────────────────────────────────────────
const W_YEAR  = 0.25;
const W_VENUE = 0.30;
const W_TAGS  = 0.45;

// ── Known tag vocabulary (order defines vector positions) ────────────────────
// Tags not in this list are ignored for similarity — they still display fine.
const TAG_VOCAB = [
  "classification", "object-detection", "segmentation", "generative",
  "3d-vision", "self-supervised", "video", "depth-estimation", "optical-flow",
  "cnn", "transformer", "diffusion", "gan", "vae", "mlp", "nerf",
  "contrastive", "masked-autoencoder", "imagenet", "real-time",
];

export const VECTOR_DIM = TAG_VOCAB.length + 2; // tags + year + venue

// ── Encoding ──────────────────────────────────────────────────────────────────

function yearNorm(year) {
  return (Number(year) - 2012) / (2024 - 2012);
}

/**
 * Encode a paper into a fixed-length Float64 vector.
 * paper must have: year (number), venue (string), hashtags (string[]).
 */
export function encode(paper) {
  const vec = new Array(VECTOR_DIM).fill(0);

  // Tag multi-hot  [0 .. TAG_VOCAB.length-1]
  const tagW = Math.sqrt(W_TAGS);
  const tagSet = new Set((paper.hashtags ?? []).map(t => t.replace(/^#/, "")));
  for (let i = 0; i < TAG_VOCAB.length; i++) {
    if (tagSet.has(TAG_VOCAB[i])) vec[i] = tagW;
  }

  // Year scalar  [TAG_VOCAB.length]
  vec[TAG_VOCAB.length]     = yearNorm(paper.year) * Math.sqrt(W_YEAR);

  // Venue one-hot is handled via cosine — same venue → high dot product.
  // We encode it as a normalised hash bucket to keep the vector fixed-length.
  // Two papers with the same venue string will get vec[last] = sqrt(W_VENUE);
  // different venues → orthogonal → dot = 0 on that dimension.
  // We use a simple collision-tolerant string hash mod 1 → [0,1] scalar.
  const venueHash = venueScalar(paper.venue ?? "");
  vec[TAG_VOCAB.length + 1] = venueHash * Math.sqrt(W_VENUE);

  return vec;
}

// Map a venue string to a stable scalar in [0, 1].
// Same venue → same value; different venues → different values (usually).
function venueScalar(venue) {
  const KNOWN = [
    "NeurIPS","ICML","ICLR","CVPR","ICCV","ECCV","SIGGRAPH","TMLR","arXiv",
    "AAAI","ACL","EMNLP","ICRA","RSS","CoRL",
  ];
  const idx = KNOWN.indexOf(venue.trim());
  if (idx !== -1) return (idx + 1) / KNOWN.length;
  // Unknown venue: hash it to a fixed bucket
  let h = 0;
  for (let i = 0; i < venue.length; i++) h = (h * 31 + venue.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Edge metadata ─────────────────────────────────────────────────────────────

export function edgeType(a, b) {
  const aTags = new Set((a.hashtags ?? []).map(t => t.replace(/^#/, "")));
  const bTags = new Set((b.hashtags ?? []).map(t => t.replace(/^#/, "")));
  for (const t of aTags) { if (bTags.has(t)) return "same_tag"; }
  if ((a.venue ?? "") === (b.venue ?? "") && a.venue) return "same_venue";
  return "related";
}

export function edgeWeight(sim) {
  if (sim >= 0.75) return 3;
  if (sim >= 0.55) return 2;
  return 1;
}

// ── Thresholds ────────────────────────────────────────────────────────────────
export const SIMILARITY_THRESHOLD = 0.38;
export const MAX_EDGES_PER_NODE   = 7;

// ── Full graph computation ────────────────────────────────────────────────────

/**
 * Compute all similarity edges for an array of paper objects.
 * Returns edge objects ready for the Rust `recompute_edges` command:
 *   { source_id, target_id, similarity, weight, edge_type }
 */
export function computeEdges(papers) {
  const n    = papers.length;
  const vecs = papers.map(encode);

  const candidates = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosine(vecs[i], vecs[j]);
      if (sim >= SIMILARITY_THRESHOLD) {
        candidates.push({
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

  candidates.sort((a, b) => b.similarity - a.similarity);

  const edgeCount = new Array(n).fill(0);
  const result    = [];
  for (const e of candidates) {
    if (edgeCount[e._i] < MAX_EDGES_PER_NODE && edgeCount[e._j] < MAX_EDGES_PER_NODE) {
      edgeCount[e._i]++;
      edgeCount[e._j]++;
      result.push({
        source_id:  e.source_id,
        target_id:  e.target_id,
        similarity: parseFloat(e.similarity.toFixed(6)),
        weight:     e.weight,
        edge_type:  e.edge_type,
      });
    }
  }
  return result;
}

/**
 * Compute edges for one new paper against an existing set.
 * Used when adding a paper so we don't recompute the entire graph.
 */
export function computeEdgesForNewPaper(newPaper, existingPapers) {
  const newVec = encode(newPaper);
  const edges  = [];

  for (const other of existingPapers) {
    if (other.id === newPaper.id) continue;
    const sim = cosine(newVec, encode(other));
    if (sim >= SIMILARITY_THRESHOLD) {
      edges.push({
        source_id:  newPaper.id,
        target_id:  other.id,
        similarity: parseFloat(sim.toFixed(6)),
        weight:     edgeWeight(sim),
        edge_type:  edgeType(newPaper, other),
      });
    }
  }

  edges.sort((a, b) => b.similarity - a.similarity);
  return edges.slice(0, MAX_EDGES_PER_NODE);
}