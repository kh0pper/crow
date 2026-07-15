/**
 * Tests for instance-sync.js — W4-1 sync data integrity.
 *
 * Schema: real init-db.js run against a tmp dir (captures FTS5 triggers,
 * FK graph, and the sync_conflicts.op column added by W4-1).
 * Feeds: plain stub objects { length, entries: Map, get(seq) } — no Hypercore.
 * Identity: shared single identity so sign/verify pass throughout.
 *
 * Test coverage (Task A scope, spec §7 tests 1-9):
 *   1. Counter atomicity
 *   2. Counter durability
 *   3. Per-entry checkpoint
 *   4. Checkpoint blob concurrency
 *   5. Per-peer serialization
 *   6. Real conflict (notification dedupe)
 *   7. Noise suppression (a) equal re-delivery (b) transform-aware equivalence
 *   8. Delete conflict
 *   9. Insert collision (a)-(d)
 *
 * Tests 10-13 (restore-path helper, stale-snapshot guard) are Task B.
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, SYNCED_TABLES, rowsEquivalent, buildCrowContextWireRow } from "../servers/sharing/instance-sync.js";
import { resolveConflict, restoreConflict } from "../servers/sharing/sync-conflict-resolve.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";
import { createMemoryServer } from "../servers/memory/server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ── Shared setup ──────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "crow-isync-test-"));

// Run real init-db.js so we get the full schema including FTS5 triggers,
// FK graph, sync_conflicts.op, etc.
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
});

const DB_PATH = join(tmpDir, "crow.db");

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Deterministic test identity: fixed private key + derived public key.
// @noble/ed25519 getPublicKey is async — resolved at module level before tests run.
const TEST_PRIV = Buffer.alloc(32, 0xAB);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");

const IDENTITY = {
  ed25519Priv: TEST_PRIV,
  ed25519Pubkey: TEST_PUB_HEX,
};

const LOCAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REMOTE_ID = "bbbbbbbb-0000-0000-0000-000000000002";

/**
 * Build a fresh InstanceSyncManager on its own DB client.
 * Each call re-opens the same file — multiple managers in one test share
 * state via the DB file (like real paired instances).
 */
function makeManager(instanceId = LOCAL_ID) {
  const db = createDbClient(DB_PATH);
  const mgr = new InstanceSyncManager(IDENTITY, db, instanceId);
  // The scratch suite env sets CROW_DISABLE_INSTANCE_SYNC=1, which the constructor
  // reads into feedsDisabled — emitChange would return before stamping and every
  // emit-path assertion would go vacuous. These tests drive stub feeds, never real
  // Hypercores, so force-enable (same as tests/group-tombstones.test.js:80).
  mgr.feedsDisabled = false;
  return { mgr, db };
}

/**
 * Build a signed entry as emitChange would produce it,
 * skipping the feed.append and lamport_ts UPDATE steps.
 */
function signEntry(entry) {
  const payload = JSON.stringify(entry);
  return { ...entry, signature: sign(payload, IDENTITY.ed25519Priv) };
}

/**
 * Stub feed: plain object the manager can call feed.get(seq) on.
 * Append entries with stubFeed.push(entry).
 * entries array is exposed for direct mutation in tests (e.g. corrupting signatures).
 */
function makeStubFeed() {
  const feed = {
    entries: [],
    get length() { return feed.entries.length; },
    async get(seq) { return feed.entries[seq]; },
    push(entry) { feed.entries.push(entry); return feed.entries.length - 1; },
  };
  return feed;
}

// ── Test 1: Counter atomicity ──────────────────────────────────────────────

test("1. Counter atomicity: 50 concurrent _nextLamport() → 50 unique strictly-increasing values", async () => {
  const { mgr, db } = makeManager("inst-t1");

  const results = await Promise.all(
    Array.from({ length: 50 }, () => mgr._nextLamport()),
  );

  // All unique
  const unique = new Set(results);
  assert.equal(unique.size, 50, "all 50 values should be unique");

  // All positive integers
  for (const v of results) {
    assert.ok(Number.isInteger(v) && v > 0, `expected positive integer, got ${v}`);
  }

  // Exactly 1..50, no gaps — a counter that skips values isn't atomic-increment
  assert.deepEqual(
    [...results].sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );

  // Persisted counter equals the max
  const { rows } = await db.execute({
    sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?",
    args: ["inst-t1"],
  });
  const persisted = Number(rows[0].local_counter);
  assert.equal(persisted, Math.max(...results));

  db.close();
});

test("1b. Counter atomicity: interleave _advanceCounter(bigTs) — no lost update, all subsequent > bigTs", async () => {
  const { mgr, db } = makeManager("inst-t1b");

  const bigTs = 9999;
  // Fire some _nextLamport + one _advanceCounter concurrently
  const [, , , advResult, , ] = await Promise.all([
    mgr._nextLamport(),
    mgr._nextLamport(),
    mgr._nextLamport(),
    mgr._advanceCounter(bigTs),
    mgr._nextLamport(),
    mgr._nextLamport(),
  ]);

  // After advance, persisted counter must be > bigTs
  const { rows } = await db.execute({
    sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?",
    args: ["inst-t1b"],
  });
  const persisted = Number(rows[0].local_counter);
  assert.ok(persisted > bigTs, `counter ${persisted} should be > bigTs ${bigTs}`);

  db.close();
});

// ── Test 2: Counter durability ────────────────────────────────────────────────

test("2. Counter durability: new manager on same DB resumes from persisted max", async () => {
  const { mgr: mgr1, db: db1 } = makeManager("inst-t2");

  const vals1 = await Promise.all([mgr1._nextLamport(), mgr1._nextLamport(), mgr1._nextLamport()]);
  const max1 = Math.max(...vals1);
  db1.close();

  // New manager instance on the same DB file
  const { mgr: mgr2, db: db2 } = makeManager("inst-t2");
  const next = await mgr2._nextLamport();

  assert.ok(next > max1, `new manager should continue from ${max1}, got ${next}`);
  db2.close();
});

// ── Test 3: Per-entry checkpoint ──────────────────────────────────────────────

test("3. Per-entry checkpoint: crash after seqs 0-1 resumes at seq 2; seqs 0-1 not re-applied", async () => {
  // Give this test its own instance id to avoid state collisions.
  const INST = "inst-t3";
  const REMOTE = "remote-t3";
  const { mgr, db } = makeManager(INST);

  // Seed a memory row that entry seq=0 and seq=1 will "update"
  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (100, 'general', 'original', 0)",
    args: [],
  });

  const feed = makeStubFeed();

  // seq 0: update row 100 with lamport_ts=10
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 100, content: "seq0", lamport_ts: 10 },
    lamport_ts: 10, instance_id: REMOTE,
  }));
  // seq 1: update row 100 with lamport_ts=20
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 100, content: "seq1", lamport_ts: 20 },
    lamport_ts: 20, instance_id: REMOTE,
  }));
  // seq 2: this entry will throw to simulate a bad entry
  feed.push(signEntry({
    table: "memories", op: "update",
    // Deliberately bad: no id field → _applyUpdate early-returns; but we need
    // a bad *signature* to force _applyEntry to throw. We corrupt the signature.
    row: { id: 100, content: "seq2-bad" },
    lamport_ts: 30, instance_id: REMOTE,
  }));
  // Corrupt seq 2's signature so it fails early
  feed.entries[2].signature = "deadbeef";

  // seq 3: valid update
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 100, content: "seq3", lamport_ts: 40 },
    lamport_ts: 40, instance_id: REMOTE,
  }));
  // seq 4: valid update with higher ts
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 100, content: "seq4", lamport_ts: 50 },
    lamport_ts: 50, instance_id: REMOTE,
  }));

  // "Crash" after processing only seqs 0-1 by limiting feed length.
  // We simulate this by manipulating lastSeq manually — process a 2-item feed.
  const feed2 = { length: 2, get: async (seq) => feed.entries[seq] };
  await mgr._processNewEntries(REMOTE, feed2);

  // Checkpoint for REMOTE should now be 2
  const cp2 = await mgr._getLastAppliedSeq(REMOTE);
  assert.equal(cp2, 2, "checkpoint after 2 entries should be 2");

  // Content should reflect seq1 (lamport_ts=20)
  const { rows: rows1 } = await db.execute({
    sql: "SELECT content FROM memories WHERE id = 100", args: [],
  });
  assert.equal(rows1[0].content, "seq1", "content should be from seq1 after first partial run");

  // "Restart": new manager, process full 5-entry feed
  const { mgr: mgr2, db: db2 } = makeManager(INST);
  await mgr2._processNewEntries(REMOTE, feed);

  // Seqs 0-1 must not be re-applied (no spurious conflict rows for them).
  // Seq 2 is skipped (bad sig), seq 3 and 4 apply.
  const { rows: conflictRows } = await db2.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = '100'", args: [],
  });
  assert.equal(Number(conflictRows[0].n), 0, "no spurious conflict rows for re-processed seqs 0-1");

  // Final content should be seq4
  const { rows: rowsFinal } = await db2.execute({
    sql: "SELECT content FROM memories WHERE id = 100", args: [],
  });
  assert.equal(rowsFinal[0].content, "seq4", "content should be from seq4 after full run");

  // Checkpoint advanced to feed.length (5)
  const cpFinal = await mgr2._getLastAppliedSeq(REMOTE);
  assert.equal(cpFinal, 5, "checkpoint should be 5 after full processing");

  db.close();
  db2.close();
});

