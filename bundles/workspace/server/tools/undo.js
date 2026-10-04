import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import { undoFileChange } from "../write-protocol.js";
import { writeOpts, writeOptsOf } from "./common.js";
import { loadChange } from "../pim/journal.js";
import { getObject, putChecked, deleteObject, journaledWrite } from "../pim/caldav.js";
import { pimHrefToSegs } from "../nc/paths.js";

/** Task 10 adds the "j1." (calendar/contacts journal) branch; Task 12 the "pc_" (queued change) dispatch. */
// K5: undo is queueable like any write (default queue, wait 0). A queued FILE undo still re-checks the etag at apply time,
// so if the person typed meanwhile it ends in changed_since; the skill says so.
export const undoHandlers = { v1: (cfg, args, ctx) => undoFileChange(cfg, { path: args.path }, args.version_id, { clock: ctx.clock, ...writeOptsOf(args) }) };

/**
 * Calendar/contacts undo (spec §5.4/§5.5): put the journaled prior ICS/vCard back with If-Match on the post-change
 * etag; re-create a deleted object at the SAME href with If-None-Match:* (spike S8: Nextcloud answers 201);
 * delete a created one. Refuses with changed_since if it changed after that edit. The undo is itself journaled.
 */
export async function pimUndo(cfg, args) {
  const e = loadChange(args.version_id);
  if (args.path !== e.ref) throw new WsError("bad_version_id", `That version_id belongs to ${e.ref}`);
  // the journal is local data, but its href still goes through paths.js and must sit in the ref's collection
  const kind = String(e.ref).startsWith("cal:") ? "cal" : String(e.ref).startsWith("contacts:") ? "card" : null;
  const segs = kind ? pimHrefToSegs(cfg, kind, e.href) : [];
  if (!kind || kind !== e.kind || segs.length !== 2 || String(e.ref).slice(kind === "cal" ? 4 : 9).split("/")[0] !== segs[0]) throw new WsError("bad_version_id", "That journal entry does not match its ref.");
  const base = { kind: e.kind, ref: e.ref, href: e.href };
  const cur = await getObject(cfg, e.href);
  const changedSince = () => new WsError("changed_since", "It changed after that edit, so nothing was undone. Read it again and decide what to change.");
  if (e.op === "delete") {
    if (cur) throw changedSince();
    const version_id = await journaledWrite(cfg, { ...base, op: "create", before_text: null }, () => putChecked(cfg, e.href, e.before_text, { ifNoneMatch: "*" }, "restore it"));
    return { ref: e.ref, undone: "restored", version_id };
  }
  if (!cur || !e.after_etag || cur.etag !== e.after_etag) throw changedSince();
  if (e.op === "create") {
    try {
      const version_id = await journaledWrite(cfg, { ...base, op: "delete", before_text: cur.text }, () => deleteObject(cfg, e.href, cur.etag));
      return { ref: e.ref, undone: "removed", version_id };
    } catch (err) { if (err instanceof WsError && err.code === "changed_concurrently") throw changedSince(); throw err; } // review T10-I4
  }
  try {
    const version_id = await journaledWrite(cfg, { ...base, op: "update", before_text: cur.text }, () => putChecked(cfg, e.href, e.before_text, { ifMatch: cur.etag }, "revert it"));
    return { ref: e.ref, undone: "reverted", version_id };
  } catch (err) { if (err instanceof WsError && err.code === "changed_concurrently") throw changedSince(); throw err; }
}
undoHandlers.j1 = (cfg, args) => pimUndo(cfg, args);

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
