# Track 2 — the visual language: Perch ownership flip, tokens, primitives

Child spec of the scope document (Gitea `kh0pp/crow-engineering`, branch
`docs/board-truth-and-visual-language-scope`, `specs/2026-08-08-board-truth-and-visual-language-scope.md`),
which locked decisions 6 (light and dark equal, no default, following the OS; **glass retired**) and
15 (Crow owns the design tokens Perch uses; **the ownership flip lands before any adoption wave**).
Kevin's execution order for this cycle: **ownership flip first**, then tokens + gallery, then the 11
primitives; the inline-CSS long tail, the three bundle web UIs, and the public blog are LATER plan
cycles under this same spec (blog last, with its own review). Two product-feedback items fold in:
the Perch panel's silent `perch_not_attached` state, and tags on tracker card faces.

Verified against `origin/main` @ab250eeb, 2026-08-15. All file:line cites below were read this
session; executors re-locate by content.

## What this spec covers (and what it defers)

**In this cycle (one plan, one PR):**
- W1 — the ownership flip: an authoritative Perch token map in Crow + a drift test against the
  vendored payload (decision 15).
- W2 — the token rewrite: `design-tokens.js` adopts the Perch-derived palette, light-first with an
  OS-driven dark mode; glass retired end-to-end; public surfaces frozen on a legacy snapshot.
- W3 — the primitives + bypass sweep: the 11 shared primitives and the dashboard's hardcoded-color/
  radius bypasses move fully onto tokens; brand SVG art recolored.
- W4 — product fixes: Perch panel unattached guidance (Crow-side); tracker card faces show tags;
  plus the small board debts that fold into that touch.

**Deferred to later cycles under this spec:** the ~53 inline-CSS long-tail files converted panel by
panel; the 3 bundle web UIs (`capstone-tracker`, `maker-lab`, `pm-workspace`); the public blog +
songbook adoption (LAST, own review — see §4.1's freeze); Track 3's motifs (wire catenary, chibi
bird states, the roost strip) which belong to the board × Perch pilot.

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

Type: **Inter** (UI) + **JetBrains Mono** (code). Fraunces and the serif toggle retire with the
dashboard's adoption (decision here, §4.3); the frozen blog keeps its current fonts until the blog
wave decides its own typography.

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
  custom property exists in the payload block that `PERCH_TOKENS` doesn't name (both directions —
  an upstream addition is drift too).
- The change flow after this lands: palette evolution edits `PERCH_TOKENS` → the drift test fails →
  the pi-lab edit + `scripts/vendor-perch.mjs` + re-pin dance brings the payload back into
  agreement. The two-repo dance still exists per change, but it can never happen silently, and
  Crow's file is where the change is authored first.
- **Considered and rejected:** injecting a Crow-generated `<style>` override into the proxied Perch
  HTML (`servers/gateway/routes/extension-proxy.js` `proxyRes` has no body-rewrite today). It would
  remove the two-repo dance, but adds streaming body-rewrite machinery to a shared generic proxy,
  breaks Perch-standalone parity (the same payload would render differently inside vs outside
  Crow), and decision 15's text chose the drift-test shape explicitly.
- **Constraint honored:** no pi-lab checkout exists on crow (`vendor-perch.mjs` resolves
  `PI_LAB_DIR || ~/pi-lab`; `~/pi-lab` here is not a git repo). W1 asserts against the CURRENT
  vendored bytes, whose values `PERCH_TOKENS` copies — no vendor run is needed in this cycle, and
  nothing in this cycle edits the payload.

## 3. W2 — the token rewrite

### 3.1 Token names keep, values change

This is a **value rewrite, not a rename**. All `--crow-*` names survive (including the legacy
aliases at `design-tokens.js:68–78` — `--crow-bg`, `--crow-surface`, `--crow-text`, etc., which
resolve through `var()` and are consumed by bundles). Rationale: `tests/design-system.test.js`
guards names not values (its hardcoded must-exist list at :70–73 and the a11y/messages tests match
on token NAMES); 119 `var(--crow-x, #hex)` fallback sites and the alias chain all survive a value
rewrite untouched — though the stale hex fallbacks are swept in W3 for consistency.

