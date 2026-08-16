# Track 2 — the visual language: Perch ownership flip, tokens, primitives

Child spec of the scope document (Gitea `kh0pp/crow-engineering`, branch
`docs/board-truth-and-visual-language-scope`, `specs/2026-08-08-board-truth-and-visual-language-scope.md`),
which locked decisions 6 (light and dark equal, no default, following the OS; **glass retired**) and
15 (Crow owns the design tokens Perch uses; **the ownership flip lands before any adoption wave**).
Kevin's execution order for this cycle: **ownership flip first**, then tokens + gallery, then the 11
primitives; the inline-CSS long tail, the three bundle web UIs, and the public blog are LATER plan
cycles under this same spec (blog last, with its own review). Two product-feedback items fold in:
the Perch panel's silent `perch_not_attached` state, and tags on tracker card faces.

Verified against `origin/main` @ab250eeb, 2026-08-15. This revision incorporates adversarial review
round 1 (record at the end). All file:line cites were read this session; executors re-locate by
content.

## What this spec covers (and what it defers)

**In this cycle (one plan, one PR):**
- W1 — the ownership flip: an authoritative Perch token map in Crow + a drift test against the
  vendored payload (decision 15).
- W2 — the token rewrite: `design-tokens.js` adopts the Perch-derived palette, light-first with an
  OS-driven dark mode; glass retired end-to-end; public surfaces frozen on a legacy snapshot.
- W3 — the primitives + bypass sweep: the 11 shared primitives and the dashboard's hardcoded
  color/radius/font bypasses move fully onto tokens; brand SVG art recolored.
- W4 — product fixes: Perch panel unattached guidance (Crow-side); tracker card faces show tags;
  plus the small board debts that fold into that touch.

**Deferred to later cycles under this spec:** the inline-CSS long-tail files converted panel by
panel; the 3 bundle web UIs (`capstone-tracker`, `maker-lab`, `pm-workspace`); the public blog +
songbook adoption (LAST, own review — see §4.1's freeze); the JetBrains-Mono hardcode sweep (~83
sites — no rendering breakage meanwhile, JBMono stays loaded; long tail); Track 3's motifs (wire
catenary, chibi bird states, the roost strip) which belong to the board × Perch pilot.

## 1. The language

Perch's palette wins and spreads (scope §2.2). The vendored `PERCH_CSS`
(`bundles/perch-hub/payload/hub/server.mjs:220–265`) defines it in 10 custom properties with a
light-first `:root` and an `@media (prefers-color-scheme: dark)` override:

| var | light | dark |
|---|---|---|
| `--sky` (ground) | `#eef1f3` | `#131a1f` |
| `--card` (surface) | `#fff` | `#1b242b` |
| `--ink` (text) | `#22303a` | `#e4ebef` |
| `--dim` (secondary) | `#6b7c88` | `#8fa0ab` |
| `--teal` (accent) | `#0e6b62` | `#4fbdb0` |
| `--teal-soft` | `#dcecea` | `#16322f` |
| `--wire` | `#94a4ae` | `#46565f` |
| `--alive` | `#2fa36b` | (inherits) |
| `--attn` | `#d1633e` | (inherits) |
| `--line` (border) | `#dde4e8` | `#2a353d` |

Type: **Inter** (UI) + **JetBrains Mono** (code). Fraunces and the serif toggle retire from the
dashboard (§4.3); the frozen blog keeps its current fonts and its serif control until the blog wave
decides its own typography. Perch's control radius is **10px** (buttons/inputs throughout
`PERCH_CSS`); its 999px full-round appears only on nav chips — Crow's radius tokens follow that
split (§3.2).

## 2. W1 — the ownership flip (decision 15, first)

**Mechanism decided in scope §2.3:** Crow's `design-tokens.js` becomes the source of truth and a
test asserts the vendored payload's token block matches it — vendoring stays intact (Perch still
ships standalone; `payload_sha256` pinning and `scripts/check-vendored-payloads.mjs` are untouched),
but drift fails CI loudly instead of silently forking the language.

