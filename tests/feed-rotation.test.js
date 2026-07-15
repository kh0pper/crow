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
import Hypercore from "hypercore";
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
  // 2d C3 (G8): expose per-side handles so a test can re-replicate one side's
  // NEW feed onto the SAME still-open stream after that side's own rotation,
  // without tearing down the link — non-breaking addition alongside `streams`.
  return { streams: [nsA, nsB], nsA, nsB, close: () => { nsA.destroy(); nsB.destroy(); } };
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

// ── Task 4 (C1): live swap gates ────────────────────────────────────────────
// memories.id is INTEGER PRIMARY KEY — string ids fail silently (T1-review
// correction). Use integer ids: G1 704000 (pre) / 704001 (post), G5 704100,
// G12 704200-704202.

test("G1: live rotation single actor -- B swaps without restart, new emits apply, conflicts flat", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    let link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: 704000, content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=704000" })).rows.length === 1);
    const conflictsBefore = Number((await b.db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_conflicts" })).rows[0].n);
    link.close();
    // A rotates its out-feed to B (storage wiped, new key minted).
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    const oldFeed = b.mgr.inFeeds.get(a.id);
    // Key delivered to B live (as every receipt point does) — NO b restart:
    await b.mgr.initInstance(a.id, newKey);
    assert.notEqual(b.mgr.inFeeds.get(a.id), oldFeed, "in-feed object must be swapped");
    assert.equal(b.mgr.inFeeds.get(a.id).key.toString("hex"), newKey.toString("hex"));
    // Replication resumes on a fresh link; post-rotation emit applies.
    link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: 704001, content: "y", lamport_ts: null });
    const applied = await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=704001" })).rows.length === 1);
    assert.equal(applied, true, "post-rotation emit must apply with no restart on B");
    const conflictsAfter = Number((await b.db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_conflicts" })).rows[0].n);
    assert.equal(conflictsAfter, conflictsBefore, "sync_conflicts flat");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("G5: same-key re-exchange is a no-op -- feed identity and seq preserved", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: 704100, content: "x", lamport_ts: null });
    await until(async () => (await b.mgr._getLastAppliedSeq(a.id, b.mgr.inFeeds.get(a.id))) >= 1);
    const feedBefore = b.mgr.inFeeds.get(a.id);
    const seqBefore = await b.mgr._getLastAppliedSeq(a.id, feedBefore);
    await b.mgr.initInstance(a.id, a.mgr.getOutFeedKey(b.id)); // same key again
    assert.equal(b.mgr.inFeeds.get(a.id), feedBefore, "same feed object");
    assert.equal(await b.mgr._getLastAppliedSeq(a.id, feedBefore), seqBefore, "seq untouched");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("G6/G6c: hung close defers boundedly; reopen attempts do not throw; settle (resolve OR reject) un-defers and heals", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    b.mgr._rotationCloseCapMs = 200;
    const link = await linkPeers(a, b);
    const oldFeed = b.mgr.inFeeds.get(a.id);
    // Injection seam (R3 F-G): wrap the REAL feed's close in a controllable promise.
    let settle;
    const gate = new Promise((res) => { settle = res; });
    const realClose = oldFeed.close.bind(oldFeed);
    oldFeed.close = () => gate.then(() => realClose());
    // Rotate A, deliver the new key to B: close hangs → defer within the cap.
    link.close();
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    const t0 = Date.now();
    await b.mgr.initInstance(a.id, newKey);          // must return, not hang
    assert.ok(Date.now() - t0 < 8000, "G6: bounded (5s cap + slack), no hang");
    assert.equal(b.mgr.inFeeds.has(a.id), false, "deferred: no in-feed mapped");
    assert.ok(b.mgr._deferredRotations.has(a.id), "deferred set");
    // G6c: subsequent attempts (the C4-interval shape) must NOT throw.
    await assert.doesNotReject(() => b.mgr.initInstance(a.id, newKey));
    assert.equal(b.mgr.inFeeds.has(a.id), false, "still suppressed while lock held");
    // Now the slow close settles → un-defer → next call completes the rotation.
    settle();
    await until(() => !b.mgr._deferredRotations.has(a.id));
    await b.mgr.initInstance(a.id, newKey);
    assert.equal(b.mgr.inFeeds.get(a.id)?.key.toString("hex"), newKey.toString("hex"), "healed after settle");
  } finally { await fleet.cleanup(); }
});

