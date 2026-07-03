/**
 * receive-health — per-process receive-path health state (R8 + R7).
 *
 * Written by the sharing layer (boot.js sets receiveWired; nostr.js mirrors
 * relay count, stamps inbound activity, counts decrypt failures — L8). Read by
 * the gateway's nest `messagesSignal` with a PLAIN IMPORT — this module has
 * ZERO imports so importing it can never spin up sharing-client sockets
 * (the pre-QW2 suite-hang trap). Same per-process-singleton shape as
 * isAuditDegraded() in servers/shared/cross-host-auth.js.
 *
 * receiveWired: null = wiring never attempted (e.g. sharing disabled) — the
 * signal renders "off", never a false warn; false = attempted and failed
 * (warn); true = subscriptions live.
 */

const INITIAL = () => ({
  receiveWired: null,
  lastError: null,
  relaysConnected: 0,
  lastInboundAt: null,
  decryptFailures: 0,
});

let _state = INITIAL();

export function setReceiveWired(ok, err) {
  _state.receiveWired = !!ok;
  _state.lastError = ok ? null : (err?.message ?? String(err ?? "unknown"));
}

export function setRelaysConnected(n) {
  _state.relaysConnected = Number(n) || 0;
}

export function markInbound(nowMs = Date.now()) {
  _state.lastInboundAt = nowMs;
}

export function markDecryptFailure() {
  _state.decryptFailures += 1;
}

export function getReceiveHealth() {
  return { ..._state };
}

/** Test hook. */
export function _resetReceiveHealth() {
  _state = INITIAL();
}
