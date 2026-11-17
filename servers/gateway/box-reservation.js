/**
 * Box reservation — the shared "this machine is spoken for" signal between
 * unattended GPU windows and the gateway's gpu-orchestrator.
 *
 * Spec in the private engineering notes
 * (§3.1 record, §3.2 orchestrator behavior, §6 decisions: reservations win,
 * 8 h default max hold, crow-embed exempt via DEFAULT_ALLOW).
 *
 * The record is a small JSON file on tmpfs (vanishes on reboot, which is the
 * right default — a reboot ends every window):
 *
 *   { owner, reason, started_at, expires_at, allow: [providerName…] }
 *
 * Writers: pi-lab's dsv4-window.sh at window open (removed at teardown) and
 * scripts/ops/box-reserve.mjs for manual holds. Reader: gpu-orchestrator.js,
 * before ANY model start. `expires_at` is mandatory so a crashed writer can
 * never wedge bots forever; a file we cannot parse, or one with no expiry,
 * counts as RESERVED (fail closed — someone may be mid-write, and an
 * unbounded hold is exactly what the expiry rule forbids).
 *
 * Path: $CROW_BOX_RESERVATION_PATH (the test seam, and what pi-lab honors
 * too) else /run/user/<uid>/crow-box-reservation.json.
 *
 * Optional fields (the one box calendar, private engineering notes §6.3):
 * `mode` ("exclusive" default, or "beside" for a GPU job that shares the
 * card), `kind`, `booking_id`, `job_id`, and for beside holds `gtt_mb`,
 * `host_ram_mb`, `hip_procs`, plus the two activation baselines
 * `gtt_used_at_activation_mb` / `mem_available_at_activation_mb` (what the
 * live counters read when the job started, so a start can estimate how much
 * of the job's own footprint is still to come). A legacy record carries none
 * of them and reads as `mode: "exclusive"` with null v2 fields; a mode string
 * we don't know is treated like any other corrupt record (fail closed).
 *
 * Every read-modify-write of the hold file or the calendar file goes under
 * the one lock below, which lives beside the calendar file.
 */

import {
  readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync,
  openSync, closeSync, writeSync, linkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stealStaleLock } from "./models/native-lock.js";
import { readLiveSnapshotSync } from "./models/live-sampler.js";
import { DEFAULT_HOST_PROFILE } from "./models/gpu-peaks.js";

/** Casey decision 2 (2026-09-04): a hold longer than this needs `force`. */
export const DEFAULT_MAX_HOLD_MS = 8 * 60 * 60 * 1000;
/** Casey decision 3: providers that may start even while reserved. The embed
 *  model is small, never evicted, and search/memory depend on it. */
export const DEFAULT_ALLOW = Object.freeze(["crow-embed"]);
const DEFAULT_MINUTES = 480;
const CACHE_MS = 2_000;

const MODULE_START_MS = Date.now();
let _processStartMs = MODULE_START_MS;

/**
 * The epoch ms this gateway process began (module load, to the millisecond).
 *
 * A beside hold that started before it began before this process did: the
 * providers a PREVIOUS process admitted beside it are not in the admitted-peak
 * tally (which only ever holds what this process itself admitted), so their
 * growth would be read as the job's own — its remaining footprint would be
 * counted too small, and the job could look like it outgrew its booking.
 * `startDecision` compares a hold's `started_at` against this and, when the
 * hold is older, sizes the job at its full booking.
 */
export function processStartMs() { return _processStartMs; }

/** Test seam: pretend this process began at `ms` (null restores module load). */
export function _setProcessStartForTest(ms) {
  _processStartMs = ms == null ? MODULE_START_MS : Number(ms);
}

/**
 * The error a beside hold or booking without a footprint gets: it would
 * reserve nothing at all, so the gate could not size a single start beside it.
 * `code` is what the CLI and the routes report.
 */
export function besideNeedsFootprint(where) {
  const err = new RangeError(
    `${where}: a beside hold needs positive gtt_mb and host_ram_mb (without them it reserves nothing)`,
  );
  err.code = "beside_needs_footprint";
  return err;
}