// ── Test 4: Checkpoint blob concurrency ──────────────────────────────────────

test("4. Checkpoint blob concurrency: concurrent _setLastAppliedSeq for two peers both survive", async () => {
  const INST = "inst-t4";
  const { mgr, db } = makeManager(INST);

  const PEER_A = "peer-a-t4";
  const PEER_B = "peer-b-t4";

  // Both fire at the same time
  await Promise.all([
    mgr._setLastAppliedSeq(PEER_A, 7),
    mgr._setLastAppliedSeq(PEER_B, 13),
  ]);

  const seqA = await mgr._getLastAppliedSeq(PEER_A);
  const seqB = await mgr._getLastAppliedSeq(PEER_B);

  assert.equal(seqA, 7, "peer A checkpoint should be 7");
  assert.equal(seqB, 13, "peer B checkpoint should be 13");

  db.close();
});

// ── Test 5: Per-peer serialization ───────────────────────────────────────────

test("5. Per-peer serialization: two concurrent _processNewEntries on same feed → each entry applied exactly once", async () => {
  const INST = "inst-t5";
  const REMOTE = "remote-t5";
  const { mgr, db } = makeManager(INST);

  // Seed a contacts row — relay_config is simpler (no FK, unique relay_url constraint)
  // Actually use memories to count updates.
  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (200, 'general', 'start', 0)",
    args: [],
  });

  const feed = makeStubFeed();
  for (let i = 1; i <= 6; i++) {
    feed.push(signEntry({
      table: "memories", op: "update",
      row: { id: 200, content: `step-${i}`, lamport_ts: i * 10 },
      lamport_ts: i * 10, instance_id: REMOTE,
    }));
  }

  // Spy on _applyEntry: with LWW + the equivalence check, a double-applied
  // batch converges to identical row state, so final state alone can't
  // distinguish serialized from interleaved runs — the apply COUNT can.
  let applyCalls = 0;
  const origApply = mgr._applyEntry.bind(mgr);
  mgr._applyEntry = async (...args) => { applyCalls++; return origApply(...args); };

  // Launch two concurrent process runs on the same feed
  await Promise.all([
    mgr._processNewEntries(REMOTE, feed),
    mgr._processNewEntries(REMOTE, feed),
  ]);

  // The lock serializes the runs; the second re-reads the checkpoint inside
  // the lock and finds nothing left to do — exactly feed.length applies total.
  assert.equal(applyCalls, 6, "each entry applied exactly once across both runs");

  // Should have exactly 0 conflict rows (no duplicate applications)
  const { rows: conflicts } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = '200'", args: [],
  });
  assert.equal(Number(conflicts[0].n), 0, "no conflicts from serialized duplicate runs");

  // Final content should be last update (step-6, lamport_ts=60)
  const { rows } = await db.execute({
    sql: "SELECT content FROM memories WHERE id = 200", args: [],
  });
  assert.equal(rows[0].content, "step-6", "last update wins");

  // Checkpoint should be 6 (all entries processed once)
  const cp = await mgr._getLastAppliedSeq(REMOTE);
  assert.equal(cp, 6, "checkpoint = feed.length");

  db.close();
});

// ── Test 6: Real conflict + notification dedupe ───────────────────────────────

test("6. Real conflict: higher local lamport_ts + different data → conflict row + notification; second conflict → no second notification", async () => {
  const INST = "inst-t6";
  const REMOTE = "remote-t6";
  const { mgr, db } = makeManager(INST);

  // Insert a memory with higher local ts
  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts, instance_id) VALUES (300, 'general', 'local-win', 100, ?)",
    args: [INST],
  });

  const feed = makeStubFeed();
  // Incoming update with lower lamport_ts but different content
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 300, content: "remote-lose", lamport_ts: 5 },
    lamport_ts: 5, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // Conflict row should exist
  const { rows: conflicts } = await db.execute({
    sql: "SELECT * FROM sync_conflicts WHERE row_id = '300'", args: [],
  });
  assert.equal(conflicts.length, 1, "should have one conflict row");
  assert.equal(conflicts[0].op, "update", "op should be 'update'");
  assert.equal(conflicts[0].winning_lamport_ts, 100);
  assert.equal(conflicts[0].losing_lamport_ts, 5);
  assert.ok(conflicts[0].winning_data.includes("local-win"), "winning_data should reference local row");

  // Notification should exist
  const { rows: notifs } = await db.execute({
    sql: "SELECT * FROM notifications WHERE source = 'instance-sync'", args: [],
  });
  assert.equal(notifs.length, 1, "should have exactly one notification");
  assert.equal(notifs[0].priority, "high");
  assert.equal(notifs[0].action_url, "/dashboard/settings?section=sync-conflicts");

  // Insert a second conflict on a different row, from a DIFFERENT remote peer
  // (same peer's checkpoint would be at seq=1 already — use remote-t6b to avoid that).
  const REMOTE2 = "remote-t6b";
  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts, instance_id) VALUES (301, 'general', 'local-win-2', 100, ?)",
    args: [INST],
  });
  const feed2 = makeStubFeed();
  feed2.push(signEntry({
    table: "memories", op: "update",
    row: { id: 301, content: "remote-lose-2", lamport_ts: 3 },
    lamport_ts: 3, instance_id: REMOTE2,
  }));

  await mgr._processNewEntries(REMOTE2, feed2);

  // Second conflict row exists, but notification count should STILL be 1 (deduped)
  const { rows: conflicts2 } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0", args: [],
  });
  assert.ok(Number(conflicts2[0].n) >= 2, "should have at least 2 conflict rows");

  const { rows: notifs2 } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM notifications WHERE source = 'instance-sync' AND is_read = 0 AND is_dismissed = 0",
    args: [],
  });
  assert.equal(Number(notifs2[0].n), 1, "dedupe: should still have only 1 unread notification");

  db.close();
});

// ── Test 7: Noise suppression ─────────────────────────────────────────────────

test("7a. Noise suppression: equal-ts equal-data re-delivery → no conflict row", async () => {
  const INST = "inst-t7a";
  const REMOTE = "remote-t7a";
  const { mgr, db } = makeManager(INST);

  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts, instance_id) VALUES (400, 'general', 'same-content', 50, ?)",
    args: [REMOTE],
  });

  const feed = makeStubFeed();
  // Re-deliver with same lamport_ts and same data
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 400, content: "same-content", category: "general", lamport_ts: 50, instance_id: REMOTE },
    lamport_ts: 50, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  const { rows: conflicts } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = '400'", args: [],
  });
  assert.equal(Number(conflicts[0].n), 0, "no conflict for re-delivery noise");

  db.close();
});

