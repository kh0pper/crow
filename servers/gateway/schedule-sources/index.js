/**
 * The Schedule page's read-only sources, as agenda items and problems: the current box hold,
 * the box ledger's windows, and the machines' timers. Every reader here only reads files; none
 * writes, execs, SSHes or opens a socket. Each source is absent unless it exists: no ledger path
 * → no Box rows; no timers folder → no Machines rows.
 *
 * Items carry `src` ("box" | "machines") and `readOnly: true`, so the page renders no control
 * for them and the POST actions (which take only a numeric Crow id) can never reach them.
 * Problems carry codes; the renderer (dashboard/panels/schedule/html.js) words them.
 */
import { readBoxHold, RELEASE_COMMAND } from "./box-hold.js";
import { readLedger, isStale } from "./box-ledger.js";
import { readHostTimers } from "./host-timers.js";
import { resolveSafeMarkdownPath } from "../routes/fileview.js";
import { docsUrl } from "../dashboard/shared/components.js";

const FREQUENT_MIN = 60;
export const REFRESH_DOCS = docsUrl("guide/schedule#machine-timers");

/** A POSIX shell single-quoted string (for a copyable path; never run here). */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const DEFAULT_READERS = {
  hold: ({ now }) => readBoxHold({ now }),
  ledger: ({ tz }) => readLedger({ tz }),
  timers: ({ now }) => readHostTimers({ now }),
  // The dashboard's markdown viewer can open the ledger when it sits under its root.
  viewable: (path) => { try { return !!resolveSafeMarkdownPath(path); } catch { return false; } },
};

/**
 * @param {{now:number, zone:string, readers?:object}} opts
 * @returns {{items:object[], problems:object[], hosts:object[], present:string[]}}
 */
export function readOnlySources({ now = Date.now(), zone = "UTC", readers = {} } = {}) {
  const r = { ...DEFAULT_READERS, ...readers };
  const items = [];
  const problems = [];
  const present = [];
  const base = { id: null, readOnly: true, enabled: true, zone, zoneDiffers: false, lastRun: null, cadence: null, summary: null };

  // The box: its current hold and its ledger.
  let hold = null;
  try { hold = r.hold({ now }); } catch { hold = null; }
  let ledger = null;
  try { ledger = r.ledger({ tz: zone, now }); } catch { ledger = null; }
  if ((hold && hold.state !== "none") || ledger) present.push("box");
  if (hold && hold.state === "active") {
    items.push({ ...base, ref: "box:hold", src: "box", kind: "box_hold", title: hold.owner, owner: hold.owner, reason: hold.reason, nextRun: hold.started ?? now, end: hold.ends, once: true, active: true });
  } else if (hold && hold.state === "corrupt") {
    problems.push({ code: "hold-corrupt", severity: "error", fixes: [{ act: "copy", text: RELEASE_COMMAND, label: "copyRelease" }] });
  }
  if (ledger) {
    const stale = [];
    ledger.rows.forEach((row, i) => {
      if (!row.open) return;
      if (isStale(row, now)) { stale.push(row); return; }
      const it = { ...base, ref: `box:${i}`, src: "box", kind: "box_window", title: row.what || row.when, owner: row.owner, when: row.when, once: true, ongoing: row.ongoing, unreadable: row.unreadable, startNow: row.startNow, end: row.end, nextRun: row.start };
      if (row.ongoing || row.unreadable) { items.push({ ...it, standing: true }); return; }
      if (row.end !== null && row.end < now) return; // just ended (inside the hour): not upcoming, not stale yet
      it.active = row.startNow || (row.start !== null && row.start <= now);
      items.push(it);
    });
    if (stale.length) {
      const fix = r.viewable(ledger.path)
        ? { act: "link", href: `/dashboard/fileview?path=${encodeURIComponent(ledger.path)}`, label: "openLedger" }
        : { act: "copy", text: shellQuote(ledger.path), label: "copyPath" };
      problems.push({ code: "ledger-stale", severity: "warning", count: stale.length, rows: stale.slice(0, 3).map((s) => s.what || s.when), fixes: [fix] });
    }
  }

  // The machines' timers.
  let timers = null;
  try { timers = r.timers({ now }); } catch { timers = null; }
  const hosts = timers && timers.hosts ? timers.hosts : [];
  if (hosts.length) present.push("machines");
  for (const h of hosts) {
    if (h.stale) problems.push({ code: "timers-old", severity: "warning", host: h.host, collectedAt: h.collectedAt, fixes: [{ act: "link", href: REFRESH_DOCS, label: "howRefresh", external: true }] });
    h.timers.forEach((t, i) => {
      if (t.failed) problems.push({ code: "timer-failed", severity: "error", host: h.host, timer: t, fixes: t.check ? [{ act: "copy", text: t.check, label: "copyCheck" }] : [] });
      if (t.next === null) return; // listed under "On the machines" only
      items.push({ ...base, ref: `timer:${h.host}:${i}`, src: "machines", kind: "host_timer", title: t.name, host: h.host, summary: t.schedule, cron: t.kind === "cron" ? t.schedule : null, once: false, nextRun: t.next, cadence: t.cadence, frequent: t.cadence !== null && t.cadence < FREQUENT_MIN, failed: t.failed });
    });
  }
  return { items, problems, hosts, present };
}