export function reservationPath() {
  if (process.env.CROW_BOX_RESERVATION_PATH) return process.env.CROW_BOX_RESERVATION_PATH;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/run/user/${uid}/crow-box-reservation.json`;
}

/**
 * The persistent calendar (the booking half of the one box calendar, per the
 * private engineering notes §6.3): `$CROW_BOX_SCHEDULE_PATH`, else
 * `$XDG_STATE_HOME/crow/box-schedule.json`, else
 * `~/.local/state/crow/box-schedule.json`. Exported here because the lock
 * that guards both files lives beside it.
 */
export function schedulePath() {
  if (process.env.CROW_BOX_SCHEDULE_PATH) return process.env.CROW_BOX_SCHEDULE_PATH;
  const stateHome = process.env.XDG_STATE_HOME;
  if (stateHome) return join(stateHome, "crow", "box-schedule.json");
  return join(homedir(), ".local", "state", "crow", "box-schedule.json");
}

/**
 * The one lock file for both layers, beside the CALENDAR file (never the hold
 * file): two processes with different hold paths still serialise on one
 * calendar. `path`, when given, IS the lock file path (the test seam).
 */
export function lockPath(path) {
  return path || join(dirname(schedulePath()), "crow-box-schedule.lock");
}

const CORRUPT = Object.freeze({
  owner: "unknown", reason: "unreadable reservation file", started_at: null, expires_at: null,
  allow: Object.freeze([]), corrupt: true, key: "corrupt",
  mode: "exclusive", kind: null, booking_id: null, job_id: null,
  gtt_mb: null, host_ram_mb: null, hip_procs: null,
  gtt_used_at_activation_mb: null, mem_available_at_activation_mb: null,
});

// One-entry cache keyed by (path, mtimeMs): the router's hot path reads this
// per request. Corrupt reads are never cached so a fixed file is seen at once.
let _cache = null; // { path, mtimeMs, at, value }

function unionAllow(list) {
  const out = new Set(DEFAULT_ALLOW);
  for (const n of Array.isArray(list) ? list : []) if (typeof n === "string" && n) out.add(n);
  return [...out];
}

const MODES = Object.freeze(["exclusive", "beside"]);

function optionalString(v) {
  return typeof v === "string" && v ? v : null;
}

function optionalNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @returns {null | {owner:string, reason:string, started_at:string|null, expires_at:string|null,
 *                   allow:string[], corrupt:boolean, key:string, mode:"exclusive"|"beside",
 *                   kind:string|null, booking_id:string|null, job_id:string|null,
 *                   gtt_mb:number|null, host_ram_mb:number|null, hip_procs:number|null,
 *                   gtt_used_at_activation_mb:number|null,
 *                   mem_available_at_activation_mb:number|null}}
 *   null when there is no file or the record has expired.
 */
export function readReservation({ now = Date.now(), path = reservationPath() } = {}) {
  let st;
  try { st = statSync(path); } catch { _cache = null; return null; }
  if (_cache && _cache.path === path && _cache.mtimeMs === st.mtimeMs && now - _cache.at < CACHE_MS && now - _cache.at >= 0) {
    return expireCheck(_cache.value, now);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { _cache = null; return CORRUPT; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { _cache = null; return CORRUPT; }
  const expiresMs = Date.parse(raw.expires_at);
  if (!Number.isFinite(expiresMs)) { _cache = null; return CORRUPT; }
  // A missing mode is a legacy record (exclusive); any other string is a
  // record we do not understand, so it fails closed like any corrupt file.
  const mode = raw.mode === undefined || raw.mode === null ? "exclusive" : raw.mode;
  if (!MODES.includes(mode)) { _cache = null; return CORRUPT; }
  const owner = String(raw.owner || "unknown");
  const started = typeof raw.started_at === "string" ? raw.started_at : null;
  const value = Object.freeze({
    owner,
    reason: String(raw.reason || ""),
    started_at: started,
    expires_at: new Date(expiresMs).toISOString(),
    allow: Object.freeze(unionAllow(raw.allow)),
    corrupt: false,
    key: `${owner}@${started || new Date(expiresMs).toISOString()}`,
    mode,
    kind: optionalString(raw.kind),
    booking_id: optionalString(raw.booking_id),
    job_id: optionalString(raw.job_id),
    gtt_mb: optionalNumber(raw.gtt_mb),
    host_ram_mb: optionalNumber(raw.host_ram_mb),
    hip_procs: optionalNumber(raw.hip_procs),
    gtt_used_at_activation_mb: optionalNumber(raw.gtt_used_at_activation_mb),
    mem_available_at_activation_mb: optionalNumber(raw.mem_available_at_activation_mb),
  });
  _cache = { path, mtimeMs: st.mtimeMs, at: now, value };
  return expireCheck(value, now);
}

function expireCheck(value, now) {
  return Date.parse(value.expires_at) > now ? value : null;
}

/** True when nothing is reserved, or `providerName` is on the allow list. */
export function isStartAllowed(reservation, providerName) {
  if (!reservation) return true;
  if (reservation.corrupt) return false;
  return !!providerName && (reservation.allow || []).includes(providerName);
}

export class ReservedError extends Error {
  /**
   * @param {object|null} reservation
   * @param {string} [providerName]
   * @param {null|string} [reason] `"reserved"` (default) or `"gpu_job_beside"`;
   *   falls back to `reservation.decisionReason` when omitted
   */
  constructor(reservation, providerName, reason = null) {
    const owner = (reservation && reservation.owner) || "unknown";
    const until = (reservation && reservation.expires_at) || "?";
    const why = reason || (reservation && reservation.decisionReason) || "reserved";
    if (why === "gpu_job_beside") {
      const job = reservation && reservation.job_id ? `, job ${reservation.job_id}` : "";
      super(`a render/video job is using part of the GPU (${owner}${job} until ${until}) — large model starts that do not fit beside it wait; refusing to start ${providerName || "a model"}`);
    } else {
      super(`box reserved by ${owner} until ${until} — refusing to start ${providerName || "a model"}`);
    }
    this.name = "ReservedError";
    this.code = "box_reserved";
    this.http = 503;
    this.owner = owner;
    this.expires_at = reservation && reservation.expires_at ? reservation.expires_at : null;
    this.provider = providerName || null;
    this.reason = why;
  }
}

/**
 * A beside hold's decision cannot be made from a live snapshot older than
 * this: a stale reading may describe a box that has changed since.
 */
export const BESIDE_SNAPSHOT_MAX_AGE_MS = 15_000;

function finiteOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * May `providerName` start right now, given the box's state?
 *
 * - No reservation: yes.
 * - A corrupt one: no (fail closed), reason "reserved".
 * - `exclusive`: today's `isStartAllowed` (the `allow[]` list), and NOTHING
 *   else is read — `live`, `peak` and `profile` may be undefined.
 * - `beside` (a render/video job sharing the card): an allowed provider
 *   starts; otherwise the provider's declared peak must fit next to the
 *   job's REMAINING footprint (its `gtt_mb`/`host_ram_mb` minus what the live
 *   counters show the JOB has already taken), under the safety margin and
 *   above the RAM floor. No peak, no snapshot, or a stale snapshot refuses.
 *
 *   What the job has taken is the growth of the live counters since
 *   activation LESS `admitted`, the declared peaks of the providers this
 *   gateway started beside the hold: their growth is theirs, not the job's
 *   progress, and charging it to the job would under-count what the job still
 *   has to take (and could make a job look like it had outgrown its booking).
 *
 *   A hold that began before this process did (its `started_at` is older than
 *   `processStart`) has an UNKNOWN tally: whatever a previous process admitted
 *   beside it is not in `admitted`, so the growth since activation cannot be
 *   attributed. Such a job is sized at its full booked footprint (nothing of
 *   it is counted as loaded yet — the gate fails closed) and is never reported
 *   over budget.
 *
 *   The requirement is the larger of what the live reading already implies
 *   (`used + remaining`) and what is COMMITTED: the booking's whole footprint
 *   plus the admitted peaks, on top of the activation baseline — or, for a
 *   hold that recorded no baseline, on top of the live reading. A provider
 *   that was admitted but has not loaded yet, or a snapshot older than its
 *   load, therefore still reserves its room: without that, two starts would be
 *   admitted into the same not-yet-taken space. The admitted peaks count
 *   either way: a hold without a baseline is sized from the counters as they
 *   read now, and what a provider started beside it has already spoken for is
 *   still not room for the next start.
 *
 *   A job whose own growth exceeds its booked `gtt_mb` is outgrowing its
 *   booking: every start not on the allow list is refused with
 *   `job_over_budget: true` (the orchestrator logs that once), whether or not
 *   the provider's peak would fit.
 *
 *   A beside hold with no `gtt_mb` or no `host_ram_mb` reserves nothing the
 *   gate can size, so every start not on the allow list is refused (fail
 *   closed); the booking and hold layers refuse to create one.
 *
 * Pure: every input is passed in (no file, no sysfs).
 *
 * @param {object|null} reservation as `readReservation` returns it
 * @param {string} providerName
 * @param {{peak?: {gtt_peak_mb: number, host_ram_peak_mb: number}|null,
 *          live?: {gttUsedMb: number, gttTotalMb: number, memAvailableMb: number, at: number}|null,
 *          profile?: object|null,
 *          admitted?: {gtt_peak_mb?: number, host_ram_peak_mb?: number}|null,
 *          now?: number, processStart?: number}} [inputs]
 *   `admitted` is the SUM of the declared peaks of the providers started
 *   beside this hold since it began (zeros when absent); `processStart`
 *   defaults to this process's own start (see `processStartMs`).
 * @returns {{allowed: boolean, reason: null|"reserved"|"gpu_job_beside",
 *            job_over_budget?: true}}
 */
export function startDecision(reservation, providerName, {
  peak = null, live = null, profile = null, admitted = null, now = Date.now(), processStart = processStartMs(),
} = {}) {
  if (!reservation) return { allowed: true, reason: null };
  if (reservation.corrupt) return { allowed: false, reason: "reserved" };
  if (reservation.mode !== "beside") {
    return isStartAllowed(reservation, providerName)
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "reserved" };
  }
  if (providerName && (reservation.allow || []).includes(providerName)) return { allowed: true, reason: null };
  const refuse = Object.freeze({ allowed: false, reason: "gpu_job_beside" });
  if (!peak) return refuse;
  if (!live) return refuse;
  if (!Number.isFinite(live.at) || now - live.at > BESIDE_SNAPSHOT_MAX_AGE_MS) return refuse;
  const gttUsed = finiteOrNull(live.gttUsedMb);
  const gttTotal = finiteOrNull(live.gttTotalMb);
  const memAvailable = finiteOrNull(live.memAvailableMb);
  const peakGtt = finiteOrNull(peak.gtt_peak_mb);
  const peakRam = finiteOrNull(peak.host_ram_peak_mb);
  if (gttUsed == null || gttTotal == null || memAvailable == null || peakGtt == null || peakRam == null) return refuse;
  const hostProfile = profile || DEFAULT_HOST_PROFILE;
  const safetyMargin = finiteOrNull(hostProfile.safety_margin_mb) ?? DEFAULT_HOST_PROFILE.safety_margin_mb;
  const ramFloor = finiteOrNull(hostProfile.ram_floor_mb) ?? DEFAULT_HOST_PROFILE.ram_floor_mb;
  const gttHold = optionalNumber(reservation.gtt_mb);
  const ramHold = optionalNumber(reservation.host_ram_mb);
  // A beside hold that booked no footprint cannot be sized: refuse every start
  // that is not on the allow list rather than let it through unmeasured.
  if (!(gttHold > 0) || !(ramHold > 0)) return refuse;
  const gttBase = optionalNumber(reservation.gtt_used_at_activation_mb);
  const ramBase = optionalNumber(reservation.mem_available_at_activation_mb);
  // Growth since activation that belongs to the JOB: everything the live
  // counters gained, less the declared peaks of the providers admitted beside
  // it. Without that subtraction a prod provider started beside the hold would
  // be counted as the job's own progress.
  const admittedGtt = finiteOrNull(admitted && admitted.gtt_peak_mb) ?? 0;
  const admittedRam = finiteOrNull(admitted && admitted.host_ram_peak_mb) ?? 0;
  // A hold older than this process: the tally cannot describe it, so nothing of
  // its booking counts as loaded yet and it is never called over budget.
  const startedMs = Date.parse(reservation.started_at);
  const tallyUnknown = !Number.isFinite(startedMs) || startedMs < Number(processStart);
  const jobGrowthGtt = gttBase == null ? null
    : (tallyUnknown ? 0 : Math.max(0, gttUsed - gttBase - admittedGtt));
  const jobGrowthRam = ramBase == null ? null
    : (tallyUnknown ? 0 : Math.max(0, ramBase - memAvailable - admittedRam));
  // What the job still has to take: its declared footprint minus the job's own
  // growth so far. Without a baseline, assume none of it has loaded yet (the
  // conservative reading: the whole booked amount is still to come).
  const remainingGtt = jobGrowthGtt == null ? gttHold : Math.max(0, gttHold - jobGrowthGtt);
  const remainingRam = jobGrowthRam == null ? ramHold : Math.max(0, ramHold - jobGrowthRam);
  // What is already committed, whatever the counters show yet: the baseline
  // (or, when the hold recorded none, the live reading) plus the job's whole
  // footprint plus every admitted peak. Once a provider is admitted its room is
  // spoken for even before it has loaded, so a second start is never admitted
  // into the same space — with or without an activation baseline.
  const committedGtt = (gttBase == null ? gttUsed : gttBase)
    + Math.max(gttHold, jobGrowthGtt ?? 0) + admittedGtt;
  const committedAvail = (ramBase == null ? memAvailable : ramBase)
    - Math.max(ramHold, jobGrowthRam ?? 0) - admittedRam;
  // The job is outgrowing its booking: refuse starts that would share the card
  // with it, and say so, so the operator can re-book or extend it. An allow[]
  // provider returned above is never refused here.
  if (!tallyUnknown && gttBase != null && jobGrowthGtt != null && jobGrowthGtt > gttHold) {
    return Object.freeze({ allowed: false, reason: "gpu_job_beside", job_over_budget: true });
  }
  const requiredGtt = Math.max(gttUsed + remainingGtt, committedGtt);
  const effectiveAvail = Math.min(memAvailable - remainingRam, committedAvail);
  const fitsGtt = requiredGtt + peakGtt <= gttTotal - safetyMargin;
  const fitsRam = effectiveAvail - peakRam >= ramFloor;
  return fitsGtt && fitsRam ? { allowed: true, reason: null } : refuse;
}

/**
 * Legacy entry point: an unconditional hold in the pre-calendar shape. It is
 * `activateHold({…, takeOver: true})` — it ignores whatever is already held
 * (a legacy writer overwrote the file), writes the same JSON as before and
 * takes the same lock.
 *
 * @returns the record written.
 * @throws RangeError when the hold exceeds DEFAULT_MAX_HOLD_MS and !force.
 */
export function writeReservation({ owner, reason = "", minutes = DEFAULT_MINUTES, allow = [], force = false, now = Date.now(), path = reservationPath() } = {}) {
  return activateHold({ owner, reason, minutes, allow, force, now, path, takeOver: true });
}

/** @returns true when a file was removed, false when there was none. */
export function clearReservation({ path = reservationPath() } = {}) {
  _cache = null;
  try { unlinkSync(path); return true; } catch (e) { if (e && e.code === "ENOENT") return false; throw e; }
}

// ---------------------------------------------------------------------------
// The lock (the private engineering notes §6.3: every read-modify-write of
// either layer goes under one lock; tmp+rename alone cannot do compare-and-set).
//
// `O_CREAT|O_EXCL` on a pid file, the same primitive models/native-lock.js uses.
// A lockfile whose owner pid is gone, whose content can't be read as a pid, or
// that is older than STALE_LOCK_AGE_MS (however alive its pid looks) is stale
// and is discarded rename-atomically — so two processes that both decide to
// steal cannot end up both believing they hold it. A bare unlink-then-create
// would hand the lock to both.
//
// Not re-entrant: a caller that already holds the lock (a composed operation)
// must use the lock-free inner functions rather than nest an acquire, and the
// synchronous form reports that as `box_lock_reentrant` instead of waiting.

const LOCK_RETRY_MS = 25;
// A lock file with no readable pid may belong to a process that has just done
// openSync("wx") and not yet written its pid. Younger than this, it is left
// alone; older, it is stale like a dead pid.
const STALE_EMPTY_LOCK_MS = 2_000;
// A critical section lasts milliseconds, so a lock file older than this is
// stale WHATEVER its pid says. After a reboot the pid in a leftover lock file
// very likely belongs to some unrelated live process: honouring it would wedge
// the box for as long as that process lives.
const STALE_LOCK_AGE_MS = 60_000;

// Test seam: runs between the staleness decision and the empty-lock steal's
// rename, so a test can replace the lock file in that window.
let _beforeEmptyLockSteal = null;
export function _setBeforeEmptyLockStealForTest(fn) { _beforeEmptyLockSteal = fn; }

function lockFs() {
  return { renameSync, unlinkSync, readFileSync };
}

function readLockPidFile(lockFile) {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user — still alive.
    return !!(err && err.code === "EPERM");
  }
}

function tryCreateLockFile(lockFile) {
  let fd;
  try {
    fd = openSync(lockFile, "wx");
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
  try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
  return true;
}

function lockFileAgeMs(lockFile) {
  try { return Date.now() - statSync(lockFile).mtimeMs; } catch { return null; }
}

/** @returns true when this process now holds the lock. */
function tryAcquireLockFile(lockFile) {
  if (tryCreateLockFile(lockFile)) return true;
  const existingPid = readLockPidFile(lockFile);
  if (existingPid != null) {
    const ageMs = lockFileAgeMs(lockFile);
    // A live owner elsewhere: wait — unless the file is older than any critical
    // section could be (a leftover lock whose pid a reboot has since reused).
    if (isProcessAlive(existingPid) && !(ageMs != null && ageMs > STALE_LOCK_AGE_MS)) return false;
    stealStaleLock({ fs: lockFs(), lockPath: lockFile, existingPid });
    return tryCreateLockFile(lockFile);
  }
  // No readable pid at all. Its creator may still be between the exclusive
  // open and the pid write, so a fresh file must not be stolen; only one older
  // than STALE_EMPTY_LOCK_MS is stale (its creator died mid-write).
  const ageMs = lockFileAgeMs(lockFile);
  if (ageMs == null) return tryCreateLockFile(lockFile); // vanished — retry the create
  if (ageMs < STALE_EMPTY_LOCK_MS) return false;
  if (!stealStaleEmptyLock(lockFile)) return false; // a third process took it in the window
  return tryCreateLockFile(lockFile);
}

/**
 * Put a staged lock file back where it came from, then drop the extra name.
 *
 * `linkSync` never replaces an existing file, so a third process that created a
 * lock file in the steal window keeps it (EEXIST) and this process is the one
 * that stands down; a rename back would silently replace their file and hand
 * the lock to two owners. Returns true when this process's file is the lock
 * file again, false when someone else's is.
 */
function putBackStagedLock(stagingPath, lockFile) {
  let ours = true;
  try {
    linkSync(stagingPath, lockFile);
  } catch {
    // EEXIST: a third process created the lock in the window and holds it now.
    // Anything else (a directory that vanished, a filesystem without hard
    // links) also leaves no lock file of ours behind.
    ours = false;
  }
  try { unlinkSync(stagingPath); } catch { /* already gone */ }
  return ours;
}

/**
 * Steal an empty (no readable pid) lock file, rename-atomic like
 * `stealStaleLock`. The rename is content-blind: another process may have
 * replaced the file between the age check and the rename, so the captured file
 * is re-examined afterwards. If its mtime is younger than
 * STALE_EMPTY_LOCK_MS the file belongs to someone else (a creator mid-write, or
 * a fresh lock) and goes straight back — through a hard link, so a lock file a
 * third process created meanwhile is never replaced; on EEXIST the staged copy
 * is dropped and the lock stays the other process's. Only a genuinely old file
 * is discarded.
 *
 * @returns {boolean} true when the path is free for this process to create its
 *   own lock file, false when another process's lock file is in place.
 */
function stealStaleEmptyLock(lockFile) {
  const stagingPath = `${lockFile}.empty.${process.pid}.${Date.now()}`;
  if (_beforeEmptyLockSteal) _beforeEmptyLockSteal(lockFile);
  try {
    renameSync(lockFile, stagingPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return true; // another racer got there first
    throw err;
  }
  let stagedAgeMs = null;
  try { stagedAgeMs = Date.now() - statSync(stagingPath).mtimeMs; } catch { stagedAgeMs = null; }
  if (stagedAgeMs != null && stagedAgeMs < STALE_EMPTY_LOCK_MS) {
    return putBackStagedLock(stagingPath, lockFile);
  }
  try { unlinkSync(stagingPath); } catch { /* already gone */ }
  return true;
}

function releaseLockFile(lockFile) {
  // Only remove the file if it is still ours: a steal race may already have
  // replaced it with another process's lock.
  try {
    if (readLockPidFile(lockFile) === process.pid) unlinkSync(lockFile);
  } catch { /* already gone */ }
}

function lockTimeoutError(lockFile, timeoutMs) {
  const err = new Error(`could not take ${lockFile} within ${timeoutMs} ms`);
  err.code = "box_lock_timeout";
  err.lockPath = lockFile;
  return err;
}

/**
 * The lock is not re-entrant, so waiting on a file that already names THIS
 * process can only end in a timeout — after blocking the whole thread for it.
 */
function reentrancyError(lockFile) {
  const err = new Error(
    `this process already holds ${lockFile}: the box lock is not re-entrant (a composed operation calls the _\u2026Locked inner functions)`,
  );
  err.code = "box_lock_reentrant";
  err.lockPath = lockFile;
  return err;
}

function sleepSync(ms) {
  // A synchronous sleep without a busy loop: Atomics.wait on a throwaway
  // buffer blocks this thread for exactly `ms`.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function prepareLockFile(lockFile) {
  try { mkdirSync(dirname(lockFile), { recursive: true }); } catch { /* exists or unwritable — openSync reports it */ }
}

/**
 * Run `fn` under the box-calendar lock, synchronously (the CLI and tests).
 * Waits up to `timeoutMs` (default 5 s) for a live holder to finish, then
 * throws an Error with `code === "box_lock_timeout"`. A file that already
 * names THIS process is not waited for: it throws `box_lock_reentrant` at
 * once (the lock is not re-entrant).
 *
 * @template T
 * @param {() => T} fn
 * @param {{path?: string, timeoutMs?: number}} [opts] `path` is the lock FILE path (test seam)
 * @returns {T}
 */
export function withReservationLock(fn, { path, timeoutMs = 5000 } = {}) {
  const lockFile = lockPath(path);
  prepareLockFile(lockFile);
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (!tryAcquireLockFile(lockFile)) {
    // Re-entrancy is a programming error, not contention: say so at once
    // instead of sleeping toward the timeout.
    if (readLockPidFile(lockFile) === process.pid) throw reentrancyError(lockFile);
    if (Date.now() >= deadline) throw lockTimeoutError(lockFile, timeoutMs);
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } finally {
    releaseLockFile(lockFile);
  }
}

/**
 * The same lock, for gateway code: polls with `setTimeout` so the event loop
 * keeps running while another process (or another request) holds it. `fn` may
 * be async. A blocking acquire must never appear on a request path.
 *
 * Critical sections must stay short: the 60 s stale rule takes the lock from a
 * section that lasts longer (only live readers would see it go), and awaiting
 * Docker or network work inside `fn` would hand it away in the middle of a
 * read-modify-write. Read what the section needs before taking the lock and do
 * the slow work after releasing it.
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{path?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withReservationLockAsync(fn, { path, timeoutMs = 5000 } = {}) {
  const lockFile = lockPath(path);
  prepareLockFile(lockFile);
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (!tryAcquireLockFile(lockFile)) {
    if (Date.now() >= deadline) throw lockTimeoutError(lockFile, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await fn();
  } finally {
    releaseLockFile(lockFile);
  }
}

// ---------------------------------------------------------------------------
// Owner-checked activate / renew / release (the one box calendar, private
// engineering notes §6.3).
//
// The lock above is NOT re-entrant. Each public wrapper takes it exactly once
// and then runs the matching `_…Locked` inner function; a composed operation
// that already holds the lock (book + activate, renew + extend its booking)
// calls the inner functions directly. The inner functions are exported for
// exactly that use and must never be called without the lock.
//
// Two separate flags, deliberately: `takeOver` ignores a foreign holder (what
// the legacy writeReservation does), `force` exceeds the 8 h cap.

export class HoldConflictError extends Error {
  /**
   * @param {string|null} holder the holder's owner string, `"unknown"` for an
   *   unreadable file, or null when there is no live hold at all.
   * @param {{expires_at?: string|null, message?: string}} [detail]
   */
  constructor(holder = null, { expires_at = null, message = null } = {}) {
    const who = holder == null ? null : String(holder);
    const until = expires_at ? ` until ${expires_at}` : "";
    super(message || (who ? `box held by ${who}${until}` : "no live hold for this owner"));
    this.name = "HoldConflictError";
    this.code = "box_held";
    this.http = 409;
    this.holder = who;
    this.expires_at = expires_at || null;
  }
}

const HOLD_MISSING = "missing";
const HOLD_CORRUPT = "corrupt";
const HOLD_RECORD = "record";

/** The hold file as it is on disk right now: missing, corrupt, or a record. */
function readHoldFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: HOLD_MISSING, raw: null };
    return { state: HOLD_CORRUPT, raw: null };
  }
  let raw;
  try { raw = JSON.parse(text); } catch { return { state: HOLD_CORRUPT, raw: null }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: HOLD_CORRUPT, raw: null };
  return { state: HOLD_RECORD, raw };
}

/** Write a hold record atomically (temp file + rename in the same directory). */
function writeHoldFile(path, rec) {
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists or unwritable — the write below reports it */ }
  const tmp = join(dir, `.crow-box-reservation.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
  _cache = null;
  return rec;
}

