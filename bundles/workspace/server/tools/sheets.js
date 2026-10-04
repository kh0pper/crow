/** Sheets tools (.xlsx, spec §4.5). */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { WsError } from "../result.js";
import { fileRef, refOf, writeOpts } from "./common.js";
import { defineTools } from "./define.js";
import { uniqueName } from "./drive.js";
import { loadOoxml, ooxmlWrite } from "./ooxml-file.js";
import { stat } from "../nc/dav.js";
import { splitFolder } from "../nc/paths.js";
import { createFile } from "../write-protocol.js";
import { openXlsx, readRange, writeRange, appendRows, addTab, renameTab, deleteTab, setNumberFormat, tabsInfo } from "../ooxml/xlsx.js";

const XLSX = Object.freeze({ ext: "xlsx", noun: "an .xlsx spreadsheet", open: openXlsx });
const TEMPLATE = new URL("../templates/blank.xlsx", import.meta.url);

const cellV = z.union([z.string().max(32767), z.number(), z.boolean(), z.null(), z.record(z.any()), z.array(z.any())]);
const values2d = z.union([z.array(z.array(cellV)).min(1).max(50000), z.array(cellV).min(1).max(16384)]);
// F7: no .min(1) here — an empty append reaches the handler, which answers bad_args inside the result envelope
const appendVals = z.union([z.array(z.array(cellV)).max(50000), z.array(cellV).max(16384), z.record(cellV), z.array(z.record(cellV)).max(50000)]);
const inputOpt = z.enum(["USER_ENTERED", "RAW"]).optional().default("USER_ENTERED").describe("USER_ENTERED parses '=formulas', numeric text, TRUE/FALSE and ISO dates into date cells; RAW keeps strings as text (JSON numbers/booleans keep their type)");

const xlsxWrite = (ctx, args, fn) => ooxmlWrite(ctx, args, XLSX, fn);

const OP_ARGS = { write: ["range", "values"], append: ["sheet_name", "values"], add_tab: ["title"], rename_tab: ["title", "new_title"], delete_tab: ["title"], set_number_format: ["range"] };
function applyOp(wb, op) {
  const missing = (OP_ARGS[op.op] || []).filter((k) => op[k] === undefined || op[k] === null || (typeof op[k] !== "object" && typeof op[k] !== "string"));
  if (missing.length) throw new WsError("bad_args", `op "${op.op}" needs ${missing.join(", ")}`);
  const input = op.value_input_option || "USER_ENTERED";
  switch (op.op) {
    case "write": { const r = writeRange(wb, op.range, op.values, input); return `write ${r.range}`; }
    case "append": { const r = appendRows(wb, op.sheet_name, op.values, input); return `append ${r.range}`; }
    case "add_tab": addTab(wb, op.title, op.index); return `add tab ${op.title}`;
    case "rename_tab": renameTab(wb, op.title, op.new_title); return `rename tab ${op.title} → ${op.new_title}`;
    case "delete_tab": deleteTab(wb, op.title); return `delete tab ${op.title}`;
    case "set_number_format": setNumberFormat(wb, op.range, op.pattern ?? "@"); return `format ${op.range}`;
    default: throw new WsError("bad_args", `unknown op "${op.op}"`);
  }
}

