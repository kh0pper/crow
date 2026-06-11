# W2-1 — Route-Layer Unification (error shape, HMAC dedupe, rate-limit factory, WS auth gap)

**Date:** 2026-06-11
**Finding:** W2-1 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md); rubric [`2026-06-10-crow-vision-and-principles.md`](./2026-06-10-crow-vision-and-principles.md) (unification leads; composable & minimal; smallest coherent change).
**Inventory basis:** full route-layer survey 2026-06-11 (27 files in `servers/gateway/routes/` + mounting in `servers/gateway/index.js`).

## Problem

The route layer accumulated four divergences:
1. **Error shapes:** most JSON APIs return `{error}`, but `stt-debug.js` wraps in `{ok:false, error}`, parts of `bundles.js` and `admin-backup.js` mix `{ok:false, ...}`, and `bot-board-api.js` carries a private `jerr()` helper. Clients can't rely on one shape.
2. **Duplicated HMAC verifiers:** `bundles.js` (`crossHostVerifyMiddleware`, ~:211) and `federation.js` (`federationVerifyMiddleware`, ~:64) are two inline copies of the same verify-signature-or-reject logic over `servers/shared/cross-host-auth.js#verifyRequest`. Drift between them is a security hazard.
3. **Three rate-limiter implementations:** `blog-embed-api.js` has a well-designed tiered limiter (60/240/600 per min by network context); `chat.js` and `bot-chat.js` each carry a hand-rolled in-process Map limiter (10 msg/60s). No shared factory.
4. **WS auth gap (security):** `extension-proxy.js#setupWebSocket` proxies WebSocket upgrades with **no auth check** — `server.on("upgrade")` bypasses Express, so `dashboardAuth` (applied to the HTTP routes) never runs. On the LAN/tailnet a client without a session can reach extension web UIs over WS (incl. noVNC). The funnel config layer keeps it off the public internet, but layers 1–2 are absent for WS.

## Non-goals (deliberately out of scope)

- No new rate limits on currently-unlimited endpoints (behavior change; revisit after W2-1 lands).
- Public HTML/plain-text pages (`blog-public.js`, `songbook.js`, `fileview.js` 4xx text) keep their human-facing responses — they are pages, not JSON APIs.
- The broader 6-auth-pattern factory consolidation (Tier-2/3 migration) and the `rate_limit_buckets` SQLite-backed limiter: later waves. This change is the smallest coherent slice.
- `mcp.js`/`storage-http.js` (OAuth tier) untouched — already consistent.

## Design

### 1. One JSON error helper — `servers/gateway/routes/_error.js` (new, ~20 LOC)

```js
export function jsonError(res, status, error, extra = undefined) {
  return res.status(status).json(extra ? { error, ...extra } : { error });
}
```

Canonical shape: `{ error: string, ...optionalExtra }`. Migrate ONLY the outliers to it:
- `stt-debug.js`: `{ok:false, error}` → `{error}` (3 sites). The panel's client JS must be checked for `ok` consumption (`servers/gateway/dashboard/` STT settings section) and updated in the same commit.
- `bot-board-api.js`: delete local `jerr`, import `jsonError` (mechanical; same semantics).
- `admin-backup.js` + `bundles.js`: normalize the few `{ok:false, error}` error responses to `{error}` (success shapes unchanged). `bundles.js` client consumers (extensions panel JS) checked for `.ok` reads on ERROR paths only.

### 2. Shared HMAC middleware — extend `servers/shared/cross-host-auth.js`

Add one exported factory (signature reconciled from both inline copies):

```js
export function crossHostVerifyMiddleware(db, { optional = false, audit = "" } = {}) { ... }
```

- Behavior: no `X-Crow-Signature` header → `optional ? next() : 401 {error:"signature_required"}`; bad sig/unknown peer → 401; good → set `req.crossHost = { instanceId, ... }` then `next()`. Mirrors today's two copies exactly (read both before writing; preserve their status codes/messages and audit calls).
- `bundles.js` uses `optional: true` (pass-through to session path), `federation.js` uses `optional: false`. Replace both inline copies with imports.

### 3. Rate-limit factory — `servers/gateway/middleware/rate-limit.js` (new)

Extract `blog-embed-api.js`'s tiered limiter into `tieredRateLimit({ tiers, keyGenerator, message })` and a simple `fixedWindowLimit({ max, windowMs, keyGenerator })` (in-process, Map-based, with periodic prune — formalizing what chat.js/bot-chat.js hand-roll). Migrate:
- `blog-embed-api.js` → `tieredRateLimit` (behavior-identical: same tiers/keys).
- `chat.js`, `bot-chat.js` → `fixedWindowLimit` (same 10/60s, same keys: session token / botId; same 429 body).

### 4. Extension-proxy WS auth (security fix)

In `extension-proxy.js#setupWebSocket`, before `proxyMiddleware.upgrade(...)`: validate the dashboard session from the upgrade request's cookies — reuse `parseCookies` + `verifySession` from `servers/gateway/dashboard/auth.js` (exact exported names verified). On failure: `socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy();`. Also reject when `req.headers["tailscale-funnel-request"]` is present (mirror layer-1 for WS). Precedent: `calls-signaling.js` validates tokens at WS connect.

### 5. Tier-1 auth application tidy

`push.js` and `settings-scope.js` apply `dashboardAuth` per-handler while the other six Tier-1 files use prefix-level `router.use`. Convert these two to prefix-level (verify no route in those files is intentionally public — read them; the inventory says none are).

## Error handling / compatibility

- Error-shape changes are visible to clients: the ONLY consumers of `stt-debug`/`bundles` error bodies are the dashboard's own client JS (same repo) — update them in the same commits. Bot Board panel JS checked for `jerr` shape reliance (none expected — same shape).
- No DB schema changes. Fleet-safe: all changes in-repo; no host-specific paths.

## Testing

- New `tests/rate-limit-middleware.test.js`: fixedWindowLimit blocks at max+1 within window, resets after window (fake timers via manual clock injection — design the factory to accept a `now` fn for testability), tieredRateLimit picks tier by key context.
- New `tests/cross-host-middleware.test.js`: no-sig optional→next, no-sig required→401, bad sig→401 (drive with stub req/res; reuse how existing cross-host tests do it if present — check `tests/` for prior art).
- Extension-proxy WS: unit-test the extracted session-check function with stub upgrade requests (no real WS needed).
- Full suite + `tests/auth-network.test.js` + boot checks; `/security-review` (auth + boundary touched).