test("G6c-reject: a REJECTING close un-defers with no unhandled rejection", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    b.mgr._rotationCloseCapMs = 200;
    let link = await linkPeers(a, b);
    link.close();
    const oldFeed = b.mgr.inFeeds.get(a.id);
    let reject;
    const gate = new Promise((_, rej) => { reject = rej; });
    oldFeed.close = () => gate; // close() = pending, then REJECTS
    const unhandled = [];
    const onUR = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUR);
    try {
      await a.mgr.closeInstanceFeeds(b.id);
      rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
      await a.mgr.initInstance(b.id, null);
      const newKey = a.mgr.getOutFeedKey(b.id);
      await b.mgr.initInstance(a.id, newKey);           // defers
      reject(new Error("close blew up"));               // the R3 F-A case
      await until(() => !b.mgr._deferredRotations.has(a.id));
      await new Promise((r) => setImmediate(r));        // let any UR surface
      assert.equal(unhandled.length, 0, "no unhandled rejection from the abandoned close");
      assert.equal(b.mgr._deferredRotations.has(a.id), false, "reject also un-defers (.finally)");
    } finally { process.off("unhandledRejection", onUR); }
  } finally { await fleet.cleanup(); }
});

test("C1 open-degrade: unopenable successor key after a live rotation degrades to out-only, never throws", async () => {
  // Committed guard for the open try/catch (R2 #1 / R3 F-D). A non-32-byte
  // buffer passes the swap branch's Buffer.equals key-compare (length mismatch
  // → keys differ → rotation proceeds, old feed closes fast) and then throws
  // inside the try at `new Hypercore(...)` ("Must pass a 32 byte buffer") —
  // exercising the CATCH, not an earlier guard. Removing the try/catch turns
  // this red (initInstance rejects).
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    link.close();
    const oldFeed = b.mgr.inFeeds.get(a.id);
    const badKey = Buffer.from("aa".repeat(5), "hex"); // unopenable: wrong length
    await assert.doesNotReject(() => b.mgr.initInstance(a.id, badKey), "open failure must degrade, not throw");
    assert.equal(b.mgr.inFeeds.has(a.id), false, "out-only degrade: no in-feed mapped");
    assert.equal(b.mgr._inFeedListeners.has(a.id), false, "old append listener detached");
    assert.equal(b.mgr._deferredRotations.has(a.id), false, "not deferred: the close succeeded, this is the degrade path");
    assert.equal(oldFeed.closed, true, "old feed was detached and closed by the swap branch");
    // The degrade is recoverable: a later valid key completes the rotation.
    await b.mgr.initInstance(a.id, a.mgr.getOutFeedKey(b.id));
    assert.equal(b.mgr.inFeeds.get(a.id)?.key.toString("hex"), a.mgr.getOutFeedKey(b.id).toString("hex"), "valid key heals");
  } finally { await fleet.cleanup(); }
});

test("G12: in-flight old-feed processing across the swap cannot corrupt the new record", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    // Seed 2 entries and let B apply them (record {k:old, s:2}).
    for (let i = 0; i < 2; i++) await a.mgr.emitChange("memories", "insert", { id: 704200 + i, content: "x", lamport_ts: null });
    await until(async () => (await b.mgr._getLastAppliedSeq(a.id, b.mgr.inFeeds.get(a.id))) >= 2);
    // Trap B's _applyEntry so the NEXT processing run parks mid-loop.
    let releaseApply; const applyGate = new Promise((r) => { releaseApply = r; });
    const realApply = b.mgr._applyEntry.bind(b.mgr);
    let trapped = false;
    b.mgr._applyEntry = async (...args) => { if (!trapped) { trapped = true; await applyGate; } return realApply(...args); };
    // Third entry arrives → old-feed run starts and parks inside _applyEntry.
    await a.mgr.emitChange("memories", "insert", { id: 704202, content: "x", lamport_ts: null });
    await until(() => trapped);
    link.close();
    // Swap while the old-feed run is mid-flight.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    await b.mgr.initInstance(a.id, newKey);
    releaseApply();                                    // old run resumes, stamps {k:old}
    await new Promise((r) => setTimeout(r, 100));      // let it finish its write
    // The record must be usable by the NEW feed: either {k:new,...} already, or
    // {k:old,...} which the key-gated read maps to 0 — NEVER {k:new, s:oldMark}.
    const rec = await b.mgr._appliedSeqRecord(a.id);
    if (rec.k === newKey.toString("hex")) {
      assert.equal(rec.s, 0, "a new-key record written during the race must be the reset, not the old mark");
    }
    const effective = await b.mgr._getLastAppliedSeq(a.id, b.mgr.inFeeds.get(a.id));
    assert.equal(effective === 0 || rec.k === newKey.toString("hex"), true,
      "new feed must start from 0 -- the old run's stamp must not masquerade under the new key");
    // And a queued post-swap run on the OLD feed must bail with no stamp:
    const before = JSON.stringify(await b.mgr._appliedSeqRecord(a.id));
    const oldFeedRef = { key: Buffer.from("cc".repeat(32), "hex"), length: 50, async get() { throw new Error("n/a"); } };
    await b.mgr._processNewEntries(a.id, oldFeedRef);  // replaced feed → entry bail
    assert.equal(JSON.stringify(await b.mgr._appliedSeqRecord(a.id)), before, "bailed run stamps nothing");
  } finally { await fleet.cleanup(); }
});

