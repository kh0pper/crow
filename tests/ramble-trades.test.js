/**
 * Phase 3 — trades.js: gifts, the swap state machine (two dbs, envelopes
 * passed by hand exactly as the transport would), locks, expiry, and the
 * inbound envelope router. No Nostr, no HTTP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { ensureIncubatingEgg } from "../bundles/ramble/server/eggs.js";
import { pendingDeliveries, deleteDelivery } from "../bundles/ramble/server/delivery.js";
import {
  TRADE_TTL_MS, giftEgg, receiveGift, proposeSwap, acceptSwap, declineSwap, receiveTrade, expireTrades,
  listTrades, lockedEggIds, isEggLocked, receiveEnvelope,
} from "../bundles/ramble/server/trades.js";

const T0 = Date.UTC(2026, 8, 7, 12);
const PK = "ab".repeat(32);

async function freshDb() { const c = createClient({ url: "file::memory:" }); await initRambleTables(c); return c; }
async function shelf(db, eggId, warmth = 10, extra = "") {
  await db.execute({ sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at) VALUES (?, 'shelf', 'user', ?, '9v6m21h', '2026-W37', ?)`, args: [eggId, warmth, T0] });
}
async function egg(db, id) { return (await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [id] })).rows[0] ?? null; }
async function trade(db, id) { return (await db.execute({ sql: "SELECT * FROM ramble_trades WHERE trade_id = ?", args: [id] })).rows[0] ?? null; }
/** Pop the one queued delivery and return its parsed payload (what the transport would send). */
async function popDelivery(db) {
  const rows = await pendingDeliveries(db, 50);
  assert.equal(rows.length, 1, `expected exactly one queued delivery, found ${rows.length}`);
  await deleteDelivery(db, rows[0].id);
  return { to: rows[0].to_crow_id, kind: rows[0].kind, payload: JSON.parse(rows[0].payload_json) };
}
const emitter = () => { const calls = []; return { calls, emit: async (t, op, row) => calls.push([t, op, row.egg_id ?? row.trade_id, row.status ?? row.state]) }; };

test("giftEgg: shelf/received only, egg leaves as 'gifted', one queued ramble.egg without species/seed", async () => {
  const db = await freshDb();
  await shelf(db, "g1", 30);
  await ensureIncubatingEgg(db, { now: T0 });
  assert.deepEqual(await giftEgg(db, { eggId: "g1", toCrowId: "bad id", now: T0 }), { ok: false, reason: "bad-recipient" });
  assert.equal((await egg(db, "g1")).status, "shelf", "a bad recipient never touches the egg");
  const { calls, emit } = emitter();
  const r = await giftEgg(db, { eggId: "g1", toCrowId: "crow:friend", now: T0, emit });
  assert.equal(r.ok, true); assert.equal(r.egg.status, "gifted"); assert.equal(r.egg.shelf_origin, "user");
  assert.deepEqual(calls, [["ramble_eggs", "update", "g1", "gifted"]]);
  const d = await popDelivery(db);
  assert.equal(d.to, "crow:friend"); assert.equal(d.kind, "egg");
  assert.deepEqual(d.payload, { type: "ramble.egg", v: 1, egg: { egg_id: "g1", warmth: 30, found_cell: "9v6m21h", found_week: "2026-W37" } });
  assert.deepEqual(await giftEgg(db, { eggId: "g1", toCrowId: "crow:friend", now: T0 }), { ok: false, reason: "not-an-egg" }, "already gone");
  assert.deepEqual(await giftEgg(db, { eggId: "nope", toCrowId: "crow:friend", now: T0 }), { ok: false, reason: "not-found" });
  const inc = (await db.execute("SELECT egg_id FROM ramble_eggs WHERE status='incubating'")).rows[0].egg_id;
  assert.deepEqual(await giftEgg(db, { eggId: inc, toCrowId: "crow:friend", now: T0 }), { ok: false, reason: "not-an-egg" }, "the incubating egg is not giftable — swap it out first");
});

