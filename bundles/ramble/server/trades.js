/**
 * Ramble trades — gifts and swaps between contacts (spec §2.5, §4, §10).
 *
 * A GIFT is one envelope: the sender's egg becomes `gifted` (the row stays,
 * never deleted), the recipient inserts it as `received` with
 * `shelf_origin='user'` (sync never auto-promotes it) and `from_crow_id`.
 *
 * A SWAP is three envelopes and eggs change hands ONLY at completion:
 *
 *   proposer                                   acceptor
 *   proposeSwap: row(proposed, my=A)  --proposed(A)-->  row(proposed, their=A)
 *                                                       acceptSwap: state=accepted, my=B
 *   receiveTrade(accepted): A->gifted, <--accepted(B)--
 *     insert B received, state=completed
 *                                     --completed(A)--> receiveTrade(completed): B->gifted,
 *                                                         insert A received, state=completed
 *
 * `declined` is legal from either side only while `proposed`; `expired` is a
 * local sweep at created_at + TRADE_TTL_MS on both sides. Every envelope is
 * idempotent by trade_id (re-delivery is a no-op) and every hand-over is one
 * db.batch. A `completed` that reaches an acceptor whose row already expired
 * still lands if their egg is still theirs (the proposer has already given
 * theirs away); if the egg is gone the proposer holds a free copy — accepted
 * under spec §9 "no scarcity ledger, no value".
 *
 * An egg named by an open trade is LOCKED: it cannot be incubated, gifted or
 * offered again until the trade closes (flock.js asks isEggLocked).
 */
import { randomUUID } from "node:crypto";
import { insertRemoteMark } from "./marks.js";
import { xOnly } from "./persona.js";
import { startOfLocalDay } from "./eggs.js";
import {
  CROW_ID_RE, isRambleEnvelope, parseEggPayload, giftPayload, tradePayload, parseTradePayload,
  payloadToMark, enqueueDeliveries,
} from "./delivery.js";

export const TRADE_TTL_MS = 7 * 86400e3;
export const OPEN_STATES = ["proposed", "accepted"];
export const GIFTABLE = new Set(["shelf", "received"]);
/** Inbound ceilings per contact (review round 1, S2): past them an envelope is a silent no-op. */
export const MAX_OPEN_PROPOSALS_PER_CONTACT = 20;
export const MAX_GIFTS_PER_CONTACT_PER_DAY = 20;

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble trades] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

async function getEgg(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}
async function getTrade(db, tradeId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_trades WHERE trade_id = ?", args: [tradeId] });
  return rows[0] ?? null;
}

const OPEN_SQL = "state IN ('proposed', 'accepted')";
const LOCK_GUARD_SQL = `NOT EXISTS (SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND ${OPEN_SQL})`;
/** Binds ONE ?: the egg must still be giftable at write time (a gift racing a propose must not lock a gone egg — S1). */
const GIFTABLE_GUARD_SQL = "EXISTS (SELECT 1 FROM ramble_eggs WHERE egg_id = ? AND status IN ('shelf', 'received'))";

/* ---------------------------------------------------------------- locks */

export async function lockedEggIds(db) {
  const { rows } = await db.execute({ sql: `SELECT my_egg_id FROM ramble_trades WHERE my_egg_id IS NOT NULL AND ${OPEN_SQL}`, args: [] });
  return new Set(rows.map((r) => r.my_egg_id));
}

export async function isEggLocked(db, eggId) {
  const { rows } = await db.execute({ sql: `SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND ${OPEN_SQL} LIMIT 1`, args: [eggId] });
  return rows.length > 0;
}

