/**
 * The K5 queue descriptor for withFileWrite/withFileRestore/undoFileChange (installed with setQueueProvider in
 * createWorkspaceServer; Quick edit in the gateway passes it directly). When the write meets a lock it records a
 * pending change with a precondition snapshot of the SAVED file and the current ONLYOFFICE document key.
 */
import { getConfig } from "../config.js";
import { workspaceDb, openWorkspaceDb } from "../db.js";
import { getFile } from "../nc/dav.js";
import { splitPath } from "../nc/paths.js";
import { docSession } from "../nc/onlyoffice.js";
import { MAX_EDIT_BYTES } from "../write-protocol.js";
import { enqueue } from "./store.js";
import { snapshot, QUEUEABLE, liveEligible } from "./conditions.js";
import { notifyChange } from "./notify.js";

const DROP = new Set(["if_open", "wait_s"]);
/** requestedBy: "bot" (MCP tools) | "quick_edit" (its close-time version label stays "Quick edit: …"). */
export function queueDescriptor(tool, args, { requestedBy = "bot" } = {}) {
  if (!QUEUEABLE.has(tool)) return null;
  return {
    // `saved` ({bytes, mtime}): a caller that already read the saved file to check it (Quick edit's guard) passes
    // those bytes, so the snapshot is taken from exactly what was checked — no second read for a save to slip into.
    enqueue: async ({ entry, lock, saved = null }) => {
      const cfg = getConfig(); const db = workspaceDb() || await openWorkspaceDb();
      const { bytes, mtime } = saved || await getFile(cfg, splitPath(entry.path), { maxBytes: MAX_EDIT_BYTES });
      const clean = Object.fromEntries(Object.entries(args).filter(([k]) => !DROP.has(k)));
      const snap = snapshot(tool, clean, bytes); // the tool's own error (bad_range, heading_not_found…) surfaces now, not at close
      const precondition = { ...(snap || {}), base_version: String(mtime) };
      const key = lock.key || (await docSession(cfg, entry.fileId).then((s) => s.key, () => null));
      const openBy = lock.data?.open_by || [];
      const lockType = lock.data?.lock_type || null;
      const row = await enqueue(db, { fileId: entry.fileId, path: entry.path, key, tool, args: clean, precondition, openBy, requestedBy });
      await notifyChange(db, row, "queued");
      const live = lockType === "editor" && liveEligible(tool, clean, precondition);
      const who = openBy.join(", ") || "Someone";
      return {
        queued: true, change_id: row.id, path: entry.path, file_id: entry.fileId, open_by: openBy, lock_type: lockType,
        apply: live ? "live_or_on_close" : "on_close",
        message: lockType === "person"
          ? `${who} locked "${entry.name}". Crow's change is waiting and will be applied after it is unlocked.`
          : `${who} has "${entry.name}" open. Crow's change is waiting and will appear ${live ? "in their editor, or " : ""}when it is closed.`,
      };
    },
  };
}
