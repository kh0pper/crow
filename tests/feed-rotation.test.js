/**
 * Item 2d gate: feed-key rotation (spec 2026-07-15-feed-key-rotation-design.md §7).
 * REAL Hypercores + REAL replication over NoiseSecretStream on a TCP socketpair —
 * the existing suites apply entries directly and cannot see replication-layer
 * defects (that blindness is what let D1/D2 ship).
 *
 * HARNESS: two real instances (each its own mkdtemp CROW_DATA_DIR + real init-db +
 * real InstanceSyncManager), joined by a real NoiseSecretStream pair over a real
 * TCP socketpair — adapted from tests/lamport-reemit.test.js's newFleet() pattern
 * (per-side real init-db SQLite, one SHARED identity object, crow_instances peer
 * row seeding), but replicating over the actual wire instead of a fake out-feed.
 *
 * NEVER point this file at ~/.crow — it opens real Hypercore feeds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import NoiseSecretStream from "@hyperswarm/secret-stream";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── shared identity ──────────────────────────────────────────────────────────
// instance-sync verifies every entry against `this.identity.ed25519Pubkey`, and
// a user's instances share one identity — both managers MUST use the same object
// (tests/lamport-reemit.test.js pattern). getPublicKey is async, so resolve it
// once into the identity shape InstanceSyncManager expects.
async function makeSharedIdentity() {
  const TEST_PRIV = Buffer.alloc(32, 0x2c);
  const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
  return { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
}

/** Real init-db.js run against a fresh dir — same mechanism as lamport-reemit.test.js. */
async function makeRealDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db (init-db.js:11) — blank it, or
    // a shell exporting it would run the migration against the REAL DB.
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  return createDbClient(join(dir, "crow.db"));
}

/** Seed `db`'s crow_instances with peerId as an active paired peer. */
async function registerPeerRow(db, peerId) {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, 'active')",
    args: [peerId, peerId, `crow:${peerId}`],
  });
}

async function makeSide(identity, id) {
  const dir = mkdtempSync(join(tmpdir(), `rot-${id}-`));
  const db = await makeRealDb(dir); // ← same helper style as lamport-reemit.test.js
  const mgr = new InstanceSyncManager(identity, db, id);
  mgr.dataDir = join(dir, "instance-sync"); // MUST: keep test feeds out of ~/.crow
  mgr.feedsDisabled = false;                // MUST: scratch env disables feeds (2c C6)
  return { mgr, db, dir, id };
}

export async function makeFleet() {
  const identity = await makeSharedIdentity(); // same object for both sides
  const a = await makeSide(identity, "instA");
  const b = await makeSide(identity, "instB");
  // Register each other in crow_instances so eager/boot paths see a paired row.
  await registerPeerRow(a.db, b.id);
  await registerPeerRow(b.db, a.id);
  return {
    a, b,
    async cleanup() {
      await a.mgr.close(); await b.mgr.close();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    },
  };
}

/** Real socketpair: two net.Sockets connected through an ephemeral local server. */
function socketPair() {
  return new Promise((resolve, reject) => {
    // Declared here (not inside the listen callback below) so both callbacks —
    // siblings, not nested — close over the SAME binding. `var` inside the
    // listen callback would hoist only to that inner function's scope and
    // leave the reference in the connection callback unbound.
    let clientSide;
    const server = net.createServer((serverSide) => {
      server.close();
      resolve([serverSide, clientSide]);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      clientSide = net.connect(server.address().port, "127.0.0.1");
      clientSide.on("error", reject);
    });
  });
}

export async function linkPeers(a, b) {
  const [sockA, sockB] = await socketPair();
  const nsA = new NoiseSecretStream(true, sockA);
  const nsB = new NoiseSecretStream(false, sockB);
  nsA.on("error", () => {}); nsB.on("error", () => {});
  // Exchange feed keys the way the real handshake does, then replicate.
  await a.mgr.initInstance(b.id, b.mgr.getOutFeedKey(a.id));
  await b.mgr.initInstance(a.id, a.mgr.getOutFeedKey(b.id));
  await a.mgr.replicate(b.id, nsA);
  await b.mgr.replicate(a.id, nsB);
  return { streams: [nsA, nsB], close: () => { nsA.destroy(); nsB.destroy(); } };
}

