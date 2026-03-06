// tag-autocomplete.js
//
// Attaches a prefix-match hashtag autocomplete dropdown to a text input.
// The input accepts multiple space/comma-separated tags; only the token
// currently being typed is matched and completed.
//
// Usage:
//   import { attachTagAutocomplete } from "./tag-autocomplete.js";
//   attachTagAutocomplete(inputEl, getTagVocab);
//
// getTagVocab — zero-arg function that returns string[] of known tags
//               (without leading #).  Called on every keystroke so the
//               vocabulary stays fresh without needing a re-attach.

export function attachTagAutocomplete(input, getVocab) {
  // ── Dropdown container ──────────────────────────────────────────────────────
  const dropdown = document.createElement("ul");
  dropdown.className = "tag-ac-dropdown";
  dropdown.style.display = "none";
  // Insert as a sibling right after the input so CSS positioning is easy.
  input.insertAdjacentElement("afterend", dropdown);

  // ── Focus hint line ─────────────────────────────────────────────────────────
  // Shown below the input when it's focused but no token is being typed.
  const focusHint = document.createElement("div");
  focusHint.className = "tag-ac-focus-hint";
  focusHint.textContent = "type # or any word to filter tags  ·  \u2191\u2193 navigate  ·  \u21b5 / Tab to pick";
  focusHint.style.display = "none";
  dropdown.insertAdjacentElement("afterend", focusHint);

  let _activeIdx = -1;   // keyboard-highlighted row index

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Return the token the cursor is currently inside. */
  function _currentToken() {
    const val    = input.value;
    const cursor = input.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const match  = before.match(/(?:^|[\s,]+)([^,\s]*)$/);
    return match ? match[1].replace(/^#/, "").toLowerCase() : "";
  }

  /** Replace only the token under the cursor with the chosen tag. */
  function _applyChoice(tag) {
    const val    = input.value;
    const cursor = input.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const after  = val.slice(cursor);

    const replaced = before.replace(/([^,\s]*)$/, "#" + tag);
    const newVal = replaced + (after.startsWith(" ") || after === "" ? "" : "") + " " + after.trimStart();
    input.value  = newVal.trimEnd() + " ";
    const newCursor = replaced.length + 1;
    input.setSelectionRange(newCursor, newCursor);

    _close();
    input.focus();
  }

  /**
   * Measure pixel width of text-before-cursor using a canvas,
   * then clamp so the dropdown never overflows the input's right edge.
   */
  function _caretLeft() {
    const val    = input.value;
    const cursor = input.selectionStart ?? val.length;

    const canvas = _caretLeft._canvas ??
      (_caretLeft._canvas = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    const cs  = window.getComputedStyle(input);
    ctx.font  = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;

    const pl   = parseFloat(cs.paddingLeft) || 0;
    const rawW = ctx.measureText(val.slice(0, cursor)).width;
    // Clamp: keep the dropdown fully within the input width.
    const maxLeft = input.offsetWidth - 168; // 168 ≈ min-width of dropdown
    return Math.max(0, Math.min(pl + rawW, maxLeft));
  }

  /** Minimal HTML escape for split-highlight rendering. */
  function esc(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  /** Render matches into the dropdown, positioned at the caret. */
  function _render(matches) {
    dropdown.innerHTML = "";
    _activeIdx = -1;
    focusHint.style.display = "none";

    if (!matches.length) { _close(); return; }

    matches.forEach((tag) => {
      const li = document.createElement("li");
      li.className   = "tag-ac-item";
      li.dataset.tag = tag;

      // Highlight the matched prefix vs. the completion suffix.
      const token  = _currentToken();
      const prefix = tag.slice(0, token.length);
      const rest   = tag.slice(token.length);
      li.innerHTML =
        `<span class="tag-ac-match">#${esc(prefix)}</span><span class="tag-ac-rest">${esc(rest)}</span>`;

      li.addEventListener("mousedown", e => {
        e.preventDefault();
        _applyChoice(tag);
      });
      dropdown.appendChild(li);
    });

    // Anchor dropdown horizontally to the caret.
    dropdown.style.left    = _caretLeft() + 10 + "px";
    dropdown.style.top    = 40 + "px";
    dropdown.style.display = "block";
    _setActive(-1);
  }

  function _close() {
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
    _activeIdx = -1;
  }

  function _setActive(idx) {
    const items = dropdown.querySelectorAll(".tag-ac-item");
    items.forEach((el, i) => el.classList.toggle("tag-ac-active", i === idx));
    _activeIdx = idx;
    if (idx >= 0) items[idx]?.scrollIntoView({ block: "nearest" });
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  input.addEventListener("input", () => {
    const token = _currentToken();
    if (!token) {
      _close();
      if (document.activeElement === input) focusHint.style.display = "block";
      return;
    }
    focusHint.style.display = "none";

    const vocab   = getVocab();
    const matches = vocab
      .filter(t => t.startsWith(token) && t !== token)
      .slice(0, 5);
    _render(matches);
  });

  input.addEventListener("focus", () => {
    if (!_currentToken()) focusHint.style.display = "block";
  });

  input.addEventListener("keydown", e => {
    if (dropdown.style.display === "none") return;
    const items = dropdown.querySelectorAll(".tag-ac-item");
    const count = items.length;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      _setActive((_activeIdx + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _setActive((_activeIdx - 1 + count) % count);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (_activeIdx >= 0) {
        e.preventDefault();
        _applyChoice(items[_activeIdx].dataset.tag);
      } else if (e.key === "Tab" && count > 0) {
        e.preventDefault();
        _applyChoice(items[0].dataset.tag);
      }
    } else if (e.key === "Escape") {
      _close();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      _close();
      focusHint.style.display = "none";
    }, 120);
  });

  input.addEventListener("scroll", _close, { passive: true });
}