test("receiveGift: lands as received/user with from_crow_id; re-delivery is a no-op; an egg gifted away comes back revived", async () => {
  const db = await freshDb();
  const { calls, emit } = emitter();
  const r = await receiveGift(db, { egg_id: "in1", warmth: 44, found_cell: "9v6m21h", found_week: "2026-W37", species: "crow", seed: 9 }, { fromCrowId: "crow:friend", now: T0, emit });
  assert.equal(r.inserted, true);
  const row = await egg(db, "in1");
  assert.deepEqual([row.status, row.shelf_origin, row.warmth, row.from_crow_id, row.species, row.seed, row.created_at], ["received", "user", 44, "crow:friend", null, null, T0]);
  assert.deepEqual(calls, [["ramble_eggs", "insert", "in1", "received"]]);
  assert.deepEqual(await receiveGift(db, { egg_id: "in1", warmth: 99 }, { fromCrowId: "crow:friend", now: T0 + 1, emit }), { inserted: false, egg_id: "in1" });
  assert.equal((await egg(db, "in1")).warmth, 44, "a re-delivered gift changes nothing");
  assert.equal(calls.length, 1);
  // Gift it onward, then it comes back: the row revives (created_at untouched).
  assert.equal((await giftEgg(db, { eggId: "in1", toCrowId: "crow:other", now: T0 + 2 })).ok, true);
  const back = await receiveGift(db, { egg_id: "in1", warmth: 50 }, { fromCrowId: "crow:other", now: T0 + 3 });
  assert.equal(back.inserted, true);
  const revived = await egg(db, "in1");
  assert.deepEqual([revived.status, revived.from_crow_id, revived.warmth, revived.created_at], ["received", "crow:other", 50, T0]);
  // A shelf egg of mine that someone claims to 'gift' me is not touched.
  await shelf(db, "mine", 5);
  assert.deepEqual(await receiveGift(db, { egg_id: "mine", warmth: 1 }, { fromCrowId: "crow:x", now: T0 }), { inserted: false, egg_id: "mine" });
  assert.equal((await egg(db, "mine")).status, "shelf");
  assert.deepEqual(await receiveGift(db, { warmth: 1 }, { fromCrowId: "crow:x", now: T0 }), { inserted: false, reason: "malformed" });
  assert.deepEqual(await receiveGift(db, { egg_id: "z", warmth: 1 }, { fromCrowId: "bad id", now: T0 }), { inserted: false, reason: "malformed" });
});

