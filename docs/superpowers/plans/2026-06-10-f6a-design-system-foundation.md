# F6a — Design-System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token scales + missing tokens, five shared UI primitives (button/codeBlock/callout/stepper/tabs), a live gallery panel, docs, and a token-completeness test — the substrate F6b/F6c render through.

**Architecture:** All dashboard CSS is JS template strings (no `.css` files). Tokens live in `shared/design-tokens.js` (`designTokensCss()`), the base component CSS blob in `shared/layout.js` (`dashboardCss()`), HTML primitives in `shared/components.js`, panels registered via `dashboard/panel-registry.js`. F6a adds token scales + a new `shared/components-css.js` (CSS+JS for the new primitives, injected once into `dashboardCss()`), new primitive functions in `components.js`, a read-only gallery panel, and a `node:test` guard.

**Tech Stack:** Node ESM, `node:test`, CSS custom properties, vanilla delegated JS (no framework), Turbo Drive.

**Spec:** `docs/superpowers/specs/2026-06-10-f6a-design-system-foundation-design.md`

**Ground truth (2026-06-10):** A token-completeness scan of `servers/gateway/dashboard/**` + `routes/blog-public.js` found **9** `var(--crow-*)` tokens used but undefined: `--crow-text-tertiary`, `--crow-warning`, `--crow-bg`, `--crow-background`, `--crow-surface`, `--crow-bg-card`, `--crow-text`, `--crow-border-subtle`, `--crow-accent-bg`. Task 1 resolves all 9 (2 new semantic tokens + 7 compatibility aliases) so the completeness test goes green. Resolution is alias-to-canonical or define-obvious-semantic per usage evidence — never fabricated.

---

## File Structure

| File | Responsibility |
|---|---|
| `servers/gateway/dashboard/shared/design-tokens.js` (modify) | Add spacing/type/leading scales; define `--crow-text-tertiary` + `--crow-warning` per theme; add 7 compatibility aliases |
| `servers/gateway/dashboard/shared/components.js` (modify) | Add `button`/`codeBlock`/`callout`/`stepper`/`tabs`; migrate existing inline px to tokens |
| `servers/gateway/dashboard/shared/components-css.js` (create) | `componentsCss()` + `componentsJs()` for the new primitives |
| `servers/gateway/dashboard/shared/layout.js` (modify) | Inject `componentsCss()` + `componentsJs()` once into `dashboardCss()` |
| `servers/gateway/dashboard/panels/design-system.js` (create) | Read-only gallery/QA panel |
| `servers/gateway/dashboard/index.js` (modify) | Register the gallery panel |
| `docs/developers/design-system.md` (create) | Token + primitive catalogue and conventions |
| `tests/design-system.test.js` (create) | Token-completeness guard + primitive render + gallery smoke |

---

## Task 1: Token scales + resolve the 9 undefined tokens (completeness guard)

**Files:**
- Create: `tests/design-system.test.js`
- Modify: `servers/gateway/dashboard/shared/design-tokens.js`

- [ ] **Step 1: Write the failing token-completeness test**

Create `tests/design-system.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/kh0pp/crow && node --test tests/design-system.test.js`
Expected: the completeness test FAILS listing the 9 undefined tokens; the scales test FAILS (scales not defined yet).

- [ ] **Step 3: Add scales + aliases to the first `:root` block of `designTokensCss()`**

In `servers/gateway/dashboard/shared/design-tokens.js`, the first `:root { … }` block ends with `--crow-info: #38bdf8;`. Add `--crow-warning` + `--crow-text-tertiary` there (dark defaults), then a new block after it. Edit the first `:root` block to append (just before its closing `}`):

```css
    --crow-info: #38bdf8;
    --crow-warning: #f59e0b;
    --crow-text-tertiary: #8b8680;
```

Then, immediately AFTER the existing `:root { --crow-radius-card … --crow-radius-pill … }` block, add a new block:

```css
  /* Sizing scales (theme-independent) */
  :root {
    --crow-space-1: 4px;  --crow-space-2: 8px;  --crow-space-3: 12px;
    --crow-space-4: 16px; --crow-space-5: 24px; --crow-space-6: 32px;
    --crow-space-8: 48px; --crow-space-10: 64px;

    --crow-text-xs: 0.75rem;  --crow-text-sm: 0.8125rem; --crow-text-base: 0.875rem;
    --crow-text-md: 1rem;     --crow-text-lg: 1.125rem;  --crow-text-xl: 1.25rem;
    --crow-text-2xl: 1.5rem;  --crow-text-3xl: 2rem;

    --crow-leading-tight: 1.2; --crow-leading-normal: 1.5; --crow-leading-relaxed: 1.7;

    /* Compatibility aliases — legacy names used across panels. Prefer the
       canonical token (right side) in NEW code. These reference the canonical
       custom properties, so they track theme overrides automatically. */
    --crow-bg: var(--crow-bg-deep);
    --crow-background: var(--crow-bg-deep);
    --crow-surface: var(--crow-bg-surface);
    --crow-bg-card: var(--crow-bg-surface);
    --crow-text: var(--crow-text-primary);
    --crow-border-subtle: var(--crow-border);
    --crow-accent-bg: var(--crow-accent-muted);
  }
```

