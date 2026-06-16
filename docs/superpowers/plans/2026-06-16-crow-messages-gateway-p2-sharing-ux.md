# Crow Messages Gateway — Plan 2 (Sharing UX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Crow Messages gateway usable end-to-end by a non-technical owner: share access to a bot with a copyable link + QR, manage who can message it, let the owner's own paired instances through with one checkbox, and let a recipient accept an invite in one tap so the bot appears in their Messages list.

**Architecture:** Plan 1 already shipped the transport (per-bot derived identity, the pi-bots `crow-messages` host adapter, the `bot_message_acl`/`bot_message_invites`/`bot_message_seen` tables, ed25519-signed invite codes, default-deny ACL). Plan 2 builds the **UI + sharing flow** on top: a libsql admin helper the gateway uses to mint/rotate invites and edit the ACL (the adapter still reads them via better-sqlite3 — same `crow.db`), the Bot Builder gateways-tab UI for `crow-messages`, the `allow_paired_instances` authorization path (deferred from Plan 1), a recipient `crow_accept_bot_invite` sharing tool, and a Messages-panel accept action + landing card.

**Tech Stack:** Node (ESM), libsql (`db.execute`) in the gateway/UI, better-sqlite3 (`db.prepare`) in the pi-bots host, `qrcode` (already a dependency), `nostr-tools` (NIP-44), Node built-in test runner (`node --test`).

---

## Background facts the implementer must know

- **Two DB clients, one file.** The gateway/UI writes `bot_message_acl` / `bot_message_invites` via **libsql** (`db.execute({sql,args})`). The pi-bots adapter reads them via **better-sqlite3** (`db.prepare(...)`). Same `crow.db`. Single-statement writes + `busy_timeout` keep this safe (handoff §Gotchas).
- **Identity is derived, never stored.** `deriveBotIdentity(seed, botId)` (`servers/sharing/identity.js:191`) is pure. **CRITICAL parity rule:** the gateway-side admin code MUST derive the seed exactly the way the pi-bots adapter does — `loadInstanceSeed(dirname(botsDbPath()))` — NOT via `loadOrCreateIdentity()`. Reason: `loadOrCreateIdentity()` reads the module-level `DATA_DIR` (`resolveDataDir()` = `CROW_DATA_DIR`→`~/.crow/data`→`./data`), but the running gateway anchors its DB on `CROW_DB_PATH` first (`servers/db.js:307`), and `botsDbPath()` (`scripts/pi-bots/instance-paths.mjs:23`) = `CROW_DB_PATH || join(resolveDataDir(),"crow.db")`. If the gateway runs with `CROW_DB_PATH` set to a dir different from `resolveDataDir()`, `loadOrCreateIdentity()` would derive a DIFFERENT key than the adapter subscribes under — every shared invite would point at a key nobody listens on. Using `loadInstanceSeed(dirname(botsDbPath()))` guarantees the editor's `crow_id` == the adapter's subscription key. It is also **read-only** (no `identity.json` write side-effect on a GET render, unlike `loadOrCreateIdentity()` which creates+writes one). It throws if the seed is missing/encrypted — the editor catches that and shows no address (correct fail).
- **ACL is keyed on the secp256k1 x-only pubkey of the SIGNED event** — never a sender-claimed field. `xOnly()` normalizes a 66-hex compressed key to 64-hex. Keep this invariant in all new auth code.
- **Invite codes** are made/validated by `generateBotInviteCode(botIdentity, token, relays)` / `parseBotInviteCode(code)` (`identity.js:237`,`:255`) — ed25519-signed, tamper-evident over the whole payload (token, secp key, relays). Returns `{ botCrowId, ed25519Pubkey, secp256k1Pubkey, token, relays }`.
- **The tables already exist** (Plan 1, `scripts/init-db.js:1654-1691`). Plan 2 adds **no** schema. `bot_message_acl(bot_id, sender_pubkey, crow_id, display_name, added_via∈{invite,manual})`, `bot_message_invites(bot_id, token UNIQUE, expires_at, max_uses, uses, revoked)`.
- **`crow_instances` has NO secp key** (`init-db.js:1503`). The `allow_paired_instances` check must join `contacts` (which HAS `secp256k1_pubkey`) by `crow_id`.
- **POST routing.** Bot Builder: `handleBotBuilderPost(req,res,{db})` dispatches on `b.action` (`create`, `toggle`, `save_<tab>`, …); the panel re-renders unless `res.headersSent`. Messages: `handlePostAction(req,res,{db})` dispatches on `b.action`; returning `false` re-renders.
- **Test harness pattern** (from `tests/bot-builder-gateway-draft.test.js`): `mkdtempSync` a dir → `process.env.CROW_DATA_DIR=dir` → `execFileSync(process.execPath,["scripts/init-db.js"],{env,cwd})` → `createDbClient()` from `servers/db.js` for libsql; `new Database(path)` for better-sqlite3.
- **Run a single test:** `node --test tests/<file>.test.js`. No aggregate runner.
- **Commit convention:** `git commit <paths> -m "..."` (positional paths, never bare `git add` + `git commit`). New test files must be `git add`-ed first. Verify with `git show --stat HEAD`.

## Branch setup (do this once, before Task 1)

- [ ] **Create the feature branch off local main `1acf9a6`.**

```bash
cd /home/kh0pp/crow
git status --short        # working tree should be clean of tracked changes
git checkout -b feat/crow-messages-p2
git log --oneline -1      # expect: 1acf9a6 Merge feat/crow-messages-gateway...
```

---

## File Structure

**Create:**
- `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js` — libsql admin helpers: mint/rotate invites, list/remove/add ACL, build the shareable invite code (derives identity + reads relays).
- `tests/crow-messages-admin.test.js` — unit tests for the admin helpers.
- `tests/crow-accept-bot-invite.test.js` — unit tests for the recipient accept payload + tool wiring.
- `tests/crow-messages-editor.test.js` — render test proving the gateways-tab action names + CSRF (catches the `hidden()` prefix bug).

**Modify:**
- `scripts/pi-bots/gateways/crow-messages-store.mjs` — `authorizeSender` gains an `allowPaired` path (paired-instance via `contacts`⋈`crow_instances`).
- `scripts/pi-bots/gateways/crow-messages.mjs` — thread `allow_paired_instances` from `gw` through to `authorizeSender`.
- `tests/crow-messages-store.test.js` / `tests/crow-messages-adapter.test.js` — extend for the paired-instance path.
- `servers/sharing/tools/contacts.js` — add `crow_accept_bot_invite` tool + a pure `buildBotAcceptPayload` helper.
- `servers/gateway/dashboard/panels/messages/api-handlers.js` — add `accept_bot_invite` action.
- `servers/gateway/dashboard/panels/messages/html.js` — render the `?bot_invite=` "Add & message" landing card.
- `servers/gateway/dashboard/panels/messages.js` — pass the `bot_invite` query through to the HTML builder.
- `servers/gateway/dashboard/panels/bot-builder/editor.js` — flip `crow-messages` to `available:true`, drop `disabled`, render the Share/manage/Advanced block.
- `servers/gateway/dashboard/panels/bot-builder/api-handlers.js` — `crow-messages` save branch + `gw_share`/`gw_newlink`/`gw_remove`/`gw_advanced_add` actions.
- `tests/bot-builder-gateway-draft.test.js` — replace the "NOT persisted" assertion (crow-messages is now persisted) with a positive one.
- `scripts/pi-bots/gateways/index.mjs` — proper `Crow Messages` label in `capabilitiesForUI()`.
- `servers/gateway/dashboard/shared/i18n.js` — EN/ES strings for the new UI.

---

## Task 1: libsql admin helpers for invites + ACL

