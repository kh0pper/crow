# F6a — Design-System Foundation (design)

**Date:** 2026-06-10
**Status:** Approved (design); spec under review
**Roadmap:** Refoundation F6, sub-project **a** (of F6a design-system → F6b onboarding → F6c connect-to-clients). Follows F4b (`origin/main`@`98cddba`). F7 (docs/GitHub) later rides on this + F6c.
**Master plan:** `~/.claude/plans/when-i-click-on-woolly-elephant.md`.

## Problem

The dashboard has a *partial* design system. Color/theme tokens are solid (`servers/gateway/dashboard/shared/design-tokens.js` — dark/light/glass/serif variants), and a small set of HTML primitives exist (`shared/components.js`: `statCard`, `statGrid`, `dataTable`, `formField`, `badge`, `actionBar`, `section`). But:

1. **No spacing or type scale.** Spacing and font sizes are hardcoded inline throughout (`margin-bottom:1rem`, `font-size:0.8rem`, `0.35rem`, …), so there is no consistent rhythm and no single place to tune it.
2. **A latent token bug.** `--crow-text-tertiary` is referenced in `components.js` (login/2FA views) but is **never defined** in `design-tokens.js` — it silently falls back. Nothing catches used-but-undefined tokens.
3. **Missing primitives.** There is no shared `button`, copy-to-clipboard code block, callout/notice, stepper, or tabs. The upcoming F6b (onboarding wizard) and F6c (connect-to-clients wizard) need exactly these — without them each would invent its own, re-introducing inconsistency.

F6a is the **substrate** F6b and F6c render through. It is scoped to deliver exactly what those need plus fix the existing gaps — **not** a blind refactor of every panel.

## Goals

1. Add the missing **token scales** (spacing, font-size, line-height) and **fix `--crow-text-tertiary`**.
2. Add the **primitives** F6b/F6c need: `button`, `codeBlock` (with copy), `callout`, `stepper`, `tabs`.
3. Migrate **`components.js`** off hardcoded inline spacing/sizing onto the new tokens.
4. A **live gallery panel** in the dashboard that renders every token + primitive variant (also the manual QA surface).
5. **Documentation** (`docs/developers/design-system.md`) cataloguing tokens + primitives + the "use tokens, not hardcoded px" convention.
6. A **token-completeness test** that fails on any used-but-undefined `--crow-*` token, plus primitive render tests.

## Non-goals

- **No full per-panel consolidation.** The ~20 panels' own `<style>` blocks and inline styles are left as-is. (Explicitly deferred — the "full consolidation" option was declined.)
- No new theme, no color/palette redesign, no font changes.
- No change to Turbo Drive / layout shell behavior.
- No migration of panels other than the shared `components.js` to the new primitives (panels may adopt them later, opportunistically).

## Design

### 1. Token additions — `shared/design-tokens.js`

