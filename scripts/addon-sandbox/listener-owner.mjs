/**
 * Who owns the loopback listener a walled add-on's relay is about to reach?
 *
 * An add-on's allow list names loopback ports, and an allow list alone cannot
 * tell an app's own service from this computer's gateway, its satellite, a
 * root daemon (tailscaled), the installer's Caddy, or another add-on's
 * published port. So every `PORT n` splice asks the kernel and docker:
 *
 *   1. the listening socket is found in `/proc/net/tcp` and `/proc/net/tcp6`
 *      (state `0A`), which gives the socket's uid and inode. No listener that
 *      accepts a connection to the address is a refusal ("nothing listens
 *      there"), and EVERY matching listener must pass;
 *   2. a socket owned by the gateway uid is mapped to its process through
 *      `/proc/<pid>/fd` (`socket:[<inode>]`). A gateway or satellite node
 *      process — in any checkout, so a co-hosted instance is caught too — is
 *      refused, and so is an inode that maps to no process. Any other process
 *      of this uid counts as the add-on's own service only if it is none of
 *      the wall's own processes (this relay, a `pi_netns_entry.mjs` helper,
 *      `bwrap`) and nothing about it — an argv element, its cwd, its
 *      executable — lies under this Crow's checkout or home (`crowRoots`):
 *      with no root to compare against, every same-uid listener is refused;
 *   3. a root-owned socket must be a port a running container publishes, and
 *      that container must carry a compose project label naming an installed
 *      add-on. The docker view is passed in (the gateway already reads it); a
 *      port no container publishes covers tailscaled and every other root
 *      daemon. An unlabelled project, a project of no installed add-on and
 *      another add-on's project are all refused; only this add-on's own
 *      project passes, plus the one named multi-add-on exception below;
 *   4. any other uid is refused (Caddy runs as its own user);
 *   5. anything that throws is a refusal, never a pass.
 *
 * The caller caches the answer briefly and asks again on every splice, so a
 * listener that changes hands is caught inside the cache window.
 *
 * Node built-ins only; `/proc` and docker reads are injectable for tests.
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { isIP } from "node:net";

/** A listening TCP socket's state in /proc/net/tcp{,6}. */
const LISTEN = "0A";

/**
 * The one named exception to the foreign-project rule: an add-on (key) may
 * reach a loopback port published by the compose project of one of these TTS
 * add-ons (values), and only when the caller names that port explicitly.
 */
export const TTS_PORT_EXCEPTION = Object.freeze({ media: Object.freeze(["kokoro-tts", "piper"]) });

/** Host IPs a published port is reachable on from the host's loopback. */
const PUBLISHED_HOST_IPS = new Set(["127.0.0.1", "0.0.0.0", "::", ""]);

/** An 8-char little-endian hex IPv4 field -> "a.b.c.d". */
function hex4ToAddr(h) {
  const s = String(h || "");
  if (!/^[0-9a-fA-F]{8}$/.test(s)) return null;
  return [0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16)).reverse().join(".");
}

