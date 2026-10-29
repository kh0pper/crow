/**
 * Preload (`node --import`) for OLD-tree gateway children in sync legs
 * (tests/fixtures/peer-pair.mjs). An old tree predates
 * servers/shared/test-timing.js, so its outbox drain keeps production's
 * fixed 60 s `setInterval`, and every leg that waits on an old author's
 * marker waits a minute per marker.
 *
 * This replaces exactly that one timer: a `setInterval` of 60000 ms created
 * directly from the tree's servers/sharing/sync-outbox-drain.js runs every
 * CROW_TEST_SYNC_DRAIN_MS instead (the value the new-tree children use; at
 * least 250 ms). Every other timer, and the drain's code, is the old tree's
 * own. It is active only inside the suite's scratch env (CROW_SUITE_SCRATCH),
 * like test-timing.js, and prints one line when it swaps the timer, so a
 * swap that stops matching is visible in the child's log.
 */
const TAG = "[old-tree-timing]";
const want = Number(process.env.CROW_TEST_SYNC_DRAIN_MS);
if (process.env.CROW_SUITE_SCRATCH && Number.isSafeInteger(want) && want > 0) {
  const ms = Math.max(want, 250);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = function patchedSetInterval(fn, delay, ...args) {
    if (delay === 60000) {
      // Frame 0 is this wrapper, frame 1 its caller.
      const caller = (new Error().stack || "").split("\n")[2] || "";
      if (/servers[\\/]sharing[\\/]sync-outbox-drain\.js:/.test(caller)) {
        console.log(`${TAG} outbox drain every ${ms} ms (was ${delay})`);
        return realSetInterval(fn, ms, ...args);
      }
    }
    return realSetInterval(fn, delay, ...args);
  };
}
