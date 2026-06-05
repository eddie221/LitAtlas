#!/usr/bin/env node
// Creates a Python virtual environment at .venv/ and installs required packages.
// Called automatically via the "prepare" npm script.

const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const root    = path.resolve(__dirname, "..");
const venvDir = path.join(root, ".venv");
const pip     = path.join(venvDir, process.platform === "win32" ? "Scripts\\pip" : "bin/pip");

if (!fs.existsSync(venvDir)) {
  console.log("Creating Python virtual environment at .venv/ ...");
  execSync("python3 -m venv .venv", { cwd: root, stdio: "inherit" });
}

console.log("Installing Python dependencies ...");
execSync(`"${pip}" install --quiet markitdown`, { cwd: root, stdio: "inherit" });
console.log("Python setup complete.");
