# Crow Messages Phase 3a — Group / Multi-Party Bot Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent multi-party rooms (you + your bots + other humans) on top of Crow Messages, where one instance *hosts* and relays every message to all participants, bots take turns only when addressed, and loops are structurally impossible.

**Architecture:** Hub-and-spoke over pairwise Nostr DMs (Approach A). Rooms are built ON the existing `contact_groups` (a group becomes a room when it has a `room_uid`); members are contacts (some `is_bot`). A new `crow_social` subtype `room_message` is fanned out 1:1 to every member; bots are uniform participants addressed at their own pubkey. The host re-fans replies so everyone sees everyone. `author_kind` gates bot turns (bots react only to human messages).

**Tech Stack:** Node 20+, `@libsql/client` (gateway side, async), `better-sqlite3` (pi-bots side, sync), Nostr (`nostr-tools`), Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-16-crow-messages-group-threads-design.md`. Read it first.

---

## File structure

**New files:**
- `servers/gateway/dashboard/shared/ensure-local-bot-contact.js` — upsert a local bot as an `is_bot` contact (derived pubkey).
- `servers/gateway/dashboard/panels/messages/rooms-store.js` — libsql room + room-message store (room CRUD, members, messages, `computeAddressedTo`).
- `servers/sharing/room-fanout.js` — envelope builders + `fanOut` (pure-ish; injected `nostrManager`).
- `servers/sharing/room-inbound.js` — `handleInboundRoomEnvelope` (host re-fan + participant materialize); wired into `boot.js`.
- Tests: `tests/rooms-store.test.js`, `tests/room-fanout.test.js`, `tests/room-inbound.test.js`, `tests/room-adapter.test.js`, `tests/messages-room-actions.test.js`, `tests/ensure-local-bot-contact.test.js`.

**Modified files:**
- `scripts/init-db.js` — 3 `contact_groups` columns + partial unique index + `room_messages` table.
- `servers/sharing/identity.js` — export `deriveInstanceIdentity(seed)`.
- `scripts/pi-bots/gateways/crow-messages.mjs` — `room_message` branch + room-aware reply + room `gatewayHint`.
- `servers/sharing/boot.js` — route `room_message` / `room_join` subtypes to `handleInboundRoomEnvelope`.
- `servers/gateway/dashboard/panels/messages/` — `api-handlers.js`, `data-queries.js`, `html.js`, `client.js`, `css.js`.
- `servers/gateway/dashboard/shared/i18n.js` — EN + ES keys.

**Shared test helper** (define inline at the top of each libsql test file that needs it):
```js
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
```

---

## Task 1: Schema — extend `contact_groups`, add `room_messages`

**Files:**
- Modify: `scripts/init-db.js` (near the existing `contact_groups` block, ~line 1755)
- Test: `tests/rooms-schema.test.js` (create)

- [ ] **Step 1: Write the failing test**

`tests/rooms-schema.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("contact_groups has room_uid/host_crow_id/mode; room_messages exists", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const cg = await db.execute("PRAGMA table_info(contact_groups)");
    const cols = cg.rows.map((r) => r.name);
    assert.ok(cols.includes("room_uid"), "room_uid");
    assert.ok(cols.includes("host_crow_id"), "host_crow_id");
    assert.ok(cols.includes("mode"), "mode");

    const rm = await db.execute("PRAGMA table_info(room_messages)");
    const rcols = rm.rows.map((r) => r.name);
    for (const c of ["group_id", "msg_uid", "sender_contact_id", "sender_label", "author_kind", "content", "direction", "nostr_event_id", "is_read"]) {
      assert.ok(rcols.includes(c), "room_messages." + c);
    }
    // Partial unique index on room_uid: two NULLs allowed, dup non-null rejected.
    await db.execute("INSERT INTO contact_groups (name) VALUES ('a')");
    await db.execute("INSERT INTO contact_groups (name) VALUES ('b')"); // both room_uid NULL — OK
    await db.execute("INSERT INTO contact_groups (name, room_uid) VALUES ('r1','u1')");
    await assert.rejects(
      db.execute("INSERT INTO contact_groups (name, room_uid) VALUES ('r2','u1')"),
      /UNIQUE|constraint/i, "duplicate room_uid rejected"
    );
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/rooms-schema.test.js`
Expected: FAIL (`room_uid` column missing).

- [ ] **Step 3: Implement the migration**

In `scripts/init-db.js`, immediately AFTER the `contact_group_members` block (the `CREATE UNIQUE INDEX ... idx_group_members_unique` ends ~line 1755), add:
```js
// --- Crow Messages rooms (phase 3a): a contact_group becomes a multi-party room
// when it carries a room_uid. Plain organizational groups (room_uid NULL) are
// unaffected. mode is validated in code ('addressed'|'always') — a CHECK can't be
// added to an existing table via ALTER, so it lives in rooms-store, not the column.
await addColumnIfMissing("contact_groups", "room_uid", "TEXT");
await addColumnIfMissing("contact_groups", "host_crow_id", "TEXT");
await addColumnIfMissing("contact_groups", "mode", "TEXT DEFAULT 'addressed'");
await db.execute(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_groups_room_uid ON contact_groups(room_uid) WHERE room_uid IS NOT NULL"
);

await initTable("room_messages table", `
  CREATE TABLE IF NOT EXISTS room_messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id          INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    msg_uid           TEXT NOT NULL,
    sender_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    sender_label      TEXT,
    author_kind       TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','bot')),
    content           TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('sent','received')),
    nostr_event_id    TEXT,
    is_read           INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_room_messages_group ON room_messages(group_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_msg_uid ON room_messages(group_id, msg_uid);
`);
```
(NOTE: `addColumnIfMissing`'s 3rd arg is the **type clause only** — confirmed against the existing `contacts` calls at ~line 1728. `initTable` is the same helper used for every table above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/rooms-schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add scripts/init-db.js tests/rooms-schema.test.js
git commit scripts/init-db.js tests/rooms-schema.test.js -m "feat(crow-messages): phase 3a schema — room columns on contact_groups + room_messages"
```

---

## Task 2: `ensureLocalBotContact` helper

Upsert a local bot as an `is_bot` contact carrying its derived pubkey, so a bot can be a uniform room member.

**Files:**
- Create: `servers/gateway/dashboard/shared/ensure-local-bot-contact.js`
- Test: `tests/ensure-local-bot-contact.test.js`

- [ ] **Step 1: Write the failing test**

`tests/ensure-local-bot-contact.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalBotContact } from "../servers/gateway/dashboard/shared/ensure-local-bot-contact.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// Inject a stub identity resolver so the test needs no identity.json on disk.
const stubIdentity = (botId) => ({ crowId: "crow:bot-" + botId, secp256k1Pubkey: "02" + "a".repeat(64) });

test("creates an is_bot contact with the derived pubkey, idempotently", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const id1 = await ensureLocalBotContact(db, "bot1", { displayName: "Research Bot", _identityFor: stubIdentity });
    assert.ok(id1 > 0);
    const { rows } = await db.execute({ sql: "SELECT crow_id, display_name, is_bot, secp256k1_pubkey FROM contacts WHERE id = ?", args: [id1] });
    assert.equal(rows[0].crow_id, "crow:bot-bot1");
    assert.equal(Number(rows[0].is_bot), 1);
    assert.equal(rows[0].display_name, "Research Bot");
    assert.equal(rows[0].secp256k1_pubkey, "02" + "a".repeat(64));
    // Idempotent: same crow_id → same row id, no duplicate.
    const id2 = await ensureLocalBotContact(db, "bot1", { displayName: "Research Bot", _identityFor: stubIdentity });
    assert.equal(id2, id1);
    const { rows: all } = await db.execute("SELECT COUNT(*) AS n FROM contacts");
    assert.equal(Number(all[0].n), 1);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/ensure-local-bot-contact.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`servers/gateway/dashboard/shared/ensure-local-bot-contact.js`:
```js
/**
 * Upsert one of THIS instance's bots as an is_bot contact, so it can be a uniform
 * room member (phase 3a). The pubkey is DERIVED (deriveBotIdentity), never stored
 * elsewhere — same anchor the pi-bots adapter subscribes on. Idempotent on crow_id.
 * Returns the contact id, or null on any failure (never throws).
 */
import { dirname } from "node:path";
import { loadInstanceSeed, deriveBotIdentity } from "../../../sharing/identity.js";
import { botsDbPath } from "../../../../scripts/pi-bots/instance-paths.mjs";

function defaultIdentityFor(botId) {
  const seed = loadInstanceSeed(dirname(botsDbPath()));
  return deriveBotIdentity(seed, botId); // { crowId, secp256k1Pubkey, ... }
}

export async function ensureLocalBotContact(db, botId, { displayName = null, _identityFor = defaultIdentityFor } = {}) {
  if (!botId) return null;
  try {
    const ident = _identityFor(botId);
    const crowId = ident.crowId;
    const pubkey = ident.secp256k1Pubkey;
    const name = displayName || botId;
    const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ? LIMIT 1", args: [crowId] });
    if (rows.length) {
      await db.execute({
        sql: "UPDATE contacts SET is_bot = 1, display_name = COALESCE(?, display_name), secp256k1_pubkey = ? WHERE id = ?",
        args: [name, pubkey, rows[0].id],
      });
      return Number(rows[0].id);
    }
    const res = await db.execute({
      sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, contact_type) VALUES (?,?,1,?, 'crow')",
      args: [crowId, name, pubkey],
    });
    return Number(res.lastInsertRowid);
  } catch (err) {
    console.error("[rooms] ensureLocalBotContact failed:", err && err.message);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/ensure-local-bot-contact.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/dashboard/shared/ensure-local-bot-contact.js tests/ensure-local-bot-contact.test.js
git commit servers/gateway/dashboard/shared/ensure-local-bot-contact.js tests/ensure-local-bot-contact.test.js -m "feat(crow-messages): ensureLocalBotContact helper for room membership"
```

---

## Task 3: Room store — room CRUD + members

**Files:**
- Create: `servers/gateway/dashboard/panels/messages/rooms-store.js`
- Test: `tests/rooms-store.test.js`

- [ ] **Step 1: Write the failing test**

`tests/rooms-store.test.js` (room CRUD portion):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoom, getRoomByUid, getRoom, listRoomMembers, ensureLocalRoomForUid,
  addMember, removeMember, setMode, renameRoom, deleteRoom, listRooms,
} from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
async function mkContact(db, crowId, name, isBot = 0) {
  const r = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, contact_type) VALUES (?,?,?,?, 'crow')", args: [crowId, name, isBot, "02" + crowId.slice(-1).repeat(64)] });
  return Number(r.lastInsertRowid);
}

test("createRoom assigns a room_uid, inserts members; mode validated", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice");
    const bot = await mkContact(db, "crow:bot1", "Research Bot", 1);
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice, bot], mode: "always", hostCrowId: "crow:me" });
    assert.ok(groupId > 0);
    assert.equal(roomUid.length, 32);
    const room = await getRoom(db, groupId);
    assert.equal(room.name, "Team");
    assert.equal(room.mode, "always");
    assert.equal(room.host_crow_id, "crow:me");
    const byUid = await getRoomByUid(db, roomUid);
    assert.equal(byUid.id, groupId);
    const members = await listRoomMembers(db, groupId);
    assert.equal(members.length, 2);
    assert.ok(members.some((m) => Number(m.is_bot) === 1));
    // Invalid mode coerces to 'addressed'
    const { groupId: g2 } = await createRoom(db, { name: "X", memberContactIds: [], mode: "bogus", hostCrowId: "crow:me" });
    assert.equal((await getRoom(db, g2)).mode, "addressed");
  } finally { cleanup(); }
});

test("ensureLocalRoomForUid materializes once; add/remove/setMode/rename/delete", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const gid1 = await ensureLocalRoomForUid(db, { roomUid: "uid-1", name: "Joined", hostCrowId: "crow:host" });
    const gid2 = await ensureLocalRoomForUid(db, { roomUid: "uid-1", name: "Joined", hostCrowId: "crow:host" });
    assert.equal(gid1, gid2, "idempotent on room_uid");
    const c = await mkContact(db, "crow:bob", "Bob");
    await addMember(db, gid1, c);
    assert.equal((await listRoomMembers(db, gid1)).length, 1);
    await addMember(db, gid1, c); // idempotent
    assert.equal((await listRoomMembers(db, gid1)).length, 1);
    await setMode(db, gid1, "always");
    assert.equal((await getRoom(db, gid1)).mode, "always");
    await renameRoom(db, gid1, "Renamed");
    assert.equal((await getRoom(db, gid1)).name, "Renamed");
    await removeMember(db, gid1, c);
    assert.equal((await listRoomMembers(db, gid1)).length, 0);
    assert.equal((await listRooms(db)).length, 1);
    await deleteRoom(db, gid1);
    assert.equal(await getRoom(db, gid1), null);
    assert.equal((await listRooms(db)).length, 0);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/rooms-store.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement (room CRUD half of rooms-store.js)**

`servers/gateway/dashboard/panels/messages/rooms-store.js`:
```js
/**
 * Crow Messages rooms store (libsql / gateway side). A room IS a contact_groups
 * row with a non-NULL room_uid; members reuse contact_group_members. The 1:1
 * `messages` table is untouched — room messages live in `room_messages`.
 */
import { randomBytes } from "node:crypto";

function normMode(mode) { return mode === "always" ? "always" : "addressed"; }

/** Create a host-side room. Assigns a stable room_uid. Returns { groupId, roomUid }. */
export async function createRoom(db, { name, memberContactIds = [], mode = "addressed", hostCrowId = null }) {
  const roomUid = randomBytes(16).toString("hex"); // 32 hex chars
  const res = await db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES (?,?,?,?)",
    args: [name, roomUid, hostCrowId, normMode(mode)],
  });
  const groupId = Number(res.lastInsertRowid);
  for (const cid of memberContactIds) {
    await db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?,?)", args: [groupId, cid] });
  }
  return { groupId, roomUid };
}

