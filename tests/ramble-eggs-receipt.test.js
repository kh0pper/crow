/**
 * Spec 2026-09-08 §4.2 — "the user is therefore only ever eggless when they
 * genuinely have none." Promote-on-gift-receipt (Kevin, 2026-09-22: the
 * branch's "wait on the shelf" deviation was rejected).
 *
 * Every test here that involves the user's own fleet is MULTI-INSTANCE: the
 * receiving Crow's emits are replayed into a second Crow through the real
 * sync apply door (`applyRemoteOp`), because a promote that is right on one
 * database and wrong after replication is the failure this project has
 * already paid for once.
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
 *   4. a swap LAPSES (expireTrades)   -> NOT promoted (Kevin: leave it). A
 *                                        late `completed` can still arrive for
 *                                        an expired row; promoting there hands
 *                                        the user BOTH eggs. The egg waits and
 *                                        the pet card offers Warm it.
 *   5. a NEST is claimed              -> promoted (nothing is in flight; not a
 *                                        gift, but the same §4.2 promise)
 *
 * And the sync-apply path: an apply NEVER promotes a user/received egg. The
 * Crow whose own write changed the slot promotes and emits; the peer receives
 * the result. The one case that leaves a slot empty on purpose is a true
 * cross-instance race (a hatch on one Crow while a gift lands on another in
 * the same sync window) — it converges to the SAME state on both Crows, with
 * the gift offered by Warm it, rather than to a divergent slot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRemoteOp } from "../servers/sharing/instance-sync.js";
import { hatchIfReady, nextPromotable, isoWeek } from "../bundles/ramble/server/eggs.js";
import { claimNest } from "../bundles/ramble/server/flock.js";
import { nestFor, CELL7_LAT_STEP } from "../bundles/ramble/server/nests.js";
import { encodeGeohash } from "../bundles/ramble/server/anchors.js";
import { pendingDeliveries, deleteDelivery } from "../bundles/ramble/server/delivery.js";
import {
  receiveEnvelope, receiveGift, proposeSwap, acceptSwap, declineSwap, receiveTrade, expireTrades, TRADE_TTL_MS,
} from "../bundles/ramble/server/trades.js";

const T0 = Date.UTC(2026, 9, 2, 12);
const FRIEND = "crow:friend";
const ME = "crow:me";

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
async function snapshot(db) {
  return (await db.execute("SELECT egg_id, status, shelf_origin FROM ramble_eggs ORDER BY egg_id")).rows
    .map((r) => [r.egg_id, r.status, r.shelf_origin ?? null]);
}

/** Captures a Crow's emits as full rows, for replay into a peer through the real apply door. */
function wire() {
  const ops = [];
  return { ops, emit: async (table, op, row) => { ops.push([table, op, { ...row }]); } };
}
let lamport = 1000;
async function replay(ops, peer) {
  for (const [table, op, row] of ops) {
    const { lamport_ts: _ignored, ...r } = row;
    // eslint-disable-next-line no-await-in-loop
    await applyRemoteOp(peer, table, op, r, ++lamport);
  }
}
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

/** Two of the user's Crows in the same converged state: a hatched bird, an empty slot. */
async function twoEgglessCrows() {
  const a = await freshDb();
  const b = await freshDb();
  for (const db of [a, b]) await put(db, "bird", "hatched", T0 - 86400e3);
  return { a, b };
}

/* ------------------------------------------------------------------ gifts */

test("MULTI-INSTANCE: a gift arriving at an empty slot is incubated, and the user's other Crow agrees", async () => {
  const { a, b } = await twoEgglessCrows();
  const w = wire();
  const r = await receiveEnvelope(a, { crowId: FRIEND, payload: giftEnvelope("gift-1") }, { now: T0, emit: w.emit });
  assert.equal(r.inserted, true);

  assert.deepEqual(await incubating(a), ["gift-1"], "spec §4.2: the slot refills when an egg arrives, not only on a hatch");
  assert.equal((await egg(a, "gift-1")).shelf_origin, null, "a deliberate promote carries no shelf origin");
  assert.equal((await egg(a, "gift-1")).from_crow_id, FRIEND, "it is still a gift from the friend");
  assert.equal((await egg(a, "gift-1")).warmth, 25, "the warmth the friend put in travels with it");

  await replay(w.ops, b);
  assert.deepEqual(await incubating(b), ["gift-1"], "the promote replicated: the peer did not have to re-derive it");
  assert.deepEqual(await snapshot(b), await snapshot(a), "both Crows hold the same eggs in the same places");
});

