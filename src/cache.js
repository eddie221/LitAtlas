// cache.js

let papers = [];  // PaperFull[] from Rust — id is number (i64)
let edges  = [];  // EdgeRow[]  from Rust
let _currentPaper     = null;
let _currentConnected = null;

// Pseudo-papers fetched from arXiv. Live in-memory only — promoted to real
// papers (with PDF + DB row) when the user clicks "Import" on the popover.
let pseudoPapers = [];   // ArxivPaper-derived: { id, title, summary, authors, ... , isPseudo:true, x,y }
let pseudoEdges  = [];   // { source_id, target_id, similarity }  (target_id is a pseudo id)

export function setPapersCache(data) { papers = data; }
export function getPapersCache()     { return papers; }
export function setEdgesCache(data)  { edges  = data; }
export function getEdgesCache()      { return edges; }
export function setPseudoPapers(data) { pseudoPapers = data; }
export function getPseudoPapers()     { return pseudoPapers; }
export function setPseudoEdges(data)  { pseudoEdges  = data; }
export function getPseudoEdges()      { return pseudoEdges; }
export function setCurrentPaperCache(data)  { _currentPaper  = data; }
export function getCurrentPaperCache()      { return _currentPaper; }
export function setCurrentConnectedCache(data)  { _currentConnected  = data; }
export function getCurrentConnectedCache()      { return _currentConnected; }

// ── Application state ────────────────────────────────────────────────────────
export const state = {
  nodes: [], edges: [],
  selectedNode: null, hoveredNode: null, hoveredEdge: null,
  dragging: null, dragOffX: 0, dragOffY: 0,
  panning: false, panStartX: 0, panStartY: 0,
  viewX: 0, viewY: 0, scale: 1,
  layoutMode: "force",
  searchQuery: "",
  animFrame: null,
};