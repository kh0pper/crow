// tests/gpu-orchestrator-reservation.test.js
//
// The reservation gate (scope §3.2): while the box is reserved, the
// orchestrator refuses to START any provider the reservation did not allow —
// on every path that can start one (on-demand acquire, boot/retry residency,
// idle-revert) — and never touches a provider that is already running.
// Loopback baseUrls are "local everywhere" (see gpu-orchestrator-host-gate),
// so these providers are orchestratable without pinning ownAddrs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as orch from "../servers/gateway/gpu-orchestrator.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";

const RES = Object.freeze({
  owner: "win", reason: "bench", started_at: "2026-09-04T20:00:00.000Z", expires_at: "2026-09-04T23:00:00.000Z",
  allow: ["crow-embed"], corrupt: false, key: "win@2026-09-04T20:00:00.000Z",
});
const cfg = {
  providers: {
    "crow-chat":  { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local" },
    "crow-embed": { bundleId: "llamacpp-vulkan-qwen3-embed",   baseUrl: "http://127.0.0.1:8005/v1", host: "local" },
  },
};
const notReady = async () => false;
const mustNotStart = async () => { throw new Error("must not start"); };

let logs, origLog;
beforeEach(() => {
  orch._setReservationReaderForTest(null);
  orch._resetReservationNoticesForTest();
  logs = []; origLog = console.log; console.log = (m) => logs.push(String(m));
});
afterEach(() => { console.log = origLog; orch._setReservationReaderForTest(null); });

test("reserved + provider not ready + not allowed -> ReservedError; bundleUp never called", async () => {
  orch._setReservationReaderForTest(() => RES);
  let started = 0;
  await assert.rejects(
    () => orch.acquireProvider("crow-chat", { cfg, probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} }),
    (e) => e instanceof ReservedError && e.code === "box_reserved" && e.owner === "win" && e.provider === "crow-chat" && e.expires_at === RES.expires_at
  );
  assert.equal(started, 0);
  assert.ok(logs.some((l) => /refusing to start crow-chat.*box reserved by win/.test(l)), logs.join("\n"));
});

test("reserved + provider already ready -> true, nothing started, nothing logged as refused", async () => {
  orch._setReservationReaderForTest(() => RES);
  const r = await orch.acquireProvider("crow-chat", { cfg, probeReadyFn: async () => true, bundleUpFn: mustNotStart });
  assert.equal(r, true);
  assert.ok(!logs.some((l) => /refusing/.test(l)));
});

test("reserved + allowed provider (default allow) -> starts normally", async () => {
  orch._setReservationReaderForTest(() => RES);
  let started = 0;
  const r = await orch.acquireProvider("crow-embed", { cfg, probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} });
  assert.equal(r, true);
  assert.equal(started, 1);
});

test("no reservation -> unchanged: starts", async () => {
  let started = 0;
  const r = await orch.acquireProvider("crow-chat", { cfg, probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} });
  assert.equal(r, true);
  assert.equal(started, 1);
});

test("corrupt reservation file -> reserved (fail closed) for every provider incl. the default allow", async () => {
  orch._setReservationReaderForTest(() => ({ owner: "unknown", reason: "unreadable reservation file", started_at: null, expires_at: null, allow: [], corrupt: true, key: "corrupt" }));
  await assert.rejects(
    () => orch.acquireProvider("crow-embed", { cfg, probeReadyFn: notReady, bundleUpFn: mustNotStart }),
    (e) => e instanceof ReservedError && e.owner === "unknown"
  );
});

test("maybeAcquireLocalProvider RETHROWS ReservedError (callers must see it) but still swallows other failures", async () => {
  orch._setReservationReaderForTest(() => RES);
  await assert.rejects(
    () => orch.maybeAcquireLocalProvider("crow-chat", { cfg, probeReadyFn: notReady, bundleUpFn: mustNotStart }),
    (e) => e instanceof ReservedError
  );
  orch._setReservationReaderForTest(null);
  const seen = [];
  const r = await orch.maybeAcquireLocalProvider("crow-chat", { cfg, probeReadyFn: notReady, bundleUpFn: async () => { throw new Error("compose exploded"); }, onError: (e) => seen.push(e.message) });
  assert.equal(r, false);
  assert.deepEqual(seen, ["compose exploded"]);
});

test("ensureResident defers while reserved (once-per-reservation log), never starts; resumes when the reservation is gone", async () => {
  orch._setReservationReaderForTest(() => RES);
  const opts = { probeReadyFn: notReady, bundleUpFn: mustNotStart, waitForReadyFn: async () => true };
  assert.equal(await orch.ensureResident("crow-chat", cfg, opts), false);
  assert.equal(await orch.ensureResident("crow-chat", cfg, opts), false);
  assert.equal(logs.filter((l) => /residency deferred: box reserved by win until 2026-09-04T23:00:00\.000Z/.test(l)).length, 1, logs.join("\n"));
  orch._setReservationReaderForTest(null);
  let started = 0;
  assert.equal(await orch.ensureResident("crow-chat", cfg, { probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true }), false, "not embed-capable -> false, but it DID start");
  assert.equal(started, 1);
});

test("ensureResident while reserved still reports an allowed provider normally", async () => {
  orch._setReservationReaderForTest(() => RES);
  let started = 0;
  await orch.ensureResident("crow-embed", cfg, { probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true });
  assert.equal(started, 1);
});

test("retryDeferredResidents keeps a blocked name parked (not dropped) while reserved", async () => {
  orch._setReservationReaderForTest(() => RES);
  orch._setDeferredResidentsForTest(["crow-chat"]);
  const ensured = [];
  const ensure = async (name) => { ensured.push(name); return false; };
  assert.deepEqual(await orch.retryDeferredResidents({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure }), []);
  assert.deepEqual(ensured, []);
  orch._setReservationReaderForTest(null);
  assert.deepEqual(await orch.retryDeferredResidents({ cfg, ownAddrs: new Set(["127.0.0.1"]), ensure }), ["crow-chat"]);
  assert.deepEqual(ensured, ["crow-chat"]);
  orch._setDeferredResidentsForTest([]);
});

test("refusal notices: the first refused start per reservation is handed to the notifier once", async () => {
  const notices = [];
  orch._setReservationNoticeSenderForTest(async (n) => { notices.push(n.kind + ":" + (n.refused ? n.refused.provider : "")); });
  orch._setReservationReaderForTest(() => RES);
  const opts = { cfg, probeReadyFn: notReady, bundleUpFn: mustNotStart, requester: "10.0.0.5 ua=x client=companion" };
  await assert.rejects(() => orch.acquireProvider("crow-chat", opts));
  await assert.rejects(() => orch.acquireProvider("crow-chat", opts));
  await new Promise((r) => setTimeout(r, 5)); // fire-and-forget sender
  assert.deepEqual(notices, ["start:", "refused:crow-chat"]);
});