/** The "receive an egg" upsert shared by gifts and swap completion: insert if new, revive if it was gifted away, else no-op. */
function receivedEggStatement(egg, fromCrowId, now) {
  return {
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, from_crow_id, created_at)
          VALUES (?, 'received', 'user', ?, ?, ?, ?, ?)
          ON CONFLICT(egg_id) DO UPDATE SET status = 'received', shelf_origin = 'user', warmth = excluded.warmth,
            found_cell = excluded.found_cell, found_week = excluded.found_week, from_crow_id = excluded.from_crow_id
          WHERE ramble_eggs.status = 'gifted'`,
    args: [egg.egg_id, egg.warmth, egg.found_cell, egg.found_week, fromCrowId, now],
  };
}

/* ---------------------------------------------------------------- gifts */

export async function giftEgg(db, { eggId, toCrowId, now = Date.now(), emit } = {}) {
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (!GIFTABLE.has(egg.status)) return { ok: false, reason: "not-an-egg" };
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_eggs SET status = 'gifted' WHERE egg_id = ? AND status IN ('shelf', 'received') AND ${LOCK_GUARD_SQL}`,
    args: [eggId, eggId],
  });
  if (rowsAffected === 0) return { ok: false, reason: "not-an-egg" };
  const gifted = await getEgg(db, eggId);
  await safeEmit(emit, "ramble_eggs", "update", gifted);
  await enqueueDeliveries(db, { toCrowIds: [toCrowId], kind: "egg", refId: eggId, payload: giftPayload(egg), now });
  return { ok: true, egg: gifted };
}

/**
 * Store a gifted egg as 'received'. The per-contact daily ceiling counts rows
 * whose `created_at` is today; a revived (gifted-back) egg keeps its original
 * `created_at` and so never counts — deliberate, revives are our own eggs.
 */
export async function receiveGift(db, eggIn, { fromCrowId, now = Date.now(), emit } = {}) {
  const egg = parseEggPayload(eggIn);
  if (!egg || typeof fromCrowId !== "string" || !CROW_ID_RE.test(fromCrowId)) return { inserted: false, reason: "malformed" };
  const { rows: today } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_eggs WHERE from_crow_id = ? AND status = 'received' AND created_at >= ?",
    args: [fromCrowId, startOfLocalDay(now)],
  });
  if (Number(today[0]?.n ?? 0) >= MAX_GIFTS_PER_CONTACT_PER_DAY) return { inserted: false, reason: "capped", egg_id: egg.egg_id };
  const { rowsAffected } = await db.execute(receivedEggStatement(egg, fromCrowId, now));
  if (rowsAffected === 0) return { inserted: false, egg_id: egg.egg_id };
  const row = await getEgg(db, egg.egg_id);
  await safeEmit(emit, "ramble_eggs", "insert", row);
  return { inserted: true, egg: row };
}

/* ---------------------------------------------------------------- swaps */

export async function proposeSwap(db, { eggId, toCrowId, now = Date.now(), emit } = {}) {
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (!GIFTABLE.has(egg.status)) return { ok: false, reason: "not-an-egg" };
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };
  const trade_id = randomUUID();
  // One statement decides the lock: two concurrent proposals of the same egg
  // cannot both pass (the second INSERT ... SELECT finds the first's open row).
  const { rowsAffected } = await db.execute({
    sql: `INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at)
          SELECT ?, ?, 'proposer', ?, NULL, NULL, 'proposed', ?, ?, ?
          WHERE ${LOCK_GUARD_SQL} AND ${GIFTABLE_GUARD_SQL}`,
    args: [trade_id, toCrowId, eggId, now, now, now + TRADE_TTL_MS, eggId, eggId],
  });
  if (rowsAffected === 0) return { ok: false, reason: (await isEggLocked(db, eggId)) ? "in-trade" : "not-an-egg" };
  const trade = await getTrade(db, trade_id);
  await safeEmit(emit, "ramble_trades", "insert", trade);
  await enqueueDeliveries(db, {
    toCrowIds: [toCrowId], kind: "trade", refId: trade_id,
    payload: tradePayload({ trade_id, state: "proposed", my_egg_id: eggId, want_egg_id: null }, egg), now,
  });
  return { ok: true, trade };
}

