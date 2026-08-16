# Track 2 Visual Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard adopts the Perch-derived visual language — Crow-owned Perch tokens with a
drift gate, a light-first OS-driven palette, glass fully retired, the 11 primitives and every
bypass on tokens — with the public blog frozen on the old look until its own wave, plus the two
product fixes (Perch unattached guidance, tracker tags).

**Architecture:** Ownership flip first (PERCH_TOKENS + drift test, no payload change). Then the
freeze (legacy token snapshot for blog/songbook/kb-public) BEFORE the value rewrite so nothing
leaks. Then the rewrite (light-first `:root` + `prefers-color-scheme` dark), theme-state removal,
glass retirement + settings migration, font delivery, and the grep-driven bypass sweeps. W4 product
fixes ride at the end.

**Tech Stack:** Node 22, node:test, vanilla JS server-rendered dashboard (no framework), CSS custom
properties.

**Spec:** `docs/superpowers/specs/2026-08-15-track2-visual-language-design.md` — the authority;
two adversarial rounds' constraints live in its Review record. The §3.2 token table and §3.2.1
contrast policy are BINDING exact values.

## Global Constraints

- Suite floor 3380/0. Mutation-test every new test; restore by EDIT, never git checkout.
- Worktree `~/crow-wt-track2` (branch `feat/track2-visual-language`, base ab250eeb). Node 22:
  `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH`.
- NEVER boot any server/script without BOTH scratch CROW_HOME and CROW_DATA_DIR — bare runs hit
  the LIVE primary db.
- Positional-path commits (`git commit <paths> -m "..."`); verify `git show --stat HEAD`; never
  mention Claude / no Co-Authored-By.
- Token NAMES never change (value rewrite); the only NEW names are `--crow-accent-contrast`,
  `--crow-radius-control`, `--crow-border-strong`, `--crow-mono-font`.
- The frozen public surfaces (`blog-public.js`, `songbook-renderer.js`, `kb-public.js`) are NEVER
  swept — they read `design-tokens-legacy.js` after Task 2 and keep legacy values/fonts/radii.
- Panel client scripts are template-literal emissions: NO literal backticks, escape sequences
  double-escaped (`\\n`). `tests/board-panel-config.test.js` guards bot-board; be equally careful
  in extensions/client.js, bot-builder/engine-gate-client.js, messages/client.js.
- New/changed UI strings: EN + ES via `servers/gateway/dashboard/shared/i18n.js`
  (`{ en, es }`, parity-tested by `tests/i18n-global-parity.test.js` — es ≠ en unless allowlisted).
- The spec's §3.2 table values are exact — copy them, never re-derive.
- Dev/review mode flipping = browser DevTools `prefers-color-scheme` emulation; no product toggle.

---

### Task 1: The ownership flip — PERCH_TOKENS + drift test (W1)

**Files:**
- Modify: `servers/gateway/dashboard/shared/design-tokens.js` (add export only — NO value changes here)
- Test: `tests/perch-token-drift.test.js` (new)

**Interfaces:**
- Produces: `export const PERCH_TOKENS = { light: {...10 keys...}, dark: {...8 keys...} }` —
  camelCase keys `sky, card, ink, dim, teal, tealSoft, wire, alive, attn, line` (dark omits
  `alive`, `attn`); values are the exact hex strings from the spec §1 table.

- [ ] **Step 1: Write the failing test.** `tests/perch-token-drift.test.js`, node:test. Read
  `bundles/perch-hub/payload/hub/server.mjs` as TEXT (never import it). Extract the light block
  with a regex for `:root{...}` and the dark block for
  `@media (prefers-color-scheme:dark){:root{...}}` (the payload writes them without spaces —
  verify against the file and anchor the regex to tolerate whitespace variants). Parse
  `--name:value` pairs (split on `;`, then first `:`). Map camelCase↔kebab (`tealSoft` ↔
  `teal-soft`). Assertions:
  1. every `PERCH_TOKENS.light` entry appears in the light block with the exact value;
  2. every `PERCH_TOKENS.dark` entry appears in the dark block with the exact value;
  3. the dark block declares NO property missing from `PERCH_TOKENS.dark` (alive/attn must stay
     inherited);
  4. the light block declares NO property missing from `PERCH_TOKENS.light`;
  5. payload-wide sweep: for every file under `bundles/perch-hub/payload/` (recursive), no
     CSS-custom-property DEFINITION (`/--[a-z-]+\s*:/` in CSS contexts) exists outside the two
     PERCH_CSS blocks of `hub/server.mjs` — implement as: count definitions per file; only
     `hub/server.mjs` may have any, and its total must equal light+dark counts.
- [ ] **Step 2: Run it — expect FAIL** (`PERCH_TOKENS` is not exported yet):
  `node --test tests/perch-token-drift.test.js`.
