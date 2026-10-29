/**
 * Who is calling the loopback signing relay? (item 46 PR-B)
 *
 * The separate bot hosts (pibot-bridge@, pibot-gateways@, pibot-discord@)
 * hold no actor key and must never get one, so they cannot prove themselves
 * with a secret: any secret they could read, a bot or pi child running as the
 * same uid could read too. The kernel and the INSTALLED unit files answer
 * instead. A caller is authenticated iff:
 *
 *   1. the connection's client-side row in /proc/net/tcp{,6} gives the
 *      connecting socket's inode (servers/shared/peer-uid.js peerSocketRow);
 *   2. one live unit of the CONFIGURED systemd manager (below) qualifies:
 *      its name is a bot host template's; Transient=no; its FragmentPath is
 *      the installed template file for that name (pibot-bridge@.service,
 *      pibot-gateways@.service, pibot-discord@.service, pibot-discord.service)
 *      in an allowed unit directory; and it loads its instance config from a
 *      root-owned, not group/world-writable /etc/crow/pibot-<instance>.env,
 *      which names the database the host serves;
 *   3. that unit's MainPID holds socket:[<inode>] in /proc/<pid>/fd, that pid
 *      sits in exactly that unit's cgroup (/proc/<pid>/cgroup), and its start
 *      time (/proc/<pid>/stat) is the one seen when the unit list was read
 *      (so a recycled pid never inherits the unit).
 *
 * The manager is product configuration, never probed: CROW_BOT_HOST_MANAGER
 * = "system" (default; scripts/pi-bots/install-runtime.sh installs system
 * units under /etc/systemd/system) or "user" (an install whose bot hosts are
 * the gateway user's own `systemctl --user` units). User mode is WEAKER: the
 * allowed fragment directory (~/.config/systemd/user) is writable by that same
 * uid, so any process of the gateway's user could install a look-alike unit.
 * The two managers are never consulted together (a same-uid process can
 * always start a transient --user unit with any name; Transient=no and the
 * fragment check refuse that, and system mode never looks at the user
 * manager at all).
 *
 * A pi or bot child in the same cgroup has another pid and fails; so does a
 * reparented orphan (systemd never makes it MainPID); so does any process that
 * merely shares the uid. Anything unresolvable (no systemd, a unit of another
 * uid whose fds this process cannot read, no procfs) refuses.
 *
 * Remaining assumptions: the gateway and the hosts run as the same uid (or the
 * gateway as root) so /proc/<pid>/fd is readable; Yama ptrace_scope >= 1, so a
 * same-uid process cannot pull the host's socket out of it (pidfd_getfd needs
 * ptrace rights) or inject into it; root (who writes /etc) is trusted.
 *
 * What this does NOT stop: code running as the gateway's user. A host's code
 * and the node its PATH resolves (the checkout, ~/.nvm) are writable by that
 * user, and a host restarts by itself (the bridge tick every minute), so a bot
 * with an open shell can plant code that then runs as a legitimate MainPID.
 * The check protects only against callers that cannot run code: an SSRF-style
 * fetch tool, another uid, a container. Only a dedicated bot user closes this.
 *
 * Every reader is a function parameter with a production default.
 */
import { execFile } from "node:child_process";
import { readdirSync, readlinkSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { peerSocketRow } from "../shared/peer-uid.js";

/** The unit names a bot host runs under (scripts/pi-bots/systemd/). */
export const BOT_HOST_UNIT_PATTERNS = Object.freeze([
  "pibot-bridge@*.service", "pibot-gateways@*.service", "pibot-discord@*.service", "pibot-discord.service",
]);
const UNIT_RE = /^(?:pibot-(bridge|gateways|discord)@([A-Za-z0-9_.:-]+)|pibot-(discord))\.service$/;
// A oneshot unit (the bridge tick) is "activating" while its ExecStart runs.
const LIVE_STATES = new Set(["active", "activating", "reloading"]);
export const SYSTEM_UNIT_DIRS = Object.freeze(["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"]);
const ENV_FILE_RE = /^\/etc\/crow\/pibot-([A-Za-z0-9_.:-]+)\.env$/;
const REJECT_LOG_WINDOW_MS = 3_600_000;
const REJECT_LOG_CAP = 256;
const UNIT_PROPS = ["Id", "MainPID", "ActiveState", "Transient", "FragmentPath", "ControlGroup", "EnvironmentFiles"];

export function isBotHostUnit(name) { return typeof name === "string" && UNIT_RE.test(name); }

/** "pibot-gateways@r4.service" → { template: "gateways", instance: "r4", templateFile: "pibot-gateways@.service" } | null */
export function unitTemplate(name) {
  const m = typeof name === "string" ? UNIT_RE.exec(name) : null;
  if (!m) return null;
  if (m[3]) return { template: "discord", instance: null, templateFile: "pibot-discord.service" };
  return { template: m[1], instance: m[2], templateFile: `pibot-${m[1]}@.service` };
}

/** The configured manager: "system" unless CROW_BOT_HOST_MANAGER=user. */
export function configuredManager(env = process.env) {
  const v = String(env.CROW_BOT_HOST_MANAGER || "").trim().toLowerCase();
  if (v === "user") return "user";
  if (v && v !== "system") console.warn(`[actor-sign] CROW_BOT_HOST_MANAGER="${v}" is not "system" or "user": using system`);
  return "system";
}

/** `systemctl show -p … <patterns>` → [{ unit, pid, state, transient, fragment, cgroup, envFiles }]. */
export function parseSystemctlShow(text) {
  const out = [];
  for (const block of String(text || "").split(/\n\s*\n/)) {
    const kv = {};
    const envFiles = [];
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k === "EnvironmentFiles") { if (v) envFiles.push(v.replace(/\s+\([^)]*\)\s*$/, "")); }
      else kv[k] = v;
    }
    if (!kv.Id) continue;
    out.push({
      unit: kv.Id,
      pid: /^\d+$/.test(kv.MainPID || "") ? Number(kv.MainPID) : 0,
      state: kv.ActiveState || "",
      transient: kv.Transient || "",
      fragment: kv.FragmentPath || "",
      cgroup: kv.ControlGroup || "",
      envFiles,
    });
  }
  return out;
}

