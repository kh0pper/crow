# OAuth operator consent gate

Status: DRAFT for Kevin's review (2026-10-02). Docs only, no code yet.
Audit item: A11 (first item of the cloud-client arc), weekend push 2026-10-02.
Predecessor: Gitea `kh0pp/crow-engineering` `specs/2026-07-18-oauth-consent-gate-spike.md`
("Approved to spec", C2 decision §8). This document supersedes the spike's design sketch where they differ; each
difference is called out in §9.
Plan: `docs/superpowers/plans/2026-10-02-oauth-consent-gate.md`.

## 1. Problem

The gateway's OAuth 2.1 provider auto-approves. `servers/gateway/auth.js` `CrowOAuthProvider.authorize()`
(lines 61-79 at `ed2382b0`) mints an authorization code for any request that reaches `/authorize`, with no
operator login and no consent screen. Dynamic Client Registration (`POST /register`) lets anyone create a client
first. The resulting access token is full-surface: `requireBearerAuth` runs with `requiredScopes: []`
(`servers/gateway/index.js:588-592`), so every token reaches every MCP tool, including the memory DB.

The only barrier today is the network. `/authorize`, `/token` and `/register` are not behind `isAllowedNetwork()`;
they are only Funnel-rejected by `rejectFunneledMiddleware()`. Any device that can open a TCP connection to the
gateway (LAN guest, a shared-tailnet node, a compromised IoT box) can mint a full-access MCP token without
knowing the dashboard password.

Note on the brief: the brief named `servers/gateway/dashboard/auth.js`. The OAuth provider is in
`servers/gateway/auth.js`. `dashboard/auth.js` holds the dashboard session, `isAllowedNetwork()` and the
cookies; this design reads from it but does not change it.

## 2. Goals and non-goals

Goals (from the brief):

1. No token is minted for any OAuth client until the operator explicitly approves it on a dashboard page.
2. Approval requires a **local** dashboard session (password login, not a peer SSO session) plus a TOTP step-up
   code when 2FA is on: the same gate as phone-call approvals (`bundles/phone/server/authority.js`).
3. The approval page shows the client name, its redirect URI, the requested scopes and the requesting IP.
4. Approved clients keep working. Token refresh never re-prompts.
5. The operator can revoke an approved client from the dashboard.
6. No change to the Funnel / network-exposure invariant (§7).
7. Nothing that is connected today breaks on deploy (§8).

