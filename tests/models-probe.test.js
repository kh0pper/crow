import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probeHardware,
  fitBadge,
  getCachedProbe,
  reprobe,
} from "../servers/gateway/models/probe.js";

// ---------------------------------------------------------------------------
// Fixtures — provenance noted per block. See task-3-report.md for full detail.
// ---------------------------------------------------------------------------

// Captured verbatim (structure) from `vulkaninfo` (no args — the default
// --text mode) run on host crow, an AMD Ryzen AI Max+ 395 (RADV GFX1151,
// Mesa 25.2.8-0ubuntu0.24.04.1). Byte sizes for the DEVICE_LOCAL heap were
// swapped from crow's real 83 GiB unified-memory figure (not representative
// of a discrete card) to 17179869184 bytes = exactly 16 GiB, matching a
// typical discrete "AMD consumer GPU" (e.g. RX 7800 XT 16GB) fit-badge
// scenario. GPU1 (llvmpipe software rasterizer, deviceType
// PHYSICAL_DEVICE_TYPE_CPU) is real output shape too, kept to prove the
// parser skips CPU-type devices.
const VULKANINFO_AMD_NO_ROCM = `
==========
VULKANINFO
==========

Vulkan Instance Version: 1.3.275

Devices:
========
GPU0:
	apiVersion         = 1.4.318
	driverVersion      = 25.2.8
	vendorID           = 0x1002
	deviceID           = 0x1586
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = AMD Radeon RX 7800 XT (RADV NAVI32)
	driverID           = DRIVER_ID_MESA_RADV
	driverName         = radv
	driverInfo         = Mesa 25.2.8-0ubuntu0.24.04.1
	conformanceVersion = 1.4.0.0

VkPhysicalDeviceMemoryProperties:
=================================
memoryHeaps: count = 2
	memoryHeaps[0]:
		size   = 17179869184 (0x400000000) (16.00 GiB)
		budget = 15461330944 (0x399994000) (14.40 GiB)
		usage  = 0 (0x00000000) (0.00 B)
		flags: count = 1
			MEMORY_HEAP_DEVICE_LOCAL_BIT
	memoryHeaps[1]:
		size   = 8589934592 (0x200000000) (8.00 GiB)
		budget = 8589934592 (0x200000000) (8.00 GiB)
		usage  = 0 (0x00000000) (0.00 B)
		flags:
			None
memoryTypes: count = 4
	memoryTypes[0]:
		heapIndex     = 0
		propertyFlags = 0x0001: count = 1
			MEMORY_PROPERTY_DEVICE_LOCAL_BIT

GPU1:
	apiVersion         = 1.4.318
	driverVersion      = 25.2.8
	vendorID           = 0x10005
	deviceID           = 0x0000
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 20.1.2, 256 bits)
	driverID           = DRIVER_ID_MESA_LLVMPIPE
	driverName         = llvmpipe
	driverInfo         = Mesa 25.2.8-0ubuntu0.24.04.1 (LLVM 20.1.2)
	conformanceVersion = 1.3.1.1

VkPhysicalDeviceMemoryProperties:
=================================
memoryHeaps: count = 1
	memoryHeaps[0]:
		size   = 134155722752 (0x1f3c4de000) (124.94 GiB)
		budget = 134155722752 (0x1f3c4de000) (124.94 GiB)
		usage  = 133521686528 (0x1f16834000) (124.35 GiB)
		flags: count = 1
			MEMORY_HEAP_DEVICE_LOCAL_BIT
memoryTypes: count = 1
	memoryTypes[0]:
		heapIndex     = 0
		propertyFlags = 0x000f: count = 4
			MEMORY_PROPERTY_DEVICE_LOCAL_BIT
`;

// Real /proc/meminfo captured on host crow (field set + line format:
// `Key:  N kB`), values edited so MemAvailable is modest and SwapFree is
// deliberately huge — this is the fixture that proves swap is NEVER
// counted toward available RAM.
const MEMINFO_HUGE_SWAP = `MemTotal:       131011448 kB
MemFree:          610000 kB
MemAvailable:     512000 kB
Buffers:           18892 kB
Cached:           559944 kB
SwapCached:        86216 kB
Active:         17137232 kB
Inactive:       22296108 kB
SwapTotal:      20000000 kB
SwapFree:       19500000 kB
Dirty:              1352 kB
Writeback:              0 kB
`;