- [ ] **Step 4: Define `--crow-text-tertiary` + `--crow-warning` in the other theme blocks**

In `.theme-light { … }`, add before its closing `}`:
```css
    --crow-text-tertiary: #78716c;
    --crow-warning: #d97706;
```

In `.theme-glass { … }` (which already redefines `--crow-success/error/info`), add before its closing `}`:
```css
    --crow-text-tertiary: rgba(255,255,255,0.45);
    --crow-warning: #ff9f0a;
```

In `.theme-glass.theme-light { … }` (redefines text colors), add before its closing `}`:
```css
    --crow-text-tertiary: rgba(0,0,0,0.45);
```
(It inherits `--crow-warning` from `.theme-glass`; no override needed.)

- [ ] **Step 5: Run to verify both tests pass**

Run: `cd /home/kh0pp/crow && node --test tests/design-system.test.js`
Expected: PASS (2 tests). The completeness test now finds zero undefined tokens.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow
git add tests/design-system.test.js
git commit tests/design-system.test.js servers/gateway/dashboard/shared/design-tokens.js -m "F6a: token scales (spacing/type/leading) + resolve 9 undefined tokens + completeness guard"
git show --stat HEAD | head -6
```

---

## Task 2: New primitive HTML functions + render tests

**Files:**
- Modify: `servers/gateway/dashboard/shared/components.js`
- Modify: `tests/design-system.test.js` (append render tests + import)

- [ ] **Step 1: Append failing render tests**

At the TOP of `tests/design-system.test.js`, add:
```js
import { button, codeBlock, callout, stepper, tabs } from "../servers/gateway/dashboard/shared/components.js";
```

Append at the end of `tests/design-system.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/kh0pp/crow && node --test tests/design-system.test.js`
Expected: FAIL — `button`/`codeBlock`/`callout`/`stepper`/`tabs` are not exported.

- [ ] **Step 3: Add the primitives to `components.js`**

Append to `servers/gateway/dashboard/shared/components.js` (after the existing exports; `escapeHtml` is already defined at the top of the file):

```js
/**
 * Button. Renders <button> by default, or <a class="btn"> when opts.href is set.
 * @param {string} label
 * @param {{variant?: "primary"|"secondary"|"danger"|"ghost", size?: "sm"|"md",
 *   href?: string, type?: string, name?: string, value?: string, attrs?: string}} [opts]
 */
export function button(label, opts = {}) {
  const variant = opts.variant || "primary";
  const size = opts.size || "md";
  const cls = `btn btn-${variant} btn-${size}`;
  const extra = opts.attrs ? " " + opts.attrs : "";
  if (opts.href) {
    return `<a class="${cls}" href="${escapeHtml(opts.href)}"${extra}>${escapeHtml(label)}</a>`;
  }
  const type = opts.type || "button";
  const name = opts.name ? ` name="${escapeHtml(opts.name)}"` : "";
  const value = opts.value != null ? ` value="${escapeHtml(String(opts.value))}"` : "";
  return `<button class="${cls}" type="${escapeHtml(type)}"${name}${value}${extra}>${escapeHtml(label)}</button>`;
}

/**
 * Code block with a copy-to-clipboard button. Text is escaped.
 * @param {string} text
 * @param {{lang?: string}} [opts]
 */
export function codeBlock(text, opts = {}) {
  const raw = String(text == null ? "" : text);
  const langLabel = opts.lang ? `<span class="code-lang">${escapeHtml(opts.lang)}</span>` : "";
  // data-copy carries the raw text (escaped as an attribute) for the delegated
  // copy handler in componentsJs(); the visible <code> is escaped for display.
  return `<div class="code-block">
  <div class="code-block-bar">${langLabel}<button type="button" class="code-copy" data-copy="${escapeHtml(raw)}">Copy</button></div>
  <pre><code>${escapeHtml(raw)}</code></pre>
</div>`;
}

