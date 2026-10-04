/** Slides tools (.pptx, spec §4.6). */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, refOf, writeOpts } from "./common.js";
import { defineTools } from "./define.js";
import { uniqueName } from "./drive.js";
import { loadOoxml, ooxmlWrite } from "./ooxml-file.js";
import { getFile } from "../nc/dav.js";
import { splitFolder, splitPath } from "../nc/paths.js";
import { createFile } from "../write-protocol.js";
import { imageSize } from "../ooxml/image-size.js";
import * as X from "../ooxml/pptx.js";

const PPTX = Object.freeze({ ext: "pptx", noun: "a .pptx deck", open: X.openPptx });
const TEMPLATE = new URL("../templates/blank.pptx", import.meta.url);
const MAX_IMAGE = 5 * 1024 * 1024;

const deckWrite = (ctx, args, fn) => ooxmlWrite(ctx, args, PPTX, fn);
const slideId = z.string().min(1).max(12).describe("slide_id from ws_slides_get_structure, e.g. '256'");
const objectId = z.string().min(3).max(30).describe("object_id '<slide_id>:<shape id>' from ws_slides_read");
const pairs = z.array(z.object({ find: z.string().min(1).max(2000), replace: z.string().max(20000), match_case: z.boolean().optional() })).min(1).max(200);
const frArgs = { find: z.string().min(1).max(2000).optional(), replace: z.string().max(20000).optional(), match_case: z.boolean().optional(), scope: z.enum(["slides", "notes", "all"]).optional(), slide_ids: z.array(slideId).min(1).max(500).optional(), pairs: pairs.optional() };
const styleArgs = { bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), font_size: z.number().min(1).max(400).optional(), color_hex: z.string().max(7).optional(), font_family: z.string().min(1).max(100).optional() };
const inches = { x: z.number().min(0).max(60).optional(), y: z.number().min(0).max(60).optional(), width: z.number().min(0.1).max(60).optional(), height: z.number().min(0.1).max(60).optional() };

function fr(deck, a) {
  const p = a.pairs || (a.find !== undefined && a.replace !== undefined ? [{ find: a.find, replace: a.replace }] : null);
  if (!p) throw new WsError("bad_args", "Provide find+replace or pairs");
  return X.findReplaceDeck(deck, p, a.match_case ?? true, a.scope ?? "slides", a.slide_ids ?? null);
}

// typed batch ops (spec §4.6): each op is checked against its own schema before anything runs
const OPS = {
  edit_text: z.object({ object_id: objectId, new_text: z.string().max(20000) }),
  find_replace: z.object(frArgs),
  add_slide: z.object({ layout: z.string().min(1).max(100).optional(), index: z.number().int().min(0).optional() }),
  delete_slide: z.object({ slide_id: slideId }),
  reorder_slides: z.object({ slide_ids: z.array(slideId).min(1).max(500), insertion_index: z.number().int().min(0) }),
  edit_notes: z.object({ slide_id: slideId, text: z.string().max(20000), mode: z.enum(["replace", "append"]).optional() }),
  format_text: z.object({ object_id: objectId, ...styleArgs }),
};
function checkOp(op, i) {
  const r = OPS[op.op].safeParse(op);
  if (!r.success) throw new WsError("bad_args", `ops[${i}] (${op.op}): ${r.error.issues.map((x) => `${x.path.join(".") || "op"} ${x.message}`).join("; ")}`);
  return { op: op.op, ...r.data };
}
function opRun(deck, op) {
  switch (op.op) {
    case "edit_text": X.editShapeText(deck, op.object_id, op.new_text); return 1;
    case "find_replace": return fr(deck, op).total;
    case "add_slide": X.addSlide(deck, op.layout ?? "Blank", op.index); return 1;
    case "delete_slide": X.deleteSlide(deck, op.slide_id); return 1;
    case "reorder_slides": return X.reorderSlides(deck, op.slide_ids, op.insertion_index).changed ? 1 : 0;
    case "edit_notes": X.editNotes(deck, op.slide_id, op.text, op.mode ?? "replace"); return 1;
    case "format_text": return X.formatShapeText(deck, op.object_id, op);
    default: throw new WsError("bad_args", `unknown op "${op.op}"`);
  }
}

