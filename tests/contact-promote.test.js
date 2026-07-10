/**
 * contact-promote — R4 Task 2. upsertFullContact is the single idempotent
 * write path for a full (request_status NULL) contact. Covers: fresh insert,
 * promotion of an accepted message-request in place, merge when a duplicate
 * full row already owns the crow_id, and no-op on an existing full contact.
 * managers wiring (sync/DHT/Nostr) is stubbed and its calls are asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertFullContact } from "../servers/sharing/contact-promote.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { writeTombstone, readTombstone } from "../servers/sharing/contact-delete.js";
import { registerContactsTools } from "../servers/sharing/tools/contacts.js";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";

/** Capture every emitChange the write path makes, returning a monotonic lamport. */
function captureSink() {
  const emits = [];
  let lamport = 1000;
  const sink = { emitChange: async (table, op, row) => { emits.push({ table, op, row }); return ++lamport; } };
  return { emits, sink, contactOps: () => emits.filter((e) => e.op !== "delete").map((e) => e.op) };
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = { init: [], join: [], sub: [] };
  return {
    calls,
    syncManager: { initContact: async (id) => calls.init.push(id) },
    peerManager: { joinContact: async (a) => calls.join.push(a) },
    nostrManager: { subscribeToContact: async (a) => calls.sub.push(a) },
  };
}

const PK = "02" + "a".repeat(64);          // 66-hex compressed
const PK_XONLY = "a".repeat(64);           // its 64-hex x-only tail
const ED = "b".repeat(64);
const CROW = "crow:testpeer01";

test("created — fresh full contact when nothing exists", async () => {
  const { db, cleanup } = freshDb();
  try {
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "created");
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [CROW] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_status, null);
    assert.equal(rows[0].ed25519_pubkey, ED);
    assert.equal(m.calls.init.length, 1);
    assert.equal(m.calls.join.length, 1);
    assert.equal(m.calls.sub.length, 1);
  } finally { cleanup(); }
});

test("promoted — an accepted request row becomes a full contact in place", async () => {
  const { db, cleanup } = freshDb();
  try {
    // Seed an accepted, secp-only request row (crow_id sentinel, empty ed25519).
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, NULL, '', ?, 'crow', 'accepted')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "promoted");
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?", args: [PK_XONLY],
    });
    assert.equal(rows.length, 1, "no duplicate row");
    assert.equal(rows[0].crow_id, CROW);
    assert.equal(rows[0].request_status, null);
    assert.equal(rows[0].ed25519_pubkey, ED);
    assert.equal(m.calls.join.length, 1, "promotion wires DHT join");
  } finally { cleanup(); }
});

test("merged — request messages fold into a pre-existing full contact, request row deleted", async () => {
  const { db, cleanup } = freshDb();
  try {
    // A full contact already owns CROW (e.g. added via crow_accept_invite)...
    const full = await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    const fullId = Number(full.lastInsertRowid);
    // ...and a separate request row for the SAME secp key accrued a message.
    const reqRow = await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'pending')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const reqId = Number(reqRow.lastInsertRowid);
    await db.execute({
      sql: `INSERT INTO messages (contact_id, nostr_event_id, content, direction, is_read, created_at)
            VALUES (?, 'evt-merge', 'hi', 'received', 0, datetime('now'))`,
      args: [reqId],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "merged");
    const reqGone = await db.execute({ sql: "SELECT id FROM contacts WHERE id = ?", args: [reqId] });
    assert.equal(reqGone.rows.length, 0, "request row deleted");
    const moved = await db.execute({ sql: "SELECT contact_id FROM messages WHERE nostr_event_id = 'evt-merge'", args: [] });
    assert.equal(Number(moved.rows[0].contact_id), fullId, "message reassigned to the full contact");
  } finally { cleanup(); }
});

test("noop — an existing full contact is left as-is (no re-wire)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    const m = stubManagers();
    const r = await upsertFullContact(db, m, { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "noop");
    assert.equal(m.calls.sub.length, 0, "no re-subscribe on a live full contact");
  } finally { cleanup(); }
});