test("a full swap: propose (A) -> accept (B) -> complete (A) -> complete (B); eggs cross exactly once; every envelope is idempotent", async () => {
  const A = await freshDb(); const B = await freshDb();
  await shelf(A, "a-egg", 20); await shelf(B, "b-egg", 60);
  const ea = emitter(); const eb = emitter();

  // A proposes.
  const p = await proposeSwap(A, { eggId: "a-egg", toCrowId: "crow:B", now: T0, emit: ea.emit });
  assert.equal(p.ok, true);
  const tid = p.trade.trade_id;
  assert.deepEqual([p.trade.role, p.trade.state, p.trade.my_egg_id, p.trade.their_egg_id, p.trade.counterpart, p.trade.expires_at], ["proposer", "proposed", "a-egg", null, "crow:B", T0 + TRADE_TTL_MS]);
  assert.equal(await isEggLocked(A, "a-egg"), true);
  assert.deepEqual(await proposeSwap(A, { eggId: "a-egg", toCrowId: "crow:C", now: T0 }), { ok: false, reason: "in-trade" });
  assert.deepEqual(await giftEgg(A, { eggId: "a-egg", toCrowId: "crow:C", now: T0 }), { ok: false, reason: "in-trade" });
  const d1 = await popDelivery(A);
  assert.equal(d1.to, "crow:B");
  assert.deepEqual(d1.payload.trade, { trade_id: tid, state: "proposed", my_egg_id: "a-egg", want_egg_id: null });
  assert.deepEqual(d1.payload.egg, { egg_id: "a-egg", warmth: 20, found_cell: "9v6m21h", found_week: "2026-W37" });

  // B receives the proposal (twice — the second is a no-op).
  const parsedP = { trade_id: tid, state: "proposed", my_egg_id: "a-egg", want_egg_id: null, egg: d1.payload.egg };
  let r = await receiveTrade(B, parsedP, { fromCrowId: "crow:A", now: T0 + 10, emit: eb.emit });
  assert.deepEqual([r.changed, r.state, r.deliveries], [true, "proposed", 0]);
  assert.deepEqual(await receiveTrade(B, parsedP, { fromCrowId: "crow:A", now: T0 + 11, emit: eb.emit }), { changed: false, trade_id: tid, deliveries: 0 });
  let tb = await trade(B, tid);
  assert.deepEqual([tb.role, tb.state, tb.my_egg_id, tb.their_egg_id, tb.counterpart, JSON.parse(tb.offer_json).warmth], ["acceptor", "proposed", null, "a-egg", "crow:A", 20]);
  assert.equal(await egg(B, "a-egg"), null, "nothing changes hands at proposal time");

  // B accepts with b-egg.
  assert.deepEqual(await acceptSwap(B, { tradeId: tid, eggId: "nope", now: T0 + 20 }), { ok: false, reason: "not-an-egg" });
  const acc = await acceptSwap(B, { tradeId: tid, eggId: "b-egg", now: T0 + 20, emit: eb.emit });
  assert.equal(acc.ok, true); assert.equal(acc.trade.state, "accepted"); assert.equal(acc.trade.my_egg_id, "b-egg");
  assert.equal(await isEggLocked(B, "b-egg"), true);
  assert.deepEqual(await acceptSwap(B, { tradeId: tid, eggId: "b-egg", now: T0 + 21 }), { ok: false, reason: "not-open" });
  assert.deepEqual(await declineSwap(B, { tradeId: tid, now: T0 + 21 }), { ok: false, reason: "not-open" }, "no backing out once accepted — the proposer may already be completing");
  const d2 = await popDelivery(B);
  assert.equal(d2.to, "crow:A");
  assert.deepEqual(d2.payload.trade, { trade_id: tid, state: "accepted", my_egg_id: "b-egg", want_egg_id: "a-egg" });
  assert.equal(d2.payload.egg.egg_id, "b-egg");
  assert.equal((await egg(B, "b-egg")).status, "shelf", "still B's until completion");

  // A receives 'accepted': completes on A's side and queues 'completed'.
  const parsedA = { trade_id: tid, state: "accepted", my_egg_id: "b-egg", want_egg_id: "a-egg", egg: d2.payload.egg };
  r = await receiveTrade(A, parsedA, { fromCrowId: "crow:B", now: T0 + 30, emit: ea.emit });
  assert.deepEqual([r.changed, r.state, r.egg_id, r.deliveries], [true, "completed", "b-egg", 1]);
  assert.equal((await egg(A, "a-egg")).status, "gifted");
  const gotB = await egg(A, "b-egg");
  assert.deepEqual([gotB.status, gotB.shelf_origin, gotB.warmth, gotB.from_crow_id], ["received", "user", 60, "crow:B"]);
  assert.deepEqual([(await trade(A, tid)).state, (await trade(A, tid)).their_egg_id], ["completed", "b-egg"]);
  assert.equal(await isEggLocked(A, "a-egg"), false);
  assert.deepEqual(await receiveTrade(A, parsedA, { fromCrowId: "crow:B", now: T0 + 31, emit: ea.emit }), { changed: false, trade_id: tid, deliveries: 0 }, "re-delivered 'accepted' is a no-op");
  const d3 = await popDelivery(A);
  assert.equal(d3.to, "crow:B");
  assert.deepEqual(d3.payload.trade, { trade_id: tid, state: "completed", my_egg_id: "a-egg", want_egg_id: "b-egg" });
  assert.deepEqual(d3.payload.egg, { egg_id: "a-egg", warmth: 20, found_cell: "9v6m21h", found_week: "2026-W37" });

  // B receives 'completed': eggs cross on B's side.
  const parsedC = { trade_id: tid, state: "completed", my_egg_id: "a-egg", want_egg_id: "b-egg", egg: d3.payload.egg };
  r = await receiveTrade(B, parsedC, { fromCrowId: "crow:A", now: T0 + 40, emit: eb.emit });
  assert.deepEqual([r.changed, r.state, r.egg_id, r.deliveries], [true, "completed", "a-egg", 0]);
  assert.equal((await egg(B, "b-egg")).status, "gifted");
  const gotA = await egg(B, "a-egg");
  assert.deepEqual([gotA.status, gotA.shelf_origin, gotA.warmth, gotA.from_crow_id], ["received", "user", 20, "crow:A"]);
  assert.equal((await trade(B, tid)).state, "completed");
  assert.deepEqual(await receiveTrade(B, parsedC, { fromCrowId: "crow:A", now: T0 + 41 }), { changed: false, trade_id: tid, deliveries: 0 });
  assert.equal((await pendingDeliveries(B, 50)).length, 0);

  // Emits: every egg movement and every trade transition rode the sync hook.
  assert.deepEqual(ea.calls, [
    ["ramble_trades", "insert", tid, "proposed"],
    ["ramble_eggs", "update", "a-egg", "gifted"], ["ramble_eggs", "insert", "b-egg", "received"], ["ramble_trades", "update", tid, "completed"],
  ]);
  assert.deepEqual(eb.calls, [
    ["ramble_trades", "insert", tid, "proposed"], ["ramble_trades", "update", tid, "accepted"],
    ["ramble_eggs", "update", "b-egg", "gifted"], ["ramble_eggs", "insert", "a-egg", "received"], ["ramble_trades", "update", tid, "completed"],
  ]);
  // 'expired' never travels: a peer cannot expire our row.
  assert.equal((await receiveTrade(B, { trade_id: tid, state: "expired", my_egg_id: null, want_egg_id: null, egg: null }, { fromCrowId: "crow:A", now: T0 })).changed, false);
  assert.equal((await trade(B, tid)).state, "completed");
  // Wrong counterpart, wrong egg ids, unknown trade: all ignored.
  assert.deepEqual(await receiveTrade(B, { ...parsedC, trade_id: "ghost" }, { fromCrowId: "crow:A", now: T0 }), { changed: false, trade_id: "ghost", deliveries: 0 });
  assert.deepEqual(await receiveTrade(A, parsedA, { fromCrowId: "crow:Z", now: T0 }), { changed: false, trade_id: tid, deliveries: 0 });
});

