/**
 * Tests for servers/sharing/sync-outbox-drain.js — Task 4 of the
 * stdio-sync-outbox plan ("The drain"). See
 * docs/superpowers/specs/2026-08-15-stdio-sync-outbox-design.md, "The
 * drain" section — binding authority for the mechanism under test.
 *
 * Schema: real init-db.js against a scratch dir (crow_instances, contacts).
 * sync_outbox/sync_state are NOT created by init-db.js (bundle-init
 * pattern) — ensureSyncTables(db) creates them per servers/shared/sync-stamp.js.
 * Feeds: plain stub objects (append(entry)) registered on mgr.outFeeds, the
 * same seam tests/instance-sync.test.js uses (no real Hypercore).
 *
 * CRITICAL trap (named by both the spec and the task brief): the suite env
 * exports CROW_DISABLE_INSTANCE_SYNC=1, which the manager constructor reads
 * into feedsDisabled — every test below force-enables via
 * `mgr.feedsDisabled = false` (tests/instance-sync.test.js's own pattern),
 * or the whole file would be vacuous. AND: a stub outFeed alone is not
 * enough — the "currently paired" set the drain checks against comes from
 * crow_instances rows (status IN ('active','offline')), so every peer a
 * test cares about accounting for is ALSO INSERTed there, or the
 * delivered-covers-all-paired check (and the paired-but-unarmed case) goes
 * quietly inert.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { ensureSyncTables } from "../servers/shared/sync-stamp.js";
import { drainOnce, startOutboxDrain, getStats } from "../servers/sharing/sync-outbox-drain.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── Shared setup ────────────────────────────────────────────────────────
//
// sync_outbox and crow_instances have NO per-test scoping column (unlike
// e.g. sync_state, keyed by instance_id) — a shared db file across tests
// would let one test's queued rows/registered peers pollute another test's
// "currently paired" accounting. So EACH test gets its own fully-migrated
// scratch db (mirrors tests/sync-emit.test.js's freshDb() convention), not
// one shared DB_PATH.

/** Build a fresh, fully-migrated scratch crow.db + a manager on it. */
function freshManager(label, instanceId = "local-0000-0000-0000-000000000001") {
  const dir = mkdtempSync(join(tmpdir(), `crow-outbox-drain-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });
  const db = createDbClient(join(dir, "crow.db"));
  const mgr = new InstanceSyncManager(IDENTITY, db, instanceId);
  mgr.feedsDisabled = false; // see header: suite-env override trap
  return { mgr, db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const TEST_PRIV = Buffer.alloc(32, 0xCD);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

/** Register a peer row so it's part of the "currently paired" target set. */
async function registerPeer(db, id, status = "active") {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, ?)",
    args: [id, id, `crow:${id}`, status],
  });
}

/** Directly INSERT a queued row into sync_outbox — bypasses emitOrQueue
 *  (Task 2, already tested elsewhere) so these tests exercise drainOnce in
 *  isolation against a known lamport/delivered_json/claimed_at shape. */
async function queueRow(db, { table = "contacts", op = "update", row, lamportTs, delivered = {}, claimedAt = null }) {
  await ensureSyncTables(db);
  const { rows } = await db.execute({
    sql: `INSERT INTO sync_outbox (table_name, op, row_json, lamport_ts, delivered_json, claimed_at)
          VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    args: [table, op, JSON.stringify(row), lamportTs, JSON.stringify(delivered), claimedAt],
  });
  return rows[0].id;
}

async function outboxRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM sync_outbox WHERE id = ?", args: [id] });
  return rows[0] || null;
}

async function outboxCount(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_outbox");
  return Number(rows[0].n);
}

// ── 1. Order preserved across batches ──────────────────────────────────

test("drainOnce: order preserved across batches (drain order = write/id order)", async () => {
  const { mgr, db, dir } = freshManager("inst-order");
  await registerPeer(db, "peer-order");
  const captured = [];
  mgr.outFeeds.set("peer-order", { append: async (e) => captured.push(e) });

  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(
      await queueRow(db, {
        row: { crow_id: `crow:order-${i}` },
        lamportTs: 100 + i,
      }),
    );
  }

  const first = await drainOnce(mgr, db, { batchSize: 2 });
  assert.equal(first.deleted, 2, "first batch of 2 fully delivers and deletes both");
  const second = await drainOnce(mgr, db, { batchSize: 2 });
  assert.equal(second.deleted, 1, "second call picks up the remaining row");

  assert.deepEqual(
    captured.map((e) => e.row.crow_id),
    ["crow:order-0", "crow:order-1", "crow:order-2"],
    "peer received entries in write (id) order across both batches",
  );
  cleanup({ db, dir });
});