/**
 * Callout / notice. content is caller-supplied HTML (not escaped — matches
 * section()/dataTable() convention; callers escape user data).
 * @param {string} content
 * @param {"info"|"success"|"warning"|"error"} [type="info"]
 */
export function callout(content, type = "info") {
  const t = ["info", "success", "warning", "error"].includes(type) ? type : "info";
  return `<div class="callout callout-${t}">${content}</div>`;
}

/**
 * Stepper (display-only). 0-based current index.
 * @param {{label: string}[]} steps
 * @param {number} current
 */
export function stepper(steps, current = 0) {
  const items = (steps || []).map((s, i) => {
    const state = i < current ? "step-done" : i === current ? "step-active" : "step-upcoming";
    return `<li class="step ${state}"><span class="step-num">${i + 1}</span><span class="step-label">${escapeHtml(s.label || "")}</span></li>`;
  }).join("");
  return `<ol class="stepper">${items}</ol>`;
}

/**
 * Tabs. Switching handled by the delegated handler in componentsJs().
 * @param {{id: string, label: string, content: string}[]} items - content is HTML (caller-escaped)
 * @param {{active?: number}} [opts]
 */
export function tabs(items, opts = {}) {
  const list = items || [];
  const active = opts.active || 0;
  const triggers = list.map((it, i) =>
    `<button type="button" class="tab-trigger ${i === active ? "tab-active" : ""}" data-tab="${escapeHtml(it.id)}">${escapeHtml(it.label)}</button>`
  ).join("");
  const panels = list.map((it, i) =>
    `<div class="tab-panel ${i === active ? "tab-active" : ""}" data-tab-panel="${escapeHtml(it.id)}">${it.content}</div>`
  ).join("");
  return `<div class="tabs"><div class="tab-list">${triggers}</div><div class="tab-panels">${panels}</div></div>`;
}
```

- [ ] **Step 4: Run to verify the render tests pass**

Run: `cd /home/kh0pp/crow && node --test tests/design-system.test.js`
Expected: PASS (all tests — 2 from Task 1 + 5 new render tests).

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow
git commit servers/gateway/dashboard/shared/components.js tests/design-system.test.js -m "F6a: button/codeBlock/callout/stepper/tabs primitives + render tests"
git show --stat HEAD | head -6
```

---

## Task 3: Primitive CSS + JS module, injected into layout

**Files:**
- Create: `servers/gateway/dashboard/shared/components-css.js`
- Modify: `servers/gateway/dashboard/shared/layout.js`

- [ ] **Step 1: Create `components-css.js`**

Create `servers/gateway/dashboard/shared/components-css.js`:

