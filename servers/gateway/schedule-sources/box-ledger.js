/**
 * Box ledger (read-only): an operator's markdown ledger of box windows, parsed for the Schedule
 * page. Only its `## Reservations` table is read; each row becomes
 *   { when, what, owner, open, start, end, startNow, ongoing, unreadable }
 * (times in ms, read in the instance zone). The parser is a heuristic over the shapes a ledger
 * uses: a phrasing it doesn't know reads as "unreadable" (shown neutrally), never as stale.
 *
 * The path comes ONLY from CROW_BOX_LEDGER_PATH: there is no fallback to any home-directory
 * file, so a second instance running as the same unix user never shows the operator's ledger
 * unless its own environment says so. The file is lstat'ed first (regular files only: no
 * symlinks, no FIFOs) and read up to 1 MB. Nothing here writes, execs or opens a socket.
 */
import * as nodeFs from "node:fs";
import { isAbsolute } from "node:path";
import { dayNum, fromDayNum } from "../../shared/relative-dates.js";

export const LEDGER_MAX_BYTES = 1024 * 1024;
export const LEDGER_MAX_LINES = 2000;
/** A row is stale once it ended more than this long ago and is still open. */
export const STALE_AFTER_MS = 3_600_000;
const WHAT_MAX = 200, OWNER_MAX = 80, WHEN_MAX = 160;

/** The configured ledger path (absolute), or null. */
export function ledgerPath(env = process.env) {
  const p = env && typeof env.CROW_BOX_LEDGER_PATH === "string" ? env.CROW_BOX_LEDGER_PATH.trim() : "";
  return p && isAbsolute(p) ? p : null;
}

/** Markdown out of a cell, for display: bold/strike/code marks, links → their text. */
export function stripMd(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Split a table line on unescaped pipes; the outer empty cells go. */
function cells(line) {
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  if (out.length && out[0].trim() === "") out.shift();
  if (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.map((c) => c.trim());
}

const _fmts = new Map();
/** The zone's offset from UTC at `ms`, in ms. */
function offsetAt(ms, tz) {
  let f = _fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    _fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
}

/** Local wall time (y-m-d h:mi in `tz`) as ms (two passes settle the zone's offset). */
function wallMs(ymd, h, mi, tz) {
  const wall = Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, mi);
  try {
    let t = wall - offsetAt(wall, tz);
    t = wall - offsetAt(t, tz);
    return t;
  } catch { return null; }
}

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const weekdayOf = (dn) => new Date(dn * 86_400_000).getUTCDay();
const ONGOING = [/\bONGOING\b/, /\bstanding\b/i, /\bHELD\b/, /multi-session/i, /\buntil\b(?!\s*~?\d{1,2}:\d{2})/i];

/** The times of one `when` cell (already stripped of markdown). */
export function readWhen(when, { tz }) {
  const date = when.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!date) return { start: null, end: null, startNow: false, ongoing: false, unreadable: true };
  const ymd = { y: Number(date[1]), m: Number(date[2]), d: Number(date[3]) };
  const after = when.slice(date.index + date[0].length);
  const arrow = after.search(/→|->/);
  const left = arrow < 0 ? after : after.slice(0, arrow);
  const right = arrow < 0 ? "" : after.slice(arrow).replace(/^(→|->)\s*/, "");
  const ongoing = ONGOING.some((re) => re.test(when));
  const st = left.match(/(?:^|[^\d:])(\d{1,2}):(\d{2})\b/);
  const startNow = !st && /\bnow\b/i.test(left);
  const startMin = st ? Number(st[1]) * 60 + Number(st[2]) : null;
  const start = st ? wallMs(ymd, Number(st[1]), Number(st[2]), tz) : null;
  const eod = wallMs(ymd, 23, 59, tz);
  if (ongoing) return { start, end: null, startNow, ongoing: true, unreadable: false };

  let end;
  const hard = when.match(/hard stop\s+(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})/i);
  const to = right.match(/^~?(\d{1,2}):(\d{2})\b(?:\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b)?/i);
  const span = right.match(/^\+?\s*(?:cap|est\.?)\s*~?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(h|hrs?|hours?|min|mins|minutes?)\b/i);
  if (hard) {
    const d = hard[1] ? { y: Number(hard[1]), m: Number(hard[2]), d: Number(hard[3]) } : ymd;
    end = wallMs(d, Number(hard[4]), Number(hard[5]), tz);
  } else if (to) {
    const h = Number(to[1]), mi = Number(to[2]);
    let dn = dayNum(ymd);
    if (to[3]) {
      const want = DAYS[to[3].slice(0, 3).toLowerCase()];
      for (let k = 0; k < 8; k++) {
        if (weekdayOf(dn + k) === want && (k > 0 || startMin === null || h * 60 + mi >= startMin)) { dn += k; break; }
      }
    } else if (startMin !== null && h * 60 + mi < startMin) dn += 1;
    end = wallMs(fromDayNum(dn), h, mi, tz);
  } else if (span) {
    const n = Number(span[2] ?? span[1]);
    const ms = /^h/i.test(span[3]) ? n * 3_600_000 : n * 60_000;
    end = start !== null && !startNow ? start + ms : eod;
  } else {
    end = eod; // "→ end of day", or a dated row with no end it can read
  }
  return { start, end, startNow, ongoing: false, unreadable: false };
}

