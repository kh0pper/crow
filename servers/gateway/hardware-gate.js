/**
 * Hardware gate for bundle installs.
 *
 * Refuses to install a bundle when the host does not have enough effective
 * RAM or disk to run it alongside already-installed bundles. Warns (but
 * allows) when under the recommended threshold.
 *
 * "Effective" RAM (not raw MemTotal) accounts for:
 *   - MemAvailable   — kernel's estimate of memory reclaimable without swap
 *   - SwapFree       — counted at half-weight, and ONLY when backed by SSD/NVMe
 *                      (rotational=0). SD-card swap is too slow to count as
 *                      headroom. zram is counted at half-weight regardless:
 *                      it's compressed RAM, not true extra capacity.
 *   - committed_ram  — sum of recommended_ram_mb across already-installed
 *                      bundles (from installed.json). Subtracted from the
 *                      available pool.
 *   - host reserve   — a flat 512 MB cushion to keep the base OS + Crow
 *                      gateway itself responsive.
 *
 * Manifests declare:
 *   requires.min_ram_mb         — refuse threshold (required)
 *   requires.recommended_ram_mb — warn threshold (optional; falls back to min)
 *   requires.min_disk_mb        — refuse threshold (required if disk-bound)
 *   requires.recommended_disk_mb — warn threshold (optional)
 *
 * Override: the installer accepts `force_install: true` only from the CLI
 * path (never exposed to the web UI). Forced installs still log the override
 * and the reason.
 */

import { readFileSync, existsSync, statfsSync } from "node:fs";

const HOST_RESERVE_MB = 512;
const SWAP_WEIGHT = 0.5; // swap counts half toward "effective" RAM

/**
 * Parse /proc/meminfo into { MemAvailable, SwapFree, ... } all in MB.
 */
export function readMeminfo(path = "/proc/meminfo") {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const out = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (m) out[m[1]] = Math.round(Number(m[2]) / 1024); // kB -> MB
  }
  return out;
}

/**
 * Detect whether the primary swap is backed by SSD (rotational=0) or zram.
 * Returns { ssd_swap_mb, zram_swap_mb, unknown_swap_mb } in MB.
 *
 * Reads /proc/swaps and checks /sys/block/<dev>/queue/rotational for each
 * device. A swapfile is attributed to the device holding its filesystem —
 * but walking that lineage in pure userland is fragile, so swapfiles whose
 * backing device we can't identify are treated as "unknown" and not counted
 * as SSD headroom.
 */
export function classifySwap(
  swapsPath = "/proc/swaps",
  rotationalFor = defaultRotationalProbe,
) {
  if (!existsSync(swapsPath)) {
    return { ssd_swap_mb: 0, zram_swap_mb: 0, unknown_swap_mb: 0 };
  }
  const lines = readFileSync(swapsPath, "utf8").split("\n").slice(1);
  let ssd = 0;
  let zram = 0;
  let unknown = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(/\s+/);
    const dev = parts[0];
    const type = parts[1];
    const sizeKb = Number(parts[2]);
    if (!Number.isFinite(sizeKb)) continue;
    const sizeMb = Math.round(sizeKb / 1024);

    if (/^\/dev\/zram/.test(dev)) {
      zram += sizeMb;
      continue;
    }
    if (type === "partition" && /^\/dev\//.test(dev)) {
      const blkName = dev.replace(/^\/dev\//, "").replace(/\d+$/, "");
      const rot = rotationalFor(blkName);
      if (rot === 0) ssd += sizeMb;
      else unknown += sizeMb; // rotational HDD or unknown
      continue;
    }
    // Swapfile or unrecognized entry — don't count as reliable headroom
    unknown += sizeMb;
  }
  return { ssd_swap_mb: ssd, zram_swap_mb: zram, unknown_swap_mb: unknown };
}

function defaultRotationalProbe(blkName) {
  const p = `/sys/block/${blkName}/queue/rotational`;
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, "utf8").trim();
    return v === "0" ? 0 : 1;
  } catch {
    return null;
  }
}

/**
 * Compute the effective RAM ceiling in MB.
 *   effective = MemAvailable + 0.5 × (ssd_swap_free + zram_swap_free)
 *
 * SwapFree from /proc/meminfo is the total free swap across all pools; we
 * approximate the "usable" portion by taking the min of SwapFree and the
 * sum of ssd+zram sizes we identified. Rotational / unknown swap is not
 * counted.
 */
