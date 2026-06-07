import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRocminfoArches,
  parseRocminfoVramGb,
  parseNvidiaSmiVramGb,
} from "../servers/gateway/gpu-arch.js";

// Trimmed real `rocminfo` output from crow: CPU agent (larger pool), the
// gfx1151 GPU agent (124 GB pool), and the NPU agent. The parser must anchor
// VRAM to the GPU agent only — NOT the CPU agent's larger GLOBAL pool.
const ROCMINFO_FIXTURE = `
Agent 1
  Name:                    AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
  Vendor Name:             CPU
  Pool Info:
      Segment:                 GLOBAL; FLAGS: FINE GRAINED
      Size:                    131011452(0x7cf137c) KB
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
Agent 2
  Name:                    gfx1151
  Vendor Name:             AMD
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    130023424(0x7c00000) KB
      Segment:                 GROUP
      Size:                    64(0x40) KB
Agent 3
  Name:                    aie2p
  Vendor Name:             AMD
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
`;

test("parseRocminfoArches: finds gfx1151 only", () => {
  assert.deepEqual(parseRocminfoArches(ROCMINFO_FIXTURE), ["gfx1151"]);
});

test("parseRocminfoVramGb: anchors to GPU agent (124 GB, not CPU's 125)", () => {
  assert.equal(parseRocminfoVramGb(ROCMINFO_FIXTURE), 124);
});

test("parseRocminfoVramGb: returns null when no GPU agent present", () => {
  const cpuOnly = `
Agent 1
  Name:                    Some CPU
  Vendor Name:             CPU
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
`;
  assert.equal(parseRocminfoVramGb(cpuOnly), null);
});

test("parseNvidiaSmiVramGb: MiB rows -> max GB", () => {
  assert.equal(parseNvidiaSmiVramGb("16384\n24576\n"), 24);
});

test("parseNvidiaSmiVramGb: empty -> null", () => {
  assert.equal(parseNvidiaSmiVramGb(""), null);
});

import { checkGpuArchCompatible } from "../servers/gateway/gpu-arch.js";

const ROCM_HOST = ["gfx1151", "rocm", "cpu"];

test("compat: arch ok + VRAM fits -> ok", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 12 } };
  assert.equal(checkGpuArchCompatible(m, ROCM_HOST, 124).ok, true);
});

test("compat: arch ok + VRAM too small -> not ok, kind vram", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 200 } };
  const r = checkGpuArchCompatible(m, ROCM_HOST, 124);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "vram");
  assert.match(r.reason, /200 GB/);
});

test("compat: arch fails -> not ok, no vram kind (arch checked first)", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 8 } };
  const r = checkGpuArchCompatible(m, ["sm_86", "cuda", "cpu"], 8);
  assert.equal(r.ok, false);
  assert.notEqual(r.kind, "vram");
});

test("compat: VRAM unknown (null) -> fail open", () => {
  const m = { requires: { gpu: true, gpu_arch: ["gfx1151"], min_vram_gb: 999 } };
  assert.equal(checkGpuArchCompatible(m, ROCM_HOST, null).ok, true);
});

test("compat: CPU bundle (no gpu requirement) -> always ok", () => {
  const m = { requires: { platform: "linux-x86_64" } };
  assert.equal(checkGpuArchCompatible(m, ["cpu"], null).ok, true);
});