- `design-tokens.js` exports `PERCH_TOKENS`: `{ light: { sky, card, ink, dim, teal, tealSoft,
  wire, alive, attn, line }, dark: { sky, card, ink, dim, teal, tealSoft, wire, line } }` — the
  exact table above, dark listing only the 8 vars Perch's dark block overrides (`alive`/`attn`
  deliberately absent: they inherit, and the test must assert that absence too, or an upstream
  dark-override would slip in unnoticed).
- New `tests/perch-token-drift.test.js`: parses the `:root{…}` and
  `@media (prefers-color-scheme:dark){:root{…}}` blocks out of
  `bundles/perch-hub/payload/hub/server.mjs` (regex over the file text — the payload is a JS file
  carrying a CSS template literal; do NOT import/execute the payload) and asserts: every
  `PERCH_TOKENS.light` entry present with the exact value; every `PERCH_TOKENS.dark` entry present
  with the exact value; NO dark declaration exists for vars absent from `PERCH_TOKENS.dark`; no
  custom property exists in the PERCH_CSS blocks that `PERCH_TOKENS` doesn't name (both directions
  — an upstream addition is drift too). **And a payload-wide sweep** (review finding 12): no
  CSS-custom-property DEFINITION (`--x:`) exists anywhere else in `bundles/perch-hub/payload/`
  (including `bots-page.mjs`'s `BOTS_CSS`, which consumes the vars but must never define its own)
  — otherwise drift hides outside the asserted blocks.
- The change flow after this lands: palette evolution edits `PERCH_TOKENS` → the drift test fails →
  the pi-lab edit + `scripts/vendor-perch.mjs` + re-pin dance brings the payload back into
  agreement. The two-repo dance still exists per change, but it can never happen silently, and
  Crow's file is where the change is authored first.
- **Considered and rejected:** injecting a Crow-generated `<style>` override into the proxied Perch
  HTML (`servers/gateway/routes/extension-proxy.js` `proxyRes` has no body-rewrite today). It would
  remove the two-repo dance, but adds streaming body-rewrite machinery to a shared generic proxy,
  breaks Perch-standalone parity (the same payload would render differently inside vs outside
  Crow), and decision 15's text chose the drift-test shape explicitly.
- **pi-lab status (corrected in review round 1):** `~/pi-lab` on crow IS a git checkout (origin
  `git@gitea:kh0pp/pi-lab.git`). This cycle still needs **no vendor run** — because nothing in it
  changes the payload, not because the checkout is missing. W1 asserts against the CURRENT vendored
  bytes, whose values `PERCH_TOKENS` copies.

## 3. W2 — the token rewrite

### 3.1 Token names keep, values change — with two named exceptions

This is a **value rewrite, not a rename**. All `--crow-*` names survive (including the legacy
aliases at `design-tokens.js:68–78` — `--crow-bg`, `--crow-surface`, `--crow-text`, etc., which
resolve through `var()` and are consumed by bundles). `tests/design-system.test.js` guards names
not values; no test asserts a palette hex (verified).

Two tokens CANNOT be safely re-valued in place and get explicit handling (review finding 2):

- `--crow-radius-pill` is consumed at **44 sites as a small control radius** (inputs, selects,
  buttons — e.g. `panels/projects.js:209–210, 474–483`). Re-valuing it to 999px would pill-round
  every text input. So: new `--crow-radius-control: 10px` (Perch's control radius) is introduced,
  the 44 existing `radius-pill` consumers are swept onto it in W3 (mechanical, greppable), and only
  THEN does `--crow-radius-pill` re-value to `999px`, reserved for chips/tags/pills proper.
- `--crow-radius-card` re-values 12px → 14px in place (safe — it is a card radius everywhere).

### 3.2 The new values

Light becomes the `:root` base (Perch is light-first; today's file is dark-first — the blocks swap
roles). Derived values (marked *d*) fill Crow tokens Perch has no equivalent for. Contrast ratios
below were computed in review round 1; the remaining checks in round 2 verify the revised values.

| token | light (`:root`) | dark (media) | source / note |
|---|---|---|---|
| `--crow-bg-deep` | `#eef1f3` | `#131a1f` | sky |
| `--crow-bg-surface` | `#ffffff` | `#1b242b` | card |
| `--crow-bg-elevated` | `#f5f7f8` *d* | `#232e36` *d* | between sky and card |
| `--crow-border` | `#dde4e8` | `#2a353d` | line |
| `--crow-border-strong` | `#94a4ae` *d* | `#46565f` *d* | wire; input/control boundaries (§3.2.1) |
| `--crow-text-primary` | `#22303a` | `#e4ebef` | ink |
| `--crow-text-secondary` | `#5c6d79` *d* | `#8fa0ab` | dim, light darkened for AA on sky |
| `--crow-text-tertiary` | `#6b7c88` | `#7d8f9a` *d* | dim — large/short text only (§3.2.1) |
| `--crow-text-muted` | `#8395a1` *d* | `#5f707b` *d* | decorative/large only (§3.2.1) |
| `--crow-accent` | `#0e6b62` | `#4fbdb0` | teal |
| `--crow-accent-hover` | `#0b574f` *d* | `#6fd0c4` *d* | teal ±1 step |
| `--crow-accent-muted` | `#dcecea` | `#16322f` | teal-soft |
| `--crow-accent-contrast` | `#ffffff` | `#131a1f` *d* | text ON accent/status fills (§3.2.1) |
| `--crow-success` | `#1d7048` *d* | `#2fa36b` | alive, light darkened for AA (finding 4) |
| `--crow-error` | `#b04a2b` *d* | `#d1633e` | attn, light darkened (finding 11) |
| `--crow-warning` | `#8f5606` *d* | `#d9a521` *d* | gold family, harmonized |
| `--crow-info` | `#33688c` *d* | `#6aa9cc` *d* | cool slate-blue, distinct from accent |
| `--crow-brand-gold` | `#8f5606` | `#d9a521` | warning family; decorative/large-only (§3.2.1) |

Radius: `--crow-radius-card: 14px`, `--crow-radius-control: 10px` (new), `--crow-radius-pill:
999px` (after the §3.1 consumer sweep).

Type tokens: `--crow-body-font: 'Inter', system-ui, sans-serif`; new `--crow-mono-font:
'JetBrains Mono', monospace`.

**Fonts actually reaching the page (review finding 3):** nothing in the dashboard reads
`--crow-body-font` today, and the dashboard hardcodes `'DM Sans'` at 13 sites across 6 files
(`layout.js:875` body, :1102 inputs, :1133 `.btn`, the login button, `panels/extensions/css.js`,
`notifications.js`, `panels/blog.js`, `messages/css.js`, `model-catalog.js`). W3 sweeps ALL of them
to `var(--crow-body-font)` with `body { font-family: var(--crow-body-font) }` as the anchor —
without this sweep the Inter migration delivers the OS fallback font, not Inter. Font LOADING picks
ONE mechanism (finding 20): the `<link rel="stylesheet">` form (with preconnect), emitted by one
shared constant used by the render path and all six standalone pages (today: 7 drifted `<link>`
sites in `layout.js` PLUS a redundant `FONT_IMPORT` `@import` in the style block — the collapse
removes the `@import` from the dashboard; `design-tokens-legacy.js` keeps the old `@import` for the
frozen blog). The new manifest loads Inter + JetBrains Mono only. CSP already allows
fonts.googleapis.com (`servers/gateway/index.js:343`).

**The body noise texture** (`layout.js:879`, a white fractal-noise SVG overlay at 0.03 opacity,
designed for the dark ground): **dropped** (finding 21). Perch's language is flat; the texture is
an indigo-era artifact and reads as grime on `#eef1f3`.

### 3.2.1 Contrast policy (review findings 1, 4, 5, 11, 19 — binding on W3)

- **Text on accent/status fills** uses `--crow-accent-contrast`, never a hardcoded `#fff`.
  Verified: white on light accent `#0e6b62` passes; `#131a1f` on dark accent `#4fbdb0` = 7.7:1.
  W3 sweeps the ~20 white-on-accent sites (`.btn-primary` `layout.js:1135–1137`, login button
  :1240–1243, `panels/projects.js:214,275,485`, `shared/player.js`, badge fills) onto it. Status
  badges (`.badge-published`, `.badge-connected`, …) likewise use `--crow-accent-contrast` on
  their status fills.
- **Body-size status text is retired as a pattern.** `.alert-success`/`.alert-error`/`.callout-*`
  render `--crow-text-primary` body text on a status-tinted background (`color-mix` on the status
  token) with a status-colored border/icon — status is carried by the container, not by coloring
  sentence text. Status tokens AS text are reserved for short/large elements (stat values, icons,
  single-word states) on `bg-surface`, where the revised values pass AA.
- **`--crow-text-tertiary` and `--crow-text-muted` are large/short-text and decorative tokens** —
  they do not pass 4.5:1 on every background and are not meant to. W3 re-points today's body-size
  muted uses (`.empty-state` copy, `.login-subtitle`, `.stat-card .label`) to
  `--crow-text-secondary`.
- **`--crow-brand-gold` is decorative/large-only** (SVG fills, large numerals). It shares warning's
  values; if a future badge needs gold-as-fill, its text is `--crow-accent-contrast`.
- **Control boundaries** (WCAG 1.4.11): inputs/selects use `--crow-border-strong` (wire) for their
  borders. Recorded as an **accepted deviation**: wire on white is ~1.9:1, short of the 3:1
  non-text ideal — this matches Perch's own control look; focus states (already
  `outline: 2px solid var(--crow-accent)`, guarded by `tests/a11y-baseline.test.js`) carry the
  accessible affordance. Round 2 does not need to re-litigate this.

### 3.3 Theme mechanism: the OS decides

Decision 6 verbatim: "Both equal, no default." Implementation:

- The rewritten `design-tokens.js` emits light values on `:root` and dark values inside
  `@media (prefers-color-scheme: dark)` — exactly Perch's mechanism, which also dissolves the
  iframe mismatch (Perch already follows the OS; today a `.theme-light` dashboard around an
  OS-dark Perch renders mixed).
- **The `.theme-light` class, the sidebar theme-toggle button (`layout.js:254–256, 277–289`,
  `toggleTheme()`), the `theme_dashboard_mode` per-surface override, and the `.theme-serif` axis
  all retire from the dashboard.** The dashboard render path (`dashboard/index.js:849–864`,
  `layout.js:138`) stops reading mode/glass/serif entirely — the dashboard has no theme state.
- **`servers/gateway/shared/theme-resolver.js` is DELETED** (review finding 7): it has zero
  importers today (blog and dashboard both compose classes inline), and it carries
  `theme_glass`/`theme_serif` reads that would fail the glass orphan sweep.
- **Named consequence for Kevin (reversible):** no manual light/dark override ships. Development
  and review flip modes via browser DevTools' `prefers-color-scheme` emulation (the plan states
  this; no product mechanism ships). If living with OS-following surfaces a real need for a pin, a
  `.theme-force-*` hook can come back in a later wave — the token structure (media query wrapping a
  delegating block) is written so that hook is addable without restructuring, but none ships now.