export async function acceptSwap(db, { tradeId, eggId, now = Date.now(), emit } = {}) {
  const trade = await getTrade(db, tradeId);
  if (!trade) return { ok: false, reason: "not-found" };
  if (trade.role !== "acceptor" || trade.state !== "proposed") return { ok: false, reason: "not-open" };
  if (Number(trade.expires_at) <= now) return { ok: false, reason: "expired" };
  const egg = await getEgg(db, eggId);
  if (!egg || !GIFTABLE.has(egg.status)) return { ok: false, reason: "not-an-egg" };
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_trades SET state = 'accepted', my_egg_id = ?, updated_at = ?
           WHERE trade_id = ? AND state = 'proposed' AND ${LOCK_GUARD_SQL} AND ${GIFTABLE_GUARD_SQL}`,
    args: [eggId, now, tradeId, eggId, eggId],
  });
  if (rowsAffected === 0) return { ok: false, reason: (await isEggLocked(db, eggId)) ? "in-trade" : "not-open" };
  const updated = await getTrade(db, tradeId);
  await safeEmit(emit, "ramble_trades", "update", updated);
  await enqueueDeliveries(db, {
    toCrowIds: [trade.counterpart], kind: "trade", refId: tradeId,
    payload: tradePayload({ trade_id: tradeId, state: "accepted", my_egg_id: eggId, want_egg_id: trade.their_egg_id }, egg), now,
  });
  return { ok: true, trade: updated };
}

/** Either side, only while `proposed` (an acceptor who already accepted may be mid-completion on the other side). */
export async function declineSwap(db, { tradeId, now = Date.now(), emit } = {}) {
  const trade = await getTrade(db, tradeId);
  if (!trade) return { ok: false, reason: "not-found" };
  const { rowsAffected } = await db.execute({
    sql: "UPDATE ramble_trades SET state = 'declined', updated_at = ? WHERE trade_id = ? AND state = 'proposed'",
    args: [now, tradeId],
  });
  if (rowsAffected === 0) return { ok: false, reason: "not-open" };
  const updated = await getTrade(db, tradeId);
  await safeEmit(emit, "ramble_trades", "update", updated);
  await enqueueDeliveries(db, {
    toCrowIds: [trade.counterpart], kind: "trade", refId: tradeId,
    payload: tradePayload({ trade_id: tradeId, state: "declined" }), now,
  });
  return { ok: true, trade: updated };
}

async function setState(db, tradeId, state, now, extra = {}) {
  const sets = ["state = ?", "updated_at = ?"];
  const args = [state, now];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(v); }
  args.push(tradeId);
  await db.execute({ sql: `UPDATE ramble_trades SET ${sets.join(", ")} WHERE trade_id = ?`, args });
}

/**
 * Apply one inbound trade envelope from `fromCrowId`. Returns
 * { changed, state?, trade_id, egg_id?, deliveries } — `deliveries` > 0 means
 * a reply was queued and the caller should poke the drain.
 */
export async function receiveTrade(db, parsed, { fromCrowId, now = Date.now(), emit } = {}) {
  const none = (extra = {}) => ({ changed: false, trade_id: parsed?.trade_id ?? null, deliveries: 0, ...extra });
  if (!parsed || typeof fromCrowId !== "string" || !CROW_ID_RE.test(fromCrowId)) return none();
  const t = parsed;
  const existing = await getTrade(db, t.trade_id);
  if (existing && existing.counterpart !== fromCrowId) return none();

  // C3: an egg the counterpart "offers" or "gives" must not be one THIS
  // instance still holds (anything but 'gifted'): a contact who remembers the
  // id of an egg they once gave us could otherwise make a completion batch
  // mark our answer egg 'gifted' while the revive no-ops — a lost egg.
  const stillOurs = async (eggId) => {
    if (!eggId) return true;
    const held = await getEgg(db, eggId);
    return !!held && held.status !== "gifted";
  };

  if (t.state === "proposed") {
    if (existing) return none();
    if (!t.egg || !t.my_egg_id || t.egg.egg_id !== t.my_egg_id) return none();
    if (await stillOurs(t.my_egg_id)) return none();
    const { rows: open } = await db.execute({
      sql: `SELECT count(*) AS n FROM ramble_trades WHERE counterpart = ? AND role = 'acceptor' AND ${OPEN_SQL}`, args: [fromCrowId],
    });
    if (Number(open[0]?.n ?? 0) >= MAX_OPEN_PROPOSALS_PER_CONTACT) return none();
    await db.execute({
      sql: `INSERT INTO ramble_trades (trade_id, counterpart, role, my_egg_id, their_egg_id, offer_json, state, created_at, updated_at, expires_at)
            VALUES (?, ?, 'acceptor', NULL, ?, ?, 'proposed', ?, ?, ?) ON CONFLICT(trade_id) DO NOTHING`,
      args: [t.trade_id, fromCrowId, t.my_egg_id, JSON.stringify(t.egg), now, now, now + TRADE_TTL_MS],
    });
    await safeEmit(emit, "ramble_trades", "insert", await getTrade(db, t.trade_id));
    return { changed: true, state: "proposed", trade_id: t.trade_id, egg_id: t.my_egg_id, deliveries: 0 };
  }

  if (t.state === "accepted") {
    if (!existing || existing.role !== "proposer") return none();
    if (existing.state === "completed" || existing.state === "declined") return none();
    if (!t.egg || !t.my_egg_id || t.egg.egg_id !== t.my_egg_id || t.want_egg_id !== existing.my_egg_id) return none();
    if (t.my_egg_id === existing.my_egg_id) return none();
    const mine = await getEgg(db, existing.my_egg_id);
    if (existing.state !== "proposed" || !mine || !GIFTABLE.has(mine.status) || (await stillOurs(t.my_egg_id))) {
      // Cannot honour it (lapsed, my egg is gone, or they named an egg we
      // hold): tell them so their egg unlocks. The row becomes 'declined'
      // (from 'proposed' OR 'expired') so the NEXT copy of this 'accepted'
      // hits the declined early-return above — exactly one reply per trade,
      // never one DM per re-delivery (C2).
      await setState(db, t.trade_id, "declined", now);
      await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
      await enqueueDeliveries(db, { toCrowIds: [fromCrowId], kind: "trade", refId: t.trade_id, payload: tradePayload({ trade_id: t.trade_id, state: "declined" }), now });
      return { changed: true, state: "declined", trade_id: t.trade_id, deliveries: 1 };
    }
    await db.batch([
      { sql: "UPDATE ramble_eggs SET status = 'gifted' WHERE egg_id = ? AND status IN ('shelf', 'received')", args: [mine.egg_id] },
      receivedEggStatement(t.egg, fromCrowId, now),
      { sql: "UPDATE ramble_trades SET state = 'completed', their_egg_id = ?, offer_json = ?, updated_at = ? WHERE trade_id = ?", args: [t.egg.egg_id, JSON.stringify(t.egg), now, t.trade_id] },
    ]);
    await safeEmit(emit, "ramble_eggs", "update", await getEgg(db, mine.egg_id));
    await safeEmit(emit, "ramble_eggs", "insert", await getEgg(db, t.egg.egg_id));
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
    await enqueueDeliveries(db, {
      toCrowIds: [fromCrowId], kind: "trade", refId: t.trade_id,
      payload: tradePayload({ trade_id: t.trade_id, state: "completed", my_egg_id: mine.egg_id, want_egg_id: t.egg.egg_id }, mine), now,
    });
    return { changed: true, state: "completed", trade_id: t.trade_id, egg_id: t.egg.egg_id, deliveries: 1 };
  }

  if (t.state === "completed") {
    if (!existing || existing.role !== "acceptor" || !existing.my_egg_id) return none();
    if (existing.state === "completed" || existing.state === "declined") return none();
    if (!t.egg || t.egg.egg_id !== existing.their_egg_id || t.want_egg_id !== existing.my_egg_id) return none();
    if (t.egg.egg_id === existing.my_egg_id || (await stillOurs(t.egg.egg_id))) return none();
    await db.batch([
      { sql: "UPDATE ramble_eggs SET status = 'gifted' WHERE egg_id = ? AND status IN ('shelf', 'received')", args: [existing.my_egg_id] },
      receivedEggStatement(t.egg, fromCrowId, now),
      { sql: "UPDATE ramble_trades SET state = 'completed', updated_at = ? WHERE trade_id = ?", args: [now, t.trade_id] },
    ]);
    await safeEmit(emit, "ramble_eggs", "update", await getEgg(db, existing.my_egg_id));
    await safeEmit(emit, "ramble_eggs", "insert", await getEgg(db, t.egg.egg_id));
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
    return { changed: true, state: "completed", trade_id: t.trade_id, egg_id: t.egg.egg_id, deliveries: 0 };
  }

  if (t.state === "declined") {
    if (!existing || !OPEN_STATES.includes(existing.state)) return none();
    await setState(db, t.trade_id, "declined", now);
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, t.trade_id));
    return { changed: true, state: "declined", trade_id: t.trade_id, deliveries: 0 };
  }

  return none(); // 'expired' never travels
}

/** Local sweep: open rows past expires_at become 'expired' (emitted). Returns how many. */
export async function expireTrades(db, now = Date.now(), { emit } = {}) {
  const { rows } = await db.execute({ sql: `SELECT trade_id FROM ramble_trades WHERE ${OPEN_SQL} AND expires_at <= ?`, args: [now] });
  if (rows.length === 0) return 0;
  await db.execute({ sql: `UPDATE ramble_trades SET state = 'expired', updated_at = ? WHERE ${OPEN_SQL} AND expires_at <= ?`, args: [now, now] });
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await safeEmit(emit, "ramble_trades", "update", await getTrade(db, r.trade_id));
  }
  return rows.length;
}

export async function listTrades(db, { now = Date.now(), limit = 20 } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM ramble_trades ORDER BY CASE WHEN ${OPEN_SQL} THEN 0 ELSE 1 END, updated_at DESC, trade_id LIMIT ?`,
    args: [limit],
  });
  return rows.map((r) => {
    let offer = null;
    if (r.offer_json) { try { offer = parseEggPayload(JSON.parse(r.offer_json)); } catch { offer = null; } }
    return {
      trade_id: r.trade_id, counterpart: r.counterpart, role: r.role, state: r.state,
      open: OPEN_STATES.includes(r.state) && Number(r.expires_at) > now,
      my_egg_id: r.my_egg_id ?? null, their_egg_id: r.their_egg_id ?? null, offer,
      created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at,
    };
  });
}

