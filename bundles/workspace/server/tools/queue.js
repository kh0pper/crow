/** Spec §5.6: status and cancel of a queued change (the bot's view of the K5 queue). */
import { z } from "zod";
import { defineTools } from "./define.js";
import { workspaceDb, openWorkspaceDb } from "../db.js";
import { get, cas, publicRow, notPending, noSuchChange, CHANGE_ID_RE } from "../queue/store.js";

export const changeIdSchema = z.string().regex(CHANGE_ID_RE).describe("change_id returned by a queued write");
const dbOf = async () => workspaceDb() || openWorkspaceDb();
export const queueDefs = [
  { name: "ws_change_status", description: "Status of a queued change: pending, applied_live (in the editor), applied_close (with version_id for undo), failed (with reason), expired, cancelled; plus who has the file open.",
    schema: { change_id: changeIdSchema },
    run: async ({ change_id }) => { const r = await get(await dbOf(), change_id); if (!r) throw noSuchChange(); return publicRow(r); } },
  { name: "ws_cancel_change", description: "Cancel a queued change that has not been applied yet (only while pending).",
    schema: { change_id: changeIdSchema },
    run: async ({ change_id }) => {
      const db = await dbOf(); const r = await get(db, change_id); if (!r) throw noSuchChange();
      if (!(await cas(db, change_id, "pending", "cancelled"))) throw notPending();
      return publicRow(await get(db, change_id));
    } },
];
export const registerQueue = (server, ctx) => defineTools(server, ctx, queueDefs);
