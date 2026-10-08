/**
 * Resolve and verify an add-on MCP server's launch command.
 *
 * Why: mcp-addons.json entries may name a bare command (`uvx`, `uv`) that
 * the gateway's systemd PATH cannot find (ENOENT, silently dropped servers).
 * And a bot shell runs as the operator's uid, so anything that uid owns —
 * ~/.local/bin, ~/.nvm, the add-on's own directory — is writable by a bot:
 * a launcher found there cannot be trusted on its location alone.
 *
 * Rules (checked at EVERY call — no trust carried over from an earlier call):
 *   - `node` is the gateway's own Node binary (process.execPath), and `npm` /
 *     `npx` are the ones next to it: the gateway already runs that directory,
 *     so trusting them adds nothing.
 *   - A relative launcher (`./run.sh`) resolves against the add-on's own
 *     installed folder (opts.cwd); its real path must stay inside that folder,
 *     and it must be pinned like any other user-owned launcher (the Extensions
 *     install and update write that pin — the install click is the consent).
 *   - Any other bare name is looked up ONLY in a fixed list of system
 *     directories (TRUSTED_DIRS), never the PATH and never a user directory.
 *     The hit must be root-owned, and so must every directory on its
 *     symlink-resolved path, none of them group- or world-writable.
 *   - An absolute path passes the same root-owned check, OR is pinned by
 *     the operator: the add-on entry carries `command_sha256` and the file's
 *     current SHA-256 must match it (hashed at every spawn).
 *   - Anything else (not found, user-owned and unpinned, hash mismatch,
 *     relative path) is refused: `missing: true` with a `reason`. Callers
 *     omit the server and say why — never fall back to a PATH lookup.
 *
 * The verified real path is returned (symlinks resolved), and a pinned
 * launcher keeps its pin in the spawned config so the process that actually
 * starts it (pi-lab's mcp-client for bots, the gateway proxy here) re-hashes
 * it right before the spawn. A same-uid process can still rewrite the file
 * in the instant between that re-check and exec; closing that needs a
 * separate bot user.
 *
 * Limit (documented trade-off): with bot shells at the operator's uid, the
 * pin itself lives in a file that uid can write (mcp-addons.json). Pinning
 * stops a launcher swapped underneath an entry; it cannot stop a bot that
 * rewrites both. The fix for that is running bot shells as a separate user
 * (planned follow-up); until then shells are Perch-only, with a human
 * approving every command the safety check does not clear.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";

export const TRUSTED_DIRS = Object.freeze(["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]);

/** Every component of the real path root-owned and not group/world-writable. */
function rootOwnedChain(p) {
  let real;
  try { real = realpathSync(p); } catch { return { ok: false, reason: "not found" }; }
  let st;
  try { st = statSync(real); } catch { return { ok: false, reason: "not found" }; }
  if (!st.isFile() || !(st.mode & 0o111)) return { ok: false, reason: "not an executable file" };
  let cur = real;
  for (;;) {
    let s;
    try { s = statSync(cur); } catch { return { ok: false, reason: "unreadable path" }; }
    if (s.uid !== 0) return { ok: false, reason: `${cur} is not owned by root` };
    if (s.mode & 0o022) return { ok: false, reason: `${cur} is writable by group or others` };
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return { ok: true, real };
}

function sha256File(p) {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
}

/**
 * @param {string} command
 * @param {{ sha256?: string, execPath?: string, trustedDirs?: string[] }} [opts]
 * @returns {{command: any, resolved: boolean, missing: boolean, reason?: string}}
 */
const NODE_SIBLINGS = new Set(["npm", "npx"]);

function isRelativeLauncher(c) { return !isAbsolute(c) && c.includes("/"); }

/** The real path of a relative launcher inside `cwd`, or a refusal reason. */
function inBundle(command, cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return { reason: `${command}: a relative launcher needs the add-on folder` };
  let root, real;
  try { root = realpathSync(cwd); } catch { return { reason: `${command}: add-on folder ${cwd} not found` }; }
  try { real = realpathSync(resolvePath(cwd, command)); } catch { return { reason: `${command}: not found in ${cwd}` }; }
  if (!real.startsWith(root + sep)) return { reason: `${command}: resolves outside the add-on folder` };
  return { real };
}

export function resolveAddonCommand(command, opts = {}) {
  if (typeof command !== "string" || command === "") return { command, resolved: false, missing: false };
  const refuse = (reason) => ({ command, resolved: false, missing: true, reason });
  const pin = typeof opts.sha256 === "string" && /^[0-9a-f]{64}$/i.test(opts.sha256) ? opts.sha256.toLowerCase() : null;
  const execPath = opts.execPath || process.execPath;
  if (command === "node") return { command: execPath, resolved: true, missing: false };
  if (NODE_SIBLINGS.has(command)) {
    const p = join(dirname(execPath), command);
    try {
      if (statSync(p).isFile()) return { command: realpathSync(p), resolved: true, missing: false };
    } catch { /* not there */ }
    return refuse(`${command} not found next to the gateway's node (${dirname(execPath)})`);
  }
  if (isRelativeLauncher(command)) {
    const b = inBundle(command, opts.cwd);
    if (!b.real) return refuse(b.reason);
    if (!pin) return refuse(`${command}: pin it with command_sha256 in the add-on entry (re-pin the add-on)`);
    const h = sha256File(b.real);
    if (h !== pin) return refuse(`${command}: SHA-256 does not match the pinned command_sha256 (re-pin the add-on)`);
    return { command: b.real, resolved: true, missing: false, sha256: pin };
  }
  if (!command.includes("/")) {
    for (const d of opts.trustedDirs || TRUSTED_DIRS) {
      const p = join(d, command);
      let exists = false;
      try { exists = statSync(p).isFile(); } catch { exists = false; }
      if (!exists) continue;
      const chain = rootOwnedChain(p);
      if (!chain.ok) return refuse(`${p}: ${chain.reason}`);  // first hit decides; never skip past a bad one
      return { command: chain.real, resolved: true, missing: false };
    }
    return refuse(`${command} not found in ${(opts.trustedDirs || TRUSTED_DIRS).join(", ")} — give the add-on an absolute command with command_sha256`);
  }
  if (!isAbsolute(command) || command.split(sep).includes("..")) return refuse(`${command}: use an absolute path`);
  // What is returned — and executed — is always the verified REAL path, never
  // a symlink that could be re-pointed between this check and the spawn.
  const chain = rootOwnedChain(command);
  if (chain.ok) return { command: chain.real, resolved: chain.real !== command, missing: false };
  if (!pin) return refuse(`${command}: ${chain.reason}; pin it with command_sha256 in the add-on entry`);
  let real;
  try { real = realpathSync(command); } catch { return refuse(`${command}: not found`); }
  const h = sha256File(real);
  if (!h) return refuse(`${command}: not readable`);
  if (h !== pin) return refuse(`${command}: SHA-256 does not match the pinned command_sha256`);
  return { command: real, resolved: real !== command, missing: false, sha256: pin };
}

/**
 * A uv/uvx launcher fetches and runs whatever its `--from git+…` names; a
 * pin on the launcher says nothing about that code. A git source must name a
 * full commit SHA (`git+https://…@<40 hex>`); a branch, tag or bare repo URL
 * is refused. Other launchers are not judged here. Returns a reason or null.
 */
export function checkLauncherArgs(command, args) {
  const base = String(command || "").split("/").pop();
  if (base !== "uv" && base !== "uvx") return null;
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const src = a.startsWith("--from=") ? a.slice(7) : (a === "--from" ? list[i + 1] || "" : (/^git\+/.test(a) ? a : null));
    if (src == null || !/^git\+/.test(src)) continue;
    if (!/@[0-9a-f]{40}$/i.test(src)) return `${base} fetches a floating git ref (${src.slice(0, 120)}); pin --from to a full commit SHA (…@<40 hex>)`;
  }
  return null;
}