- [ ] **Step 3: Implement.** Append to `design-tokens.js`:
  ```js
  // Decision 15 (Track 2): Crow is the authority for the Perch palette. The vendored
  // perch-hub payload must match these values exactly — tests/perch-token-drift.test.js
  // fails CI on any drift, in either direction. Changing a value here REQUIRES the
  // pi-lab edit + scripts/vendor-perch.mjs re-pin dance to land in the same PR.
  export const PERCH_TOKENS = {
    light: { sky: "#eef1f3", card: "#fff", ink: "#22303a", dim: "#6b7c88",
             teal: "#0e6b62", tealSoft: "#dcecea", wire: "#94a4ae",
             alive: "#2fa36b", attn: "#d1633e", line: "#dde4e8" },
    dark:  { sky: "#131a1f", card: "#1b242b", ink: "#e4ebef", dim: "#8fa0ab",
             teal: "#4fbdb0", tealSoft: "#16322f", wire: "#46565f", line: "#2a353d" },
  };
  ```
- [ ] **Step 4: Green.** Same command, all pass.
- [ ] **Step 5: Mutation-test.** Change `teal` to `#0e6b63` → test must fail; restore by EDIT.
  Also temporarily add `--x:#000` to a comment-free spot in `bots-page.mjs`'s BOTS_CSS → sweep
  assertion must fail; restore by EDIT.
- [ ] **Step 6: Commit** `servers/gateway/dashboard/shared/design-tokens.js tests/perch-token-drift.test.js`.

### Task 2: The freeze — legacy snapshot for public surfaces (W2, first half)

**Files:**
- Create: `servers/gateway/dashboard/shared/design-tokens-legacy.js`
- Modify: `servers/gateway/routes/blog-public.js` (:20 import), `servers/blog/songbook-renderer.js`
  (:16 import + its 3 emit sites), `bundles/knowledge-base/routes/kb-public.js` (:27–41 dynamic
  import + fallback)
- Test: `tests/design-tokens-freeze.test.js` (new)

**Interfaces:**
- Produces: `export const LEGACY_FONT_IMPORT` and `export function legacyDesignTokensCss()` —
  byte-for-byte today's `FONT_IMPORT` / `designTokensCss()` output MINUS the `.theme-glass` and
  `.theme-glass.theme-light` blocks (design-tokens.js:80–119). Everything else identical
  (dark-first `:root`, `.theme-light`, `.theme-serif`, scales, aliases).

- [ ] **Step 1: Create the legacy module.** Copy the current `design-tokens.js` content into
  `design-tokens-legacy.js`; rename exports to `LEGACY_FONT_IMPORT`/`legacyDesignTokensCss`;
  delete the two glass blocks; add a header comment: frozen snapshot for the public
  blog/songbook/kb until the blog wave — do not edit values here, delete this file in that wave.
  Do not export PERCH_TOKENS from it.
- [ ] **Step 2: Failing freeze test.** `tests/design-tokens-freeze.test.js`:
  ```js
  import { legacyDesignTokensCss, LEGACY_FONT_IMPORT } from ".../design-tokens-legacy.js";
  import { designTokensCss } from ".../design-tokens.js";
  // 1. legacy carries the old ground and not the new one
  assert.ok(legacyDesignTokensCss().includes("#0f0f17"));
  assert.ok(!legacyDesignTokensCss().includes("#eef1f3"));
  // 2. legacy has no glass
  assert.ok(!legacyDesignTokensCss().includes("theme-glass"));
  // 3. the CURRENT module still carries the old ground — this assertion INVERTS in Task 3
  //    (written now so the file exists; Task 3 flips it to the new-ground pin)
  // 4. blog-public.js and songbook-renderer.js source text import the legacy module,
  //    and do NOT import designTokensCss from design-tokens.js (read both files as text)
  ```
  (Assertion 3 in this task: `designTokensCss().includes("#0f0f17")` — Task 3 flips it.)
- [ ] **Step 3: FAIL** (imports not yet switched), then **switch the imports**: `blog-public.js:20`
  → `import { LEGACY_FONT_IMPORT as FONT_IMPORT, legacyDesignTokensCss as designTokensCss } from
  "../dashboard/shared/design-tokens-legacy.js";` (alias-import keeps the rest of the file
  untouched); same shape in `songbook-renderer.js:16`. `kb-public.js`: point the dynamic-import
  path resolution at `design-tokens-legacy.js` AND rename the property accesses (plan-review
  finding 3 — `:35–36` read `tokens.FONT_IMPORT`/`tokens.designTokensCss`, which would become
  `undefined` WITHOUT throwing, so the catch never fires): they become
  `tokens.LEGACY_FONT_IMPORT`/`tokens.legacyDesignTokensCss`. Replace the silent hardcoded
  fallback (:40) with `console.error("[kb-public] legacy design tokens unavailable — serving
  unstyled", err)` + a minimal neutral CSS string (system font, black-on-white) so failure is
  LOUD. Extend the freeze test's text-check to kb-public (imports legacy path + accesses the
  legacy names).
- [ ] **Step 4: Green** `node --test tests/design-tokens-freeze.test.js`; also run any existing
  blog/songbook tests: `grep -l "blog-public\|songbook" tests/ -r` → run those files.
- [ ] **Step 5: Mutation-test** (point blog-public back at design-tokens.js → test 4 fails;
  restore by EDIT). **Step 6: Commit** all five files.

### Task 3: The token rewrite + glass CSS deletion + gallery (W2, second half)

