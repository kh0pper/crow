/**
 * Quick edit writes (spec §8): one paragraph, cell or slide shape at a time, as crow-bot, through the same write
 * protocol as the tools (a version before every change, labelled "Quick edit: …"). A phone waits at most 10 s for an
 * open file (F16); after that the change is queued (K5) as the equivalent tool op and applied live or at close.
 */
import { WsError } from "../result.js";
import { withFileWrite, withFileRestore, undoFileChange, wasPutSent } from "../write-protocol.js";
import { splitPath } from "../nc/paths.js";
import { getFile } from "../nc/dav.js";
import { kids, NS } from "../ooxml/xml.js";
import { openDocx, paragraphText } from "../ooxml/docx-model.js";
import { setParagraphText, isPlainTextParagraph, passagePrefix, findPassage } from "../ooxml/docx-edit.js";
import { openXlsx, writeRange, readRange } from "../ooxml/xlsx.js";
import { openPptx, editShapeText, shapeById, shapeText } from "../ooxml/pptx.js";
import { queueDescriptor } from "../queue/provider.js";
import { queueDefs } from "../tools/queue.js";
import { cas, CHANGE_ID_RE } from "../queue/store.js";
import { workspaceDb, openWorkspaceDb } from "../db.js";

export const QUICK_MAX_BYTES = 20 * 1024 * 1024;
const WAIT_S = 10; // spec §8 / F16: a phone shouldn't hang for 30 s
const KINDS = ["docx", "xlsx", "pptx"];
const [, cancelChange] = queueDefs; // ws_cancel_change
/** Browsers submit textarea/hidden values with CRLF: normalize both sides, or every multi-line target is "stale". */
const nl = (x) => String(x ?? "").replace(/\r\n?/g, "\n");
const forced = (form) => form.if_open === "force_close";

/** K5: an open file → the edit is queued as the equivalent tool op (applies live through the plugin, or at close). */
function asToolOp(form, value) {
  const path = String(form.path);
  // Final review I2/I1: the prefix is read exactly as rewrite_passages reads it, and expect_text pins the whole
  // paragraph to what the page showed (a person's later edit that keeps the first words is never overwritten).
  if (form.kind === "docx") return ["ws_docs_rewrite_passages", { path, passages: [{ match_prefix: passagePrefix(form.shown), new_text: value, expect_text: form.shown }] }];
  if (form.kind === "xlsx") return ["ws_sheets_write", { path, range: String(form.target), values: [[value]] }];
  return ["ws_slides_edit_text", { path, object_id: String(form.target), new_text: value }];
}
/** force_close = the user's explicit "apply now" (never queued); otherwise queue after the 10 s wait. */
const writeOpts = (form, clock, [tool, args], queueGuard = null) => {
  const queue = forced(form) ? null : queueDescriptor(tool, args, { requestedBy: "quick_edit" });
  return { label: "Quick edit", waitS: WAIT_S, clock, ifOpen: forced(form) ? "force_close" : "queue", queue: queue && queueGuard ? guardedQueue(queue, queueGuard) : queue };
};

const xlsxStale = (wb, target, shown) => { if (String(readRange(wb, target, "FORMULA").values[0]?.[0] ?? "") !== shown) throw new WsError("stale_view", "The sheet changed since this page loaded; reload and try again."); };
const pptxStale = (deck, target, shown) => { if (shapeText(shapeById(deck, target).sp) !== shown) throw new WsError("stale_view", "The slide changed since this page loaded; reload and try again."); };

/** The paragraph the page showed, or a refusal: stale (moved/changed) or not plain text (links, images, fields…). */
function docxTarget(d, target, shown) {
  const p = /^\d{1,6}$/.test(target) ? kids(d.body, NS.w, "p")[Number(target)] : null;
  // Review I6: the form carries the text the page showed; if the paragraph at that index changed, refuse.
  if (!p || paragraphText(p) !== shown) throw new WsError("stale_view", "The document changed since this page loaded; reload and try again.");
  if (!isPlainTextParagraph(p)) throw new WsError("not_plain_text", "This paragraph contains a link, image, field or footnote; edit it in the editor so nothing is lost.");
  return p;
}

/**
 * Final review I1: every Quick edit queue path first checks the SAVED file: the target must still read what the page
 * showed (else stale_view, nothing queued) — the queued twin's own snapshot/precondition then protects it from any
 * later edit (xlsx/pptx: the queued cell/shape value; docx: expect_text).
 * T14-I1: the queued docx twin is rewrite_passages by prefix, which rewrites the FIRST paragraph starting with it.
 * Queue only when that paragraph IS the one the page showed (and the text is not empty); otherwise answer the lock's
 * own refusal (open_in_editor: "try again when the editor closes") so a duplicated prefix never edits another paragraph.
 */