test("7b. Noise suppression: transform-aware equivalence — research_notes re-delivery with local project_id → no false conflict", async () => {
  const INST = "inst-t7b";
  const REMOTE = "remote-t7b";
  const { mgr, db } = makeManager(INST);

  // research_notes.project_id is a FK to project_spaces (rebuilt in W2-5B2;
  // the rp→ps trigger that used to satisfy it was retired in B3a) — seed the
  // ps parent directly.
  // research_notes.lamport_ts is absent on a fresh DB (ordering bug in init-db line 160
  // which runs before the CREATE TABLE at line 481). Use default NULL → 0 via || 0.
  await db.execute({
    sql: `INSERT INTO project_spaces (id, slug, name, type, status) VALUES (42, 'test-project-42', 'Test Project', 'general', 'active')`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO research_notes (id, content, project_id)
          VALUES (500, 'note-content', 42)`,
    args: [],
  });

  const feed = makeStubFeed();
  // Re-deliver the same note — with project_id=null as it would come over the wire
  // (OUTBOUND_TRANSFORMS nulls project_id). lamport_ts=0 matches the default local ts.
  feed.push(signEntry({
    table: "research_notes", op: "update",
    row: { id: 500, content: "note-content", project_id: null },
    lamport_ts: 0, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  const { rows: conflicts } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = '500'", args: [],
  });
  assert.equal(Number(conflicts[0].n), 0, "no false conflict: local project_id transforms away");

  db.close();
});

// ── Test 8: Delete conflict ───────────────────────────────────────────────────

test("8a. Delete conflict: stale delete (low lamport_ts) vs newer local row → row survives, conflict logged op=delete", async () => {
  const INST = "inst-t8a";
  const REMOTE = "remote-t8a";
  const { mgr, db } = makeManager(INST);

  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (600, 'general', 'should-survive', 100)",
    args: [],
  });

  const feed = makeStubFeed();
  feed.push(signEntry({
    table: "memories", op: "delete",
    row: { id: 600 },
    lamport_ts: 5, instance_id: REMOTE,  // stale: lower than local 100
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // Row should still exist
  const { rows } = await db.execute({
    sql: "SELECT content FROM memories WHERE id = 600", args: [],
  });
  assert.equal(rows.length, 1, "row should survive stale delete");
  assert.equal(rows[0].content, "should-survive");

  // Conflict logged with op='delete'
  const { rows: conflicts } = await db.execute({
    sql: "SELECT op FROM sync_conflicts WHERE row_id = '600'", args: [],
  });
  assert.equal(conflicts.length, 1, "should have one conflict row");
  assert.equal(conflicts[0].op, "delete", "op should be 'delete'");

  db.close();
});

test("8b. Delete conflict: newer delete (higher lamport_ts) → row deleted", async () => {
  const INST = "inst-t8b";
  const REMOTE = "remote-t8b";
  const { mgr, db } = makeManager(INST);

  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (601, 'general', 'will-be-deleted', 10)",
    args: [],
  });

  const feed = makeStubFeed();
  feed.push(signEntry({
    table: "memories", op: "delete",
    row: { id: 601 },
    lamport_ts: 100, instance_id: REMOTE,  // newer: higher than local 10
  }));

  await mgr._processNewEntries(REMOTE, feed);

  const { rows } = await db.execute({
    sql: "SELECT id FROM memories WHERE id = 601", args: [],
  });
  assert.equal(rows.length, 0, "row should be deleted");

  db.close();
});

// ── Test 9: Insert collision (D7) ────────────────────────────────────────────

test("9a. Insert collision (D7-a): remote insert colliding with different local row at same id → not applied, conflict op=insert", async () => {
  const INST = "inst-t9a";
  const REMOTE = "remote-t9a";
  const { mgr, db } = makeManager(INST);

  // Local row at id=700 with certain content
  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (700, 'general', 'local-row', 50)",
    args: [],
  });

  const feed = makeStubFeed();
  // Remote tries to insert a DIFFERENT row at the same id
  feed.push(signEntry({
    table: "memories", op: "insert",
    row: { id: 700, category: "general", content: "remote-collision", lamport_ts: 30 },
    lamport_ts: 30, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // Local row should still have original content (remote insert NOT applied)
  const { rows } = await db.execute({
    sql: "SELECT content FROM memories WHERE id = 700", args: [],
  });
  assert.equal(rows[0].content, "local-row", "remote insert should not overwrite local row");

  // Conflict row logged with op='insert'
  const { rows: conflicts } = await db.execute({
    sql: "SELECT op, losing_data FROM sync_conflicts WHERE row_id = '700'", args: [],
  });
  assert.equal(conflicts.length, 1, "should have one conflict row for insert collision");
  assert.equal(conflicts[0].op, "insert", "op should be 'insert'");
  assert.ok(conflicts[0].losing_data.includes("remote-collision"), "losing_data holds the incoming row");

  db.close();
});

test("9b. Insert collision (D7-b): colliding equivalent row → no conflict", async () => {
  const INST = "inst-t9b";
  const REMOTE = "remote-t9b";
  const { mgr, db } = makeManager(INST);

  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (701, 'general', 'same-content', 30)",
    args: [],
  });

  const feed = makeStubFeed();
  feed.push(signEntry({
    table: "memories", op: "insert",
    row: { id: 701, category: "general", content: "same-content", lamport_ts: 30 },
    lamport_ts: 30, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  const { rows: conflicts } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = '701'", args: [],
  });
  assert.equal(Number(conflicts[0].n), 0, "no conflict for equivalent re-insert");

  db.close();
});

test("9c. Insert collision (D7-c): no-row-at-id branch (secondary UNIQUE collision) → warn only, no conflict, no throw", async () => {
  // contacts.crow_id has a UNIQUE constraint; two inserts with different ids
  // but the same crow_id → the second is OR-IGNORE'd with no local row at that id.
  const INST = "inst-t9c";
  const REMOTE = "remote-t9c";
  const { mgr, db } = makeManager(INST);

  // Seed the existing contact
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey)
          VALUES (1000, 'unique-crow-id', 'Alice', 'pubkey1', 'sec1')`,
    args: [],
  });

  const feed = makeStubFeed();
  // Remote sends a fresh id=1001 but reuses crow_id='unique-crow-id'
  // → INSERT OR IGNORE skips, but id=1001 doesn't exist locally.
  feed.push(signEntry({
    table: "contacts", op: "insert",
    row: { id: 1001, crow_id: "unique-crow-id", display_name: "Alice-dupe",
           ed25519_pubkey: "pubkey1", secp256k1_pubkey: "sec1" },
    lamport_ts: 10, instance_id: REMOTE,
  }));

  // Should not throw
  await mgr._processNewEntries(REMOTE, feed);

  // No conflict row created
  const { rows: conflicts } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE row_id = '1001'", args: [],
  });
  assert.equal(Number(conflicts[0].n), 0, "no conflict for secondary-UNIQUE dedupe");

  db.close();
});

test("9d. Insert collision (D7-d): entry with row.id == null → warn branch, no throw", async () => {
  const INST = "inst-t9d";
  const REMOTE = "remote-t9d";
  const { mgr, db } = makeManager(INST);

  // No id AND a NOT NULL violation (content: null) — OR IGNORE swallows the
  // violation so rowsAffected === 0, which reaches the null-id guard. (A plain
  // no-id insert would auto-assign an id and never enter the rowsAffected===0
  // branch at all.) Call _applyInsert DIRECTLY: through _processNewEntries the
  // outer catch in _applyEntry would swallow a missing-guard throw, making the
  // test unable to tell guard from crash.
  const row = { category: "general", content: null };

  // Shared DB across tests — assert deltas, not absolutes.
  const countOf = async (table) => {
    const { rows } = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] });
    return Number(rows[0].n);
  };
  const conflictsBefore = await countOf("sync_conflicts");
  const memsBefore = await countOf("memories");

  // Without the guard this rejects (better-sqlite3 throws binding undefined id)
  await assert.doesNotReject(() => mgr._applyInsert("memories", row, 5, REMOTE));

  // Guard must not have logged a conflict or inserted anything
  assert.equal(await countOf("sync_conflicts"), conflictsBefore, "null-id guard logs no conflict");
  assert.equal(await countOf("memories"), memsBefore, "nothing inserted");

  db.close();
});

// ── rowsEquivalent unit tests ─────────────────────────────────────────────────

test("rowsEquivalent: both nullish → equal", () => {
  assert.ok(rowsEquivalent({ a: null }, { a: undefined }));
  assert.ok(rowsEquivalent({ a: null, b: null }, { a: null, b: null }));
});

test("rowsEquivalent: one nullish, one value → not equal", () => {
  assert.ok(!rowsEquivalent({ a: null }, { a: "x" }));
  assert.ok(!rowsEquivalent({ a: "x" }, { a: null }));
  assert.ok(!rowsEquivalent({ a: "" }, { a: null }), "empty string ≠ null");
});

test("rowsEquivalent: string coercion", () => {
  assert.ok(rowsEquivalent({ a: 1 }, { a: "1" }));
  assert.ok(!rowsEquivalent({ a: 1 }, { a: "2" }));
});

test("rowsEquivalent: lamport_ts and instance_id are ignored", () => {
  assert.ok(rowsEquivalent(
    { id: 1, content: "x", lamport_ts: 10, instance_id: "aaa" },
    { id: 1, content: "x", lamport_ts: 99, instance_id: "bbb" },
  ));
});

test("rowsEquivalent: key in b missing from a → not equal (one nullish)", () => {
  // b has key 'b' that a doesn't have: a.b = undefined (null), b.b = "y" → not equal
  assert.ok(!rowsEquivalent({ a: "x" }, { a: "x", b: "y" }));
});

test("rowsEquivalent: key only in a is ignored (a is partial local, b is wire row)", () => {
  // a has extra key that b doesn't carry — b is the wire row, its keys are authoritative
  assert.ok(rowsEquivalent({ a: "x", extraLocal: "ignored" }, { a: "x" }));
});

