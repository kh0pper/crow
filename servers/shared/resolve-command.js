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
 *   - `node` is the gateway's own Node binary (process.execPath): the
 *     gateway already runs it, so trusting it adds nothing.
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
import { dirname, isAbsolute, join, sep } from "node:path";

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
export function resolveAddonCommand(command, opts = {}) {
  if (typeof command !== "string" || command === "") return { command, resolved: false, missing: false };
  const refuse = (reason) => ({ command, resolved: false, missing: true, reason });
  const pin = typeof opts.sha256 === "string" && /^[0-9a-f]{64}$/i.test(opts.sha256) ? opts.sha256.toLowerCase() : null;
  if (command === "node") return { command: opts.execPath || process.execPath, resolved: true, missing: false };
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
