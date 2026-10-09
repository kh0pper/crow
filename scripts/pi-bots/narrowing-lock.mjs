/**
 * Locked narrowings (Crow Artifacts untrusted rounds, spec §7.3).
 *
 * bot_sessions.narrowed_tools is a DISABLE list (Perch narrows, Bot Builder
 * widens). A disable list alone cannot hold an untrusted round closed: a tool
 * granted to the bot after the round started would simply not be on it. A
 * locked narrowing therefore carries two sentinels that are never real tool
 * ids (pi ids are `mcp__…` or bare builtin names):
 *   "crow:locked"          — the narrowing may only grow (routes/perch.js);
 *   "crow:only:<prefix>"   — ALLOW list: only tools equal to or starting with
 *                            a listed prefix survive (bridge applySessionNarrowing).
 * A lock without any allow entry keeps NO tools. Only the engine's
 * spawn({narrowedTools}) may write sentinels; the operator's narrow route
 * strips any "crow:" entry it is sent.
 */
export const NARROWING_LOCK = "crow:locked";
export const ALLOW_ONLY_PREFIX = "crow:only:";
export const isSentinel = (t) => typeof t === "string" && t.startsWith("crow:");

/**
 * THE allow-entry matcher (plan review R-M6). An allow prefix names a server
 * as `mcp__<server>__`; a def may grant that server either per tool
 * (`server/tool` → `mcp__server__tool`) or whole (`server` → `mcp__server`).
 * Both match; another server whose name merely starts the same
 * (`mcp__serverX__…`) never does.
 */
export function allowEntryMatches(tool, prefix) {
  if (typeof tool !== "string" || typeof prefix !== "string" || !prefix) return false;
  if (tool === prefix || tool.startsWith(prefix)) return prefix.endsWith("__") || tool === prefix;
  return prefix.endsWith("__") && tool === prefix.slice(0, -2);
}
/** Does this raw column value claim to be locked (even if it no longer parses)? */
export const mentionsLock = (raw) => typeof raw === "string" && raw.includes(NARROWING_LOCK);
