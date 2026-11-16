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

export function actorEnvFor({ botId, displayName, threadId }) {
  const env = {
    CROW_ACTOR_KIND: "bot",
    CROW_ACTOR_BOT_ID: String(botId),
    CROW_ACTOR_BOT_NAME: sanitizeActorName(displayName, botId),
  };
  // The thread the bot is answering in, only when there is one.
  if (typeof threadId === "string") {
    const thread = Array.from(threadId.replace(/[\p{Cc}\p{Cf}]/gu, "")).slice(0, 200).join("");
    if (thread) env.CROW_ACTOR_THREAD = thread;
  }
  return env;
}

/**
 * The env the bot engine puts on pi's OWN process, so every MCP server pi spawns inherits the
 * bot's identity even when its block carries no env of its own:
 *
 *   CROW_ACTOR_KIND / CROW_ACTOR_BOT_ID / CROW_ACTOR_BOT_NAME  who the bot is (actor-env above)
 *   CROW_BOT_SESSION=<botId>                                   the engine-reserved session marker
 *
 * The marker is not a claim a caller can make: it is engine-owned and `actorFromEnv` refuses any
 * env where it disagrees with the bot id, so a bot reaching an MCP server cannot borrow the
 * operator's scope by leaving the actor out. `botId` must come from the engine (never a bot
 * definition, which is bot-writable).
 */
export function botSessionEnv(botId, displayName) {
  const id = String(botId);
  return { ...actorEnvFor({ botId: id, displayName }), CROW_BOT_SESSION: id };
}

/** Replaces each active stdio block (never mutates the shared block object). */
export function applyActorEnv(mcpServers, actorEnv) {
  for (const [name, block] of Object.entries(mcpServers || {})) {
    if (!block || typeof block !== "object" || block.url || block.disabled) continue;
    mcpServers[name] = { ...block, env: { ...(block.env || {}), ...actorEnv } };
  }
}
