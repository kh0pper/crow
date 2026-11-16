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
 * `host_ram_mb`, `hip_procs`. A legacy record carries none of them and reads
 * as `mode: "exclusive"` with null v2 fields; a mode string we don't know is
 * treated like any other corrupt record (fail closed).
 *
 * Every read-modify-write of the hold file or the calendar file goes under
 * the one lock below, which lives beside the calendar file.
 */

import {
  readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync,
  openSync, closeSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stealStaleLock } from "./models/native-lock.js";

/** Casey decision 2 (2026-09-04): a hold longer than this needs `force`. */
export const DEFAULT_MAX_HOLD_MS = 8 * 60 * 60 * 1000;
/** Casey decision 3: providers that may start even while reserved. The embed
 *  model is small, never evicted, and search/memory depend on it. */
export const DEFAULT_ALLOW = Object.freeze(["crow-embed"]);
const DEFAULT_MINUTES = 480;
const CACHE_MS = 2_000;

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
 *                   gtt_mb:number|null, host_ram_mb:number|null, hip_procs:number|null}}
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
  constructor(reservation, providerName) {
    const owner = (reservation && reservation.owner) || "unknown";
    const until = (reservation && reservation.expires_at) || "?";
    super(`box reserved by ${owner} until ${until} — refusing to start ${providerName || "a model"}`);
    this.name = "ReservedError";
    this.code = "box_reserved";
    this.http = 503;
    this.owner = owner;
    this.expires_at = reservation && reservation.expires_at ? reservation.expires_at : null;
    this.provider = providerName || null;
  }
}

/**
 * Write a reservation atomically (temp file + rename in the same directory).
 * @returns the record written.
 * @throws RangeError when the hold exceeds DEFAULT_MAX_HOLD_MS and !force.
 */
export function writeReservation({ owner, reason = "", minutes = DEFAULT_MINUTES, allow = [], force = false, now = Date.now(), path = reservationPath() } = {}) {
  const who = String(owner || "").trim();
  if (!who) throw new Error("writeReservation: owner is required");
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) throw new RangeError("writeReservation: minutes must be a positive number");
  const holdMs = Math.round(mins * 60_000);
  if (holdMs > DEFAULT_MAX_HOLD_MS && !force) {
    throw new RangeError(`hold of ${mins} min exceeds the 8h default max; pass force to exceed it`);
  }
  const rec = {
    owner: who,
    reason: String(reason || ""),
    started_at: new Date(now).toISOString(),
    expires_at: new Date(now + holdMs).toISOString(),
    allow: [...new Set((Array.isArray(allow) ? allow : []).filter((n) => typeof n === "string" && n))],
  };
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists or unwritable — the write below reports it */ }
  const tmp = join(dir, `.crow-box-reservation.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
  _cache = null;
  return rec;
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
// A lockfile whose owner pid is gone (or whose content can't be read as a pid)
// is stale and is discarded through `stealStaleLock` — rename-atomic, so two
// processes that both decide to steal cannot end up both believing they hold
// it. A bare unlink-then-create would hand the lock to both.
//
// Not re-entrant: a caller that already holds the lock (a composed operation)
// must use the lock-free inner functions rather than nest an acquire.

const LOCK_RETRY_MS = 25;

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

/** @returns true when this process now holds the lock. */
function tryAcquireLockFile(lockFile) {
  if (tryCreateLockFile(lockFile)) return true;
  const existingPid = readLockPidFile(lockFile);
  // A live owner elsewhere: wait. A dead pid or unreadable content: stale.
  if (existingPid != null && isProcessAlive(existingPid)) return false;
  stealStaleLock({ fs: lockFs(), lockPath: lockFile, existingPid });
  return tryCreateLockFile(lockFile);
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
 * throws an Error with `code === "box_lock_timeout"`.
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
