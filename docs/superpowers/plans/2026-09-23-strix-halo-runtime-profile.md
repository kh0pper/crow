# Strix Halo Runtime Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Crow's native model path understand a unified-memory gfx1151 host. The probe reads GTT and knows the GPU shares RAM. `fitBadge` stops double-counting that shared memory. An operator can pin a llama-server binary to one model. A gfx1151 + Vulkan host gets pi-lab's launch flags as the lowest-precedence defaults.

**Architecture:** Additive fields on the existing `probeHardware()` result drive a new unified branch in `fitBadge`. Per-model runtime overrides sit in `state.json` next to the host override. They reuse its `validateBinary` and are resolved first in `resolveNativeBinPath`. A pure `host-profile.js` returns launch defaults, which the orchestrator merges under the catalog and provider launch layers. A small `.mjs` CLI is the operator surface.

**Tech Stack:** Node 24 ESM, the `node:test` runner through `scripts/run-suite.mjs`, and `node:util` `parseArgs` for the CLI.

**Spec:** `docs/superpowers/specs/2026-09-23-strix-halo-runtime-profile-design.md`. It amends `docs/superpowers/specs/2026-09-04-models-bundles-to-catalog-design.md` §3.4 and §4.

## Global Constraints

- Worktree ~/crow-wt-halo-profile; node_modules is a symlink — never commit it or .superpowers/.
- Every shell starts with `export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH`; tests ONLY via `npm test -- tests/<file>.test.js` (never raw `node --test` — it writes to the live DB).
- Commit with explicit paths (`git add` new files, then `git commit <paths> -m ...`); `git show --stat HEAD` after each commit.
- Every new i18n key/changed string needs en AND es (global parity gate).
- Tests must not read the real host's /sys, /proc, vulkaninfo, or ~/.crow — everything through the injected fs/execFile/data-dir seams.
- Existing probe/fitBadge/launch/override tests must stay green unchanged except where the spec changes behaviour. The only existing tests this plan changes are:
  - `tests/models-state.test.js`: "loadState on a missing state file returns an empty state", "saveState + loadState round-trip atomically and deep-equal" and "loadState on a corrupt (non-JSON) state file returns an empty state". Their expected state gains `runtimeOverrides: {}` because the state shape gains a key (spec §2.3).
  - Test helpers only (no assertion changes): `fakeFs` in `tests/models-probe.test.js` gains a `readdirSync`, and `startCapableOpts` in `tests/gpu-orchestrator-native.test.js` gains `getModelRuntimeOverrideFn: () => null`.
- Derived from the spec:
  - Probe fields are **additive only**. Every existing field keeps its meaning, and `vramMb` still reports the Vulkan `DEVICE_LOCAL` heap.
  - `probe.js` must NOT import `gpu-arch.js` or `hardware-gate.js`.
  - The parsers stay pure and exported. Sysfs reads go through the injected `fs`.
  - `unified`: when vulkaninfo answered, `INTEGRATED_GPU` → `true` and `DISCRETE_GPU` → `false`. Other Vulkan types, and the no-Vulkan (rocminfo) path, use the sysfs heuristic: an AMD GPU with `mem_info_vram_total` ≤ 2048 MiB plus a `mem_info_gtt_total`. darwin keeps `unified: null`.
  - `gttTotalMb`/`gttUsedMb` are populated only when `unified === true`, from the amdgpu card with the smallest `mem_info_vram_total` that has GTT (the iGPU).
  - `fitBadge` on discrete and unknown hosts is byte-for-byte unchanged. The unified path never adds VRAM credit. The GTT ceiling applies only to a **GTT-expanded** APU (`unified === true`, `gttTotalMb` and `ramTotalMb` known, `gttTotalMb >= 0.75 × ramTotalMb`), ceiling first: `min_ram_mb > gttTotalMb` → `wont_fit`, then `min_ram_mb <= ramAvailableMb` → `fits`, else `tight`. Every other unified host uses today's formula minus the VRAM credit.
  - The CLI is a second `state.json` writer: after every write it re-reads and verifies, retries once, then exits 3 naming a concurrent gateway write.
  - **No new badge value** (D3). `FIT_ORDER`, the panel client script and the panel tests are untouched.
  - Per-model overrides live in `state.json` under `runtimeOverrides`. They never go in `gpu_policy` or any DB column, because they must never replicate.
  - Resolve order: per-model override (keyed `p.gpuPolicy?.catalogId || providerName`), then host override, then stock release through `ensureRuntime`. A missing `bin` warns once per bin and falls through to the next layer. A per-model override skips `ensureRuntime` and therefore skips `min_runtime_version`.
  - Launch precedence: **host profile < catalog `launch` < provider `gpu_policy.launch` < the jinja layer** (D7). The profile only fills keys nobody set.
  - `hostLaunchDefaults(probe)` returns `{ flash_attn: "on", no_mmap: true, no_op_offload: true }` only when `probe.gpuArch === "gfx1151"` and `probe.accel === "vulkan"`, and `null` otherwise.
  - `no_op_offload` is a boolean launch key and renders `--no-op-offload` only when `true`. Both `--op-offload` and `--no-op-offload` join `LAUNCH_OWNED_FLAGS`.
  - The profile applies to native-runtime starts only. Docker bundles are untouched.
  - Out of scope, not to be built: a live GTT start gate, any dashboard UI, ROCm/HIP runtime assets, and any change to `SINGLE_BOX_RAM_MB`.

## Review Focus

1. **An override-only start never warms the probe cache.** With a per-model or host override set, `resolveNativeBinPath` returns before it probes. The gfx1151 profile would then silently never apply on exactly the host this work is for. Expected: `resolveNativeBinPath` warms the probe BEFORE any override early-return, so override and stock paths both leave a warm cache, and `startNativeAndAwaitReady` only reads `getCachedProbeFn()` (null → no profile). A probe that throws on an override path means "no profile", never a failed start; on the stock path it still surfaces, as today. Pinned in Task 3, Step 1 and Task 5, Step 1.
2. **An override set under the wrong id never applies, silently.** An operator may type a provider name such as `crow-chat` where the row carries `gpu_policy.catalogId`. Expected: the CLI warns when the id matches no catalog id and no registered `catalogId`, but still stores it, since the provider-name fallback is legal. Pinned in Task 4, Step 1.
3. **A read-only CLI command must not write state.** `getRuntimeOverride()` bootstraps from `CROW_LLAMA_SERVER_BIN` and persists, so a `list` or `get` routed through it would write `state.json`. Expected: `list` and `get` read `loadState()` directly and never create or modify the file, and neither does a host `clear` when no host override is stored. Pinned in Task 4, Step 1.
4. **A state file written by an older gateway, or a hand-mangled one.** This covers `state.json` with no `runtimeOverrides`, or with `runtimeOverrides` set to an array or `null`. Expected: it loads as `{}`, the host override and registry are untouched, and a later per-model `set` keeps every other key intact. Pinned in Task 3, Step 1.
5. **Real `/sys/class/drm` noise.** The directory holds connector entries (`card0-DP-1`, `card0-HDMI-A-1`), `renderD128`, `version`, cards with no `mem_info_*` files, and unreadable files. Expected: only `card<N>` directories count, in numeric order, and the first one carrying `mem_info_gtt_total` wins. Anything missing leaves the field `null` without throwing. Pinned in Task 1, Step 1.

---

## File Structure

| file | change | responsibility |
|---|---|---|
| `servers/gateway/models/probe.js` | modify | adds `gpuArch`, `unified`, `gttTotalMb`, `gttUsedMb` and `ramTotalMb`; exports the `parseGfxArch`, `parseMemTotalMb` and `readAmdgpuMem` helpers; unified `fitBadge` branch |
| `servers/gateway/dashboard/shared/i18n.js` | modify | `models.fitTightHint` en + es copy |
| `servers/gateway/models/state.js` | modify | `runtimeOverrides` map in the empty and loaded state |
| `servers/gateway/models/runtime-override.js` | modify | per-model get/set/clear/list |
| `servers/gateway/gpu-orchestrator.js` | modify | `resolveNativeBinPath` resolve order + `providerName` from both callers; host-profile merge in `startNativeAndAwaitReady` |
| `scripts/models-runtime-override.mjs` | create | operator CLI |
| `servers/gateway/models/launch.js` | modify | `no_op_offload` key, owned flags, render |
| `servers/gateway/models/host-profile.js` | create | pure `hostLaunchDefaults(probe)` |
| `docs/architecture/models.md` | modify | documents the probe fields, unified fit, per-model override, CLI and host profile |
| `tests/models-probe.test.js` | modify | probe fields + unified fit matrix + hint copy |
| `tests/models-state.test.js` | modify | 3 shape assertions (listed above) |
| `tests/models-runtime-override.test.js` | modify | per-model store tests |
| `tests/gpu-orchestrator-native.test.js` | modify | resolve order + host profile start args |
| `tests/models-runtime-override-cli.test.js` | create | CLI |
| `tests/models-launch.test.js` | modify | `no_op_offload` |
| `tests/models-host-profile.test.js` | create | `hostLaunchDefaults` |

---

### Task 1: Probe knows unified memory (`gpuArch`, `unified`, GTT, MemTotal)

**Files:**
- Modify: `servers/gateway/models/probe.js` (parsers `:82-241`, detection helpers `:247-270`, typedef `:276-286`, `probeHardware` `:300-391`)
- Test: `tests/models-probe.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `parseVulkaninfo(text) → { name, vramMb, deviceType: string|null, arch: string|null } | null`
  - `parseRocminfo(text) → { name, vramMb, arch: string|null } | null`
  - `parseGfxArch(name: string) → "gfxNNNN" | null`
  - `parseMemTotalMb(text) → number|null`
  - `readAmdgpuMem(fs) → { gttTotalMb, gttUsedMb, vramTotalMb } | null`, taken from the `card<N>` with GTT whose `vramTotalMb` is smallest (missing VRAM ranks last; ties go to the lower card number)
  - `UNIFIED_VRAM_CARVEOUT_MAX_MB = 2048`
  - The `Probe` object gains `gpuArch: string|null`, `unified: boolean|null`, `gttTotalMb: number|null`, `gttUsedMb: number|null` and `ramTotalMb: number|null`.
  - Task 2 reads `unified`, `gttTotalMb` and `ramTotalMb`. Task 5 reads `gpuArch` and `accel`.

- [ ] **Step 1: Write the failing tests**

In `tests/models-probe.test.js`, change the import block at the top to:

```js
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
```

Replace the `fakeFs` helper with this version. It is identical except that it adds `dirs` and `readdirSync`. Every existing call site passes no `dirs`, so `readdirSync` throws `ENOENT` for them, which is the "no sysfs" case:

```js
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
```

Add these fixtures directly after the `ROCMINFO_AGENT_BLOCK` constant:

```js
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
```

Add these tests after the existing `"disk free reported via fs.statfsSync when modelsDir given"` test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-probe.test.js
```
Expected: FAIL. The file fails to load with `SyntaxError: The requested module '../servers/gateway/models/probe.js' does not provide an export named 'parseGfxArch'`.

The three round-2 tests (dGPU at card0 + iGPU at card1 through `readAmdgpuMem` and through `probeHardware`, and the no-vram card listed first) are deliberately built to FAIL against a naive "first numeric card with GTT wins" `readAmdgpuMem`. That implementation returns card0 in all three: GTT 8192 instead of 126976, and GTT 4096 instead of 1024. If a draft passes them while picking the first card, the fixture is wrong.

- [ ] **Step 3: Implement**

In `servers/gateway/models/probe.js`:

(a) Replace the two constants at `:46-47` with:

```js
const WSL_INTEROP_PATH = "/proc/sys/fs/binfmt_misc/WSLInterop";
const MEMINFO_PATH = "/proc/meminfo";
const DRM_CLASS_DIR = "/sys/class/drm";
const INTEGRATED_GPU_TYPE = "PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU";
const DISCRETE_GPU_TYPE = "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU";
const AMD_NAME_RE = /\b(AMD|Radeon|RADV)\b/i;

/**
 * An amdgpu `mem_info_vram_total` at or below this is an APU's BIOS
 * carve-out (Strix Halo ships 512 MiB), not a discrete card's own memory —
 * paired with a readable `mem_info_gtt_total`, it marks the host unified
 * (Strix Halo runtime profile spec §2.1, D1).
 */
export const UNIFIED_VRAM_CARVEOUT_MAX_MB = 2048;
```

(b) In `parseVulkaninfo`, replace the `flushDevice` body's `candidates.push(...)` line with:

```js
      candidates.push({
        name: currentName,
        vramMb: Math.round(maxHeapBytes / 1024 / 1024),
        deviceType: currentType,
        arch: parseGfxArch(currentName),
      });
```

Then update its doc comment's last line from `Returns { name, vramMb } or null ...` to:

```js
 * Returns { name, vramMb, deviceType, arch } (deviceType is the raw
 * `PHYSICAL_DEVICE_TYPE_*` token, arch is `parseGfxArch(name)`) or null if
 * no GPU with a DEVICE_LOCAL heap found. `vramMb` keeps its meaning — the
 * largest DEVICE_LOCAL heap — even on unified memory, where it is a slice
 * of RAM; `probe.unified` is what tells a consumer not to add it to RAM.
```

(c) Directly above `parseNvidiaSmi`, add:

```js
/**
 * Pull the gfx architecture out of a Vulkan device name — RADV puts it in
 * parentheses, e.g. "AMD Radeon Graphics (RADV GFX1151)" -> "gfx1151".
 * Returns null for names without a GFX token (NVIDIA, older RADV names
 * like "(RADV NAVI32)").
 */
export function parseGfxArch(name) {
  if (typeof name !== "string") return null;
  const m = name.match(/\bGFX(\d{3,4}[a-z]?)\b/i);
  return m ? `gfx${m[1].toLowerCase()}` : null;
}
```

(d) In `parseRocminfo`:
- add `let arch = null;` after `let maxKb = 0;`;
- in `flushAgent` change the push to `candidates.push({ name: marketingName || "AMD GPU", vramMb: Math.round(maxKb / 1024), arch });`;
- add `arch = null;` in `flushAgent`'s reset list;
- replace the `Name: gfx` detection block with:

```js
    const gfx = line.match(/^\s*Name:\s*(gfx[0-9a-f]+)\s*$/);
    if (gfx) {
      isGpu = true;
      arch = gfx[1];
      continue;
    }
```

Then update its doc's last line to `Returns { name, vramMb, arch } for the largest GPU agent's GLOBAL pool, or null.`

(e) Directly after `parseMemAvailableMb`, add:

```js
/** Parse the `MemTotal:  N kB` line from /proc/meminfo text. MB, rounded. */
export function parseMemTotalMb(text) {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const m = line.match(/^MemTotal:\s+(\d+)\s+kB/);
    if (m) return Math.round(Number(m[1]) / 1024);
  }
  return null;
}
```

(f) Replace `readMemAvailable` (`:253-260`) with the following. It reads the file once; both MemAvailable and MemTotal parse from it:

```js
function readMeminfo(fs) {
  try {
    return fs.readFileSync(MEMINFO_PATH, "utf8");
  } catch {
    return null;
  }
}