/**
 * The pin an install / update / re-pin should write for a launcher, or null
 * when it needs none (node/npm/npx, root-owned) or cannot have one (a bare
 * name outside the system directories — give the entry an absolute path).
 */
export function launcherPin(command, cwd) {
  if (typeof command !== "string" || !command || command === "node" || NODE_SIBLINGS.has(command)) return null;
  let real;
  if (isRelativeLauncher(command)) {
    const b = inBundle(command, cwd);
    if (!b.real) return null;
    real = b.real;
  } else if (isAbsolute(command)) {
    if (command.split(sep).includes("..")) return null;
    if (rootOwnedChain(command).ok) return null;
    try { real = realpathSync(command); } catch { return null; }
  } else {
    return null;
  }
  return sha256File(real);
}

/**
 * Launcher health of one mcp-addons.json entry (read-only): ok, or the reason
 * it would be refused, and whether a re-pin (install-owned or operator) fixes it.
 */
export function addonLauncherStatus(entry, cwd, opts = {}) {
  if (!entry || typeof entry !== "object" || entry.url || typeof entry.command !== "string") return { ok: true, skipped: true };
  const rc = resolveAddonCommand(entry.command, { ...opts, sha256: entry.command_sha256, cwd });
  if (rc.missing) {
    const repinnable = /command_sha256|re-pin/.test(rc.reason || "") && launcherPin(entry.command, cwd) !== null;
    return { ok: false, reason: rc.reason, needsRepin: repinnable };
  }
  const argProblem = checkLauncherArgs(rc.command, entry.args);
  if (argProblem) return { ok: false, reason: argProblem, needsRepin: false };
  return { ok: true };
}
