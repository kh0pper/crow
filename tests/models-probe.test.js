import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probeHardware,
  fitBadge,
  getCachedProbe,
  reprobe,
  parseVulkaninfo,
  parseRocminfo,
  parseGfxArch,
  parseMemTotalMb,
  readAmdgpuMem,
} from "../servers/gateway/models/probe.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

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

// Captured from `vulkaninfo` on host crow 2026-09-23 (Mesa 25.2.8, RADV
// GFX1151), trimmed to the header + memory-heap blocks. Byte sizes are
// crow's real ones: heap0 41.50 GiB host-visible (no DEVICE_LOCAL flag),
// heap1 83.00 GiB DEVICE_LOCAL — a slice of the same unified pool as RAM.
const VULKANINFO_CROW_UNIFIED = `
==========
VULKANINFO
==========

Devices:
========
GPU0:
VkPhysicalDeviceProperties:
---------------------------
	apiVersion        = 1.4.318 (4211006)
	driverVersion     = 25.2.8 (104865800)
	vendorID          = 0x1002
	deviceID          = 0x1586
	deviceType        = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
	deviceName        = AMD Radeon Graphics (RADV GFX1151)

VkPhysicalDeviceMemoryProperties:
=================================
memoryHeaps: count = 2
	memoryHeaps[0]:
		size   = 44560285696 (0xa60000000) (41.50 GiB)
		budget = 23818784768 (0x58bb5d000) (22.18 GiB)
		usage  = 0 (0x00000000) (0.00 B)
		flags:
			None
	memoryHeaps[1]:
		size   = 89120571392 (0x14c0000000) (83.00 GiB)
		budget = 47637569536 (0xb176ba000) (44.37 GiB)
		usage  = 0 (0x00000000) (0.00 B)
		flags: count = 1
			MEMORY_HEAP_DEVICE_LOCAL_BIT
memoryTypes: count = 11
`;

// A mixed-vendor host: Vulkan's chosen device is an Intel INTEGRATED_GPU
// (laptop iGPU), while a separate discrete AMD card is also present as the
// host's only amdgpu sysfs card (see SYSFS_DISCRETE_AMD below, reused as
// that card). readAmdgpuMem always returns the amdgpu card with the
// smallest vram_total, which on this host is the dGPU itself (there is no
// smaller amdgpu card to beat it) — its GTT aperture must NOT be surfaced
// as a unified-memory ceiling just because Vulkan judged unrelated
// hardware "integrated".
const VULKANINFO_INTEL_INTEGRATED = `
==========
VULKANINFO
==========

Devices:
========
GPU0:
VkPhysicalDeviceProperties:
---------------------------
	apiVersion        = 1.3.275 (4206699)
	driverVersion     = 23.2.1 (0)
	vendorID          = 0x8086
	deviceID          = 0x9a49
	deviceType        = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
	deviceName        = Intel(R) Iris(R) Xe Graphics (TGL GT2)

VkPhysicalDeviceMemoryProperties:
=================================
memoryHeaps: count = 1
	memoryHeaps[0]:
		size   = 4294967296 (0x100000000) (4.00 GiB)
		budget = 3221225472 (0xc0000000) (3.00 GiB)
		usage  = 0 (0x00000000) (0.00 B)
		flags: count = 1
			MEMORY_HEAP_DEVICE_LOCAL_BIT
memoryTypes: count = 1
`;

// crow's real amdgpu sysfs values (spec §1): 512 MiB BIOS carve-out,
// GTT sized by amdgpu.gttsize=126976. /sys/class/drm listing is crow's
// real one (connector entries, renderD128 and version included).
const DRM_DIRS_CROW = {
  "/sys/class/drm": ["card0", "card0-DP-1", "card0-DP-2", "card0-HDMI-A-1", "card0-Writeback-1", "renderD128", "version"],
};
const SYSFS_CROW = {
  "/sys/class/drm/card0/device/mem_info_vram_total": "536870912\n",
  "/sys/class/drm/card0/device/mem_info_gtt_total": "133143986176\n",
  "/sys/class/drm/card0/device/mem_info_gtt_used": "61800000000\n",
};

