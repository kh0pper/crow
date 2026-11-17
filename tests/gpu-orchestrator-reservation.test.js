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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as orch from "../servers/gateway/gpu-orchestrator.js";
import { ReservedError, _setProcessStartForTest } from "../servers/gateway/box-reservation.js";

// The beside holds below began on 2026-09-04. A hold that began BEFORE the
// gateway process is the unknown-tally case (sized at its full booking), so
// tell the gate this process has been up since before the fixtures — every
// case here is about a tally this process itself built.
_setProcessStartForTest(Date.parse("2026-01-01T00:00:00Z"));

const RES = Object.freeze({
  owner: "win", reason: "bench", started_at: "2026-09-04T20:00:00.000Z", expires_at: "2026-09-04T23:00:00.000Z",
  allow: ["crow-embed"], corrupt: false, key: "win@2026-09-04T20:00:00.000Z",
});
// A render/video job sharing the card: the beside-mode hold from the calendar.
const BESIDE = Object.freeze({
  owner: "gpujob-7f3a", reason: "render batch", started_at: "2026-09-04T20:00:00.000Z", expires_at: "2026-09-04T23:00:00.000Z",
  allow: ["crow-embed"], corrupt: false, key: "gpujob-7f3a@2026-09-04T20:00:00.000Z",
  mode: "beside", kind: "gpu-job", booking_id: "bk_0123456789ab", job_id: "job_42",
  gtt_mb: 50000, host_ram_mb: 30000, hip_procs: 4,
  gtt_used_at_activation_mb: null, mem_available_at_activation_mb: null,
});
const LIVE = Object.freeze({ gttUsedMb: 20000, gttTotalMb: 131072, memAvailableMb: 110000 });
const cfg = {
  providers: {
    "crow-chat":  { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local" },
    "crow-embed": { bundleId: "llamacpp-vulkan-qwen3-embed",   baseUrl: "http://127.0.0.1:8005/v1", host: "local" },
  },
};
const notReady = async () => false;
const mustNotStart = async () => { throw new Error("must not start"); };

let logs, origLog;
let profileDir;
const ORIGINAL_PROFILE_PATH = process.env.CROW_GPU_HOST_PROFILE_PATH;

/** Write a host profile into a fresh file and point the process at it. */
function useHostProfile(providers) {
  const p = join(profileDir, `profile-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ gtt_total_mb: 131072, safety_margin_mb: 8192, ram_floor_mb: 12288, providers }));
  process.env.CROW_GPU_HOST_PROFILE_PATH = p;
  return p;
}

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), "orch-peaks-"));
  orch._setReservationReaderForTest(null);
  orch._setLiveMemReaderForTest(null);
  orch._resetReservationNoticesForTest();
  orch._resetAdmittedForTest();
  // The default notice sender writes a notification row through createDbClient().
  // Every test here trips a notice (deferred residency, refusals), so the sender
  // MUST be stubbed for the whole file — run raw (outside scripts/run-suite.mjs's
  // scratch env) the default would land rows in the operator's live crow.db.
  // (It did, on 2026-09-04: 16 phantom "Box reserved by win" notifications.)
  orch._setReservationNoticeSenderForTest(async () => {});
  logs = []; origLog = console.log; console.log = (m) => logs.push(String(m));
});
afterEach(() => {
  console.log = origLog;
  orch._setReservationReaderForTest(null);
  orch._setLiveMemReaderForTest(null);
  orch._setReservationNoticeSenderForTest(null);
  orch._resetAdmittedForTest();
  if (ORIGINAL_PROFILE_PATH === undefined) delete process.env.CROW_GPU_HOST_PROFILE_PATH;
  else process.env.CROW_GPU_HOST_PROFILE_PATH = ORIGINAL_PROFILE_PATH;
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

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

// --- beside holds: a render/video job sharing the card --------------------
//
// An exclusive hold keeps today's rule (allow[] only). A beside hold lets a
// start through when the provider's declared peak fits next to the job's
// remaining footprint; otherwise the start is refused with reason
// "gpu_job_beside" on the same box_reserved path.

test("exclusive holds ignore the sampler", async () => {
  let liveReads = 0;
  orch._setLiveMemReaderForTest(() => {
    liveReads++;
    throw new Error("an exclusive hold must never read the live snapshot");
  });
  useHostProfile({ "crow-chat": { gtt_peak_mb: 1000, host_ram_peak_mb: 1000 } });
  orch._setReservationReaderForTest(() => RES);
  let started = 0;
  const opts = { cfg, probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {} };
  await assert.rejects(
    () => orch.acquireProvider("crow-chat", { ...opts, bundleUpFn: mustNotStart }),
    (e) => e instanceof ReservedError && e.reason === "reserved",
  );
  assert.equal(await orch.acquireProvider("crow-embed", opts), true, "the allow list still decides");
  assert.equal(started, 1);
  assert.equal(liveReads, 0, "the live snapshot is a beside-mode input only");
});

test("beside hold: a provider whose peak fits starts", async () => {
  useHostProfile({ "crow-chat": { gtt_peak_mb: 26000, host_ram_peak_mb: 26000 } });
  orch._setReservationReaderForTest(() => BESIDE);
  orch._setLiveMemReaderForTest(() => ({ ...LIVE, at: Date.now() }));
  let started = 0;
  const r = await orch.acquireProvider("crow-chat", {
    cfg, probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {},
  });
  assert.equal(r, true);
  assert.equal(started, 1);
  assert.ok(!logs.some((l) => /refusing/.test(l)), logs.join("\n"));
});

test("beside hold: refusal is a ReservedError with reason gpu_job_beside", async () => {
  useHostProfile({ "crow-chat": { gtt_peak_mb: 80000, host_ram_peak_mb: 26000 } });
  orch._setReservationReaderForTest(() => BESIDE);
  orch._setLiveMemReaderForTest(() => ({ ...LIVE, at: Date.now() }));
  let started = 0;
  await assert.rejects(
    () => orch.acquireProvider("crow-chat", {
      cfg, probeReadyFn: notReady, bundleUpFn: async () => { started++; }, waitForReadyFn: async () => true, bundleStopFn: async () => {},
    }),
    (e) => e instanceof ReservedError
      && e.code === "box_reserved"
      && e.reason === "gpu_job_beside"
      && e.owner === "gpujob-7f3a"
      && e.expires_at === BESIDE.expires_at
      && /render\/video job/.test(e.message),
  );
  assert.equal(started, 0, "nothing was started");
  assert.ok(logs.some((l) => /refusing to start crow-chat/.test(l)), logs.join("\n"));
});

// --- admitted-peak accounting: growth the gateway caused is not the job's ---
//
// `startDecision` subtracts the declared peaks of the providers this gateway
// started beside the hold from the live growth, so their footprint is not read
// as the job's own progress. The tally is keyed by the hold key.

const HOLD_A = Object.freeze({
  owner: "gpujob-a", reason: "render batch", started_at: "2026-09-04T20:00:00.000Z", expires_at: "2026-09-04T23:00:00.000Z",
  allow: ["crow-embed"], corrupt: false, key: "gpujob-a@2026-09-04T20:00:00.000Z",
  mode: "beside", kind: "gpu-job", booking_id: "bk_00000000000a", job_id: "job_a",
  gtt_mb: 40000, host_ram_mb: 30000, hip_procs: 2,
  gtt_used_at_activation_mb: 60000, mem_available_at_activation_mb: 100000,
});
// A second hold: same numbers, different key (it began half an hour later).
const HOLD_B = Object.freeze({
  ...HOLD_A,
  owner: "gpujob-b", started_at: "2026-09-04T20:30:00.000Z",
  key: "gpujob-b@2026-09-04T20:30:00.000Z", booking_id: "bk_00000000000b", job_id: "job_b",
});
const LIVE_BESIDE = Object.freeze({ gttUsedMb: 75000, gttTotalMb: 131072, memAvailableMb: 96000 });
const cfgBeside = {
  providers: {
    "crow-small": { bundleId: "llamacpp-vulkan-qwen3-embed", baseUrl: "http://127.0.0.1:8005/v1", host: "local" },
    "crow-chat": { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local" },
  },
};

/** An acquireProvider's opts that start (counting into `started`) and warm up. */
function besideOpts(started) {
  return {
    cfg: cfgBeside, probeReadyFn: notReady, bundleUpFn: async () => { started.push(1); },
    waitForReadyFn: async () => true, bundleStopFn: async () => {},
  };
}

test("admitted peaks are per hold key and reset when the hold changes", async () => {
  // 10000 mb of prod peak beside the job, and the job's own booking is 40000.
  useHostProfile({
    "crow-small": { gtt_peak_mb: 10000, host_ram_peak_mb: 1000 },
    "crow-chat": { gtt_peak_mb: 20000, host_ram_peak_mb: 1000 },
  });
  orch._setLiveMemReaderForTest(() => ({ ...LIVE_BESIDE, at: Date.now() }));
  const started = [];

  // Under hold A the small provider (10000) fits and is admitted.
  orch._setReservationReaderForTest(() => HOLD_A);
  assert.equal(await orch.acquireProvider("crow-small", besideOpts(started)), true);
  assert.equal(started.length, 1);

  // Its peak is added back out, so the job still has 35000 of its booking to
  // take: 75000 + 35000 + 20000 does not fit. Without the tally (25000
  // remaining) this start would be admitted.
  await assert.rejects(
    () => orch.acquireProvider("crow-chat", { ...besideOpts(started), bundleUpFn: mustNotStart }),
    (e) => e instanceof ReservedError && e.reason === "gpu_job_beside",
  );
  assert.equal(started.length, 1, "the refused start never reached bundleUp");

  // A different hold key starts from an empty tally: the same start is allowed,
  // which also prunes hold A's entries (only the live key's map is kept).
  orch._setReservationReaderForTest(() => HOLD_B);
  assert.equal(await orch.acquireProvider("crow-chat", besideOpts(started)), true);

  // Back under hold A the entries recorded before B went live are gone, so the
  // start it refused above is admitted again.
  orch._setReservationReaderForTest(() => HOLD_A);
  assert.equal(await orch.acquireProvider("crow-chat", besideOpts(started)), true);

  // The seam forgets everything.
  orch._resetAdmittedForTest();
  assert.equal(await orch.acquireProvider("crow-chat", besideOpts(started)), true);
});

test("a job over its booking is refused and the over-budget line is logged once", async () => {
  useHostProfile({
    "crow-chat": { gtt_peak_mb: 1000, host_ram_peak_mb: 1000 },
  });
  // 105000 - 60000 = 45000 mb of growth against a 40000 mb booking.
  orch._setLiveMemReaderForTest(() => ({
    gttUsedMb: 105000, gttTotalMb: 131072, memAvailableMb: 97000, at: Date.now(),
  }));
  orch._setReservationReaderForTest(() => HOLD_A);
  const started = [];
  const cfgTwo = {
    providers: {
      "crow-chat": { bundleId: "llamacpp-vulkan-qwen36-35b-a3b", baseUrl: "http://127.0.0.1:8003/v1", host: "local" },
      "crow-embed": { bundleId: "llamacpp-vulkan-qwen3-embed", baseUrl: "http://127.0.0.1:8005/v1", host: "local" },
    },
  };
  const opts = { ...besideOpts(started), cfg: cfgTwo };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      () => orch.acquireProvider("crow-chat", { ...opts, bundleUpFn: mustNotStart }),
      (e) => e instanceof ReservedError && e.reason === "gpu_job_beside",
    );
  }
  assert.equal(started.length, 0);
  assert.equal(
    logs.filter((l) => /gpu job exceeded its booked footprint/.test(l)).length, 1,
    logs.join("\n"),
  );
  // The allow list is still exempt from the over-budget refusal.
  assert.equal(await orch.acquireProvider("crow-embed", opts), true);
  assert.equal(started.length, 1);
});