### 3.2 The new values

Light becomes the `:root` base (Perch is light-first; today's file is dark-first — the blocks swap
roles). Derived values (marked *d*) fill Crow tokens Perch has no equivalent for; the two
adversarial review rounds check every text/bg pair for WCAG AA (≥4.5:1 body text, ≥3:1 large/UI).

| token | light (`:root`) | dark (media) | source |
|---|---|---|---|
| `--crow-bg-deep` | `#eef1f3` | `#131a1f` | sky |
| `--crow-bg-surface` | `#ffffff` | `#1b242b` | card |
| `--crow-bg-elevated` | `#f5f7f8` *d* | `#232e36` *d* | between sky and card |
| `--crow-border` | `#dde4e8` | `#2a353d` | line |
| `--crow-text-primary` | `#22303a` | `#e4ebef` | ink |
| `--crow-text-secondary` | `#5c6d79` *d* | `#8fa0ab` | dim (light darkened one step for AA on sky) |
| `--crow-text-tertiary` | `#6b7c88` | `#7d8f9a` *d* | dim |
| `--crow-text-muted` | `#8395a1` *d* | `#5f707b` *d* | dim family |
| `--crow-accent` | `#0e6b62` | `#4fbdb0` | teal |
| `--crow-accent-hover` | `#0b574f` *d* | `#6fd0c4` *d* | teal ±1 step |
| `--crow-accent-muted` | `#dcecea` | `#16322f` | teal-soft |
| `--crow-success` | `#2fa36b` | `#2fa36b` | alive |
| `--crow-error` | `#c14f2e` *d* | `#d1633e` | attn (light darkened for AA as text on white) |
| `--crow-warning` | `#a16207` *d* | `#d9a521` *d* | gold family, harmonized |
| `--crow-info` | `#3d7ea8` *d* | `#6aa9cc` *d* | cool slate-blue, distinct from accent |
| `--crow-brand-gold` | `#a16207` | `#d9a521` | folds into the warning family (see below) |

`--crow-brand-gold` stays as a name (consumed by art and badges) but shares the warning family's
values — the indigo-era `#fbbf24` reads as a different brand next to teal/terracotta. The wire
color is NOT a `--crow-*` token in this cycle; motif tokens arrive with Track 3.

Radius: `--crow-radius-card: 14px`, `--crow-radius-pill: 999px` (Perch's values, per the scope
table). W3 makes the primitives actually consume them (today `.card`/`.btn` hardcode 12px/8px).

