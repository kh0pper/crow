# OAuth Operator Consent Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No OAuth client gets a token until the operator approves it on a dashboard page (local session + TOTP step-up when 2FA is on); approved clients refresh without re-consent; approvals are revocable from the Connect panel.

**Architecture:** `CrowOAuthProvider.authorize()` stops minting codes. It parks the request in an in-memory `PendingAuthorizations` store and redirects the browser to `/dashboard/oauth/consent/<id>`. A new consent router (mounted before `dashboardAuth`) checks network + local session, then renders Approve/Deny. Approve writes an `oauth_client_approvals` row and mints the code. Refresh never touches `/authorize`, so it is unaffected. A one-shot migration grandfathers clients that already hold live tokens.

**Tech Stack:** Node 24, Express 5, `@modelcontextprotocol/sdk` 1.27.1 auth router, better-sqlite3 via `servers/db.js` `createDbClient`, `otpauth`, node:test.

**Spec:** `docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md`

## Global Constraints

- No `SCHEMA_GENERATION` bump. The new table rides `scripts/migrations/` (precedent `0007-perch-session-files`) plus `initOAuthTables()` plus `init-db.js`, all from one DDL string.
- No change to `PUBLIC_FUNNEL_PREFIXES`, `isAllowedNetwork()`, or `CROW_DASHBOARD_PUBLIC` semantics. `tests/auth-network.test.js` stays green and unchanged.
- No new DROP/DELETE in `scripts/init-db.js`.
- Every new UI string: `en` + `es`, `es !== en`, no em dash (`tests/i18n-global-parity.test.js`, connect copy rule).
- Tests run ONLY via `npm test -- tests/<file>.test.js` (scratch env). NEVER raw `node --test` (writes the live DB).
- Commit with positional paths: `git add <new files>` then `git commit <paths> -m "..."`; check `git show --stat HEAD`. No Claude attribution.
- Never start, restart or write to a live gateway or `~/.crow` while building. The scratch-gateway acceptance (Task 8) uses an isolated `HOME`/`CROW_HOME`/DB and `CROW_AUTO_UPDATE=0`.
- Migration id `0008-oauth-client-approvals` must match its filename. If a parallel branch lands an `0008` first, rename to the next free number (file name, `id` export, and the test's expected id).
- `dashboard/auth.js`, `routes/bundles.js` and other shared hot files: this plan does not touch `dashboard/auth.js`. `dashboard/index.js` gets three small edits only.

## Review Focus

- **Operator not logged in when the app opens the browser** → after login (password, or password + 2FA, or recovery code) they land back on the consent page, not `/dashboard`. Owned by Task 5 (wiring) and pinned by the Task 8 acceptance script (unit tests cannot reach the login handlers).
- **Hostile DCR metadata** (HTML in `client_name`, odd redirect URIs) → always escaped on the consent page and in the Connect list. Pinned in Task 4 (`app-supplied values are escaped`) and Task 6 (`escaped names`).
- **Consent page framed by another site** (global CSP allows `frame-ancestors 'self' https:`) → this page sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`. Pinned in Task 5.
- **Revoke while a code is in flight** → the code cannot be exchanged afterwards. Pinned in Task 5 (`a code minted before a revoke`).
- **Deploy onto an instance with live OAuth clients we could not inventory (grackle)** → they keep working (grandfathered). Pinned in Task 1 (`grandfathers exactly the clients that hold a live token`).

## File Structure

| File | Responsibility |
|---|---|
| Create `servers/gateway/oauth-approvals-ddl.js` | The one `oauth_client_approvals` DDL string (side-effect free). |
| Create `scripts/migrations/0008-oauth-client-approvals.mjs` | Create the table on existing installs; grandfather live clients. |
| Modify `scripts/init-db.js` | Fresh installs get the table. |
| Create `servers/gateway/oauth-consent.js` | Pending store, approval DB helpers, local-session + TOTP checks, login-return cookie. |
| Modify `servers/gateway/auth.js` | Provider: `authorize()` parks; `issueCode`/`denyRedirect`/`purgeClient`; approval check at exchange; table in `initOAuthTables()`. |
| Modify `servers/gateway/index.js` | `app.locals.oauthProvider = provider`; (Task 9) issuer source. |
| Modify `servers/gateway/dashboard/shared/layout.js` | `renderOAuthConsent`, `renderOAuthNotice`. |
| Modify `servers/gateway/dashboard/shared/i18n.js` | `oauthConsent.*`, `connect.oauth.*`, updated `connect.oauthNote`. |
| Create `servers/gateway/routes/oauth-consent.js` | GET/POST `/dashboard/oauth/consent/:id`. |
| Modify `servers/gateway/dashboard/index.js` | Mount the consent router; post-login return in three login handlers. |
| Modify `servers/gateway/dashboard/panels/connect.js` | "Approved apps" list + revoke action. |
| Modify `docs/architecture/gateway.md`, `docs/platforms/claude-code.md` | Document the consent step. |
| Modify `servers/gateway/issuer-url.js` (Task 9, gated) | `issuerSourceUrl()` with `CROW_OAUTH_ISSUER_URL`. |

---

### Task 1: Approvals table, migration and grandfathering

**Files:**
- Create: `servers/gateway/oauth-approvals-ddl.js`
- Create: `scripts/migrations/0008-oauth-client-approvals.mjs`
- Modify: `scripts/init-db.js` (import block ~line 8; after the OAuth tables block ~line 450)
- Modify: `servers/gateway/auth.js` (imports; `initOAuthTables()` DDL)
- Test: `tests/oauth-client-approvals-migration.test.js`

**Interfaces:**
- Produces: `OAUTH_APPROVALS_DDL` (string, no trailing `;`) from `servers/gateway/oauth-approvals-ddl.js`. Table `oauth_client_approvals(client_id PK, client_name, redirect_uris JSON text, approved_via 'operator'|'grandfathered', approved_ip, approved_at)`. Migration exports `id`, `run({ dbPath, log }) → { applied: true, results }`.

- [ ] **Step 1: Write the failing test** — create `tests/oauth-client-approvals-migration.test.js`:

```js
// 0008-oauth-client-approvals: creates the consent-gate approvals table on
// instances whose boot guard skips init-db, and grandfathers every DCR client
// that already holds a live token so nothing connected breaks on deploy
// (spec docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run, id } from "../scripts/migrations/0008-oauth-client-approvals.mjs";

const OAUTH_DDL = `
  CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    client_id TEXT NOT NULL, scopes TEXT DEFAULT '', resource TEXT, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`;

function scratch({ oauth = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oauth-appr-mig-"));
  const dbPath = join(dir, "crow.db");
  const d = new Database(dbPath);
  if (oauth) d.exec(OAUTH_DDL);
  d.close();
  return { dir, dbPath };
}

const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();

function seed(dbPath) {
  const d = new Database(dbPath);
  const client = d.prepare("INSERT INTO oauth_clients (client_id, metadata) VALUES (?, ?)");
  client.run("live", JSON.stringify({ client_id: "live", client_name: "Claude Code", redirect_uris: ["http://localhost:5555/cb"] }));
  client.run("stale", JSON.stringify({ client_id: "stale", client_name: "Old", redirect_uris: ["http://localhost:1/cb"] }));
  client.run("never", JSON.stringify({ client_id: "never", client_name: "Probe", redirect_uris: ["http://localhost:9999/callback"] }));
  client.run("corrupt", "{not json");
  const tok = d.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at) VALUES (?, ?, ?, ?)");
  tok.run("h1", "refresh", "live", iso(86_400_000));
  tok.run("h2", "access", "stale", iso(-60_000));
  tok.run("h3", "access", "corrupt", iso(60_000));
  tok.run("h4", "access", "dashboard", iso(60_000)); // a dashboard session, never a client
  d.close();
}

const rows = (dbPath) => {
  const d = new Database(dbPath);
  const r = d.prepare("SELECT client_id, client_name, redirect_uris, approved_via FROM oauth_client_approvals ORDER BY client_id").all();
  d.close();
  return r;
};

test("grandfathers exactly the clients that hold a live token", () => {
  const { dir, dbPath } = scratch();
  try {
    seed(dbPath);
    const r = run({ dbPath, log: () => {} });
    assert.equal(r.applied, true);
    assert.deepEqual(rows(dbPath), [
      { client_id: "corrupt", client_name: null, redirect_uris: "[]", approved_via: "grandfathered" },
      { client_id: "live", client_name: "Claude Code", redirect_uris: '["http://localhost:5555/cb"]', approved_via: "grandfathered" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a second run is a no-op and never overwrites an operator approval", () => {
  const { dir, dbPath } = scratch();
  try {
    seed(dbPath);
    run({ dbPath, log: () => {} });
    const d = new Database(dbPath);
    d.prepare("UPDATE oauth_client_approvals SET approved_via = 'operator', client_name = 'Renamed' WHERE client_id = 'live'").run();
    d.close();
    run({ dbPath, log: () => {} });
    const live = rows(dbPath).find((x) => x.client_id === "live");
    assert.equal(live.approved_via, "operator");
    assert.equal(live.client_name, "Renamed");
    assert.equal(rows(dbPath).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an instance with no oauth tables gets the table and grandfathers nothing", () => {
  const { dir, dbPath } = scratch({ oauth: false });
  try {
    const r = run({ dbPath, log: () => {} });
    assert.equal(r.applied, true);
    assert.deepEqual(rows(dbPath), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same table shape as initOAuthTables() (one DDL, three rails)", async () => {
  const a = scratch({ oauth: false });
  const b = scratch({ oauth: false });
  try {
    run({ dbPath: a.dbPath, log: () => {} });
    const { initOAuthTables } = await import("../servers/gateway/auth.js");
    await initOAuthTables(b.dbPath);
    const shape = (p) => {
      const d = new Database(p);
      const cols = d.prepare("PRAGMA table_info(oauth_client_approvals)").all();
      d.close();
      return cols;
    };
    assert.deepEqual(shape(a.dbPath), shape(b.dbPath));
    assert.deepEqual(shape(a.dbPath).map((c) => c.name),
      ["client_id", "client_name", "redirect_uris", "approved_via", "approved_ip", "approved_at"]);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("the module id matches its filename, as the runner's registry expects", () => {
  assert.equal(id, "0008-oauth-client-approvals");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/oauth-client-approvals-migration.test.js`
Expected: FAIL, `Cannot find module '.../scripts/migrations/0008-oauth-client-approvals.mjs'`.

- [ ] **Step 3: Create the DDL module** `servers/gateway/oauth-approvals-ddl.js`:

```js
/**
 * OAuth client approvals table: ONE shape, three rails.
 *
 * Imported by servers/gateway/auth.js initOAuthTables() (every gateway boot),
 * scripts/init-db.js (fresh installs) and
 * scripts/migrations/0008-oauth-client-approvals.mjs (existing installs, plus
 * the one-time grandfathering). Keep this module free of imports and side
 * effects: the migration loads it before the gateway opens any DB client.
 *
 * Instance-local. Never add this table to SYNCED_TABLES
 * (servers/sharing/instance-sync.js): an approval gates this instance's own
 * oauth_clients / oauth_tokens, which do not sync either.
 * Spec: docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §4.6.
 */
export const OAUTH_APPROVALS_DDL = `CREATE TABLE IF NOT EXISTS oauth_client_approvals (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris TEXT NOT NULL DEFAULT '[]',
    approved_via TEXT NOT NULL CHECK(approved_via IN ('operator', 'grandfathered')),
    approved_ip TEXT,
    approved_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`;
```

- [ ] **Step 4: Create the migration** `scripts/migrations/0008-oauth-client-approvals.mjs`:

```js
// scripts/migrations/0008-oauth-client-approvals.mjs
//
// OAuth consent gate (spec docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §8).
//
// 1. Creates oauth_client_approvals. A NEW TABLE carries no SCHEMA_GENERATION
//    bump by design (a bump re-runs every DROP/CREATE in init-db against live
//    DBs); this rail creates it on instances whose boot guard skips init-db,
//    from the same DDL string init-db.js and initOAuthTables() use.
// 2. Grandfathers every Dynamic-Client-Registration client that holds at least
//    one unexpired token, so nothing connected before the gate breaks on
//    deploy. INSERT OR IGNORE: an operator approval is never overwritten.
//
// Safe to re-run with its schema_migrations record missing (restore from
// backup): it can only approve clients that still hold live tokens, and a
// revoke deletes the tokens together with the approval.
import Database from "better-sqlite3";
import { OAUTH_APPROVALS_DDL } from "../../servers/gateway/oauth-approvals-ddl.js";

export const id = "0008-oauth-client-approvals";

function jsonOrEmpty(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.prepare(OAUTH_APPROVALS_DDL).run();
    const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    let granted = 0;
    if (has("oauth_clients") && has("oauth_tokens")) {
      const live = db.prepare(
        `SELECT c.client_id, c.metadata FROM oauth_clients c
          WHERE c.client_id != 'dashboard'
            AND EXISTS (SELECT 1 FROM oauth_tokens t
                         WHERE t.client_id = c.client_id
                           AND julianday(t.expires_at) > julianday('now'))`,
      ).all();
      const ins = db.prepare(
        `INSERT OR IGNORE INTO oauth_client_approvals (client_id, client_name, redirect_uris, approved_via)
         VALUES (?, ?, ?, 'grandfathered')`,
      );
      for (const row of live) {
        const meta = jsonOrEmpty(row.metadata);
        const name = typeof meta.client_name === "string" ? meta.client_name.slice(0, 200) : null;
        const uris = JSON.stringify(Array.isArray(meta.redirect_uris) ? meta.redirect_uris : []);
        granted += ins.run(row.client_id, name, uris).changes;
      }
    }
    log(`  oauth_client_approvals: ready, ${granted} client(s) grandfathered`);
    return { applied: true, results: ["table", `grandfathered:${granted}`] };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5: Add the table to `initOAuthTables()`** in `servers/gateway/auth.js`. Add the import below the existing `import { createDbClient, auditLog } from "../db.js";`:

```js
import { OAUTH_APPROVALS_DDL } from "./oauth-approvals-ddl.js";
```

and in `initOAuthTables()` replace

```js
    CREATE INDEX IF NOT EXISTS idx_tokens_client ON oauth_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_type ON oauth_tokens(token_type);
  `);

  // Clean up expired tokens on startup
```

with

```js
    CREATE INDEX IF NOT EXISTS idx_tokens_client ON oauth_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_type ON oauth_tokens(token_type);

    ${OAUTH_APPROVALS_DDL};
  `);

  // Clean up expired tokens on startup
```

- [ ] **Step 6: Add the table to `scripts/init-db.js`** (fresh installs). After `import { BOT_JOBS_DDL, missingBotJobsColumns } from "./pi-bots/bot-jobs-schema.mjs";` add:

```js
import { OAUTH_APPROVALS_DDL } from "../servers/gateway/oauth-approvals-ddl.js";
```

and directly after the `await initTable("OAuth tables", \`...\`);` block (the one ending with `CREATE INDEX IF NOT EXISTS idx_tokens_type ON oauth_tokens(token_type);`) add:

```js

// OAuth consent gate approvals (2026-10-02). No SCHEMA_GENERATION bump: existing
// installs get the table from scripts/migrations/0008-oauth-client-approvals.mjs
// and from initOAuthTables() on every boot; all three share OAUTH_APPROVALS_DDL.
await initTable("oauth_client_approvals table", `${OAUTH_APPROVALS_DDL};`);
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- tests/oauth-client-approvals-migration.test.js tests/migration-registry.test.js`
Expected: PASS (5 + existing registry tests).

- [ ] **Step 8: Commit**

```bash
git add servers/gateway/oauth-approvals-ddl.js scripts/migrations/0008-oauth-client-approvals.mjs tests/oauth-client-approvals-migration.test.js
git commit servers/gateway/oauth-approvals-ddl.js scripts/migrations/0008-oauth-client-approvals.mjs tests/oauth-client-approvals-migration.test.js servers/gateway/auth.js scripts/init-db.js -m "feat(oauth): oauth_client_approvals table + 0008 migration grandfathering live clients"
git show --stat HEAD
```

---

### Task 2: Consent building blocks (`oauth-consent.js`)

**Files:**
- Create: `servers/gateway/oauth-consent.js`
- Test: `tests/oauth-consent-store.test.js`

**Interfaces:**
- Consumes: `OAUTH_APPROVALS_DDL` (Task 1, tests only); `auditLog` (`servers/db.js`); `parseCookies` (`dashboard/auth.js`); `is2faEnabled`, `getTotpSecret`, `verifyTotp` (`dashboard/totp.js`).
- Produces (all exported from `servers/gateway/oauth-consent.js`):
  - constants `PENDING_TTL_MS` (600000), `MAX_PENDING` (100), `MAX_STEP_UP_FAILURES` (5), `CONSENT_PATH_PREFIX` (`"/dashboard/oauth/consent/"`), `OAUTH_RETURN_COOKIE` (`"crow_oauth_return"`)
  - `class PendingAuthorizations({ttlMs?, max?, now?})` with `create({client, params, requester}) → id`, `get(id) → entry|null`, `take(id) → entry|null`, `purgeClient(clientId) → number`, `size`. Entry: `{id, client, params, requester:{ip, tailnetUser}, createdAt, expiresAt, stepUpFailures}`
  - `isValidPendingId(id) → boolean`, `requesterFromReq(req) → {ip, tailnetUser}`, `isLoopbackRedirect(uri) → boolean`
  - `isClientApproved(db, clientId) → Promise<boolean>`, `approveClient(db, client, {ip}) → Promise<void>`, `listApprovedClients(db) → Promise<Array<{clientId, clientName, redirectUris, approvedVia, approvedIp, approvedAt, liveSessions, lastTokenAt}>>`, `revokeClient(db, clientId, {ip}) → Promise<{revoked, tokensDeleted}>`
  - `isLocalDashboardSession(db, rawSession) → Promise<boolean>`, `consentStepUpRequired(deps?) → Promise<boolean>`, `consentStepUpOk(code, deps?) → Promise<boolean>`
  - `oauthReturnSetCookie(id) → string`, `oauthReturnClearCookie() → string`, `oauthReturnTarget(req) → string|null`

- [ ] **Step 1: Write the failing test** — create `tests/oauth-consent-store.test.js`:

```js
// Consent-gate building blocks (servers/gateway/oauth-consent.js): the pending
// store, request helpers, the login-return cookie, the TOTP step-up and the
// approvals table helpers. Spec: docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  PendingAuthorizations, isValidPendingId, requesterFromReq, isLoopbackRedirect,
  oauthReturnTarget, oauthReturnSetCookie, oauthReturnClearCookie, CONSENT_PATH_PREFIX,
  consentStepUpOk, consentStepUpRequired,
  isClientApproved, approveClient, listApprovedClients, revokeClient, isLocalDashboardSession,
} from "../servers/gateway/oauth-consent.js";
import { OAUTH_APPROVALS_DDL } from "../servers/gateway/oauth-approvals-ddl.js";
import { createDbClient } from "../servers/db.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const client = (id, extra = {}) => ({ client_id: id, client_name: `App ${id}`, redirect_uris: ["http://localhost:1/cb"], ...extra });

// --- PendingAuthorizations -------------------------------------------------

test("create returns a 32-hex id; get returns the entry with requester and zero failures", () => {
  const p = new PendingAuthorizations();
  const id = p.create({ client: client("a"), params: { state: "s" }, requester: { ip: "100.1.2.3", tailnetUser: null } });
  assert.ok(isValidPendingId(id));
  const e = p.get(id);
  assert.equal(e.client.client_id, "a");
  assert.equal(e.requester.ip, "100.1.2.3");
  assert.equal(e.stepUpFailures, 0);
});

test("entries expire after the TTL and are swept", () => {
  let now = 1_000;
  const p = new PendingAuthorizations({ ttlMs: 100, now: () => now });
  const id = p.create({ client: client("a"), params: {} });
  now = 1_099;
  assert.ok(p.get(id));
  now = 1_100;
  assert.equal(p.get(id), null);
  assert.equal(p.size, 0);
});

test("take is single use", () => {
  const p = new PendingAuthorizations();
  const id = p.create({ client: client("a"), params: {} });
  assert.ok(p.take(id));
  assert.equal(p.take(id), null);
});

test("capacity evicts the oldest request first", () => {
  const p = new PendingAuthorizations({ max: 2 });
  const a = p.create({ client: client("a"), params: {} });
  const b = p.create({ client: client("b"), params: {} });
  const c = p.create({ client: client("c"), params: {} });
  assert.equal(p.get(a), null);
  assert.ok(p.get(b) && p.get(c));
});

test("malformed ids never match", () => {
  const p = new PendingAuthorizations();
  for (const bad of [undefined, null, "", "x".repeat(32), "../etc/passwd", "A".repeat(32), "a".repeat(33)]) {
    assert.equal(p.get(bad), null);
  }
});

test("purgeClient drops only that client's requests", () => {
  const p = new PendingAuthorizations();
  const a1 = p.create({ client: client("a"), params: {} });
  const b1 = p.create({ client: client("b"), params: {} });
  assert.equal(p.purgeClient("a"), 1);
  assert.equal(p.get(a1), null);
  assert.ok(p.get(b1));
});

// --- request helpers ---------------------------------------------------------

test("requesterFromReq: strips the v4-mapped prefix and reads the tailnet login", () => {
  assert.deepEqual(requesterFromReq({ ip: "::ffff:100.64.0.9", headers: { "tailscale-user-login": "k@x" } }),
    { ip: "100.64.0.9", tailnetUser: "k@x" });
  assert.deepEqual(requesterFromReq({ headers: {} }), { ip: null, tailnetUser: null });
  assert.deepEqual(requesterFromReq(undefined), { ip: null, tailnetUser: null });
});

test("isLoopbackRedirect: only this machine's addresses count", () => {
  assert.equal(isLoopbackRedirect("http://localhost:33418/callback"), true);
  assert.equal(isLoopbackRedirect("http://127.0.0.1:9/cb"), true);
  assert.equal(isLoopbackRedirect("http://[::1]:9/cb"), true);
  assert.equal(isLoopbackRedirect("https://claude.ai/api/mcp/auth_callback"), false);
  assert.equal(isLoopbackRedirect("http://localhost.evil.com/cb"), false);
  assert.equal(isLoopbackRedirect("not a url"), false);
});

test("login return: only a valid id becomes a consent path", () => {
  const id = "a".repeat(32);
  assert.equal(oauthReturnTarget({ headers: { cookie: `crow_oauth_return=${id}` } }), CONSENT_PATH_PREFIX + id);
  assert.equal(oauthReturnTarget({ headers: { cookie: "crow_oauth_return=https://evil.example" } }), null);
  assert.equal(oauthReturnTarget({ headers: { cookie: "crow_oauth_return=..%2F..%2Fdashboard" } }), null);
  assert.equal(oauthReturnTarget({ headers: {} }), null);
  assert.match(oauthReturnSetCookie(id), new RegExp(`^crow_oauth_return=${id}; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=600`));
  assert.match(oauthReturnClearCookie(), /^crow_oauth_return=; .*Max-Age=0$/);
});

// --- TOTP step-up -------------------------------------------------------------

const totp = ({ enabled, secret = "SECRET", valid = "123456" }) => ({
  is2faEnabled: async () => enabled,
  getTotpSecret: async () => secret,
  verifyTotp: (code, s) => s === secret && code === valid,
});

test("step-up: not required and always ok when 2FA is off", async () => {
  assert.equal(await consentStepUpRequired(totp({ enabled: false })), false);
  assert.equal(await consentStepUpOk(undefined, totp({ enabled: false })), true);
});

test("step-up: with 2FA on, only a valid six-digit code passes", async () => {
  const d = totp({ enabled: true });
  assert.equal(await consentStepUpRequired(d), true);
  assert.equal(await consentStepUpOk("123456", d), true);
  assert.equal(await consentStepUpOk(" 123456 ", d), true);
  assert.equal(await consentStepUpOk("654321", d), false);
  assert.equal(await consentStepUpOk("12345", d), false);
  assert.equal(await consentStepUpOk(undefined, d), false);
  assert.equal(await consentStepUpOk("123456", totp({ enabled: true, secret: null })), false);
});

// --- approvals + sessions on a real scratch DB -------------------------------------

let dir, dbPath, raw, db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "oauth-consent-store-"));
  dbPath = join(dir, "crow.db");
  raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT NOT NULL, client_id TEXT NOT NULL,
      scopes TEXT DEFAULT '', resource TEXT, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
      ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')));
    ${OAUTH_APPROVALS_DDL};
  `);
  db = createDbClient(dbPath);
});
after(() => {
  db.close();
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();

test("approveClient upserts an operator approval and audits it", async () => {
  assert.equal(await isClientApproved(db, "c1"), false);
  await approveClient(db, client("c1"), { ip: "100.1.1.1" });
  await approveClient(db, client("c1", { client_name: "Renamed" }), { ip: "100.1.1.2" });
  assert.equal(await isClientApproved(db, "c1"), true);
  const row = raw.prepare("SELECT * FROM oauth_client_approvals WHERE client_id='c1'").get();
  assert.equal(row.client_name, "Renamed");
  assert.equal(row.approved_ip, "100.1.1.2");
  assert.equal(row.approved_via, "operator");
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM audit_log WHERE event_type='oauth_client_approved'").get().n, 2);
});

test("listApprovedClients counts only live refresh tokens", async () => {
  await approveClient(db, client("c2"), {});
  const ins = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at) VALUES (?, ?, ?, ?)");
  ins.run("r-live", "refresh", "c2", iso(86_400_000));
  ins.run("r-dead", "refresh", "c2", iso(-60_000));
  ins.run("a-live", "access", "c2", iso(60_000));
  const c2 = (await listApprovedClients(db)).find((a) => a.clientId === "c2");
  assert.equal(c2.liveSessions, 1);
  assert.deepEqual(c2.redirectUris, ["http://localhost:1/cb"]);
  assert.equal(c2.approvedVia, "operator");
  assert.ok(c2.lastTokenAt);
});

test("revokeClient deletes the client's tokens and approval atomically, and never touches dashboard sessions", async () => {
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES ('sess', 'access', 'dashboard', 'dashboard', ?)").run(iso(60_000));
  const r = await revokeClient(db, "c2", { ip: "100.1.1.3" });
  assert.deepEqual(r, { revoked: true, tokensDeleted: 3 });
  assert.equal(await isClientApproved(db, "c2"), false);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE client_id='c2'").get().n, 0);
  assert.deepEqual(await revokeClient(db, "dashboard"), { revoked: false, tokensDeleted: 0 });
  assert.deepEqual(await revokeClient(db, ""), { revoked: false, tokensDeleted: 0 });
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE client_id='dashboard'").get().n, 1);
});

test("isLocalDashboardSession: local yes; SSO, expired, unknown and empty no", async () => {
  const ins = raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)");
  ins.run(sha("local"), "dashboard", iso(60_000));
  ins.run(sha("sso"), "dashboard sso", iso(60_000));
  ins.run(sha("old"), "dashboard", iso(-60_000));
  assert.equal(await isLocalDashboardSession(db, "local"), true);
  assert.equal(await isLocalDashboardSession(db, "sso"), false);
  assert.equal(await isLocalDashboardSession(db, "old"), false);
  assert.equal(await isLocalDashboardSession(db, "nope"), false);
  assert.equal(await isLocalDashboardSession(db, undefined), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/oauth-consent-store.test.js`
Expected: FAIL, `Cannot find module '.../servers/gateway/oauth-consent.js'`.

- [ ] **Step 3: Implement** `servers/gateway/oauth-consent.js`:

```js
/**
 * OAuth operator consent gate: pending requests, approvals, and the checks the
 * consent page runs.
 *
 * The OAuth provider (./auth.js) no longer mints an authorization code on
 * /authorize. It parks the request in a PendingAuthorizations store and sends
 * the browser to /dashboard/oauth/consent/<id>, where the operator approves or
 * denies it with a LOCAL dashboard session (plus a TOTP code when 2FA is on).
 * Approvals persist per client in oauth_client_approvals, so token refresh
 * never re-prompts.
 *
 * Spec: docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md
 */
import { randomBytes, createHash } from "node:crypto";
import { auditLog } from "../db.js";
import { parseCookies } from "./dashboard/auth.js";
import { is2faEnabled, getTotpSecret, verifyTotp } from "./dashboard/totp.js";

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING = 100;
export const MAX_STEP_UP_FAILURES = 5;
export const CONSENT_PATH_PREFIX = "/dashboard/oauth/consent/";
export const OAUTH_RETURN_COOKIE = "crow_oauth_return";

const PENDING_ID_RE = /^[a-f0-9]{32}$/;
const TOTP_DEPS = { is2faEnabled, getTotpSecret, verifyTotp };

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

export function isValidPendingId(id) {
  return typeof id === "string" && PENDING_ID_RE.test(id);
}

/**
 * In-memory store of authorization requests awaiting the operator. Single
 * process, short-lived (10 min), so no table: a restart drops pending
 * requests and the client simply retries, exactly like the code map.
 */
export class PendingAuthorizations {
  constructor({ ttlMs = PENDING_TTL_MS, max = MAX_PENDING, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.map = new Map();
  }

  sweep() {
    const t = this.now();
    for (const [id, e] of this.map) if (e.expiresAt <= t) this.map.delete(id);
  }

  create({ client, params, requester }) {
    this.sweep();
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    const id = randomBytes(16).toString("hex");
    const t = this.now();
    this.map.set(id, {
      id,
      client,
      params,
      requester: requester || { ip: null, tailnetUser: null },
      createdAt: t,
      expiresAt: t + this.ttlMs,
      stepUpFailures: 0,
    });
    return id;
  }

  get(id) {
    if (!isValidPendingId(id)) return null;
    const e = this.map.get(id);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.map.delete(id);
      return null;
    }
    return e;
  }

  /** Get-and-remove. Every decision (approve, deny, silent re-auth) takes. */
  take(id) {
    const e = this.get(id);
    if (e) this.map.delete(id);
    return e;
  }

  purgeClient(clientId) {
    let n = 0;
    for (const [id, e] of this.map) {
      if (e.client?.client_id === clientId) {
        this.map.delete(id);
        n++;
      }
    }
    return n;
  }

  get size() {
    return this.map.size;
  }
}

/** Who asked: req.ip (trust proxy 1 → the tailnet client behind Serve) and
 *  the tailscaled-set login header when present. */
export function requesterFromReq(req) {
  const ip = req?.ip ? String(req.ip).replace(/^::ffff:/, "") : null;
  const user = req?.headers?.["tailscale-user-login"];
  return { ip, tailnetUser: typeof user === "string" && user ? user.slice(0, 200) : null };
}

/** True when the redirect URI points at the operator's own machine. */
export function isLoopbackRedirect(uri) {
  try {
    const h = new URL(uri).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

// --- Approvals (oauth_client_approvals) ------------------------------------

export async function isClientApproved(db, clientId) {
  if (!clientId) return false;
  const { rows } = await db.execute({
    sql: "SELECT 1 AS ok FROM oauth_client_approvals WHERE client_id = ?",
    args: [clientId],
  });
  return rows.length > 0;
}

export async function approveClient(db, client, { ip = null } = {}) {
  const name = typeof client.client_name === "string" ? client.client_name.slice(0, 200) : null;
  const uris = JSON.stringify(Array.isArray(client.redirect_uris) ? client.redirect_uris : []);
  await db.execute({
    sql: `INSERT INTO oauth_client_approvals (client_id, client_name, redirect_uris, approved_via, approved_ip)
          VALUES (?, ?, ?, 'operator', ?)
          ON CONFLICT(client_id) DO UPDATE SET
            client_name = excluded.client_name,
            redirect_uris = excluded.redirect_uris,
            approved_via = 'operator',
            approved_ip = excluded.approved_ip,
            approved_at = datetime('now')`,
    args: [client.client_id, name, uris, ip],
  });
  await auditLog(db, "oauth_client_approved", { actor: client.client_id, ip, details: { client_name: name } });
}

function jsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export async function listApprovedClients(db) {
  const { rows } = await db.execute({
    sql: `SELECT a.client_id, a.client_name, a.redirect_uris, a.approved_via, a.approved_ip, a.approved_at,
            (SELECT COUNT(*) FROM oauth_tokens t WHERE t.client_id = a.client_id AND t.token_type = 'refresh'
               AND julianday(t.expires_at) > julianday('now')) AS live_sessions,
            (SELECT MAX(t.created_at) FROM oauth_tokens t WHERE t.client_id = a.client_id) AS last_token_at
          FROM oauth_client_approvals a
          ORDER BY a.approved_at DESC, a.client_id`,
    args: [],
  });
  return rows.map((r) => ({
    clientId: r.client_id,
    clientName: r.client_name || null,
    redirectUris: jsonArray(r.redirect_uris),
    approvedVia: r.approved_via,
    approvedIp: r.approved_ip || null,
    approvedAt: r.approved_at,
    liveSessions: Number(r.live_sessions || 0),
    lastTokenAt: r.last_token_at || null,
  }));
}

/**
 * Revoke: delete every token for the client AND its approval, atomically.
 * The caller also calls provider.purgeClient(clientId) for in-memory codes and
 * pending requests. 'dashboard' (dashboard sessions) is never a target.
 */
export async function revokeClient(db, clientId, { ip = null } = {}) {
  if (!clientId || typeof clientId !== "string" || clientId === "dashboard") {
    return { revoked: false, tokensDeleted: 0 };
  }
  const res = await db.batch([
    { sql: "DELETE FROM oauth_tokens WHERE client_id = ?", args: [clientId] },
    { sql: "DELETE FROM oauth_client_approvals WHERE client_id = ?", args: [clientId] },
  ]);
  const tokensDeleted = res[0]?.rowsAffected || 0;
  const revoked = (res[1]?.rowsAffected || 0) > 0;
  await auditLog(db, "oauth_client_revoked", { actor: clientId, ip, details: { tokensDeleted, hadApproval: revoked } });
  return { revoked, tokensDeleted };
}

// --- Operator checks ---------------------------------------------------------

/** Only a LOCAL password-login session approves. Peer SSO sessions
 *  (scopes 'dashboard sso') are refused, as for phone approvals. */
export async function isLocalDashboardSession(db, rawSession) {
  if (!rawSession) return false;
  const { rows } = await db.execute({
    sql: "SELECT scopes FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard' AND julianday(expires_at) > julianday('now')",
    args: [sha256(rawSession)],
  });
  return rows[0]?.scopes === "dashboard";
}

export async function consentStepUpRequired(deps = TOTP_DEPS) {
  return !!(await deps.is2faEnabled());
}

/** TOTP step-up at approval time, only when 2FA is enabled (phone precedent). */
export async function consentStepUpOk(code, deps = TOTP_DEPS) {
  if (!(await deps.is2faEnabled())) return true;
  const c = String(code ?? "").trim();
  if (!/^\d{6}$/.test(c)) return false;
  const secret = await deps.getTotpSecret();
  return !!secret && deps.verifyTotp(c, secret);
}

// --- Login return (crow_oauth_return cookie) --------------------------------

function secureSuffix() {
  return process.env.CROW_HOSTED || process.env.NODE_ENV === "production" ? "; Secure" : "";
}

export function oauthReturnSetCookie(id) {
  return `${OAUTH_RETURN_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=${PENDING_TTL_MS / 1000}${secureSuffix()}`;
}

export function oauthReturnClearCookie() {
  return `${OAUTH_RETURN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0`;
}

/** The consent path to return to after login, or null. The cookie only ever
 *  supplies a 32-hex id; the path is rebuilt here, so it cannot redirect
 *  anywhere else. */
export function oauthReturnTarget(req) {
  const id = parseCookies(req)[OAUTH_RETURN_COOKIE];
  return isValidPendingId(id) ? CONSENT_PATH_PREFIX + id : null;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/oauth-consent-store.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/oauth-consent.js tests/oauth-consent-store.test.js
git commit servers/gateway/oauth-consent.js tests/oauth-consent-store.test.js -m "feat(oauth): consent-gate pending store, approvals helpers, local-session and TOTP checks"
git show --stat HEAD
```

---

### Task 3: Provider stops minting on `/authorize`

**Files:**
- Modify: `servers/gateway/auth.js` (imports; `CrowOAuthProvider` constructor + `authorize()`; `exchangeAuthorizationCode()`)
- Modify: `servers/gateway/index.js:519` (`app.locals.oauthProvider`)
- Test: `tests/oauth-provider-consent.test.js`

**Interfaces:**
- Consumes: `PendingAuthorizations`, `CONSENT_PATH_PREFIX`, `requesterFromReq`, `isClientApproved`, `approveClient` (Task 2).
- Produces: `provider.pending` (`PendingAuthorizations`), `provider.issueCode(client, params) → string` (client redirect URL with `code`, `state`), `provider.denyRedirect(params, description?) → string` (with `error=access_denied`, `state`), `provider.purgeClient(clientId) → number`. `app.locals.oauthProvider` set in the gateway.

- [ ] **Step 1: Write the failing test** — create `tests/oauth-provider-consent.test.js`:

```js
// CrowOAuthProvider under the consent gate: authorize() parks the request
// instead of minting a code; issueCode()/denyRedirect() build the client
// redirects; exchange refuses unapproved clients; purgeClient() drops a
// revoked client's in-memory state.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initOAuthTables, createOAuthProvider } from "../servers/gateway/auth.js";
import { approveClient } from "../servers/gateway/oauth-consent.js";

let dir, dbPath, provider;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "oauth-provider-consent-"));
  dbPath = join(dir, "crow.db");
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
    ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  d.close();
  await initOAuthTables(dbPath);
  provider = createOAuthProvider(dbPath);
});
after(() => {
  provider.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const client = { client_id: "c-1", client_name: "Unit", redirect_uris: ["http://localhost:7/cb"] };
const params = { redirectUri: "http://localhost:7/cb", state: "xyz", codeChallenge: "ch", scopes: ["mcp:tools"] };

function fakeRes(reqExtra = {}) {
  const out = { status: 200, location: null, body: null };
  const res = {
    req: { ip: "100.70.0.5", headers: { "tailscale-user-login": "k@x" }, ...reqExtra },
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    redirect(c, l) { out.status = c; out.location = l; },
  };
  return { res, out };
}

test("authorize() mints no code and redirects to the consent page", async () => {
  const before = provider.codes.size;
  const { res, out } = fakeRes();
  await provider.authorize(client, params, res);
  assert.equal(out.status, 302);
  assert.match(out.location, /^\/dashboard\/oauth\/consent\/[a-f0-9]{32}$/);
  assert.equal(provider.codes.size, before);
  const pending = provider.pending.get(out.location.split("/").pop());
  assert.equal(pending.client.client_id, "c-1");
  assert.deepEqual(pending.requester, { ip: "100.70.0.5", tailnetUser: "k@x" });
});

test("authorize() still refuses an unregistered redirect URI", async () => {
  const { res, out } = fakeRes();
  await provider.authorize(client, { ...params, redirectUri: "http://localhost:8/other" }, res);
  assert.equal(out.status, 400);
  assert.equal(out.body.error, "invalid_request");
});

test("issueCode() returns the client redirect with code and state", () => {
  const url = new URL(provider.issueCode(client, params));
  assert.equal(url.origin + url.pathname, "http://localhost:7/cb");
  assert.equal(url.searchParams.get("state"), "xyz");
  assert.ok(provider.codes.has(url.searchParams.get("code")));
});

test("denyRedirect() carries access_denied and the state, never a code", () => {
  const url = new URL(provider.denyRedirect(params));
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "xyz");
  assert.equal(url.searchParams.get("code"), null);
});

test("exchangeAuthorizationCode refuses an unapproved client and burns the code", async () => {
  const code = new URL(provider.issueCode(client, params)).searchParams.get("code");
  await assert.rejects(provider.exchangeAuthorizationCode(client, code), /not approved/);
  assert.equal(provider.codes.has(code), false);
});

test("exchangeAuthorizationCode mints tokens once the client is approved", async () => {
  await approveClient(provider.db, client, { ip: "100.70.0.5" });
  const code = new URL(provider.issueCode(client, params)).searchParams.get("code");
  const t = await provider.exchangeAuthorizationCode(client, code);
  assert.ok(t.access_token && t.refresh_token);
  assert.equal((await provider.verifyAccessToken(t.access_token)).clientId, "c-1");
});

test("purgeClient() drops that client's codes and pending requests only", async () => {
  const other = { ...client, client_id: "c-2" };
  const mine = new URL(provider.issueCode(client, params)).searchParams.get("code");
  const theirs = new URL(provider.issueCode(other, params)).searchParams.get("code");
  const { res, out } = fakeRes();
  await provider.authorize(client, params, res);
  const removed = provider.purgeClient("c-1");
  assert.ok(removed >= 1, "this test's pending request (and the first test's) are dropped");
  assert.equal(provider.codes.has(mine), false);
  assert.equal(provider.codes.has(theirs), true);
  assert.equal(provider.pending.get(out.location.split("/").pop()), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/oauth-provider-consent.test.js`
Expected: FAIL, first test: `302 !== ...` / location is `http://localhost:7/cb?code=...` (today's auto-approve), and `provider.issueCode is not a function`.

- [ ] **Step 3: Change the imports** at the top of `servers/gateway/auth.js`. Replace

```js
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
```

with

```js
import { InvalidTokenError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
```

and below the `OAUTH_APPROVALS_DDL` import (Task 1) add

```js
import {
  PendingAuthorizations, CONSENT_PATH_PREFIX, requesterFromReq, isClientApproved,
} from "./oauth-consent.js";
```

- [ ] **Step 4: Replace the constructor and `authorize()`.** Replace everything from `export class CrowOAuthProvider {` down to (not including) `  async challengeForAuthorizationCode(client, authorizationCode) {` with:

```js
export class CrowOAuthProvider {
  constructor(db, { pending } = {}) {
    this.db = db;
    this.clientsStore = new CrowOAuthClientsStore(db);
    this.codes = new Map(); // Ephemeral — auth codes are short-lived
    // Consent gate: /authorize parks requests here until the operator decides.
    this.pending = pending || new PendingAuthorizations();
  }

  /**
   * Consent gate (spec 2026-10-02-oauth-consent-gate-design.md §4). No code is
   * minted here any more: the request waits in this.pending and the browser
   * goes to the dashboard consent page, which calls issueCode() or
   * denyRedirect() once the operator decides.
   */
  async authorize(client, params, res) {
    if (!client.redirect_uris || !client.redirect_uris.includes(params.redirectUri)) {
      res.status(400).json({ error: "invalid_request", error_description: "Unregistered redirect_uri" });
      return;
    }
    const requester = requesterFromReq(res.req);
    const id = this.pending.create({ client, params, requester });
    await auditLog(this.db, "oauth_authorize_pending", { actor: client.client_id, ip: requester.ip });
    res.redirect(302, CONSENT_PATH_PREFIX + id);
  }

  /** Mint a single-use code for an operator-approved request; returns the
   *  client redirect URL carrying it (same shape authorize() used to send). */
  issueCode(client, params) {
    const code = randomUUID();
    this.codes.set(code, { client, params, expiresAt: Date.now() + 600000 }); // 10 min
    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) searchParams.set("state", params.state);
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    return targetUrl.toString();
  }

  /** The RFC 6749 §4.1.2.1 access_denied redirect for a refused request. */
  denyRedirect(params, description = "The operator denied this request") {
    const searchParams = new URLSearchParams({ error: "access_denied", error_description: description });
    if (params.state !== undefined) searchParams.set("state", params.state);
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    return targetUrl.toString();
  }

  /** Drop a revoked client's in-flight codes and pending requests. */
  purgeClient(clientId) {
    for (const [code, data] of this.codes) {
      if (data.client?.client_id === clientId) this.codes.delete(code);
    }
    return this.pending.purgeClient(clientId);
  }
```

- [ ] **Step 5: Refuse unapproved clients at exchange.** In `exchangeAuthorizationCode()`, replace

```js
    if (codeData.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
```

with

```js
    if (codeData.client.client_id !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    // Consent gate, second check: codes only come from the consent path, and
    // revoke purges them, but never mint for a client with no approval row.
    if (!(await isClientApproved(this.db, client.client_id))) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Client is not approved by the operator");
    }
```

- [ ] **Step 6: Expose the provider to the consent routes.** In `servers/gateway/index.js`, replace

```js
  const provider = createOAuthProvider();
```

with

```js
  const provider = createOAuthProvider();
  // The consent routes (routes/oauth-consent.js) and the Connect panel's
  // revoke reach the provider's pending requests and codes through here.
  app.locals.oauthProvider = provider;
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- tests/oauth-provider-consent.test.js tests/timestamp-expiry-boundary.test.js tests/oauth-client-approvals-migration.test.js`
Expected: PASS. (`timestamp-expiry-boundary` proves `verifyAccessToken` is unchanged: its DB has no approvals table and its token still verifies.)

- [ ] **Step 8: Commit**

```bash
git add tests/oauth-provider-consent.test.js
git commit servers/gateway/auth.js servers/gateway/index.js tests/oauth-provider-consent.test.js -m "feat(oauth): authorize() parks requests for operator consent instead of minting codes"
git show --stat HEAD
```

> Between Task 3 and Task 5 the gateway has no consent page, so `/authorize` redirects to a 404. Do not deploy a partial branch; the branch ships as one PR.

---

### Task 4: Consent page renderers and copy

**Files:**
- Modify: `servers/gateway/dashboard/shared/layout.js` (insert before the `/**\n * Render the 2FA recovery code entry page.\n */` comment)
- Modify: `servers/gateway/dashboard/shared/i18n.js` (after `"connect.token.actionError"`; and `"connect.oauthNote"`)
- Test: `tests/oauth-consent-page.test.js`

**Interfaces:**
- Produces: `renderOAuthConsent({lang, error, stepUp, csrf, action, clientName, clientId, redirectUri, remoteRedirect, scopes, requesterIp, requesterUser, requestedAt}) → string`, `renderOAuthNotice({title, message, lang}) → string`. Keys `oauthConsent.*` (19) and `connect.oauth.*` (8).

- [ ] **Step 1: Write the failing test** — create `tests/oauth-consent-page.test.js`:

```js
// Consent page + notice renderers (spec docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §4.5).
// Everything the app supplies through Dynamic Client Registration is hostile
// input: it must come out escaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderOAuthConsent, renderOAuthNotice } from "../servers/gateway/dashboard/shared/layout.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";

const base = {
  lang: "en", error: null, stepUp: false, csrf: "tok-1", action: "/dashboard/oauth/consent/" + "a".repeat(32),
  clientName: "Claude Code", clientId: "cid-123", redirectUri: "http://localhost:5/cb", remoteRedirect: false,
  scopes: ["mcp:tools"], requesterIp: "100.64.0.9", requesterUser: "k@example.com", requestedAt: "2026-10-02T12:00:00.000Z",
};

test("shows every field the operator decides on, plus Approve and Deny", () => {
  const html = renderOAuthConsent(base);
  for (const s of ["Claude Code", "cid-123", "http://localhost:5/cb", "mcp:tools", "100.64.0.9", "k@example.com",
    t("oauthConsent.scopesFullAccess", "en"), t("oauthConsent.clientNameNote", "en")]) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
  assert.ok(html.includes('name="action" value="approve"') && html.includes('name="action" value="deny"'));
  assert.ok(html.includes('name="_csrf" value="tok-1"'));
  assert.ok(html.includes(`action="${base.action}"`));
});

test("app-supplied values are escaped", () => {
  const html = renderOAuthConsent({ ...base, clientName: '<img src=x onerror=alert(1)>', redirectUri: 'http://localhost/"><b>x', scopes: ["<s>"] });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes('"><b>x'));
  assert.ok(html.includes("&lt;s&gt;"));
});

test("2FA field only when step-up is required; Deny never needs it", () => {
  assert.ok(!renderOAuthConsent(base).includes('name="totp_code"'));
  const html = renderOAuthConsent({ ...base, stepUp: true });
  assert.ok(html.includes('name="totp_code"'));
  assert.match(html, /value="deny" formnovalidate/);
});

test("remote redirect warning, unnamed app, no scopes, unknown IP, error and Spanish", () => {
  const html = renderOAuthConsent({ ...base, remoteRedirect: true, clientName: null, scopes: [], requesterIp: null, error: "Bad code", lang: "es" });
  assert.ok(html.includes(t("oauthConsent.redirectRemoteWarning", "es")));
  assert.ok(html.includes(t("oauthConsent.unnamed", "es")));
  assert.ok(html.includes(t("oauthConsent.scopesNone", "es")));
  assert.ok(html.includes(t("oauthConsent.unknown", "es")));
  assert.ok(html.includes("Bad code"));
  assert.ok(html.includes('<html lang="es">'));
});

test("notice page escapes its text", () => {
  const html = renderOAuthNotice({ title: "Gone <x>", message: "Try again & retry", lang: "en" });
  assert.ok(html.includes("Gone &lt;x&gt;") && html.includes("Try again &amp; retry"));
});

test("every oauthConsent.* key has en + es and no em dash", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("oauthConsent."));
  assert.equal(keys.length, 19);
  for (const k of keys) for (const l of ["en", "es"]) {
    assert.ok(translations[k][l]?.trim(), `${k}.${l}`);
    assert.ok(!translations[k][l].includes("—"), `${k}.${l} em dash`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/oauth-consent-page.test.js`
Expected: FAIL, `renderOAuthConsent is not a function` / `does not provide an export named 'renderOAuthConsent'`.

- [ ] **Step 3: Add the renderers** to `servers/gateway/dashboard/shared/layout.js`, immediately before the `/**` that opens `Render the 2FA recovery code entry page.` (they use the file's own `escapeHtml`, `t`, `FONT_LINKS`, `dashboardCss`):

```js
/**
 * OAuth consent page (spec 2026-10-02-oauth-consent-gate-design.md §4.5).
 * Standalone like the login pages: no Turbo, no script. The client name,
 * redirect URI and scopes come from Dynamic Client Registration, so they are
 * attacker-controlled: every one is escaped and the name is labelled as
 * supplied by the app.
 */
export function renderOAuthConsent({
  lang, error, stepUp, csrf, action, clientName, clientId, redirectUri,
  remoteRedirect, scopes, requesterIp, requesterUser, requestedAt,
} = {}) {
  const L = lang || "en";
  const s = (v) => escapeHtml(String(v ?? ""));
  const muted = "font-size:0.75rem;color:var(--crow-text-tertiary)";
  const row = (label, valueHtml) =>
    `<div style="margin:0.6rem 0;text-align:left"><div style="${muted}">${s(label)}</div>` +
    `<div style="font-size:0.9rem;word-break:break-all">${valueHtml}</div></div>`;
  const scopeText = Array.isArray(scopes) && scopes.length ? scopes.join(" ") : t("oauthConsent.scopesNone", L);
  const who = s(requesterIp || t("oauthConsent.unknown", L)) + (requesterUser ? ` (${s(requesterUser)})` : "");
  return `<!DOCTYPE html>
<html lang="${s(L)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${s(t("oauthConsent.pageTitle", L))} — Crow's Nest</title>
  ${FONT_LINKS}
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${s(t("oauthConsent.subtitle", L))}</p>
      ${error ? `<div class="login-error">${s(error)}</div>` : ""}
      ${row(t("oauthConsent.clientName", L), `<strong>${s(clientName || t("oauthConsent.unnamed", L))}</strong> <span style="${muted}">(${s(t("oauthConsent.clientNameNote", L))})</span>`)}
      ${row(t("oauthConsent.redirectUri", L), `<code>${s(redirectUri)}</code>`)}
      ${remoteRedirect ? `<div class="login-error" style="text-align:left">${s(t("oauthConsent.redirectRemoteWarning", L))}</div>` : ""}
      ${row(t("oauthConsent.scopes", L), `<code>${s(scopeText)}</code><div style="margin-top:0.25rem">${s(t("oauthConsent.scopesFullAccess", L))}</div>`)}
      ${row(t("oauthConsent.requestedFrom", L), `${who} <span style="${muted}">${s(requestedAt)}</span>`)}
      ${row(t("oauthConsent.clientId", L), `<code style="font-size:0.75rem">${s(clientId)}</code>`)}
      <form method="POST" action="${s(action)}" data-turbo="false">
        <input type="hidden" name="_csrf" value="${s(csrf)}">
        ${stepUp ? `<input type="text" name="totp_code" placeholder="${s(t("oauthConsent.totpLabel", L))}" aria-label="${s(t("oauthConsent.totpLabel", L))}" required autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" style="text-align:center;font-size:1.2rem;letter-spacing:0.2em">` : ""}
        <button type="submit" name="action" value="approve">${s(t("oauthConsent.approve", L))}</button>
        <button type="submit" name="action" value="deny" formnovalidate style="margin-top:0.5rem;background:transparent;border:1px solid var(--crow-border);color:var(--crow-text-secondary)">${s(t("oauthConsent.deny", L))}</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

/** One-message card for consent outcomes that have no client to redirect to
 *  (expired or already-answered requests). */
export function renderOAuthNotice({ title, message, lang } = {}) {
  const L = lang || "en";
  const s = (v) => escapeHtml(String(v ?? ""));
  return `<!DOCTYPE html>
<html lang="${s(L)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>${s(title)} — Crow's Nest</title>
  ${FONT_LINKS}
  ${dashboardCss()}
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-logo">Crow</h1>
      <p class="login-subtitle">${s(title)}</p>
      <p style="font-size:0.9rem;color:var(--crow-text-secondary)">${s(message)}</p>
    </div>
  </div>
</body>
</html>`;
}
```

- [ ] **Step 4: Add the copy** to `servers/gateway/dashboard/shared/i18n.js`, directly after the `"connect.token.actionError": { ... },` entry:

```js
  // ─── OAuth consent gate (2026-10-02) ───
  "oauthConsent.pageTitle": { en: "Approve app", es: "Aprobar aplicación" },
  "oauthConsent.subtitle": {
    en: "An app wants to connect to your Crow. Approve it only if you started this connection yourself.",
    es: "Una aplicación quiere conectarse a tu Crow. Apruébala solo si tú iniciaste esta conexión.",
  },
  "oauthConsent.clientName": { en: "App", es: "Aplicación" },
  "oauthConsent.clientNameNote": { en: "name supplied by the app", es: "nombre indicado por la aplicación" },
  "oauthConsent.unnamed": { en: "Unnamed app", es: "Aplicación sin nombre" },
  "oauthConsent.redirectUri": { en: "Sends access to", es: "Envía el acceso a" },
  "oauthConsent.redirectRemoteWarning": {
    en: "This address is not a local address on your computer. Approve only if you recognize it.",
    es: "Esta dirección no es una dirección local de tu computadora. Apruébala solo si la reconoces.",
  },
  "oauthConsent.scopes": { en: "Requested scopes", es: "Permisos solicitados" },
  "oauthConsent.scopesNone": { en: "(none requested)", es: "(no se solicitó ninguno)" },
  "oauthConsent.scopesFullAccess": {
    en: "Approving gives this app full access to every Crow tool: memories, projects, messages and files.",
    es: "Al aprobar, esta aplicación tendrá acceso completo a todas las herramientas de Crow: memorias, proyectos, mensajes y archivos.",
  },
  "oauthConsent.requestedFrom": { en: "Requested from", es: "Solicitado desde" },
  "oauthConsent.unknown": { en: "unknown", es: "desconocido" },
  "oauthConsent.clientId": { en: "Client ID", es: "ID de cliente" },
  "oauthConsent.totpLabel": { en: "2FA code", es: "Código 2FA" },
  "oauthConsent.approve": { en: "Approve", es: "Aprobar" },
  "oauthConsent.deny": { en: "Deny", es: "Denegar" },
  "oauthConsent.errorTotp": {
    en: "That 2FA code is not valid. Try again.",
    es: "Ese código 2FA no es válido. Inténtalo de nuevo.",
  },
  "oauthConsent.expiredTitle": { en: "Request expired", es: "Solicitud vencida" },
  "oauthConsent.expiredBody": {
    en: "This approval request has expired or was already answered. Start the connection again from your app.",
    es: "Esta solicitud de aprobación venció o ya fue respondida. Vuelve a iniciar la conexión desde tu aplicación.",
  },
  "connect.oauth.heading": { en: "Approved apps", es: "Aplicaciones aprobadas" },
  "connect.oauth.intro": {
    en: "Apps you approved through the browser sign-in. Revoking an app ends its access right away, and it must ask for approval again to reconnect.",
    es: "Aplicaciones que aprobaste al iniciar sesión en el navegador. Al revocar una aplicación, su acceso termina de inmediato y tendrá que pedir aprobación otra vez para reconectarse.",
  },
  "connect.oauth.empty": { en: "No apps are approved yet.", es: "Todavía no hay aplicaciones aprobadas." },
  "connect.oauth.approvedAt": { en: "Approved {when}", es: "Aprobada {when}" },
  "connect.oauth.grandfathered": {
    en: "Connected before approvals existed",
    es: "Conectada antes de que existieran las aprobaciones",
  },
  "connect.oauth.liveSessions": { en: "Active sign-ins: {n}", es: "Sesiones activas: {n}" },
  "connect.oauth.revoke": { en: "Revoke", es: "Revocar" },
  "connect.oauth.revoked": { en: "Access revoked.", es: "Acceso revocado." },
```

and replace the existing `"connect.oauthNote"` entry with:

```js
  "connect.oauthNote": {
    en: "On first use the client opens a browser. Sign in to Crow's Nest and approve the app. No token is needed.",
    es: "En el primer uso el cliente abre un navegador. Inicia sesión en el Nido del Cuervo y aprueba la aplicación. No se necesita ningún token.",
  },
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/oauth-consent-page.test.js tests/i18n-global-parity.test.js tests/connect.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/oauth-consent-page.test.js
git commit servers/gateway/dashboard/shared/layout.js servers/gateway/dashboard/shared/i18n.js tests/oauth-consent-page.test.js -m "feat(oauth): consent page renderers and EN/ES copy"
git show --stat HEAD
```

---

### Task 5: Consent routes, mount and post-login return

**Files:**
- Create: `servers/gateway/routes/oauth-consent.js`
- Modify: `servers/gateway/dashboard/index.js` (imports; `POST /dashboard/login`; `POST /dashboard/login/2fa`; `POST /dashboard/login/2fa/recovery`; mount before `// --- Protected routes ---`)
- Test: `tests/oauth-consent-gate.test.js`

**Interfaces:**
- Consumes: Task 2 exports; `provider.pending/issueCode/denyRedirect` (Task 3) via `req.app.locals.oauthProvider`; `renderOAuthConsent/renderOAuthNotice` (Task 4); `isAllowedNetwork`, `parseCookies` (`dashboard/auth.js`); `csrfMiddleware` (`dashboard/shared/csrf.js`).
- Produces: `export default function oauthConsentRouter({ dbFactory?, totpDeps? }) → express.Router` serving `GET|POST /dashboard/oauth/consent/:id`.

- [ ] **Step 1: Write the failing test** — create `tests/oauth-consent-gate.test.js`:

```js
// OAuth operator consent gate, end to end over HTTP
// (spec docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §12).
//
// A real Express app with the MCP SDK's mcpAuthRouter (register / authorize /
// token), Crow's provider, the global Funnel reject middleware and the consent
// router, on a scratch DB. Sessions are seeded straight into oauth_tokens the
// way dashboard/auth.js stores them. Requests carry Tailscale-User-Login +
// X-Forwarded-For so isAllowedNetwork() sees a tailnet caller, as it does
// behind Tailscale Serve.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import * as OTPAuth from "otpauth";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const TS = { "tailscale-user-login": "kevin@example.com", "x-forwarded-for": "100.101.102.103" };
const CSRF = "csrf-test-value";
const REDIRECT = "http://localhost:9999/cb";

const saved = { CROW_DB_PATH: process.env.CROW_DB_PATH };
let dir, dbPath, raw, server, base, provider, oauthConsent;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "oauth-consent-"));
  dbPath = join(dir, "crow.db");
  process.env.CROW_DB_PATH = dbPath;
  raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
      ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  const { initOAuthTables, createOAuthProvider } = await import("../servers/gateway/auth.js");
  await initOAuthTables(dbPath);
  provider = createOAuthProvider(dbPath);
  oauthConsent = await import("../servers/gateway/oauth-consent.js");

  const { default: express } = await import("express");
  const { mcpAuthRouter } = await import("@modelcontextprotocol/sdk/server/auth/router.js");
  const { rejectFunneledMiddleware } = await import("../servers/gateway/funnel.js");
  const { default: oauthConsentRouter } = await import("../servers/gateway/routes/oauth-consent.js");

  const app = express();
  app.set("trust proxy", 1);
  app.use(rejectFunneledMiddleware());
  app.locals.oauthProvider = provider;
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL("http://localhost"),
    scopesSupported: ["mcp:tools"],
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
  }));
  app.use(oauthConsentRouter());
  server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { provider.db.close(); } catch {}
  try { raw.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  if (saved.CROW_DB_PATH === undefined) delete process.env.CROW_DB_PATH;
  else process.env.CROW_DB_PATH = saved.CROW_DB_PATH;
});

function session(scopes = "dashboard") {
  const tok = randomBytes(32).toString("hex");
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)")
    .run(sha(tok), scopes, new Date(Date.now() + 3_600_000).toISOString());
  return tok;
}
const cookieFor = (sess) => `crow_session=${sess}; crow_csrf=${CSRF}`;

async function register(name = "Test App", redirect = REDIRECT) {
  const r = await fetch(base + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
  });
  assert.equal(r.status, 201);
  return r.json();
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorize(client, challenge, state = "st-1") {
  const u = new URL(base + "/authorize");
  u.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp:tools",
  }).toString();
  return fetch(u, { redirect: "manual", headers: TS });
}

function consentGet(location, sess, extra = {}) {
  return fetch(base + location, {
    redirect: "manual",
    headers: { ...TS, ...(sess ? { cookie: cookieFor(sess) } : {}), ...extra },
  });
}

function consentPost(location, sess, fields, csrf = CSRF) {
  return fetch(base + location, {
    method: "POST",
    redirect: "manual",
    headers: { ...TS, cookie: cookieFor(sess), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, ...fields }).toString(),
  });
}

function token(fields) {
  return fetch(base + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function exchange(client, code, verifier) {
  return token({
    grant_type: "authorization_code", client_id: client.client_id, code,
    code_verifier: verifier, redirect_uri: client.redirect_uris[0],
  });
}

async function pendingLocation(client, challenge, state) {
  const r = await authorize(client, challenge, state);
  assert.equal(r.status, 302);
  const loc = r.headers.get("location");
  assert.match(loc, /^\/dashboard\/oauth\/consent\/[a-f0-9]{32}$/);
  return loc;
}

/** Register + approve through the page; returns { client, tokens, verifier }. */
async function approvedClient(name) {
  const client = await register(name);
  const { verifier, challenge } = pkce();
  const loc = await pendingLocation(client, challenge, "s");
  const r = await consentPost(loc, session(), { action: "approve" });
  assert.equal(r.status, 303);
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const tr = await exchange(client, code, verifier);
  assert.equal(tr.status, 200);
  return { client, tokens: await tr.json(), verifier };
}

const approvalRow = (clientId) =>
  raw.prepare("SELECT * FROM oauth_client_approvals WHERE client_id = ?").get(clientId);

test("a new client gets NO code from /authorize: it is sent to the consent page", async () => {
  const client = await register();
  const { challenge } = pkce();
  const before = provider.codes.size;
  const loc = await pendingLocation(client, challenge);
  assert.ok(!loc.includes("code="), "no code in the redirect");
  assert.equal(provider.codes.size, before, "no code minted");
});

test("without a session the consent page sends the operator to log in and remembers the request", async () => {
  const client = await register();
  const loc = await pendingLocation(client, pkce().challenge);
  const r = await consentGet(loc, null);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/dashboard/login");
  const id = loc.split("/").pop();
  assert.match(r.headers.get("set-cookie") || "", new RegExp(`crow_oauth_return=${id};.*Path=/dashboard`));
});

test("an SSO-only session cannot approve: it is sent to log in locally", async () => {
  const client = await register();
  const loc = await pendingLocation(client, pkce().challenge);
  const r = await consentGet(loc, session("dashboard sso"));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/dashboard/login");
});

test("an off-network caller (bare loopback, no Tailscale headers) gets 403", async () => {
  const client = await register();
  const loc = await pendingLocation(client, pkce().challenge);
  const r = await fetch(base + loc, { redirect: "manual", headers: { cookie: cookieFor(session()) } });
  assert.equal(r.status, 403);
});

test("a funneled request for the consent page gets 403 (network-exposure invariant)", async () => {
  const client = await register();
  const loc = await pendingLocation(client, pkce().challenge);
  const r = await consentGet(loc, session(), { "tailscale-funnel-request": "?1" });
  assert.equal(r.status, 403);
});

test("the consent page shows name, redirect URI, scopes and requesting IP, and cannot be framed", async () => {
  const client = await register("Claude <Code>");
  const loc = await pendingLocation(client, pkce().challenge);
  const r = await consentGet(loc, session());
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("Claude &lt;Code&gt;"), "client name, escaped");
  assert.ok(!html.includes("Claude <Code>"), "never raw");
  assert.ok(html.includes(REDIRECT), "redirect URI");
  assert.ok(html.includes("mcp:tools"), "requested scopes");
  assert.ok(html.includes("100.101.102.103"), "requesting IP from X-Forwarded-For");
  assert.ok(html.includes("kevin@example.com"), "tailnet user");
  assert.ok(html.includes(`name="_csrf" value="${CSRF}"`), "CSRF token in the form");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("a non-loopback redirect URI carries a warning", async () => {
  const client = await register("Remote", "https://example.net/cb");
  const loc = await pendingLocation(client, pkce().challenge);
  const html = await (await consentGet(loc, session())).text();
  assert.ok(html.includes("not a local address"));
});

test("approve mints a code that exchanges for tokens, and records the approval", async () => {
  const client = await register("Approver");
  const { verifier, challenge } = pkce();
  const loc = await pendingLocation(client, challenge, "st-approve");
  const r = await consentPost(loc, session(), { action: "approve" });
  assert.equal(r.status, 303);
  const dest = new URL(r.headers.get("location"));
  assert.equal(dest.origin + dest.pathname, REDIRECT);
  assert.equal(dest.searchParams.get("state"), "st-approve");
  const tr = await exchange(client, dest.searchParams.get("code"), verifier);
  assert.equal(tr.status, 200);
  const tokens = await tr.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  const row = approvalRow(client.client_id);
  assert.equal(row.approved_via, "operator");
  assert.equal(row.approved_ip, "100.101.102.103");
  assert.equal(row.client_name, "Approver");
  // The request is single use.
  assert.equal((await consentGet(loc, session())).status, 410);
});

test("refresh works with no consent step", async () => {
  const { client, tokens } = await approvedClient("Refresher");
  const r = await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).access_token);
});

test("an approved client re-authorizes with no page, but only with a local session", async () => {
  const { client } = await approvedClient("Returning");
  const { verifier, challenge } = pkce();
  const loc = await pendingLocation(client, challenge, "again");
  assert.equal((await consentGet(loc, null)).headers.get("location"), "/dashboard/login", "no session: log in first");
  const r = await consentGet(loc, session());
  assert.equal(r.status, 302);
  const dest = new URL(r.headers.get("location"));
  assert.equal(dest.searchParams.get("state"), "again");
  assert.equal((await exchange(client, dest.searchParams.get("code"), verifier)).status, 200);
});

test("deny returns access_denied with the state and approves nothing", async () => {
  const client = await register("Denied");
  const loc = await pendingLocation(client, pkce().challenge, "st-deny");
  const r = await consentPost(loc, session(), { action: "deny" });
  assert.equal(r.status, 303);
  const dest = new URL(r.headers.get("location"));
  assert.equal(dest.searchParams.get("error"), "access_denied");
  assert.equal(dest.searchParams.get("state"), "st-deny");
  assert.equal(dest.searchParams.get("code"), null);
  assert.equal(approvalRow(client.client_id), undefined);
  assert.equal((await consentGet(loc, session())).status, 410, "single use");
});

test("an expired request cannot be approved", async () => {
  const client = await register("Late");
  const loc = await pendingLocation(client, pkce().challenge);
  provider.pending.get(loc.split("/").pop()).expiresAt = Date.now() - 1;
  const r = await consentPost(loc, session(), { action: "approve" });
  assert.equal(r.status, 410);
  assert.equal(approvalRow(client.client_id), undefined);
});

test("a malformed request id is treated as expired", async () => {
  assert.equal((await consentGet("/dashboard/oauth/consent/not-an-id", session())).status, 410);
});

test("CSRF: an approve without the matching token is rejected", async () => {
  const client = await register("Csrf");
  const loc = await pendingLocation(client, pkce().challenge);
  const r = await consentPost(loc, session(), { action: "approve" }, "wrong");
  assert.equal(r.status, 403);
  assert.equal(approvalRow(client.client_id), undefined);
});

test("with 2FA on, approve needs a valid TOTP code, and the fifth bad code denies", async () => {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  raw.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('totp_enabled', 'true'), ('totp_secret', ?)").run(secret);
  try {
    const client = await register("TwoFactor");
    const { verifier, challenge } = pkce();
    const loc = await pendingLocation(client, challenge);
    const page = await (await consentGet(loc, session())).text();
    assert.ok(page.includes('name="totp_code"'), "the page asks for a code");

    const bad = await consentPost(loc, session(), { action: "approve", totp_code: "000000" });
    assert.equal(bad.status, 400);
    assert.equal(approvalRow(client.client_id), undefined);

    const code = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
    const ok = await consentPost(loc, session(), { action: "approve", totp_code: code });
    assert.equal(ok.status, 303);
    const dest = new URL(ok.headers.get("location"));
    assert.equal((await exchange(client, dest.searchParams.get("code"), verifier)).status, 200);

    const client2 = await register("Guesser");
    const loc2 = await pendingLocation(client2, pkce().challenge);
    let last;
    for (let i = 0; i < 5; i++) last = await consentPost(loc2, session(), { action: "approve", totp_code: "000000" });
    assert.equal(last.status, 303);
    assert.equal(new URL(last.headers.get("location")).searchParams.get("error"), "access_denied");
    assert.equal(approvalRow(client2.client_id), undefined);
  } finally {
    raw.prepare("DELETE FROM dashboard_settings WHERE key IN ('totp_enabled', 'totp_secret')").run();
  }
});

test("revoke deletes tokens, refresh fails, and the next authorization prompts again", async () => {
  const { client, tokens } = await approvedClient("Revoked");
  const db = provider.db;
  const res = await oauthConsent.revokeClient(db, client.client_id, { ip: "100.101.102.103" });
  provider.purgeClient(client.client_id);
  assert.equal(res.revoked, true);
  assert.equal(res.tokensDeleted, 2, "access + refresh");
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid token/);
  const rr = await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token });
  assert.notEqual(rr.status, 200);
  const loc = await pendingLocation(client, pkce().challenge);
  const page = await consentGet(loc, session());
  assert.equal(page.status, 200, "the consent page shows again");
});

test("a code minted before a revoke cannot be exchanged after it", async () => {
  const client = await register("Racer");
  const { verifier, challenge } = pkce();
  const loc = await pendingLocation(client, challenge);
  const r = await consentPost(loc, session(), { action: "approve" });
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  await oauthConsent.revokeClient(provider.db, client.client_id);
  provider.purgeClient(client.client_id);
  assert.notEqual((await exchange(client, code, verifier)).status, 200);
});

test("a code forged into the code map for an unapproved client is never exchanged", async () => {
  const client = await register("Forger");
  const { verifier, challenge } = pkce();
  provider.codes.set("forged-code", {
    client,
    params: { redirectUri: REDIRECT, codeChallenge: challenge, scopes: [] },
    expiresAt: Date.now() + 60_000,
  });
  const r = await exchange(client, "forged-code", verifier);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_grant");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/oauth-consent-gate.test.js`
Expected: FAIL, `Cannot find module '.../servers/gateway/routes/oauth-consent.js'`.

- [ ] **Step 3: Implement the router** `servers/gateway/routes/oauth-consent.js`:

```js
/**
 * OAuth operator consent pages: GET/POST /dashboard/oauth/consent/:id.
 *
 * Spec: docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §4.3.
 *
 * Mounted inside the dashboard router BEFORE dashboardAuth, because it must
 * set the crow_oauth_return cookie before sending the operator to log in.
 * It therefore re-applies the network gate itself. It is never reachable via
 * Funnel: /dashboard/* is not in PUBLIC_FUNNEL_PREFIXES, so the global
 * rejectFunneledMiddleware 403s it first.
 */
import express, { Router } from "express";
import { createDbClient, auditLog } from "../../db.js";
import { isAllowedNetwork, parseCookies } from "../dashboard/auth.js";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import { SUPPORTED_LANGS, t } from "../dashboard/shared/i18n.js";
import { renderOAuthConsent, renderOAuthNotice } from "../dashboard/shared/layout.js";
import {
  CONSENT_PATH_PREFIX, MAX_STEP_UP_FAILURES,
  isClientApproved, approveClient, isLocalDashboardSession,
  consentStepUpOk, consentStepUpRequired, oauthReturnSetCookie, isLoopbackRedirect,
} from "../oauth-consent.js";

function langOf(req) {
  const l = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(l) ? l : "en";
}

/** The global CSP allows `frame-ancestors 'self' https:` (companion iframe).
 *  A consent page must never be framable, or any HTTPS site could clickjack
 *  the Approve button. Tighten it for this page only. */
function noFraming(res) {
  res.setHeader("X-Frame-Options", "DENY");
  const csp = res.getHeader("Content-Security-Policy");
  if (typeof csp === "string" && /frame-ancestors/.test(csp)) {
    res.setHeader("Content-Security-Policy", csp.replace(/frame-ancestors[^;]*/, "frame-ancestors 'none'"));
  } else {
    res.setHeader("Content-Security-Policy", (typeof csp === "string" && csp ? csp + "; " : "") + "frame-ancestors 'none'");
  }
}

function expired(res, lang) {
  res.status(410).type("html").send(renderOAuthNotice({
    title: t("oauthConsent.expiredTitle", lang),
    message: t("oauthConsent.expiredBody", lang),
    lang,
  }));
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.dbFactory] - returns a db client (default createDbClient)
 * @param {object} [opts.totpDeps] - { is2faEnabled, getTotpSecret, verifyTotp } override for tests
 */
export default function oauthConsentRouter({ dbFactory = createDbClient, totpDeps } = {}) {
  const router = Router();
  const path = CONSENT_PATH_PREFIX + ":id";

  // Shared front half: network, provider, pending entry, local session.
  // Returns { provider, pending, lang } or null after it has responded.
  async function front(req, res, db) {
    if (!isAllowedNetwork(req)) {
      res.status(403).type("text/plain").send("Forbidden: local network or Tailscale only.");
      return null;
    }
    const lang = langOf(req);
    const provider = req.app?.locals?.oauthProvider;
    if (!provider) {
      res.status(404).type("text/plain").send("Not found.");
      return null;
    }
    const pending = provider.pending.get(req.params.id);
    if (!pending) {
      expired(res, lang);
      return null;
    }
    if (!(await isLocalDashboardSession(db, parseCookies(req).crow_session))) {
      res.setHeader("Set-Cookie", oauthReturnSetCookie(pending.id));
      res.redirect(req.method === "GET" ? 302 : 303, "/dashboard/login");
      return null;
    }
    return { provider, pending, lang };
  }

  async function page(req, res, { pending, lang, error = null, status = 200 }) {
    const stepUp = await consentStepUpRequired(totpDeps);
    res.status(status).type("html").send(renderOAuthConsent({
      lang,
      error,
      stepUp,
      csrf: req.csrfToken || "",
      action: CONSENT_PATH_PREFIX + pending.id,
      clientName: pending.client.client_name,
      clientId: pending.client.client_id,
      redirectUri: pending.params.redirectUri,
      remoteRedirect: !isLoopbackRedirect(pending.params.redirectUri),
      scopes: pending.params.scopes || [],
      requesterIp: pending.requester.ip,
      requesterUser: pending.requester.tailnetUser,
      requestedAt: new Date(pending.createdAt).toISOString(),
    }));
  }

  router.get(path, csrfMiddleware, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    noFraming(res);
    const db = dbFactory();
    try {
      const f = await front(req, res, db);
      if (!f) return;
      const { provider, pending, lang } = f;
      // Already approved: no page, no click. The operator's local session
      // (checked in front()) is still what lets the code be minted.
      if (await isClientApproved(db, pending.client.client_id)) {
        const taken = provider.pending.take(pending.id);
        if (!taken) return expired(res, lang);
        await auditLog(db, "oauth_reauthorized", { actor: taken.client.client_id, ip: taken.requester.ip });
        return res.redirect(302, provider.issueCode(taken.client, taken.params));
      }
      return await page(req, res, { pending, lang });
    } catch (err) {
      console.error("[oauth-consent] GET failed:", err.message);
      if (!res.headersSent) res.status(500).type("text/plain").send("Consent error.");
    } finally {
      db.close();
    }
  });

  router.post(path, express.urlencoded({ extended: false }), csrfMiddleware, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    noFraming(res);
    const db = dbFactory();
    try {
      const f = await front(req, res, db);
      if (!f) return;
      const { provider, pending, lang } = f;
      const action = req.body?.action;

      if (action === "deny") {
        const taken = provider.pending.take(pending.id);
        if (!taken) return expired(res, lang);
        await auditLog(db, "oauth_consent_denied", { actor: taken.client.client_id, ip: req.ip });
        return res.redirect(303, provider.denyRedirect(taken.params));
      }
      if (action !== "approve") {
        return res.status(400).type("text/plain").send("Unknown action.");
      }

      if (!(await consentStepUpOk(req.body?.totp_code, totpDeps))) {
        pending.stepUpFailures += 1;
        if (pending.stepUpFailures >= MAX_STEP_UP_FAILURES) {
          provider.pending.take(pending.id);
          await auditLog(db, "oauth_consent_locked", { actor: pending.client.client_id, ip: req.ip });
          return res.redirect(303, provider.denyRedirect(pending.params, "Too many invalid 2FA codes"));
        }
        return await page(req, res, { pending, lang, error: t("oauthConsent.errorTotp", lang), status: 400 });
      }

      // take() AFTER the awaits above: a concurrent decision may have won.
      const taken = provider.pending.take(pending.id);
      if (!taken) return expired(res, lang);
      await approveClient(db, taken.client, { ip: req.ip });
      return res.redirect(303, provider.issueCode(taken.client, taken.params));
    } catch (err) {
      console.error("[oauth-consent] POST failed:", err.message);
      if (!res.headersSent) res.status(500).type("text/plain").send("Consent error.");
    } finally {
      db.close();
    }
  });

  return router;
}
```

- [ ] **Step 4: Run the integration test**

Run: `npm test -- tests/oauth-consent-gate.test.js`
Expected: PASS (18 tests).

- [ ] **Step 5: Mount the router and wire the login return** in `servers/gateway/dashboard/index.js`.

(a) After `import { csrfMiddleware } from "./shared/csrf.js";` add:

```js
import oauthConsentRouter from "../routes/oauth-consent.js";
import { oauthReturnTarget, oauthReturnClearCookie } from "../oauth-consent.js";
```

(b) In `POST /dashboard/login`, replace

```js
    setSessionCookie(res, result.token);

    // W3-3: redirect to onboarding
```

with

```js
    setSessionCookie(res, result.token);

    // OAuth consent gate: a login that interrupted an app's approval request
    // goes back to that request, not to the dashboard home.
    const oauthReturn = oauthReturnTarget(req);
    if (oauthReturn) {
      const existing = res.getHeader("Set-Cookie") || [];
      res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), oauthReturnClearCookie()]);
      return res.redirectAfterPost(oauthReturn);
    }

    // W3-3: redirect to onboarding
```

(c) In BOTH `POST /dashboard/login/2fa` and `POST /dashboard/login/2fa/recovery` (the line is identical in both; use replace-all on exactly this line), replace

```js
    const redirectTo = (ssoSrc && ssoDest && isSafeDestPath(ssoDest)) ? ssoDest : "/dashboard";
```

with

```js
    // OAuth consent gate: return to an interrupted approval request. Not for
    // SSO logins (an SSO session cannot approve; it keeps its SSO destination).
    const oauthReturn = ssoSrc ? null : oauthReturnTarget(req);
    const redirectTo = (ssoSrc && ssoDest && isSafeDestPath(ssoDest)) ? ssoDest : (oauthReturn || "/dashboard");
```

and (again both handlers, identical line) after

```js
    const cookieHeaders = [`crow_pending_2fa=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];
```

add

```js
    if (oauthReturn) cookieHeaders.push(oauthReturnClearCookie());
```

Check: `grep -n "oauthReturn" servers/gateway/dashboard/index.js` shows 1 import line plus 4 lines in the password handler and 3 lines in each 2FA handler.

(d) Immediately before the line `  // --- Protected routes ---` add:

```js
  // OAuth consent gate pages. BEFORE dashboardAuth: the route must set the
  // crow_oauth_return cookie before sending the operator to log in, so it
  // applies isAllowedNetwork + the local-session check itself. Never
  // Funnel-reachable (/dashboard/* is not in PUBLIC_FUNNEL_PREFIXES).
  router.use(oauthConsentRouter());

```

- [ ] **Step 6: Run the gate, network and login tests**

Run: `npm test -- tests/oauth-consent-gate.test.js tests/auth-network.test.js tests/dashboard-2fa-login.test.js`
Expected: PASS. `auth-network` unchanged and green.

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/routes/oauth-consent.js tests/oauth-consent-gate.test.js
git commit servers/gateway/routes/oauth-consent.js servers/gateway/dashboard/index.js tests/oauth-consent-gate.test.js -m "feat(oauth): operator consent page with local session + 2FA step-up; login returns to it"
git show --stat HEAD
```

---

### Task 6: "Approved apps" with revoke in the Connect panel

**Files:**
- Modify: `servers/gateway/dashboard/panels/connect.js`
- Test: `tests/connect-oauth-apps.test.js`

**Interfaces:**
- Consumes: `listApprovedClients`, `revokeClient` (Task 2); `provider.purgeClient` (Task 3) via `req.app?.locals?.oauthProvider`; `fill` (`i18n.js`).
- Produces: POST `/dashboard/connect` action `revoke_oauth_client` with field `client_id`.

- [ ] **Step 1: Write the failing test** — create `tests/connect-oauth-apps.test.js`:

```js
// Connect panel "Approved apps" section: lists consent-gate approvals and
// revokes them (spec docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md §4.7).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import connectPanel from "../servers/gateway/dashboard/panels/connect.js";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";
import { OAUTH_APPROVALS_DDL } from "../servers/gateway/oauth-approvals-ddl.js";
import { createDbClient } from "../servers/db.js";

let dir, raw, real;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "connect-oauth-"));
  const dbPath = join(dir, "crow.db");
  raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT NOT NULL, client_id TEXT NOT NULL,
      scopes TEXT DEFAULT '', resource TEXT, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT,
      ip_address TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now')));
    ${OAUTH_APPROVALS_DDL};
  `);
  real = createDbClient(dbPath);
});
after(() => {
  real.close();
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

// Settings reads (local-token meta) answer "no token" without touching the
// instance-id machinery; everything else hits the real scratch DB.
const db = () => ({
  execute: (q) => (/dashboard_settings/.test(q.sql) ? Promise.resolve({ rows: [] }) : real.execute(q)),
  batch: (s) => real.batch(s),
});

function req({ method = "GET", body = null, purged = [] } = {}) {
  return {
    method, body, csrfToken: "csrf-x", query: {}, headers: {}, protocol: "https", ip: "100.64.0.7",
    get: (h) => (h.toLowerCase() === "host" ? "crow.example.ts.net:8444" : ""),
    app: { locals: { oauthProvider: { purgeClient: (id) => { purged.push(id); return 0; } } } },
  };
}
const render = (r) => connectPanel.handler(r, { send() {}, setHeader() {} }, { db: db(), layout: ({ content }) => content });

function seed() {
  raw.exec("DELETE FROM oauth_client_approvals; DELETE FROM oauth_tokens;");
  raw.prepare("INSERT INTO oauth_client_approvals (client_id, client_name, redirect_uris, approved_via, approved_ip) VALUES (?, ?, ?, ?, ?)")
    .run("cid-1", "Claude <Code>", '["http://localhost:5/cb"]', "operator", "100.64.0.2");
  raw.prepare("INSERT INTO oauth_client_approvals (client_id, client_name, redirect_uris, approved_via) VALUES (?, ?, ?, ?)")
    .run("cid-2", null, "[]", "grandfathered");
  raw.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at) VALUES ('r1', 'refresh', 'cid-1', ?)")
    .run(new Date(Date.now() + 86_400_000).toISOString());
}

test("lists approved apps with escaped names, how they were approved, and a Revoke form each", async () => {
  seed();
  const html = await render(req());
  assert.ok(html.includes(i18n.t("connect.oauth.heading", "en")));
  assert.ok(html.includes("Claude &lt;Code&gt;") && !html.includes("Claude <Code>"), "name escaped");
  assert.ok(html.includes("http://localhost:5/cb"));
  assert.ok(html.includes(i18n.t("oauthConsent.unnamed", "en")), "unnamed app label");
  assert.ok(html.includes(i18n.t("connect.oauth.grandfathered", "en")));
  assert.ok(html.includes("Active sign-ins: 1"));
  assert.equal((html.match(/value="revoke_oauth_client"/g) || []).length, 2);
  assert.ok(html.includes('name="client_id" value="cid-1"'));
});

test("with no approvals it says so", async () => {
  raw.exec("DELETE FROM oauth_client_approvals;");
  const html = await render(req());
  assert.ok(html.includes(i18n.t("connect.oauth.empty", "en")));
  assert.ok(!html.includes('value="revoke_oauth_client"'));
});

test("POST revoke_oauth_client deletes approval + tokens, purges the provider, and confirms", async () => {
  seed();
  const purged = [];
  const html = await render(req({ method: "POST", body: { action: "revoke_oauth_client", client_id: "cid-1" }, purged }));
  assert.deepEqual(purged, ["cid-1"]);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM oauth_client_approvals WHERE client_id='cid-1'").get().n, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE client_id='cid-1'").get().n, 0);
  assert.ok(html.includes(i18n.t("connect.oauth.revoked", "en")));
  assert.ok(!html.includes('name="client_id" value="cid-1"'), "gone from the list");
});

test("a stub DB with no approvals table still renders the panel", async () => {
  const html = await connectPanel.handler(req(), { send() {}, setHeader() {} },
    { db: { execute: async () => ({ rows: [] }) }, layout: ({ content }) => content });
  assert.ok(html.includes(i18n.t("connect.oauth.empty", "en")));
});

test("new consent-gate copy has en + es and no em dash", () => {
  const keys = Object.keys(i18n.translations).filter((k) => k.startsWith("oauthConsent.") || k.startsWith("connect.oauth."));
  assert.ok(keys.length >= 25, `found ${keys.length}`);
  for (const k of [...keys, "connect.oauthNote"]) {
    for (const lang of ["en", "es"]) {
      const v = i18n.translations[k][lang];
      assert.ok(v && v.trim(), `${k}.${lang}`);
      assert.ok(!v.includes("—"), `${k}.${lang} has an em dash`);
    }
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/connect-oauth-apps.test.js`
Expected: FAIL, the heading `Approved apps` is not in the panel HTML.

- [ ] **Step 3: Implement.** In `servers/gateway/dashboard/panels/connect.js`:

(a) Replace the two import lines

```js
import { t, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { generateLocalToken, revokeLocalToken, getLocalTokenMeta } from "../../local-token.js";
```

with

```js
import { t, fill, SUPPORTED_LANGS } from "../shared/i18n.js";
import { parseCookies } from "../auth.js";
import { generateLocalToken, revokeLocalToken, getLocalTokenMeta } from "../../local-token.js";
import { listApprovedClients, revokeClient } from "../../oauth-consent.js";
```

(b) Immediately before `function clientTabs(baseUrl, lang) {` add:

```js
// OAuth consent gate (spec 2026-10-02-oauth-consent-gate-design.md §4.7): the
// apps the operator approved, each with a Revoke form. App-supplied values
// (name, redirect URIs) are attacker-controllable via DCR: always escaped.
function oauthAppsSection({ lang, apps, csrf, revoked }) {
  const flash = revoked ? callout(t("connect.oauth.revoked", lang), "success") : "";
  const intro = `<p style="${P_STYLE}">${t("connect.oauth.intro", lang)}</p>`;
  if (!apps.length) return flash + intro + `<p style="${P_STYLE}">${t("connect.oauth.empty", lang)}</p>`;
  const rows = apps.map((a) => {
    const how = a.approvedVia === "grandfathered"
      ? t("connect.oauth.grandfathered", lang)
      : fill(t("connect.oauth.approvedAt", lang), { when: escapeHtml(a.approvedAt || "") });
    return `<div style="border:1px solid var(--crow-border);border-radius:8px;padding:var(--crow-space-3);margin-bottom:var(--crow-space-2)">`
      + `<div><strong>${escapeHtml(a.clientName || t("oauthConsent.unnamed", lang))}</strong> `
      + `<code style="font-size:var(--crow-text-xs)">${escapeHtml(a.clientId)}</code></div>`
      + `<div style="${P_STYLE}">${escapeHtml(a.redirectUris.join(", "))}</div>`
      + `<div style="${P_STYLE}">${how} · ${fill(t("connect.oauth.liveSessions", lang), { n: a.liveSessions })}</div>`
      + `<form method="POST" action="/dashboard/connect" data-turbo="false" style="margin:0">`
      + `<input type="hidden" name="_csrf" value="${escapeHtml(csrf || "")}">`
      + `<input type="hidden" name="action" value="revoke_oauth_client">`
      + `<input type="hidden" name="client_id" value="${escapeHtml(a.clientId)}">`
      + button(t("connect.oauth.revoke", lang), { variant: "secondary", type: "submit" })
      + `</form></div>`;
  }).join("");
  return flash + intro + rows;
}
```

(c) In `handler`, replace

```js
    let actionError = false;
```

with

```js
    let actionError = false;
    let revoked = false;
```

(d) Replace

```js
        } else if (action === "revoke_token") {
          await revokeLocalToken(db);
        } else {
```

with

```js
        } else if (action === "revoke_token") {
          await revokeLocalToken(db);
        } else if (action === "revoke_oauth_client") {
          const clientId = String(req.body?.client_id || "");
          const r = await revokeClient(db, clientId, { ip: req.ip || null });
          // Drop the client's in-flight codes and pending consent requests too.
          req.app?.locals?.oauthProvider?.purgeClient(clientId);
          revoked = r.revoked;
          meta = await getLocalTokenMeta(db);
        } else {
```

(e) Replace

```js
    const errorCallout = actionError ? callout(t("connect.token.actionError", lang), "error") : "";
```

with

```js
    let apps = [];
    if (db) {
      try { apps = await listApprovedClients(db); } catch { /* no approvals table yet: show none */ }
    }

    const errorCallout = actionError ? callout(t("connect.token.actionError", lang), "error") : "";
```

(f) In the `content` expression, after the line that renders `section(t("connect.token.heading", lang), ...)` add:

```js
      section(t("connect.oauth.heading", lang), oauthAppsSection({ lang, apps, csrf: req.csrfToken, revoked })) +
```

- [ ] **Step 4: Run the panel tests**

Run: `npm test -- tests/connect-oauth-apps.test.js tests/connect.test.js tests/connect-token.test.js`
Expected: PASS (the existing stub-DB tests still render because `listApprovedClients` on `{ rows: [] }` yields `[]`).

- [ ] **Step 5: Commit**

```bash
git add tests/connect-oauth-apps.test.js
git commit servers/gateway/dashboard/panels/connect.js tests/connect-oauth-apps.test.js -m "feat(oauth): list and revoke approved OAuth apps in the Connect panel"
git show --stat HEAD
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/architecture/gateway.md` (the `## OAuth 2.1` section)
- Modify: `docs/platforms/claude-code.md:75`

- [ ] **Step 1: gateway.md.** After the line `OAuth is backed by SQLite tables (\`oauth_clients\`, \`oauth_tokens\`) for persistence across restarts.` add:

```markdown

### Operator consent

`/authorize` never issues a code by itself. It parks the request and sends the browser to
`/dashboard/oauth/consent/<id>`. The operator must be signed in to Crow's Nest with a local
password session (peer SSO sessions do not count) and, when 2FA is on, enter a TOTP code to
approve. The page shows the app's self-reported name, its redirect URI, the requested scopes and
the requesting IP. Deny returns `error=access_denied` to the app.

An approval is remembered per client in `oauth_client_approvals` (instance-local, never synced).
Token refresh never asks again. A later full authorization by an approved client completes without a
click, but still needs the operator's local session in the browser. Approved apps are listed in the
Connect panel (`/dashboard/connect`) with a Revoke button, which deletes the app's tokens and its
approval at once.

Headless clients that cannot open a browser use the local MCP token from the Connect panel instead.
Peer instances, instance sync and cross-instance SSO do not use `/authorize` and are unaffected.
Design: `docs/superpowers/specs/2026-10-02-oauth-consent-gate-design.md`.
```

and add `oauth_client_approvals` to that sentence's table list:

```markdown
OAuth is backed by SQLite tables (`oauth_clients`, `oauth_tokens`, `oauth_client_approvals`) for persistence across restarts.
```

- [ ] **Step 2: claude-code.md.** Replace

```markdown
3. On first use, Claude Code will open the OAuth flow in your browser to authorize.
```

with

```markdown
3. On first use, Claude Code opens the OAuth flow in your browser. Sign in to Crow's Nest if asked, check the app details, and click **Approve** (enter your 2FA code if 2FA is on). Approved apps are listed, and can be revoked, under **Connect a client** in the dashboard.
```

- [ ] **Step 3: Commit**

```bash
git commit docs/architecture/gateway.md docs/platforms/claude-code.md -m "docs(oauth): document the operator consent step"
git show --stat HEAD
```

---

### Task 8: Full verification and scratch-gateway acceptance

**Files:** none committed. The acceptance script lives in the scratchpad and is copied into the worktree root only while it runs (it imports `otpauth` and `better-sqlite3`, which resolve from the repo's `node_modules`), then deleted.

- [ ] **Step 1: Static checks**

Run: `node scripts/build-registry.mjs --check && node scripts/check-port-allocation.js`
Expected: both exit 0 (no bundle or port changes).

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: everything passes except known environment-only failures. Seen while validating this plan: `tests/perch-hub-render.test.js` "F1b live: crossing the breakpoint…" (live CDP Chrome; fails identically on unmodified `ed2382b0`). Any other failure is a regression.

- [ ] **Step 3: Boot an isolated scratch gateway** (never `~/.crow`, never a prod port). From the worktree:

```bash
S=$(mktemp -d /tmp/consent-acc.XXXX); mkdir -p $S/home $S/crow/data
( export HOME=$S/home CROW_HOME=$S/crow CROW_DATA_DIR=$S/crow/data CROW_DB_PATH=$S/crow/data/crow.db \
    PORT=3990 CROW_GATEWAY_PORT=3990 CROW_GATEWAY_URL=http://localhost:3990 \
    CROW_DISABLE_MODEL_ORCHESTRATION=1 CROW_AUTO_UPDATE=0 NODE_ENV=development
  exec timeout 900 node servers/gateway/index.js > $S/gw.log 2>&1 ) &
echo "scratch dir: $S"
```

Run this as a background task and stop it by its task id (do NOT `pkill -f servers/gateway/index.js`: the prod gateways have the same command line). Confirm `ss -ltn | grep 3990` is free first. Wait for `curl -s http://127.0.0.1:3990/health` to return `{"status":"ok",...}`, then check the log:

Run: `grep -n "0008-oauth-client-approvals\|OAuth 2.1 enabled" $S/gw.log`
Expected: `applying 0008-oauth-client-approvals`, `oauth_client_approvals: ready, 0 client(s) grandfathered`, `OAuth 2.1 enabled`.

- [ ] **Step 4: Run the acceptance script.** Save as `consent-acceptance.mjs` in the worktree root (do not `git add` it):

```js
// Scratch-gateway acceptance for the OAuth consent gate. NEVER point at a live gateway.
import { createHash, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import Database from "better-sqlite3";
const BASE = process.env.BASE || "http://127.0.0.1:3990";
const DB = process.env.SCRATCH_DB;
const TS = { "tailscale-user-login": "kevin@example.com", "x-forwarded-for": "100.101.102.103" };
const PW = "correct horse battery staple 42";
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function take(res) {
  for (const c of res.headers.getSetCookie()) {
    const [kv, ...attrs] = c.split(";");
    const [k, ...v] = kv.split("=");
    if (/max-age=0/i.test(attrs.join(";"))) jar.delete(k.trim()); else jar.set(k.trim(), v.join("="));
  }
  return res;
}
const go = async (path, opts = {}) => take(await fetch(BASE + path, { redirect: "manual", ...opts, headers: { ...TS, cookie: cookieHeader(), ...(opts.headers || {}) } }));
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); };
const pkce = () => { const v = randomBytes(32).toString("base64url"); return { v, c: createHash("sha256").update(v).digest("base64url") }; };

async function newClient(name) {
  const r = await fetch(BASE + "/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  return r.json();
}
async function startAuth(client, c) {
  const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: "http://localhost:9999/cb", response_type: "code", code_challenge: c, code_challenge_method: "S256", state: "acc", scope: "mcp:tools" });
  return go("/authorize?" + q);
}
async function tokenFor(client, code, v) {
  const r = await fetch(BASE + "/token", form({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: v, redirect_uri: "http://localhost:9999/cb" }));
  return r.json();
}
async function mcp(bearer) {
  const r = await fetch(BASE + "/router/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acc", version: "0" } } }) });
  return r.status;
}

// A. password login returns to consent; approve; token; MCP; revoke.
const A = await newClient("Acceptance A");
const pa = pkce();
let r = await startAuth(A, pa.c);
const consentA = r.headers.get("location");
ok(r.status === 302 && /^\/dashboard\/oauth\/consent\/[a-f0-9]{32}$/.test(consentA), "authorize parks the request: " + consentA);
r = await go(consentA);
ok(r.status === 302 && r.headers.get("location") === "/dashboard/login" && jar.has("crow_oauth_return"), "no session: to login, return cookie set");
r = await go("/dashboard/login", form({ password: PW, confirm: PW }));
ok(r.status === 303 && r.headers.get("location") === consentA, "password login returns to the consent page (" + r.status + " " + r.headers.get("location") + ")");
ok(!jar.has("crow_oauth_return"), "return cookie cleared");
r = await go(consentA);
const page = await r.text();
ok(r.status === 200 && page.includes("Acceptance A") && page.includes("100.101.102.103"), "consent page shows app + IP");
r = await go(consentA, form({ _csrf: jar.get("crow_csrf"), action: "approve" }));
const codeA = new URL(r.headers.get("location")).searchParams.get("code");
ok(r.status === 303 && codeA, "approve redirects with a code");
const tA = await tokenFor(A, codeA, pa.v);
ok(tA.access_token, "code exchanges for tokens");
ok((await mcp(tA.access_token)) === 200, "MCP initialize with the token works");
r = await go("/dashboard/connect");
const panel = await r.text();
ok(panel.includes("Acceptance A") && panel.includes("revoke_oauth_client"), "Connect panel lists the app");
r = await go("/dashboard/connect", form({ _csrf: jar.get("crow_csrf"), action: "revoke_oauth_client", client_id: A.client_id }));
ok(r.status === 200, "revoke posted");
ok((await mcp(tA.access_token)) === 401, "MCP with the revoked token is refused");

// B. 2FA on: login -> 2FA -> back to consent -> approve needs a code.
const secret = new OTPAuth.Secret({ size: 20 }).base32;
const d = new Database(DB);
d.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('totp_enabled','true'), ('totp_secret', ?)").run(secret);
d.close();
const gen = () => new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
jar.clear();
const B = await newClient("Acceptance B");
const pb = pkce();
r = await startAuth(B, pb.c);
const consentB = r.headers.get("location");
r = await go(consentB);
ok(r.headers.get("location") === "/dashboard/login", "B: to login");
r = await go("/dashboard/login", form({ password: PW }));
ok(r.status === 200 && jar.has("crow_pending_2fa"), "B: password ok, 2FA page");
r = await go("/dashboard/login/2fa", form({ totp_code: gen() }));
ok(r.status === 303 && r.headers.get("location") === consentB, "B: 2FA login returns to the consent page (" + r.headers.get("location") + ")");
r = await go(consentB);
ok((await r.text()).includes('name="totp_code"'), "B: consent asks for a 2FA code");
r = await go(consentB, form({ _csrf: jar.get("crow_csrf"), action: "approve", totp_code: "000000" }));
ok(r.status === 400, "B: bad code refused");
r = await go(consentB, form({ _csrf: jar.get("crow_csrf"), action: "approve", totp_code: gen() }));
const codeB = new URL(r.headers.get("location")).searchParams.get("code");
ok(r.status === 303 && codeB, "B: good code approves");
ok((await tokenFor(B, codeB, pb.v)).access_token, "B: token issued");
console.log("ACCEPTANCE PASSED");
```

Run: `BASE=http://127.0.0.1:3990 SCRATCH_DB=$S/crow/data/crow.db node consent-acceptance.mjs`
Expected: 18 `ok -` lines and `ACCEPTANCE PASSED`, covering: password login returns to consent, approve, token, MCP `initialize` 200, Connect panel lists and revokes, MCP 401 after revoke, 2FA login returns to consent, bad TOTP 400, good TOTP approves.

- [ ] **Step 5: Clean up.** Stop the background task, then `rm consent-acceptance.mjs`, `rm -rf $S`, and confirm `systemctl is-active crow-gateway crow-r4-gateway` is still `active` (untouched).

- [ ] **Step 6: Rebase and push**

```bash
git pull --rebase origin main
git push -u origin <branch>
```

Before merge: confirm every check-run on the head sha is `completed`/`success` (`https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs`). Merging restarts the crow and r4 gateways through auto-update: register the deploy in `~/CROW-SCHEDULE.md` first (decision D5).

---

### Task 9 (gated on Kevin's decision D4): `CROW_OAUTH_ISSUER_URL`

Do this task only if Kevin approves D4. It does not change any exposed path. It changes which URL the `/.well-known/*` metadata names as issuer, which is what makes OAuth on crow work at all (today crow's issuer is the Funnel host on :443, where `/authorize` does not exist).

**Files:**
- Modify: `servers/gateway/issuer-url.js`
- Modify: `servers/gateway/index.js` (issuer import + `publicUrl`)
- Test: `tests/issuer-url.test.js`

**Interfaces:**
- Produces: `issuerSourceUrl(env = process.env) → string|undefined`.

- [ ] **Step 1: Write the failing test.** In `tests/issuer-url.test.js` change the import to

```js
import { resolveIssuerUrl, issuerSourceUrl } from "../servers/gateway/issuer-url.js";
```

and append:

```js

// OAuth consent gate D4: CROW_OAUTH_ISSUER_URL overrides the issuer source.
test("issuerSourceUrl: CROW_OAUTH_ISSUER_URL wins, then CROW_GATEWAY_URL, then RENDER_EXTERNAL_URL", () => {
  const all = {
    CROW_OAUTH_ISSUER_URL: "https://crow.example.ts.net:8444",
    CROW_GATEWAY_URL: "https://crow.example.ts.net",
    RENDER_EXTERNAL_URL: "https://x.onrender.com",
  };
  assert.equal(issuerSourceUrl(all), "https://crow.example.ts.net:8444");
  assert.equal(issuerSourceUrl({ ...all, CROW_OAUTH_ISSUER_URL: "" }), "https://crow.example.ts.net");
  assert.equal(issuerSourceUrl({ RENDER_EXTERNAL_URL: "https://x.onrender.com" }), "https://x.onrender.com");
  assert.equal(issuerSourceUrl({}), undefined);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/issuer-url.test.js`
Expected: FAIL, `does not provide an export named 'issuerSourceUrl'`.

- [ ] **Step 3: Implement.** In `servers/gateway/issuer-url.js`, immediately before `export function resolveIssuerUrl({ publicUrl, port }) {` add:

```js
/**
 * Which configured URL the OAuth issuer comes from. CROW_OAUTH_ISSUER_URL wins
 * so an operator can advertise the tailnet-only Serve port (e.g. :8444) when
 * CROW_GATEWAY_URL names a Funnel host where /authorize does not exist (MPA
 * defect 3; spec 2026-10-02-oauth-consent-gate-design.md §7 / D4). Set it per
 * gateway unit, never in a shared .env that a co-hosted gateway also loads.
 */
export function issuerSourceUrl(env = process.env) {
  return env.CROW_OAUTH_ISSUER_URL || env.CROW_GATEWAY_URL || env.RENDER_EXTERNAL_URL || undefined;
}

```

In `servers/gateway/index.js` replace `import { resolveIssuerUrl } from "./issuer-url.js";` with

```js
import { resolveIssuerUrl, issuerSourceUrl } from "./issuer-url.js";
```

and replace

```js
  const publicUrl = process.env.CROW_GATEWAY_URL || process.env.RENDER_EXTERNAL_URL;
```

with

```js
  const publicUrl = issuerSourceUrl(process.env);
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/issuer-url.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git commit servers/gateway/issuer-url.js servers/gateway/index.js tests/issuer-url.test.js -m "feat(oauth): CROW_OAUTH_ISSUER_URL overrides the advertised OAuth issuer"
git show --stat HEAD
```

- [ ] **Step 6: Ops (Kevin, after deploy, not part of the PR).** Put `Environment=CROW_OAUTH_ISSUER_URL=https://crow.dachshund-chromatic.ts.net:8444` in a drop-in for `crow-gateway.service` ONLY. Never put it in `~/crow/.env`: `crow-r4-gateway` loads that file through the gateway's `.env` reader and would then advertise crow's issuer. Restart is a prod action and needs a CROW-SCHEDULE entry.

---

## Self-Review

- Spec coverage: §4.1-4.2 → Tasks 2-3; §4.3 → Task 5; §4.4 → Task 5 (wiring) + Task 8 (acceptance); §4.5 → Task 4; §4.6 → Tasks 1-3; §4.7 → Task 6; §5-§7 invariants → Task 5 (`funneled request … 403`, `auth-network` run) and Global Constraints; §8 grandfathering → Task 1; D4 → Task 9; §12 acceptance → Tasks 5 and 8.
- Every code step contains the full code; all files were exercised on a throwaway copy of `ed2382b0` (unit + integration tests, full suite, and the Task 8 acceptance script against a booted scratch gateway: `ACCEPTANCE PASSED`).
- Names are consistent across tasks: `PendingAuthorizations`, `issueCode`, `denyRedirect`, `purgeClient`, `isClientApproved`, `approveClient`, `listApprovedClients`, `revokeClient`, `isLocalDashboardSession`, `consentStepUpOk`, `consentStepUpRequired`, `oauthReturnTarget`, `oauthReturnSetCookie`, `oauthReturnClearCookie`, `renderOAuthConsent`, `renderOAuthNotice`, `app.locals.oauthProvider`.
