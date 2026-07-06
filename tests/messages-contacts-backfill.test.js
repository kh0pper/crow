import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const SECP = "a".repeat(64);

// R2b: helpers the drain test (I-B1) depends on — signedEntry mirrors the one
// in messages-sync.test.js; fakeFeedWith matches _processNewEntriesInner's
// contract exactly (iterates seq < feed.length, awaits feed.get(seq)).
import { sign } from "../servers/sharing/identity.js";
function signedEntry(table, op, row, lamport_ts) {
  const entry = { table, op, row, lamport_ts, instance_id: "peer-1" };
  entry.signature = sign(JSON.stringify(entry), IDENTITY.ed25519Priv);
  return entry;
}
const fakeFeedWith = (entries) => ({ length: entries.length, async get(seq) { return entries[seq]; } });

function freshMgr(label, id) {
  const d = mkdtempSync(join(tmpdir(), `crow-p3b-backfill-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: d }, stdio: "pipe" });
  after(() => rmSync(d, { recursive: true, force: true }));
  const m = new InstanceSyncManager(IDENTITY, createDbClient(join(d, "crow.db")), id);
  // Pretend a peer feed is open so backfill doesn't early-return "no-peers";
  // give it a fake append so the wrapped emitChange doesn't touch a real Hypercore.
  m.feedsDisabled = false;
  m.outFeeds.set("peer-1", { append: async () => {} });
  return m;
}

test("backfillContactsOnce: re-emits syncable full contacts once, then no-ops on re-run (idempotent)", async () => {
  const m = freshMgr("idem", "local-1"); const db = m.db;
  const emitted = [];
  const orig = m.emitChange.bind(m);
  m.emitChange = async (t, o, r) => { emitted.push({ t, crow: r.crow_id }); return orig(t, o, r); };
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:full1','ed', ?, 'Full One')", args: [SECP] });
  const n1 = await m.backfillContactsOnce();
  assert.equal(n1, 1, "one syncable contact re-emitted");
  assert.ok(emitted.some((e) => e.t === "contacts" && e.crow === "crow:full1"));
  // Re-run: flag guards → no-op (no repeated thrash).
  emitted.length = 0;
  const n2 = await m.backfillContactsOnce();
  assert.equal(n2, 0, "flag-guarded second run is a no-op");
  assert.equal(emitted.length, 0, "no re-emit on the guarded second run");
});

test("backfillContactsOnce: excludes pending, local-bot, and blocked contacts (SELECT filter)", async () => {
  const m = freshMgr("filter", "local-2"); const db = m.db;
  const emitted = [];
  m.emitChange = async (_t, _o, r) => { emitted.push(r.crow_id); }; // bypass real emit; the SELECT filter is what we assert
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:ok', 'ed', ?)", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, request_status) VALUES ('req:pending', 'ed', ?, 'pending')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, origin) VALUES ('crow:bot', 'ed', ?, 'local-bot')", args: [SECP] });
  await db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES ('crow:blk', 'ed', ?, 1)", args: [SECP] });
  const n = await m.backfillContactsOnce();
  assert.equal(n, 1, "only the one full accepted contact re-emitted");
  assert.deepEqual(emitted, ["crow:ok"]);
});

test("backfillContactsOnce: no armed peers → emits nothing but stays RETRYABLE (boot can race feed-init)", async () => {
  const m = freshMgr("nopeers", "local-3");
  m.outFeeds.clear(); // feeds not armed (yet) — e.g. the sharing boot hasn't opened them
  const emitted = [];
  m.emitChange = async (_t, _o, r) => emitted.push(r.crow_id);
  await m.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:solo', 'ed', ?)", args: [SECP] });
  assert.equal(await m.backfillContactsOnce(), 0);
  assert.equal(emitted.length, 0);
  // Observed live on grackle 2026-07-06: peers existed but boot raced feed-init,
  // and the old code marked 'no-peers' TERMINALLY — backfill never ran. Now the
  // no-peers path must NOT set the flag: once feeds arm, a later run backfills.
  m.outFeeds.set("peer-1", { append: async () => {} });
  assert.equal(await m.backfillContactsOnce(), 1, "retry with armed feeds must backfill");
  assert.deepEqual(emitted, ["crow:solo"]);
  // And only THEN is it terminal (done:<n> written as an UPSERT).
  assert.equal(await m.backfillContactsOnce(), 0, "now marked done — one-shot per lifetime");
  assert.equal(emitted.length, 1);
});

test("backfillContactsOnce: a stale 'no-peers' flag row from the pre-fix code is healed (UPSERT, no per-boot re-emit)", async () => {
  const m = freshMgr("staleflag", "local-5");
  m.outFeeds.set("peer-1", { append: async () => {} });
  await m.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:heal', 'ed', ?)", args: [SECP] });
  // Simulate the pre-fix state: flag stuck at 'no-peers' despite paired peers.
  await m.db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('__contacts_backfill_v1', 'no-peers', datetime('now'))",
    args: [],
  });
  const emitted = [];
  m.emitChange = async (_t, _o, r) => emitted.push(r.crow_id);
  assert.equal(await m.backfillContactsOnce(), 1, "stale no-peers is not terminal — backfill runs");
  const { rows } = await m.db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key='__contacts_backfill_v1'" });
  assert.equal(rows[0].value, "done:1", "done-mark UPSERTs over the stale row");
  assert.equal(await m.backfillContactsOnce(), 0, "terminal after the real run — no per-boot re-emit thrash");
  assert.equal(emitted.length, 1);
});

test("backfillContactsOnce: drains the inbound backlog BEFORE re-emitting (I-B1 — a peer's delivered block must win)", async () => {
  const m = freshMgr("ib1", "local-4");
  m.outFeeds.set("peer-1", { append: async () => {} });
  // Local stale contact: not blocked here…
  await m.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, is_blocked, lamport_ts) VALUES ('crow:divg', 'ed', ?, 0, 5)", args: [SECP] });
  // …but the peer already DELIVERED a newer block into our in-feed (not yet applied).
  const blockEntry = signedEntry("contacts", "update",
    { crow_id: "crow:divg", ed25519_pubkey: "ed", secp256k1_pubkey: SECP, is_blocked: 1 }, 9);
  m.inFeeds.set("peer-1", fakeFeedWith([blockEntry]));
  const emitted = [];
  const realEmit = m.emitChange.bind(m);
  m.emitChange = async (_t, _o, r) => emitted.push({ crow_id: r.crow_id, is_blocked: r.is_blocked });
  await m.backfillContactsOnce();
  // The drain applied the block first → the SELECT filter (is_blocked=0) excluded it → NOT re-emitted.
  assert.equal(emitted.filter((e) => e.crow_id === "crow:divg").length, 0,
    "a contact blocked by an already-delivered peer entry must not be re-emitted with fresh lamport");
  const { rows } = await m.db.execute({ sql: "SELECT is_blocked FROM contacts WHERE crow_id='crow:divg'" });
  assert.equal(Number(rows[0].is_blocked), 1, "the peer's delivered block was applied before the backfill emitted");
  m.emitChange = realEmit;
});
// fakeFeedWith(entries): minimal in-feed stub — { length: entries.length, async get(seq){ return entries[seq]; } }
// (matches the _processNewEntries contract: reads lastSeq via sync_state, iterates seq < length, feed.get(seq)).