test("rejects the req: sentinel and a missing secp key", async () => {
  const { db, cleanup } = freshDb();
  try {
    await assert.rejects(() => upsertFullContact(db, stubManagers(), { crowId: "req:" + PK_XONLY, ed25519Pub: ED, secp256k1Pub: PK }));
    await assert.rejects(() => upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: "" }));
  } finally { cleanup(); }
});

// --- Task 7: a re-add of a tombstoned crow_id MUST emit `insert` (design §D3.2). ---
// The applier distinguishes a genuine re-add from a stale rename ONLY by the op.
// upsertFullContact emits `update` from MERGE/PROMOTE today; under a tombstone that
// update would be dropped forever by every peer (R1-C1). These guards pin the fix.

// GUARD #4 (THE CRITICAL): the R1-C1 re-pair interleaving takes the PROMOTE branch.
test("tombstoned re-add via PROMOTE emits `insert`, not `update`, and clears the tombstone", async () => {
  const { db, cleanup } = freshDb();
  const CROW_Y = "crow:yyyyyyyyyy";
  try {
    // The emitting instance holds a tombstone for crow:Y (it APPLIED the delete)...
    await writeTombstone(db, CROW_Y, 100);
    // ...there is NO crow:Y row (delete removed it)...
    // ...but the deleted peer DM'd us, so an L6 `req:<secp>` pending row exists for its secp.
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, NULL, '', ?, 'crow', 'pending')`,
      args: ["req:" + PK_XONLY, PK],
    });
    const cap = captureSink();
    __setEmitSinkForTest(cap.sink);
    const r = await upsertFullContact(db, stubManagers(), { crowId: CROW_Y, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "promoted", "re-invite rebinds the req: row → PROMOTE");
    assert.deepEqual(cap.contactOps(), ["insert"], "a tombstoned re-add MUST emit insert, never update");
    assert.equal(await readTombstone(db, CROW_Y), null, "the local re-add supersedes and clears the tombstone");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

// GUARD #2 shape: the MERGE outcome under a tombstone must also emit `insert`.
test("tombstoned re-add via MERGE emits `insert`, not `update`, and clears the tombstone", async () => {
  const { db, cleanup } = freshDb();
  try {
    // A full contact already owns CROW and a same-secp request row also exists → MERGE.
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
            VALUES (?, '', ?, 'crow', 'pending')`,
      args: ["req:" + PK_XONLY, PK],
    });
    await writeTombstone(db, CROW, 100);
    const cap = captureSink();
    __setEmitSinkForTest(cap.sink);
    const r = await upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "merged");
    assert.deepEqual(cap.contactOps(), ["insert"], "MERGE under a tombstone emits insert");
    assert.equal(await readTombstone(db, CROW), null, "tombstone cleared");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

// GUARD #4 negative half + common-path invariant: with NO tombstone, byte-identical
// to today — PROMOTE emits `update`, MERGE emits `update`, CREATE emits `insert`.
test("no tombstone: PROMOTE and MERGE emit `update`, CREATE emits `insert` (common path unchanged)", async () => {
  // PROMOTE → update
  {
    const { db, cleanup } = freshDb();
    try {
      await db.execute({
        sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
              VALUES (?, NULL, '', ?, 'crow', 'pending')`,
        args: ["req:" + PK_XONLY, PK],
      });
      const cap = captureSink();
      __setEmitSinkForTest(cap.sink);
      const r = await upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
      assert.equal(r.outcome, "promoted");
      assert.deepEqual(cap.contactOps(), ["update"], "PROMOTE without a tombstone still emits update");
    } finally { __setEmitSinkForTest(null); cleanup(); }
  }
  // MERGE → update
  {
    const { db, cleanup } = freshDb();
    try {
      await db.execute({
        sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
              VALUES (?, 'Peer', ?, ?, 'crow')`,
        args: [CROW, ED, PK],
      });
      await db.execute({
        sql: `INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, contact_type, request_status)
              VALUES (?, '', ?, 'crow', 'pending')`,
        args: ["req:" + PK_XONLY, PK],
      });
      const cap = captureSink();
      __setEmitSinkForTest(cap.sink);
      const r = await upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
      assert.equal(r.outcome, "merged");
      assert.deepEqual(cap.contactOps(), ["update"], "MERGE without a tombstone still emits update");
    } finally { __setEmitSinkForTest(null); cleanup(); }
  }
  // CREATE → insert
  {
    const { db, cleanup } = freshDb();
    try {
      const cap = captureSink();
      __setEmitSinkForTest(cap.sink);
      const r = await upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
      assert.equal(r.outcome, "created");
      assert.deepEqual(cap.contactOps(), ["insert"], "CREATE emits insert as always");
    } finally { __setEmitSinkForTest(null); cleanup(); }
  }
});