test("MULTI-INSTANCE: every Crow hears the same gift DM (one shared identity); both promote it and their emits agree", async () => {
  // servers/sharing/nostr.js: all of a user's Crows share one Nostr identity,
  // so one DM is decrypted and applied by EVERY instance, each at its own
  // clock. Both promote; the promote picks by replicated rows, so both pick
  // the same egg, and replaying each one's emits into the other changes
  // nothing — no contest for the slot, no 'sync'-relabelled loser.
  const { a, b } = await twoEgglessCrows();
  const wa = wire();
  const wb = wire();
  await receiveEnvelope(a, { crowId: FRIEND, payload: giftEnvelope("gift-both") }, { now: T0, emit: wa.emit });
  await receiveEnvelope(b, { crowId: FRIEND, payload: giftEnvelope("gift-both") }, { now: T0 + 700, emit: wb.emit });
  await replay(wa.ops, b);
  await replay(wb.ops, a);
  for (const db of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await incubating(db), ["gift-both"]);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await egg(db, "gift-both")).shelf_origin, null, "never relabelled 'sync' by a convergence demotion");
  }
  assert.deepEqual(await snapshot(a), await snapshot(b));
});

test("a gift arriving while an egg is already warming waits on the shelf — it never displaces it", async () => {
  const db = await freshDb();
  await put(db, "warming", "incubating", T0 - 1000, { warmth: 40 });
  await receiveGift(db, giftEnvelope("gift-2").egg, { fromCrowId: FRIEND, now: T0 });
  assert.deepEqual(await incubating(db), ["warming"]);
  assert.equal((await egg(db, "gift-2")).status, "received");
});

test("re-delivery of a gift that was already promoted is a no-op (no second promote, no emit)", async () => {
  const db = await freshDb();
  await receiveGift(db, giftEnvelope("gift-3").egg, { fromCrowId: FRIEND, now: T0 });
  const w = wire();
  const again = await receiveGift(db, giftEnvelope("gift-3").egg, { fromCrowId: FRIEND, now: T0 + 5, emit: w.emit });
  assert.equal(again.inserted, false);
  assert.deepEqual(w.ops, [], "nothing changed, so nothing replicates");
  assert.deepEqual(await incubating(db), ["gift-3"]);
});

test("the promote follows the ONE shelf rule: with an older egg already waiting, the older one goes in", async () => {
  // An empty slot beside an unlocked shelf egg only exists after a lapsed swap
  // or a cross-instance race (see below). When a gift then arrives, the
  // promote does not special-case the gift: nextPromotable decides, exactly
  // as it does for a hatch and for the panel's Warm it card.
  const db = await freshDb();
  await put(db, "older", "shelf", T0 - 5000, { origin: "user" });
  await receiveGift(db, giftEnvelope("gift-4").egg, { fromCrowId: FRIEND, now: T0 });
  assert.deepEqual(await incubating(db), ["older"]);
  assert.equal((await egg(db, "gift-4")).status, "received");
});

test("the daily per-contact gift ceiling still counts a gift that was promoted out of 'received'", async () => {
  const db = await freshDb();
  // 20 gifts in one day: the first is promoted to incubating, 19 stay received.
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await receiveGift(db, giftEnvelope(`flood-${i}`).egg, { fromCrowId: FRIEND, now: T0 + i });
    assert.equal(r.inserted, true, `gift ${i}`);
  }
  assert.deepEqual(await incubating(db), ["flood-0"]);
  const over = await receiveGift(db, giftEnvelope("flood-20").egg, { fromCrowId: FRIEND, now: T0 + 30 });
  assert.equal(over.reason, "capped", "promoting one must not open a 21st slot in the ceiling");
});

/* ------------------------------------------------------------------ nests */

