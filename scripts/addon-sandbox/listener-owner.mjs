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
 *   2. a socket owned by the gateway uid is mapped to EVERY process holding it
 *      through `/proc/<pid>/fd` (`socket:[<inode>]`) — a socket can be shared
 *      after fork, so each holder is judged and any refusal is the answer. A
 *      gateway or satellite node process — in any checkout, so a co-hosted
 *      instance is caught too — is refused, and so is an inode that maps to no
 *      process. Any other process of this uid counts as the add-on's own
 *      service only if it is none of the wall's own processes (this relay, a
 *      `pi_netns_entry.mjs` helper, `bwrap`) and nothing about it — an argv
 *      element, its cwd, its executable — lies under this Crow's checkout or
 *      home (`crowRoots`): with no root to compare against, every same-uid
 *      listener is refused. A process whose argv or cwd cannot be read is
 *      refused before anything else: what it is cannot be judged;
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
import { networkInterfaces } from "node:os";

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

/**
 * The shape an owner value must have before it is compared with an add-on id:
 * one lowercase slug. A map that carries anything else (a placeholder, an
 * empty string, a path-shaped value) names no owner, so no comparison passes.
 */
const OWNER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `owner` may only be read as `addonId` when both are exactly one slug. */
function ownerIsAddon(owner, addonId) {
  return typeof owner === "string" && typeof addonId === "string"
    && OWNER_ID_RE.test(owner) && OWNER_ID_RE.test(addonId) && owner === addonId;
}

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

/**
 * Every pid holding a socket inode, from `/proc/<pid>/fd` links; empty when
 * unmapped. A socket can be shared after a fork (and a process can hold it on
 * more than one fd), so all of them are returned, not the first one found.
 */
function pidsForInode(inode, opts) {
  const out = [];
  let pids;
  try { pids = opts.readdir("/proc"); } catch { return out; }
  for (const name of pids || []) {
    if (!/^\d+$/.test(String(name))) continue;
    let fds;
    try { fds = opts.readdir("/proc/" + name + "/fd"); } catch { continue; }
    const pid = Number(name);
    for (const fd of fds || []) {
      let target = "";
      try { target = String(opts.readlink("/proc/" + name + "/fd/" + fd)); } catch { continue; }
      if (target !== "socket:[" + inode + "]") continue;
      if (!out.includes(pid)) out.push(pid);
      break; // one fd per process is enough
    }
  }
  return out;
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
    // A deleted target reads as "<path> (deleted)", which no root comparison
    // would match: treated as unreadable, so the process is refused.
    return t === "" || t.endsWith(" (deleted)") ? null : t;
  } catch { return null; }
}

