/**
 * Who is calling the loopback signing relay? (item 46 PR-B)
 *
 * The separate bot hosts (pibot-bridge@, pibot-gateways@, pibot-discord@)
 * hold no actor key and must never get one, so they cannot prove themselves
 * with a secret: any secret they could read, a bot or pi child running as the
 * same uid could read too. The kernel answers instead. A caller is
 * authenticated iff the socket it connected with is held by the MAIN process
 * of a live unit of those templates:
 *
 *   1. the connection's client-side row in /proc/net/tcp{,6} gives the
 *      connecting socket's inode (servers/shared/peer-uid.js peerSocketRow);
 *   2. systemd names each live bot host unit's MainPID (`systemctl show`,
 *      system and user managers, cached ~5 s, refreshed once on a miss);
 *   3. the caller is that unit iff /proc/<MainPID>/fd holds socket:[<inode>].
 *
 * A pi or bot child in the same cgroup has another pid and fails; so does a
 * reparented orphan (systemd never makes it MainPID); so does any process that
 * merely shares the uid. Anything unresolvable (no systemd, a unit of another
 * uid whose fds this process cannot read, no procfs) refuses.
 *
 * Limits (the trust this relies on): the gateway and the host run as the same
 * uid (or the gateway as root) so /proc/<pid>/fd is readable; Yama
 * ptrace_scope >= 1, so a same-uid process cannot pull the host's socket out
 * of it (pidfd_getfd needs ptrace rights); systemd's MainPID is the host's
 * node process (ExecStart execs node through env). Within the cache window a
 * host's MainPID could exit and its pid be reused by another same-uid process
 * holding the caller socket; the window is a few seconds and needs a pid
 * collision.
 *
 * Every reader is a function parameter with a production default; no
 * environment variable changes what this checks.
 */
import { execFile } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { peerSocketRow } from "../shared/peer-uid.js";

/** The unit names a bot host runs under (scripts/pi-bots/systemd/). */
export const BOT_HOST_UNIT_PATTERNS = Object.freeze([
  "pibot-bridge@*.service", "pibot-gateways@*.service", "pibot-discord@*.service", "pibot-discord.service",
]);
const UNIT_RE = /^(?:pibot-(?:bridge|gateways|discord)@[A-Za-z0-9_.:-]+|pibot-discord)\.service$/;
// A oneshot unit (the bridge tick) is "activating" while its ExecStart runs.
const LIVE_STATES = new Set(["active", "activating", "reloading"]);

export function isBotHostUnit(name) { return typeof name === "string" && UNIT_RE.test(name); }

/** `systemctl show -p Id -p MainPID -p ActiveState <patterns>` → [{ unit, pid, state }]. */
export function parseSystemctlShow(text) {
  const out = [];
  for (const block of String(text || "").split(/\n\s*\n/)) {
    const kv = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (!kv.Id) continue;
    out.push({ unit: kv.Id, pid: /^\d+$/.test(kv.MainPID || "") ? Number(kv.MainPID) : 0, state: kv.ActiveState || "" });
  }
  return out;
}

function systemctl(args) {
  return new Promise((resolve, reject) => {
    // Fixed argv, no shell: nothing from a request reaches this command line.
    execFile("systemctl", args, { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) => {
      // `show` over patterns exits 0 even with no match; a missing systemctl rejects.
      if (err && !stdout) return reject(err);
      resolve(String(stdout || ""));
    });
  });
}

/** Production unit list: both managers, live bot host units only. */
export async function defaultListUnits() {
  const args = ["show", "--no-pager", "-p", "Id", "-p", "MainPID", "-p", "ActiveState", "--", ...BOT_HOST_UNIT_PATTERNS];
  const results = await Promise.allSettled([systemctl(args), systemctl(["--user", ...args])]);
  if (results.every((r) => r.status === "rejected")) throw new Error("systemctl unavailable");
  return results.flatMap((r) => (r.status === "fulfilled" ? parseSystemctlShow(r.value) : []));
}

/** Production descriptor reader: the link target of every fd of `pid`. */
export function defaultReadFdLinks(pid) {
  const dir = `/proc/${pid}/fd`;
  const out = [];
  for (const fd of readdirSync(dir)) {
    try { out.push(readlinkSync(`${dir}/${fd}`)); } catch { /* closed meanwhile */ }
  }
  return out;
}

/**
 * @param {object} [o]
 * @param {() => Promise<Array<{unit:string,pid:number,state:string}>>} [o.listUnits]
 * @param {(pid:number) => string[]} [o.readFdLinks]
 * @param {(name:"tcp"|"tcp6") => string} [o.readProcNet]  default: procfs
 * @param {() => number} [o.now]
 * @param {number} [o.cacheMs]       unit list lifetime
 * @param {number} [o.refreshMinMs]  minimum age before a miss re-reads the list
 */
export function createBotHostCallerResolver({
  listUnits = defaultListUnits, readFdLinks = defaultReadFdLinks, readProcNet, now = () => Date.now(),
  cacheMs = 5000, refreshMinMs = 500,
} = {}) {
  let cache = null; // { at, units }

  async function candidates({ refresh = false } = {}) {
    const t = now();
    const fresh = cache && t - cache.at < cacheMs;
    const refreshable = !cache || t - cache.at >= refreshMinMs;
    if (fresh && !(refresh && refreshable)) return cache.units;
    const all = await listUnits();
    const units = (Array.isArray(all) ? all : [])
      .filter((u) => u && isBotHostUnit(u.unit) && LIVE_STATES.has(u.state) && Number.isSafeInteger(u.pid) && u.pid > 1);
    cache = { at: t, units };
    return units;
  }

  function holder(units, inode) {
    const want = `socket:[${inode}]`;
    for (const u of units) {
      let links;
      try { links = readFdLinks(u.pid); } catch { continue; }
      if (Array.isArray(links) && links.includes(want)) return u;
    }
    return null;
  }

  /** → { ok: true, unit, pid } | { ok: false, reason } */
  async function authenticate(socket) {
    if (!socket || typeof socket !== "object") return { ok: false, reason: "no socket" };
    let row;
    try { row = peerSocketRow(socket, readProcNet ? { readTable: readProcNet } : {}); } catch { row = null; }
    if (!row || row.unavailable) return { ok: false, reason: "socket table unreadable" };
    if (!row.inode || !/^\d+$/.test(String(row.inode)) || row.inode === "0") return { ok: false, reason: "caller socket not found" };
    let units;
    try { units = await candidates(); } catch { return { ok: false, reason: "bot host units unavailable" }; }
    let hit = holder(units, row.inode);
    if (!hit) {
      // A tick that started after the list was read: re-read it once (rate-limited).
      try { units = await candidates({ refresh: true }); } catch { return { ok: false, reason: "bot host units unavailable" }; }
      hit = holder(units, row.inode);
    }
    if (!hit) return { ok: false, reason: "caller is not a bot host's main process" };
    return { ok: true, unit: hit.unit, pid: hit.pid };
  }

  return { authenticate, _candidates: candidates };
}
