/**
 * GPU architecture detection + bundle compatibility check.
 *
 * Bundles can declare `requires.gpu_arch` as an array of accepted arch tags.
 * A host's actual arch is detected once at gateway start (cached) by probing
 * `rocminfo`, `nvidia-smi` and (on darwin) `system_profiler`. Every probe is
 * asynchronous and bounded (`runBoundedProbe`): a wedged GPU driver can leave
 * its child unkillable, so no code path here spawns a child synchronously or
 * waits on one past its deadline. Each manifest tag is matched against the
 * host tags via a small alias table that lets bundles target either a specific
 * arch (e.g. `gfx1151`) or a family (e.g. `rocm`, `cuda`, `metal`, `cpu`).
 *
 * Manifest examples:
 *   requires.gpu_arch: ["cuda"]              // any NVIDIA CUDA-capable GPU
 *   requires.gpu_arch: ["rocm"]              // any AMD ROCm-capable GPU
 *   requires.gpu_arch: ["gfx1151"]           // only Strix Halo (Radeon 8060S)
 *   requires.gpu_arch: ["sm_80", "sm_86"]    // Ampere only
 *   requires.gpu_arch: ["cuda", "rocm", "cpu"]  // works anywhere
 *
 * Match rules:
 *   - No `requires.gpu_arch` and no `requires.gpu` → always compatible.
 *   - `requires.gpu: true` and no `gpu_arch` → compatible if host has *any* GPU.
 *   - `requires.gpu_arch` present → at least one tag must match a host tag,
 *     after expansion via `FAMILY_MEMBERS` (so `rocm` matches `gfx1151`).
 *   - `cpu` always matches (every host has a CPU).
 */

import { existsSync, readdirSync } from "node:fs";
import { runBoundedProbe } from "../shared/bounded-probe.js";

/**
 * Resolve a binary by trying PATH first, then a list of common absolute paths.
 * Returns the first existing absolute path, or the bare name (so PATH lookup
 * still happens). gpu-arch detection runs from the gateway whose systemd unit
 * may not have GPU vendor SDK directories in PATH.
 */
function resolveBinary(name, fallbackDirs) {
  // Probe each fallback dir literally + glob-expand /opt/rocm-* style patterns.
  for (const dir of fallbackDirs) {
    if (dir.includes("*")) {
      const [base, suffix] = dir.split("*");
      const parent = base.replace(/\/[^/]*$/, "");
      const prefix = base.split("/").pop() || "";
      try {
        for (const entry of readdirSync(parent)) {
          if (!entry.startsWith(prefix)) continue;
          const candidate = parent + "/" + entry + suffix + "/" + name;
          if (existsSync(candidate)) return candidate;
        }
      } catch { /* skip */ }
    } else {
      const candidate = dir + "/" + name;
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}

const ROCMINFO = resolveBinary("rocminfo", ["/opt/rocm/bin", "/opt/rocm-*/bin", "/usr/bin", "/usr/local/bin"]);
const NVIDIASMI = resolveBinary("nvidia-smi", ["/usr/bin", "/usr/local/bin", "/usr/local/nvidia/bin"]);

/** Family tags that match any specific arch in the family. */
const FAMILY_MEMBERS = {
  cuda: (tag) => /^sm_\d+$/.test(tag),
  rocm: (tag) => /^gfx[0-9a-f]+$/.test(tag),
  metal: (tag) => /^apple_/.test(tag),
  cpu: (tag) => tag === "cpu",
};

/**
 * Pure parser: extract gfxNNNN arch tags from rocminfo text. CPU agents carry a
 * marketing name (no gfx token), so a bare `Name: gfxNNNN` match is unambiguous.
 */
export function parseRocminfoArches(text) {
  const tags = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*Name:\s*(gfx[0-9a-f]+)\s*$/);
    if (m) tags.add(m[1]);
  }
  return [...tags];
}

/**
 * Pure parser: largest single GPU agent's VRAM pool in GB from rocminfo text. Per-agent state machine
 * that captures the largest `Segment: GLOBAL` pool size ONLY for GPU agents
 * (those whose `Name:` is gfxNNNN), so the CPU agent's (often larger) system-RAM
 * pool is never mistaken for VRAM. On a unified-memory APU this is the GTT/UMA
 * ceiling. Returns null if no GPU agent is found.
 */