// ── 2. Partial delivery: unclaim-on-retain, immediate-retry observable ──

test("drainOnce: partial delivery retains the row with delivered_json merged; unclaim proven via IMMEDIATE retry (no 10-min wait)", async () => {
  const { mgr, db, dir } = freshManager("inst-partial");
  await registerPeer(db, "peer-A");
  await registerPeer(db, "peer-B"); // paired but starts UNARMED — no outFeed yet
  const capturedA = [];
  mgr.outFeeds.set("peer-A", { append: async (e) => capturedA.push(e) });

  const id = await queueRow(db, { row: { crow_id: "crow:partial" }, lamportTs: 500 });

  const first = await drainOnce(mgr, db);
  assert.equal(first.deleted, 0, "row must NOT be deleted — peer-B never appended");
  assert.equal(first.emitted, 1, "an emit attempt happened this pass");
  assert.deepEqual(first.parkedPeers, ["peer-B"], "peer-B reported as parked (paired, unarmed)");

  const mid = await outboxRow(db, id);
  assert.ok(mid, "row still present after partial delivery");
  assert.deepEqual(JSON.parse(mid.delivered_json), { "peer-A": true }, "delivered_json carries the peer that DID append");
  assert.equal(capturedA.length, 1, "the healthy peer still received the real append despite the retained row");

  // Immediate-retry observable: call drainOnce again RIGHT AWAY (no
  // backdating). If the first pass failed to unclaim, this second call's
  // claim UPDATE (claimed_at IS NULL OR < -10min) would skip the row
  // entirely and it would stay retained even after peer-B arms — proving
  // the unclaim, not just reading the claimed_at column directly.
  mgr.outFeeds.set("peer-B", { append: async (e) => {} });
  const second = await drainOnce(mgr, db);
  assert.equal(second.deleted, 1, "row deletes on the very next drainOnce call once peer-B is armed — proves the retain path unclaimed it");

  const gone = await outboxRow(db, id);
  assert.equal(gone, null);
  cleanup({ db, dir });
});

// ── 2b. Escalating warn: paired peer unarmed for >3 consecutive drains ──

test("drainOnce: escalating warn fires once a paired peer has stayed unarmed for more than 3 consecutive drains", async () => {
  const { mgr, db, dir } = freshManager("inst-unarmed-streak");
  await registerPeer(db, "peer-unarmed-streak"); // paired, but NO outFeed ever registered

  await queueRow(db, { row: { crow_id: "crow:streak" }, lamportTs: 900 });

  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnCalls.push(args.join(" ")); };
  try {
    for (let i = 0; i < 3; i++) {
      await drainOnce(mgr, db);
    }
    assert.ok(
      !warnCalls.some((m) => m.includes("ESCALATING")),
      "no escalating warn yet at exactly 3 consecutive unarmed drains",
    );

    await drainOnce(mgr, db); // 4th consecutive pass — crosses the >3 threshold
    assert.ok(
      warnCalls.some((m) => m.includes("ESCALATING") && m.includes("peer-unarmed-streak")),
      "escalating warn fires once the peer has been unarmed for >3 consecutive drains",
    );
  } finally {
    console.warn = origWarn;
  }
  cleanup({ db, dir });
});

test("drainOnce: unarmed streak resets once the peer arms — a later, unrelated peer starts its own clean streak", async () => {
  const { mgr, db, dir } = freshManager("inst-unarmed-reset");
  await registerPeer(db, "peer-reset");

  await queueRow(db, { row: { crow_id: "crow:reset-1" }, lamportTs: 1 });

  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnCalls.push(args.join(" ")); };
  try {
    // peer-reset unarmed for 3 straight passes (streak builds to 3, never
    // crosses the >3 threshold).
    for (let i = 0; i < 3; i++) {
      await drainOnce(mgr, db);
    }

    // peer-reset arms on the 4th pass — row delivers, streak resets to 0.
    mgr.outFeeds.set("peer-reset", { append: async () => {} });
    await drainOnce(mgr, db);
    assert.ok(
      !warnCalls.some((m) => m.includes("ESCALATING") && m.includes("peer-reset")),
      "peer-reset must never escalate — it armed on the pass that would have crossed the threshold",
    );

    // A brand-new peer, never seen before, starts its OWN streak from zero —
    // proves tracking is per-peer state, not a leaked/shared counter.
    await registerPeer(db, "peer-fresh");
    await queueRow(db, { row: { crow_id: "crow:reset-2" }, lamportTs: 2 });
    for (let i = 0; i < 3; i++) {
      await drainOnce(mgr, db);
    }
    assert.ok(
      !warnCalls.some((m) => m.includes("ESCALATING") && m.includes("peer-fresh")),
      "peer-fresh must not escalate yet — only 3 consecutive unarmed passes so far",
    );
    await drainOnce(mgr, db); // 4th consecutive pass for peer-fresh
    assert.ok(
      warnCalls.some((m) => m.includes("ESCALATING") && m.includes("peer-fresh")),
      "peer-fresh escalates independently on its own 4th consecutive unarmed pass",
    );
  } finally {
    console.warn = origWarn;
  }
  cleanup({ db, dir });
});