function readSysfsBytes(fs, path) {
  try {
    const n = Number.parseInt(String(fs.readFileSync(path, "utf8")).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

const bytesToMb = (b) => (b == null ? null : Math.round(b / 1024 / 1024));

/**
 * Read amdgpu's memory counters for the host's iGPU: among the
 * `/sys/class/drm/card<N>` entries (connector entries like `card0-DP-1`,
 * `renderD128` and `version` are ignored) that expose
 * `device/mem_info_gtt_total`, the one with the SMALLEST
 * `mem_info_vram_total` (an APU's BIOS carve-out; a missing vram_total
 * ranks last; ties go to the lower card number). On a host with an iGPU
 * beside a discrete card this picks the iGPU, never the dGPU.
 * Returns { gttTotalMb, gttUsedMb, vramTotalMb } (the latter two null when
 * their file is missing/unreadable), or null when no card has GTT info
 * (not amdgpu, not linux, or `fs` can't list directories). Never throws.
 */
export function readAmdgpuMem(fs) {
  let entries;
  try {
    entries = fs.readdirSync(DRM_CLASS_DIR);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const cards = entries
    .map((e) => String(e))
    .filter((e) => /^card\d+$/.test(e))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  let best = null;
  for (const card of cards) {
    const base = `${DRM_CLASS_DIR}/${card}/device`;
    const gttTotal = readSysfsBytes(fs, `${base}/mem_info_gtt_total`);
    if (gttTotal == null) continue;
    const info = {
      gttTotalMb: bytesToMb(gttTotal),
      gttUsedMb: bytesToMb(readSysfsBytes(fs, `${base}/mem_info_gtt_used`)),
      vramTotalMb: bytesToMb(readSysfsBytes(fs, `${base}/mem_info_vram_total`)),
    };
    const rank = info.vramTotalMb ?? Number.POSITIVE_INFINITY;
    const bestRank = best ? (best.vramTotalMb ?? Number.POSITIVE_INFINITY) : null;
    // Strict "<" keeps the lower card number on a tie (cards are sorted).
    if (best === null || rank < bestRank) best = info;
  }
  return best;
}
```

(g) Replace the `Probe` typedef with:

```js
/**
 * @typedef {Object} Probe
 * @property {"linux"|"darwin"} platform
 * @property {boolean} wsl2
 * @property {"vulkan"|"cuda"|"metal"|"cpu"} accel
 * @property {string|null} gpuName
 * @property {number|null} vramMb        largest DEVICE_LOCAL heap (a RAM slice when unified)
 * @property {string|null} gpuArch       e.g. "gfx1151" (Vulkan name, else rocminfo)
 * @property {boolean|null} unified      GPU shares system RAM; null when no GPU detected
 * @property {number|null} gttTotalMb    amdgpu GTT aperture (the real single-box ceiling on unified)
 * @property {number|null} gttUsedMb
 * @property {number|null} ramAvailableMb
 * @property {number|null} ramTotalMb    /proc/meminfo MemTotal
 * @property {number|null} diskFreeMb
 * @property {string[]} unknown
 */
```

(h) In `probeHardware`, replace the `probe` literal with:

```js
  const probe = {
    platform: platform === "darwin" ? "darwin" : "linux",
    wsl2: false,
    accel: "cpu",
    gpuName: null,
    vramMb: null,
    gpuArch: null,
    unified: null,
    gttTotalMb: null,
    gttUsedMb: null,
    ramAvailableMb: null,
    ramTotalMb: null,
    diskFreeMb: null,
    unknown,
  };
```

Then replace the whole `} else { probe.wsl2 = detectWsl2(fs, release); ... }` linux branch (from `probe.wsl2 = detectWsl2` through the `unknown.push("ram")` block's closing brace) with:

```js
  } else {
    probe.wsl2 = detectWsl2(fs, release);
    let vkType = null; // Vulkan's deviceType verdict, when vulkaninfo answered
    let amdGpu = false; // the chosen GPU is AMD (the sysfs heuristic may apply)

    if (probe.wsl2) {
      // v1 rule: force cpu, no GPU passthrough detection attempted. This is
      // a deliberate policy decision, not a failed detection, so nothing is
      // pushed to `unknown` for it.
      probe.accel = "cpu";
    } else {
      const vkOut = await run(execFile, "vulkaninfo", []);
      const vk = parseVulkaninfo(vkOut);
      if (vk) {
        probe.accel = "vulkan";
        probe.gpuName = vk.name;
        probe.vramMb = vk.vramMb;
        probe.gpuArch = vk.arch;
        vkType = vk.deviceType;
        amdGpu = AMD_NAME_RE.test(vk.name);
      } else {
        const nvOut = await run(execFile, "nvidia-smi", [
          "--query-gpu=name,memory.total",
          "--format=csv,noheader,nounits",
        ]);
        const nv = parseNvidiaSmi(nvOut);
        if (nv) {
          probe.accel = "cuda";
          probe.gpuName = nv.name;
          probe.vramMb = nv.vramMb;
        } else {
          const rcOut = await run(execFile, "rocminfo", []);
          const rc = parseRocminfo(rcOut);
          if (rc) {
            // Probe.accel has no separate "rocm" value; AMD family is
            // reported as "vulkan" (v1 only ships the Vulkan/Mesa asset).
            probe.accel = "vulkan";
            probe.gpuName = rc.name;
            probe.vramMb = rc.vramMb;
            probe.gpuArch = rc.arch;
            amdGpu = true;
          } else {
            probe.accel = "cpu";
            unknown.push("gpu");
          }
        }
      }
    }

    // Unified (spec §2.1, review C1). Vulkan's deviceType decides whenever
    // it answered: INTEGRATED -> true, DISCRETE -> false. Only other Vulkan
    // types, or no Vulkan at all (the rocminfo path; the nvidia path has
    // amdGpu false), fall back to the sysfs small-carve-out heuristic.
    // GTT fields are the iGPU's and are reported ONLY on a unified host —
    // a discrete card's GTT aperture is not a model ceiling.
    const amd = readAmdgpuMem(fs);
    if (probe.gpuName != null) {
      if (vkType === INTEGRATED_GPU_TYPE) probe.unified = true;
      else if (vkType === DISCRETE_GPU_TYPE) probe.unified = false;
      else {
        probe.unified =
          amdGpu && amd != null && amd.vramTotalMb != null && amd.vramTotalMb <= UNIFIED_VRAM_CARVEOUT_MAX_MB;
      }
    }
    if (probe.unified === true && amd) {
      probe.gttTotalMb = amd.gttTotalMb;
      probe.gttUsedMb = amd.gttUsedMb;
    }

    const meminfo = readMeminfo(fs);
    const memAvail = parseMemAvailableMb(meminfo);
    if (memAvail != null) {
      probe.ramAvailableMb = memAvail;
    } else {
      unknown.push("ram");
    }
    probe.ramTotalMb = parseMemTotalMb(meminfo);
  }
```

(i) Add one paragraph to the module header comment, just before its closing ` */`:

```js
 *
 * Unified memory (Strix Halo runtime profile spec §2.1): `gpuArch`,
 * `unified`, `gttTotalMb`/`gttUsedMb` (amdgpu sysfs, read through the same
 * injected `fs`) and `ramTotalMb` are additive. On an APU the Vulkan
 * DEVICE_LOCAL heap is a slice of RAM, so `unified: true` tells fitBadge
 * never to add `vramMb` on top of RAM. Vulkan's deviceType decides
 * `unified` whenever it answered; the sysfs carve-out heuristic is only a
 * fallback. GTT fields are reported only when `unified === true`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-probe.test.js
```
Expected: PASS, with every pre-existing test green and unmodified.

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow-wt-halo-profile
git commit servers/gateway/models/probe.js tests/models-probe.test.js -m "feat(models): probe knows unified memory — gpuArch, unified, GTT, MemTotal"
git show --stat HEAD
```

---

### Task 2: `fitBadge` on unified memory, and the tight-hint copy

**Files:**
- Modify: `servers/gateway/models/probe.js` (`fitBadge`, `:397-434`)
- Modify: `servers/gateway/dashboard/shared/i18n.js:735` (`models.fitTightHint`)
- Test: `tests/models-probe.test.js`

**Interfaces:**
- Consumes: from Task 1, the `Probe` fields `unified`, `gttTotalMb`, `ramTotalMb` and `ramAvailableMb`.
- Produces: `fitBadge(probe, quant) → "fits"|"tight"|"wont_fit"|"unknown"`. The signature is unchanged. Only unified probes behave differently.

- [ ] **Step 1: Write the failing tests**

In `tests/models-probe.test.js`, add `import { t } from "../servers/gateway/dashboard/shared/i18n.js";` below the probe import. Then add these after the last existing `fitBadge` test (`"fitBadge: min_vram_mb 0 (CPU-capable quant) never adds VRAM even if present"`):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-probe.test.js
```
Expected: FAIL.
- `"Flash-Next ... -> tight"` gets `"wont_fit"`: today's math is 115068 > 47104 × 1.10.
- The 0.75-boundary test's expanded case gets `"wont_fit"`.
- `"min_vram_mb > 0 NEVER adds VRAM"` gets `"fits"`, and the laptop `30000/8000` case gets `"fits"`, which is the double-count.
- The "GTT or MemTotal unknown" test fails on the VRAM credit: 115068 with `min_vram_mb: 8000` gets `"fits"`.
- The hint test fails its `/other models stopped first/` match.
- The ceiling-first test's `105000` case gets `"fits"` from today's VRAM-credited math.
- The "under available", "GLM -> wont_fit", "fits MemAvailable but exceeds GTT" and "unified:false" tests already pass. They pin behaviour that must not move.

- [ ] **Step 3: Implement**

In `servers/gateway/models/probe.js`, replace the whole `fitBadge` doc comment and function (`:397-434`) with:

```js
const positiveOrNull = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Decide whether `quant` fits on the given `probe`.
 *
 * Fail-closed: missing RAM info (`probe.ramAvailableMb == null`) NEVER
 * returns "fits" — it returns "unknown". Swap is never part of `probe`, so
 * it can never leak in here either.
 *
 * Unified memory (`probe.unified === true`, Strix Halo spec §2.2, D2) — the
 * GPU's DEVICE_LOCAL heap is a slice of the same RAM, so VRAM is NEVER
 * added (that was a double-count).
 *   GTT-expanded APU (gttTotalMb and ramTotalMb known, and
 *   gttTotalMb >= 0.75 x ramTotalMb — e.g. crow with amdgpu.gttsize),
 *   ceiling FIRST (MemAvailable can exceed GTT on an idle box):
 *     min_ram_mb >  gttTotalMb     -> "wont_fit" (can never run on this box)
 *     min_ram_mb <= ramAvailableMb -> "fits"
 *     otherwise                    -> "tight"  (fits once other resident
 *                                     models are stopped)
 *   Every other unified host (default GTT, or GTT/MemTotal unknown): the
 *   discrete formula below with effective = ramAvailableMb (no VRAM credit).
 *   A default GTT is NOT a ceiling — llama.cpp can run the rest on CPU.
 *
 * Discrete / unknown (`unified` false or null) — byte-identical to before:
 * effective RAM = probe.ramAvailableMb
 *   + (probe.vramMb, only when quant.min_vram_mb > 0 AND
 *      probe.vramMb >= quant.min_vram_mb — i.e. the GPU can actually hold
 *      the offloaded layers; VRAM below the quant's own floor doesn't count
 *      at all, and a CPU-capable quant with min_vram_mb: 0 never adds VRAM
 *      even if a GPU is present, since it wasn't asked to be used).
 *
 * Thresholds (exact-integer comparison, no floating-point boundary noise):
 *   min_ram_mb <= effective                    -> "fits"
 *   min_ram_mb <= effective * 1.10 (inclusive)  -> "tight"
 *   otherwise                                   -> "wont_fit"
 *
 * "tight" deliberately carries both meanings (near the limit / needs other
 * models stopped) — no fourth badge value (D3); the hint copy says both.
 *
 * @param {Probe|null|undefined} probe
 * @param {{min_ram_mb?: number, min_vram_mb?: number}} quant
 * @returns {"fits"|"tight"|"wont_fit"|"unknown"}
 */
export function fitBadge(probe, quant) {
  if (!probe || probe.ramAvailableMb == null) return "unknown";
  const minRam = quant?.min_ram_mb;
  if (typeof minRam !== "number" || !Number.isFinite(minRam)) return "unknown";

  let effective = probe.ramAvailableMb;
  if (probe.unified === true) {
    const gtt = positiveOrNull(probe.gttTotalMb);
    const total = positiveOrNull(probe.ramTotalMb);
    if (gtt != null && total != null && 4 * gtt >= 3 * total) {
      // GTT-expanded APU: gtt >= 0.75 x MemTotal, integer-exact. The
      // ceiling is checked FIRST: on an idle box MemAvailable can exceed
      // GTT, and a quant above GTT can still never be GPU-resident.
      if (minRam > gtt) return "wont_fit";
      if (minRam <= effective) return "fits";
      return "tight";
    }
    // Any other unified host: today's formula, never the VRAM credit.
  } else {
    const minVram = typeof quant?.min_vram_mb === "number" ? quant.min_vram_mb : 0;
    if (minVram > 0 && typeof probe.vramMb === "number" && probe.vramMb >= minVram) {
      effective += probe.vramMb;
    }
  }

  if (minRam <= effective) return "fits";
  if (10 * minRam <= 11 * effective) return "tight"; // minRam / effective <= 1.10, integer-exact
  return "wont_fit";
}
```

In `servers/gateway/dashboard/shared/i18n.js`, replace line 735 with:

```js
  "models.fitTightHint": { en: "Close to your limits — may run slowly, use swap, or need other models stopped first.", es: "Cerca de tus límites — puede ejecutarse lento, usar memoria de intercambio o necesitar que otros modelos se detengan primero." },
```

The panel embeds this through `tJs`, which escapes `'`, backticks and `${`. The new copy contains none of them.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-probe.test.js
```
Expected: PASS. All pre-existing discrete `fitBadge` tests stay green unchanged.

Then run the i18n parity gate and the catalog panel tests, which render the hint:
```bash
cd /home/kh0pp/crow-wt-halo-profile && ls tests | grep -iE "i18n|model-catalog|models-panel"
```
Run each listed file with `npm test -- tests/<file>`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow-wt-halo-profile
git commit servers/gateway/models/probe.js servers/gateway/dashboard/shared/i18n.js tests/models-probe.test.js -m "feat(models): fitBadge on unified memory — GTT ceiling, no VRAM double-count"
git show --stat HEAD
```

---

### Task 3: Per-model runtime override store and resolve order

**Files:**
- Modify: `servers/gateway/models/state.js` (header doc `:33-34`, `emptyState` `:81-83`, `loadState` `:144-164`)
- Modify: `servers/gateway/models/runtime-override.js` (append after `getRuntimeOverride`, and update the header)
- Modify: `servers/gateway/gpu-orchestrator.js` (import `:90`, `resolveNativeBinPath` `:686-721`, callers `:854` and `:1164`)
- Test: `tests/models-state.test.js` (3 shape assertions), `tests/models-runtime-override.test.js`, `tests/gpu-orchestrator-native.test.js`

**Interfaces:**
- Consumes: the existing `validateBinary(bin, { accessSyncImpl, spawnSyncImpl })` (module-private), `loadState`, `saveState` and `RuntimeOverrideError`.
- Produces:
  - `resolveNativeBinPath` warms the probe cache (`getCachedProbeFn() || await reprobeFn()`) before any override early-return. Task 5 relies on this: `startNativeAndAwaitReady` only reads `getCachedProbeFn()`.
  - `getModelRuntimeOverride(dir, catalogId, { loadStateFn }?) → { bin, label, version, setAt, source: "state" } | null`
  - `setModelRuntimeOverride(dir, catalogId, bin, { label?, loadStateFn?, saveStateFn?, now?, accessSyncImpl?, spawnSyncImpl? }?) → { bin, label, version, setAt }`. It throws `RuntimeOverrideError`, with codes `BAD_MODEL_ID`, `NOT_ABSOLUTE`, `NOT_EXECUTABLE` and `VERSION_FAILED`.
  - `clearModelRuntimeOverride(dir, catalogId, { loadStateFn?, saveStateFn? }?) → boolean`
  - `listModelRuntimeOverrides(dir, { loadStateFn }?) → { [catalogId]: record }` (a copy)
  - `state.runtimeOverrides: { [catalogId]: { bin, label, version, setAt } }`, always an object after `loadState`.
  - A new orchestrator opts seam, `getModelRuntimeOverrideFn(dir, id)`. `resolveNativeBinPath` now reads `opts.providerName`.

- [ ] **Step 1: Write the failing tests**

**(a)** In `tests/models-state.test.js`, update the three shape assertions that the spec changes.

- In `"loadState on a missing state file returns an empty state, not a throw"` and `"loadState on a corrupt (non-JSON) state file returns an empty state, not a throw"`, change the expected literal to:

```js
    assert.deepEqual(state, { reservations: {}, journal: {}, registry: {}, conversions: {}, runtimeOverride: null, runtimeOverrides: {} });
```

- In `"saveState + loadState round-trip atomically and deep-equal"`, add `runtimeOverrides: {},` directly after `runtimeOverride: null,` in the `state` literal.

Then append these tests at the end of the file:

```js
test("loadState: runtimeOverrides round-trips; absent, null or an array loads as {} without touching runtimeOverride", async () => {
  const dir = mkdtempSync(join(tmpdir(), "models-state-"));
  try {
    const host = { bin: "/x/llama-server", label: null, version: "b1", setAt: "2026-09-23T00:00:00Z" };
    const perModel = { "qwen3.6-35b-a3b": { bin: "/opt/pr/llama-server", label: "pr-1234", version: "b9999", setAt: "2026-09-23T00:00:00Z" } };
    saveState(dir, { ...loadState(dir), runtimeOverride: host, runtimeOverrides: perModel });
    assert.deepEqual(loadState(dir).runtimeOverrides, perModel);
    assert.deepEqual(loadState(dir).runtimeOverride, host);

    for (const bad of [undefined, null, ["x"], "str"]) {
      mkdirSync(join(dir, "models"), { recursive: true });
      writeFileSync(statePath(dir), JSON.stringify({ registry: {}, runtimeOverride: host, runtimeOverrides: bad }), "utf8");
      assert.deepEqual(loadState(dir).runtimeOverrides, {}, `runtimeOverrides=${JSON.stringify(bad)}`);
      assert.deepEqual(loadState(dir).runtimeOverride, host);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Check that `mkdirSync`, `writeFileSync`, `statePath`, `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `loadState` and `saveState` are imported at the top of the file. They are already used by existing tests there. Add any that are missing to the existing import lines.

**(b)** In `tests/models-runtime-override.test.js`, two import lines change.

Replace line 6 exactly,

```js
import { loadState } from "../servers/gateway/models/state.js";
```

with

```js
import { loadState, saveState } from "../servers/gateway/models/state.js";
```

and replace line 7 exactly,

```js
import { getRuntimeOverride, setRuntimeOverride, clearRuntimeOverride, parseLlamaServerVersion, RuntimeOverrideError } from "../servers/gateway/models/runtime-override.js";
```

with

```js
import {
  getRuntimeOverride, setRuntimeOverride, clearRuntimeOverride, parseLlamaServerVersion, RuntimeOverrideError,
  getModelRuntimeOverride, setModelRuntimeOverride, clearModelRuntimeOverride, listModelRuntimeOverrides,
} from "../servers/gateway/models/runtime-override.js";
```

Append:

```js
// --- per-model overrides (Strix Halo spec §2.3, D4) -----------------------

test("per-model override: set, get, list, clear round-trip through state.json", () => withDir((dir) => {
  const opts = { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess, now: () => new Date("2026-09-23T00:00:00Z"), label: "pr-1234" };
  const rec = setModelRuntimeOverride(dir, "qwen3.6-35b-a3b", "/opt/pr/llama-server", opts);
  assert.deepEqual(rec, { bin: "/opt/pr/llama-server", label: "pr-1234", version: "b10068", setAt: "2026-09-23T00:00:00.000Z" });
  assert.deepEqual(loadState(dir).runtimeOverrides, { "qwen3.6-35b-a3b": rec });
  assert.deepEqual(getModelRuntimeOverride(dir, "qwen3.6-35b-a3b"), { ...rec, source: "state" });
  assert.equal(getModelRuntimeOverride(dir, "other-model"), null);
  assert.deepEqual(listModelRuntimeOverrides(dir), { "qwen3.6-35b-a3b": rec });
  assert.equal(clearModelRuntimeOverride(dir, "qwen3.6-35b-a3b"), true);
  assert.equal(clearModelRuntimeOverride(dir, "qwen3.6-35b-a3b"), false);
  assert.deepEqual(listModelRuntimeOverrides(dir), {});
}));

test("per-model override: label defaults to null; a second model and the host override coexist untouched", () => withDir((dir) => {
  const v = { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess };
  const host = setRuntimeOverride(dir, { bin: "/opt/host/llama-server" }, v);
  saveState(dir, { ...loadState(dir), registry: { "a@Q4": { file: "a.gguf", catalogId: "a", quant: "Q4" } } });
  setModelRuntimeOverride(dir, "a", "/opt/a/llama-server", v);
  setModelRuntimeOverride(dir, "b", "/opt/b/llama-server", v);
  const s = loadState(dir);
  assert.equal(s.runtimeOverrides.a.label, null);
  assert.deepEqual(Object.keys(s.runtimeOverrides).sort(), ["a", "b"]);
  assert.deepEqual(s.runtimeOverride, host);
  assert.equal(s.registry["a@Q4"].file, "a.gguf");
  clearModelRuntimeOverride(dir, "a");
  assert.deepEqual(loadState(dir).runtimeOverride, host, "clearing a per-model override never touches the host override");
  assert.ok(loadState(dir).runtimeOverrides.b);
}));

test("per-model override: validateBinary errors are the host override's, and nothing persists", () => withDir((dir) => {
  assert.throws(() => setModelRuntimeOverride(dir, "a", "llama-server", { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess }),
    (e) => e instanceof RuntimeOverrideError && e.code === "NOT_ABSOLUTE");
  assert.throws(() => setModelRuntimeOverride(dir, "a", "/x/llama-server", { spawnSyncImpl: okSpawn, accessSyncImpl: () => { throw new Error("EACCES"); } }),
    (e) => e.code === "NOT_EXECUTABLE");
  assert.throws(() => setModelRuntimeOverride(dir, "a", "/x/llama-server", { spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "boom" }), accessSyncImpl: okAccess }),
    (e) => e.code === "VERSION_FAILED");
  assert.deepEqual(loadState(dir).runtimeOverrides, {});
}));

test("per-model override: a missing/empty/prototype-ish model id is refused with BAD_MODEL_ID; lookups of them return null", () => withDir((dir) => {
  const v = { spawnSyncImpl: okSpawn, accessSyncImpl: okAccess };
  for (const id of [undefined, "", " ", "__proto__", "has space", 42]) {
    assert.throws(() => setModelRuntimeOverride(dir, id, "/x/llama-server", v), (e) => e.code === "BAD_MODEL_ID", String(id));
  }
  assert.equal(getModelRuntimeOverride(dir, "constructor"), null);
  assert.equal(getModelRuntimeOverride(dir, ""), null);
  assert.equal(clearModelRuntimeOverride(dir, "toString"), false);
}));
```

**(c)** In `tests/gpu-orchestrator-native.test.js`:

- in `startCapableOpts`, add `getModelRuntimeOverrideFn: () => null,` directly after `getRuntimeOverrideFn: () => null,`;
- add `_resetProbeFailureWindowForTest` to the `gpu-orchestrator.js` import list, and call `_resetProbeFailureWindowForTest();` as the last line of the top-level `beforeEach`. The window is module state, and a throwing-probe test must not starve a later cold-cache test;
- append these tests after `"native start: the runtime override binary wins over the catalog release; a vanished override falls back"`:

```js
// --- per-model runtime override resolve order (Strix Halo spec §2.3, D4) ---

test("runtime resolve: a per-model override wins over the host override and the stock release", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18100, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  const asked = [];
  opts.getModelRuntimeOverrideFn = (dir, id) => { asked.push([dir, id]); return { bin: "/opt/model/llama-server" }; };
  opts.getRuntimeOverrideFn = () => ({ bin: "/opt/host/llama-server" });
  let ensured = 0; opts.ensureRuntimeFn = async () => { ensured++; return "/fake/release/llama-server"; };
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/opt/model/llama-server");
  assert.equal(ensured, 0, "ensureRuntime (and so min_runtime_version) skipped under a per-model override");
  assert.deepEqual(asked[0], ["/fake/crow-home", "native-target"]);
});

test("runtime resolve: the per-model key is gpuPolicy.catalogId, not the provider name", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18101, "qwen3-4b") } }; // catalogId "qwen3-4b"
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  const asked = [];
  opts.getModelRuntimeOverrideFn = (dir, id) => { asked.push(id); return id === "qwen3-4b" ? { bin: "/opt/qwen/llama-server" } : null; };
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/opt/qwen/llama-server");
  assert.deepEqual([...new Set(asked)], ["qwen3-4b"]);
});

test("runtime resolve: with no gpuPolicy.catalogId the per-model key falls back to the provider name", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18102, "qwen3-4b", { gpuPolicy: { catalogId: undefined } }) } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getModelRuntimeOverrideFn = (dir, id) => (id === "native-target" ? { bin: "/opt/byname/llama-server" } : null);
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/opt/byname/llama-server");
});

test("runtime resolve: a missing per-model bin falls through to the host override", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18103, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/gone-model-a/llama-server" });
  opts.getRuntimeOverrideFn = () => ({ bin: "/opt/host/llama-server" });
  opts.existsSyncFn = (p) => p !== "/opt/gone-model-a/llama-server";
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/opt/host/llama-server");
});

test("runtime resolve: missing per-model AND missing host bins fall through to the stock release", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18104, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/gone-model-b/llama-server" });
  opts.getRuntimeOverrideFn = () => ({ bin: "/opt/gone-host-b/llama-server" });
  opts.existsSyncFn = (p) => p !== "/opt/gone-model-b/llama-server" && p !== "/opt/gone-host-b/llama-server";
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/fake/runtimes/llamacpp/b1/llama-server");
});

test("runtime resolve: a missing per-model bin warns once per bin across repeated acquires", async () => {
  const cfg = { providers: { "native-target": nativeProv(18105, "native-target") } };
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    for (let i = 0; i < 2; i++) {
      _setNativeHandleForTest("native-target", null);
      const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]) });
      opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/gone-warn-once/llama-server" });
      opts.existsSyncFn = (p) => p !== "/opt/gone-warn-once/llama-server";
      assert.equal(await acquireProvider("native-target", opts), true);
    }
  } finally { console.warn = origWarn; }
  assert.equal(warns.filter((w) => w.includes("/opt/gone-warn-once/llama-server")).length, 1, warns.join("\n"));
});

test("runtime resolve: ensureResident's native start also applies the per-model override", async () => {
  const startCalls = [];
  const p = nativeProv(18106, "qwen3-4b", { gpuPolicy: { alwaysResident: true, runtime: "native" } });
  const cfg = { providers: { "native-target": p } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getModelRuntimeOverrideFn = (dir, id) => (id === "qwen3-4b" ? { bin: "/opt/resident/llama-server" } : null);
  await ensureResident("native-target", cfg, opts);
  assert.equal(startCalls[0].binPath, "/opt/resident/llama-server");
});

test("runtime resolve: the probe is warmed BEFORE an override early-return (cold cache -> one reprobe)", async () => {
  const cfg = { providers: { "native-target": nativeProv(18107, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]) });
  let cached = null;
  let reprobeCalls = 0;
  opts.getCachedProbeFn = () => cached;
  opts.reprobeFn = async () => { reprobeCalls++; cached = { platform: "linux", accel: "cpu" }; return cached; };
  opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/warm/llama-server" });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(reprobeCalls, 1);
  assert.notEqual(cached, null, "an override start leaves the probe cache warm");
});

test("runtime resolve: a probe failure on an override path is remembered — two acquires inside 5 min reprobe once and warn once; after the window it probes again", async () => {
  const cfg = { providers: { "native-target": nativeProv(18109, "native-target") } };
  let t = 1_000_000;
  let reprobeCalls = 0;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  const acquire = async () => {
    _setNativeHandleForTest("native-target", null);
    const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]) });
    opts.getCachedProbeFn = () => null;
    opts.reprobeFn = async () => { reprobeCalls++; throw new Error("vulkaninfo exploded"); };
    opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/window/llama-server" });
    opts.nowFn = () => t;
    return acquireProvider("native-target", opts);
  };
  try {
    assert.equal(await acquire(), true);
    t += 60_000; // 1 min later, inside the window
    assert.equal(await acquire(), true);
    assert.equal(reprobeCalls, 1, "no re-probe inside the failure window");
    assert.equal(warns.filter((w) => w.includes("hardware probe failed")).length, 1, "one warning per window");
    t += 5 * 60_000; // past the window
    assert.equal(await acquire(), true);
    assert.equal(reprobeCalls, 2, "the window expired, so it probed again");
  } finally { console.warn = origWarn; }
});

test("runtime resolve: a probe failure is survivable on an override path but still surfaces on the stock path", async () => {
  const cfg = { providers: { "native-target": nativeProv(18108, "native-target") } };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const withOverride = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]) });
    withOverride.getCachedProbeFn = () => null;
    withOverride.reprobeFn = async () => { throw new Error("vulkaninfo exploded"); };
    withOverride.getModelRuntimeOverrideFn = () => ({ bin: "/opt/survive/llama-server" });
    assert.equal(await acquireProvider("native-target", withOverride), true);

    _setNativeHandleForTest("native-target", null);
    const stock = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]) });
    stock.getCachedProbeFn = () => null;
    stock.reprobeFn = async () => { throw new Error("vulkaninfo exploded"); };
    await assert.rejects(acquireProvider("native-target", stock), /vulkaninfo exploded/);
  } finally { console.warn = origWarn; }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-state.test.js && npm test -- tests/models-runtime-override.test.js ; npm test -- tests/gpu-orchestrator-native.test.js
```
Expected: FAIL.
- `models-state` fails on the missing `runtimeOverrides` key.
- `models-runtime-override` fails to load with `does not provide an export named 'getModelRuntimeOverride'`.
- The orchestrator's per-model tests get the stock or host bin instead of the override bin.

- [ ] **Step 3: Implement**

**(a)** In `servers/gateway/models/state.js`:

Replace the header bullet at `:33-34` with:

```js
 *   - runtimeOverride: `null`, or `{ bin, label, version, setAt }` naming an
 *     operator-chosen llama-server binary that wins over the catalog's release.
 *   - runtimeOverrides (keyed by catalog id, or provider name for a row with
 *     no catalogId): per-model `{ bin, label, version, setAt }` that wins over
 *     BOTH runtimeOverride and the release for that one model (Strix Halo
 *     runtime profile spec §2.3). Host-local like runtimeOverride — a binary
 *     path is host-specific, so this never goes in the synced gpu_policy.
```

Replace `emptyState`:

```js
function emptyState() {
  return { reservations: {}, journal: {}, registry: {}, conversions: {}, runtimeOverride: null, runtimeOverrides: {} };
}
```

In `loadState`, replace the returned object with:

```js
    return {
      reservations: obj("reservations"),
      journal: obj("journal"),
      registry: migrateRegistryKeys(obj("registry")),
      conversions: obj("conversions"),
      runtimeOverride:
        parsed && parsed.runtimeOverride && typeof parsed.runtimeOverride === "object"
          ? parsed.runtimeOverride
          : null,
      runtimeOverrides:
        parsed && parsed.runtimeOverrides && typeof parsed.runtimeOverrides === "object" && !Array.isArray(parsed.runtimeOverrides)
          ? parsed.runtimeOverrides
          : {},
    };
```

**(b)** In `servers/gateway/models/runtime-override.js`, append this paragraph to the header comment, before its closing ` */`:

```js
 *
 * Per-model overrides (Strix Halo runtime profile spec §2.3, D4) live in
 * `state.runtimeOverrides[catalogId]` with the same record shape and the
 * same `validateBinary`. The orchestrator resolves per-model -> host ->
 * catalog release. Unlike the host override there is no env bootstrap.
```

Append at the end of the file:

```js
// ---------------------------------------------------------------------------
// Per-model overrides (Strix Halo runtime profile spec §2.3, D4)
// ---------------------------------------------------------------------------

// A catalog id ("qwen3.6-35b-a3b") or a provider name ("crow-chat"). The
// leading [A-Za-z0-9] keeps "__proto__"-style keys out of the map.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function assertModelId(catalogId) {
  if (typeof catalogId !== "string" || !MODEL_ID_RE.test(catalogId)) {
    throw new RuntimeOverrideError(
      `a per-model runtime override needs a model id (catalog id or provider name), got ${JSON.stringify(catalogId)}`,
      "BAD_MODEL_ID",
    );
  }
}

function overridesOf(state) {
  const m = state && state.runtimeOverrides;
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

/** The stored per-model override for `catalogId` (source: "state"), or null. Never bootstraps. */
export function getModelRuntimeOverride(dir, catalogId, { loadStateFn = loadState } = {}) {
  if (typeof catalogId !== "string" || !catalogId) return null;
  const map = overridesOf(loadStateFn(dir));
  if (!Object.hasOwn(map, catalogId)) return null;
  const rec = map[catalogId];
  return rec && typeof rec.bin === "string" ? { ...rec, source: "state" } : null;
}

/**
 * Validate `bin` exactly like the host override, then persist
 * `{ bin, label, version, setAt }` under `state.runtimeOverrides[catalogId]`.
 * Throws RuntimeOverrideError (BAD_MODEL_ID / NOT_ABSOLUTE / NOT_EXECUTABLE /
 * VERSION_FAILED) — nothing is persisted in that case. `opts.label` is the
 * optional human label.
 */
export function setModelRuntimeOverride(dir, catalogId, bin, opts = {}) {
  assertModelId(catalogId);
  const { label = null, loadStateFn = loadState, saveStateFn = saveState, now = () => new Date() } = opts;
  const version = validateBinary(bin, opts);
  const record = { bin, label, version, setAt: now().toISOString() };
  const state = loadStateFn(dir);
  state.runtimeOverrides = { ...overridesOf(state), [catalogId]: record };
  saveStateFn(dir, state);
  return record;
}

/** Remove the per-model override for `catalogId`. Returns true iff one was set. */
export function clearModelRuntimeOverride(dir, catalogId, { loadStateFn = loadState, saveStateFn = saveState } = {}) {
  if (typeof catalogId !== "string" || !catalogId) return false;
  const state = loadStateFn(dir);
  const map = { ...overridesOf(state) };
  if (!Object.hasOwn(map, catalogId)) return false;
  delete map[catalogId];
  state.runtimeOverrides = map;
  saveStateFn(dir, state);
  return true;
}

/** A copy of every stored per-model override, keyed by model id. */
export function listModelRuntimeOverrides(dir, { loadStateFn = loadState } = {}) {
  return { ...overridesOf(loadStateFn(dir)) };
}
```

**(c)** In `servers/gateway/gpu-orchestrator.js`:

Change the import at `:90` to:

```js
import { getRuntimeOverride, getModelRuntimeOverride } from "./models/runtime-override.js";
```

Replace the `resolveNativeBinPath` function head, from `async function resolveNativeBinPath(p, opts = {}) {` down to and including the host-override block that ends with `console.warn(... falling back to the catalog release\`); }`, with:

```js
// Missing-override warnings fire once per bin (spec §2.3) — an acquire runs
// on every chat turn, and a vanished binary would otherwise spam the log.
// A bin that reappears re-arms its warning.
const _warnedMissingOverrideBins = new Set();

// Probe-failure window (review round 2). When the pre-override probe
// warm-up throws, remember when; for the next PROBE_RETRY_MS no warm-up
// re-probes (each acquire of an override-started model would otherwise
// fork vulkaninfo/nvidia-smi/rocminfo again), and the warning fires once
// per window. The stock path is unchanged: it still probes itself when it
// has no probe, because it cannot pick a runtime asset without one.
export const PROBE_RETRY_MS = 5 * 60 * 1000;
let _probeFailedAt = null;
/** Test seam: forget any remembered probe failure. */
export function _resetProbeFailureWindowForTest() {
  _probeFailedAt = null;
}
function warnMissingOverrideOnce(bin, message) {
  if (_warnedMissingOverrideBins.has(bin)) return;
  _warnedMissingOverrideBins.add(bin);
  console.warn(`[gpu-orchestrator] ${message}`);
}

async function resolveNativeBinPath(p, opts = {}) {
  const {
    ensureRuntimeFn = ensureRuntime,
    resolveDataDirFn = resolveDataDir,
    loadCatalogFn = defaultLoadCatalog,
    getCachedProbeFn = getCachedProbe,
    reprobeFn = reprobe,
    getRuntimeOverrideFn = getRuntimeOverride,
    getModelRuntimeOverrideFn = getModelRuntimeOverride,
    existsSyncFn = existsSync,
    providerName = null,
    nowFn = Date.now,
  } = opts;
  const dir = resolveDataDirFn();

  // Warm the probe cache FIRST (Fix 1: nothing on the boot path calls
  // reprobe()), before any override early-return, so an override start
  // also leaves it warm for startNativeAndAwaitReady's host launch profile
  // (Strix Halo spec §2.4, review round 1). A probe failure is only fatal
  // on the stock path, which needs the probe to pick a runtime asset.
  // A failure is remembered for PROBE_RETRY_MS: inside that window the
  // warm-up does not re-probe, and it warns once per window.
  let probe = getCachedProbeFn();
  let probeError = null;
  if (!probe) {
    const now = nowFn();
    const inFailureWindow = _probeFailedAt !== null && now - _probeFailedAt < PROBE_RETRY_MS;
    if (!inFailureWindow) {
      try {
        probe = await reprobeFn();
        _probeFailedAt = null;
      } catch (err) {
        probeError = err;
        _probeFailedAt = now;
        console.warn(`[gpu-orchestrator] hardware probe failed (not retried for ${PROBE_RETRY_MS / 60000} min on override starts): ${err.message}`);
      }
    }
  }

  // Resolve order (Strix Halo runtime profile spec §2.3): per-model
  // override -> host override -> stock catalog release. Each override layer
  // whose bin is missing warns once and falls through. Either override
  // skips ensureRuntime — and therefore min_runtime_version.
  const modelId = p?.gpuPolicy?.catalogId || providerName;
  if (modelId) {
    const perModel = getModelRuntimeOverrideFn(dir, modelId);
    if (perModel && typeof perModel.bin === "string") {
      if (existsSyncFn(perModel.bin)) {
        _warnedMissingOverrideBins.delete(perModel.bin);
        return perModel.bin;
      }
      warnMissingOverrideOnce(perModel.bin, `per-model runtime override for "${modelId}" (${perModel.bin}) is missing — falling back to the host override or the catalog release`);
    }
  }
  const override = getRuntimeOverrideFn(dir);
  if (override && typeof override.bin === "string") {
    if (existsSyncFn(override.bin)) {
      _warnedMissingOverrideBins.delete(override.bin);
      return override.bin;
    }
    warnMissingOverrideOnce(override.bin, `runtime override ${override.bin} is missing — falling back to the catalog release`);
  }
```

Then replace the old probe block that follows `const catalog = loadCatalogFn();` — from the `// Fix 1 (final-review fix wave, CRITICAL)` comment through `probe = await reprobeFn();\n  }` — with:

```js
  // The probe was warmed at the top of this function (Fix 1 still holds:
  // one reprobe on a cold cache, none after). The stock path needs it:
  // a failure from THIS call surfaces as-is; a warm-up skipped by the
  // failure window gets one real probe here, exactly as before this change.
  if (probeError) throw probeError;
  if (!probe) probe = await reprobeFn();
```

Leave the rest of the function unchanged, from `const key = ...` to the end.

In `startNativeAndAwaitReady`, replace

```js
  const binPath = preResolvedBinPath || await resolveNativeBinPath(p, opts);
```

with

```js
  const binPath = preResolvedBinPath || await resolveNativeBinPath(p, { ...opts, providerName });
```

In `acquireProvider`'s native branch, replace

```js
    const binPath = await resolveNativeBinPath(p, opts);
```

with

```js
    const binPath = await resolveNativeBinPath(p, { ...opts, providerName });
```

Finally, update the `resolveNativeBinPath` doc comment. Add as its first line: `Resolve order: per-model override (state.runtimeOverrides[catalogId || providerName]) -> host override -> catalog release (Strix Halo spec §2.3).`

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile
npm test -- tests/models-state.test.js
npm test -- tests/models-runtime-override.test.js
npm test -- tests/gpu-orchestrator-native.test.js
npm test -- tests/gpu-orchestrator-serving-class.test.js
npm test -- tests/chat-template-kwargs.test.js
```
Expected: all PASS. The last two exercise native starts through their own harnesses, which have no `getModelRuntimeOverrideFn`. There the default reads their fake or scratch data dir, finds no `state.json`, and returns null.

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow-wt-halo-profile
git commit servers/gateway/models/state.js servers/gateway/models/runtime-override.js servers/gateway/gpu-orchestrator.js tests/models-state.test.js tests/models-runtime-override.test.js tests/gpu-orchestrator-native.test.js -m "feat(models): per-model runtime override — state.json store, resolved before the host override"
git show --stat HEAD
```

---

### Task 4: Operator CLI `scripts/models-runtime-override.mjs`

**Files:**
- Create: `scripts/models-runtime-override.mjs`
- Test: `tests/models-runtime-override-cli.test.js` (create)

**Interfaces:**
- Consumes: from Task 3, `getModelRuntimeOverride`, `setModelRuntimeOverride`, `clearModelRuntimeOverride` and `listModelRuntimeOverrides`. From the existing code: `setRuntimeOverride`, `clearRuntimeOverride`, `RuntimeOverrideError`, `loadState` and `resolveDataDir` (`servers/db.js`).
- Produces: `main(argv: string[], deps?: { dir?, out?, err?, overrideOpts?, catalogIds?, env? }) → Promise<0|1|2|3>` and `EXIT_CONCURRENT_WRITE = 3`.
  - Exit codes: 0 is ok, 1 is refused by validation, 2 is a usage error, 3 means a concurrent gateway write overwrote the change twice.
  - Every write is re-read and verified, and retried once on a mismatch. `overrideOpts` is forwarded to the library set/clear calls, so tests can inject a clobbering `saveStateFn`.
  - `set` and `clear` print `(data dir: <dir>)`. `clear` without `--model` writes nothing when no host override is stored. Host `get`/`clear` warn when `env.CROW_LLAMA_SERVER_BIN` is set.
  - Run directly, the script sets `process.exitCode` from `main(process.argv.slice(2))`.
  - Data dir: `resolveDataDir()`, the gateway's own helper. It honours `CROW_DATA_DIR`, else `~/.crow/data`, else the repo `./data`.

- [ ] **Step 1: Write the failing tests**

Create `tests/models-runtime-override-cli.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, EXIT_CONCURRENT_WRITE } from "../scripts/models-runtime-override.mjs";
import { loadState, saveState, statePath } from "../servers/gateway/models/state.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "models-runtime-override.mjs");
const overrideOpts = {
  accessSyncImpl: () => {},
  spawnSyncImpl: () => ({ status: 0, stdout: "", stderr: "version: 10068 (abc1234)\n" }),
  now: () => new Date("2026-09-23T00:00:00Z"),
};

async function run(dir, argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    dir,
    out: (s) => out.push(String(s)),
    err: (s) => err.push(String(s)),
    overrideOpts,
    catalogIds: ["qwen3.6-35b-a3b"],
    env: {},
    ...extra,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rt-override-cli-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A saveStateFn that saves, then lets a "gateway" clobber the file `times` times. */
function clobberingSave(times, clobber) {
  let left = times;
  return (d, st) => {
    saveState(d, st);
    if (left > 0) {
      left -= 1;
      saveState(d, clobber(st));
    }
  };
}
const dropOverrides = (st) => ({ ...st, runtimeOverride: null, runtimeOverrides: {} });

test("cli: set --model, get --model, list, clear --model round-trip; set/clear print the data dir", () => withDir(async (dir) => {
  const set = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server", "--label", "pr-1234"]);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /qwen3\.6-35b-a3b.*\/opt\/pr\/llama-server.*b10068/);
  assert.ok(set.out.includes(`(data dir: ${dir})`), set.out);
  assert.equal(set.err, "", "a catalog id produces no warning");

  const get = await run(dir, ["get", "--model", "qwen3.6-35b-a3b"]);
  assert.equal(get.code, 0);
  assert.deepEqual(JSON.parse(get.out), { bin: "/opt/pr/llama-server", label: "pr-1234", version: "b10068", setAt: "2026-09-23T00:00:00.000Z" });

  const list = await run(dir, ["list"]);
  assert.equal(list.code, 0);
  const parsed = JSON.parse(list.out);
  assert.equal(parsed.dataDir, dir);
  assert.equal(parsed.host, null);
  assert.equal(parsed.models["qwen3.6-35b-a3b"].bin, "/opt/pr/llama-server");

  const clear = await run(dir, ["clear", "--model", "qwen3.6-35b-a3b"]);
  assert.equal(clear.code, 0);
  assert.match(clear.out, /cleared/);
  assert.ok(clear.out.includes(`(data dir: ${dir})`), clear.out);
  assert.deepEqual(loadState(dir).runtimeOverrides, {});
  assert.match((await run(dir, ["clear", "--model", "qwen3.6-35b-a3b"])).out, /nothing to clear/);
  assert.equal((await run(dir, ["get", "--model", "qwen3.6-35b-a3b"])).out, "none");
}));

test("cli: without --model, set/get/clear act on the host override and leave per-model entries alone", () => withDir(async (dir) => {
  await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"]);
  assert.equal((await run(dir, ["get"])).out, "none");
  const set = await run(dir, ["set", "--bin", "/opt/host/llama-server"]);
  assert.equal(set.code, 0, set.err);
  assert.ok(set.out.includes(`(data dir: ${dir})`), set.out);
  assert.equal(JSON.parse((await run(dir, ["get"])).out).bin, "/opt/host/llama-server");
  assert.equal((await run(dir, ["clear"])).code, 0);
  assert.equal(loadState(dir).runtimeOverride, null);
  assert.ok(loadState(dir).runtimeOverrides["qwen3.6-35b-a3b"], "per-model entry survived the host clear");
}));

test("cli: host clear with no host override stored neither creates nor rewrites state.json", () => withDir(async (dir) => {
  const r = await run(dir, ["clear"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to clear \(host override\)/);
  assert.equal(existsSync(statePath(dir)), false);
}));

test("cli: host get/clear warn when CROW_LLAMA_SERVER_BIN is set; --model commands and an unset env do not", () => withDir(async (dir) => {
  const env = { CROW_LLAMA_SERVER_BIN: "/opt/env/llama-server" };
  assert.match((await run(dir, ["get"], { env })).err, /CROW_LLAMA_SERVER_BIN is set.*re-bootstraps the host override/);
  assert.match((await run(dir, ["clear"], { env })).err, /re-bootstraps the host override/);
  assert.equal((await run(dir, ["get", "--model", "qwen3.6-35b-a3b"], { env })).err, "");
  assert.equal((await run(dir, ["get"])).err, "");
}));

test("cli: a write clobbered once by a concurrent gateway write is retried and lands (exit 0)", () => withDir(async (dir) => {
  const r = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"], {
    overrideOpts: { ...overrideOpts, saveStateFn: clobberingSave(1, dropOverrides) },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(loadState(dir).runtimeOverrides["qwen3.6-35b-a3b"].bin, "/opt/pr/llama-server");
}));

test("cli: a write clobbered twice exits 3 naming the concurrent gateway write (set, host set, and clear)", () => withDir(async (dir) => {
  const always = { ...overrideOpts, saveStateFn: clobberingSave(99, dropOverrides) };
  const setModel = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"], { overrideOpts: always });
  assert.equal(setModel.code, EXIT_CONCURRENT_WRITE);
  assert.match(setModel.err, /concurrent gateway write overwrote it/);
  const setHost = await run(dir, ["set", "--bin", "/opt/host/llama-server"], { overrideOpts: always });
  assert.equal(setHost.code, EXIT_CONCURRENT_WRITE);

  // clear: the "gateway" keeps writing the old record back.
  await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "/opt/pr/llama-server"]);
  const rec = loadState(dir).runtimeOverrides["qwen3.6-35b-a3b"];
  const restore = { ...overrideOpts, saveStateFn: clobberingSave(99, (st) => ({ ...st, runtimeOverrides: { "qwen3.6-35b-a3b": rec } })) };
  const clear = await run(dir, ["clear", "--model", "qwen3.6-35b-a3b"], { overrideOpts: restore });
  assert.equal(clear.code, EXIT_CONCURRENT_WRITE);
  assert.match(clear.err, /concurrent gateway write overwrote it/);
}));

test("cli: a binary that fails validation exits 1 with the code, and persists nothing", () => withDir(async (dir) => {
  const rel = await run(dir, ["set", "--model", "qwen3.6-35b-a3b", "--bin", "llama-server"]);
  assert.equal(rel.code, 1);
  assert.match(rel.err, /NOT_ABSOLUTE/);
  const bad = await run(dir, ["set", "--bin", "/x/llama-server"], {
    overrideOpts: { ...overrideOpts, spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "boom" }) },
  });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /VERSION_FAILED/);
  assert.deepEqual(loadState(dir).runtimeOverrides, {});
  assert.equal(loadState(dir).runtimeOverride, null);
}));

test("cli: an id matching no catalog id and no registered model warns but is still stored (provider-name fallback is legal)", () => withDir(async (dir) => {
  const r = await run(dir, ["set", "--model", "crow-chat", "--bin", "/opt/x/llama-server"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /warning: "crow-chat" matches no catalog id/);
  assert.ok(loadState(dir).runtimeOverrides["crow-chat"]);

  saveState(dir, { ...loadState(dir), registry: { "my-hf-model@Q4": { file: "m.gguf", catalogId: "my-hf-model", quant: "Q4" } } });
  const reg = await run(dir, ["set", "--model", "my-hf-model", "--bin", "/opt/x/llama-server"]);
  assert.equal(reg.err, "", "a registered catalogId is known — no warning");
}));

test("cli: usage errors exit 2", () => withDir(async (dir) => {
  for (const argv of [[], ["frobnicate"], ["set"], ["list", "--bogus"], ["get", "--model", ""], ["list", "extra"]]) {
    const r = await run(dir, argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /usage|needs|Unknown option|unknown command/i, JSON.stringify(argv));
  }
  assert.equal((await run(dir, ["--help"])).code, 0);
}));

test("cli (child process): resolves the data dir from CROW_DATA_DIR; list/get/host-clear never write state or bootstrap CROW_LLAMA_SERVER_BIN", () => withDir(async (dir) => {
  saveState(dir, { ...loadState(dir), runtimeOverrides: { "qwen3.6-35b-a3b": { bin: "/opt/seeded/llama-server", label: null, version: "b1", setAt: "2026-09-23T00:00:00Z" } } });
  const env = { ...process.env, CROW_DATA_DIR: dir };
  delete env.CROW_LLAMA_SERVER_BIN;
  const list = spawnSync(process.execPath, [SCRIPT, "list"], { env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.dataDir, resolve(dir));
  assert.equal(parsed.models["qwen3.6-35b-a3b"].bin, "/opt/seeded/llama-server");

  // A fresh dir + an env bin that WOULD validate (node --version exits 0):
  // if any of these went through getRuntimeOverride's bootstrap, or host
  // clear wrote unconditionally, state.json would appear. It must not.
  const fresh = mkdtempSync(join(tmpdir(), "rt-override-cli-fresh-"));
  try {
    const env2 = { ...process.env, CROW_DATA_DIR: fresh, CROW_LLAMA_SERVER_BIN: process.execPath };
    for (const argv of [["list"], ["get"], ["clear"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...argv], { env: env2, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(existsSync(statePath(fresh)), false, "read-only commands and a no-op host clear must not create state.json");
  } finally { rmSync(fresh, { recursive: true, force: true }); }
}));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-runtime-override-cli.test.js
```
Expected: FAIL with `Cannot find module '.../scripts/models-runtime-override.mjs'`.

- [ ] **Step 3: Implement**

Create `scripts/models-runtime-override.mjs`:

```js
#!/usr/bin/env node
/**
 * models-runtime-override.mjs — inspect, set and clear the llama-server
 * runtime overrides in <data dir>/models/state.json (Strix Halo runtime
 * profile spec §2.3, D5). This is how a pi-lab pre-merge llama.cpp build
 * reaches ONE model without touching the rest of the host.
 *
 *   list                                              host + every per-model override (JSON)
 *   get   [--model <id>]                              one record (JSON) or "none"
 *   set   --bin <abs path> [--model <id>] [--label <s>]
 *   clear [--model <id>]
 *
 * Without --model a command acts on the HOST override. <id> is the provider
 * row's gpu_policy.catalogId (or the provider name for a row without one);
 * a catalogId override applies to every quant/variant row of that model.
 * `set` validates exactly like the gateway: absolute path, executable,
 * `<bin> --version` exits 0.
 *
 * Data dir: resolveDataDir() — the gateway's own helper (CROW_DATA_DIR, else
 * ~/.crow/data, else the repo's ./data). For r4:
 *   CROW_DATA_DIR=/home/kh0pp/.crow-r4/data node scripts/models-runtime-override.mjs …
 * `set`/`clear` print the data dir they wrote. The gateway reads state.json
 * on every native start, so no restart is needed; a model that is already
 * running keeps its binary until it is stopped and started again.
 *
 * Second writer: the gateway also rewrites state.json (reservations,
 * registry, liveness markers) with a whole-file load/modify/save, so a
 * gateway write can land between our write and the next read and silently
 * drop our change. Every write is therefore re-read and verified; on a
 * mismatch it is retried once, then the CLI exits 3 saying a concurrent
 * gateway write overwrote it. The read-back NARROWS the race but does not
 * close it: a gateway that loaded state.json before our write and saves
 * after our read-back still wins, silently. After a `set`/`clear`, verify
 * with `get` after the next gateway restart.
 *
 * `list`/`get` read state.json directly — they never go through
 * getRuntimeOverride(), whose CROW_LLAMA_SERVER_BIN bootstrap would WRITE
 * state from a read command. `clear` without --model writes nothing when
 * no host override is stored.
 *
 * Exit codes: 0 ok, 1 refused (binary/id validation), 2 usage,
 * 3 overwritten by a concurrent gateway write.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveDataDir } from "../servers/db.js";
import { loadState } from "../servers/gateway/models/state.js";
import {
  setRuntimeOverride,
  clearRuntimeOverride,
  setModelRuntimeOverride,
  clearModelRuntimeOverride,
  listModelRuntimeOverrides,
  RuntimeOverrideError,
} from "../servers/gateway/models/runtime-override.js";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_PATH = join(REPO, "registry", "model-catalog.json");

export const EXIT_CONCURRENT_WRITE = 3;

export const USAGE = [
  "usage: node scripts/models-runtime-override.mjs <command> [options]",
  "  list",
  "  get   [--model <id>]",
  "  set   --bin <absolute path> [--model <id>] [--label <text>]",
  "  clear [--model <id>]",
  "without --model, get/set/clear act on the host-wide override",
].join("\n");

class ConcurrentWriteError extends Error {}

function defaultCatalogIds() {
  try {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    return (catalog.models || []).map((m) => m && m.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

function knownModelIds(dir, catalogIds) {
  const ids = new Set(catalogIds);
  for (const entry of Object.values(loadState(dir).registry || {})) {
    if (entry && typeof entry.catalogId === "string") ids.add(entry.catalogId);
  }
  return ids;
}

/**
 * Run `apply()` (one library write), re-read state.json, and confirm
 * `landed(state, result)`. Retry once on a mismatch; a second mismatch
 * throws ConcurrentWriteError. Returns the FIRST attempt's result (e.g.
 * clear's "was one set?").
 */
function writeVerified(dir, apply, landed) {
  const first = apply();
  if (landed(loadState(dir), first)) return first;
  const second = apply();
  if (landed(loadState(dir), second)) return first;
  throw new ConcurrentWriteError(
    `state.json at ${dir} did not keep the change after a retry — a concurrent gateway write overwrote it. Run the command again; if it keeps happening, check that the gateway on this data dir is current (an older gateway drops unknown state keys).`,
  );
}

const sameRecord = (stored, rec) => !!stored && stored.bin === rec.bin && stored.setAt === rec.setAt;

export async function main(argv, deps = {}) {
  const { out = (s) => console.log(s), err = (s) => console.error(s), overrideOpts = {}, env = process.env } = deps;

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        model: { type: "string" },
        bin: { type: "string" },
        label: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    err(USAGE);
    return 2;
  }
  const model = values.model;
  if (model !== undefined && model.trim() === "") {
    err(`--model needs a non-empty id\n${USAGE}`);
    return 2;
  }

  const cmd = positionals[0];
  const dir = deps.dir ?? resolveDataDir();

  if (!model && (cmd === "get" || cmd === "clear") && env.CROW_LLAMA_SERVER_BIN) {
    err(`warning: CROW_LLAMA_SERVER_BIN is set (${env.CROW_LLAMA_SERVER_BIN}) in this shell; a gateway started with it re-bootstraps the host override from it whenever none is stored`);
  }

  try {
    switch (cmd) {
      case "list": {
        const state = loadState(dir);
        out(JSON.stringify({ dataDir: dir, host: state.runtimeOverride, models: listModelRuntimeOverrides(dir) }, null, 2));
        return 0;
      }
      case "get": {
        let rec;
        if (model) {
          const map = listModelRuntimeOverrides(dir);
          rec = Object.hasOwn(map, model) ? map[model] : null;
        } else {
          rec = loadState(dir).runtimeOverride;
        }
        out(rec ? JSON.stringify(rec, null, 2) : "none");
        return 0;
      }
      case "set": {
        if (!values.bin) {
          err(`set needs --bin <absolute path>\n${USAGE}`);
          return 2;
        }
        const label = values.label ?? null;
        if (model) {
          const catalogIds = deps.catalogIds ?? defaultCatalogIds();
          if (!knownModelIds(dir, catalogIds).has(model)) {
            err(`warning: "${model}" matches no catalog id or registered model; it will only apply to a provider named "${model}" whose gpu_policy has no catalogId`);
          }
          const rec = writeVerified(
            dir,
            () => setModelRuntimeOverride(dir, model, values.bin, { ...overrideOpts, label }),
            (st, r) => Object.hasOwn(st.runtimeOverrides, model) && sameRecord(st.runtimeOverrides[model], r),
          );
          out(`per-model override set for ${model}: ${rec.bin} (${rec.version}) (data dir: ${dir})`);
        } else {
          const rec = writeVerified(
            dir,
            () => setRuntimeOverride(dir, { bin: values.bin, label }, overrideOpts),
            (st, r) => sameRecord(st.runtimeOverride, r),
          );
          out(`host override set: ${rec.bin} (${rec.version}) (data dir: ${dir})`);
        }
        return 0;
      }
      case "clear": {
        const what = model ? `per-model override for ${model}` : "host override";
        let had;
        if (model) {
          had = writeVerified(
            dir,
            () => clearModelRuntimeOverride(dir, model, overrideOpts),
            (st) => !Object.hasOwn(st.runtimeOverrides, model),
          );
        } else if (loadState(dir).runtimeOverride == null) {
          had = false; // nothing stored: never create or rewrite state.json
        } else {
          had = writeVerified(
            dir,
            () => clearRuntimeOverride(dir, overrideOpts),
            (st) => st.runtimeOverride == null,
          );
        }
        out(`${had ? `cleared ${what}` : `nothing to clear (${what})`} (data dir: ${dir})`);
        return 0;
      }
      default:
        err(`unknown command "${cmd}"\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof RuntimeOverrideError) {
      err(`refused (${e.code}): ${e.message}`);
      return 1;
    }
    if (e instanceof ConcurrentWriteError) {
      err(`error: ${e.message}`);
      return EXIT_CONCURRENT_WRITE;
    }
    throw e;
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test -- tests/models-runtime-override-cli.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow-wt-halo-profile
git add scripts/models-runtime-override.mjs tests/models-runtime-override-cli.test.js
git commit scripts/models-runtime-override.mjs tests/models-runtime-override-cli.test.js -m "feat(models): models-runtime-override CLI — list/get/set/clear host and per-model overrides"
git show --stat HEAD
```

---

### Task 5: `no_op_offload` launch key, gfx1151 host profile, and the orchestrator merge

**Files:**
- Modify: `servers/gateway/models/launch.js` (`TOP_LEVEL_KEYS` `:17`, `LAUNCH_OWNED_FLAGS` `:27-34`, `validateLaunch` `:48-57`, `renderLaunchArgs` `:117`, header)
- Create: `servers/gateway/models/host-profile.js`
- Modify: `servers/gateway/gpu-orchestrator.js` (imports; the `startNativeAndAwaitReady` opts destructure `:814-831`; the launch merge `:868-882`)
- Test: `tests/models-launch.test.js`, `tests/models-host-profile.test.js` (create), `tests/gpu-orchestrator-native.test.js`

**Interfaces:**
- Consumes: from Task 1, `probe.gpuArch` and `probe.accel`. The existing `mergeLaunch` and `renderLaunchArgs`. From Task 3, the warm probe cache that `resolveNativeBinPath` leaves behind; `startNativeAndAwaitReady` now reads the `getCachedProbeFn` seam (never `reprobeFn`).
- Produces:
  - `hostLaunchDefaults(probe) → { flash_attn: "on", no_mmap: true, no_op_offload: true } | null` (a fresh object each call)
  - `GFX1151_VULKAN_DEFAULTS` (frozen)
  - the launch key `no_op_offload: boolean`

- [ ] **Step 1: Write the failing tests**

In `tests/models-launch.test.js`, append:

```js
// --- no_op_offload (Strix Halo spec §2.4) ---------------------------------

test("validateLaunch: no_op_offload is a boolean knob", () => {
  assert.deepEqual(validateLaunch({ no_op_offload: true }), []);
  assert.deepEqual(validateLaunch({ no_op_offload: false }), []);
  assert.match(validateLaunch({ no_op_offload: "yes" })[0], /no_op_offload must be a boolean/);
  assert.match(validateLaunch({ no_op_offload: 1 })[0], /no_op_offload must be a boolean/);
});

test("validateLaunch: extra_args may not smuggle --op-offload or --no-op-offload", () => {
  assert.match(validateLaunch({ extra_args: ["--no-op-offload"] })[0], /extra_args may not contain "--no-op-offload"/);
  assert.match(validateLaunch({ extra_args: ["--op-offload"] })[0], /extra_args may not contain "--op-offload"/);
  assert.ok(LAUNCH_OWNED_FLAGS.has("--op-offload") && LAUNCH_OWNED_FLAGS.has("--no-op-offload"));
});

test("renderLaunchArgs: no_op_offload:true renders --no-op-offload right after --no-mmap; false/absent renders nothing", () => {
  assert.deepEqual(renderLaunchArgs({ no_mmap: true, no_op_offload: true, kv_type: "q8_0" }),
    ["--no-mmap", "--no-op-offload", "-ctk", "q8_0", "-ctv", "q8_0"]);
  assert.deepEqual(renderLaunchArgs({ no_op_offload: false }), []);
  assert.deepEqual(renderLaunchArgs({ flash_attn: "on" }), ["-fa", "on"]);
});

test("mergeLaunch: a later layer's no_op_offload:false beats an earlier true", () => {
  assert.deepEqual(mergeLaunch({ no_op_offload: true, no_mmap: true }, { no_op_offload: false }), { no_op_offload: false, no_mmap: true });
});
```

Create `tests/models-host-profile.test.js`:

```js
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
```

In `tests/gpu-orchestrator-native.test.js`, add `import { renderLaunchArgs } from "../servers/gateway/models/launch.js";` below the existing `state.js` import. Then append:

```js
// --- gfx1151 host launch profile (Strix Halo spec §2.4, D6/D7) -------------

const HALO_PROBE = { platform: "linux", accel: "vulkan", gpuArch: "gfx1151", unified: true };
const haloCatalog = (launch) => () => ({ runtime: { release: "b1", assets: {} }, models: [{ id: "native-target", task: "chat", context_len: 8192, ...(launch ? { launch } : {}) }] });

test("host profile: on gfx1151 vulkan the profile fills launch keys nobody set", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18130, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getCachedProbeFn = () => HALO_PROBE;
  opts.loadCatalogFn = haloCatalog({ ctx: 8192, ngl: 999 });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.deepEqual(startCalls[0].launch, { flash_attn: "on", no_mmap: true, no_op_offload: true, ctx: 8192, ngl: 999 });
  const argv = renderLaunchArgs(startCalls[0].launch);
  for (const f of ["--no-mmap", "--no-op-offload"]) assert.ok(argv.includes(f), `${f} in ${argv.join(" ")}`);
  assert.deepEqual(argv.slice(argv.indexOf("-fa"), argv.indexOf("-fa") + 2), ["-fa", "on"]);
});

test("host profile: a curated catalog value wins over the profile", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18131, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getCachedProbeFn = () => HALO_PROBE;
  opts.loadCatalogFn = haloCatalog({ flash_attn: "off" });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.deepEqual(startCalls[0].launch, { flash_attn: "off", no_mmap: true, no_op_offload: true });
});