test("decline: either side while proposed; the counterpart's egg unlocks; an accept after decline is refused", async () => {
  const A = await freshDb(); const B = await freshDb();
  await shelf(A, "a1"); await shelf(B, "b1");
  assert.deepEqual(await proposeSwap(A, { eggId: "a1", toCrowId: "", now: T0 }), { ok: false, reason: "bad-recipient" });
  assert.equal(await isEggLocked(A, "a1"), false, "a bad recipient never locks the egg");
  const p = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 });
  const d1 = await popDelivery(A);
  await receiveTrade(B, { trade_id: p.trade.trade_id, state: "proposed", my_egg_id: "a1", want_egg_id: null, egg: d1.payload.egg }, { fromCrowId: "crow:A", now: T0 });
  const dec = await declineSwap(B, { tradeId: p.trade.trade_id, now: T0 + 5 });
  assert.equal(dec.ok, true); assert.equal(dec.trade.state, "declined");
  const d2 = await popDelivery(B);
  assert.deepEqual(d2.payload, { type: "ramble.trade", v: 1, trade: { trade_id: p.trade.trade_id, state: "declined", my_egg_id: null, want_egg_id: null } });
  const r = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "declined", my_egg_id: null, want_egg_id: null, egg: null }, { fromCrowId: "crow:B", now: T0 + 6 });
  assert.deepEqual([r.changed, r.state], [true, "declined"]);
  assert.equal(await isEggLocked(A, "a1"), false, "a declined offer releases the egg");
  assert.equal((await egg(A, "a1")).status, "shelf");
  assert.deepEqual(await acceptSwap(B, { tradeId: p.trade.trade_id, eggId: "b1", now: T0 + 7 }), { ok: false, reason: "not-open" });
  // The proposer can cancel their own open offer the same way.
  const p2 = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 + 8 });
  await popDelivery(A);
  assert.equal((await declineSwap(A, { tradeId: p2.trade.trade_id, now: T0 + 9 })).trade.state, "declined");
  assert.equal((await popDelivery(A)).payload.trade.state, "declined");
  assert.deepEqual(await declineSwap(A, { tradeId: "ghost", now: T0 }), { ok: false, reason: "not-found" });
  // The RECEIVING side honours a decline even after having accepted (Q2 asymmetry).
  const C = await freshDb();
  await shelf(C, "x", 12);
  await C.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-dec-acc','crow:Z','acceptor','x','y','{}','accepted',?,?,?)", args: [T0, T0, T0 + 999] });
  assert.equal(await isEggLocked(C, "x"), true);
  const rr = await receiveTrade(C, { trade_id: "t-dec-acc", state: "declined", my_egg_id: null, want_egg_id: null, egg: null }, { fromCrowId: "crow:Z", now: T0 + 10 });
  assert.deepEqual([rr.changed, rr.state], [true, "declined"]);
  assert.equal(await isEggLocked(C, "x"), false);
});