/* --------------------------------------------------------- inbound router */

/**
 * One decrypted ramble envelope from a CONTACT (the transport got it from
 * NostrManager's per-contact subscription, so `crowId`/`pubkey` are the
 * verified sender). Returns a small result the transport turns into bus
 * events, or null for anything that is not ours.
 */
export async function receiveEnvelope(db, { crowId, pubkey, payload, eventId = null } = {}, { now = Date.now(), emit } = {}) {
  if (!isRambleEnvelope(payload) || typeof crowId !== "string" || !CROW_ID_RE.test(crowId)) return null;
  if (payload.type === "ramble.mark") {
    const author = typeof pubkey === "string" ? xOnly(pubkey) : null;
    const row = payloadToMark(payload.mark, { author, eventId });
    if (!row) return { kind: "mark", inserted: false };
    const r = await insertRemoteMark(db, row);
    return { kind: "mark", inserted: !!r.inserted, row: r.row ?? null, geohash: row.geohash, mark_id: row.mark_id, markKind: row.kind };
  }
  if (payload.type === "ramble.egg") {
    const r = await receiveGift(db, payload.egg, { fromCrowId: crowId, now, emit });
    return { kind: "egg", inserted: r.inserted, egg_id: r.egg?.egg_id ?? r.egg_id ?? null, deliveries: 0 };
  }
  if (payload.type === "ramble.trade") {
    const parsed = parseTradePayload(payload);
    if (!parsed) return { kind: "trade", changed: false, trade_id: null, deliveries: 0 };
    const r = await receiveTrade(db, parsed, { fromCrowId: crowId, now, emit });
    return { kind: "trade", ...r };
  }
  return null;
}