function systemctl(args) {
  return new Promise((resolveP, reject) => {
    // Fixed argv, no shell: nothing from a request reaches this command line.
    execFile("systemctl", args, { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) => {
      // `show` over patterns exits 0 even with no match; a missing systemctl rejects.
      if (err && !stdout) return reject(err);
      resolveP(String(stdout || ""));
    });
  });
}

/** Production unit list for ONE manager. */
export async function defaultListUnits(manager) {
  const args = ["show", "--no-pager", ...UNIT_PROPS.flatMap((p) => ["-p", p]), "--", ...BOT_HOST_UNIT_PATTERNS];
  return parseSystemctlShow(await systemctl(manager === "user" ? ["--user", ...args] : args));
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

/** Every cgroup path /proc/<pid>/cgroup lists (v2 "0::/path", v1 "n:ctrl:/path"). */
export function defaultReadCgroups(pid) {
  return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").filter(Boolean).map((l) => l.split(":").slice(2).join(":"));
}

/** Field 22 of /proc/<pid>/stat (start time in clock ticks since boot), as a string. */
export function defaultReadStartTime(pid) {
  const t = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rest = t.slice(t.lastIndexOf(")") + 2).split(" "); // fields from 3 on
  return rest[19];
}

/** An instance config file: its text and who may write it. */
export function defaultReadEnvFile(path) {
  const st = statSync(path);
  return { isFile: st.isFile(), uid: st.uid, mode: st.mode, text: readFileSync(path, "utf8") };
}

/** KEY=VALUE lines (systemd EnvironmentFile syntax, quotes stripped). */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

/** The database a host with this instance config serves (instance-paths.mjs botsDbPath), or null. */
export function hostDbPathFromEnv(env) {
  if (env.CROW_DB_PATH) return resolve(env.CROW_DB_PATH);
  if (env.CROW_DATA_DIR) return resolve(env.CROW_DATA_DIR, "crow.db");
  return null;
}

/**
 * @param {object} [o]
 * @param {"system"|"user"} [o.manager]     default: configuredManager()
 * @param {(manager) => Promise<object[]>} [o.listUnits]
 * @param {(pid) => string[]} [o.readFdLinks]
 * @param {(pid) => string[]} [o.readCgroups]
 * @param {(pid) => string} [o.readStartTime]
 * @param {(path) => {isFile,uid,mode,text}} [o.readEnvFile]
 * @param {(name:"tcp"|"tcp6") => string} [o.readProcNet]  default: procfs
 * @param {string} [o.userUnitDir]          the one fragment dir allowed in user mode
 * @param {() => number} [o.now]
 * @param {(line:string) => void} [o.log]  where a unit's rejection reason goes (once an hour each)
 * @param {number} [o.cacheMs]       unit list lifetime
 * @param {number} [o.refreshMinMs]  minimum gap between two unit-list reads
 */
export function createBotHostCallerResolver({
  manager = configuredManager(), listUnits = defaultListUnits, readFdLinks = defaultReadFdLinks,
  readCgroups = defaultReadCgroups, readStartTime = defaultReadStartTime, readEnvFile = defaultReadEnvFile,
  readProcNet, userUnitDir = join(homedir(), ".config", "systemd", "user"), now = () => Date.now(),
  log = (m) => console.warn(m),
  cacheMs = 5000, refreshMinMs = 500,
} = {}) {
  const mgr = manager === "user" ? "user" : "system";
  const fragmentDirs = mgr === "user" ? [userUnitDir] : [...SYSTEM_UNIT_DIRS];
  let cache = null;       // { at, units }
  let lastAttempt = -Infinity;
  let inflight = null;

  // Why a unit did not qualify, once per (unit, reason) per hour: an operator
  // drop-in (a second EnvironmentFile, say) must not disable signing silently.
  // Unit names and reasons only, never a config file's content.
  const rejectLogged = new Map();
  function noteReject(unit, reason) {
    const k = `${unit}\n${reason}`;
    const t = now();
    const last = rejectLogged.get(k);
    if (last !== undefined && t - last < REJECT_LOG_WINDOW_MS) return;
    rejectLogged.delete(k);
    if (rejectLogged.size >= REJECT_LOG_CAP) rejectLogged.delete(rejectLogged.keys().next().value);
    rejectLogged.set(k, t);
    try { log(`[actor-sign] bot host unit ${unit} does not qualify: ${reason}`); } catch { /* never fatal */ }
  }

  /** One unit record → a qualified host, or { reject } naming why not. */
  function qualifyOrReason(u) {
    if (!u || !LIVE_STATES.has(u.state) || !Number.isSafeInteger(u.pid) || u.pid <= 1) return { reject: null }; // not running: not worth a line
    const t = unitTemplate(u.unit);
    if (!t) return { reject: null };
    if (u.transient !== "no") return { reject: "transient unit" };
    if (!u.cgroup) return { reject: "no control group" };
    const frag = String(u.fragment || "");
    if (!frag.startsWith("/") || normalize(frag) !== frag || !fragmentDirs.includes(dirname(frag))) return { reject: `unit file outside the allowed directories (${mgr} manager)` };
    if (basename(frag) !== t.templateFile) return { reject: `unit file is not the installed template ${t.templateFile}` };
    // The instance config: exactly one root-owned /etc/crow/pibot-<instance>.env.
    const files = Array.isArray(u.envFiles) ? u.envFiles : [];
    if (files.length !== 1) return { reject: `needs exactly one environment file, has ${files.length}` };
    const m = ENV_FILE_RE.exec(files[0]);
    if (!m) return { reject: "environment file is not /etc/crow/pibot-<instance>.env" };
    if (t.instance !== null && m[1] !== t.instance) return { reject: "environment file names another instance" };
    let ef;
    try { ef = readEnvFile(files[0]); } catch { return { reject: "environment file unreadable" }; }
    if (!ef || !ef.isFile || ef.uid !== 0 || (ef.mode & 0o022) !== 0) return { reject: "environment file is not a root-owned file closed to group and other writes" };
    const hostDbPath = hostDbPathFromEnv(parseEnvFile(ef.text));
    if (!hostDbPath) return { reject: "environment file names no database (CROW_DB_PATH or CROW_DATA_DIR)" };
    let start;
    try { start = String(readStartTime(u.pid)); } catch { return { reject: "main process start time unreadable" }; }
    return { host: { unit: u.unit, pid: u.pid, cgroup: u.cgroup, template: t.template, instance: t.instance, hostDbPath, start } };
  }

  function qualify(u) {
    const r = qualifyOrReason(u);
    if (r.reject) noteReject(u.unit, r.reject);
    return r.host || null;
  }

  async function read() {
    const all = await listUnits(mgr);
    return (Array.isArray(all) ? all : []).map(qualify).filter(Boolean);
  }

  /** The qualified hosts. Single-flight: concurrent callers share one read, and
   *  the attempt is stamped BEFORE it runs, so a burst of requests forks
   *  systemctl at most once per refreshMinMs. */
  async function candidates({ refresh = false } = {}) {
    const t = now();
    const fresh = cache && t - cache.at < cacheMs;
    if (fresh && !refresh) return cache.units;
    if (inflight) return inflight;
    if (t - lastAttempt < refreshMinMs) {
      if (cache) return cache.units;
      throw new Error("bot host units unavailable");
    }
    lastAttempt = t;
    inflight = read().then((units) => { cache = { at: now(), units }; return units; }).finally(() => { inflight = null; });
    return inflight;
  }

  function holder(units, inode) {
    const want = `socket:[${inode}]`;
    for (const u of units) {
      let links;
      try { links = readFdLinks(u.pid); } catch { continue; }
      if (!Array.isArray(links) || !links.includes(want)) continue;
      // The same process the unit list named, still in exactly that unit.
      let cgs, start;
      try { cgs = readCgroups(u.pid); start = String(readStartTime(u.pid)); } catch { continue; }
      if (!Array.isArray(cgs) || !cgs.includes(u.cgroup) || start !== u.start) continue;
      return u;
    }
    return null;
  }

  /** → { ok: true, unit, pid, template, instance, hostDbPath } | { ok: false, reason } */
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
      // A tick that started after the list was read: re-read it (single-flight, rate-limited).
      try { units = await candidates({ refresh: true }); } catch { return { ok: false, reason: "bot host units unavailable" }; }
      hit = holder(units, row.inode);
    }
    if (!hit) return { ok: false, reason: "caller is not a bot host's main process" };
    return { ok: true, unit: hit.unit, pid: hit.pid, template: hit.template, instance: hit.instance, hostDbPath: hit.hostDbPath };
  }

  return { authenticate, manager: mgr, _candidates: candidates };
}
