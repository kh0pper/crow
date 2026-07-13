// tests/group-tombstones.test.js
//
// Item 2b — contact_groups offline-peer tombstones: the EXECUTABLE acceptance gate
// (design §5, spec docs/superpowers/specs/2026-07-13-group-tombstones-design.md).
// Covers W2 (strict delete-wins in _applyGroup) + G1 (STATEMENT-LEVEL tombstone
// guards on the insert/update writes): tests T1, T2, T3, T4, T5, T8.
//
// HARNESS: two real instances (each its own mkdtemp CROW_DATA_DIR + real init-db +
// real InstanceSyncManager) joined by a fake out-feed that captures every entry
// emitChange() appends and hands it to the peer's _applyEntry() — adapted from
// tests/advertised-prune-durability.test.js. ⚠️ Harness trap (design R1 F5a): that
// file installs contact-sync.js's test sink; GROUP emits route through
// group-sync.js's SEPARATE __setEmitSinkForTest — wired here — and every emit
// asserts wire growth before any drain (an emit into a null sink would make every
// wire-order assertion below pass vacuously).
//
// W1 (the originating delete_group handler) is Task 3; deleteGroupLocalW1() below
// simulates its specced shape (tombstone + DELETE in ONE db.batch, then
// emitGroupDelete) so T1/T2/T3 exercise the full two-instance flow.
//
// NEVER point this file at ~/.crow or ~/.crow-mpa — this code path DELETES groups.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { emitGroupUpsert, emitGroupDelete, __setEmitSinkForTest } from "../servers/sharing/group-sync.js";
import { groupTombstoneStatement, readGroupTombstone } from "../servers/sharing/group-delete.js";
import { restoreConflict } from "../servers/sharing/sync-conflict-resolve.js";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { getGroups } from "../servers/gateway/dashboard/panels/contacts/data-queries.js";
import { sign } from "../servers/sharing/identity.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── identities ───────────────────────────────────────────────────────────────
// One shared ed25519 identity: instance-sync verifies every entry against
// `this.identity.ed25519Pubkey`, and a user's instances share one identity.
const TEST_PRIV = Buffer.alloc(32, 0x2b);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

const A_ID = "inst-aaaa-0000-0000-0000-00000000000a";
const B_ID = "inst-bbbb-0000-0000-0000-00000000000b";
const SECP = "a".repeat(64);

// ── two real instances ───────────────────────────────────────────────────────
function initInstance(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-grp-tomb-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    // CROW_DB_PATH outranks CROW_DATA_DIR in init-db (init-db.js:11) — blank it, or a
    // shell exporting it (grackle's .env did, PR #180) would run the gen-8 migration
    // against the REAL DB, outside the deploy rail's backups.
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "", CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  return { dir, path: join(dir, "crow.db") };
}
const A_FILES = initInstance("a");
const B_FILES = initInstance("b");
after(() => {
  __setEmitSinkForTest(null);
  rmSync(A_FILES.dir, { recursive: true, force: true });
  rmSync(B_FILES.dir, { recursive: true, force: true });
});

/**
 * The shared feed. `wire` holds EVERY entry either instance appended. deliver()
 * drains in append order (T1's "A→B then B→A" when the delete was emitted first);
 * applyItem() lets T2 drain in the REVERSED order explicitly.
 */
