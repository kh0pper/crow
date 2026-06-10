# F6c-1 — Connect-to-Clients Wizard (design)

**Date:** 2026-06-10
**Layer:** v1 refoundation, F6c (decomposed: **F6c-1 = this UI wizard**, F6c-2 = token backend, later/separate spec)
**Status:** design approved (brainstorming), pending spec review → writing-plans

## Problem

Connecting an MCP client (Claude Code, Cursor, Gemini CLI, etc.) to a Crow instance works, but the guidance is scattered and thin:

- **Connections** settings section (`settings/sections/connections.js`) — a read-only table of gateway URLs + 4 MCP endpoint URLs. Correctly derives the reachable base URL from the request host.
- **Help & Setup** settings section (`settings/sections/help-setup.js`) — an 8-platform list where each entry is one line of prose + a link out to maestro.press, plus a context-usage stats block. No copy-paste config, no copy buttons.
- **`npm run mcp-config`** (CLI only, `scripts/generate-mcp-config.js`) — emits a real `.mcp.json`, but is invisible from the dashboard.
- **F6b onboarding step 3** ("Connect a client") is a placeholder that deep-links to Help & Setup and tells the user "a guided connect wizard is on the way."

F6c-1 builds that guided wizard: one discoverable surface with copy-paste, per-client config.

## Key reconnaissance findings (load-bearing — these shaped the scope)

1. **`CROW_LOCAL_MCP_TOKEN` authenticates nothing server-side.** Repo-wide grep shows only the build script `generate-mcp-config.js` reads it; the gateway never does. `/router/mcp` accepts exactly two credentials: OAuth access tokens (`oauth_tokens` table) and paired-instance tokens (`crow_instances.auth_token_hash`). A request bearing `CROW_LOCAL_MCP_TOKEN` is hashed, missed in `oauth_tokens`, and **401s**. `crow-gateway` runs with auth on (`npm run gateway`, no `--no-auth`). Confirmed three ways (grep, auth-chain trace, running-service config).
   - **Consequence:** making a dashboard-shown/generated token actually work is a *backend auth feature* (new verifier branch + token store + `.env` write + security pass), not UI. That work is **F6c-2**, with its own security review. F6c-1 does **not** touch auth and does **not** display the token.
2. **OAuth already works for remote HTTP clients.** The gateway supports dynamic client registration (`/register`) + authorization-code flow. A client like Claude Code pointed at `/router/mcp` over HTTP runs the OAuth handshake on first use — **no token needed**. This is F6c-1's remote-connection story.
3. **Cloud web clients cannot reach a private Crow.** The network-exposure invariant (CLAUDE.md) forbids MCP/dashboard on Tailscale Funnel; a Tailnet-only Crow is unreachable from Anthropic/OpenAI servers. So claude.ai-web / ChatGPT-web cannot connect to a private instance. The wizard states this honestly rather than showing a config that times out.
4. **`.env`-write precedent exists** (`env-manager.js` `writeEnvVar`, used by `settings/sections/integrations.js`) — relevant to **F6c-2**, not used in F6c-1.

## Goals

- One discoverable, guided surface for connecting a client, with **copy-paste config + copy buttons** per client.
- Cover the two connection styles that work **today, with no token**:
  - **Local stdio** — `npm run mcp-config` in a checked-out repo, then restart the client.
  - **Remote HTTP via OAuth** — paste an `http` server entry pointing at this instance's `/router/mcp`; the client does OAuth on first use.
- Be **honest about reachability**: lead with local/Tailnet clients; mark cloud web clients as not-connectable to a private Crow.
- Consolidate the scattered guidance; fulfill F6b step 3's promise.
- Bilingual EN/ES; crow.md copy rules; server-rendered, no new client JS.

## Non-goals (explicit)

- **No token surfacing** (display, generate, rotate, revoke) — all deferred to F6c-2.
- **No server-side auth changes**, no `.env` writes, no DB schema/`init-db` changes.
- No new env vars; no Tailscale-IP detection (reuse request-host derivation).
- No changes to `generate-mcp-config.js` behavior (the wizard *documents* it, does not alter it).

## Architecture

A new **hidden panel**, mirroring the F6b onboarding / design-system pattern exactly.

- **File:** `servers/gateway/dashboard/panels/connect.js`
- **Route:** `/dashboard/connect`, `hidden: true` (reachable by URL + deep-link, not in the sidebar — same as `onboarding.js:74`, `design-system.js:65`).
- **Rendering:** server-side HTML using the F6a primitives in `shared/components.js` — `section`, `tabs(items,{active})`, `codeBlock(text,{lang})` (copy-to-clipboard built in), `callout(content,type)`, `button(label,{href,variant,attrs})`. The only client-side behavior is the already-shipped delegated handlers for tab switching and code copy (in `components-css.js`); no new JS.
- **Base URL:** `${req.protocol}://${req.get("host")}` — the address the operator is actually browsing from, i.e. the reachable one. Reuses the established pattern from `connections.js:23`. No env var.
- **Language:** cookie-first resolution (`parseCookies(req).crow_lang`) consistent with help-setup/onboarding; fall back to the `dashboard_settings` language row / `"en"`.

### Panel content

