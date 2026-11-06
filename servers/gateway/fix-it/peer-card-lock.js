/**
 * N1b-8 review round 1 (B1): one serialised decide-then-upsert per peer.
 *
 * The Fix-it card path is a read-modify-write: read this detector's open cards
 * (`store.listBySource`), decide (peer-card-policy.js), then upsert. Two
 * denials for the same peer arriving together both read "no cards yet" and both
 * create one, so the MAX_OPEN_CARDS_PER_PEER cap did not hold: 20 concurrent
 * denials from one peer made 20 pending cards.
 *
 * A process-level promise chain per key (the same shape peer-exposure-store.js
 * uses for its writes) makes the read and the write of one peer atomic with
 * respect to the others. Notes:
 *
 *   - The chain is keyed by the VERIFIED peer id, so two peers never wait on
 *     each other's read-decide-write of the CARD store. They DO share the one
 *     process-level write queue for the suppressed-request counters
 *     (peer-card-counters.js `recordSuppressedRequest`): an event that is
 *     counted rather than carded waits, in arrival order, behind every other
 *     peer's counter write. Counting is serialised globally; the card path is
 *     not.
 *   - Review round 2 (N-b): the queue per key is BOUNDED
 *     (MAX_QUEUED_TASKS_PER_KEY). A peer that fires thousands of denials at
 *     once cannot park thousands of pending read-decide-write operations in
 *     memory; events beyond the cap are dropped before they touch the db and
 *     counted in memory (`_peerLockOverflow()`), never silently.
 *   - The key is dropped as soon as its tail settles: the map cannot grow with
 *     the number of peers ever seen.
 *   - One failing event never wedges the chain — the tail is a promise that
 *     always resolves, so the next event still runs; the failing event's own
 *     rejection is the caller's to handle.
 */

/**
 * How many tasks one key may have accepted but not finished (the running one
 * plus the queued ones). Well above anything a human-paced peer produces
 * (the card path itself allows at most MAX_OPEN_CARDS_PER_PEER open cards and
 * one new card per capability per 24 h), and small enough that a flood costs
 * bounded memory.
 */
export const MAX_QUEUED_TASKS_PER_KEY = 16;

/** @type {Map<string, {tail: Promise<void>, queued: number}>} one live state per key */
const chains = new Map();

/** Task count at which events for this key are dropped (memory only). */
let overflow = 0;

/**
 * Run `fn` with no other call for `key` in flight, in arrival order.
 *
 * When the key already holds MAX_QUEUED_TASKS_PER_KEY unfinished tasks, `fn` is
 * NOT run: the event is dropped (no db work at all) and counted in `overflow`.
 * The returned promise resolves to undefined, so the fire-and-forget caller
 * (`emitFixIt`) behaves exactly as on success.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T|undefined>} the result (or rejection) of `fn`, or
 *   undefined when the event was dropped
 */
export function withPeerLock(key, fn) {
  const k = typeof key === "string" && key ? key : "\u0000unkeyed";
  let state = chains.get(k);
  if (state && state.queued >= MAX_QUEUED_TASKS_PER_KEY) {
    overflow += 1;
    return Promise.resolve(undefined);
  }
  // One mutable state object per key, so the counters cannot drift apart.
  if (!state) {
    state = { tail: Promise.resolve(), queued: 0 };
    chains.set(k, state);
  }
  state.queued += 1;
  const run = state.tail.then(fn, fn); // never inherits the previous failure
  const tail = run.then(() => {}, () => {});
  state.tail = tail;
  // Drop the key when the tail settles, but only if nothing else has queued
  // behind it in the meantime (otherwise we would orphan a live chain).
  tail.then(() => {
    state.queued -= 1;
    if (state.queued <= 0 && chains.get(k) === state) chains.delete(k);
  });
  return run;
}

/** Test seam: how many keys are currently queued (must return to 0). */
export function _peerLockSize() {
  return chains.size;
}

/** Test seam: how many events were dropped because a key's queue was full. */
export function _peerLockOverflow() {
  return overflow;
}

/** Test seam: forget the drop counter and the chains (tests that assert them). */
export function _resetPeerLockForTest() {
  chains.clear();
  overflow = 0;
}