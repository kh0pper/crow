/**
 * K5 security (T13 fix A): the undo of a live-applied change is derived SERVER-SIDE, from Crow's own record of the
 * op (the row's args + its queue-time precondition snapshot) — never from anything the browser sends. The plugin's
 * ack carries no inverse; an old plugin's `inverse` field is ignored.
 *
 * Only ops whose inverse is exact from that record get one; the rest (and any doubt) → null → undo_via_versions.
 * Every inverse step still re-checks at undo time that the original change is in the file exactly (pre.orig) and
 * is count-/content-checked by its own tool, so a stale record answers changed_since, never a wrong edit.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { pinInverse } from "../queue/conditions.js";
import { argsOf, preOf } from "../queue/store.js";
import { ALL_DEFS } from "../tools/all.js";
import { openDocx, paragraphText } from "../ooxml/docx-model.js";
import { markdownToBlocks } from "../ooxml/md-to-wml.js";
import { patternFor } from "../ooxml/xlsx.js";

const BLANK_DOCX = new URL("../templates/blank.docx", import.meta.url);
const nfc = (s) => String(s ?? "").normalize("NFC");
const isFormula = (v) => typeof v === "string" && /^=./.test(v.trim());

/** The paragraph texts the markdown becomes (what the plugin inserted); null unless every block is a plain paragraph. */
function insertedTexts(md) {
  const d = openDocx(readFileSync(BLANK_DOCX));
  const blocks = markdownToBlocks(d, md);
  if (!blocks.length || blocks.length > 500 || blocks.some((b) => b.localName !== "p")) return null;
  return blocks.map((p) => paragraphText(p).normalize("NFC"));
}
function rowsOf(values, header) {
  let v = values;
  if (v && !Array.isArray(v) && typeof v === "object") v = [v];
  if (!Array.isArray(v) || !v.length) return null;
  if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    if (!Array.isArray(header)) return null;
    return v.map((o) => { const n = Object.fromEntries(Object.entries(o).map(([k, x]) => [nfc(k), x])); return header.map((h) => (Object.hasOwn(n, h) ? n[h] : "")); });
  }
  return v.every(Array.isArray) ? v : v.some(Array.isArray) ? null : [v];
}

/** The exact inverse of a live tool, from args + pre only; null when it is not exact. */
function inverseOf(tool, a, pre) {
  switch (tool) {
    case "ws_docs_find_replace": {
      const ps = a.pairs || (a.find !== undefined ? [{ find: a.find, replace: a.replace, match_case: a.match_case }] : []);
      if (ps.length !== 1) return null;
      const f = nfc(ps[0].find), r = nfc(ps[0].replace), mc = ps[0].match_case ?? a.match_case ?? true;
      // exact only when the replacement did not exist before, the case is known and the texts don't nest;
      // expect_count = the occurrences replaced as Crow recorded them (a different count at undo → changed_since)
      if (mc !== true || !r || !f || pre?.rcount !== 0 || !(Number.isInteger(pre?.fcount) && pre.fcount > 0) || r.includes(f) || f.includes(r)) return null;
      return [{ tool, args: { pairs: [{ find: r, replace: f }], expect_count: pre.fcount } }];
    }
    case "ws_docs_append": case "ws_docs_insert_at_heading": {
      const texts = insertedTexts(a.markdown); if (!texts) return null;
      return [{ tool: "ws__docs_remove_paragraphs_exact", args: tool === "ws_docs_append" ? { texts, at_end: true } : { texts, after_heading: String(a.heading) } }];
    }
    case "ws_sheets_write": {
      // the plugin applied only after checking each target cell still held pre.cells — so those ARE the old values
      const m = /^(.*)!\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.exec(String(a.range || "").trim());
      const rows = rowsOf(a.values);
      if (!m || !rows || !Array.isArray(pre?.cells)) return null;
      const old = rows.map((row, i) => row.map((_, j) => { const v = pre.cells[i]?.[j]; return v === undefined || v === null ? "" : v; }));
      if (old.some((row) => row.some((v) => typeof v === "boolean" || isFormula(v)))) return null;
      return [{ tool, args: { range: `${m[1]}!${m[2].toUpperCase()}${m[3]}`, values: old, value_input_option: "RAW" } }];
    }
    case "ws_sheets_append": {
      const rows = rowsOf(a.values, pre?.header);
      if (!rows || !Number.isInteger(pre?.last_row) || rows.some((row) => row.some(isFormula))) return null;
      return [{ tool: "ws__sheets_clear_rows_exact", args: { sheet: String(a.sheet_name), from_row: pre.last_row + 1, values: rows } }];
    }
    case "ws_sheets_set_number_format":
      if (!Array.isArray(pre?.s_attrs)) return null;
      return [{ tool: "ws__sheets_restore_styles", args: { range: String(a.range), s_attrs: pre.s_attrs, pattern: patternFor(a.pattern, a.format_type ?? "TEXT") } }];
    case "ws_sheets_rename_tab": return [{ tool, args: { title: String(a.new_title), new_title: String(a.title) } }];
    default: return null; // rewrite_passages: the replaced text in the editor is not on Crow's record → versions
  }
}

/** Pinned (allowed tool, this row's file) and valid for the inverse tool's own schema — or null (undo via versions). */
export function deriveInverse(row) {
  let inv;
  try { inv = inverseOf(row.tool, argsOf(row), preOf(row)); } catch { return null; }
  const pinned = pinInverse(row, inv);
  if (!pinned) return null;
  for (const x of pinned) {
    const def = ALL_DEFS.get(x.tool);
    if (!def) return null;
    const schema = def.internal ? z.object(def.schema).strict() : z.object(def.schema);
    if (!schema.safeParse(x.args).success) return null;
  }
  return pinned;
}