test("G11/G11b: malformed and self-echoed feed keys are rejected -- no persist-shape swap, no crash", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    await b.mgr.initInstance(a.id, null); // arm out-feed so self-key exists
    for (const bad of ["zz".repeat(32), "aa".repeat(16), "aa".repeat(33), "", null, 42]) {
      assert.equal(b.mgr.validateIncomingFeedKey(a.id, bad), null, `rejects ${String(bad).slice(0,8)}`);
    }
    const selfKey = b.mgr.getOutFeedKey(a.id).toString("hex");
    assert.equal(b.mgr.validateIncomingFeedKey(a.id, selfKey), null, "G11b: self-echo rejected");
    const good = "ab".repeat(32);
    const buf = b.mgr.validateIncomingFeedKey(a.id, good);
    assert.equal(buf?.toString("hex"), good, "valid key parses");
  } finally { await fleet.cleanup(); }
});

// ── Task 6 (C3): live-stream tracking + post-swap attach ────────────────────
// memories.id is INTEGER PRIMARY KEY — G8 706000 (pre) / 706001 (post), G9 706100+.

test("G8: rotation while a stream is actively replicating -- new feed attaches to the SAME stream", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b); // old core actively replicating on this stream
    let streamErrors = 0;
    link.nsA.on("error", () => { streamErrors++; });
    link.nsB.on("error", () => { streamErrors++; });
    await a.mgr.emitChange("memories", "insert", { id: 706000, content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=706000" })).rows.length === 1);
    // A rotates; the key is delivered to B while the ORIGINAL stream stays open.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    // A's side of the SAME stream: A's out-feed was closed+recreated, so A must
    // re-attach its own side explicitly (this harness action, not C3's job).
    await a.mgr.replicate(b.id, link.nsA);
    await b.mgr.initInstance(a.id, newKey); // swap: real bounded close of old core, then attach
    await a.mgr.emitChange("memories", "insert", { id: 706001, content: "y", lamport_ts: null });
    const applied = await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=706001" })).rows.length === 1);
    assert.equal(applied, true, "post-rotation data must flow over the pre-existing stream");
    // The out-feed side (A -> B, re-attached above) must not have been disturbed
    // by B's in-feed swap on the same stream: the pre-rotation row must still be
    // there and the stream must not have thrown/reset underneath either side.
    const preStillThere = (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=706000" })).rows.length === 1;
    assert.equal(preStillThere, true, "pre-rotation row undisturbed by the swap");
    assert.equal(streamErrors, 0, "out-feed replication over the SAME stream must not surface errors during the swap");
    link.close();
  } finally { await fleet.cleanup(); }
});