test("an 'accepted' that arrives after the offer lapsed (expired or egg gone) is answered with 'declined', not completed", async () => {
  const A = await freshDb();
  await shelf(A, "a1");
  const p = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 });
  await popDelivery(A);
  assert.equal(await expireTrades(A, T0 + TRADE_TTL_MS, {}), 1);
  assert.equal((await trade(A, p.trade.trade_id)).state, "expired");
  assert.equal(await isEggLocked(A, "a1"), false);
  const r = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "b1", want_egg_id: "a1", egg: { egg_id: "b1", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + TRADE_TTL_MS + 1 });
  assert.deepEqual([r.changed, r.state, r.deliveries], [true, "declined", 1], "a lapsed offer answers 'declined' once and settles as declined");
  assert.equal((await egg(A, "a1")).status, "shelf", "nothing changed hands");
  assert.equal(await egg(A, "b1"), null);
  assert.equal((await popDelivery(A)).payload.trade.state, "declined");
  assert.equal(await expireTrades(A, T0 + TRADE_TTL_MS + 5, {}), 0, "already-terminal rows are not re-expired");
  // C2: every further copy of that 'accepted' is a silent no-op — never another DM.
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const again = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "b1", want_egg_id: "a1", egg: { egg_id: "b1", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + TRADE_TTL_MS + 2 + i });
    assert.deepEqual([again.changed, again.deliveries], [false, 0]);
  }
  assert.equal((await pendingDeliveries(A, 50)).length, 0);
});

