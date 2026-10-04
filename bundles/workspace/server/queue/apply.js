/**
 * Close-time apply of one queued change (spec §5.8). Runs the tool's own run() with the queue OFF (`__tool: null`)
 * and if_open "wait", after re-validating the precondition on the saved file. Every transition is a CAS, so a second
 * applier (or the live plugin) can never apply the same change again.
 */
import { getFile } from "../nc/dav.js";
import { splitPath } from "../nc/paths.js";
import { MAX_EDIT_BYTES } from "../write-protocol.js";
import { checkPre, checkPost } from "./conditions.js";
import { cas, argsOf, preOf, resultOf, markVerified } from "./store.js";
import { ALL_DEFS } from "../tools/all.js";

/** Version labels of close-time applies: "Crow (queued): …"; Quick edit keeps "Quick edit: …" (both match CROW_LABEL_RE). */
export const labelFor = (row) => (row.requested_by === "quick_edit" ? "Quick edit" : row.requested_by === "undo" ? "Undo (queued)" : "Crow (queued)");
/** Errors that mean "not now" (the file was re-opened or is busy): nothing was written, the change waits again. */
const TRANSIENT = new Set(["open_in_editor", "locked_by_person", "stale_editor_lock", "locked", "busy", "changed_concurrently", "editor_unreachable", "could_not_close_editor"]);
/** The tool's own anchor errors: the target is gone → target_changed. */
const ANCHOR = new Set(["not_found", "heading_not_found", "tab_not_found", "slide_not_found", "shape_not_found", "comment_not_found", "target_changed", "already_resolved"]);
const res = (row, extra) => JSON.stringify({ ...resultOf(row), ...extra });
const readSaved = async (ctx, row) => (await getFile(ctx.getConfig(), splitPath(row.path), { maxBytes: MAX_EDIT_BYTES })).bytes;

async function fail(db, row, from, reason, extra = {}) {
  await cas(db, row.id, from, "failed", { result_json: res(row, { reason, ...extra }) });
  return { state: "failed", reason, ...extra };
}

/** Run the claimed change (state applying_close). `pre` already passed. */
async function runClaimed(ctx, db, row) {
  const args = argsOf(row); const def = ALL_DEFS.get(row.tool);
  if (!def) return fail(db, row, "applying_close", "unsupported");
  const callArgs = Object.defineProperties({ ...args, if_open: "wait", wait_s: 0 }, { __tool: { value: null }, __label: { value: labelFor(row) } });
  let out;
  try { out = await def.run(callArgs, ctx); }
  catch (e) {
    if (TRANSIENT.has(e.code)) { await cas(db, row.id, "applying_close", "pending"); return { state: "pending", reason: e.code }; } // re-opened meanwhile: nothing written
    if (e.code === "changed_since") return fail(db, row, "applying_close", "changed_since");
    // spec §5.8: an undo whose target moved on answers changed_since; any other change target_changed
    if (ANCHOR.has(e.code)) return fail(db, row, "applying_close", row.requested_by === "undo" ? "changed_since" : "target_changed", { detail: e.code });
    // Unexpected error: it may have come AFTER the save (labels, stat). The postcondition decides — never a re-apply.
    let post = null; try { post = checkPost(row.tool, args, await readSaved(ctx, row), preOf(row)); } catch { post = null; }
    if (post === true) { await cas(db, row.id, "applying_close", "applied_close", { result_json: res(row, { detected: true, warning: String(e.message).slice(0, 200) }) }); return { state: "applied_close", detected: true }; }
    return fail(db, row, "applying_close", e.code || "error", { message: String(e.message).slice(0, 300) });
  }
  if (!out || out.changed === 0 || out.changed === false) return fail(db, row, "applying_close", row.requested_by === "undo" ? "changed_since" : "target_changed", { detail: "nothing_to_change" });
  await cas(db, row.id, "applying_close", "applied_close", { version_id: out.version_id ?? null, result_json: res(row, { changed: out.changed ?? 1, version_label: out.version_label ?? null, ...(out.label_warning ? { label_warning: out.label_warning } : {}) }) });
  return { state: "applied_close", version_id: out.version_id ?? null };
}

/**
 * Apply one row that nextApplicable returned (pending or unknown_after_claim).
 * unknown_after_claim (spec §5.6): postcondition present → applied_live (detected); else precondition still true →
 * apply; else failed: ambiguous. Never applied twice.
 */
export async function applyQueued(ctx, db, row) {
  const args = argsOf(row); const pre = preOf(row);
  if (row.state === "unknown_after_claim") {
    const bytes = await readSaved(ctx, row);
    const post = checkPost(row.tool, args, bytes, pre);
    if (post === true) return (await cas(db, row.id, "unknown_after_claim", "applied_live", { verified: 1, result_json: res(row, { detected: true }) })) ? { state: "applied_live", detected: true } : { state: "skipped" };
    if (post === null) return fail(db, row, "unknown_after_claim", "ambiguous");
    if (!(await cas(db, row.id, "unknown_after_claim", "applying_close"))) return { state: "skipped" };
    const p = checkPre(row.tool, args, pre, bytes);
    if (!p.ok) return fail(db, row, "applying_close", "ambiguous");
    return runClaimed(ctx, db, row);
  }
  if (row.state !== "pending" || !(await cas(db, row.id, "pending", "applying_close"))) return { state: "skipped" };
  let bytes;
  try { bytes = await readSaved(ctx, row); } catch (e) { await cas(db, row.id, "applying_close", "pending"); return { state: "pending", reason: e.code || "read_failed" }; }
  const p = checkPre(row.tool, args, pre, bytes);
  if (!p.ok) return fail(db, row, "applying_close", p.reason);
  return runClaimed(ctx, db, row);
}

/**
 * K5-I3 / R-LIVE (spec §5.7): once the session is over, an applied_live change is checked against the SAVED file.
 * Present → verified. Absent → failed: not_saved + notify — the edit was removed or undone in the editor (Ctrl-Z),
 * or the editor closed before saving; it is NEVER re-applied behind the person's back (a claim-ack is not proof of
 * application, and re-applying could double it or override the person). Undecidable → left unverified.
 */
export async function verifyLive(db, row, bytes) {
  const post = checkPost(row.tool, argsOf(row), bytes, preOf(row));
  if (post === true) { await markVerified(db, row.id); return { state: "applied_live", verified: true }; }
  if (post === null) return { state: "applied_live", verified: false };
  if (!(await cas(db, row.id, "applied_live", "failed", { result_json: res(row, { reason: "not_saved" }) }))) return { state: "skipped" };
  return { state: "failed", reason: "not_saved" };
}
