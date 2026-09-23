import { test } from "node:test";
import assert from "node:assert/strict";
import { hostLaunchDefaults, GFX1151_VULKAN_DEFAULTS } from "../servers/gateway/models/host-profile.js";
import { validateLaunch } from "../servers/gateway/models/launch.js";

test("hostLaunchDefaults: gfx1151 + vulkan -> pi-lab's flags", () => {
  assert.deepEqual(hostLaunchDefaults({ gpuArch: "gfx1151", accel: "vulkan" }), { flash_attn: "on", no_mmap: true, no_op_offload: true });
});

test("hostLaunchDefaults: the profile is itself a valid launch block", () => {
  assert.deepEqual(validateLaunch(hostLaunchDefaults({ gpuArch: "gfx1151", accel: "vulkan" })), []);
});

test("hostLaunchDefaults: gfx1151 on cpu -> null", () => {
  assert.equal(hostLaunchDefaults({ gpuArch: "gfx1151", accel: "cpu" }), null);
});

test("hostLaunchDefaults: another arch, or no arch, on vulkan -> null", () => {
  assert.equal(hostLaunchDefaults({ gpuArch: "gfx1100", accel: "vulkan" }), null);
  assert.equal(hostLaunchDefaults({ gpuArch: null, accel: "vulkan" }), null);
  assert.equal(hostLaunchDefaults({ accel: "cuda" }), null);
});

test("hostLaunchDefaults: null/undefined probe -> null", () => {
  assert.equal(hostLaunchDefaults(null), null);
  assert.equal(hostLaunchDefaults(undefined), null);
});

test("hostLaunchDefaults: returns a fresh object — mutating it never leaks into the next call or the frozen constant", () => {
  const a = hostLaunchDefaults({ gpuArch: "gfx1151", accel: "vulkan" });
  a.no_mmap = false;
  assert.equal(hostLaunchDefaults({ gpuArch: "gfx1151", accel: "vulkan" }).no_mmap, true);
  assert.ok(Object.isFrozen(GFX1151_VULKAN_DEFAULTS));
});
