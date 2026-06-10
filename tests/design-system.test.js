import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { button, codeBlock, callout, stepper, tabs } from "../servers/gateway/dashboard/shared/components.js";

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
                     "--crow-text-tertiary", "--crow-warning"]) {
    assert.ok(src.includes(tk + ":"), `expected ${tk} defined in design-tokens.js`);
  }
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

test("tabs: one panel per item, active marked, ids wired", () => {
  const html = tabs([{ id: "a", label: "A", content: "AA" }, { id: "b", label: "B", content: "BB" }], { active: 1 });
  assert.ok((html.match(/data-tab=/g) || []).length === 2, "two tab triggers");
  assert.ok(html.includes("AA") && html.includes("BB"));
  assert.ok(html.includes("tab-active"));
});
