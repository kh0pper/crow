// tests/lamport-reemit.test.js
//
// Item 2c — Lamport-preserving re-emit + boot-window emit loss: the EXECUTABLE
// two-instance acceptance gate (design §5, spec
// docs/superpowers/specs/2026-07-14-lamport-preserving-reemit-design.md).
//
// This file (Task 4) carries the SHARED harness that Tasks 5–7 extend, plus the
// C3 gate cases G3/G3b/G3c: the per-peer ordered append chain (_appendLocks),
// the boot-window pending queue (_pendingPeerEmits), and the drain-on-arm seam
// (_drainPendingEmits) wired into _initInstanceInner.
//
// HARNESS: two real instances (each its own mkdtemp CROW_DATA_DIR + real init-db +
// real InstanceSyncManager) joined by a fake out-feed that captures every entry a
// chained append/drain writes and hands it to the peer's _applyEntry() — adapted
// from tests/group-tombstones.test.js. Deltas: outFeeds are keyed by the OTHER
// instance's REAL id (not "peer"); each instance's crow_instances is seeded with
// the other as an active paired peer (so emitChange's per-peer broadcast targets
// it even while unarmed); the emit sink helper act() binds contact-sync.js's
// __setEmitSinkForTest (contact emits route there — a SEPARATE sink from groups).
//
// NEVER point this file at ~/.crow — it DELETES contacts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── identities ───────────────────────────────────────────────────────────────
// One shared ed25519 identity: instance-sync verifies every entry against
// `this.identity.ed25519Pubkey`, and a user's instances share one identity.
const TEST_PRIV = Buffer.alloc(32, 0x2c);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

const A_ID = "inst-aaaa-0000-0000-0000-00000000000a";
const B_ID = "inst-bbbb-0000-0000-0000-00000000000b";

// ── two real instances ───────────────────────────────────────────────────────
function initInstance(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-2c-reemit-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db (init-db.js:11) — blank it, or a
    // shell exporting it (grackle's .env did, PR #180) would run the migration
    // against the REAL DB, outside the deploy rail's backups.
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  return { dir, path: join(dir, "crow.db") };
}
const A_FILES = initInstance("a");
const B_FILES = initInstance("b");

// Seed each instance's crow_instances with the OTHER as an active paired peer,
// ONCE, in the on-disk file — every fresh newFleet() db handle sees the row.
// emitChange's per-peer broadcast reads this table to find unarmed paired peers
// (the boot-window target set), so without it G3's park-while-closed never fires.
{
  const sa = createDbClient(A_FILES.path);
  await sa.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, 'active')", args: [B_ID, "B", "crow:b"] });
  const sb = createDbClient(B_FILES.path);
  await sb.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, 'active')", args: [A_ID, "A", "crow:a"] });
}

after(() => {
  __setEmitSinkForTest(null);
  rmSync(A_FILES.dir, { recursive: true, force: true });
  rmSync(B_FILES.dir, { recursive: true, force: true });
});

/**
 * The shared feed. `wire` holds EVERY entry either instance appended. deliver()
 * drains in append order. Out-feeds are keyed by the OTHER instance's real id so
 * emitChange's per-peer broadcast (targets = paired ids ∪ outFeeds.keys()) both
 * finds the stub and never double-appends.
 */
function newFleet() {
  const wire = [];
  const A = { id: A_ID, db: createDbClient(A_FILES.path) };
  const B = { id: B_ID, db: createDbClient(B_FILES.path) };
  const attach = (inst) => {
    inst.mgr = new InstanceSyncManager(IDENTITY, inst.db, inst.id);
    inst.mgr.feedsDisabled = false; // scratch env sets CROW_DISABLE_INSTANCE_SYNC=1
    const otherId = inst.id === A_ID ? B_ID : A_ID;
    inst.mgr.outFeeds = new Map([[otherId, {
      append: async (e) => { wire.push({ from: inst.id, entry: JSON.parse(JSON.stringify(e)) }); },
    }]]);
  };
  attach(A);
  attach(B);
  let cursor = 0;
  const other = (fromId) => (fromId === A.id ? B : A);
  /** Apply one captured wire item to a destination instance (JSON round-tripped). */
  const applyItem = async (dest, item) =>
    dest.mgr._applyEntry(item.from, JSON.parse(JSON.stringify(item.entry)));
  /** Replicate every un-delivered entry to the other side, in append order. */
  const deliver = async () => {
    while (cursor < wire.length) {
      const item = wire[cursor++];
      await applyItem(other(item.from), item);
    }
  };
  /** Mark everything currently on the wire as delivered WITHOUT applying. */
  const skimWire = () => { const items = wire.slice(cursor); cursor = wire.length; return items; };
  /** Restart an instance: brand-new db handle + manager over the SAME file. */
  const restart = async (inst) => {
    inst.db = createDbClient(inst.id === A_ID ? A_FILES.path : B_FILES.path);
    attach(inst);
  };
  return { A, B, wire, deliver, applyItem, skimWire, restart, other };
}

/** Run `fn` with `inst` as the CONTACT emit sink — an emit belongs to exactly one instance. */
async function act(inst, fn) {
  __setEmitSinkForTest(inst.mgr);
  try { return await fn(); } finally { __setEmitSinkForTest(null); }
}

