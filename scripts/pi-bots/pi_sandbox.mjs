/**
 * S3 (2026-10-02): defense in depth for pi children. It removes the CASUAL
 * routes from a bot's shell to docker and sudo. It is NOT a containment
 * boundary (see "What it does not stop" below).
 *
 * Why: pi children run as the gateway's uid with the gateway's groups. On
 * crow that user is in the `docker` group, and `docker run -v /:/host` is root.
 * The same user is in `sudo`, and the password sits in files the uid can read.
 *
 * What does NOT work unprivileged (verified on crow, util-linux 2.39.3):
 *  - `setpriv --clear-groups` / `--groups`: setgroups(2) needs CAP_SETGID.
 *  - Node's spawn `uid`/`gid`: same syscall, same refusal.
 *  - a bare user namespace (`unshare -U`): unmapped groups show up as 65534
 *    but still count for access checks, so the docker socket stays reachable.
 *  A real boundary needs a dedicated unprivileged bot user (root to set up).
 *  That is an operator decision, not made here.
 *
 * What this does, with no privilege, when bubblewrap is usable:
 *     bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc
 *           --ro-bind /dev/null <docker.sock>...          docker API
 *           --tmpfs /run/user                             user bus, systemd
 *                                                         user manager, gnupg,
 *                                                         keyring, pipewire,
 *                                                         pulse, pk-debconf
 *           --tmpfs /tmp/tmux-<uid>, /tmp/cc-daemon-<uid> (always),
 *                   /tmp/.X11-unix (when present)
 *           --ro-bind ~/.config/systemd ~/.config/systemd   user units not
 *           --ro-bind ~/.local/share/systemd ...            directly writable
 *           --info-fd 3 -- node cli.js ...
 *  and the child env loses DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR,
 *  SSH_AUTH_SOCK, TMUX, TMUX_PANE, DISPLAY, WAYLAND_DISPLAY and every *_SOCK,
 *  *_SOCKET and *_SOCKET_PATH.
 *  - The masks are locked mounts: the child cannot unmount them, even from a
 *    nested user namespace (verified).
 *  - Its own PID namespace with a fresh /proc (--unshare-pid --proc /proc;
 *    not --die-with-parent, see BWRAP_BASE): no host process is even
 *    visible, so the gateway's and other bots' /proc/<pid>/{root,environ,mem}
 *    do not exist inside, and a same-uid host process cannot be signalled
 *    (kill -0 fails, ESRCH). This is structural, not a ptrace-policy outcome
 *    (in its own user namespace those reads were already refused). The
 *    parent side keeps using outer PIDs: proc.pid is the outer bwrap, bwrap's
 *    --info-fd child-pid is the namespace's init (an inner bwrap, kept as
 *    PiRpc.sandboxInitPid) and PiRpc resolves pi's outer pid as that init's
 *    child; the process-group kill and the reaper (which folds nested
 *    wrappers) work on outer PIDs.
 *  - Where bwrap can make a user namespace but not a PID namespace or a fresh
 *    /proc, the user-namespace-only tier (BWRAP_BASE_NO_PIDNS) runs instead,
 *    with a one-time warning; it is re-probed, so a transient failure does
 *    not pin it.
 *  - bubblewrap sets no_new_privs, so sudo and setuid/setgid binaries
 *    (crontab, at, pkexec) cannot raise privilege.
 *  - uid, network, cwd and the rest of the filesystem (read-write) are
 *    unchanged. Inside, files owned by other uids/gids show as nobody/nogroup.
 *
 * What it does not stop (known escape routes, all need a dedicated user):
 *  - the writable filesystem: ~/.bashrc and other rc files, ~/crow (the
 *    gateway's own source, run on the next restart/auto-update), autostart
 *    entries, ~/.ssh/authorized_keys, any script a privileged process runs;
 *  - `ssh localhost` (or another lab host) with a readable private key in
 *    ~/.ssh, which gives an unsandboxed shell;
 *  - abstract unix sockets (no network namespace), e.g. @/tmp/.X11-unix/X*;
 *  - the user-unit dirs are only not DIRECTLY writable: renaming an ancestor
 *    (mv ~/.config ~/.config.x; mkdir -p ~/.config/systemd/user) moves the
 *    read-only mount away and a unit dropped in the fresh dir loads at the
 *    next reload or boot (same persistence class as rc files);
 *  - the system D-Bus (/run/dbus/system_bus_socket): reachable; privileged
 *    methods are polkit-gated and the setuid polkit helper cannot run under
 *    no_new_privs, so no escalation was found, but it stays open;
 *  - reading anything the uid can read (crow.db, tokens, ~/.claude) - S6.
 *
 * Without bubblewrap (e.g. black-swan), the fallback is
 * `setpriv --no-new-privs`: no masks, but sudo/setuid are still blocked.
 *
 * Contain tier (opt-in, queue item 19 step 2a): pi_contain.mjs. With
 * CROW_PI_SANDBOX=contain (every pi) or CROW_PI_CONTAIN_BOTS=<id,...> (listed
 * bots) a bot spawn gets an EMPTY root with only its engine, its own paths
 * and its instance data bound, instead of the whole host filesystem.
 *
 * Modes, from the GATEWAY's env only (process.env; a bot def's spawn_env
 * cannot change it): CROW_PI_SANDBOX = "auto" (default: bwrap, else the
 * setpriv fallback, else plain, with a one-time warning), "required" (refuse
 * to spawn pi without bwrap), "off" (never wrap).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { containSelected, buildContainPlan } from "./pi_contain.mjs";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
const SETPRIV_CANDIDATES = ["/usr/bin/setpriv", "/bin/setpriv"];
export const PROBE_RETRY_MS = 5 * 60 * 1000;
/** Every sandboxed pi: own user + PID namespace, fresh /proc. The probe uses
 *  the same flags, so tier "pidns" means all of them work. NOT
 *  --die-with-parent: close()'s group SIGTERM ends the outer bwrap at once,
 *  and PDEATHSIG would then SIGKILL the namespace init, so pi's SIGTERM drain
 *  and MCP shutdown would never run. A wrapper orphaned by a dead gateway is
 *  caught by the reaper's orphan rule (ppid 1). */
