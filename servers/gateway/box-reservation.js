/**
 * Box reservation — the shared "this machine is spoken for" signal between
 * unattended GPU windows and the gateway's gpu-orchestrator.
 *
 * Spec: docs/superpowers/specs/2026-09-04-box-reservation-scheduling-scope.md
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
 */

import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Kevin decision 2 (2026-09-04): a hold longer than this needs `force`. */
export const DEFAULT_MAX_HOLD_MS = 8 * 60 * 60 * 1000;
/** Kevin decision 3: providers that may start even while reserved. The embed
 *  model is small, never evicted, and search/memory depend on it. */
export const DEFAULT_ALLOW = Object.freeze(["crow-embed"]);
const DEFAULT_MINUTES = 480;
const CACHE_MS = 2_000;

export function reservationPath() {
  if (process.env.CROW_BOX_RESERVATION_PATH) return process.env.CROW_BOX_RESERVATION_PATH;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/run/user/${uid}/crow-box-reservation.json`;
}

const CORRUPT = Object.freeze({
  owner: "unknown", reason: "unreadable reservation file", started_at: null, expires_at: null,
  allow: Object.freeze([]), corrupt: true, key: "corrupt",
});

// One-entry cache keyed by (path, mtimeMs): the router's hot path reads this
// per request. Corrupt reads are never cached so a fixed file is seen at once.
let _cache = null; // { path, mtimeMs, at, value }

function unionAllow(list) {
  const out = new Set(DEFAULT_ALLOW);
  for (const n of Array.isArray(list) ? list : []) if (typeof n === "string" && n) out.add(n);
  return [...out];
}

/**
 * @returns {null | {owner:string, reason:string, started_at:string|null, expires_at:string|null,
 *                   allow:string[], corrupt:boolean, key:string}}
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