Non-goals (cloud-client arc, separate design with Kevin's named approval): public exposure of `/authorize`,
real scope enforcement, refresh-token rotation, DCR spam limits beyond today's rate limits, authenticating
`/introspect`, per-tool consent. None of these change here.

## 3. Current flow (verified at `ed2382b0`)

MCP SDK 1.27.1 `mcpAuthRouter` mounts `/authorize`, `/token`, `/register` and the `/.well-known/*` metadata
(`servers/gateway/index.js:532-550`). The SDK's authorize handler validates `client_id`, `redirect_uri`
(against the registered list), `response_type=code` and an S256 PKCE challenge, then calls
`provider.authorize(client, params, res)`. Crow's provider stores `{client, params}` under a random code in an
in-memory `Map` (10 min TTL) and 302s to `redirect_uri?code=…&state=…`.

`POST /token` with `grant_type=authorization_code` runs the SDK's local PKCE check
(`challengeForAuthorizationCode`), then `exchangeAuthorizationCode`, which writes a hashed 24 h access token
and a hashed 30-day refresh token to `oauth_tokens`. `grant_type=refresh_token` calls `exchangeRefreshToken`,
which reuses the refresh token and mints a new access token. **Refresh never touches `/authorize`.** That is
what makes goal 4 cheap: the gate sits only on the browser leg.

## 4. Design

### 4.1 Flow

```
client ──GET /authorize──▶ SDK validation ──▶ provider.authorize()
                                                │  (no code minted)
                                                ▼
                               pending store (in memory, 10 min, id = 32 hex)
                                                │
browser ◀── 302 /dashboard/oauth/consent/<id> ──┘
   │
   ├─ no local session ─▶ Set-Cookie crow_oauth_return=<id> ─▶ /dashboard/login (password, then 2FA)
   │                      └─ login success ─▶ 303 back to /dashboard/oauth/consent/<id>
   │
   ├─ client already approved ─▶ code minted ─▶ 302 redirect_uri?code&state          (no click)
   │
   └─ consent page ─▶ Approve (+ TOTP if 2FA on) ─▶ approval row + code ─▶ 303 redirect_uri?code&state
                    └ Deny ─▶ 303 redirect_uri?error=access_denied&state
```

### 4.2 Pending authorizations (in memory)

`provider.authorize()` validates the redirect URI as today, then parks
`{client, params, requester:{ip, tailnetUser}, createdAt, expiresAt, stepUpFailures}` in a
`PendingAuthorizations` store and redirects the browser to `/dashboard/oauth/consent/<id>`.

- Id: `randomBytes(16)` hex. Every lookup validates `^[a-f0-9]{32}$` first.
- TTL 10 minutes (same as codes today). Expired entries are swept on create and rejected on read.
- Capacity 100; the oldest entry is evicted first. `/authorize` already sits behind the gateway `authLimiter`
  and the SDK's own limiter (100 per 15 min).
- Single use: Approve, Deny and the silent re-authorization all `take()` the entry.
- In memory only. A gateway restart drops pending requests; the client simply retries. This matches the
  existing code map and avoids a new table for 10-minute state.
- `requester.ip` is `req.ip` at `/authorize` time. The gateway sets `trust proxy` 1, so behind Tailscale Serve
  this is the tailnet client address from `X-Forwarded-For`. `tailnetUser` is the `Tailscale-User-Login`
  header when present (tailscaled strips and re-sets it, so clients cannot forge it).

### 4.3 Consent routes

`servers/gateway/routes/oauth-consent.js`, mounted inside the dashboard router **before** `dashboardAuth`
(it has to set the return cookie before the login redirect, which `dashboardAuth` cannot do). Because it skips
`dashboardAuth`, it re-applies the same checks itself, in this order:

1. `isAllowedNetwork(req)` or 403. This also covers the Funnel header.
2. `req.app.locals.oauthProvider` present or 404 (`--no-auth` mode has no provider).
3. Pending entry valid or 410 with an "expired" notice page.
4. Local dashboard session: the `crow_session` cookie hashes to an `oauth_tokens` row with
   `client_id='dashboard'`, `scopes='dashboard'` and an unexpired `expires_at` (compared with `julianday()`).
   SSO sessions (`scopes='dashboard sso'`) do not qualify, matching the phone precedent. Otherwise: set
   `crow_oauth_return=<id>` (HttpOnly, SameSite=Lax, Path=/dashboard, Max-Age 600) and redirect to
   `/dashboard/login`.

`GET /dashboard/oauth/consent/:id`:

- If the client already has an approval row: take the pending entry, mint the code, 302 to the client.
  No page and no click. The operator's session is still required (decision D1).
- Otherwise render the consent page.

`POST /dashboard/oauth/consent/:id` (urlencoded, `csrfMiddleware` double-submit):

- `action=deny`: take the entry, audit `oauth_consent_denied`, 303 to `redirect_uri?error=access_denied&state=…`.
- `action=approve`: check the TOTP step-up (only when 2FA is enabled, decision D2). A bad code re-renders the
  page with an error (400) and increments `stepUpFailures`; the fifth failure takes the entry and redirects
  with `access_denied`. A good code takes the entry, upserts the approval row
  (`approved_via='operator'`, `approved_ip=req.ip`), audits `oauth_client_approved`, mints the code and 303s
  to the client.
- Any other action: 400.

Both handlers send `Cache-Control: no-store`, `X-Frame-Options: DENY`, and rewrite the CSP's
`frame-ancestors` to `'none'` for this page only. The global CSP allows `frame-ancestors 'self' https:` for the
companion iframe, which would let any HTTPS site frame (clickjack) the consent page.

### 4.4 Post-login return

`POST /dashboard/login` (no 2FA), `POST /dashboard/login/2fa` and `POST /dashboard/login/2fa/recovery`
check `crow_oauth_return`. If it holds a valid pending id, the handler clears the cookie and redirects to
`/dashboard/oauth/consent/<id>` instead of `/dashboard`. Logins that originate from SSO keep their SSO
destination (an SSO session cannot approve anyway). The cookie only ever carries a 32-hex id and the target
path is rebuilt server-side, so it cannot become an open redirect.

### 4.5 The consent page

Standalone page in the login-card style (`servers/gateway/dashboard/shared/layout.js`): no Turbo and no page-specific script (only the shared components script every login-card page carries).
It shows:

| Field | Source | Notes |
|---|---|---|
| App | DCR `client_name` | Labelled "name supplied by the app": it is attacker-controlled. Escaped. "Unnamed app" when absent. |
| Sends access to | `params.redirectUri` | Escaped. If the host is not `localhost` / `127.0.0.1` / `[::1]`, a warning says it is not a local address. |
| Requested scopes | `params.scopes` | Raw list, or "(none requested)". Always followed by the honest line that approval grants full access to every Crow tool, because scopes are not enforced (`requiredScopes: []`). |
| Requested from | `requester.ip` (+ `tailnetUser`) and the request time | From the `/authorize` request, not the approving browser. |
| Client ID | `client_id` | Small print, for matching against the revoke list. |
| 2FA code | input | Only when `totp_enabled='true'`. `Deny` has `formnovalidate` so it never needs a code. |

All strings are EN + ES (the global i18n parity gate), with no em dashes (connect panel copy rule).

### 4.6 Approval store

New instance-local table:

```sql
CREATE TABLE IF NOT EXISTS oauth_client_approvals (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  approved_via TEXT NOT NULL CHECK(approved_via IN ('operator', 'grandfathered')),
  approved_ip TEXT,
  approved_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

- One DDL string in a side-effect-free module (`servers/gateway/oauth-approvals-ddl.js`), imported by
  `initOAuthTables()` (runs on every gateway boot), `scripts/init-db.js` (fresh installs) and the migration.
  Same pattern as `BOT_JOBS_DDL`.
- **No `SCHEMA_GENERATION` bump.** A new table rides the additive migration registry, as
  `0007-perch-session-files` did. A bump would re-run init-db's DROP TABLE statements on every live DB.
- Approval is per `client_id`. A DCR client's `redirect_uris` cannot change after registration: the SDK
  generates the `client_id` (`randomUUID`), so a re-registration is a new client. The snapshot of
  `client_name` / `redirect_uris` is for display only.
- Not synced. `SYNCED_TABLES` (`servers/sharing/instance-sync.js:57`) contains neither `oauth_*` table, and
  this one is not added. Approvals stay per instance, like the clients and tokens they gate.

`exchangeAuthorizationCode()` also refuses to mint when the client has no approval row (`InvalidGrantError`).
Codes are only created by the consent path, so this is a second check that also closes the window between a
revoke and an in-flight code.

### 4.7 Revocation

The Connect panel (`/dashboard/connect`, next to the local-token controls) gains an "Approved apps" section:
name, client id, redirect URIs, how and when it was approved (operator, or "connected before approvals
existed"), and the count of live refresh tokens. Each row has a Revoke button (CSRF form).

Revoke runs one transaction: `DELETE FROM oauth_tokens WHERE client_id=?` and
`DELETE FROM oauth_client_approvals WHERE client_id=?`, audited as `oauth_client_revoked`. It then calls
`provider.purgeClient(clientId)` to drop that client's in-memory codes and pending requests. Effect: MCP calls
with its access token fail immediately, its refresh fails, and its next authorization shows the consent page
again. `client_id='dashboard'` (dashboard sessions) is refused by the helper. The DCR client row is kept, so a
revoked client can ask again rather than hit `invalid_client`.

Revoke is available to any dashboard session, SSO included. It only removes access, so it does not need the
step-up.

## 5. What does not change

- `/authorize`, `/token`, `/register`, `/.well-known/*`: same mounts, same rate limits, same Funnel
  treatment. `/register` stays open: DCR is a machine-to-machine POST with no browser, so the approval
  happens at the client's first authorization, before any token exists. That meets "approval before any token
  is minted" for both new registrations and new authorizations.
- `exchangeRefreshToken()`, `verifyAccessToken()`: unchanged. Refresh and MCP calls never re-prompt.
- The local MCP token, board token and phone token (`servers/gateway/local-token.js`): static, hashed,
  unaffected. They stay the headless path.
- Dashboard login, sessions, SSO, 2FA setup: unchanged, apart from the return-cookie check in §4.4.

## 6. Peers, federation and instance sync

Grepped every OAuth endpoint consumer (`/authorize`, `/token`, `grant_type`, `authorization_code`,
`oauth-authorization-server`) across `servers/`, `scripts/`, `bundles/`. The only hits are Google's OAuth
endpoints (google-workspace, pm-workspace), third-party services (wallabag, peertube, Trello) and the
gateway's own rate-limit lines. No Crow peer obtains a token through this provider:

| Path | Auth | Touches `/authorize`? |
|---|---|---|
| Federated MCP calls | `instanceAuthMiddleware` (`instance-registry.js:479`): bearer hash vs `crow_instances.auth_token_hash`; `routes/mcp.js` `skipAuthForInstance` bypasses OAuth and applies the peer exposure gate | No |
| Instance sync (tailnet) | `servers/sharing/tailnet-sync.js`: ed25519 mutual-auth WebSocket handshake | No |
| Instance sync (Hyperswarm), contacts, Nostr | identity keys | No |
| Cross-instance SSO | HMAC tickets, `mintSsoSession()` writes a `dashboard sso` session row | No (and cannot approve, §4.3) |
| Federation dashboard routes | `X-Crow-Signature` HMAC | No |
| Pairing | `routes/instance-enroll.js`, `crow_register_instance` | No |
| Bots / pi | local, board or phone token; peer tokens from `peer-tokens.json` | No |

Instance sync uses its own auth and is not affected by the gate.

## 7. Network-exposure invariant

No invariant change.

- The consent routes live under `/dashboard/`, which is not in `PUBLIC_FUNNEL_PREFIXES`
  (`servers/gateway/funnel.js`), so `rejectFunneledMiddleware()` 403s any funneled request. The route also
  re-applies `isAllowedNetwork()` itself (layer 2).
- No path is added to or removed from `PUBLIC_FUNNEL_PREFIXES`. `CROW_DASHBOARD_PUBLIC` keeps its meaning.
- The gate narrows access. It does not widen it.
- `tests/auth-network.test.js` must stay green, unchanged. The new integration test also asserts a funneled
  consent request gets 403.

One adjacent item touches content that is Funnel-visible, without changing exposure. It is optional and
needs Kevin (D4): the OAuth issuer advertised in `/.well-known/*` comes from `CROW_GATEWAY_URL`. On crow that
is `https://crow.dachshund-chromatic.ts.net`, port 443, which is the Funnel host and serves only r4's `/s`
routes (`tailscale serve status`). So crow's OAuth discovery points at a host where `/authorize` does not exist
(MPA defect 3). The fix is a `CROW_OAUTH_ISSUER_URL` override (plan Task 9). It changes which URL the metadata
names. It does not change which paths Funnel can reach.

## 8. Existing clients: inventory and grandfathering

Read-only inventory, 2026-10-02 (`sqlite3 -readonly`, or a read-only better-sqlite3/python handle where
`sqlite3` is absent):

| Instance | `oauth_clients` | OAuth tokens (non-dashboard) | Notes |
|---|---|---|---|
| crow `~/.crow/data/crow.db` | 1: `probe` (created 2026-08-10, redirect `http://localhost:9999/callback`, public) | 0 | The probe dates from the MPA-retirement investigation. 1 live dashboard session. |
| r4 `~/.crow-r4/data/crow.db` | 0 | 0 | 1 live dashboard session. |
| Dayane container (`crow-dayane`, `/crow/data/crow.db`) | 0 | 0 | 5 dashboard sessions. |
| raven `~/.crow/data/crow.db` | 0 | 0 | |
| black-swan `~/.crow/data/crow.db` | 0 | 0 | |
| MPA `~/.crow-mpa/data/crow.db` | no oauth tables | n/a | Retired. |
| grackle | **not inventoried** | | SSH timed out over Tailscale and over LAN `10.0.0.21` (consistent with the audit's "grackle row reads offline"). |

So no instance that could be read has a connected OAuth client today. How current clients connect instead:

- This Claude Code config (`~/.claude.json`): `crow-blog-grackle` uses a static `Authorization: Bearer`
  header, so it is unaffected. `crow-core` points at `http://localhost:3001/router/mcp` with no header. It
  is not connected now (its `authenticate` tool is pending), because crow's issuer points at the Funnel host
  (§7). The gate does not change that. D4 would.
- stdio servers (`crow-memory`, `crow-projects`, …) do not use HTTP auth.
- claude.ai web connectors (Crow Projects, Memory, Sharing) are cloud clients and are in no instance's DB.
  They belong to the cloud arc.

Grandfathering path (for grackle and any install we cannot see): migration
`scripts/migrations/0008-oauth-client-approvals.mjs` runs once per instance at boot, before
`initOAuthTables()`. It:

1. creates `oauth_client_approvals` (idempotent);
2. if both `oauth_clients` and `oauth_tokens` exist, inserts `approved_via='grandfathered'` for every DCR
   client that has at least one unexpired token (access or refresh), copying `client_name` and
   `redirect_uris` from the stored metadata. It uses `INSERT OR IGNORE`, so an operator approval is never
   overwritten.

A grandfathered client keeps working: refresh needs no approval check, and its access tokens are untouched.
Only its next full browser authorization (after 30 days, or a reconnect) goes through the session check.
Clients with no live tokens are not grandfathered. They have nothing to keep working, and their next
authorization prompts like a new client. The migration is safe to re-run (lost `schema_migrations` row after
a restore). It can only approve clients that still hold live tokens, and revoke deletes tokens together with
the approval.

The migration number `0008` is free at `ed2382b0`. If a parallel branch lands an `0008` first, renumber to
the next free id at rebase time. The id must match the filename (`tests/migration-registry.test.js`).

## 9. Differences from the 2026-07-18 spike

| Spike | This design | Why |
|---|---|---|
| Re-auth of a known client never re-prompts (silent by client id) | Silent only when the browser carries a **local** dashboard session; otherwise login first (no consent click) | Public DCR clients have no secret. Anyone who learns an approved `client_id` could start `/authorize` with its loopback redirect from their own machine and receive a code on their own localhost. Requiring the operator's session closes that. Refresh is still prompt-free (goal 4). Decision D1. |
| `CROW_OAUTH_AUTO_APPROVE=true` escape hatch | Not built | It would contradict goal 1. The headless path is the local MCP token. Decision D3. |
| Consent needs a live dashboard session | Local session **plus** TOTP step-up when 2FA is on, SSO sessions refused | The brief's "same as phone approvals". |
| Revocation list "in the connect panel" | Same | |
| Grandfather "clients holding live tokens" | Same, via the migration registry | |

## 10. Decisions that need Kevin

- **D1. Silent re-authorization.** The default here is that an approved client re-authorizes without a click
  but only with the operator's local session in the browser. The alternative is the spike's fully silent
  re-authorization by `client_id`, which is weaker (§9).
- **D2. 2FA strength.** The default follows the phone precedent: a TOTP code is required at approval only when
  2FA is enabled. crow has 2FA on. r4 does not. The alternative is to refuse all approvals unless 2FA is
  enrolled.
- **D3. Auto-approve escape hatch.** The default is not to build it.
- **D4. Issuer override (plan Task 9, optional).** Add `CROW_OAUTH_ISSUER_URL` and set it to
  `https://crow.dachshund-chromatic.ts.net:8444` **in a systemd drop-in for `crow-gateway.service` only**,
  never in `~/crow/.env`. r4's unit inherits `~/crow/.env` through the gateway's `.env` loader, and r4 would
  then advertise crow's issuer. Without D4, OAuth on crow cannot complete at all, gate or no gate, so live
  acceptance there needs it. This is a prod unit change.
- **D5. Deploy window.** Merging to main restarts the crow and r4 gateways through auto-update. Register the
  deploy in `~/CROW-SCHEDULE.md` first.

## 11. Observations outside scope (not changed here)

- A dashboard session token is also a valid MCP bearer token. Sessions live in `oauth_tokens` as
  `token_type='access'`, and `verifyAccessToken()` does not filter on `client_id`. A stolen `crow_session`
  cookie is therefore full MCP access. That is consistent with the session already being full dashboard
  access, but worth a cloud-arc look.
- `/introspect` is unauthenticated (`index.js:562`).
- Refresh tokens are reused, not rotated, and scopes are decorative (C2 doc §2.2).

## 12. Acceptance

- Integration test over a real Express app with the SDK router and the consent router: new client gets no
  code; consent requires a local session (SSO refused); off-network and funneled requests refused; page shows
  name, redirect, scopes, IP and blocks framing; approve gives a working code; refresh works with no prompt;
  approved client re-authorizes silently only with a session; deny gives `access_denied`; expired request
  gets 410; 2FA required when enabled; 5 bad codes deny; CSRF enforced; revoke kills tokens and refresh and
  re-prompts; a pre-revoke code cannot be exchanged; a forged code for an unapproved client cannot be exchanged.
- Migration test: grandfathers only clients with live tokens, idempotent, never overwrites an operator
  approval, tolerates missing oauth tables, same shape as `initOAuthTables()`.
- `tests/auth-network.test.js` green and unchanged. Full `npm test` green, i18n parity included.
- Scratch-gateway acceptance (never `~/.crow`): register, authorize, password login returns to consent,
  approve, token, MCP call; then 2FA login returns to consent; then revoke from the Connect panel.