// A discrete AMD card's sysfs: 16 GiB VRAM carve-out (way above the 2 GiB
// unified threshold) alongside its own (small) GTT aperture.
const SYSFS_DISCRETE_AMD = {
  "/sys/class/drm/card0/device/mem_info_vram_total": "17179869184\n",
  "/sys/class/drm/card0/device/mem_info_gtt_total": "8589934592\n",
  "/sys/class/drm/card0/device/mem_info_gtt_used": "1048576\n",
};

// Two amdgpu cards: an APU's iGPU (card0, 512 MiB carve-out) beside a
// discrete card (card1, 16 GiB). Vulkan picks the discrete one.
const DRM_DIRS_TWO_CARDS = { "/sys/class/drm": ["card0", "card0-eDP-1", "card1", "card1-DP-1", "renderD128", "renderD129", "version"] };
const SYSFS_TWO_CARDS = {
  "/sys/class/drm/card0/device/mem_info_vram_total": "536870912\n",
  "/sys/class/drm/card0/device/mem_info_gtt_total": "33554432000\n",
  "/sys/class/drm/card0/device/mem_info_gtt_used": "1048576\n",
  "/sys/class/drm/card1/device/mem_info_vram_total": "17179869184\n",
  "/sys/class/drm/card1/device/mem_info_gtt_total": "8589934592\n",
  "/sys/class/drm/card1/device/mem_info_gtt_used": "1048576\n",
};

// A small (2 GiB) discrete card: at the heuristic's threshold, but Vulkan
// says DISCRETE, and Vulkan wins.
const SYSFS_SMALL_DISCRETE = {
  "/sys/class/drm/card0/device/mem_info_vram_total": "2147483648\n",
  "/sys/class/drm/card0/device/mem_info_gtt_total": "8589934592\n",
};

function fakeFs({ existsFiles = [], readFiles = {}, statfs = null, dirs = {} } = {}) {
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
    readdirSync(path) {
      if (path in dirs) return dirs[path];
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
// Strix Halo spec §2.1 — unified memory, GTT, gpuArch, MemTotal
// ---------------------------------------------------------------------------

test("parseVulkaninfo: crow's excerpt -> INTEGRATED_GPU, gfx1151, DEVICE_LOCAL heap still reported as vramMb", () => {
  assert.deepEqual(parseVulkaninfo(VULKANINFO_CROW_UNIFIED), {
    name: "AMD Radeon Graphics (RADV GFX1151)",
    vramMb: 84992, // 89120571392 / 1024 / 1024 — the heap, unchanged meaning
    deviceType: "PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU",
    arch: "gfx1151",
  });
});

test("parseVulkaninfo: discrete sample -> DISCRETE_GPU, no gfx token -> arch null", () => {
  const vk = parseVulkaninfo(VULKANINFO_AMD_NO_ROCM);
  assert.equal(vk.deviceType, "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU");
  assert.equal(vk.arch, null);
  assert.equal(vk.vramMb, 16384);
});

test("parseGfxArch: RADV names, case-insensitive, letter suffix; non-matching -> null", () => {
  assert.equal(parseGfxArch("AMD Radeon Graphics (RADV GFX1151)"), "gfx1151");
  assert.equal(parseGfxArch("AMD Radeon Pro (radv gfx90a)"), "gfx90a");
  assert.equal(parseGfxArch("AMD Radeon RX 7800 XT (RADV NAVI32)"), null);
  assert.equal(parseGfxArch("NVIDIA GeForce RTX 3080"), null);
  assert.equal(parseGfxArch(null), null);
});

test("parseRocminfo: reports the chosen GPU agent's gfx arch", () => {
  const rc = parseRocminfo(ROCMINFO_AGENT_BLOCK);
  assert.equal(rc.arch, "gfx1151");
  assert.equal(rc.vramMb, 126976);
});

test("parseMemTotalMb: MemTotal kB -> MB rounded; missing -> null", () => {
  assert.equal(parseMemTotalMb(MEMINFO_HUGE_SWAP), 127941); // 131011448 / 1024
  assert.equal(parseMemTotalMb("MemAvailable: 1024 kB\n"), null);
  assert.equal(parseMemTotalMb(null), null);
});

test("probeHardware on crow: vulkan gfx1151 integrated -> unified true, GTT + MemTotal read, vramMb unchanged", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_CROW_UNIFIED });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_CROW }, dirs: DRM_DIRS_CROW });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.18.22-generic" });

  assert.equal(probe.accel, "vulkan");
  assert.equal(probe.gpuArch, "gfx1151");
  assert.equal(probe.unified, true);
  assert.equal(probe.vramMb, 84992);
  assert.equal(probe.gttTotalMb, 126976); // 133143986176 / 1024 / 1024
  assert.equal(probe.gttUsedMb, 58937); // 61800000000 / 1024 / 1024, rounded
  assert.equal(probe.ramTotalMb, 127941);
  assert.equal(probe.ramAvailableMb, 500);
});

