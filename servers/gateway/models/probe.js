/**
 * Hardware probe for the model catalog (Item G).
 *
 * Detects what a host can actually run a model on — accelerator kind, GPU
 * name/VRAM, available RAM, and free disk — for the catalog's panel fit
 * badges and runtime asset selection (later tasks). Genuinely new detection
 * code: it does NOT extend or import `gpu-arch.js` or `hardware-gate.js`.
 * Their behaviors were CONSULTED for parsing patterns (rocminfo agent/pool
 * state machine, nvidia-smi CSV, /proc/meminfo `Key:  N kB` lines,
 * `fs.statfsSync` disk math) but are explicitly wrong to reuse here:
 *
 *   - gpu-arch.js's `detectGpuVramGb` FAILS OPEN (null VRAM => install not
 *     blocked). A fit badge must fail CLOSED: unknown data never renders as
 *     "fits".
 *   - hardware-gate.js's `computeEffectiveRam` counts SwapFree (half-weight,
 *     SSD/zram only) toward available RAM. Fit badges must NEVER count swap
 *     — a model that only "fits" by swapping is a bad user experience, not
 *     a fit.
 *   - Neither file covers Vulkan (the actual acceleration path for AMD
 *     consumer GPUs without ROCm installed) or WSL2 (which needs a hard
 *     override, not a probe result).
 *
 * Detection order (linux): WSLInterop file / kernel string -> wsl2 flag
 * (forces accel "cpu", v1 rule: no CUDA asset exists for linux under WSL2,
 * and we don't attempt GPU passthrough detection there). Otherwise:
 * vulkaninfo (deviceName + VRAM from the DEVICE_LOCAL memory heap) -> accel
 * "vulkan"; else nvidia-smi -> accel "cuda"; else rocminfo (AMD family,
 * still reported as "vulkan" since the Probe.accel enum has no separate
 * "rocm" value — v1 always ships the Vulkan/Mesa asset for AMD). darwin ->
 * accel "metal" always (deterministic), RAM from `sysctl -n hw.memsize`
 * (this is total physical memory, not "available" — macOS has no direct
 * MemAvailable equivalent exposed via a single documented command; treating
 * total-as-available is a deliberate v1 simplification, not a detection
 * bug — see task-3-report.md).
 *
 * Anything genuinely undetectable leaves its Probe field(s) null AND pushes
 * a short name ("gpu" | "ram" | "disk") into `unknown`. A deliberate,
 * confident non-detection (WSL2's forced cpu, darwin's forced metal) is NOT
 * "unknown" and does not get pushed.
 */

import { execFile as execFileCb } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";

const WSL_INTEROP_PATH = "/proc/sys/fs/binfmt_misc/WSLInterop";
const MEMINFO_PATH = "/proc/meminfo";

// ---------------------------------------------------------------------------
// execFile helper — always resolves (never throws/rejects); a command that
// errors or is missing resolves to null so callers can treat every
// detection path uniformly as "did this signal come back or not".
// ---------------------------------------------------------------------------

function run(execFile, cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { encoding: "utf8", timeout: 5000 }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
      });
    } catch {
      resolve(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Pure parsers — exported for direct unit testing / reuse.
// ---------------------------------------------------------------------------

/**
 * Parse `vulkaninfo` (plain, no args — the default --text mode) output.
 * `--summary` mode does NOT include memory heap data on any vulkan-tools
 * build checked for this task, so the probe must invoke plain `vulkaninfo`
 * to get the DEVICE_LOCAL heap size the spec asks for (see task-3-report.md
 * for the verification). Skips PHYSICAL_DEVICE_TYPE_CPU devices (software
 * rasterizers like llvmpipe) and picks the device with the largest
 * DEVICE_LOCAL heap when more than one real GPU is present.
 * Returns { name, vramMb } or null if no GPU with a DEVICE_LOCAL heap found.
 */
export function parseVulkaninfo(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const candidates = [];

  let currentType = null;
  let currentName = null;
  let inMemProps = false;
  let heapSize = 0;
  let maxHeapBytes = 0;

  const flushDevice = () => {
    if (currentName && currentType !== "PHYSICAL_DEVICE_TYPE_CPU" && maxHeapBytes > 0) {
      candidates.push({ name: currentName, vramMb: Math.round(maxHeapBytes / 1024 / 1024) });
    }
    currentType = null;
    currentName = null;
    inMemProps = false;
    heapSize = 0;
    maxHeapBytes = 0;
  };

  for (const line of lines) {
    if (/^GPU\d+:/.test(line)) {
      flushDevice();
      continue;
    }
    const typeM = line.match(/deviceType\s*=\s*(\S+)/);
    if (typeM) {
      currentType = typeM[1];
      continue;
    }
    const nameM = line.match(/deviceName\s*=\s*(.+)/);
    if (nameM) {
      currentName = nameM[1].trim();
      continue;
    }
    if (/VkPhysicalDeviceMemoryProperties:/.test(line)) {
      inMemProps = true;
      continue;
    }
    if (!inMemProps) continue;
    if (/memoryTypes:/.test(line)) {
      inMemProps = false;
      continue;
    }
    const sizeM = line.match(/^\s*size\s*=\s*(\d+)/);
    if (sizeM) {
      heapSize = parseInt(sizeM[1], 10);
      continue;
    }
    if (/MEMORY_HEAP_DEVICE_LOCAL_BIT/.test(line)) {
      if (heapSize > maxHeapBytes) maxHeapBytes = heapSize;
      continue;
    }
  }
  flushDevice(); // last device in the file never hits a following "GPUn:" line

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.vramMb - a.vramMb);
  return candidates[0];
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
 * output (one "name, memMiB" line per GPU). Returns the first valid GPU
 * line as { name, vramMb } (memory.total in MiB, treated as MB), or null.
 */
export function parseNvidiaSmi(text) {
  if (!text) return null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) continue;
    const name = parts[0];
    const mem = parseInt(parts[1], 10);
    if (name && Number.isFinite(mem) && mem > 0) {
      return { name, vramMb: mem };
    }
  }
  return null;
}