/**
 * Activate (or re-activate one's own) hold. Caller holds the lock.
 *
 * @returns the record written. A plain legacy-shaped hold writes exactly the
 *   old JSON: `mode` is only written for "beside", and the v2 fields only when
 *   they are given.
 * @throws {HoldConflictError} an unexpired hold by another owner (or a corrupt
 *   file) is in the way and !takeOver.
 * @throws {RangeError} bad minutes/mode, or minutes over the 8 h cap without force.
 */
export function _activateHoldLocked({
  owner, reason = "", minutes = DEFAULT_MINUTES, allow = [], mode = "exclusive",
  kind = null, booking_id = null, job_id = null,
  gtt_mb = null, host_ram_mb = null, hip_procs = null,
  gtt_used_at_activation_mb = null, mem_available_at_activation_mb = null,
  force = false, takeOver = false, now = Date.now(), path = reservationPath(),
} = {}) {
  const who = String(owner || "").trim();
  if (!who) throw new Error("hold: owner is required");
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) throw new RangeError("hold: minutes must be a positive number");
  if (!MODES.includes(mode)) throw new RangeError(`hold: mode must be one of ${MODES.join(" | ")}`);
  // A beside hold reserves part of the card for a job: without both footprint
  // numbers it reserves nothing, and the gate could not size a start beside it.
  if (mode === "beside" && !(optionalNumber(gtt_mb) > 0 && optionalNumber(host_ram_mb) > 0)) {
    throw besideNeedsFootprint("hold");
  }
  const holdMs = Math.round(mins * 60_000);
  if (holdMs > DEFAULT_MAX_HOLD_MS && !force) {
    throw new RangeError(`hold of ${mins} min exceeds the 8h default max; pass force to exceed it`);
  }
  const live = readReservation({ path, now });
  if (live && !takeOver) {
    if (live.corrupt) {
      throw new HoldConflictError("unknown", {
        message: "the box reservation file is unreadable (box held by unknown)",
      });
    }
    if (live.owner !== who) {
      throw new HoldConflictError(live.owner, { expires_at: live.expires_at });
    }
  }
  const rec = {
    owner: who,
    reason: String(reason || ""),
    started_at: new Date(now).toISOString(),
    expires_at: new Date(now + holdMs).toISOString(),
    allow: [...new Set((Array.isArray(allow) ? allow : []).filter((n) => typeof n === "string" && n))],
  };
  if (mode === "beside") rec.mode = "beside";
  const strings = { kind: optionalString(kind), booking_id: optionalString(booking_id), job_id: optionalString(job_id) };
  const numbers = {
    gtt_mb: optionalNumber(gtt_mb), host_ram_mb: optionalNumber(host_ram_mb), hip_procs: optionalNumber(hip_procs),
  };
  for (const [k, v] of Object.entries(strings)) if (v != null) rec[k] = v;
  for (const [k, v] of Object.entries(numbers)) if (v != null) rec[k] = v;
  // A beside hold records what the live counters read when the job started, so
  // `startDecision` can tell how much of the job's footprint is still to come.
  // Anything not supplied is filled from one synchronous read (null when the
  // counters are unreadable); whatever stays null is simply not written.
  let gttBase = optionalNumber(gtt_used_at_activation_mb);
  let ramBase = optionalNumber(mem_available_at_activation_mb);
  if (mode === "beside" && (gttBase == null || ramBase == null)) {
    let snapshot = null;
    try { snapshot = readLiveSnapshotSync(); } catch { snapshot = null; }
    if (gttBase == null) gttBase = snapshot ? optionalNumber(snapshot.gttUsedMb) : null;
    if (ramBase == null) ramBase = snapshot ? optionalNumber(snapshot.memAvailableMb) : null;
  }
  if (gttBase != null) rec.gtt_used_at_activation_mb = gttBase;
  if (ramBase != null) rec.mem_available_at_activation_mb = ramBase;
  return writeHoldFile(path, rec);
}

