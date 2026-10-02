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
 *     bwrap --dev-bind / / --unshare-user
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
 *  - In its own user namespace the child is refused other processes'
 *    /proc/<pid>/{root,environ,mem} (the gateway's and other bots').
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
 * Modes, from the GATEWAY's env only (process.env; a bot def's spawn_env
 * cannot change it): CROW_PI_SANDBOX = "auto" (default: bwrap, else the
 * setpriv fallback, else plain, with a one-time warning), "required" (refuse
 * to spawn pi without bwrap), "off" (never wrap).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
const SETPRIV_CANDIDATES = ["/usr/bin/setpriv", "/bin/setpriv"];
export const PROBE_RETRY_MS = 5 * 60 * 1000;

let probeCache = null; // { ok, bwrap, setpriv, reason, at }
let warnedFor = null;

/** Test seam only. */
export function _resetPiSandboxForTest() { probeCache = null; warnedFor = null; }

export function piSandboxMode(env = process.env) {
  const v = String(env.CROW_PI_SANDBOX || "auto").trim().toLowerCase();
  return v === "off" || v === "required" ? v : "auto";
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
  "TMUX", "TMUX_PANE", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "CROW_PI_SANDBOX"]);

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
 * Can this process start a bubblewrap user-namespace sandbox? A success is
 * cached for the life of the process; a failure is re-probed after
 * PROBE_RETRY_MS (a transient spawn timeout must not leave every later pi
 * unsandboxed until restart).
 */
export function probePiSandbox(opts = {}) {
  const now = opts.now ?? Date.now();
  if (probeCache && !opts.force && (probeCache.ok || now - probeCache.at < PROBE_RETRY_MS)) return probeCache;
  const bwrap = opts.bwrap !== undefined ? opts.bwrap : (BWRAP_CANDIDATES.find((p) => existsSync(p)) || null);
  const setpriv = opts.setpriv !== undefined ? opts.setpriv : (SETPRIV_CANDIDATES.find((p) => existsSync(p)) || null);
  let ok = false, reason;
  if (!bwrap) reason = "bubblewrap (bwrap) is not installed";
  else {
    const err = runProbe(bwrap, ["--dev-bind", "/", "/", "--unshare-user", "--", "/bin/true"]);
    if (err == null) ok = true; else reason = "bwrap cannot create a user namespace here: " + err;
  }
  let setprivOk = false;
  if (!ok && setpriv) setprivOk = runProbe(setpriv, ["--no-new-privs", "/bin/true"]) == null;
  probeCache = { ok, bwrap: ok ? bwrap : null, setpriv: setprivOk ? setpriv : null, reason: ok ? null : reason, at: now };
  return probeCache;
}

/** Current state for status surfaces: "active" | "nnp-only: ..." | "off" | "fallback: ...". */
export function piSandboxStatus() {
  const mode = piSandboxMode(process.env);
  if (mode === "off") return "off";
  const p = probePiSandbox();
  if (p.ok) return "active";
  return (p.setpriv ? "nnp-only: " : "fallback: ") + p.reason;
}

/**
 * The command line (and env) to spawn pi with.
 * @returns {{cmd, args, env, sandboxed:boolean, wrapper:"bwrap"|"setpriv"|null, reason, masked:string[]}}
 * @throws when mode is "required" and bwrap is unavailable.
 */
export function wrapPiSpawn(cmd, args, opts = {}) {
  // M1: the mode and the socket list come from the GATEWAY's env, never from
  // the child env (which carries the bot def's spawn_env).
  const mode = opts.mode || piSandboxMode(process.env);
  const env = opts.env || process.env;
  const plain = (reason) => ({ cmd, args, env, sandboxed: false, wrapper: null, reason, masked: [] });
  if (mode === "off") return plain("CROW_PI_SANDBOX=off");
  const probe = opts.probe || probePiSandbox();
  if (!probe.ok) {
    if (mode === "required") {
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
        sandboxed: false, wrapper: "setpriv", reason: probe.reason, masked: [] };
    }
    return plain(probe.reason);
  }
  const sockets = opts.sockets || dockerSocketPaths(process.env);
  const tmpfs = opts.runtimeDirs || userRuntimeDirs();
  const roDirs = opts.roDirs || systemdUserUnitDirs();
  const pre = ["--dev-bind", "/", "/", "--unshare-user"];
  for (const d of tmpfs) pre.push("--tmpfs", d);
  for (const s of sockets) if (!tmpfs.some((d) => s === d || s.startsWith(d + "/"))) pre.push("--ro-bind", "/dev/null", s);
  for (const d of roDirs) pre.push("--ro-bind", d, d);
  if (opts.infoFd != null) pre.push("--info-fd", String(opts.infoFd));
  return { cmd: probe.bwrap, args: [...pre, "--", cmd, ...args], env: scrubSandboxEnv(env),
    sandboxed: true, wrapper: "bwrap", reason: null, masked: [...sockets, ...tmpfs, ...roDirs] };
}

/** True when a ps `args` string is a bubblewrap wrapper (used by the reaper). */
export function isSandboxWrapperArgs(argsStr) {
  const first = String(argsStr || "").trim().split(/\s+/)[0] || "";
  return basename(first) === "bwrap";
}
