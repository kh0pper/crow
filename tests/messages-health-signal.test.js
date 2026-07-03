/**
 * messagesSignal — R7 (+R3 residual relay-state). Warn ONLY on
 * receiveWired===false or relaysConnected===0. A quiet mailbox (old/no
 * lastInboundAt) and a pending-outbound backlog NEVER warn. receiveWired null
 * (never attempted) renders off, no issue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectHealthSignals, invalidateHealthCache,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import {
  setReceiveWired, setRelaysConnected, markInbound, markDecryptFailure,
  _resetReceiveHealth,
} from "../servers/sharing/receive-health.js";

// Generic stub: message_retry_queue COUNT returns `retryRows`; everything else empty.
function makeDb(retryRows = 0) {
  return {
    execute: async ({ sql }) =>
      /FROM message_retry_queue/.test(sql)
        ? { rows: [{ n: retryRows }] }
        : { rows: [] },
  };
}

async function messagesDetail(db, now) {
  invalidateHealthCache();
  const r = await collectHealthSignals(db, now ? { now } : {});
  return {
    detail: r.details.find((d) => d.id === "messages"),
    issue: r.issues.find((i) => i.id === "messages"),
  };
}

test("never attempted (receiveWired null) → off, no issue", async () => {
  _resetReceiveHealth();
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "off");
  assert.equal(issue, undefined);
});

test("receiveWired=false → warn issue (R8's loud signal)", async () => {
  _resetReceiveHealth();
  setReceiveWired(false, new Error("DHT boom"));
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "warn");
  assert.ok(issue);
  assert.equal(issue.severity, "warn");
});

test("wired but 0 relays → warn", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(0);
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "warn");
  assert.ok(issue);
});

test("healthy: relays count in value, ok, no issue", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  const { detail, issue } = await messagesDetail(makeDb());
  assert.equal(detail.state, "ok");
  assert.match(detail.value, /4/);
  assert.equal(issue, undefined);
});

test("quiet mailbox: 10-day-old inbound stays ok (display-only)", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  const NOW = 1_800_000_000_000;
  markInbound(NOW - 10 * 24 * 60 * 60 * 1000);
  const { detail, issue } = await messagesDetail(makeDb(), () => NOW);
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /10d/);
});

test("pending outbound + decrypt failures are display-only, never an issue", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  markDecryptFailure();
  const { detail, issue } = await messagesDetail(makeDb(3));
  assert.equal(detail.state, "ok");
  assert.equal(issue, undefined);
  assert.match(detail.value, /3/); // pending count surfaced
});

test("retry-queue read failure degrades gracefully (still ok, no throw)", async () => {
  _resetReceiveHealth();
  setReceiveWired(true);
  setRelaysConnected(4);
  const badDb = { execute: async () => { throw new Error("db gone"); } };
  const { detail } = await messagesDetail(badDb);
  assert.equal(detail.state, "ok");
});
