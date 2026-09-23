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
 *
 * Unified memory (Strix Halo runtime profile spec §2.1): `gpuArch`,
 * `unified`, `gttTotalMb`/`gttUsedMb` (amdgpu sysfs, read through the same
 * injected `fs`) and `ramTotalMb` are additive. On an APU the Vulkan
 * DEVICE_LOCAL heap is a slice of RAM, so `unified: true` tells fitBadge
 * never to add `vramMb` on top of RAM. Vulkan's deviceType decides
 * `unified` whenever it answered; the sysfs carve-out heuristic is only a
 * fallback. GTT fields are reported only when `unified === true`.
 */

import { execFile as execFileCb } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";

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
 * Returns { name, vramMb, deviceType, arch } (deviceType is the raw
 * `PHYSICAL_DEVICE_TYPE_*` token, arch is `parseGfxArch(name)`) or null if
 * no GPU with a DEVICE_LOCAL heap found. `vramMb` keeps its meaning — the
 * largest DEVICE_LOCAL heap — even on unified memory, where it is a slice
 * of RAM; `probe.unified` is what tells a consumer not to add it to RAM.
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
      candidates.push({
        name: currentName,
        vramMb: Math.round(maxHeapBytes / 1024 / 1024),
        deviceType: currentType,
        arch: parseGfxArch(currentName),
      });
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
 * Pull the gfx architecture out of a Vulkan device name — RADV puts it in
 * parentheses, e.g. "AMD Radeon Graphics (RADV GFX1151)" -> "gfx1151".
 * Returns null for names without a GFX token (NVIDIA, older RADV names
 * like "(RADV NAVI32)").
 */
export function parseGfxArch(name) {
  if (typeof name !== "string") return null;
  const m = name.match(/\bGFX(\d{2,4}[a-z]?)\b/i);
  return m ? `gfx${m[1].toLowerCase()}` : null;
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
 * Returns { name, vramMb, arch } for the largest GPU agent's GLOBAL pool, or null.
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
  let arch = null;

  const flushAgent = () => {
    if (isGpu && maxKb > 0) {
      candidates.push({ name: marketingName || "AMD GPU", vramMb: Math.round(maxKb / 1024), arch });
    }
    isGpu = false;
    marketingName = null;
    inGlobalSegment = false;
    maxKb = 0;
    arch = null;
  };

  for (const line of lines) {
    if (/^\s*Agent\s+\d+/.test(line)) {
      flushAgent();
      inAgent = true;
      continue;
    }
    if (!inAgent) continue;
    const gfx = line.match(/^\s*Name:\s*(gfx[0-9a-f]+)\s*$/);
    if (gfx) {
      isGpu = true;
      arch = gfx[1];
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

/**
 * Parse a `<field>:  N kB` line from /proc/meminfo text. MB, rounded.
 * Shared by `parseMemAvailableMb` and `parseMemTotalMb` — same line shape,
 * different field name.
 */
export function parseMeminfoKbField(text, field) {
  if (!text) return null;
  const re = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`);
  for (const line of text.split("\n")) {
    const m = line.match(re);
    if (m) return Math.round(Number(m[1]) / 1024);
  }
  return null;
}

/** Parse the `MemAvailable:  N kB` line from /proc/meminfo text. MB, rounded. */
export function parseMemAvailableMb(text) {
  return parseMeminfoKbField(text, "MemAvailable");
}

/** Parse the `MemTotal:  N kB` line from /proc/meminfo text. MB, rounded. */
export function parseMemTotalMb(text) {
  return parseMeminfoKbField(text, "MemTotal");
}

// ---------------------------------------------------------------------------
// Detection helpers (impure — call out to execFile/fs)
// ---------------------------------------------------------------------------

function detectWsl2(fs, release) {
  if (fs.existsSync(WSL_INTEROP_PATH)) return true;
  if (typeof release === "string" && /microsoft/i.test(release)) return true;
  return false;
}

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
    gpuArch: null,
    unified: null,
    gttTotalMb: null,
    gttUsedMb: null,
    ramAvailableMb: null,
    ramTotalMb: null,
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
    // Only report GTT when the chosen amdgpu card itself looks like a
    // carve-out iGPU. `probe.unified` can be true from Vulkan's verdict on a
    // NON-amdgpu integrated GPU (e.g. Intel) while a separate amdgpu
    // DISCRETE card is also present on the host; readAmdgpuMem always
    // returns the amdgpu card with the smallest vram_total, which on that
    // mixed host is the dGPU, not an iGPU — its GTT aperture is not a model
    // ceiling and must not be surfaced.
    if (
      probe.unified === true &&
      amd &&
      amd.vramTotalMb != null &&
      amd.vramTotalMb <= UNIFIED_VRAM_CARVEOUT_MAX_MB
    ) {
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
