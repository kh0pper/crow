/**
 * Per-bot git access: the ssh side — the exact options a bot's git runs, the
 * host-key scan behind the confirm prompt, and the "test connection" probe.
 *
 * Everything here is built from fixed parts and the bot's key dir:
 *
 *   ssh -F /dev/null -i <key dir>/id_ed25519 -o IdentitiesOnly=yes …
 *
 * No inherited environment reaches ssh, no agent and no user config: `-F
 * /dev/null` drops ~/.ssh/config, `IdentityAgent=none` drops SSH_AUTH_SOCK,
 * `GlobalKnownHostsFile=/dev/null` drops /etc/ssh/ssh_known_hosts, and
 * `UserKnownHostsFile` points at the bot's GENERATED known_hosts (pinned GitHub
 * keys + the hosts the owner confirmed), with `StrictHostKeyChecking=yes` so an
 * unknown host is refused instead of learned. `ProxyCommand=none`,
 * `ProxyJump=none` and `ControlMaster=no` keep a config-shaped boundary in
 * place even if some of the above is ever relaxed by mistake.
 *
 * Both paths are checked against paths.js's SAFE_PATH_RE before they are put
 * into the option array, because GIT_SSH_COMMAND is a STRING git hands to a
 * shell: a path with a space, a quote or `$` could never be expressed there
 * without quoting, so such a path simply disables git. They also come from
 * paths.js's childVisiblePath: ssh, ssh-keyscan and git are CHILD processes,
 * and an anchored `/proc/self/fd/<fd>/…` path resolves only inside this one.
 *
 * Both probes are ASYNC (a promisified execFile): ssh may sit on a 20 s connect
 * timeout and ssh-keyscan on a 10 s scan, and a synchronous child process would
 * block the whole gateway — every dashboard request, card and health check — for
 * that long. The per-bot busy guard is set before the await and cleared in a
 * finally, so two overlapping calls for one bot really do overlap.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GITHUB_HOST, normalizeHost, parseKeyscan } from "./host-keys.js";
import { botGitAnchored, childVisiblePath, isSafeKeyPath, isValidGitBotId } from "./paths.js";
import { botGitSecretValues, botKeyStatus, writeKnownHosts } from "./store.js";
import { maskSecrets } from "../secret-mask.js";

/** The key and known_hosts file names inside a key dir (store.js writes them). */
const KEY = "id_ed25519";
const KNOWN_HOSTS = "known_hosts";

/** How long an ssh option array may get before a refusal is suspicious. */
const MAX_OPTION_ARGS = 64;

/**
 * The fixed ssh options for a bot's key dir, as argv (no "ssh" element).
 * Refuses (null) when either path could not be written into a command string.
 *
 * @param {{keyPath: string, knownHostsPath: string}} paths
 * @returns {string[]|null}
 */
export function sshOptionArgs({ keyPath, knownHostsPath } = {}) {
  if (!isSafeKeyPath(keyPath) || !isSafeKeyPath(knownHostsPath)) return null;
  const args = [
    "-F", "/dev/null",
    "-i", keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", "BatchMode=yes",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "PermitLocalCommand=no",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=10",
  ];
  return args.length <= MAX_OPTION_ARGS ? args : null;
}

/**
 * GIT_SSH_COMMAND for a bot's git: "ssh " + the option array. Safe to hand to
 * a shell only because every variable part went through SAFE_PATH_RE (see the
 * header); null when a path is unusable.
 *
 * @param {{keyPath: string, knownHostsPath: string}} paths
 * @returns {string|null}
 */
export function gitSshCommand({ keyPath, knownHostsPath } = {}) {
  const args = sshOptionArgs({ keyPath, knownHostsPath });
  return args ? "ssh " + args.join(" ") : null;
}

/**
 * The default runner: node's async `execFile`, promisified. Nothing in this
 * module may run a child process synchronously (see the header).
 */
const execFileAsync = promisify(execFile);

/** True for a ChildProcess (`execFile`'s own return value), i.e. a callback-style impl. */
function isChildProcessLike(ret) {
  return Boolean(ret) && typeof ret === "object" && typeof ret.on === "function" && typeof ret.kill === "function";
}

