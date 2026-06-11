# W3-4 + W3-5a — Error-UX unification + a11y baseline

**Date:** 2026-06-11
**Findings:** W3-4 + W3-5 (sliced) in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md). Vision: resilient & forgiving — plain language, no dead-end failures; layered disclosure. **Deliberate re-scope:** i18n'ing the three giant panels moves into Wave 4's panel splits (doing it before splitting = double work); the `design-system` panel's strings stay EN (hidden QA tool — accepted).

## W3-4 scope (from the 2026-06-11 inventory)

1. **One global toast helper** in the layout (available to every panel): `crowToast(message, { type: "error"|"success", details })` — design-token styled, fixed-position container rendered once in layout with `aria-live="polite"`, auto-dismiss 6s (errors 8s), click-to-dismiss, optional `details` rendered in a native `<details>` (the legibility layer). Coexists with Turbo Drive (container lives in the persistent layout; re-binding safe on visits).
2. **Replace the 7 `alert()` error sites** (blog.js:358,371; bot-builder.js:1555; bot-board.js:1211,1212,1217,1218) with `crowToast(..., {type:"error"})`, messages i18n'd (en+es) via the established `tJs` pattern.
3. **i18n the EN-hardcoded `confirm()` strings** (bot-builder.js:1393,1401,1548; bot-board.js:1127,1135,1184; projects.js:429; orchestrator.js:205) — keep `confirm()` itself (a modal system is out of scope), translate the text.
4. **Orchestrator raw-JSON humanization** (orchestrator.js:106-107,164-174): known fields render as labeled values ("Tokens in: 5,000"); unknown objects render as aligned `key: value` lines — never raw JSON.stringify blobs.
5. **Top silent-catch fixes (user-clicked actions only):** bot-board drawer/card/plan/tracker-item fetch failures → error toast ("Couldn't load — try again"); tracker items fetch (bb:1347) → toast; extensions registry double-failure → inline banner ("Extensions service unavailable"). All i18n'd.

## W3-5a scope

6. **`:focus-visible` baseline** in `shared/components-css.js`: buttons (.btn*), links in nav, inputs — `outline: 2px solid var(--crow-accent); outline-offset: 2px` (match the two existing focus-visible precedents).
7. **aria-labels on icon-only buttons:** bot-board column toggles (:763), drawer close (:797), notification dismiss buttons (notifications.js:378), plus any found by a sweep of `<button` with single-glyph content in panels/.
8. **`aria-live="polite"`** on the notifications dropdown list container.

## Testing
- Extend `tests/design-system.test.js` (or a new `tests/a11y-baseline.test.js`): components-css contains `:focus-visible` rules; layout HTML contains the toast container with aria-live; new i18n keys have en+es (key-list test like tests/onboarding.test.js's).
- Full suite green; disposable boot; post-deploy manual smoke (trigger a failing action → toast appears).
- No schema changes; deploy = pull + restart.