test("MULTI-INSTANCE: an egg claimed from a nest with the slot empty warms at once, on both Crows", async () => {
  // Not a gift, but the same §4.2 promise and the commonest way back from
  // eggless: walk to a nest. Replayed through the apply door, the claim's
  // 'user' shelf insert is a user shelve (no sync re-promote), and the
  // promote op that follows lands the egg in the peer's slot.
  const { a, b } = await twoEgglessCrows();
  const week = isoWeek(T0);
  let cell = null;
  for (let i = 0; i < 5000 && !cell; i += 1) {
    const c = encodeGeohash(30.46 + i * CELL7_LAT_STEP, -98.08, 7);
    if (nestFor(c, week)) cell = c;
  }
  const nest = nestFor(cell, week);
  const w = wire();
  const r = await claimNest(a, { cell, week, here: { lat: nest.lat, lon: nest.lon }, now: T0, emit: w.emit });
  assert.equal(r.claimed, true);
  assert.deepEqual(await incubating(a), [r.egg.egg_id]);
  await replay(w.ops, b);
  assert.deepEqual(await incubating(b), [r.egg.egg_id]);
  assert.deepEqual(await snapshot(b), await snapshot(a));
});

/* ------------------------------------------------------------------ swaps */

/**
 * The user proposes their only shelf egg while another egg warms; that egg
 * then hatches, so the slot is empty and the shelf egg is locked. This is the
 * natural way a swap's hand-over reaches an empty slot.
 */
async function proposerWithEmptySlot(me, w) {
  await put(me, "mine", "shelf", T0 - 3000, { origin: "user" });
  await put(me, "warming", "incubating", T0 - 2000, { warmth: 100 });
  const p = await proposeSwap(me, { eggId: "mine", toCrowId: FRIEND, now: T0, emit: w.emit });
  assert.equal(p.ok, true);
  await hatchIfReady(me, { now: T0 + 10, emit: w.emit });
  assert.deepEqual(await incubating(me), [], "precondition: the only shelf egg is locked, so the hatch left the slot empty");
  return p.trade.trade_id;
}

test("MULTI-INSTANCE: a completed swap (proposer side) incubates the egg that came in, on both Crows", async () => {
  const me = await freshDb();
  const peer = await freshDb();
  const friend = await freshDb();
  const w = wire();
  const tradeId = await proposerWithEmptySlot(me, w);
  await replay(w.ops, peer);
  w.ops.length = 0;

  // The friend receives the proposal and answers with their egg.
  const proposed = await pop(me);
  await receiveTrade(friend, { ...proposed.trade, egg: proposed.egg }, { fromCrowId: ME, now: T0 + 20 });
  await put(friend, "theirs", "shelf", T0 - 9000, { origin: "user", warmth: 15 });
  assert.equal((await acceptSwap(friend, { tradeId, eggId: "theirs", now: T0 + 30 })).ok, true);
  const accepted = await pop(friend);

  const r = await receiveTrade(me, { ...accepted.trade, egg: accepted.egg }, { fromCrowId: FRIEND, now: T0 + 40, emit: w.emit });
  assert.equal(r.state, "completed");
  assert.equal((await egg(me, "mine")).status, "gifted", "the hand-over happened");
  assert.deepEqual(await incubating(me), ["theirs"], "the egg that came in went straight into the empty slot");

  await replay(w.ops, peer);
  assert.deepEqual(await incubating(peer), ["theirs"]);
  assert.deepEqual(await snapshot(peer), await snapshot(me));
});

test("MULTI-INSTANCE: a completed swap (acceptor side) incubates the egg that came in, on both Crows", async () => {
  const me = await freshDb();
  const peer = await freshDb();
  const friend = await freshDb();
  const w = wire();

  // The friend proposes; the user accepts with their only shelf egg while another warms.
  await put(friend, "theirs", "shelf", T0 - 9000, { origin: "user", warmth: 15 });
  const p = await proposeSwap(friend, { eggId: "theirs", toCrowId: ME, now: T0 });
  const proposed = await pop(friend);
  await receiveTrade(me, { ...proposed.trade, egg: proposed.egg }, { fromCrowId: FRIEND, now: T0 + 5, emit: w.emit });
  await put(me, "mine", "shelf", T0 - 3000, { origin: "user" });
  await put(me, "warming", "incubating", T0 - 2000, { warmth: 100 });
  assert.equal((await acceptSwap(me, { tradeId: p.trade.trade_id, eggId: "mine", now: T0 + 10, emit: w.emit })).ok, true);
  await hatchIfReady(me, { now: T0 + 11, emit: w.emit });
  assert.deepEqual(await incubating(me), [], "precondition: the accepted egg is locked, the slot is empty");
  await replay(w.ops, peer);
  w.ops.length = 0;

  const accepted = await pop(me);
  await receiveTrade(friend, { ...accepted.trade, egg: accepted.egg }, { fromCrowId: ME, now: T0 + 20 });
  const completed = await pop(friend);
  const r = await receiveTrade(me, { ...completed.trade, egg: completed.egg }, { fromCrowId: FRIEND, now: T0 + 30, emit: w.emit });
  assert.equal(r.state, "completed");
  assert.equal((await egg(me, "mine")).status, "gifted");
  assert.deepEqual(await incubating(me), ["theirs"]);

  await replay(w.ops, peer);
  assert.deepEqual(await incubating(peer), ["theirs"]);
  assert.deepEqual(await snapshot(peer), await snapshot(me));
});

