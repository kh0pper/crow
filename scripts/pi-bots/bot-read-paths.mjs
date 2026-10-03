/**
 * Bot read roots (S6-CROW) — what goes into `permission_policy.read_paths`.
 *
 * pi-lab >= c8bbb02 confines a bot's read-type tools (read/grep/find/ls,
 * send_user_file) to: the spawn cwd, dirname(PI_BOT_MCP_CONFIG), write_paths,
 * and the optional `read_paths`. Crow computes the EFFECTIVE read_paths per
 * spawn from:
 *
 *   - the operator's explicit `def.permission_policy.read_paths` (Bot Builder ›
 *     Permissions › "Folders this bot can read"), kept as typed;
 *   - the bot's project workspace (`project_spaces.workspace_dir`) — added
 *     automatically, and ONLY for a bot that has a project. A bot without a
 *     project never gets anything it was not explicitly given.
 *
 * Pure: no fs, no DB. The bridge (PiRpc) owns the spawn-time merge; the Bot
 * Builder uses parseReadPathsInput for save-time validation.
 */
import { posix } from "node:path";

/** An acceptable read root: an absolute POSIX path, no NUL/newline, no `..` segment. */
export function isValidReadPath(p) {
  if (typeof p !== "string") return false;
  if (!p.startsWith("/")) return false;
  if (/[\0\r\n]/.test(p)) return false;
  if (p.split("/").includes("..")) return false;
  return true;
}

/** Normalize one root: collapse `//` and `.` segments, drop a trailing slash (not on "/"). */
export function normalizeReadPath(p) {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * Bot Builder save-time parse of the "one per line" textarea.
 * @returns {{paths: string[], invalid: string[]}} paths normalized + de-duplicated in order.
 */
export function parseReadPathsInput(text) {
  const out = [];
  const invalid = [];
  for (const raw of String(text == null ? "" : text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!isValidReadPath(line)) { invalid.push(line); continue; }
    const n = normalizeReadPath(line);
    if (!out.includes(n)) out.push(n);
  }
  return { paths: out, invalid };
}

/**
 * The effective read_paths for one spawn.
 *
 * @param {object} def  the bot def (never mutated)
 * @param {{projectWorkspaceDir?: string|null, extra?: string[]}} [opts]
 *   projectWorkspaceDir — the bot's project workspace_dir; null/absent for a
 *   bot without a project. extra — engine-added roots (e.g. the world root in
 *   fd mode when pi's cwd is not the world root).
 * @returns {string[]} explicit (valid) entries first, then the project
 *   workspace, then extras; de-duplicated. Invalid hand-edited entries in the
 *   stored def are dropped (pi-lab would resolve a relative one against cwd).
 */
export function effectiveReadPaths(def, { projectWorkspaceDir = null, extra = [] } = {}) {
  const pp = (def && def.permission_policy) || {};
  const explicit = Array.isArray(pp.read_paths) ? pp.read_paths : [];
  const out = [];
  const add = (p) => {
    if (!isValidReadPath(p)) return;
    const n = normalizeReadPath(p);
    if (!out.includes(n)) out.push(n);
  };
  for (const p of explicit) add(p);
  if (projectWorkspaceDir) add(projectWorkspaceDir);
  for (const p of extra || []) add(p);
  return out;
}