// ── Test 10: Restore path (happy) ────────────────────────────────────────────

test("10. Restore path (happy): UPDATE-of-present-keys; absent columns untouched; FTS integrity; emitChange spy", async () => {
  const INST = "inst-t10";
  const REMOTE = "remote-t10";
  const { mgr, db } = makeManager(INST);

  // Seed a memories row with content and extra columns that losing_data will NOT carry.
  // access_count and created_at are columns that must survive the restore untouched.
  await db.execute({
    sql: `INSERT INTO memories (id, category, content, importance, lamport_ts, access_count, created_at)
          VALUES (800, 'general', 'original-content', 5, 50, 7, datetime('now'))`,
    args: [],
  });

  // Manufacture a conflict row as if a remote edit with lower lamport_ts was received.
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '800', ?, ?, 50, 10, ?, ?, 'update')`,
    args: [
      INST, REMOTE,
      JSON.stringify({ id: 800, category: "general", content: "original-content", importance: 5, lamport_ts: 50, access_count: 7 }),
      JSON.stringify({ id: 800, content: "restoredversion", importance: 3 }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '800'", args: [] });
  const conflictId = crows[0].id;

  // emitChange spy
  const emitted = [];
  const fakeSync = {
    emitChange: async (table, op, row) => { emitted.push({ table, op, row }); },
  };

  const outcome = await restoreConflict(db, conflictId, { instanceSync: fakeSync });
  assert.equal(outcome.status, "applied", "restore should succeed");

  // content updated to losing side
  const { rows: memRows } = await db.execute({
    sql: "SELECT content, importance, access_count FROM memories WHERE id = 800",
    args: [],
  });
  assert.equal(memRows[0].content, "restoredversion", "content should be restored");
  assert.equal(Number(memRows[0].importance), 3, "importance should be restored");
  // access_count not in losing_data — must be untouched
  assert.equal(Number(memRows[0].access_count), 7, "access_count (absent from losing_data) must be untouched");

  // conflict resolved
  const { rows: confRows } = await db.execute({
    sql: "SELECT resolved FROM sync_conflicts WHERE id = ?",
    args: [conflictId],
  });
  assert.equal(Number(confRows[0].resolved), 1, "conflict should be resolved");

  // emitChange called with "update"
  assert.equal(emitted.length, 1, "emitChange called once");
  assert.equal(emitted[0].op, "update", "emitChange op should be 'update'");
  assert.equal(emitted[0].table, "memories", "emitChange table should be 'memories'");

  // FTS integrity: after the UPDATE the memories_fts index must be consistent.
  // An integrity-check passes if the shadow tables aren't corrupted.
  let ftsOk = true;
  try {
    await db.execute({
      sql: `INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')`,
      args: [],
    });
  } catch (err) {
    ftsOk = false;
    assert.fail(`FTS integrity-check failed: ${err.message}`);
  }
  assert.ok(ftsOk, "FTS integrity-check should pass after restore");

  // The restored row should be findable via FTS MATCH on the new content.
  // (The FTS update trigger fires on UPDATE to memories — verify the OLD
  // content is no longer the only match; we care that the index didn't corrupt.)
  const { rows: ftsRows } = await db.execute({
    sql: `SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'restoredversion'`,
    args: [],
  });
  assert.ok(ftsRows.length > 0, "restored content should be findable via FTS MATCH");

  // And the PRE-restore content must be GONE from the index for this row —
  // an orphaned old document here is exactly the INSERT OR REPLACE corruption
  // the spec forbids (the memories_au trigger must have delete+reinserted).
  const { rows: staleRows } = await db.execute({
    sql: `SELECT rowid FROM memories_fts WHERE memories_fts MATCH '"original-content"' AND rowid = 800`,
    args: [],
  });
  assert.equal(staleRows.length, 0, "pre-restore content must not remain in the FTS index");

  // FK survival: contacts → messages uses a similar pattern. Here we verify that
  // restoring a memories row leaves it accessible (no cascade side effects).
  const { rows: afterRestore } = await db.execute({
    sql: "SELECT id FROM memories WHERE id = 800",
    args: [],
  });
  assert.equal(afterRestore.length, 1, "memories row should still exist after restore");

  db.close();
});