/**
 * Parse `rocminfo` output. Consulted (per the task brief) as the AMD
 * fallback when vulkaninfo itself is missing but ROCm is installed. Mirrors
 * gpu-arch.js's Agent/Pool state-machine parsing pattern (Name: gfxNNNN
 * marks a GPU agent unambiguously; CPU agents never carry a gfx token) but
 * is a fresh, standalone implementation that additionally captures
 * "Marketing Name:" for a human-readable GPU name and reports VRAM in MB
 * (not GB — fit-badge math needs MB precision).
 * Returns { name, vramMb } for the largest GPU agent's GLOBAL pool, or null.
 */
export function parseRocminfo(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const candidates = [];

  let inAgent = false;
  let isGpu = false;
  let marketingName = null;
  let inGlobalSegment = false;
  let maxKb = 0;

  const flushAgent = () => {
    if (isGpu && maxKb > 0) {
      candidates.push({ name: marketingName || "AMD GPU", vramMb: Math.round(maxKb / 1024) });
    }
    isGpu = false;
    marketingName = null;
    inGlobalSegment = false;
    maxKb = 0;
  };

  for (const line of lines) {
    if (/^\s*Agent\s+\d+/.test(line)) {
      flushAgent();
      inAgent = true;
      continue;
    }
    if (!inAgent) continue;
    if (/^\s*Name:\s*gfx[0-9a-f]+\s*$/.test(line)) {
      isGpu = true;
      continue;
    }
    const mn = line.match(/^\s*Marketing Name:\s*(.+?)\s*$/);
    if (mn) {
      marketingName = mn[1];
      continue;
    }
    if (!isGpu) continue;
    if (/^\s*Segment:\s*GLOBAL/.test(line)) {
      inGlobalSegment = true;
      continue;
    }
    if (/^\s*Segment:/.test(line)) {
      inGlobalSegment = false;
      continue;
    }
    if (inGlobalSegment) {
      const m = line.match(/^\s*Size:\s*(\d+)\b.*KB/);
      if (m) maxKb = Math.max(maxKb, parseInt(m[1], 10));
    }
  }
  flushAgent(); // last agent in the file never hits a following "Agent N" line

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.vramMb - a.vramMb);
  return candidates[0];
}

