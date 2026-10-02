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
import { componentsCss, componentsJs } from "../servers/gateway/dashboard/shared/components-css.js";
import { renderMarkdown, wrapTables } from "../servers/blog/renderer.js";

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
    // Exactly the class "table-scroll" — optionally followed by more classes
    // (space-separated) or one server-side ${…} suffix — so a lookalike such
    // as "table-scrollbar" does not pass.
    if (!/<div class="table-scroll(?:\s[^"]*|\$\{[^}]*\})?"[^>]*>$/.test(before)) bad.push(ln);
  }
  for (const m of src.matchAll(/(\w+)\s*=\s*document\.createElement\(\s*['"]table['"]\s*\)/g)) {
    const ln = lineAt(m.index);
    if (isCommentLine(lines[ln - 1])) continue;
    const tableVar = m[1];
    const window = lines.slice(ln - 1, ln + 90).join("\n");
    // Some element is classed exactly 'table-scroll' AND that same element
    // receives the table via appendChild.
    const ok = [...window.matchAll(/(\w+)\.className\s*=\s*['"]table-scroll['"]/g)].some((w) =>
      new RegExp("\\b" + w[1] + "\\.appendChild\\(\\s*" + tableVar + "\\s*\\)").test(window));
    if (!ok) bad.push(ln);
  }
  // A createElement('table') whose result is not assigned cannot be traced.
  for (const m of src.matchAll(/createElement\(\s*['"]table['"]\s*\)/g)) {
    const pre = src.slice(Math.max(0, m.index - 40), m.index);
    if (!/(\w+)\s*=\s*document\.$/.test(pre)) {
      const ln = lineAt(m.index);
      if (!isCommentLine(lines[ln - 1])) bad.push(ln);
    }
  }
  return bad;
}

test("the checker itself flags a bare table and passes a wrapped one (not vacuous)", () => {
  assert.deepEqual(findBareTables("const a = `<table class=\"x\"><tr></tr></table>`;"), [1]);
  assert.deepEqual(findBareTables("const a = `<div class=\"card\"><table>`;"), [1]);
  assert.deepEqual(findBareTables("const a = `<div class=\"table-scroll\"><table class=\"x\">`;"), []);
  assert.deepEqual(findBareTables("x = `<div class=\"table-scroll\" style=\"margin:0\">` +\n  `<table>`;"), []);
  assert.deepEqual(findBareTables("x = `<div class=\"table-scrollbar\"><table>`;"), [1], "lookalike class");
  assert.deepEqual(findBareTables("x = `<div class=\"table-scroll${extra}\"><table>`;"), []);
  assert.deepEqual(findBareTables("var t=document.createElement('table');\nwrap.appendChild(t);"), [1]);
  // Classed wrapper exists but the table never goes into it.
  assert.deepEqual(findBareTables("var t=document.createElement('table');\nvar s=document.createElement('div');s.className='table-scroll';\nhost.appendChild(t);"), [1]);
  assert.deepEqual(findBareTables("var t=document.createElement('table');\nvar s=document.createElement('div');s.className='table-scroll';\ns.appendChild(t);"), []);
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
  assert.match(stacked, /^<div class="table-scroll table-stack"><table class="data-table data-table--stack" role="table">/);
  assert.match(stacked, /<td role="cell" data-label="bot_id">x<\/td>/);
  assert.match(stacked, /<td role="cell" data-label="updated">2026-10-02<\/td>/);
  assert.match(stacked, /<tr role="row">/);
  // An empty header is an action column: no label, shares one line.
  assert.match(stacked, /<td role="cell" class="dt-action"><a>Edit<\/a><\/td>/);
  // A wide free-text column is marked, stacked or not.
  assert.match(dataTable(["a", "b"], [["1", "2"]], { stack: true, wide: [1] }), /<td role="cell" class="dt-wide" data-label="b">2<\/td>/);
  assert.match(dataTable(["a", "b"], [["1", "2"]], { wide: [1] }), /<td class="dt-wide">2<\/td>/);
  // Unstacked tables carry no ARIA roles (plain table semantics).
  assert.ok(!/role=/.test(plain));
  // Header text is escaped into the attribute.
  assert.match(dataTable(['a"b'], [["1"]], { stack: true }), /data-label="a&quot;b"/);
});

test("the shared stylesheet makes .table-scroll scroll and stacks only when measured too wide", () => {
  const css = componentsCss();
  const rule = css.match(/\.table-scroll\s*\{([^}]*)\}/);
  assert.ok(rule, ".table-scroll rule exists");
  assert.match(rule[1], /overflow-x:\s*auto/);
  assert.match(rule[1], /max-width:\s*100%/);
  // Stacking is driven by the measured .is-stacked class, not a fixed
  // container breakpoint, and a stacked list has a floor width.
  assert.ok(!/@container/.test(css), "no fixed container-query breakpoint");
  assert.match(css, /\.table-stack\.is-stacked\s*\{\s*min-width:\s*14rem/);
  // No rule strips a wrapped table's own top margin.
  assert.ok(!/\.table-scroll > table\s*\{[^}]*margin/.test(css));
  // Inline code inside table cells keeps Perch's "cells stay intact" rule.
  assert.match(css, /:not\(pre, td, th\) > code/);
  // The zero-specificity safety net: pre scrolls, media shrinks, flex/grid
  // children may shrink below their content.
  assert.match(css, /:where\(\.content-body\) :where\(pre\) \{[^}]*overflow-x:\s*auto/);
  assert.match(css, /:where\(\.content-body\) :where\(img,[^)]*\) \{[^}]*max-width:\s*100%/);
  assert.match(css, /:where\(\.content-body\) :where\(div,[^)]*\) \{[^}]*min-width:\s*0/);
});

test("renderMarkdown wraps markdown tables (public blog, preview, memory, KB, Perch, file view)", () => {
  const html = renderMarkdown("|a|b|\n|-|-|\n|1|2|");
  assert.match(html, /^<div class="table-scroll"><table>[\s\S]*<\/table><\/div>\s*$/);
  // Every table gets exactly one wrapper, nested or not.
  const two = renderMarkdown("|a|\n|-|\n|1|\n\ntext\n\n|b|\n|-|\n|2|");
  assert.equal((two.match(/<div class="table-scroll">/g) || []).length, 2);
  assert.equal((two.match(/<\/table><\/div>/g) || []).length, 2);
  // Author markup cannot smuggle the wrapper or a fake table close.
  const sneaky = renderMarkdown("<div class=\"table-scroll\">x</div>\n\n`</table>`");
  assert.ok(!sneaky.includes('class="table-scroll"'), "the sanitizer strips author-supplied wrapper classes");
  assert.ok(!sneaky.includes("</table></div>"));
  assert.equal(wrapTables("<p>no table</p>"), "<p>no table</p>");
});

test("pages that render markdown without the dashboard stylesheet carry the wrapper CSS", () => {
  for (const rel of ["servers/gateway/routes/blog-public.js", "servers/gateway/routes/fileview.js"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.match(src, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/, rel + " styles .table-scroll");
    assert.match(src, /@media print\s*\{\s*\.table-scroll/, rel + " prints wide tables unclipped");
  }
});

test("the scroll hint is drawn only while a wrapper can scroll, and print is unclipped", () => {
  const css = componentsCss();
  const base = css.match(/\.table-scroll\s*\{([^}]*)\}/)[1];
  assert.ok(!/background/.test(base), "no always-on cover gradients on the bare wrapper");
  assert.match(css, /\.table-scroll\.is-scrollable\s*\{[^}]*background:/);
  assert.match(css, /@media print\s*\{\s*\.table-scroll[^{]*\{[^}]*overflow:\s*visible/);
  // Context-aware cover colour: page background vs card.
  assert.match(css, /\.content-body\s*\{\s*--table-scroll-bg:\s*var\(--crow-bg-deep\)/);
  assert.match(css, /\.card, \.stat-card\s*\{\s*--table-scroll-bg:\s*var\(--crow-bg-surface\)/);
  const js = componentsJs();
  assert.match(js, /is-scrollable/);
  assert.match(js, /is-stacked/);
  assert.ok(!js.includes("`"), "client JS is emitted inside a template literal: no backticks");
});