test("probeHardware: discrete AMD (DISCRETE_GPU, 16 GiB) -> unified false, GTT fields NOT populated", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_DISCRETE_AMD }, dirs: { "/sys/class/drm": ["card0"] } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.unified, false);
  assert.equal(probe.gpuArch, null);
  assert.equal(probe.gttTotalMb, null);
  assert.equal(probe.gttUsedMb, null);
});

test("probeHardware: iGPU card0 (512 MiB) + discrete card1 (16 GiB), Vulkan says DISCRETE -> unified false, no GTT, discrete fitBadge unchanged", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_TWO_CARDS }, dirs: DRM_DIRS_TWO_CARDS });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.unified, false);
  assert.equal(probe.gttTotalMb, null);
  assert.equal(probe.gttUsedMb, null);
  const quant = { min_ram_mb: 16000, min_vram_mb: 8000 };
  // 500 MB available + 16384 MB VRAM credit >= 16000 -> fits, exactly as a
  // pre-change probe (no new fields) computes it.
  assert.equal(fitBadge(probe, quant), "fits");
  assert.equal(fitBadge(probe, quant), fitBadge({ ramAvailableMb: probe.ramAvailableMb, vramMb: probe.vramMb }, quant));
});

test("probeHardware: a <=2 GiB discrete card reported DISCRETE by Vulkan -> unified false (Vulkan beats the sysfs heuristic)", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_SMALL_DISCRETE }, dirs: { "/sys/class/drm": ["card0"] } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.unified, false);
  assert.equal(probe.gttTotalMb, null);
});

test("probeHardware: discrete sample with no sysfs at all -> unified false, GTT null", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_AMD_NO_ROCM });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.unified, false);
  assert.equal(probe.gttTotalMb, null);
  assert.equal(probe.gttUsedMb, null);
});

test("probeHardware: rocminfo-only AMD host with a <=2 GiB carve-out + GTT -> unified true via sysfs, arch from rocminfo", async () => {
  const execFile = fakeExecFile({ rocminfo: ROCMINFO_AGENT_BLOCK });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_CROW }, dirs: DRM_DIRS_CROW });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.accel, "vulkan");
  assert.equal(probe.gpuArch, "gfx1151");
  assert.equal(probe.unified, true);
  assert.equal(probe.gttTotalMb, 126976);
});

test("probeHardware: NVIDIA host whose drm cards expose no mem_info files -> GTT null, unified false", async () => {
  const execFile = fakeExecFile({ "nvidia-smi": NVIDIA_SMI_CSV });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP }, dirs: { "/sys/class/drm": ["card0", "card0-DP-1", "renderD128"] } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.accel, "cuda");
  assert.equal(probe.gttTotalMb, null);
  assert.equal(probe.unified, false);
  assert.equal(probe.gpuArch, null);
});

test("probeHardware: no GPU at all -> unified null (not false), gpuArch null; ramTotalMb still read", async () => {
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } });
  const probe = await probeHardware({ execFile: ALL_FAIL_EXEC, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.unified, null);
  assert.equal(probe.gpuArch, null);
  assert.equal(probe.ramTotalMb, 127941);
});