test("C3 churn: a lingering old stream's late close must not drop a re-paired peer's fresh stream set", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    // Track an OLD stream (Set A) on B for peer A.
    const link1 = await linkPeers(a, b);
    const oldStream = link1.nsB;
    assert.equal(b.mgr._activeStreams.get(a.id)?.has(oldStream), true, "old stream tracked");
    // Revoke: map entry deleted, but oldStream's close listener still holds Set A.
    await b.mgr.closeInstanceFeeds(a.id);
    assert.equal(b.mgr._activeStreams.has(a.id), false, "revoke tears down the tracked set");
    // Re-pair: a NEW stream creates a FRESH Set B in the map.
    const link2 = await linkPeers(a, b);
    const newStream = link2.nsB;
    assert.equal(b.mgr._activeStreams.get(a.id)?.has(newStream), true, "fresh set holds the new stream");
    // Precondition for non-vacuousness: the OLD stream must still be open when
    // the fresh set exists — its close has not fired yet.
    assert.equal(oldStream.destroyed, false, "precondition: old stream still open when the fresh set is created");
    // The old stream's socket finally tears down → its drop() runs, emptying
    // stale Set A. Without the identity guard it would delete the map entry —
    // destroying live Set B.
    link1.close();
    await until(() => oldStream.destroyed);
    await new Promise((r) => setImmediate(r)); // let the close listener run after destroy settles
    const liveSet = b.mgr._activeStreams.get(a.id);
    assert.ok(liveSet, "fresh stream set must survive the stale stream's late close");
    assert.equal(liveSet.has(newStream), true, "fresh set still contains the new stream");
    link2.close();
  } finally { await fleet.cleanup(); }
});

test("G9: old core blocks remain readable after the swap (acceptance pin)", async () => {
  const fleet = await makeFleet();
  try {
    const { a, b } = fleet;
    const link = await linkPeers(a, b);
    await a.mgr.emitChange("memories", "insert", { id: 706100, content: "x", lamport_ts: null });
    await until(async () => (await b.db.execute({ sql: "SELECT id FROM memories WHERE id=706100" })).rows.length === 1);
    const oldKey = Buffer.from(b.mgr.inFeeds.get(a.id).key);
    link.close();
    // A rotates its out-feed to B (storage wiped, new key minted) -- G1-style.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    await b.mgr.initInstance(a.id, newKey); // live swap, no restart -- old session closes (bounded)
    // Release B's own live sessions on this peer's corestore dir first: the
    // probed rocksdb fd-lock is process-wide per directory, so a standalone
    // reopen below would otherwise collide with B's still-open NEW in-feed
    // session even though it targets a DIFFERENT key (old vs new core).
    // NOTE: this narrows what G9 proves — old blocks survive rotation and are
    // readable once sessions close, NOT concurrent-session coexistence.
    await b.mgr.closeInstanceFeeds(a.id);
    // Acceptance pin: the OLD in-feed's on-disk blocks are still directly readable
    // by reopening the SAME "in" dir keyed with the OLD key -- the swap discards
    // only the live Hypercore session, never the storage (probed fact: a feed dir
    // is a multi-core store; old blocks stay readable after the old session closes).
    const reopened = new Hypercore(join(b.mgr.dataDir, a.id, "in"), oldKey, { valueEncoding: "json" });
    await reopened.ready();
    assert.ok(reopened.length >= 1, "old block(s) still present on disk");
    assert.ok(await reopened.get(0), "old block 0 still readable");
    await reopened.close();
  } finally { await fleet.cleanup(); }
});

// ── Task 7 (F3): tailnet server pre-exchange init race ─────────────────────