export function parseRocminfoVramGb(text) {
  let inGpuAgent = false;
  let inGlobalSegment = false;
  let maxKb = 0;
  for (const line of text.split("\n")) {
    if (/^\s*Agent\s+\d+/.test(line)) {
      inGpuAgent = false;
      inGlobalSegment = false;
      continue;
    }
    if (/^\s*Name:\s*gfx[0-9a-f]+\s*$/.test(line)) {
      inGpuAgent = true;
      continue;
    }
    if (!inGpuAgent) continue;
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
  if (maxKb <= 0) return null;
  return Math.round(maxKb / 1024 / 1024); // KB -> GB (largest single agent pool)
}

/**
 * Pure parser: max GPU memory in GB from `nvidia-smi --query-gpu=memory.total
 * --format=csv,noheader,nounits` output (one integer MiB per GPU line).
 */
export function parseNvidiaSmiVramGb(text) {
  let maxMib = 0;
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)$/);
    if (m) maxMib = Math.max(maxMib, parseInt(m[1], 10));
  }
  if (maxMib <= 0) return null;
  return Math.round(maxMib / 1024); // MiB -> GB
}

/** Default per-command deadline for one probe. */
export const PROBE_DEADLINE_MS = 5000;

/**
 * How long an unknown (deadline) result stands before the host is probed
 * again. A wedged GPU is never re-probed in a hot path, and never more than
 * once per window.
 */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

/** The provisional, fail-open answer used before any probe has answered. */
const PROVISIONAL_ARCHES = ["cpu"];

/** Cached host arches; null until a probe has answered. */
let cachedHostArches = null;
/** Cached host VRAM (GB). null = no GPU / unknown. */
let cachedVramGb = null;
/**
 * Earliest time a populated cache may be probed again. Date.now() +
 * RETRY_AFTER_MS for a deadline (unknown) result, Number.POSITIVE_INFINITY for
 * a normal result, which stands for the process lifetime.
 */
let cacheRetryAt = 0;
/** The single in-flight probe, shared by every concurrent caller. */
let inFlightProbe = null;
/** Probe implementation seam (tests inject a stub instead of spawning). */
let probeImpl = runBoundedProbe;

/** Test seam: replace the probe implementation (null restores the real one). */
export function _setProbeImplForTest(fn) {
  probeImpl = fn || runBoundedProbe;
}

/** Test seam: forget every cached result and the in-flight probe. */
export function _resetGpuProbeForTest() {
  cachedHostArches = null;
  cachedVramGb = null;
  cacheRetryAt = 0;
  inFlightProbe = null;
}

/** True once a probe (normal, miss or deadline) has populated the cache. */
function cachePopulated() {
  return cachedHostArches !== null;
}

/** True when a new probe may run now: cache empty, or its retry window lapsed. */
function mayProbe() {
  return !cachePopulated() || Date.now() >= cacheRetryAt;
}

/**
 * Run one probe implementation call. The implementation is expected to never
 * throw and never reject; a stub that does is treated as a spawn error.
 */
async function callProbe(impl, cmd, args, deadlineMs) {
  try {
    const r = await impl(cmd, args, { deadlineMs });
    if (!r || typeof r !== "object") return { ok: false, stdout: "", reason: "spawn-error" };
    return { ok: r.ok === true, stdout: typeof r.stdout === "string" ? r.stdout : "", reason: r.reason };
  } catch {
    return { ok: false, stdout: "", reason: "spawn-error" };
  }
}

/**
 * One full probe, sequential and fully asynchronous. ONE rocminfo answers both
 * arches and VRAM; nvidia-smi answers compute capability (arch) and, only when
 * rocm had no GPU pool, memory.total (VRAM); system_profiler runs on darwin
 * only. A deadline on any command stops the remaining probes: the GPU is
 * wedged, so asking it anything else is pointless.
 *
 * @returns {Promise<{ok: boolean, arches: string[], vramGb: number|null, reason?: string}>}
 */