The gateway/UI cannot use the better-sqlite3 `crow-messages-store.mjs`. This module is its libsql counterpart for the **write/manage** side, plus it builds the shareable invite code (deriving the bot identity and reading relays).

**Files:**
- Create: `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js`
- Test: `tests/crow-messages-admin.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/crow-messages-admin.test.js`:

```javascript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cm-admin-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let admin = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  // init-db does NOT create identity.json (the instance seed). Seed it now so
  // loadInstanceSeed(dirname(botsDbPath())) can derive bot keys. With CROW_DATA_DIR
  // set and no CROW_DB_PATH, botsDbPath() = <dir>/crow.db, so dirname == <dir>.
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity(); // writes <dir>/identity.json (unencrypted)
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

test("mintInvite creates a non-revoked token; getActiveInvite returns the latest", async () => {
  const tok = await admin.mintInvite(db, "bot1", {});
  assert.ok(tok && typeof tok === "string" && tok.length >= 16, "token returned");
  const active = await admin.getActiveInvite(db, "bot1");
  assert.equal(active.token, tok);
  assert.equal(Number(active.revoked), 0);
});

test("rotateInvite revokes all prior tokens and mints a fresh one", async () => {
  const before = (await admin.getActiveInvite(db, "bot1")).token;
  const fresh = await admin.rotateInvite(db, "bot1", {});
  assert.notEqual(fresh, before, "new token differs");
  const active = await admin.getActiveInvite(db, "bot1");
  assert.equal(active.token, fresh, "active is the fresh one");
  // The prior token must now be revoked.
  const { rows } = await db.execute({
    sql: "SELECT revoked FROM bot_message_invites WHERE token=?", args: [before],
  });
  assert.equal(Number(rows[0].revoked), 1, "prior token revoked");
});

test("listAcl / addManualAcl / removeAcl round-trip", async () => {
  const pk = "a".repeat(64);
  await admin.addManualAcl(db, "bot1", "02" + pk, "crow:zzz", "Alice"); // compressed in → normalized
  let acl = await admin.listAcl(db, "bot1");
  assert.equal(acl.length, 1);
  assert.equal(acl[0].sender_pubkey, pk, "stored x-only (64-hex)");
  assert.equal(acl[0].display_name, "Alice");
  assert.equal(acl[0].added_via, "manual");
  await admin.removeAcl(db, "bot1", pk);
  acl = await admin.listAcl(db, "bot1");
  assert.equal(acl.length, 0, "removed");
});

test("buildInviteCode produces a code parseable by parseBotInviteCode with the active token", async () => {
  const { parseBotInviteCode } = await import("../servers/sharing/identity.js");
  const tok = (await admin.getActiveInvite(db, "bot1")).token;
  const code = await admin.buildInviteCode(db, "bot1", tok);
  const parsed = parseBotInviteCode(code);
  assert.equal(parsed.token, tok);
  assert.ok(parsed.secp256k1Pubkey && parsed.secp256k1Pubkey.length >= 64, "carries the bot secp key");
  assert.ok(Array.isArray(parsed.relays), "carries relays");
});

test("botIdentityFor matches the key the pi-bots adapter would subscribe under (parity)", async () => {
  // The adapter derives via loadInstanceSeed(dirname(botsDbPath())); the admin
  // helper MUST produce the identical crow_id, or shared invites are dead.
  const { loadInstanceSeed, deriveBotIdentity } = await import("../servers/sharing/identity.js");
  const { botsDbPath } = await import("../scripts/pi-bots/instance-paths.mjs");
  const { dirname } = await import("node:path");
  const adapterId = deriveBotIdentity(loadInstanceSeed(dirname(botsDbPath())), "bot1");
  const adminId = admin.botIdentityFor("bot1");
  assert.equal(adminId.crowId, adapterId.crowId, "crow_id parity admin vs adapter");
  assert.equal(adminId.secp256k1Pubkey, adapterId.secp256k1Pubkey, "secp key parity");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/crow-messages-admin.test.js`
Expected: FAIL — `Cannot find module ...crow-messages-admin.js`.

- [ ] **Step 3: Write the implementation**

Create `servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js`:

```javascript
/**
 * Crow Messages gateway — admin (libsql) side, for the gateway/UI process.
 *
 * The pi-bots adapter reads bot_message_acl/bot_message_invites via better-sqlite3
 * (crow-messages-store.mjs); this is the write/manage counterpart the dashboard
 * uses via libsql (db.execute). Same crow.db file — single-statement writes.
 *
 * Identity is derived (never stored): the gateway's own instance seed
 * (loadOrCreateIdentity().seed) + the bot id → deriveBotIdentity.
 */
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  loadInstanceSeed, deriveBotIdentity, generateBotInviteCode,
} from "../../../../sharing/identity.js";
import { botsDbPath } from "../../../../../scripts/pi-bots/instance-paths.mjs";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

/** x-only normalize: a 66-hex compressed secp key → 64-hex. */
export function xOnly(hex) { const h = String(hex || ""); return h.length === 66 ? h.slice(2) : h; }

/**
 * Derive this instance's identity for the given bot (pure; nothing stored).
 * Seed source = loadInstanceSeed(dirname(botsDbPath())) — the SAME anchor the
 * pi-bots adapter uses (crow-messages.mjs:75), so the editor's crow_id and the
 * adapter's subscription key are guaranteed identical. Read-only: throws (not
 * creates) if no identity.json exists beside the crow.db.
 */
export function botIdentityFor(botId) {
  const seed = loadInstanceSeed(dirname(botsDbPath()));
  return deriveBotIdentity(seed, botId);
}

/** Instance-configured Nostr relays (libsql), else defaults. Mirrors store.resolveRelays. */
export async function resolveRelays(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT relay_url FROM relay_config WHERE relay_type='nostr' AND enabled=1", args: [],
    });
    if (rows.length) return rows.map((r) => r.relay_url);
  } catch { /* table may be absent */ }
  return DEFAULT_RELAYS;
}

/** Mint a fresh invite token row. Returns the token string. */
export async function mintInvite(db, botId, { expiresAt = null, maxUses = null } = {}) {
  const token = randomBytes(24).toString("base64url");
  await db.execute({
    sql: "INSERT INTO bot_message_invites (bot_id, token, expires_at, max_uses) VALUES (?,?,?,?)",
    args: [botId, token, expiresAt, maxUses],
  });
  return token;
}

/** Latest non-revoked invite for a bot, or null. */
export async function getActiveInvite(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT id, token, expires_at, max_uses, uses, revoked, created_at FROM bot_message_invites "
       + "WHERE bot_id=? AND revoked=0 ORDER BY id DESC LIMIT 1",
    args: [botId],
  });
  return rows[0] || null;
}

/** Revoke every prior token for the bot, then mint a fresh one. Returns the new token. */
export async function rotateInvite(db, botId, opts = {}) {
  await db.execute({ sql: "UPDATE bot_message_invites SET revoked=1 WHERE bot_id=?", args: [botId] });
  return mintInvite(db, botId, opts);
}

/** All ACL rows for a bot (the "Who can message" list). */
export async function listAcl(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT id, sender_pubkey, crow_id, display_name, added_via, created_at "
       + "FROM bot_message_acl WHERE bot_id=? ORDER BY created_at ASC",
    args: [botId],
  });
  return rows;
}

/** Remove one authorized sender (by x-only pubkey). */
export async function removeAcl(db, botId, senderPubkey) {
  await db.execute({
    sql: "DELETE FROM bot_message_acl WHERE bot_id=? AND sender_pubkey=?",
    args: [botId, xOnly(senderPubkey)],
  });
}

/** Manually authorize a sender (Advanced add-by-pubkey). Idempotent on (bot, pubkey). */
export async function addManualAcl(db, botId, senderPubkey, crowId = null, displayName = null) {
  await db.execute({
    sql: "INSERT INTO bot_message_acl (bot_id, sender_pubkey, crow_id, display_name, added_via) "
       + "VALUES (?,?,?,?, 'manual') "
       + "ON CONFLICT(bot_id, sender_pubkey) DO UPDATE SET crow_id=excluded.crow_id, display_name=excluded.display_name",
    args: [botId, xOnly(senderPubkey), crowId, displayName],
  });
}

/** Build the shareable, ed25519-signed invite code for (bot, token). */
export async function buildInviteCode(db, botId, token) {
  const botIdentity = botIdentityFor(botId);
  const relays = await resolveRelays(db);
  return generateBotInviteCode(botIdentity, token, relays);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/crow-messages-admin.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/crow-messages-admin.test.js servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js
git commit servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js tests/crow-messages-admin.test.js \
  -m "feat(crow-messages): libsql admin helpers for invites + ACL (Plan 2 T1)"
git show --stat HEAD
```

