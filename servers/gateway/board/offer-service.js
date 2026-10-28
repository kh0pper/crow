/**
 * Card offers (redesign P5): a bot offers a card in a Perch chat; the operator's one tap makes it.
 *
 * The offered card lives on the bot's OWN board project, named at offer time (release 1: no
 * project picker; the operator can move the card later from its details). Offering creates no
 * card. Accepting creates exactly one, tagged `crow-offer-<id>`, and starts nothing.
 *
 * Rows live in crow.db `card_offers` (migration 0011 + init-db, one shape on both rails). The
 * accept is three steps: a claim (status 'pending' -> 'accepted', with a random claim_token and a
 * lease), the create on tasks.db, and the settle (card_id). Crash recovery (recoverOffer) handles
 * "accepted, card_id NULL": an exact `crow-offer-<id>` tag match settles to that card; otherwise
 * the offer goes back to 'pending' only once the accept's lease has expired, so a slow accept is
 * never raced. An offer that has a card is never reset.
 *
 * Every reader tolerates a store that has not run 0011 yet ("no such table").
 *
 * Errors are thrown in card-service's `{code, http}` shape, so both the board MCP tool and the
 * perch-api routes map them without a translation table.
 */
import { boardState } from "../dashboard/shared/bot-display.js";
import { assertProjectExists } from "../../shared/project-acl.js";
import { isVoiceBotId } from "../../shared/voice-bot.js";

/** How long an accept holds its claim before recovery may reopen it. createCard's own bound
 *  (the client's busy timeout, about 10 s) keeps the create far inside this. */
export const OFFER_LEASE_MS = 120_000;
/** A thread holds at most this many pending offers; the next one is refused. */
export const MAX_PENDING_OFFERS = 3;
export const OFFER_TITLE_MAX = 500;
export const OFFER_TAG_PREFIX = "crow-offer-";

function fail(msg, code, http) {
  return Object.assign(new Error(msg), { code, http });
}

// Test seam: the lease clock. Production reads Date.now(); a test pins it to walk a lease
// through fake time without sleeping.
let _now = () => Date.now();
export function _setClockForTest(fn) {
  _now = typeof fn === "function" ? fn : () => Date.now();
}
const nowIso = (offsetMs = 0) => new Date(_now() + offsetMs).toISOString();

const isNoTable = (e) => /no such table:?\s*card_offers/i.test(String(e?.message || e));
export const isBusy = (e) => /SQLITE_BUSY|database is locked/i.test(String(e?.code || "") + " " + String(e?.message || ""));

/** The tag an accepted offer's card carries. */
export const offerTag = (offerId) => OFFER_TAG_PREFIX + Number(offerId);

/** The fixed gateway line the bot hears on its next turn. No bot-chosen text. */
export const offerNoteLine = (cardId) => `[Crow] The operator made card #${Number(cardId)} from your offer.`;

/** A card's tags as a list: split on whitespace and commas, empties dropped. */
export function tagList(tags) {
  return String(tags ?? "").split(/[\s,]+/).filter(Boolean);
}

/** Trimmed, control characters removed (each run becomes one space, so "a\nb" reads "a b"),
 *  1-500 characters; else null. */
export function cleanOfferTitle(raw) {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").trim();
  return t.length >= 1 && t.length <= OFFER_TITLE_MAX ? t : null;
}

export async function loadBotRow(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE bot_id=?",
    args: [botId],
  });
  return rows[0] || null;
}

/** "Give to…" target check: the bot exists and is enabled (else 400
 * bot_unavailable), and it has a board a card can go on — kanban/task-list
 * with a linked, live project (boardState() "on", the SAME predicate the
 * Bot Builder and the Bot Board render with, so the gate and the UI cannot
 * drift). Anything else — type none, no project, a custom tracker (a card
 * cannot go onto a tracker board), an archived or missing project — is 409
 * no_board. */
export async function loadGiveTarget(db, botId) {
  const row = await loadBotRow(db, botId);
  if (!row || !Number(row.enabled) || isVoiceBotId(row.bot_id)) throw fail("bot unavailable", "bot_unavailable", 400);
  if (boardState(row).state !== "on") throw fail("bot has no board", "no_board", 409);
  try {
    await assertProjectExists(db, Number(row.project_id));
  } catch {
    throw fail("bot's board project is gone or archived", "no_board", 409);
  }
  return row;
}