```js
/**
 * CSS + minimal client JS for the F6a shared primitives (button, codeBlock,
 * callout, stepper, tabs). Injected once by layout.js dashboardCss(). All
 * sizing uses the token scales from design-tokens.js (no hardcoded px).
 */

export function componentsCss() {
  return `
  /* Button */
  .btn { display:inline-flex; align-items:center; gap:var(--crow-space-2);
    font-family:inherit; font-size:var(--crow-text-base); font-weight:500;
    border-radius:var(--crow-radius-pill); border:1px solid transparent;
    cursor:pointer; text-decoration:none; transition:background .15s,border-color .15s,color .15s; }
  .btn-md { padding:var(--crow-space-2) var(--crow-space-4); }
  .btn-sm { padding:var(--crow-space-1) var(--crow-space-3); font-size:var(--crow-text-sm); }
  .btn-primary { background:var(--crow-accent); color:#fff; }
  .btn-primary:hover { background:var(--crow-accent-hover); }
  .btn-secondary { background:var(--crow-bg-elevated); color:var(--crow-text-primary); border-color:var(--crow-border); }
  .btn-secondary:hover { border-color:var(--crow-accent); }
  .btn-danger { background:var(--crow-error); color:#fff; }
  .btn-danger:hover { filter:brightness(1.1); }
  .btn-ghost { background:transparent; color:var(--crow-text-secondary); }
  .btn-ghost:hover { color:var(--crow-text-primary); background:var(--crow-bg-elevated); }

  /* Code block */
  .code-block { border:1px solid var(--crow-border); border-radius:var(--crow-radius-card);
    overflow:hidden; margin:var(--crow-space-4) 0; background:var(--crow-bg-deep); }
  .code-block-bar { display:flex; align-items:center; justify-content:space-between;
    padding:var(--crow-space-2) var(--crow-space-3); background:var(--crow-bg-elevated);
    border-bottom:1px solid var(--crow-border); }
  .code-lang { font-size:var(--crow-text-xs); color:var(--crow-text-muted); text-transform:uppercase; letter-spacing:0.05em; }
  .code-copy { margin-left:auto; font-size:var(--crow-text-xs); color:var(--crow-text-secondary);
    background:transparent; border:1px solid var(--crow-border); border-radius:var(--crow-radius-pill);
    padding:var(--crow-space-1) var(--crow-space-3); cursor:pointer; }
  .code-copy:hover { color:var(--crow-text-primary); border-color:var(--crow-accent); }
  .code-block pre { margin:0; padding:var(--crow-space-3); overflow:auto;
    font-family:'JetBrains Mono',monospace; font-size:var(--crow-text-sm); line-height:var(--crow-leading-normal); }

  /* Callout */
  .callout { border-left:3px solid var(--crow-info); border-radius:var(--crow-radius-pill);
    background:var(--crow-bg-elevated); padding:var(--crow-space-3) var(--crow-space-4);
    margin:var(--crow-space-4) 0; font-size:var(--crow-text-base); line-height:var(--crow-leading-normal); }
  .callout-info { border-left-color:var(--crow-info); }
  .callout-success { border-left-color:var(--crow-success); }
  .callout-warning { border-left-color:var(--crow-warning); }
  .callout-error { border-left-color:var(--crow-error); }

  /* Stepper */
  .stepper { display:flex; gap:var(--crow-space-4); list-style:none; padding:0; margin:var(--crow-space-4) 0; flex-wrap:wrap; }
  .stepper .step { display:flex; align-items:center; gap:var(--crow-space-2); font-size:var(--crow-text-sm); color:var(--crow-text-tertiary); }
  .stepper .step-num { display:inline-flex; align-items:center; justify-content:center;
    width:24px; height:24px; border-radius:50%; border:1px solid var(--crow-border);
    font-size:var(--crow-text-xs); }
  .step-done { color:var(--crow-text-secondary); }
  .step-done .step-num { background:var(--crow-accent); color:#fff; border-color:var(--crow-accent); }
  .step-active { color:var(--crow-text-primary); font-weight:500; }
  .step-active .step-num { border-color:var(--crow-accent); color:var(--crow-accent); }

  /* Tabs */
  .tab-list { display:flex; gap:var(--crow-space-1); border-bottom:1px solid var(--crow-border); margin-bottom:var(--crow-space-4); }
  .tab-trigger { background:transparent; border:none; border-bottom:2px solid transparent;
    color:var(--crow-text-secondary); font-family:inherit; font-size:var(--crow-text-base);
    padding:var(--crow-space-2) var(--crow-space-4); cursor:pointer; }
  .tab-trigger:hover { color:var(--crow-text-primary); }
  .tab-trigger.tab-active { color:var(--crow-accent); border-bottom-color:var(--crow-accent); }
  .tab-panel { display:none; }
  .tab-panel.tab-active { display:block; }
  `;
}

/**
 * Delegated client JS for copy buttons and tab switching. Injected once;
 * idempotent under Turbo Drive via a window flag. No inline onclick.
 */
export function componentsJs() {
  return `<script>
  if (!window.__crowComponentsBound) {
    window.__crowComponentsBound = true;
    document.addEventListener("click", function (e) {
      var copy = e.target.closest("[data-copy]");
      if (copy) {
        var text = copy.getAttribute("data-copy") || "";
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () {
            var prev = copy.textContent; copy.textContent = "Copied"; setTimeout(function () { copy.textContent = prev; }, 1200);
          }).catch(function () {});
        }
        return;
      }
      var tab = e.target.closest("[data-tab]");
      if (tab) {
        var id = tab.getAttribute("data-tab");
        var root = tab.closest(".tabs");
        if (!root) return;
        root.querySelectorAll(".tab-trigger").forEach(function (t) { t.classList.toggle("tab-active", t.getAttribute("data-tab") === id); });
        root.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.toggle("tab-active", p.getAttribute("data-tab-panel") === id); });
      }
    });
  }
  </script>`;
}
```

- [ ] **Step 2: Inject into `layout.js`**

In `servers/gateway/dashboard/shared/layout.js`, add the import near the existing token import (line ~9):
```js
import { componentsCss, componentsJs } from "./components-css.js";
```

In `dashboardCss()` (the `<style>` block beginning ~line 775), add `${componentsCss()}` immediately after `${designTokensCss()}`:
```js
  ${designTokensCss()}
  ${componentsCss()}
```