**Files:**
- Modify: `servers/gateway/dashboard/shared/design-tokens.js` (full rewrite of the CSS string;
  PERCH_TOKENS export from Task 1 stays), `servers/gateway/dashboard/panels/design-system.js`,
  `tests/design-system.test.js`, `tests/design-tokens-freeze.test.js` (flip assertion 3),
  AND — plan-review finding 1: glass token DEFINITIONS and CONSUMERS must fall in the same task
  or `tests/design-system.test.js`'s undefined-token walk fails at the task boundary — every
  glass CSS consumer and read: `servers/gateway/dashboard/shared/layout.js` (:1265–1298 glass
  rules), `servers/gateway/dashboard/panels/extensions/css.js` (:398–417),
  `servers/gateway/dashboard/settings/menu-renderer.js` (:179–181),
  `servers/gateway/routes/blog-public.js` (:83 `themeGlass` read, :299–318 glass rules, :332
  class composition), `servers/gateway/routes/songbook.js` (:29 read),
  `servers/blog/songbook-renderer.js` (glass rules + class-composition sites :306, :474, :587)

**Interfaces:**
- Produces: `designTokensCss()` now emits: light values on `:root`, dark inside
  `@media (prefers-color-scheme: dark) { :root { ... } }`. All existing token names, the legacy
  aliases (:68–78) verbatim, PLUS `--crow-accent-contrast`, `--crow-radius-control: 10px`,
  `--crow-border-strong`, `--crow-mono-font: 'JetBrains Mono', monospace`. NO `.theme-light`,
  `.theme-serif`, `.theme-glass` blocks. `FONT_IMPORT` export REMAINS for now (Task 6 retires it
  from the dashboard) but its value updates to Inter + JetBrains Mono only.

- [ ] **Step 1: Failing tests.** In `tests/design-system.test.js`: add the new-ground pin
  (`designTokensCss()` contains `#eef1f3` on `:root` and `#131a1f` inside the dark media block);
  add `--crow-accent-contrast`, `--crow-radius-control`, `--crow-border-strong` to the must-exist
  name list (:70–73 area). Flip freeze-test assertion 3 to
  `assert.ok(designTokensCss().includes("#eef1f3") && !designTokensCss().includes("#0f0f17"))`.
- [ ] **Step 2: FAIL**, then **rewrite the token CSS** with the spec §3.2 table EXACTLY:

  `:root` (light): bg-deep `#eef1f3`, bg-surface `#ffffff`, bg-elevated `#f5f7f8`, border
  `#dde4e8`, border-strong `#94a4ae`, text-primary `#22303a`, text-secondary `#5c6d79`,
  text-tertiary `#6b7c88`, text-muted `#8395a1`, accent `#0e6b62`, accent-hover `#0b574f`,
  accent-muted `#dcecea`, accent-contrast `#ffffff`, success `#1d7048`, error `#b04a2b`, warning
  `#8f5606`, info `#33688c`, brand-gold `#8f5606`.

  `@media (prefers-color-scheme: dark) { :root {` bg-deep `#131a1f`, bg-surface `#1b242b`,
  bg-elevated `#232e36`, border `#2a353d`, border-strong `#46565f`, text-primary `#e4ebef`,
  text-secondary `#8fa0ab`, text-tertiary `#7d8f9a`, text-muted `#5f707b`, accent `#4fbdb0`,
  accent-hover `#6fd0c4`, accent-muted `#16322f`, accent-contrast `#131a1f`, success `#2fa36b`,
  error `#d1633e`, warning `#d9a521`, info `#6aa9cc`, brand-gold `#d9a521` `} }`.

  Radius: card `14px`, control `10px` (new), pill stays `8px` IN THIS TASK (Task 7's triage
  re-values it to `999px` after the consumer sweep — a temporary two-commit state inside one PR
  is fine; note it in the commit message). Spacing/type scales and leading unchanged.
  `--crow-body-font: 'Inter', system-ui, sans-serif` on `:root` (no serif block).
  `--crow-mono-font: 'JetBrains Mono', monospace`. Aliases block verbatim. Delete `.theme-light`,
  `.theme-serif`, both glass blocks. `FONT_IMPORT` → the css2 URL for
  `Inter:wght@400;500;600;700` + `JetBrains+Mono:wght@400;600`.
  **In the same step, delete every glass CSS consumer** (the Files list above): the `.theme-glass`
  rule blocks in `layout.js`/`extensions/css.js`/`menu-renderer.js`/`blog-public.js`/
  `songbook-renderer.js`, the `themeGlass` read fields (`blog-public.js:83`, `songbook.js:29`)
  and their class-composition uses (`blog-public.js:332`, songbook-renderer ×3) — after this
  task, `var(--crow-glass-*)`/`--crow-bg-popup`/`--crow-border-popup` have zero consumers AND
  zero definitions, so the design-system undefined-token walk stays green.
- [ ] **Step 3: Green** `node --test tests/design-system.test.js tests/design-tokens-freeze.test.js
  tests/perch-token-drift.test.js tests/a11y-baseline.test.js`.
- [ ] **Step 4: Gallery.** `panels/design-system.js`: add `accent-contrast`, `border-strong` to
  the `COLORS` array; add a radius row demoing the three radius tokens; add a mono-font sample
  line; add a button-on-accent demo (`background:var(--crow-accent);color:var(--crow-accent-contrast)`).
  Re-run the design-system test (it renders the handler).
