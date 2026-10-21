/**
 * Isolation self-check (queue item 19, migration steps 0-1).
 *
 * Booleans-only probes of what this process can OPEN that belongs to another
 * instance or to the operator, so an operator hardening a unit (PrivateUsers=,
 * ProtectHome=, ...) can see the effect. Every probe opens and closes at once;
 * nothing here reads file or process contents, and nothing prints a value.
 *
 * Why /proc matters: two unsandboxed processes with the same uid can open
 * each other's /proc/<pid>/root (the other's whole filesystem view, past its
 * ProtectHome=) and /proc/<pid>/environ. Linux checks that access at open
 * time, so opening is the whole test. A unit with PrivateUsers=yes runs in
 * its own user namespace, where both opens fail with EACCES.
 */
import { closeSync, constants, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SECRET_NAME_RE } from "./bot-env.js";

/** True when `path` (file or directory) can be opened read-only by this process. */
export function canOpen(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

/** For each live pid: can this process open its /proc root and environ? */
export function probeForeignProc(pids) {
  const out = [];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!canOpen(`/proc/${pid}`)) continue; // gone, or hidden
    out.push({ pid, root: canOpen(`/proc/${pid}/root/`), environ: canOpen(`/proc/${pid}/environ`) });
  }
  return out;
}

const ROOT_EQUIVALENT_GROUPS = ["docker", "sudo", "wheel", "lxd", "libvirt", "incus-admin"];

function groupNames() {
  let lines = [];
  try { lines = readFileSync("/etc/group", "utf8").split("\n"); } catch { return []; }
  const mine = new Set(typeof process.getgroups === "function" ? process.getgroups() : []);
  const names = [];
  for (const l of lines) {
    const [name, , gid] = l.split(":");
    if (name && mine.has(Number(gid))) names.push(name);
  }
  return names;
}

/** no_new_privs, user-namespace kind and root-equivalent group membership. */
export function processFacts() {
  let noNewPrivs = false;
  try { noNewPrivs = /^NoNewPrivs:\s*1\s*$/m.test(readFileSync("/proc/self/status", "utf8")); } catch {}
  // The initial user namespace maps the whole uid range onto itself.
  let userNamespace = "init";
  try {
    const map = readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/);
    if (!(map[0] === "0" && map[1] === "0" && map[2] === "4294967295")) userNamespace = "private";
  } catch {}
  const groups = groupNames();
  return { noNewPrivs, userNamespace, rootEquivalentGroups: ROOT_EQUIVALENT_GROUPS.filter((g) => groups.includes(g)) };
}

/** Secret-like variable NAMES in a `systemctl show -p Environment --value` string. */
export function secretEnvNames(showOutput) {
  const names = [];
  for (const m of String(showOutput || "").matchAll(/(?:^|[\s"])([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    const k = m[1];
    if (/_PATH$|_FILE$|_DIR$|_URL$/.test(k)) continue; // a location, not a secret
    if (SECRET_NAME_RE.test(k) && !names.includes(k)) names.push(k);
  }
  return names;
}

/** pids whose command line runs a Crow gateway or bot runner (other than this process). */
export function crowProcessPids() {
  const pids = [];
  let entries = [];
  try { entries = readdirSync("/proc"); } catch { return pids; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (pid === process.pid) continue;
    let cmd = "";
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    if (/servers\/gateway\/index\.js|gateways\/gateway_runner\.mjs/.test(cmd)) pids.push(pid);
  }
  return pids;
}

/**
 * The full report. `sensitivePaths` are absolute paths that should NOT be
 * openable from a hardened instance (other instance homes, the operator's
 * key and assistant-config dirs); the caller decides the list.
 */
export function isolationReport({ sensitivePaths = [], pids = crowProcessPids() } = {}) {
  return {
    sensitiveOpenable: sensitivePaths.filter((p) => canOpen(p)),
    foreignProc: probeForeignProc(pids),
    facts: processFacts(),
  };
}

export function formatIsolationLine(r) {
  const yes = (b) => (b ? "yes" : "no");
  const anyRoot = r.foreignProc.some((p) => p.root);
  const anyEnv = r.foreignProc.some((p) => p.environ);
  return "[isolation] " + [
    `sensitive paths openable: ${r.sensitiveOpenable.length}` + (r.sensitiveOpenable.length ? ` (${r.sensitiveOpenable.join(", ")})` : ""),
    `foreign /proc root openable: ${r.foreignProc.length ? yes(anyRoot) : "n/a"}`,
    `foreign /proc environ openable: ${r.foreignProc.length ? yes(anyEnv) : "n/a"}`,
    `user namespace: ${r.facts.userNamespace}`,
    `no_new_privs: ${yes(r.facts.noNewPrivs)}`,
    `root-equivalent groups: ${r.facts.rootEquivalentGroups.join(",") || "none"}`,
  ].join("; ");
}

function looksLikeInstanceHome(p) {
  try { if (!statSync(p).isDirectory()) return false; } catch { return false; }
  for (const marker of ["installed.json", "mcp-addons.json", "data"]) {
    try { statSync(join(p, marker)); return true; } catch {}
  }
  return false;
}

/** Default sensitive paths: the other ~/.crow* homes, ~/.ssh, ~/.gnupg. */
export function defaultSensitivePaths({ home = homedir(), crowHome = process.env.CROW_HOME || join(homedir(), ".crow") } = {}) {
  const own = resolve(crowHome);
  const parent = dirname(own);
  const paths = [];
  try {
    for (const e of readdirSync(parent)) {
      const p = join(parent, e);
      // An instance home, not any dir that starts with .crow (backups, flags).
      if (/^\.crow(-|$)/.test(e) && p !== own && looksLikeInstanceHome(p)) paths.push(p);
    }
  } catch {}
  for (const d of [".ssh", ".gnupg"]) paths.push(join(home, d));
  return [...new Set(paths)];
}