---

## Task 2: `allow_paired_instances` authorization path

Plan 1 left `authorizeSender` ACL-only. Re-add the paired-instance path: when the bot's gateway config has `allow_paired_instances` on, a sender whose secp key matches a `contacts` row whose `crow_id` is a known `crow_instances` row is allowed without an explicit ACL entry.

**Files:**
- Modify: `scripts/pi-bots/gateways/crow-messages-store.mjs`
- Modify: `scripts/pi-bots/gateways/crow-messages.mjs:53` (chat authorize call) + `:64` (`start`)
- Test: `tests/crow-messages-store.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/crow-messages-store.test.js`:

```javascript
test("authorizeSender: allow_paired_instances lets a paired-instance contact through without an ACL row", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "cm-store-paired-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmp }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const d = new Database(join(tmp, "crow.db"));
  // contacts.secp256k1_pubkey is stored as the 66-hex COMPRESSED key (02/03 prefix),
  // but events authorize on the 64-hex x-only pubkey. Test BOTH parity prefixes.
  const xonly02 = "c".repeat(64);          // a 02-prefixed contact
  const xonly03 = "f".repeat(64);          // a 03-prefixed contact (the half a naive "02"+pk match misses)
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:paired01", "Laptop", "ed".repeat(16), "02" + xonly02);
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:paired03", "Phone", "ee".repeat(16), "03" + xonly03);
  d.prepare("INSERT INTO crow_instances (id, name, crow_id) VALUES (?,?,?)").run("inst-1", "Laptop", "crow:paired01");
  d.prepare("INSERT INTO crow_instances (id, name, crow_id) VALUES (?,?,?)").run("inst-2", "Phone", "crow:paired03");
  // Off → denied (default-deny, no ACL row).
  assert.equal(cmStore.authorizeSender(d, "botX", xonly02, false), false, "denied with toggle off");
  // On → allowed via the paired-instance join, for BOTH 02 and 03 contacts.
  assert.equal(cmStore.authorizeSender(d, "botX", xonly02, true), true, "02-prefixed paired contact allowed");
  assert.equal(cmStore.authorizeSender(d, "botX", xonly03, true), true, "03-prefixed paired contact allowed");
  // A contact who is NOT a registered instance → denied even with toggle on.
  d.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)")
    .run("crow:friend01", "Friend", "ab".repeat(16), "02" + "a".repeat(64));
  assert.equal(cmStore.authorizeSender(d, "botX", "a".repeat(64), true), false, "non-instance contact denied");
  // Unknown sender → denied.
  assert.equal(cmStore.authorizeSender(d, "botX", "d".repeat(64), true), false, "unknown sender denied");
  d.close();
  rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/crow-messages-store.test.js`
Expected: FAIL — `authorizeSender` ignores the 4th arg, so "denied with toggle off" passes but "allowed with toggle on" fails (returns false).

- [ ] **Step 3: Update `authorizeSender`**

In `scripts/pi-bots/gateways/crow-messages-store.mjs`, replace the `authorizeSender` function (lines 18-27) with:

```javascript
/**
 * True if senderPubkey (x-only) may message botId.
 * Sources: (1) the bot's ACL (default-deny), OR (2) when allowPaired is true,
 * the sender is one of the operator's own paired instances — i.e. a contacts
 * row (which carries the secp key) whose crow_id is a registered crow_instances
 * row (crow_instances itself has no secp key, so we join contacts by crow_id).
 * Fail-closed: any error → false.
 */
export function authorizeSender(db, botId, senderPubkey, allowPaired = false) {
  const pk = xOnly(senderPubkey);
  try {
    const acl = db.prepare("SELECT 1 FROM bot_message_acl WHERE bot_id=? AND sender_pubkey=? LIMIT 1").get(botId, pk);
    if (acl) return true;
    if (allowPaired) {
      // contacts.secp256k1_pubkey is the 66-hex COMPRESSED key (02/03 prefix);
      // events authorize on the 64-hex x-only key. Compare the trailing 64 hex
      // so BOTH y-parities match (a `02`+pk equality test would miss every
      // 03-prefixed contact — ~half of them).
      const paired = db.prepare(
        "SELECT 1 FROM contacts c JOIN crow_instances i ON i.crow_id = c.crow_id "
        + "WHERE substr(c.secp256k1_pubkey, -64) = ? LIMIT 1"
      ).get(pk);
      if (paired) return true;
    }
  } catch { return false; }
  return false;
}
```

- [ ] **Step 4: Thread the toggle through the adapter**

In `scripts/pi-bots/gateways/crow-messages.mjs`:

a) Update `handleCrowMessageEvent`'s signature + the chat authorize call. Change the destructured params (line 28) to add `allowPaired`:

```javascript
export async function handleCrowMessageEvent({ botId, senderPubkey, decrypted, db, handleInbound, sendDM, log, allowPaired = false }) {
```

and change the chat authorize line (line 53) from:

```javascript
  if (!cmStore.authorizeSender(db, botId, pk)) { log("drop unauthorized bot=" + botId + " sender=" + pk); return; }
```

to:

```javascript
  if (!cmStore.authorizeSender(db, botId, pk, allowPaired)) { log("drop unauthorized bot=" + botId + " sender=" + pk); return; }
```

> Scope note: leave the OTHER `authorizeSender` call (line 37, inside the `bot_invite_accept` control path) ACL-only — do NOT thread `allowPaired` there. That call is an "already authorized?" short-circuit before consuming a token; if a paired instance accepts an invite it simply records an explicit ACL row (harmless). Only the plain-chat path (line 53) gets the toggle.

b) In `start({ bot_id, gw, log })`, read the toggle once near the top of `start` (after `const db = ...`, around line 70) :

```javascript
  const allowPaired = !!(gw && gw.allow_paired_instances);
```

and pass it into the `handleCrowMessageEvent` call inside the subscribe callback (the object literal around line 94-103) by adding `allowPaired,` to that object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/crow-messages-store.test.js tests/crow-messages-adapter.test.js`
Expected: PASS (all, including the new paired-instance test).

- [ ] **Step 6: Commit**

```bash
git commit scripts/pi-bots/gateways/crow-messages-store.mjs scripts/pi-bots/gateways/crow-messages.mjs tests/crow-messages-store.test.js \
  -m "feat(crow-messages): allow_paired_instances authorization path (Plan 2 T2)"
git show --stat HEAD
```

---

## Task 3: recipient accept tool (`crow_accept_bot_invite`)

The recipient parses the bot invite, adds the bot as a **contact** (so it shows in the existing Messages list and the recipient's NostrManager subscribes for replies), and sends the bot a signed-token `bot_invite_accept` DM. The adapter already handles that inbound (`handleCrowMessageEvent` → `consumeInvite` → `upsertAclFromAccept`).

**Files:**
- Modify: `servers/sharing/tools/contacts.js`
- Test: `tests/crow-accept-bot-invite.test.js`

- [ ] **Step 1: Write the failing test (pure payload helper)**

Create `tests/crow-accept-bot-invite.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotAcceptPayload } from "../servers/sharing/tools/contacts.js";