/** Parse the `MemAvailable:  N kB` line from /proc/meminfo text. MB, rounded. */
export function parseMemAvailableMb(text) {
  if (!text) return null;
  for (const line of text.split("\n")) {
    const m = line.match(/^MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Math.round(Number(m[1]) / 1024);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection helpers (impure — call out to execFile/fs)
// ---------------------------------------------------------------------------

function detectWsl2(fs, release) {
  if (fs.existsSync(WSL_INTEROP_PATH)) return true;
  if (typeof release === "string" && /microsoft/i.test(release)) return true;
  return false;
}

async function readMemAvailable(fs) {
  try {
    const raw = fs.readFileSync(MEMINFO_PATH, "utf8");
    return parseMemAvailableMb(raw);
  } catch {
    return null;
  }
}

function readDiskFreeMb(fs, dir) {
  if (!dir) return null;
  try {
    const s = fs.statfsSync(dir);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// probeHardware
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Probe
 * @property {"linux"|"darwin"} platform
 * @property {boolean} wsl2
 * @property {"vulkan"|"cuda"|"metal"|"cpu"} accel
 * @property {string|null} gpuName
 * @property {number|null} vramMb
 * @property {number|null} ramAvailableMb
 * @property {number|null} diskFreeMb
 * @property {string[]} unknown
 */

/**
 * Probe this host's hardware. Every external call is injected (execFile,
 * fs) so every path is fixture-testable without the real binaries/files.
 * `platform`/`release` are also injectable (defaulting to process.platform
 * / os.release()) — needed to exercise the darwin and WSL2 branches from
 * fixtures without a real machine of that kind. `modelsDir`, if given, is
 * the directory `fs.statfsSync` is called against for `diskFreeMb`; if
 * omitted, diskFreeMb stays null and "disk" is pushed to `unknown`.
 *
 * @param {{execFile?: Function, fs?: Object, platform?: string, release?: string, modelsDir?: string|null}} [opts]
 * @returns {Promise<Probe>}
 */
export async function probeHardware(opts = {}) {
  const {
    execFile = execFileCb,
    fs = nodeFs,
    platform = process.platform,
    release = nodeOs.release(),
    modelsDir = null,
  } = opts;

  const unknown = [];
  const probe = {
    platform: platform === "darwin" ? "darwin" : "linux",
    wsl2: false,
    accel: "cpu",
    gpuName: null,
    vramMb: null,
    ramAvailableMb: null,
    diskFreeMb: null,
    unknown,
  };

  if (probe.platform === "darwin") {
    probe.accel = "metal";
    const out = await run(execFile, "sysctl", ["-n", "hw.memsize"]);
    const bytes = out ? parseInt(out.trim(), 10) : NaN;
    if (Number.isFinite(bytes) && bytes > 0) {
      probe.ramAvailableMb = Math.round(bytes / 1024 / 1024);
    } else {
      unknown.push("ram");
    }
    // No spec'd way to detect GPU name/VRAM on darwin (unified memory,
    // metal is deterministic from platform alone) — left null + unknown.
    unknown.push("gpu");
  } else {
    probe.wsl2 = detectWsl2(fs, release);

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
          } else {
            probe.accel = "cpu";
            unknown.push("gpu");
          }
        }
      }
    }

    const memAvail = await readMemAvailable(fs);
    if (memAvail != null) {
      probe.ramAvailableMb = memAvail;
    } else {
      unknown.push("ram");
    }
  }

  const diskFreeMb = readDiskFreeMb(fs, modelsDir);
  if (diskFreeMb != null) {
    probe.diskFreeMb = diskFreeMb;
  } else {
    unknown.push("disk");
  }

  return probe;
}

// ---------------------------------------------------------------------------
// fitBadge
// ---------------------------------------------------------------------------

/**
 * Decide whether `quant` fits on the given `probe`.
 *
 * Fail-closed: missing RAM info (`probe.ramAvailableMb == null`) NEVER
 * returns "fits" — it returns "unknown". Swap is never part of `probe`, so
 * it can never leak in here either.
 *
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
 * @param {Probe|null|undefined} probe
 * @param {{min_ram_mb?: number, min_vram_mb?: number}} quant
 * @returns {"fits"|"tight"|"wont_fit"|"unknown"}
 */
export function fitBadge(probe, quant) {
  if (!probe || probe.ramAvailableMb == null) return "unknown";
  const minRam = quant?.min_ram_mb;
  if (typeof minRam !== "number" || !Number.isFinite(minRam)) return "unknown";

  const minVram = typeof quant?.min_vram_mb === "number" ? quant.min_vram_mb : 0;
  let effective = probe.ramAvailableMb;
  if (minVram > 0 && typeof probe.vramMb === "number" && probe.vramMb >= minVram) {
    effective += probe.vramMb;
  }

  if (minRam <= effective) return "fits";
  if (10 * minRam <= 11 * effective) return "tight"; // minRam / effective <= 1.10, integer-exact
  return "wont_fit";
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let cachedProbe = null;

/** Returns the last probe stored by `reprobe()`, or null if never probed. */
export function getCachedProbe() {
  return cachedProbe;
}

/** Forces a fresh `probeHardware()` call, stores it as the cache, and returns it. */
export async function reprobe(opts = {}) {
  const probe = await probeHardware(opts);
  cachedProbe = probe;
  return probe;
}