// ── 3. Claim excludes already-claimed rows (no-op until stale) ─────────

test("drainOnce: claim excludes a hand-claimed (not-yet-stale) row — second call no-ops on it", async () => {
  const { mgr, db, dir } = freshManager("inst-claimed");
  await registerPeer(db, "peer-c");
  mgr.outFeeds.set("peer-c", { append: async () => {} });

  const id = await queueRow(db, { row: { crow_id: "crow:claimed" }, lamportTs: 10 });
  // Hand-claim it "just now" — simulates another drainer (or process) owning it.
  await db.execute({ sql: "UPDATE sync_outbox SET claimed_at = datetime('now') WHERE id = ?", args: [id] });

  const result = await drainOnce(mgr, db);
  assert.equal(result.emitted, 0, "claimed-and-fresh row is excluded from the claim");
  assert.equal(result.deleted, 0);

  const row = await outboxRow(db, id);
  assert.ok(row, "row is untouched, still present, still claimed");
  assert.ok(row.claimed_at, "claimed_at was not cleared by a drain that never touched the row");
  cleanup({ db, dir });
});

// ── 4. Stale claim (backdated 11 min) reclaims ──────────────────────────

test("drainOnce: a claim older than 10 minutes is reclaimed and processed", async () => {
  const { mgr, db, dir } = freshManager("inst-stale");
  await registerPeer(db, "peer-s");
  const captured = [];
  mgr.outFeeds.set("peer-s", { append: async (e) => captured.push(e) });

  const id = await queueRow(db, { row: { crow_id: "crow:stale" }, lamportTs: 20 });
  await db.execute({
    sql: "UPDATE sync_outbox SET claimed_at = datetime('now', '-11 minutes') WHERE id = ?",
    args: [id],
  });

  const result = await drainOnce(mgr, db);
  assert.equal(result.deleted, 1, "the stale-claimed row is reclaimed and, fully delivered, deleted");
  assert.equal(captured.length, 1, "stale-reclaim redelivery actually re-appended (idempotent redelivery, not a skip)");
  cleanup({ db, dir });
});

// ── 5. Preserve-mode lamport asserted on the captured feed entry ───────

test("drainOnce: the captured feed entry carries the QUEUED row's original lamport (preserve-mode), not a freshly minted one", async () => {
  const { mgr, db, dir } = freshManager("inst-lamport");
  await registerPeer(db, "peer-l");
  const captured = [];
  mgr.outFeeds.set("peer-l", { append: async (e) => captured.push(e) });

  // Mint a few lamports on THIS manager first so a fresh mint would clearly
  // differ from the queued value below.
  await mgr._nextLamport();
  await mgr._nextLamport();

  const QUEUED_LAMPORT = 777777;
  await queueRow(db, { row: { crow_id: "crow:lamport" }, lamportTs: QUEUED_LAMPORT });

  const result = await drainOnce(mgr, db);
  assert.equal(result.deleted, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].lamport_ts, QUEUED_LAMPORT, "preserve-mode: entry lamport === the row's original queued lamport");
  cleanup({ db, dir });
});

// ── 6. Overlapping drainOnce calls serialize ────────────────────────────

test("drainOnce: overlapping calls serialize — a second call's row processing never interleaves a slow first call's", async () => {
  const { mgr, db, dir } = freshManager("inst-overlap");
  await registerPeer(db, "peer-o");

  const events = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstCall = true;

  mgr.outFeeds.set("peer-o", {
    append: async (e) => {
      if (firstCall) {
        firstCall = false;
        events.push("first-start");
        await gate; // hold the first call open until the test releases it
        events.push("first-end");
      } else {
        events.push("second-row");
      }
    },
  });

  await queueRow(db, { row: { crow_id: "crow:ov-1" }, lamportTs: 1 });
  await queueRow(db, { row: { crow_id: "crow:ov-2" }, lamportTs: 2 });

  const p1 = drainOnce(mgr, db, { batchSize: 1 }); // claims row 1, blocks in append
  // Give p1's claim + emitChange call a tick to actually start before p2 fires.
  await new Promise((r) => setTimeout(r, 20));
  const p2 = drainOnce(mgr, db, { batchSize: 1 }); // must wait for p1 to finish

  // p2 must not have recorded anything yet — it's queued behind p1 in the chain.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ["first-start"], "second call has not started its row work while the first is still open");

  releaseFirst();
  await p1;
  await p2;

  assert.deepEqual(events, ["first-start", "first-end", "second-row"], "second call's row processing only began after the first call fully completed");
  cleanup({ db, dir });
});

