/**
 * The satellite install gate (SAT-3, spec §7.0 items 2–3, §7.1; Kevin decision K5).
 *
 * Manifest fields, satellite profile only (a full Crow ignores them):
 *   "satellite": true                    eligible, but not measured yet: refused on a satellite
 *   "satellite": { "min_ram_mb": N }     eligible and measured: the bundle's reservation
 *                                        (container peak + ONE MCP child's peak, M1-measured)
 *   "mcp": { "mem_mb": N }               the MCP child's measured peak (admission, SAT-6)
 * The manifest's general `requires.min_ram_mb` is never used here.
 *
 * Gate: MemAvailable (read with the agent already running) − SAT_HOST_RESERVE_MB (96)
 *       − Σ headroom(installed satellite bundles) ≥ satellite.min_ram_mb,
 * headroom = max(0, reservation − current use); current use = the compose project's
 * containers' cgroup memory.current + the bundle's MCP child RSS. MemAvailable already reflects
 * what running bundles use, so only the unused part of each reservation is subtracted (no
 * double count). Swap counts 0. Every /proc, cgroup and docker read is injectable.
 */
import { readTextOrNull } from "./status.js";

export const SAT_HOST_RESERVE_MB = 96;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The manifest opts in (true, or the measured object). */
export function satelliteEligible(manifest) {
  return manifest?.satellite === true || isObj(manifest?.satellite);
}

/** The measured reservation in MB, or null. */
export function satelliteRamMb(manifest) {
  const v = isObj(manifest?.satellite) ? manifest.satellite.min_ram_mb : undefined;
  return posNum(v) ? v : null;
}

/** GPU, model, desktop and browser bundles never run on a satellite. */
function heavyReason(m) {
  if (m?.privileged === true) return "needs privileged access";
  if (m?.host_grants?.gpu || m?.requires?.gpu) return "needs a GPU";
  if (m?.type === "model" || /model/i.test(String(m?.category || ""))) return "is a model bundle";
  if (/desktop/i.test(String(m?.category || ""))) return "is a desktop bundle";
  if (m?.id === "browser" || /browser/i.test(String(m?.category || ""))) return "is a browser bundle";
  return null;
}

/** Why this manifest cannot install on a satellite: {code, status, reason} | null. */
export function satelliteManifestProblem(manifest) {
  if (!satelliteEligible(manifest)) return { code: "not_satellite", status: 403, reason: "This extension is not made for small servers." };
  const heavy = heavyReason(manifest);
  if (heavy) return { code: "never_satellite", status: 403, reason: `This extension ${heavy}, which a small server never runs.` };
  if (satelliteRamMb(manifest) === null || (manifest?.server && !posNum(manifest?.mcp?.mem_mb))) {
    return { code: "not_measured", status: 422, reason: "This extension is not measured for small servers yet." };
  }
  return null;
}

/** MemAvailable in whole MB, or null. Swap is never read. */
export function memAvailableMb(meminfoText) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(meminfoText || ""));
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

export function parseVmRssMb(statusText) {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(String(statusText || ""));
  return m ? Number(m[1]) / 1024 : 0;
}

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
/** cgroup v2 memory.current paths for a container: systemd driver, then cgroupfs driver. */
const cgroupPaths = (id) => [`/sys/fs/cgroup/system.slice/docker-${id}.scope/memory.current`, `/sys/fs/cgroup/docker/${id}/memory.current`];

/**
 * A bundle's current use in MB: Σ memory.current of its compose project's containers plus its
 * MCP child's RSS. Docker unreachable → the containers count 0 (the whole reservation stays held,
 * the conservative side).
 */
export async function bundleCurrentUseMb({ project, dockerRunner, readText = readTextOrNull, mcpPids = () => [] }) {
  let bytes = 0;
  try {
    const { stdout } = await dockerRunner("docker", ["ps", "-q", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`], { timeout: 15_000 });
    for (const id of String(stdout || "").split("\n").map((s) => s.trim()).filter((s) => CONTAINER_ID.test(s))) {
      for (const p of cgroupPaths(id)) {
        const t = readText(p);
        if (t !== null && /^\d+\s*$/.test(t)) { bytes += Number(t); break; }
      }
    }
  } catch { /* docker unreachable: 0 */ }
  let rss = 0;
  for (const pid of mcpPids() || []) {
    if (Number.isInteger(pid) && pid > 0) rss += parseVmRssMb(readText(`/proc/${pid}/status`));
  }
  return bytes / (1024 * 1024) + rss;
}

/**
 * The arithmetic. installed: [{id, reservationMb, useMb}].
 * → {ok:true, need_mb, free_mb} | {ok:false, code:"insufficient_memory", need_mb, free_mb, shortfall_mb, reason}
 */
export function gateDecision({ needMb, memAvailableMb: avail, installed = [], reserveMb = SAT_HOST_RESERVE_MB }) {
  const held = installed.reduce((s, b) => s + Math.max(0, Number(b.reservationMb) - Number(b.useMb || 0)), 0);
  const free = Math.floor(avail - reserveMb - held);
  if (free >= needMb) return { ok: true, need_mb: needMb, free_mb: free };
  const shortfall = Math.ceil(needMb - free);
  return {
    ok: false, code: "insufficient_memory", need_mb: needMb, free_mb: free, shortfall_mb: shortfall,
    reason: `Not enough memory on this server: the extension needs ${needMb} MB and ${Math.max(0, free)} MB is free after the ${reserveMb} MB reserve and the installed extensions' reservations (short by ${shortfall} MB).`,
  };
}

/**
 * The whole gate for one install. installed: installed.json records; manifestFor(id) → that
 * bundle's manifest (installed copy); currentUseMb(record) → MB. The bundle being installed is
 * never counted against itself.
 */
export async function runGate({ manifest, installed = [], manifestFor, readText = readTextOrNull, currentUseMb }) {
  const problem = satelliteManifestProblem(manifest);
  if (problem) return { ok: false, ...problem };
  const avail = memAvailableMb(readText("/proc/meminfo"));
  if (avail === null) return { ok: false, code: "memory_unknown", status: 503, reason: "This server's free memory could not be read." };
  const rows = [];
  for (const rec of installed) {
    if (!rec || rec.id === manifest.id) continue;
    const reservation = satelliteRamMb(manifestFor(rec.id));
    if (reservation === null) continue;
    rows.push({ id: rec.id, reservationMb: reservation, useMb: await currentUseMb(rec) });
  }
  const d = gateDecision({ needMb: satelliteRamMb(manifest), memAvailableMb: avail, installed: rows });
  return d.ok ? d : { ...d, status: 409 };
}