test("buildBotAcceptPayload carries the token + the accepter's identity, typed crow_social/bot_invite_accept", () => {
  const identity = {
    crowId: "crow:me0000000",
    ed25519Pubkey: "ed".repeat(16),
    secp256k1Pubkey: "ab".repeat(33),
  };
  const out = JSON.parse(buildBotAcceptPayload("the-token", identity, "Kevin"));
  assert.equal(out.type, "crow_social");
  assert.equal(out.subtype, "bot_invite_accept");
  assert.equal(out.token, "the-token");
  assert.equal(out.sender.crow_id, "crow:me0000000");
  assert.equal(out.sender.ed25519_pubkey, identity.ed25519Pubkey);
  assert.equal(out.sender.secp256k1_pubkey, identity.secp256k1Pubkey);
  assert.equal(out.sender.display_name, "Kevin");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/crow-accept-bot-invite.test.js`
Expected: FAIL — `buildBotAcceptPayload` not exported.

- [ ] **Step 3: Add the helper + the tool**

In `servers/sharing/tools/contacts.js`:

a) Extend the import line (line 10) to include `parseBotInviteCode`:

```javascript
import { generateInviteCode, parseInviteCode, parseBotInviteCode, computeSafetyNumber } from "../identity.js";
```

b) Add the pure helper near the top of the file (after the imports, before `export function registerContactsTools`):

```javascript
/**
 * Build the DM payload a recipient sends to a bot to accept its invite.
 * The adapter authorizes future chats on the SIGNED event pubkey, so the keys
 * here are labels the bot stores; the token is the bearer capability it checks.
 */
export function buildBotAcceptPayload(token, identity, displayName) {
  return JSON.stringify({
    type: "crow_social",
    subtype: "bot_invite_accept",
    token,
    sender: {
      crow_id: identity.crowId,
      ed25519_pubkey: identity.ed25519Pubkey,
      secp256k1_pubkey: identity.secp256k1Pubkey,
      display_name: displayName || identity.crowId,
    },
  });
}
```

> Note (intentional divergence): this tool adds an `isKioskActive` guard that `crow_accept_invite` lacks — accepting a bot invite is a deliberate action that shouldn't fire from a locked kiosk. The `isKioskActive`/`kioskBlockedResponse` imports are already present (`contacts.js:9`). `db`, `identity`, `syncManager`, `nostrManager` are all destructured from `ctx` at the top of `registerContactsTools` (`contacts.js:13`).

c) Register the tool inside `registerContactsTools`, after the `crow_accept_invite` tool block (after line 148, before `// --- Tool: crow_list_contacts ---`):

```javascript
  // --- Tool: crow_accept_bot_invite ---

  server.tool(
    "crow_accept_bot_invite",
    "Accept a Crow Messages bot invite. Adds the bot to your Messages so you can chat with it, and tells the bot you accepted so it authorizes you. Paste the bot invite code the owner shared.",
    {
      invite_code: z.string().max(2000).describe("The bot invite code (crow:<id>.<payload>.<sig>)"),
      display_name: z.string().max(100).optional().describe("Name to show for this bot"),
    },
    async ({ invite_code, display_name }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_accept_bot_invite");
      try {
        const bot = parseBotInviteCode(invite_code.trim());
        const name = display_name || bot.botCrowId;

        // Add the bot as a contact so it appears in Messages and we subscribe
        // for its replies. Idempotent on crow_id.
        const existing = await db.execute({
          sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [bot.botCrowId],
        });
        let contactId;
        if (existing.rows.length > 0) {
          contactId = Number(existing.rows[0].id);
        } else {
          const result = await db.execute({
            sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
            args: [bot.botCrowId, name, bot.ed25519Pubkey, bot.secp256k1Pubkey],
          });
          contactId = Number(result.lastInsertRowid);
          try { await syncManager.initContact(contactId, null); } catch { /* bot has no hypercore feed; non-fatal */ }
        }

        // Subscribe to the bot's replies over Nostr.
        try {
          await nostrManager.subscribeToContact({
            id: contactId, crowId: bot.botCrowId, secp256k1_pubkey: bot.secp256k1Pubkey,
          });
        } catch { /* non-fatal — re-subscribed on next restart */ }

        // Tell the bot we accepted (carries the token it validates).
        try {
          if (nostrManager.relays.size === 0) await nostrManager.connectRelays();
          await nostrManager.sendMessage(
            { secp256k1_pubkey: bot.secp256k1Pubkey },
            buildBotAcceptPayload(bot.token, identity, name)
          );
        } catch (err) {
          return {
            content: [{ type: "text", text: `Added ${name}, but could not reach the bot to confirm (it will authorize you when next online): ${err.message}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Added ${name}! You can now message this bot from your Messages list.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to accept bot invite: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/crow-accept-bot-invite.test.js`
Expected: PASS.

- [ ] **Step 5: Verify the sharing server still loads (tool registers cleanly)**

Run: `node -e "import('./servers/sharing/server.js').then(m => { m.createSharingServer(); console.log('sharing server OK'); }).catch(e => { console.error(e); process.exit(1); })"`
Expected: prints `sharing server OK`.

- [ ] **Step 6: Commit**

```bash
git add tests/crow-accept-bot-invite.test.js
git commit servers/sharing/tools/contacts.js tests/crow-accept-bot-invite.test.js \
  -m "feat(crow-messages): crow_accept_bot_invite recipient tool (Plan 2 T3)"
git show --stat HEAD
```

---

## Task 4: Messages-panel accept action + `?bot_invite=` landing card

Mirror the existing `accept_invite` action and add a GET landing card so a shared link `…/dashboard/messages?bot_invite=<code>` shows "Add & message `<bot>`" with one button.

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js`
- Modify: `servers/gateway/dashboard/panels/messages.js`
- Modify: `servers/gateway/dashboard/panels/messages/html.js`
- Test: append to `tests/crow-accept-bot-invite.test.js`

- [ ] **Step 1: Write the failing test (action dispatch)**

Append to `tests/crow-accept-bot-invite.test.js`:

```javascript
import { mock } from "node:test";

test("messages handlePostAction routes accept_bot_invite to the sharing tool and redirects", async () => {
  const { handlePostAction } = await import("../servers/gateway/dashboard/panels/messages/api-handlers.js");
  // Stub the sharing client factory via a captured call recorder on the module
  // is overkill; instead assert the dispatch path returns a redirect for a
  // well-formed body even if the tool call fails internally (it catches).
  const calls = [];
  const req = { body: { action: "accept_bot_invite", invite_code: "crow:x.y.z" } };
  const res = { redirectAfterPost: (u) => { calls.push(u); res.headersSent = true; } };
  await handlePostAction(req, res, { db: { execute: async () => ({ rows: [] }) } });
  assert.equal(calls[0], "/dashboard/messages", "redirects back to messages");
});
```

> Why this test is valid even though it hits the real sharing server: the handler wraps `getSharingClient()` → `createSharingServer()` AND the `callTool` in one `try/catch`; the `return res.redirectAfterPost(...)` is OUTSIDE the try and always runs. So construction throwing (e.g. no managers wired in a bare test process) is caught and the redirect still fires — the test asserts the dispatch path, not tool success.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/crow-accept-bot-invite.test.js`
Expected: FAIL — `accept_bot_invite` is unhandled, so `handlePostAction` returns `false` without redirecting (`calls` empty).

- [ ] **Step 3: Add the action handler**

In `servers/gateway/dashboard/panels/messages/api-handlers.js`, add this block immediately after the `accept_invite` block (after line 130, before `return false;`):

```javascript
  if (action === "accept_bot_invite" && req.body.invite_code) {
    try {
      const client = await getSharingClient();
      await client.callTool({
        name: "crow_accept_bot_invite",
        arguments: { invite_code: req.body.invite_code.trim() },
      });
      await client.close();
    } catch (err) {
      console.error("[messages] Failed to accept bot invite:", err.message);
    }
    return res.redirectAfterPost("/dashboard/messages");
  }
```

- [ ] **Step 4: Run the action test to verify it passes**

Run: `node --test tests/crow-accept-bot-invite.test.js`
Expected: PASS.

- [ ] **Step 5: Render the landing card (CSRF-correct)**

GROUND TRUTH (verified): `buildMessagesHTML(data)` is **synchronous, single-arg** (`html.js:31`). The CSRF middleware is **strict by default** (`csrf.js:45`, `CROW_CSRF_STRICT !== "0"`): any authenticated POST without a matching `_csrf` field 403s. So the landing form MUST carry `csrfInput(req)`, and `csrfInput` needs `req` — which `html.js` does NOT have but `messages.js` DOES. Therefore parse the code and build the CSRF field in `messages.js` (do NOT make `buildMessagesHTML` async).

In `servers/gateway/dashboard/panels/messages.js`:

a) Add the csrf import near the top (with the other imports):

```javascript
import { csrfInput } from "../shared/csrf.js";
```

b) Before the `buildMessagesHTML({...})` call (around line 60), parse the optional landing code:

```javascript
    // Bot-invite landing: a shared link opened on THIS instance (?bot_invite=<code>).
    // Parse here (we have `req`) so the still-sync HTML builder just renders strings.
    let botInvite = null;
    const biCode = (req.query && req.query.bot_invite) || null;
    if (biCode) {
      let botName = null;
      try {
        const { parseBotInviteCode } = await import("../../../sharing/identity.js");
        botName = parseBotInviteCode(biCode).botCrowId;
      } catch { /* malformed/expired: still offer the button; the tool reports the error */ }
      botInvite = { code: biCode, name: botName, csrf: csrfInput(req) };
    }
```

c) Add `botInvite,` to the `buildMessagesHTML({...})` argument object.

In `servers/gateway/dashboard/panels/messages/html.js`:

a) Ensure `escapeHtml` is imported (from `../../shared/components.js`); add the import if absent.

b) Accept `botInvite` in the `buildMessagesHTML(data)` destructure, and build the card (synchronous — no parsing here):

```javascript
  // Bot-invite "Add & message" card (data pre-parsed in messages.js).
  let botInviteCard = "";
  if (botInvite) {
    const name = botInvite.name || "a Crow bot";
    botInviteCard =
      `<div class="msg-bot-invite-card">` +
      `<p><strong>${escapeHtml(name)}</strong> would like to chat with you.</p>` +
      `<form method="POST" action="/dashboard/messages">` +
      `<input type="hidden" name="action" value="accept_bot_invite">` +
      `<input type="hidden" name="invite_code" value="${escapeHtml(botInvite.code)}">` +
      `${botInvite.csrf}` +
      `<button type="submit" class="msg-btn-primary">Add &amp; message</button>` +
      `</form></div>`;
  }
```

c) Concatenate `botInviteCard` at the front of the page content the function returns.

> **Network-exposure invariant (do NOT touch):** `/dashboard/messages` is NOT in `PUBLIC_FUNNEL_PREFIXES` (`servers/gateway/funnel.js`), so the `?bot_invite=` route is automatically 403'd for Tailscale-Funnel requests and stays behind dashboard auth — consistent with CLAUDE.md and the spec (§Landing route). The recipient opens the link on their OWN authenticated Crow. **Do NOT add any path to `funnel.js`** to "fix" perceived reachability; that would open a hole.

- [ ] **Step 6: Verify the gateway starts cleanly**

Run: `node servers/gateway/index.js --no-auth` then Ctrl-C after it prints its listening line.
Expected: starts without throwing (the messages panel module loads).

- [ ] **Step 7: Commit**

```bash
git commit servers/gateway/dashboard/panels/messages/api-handlers.js servers/gateway/dashboard/panels/messages.js servers/gateway/dashboard/panels/messages/html.js tests/crow-accept-bot-invite.test.js \
  -m "feat(crow-messages): recipient accept action + landing card (Plan 2 T4)"
git show --stat HEAD
```

---

## Task 5: Bot Builder editor — Share/manage/Advanced UI

Flip `crow-messages` to available and render the bespoke config block when the type is selected.

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/editor.js`

- [ ] **Step 1: Flip the dropdown entry**

In `editor.js`, in the `gwTypes` array (line 241), change:

```javascript
      { value: "crow-messages", label: "Crow Messages", available: false },
```

to:

```javascript
      { value: "crow-messages", label: "Crow Messages", available: true },
```

(Leave `signal` as `available: false`.)

- [ ] **Step 2: Declare the sibling-block variable**

GROUND TRUTH (verified): the `hidden(tb)` helper (`editor.js:31`) hardcodes the prefix — it renders `name="action" value="save_${tb}"`. So `hidden("gw_share")` would render `value="save_gw_share"`, which the `gw_share` handler never matches (it would fall through to the `save_` tab handler as an unknown tab `gw_share`). **Do NOT use `hidden()` for the gw_* forms.** Emit explicit `<input type="hidden" name="action" value="gw_share">` + a `bot_id` input + `csrfInput(req)`. (`csrfInput` and `req` are already in scope: imported at `editor.js:9`, `req` is the function's first param.)

GROUND TRUTH (verified): HTML forms cannot nest, and the gateways tab injects `gwFields` INSIDE `<form class="btb-form">…</form>` (`editor.js:408-412`). So the gw_* management forms must be rendered as a **sibling block AFTER `</form>`**, not inside `gwFields`. Only the paired-instance checkbox (which the main `save_gateways` form submits) goes in `gwFields`.

In `editor.js` change the gateways-tab declaration at line 251 from:

```javascript
    let gwFields, gwHint;
```

to:

```javascript
    let gwFields, gwHint, gwExtra = ""; // gwExtra renders OUTSIDE the main form (sibling)
```

- [ ] **Step 3: Add the crow-messages render branch**

In the gateways-tab `if (gwType === "discord") … else if …` chain, add a `crow-messages` branch after the `companion` branch and before the final `gmail`/else:

```javascript
    } else if (gwType === "crow-messages") {
      const admin = await import("./crow-messages-admin.js");
      const allowPaired = gw.allow_paired_instances === true;
      let botCrowId = "";
      try { botCrowId = admin.botIdentityFor(botId).crowId; } catch { botCrowId = ""; }

      // Only the toggle belongs in the MAIN save_gateways form.
      const pairedToggle =
        `<div class="btb-group"><label class="btb-checkbox">` +
        `<input type="checkbox" name="gw_allow_paired_instances"${allowPaired ? " checked" : ""}> ` +
        `${escapeHtml(t("botbuilder.cmAllowPaired", lang))}</label></div>`;
      gwFields = pairedToggle;
      gwHint = `<p class="btb-hint">${escapeHtml(t("botbuilder.cmHint", lang))}</p>`;

      // Everything below is its OWN form(s) → must live OUTSIDE the main form.
      // Explicit hidden action inputs (NOT the hidden() helper, which prefixes "save_").
      const actInputs = (act) =>
        `<input type="hidden" name="action" value="${act}">` +
        `<input type="hidden" name="bot_id" value="${escapeHtml(botId)}">${csrfInput(req)}`;

      // Current shareable link (if an active invite exists) + its QR.
      let shareBlock = "";
      try {
        const active = await admin.getActiveInvite(db, botId);
        if (active) {
          const code = await admin.buildInviteCode(db, botId, active.token);
          const link = `/dashboard/messages?bot_invite=${encodeURIComponent(code)}`;
          let qrImg = "";
          try {
            const QRCode = (await import("qrcode")).default;
            const dataUrl = await QRCode.toDataURL(code, { width: 220, margin: 1 });
            qrImg = `<img src="${dataUrl}" alt="Share QR" width="220" height="220" style="image-rendering:pixelated">`;
          } catch { /* qr optional */ }
          shareBlock =
            `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmShareLabel", lang))}</label>` +
            `<p class="btb-hint">${escapeHtml(t("botbuilder.cmShareHint", lang))}</p>` +
            `<textarea class="btb-textarea" rows="3" readonly onclick="this.select()">${escapeHtml(code)}</textarea>` +
            `<p class="btb-hint"><a href="${escapeHtml(link)}">${escapeHtml(t("botbuilder.cmOpenLink", lang))}</a></p>` +
            (qrImg ? `<div style="margin:.5rem 0">${qrImg}</div>` : "") + `</div>`;
        }
      } catch { shareBlock = ""; }

      const shareActions =
        `<div class="btb-group">` +
        `<form method="POST" style="display:inline">${actInputs("gw_share")}` +
        `<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.cmShareBtn", lang))}</button></form> ` +
        `<form method="POST" style="display:inline">${actInputs("gw_newlink")}` +
        `<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.cmNewLinkBtn", lang))}</button></form>` +
        `</div>`;

      // "Who can message" — ACL rows as a name list, each with Remove.
      let aclList = "";
      try {
        const acl = await admin.listAcl(db, botId);
        const items = acl.map((r) => {
          const label = escapeHtml(r.display_name || r.crow_id || r.sender_pubkey.slice(0, 12) + "…");
          return `<li><span>${label}</span> ` +
            `<form method="POST" style="display:inline">${actInputs("gw_remove")}` +
            `<input type="hidden" name="sender_pubkey" value="${escapeHtml(r.sender_pubkey)}">` +
            `<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.cmRemove", lang))}</button></form></li>`;
        }).join("");
        aclList =
          `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmWhoCanMessage", lang))}</label>` +
          (items ? `<ul style="list-style:none;padding-left:0">${items}</ul>`
                 : `<p class="btb-hint">${escapeHtml(t("botbuilder.cmNobodyYet", lang))}</p>`) +
          `</div>`;
      } catch { aclList = ""; }

      const advanced =
        `<details><summary>${escapeHtml(t("botbuilder.cmAdvanced", lang))} &#9656;</summary>` +
        (botCrowId ? `<p class="btb-hint">${escapeHtml(t("botbuilder.cmRawAddress", lang))}: <code>${escapeHtml(botCrowId)}</code></p>` : "") +
        `<form method="POST">${actInputs("gw_advanced_add")}` +
        `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmManualPubkey", lang))}</label>` +
        `<input type="text" name="sender_pubkey" class="btb-input" placeholder="secp256k1 hex (64 or 66)"></div>` +
        `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmManualName", lang))}</label>` +
        `<input type="text" name="display_name" class="btb-input"></div>` +
        `<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.cmManualAdd", lang))}</button></form>` +
        `</details>`;

      gwExtra = `<div class="btb-cm-manage">` + shareBlock + shareActions + aclList + advanced + `</div>`;
```

> All helpers used (`escapeHtml`, `t`, `lang`, `db`, `csrfInput`, `req`) are already in scope in this function. Buttons reuse the existing `btb-btn` class (no new CSS needed).

- [ ] **Step 4: Append the sibling block after the form close**

In `editor.js`, the gateways-tab body assembly (line 407-412) ends with `… + actionBar(...) + \`</form>\``. Change the final line to append `gwExtra` after the form closes:

```javascript
      actionBar(`<button type="submit" class="btb-btn">${t("botbuilder.btnSaveGateways", lang)}</button>`) + `</form>` + gwExtra;
```

(For every other gateway type `gwExtra` is `""`, so this is a no-op there.)

- [ ] **Step 5: Write a render test (proves the action names + CSRF are correct)**

This is the only place that catches the `hidden()` prefix bug — the Task 6 handler tests pass hand-built bodies and would NOT. Create `tests/crow-messages-editor.test.js`:

```javascript
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cm-editor-"));
process.env.CROW_DATA_DIR = dir;

let db = null, renderBotEditor = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity();
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["cm-bot", "CM Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }], tools: {}, models: {} })],
  });
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
});

after(async () => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("gateways tab for crow-messages renders correct action names + csrf, no save_ prefix bug", async () => {
  let html = "";
  const res = { send: (s) => { html = s; } };
  const layout = ({ content }) => content;
  const req = { method: "GET", query: { bot: "cm-bot", tab: "gateways" }, cookies: {}, headers: {} };
  await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "cm-bot", notice: "", q: req.query });
  assert.match(html, /name="action" value="gw_share"/, "Share button posts gw_share");
  assert.match(html, /name="action" value="gw_newlink"/, "New link posts gw_newlink");
  assert.match(html, /name="action" value="gw_advanced_add"/, "Advanced add posts gw_advanced_add");
  assert.ok(!/value="save_gw_/.test(html), "no save_-prefixed gw action (the hidden() bug)");
  assert.match(html, /name="gw_allow_paired_instances"[^>]*checked/, "paired toggle reflects saved true");
  // CSRF: the page must carry a _csrf field for the POST forms.
  assert.match(html, /name="_csrf"/, "csrf field present");
});
```

> The fake `res`/`layout` capture the rendered HTML (`renderBotEditor` ends in `res.send(layout({title, content}))`, `editor.js:888`). `csrfInput(req)` renders a `_csrf` hidden input from the request; with no session cookie it still emits the field.

- [ ] **Step 6: Run the render test**

Run: `node --test tests/crow-messages-editor.test.js`
Expected: PASS. Also confirm the module parses cleanly:
`node -e "import('./servers/gateway/dashboard/panels/bot-builder/editor.js').then(()=>console.log('editor OK')).catch(e=>{console.error(e);process.exit(1)})"`

- [ ] **Step 7: Commit**

```bash
git add tests/crow-messages-editor.test.js
git commit servers/gateway/dashboard/panels/bot-builder/editor.js tests/crow-messages-editor.test.js \
  -m "feat(crow-messages): Bot Builder share/manage/advanced UI (Plan 2 T5)"
git show --stat HEAD
```

---

## Task 6: Bot Builder api-handlers — save branch + gw_* actions

Replace the catch-all "ignore unsupported type" `else` with a real `crow-messages` save (persists the type + paired toggle) and add the `gw_share` / `gw_newlink` / `gw_remove` / `gw_advanced_add` actions.

**Files:**
- Modify: `servers/gateway/dashboard/panels/bot-builder/api-handlers.js`
- Modify: `tests/bot-builder-gateway-draft.test.js` (replace the "NOT persisted" test)

- [ ] **Step 1: Update the regression test (crow-messages is now persisted)**

In `tests/bot-builder-gateway-draft.test.js`, replace the final test (`"a not-yet-available gateway type (crow-messages) is NOT persisted"`, lines 134-150) with:

```javascript
test("crow-messages saves type + allow_paired_instances toggle", async () => {
  let res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "crow-messages", gw_allow_paired_instances: "on" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  let def = await readDef();
  assert.equal(def.gateways[0]?.type, "crow-messages", "type persists");
  assert.equal(def.gateways[0]?.allow_paired_instances, true, "toggle on persists true");

  // Toggle off (checkbox absent in the body).
  res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "crow-messages" } },
    res, { db }
  );
  def = await readDef();
  assert.equal(def.gateways[0]?.allow_paired_instances, false, "absent checkbox persists false");
});

test("gw_share mints an active invite; gw_newlink rotates it", async () => {
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  let res = mkRes();
  await handleBotBuilderPost({ body: { action: "gw_share", bot_id: "draft-bot" } }, res, { db });
  assert.match(res.redirected, /tab=gateways/, "redirects to gateways tab");
  const first = await admin.getActiveInvite(db, "draft-bot");
  assert.ok(first && first.token, "an active invite exists after share");

  res = mkRes();
  await handleBotBuilderPost({ body: { action: "gw_newlink", bot_id: "draft-bot" } }, res, { db });
  const second = await admin.getActiveInvite(db, "draft-bot");
  assert.notEqual(second.token, first.token, "new link rotates the token");
});

test("gw_advanced_add then gw_remove edits the ACL", async () => {
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  const pk = "e".repeat(64);
  let res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "gw_advanced_add", bot_id: "draft-bot", sender_pubkey: pk, display_name: "Bob" } },
    res, { db }
  );
  let acl = await admin.listAcl(db, "draft-bot");
  assert.ok(acl.find((r) => r.sender_pubkey === pk && r.display_name === "Bob"), "manual ACL added");

  res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "gw_remove", bot_id: "draft-bot", sender_pubkey: pk } }, res, { db }
  );
  acl = await admin.listAcl(db, "draft-bot");
  assert.ok(!acl.find((r) => r.sender_pubkey === pk), "ACL row removed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/bot-builder-gateway-draft.test.js`
Expected: FAIL — the crow-messages save still hits the catch-all (type not persisted); `gw_*` actions unhandled (no redirect → `res.redirected` null).

- [ ] **Step 3: Add the save branch**

In `servers/gateway/dashboard/panels/bot-builder/api-handlers.js`, replace the final `else` of the gateways tab (lines 283-290, the "Not-yet-available gateway type" block) with:

```javascript
      } else if (gwType === "crow-messages") {
        // First-class P2P gateway (host adapter from Plan 1). Identity is derived
        // and invites/ACL live in their own tables (edited via gw_* actions); the
        // bot def only carries the type + the allow-paired toggle. This minimal
        // record is a valid host-managed gateway: gateway_runner.mjs:56 iterates
        // def.gateways[], and :89 calls adapter.start({bot_id, gw, log}) with this
        // exact object (the adapter reads gw.allow_paired_instances — Task 2).
        def.gateways = [{
          type: "crow-messages",
          allow_paired_instances: b.gw_allow_paired_instances === "on" || b.gw_allow_paired_instances === "true",
        }];
      } else {
        // Genuinely unsupported / coming-soon type (e.g. "signal"): refuse to
        // persist so the runner can't host a feature with no management UI.
        console.warn(`[bot-builder] ignoring save of unsupported gateway type "${gwType}" for bot ${botId}`);
      }
```

- [ ] **Step 4: Add the gw_* action handlers**

In `api-handlers.js`, add this block **before** the `if (action && action.startsWith("save_"))` block (so these standalone actions are handled first). Insert after the `toggle_peer_managed` handler (after its `return res.redirectAfterPost(...)`, around line 64):

```javascript
  // ---- Crow Messages gateway management actions (Plan 2) ----
  if (action === "gw_share" || action === "gw_newlink" || action === "gw_remove" || action === "gw_advanced_add") {
    const botId = (b.bot_id || "").trim();
    if (!botId) return res.redirectAfterPost("/dashboard/bot-builder");
    const admin = await import("./crow-messages-admin.js");
    try {
      if (action === "gw_share") {
        // Mint only if there isn't already an active link (idempotent Share).
        const active = await admin.getActiveInvite(db, botId);
        if (!active) await admin.mintInvite(db, botId, {});
      } else if (action === "gw_newlink") {
        await admin.rotateInvite(db, botId, {});
      } else if (action === "gw_remove") {
        if (b.sender_pubkey) await admin.removeAcl(db, botId, String(b.sender_pubkey).trim());
      } else if (action === "gw_advanced_add") {
        const pk = (b.sender_pubkey || "").trim();
        if (pk) await admin.addManualAcl(db, botId, pk, null, (b.display_name || "").trim() || null);
      }
    } catch (e) {
      return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=gateways&warn=${encodeURIComponent(e.message)}`);
    }
    return res.redirectAfterPost(`/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=gateways`);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/bot-builder-gateway-draft.test.js`
Expected: PASS (all tests, including the three new ones).

- [ ] **Step 6: Commit**

```bash
git commit servers/gateway/dashboard/panels/bot-builder/api-handlers.js tests/bot-builder-gateway-draft.test.js \
  -m "feat(crow-messages): persist gateway + share/rotate/remove/add actions (Plan 2 T6)"
