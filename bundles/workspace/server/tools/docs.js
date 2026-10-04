import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, writeOpts, refOf, writeOptsOf } from "./common.js";
import { defineTools } from "./define.js";
import { stat, getFile, resolveRef } from "../nc/dav.js";
import { withFileWrite, MAX_EDIT_BYTES } from "../write-protocol.js";
import { openDocx, topBlocks } from "../ooxml/docx-model.js";
import { toMarkdown, structure, sectionRange } from "../ooxml/docx-read.js";

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
export function registerDocs(server, ctx, extra = []) { return defineTools(server, ctx, [...docsReadDefs, ...extra]); }
