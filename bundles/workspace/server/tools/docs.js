import { readFileSync } from "node:fs";
import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, writeOpts, refOf, writeOptsOf } from "./common.js";
import { defineTools } from "./define.js";
import { uniqueName } from "./drive.js";
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { splitFolder, splitPath } from "../nc/paths.js";
import { withFileWrite, createFile, MAX_EDIT_BYTES } from "../write-protocol.js";
import { openDocx, topBlocks } from "../ooxml/docx-model.js";
import { toMarkdown, structure, sectionRange } from "../ooxml/docx-read.js";
import { findReplace, rewritePassages, formatText, appendMarkdown, insertAtHeading, replaceSection, insertImage } from "../ooxml/docx-edit.js";
import { imageSize } from "../ooxml/image-size.js";

const TEMPLATE = (ext) => readFileSync(new URL(`../templates/blank.${ext}`, import.meta.url));
const MAX_IMAGE = 5 * 1024 * 1024;
const pairsSchema = z.array(z.object({ find: z.string().min(1).max(2000), replace: z.string().max(20000), match_case: z.boolean().optional() })).min(1).max(200);

export async function loadDocx(cfg, ref) {
  const segs = await resolveRef(cfg, ref);
  const entry = await stat(cfg, segs);
  if (!/\.docx$/i.test(entry.name)) throw new WsError("wrong_type", `"${entry.name}" is not a .docx document`);
  const { bytes, etag } = await getFile(cfg, segs, { maxBytes: MAX_EDIT_BYTES });
  return { entry: { ...entry, etag }, d: openDocx(bytes) };
}

/** Run fn(d) on the live file inside the write protocol; one save → one version. */
export function docxWrite(ctx, args, fn, label = "Crow") {
  return withFileWrite(ctx.getConfig(), refOf(args), async (bytes, entry) => {
    if (!/\.docx$/i.test(entry.name)) throw new WsError("wrong_type", `"${entry.name}" is not a .docx document`);
    const d = openDocx(bytes);
    const r = fn(d);
    if (!r.changed) return { changed: 0, data: r.data };
    return { bytes: d.pkg.save(), changed: r.changed, summary: r.summary, data: r.data };
  }, { ...writeOptsOf(args), clock: ctx.clock, label });
}

export const docsReadDefs = [
  { name: "ws_docs_read", description: "Read a .docx as markdown (headings, lists, bold/italic, links, tables). Always reads the live file.",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => { const { entry, d } = await loadDocx(getConfig(), refOf(args)); return { path: entry.path, file_id: entry.fileId, title: entry.name.replace(/\.docx$/i, ""), etag: entry.etag, markdown: toMarkdown(d) }; } },
  { name: "ws_docs_get_structure", description: "Heading outline of a .docx: [{level, text, index}].",
    schema: { ...fileRef },
    run: async (args, { getConfig }) => { const { entry, d } = await loadDocx(getConfig(), refOf(args)); return { path: entry.path, headings: structure(d) }; } },
  { name: "ws_docs_read_section", description: "Markdown of one section: from the heading to the next heading of the same or higher level.",
    schema: { ...fileRef, heading: z.string().min(1).max(500) },
    run: async (args, { getConfig }) => { const { entry, d } = await loadDocx(getConfig(), refOf(args)); const r = sectionRange(d, args.heading); return { path: entry.path, heading: args.heading, markdown: toMarkdown(d, topBlocks(d).slice(r.start, r.end)) }; } },
];

