/**
 * S3 (2026-10-02): run pi children without the gateway's docker access.
 *
 * Why: pi children run as the gateway's uid with the gateway's groups. On
 * crow that user is in the `docker` group (crow-gateway.service also says
 * SupplementaryGroups=docker), and `docker run -v /:/host` is root. A bot with
 * an open shell (or an allowlisted python/uv) is therefore root-equivalent,
 * which also defeats the in-memory actor key (actor-sig.mjs). The same user is
 * in `sudo`, so a child that finds the password can escalate too.
 *
 * What does NOT work unprivileged (verified on crow, util-linux 2.39.3):
 *  - `setpriv --clear-groups` / `--groups`: setgroups(2) needs CAP_SETGID
 *    ("setgroups failed: Operation not permitted").
 *  - Node's spawn `uid`/`gid`: same syscall, same refusal.
 *  - a bare user namespace (`unshare -U`): the unmapped groups show up as
 *    65534 but the kernel still counts them for access checks, so the docker
 *    socket stays reachable.
 *  The real fixes (a dedicated unprivileged user, or granting the gateway
 *  CAP_SETGID) need root to set up, which is an operator decision.
 *
 * What this does instead, with no privilege: when bubblewrap is usable, pi is
 * spawned as
 *     bwrap --dev-bind / / --unshare-user --ro-bind /dev/null <docker.sock> -- node cli.js ...
 *  - the docker socket path is replaced by /dev/null inside the child's mount
 *    namespace. The mount is locked (made in a less-privileged userns from
 *    the child's view), so the child cannot unmount it;
 *  - the child is in its own user namespace, so the /proc/<pid>/root and
 *    /proc/<pid>/environ of processes outside it are refused (the kernel's
 *    ptrace check needs CAP_SYS_PTRACE in the target's namespace). That closes
 *    the "reach the socket through the gateway's /proc/<pid>/root" path;
 *  - bubblewrap always sets no_new_privs, so sudo and other setuid binaries
 *    cannot raise privilege in the child;
 *  - everything else is unchanged: same filesystem (read-write), network,
 *    uid, cwd, env, process group. `id -G` shows the docker gid as 65534
 *    (nogroup). It is still in the credential, but the one object it opens is
 *    masked.
 *
 * Modes (CROW_PI_SANDBOX): "auto" (default) wraps when bwrap is usable and
 * otherwise spawns as before with a one-time warning; "required" refuses to
 * spawn pi without the sandbox; "off" never wraps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];

let probeCache = null; // { ok, bwrap, reason }
let warned = false;

/** Test seam only. */
export function _resetPiSandboxForTest() { probeCache = null; warned = false; }

export function piSandboxMode(env = process.env) {
  const v = String(env.CROW_PI_SANDBOX || "auto").trim().toLowerCase();
  return v === "off" || v === "required" ? v : "auto";
}

function isSocket(p) {
  try { return statSync(p).isSocket(); } catch { return false; }
}

/**
 * Docker API sockets reachable on this host, as real paths (so /var/run ->
 * /run duplicates collapse). DOCKER_HOST=unix://..., the system sockets, and a
 * rootless daemon's socket in XDG_RUNTIME_DIR.
 */
export function dockerSocketPaths(env = process.env) {
  const cands = ["/run/docker.sock", "/var/run/docker.sock"];
  const dh = String(env.DOCKER_HOST || "");
  if (dh.startsWith("unix://")) cands.unshift(dh.slice("unix://".length));
  if (env.XDG_RUNTIME_DIR) cands.push(env.XDG_RUNTIME_DIR + "/docker.sock");
  const out = [];
  for (const c of cands) {
    if (!c || !isSocket(c)) continue;
    let r = c;
    try { r = realpathSync(c); } catch {}
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** Can this process start a bubblewrap user-namespace sandbox? Cached. */
export function probePiSandbox(opts = {}) {
  if (probeCache && !opts.force) return probeCache;
  const bwrap = opts.bwrap || BWRAP_CANDIDATES.find((p) => existsSync(p)) || null;
  if (!bwrap) {
    probeCache = { ok: false, bwrap: null, reason: "bubblewrap (bwrap) is not installed" };
    return probeCache;
  }
  const r = spawnSync(bwrap, ["--dev-bind", "/", "/", "--unshare-user", "--", "/bin/true"],
    { timeout: 5000, stdio: ["ignore", "ignore", "pipe"] });
  probeCache = r.status === 0
    ? { ok: true, bwrap, reason: null }
    : { ok: false, bwrap, reason: "bwrap cannot create a user namespace here: " +
        String((r.stderr && r.stderr.toString().trim()) || (r.error && r.error.message) || ("exit " + r.status)).slice(0, 200) };
  return probeCache;
}

/**
 * The command line to spawn pi with.
 * @returns {{cmd:string, args:string[], sandboxed:boolean, reason:string|null, masked:string[]}}
 * @throws when mode is "required" and the sandbox is unavailable.
 */
export function wrapPiSpawn(cmd, args, opts = {}) {
  const env = opts.env || process.env;
  const mode = opts.mode || piSandboxMode(env);
  const plain = (reason) => ({ cmd, args, sandboxed: false, reason, masked: [] });
  if (mode === "off") return plain("CROW_PI_SANDBOX=off");
  const probe = opts.probe || probePiSandbox();
  if (!probe.ok) {
    if (mode === "required") {
      throw new Error("pi sandbox required (CROW_PI_SANDBOX=required) but unavailable: " + probe.reason);
    }
    if (!warned) {
      warned = true;
      console.error("[pi-sandbox] WARNING: pi children run WITHOUT the sandbox (" + probe.reason +
        "). They keep this process's groups (docker, if present) and can use sudo.");
    }
    return plain(probe.reason);
  }
  const masked = opts.sockets || dockerSocketPaths(env);
  const pre = ["--dev-bind", "/", "/", "--unshare-user"];
  for (const s of masked) pre.push("--ro-bind", "/dev/null", s);
  if (opts.infoFd != null) pre.push("--info-fd", String(opts.infoFd));
  return { cmd: probe.bwrap, args: [...pre, "--", cmd, ...args], sandboxed: true, reason: null, masked };
}

/** True when a ps `args` string is a bubblewrap wrapper (used by the reaper). */
export function isSandboxWrapperArgs(argsStr) {
  const first = String(argsStr || "").trim().split(/\s+/)[0] || "";
  return basename(first) === "bwrap";
}