/** Materialize a local room row for a room hosted elsewhere (participant side). Idempotent on room_uid. Returns groupId. */
export async function ensureLocalRoomForUid(db, { roomUid, name = "Room", hostCrowId = null, mode = "addressed" }) {
  const { rows } = await db.execute({ sql: "SELECT id FROM contact_groups WHERE room_uid = ?", args: [roomUid] });
  if (rows.length) return Number(rows[0].id);
  const res = await db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES (?,?,?,?)",
    args: [name, roomUid, hostCrowId, normMode(mode)],
  });
  return Number(res.lastInsertRowid);
}

/** A room by its contact_groups id, or null. Only returns rows that ARE rooms (room_uid not null). */
export async function getRoom(db, groupId) {
  const { rows } = await db.execute({ sql: "SELECT id, name, room_uid, host_crow_id, mode, created_at FROM contact_groups WHERE id = ? AND room_uid IS NOT NULL", args: [groupId] });
  return rows[0] || null;
}

/** A room by its shared room_uid, or null. */
export async function getRoomByUid(db, roomUid) {
  const { rows } = await db.execute({ sql: "SELECT id, name, room_uid, host_crow_id, mode, created_at FROM contact_groups WHERE room_uid = ?", args: [roomUid] });
  return rows[0] || null;
}

/** All rooms (room_uid not null), newest first. */
export async function listRooms(db) {
  const { rows } = await db.execute("SELECT id, name, room_uid, host_crow_id, mode, created_at FROM contact_groups WHERE room_uid IS NOT NULL ORDER BY id DESC");
  return rows;
}

/** Member contacts of a room (joined to contacts for pubkey/name/is_bot). */
export async function listRoomMembers(db, groupId) {
  const { rows } = await db.execute({
    sql: `SELECT c.id, c.crow_id, c.display_name, c.is_bot, c.secp256k1_pubkey, c.is_blocked
          FROM contact_group_members gm JOIN contacts c ON c.id = gm.contact_id
          WHERE gm.group_id = ? AND c.is_blocked = 0`,
    args: [groupId],
  });
  return rows;
}

export async function addMember(db, groupId, contactId) {
  await db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?,?)", args: [groupId, contactId] });
}
export async function removeMember(db, groupId, contactId) {
  await db.execute({ sql: "DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?", args: [groupId, contactId] });
}
export async function setMode(db, groupId, mode) {
  await db.execute({ sql: "UPDATE contact_groups SET mode = ? WHERE id = ? AND room_uid IS NOT NULL", args: [normMode(mode), groupId] });
}
export async function renameRoom(db, groupId, name) {
  await db.execute({ sql: "UPDATE contact_groups SET name = ? WHERE id = ? AND room_uid IS NOT NULL", args: [name, groupId] });
}
export async function deleteRoom(db, groupId) {
  await db.execute({ sql: "DELETE FROM contact_groups WHERE id = ? AND room_uid IS NOT NULL", args: [groupId] });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/rooms-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/dashboard/panels/messages/rooms-store.js tests/rooms-store.test.js
git commit servers/gateway/dashboard/panels/messages/rooms-store.js tests/rooms-store.test.js -m "feat(crow-messages): rooms-store room + member CRUD"
```

---

## Task 4: Room messages — insert/dedup, fetch, `computeAddressedTo`

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/rooms-store.js` (append)
- Test: `tests/rooms-store.test.js` (append cases)

- [ ] **Step 1: Write the failing test (append to `tests/rooms-store.test.js`)**

```js
import { insertRoomMessage, getRoomMessages, computeAddressedTo } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

test("insertRoomMessage dedups on (group, msg_uid); getRoomMessages returns chronological", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const { groupId } = await createRoom(db, { name: "R", memberContactIds: [], mode: "addressed", hostCrowId: "crow:me" });
    const a = await insertRoomMessage(db, { groupId, msgUid: "m1", senderContactId: null, senderLabel: "You", authorKind: "human", content: "hi", direction: "sent" });
    const b = await insertRoomMessage(db, { groupId, msgUid: "m1", senderContactId: null, senderLabel: "You", authorKind: "human", content: "hi", direction: "sent" });
    assert.equal(a, true, "first insert is new");
    assert.equal(b, false, "duplicate msg_uid ignored");
    await insertRoomMessage(db, { groupId, msgUid: "m2", senderContactId: null, senderLabel: "Bot", authorKind: "bot", content: "hello", direction: "received" });
    const msgs = await getRoomMessages(db, groupId);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, "hi");
    assert.equal(msgs[1].author_kind, "bot");
  } finally { cleanup(); }
});

test("computeAddressedTo: exact @mention and whole-word name; no substring false-positive", async () => {
  const roster = [{ contactId: 1, name: "Research Bot" }, { contactId: 2, name: "Max" }];
  assert.deepEqual(computeAddressedTo("hey @Research Bot can you help", roster), ["Research Bot"]);
  assert.deepEqual(computeAddressedTo("Max, what time is it?", roster), ["Max"]);
  assert.deepEqual(computeAddressedTo("the maximum value", roster), [], "‘maximum’ must NOT match ‘Max’");
  assert.deepEqual(computeAddressedTo("nobody addressed here", roster), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/rooms-store.test.js`
Expected: FAIL (`insertRoomMessage` not exported).

- [ ] **Step 3: Implement (append to `rooms-store.js`)**

```js
/** Insert a room message. Returns true if newly inserted, false if a dup (group, msg_uid). */
export async function insertRoomMessage(db, { groupId, msgUid, senderContactId = null, senderLabel = null, authorKind = "human", content, direction, nostrEventId = null }) {
  const res = await db.execute({
    sql: `INSERT OR IGNORE INTO room_messages
            (group_id, msg_uid, sender_contact_id, sender_label, author_kind, content, direction, nostr_event_id)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [groupId, msgUid, senderContactId, senderLabel, authorKind === "bot" ? "bot" : "human", content, direction, nostrEventId],
  });
  return (res.rowsAffected || 0) > 0;
}