export const sheetsDefs = [
  { name: "ws_sheets_list", description: "Tab names of an .xlsx, in order.", schema: { ...fileRef },
    run: async (a, c) => { const { entry, model: wb } = await loadOoxml(c.getConfig(), refOf(a), XLSX); return { path: entry.path, tabs: wb.sheets.map((s) => s.name) }; } },
  { name: "ws_sheets_get_tabs", description: "Tab details: sheet_id, index, title, rows, cols, frozen rows/cols, hidden.", schema: { ...fileRef },
    run: async (a, c) => { const { entry, model: wb } = await loadOoxml(c.getConfig(), refOf(a), XLSX); return { path: entry.path, tabs: tabsInfo(wb) }; } },
  { name: "ws_sheets_read", description: "Read a range ('Tab!A1:C10', 'Tab!A:A' or 'Tab'), at most 50,000 cells. value_render_option: FORMATTED_VALUE | UNFORMATTED_VALUE | FORMULA. stale_formulas=true means some formulas have no computed value yet: read them with FORMULA.",
    schema: { ...fileRef, range: z.string().min(1).max(300), value_render_option: z.string().optional().default("FORMATTED_VALUE") },
    run: async (a, c) => { const { entry, model: wb } = await loadOoxml(c.getConfig(), refOf(a), XLSX); return { path: entry.path, ...readRange(wb, a.range, a.value_render_option) }; } },
  { name: "ws_sheets_write", description: "Overwrite cells starting at the range's top-left (a flat list is one row). USER_ENTERED parses '=formulas', numbers, TRUE/FALSE; RAW stores strings as text as-is. Keeps cell formatting. Refuses non-top-left cells of merged areas and partial shared-formula ranges.",
    schema: { ...fileRef, range: z.string().min(1).max(300), values: values2d, value_input_option: inputOpt, ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const r = writeRange(wb, a.range, a.values, a.value_input_option); return { changed: r.cells, summary: `write ${r.range}`, data: { updated_range: r.range, updated_cells: r.cells } }; }) },
  { name: "ws_sheets_append", description: "Append rows after the last non-empty row. Accepts rows, a dict, or a list of dicts keyed by the header row (unknown keys are an error).",
    schema: { ...fileRef, sheet_name: z.string().min(1).max(31), values: appendVals, value_input_option: inputOpt, ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const r = appendRows(wb, a.sheet_name, a.values, a.value_input_option); return { changed: r.rows, summary: `append ${r.rows} row(s)`, data: r }; }) },
  { name: "ws_sheets_create", description: "Create an .xlsx from the blank template; the first tabs entry renames Sheet1. Dedupes by name when folder is given (find_existing=true); find_existing=false picks a free name.",
    schema: { title: z.string().min(1).max(200), folder: z.string().max(4096).optional(), tabs: z.array(z.string().min(1).max(31)).max(50).optional(), find_existing: z.boolean().optional().default(true) },
    run: async (a, c) => {
      const cfg = c.getConfig(); const folder = splitFolder(a.folder ?? "");
      const base = a.title.normalize("NFC").replace(/\.xlsx$/i, "");
      if (/[/\\]/.test(base)) throw new WsError("bad_path", "titles cannot contain / or \\");
      let name = `${base}.xlsx`;
      if (a.folder !== undefined && a.find_existing) { try { const e = await stat(cfg, [...folder, name]); return { created: false, path: e.path, file_id: e.fileId }; } catch (e) { if (e.code !== "not_found") throw e; } }
      else if (!a.find_existing) name = await uniqueName(cfg, folder, name);
      const wb = openXlsx(readFileSync(TEMPLATE));
      const [first, ...rest] = a.tabs || [];
      if (first) renameTab(wb, wb.sheets[0].name, first);
      for (const t of rest) addTab(wb, t);
      return { created: true, ...(await createFile(cfg, folder, name, wb.pkg.save(), { summary: `create ${name}`, clock: c.clock })) };
    } },
  { name: "ws_sheets_add_tab", description: "Add a tab (optional position index).", schema: { ...fileRef, title: z.string().min(1).max(64), index: z.number().int().min(0).optional(), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => ({ changed: 1, summary: `add tab ${a.title}`, data: addTab(wb, a.title, a.index) })) },
  { name: "ws_sheets_rename_tab", description: "Rename a tab and update formulas, defined names and charts that reference it. Refused when a pivot table reads from the tab.", schema: { ...fileRef, title: z.string().min(1).max(64), new_title: z.string().min(1).max(64), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => ({ changed: 1, summary: `rename tab ${a.title}`, data: renameTab(wb, a.title, a.new_title) })) },
  { name: "ws_sheets_delete_tab", description: "Delete a tab. Destructive: confirm intent with the user first. The last visible tab cannot be deleted.", schema: { ...fileRef, title: z.string().min(1).max(64), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => ({ changed: 1, summary: `delete tab ${a.title}`, data: deleteTab(wb, a.title) })) },
  { name: "ws_sheets_set_number_format", description: "Set a number format on a range (default '@' = plain text, keeps leading zeros). Other cell formatting is kept.",
    schema: { ...fileRef, range: z.string().min(1).max(300), pattern: z.string().min(1).max(255).optional().default("@"), format_type: z.string().max(20).optional().default("TEXT"), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const n = setNumberFormat(wb, a.range, a.pattern); return { changed: n, summary: `format ${a.range}`, data: { formatted_cells: n } }; }) },
  { name: "ws_sheets_batch_update", description: "Apply typed ops in order as ONE version: write, append, add_tab, rename_tab, delete_tab, set_number_format (same params as the single tools). Any failing op aborts the whole batch.",
    schema: { ...fileRef, ops: z.array(z.object({ op: z.enum(["write", "append", "add_tab", "rename_tab", "delete_tab", "set_number_format"]) }).passthrough()).min(1).max(200), ...writeOpts },
    run: (a, c) => xlsxWrite(c, a, (wb) => { const done = a.ops.map((op) => applyOp(wb, op)); return { changed: done.length, summary: `${done.length} sheet op(s)`, data: { applied: done } }; }) },
];
export const registerSheets = (server, ctx) => defineTools(server, ctx, sheetsDefs);
