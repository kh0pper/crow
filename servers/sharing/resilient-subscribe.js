/**
 * Keep a single Nostr subscription alive across relay socket drops.
 *
 * nostr-tools' `relay.subscribe(...)` is established once and is NOT re-created
 * when the socket drops, goes idle, or the relay closes the long-lived REQ — the
 * relay keeps holding events but they never reach the handler until the process
 * restarts and re-subscribes. This wraps ONE subscribe against ONE relay and
 * re-establishes it whenever the relay reports disconnected.
 *
 * Design: the caller owns the relay lifecycle and runs a periodic health loop
 * that calls `ensureHealthy()` on each handle. Pair this with
 * `Relay.connect(url, { enablePing: true })` so a silently-dead half-open socket
 * flips `relay.connected` to false (ping timeout → ws.close) and the loop then
 * reconnects it. `enableReconnect` is intentionally left OFF — this is the single
 * app-level reconnect engine. Mirrors the reconnect-or-skip philosophy of
 * safe-relay-publish.js, on the subscribe side.
 *
 * Never touches sqlite and never constructs/closes the relay — that keeps the
 * same code usable from the pi-bots adapter (better-sqlite3) and NostrManager
 * (libsql) unchanged.
 *
 * @param {object} relay  connected nostr-tools Relay (or a stub)
 * @param {object} filter Nostr filter WITHOUT `since` (this injects `since`)
 * @param {function} onevent  called with each event (the caller dedups/decodes)
 * @param {{initialSince?:number, skewSec?:number, connectTimeoutMs?:number}} opts
 * @returns {{ensureHealthy:()=>Promise<void>, close:()=>void}}
 */
export function makeResilientSub(relay, filter, onevent, opts = {}) {
  const skewSec = opts.skewSec ?? 120;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
  const initialSince = opts.initialSince ?? null;
  let lastSeen = null; // max event.created_at delivered
  let sub = null;      // current sub handle, or null if none / dropped
  let stopped = false;
  let busy = false;

  const wrapped = (event) => {
    if (event && typeof event.created_at === "number") {
      // Clamp the watermark to no more than now + skew. A future-dated created_at
      // (malicious or clock-skewed) must never push `since` (= lastSeen - skew)
      // into the future, or the resubscribe filter would match nothing and cause a
      // permanent receive blackout that a restart can't clear.
      const ceiling = Math.floor(Date.now() / 1000) + skewSec;
      const clamped = Math.min(event.created_at, ceiling);
      if (lastSeen === null || clamped > lastSeen) lastSeen = clamped;
    }
    onevent(event);
  };

  function doSubscribe() {
    const since = lastSeen !== null ? lastSeen - skewSec : initialSince;
    const f = since !== null ? { ...filter, since } : { ...filter };
    try {
      sub = relay.subscribe([f], { onevent: wrapped, onclose: () => { sub = null; } });
    } catch {
      sub = null; // relay not ready; ensureHealthy retries next tick
    }
  }

  // Subscribe immediately (relay is connected at construction) so listening
  // starts right away, exactly like the pre-hardening one-shot subscribe.
  doSubscribe();

  async function ensureHealthy() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (!relay.connected) {
        let to;
        try {
          await Promise.race([
            relay.connect(),
            new Promise((_, rej) => { to = setTimeout(() => rej(new Error("connect timeout")), connectTimeoutMs); }),
          ]);
        } catch {
          return; // still down → retry next tick
        } finally {
          clearTimeout(to); // don't leave the race timer dangling when connect wins
        }
      }
      // Re-check `stopped` after the connect await: close() may have raced the
      // in-flight reconnect (teardown-during-reconnect). Without this, we'd
      // resurrect a subscription on a relay that's being torn down.
      if (stopped) return;
      if (!relay.connected) return;
      if (!sub) doSubscribe();
    } finally {
      busy = false;
    }
  }

  function close() {
    stopped = true;
    if (sub) { try { sub.close(); } catch {} sub = null; }
  }

  return { ensureHealthy, close };
}
