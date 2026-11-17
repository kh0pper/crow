// tests/gpu-peaks.test.js
//
// The host profile (the private engineering notes, the host profile section)
// declares each provider's GPU footprint so a beside hold can decide whether a
// start fits. A missing or broken file must give the admission defaults and
// never throw: the measurement file is not the gate.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostProfilePath, readHostProfile, providerPeak, DEFAULT_HOST_PROFILE,
} from "../servers/gateway/models/gpu-peaks.js";

const DIR = mkdtempSync(join(tmpdir(), "gpu-peaks-"));
const ORIGINAL = process.env.CROW_GPU_HOST_PROFILE_PATH;
let seq = 0;

after(() => {
  if (ORIGINAL === undefined) delete process.env.CROW_GPU_HOST_PROFILE_PATH;
  else process.env.CROW_GPU_HOST_PROFILE_PATH = ORIGINAL;
  rmSync(DIR, { recursive: true, force: true });
});

/** Point the module at a fresh file (a new path always beats the cache). */
function useProfile(text) {
  const p = join(DIR, `profile-${seq++}.json`);
  if (text != null) writeFileSync(p, typeof text === "string" ? text : JSON.stringify(text));
  process.env.CROW_GPU_HOST_PROFILE_PATH = p;
  return p;
}

test("missing file gives defaults", () => {
  const p = useProfile(null);
  assert.equal(hostProfilePath(), p);
  const profile = readHostProfile();
  assert.equal(profile.safety_margin_mb, 8192);
  assert.equal(profile.ram_floor_mb, 12288);
  assert.equal(profile.cpu_lane_cpuset, "0-15");
  assert.equal(profile.prod_growth_mb, 6144);
  assert.deepEqual(profile.providers, {});
  assert.equal(profile.gtt_total_mb, undefined, "an unmeasured total stays unset");
  assert.equal(profile.kfd_limit, undefined);
  assert.equal(DEFAULT_HOST_PROFILE.safety_margin_mb, 8192);
});

test("corrupt file gives defaults", () => {
  useProfile("{not json");
  assert.deepEqual({ ...readHostProfile(), providers: {} }, { ...DEFAULT_HOST_PROFILE, providers: {} });
  useProfile("[1, 2, 3]");
  assert.deepEqual({ ...readHostProfile(), providers: {} }, { ...DEFAULT_HOST_PROFILE, providers: {} });
  useProfile({ safety_margin_mb: "lots", providers: "crow-chat" });
  const merged = readHostProfile();
  assert.equal(merged.safety_margin_mb, 8192, "a non-numeric field keeps the default");
  assert.deepEqual(merged.providers, {});
  // Never throws, even for a path that cannot be read at all.
  process.env.CROW_GPU_HOST_PROFILE_PATH = join(DIR, "no-such-dir", "profile.json");
  assert.equal(readHostProfile().ram_floor_mb, 12288);
});

test("provider peak lookup", () => {
  useProfile({
    gtt_total_mb: 131072,
    safety_margin_mb: 6144,
    providers: {
      "crow-chat": { gtt_peak_mb: 26000, host_ram_peak_mb: 27000 },
      "crow-embed": { gtt_peak_mb: 2000 },
      "crow-voice": { gtt_peak_mb: "8000", host_ram_peak_mb: 9000 },
    },
  });
  assert.deepEqual(providerPeak("crow-chat"), { gtt_peak_mb: 26000, host_ram_peak_mb: 27000 });
  assert.equal(providerPeak("crow-embed"), null, "half a peak is not a peak");
  assert.equal(providerPeak("crow-voice"), null, "a string is not a number");
  assert.equal(providerPeak("crow-unknown"), null);
  assert.equal(providerPeak(""), null);
  const profile = readHostProfile();
  assert.equal(profile.gtt_total_mb, 131072);
  assert.equal(profile.safety_margin_mb, 6144, "a valid field overrides its default");
  assert.equal(profile.ram_floor_mb, 12288, "the untouched default is still there");
});