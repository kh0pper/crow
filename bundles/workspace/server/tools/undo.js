import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import { undoFileChange } from "../write-protocol.js";
import { writeOpts, writeOptsOf } from "./common.js";

/** Task 10 adds the "j1." (calendar/contacts journal) branch; Task 12 the "pc_" (queued change) dispatch. */
// K5: undo is queueable like any write (default queue, wait 0). A queued FILE undo still re-checks the etag at apply time,
// so if the person typed meanwhile it ends in changed_since; the skill says so.
export const undoHandlers = { v1: (cfg, args, ctx) => undoFileChange(cfg, { path: args.path }, args.version_id, { clock: ctx.clock, ...writeOptsOf(args) }) };

export const undoDef = {
  name: "ws_undo_last_change",
  description: "Undo one Crow change: pass the path (or the cal:/contacts: ref) and the version_id that change returned. Refuses if someone changed it since.",
  schema: { path: z.string().max(4096), version_id: z.string().max(2048), ...writeOpts },
  run: async (args, c) => {
    const kind = String(args.version_id).split(".")[0];
    const h = Object.hasOwn(undoHandlers, kind) ? undoHandlers[kind] : null;
    if (!h) throw new WsError("bad_version_id", "That version_id was not issued by the Workspace tools.");
    return h(c.getConfig(), args, c);
  },
};

export function registerUndo(server, ctx) { return defineTools(server, ctx, [undoDef]); }