export { newFleet, act, A_ID, B_ID, IDENTITY };

// ── G3: boot-window delete queues, drains on arm, peer converges ───────────────
test("G3: boot-window delete queues, drains on arm, peer converges", async () => {
  const f = newFleet();
  // Seed the same contact on both sides, converged at lamport 5.
  for (const inst of [f.A, f.B]) {
    await inst.db.execute({ sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, lamport_ts) VALUES ('crow:g3', '', 'aa11', 'G3', 5)", args: [] });
  }
  // A's counter reflects the converged lamport: in prod A reached lamport 5 by
  // emitting, so its originating delete mints ABOVE 5. Without this, a
  // fresh-counter delete rides @1 and loses the (unrelated, pre-existing) #155
  // delete-LWW gate (lamportTs > localTs) to B's row@5 — masking the C3 mechanism
  // this case exercises (the queue/drain seam, not delete LWW).
  await f.A.mgr._advanceCounter(5);
  // A's boot window: NO armed feeds (but B is paired in crow_instances via the harness).
  f.A.mgr.outFeeds = new Map();
  const { deleteContactLocal } = await import("../servers/sharing/contact-delete.js");
  const { rows } = await f.A.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g3'", args: [] });
  await act(f.A, () => deleteContactLocal(f.A.db, {}, rows[0]));
  assert.equal(f.wire.length, 0, "nothing rode while feeds were closed");
  const { rows: tombA } = await f.A.db.execute({ sql: "SELECT * FROM contact_tombstones WHERE crow_id = 'crow:g3'", args: [] });
  assert.ok(tombA[0], "local tombstone written in the window");
  // Arm A→B and drain through the REAL seam.
  f.A.mgr.outFeeds = new Map([[f.B.id, { append: async (e) => f.wire.push({ from: f.A.id, entry: JSON.parse(JSON.stringify(e)) }) }]]);
  const drained = await f.A.mgr._drainPendingEmits(f.B.id);
  assert.equal(drained, 1, "the queued delete drained");
  assert.equal(f.wire.length, 1);
  assert.equal(Number(f.wire[0].entry.lamport_ts), Number(tombA[0].lamport_ts), "tombstone lamport == envelope lamport");
  await f.deliver();
  const { rows: rowB } = await f.B.db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = 'crow:g3'", args: [] });
  assert.equal(rowB.length, 0, "B's row deleted");
  const { rows: tombB } = await f.B.db.execute({ sql: "SELECT * FROM contact_tombstones WHERE crow_id = 'crow:g3'", args: [] });
  assert.ok(tombB[0], "B tombstoned");
});

// ── G3b: real initInstance invokes the drain after arming (scratch dataDir) ────
test("G3b: real initInstance invokes the drain after arming (scratch dataDir)", async () => {
  const f = newFleet();
  const scratch = mkdtempSync(join(tmpdir(), "crow-2c-g3b-"));
  f.A.mgr.dataDir = join(scratch, "instance-sync"); // isolate from process default (tests/instance-sync-noauth-feeds.test.js:71)
  f.A.mgr.outFeeds = new Map();
  // Park one entry for B.
  await f.A.mgr._appendToPeer(f.B.id, { table: "contacts", op: "update", row: { crow_id: "crow:g3b" }, lamport_ts: 1, instance_id: f.A.id });
  const calls = [];
  const realDrain = f.A.mgr._drainPendingEmits.bind(f.A.mgr);
  f.A.mgr._drainPendingEmits = async (peerId) => { calls.push(peerId); return realDrain(peerId); };
  try {
    await f.A.mgr.initInstance(f.B.id, null); // real Hypercore on scratch disk
    assert.ok(calls.includes(f.B.id), "initInstance drained the pending slot after arming");
    const feed = f.A.mgr.outFeeds.get(f.B.id);
    assert.equal(feed.length, 1, "pending entry is readable from the REAL Hypercore");
    const block = await feed.get(0);
    assert.equal(block.row.crow_id, "crow:g3b");
  } finally {
    try { await f.A.mgr.outFeeds.get(f.B.id)?.close(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── G3c: chain preserves emit order across the open transition ─────────────────
test("G3c: chain preserves emit order across the open transition; nothing duplicated or stranded", async () => {
  const f = newFleet();
  f.A.mgr.outFeeds = new Map();
  const appended = [];
  // E1 parks (feed closed).
  await f.A.mgr._appendToPeer(f.B.id, { marker: "E1" });
  // Arm with a SLOW stub append so the drain is in flight when E2 is emitted.
  f.A.mgr.outFeeds = new Map([[f.B.id, { append: async (e) => { await new Promise((r) => setTimeout(r, 20)); appended.push(e.marker); } }]]);
  const drainP = f.A.mgr._drainPendingEmits(f.B.id);      // chained task 1 (slow)
  const liveP = f.A.mgr._appendToPeer(f.B.id, { marker: "E2" }); // chained task 2
  await Promise.all([drainP, liveP]);
  assert.deepEqual(appended, ["E1", "E2"], "E1 strictly before E2");
  assert.equal((f.A.mgr._pendingPeerEmits.get(f.B.id) || []).length, 0, "nothing stranded");
});
