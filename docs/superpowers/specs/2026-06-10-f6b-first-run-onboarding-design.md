# F6b — Guided First-Run Onboarding (design)

**Status:** approved (brainstorming) — ready for writing-plans
**Date:** 2026-06-10
**Part of:** Crow v1 refoundation. Follows F6a (design-system foundation); precedes F6c (connect-to-clients wizard) and F7 (docs/GitHub).
**Repo:** `/home/kh0pp/crow`, branch off `main` @ `e655672`.

## Problem

A brand-new self-hosted Crow user, immediately after setting their dashboard password, lands directly on the first dashboard panel (today `POST /dashboard/login` → `/dashboard` → first visible panel, `servers/gateway/dashboard/index.js:189-190` and the home redirect at `:690-695`). There is **no guided first-run** — nothing explains what Crow is or points them at the few things worth setting up (integrations, a bot, connecting an AI client). The Settings → Help & Setup section exists but is post-auth reference material, not a guided flow, and a new user has no reason to find it.

The pieces a user needs already exist as separate post-auth surfaces (Settings → Integrations, Bot Builder, Help & Setup / Connections). What's missing is the **orientation layer** that introduces them in sequence on first run.

## Decision summary (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| What the flow does | **Orient & route** (not do-it-inline) | No `.env` writes, no per-run gateway restart, no duplication of the existing `wizard-web.js` or of F6c. Leans on existing surfaces. |
| Re-entry | **Auto once + replayable via link** | Shows automatically after first password set; also reachable anytime from Settings → Help & Setup. No completion-tracking DB flag needed. |
| Language | **Bilingual EN/ES** | Matches the setup-page and login it sits between. |
| Step navigation | **Server-side `?step=N`** | No client JS, refresh/back-safe, trivially testable, matches how the rest of the dashboard renders. |

## Non-goals (explicit — keeps the orient-and-route decision honest)

- **No inline configuration:** no API-key entry, no bot creation, no MCP token generation, no `.env` writes, **no gateway restart** triggered by the flow.
- **No connect wizard:** step 3 ("Connect a client") is a thin pointer only. The polished connect-to-clients flow (token management, copy-paste `~/.claude/mcp.json` snippets, per-client tabs) is **F6c** and must not be duplicated here.
- **No managed-hosting 2FA path:** the trigger fires only on the self-hosted first-run success path. The managed-hosting first-run path that diverts to 2FA setup (`index.js:183-187`) keeps landing in `/dashboard`. Onboarding-after-2FA is a possible future follow-up, not v1.
- **No new DB tables or columns**, no `init-db` change.

## Architecture

One new hidden dashboard panel plus two small wiring touch-points.

### New file: `servers/gateway/dashboard/panels/onboarding.js`

A hidden panel modeled exactly on `panels/design-system.js`:

```
export default {
  id: "onboarding",
  name: "Onboarding",       // literal; never shown (hidden panel), so no i18n nav key needed
  route: "/dashboard/onboarding",
  hidden: true,             // reachable by URL, not in the sidebar
  navOrder: 96,             // adjacent to design-system (95); irrelevant while hidden
  category: "tools",
  async handler(req, res, { layout, lang }) { ... }
}
```

The handler:
1. Resolves language **cookie-first** (see Language section), overriding the panel-supplied `lang`.
2. Parses and **clamps** `step` from `req.query.step` into `[0, STEPS.length-1]` (junk/out-of-range → a valid in-range page, never a throw).
3. Renders `stepper(STEPS, current)` + the current step's `section()` (explainer + optional `callout()` + deep-link `button()`s with `target="_blank"`) + a nav row (Back · Skip to dashboard · Next/Finish).
4. Returns `layout({ title, content })` — the standard dashboard chrome, consistent with `design-system.js`.

Registered once in `index.js` alongside the other `registerPanel(...)` calls (the block around `:90-104`), importing the default export like `designSystemPanel`.

### Touch-point 1 — trigger (`servers/gateway/dashboard/index.js`, `POST /dashboard/login`)

In the first-time-setup branch (`:133`), capture the fact that this request just created the password **before** `setPassword()` runs:

```
const wasFirstSetup = !hasPassword;   // computed at the top, before setPassword()
...
setSessionCookie(res, result.token);
res.redirectAfterPost(wasFirstSetup ? "/dashboard/onboarding" : "/dashboard");   // was: "/dashboard"
```

Only the non-2FA success path (`:189-190`) is changed. The `needs2faSetup()` branch (`:183-187`) is untouched (see non-goals). A normal returning-user login (`wasFirstSetup === false`) still goes to `/dashboard` exactly as today.

### Touch-point 2 — replay link (`servers/gateway/dashboard/settings/sections/help-setup.js`)

Add a small bilingual "Replay setup guide" link/button → `/dashboard/onboarding?step=0` within the Help & Setup section render. This section already resolves `currentLang` cookie-first and uses `t()`, so the link uses a new `onboarding.replayLink` key.

## The five steps (orient & route)

`STEPS` is an array of `{ key }` whose labels come from i18n (`onboarding.step{N}Title`). Each rendered step shows the stepper, a `section()`, optional `callout()`, deep-link button(s) opening in a **new tab**, and the nav row.