test("G13: stale-snapshot tailnet handshake cannot swap back a concurrently-received new key", async () => {
  const fleet = await makeFleet();
  const http = await import("node:http");
  const { WebSocket } = await import("ws");
  const { setupTailnetSyncServer } = await import("../servers/sharing/tailnet-sync.js");
  const { sign } = await import("../servers/sharing/identity.js");
  let server, ws;
  try {
    const { a, b } = fleet;
    // B hosts the WS server. Seed B's row for A with the OLD key.
    const oldLink = await linkPeers(a, b);
    oldLink.close();
    const oldKeyHex = a.mgr.getOutFeedKey(b.id).toString("hex");
    await b.db.execute({ sql: "UPDATE crow_instances SET sync_url = ? WHERE id = ?", args: [oldKeyHex, a.id] });
    // Barrier: park the server's :222 snapshot SELECT until the new key lands.
    let releaseLookup; const lookupGate = new Promise((r) => { releaseLookup = r; });
    let parked = false;
    const realExec = b.db.execute.bind(b.db);
    const dbWrapper = { ...b.db, execute: async (q) => {
      if (!parked && typeof q?.sql === "string" && q.sql.includes("WHERE id = ? AND status IN ('active','offline') LIMIT 1")) {
        parked = true;
        // Capture the snapshot NOW (before the concurrent rotation lands) --
        // the race is that the READ happens-before the rotation but the
        // CALLER'S USE of that stale result happens after it. Delaying
        // realExec() itself (rather than just the return) would make the
        // query observe the already-rotated row and defeat the gate.
        const result = await realExec(q);
        await lookupGate; // hold the stale snapshot until the new key lands
        return result;
      }
      return realExec(q);
    }};
    server = http.createServer();
    setupTailnetSyncServer(server, { identity: b.mgr.identity, instanceSyncManager: b.mgr, db: dbWrapper });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    // Dial as A with a REAL signed handshake.
    ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/instance-sync/stream`);
    await new Promise((r) => ws.once("open", r));
    const nonce = "00".repeat(16);
    ws.send(JSON.stringify({ instance_id: a.id, nonce_hex: nonce, sig_hex: sign(`${a.id}:${nonce}`, a.mgr.identity.ed25519Priv) }));
    await until(() => parked); // server is now parked holding the OLD snapshot
    // Hyperswarm path lands A's rotated key on B.
    await a.mgr.closeInstanceFeeds(b.id);
    rmSync(join(a.mgr.dataDir, b.id, "out"), { recursive: true, force: true });
    await a.mgr.initInstance(b.id, null);
    const newKey = a.mgr.getOutFeedKey(b.id);
    await b.db.execute({ sql: "UPDATE crow_instances SET sync_url = ? WHERE id = ?", args: [newKey.toString("hex"), a.id] });
    await b.mgr.initInstance(a.id, newKey);
    const swappedFeed = b.mgr.inFeeds.get(a.id);
    releaseLookup(); // server resumes with its stale snapshot -> hits :238
    // Give the handler time to run its init + key-exchange frames.
    ws.send(JSON.stringify({ feed_key_hex: newKey.toString("hex") }));
    await new Promise((r) => setTimeout(r, 300)); // grace window for the handler's post-swap writes
    assert.equal(b.mgr.inFeeds.get(a.id), swappedFeed,
      "the stale-snapshot :238 init must NOT have swapped the in-feed back (F3)");
    assert.equal(b.mgr.inFeeds.get(a.id).key.toString("hex"), newKey.toString("hex"));
  } finally {
    if (ws) try { ws.close(); } catch {}
    if (server) await new Promise((r) => server.close(r));
    await fleet.cleanup();
  }
});

// ── Task 8 (C4): 60s heal loop in refresh() ─────────────────────────────────

test("C4: refresh heals sync_url drift for ALREADY-DIALING peers and survives initInstance throws", async () => {
  const calls = [];
  const stubMgr = {
    localInstanceId: "me",
    // Mirrors the real InstanceSyncManager.validateIncomingFeedKey contract
    // (servers/sharing/instance-sync.js): a well-formed 64-hex-char key
    // decodes to a Buffer; anything else is rejected as null. The brief's
    // literal stub omits this method entirely, which under the heal call's
    // `validateIncomingFeedKey?.(...) ?? null` optional-chaining would pass
    // null (arm-only) for every peer -- failing this test's very first
    // assertion (calls[0] expects the real hex key, not null). Giving the
    // stub the real method's observable behavior keeps the test honest
    // without dragging in a full InstanceSyncManager (Hypercore, inFeeds,
    // on-disk dirs) that this unit test has no business needing.
    validateIncomingFeedKey: (_peerId, hex) =>
      typeof hex === "string" && /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null,
    initInstance: async (id, key) => {
      calls.push([id, key ? key.toString("hex") : null]);
      if (calls.length === 1) throw new Error("boom"); // first tick throws
    },
  };
  const peerRow = { id: "peer1", gateway_url: "http://127.0.0.1:1", tailscale_ip: null, sync_url: "ab".repeat(32), status: "active" };
  const stubDb = { execute: async () => ({ rows: [peerRow] }) };
  const { startTailnetSyncClients } = await import("../servers/sharing/tailnet-sync.js");
  const clients = await startTailnetSyncClients({ db: stubDb, instanceSyncManager: stubMgr, identity: {} });
  try {
    // First refresh already ran inside startTailnetSyncClients: the throw must
    // not have escaped (this test completing IS the assertion), and the call
    // must have carried the persisted key.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["peer1", "ab".repeat(32)]);
    assert.ok(clients.dialers.has("peer1"), "dialer was still created after the throw");
    // Second refresh: peer is ALREADY dialing -- the heal call must still fire
    // (placed BEFORE the dialers.has() continue; R3 F-C).
    peerRow.sync_url = "cd".repeat(32);
    await clients.__refreshForTest();
    assert.deepEqual(calls[1], ["peer1", "cd".repeat(32)], "already-dialing peer still healed");
  } finally { clients.stop(); }
});