Header `section` ("Connect a client") + a one-line orienting sentence, then a `tabs()` strip ordered by what works on a private Crow first:

| Tab | Style shown | Notes |
|---|---|---|
| **Claude Code** | (a) Local stdio: `npm run mcp-config` → restart. (b) Remote HTTP+OAuth: `~/.claude/mcp.json` / `.mcp.json` `http` entry → OAuth on first use. | Both token-free. Primary tab, `active:0`. |
| **Cursor** | Remote HTTP+OAuth: `.cursor/mcp.json` `url` entry. | |
| **Cline** | VS Code MCP settings → add the HTTP server URL. | |
| **Gemini CLI** | `~/.gemini/settings.json` `url` entry. | |
| **Claude Desktop** | Local stdio via the generated config (needs the repo). | |
| **claude.ai / ChatGPT (web)** | ⚠ `callout` only — no config. Explains a private Crow is Tailnet-only, unreachable from cloud servers, and Funnel-exposing MCP is forbidden by the network-exposure invariant. | Honesty over a dead config. |

Each non-cloud tab = a short lead sentence that folds the one-or-two steps inline ("run X, then restart Y") + one or more `codeBlock()` snippets (the copy-paste config, with the live base URL interpolated) + an optional `callout` for the key gotcha (e.g. "stdio needs the repo checked out on this machine"; "first HTTP use opens a browser for OAuth"). (The steps are short enough that a sentence reads cleaner than a numbered `<ol>` and needs fewer i18n keys.)

A trailing `section` with `button`s deep-linking to the **Connections** section (raw URLs) and the maestro.press platform docs, for users who want more.

### Consolidation (touch, don't duplicate)

- **`panels/onboarding.js`** — step 3's deep-link flips from `/dashboard/settings?section=help-setup` to `/dashboard/connect`; the placeholder copy ("a guided connect wizard is on the way") becomes a real invitation. Reuse the existing `onboarding.openConnections` label key (re-point only its `href`); update step 3's body copy EN/ES in place (no key renames, to keep the parity test stable).
- **`settings/sections/help-setup.js`** — the 8-platform `<ul>` is replaced by a one-line pointer + a `button`/link to `/dashboard/connect`. The **context-usage stats block stays** (it is not connect-config). Preview text ("8 platforms") updated.
- **`settings/sections/connections.js`** — keeps its URL/endpoint tables; gains the same one-line pointer to `/dashboard/connect`.

### i18n

New `connect.*` keys (EN/ES) in `shared/i18n.js` for: panel title, orienting sentence, per-tab labels, step text, gotcha callouts, the cloud-client warning, and the trailing links. `translations` is already exported, so the parity test asserts `es` presence directly. All copy follows crow.md rules (no em dashes; no "not X but Y").

## Files

**Create**
- `servers/gateway/dashboard/panels/connect.js` — the panel.
- `tests/connect.test.js` — unit tests.

**Modify**
- `servers/gateway/dashboard/panels/onboarding.js` — step 3 deep-link + copy.
- `servers/gateway/dashboard/settings/sections/help-setup.js` — slim platform list to a pointer; keep stats.
- `servers/gateway/dashboard/settings/sections/connections.js` — add pointer.
- `servers/gateway/dashboard/shared/i18n.js` — `connect.*` EN/ES keys + onboarding step-3 copy.
- `docs/architecture/dashboard.md` — document the new panel (per CLAUDE.md "codebase shape changed → CLAUDE.md/docs").

**No `init-db`, no schema, no auth, no env, no `generate-mcp-config.js` changes.**

## Testing

`tests/connect.test.js` (Node's built-in `node --test`, F6b convention), asserting:

- Panel registers, is `hidden:true`, route `/dashboard/connect`.
- All client tabs render; the primary tab is active.
- Each non-cloud tab's snippet **embeds the request host** (render with a mock `req` whose host is e.g. `crow.example.ts.net:8444` and assert the URL appears, not `localhost` hardcoded).
- The cloud-client tab renders the warning `callout` and contains **no** copy-paste server URL.
- **No token** string is emitted anywhere in the panel (regression guard for the F6c-2 boundary).
- EN/ES parity for all new `connect.*` keys (and that ES actually differs from EN where it should, per the F6b parity-test approach).

The existing `tests/design-system.test.js` token-scanner auto-covers the new dashboard file (use complete-literal `var(--crow-...)` token refs — see the F6b interpolation gotcha).

## Deploy

Panel + any CSS/strings load at **startup** (panel registration), so deploy = `git pull` + **gateway restart** + verify (like F6a/F6b, unlike F4b's per-request read). Restart `crow-gateway` (:3001) + `crow-mpa-gateway` (:3006) on crow, `crow-gateway` on grackle (:3002), `crow-gateway` on black-swan (:3001, slow ~6–10s). No `init-db`. The 4 `pibot-*@crow-mpa` bots are independent of gateway restarts. Prove the panel via unit tests (a 403 on `/dashboard/connect` only proves dashboardAuth runs before panel lookup).

## Forward link to F6c-2

Once F6c-2 ships the server-side static-token verifier + generate/rotate UI, revisit this panel to add the token-bearing remote-HTTP config as a third style on the relevant tabs (headless / no-browser scenarios), and surface the token (masked + copy) here or in Connections.