export function computeEffectiveRam(meminfo, swapClass) {
  if (!meminfo) return null;
  const memAvail = meminfo.MemAvailable || 0;
  const swapFree = meminfo.SwapFree || 0;
  const usableSwapPool =
    (swapClass?.ssd_swap_mb || 0) + (swapClass?.zram_swap_mb || 0);
  const usableSwap = Math.min(swapFree, usableSwapPool);
  return Math.round(memAvail + SWAP_WEIGHT * usableSwap);
}

/**
 * Sum `recommended_ram_mb` across already-installed bundles.
 * Bundles that predate the hardware-gate field contribute 0 (backfill
 * migration not required — missing values default to 0, matching the F.0
 * open-item notes).
 */
export function committedRamMb(installed, manifestLookup) {
  let total = 0;
  for (const entry of installed || []) {
    const m = manifestLookup(entry.id);
    const r = m?.requires?.recommended_ram_mb;
    if (typeof r === "number" && r > 0) total += r;
  }
  return total;
}

/**
 * Decide whether a bundle install can proceed.
 *
 * Returns { allow: boolean, level: "ok"|"warn"|"refuse", reason?, stats }.
 * `stats` is always present so the UI/consent modal can show actual numbers.
 */
export function checkInstall({
  manifest,
  installed,
  manifestLookup,
  meminfoPath,
  dataDir,
  swapsPath,
  rotationalProbe,
  diskStat = defaultDiskStat,
}) {
  const minRam = manifest?.requires?.min_ram_mb || 0;
  const recRam =
    manifest?.requires?.recommended_ram_mb || minRam;
  const minDisk = manifest?.requires?.min_disk_mb || 0;
  const recDisk =
    manifest?.requires?.recommended_disk_mb || minDisk;

  const meminfo = readMeminfo(meminfoPath);
  const swapClass = classifySwap(swapsPath, rotationalProbe);
  const effectiveRam = computeEffectiveRam(meminfo, swapClass);
  const committed = committedRamMb(installed, manifestLookup);
  const freeRam = effectiveRam != null ? effectiveRam - committed : null;

  const diskFreeMb = diskStat(dataDir);

  const stats = {
    mem_total_mb: meminfo?.MemTotal ?? null,
    mem_available_mb: meminfo?.MemAvailable ?? null,
    swap: swapClass,
    effective_ram_mb: effectiveRam,
    committed_ram_mb: committed,
    free_ram_mb: freeRam,
    disk_free_mb: diskFreeMb,
    manifest_min_ram_mb: minRam,
    manifest_recommended_ram_mb: recRam,
    manifest_min_disk_mb: minDisk,
    manifest_recommended_disk_mb: recDisk,
    host_reserve_mb: HOST_RESERVE_MB,
  };

  // Refuse if RAM gate fails
  if (minRam > 0 && freeRam != null && freeRam - HOST_RESERVE_MB < minRam) {
    const short = minRam - Math.max(0, freeRam - HOST_RESERVE_MB);
    return {
      allow: false,
      level: "refuse",
      reason:
        `This bundle needs ${minRam} MB of available RAM but only ${Math.max(0, freeRam - HOST_RESERVE_MB)} MB is free after ` +
        `reserving ${HOST_RESERVE_MB} MB for the host and ${committed} MB for ${installed?.length || 0} already-installed bundle(s). ` +
        `Short by ${short} MB. Consider uninstalling another bundle or moving this to an x86 host.`,
      stats,
    };
  }

  // Refuse if disk gate fails
  if (minDisk > 0 && diskFreeMb != null && diskFreeMb < minDisk) {
    return {
      allow: false,
      level: "refuse",
      reason:
        `This bundle needs ${minDisk} MB of free disk space in ${dataDir} but only ${diskFreeMb} MB is available.`,
      stats,
    };
  }

  // Warn if under recommended
  if (recRam > 0 && freeRam != null && freeRam - HOST_RESERVE_MB < recRam) {
    return {
      allow: true,
      level: "warn",
      reason:
        `Under recommended: bundle prefers ${recRam} MB of free RAM, ${Math.max(0, freeRam - HOST_RESERVE_MB)} MB available after host reserve. Install will proceed but performance may suffer under load.`,
      stats,
    };
  }
  if (recDisk > 0 && diskFreeMb != null && diskFreeMb < recDisk) {
    return {
      allow: true,
      level: "warn",
      reason:
        `Under recommended disk: bundle prefers ${recDisk} MB free, ${diskFreeMb} MB available.`,
      stats,
    };
  }

  return { allow: true, level: "ok", stats };
}

function defaultDiskStat(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const s = statfsSync(path);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}