test("probeHardware: WSL2 and darwin leave every new field null", async () => {
  const wsl = await probeHardware({
    execFile: fakeExecFile({ vulkaninfo: VULKANINFO_CROW_UNIFIED }),
    fs: fakeFs({ existsFiles: ["/proc/sys/fs/binfmt_misc/WSLInterop"], readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP } }),
    platform: "linux",
    release: "5.15.0-microsoft-standard-WSL2",
  });
  assert.equal(wsl.unified, null);
  assert.equal(wsl.gpuArch, null);
  assert.equal(wsl.gttTotalMb, null);

  const mac = await probeHardware({ execFile: fakeExecFile({ sysctl: "34359738368\n" }), fs: fakeFs({}), platform: "darwin", release: "23.0.0" });
  assert.equal(mac.unified, null);
  assert.equal(mac.gpuArch, null);
  assert.equal(mac.gttTotalMb, null);
  assert.equal(mac.ramTotalMb, null);
});

test("readAmdgpuMem: only card<N> dirs count; among cards with GTT the smallest VRAM (the iGPU) wins; junk/unreadable skipped", () => {
  const fs = fakeFs({
    dirs: { "/sys/class/drm": ["card10", "card2-DP-1", "version", "renderD128", "card2", "card1", "card3"] },
    readFiles: {
      // card1: gtt_total is garbage -> skipped entirely
      "/sys/class/drm/card1/device/mem_info_gtt_total": "not-a-number\n",
      "/sys/class/drm/card1/device/mem_info_vram_total": "1048576\n",
      // card2: 256 MiB carve-out -> the iGPU, chosen; gtt_used missing -> null
      "/sys/class/drm/card2/device/mem_info_gtt_total": "1073741824\n",
      "/sys/class/drm/card2/device/mem_info_vram_total": "268435456\n",
      // card3: GTT but no vram_total -> ranks last
      "/sys/class/drm/card3/device/mem_info_gtt_total": "4294967296\n",
      // card10: discrete 16 GiB -> larger VRAM, not chosen
      "/sys/class/drm/card10/device/mem_info_gtt_total": "2147483648\n",
      "/sys/class/drm/card10/device/mem_info_vram_total": "17179869184\n",
    },
  });
  assert.deepEqual(readAmdgpuMem(fs), { gttTotalMb: 1024, gttUsedMb: null, vramTotalMb: 256 });
});

// Round 2 (review): these fail against a naive "first numeric card with GTT"
// implementation — the dGPU sits at card0 and the no-vram card sorts first.
const DRM_DIRS_DGPU_FIRST = { "/sys/class/drm": ["card0", "card0-DP-1", "card1", "card1-eDP-1", "renderD128", "renderD129", "version"] };
const SYSFS_DGPU_CARD0_IGPU_CARD1 = {
  "/sys/class/drm/card0/device/mem_info_vram_total": "17179869184\n", // dGPU, 16 GiB
  "/sys/class/drm/card0/device/mem_info_gtt_total": "8589934592\n",
  "/sys/class/drm/card0/device/mem_info_gtt_used": "1048576\n",
  "/sys/class/drm/card1/device/mem_info_vram_total": "536870912\n", // iGPU, 512 MiB carve-out
  "/sys/class/drm/card1/device/mem_info_gtt_total": "133143986176\n",
  "/sys/class/drm/card1/device/mem_info_gtt_used": "61800000000\n",
};

test("readAmdgpuMem: dGPU at card0 (16 GiB) + iGPU at card1 (512 MiB) -> card1's GTT (a first-card-wins impl picks card0 and fails)", () => {
  const fs = fakeFs({ dirs: DRM_DIRS_DGPU_FIRST, readFiles: SYSFS_DGPU_CARD0_IGPU_CARD1 });
  assert.deepEqual(readAmdgpuMem(fs), { gttTotalMb: 126976, gttUsedMb: 58937, vramTotalMb: 512 });
});

test("probeHardware: crow's INTEGRATED vulkaninfo + dGPU at card0 and iGPU at card1 -> GTT fields come from card1", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_CROW_UNIFIED });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_DGPU_CARD0_IGPU_CARD1 }, dirs: DRM_DIRS_DGPU_FIRST });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.18.22-generic" });
  assert.equal(probe.unified, true);
  assert.equal(probe.gttTotalMb, 126976); // card1, not card0's 8192
  assert.equal(probe.gttUsedMb, 58937); // card1, not card0's 1
});