Type tokens: `--crow-body-font: 'Inter', system-ui, sans-serif`; new `--crow-mono-font:
'JetBrains Mono', monospace` (today's code surfaces hardcode their mono stacks). `FONT_IMPORT`
(`design-tokens.js:7`) rewrites to Inter + JetBrains Mono only — the current import also carries
Source Serif 4 / Source Sans 3, which nothing in the repo uses (verified: zero references), and DM
Sans / Fraunces, which retire from the dashboard. The **7 hardcoded `<link>` font sites in
`layout.js`** (:227 render path + 6 standalone pages at :631,670,708,744,784,822 — a drifted second
copy of the font manifest) collapse to one shared constant so this can't drift again.

### 3.3 Theme mechanism: the OS decides

Decision 6 verbatim: "Both equal, no default." Implementation:

- The rewritten `design-tokens.js` emits light values on `:root` and dark values inside
  `@media (prefers-color-scheme: dark)` — exactly Perch's mechanism, which also dissolves the
  iframe mismatch found in exploration (Perch already follows the OS; today a `.theme-light`
  dashboard around an OS-dark Perch renders mixed).
- **The `.theme-light` class, the sidebar theme-toggle button (`layout.js:254–256, 277–289`), the
  `theme_dashboard_mode` per-surface override, and the `.theme-serif` axis all retire from the
  dashboard.** `theme-resolver.js` keeps serving the FROZEN blog path (§4.1) but the dashboard
  render path (`dashboard/index.js:849–864`, `layout.js:138`) stops reading mode/glass/serif
  entirely — the dashboard has no theme state.
- **Named consequence for Kevin (reversible):** there is no manual light/dark override in the
  dashboard after this. If living with OS-following surfaces a real need for a pin, a
  `prefers-color-scheme`-shaped override class can come back in a later wave — the token structure
  (media query wrapping a delegating block) should be written so a `.theme-force-light/dark` hook
  could be added without restructuring, but none ships now (YAGNI + decision text).

### 3.4 Glass retires end-to-end (decision 6)

Everywhere at once — glass is not frozen with the blog, it is removed:

- CSS blocks deleted: `design-tokens.js:80–119`; `layout.js:1265–1298`;
  `panels/extensions/css.js:398–417`; `settings/menu-renderer.js:179–181`;
  `blog-public.js:299–318` + class composition :332; `songbook-renderer.js` glass rules + the 3
  class-composition sites (:306, :474, :587). Orphan sweep afterward:
  `grep -rn "crow-glass-blur\|crow-bg-popup\|crow-border-popup\|theme-glass"` must come back empty
  outside docs history.
- Settings UI: the Glass checkbox and its shim leave `settings/sections/theme.js` (:22, :53–57,
  :84–86, :122); the section's remaining content is the blog-only controls (§4.1).
- MCP: `crow_blog_settings` drops the `theme_glass` param (zod :456, get :478, display :481, set
  :509) — a breaking tool-surface change, acceptable: the tool is ours and the feature is removed
  product-wide.
- **Settings migration** (net-new; the only precedent is
  `settings/migrations/llm-settings-migration.js` — follow its registration pattern): delete
  `blog_theme_glass` rows from BOTH `dashboard_settings` (global) and
  `dashboard_settings_overrides` (every `instance_id`). Absent key reads falsy at every read site
  (`=== "true"` is the only check), so deletion is the whole migration — no fallback value needs
  inventing. The same migration deletes the dashboard-only `blog_theme_dashboard_mode` override
  (the dashboard has no theme state after §3.3); `blog_theme_mode`, `blog_theme_blog_mode`, AND
  `blog_theme_serif` SURVIVE — the frozen blog still reads all three (§4.1, §4.3).
- Docs: `docs/superpowers/plans/2026-07-11-extensions-overhaul.md`'s standing instruction to
  "mirror every new surface into the `.theme-glass` block" gets a superseded-note; the F6a design
  docs likewise. (Doc edits, not deletions — they are history.)

## 4. Where the rewrite must NOT leak, and where it must reach

### 4.1 Public surfaces freeze (the blog is LAST, with its own review)

`blog-public.js:20`, `songbook-renderer.js:16`, and `bundles/knowledge-base/routes/kb-public.js:27–41`
all consume `design-tokens.js` today — an in-place value rewrite would repaint the PUBLIC blog the
moment it merges, violating the scope's wave order. So:

- New `servers/gateway/dashboard/shared/design-tokens-legacy.js`: a verbatim snapshot of today's
  `designTokensCss()` + `FONT_IMPORT` (minus the glass blocks, which retire everywhere), exported
  as `legacyDesignTokensCss()` / `LEGACY_FONT_IMPORT`, with a header comment naming it a frozen
  copy that dies in the blog wave.
- `blog-public.js` and `songbook-renderer.js` switch their imports to the legacy module and keep
  reading `blog_theme_mode` / `blog_theme_blog_mode` / serif for their own class composition
  (blog behavior unchanged except glass).
- `kb-public.js` points its dynamic import at the legacy module too, and its silent hardcoded
  fallback palette (:40) becomes a LOUD failure (log + minimal neutral styles) instead of a stale
  palette copy — the exploration flagged that fallback as a silent-fork hazard either way.
- A test pins the freeze: blog-rendered CSS must contain the legacy ground `#0f0f17` and must NOT
  contain the new `#eef1f3` ground (and inverse for the dashboard) — so nobody re-couples the
  imports without noticing.

### 4.2 W3 — primitives and the bypass sweep

The leverage is the primitives (scope §2.4). All CSS for them is token-driven already EXCEPT the
bypasses exploration found — each becomes a token consumer:

- `layout.js` `.card`/`.stat-card`/`.login-card` shadows: literal `rgba(99,102,241,…)` (indigo) at
  :1045, :1049, :1061 → `color-mix(in srgb, var(--crow-accent) N%, transparent)`.
- Radius literals: `.card`/`.stat-card`/`.login-card` `border-radius:12px` (:1042, :1059, :1210)
  → `var(--crow-radius-card)`; inputs/`.btn` `8px` (:1105, :1127, :1243) → `var(--crow-radius-pill)`
  where pill-shaped, `--crow-radius-card` where boxy — reviewed visually via the gallery.
- Alert tints `rgba(34,197,94,.1)` / `rgba(239,68,68,.1)` (:1197–1198, :1230–1232) →
  `color-mix` on `--crow-success`/`--crow-error`.
- `components.js` `section()` heading hardcodes `'Fraunces',serif` (:114) → `var(--crow-body-font)`
  (with weight/size adjustments for Inter headings); same for the other Fraunces hardcodes in
  `layout.js:114-equivalents, 1184, 1218`.
- `nest/css.js` (:222, :224, :227, :299) and `notifications.js` (:301, :401, :431, :519) literal
  indigo/navy → tokens.
- Brand SVG art recolored to the new palette (art is not CSS; hand-edit): `shared/crow-hero.js`,
  `shared/empty-state-icons.js`, `notifications.js:775–788` (the tamagotchi crow). The crow stays
  a crow; fills move from indigo/gold to ink/teal/gold-as-`#d9a521`.
- The 119 `var(--crow-x, #oldhex)` stale fallbacks: swept to the new values (mechanical,
  greppable), heaviest in `panels/messages/css.js` and `panels/contacts/html.js`. The contacts
  default group color literal (`api-handlers.js:305` `|| "#6366f1"`) → the new accent.
- Standalone pages that bypass tokens entirely — `setup-page.js:110,138`, `calls-page.js:228,268`
  — convert to `var(--crow-*)` with the token `<style>` included, or hand-recolor if including the
  token sheet is disproportionate; executor's call, named in the plan.
- The gallery panel (`panels/design-system.js`) keeps working by construction (it iterates token
  names); it gains a swatch row for the new `--crow-mono-font` + radius demo so the review can be
  visual.

`tests/design-system.test.js` continues to pass by construction (names unchanged); it gains a
value-level assertion that `:root` carries the new ground `#eef1f3` (pinning the flip actually
happened) and loses nothing.

### 4.3 What retires with Fraunces

The serif axis existed to force Fraunces. With Inter as the language: `.theme-serif` block deleted,
`blog_theme_serif` dashboard read deleted, the settings checkbox deleted (blog keeps serif via the
frozen legacy module — its `LEGACY_FONT_IMPORT` still carries Fraunces, and `songbook/blog` class
composition still reads the setting until the blog wave). `bundles/media/panel/media.js`'s 6 inline
`fontFamily: 'Fraunces'` literals → `var(--crow-body-font)`.

## 5. W4 — product fixes riding this cycle

### 5.1 Perch panel: say why the perch is empty (Crow-side)

Diagnosed 2026-08-15: launching Perch with no bot attached yields a silent, inert lens —
`perch_attached` is false for every bot, so the vendored UI renders no chat affordances and no
explanation (the vendored 403 handler exists but only fires on a race; the empty state is the real
gap). Fix WITHOUT touching the payload (no pi-lab on this machine, and the empty state is a
Crow-integration concern):

- `panels/perch.js` `renderRunning()` (:126–139): before emitting the iframe, count attached bots
  the same way the gateway does (`perchAttached(def)` — reuse the existing helper from
  `servers/gateway/routes/perch.js:175` by extracting it to a shared module rather than adding a
  third copy; exploration found it already duplicated verbatim in `perch-interactive-api.js:92`).
- Zero attached → render a callout ABOVE the iframe (not instead of it — the lens itself still
  works and shows its sessions view): "No bot has the Perch channel attached. In Bot Builder, open
  a bot → Gateways → choose 'Perch (dashboard chat)' → Save." with a link to the Bot Builder
  panel. EN + ES via `i18n.js` (`perch.unattachedTitle`, `perch.unattachedBody`,
  `perch.unattachedCta`), satisfying `tests/i18n-global-parity.test.js`.
- Test: panel render with zero attached defs contains the callout; with ≥1 attached def it
  doesn't.

### 5.2 Tags on tracker card faces

The kanban face already renders `tags` as pills (`bot-board/html.js:48–51`); the tracker face
(`trackerCardFaceHtml`, :102–158) never does, and the tracker query (:556) doesn't even SELECT
`tags`. Fix: add `tags` to that column list; render the same `bb-tags`/`bb-tag` pill block
(markup shared with the kanban face — extract the tag-pill builder rather than duplicating it)
into the tracker face beside `metaHtml`. CSS exists (`css.js:24–25`). Server-side render only —
`client.js` untouched (it never builds faces), so the no-backticks/double-escape constraints are
not in play; `tests/board-panel-config.test.js`'s parse test still guards the emitted script.
Test: tracker board render shows pills for a tagged item; kanban unchanged.

### 5.3 Board debts folding into the same touch (standing-small-debts list)

Fold into the board task, don't PR alone: `nowStamp()` ×3 and `hasArchivedAtColumn` ×4
duplications converge to one helper each; the duplicated terminal-stamping card/item block
likewise; `autonomy: null` bypassing validation (pre-existing) gets the missing null-check +
test; POST `/card/:id` with archived + bad status returns 409 (archived wins) not 400, + test.
`bot_sessions.plan_path` always-null (perch.js displays it) is NOT in this cycle — it is
perch-lens behavior that Track 3 reshapes anyway; noted, deferred.

## 6. Testing

- `tests/perch-token-drift.test.js` — §2, both directions, mutation-tested (change one
  `PERCH_TOKENS` hex → test fails).
- `tests/design-system.test.js` — passes by construction + the new ground-value pin.
- New freeze test (§4.1): dashboard CSS carries `#eef1f3`, blog CSS carries `#0f0f17`, and
  neither carries the other's ground.
- Glass orphan test: rendered dashboard/blog CSS contains no `theme-glass` and no glass-only
  token names; the settings migration's before/after proven on a scratch db (rows deleted from
  both tables, every instance_id).