/** Room messages, oldest-first, joined to the sender contact for display. */
export async function getRoomMessages(db, groupId, { limit = 200 } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT rm.id, rm.msg_uid, rm.content, rm.author_kind, rm.direction, rm.is_read, rm.created_at,
                 rm.sender_label, c.display_name AS sender_name, c.is_bot AS sender_is_bot
          FROM room_messages rm
          LEFT JOIN contacts c ON c.id = rm.sender_contact_id
          WHERE rm.group_id = ?
          ORDER BY rm.id ASC
          LIMIT ?`,
    args: [groupId, limit],
  });
  return rows;
}

/**
 * Which bots in `botRoster` a human message addresses. Matches an explicit
 * `@name` OR a whole-word occurrence of the bot's display name (case-insensitive).
 * NEVER substring ("maximum" must not match "Max"). botRoster: [{contactId,name}].
 */
export function computeAddressedTo(text, botRoster) {
  const out = [];
  const lc = String(text || "").toLowerCase();
  for (const b of botRoster) {
    const name = String(b.name || "").trim();
    if (!name) continue;
    const nl = name.toLowerCase();
    const esc = nl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const at = lc.includes("@" + nl);
    const word = new RegExp("(^|[^a-z0-9])" + esc + "([^a-z0-9]|$)").test(lc);
    if (at || word) out.push(name);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/rooms-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/dashboard/panels/messages/rooms-store.js tests/rooms-store.test.js
git commit servers/gateway/dashboard/panels/messages/rooms-store.js tests/rooms-store.test.js -m "feat(crow-messages): room message insert/dedup + computeAddressedTo"
```

---

## Task 5: Transport — envelope builders + fan-out

**Files:**
- Create: `servers/sharing/room-fanout.js`
- Test: `tests/room-fanout.test.js`

- [ ] **Step 1: Write the failing test**

`tests/room-fanout.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoomMessageEnvelope, buildRoomJoinEnvelope, fanOut } from "../servers/sharing/room-fanout.js";

test("buildRoomMessageEnvelope shapes a crow_social room_message", () => {
  const env = JSON.parse(buildRoomMessageEnvelope({
    roomUid: "u1", roomName: "Team", hostCrowId: "crow:me", msgUid: "m1",
    author: { kind: "human", crow_id: "crow:me", display_name: "You" }, text: "hi",
    addressedTo: ["Research Bot"], ts: "2026-06-16T00:00:00Z",
  }));
  assert.equal(env.type, "crow_social");
  assert.equal(env.subtype, "room_message");
  assert.equal(env.payload.room_uid, "u1");
  assert.equal(env.payload.msg_uid, "m1");
  assert.deepEqual(env.payload.addressed_to, ["Research Bot"]);
  assert.equal(env.payload.author.kind, "human");
});

test("fanOut sends to every member except the excluded origin; returns sent/failed", async () => {
  const calls = [];
  const nostrManager = { async sendMessage(contact, envelope) {
    if (contact.id === 3) throw new Error("relay down");
    calls.push([contact.id, JSON.parse(envelope).subtype]);
    return { eventId: "e", relays: ["wss://x"] };
  } };
  const members = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 9 }];
  const res = await fanOut({ nostrManager, members, envelope: buildRoomJoinEnvelope({ roomUid: "u", roomName: "T", hostCrowId: "crow:me", members: [] }), excludeContactId: 9 });
  assert.deepEqual(calls.map((c) => c[0]).sort(), [1, 2]); // 9 excluded, 3 failed
  assert.deepEqual(res.sent.sort(), [1, 2]);
  assert.deepEqual(res.failed, [3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/room-fanout.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`servers/sharing/room-fanout.js`:
```js
/**
 * Crow Messages room transport (phase 3a). Pure envelope builders + a best-effort
 * fan-out over the existing nostrManager.sendMessage 1:1 path. The host calls this
 * to relay a room_message to every member; a participant uses it to send a reply
 * to the host. No relay/identity coupling here — nostrManager is injected.
 */

export function buildRoomMessageEnvelope({ roomUid, roomName, hostCrowId, msgUid, author, text, addressedTo = [], ts = null }) {
  return JSON.stringify({
    type: "crow_social", version: 1, subtype: "room_message",
    payload: {
      room_uid: roomUid, room_name: roomName, host_crow_id: hostCrowId,
      msg_uid: msgUid, author: author || {}, text: text || "",
      addressed_to: Array.isArray(addressedTo) ? addressedTo : [],
      ts: ts || new Date().toISOString(),
    },
  });
}

export function buildRoomJoinEnvelope({ roomUid, roomName, hostCrowId, members = [] }) {
  return JSON.stringify({
    type: "crow_social", version: 1, subtype: "room_join",
    payload: { room_uid: roomUid, room_name: roomName, host_crow_id: hostCrowId, members },
  });
}

/**
 * Send `envelope` to each member contact except `excludeContactId`. Best-effort:
 * one failed recipient never aborts the rest. Returns { sent:[ids], failed:[ids] }.
 */
export async function fanOut({ nostrManager, members, envelope, excludeContactId = null, log = () => {} }) {
  const sent = [], failed = [];
  for (const c of members) {
    if (excludeContactId != null && Number(c.id) === Number(excludeContactId)) continue;
    try { await nostrManager.sendMessage(c, envelope); sent.push(c.id); }
    catch (e) { failed.push(c.id); log("room fanout fail contact=" + c.id + ": " + (e && e.message)); }
  }
  return { sent, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/room-fanout.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/sharing/room-fanout.js tests/room-fanout.test.js
git commit servers/sharing/room-fanout.js tests/room-fanout.test.js -m "feat(crow-messages): room envelope builders + fan-out"
```

---

## Task 6: Inbound — host re-fan + participant materialize

`handleInboundRoomEnvelope` handles two subtypes. **room_join** (a host added us) → materialize the local room + members. **room_message** → host-side: authorize signer is a member, store (dedup), re-fan to other members (computing `addressed_to` for human-authored). This is where the host relays bot replies and remote-human replies to everyone.

**Files:**
- Create: `servers/sharing/room-inbound.js`
- Modify: `servers/sharing/boot.js` (route the two subtypes)
- Test: `tests/room-inbound.test.js`

- [ ] **Step 1: Write the failing test**

`tests/room-inbound.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInboundRoomEnvelope } from "../servers/sharing/room-inbound.js";
import { createRoom, getRoomByUid, getRoomMessages, listRoomMembers, ensureLocalRoomForUid, addMember } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}
const PK = (c) => "02" + c.repeat(64);           // compressed contact pubkey
const XO = (c) => c.repeat(64);                   // x-only signer
async function mkContact(db, crowId, name, isBot, c) {
  const r = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, contact_type) VALUES (?,?,?,?, 'crow')", args: [crowId, name, isBot, PK(c)] });
  return Number(r.lastInsertRowid);
}

test("room_join materializes a local room + members", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const sent = [];
    const nostrManager = { async sendMessage(ct, env) { sent.push([ct.id, JSON.parse(env).subtype]); } };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" },
      subtype: "room_join",
      payload: { room_uid: "u-join", room_name: "Invited", host_crow_id: "crow:host", members: [] },
      senderPubkey: XO("h"),
    });
    const room = await getRoomByUid(db, "u-join");
    assert.ok(room, "room materialized");
    assert.equal(room.host_crow_id, "crow:host");
  } finally { cleanup(); }
});