// CREATE under a tombstone: op is unchanged (insert), but the tombstone must clear.
test("tombstoned re-add via CREATE emits `insert` and clears the tombstone", async () => {
  const { db, cleanup } = freshDb();
  try {
    await writeTombstone(db, CROW, 100);
    const cap = captureSink();
    __setEmitSinkForTest(cap.sink);
    const r = await upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "created");
    assert.deepEqual(cap.contactOps(), ["insert"]);
    assert.equal(await readTombstone(db, CROW), null, "CREATE clears a coexisting tombstone");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

// NOOP under a coexisting tombstone (row present + tombstone, the D3.1(a) state):
// clear the tombstone, but do NOT emit.
test("tombstoned NOOP clears the tombstone and emits nothing", async () => {
  const { db, cleanup } = freshDb();
  try {
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type)
            VALUES (?, 'Peer', ?, ?, 'crow')`,
      args: [CROW, ED, PK],
    });
    await writeTombstone(db, CROW, 100);
    const cap = captureSink();
    __setEmitSinkForTest(cap.sink);
    const r = await upsertFullContact(db, stubManagers(), { crowId: CROW, ed25519Pub: ED, secp256k1Pub: PK, displayName: "Peer" });
    assert.equal(r.outcome, "noop");
    assert.deepEqual(cap.emits, [], "NOOP emits nothing, tombstone or not");
    assert.equal(await readTombstone(db, CROW), null, "a coexisting tombstone is cleared on NOOP");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});

// crow_accept_bot_invite has its own INSERT (already emits `insert`); it must also
// clear a tombstone for the bot's crowId. Drive the REAL handler (honest seam).
test("crow_accept_bot_invite clears a tombstone for the bot's crowId", async () => {
  const { db, cleanup } = freshDb();
  try {
    const botIdent = deriveBotIdentity(randomBytes(32), "tombstoned-bot");
    const code = generateBotInviteCode(botIdent, "tok-1", [], "Rebot");
    const botCrowId = parseBotInviteCode(code).botCrowId;
    await writeTombstone(db, botCrowId, 100);

    // Capture the registered tool handler without spinning a real MCP server.
    const handlers = {};
    const server = { tool: (name, _desc, _schema, fn) => { handlers[name] = fn; } };
    const identity = { crowId: "crow:me00000000", ed25519Pubkey: "ee".repeat(16), secp256k1Pubkey: "cc".repeat(33) };
    const nostrManager = {
      relays: new Map(),
      connectRelays: async () => {},
      sendMessage: async () => {},
      subscribeToContact: async () => {},
    };
    const syncManager = { initContact: async () => {} };
    registerContactsTools(server, { db, identity, peerManager: {}, syncManager, nostrManager });

    __setEmitSinkForTest(captureSink().sink); // absorb the insert emit, avoid managers.js
    const res = await handlers["crow_accept_bot_invite"]({ invite_code: code });
    assert.equal(res.isError, undefined, "accept succeeded");
    const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ?", args: [botCrowId] });
    assert.equal(rows.length, 1, "bot contact inserted");
    assert.equal(await readTombstone(db, botCrowId), null, "the bot's tombstone is cleared on accept");
  } finally { __setEmitSinkForTest(null); cleanup(); }
});