### 3.4 Glass retires end-to-end (decision 6)

Everywhere at once — glass is not frozen with the blog, it is removed:

- CSS blocks deleted: `design-tokens.js:80–119`; `layout.js:1265–1298`;
  `panels/extensions/css.js:398–417`; `settings/menu-renderer.js:179–181`;
  `blog-public.js:299–318` + class composition :332; `songbook-renderer.js` glass rules + the 3
  class-composition sites (:306, :474, :587); `theme-resolver.js` dies whole (§3.3). Orphan sweep
  afterward: `grep -rn "crow-glass-blur\|crow-bg-popup\|crow-border-popup\|theme-glass"` over
  `servers/` and `bundles/` must come back empty (docs history exempt).
- **Settings section end state (review finding 10, decided):** `settings/sections/theme.js`
  becomes the **"Blog theme"** section (label re-keyed via i18n): a Color Mode select writing
  `blog_theme_mode` (+ the existing blog-surface override select writing `blog_theme_blog_mode`)
  and the Serif Headings checkbox writing `blog_theme_serif` — all three still consumed by the
  frozen blog. Deleted: the Glass checkbox + its shim (:22, :53–57, :84–86, :122), the Dashboard
  Override select, the now-dead `set_theme`/`set_theme_mode` AJAX handlers (:104–131, tied to the
  retiring `toggleTheme()`), and `getPreview`'s glass read — `getPreview` re-renders from blog
  mode + serif only.