function toOffer(r) {
  return {
    id: Number(r.id),
    title: String(r.title),
    projectId: Number(r.project_id),
    status: String(r.status),
    cardId: r.card_id == null ? null : Number(r.card_id),
    // The board project's name, so the chat can say where a card went without a second lookup.
    projectName: r.project_name == null ? null : String(r.project_name),
  };
}

export async function getOffer(db, offerId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM card_offers WHERE id=?", args: [Number(offerId)] });
    return rows[0] || null;
  } catch (e) {
    if (isNoTable(e)) return null;
    throw e;
  }
}

/**
 * A bot offers a card in its Perch thread. Validated now (C6): the bot passes loadGiveTarget's
 * rules, else `no_board`. A pending offer with the same (thread, title) comes back as a
 * duplicate; a fourth pending offer in a thread is `too_many_offers`. One INSERT … SELECT decides
 * both, so two concurrent offers can never slip past the cap together.
 */
export async function offerCard(db, { botId, threadId, title }) {
  const clean = cleanOfferTitle(title);
  if (!clean) throw fail(`a card title is 1-${OFFER_TITLE_MAX} characters`, "bad_title", 400);
  if (typeof threadId !== "string" || !threadId) throw fail("no thread", "bad_request", 400);
  let row;
  try {
    row = await loadGiveTarget(db, botId);
  } catch (e) {
    // Only the gate's own refusals read as "no board"; a store error stays what it is.
    if (e && (e.code === "no_board" || e.code === "bot_unavailable")) {
      throw fail("This bot has no board to put a card on", "no_board", 409);
    }
    throw e;
  }
  const projectId = Number(row.project_id);
  let ins;
  try {
    ins = await db.execute({
    sql: `INSERT INTO card_offers (bot_id, thread_id, title, project_id)
          SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM card_offers WHERE thread_id=? AND title=? AND status='pending')
             AND (SELECT COUNT(*) FROM card_offers WHERE thread_id=? AND status='pending') < ?`,
    args: [String(botId), threadId, clean, projectId, threadId, clean, threadId, MAX_PENDING_OFFERS],
    });
  } catch (e) {
    if (isNoTable(e)) throw fail("Card offers are not available until the store is migrated", "not_migrated", 503);
    throw e;
  }
  if (ins.rowsAffected === 1) return { offerId: Number(ins.lastInsertRowid), projectId, duplicate: false };
  const dup = (await db.execute({
    sql: "SELECT id, project_id FROM card_offers WHERE thread_id=? AND title=? AND status='pending' ORDER BY id LIMIT 1",
    args: [threadId, clean],
  })).rows[0];
  if (dup) return { offerId: Number(dup.id), projectId: Number(dup.project_id), duplicate: true };
  throw fail(`a chat holds at most ${MAX_PENDING_OFFERS} offers waiting for an answer`, "too_many_offers", 429);
}

