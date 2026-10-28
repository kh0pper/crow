/**
 * Live browser tile: the pure half of the Perch engine's browser wiring.
 *
 * The engine (perch-interactive.js) owns the timing: it watches its own child
 * events, renews and releases the shared browser lease
 * (servers/shared/browser-lease.js) and emits the tile frames. These helpers
 * decide WHAT those events mean, without any I/O except browserInstalled().
 *
 * Nothing here ever logs, and nothing here ever reads a URL: the tile's domain
 * comes from the gateway's own CDP watcher (a later task), never from a tool's
 * arguments or the lease file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFree } from "../../shared/browser-lease.js";

/** The gateway renews a session's lease at most this often (spec §7 item 8). */
export const RENEW_MS = 10_000;
/** Every gateway lease write breaks a lock older than this, whatever its pid (Ruling B3). */
export const FORCE_BREAK_AFTER_MS = 30_000;

const TOOL_PREFIX = "crow_browser_";
// mcp__<server>__crow_browser_<name>: the server name is whatever the bot's MCP
// config called the browser (the add-on id `browser`, or `crow-browser`).
const DIRECT_RE = /^mcp__([A-Za-z0-9][A-Za-z0-9._-]*)__crow_browser_[a-z0-9_]+$/;
// Router mode: one tool per server, the real tool rides args.tool.
const ROUTER_RE = /^mcp__[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROUTED_RE = /^crow_browser_[a-z0-9_]+$/;

/** args as pi sent them: an object, or a JSON string; anything else → null. */
function argsObject(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args !== "string" || args.length > 65536) return null;
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Is this child tool call a crow-browser call?
 *   - `mcp__<server>__crow_browser_*`
 *   - router `mcp__<server>` whose `args.tool` starts `crow_browser_`
 * Parsed defensively: a malformed args payload is simply "not a browser call".
 */
export function isBrowserTool(toolName, args) {
  if (typeof toolName !== "string" || toolName.length > 256) return false;
  if (DIRECT_RE.test(toolName)) return true;
  if (!ROUTER_RE.test(toolName)) return false;
  const a = argsObject(args);
  const tool = a && a.tool;
  return typeof tool === "string" && tool.length <= 128 && tool.startsWith(TOOL_PREFIX) && ROUTED_RE.test(tool);
}

/** The lease, read at `now`, is held by this Perch session's bot (not expired). */
export function heldBySession(lease, sessionId, now = Date.now()) {
  return !!lease && !isFree(lease, now) && !!lease.holder
    && lease.holder.kind === "bot" && lease.holder.sessionId === sessionId;
}

/** The lease names this session as its holder at all (expired or not): what release() would free. */
export function namesSession(lease, sessionId) {
  return !!lease && !!lease.holder && lease.holder.kind === "bot" && lease.holder.sessionId === sessionId;
}

/**
 * The `live` frame this lease means for session `s`, or null.
 * Live only when the lease is held by THIS session AND the session has a turn
 * in flight that has made a browser call (spec §7 item 4): a lease left over
 * from a dead gateway, or naming a session with no turn, lights nothing.
 */
export function tileEventFor(lease, s, now = Date.now()) {
  if (!s || !s.turn || !s.turn.browser) return null;
  if (!heldBySession(lease, s.sessionId, now)) return null;
  const rec = s.turn.browser;
  return { type: "browser", phase: "live", anchor: rec.anchor || null, domain: rec.domain || null, gen: lease.gen };
}

/** The `done` frame for a tile record. `shot` is { id, url } or null. */
export function doneEventFor(rec, { shot = null, operator = false } = {}) {
  return {
    type: "browser",
    phase: "done",
    anchor: rec.anchor || null,
    domain: rec.domain || null,
    shot: validShot(shot),
    note: operator ? "operator" : null,
  };
}

/** A final-shot hook's answer, kept only when it is the { id, url } shape. */
export function validShot(shot) {
  if (!shot || typeof shot !== "object") return null;
  const id = shot.id;
  const url = shot.url;
  if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0) && !(typeof id === "string" && id && id.length <= 128)) return null;
  if (typeof url !== "string" || !url.startsWith("/") || url.length > 512) return null;
  return { id, url };
}

/** A domain from the gateway's CDP watcher: a short string, or null. */
export function validDomain(domain) {
  return typeof domain === "string" && domain.length > 0 && domain.length <= 253 ? domain : null;
}

/** Is the browser bundle installed on THIS instance (<crowHome>/installed.json lists `browser`)? */
export function browserInstalled(crowHome) {
  if (!crowHome) return false;
  let list;
  try { list = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8")); } catch { return false; }
  const ids = Array.isArray(list)
    ? list.map((x) => (typeof x === "string" ? x : x && x.id))
    : Object.keys(list || {});
  return ids.includes("browser");
}

/** A lease error as a log-safe word (no paths, no URLs). */
export function leaseErrorText(e) {
  const code = e && typeof e.code === "string" && /^[A-Z_]{1,32}$/.test(e.code) ? e.code : null;
  return code || "lease error";
}