// Same real field shape, but no MemAvailable line at all — proves the
// "missing RAM info" fail-closed path (probe.ramAvailableMb === null).
const MEMINFO_NO_MEMAVAILABLE = `MemTotal:       131011448 kB
MemFree:          610000 kB
Buffers:           18892 kB
Cached:           559944 kB
SwapTotal:      20000000 kB
SwapFree:       19500000 kB
`;

// Documented `nvidia-smi --query-gpu=name,memory.total
// --format=csv,noheader,nounits` output shape (no NVIDIA GPU present on
// crow to capture directly — this is the well-known scripting invocation
// format used throughout NVIDIA's own docs and countless tooling).
const NVIDIA_SMI_CSV = `NVIDIA GeForce RTX 3080, 10240
`;

// Real rocminfo output captured on host crow (ROCm 7.2.1), trimmed to the
// CPU agent (Agent 1) + GPU agent (Agent 2, gfx1151) blocks, keeping the
// real field labels/ordering: Name, Marketing Name, Segment/Size pool
// lines under "Pool Info".
const ROCMINFO_AGENT_BLOCK = `ROCk module is loaded
=====================
HSA System Attributes
=====================
Runtime Version:         1.18

==========
HSA Agents
==========
*******
Agent 1
*******
  Name:                    AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
  Marketing Name:          AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
  Vendor Name:             CPU
  Device Type:             CPU
  Pool Info:
    Pool 1
      Segment:                 GLOBAL; FLAGS: FINE GRAINED
      Size:                    131011448(0x7cf1378) KB
      Allocatable:             TRUE
*******
Agent 2
*******
  Name:                    gfx1151
  Marketing Name:          AMD Radeon Graphics
  Vendor Name:             AMD
  Device Type:             GPU
  Pool Info:
    Pool 1
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    130023424(0x7c00000) KB
      Allocatable:             TRUE
`;

function fakeFs({ existsFiles = [], readFiles = {}, statfs = null } = {}) {
  return {
    existsSync(path) {
      return existsFiles.includes(path);
    },
    readFileSync(path, enc) {
      if (path in readFiles) return readFiles[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = "ENOENT";
      throw err;
    },
    statfsSync(path) {
      if (statfs === null) {
        const err = new Error(`ENOENT: ${path}`);
        err.code = "ENOENT";
        throw err;
      }
      if (typeof statfs === "function") return statfs(path);
      return statfs;
    },
  };
}

/**
 * Fake execFile matching node:child_process's callback signature:
 * execFile(file, args, options, callback).
 * `handlers` maps command name -> stdout string (success) or `null` (error).
 */
function fakeExecFile(handlers) {
  return (cmd, args, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    if (!(cmd in handlers) || handlers[cmd] === null) {
      cb(new Error(`${cmd}: command not found`));
      return;
    }
    cb(null, handlers[cmd], "");
  };
}

const ALL_FAIL_EXEC = fakeExecFile({});

// ---------------------------------------------------------------------------
// probeHardware — accelerator + VRAM detection
// ---------------------------------------------------------------------------

test("AMD host without ROCm: vulkaninfo succeeds -> accel vulkan, VRAM from DEVICE_LOCAL heap", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.platform, "linux");
  assert.equal(probe.wsl2, false);
  assert.equal(probe.accel, "vulkan");
  assert.equal(probe.gpuName, "AMD Radeon RX 7800 XT (RADV NAVI32)");
  assert.equal(probe.vramMb, 16384); // 17179869184 bytes / 1024 / 1024
});

test("WSL2 + nvidia-smi present -> accel forced cpu (v1 rule, no CUDA asset for linux)", async () => {
  const execFile = fakeExecFile({
    "nvidia-smi": NVIDIA_SMI_CSV,
    vulkaninfo: VULKANINFO_AMD_NO_ROCM,
  });
  const fs = fakeFs({
    existsFiles: ["/proc/sys/fs/binfmt_misc/WSLInterop"],
    readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP },
  });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "5.15.0-microsoft-standard-WSL2" });

  assert.equal(probe.wsl2, true);
  assert.equal(probe.accel, "cpu");
  assert.equal(probe.gpuName, null);
  assert.equal(probe.vramMb, null);
});