export const BWRAP_BASE = Object.freeze(["--dev-bind", "/", "/", "--unshare-user", "--unshare-pid", "--proc", "/proc"]);
/** Second tier, for hosts where bwrap can make a user namespace but not a PID
 *  namespace or a fresh /proc: the pre-PID-namespace sandbox (tier "userns",
 *  status "active-no-pidns"). */
export const BWRAP_BASE_NO_PIDNS = Object.freeze(["--dev-bind", "/", "/", "--unshare-user"]);

let probeCache = null; // { ok, pidns, bwrap, setpriv, reason, pidnsReason, at }
let warnedFor = null;
let warnedNoPidns = false;

/** Test seam only. */
export function _resetPiSandboxForTest() { probeCache = null; warnedFor = null; warnedNoPidns = false; }

export function piSandboxMode(env = process.env) {
  const v = String(env.CROW_PI_SANDBOX || "auto").trim().toLowerCase();
  return v === "off" || v === "required" || v === "contain" ? v : "auto";
}

function isSocket(p) {
  try { return statSync(p).isSocket(); } catch { return false; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}


/**
 * Docker API sockets reachable on this host, as real paths (so /var/run ->
 * /run duplicates collapse). DOCKER_HOST=unix://..., the system sockets, and a
 * rootless daemon's socket in XDG_RUNTIME_DIR (covered by the /run/user tmpfs
 * too).
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

/**
 * Per-user IPC directories to hide behind an empty tmpfs. N2: masked whether
 * or not the service is running at spawn time, so a session (a long-lived
 * Perch child) cannot reach a tmux server or Claude Code daemon started later.
 *  - /run/user as a whole (when it exists): covers /run/user/<uid> even if the
 *    user manager starts after the spawn. Nothing under it is a bot's business.
 *  - /tmp/tmux-<uid> and /tmp/cc-daemon-<uid>: created on the host first
 *    (mode 0700, the shape tmux and Claude Code create themselves) so the
 *    mount point exists and a bot cannot pre-create them for a later server.
 *  - /tmp/.X11-unix only when present: it must be root-owned for X servers,
 *    so it is never created here, and X is reachable through abstract sockets
 *    anyway (a documented remaining route).
 */
export function userRuntimeDirs(uid = process.getuid(), { create = true } = {}) {
  const out = [];
  if (isDir("/run/user")) out.push("/run/user");
  for (const d of [`/tmp/tmux-${uid}`, `/tmp/cc-daemon-${uid}`]) {
    if (!isDir(d) && create) { try { mkdirSync(d, { mode: 0o700 }); } catch {} }
    if (isDir(d)) out.push(d);
  }
  if (isDir("/tmp/.X11-unix")) out.push("/tmp/.X11-unix");
  return out;
}

/** Dirs the systemd user manager loads units from, made read-only inside.
 *  Created (empty) when missing so a bot cannot create them itself. */
export function systemdUserUnitDirs(home = homedir(), { create = true } = {}) {
  const dirs = [join(home, ".config", "systemd"), join(home, ".local", "share", "systemd")];
  const out = [];
  for (const d of dirs) {
    if (!isDir(d) && create) { try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {} }
    if (isDir(d)) out.push(d);
  }
  return out;
}

const SCRUB_EXACT = new Set(["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "TMUX", "TMUX_PANE", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "CROW_PI_SANDBOX", "CROW_PI_CONTAIN_BOTS", "CROW_PI_CONTAIN_DATA_KEEP"]);

/** Copy of env without user-session IPC pointers (and the sandbox switch). */
export function scrubSandboxEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (SCRUB_EXACT.has(k) || /_SOCK(ET)?(_PATH)?$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function runProbe(bin, args) {
  const r = spawnSync(bin, args, { timeout: 5000, stdio: ["ignore", "ignore", "pipe"] });
  return r.status === 0 ? null
    : String((r.stderr && r.stderr.toString().trim()) || (r.error && r.error.message) || ("exit " + r.status)).slice(0, 200);
}

/**
 * Can this process start a bubblewrap sandbox, and which tier? Tier 1 (user
 * + PID namespace, fresh /proc) first, then tier 2 (user namespace only).
 * Only a FULL-tier success is cached for the life of the process. A failure
 * and a tier-2 success are re-probed after PROBE_RETRY_MS, so a transient
 * spawn timeout neither leaves every later pi unsandboxed nor pins it to the
 * weaker tier until restart. `runProbe` is a test seam.
 */
export function probePiSandbox(opts = {}) {
  const now = opts.now ?? Date.now();
  if (probeCache && !opts.force && ((probeCache.ok && probeCache.pidns) || now - probeCache.at < PROBE_RETRY_MS)) return probeCache;
  const bwrap = opts.bwrap !== undefined ? opts.bwrap : (BWRAP_CANDIDATES.find((p) => existsSync(p)) || null);
  const setpriv = opts.setpriv !== undefined ? opts.setpriv : (SETPRIV_CANDIDATES.find((p) => existsSync(p)) || null);
  const run = opts.runProbe || runProbe;
  let ok = false, pidns = false, reason, pidnsReason = null;
  if (!bwrap) reason = "bubblewrap (bwrap) is not installed";
  else {
    const err = run(bwrap, [...BWRAP_BASE, "--", "/bin/true"]);
    if (err == null) { ok = true; pidns = true; }
    else {
      pidnsReason = "bwrap cannot create a PID namespace with a fresh /proc here (--unshare-pid / --proc): " + err;
      const err2 = run(bwrap, [...BWRAP_BASE_NO_PIDNS, "--", "/bin/true"]);
      if (err2 == null) ok = true;
      else reason = "bwrap cannot create a user namespace here (--unshare-user): " + err2;
    }
  }
  let setprivOk = false;
  if (!ok && setpriv) setprivOk = run(setpriv, ["--no-new-privs", "/bin/true"]) == null;
  probeCache = { ok, pidns, bwrap: ok ? bwrap : null, setpriv: setprivOk ? setpriv : null, reason: ok ? null : reason,
    pidnsReason: pidns ? null : pidnsReason, at: now };
  return probeCache;
}

/** Current state for status surfaces: "active" (tier pidns) | "active-no-pidns"
 *  (tier userns) | "nnp-only: ..." | "off" | "fallback: ...". */
export function piSandboxStatus() {
  const mode = piSandboxMode(process.env);
  if (mode === "off") return "off";
  const p = probePiSandbox();
  if (p.ok) return p.pidns === false ? "active-no-pidns" : "active";
  return (p.setpriv ? "nnp-only: " : "fallback: ") + p.reason;
}

/**
 * The command line (and env) to spawn pi with. `tier` names what the child
 * really gets: "pidns" (bwrap, user + PID namespace, fresh /proc), "userns"
 * (bwrap, user namespace only), "nnp" (setpriv --no-new-privs only) or
 * "none" (plain spawn). `pidNamespace` is true exactly for "pidns".
 * @returns {{cmd, args, env, tier:"pidns"|"userns"|"nnp"|"none", sandboxed:boolean, wrapper:"bwrap"|"setpriv"|null, pidNamespace:boolean, reason, masked:string[]}}
 * @throws when mode is "required" and bwrap is unavailable.
 */
export function wrapPiSpawn(cmd, args, opts = {}) {
  // M1: the mode and the socket list come from the GATEWAY's env, never from
  // the child env (which carries the bot def's spawn_env).
  const mode = opts.mode || piSandboxMode(process.env);
  const env = opts.env || process.env;
  const plain = (reason) => ({ cmd, args, env, tier: "none", sandboxed: false, wrapper: null, pidNamespace: false, reason, masked: [] });
  if (mode === "off") return plain("CROW_PI_SANDBOX=off");
  const probe = opts.probe || probePiSandbox();
  // Contain tier (pi_contain.mjs): selected for this bot by the spawner's env
  // (CROW_PI_SANDBOX=contain, or CROW_PI_CONTAIN_BOTS listing the bot) and
  // possible only when the caller passed the bot's mount inputs. An opted-in
  // spawn never silently downgrades: no bubblewrap, or a policy that cannot
  // be contained (bypass), is an error the caller surfaces as a failed turn.
  if (opts.contain && containSelected(process.env, opts.botId)) {
    if (!probe.ok) throw new Error("pi contain tier selected but bubblewrap is unavailable: " + probe.reason);
    if (probe.pidns === false) {
      throw new Error("pi contain tier selected but bwrap cannot make a PID namespace here (" + (probe.pidnsReason || "unavailable") + ")");
    }
    const plan = buildContainPlan(opts.contain);
    for (const r of plan.refused) console.error("[pi-sandbox] contain: not bound: " + r.path + " (" + r.reason + ")");
    const pre = [...plan.args];
    // Instance secrets dirs (hideDirs): contain binds none of them; one that a
    // bound dir happens to contain is over-mounted read-only, so every one is
    // really hidden and reported masked (the bridge refuses otherwise).
    const hideDirs = (opts.hideDirs || []).filter((d) => typeof d === "string" && d.startsWith("/"));
    const boundSrc = [];
    for (let i = 0; i < pre.length; i++) if (pre[i] === "--bind" || pre[i] === "--ro-bind") boundSrc.push(pre[i + 2]);
    for (const d of hideDirs) if (isDir(d) && boundSrc.some((b) => b && (d === b || d.startsWith(b + "/")))) pre.push("--tmpfs", d, "--remount-ro", d);
    if (opts.infoFd != null) pre.push("--info-fd", String(opts.infoFd));
    return { cmd: probe.bwrap, args: [...pre, "--", cmd, ...args], env: { ...scrubSandboxEnv(env), ...plan.env },
      sandboxed: true, wrapper: "bwrap", tier: "contain", pidNamespace: true, reason: null, masked: hideDirs, refused: plan.refused };
  }
  if (!probe.ok) {
    if (mode === "required" || mode === "contain") {
      throw new Error("pi sandbox required (CROW_PI_SANDBOX=required) but unavailable: " + probe.reason);
    }
    const key = probe.reason + "|" + !!probe.setpriv;
    if (warnedFor !== key) {
      warnedFor = key;
      console.error("[pi-sandbox] WARNING: pi children run WITHOUT the bubblewrap sandbox (" + probe.reason + "). " +
        (probe.setpriv ? "Falling back to setpriv --no-new-privs: sudo/setuid are blocked, docker is NOT."
          : "They keep this process's groups (docker, if present) and can use sudo."));
    }
    if (probe.setpriv) {
      return { cmd: probe.setpriv, args: ["--no-new-privs", cmd, ...args], env: scrubSandboxEnv(env),
        tier: "nnp", sandboxed: false, wrapper: "setpriv", pidNamespace: false, reason: probe.reason, masked: [] };
    }
    return plain(probe.reason);
  }
  const sockets = opts.sockets || dockerSocketPaths(process.env);
  const tmpfs = opts.runtimeDirs || userRuntimeDirs();
  const roDirs = opts.roDirs || systemdUserUnitDirs();
  // Instance secret dirs (the bot engine passes <CROW_HOME>/secrets: the
  // keychain key, retained bundle secrets, the secret-values file). A dir, not
  // a file: a file bind would come off the moment the file is replaced by
  // rename, while the tmpfs over its dir stays.
  const hideDirs = (opts.hideDirs || []).filter((d) => typeof d === "string" && d.startsWith("/") && isDir(d));
  // Pin EVERY ancestor of a hidden dir below / (bound onto itself it is a
  // mountpoint, and renaming a mountpoint fails, EBUSY). Not only those whose
  // parent is writable now: the bot owns ~ and can chmod it unwritable for
  // one spawn and writable again inside the next. Without this a bot renames
  // e.g. ~/.crow away, the tmpfs moves with it, and the next fresh process
  // anchors a planted decoy at the old path while the real dir sits visible
  // elsewhere. A bind costs nothing.
  const pins = [];
  for (const d of hideDirs) {
    for (let a = dirname(d); a && a !== "/" && a !== opts.pinStop; a = dirname(a)) {
      if (!pins.includes(a)) pins.push(a);
    }
  }
  // A probe without a pidns field (older callers, test stubs) means the full tier.
  const pidNamespace = probe.pidns !== false;
  if (!pidNamespace && !warnedNoPidns) {
    warnedNoPidns = true;
    console.error("[pi-sandbox] WARNING: pi children run in the bubblewrap sandbox WITHOUT a private PID namespace (" +
      (probe.pidnsReason || "unavailable") + "). Bots can see host processes and their /proc entries.");
  }
  const pre = [...(pidNamespace ? BWRAP_BASE : BWRAP_BASE_NO_PIDNS)];
  for (const a of pins.sort((x, y) => x.length - y.length)) pre.push("--bind", a, a);
  for (const d of tmpfs) pre.push("--tmpfs", d);
  // Read-only too: no decoy can be planted there for a host-side reader
  // (send_user_file) to resolve to the real file behind the mask.
  for (const d of hideDirs) if (!tmpfs.some((t) => d === t || d.startsWith(t + "/"))) pre.push("--tmpfs", d, "--remount-ro", d);
  for (const s of sockets) if (!tmpfs.some((d) => s === d || s.startsWith(d + "/"))) pre.push("--ro-bind", "/dev/null", s);
  for (const d of roDirs) pre.push("--ro-bind", d, d);
  if (opts.infoFd != null) pre.push("--info-fd", String(opts.infoFd));
  return { cmd: probe.bwrap, args: [...pre, "--", cmd, ...args], env: scrubSandboxEnv(env),
    tier: pidNamespace ? "pidns" : "userns", sandboxed: true, wrapper: "bwrap", pidNamespace, reason: null, masked: [...sockets, ...tmpfs, ...hideDirs, ...roDirs], pinned: pins };
}

/** True when a ps `args` string is a bubblewrap wrapper (used by the reaper). */
export function isSandboxWrapperArgs(argsStr) {
  const first = String(argsStr || "").trim().split(/\s+/)[0] || "";
  return basename(first) === "bwrap";
}
