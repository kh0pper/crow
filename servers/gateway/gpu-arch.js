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
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*Name:\s*(gfx[0-9a-f]+)\s*$/);
      if (m) {
        tags.add(m[1]);
        tags.add("rocm");
      }
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