test("10b. Restore path (row-since-gone): plain INSERT + emitChange('insert')", async () => {
  const INST = "inst-t10b";
  const REMOTE = "remote-t10b";
  const { mgr, db } = makeManager(INST);

  // The "row-since-gone" INSERT path requires that:
  //   - The live row does not exist
  //   - The stale-snapshot guard passes (storedWinningData matches live state)
  // When a prior stale-guard pass re-snapshots a gone row, it stores the JSON
  // string 'null' in winning_data (to satisfy the NOT NULL constraint while still
  // representing "no row"). We seed the conflict in that post-re-snapshot state:
  //   winning_data = 'null' (JSON null), live row absent → guard: both null → pass.
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '801', ?, ?, 50, 10, 'null', ?, 'update')`,
    args: [
      INST, REMOTE,
      // losing_data: full-ish row so INSERT has required NOT NULL columns.
      JSON.stringify({ id: 801, category: "general", content: "re-inserted-content", importance: 2, lamport_ts: 10 }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '801'", args: [] });
  const conflictId = crows[0].id;

  const emitted = [];
  const fakeSync = {
    emitChange: async (table, op, row) => { emitted.push({ table, op, row }); },
  };

  const outcome = await restoreConflict(db, conflictId, { instanceSync: fakeSync });
  assert.equal(outcome.status, "applied", "restore of gone row should succeed");

  const { rows: memRows } = await db.execute({
    sql: "SELECT content FROM memories WHERE id = 801",
    args: [],
  });
  assert.equal(memRows.length, 1, "row should be re-inserted");
  assert.equal(memRows[0].content, "re-inserted-content");

  // emitChange must use "insert" (not "update") so peers also lacking the row
  // will receive and apply it correctly.
  assert.equal(emitted.length, 1, "emitChange called once");
  assert.equal(emitted[0].op, "insert", "emitChange op should be 'insert' for re-insert");

  db.close();
});

// ── Test 11: Restore failure leaves conflict unresolved ───────────────────────

test("11. Restore failure (partial losing_data + row gone → INSERT NOT NULL fail): error returned, conflict still unresolved", async () => {
  const INST = "inst-t11";
  const REMOTE = "remote-t11";
  const { mgr, db } = makeManager(INST);

  // memories.content has NOT NULL; losing_data is partial and omits it.
  // winning_data = 'null' (JSON null string) so the stale guard treats it as
  // "row was gone when last snapshotted", and since the live row is also absent,
  // the guard passes (both null → not stale). The INSERT then fails on NOT NULL.
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '850', ?, ?, 0, 5, 'null', ?, 'update')`,
    args: [
      INST, REMOTE,
      // partial: has id + tags but NOT content (which is NOT NULL in memories)
      JSON.stringify({ id: 850, tags: "tag1" }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '850'", args: [] });
  const conflictId = crows[0].id;

  const outcome = await restoreConflict(db, conflictId, { instanceSync: null });
  assert.equal(outcome.status, "error", "should return error outcome");
  assert.ok(outcome.message && outcome.message.length > 0, "should have a plain-language error message");

  // Conflict must remain unresolved
  const { rows: confRows } = await db.execute({
    sql: "SELECT resolved FROM sync_conflicts WHERE id = ?",
    args: [conflictId],
  });
  assert.equal(Number(confRows[0].resolved), 0, "conflict should remain unresolved after failure");

  // No partial row inserted
  const { rows: memRows } = await db.execute({
    sql: "SELECT id FROM memories WHERE id = 850",
    args: [],
  });
  assert.equal(memRows.length, 0, "no partial row should be inserted");

  db.close();
});

// ── Test 12: Stale-snapshot guard ────────────────────────────────────────────

test("12a. Stale-snapshot guard: live row changed after conflict logged → NOT applied, winning_data re-snapshotted, stale outcome", async () => {
  const INST = "inst-t12a";
  const REMOTE = "remote-t12a";
  const { mgr, db } = makeManager(INST);

  // Seed row
  await db.execute({
    sql: `INSERT INTO memories (id, category, content, lamport_ts) VALUES (860, 'general', 'at-conflict-time', 50)`,
    args: [],
  });

  // Log conflict with snapshot of row as it was at conflict time.
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '860', ?, ?, 50, 10, ?, ?, 'update')`,
    args: [
      INST, REMOTE,
      JSON.stringify({ id: 860, category: "general", content: "at-conflict-time", lamport_ts: 50 }),
      JSON.stringify({ id: 860, content: "losing-version" }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '860'", args: [] });
  const conflictId = crows[0].id;

  // NOW change the live row (operator edited it after the conflict was logged).
  await db.execute({
    sql: `UPDATE memories SET content = 'edited-after-conflict', lamport_ts = 99 WHERE id = 860`,
    args: [],
  });

  const emitted = [];
  const fakeSync = {
    emitChange: async (table, op, row) => { emitted.push({ table, op, row }); },
  };

  // First confirm: should trip the stale guard.
  const outcome1 = await restoreConflict(db, conflictId, { instanceSync: fakeSync });
  assert.equal(outcome1.status, "stale", "should return stale outcome when live row has changed");
  assert.ok(outcome1.message && outcome1.message.includes("changed"), "stale message should mention change");
  assert.equal(emitted.length, 0, "emitChange should not be called on stale");

  // winning_data should have been re-snapshotted to the current live content.
  const { rows: confRows } = await db.execute({
    sql: "SELECT winning_data, resolved FROM sync_conflicts WHERE id = ?",
    args: [conflictId],
  });
  const resnapshot = JSON.parse(confRows[0].winning_data);
  assert.equal(resnapshot.content, "edited-after-conflict", "winning_data should be re-snapshotted to current row");
  assert.equal(Number(confRows[0].resolved), 0, "conflict should remain unresolved after stale guard");

  // Live row content should NOT have been changed to the losing version.
  const { rows: memRows } = await db.execute({ sql: "SELECT content FROM memories WHERE id = 860", args: [] });
  assert.equal(memRows[0].content, "edited-after-conflict", "live row must not have been overwritten");

  // Second confirm: snapshot now matches live row → stale guard passes → applies.
  const outcome2 = await restoreConflict(db, conflictId, { instanceSync: fakeSync });
  assert.equal(outcome2.status, "applied", "second confirm should apply after re-snapshot");
  assert.equal(emitted.length, 1, "emitChange called on second confirm");

  const { rows: memRows2 } = await db.execute({ sql: "SELECT content FROM memories WHERE id = 860", args: [] });
  assert.equal(memRows2[0].content, "losing-version", "losing version applied on second confirm");

  db.close();
});

test("12b. Stale-snapshot guard (delete variant): snapshot differs → guard blocks the DELETE", async () => {
  const INST = "inst-t12b";
  const REMOTE = "remote-t12b";
  const { mgr, db } = makeManager(INST);

  await db.execute({
    sql: `INSERT INTO memories (id, category, content, lamport_ts) VALUES (861, 'general', 'guard-me', 50)`,
    args: [],
  });

  // Log a delete conflict: losing_data = the delete marker, winning_data = snapshot of live row.
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '861', ?, ?, 50, 5, ?, ?, 'delete')`,
    args: [
      INST, REMOTE,
      JSON.stringify({ id: 861, category: "general", content: "guard-me", lamport_ts: 50 }),
      JSON.stringify({ id: 861 }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '861'", args: [] });
  const conflictId = crows[0].id;

  // Edit the live row after the conflict was logged → stale guard should fire.
  await db.execute({
    sql: `UPDATE memories SET content = 'updated-after-conflict' WHERE id = 861`,
    args: [],
  });

  const outcome = await restoreConflict(db, conflictId, { instanceSync: null });
  assert.equal(outcome.status, "stale", "delete restore should trip stale guard when row changed");

  // Row must still exist
  const { rows: memRows } = await db.execute({ sql: "SELECT id FROM memories WHERE id = 861", args: [] });
  assert.equal(memRows.length, 1, "row should still exist — delete was blocked by stale guard");

  db.close();
});

// ── Test 13: Delete-restore + insert-restore-disabled ────────────────────────

test("13a. Delete-restore: op=delete conflict with current snapshot → row deleted + emitChange('delete')", async () => {
  const INST = "inst-t13a";
  const REMOTE = "remote-t13a";
  const { mgr, db } = makeManager(INST);

  await db.execute({
    sql: `INSERT INTO memories (id, category, content, lamport_ts) VALUES (870, 'general', 'to-be-deleted', 50)`,
    args: [],
  });

  // Log a delete conflict: winning_data = current row, losing = delete marker.
  // snapshot matches live row exactly so guard passes.
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '870', ?, ?, 50, 5, ?, ?, 'delete')`,
    args: [
      INST, REMOTE,
      JSON.stringify({ id: 870, category: "general", content: "to-be-deleted", lamport_ts: 50 }),
      JSON.stringify({ id: 870 }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '870'", args: [] });
  const conflictId = crows[0].id;

  const emitted = [];
  const fakeSync = {
    emitChange: async (table, op, row) => { emitted.push({ table, op, row }); },
  };

  const outcome = await restoreConflict(db, conflictId, { instanceSync: fakeSync });
  assert.equal(outcome.status, "applied", "delete-restore should succeed");

  // Row should be gone
  const { rows: memRows } = await db.execute({ sql: "SELECT id FROM memories WHERE id = 870", args: [] });
  assert.equal(memRows.length, 0, "row should be deleted after delete-restore");

  // emitChange with "delete"
  assert.equal(emitted.length, 1, "emitChange called once");
  assert.equal(emitted[0].op, "delete", "emitChange op should be 'delete'");

  // Conflict resolved
  const { rows: confRows } = await db.execute({ sql: "SELECT resolved FROM sync_conflicts WHERE id = ?", args: [conflictId] });
  assert.equal(Number(confRows[0].resolved), 1, "conflict should be resolved after delete-restore");

  db.close();
});

test("13b. Insert-restore-disabled: op=insert conflict → restore refused, resolve still works", async () => {
  const INST = "inst-t13b";
  const REMOTE = "remote-t13b";
  const { mgr, db } = makeManager(INST);

  // Log an insert-collision conflict (op='insert').
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('memories', '880', ?, ?, 50, 30, ?, ?, 'insert')`,
    args: [
      INST, REMOTE,
      JSON.stringify({ id: 880, category: "general", content: "local-row", lamport_ts: 50 }),
      JSON.stringify({ id: 880, category: "general", content: "remote-collision", lamport_ts: 30 }),
    ],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id FROM sync_conflicts WHERE row_id = '880'", args: [] });
  const conflictId = crows[0].id;

  // Restore must be refused
  const outcome = await restoreConflict(db, conflictId, { instanceSync: null });
  assert.equal(outcome.status, "refused", "insert conflict restore should be refused");
  assert.ok(outcome.message && outcome.message.length > 0, "should have explanatory message");

  // Conflict still unresolved
  const { rows: confRows } = await db.execute({ sql: "SELECT resolved FROM sync_conflicts WHERE id = ?", args: [conflictId] });
  assert.equal(Number(confRows[0].resolved), 0, "conflict should remain unresolved after refused restore");

  // resolveConflict (keep current) must still work
  await resolveConflict(db, conflictId);
  const { rows: confRows2 } = await db.execute({ sql: "SELECT resolved FROM sync_conflicts WHERE id = ?", args: [conflictId] });
  assert.equal(Number(confRows2[0].resolved), 1, "resolveConflict should work for insert conflicts");

  db.close();
});

// ── Test 14: Missing op column (pre-init-db host) — opus review F1 ────────────

test("14. Legacy DB without sync_conflicts.op: stale update still skipped AND conflict still logged", async () => {
  // Simulates a fleet host that pulled new code but never ran init-db: the
  // conflict INSERT naming `op` throws there, and before the F1 fix that throw
  // fell through _checkConflict's catch to "apply" — silently overwriting
  // newer local data with a stale remote row.
  const INST = "inst-t14";
  const REMOTE = "remote-t14";
  const legacyDir = mkdtempSync(join(tmpdir(), "crow-isync-legacy-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: legacyDir },
    stdio: "pipe",
  });
  const db = createDbClient(join(legacyDir, "crow.db"));
  // Recreate the pre-W4-1 schema state
  await db.execute({ sql: "ALTER TABLE sync_conflicts DROP COLUMN op", args: [] });

  const mgr = new InstanceSyncManager(IDENTITY, db, INST);

  await db.execute({
    sql: "INSERT INTO memories (id, category, content, lamport_ts) VALUES (900, 'general', 'newer-local', 50)",
    args: [],
  });

  const feed = makeStubFeed();
  feed.push(signEntry({
    table: "memories", op: "update",
    row: { id: 900, content: "stale-remote", lamport_ts: 10 },
    lamport_ts: 10, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // Local data preserved — the stale update must NOT have applied
  const { rows: memRows } = await db.execute({
    sql: "SELECT content FROM memories WHERE id = 900", args: [],
  });
  assert.equal(memRows[0].content, "newer-local", "stale remote update must not overwrite newer local data");

  // Conflict trace preserved via the legacy column set
  const { rows: confRows } = await db.execute({
    sql: "SELECT * FROM sync_conflicts WHERE row_id = '900'", args: [],
  });
  assert.equal(confRows.length, 1, "conflict must still be logged without the op column");

  db.close();
  rmSync(legacyDir, { recursive: true, force: true });
});

// ── Tests 15-22: W4-1b crow_context replication ───────────────────────────────

// Helper: seed a crow_context row for tests below.
async function seedCtxRow(db, { section_key, section_title = "Test", content = "body", sort_order = 10, enabled = 1, device_id = null, project_id = null, lamport_ts = 0 } = {}) {
  await db.execute({
    sql: `INSERT OR REPLACE INTO crow_context
            (section_key, section_title, content, sort_order, enabled, device_id, project_id, lamport_ts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [section_key, section_title, content, sort_order, enabled, device_id, project_id, lamport_ts],
  });
}

// ── Test 15: Update replicates ────────────────────────────────────────────────

test("15. crow_context update replicates: full-row update applies content+enabled+sort_order; device-scoped row untouched; project-scoped (INTEGER IS ?) applies", async () => {
  const INST = "inst-t15";
  const REMOTE = "remote-t15";
  const { mgr, db } = makeManager(INST);

  // Global row
  await seedCtxRow(db, { section_key: "identity", content: "old", enabled: 1, sort_order: 5, lamport_ts: 10 });
  // Device-scoped row — must NOT be touched by a global update
  await seedCtxRow(db, { section_key: "identity", content: "device-local", device_id: "dev-xyz", lamport_ts: 10 });
  // Project-scoped row (INTEGER project_id — tests the fourth partial index)
  await seedCtxRow(db, { section_key: "identity", content: "proj-old", project_id: 42, lamport_ts: 10 });

  const feed = makeStubFeed();
  // Global update (newer ts)
  feed.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "identity", section_title: "Identity", content: "new-content", enabled: 0, sort_order: 99, device_id: null, project_id: null },
    lamport_ts: 50, instance_id: REMOTE,
  }));
  // Project-scoped update (newer ts, INTEGER project_id)
  feed.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "identity", section_title: "Identity", content: "proj-new", enabled: 1, sort_order: 10, device_id: null, project_id: 42 },
    lamport_ts: 50, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // Global row updated
  const { rows: globalRows } = await db.execute({
    sql: "SELECT content, enabled, sort_order, lamport_ts FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS NULL",
    args: ["identity"],
  });
  assert.equal(globalRows[0].content, "new-content", "global content updated");
  assert.equal(Number(globalRows[0].enabled), 0, "enabled updated (INTEGER 0)");
  assert.equal(Number(globalRows[0].sort_order), 99, "sort_order updated");
  assert.equal(Number(globalRows[0].lamport_ts), 50, "lamport_ts stamped to incomingTs");

  // Device-scoped row untouched
  const { rows: devRows } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = ? AND device_id = ?",
    args: ["identity", "dev-xyz"],
  });
  assert.equal(devRows[0].content, "device-local", "device-scoped row must not be touched by global update");

  // Project-scoped row updated
  const { rows: projRows } = await db.execute({
    sql: "SELECT content, lamport_ts FROM crow_context WHERE section_key = ? AND project_id IS 42",
    args: ["identity"],
  });
  assert.equal(projRows[0].content, "proj-new", "project-scoped row updated via INTEGER IS ? path");
  assert.equal(Number(projRows[0].lamport_ts), 50, "project-scoped lamport_ts stamped");

  db.close();
});

// ── Test 16: Delete replicates + delete conflict ──────────────────────────────

test("16. crow_context delete replicates: newer delete removes row; stale delete vs newer local → row survives + op=delete conflict", async () => {
  const INST = "inst-t16";
  const REMOTE = "remote-t16";
  const { mgr, db } = makeManager(INST);

  // Row A: will be deleted (newer incoming ts)
  await seedCtxRow(db, { section_key: "custom_a", content: "bye", lamport_ts: 5 });
  // Row B: will survive (stale incoming ts)
  await seedCtxRow(db, { section_key: "custom_b", content: "stay", lamport_ts: 100 });

  const feed = makeStubFeed();
  feed.push(signEntry({
    table: "crow_context", op: "delete",
    row: { section_key: "custom_a", device_id: null, project_id: null },
    lamport_ts: 50, instance_id: REMOTE,
  }));
  feed.push(signEntry({
    table: "crow_context", op: "delete",
    row: { section_key: "custom_b", device_id: null, project_id: null },
    lamport_ts: 10, instance_id: REMOTE,  // stale: localTs=100
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // custom_a deleted
  const { rows: rowA } = await db.execute({
    sql: "SELECT id FROM crow_context WHERE section_key = 'custom_a' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(rowA.length, 0, "custom_a should be deleted by newer delete");

  // custom_b survives
  const { rows: rowB } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 'custom_b' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(rowB.length, 1, "custom_b must survive stale delete");
  assert.equal(rowB[0].content, "stay");

  // Conflict row for custom_b with op='delete'
  const expectedRowId = JSON.stringify({ section_key: "custom_b", device_id: null, project_id: null });
  const { rows: conflicts } = await db.execute({
    sql: "SELECT op FROM sync_conflicts WHERE row_id = ?",
    args: [expectedRowId],
  });
  assert.equal(conflicts.length, 1, "conflict row logged for stale delete");
  assert.equal(conflicts[0].op, "delete", "conflict op='delete'");

  db.close();
});

// ── Test 17: Stale update + tie + re-delivery ────────────────────────────────

test("17. crow_context stale update: non-equivalent → conflict; equivalent re-delivery → silent skip; tie + different data → conflict, local kept", async () => {
  const INST = "inst-t17";
  const REMOTE = "remote-t17";
  const { mgr, db } = makeManager(INST);

  await seedCtxRow(db, { section_key: "t17_section", content: "local-val", lamport_ts: 20 });

  const feed = makeStubFeed();

  // (a) Stale, non-equivalent → conflict
  feed.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "t17_section", content: "stale-different", device_id: null, project_id: null },
    lamport_ts: 5, instance_id: REMOTE,
  }));

  // (b) Stale, equivalent → silent skip (same content, same ts <= localTs)
  feed.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "t17_section", content: "local-val", device_id: null, project_id: null },
    lamport_ts: 10, instance_id: REMOTE,
  }));

  // (c) Tie (incomingTs == localTs=20) + different data → conflict, local kept
  feed.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "t17_section", content: "tie-different", device_id: null, project_id: null },
    lamport_ts: 20, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // Local content unchanged throughout (conflict = local kept)
  const { rows } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 't17_section' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(rows[0].content, "local-val", "local content preserved after stale/conflict entries");

  // Two conflict rows (stale-different and tie-different), zero for re-delivery
  const rowIdJson = JSON.stringify({ section_key: "t17_section", device_id: null, project_id: null });
  const { rows: conflicts } = await db.execute({
    sql: "SELECT op FROM sync_conflicts WHERE row_id = ?",
    args: [rowIdJson],
  });
  assert.equal(conflicts.length, 2, "two conflict rows (non-equiv stale + tie-different); equivalent re-delivery silent");

  db.close();
});

// ── Test 18: Emit stamps local row ───────────────────────────────────────────

test("18. crow_context emitChange stamps local row's lamport_ts (global and device-scoped); stamping is monotonic", async () => {
  const INST = "inst-t18";
  const { mgr, db } = makeManager(INST);

  // Seed a global and device-scoped row both at lamport_ts=0
  await seedCtxRow(db, { section_key: "t18_global", content: "g", lamport_ts: 0 });
  await seedCtxRow(db, { section_key: "t18_dev", content: "d", device_id: "dev-t18", lamport_ts: 0 });

  // emitChange for the global row
  await mgr.emitChange("crow_context", "update", {
    section_key: "t18_global", content: "g", device_id: null, project_id: null,
  });

  const { rows: gRows } = await db.execute({
    sql: "SELECT lamport_ts FROM crow_context WHERE section_key = 't18_global' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  const ts1 = Number(gRows[0].lamport_ts);
  assert.ok(ts1 > 0, `global lamport_ts should be stamped > 0, got ${ts1}`);

  // emitChange for the device-scoped row
  await mgr.emitChange("crow_context", "update", {
    section_key: "t18_dev", content: "d", device_id: "dev-t18", project_id: null,
  });

  const { rows: dRows } = await db.execute({
    sql: "SELECT lamport_ts FROM crow_context WHERE section_key = 't18_dev' AND device_id = 'dev-t18'",
    args: [],
  });
  const ts2 = Number(dRows[0].lamport_ts);
  assert.ok(ts2 > 0, `device-scoped lamport_ts should be stamped > 0, got ${ts2}`);

  // Monotonic guard: stamp the row STRICTLY ABOVE what the next emit will
  // allocate (counter forced to 1 → next ts = 2), then emit. Under a plain
  // `lamport_ts = ?` assignment the stamp would drop to 2; only
  // MAX(COALESCE(lamport_ts,0), ?) keeps it at 50.
  await db.execute({
    sql: "UPDATE crow_context SET lamport_ts = 50 WHERE section_key = 't18_global' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  await db.execute({
    sql: "UPDATE sync_state SET local_counter = 1 WHERE instance_id = ?",
    args: [INST],
  });
  await mgr.emitChange("crow_context", "update", {
    section_key: "t18_global", content: "g", device_id: null, project_id: null,
  });
  const { rows: gRows2 } = await db.execute({
    sql: "SELECT lamport_ts FROM crow_context WHERE section_key = 't18_global' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  const ts3 = Number(gRows2[0].lamport_ts);
  assert.equal(ts3, 50, `MAX guard: a lower fresh ts must not lower the existing stamp (got ${ts3})`);

  db.close();
});

test("2c-C1a. emitChange opts.lamportTs: envelope preserved, local row NOT re-stamped, counter floored", async () => {
  const { mgr, db } = makeManager("inst-2c-c1");
  const captured = [];
  mgr.outFeeds = new Map([["peer-x", { append: async (e) => captured.push(e) }]]);
  // Row's own lamport_ts (9) diverges from opts.lamportTs (5) on purpose: this
  // is the only way to tell "envelope preserves opts.lamportTs" apart from a
  // bug where preserve-mode reuses the row's own current lamport instead.
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:c1a', '', 'a1', 'Old Name', 9)",
    args: [],
  });
  const { rows: r0 } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:c1a'", args: [] });
  const ts = await mgr.emitChange("contacts", "update", r0[0], { lamportTs: 5 });
  assert.equal(ts, 5, "returns the preserved envelope lamport (opts.lamportTs), not the row's own lamport");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].lamport_ts, 5, "envelope carries the preserved opts.lamportTs, not the row's own lamport");
  const { rows: r1 } = await db.execute({ sql: "SELECT lamport_ts FROM contacts WHERE crow_id = 'crow:c1a'", args: [] });
  assert.equal(Number(r1[0].lamport_ts), 9, "local row lamport NOT re-stamped (stays at its original 9)");
  // Counter floored: the next fresh mint must exceed BOTH the row's own
  // lamport (9) and the preserved value (5) — i.e. > 9, the higher of the two.
  const fresh = await mgr._nextLamport();
  assert.ok(fresh > 9, `next mint ${fresh} must exceed row lamport 9`);
  db.close();
});

test("2c-C1b. emitChange without opts: behavior unchanged (fresh mint + local stamp)", async () => {
  const { mgr, db } = makeManager("inst-2c-c1b");
  const captured = [];
  mgr.outFeeds = new Map([["peer-x", { append: async (e) => captured.push(e) }]]);
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, lamport_ts) VALUES ('crow:c1b', '', 'b1', 5)",
    args: [],
  });
  const { rows: r0 } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:c1b'", args: [] });
  const ts = await mgr.emitChange("contacts", "update", r0[0]);
  assert.ok(ts > 5, "fresh mint exceeds row lamport (counter floor)");
  const { rows: r1 } = await db.execute({ sql: "SELECT lamport_ts FROM contacts WHERE crow_id = 'crow:c1b'", args: [] });
  assert.equal(Number(r1[0].lamport_ts), ts, "local row re-stamped with the fresh mint");
  db.close();
});

test("2c-C1c. emitChange opts.lamportTs === 0 (NULL-legacy sentinel): preserved not minted, local row stays NULL", async () => {
  const { mgr, db } = makeManager("inst-2c-c1c");
  const captured = [];
  mgr.outFeeds = new Map([["peer-x", { append: async (e) => captured.push(e) }]]);
  // lamport_ts explicitly NULL (the column has DEFAULT 0, so merely omitting
  // it would NOT produce NULL) — this is the legacy-row sentinel that later
  // tasks rely on.
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:c1c', '', 'c1', 'Legacy Name', NULL)",
    args: [],
  });
  const { rows: r0 } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:c1c'", args: [] });
  const ts = await mgr.emitChange("contacts", "update", r0[0], { lamportTs: 0 });
  assert.equal(ts, 0, "returns the preserved envelope lamport (0), not a fresh mint");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].lamport_ts, 0, "envelope carries the preserved 0, not a freshly minted value");
  const { rows: r1 } = await db.execute({ sql: "SELECT lamport_ts FROM contacts WHERE crow_id = 'crow:c1c'", args: [] });
  assert.equal(r1[0].lamport_ts, null, "local row lamport stays NULL (not re-stamped)");
  db.close();
});

// ── Test 19: Upsert (update for missing row) ──────────────────────────────────

test("19. crow_context upsert: update for absent section creates row with lamport_ts=incomingTs; stale follow-up → conflict/skip not applied; partial old-sender entry missing content → skipped; resurrection case", async () => {
  const INST = "inst-t19";
  const REMOTE = "remote-t19";
  const { mgr, db } = makeManager(INST);

  // (a) Update entry for a section absent locally → row created
  const feed = makeStubFeed();
  feed.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "t19_upsert", section_title: "T19", content: "born", enabled: 1, sort_order: 5, device_id: null, project_id: null },
    lamport_ts: 30, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  const { rows } = await db.execute({
    sql: "SELECT content, lamport_ts FROM crow_context WHERE section_key = 't19_upsert' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(rows.length, 1, "upsert created the row");
  assert.equal(rows[0].content, "born");
  assert.equal(Number(rows[0].lamport_ts), 30, "lamport_ts = incomingTs (C2 — not default 0)");

  // (b) Stale follow-up with different data → conflict (not applied)
  // Use a different remote id so the checkpoint doesn't skip it.
  const REMOTE2 = "remote-t19b";
  const feed2 = makeStubFeed();
  feed2.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "t19_upsert", section_title: "T19", content: "stale-attempt", device_id: null, project_id: null },
    lamport_ts: 10, instance_id: REMOTE2,
  }));
  await mgr._processNewEntries(REMOTE2, feed2);
  const { rows: rows2 } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 't19_upsert' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(rows2[0].content, "born", "stale follow-up must not overwrite");
  const rowIdJson = JSON.stringify({ section_key: "t19_upsert", device_id: null, project_id: null });
  const { rows: conflicts } = await db.execute({
    sql: "SELECT id FROM sync_conflicts WHERE row_id = ?",
    args: [rowIdJson],
  });
  assert.ok(conflicts.length >= 1, "stale follow-up logs conflict");

  // (c) Old-sender partial entry missing content for an absent section → skipped.
  // Distinct remote: reusing REMOTE would no-op via its advanced checkpoint
  // (lastSeq=1 vs a fresh feed's seq 0) and never exercise the guard.
  const REMOTE_PARTIAL = "remote-t19-partial";
  const feed3 = makeStubFeed();
  feed3.push(signEntry({
    table: "crow_context", op: "update",
    row: { section_key: "t19_partial", section_title: "Partial", device_id: null, project_id: null },  // no content
    lamport_ts: 40, instance_id: REMOTE_PARTIAL,
  }));
  await mgr._processNewEntries(REMOTE_PARTIAL, feed3);
  const { rows: partialRows } = await db.execute({
    sql: "SELECT id FROM crow_context WHERE section_key = 't19_partial'",
    args: [],
  });
  assert.equal(partialRows.length, 0, "partial old-sender entry (missing content) must not create a row");

  // (d) Resurrection: delete locally, re-deliver the older update → row recreated
  await db.execute({
    sql: "DELETE FROM crow_context WHERE section_key = 't19_upsert' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  const { rows: afterDelete } = await db.execute({
    sql: "SELECT id FROM crow_context WHERE section_key = 't19_upsert'",
    args: [],
  });
  assert.equal(afterDelete.length, 0, "row deleted before resurrection test");

  const REMOTE3 = "remote-t19c";
  const feed4 = makeStubFeed();
  feed4.push(signEntry({
    table: "crow_context", op: "update",  // pre-delete update re-delivered
    row: { section_key: "t19_upsert", section_title: "T19", content: "resurrected", enabled: 1, sort_order: 5, device_id: null, project_id: null },
    lamport_ts: 30, instance_id: REMOTE3,
  }));
  await mgr._processNewEntries(REMOTE3, feed4);
  const { rows: resurrected } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 't19_upsert' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(resurrected.length, 1, "row resurrected by re-delivered update (C4: resurrection-over-loss)");
  assert.equal(resurrected[0].content, "resurrected");

  db.close();
});

// ── Test 20: Insert LWW routing ───────────────────────────────────────────────

test("20. crow_context insert LWW routing: insert colliding with older local row → applied as update (newer wins); colliding with newer local + different data → conflict, local kept", async () => {
  const INST = "inst-t20";
  const REMOTE = "remote-t20";
  const { mgr, db } = makeManager(INST);

  // Row with older local ts — incoming insert should win
  await seedCtxRow(db, { section_key: "t20_lww_a", content: "old-local", lamport_ts: 5 });
  // Row with newer local ts — local should win
  await seedCtxRow(db, { section_key: "t20_lww_b", content: "newer-local", lamport_ts: 100 });

  const feed = makeStubFeed();
  // Insert for t20_lww_a (incomingTs=50 > localTs=5) → should apply
  feed.push(signEntry({
    table: "crow_context", op: "insert",
    row: { section_key: "t20_lww_a", section_title: "A", content: "incoming-wins", enabled: 1, sort_order: 1, device_id: null, project_id: null },
    lamport_ts: 50, instance_id: REMOTE,
  }));
  // Insert for t20_lww_b (incomingTs=10 < localTs=100, different data) → conflict
  feed.push(signEntry({
    table: "crow_context", op: "insert",
    row: { section_key: "t20_lww_b", section_title: "B", content: "incoming-loses", enabled: 1, sort_order: 1, device_id: null, project_id: null },
    lamport_ts: 10, instance_id: REMOTE,
  }));

  await mgr._processNewEntries(REMOTE, feed);

  // t20_lww_a: incoming wins (newer ts)
  const { rows: aRows } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 't20_lww_a' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(aRows[0].content, "incoming-wins", "newer incoming insert applied over older local");

  // t20_lww_b: local kept (stale incoming)
  const { rows: bRows } = await db.execute({
    sql: "SELECT content FROM crow_context WHERE section_key = 't20_lww_b' AND device_id IS NULL AND project_id IS NULL",
    args: [],
  });
  assert.equal(bRows[0].content, "newer-local", "local row wins against stale incoming insert");

  // Conflict row for t20_lww_b
  const rowIdJson = JSON.stringify({ section_key: "t20_lww_b", device_id: null, project_id: null });
  const { rows: conflicts } = await db.execute({
    sql: "SELECT op FROM sync_conflicts WHERE row_id = ?",
    args: [rowIdJson],
  });
  assert.ok(conflicts.length >= 1, "conflict logged for stale insert vs newer local");

  db.close();
});

// ── Test 21: Restore refused ─────────────────────────────────────────────────

test("21. crow_context restore refused: restoreConflict returns refused AND winning_data is byte-identical before and after (C3)", async () => {
  const INST = "inst-t21";
  const REMOTE = "remote-t21";
  const { mgr, db } = makeManager(INST);

  const rowIdJson = JSON.stringify({ section_key: "t21_ctx", device_id: null, project_id: null });
  const winningDataSnapshot = JSON.stringify({ section_key: "t21_ctx", content: "local-kept", lamport_ts: 50 });

  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, op)
          VALUES ('crow_context', ?, ?, ?, 50, 10, ?, ?, 'update')`,
    args: [rowIdJson, INST, REMOTE, winningDataSnapshot, JSON.stringify({ section_key: "t21_ctx", content: "remote-version" })],
  });

  const { rows: crows } = await db.execute({ sql: "SELECT id, winning_data FROM sync_conflicts WHERE row_id = ?", args: [rowIdJson] });
  const conflictId = crows[0].id;
  const winningDataBefore = crows[0].winning_data;

  const outcome = await restoreConflict(db, conflictId, { instanceSync: null });
  assert.equal(outcome.status, "refused", "crow_context restore must be refused");
  assert.ok(outcome.message && outcome.message.includes("crow_context"), "refusal message mentions crow_context");

  // winning_data must be byte-identical (C3: stale guard must not run first and destroy it)
  const { rows: confRows } = await db.execute({
    sql: "SELECT winning_data, resolved FROM sync_conflicts WHERE id = ?",
    args: [conflictId],
  });
  assert.equal(confRows[0].winning_data, winningDataBefore, "winning_data byte-identical after refused restore (C3)");
  assert.equal(Number(confRows[0].resolved), 0, "conflict stays unresolved after refused restore");

  // resolveConflict must still work for crow_context conflicts
  await resolveConflict(db, conflictId);
  const { rows: confRows2 } = await db.execute({ sql: "SELECT resolved FROM sync_conflicts WHERE id = ?", args: [conflictId] });
  assert.equal(Number(confRows2[0].resolved), 1, "resolveConflict must work for crow_context conflicts");

  db.close();
});

// ── Test 22: Sender emits — VALUES, not just shape ───────────────────────────

test("22a. buildCrowContextWireRow unit test: allowlist fields present; id/lamport_ts/updated_at absent; enabled is integer", () => {
  const dbRow = {
    id: 99,
    section_key: "identity",
    section_title: "Identity",
    content: "some content",
    sort_order: 10,
    enabled: 0,       // INTEGER 0 from DB (must not be coerced to boolean)
    device_id: null,
    project_id: null,
    lamport_ts: 42,
    updated_at: "2026-06-11T00:00:00Z",
    extra_future_col: "ignored",
  };

  const wire = buildCrowContextWireRow(dbRow);

  // Allowlist fields present
  assert.ok("section_key"   in wire, "section_key present");
  assert.ok("section_title" in wire, "section_title present");
  assert.ok("content"       in wire, "content present");
  assert.ok("sort_order"    in wire, "sort_order present");
  assert.ok("enabled"       in wire, "enabled present");
  assert.ok("device_id"     in wire, "device_id present");
  assert.ok("project_id"    in wire, "project_id present");

  // Forbidden fields absent
  assert.ok(!("id"          in wire), "id must not be in wire row");
  assert.ok(!("lamport_ts"  in wire), "lamport_ts must not be in wire row");
  assert.ok(!("updated_at"  in wire), "updated_at must not be in wire row");

  // enabled is the INTEGER 0 from the DB (not boolean false)
  assert.equal(wire.enabled, 0, "enabled is integer 0");
  assert.strictEqual(typeof wire.enabled, "number", "enabled is a number not boolean");

  // Values match source
  assert.equal(wire.section_key, "identity");
  assert.equal(wire.content, "some content");
  assert.equal(wire.device_id, null);
});

test("22b. crow_update_context_section emits post-UPDATE values (not pre-update values)", async () => {
  // Spin up a real memory server with an emitChange spy injected as syncManager.
  // Call crow_update_context_section changing content AND enabled.
  // Assert the captured emit carries the POST-update values:
  //   a pre-update-SELECT emit has the same shape but different values → fails the assertion.
  const testDir = mkdtempSync(join(tmpdir(), "crow-isync-t22b-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: testDir },
    stdio: "pipe",
  });
  const dbPath = join(testDir, "crow.db");

  const emitted = [];
  const spySync = {
    emitChange: async (table, op, row) => { emitted.push({ table, op, row }); return 1; },
  };

  const memServer = createMemoryServer(dbPath, { syncManager: spySync });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await memServer.connect(serverTransport);
  const client = new Client({ name: "test22b", version: "0" });
  await client.connect(clientTransport);

  // Seed the identity section so it exists to update
  const seedDb = createDbClient(dbPath);
  await seedCtxRow(seedDb, { section_key: "identity", section_title: "Identity", content: "original", enabled: 1, sort_order: 10 });
  seedDb.close();

  // Call the MCP tool to update content and enabled
  await client.callTool({
    name: "crow_update_context_section",
    arguments: { section_key: "identity", content: "updated-content", enabled: false },
  });

  // Verify the emit was fired
  const ctxEmits = emitted.filter((e) => e.table === "crow_context" && e.op === "update");
  assert.ok(ctxEmits.length >= 1, "at least one crow_context update emit fired");

  const emit = ctxEmits[ctxEmits.length - 1];
  // Post-update values must be reflected in the wire row
  assert.equal(emit.row.content, "updated-content", "emit carries POST-update content (not pre-update)");
  assert.equal(Number(emit.row.enabled), 0, "emit carries POST-update enabled=0 (INTEGER, not boolean)");
  // Allowlist enforced: no id or lamport_ts
  assert.ok(!("id" in emit.row), "id must not be in emitted wire row");
  assert.ok(!("lamport_ts" in emit.row), "lamport_ts must not be in emitted wire row");

  await client.close();
  rmSync(testDir, { recursive: true, force: true });
});
