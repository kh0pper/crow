# Crow Messages Gateway — Plan 1: Foundation + Transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Crow bot receivable and replyable over Crow Messages (Nostr DM) under its own derived identity, with default-deny per-bot authorization — testable end-to-end with a mock relay and a manually-authorized sender.

**Architecture:** A pi-bots host adapter (`scripts/pi-bots/gateways/crow-messages.mjs`, hosted by `gateway_runner` like Telegram/Slack) derives the bot's Nostr keypair from the instance seed, subscribes for the bot's pubkey, decrypts inbound DMs, authorizes the sender against a per-bot ACL (+ optional "any paired instance"), and drives the real pi bridge (`handleInbound`) so the bot answers as itself; replies are published from the bot key. A small Nostr-client helper and a better-sqlite3 ACL/invite store back it. This plan is the **transport layer**; Plan 2 adds the Bot Builder sharing UI + the recipient one-tap accept flow.

**Tech Stack:** Node.js ESM, `node --test`, `nostr-tools` (`/pure`, `/nip44`, `/relay`), `@noble/*` (hkdf/ed25519/secp256k1, already used by `identity.js`), better-sqlite3 (pi-bots host), libsql (schema via `init-db.js`).

**Spec:** `docs/superpowers/specs/2026-06-15-crow-messages-gateway-design.md`.

---

## Shared conventions (apply to every task)

- **Pubkey normalization:** Nostr uses x-only 64-hex pubkeys; `identity.js` derives **compressed 66-hex** secp keys (02/03 prefix). Always store/compare the **x-only 64-hex** form. Helper `xOnly(hex)` (Task 4) strips a 66-char key to its last 64 chars; a 64-char key passes through.
- **Tests:** `node --test tests/<file>.test.js`. Keep each `crow-messages-*.test.js` a separate file. `CROW_DB_PATH`/`CROW_DATA_DIR` must be unset in the shell (tests set their own temp dirs).
- **Commits:** positional-path `git commit <paths> -m "…"`; new files need `git add <path>` first; `git show --stat HEAD` after each.

## File structure

- Modify `servers/sharing/identity.js` — add `deriveBotIdentity`, `generateBotInviteCode`, `parseBotInviteCode` (pure, exported).
- Modify `scripts/init-db.js` — add `bot_message_acl`, `bot_message_invites` tables.
- Create `scripts/pi-bots/gateways/nostr-client.mjs` — pure DM crypto (`xOnly`, `buildDM`, `openDM`) + thin relay wrappers (`connectRelays`, `subscribe`, `publish`).
- Create `scripts/pi-bots/gateways/crow-messages-store.mjs` — better-sqlite3 helpers: `resolveRelays`, `authorizeSender`, `consumeInvite`, `upsertAclFromAccept`.
- Create `scripts/pi-bots/gateways/crow-messages.mjs` — the adapter: `handleCrowMessageEvent` (testable core) + `start`/`stop`/`checkRequirements`/`gatewayHint`/`configFields`.
- Modify `scripts/pi-bots/gateways/index.mjs` — register the adapter in `HOST_ADAPTERS`.
- Tests: `tests/crow-bot-identity.test.js`, `tests/crow-messages-store.test.js`, `tests/crow-messages-adapter.test.js`, `tests/crow-messages-integration.test.js`.

---

## Task 1: Per-bot derived identity

**Files:**
- Modify: `servers/sharing/identity.js`
- Test: `tests/crow-bot-identity.test.js`

- [ ] **Step 1: Write the failing test** — create `tests/crow-bot-identity.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBotIdentity } from "../servers/sharing/identity.js";

const SEED = Buffer.alloc(32, 7); // fixed, deterministic

test("deriveBotIdentity is deterministic and bot-distinct", () => {
  const a1 = deriveBotIdentity(SEED, "bot-alpha");
  const a2 = deriveBotIdentity(SEED, "bot-alpha");
  const b = deriveBotIdentity(SEED, "bot-beta");
  assert.equal(a1.crowId, a2.crowId);
  assert.equal(a1.secp256k1Pubkey, a2.secp256k1Pubkey);
  assert.notEqual(a1.crowId, b.crowId);
  assert.notEqual(a1.secp256k1Pubkey, b.secp256k1Pubkey);
});

test("deriveBotIdentity shape: crow: id, hex keys, compressed secp (66 hex)", () => {
  const id = deriveBotIdentity(SEED, "bot-alpha");
  assert.match(id.crowId, /^crow:[0-9a-z]{10}$/);
  assert.equal(id.secp256k1Pubkey.length, 66);
  assert.equal(id.ed25519Pubkey.length, 64);
  assert.ok(Buffer.isBuffer(id.secp256k1Priv));
});

test("deriveBotIdentity requires seed + botId", () => {
  assert.throws(() => deriveBotIdentity(null, "x"));
  assert.throws(() => deriveBotIdentity(SEED, ""));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-bot-identity.test.js`
Expected: FAIL — `deriveBotIdentity` is not exported.

- [ ] **Step 3: Add `deriveBotIdentity` to `servers/sharing/identity.js`**

Insert after `deriveIdentity` (after line 184, before `generateInviteCode`). It reuses the file-private `deriveKey`, `ed`, `secp`, and `computeCrowId` (all in scope):