/**
 * Run one command through `execFileImpl` and settle exactly once, whatever
 * shape the impl has: a promise (the default), a callback-style function
 * (`execFile` itself: `(cmd, args, opts, cb)`, returning a ChildProcess), or a
 * synchronous stub that returns its stdout (or throws an error carrying it).
 * Resolves `{ stdout, stderr }`; rejects with the impl's own error object, so
 * err.stdout, err.stderr, err.killed and err.signal survive.
 */
function runProcess(execFileImpl, cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (err) {
        // execFile puts the child's output on the error; a stub may not.
        if (err.stdout == null && stdout != null) err.stdout = stdout;
        if (err.stderr == null && stderr != null) err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: stdout == null ? "" : String(stdout), stderr: stderr == null ? "" : String(stderr) });
    };
    let ret;
    try {
      ret = execFileImpl(cmd, args, opts, (err, stdout, stderr) => settle(err, stdout, stderr));
    } catch (err) {
      settle(err, err && err.stdout, err && err.stderr);
      return;
    }
    if (ret && typeof ret.then === "function") {
      ret.then((r) => settle(null, r && r.stdout, r && r.stderr), (err) => settle(err, err && err.stdout, err && err.stderr));
    } else if (isChildProcessLike(ret)) {
      // Callback-style: the callback above settles it.
    } else if (ret !== undefined) {
      // A synchronous stub that returned its stdout (a string, usually "").
      settle(null, ret, "");
    }
    // ret === undefined: a callback-style impl that returned nothing; wait.
  });
}

/** The key dir of a bot with a usable key, as `{ ok: true, dir, keyPath, knownHostsPath }`. */
function keyPaths(botId) {
  if (!isValidGitBotId(botId)) return { ok: false, reason: "invalid bot id" };
  const anchored = botGitAnchored(botId);
  if (!anchored) return { ok: false, reason: "the secrets dir is not available" };
  // ssh gets these as `-i` and `UserKnownHostsFile=`, i.e. as paths a CHILD
  // process must open: the anchored /proc/self/fd path would not resolve there.
  const dir = childVisiblePath(anchored, { directory: true });
  if (!dir) return { ok: false, reason: "the secrets dir is not available" };
  const keyPath = join(dir, KEY);
  const knownHostsPath = join(dir, KNOWN_HOSTS);
  if (!isSafeKeyPath(keyPath) || !isSafeKeyPath(knownHostsPath)) {
    return { ok: false, reason: "the key dir path cannot be used in a git command" };
  }
  return { ok: true, dir, keyPath, knownHostsPath };
}

/** A scan host as `{ host, port }`, or null (also refuses the pinned host and anything unconfirmable). */
function scanTarget(host, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  const raw = String(host == null ? "" : host).trim().toLowerCase();
  if (!raw) return null;
  const norm = normalizeHost(p === 22 ? raw : raw + ":" + p);
  if (!norm || norm.port !== p) return null;
  return norm;
}

/**
 * `ssh-keyscan` a host the owner wants to confirm, and return the keys it
 * serves as `[{ type, key, fingerprint }]` (host-keys.parseKeyscan applies the
 * line rules again, so a scan cannot smuggle a marker or a wildcard into the
 * confirm prompt). The host is validated (normalizeHost refuses `-…`, IPv6,
 * localhost, our own loopback range and the pinned host) AND passed after `--`,
 * so it can never be read as an option.
 *
 * @param {{host: string, port?: number, execFileImpl?: Function}} opts
 * @returns {Promise<Array<{type: string, key: string, fingerprint: string}>|null>} null: the host is not scannable
 */
