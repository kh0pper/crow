/**
 * VitePress compiles docs/**\/*.md as Vue templates, so a bare `<tag>` in prose is
 * parsed as an element: a lone `<time>` broke the deploy-docs workflow with
 * "Element is missing end tag" (#916). Every `<identifier ...>` Vue actually sees
 * must therefore be void, self-closing (`/>`), or closed by a matching
 * `</identifier>` in the same file. Placeholders in prose belong in backticks (or
 * written `&lt;name&gt;`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../docs", import.meta.url));

/** Elements HTML/Vue treats as void: an unclosed one is legal. */
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "source", "wbr"]);

function markdownFiles(dir = DOCS, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".vitepress" || ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) markdownFiles(p, out);
    else if (ent.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Blank a match in place, keeping its newlines so line numbers stay put. */
const mask = (s) => s.replace(/[^\n]/g, " ");

/**
 * The document as Vue sees it: fenced and indented code blocks blanked, inline
 * code spans (which may wrap lines) and HTML comments masked. Line numbers are
 * preserved, so a hit reports the line it is on.
 */
function templateText(md) {
  const kept = [];
  let fence = null;
  let prevBlank = true; // the start of a file behaves like a blank line
  let inCode = false;
  for (const line of md.split("\n")) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      kept.push("");
      continue;
    }
    if (mark) { fence = mark[1]; prevBlank = true; kept.push(""); continue; }
    if (!line.trim()) { prevBlank = true; kept.push(""); continue; }
    // Markdown's indented code block: 4+ spaces, and it cannot interrupt a paragraph.
    // A list item's own 4-space continuation can look the same; skipping it can only
    // hide a hit, never invent one, which is the safe way to be wrong here.
    if (/^(\t| {4})/.test(line) && (inCode || prevBlank)) { inCode = true; prevBlank = false; kept.push(""); continue; }
    inCode = false;
    prevBlank = false;
    kept.push(line);
  }
  return kept.join("\n")
    .replace(/(`+)[\s\S]*?\1/g, mask)
    .replace(/<!--[\s\S]*?-->/g, mask);
}

/** Every unclosed, non-void opening tag in one markdown document. */
function bareTags(md) {
  const text = templateText(md);
  const found = [];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [i, line] of text.split("\n").entries()) {
    for (const m of line.matchAll(/<([A-Za-z][A-Za-z0-9_.:-]*)(\s[^<>]*)?>/g)) {
      const name = m[1];
      if (m[0].endsWith("/>") || VOID.has(name.toLowerCase())) continue;
      if (new RegExp(`</${escape(name)}\\s*>`).test(text)) continue;
      found.push({ line: i + 1, tag: m[0].slice(0, 40) });
    }
  }
  return found;
}

test("no markdown file in docs/ carries a bare (unclosed, non-void) tag", () => {
  const violations = markdownFiles().flatMap((f) =>
    bareTags(readFileSync(f, "utf8")).map((v) => `${relative(DOCS, f)}:${v.line} ${v.tag}`));
  assert.deepEqual(violations, []);
});

test("every markdown file in docs/ leaves prose for the guard to read (no runaway code fence)", () => {
  const silent = markdownFiles().filter((f) => !templateText(readFileSync(f, "utf8")).replace(/\s+/g, ""));
  assert.deepEqual(silent.map((f) => relative(DOCS, f)), []);
});

test("the guard catches the shape that broke the docs build, and leaves code, void and real HTML alone", () => {
  const original = 'A beside hold is worded "a job is using part of the GPU until about <time>; larger starts wait."';
  assert.deepEqual(bareTags(original).map((v) => v.line), [1], "the bare <time> would have failed the build");

  const fine = [
    "A placeholder in backticks: `until about <time>;`",
    "A span that wraps a line: `Connected Crow to <app> with an API",
    "token it created`.",
    "An escaped one: &lt;time&gt;",
    "A comment: <!-- <time> --> and a multi-line one: <!--",
    "<time>",
    "-->",
    "A fenced block:",
    "```",
    "<div><time>",
    "```",
    "An indented one:",
    "",
    "    node x.mjs get --model <id>",
    "",
    'Void and self-closing: <br> <img src="x.png"> <meta name="x"> <component-a :x="1" />.',
    "A real closed pair stays legal:",
    "",
    "<div>",
    "text",
    "</div>",
  ].join("\n");
  assert.deepEqual(bareTags(fine), []);
});