test("probeHardware: Vulkan INTEGRATED Intel + a single 16 GiB amdgpu dGPU card -> unified true (Vulkan's verdict), but GTT NOT surfaced (the amdgpu card is not a carve-out iGPU)", async () => {
  const execFile = fakeExecFile({ vulkaninfo: VULKANINFO_INTEL_INTEGRATED });
  const fs = fakeFs({ readFiles: { "/proc/meminfo": MEMINFO_HUGE_SWAP, ...SYSFS_DISCRETE_AMD }, dirs: { "/sys/class/drm": ["card0"] } });
  const probe = await probeHardware({ execFile, fs, platform: "linux", release: "6.8.0-generic" });

  assert.equal(probe.unified, true);
  assert.equal(probe.gttTotalMb, null);
  assert.equal(probe.gttUsedMb, null);
});

test("readAmdgpuMem: a card with no mem_info_vram_total listed BEFORE one that has it ranks last (the card with vram_total wins)", () => {
  const fs = fakeFs({
    dirs: { "/sys/class/drm": ["card0", "card1"] },
    readFiles: {
      "/sys/class/drm/card0/device/mem_info_gtt_total": "4294967296\n", // no vram_total file
      "/sys/class/drm/card1/device/mem_info_gtt_total": "1073741824\n",
      "/sys/class/drm/card1/device/mem_info_vram_total": "536870912\n",
    },
  });
  assert.deepEqual(readAmdgpuMem(fs), { gttTotalMb: 1024, gttUsedMb: null, vramTotalMb: 512 });
});

test("readAmdgpuMem: equal VRAM -> the lower card number wins", () => {
  const fs = fakeFs({
    dirs: { "/sys/class/drm": ["card4", "card1"] },
    readFiles: {
      "/sys/class/drm/card1/device/mem_info_gtt_total": "1073741824\n",
      "/sys/class/drm/card1/device/mem_info_vram_total": "536870912\n",
      "/sys/class/drm/card4/device/mem_info_gtt_total": "2147483648\n",
      "/sys/class/drm/card4/device/mem_info_vram_total": "536870912\n",
    },
  });
  assert.equal(readAmdgpuMem(fs).gttTotalMb, 1024);
});

test("readAmdgpuMem: no /sys/class/drm, or an fs without readdirSync -> null, never throws", () => {
  assert.equal(readAmdgpuMem(fakeFs({})), null);
  assert.equal(readAmdgpuMem({ readFileSync() { throw new Error("x"); } }), null);
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
// fitBadge on unified memory (Strix Halo spec §2.2, D2)
// ---------------------------------------------------------------------------

// crow today (spec §1): 126,976 MiB GTT, 127,941 MiB MemTotal, ~46 GiB
// available with 35b + embed resident, RADV's 83 GiB DEVICE_LOCAL heap.
// GTT >= 0.75 x MemTotal -> a GTT-expanded APU (review C2).
const CROW_UNIFIED = { unified: true, gttTotalMb: 126976, ramTotalMb: 127941, ramAvailableMb: 47104, vramMb: 84992 };
// A default-GTT laptop APU: GTT is half of RAM -> NOT GTT-expanded.
const LAPTOP_APU = { unified: true, gttTotalMb: 16000, ramTotalMb: 32000, ramAvailableMb: 24000, vramMb: 16000 };

test("fitBadge GTT-expanded: under available -> fits", () => {
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 40000, min_vram_mb: 0 }), "fits");
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 47104, min_vram_mb: 0 }), "fits"); // boundary inclusive
});

test("fitBadge GTT-expanded (crow): Flash-Next UD-Q4_K_XL 115,068 MiB -> tight; == GTT still tight", () => {
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 115068, min_vram_mb: 0 }), "tight");
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 126976, min_vram_mb: 0 }), "tight");
});

test("fitBadge GTT-expanded (crow): GLM UD-IQ4_XS 157,911 MiB -> wont_fit; GTT+1 -> wont_fit", () => {
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 157911, min_vram_mb: 0 }), "wont_fit");
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 126977, min_vram_mb: 0 }), "wont_fit");
});