// ── 7. feedsDisabled refusal ─────────────────────────────────────────────

test("drainOnce: refuses when mgr.feedsDisabled — zero counts, no db touch", async () => {
  const { mgr, db, dir } = freshManager("inst-disabled");
  mgr.feedsDisabled = true; // simulate a --no-auth companion sharing this db
  await registerPeer(db, "peer-d");
  mgr.outFeeds.set("peer-d", { append: async () => {} });

  const id = await queueRow(db, { row: { crow_id: "crow:disabled" }, lamportTs: 1 });

  const result = await drainOnce(mgr, db);
  assert.deepEqual(result, { emitted: 0, deleted: 0, parkedPeers: [] });

  const row = await outboxRow(db, id);
  assert.ok(row, "row untouched — feedsDisabled must not claim/consume it");
  assert.equal(row.claimed_at, null, "not even claimed");
  cleanup({ db, dir });
});

// ── Mutation-test guard, as its own assertion: not-syncable null path ──

test("drainOnce: a not-syncable row (belt-and-braces, older-code shape) resolves null from emitChange and is DELETEd, not retained", async () => {
  const { mgr, db, dir } = freshManager("inst-notsync");
  // origin: 'local-bot' fails shouldSyncRow("contacts", ...) unconditionally.
  const id = await queueRow(db, { row: { crow_id: "crow:bot", origin: "local-bot" }, lamportTs: 1 });

  const result = await drainOnce(mgr, db);
  assert.equal(result.deleted, 1);
  assert.equal(result.emitted, 0, "not-syncable null never counts as an emit");
  const row = await outboxRow(db, id);
  assert.equal(row, null);
  cleanup({ db, dir });
});

// ── Zero-paired-peers vacuous delivery ──────────────────────────────────

test("drainOnce: zero currently-paired peers deletes the row on first pass (live-emit parity, not a bug)", async () => {
  const { mgr, db, dir } = freshManager("inst-zeropeer");
  // No registerPeer call — no crow_instances rows at all for this instance.
  const id = await queueRow(db, { row: { crow_id: "crow:zero" }, lamportTs: 1 });

  const result = await drainOnce(mgr, db);
  assert.equal(result.deleted, 1);
  const row = await outboxRow(db, id);
  assert.equal(row, null);
  cleanup({ db, dir });
});

// ── startOutboxDrain: boot pass + unref'd interval, stop() clears it ────

test("startOutboxDrain: runs an immediate boot pass and stop() clears the interval", async () => {
  const { mgr, db, dir } = freshManager("inst-boot");
  await registerPeer(db, "peer-boot");
  const captured = [];
  mgr.outFeeds.set("peer-boot", { append: async (e) => captured.push(e) });
  await queueRow(db, { row: { crow_id: "crow:boot" }, lamportTs: 1 });

  const handle = startOutboxDrain(mgr, db, { intervalMs: 1_000_000 });
  assert.equal(typeof handle.stop, "function");

  // Boot pass is fire-and-forget (async) — wait for it to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(captured.length, 1, "boot pass drained the queued row without waiting for the interval");

  handle.stop();
  assert.equal(await outboxCount(db), 0);
  cleanup({ db, dir });
});

// ── getStats: depth + oldest age ────────────────────────────────────────

test("getStats: reports depth and oldest-row age; zero depth reports null age", async () => {
  const { mgr, db, dir } = freshManager("inst-stats");
  // Deliberately no ensureSyncTables() call here — getStats() must handle a
  // sync_outbox table that doesn't exist yet (fresh install, nothing ever
  // queued) on its own.

  const empty = await getStats(db);
  assert.equal(empty.depth, 0);
  assert.equal(empty.oldestAgeMs, null);

  await queueRow(db, { row: { crow_id: "crow:stats-1" }, lamportTs: 1 });
  await queueRow(db, { row: { crow_id: "crow:stats-2" }, lamportTs: 2 });

  const withRows = await getStats(db);
  assert.equal(withRows.depth, 2);
  assert.ok(Number.isFinite(withRows.oldestAgeMs) && withRows.oldestAgeMs >= 0, "oldestAgeMs is a non-negative number once rows exist");
  cleanup({ db, dir });
  void mgr;
});
