/**
 * MCP Instructions Generator
 *
 * Generates the `instructions` string passed to McpServer constructors.
 * Sent to clients during the MCP handshake (InitializeResult) — the AI
 * sees this before any tool calls, providing behavioral guidance automatically.
 *
 * Used by:
 * - Gateway startup (pre-computed, passed to all server factories)
 * - stdio entry points (generated once at startup)
 * - crow-core (generated once before registering tools)
 */

import { createDbClient } from "../db.js";
import { generateCondensedContext } from "../memory/crow-context.js";

/** Hard cap for instructions string (bytes) */
const MAX_INSTRUCTIONS_LENGTH = 2048;

/**
 * Static fallback when DB is unavailable or crow_context table doesn't exist.
 * ~500 bytes — provides minimal behavioral guidance.
 */
export const STATIC_INSTRUCTIONS = `You are connected to Crow, a persistent AI memory and project management platform.
On session start: call crow_recall_by_context with the user's first message to load relevant memories.
Store important information with crow_store_memory during conversations.
Call crow_get_context for full behavioral guidance and capability reference.
Show brief [crow: action] notes when performing autonomous actions.
Use the session-start or crow-guide prompts for detailed workflow guidance.`;

/**
 * Generate the instructions string for MCP server initialization.
 *
 * Queries the crow_context table for essential behavioral sections,
 * condenses them into a ~1.5KB string, and returns it. Falls back to
 * STATIC_INSTRUCTIONS if the DB is unavailable.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - Database path override
 * @param {boolean} [options.routerStyle=false] - Use category tool names (crow_memory action: "store_memory") instead of direct names
 * @param {string} [options.deviceId=null] - Device ID for per-device context overrides
 * @returns {Promise<string>}
 */
export async function generateInstructions(options = {}) {
  const { dbPath, routerStyle = false, deviceId = null } = options;

  try {
    const db = createDbClient(dbPath);
    const condensed = await generateCondensedContext(db, { routerStyle, deviceId });

    if (!condensed) {
      return STATIC_INSTRUCTIONS;
    }

    // Enforce hard cap
    if (condensed.length > MAX_INSTRUCTIONS_LENGTH) {
      return condensed.slice(0, MAX_INSTRUCTIONS_LENGTH - 3) + "...";
    }

    return condensed;
  } catch {
    // DB unavailable, table doesn't exist, etc.
    return STATIC_INSTRUCTIONS;
  }
}