async function runProbe(impl, deadlineMs) {
  const tags = new Set(PROVISIONAL_ARCHES);
  let vramGb = null;
  let timedOut = false;

  // ROCm: rocminfo lists each agent's `Name:` line. CPU agents have a marketing
  // name (e.g. "AMD RYZEN AI MAX+ 395 ..."), GPU agents have an arch name
  // (e.g. "gfx1151"). The arch never appears in CPU agent metadata, so a bare
  // text match for `Name: gfxNNNN` is unambiguous.
  const rocm = await callProbe(impl, ROCMINFO, [], deadlineMs);
  if (rocm.reason === "deadline") {
    timedOut = true;
  } else if (rocm.ok) {
    for (const tag of parseRocminfoArches(rocm.stdout)) {
      tags.add(tag);
      tags.add("rocm");
    }
    vramGb = parseRocminfoVramGb(rocm.stdout);
  }

  // CUDA: nvidia-smi reports compute capability per GPU as "X.Y" (e.g. "8.6").
  // Convert to sm_XY form to match CUDA convention.
  if (!timedOut) {
    const nvArch = await callProbe(impl, NVIDIASMI, ["--query-gpu=compute_cap", "--format=csv,noheader"], deadlineMs);
    if (nvArch.reason === "deadline") {
      timedOut = true;
    } else if (nvArch.ok) {
      for (const line of nvArch.stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\.(\d+)$/);
        if (m) {
          tags.add(`sm_${m[1]}${m[2]}`);
          tags.add("cuda");
        }
      }
    }
  }

  // VRAM keeps its rocm-first-then-nvidia rule: nvidia-smi is asked about
  // memory.total only when rocminfo reported no GPU pool.
  if (!timedOut && vramGb === null) {
    const nvVram = await callProbe(
      impl,
      NVIDIASMI,
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      deadlineMs,
    );
    if (nvVram.reason === "deadline") {
      timedOut = true;
    } else if (nvVram.ok) {
      vramGb = parseNvidiaSmiVramGb(nvVram.stdout);
    }
  }

  // Apple Silicon detection: present if `system_profiler SPHardwareDataType`
  // reports an "Apple" chip. We don't ship for macOS in the gateway today, so
  // just probe quietly.
  if (!timedOut && process.platform === "darwin") {
    const mac = await callProbe(impl, "system_profiler", ["SPHardwareDataType"], deadlineMs);
    if (mac.reason === "deadline") {
      timedOut = true;
    } else if (mac.ok) {
      const m = mac.stdout.match(/Chip:\s*Apple\s+(\S+)/);
      if (m) {
        tags.add(`apple_${m[1].toLowerCase()}`);
        tags.add("metal");
      }
    }
  }

  if (timedOut) {
    cachedHostArches = [...PROVISIONAL_ARCHES];
    cachedVramGb = null;
    cacheRetryAt = Date.now() + RETRY_AFTER_MS;
    return { ok: false, arches: cachedHostArches, vramGb: null, reason: "deadline" };
  }

  cachedHostArches = Array.from(tags);
  cachedVramGb = vramGb;
  cacheRetryAt = Number.POSITIVE_INFINITY;
  return { ok: true, arches: cachedHostArches, vramGb };
}

/**
 * Probe this host's GPU, sharing one in-flight probe between every concurrent
 * caller. A normal result (success or a definite miss: missing binary,
 * non-zero exit) is cached for the process lifetime; a deadline result is
 * cached as unknown for RETRY_AFTER_MS.
 *
 * @param {{refresh?: boolean, deadlineMs?: number, probeImpl?: Function}} [opts]
 * @returns {Promise<{ok: boolean, arches: string[], vramGb: number|null, reason?: string}>}
 */
export async function probeGpuHost({ refresh = false, deadlineMs = PROBE_DEADLINE_MS, probeImpl: impl } = {}) {
  if (inFlightProbe) return inFlightProbe;
  if (!refresh && !mayProbe()) {
    return { ok: true, arches: cachedHostArches ?? [...PROVISIONAL_ARCHES], vramGb: cachedVramGb };
  }
  const use = impl || probeImpl;
  inFlightProbe = runProbe(use, deadlineMs).finally(() => {
    inFlightProbe = null;
  });
  return inFlightProbe;
}

/**
 * Schedule a background probe: fire-and-forget, at most one in flight, never
 * inside a retry window (unless `refresh` asks for one).
 */