| # | Step (i18n key stem) | Body | Deep-link(s) (`target="_blank"`) |
|---|---|---|---|
| 0 | `welcome` | What Crow is — a persistent memory + research assistant usable across AI clients. "This short tour points you at the few things worth setting up." | none (Next / Skip only) |
| 1 | `integrations` | Connect Google, Slack, GitHub, etc. so Crow can act on them. `callout(info)`: keys are entered in Settings; some integrations need a gateway restart. | **Open Integrations** → settings (Integrations section) |
| 2 | `bot` | Crow can run Gmail/Discord/etc. bots with their own persona + skills. | **Open Bot Builder** → `/dashboard/bot-builder` |
| 3 | `connect` | Use Crow from Claude Code / claude.ai / other clients via MCP. `callout(info)`: a guided connect wizard is coming (F6c); for now see the connection URLs. | **Connection URLs** → settings (Help & Setup section) |

> **Deep-link targets to verify during planning:** steps 1 and 3 point into the Settings panel's Integrations and Help & Setup sections. Confirm whether the settings panel supports anchor fragments (e.g. `/dashboard/settings#integrations`) by inspecting the section-id scheme; if it does, use the fragment, otherwise fall back to plain `/dashboard/settings`. Do not assert the anchor works — verify it. The Bot Builder target (`/dashboard/bot-builder`) is a top-level panel route and is safe.
| 4 | `done` | `callout(success)` — you're set. Replayable anytime from Settings → Help & Setup. | **Go to the dashboard** → `/dashboard` (primary button) |

Navigation:
- **Next →** / **Finish** → `?step=current+1`; on the last step the primary button goes to `/dashboard`.
- **Back** → `?step=current-1` (hidden on step 0).
- **Skip to dashboard** → `/dashboard` (present on every step except the last).
- Deep-link buttons open in a new tab so the linear flow is preserved.

## Language resolution (bilingual)

- New `onboarding.*` namespace added to `servers/gateway/dashboard/shared/i18n.js` (~25-30 keys: per-step `step{N}Title` + `step{N}Body`, callout strings, `btnNext`/`btnBack`/`btnSkip`/`btnFinish`/`btnGoDashboard`, the deep-link button labels, and `replayLink`). Every key carries both `en` and `es`, following the existing flat-key convention. HTML uses `t()`; any JS-string context uses `tJs()`.
- The panel-dispatch `lang` (`index.js:749`) derives from the DB `language` setting, which a brand-new user hasn't set (→ `en`). The setup/login pages honor the **`crow_lang` cookie**. So the onboarding handler resolves lang **cookie-first**, mirroring `help-setup.js` (`DB language ... || parseCookies(req).crow_lang || "en"`), so a user who chose ES at setup gets ES onboarding. This deliberate deviation from the stock panel `lang` is documented in the handler.

## Design-system / tokens

All spacing and type use F6a tokens (`var(--crow-space-*)`, `var(--crow-text-*)`); no hardcoded px. The F6a token-completeness test (`tests/design-system.test.js`) already walks the whole dashboard tree, so the new panel is covered automatically. Mind the scanner gotcha: never write a literal `var(--crow-<alnum>${...})` (even in a comment) — use complete-literal token references. Primitives used: `stepper`, `section`, `callout`, `button` (all from `shared/components.js`, confirmed present).

## Testing (`tests/onboarding.test.js`, `node --test`)

Modeled on `tests/design-system.test.js` (invoke the handler with a stubbed `layout`, assert on markers):

1. **Renders every step** — for `step` 0..4, handler returns HTML containing the `stepper` markup and that step's expected deep-link / primary action marker.
2. **Step clamping** — `?step=-1`, `?step=99`, `?step="abc"` each render a valid in-range page without throwing.
3. **Panel identity** — `id === "onboarding"`, `route === "/dashboard/onboarding"`, `hidden === true`.
4. **i18n parity (new)** — every `onboarding.*` key in `i18n.js` has a non-empty `en` and a non-empty `es` value. Mechanically guards the bilingual requirement.
5. **Bilingual render** — handler with a Spanish `crow_lang` cookie produces ES copy (assert a known ES string appears); with no cookie / `en`, English copy.

(The existing `design-system.test.js` token test transitively covers the new panel's token usage.)

## Files touched

| File | Change |
|---|---|
| `servers/gateway/dashboard/panels/onboarding.js` | **new** — hidden panel, 5-step `?step` flow |
| `servers/gateway/dashboard/index.js` | register panel; first-run redirect to `/dashboard/onboarding` |
| `servers/gateway/dashboard/shared/i18n.js` | new `onboarding.*` EN/ES keys |
| `servers/gateway/dashboard/settings/sections/help-setup.js` | bilingual "Replay setup guide" link |
| `tests/onboarding.test.js` | **new** — 5 test groups above |
| `docs/architecture/dashboard.md` | brief note that onboarding is a hidden panel triggered on first-run + replayable from Help & Setup |

## Deploy

CSS/JS/panel registration load at **startup** (the panel is imported and registered when the gateway boots, like F6a). So deploy = `git pull` + **gateway restart**, attended, one host at a time, verify-after (`systemctl is-active`, `NRestarts=0`, `/dashboard`→403/303, `/health`→200; black-swan starts slowly). No `init-db`. The 4 prod bots run as separate `pibot-*@crow-mpa` units and are unaffected by gateway restarts. To prove the change is live, the panel is reachable at `/dashboard/onboarding` (behind auth) and the redirect only matters on a fresh instance — verification will assert the panel renders and the redirect-target logic via the test, plus a manual check that the registered route resolves.

## Risks / edge cases

- **Returning-user login must be unaffected.** `wasFirstSetup` is false for every non-first login → unchanged `/dashboard` redirect. Covered by reading the branch carefully; the change is a single ternary on a captured boolean.
- **Clamping** prevents a malformed `?step` from throwing (tested).
- **New tab deep-links** mean the onboarding tab stays open; the user can continue the tour after exploring a surface.
- **Replay link** must not appear pre-auth (it lives inside the post-auth Help & Setup section, so this is automatic).
