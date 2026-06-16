# Roster Auto-Advertise (Crow Messages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bot whose Crow Messages gateway has `allow_paired_instances=true` automatically appear ("available") in the operator's *other* (paired) Crows' Messages lists, and let the first message to it materialize a real conversation — with no manual per-device invite.

**Architecture:** Pull-at-render. The **owner** instance exposes a signed federation endpoint listing its advertisable bots, each carrying a reusable "paired-roster" bot invite code. A **viewer** instance fan-out-fetches every paired peer's endpoint (cached ~60s, per-peer timeout, offline peers silently omitted), merges the results into Messages as read-only "available" entries, and on first send runs the already-shipped `crow_accept_bot_invite` handshake (which creates the local contact + authorizes the sender on the owner) then sends the message. Authorization rides the proven invite/accept path, not the unverified `allow_paired_instances` runtime pubkey match.

**Tech Stack:** Node (ESM), Express, libsql (`db.execute`) in the gateway, `node --test` runner, existing federation primitives (`crossHostVerifyMiddleware`, `forwardSignedRequest`), existing sharing tools (`crow_accept_bot_invite`, `crow_send_message`).

**Spec:** `docs/superpowers/specs/2026-06-16-roster-auto-advertise-design.md`

---

## File Structure

- **Modify** `scripts/init-db.js` — add `contacts.origin` + `bot_message_invites.kind` columns (guarded ALTER). [Task 1]
- **Modify** `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js` — owner-side enumeration + paired-roster invite + advertisement payload builder. [Task 2]
- **Modify** `servers/gateway/routes/federation.js` — `GET /dashboard/advertised-bots` route. [Task 3]
- **Create** `servers/gateway/dashboard/advertised-bots-cache.js` — viewer-side per-peer fetch + validate + TTL cache. [Task 4]
- **Modify** `servers/gateway/dashboard/panels/messages/data-queries.js` — `getAdvertisedBotItems(db)` aggregation + dedup. [Task 5]
- **Modify** `servers/gateway/dashboard/panels/messages/html.js` + `messages.js` + `shared/i18n.js` — "Bots on your other Crows" section + wiring + strings. [Task 6]
- **Modify** `servers/gateway/dashboard/panels/messages/api-handlers.js` — `message_advertised_bot` materialize action. [Task 7]
- **Modify** `servers/gateway/dashboard/panels/messages/data-queries.js` — `pruneStaleAdvertisedContacts` cleanup. [Task 8]
- **Verify** network-exposure invariant unaffected. [Task 9]

**Test command (every task):** `node --test --test-force-exit tests/<file>.test.js` (force-exit avoids hangs from tests that open Nostr relays). There is no aggregate runner.

**Commit discipline:** positional-path `git commit <paths> -m "..."`; `git add <new-test-file>` before committing a brand-new test file; `git pull --rebase` before any push.

---

### Task 1: Schema — `contacts.origin` + `bot_message_invites.kind`

**Files:**
- Modify: `scripts/init-db.js` (near the `contacts` table and the `bot_message_invites` table)
- Test: `tests/roster-advertise-schema.test.js` (create)

Both are nullable additive columns; existing hosts get them via guarded `ALTER TABLE ... ADD COLUMN`. `contacts.origin` distinguishes auto-materialized advertised bots (`'advertised'`) from manual/invite contacts (`NULL`). `bot_message_invites.kind` tags the reusable paired-roster invite (`'paired-roster'`) so it is reused, not re-minted.

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-schema.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";

// Mirrors the guarded-ALTER helper added to init-db.js. Kept inline so the test
// asserts the COLUMN EXISTS without bootstrapping the whole init-db script.
async function addColumnIfMissing(db, table, column, decl) {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`);
  if (!rows.some((r) => r.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
  }
}

test("contacts.origin and bot_message_invites.kind are added idempotently", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT)`);
  await db.execute(`CREATE TABLE bot_message_invites (id INTEGER PRIMARY KEY, bot_id TEXT, token TEXT)`);

  // Running twice must not throw (idempotent).
  for (let i = 0; i < 2; i++) {
    await addColumnIfMissing(db, "contacts", "origin", "origin TEXT");
    await addColumnIfMissing(db, "bot_message_invites", "kind", "kind TEXT");
  }

  const c = await db.execute(`PRAGMA table_info(contacts)`);
  assert.ok(c.rows.some((r) => r.name === "origin"), "contacts.origin exists");
  const i = await db.execute(`PRAGMA table_info(bot_message_invites)`);
  assert.ok(i.rows.some((r) => r.name === "kind"), "bot_message_invites.kind exists");
});
```

- [ ] **Step 2: Run test to verify it passes (it exercises the helper, not init-db yet)**

Run: `node --test --test-force-exit tests/roster-advertise-schema.test.js`
Expected: PASS (this test guards the migration contract; the real wiring is in Step 3).

- [ ] **Step 3: Add the guarded migration to `init-db.js`**

Find the existing guarded-`ALTER` pattern in `scripts/init-db.js` (search for `ADD COLUMN` — the file already does this for several tables) and follow it exactly. Add, after the `contacts` and `bot_message_invites` tables are created:

```js
// Roster auto-advertise (Theme 12): distinguish auto-materialized advertised
// bots from manual contacts, and tag the reusable paired-roster invite.
await addColumnIfMissing("contacts", "origin", "TEXT");          // NULL=manual/invite, 'advertised'
await addColumnIfMissing("bot_message_invites", "kind", "TEXT"); // NULL=normal, 'paired-roster'
```

Use the file's existing `addColumnIfMissing` helper (or the equivalent inline pattern already present — match what the file uses; do not invent a new helper name).

- [ ] **Step 4: Verify init-db runs clean on a real data dir**

Run: `node scripts/init-db.js`
Expected: completes without error; re-running is a no-op (no duplicate-column error).

- [ ] **Step 5: Commit**

```bash
git add tests/roster-advertise-schema.test.js
git commit tests/roster-advertise-schema.test.js scripts/init-db.js -m "feat(crow-messages): roster-advertise schema (contacts.origin, invites.kind)"
git show --stat HEAD | head -8
```

---

### Task 2: Owner — advertisement payload builder

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js`
- Test: `tests/roster-advertise-owner.test.js` (create)