test("host profile: gpu_policy.launch opts out (no_op_offload:false, no_mmap:false) — neither flag renders", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18132, "native-target", { gpuPolicy: { launch: { no_op_offload: false, no_mmap: false } } }) } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getCachedProbeFn = () => HALO_PROBE;
  opts.loadCatalogFn = haloCatalog(null);
  assert.equal(await acquireProvider("native-target", opts), true);
  const argv = renderLaunchArgs(startCalls[0].launch);
  assert.ok(!argv.includes("--no-op-offload"), argv.join(" "));
  assert.ok(!argv.includes("--no-mmap"), argv.join(" "));
  assert.equal(startCalls[0].launch.flash_attn, "on", "keys the provider did not touch still come from the profile");
});

test("host profile: jinja still layers on top of the profile", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18133, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getCachedProbeFn = () => HALO_PROBE;
  opts.loadCatalogFn = () => ({ runtime: { release: "b1", assets: {} }, models: [{ id: "native-target", task: "chat", context_len: 8192, chat_template_kwargs: { enable_thinking: false } }] });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.deepEqual(startCalls[0].launch, { flash_attn: "on", no_mmap: true, no_op_offload: true, jinja: true });
});

test("host profile: another arch on vulkan gets no profile (launch stays empty)", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18134, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getCachedProbeFn = () => ({ platform: "linux", accel: "vulkan", gpuArch: "gfx1100", unified: false });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.deepEqual(startCalls[0].launch, {});
});

