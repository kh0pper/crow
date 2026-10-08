/**
 * pi-lab compatibility gate (S6-CROW).
 *
 * pi-lab is the extension package pi loads for every bot turn (the
 * permission gate, the MCP client). Crow depends on behaviour that only exists
 * from a known pi-lab revision on, so the minimum is declared here, in one
 * place, and checked once per process:
 *
 *   MIN_PI_LAB_REV = c3aed09 (2026-10-08) — bash policies ask/auto (the local
 *   safety classifier); it contains c8bbb02 (2026-10-02): bot read
 *   confinement (`permission_policy.read_paths`, `.mcp.json` structurally
 *   unreadable) and MCP config delivery over an inherited fd
 *   (`PI_BOT_MCP_CONFIG_FD`). It also re-verifies pinned add-on launchers
 *   (command_sha256) at spawn. An older pi-lab blocks ask/auto like deny.
 *
 * How pi-lab is found: pi loads packages from `<agentDir>/settings.json`
 * `packages[]` (paths relative to the agent dir; agentDir =
 * PI_CODING_AGENT_DIR or ~/.pi/agent). The pi-lab entry is the one that holds
 * `extensions/mcp-client.ts`. PIBOT_PI_LAB_DIR overrides the lookup.
 *
 * How the revision is judged (either is enough):
 *   1. git: MIN_PI_LAB_REV is an ancestor of the checkout's HEAD (pi runs the
 *      working tree, so HEAD is what runs);
 *   2. feature markers in the source, for exports and containers with no git
 *      history (a second-user container pins a pi-lab export).
 *
 * Never throws. An unknown pi-lab (none found, unreadable) is reported as not
 * compatible: the MCP-config fd needs pi-lab to read it, and a pi that ignores
 * the fd would run the bot with no MCP servers at all — so "auto" delivery
 * falls back to the file when this check fails (see mcp-delivery.mjs).
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

export const MIN_PI_LAB_REV = "c3aed09";

const MARKERS = [
  { file: join("extensions", "mcp-client.ts"), needle: "PI_BOT_MCP_CONFIG_FD" },
  { file: join("extensions", "permission-gating.ts"), needle: "read_paths" },
  { file: join("extensions", "shared", "bot-bash-auto.ts"), needle: "CUT_MARKER_RE" },
  { file: join("extensions", "shared", "launcher-pin.ts"), needle: "releaseLauncher" },
];

/** The pi agent dir pi itself would use. */
export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
}

/** Locate the pi-lab checkout pi loads, or null. */
export function findPiLabDir({ env = process.env } = {}) {
  if (env.PIBOT_PI_LAB_DIR) return env.PIBOT_PI_LAB_DIR;
  const agentDir = piAgentDir(env);
  let settings;
  try { settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")); } catch { return null; }
  const pkgs = Array.isArray(settings && settings.packages) ? settings.packages : [];
  for (const p of pkgs) {
    const src = typeof p === "string" ? p : (p && typeof p.source === "string" ? p.source : null);
    if (!src || /^(npm|git|https?):/.test(src)) continue;
    const dir = isAbsolute(src) ? src : resolve(agentDir, src);
    if (existsSync(join(dir, "extensions", "mcp-client.ts"))) return dir;
  }
  return null;
}

function gitAncestor(dir, rev) {
  try {
    execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", rev, "HEAD"],
      { stdio: "ignore", timeout: 5000 });
    return true;
  } catch { return false; }
}

function markersPresent(dir) {
  try {
    return MARKERS.every((m) => readFileSync(join(dir, m.file), "utf8").includes(m.needle));
  } catch { return false; }
}

/**
 * @returns {{ok: boolean, dir: string|null, how: "git"|"markers"|null, reason: string|null}}
 */
export function checkPiLabCompat({ env = process.env, dir: dirOverride } = {}) {
  const dir = dirOverride || findPiLabDir({ env });
  if (!dir) {
    return { ok: false, dir: null, how: null,
      reason: "pi-lab not found in " + join(piAgentDir(env), "settings.json") + " packages[] (set PIBOT_PI_LAB_DIR to point at it)" };
  }
  if (existsSync(join(dir, ".git")) && gitAncestor(dir, MIN_PI_LAB_REV)) return { ok: true, dir, how: "git", reason: null };
  if (markersPresent(dir)) return { ok: true, dir, how: "markers", reason: null };
  return { ok: false, dir, how: null,
    reason: "pi-lab at " + dir + " predates " + MIN_PI_LAB_REV + " (no bash ask/auto; before c8bbb02 also no bot read confinement, no PI_BOT_MCP_CONFIG_FD)" };
}

let _cached = null;
let _cachedAt = 0;
let _warnedKey = null;

/** Re-check interval: a pi-lab checkout changed under a long-lived gateway
 *  is picked up within this window, without a restart. */
export const PI_LAB_COMPAT_TTL_MS = 5 * 60 * 1000;

/** Cached per process for PI_LAB_COMPAT_TTL_MS. `_reset` is a test seam. */
export function piLabCompat({ _reset = false } = {}) {
  if (_reset) { _cached = null; _cachedAt = 0; _warnedKey = null; }
  if (!_cached || Date.now() - _cachedAt > PI_LAB_COMPAT_TTL_MS) {
    _cached = checkPiLabCompat();
    _cachedAt = Date.now();
  }
  return _cached;
}

/**
 * Boot-time check: log ONE clear line, a warning when pi-lab is older than
 * MIN_PI_LAB_REV. Never throws, never blocks boot. Returns the result.
 */
export function warnIfPiLabIncompatible(log = (m) => console.warn(m), { onlyProblems = false } = {}) {
  const r = piLabCompat();
  // Once per process per distinct result, so a pi-lab change is announced
  // too. onlyProblems: the per-turn caller stays silent while all is well.
  const key = (r.ok ? "ok:" : "bad:") + (r.dir || "") + ":" + (r.reason || "");
  if (_warnedKey === key || (onlyProblems && r.ok)) return r;
  _warnedKey = key;
  if (r.ok) {
    log("[pi-lab] " + r.dir + " is at or after " + MIN_PI_LAB_REV + " (" + r.how + ") — bot read confinement + MCP config over fd available");
  } else {
    log("[pi-lab] WARNING: " + r.reason + ". Crow needs pi-lab >= " + MIN_PI_LAB_REV +
      ": without it a bot's read tools are NOT confined to its own world and its MCP config (signed actor headers) " +
      "must be written to disk as .mcp.json. Update pi-lab (git -C <pi-lab> pull) and restart.");
  }
  return r;
}