const quickQueueGuard = (cfg, kind, target, shown) => async ({ entry, lock }) => {
  // The bytes checked here are the bytes the queued twin's snapshot is taken from (guardedQueue passes them on):
  // a save landing between two separate reads could otherwise become the "expected" value and be overwritten.
  const saved = await getFile(cfg, splitPath(entry.path), { maxBytes: QUICK_MAX_BYTES });
  const { bytes } = saved;
  if (kind === "xlsx") { xlsxStale(openXlsx(bytes), target, shown); return saved; }
  if (kind === "pptx") { pptxStale(openPptx(bytes), target, shown); return saved; }
  const d = openDocx(bytes);
  const p = docxTarget(d, target, shown);
  const prefix = passagePrefix(shown);
  if (!prefix || findPassage(kids(d.body, NS.w, "p"), prefix) !== p) {
    throw new WsError(lock.code || "open_in_editor", `${lock.message || "The file is open."} This paragraph cannot wait in the queue; try again after the editor closes.`, { ...(lock.data || {}), not_queueable: true });
  }
  return saved;
};
const guardedQueue = (queue, check) => ({ enqueue: async (sig) => { const saved = await check(sig); return queue.enqueue({ ...sig, saved }); } });

/** T14-I2: put a twin cancelled by "Apply now" back in the queue, so a failed forced save never loses the change. */
async function repend(changeId) {
  const db = workspaceDb() || await openWorkspaceDb();
  return cas(db, changeId, "cancelled", "pending");
}

export async function quickSave(cfg, formIn, clock) {
  const cancelFirst = String(formIn.cancel_first ?? "");
  if (!cancelFirst || !forced(formIn)) return save(cfg, formIn, clock);
  if (!CHANGE_ID_RE.test(cancelFirst)) throw new WsError("bad_args", "cancel_first is not a change id");
  // "Yes, apply now" from the queued page: cancel the queued twin first so it can never apply a second time.
  // If it can't be cancelled (already claimed/applied), this throws not_pending and NOTHING is written (review K5-I9).
  await cancelChange.run({ change_id: cancelFirst });
  try { return await save(cfg, formIn, clock); }
  catch (err) {
    // Final review M1: once the PUT was sent the change may already be in the file — never put the twin back (it
    // would apply a second time), and never say "nothing was changed": the waiting change WAS cancelled and the
    // save may or may not have landed.
    if (wasPutSent(err)) throw new WsError("apply_now_unconfirmed", `The waiting change was cancelled and the save was sent, but it could not be confirmed (${err?.code || "error"}); check the file before trying again.`, { change_id: cancelFirst, cause: err?.code || null });
    // T14-I2: the forced save failed BEFORE writing (busy, a person's lock, too large, …): the change goes back in the queue.
    let back = false;
    try { back = await repend(cancelFirst); } catch { back = false; }
    if (!back) throw err;
    throw new WsError("still_waiting", `Could not apply it now (${err?.code || "error"}); your change is still waiting and will be applied when the editor closes.`, { change_id: cancelFirst, cause: err?.code || null });
  }
}

async function save(cfg, formIn, clock) {
  const segs = splitPath(String(formIn.path ?? ""));
  const form = { ...formIn, shown: nl(formIn.shown) };
  const value = nl(form.value).slice(0, 20000);
  const kind = String(form.kind || "");
  const ext = segs.at(-1).toLowerCase().split(".").pop();
  if (!KINDS.includes(kind) || ext !== kind) throw new WsError("wrong_type", "Quick edit works on .docx, .xlsx and .pptx files");
  const target = String(form.target ?? "");
  return withFileWrite(cfg, segs, async (bytes) => {
    if (bytes.length > QUICK_MAX_BYTES) throw new WsError("too_large", "Quick edit handles files up to 20 MB; use the editor on a computer");
    if (kind === "docx") {
      const d = openDocx(bytes);
      setParagraphText(d, docxTarget(d, target, form.shown), value);
      return { bytes: d.pkg.save(), changed: 1, summary: `paragraph ${Number(target) + 1}` };
    }
    if (kind === "xlsx") {
      const wb = openXlsx(bytes);
      xlsxStale(wb, target, form.shown);
      const r = writeRange(wb, target, [[value]], "USER_ENTERED");
      return { bytes: wb.pkg.save(), changed: 1, summary: `cell ${r.range}` };
    }
    const deck = openPptx(bytes);
    pptxStale(deck, target, form.shown);
    editShapeText(deck, target, value);
    return { bytes: deck.pkg.save(), changed: 1, summary: "slide text" };
  }, writeOpts(form, clock, asToolOp({ ...form, kind }, value), quickQueueGuard(cfg, kind, target, form.shown)));
}

/** Undo of a Quick edit: waits 10 s for an open file, then answers open_in_editor (undo is close-time only, spec §5.7). */
export const quickUndo = (cfg, form, clock) => undoFileChange(cfg, { path: String(form.path ?? "") }, String(form.version_id ?? ""), { clock, waitS: WAIT_S, ifOpen: forced(form) ? "force_close" : "wait" });

/** F13: an open file queues ws_drive_restore_version {path, version_id}. */
export function quickRestore(cfg, form, clock) {
  const versionId = String(form.version_id ?? "");
  if (!/^\d{1,12}$/.test(versionId)) throw new WsError("bad_version_id", "not a version");
  const path = String(form.path ?? "");
  return withFileRestore(cfg, splitPath(path), versionId, { ...writeOpts(form, clock, ["ws_drive_restore_version", { path, version_id: versionId }]), summary: `restore version ${versionId}` });
}
