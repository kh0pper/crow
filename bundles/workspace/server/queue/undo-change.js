/**
 * ws_undo_last_change with a change_id (`pc_…`, spec §5.8):
 * - applied_close → its stored version_id → the normal file undo;
 * - applied_live → queue the recorded inverse, but only when it is exact (pinned by pinInverse to one allowed tool on
 *   the same file); its first step re-checks that the original change is still in the file exactly (else changed_since);
 * - applied_live without an exact inverse (or found by postcondition) → undo_via_versions (the live edit was saved
 *   together with the person's own typing, so Crow offers the version from before instead of guessing);
 * - anything else → not_applied.
 */
import { WsError } from "../result.js";
import { workspaceDb, openWorkspaceDb } from "../db.js";
import { stat } from "../nc/dav.js";
import { splitPath } from "../nc/paths.js";
import { docSession } from "../nc/onlyoffice.js";
import { listVersions } from "../nc/versions.js";
import { get, enqueue, cas, claimUndo, releaseUndo, argsOf, preOf, resultOf } from "./store.js";
import { pinInverse } from "./conditions.js";

/** Terminal states in which an undo step changed nothing. */
const NOT_APPLIED = new Set(["failed", "cancelled", "expired"]);
const badId = (m = "That change_id was not issued by the Workspace tools on this Crow.") => new WsError("bad_version_id", m);

async function viaVersions(cfg, row, why) {
  const before = preOf(row)?.base_version || null;
  const kept = before ? await listVersions(cfg, Number(row.file_id)).then((v) => v.some((x) => x.versionId === before), () => false) : false;
  return new WsError("undo_via_versions", `${why} The edit was saved in the editor together with the person's own typing, so Crow will not guess how to take it out. Use ws_drive_list_versions and, if the user agrees, ws_drive_restore_version${kept ? ` with version_id ${before} (the saved version from before that edit)` : ""}.`,
    { path: row.path, file_id: Number(row.file_id), before_version_id: kept ? before : null, versions_tool: "ws_drive_list_versions", restore_tool: "ws_drive_restore_version" });
}

export async function undoQueuedChange(cfg, args, ctx, { fileUndo }) {
  const db = workspaceDb() || await openWorkspaceDb();
  const row = await get(db, String(args.version_id));
  if (!row) throw badId();
  const e = await stat(cfg, splitPath(args.path));
  if (Number(e.fileId) !== Number(row.file_id)) throw badId("That change_id belongs to a different file.");
  if (row.state === "applied_close") {
    if (!row.version_id) throw await viaVersions(cfg, row, "That change was applied but left no undo id.");
    // keep __tool so an undo of a file that is open now is queued like any write
    return fileUndo(cfg, Object.defineProperty({ ...args, version_id: row.version_id }, "__tool", { value: args.__tool }), ctx);
  }
  if (row.state !== "applied_live") throw new WsError("not_applied", row.state === "pending" ? "That change has not been applied yet; cancel it with ws_cancel_change instead." : `That change was not applied (state: ${row.state}), so there is nothing to undo.`, { state: row.state });
  const res = resultOf(row);
  if (res.undone_by) {
    // M5: an earlier undo only blocks a new one while it is waiting or applied. If it ended without applying, the
    // marker is released: cancelled/expired → queue it again; failed (the inverse was no longer exact) → versions.
    const ids0 = String(res.undone_by).split(",");
    const steps = await Promise.all(ids0.map((x) => get(db, x)));
    if (steps.some((r) => !r || !NOT_APPLIED.has(r.state))) throw new WsError("already_undone", "That change was already undone (or its undo is waiting).", { undo_change_ids: ids0 });
    await releaseUndo(db, row.id, String(res.undone_by));
    const failed = steps.find((r) => r.state === "failed");
    if (failed) {
      await db.execute({ sql: "UPDATE workspace_pending_changes SET result_json=json_set(COALESCE(result_json,'{}'),'$.undo_failed',?) WHERE id=?", args: [resultOf(failed).reason || "failed", row.id] });
      res.undo_failed = resultOf(failed).reason || "failed";
    }
  }
  if (res.undo_failed) throw await viaVersions(cfg, row, `Crow's earlier undo of it could not be applied (${res.undo_failed}).`);
  let inverse = null; try { inverse = row.inverse_json ? JSON.parse(row.inverse_json) : null; } catch { inverse = null; }
  const pinned = res.detected ? null : pinInverse(row, inverse);
  if (!pinned) throw await viaVersions(cfg, row, res.detected ? "That change was found already applied in the editor, without a record of what it replaced." : "Crow has no exact way to reverse that live edit.");
  if (!(await claimUndo(db, row.id, "pending"))) throw new WsError("already_undone", "That change was already undone (or its undo is waiting).");
  const key = await docSession(cfg, e.fileId).then((s) => s.key, () => row.doc_key || null);
  const orig = { tool: row.tool, args: argsOf(row), pre: preOf(row) };
  const ids = [];
  try {
    for (const [i, op] of pinned.entries()) {
      const r = await enqueue(db, { fileId: e.fileId, path: e.path, key, tool: op.tool, args: { ...op.args, path: e.path }, precondition: i === 0 ? { undo_of: row.id, orig } : { undo_of: row.id, step: i }, openBy: [], requestedBy: "undo" });
      ids.push(r.id);
    }
  } catch (err) {
    // nothing half-queued survives: cancel the steps already queued, then release the claim so undo can be retried
    for (const id of ids) await cas(db, id, "pending", "cancelled").catch(() => {});
    await releaseUndo(db, row.id, "pending").catch(() => {});
    throw err;
  }
  await db.execute({ sql: "UPDATE workspace_pending_changes SET result_json=json_set(COALESCE(result_json,'{}'),'$.undone_by',?) WHERE id=?", args: [ids.join(","), row.id] });
  return { queued: true, undo_of: row.id, change_ids: ids, change_id: ids[0], path: e.path, file_id: e.fileId, apply: "on_close",
    message: "The undo is queued: it applies as soon as nobody has the file open (or when it is closed). If the text was changed since, it is not undone (changed_since)." };
}