test("fitBadge GTT-expanded: min_vram_mb > 0 NEVER adds VRAM (no double-count)", () => {
  // Discrete math would be 47104 + 84992 >= 60000 -> fits.
  assert.equal(fitBadge(CROW_UNIFIED, { min_ram_mb: 60000, min_vram_mb: 8000 }), "tight");
});

test("fitBadge default-GTT laptop APU: fits MemAvailable but exceeds GTT -> fits (GTT is not a ceiling here)", () => {
  assert.equal(fitBadge(LAPTOP_APU, { min_ram_mb: 20000, min_vram_mb: 0 }), "fits");
});

test("fitBadge default-GTT laptop APU: today's 10% band, minus the VRAM credit", () => {
  assert.equal(fitBadge(LAPTOP_APU, { min_ram_mb: 26400, min_vram_mb: 0 }), "tight"); // 24000 x 1.10 exactly
  assert.equal(fitBadge(LAPTOP_APU, { min_ram_mb: 26401, min_vram_mb: 0 }), "wont_fit"); // no widening to GTT/RAM
  // Discrete math would add 16000 VRAM -> fits; unified never does.
  assert.equal(fitBadge(LAPTOP_APU, { min_ram_mb: 30000, min_vram_mb: 8000 }), "wont_fit");
});

test("fitBadge unified: the 0.75 GTT-expansion boundary is inclusive and integer-exact", () => {
  const at = { unified: true, gttTotalMb: 96000, ramTotalMb: 128000, ramAvailableMb: 47104 };
  // (both variants: 90000 is below GTT 96000 and above available 47104)
  const below = { ...at, gttTotalMb: 95999 };
  assert.equal(fitBadge(at, { min_ram_mb: 90000, min_vram_mb: 0 }), "tight"); // expanded -> GTT ceiling
  assert.equal(fitBadge(below, { min_ram_mb: 90000, min_vram_mb: 0 }), "wont_fit"); // default -> 10% band
});

test("fitBadge GTT-expanded: the ceiling is checked FIRST — an idle box with MemAvailable > GTT still says wont_fit above GTT", () => {
  // gtt = 80% of MemTotal; idle, so MemAvailable (110000) exceeds GTT (102400).
  const idle = { unified: true, gttTotalMb: 102400, ramTotalMb: 128000, ramAvailableMb: 110000 };
  assert.equal(fitBadge(idle, { min_ram_mb: 105000, min_vram_mb: 0 }), "wont_fit"); // between GTT and available
  assert.equal(fitBadge(idle, { min_ram_mb: 102400, min_vram_mb: 0 }), "fits"); // == GTT, within available
});

test("fitBadge unified: GTT or MemTotal unknown -> today's formula minus VRAM credit (no GTT ceiling, no widening)", () => {
  const noGtt = { ...CROW_UNIFIED, gttTotalMb: null };
  const noTotal = { ...CROW_UNIFIED, ramTotalMb: null };
  for (const probe of [noGtt, noTotal]) {
    assert.equal(fitBadge(probe, { min_ram_mb: 47104, min_vram_mb: 8000 }), "fits");
    assert.equal(fitBadge(probe, { min_ram_mb: 51814, min_vram_mb: 8000 }), "tight"); // <= 47104 x 1.10
    assert.equal(fitBadge(probe, { min_ram_mb: 115068, min_vram_mb: 8000 }), "wont_fit");
  }
});

test("fitBadge unified: missing ramAvailableMb -> unknown (fail-closed unchanged)", () => {
  assert.equal(fitBadge({ ...CROW_UNIFIED, ramAvailableMb: null }, { min_ram_mb: 1, min_vram_mb: 0 }), "unknown");
});

test("fitBadge: unified:false keeps the discrete VRAM credit exactly as before", () => {
  const probe = { unified: false, ramAvailableMb: 6000, vramMb: 12000, gttTotalMb: null };
  assert.equal(fitBadge(probe, { min_ram_mb: 16000, min_vram_mb: 8000 }), "fits");
});

test("models.fitTightHint copy covers 'other models stopped first' in en and es", () => {
  assert.match(t("models.fitTightHint", "en"), /other models stopped first/);
  assert.match(t("models.fitTightHint", "es"), /otros modelos/);
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
