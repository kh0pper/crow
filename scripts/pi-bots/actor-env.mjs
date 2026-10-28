// Actor identity for a pi bot's stdio MCP servers. The gateway writes these
// into each stdio block's env when it builds the per-turn config, so a server
// that writes comments can label them as coming from a bot. The actor is
// never derived from tool arguments.

/** Strip control (\p{Cc}) and format (\p{Cf}: bidi overrides, zero-width)
 *  characters, trim, cap at 40 chars; fall back to the bot id. */
export function sanitizeActorName(name, fallbackId) {
  const clean = String(name == null ? "" : name)
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  const capped = Array.from(clean).slice(0, 40).join("").trim();
  return capped || String(fallbackId == null ? "" : fallbackId);
}

export function actorEnvFor({ botId, displayName }) {
  return {
    CROW_ACTOR_KIND: "bot",
    CROW_ACTOR_BOT_ID: String(botId),
    CROW_ACTOR_BOT_NAME: sanitizeActorName(displayName, botId),
  };
}

/** Replaces each active stdio block (never mutates the shared block object). */
export function applyActorEnv(mcpServers, actorEnv) {
  for (const [name, block] of Object.entries(mcpServers || {})) {
    if (!block || typeof block !== "object" || block.url || block.disabled) continue;
    mcpServers[name] = { ...block, env: { ...(block.env || {}), ...actorEnv } };
  }
}