The `componentsJs()` `<script>` must be emitted once per page. `dashboardCss()` returns a `<style>` block, so emit the script right after that block's closing `</style>`. **The closing `</style>` is on `layout.js:1320`** — the line reads `  </style>\`;` (the function's closing `}` is on 1321). It is NOT next to `${tamagotchiCss}` (that's line 1163; the CSS continues ~157 lines past it). There is exactly one `</style>` in `dashboardCss()`. Change that one line from:
```js
  </style>`;
```
to:
```js
  </style>${componentsJs()}`;
```
Add a one-line comment just above that line explaining the layering: `// primitives' delegated copy/tabs JS rides with the CSS so it also loads on the login/2FA/setup pages, which call dashboardCss() directly and bypass renderLayout's scripts slot.` (`dashboardCss()` is interpolated once per page across 7 distinct render functions — verified — so the script injects once per page; the `window.__crowComponentsBound` guard makes it idempotent regardless.)

- [ ] **Step 3: Verify the gateway module graph still loads + token test stays green**

Run:
```bash
cd /home/kh0pp/crow
node --input-type=module -e "import('./servers/gateway/dashboard/shared/layout.js').then(()=>console.log('layout OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
node --test tests/design-system.test.js 2>&1 | grep -E "# pass|# fail"
```
Expected: `layout OK`; tests still pass (the completeness scan now also reads `components-css.js` for defined tokens and finds all its `var(--crow-*)` usages defined — every token it uses was added in Task 1).

- [ ] **Step 4: Commit**

```bash
cd /home/kh0pp/crow
git add servers/gateway/dashboard/shared/components-css.js
git commit servers/gateway/dashboard/shared/components-css.js servers/gateway/dashboard/shared/layout.js -m "F6a: primitive CSS + delegated copy/tabs JS, injected once into dashboardCss"
git show --stat HEAD | head -6
```

---

## Task 4: Migrate `components.js` inline styles to tokens

**Files:**
- Modify: `servers/gateway/dashboard/shared/components.js`

- [ ] **Step 1: Replace hardcoded inline spacing/sizing in the EXISTING functions with tokens**

Edit only the pre-existing functions (`statGrid`, `formField`, `actionBar`, and any other existing inline px in this file — NOT the Task-2 primitives, which already use classes). Apply these exact mappings to the inline `style="…"` strings:
- `margin-bottom:1.5rem` → `margin-bottom:var(--crow-space-5)`
- `margin-bottom:1rem` → `margin-bottom:var(--crow-space-4)`
- `font-size:0.8rem` → `font-size:var(--crow-text-sm)`
- `margin-bottom:0.35rem` → `margin-bottom:var(--crow-space-1)`
- `gap:0.5rem` → `gap:var(--crow-space-2)`

**Not pixel-identical — this snaps legacy odd values onto the nearest scale step (a deliberate ≤2px shift, not "behavior-preserving"):** `0.35rem` (5.6px) → `space-1` (4px) is a −1.6px change on the `formField` label margin; `0.8rem` (12.8px) → `text-sm` (13px) is +0.2px. The other three (`1.5rem`/`1rem`/`0.5rem`) are exact. The snap is intentional (rhythm); no test asserts these pixel values.

For example, `formField`'s label line becomes:
```js
  return `<div style="margin-bottom:var(--crow-space-4)">
  <label for="${id}" style="display:block;font-size:var(--crow-text-sm);color:var(--crow-text-muted);margin-bottom:var(--crow-space-1);text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(label)}</label>
  ${input}
</div>`;
```
and `actionBar`:
```js
  return `<div style="display:flex;gap:var(--crow-space-2);margin-bottom:var(--crow-space-5);flex-wrap:wrap">${arr.join("")}</div>`;
```
and `statGrid`:
```js
  return `<div class="card-grid" style="margin-bottom:var(--crow-space-5)">${cards.join("")}</div>`;
```
Leave the `statCard` `animation:` inline style as-is (not a spacing/sizing token). Do not touch the login/2FA view functions' many inline styles in this task (those are out of the foundation-migration scope — only the reusable component helpers: statGrid/formField/actionBar/section if applicable).

- [ ] **Step 2: Verify tests + token completeness still green**

Run: `cd /home/kh0pp/crow && node --test tests/design-system.test.js 2>&1 | grep -E "# pass|# fail"`
Expected: PASS (all token tokens used are defined — `--crow-space-*`/`--crow-text-sm` were added in Task 1).

- [ ] **Step 3: Commit**

```bash
cd /home/kh0pp/crow
git commit servers/gateway/dashboard/shared/components.js -m "F6a: migrate shared component helpers off hardcoded px onto tokens"
git show --stat HEAD | head -6
```

---

## Task 5: Gallery panel + registration + smoke test

**Files:**
- Create: `servers/gateway/dashboard/panels/design-system.js`
- Modify: `servers/gateway/dashboard/index.js`
- Modify: `tests/design-system.test.js` (append smoke test)

- [ ] **Step 1: Append the failing gallery smoke test**

At the TOP of `tests/design-system.test.js`, add:
```js
import designSystemPanel from "../servers/gateway/dashboard/panels/design-system.js";
```
Append at the end:
```js
test("design-system gallery panel renders all primitives without throwing", async () => {
  // layout stub: return the content so we can assert primitives are present
  const layout = ({ content }) => content;
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/kh0pp/crow && node --test tests/design-system.test.js`
Expected: FAIL — cannot import `../servers/gateway/dashboard/panels/design-system.js`.

- [ ] **Step 3: Create the gallery panel**

Create `servers/gateway/dashboard/panels/design-system.js`:

```js
/**
 * Design System gallery — a read-only QA surface that renders every token and
 * primitive with the real layout + tokens. The living reference for F6b/F6c
 * and theme work.
 */
import { section, badge, statCard, statGrid, dataTable, formField,
  button, codeBlock, callout, stepper, tabs } from "../shared/components.js";

const SPACES = ["1", "2", "3", "4", "5", "6", "8", "10"];
const SIZES = ["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl"];
const COLORS = ["bg-deep", "bg-surface", "bg-elevated", "border", "text-primary",
  "text-secondary", "text-tertiary", "text-muted", "accent", "brand-gold",
  "success", "error", "warning", "info"];

function swatches() {
  return `<div style="display:flex;flex-wrap:wrap;gap:var(--crow-space-3)">` +
    COLORS.map((c) => `<div style="text-align:center;font-size:var(--crow-text-xs)">
      <div style="width:56px;height:56px;border-radius:var(--crow-radius-card);border:1px solid var(--crow-border);background:var(--crow-${c})"></div>
      <div style="margin-top:var(--crow-space-1);color:var(--crow-text-muted)">${c}</div></div>`).join("") +
    `</div>`;
}

function spacingScale() {
  return SPACES.map((s) => `<div style="display:flex;align-items:center;gap:var(--crow-space-3);margin-bottom:var(--crow-space-1)">
    <code style="width:7ch;font-size:var(--crow-text-xs)">space-${s}</code>
    <div style="height:12px;width:var(--crow-space-${s});background:var(--crow-accent);border-radius:2px"></div></div>`).join("");
}

function typeScale() {
  return SIZES.map((s) => `<div style="font-size:var(--crow-text-${s});line-height:var(--crow-leading-normal)">text-${s} — The quick brown crow</div>`).join("");
}

export default {
  id: "design-system",
  name: "Design System",
  icon: "skills",
  route: "/dashboard/design-system",
  navOrder: 95,
  category: "tools",
  hidden: true, // QA/reference surface — reachable by URL, not shown in every user's sidebar

  async handler(req, res, { layout }) {
    const content =
      section("Colors", swatches()) +
      section("Spacing scale", spacingScale()) +
      section("Type scale", typeScale()) +
      section("Buttons", [
        button("Primary", { variant: "primary" }),
        button("Secondary", { variant: "secondary" }),
        button("Danger", { variant: "danger" }),
        button("Ghost", { variant: "ghost" }),
        button("Small", { variant: "primary", size: "sm" }),
        button("Link", { href: "#", variant: "secondary" }),
      ].join(" ")) +
      section("Callouts",
        callout("Informational notice.", "info") +
        callout("Success — it worked.", "success") +
        callout("Warning — check this.", "warning") +
        callout("Error — something failed.", "error")) +
      section("Code block", codeBlock('{\n  "mcpServers": { "crow": { "url": "https://crow.example/router/mcp" } }\n}', { lang: "json" })) +
      section("Stepper", stepper([{ label: "Welcome" }, { label: "Integrations" }, { label: "Connect" }, { label: "Done" }], 1)) +
      section("Tabs", tabs([
        { id: "cc", label: "Claude Code", content: codeBlock("claude mcp add crow ...", { lang: "sh" }) },
        { id: "web", label: "claude.ai", content: callout("Connect via Settings → Connectors.", "info") },
        { id: "oc", label: "opencode", content: "<p>opencode config snippet.</p>" },
      ])) +
      section("Existing primitives",
        statGrid([statCard("Memories", "128"), statCard("Bots", "4")]) +
        `<div style="margin:var(--crow-space-4) 0">${badge("active", "active")} ${badge("draft", "draft")}</div>` +
        dataTable(["Name", "Type"], [["alpha", "bundle"], ["beta", "mcp-server"]]) +
        `<div style="margin-top:var(--crow-space-4)">${formField("Example field", "demo", { placeholder: "type here" })}</div>`);

    return layout({ title: "Design System", content });
  },
};
```

- [ ] **Step 4: Register the panel in `index.js`**

In `servers/gateway/dashboard/index.js`, add the import alongside the other panel imports (near line 64-70):
```js
import designSystemPanel from "./panels/design-system.js";
```
And register it alongside the other `registerPanel(...)` calls (near line 90-98):
```js
  registerPanel(designSystemPanel);
```

- [ ] **Step 5: Run tests + boot-graph check**

Run:
```bash
cd /home/kh0pp/crow
node --test tests/design-system.test.js 2>&1 | grep -E "# pass|# fail"
node --input-type=module -e "import('./servers/gateway/dashboard/index.js').then(()=>console.log('index OK')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: all design-system tests PASS; `index OK`.

- [ ] **Step 6: Commit**

```bash
cd /home/kh0pp/crow
git add servers/gateway/dashboard/panels/design-system.js
git commit servers/gateway/dashboard/panels/design-system.js servers/gateway/dashboard/index.js tests/design-system.test.js -m "F6a: design-system gallery panel (live token + primitive reference) + smoke test"
git show --stat HEAD | head -6
```

---

## Task 6: Documentation

**Files:**
- Create: `docs/developers/design-system.md`

- [ ] **Step 1: Write the doc**

Create `docs/developers/design-system.md`:

```markdown
# Design System

The dashboard's design system: CSS custom-property **tokens** + shared HTML **primitives**. Live reference: the **Design System** panel at `/dashboard/design-system`.

## Where things live

- Tokens: `servers/gateway/dashboard/shared/design-tokens.js` (`designTokensCss()`).
- Primitive HTML: `servers/gateway/dashboard/shared/components.js`.
- Primitive CSS + client JS: `servers/gateway/dashboard/shared/components-css.js` (injected once by `layout.js`).
- Gallery panel: `servers/gateway/dashboard/panels/design-system.js`.

## Tokens

**Color** (per theme — dark/light/glass): `--crow-bg-deep|bg-surface|bg-elevated|border`, `--crow-text-primary|secondary|tertiary|muted`, `--crow-accent|accent-hover|accent-muted`, `--crow-brand-gold`, `--crow-success|error|warning|info`.

**Spacing** (4px base): `--crow-space-1`(4px) `-2`(8) `-3`(12) `-4`(16) `-5`(24) `-6`(32) `-8`(48) `-10`(64).

**Type**: `--crow-text-xs`(.75rem) `-sm`(.8125) `-base`(.875) `-md`(1) `-lg`(1.125) `-xl`(1.25) `-2xl`(1.5) `-3xl`(2).

**Line-height**: `--crow-leading-tight`(1.2) `-normal`(1.5) `-relaxed`(1.7).

**Radius**: `--crow-radius-card`, `--crow-radius-pill`.

**Compatibility aliases** (legacy names; prefer the canonical token on the right in new code): `--crow-bg`→`bg-deep`, `--crow-background`→`bg-deep`, `--crow-surface`→`bg-surface`, `--crow-bg-card`→`bg-surface`, `--crow-text`→`text-primary`, `--crow-border-subtle`→`border`, `--crow-accent-bg`→`accent-muted`.

## Primitives

| Function | Use |
|---|---|
| `button(label, {variant,size,href,type,name,value,attrs})` | Buttons/links. variant: primary\|secondary\|danger\|ghost; size: sm\|md. `href` → `<a>`. |
| `codeBlock(text, {lang})` | Monospace block with a copy-to-clipboard button. Text is escaped. |
| `callout(content, type)` | info\|success\|warning\|error notice. `content` is caller-supplied HTML (escape user data). |
| `stepper(steps, current)` | Display-only numbered progress. `steps`=`[{label}]`, `current` 0-based. |
| `tabs(items, {active})` | `items`=`[{id,label,content}]`. Client-side switching. |
| `statCard`/`statGrid`/`dataTable`/`formField`/`badge`/`actionBar`/`section` | Pre-existing helpers. |

Example:
\`\`\`js
import { button, callout, codeBlock } from "../shared/components.js";
callout(`Run ${button("Connect", { href: "/dashboard/connect" })}`, "info");
codeBlock(JSON.stringify(cfg, null, 2), { lang: "json" });
\`\`\`

## Convention

New dashboard UI **uses tokens** (`var(--crow-space-*)`, `var(--crow-text-*)`, color tokens) and the shared **primitives** — not hardcoded px or bespoke buttons. A test (`tests/design-system.test.js`) fails CI if any `var(--crow-*)` token is used but undefined. Full migration of every legacy panel's inline styles is out of scope (done opportunistically when touching a panel).
```

- [ ] **Step 2: Sanity-check + commit**

Run: `cd /home/kh0pp/crow && grep -c "Compatibility aliases" docs/developers/design-system.md`
Expected: `2` (heading mention + table). Then:
```bash
cd /home/kh0pp/crow
git add docs/developers/design-system.md
git commit docs/developers/design-system.md -m "F6a: document the design system (tokens, primitives, conventions)"
git show --stat HEAD | head -6
```

---

## Final verification

- [ ] **Full suite + module-graph + token guard**

```bash
cd /home/kh0pp/crow
node --test tests/design-system.test.js 2>&1 | tail -6        # all pass
node --test tests/auth-network.test.js 2>&1 | grep -E "# pass|# fail"   # no regression
node --input-type=module -e "import('./servers/gateway/dashboard/index.js').then(()=>console.log('dashboard index OK'))"
```
Expected: design-system tests all pass; auth-network unchanged; dashboard index imports clean.

- [ ] **Holistic review** — per subagent-driven-development, run the final holistic code review across all F6a commits before considering the branch done.

---

## Notes for the implementer

- **Commits:** `git commit <explicit paths>` (parallel sessions share the tree); `git add <path>` first for new files. Verify `git show --stat HEAD`. Never attribute Claude / add a co-author trailer.
- **No init-db, no routes** beyond the standard read-only panel registration. Deploy (later) = pull + restart gateways so the new CSS/JS/panel load (CSS is injected at render, but `componentsJs()`/`componentsCss()` are imported at module load, and the panel registers at startup → a restart is needed for those, unlike F4b's per-request registry).
- **Scope guard:** do NOT refactor other panels' `<style>` blocks or inline styles (explicit non-goal). Task 4 touches only the reusable helpers in `components.js`.
- **CSS has no unit test** — the gallery panel + manual theme check (dark/light/glass) is the visual QA. The token-completeness test is the automated guard.
- **Expected benign rendering changes during manual QA (not regressions):** resolving the 7 aliases in Task 1 changes a few panels that today rely on inline fallbacks — e.g. `integrations.js` input bg (`var(--crow-background,#111)` → theme `bg-deep`, which *fixes* a wrong dark `#111` in light theme), `files.js` `--crow-bg-card`, `nav-groups.js` `--crow-border-subtle`, `extensions.js` `--crow-warning`. All map to theme-correct tokens; verify they look right across themes but don't treat the shift as a bug.
```

---

## Review

**Reviewer:** staff-engineer plan-reviewer subagent (adversarial). **Date:** 2026-06-10. **Verdict:** APPROVE (with minor fixes) — fixes applied below.

The reviewer independently re-verified the load-bearing claims against the real repo: the token-completeness algorithm works; the 9-undefined-token list is exactly correct (re-scanned: 9, simulated post-Task-1: 0); the alias regex defines `--crow-bg` without mis-counting the inner `var(--crow-bg-deep)`; `blog-public.js` defines zero tokens (no false positives); `componentsCss()` uses 23 tokens all defined by Task 1 (no committed-red); `dashboardCss()` injects once per page across 7 distinct render functions; the panel handler contract (`return layout({title,content})` + dispatcher at index.js:780-806) matches; and `data-copy` is XSS-safe (escaped attribute, value read as plain string).

Fixes applied:
- **C1** — Task 3 Step 2 injection instruction corrected: the real closing `</style>` is `layout.js:1320`, not next to `${tamagotchiCss}` (1163); added the explanatory comment (S1).
- **C2** — corrected the false "behavior-preserving" claim (spec + Task 4): the migration snaps two legacy odd values (`0.35rem`→space-1, `0.8rem`→text-sm) with a deliberate ≤2px shift; the other three are exact.
- **S2** — gallery panel set `hidden: true` (QA surface, URL-reachable, not in every sidebar).
- **S4** — added a manual-QA note listing the benign alias-resolution rendering changes (integrations input bg, files card, nav-groups border, extensions warning) so they aren't mistaken for regressions.
- **Q1** — dropped the unused `escapeHtml` import from the gallery panel.
- **S3** (icon collision with Skills panel) — accepted as-is: cosmetic only, and reusing the known-valid `"skills"` icon avoids risking an invalid icon key.