test("host re-fans a member's human message to other members, computing addressed_to; dedups", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice", 0, "a");
    const bot = await mkContact(db, "crow:bot1", "Research Bot", 1, "b");
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice, bot], mode: "addressed", hostCrowId: "crow:me" });
    const fanned = [];
    const nostrManager = { async sendMessage(ct, env) { fanned.push([ct.id, JSON.parse(env)]); } };
    const payload = {
      room_uid: roomUid, room_name: "Team", host_crow_id: "crow:me", msg_uid: "mh1",
      author: { kind: "human", crow_id: "crow:alice", display_name: "Alice" },
      text: "@Research Bot please summarize", addressed_to: [],
    };
    await handleInboundRoomEnvelope({ db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message", payload, senderPubkey: XO("a") });
    // Stored a received row
    const msgs = await getRoomMessages(db, groupId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].author_kind, "human");
    // Re-fanned to the bot (not back to Alice, the origin)
    assert.equal(fanned.length, 1);
    assert.equal(fanned[0][0], bot);
    assert.deepEqual(fanned[0][1].payload.addressed_to, ["Research Bot"], "host computed addressed_to");
    assert.equal(fanned[0][1].payload.msg_uid, "mh1", "msg_uid preserved");
    // Replay same msg_uid → no second store, no second fan-out
    fanned.length = 0;
    await handleInboundRoomEnvelope({ db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message", payload, senderPubkey: XO("a") });
    assert.equal((await getRoomMessages(db, groupId)).length, 1);
    assert.equal(fanned.length, 0, "dup not re-fanned");
  } finally { cleanup(); }
});

test("participant side (room hosted elsewhere) stores the host's relay but does NOT re-fan", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // The host (operator) is a contact of ours; the room is hosted by them.
    const host = await mkContact(db, "crow:host", "Host", 0, "h");
    const gid = await ensureLocalRoomForUid(db, { roomUid: "u-remote", name: "Their Room", hostCrowId: "crow:host" });
    await addMember(db, gid, host);
    let fanned = 0;
    const nostrManager = { async sendMessage() { fanned++; } };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message",
      payload: { room_uid: "u-remote", msg_uid: "r1", author: { kind: "human", crow_id: "crow:alice", display_name: "Alice" }, text: "hi all", addressed_to: [] },
      senderPubkey: XO("h"), // signed by the HOST (relaying Alice's message)
    });
    assert.equal((await getRoomMessages(db, gid)).length, 1, "stored for display");
    assert.equal(fanned, 0, "participant does not re-fan");
  } finally { cleanup(); }
});

test("room_message from a non-member signer is dropped (fail-closed)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const alice = await mkContact(db, "crow:alice", "Alice", 0, "a");
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [alice], mode: "addressed", hostCrowId: "crow:me" });
    const nostrManager = { async sendMessage() { throw new Error("should not fan"); } };
    await handleInboundRoomEnvelope({
      db, nostrManager, identity: { crowId: "crow:me" }, subtype: "room_message",
      payload: { room_uid: roomUid, msg_uid: "x", author: { kind: "human" }, text: "intruder", addressed_to: [] },
      senderPubkey: XO("z"), // not a member
    });
    assert.equal((await getRoomMessages(db, groupId)).length, 0, "intruder message not stored");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/room-inbound.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`servers/sharing/room-inbound.js`:
```js
/**
 * Crow Messages room inbound (phase 3a). Routed from boot.js onSocialMessage for
 * the `room_join` and `room_message` subtypes. In 3a THIS instance is always the
 * host of rooms it created; a room_message therefore arrives from one of our own
 * members (a local bot's reply or a remote human's reply) — we authorize the
 * signer is a member, store once, and re-fan to everyone else. room_join is the
 * participant path: materialize the local room a remote host invited us into.
 */
import {
  ensureLocalRoomForUid, getRoomByUid, listRoomMembers,
  insertRoomMessage, computeAddressedTo,
} from "../gateway/dashboard/panels/messages/rooms-store.js";
import { buildRoomMessageEnvelope, fanOut } from "./room-fanout.js";

function xOnly(hex) { const h = String(hex || ""); return h.length === 66 ? h.slice(2) : h; }
function pubkeyMatches(storedCompressed, signerXOnly) {
  const a = String(storedCompressed || "");
  return a.length >= 64 && a.slice(-64).toLowerCase() === String(signerXOnly || "").toLowerCase();
}

export async function handleInboundRoomEnvelope({ db, nostrManager, identity, subtype, payload, senderPubkey, log = () => {} }) {
  const pk = xOnly(senderPubkey);

  if (subtype === "room_join") {
    const groupId = await ensureLocalRoomForUid(db, {
      roomUid: payload.room_uid, name: payload.room_name, hostCrowId: payload.host_crow_id,
    });
    // Best-effort: add any members we already know as contacts (matched by crow_id).
    if (Array.isArray(payload.members)) {
      for (const m of payload.members) {
        if (!m || !m.crow_id) continue;
        const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [m.crow_id] });
        if (rows[0]?.id != null) await db.execute({ sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?,?)", args: [groupId, rows[0].id] });
      }
    }
    return;
  }

  if (subtype === "room_message") {
    const room = await getRoomByUid(db, payload.room_uid);
    if (!room) { log("room_message: unknown room " + payload.room_uid); return; }
    const members = await listRoomMembers(db, room.id);
    const author = payload.author || {};
    const weAreHost = !room.host_crow_id || room.host_crow_id === identity.crowId;

    // Authorize the SIGNER: a room member (host side, where members relay to us) OR
    // the room's host (participant side, where the host relays to us). Fail-closed.
    const signerMember = members.find((m) => pubkeyMatches(m.secp256k1_pubkey, pk));
    let authorized = !!signerMember;
    if (!authorized && room.host_crow_id) {
      const { rows } = await db.execute({ sql: "SELECT secp256k1_pubkey FROM contacts WHERE crow_id = ?", args: [room.host_crow_id] });
      if (rows[0] && pubkeyMatches(rows[0].secp256k1_pubkey, pk)) authorized = true;
    }
    if (!authorized) { log("room_message drop: signer not member/host of " + payload.room_uid); return; }

    // Attribute the message to its AUTHOR (by crow_id) for display, not the signer
    // (on the participant side the signer is the host relaying someone else's text).
    let authorContactId = null, authorLabel = author.display_name || null;
    if (author.crow_id) {
      const { rows } = await db.execute({ sql: "SELECT id, display_name FROM contacts WHERE crow_id = ?", args: [author.crow_id] });
      if (rows[0]) { authorContactId = rows[0].id; authorLabel = rows[0].display_name || authorLabel; }
    }
    if (authorContactId == null && signerMember) { authorContactId = signerMember.id; authorLabel = authorLabel || signerMember.display_name; }

    const inserted = await insertRoomMessage(db, {
      groupId: room.id, msgUid: payload.msg_uid, senderContactId: authorContactId,
      senderLabel: authorLabel,
      authorKind: author.kind === "bot" ? "bot" : "human",
      content: payload.text || "", direction: "received", nostrEventId: null,
    });
    if (!inserted) return; // duplicate msg_uid — already handled

    // ONLY the host relays. A participant just stored the message for display.
    if (!weAreHost) return;

    // Host re-fan to all OTHER members. For human-authored messages the host
    // computes addressed_to (authoritative); bot-authored messages address no one.
    const botRoster = members.filter((m) => Number(m.is_bot) === 1).map((m) => ({ contactId: m.id, name: m.display_name || m.crow_id }));
    const addressedTo = author.kind === "human"
      ? (room.mode === "always" ? botRoster.map((b) => b.name) : computeAddressedTo(payload.text || "", botRoster))
      : [];
    const envelope = buildRoomMessageEnvelope({
      roomUid: room.room_uid, roomName: room.name, hostCrowId: identity.crowId,
      msgUid: payload.msg_uid, author, text: payload.text || "", addressedTo, ts: payload.ts || null,
    });
    // Exclude the transport origin (the member who sent it) from the re-fan.
    await fanOut({ nostrManager, members, envelope, excludeContactId: signerMember ? signerMember.id : null, log });
    return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/room-inbound.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into `boot.js`**

In `servers/sharing/boot.js`, inside the `onSocialMessage` handler (the `async (subtype, payload, senderPubkey) => {...}` dispatch around line 233), add near the other `else if (subtype === ...)` branches:
```js
else if (subtype === "room_message" || subtype === "room_join") {
  const { handleInboundRoomEnvelope } = await import("./room-inbound.js");
  await handleInboundRoomEnvelope({ db, nostrManager, identity, subtype, payload, senderPubkey, log: (m) => console.log("[rooms]", m) });
}
```
(The handler dedups + fan-outs internally; nothing else to do here. `db`, `nostrManager`, `identity` are already in scope in this closure — confirm against the existing `group_message` branch, which uses the same `db`.)

- [ ] **Step 6: Verify boot module graph loads**

Run: `node --input-type=module -e 'await import("./servers/sharing/boot.js"); console.log("boot ok")'`
Expected: prints `boot ok` (no import/syntax error). (Do NOT run `node servers/gateway/index.js --no-auth` — it is rejected when `CROW_GATEWAY_URL` is set in `.env`.)

- [ ] **Step 7: Commit**
```bash
git add servers/sharing/room-inbound.js tests/room-inbound.test.js servers/sharing/boot.js
git commit servers/sharing/room-inbound.js tests/room-inbound.test.js servers/sharing/boot.js -m "feat(crow-messages): room inbound — host re-fan + participant materialize"
```

---

## Task 7: pi-bots adapter — room turn gate + room-aware reply

The bot recognizes `room_message`, trusts ONLY its own host instance as signer, runs a turn iff `author.kind==='human'` AND it is in `addressed_to`, and replies to the host as a bot-authored room_message.

**Files:**
- Modify: `servers/sharing/identity.js` (export `deriveInstanceIdentity`)
- Modify: `scripts/pi-bots/gateways/crow-messages.mjs`
- Test: `tests/room-adapter.test.js`

- [ ] **Step 1: Export `deriveInstanceIdentity`**

In `servers/sharing/identity.js`, after `deriveBotIdentity` (~line 210), add:
```js
/** The instance's OWN identity from a raw seed (same derivation as loadOrCreateIdentity). */
export function deriveInstanceIdentity(seed) {
  return deriveIdentity(seed); // { crowId, secp256k1Pubkey, secp256k1Priv, ... }
}
```
(`deriveIdentity` already exists at line 163 and ignores its 2nd arg in the body — safe to call with just `seed`.)

- [ ] **Step 2: Write the failing test**

`tests/room-adapter.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCrowMessageEvent } from "../scripts/pi-bots/gateways/crow-messages.mjs";