/** A 32-char hex IPv6 field (four little-endian 32-bit words) -> eight 16-bit groups. */
function hex6ToGroups(h) {
  const s = String(h || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  const groups = [];
  for (let w = 0; w < 4; w++) {
    const word = s.slice(w * 8, w * 8 + 8);
    const bytes = [0, 2, 4, 6].map((i) => parseInt(word.slice(i, i + 2), 16)).reverse();
    groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
  }
  return groups;
}

/** RFC 5952 form: lowercase, no leading zeros, the longest (first) zero run as "::". */
function format6(g) {
  const hex = g.map((x) => x.toString(16));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return hex.join(":");
  return hex.slice(0, best).join(":") + "::" + hex.slice(best + bestLen).join(":");
}

/** The one spelling this check compares: brackets and a zone go, v4-mapped becomes its IPv4. */
function canon(addr) {
  const s = String(addr ?? "").trim().replace(/^\[(.*)\]$/, "$1").split("%")[0].toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  return mapped ? mapped[1] : s;
}

/** Every local address a listener on `addr` may be bound to and still answer. */
function wildcardOf(addr) {
  const a = canon(addr);
  const fam = isIP(a);
  if (fam === 4) return [a, "0.0.0.0", "::"];
  if (fam === 6) return [a, "::"];
  return [a];
}

/** The LISTEN rows of one /proc/net/tcp{,6} text. */
function listenersIn(text) {
  const out = [];
  for (const line of String(text || "").split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    if (String(c[3]).toUpperCase() !== LISTEN) continue;
    const parts = String(c[1]).split(":");
    if (parts.length !== 2) continue;
    const uid = Number(c[7]);
    const port = parseInt(parts[1], 16);
    if (!Number.isInteger(uid) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    let addr = null;
    if (parts[0].length === 8) addr = hex4ToAddr(parts[0]);
    else if (parts[0].length === 32) {
      const g = hex6ToGroups(parts[0]);
      if (g) {
        addr = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff
          ? [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".")
          : format6(g);
      }
    }
    if (!addr) continue;
    out.push({ addr, port, uid, inode: String(c[9]) });
  }
  return out;
}

/** The pid holding a socket inode, from `/proc/<pid>/fd` links; null when unmapped. */
function pidForInode(inode, opts) {
  let pids;
  try { pids = opts.readdir("/proc"); } catch { return null; }
  for (const name of pids || []) {
    if (!/^\d+$/.test(String(name))) continue;
    let fds;
    try { fds = opts.readdir("/proc/" + name + "/fd"); } catch { continue; }
    for (const fd of fds || []) {
      let target = "";
      try { target = String(opts.readlink("/proc/" + name + "/fd/" + fd)); } catch { continue; }
      if (target === "socket:[" + inode + "]") return Number(name);
    }
  }
  return null;
}

/** One NUL-separated /proc/<pid>/cmdline, as its argv list. */
function argvOf(pid, opts) {
  let text = "";
  try { text = String(opts.readFile("/proc/" + pid + "/cmdline") || ""); } catch { return []; }
  return text.split("\0").filter((x) => x !== "");
}

/** The process's own cwd, so a relative argv element can be resolved; null when unreadable. */
function cwdOf(pid, opts) {
  try {
    const t = String(opts.readlink("/proc/" + pid + "/cwd") ?? "");
    return t === "" ? null : t;
  } catch { return null; }
}

/** The process's executable; null when unreadable. */
function exeOf(pid, opts) {
  try {
    const t = String(opts.readlink("/proc/" + pid + "/exe") ?? "");
    return t === "" ? null : t;
  } catch { return null; }
}

/** An absolute path as the comparisons want it: no trailing slashes, "/" kept; null otherwise. */
function cleanPath(p) {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s.startsWith("/")) return null;
  const t = s.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

/** Is `p` the root itself or below it? By path segment: /srv/crow-other is not under /srv/crow. */
function underRoot(p, root) {
  const a = cleanPath(p);
  if (!a) return false;
  if (root === "/") return true;
  return a === root || a.startsWith(root + "/");
}

/** The last segment of a path, for matching a helper by its program name. */
function baseName(p) {
  const s = String(p ?? "");
  const cut = s.lastIndexOf("/");
  return cut < 0 ? s : s.slice(cut + 1);
}

/** One listener's verdict. Every problem is a `denied` result, never a pass. */
async function verdictFor(listener, opts) {
  const base = { uid: listener.uid, inode: listener.inode };
  if (listener.uid === opts.gatewayUid) {
    const pid = pidForInode(listener.inode, opts);
    if (pid === null) return { kind: "denied", reason: "unmapped", ...base };
    const argv = argvOf(pid, opts);
    const cwd = cwdOf(pid, opts);
    const cwdPrefix = cwd === null ? null : cwd.replace(/\/+$/, "");
    const resolved = argv.map((a, i) => (i === 0 || a.startsWith("/") || cwdPrefix === null ? a : cwdPrefix + "/" + a));
    // The gateway and its satellite are named first: those two reasons are
    // what the relay's refusals read as.
    if (resolved.some((a) => a.endsWith("/servers/gateway/index.js"))) return { kind: "denied", reason: "gateway", ...base, pid };
    if (resolved.some((a) => a.includes("/servers/satellite/"))) return { kind: "denied", reason: "satellite", ...base, pid };
    // The wall's own processes: this relay, either helper it runs.
    if (opts.selfPids.has(pid)) return { kind: "denied", reason: "the wall's own process", ...base, pid };
    if (resolved.some((a) => baseName(a) === "pi_netns_entry.mjs")) return { kind: "denied", reason: "the wall's own process", ...base, pid };
    if (resolved.length && baseName(resolved[0]) === "bwrap") return { kind: "denied", reason: "the wall's own process", ...base, pid };
    // This Crow's own code, whichever way the path is spelled on the process.
    if (!opts.crowRoots.length) return { kind: "denied", reason: "no Crow roots to check against", ...base, pid };
    const exe = exeOf(pid, opts);
    const paths = [...resolved, cwd, exe];
    if (paths.some((p) => opts.crowRoots.some((root) => underRoot(p, root)))) {
      return { kind: "denied", reason: "Crow's own code", ...base, pid };
    }
    if (cwd === null || exe === null) return { kind: "denied", reason: "owner check failed", ...base, pid };
    return { kind: "own-uid", ...base, pid };
  }
  if (listener.uid === 0) {
    if (!opts.docker) return { kind: "denied", reason: "no docker view", ...base };
    const list = await opts.docker();
    const pubs = (Array.isArray(list) ? list : []).filter((e) => e
      && Number(e.hostPort) === listener.port
      && PUBLISHED_HOST_IPS.has(e.hostIp == null ? "" : String(e.hostIp)));
    if (!pubs.length) return { kind: "denied", reason: "no container publishes it", ...base };
    const projects = new Set(pubs.map((e) => (e.project == null ? "" : String(e.project).trim())));
    if (projects.size > 1) return { kind: "denied", reason: "published by more than one project", ...base };
    const project = [...projects][0];
    if (!project) return { kind: "denied", reason: "unlabelled project", ...base };
    if (!opts.addonProjects.has(project)) {
      return { kind: "denied", reason: "project of no installed add-on", ...base, project };
    }
    const owner = String(opts.addonProjects.get(project) ?? "");
    if (owner && owner === opts.addonId) return { kind: "docker-publish", project, projectOwner: owner, ...base };
    const exception = Object.prototype.hasOwnProperty.call(TTS_PORT_EXCEPTION, opts.addonId)
      ? TTS_PORT_EXCEPTION[opts.addonId]
      : null;
    if (owner && Array.isArray(exception) && exception.includes(owner)) {
      return { kind: "docker-publish", project, projectOwner: owner, ...base };
    }
    return { kind: "denied", reason: "foreign project", ...base, project };
  }
  return { kind: "denied", reason: "other uid", ...base };
}

/**
 * Who owns the listener answering `addr:port`?
 *
 * @param {string} addr  the loopback address the relay would connect to
 * @param {number} port
 * @param {object} [o]
 *   `gatewayUid`     the uid this Crow runs as (default `process.getuid()`)
 *   `addonId`        the add-on being walled
 *   `addonProjects`  Map of compose project -> add-on id, across instances
 *   `docker`         async () => [{ hostIp, hostPort, project }]
 *   `crowRoots`      absolute paths of this Crow's checkout and home (both
 *                    spellings); default: `CROW_APP_ROOT` and `CROW_HOME`.
 *                    Empty: no same-uid listener passes at all
 *   `selfPids`       pids of the wall's own processes (default `[process.pid]`)
 *   `readFile`, `readdir`, `readlink`  injected /proc readers (tests)
 * @returns {Promise<{kind: "own-uid"|"docker-publish"|"denied", reason?: string, uid?: number, pid?: number, project?: string, projectOwner?: string, inode?: string}>}
 */
export async function identifyListener(addr, port, o = {}) {
  const roots = (v) => {
    const out = [];
    for (const r of Array.isArray(v) ? v : [process.env.CROW_APP_ROOT, process.env.CROW_HOME]) {
      const c = cleanPath(r);
      if (c && !out.includes(c)) out.push(c);
    }
    return out;
  };
  const pids = (v) => new Set((Array.isArray(v) ? v : [process.pid]).map(Number).filter(Number.isInteger));
  const opts = {
    gatewayUid: Number.isInteger(o.gatewayUid) ? o.gatewayUid : (typeof process.getuid === "function" ? process.getuid() : null),
    addonId: o.addonId ?? null,
    addonProjects: o.addonProjects instanceof Map ? o.addonProjects : new Map(),
    docker: typeof o.docker === "function" ? o.docker : null,
    crowRoots: roots(o.crowRoots),
    selfPids: pids(o.selfPids),
    readFile: o.readFile || ((p) => readFileSync(p, "utf8")),
    readdir: o.readdir || ((p) => readdirSync(p)),
    readlink: o.readlink || ((p) => readlinkSync(p)),
  };
  try {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { kind: "denied", reason: "no port" };
    const want = new Set(wildcardOf(addr).map(canon));
    const found = [];
    const seen = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text = "";
      try { text = String(opts.readFile(file) || ""); } catch { text = ""; }
      for (const l of listenersIn(text)) {
        if (l.port !== p || !want.has(canon(l.addr))) continue;
        const key = l.addr + "|" + l.inode;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(l);
      }
    }
    if (!found.length) return { kind: "denied", reason: "nothing listens there" };
    const results = [];
    for (const l of found) {
      const v = await verdictFor(l, opts);
      if (!v || v.kind === "denied") return v || { kind: "denied", reason: "owner check failed" };
      results.push(v);
    }
    // Listeners of different kinds on one port (an own process on 127.0.0.1
    // and a container on 0.0.0.0): which one answers depends on the bind, so
    // neither answer is trusted.
    if (new Set(results.map((r) => r.kind)).size > 1) return { kind: "denied", reason: "more than one listener owner" };
    const published = results.filter((r) => r.kind === "docker-publish");
    if (published.length) {
      const projects = new Set(published.map((r) => r.project ?? null));
      if (projects.size > 1) return { kind: "denied", reason: "published by more than one project", uid: 0 };
      return published[0];
    }
    return results[0];
  } catch {
    return { kind: "denied", reason: "owner check failed" };
  }
}