/** A thread's offers, newest first (20). */
export async function listOffers(db, threadId) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT o.id, o.title, o.project_id, o.status, o.card_id, p.name AS project_name
            FROM card_offers o LEFT JOIN project_spaces p ON p.id = o.project_id
           WHERE o.thread_id=? ORDER BY o.id DESC LIMIT 20`,
      args: [String(threadId)],
    });
    return rows.map(toOffer);
  } catch (e) {
    if (isNoTable(e)) return [];
    throw e;
  }
}

/**
 * Decide a pending offer. One UPDATE guarded on status='pending': a second tap, a second device
 * or a decided offer changes 0 rows and gets 409 already_decided. An accept writes its
 * claim_token and a lease in the same statement.
 */
export async function claimOffer(db, offerId, decision, { claimToken = null } = {}) {
  if (decision !== "accepted" && decision !== "declined") throw fail("bad decision", "bad_request", 400);
  const accept = decision === "accepted";
  const r = await db.execute({
    sql: accept
      ? "UPDATE card_offers SET status=?, decided_at=datetime('now'), claim_token=?, lease_until=? WHERE id=? AND status='pending'"
      : "UPDATE card_offers SET status=?, decided_at=datetime('now') WHERE id=? AND status='pending'",
    args: accept ? [decision, String(claimToken), nowIso(OFFER_LEASE_MS), Number(offerId)] : [decision, Number(offerId)],
  });
  if (r.rowsAffected === 0) throw fail("this offer was already decided", "already_decided", 409);
  return getOffer(db, offerId);
}

/** The accept's lease check, right before the create: extends the lease only while THIS claim
 *  still holds an accepted, card-less offer. false = a sweep or another accept took it over. */
export async function renewLease(db, offerId, claimToken) {
  const r = await db.execute({
    sql: "UPDATE card_offers SET lease_until=? WHERE id=? AND claim_token=? AND status='accepted' AND card_id IS NULL",
    args: [nowIso(OFFER_LEASE_MS), Number(offerId), String(claimToken)],
  });
  return r.rowsAffected === 1;
}

/** A failed create, before any card exists: back to pending, only while this claim holds it. */
export async function releaseClaim(db, offerId, claimToken) {
  const r = await db.execute({
    sql: `UPDATE card_offers SET status='pending', decided_at=NULL, claim_token=NULL, lease_until=NULL
           WHERE id=? AND status='accepted' AND card_id IS NULL AND claim_token=?`,
    args: [Number(offerId), String(claimToken)],
  });
  return r.rowsAffected === 1;
}

/** Settle an accepted offer to its card. `projectId` is where the card really went (the bot's
 *  board at accept time, which can differ from the one named at offer time); it is written in
 *  the same UPDATE so listOffers never reports a stale project. null keeps the offer's own. */
export async function settleOffer(db, offerId, cardId, projectId = null) {
  await db.execute({
    sql: "UPDATE card_offers SET card_id=?, project_id=COALESCE(?, project_id) WHERE id=? AND card_id IS NULL",
    args: [Number(cardId), projectId == null ? null : Number(projectId), Number(offerId)],
  });
}

/** The card an accept made for this offer: an EXACT tag match (offer 1 never matches
 *  crow-offer-12) on a card assigned to the offering bot (so a card someone tagged by hand is
 *  never adopted), as {id, projectId}, or null. The LIKE only narrows the candidates. */
export async function findOfferCardRow(tdb, offerId, botId) {
  const tag = offerTag(offerId);
  const { rows } = await tdb.execute({
    sql: "SELECT id, tags, project_id FROM tasks_items WHERE board_id IS NULL AND assigned_bot = ? AND tags LIKE '%crow-offer-' || ? || '%' ORDER BY id",
    args: [String(botId), String(Number(offerId))],
  });
  const hit = rows.find((r) => tagList(r.tags).includes(tag));
  return hit ? { id: Number(hit.id), projectId: hit.project_id == null ? null : Number(hit.project_id) } : null;
}

/** findOfferCardRow's card id, or null. */
export async function findOfferCard(tdb, offerId, botId) {
  const r = await findOfferCardRow(tdb, offerId, botId);
  return r ? r.id : null;
}

/**
 * C8 recovery for "accepted, card_id NULL" (a crash between the create and the settle). A tagged
 * card settles the offer to it. With none, the offer reopens only when the accept's lease has
 * expired, never on decided_at's age, so a slow accept can't be raced. An offer with a card, or
 * one that is not accepted, is returned as it is. Returns the row plus `recovered`
 * ("settled" | "reopened" | null).
 */
export async function recoverOffer(db, tdb, offer) {
  if (!offer) return offer;
  if (offer.card_id != null || offer.status !== "accepted") return { ...offer, recovered: null };
  const card = await findOfferCardRow(tdb, offer.id, offer.bot_id);
  if (card) {
    await settleOffer(db, offer.id, card.id, card.projectId);
    return { ...(await getOffer(db, offer.id)), recovered: "settled" };
  }
  // A lease that was never written is a state the accept path does not produce; it reads as
  // expired so such a row can never be stuck accepted forever.
  const r = await db.execute({
    sql: `UPDATE card_offers SET status='pending', decided_at=NULL, claim_token=NULL, lease_until=NULL
           WHERE id=? AND status='accepted' AND card_id IS NULL AND (lease_until IS NULL OR lease_until < ?)`,
    args: [Number(offer.id), nowIso()],
  });
  return { ...(await getOffer(db, offer.id)), recovered: r.rowsAffected === 1 ? "reopened" : null };
}

export async function strandedOffers(db, threadId) {
  try {
    const { rows } = await db.execute({
      sql: threadId == null
        ? "SELECT * FROM card_offers WHERE status='accepted' AND card_id IS NULL ORDER BY id"
        : "SELECT * FROM card_offers WHERE status='accepted' AND card_id IS NULL AND thread_id=? ORDER BY id",
      args: threadId == null ? [] : [String(threadId)],
    });
    return rows;
  } catch (e) {
    if (isNoTable(e)) return [];
    throw e;
  }
}

/** recoverOffer over one thread's stranded offers (the GET /offers read). `tdb` may be a getter,
 *  called only when there is a stranded offer, so a read never makes a tasks.db file on an
 *  install without one. Returns the client it opened (the caller closes it), or null. */
export async function recoverThread(db, tdb, threadId) {
  const stranded = await strandedOffers(db, threadId);
  if (!stranded.length) return null;
  const t = typeof tdb === "function" ? tdb() : tdb;
  for (const o of stranded) await recoverOffer(db, t, o);
  return t;
}

/**
 * The recovery sweep: recoverOffer over every accepted offer with no card. Idempotent. A busy
 * store skips the rest of this pass (`skipped: true`); the next pass picks it up.
 */
export async function sweepOffers(db, tdb) {
  const out = { settled: 0, reopened: 0 };
  try {
    for (const o of await strandedOffers(db, null)) {
      const r = await recoverOffer(db, tdb, o);
      if (r.recovered === "settled") out.settled++;
      else if (r.recovered === "reopened") out.reopened++;
    }
  } catch (e) {
    if (isBusy(e)) return { ...out, skipped: true };
    throw e;
  }
  return out;
}

/**
 * The boot and timer entry to sweepOffers: opens crow.db, and tasks.db only when some accept was
 * left with no card (so an install without a tasks store never gets an empty file made for it),
 * and closes both. A busy store skips the pass.
 */
export async function runOfferSweep(openDb, openTasks) {
  const db = openDb();
  let tdb = null;
  try {
    let stranded;
    try {
      stranded = await strandedOffers(db, null);
    } catch (e) {
      if (isBusy(e)) return { settled: 0, reopened: 0, skipped: true };
      throw e;
    }
    if (!stranded.length) return { settled: 0, reopened: 0 };
    tdb = openTasks();
    return await sweepOffers(db, tdb);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
  }
}

/**
 * The message route's once-only note: claims every accepted, settled offer in this thread whose
 * note has not gone out (`note_delivered_at IS NULL` guard, so two messages can't both send it)
 * and returns the lines to prefix plus the claims, which `unclaimOfferNotes` hands back when the
 * turn never started.
 */
export async function claimOfferNotes(db, threadId) {
  // Delivery is AT MOST once: a crash between this claim and the engine taking the message loses
  // the line (accepted; the chat's system note still shows the card).
  let rows;
  try {
    rows = (await db.execute({
      sql: "SELECT id, card_id FROM card_offers WHERE thread_id=? AND status='accepted' AND card_id IS NOT NULL AND note_delivered_at IS NULL ORDER BY id",
      args: [String(threadId)],
    })).rows;
  } catch (e) {
    if (isNoTable(e)) return { lines: [], claims: [] };
    throw e;
  }
  const lines = [], claims = [];
  for (const r of rows) {
    const stamp = nowIso();
    const u = await db.execute({
      sql: "UPDATE card_offers SET note_delivered_at=? WHERE id=? AND note_delivered_at IS NULL",
      args: [stamp, Number(r.id)],
    });
    if (u.rowsAffected === 1) {
      lines.push(offerNoteLine(r.card_id));
      claims.push({ id: Number(r.id), stamp });
    }
  }
  return { lines, claims };
}

/** The offer-note lines the message route prefixes, removed from the start of a stored user
 *  message (exact lines, anchored, followed by the blank line), so a reloaded transcript shows
 *  the operator only their own text. Anything else is returned unchanged. */
const OFFER_NOTE_PREFIX = /^(?:\[Crow\] The operator made card #\d+ from your offer\.\n)+\n/;
export function stripOfferNotes(text) {
  return typeof text === "string" ? text.replace(OFFER_NOTE_PREFIX, "") : text;
}

export async function unclaimOfferNotes(db, claims) {
  for (const c of claims || []) {
    await db.execute({
      sql: "UPDATE card_offers SET note_delivered_at=NULL WHERE id=? AND note_delivered_at=?",
      args: [c.id, c.stamp],
    });
  }
}