- [ ] **Step 5: Mutation + commit** (mutate ground hex → pin test fails; restore). Commit the four
  files.

### Task 4: Theme-state removal (dashboard has no theme)

**Files:**
- Modify: `servers/gateway/dashboard/shared/layout.js` (:138 class composition; :254–256 toggle
  button; :277–289 `toggleTheme()`; :879 noise texture), `servers/gateway/dashboard/index.js`
  (:849–864 theme reads → stop passing theme/glass/serif into renderLayout; remove those params
  from `renderLayout`'s signature usage)
- Delete: `servers/gateway/shared/theme-resolver.js`
- Test: extend `tests/design-tokens-freeze.test.js` or a small new `tests/dashboard-no-theme-state.test.js`

- [ ] **Step 1: Failing test** (`tests/dashboard-no-theme-state.test.js`): walk the WHOLE
  `servers/gateway/dashboard/` tree as text (plan-review finding 7 — a two-file check misses
  `panels/nest/css.js`'s three `.theme-light` rules at :29, :109, :229) — assert no
  `theme-light`, no `toggleTheme`, no `theme_glass`, no `theme_serif` reads; assert
  `theme-resolver.js` does not exist (`fs.existsSync` false); assert layout.js has no
  `fractalNoise`/noise-SVG overlay.
- [ ] **Step 2: FAIL → implement.** `layout.js`: body class becomes static (drop the
  theme/glass/serif class interpolation at :138); delete the toggle button markup and
  `toggleTheme()`; delete the noise-texture rule (:880). `panels/nest/css.js`: fold its three
  `.theme-light` rules into base + dark-media form (their light intent becomes the `:root`
  default; any dark-specific counterpart moves into the media block) or delete where the base
  rule already covers it. `dashboard/index.js`: delete the `blog_theme_%` read block (:849–864)
  and pass no theme params. Delete `servers/gateway/shared/theme-resolver.js` (verified zero
  importers). Sweep: `grep -rn "theme-resolver" servers/ bundles/` → empty.
- [ ] **Step 3: Green** — new test + `node --test tests/design-system.test.js` + boot check:
  `CROW_HOME=$(mktemp -d) CROW_DATA_DIR=$(mktemp -d) node servers/gateway/index.js --no-auth`
  starts clean (ctrl-C; scratch env MANDATORY).
- [ ] **Step 4: Mutation + commit.**

### Task 5: Glass retirement — settings section, MCP, migration, init-db

(The glass CSS blocks, class composition, and `themeGlass` reads were deleted in Task 3 —
plan-review finding 1. This task owns everything else glass.)

**Files:**
- Modify: `servers/gateway/dashboard/settings/sections/theme.js` (section end state — NOTE the
  `set_kiosk` handler at :106–110 SURVIVES the rewrite untouched, plan-review finding 9),
  `servers/blog/server.js` (MCP params), `servers/gateway/tool-manifests.js` (:86),
  `scripts/init-db.js` (:2326–2374 dashboard_theme branch), `servers/gateway/boot/admin-api.js`
  (:59–60 area — invoke the new migration), `servers/gateway/dashboard/shared/i18n.js` (relabel
  keys), `tests/instance-scope-cleanups.test.js` (delete case D4 only)
- Create: `servers/gateway/dashboard/settings/migrations/theme-keys-migration.js`
- Test: `tests/theme-glass-retirement.test.js` (new)

- [ ] **Step 1: Failing tests** (`tests/theme-glass-retirement.test.js`):
  1. Orphan grep as a test: walk `servers/` + `bundles/` (skip `design-tokens-legacy.js`? NO —
     legacy has no glass either; skip nothing but `docs/`), assert no line matches
     `/crow-glass-blur|crow-bg-popup|crow-border-popup|theme-glass|theme_glass|themeGlass/`.
  2. Migration behavior on a scratch db (init a scratch schema via `scripts/init-db.js` with
     scratch CROW_HOME+CROW_DATA_DIR): seed `blog_theme_glass`, `blog_theme_dashboard_mode`,
     `dashboard_theme`, `blog_theme`, `blog_theme_mode`, `blog_theme_serif` rows into BOTH
     `dashboard_settings` and `dashboard_settings_overrides` (two fake instance_ids) → run the
     migration → the four retired keys gone from both tables/all instances; `blog_theme_mode` +
     `blog_theme_serif` intact; guard flag set; second run no-ops.
  3. init-db non-resurrection: with a `dashboard_theme` legacy row **whose value is `'light'`**
     (plan-review finding 4 — the branch at init-db.js:2362–2368 only mints on `'light'`; any
     other seed value makes this test vacuously green) and NO `blog_theme_mode`, run init-db
     (scratch env) → no `blog_theme_dashboard_mode` appears.
- [ ] **Step 2: FAIL → implement.**
  - `theme.js` → "Blog theme": keep Color Mode (`blog_theme_mode`), blog override
    (`blog_theme_blog_mode`), Serif Headings (`blog_theme_serif`); delete Glass checkbox + shim +
    Dashboard Override + `set_theme`/`set_theme_mode` handlers + glass in `getPreview`. Relabel
    via i18n keys (`settings.section.blogTheme` en "Blog theme" / es "Tema del blog" — check the
    existing section-label key mechanism in `settings-i18n-section-labels.test.js` and follow it).
  - Delete test case D4 in `tests/instance-scope-cleanups.test.js` (D5 stays).
  - `servers/blog/server.js`: drop `theme_glass` (zod :456, get :478, display :481, set :509) and
    `theme_dashboard_mode` (zod :459, set :512); in the deprecated `theme` alias handler
    (:495–505) delete the `updates.push(["blog_theme", theme])` line (:504), keep
    `theme_mode`/`theme_serif` mappings. Update `tool-manifests.js:86` params string.
  - `theme-keys-migration.js`: follow `llm-settings-migration.js`'s export shape; delete the four
    keys from both tables (all instance_ids); guard-flag key e.g.
    `theme_keys_migration_v1_done`. Wire the dynamic import + run beside the llm migration in
    `boot/admin-api.js:59–60`.
  - `scripts/init-db.js:2326–2374`: remove the `dashboard_theme` → `blog_theme_dashboard_mode`
    re-mint branch (keep whatever else the block does for `blog_theme`→`blog_theme_mode` ONLY if
    it cannot resurrect deleted keys — read the block; the spec's requirement is precisely
    "non-resurrecting").
- [ ] **Step 3: Green** — new test + `node --test tests/instance-scope-cleanups.test.js
  tests/i18n-global-parity.test.js tests/settings-i18n-section-labels.test.js` + any
  blog-settings/MCP tests (`grep -rl crow_blog_settings tests/`).
- [ ] **Step 4: Mutation + commit** (make the migration skip overrides table → test 2 fails).

### Task 6: Font delivery — one manifest, Inter everywhere in the dashboard

**Files:**
- Modify: `servers/gateway/dashboard/shared/layout.js` (7 `<link>` sites :225,:629,:668,:706,
  :744,:784,:822 + the `FONT_IMPORT` `@import` at :867 + 13 DM Sans hardcodes incl. :875 body,
  :1102, :1133), `servers/gateway/dashboard/shared/components.js` (:114 section heading),
  the remaining DM Sans files (`panels/extensions/css.js`, `notifications.js`, `panels/blog.js`,
  `messages/css.js`, `model-catalog.js`), and the FULL Fraunces grep set (spec §4.2 — dashboard
  tree + bundle panels; client-script sites need double-escape care)
- Test: `tests/dashboard-fonts.test.js` (new)

- [ ] **Step 1: Failing test**: (a) `layout.js` text contains exactly ONE fonts.googleapis URL
  constant (a shared `FONT_LINKS` export) and no `@import url('https://fonts` in `layout.js` OR
  `design-tokens.js` (scope pinned to those two files — `design-tokens-legacy.js` lives in the
  same dir and permanently carries the legacy `@import`, plan-review finding 8); (b) the URL
  names Inter and JetBrains Mono and NOT DM Sans/Fraunces; (c) grep-as-test: no `'DM Sans'`
  anywhere under `servers/gateway/dashboard/` (note: `servers/gateway/routes/calls-page.js` also
  hardcodes DM Sans — it is OUTSIDE this scope deliberately: a self-contained page with no token
  sheet; Task 7 moves its font to `system-ui` during its recolor, finding 12);
  (d) `Fraunces` appears ONLY in `design-tokens-legacy.js` under `servers/` and `bundles/`
  EXCEPT `blog-public.js`, `songbook-renderer.js`, `kb-public.js`, `settings/sections/theme.js`
  (serif label), `servers/blog/server.js` (zod description) — encode the exemption list in the
  test.
- [ ] **Step 2: FAIL → implement.** Add `export const FONT_LINKS` (preconnect ×2 + one
  stylesheet link, Inter 400/500/600/700 + JBMono 400/600) in `layout.js` (or a small shared
  module); replace the 7 link sites; remove `FONT_IMPORT` from the dashboard style block (:867)
  — then delete the `FONT_IMPORT` export from `design-tokens.js` entirely and fix its importers
  (only dashboard files remain after Task 2). Sweep `'DM Sans'` → `var(--crow-body-font)` (13
  sites; body rule at :875 anchors). Sweep Fraunces per the grep with the exemptions; in client
  scripts keep emission constraints (no backticks, double-escaped).
- [ ] **Step 3: Green** — new test + `node --test tests/design-system.test.js
  tests/board-panel-config.test.js` + the extensions/messages panel test files.
- [ ] **Step 4: Mutation + commit** (re-add one DM Sans hardcode → grep test fails; restore).

### Task 7: Color/radius bypass sweep (grep-driven, dashboard only)

**Files:**
- Modify (per the greps below): `layout.js`, `panels/projects.js`, `shared/player.js`,
  `panels/nest/css.js`, `notifications.js`, `panels/messages/css.js`, `panels/contacts/html.js`,
  `panels/contacts/api-handlers.js` (:305), `components-css.js`, `bot-board/css.js`,
  `bot-builder/css.js`, `messages/client.js` (:639,:1251 — client emission!), `providers-tab.js`
  (:27), `ai-profiles.js` (:126), `servers/gateway/setup-page.js` (:110,:138),
  `servers/gateway/routes/calls-page.js` (:228,:268), bundle PANEL files from the fallback grep,
  and finally `design-tokens.js` (radius-pill 8px → 999px LAST)
- Test: `tests/token-bypass-sweep.test.js` (new)

- [ ] **Step 1: Failing grep-as-test** (`tests/token-bypass-sweep.test.js`), scope = `servers/gateway/dashboard/`
  + `servers/gateway/setup-page.js` + `servers/gateway/routes/calls-page.js` + `bundles/*/panel*/`
  (EXCLUDE the three frozen public files, `design-tokens-legacy.js`, AND — plan-review finding 2
  — the three brand-art files `shared/crow-hero.js`, `shared/empty-state-icons.js`,
  `shared/notifications.js`, which Task 8 recolors and re-adds to scope by removing these
  exclusions):
  1. no old-palette hex literal:
     `/#0f0f17|#1a1a2e|#2d2d3d|#6366f1|#818cf8|#2d2854|#fbbf24|rgba\(99,102,241|rgba\(251,191,36/i`
     (the gold-rgba form included, finding 12);
  2. no `color:\s*(#fff|#ffffff|white)` in the same rule as `background:\s*var\(--crow-accent` —
     implement as a per-file scan for the ~37 known pairs (fix-list from
     `grep -rn "var(--crow-accent)" | grep -i "fff\|white"` at task start);
  3. no `border-radius:\s*(8px|12px)` in `layout.js` (the token-bypass literals — the grep will
     surface ~15 sites, finding 5: :753, :756, :794, :800, :923, :1042, :1059, :1105, :1127,
     :1193, :1210, :1234, :1243, :1376, :1438 — ALL get the shape triage, not just the 6 named
     below);
  4. no `var\(--crow-[a-z-]+,\s*#/` stale fallback whose hex is an OLD palette value (the
     old-hex set from check 1).
- [ ] **Step 2: FAIL → transform, rule by rule. CATCH-ALL RULE binding on every grep hit not
  covered by a named rule below** (plan-review finding 5 — the named lists undercount; in-scope
  files the grep will also surface include `panels/files.js:159,:216`,
  `panels/messages/html.js:15` avatar hue array, `panels/extensions/html.js:69`,
  `layout.js:935,:1388,:1397,:1398`, and ~8 bundle panel files — iptv, frigate, calls,
  scratch-offline, maker-lab, media ×2, podcast): radius literals → control/card triage by
  shape; old-palette hex → the spec §3.2 new-palette equivalent (indigo → accent, gold →
  `#d9a521`/brand-gold, navy grounds → bg tokens, indigo-rgba tints → `color-mix` on accent);
  NEVER weaken or scope-down the test to pass. The messages avatar hue array swaps its indigo
  entry for the new accent (decided). Then the named rules:
  - white-on-accent → `color: var(--crow-accent-contrast)` (all ~37).
  - shadows `rgba(99,102,241,X)` → `color-mix(in srgb, var(--crow-accent) N%, transparent)`
    (N = round(X×100)).
  - alert/callout restructure per spec §3.2.1: `.alert-success/.alert-error/.callout-*` →
    `color: var(--crow-text-primary); background: color-mix(in srgb, var(--crow-success) 12%,
    transparent); border-left: 3px solid var(--crow-success)` (error/warning/info analogous).
  - radius triage: control-shaped sites (inputs/selects/buttons/`.bb-search`/`.bb-switch`/
    `.btn-xs`/`.callout`) → `var(--crow-radius-control)`; the chip/tag/badge list from spec §3.1
    STAYS on `var(--crow-radius-pill)`; `layout.js` literals :1042,:1059,:1210 →
    `var(--crow-radius-card)`, :1105,:1127,:1243 → `var(--crow-radius-control)`. THEN re-value
    `--crow-radius-pill: 999px` in `design-tokens.js`. Frozen files untouched (their 5 sites are
    excluded by test scope).
  - body-size muted re-points: `.empty-state` copy, `.login-subtitle`, `.stat-card .label` →
    `var(--crow-text-secondary)`.
  - stale fallbacks: rewrite each `var(--crow-x, #oldhex)` fallback to the NEW light value of
    that token (fallbacks only fire when tokens are absent — light value is the `:root` default).
  - `contacts/api-handlers.js:305` `|| "#6366f1"` → `|| "#0e6b62"`.
  - `messages/client.js:639,:1251`: while converting, their fallbacks become
    `var(--crow-radius-pill, 999px)` (matching `messages/css.js:607`'s existing end-state form;
    finding 12) — CLIENT EMISSION: no backticks, double-escaped.
  - `setup-page.js` + `calls-page.js`: replace hex with the new-palette equivalents (hand
    recolor — these pages don't load the token sheet; keep them self-contained), and
    `calls-page.js`'s DM Sans hardcode → `system-ui` stack (finding 12).
  - Path corrections (finding 10): the providers-tab/ai-profiles chip sites are
    `servers/gateway/dashboard/settings/sections/llm/providers-tab.js:27` and
    `settings/sections/llm/ai-profiles.js:126`.
- [ ] **Step 3: Green** — new test + `node --test tests/design-system.test.js
  tests/messages-client-live.test.js tests/board-panel-config.test.js tests/a11y-baseline.test.js`
  + contacts/messages/nest panel test files.
- [ ] **Step 4: Mutation + commit** (reintroduce one `#6366f1` → test fails; restore). Commit in
  two logical groups if cleaner (sweep, then radius re-value).

### Task 8: Brand SVG art recolor

**Files:**
- Modify: `servers/gateway/dashboard/shared/crow-hero.js`,
  `servers/gateway/dashboard/shared/empty-state-icons.js`,
  `servers/gateway/dashboard/shared/notifications.js` (:775–788 tamagotchi crow)
- Test: extend `tests/token-bypass-sweep.test.js` scope to these files

- [ ] **Step 1:** REMOVE the three art-file exclusions from `tests/token-bypass-sweep.test.js`'s
  scope (Task 7 excluded them by name — plan-review finding 2) → FAIL (they carry
  `#6366f1`/`#818cf8`/`#fbbf24`/`#0f0f17`/`#1a1a2e` fills).
- [ ] **Step 2:** Recolor: indigo fills → teal (`#0e6b62` main / `#4fbdb0` highlights), navy
  grounds → ink (`#22303a`) or transparent, gold → `#d9a521`. The crow silhouette stays a crow;
  keep stroke/shape geometry untouched — fills/strokes only. Where the SVG sits on a themed
  background, prefer `currentColor`/`var(--crow-*)` if the SVG is inline in HTML (these are JS
  template strings rendered inline — `var()` works in inline SVG attributes via `style=`; use it
  where trivially applicable, literal new-palette hex otherwise).
- [ ] **Step 3: Green** (bypass test + design-system render test + notifications test files if
  any: `grep -l notifications tests/ -r`). Visual check via the gallery/dashboard screenshot is
  the final review's job, not this task's.
- [ ] **Step 4: Commit.**

### Task 9: Perch panel unattached guidance (W4/§5.1)

**Files:**
- Create: `servers/gateway/shared/perch-attached.js`
- Modify: `servers/gateway/routes/perch.js` (:175–179 → import), `servers/gateway/routes/
  perch-interactive-api.js` (:92–96 → import), `servers/gateway/dashboard/panels/perch.js`
  (`renderRunning` :126–139 + its handler's data path), `servers/gateway/dashboard/shared/i18n.js`
- Test: `tests/perch-panel-unattached.test.js` (new; check for an existing perch panel test file
  first — `grep -l "panels/perch" tests/ -r` — and extend it if one exists)

**Interfaces:**
- Produces: `export function perchAttached(def)` in `perch-attached.js` — verbatim the current
  duplicated body (uses `missingGatewayFields` from
  `servers/gateway/dashboard/panels/bot-builder/gateway-fields.js`).

- [ ] **Step 1: Failing tests:** (a) both route files import from `perch-attached.js` and define
  no local `perchAttached` (text check); (b) panel: on a scratch db, seed `pi_bot_defs` rows —
  one enabled+attached (`definition` JSON with `gateways: [{type:"perch"}]`, `enabled: true`),
  one disabled+attached, one enabled+unattached (`pi_bot_defs.enabled` is INTEGER — seed `1`/`0`,
  not booleans; plan-review finding 11) — render the panel handler: with ONLY the
  disabled+attached and enabled+unattached rows → output contains the i18n'd callout (assert the
  EN string) AND still contains the iframe; add the enabled+attached row → no callout.
- [ ] **Step 2: FAIL → implement.** Extract the helper; panel handler queries `pi_bot_defs` via
  `createDbClient` + `JSON.parse(row.definition)` (mirror `routes/perch.js:181–186`), counts
  `enabled && perchAttached(def)`, renders the callout above the iframe when zero. i18n keys
  `perch.unattachedTitle` / `perch.unattachedBody` / `perch.unattachedCta` with EN+ES (body: EN
  "No enabled bot has the Perch channel attached. In Bot Builder, open a bot → Gateways → choose
  'Perch (dashboard chat)' → Save." — write natural ES, not machine-literal). CTA links to the
  Bot Builder panel route.
- [ ] **Step 3: Green** — new test + `node --test tests/i18n-global-parity.test.js` + existing
  perch route tests (`grep -l "routes/perch" tests/ -r`).
- [ ] **Step 4: Mutation** (count disabled bots as attached → test b fails) **+ commit.**

### Task 10: Tracker tags + board debts (W4/§5.2–5.3)

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-board/html.js` (:48–51 extract tag-pill builder;
  :102–158 tracker face; :556 SELECT), `servers/gateway/board/card-service.js` (:191 autonomy
  null; :258–264 + :317–323 terminal-stamp dedup; nowStamp), `servers/gateway/board/plan-service.js`
  + `result-service.js` (nowStamp — converge to one helper in a shared board util),
  `servers/gateway/routes/bot-board-api.js` (:393–395 status-400 vs archived-409 order),
  `servers/gateway/dashboard/panels/bot-builder/editor.js` (:59 hasArchivedAtColumn),
  `bundles/pm-workspace/server/digest/adapters/boards.js` (:29), `bundles/pm-workspace/server/
  sync/monday.js` (:250)
- Test: the harness files by name (plan-review finding 6 — `ls tests/ | grep -i board` misses
  the tracker one): tracker-tags render test → `tests/tracker-panel.test.js` (its
  `renderCustomTracker` fixture's `tasks_items` already has a `tags` column); autonomy-null →
  `tests/board-card-service.test.js`; archived-409 → `tests/board-card-api.test.js`.

- [ ] **Step 1: Failing tests:** (a) tracker board render (`tests/tracker-panel.test.js`'s
  existing harness) with an item carrying `tags:"grant,urgent"` shows
  `class="bb-tag"` pills; kanban render unchanged (existing assertions stay green). (b)
  `card-service` update with `autonomy: null` → validation error (assert the error shape other
  invalid values get at :191's normalizer). (c) POST update on an ARCHIVED card with an invalid
  status → 409 (not 400).
- [ ] **Step 2: FAIL → implement.** `html.js`: extract `tagPillsHtml(tags)` from :48–51; call in
  both faces; add `tags` to the :556 column list. Debts: single `nowStamp()` in a board shared
  util imported ×3; single `hasArchivedAtColumn(db)` helper (place beside the board helpers;
  pm-workspace imports via its existing core-import pattern — check how those bundle files import
  core code today and follow it); dedupe the terminal-stamp block into one function; fix the
  :191 null bypass (`norm != null` → explicit invalid on `null` when the field was present); swap
  the check order at bot-board-api :393–395 (archived first).
- [ ] **Step 3: Green** — the board test files + `node --test tests/board-panel-config.test.js`.
- [ ] **Step 4: Mutation** (revert the SELECT tags addition → render test fails) **+ commit.**

### Task 11: Docs notes + full validation

**Files:**
- Modify: `docs/superpowers/plans/2026-07-11-extensions-overhaul.md` (superseded-note on the
  glass-mirroring instruction), `docs/superpowers/plans/2026-06-10-f6a-design-system-foundation.md`
  + `docs/superpowers/specs/2026-06-10-f6a-design-system-foundation-design.md` (same note),
  `docs/architecture/dashboard.md` (one paragraph: the token system is light-first OS-driven,
  Perch tokens are Crow-owned with the drift gate, glass removed — fact-check every clause
  against the shipped code)

- [ ] **Step 1:** Write the doc notes (superseded-note format: a dated one-liner at the relevant
  section head pointing at this spec). Controller fact-checks the dashboard.md paragraph.
- [ ] **Step 2:** Full suite: `npm test` ≥ 3380 minus the deleted D4 case plus all new tests, 0
  fail. Record exact numbers.
- [ ] **Step 3:** 3×3 concurrent validation (3 rounds × 3 parallel `npm test`), report all 9.
  Known pre-existing flake: models-manager resume under load — report, don't fix.
- [ ] **Step 4: Commit docs.** Controller then owns: final whole-branch review → fix wave → push
  → PR → CI check-runs green → merge.

---

## Self-review record

**Spec coverage:** W1→T1; freeze §4.1→T2; §3.2 values + gallery→T3; §3.3 theme removal→T4
(noise texture included); §3.4 glass/settings/MCP/migration/init-db/D4→T5; fonts §3.2-fonts +
Fraunces §4.2→T6; §3.2.1 policy sweeps + radius triage §3.1 + fallbacks + standalone pages→T7;
SVG art→T8; §5.1→T9; §5.2+§5.3→T10; docs+§6 validation→T11. Drift-test both-directions +
payload sweep in T1 matches §2. The §4.2 "gallery gains demo rows" lands in T3 Step 4.
**Placeholders:** none — every step names exact files, values, and assertions; sweeps are
grep-defined with transformation rules (by design, not placeholder).
**Type consistency:** `PERCH_TOKENS` shape (T1) is what the drift test consumes;
`legacyDesignTokensCss`/`LEGACY_FONT_IMPORT` (T2) match blog imports; `FONT_LINKS` (T6) replaces
`FONT_IMPORT` after T2 removed non-dashboard importers; `perchAttached(def)` (T9) single
signature; `tagPillsHtml(tags)` (T10) used by both faces. Radius-pill re-values in T7 (not T3) —
stated in both tasks.

## Review

**2026-08-15, adversarial staff-engineer review (fable). Verdict: REVISE → all 12 findings
applied.** Critical: glass token definitions (T3) and consumers (then-T5) sat on opposite sides
of per-task green gates — all glass CSS deletion moved into T3. Importants: T7's test scope
contradicted T8 (art files now excluded-then-readded); kb-public's accessor rename was missing
(undefined-without-throwing); the init-db non-resurrection test was vacuous unless seeded
`'light'`; T7 gained the binding catch-all transform rule + the fuller grep inventory; T10's
harness files named (`tracker-panel`, `board-card-service`, `board-card-api`). Minors: nest/css.js
`.theme-light` ×3 folded into T4's tree-wide grep; T6's no-@import scope pinned (legacy exempt);
`set_kiosk` survival stated; llm/ paths + noise-texture :880 corrected; `pi_bot_defs.enabled` as
INTEGER; messages/client fallbacks → `,999px`, calls-page DM Sans → system-ui, gold-rgba in the
regex. Reviewer Q1 resolved: glass CSS folded into T3 (not a separate task). Q2: suite floor
3380/0 verified by the controller's own run at the branch base.
