/**
 * Publish a Nostr event to a single relay WITHOUT risking an unhandled-rejection
 * process crash.
 *
 * Why this exists: nostr-tools' `Relay.publish()` calls `Relay.send()` WITHOUT
 * awaiting it. When the relay's WebSocket has dropped, `send()` rejects with
 * `SendingOnClosedConnection` (connectionPromise === null). That rejection is on
 * the orphaned `send()` promise — NOT the promise `publish()` returns — so it
 * escapes any `try { await relay.publish() } catch {}` around the call site. Under
 * Node's default `--unhandled-rejections=throw` an unhandled rejection terminates
 * the whole process. This is exactly what took down the crow-mpa gateway mid
 * room fan-out when relay.damus.io had dropped its connection.
 *
 * Guard: never invoke `publish()` on a relay that is not connected. Reconnect a
 * dropped relay first (best-effort, bounded by nostr-tools' own connect timeout);
 * if it is still down, skip it. The `connected` check sits immediately before the
 * synchronous `publish()` call with no `await` between them, so a close event
 * cannot interleave (single-threaded, no yield point) — the deterministic
 * closed-relay trigger is removed.
 *
 * @returns {Promise<boolean>} true if we published, false if the relay was skipped.
 */
export async function safeRelayPublish(relay, event) {
  if (!relay) return false;
  if (!relay.connected) {
    try { await relay.connect(); } catch { /* reconnect best-effort; skip below if still down */ }
  }
  if (!relay.connected) return false; // still closed → skip; do NOT trigger the leak
  await relay.publish(event);
  return true;
}
