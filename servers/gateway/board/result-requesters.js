/**
 * Who asked for a card's result (PR 3, Task 3.8; PR 5, Task 5.1). Keyed by card id, in memory and with no
 * table: a claim says which rail (a registered "kind": today "voice", the hand-off; later "delegate") gets
 * the card's final report instead of the plain board notification. A kind registers three hooks:
 *
 *   notice(cdb, ctx)   → the notification to send (createNotification's opts), or null for "not mine after
 *                        all" (today's generic notice goes out instead); ctx = { card, outcome, summaryMd,
 *                        resultId, actor, tdb }
 *   owns(cdb, cardId)  → whether the kind's own records say this card is its [rv1 C7]: the DB fallback, so a
 *                        claim lost to a restart (or made on another gateway) still routes the result
 *   restore(cdb)       → the card ids the kind holds, for the boot warm-up (a cache, never the only source)
 *
 * The turn-end mark: a result notice sent by a rail of its own tells the Perch session holding the card not
 * to push "replied" for the same turn. It is turn-scoped and unstored (engine.suppressTurnEndPush): a report
 * made outside a running turn, or a mark never consumed, cannot leak onto a later turn.
 *
 * The claims and the kinds live on a globalThis symbol (P30), so a second module instance (a bundle-loaded
 * copy under another APP_ROOT) claims into the same map.
 */
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const REGISTRY = Symbol.for("crow.voice.result-requesters");
const state = (globalThis[REGISTRY] ??= { claims: new Map(), kinds: new Map() });
const { claims, kinds } = state;   // cardId (number) → kind; kind → { notice, restore, owns }

function key(cardId) {
  const n = Number(cardId);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`result-requesters: bad card id ${JSON.stringify(cardId)}`);
  return n;
}

function assertKind(kind) {
  if (typeof kind !== "string" || !KIND.test(kind)) throw new Error(`result-requesters: bad kind ${JSON.stringify(kind)}`);
}

/** Register (or replace) a result kind: { notice, restore, owns }, every one a function. */
export function registerResultKind(kind, impl) {
  assertKind(kind);
  for (const fn of ["notice", "restore", "owns"]) {
    if (typeof impl?.[fn] !== "function") throw new Error(`result-requesters: kind ${kind} needs a ${fn} function`);
  }
  kinds.set(kind, { notice: impl.notice, restore: impl.restore, owns: impl.owns });
}

/** Claim a card's result for `kind` (replacing an earlier claim). */
export function claimResult(cardId, kind) {
  assertKind(kind);
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
 * The notice for a card's result, or null when no rail wants it. The claimed kind answers; with no claim,
 * the first registered kind whose `owns` finds the card answers and takes the claim [rv1 C7]. A kind that
 * throws, or answers with anything but an object, gives null (logged): the board's own notice then goes
 * out, so a broken rail never silences a result.
 */
export async function resultNoticeFor(cdb, ctx, { log = (m) => console.warn(m) } = {}) {
  const raw = ctx && ctx.card ? ctx.card.id : null;
  const cardId = Number(raw);
  if (!Number.isInteger(cardId) || cardId <= 0) return null;
  let kind = claims.get(cardId) ?? null;
  if (kind == null) {
    for (const [k, impl] of kinds) {
      let mine = false;
      try { mine = (await impl.owns(cdb, cardId)) === true; }
      catch (err) { log(`[result-requesters] ${k}.owns(${cardId}) failed (${err?.message || err})`); }
      if (mine) { claims.set(cardId, k); kind = k; break; }
    }
    if (kind == null) return null;
  }
  const impl = kinds.get(kind);
  if (!impl) { log(`[result-requesters] card ${cardId} is claimed by ${kind}, which is not registered`); return null; }
  let notice;
  try { notice = await impl.notice(cdb, ctx); }
  catch (err) { log(`[result-requesters] ${kind}.notice(${cardId}) failed (${err?.message || err})`); return null; }
  if (notice == null) return null;
  if (typeof notice !== "object") { log(`[result-requesters] ${kind}.notice(${cardId}) returned a ${typeof notice}, not a notice`); return null; }
  return notice;
}

/**
 * The boot warm-up: every kind's `restore` fills the in-memory claims (an earlier claim is kept). Never the
 * only source (`owns` is), so a kind that throws is logged and the rest go on. → the number of claims added.
 */
export async function restoreResultRequesters(cdb, { log = (m) => console.warn(m) } = {}) {
  let added = 0;
  for (const [kind, impl] of kinds) {
    let ids;
    try { ids = await impl.restore(cdb); }
    catch (err) { log(`[result-requesters] ${kind}.restore failed (${err?.message || err})`); continue; }
    for (const id of Array.isArray(ids) ? ids : []) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0 || claims.has(n)) continue;
      claims.set(n, kind);
      added++;
    }
  }
  return added;
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

/** A fresh process: no claims and no kinds. */
export function _resetResultRequestersForTest() {
  claims.clear();
  kinds.clear();
}
