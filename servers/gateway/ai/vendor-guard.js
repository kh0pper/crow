/**
 * Cross-vendor tool-use guard.
 *
 * chat_messages.tool_calls JSON is vendor-specific (OpenAI function-call
 * schema vs Anthropic tool_use blocks vs Gemini functionCall parts). The
 * recent-messages window at chat.js feeds tool_calls back into the
 * adapter blindly. A mid-conversation vendor switch would reach a 400 at
 * the adapter or silently degrade.
 *
 * This module detects when a proposed model switch would change the
 * conversation's vendor AND the conversation has active tool_calls in
 * its recent history. Same-vendor switches (gpt-4o → gpt-4o-mini,
 * claude-3.5-sonnet → claude-3-haiku) are always fine.
 *
 * v2 (deferred): a canonical-tool-call translator at the adapter layer.
 */

/**
 * Collapse any provider-ish label (a providers.provider_type value, the
 * legacy chat_conversations.provider string, or a models.json adapter
 * key) into a canonical vendor bucket. Bucket equality means the two
 * models speak the same tool-call schema.
 *
 * Buckets:
 *   openai      — OpenAI + OpenRouter + OpenAI-compat + Meta + Ollama
 *                 (Ollama's /api/chat adapter speaks OpenAI-flavored
 *                 tool_calls via its compat layer)
 *   anthropic   — Anthropic Messages API
 *   google      — Google Gemini API
 *
 * Local bundle providers (bundle_id IS NOT NULL, provider_type IS NULL)
 * are effectively openai-shaped because they run vLLM/llama.cpp with
 * OpenAI-compatible endpoints. Returns "openai" for them unless
 * a caller passes a more specific provider_type.
 */
export function vendorBucket(label) {
  if (!label) return "openai";
  const lower = String(label).toLowerCase();
  if (lower === "anthropic") return "anthropic";
  if (lower === "google") return "google";
  // openai, openai-compat, openrouter, meta, ollama → openai bucket
  return "openai";
}

/**
 * Check whether any recent assistant message in `convId` carries
 * tool_calls. Scans the same window the adapter replays (CONTEXT_WINDOW
 * messages). A conversation that has ever used tools is frozen at its
 * current vendor until the user starts a new chat.
 *
 * @param {object} db  libsql client
 * @param {number} convId
 * @param {number} [windowLimit=20]
 * @returns {Promise<boolean>}
 */
export async function hasActiveToolCalls(db, convId, windowLimit = 20) {
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM chat_messages
          WHERE conversation_id = ?
            AND tool_calls IS NOT NULL
            AND tool_calls != ''
          ORDER BY id DESC
          LIMIT ?`,
    args: [convId, windowLimit],
  });
  return rows.length > 0;
}

/**
 * Given a conversation's current provider label and a proposed new
 * provider label, return an error object when the switch is blocked.
 * Caller converts this into a 400 response.
 *
 * @param {object} db
 * @param {number} convId
 * @param {string} currentLabel  current vendor (conversation.provider or provider_type)
 * @param {string} proposedLabel vendor of the new provider
 * @returns {Promise<null | { code: string, message: string }>}
 */
export async function checkVendorSwitch(db, convId, currentLabel, proposedLabel) {
  const currentBucket = vendorBucket(currentLabel);
  const proposedBucket = vendorBucket(proposedLabel);
  if (currentBucket === proposedBucket) return null;
  if (!(await hasActiveToolCalls(db, convId))) return null;
  return {
    code: "cross_vendor_tool_lock",
    message: `Cannot switch model vendors (${currentBucket} → ${proposedBucket}) in a conversation with active tool calls. Start a new chat to change vendors.`,
  };
}