export async function keyscan({ host, port = 22, execFileImpl = execFileAsync } = {}) {
  const target = scanTarget(host, port);
  if (!target) return null;
  let result;
  try {
    result = await runProcess(
      execFileImpl,
      "ssh-keyscan",
      ["-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", String(target.port), "--", target.host],
      { timeout: 10_000, env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C" } },
    );
  } catch {
    return [];
  }
  return parseKeyscan(result.stdout, target);
}

/**
 * One "test connection" per bot at a time (a second call answers "busy").
 * The id is added BEFORE the await and removed in the finally, so an overlapping
 * call for the same bot sees it; a guard set after the await would not.
 */
const running = new Set();

/** ANSI escape sequences (colour, cursor, OSC titles). */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Control characters except newline (0x7f included: it is not printable either). */
const CONTROL_RE = /[\x00-\x09\x0b-\x1f\x7f]/g;

/**
 * ssh output as the owner MAY see it: ANSI and control characters removed, the
 * bot's key dir replaced by `<key dir>`, any line carrying a private-key header
 * dropped, every known secret value masked, then capped. Masking happens before
 * the cap, so a cut never leaves half a key on screen.
 */
function scrubExcerpt(text, { keyDir, values = [], limit = 400 } = {}) {
  let s = String(text == null ? "" : text);
  s = s.replace(ANSI_RE, "").replace(CONTROL_RE, "");
  if (keyDir) s = s.split(keyDir).join("<key dir>");
  // Built at runtime: the literal header must never sit in a tracked file.
  const keyLabel = "PRIVATE" + " KEY";
  s = s.split("\n").filter((line) => !line.includes(keyLabel)).join("\n");
  try { s = maskSecrets(s, { values }); } catch { s = ""; }
  return s.slice(0, limit);
}

/** The banner that means "the key is accepted", whatever ssh's exit code says. */
const OK_RE = /successfully authenticated/i;
const DENIED_RE = /Permission denied/;
const HOSTKEY_RE = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/;

/**
 * Try ssh into a git host as the bot, through the bot's own key and
 * known_hosts. Only the pinned `github.com:22` and the hosts the owner
 * confirmed for this bot are attempted; anything else is refused before ssh
 * runs. Output is classified (not the exit code: ssh exits 1 on GitHub's
 * success banner) as "ok", "denied", "hostkey", "timeout" or "failed", and the
 * excerpt is scrubbed (see scrubExcerpt).
 *
 * @param {{botId: string, host: string, port?: number, execFileImpl?: Function}} opts
 * @returns {Promise<{result: "ok"|"denied"|"hostkey"|"timeout"|"failed"|"refused"|"busy", excerpt: string}>}
 */
export async function testConnection({ botId, host, port = 22, execFileImpl = execFileAsync } = {}) {
  if (!isValidGitBotId(botId)) return { result: "refused", excerpt: "invalid bot id" };
  if (running.has(botId)) return { result: "busy", excerpt: "another connection test is running for this bot" };
  running.add(botId);
  try {
    const paths = keyPaths(botId);
    if (!paths.ok) return { result: "refused", excerpt: paths.reason };
    const status = botKeyStatus(botId);
    if (!status.on) return { result: "refused", excerpt: status.reason || "no git key for this bot" };

    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { result: "refused", excerpt: "invalid port" };
    const raw = String(host == null ? "" : host).trim().toLowerCase();
    const pinned = raw === GITHUB_HOST && p === 22;
    let target = raw;
    if (!pinned) {
      const norm = scanTarget(raw, p);
      if (!norm) return { result: "refused", excerpt: "this host cannot be tested" };
      if (!status.hosts.some((h) => h.host === norm.host && h.port === norm.port)) {
        return { result: "refused", excerpt: "confirm this host's key first" };
      }
      target = norm.host;
    }

    // The host the owner just confirmed is not in known_hosts until a spawn
    // regenerates it, so regenerate it now (same recipe, same file).
    const known = writeKnownHosts(botId);
    if (!known.ok) return { result: "refused", excerpt: known.reason };
    const args = sshOptionArgs({ keyPath: paths.keyPath, knownHostsPath: paths.knownHostsPath });
    if (!args) return { result: "refused", excerpt: "the key dir path cannot be used in a git command" };

    const argv = [...args, "-p", String(p), "-T", "--", "git@" + target];
    let stdout = "";
    let stderr = "";
    let killed = false;
    try {
      const r = await runProcess(
        execFileImpl,
        "ssh",
        argv,
        { timeout: 20_000, env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C" } },
      );
      stdout = r.stdout;
    } catch (err) {
      stdout = String(err && err.stdout != null ? err.stdout : "");
      stderr = String(err && err.stderr != null ? err.stderr : "");
      killed = Boolean(err && (err.killed === true || err.signal != null || err.code === "ETIMEDOUT"));
    }
    const text = stdout + (stdout && stderr ? "\n" : "") + stderr;
    let result = "failed";
    if (OK_RE.test(text)) result = "ok";
    else if (DENIED_RE.test(text)) result = "denied";
    else if (HOSTKEY_RE.test(text)) result = "hostkey";
    else if (killed) result = "timeout";
    const values = botGitSecretValues();
    return { result, excerpt: scrubExcerpt(text, { keyDir: dirname(paths.keyPath), values }) };
  } finally {
    running.delete(botId);
  }
}