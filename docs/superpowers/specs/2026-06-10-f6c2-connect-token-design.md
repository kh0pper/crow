# F6c-2 — Local MCP Token (server-side verifier + management UI)

**Date:** 2026-06-10
**Status:** Design approved, pre-plan
**Predecessor:** F6c-1 (connect wizard UI slice, `origin/main` @ `903497f`)
**Layer:** Crow v1 refoundation, F6c-2 (decomposed from F6c)

## Problem

F6c-1 shipped the connect wizard but deliberately surfaced **no token**, because of a
load-bearing finding (re-verified this session against the live tree):

**`CROW_LOCAL_MCP_TOKEN` authenticates nothing server-side.** Only the build script
`scripts/generate-mcp-config.js` reads it (to embed `Bearer ${token}` into a generated
`.mcp.json` via `--http`). The gateway never reads it. `verifyAccessToken`
(`servers/gateway/auth.js:186`) checks only the `oauth_tokens` table, so a request bearing
`CROW_LOCAL_MCP_TOKEN` is hashed, missed, and 401s. The two credentials the MCP endpoints
accept today are OAuth access tokens (`oauth_tokens`) and paired-instance tokens
(`crow_instances.auth_token_hash`).

So the headless / no-browser remote-HTTP path (a client that pastes an `http` MCP entry with
a static bearer header, no OAuth dance) does not work. F6c-2 makes it real.

## Goal

A single, per-instance, full-tool-access **static bearer token** that:

1. Authenticates incoming MCP requests server-side (new verifier branch in the gateway auth chain).
2. Is generated / rotated / revoked from the F6c-1 connect panel (operator-gated UI).
3. Needs **no gateway restart** to mint, rotate, or revoke (per-request DB read of the hash).
   The one-time restart is only to deploy the new middleware code, exactly like F6c-1.

## Decisions (locked during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Token model | **Single global token** (one active at a time) | Matches how the handoff describes it and how `CROW_LOCAL_MCP_TOKEN` works. Smallest data model: one hash. YAGNI vs multiple named tokens. |
| Cross-instance | **Per-instance, not synced** | A full-access bearer must not replicate across hosts (blast radius). Each instance has its own gateway URL + its own token, minted from its own dashboard. Mirrors the per-instance OAuth/instance-token model. |
| Token at rest | **Hash-only in DB + copy UI** | Store only `sha256(token)`; reveal the raw value exactly once on generation. No plaintext token on disk. No `.env` write. |
| UI placement | **Connect panel**, pointer from Connections | Token + the config snippet that uses it live in one place; Connections links to it. |
| Restart semantics | **Per-request DB read** | No restart to mint/rotate/revoke after deploy (like F4b). |

## Architecture

Two independent concerns:

- **Auth path** — authenticate incoming MCP requests bearing the token.
- **Management path** — operator generate/rotate/revoke UI, dashboardAuth + CSRF gated.

### 1. Token store (no schema change)

Reuse the **local-scoped settings** store (`dashboard_settings_overrides`, keyed by
`instance_id`, never synced — see `registry.js:188` `writeSetting(..., { scope: "local" })`).
This satisfies "per-instance, not synced" with zero `init-db.js` change and no sync-allowlist
entry (so it can never replicate). Two keys:

- `mcp_local_token_hash` → `sha256(token)` hex. The verifier reads only this.
- `mcp_local_token_created` → ISO-8601 timestamp, for the masked UI ("active since …").

Rationale for not adding a table: a single global token needs no list, no per-row metadata,
and no FTS shadow. The local-override settings table already gives per-instance, non-synced
semantics for free. `last_used_at` is deliberately omitted (a write per MCP request would be
write-amplification on the hot path).

### 2. New module `servers/gateway/local-token.js`

Mirrors the shape of `instance-registry.js`. Pure, db-injected functions plus one middleware:

- `generateLocalToken(db)` → `randomBytes(32).toString("hex")`, store `sha256` + created ISO,
  return the **raw token** (the caller reveals it exactly once).
- `revokeLocalToken(db)` → `deleteLocalSetting` for both keys.
- `getLocalTokenMeta(db)` → `{ present: boolean, createdAt: string|null }`. Never returns the
  raw token or the hash.
- `validateLocalToken(db, token)` → read stored hash; if none, `false`; else
  `crypto.timingSafeEqual(sha256(token), storedHash)`. Returns boolean.
- `applyLocalTokenAuth(req)` → if `req.localTokenAuth` is set, assign the full-access
  `localOperatorAuth()` to `req.auth` and return `true`; else return `false`. Takes only `req`
  (no `peerGate` dependency), which is what structurally proves a local token is never run
  through the peer exposure gate. Called by `skipAuthForInstance`.
- `localTokenAuthMiddleware(db)` → Express middleware. Mounted globally but reads the DB **only
  for MCP-path requests** (`/mcp`, `/sse`, `/messages` suffixes; `req.localTokenAuth` is consumed
  only on those routes), so non-MCP Bearer traffic (dashboard APIs, OAuth `/token`, `/blog`)
  skips the read entirely. Runs the check only when `Authorization: Bearer …` is present **and**
  `req.instanceAuth` is unset (instance auth wins). On a valid token, sets
  `req.localTokenAuth = { token: "local-mcp" }`. On no-token-configured or mismatch, calls
  `next()` without the flag (falls through to OAuth, like `instanceAuthMiddleware`).

### 3. Auth-chain wiring (the load-bearing fix)

- `servers/gateway/index.js`: mount `localTokenAuthMiddleware(createDbClient())` immediately
  **after** `instanceAuthMiddleware` (currently `index.js:520`). This is the only change that
  requires a one-time gateway restart to deploy.
- `servers/gateway/routes/mcp.js`, inside `skipAuthForInstance` (`mcp.js:224`): add a branch
  **after** the instance branch and **before** the `authMiddleware` fallback:

  ```js
  // Full local-operator credential, same access surface as an OAuth client.
  // applyLocalTokenAuth does NOT run peerGate (a local token is not a paired
  // peer), and sits after the instance branch / before the OAuth fallback.
  if (applyLocalTokenAuth(req)) return next();
  ```

  Mirrors the synthesized-`req.auth` shape the instance branch already uses (downstream MCP
  handlers read fields off `req.auth`).

- **`--no-auth` mode (dev-only):** when `authMiddleware` is `null` (`index.js:599-600`),
  `skipAuthForInstance` is not mounted at all (`mcp.js:258` `else` branch), so the token branch
  never runs. This is correct and inert: in `--no-auth` every request is already unauthenticated,
  so the token neither grants nor blocks anything beyond the mode's existing behavior. Matches the
  instance branch, which is likewise inert in that mode.

### 4. Connect panel UI (`servers/gateway/dashboard/panels/connect.js`)

The dashboard dispatcher is `router.all("/dashboard/:panelId", …)` (`dashboard/index.js:715`),
which routes **every method** to `panel.handler`, and `csrfMiddleware` already runs on
`/dashboard` (`index.js:593`). So the connect panel handles its own POST actions; no new
router is needed.

- **GET**: keep all F6c-1 OAuth tabs unchanged (the token-free OAuth path stays the
  recommended default). Add a **"Headless / no browser (token)"** section:
  - No token present → short explainer + a **Generate token** form (POST `generate_token`).
  - Token present → masked state ("A token is active, created `<date>`"), **Rotate** and
    **Revoke** forms, and the remote-HTTP config snippet showing a `<YOUR-TOKEN>` placeholder
    (the stored secret cannot be shown again).