Extend `designTokensCss()`. The new scales are **theme-independent** (sizing doesn't change per theme), so they go in a single `:root` block alongside the existing radius tokens:

```css
:root {
  /* Spacing scale (4px base) */
  --crow-space-1: 4px;  --crow-space-2: 8px;  --crow-space-3: 12px;
  --crow-space-4: 16px; --crow-space-5: 24px; --crow-space-6: 32px;
  --crow-space-8: 48px; --crow-space-10: 64px;
  /* Type scale */
  --crow-text-xs: 0.75rem;  --crow-text-sm: 0.8125rem; --crow-text-base: 0.875rem;
  --crow-text-md: 1rem;     --crow-text-lg: 1.125rem;  --crow-text-xl: 1.25rem;
  --crow-text-2xl: 1.5rem;  --crow-text-3xl: 2rem;
  /* Line-height */
  --crow-leading-tight: 1.2; --crow-leading-normal: 1.5; --crow-leading-relaxed: 1.7;
}
```

`--crow-text-tertiary` is added to **every theme block** (`:root`, `.theme-light`, `.theme-glass`, `.theme-glass.theme-light`) as a step between `secondary` and `muted` (e.g. dark `#8b8680`, light `#78716c`, glass `rgba(255,255,255,0.45)`). Exact values chosen to read correctly against each theme's background; verified in the gallery panel.

### 2. New primitives — `shared/components.js` (HTML) + new `shared/components-css.js` (CSS)

Add HTML template functions to `components.js`. Their CSS goes in a **new focused module `shared/components-css.js`** exporting `componentsCss()` (a CSS string), imported once into `dashboardCss()` in `layout.js` (a one-line addition) so the new CSS stays out of that already-large blob and is independently testable. All sizing/spacing in the new CSS uses the tokens from §1.

| Primitive | Signature | Notes |
|---|---|---|
| `button` | `button(label, opts)` | `opts.variant` ∈ primary\|secondary\|danger\|ghost (default primary); `opts.size` ∈ sm\|md (default md); `opts.href` renders `<a class="btn">`, else `<button>`; `opts.type`, `opts.name`, `opts.attrs`. Class `btn btn-<variant> btn-<size>`. |
| `codeBlock` | `codeBlock(text, opts)` | `<pre>` with a copy button; `opts.lang` label; `opts.multiline`. Copy uses a tiny inline `navigator.clipboard.writeText` handler keyed off a `data-copy` attribute — **one** delegated listener shipped in `componentsCss()`'s sibling JS (see §2a). Text is HTML-escaped. |
| `callout` | `callout(content, type)` | `type` ∈ info\|success\|warning\|error (default info); left-accent-bordered notice using the matching `--crow-success/error/info/accent` token. `content` is caller-supplied HTML (not escaped — caller's responsibility, matches `dataTable`/`section`). |
| `stepper` | `stepper(steps, current)` | `steps` = array of `{label}`; `current` = 0-based index. Renders numbered circles + labels, with done/active/upcoming states. Pure display (no nav logic). |
| `tabs` | `tabs(items, opts)` | `items` = `[{id,label,content}]`; renders tab buttons + panels; `opts.active` default 0. Tab switching via a small delegated click handler (§2a). Used by F6c for per-client tabs. |

#### 2a. Minimal client JS for `codeBlock` copy + `tabs` switching

`components-css.js` also exports `componentsJs()` — a small `<script>` string with **delegated** listeners (one `click` handler on `document` that handles `[data-copy]` and `[data-tab]`), injected once by `layout.js` alongside `dashboardCss()`. Delegated (not per-element) so it works with Turbo Drive navigations and dynamically rendered content. No framework, no inline `onclick`.

### 3. Migrate `components.js` to tokens

Replace hardcoded inline spacing/sizing **within `components.js`** with the new tokens (e.g. `margin-bottom:1rem` → `var(--crow-space-4)`, `font-size:0.8rem` → `var(--crow-text-sm)`). Behavior-preserving (the px values map to the equivalent token). Scope is `components.js` only — no other files' inline styles are touched.

### 4. Gallery panel — `dashboard/panels/design-system.js`

A read-only dashboard panel (registered via the existing panel pattern; route under `/dashboard/`) that renders, using the real layout + tokens:
- Every token: color swatches per theme, the spacing scale, the type scale, line-heights.
- Every primitive in all variants (button variants/sizes, callout types, a live `codeBlock` with a working copy button, a `stepper` mid-flow, a `tabs` group, plus the existing `statCard`/`dataTable`/`badge`/`formField`).

It is the living QA surface for F6b/F6c and for theme work. Read-only, no mutations, behind dashboard auth like every other panel (not Funnel-public).

### 5. Documentation — `docs/developers/design-system.md`

Catalogs: the token scales (names + values + when to use), each primitive (signature + a usage snippet + rendered-look note pointing at the gallery panel), and the **convention**: new dashboard UI uses tokens (`var(--crow-space-*)`, `var(--crow-text-*)`) and the shared primitives rather than hardcoded px / bespoke buttons. Notes that full per-panel migration is out of scope (opportunistic later).

### 6. Testing — `tests/design-system.test.js` (`node:test`)

- **Token-completeness guard:** collect every `var(--crow-<name>)` referenced across `servers/gateway/dashboard/**` (+ `blog-public` which also consumes tokens), collect every `--crow-<name>:` defined in `design-tokens.js` + `components-css.js`, and assert the referenced set ⊆ defined set. Fails on any undefined token (regression guard; directly covers the `--crow-text-tertiary` bug). Allow a small explicit ignore-list only if a token is intentionally computed.
- **Primitive render tests:** each new primitive returns expected HTML — `button` emits the right `btn-<variant>` class and switches `<a>`/`<button>` on `href`; `codeBlock` escapes its text and includes a `data-copy` trigger; `callout` applies the type class; `stepper` marks done/active/upcoming correctly; `tabs` renders one panel per item and marks the active one. HTML-escaping asserted where inputs are escaped.
- **Gallery panel smoke:** the panel module renders to a non-empty HTML string containing each primitive's marker class without throwing.

## Components & boundaries

| Unit | Responsibility | Depends on | Consumers |
|---|---|---|---|
| `shared/design-tokens.js` | CSS custom properties (now incl. spacing/type/leading + `--crow-text-tertiary`) | — | layout, blog, components-css, gallery |
| `shared/components.js` | HTML template fns (existing + button/codeBlock/callout/stepper/tabs) | escapeHtml | panels, F6b, F6c, gallery |
| `shared/components-css.js` (new) | `componentsCss()` + `componentsJs()` for the new primitives | tokens | layout.js (`dashboardCss`) |
| `dashboard/panels/design-system.js` (new) | Live gallery/QA panel | components, tokens | dashboard nav |
| `docs/developers/design-system.md` (new) | The catalogue + convention | — | developers |
| `tests/design-system.test.js` (new) | Token-completeness + render guards | components, design-tokens | `node --test` |

## Data flow

`design-tokens.js` (tokens) + `components-css.js` (component CSS/JS) → injected by `layout.js` `dashboardCss()` into every dashboard page → primitives in `components.js` emit class-based HTML that those styles target → panels (and F6b/F6c, and the gallery) call the primitives. No DB, no routes beyond the gallery panel's read-only render, no runtime state.

## Error handling

Pure render functions: defensive on missing/empty inputs (empty label, missing opts) — return valid HTML, never throw (mirrors existing `components.js` tolerance, e.g. `actionBar`). The copy handler degrades gracefully if `navigator.clipboard` is unavailable (no-op + no error). The token-completeness test is the guard against silent token drift.

## Testing strategy

`node:test` only (repo convention; no UI test framework). The three test groups above. Manual QA via the gallery panel across themes (dark/light/glass). Existing `tests/auth-network.test.js` stays green (no route/auth changes beyond a standard read-only panel).

## Risks & mitigations

- **Token-completeness test false positives** (a `var()` in a comment or a dynamically-built token name) → restrict the scan to `var(--crow-…)` literals and maintain a tiny documented ignore-list if truly needed; start with zero and only add with justification.
- **Injecting `componentsJs()` twice / double-binding** → single delegated listener guarded by a `window.__crowComponentsBound` flag; injected once in `dashboardCss()`'s sibling, idempotent under Turbo.
- **Gallery panel drifting from reality** → it imports and renders the real primitives/tokens (no copies), so it can't drift; the smoke test asserts it renders.
- **Scope creep into per-panel refactor** → explicit non-goal; the migration step touches only `components.js`.

## Open questions

None — scope (foundation), primitive set (button/codeBlock/callout/stepper/tabs, all in), and the gallery panel (build now) are all decided.
