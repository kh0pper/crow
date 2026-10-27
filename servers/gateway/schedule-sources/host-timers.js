/**
 * Machine timers (read-only): systemd timers and cron lines on the operator's machines, as JSON
 * files some collector wrote into one folder. The gateway only READS that folder: it never SSHes,
 * never spawns a process and never opens a connection for this.
 *
 * Folder: CROW_HOST_TIMERS_DIR, else <CROW_HOME>/host-timers/. Absent → nothing shows (one stat).
 * At most 50 `*.json` files of ≤ 256 KB each (the listing stops there, or after 1,000 entries
 * of any name), 2,000 timers in all and 200 cron next-run computations (35 days ahead) per
 * read, and 50 ms for all of it: the rest is counted as not shown. Each entry is lstat'ed (regular files only: a
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
import { CronExpressionParser } from "cron-parser";
import { validTimeZone } from "../../shared/relative-dates.js";

export const SCHEMA = "crow.host-timers/1";
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 256 * 1024;
/** At most this many timers per read, across every file; the rest are counted as not shown. */
export const MAX_TOTAL_TIMERS = 2000;
/** The folder listing reads at most this many entries (of any name). */
export const MAX_DIR_ENTRIES = 1000;
export const CACHE_MS = 60_000;
/** A file whose collected_at is older than this is "old data". */
export const STALE_DATA_MS = 3_600_000;
export const KINDS = Object.freeze(["systemd-system", "systemd-user", "cron"]);
/**
 * systemd's unit-name charset, starting with a letter or digit: only such a name ever reaches a
 * copyable command (a leading "-" would be an option: `-H user@host` makes systemctl SSH out).
 */
export const SAFE_UNIT = /^[A-Za-z0-9][A-Za-z0-9@._:\-]{0,254}$/;
/** At most this many cron next-run computations per read, across every file. */
export const CRON_EVAL_CAP = 200;
/** A cron line's next run is looked for this far ahead only (a never-soon line stays cheap). */
export const LOOKAHEAD_MS = 35 * 86_400_000;
/**
 * One read gets at most this long for reading, validating and cron work together: past it, no
 * further file is read, no further timer validated and no further next run computed.
 */
const READ_BUDGET_MS = 70;
/** Of which cron next-run work gets at most this much; past it, the rest show "no next run". */
const CRON_BUDGET_MS = 30;
/** An unchanged file's validated timers are reused this long. */
const FILE_REUSE_MS = 15 * 60_000;
const NAME_MAX = 80, NAME_READ = 120, HOST_MAX = 64, SCHEDULE_MAX = 120, RESULT_MAX = 40;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Cut first, so nothing below ever scans more than a few hundred characters of a field.
const str = (v, max) => (typeof v === "string" ? v.slice(0, max).replace(CONTROL, " ").trim() : null);
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
  return `systemctl ${t.kind === "systemd-user" ? "--user " : ""}status -- ${unit}`;
}

/** The next two runs of a cron line inside the look-ahead ([] past it, null when unparseable). */
function cronNextTwo(expr, tz, now) {
  try {
    const it = CronExpressionParser.parse(String(expr), { tz, currentDate: new Date(now), endDate: new Date(now + LOOKAHEAD_MS) });
    const out = [it.next().getTime()];
    try { out.push(it.next().getTime()); } catch {}
    return out;
  } catch { return null; }
}

/** A fresh evaluation budget for one read. */
// The budget's clock (wall time); a test seam so the count caps can be checked on any machine.
let budgetClock = () => Date.now();
/** Test seam: the clock the read budget runs on (null restores the real one). */
export function _setBudgetClockForTest(fn) { budgetClock = fn || (() => Date.now()); }

function newBudget() {
  const t = budgetClock();
  return { left: CRON_EVAL_CAP, timersLeft: MAX_TOTAL_TIMERS, until: t + READ_BUDGET_MS, cronUntil: t + CRON_BUDGET_MS };
}
const outOfTime = (budget) => budgetClock() >= budget.until;