- MCP: `crow_blog_settings` drops BOTH `theme_glass` (zod :456, get :478, display :481, set :509)
  AND `theme_dashboard_mode` (zod :459, set :512 — it would re-create the row the migration
  deletes; finding 9). Breaking tool-surface change, ours to make.
- **Settings migration** (net-new; follow `settings/migrations/llm-settings-migration.js`'s
  registration pattern): delete `blog_theme_glass`, `blog_theme_dashboard_mode`, AND the legacy
  `dashboard_theme` + `blog_theme` keys (finding 8) from BOTH `dashboard_settings` (global) and
  `dashboard_settings_overrides` (every `instance_id`). `blog_theme_mode`, `blog_theme_blog_mode`,
  and `blog_theme_serif` SURVIVE — the frozen blog reads all three. Absent keys read falsy at
  every read site (`=== "true"` / `|| "dark"` fallbacks), so deletion is the whole migration.
- **init-db's legacy theme block** (`scripts/init-db.js:2326–2374`) has its `dashboard_theme`
  branch retired in the same PR (finding 8): today it can re-mint `blog_theme_dashboard_mode` from
  a surviving legacy `dashboard_theme` row on any host without `blog_theme_mode` — resurrection of
  the exact key the migration deletes.
- Docs: `docs/superpowers/plans/2026-07-11-extensions-overhaul.md`'s standing instruction to
  "mirror every new surface into the `.theme-glass` block" gets a superseded-note; the F6a design
  docs likewise. (Doc edits, not deletions — they are history.)