/* ------------------------------------------------------- declined swaps */

test("MULTI-INSTANCE: a DECLINED swap frees the locked egg straight into the empty slot", async () => {
  const me = await freshDb();
  const peer = await freshDb();
  const w = wire();
  const tradeId = await proposerWithEmptySlot(me, w);
  await replay(w.ops, peer);
  w.ops.length = 0;
  await pop(me); // the proposal went out

  const r = await receiveTrade(me, { trade_id: tradeId, state: "declined", my_egg_id: null, want_egg_id: null, egg: null }, { fromCrowId: FRIEND, now: T0 + 50, emit: w.emit });
  assert.equal(r.state, "declined");
  assert.deepEqual(await incubating(me), ["mine"], "the egg is no longer promised, so it warms");

  await replay(w.ops, peer);
  assert.deepEqual(await incubating(peer), ["mine"]);

  // Why this is safe where expiry is not: a declined row can never complete.
  // A late 'accepted' copy hits the declined early-return — no hand-over, no
  // second egg.
  const late = await receiveTrade(me, {
    trade_id: tradeId, state: "accepted", my_egg_id: "theirs", want_egg_id: "mine",
    egg: { egg_id: "theirs", warmth: 0, found_cell: null, found_week: null },
  }, { fromCrowId: FRIEND, now: T0 + 60 });
  assert.equal(late.changed, false);
  assert.equal(await egg(me, "theirs"), null, "no free egg");
  assert.deepEqual(await incubating(me), ["mine"]);
});

test("withdrawing our own proposal frees the egg into the empty slot", async () => {
  const me = await freshDb();
  const w = wire();
  const tradeId = await proposerWithEmptySlot(me, w);
  await pop(me);
  assert.equal((await declineSwap(me, { tradeId, now: T0 + 50 })).ok, true);
  assert.deepEqual(await incubating(me), ["mine"]);
});

test("the 'cannot honour' reply (an accept that reaches an expired proposal) frees the egg into the empty slot", async () => {
  const me = await freshDb();
  const w = wire();
  const tradeId = await proposerWithEmptySlot(me, w);
  await pop(me);
  // The proposal lapses; expiry alone does NOT promote (next test).
  await expireTrades(me, T0 + TRADE_TTL_MS + 1);
  assert.deepEqual(await incubating(me), []);
  // The friend's late accept is refused and the row becomes 'declined', which
  // can never complete — so the egg may now warm.
  const r = await receiveTrade(me, {
    trade_id: tradeId, state: "accepted", my_egg_id: "theirs", want_egg_id: "mine",
    egg: { egg_id: "theirs", warmth: 0, found_cell: null, found_week: null },
  }, { fromCrowId: FRIEND, now: T0 + TRADE_TTL_MS + 5 });
  assert.equal(r.state, "declined");
  assert.deepEqual(await incubating(me), ["mine"]);
  assert.equal(await egg(me, "theirs"), null);
});

/* --------------------------------------------------------- lapsed swaps */

test("LAPSED: expireTrades does not promote; the egg waits and the Warm it card offers it", async () => {
  const me = await freshDb();
  const w = wire();
  await proposerWithEmptySlot(me, w);
  const swept = await expireTrades(me, T0 + TRADE_TTL_MS + 1);
  assert.equal(swept, 1);
  assert.deepEqual(await incubating(me), [], "expireTrades is left alone (Kevin, 2026-09-22)");
  assert.equal((await nextPromotable(me)).egg_id, "mine", "the pet card's Warm it offers exactly this egg");
});