test("WSL2 detected via kernel release string fallback when WSLInterop file absent", async () => {
  const execFile = ALL_FAIL_EXEC;
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "5.15.0-microsoft-standard-WSL2" });

  assert.equal(probe.wsl2, true);
  assert.equal(probe.accel, "cpu");
});

test("nothing detectable at all -> null fields + names pushed to unknown", async () => {
  const execFile = ALL_FAIL_EXEC;
  const fs = fakeFs({}); // no WSLInterop, no /proc/meminfo, no statfs
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.wsl2, false);
  assert.equal(probe.accel, "cpu");
  assert.equal(probe.gpuName, null);
  assert.equal(probe.vramMb, null);
  assert.equal(probe.ramAvailableMb, null);
  assert.equal(probe.diskFreeMb, null);
  assert.ok(probe.unknown.includes("gpu"));
  assert.ok(probe.unknown.includes("ram"));
  assert.ok(probe.unknown.includes("disk"));
});

test("swap is never counted toward ramAvailableMb, even when swap is huge", async () => {
  const execFile = ALL_FAIL_EXEC;
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  // MemAvailable: 512000 kB -> 500 MB. SwapFree: 19500000 kB (~19 GB) must
  // NOT be added in, even though it dwarfs MemAvailable.
  assert.equal(probe.ramAvailableMb, 500);
});

test("missing MemAvailable line -> ramAvailableMb null + pushed to unknown (fail-closed)", async () => {
  const execFile = ALL_FAIL_EXEC;
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_NO_MEMAVAILABLE } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.ramAvailableMb, null);
  assert.ok(probe.unknown.includes("ram"));
});

test("nvidia-smi path used when vulkaninfo fails -> accel cuda", async () => {
  const execFile = fakeExecFile({ "nvidia-smi": NVIDIA_SMI_CSV });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.accel, "cuda");
  assert.equal(probe.gpuName, "NVIDIA GeForce RTX 3080");
  assert.equal(probe.vramMb, 10240);
});

test("rocminfo consulted when vulkaninfo and nvidia-smi both fail -> accel vulkan (AMD family)", async () => {
  const execFile = fakeExecFile({ rocminfo: ROCMINFO_AGENT_BLOCK });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.accel, "vulkan");
  assert.equal(probe.gpuName, "AMD Radeon Graphics");
  assert.equal(probe.vramMb, 126976); // 130023424 KB / 1024
});

test("darwin: accel metal, RAM from sysctl hw.memsize", async () => {
  const execFile = fakeExecFile({ sysctl: "34359738368\n" }); // 32 GiB
  const fs = fakeFs({});
  const probe = await probeHardware({ execFile, fs, platform: "darwin", release: "23.0.0" });

  assert.equal(probe.platform, "darwin");
  assert.equal(probe.accel, "metal");
  assert.equal(probe.ramAvailableMb, 32768);
});

test("disk free reported via fs.statfsSync when modelsDir given", async () => {
  const execFile = ALL_FAIL_EXEC;
  const fs = fakeFs({
    readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP },
    statfs: { bavail: 1000000, bsize: 4096 },
  });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic", modelsDir: "/home/kh0pp/.crow/models" });

  assert.equal(probe.diskFreeMb, Math.round((1000000 * 4096) / (1024 * 1024)));
  assert.ok(!probe.unknown.includes("disk"));
});

// ---------------------------------------------------------------------------
// fitBadge
// ---------------------------------------------------------------------------

test("fitBadge: available RAM meets min_ram_mb exactly -> fits", () => {
  const probe = { ramAvailableMb: 8000, vramMb: null };
  assert.equal(fitBadge(probe, { min_ram_mb: 8000, min_vram_mb: 0 }), "fits");
});