export const slidesDefs = [
  { name: "ws_slides_read", description: "Read a .pptx: per slide its slide_id, index, title, shapes (object_id, name, kind, text) and speaker notes.", schema: { ...fileRef, include_notes: z.boolean().optional().default(true) },
    run: async (a, c) => { const { entry, model: deck } = await loadOoxml(c.getConfig(), refOf(a), PPTX); return { path: entry.path, slides: X.readDeck(deck, a.include_notes) }; } },
  { name: "ws_slides_get_structure", description: "Slide ids, titles and element (object) ids of a .pptx, in slide order.", schema: { ...fileRef },
    run: async (a, c) => { const { entry, model: deck } = await loadOoxml(c.getConfig(), refOf(a), PPTX); return { path: entry.path, slides: X.readDeck(deck, false).map((s) => ({ slide_id: s.slide_id, index: s.index, title: s.title, object_ids: s.shapes.map((x) => x.object_id) })) }; } },
  { name: "ws_slides_read_notes", description: "Speaker notes text, for all slides or one slide_id (read-only).", schema: { ...fileRef, slide_id: slideId.optional() },
    run: async (a, c) => { const { entry, model: deck } = await loadOoxml(c.getConfig(), refOf(a), PPTX); const ss = a.slide_id ? [X.slideById(deck, a.slide_id)] : deck.slides; return { path: entry.path, notes: ss.map((s) => ({ slide_id: s.id, text: X.notesText(deck, s) })) }; } },
  { name: "ws_slides_find_replace", description: "Find/replace text in a .pptx, keeping formatting. scope: slides (default; never touches speaker notes), notes, or all. slide_ids restricts. Batch mode (pairs) is atomic: one version. 0 occurrences = no match, no version. Accented text matches however it was typed (NFC/NFD).",
    schema: { ...fileRef, ...frArgs, match_case: z.boolean().optional().default(true), scope: z.enum(["slides", "notes", "all"]).optional().default("slides"), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => { const r = fr(deck, a); return { changed: r.total, summary: `replace ${(a.pairs || [a]).map((p) => `"${p.find}"`).join(", ")} (${a.scope})`, data: { results: r.results, total_changes: r.total } }; }) },
  { name: "ws_slides_create", description: "Create a .pptx with one title slide titled with the deck name (a free name is picked if it exists).", schema: { title: z.string().min(1).max(200), folder: z.string().max(4096).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig(); const folder = splitFolder(a.folder ?? "");
      const base = a.title.normalize("NFC").replace(/\.pptx$/i, "");
      if (/[/\\]/.test(base)) throw new WsError("bad_path", "titles cannot contain / or \\");
      const name = await uniqueName(cfg, folder, `${base}.pptx`);
      const deck = X.openPptx(readFileSync(TEMPLATE));
      const { slide_id } = X.addSlide(deck, "Title Slide");
      const title = X.readDeck(deck, false)[0].shapes.find((s) => s.kind === "ctrTitle" || s.kind === "title");
      if (title) X.editShapeText(deck, title.object_id, base);
      X.ensureNotesMasterId(deck);
      return { created: true, slide_id, ...(await createFile(cfg, folder, name, deck.pkg.save(), { summary: `create ${name}`, clock: c.clock })) };
    } },
  { name: "ws_slides_add_slide", description: "Add a slide using one of the deck's own layouts by name, case-insensitive (e.g. 'Title and Content', 'Title Only', 'Blank'); an unknown name lists them. index = position (default: end).", schema: { ...fileRef, layout: z.string().min(1).max(100).optional().default("Blank"), index: z.number().int().min(0).optional(), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: `add slide (${a.layout})`, data: X.addSlide(deck, a.layout, a.index) })) },
  { name: "ws_slides_duplicate_slide", description: "Duplicate a slide (with its speaker notes) right after it.", schema: { ...fileRef, slide_id: slideId, ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: `duplicate slide ${a.slide_id}`, data: X.duplicateSlide(deck, a.slide_id) })) },
  { name: "ws_slides_delete_slide", description: "Delete a slide with its notes and relationships. Destructive: confirm intent with the user first.", schema: { ...fileRef, slide_id: slideId, ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: `delete slide ${a.slide_id}`, data: X.deleteSlide(deck, a.slide_id) })) },
  { name: "ws_slides_reorder_slides", description: "Move slides (kept in the given order) to insertion_index, a position in the slide order before the move (Google semantics).", schema: { ...fileRef, slide_ids: z.array(slideId).min(1).max(500), insertion_index: z.number().int().min(0), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => { const r = X.reorderSlides(deck, a.slide_ids, a.insertion_index); return { changed: r.changed ? 1 : 0, summary: "reorder slides", data: { order: r.order } }; }) },
  { name: "ws_slides_add_text_box", description: "Add a text box to a slide (position and size in inches; \\n makes new paragraphs).", schema: { ...fileRef, slide_id: slideId, text: z.string().max(20000), ...inches, font_size: z.number().min(1).max(400).optional(), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: "add text box", data: X.addTextBox(deck, a.slide_id, a.text, a) })) },
  { name: "ws_slides_add_image", description: "Add a PNG/JPEG/GIF from the drive (≤5 MB, sides ≤65535 px) to a slide (position and size in inches).", schema: { ...fileRef, slide_id: slideId, image_path: z.string().min(1).max(4096), ...inches, ...writeOpts },
    run: async (a, c) => {
      const img = await getFile(c.getConfig(), splitPath(a.image_path), { maxBytes: MAX_IMAGE });
      imageSize(img.bytes); // refuse a non-image before touching the deck
      return deckWrite(c, a, (deck) => ({ changed: 1, summary: "add image", data: X.addImage(deck, a.slide_id, img.bytes, a) }));
    } },
  { name: "ws_slides_format_text", description: "Style all text in a shape: bold, italic, underline, font_size (pt), color_hex (6 hex digits), font_family. At least one style.", schema: { ...fileRef, object_id: objectId, ...styleArgs, ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => { const n = X.formatShapeText(deck, a.object_id, a); return { changed: n, summary: `format ${a.object_id}`, data: { runs: n } }; }) },
  { name: "ws_slides_format_paragraph", description: "Paragraph alignment in a shape: START, CENTER, END, JUSTIFIED.", schema: { ...fileRef, object_id: objectId, alignment: z.enum(["START", "CENTER", "END", "JUSTIFIED"]), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => { const n = X.formatParagraphs(deck, a.object_id, a.alignment); return { changed: n, summary: `align ${a.object_id}`, data: { paragraphs: n } }; }) },
  { name: "ws_slides_edit_text", description: "Replace a shape's text, keeping the first run's formatting and the first paragraph's settings. \\n makes new paragraphs.", schema: { ...fileRef, object_id: objectId, new_text: z.string().max(20000), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: `edit text ${a.object_id}`, data: { edited: X.editShapeText(deck, a.object_id, a.new_text) } })) },
  { name: "ws_slides_edit_notes", description: "Set (replace) or append speaker notes; the notes page is created if the slide has none.", schema: { ...fileRef, slide_id: slideId, text: z.string().max(20000), mode: z.enum(["replace", "append"]).optional().default("replace"), ...writeOpts },
    run: (a, c) => deckWrite(c, a, (deck) => ({ changed: 1, summary: `edit notes of slide ${a.slide_id}`, data: { edited: X.editNotes(deck, a.slide_id, a.text, a.mode) } })) },
  { name: "ws_slides_batch_update", description: "Apply typed ops in order as ONE version: edit_text, find_replace, add_slide, delete_slide, reorder_slides, edit_notes, format_text (same params as the single tools). Any failing op aborts the whole batch.",
    schema: { ...fileRef, ops: z.array(z.object({ op: z.enum(["edit_text", "find_replace", "add_slide", "delete_slide", "reorder_slides", "edit_notes", "format_text"]) }).passthrough()).min(1).max(200), ...writeOpts },
    run: (a, c) => {
      const ops = a.ops.map(checkOp); // every op is valid before the file is touched
      return deckWrite(c, a, (deck) => { let n = 0; for (const op of ops) n += opRun(deck, op); return { changed: n, summary: `${ops.length} slide op(s)`, data: { applied: ops.length, changes: n } }; });
    } },
];
export const registerSlides = (server, ctx) => defineTools(server, ctx, slidesDefs);
