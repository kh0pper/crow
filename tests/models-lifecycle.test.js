// tests/models-lifecycle.test.js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore, buildModelsListing, JOB_STATES } from "../servers/gateway/models/lifecycle.js";
import { _setLiveSnapshotForTest } from "../servers/gateway/models/live-sampler.js";

test("job store: create, update, activeFor, eviction of old finished jobs", () => {
  let t = 1000, n = 0;
  const s = createJobStore({ now: () => t, maxJobs: 2, idFn: () => `j${++n}` });
  const a = s.create("crow-chat");
  assert.equal(a.state, "queued");
  assert.equal(s.activeFor("crow-chat").id, "j1");
  t = 2000;
  s.update("j1", { state: "resident" });
  assert.equal(s.get("j1").updatedAt, 2000);
  assert.equal(s.activeFor("crow-chat"), null, "a resident job is finished");
  s.create("a"); s.create("b");
  assert.equal(s.get("j1"), null, "oldest finished job evicted past maxJobs");
  assert.throws(() => s.update("j2", { state: "nope" }), /unknown job state/);
  assert.deepEqual(JOB_STATES, ["queued", "evicting", "starting", "resident", "failed", "blocked_by_reservation"]);
});

const providers = {
  "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", mutexGroup: "crow-strix-vram", port: 18102 } },
  "crow-local-27b-512k": { models: [{ id: "qwen3.8-27b-512k" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", mutexGroup: "crow-strix-vram", port: 18104 } },
  "crow-local-27b": { models: [{ id: "qwen3.8-27b" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "r4-gemma": { models: [{ id: "gemma-4-e2b-it" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "qwen-cloud": { models: [{ id: "x" }], baseUrl: "https://example.com/v1" },
};

test("listing: resident/stopped/blocked, wouldEvict lists resident siblings, external and foreign rows, cloud omitted", () => {
  const rows = buildModelsListing({
    providers,
    ownInstanceId: "me",
    snapshotOf: (name) => (name === "crow-chat" ? { live: true, argv: ["--model", "/m.gguf"] } : null),
    jobs: { activeFor: () => null },
    reservation: { owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: ["crow-chat"] },
    externalHealth: { "crow-local-27b": { ready: true } },
    siblingsOf: (name) => (name === "crow-local-27b-512k" ? ["crow-chat"] : name === "crow-chat" ? ["crow-local-27b-512k"] : []),
  });
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.equal(by["crow-chat"].status, "resident");
  assert.deepEqual(by["crow-chat"].argv, ["--model", "/m.gguf"]);
  assert.equal(by["crow-local-27b-512k"].status, "blocked_by_reservation", "not on the allow list while reserved");
  assert.deepEqual(by["crow-local-27b-512k"].wouldEvict, ["crow-chat"], "only RESIDENT siblings");
  assert.equal(by["crow-local-27b"].status, "external_up");
  assert.equal(by["crow-local-27b"].managed, "external");
  assert.equal(by["r4-gemma"].status, "foreign");
  assert.equal(by["r4-gemma"].owner, "r4");
  assert.equal(by["qwen-cloud"], undefined);
});

test("listing: an active job reports loading", () => {
  const rows = buildModelsListing({
    providers: { "crow-chat": providers["crow-chat"] }, ownInstanceId: "me", snapshotOf: () => null,
    jobs: { activeFor: () => ({ id: "j1", state: "starting" }) }, reservation: null, externalHealth: {}, siblingsOf: () => [],
  });
  assert.equal(rows[0].status, "loading");
});

// A beside hold (a render/video job sharing the card): the providers
// startDecision refuses wait for it, the ones that fit keep their normal
// status, and an exclusive hold keeps today's blocked_by_reservation.

const ORIGINAL_PROFILE_PATH = process.env.CROW_GPU_HOST_PROFILE_PATH;
let peakDir = null;

function useHostProfile(peakProviders) {
  peakDir = mkdtempSync(join(tmpdir(), "lifecycle-peaks-"));
  const p = join(peakDir, "gpu-host-profile.json");
  writeFileSync(p, JSON.stringify({
    gtt_total_mb: 131072, safety_margin_mb: 8192, ram_floor_mb: 12288, providers: peakProviders,
  }));
  process.env.CROW_GPU_HOST_PROFILE_PATH = p;
}

afterEach(() => {
  _setLiveSnapshotForTest(undefined);
  if (ORIGINAL_PROFILE_PATH === undefined) delete process.env.CROW_GPU_HOST_PROFILE_PATH;
  else process.env.CROW_GPU_HOST_PROFILE_PATH = ORIGINAL_PROFILE_PATH;
  if (peakDir) { rmSync(peakDir, { recursive: true, force: true }); peakDir = null; }
});

const besideProviders = {
  "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.6-35b-a3b", port: 18102 } },
  "crow-local-27b-512k": { models: [{ id: "qwen3.8-27b-512k" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.8-27b", port: 18104 } },
  "crow-unmeasured": { models: [{ id: "unmeasured" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18106/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "unmeasured", port: 18106 } },
};

const BESIDE_HOLD = Object.freeze({
  owner: "gpujob-7f3a", reason: "render batch", started_at: "2026-10-05T10:00:00.000Z", expires_at: "2026-10-05T12:00:00.000Z",
  allow: ["crow-chat"], corrupt: false, key: "gpujob-7f3a@2026-10-05T10:00:00.000Z",
  mode: "beside", kind: "gpu-job", booking_id: "bk_0123456789ab", job_id: "job_42",
  gtt_mb: 50000, host_ram_mb: 30000, hip_procs: 4,
  gtt_used_at_activation_mb: null, mem_available_at_activation_mb: null,
});

function listUnder(reservation) {
  return Object.fromEntries(buildModelsListing({
    providers: besideProviders, ownInstanceId: "me", snapshotOf: () => null,
    jobs: { activeFor: () => null }, reservation, externalHealth: {}, siblingsOf: () => [],
  }).map((r) => [r.provider, r]));
}

test("catalog status under a beside hold is beside_job only for refused providers", () => {
  useHostProfile({
    "crow-chat": { gtt_peak_mb: 26000, host_ram_peak_mb: 26000 },
    "crow-local-27b-512k": { gtt_peak_mb: 90000, host_ram_peak_mb: 40000 },
  });
  _setLiveSnapshotForTest({ gttUsedMb: 20000, gttTotalMb: 131072, memAvailableMb: 110000, at: Date.now() });

  const by = listUnder(BESIDE_HOLD);
  assert.equal(by["crow-chat"].status, "stopped", "on the allow list: it keeps its normal status");
  assert.equal(by["crow-local-27b-512k"].status, "beside_job", "its peak does not fit beside the job");
  assert.equal(by["crow-unmeasured"].status, "beside_job", "no declared peak: refused (fail closed)");

  // An exclusive hold keeps today's rule for the same providers.
  const exclusive = { ...BESIDE_HOLD, mode: "exclusive", key: "gpujob-7f3a@2026-10-05T10:00:00.000Z" };
  const ex = listUnder(exclusive);
  assert.equal(ex["crow-chat"].status, "stopped");
  assert.equal(ex["crow-local-27b-512k"].status, "blocked_by_reservation");
  assert.equal(ex["crow-unmeasured"].status, "blocked_by_reservation");
});