- **POST** (`action` ∈ `generate_token` | `rotate_token` | `revoke_token`, plus `_csrf`):
  mutate, then:
  - generate / rotate → **render the panel directly (no redirect)**, revealing the raw token
    exactly once inside a warning callout with a copy button, plus the ready-to-paste config
    with `headers: { "Authorization": "Bearer <token>" }` for header-capable clients (e.g.
    Claude Code). A redirect (PRG) is intentionally avoided here because it would force
    flashing/stashing the secret; rendering once on the POST response is the standard
    show-once pattern.
  - revoke → re-render the masked/empty state.
- All new copy lives as bilingual `connect.token.*` keys in `shared/i18n.js`. Crow.md writing
  rules apply (no em dashes, no "not X, but Y" in UI copy). The Connections settings section
  (`settings/sections/connections.js`) gains a one-line pointer to the connect panel for token
  management.

### 5. Security posture (full pass before merge)

This is a long-lived, full-tool-access bearer token, so:

- **At rest:** only `sha256(token)` is stored. The raw value is shown exactly once on the
  POST response and is never redirected, flashed, session-stored, logged, or written to
  `.env`/disk.
- **Compare:** `crypto.timingSafeEqual`.
- **Entropy:** 32 random bytes (256-bit), brute-force-infeasible, so no added rate limiting is
  required beyond what the MCP endpoints already have.
- **Rotation/revocation:** rotate overwrites the single hash; the old token is invalid on the
  next request (per-request hash read). Revoke deletes the keys.
- **Management UI:** gated by dashboardAuth + CSRF (double-submit) like every other dashboard
  mutation.
- **Network-exposure invariant preserved:** the MCP paths (`/router/mcp`, `/*/mcp`) are
  already blocked from Tailscale Funnel by the gateway's funnel middleware; this work adds
  nothing to `PUBLIC_FUNNEL_PREFIXES` and does not weaken that gate. A token-bearing request
  arriving over Funnel is rejected before auth runs. Verified by an adversarial
  `/security-review` pass plus an explicit invariant test.

### 6. Tests (`tests/connect-token.test.js`)

- `validateLocalToken`: correct token, wrong token, no-token-configured.
- `localTokenAuthMiddleware`: sets `req.localTokenAuth` on a valid token; does not on a wrong
  token; does not run when `req.instanceAuth` is already set (instance precedence); fast-exits
  when no token configured.
- `skipAuthForInstance` local-token branch: synthesizes `req.auth`, calls `next()`, and is not
  routed through `peerGate`.
- Lifecycle: generate stores the hash at **local** scope (assert it is not in the sync
  allowlist / not synced) and returns a raw token; rotate changes the stored hash; revoke
  clears it.
- Panel: reveal-once render on POST vs masked render on GET.
- Network-exposure: a token-bearing request to an MCP path carrying
  `Tailscale-Funnel-Request` is still rejected (invariant).

Target: green alongside the existing dashboard suite (F6c-1's 25/25 plus these).

## Out of scope (deferred / explicitly not doing)

- Multiple named / per-client tokens (revoke-one-client). Single global token only.
- Cross-instance sync of the token.
- `.env` write and `scripts/generate-mcp-config.js --http` rework. The `--http` build path
  stays as-is; a user who wants it can paste the generated token into `.env` themselves.
- `last_used_at` / usage tracking (hot-path write-amplification).

## Deploy

One-time gateway restart (to load the new `localTokenAuthMiddleware` and the updated panel),
exactly like F6c-1. On crow: restart `crow-gateway` + `crow-mpa-gateway` (both
`WorkingDirectory=/home/kh0pp/crow`, code already at merged `main`). grackle + black-swan:
`git pull --ff-only` then restart. No `init-db`. Bots untouched.

## Workflow

brainstorm (done) → this spec → writing-plans → plan-review (adversarial, before coding) →
subagent-driven-development (per-task spec-review then quality-review) → final holistic
(opus) review → **`/security-review` pass** → finishing-a-development-branch (merge + deploy).