/** Spec §4.3 edit tools. Deliberately NO full-document replace (D7): edits are find/replace, section- or paragraph-scoped. */
export const docsWriteDefs = [
  { name: "ws_docs_find_replace", description: "Find/replace text in a .docx, keeping formatting. Batch mode (pairs) is atomic: one save, one version. Covers body, tables, headers and footers. Accented text matches however it was typed (NFC/NFD); a match never crosses a tab or line break.",
    schema: { ...fileRef, find: z.string().min(1).max(2000).optional(), replace: z.string().max(20000).optional(), match_case: z.boolean().optional().default(true), pairs: pairsSchema.optional(), ...writeOpts },
    run: (args, ctx) => {
      const pairs = args.pairs || (args.find !== undefined && args.replace !== undefined ? [{ find: args.find, replace: args.replace }] : null);
      if (!pairs) throw new WsError("bad_args", "Provide find+replace or pairs");
      return docxWrite(ctx, args, (d) => { const r = findReplace(d, pairs, args.match_case); return { changed: r.total, summary: `replace ${pairs.map((p) => `"${p.find}"`).join(", ")}`, data: { results: r.results, total_changes: r.total } }; });
    } },
  { name: "ws_docs_append", description: "Append markdown at the end of a .docx (headings, lists, bold/italic, links, tables).",
    schema: { ...fileRef, markdown: z.string().min(1).max(200000), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => ({ changed: appendMarkdown(d, args.markdown), summary: "append text", data: {} })) },
  { name: "ws_docs_insert_at_heading", description: "Insert markdown right after a heading. Inserted text never inherits the heading style.",
    schema: { ...fileRef, heading: z.string().min(1).max(500), markdown: z.string().min(1).max(200000), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => ({ changed: insertAtHeading(d, args.heading, args.markdown), summary: `insert under "${args.heading}"`, data: { heading_inheritance_fix_applied: true } })) },
  { name: "ws_docs_replace_section", description: "Replace everything between a heading and the next heading of the same or higher level (subsections included). Atomic. The heading itself is kept; an empty section can be filled.",
    schema: { ...fileRef, heading: z.string().min(1).max(500), markdown: z.string().max(200000), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => {
      const r = replaceSection(d, args.heading, args.markdown);
      // an empty section replaced by empty markdown changes nothing → no version (spec §4.1)
      return { changed: r.removed + r.inserted, summary: `replace section "${args.heading}"`, data: { removed_blocks: r.removed, inserted_blocks: r.inserted, heading_inheritance_fix_applied: true } };
    }) },
  { name: "ws_docs_rewrite_passages", description: "Rewrite whole paragraphs found by the start of their text (match_prefix, ≤100 chars, case-sensitive). Keeps paragraph style and the first run's formatting. Atomic.",
    schema: { ...fileRef, passages: z.array(z.object({ match_prefix: z.string().max(1000), new_text: z.string().max(20000) })).min(1).max(100), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => { const r = rewritePassages(d, args.passages); const n = r.results.filter((x) => x.matched).length; return { changed: n, summary: `rewrite ${n} paragraph(s)`, data: { total_passages: args.passages.length, matched: n, results: r.results } }; }) },
  { name: "ws_docs_format_text", description: "Style matching text: bold, italic, underline, color_hex, or link_url (http/https/mailto). occurrence 0 = first, -1 = all.",
    schema: { ...fileRef, find: z.string().min(1).max(2000), occurrence: z.number().int().min(-1).optional().default(0), bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), link_url: z.string().max(2000).optional(), color_hex: z.string().max(7).optional(), ...writeOpts },
    run: (args, ctx) => docxWrite(ctx, args, (d) => { const n = formatText(d, args.find, args.occurrence, args); return { changed: n, summary: `format "${args.find}"`, data: { formatted: n } }; }) },
  { name: "ws_docs_insert_image", description: "Insert a PNG/JPEG/GIF from the drive (≤5 MB) replacing anchor_text, or before body block `index` (default 0).",
    schema: { ...fileRef, image_path: z.string().max(4096), anchor_text: z.string().min(1).max(500).optional(), index: z.number().int().min(0).optional(), max_width_pt: z.number().min(10).max(2000).optional().default(450), ...writeOpts },
    run: async (args, ctx) => {
      const img = await getFile(ctx.getConfig(), splitPath(args.image_path), { maxBytes: MAX_IMAGE });
      imageSize(img.bytes); // refuse a non-image before touching the document
      return docxWrite(ctx, args, (d) => ({ changed: 1, summary: "insert image", data: insertImage(d, img.bytes, { anchorText: args.anchor_text, index: args.index, maxWidthPt: args.max_width_pt }) }));
    } },
  { name: "ws_docs_create", description: "Create a .docx in a folder from the blank template, optionally with markdown content. Dedupes by title unless find_existing is false.",
    schema: { folder: z.string().max(4096), title: z.string().min(1).max(200), content: z.string().max(200000).optional().default(""), find_existing: z.boolean().optional().default(true) },
    run: async (args, ctx) => {
      const cfg = ctx.getConfig(); const folder = splitFolder(args.folder);
      const base = args.title.normalize("NFC").replace(/\.docx$/i, "");
      if (/[/\\]/.test(base)) throw new WsError("bad_path", "titles cannot contain / or \\");
      let name = `${base}.docx`;
      if (args.find_existing) { try { const e = await stat(cfg, [...folder, name]); return { created: false, path: e.path, file_id: e.fileId }; } catch (e) { if (e.code !== "not_found") throw e; } }
      else name = await uniqueName(cfg, folder, name);
      const d = openDocx(TEMPLATE("docx"));
      if (args.content) appendMarkdown(d, args.content);
      return { created: true, ...(await createFile(cfg, folder, name, d.pkg.save(), { summary: `create ${name}`, clock: ctx.clock })) };
    } },
];
export function registerDocs(server, ctx, extra = []) { return defineTools(server, ctx, [...docsReadDefs, ...extra]); }
