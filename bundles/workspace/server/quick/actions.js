/**
 * Quick edit writes (spec §8): one paragraph, cell or slide shape at a time, as crow-bot, through the same write
 * protocol as the tools (a version before every change, labelled "Quick edit: …"). A phone waits at most 10 s for an
 * open file (F16); after that the change is queued (K5) as the equivalent tool op and applied live or at close.
 */
import { WsError } from "../result.js";
import { withFileWrite, withFileRestore, undoFileChange } from "../write-protocol.js";
import { splitPath } from "../nc/paths.js";
import { kids, NS } from "../ooxml/xml.js";
import { openDocx, paragraphText } from "../ooxml/docx-model.js";
import { setParagraphText, isPlainTextParagraph } from "../ooxml/docx-edit.js";
import { openXlsx, writeRange, readRange } from "../ooxml/xlsx.js";
import { openPptx, editShapeText, shapeById, shapeText } from "../ooxml/pptx.js";
import { queueDescriptor } from "../queue/provider.js";
import { queueDefs } from "../tools/queue.js";

export const QUICK_MAX_BYTES = 20 * 1024 * 1024;
const WAIT_S = 10; // spec §8 / F16: a phone shouldn't hang for 30 s
const KINDS = ["docx", "xlsx", "pptx"];
const CHANGE_ID = /^pc_[0-9a-z]+$/;
const [, cancelChange] = queueDefs; // ws_cancel_change
/** Browsers submit textarea/hidden values with CRLF: normalize both sides, or every multi-line target is "stale". */
const nl = (x) => String(x ?? "").replace(/\r\n?/g, "\n");
const forced = (form) => form.if_open === "force_close";

/** K5: an open file → the edit is queued as the equivalent tool op (applies live through the plugin, or at close). */
function asToolOp(form, value) {
  const path = String(form.path);
  if (form.kind === "docx") return ["ws_docs_rewrite_passages", { path, passages: [{ match_prefix: form.shown.slice(0, 100), new_text: value }] }];
  if (form.kind === "xlsx") return ["ws_sheets_write", { path, range: String(form.target), values: [[value]] }];
  return ["ws_slides_edit_text", { path, object_id: String(form.target), new_text: value }];
}
/** force_close = the user's explicit "apply now" (never queued); otherwise queue after the 10 s wait. */
const writeOpts = (form, clock, [tool, args]) => ({
  label: "Quick edit", waitS: WAIT_S, clock,
  ifOpen: forced(form) ? "force_close" : "queue",
  queue: forced(form) ? null : queueDescriptor(tool, args, { requestedBy: "quick_edit" }),
});

export async function quickSave(cfg, formIn, clock) {
  // "Yes, apply now" from the queued page: cancel the queued twin first so it can never apply a second time.
  // If it can't be cancelled (already claimed/applied), this throws not_pending and NOTHING is written (review K5-I9).
  if (forced(formIn) && CHANGE_ID.test(String(formIn.cancel_first || ""))) await cancelChange.run({ change_id: String(formIn.cancel_first) });
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
      const p = /^\d{1,6}$/.test(target) ? kids(d.body, NS.w, "p")[Number(target)] : null;
      // Review I6: the form carries the text the page showed; if the paragraph at that index changed, refuse.
      if (!p || paragraphText(p) !== form.shown) throw new WsError("stale_view", "The document changed since this page loaded; reload and try again.");
      if (!isPlainTextParagraph(p)) throw new WsError("not_plain_text", "This paragraph contains a link, image, field or footnote; edit it in the editor so nothing is lost.");
      setParagraphText(d, p, value);
      return { bytes: d.pkg.save(), changed: 1, summary: `paragraph ${Number(target) + 1}` };
    }
    if (kind === "xlsx") {
      const wb = openXlsx(bytes);
      if (String(readRange(wb, target, "FORMULA").values[0]?.[0] ?? "") !== form.shown) throw new WsError("stale_view", "The sheet changed since this page loaded; reload and try again.");
      const r = writeRange(wb, target, [[value]], "USER_ENTERED");
      return { bytes: wb.pkg.save(), changed: 1, summary: `cell ${r.range}` };
    }
    const deck = openPptx(bytes);
    if (shapeText(shapeById(deck, target).sp) !== form.shown) throw new WsError("stale_view", "The slide changed since this page loaded; reload and try again.");
    editShapeText(deck, target, value);
    return { bytes: deck.pkg.save(), changed: 1, summary: "slide text" };
  }, writeOpts(form, clock, asToolOp({ ...form, kind }, value)));
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
