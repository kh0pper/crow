/** Crow Workspace MCP server (W2): ws_* tools over Nextcloud + ONLYOFFICE as crow-bot. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { registerDrive } from "./tools/drive.js";
import { registerDocs, docsWriteDefs } from "./tools/docs.js";
import { registerDocComments } from "./tools/docs-comments.js";
import { registerSheets } from "./tools/sheets.js";
import { registerSlides } from "./tools/slides.js";
import { registerUndo } from "./tools/undo.js";
import { registerCalendar } from "./tools/calendar.js";
import { registerContacts } from "./tools/contacts.js";
import { pruneJournal } from "./pim/journal.js";
import { systemClock } from "./write-protocol.js";
import { setQueueProvider } from "./tools/common.js";
import { queueDescriptor } from "./queue/provider.js";
import { registerQueue } from "./tools/queue.js";

export const realClock = systemClock;

export const WORKSPACE_INSTRUCTIONS = [
  "Crow Workspace tools (ws_*): files, .docx/.xlsx/.pptx, calendars and contacts in the household's private Nextcloud, as the 'Crow bot' account.",
  "Guardrails: no full-document replace; inserted text never inherits heading styles; comments are listed completely; batch find/replace is atomic; replace_section works heading-to-heading.",
  "Every write returns version_id: tell the user, and pass it to ws_undo_last_change to revert.",
  "If a write returns queued:true, the file is open: tell the user it will apply in their editor or when it closes (ws_change_status reports the outcome). Use if_open:'force_close' only if the user explicitly says to apply now even if it closes the other person's editor.",
].join("\n");

export function createWorkspaceServer({ clock = realClock } = {}) {
  const server = new McpServer({ name: "crow-workspace", version: "0.2.1" }, { instructions: WORKSPACE_INSTRUCTIONS });
  const ctx = Object.freeze({ getConfig, clock });
  const names = [];
  names.push(...registerDrive(server, ctx)); // further tool families register here (Tasks 6-11)
  names.push(...registerDocs(server, ctx, docsWriteDefs));
  names.push(...registerDocComments(server, ctx));
  names.push(...registerSheets(server, ctx));
  names.push(...registerSlides(server, ctx));
  names.push(...registerCalendar(server, ctx));
  names.push(...registerContacts(server, ctx));
  names.push(...registerUndo(server, ctx));
  // K5: writes to an open/locked file become pending changes (the crow.db client opens lazily on first use)
  setQueueProvider(queueDescriptor);
  names.push(...registerQueue(server, ctx));
  // spec §5.5: prune the PIM undo journal at start and every 6 h (30 days / 500 entries)
  try { pruneJournal(); } catch { /* never block startup */ }
  const pruneTimer = setInterval(() => { try { pruneJournal(); } catch { /* next round */ } }, 6 * 3600e3); pruneTimer.unref();
  server.__wsToolNames = names;
  return server;
}