/**
 * Extend the caller's own unexpired hold. Caller holds the lock.
 *
 * `started_at` is kept, so the notice key `owner@started_at` does not change
 * and no second notice goes out. Every other field is preserved. A missing or
 * expired hold is never recreated: a legacy `rm -f` teardown ends the lease.
 *
 * @throws {HoldConflictError} missing file (holder null), corrupt file (holder
 *   "unknown"), expired hold, or a different owner.
 * @throws {RangeError} bad minutes; minutes over 8 h without force; a total
 *   span over 8 h from `started_at` for a hold that is not `kind: "gpu-job"`
 *   without force; or the extension running past `notAfter`.
 */
export function _renewHoldLocked({ owner, minutes, now = Date.now(), path = reservationPath(), notAfter = null, force = false } = {}) {
  const who = String(owner || "").trim();
  if (!who) throw new Error("hold: owner is required");
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) throw new RangeError("hold: minutes must be a positive number");
  const holdMs = Math.round(mins * 60_000);
  if (holdMs > DEFAULT_MAX_HOLD_MS && !force) {
    throw new RangeError(`hold of ${mins} min exceeds the 8h default max; pass force to exceed it`);
  }
  const file = readHoldFile(path);
  if (file.state === HOLD_MISSING) {
    throw new HoldConflictError(null, { message: `no live hold for ${who} to renew (nothing is held)` });
  }
  if (file.state === HOLD_CORRUPT) {
    throw new HoldConflictError("unknown", {
      message: `no live hold for ${who} to renew (the reservation file is unreadable; box held by unknown)`,
    });
  }
  const raw = file.raw;
  const expiresMs = Date.parse(raw.expires_at);
  if (!Number.isFinite(expiresMs)) {
    throw new HoldConflictError("unknown", {
      message: `no live hold for ${who} to renew (the reservation file has no readable expiry; box held by unknown)`,
    });
  }
  const expiresIso = new Date(expiresMs).toISOString();
  if (expiresMs <= now) {
    throw new HoldConflictError(null, {
      expires_at: expiresIso,
      message: `no live hold for ${who} to renew (the hold expired at ${expiresIso})`,
    });
  }
  const recOwner = optionalString(raw.owner) || "unknown";
  if (recOwner !== who) throw new HoldConflictError(recOwner, { expires_at: expiresIso });
  const nextExpiresMs = now + holdMs;
  const startedMs = Date.parse(raw.started_at);
  // The cap is per call (checked above) AND, for everything but a GPU job's
  // lease, on the total span from started_at. A legacy record has kind null,
  // so the total-span cap applies to it.
  if (!force && optionalString(raw.kind) !== "gpu-job" && Number.isFinite(startedMs)
      && nextExpiresMs - startedMs > DEFAULT_MAX_HOLD_MS) {
    throw new RangeError(`renewing to ${new Date(nextExpiresMs).toISOString()} would make the hold span more than 8h from ${raw.started_at}; pass force to exceed it`);
  }
  if (notAfter != null && nextExpiresMs > Number(notAfter)) {
    throw new RangeError("renew_past_next_booking");
  }
  return writeHoldFile(path, { ...raw, expires_at: new Date(nextExpiresMs).toISOString() });
}

