/**
 * Process-level narrow net for nostr-tools' close-race rejection (2c-F1 C1b).
 *
 * nostr-tools 2.23.3: AbstractRelay.send() is an ASYNC method that throws
 * SendingOnClosedConnection when the socket dropped (connectionPromise null);
 * Subscription.fire() calls it without await or catch, so the throw is an
 * orphaned rejection — fatal under Node's default --unhandled-rejections=throw.
 * The connected-guards in resilient-subscribe.js and the pi-bots nostr-client
 * remove the deterministic triggers; this guard covers library-internal fire()
 * paths we cannot wrap. Any OTHER rejection is rethrown — crash-on-unknown is
 * load-bearing (throw inside the listener → uncaughtException → default fatal,
 * the same observable outcome as having no listener at all).
 */
let installed = false;
let swallowed = 0;

/**
 * Returns true iff the rejection is the known nostr close-race (swallowed).
 * Exported so tests can unit-call it without emitting a real process event.
 */
export function handleRejection(err) {
  if (err?.name === "SendingOnClosedConnection") {
    swallowed++;
    // Rate-limited observability: a stuck-relay loop must not hide behind a
    // single warn — log the count at 1, 10, 100, 1000, ...
    if (Number.isInteger(Math.log10(swallowed))) {
      console.warn(`[nostr] swallowed SendingOnClosedConnection #${swallowed} (relay dropped mid-send)`);
    }
    return true;
  }
  return false;
}

let listener = null;

/** Idempotent: installs exactly one process listener regardless of call count. */
export function installNostrCrashGuard() {
  if (installed) return;
  installed = true;
  listener = (err) => { if (!handleRejection(err)) throw err; }; // crash-on-unknown preserved
  process.on("unhandledRejection", listener);
}

/**
 * Test-only. A permanent throwing global listener in the node:test process
 * would fight the runner (a stray non-nostr rejection in ANY later test in
 * the file becomes an uncaughtException attributed to no test). Tests MUST
 * uninstall in finally; prod never calls this.
 */
export function uninstallNostrCrashGuard() {
  if (listener) process.off("unhandledRejection", listener);
  listener = null;
  installed = false;
  swallowed = 0;
}
