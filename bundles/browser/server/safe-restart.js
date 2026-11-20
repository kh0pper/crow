/**
 * The safe close a browser REPLACEMENT has to run before it replaces anything
 * (2026-11-03).
 *
 * `crow_browser_launch` replaces the browser on a proxy change and on a restart, and its
 * pages are closed through `closeGuardedPages` first (deny-all session, about:blank,
 * close after that page's grace). But `{ ok: false }` there does NOT mean the browser is
 * gone: the cleanup answers false when it could not open a browser CDP session to crash
 * the browser, or when `Browser.crash` was refused, and the browser is then still
 * running with the bot's pages possibly unguarded. Dropping the connection on that
 * answer loses the state a retry needs, and the retry then restarts the container with
 * those pages still open behind routes that no longer exist.
 *
 * So the distinction lives HERE, in one helper, and the launch handler only reads its
 * two answers:
 *
 *   ok:true                       → { proceed: true,  dropConnection: true }
 *                                   (the pages were closed; `browser.close()` may follow)
 *
 *   ok:false, the browser is gone  → { proceed: false, dropConnection: true }
 *                                   (found by probing: the connection is dead anyway)
 *
 *   ok:false, the browser is there → { proceed: false, dropConnection: false }
 *                                   (alive with pages possibly unguarded: keep
 *                                   browser/context so a retry runs the safe close again)
 *
 * `isConnected()` reports the PLAYWRIGHT WEBSOCKET, not Chromium: it says whether this process's
 * connection to the browser server is up, and the two can disagree. Two accepted limits follow,
 * recorded on purpose:
 *
 *   (a) The socket can drop while Chromium keeps running. The state is then dropped, and the
 *       next launch SKIPS the safe close — those pages were already unguarded from the moment
 *       the socket dropped, because the route guard and the deny-all sessions live in the
 *       connection that went away.
 *
 *   (b) A crash that went through while a proxy keeps the socket open leaves `isConnected()`
 *       true, so the refusal repeats on every retry. That is safe — the restart never happens
 *       over pages nobody closed — but stuck: only a fresh connection (or a restart of this
 *       process) clears it.
 *
 * A browser that is going away can take a moment to show it, so the probe is repeated
 * every `pollMs` until the browser answers gone or `maxWaitMs` has been spent. It never
 * throws: a throwing `closeGuardedPages` counts as `ok: false`, and a throwing
 * `isConnected` counts as still connected — "could not tell" must never throw away a
 * connection that may be able to run the safe close again.
 */

/** How long to wait between two connectivity probes when the caller does not say. */
const DEFAULT_POLL_MS = 100;
/** The whole probe, when the caller does not say. */
const DEFAULT_MAX_WAIT_MS = 1500;

/** A real wait, for a caller that only wants to override polling, not timing. */
const realWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decide what a launch may do after the safe close of the browser it is replacing.
 *
 * @param {object} opts
 * @param {(getContext: () => object|null, opts?: object) => Promise<{ok: boolean}>} opts.closeGuardedPages
 *   the safe close (`private-address.js`)
 * @param {() => object|null} opts.getContext - returns the guarded BrowserContext
 * @param {object} [opts.ownership] - the MCP process's page ownership
 * @param {() => boolean} opts.isConnected - is the browser this close was about still there?
 * @param {(ms: number) => Promise<void>} [opts.wait] - the wait between two probes
 * @param {number} [opts.pollMs] - how long one wait is (default 100 ms)
 * @param {number} [opts.maxWaitMs] - the whole probe's bound (default 1500 ms)
 * @returns {Promise<{proceed: boolean, dropConnection: boolean}>} never rejects
 */
export async function closePagesBeforeRestart({
  closeGuardedPages,
  getContext,
  ownership,
  isConnected,
  wait,
  pollMs,
  maxWaitMs,
} = {}) {
  const poll = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS;
  const limit = Number.isFinite(maxWaitMs) && maxWaitMs >= 0 ? maxWaitMs : DEFAULT_MAX_WAIT_MS;
  // A probe the caller did not pass cannot say "gone": the connection is kept, so a
  // retry runs the safe close again instead of restarting over pages nobody closed.
  const probe = typeof isConnected === "function" ? isConnected : () => true;
  const sleep = typeof wait === "function" ? wait : realWait;

  let closed = false;
  try {
    const answer = await closeGuardedPages(getContext, { ownership });
    closed = Boolean(answer && answer.ok === true);
  } catch {
    // A close that THREW proves nothing about the browser: it is read as `ok: false`,
    // and the probe below decides what that means.
    closed = false;
  }
  if (closed) return { proceed: true, dropConnection: true };

  // The pages were not closed safely. That is not the same as the browser being gone:
  // a crash that is under way, a container that is stopping and a connection that is
  // already dead all answer "gone" here, while a browser that is still up answers
  // "there" and must keep its connection for the retry.
  let waited = 0;
  for (;;) {
    let connected = true;
    try {
      connected = probe() !== false;
    } catch {
      // A probe that throws has not said "gone" (see the doc comment above).
      connected = true;
    }
    if (!connected) return { proceed: false, dropConnection: true };
    if (waited + poll > limit) return { proceed: false, dropConnection: false };
    try {
      await sleep(poll);
    } catch {
      // A wait that rejects does not change the question: the browser still answers.
    }
    waited += poll;
  }
}