Add three exported functions: `getOrCreatePairedRosterInvite(db, botId)`, `listAdvertisedBots(db)`, and `buildAdvertisementPayload(db, {instanceId, instanceLabel})`. The payload is built by a pure-ish function (DB + derived identity only) so it is unit-testable without the HTTP/signing layer.

> **Verify before coding:** open `servers/sharing/identity.js` and confirm `deriveBotIdentity(...)` returns the secp256k1 public key under the property name used below (`secp256k1Pubkey`). `crow-messages-admin.js` already imports `deriveBotIdentity`/`generateBotInviteCode` and `botIdentityFor` returns that object — match its actual field name. `xOnly()` is already exported from this file.

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-owner.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  getOrCreatePairedRosterInvite, listAdvertisedBots,
} from "../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js";

async function seed(db) {
  await db.execute(`CREATE TABLE bot_message_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, token TEXT UNIQUE,
    expires_at TEXT, max_uses INTEGER, uses INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), kind TEXT)`);
  await db.execute(`CREATE TABLE pi_bot_defs (
    bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER DEFAULT 1)`);
}

test("getOrCreatePairedRosterInvite mints once, then reuses", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  const t1 = await getOrCreatePairedRosterInvite(db, "botA");
  const t2 = await getOrCreatePairedRosterInvite(db, "botA");
  assert.equal(t1, t2, "same token reused");
  const { rows } = await db.execute("SELECT max_uses, expires_at, kind FROM bot_message_invites WHERE bot_id='botA'");
  assert.equal(rows.length, 1, "exactly one row");
  assert.equal(rows[0].max_uses, null);
  assert.equal(rows[0].expires_at, null);
  assert.equal(rows[0].kind, "paired-roster");
});

test("listAdvertisedBots returns only crow-messages bots with allow_paired_instances", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["yes", "Yes Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] })] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["off", "Off Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: false }] })] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["gmail", "Gmail Bot", JSON.stringify({ gateways: [{ type: "gmail" }] })] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,0)",
    args: ["disabled", "Disabled", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] })] });

  const bots = await listAdvertisedBots(db);
  assert.deepEqual(bots.map((b) => b.botId).sort(), ["yes"]);
  assert.equal(bots[0].displayName, "Yes Bot");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/roster-advertise-owner.test.js`
Expected: FAIL — `getOrCreatePairedRosterInvite`/`listAdvertisedBots` are not exported yet.

- [ ] **Step 3: Implement in `crow-messages-admin.js`**

Append these exports (uses `randomBytes`, `xOnly`, `botIdentityFor`, `buildInviteCode` already in the file):

```js
/**
 * Find the bot's reusable paired-roster invite (unlimited-use, non-expiring,
 * kind='paired-roster', not revoked), or mint one. Returns the token string.
 * One invite suffices: all of the operator's paired instances share one Nostr
 * identity, so a single accept authorizes every sibling.
 */
export async function getOrCreatePairedRosterInvite(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT token FROM bot_message_invites WHERE bot_id=? AND kind='paired-roster' AND revoked=0 ORDER BY id DESC LIMIT 1",
    args: [botId],
  });
  if (rows.length) return rows[0].token;
  const token = randomBytes(24).toString("base64url");
  await db.execute({
    sql: "INSERT INTO bot_message_invites (bot_id, token, expires_at, max_uses, kind) VALUES (?,?,NULL,NULL,'paired-roster')",
    args: [botId, token],
  });
  return token;
}

/** Bots whose def has a crow-messages gateway with allow_paired_instances=true. */
export async function listAdvertisedBots(db) {
  const { rows } = await db.execute({
    sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE enabled=1",
    args: [],
  });
  const out = [];
  for (const r of rows) {
    let def;
    try { def = JSON.parse(r.definition || "{}"); } catch { continue; }
    const gw = Array.isArray(def.gateways)
      ? def.gateways.find((g) => g && g.type === "crow-messages" && g.allow_paired_instances === true)
      : null;
    if (!gw) continue;
    out.push({ botId: r.bot_id, displayName: r.display_name || r.bot_id });
  }
  return out;
}

/**
 * Build the advertisement payload served to paired peers. Each entry carries a
 * reusable paired-roster invite code (which embeds the bot's pubkey + relays +
 * name) plus the x-only messaging pubkey for receiver-side dedup. A bot whose
 * identity can't derive (no instance seed) is skipped, not fatal.
 */