git show --stat HEAD
```

---

## Task 7: Registry label + i18n strings

**Files:**
- Modify: `scripts/pi-bots/gateways/index.mjs`
- Modify: `servers/gateway/dashboard/shared/i18n.js`

- [ ] **Step 1: Proper label in capabilitiesForUI**

In `scripts/pi-bots/gateways/index.mjs`, the `capabilitiesForUI()` loop labels host adapters by capitalizing the type — `crow-messages` → "Crow-messages" (ugly). Add a label override map. Replace the `capabilitiesForUI` function (lines 78-84) with:

```javascript
const LABEL_OVERRIDES = { "crow-messages": "Crow Messages" };

export function capabilitiesForUI() {
  const out = [STATIC_META.gmail, STATIC_META.discord];
  for (const a of HOST_ADAPTERS) {
    const label = LABEL_OVERRIDES[a.type] || (a.type.charAt(0).toUpperCase() + a.type.slice(1));
    out.push({ type: a.type, mode: a.mode, label, configFields: a.configFields || [] });
  }
  return out;
}
```

- [ ] **Step 2: Add i18n keys**

In `servers/gateway/dashboard/shared/i18n.js`, add these entries to the dictionary (alongside the other `botbuilder.*` keys; any location within the dictionary object is fine):

```javascript
  "botbuilder.cmHint": { en: "People you share access with can chat with this bot over Crow Messages. The bot answers as itself.", es: "Las personas con quienes compartas el acceso podrán chatear con este bot por Crow Messages. El bot responde como tal." },
  "botbuilder.cmShareLabel": { en: "Share access", es: "Compartir acceso" },
  "botbuilder.cmShareHint": { en: "Send this to anyone you want to let chat with this bot.", es: "Envía esto a quien quieras que pueda chatear con este bot." },
  "botbuilder.cmOpenLink": { en: "Open invite on this device", es: "Abrir invitación en este dispositivo" },
  "botbuilder.cmShareBtn": { en: "Share access", es: "Compartir acceso" },
  "botbuilder.cmNewLinkBtn": { en: "New link", es: "Nuevo enlace" },
  "botbuilder.cmWhoCanMessage": { en: "Who can message this bot", es: "Quién puede escribir a este bot" },
  "botbuilder.cmNobodyYet": { en: "Nobody yet. Share access to add people.", es: "Nadie todavía. Comparte el acceso para añadir personas." },
  "botbuilder.cmRemove": { en: "Remove", es: "Quitar" },
  "botbuilder.cmAllowPaired": { en: "Allow my other Crow devices", es: "Permitir mis otros dispositivos Crow" },
  "botbuilder.cmAdvanced": { en: "Advanced", es: "Avanzado" },
  "botbuilder.cmRawAddress": { en: "Bot address", es: "Dirección del bot" },
  "botbuilder.cmManualPubkey": { en: "Add by public key", es: "Añadir por clave pública" },
  "botbuilder.cmManualName": { en: "Name (optional)", es: "Nombre (opcional)" },
  "botbuilder.cmManualAdd": { en: "Add", es: "Añadir" },