## 4. Where the rewrite must NOT leak, and where it must reach

### 4.1 Public surfaces freeze (the blog is LAST, with its own review)

`blog-public.js:20`, `songbook-renderer.js:16`, and `bundles/knowledge-base/routes/kb-public.js:27–41`
consume `design-tokens.js` today (verified: the only importers outside the dashboard tree) — an
in-place value rewrite would repaint the PUBLIC blog the moment it merges, violating the wave
order. So:

- New `servers/gateway/dashboard/shared/design-tokens-legacy.js`: a verbatim snapshot of today's
  `designTokensCss()` + `FONT_IMPORT` (minus the glass blocks, which retire everywhere), exported
  as `legacyDesignTokensCss()` / `LEGACY_FONT_IMPORT`, header-commented as a frozen copy that dies
  in the blog wave.
- `blog-public.js` and `songbook-renderer.js` switch imports to the legacy module and keep reading
  `blog_theme_mode` / `blog_theme_blog_mode` / `blog_theme_serif` for their own class composition
  (blog behavior unchanged except glass).
- `kb-public.js` points its dynamic import at the legacy module too, and its silent hardcoded
  fallback palette (:40) becomes a LOUD failure (log + minimal neutral styles) instead of a stale
  palette copy.
- **Freeze test, scope pinned (finding 18):** asserts over RENDERED output, not file greps —
  `designTokensCss()`'s string contains `#eef1f3` and not `#0f0f17`; `legacyDesignTokensCss()`'s
  string contains `#0f0f17` and not `#eef1f3`; and the blog page-shell render uses the legacy
  function. Standalone hardcoded pages (§4.2) are outside its scope by construction.

