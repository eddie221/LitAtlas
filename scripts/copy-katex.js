#!/usr/bin/env node
// Run after `npm install` to copy KaTeX vendored files into src/libs/.
// Called automatically via the "prepare" npm script.

const fs   = require("fs");
const path = require("path");

const root    = path.resolve(__dirname, "..");
const katex   = path.join(root, "node_modules", "katex", "dist");
const libsDir = path.join(root, "src", "libs");
const fontsDir = path.join(libsDir, "fonts");

fs.mkdirSync(fontsDir, { recursive: true });

const files = [
  ["katex.min.css",      path.join(libsDir, "katex.min.css")],
  ["katex.min.js",       path.join(libsDir, "katex.min.js")],
  [path.join("contrib", "auto-render.min.js"), path.join(libsDir, "auto-render.min.js")],
];

for (const [src, dest] of files) {
  fs.copyFileSync(path.join(katex, src), dest);
  console.log(`copied ${src}`);
}

const fontsSrc = path.join(katex, "fonts");
for (const f of fs.readdirSync(fontsSrc)) {
  fs.copyFileSync(path.join(fontsSrc, f), path.join(fontsDir, f));
}
console.log(`copied ${fs.readdirSync(fontsDir).length} fonts`);
