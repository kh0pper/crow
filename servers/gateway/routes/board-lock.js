/**
 * Board card lock predicate — THE single definition, for BOTH rails.
 *
 * A board card can be held by two different mechanisms, and every writer has to
 * respect both:
 *
 *   - the CONVERSATIONAL rail — a `bot_sessions` row (the bridge's live pi
 *     turn). Locked while its status is active/waiting-user.
 *   - the JOB rail — an unfinished `bot_jobs` row carrying this card_id. Locked
 *     while its status is queued/running. The job rail writes NO session row,
 *     so a session-only predicate reports a dispatched card as free.
 *
 * This file exists because that predicate used to be copy-pasted into three
 * places (the JSON API's single-card re-check, the SSR/SSE board render, and
 * the no-JS `action=move` handler) and they diverged: only the first learned
 * about the job rail. The result was a card that every API write 409'd on while
 * the board drew it unlocked and draggable, and a force-unlock that reported
 * "card is not locked" about a card nothing could write to. Import from here;
 * do not re-derive.
 *
 * Rail precedence in the single-card form: JOB first. When a card is held by
 * both, the caller is told about the job — the rail that a fresh dispatch would
 * collide with. force-unlock releases one rail per call by design (it is a
 * deliberate, audited act, not a sweep), so a doubly-held card takes two.
 *
 * Every query is individually try/caught and degrades to "this rail holds no
 * lock": `bot_sessions` / `bot_jobs` are absent on a primary (non-MPA) gateway,
 * where the board panel is not offered at all. Read paths stay permissive;
 * write paths 409 only on a POSITIVE lock.
 *
 * Callers pass the gateway's async libsql client for crow.db (both tables live
 * there) — never tasks.db, which holds the cards themselves.
 */

// bot_sessions statuses that mean "a pi turn owns this card right now".
// NOT a description of jobs — a job's 'queued' is not a session state, and
// widening this set to cover it would make it lie to every other reader.
export const SESSION_LOCK_STATUSES = new Set(["active", "waiting-user"]);

// bot_jobs statuses that are not yet terminal. job_runner claims from 'queued'
// and recovers from 'running'; 'completed'/'failed' are its only end states, so
// these two are exactly the rows that can still take the card.
export const JOB_LOCK_STATUSES = new Set(["queued", "running"]);

// Built from the Set above so the SQL and the predicate can never disagree.
const JOB_STATUS_ARGS = [...JOB_LOCK_STATUSES];
const JOB_STATUS_PH = JOB_STATUS_ARGS.map(() => "?").join(",");

/**
 * The unfinished job holding a card, or null. Newest first: a card that somehow
 * accumulated two live jobs reports the one a retry would surface.
 */
export async function jobLockFor(db, cardId) {
  try {
    const r = (await db.execute({
      sql:
        "SELECT job_id, bot_id, card_id, card_action, status, worker_pid, started_at " +
        `FROM bot_jobs WHERE card_id=? AND status IN (${JOB_STATUS_PH}) ` +
        "ORDER BY rowid DESC LIMIT 1",
      args: [cardId, ...JOB_STATUS_ARGS],
    })).rows[0];
    return r || null;
  } catch {
    return null; // bot_jobs absent / transient — this rail holds nothing.
  }
}

/**
 * The MAX(id) bot_sessions row for a card, or null. Returned even when its
 * status is not a locking one: force-unlock reports what it found.
 */
export async function sessionRowFor(db, cardId) {
  try {
    const r = (await db.execute({
      sql:
        "SELECT id, bot_id, status, pi_session_dir, " +
        "(strftime('%s','now') - strftime('%s', updated_at)) AS age_s " +
        "FROM bot_sessions WHERE card_id=? ORDER BY id DESC LIMIT 1",
      args: [cardId],
    })).rows[0];
    return r || null;
  } catch {
    return null;
  }
}

/**
 * Single-card lock state. Returns { locked, rail, row }:
 *   rail 'job'     — row is the bot_jobs row (job_id, bot_id, status, worker_pid)
 *   rail 'session' — row is the bot_sessions row (id, status, pi_session_dir, age_s)
 *   rail null      — no row on either rail; locked is false
 * `locked` can be false with rail 'session' (a finished session is still the
 * row force-unlock wants to describe).
 */
export async function lockState(db, cardId) {
  const job = await jobLockFor(db, cardId);
  if (job) return { locked: true, rail: "job", row: job };
  const sess = await sessionRowFor(db, cardId);
  if (!sess) return { locked: false, rail: null, row: null };
  return { locked: SESSION_LOCK_STATUSES.has(String(sess.status)), rail: "session", row: sess };
}

/**
 * Batched form of the SAME predicate: the ids locked by either rail. TWO
 * queries total regardless of card count (design D5: the board render and the
 * SSE tick must never run a per-card LIMIT-1 loop).
 */
export async function lockedCardIds(db, cardIds) {
  const ids = (cardIds || []).filter((n) => Number.isInteger(n));
  const locked = new Set();
  if (!ids.length) return locked;
  const ph = ids.map(() => "?").join(",");
  try {
    const rows = (await db.execute({
      sql:
        `SELECT DISTINCT card_id FROM bot_jobs WHERE card_id IN (${ph}) ` +
        `AND status IN (${JOB_STATUS_PH})`,
      args: [...ids, ...JOB_STATUS_ARGS],
    })).rows || [];
    for (const r of rows) locked.add(Number(r.card_id));
  } catch { /* bot_jobs absent — this rail holds nothing */ }
  try {
    const rows = (await db.execute({
      sql:
        "SELECT card_id, status FROM bot_sessions " +
        `WHERE id IN (SELECT MAX(id) FROM bot_sessions WHERE card_id IN (${ph}) GROUP BY card_id)`,
      args: ids,
    })).rows || [];
    for (const r of rows) {
      if (SESSION_LOCK_STATUSES.has(String(r.status))) locked.add(Number(r.card_id));
    }
  } catch { /* bot_sessions absent — this rail holds nothing */ }
  return locked;
}

/** Map<cardId, boolean> over the ids given — every id gets an entry. */
export async function lockMapFor(db, cardIds) {
  const ids = (cardIds || []).filter((n) => Number.isInteger(n));
  const locked = await lockedCardIds(db, ids);
  const m = new Map();
  for (const id of ids) m.set(id, locked.has(id));
  return m;
}

/** The one-card boolean, for callers that only gate a write. */
export async function isCardLocked(db, cardId) {
  if (!Number.isInteger(cardId)) return false;
  return (await lockState(db, cardId)).locked;
}
