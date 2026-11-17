/**
 * Crow Mail's per-turn comment record (plan 3, Task 9): the comments a drafting turn started with,
 * under the turn's own id.
 *
 * `mail_draft_propose` must mark exactly those applied — in the same transaction as the revision it
 * writes — and never a comment the person added while the turn was running. `drafts/turn.js` records
 * the snapshot under the turn id at mint time (before the turn can propose anything) and forgets it
 * in the turn's `finally`; `drafts/revise.js` records the set it sent, and the FIRST record for a turn
 * wins, so the turn's own snapshot is never replaced by a later one.
 *
 * The record is process memory only, pruned by age and dropped when the turn ends, exactly like the
 * turn's token: a revision written after a restart is a revision with no comments to fold in, and the
 * comments stay queued where the person can see them.
 *
 * This is a leaf module with no imports: it is what `servers/gateway/mail-draft-mcp.js` reads while it
 * writes a revision, so nothing of the revision loop's turn machinery (or the bot runtime behind it)
 * may come with it.
 */

/** How long a turn's comment record is kept before it is dropped unread (a turn never runs this long). */
export const TURN_COMMENT_TTL_MS = 60 * 60 * 1000;

/**
 * The comments a turn starts with, per turn id. Module memory, like the turn token: a record is the
 * turn's snapshot of the draft, and it deliberately does not outlive the process.
 * @type {Map<string, {ids: string[], at: number}>}
 */
const turnComments = new Map();

function pruneTurnComments(now) {
  for (const [turnId, entry] of turnComments) {
    if (now - entry.at >= TURN_COMMENT_TTL_MS) turnComments.delete(turnId);
  }
}

/**
 * Record the comments a turn starts with. The first record for a turn is kept: the turn's own
 * snapshot (read at mint time, before it can propose anything) is authoritative, and a later note for
 * the same turn changes nothing.
 *
 * @param {string} turnId
 * @param {string[]} ids
 * @returns {boolean} whether this call made the record
 */
export function noteTurnCommentIds(turnId, ids) {
  if (typeof turnId !== "string" || !turnId) return false;
  if (!Array.isArray(ids)) return false;
  const now = Date.now();
  pruneTurnComments(now);
  if (turnComments.has(turnId)) return false;
  const clean = [];
  for (const id of ids) if (typeof id === "string" && id && !clean.includes(id)) clean.push(id);
  turnComments.set(turnId, { ids: clean, at: now });
  return true;
}

/** The comments a turn started with, as recorded; an unknown turn has none. */
export function turnCommentIds(turnId) {
  if (typeof turnId !== "string" || !turnId) return [];
  const entry = turnComments.get(turnId);
  return entry ? [...entry.ids] : [];
}

/** Forget a turn's record (the turn ended; nothing can propose under its token any more). */
export function forgetTurnCommentIds(turnId) {
  if (typeof turnId !== "string" || !turnId) return false;
  return turnComments.delete(turnId);
}

/** Test seam only: forget every record (module state is per process, like a restart). */
export function _resetTurnCommentIdsForTests() {
  turnComments.clear();
}