test("fitBadge: available RAM comfortably above min_ram_mb -> fits", () => {
  const probe = { ramAvailableMb: 16000, vramMb: null };
  assert.equal(fitBadge(probe, { min_ram_mb: 8000, min_vram_mb: 0 }), "fits");
});

test("fitBadge: exactly 10% over -> tight (boundary inclusive)", () => {
  const probe = { ramAvailableMb: 8000, vramMb: null };
  // minRam 8800 = effective 8000 * 1.10 exactly.
  assert.equal(fitBadge(probe, { min_ram_mb: 8800, min_vram_mb: 0 }), "tight");
});

test("fitBadge: just over the 10% edge -> wont_fit", () => {
  const probe = { ramAvailableMb: 8000, vramMb: null };
  assert.equal(fitBadge(probe, { min_ram_mb: 8801, min_vram_mb: 0 }), "wont_fit");
});

test("fitBadge: far over -> wont_fit", () => {
  const probe = { ramAvailableMb: 4000, vramMb: null };
  assert.equal(fitBadge(probe, { min_ram_mb: 16000, min_vram_mb: 0 }), "wont_fit");
});

test("fitBadge: ramAvailableMb null -> unknown, NEVER fits (fail-closed)", () => {
  const probe = { ramAvailableMb: null, vramMb: null };
  assert.equal(fitBadge(probe, { min_ram_mb: 1, min_vram_mb: 0 }), "unknown");
});

test("fitBadge: probe itself null/undefined -> unknown", () => {
  assert.equal(fitBadge(null, { min_ram_mb: 1000, min_vram_mb: 0 }), "unknown");
  assert.equal(fitBadge(undefined, { min_ram_mb: 1000, min_vram_mb: 0 }), "unknown");
});

test("fitBadge: sufficient VRAM counts toward the fit when min_vram_mb > 0", () => {
  // RAM alone falls short, but detected VRAM covers min_vram_mb and pushes
  // the effective total over min_ram_mb.
  const probe = { ramAvailableMb: 6000, vramMb: 12000 };
  const quant = { min_ram_mb: 16000, min_vram_mb: 8000 };
  // effective = 6000 + 12000 = 18000 >= 16000 -> fits
  assert.equal(fitBadge(probe, quant), "fits");
});

test("fitBadge: VRAM below min_vram_mb does NOT count toward the fit", () => {
  const probe = { ramAvailableMb: 6000, vramMb: 4000 }; // vramMb < min_vram_mb
  const quant = { min_ram_mb: 16000, min_vram_mb: 8000 };
  // effective stays 6000 (vram excluded) -> far short -> wont_fit
  assert.equal(fitBadge(probe, quant), "wont_fit");
});

test("fitBadge: min_vram_mb 0 (CPU-capable quant) never adds VRAM even if present", () => {
  const probe = { ramAvailableMb: 8000, vramMb: 24000 };
  const quant = { min_ram_mb: 8000, min_vram_mb: 0 };
  assert.equal(fitBadge(probe, quant), "fits"); // RAM alone already fits
});

// ---------------------------------------------------------------------------
// module-level cache: getCachedProbe / reprobe
// ---------------------------------------------------------------------------

test("getCachedProbe returns null before any reprobe in a fresh module state, then reprobe populates it", async () => {
  // This test must run before any other test in this file calls reprobe();
  // it is registered first among the cache tests and node:test executes a
  // single file's top-level tests in declaration order by default.
  assert.equal(getCachedProbe(), null);

  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });

  const fresh = await reprobe({ execFile, fs, platform: "linux", release: "6.8.0-generic" });
  assert.equal(fresh.accel, "vulkan");
  assert.strictEqual(getCachedProbe(), fresh);
});

test("reprobe forces a fresh probe even when hardware inputs changed", async () => {
  const fsA = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  await reprobe({ execFile: ALL_FAIL_EXEC, fs: fsA, platform: "linux", release: "6.8.0-generic" });
  assert.equal(getCachedProbe().accel, "cpu");

  const execFile2 = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fresh2 = await reprobe({ execFile: execFile2, fs: fsA, platform: "linux", release: "6.8.0-generic" });
  assert.equal(fresh2.accel, "vulkan");
  assert.strictEqual(getCachedProbe(), fresh2);
});
