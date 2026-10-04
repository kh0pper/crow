/**
 * Internal exact-inverse ops for undoing a LIVE-applied change (spec §5.8, K5-I8). They are reached only through a
 * queued undo row (args pinned by pinInverse to the same file), are registered in ALL_DEFS only and are NEVER exposed
 * as MCP tools (the ws__ prefix). Each refuses with target_changed unless the file still holds exactly what the
 * original change added. Their args come from the live plugin's ack, so each def carries a strict zod schema (Task 13
 * re-validates with it) and run() checks it again before touching the file.
 */
import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, writeOpts } from "./common.js";
import { docxWrite } from "./docs.js";
import { XLSX } from "./sheets.js";
import { ooxmlWrite } from "./ooxml-file.js";
import { removeParagraphsExact } from "../ooxml/docx-edit.js";
import { deleteComment } from "../ooxml/docx-comments.js";
import { clearRowsExact } from "../ooxml/xlsx.js";

const cell = z.union([z.string().max(32767), z.number(), z.boolean(), z.null()]);
const dimension = z.string().max(40).optional().describe("the tab's <dimension> ref before the change (\"\" = none)");
const internal = (name, schema, run) => {
  const check = z.object(schema).strict();
  return { name, internal: true, schema, run: async (a, c) => {
    const p = check.safeParse({ ...a });
    if (!p.success) throw new WsError("bad_args", `${name}: ${p.error.issues.map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ").slice(0, 300)}`);
    return run(Object.defineProperties({ ...p.data }, { __tool: { value: a.__tool ?? null }, __label: { value: a.__label } }), c);
  } };
};

export const inverseDefs = [
  internal("ws__docs_remove_paragraphs_exact", { ...fileRef, texts: z.array(z.string().max(200000)).min(1).max(500), after_heading: z.string().min(1).max(500).optional(), at_end: z.boolean().optional(), ...writeOpts },
    (a, c) => docxWrite(c, a, (d) => ({ changed: removeParagraphsExact(d, a.texts, { afterHeading: a.after_heading, atEnd: a.at_end === true }), summary: "remove the text Crow added", data: {} }))),
  internal("ws__docs_delete_comment", { ...fileRef, comment_id: z.string().regex(/^\d{1,9}$/), content: z.string().max(10000).optional(), ...writeOpts },
    (a, c) => docxWrite(c, a, (d) => ({ changed: 1, summary: "remove Crow's comment", data: deleteComment(d, a.comment_id, { content: a.content }) }))),
  internal("ws__sheets_clear_rows_exact", { ...fileRef, sheet: z.string().min(1).max(31), from_row: z.number().int().min(1).max(1048576), values: z.array(z.array(cell).max(16384)).min(1).max(10000), dimension, ...writeOpts },
    (a, c) => ooxmlWrite(c, a, XLSX, (wb) => { const n = clearRowsExact(wb, a.sheet, a.from_row, a.values, { dimension: a.dimension }); return { changed: n || 1, summary: `remove ${a.values.length} appended row(s)`, data: { cleared_cells: n } }; })),
];