### 4.2 W3 — primitives and the bypass sweep

The leverage is the primitives (scope §2.4). Beyond the §3.2/§3.2.1 sweeps (DM Sans ×13,
white-on-accent ~20, radius-pill consumers ×44, body-size muted re-points), the bypasses found in
exploration each become token consumers:

- `layout.js` `.card`/`.stat-card`/`.login-card` shadows: literal `rgba(99,102,241,…)` at :1045,
  :1049, :1061 → `color-mix(in srgb, var(--crow-accent) N%, transparent)`.
- Radius literals: `.card`/`.stat-card`/`.login-card` 12px (:1042, :1059, :1210) →
  `var(--crow-radius-card)`; inputs/`.btn` 8px (:1105, :1127, :1243) → `var(--crow-radius-control)`.
- Alert tints `rgba(34,197,94,.1)` / `rgba(239,68,68,.1)` (:1197–1198, :1230–1232) → `color-mix`
  on `--crow-success`/`--crow-error`, restructured per §3.2.1's container pattern.
- Fraunces: `components.js` `section()` heading (:114), `layout.js:908` (`.logo`), :1015, :1184,
  :1218, and `bundles/media/panel/media.js`'s **10** inline `font-family:'Fraunces'` style literals
  (:105, :114, :609, :638, :676, :703, :726, :797, :817, :860) → `var(--crow-body-font)`.
  **Acceptance is a grep** (finding 17): after the sweep, `Fraunces` appears only in
  `design-tokens-legacy.js`.
- `nest/css.js` (:222, :224, :227, :299) and `notifications.js` (:301, :401, :431, :519) literal
  indigo/navy → tokens.
- Brand SVG art recolored to the new palette (art is not CSS; hand-edit): `shared/crow-hero.js`,
  `shared/empty-state-icons.js`, `notifications.js:775–788` (the tamagotchi crow). The crow stays a
  crow; fills move from indigo/gold to ink/teal/gold-as-`#d9a521`.
- Stale `var(--crow-x, #oldhex)` fallbacks: ~89 dashboard-tree sites + ~35 bundle-PANEL sites
  (bundle panels render inside the dashboard — both sets are in the sweep; finding 15), heaviest
  in `panels/messages/css.js`, `panels/contacts/html.js`, `bundles/meta-glasses`,
  `bundles/podcast`. The contacts default group color literal (`contacts/api-handlers.js:305`
  `|| "#6366f1"`) → the new accent.
- Standalone pages that bypass tokens entirely — `servers/gateway/setup-page.js:110,138` and
  `servers/gateway/routes/calls-page.js:228,268` (paths corrected per finding 16) — convert to
  `var(--crow-*)` with the token `<style>` included, or hand-recolor if including the sheet is
  disproportionate; executor's call, named in the plan.
- The gallery panel (`panels/design-system.js`) keeps working by construction (it iterates token
  names); it gains rows for `--crow-accent-contrast` demos (button on accent), the three radius
  tokens, and `--crow-mono-font`, so review can be visual. Mode flipping during review is via
  DevTools `prefers-color-scheme` emulation (§3.3).

`tests/design-system.test.js` continues to pass by construction (names unchanged); it gains a
value-level assertion that `:root` carries the new ground `#eef1f3`, and its must-exist name list
gains the three new tokens (`--crow-accent-contrast`, `--crow-radius-control`,
`--crow-border-strong`).