```

- [ ] **Step 3: Verify both modules parse**

Run: `node -e "import('./scripts/pi-bots/gateways/index.mjs').then(m=>{const c=m.capabilitiesForUI().find(x=>x.type==='crow-messages');if(c.label!=='Crow Messages')throw new Error('label='+c.label);console.log('label OK')}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `label OK`.

Run: `node -e "import('./servers/gateway/dashboard/shared/i18n.js').then(m=>{if(m.t('botbuilder.cmShareBtn','es')!=='Compartir acceso')throw new Error('es missing');console.log('i18n OK')}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `i18n OK`.

- [ ] **Step 4: Commit**

```bash
git commit scripts/pi-bots/gateways/index.mjs servers/gateway/dashboard/shared/i18n.js \
  -m "feat(crow-messages): registry label + EN/ES i18n strings (Plan 2 T7)"
git show --stat HEAD
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the full crow-messages + bot-builder + sharing test set**

Run:
```bash
node --test tests/crow-messages-admin.test.js tests/crow-messages-store.test.js \
  tests/crow-messages-adapter.test.js tests/crow-messages-integration.test.js \
  tests/crow-bot-identity.test.js tests/crow-accept-bot-invite.test.js \
  tests/crow-messages-editor.test.js tests/bot-builder-gateway-draft.test.js
```
Expected: all pass.

