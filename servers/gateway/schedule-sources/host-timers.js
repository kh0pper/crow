/**
 * Machine timers (read-only): systemd timers and cron lines on the operator's machines, as JSON
 * files some collector wrote into one folder. The gateway only READS that folder: it never SSHes,
 * never spawns a process and never opens a connection for this.
 *
 * Folder: CROW_HOST_TIMERS_DIR, else <CROW_HOME>/host-timers/. Absent → nothing shows (one stat).
 * At most 50 `*.json` files of ≤ 256 KB each; each entry is lstat'ed (regular files only: a
 * symlink or a FIFO named x.json is skipped, so a read can never block), read with O_NOFOLLOW,
 * validated against the schema below and stripped of unknown fields. Results are cached 60 s.
 *
 *   { "schema": "crow.host-timers/1", "host": "box-1", "tz": "America/Chicago",
 *     "collected_at": "2026-10-26T13:45:01Z",
 *     "timers": [ { "id": "user:backup.timer", "kind": "systemd-user", "name": "backup",
 *                   "schedule": "every 2 h", "next": "…Z", "last": "…Z", "last_result": "success" },
 *                 { "id": "cron:3", "kind": "cron", "name": "collect.sh", "schedule": "*\/15 * * * *" } ] }
 *
 * The files are untrusted input. A cron entry's name is cut to its command's basename (leading
 * VAR=value words and `cd … &&` skipped, never any argument), every name is cut to 80 chars, and
 * the page escapes everything. A "check" command is offered for copying only when the unit
 * matches systemd's own name charset; the gateway never runs it.
 */
import * as nodeFs from "node:fs";
import { join, isAbsolute } from "node:path";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { cronNext } from "../../shared/schedule-core.js";
import { validTimeZone } from "../../shared/relative-dates.js";