### 4.3 What retires with Fraunces

The serif axis existed to force Fraunces on the DASHBOARD. `.theme-serif` block deleted, the
dashboard's serif read deleted. The Serif Headings checkbox SURVIVES in the "Blog theme" section
(§3.4) because the frozen blog still consumes `blog_theme_serif` — it retires with the blog wave,
not this one.

## 5. W4 — product fixes riding this cycle

### 5.1 Perch panel: say why the perch is empty (Crow-side)

Diagnosed 2026-08-15: launching Perch with no bot attached yields a silent, inert lens —
`perch_attached` is false for every bot, so the vendored UI renders no chat affordances and no
explanation (the vendored 403 handler exists but only fires on a race; the empty state is the real
gap). Fix in the Crow panel, not the payload — the empty state is a Crow-integration concern
(which bots exist and how to attach them is Bot Builder knowledge), and the payload stays
untouched this cycle:

- `panels/perch.js` `renderRunning()` (:126–139): before emitting the iframe, count attached bots
  the same way the gateway does — extract `perchAttached(def)` (duplicated verbatim today at
  `servers/gateway/routes/perch.js:175` and `perch-interactive-api.js:92`) into a shared module
  both routes and the panel import; the panel reads bot defs through the same store the routes use.
- Zero attached → render a callout ABOVE the iframe (not instead — the lens's sessions view still
  works): "No bot has the Perch channel attached. In Bot Builder, open a bot → Gateways → choose
  'Perch (dashboard chat)' → Save." with a link to the Bot Builder panel. EN + ES via `i18n.js`
  (`perch.unattachedTitle`, `perch.unattachedBody`, `perch.unattachedCta`), satisfying
  `tests/i18n-global-parity.test.js`.
- Test: panel render with zero attached defs contains the callout; with ≥1 attached def it doesn't.

### 5.2 Tags on tracker card faces

The kanban face already renders `tags` as pills (`bot-board/html.js:48–51`); the tracker face
(`trackerCardFaceHtml`, :102–158) never does, and the tracker query (:556) doesn't SELECT `tags`.
Fix: add `tags` to that column list; render the same `bb-tags`/`bb-tag` pill block into the tracker
face beside `metaHtml` (extract the tag-pill builder rather than duplicating it). CSS exists
(`css.js:24–25`). Server-side render only — `client.js` untouched (it never builds faces), so the
no-backticks/double-escape constraints are not in play; `tests/board-panel-config.test.js`'s parse
test still guards the emitted script. Test: tracker board render shows pills for a tagged item;
kanban unchanged.

### 5.3 Board debts folding into the same touch (standing-small-debts list)

Fold into the board task, don't PR alone: `nowStamp()` ×3 and `hasArchivedAtColumn` ×3
(`bot-builder/editor.js:59`, `pm-workspace/.../boards.js:29`, `pm-workspace/.../monday.js:250` —
count corrected per finding 13) converge to one helper each; the duplicated terminal-stamping block
(`card-service.js:258–264` vs :317–323) likewise; `autonomy: null` bypassing validation
(`card-service.js:191`, `norm != null` lets null through) gets the missing check + test; POST
`/card/:id` with archived + bad status returns 409 (archived wins — today `bot-board-api.js:395`'s
status 400 fires first) + test. `bot_sessions.plan_path` always-null (perch.js displays it) is NOT
in this cycle — Track 3 reshapes that lens anyway; noted, deferred.

## 6. Testing

- `tests/perch-token-drift.test.js` — §2, both directions + the payload-wide no-definitions sweep,
  mutation-tested (change one `PERCH_TOKENS` hex → test fails).
- `tests/design-system.test.js` — new-ground value pin + three new token names in the must-exist
  list.