test("host profile: an override-only start (cold probe cache) still warms the probe and applies the profile", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18135, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  let cached = null;
  let reprobeCalls = 0;
  opts.getCachedProbeFn = () => cached;
  opts.reprobeFn = async () => { reprobeCalls++; cached = HALO_PROBE; return HALO_PROBE; };
  opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/halo/llama-server" });
  assert.equal(await acquireProvider("native-target", opts), true);
  assert.equal(startCalls[0].binPath, "/opt/halo/llama-server");
  assert.equal(reprobeCalls, 1);
  assert.equal(startCalls[0].launch.no_op_offload, true);
});

test("host profile: a probe that throws means no profile, never a failed start", async () => {
  const startCalls = [];
  const cfg = { providers: { "native-target": nativeProv(18136, "native-target") } };
  const opts = startCapableOpts({ cfg, identityProbeFn: probeSequence(["down", "resident"]), startCalls });
  opts.getCachedProbeFn = () => null;
  opts.reprobeFn = async () => { throw new Error("vulkaninfo exploded"); };
  opts.getModelRuntimeOverrideFn = () => ({ bin: "/opt/halo2/llama-server" }); // override path: the probe failure is survivable
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await acquireProvider("native-target", opts), true);
  } finally { console.warn = origWarn; }
  assert.deepEqual(startCalls[0].launch, {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile
npm test -- tests/models-launch.test.js ; npm test -- tests/models-host-profile.test.js ; npm test -- tests/gpu-orchestrator-native.test.js
```
Expected: FAIL.
- `models-launch` fails with `unknown key "no_op_offload"` and a missing owned flag.
- `models-host-profile` fails with `Cannot find module .../host-profile.js`.
- The orchestrator's host-profile tests get `launch` without the profile keys.

- [ ] **Step 3: Implement**

**(a)** In `servers/gateway/models/launch.js`:

Add to the header comment, before its closing ` */`:

```js
 *
 * Precedence at a native start (Strix Halo runtime profile spec §2.4, D7):
 * host profile (`host-profile.js`) < catalog `launch` < provider
 * `gpu_policy.launch` < the jinja layer — each layer via `mergeLaunch`.
```

Replace `TOP_LEVEL_KEYS`:

```js
const TOP_LEVEL_KEYS = new Set(["ctx", "ngl", "flash_attn", "parallel", "no_mmap", "no_op_offload", "kv_type", "spec", "sampling", "jinja", "extra_args"]);
```

Replace `LAUNCH_OWNED_FLAGS`:

```js
export const LAUNCH_OWNED_FLAGS = new Set([
  "-m", "--model", "--alias", "--port", "--host",
  "-c", "--ctx-size", "--mmproj", "--embedding", "--embeddings", "--reranking", "--jinja",
  "-ngl", "--n-gpu-layers", "-fa", "--flash-attn", "-np", "--parallel", "--no-mmap",
  "--op-offload", "--no-op-offload",
  "-ctk", "-ctv", "--cache-type-k", "--cache-type-v",
  "--spec-type", "--spec-draft-n-max",
  "--temp", "--top-p", "--top-k", "--min-p", "--presence-penalty",
]);
```

In `validateLaunch`, replace the destructure line and add the check after the `no_mmap` check:

```js
  const { ctx, ngl, flash_attn, parallel, no_mmap, no_op_offload, kv_type, spec, sampling, jinja, extra_args } = launch;
```

```js
  if (no_op_offload !== undefined && typeof no_op_offload !== "boolean") errors.push(`${label}: no_op_offload must be a boolean`);
```

In `renderLaunchArgs`, directly after `if (launch.no_mmap === true) args.push("--no-mmap");`, add:

```js
  if (launch.no_op_offload === true) args.push("--no-op-offload");
```

**(b)** Create `servers/gateway/models/host-profile.js`:

```js
/**
 * Host launch profile (Strix Halo runtime profile spec §2.4, D6/D7).
 *
 * `hostLaunchDefaults(probe)` returns launch knobs for the host itself, or
 * null. It is the LOWEST launch layer at a native start:
 *
 *   host profile < catalog `launch` < provider `gpu_policy.launch` < jinja
 *
 * so it only ever fills keys nobody else set. A provider opts out per key
 * through its own `gpu_policy.launch` (`{ no_op_offload: false }`,
 * `{ no_mmap: false }`, `{ flash_attn: "off" }`). It applies to native
 * llama-server starts only; Docker bundles build their own command lines.
 *
 * gfx1151 (Strix Halo) on Vulkan gets kyuz0's / pi-lab's flags:
 * `-fa on` (llama.cpp renders `-fa 1` as `on`), `--no-mmap`, and
 * `--no-op-offload`. Flash attention stays on for every task: production
 * containers already run `-fa on` for chat AND embedding models on this
 * hardware, and FA on an unsupported head size falls back silently.
 * `--no-op-offload` stays regardless of `ngl` (pi-lab approved it as a
 * default). pi-lab's caveats, kept here on purpose:
 *   - `--no-op-offload` changes nothing unless weights are host-resident;
 *   - its measured +18% alone did NOT include the fork-only
 *     `GGML_MOE_PREFETCH`, so do not expect that number from stock builds;
 *   - outputs match on argmax, not bit for bit.
 *
 * Pure: reads only the probe object it is handed (probe.js supplies
 * `gpuArch` and `accel`); never probes on its own.
 */

export const GFX1151_VULKAN_DEFAULTS = Object.freeze({ flash_attn: "on", no_mmap: true, no_op_offload: true });

/**
 * @param {{gpuArch?: string|null, accel?: string}|null|undefined} probe
 * @returns {{flash_attn: "on", no_mmap: true, no_op_offload: true}|null}
 */
export function hostLaunchDefaults(probe) {
  if (!probe || probe.gpuArch !== "gfx1151" || probe.accel !== "vulkan") return null;
  return { ...GFX1151_VULKAN_DEFAULTS };
}
```

**(c)** In `servers/gateway/gpu-orchestrator.js`:

Add below the `mergeLaunch` import (`:89`):

```js
import { hostLaunchDefaults } from "./models/host-profile.js";
```

In `startNativeAndAwaitReady`'s opts destructure, add one entry after `existsSyncFn = existsSync,`:

```js
    getCachedProbeFn = getCachedProbe,
```

It deliberately does NOT take `reprobeFn`: Task 3 made `resolveNativeBinPath` warm the probe before any override early-return, so this function, which runs inside the single-flight, only reads the cache and never probes.

Replace the launch-profile comment and the `const launch = mergeLaunch(...)` line. That runs from `// Launch profile (spec §3.1/§4, Task 10)` through `const launch = mergeLaunch(mergeLaunch(catalogEntry?.launch, p.gpuPolicy?.launch), jinja ? { jinja: true } : null);`. Keep the `catalogId`/`catalogEntry`/`jinja` lines between them exactly as they are. The block becomes:

```js
  // Launch profile (spec §3.1/§4, Task 10; Strix Halo spec §2.4, D7):
  //   host profile < catalog `launch` < provider `gpuPolicy.launch` < jinja,
  // each layer via `mergeLaunch`, then rendered by `runtime.js`'s
  // `startModel` into llama-server flags. The host profile only fills keys
  // nobody set. Scoped --jinja (C1 Task 1, folded into `launch.jinja`):
  // chat_template_kwargs in request bodies is only honored under
  // llama-server's jinja engine; scoped per-model — the other catalog
  // models are not template-verified under --jinja.
  const catalogId = p.gpuPolicy?.catalogId || providerName;
  let catalogEntry = null;
  try {
    catalogEntry = (loadCatalogFn()?.models || []).find((m) => m.id === catalogId) || null;
  } catch { /* catalog unreadable → no catalog-driven args, model starts as before */ }

  // resolveNativeBinPath already warmed the probe cache (before any
  // override early-return), so this only READS it — no probing inside the
  // single-flight critical section. A null cache (the probe failed on an
  // override path) means "no host profile", never a failed start.
  const hostProbe = getCachedProbeFn();

  const jinja = !!(catalogEntry && catalogEntry.chat_template_kwargs && typeof catalogEntry.chat_template_kwargs === "object");
  const launch = mergeLaunch(
    mergeLaunch(mergeLaunch(hostLaunchDefaults(hostProbe), catalogEntry?.launch), p.gpuPolicy?.launch),
    jinja ? { jinja: true } : null,
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile
npm test -- tests/models-launch.test.js
npm test -- tests/models-host-profile.test.js
npm test -- tests/gpu-orchestrator-native.test.js
npm test -- tests/chat-template-kwargs.test.js
npm test -- tests/gpu-orchestrator-serving-class.test.js
node scripts/validate-model-catalog.js
```
Expected: all PASS. Pre-existing launch assertions are unchanged, because every existing harness probe is `{ accel: "cpu" }`, so the profile is `null`. `validate-model-catalog.js` exits 0; the catalog content is unchanged.

- [ ] **Step 5: Commit**

```bash
cd /home/kh0pp/crow-wt-halo-profile
git add servers/gateway/models/host-profile.js tests/models-host-profile.test.js
git commit servers/gateway/models/launch.js servers/gateway/models/host-profile.js servers/gateway/gpu-orchestrator.js tests/models-launch.test.js tests/models-host-profile.test.js tests/gpu-orchestrator-native.test.js -m "feat(models): gfx1151 host launch profile + no_op_offload key, lowest launch layer"
git show --stat HEAD
```

---

### Task 6: Architecture docs and full-suite verification

**Files:**
- Modify: `docs/architecture/models.md` (the "Runtime override" section `:59-61`, plus a new section before "What later plans add" `:63`)

**Interfaces:**
- Consumes: the names every earlier task shipped (`gpuArch`, `unified`, `gttTotalMb`, `gttUsedMb`, `ramTotalMb`, `runtimeOverrides`, `scripts/models-runtime-override.mjs`, `hostLaunchDefaults`, `no_op_offload`).
- Produces: documentation only.

- [ ] **Step 1: Replace the "Runtime override" section**

In `docs/architecture/models.md`, replace the paragraph under `## Runtime override` (`:61`) with:

```markdown
`state.json.runtimeOverride` (`{ bin, label, version, setAt }`) is host-local. It lives in the state file, never in the `providers` DB row, so it never replicates to another instance. It bootstraps once from the `CROW_LLAMA_SERVER_BIN` environment variable when no record exists yet.

`state.json.runtimeOverrides[<id>]` is a **per-model** override with the same record shape and the same validation. `<id>` is the provider row's `gpu_policy.catalogId`, or the provider name for a row without one.

A native start resolves its binary in this order:

1. the per-model override;
2. the host override;
3. the pinned catalog release through `ensureRuntime`.

Either override skips `ensureRuntime`, and with it any `min_runtime_version` check. An override binary that goes missing logs one warning per binary and falls through to the next layer rather than failing the start.

The operator surface is a CLI that resolves the data dir the way the gateway does (`CROW_DATA_DIR`, else `~/.crow/data`):

    node scripts/models-runtime-override.mjs list
    node scripts/models-runtime-override.mjs get   [--model <id>]
    node scripts/models-runtime-override.mjs set   --bin /abs/llama-server [--model <id>] [--label <text>]
    node scripts/models-runtime-override.mjs clear [--model <id>]

For r4, point it at r4's data dir:

    CROW_DATA_DIR=/home/kh0pp/.crow-r4/data node scripts/models-runtime-override.mjs …

- Without `--model`, a command acts on the host override.
- A per-model override keyed by a `catalogId` applies to every quant/variant row of that model. That is intended: pi-lab builds are per model.
- `list` and `get` only read. They never trigger the env bootstrap. `clear` without `--model` writes nothing when no host override is stored.
- `set` and `clear` print the data dir they wrote to.
- The CLI is a second writer of `state.json`, next to the gateway. After every write it re-reads the file and checks the change landed. On a mismatch it retries once, then exits 3 saying a concurrent gateway write overwrote it.
- The read-back narrows the race but does not close it. A gateway that loaded `state.json` before the write and saves after the read-back still wins, silently. Verify with `get` after the next gateway restart.
- When `CROW_LLAMA_SERVER_BIN` is set, host `get`/`clear` warn that the gateway will re-bootstrap the host override from that variable.
- `set --model` warns when the id matches no catalog id and no registered model, because such an override only applies to a provider with that exact name.
- A running model keeps its binary until it is next started.

**Deploy note:** restart the crow and r4 gateways once after deploying this, before the first `set`. An older gateway drops unknown state keys, so it would rewrite `state.json` without `runtimeOverrides`.

This CLI is how a pi-lab pre-merge llama.cpp build reaches a single model. The dashboard card for both overrides is plan 3.
```

- [ ] **Step 2: Add the unified-memory and host-profile section**

Insert directly before `## What later plans add`:

```markdown
## Unified memory and the gfx1151 host profile

This section covers the Strix Halo runtime profile, spec `docs/superpowers/specs/2026-09-23-strix-halo-runtime-profile-design.md`.

**Probe.** `probeHardware()` adds five fields. Every earlier field keeps its meaning.

| field | what it holds |
|---|---|
| `gpuArch` | e.g. `gfx1151`, from the Vulkan device name, else from rocminfo |
| `unified` | `true` when Vulkan reports `INTEGRATED_GPU`, or when amdgpu sysfs shows a VRAM carve-out of 2 GiB or less alongside a GTT total. `false` for a discrete GPU. `null` when no GPU is detected. |
| `gttTotalMb`, `gttUsedMb` | from the first `/sys/class/drm/card<N>/device/mem_info_gtt_*` |
| `ramTotalMb` | `/proc/meminfo` `MemTotal` |

On an APU, `vramMb` (RADV's `DEVICE_LOCAL` heap, 83 GiB on crow) is a slice of RAM. It is not separate memory.

`unified` comes from Vulkan's `deviceType` whenever vulkaninfo answers: `INTEGRATED_GPU` is `true` and `DISCRETE_GPU` is `false`. The sysfs small-carve-out heuristic is only a fallback, for other Vulkan types and for the rocminfo path. GTT fields are reported only when `unified` is `true`, taken from the amdgpu card with the smallest VRAM (the iGPU).

**Fit badge.** On a unified host `fitBadge` never adds VRAM to RAM. The GTT ceiling applies only to a **GTT-expanded** APU, where GTT total is at least 75% of `MemTotal`, as on crow with `amdgpu.gttsize`:

| condition (GTT-expanded, checked in this order) | badge |
|---|---|
| `min_ram_mb` above GTT total | `wont_fit`, even when an idle box has more MemAvailable than GTT |
| `min_ram_mb` within MemAvailable | `fits` |
| anything in between | `tight`: it fits the box, but only after other resident models are stopped |

Every other unified host (default GTT, or GTT/MemTotal unknown) uses the discrete formula minus the VRAM credit: `fits` within MemAvailable, `tight` within 110% of it, else `wont_fit`. So a laptop APU with default GTT never has a `fits` turned into `wont_fit`. Only GTT-expanded hosts get the wider `tight` band. There is no fourth badge value. The tight hint says both "close to your limits" and "may need other models stopped first". The discrete path is unchanged. The live GTT start gate is a separate change (two-host spec §6).

**Host launch profile.** `servers/gateway/models/host-profile.js` returns `{ flash_attn: "on", no_mmap: true, no_op_offload: true }` for `gpuArch: "gfx1151"` on `accel: "vulkan"`, and nothing otherwise. It is the **lowest** launch layer:

    host profile < catalog launch < provider gpu_policy.launch < jinja

So a curated catalog value or an operator's per-provider value always wins. Flash attention stays on for every task, because production containers already run `-fa on` for chat and embedding models on this hardware, and FA on an unsupported head size falls back silently. `--no-op-offload` stays in the profile regardless of `ngl`. A provider opts out per key with `gpu_policy.launch: { no_op_offload: false }`, `{ no_mmap: false }` or `{ flash_attn: "off" }`.

`no_op_offload` is a typed launch key. It renders `--no-op-offload` only when `true`, and `--op-offload`/`--no-op-offload` can never ride in `extra_args`.

pi-lab's caveats, also recorded in the module:

- `--no-op-offload` changes nothing unless weights are host-resident;
- pi-lab's measured +18% did not include the fork-only `GGML_MOE_PREFETCH`;
- results match on argmax, not bit for bit.

The profile applies to native starts only. Docker bundles build their own command lines.
```

- [ ] **Step 3: Run the full suite**

Run:
```bash
export PATH=/home/kh0pp/.nvm/versions/node/v24.21.0/bin:$PATH
cd /home/kh0pp/crow-wt-halo-profile && npm test 2>&1 | tail -15
```
Expected: `# fail 0`. The pass count is the pre-branch baseline plus the tests added in Tasks 1–5.

Also run the static checks CI runs:
```bash
cd /home/kh0pp/crow-wt-halo-profile && node scripts/check-port-allocation.js && node scripts/build-registry.mjs --check
```
Expected: both exit 0. No ports or registry entries changed.

- [ ] **Step 4: Commit**

```bash
cd /home/kh0pp/crow-wt-halo-profile
git commit docs/architecture/models.md -m "docs(models): unified-memory probe/fit, per-model runtime override + CLI, gfx1151 host profile"
git show --stat HEAD
```

---

## Self-Review

**1. Spec coverage**

| spec section | task |
|---|---|
| §2.1 probe fields (`gpuArch`, `unified`, `gttTotalMb`/`gttUsedMb`, `ramTotalMb`); `parseVulkaninfo` returns `deviceType` + arch; pure exported parsers; sysfs through the injected `fs`; no `gpu-arch.js` import | Task 1 |
| §2.2 unified `fitBadge` (ceiling, fits/tight/wont_fit, no VRAM credit, fail-closed); hint copy in en + es; no new badge (D3) | Task 2 |
| §2.3 `runtimeOverrides` in `state.json`; the four functions; same `validateBinary` | Task 3 |
| §2.3 resolve order with a warn-once fall-through; `opts.providerName` from both callers | Task 3 |
| §2.3 CLI (D5) | Task 4 |
| §2.4 `host-profile.js`, precedence (D7), `no_op_offload` key, owned flags, opt-outs, caveats comment, native-only | Task 5 |
| §3 out of scope | Global Constraints (nothing built) |
| §4 testing | every bullet has a test in Tasks 1–5 |
| Docs | Task 6 |

**2. Placeholder scan.** No TBD or "similar to" references. Every code step carries its full code. The one discovery command, Task 2 Step 4's `ls tests | grep`, is a verification lookup, not a code gap.

**3. Type consistency.**
- `getModelRuntimeOverrideFn(dir, id)` has the same signature in Task 3's implementation, the harness default, and Tasks 3 and 5's tests.
- `hostLaunchDefaults(probe)` and `GFX1151_VULKAN_DEFAULTS` match across Task 5 and the docs.
- `main(argv, deps)` matches between the CLI and its test.
- `readAmdgpuMem` returns `{ gttTotalMb, gttUsedMb, vramTotalMb }` in both the probe code and its test.

**4. Review Focus.** Each of the five items has a pinned test: Task 5 Step 1 (two tests), Task 4 Step 1 (two tests), Task 3 Step 1 (the state test), and Task 1 Step 1 (the `readAmdgpuMem` tests).

## Review

Adversarial review round 1. Every ruling below was binding and has been applied to this plan and to the spec.

| # | finding | resolution |
|---|---|---|
| C1 | `unified` misfired on discrete AMD: the sysfs carve-out heuristic could mark a host unified even though Vulkan reported a discrete GPU, and the first card's GTT was reported for a dGPU. | Vulkan's `deviceType` decides whenever vulkaninfo answered (`INTEGRATED_GPU` → true, `DISCRETE_GPU` → false). Other types and the no-Vulkan (rocminfo) path use the heuristic. GTT fields are populated only when `unified === true`, from the amdgpu card with the smallest `mem_info_vram_total` that has GTT (the iGPU). New Task 1 tests: a two-card iGPU+dGPU fixture (Vulkan DISCRETE) gives unified false, no GTT and an unchanged discrete `fitBadge`; a ≤2 GiB discrete card reported DISCRETE gives unified false; `readAmdgpuMem` picks the smallest-VRAM card, with ties going to the lower card number. |
| C2 | The unified `fitBadge` could flip `fits` to `wont_fit` on default-GTT laptop APUs, where GTT is ~50% of RAM. | The GTT ceiling applies only to a GTT-expanded APU (`gttTotalMb >= 0.75 × ramTotalMb`, both known), in the order fits → wont_fit (> GTT) → tight. Every other unified host uses today's formula minus the VRAM credit. Discrete and unknown hosts are byte-identical. The "GTT smaller than MemAvailable is still the ceiling" test is dropped. Added: a default-GTT laptop quant within MemAvailable but above GTT gives `fits`, crow's Flash-Next 115,068 gives `tight`, GLM 157,911 gives `wont_fit`, an integer-exact 0.75 boundary test, and GTT/MemTotal unknown uses the 10% band without VRAM. The spec's §2.2 records that the tight widening applies only to GTT-expanded hosts. |
| C3 | The CLI is a second `state.json` writer and can silently lose a race with the gateway. | Every write is re-read and verified, retried once, then the CLI exits 3 with "a concurrent gateway write overwrote it" (tests inject a clobbering `saveStateFn`). `set`/`clear` print the resolved data dir. Task 6 docs gain the deploy note (restart the crow and r4 gateways once before the first `set`, since an older gateway drops unknown state keys) and the r4 invocation `CROW_DATA_DIR=/home/kh0pp/.crow-r4/data node scripts/models-runtime-override.mjs …`. |
| S1 | `clear` with no `--model` wrote or created `state.json` even when nothing was stored. | It now checks first and writes nothing. Pinned by an in-process test and by the child-process no-write loop. |
| S2 | A host `get`/`clear` is misleading when `CROW_LLAMA_SERVER_BIN` is set. | Both print a warning that the gateway re-bootstraps the host override from that variable. Tested. |
| S3 | The probe warm-up sat inside `startNativeAndAwaitReady`'s single-flight critical section. | Moved into `resolveNativeBinPath`, before any override early-return, so override and stock paths both leave a warm cache. `startNativeAndAwaitReady` only reads `getCachedProbeFn()` (null means no profile). A probe failure is survivable on an override path and still surfaces on the stock path, as before. Tests are in Tasks 3 and 5. |
| S4 | Should flash attention stay on in the profile? | It is kept `"on"`, since production containers run `-fa on` for chat and embedding models on this hardware. The host-profile module comment and the docs note that FA on an unsupported head size falls back silently. |
| S5 | Task 3(b)'s import edit was vague. | It now names the exact lines 6 and 7 of `tests/models-runtime-override.test.js`, with their replacements. |

**Questions answered:**

- **A per-model override keyed by `catalogId` applies to every quant/variant row of that model.** That is intended, because pi-lab builds are per model. Recorded in the spec, the CLI header and the docs.
- **`--no-op-offload` stays in the profile regardless of `ngl`.** pi-lab approved it as a default. The opt-out is `gpu_policy.launch: { no_op_offload: false }`.
- **darwin keeps `unified: null`.** Pinned by the Task 1 WSL2/darwin test.

### Round 2

| # | finding | resolution |
|---|---|---|
| R2-1 | The C1 tests would pass a naive "first numeric card with GTT" `readAmdgpuMem`: every fixture put the iGPU first. | Added a dGPU-at-card0 (16 GiB) + iGPU-at-card1 (512 MiB) fixture. It is tested directly through `readAmdgpuMem` (card1's GTT wins) and through `probeHardware` with crow's INTEGRATED vulkaninfo (GTT fields from card1). A third test lists a card with no `mem_info_vram_total` before one that has it, and the card with vram_total wins. Task 1 Step 2 states that all three fail against a first-card implementation. |
| R2-2 | GTT-expanded `fitBadge` checked `fits` before the ceiling, so an idle box whose MemAvailable exceeds GTT said `fits` for a quant above GTT. | The ceiling is checked first: `> gttTotalMb` → `wont_fit`, then `<= ramAvailableMb` → `fits`, else `tight`. Added the idle-box test (GTT 80% of MemTotal, MemAvailable > GTT, quant between them → `wont_fit`). Spec §2.2's numbered order is updated. |
| R2-3 | A probe that throws was re-run on every override-path acquire. | A module-level failure timestamp is added, with a `nowFn` seam and `PROBE_RETRY_MS` of 5 min. Inside the window the warm-up does not re-probe, and it warns once per window. The stock path still probes itself when it has no probe, so its behaviour is unchanged. A test checks that two acquires inside the window reprobe once and warn once, and that a third acquire after the window probes again. The harness `beforeEach` resets the window. |
| R2-4 | The CLI docs overstated the read-back verification. | The CLI header and the Task 6 docs now say the read-back narrows but does not close the race: a gateway that loaded state before the write and saves after the read-back still wins. They advise "verify with `get` after the next gateway restart". |

