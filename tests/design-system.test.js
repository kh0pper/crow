import { test } from "node:test";
import assert from "node:assert/strict";
import designSystemPanel from "../servers/gateway/dashboard/panels/design-system.js";
import { designTokensCss } from "../servers/gateway/dashboard/shared/design-tokens.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { button, codeBlock, callout, stepper, tabs } from "../servers/gateway/dashboard/shared/components.js";
import { componentsCss } from "../servers/gateway/dashboard/shared/components-css.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = join(ROOT, "servers/gateway/dashboard");

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Files that consume tokens: the whole dashboard tree + the public blog renderer. */
function tokenConsumerFiles() {
  const files = walk(DASH);
  const blog = join(ROOT, "servers/gateway/routes/blog-public.js");
  try { readFileSync(blog); files.push(blog); } catch {}
  return files;
}

// Note: this checks that the LHS token name is defined, but does not verify
// that var() aliases on the RHS resolve to a defined canonical token.
// If an alias's RHS target is later removed, this test will not catch it.
function definedTokens() {
  const defined = new Set();
  for (const rel of ["shared/design-tokens.js", "shared/components-css.js"]) {
    let src = "";
    try { src = readFileSync(join(DASH, rel), "utf8"); } catch { continue; }
    for (const m of src.matchAll(/(--crow-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  return defined;
}

function usedTokens() {
  const used = new Map(); // token -> first file:line
  for (const f of tokenConsumerFiles()) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\((--crow-[a-z0-9-]+)/g)) {
        if (!used.has(m[1])) used.set(m[1], `${f}:${i + 1}`);
      }
    });
  }
  return used;
}

test("every var(--crow-*) token used in the dashboard is defined", () => {
  const defined = definedTokens();
  const used = usedTokens();
  const undefinedTokens = [...used.entries()].filter(([t]) => !defined.has(t));
  assert.equal(
    undefinedTokens.length,
    0,
    "undefined tokens:\n" + undefinedTokens.map(([t, loc]) => `  ${t}  (first at ${loc})`).join("\n"),
  );
});

test("token scales are defined", () => {
  const src = readFileSync(join(DASH, "shared/design-tokens.js"), "utf8");
  for (const tk of ["--crow-space-1", "--crow-space-4", "--crow-space-8",
                     "--crow-text-xs", "--crow-text-base", "--crow-text-3xl",
                     "--crow-leading-tight", "--crow-leading-relaxed",
                     "--crow-text-tertiary", "--crow-warning",
                     "--crow-accent-contrast", "--crow-radius-control", "--crow-border-strong"]) {
    assert.ok(src.includes(tk + ":"), `expected ${tk} defined in design-tokens.js`);
  }
});

test("designTokensCss: light values on :root, dark values inside the prefers-color-scheme media block", () => {
  const css = designTokensCss();
  const rootBlock = css.slice(0, css.indexOf("@media"));
  assert.ok(rootBlock.includes("#eef1f3"), "expected new light ground #eef1f3 on :root");
  const darkIdx = css.indexOf("@media (prefers-color-scheme: dark)");
  assert.ok(darkIdx !== -1, "expected a prefers-color-scheme: dark media block");
  assert.ok(css.slice(darkIdx).includes("#131a1f"), "expected new dark ground #131a1f inside the dark media block");
});

test("button: variant/size classes, <a> vs <button>, escaping", () => {
  const b = button("Save", { variant: "primary", size: "md" });
  assert.ok(b.includes("btn") && b.includes("btn-primary") && b.includes("btn-md"));
  assert.ok(b.startsWith("<button"));
  const link = button("Go", { href: "/x", variant: "secondary" });
  assert.ok(link.startsWith("<a") && link.includes('href="/x"') && link.includes("btn-secondary"));
  assert.ok(button("<x>").includes("&lt;x&gt;"));
});

test("codeBlock: escapes text and includes a copy trigger", () => {
  const c = codeBlock("npm run x <y>");
  assert.ok(c.includes("&lt;y&gt;"), "escapes content");
  assert.ok(c.includes("data-copy"), "has copy trigger");
  assert.ok(c.includes("<pre"));
});

test("callout: applies the type class", () => {
  assert.ok(callout("hi", "warning").includes("callout-warning"));
  assert.ok(callout("hi").includes("callout-info"), "defaults to info");
});

test("stepper: marks done/active/upcoming", () => {
  const s = stepper([{ label: "A" }, { label: "B" }, { label: "C" }], 1);
  assert.ok(s.includes("step-done"));
  assert.ok(s.includes("step-active"));
  assert.ok(s.includes("step-upcoming"));
  assert.ok(s.includes("A") && s.includes("B") && s.includes("C"));
});