/** Await until fn() is truthy or the deadline passes — condition-based, no bare sleeps. */
export async function until(fn, ms = 5000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

test("G0 baseline: real replication applies an emitted row across the socketpair", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    // Arm feeds by exchanging real keys BEFORE linking (linkPeers does both).
    link = await linkPeers(fleet.a, fleet.b);
    // memories.id is INTEGER PRIMARY KEY AUTOINCREMENT (real schema, scripts/init-db.js) —
    // a text id like "rot-g0" throws SQLITE datatype mismatch on the receiving INSERT,
    // so the emitted row's id must be a real integer (adapted from the brief's literal
    // string id, which does not survive against the real table).
    const G0_ID = 700001;
    await fleet.a.mgr.emitChange("memories", "insert",
      { id: G0_ID, content: "rot-g0 hello", lamport_ts: null });
    const applied = await until(async () => {
      const { rows } = await fleet.b.db.execute({
        sql: "SELECT id FROM memories WHERE id = ?", args: [G0_ID] });
      return rows.length === 1;
    });
    assert.equal(applied, true, "row emitted on A must apply on B via real replication");
  } finally {
    // link.close() BEFORE fleet.cleanup() regardless of pass/fail — an assertion
    // throw must not strand the NoiseSecretStream/TCP sockets open (they held the
    // whole process open past a failing run in early iteration of this harness).
    if (link) link.close();
    await fleet.cleanup();
  }
});

// ── unit tests ────────────────────────────────────────────────────────────────