```js
/**
 * Derive a per-bot identity from the instance seed. Pure + deterministic:
 * same (seed, botId) → same keys/crow_id. Namespaced so a bot key is
 * independent of the instance identity and of other bots. Nothing stored.
 */
export function deriveBotIdentity(seed, botId) {
  if (!seed || !botId || typeof botId !== "string") {
    throw new Error("deriveBotIdentity requires (seed, botId)");
  }
  const ns = "crow-bot-v1:" + botId;
  const ed25519Priv = deriveKey(seed, ns + "|ed25519", 32);
  const ed25519Pub = ed.getPublicKey(ed25519Priv);
  const secp256k1Priv = deriveKey(seed, ns + "|secp256k1", 32);
  const secp256k1Pub = secp.getPublicKey(secp256k1Priv); // compressed (33 bytes)
  const crowId = computeCrowId(ed25519Pub);
  return {
    crowId,
    botId,
    ed25519Priv: Buffer.from(ed25519Priv),
    ed25519Pub: Buffer.from(ed25519Pub),
    ed25519Pubkey: Buffer.from(ed25519Pub).toString("hex"),
    secp256k1Priv: Buffer.from(secp256k1Priv),
    secp256k1Pub: Buffer.from(secp256k1Pub),
    secp256k1Pubkey: Buffer.from(secp256k1Pub).toString("hex"),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/crow-bot-identity.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/crow-bot-identity.test.js
git commit servers/sharing/identity.js tests/crow-bot-identity.test.js -m "feat(crow-messages): derive per-bot Nostr identity from instance seed"
git show --stat HEAD
```

---

## Task 2: Data model (`bot_message_acl`, `bot_message_invites`)

**Files:**
- Modify: `scripts/init-db.js`
- Test: `tests/crow-messages-store.test.js` (schema assertion lives with the store tests; shared init-db harness)

- [ ] **Step 1: Write the failing test** — create `tests/crow-messages-store.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";

let dir, db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "crowmsg-store-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("bot_message_acl + bot_message_invites tables exist with expected columns", async () => {
  const acl = (await db.execute("PRAGMA table_info(bot_message_acl)")).rows.map(r => r.name);
  for (const c of ["id","bot_id","sender_pubkey","crow_id","display_name","added_via","created_at"]) {
    assert.ok(acl.includes(c), "acl missing " + c);
  }
  const inv = (await db.execute("PRAGMA table_info(bot_message_invites)")).rows.map(r => r.name);
  for (const c of ["id","bot_id","token","expires_at","max_uses","uses","revoked","created_at"]) {
    assert.ok(inv.includes(c), "invites missing " + c);
  }
  const aclIdx = (await db.execute("PRAGMA index_list(bot_message_acl)")).rows.some(r => Number(r.unique) === 1);
  assert.ok(aclIdx, "expected UNIQUE(bot_id,sender_pubkey)");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-messages-store.test.js`
Expected: FAIL — `PRAGMA table_info` returns no columns; "acl missing id".

- [ ] **Step 3: Add the tables to `scripts/init-db.js`**

Insert immediately after the `fix_it_items` `initTable(...)` block (added 2026-06-15), using the same `initTable` wrapper:

```js
// --- Crow Messages gateway (2026-06-15): per-bot inbound authorization + invite
// tokens. LOCAL-ONLY (operational state, never synced). ACL is keyed on the
// x-only secp256k1 pubkey (verifiable from a signed inbound DM). ---
await initTable("bot_message_acl table", `
  CREATE TABLE IF NOT EXISTS bot_message_acl (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id        TEXT NOT NULL,
    sender_pubkey TEXT NOT NULL,
    crow_id       TEXT,
    display_name  TEXT,
    added_via     TEXT NOT NULL DEFAULT 'invite'
                    CHECK (added_via IN ('invite','manual')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bot_id, sender_pubkey)
  );
  CREATE INDEX IF NOT EXISTS idx_bot_message_acl_bot ON bot_message_acl(bot_id);
`);
await initTable("bot_message_invites table", `
  CREATE TABLE IF NOT EXISTS bot_message_invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TEXT,
    max_uses    INTEGER,
    uses        INTEGER NOT NULL DEFAULT 0,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bot_message_invites_bot ON bot_message_invites(bot_id);
`);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/crow-messages-store.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add tests/crow-messages-store.test.js
git commit scripts/init-db.js tests/crow-messages-store.test.js -m "feat(crow-messages): bot_message_acl + bot_message_invites tables"
git show --stat HEAD
```

---

## Task 3: Bot invite codec