/** One timer entry, validated, unknown fields dropped; null when unusable. */
function validTimer(raw, { tz, now, budget }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // An id longer than a unit name can be is not cut down into one: the entry is dropped.
  if (typeof raw.id !== "string" || raw.id.length > 255) return null;
  const id = str(raw.id, 255);
  const kind = KINDS.includes(raw.kind) ? raw.kind : null;
  if (!id || !kind) return null;
  let name = str(raw.name, NAME_READ) || id.slice(0, NAME_READ);
  if (kind === "cron") name = commandName(name) || "cron";
  name = name.slice(0, NAME_MAX);
  const schedule = str(raw.schedule, SCHEDULE_MAX);
  let next = null;
  let cadence = null;
  if (kind === "cron" && schedule) {
    if (budget.left > 0 && budgetClock() < budget.cronUntil) {
      budget.left--;
      const two = cronNextTwo(schedule, tz, now);
      if (two && two.length) next = two[0];
      if (two && two.length > 1) cadence = Math.round((two[1] - two[0]) / 60_000);
    }
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
export function validHostFile(raw, { now = Date.now(), file = null, budget = newBudget() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== SCHEMA) return null;
  const host = str(raw.host, HOST_MAX);
  const collectedAt = isoMs(raw.collected_at);
  if (!host || collectedAt === null || !Array.isArray(raw.timers)) return null;
  const tz = (typeof raw.tz === "string" && validTimeZone(raw.tz)) || "UTC";
  const timers = [];
  let seen = 0;
  for (; seen < raw.timers.length; seen++) {
    if (budget.timersLeft <= 0 || outOfTime(budget)) break;
    budget.timersLeft--;
    const t = validTimer(raw.timers[seen], { tz, now, budget });
    if (t) timers.push(t);
  }
  return { host, tz, file, collectedAt, stale: now - collectedAt > STALE_DATA_MS, timers, notShown: raw.timers.length - seen };
}

/** The text of a regular file of ≤ MAX_FILE_BYTES already lstat'ed as `st`, or null. */
function readSmallRegular(fs, path, st) {
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
const _files = new Map(); // path → { mtimeMs, size, at, host } (host null = invalid file)
/** Test seam: forget cached reads. */
export function _resetHostTimersCache() { _cache.clear(); _files.clear(); }

/** The first MAX_FILES `*.json` names in the folder, without ever listing it whole. */
function listJson(fs, dir) {
  const names = [];
  let truncated = false, read = 0;
  const d = fs.opendirSync(dir);
  try {
    let e;
    while ((e = d.readSync()) !== null) {
      if (++read > MAX_DIR_ENTRIES) { truncated = true; break; }
      if (!/^[^.].*\.json$/.test(e.name)) continue;
      if (names.length >= MAX_FILES) { truncated = true; break; }
      names.push(e.name);
    }
  } finally { try { d.closeSync(); } catch {} }
  return { names: names.sort(), truncated };
}

/** Test seam: how many files under `dir` the per-file cache holds. */
export function _cachedFileCount(dir) { return [..._files.keys()].filter((k) => k.startsWith(join(dir, "/"))).length; }

/**
 * One file's validated host: reused while its name, mtime and size are unchanged. Returns
 * { host } (host null = invalid), or { unread: true } when the read is out of time.
 */
function hostOf(fs, dir, name, now, budget) {
  const path = join(dir, name);
  let st;
  try { st = fs.lstatSync(path); } catch { return { host: null }; }
  const hit = _files.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && now - hit.at >= 0 && now - hit.at < FILE_REUSE_MS) {
    if (!hit.host) return { host: null };
    budget.timersLeft -= hit.host.timers.length;
    return { host: { ...hit.host, stale: now - hit.host.collectedAt > STALE_DATA_MS, timers: hit.host.timers.map((t) => (t.next !== null && t.next <= now ? { ...t, next: null } : t)) } };
  }
  if (outOfTime(budget) || budget.timersLeft <= 0) return { unread: true };
  const text = readSmallRegular(fs, path, st);
  let h = null;
  if (text !== null) { try { h = validHostFile(JSON.parse(text), { now, file: name, budget }); } catch { h = null; } }
  // A file the budget cut short is not cached: the next read gets another go at all of it.
  if (!h || !h.notShown) _files.set(path, { mtimeMs: st.mtimeMs, size: st.size, at: now, host: h });
  return { host: h };
}

/**
 * Every valid host file in the folder, or null when there is no folder.
 * @returns {null | {dir:string, hosts:object[], skipped:number, truncated:boolean, hiddenTimers:number, unreadFiles:number}}
 */
export function readHostTimers({ env = process.env, now = Date.now(), fs = nodeFs } = {}) {
  const dir = hostTimersDir(env);
  if (!dir) return null;
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  if (!st.isDirectory()) return null;
  const hit = _cache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.value;
  let listing;
  try { listing = listJson(fs, dir); } catch { return null; }
  // Forget cached files that left the folder, so rotating names can't grow the cache.
  const listed = new Set(listing.names.map((n) => join(dir, n)));
  for (const k of _files.keys()) if (k.startsWith(join(dir, "/")) && !listed.has(k)) _files.delete(k);
  let skipped = 0, unreadFiles = 0, hiddenTimers = 0, shown = 0;
  const hosts = [];
  const budget = newBudget();
  for (const n of listing.names) {
    const r = hostOf(fs, dir, n, now, budget);
    if (r.unread) { unreadFiles++; continue; }
    if (!r.host) { skipped++; continue; }
    const h = r.host;
    // The total cap (a reused file's timers count too).
    const room = Math.max(0, MAX_TOTAL_TIMERS - shown);
    hiddenTimers += (h.notShown || 0) + Math.max(0, h.timers.length - room);
    if (h.timers.length > room) h.timers = h.timers.slice(0, room);
    shown += h.timers.length;
    hosts.push(h);
  }
  hosts.sort((a, b) => a.host.localeCompare(b.host));
  const value = { dir, hosts, skipped, truncated: listing.truncated, hiddenTimers, unreadFiles };
  _cache.set(dir, { mtimeMs: st.mtimeMs, at: now, value });
  return value;
}
