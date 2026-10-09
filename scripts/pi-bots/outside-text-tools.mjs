/**
 * D22 (Kevin, 2026-10-08): a session that reads OUTSIDE text through its own
 * tools is untrusted from then on (its Artifacts versions render with scripts
 * off until the owner approves them). Outside text = web fetch, browser, mail,
 * inbox/messages, RSS, research fetch, and any tool whose output can carry
 * third-party text.
 *
 * FAIL CLOSED: this is an ALLOW list of tools known NOT to return third-party
 * text. Every other tool taints — bash, file reads (a downloaded file is
 * third-party text), memory, board, any unknown add-on tool. The taint is
 * recorded server-side by the Perch engine at tool-call START, keyed by the
 * engine's own (bot, thread), never by anything the bot says.
 *
 * Why these are clean:
 *   write / edit         return a status, not content
 *   ask_user             returns the OWNER's own answer
 *   send_user_file       returns a delivery status
 *   mcp__artifacts__*    every bot-facing read passes the Artifacts taint gate:
 *                        non-owner text comes back "[withheld]"
 */
export const CLEAN_TOOLS = Object.freeze(["write", "edit", "ask_user", "send_user_file"]);

/**
 * Provenance (plan re-check 2, R3-L1): clean MCP tools are matched EXACTLY
 * against the core artifacts server's tool names (mcp.js TOOL_CLASSES; a
 * parity test keeps the two lists equal), never by prefix — so a server whose
 * key merely begins with "artifacts__" is not clean. Builtin names count as
 * clean only while the session loads NO third-party pi extension (one could
 * register a tool under a builtin's name).
 *
 * Residual, recorded here per the reviewer: `edit` reports whether a guessed
 * string exists in a file ("Could not find the exact text"), a slow one-bit
 * read. Accepted: it reads only files the session can already write.
 */
export const CLEAN_MCP_TOOLS = Object.freeze([
  "mcp__artifacts__artifact_create", "mcp__artifacts__artifact_update", "mcp__artifacts__artifact_get", "mcp__artifacts__artifact_list",
  "mcp__artifacts__artifact_comments", "mcp__artifacts__artifact_reply", "mcp__artifacts__artifact_resolve", "mcp__artifacts__artifact_round_done",
]);

export function taintsSession(toolName, { thirdPartyExtensions = false } = {}) {
  if (typeof toolName !== "string" || !toolName) return true;   // unknown → taints
  if (CLEAN_MCP_TOOLS.includes(toolName)) return false;
  if (!thirdPartyExtensions && CLEAN_TOOLS.includes(toolName)) return false;
  return true;
}
