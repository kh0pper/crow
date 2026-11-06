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
 *     each other (a slow peer cannot stall the whole Nest).
 *   - The key is dropped as soon as its tail settles: the map cannot grow with
 *     the number of peers ever seen.
 *   - One failing event never wedges the chain — the tail is a promise that
 *     always resolves, so the next event still runs; the failing event's own
 *     rejection is the caller's to handle.
 */

/** @type {Map<string, Promise<void>>} */
const chains = new Map();

/**
 * Run `fn` with no other call for `key` in flight, in arrival order.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>} the result (or rejection) of `fn`
 */
export function withPeerLock(key, fn) {
  const k = typeof key === "string" && key ? key : "\u0000unkeyed";
  const prev = chains.get(k) || Promise.resolve();
  const run = prev.then(fn, fn); // never inherits the previous failure
  const tail = run.then(() => {}, () => {});
  chains.set(k, tail);
  // Drop the key when the tail settles, but only if nothing else has queued
  // behind it in the meantime (otherwise we would orphan a live chain).
  tail.then(() => {
    if (chains.get(k) === tail) chains.delete(k);
  });
  return run;
}

/** Test seam: how many keys are currently queued (must return to 0). */
export function _peerLockSize() {
  return chains.size;
}