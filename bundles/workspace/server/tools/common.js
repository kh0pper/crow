import { z } from "zod";
import { WsError } from "../result.js";
export const fileRef = {
  path: z.string().max(4096).optional().describe("Path inside Crow's Workspace drive, e.g. 'Shared with Crow/Casa Nueva/Menu.xlsx'"),
  file_id: z.number().int().positive().optional().describe("Nextcloud file id (alternative to path)"),
};
export const writeOpts = {
  wait_s: z.number().int().min(0).max(30).optional().describe("Seconds to wait if the file is open before queueing (default 0)"),
  if_open: z.enum(["queue", "wait", "force_close"]).optional().describe("queue (default): if open, the change waits and applies live or when closed. force_close ONLY if the user explicitly said to apply now even if it closes their editor"),
};
/** K5: the queue provider is installed by createWorkspaceServer (Task 12); without one (and for non-queueable tools) queue = null → "wait" semantics. */
let queueProvider = null;
export const setQueueProvider = (fn) => { queueProvider = fn; };
export function refOf(args) {
  if (args.file_id !== undefined) return { file_id: args.file_id };
  if (typeof args.path === "string") return { path: args.path };
  throw new WsError("bad_ref", "give a path (or file_id)");
}
/**
 * __tool (non-enumerable, set by defineTools) selects the queue descriptor; the close-time applier passes __tool null
 * (queue off) and __label ("Crow (queued)" / "Quick edit") for the version labels.
 */
export const writeOptsOf = (args) => ({ waitS: args.wait_s ?? 0, ifOpen: args.if_open ?? "queue", queue: queueProvider && args.__tool ? queueProvider(args.__tool, args) : null, ...(args.__label ? { label: args.__label } : {}) });
export function toPublic(e, cfg) {
  return { path: e.path, name: e.name, file_id: e.fileId, type: e.isFolder ? "folder" : "file", size: e.size, modified: e.modified, mime: e.mime, locked: e.lock, web_url: `${cfg.webBase}/f/${e.fileId}` };
}