export const SCHEMA = "crow.host-timers/1";
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TIMERS = 500;
export const CACHE_MS = 60_000;
/** A file whose collected_at is older than this is "old data". */
export const STALE_DATA_MS = 3_600_000;
export const KINDS = Object.freeze(["systemd-system", "systemd-user", "cron"]);
/** systemd's unit-name charset: only such a name ever reaches a copyable command. */
export const SAFE_UNIT = /^[A-Za-z0-9@._:\-]{1,255}$/;
const NAME_MAX = 80, HOST_MAX = 64, SCHEDULE_MAX = 120, RESULT_MAX = 40;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const str = (v, max) => (typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : null);
const isoMs = (v) => { if (typeof v !== "string") return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** The folder to read: CROW_HOST_TIMERS_DIR (absolute only), else <CROW_HOME>/host-timers. */
export function hostTimersDir(env = process.env) {
  const p = env && typeof env.CROW_HOST_TIMERS_DIR === "string" ? env.CROW_HOST_TIMERS_DIR.trim() : "";
  if (p) return isAbsolute(p) ? p : null;
  return join(resolveCrowHome(env), "host-timers");
}

/**
 * A command line's program name, never its arguments: leading VAR=value words, `cd … &&` /
 * `cd … ;` and common wrappers (env, nice, ionice, flock …) are skipped; then the basename.
 */
export function commandName(cmd) {
  let s = String(cmd ?? "").replace(CONTROL, " ").trim();
  // `cd somewhere && real` / `cd somewhere; real` → real (repeatable).
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^cd\s+\S+\s*(?:&&|;)\s*(.*)$/s);
    if (!m) break;
    s = m[1].trim();
  }
  const words = s.split(/\s+/).filter(Boolean);
  let i = 0;
  const wrapper = (w) => /^(env|nice|ionice|nohup|flock|timeout|chronic|exec|sudo)$/.test(w.split("/").pop()) || /^(-\S*|\d+)$/.test(w);
  while (i < words.length && (wrapper(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
  const prog = words[i] || "";
  const base = prog.split("/").filter(Boolean).pop() || "";
  return base.replace(/[;&|<>`$()'"\\]+.*$/, "").slice(0, NAME_MAX);
}

/** The read-only check command for a timer, or null when its unit isn't a safe systemd name. */
export function checkCommand(t) {
  if (!t || (t.kind !== "systemd-user" && t.kind !== "systemd-system")) return null;
  const unit = String(t.id).replace(/^(user|system):/, "");
  if (!SAFE_UNIT.test(unit)) return null;
  return `systemctl ${t.kind === "systemd-user" ? "--user " : ""}status ${unit}`;
}

/** One timer entry, validated, unknown fields dropped; null when unusable. */
function validTimer(raw, { tz, now }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = str(raw.id, 255);
  const kind = KINDS.includes(raw.kind) ? raw.kind : null;
  if (!id || !kind) return null;
  let name = str(raw.name, 400) || id;
  if (kind === "cron") name = commandName(name) || "cron";
  name = name.slice(0, NAME_MAX);
  const schedule = str(raw.schedule, SCHEDULE_MAX);
  let next = null;
  let cadence = null;
  if (kind === "cron" && schedule) {
    next = cronNext(schedule, tz, now);
    const after = next !== null ? cronNext(schedule, tz, next) : null;
    if (after !== null) cadence = Math.round((after - next) / 60_000);
  } else {
    next = isoMs(raw.next);
  }
  const last = isoMs(raw.last);
  if (kind !== "cron" && next !== null && last !== null && next > last) cadence = Math.round((next - last) / 60_000);
  const lastResult = str(raw.last_result, RESULT_MAX);
  const t = { id, kind, name, schedule, next: next !== null && next > now ? next : null, last, lastResult, cadence, failed: !!lastResult && lastResult !== "success" };
  t.check = checkCommand(t);
  return t;
}

/** One host file, validated (null when it doesn't match the schema). */
export function validHostFile(raw, { now = Date.now(), file = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== SCHEMA) return null;
  const host = str(raw.host, HOST_MAX);
  const collectedAt = isoMs(raw.collected_at);
  if (!host || collectedAt === null || !Array.isArray(raw.timers)) return null;
  const tz = (typeof raw.tz === "string" && validTimeZone(raw.tz)) || "UTC";
  const timers = raw.timers.slice(0, MAX_TIMERS).map((t) => validTimer(t, { tz, now })).filter(Boolean);
  return { host, tz, file, collectedAt, stale: now - collectedAt > STALE_DATA_MS, timers };
}

function readSmallRegular(fs, path) {
  let st;
  try { st = fs.lstatSync(path); } catch { return null; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  let fd = null;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(fst.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } catch { return null; } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

const _cache = new Map(); // dir → { mtimeMs, at, value }
/** Test seam: forget cached reads. */
export function _resetHostTimersCache() { _cache.clear(); }

/**
 * Every valid host file in the folder, or null when there is no folder.
 * @returns {null | {dir:string, hosts:object[], skipped:number}}
 */
export function readHostTimers({ env = process.env, now = Date.now(), fs = nodeFs } = {}) {
  const dir = hostTimersDir(env);
  if (!dir) return null;
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  if (!st.isDirectory()) return null;
  const hit = _cache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.value;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[^.].*\.json$/.test(n)).sort(); } catch { return null; }
  let skipped = Math.max(0, names.length - MAX_FILES);
  const hosts = [];
  for (const n of names.slice(0, MAX_FILES)) {
    const text = readSmallRegular(fs, join(dir, n));
    let h = null;
    if (text !== null) { try { h = validHostFile(JSON.parse(text), { now, file: n }); } catch { h = null; } }
    if (h) hosts.push(h); else skipped++;
  }
  hosts.sort((a, b) => a.host.localeCompare(b.host));
  const value = { dir, hosts, skipped };
  _cache.set(dir, { mtimeMs: st.mtimeMs, at: now, value });
  return value;
}
