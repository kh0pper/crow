/** Crow Workspace MCP server (W2): ws_* tools over Nextcloud + ONLYOFFICE as crow-bot. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { registerDrive } from "./tools/drive.js";
import { registerDocs, docsWriteDefs } from "./tools/docs.js";
import { registerUndo } from "./tools/undo.js";
import { systemClock } from "./write-protocol.js";

export const realClock = systemClock;

export const WORKSPACE_INSTRUCTIONS = [
  "Crow Workspace tools (ws_*): files, .docx/.xlsx/.pptx, calendars and contacts in the household's private Nextcloud, as the 'Crow bot' account.",
  "Guardrails: no full-document replace; inserted text never inherits heading styles; comments are listed completely; batch find/replace is atomic; replace_section works heading-to-heading.",
  "Every write returns version_id: tell the user, and pass it to ws_undo_last_change to revert.",
  "If a write returns queued:true, the file is open: tell the user it will apply in their editor or when it closes (ws_change_status reports the outcome). Use if_open:'force_close' only if the user explicitly says to apply now even if it closes the other person's editor.",
].join("\n");

export function createWorkspaceServer({ clock = realClock } = {}) {
  const server = new McpServer({ name: "crow-workspace", version: "0.2.0" }, { instructions: WORKSPACE_INSTRUCTIONS });
  const ctx = Object.freeze({ getConfig, clock });
  const names = [];
  names.push(...registerDrive(server, ctx)); // further tool families register here (Tasks 6-11)
  names.push(...registerDocs(server, ctx, docsWriteDefs));
  names.push(...registerUndo(server, ctx));
  server.__wsToolNames = names;
  return server;
}