// Minimal stub db (better-sqlite3 shape is not needed: room branch never touches it).
const stubDb = { prepare() { return { get() { return null; }, run() { return { changes: 1 }; }, all() { return []; } }; } };

function roomEvent(over = {}) {
  return {
    botId: "bot1",
    senderPubkey: "h".repeat(64),         // signer = host (matches hostXOnly below)
    decrypted: JSON.stringify({
      type: "crow_social", version: 1, subtype: "room_message",
      payload: {
        room_uid: "u1", room_name: "Team", host_crow_id: "crow:host", msg_uid: "m1",
        author: { kind: "human", crow_id: "crow:alice", display_name: "Alice" },
        text: "@Research Bot help", addressed_to: ["Research Bot"],
        ...(over.payload || {}),
      },
    }),
    db: stubDb,
    hostXOnly: "h".repeat(64),
    botDisplayName: "Research Bot",
    botCrowId: "crow:bot1",
    sendRoomReply: null, // set per test
    log: () => {},
    ...over,
  };
}

test("addressed human room_message → runs a pi turn; reply goes to host as bot-authored", async () => {
  const replies = [];
  let turn = null;
  await handleCrowMessageEvent(roomEvent({
    handleInbound: async (opts) => { turn = opts; await opts.sendReply("done"); return { action: "done" }; },
    sendRoomReply: async (roomUid, roomName, text) => replies.push([roomUid, text]),
  }));
  assert.ok(turn, "turn ran");
  assert.equal(turn.gateway_thread_id, "crow-room:u1");
  assert.equal(turn.user_message, "@Research Bot help");
  assert.deepEqual(replies, [["u1", "done"]]);
});

test("bot-authored room_message → NO turn (loop-safety)", async () => {
  let turn = false;
  await handleCrowMessageEvent(roomEvent({
    payload: { author: { kind: "bot", display_name: "Other Bot" }, addressed_to: ["Research Bot"] },
    handleInbound: async () => { turn = true; return {}; },
    sendRoomReply: async () => {},
  }));
  assert.equal(turn, false);
});

test("not-addressed human message → NO turn", async () => {
  let turn = false;
  await handleCrowMessageEvent(roomEvent({
    payload: { addressed_to: ["Some Other Bot"] },
    handleInbound: async () => { turn = true; return {}; },
    sendRoomReply: async () => {},
  }));
  assert.equal(turn, false);
});