export async function buildAdvertisementPayload(db, { instanceId, instanceLabel }) {
  const bots = [];
  for (const b of await listAdvertisedBots(db)) {
    try {
      const ident = botIdentityFor(b.botId); // throws if no identity.json beside crow.db
      const token = await getOrCreatePairedRosterInvite(db, b.botId);
      const inviteCode = await buildInviteCode(db, b.botId, token);
      bots.push({
        bot_id: b.botId,
        display_name: b.displayName,
        instance_id: instanceId,
        instance_label: instanceLabel,
        messaging_pubkey: xOnly(ident.secp256k1Pubkey),
        invite_code: inviteCode,
      });
    } catch { /* skip a bot whose identity can't derive */ }
  }
  return { bots };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-owner.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add tests/roster-advertise-owner.test.js
git commit tests/roster-advertise-owner.test.js servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js -m "feat(crow-messages): owner advertisement payload builder"
git show --stat HEAD | head -8
```

---

### Task 3: Owner — `GET /dashboard/advertised-bots` federation route

**Files:**
- Modify: `servers/gateway/routes/federation.js`
- Test: `tests/roster-advertise-route.test.js` (create) — mirror the signing setup in `tests/federation-overview.test.js`

The route reuses the existing `federationVerify` middleware (so it stays HMAC-gated and Funnel-blocked under the `/dashboard` mount) and returns `buildAdvertisementPayload(...)`.

- [ ] **Step 1: Add the route in `federation.js`**

Add the import near the top (with the other imports):

```js
import { buildAdvertisementPayload } from "../dashboard/panels/bot-builder/crow-messages-admin.js";
```

Add the route immediately after the `/capabilities` route (before the `router.use("/", botFederationRouter(...))` line), so it sits inside the same `federationVerify` gate and `/dashboard` mount:

```js
  // Roster auto-advertise (Theme 12): the responding instance's bots that have
  // allow_paired_instances=true. Same HMAC gate as /overview; under /dashboard →
  // Funnel-blocked (never add to PUBLIC_FUNNEL_PREFIXES). Each entry carries a
  // reusable paired-roster invite the caller auto-accepts on first message.
  router.get("/advertised-bots", federationVerify, async (req, res) => {
    const db = createDbClient();
    try {
      const localId = getOrCreateLocalInstanceId();
      const inst = await getInstance(db, localId);
      const payload = await buildAdvertisementPayload(db, {
        instanceId: localId,
        instanceLabel: inst?.name || inst?.hostname || null,
      });
      res.type("application/json").send(JSON.stringify(payload));
    } catch (err) {
      console.warn("[federation] advertised-bots render failed:", err.message);
      res.status(500).json({ error: "advertised_bots_render_failed" });
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Write the failing test (mirror `tests/federation-overview.test.js`)**

Open `tests/federation-overview.test.js` and copy its exact app/signing harness (how it mounts the dashboard router, mints a paired instance + bearer token, and builds the `X-Crow-Signature`/`Timestamp`/`Nonce` headers via `signedHeaders`). Reuse that harness verbatim, changing only the request path and assertions:

```js
// tests/roster-advertise-route.test.js  (harness copied from federation-overview.test.js)
// ...same imports, same makeApp(), same paired-instance + signedHeaders setup...

test("GET /dashboard/advertised-bots returns advertised bots to a signed paired peer", async () => {
  // (setup: insert a pi_bot_defs row with a crow-messages gateway + allow_paired_instances=true,
  //  and ensure an instance identity.json exists beside the test crow.db so botIdentityFor() works —
  //  follow how other crow-messages tests provide identity, or skip identity by asserting the
  //  empty-but-200 contract when no bots qualify.)
  const headers = signedHeaders("GET", "/dashboard/advertised-bots", "");
  const res = await request(app).get("/dashboard/advertised-bots").set(headers);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.bots), "body.bots is an array");
});

test("GET /dashboard/advertised-bots rejects an unsigned caller", async () => {
  const res = await request(app).get("/dashboard/advertised-bots");
  assert.notEqual(res.status, 200);
});
```

If providing a real bot identity in-test is heavy, assert the **contract** instead: with no qualifying bots, the route returns `200` + `{ bots: [] }`. The owner enumeration/identity logic is already unit-tested in Task 2; this test's job is the route + auth gate.

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-route.test.js`
Expected: PASS — signed request → 200 with `bots` array; unsigned → non-200.

- [ ] **Step 4: Commit**

```bash
git add tests/roster-advertise-route.test.js
git commit tests/roster-advertise-route.test.js servers/gateway/routes/federation.js -m "feat(crow-messages): /dashboard/advertised-bots federation route"
git show --stat HEAD | head -8
```

---

### Task 4: Viewer — advertised-bots cache (per-peer fetch + validate + TTL)

**Files:**
- Create: `servers/gateway/dashboard/advertised-bots-cache.js`
- Test: `tests/roster-advertise-cache.test.js` (create)

Mirrors `overview-cache.js` (same `forwardSignedRequest` path, same `_setFetchImpl`/`_resetCache` test seams) but leaner. TTL 60s success / 60s error. Validates each bot entry; a malformed entry is dropped, a peer error → `{status:'unavailable', bots:[]}`.

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-cache.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getPeerAdvertisedBots, _setFetchImpl, _resetCache,
} from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PK = "a".repeat(64);
beforeEach(() => { _resetCache(); _setFetchImpl(null); });

test("ok response is validated and returned", async () => {
  _setFetchImpl(async () => ({ ok: true, body: { bots: [
    { bot_id: "b1", display_name: "Bot One", instance_label: "Laptop", messaging_pubkey: PK, invite_code: "crow:x.y.z" },
    { bot_id: "bad", messaging_pubkey: "nothex", invite_code: "crow:1.2.3" }, // dropped
  ] } }));
  const r = await getPeerAdvertisedBots({}, "inst1");
  assert.equal(r.status, "ok");
  assert.equal(r.bots.length, 1);
  assert.equal(r.bots[0].bot_id, "b1");
  assert.equal(r.bots[0].instance_id, "inst1");
  assert.equal(r.bots[0].messaging_pubkey, PK);
});

test("fetch failure yields an unavailable sentinel (never throws)", async () => {
  _setFetchImpl(async () => ({ ok: false, error: "timeout" }));
  const r = await getPeerAdvertisedBots({}, "inst2");
  assert.equal(r.status, "unavailable");
  assert.deepEqual(r.bots, []);
});

test("second call within TTL does not re-fetch", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return { ok: true, body: { bots: [] } }; });
  await getPeerAdvertisedBots({}, "inst3");
  await getPeerAdvertisedBots({}, "inst3");
  assert.equal(calls, 1, "cached on second call");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/roster-advertise-cache.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `advertised-bots-cache.js`**

```js
/**
 * Advertised-bots cache — per-peer /dashboard/advertised-bots fetch + validate
 * + TTL cache. Sibling of overview-cache.js, same signed-fetch seam. A peer
 * that errors/times out yields an `unavailable` sentinel (never throws), so a
 * single offline Crow can't break the Messages render.
 */
import { forwardSignedRequest } from "../shared/peer-forward.js";
import { getOrCreateLocalInstanceId } from "./instance-registry.js";

const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HEX64 = /^[a-f0-9]{64}$/i;

const _cache = new Map();
const now = () => Date.now();

function validateBot(b, instanceId) {
  if (!b || typeof b !== "object") return null;
  if (typeof b.bot_id !== "string" || !b.bot_id || b.bot_id.length > 128) return null;
  if (typeof b.invite_code !== "string" || !b.invite_code.startsWith("crow:") || b.invite_code.length > 2000) return null;
  const pk = (typeof b.messaging_pubkey === "string" ? b.messaging_pubkey : "").replace(/^0[23]/, "").toLowerCase();
  if (!HEX64.test(pk)) return null;
  return {
    bot_id: b.bot_id,
    display_name: (typeof b.display_name === "string" && b.display_name) ? b.display_name.slice(0, 256) : b.bot_id,
    instance_id: instanceId,
    instance_label: typeof b.instance_label === "string" ? b.instance_label.slice(0, 256) : null,
    messaging_pubkey: pk,
    invite_code: b.invite_code,
  };
}

async function defaultFetchImpl(db, instanceId) {
  const localId = getOrCreateLocalInstanceId();
  return forwardSignedRequest({
    db, sourceInstanceId: localId, targetInstanceId: instanceId,
    method: "GET", path: "/dashboard/advertised-bots",
    auditAction: "federation.overview", actor: "advertised-bots-cache",
    timeoutMs: FETCH_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
  });
}
let _fetchImpl = defaultFetchImpl;

async function doFetch(db, instanceId) {
  let result;
  try { result = await _fetchImpl(db, instanceId); }
  catch (err) { return { instanceId, status: "unavailable", reason: "exception:" + (err?.message || "unknown"), bots: [] }; }
  if (!result || !result.ok) return { instanceId, status: "unavailable", reason: result?.error || "fetch_failed", bots: [] };
  const raw = result.body && Array.isArray(result.body.bots) ? result.body.bots : [];
  const bots = raw.map((b) => validateBot(b, instanceId)).filter(Boolean);
  return { instanceId, status: "ok", bots };
}

/** Fetch (or return cached) advertised bots for one paired peer. Never throws. */
export async function getPeerAdvertisedBots(db, instanceId) {
  if (!instanceId) return { instanceId, status: "unavailable", reason: "no_id", bots: [] };
  const entry = _cache.get(instanceId);
  if (entry && entry.expiresAt > now()) {
    if (entry.inflight) return entry.inflight;
    return entry.data;
  }
  const inflight = (async () => {
    const data = await doFetch(db, instanceId);
    _cache.set(instanceId, { data, expiresAt: now() + TTL_MS });
    return data;
  })();
  _cache.set(instanceId, { inflight, expiresAt: now() + FETCH_TIMEOUT_MS + 500 });
  return inflight;
}

export function _resetCache() { _cache.clear(); }
export function _setFetchImpl(fn) { _fetchImpl = fn || defaultFetchImpl; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-cache.test.js`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/advertised-bots-cache.js tests/roster-advertise-cache.test.js
git commit servers/gateway/dashboard/advertised-bots-cache.js tests/roster-advertise-cache.test.js -m "feat(crow-messages): viewer advertised-bots cache"
git show --stat HEAD | head -8
```

---

### Task 5: Viewer — aggregate + dedup (`getAdvertisedBotItems`)

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js`
- Test: `tests/roster-advertise-aggregate.test.js` (create)

Enumerate non-revoked paired instances (excluding self + the `__local_mcp__` pseudo-instance), fan-out via the cache, flatten + dedup by messaging pubkey, and exclude bots that already have a local contact (already materialized).

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-aggregate.test.js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { getAdvertisedBotItems } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { _setFetchImpl, _resetCache } from "../servers/gateway/dashboard/advertised-bots-cache.js";

const PK_NEW = "b".repeat(64);
const PK_KNOWN = "c".repeat(64);

async function seed(db) {
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT)`);
  await db.execute(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, crow_id TEXT, status TEXT)`);
  // Two paired peers + a revoked one + the local-mcp pseudo-instance (must be skipped).
  await db.execute("INSERT INTO crow_instances (id, crow_id, status) VALUES ('peer1','u',  'active')");
  await db.execute("INSERT INTO crow_instances (id, crow_id, status) VALUES ('peer2','u',  'offline')");
  await db.execute("INSERT INTO crow_instances (id, crow_id, status) VALUES ('gone', 'u',  'revoked')");
  await db.execute("INSERT INTO crow_instances (id, crow_id, status) VALUES ('mcp','__local_mcp__','active')");
  // An already-materialized contact (compressed 02-prefixed key whose trailing-64 == PK_KNOWN).
  await db.execute({ sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES ('crow:known', ?)", args: ["02" + PK_KNOWN] });
}

beforeEach(() => { _resetCache(); _setFetchImpl(null); });

test("aggregates advertised bots, drops revoked/mcp peers, dedups, excludes materialized", async () => {
  const db = createClient({ url: ":memory:" });
  await seed(db);
  _setFetchImpl(async (_db, instanceId) => {
    if (instanceId === "peer1") return { ok: true, body: { bots: [
      { bot_id: "n1", display_name: "New", instance_label: "Phone", messaging_pubkey: PK_NEW, invite_code: "crow:n.e.w" },
      { bot_id: "kn", display_name: "Known", instance_label: "Phone", messaging_pubkey: PK_KNOWN, invite_code: "crow:k.n.o" },
    ] } };
    if (instanceId === "peer2") return { ok: true, body: { bots: [
      { bot_id: "n1dup", display_name: "Dup", instance_label: "Laptop", messaging_pubkey: PK_NEW, invite_code: "crow:d.u.p" },
    ] } };
    return { ok: false, error: "should-not-be-called" };
  });

  const items = await getAdvertisedBotItems(db);
  assert.equal(items.length, 1, "one unique, non-materialized bot");
  assert.equal(items[0].type, "advertised");
  assert.equal(items[0].messagingPubkey, PK_NEW);
  assert.equal(items[0].inviteCode, "crow:n.e.w");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/roster-advertise-aggregate.test.js`
Expected: FAIL — `getAdvertisedBotItems` not exported.

- [ ] **Step 3: Implement `getAdvertisedBotItems` in `data-queries.js`**

Add the import at the top of the file:

```js
import { getPeerAdvertisedBots } from "../../advertised-bots-cache.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
```

Add the function:

```js
/**
 * Advertised bots from paired instances, as read-only "available" Messages
 * entries. Excludes self + the __local_mcp__ pseudo-instance + revoked peers,
 * dedups by messaging pubkey, and omits any bot already materialized as a local
 * contact. Never throws — a bad peer is silently dropped by the cache.
 */
export async function getAdvertisedBotItems(db) {
  // Pubkeys we already have a contact for (trailing-64, lowercased).
  const known = new Set();
  try {
    const { rows } = await db.execute("SELECT secp256k1_pubkey FROM contacts WHERE secp256k1_pubkey IS NOT NULL");
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      if (h.length >= 64) known.add(h.slice(-64).toLowerCase());
    }
  } catch {}

  let localId = null;
  try { localId = getOrCreateLocalInstanceId(); } catch {}

  let peerIds = [];
  try {
    const { rows } = await db.execute({
      sql: "SELECT id FROM crow_instances WHERE status != 'revoked' AND (crow_id IS NULL OR crow_id != '__local_mcp__')",
      args: [],
    });
    peerIds = rows.map((r) => r.id).filter((id) => id && id !== localId);
  } catch {}

  const settled = await Promise.allSettled(peerIds.map((id) => getPeerAdvertisedBots(db, id)));
  const items = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value || s.value.status !== "ok") continue;
    for (const b of s.value.bots) {
      if (known.has(b.messaging_pubkey) || seen.has(b.messaging_pubkey)) continue;
      seen.add(b.messaging_pubkey);
      items.push({
        type: "advertised",
        botId: b.bot_id,
        displayName: b.display_name,
        instanceId: b.instance_id,
        instanceLabel: b.instance_label,
        messagingPubkey: b.messaging_pubkey,
        inviteCode: b.invite_code,
      });
    }
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-aggregate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/roster-advertise-aggregate.test.js
git commit tests/roster-advertise-aggregate.test.js servers/gateway/dashboard/panels/messages/data-queries.js -m "feat(crow-messages): aggregate advertised bots for Messages"
git show --stat HEAD | head -8
```

---

### Task 6: Viewer — "Bots on your other Crows" section + wiring + i18n

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/html.js`
- Modify: `servers/gateway/dashboard/panels/messages.js`
- Modify: the dashboard i18n source (find with: `grep -rn '"messages.noChats"' servers/gateway/dashboard/`)
- Test: `tests/roster-advertise-html.test.js` (create)

Render a distinct section listing advertised bots, each badged with the owning instance label and carrying a one-line compose form (`action=message_advertised_bot`). The form posts the `invite_code` + `message`; CSRF is required (use the same `csrfInput`-derived string the bot-invite card uses — pass it in as `csrf`).

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-html.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesHTML } from "../servers/gateway/dashboard/panels/messages/html.js";

test("advertised bots render a section with a materialize form", () => {
  const html = buildMessagesHTML({
    items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
    inviteResult: null, inviteError: null, lang: "en", botInvite: null,
    csrf: '<input type="hidden" name="_csrf" value="tok">',
    advertisedBots: [{
      type: "advertised", botId: "b1", displayName: "Helper Bot",
      instanceId: "phone1", instanceLabel: "Phone", messagingPubkey: "a".repeat(64),
      inviteCode: "crow:abc.def.ghi",
    }],
  });
  assert.ok(html.includes("Helper Bot"), "bot name rendered");
  assert.ok(html.includes("Phone"), "instance label badge rendered");
  assert.ok(html.includes('value="message_advertised_bot"'), "materialize action present");
  assert.ok(html.includes("crow:abc.def.ghi"), "invite code embedded");
  assert.ok(html.includes('name="_csrf"'), "csrf present");
});

test("no advertised section when list is empty", () => {
  const html = buildMessagesHTML({
    items: [], totalUnread: 0, aiConfigured: false, storageAvailable: false,
    inviteResult: null, inviteError: null, lang: "en", botInvite: null,
    csrf: "", advertisedBots: [],
  });
  assert.ok(!html.includes("message_advertised_bot"), "no materialize form when empty");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/roster-advertise-html.test.js`
Expected: FAIL — `advertisedBots`/`csrf` not destructured; section not rendered.

- [ ] **Step 3: Implement the section in `html.js`**

Add `advertisedBots` and `csrf` to the destructure on line 32:

```js
const { items, totalUnread, aiConfigured, storageAvailable, inviteResult, inviteError, lang, botInvite, advertisedBots, csrf } = data;
```

Build the section (place after the `botInviteCard` block, before `const avatarItems`):

```js
  // "Bots on your other Crows" — advertised peer-bots (read-only until first send).
  let advertisedSection = "";
  if (Array.isArray(advertisedBots) && advertisedBots.length) {
    const rows = advertisedBots.map((b) =>
      `<div class="msg-advertised-bot">` +
        `<div class="msg-advertised-bot-head">` +
          `<strong>${escapeHtml(b.displayName)}</strong>` +
          `<span class="msg-advertised-badge">${escapeHtml(b.instanceLabel || t("messages.anotherCrow", lang))}</span>` +
        `</div>` +
        `<form method="POST" action="/dashboard/messages" class="msg-advertised-form">` +
          `<input type="hidden" name="action" value="message_advertised_bot">` +
          `<input type="hidden" name="invite_code" value="${escapeHtml(b.inviteCode)}">` +
          `<input type="text" name="message" required placeholder="${escapeHtml(t("messages.advertisedPlaceholder", lang))}">` +
          `${csrf || ""}` +
          `<button type="submit" class="msg-btn-primary">${escapeHtml(t("messages.send", lang))}</button>` +
        `</form>` +
      `</div>`
    ).join("");
    advertisedSection =
      `<div class="msg-advertised-section">` +
      `<div class="msg-advertised-title">${escapeHtml(t("messages.botsOnOtherCrows", lang))}</div>` +
      rows + `</div>`;
  }
```

Change the final `return botInviteCard + \`...` to:

```js
  return botInviteCard + advertisedSection + `
    <div class="msg-hub" style="position:relative">
```

- [ ] **Step 4: Wire `messages.js` to fetch + pass the data**

In `messages.js`, add to the imports on line 17:

```js
import { getUnifiedConversationList, getAdvertisedBotItems } from "./messages/data-queries.js";
```

After `const { items, totalUnread } = await getUnifiedConversationList(db);` (line 57), add:

```js
    // Advertised peer-bots (read-only "available" entries). Never throws.
    let advertisedBots = [];
    try { advertisedBots = await getAdvertisedBotItems(db); } catch {}
```

In the `buildMessagesHTML({ ... })` call (line 75), add `advertisedBots` and `csrf`:

```js
      advertisedBots,
      csrf: csrfInput(req),
```

(`csrfInput` is already imported on line 18.)

- [ ] **Step 5: Add i18n strings**

In the i18n source file (found via the grep above), add under the `en` map and the `es` map. EN:

```
"messages.botsOnOtherCrows": "Bots on your other Crows",
"messages.anotherCrow": "another Crow",
"messages.advertisedPlaceholder": "Send a message to start…",
"messages.send": "Send",
```

ES (only add keys that don't already exist — `messages.send` may already be present; if so, don't duplicate it):

```
"messages.botsOnOtherCrows": "Bots en tus otros Crows",
"messages.anotherCrow": "otro Crow",
"messages.advertisedPlaceholder": "Envía un mensaje para empezar…",
"messages.send": "Enviar",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-html.test.js`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add tests/roster-advertise-html.test.js
git commit tests/roster-advertise-html.test.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages.js <i18n-file-path> -m "feat(crow-messages): render advertised-bots section in Messages"
git show --stat HEAD | head -8
```

---

### Task 7: Viewer — `message_advertised_bot` materialize action

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js`
- Test: `tests/roster-advertise-materialize.test.js` (create)

On first send: parse the invite to get the bot's crow_id, record whether a contact already existed, run `crow_accept_bot_invite` (creates the contact + sends the accept handshake to the owner), tag a *newly created* contact `origin='advertised'`, then `crow_send_message`.

> **Test seam:** `getSharingClient()` builds an in-memory MCP client against the real sharing server, which needs Nostr/relays — too heavy for a unit test. Refactor the handler to accept an optional injected client factory so the test can stub `callTool`. Add a 3rd destructured arg with a default: `handlePostAction(req, res, { db, sharingClientFactory = getSharingClient })`. The new action uses `sharingClientFactory`. Existing call sites pass `{ db }` unchanged (default applies).

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-materialize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

function fakeRes() {
  return { headersSent: false, _redir: null,
    redirectAfterPost(url) { this.headersSent = true; this._redir = url; return this; } };
}

test("first send to an advertised bot accepts the invite, tags origin, and sends", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT)`);

  const calls = [];
  const fakeClient = {
    async callTool(args) {
      calls.push(args.name);
      if (args.name === "crow_accept_bot_invite") {
        // Simulate the accept tool creating the contact (idempotent on crow_id).
        await db.execute({ sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey) VALUES (?, ?)",
          args: ["crow:bot-id-here", "02" + "a".repeat(64)] });
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };

  // parseBotInviteCode must yield botCrowId 'crow:bot-id-here' for this code.
  // Use a real code from generateBotInviteCode in setup, OR stub the import via a
  // code the parser accepts; the key assertion is the call ORDER + the origin tag.
  const req = { body: { action: "message_advertised_bot",
    invite_code: "crow:bot-id-here.payload.sig", message: "hello" } };
  const res = fakeRes();

  const handled = await handlePostAction(req, res, { db, sharingClientFactory: async () => fakeClient });
  assert.equal(res.headersSent, true, "redirected");
  assert.deepEqual(calls, ["crow_accept_bot_invite", "crow_send_message"], "accept then send");

  const { rows } = await db.execute("SELECT origin FROM contacts WHERE crow_id='crow:bot-id-here'");
  assert.equal(rows[0]?.origin, "advertised", "newly created contact tagged origin=advertised");
});
```

> If `parseBotInviteCode` rejects the fake string, generate a real code in the test via `generateBotInviteCode(deriveBotIdentity(seed,'bot'), 'tok', [], null)` and read back its `botCrowId` with `parseBotInviteCode` to use as the expected crow_id. Keep the call-order + origin-tag assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/roster-advertise-materialize.test.js`
Expected: FAIL — action not handled (`handled`/redirect false), no calls recorded.

- [ ] **Step 3: Implement the action in `api-handlers.js`**

Change the signature:

```js
export async function handlePostAction(req, res, { db, sharingClientFactory = getSharingClient }) {
```

Add the action (place after the `accept_bot_invite` block, before `return false;`):

```js
  if (action === "message_advertised_bot" && req.body.invite_code && req.body.message) {
    const code = req.body.invite_code.trim();
    let botCrowId = null;
    try {
      const { parseBotInviteCode } = await import("../../../sharing/identity.js");
      botCrowId = parseBotInviteCode(code).botCrowId;
    } catch { /* malformed — accept will report the error; bail to redirect */ }

    try {
      // Was this bot already a contact? (Only tag origin on contacts WE create,
      // so we never relabel a manually-added contact.)
      let wasNew = false;
      if (botCrowId) {
        const { rows } = await db.execute({ sql: "SELECT 1 FROM contacts WHERE crow_id = ?", args: [botCrowId] });
        wasNew = rows.length === 0;
      }

      const client = await sharingClientFactory();
      // Accept creates the local contact + tells the owner to authorize us.
      await client.callTool({ name: "crow_accept_bot_invite", arguments: { invite_code: code } });

      if (botCrowId) {
        if (wasNew) {
          await db.execute({ sql: "UPDATE contacts SET origin = 'advertised' WHERE crow_id = ?", args: [botCrowId] });
        }
        await client.callTool({ name: "crow_send_message", arguments: { contact: botCrowId, message: req.body.message } });
      }
      await client.close();
    } catch (err) {
      console.error("[messages] Failed to message advertised bot:", err.message);
    }
    return res.redirectAfterPost("/dashboard/messages");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-materialize.test.js`
Expected: PASS — calls are `["crow_accept_bot_invite","crow_send_message"]`, contact tagged `advertised`.

- [ ] **Step 5: Commit**

```bash
git add tests/roster-advertise-materialize.test.js
git commit tests/roster-advertise-materialize.test.js servers/gateway/dashboard/panels/messages/api-handlers.js -m "feat(crow-messages): materialize advertised bot on first message"
git show --stat HEAD | head -8
```

---

### Task 8: Viewer — prune stale advertised contacts

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js`
- Test: `tests/roster-advertise-prune.test.js` (create)

Delete `origin='advertised'` contacts that have **no message history** and are **no longer in the live advertised set** (e.g. the bot stopped advertising or the instance unpaired). Contacts with history are always kept (they show in the normal conversation list). Called at the end of `getAdvertisedBotItems` with the live pubkey set computed there.

- [ ] **Step 1: Write the failing test**

```js
// tests/roster-advertise-prune.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { pruneStaleAdvertisedContacts } from "../servers/gateway/dashboard/panels/messages/data-queries.js";

test("prunes advertised contacts with no history that are no longer advertised", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE contacts (id INTEGER PRIMARY KEY, crow_id TEXT, secp256k1_pubkey TEXT, origin TEXT)`);
  await db.execute(`CREATE TABLE messages (id INTEGER PRIMARY KEY, contact_id INTEGER)`);

  // 1) advertised, no history, NOT live  → pruned
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (1,'a','02'||?,'advertised')", args: ["a".repeat(64)] });
  // 2) advertised, no history, STILL live → kept
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (2,'b','02'||?,'advertised')", args: ["b".repeat(64)] });
  // 3) advertised, HAS history, not live → kept
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (3,'c','02'||?,'advertised')", args: ["c".repeat(64)] });
  await db.execute("INSERT INTO messages (contact_id) VALUES (3)");
  // 4) manual contact, no history, not live → kept (origin NULL)
  await db.execute({ sql: "INSERT INTO contacts (id, crow_id, secp256k1_pubkey, origin) VALUES (4,'d','02'||?,NULL)", args: ["d".repeat(64)] });

  const live = new Set(["b".repeat(64)]);
  await pruneStaleAdvertisedContacts(db, live);

  const { rows } = await db.execute("SELECT id FROM contacts ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), [2, 3, 4], "only the stale advertised no-history contact is pruned");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/roster-advertise-prune.test.js`
Expected: FAIL — `pruneStaleAdvertisedContacts` not exported.

- [ ] **Step 3: Implement + wire**

Add to `data-queries.js`:

```js
/**
 * Delete origin='advertised' contacts that have no message history AND are no
 * longer advertised (not in `livePubkeys`, a Set of trailing-64 lowercased
 * x-only keys). Contacts with history are always kept. Never throws.
 */
export async function pruneStaleAdvertisedContacts(db, livePubkeys) {
  try {
    const { rows } = await db.execute(`
      SELECT c.id, c.secp256k1_pubkey
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id
      WHERE c.origin = 'advertised'
      GROUP BY c.id
      HAVING COUNT(m.id) = 0`);
    for (const r of rows) {
      const h = String(r.secp256k1_pubkey || "");
      const pk = h.length >= 64 ? h.slice(-64).toLowerCase() : "";
      if (!livePubkeys.has(pk)) {
        await db.execute({ sql: "DELETE FROM contacts WHERE id = ?", args: [r.id] });
      }
    }
  } catch {}
}
```

In `getAdvertisedBotItems`, build a `live` set of every advertised pubkey seen (before dedup-excluding materialized ones) and call prune just before returning:

```js
  // (inside getAdvertisedBotItems, accumulate while iterating s.value.bots:)
  const live = new Set();
  // ... in the inner loop, BEFORE the known/seen skips: live.add(b.messaging_pubkey);
  // ... after the loop, before `return items;`:
  await pruneStaleAdvertisedContacts(db, live);
  return items;
```

> Make sure `live.add(b.messaging_pubkey)` runs for **every** advertised bot from a reachable peer — including ones already materialized — so a still-advertised materialized contact is never pruned. Do NOT populate `live` from unreachable peers (a transient offline peer must not trigger pruning of its bots); the `status !== "ok"` guard already skips those.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/roster-advertise-prune.test.js tests/roster-advertise-aggregate.test.js`
Expected: PASS (prune test + the Task 5 aggregate test still green).

- [ ] **Step 5: Commit**

```bash
git add tests/roster-advertise-prune.test.js
git commit tests/roster-advertise-prune.test.js servers/gateway/dashboard/panels/messages/data-queries.js -m "feat(crow-messages): prune stale advertised contacts"
git show --stat HEAD | head -8
```

---

### Task 9: Verify network-exposure invariant + full suite

**Files:**
- Test: `tests/auth-network.test.js` (existing — run, do not modify unless it fails)

The new route lives under the `/dashboard` mount and is HMAC-gated by `federationVerify`; it is NOT in `PUBLIC_FUNNEL_PREFIXES`, so it must remain Funnel-blocked. Confirm nothing regressed.

- [ ] **Step 1: Run the network-invariant test**

Run: `node --test --test-force-exit tests/auth-network.test.js`
Expected: PASS — no public exposure of private routes.

- [ ] **Step 2: Run the full roster-advertise test set together**

Run:
```bash
node --test --test-force-exit \
  tests/roster-advertise-schema.test.js \
  tests/roster-advertise-owner.test.js \
  tests/roster-advertise-route.test.js \
  tests/roster-advertise-cache.test.js \
  tests/roster-advertise-aggregate.test.js \
  tests/roster-advertise-html.test.js \
  tests/roster-advertise-materialize.test.js \
  tests/roster-advertise-prune.test.js
```
Expected: all PASS.

- [ ] **Step 3: Confirm the gateway boots clean**

Run: `node servers/gateway/index.js --no-auth` (ctrl-C after it logs "listening").
Expected: starts without import/syntax errors (validates the federation route + cache + data-queries wiring load).

- [ ] **Step 4: Commit (only if `auth-network.test.js` needed a touch — otherwise nothing to commit)**

No code change expected here; this task is verification. If a regression surfaced, fix it in the relevant task's file and re-run.

---

## Deploy (after merge — per the handoff cheat-sheet)

Schema change present → at each host: `git pull --rebase`, then run `node scripts/init-db.js` per data dir **first** (MPA: `CROW_DB_PATH=~/.crow-mpa/data/crow.db node scripts/init-db.js`), then restart the **gateway(s)**. The pi-bots host (`pibot-gateways@crow-mpa`, `pibot-gateways@grackle`) does **not** need restarting — no adapter/store code changed (the new invite row is read by the existing `consumeInvite` path). Hosts: crow main (`:3001`) + MPA (`:3006`) + grackle (`:3002`) + black-swan (`0.0.0.0:3001`). Verify via node ports, not ts.net `/health`. Gateway restarts drop glasses/companion WS (reopen app).

## Self-Review notes (author)

- **Spec coverage:** gating (Task 2 `listAdvertisedBots`), pull-at-render transport (Tasks 3–4), display (Task 6), materialize-on-first-send (Task 7), embedded-invite auth (Tasks 2+7), cleanup (Task 8), schema `contacts.origin`/invite `kind` (Task 1), security/Funnel invariant (Task 9). All spec sections map to a task.
- **Type consistency:** owner payload keys are snake_case (`bot_id`, `messaging_pubkey`, `invite_code`, `instance_label`) end-to-end through the cache validator; the viewer item is camelCase (`botId`, `messagingPubkey`, `inviteCode`, `instanceLabel`) from `getAdvertisedBotItems` onward (Tasks 5–7 consistent). Pubkey comparison is always trailing-64 lowercased.
- **Open verification (not placeholders):** confirm `deriveBotIdentity` field name (`secp256k1Pubkey`) in Task 2; copy the signing harness from `tests/federation-overview.test.js` in Task 3; locate the i18n source file in Task 6. Each is a concrete lookup, not an unspecified decision.