**Files:**
- Modify: `servers/sharing/identity.js`
- Test: `tests/crow-bot-identity.test.js` (extend Task 1's file)

Mirrors `generateInviteCode`/`parseInviteCode` (`identity.js:191-241`) but encodes a **bot** address + an authorization **token** + relay hints. `parseBotInviteCode` validates the embedded `crow_id` matches the embedded ed25519 pubkey (same integrity check `parseInviteCode` uses), so the recipient is guaranteed to address the correct bot key; the token is what the bot later authorizes against.

- [ ] **Step 1: Write the failing tests** (append to `tests/crow-bot-identity.test.js`)

```js
import { generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";

test("bot invite code round-trips address + token + relays", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const code = generateBotInviteCode(bot, "tok-123", ["wss://relay.example"]);
  const parsed = parseBotInviteCode(code);
  assert.equal(parsed.botCrowId, bot.crowId);
  assert.equal(parsed.ed25519Pubkey, bot.ed25519Pubkey);
  assert.equal(parsed.secp256k1Pubkey, bot.secp256k1Pubkey);
  assert.equal(parsed.token, "tok-123");
  assert.deepEqual(parsed.relays, ["wss://relay.example"]);
});

test("parseBotInviteCode rejects a tampered crow_id", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const other = deriveBotIdentity(SEED, "bot-beta");
  const code = generateBotInviteCode(bot, "tok-123");
  // Splice another bot's crow_id onto the front → integrity check must fail.
  const parts = code.split(".");
  const bad = [other.crowId, parts[1], parts[2]].join(".");
  assert.throws(() => parseBotInviteCode(bad), /mismatch|match/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-bot-identity.test.js`
Expected: FAIL — `generateBotInviteCode` not exported.

- [ ] **Step 3: Add the codec to `servers/sharing/identity.js`** (after `deriveBotIdentity`):

```js
/**
 * Encode a bot invite: `<botCrowId>.<base64url(payload)>.<hmac>`. Payload carries
 * the bot address (keys) + an authorization token + relay hints. HMAC mirrors
 * generateInviteCode (tamper-evidence for the issuer; recipients validate by the
 * crowId↔ed25519 check in parseBotInviteCode).
 */
export function generateBotInviteCode(botIdentity, token, relays = []) {
  const payload = Buffer.from(JSON.stringify({
    crowId: botIdentity.crowId,
    ed25519Pub: botIdentity.ed25519Pubkey,
    secp256k1Pub: botIdentity.secp256k1Pubkey,
    token,
    relays,
    v: 1,
  })).toString("base64url");
  const hmac = createHmac("sha256", botIdentity.ed25519Priv).update(payload).digest("base64url");
  return `${botIdentity.crowId}.${payload}.${hmac}`;
}

/**
 * Decode + validate a bot invite. Throws on malformed input or a crow_id that
 * does not match the embedded ed25519 pubkey.
 */
export function parseBotInviteCode(code) {
  const parts = String(code).split(".");
  if (parts.length !== 3) throw new Error("Invalid bot invite code format");
  const [crowIdPart, payload] = parts;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (data.crowId !== crowIdPart) throw new Error("Bot invite Crow ID mismatch");
  const expected = computeCrowId(Buffer.from(data.ed25519Pub, "hex"));
  if (expected !== data.crowId) throw new Error("Bot invite public key does not match Crow ID");
  return {
    botCrowId: data.crowId,
    ed25519Pubkey: data.ed25519Pub,
    secp256k1Pubkey: data.secp256k1Pub,
    token: data.token,
    relays: Array.isArray(data.relays) ? data.relays : [],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/crow-bot-identity.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/identity.js tests/crow-bot-identity.test.js -m "feat(crow-messages): bot invite codec (generate/parse)"
git show --stat HEAD
```

---

## Task 4: Nostr-client helper (pure DM crypto + relay wrappers)

**Files:**
- Create: `scripts/pi-bots/gateways/nostr-client.mjs`
- Test: `tests/crow-messages-adapter.test.js` (the pure crypto round-trip; adapter tests share this file)

`buildDM`/`openDM` are pure (NIP-44 + kind:4) and unit-tested. `connectRelays`/`subscribe`/`publish` are thin `nostr-tools/relay` wrappers, exercised by the integration task via injected stubs (no real relay in unit tests).

- [ ] **Step 1: Write the failing test** — create `tests/crow-messages-adapter.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBotIdentity } from "../servers/sharing/identity.js";
import { xOnly, buildDM, openDM } from "../scripts/pi-bots/gateways/nostr-client.mjs";

const SEED = Buffer.alloc(32, 9);

test("xOnly strips a compressed (66) key to 64, passes 64 through", () => {
  assert.equal(xOnly("02" + "a".repeat(64)).length, 64);
  assert.equal(xOnly("a".repeat(64)), "a".repeat(64));
});

test("buildDM → openDM round-trips between two derived identities", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const sender = deriveBotIdentity(SEED, "sender-x");
  // sender → bot
  const ev = buildDM(sender.secp256k1Priv, xOnly(bot.secp256k1Pubkey), "hello bot");
  assert.equal(ev.kind, 4);
  assert.ok(ev.tags.some(t => t[0] === "p" && t[1] === xOnly(bot.secp256k1Pubkey)));
  // bot decrypts using sender's pubkey (event.pubkey)
  const text = openDM(bot.secp256k1Priv, ev.pubkey, ev.content);
  assert.equal(text, "hello bot");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/pi-bots/gateways/nostr-client.mjs`**

```js
/**
 * Minimal Nostr DM client for the pi-bots crow-messages adapter. Mirrors the
 * NIP-44 / kind:4 conventions in servers/sharing/nostr.js but stands alone in
 * the pi-bots host process. Pure helpers (xOnly/buildDM/openDM) are unit-tested;
 * the relay wrappers are thin and exercised via injected stubs in integration.
 */
import { finalizeEvent } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { Relay } from "nostr-tools/relay";

/** Normalize any secp pubkey hex to Nostr x-only 64-hex (strip 02/03 prefix). */
export function xOnly(hex) {
  const h = String(hex || "");
  return h.length === 66 ? h.slice(2) : h;
}

/** Build a signed kind:4 NIP-44 DM from senderPriv to recipient (x-only hex). */
export function buildDM(senderPriv, recipientXOnlyPubkey, content) {
  const ck = nip44.v2.utils.getConversationKey(senderPriv, recipientXOnlyPubkey);
  const encrypted = nip44.v2.encrypt(content, ck);
  return finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientXOnlyPubkey]],
    content: encrypted,
  }, senderPriv);
}

/** Decrypt a kind:4 NIP-44 DM addressed to us, given the sender's x-only pubkey. */
export function openDM(recipientPriv, senderXOnlyPubkey, content) {
  const ck = nip44.v2.utils.getConversationKey(recipientPriv, xOnly(senderXOnlyPubkey));
  return nip44.v2.decrypt(content, ck);
}

/** Connect to relays; returns a Map<url, Relay> of those that connected. */
export async function connectRelays(urls, timeoutMs = 10000) {
  const relays = new Map();
  const results = await Promise.allSettled(urls.map(async (url) => {
    const relay = await Promise.race([
      Relay.connect(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error("connection timeout")), timeoutMs)),
    ]);
    return { url, relay };
  }));
  for (const r of results) if (r.status === "fulfilled") relays.set(r.value.url, r.value.relay);
  return relays;
}

/** Subscribe a filter across all relays; returns an array of sub handles. */
export function subscribe(relays, filter, onevent) {
  const subs = [];
  for (const [, relay] of relays) {
    try { subs.push(relay.subscribe([filter], { onevent })); } catch { /* per-relay */ }
  }
  return subs;
}

/** Publish an event to all relays (best-effort). */
export async function publish(relays, event) {
  for (const [, relay] of relays) { try { await relay.publish(event); } catch { /* per-relay */ } }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/gateways/nostr-client.mjs tests/crow-messages-adapter.test.js
git commit scripts/pi-bots/gateways/nostr-client.mjs tests/crow-messages-adapter.test.js -m "feat(crow-messages): standalone Nostr DM client helper"
git show --stat HEAD
```

---

## Task 5: ACL / invite store (better-sqlite3)

**Files:**
- Create: `scripts/pi-bots/gateways/crow-messages-store.mjs`
- Test: `tests/crow-messages-store.test.js` (extend Task 2's file)

Runs in the pi-bots host (better-sqlite3, sync). Pubkeys stored/compared as x-only 64-hex.

- [ ] **Step 1: Write the failing tests** (append to `tests/crow-messages-store.test.js`)

```js
import Database from "better-sqlite3";
import * as cmStore from "../scripts/pi-bots/gateways/crow-messages-store.mjs";

function bdb() { return new Database(join(dir, "crow.db")); } // same file init-db built

test("upsertAclFromAccept + authorizeSender (default-deny)", async () => {
  const d = bdb();
  try {
    const pk = "a".repeat(64);
    assert.equal(cmStore.authorizeSender(d, "bot1", pk, false), false, "deny before add");
    cmStore.upsertAclFromAccept(d, "bot1", pk, "crow:zzz", "Alice");
    assert.equal(cmStore.authorizeSender(d, "bot1", pk, false), true, "allow after add");
    assert.equal(cmStore.authorizeSender(d, "bot1", "b".repeat(64), false), false, "other sender denied");
    // x-only normalization: a 66-hex compressed form authorizes the stored 64-hex
    assert.equal(cmStore.authorizeSender(d, "bot1", "02" + pk, false), true, "compressed key normalized");
  } finally { d.close(); }
});

test("consumeInvite validates token, respects max_uses + revoked + expiry", async () => {
  const d = bdb();
  try {
    d.prepare("INSERT INTO bot_message_invites (bot_id, token, max_uses, uses) VALUES (?,?,?,0)").run("bot1", "tok-A", 1);
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-A"), true, "first use ok");
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-A"), false, "exhausted");
    assert.equal(cmStore.consumeInvite(d, "bot1", "nope"), false, "unknown token");
    d.prepare("INSERT INTO bot_message_invites (bot_id, token, revoked) VALUES (?,?,1)").run("bot1", "tok-R");
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-R"), false, "revoked");
    d.prepare("INSERT INTO bot_message_invites (bot_id, token, expires_at) VALUES (?,?,datetime('now','-1 day'))").run("bot1", "tok-E");
    assert.equal(cmStore.consumeInvite(d, "bot1", "tok-E"), false, "expired");
  } finally { d.close(); }
});

test("authorizeSender honors allow_paired_instances via crow_instances", async () => {
  const d = bdb();
  try {
    const pk = "c".repeat(64);
    d.prepare("INSERT INTO crow_instances (id, crow_id, secp256k1_pubkey, status, created_at, updated_at) VALUES (?,?,?, 'active', datetime('now'), datetime('now'))")
      .run("inst-1", "crow:peer", "02" + pk); // stored compressed
    assert.equal(cmStore.authorizeSender(d, "bot1", pk, false), false, "off → deny");
    assert.equal(cmStore.authorizeSender(d, "bot1", pk, true), true, "on → paired instance allowed");
  } finally { d.close(); }
});
```

(If `crow_instances` lacks a `secp256k1_pubkey` column on this schema, the third test documents the dependency — verify the column exists in `scripts/init-db.js` `crow_instances`; the adapter's paired-instance match relies on it.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-messages-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/pi-bots/gateways/crow-messages-store.mjs`**

```js
/**
 * Crow Messages gateway store — per-bot authorization + invite tokens, for the
 * pi-bots host (better-sqlite3, synchronous). Pubkeys are x-only 64-hex.
 */
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

function xOnly(hex) { const h = String(hex || ""); return h.length === 66 ? h.slice(2) : h; }

/** Resolve the instance's configured Nostr relays (mirror nostr.js), else default. */
export function resolveRelays(db) {
  try {
    const rows = db.prepare("SELECT relay_url FROM relay_config WHERE relay_type='nostr' AND enabled=1").all();
    if (rows.length) return rows.map((r) => r.relay_url);
  } catch { /* table may be absent */ }
  return DEFAULT_RELAYS;
}

/** True if senderPubkey is allowed to message botId. */
export function authorizeSender(db, botId, senderPubkey, allowPaired) {
  const pk = xOnly(senderPubkey);
  const acl = db.prepare("SELECT 1 FROM bot_message_acl WHERE bot_id=? AND sender_pubkey=? LIMIT 1").get(botId, pk);
  if (acl) return true;
  if (allowPaired) {
    // crow_instances stores compressed (66) secp keys; compare on x-only.
    const rows = db.prepare("SELECT secp256k1_pubkey FROM crow_instances WHERE status='active'").all();
    for (const r of rows) if (xOnly(r.secp256k1_pubkey) === pk) return true;
  }
  return false;
}

/** Validate + consume an invite token (atomic-ish: check then bump uses). */
export function consumeInvite(db, botId, token) {
  const row = db.prepare("SELECT id, max_uses, uses, revoked, expires_at FROM bot_message_invites WHERE bot_id=? AND token=?").get(botId, token);
  if (!row) return false;
  if (Number(row.revoked) === 1) return false;
  if (row.expires_at) {
    const exp = db.prepare("SELECT (datetime('now') > ?) AS expired").get(row.expires_at);
    if (Number(exp.expired) === 1) return false;
  }
  if (row.max_uses != null && Number(row.uses) >= Number(row.max_uses)) return false;
  db.prepare("UPDATE bot_message_invites SET uses = uses + 1 WHERE id=?").run(row.id);
  return true;
}

/** Add/refresh an authorized sender from an accepted invite. */
export function upsertAclFromAccept(db, botId, senderPubkey, crowId, displayName) {
  const pk = xOnly(senderPubkey);
  db.prepare(`INSERT INTO bot_message_acl (bot_id, sender_pubkey, crow_id, display_name, added_via)
              VALUES (?,?,?,?, 'invite')
              ON CONFLICT(bot_id, sender_pubkey) DO UPDATE SET
                crow_id=excluded.crow_id, display_name=excluded.display_name`)
    .run(botId, pk, crowId || null, displayName || null);
}

export { xOnly, DEFAULT_RELAYS };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/crow-messages-store.test.js`
Expected: PASS (4 tests total). If the paired-instance test errors on a missing `secp256k1_pubkey` column, confirm `crow_instances` defines it in `scripts/init-db.js` and adjust the seed insert columns to match the real schema.

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/gateways/crow-messages-store.mjs
git commit scripts/pi-bots/gateways/crow-messages-store.mjs tests/crow-messages-store.test.js -m "feat(crow-messages): better-sqlite3 ACL/invite store"
git show --stat HEAD
```

---

## Task 6: The adapter (testable core + host wiring)

**Files:**
- Create: `scripts/pi-bots/gateways/crow-messages.mjs`
- Test: `tests/crow-messages-adapter.test.js` (extend Task 4's file)

The routing/authorization/turn core is `handleCrowMessageEvent`, dependency-injected so it's unit-testable without relays or pi. `start()` wires the real subscription to it.

- [ ] **Step 1: Write the failing tests** (append to `tests/crow-messages-adapter.test.js`)

```js
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { handleCrowMessageEvent } from "../scripts/pi-bots/gateways/crow-messages.mjs";
import * as cmStore from "../scripts/pi-bots/gateways/crow-messages-store.mjs";

function freshDb() {
  const d = mkdtempSync(join(tmpdir(), "crowmsg-adapter-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  return { dir: d, db: new Database(join(d, "crow.db")) };
}

test("invite-accept event authorizes the sender, runs no pi turn", async () => {
  const { dir, db } = freshDb();
  try {
    db.prepare("INSERT INTO bot_message_invites (bot_id, token) VALUES (?,?)").run("bot1", "tok-1");
    let turns = 0;
    const sent = [];
    await handleCrowMessageEvent({
      botId: "bot1", senderPubkey: "a".repeat(64),
      decrypted: JSON.stringify({ type: "crow_social", subtype: "bot_invite_accept", token: "tok-1", sender: { crow_id: "crow:s", secp256k1Pub: "a".repeat(64), display_name: "Sam" } }),
      db, allowPaired: false,
      handleInbound: async () => { turns++; return { action: "done" }; },
      sendDM: async (pk, text) => sent.push([pk, text]),
      log: () => {},
    });
    assert.equal(turns, 0, "no pi turn on accept");
    assert.equal(cmStore.authorizeSender(db, "bot1", "a".repeat(64), false), true, "now authorized");
    assert.equal(sent.length, 1, "sent an ack");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("authorized chat → handleInbound with crow-messages thread; reply published", async () => {
  const { dir, db } = freshDb();
  try {
    cmStore.upsertAclFromAccept(db, "bot1", "a".repeat(64), "crow:s", "Sam");
    let seen = null; const sent = [];
    await handleCrowMessageEvent({
      botId: "bot1", senderPubkey: "a".repeat(64), decrypted: "what's the weather?",
      db, allowPaired: false,
      handleInbound: async (opts) => { seen = opts; await opts.sendReply("sunny"); return { action: "done" }; },
      sendDM: async (pk, text) => sent.push([pk, text]),
      log: () => {},
    });
    assert.equal(seen.gateway_type, "crow-messages");
    assert.equal(seen.gateway_thread_id, "crow-messages:" + "a".repeat(64));
    assert.equal(seen.user_message, "what's the weather?");
    assert.deepEqual(sent, [["a".repeat(64), "sunny"]]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("unauthorized chat → no turn, no reply", async () => {
  const { dir, db } = freshDb();
  try {
    let turns = 0; const sent = [];
    await handleCrowMessageEvent({
      botId: "bot1", senderPubkey: "z".repeat(64), decrypted: "hi",
      db, allowPaired: false,
      handleInbound: async () => { turns++; return {}; },
      sendDM: async (...a) => sent.push(a), log: () => {},
    });
    assert.equal(turns, 0);
    assert.equal(sent.length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: FAIL — `handleCrowMessageEvent` not exported (module missing).

- [ ] **Step 3: Implement `scripts/pi-bots/gateways/crow-messages.mjs`**

```js
/**
 * Crow Messages gateway adapter (pi-bots host-managed, like telegram/slack).
 * A bot is reachable under its own derived Nostr identity; authorized senders'
 * DMs drive the real pi bridge (handleInbound) and the bot replies from its key.
 */
import { loadOrCreateIdentity, deriveBotIdentity } from "../../../servers/sharing/identity.js";
import { handleInbound as realHandleInbound } from "../bridge.mjs";
import { chunkedSend, SerialQueue } from "./base.mjs";
import * as cmStore from "./crow-messages-store.mjs";
import { xOnly, buildDM, openDM, connectRelays, subscribe, publish } from "./nostr-client.mjs";

export const type = "crow-messages";
export const mode = "nostr";
export const configFields = []; // custom Share/manage UI ships in Plan 2

export function gatewayHint(threadId) {
  return "\nGATEWAY: crow-messages — your reply text is delivered over Crow Messages automatically. "
    + "Do NOT use gmail tools. (thread ref: " + threadId + ")";
}

export async function checkRequirements() {
  try { await import("nostr-tools/pure"); return true; } catch { return false; }
}

/**
 * Core router for one decrypted inbound DM. Dependency-injected for testing.
 * @returns {Promise<void>}
 */
export async function handleCrowMessageEvent({ botId, botIdentity, senderPubkey, decrypted, db, allowPaired, handleInbound, sendDM, log }) {
  const pk = xOnly(senderPubkey);
  // Control message?
  if (typeof decrypted === "string" && decrypted.startsWith("{")) {
    let payload = null;
    try { payload = JSON.parse(decrypted); } catch { payload = null; }
    if (payload && payload.type === "crow_social" && payload.subtype === "bot_invite_accept") {
      const ok = cmStore.consumeInvite(db, botId, payload.token);
      if (!ok) { log("invite reject bot=" + botId + " sender=" + pk); return; }
      const s = payload.sender || {};
      cmStore.upsertAclFromAccept(db, botId, s.secp256k1Pub || pk, s.crow_id || null, s.display_name || null);
      try { await sendDM(pk, "You can chat with this bot now."); } catch { /* ack best-effort */ }
      log("invite accept bot=" + botId + " sender=" + pk);
      return;
    }
    // Unknown control payloads are ignored (no turn).
    if (payload && payload.type) return;
  }
  // Plain chat → authorize then run a turn.
  if (!cmStore.authorizeSender(db, botId, pk, allowPaired)) { log("drop unauthorized bot=" + botId + " sender=" + pk); return; }
  await handleInbound({
    bot_id: botId,
    gateway_thread_id: "crow-messages:" + pk,
    user_message: decrypted,
    gateway_type: "crow-messages",
    sendReply: async (text) => { await sendDM(pk, text); },
    log: (m) => log("  [bridge:" + botId + "] " + m),
  });
}

export async function start({ bot_id, gw, log }) {
  let identity;
  try { identity = loadOrCreateIdentity(); } catch (e) { log("crow-messages bot=" + bot_id + " no identity: " + e.message); return { stop() {} }; }
  const botIdentity = deriveBotIdentity(identity.seed, bot_id);
  const allowPaired = !!(gw && gw.allow_paired_instances);

  const Database = (await import("better-sqlite3")).default;
  const { botsDbPath } = await import("../paths.mjs"); // existing CROW_DB resolver used by gateway_runner
  const db = new Database(botsDbPath()); db.pragma("busy_timeout = 10000");

  const relays = await connectRelays(cmStore.resolveRelays(db));
  const botXOnly = xOnly(botIdentity.secp256k1Pubkey);
  const queue = new SerialQueue({ maxDepth: 5, log, handler: (job) => job() });

  const subs = subscribe(relays, { kinds: [4], "#p": [botXOnly] }, (event) => {
    let decrypted;
    try { decrypted = openDM(botIdentity.secp256k1Priv, event.pubkey, event.content); }
    catch { return; } // not for us / undecryptable
    queue.push(() => handleCrowMessageEvent({
      botId: bot_id, botIdentity, senderPubkey: event.pubkey, decrypted, db, allowPaired,
      handleInbound: realHandleInbound,
      sendDM: async (recipXOnly, text) => {
        await chunkedSend(async (chunk) => {
          const ev = buildDM(botIdentity.secp256k1Priv, recipXOnly, chunk);
          await publish(relays, ev);
        }, text, { log });
      },
      log,
    }).catch((e) => log("event handler error: " + (e && e.message))));
  });

  log("crow-messages bot=" + bot_id + " listening as " + botIdentity.crowId + " on " + relays.size + " relay(s)");
  return {
    stop() {
      for (const s of subs) { try { s.close(); } catch {} }
      for (const [, relay] of relays) { try { relay.close(); } catch {} }
      try { db.close(); } catch {}
    },
  };
}

export default { type, mode, configFields, gatewayHint, checkRequirements, start, handleCrowMessageEvent };
```

> **Integration note for the executor:** `start()` references `botsDbPath` from a pi-bots paths module and `chunkedSend`/`SerialQueue` from `base.mjs`. Confirm the exact export names/paths against `gateway_runner.mjs` (it builds `CROW_DB = botsDbPath()`) and `base.mjs` before running; adjust the import specifiers if they differ. `start()` is **not** unit-tested (it needs real relays); Task 8 covers the wired path via injected stubs, and the live smoke happens at deploy.

- [ ] **Step 4: Run to verify the core passes**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: PASS (5 tests total — 2 crypto + 3 routing).

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-bots/gateways/crow-messages.mjs
git commit scripts/pi-bots/gateways/crow-messages.mjs tests/crow-messages-adapter.test.js -m "feat(crow-messages): gateway adapter (router core + host transport)"
git show --stat HEAD
```

---

## Task 7: Register the adapter as host-managed

**Files:**
- Modify: `scripts/pi-bots/gateways/index.mjs`
- Test: `tests/crow-messages-adapter.test.js` (extend)

- [ ] **Step 1: Write the failing test** (append to `tests/crow-messages-adapter.test.js`)

```js
import { isHostManaged, getAdapter } from "../scripts/pi-bots/gateways/index.mjs";

test("crow-messages is registered as a host-managed adapter", () => {
  assert.equal(isHostManaged("crow-messages"), true);
  const a = getAdapter("crow-messages");
  assert.ok(a && a.type === "crow-messages" && typeof a.start === "function");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: FAIL — `isHostManaged("crow-messages")` is false.

- [ ] **Step 3: Register in `scripts/pi-bots/gateways/index.mjs`**

Add the import and include it in `HOST_ADAPTERS`:

```js
import telegram from "./telegram.mjs";
import slack from "./slack.mjs";
import crowMessages from "./crow-messages.mjs";

/** Adapter modules the host process owns (each exports start() -> {stop}). */
const HOST_ADAPTERS = [telegram, slack, crowMessages];
```

(`capabilitiesForUI()` will surface it generically; Plan 2 replaces that with the custom Share/manage UI. `gatewayHint` already routes unknown types through the adapter's own `gatewayHint` via the `HOST_BY_TYPE` lookup, so no change needed there.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/crow-messages-adapter.test.js`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git commit scripts/pi-bots/gateways/index.mjs tests/crow-messages-adapter.test.js -m "feat(crow-messages): register adapter in HOST_ADAPTERS"
git show --stat HEAD
```

---

## Task 8: End-to-end transport integration (mock relay)

**Files:**
- Test: `tests/crow-messages-integration.test.js`

Drives the full router with a stub relay and a stub `handleInbound`: invite token → accept event authorizes → a chat event from that sender reaches `handleInbound` and the reply is published as an encrypted DM the sender can decrypt.

- [ ] **Step 1: Write the test** — create `tests/crow-messages-integration.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deriveBotIdentity } from "../servers/sharing/identity.js";
import { handleCrowMessageEvent } from "../scripts/pi-bots/gateways/crow-messages.mjs";
import { buildDM, openDM, xOnly } from "../scripts/pi-bots/gateways/nostr-client.mjs";

const SEED = Buffer.alloc(32, 3);

test("invite → accept → authorized chat → reply decryptable by sender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crowmsg-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = new Database(join(dir, "crow.db"));
  try {
    const bot = deriveBotIdentity(SEED, "bot1");
    const sender = deriveBotIdentity(SEED, "sender1");
    db.prepare("INSERT INTO bot_message_invites (bot_id, token) VALUES (?,?)").run("bot1", "tok-9");

    // captured outbound DMs (bot → sender), as real encrypted events
    const outbound = [];
    const sendDM = async (recipXOnly, text) => {
      outbound.push(buildDM(bot.secp256k1Priv, recipXOnly, text));
    };
    const deps = { botId: "bot1", db, allowPaired: false, sendDM, log: () => {} };

    // 1. sender accepts the invite
    await handleCrowMessageEvent({
      ...deps, senderPubkey: xOnly(sender.secp256k1Pubkey),
      decrypted: JSON.stringify({ type: "crow_social", subtype: "bot_invite_accept", token: "tok-9",
        sender: { crow_id: sender.crowId, secp256k1Pub: xOnly(sender.secp256k1Pubkey), display_name: "Sender One" } }),
      handleInbound: async () => ({ action: "done" }),
    });

    // 2. now an authorized chat turn
    let turnSeen = null;
    await handleCrowMessageEvent({
      ...deps, senderPubkey: xOnly(sender.secp256k1Pubkey), decrypted: "hello there",
      handleInbound: async (opts) => { turnSeen = opts; await opts.sendReply("general kenobi"); return { action: "done" }; },
    });

    assert.equal(turnSeen.user_message, "hello there");
    // last outbound is the chat reply; sender can decrypt it
    const replyEv = outbound[outbound.length - 1];
    const text = openDM(sender.secp256k1Priv, replyEv.pubkey, replyEv.content);
    assert.equal(text, "general kenobi");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test tests/crow-messages-integration.test.js`
Expected: PASS (1 test). (No prior failing state needed — it composes already-built units; if it fails, the defect is in an earlier task.)

- [ ] **Step 3: Run the whole Plan-1 suite**

Run: `node --test tests/crow-bot-identity.test.js tests/crow-messages-store.test.js tests/crow-messages-adapter.test.js tests/crow-messages-integration.test.js`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/crow-messages-integration.test.js
git commit tests/crow-messages-integration.test.js -m "test(crow-messages): end-to-end transport (invite→accept→chat→reply)"
git show --stat HEAD
```

---

## Self-Review

**Spec coverage (Plan-1 slice):** derived identity (§Identity → T1); data model (§Data model → T2); invite codec (§Invites → T3); Nostr transport primitives + adapter driving the real pi bridge with `gateway_thread_id`, replies from the bot key, no `messages`-table writes (§Transport → T4/T6); default-deny authorization by secp pubkey, invite-consume, paired-instance toggle (§Trust → T5/T6); host registration so `gateway_runner` auto-hosts it (§Registry → T7); E2E (§Testing → T8). **Deferred to Plan 2 (not this plan):** owner Bot Builder UI (Share/manage/Advanced), recipient `crow_accept_bot_invite` tool + landing route, `capabilitiesForUI`/`STATIC_META` friendly entry, i18n. These are the human-facing sharing layer; the transport works now with a manually/inserted invite + accept.

**Placeholder scan:** the two integration specifics flagged inline (the `botsDbPath`/`base.mjs` import names in Task 6, and the `crow_instances.secp256k1_pubkey` column in Task 5) are **verify-then-adjust** items with concrete fallbacks, not blanks — the executor confirms the exact symbol against the cited existing file. No `TBD`/`handle errors`/`similar to`.

**Type consistency:** `deriveBotIdentity` shape (`secp256k1Priv`/`secp256k1Pubkey`/`crowId`) is consistent across T1/T3/T6/T8; pubkeys are x-only 64-hex at every store/compare boundary via `xOnly`; `handleCrowMessageEvent`'s injected deps (`db`, `handleInbound`, `sendDM`, `allowPaired`, `log`) match between T6's definition and T8's call.

---

## After Plan 1

1. **Pre-deploy verification:** the live host that runs crow-messages bots needs `nostr-tools` + `better-sqlite3` resolvable in the pi-bots process (both already used elsewhere — confirm), and the host's env must point `identity.js` at the right instance seed (`CROW_DATA_DIR`/`HOME`).
2. **Plan 2 — Sharing UX:** owner Bot Builder config block (the "Share access" link/QR, "Allow my other Crow devices", "Who can message" list with Remove, "New link" rotation, Advanced disclosure) + persistence/actions in `api-handlers.js` + a `capabilitiesForUI` entry; the recipient `crow_accept_bot_invite` sharing tool (parse code → add the bot as a contact so it shows in Messages → send the `bot_invite_accept` DM) + the "Add & message" landing route. Brainstorming already locked this UX — Plan 2 turns it into tasks.
3. Then: plan-review → execute → `/security-review` (new Nostr transport + authorization boundary) → finishing-a-development-branch → deploy.