test("signer != host → dropped (fail-closed)", async () => {
  let turn = false;
  await handleCrowMessageEvent(roomEvent({
    senderPubkey: "z".repeat(64), // not the host
    handleInbound: async () => { turn = true; return {}; },
    sendRoomReply: async () => {},
  }));
  assert.equal(turn, false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --test-force-exit tests/room-adapter.test.js`
Expected: FAIL (room branch not implemented — addressed turn won't fire as `crow-room:` thread).

- [ ] **Step 4: Implement the room branch in `handleCrowMessageEvent`**

In `scripts/pi-bots/gateways/crow-messages.mjs`, extend the function signature and add the branch BEFORE the existing "Plain chat" handling. Update the signature:
```js
export async function handleCrowMessageEvent({
  botId, senderPubkey, decrypted, db, handleInbound, sendDM, log, allowPaired = false,
  hostXOnly = null, botDisplayName = null, botCrowId = null, sendRoomReply = null,
}) {
  const pk = xOnly(senderPubkey);
```
Then, inside the existing `if (typeof decrypted === "string" && decrypted.startsWith("{"))` control-message block, immediately after `payload` is parsed (the `try { payload = JSON.parse(decrypted); } catch ...` line) and BEFORE the existing `bot_invite_accept` check — and crucially before the catch-all `if (payload && payload.type) return;` — add:
```js
    if (payload && payload.type === "crow_social" && payload.subtype === "room_message") {
      // Trust: accept room traffic ONLY from our own host instance (the signer of
      // this DM). Payload fields (author/host_crow_id) are LABELS, never trusted.
      if (!hostXOnly || pk !== xOnly(hostXOnly)) { log("room drop: signer!=host bot=" + botId); return; }
      const p = payload.payload || {};
      const author = p.author || {};
      // Loop-safety: react ONLY to human-authored messages.
      if (author.kind !== "human") return;
      // Addressing: the host already encoded the mode decision into addressed_to
      // (all bots in 'always' mode, matched bots otherwise). We only check membership.
      const me = String(botDisplayName || "").toLowerCase();
      const addressed = Array.isArray(p.addressed_to) ? p.addressed_to.map((s) => String(s).toLowerCase()) : [];
      if (!me || !addressed.includes(me)) return;
      await handleInbound({
        bot_id: botId,
        gateway_thread_id: "crow-room:" + p.room_uid,
        user_message: p.text || "",
        gateway_type: "crow-messages",
        sendReply: async (text) => { if (sendRoomReply) await sendRoomReply(p.room_uid, p.room_name, text); },
        log: (m) => log("  [bridge:" + botId + "] " + m),
      });
      return;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-force-exit tests/room-adapter.test.js`
Expected: PASS.

- [ ] **Step 6: Wire `start()` to derive host identity + provide `sendRoomReply`**

In `scripts/pi-bots/gateways/crow-messages.mjs` `start()`, after `const botIdentity = deriveBotIdentity(seed, bot_id);` add:
```js
  const { deriveInstanceIdentity } = await import("../../../servers/sharing/identity.js");
  const hostIdentity = deriveInstanceIdentity(seed);
  const hostXOnly = xOnly(hostIdentity.secp256k1Pubkey);
  const botDisplayName = (() => {
    try { return db.prepare("SELECT display_name FROM pi_bot_defs WHERE bot_id=?").get(bot_id)?.display_name || bot_id; }
    catch { return bot_id; }
  })();
  const { randomBytes } = await import("node:crypto");
```
Then in the `queue.push(() => handleCrowMessageEvent({ ... }))` call, add these fields to the object:
```js
      hostXOnly,
      botDisplayName,
      botCrowId: botIdentity.crowId,
      sendRoomReply: async (roomUid, roomName, text) => {
        // Reply to the HOST as a bot-authored room_message; one envelope per chunk,
        // each with its own msg_uid so the host dedups + relays each bubble.
        await chunkedSend(async (chunk) => {
          const env = JSON.stringify({
            type: "crow_social", version: 1, subtype: "room_message",
            payload: {
              room_uid: roomUid, room_name: roomName, host_crow_id: hostIdentity.crowId,
              msg_uid: randomBytes(16).toString("hex"),
              author: { kind: "bot", crow_id: botIdentity.crowId, display_name: botDisplayName },
              text: chunk, addressed_to: [], ts: new Date().toISOString(),
            },
          });
          const ev = buildDM(botIdentity.secp256k1Priv, hostXOnly, env);
          await publish(relays, ev);
        }, text, { log });
      },
```

- [ ] **Step 7: Add a room `gatewayHint` (optional steering)**

In the same file, the bridge passes `gateway_type: "crow-messages"`, so the existing `gatewayHint(threadId)` already applies. No change needed — the existing hint ("your reply text is delivered over Crow Messages automatically") is correct for room replies too. (Skip; documented so an implementer doesn't add a redundant hint.)

- [ ] **Step 8: Run the adapter test suite + commit**

Run: `node --test --test-force-exit tests/room-adapter.test.js tests/crow-messages-adapter.test.js`
Expected: PASS (no regression in the existing 1:1 adapter test).
```bash
git add servers/sharing/identity.js scripts/pi-bots/gateways/crow-messages.mjs tests/room-adapter.test.js
git commit servers/sharing/identity.js scripts/pi-bots/gateways/crow-messages.mjs tests/room-adapter.test.js -m "feat(crow-messages): bot room turn gate + room-aware reply"
```

---

## Task 8: Unified conversation list + room messages in the panel data layer

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/data-queries.js`
- Test: `tests/messages-room-actions.test.js` (create; this file also covers Task 9)

- [ ] **Step 1: Write the failing test**

`tests/messages-room-actions.test.js` (room-list portion):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUnifiedConversationList } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { createRoom, insertRoomMessage } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("getUnifiedConversationList includes rooms with type 'room' and unread", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const { groupId } = await createRoom(db, { name: "Team", memberContactIds: [], mode: "addressed", hostCrowId: "crow:me" });
    await insertRoomMessage(db, { groupId, msgUid: "m1", senderContactId: null, senderLabel: "Bot", authorKind: "bot", content: "hi", direction: "received" });
    const { items, totalUnread } = await getUnifiedConversationList(db);
    const room = items.find((i) => i.type === "room");
    assert.ok(room, "room present in unified list");
    assert.equal(room.displayName, "Team");
    assert.equal(room.groupId, groupId);
    assert.equal(room.unread, 1);
    assert.equal(totalUnread, 1);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/messages-room-actions.test.js`
Expected: FAIL (no `type:'room'` item).

- [ ] **Step 3: Implement — add a rooms block to `getUnifiedConversationList`**

In `servers/gateway/dashboard/panels/messages/data-queries.js`, inside `getUnifiedConversationList`, AFTER the "Peer contacts" `try {…} catch {}` block and BEFORE the final `items.sort(...)`, add:
```js
  // Rooms (multi-party). A contact_group with a room_uid is a room.
  try {
    const { rows: roomRows } = await db.execute(`
      SELECT g.id AS group_id, g.name, g.room_uid, g.mode,
             MAX(rm.created_at) AS last_msg_at,
             SUM(CASE WHEN rm.is_read = 0 AND rm.direction = 'received' THEN 1 ELSE 0 END) AS unread,
             (SELECT COUNT(*) FROM contact_group_members gm WHERE gm.group_id = g.id) AS member_count
      FROM contact_groups g
      LEFT JOIN room_messages rm ON rm.group_id = g.id
      WHERE g.room_uid IS NOT NULL
      GROUP BY g.id
      ORDER BY last_msg_at DESC NULLS LAST, g.id DESC
    `);
    for (const row of roomRows) {
      const unread = Number(row.unread) || 0;
      totalUnread += unread;
      items.push({
        type: "room",
        id: "room-" + row.group_id,
        groupId: Number(row.group_id),
        roomUid: row.room_uid,
        displayName: row.name || "Room",
        mode: row.mode || "addressed",
        memberCount: Number(row.member_count) || 0,
        lastActivity: row.last_msg_at || null,
        unread,
      });
    }
  } catch {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/messages-room-actions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/dashboard/panels/messages/data-queries.js tests/messages-room-actions.test.js
git commit servers/gateway/dashboard/panels/messages/data-queries.js tests/messages-room-actions.test.js -m "feat(crow-messages): rooms in the unified conversation list"
```

---

## Task 9: Panel POST action handlers — create / send / manage rooms

The handlers must work both as **host** (we created the room → fan out to all members) and as **participant** (room hosted elsewhere → send a single message to the host). In 3a the operator is always host of their own rooms; the participant branch exists because remote humans run the same code.

**Files:**
- Modify: `servers/gateway/dashboard/panels/messages/api-handlers.js`
- Test: `tests/messages-room-actions.test.js` (append)

- [ ] **Step 1: Write the failing test (append)**

```js
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";
import { getRoom, getRoomByUid, listRoomMembers, getRoomMessages } from "../servers/gateway/dashboard/panels/messages/rooms-store.js";

function fakeRes() { return { _r: null, redirectAfterPost(p) { this._r = p; return true; } }; }
// Capture fan-out by injecting a fake managers object.
function fakeManagers(sink) {
  return { identity: { crowId: "crow:me" }, nostrManager: { async sendMessage(ct, env) { sink.push([ct.id, JSON.parse(env)]); } } };
}

test("create_room → host room with members; room_join fanned to members", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const a = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, contact_type) VALUES ('crow:a','Alice','02"+"a".repeat(64)+"','crow')", args: [] });
    const aliceId = Number(a.lastInsertRowid);
    const sink = [];
    const req = { body: { action: "create_room", room_name: "Team", member_ids: String(aliceId) } };
    const res = fakeRes();
    const handled = await handlePostAction(req, res, { db, _managers: fakeManagers(sink) });
    assert.equal(handled, true);
    const room = (await db.execute("SELECT id FROM contact_groups WHERE room_uid IS NOT NULL")).rows[0];
    assert.ok(room, "room created");
    assert.equal((await listRoomMembers(db, room.id)).length, 1);
    assert.ok(sink.some((s) => s[1].subtype === "room_join"), "room_join sent");
  } finally { cleanup(); }
});

test("room_send (host) stores a sent row and fans out room_message", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const a = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, contact_type) VALUES ('crow:a','Alice','02"+"a".repeat(64)+"','crow')", args: [] });
    const aliceId = Number(a.lastInsertRowid);
    const { groupId, roomUid } = await createRoom(db, { name: "Team", memberContactIds: [aliceId], mode: "addressed", hostCrowId: "crow:me" });
    const sink = [];
    const req = { body: { action: "room_send", group_id: String(groupId), message: "hello team" } };
    const res = fakeRes();
    await handlePostAction(req, res, { db, _managers: fakeManagers(sink) });
    const msgs = await getRoomMessages(db, groupId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].direction, "sent");
    assert.equal(msgs[0].author_kind, "human");
    const fanned = sink.filter((s) => s[1].subtype === "room_message");
    assert.equal(fanned.length, 1);
    assert.equal(fanned[0][1].payload.room_uid, roomUid);
  } finally { cleanup(); }
});

