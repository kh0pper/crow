/**
 * GPU architecture detection + bundle compatibility check.
 *
 * Bundles can declare `requires.gpu_arch` as an array of accepted arch tags.
 * A host's actual arch is detected once at gateway start (cached) by probing
 * `rocminfo` and `nvidia-smi`. Each manifest tag is matched against the host
 * tags via a small alias table that lets bundles target either a specific
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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

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

/** Cached host VRAM (GB), populated on first call. null = no GPU / unknown. */
let cachedVramGb = null;
let vramProbed = false;

/**
 * Detect total host GPU VRAM in GB (ROCm first, then NVIDIA). Returns null when
 * no GPU is present or detection fails — callers MUST treat null as "unknown"
 * and fail open (do not block install on a probe miss).
 */
export function detectGpuVramGb({ refresh = false } = {}) {
  if (vramProbed && !refresh) return cachedVramGb;
  let gb = null;
  try {
    const out = execFileSync(ROCMINFO, [], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" });
    gb = parseRocminfoVramGb(out);
  } catch { /* rocminfo missing or no AMD GPU */ }
  if (gb === null) {
    try {
      const out = execFileSync(
        NVIDIASMI,
        ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" },
      );
      gb = parseNvidiaSmiVramGb(out);
    } catch { /* nvidia-smi missing or no NVIDIA GPU */ }
  }
  cachedVramGb = gb;
  vramProbed = true;
  return cachedVramGb;
}

/** Cached host arches, populated on first call. */
let cachedHostArches = null;

/**
 * Detect the host's GPU architectures. Returns an array of tags, e.g.
 * ["gfx1151", "rocm", "cpu"] or ["sm_86", "cuda", "cpu"].
 *
 * Family tags are added alongside specific arches so manifests can target
 * either level. "cpu" is always included.
 */
export function detectGpuArch({ refresh = false } = {}) {
  if (cachedHostArches && !refresh) return cachedHostArches;
  const tags = new Set(["cpu"]);

  // ROCm: rocminfo lists each agent's `Name:` line. CPU agents have a marketing
  // name (e.g. "AMD RYZEN AI MAX+ 395 ..."), GPU agents have an arch name
  // (e.g. "gfx1151"). The arch never appears in CPU agent metadata, so a bare
  // text match for `Name: gfxNNNN` is unambiguous and avoids state machines.
  try {
    const out = execFileSync(ROCMINFO, [], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" });
    for (const tag of parseRocminfoArches(out)) {
      tags.add(tag);
      tags.add("rocm");
    }
  } catch {
    // rocminfo missing or no AMD GPU — fine, fall through.
  }

  // CUDA: nvidia-smi reports compute capability per GPU as "X.Y" (e.g. "8.6").
  // Convert to sm_XY form to match CUDA convention.
  try {
    const out = execFileSync(
      NVIDIASMI,
      ["--query-gpu=compute_cap", "--format=csv,noheader"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" },
    );
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\.(\d+)$/);
      if (m) {
        tags.add(`sm_${m[1]}${m[2]}`);
        tags.add("cuda");
      }
    }
  } catch {
    // nvidia-smi missing or no NVIDIA GPU — fine.
  }

  // Apple Silicon detection: present if `system_profiler SPHardwareDataType`
  // reports an "Apple" chip. We don't ship for macOS in the gateway today, so
  // just probe quietly.
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("system_profiler", ["SPHardwareDataType"], { timeout: 5000, encoding: "utf8" });
      const m = out.match(/Chip:\s*Apple\s+(\S+)/);
      if (m) {
        tags.add(`apple_${m[1].toLowerCase()}`);
        tags.add("metal");
      }
    } catch {
      // Fine.
    }
  }

  cachedHostArches = Array.from(tags);
  return cachedHostArches;
}

/**
 * Check whether a manifest's GPU arch requirement is satisfiable on this host.
 * Returns { ok: bool, reason?: string, required?: string[], detected?: string[] }.
 */
export function checkGpuArchCompatible(manifest, hostArches = detectGpuArch()) {
  const required = manifest?.requires?.gpu_arch;
  const requiresGpu = Boolean(manifest?.requires?.gpu);

  // No GPU requirement → always compatible.
  if (!requiresGpu && (!required || required.length === 0)) {
    return { ok: true };
  }

  // requires.gpu: true with no specific arch → just need any GPU (anything but
  // a cpu-only host).
  if (requiresGpu && (!required || required.length === 0)) {
    const hasGpu = hostArches.some((t) => t !== "cpu");
    return hasGpu
      ? { ok: true }
      : { ok: false, reason: "Bundle requires a GPU, but none was detected.", detected: hostArches };
  }

  // Explicit gpu_arch list — at least one entry must match a host tag, with
  // family-tag expansion.
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