test("LAPSED, acceptor side: a late 'completed' after expiry hands over exactly ONE egg and then incubates it", async () => {
  // The race that keeps expireTrades out of the promote: had expiry promoted
  // 'mine' into the slot, the hand-over's `WHERE status IN ('shelf','received')`
  // would miss it while the received egg still landed — the user would keep
  // both. Promoting AFTER the hand-over batch has no such window.
  const me = await freshDb();
  const friend = await freshDb();
  await put(friend, "theirs", "shelf", T0 - 9000, { origin: "user", warmth: 15 });
  const p = await proposeSwap(friend, { eggId: "theirs", toCrowId: ME, now: T0 });
  const proposed = await pop(friend);
  await receiveTrade(me, { ...proposed.trade, egg: proposed.egg }, { fromCrowId: FRIEND, now: T0 + 5 });
  await put(me, "mine", "shelf", T0 - 3000, { origin: "user" });
  await put(me, "warming", "incubating", T0 - 2000, { warmth: 100 });
  await acceptSwap(me, { tradeId: p.trade.trade_id, eggId: "mine", now: T0 + 10 });
  await hatchIfReady(me, { now: T0 + 11 });
  const accepted = await pop(me);
  await receiveTrade(friend, { ...accepted.trade, egg: accepted.egg }, { fromCrowId: ME, now: T0 + 20 });
  const completed = await pop(friend);

  await expireTrades(me, T0 + TRADE_TTL_MS + 100);
  assert.deepEqual(await incubating(me), [], "expiry did not promote 'mine'");

  const r = await receiveTrade(me, { ...completed.trade, egg: completed.egg }, { fromCrowId: FRIEND, now: T0 + TRADE_TTL_MS + 200 });
  assert.equal(r.state, "completed");
  assert.equal((await egg(me, "mine")).status, "gifted", "the user's egg left");
  assert.deepEqual(await incubating(me), ["theirs"], "and the one that came in warms");
  const held = (await me.execute("SELECT count(*) AS n FROM ramble_eggs WHERE status IN ('incubating','shelf','received')")).rows[0].n;
  assert.equal(Number(held), 1, "exactly one egg, never both");
});

/* -------------------------------------------------------------- sync apply */

test("SYNC APPLY: a replicated gift never promotes on the peer by itself — the receiving Crow's promote does", async () => {
  // Isolates the apply door: B is handed ONLY the gift's insert (as if the
  // receiving Crow's promote op had not arrived yet). The apply must leave it
  // received — `RAMBLE_EGG_REPROMOTE_SQL` drafts 'sync' eggs only — because a
  // non-emitting promote here could pick a different egg than the receiving
  // Crow did, and nothing would ever reconcile the two.
  const b = (await twoEgglessCrows()).b;
  await applyRemoteOp(b, "ramble_eggs", "insert", {
    egg_id: "gift-5", status: "received", shelf_origin: "user", warmth: 25, from_crow_id: FRIEND, created_at: T0,
  }, ++lamport);
  assert.deepEqual(await incubating(b), []);
  assert.equal((await egg(b, "gift-5")).status, "received");
  // ...and the promote op that follows in the same drain lands it.
  await applyRemoteOp(b, "ramble_eggs", "update", {
    egg_id: "gift-5", status: "incubating", shelf_origin: null, warmth: 25, from_crow_id: FRIEND, created_at: T0,
  }, ++lamport);
  assert.deepEqual(await incubating(b), ["gift-5"]);
});

test("SYNC APPLY RACE: a hatch on one Crow and a gift on the other in the same window converge to the SAME state", async () => {
  // A still has `warming` in its slot when the gift lands, so the gift is
  // correctly left on A's shelf; at the same moment B hatches `warming` with
  // nothing on its shelf. Neither write saw an empty slot beside an egg, so
  // neither promoted. After the ops cross, both Crows must agree exactly:
  // slot empty, gift waiting, Warm it offering it — never one Crow
  // incubating it and the other not.
  const a = await freshDb();
  const b = await freshDb();
  for (const db of [a, b]) await put(db, "warming", "incubating", T0 - 2000, { warmth: 100 });
  const wa = wire();
  const wb = wire();
  await receiveGift(a, giftEnvelope("gift-6").egg, { fromCrowId: FRIEND, now: T0, emit: wa.emit });
  await hatchIfReady(b, { now: T0, emit: wb.emit });
  assert.equal((await egg(a, "gift-6")).status, "received", "A's slot was full when the gift landed");

  await replay(wb.ops, a);
  await replay(wa.ops, b);
  assert.deepEqual(await snapshot(a), await snapshot(b), "converged");
  assert.deepEqual(await incubating(a), []);
  assert.equal((await nextPromotable(a)).egg_id, "gift-6");
  assert.equal((await nextPromotable(b)).egg_id, "gift-6", "both pet cards offer the same egg");
});