function scheduleBackgroundProbe({ refresh = false } = {}) {
  if (inFlightProbe) return;
  if (!refresh && !mayProbe()) return;
  probeGpuHost({ refresh }).catch(() => {});
}

/**
 * Await the probe when the cached answer is still missing or stale, so an async
 * caller sees the real answer on a cold cache or after a deadline result's
 * retry window has lapsed. A no-op once a normal result is cached (its
 * cacheRetryAt is Infinity) or while a deadline result is still inside its
 * window; only a lapsed window re-probes, and that is bounded by the deadline.
 */
export async function ensureGpuProbed() {
  if (cachePopulated() && !mayProbe()) return;
  await probeGpuHost();
}

/**
 * Detect total host GPU VRAM in GB (ROCm first, then NVIDIA). Returns null when
 * no GPU is present, detection fails, or no probe has answered yet — callers
 * MUST treat null as "unknown" and fail open (do not block install on a probe
 * miss). Never forks or blocks: a cold cache schedules a background probe and
 * returns null immediately. `refresh` schedules a background re-probe.
 */
export function detectGpuVramGb({ refresh = false } = {}) {
  scheduleBackgroundProbe({ refresh });
  return cachedVramGb;
}

/**
 * Detect the host's GPU architectures. Returns an array of tags, e.g.
 * ["gfx1151", "rocm", "cpu"] or ["sm_86", "cuda", "cpu"].
 *
 * Family tags are added alongside specific arches so manifests can target
 * either level. "cpu" is always included. Never forks or blocks: a cold cache
 * schedules a background probe and returns the provisional ["cpu"] without
 * caching it. `refresh` schedules a background re-probe.
 */
export function detectGpuArch({ refresh = false } = {}) {
  scheduleBackgroundProbe({ refresh });
  return cachedHostArches ?? [...PROVISIONAL_ARCHES];
}

/**
 * Arch-only compatibility check — the logic extracted from the pre-VRAM
 * checkGpuArchCompatible. Returns the same shape (ok, reason, required,
 * detected) but never carries kind/vram fields. Internal — not exported.
 */
function checkArchOnly(manifest, hostArches) {
  const required = manifest?.requires?.gpu_arch;
  const requiresGpu = Boolean(manifest?.requires?.gpu);

  // No GPU requirement → always compatible.
  if (!requiresGpu && (!required || required.length === 0)) {
    return { ok: true };
  }
  // requires.gpu: true with no specific arch → need any GPU (non-cpu host).
  if (requiresGpu && (!required || required.length === 0)) {
    const hasGpu = hostArches.some((t) => t !== "cpu");
    return hasGpu
      ? { ok: true }
      : { ok: false, reason: "Bundle requires a GPU, but none was detected.", detected: hostArches };
  }
  // Explicit gpu_arch list — at least one tag must match (with family expansion).
  const hostSet = new Set(hostArches);
  for (const tag of required) {
    if (hostSet.has(tag)) return { ok: true };
    const family = FAMILY_MEMBERS[tag];
    if (family && hostArches.some(family)) return { ok: true };
  }
  return {
    ok: false,
    reason: `Bundle requires GPU arch in [${required.join(", ")}]; host has [${hostArches.join(", ")}].`,
    required,
    detected: hostArches,
  };
}

/**
 * Check whether a manifest's GPU requirements are satisfiable on this host.
 * Arch is checked first; only on an arch match is VRAM considered. When host
 * VRAM is unknown (null), VRAM gating is skipped (fail open).
 * Returns { ok: bool, reason?, kind?, required?, detected?, requiredVramGb?, detectedVramGb? }.
 */
export function checkGpuArchCompatible(manifest, hostArches = detectGpuArch(), hostVramGb = detectGpuVramGb()) {
  const archResult = checkArchOnly(manifest, hostArches);
  if (!archResult.ok) return archResult;

  const minVram = manifest?.requires?.min_vram_gb;
  if (typeof minVram === "number" && typeof hostVramGb === "number" && hostVramGb < minVram) {
    return {
      ok: false,
      kind: "vram",
      reason: `Requires ~${minVram} GB VRAM; host has ~${hostVramGb} GB.`,
      requiredVramGb: minVram,
      detectedVramGb: hostVramGb,
    };
  }
  return { ok: true };
}