/**
 * Remove the hold. Caller holds the lock.
 *
 * @returns {boolean} true when a file was removed. Only the holder's own hold
 *   is removed, unless `force`; a different owner's hold is left in place.
 */
export function _releaseHoldLocked({ owner, force = false, path = reservationPath() } = {}) {
  const who = String(owner || "").trim();
  if (!who) throw new Error("hold: owner is required");
  const file = readHoldFile(path);
  if (file.state === HOLD_MISSING) return false;
  const recOwner = file.state === HOLD_CORRUPT ? "unknown" : (optionalString(file.raw.owner) || "unknown");
  if (!force && recOwner !== who) return false;
  try {
    unlinkSync(path);
  } catch (err) {
    _cache = null;
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
  _cache = null;
  return true;
}

/**
 * Take the lock once and activate. `lock` ({path?, timeoutMs?}) is the test
 * seam for the lock file.
 * @returns the record written.
 */
export function activateHold(options = {}) {
  const { lock, ...rest } = options;
  return withReservationLock(() => _activateHoldLocked(rest), lock);
}

/** Take the lock once and renew the caller's own hold. @returns the record written. */
export function renewHold(options = {}) {
  const { lock, ...rest } = options;
  return withReservationLock(() => _renewHoldLocked(rest), lock);
}

/** Take the lock once and release the caller's own hold (or any with force). */
export function releaseHold(options = {}) {
  const { lock, ...rest } = options;
  return withReservationLock(() => _releaseHoldLocked(rest), lock);
}
