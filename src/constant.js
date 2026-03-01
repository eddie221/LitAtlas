// constant.js

// Map the first hashtag on a paper to a display colour for the graph.
// Falls back to #888 if no known tag is found.
export const TAG_COLORS = {
  "classification":  "#c8ff00",
  "object-detection":"#00d4ff",
  "segmentation":    "#ff6b35",
  "generative":      "#a855f7",
  "3d-vision":       "#f43f5e",
  "self-supervised": "#34d399",
  "video":           "#fb923c",
  "depth-estimation":"#60a5fa",
};

// Per-node color overrides: { [paperId]: "#rrggbb" }
// Populated at runtime by the color picker in the detail panel.
export const nodeColorOverrides = {};

// Preset palette offered in the color picker UI
export const COLOR_PALETTE = [
  "#c8ff00", "#00d4ff", "#ff6b35", "#a855f7",
  "#f43f5e", "#34d399", "#fb923c", "#60a5fa",
  "#f9fafb", "#facc15", "#e879f9", "#2dd4bf",
];

// Derive a display colour from a paper's hashtag array.
// Per-node color override (set via color picker) takes highest priority.
export function colorForPaper(paper) {
  if (paper?.id !== undefined && nodeColorOverrides[paper.id]) {
    return nodeColorOverrides[paper.id];
  }
  for (const tag of (paper.hashtags ?? [])) {
    const key = tag.replace(/^#/, "");
    if (TAG_COLORS[key]) return TAG_COLORS[key];
  }
  return "#888";
}

// Human-readable "group" label for sidebar/tooltip.
export function groupForPaper(paper) {
  const tag = (paper.hashtags?.[0] ?? "").replace(/^#/, "");
  return tag
    ? tag.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Research Paper";
}