/** The process's executable; null when unreadable. */
function exeOf(pid, opts) {
  try {
    const t = String(opts.readlink("/proc/" + pid + "/exe") ?? "");
    // A deleted target reads as "<path> (deleted)", which no root comparison
    // would match: treated as unreadable, so the process is refused.
    return t === "" || t.endsWith(" (deleted)") ? null : t;
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

/**
 * Is this argv element the gateway's entry point? A file below `/servers/gateway/`
 * (whatever it is named) and the directory form (`node /srv/crow/servers/gateway`)
 * both are.
 */
function isGatewayArg(p) {
  if (typeof p !== "string" || !p) return false;
  return p.includes("/servers/gateway/") || p.endsWith("/servers/gateway");
}

/**
 * The verdict for ONE same-uid process holding the socket. Every problem is a
 * `denied` result, never a pass.
 */
function sameUidVerdict(pid, opts, base) {
  const denied = (reason) => ({ kind: "denied", reason, ...base, pid });
  const argv = argvOf(pid, opts);
  // No argv at all (unreadable, or an empty cmdline) says nothing about what
  // this process is: refused before any rule that would otherwise pass it.
  if (!argv.length) return denied("owner check failed");
  const cwd = cwdOf(pid, opts);
  const cwdPrefix = cwd === null ? null : cwd.replace(/\/+$/, "");
  // A relative argv element cannot be resolved without the cwd, so a gateway
  // named relatively (`node servers/gateway/index.js`) would slip past the
  // gateway check: refused before that check and the satellite one.
  if (cwdPrefix === null && argv.slice(1).some((a) => !a.startsWith("/"))) return denied("owner check failed");
  const resolved = argv.map((a, i) => (i === 0 || a.startsWith("/") || cwdPrefix === null ? a : cwdPrefix + "/" + a));
  // The gateway and its satellite are named first: those two reasons are what
  // the relay's refusals read as.
  if (resolved.some(isGatewayArg)) return denied("gateway");
  if (resolved.some((a) => a.includes("/servers/satellite/") || a.endsWith("/servers/satellite"))) return denied("satellite");
  // The wall's own processes: this relay, either helper it runs.
  if (opts.selfPids.has(pid)) return denied("the wall's own process");
  if (resolved.some((a) => baseName(a) === "pi_netns_entry.mjs")) return denied("the wall's own process");
  if (baseName(resolved[0]) === "bwrap") return denied("the wall's own process");
  // This Crow's own code, whichever way the path is spelled on the process.
  if (!opts.crowRoots.length) return denied("no Crow roots to check against");
  const exe = exeOf(pid, opts);
  const paths = [...resolved, cwd, exe];
  if (paths.some((p) => opts.crowRoots.some((root) => underRoot(p, root)))) return denied("Crow's own code");
  if (cwd === null || exe === null) return denied("owner check failed");
  return { kind: "own-uid", ...base, pid };
}

/** One listener's verdict. Every problem is a `denied` result, never a pass. */
async function verdictFor(listener, opts) {
  const base = { uid: listener.uid, inode: listener.inode };
  if (listener.uid === opts.gatewayUid) {
    const pids = pidsForInode(listener.inode, opts);
    if (!pids.length) return { kind: "denied", reason: "unmapped", ...base };
    const verdicts = pids.map((pid) => sameUidVerdict(pid, opts, base));
    // A socket shared by several processes is only as safe as the least safe
    // holder: any refusal is the listener's answer.
    return verdicts.find((v) => v.kind === "denied") || verdicts[0];
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
    if (ownerIsAddon(owner, opts.addonId)) return { kind: "docker-publish", project, projectOwner: owner, ...base };
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
      try { text = String(opts.readFile(file) || ""); } catch (e) {
        // A table the kernel does not have is a family with no listener. Any
        // other failure could hide the very listener this check exists to
        // find (an IPv6 one, for tcp6), so it is refused.
        if (e && e.code === "ENOENT") continue;
        return { kind: "denied", reason: "owner check failed" };
      }
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

// ---- container addresses --------------------------------------------------
//
// A listed host:port may resolve to a container of an add-on's own compose
// project rather than to a loopback port, and the same project rules decide
// whether that container may be reached: this add-on's own project, or the one
// named TTS exception for `media`. The bridge ranges and the container
// addresses come from this computer, so an address inside one of them is only
// reachable through a container whose working_dir is an installed add-on's
// bundle folder.

/** The bridge interfaces docker, podman and the CNI plugin create. */
const BRIDGE_IFACE_RE = /^(docker\d*|br-[0-9a-f]{6,}|podman\d*|cni-podman\d*)$/;

/** Eight 16-bit groups of an IPv6 spelling, or null. */
function groups6(a) {
  let s = String(a ?? "").trim().replace(/^\[(.*)\]$/, "$1").split("%")[0].toLowerCase();
  if (!s) return null;
  if (s.includes(".")) {
    // A trailing dotted quad is the last two groups.
    const cut = s.lastIndexOf(":");
    if (cut < 0) return null;
    const q = s.slice(cut + 1).split(".");
    if (q.length !== 4 || q.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    const hi = ((Number(q[0]) << 8) | Number(q[1])).toString(16);
    const lo = ((Number(q[2]) << 8) | Number(q[3])).toString(16);
    s = s.slice(0, cut + 1) + hi + ":" + lo;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  for (const g of [...head, ...tail]) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...Array(fill).fill("0"), ...tail].map((x) => parseInt(x, 16));
  }
  if (head.length !== 8) return null;
  return head.map((x) => parseInt(x, 16));
}

const big6 = (g) => g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n);

/** An address as one comparison sees it: a family, and its value in that family (v4-mapped read as IPv4). */
function addrParts(a) {
  const s = canon(a);
  if (!s) return null;
  const fam = isIP(s);
  if (fam === 4) return { fam: 4, v4: s };
  if (fam !== 6) return null;
  const g = groups6(s);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return { fam: 4, v4: [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".") };
  }
  return { fam: 6, g };
}

/** One spelling of an address for equality (a v4-mapped form compares as its IPv4). */
function addrKey(a) {
  const p = addrParts(a);
  if (!p) return null;
  return p.fam === 4 ? "v4:" + p.v4 : "v6:" + format6(p.g);
}

/** The high `plen` bits of an IPv4 address, as an integer. */
function head4(a, plen) {
  if (plen <= 0) return 0;
  const n = a.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  return Math.floor(n / 2 ** (32 - plen));
}

/** An IPv6 group list with everything past `plen` cleared. */
function net6(g, plen) {
  if (plen <= 0) return [0, 0, 0, 0, 0, 0, 0, 0];
  const keep = BigInt(128 - plen);
  const v = (big6(g) >> keep) << keep;
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => Number((v >> BigInt(112 - i * 16)) & 0xffffn));
}

/** A netmask as a prefix length, or null when its bits are not a run of ones then zeros. */
function prefixFromMask(mask) {
  const p = addrParts(mask);
  if (!p) return null;
  const bits = p.fam === 4
    ? p.v4.split(".").map((o) => Number(o).toString(2).padStart(8, "0")).join("")
    : p.g.map((x) => x.toString(2).padStart(16, "0")).join("");
  if (!/^1*0*$/.test(bits)) return null;
  const zero = bits.indexOf("0");
  return zero < 0 ? bits.length : zero;
}

/** The network `addr/plen` names, as a CIDR string, or null. */
function cidrOf(parts, plen) {
  if (!parts) return null;
  if (parts.fam === 4) {
    if (!(plen >= 0 && plen <= 32)) return null;
    const size = 2 ** (32 - plen);
    const base = Math.floor(parts.v4.split(".").reduce((acc, o) => acc * 256 + Number(o), 0) / size) * size;
    return [base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join(".") + "/" + plen;
  }
  if (!(plen >= 0 && plen <= 128)) return null;
  return format6(net6(parts.g, plen)) + "/" + plen;
}

/** One interface entry as a CIDR: its `cidr` field, else its address and netmask. */
function interfaceCidr(entry) {
  if (!entry || typeof entry !== "object") return null;
  let addr = entry.address;
  let plen = null;
  const cidr = typeof entry.cidr === "string" ? entry.cidr.trim() : "";
  if (cidr) {
    const p = cidr.split("/");
    if (p.length === 2 && /^\d{1,3}$/.test(p[1])) { addr = p[0]; plen = Number(p[1]); }
  }
  if (plen === null) {
    if (typeof entry.netmask !== "string") return null;
    plen = prefixFromMask(entry.netmask);
    if (plen === null) return null;
  }
  return cidrOf(addrParts(addr), plen);
}

/**
 * The CIDR of every docker/podman bridge interface on this computer
 * (`docker0`, `docker_gwbridge`, `br-<id>`, `podman0`, `cni-podman0`), IPv4 and
 * IPv6. Pure: o is an `os.networkInterfaces()`-shaped object.
 *
 * @param {object} [ifaces]
 * @returns {string[]}
 */
export function bridgeSubnetsFromInterfaces(ifaces = networkInterfaces()) {
  const out = [];
  const table = ifaces && typeof ifaces === "object" ? ifaces : {};
  for (const name of Object.keys(table)) {
    if (!BRIDGE_IFACE_RE.test(name)) continue;
    const list = table[name];
    for (const entry of Array.isArray(list) ? list : []) {
      const c = interfaceCidr(entry);
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/**
 * The interfaces carrying a default route, from the two kernel route tables.
 * `/proc/net/route` (IPv4): a row whose Destination is `00000000`. Its columns
 * are Iface Destination Gateway Flags RefCnt Use Metric Mask …; `/proc/net/route`
 * is an empty set when the text is absent, unreadable or shapeless.
 */
function defaultV4Ifaces(text) {
  const out = new Set();
  for (const line of String(text || "").split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8) continue;
    if (!/^0{8}$/i.test(c[1])) continue;
    out.add(c[0]);
  }
  return out;
}

/**
 * The interfaces carrying a default route, from `/proc/net/ipv6_route`: headerless
 * rows of dest (32 hex) destPrefix (2 hex) src srcPrefix nextHop metric refcnt use
 * flags iface, where a default route has an all-zero destination and prefix "00".
 */
function defaultV6Ifaces(text) {
  const out = new Set();
  for (const line of String(text || "").split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    if (!/^0{32}$/i.test(c[0]) || !/^0{2}$/i.test(c[1])) continue;
    out.add(c[9]);
  }
  return out;
}

/**
 * The CIDRs of every local interface that cannot be a way off this computer:
 * all of them but `lo` and the interface(s) a default route leaves through.
 *
 * With no docker view this stands in for "the docker and podman bridges": a
 * custom-named bridge (`mybr0`) is a bridge range like any other, a LAN
 * interface carrying the default route is not, and loopback never is. A route
 * table that cannot be read (`routes` missing, or a text that is empty) leaves
 * no default-route interface known, so every non-loopback subnet counts: an
 * address there is refused unless a container of this add-on's own project
 * holds it, which is the narrow answer, never the wide one.
 *
 * Pure: `routes` is `{ v4, v6 }` texts, as `/proc/net/route` and
 * `/proc/net/ipv6_route` hold them.
 *
 * @param {object} [ifaces]  an `os.networkInterfaces()`-shaped object
 * @param {{v4?: string, v6?: string}} [routes]
 * @returns {string[]}
 */
export function localOnlySubnets(ifaces = networkInterfaces(), routes = {}) {
  const out = [];
  const table = ifaces && typeof ifaces === "object" ? ifaces : {};
  const r = routes && typeof routes === "object" ? routes : {};
  const defaults = new Set([...defaultV4Ifaces(r.v4), ...defaultV6Ifaces(r.v6)]);
  for (const name of Object.keys(table)) {
    if (name === "lo" || defaults.has(name)) continue;
    const list = table[name];
    for (const entry of Array.isArray(list) ? list : []) {
      const c = interfaceCidr(entry);
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/**
 * Is `addr` inside `cidr`? IPv4 and IPv6, a v4-mapped spelling read as the
 * IPv4 it carries. False on anything unparsable. Pure.
 *
 * @param {string} addr
 * @param {string} cidr
 * @returns {boolean}
 */
export function addrInCidr(addr, cidr) {
  try {
    const a = addrParts(addr);
    if (!a) return false;
    const parts = String(cidr ?? "").trim().split("/");
    if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1])) return false;
    const plen = Number(parts[1]);
    const b = addrParts(parts[0]);
    if (!b || a.fam !== b.fam) return false;
    if (a.fam === 4) return plen <= 32 && head4(a.v4, plen) === head4(b.v4, plen);
    if (plen > 128) return false;
    if (plen === 0) return true;
    const shift = BigInt(128 - plen);
    return (big6(a.g) >> shift) === (big6(b.g) >> shift);
  } catch {
    return false;
  }
}

/**
 * Who may be reached at a resolved address that belongs to a container on this
 * computer?
 *
 * An address inside a docker/podman bridge range, or the address of a running
 * container, may only be reached through this add-on's own compose project —
 * or, for `media`, a TTS add-on's project (the one named exception). Every
 * other answer is a refusal: a foreign project, a project of no installed
 * add-on (which covers a containerized Crow gateway, whose working dir is not
 * an add-on folder), an unlabelled project, more than one project at the
 * address, a bridge address no container holds, and an unreadable docker view.
 *
 * @param {string} addr
 * @param {object} o
 *   `addonId`         the add-on being walled
 *   `view`            a docker-view snapshot, or null when the read failed
 *   `bridgeSubnets`   CIDR strings of this computer's bridge interfaces
 * @returns {{kind: "not-container"|"docker-container"|"denied", reason?: string, project?: string, projectOwner?: string}}
 */
export function identifyContainerAddr(addr, o = {}) {
  try {
    const key = addrKey(addr);
    if (!key) return { kind: "denied", reason: "owner check failed" };
    const view = o.view && typeof o.view === "object" ? o.view : null;
    const subnets = [
      ...(Array.isArray(o.bridgeSubnets) ? o.bridgeSubnets : []),
      ...(view && Array.isArray(view.subnets) ? view.subnets : []),
    ];
    const inBridge = subnets.some((c) => addrInCidr(addr, c));
    const all = view && Array.isArray(view.containers) ? view.containers : [];
    const holders = all.filter((c) => c && Array.isArray(c.ips) && c.ips.some((ip) => addrKey(ip) === key));
    if (!inBridge && !holders.length) return { kind: "not-container" };
    if (!view) return { kind: "denied", reason: "owner check failed" };
    if (!holders.length) return { kind: "denied", reason: "no container has that address" };
    const projects = new Set(holders.map((c) => String(c.project ?? "").trim()));
    if (projects.size > 1) return { kind: "denied", reason: "more than one project at that address" };
    const project = [...projects][0];
    if (!project) return { kind: "denied", reason: "unlabelled project" };
    const map = view.addonProjects instanceof Map ? view.addonProjects : new Map();
    if (!map.has(project)) return { kind: "denied", reason: "project of no installed add-on", project };
    const owner = String(map.get(project) ?? "");
    if (ownerIsAddon(owner, o.addonId)) return { kind: "docker-container", project, projectOwner: owner };
    const exception = Object.prototype.hasOwnProperty.call(TTS_PORT_EXCEPTION, o.addonId)
      ? TTS_PORT_EXCEPTION[o.addonId]
      : null;
    if (owner && Array.isArray(exception) && exception.includes(owner)) {
      return { kind: "docker-container", project, projectOwner: owner };
    }
    return { kind: "denied", reason: "foreign project", project };
  } catch {
    return { kind: "denied", reason: "owner check failed" };
  }
}