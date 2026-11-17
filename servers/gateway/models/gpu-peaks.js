/**
 * Declared per-provider GPU peaks, read from the host profile file (the
 * private engineering notes, the host profile section).
 *
 * Every number here is MiB-ish "mb": `gtt_total_mb`, `safety_margin_mb`,
 * `ram_floor_mb`, `prod_growth_mb`, and each provider's `gtt_peak_mb` /
 * `host_ram_peak_mb`. They are compared with the live readings
 * `models/live-sampler.js` reports, which converts its byte (and kB) counters
 * into the same unit. The word "mb" is the repo's shorthand for that, not a
 * decimal-megabyte claim.
 *
 * Path: $CROW_GPU_HOST_PROFILE_PATH, else
 * $XDG_STATE_HOME/crow/gpu-host-profile.json, else
 * ~/.local/state/crow/gpu-host-profile.json.
 *
 * A missing, unreadable or malformed file yields the built-in defaults and
 * never throws: an absent measurement must not make the gate itself fail. A
 * provider with no declared peak is `null` from `providerPeak`, which
 * `startDecision` treats as "cannot be sized yet" and refuses (fail closed).
 *
 *   {
 *     "gtt_total_mb": 131072,
 *     "safety_margin_mb": 8192,
 *     "ram_floor_mb": 12288,
 *     "kfd_limit": 4,
 *     "cpu_lane_cpuset": "0-15",
 *     "prod_growth_mb": 6144,
 *     "providers": { "crow-chat": { "gtt_peak_mb": 26000, "host_ram_peak_mb": 26000 } }
 *   }
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Admission defaults (the private engineering notes, admission defaults). */
export const DEFAULT_HOST_PROFILE = Object.freeze({
  safety_margin_mb: 8192,
  ram_floor_mb: 12288,
  cpu_lane_cpuset: "0-15",
  prod_growth_mb: 6144,
  providers: Object.freeze({}),
});

const NUMERIC_KEYS = Object.freeze([
  "gtt_total_mb", "safety_margin_mb", "ram_floor_mb", "kfd_limit", "prod_growth_mb",
]);
// The profile changes only when someone re-measures the host; one statSync per
// call is cheap, so the cache exists only to skip the read+parse.
const CACHE_MS = 2_000;

/** @returns the host profile file this process reads. */
export function hostProfilePath() {
  if (process.env.CROW_GPU_HOST_PROFILE_PATH) return process.env.CROW_GPU_HOST_PROFILE_PATH;
  const stateHome = process.env.XDG_STATE_HOME;
  if (stateHome) return join(stateHome, "crow", "gpu-host-profile.json");
  return join(homedir(), ".local", "state", "crow", "gpu-host-profile.json");
}

function numberOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function freezeProfile(profile) {
  for (const peak of Object.values(profile.providers)) Object.freeze(peak);
  Object.freeze(profile.providers);
  return Object.freeze(profile);
}

/** The defaults with every valid field of `raw` merged over them. */
function mergeProfile(raw) {
  const profile = { ...DEFAULT_HOST_PROFILE, providers: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return freezeProfile(profile);
  for (const key of NUMERIC_KEYS) {
    const n = numberOrNull(raw[key]);
    if (n != null) profile[key] = n;
  }
  if (typeof raw.cpu_lane_cpuset === "string" && raw.cpu_lane_cpuset) {
    profile.cpu_lane_cpuset = raw.cpu_lane_cpuset;
  }
  if (raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)) {
    for (const [name, peak] of Object.entries(raw.providers)) {
      if (peak && typeof peak === "object" && !Array.isArray(peak)) profile.providers[name] = { ...peak };
    }
  }
  return freezeProfile(profile);
}

let _cache = null; // { path, mtimeMs, at, value }

/**
 * The host profile, with the defaults filled in. Never throws.
 *
 * @param {{now?: number, path?: string}} [opts] `path` is the test seam
 * @returns {{gtt_total_mb?: number, safety_margin_mb: number, ram_floor_mb: number,
 *            kfd_limit?: number, cpu_lane_cpuset: string, prod_growth_mb: number,
 *            providers: Object<string, {gtt_peak_mb?: number, host_ram_peak_mb?: number}>}}
 */
export function readHostProfile({ now = Date.now(), path = hostProfilePath() } = {}) {
  let st;
  try { st = statSync(path); } catch { _cache = null; return mergeProfile(null); }
  if (_cache && _cache.path === path && _cache.mtimeMs === st.mtimeMs
      && now - _cache.at < CACHE_MS && now - _cache.at >= 0) {
    return _cache.value;
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { _cache = null; return mergeProfile(null); }
  // A parsed non-object (a number, an array) is as unusable as a broken file.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { _cache = null; return mergeProfile(null); }
  const value = mergeProfile(raw);
  _cache = { path, mtimeMs: st.mtimeMs, value };
  return value;
}

/**
 * A provider's declared peak, or null when the provider is absent from the
 * profile or either number is missing / not finite.
 *
 * @param {string} name
 * @returns {{gtt_peak_mb: number, host_ram_peak_mb: number}|null}
 */
export function providerPeak(name) {
  if (!name) return null;
  const providers = readHostProfile().providers;
  const peak = providers[String(name)];
  if (!peak || typeof peak !== "object") return null;
  const gtt = numberOrNull(peak.gtt_peak_mb);
  const ram = numberOrNull(peak.host_ram_peak_mb);
  if (gtt == null || ram == null) return null;
  return { gtt_peak_mb: gtt, host_ram_peak_mb: ram };
}