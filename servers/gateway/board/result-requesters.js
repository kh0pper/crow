/**
 * Who asked for a card's result (PR 3, Task 3.8; PR 5 adds the per-kind registry, the DB fallback and the
 * completion notice). In memory, keyed by card id: a claim says which rail (today only "voice") gets the
 * card's final report instead of the plain board notification.
 *
 * The turn-end mark: a result notice sent by a rail of its own tells the Perch session holding the card not
 * to push "replied" for the same turn. It is turn-scoped and unstored (engine.suppressTurnEndPush): a report
 * made outside a running turn, or a mark never consumed, cannot leak onto a later turn.
 */
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const claims = new Map();   // cardId (number) → kind

function key(cardId) {
  const n = Number(cardId);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`result-requesters: bad card id ${JSON.stringify(cardId)}`);
  return n;
}

/** Claim a card's result for `kind` (replacing an earlier claim). */
export function claimResult(cardId, kind) {
  if (typeof kind !== "string" || !KIND.test(kind)) throw new Error(`result-requesters: bad kind ${JSON.stringify(kind)}`);
  claims.set(key(cardId), kind);
}

export function releaseResult(cardId) {
  claims.delete(key(cardId));
}

/** The kind that claimed the card, or null. */
export function requesterOf(cardId) {
  return claims.get(key(cardId)) ?? null;
}

/**
 * The card's result just reached the operator by its own rail: the running turn of the Perch session holding
 * the card keeps its "replied" push to itself. Lazily reaches the engine and never creates one; false when
 * there is no engine, no holder or no running turn.
 */
export async function markTurnEnd(cardId) {
  let eng = null;
  try {
    const { getInteractiveEngine } = await import("../perch-interactive.js");
    eng = getInteractiveEngine({ createIfMissing: false });
  } catch { return false; }
  if (!eng || typeof eng.suppressTurnEndPush !== "function") return false;
  return eng.suppressTurnEndPush(key(cardId)) === true;
}

export function _resetResultRequestersForTest() {
  claims.clear();
}