function newFleet() {
  const wire = [];
  const A = { id: A_ID, db: createDbClient(A_FILES.path) };
  const B = { id: B_ID, db: createDbClient(B_FILES.path) };
  const attach = (inst) => {
    inst.mgr = new InstanceSyncManager(IDENTITY, inst.db, inst.id);
    inst.mgr.feedsDisabled = false;
    inst.mgr.outFeeds = new Map([["peer", {
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
  /** Mark everything currently on the wire as delivered WITHOUT applying (T2 uses applyItem manually). */
  const skimWire = () => { const items = wire.slice(cursor); cursor = wire.length; return items; };
  /** Restart an instance: brand-new db handle + manager over the SAME file. */
  const restart = async (inst) => {
    inst.db = createDbClient(inst.id === A_ID ? A_FILES.path : B_FILES.path);
    attach(inst);
  };
  return { A, B, wire, deliver, applyItem, skimWire, restart, other };
}

/** Run `fn` with `inst` as the GROUP emit sink — an emit belongs to exactly one instance. */
async function act(inst, fn) {
  __setEmitSinkForTest(inst.mgr);
  try { return await fn(); } finally { __setEmitSinkForTest(null); }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const groupRow = async (inst, uid) => (await inst.db.execute({
  sql: "SELECT * FROM contact_groups WHERE group_uid = ?", args: [uid],
})).rows[0] || null;

const conflicts = async (inst) =>
  Number((await inst.db.execute("SELECT COUNT(*) c FROM sync_conflicts")).rows[0].c);

const conflictRows = async (inst) => (await inst.db.execute(
  "SELECT * FROM sync_conflicts ORDER BY id",
)).rows;

const tomb = (inst, uid) => readGroupTombstone(inst.db, uid);

const members = async (inst, uid) => {
  const { rows } = await inst.db.execute({
    sql: `SELECT c.crow_id FROM contact_group_members gm
            JOIN contacts c ON c.id = gm.contact_id
            JOIN contact_groups g ON g.id = gm.group_id
           WHERE g.group_uid = ? ORDER BY c.crow_id`, args: [uid],
  });
  return rows.map((r) => r.crow_id);
};

const setCounter = async (inst, n) => {
  await inst.mgr._ensureCounter();
  await inst.db.execute({ sql: "UPDATE sync_state SET local_counter = ? WHERE instance_id = ?", args: [n, inst.id] });
};

/** Seed the same syncable contact on an instance (members resolve by crow_id). */
async function seedContact(inst, id, crowId) {
  await inst.db.execute({
    sql: "INSERT INTO contacts (id, crow_id, ed25519_pubkey, secp256k1_pubkey) VALUES (?, ?, '', ?)",
    args: [id, crowId, SECP],
  });
}

/**
 * Create a plain group locally (trigger assigns the random group_uid) and emit
 * it through the REAL group-sync path. Asserts the emit reached the wire
 * (harness trap: a null sink would pass every downstream assertion vacuously).
 */
async function createGroupAndEmit(fleet, inst, name) {
  const wireBefore = fleet.wire.length;
  await inst.db.execute({ sql: "INSERT INTO contact_groups (name) VALUES (?)", args: [name] });
  const { rows } = await inst.db.execute({
    sql: "SELECT id, group_uid FROM contact_groups WHERE name = ? ORDER BY id DESC LIMIT 1", args: [name],
  });
  const { id, group_uid: uid } = rows[0];
  assert.ok(uid, "trigger assigned a group_uid");
  await act(inst, () => emitGroupUpsert(inst.db, id));
  assert.ok(fleet.wire.length > wireBefore, "group upsert reached the wire (GROUP sink wired)");
  return { id, uid };
}

/** Rename + re-emit through the real path. Returns the emitted entry's lamport. */
async function renameAndEmit(fleet, inst, uid, newName) {
  const wireBefore = fleet.wire.length;
  await inst.db.execute({ sql: "UPDATE contact_groups SET name = ? WHERE group_uid = ?", args: [newName, uid] });
  const { rows } = await inst.db.execute({ sql: "SELECT id FROM contact_groups WHERE group_uid = ?", args: [uid] });
  await act(inst, () => emitGroupUpsert(inst.db, rows[0].id));
  assert.ok(fleet.wire.length > wireBefore, "rename reached the wire (GROUP sink wired)");
  return Number(fleet.wire.at(-1).entry.lamport_ts);
}

/**
 * W1 simulation (Task 3 ships the real delete_group handler): tombstone + local
 * DELETE in ONE db.batch, then emitGroupDelete through the real group-sync path.
 * Returns the delete entry's wire lamport.
 */
async function deleteGroupLocalW1(fleet, inst, uid) {
  const wireBefore = fleet.wire.length;
  await inst.db.batch([
    groupTombstoneStatement(uid, 0),
    { sql: "DELETE FROM contact_groups WHERE group_uid = ? AND room_uid IS NULL", args: [uid] },
  ]);
  await act(inst, () => emitGroupDelete(uid));
  assert.ok(fleet.wire.length > wireBefore, "delete reached the wire (GROUP sink wired)");
  return Number(fleet.wire.at(-1).entry.lamport_ts);
}

/** Forge a signed sync entry (T5/T8 drive _applyEntry directly, like groups-sync.test.js). */
function signedEntry(table, op, row, lamport_ts, instance_id) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}

beforeEach(async () => {
  const dbs = [createDbClient(A_FILES.path), createDbClient(B_FILES.path)];
  for (const db of dbs) {
    await db.execute("DELETE FROM room_messages");
    await db.execute("DELETE FROM contact_group_members");
    await db.execute("DELETE FROM contact_groups");
    await db.execute("DELETE FROM group_tombstones");
    await db.execute("DELETE FROM contacts");
    await db.execute("DELETE FROM sync_conflicts");
    await db.execute("DELETE FROM notifications");
    db.close();
  }
  __setEmitSinkForTest(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// T1 — S1 resurrection, THE defect (design §1.1). Drain A→B then B→A.
// RED-ON-UNMODIFIED-CODE REQUIRED: fails by resurrecting G on A.
// ─────────────────────────────────────────────────────────────────────────────

test("T1: A deletes G; offline B renames at a HIGHER lamport; drain A→B then B→A — both converge to deleted+tombstoned, exactly one delete-won conflict row", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };

  const g = await createGroupAndEmit(f, f.A, "Family");
  await f.deliver();
  assert.ok(await groupRow(f.B, g.uid), "setup: B holds the synced group");

  // A deletes (delete emitted at lamport d); B — offline, counter already ahead —
  // renames at r > d (explicit interleave per the spec's harness note).
  const d = await deleteGroupLocalW1(f, f.A, g.uid);
  await setCounter(f.B, d + 10);
  const r = await renameAndEmit(f, f.B, g.uid, "Renamed");
  assert.ok(r > d, `setup: rename lamport ${r} exceeds delete lamport ${d}`);

  // Wire order is delete-then-rename, so deliver() IS "A→B then B→A".
  await f.deliver();

  assert.equal(await groupRow(f.A, g.uid), null, "A: group NOT resurrected by B's rename");
  assert.equal(await groupRow(f.B, g.uid), null, "B: group deleted despite its newer rename (strict delete-wins)");
  assert.ok(await tomb(f.A, g.uid), "A: standing tombstone");
  assert.ok(await tomb(f.B, g.uid), "B: standing tombstone");

  // Conflict rows: exactly ONE, on B, labeled truthfully (R2 F6): the delete WON,
  // B's discarded rename is the LOSER — the only surviving record of the S2 trade-off.
  assert.equal(await conflicts(f.A), c0.a, "A: no conflict rows (silent drop of the stale upsert)");
  assert.equal(await conflicts(f.B), c0.b + 1, "B: exactly one delete-won conflict row");
  const cr = (await conflictRows(f.B)).at(-1);
  assert.equal(cr.table_name, "contact_groups");
  assert.equal(cr.op, "delete");
  assert.equal(cr.winning_instance_id, A_ID, "winner = the deleting instance");
  assert.equal(cr.losing_instance_id, B_ID, "loser = the local editor");
  assert.equal(Number(cr.winning_lamport_ts), d, "winning lamport = the delete's");
  assert.equal(Number(cr.losing_lamport_ts), r, "losing lamport = the discarded rename's");
  assert.equal(JSON.parse(cr.losing_data).name, "Renamed", "losing_data = the discarded LOCAL row");
  const winData = JSON.parse(cr.winning_data);
  assert.equal(winData.group_uid, g.uid, "winning_data = the wire delete row");
  assert.equal(winData.name, undefined, "winning_data carries no name (it IS the delete, not the rename)");
});

// ─────────────────────────────────────────────────────────────────────────────
// T1b — W2's UNCONDITIONAL tombstone: a delete for a uid this instance NEVER
// held must still stand a tombstone (protects against update-after-delete
// arrival reordering and pre-arms third instances holding stale copies).
// Kills the `if (!localRow) return;` mutation, which every other test survives
// (their receive-side tombstones all form with a local row present).
// ─────────────────────────────────────────────────────────────────────────────

test("T1b: op=delete for a uid B NEVER held stands a tombstone with zero conflict rows; a later higher-lamport upsert is dropped", async () => {
  const f = newFleet();
  const uid = "t1b-" + "0".repeat(28);
  const c0 = await conflicts(f.B);

  assert.equal(await groupRow(f.B, uid), null, "setup: B never held the uid");
  await f.B.mgr._applyEntry(A_ID, signedEntry("contact_groups", "delete", { group_uid: uid }, 40, A_ID));

  assert.ok(await tomb(f.B, uid), "tombstone standing despite NO local row (W2 unconditional)");
  assert.equal(await groupRow(f.B, uid), null, "still no row");
  assert.equal(await conflicts(f.B), c0, "zero conflict rows from a no-row delete");

  // The reordered/stale upsert the unconditional tombstone exists to stop.
  await f.B.mgr._applyEntry(A_ID, signedEntry("contact_groups", "update",
    { group_uid: uid, name: "Zombie", members: [] }, 99, A_ID));
  assert.equal(await groupRow(f.B, uid), null, "higher-lamport upsert dropped");
  assert.ok(await tomb(f.B, uid), "tombstone intact");
  assert.equal(await conflicts(f.B), c0, "still zero conflict rows (silent drop)");
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — S1 with the drain order REVERSED: B→A first, then A→B.
// RED-ON-UNMODIFIED-CODE REQUIRED: fails by resurrecting G on A.
// ─────────────────────────────────────────────────────────────────────────────

test("T2: same as T1 but drained B→A first, then A→B — same converged end state", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };

  const g = await createGroupAndEmit(f, f.A, "Chess Club");
  await f.deliver();
  assert.ok(await groupRow(f.B, g.uid), "setup: B holds the synced group");

  const d = await deleteGroupLocalW1(f, f.A, g.uid);
  await setCounter(f.B, d + 10);
  const r = await renameAndEmit(f, f.B, g.uid, "Renamed");
  assert.ok(r > d, "setup: rename lamport exceeds delete lamport");

  // Reversed drain: B's rename → A first, then A's delete → B.
  const pending = f.skimWire();
  const deleteItem = pending.find((i) => i.entry.op === "delete");
  const renameItem = pending.find((i) => i.from === B_ID && i.entry.op !== "delete");
  assert.ok(deleteItem && renameItem, "setup: both entries captured on the wire");
  await f.applyItem(f.A, renameItem); // B→A first
  await f.applyItem(f.B, deleteItem); // then A→B

  assert.equal(await groupRow(f.A, g.uid), null, "A: rename-first drain did NOT resurrect the group");
  assert.equal(await groupRow(f.B, g.uid), null, "B: delete applied despite newer local rename");
  assert.ok(await tomb(f.A, g.uid), "A: standing tombstone");
  assert.ok(await tomb(f.B, g.uid), "B: standing tombstone");

  assert.equal(await conflicts(f.A), c0.a, "A: zero conflict growth");
  assert.equal(await conflicts(f.B), c0.b + 1, "B: exactly one delete-won conflict row");
  const cr = (await conflictRows(f.B)).at(-1);
  assert.equal(cr.op, "delete");
  assert.equal(cr.winning_instance_id, A_ID, "winner = the deleting instance");
  assert.equal(JSON.parse(cr.losing_data).name, "Renamed", "losing_data = the discarded local row");
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — mutual delete: converged, both tombstoned, ZERO conflict growth.
// ─────────────────────────────────────────────────────────────────────────────

test("T3: A and B delete G concurrently; drain both — converged, both tombstoned, zero sync_conflicts growth", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };

  const g = await createGroupAndEmit(f, f.A, "Doomed Twice");
  await f.deliver();
  assert.ok(await groupRow(f.B, g.uid), "setup: B holds the synced group");

  await deleteGroupLocalW1(f, f.A, g.uid);
  await deleteGroupLocalW1(f, f.B, g.uid);
  await f.deliver();

  assert.equal(await groupRow(f.A, g.uid), null, "A: deleted");
  assert.equal(await groupRow(f.B, g.uid), null, "B: deleted");
  assert.ok(await tomb(f.A, g.uid), "A: standing tombstone");
  assert.ok(await tomb(f.B, g.uid), "B: standing tombstone");
  assert.equal(await conflicts(f.A), c0.a, "A: zero conflict growth");
  assert.equal(await conflicts(f.B), c0.b, "B: zero conflict growth");
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — negative control: live groups still sync normally; a NEW same-named group
// after a delete syncs under its fresh uid.
// ─────────────────────────────────────────────────────────────────────────────

test("T4: live-group rename + membership still sync end-to-end; a re-created same-named group (fresh uid) syncs; zero conflict growth", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };
  await seedContact(f.A, 501, "crow:mem1");
  await seedContact(f.B, 501, "crow:mem1");

  // Create on A → syncs to B.
  const g = await createGroupAndEmit(f, f.A, "Family");
  await f.deliver();
  assert.ok(await groupRow(f.B, g.uid), "create synced A→B");

  // Membership add on A → syncs to B.
  await f.A.db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, 501)", args: [g.id] });
  await act(f.A, () => emitGroupUpsert(f.A.db, g.id));
  await f.deliver();
  assert.deepEqual(await members(f.B, g.uid), ["crow:mem1"], "membership synced A→B");

  // Rename on B → syncs back to A.
  await renameAndEmit(f, f.B, g.uid, "Familia");
  await f.deliver();
  assert.equal((await groupRow(f.A, g.uid)).name, "Familia", "rename synced B→A");

  // Delete, then re-create the SAME NAME on A: the fresh trigger-random uid is not
  // tombstoned, so the new group syncs while the old uid stays dead.
  await deleteGroupLocalW1(f, f.A, g.uid);
  await f.deliver();
  assert.equal(await groupRow(f.B, g.uid), null, "old uid deleted on B");

  const g2 = await createGroupAndEmit(f, f.A, "Familia");
  assert.notEqual(g2.uid, g.uid, "re-created group has a FRESH uid");
  await f.deliver();
  assert.ok(await groupRow(f.B, g2.uid), "re-created group synced under its fresh uid");
  assert.equal(await groupRow(f.B, g.uid), null, "old uid still dead on B");
  assert.ok(await tomb(f.B, g.uid), "old uid still tombstoned on B");

  assert.equal(await conflicts(f.A), c0.a, "A: zero conflict growth");
  assert.equal(await conflicts(f.B), c0.b, "B: zero conflict growth");
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — restart durability. RED-ON-UNMODIFIED-CODE REQUIRED: fails by accepting
// the stale upsert after B's restart.
// ─────────────────────────────────────────────────────────────────────────────

test("T5: after a restart of B (fresh manager, same DB) a stale upsert for the tombstoned uid is still dropped", async () => {
  const f = newFleet();

  const g = await createGroupAndEmit(f, f.A, "Book Club");
  await f.deliver();
  const d = await deleteGroupLocalW1(f, f.A, g.uid);
  await f.deliver();
  assert.equal(await groupRow(f.B, g.uid), null, "setup: delete applied on B");

  // Restart B: brand-new db handle + manager over the same files.
  await f.restart(f.B);
  assert.ok(await tomb(f.B, g.uid), "setup: tombstone survived the restart");
  const c0 = await conflicts(f.B);

  // A stale peer's upsert for the dead uid, at a lamport ABOVE the delete's
  // (the mutual-case shape — under strict delete-wins ANY lamport must drop).
  await f.B.mgr._applyEntry(A_ID, signedEntry("contact_groups", "update",
    { group_uid: g.uid, name: "Zombie", members: [] }, d + 5, A_ID));

  assert.equal(await groupRow(f.B, g.uid), null, "B: stale upsert dropped after restart");
  assert.ok(await tomb(f.B, g.uid), "B: tombstone intact");
  assert.equal(await conflicts(f.B), c0, "B: zero conflict growth (silent drop)");
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — G1 statement-guard unit tests (design R1 F1): the guarded INSERT/UPDATE
// are no-ops against a pre-seeded tombstone, and the rowsAffected reconcile gate
// is proven on the UPDATE branch (R2 F5: on the INSERT branch the gate mutation
// is INVISIBLE — null gid early-returns the reconcile — so the load-bearing
// check seeds the ZOMBIE state, tombstone + live row, where localRow.id is real).
// ─────────────────────────────────────────────────────────────────────────────

test("T8a: guarded INSERT is a no-op against a pre-seeded tombstone — no row, no member rows, no conflict rows", async () => {
  const f = newFleet();
  const uid = "t8a-" + "0".repeat(28);
  await seedContact(f.A, 601, "crow:t8a");
  await f.A.db.execute(groupTombstoneStatement(uid, 3));
  const c0 = await conflicts(f.A);

  // Drive the REAL apply path (op=update, no local row → insert branch).
  await f.A.mgr._applyEntry(B_ID, signedEntry("contact_groups", "update",
    { group_uid: uid, name: "Zombie", members: ["crow:t8a"] }, 999, B_ID));

  assert.equal(await groupRow(f.A, uid), null, "guarded INSERT dropped the tombstoned uid");
  const gm = (await f.A.db.execute("SELECT COUNT(*) c FROM contact_group_members")).rows[0].c;
  assert.equal(Number(gm), 0, "reconcile did not run (no member rows)");
  assert.ok(await tomb(f.A, uid), "tombstone intact");
  assert.equal(await conflicts(f.A), c0, "zero conflict growth");
});

test("T8b: guarded UPDATE is a no-op against the zombie state (tombstone + live row) — metadata unchanged AND membership untouched (reconcile gated on rowsAffected)", async () => {
  const f = newFleet();
  await seedContact(f.A, 602, "crow:t8b");

  // Manufacture the zombie: a live row whose uid is tombstoned (direct DB writes —
  // reachable in prod only via a race/manual edit; G1 must still hold).
  await f.A.db.execute({ sql: "INSERT INTO contact_groups (id, name, lamport_ts) VALUES (700, 'Zombie', 5)", args: [] });
  const uid = (await f.A.db.execute("SELECT group_uid FROM contact_groups WHERE id = 700")).rows[0].group_uid;
  await f.A.db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (700, 602)", args: [] });
  await f.A.db.execute(groupTombstoneStatement(uid, 6));
  const c0 = await conflicts(f.A);

  // A HIGHER-lamport update with an explicit members wire-array that would wipe
  // the membership if the reconcile ran against localRow.id (real, non-null).
  await f.A.mgr._applyEntry(B_ID, signedEntry("contact_groups", "update",
    { group_uid: uid, name: "Hacked", members: [] }, 50, B_ID));

  const row = await groupRow(f.A, uid);
  assert.ok(row, "zombie row still present (this test does not assert healing)");
  assert.equal(row.name, "Zombie", "guarded UPDATE did not touch metadata");
  assert.equal(Number(row.lamport_ts), 5, "lamport not stamped by the dropped update");
  assert.deepEqual(await members(f.A, uid), ["crow:t8b"],
    "membership UNTOUCHED — reconcile must be gated on rowsAffected > 0 (R2 F5)");
  assert.ok(await tomb(f.A, uid), "tombstone intact");
  assert.equal(await conflicts(f.A), c0, "zero conflict growth");
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — W1 atomicity through the REAL delete_group handler (design §3.3 W1):
// handleContactAction with a fake req, the pattern the existing panel tests use.
// ─────────────────────────────────────────────────────────────────────────────

test("T7: delete_group on a plain group — row gone AND tombstone standing (row's own lamport) in one call, exactly one delete emitted", async () => {
  const f = newFleet();
  const g = await createGroupAndEmit(f, f.A, "Handler Target");
  // Give the row a real lamport so the tombstone's observability field is provable.
  await f.A.db.execute({ sql: "UPDATE contact_groups SET lamport_ts = 42 WHERE id = ?", args: [g.id] });

  const wireBefore = f.wire.length;
  const res = await act(f.A, () => handleContactAction(
    { body: { action: "delete_group", group_id: String(g.id) } }, f.A.db, { managers: {} }));
  assert.equal(res.redirect, "/dashboard/contacts?view=groups");

  assert.equal(await groupRow(f.A, g.uid), null, "row gone");
  const t = await tomb(f.A, g.uid);
  assert.ok(t, "tombstone standing");
  assert.equal(Number(t.lamport_ts), 42, "tombstone carries the row's own lamport (observability only, spec §3.2)");

  const emitted = f.wire.slice(wireBefore);
  assert.equal(emitted.length, 1, "exactly one emit from the handler");
  assert.equal(emitted[0].entry.op, "delete");
  assert.equal(emitted[0].entry.row.group_uid, g.uid, "the delete carries the group_uid");
});

test("T7 (injected failure): when the batch's tombstone statement fails, NEITHER the DELETE nor the tombstone lands, and nothing is emitted", async () => {
  const f = newFleet();
  const g = await createGroupAndEmit(f, f.A, "Survivor");

  // Pass-through wrapper over the REAL db: the batch runs for real, but the
  // tombstone statement is swapped for one that violates deleted_at NOT NULL —
  // so the batch's OTHER statement (the DELETE) executes inside the transaction
  // and must roll back with it. This proves batch-atomicity through the real
  // handler: two sequential db.execute calls would leave the DELETE committed.
  const failingDb = {
    execute: (arg) => f.A.db.execute(arg),
    batch: (stmts) => f.A.db.batch(stmts.map((s) =>
      typeof s !== "string" && /group_tombstones/i.test(s.sql)
        ? { sql: "INSERT INTO group_tombstones (group_uid, lamport_ts, deleted_at) VALUES (?, 0, NULL)", args: [g.uid] }
        : s)),
  };

  const wireBefore = f.wire.length;
  await assert.rejects(
    act(f.A, () => handleContactAction(
      { body: { action: "delete_group", group_id: String(g.id) } }, failingDb, { managers: {} })),
    /NOT NULL/i,
    "the failed batch propagates (handler does not swallow it)",
  );

  assert.ok(await groupRow(f.A, g.uid), "DELETE rolled back — row still present");
  assert.equal(await tomb(f.A, g.uid), null, "no tombstone landed");
  assert.equal(f.wire.length, wireBefore, "nothing emitted after the failed batch");
});

// ─────────────────────────────────────────────────────────────────────────────
// T10 — room-id routing (design R2 F2') + the Groups-list filter: delete_group
// on a ROOM must route to deleteRoom (full teardown), never tombstone, never
// emit; and getGroups must stop returning rooms (they have their own UI).
// ─────────────────────────────────────────────────────────────────────────────

test("T10: delete_group on a ROOM routes to deleteRoom — room+members+room_messages gone, NO tombstone, NOTHING emitted; getGroups excludes rooms", async () => {
  const f = newFleet();
  await seedContact(f.A, 801, "crow:roomie");

  // A room row, shaped the way rooms-store.createRoom writes it
  // (room_uid + host_crow_id + mode), with a member and a room message.
  await f.A.db.execute({
    sql: "INSERT INTO contact_groups (name, room_uid, host_crow_id, mode) VALUES ('War Room', ?, 'crow:host', 'addressed')",
    args: ["f".repeat(32)],
  });
  const room = (await f.A.db.execute(
    "SELECT id, group_uid, room_uid FROM contact_groups WHERE room_uid IS NOT NULL")).rows[0];
  assert.ok(room.group_uid, "trigger stamped the room row with a group_uid too");
  await f.A.db.execute({ sql: "INSERT INTO contact_group_members (group_id, contact_id) VALUES (?, 801)", args: [room.id] });
  await f.A.db.execute({
    sql: "INSERT INTO room_messages (group_id, msg_uid, content, direction) VALUES (?, 'm1', 'hi', 'received')",
    args: [room.id],
  });

  // A plain group beside it — getGroups must keep returning plain groups.
  const plain = await createGroupAndEmit(f, f.A, "Plain Group");
  const listed = await getGroups(f.A.db);
  assert.ok(listed.some((r) => Number(r.id) === Number(plain.id)), "getGroups returns the plain group");
  assert.ok(!listed.some((r) => Number(r.id) === Number(room.id)), "getGroups does NOT return rooms (WHERE room_uid IS NULL)");

  const wireBefore = f.wire.length;
  const res = await act(f.A, () => handleContactAction(
    { body: { action: "delete_group", group_id: String(room.id) } }, f.A.db, { managers: {} }));
  assert.equal(res.redirect, "/dashboard/contacts?view=groups");

  // deleteRoom teardown: row + members + room_messages all gone.
  const count = async (sql, args) => Number((await f.A.db.execute({ sql, args })).rows[0].c);
  assert.equal(await count("SELECT COUNT(*) c FROM contact_groups WHERE id = ?", [room.id]), 0, "room row gone");
  assert.equal(await count("SELECT COUNT(*) c FROM contact_group_members WHERE group_id = ?", [room.id]), 0, "room members gone");
  assert.equal(await count("SELECT COUNT(*) c FROM room_messages WHERE group_id = ?", [room.id]), 0, "room messages gone");

  // Rooms are never synced (their own Nostr fan-out): no tombstone under EITHER
  // of the row's uids, and the group sink captured zero entries for the delete.
  assert.equal(await tomb(f.A, room.group_uid), null, "no tombstone for the room's group_uid");
  assert.equal(await tomb(f.A, room.room_uid), null, "no tombstone for the room_uid");
  assert.equal(f.wire.length, wireBefore, "NOTHING emitted for a room delete");

  // The plain group beside it is untouched.
  assert.ok(await groupRow(f.A, plain.uid), "the plain group survives");
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — W3 (design §3.4): a NULL-uid legacy row whose DETERMINISTIC uid is
// tombstoned means the logical group was deleted fleet-wide while this instance
// was offline (or pre-C1) — the assignment pass must DELETE it, not regenerate
// the dead uid. ⚠️ Seeding trap (design §5): the contact_groups_group_uid_ai
// trigger makes a NULL-uid INSERT impossible — seed with INSERT then
// UPDATE ... SET group_uid = NULL.
// ─────────────────────────────────────────────────────────────────────────────

test("T6: W3 — a legacy NULL-uid row whose deterministic uid is tombstoned is DELETED at assignment time (nothing emitted, tombstone stands); a non-tombstoned sibling is assigned normally", async () => {
  const f = newFleet();

  // Two legacy rows on B (INSERT then NULL the trigger-assigned uid — spec §5 trap).
  await f.B.db.execute({ sql: "INSERT INTO contact_groups (name) VALUES ('Dead Legacy')", args: [] });
  await f.B.db.execute({ sql: "INSERT INTO contact_groups (name) VALUES ('Live Legacy')", args: [] });
  await f.B.db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name IN ('Dead Legacy','Live Legacy')");
  const nulls = Number((await f.B.db.execute(
    "SELECT COUNT(*) c FROM contact_groups WHERE group_uid IS NULL")).rows[0].c);
  assert.equal(nulls, 2, "setup: both legacy rows are NULL-uid");

  // Tombstone the DETERMINISTIC uid of one — via the SAME derivation the code uses.
  const deadUid = f.B.mgr.deterministicGroupUid("Dead Legacy");
  const liveUid = f.B.mgr.deterministicGroupUid("Live Legacy");
  await f.B.db.execute(groupTombstoneStatement(deadUid, 7));

  const wireBefore = f.wire.length;
  await f.B.mgr._assignDeterministicGroupUids();

  // The tombstoned legacy row is GONE — deleted, not assigned.
  const dead = (await f.B.db.execute({
    sql: "SELECT * FROM contact_groups WHERE name = 'Dead Legacy'", args: [] })).rows;
  assert.equal(dead.length, 0, "W3 deleted the tombstoned legacy row");
  assert.equal(await groupRow(f.B, deadUid), null, "no row holds the tombstoned uid");
  assert.ok(await tomb(f.B, deadUid), "the tombstone still stands");

  // NEGATIVE CONTROL: the non-tombstoned sibling got its uid assigned normally.
  const live = await groupRow(f.B, liveUid);
  assert.ok(live, "negative control: non-tombstoned legacy row assigned its deterministic uid");
  assert.equal(live.name, "Live Legacy");

  assert.equal(f.wire.length, wireBefore, "nothing emitted for the W3 local delete (wire unchanged)");
});

// ─────────────────────────────────────────────────────────────────────────────
// T6b — fail-open (design §3.4 / G2 rationale): a group_tombstones read failure
// (e.g. missing table on an un-migrated DB) means "not tombstoned" — it must
// NEVER kill uid assignment for every group; and W4's re-emit must no-op
// without throwing. Mutation check (c): letting the read error propagate out
// of the W3 check reds this test.
// ─────────────────────────────────────────────────────────────────────────────

test("T6b: W3/W4 fail-open — group_tombstones reads that THROW do not kill uid assignment, and reemitGroupTombstones no-ops without throwing", async () => {
  const f = newFleet();
  await f.B.db.execute({ sql: "INSERT INTO contact_groups (name) VALUES ('Fail Open')", args: [] });
  await f.B.db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name = 'Fail Open'");

  // Pass-through wrapper over the REAL db: any statement touching
  // group_tombstones throws (the un-migrated-DB shape).
  const realDb = f.B.db;
  const throwingDb = {
    execute: (arg) => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      if (/group_tombstones/i.test(sql)) throw new Error("boom: group_tombstones unavailable");
      return realDb.execute(arg);
    },
    batch: (stmts) => realDb.batch(stmts),
  };
  f.B.mgr.db = throwingDb;
  try {
    const n = await f.B.mgr._assignDeterministicGroupUids();
    assert.equal(n, 1, "uid assignment proceeded despite throwing tombstone reads (fail-open)");
    const reemitted = await f.B.mgr.reemitGroupTombstones();
    assert.equal(reemitted, 0, "W4 re-emit no-ops (guarded) when the table read throws");
  } finally {
    f.B.mgr.db = realDb;
  }

  const uid = f.B.mgr.deterministicGroupUid("Fail Open");
  assert.ok(await groupRow(f.B, uid), "the legacy row holds its deterministic uid");
});

// ─────────────────────────────────────────────────────────────────────────────
// T9 — W4 (design §3.7): FLAGLESS every-boot tombstone re-emit. Sync feeds are
// born EMPTY at pairing, so a peer that pairs AFTER the delete never hears it —
// B below stands in for that peer: it never received the delete entry (skimmed
// off the wire) and holds a stale live copy of the group. A's boot re-emit must
// converge it; a second re-emit (next boot) must change nothing.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// G2 (design §3.3): emit gate. Belt-and-braces for the anomalous
// live-row-beside-tombstone state (§3.6) — G1 on receivers is the load-bearing
// mechanism; G2 stops this instance from even emitting for a dead uid.
// ─────────────────────────────────────────────────────────────────────────────

test("G2: emitGroupUpsert on a live-row-beside-tombstone zombie emits NOTHING; a non-tombstoned row still emits (negative control)", async () => {
  const f = newFleet();

  // Manufacture the anomalous state directly (design §3.6: reachable in prod
  // only via a race/manual edit): a live plain group whose uid is tombstoned.
  await f.A.db.execute({ sql: "INSERT INTO contact_groups (id, name) VALUES (901, 'Zombie Emitter')", args: [] });
  const uid = (await f.A.db.execute(
    "SELECT group_uid FROM contact_groups WHERE id = 901")).rows[0].group_uid;
  assert.ok(uid, "trigger assigned a group_uid");
  await f.A.db.execute(groupTombstoneStatement(uid, 4));

  const wireBefore = f.wire.length;
  await act(f.A, () => emitGroupUpsert(f.A.db, 901));
  assert.equal(f.wire.length, wireBefore, "G2 muted the tombstoned row's emit (wire unchanged)");

  // NEGATIVE CONTROL: a non-tombstoned group emits through the SAME sink —
  // proves the muted emit above was G2, not a dead sink (anti-vacuous).
  await f.A.db.execute({ sql: "INSERT INTO contact_groups (id, name) VALUES (902, 'Live Emitter')", args: [] });
  await act(f.A, () => emitGroupUpsert(f.A.db, 902));
  assert.equal(f.wire.length, wireBefore + 1, "negative control: non-tombstoned row emitted (wire +1)");
  assert.equal(f.wire.at(-1).entry.row.name, "Live Emitter", "the emitted entry is the live group's");
});

// ─────────────────────────────────────────────────────────────────────────────
// T11 — G3 (design R2 F3'): the sync-conflicts RESTORE button must not
// re-INSERT a tombstoned uid. The conflict row is seeded in the EXACT shape
// _insertConflictRow writes on the local-wins path (op="update": row_id = JSON
// {group_uid}, losing_data = the filtered wire row — the shape T1 asserts).
// Driven the way the settings UI does (sync-conflicts.js handleAction →
// restoreConflict): the first call trips the stale-snapshot guard (the
// winning_data snapshot vs. the now-gone row) and re-snapshots — the UI's
// confirm-again flow; the SECOND call reaches the INSERT branch G3 guards.
// ─────────────────────────────────────────────────────────────────────────────

/** Seed a contact_groups op="update" conflict + drive restore twice (stale → outcome). */
async function seedConflictAndRestore(inst, uid, tombstoned) {
  const losing = { group_uid: uid, name: "Restored Zombie" };
  const winning = { id: 950, group_uid: uid, name: "Local Winner", lamport_ts: 9 };
  await inst.mgr._insertConflictRow("contact_groups", JSON.stringify({ group_uid: uid }),
    A_ID, B_ID, 9, 12, JSON.stringify(winning), JSON.stringify(losing), "update");
  const conflictId = (await inst.db.execute(
    "SELECT id FROM sync_conflicts ORDER BY id DESC LIMIT 1")).rows[0].id;
  if (tombstoned) await inst.db.execute(groupTombstoneStatement(uid, 12));

  const first = await restoreConflict(inst.db, String(conflictId), { instanceSync: null });
  assert.equal(first.status, "stale", "first click re-snapshots (the UI's double-confirm flow)");
  const second = await restoreConflict(inst.db, String(conflictId), { instanceSync: null });
  return { conflictId, outcome: second };
}

test("T11: restoring a contact_groups conflict whose uid is TOMBSTONED is REFUSED — no row inserted, tombstone intact, conflict left unresolved", async () => {
  const f = newFleet();
  const uid = "t11-" + "0".repeat(28);

  const { conflictId, outcome } = await seedConflictAndRestore(f.A, uid, true);

  assert.equal(outcome.status, "refused", "G3 refuses the restore (not applied, not error)");
  assert.match(outcome.message || "", /deleted fleet-wide/i,
    "the refusal surfaces the reason instead of claiming success");
  assert.equal(await groupRow(f.A, uid), null, "NO contact_groups row was inserted");
  assert.ok(await tomb(f.A, uid), "tombstone intact");
  const c = (await f.A.db.execute({
    sql: "SELECT resolved FROM sync_conflicts WHERE id = ?", args: [conflictId] })).rows[0];
  assert.equal(Number(c.resolved), 0,
    "conflict left UNRESOLVED on refusal (the data stays visible, like the D7 refusal)");
});

test("T11 negative control: the SAME conflict WITHOUT a tombstone restores — row inserted, conflict resolved (proves the harness reaches the INSERT branch)", async () => {
  const f = newFleet();
  const uid = "t11-neg-" + "0".repeat(24);

  const { conflictId, outcome } = await seedConflictAndRestore(f.A, uid, false);

  assert.equal(outcome.status, "applied", "non-tombstoned restore succeeds");
  const row = await groupRow(f.A, uid);
  assert.ok(row, "the losing row was re-INSERTed");
  assert.equal(row.name, "Restored Zombie", "restored with the losing_data values");
  const c = (await f.A.db.execute({
    sql: "SELECT resolved FROM sync_conflicts WHERE id = ?", args: [conflictId] })).rows[0];
  assert.equal(Number(c.resolved), 1, "conflict marked resolved on success");
});

test("T9: W4 flagless boot re-emit — a peer that paired after the delete converges (stale copy gone, tombstoned, exactly one delete-won conflict row); a second re-emit is idempotent", async () => {
  const f = newFleet();

  // A: a REAL prior delete (group created + deleted through the W1 shape).
  const g = await createGroupAndEmit(f, f.A, "Ghost");
  const d = await deleteGroupLocalW1(f, f.A, g.uid);
  assert.ok(await tomb(f.A, g.uid), "setup: A holds the tombstone");
  // B "paired after the delete": it never receives the create/delete entries.
  f.skimWire();

  // B: fresh peer seeded with a stale live copy of the group (same uid, direct
  // INSERT then uid overwrite past the trigger) at a lamport ABOVE the delete's.
  await f.B.db.execute({ sql: "INSERT INTO contact_groups (name, lamport_ts) VALUES ('Ghost', ?)", args: [d + 5] });
  await f.B.db.execute({ sql: "UPDATE contact_groups SET group_uid = ? WHERE name = 'Ghost'", args: [g.uid] });
  assert.ok(await groupRow(f.B, g.uid), "setup: B holds the stale live copy");
  assert.equal(await tomb(f.B, g.uid), null, "setup: B never saw the delete (no tombstone)");
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };

  // A's boot re-emit (W4) → drain to B.
  const wireBefore = f.wire.length;
  const n1 = await f.A.mgr.reemitGroupTombstones();
  assert.equal(n1, 1, "one tombstone re-emitted");
  assert.ok(f.wire.length > wireBefore, "the re-emit reached the wire");
  assert.equal(f.wire.at(-1).entry.op, "delete", "re-emit is an op=delete");
  assert.equal(f.wire.at(-1).entry.row.group_uid, g.uid, "same wire shape as emitGroupDelete ({ group_uid })");
  await f.deliver();

  assert.equal(await groupRow(f.B, g.uid), null, "B: stale live copy deleted");
  assert.ok(await tomb(f.B, g.uid), "B: tombstone standing");
  assert.equal(await conflicts(f.B), c0.b + 1, "B: exactly one delete-won conflict row");
  const cr = (await conflictRows(f.B)).at(-1);
  assert.equal(cr.table_name, "contact_groups");
  assert.equal(cr.op, "delete");
  assert.equal(cr.winning_instance_id, A_ID, "winner = the (re-emitting) deleting instance");

  // Idempotence: a second boot's re-emit produces NO further state change.
  const n2 = await f.A.mgr.reemitGroupTombstones();
  assert.equal(n2, 1, "re-emits every boot — deliberately flagless");
  await f.deliver();
  assert.equal(await groupRow(f.B, g.uid), null, "B: still deleted");
  assert.ok(await tomb(f.B, g.uid), "B: tombstone intact");
  assert.equal(await conflicts(f.B), c0.b + 1, "B: NO conflict growth on the second re-emit");
  assert.equal(await conflicts(f.A), c0.a, "A: zero conflict growth throughout");
});