- i18n parity (new keys), a11y-baseline (unchanged names), board-panel-config parse (unchanged
  emission), existing perch panel tests extended for §5.1.
- Contrast: the review rounds hand-check the §3.2 table's AA claims (no automated contrast gate
  in this cycle — a gallery-driven eyeball plus reviewer math; an automated check is a
  nice-to-have the plan may add if cheap).
- Suite floor 3380/0 (post-#292). Mutation-test every new test; 3×3 concurrent validation at the
  end.

## 7. Out of scope, restated

Long-tail panel conversion; bundle web UIs; blog/songbook adoption of the new language (they run
frozen legacy tokens from this cycle until then); Track 3 motifs (catenary wire, chibi bird, the
roost, Perch-stops-being-a-page); the Perch filesystem-sessions-lens question (Track 3); any
`PERCH_CSS`/payload edit (needs pi-lab, none needed here); r4-assistant's stale tool list
(instance data, Kevin-conditional); `bot_sessions.plan_path` (§5.3).

## Named decisions made in this spec (Kevin was not in the loop; each reversible)

1. **Value rewrite, not rename** (§3.1) — preserves tests, aliases, fallback sites.
2. **No manual light/dark override ships** (§3.3) — decision 6 read literally; structure leaves a
   hook for a later pin.
3. **Serif/Fraunces retires from the dashboard with the language; blog keeps it frozen** (§4.3).
4. **brand-gold re-values into the warning/gold family** (`#a16207`/`#d9a521`) rather than keeping
   indigo-era `#fbbf24` (§3.2).
5. **Glass dies everywhere at once** including the otherwise-frozen blog (§3.4) — it is a decided
   retirement, not a repaint wave.
6. **`crow_blog_settings` drops its `theme_glass` param** (breaking MCP surface, ours) (§3.4).
7. **kb-public's silent fallback becomes a loud failure** (§4.1).
8. **The `perch_not_attached` fix is Crow-side panel UX**, not a vendored-payload change (§5.1).