- Freeze test (§4.1) over rendered function output, both directions, plus blog-shell-uses-legacy.
- Glass orphan test: rendered dashboard CSS and blog CSS contain no `theme-glass` and no
  glass-only token names; the settings migration proven on a scratch db (all four keys deleted
  from both tables, every instance_id; the three surviving keys intact); init-db's retired
  `dashboard_theme` branch proven non-resurrecting (seed legacy row, run init-db, assert no
  `blog_theme_dashboard_mode` re-mint).
- i18n parity (new keys incl. the section relabel), a11y-baseline (unchanged token names),
  board-panel-config parse (unchanged emission), perch panel tests extended for §5.1.
- Contrast: round 1 computed the failing pairs and the revised values above; round 2 verifies the
  revised table's math. No automated contrast gate ships this cycle (nice-to-have if cheap during
  planning).
- Suite floor 3380/0 (post-#292). Mutation-test every new test; 3×3 concurrent validation at the
  end.

## 7. Out of scope, restated

Long-tail panel conversion; bundle web UIs; blog/songbook adoption of the new language (frozen
legacy tokens until then); the JBMono hardcode sweep; Track 3 motifs and the Perch
sessions-lens question; any `PERCH_CSS`/payload edit (none needed this cycle);
r4-assistant's stale tool list (instance data, Kevin-conditional); `bot_sessions.plan_path`
(§5.3).

## Named decisions made in this spec (Kevin was not in the loop; each reversible)

1. **Value rewrite, not rename** (§3.1) — with the two-token exception handled explicitly
   (radius-control introduced before radius-pill re-values).
2. **No manual light/dark override ships** (§3.3) — decision 6 read literally; DevTools emulation
   is the dev/review workflow; a later pin hook stays addable.
3. **Serif/Fraunces retires from the dashboard; the blog keeps its serif control until the blog
   wave** (§4.3).
4. **brand-gold re-values into the warning/gold family and is decorative/large-only** (§3.2.1).
5. **Glass dies everywhere at once** including the otherwise-frozen blog (§3.4).
6. **`crow_blog_settings` drops `theme_glass` AND `theme_dashboard_mode`** (breaking MCP surface,
   ours) (§3.4).
7. **kb-public's silent fallback becomes a loud failure** (§4.1).
8. **The `perch_not_attached` fix is Crow-side panel UX**, not a vendored-payload change (§5.1).
9. **Body-size status text retires as a pattern**; status containers carry the color (§3.2.1).
10. **The theme settings section becomes "Blog theme"** with exactly mode + blog-override + serif
    (§3.4).
11. **The body noise texture drops** (§3.2).
12. **Input-boundary contrast accepted below 3:1 non-text** (wire borders, matching Perch), with
    accent focus outlines as the accessible affordance (§3.2.1).

## Review record (2026-08-15)

**Round 1** (adversarial, fable, against @ab250eeb + spec commit 2c86dc30): verdict REVISE, 21
findings + 4 questions, all applied above. The four criticals each named a would-have-shipped
regression: (1) white-on-accent buttons at 2.27:1 in dark mode → `--crow-accent-contrast` token +
sweep; (2) `radius-pill` 8px→999px would have pill-rounded 44 form controls → `--crow-radius-control`
introduced first; (3) the Inter migration didn't deliver Inter (13 DM Sans hardcodes, zero
`--crow-body-font` consumers in the dashboard) → the DM Sans sweep is now binding; (4) light
success `#2fa36b` fails AA as text → `#1d7048` + the status-container pattern. Important findings
corrected three factual claims (pi-lab IS checked out; `theme-resolver.js` is dead code and now
dies; init-db can resurrect a deleted theme key → its legacy branch retires) and hardened the
migration (legacy `dashboard_theme`/`blog_theme` keys join the deletion), the MCP tool surface
(`theme_dashboard_mode` drops too), the drift test (payload-wide definition sweep), and the
muted/tertiary/status contrast policy. Questions answered as decisions 2, 10, 4 (gold is
decorative-only), and the JBMono sweep deferral (§"deferred").
