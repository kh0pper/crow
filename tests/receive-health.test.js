/**
 * receive-health — R8/R7 per-process receive-path state. Pure module, zero
 * imports (gateway reads it with a plain import; must never pull sharing-client
 * sockets). Initial receiveWired is null = "never attempted".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setReceiveWired, setRelaysConnected, markInbound, markDecryptFailure,
  getReceiveHealth, _resetReceiveHealth,
} from "../servers/sharing/receive-health.js";

test("initial state: receiveWired null, no error, 0 relays, no inbound", () => {
  _resetReceiveHealth();
  assert.deepEqual(getReceiveHealth(), {
    receiveWired: null, lastError: null, relaysConnected: 0,
    lastInboundAt: null, decryptFailures: 0,
  });
});

test("setReceiveWired(false, err) records the failure; (true) clears it", () => {
  _resetReceiveHealth();
  setReceiveWired(false, new Error("DHT boom"));
  let h = getReceiveHealth();
  assert.equal(h.receiveWired, false);
  assert.equal(h.lastError, "DHT boom");
  setReceiveWired(true);
  h = getReceiveHealth();
  assert.equal(h.receiveWired, true);
  assert.equal(h.lastError, null);
});

test("setReceiveWired accepts a string error and a missing error", () => {
  _resetReceiveHealth();
  setReceiveWired(false, "plain string");
  assert.equal(getReceiveHealth().lastError, "plain string");
  setReceiveWired(false);
  assert.equal(getReceiveHealth().receiveWired, false);
  assert.equal(typeof getReceiveHealth().lastError, "string"); // some non-null placeholder
});

test("setRelaysConnected coerces; markInbound stamps; markDecryptFailure counts", () => {
  _resetReceiveHealth();
  setRelaysConnected(4);
  markInbound(1234567890);
  markDecryptFailure();
  markDecryptFailure();
  const h = getReceiveHealth();
  assert.equal(h.relaysConnected, 4);
  assert.equal(h.lastInboundAt, 1234567890);
  assert.equal(h.decryptFailures, 2);
  setRelaysConnected("not a number");
  assert.equal(getReceiveHealth().relaysConnected, 0);
});

test("getReceiveHealth returns a copy — mutating it does not leak back", () => {
  _resetReceiveHealth();
  const h = getReceiveHealth();
  h.receiveWired = true;
  assert.equal(getReceiveHealth().receiveWired, null);
});