test("stepper: a labelled group with a compact phone line above the full list", () => {
  const s = stepper([{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }], 1,
    { compactLabel: "Step 2 of 4", ariaLabel: "Steps" });
  assert.ok(s.startsWith('<div class="stepper-wrap" role="group" aria-label="Steps">'), s);
  assert.equal((s.match(/aria-current="step"/g) || []).length, 1, "exactly one current step");
  const compact = s.slice(s.indexOf('class="stepper-compact"'), s.indexOf('<ol'));
  assert.ok(compact.includes('aria-hidden="true"'), "the compact line is hidden from assistive tech (the list carries the steps)");
  assert.ok(compact.includes("Step 2 of 4 · B"), "the compact text is the filled label plus the current step");
  assert.ok(compact.includes("width:50%"), "bar width is (current+1)/total");
  assert.ok(!/role="progressbar"/.test(s), "the bar is decorative, not a progressbar");
  assert.ok(s.includes('<ol class="stepper">'), "the full list is still rendered");
});

test("stepper: escapes the compact label, aria label and step labels", () => {
  const s = stepper([{ label: "<b>x</b>" }], 0, { compactLabel: "<i>1</i>", ariaLabel: '"q"&' });
  assert.ok(!s.includes("<b>") && !s.includes("<i>"), s);
  assert.ok(s.includes("&lt;i&gt;1&lt;/i&gt; · &lt;b&gt;x&lt;/b&gt;"), s);
  assert.ok(s.includes('aria-label="&quot;q&quot;&amp;"'), s);
});

test("stepper: without opts falls back to n / total, and tolerates bad input", () => {
  const s = stepper([{ label: "A" }, { label: "B" }, { label: "C" }], 2);
  assert.ok(s.includes("3 / 3 · C"), s);
  assert.ok(s.includes("width:100%"));
  assert.doesNotThrow(() => stepper([], 0));
  assert.doesNotThrow(() => stepper(null, 5));
  assert.ok(stepper([{ label: "A" }], 9).includes("width:100%"), "an out-of-range current is clamped");
});

test("componentsCss: compact stepper only at the phone breakpoint, list kept for screen readers", () => {
  const css = componentsCss();
  assert.match(css, /\.stepper-compact\s*\{[^}]*display:\s*none/);
  const at = css.indexOf("@media (max-width:768px)");
  assert.ok(at !== -1, "uses the dashboard's inclusive 768px phone breakpoint");
  const block = css.slice(at, css.indexOf("}\n  }", at) + 4);
  assert.match(block, /\.stepper-compact\s*\{[^}]*display:\s*block/);
  // sr-only, never display:none — the ol keeps the steps for screen readers.
  const ol = block.slice(block.indexOf(".stepper-wrap .stepper"));
  for (const decl of ["position:absolute", "width:1px", "height:1px", "overflow:hidden", "clip:rect(0 0 0 0)", "white-space:nowrap"]) {
    assert.ok(ol.replace(/\s+/g, "").includes(decl.replace(/\s+/g, "")), "sr-only declaration " + decl);
  }
  assert.ok(!/\.stepper-wrap \.stepper\s*\{[^}]*display:\s*none/.test(block), "the list must not be display:none");
});

test("componentsCss: disabled buttons look disabled, hover and focus included", () => {
  const css = componentsCss();
  for (const sel of ['.btn.btn:disabled', '.btn.btn[aria-disabled="true"]', '.btn.btn:disabled:hover',
    '.btn.btn[aria-disabled="true"]:hover', '.btn.btn:disabled:focus', '.btn.btn[aria-disabled="true"]:focus']) {
    assert.ok(css.includes(sel), "selector " + sel);
  }
  const rule = css.slice(css.indexOf(".btn.btn:disabled"));
  const body = rule.slice(rule.indexOf("{"), rule.indexOf("}"));
  assert.match(body, /cursor:\s*not-allowed/);
  assert.match(body, /background:\s*var\(--crow-bg-elevated\)/);
});

test("tabs: one panel per item, active marked, ids wired", () => {
  const html = tabs([{ id: "a", label: "A", content: "AA" }, { id: "b", label: "B", content: "BB" }], { active: 1 });
  assert.ok((html.match(/data-tab=/g) || []).length === 2, "two tab triggers");
  assert.ok(html.includes("AA") && html.includes("BB"));
  assert.ok(html.includes("tab-active"));
});

test("design-system gallery panel renders all primitives without throwing", async () => {
  const layout = ({ content }) => content; // stub: return content for assertions
  let captured = "";
  const res = { send(html) { captured = html; }, setHeader() {} };
  const out = await designSystemPanel.handler({ method: "GET", body: {} }, res, { db: null, layout, lang: "en" });
  const html = typeof out === "string" ? out : captured;
  assert.ok(html && html.length > 0, "panel rendered HTML");
  for (const marker of ["btn-primary", "code-block", "callout-warning", "stepper", "tab-list"]) {
    assert.ok(html.includes(marker), `gallery includes ${marker}`);
  }
  assert.equal(designSystemPanel.id, "design-system");
  assert.equal(designSystemPanel.route, "/dashboard/design-system");
});
