/**
 * Mobile overflow guard (2026-10): every dashboard table sits in the shared
 * .table-scroll wrapper.
 *
 * On a phone (Pixel 9a: 412px portrait, ~915px landscape with the sidebar
 * open) a bare <table> wider than its card ran past the card's right border
 * and clipped its last columns (Bot Builder -> "Your bots" lost UPDATED).
 * The fix is one shared wrapper (components-css.js: .table-scroll scrolls
 * inside the card) that dataTable() emits and every hand-built table opens
 * itself with. This file fails when a panel emits a table outside it.
 *
 * Static, hermetic: reads source text only — no browser, no DB, no ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { dataTable } from "../servers/gateway/dashboard/shared/components.js";
import { componentsCss } from "../servers/gateway/dashboard/shared/components-css.js";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every dashboard source: the gateway dashboard + every bundle's panel(s) dir. */
function dashboardSources() {
  const files = walk(join(ROOT, "servers/gateway/dashboard"));
  const bundles = join(ROOT, "bundles");
  for (const b of readdirSync(bundles)) {
    for (const d of ["panel", "panels"]) walk(join(bundles, b, d), files);
  }
  return files;
}

const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/**
 * Offending table emissions in one source text. A literal `<table` passes only
 * when the markup right before it (ignoring whitespace and the quote/backtick/
 * `+` of string concatenation) is an opening <div class="table-scroll…">. A
 * client-side createElement('table') passes only when the same builder (the
 * next 90 lines) puts it in a 'table-scroll' element.
 */
function findBareTables(src) {
  const bad = [];
  const lines = src.split("\n");
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;
  for (const m of src.matchAll(/<table[\s>]/g)) {
    const ln = lineAt(m.index);
    if (isCommentLine(lines[ln - 1])) continue;
    const before = src.slice(Math.max(0, m.index - 400), m.index).replace(/[\s`'"+]*$/, "");
    if (!/<div class="table-scroll[^"]*"[^>]*>$/.test(before)) bad.push(ln);
  }
  for (const m of src.matchAll(/createElement\(\s*['"]table['"]\s*\)/g)) {
    const ln = lineAt(m.index);
    if (isCommentLine(lines[ln - 1])) continue;
    const window = lines.slice(ln - 1, ln + 90).join("\n");
    if (!/['"]table-scroll['"]/.test(window)) bad.push(ln);
  }
  return bad;
}

test("the checker itself flags a bare table and passes a wrapped one (not vacuous)", () => {
  assert.deepEqual(findBareTables("const a = `<table class=\"x\"><tr></tr></table>`;"), [1]);
  assert.deepEqual(findBareTables("const a = `<div class=\"card\"><table>`;"), [1]);
  assert.deepEqual(findBareTables("const a = `<div class=\"table-scroll\"><table class=\"x\">`;"), []);
  assert.deepEqual(findBareTables("x = `<div class=\"table-scroll\" style=\"margin:0\">` +\n  `<table>`;"), []);
  assert.deepEqual(findBareTables("var t=document.createElement('table');\nwrap.appendChild(t);"), [1]);
  assert.deepEqual(findBareTables("var t=document.createElement('table');\nvar s=document.createElement('div');s.className='table-scroll';"), []);
});

test("no dashboard panel emits a <table> outside the shared .table-scroll wrapper", () => {
  const offenders = [];
  let tables = 0;
  for (const f of dashboardSources()) {
    const src = readFileSync(f, "utf8");
    tables += (src.match(/<table[\s>]|createElement\(\s*['"]table['"]\s*\)/g) || []).length;
    for (const ln of findBareTables(src)) offenders.push(`${relative(ROOT, f)}:${ln}`);
  }
  // Floor, so a path or regex mistake that scans nothing cannot pass silently.
  assert.ok(tables >= 30, `expected to scan the dashboard's tables, found only ${tables}`);
  assert.deepEqual(offenders, [],
    "wrap the table in <div class=\"table-scroll\">…</div> or build it with dataTable() — " +
    "a bare table overflows its card on a phone");
});

test("dataTable() emits the scroll wrapper, and the stacked variant labels every cell", () => {
  const plain = dataTable(["Name", "Model"], [["a", "crow-local/qwen3.6-35b-a3b"]]);
  assert.match(plain, /^<div class="table-scroll"><table class="data-table">/);
  assert.match(plain, /<\/table><\/div>$/);

  const stacked = dataTable(["bot_id", "updated", ""], [["x", "2026-10-02", "<a>Edit</a>"]], { stack: true });
  assert.match(stacked, /^<div class="table-scroll table-stack"><table class="data-table data-table--stack">/);
  assert.match(stacked, /<td data-label="bot_id">x<\/td>/);
  assert.match(stacked, /<td data-label="updated">2026-10-02<\/td>/);
  // An empty header is an action column: no label, shares one line.
  assert.match(stacked, /<td class="dt-action"><a>Edit<\/a><\/td>/);
  // Header text is escaped into the attribute.
  assert.match(dataTable(['a"b'], [["1"]], { stack: true }), /data-label="a&quot;b"/);
});

test("the shared stylesheet makes .table-scroll scroll and stacks on a narrow container", () => {
  const css = componentsCss();
  const rule = css.match(/\.table-scroll\s*\{([^}]*)\}/);
  assert.ok(rule, ".table-scroll rule exists");
  assert.match(rule[1], /overflow-x:\s*auto/);
  assert.match(rule[1], /max-width:\s*100%/);
  assert.match(css, /container:\s*crow-table\s*\/\s*inline-size/);
  assert.match(css, /@container crow-table \(max-width: 600px\)/);
  // The zero-specificity safety net: pre scrolls, media shrinks, flex/grid
  // children may shrink below their content.
  assert.match(css, /:where\(\.content-body\) :where\(pre\) \{[^}]*overflow-x:\s*auto/);
  assert.match(css, /:where\(\.content-body\) :where\(img,[^)]*\) \{[^}]*max-width:\s*100%/);
  assert.match(css, /:where\(\.content-body\) :where\(div,[^)]*\) \{[^}]*min-width:\s*0/);
});