test("C3: an offer, an acceptance or a completion naming an egg we still hold is ignored (or declined), never a lost egg", async () => {
  const B = await freshDb();
  await shelf(B, "b1", 15);
  await shelf(B, "held", 20);
  // A proposal offering an egg we hold: ignored, no row.
  let r = await receiveTrade(B, { trade_id: "t-held", state: "proposed", my_egg_id: "held", want_egg_id: null, egg: { egg_id: "held", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 });
  assert.equal(r.changed, false);
  assert.equal(await trade(B, "t-held"), null);
  // A completion whose egg is one we hold: ignored, our answer egg stays ours.
  await B.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-c','crow:A','acceptor','b1','held','{}','accepted',?,?,?)", args: [T0, T0, T0 + 999] });
  r = await receiveTrade(B, { trade_id: "t-c", state: "completed", my_egg_id: "held", want_egg_id: "b1", egg: { egg_id: "held", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 + 1 });
  assert.equal(r.changed, false);
  assert.equal((await egg(B, "b1")).status, "shelf");
  assert.equal((await egg(B, "held")).status, "shelf");
  // An acceptance (we proposed) that names an egg we hold: declined reply, our egg untouched.
  const A = await freshDb();
  await shelf(A, "a1"); await shelf(A, "mine-too", 3);
  const p = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 });
  await popDelivery(A);
  r = await receiveTrade(A, { trade_id: p.trade.trade_id, state: "accepted", my_egg_id: "mine-too", want_egg_id: "a1", egg: { egg_id: "mine-too", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + 1 });
  assert.deepEqual([r.changed, r.state, r.deliveries], [true, "declined", 1]);
  assert.equal((await popDelivery(A)).payload.trade.state, "declined");
  assert.deepEqual([(await egg(A, "a1")).status, (await egg(A, "mine-too")).status], ["shelf", "shelf"]);
  // The same egg on both sides of a swap is nonsense: ignored.
  const p2 = await proposeSwap(A, { eggId: "a1", toCrowId: "crow:B", now: T0 + 2 });
  await popDelivery(A);
  r = await receiveTrade(A, { trade_id: p2.trade.trade_id, state: "accepted", my_egg_id: "a1", want_egg_id: "a1", egg: { egg_id: "a1", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:B", now: T0 + 3 });
  assert.equal(r.changed, false);
  assert.equal((await trade(A, p2.trade.trade_id)).state, "proposed");
});

test("S2: inbound ceilings — at most 20 open proposals per contact and 20 received gifts per contact per day", async () => {
  const B = await freshDb();
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await receiveTrade(B, { trade_id: "t" + i, state: "proposed", my_egg_id: "e" + i, want_egg_id: null, egg: { egg_id: "e" + i, warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:spam", now: T0 + i });
    assert.equal(r.changed, true);
  }
  const over = await receiveTrade(B, { trade_id: "t20", state: "proposed", my_egg_id: "e20", want_egg_id: null, egg: { egg_id: "e20", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:spam", now: T0 + 20 });
  assert.equal(over.changed, false);
  assert.equal((await receiveTrade(B, { trade_id: "t-other", state: "proposed", my_egg_id: "e-o", want_egg_id: null, egg: { egg_id: "e-o", warmth: 1, found_cell: null, found_week: null } }, { fromCrowId: "crow:other", now: T0 + 21 })).changed, true, "the cap is per contact");
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await receiveGift(B, { egg_id: "g" + i, warmth: 1 }, { fromCrowId: "crow:spam", now: T0 + i })).inserted, true);
  }
  assert.deepEqual(await receiveGift(B, { egg_id: "g20", warmth: 1 }, { fromCrowId: "crow:spam", now: T0 + 20 }), { inserted: false, reason: "capped", egg_id: "g20" });
  assert.equal((await receiveGift(B, { egg_id: "g21", warmth: 1 }, { fromCrowId: "crow:spam", now: T0 + 86400e3 })).inserted, true, "a new local day opens the cap");
});

test("expiry sweeps proposed AND accepted rows, emits them, and a 'completed' still lands on an acceptor whose row expired if the egg is still theirs", async () => {
  const B = await freshDb();
  await shelf(B, "b1", 15);
  await B.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-acc','crow:A','acceptor','b1','a1','{}','accepted',?,?,?)", args: [T0, T0, T0 + 100] });
  await B.execute({ sql: "INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at) VALUES ('t-prop','crow:A','acceptor',NULL,'a2','{}','proposed',?,?,?)", args: [T0, T0, T0 + 100] });
  const { calls, emit } = emitter();
  assert.equal(await expireTrades(B, T0 + 100, { emit }), 2);
  assert.deepEqual(calls.map((c) => [c[2], c[3]]).sort(), [["t-acc", "expired"], ["t-prop", "expired"]]);
  assert.equal(await isEggLocked(B, "b1"), false);
  const r = await receiveTrade(B, { trade_id: "t-acc", state: "completed", my_egg_id: "a1", want_egg_id: "b1", egg: { egg_id: "a1", warmth: 3, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 + 200, emit });
  assert.deepEqual([r.changed, r.state], [true, "completed"]);
  assert.equal((await egg(B, "b1")).status, "gifted");
  assert.equal((await egg(B, "a1")).status, "received");
  // A 'completed' for a proposal that was never accepted is ignored.
  const r2 = await receiveTrade(B, { trade_id: "t-prop", state: "completed", my_egg_id: "a2", want_egg_id: "zzz", egg: { egg_id: "a2", warmth: 3, found_cell: null, found_week: null } }, { fromCrowId: "crow:A", now: T0 + 201 });
  assert.equal(r2.changed, false);
  assert.equal(await egg(B, "a2"), null);
});

test("listTrades: open offers first, newest first, with the parsed offer; lockedEggIds covers both roles", async () => {
  const db = await freshDb();
  await shelf(db, "x1");
  await db.executeMultiple(`
    INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at)
    VALUES ('old-done','crow:A','proposer','x0',NULL,NULL,'completed',1,2,999),
           ('open-1','crow:B','acceptor',NULL,'y1','{"egg_id":"y1","warmth":33,"found_cell":null,"found_week":null}','proposed',5,5,999),
           ('open-2','crow:C','proposer','x1',NULL,NULL,'proposed',7,7,999),
           ('open-3','crow:D','acceptor','x2','y2',NULL,'accepted',3,9,999);`);
  const list = await listTrades(db, { now: 10, limit: 20 });
  assert.deepEqual(list.map((t) => [t.trade_id, t.open]), [["open-3", true], ["open-2", true], ["open-1", true], ["old-done", false]]);
  assert.deepEqual(list[2].offer, { egg_id: "y1", warmth: 33, found_cell: null, found_week: null });
  assert.equal(list[1].offer, null);
  assert.deepEqual([...(await lockedEggIds(db))].sort(), ["x1", "x2"]);
  assert.equal(await isEggLocked(db, "x0"), false);
});

test("receiveEnvelope routes marks (as persistent contacts marks + meet payload), eggs and trades; junk is null", async () => {
  const db = await freshDb();
  const mark = { mark_id: "m-1", kind: "mark", anchor_kind: "geo", geohash: "9v6m21h", lat: 30.46, lon: -98.08, accuracy_m: 10, anchor_ref: null, reveal: "open", content_text: "hi contact", content_kind: "none", content_ref: null, created_at: T0, bird: { species: "raven", seed: 3 } };
  const r = await receiveEnvelope(db, { crowId: "crow:F", pubkey: "02" + PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-1" }, { now: T0 });
  assert.deepEqual([r.kind, r.inserted, r.geohash, r.mark_id, r.markKind], ["mark", true, "9v6m21h", "m-1", "mark"]);
  const stored = (await db.execute("SELECT * FROM ramble_marks WHERE mark_id='m-1'")).rows[0];
  assert.deepEqual([stored.visibility, stored.expires_at, stored.origin, stored.author, stored.author_level, stored.bird_species, stored.nostr_event_id], ["contacts", null, "remote", PK, "real", "raven", "ev-1"]);
  assert.equal((await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.mark", v: 1, mark }, eventId: "ev-2" }, { now: T0 })).inserted, false, "same mark_id: a re-delivery is a no-op");
  const g = await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "gift-1", warmth: 2 } } }, { now: T0 });
  assert.deepEqual([g.kind, g.inserted, g.egg_id], ["egg", true, "gift-1"]);
  assert.equal((await egg(db, "gift-1")).from_crow_id, "crow:F");
  const t = await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.trade", v: 1, trade: { trade_id: "t-9", state: "proposed", my_egg_id: "e9", want_egg_id: null }, egg: { egg_id: "e9", warmth: 5 } } }, { now: T0 });
  assert.deepEqual([t.kind, t.changed, t.state, t.trade_id], ["trade", true, "proposed", "t-9"]);
  assert.deepEqual(await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.trade", v: 1, trade: { trade_id: "t-9", state: "weird" } } }, { now: T0 }), { kind: "trade", changed: false, trade_id: null, deliveries: 0 });
  assert.equal(await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "crow_social" } }, { now: T0 }), null);
  assert.equal(await receiveEnvelope(db, { crowId: "bad id", pubkey: PK, payload: { type: "ramble.egg", v: 1, egg: { egg_id: "x" } } }, { now: T0 }), null);
  assert.deepEqual(await receiveEnvelope(db, { crowId: "crow:F", pubkey: "nothex", payload: { type: "ramble.mark", v: 1, mark } }, { now: T0 }), { kind: "mark", inserted: false });
  assert.equal(await receiveEnvelope(db, { crowId: "crow:F", pubkey: PK, payload: { type: "ramble.unknown", v: 1 } }, { now: T0 }), null);
});