test("C2 unit: set writes {k,s} object; get is key-gated; null-feed coerces both shapes", async () => {
  const fleet = await makeFleet();
  try {
    const { mgr, db } = fleet.a;
    const PEER = fleet.b.id;
    const keyX = "aa".repeat(32), keyY = "bb".repeat(32);
    await mgr._setLastAppliedSeq(PEER, 7, keyX);
    // Raw storage shape: a JSON object, not a string (spec C2 SQL note / R2 #7).
    const { rows } = await db.execute({
      sql: "SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?",
      args: [mgr.localInstanceId] });
    const rec = JSON.parse(rows[0].b)[PEER];
    assert.equal(typeof rec, "object", "must store an object, not a JSON string");
    assert.equal(rec.k, keyX); assert.equal(rec.s, 7);
    // Key-gated reads:
    assert.equal(await mgr._getLastAppliedSeq(PEER, { key: Buffer.from(keyX, "hex") }), 7);
    assert.equal(await mgr._getLastAppliedSeq(PEER, { key: Buffer.from(keyY, "hex") }), 0,
      "foreign-key record must read 0");
    // Display path (feed=null) coerces the object:
    assert.equal(await mgr._getLastAppliedSeq(PEER, null), 7);
    // Legacy numeric display coercion (R3 F-F): write a bare number the old way.
    await db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 42) WHERE instance_id = ?`,
      args: [`$."${PEER}"`, mgr.localInstanceId] });
    assert.equal(await mgr._getLastAppliedSeq(PEER, null), 42, "legacy bare number coerces");
  } finally { await fleet.cleanup(); }
});

// ── C2 reconcile-at-open (2d Task 3) ───────────────────────────────────────────
// NOTE ids: memories.id is INTEGER PRIMARY KEY — the brief's string ids
// (g4-*, g4c-*, g6b-pre) throw a silent datatype-mismatch on the receiving
// INSERT, which until() only observes as a timeout. Use unique integer ids:
// G4a/G4b range 703000-703009, G4c range 703100-703104, G6b uses 703200.

test("G4a/G4b: legacy numeric adopted when n <= length at open; reset when n > length", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    // Build a real feed pair, replicate 3 entries so B's in-feed has length 3.
    const link = await linkPeers(a, b);
    for (let i = 0; i < 3; i++) {
      await a.mgr.emitChange("memories", "insert", { id: 703000 + i, content: "x", lamport_ts: null });
    }
    // Wait for the real applied-seq record to settle at s:3, not just for
    // feed.length to reach 3 — feed.length only proves the bytes landed, not
    // that the receiving side's per-entry processing pipeline (which writes
    // its OWN {k,s} checkpoint) has finished. Waiting on length alone races
    // the pipeline's checkpoint writes against this test's manual override
    // below (observed: the pipeline's write landed AFTER the manual override
    // and silently clobbered it, corrupting the RED evidence for G4a).
    await until(async () => {
      const r = await b.mgr._appliedSeqRecord(a.id);
      return typeof r === "object" && r !== null && r.s === 3;
    });
    link.close();
    // Simulate legacy state: overwrite B's record with a bare number, then
    // force a re-open (close feeds, re-init) — reconcile must run at open.
    const K = b.mgr.inFeeds.get(a.id).key.toString("hex");
    await b.db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 2) WHERE instance_id = ?`,
      args: [`$."${a.id}"`, b.mgr.localInstanceId] });
    await b.mgr.closeInstanceFeeds(a.id);
    await b.mgr.initInstance(a.id, Buffer.from(K, "hex"));   // n=2 <= length 3 → adopt
    let rec = await b.mgr._appliedSeqRecord(a.id);
    assert.deepEqual({ k: rec.k, s: rec.s }, { k: K, s: 2 }, "G4a: adopted as {k, s:n}");
    // G4b: n > length → provably foreign → reset to 0.
    await b.db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 99) WHERE instance_id = ?`,
      args: [`$."${a.id}"`, b.mgr.localInstanceId] });
    await b.mgr.closeInstanceFeeds(a.id);
    await b.mgr.initInstance(a.id, Buffer.from(K, "hex"));
    rec = await b.mgr._appliedSeqRecord(a.id);
    assert.deepEqual({ k: rec.k, s: rec.s }, { k: K, s: 0 }, "G4b: impossible mark reset to 0");
  } finally { await fleet.cleanup(); }
});

test("G4c burst-crossing: legacy n vs fresh rotated feed that replicates a backlog past n in one link", async () => {
  const fleet = await makeFleet();
  let link;
  try {
    const { a, b } = fleet;
    // A pre-populates FIVE entries in its out-feed to B while UNLINKED (so the
    // whole backlog arrives as one burst after B opens its fresh in-feed).
    await a.mgr.initInstance(b.id, null);
    for (let i = 0; i < 5; i++) {
      await a.mgr.emitChange("memories", "insert", { id: 703100 + i, content: "x", lamport_ts: null });
    }
    // B holds a stale legacy mark n=3 for A (as if earned on a long-dead feed).
    await b.db.execute({
      sql: `UPDATE sync_state SET last_applied_seq_per_peer = json_set(COALESCE(last_applied_seq_per_peer,'{}'), ?, 3) WHERE instance_id = ?`,
      args: [`$."${a.id}"`, b.mgr.localInstanceId] });
    // B opens A's feed fresh (length 0 at open → reset to {k,s:0}), THEN the
    // burst replicates. Lazy evaluation would flip to "trust 3" once length=5.
    link = await linkPeers(a, b);
    // Right-reason check (mandatory per T1 review): the record must already be
    // frozen at {k, s:0} the instant the feed opened, BEFORE the burst lands —
    // otherwise a pass here could mean "everything happened to apply anyway"
    // rather than "the impossible mark was actually discarded at open".
    const K = b.mgr.inFeeds.get(a.id).key.toString("hex");
    const recAtOpen = await b.mgr._appliedSeqRecord(a.id);
    assert.deepEqual(recAtOpen && { k: recAtOpen.k, s: recAtOpen.s }, { k: K, s: 0 },
      "G4c right-reason: record frozen at {k,s:0} at open, before the burst lands");
    const allApplied = await until(async () => {
      const { rows } = await b.db.execute({
        sql: "SELECT COUNT(*) AS n FROM memories WHERE id BETWEEN 703100 AND 703104" });
      return Number(rows[0].n) === 5;
    });
    assert.equal(allApplied, true, "entries 0..2 must NOT be skipped (burst-crossing, R1 F2)");
  } finally {
    // link.close() BEFORE fleet.cleanup(), same footgun as G0: an assertion
    // throw must not strand the NoiseSecretStream/TCP sockets open.
    if (link) link.close();
    await fleet.cleanup();
  }
});

test("G6b: a restarted manager (same dirs+DB, new objects) completes a rotation via reconcile", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: 703200, content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=703200" })).rows.length === 1);
    link.close();
    // A "rotates": wipe its out-feed dir for B and re-init → new key minted.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    // B "restarts": build a NEW manager over B's same db+dataDir, sync_url = new key.
    await b.mgr.close();
    const b2mgr = new (b.mgr.constructor)(b.mgr.identity, b.db, b.mgr.localInstanceId);
    b2mgr.dataDir = b.mgr.dataDir; b2mgr.feedsDisabled = false;
    await b2mgr.initInstance(a.id, newKey); // reconcile: k differs → {k:new, s:0}
    const rec = await b2mgr._appliedSeqRecord(a.id);
    assert.equal(rec.k, newKey.toString("hex"));
    assert.equal(rec.s, 0, "restart completes rotation: record reset for the new feed");
    await b2mgr.close();
    b.mgr = b2mgr; // let cleanup close the live one
  } finally { await fleet.cleanup(); }
});