test("room_set_mode / room_rename / room_remove_member / room_delete", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const a = await db.execute({ sql: "INSERT INTO contacts (crow_id, display_name, secp256k1_pubkey, contact_type) VALUES ('crow:a','Alice','02"+"a".repeat(64)+"','crow')", args: [] });
    const aliceId = Number(a.lastInsertRowid);
    const { groupId } = await createRoom(db, { name: "Team", memberContactIds: [aliceId], mode: "addressed", hostCrowId: "crow:me" });
    const sink = [];
    const run = async (body) => { const res = fakeRes(); await handlePostAction({ body }, res, { db, _managers: fakeManagers(sink) }); };
    await run({ action: "room_set_mode", group_id: String(groupId), mode: "always" });
    assert.equal((await getRoom(db, groupId)).mode, "always");
    await run({ action: "room_rename", group_id: String(groupId), room_name: "Squad" });
    assert.equal((await getRoom(db, groupId)).name, "Squad");
    await run({ action: "room_remove_member", group_id: String(groupId), contact_id: String(aliceId) });
    assert.equal((await listRoomMembers(db, groupId)).length, 0);
    await run({ action: "room_delete", group_id: String(groupId) });
    assert.equal(await getRoom(db, groupId), null);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/messages-room-actions.test.js`
Expected: FAIL (actions not handled).

- [ ] **Step 3: Implement — add room actions to `handlePostAction`**

In `servers/gateway/dashboard/panels/messages/api-handlers.js`:

(a) Add imports at the top:
```js
import { randomBytes } from "node:crypto";
import {
  createRoom, getRoom, listRoomMembers, addMember, removeMember,
  setMode, renameRoom, deleteRoom, insertRoomMessage, computeAddressedTo,
} from "./rooms-store.js";
import { buildRoomMessageEnvelope, buildRoomJoinEnvelope, fanOut } from "../../../../sharing/room-fanout.js";
import { ensureLocalBotContact } from "../../shared/ensure-local-bot-contact.js";
```

(b) Change the signature to accept an injectable managers seam (defaults to the real one):
```js
export async function handlePostAction(req, res, { db, sharingClientFactory = getSharingClient, _managers = null }) {
  const managers = _managers || getManagersOrNull();
  const { action } = req.body;
```
(`getManagersOrNull` is already imported at line 11.)

(c) Add these branches before the final `return false;`:
```js
  if (action === "create_room" && req.body.room_name) {
    // member_ids arrives as a comma string (single field) OR an array (repeated
    // checkbox fields from the New Group form) — normalize both.
    const rawMembers = req.body.member_ids;
    const memberIds = (Array.isArray(rawMembers) ? rawMembers : String(rawMembers || "").split(","))
      .map((s) => parseInt(String(s).trim(), 10)).filter((n) => Number.isInteger(n));
    const mode = req.body.mode === "always" ? "always" : "addressed";
    const hostCrowId = managers?.identity?.crowId || null;
    const { groupId, roomUid } = await createRoom(db, { name: req.body.room_name.trim(), memberContactIds: memberIds, mode, hostCrowId });
    // Notify members so their client materializes the room.
    if (managers?.nostrManager) {
      const members = await listRoomMembers(db, groupId);
      const roster = members.map((m) => ({ crow_id: m.crow_id, display_name: m.display_name }));
      const join = buildRoomJoinEnvelope({ roomUid, roomName: req.body.room_name.trim(), hostCrowId, members: roster });
      await fanOut({ nostrManager: managers.nostrManager, members, envelope: join, log: (m) => console.error("[rooms]", m) });
    }
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + groupId);
  }

  if (action === "room_send" && req.body.group_id && req.body.message) {
    const groupId = parseInt(req.body.group_id, 10);
    const room = await getRoom(db, groupId);
    if (!room) return res.redirectAfterPost("/dashboard/messages");
    const msgUid = randomBytes(16).toString("hex");
    const myCrowId = managers?.identity?.crowId || null;
    const author = { kind: "human", crow_id: myCrowId, display_name: managers?.identity?.displayName || "You" };
    await insertRoomMessage(db, { groupId, msgUid, senderContactId: null, senderLabel: "You", authorKind: "human", content: req.body.message, direction: "sent" });
    if (managers?.nostrManager) {
      const members = await listRoomMembers(db, groupId);
      const isHost = !room.host_crow_id || room.host_crow_id === myCrowId;
      if (isHost) {
        const botRoster = members.filter((m) => Number(m.is_bot) === 1).map((m) => ({ contactId: m.id, name: m.display_name || m.crow_id }));
        const addressedTo = room.mode === "always" ? botRoster.map((b) => b.name) : computeAddressedTo(req.body.message, botRoster);
        const env = buildRoomMessageEnvelope({ roomUid: room.room_uid, roomName: room.name, hostCrowId: myCrowId, msgUid, author, text: req.body.message, addressedTo });
        await fanOut({ nostrManager: managers.nostrManager, members, envelope: env, log: (m) => console.error("[rooms]", m) });
      } else {
        // Participant: send only to the host, who re-fans. addressed_to left to the host.
        const host = members.find((m) => m.crow_id === room.host_crow_id);
        const env = buildRoomMessageEnvelope({ roomUid: room.room_uid, roomName: room.name, hostCrowId: room.host_crow_id, msgUid, author, text: req.body.message, addressedTo: [] });
        if (host) await fanOut({ nostrManager: managers.nostrManager, members: [host], envelope: env });
      }
    }
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + groupId);
  }

  if (action === "room_add_member" && req.body.group_id && req.body.contact_id) {
    await addMember(db, parseInt(req.body.group_id, 10), parseInt(req.body.contact_id, 10));
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + parseInt(req.body.group_id, 10));
  }
  if (action === "room_add_bot" && req.body.group_id && req.body.bot_id) {
    const cid = await ensureLocalBotContact(db, req.body.bot_id.trim(), { displayName: req.body.bot_display_name || null });
    if (cid != null) await addMember(db, parseInt(req.body.group_id, 10), cid);
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + parseInt(req.body.group_id, 10));
  }
  if (action === "room_remove_member" && req.body.group_id && req.body.contact_id) {
    await removeMember(db, parseInt(req.body.group_id, 10), parseInt(req.body.contact_id, 10));
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + parseInt(req.body.group_id, 10));
  }
  if (action === "room_set_mode" && req.body.group_id) {
    await setMode(db, parseInt(req.body.group_id, 10), req.body.mode === "always" ? "always" : "addressed");
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + parseInt(req.body.group_id, 10));
  }
  if (action === "room_rename" && req.body.group_id && req.body.room_name) {
    await renameRoom(db, parseInt(req.body.group_id, 10), req.body.room_name.trim());
    return res.redirectAfterPost("/dashboard/messages?openRoom=" + parseInt(req.body.group_id, 10));
  }
  if (action === "room_delete" && req.body.group_id) {
    await deleteRoom(db, parseInt(req.body.group_id, 10));
    return res.redirectAfterPost("/dashboard/messages");
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/messages-room-actions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add servers/gateway/dashboard/panels/messages/api-handlers.js tests/messages-room-actions.test.js
git commit servers/gateway/dashboard/panels/messages/api-handlers.js tests/messages-room-actions.test.js -m "feat(crow-messages): room POST action handlers (create/send/manage)"
```

---

## Task 10: UI — New Group popover, room thread, settings, i18n

This task is rendering + JS only (no new logic paths). Verify by a render smoke test + manual preview. Follow the exact patterns in `html.js` (popover items, dialogs, `csrf`), `client.js` (dialog toggles), and `i18n.js` (EN+ES pairs).

**Files:**
- Modify: `servers/gateway/dashboard/shared/i18n.js`
- Modify: `servers/gateway/dashboard/panels/messages/html.js`
- Modify: `servers/gateway/dashboard/panels/messages/client.js`
- Modify: `servers/gateway/dashboard/panels/messages/css.js`
- Test: `tests/messages-room-render.test.js` (create)

- [ ] **Step 1: Add i18n keys (EN + ES)**

In `servers/gateway/dashboard/shared/i18n.js`, in the `translations` object, add:
```js
"messages.newGroup": { en: "New Group", es: "Nuevo grupo" },
"messages.newGroupDesc": { en: "Start a multi-party room with people and bots", es: "Inicia una sala con personas y bots" },
"messages.groupName": { en: "Group name", es: "Nombre del grupo" },
"messages.groupMembers": { en: "Add members (people and bots)", es: "Agregar miembros (personas y bots)" },
"messages.createGroupBtn": { en: "Create Group", es: "Crear grupo" },
"messages.roomMode": { en: "Bot replies", es: "Respuestas de bots" },
"messages.roomModeAddressed": { en: "Only when addressed", es: "Solo cuando se le menciona" },
"messages.roomModeAlways": { en: "To every message", es: "A cada mensaje" },
"messages.roomMembers": { en: "Members", es: "Miembros" },
"messages.roomAddMember": { en: "Add member", es: "Agregar miembro" },
"messages.roomRename": { en: "Rename", es: "Renombrar" },
"messages.roomDelete": { en: "Delete room", es: "Eliminar sala" },
"messages.roomLeaveHint": { en: "Bots reply only to people, never to each other.", es: "Los bots responden solo a personas, nunca entre ellos." },
```

- [ ] **Step 2: Add the "New Group" popover item + create dialog (`html.js`)**

In `servers/gateway/dashboard/panels/messages/html.js`, after the existing `msgOpenBotDirectory()` popover item (~line 141-144), add a sibling popover item:
```js
        <div class="msg-popover-item" onclick="msgShowCreateGroupDialog()">
          <div class="msg-popover-item-title">${t("messages.newGroup", lang)}</div>
          <div class="msg-popover-item-desc">${t("messages.newGroupDesc", lang)}</div>
        </div>
```
And add a dialog near the other `msg-invite-dialog` blocks. `contactsForPicker` is the existing contacts list available to the panel (the same list used to render conversations) — render a checkbox per contact, bots labeled:
```js
      <div class="msg-invite-dialog" id="invite-group">
        <form method="POST">
          <input type="hidden" name="action" value="create_room">
          <input name="room_name" placeholder="${t("messages.groupName", lang)}" required maxlength="80" class="msg-input">
          <label class="msg-room-mode">
            ${t("messages.roomMode", lang)}:
            <select name="mode">
              <option value="addressed">${t("messages.roomModeAddressed", lang)}</option>
              <option value="always">${t("messages.roomModeAlways", lang)}</option>
            </select>
          </label>
          <div class="msg-member-picker">
            <div class="msg-member-picker-label">${t("messages.groupMembers", lang)}</div>
            ${(contactsForPicker || []).map((c) => `
              <label class="msg-member-opt">
                <input type="checkbox" name="member_ids" value="${c.id}">
                ${c.is_bot ? '<span class="msg-bot-badge">bot</span> ' : ""}${escapeHtml(c.display_name || c.crow_id)}
              </label>`).join("")}
          </div>
          ${csrf || ""}
          <button type="submit" class="msg-send-btn msg-room-create-btn">${t("messages.createGroupBtn", lang)}</button>
        </form>
        <div class="msg-room-hint">${t("messages.roomLeaveHint", lang)}</div>
      </div>
```
NOTE: `member_ids` is sent as repeated checkbox fields; Express collects repeated fields into an array. The Task 9 `create_room` handler already normalizes both an array and a comma string — no further change needed here.

Use the existing `escapeHtml` helper already imported in `html.js` (confirm it's imported; the panel already escapes bot titles per the arc). `contactsForPicker` and `csrf` come from the panel's render data — thread them through where the panel calls the html render (the panel already passes `csrf`; add `contactsForPicker` from the same contacts query used for the conversation list).

- [ ] **Step 3: Render the room thread + settings (`html.js`)**

When `openRoom` (or `?openRoom=<groupId>`) is set, the panel renders a room thread instead of a 1:1 thread. Add a `renderRoomThread({ room, members, messages, lang, csrf })` helper in `html.js`:
```js
export function renderRoomThread({ room, members, messages, lang, csrf, escapeHtml }) {
  const bubbles = (messages || []).map((m) => `
    <div class="msg-bubble ${m.direction === "sent" ? "sent" : "received"}">
      <div class="msg-bubble-sender">${m.author_kind === "bot" ? '<span class="msg-bot-badge">bot</span> ' : ""}${escapeHtml(m.sender_name || m.sender_label || "You")}</div>
      <div class="msg-bubble-text">${escapeHtml(m.content)}</div>
    </div>`).join("");
  const memberChips = (members || []).map((m) => `
    <span class="msg-room-chip">${Number(m.is_bot) === 1 ? '<span class="msg-bot-badge">bot</span> ' : ""}${escapeHtml(m.display_name || m.crow_id)}
      <form method="POST" class="msg-chip-x"><input type="hidden" name="action" value="room_remove_member"><input type="hidden" name="group_id" value="${room.id}"><input type="hidden" name="contact_id" value="${m.id}">${csrf || ""}<button type="submit" title="${t("common.remove", lang)}">×</button></form>
    </span>`).join("");
  return `
    <div class="msg-room-header">
      <span class="msg-room-title">${escapeHtml(room.name)}</span>
      <span class="msg-room-members">${memberChips}</span>
      <form method="POST" class="msg-room-mode-form">
        <input type="hidden" name="action" value="room_set_mode"><input type="hidden" name="group_id" value="${room.id}">
        <select name="mode" onchange="this.form.requestSubmit()">
          <option value="addressed" ${room.mode !== "always" ? "selected" : ""}>${t("messages.roomModeAddressed", lang)}</option>
          <option value="always" ${room.mode === "always" ? "selected" : ""}>${t("messages.roomModeAlways", lang)}</option>
        </select>${csrf || ""}
      </form>
    </div>
    <div class="msg-thread">${bubbles}</div>
    <form method="POST" class="msg-composer">
      <input type="hidden" name="action" value="room_send"><input type="hidden" name="group_id" value="${room.id}">
      <input name="message" class="msg-input" placeholder="Message ${escapeHtml(room.name)}… (use @name to address a bot)" required autocomplete="off">
      ${csrf || ""}
      <button type="submit" class="msg-send-btn">→</button>
    </form>`;
}
```
Wire the panel: where it currently decides to render a 1:1 thread when `open=<contactId>`, add an `openRoom=<groupId>` branch that loads `getRoom`, `listRoomMembers`, `getRoomMessages` and calls `renderRoomThread`. Mark room messages read on open: `UPDATE room_messages SET is_read = 1 WHERE group_id = ? AND direction = 'received'`. Add `"common.remove": { en: "Remove", es: "Quitar" }` to i18n if not present.

- [ ] **Step 4: Add the dialog toggle + @-helper (`client.js`)**

In `servers/gateway/dashboard/panels/messages/client.js`, mirror `msgShowInviteDialog`:
```js
function msgShowCreateGroupDialog() {
  document.querySelectorAll('.msg-invite-dialog').forEach(function (d) { d.classList.remove('visible'); });
  var dialog = document.getElementById('invite-group');
  if (dialog) dialog.classList.toggle('visible');
  var pop = document.getElementById('msg-popover');
  if (pop) pop.classList.remove('visible');
}
```
(The `@`-mention picker is sugar; the host computes `addressed_to` authoritatively, so a plain text input is sufficient for v1. Skip a JS autocomplete to keep scope tight — the placeholder already tells the user to type `@name`.)

- [ ] **Step 5: Add minimal CSS (`css.js`)**

Append room styles to the exported CSS string in `servers/gateway/dashboard/panels/messages/css.js` (match existing class naming + variables):
```css
.msg-member-picker { max-height: 180px; overflow-y: auto; margin: 8px 0; border: 1px solid var(--border, #333); border-radius: 6px; padding: 6px; }
.msg-member-opt { display: block; padding: 3px 4px; font-size: 0.82rem; cursor: pointer; }
.msg-room-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border, #333); }
.msg-room-title { font-weight: 600; }
.msg-room-chip { display: inline-flex; align-items: center; gap: 3px; background: var(--chip-bg, #222); border-radius: 10px; padding: 1px 8px; font-size: 0.75rem; }
.msg-chip-x { display: inline; } .msg-chip-x button { background: none; border: none; color: inherit; cursor: pointer; }
.msg-room-hint, .msg-room-mode { font-size: 0.75rem; opacity: 0.7; margin-top: 6px; }
.msg-bubble-sender { font-size: 0.7rem; opacity: 0.7; margin-bottom: 2px; }
```

- [ ] **Step 6: Write a render smoke test**

`tests/messages-room-render.test.js`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRoomThread } from "../servers/gateway/dashboard/panels/messages/html.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

test("renderRoomThread shows bot badge, sender labels, addressed placeholder, and CSRF", () => {
  const html = renderRoomThread({
    room: { id: 5, name: "Team", mode: "addressed" },
    members: [{ id: 1, display_name: "Alice", is_bot: 0 }, { id: 2, display_name: "Research Bot", is_bot: 1 }],
    messages: [
      { direction: "sent", author_kind: "human", sender_name: null, sender_label: "You", content: "hi" },
      { direction: "received", author_kind: "bot", sender_name: "Research Bot", content: "hello" },
    ],
    lang: "en", csrf: '<input type="hidden" name="_csrf" value="t">', escapeHtml: esc,
  });
  assert.match(html, /Research Bot/);
  assert.match(html, /msg-bot-badge/);
  assert.match(html, /name="action" value="room_send"/);
  assert.match(html, /_csrf/);
  assert.match(html, /@name to address a bot/);
});
```

- [ ] **Step 7: Run + commit**

Run: `node --test --test-force-exit tests/messages-room-render.test.js`
Expected: PASS.
```bash
git add servers/gateway/dashboard/shared/i18n.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/panels/messages/css.js tests/messages-room-render.test.js
git commit servers/gateway/dashboard/shared/i18n.js servers/gateway/dashboard/panels/messages/html.js servers/gateway/dashboard/panels/messages/client.js servers/gateway/dashboard/panels/messages/css.js tests/messages-room-render.test.js -m "feat(crow-messages): room UI — New Group, room thread, settings, i18n"
```

---

## Task 11: Full-suite + boot verification

- [ ] **Step 1: Run the full test suite**

Run: `node --test --test-force-exit tests/*.test.js`
Expected: All pass (the prior baseline was 746/746; this adds the new files). Investigate any failure before proceeding.

- [ ] **Step 2: Verify the module graphs load**

Run:
```bash
node --input-type=module -e 'await import("./servers/sharing/boot.js"); await import("./servers/sharing/room-inbound.js"); await import("./servers/gateway/dashboard/panels/messages/api-handlers.js"); await import("./scripts/pi-bots/gateways/crow-messages.mjs"); console.log("graphs ok")'
```
Expected: prints `graphs ok`.

- [ ] **Step 3: Format**

Run the repo formatter if present (`npm run format` or the `/format` skill). Commit any formatting changes.

- [ ] **Step 4: Final commit (if Step 3 changed anything)**
```bash
git commit -m "chore(crow-messages): format phase 3a room threads" <changed paths>
```

---

## Self-review notes (gaps closed during planning)

- **`member_ids` array vs comma string** — handler normalizes both (Task 9 Step 3 / Task 10 Step 2).
- **Host vs participant send** — `room_send` branches on `host_crow_id` (Task 9); both paths exist because remote humans run identical code in 3a.
- **Loop safety** — enforced in TWO independent places: the bot adapter gate (`author.kind!=='human'` → no turn, Task 7) and the host never sets `addressed_to` for bot-authored messages (Task 6/9). Tested in `room-adapter.test.js`.
- **Dedup** — `room_messages(group_id,msg_uid)` UNIQUE + `insertRoomMessage` returns false on dup; the host skips re-fan on a dup (Task 6).
- **Trust** — bot accepts only its own-host signer (Task 7); host accepts only room-member signers (Task 6). Both fail-closed, both tested.

## After implementation (NOT part of the TDD tasks)

- **Plan-review** this plan before executing (`plan-reviewer` skill) — phase 2's review caught a real migration-signature bug.
- **`/security-review`** on the branch before merge.
- **Deploy (schema change + adapter change):** per data dir, `CROW_DB_PATH=<db> node scripts/init-db.js` → verify columns/table via PRAGMA → restart gateway(s) → **restart `pibot-gateways@<inst>`** (adapter changed — unlike phases 1/2). Hosts: crow `~/.crow` :3001, MPA `~/.crow-mpa` :3006 (GPU/bot host), grackle `~/crow` :3002, black-swan `~/crow` :3001.
- **Live-verify cross-instance:** create a real room with one local bot + one remote human contact; confirm the bot answers only when addressed, the human sees the bot's reply (re-fan works), and a second bot stays silent. Not "tests pass."
- **Docs TODO** (the standing operator ask): after this ships, document the whole Crow Messages arc in the public VitePress/GitHub docs (EN+ES) — see the handoff `session-handoff-2026-06-16-crow-messages-phase3-and-docs`.