/**
 * The Reservations table's rows.
 * @param {string} text   the ledger
 * @param {{now:number, tz:string}} opts
 */
export function parseLedger(text, { tz } = {}) {
  const src = String(text ?? "").slice(0, LEDGER_MAX_BYTES);
  const lines = src.split(/\r?\n/);
  const out = [];
  let inSection = false, seen = 0, header = true;
  for (const raw of lines) {
    if (/^##\s/.test(raw)) {
      if (inSection) break;
      inSection = /^##\s+Reservations\b/i.test(raw);
      continue;
    }
    if (!inSection) continue;
    const leadStrike = /^\s*~~\|/.test(raw);
    const line = leadStrike ? raw.replace(/^\s*~~/, "") : raw;
    if (!/^\s*\|/.test(line)) continue;
    if (++seen > LEDGER_MAX_LINES) break;
    const c = cells(line);
    if (c.every((x) => /^:?-{3,}:?$/.test(x))) { header = false; continue; }
    if (header) continue; // the header row sits above the separator
    const [whenRaw = "", whatRaw = "", ownerRaw = ""] = c;
    const cleared = leadStrike || whenRaw.includes("~~") || whatRaw.includes("~~");
    const when = stripMd(whenRaw);
    const times = readWhen(when, { tz });
    out.push({
      when: clip(when, WHEN_MAX),
      what: clip(stripMd(whatRaw), WHAT_MAX),
      owner: clip(stripMd(ownerRaw), OWNER_MAX),
      open: !cleared,
      ...times,
    });
  }
  return out;
}

/** Open, not ongoing, readable, and ended more than an hour ago. */
export function isStale(row, now) {
  return !!row && row.open && !row.ongoing && !row.unreadable && row.end !== null && row.end < now - STALE_AFTER_MS;
}

let _cache = null; // { path, mtimeMs, size, tz, rows }

/**
 * The ledger's rows, or null when no path is configured, or the file is missing, not a regular
 * file (a symlink, a FIFO, a directory) or unreadable. `fs` is a test seam.
 * @returns {null | {path:string, rows:object[]}}
 */
export function readLedger({ env = process.env, tz = "UTC", fs = nodeFs } = {}) {
  const path = ledgerPath(env);
  if (!path) return null;
  let st;
  try { st = fs.lstatSync(path); } catch { return null; }
  if (!st.isFile()) return null;
  if (_cache && _cache.path === path && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size && _cache.tz === tz) return { path, rows: _cache.rows };
  let fd = null;
  try {
    // O_NOFOLLOW + O_NONBLOCK: a file swapped for a symlink or a FIFO after the lstat can't
    // redirect or block the read.
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return null;
    const buf = Buffer.alloc(Math.min(fst.size, LEDGER_MAX_BYTES));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    const rows = parseLedger(buf.subarray(0, got).toString("utf8"), { tz });
    _cache = { path, mtimeMs: st.mtimeMs, size: st.size, tz, rows };
    return { path, rows };
  } catch { return null; } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}