- [ ] **Step 2: Run the whole suite for regressions**

Run: `for f in tests/*.test.js; do node --test "$f" || echo "FAIL: $f"; done 2>&1 | tail -40`
Expected: no `FAIL:` lines. (If a pre-existing unrelated failure shows, confirm it also fails on `1acf9a6` before treating it as a regression.)

- [ ] **Step 3: Start the gateway and load the Bot Builder gateways tab manually**

Run: `node servers/gateway/index.js --no-auth` (background or separate shell). Visit `/dashboard/bot-builder?bot=<some-bot>&tab=gateways`, switch the type to **Crow Messages**, confirm: the dropdown is selectable (not "coming soon"), the "Share access" button mints a link + QR, "New link" rotates it, an added person shows under "Who can message" with Remove, and the Advanced section shows the bot's `crow:` address. Ctrl-C to stop.
Expected: all controls work; no server errors in the log.

- [ ] **Step 4: Self-review against the spec** (run the writing-plans self-review checklist mentally; the spec's §Testing items map to T1–T6).

---

## Spec coverage map

| Spec requirement | Task |
|---|---|
| Owner UI: Share link + QR | T5 (render), T6 (`gw_share`), T1 (`buildInviteCode`) |
| Owner UI: New link (rotate) | T5, T6 (`gw_newlink`), T1 (`rotateInvite`) |
| Owner UI: Who can message + Remove | T5, T6 (`gw_remove`), T1 (`listAcl`/`removeAcl`) |
| Owner UI: Allow my other Crow devices | T2 (auth), T5 (toggle), T6 (save) |
| Owner UI: Advanced (raw address, manual add) | T5, T6 (`gw_advanced_add`), T1 (`addManualAcl`) |
| Recipient one-tap accept | T3 (`crow_accept_bot_invite`), T4 (action + landing) |
| Adapter consumes accept (already built P1) | — (T3 sends the DM the P1 adapter already handles) |
| `allow_paired_instances` (deferred from P1) | T2 |
| `available:true` + persist gateway | T5, T6 |
| capabilitiesForUI / label | T7 |
| i18n EN/ES | T7 |

## Out of scope (per spec — do NOT build)

Roster auto-advertise; cross-instance bot directory/picker; group threads; writing bot turns into the personal `messages` table; auto-rotating derived keys.

## After all tasks pass

Run `superpowers:finishing-a-development-branch`, then `/security-review` (focus: the UI write path on ACL/invites and the recipient accept path), then deploy per the handoff's deploy cheat-sheet (each host: `git pull --rebase` → `node scripts/init-db.js` → restart gateways + `pibot-gateways`). Decide with the operator whether to push Plan 1 + Plan 2 together or Plan 1 first (local main is ahead of origin by the Plan-1 merge).

---

## Review

**Reviewer:** adversarial staff-engineer subagent (Plan agent). **Date:** 2026-06-16. **Initial verdict:** REVISE. All issues resolved in-plan before execution; re-verified each claim against the codebase.

| ID | Issue | Resolution |
|---|---|---|
| C1 | `hidden()` helper (`editor.js:31`) hardcodes the `save_` prefix → `hidden("gw_share")` renders `value="save_gw_share"`, which the `gw_share` handler never matches; the whole owner UI silently no-ops. Handler tests (hand-built bodies) wouldn't catch it. | Task 5 now uses an explicit `actInputs(act)` helper emitting `name="action" value="gw_share"` + `bot_id` + `csrfInput(req)` — never `hidden()`. Added `tests/crow-messages-editor.test.js` (render test) asserting the correct action names AND that no `save_gw_` prefix appears. |
| C2 | Landing-card form had no `_csrf` field and `buildMessagesHTML` (verified sync, single-arg, no `req`) can't call `csrfInput`. Strict CSRF is the default (`csrf.js:45`) → the "Add & message" button 403s. The action test bypasses middleware (false confidence). | Task 4 now parses the code AND builds `csrfInput(req)` in `messages.js` (which has `req`), passing `{code,name,csrf}` into the still-sync builder; the card embeds the csrf field. Builder stays sync. |
| C3 | Paired-instance JOIN matched `IN (pk, "02"+pk)` — but `contacts.secp256k1_pubkey` is the 66-hex COMPRESSED key (`identity.js:170`), so every `03`-parity contact (~half) is silently denied. Test used an unrealistic 64-hex contact key. | SQL changed to `substr(c.secp256k1_pubkey,-64)=?` (matches both parities). Task 2 test now inserts realistic 66-hex contacts including a `03`-prefixed case and asserts both pass. |
| S1 | gw_* `<form>`s were concatenated into `gwFields`, which renders INSIDE the main `<form class="btb-form">` (`editor.js:408-412`) — invalid nested forms. | Task 5 introduces `gwExtra` rendered as a sibling AFTER `</form>`; only the paired-toggle checkbox stays in `gwFields` (it's submitted by the main form). |
| S5 | Confirm the landing route doesn't breach the funnel invariant. | Verified `/dashboard/messages` is not in `PUBLIC_FUNNEL_PREFIXES` → auto-403 under Funnel. Plan adds an explicit "do NOT touch `funnel.js`" instruction. |
| S6 | The new accept tool adds a kiosk guard the legacy one lacks. | Documented as intentional divergence in Task 3. |
| Q1 | Highest risk: deriving via `loadOrCreateIdentity()` reads `resolveDataDir()`, but the gateway anchors on `CROW_DB_PATH`; a mismatch → the editor embeds a key the adapter never subscribes under (dead invites). | `botIdentityFor` now derives via `loadInstanceSeed(dirname(botsDbPath()))` — the SAME anchor as the adapter (`crow-messages.mjs:75`), guaranteeing crow_id parity. Added a parity test asserting admin-derived == adapter-derived crow_id. |
| Q2 | `loadOrCreateIdentity()` WRITES `identity.json` as a side effect of a GET render on a fresh instance. | Resolved by Q1's fix: `loadInstanceSeed` is read-only (throws if absent; editor catches → shows no address). |
| Q3 | The accept action test hits the real `createSharingServer()`. | Confirmed the redirect is OUTSIDE the handler's try/catch, so construction throwing is caught and the redirect still fires; noted in Task 4. |
| Q4 | Confirm a minimal `{type:"crow-messages"}` record is a valid host-managed gateway. | Verified `gateway_runner.mjs:56` iterates `def.gateways[]` and `:89` calls `adapter.start({bot_id, gw, log})`; noted inline in Task 6. |

**Final status:** REVISE issues all addressed; plan ready for execution.
