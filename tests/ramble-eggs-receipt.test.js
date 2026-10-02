/**
 * Spec 2026-09-08 §4.2 — "the user is therefore only ever eggless when they
 * genuinely have none." Promote-on-gift-receipt (Kevin, 2026-09-22: the
 * branch's "wait on the shelf" deviation was rejected).
 *
 * ⚠ THE HARNESS MODELS LAMPORT LWW FOR REAL (fix round 1, I-3). An earlier
 * version replayed every op with one global, ever-increasing stamp and never
 * stamped the sender's own row, so every replayed op won by construction and
 * no assertion here could fail on an ordering bug. Now:
 *
 *   - every simulated Crow keeps ITS OWN counter (`crow(db, start)`);
 *   - every emit mints from that counter AND stamps the local row with the
 *     production `stampSql`, exactly as emitChange does;
 *   - delivery advances the receiver's counter past each incoming op, as
 *     `_advanceCounter` does, and applies through the real `applyRemoteOp`;
 *   - a contact's DM reaches EVERY Crow of the user (all of a user's Crows
 *     share one Nostr identity — servers/sharing/nostr.js), so each Crow runs
 *     the receive path itself, as in production.
 *
 * Race tests run with the counters ordered BOTH ways. An EQUAL-Lamport tie
 * between two different writes of one row is the open core defect I-2
 * (applyRambleEgg applies an incoming op on a tie, on both sides), which is
 * awaiting a decision; those cases are deliberately not pinned here.
 *
 * The ways an egg can appear while the slot is empty, and the answer for
 * each (mirrored in the comment above `promoteFromShelf` in eggs.js):
 *
 *   1. a GIFT arrives                 -> promoted on receipt, replicates
 *   2. a SWAP completes (either side) -> promoted after the hand-over batch
 *   3. a swap is DECLINED (inbound,
 *      our own withdrawal, or the
 *      "cannot honour" reply)         -> promoted: a declined row can never
 *                                        complete, so nothing is stranded
 *   4. a swap LAPSES (expireTrades)   -> NOT promoted by the sweep (Kevin:
 *                                        leave it). The freed egg IS
 *                                        promotable by every other path, so
 *                                        the late-`completed` hand-over takes
 *                                        it from the slot too (I-1): the user
 *                                        never keeps both eggs.
 *   5. a NEST is claimed              -> promoted (nothing is in flight; not a
 *                                        gift, but the same §4.2 promise)
 *
 * And the sync-apply path: an apply NEVER promotes a user/received egg. Each
 * Crow promotes from its own receive path and emits; LWW settles the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRemoteOp } from "../servers/sharing/instance-sync.js";
import { stampSql } from "../servers/shared/sync-stamp.js";
import { hatchIfReady, nextPromotable, isoWeek } from "../bundles/ramble/server/eggs.js";
import { claimNest, incubateEgg } from "../bundles/ramble/server/flock.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";
import { pendingDeliveries, deleteDelivery } from "../bundles/ramble/server/delivery.js";
import {
  receiveEnvelope, receiveGift, proposeSwap, acceptSwap, declineSwap, receiveTrade, expireTrades, TRADE_TTL_MS,
} from "../bundles/ramble/server/trades.js";

const T0 = Date.UTC(2026, 9, 2, 12);
const FRIEND = "crow:friend";
const ME = "crow:me";
/** Counter starts for the two of the user's Crows, both orderings. Chosen so no op can tie (I-2). */
const ORDERS = [[200, 10], [10, 200]];

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }

async function put(db, eggId, status, createdAt, { origin = null, warmth = 0 } = {}) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at)
          VALUES (?, ?, ?, ?, '9v6m21h', '2026-W40', ?)`,
    args: [eggId, status, origin, warmth, createdAt],
  });
}
async function egg(db, id) { return (await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [id] })).rows[0] ?? null; }
async function incubating(db) {
  return (await db.execute("SELECT egg_id FROM ramble_eggs WHERE status = 'incubating' ORDER BY egg_id")).rows.map((r) => r.egg_id);
}
async function held(db) {
  return Number((await db.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status IN ('incubating','shelf','received')")).rows[0].n);
}
async function snapshot(db) {
  return (await db.execute("SELECT egg_id, status, shelf_origin, warmth FROM ramble_eggs ORDER BY egg_id")).rows
    .map((r) => [r.egg_id, r.status, r.shelf_origin ?? null, r.warmth]);
}
async function tradeState(db, id) {
  return (await db.execute({ sql: "SELECT state FROM ramble_trades WHERE trade_id = ?", args: [id] })).rows[0]?.state ?? null;
}

/**
 * One of the user's Crows: its own Lamport counter, and an emit that mints,
 * stamps the local row (production `stampSql`) and records the wire op.
 */
function crow(db, start) {
  const c = { db, counter: start, ops: [], sent: new Map() };
  c.emit = async (table, op, row) => {
    const ts = ++c.counter;
    if (op !== "delete") {
      const st = stampSql(table, row, ts);
      if (st) await db.execute(st);
    }
    const { lamport_ts: _ignored, ...wire } = row;
    c.ops.push([table, op, wire, ts]);
  };
  return c;
}
/** Deliver every op `from` has not yet sent to `to`, advancing `to`'s counter like _advanceCounter. */
async function deliver(from, to) {
  const already = from.sent.get(to) ?? 0;
  for (const [table, op, row, ts] of from.ops.slice(already)) {
    to.counter = Math.max(to.counter, ts + 1);
    // eslint-disable-next-line no-await-in-loop
    await applyRemoteOp(to.db, table, op, row, ts);
  }
  from.sent.set(to, from.ops.length);
}
async function sync(a, b) { await deliver(a, b); await deliver(b, a); }

/** Pop the one queued delivery (what the transport would send). */
async function pop(db) {
  const rows = await pendingDeliveries(db, 50);
  assert.equal(rows.length, 1, `expected one queued delivery, found ${rows.length}`);
  await deleteDelivery(db, rows[0].id);
  return JSON.parse(rows[0].payload_json);
}
const giftEnvelope = (eggId, warmth = 25) => ({
  type: "ramble.egg", v: 1, egg: { egg_id: eggId, warmth, found_cell: "9v6m21h", found_week: "2026-W40" },
});
const asParsed = (env) => ({ ...env.trade, egg: env.egg ?? null });

/** Two of the user's Crows, converged: a hatched bird, an empty slot. */
async function twoEgglessCrows([aStart, bStart]) {
  const a = crow(await freshDb(), aStart);
  const b = crow(await freshDb(), bStart);
  for (const c of [a, b]) await put(c.db, "bird", "hatched", T0 - 86400e3);
  return { a, b };
}

/* ------------------------------------------------------------------ gifts */

for (const order of ORDERS) {
  test(`MULTI-INSTANCE (counters ${order}): one gift DM reaches both Crows; each promotes it; after sync both agree`, async () => {
    const { a, b } = await twoEgglessCrows(order);
    const r = await receiveEnvelope(a.db, { crowId: FRIEND, payload: giftEnvelope("gift-1") }, { now: T0, emit: a.emit });
    assert.equal(r.inserted, true);
    await receiveEnvelope(b.db, { crowId: FRIEND, payload: giftEnvelope("gift-1") }, { now: T0 + 700, emit: b.emit });

    for (const c of [a, b]) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await incubating(c.db), ["gift-1"], "spec §4.2: the slot refills when an egg arrives, not only on a hatch");
    }
    await sync(a, b);
    assert.deepEqual(await incubating(a.db), ["gift-1"]);
    assert.deepEqual(await snapshot(a.db), await snapshot(b.db), "both Crows hold the same eggs in the same places");
    const g = await egg(a.db, "gift-1");
    assert.equal(g.shelf_origin, null, "never relabelled 'sync' by a convergence demotion");
    assert.equal(g.from_crow_id, FRIEND);
    assert.equal(g.warmth, 25, "the warmth the friend put in travels with it");
  });

  test(`MULTI-INSTANCE (counters ${order}): the gift lands while one Crow is mid-hatch — both Crows converge`, async () => {
    // B hatches `warming` (its shelf is empty, so its slot empties) and then
    // the friend's gift DM reaches BOTH Crows: B promotes it, A — whose slot
    // still holds `warming` — leaves it received. Which write wins is LWW's
    // call; the assertion is that both Crows agree on it. (On an exact
    // Lamport tie they do not — I-2, pending a decision.)
    const a = crow(await freshDb(), order[0]);
    const b = crow(await freshDb(), order[1]);
    for (const c of [a, b]) await put(c.db, "warming", "incubating", T0 - 2000, { warmth: 100 });
    await hatchIfReady(b.db, { now: T0, emit: b.emit });
    await receiveGift(b.db, giftEnvelope("gift-6").egg, { fromCrowId: FRIEND, now: T0 + 1, emit: b.emit });
    await receiveGift(a.db, giftEnvelope("gift-6").egg, { fromCrowId: FRIEND, now: T0 + 2, emit: a.emit });
    assert.deepEqual(await incubating(b.db), ["gift-6"]);
    assert.equal((await egg(a.db, "gift-6")).status, "received", "A's slot was full when the gift landed");

    await sync(a, b);
    assert.deepEqual(await snapshot(a.db), await snapshot(b.db), "converged");
    assert.equal((await egg(a.db, "warming")).status, "hatched");
    const slot = await incubating(a.db);
    if (slot.length === 0) {
      assert.equal((await nextPromotable(a.db)).egg_id, "gift-6", "if the received write won, Warm it offers the gift on both");
      assert.equal((await nextPromotable(b.db)).egg_id, "gift-6");
    } else {
      assert.deepEqual(slot, ["gift-6"]);
    }
  });
}

test("a gift arriving while an egg is already warming waits on the shelf — it never displaces it", async () => {
  const db = await freshDb();
  await put(db, "warming", "incubating", T0 - 1000, { warmth: 40 });
  await receiveGift(db, giftEnvelope("gift-2").egg, { fromCrowId: FRIEND, now: T0 });
  assert.deepEqual(await incubating(db), ["warming"]);
  assert.equal((await egg(db, "gift-2")).status, "received");
});

test("re-delivery of a gift that was already promoted is a no-op (no second promote, no emit)", async () => {
  const c = crow(await freshDb(), 1);
  await receiveGift(c.db, giftEnvelope("gift-3").egg, { fromCrowId: FRIEND, now: T0, emit: c.emit });
  const before = c.ops.length;
  const again = await receiveGift(c.db, giftEnvelope("gift-3").egg, { fromCrowId: FRIEND, now: T0 + 5, emit: c.emit });
  assert.equal(again.inserted, false);
  assert.equal(c.ops.length, before, "nothing changed, so nothing replicates");
  assert.deepEqual(await incubating(c.db), ["gift-3"]);
});

test("the promote follows the ONE shelf rule: with an older egg already waiting, the older one goes in", async () => {
  const db = await freshDb();
  await put(db, "older", "shelf", T0 - 5000, { origin: "user" });
  await receiveGift(db, giftEnvelope("gift-4").egg, { fromCrowId: FRIEND, now: T0 });
  assert.deepEqual(await incubating(db), ["older"]);
  assert.equal((await egg(db, "gift-4")).status, "received");
});

test("the daily per-contact gift ceiling still counts a gift that was promoted out of 'received'", async () => {
  const db = await freshDb();
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await receiveGift(db, giftEnvelope(`flood-${i}`).egg, { fromCrowId: FRIEND, now: T0 + i });
    assert.equal(r.inserted, true, `gift ${i}`);
  }
  assert.deepEqual(await incubating(db), ["flood-0"]);
  const over = await receiveGift(db, giftEnvelope("flood-20").egg, { fromCrowId: FRIEND, now: T0 + 30 });
  assert.equal(over.reason, "capped", "promoting one must not open a 21st slot in the ceiling");
});

test("a gift already at the hatch threshold hatches on receipt, as Warm it would (review M-4)", async () => {
  const db = await freshDb();
  await put(db, "bird", "hatched", T0 - 86400e3);
  await receiveGift(db, giftEnvelope("ripe", 100).egg, { fromCrowId: FRIEND, now: T0 });
  const ripe = await egg(db, "ripe");
  assert.equal(ripe.status, "hatched", "not parked at 100% until some unrelated credit arrives");
  assert.ok(ripe.species, "a bird was rolled");
  assert.deepEqual(await incubating(db), []);
});

/* ------------------------------------------------------------------ nests */

function firstNestCell(week) {
  for (let i = 0; i < 5000; i += 1) {
    const c = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(c, week)) return c;
  }
  throw new Error("no nest");
}

for (const order of ORDERS) {
  test(`MULTI-INSTANCE (counters ${order}): an egg claimed from a nest with the slot empty warms at once, on both Crows`, async () => {
    // A nest claim is local to the Crow it happens on (claims never travel by
    // DM). Its 'user' shelf insert is a user shelve on apply (no sync
    // re-promote), and the promote op that follows lands it in the peer's slot.
    const { a, b } = await twoEgglessCrows(order);
    const week = isoWeek(T0);
    const cell = firstNestCell(week);
    const nest = nestFor(cell, week);
    const r = await claimNest(a.db, { cell, week, here: { lat: nest.lat, lon: nest.lon }, now: T0, emit: a.emit });
    assert.equal(r.claimed, true);
    assert.deepEqual(await incubating(a.db), [r.egg.egg_id]);
    await sync(a, b);
    assert.deepEqual(await incubating(b.db), [r.egg.egg_id]);
    assert.deepEqual(await snapshot(b.db), await snapshot(a.db));
  });
}

/* ------------------------------------------------------------------ swaps */

/**
 * The user's two Crows (`me`, `peer`), converged, with the user's only shelf
 * egg `mine` and a full `warming` egg. The user proposes `mine` on `me`; the
 * egg then hatches, so the slot is empty and `mine` is locked. Everything is
 * synced to `peer` before any reply arrives.
 */
async function proposerPair(order) {
  const me = crow(await freshDb(), order[0]);
  const peer = crow(await freshDb(), order[1]);
  for (const c of [me, peer]) {
    await put(c.db, "mine", "shelf", T0 - 3000, { origin: "user" });
    await put(c.db, "warming", "incubating", T0 - 2000, { warmth: 100 });
  }
  const p = await proposeSwap(me.db, { eggId: "mine", toCrowId: FRIEND, now: T0, emit: me.emit });
  assert.equal(p.ok, true);
  await hatchIfReady(me.db, { now: T0 + 10, emit: me.emit });
  await sync(me, peer);
  for (const c of [me, peer]) {
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await incubating(c.db), [], "precondition: the only shelf egg is locked, so the hatch left the slot empty");
  }
  return { me, peer, tradeId: p.trade.trade_id };
}

for (const order of ORDERS) {
  test(`MULTI-INSTANCE (counters ${order}): a completed swap (proposer side) incubates the incoming egg on both Crows`, async () => {
    const { me, peer, tradeId } = await proposerPair(order);
    const friend = await freshDb();
    await receiveTrade(friend, asParsed(await pop(me.db)), { fromCrowId: ME, now: T0 + 20 });
    await put(friend, "theirs", "shelf", T0 - 9000, { origin: "user", warmth: 15 });
    assert.equal((await acceptSwap(friend, { tradeId, eggId: "theirs", now: T0 + 30 })).ok, true);
    const accepted = asParsed(await pop(friend));

    // The friend's 'accepted' DM reaches BOTH of the user's Crows.
    const r = await receiveTrade(me.db, accepted, { fromCrowId: FRIEND, now: T0 + 40, emit: me.emit });
    await receiveTrade(peer.db, accepted, { fromCrowId: FRIEND, now: T0 + 41, emit: peer.emit });
    assert.equal(r.state, "completed");
    for (const c of [me, peer]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await egg(c.db, "mine")).status, "gifted", "the hand-over happened");
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await incubating(c.db), ["theirs"], "the egg that came in went straight into the empty slot");
    }
    await sync(me, peer);
    assert.deepEqual(await snapshot(peer.db), await snapshot(me.db));
    assert.deepEqual(await incubating(me.db), ["theirs"]);
    assert.equal(await tradeState(peer.db, tradeId), "completed");
  });

  test(`MULTI-INSTANCE (counters ${order}): a completed swap (acceptor side) incubates the incoming egg on both Crows`, async () => {
    const me = crow(await freshDb(), order[0]);
    const peer = crow(await freshDb(), order[1]);
    const friend = await freshDb();
    for (const c of [me, peer]) {
      await put(c.db, "mine", "shelf", T0 - 3000, { origin: "user" });
      await put(c.db, "warming", "incubating", T0 - 2000, { warmth: 100 });
    }
    await put(friend, "theirs", "shelf", T0 - 9000, { origin: "user", warmth: 15 });
    const p = await proposeSwap(friend, { eggId: "theirs", toCrowId: ME, now: T0 });
    const proposed = asParsed(await pop(friend));
    await receiveTrade(me.db, proposed, { fromCrowId: FRIEND, now: T0 + 5, emit: me.emit });
    await receiveTrade(peer.db, proposed, { fromCrowId: FRIEND, now: T0 + 6, emit: peer.emit });
    await sync(me, peer);
    assert.equal((await acceptSwap(me.db, { tradeId: p.trade.trade_id, eggId: "mine", now: T0 + 10, emit: me.emit })).ok, true);
    await hatchIfReady(me.db, { now: T0 + 11, emit: me.emit });
    await sync(me, peer);
    for (const c of [me, peer]) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await incubating(c.db), [], "precondition: the accepted egg is locked, the slot is empty");
    }

    await receiveTrade(friend, asParsed(await pop(me.db)), { fromCrowId: ME, now: T0 + 20 });
    const completed = asParsed(await pop(friend));
    const r = await receiveTrade(me.db, completed, { fromCrowId: FRIEND, now: T0 + 30, emit: me.emit });
    await receiveTrade(peer.db, completed, { fromCrowId: FRIEND, now: T0 + 31, emit: peer.emit });
    assert.equal(r.state, "completed");
    await sync(me, peer);
    for (const c of [me, peer]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await egg(c.db, "mine")).status, "gifted");
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await incubating(c.db), ["theirs"]);
    }
    assert.deepEqual(await snapshot(peer.db), await snapshot(me.db));
  });

  /* ------------------------------------------------------- declined swaps */

  test(`MULTI-INSTANCE (counters ${order}): a DECLINED swap frees the locked egg straight into the empty slot, on both Crows`, async () => {
    const { me, peer, tradeId } = await proposerPair(order);
    await pop(me.db); // the proposal went out
    const declined = { trade_id: tradeId, state: "declined", my_egg_id: null, want_egg_id: null, egg: null };
    const r = await receiveTrade(me.db, declined, { fromCrowId: FRIEND, now: T0 + 50, emit: me.emit });
    await receiveTrade(peer.db, declined, { fromCrowId: FRIEND, now: T0 + 51, emit: peer.emit });
    assert.equal(r.state, "declined");
    await sync(me, peer);
    for (const c of [me, peer]) {
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await incubating(c.db), ["mine"], "the egg is no longer promised, so it warms");
    }
    assert.deepEqual(await snapshot(peer.db), await snapshot(me.db));

    // Why this is safe: a declined row can never complete. A late 'accepted'
    // copy hits the declined early-return — no hand-over, no second egg.
    const late = await receiveTrade(me.db, {
      trade_id: tradeId, state: "accepted", my_egg_id: "theirs", want_egg_id: "mine",
      egg: { egg_id: "theirs", warmth: 0, found_cell: null, found_week: null },
    }, { fromCrowId: FRIEND, now: T0 + 60 });
    assert.equal(late.changed, false);
    assert.equal(await egg(me.db, "theirs"), null, "no free egg");
  });
}

test("withdrawing our own proposal frees the egg into the empty slot", async () => {
  const { me, tradeId } = await proposerPair(ORDERS[0]);
  await pop(me.db);
  assert.equal((await declineSwap(me.db, { tradeId, now: T0 + 50, emit: me.emit })).ok, true);
  assert.deepEqual(await incubating(me.db), ["mine"]);
});

test("the 'cannot honour' reply (an accept that reaches an expired proposal) frees the egg into the empty slot", async () => {
  const { me, tradeId } = await proposerPair(ORDERS[0]);
  await pop(me.db);
  await expireTrades(me.db, T0 + TRADE_TTL_MS + 1);
  assert.deepEqual(await incubating(me.db), [], "expiry alone does not promote");
  const r = await receiveTrade(me.db, {
    trade_id: tradeId, state: "accepted", my_egg_id: "theirs", want_egg_id: "mine",
    egg: { egg_id: "theirs", warmth: 0, found_cell: null, found_week: null },
  }, { fromCrowId: FRIEND, now: T0 + TRADE_TTL_MS + 5 });
  assert.equal(r.state, "declined");
  assert.deepEqual(await incubating(me.db), ["mine"]);
  assert.equal(await egg(me.db, "theirs"), null);
});

/* --------------------------------------------------------- lapsed swaps */

/**
 * The user accepts the friend's offer with `mine` (their only shelf egg) while
 * `warming` fills the slot; `warming` hatches, so the slot is empty and `mine`
 * is locked. The friend completes on their side, but the user's row expires
 * before the `completed` envelope arrives. Returns that envelope, undelivered.
 */
async function lapsedAcceptor() {
  const me = await freshDb();
  const friend = await freshDb();
  await put(friend, "theirs", "shelf", T0 - 9000, { origin: "user", warmth: 15 });
  const p = await proposeSwap(friend, { eggId: "theirs", toCrowId: ME, now: T0 });
  await receiveTrade(me, asParsed(await pop(friend)), { fromCrowId: FRIEND, now: T0 + 5 });
  await put(me, "mine", "shelf", T0 - 3000, { origin: "user" });
  await put(me, "warming", "incubating", T0 - 2000, { warmth: 100 });
  await acceptSwap(me, { tradeId: p.trade.trade_id, eggId: "mine", now: T0 + 10 });
  await hatchIfReady(me, { now: T0 + 11 });
  await receiveTrade(friend, asParsed(await pop(me)), { fromCrowId: ME, now: T0 + 20 });
  const completed = asParsed(await pop(friend));
  await expireTrades(me, T0 + TRADE_TTL_MS + 100);
  return { me, friend, completed };
}

test("LAPSED: expireTrades does not promote; the egg waits and the Warm it card offers it", async () => {
  const { me } = await lapsedAcceptor();
  assert.deepEqual(await incubating(me), [], "expireTrades is left alone (Kevin, 2026-09-22)");
  assert.equal((await nextPromotable(me)).egg_id, "mine", "the pet card's Warm it offers exactly this egg");
});

test("LAPSED, nothing in between: a late 'completed' hands over exactly ONE egg and then incubates it", async () => {
  const { me, completed } = await lapsedAcceptor();
  const r = await receiveTrade(me, completed, { fromCrowId: FRIEND, now: T0 + TRADE_TTL_MS + 200 });
  assert.equal(r.state, "completed");
  assert.equal((await egg(me, "mine")).status, "gifted", "the user's egg left");
  assert.deepEqual(await incubating(me), ["theirs"], "and the one that came in warms");
  assert.equal(await held(me), 1, "exactly one egg, never both");
});

test("I-1 REGRESSION: a lapsed egg drafted by a LATER gift is still handed over by the late 'completed' — never both eggs", async () => {
  // Reviewer repro R1 (fix round 1). The expired row no longer locks `mine`,
  // so an unrelated gift's promote drafts it into the slot. The hand-over
  // UPDATE used to match only 'shelf'/'received', so it missed the now-
  // incubating egg while the incoming egg still landed: the user kept `mine`
  // AND `theirs`, and the friend held `mine` too.
  const { me, friend, completed } = await lapsedAcceptor();
  await receiveGift(me, { egg_id: "gift-x", warmth: 0 }, { fromCrowId: "crow:other", now: T0 + TRADE_TTL_MS + 150 });
  assert.deepEqual(await incubating(me), ["mine"], "precondition: the gift's promote drafted the lapsed egg");

  const r = await receiveTrade(me, completed, { fromCrowId: FRIEND, now: T0 + TRADE_TTL_MS + 200 });
  assert.equal(r.state, "completed");
  assert.equal((await egg(me, "mine")).status, "gifted", "the promised egg leaves, wherever it was");
  assert.equal((await egg(friend, "mine")).status, "incubating", "and the friend has it");
  assert.equal(await held(me), 2, "gift-x and theirs — not mine as well");
  assert.equal((await incubating(me)).length, 1, "and the slot was refilled");
});

test("I-1 REGRESSION: the same holds when the user drafted the lapsed egg themselves with Warm it", async () => {
  const { me, completed } = await lapsedAcceptor();
  assert.equal((await incubateEgg(me, "mine", { now: T0 + TRADE_TTL_MS + 150 })).ok, true);
  await receiveTrade(me, completed, { fromCrowId: FRIEND, now: T0 + TRADE_TTL_MS + 200 });
  assert.equal((await egg(me, "mine")).status, "gifted");
  assert.deepEqual(await incubating(me), ["theirs"]);
  assert.equal(await held(me), 1);
});

/* -------------------------------------------------------------- sync apply */

test("SYNC APPLY: a replicated gift never promotes on the peer by itself — the receiving Crow's promote does", async () => {
  // Isolates the apply door: B is handed ONLY the gift's insert. The apply
  // must leave it received — `RAMBLE_EGG_REPROMOTE_SQL` drafts 'sync' eggs
  // only — because a non-emitting promote here could pick a different egg
  // than the receiving Crow did, and nothing would ever reconcile the two.
  const { b } = await twoEgglessCrows(ORDERS[0]);
  await applyRemoteOp(b.db, "ramble_eggs", "insert", {
    egg_id: "gift-5", status: "received", shelf_origin: "user", warmth: 25, from_crow_id: FRIEND, created_at: T0,
  }, 500);
  assert.deepEqual(await incubating(b.db), []);
  assert.equal((await egg(b.db, "gift-5")).status, "received");
  await applyRemoteOp(b.db, "ramble_eggs", "update", {
    egg_id: "gift-5", status: "incubating", shelf_origin: null, warmth: 25, from_crow_id: FRIEND, created_at: T0,
  }, 501);
  assert.deepEqual(await incubating(b.db), ["gift-5"]);
});
