// tests/advertised-prune-durability.test.js
//
// F4 durability + convergence (spec `2026-07-12-advertised-contact-prune-design.md`
// §5 tests 5, 6, 7, 9, 10). tests/roster-advertise-prune.test.js covers the trigger
// matrix on ONE instance; this file covers what happens BETWEEN two instances — the
// half where three previous designs died:
//
//   v1  broadcast a delete   ⇒ LWW asymmetry ⇒ divergence + sync_conflicts growth (test 9)
//   v2  bare local delete    ⇒ any later `update` re-INSERTs the row              (test 5)
//   v3  fresh-counter tomb   ⇒ a MUTUAL prune + re-add ties at the gate and is
//                              dropped FOREVER — and v3's test plan never once
//                              pruned on both sides, so every test passed         (test 6)
//
// HARNESS: two real instances (each its own mkdtemp CROW_DATA_DIR + real init-db +
// real InstanceSyncManager) joined by a fake out-feed that captures every entry
// emitChange() appends and hands it to the peer's _applyEntry(). Capturing the feed
// (rather than running hypercore) is what lets us assert the design's central claim
// NEGATIVELY: that the prune puts NOTHING on the wire.
//
// NEVER point this file at ~/.crow or ~/.crow-mpa — this code path DELETES contacts.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { acceptBotInvite } from "../servers/sharing/accept-bot-invite.js";
import { pruneStaleAdvertisedContacts } from "../servers/gateway/dashboard/panels/messages/data-queries.js";
import { emitContactChange, __setEmitSinkForTest } from "../servers/sharing/contact-sync.js";
import { readTombstone } from "../servers/sharing/contact-delete.js";
import { deriveBotIdentity, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";
import { normalizePubkey } from "../servers/sharing/pubkey-util.js";
import { handleIncomingRequest } from "../servers/sharing/boot.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── identities ───────────────────────────────────────────────────────────────
// One shared ed25519 identity: instance-sync verifies every entry against
// `this.identity.ed25519Pubkey`, and a user's instances share one identity.
const TEST_PRIV = Buffer.alloc(32, 0x5e);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

const A_ID = "inst-aaaa-0000-0000-0000-00000000000a";
const B_ID = "inst-bbbb-0000-0000-0000-00000000000b";
const ADV = "inst-advertiser-x"; // the peer whose directory the bot came from

/** The bot that gets un-advertised and pruned. */
const BOT = deriveBotIdentity(randomBytes(32), "prune-bot");
const BOT_CODE = generateBotInviteCode(BOT, "tok-prune", [], "Prune Bot");
const BOT_CROW_ID = parseBotInviteCode(BOT_CODE).botCrowId;
const BOT_X = String(BOT.secp256k1Pubkey).slice(-64).toLowerCase();

/** The negative control: a bot that stays advertised throughout. */
const KEEP = deriveBotIdentity(randomBytes(32), "keep-bot");
const KEEP_CODE = generateBotInviteCode(KEEP, "tok-keep", [], "Keep Bot");
const KEEP_CROW_ID = parseBotInviteCode(KEEP_CODE).botCrowId;
const KEEP_X = String(KEEP.secp256k1Pubkey).slice(-64).toLowerCase();

// ── two real instances ───────────────────────────────────────────────────────
function initInstance(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-prune-dur-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" },
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
 * The shared feed. `wire` holds EVERY entry either instance appended — the object
 * of assertion for "the prune broadcasts nothing" and "no delete on the wire".
 * Entries are JSON round-tripped, exactly as a real hypercore would deliver them.
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
  /** Replicate every un-delivered entry to the other side, in order. */
  const deliver = async () => {
    while (cursor < wire.length) {
      const { from, entry } = wire[cursor++];
      const dest = from === A.id ? B : A;
      await dest.mgr._applyEntry(from, entry);
    }
  };
  /** Restart an instance: brand-new db handle + manager over the SAME file. */
  const restart = async (inst) => {
    inst.db = createDbClient(inst.id === A_ID ? A_FILES.path : B_FILES.path);
    attach(inst);
  };
  return { A, B, wire, deliver, restart };
}

/** Run `fn` with `inst` as the emit sink — an emit belongs to exactly one instance. */
async function act(inst, fn) {
  __setEmitSinkForTest(inst.mgr);
  try { return await fn(); } finally { __setEmitSinkForTest(null); }
}

const row = async (inst, crowId) => (await inst.db.execute({
  sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [crowId],
})).rows[0] || null;

const conflicts = async (inst) => Number((await inst.db.execute("SELECT COUNT(*) c FROM sync_conflicts")).rows[0].c);

const counter = async (inst) => Number((await inst.db.execute({
  sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?", args: [inst.id],
})).rows[0]?.local_counter ?? 0);

const setCounter = async (inst, n) => {
  await inst.mgr._ensureCounter();
  await inst.db.execute({ sql: "UPDATE sync_state SET local_counter = ? WHERE instance_id = ?", args: [n, inst.id] });
};

/** perInstance as getBotDirectory builds it: ADV answered ok+complete with `live` keys. */
const directory = (...liveXOnlyKeys) => new Map([
  [ADV, { ok: true, complete: true, pubkeys: new Set(liveXOnlyKeys) }],
]);

/**
 * The prune, called exactly as getBotDirectory({prune:true}) calls it — and run
 * with `inst` INSTALLED AS THE LIVE EMIT SINK, as it is in production. This is
 * load-bearing, not decoration: emitContactChange/emitContactDelete resolve their
 * sink from the module-global (the real InstanceSyncManager at runtime). With a
 * null sink, a prune that DID broadcast a delete would emit into the void and the
 * wire assertions below would pass vacuously — v1's exact failure, invisible.
 */
const prune = (inst, perInstance) =>
  act(inst, () => pruneStaleAdvertisedContacts(inst.db, perInstance, inst.id, { syncManager: inst.mgr }));

/** A adds the bot from ADV's directory; B receives it by sync. Returns the shared lamport. */
async function addFromDirectoryAndSync(fleet, code, crowId) {
  await act(fleet.A, () => acceptBotInvite(fleet.A.db, {}, { inviteCode: code, advertisedByInstanceId: ADV }));
  await fleet.deliver();
  const a = await row(fleet.A, crowId);
  const b = await row(fleet.B, crowId);
  assert.ok(a && b, "setup: both instances hold the contact");
  assert.equal(Number(a.lamport_ts), Number(b.lamport_ts), "setup: both rows converged on one lamport");
  return Number(a.lamport_ts);
}

/** Every real resurrection vector is an `op="update"` (block, rename, accept, boot backfill). */
async function emitUpdate(inst, crowId, patch = {}) {
  const keys = Object.keys(patch);
  if (keys.length) {
    await inst.db.execute({
      sql: `UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE crow_id = ?`,
      args: [...keys.map((k) => patch[k]), crowId],
    });
  }
  const r = await row(inst, crowId);
  await act(inst, () => emitContactChange("update", r));
}

beforeEach(async () => {
  const dbs = [createDbClient(A_FILES.path), createDbClient(B_FILES.path)];
  for (const db of dbs) {
    await db.execute("DELETE FROM messages");
    await db.execute("DELETE FROM contacts");
    await db.execute("DELETE FROM contact_tombstones");
    await db.execute("DELETE FROM crow_instances");
    await db.execute("DELETE FROM notifications");
  }
  __setEmitSinkForTest(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 test 5 — THE HEADLINE (defect D3: resurrection)
// ─────────────────────────────────────────────────────────────────────────────

test("5. A prunes ⇒ tombstone at the row's OWN lamport_ts; B's later `update` does NOT resurrect it; a restart of A does not either", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };

  // Both instances hold the same advertised contact (A added it, B got it by sync),
  // plus a second one that stays advertised (the negative control).
  const lamport = await addFromDirectoryAndSync(f, BOT_CODE, BOT_CROW_ID);
  await addFromDirectoryAndSync(f, KEEP_CODE, KEEP_CROW_ID);
  const wireBeforePrune = f.wire.length;

  // ADV stops advertising the bot (KEEP is still in its list).
  await prune(f.A, directory(KEEP_X));

  assert.equal(await row(f.A, BOT_CROW_ID), null, "the pruned row is gone on A");
  const tomb = await readTombstone(f.A.db, BOT_CROW_ID);
  assert.ok(tomb, "the prune wrote a tombstone (a bare DELETE is resurrectable)");
  assert.equal(Number(tomb.lamport_ts), lamport,
    "the tombstone sits at the PRUNED ROW'S OWN lamport_ts — not a fresh counter value (spec §3 F4)");
  assert.equal(f.wire.length, wireBeforePrune, "the prune emitted NOTHING");

  // THE resurrection vector. block/unblock, profile edit, accept-request and the
  // boot backfill are ALL op="update" — B still holds the row and still emits.
  await emitUpdate(f.B, BOT_CROW_ID, { is_blocked: 1 });
  await f.deliver();
  assert.equal(await row(f.A, BOT_CROW_ID), null,
    "D3: a peer's `update` against a standing tombstone must NOT re-INSERT the contact");

  // Durability across a process restart — the whole point of a row, not memory.
  await f.restart(f.A);
  assert.ok(await readTombstone(f.A.db, BOT_CROW_ID), "the tombstone survived the restart");
  await emitUpdate(f.B, BOT_CROW_ID, { display_name: "Zombie" });
  await f.deliver();
  assert.equal(await row(f.A, BOT_CROW_ID), null, "still gone after a restart of A");

  // NEGATIVE CONTROL — ordinary contact sync is untouched by any of the above.
  await emitUpdate(f.B, KEEP_CROW_ID, { display_name: "Keep Bot Renamed" });
  await f.deliver();
  const keep = await row(f.A, KEEP_CROW_ID);
  assert.ok(keep, "the still-advertised contact was never pruned");
  assert.equal(keep.display_name, "Keep Bot Renamed", "and it still syncs normally");
  assert.equal(await readTombstone(f.A.db, KEEP_CROW_ID), null, "no tombstone for the live contact");

  // §5 test 9
  assert.equal(await conflicts(f.A), c0.a, "sync_conflicts unchanged on A");
  assert.equal(await conflicts(f.B), c0.b, "sync_conflicts unchanged on B");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 test 6 — THE LAMPORT-TIE REGRESSION (R3/CRITICAL-1)
//
// v3's plan never pruned on BOTH sides, so it could not see this. A MUTUAL prune is
// the NORMAL case: both instances are paired with ADV, both see the bot vanish from
// its directory, both reach the same conclusion. The prune emits nothing, so a
// counter burned by a tombstone is invisible to the fleet — and the re-adder's
// `insert` can then land at or below the peer's tombstone and be dropped FOREVER.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutual prune, then the LOWER-counter instance re-adds and emits `insert`.
 * The peer MUST apply it and clear its tombstone. `arrange` sets the counters.
 */
async function mutualPruneThenReAdd(arrange) {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };
  const lamport = await addFromDirectoryAndSync(f, BOT_CODE, BOT_CROW_ID);
  await arrange(f, lamport);

  // BOTH instances independently reach the same conclusion. This is the case v3
  // omitted, and the only one in which the tombstone lamports can disagree.
  await prune(f.A, directory());
  await prune(f.B, directory());
  assert.equal(await row(f.A, BOT_CROW_ID), null, "pruned on A");
  assert.equal(await row(f.B, BOT_CROW_ID), null, "pruned on B");

  // The re-adder must be the one with the LOWER counter — the losing side of the tie.
  const [reAdder, peer] = (await counter(f.A)) <= (await counter(f.B)) ? [f.A, f.B] : [f.B, f.A];

  // ADV re-advertises; the user adds the bot again on the lower-counter instance.
  await act(reAdder, () => acceptBotInvite(reAdder.db, {}, { inviteCode: BOT_CODE, advertisedByInstanceId: ADV }));
  await f.deliver();

  assert.ok(await row(reAdder, BOT_CROW_ID), "the re-add landed locally");
  assert.equal(await readTombstone(reAdder.db, BOT_CROW_ID), null, "the re-adder cleared its own tombstone");
  assert.ok(await row(peer, BOT_CROW_ID),
    "THE ASSERTION: the peer MUST apply the re-add. A tombstone written at a fresh counter " +
    "value ties with (or outruns) the re-adder's insert, the gate drops it, and the two " +
    "instances diverge PERMANENTLY — with no error, on both sides, forever.");
  assert.equal(await readTombstone(peer.db, BOT_CROW_ID), null, "and the peer cleared its tombstone");
  assert.equal(await conflicts(f.A), c0.a, "sync_conflicts unchanged on A");
  assert.equal(await conflicts(f.B), c0.b, "sync_conflicts unchanged on B");
}

test("6a. MUTUAL prune with the counters at an exact TIE, then the re-add ⇒ both sides converge", async () => {
  // The live fleet sits at 4385 / 4385 / 4384 — this is the regime, not a hypothetical.
  await mutualPruneThenReAdd(async (f) => {
    await setCounter(f.A, 4385);
    await setCounter(f.B, 4385);
  });
});

test("6b. MUTUAL prune with the RE-ADDER's counter BELOW its peer's, then the re-add ⇒ both sides converge", async () => {
  // The shape a two-instance sync produces on its own: the applier's counter is
  // MAX(counter, ts+1), so the receiver always ends up AHEAD of the emitter.
  await mutualPruneThenReAdd(async (f) => {
    assert.ok((await counter(f.A)) < (await counter(f.B)),
      "the natural post-sync state already puts the adder BELOW its peer");
  });
});

test("6c. MUTUAL prune with the re-adder's counter FAR below its peer's ⇒ both sides converge", async () => {
  await mutualPruneThenReAdd(async (f, lamport) => {
    await setCounter(f.A, lamport);       // the adder, still where its own emit left it
    await setCounter(f.B, lamport + 500); // the peer, run far ahead by unrelated local writes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 test 6d — THE INCOMMENSURABLE-LAMPORT REGRESSION.
//
// v4's convergence proof claimed a genuine re-add "is emitted at the re-adder's next
// lamport, which is necessarily > R.lamport_ts ⇒ applies and clears the tombstone".
// FALSE. The gate runs on the PEER, against the PEER's tombstone, which sits at the
// PEER's ROW lamport. Two instances' row lamports are equal only when every emit has
// been applied on both sides. One un-replicated `update` on the peer (a rename, a
// block — every one of them is an `op="update"`) and the peer's tombstone OUTRUNS the
// re-adder's insert. The gate drops the insert; every later `update` from the re-adder
// is then dropped unconditionally by the same tombstone. PERMANENT divergence, zero
// sync_conflicts, no log line. A prune tombstone's lamport is a LOCAL row lamport —
// comparing a global insert lamport against it compares incommensurable things.
// ─────────────────────────────────────────────────────────────────────────────

test("6d. a re-add CONVERGES even when the peer's tombstone outran it (the peer had an un-replicated update)", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };

  // A adds the bot from ADV's directory and emits insert@L; B applies it. Both rows @L.
  const L = await addFromDirectoryAndSync(f, BOT_CODE, BOT_CROW_ID);

  // B blocks the bot contact and emits update@L' (L' > L) — and A NEVER RECEIVES IT
  // (offline, feed lag). B's ROW lamport now outruns A's, and A's counter never learns
  // it (_applyEntry:_advanceCounter only runs on receipt — the premise is non-receipt).
  const sent = f.wire.length;
  await emitUpdate(f.B, BOT_CROW_ID, { is_blocked: 1 });
  const lost = f.wire.splice(sent); // dropped on the floor: A never sees this entry
  assert.equal(lost.length, 1, "setup: B emitted exactly one update, and it never reached A");

  const aTs = Number((await row(f.A, BOT_CROW_ID)).lamport_ts);
  const bTs = Number((await row(f.B, BOT_CROW_ID)).lamport_ts);
  assert.equal(aTs, L, "setup: A's row still sits at the original insert's lamport");
  assert.ok(bTs > aTs, "setup: B's ROW lamport outran A's — this is the divergence the gate cannot see");

  // ADV un-advertises ⇒ BOTH instances prune independently. Each writes its tombstone at
  // its OWN row lamport ⇒ the two tombstones DISAGREE, and nothing on the wire says so.
  await prune(f.A, directory());
  await prune(f.B, directory());
  assert.equal(Number((await readTombstone(f.A.db, BOT_CROW_ID)).lamport_ts), aTs, "A's tombstone @ A's row lamport");
  assert.equal(Number((await readTombstone(f.B.db, BOT_CROW_ID)).lamport_ts), bTs, "B's tombstone @ B's HIGHER row lamport");

  // ADV re-advertises. The user re-adds the bot on A. The re-added row is a FRESH INSERT
  // (lamport_ts 0), so emitChange's counter floor has nothing to floor against — the
  // insert goes out at A's own next counter value, at or BELOW B's tombstone.
  await act(f.A, () => acceptBotInvite(f.A.db, {}, { inviteCode: BOT_CODE, advertisedByInstanceId: ADV }));
  const reAdd = f.wire.at(-1).entry;
  assert.equal(reAdd.op, "insert", "the re-add goes out as an `insert`");
  assert.ok(Number(reAdd.lamport_ts) <= bTs,
    "the re-add's lamport is at or below B's tombstone — this is the trap the lamport gate walks into");
  await f.deliver();

  assert.ok(await row(f.A, BOT_CROW_ID), "the re-add landed on A");
  assert.equal(await readTombstone(f.A.db, BOT_CROW_ID), null, "A cleared its own tombstone");

  assert.ok(await row(f.B, BOT_CROW_ID),
    "THE ASSERTION: B MUST apply the genuine re-add. A prune tombstone is GARBAGE COLLECTION, not an " +
    "authoritative delete — it exists only to block resurrection-by-`update` (D3). Gating an `insert` on " +
    "its lamport drops the re-add, and then every later `update` from A is dropped unconditionally by the " +
    "same tombstone: the bot is on A and NOT on B, forever, with zero sync_conflicts and nothing logged.");
  assert.equal(await readTombstone(f.B.db, BOT_CROW_ID), null, "and B cleared its tombstone once the row was back");

  // A follow-up rename from A must now reach B — proof the gate is not still swallowing updates.
  await emitUpdate(f.A, BOT_CROW_ID, { display_name: "Back Again" });
  await f.deliver();
  assert.equal((await row(f.B, BOT_CROW_ID)).display_name, "Back Again", "and normal contact sync resumed on B");

  assert.equal(await conflicts(f.A), c0.a, "sync_conflicts unchanged on A");
  assert.equal(await conflicts(f.B), c0.b, "sync_conflicts unchanged on B");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 test 7 — CONVERGENCE (the plan's acceptance criterion)
// ─────────────────────────────────────────────────────────────────────────────

test("7. both instances paired with ADV prune INDEPENDENTLY — provenance crossed the wire, no delete ever did", async () => {
  const f = newFleet();
  const c0 = { a: await conflicts(f.A), b: await conflicts(f.B) };
  for (const inst of [f.A, f.B]) {
    await inst.db.execute({
      sql: "INSERT INTO crow_instances (id, name, crow_id, trusted, status, is_home) VALUES (?,?,?,1,'active',0)",
      args: [ADV, "Advertiser", "crow:adv0000001"],
    });
  }

  // A ADDED it from ADV's directory. B receives it BY SYNC.
  await act(f.A, () => acceptBotInvite(f.A.db, {}, { inviteCode: BOT_CODE, advertisedByInstanceId: ADV }));

  // The provenance must actually cross the wire — if it does not, B can NEVER prune
  // (rule: advertised_by_instance_id IS NOT NULL) and the whole design fails.
  const inserts = f.wire.filter((w) => w.entry.table === "contacts" && w.entry.op === "insert");
  assert.equal(inserts.length, 1, "exactly one insert on the wire");
  assert.equal(inserts[0].entry.row.advertised_by_instance_id, ADV,
    "the FACT of who advertised the bot rides the wire (it is NOT in EXCLUDED_COLUMNS)");
  assert.equal("origin" in inserts[0].entry.row, false,
    "…while `origin` — a judgment — does not (F3)");

  await f.deliver();
  const b = await row(f.B, BOT_CROW_ID);
  assert.equal(b.advertised_by_instance_id, ADV, "B stored the provenance it received");
  assert.equal(b.origin, null, "B did NOT inherit the sender's judgment");

  // ADV un-advertises. Each instance reaches the same conclusion from its OWN view.
  const wireBefore = f.wire.length;
  await prune(f.A, directory());
  await prune(f.B, directory());

  assert.equal(await row(f.A, BOT_CROW_ID), null, "gone on A");
  assert.equal(await row(f.B, BOT_CROW_ID), null, "gone on B — it pruned independently, from its own view of ADV");
  assert.equal(f.wire.length, wireBefore, "NOTHING was emitted by either prune");
  assert.equal(f.wire.filter((w) => w.entry.op === "delete").length, 0,
    "ZERO `op=delete` on the wire — convergence needs no broadcast and no host authority (v1 died here)");

  // Deliver anything still queued; a delete-free wire must leave both sides settled.
  await f.deliver();
  assert.equal(await row(f.A, BOT_CROW_ID), null, "still gone on A after replication");
  assert.equal(await row(f.B, BOT_CROW_ID), null, "still gone on B after replication");

  // §5 test 9
  assert.equal(await conflicts(f.A), c0.a, "sync_conflicts unchanged on A");
  assert.equal(await conflicts(f.B), c0.b, "sync_conflicts unchanged on B");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 test 9 — sync_conflicts must not grow. Growth is what killed v1.
// ─────────────────────────────────────────────────────────────────────────────

test("9. a FULL lifecycle (add → sync → mutual prune → resurrection attempt → re-add) grows sync_conflicts by ZERO on both instances", async () => {
  const f = newFleet();
  const before = { a: await conflicts(f.A), b: await conflicts(f.B) };

  await addFromDirectoryAndSync(f, BOT_CODE, BOT_CROW_ID);
  await addFromDirectoryAndSync(f, KEEP_CODE, KEEP_CROW_ID);
  await prune(f.A, directory(KEEP_X));
  await prune(f.B, directory(KEEP_X));
  await emitUpdate(f.B, KEEP_CROW_ID, { display_name: "Still Here" });
  await act(f.A, () => acceptBotInvite(f.A.db, {}, { inviteCode: BOT_CODE, advertisedByInstanceId: ADV }));
  // ONE drain at the end — the interleaving that exposes v1's LWW asymmetry: a
  // broadcast delete would arrive at a peer that has ALREADY re-added the row at a
  // higher lamport ⇒ the delete LOSES ⇒ `_insertConflictRow` ⇒ the log grows.
  await f.deliver();

  // The conflict log FIRST — it is this test's named mechanism, and under a
  // broadcast-delete prune it is the assertion that must report.
  assert.equal(await conflicts(f.A), before.a,
    "sync_conflicts BYTE-IDENTICAL on A — a broadcast delete would collide with the re-added row and log one");
  assert.equal(await conflicts(f.B), before.b, "sync_conflicts BYTE-IDENTICAL on B");
  assert.ok(await row(f.B, BOT_CROW_ID), "and the lifecycle actually converged");
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 test 10 — DOCUMENTED, NOT FIXED. An accepted trade-off, asserted so that it
// is a CHOICE on the record rather than a surprise in production.
// ─────────────────────────────────────────────────────────────────────────────

test("10. ACCEPTED TRADE-OFF: a DM from a pruned-but-still-running bot arrives as a message REQUEST — it must not resurrect the contact", async () => {
  const f = newFleet();
  await addFromDirectoryAndSync(f, BOT_CODE, BOT_CROW_ID);
  await prune(f.A, directory());
  assert.equal(await row(f.A, BOT_CROW_ID), null, "pruned");

  // The bot is un-advertised, not dead. It DMs us. It is no longer a contact, so the
  // receive path files it as a message request under `req:<secp>` — by design.
  await handleIncomingRequest(f.A.db, { createNotification: async () => {} }, {
    senderPubkey: BOT.secp256k1Pubkey, content: "still here", eventId: "evt-prune-10",
  });

  const reqId = "req:" + normalizePubkey(BOT.secp256k1Pubkey);
  const req = await row(f.A, reqId);
  assert.ok(req, "the DM landed as a `req:<secp>` message-request row");
  assert.equal(req.request_status, "pending", "…in the pending-request state, awaiting the user");
  const { rows: msgs } = await f.A.db.execute({
    sql: "SELECT content FROM messages WHERE contact_id = ?", args: [req.id],
  });
  assert.deepEqual(msgs.map((m) => m.content), ["still here"], "the message itself is NOT lost");

  // And the pruned contact stays pruned: a request is not a resurrection.
  assert.equal(await row(f.A, BOT_CROW_ID), null, "the pruned bot contact was NOT recreated");
  assert.ok(await readTombstone(f.A.db, BOT_CROW_ID), "its tombstone still stands");
});
