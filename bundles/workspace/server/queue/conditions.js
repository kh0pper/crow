/**
 * K5 exactly-once guards (spec §5.6), evaluated on SAVED bytes (the live plugin evaluates the same rules in the editor).
 * - snapshot(tool, args, bytes): computed at queue time from the saved file → precondition_json.
 * - checkPre: is the target still what it was when queued ("anchor" + "snapshot" checks) → {ok, reason}.
 * - checkPost: is this change already in the file (after a live claim whose ack never came, or to verify a live ack
 *   against the saved file — R-LIVE: an ack is never proof) → true | false | null (null = cannot tell → never re-applied).
 * Counts, not mere presence, wherever the inserted text could already exist (a replacement that contains the find
 * text, a paragraph that was already in the document), so a postcondition never misses an applied change.
 */
import { createHash } from "node:crypto";
import { WsError } from "../result.js";
import { NS, all } from "../ooxml/xml.js";
import { openDocx, allParagraphs, textMap, paragraphText, topBlocks } from "../ooxml/docx-model.js";
import { sectionRange } from "../ooxml/docx-read.js";
import { markdownToBlocks } from "../ooxml/md-to-wml.js";
import { rewritePassages } from "../ooxml/docx-edit.js";
import { openXlsx, readRange, writeRange, sheetByName, headerRow, lastDataRow, rowsFormula, styleAttrs, numFmtCodes, cellKey, sameRows, patternFor } from "../ooxml/xlsx.js";
import { dateToSerial } from "../ooxml/xlsx-format.js";
import { openPptx, shapeById, shapeText, slideById, paraText } from "../ooxml/pptx.js";

/** Spec §5.6 "what can be queued": every content op of Docs, comments, Sheets, Slides; Drive new version/restore; undo. */
export const QUEUEABLE = new Set(["ws_docs_find_replace", "ws_docs_append", "ws_docs_insert_at_heading", "ws_docs_replace_section", "ws_docs_rewrite_passages", "ws_docs_format_text", "ws_docs_insert_image",
  "ws_docs_add_comment", "ws_docs_reply_comment", "ws_docs_resolve_comment", "ws_docs_apply_comment_edit",
  "ws_sheets_write", "ws_sheets_append", "ws_sheets_add_tab", "ws_sheets_rename_tab", "ws_sheets_delete_tab", "ws_sheets_set_number_format", "ws_sheets_batch_update",
  "ws_slides_find_replace", "ws_slides_add_slide", "ws_slides_duplicate_slide", "ws_slides_delete_slide", "ws_slides_reorder_slides", "ws_slides_add_text_box", "ws_slides_add_image", "ws_slides_format_text", "ws_slides_format_paragraph", "ws_slides_edit_text", "ws_slides_edit_notes", "ws_slides_batch_update",
  "ws_drive_upload_new_version", "ws_drive_restore_version", "ws_undo_last_change"]);

/**
 * Ops the plugin may apply live (spec §5.7 table, minus R-LIVE: the 9.4 builder API lacks AddComment/SetBold/SetItalic/
 * SetUnderline/SetColor, so ws_docs_add_comment and ws_docs_format_text are close-time only). Task 13: the slide ops
 * are close-time only too — S9 verified no text method on a shape's ApiDocumentContent, so the plugin cannot read
 * or check a shape's text. ws_sheets_add_tab is close-time only (T13 fix I2): Api.AddSheet makes the new tab the
 * ACTIVE sheet and no verified method switches back, so the person's typing would land in Crow's tab.
 * onlyoffice-plugin/ops.js implements exactly this set; its test pins it.
 */
export const LIVE_OPS = new Set(["ws_docs_find_replace", "ws_docs_append", "ws_docs_insert_at_heading", "ws_docs_rewrite_passages",
  "ws_sheets_write", "ws_sheets_append", "ws_sheets_set_number_format", "ws_sheets_rename_tab"]);
export const isLiveOp = (tool) => LIVE_OPS.has(tool);
/**
 * R-LIVE: a live ack is verified against the saved file, so a change is offered for live apply only when its
 * postcondition can be decided (single-pair find/replace with counts, an append with a known first paragraph…).
 * Everything else waits for close-time apply.
 */
export function liveEligible(tool, args = {}, pre = null) {
  if (!isLiveOp(tool) || pre?.undo_of) return false; // spec §5.7: undo (every step of a queued inverse) is close-time only
  switch (tool) {
    case "ws_docs_find_replace": return pairsOf(args).length === 1 && Number.isInteger(pre?.rcount);
    case "ws_docs_append": case "ws_docs_insert_at_heading": return Number.isInteger(pre?.count) && !!pre?.text;
    case "ws_sheets_append": return Number.isInteger(pre?.last_row);
    // T13 fix I1: the file op's own guardrails ran on the saved file at queue time (snapshot dry run); the editor
    // cannot check them. Residual: a link/field added in the editor after the last save is not seen.
    case "ws_docs_rewrite_passages": return !!pre?.new_counts && pre?.plain === true;
    case "ws_sheets_write": return pre?.guarded === true;
    default: return true;
  }
}

/** The internal exact-inverse ops (registered in ALL_DEFS only, never as MCP tools). */
export const INTERNAL_OPS = Object.freeze(["ws__docs_remove_paragraphs_exact", "ws__docs_delete_comment", "ws__sheets_clear_rows_exact", "ws__sheets_restore_styles"]);
/** K5-I7: the ONLY inverse tool accepted for each live tool (never anything else, never a ws_drive_* tool). */
export const INVERSE_OF = Object.freeze({ ws_docs_find_replace: "ws_docs_find_replace", ws_docs_rewrite_passages: "ws_docs_rewrite_passages", ws_docs_format_text: "ws_docs_format_text",
  ws_docs_append: "ws__docs_remove_paragraphs_exact", ws_docs_insert_at_heading: "ws__docs_remove_paragraphs_exact", ws_docs_add_comment: "ws__docs_delete_comment",
  ws_sheets_write: "ws_sheets_write", ws_sheets_append: "ws__sheets_clear_rows_exact", ws_sheets_set_number_format: "ws__sheets_restore_styles",
  ws_sheets_rename_tab: "ws_sheets_rename_tab", ws_slides_edit_text: "ws_slides_edit_text", ws_slides_find_replace: "ws_slides_find_replace" });
/** Pin a reported inverse to the allowed tool and THIS file; anything off-list → null (undo_via_versions), never a partial inverse. */
export function pinInverse(row, inverse) {
  if (!Array.isArray(inverse) || !inverse.length || inverse.length > 20) return null;
  const allowed = INVERSE_OF[row.tool]; if (!allowed) return null;
  const out = inverse.filter((x) => x && x.tool === allowed && x.args && typeof x.args === "object" && !Array.isArray(x.args))
    .map((x) => { const { path, file_id, if_open, wait_s, ...rest } = x.args; return { tool: allowed, args: { ...rest, path: row.path } }; });
  return out.length === inverse.length ? out : null;
}

const nfc = (s) => String(s ?? "").normalize("NFC");
const fold = (s, matchCase) => (matchCase === false ? nfc(s).toLowerCase() : nfc(s));
const countOf = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
const docText = (d) => allParagraphs(d).map(({ p }) => textMap(p).text).join("\n").normalize("NFC");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const pairsOf = (a) => a.pairs || (a.find !== undefined ? [{ find: a.find, replace: a.replace ?? "", match_case: a.match_case }] : []);
const caseOf = (a, p) => p.match_case ?? a.match_case ?? true;
/** Occurrences of `find` that are NOT part of an occurrence of `replace` (so "taco"→"tacos" is seen as done). */
const remainingFinds = (hay, f, r) => Math.max(0, countOf(hay, f) - (r.includes(f) ? countOf(r, f) * countOf(hay, r) : 0));

/** The text of the first non-empty paragraph the markdown becomes (what the engine — and the plugin — inserts). */
function firstInsertedText(d, md) {
  for (const n of markdownToBlocks(d, md)) for (const p of n.localName === "p" ? [n] : all(n, NS.w, "p")) { const t = paragraphText(p).normalize("NFC").trim(); if (t) return t; }
  return "";
}
/**
 * rewrite_passages: how many paragraphs read exactly each new_text (trimmed, NFC) — counted at queue time, so the
 * postcondition is "at least that many more", never mere presence. A new_text with a line break or tab cannot be
 * compared paragraph-for-paragraph → no snapshot (undecidable: never live, never "detected").
 */
const rewriteTexts = (args) => (args.passages || []).map((p) => nfc(p.new_text).trim());
const paraCount = (d, text) => allParagraphs(d).filter(({ p }) => paragraphText(p).normalize("NFC").trim() === text).length;
const sectionHash = (d, heading) => { const r = sectionRange(d, heading); return sha(topBlocks(d).slice(r.start + 1, r.end).map((b) => all(b, NS.w, "p").concat(b.localName === "p" ? [b] : []).map(paragraphText).join("\n")).join("\n\u0001")); };
const slideTexts = (deck, slideIds) => deck.slides.filter((s) => !slideIds || slideIds.map(String).includes(String(s.id))).map((s) => all(deck.pkg.xml(s.part), NS.a, "p").map(paraText).join("\n")).join("\n").normalize("NFC");
const tabExists = (wb, name) => { try { sheetByName(wb, name); return true; } catch { return false; } };
const appendRowsOf = (args, header) => {
  let v = args.values; if (v && !Array.isArray(v) && typeof v === "object") v = [v];
  if (!Array.isArray(v) || !v.length) return null;
  if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) { if (!header) return null; return v.map((o) => { const n = Object.fromEntries(Object.entries(o).map(([k, x]) => [nfc(k), x])); return header.map((h) => (Object.hasOwn(n, h) ? n[h] : "")); }); }
  return v.every(Array.isArray) ? v : [v];
};
/** A written value vs what the cell reads back: ISO dates may have become date serials. */
const sameWritten = (want, got) => {
  if (sameRows(got, want)) return true;
  if (want.length !== got.length) return false;
  return want.every((row, i) => row.every((w, j) => { const g = got[i]?.[j]; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(w ?? "")); return cellKey(g) === cellKey(w) || (m && Number(g) === dateToSerial(+m[1], +m[2], +m[3])); }) && (got[i] || []).slice(row.length).every((g) => cellKey(g) === ""));
};

/** Precondition snapshot at queue time. Throws the tool's own error (bad_range, heading_not_found…) when the change could never apply. */
export function snapshot(tool, args, bytes) {
  switch (tool) {
    case "ws_docs_find_replace": { const d = openDocx(bytes); const ps = pairsOf(args); if (ps.length !== 1) return null; const t = docText(d); const mc = caseOf(args, ps[0]); return { fcount: countOf(fold(t, mc), fold(ps[0].find, mc)), rcount: countOf(fold(t, mc), fold(ps[0].replace, mc)) }; }
    case "ws_docs_append": case "ws_docs_insert_at_heading": { const d = openDocx(bytes); if (tool === "ws_docs_insert_at_heading") sectionRange(d, args.heading); const text = firstInsertedText(d, args.markdown); return text ? { text, count: paraCount(d, text) } : null; }
    case "ws_docs_replace_section": return { section_hash: sectionHash(openDocx(bytes), args.heading) };
    case "ws_docs_rewrite_passages": {
      const ts = rewriteTexts(args); if (!ts.length || ts.some((t) => /[\n\t]/.test(t))) return null;
      const d = openDocx(bytes);
      // T13 fix I1: dry run of the file op on a throwaway copy — every passage must match a PLAIN paragraph (no link,
      // field, image, tracked change…), or the change is never offered live (the editor cannot tell).
      const plain = rewritePassages(openDocx(bytes), args.passages).results.every((r) => r.matched);
      return { new_counts: Object.fromEntries([...new Set(ts)].map((t) => [t, paraCount(d, t)])), plain };
    }
    case "ws_sheets_write": {
      // T13 fix I1: the file op's guardrails (merged non-anchor cell, partial shared formula) run NOW, on a throwaway
      // copy of the saved file: such a write is refused at queue time instead of being offered live.
      writeRange(openXlsx(bytes), args.range, args.values, args.value_input_option || "USER_ENTERED");
      return { cells: readRange(openXlsx(bytes), args.range, "FORMULA").values, guarded: true };
    }
    case "ws_sheets_append": { const wb = openXlsx(bytes); return { header: headerRow(wb, args.sheet_name), last_row: lastDataRow(wb, args.sheet_name) }; }
    case "ws_sheets_set_number_format": return { s_attrs: styleAttrs(openXlsx(bytes), args.range) };
    case "ws_slides_edit_text": return { text: shapeText(shapeById(openPptx(bytes), args.object_id).sp) };
    case "ws_slides_find_replace": { const ps = pairsOf(args); if (ps.length !== 1) return null; const t = slideTexts(openPptx(bytes), args.slide_ids); const mc = caseOf(args, ps[0]); return { fcount: countOf(fold(t, mc), fold(ps[0].find, mc)), rcount: countOf(fold(t, mc), fold(ps[0].replace, mc)) }; }
    default: return null;
  }
}

const OK = { ok: true };
const no = (reason = "target_changed") => ({ ok: false, reason });
/** The tool-level precondition (anchor + snapshot) on the saved bytes. */
function toolPre(tool, args, pre, bytes) {
  switch (tool) {
    case "ws_docs_find_replace": {
      const t = docText(openDocx(bytes));
      if (args.expect_count !== undefined) { const p = pairsOf(args)[0]; const mc = caseOf(args, p); return countOf(fold(t, mc), fold(p.find, mc)) === Number(args.expect_count) ? OK : no(); } // an exact inverse is count-checked
      return pairsOf(args).some((p) => { const mc = caseOf(args, p); return remainingFinds(fold(t, mc), fold(p.find, mc), fold(p.replace, mc)) > 0; }) ? OK : no();
    }
    case "ws_docs_insert_at_heading": try { sectionRange(openDocx(bytes), args.heading); return OK; } catch { return no(); }
    case "ws_docs_replace_section": try { return !pre?.section_hash || sectionHash(openDocx(bytes), args.heading) === pre.section_hash ? OK : no(); } catch { return no(); }
    case "ws_docs_rewrite_passages": { const lines = docText(openDocx(bytes)).split("\n"); return args.passages.some((p) => lines.some((line) => line.normalize("NFC").startsWith(nfc(p.match_prefix)))) ? OK : no(); }
    case "ws_docs_format_text": case "ws_docs_add_comment": { const needle = args.find ?? args.quoted_text; return !needle || docText(openDocx(bytes)).includes(nfc(needle)) ? OK : no(); }
    case "ws_sheets_write": try { const cur = readRange(openXlsx(bytes), args.range, "FORMULA").values; return pre?.cells === undefined || sameRows(cur, pre.cells) ? OK : no(); } catch { return no(); }
    case "ws_sheets_append": try { const h = headerRow(openXlsx(bytes), args.sheet_name); return !pre?.header || JSON.stringify(h) === JSON.stringify(pre.header) ? OK : no(); } catch { return no(); }
    case "ws_sheets_add_tab": try { return tabExists(openXlsx(bytes), args.title) ? no() : OK; } catch { return no(); }
    case "ws_sheets_rename_tab": case "ws_sheets_delete_tab": try { return tabExists(openXlsx(bytes), args.title) ? OK : no(); } catch { return no(); }
    case "ws_slides_edit_text": try { return pre?.text === undefined || shapeText(shapeById(openPptx(bytes), args.object_id).sp) === pre.text ? OK : no(); } catch { return no(); }
    case "ws_slides_find_replace": { const t = slideTexts(openPptx(bytes), args.slide_ids); if (args.expect_count !== undefined) { const p = pairsOf(args)[0]; const mc = caseOf(args, p); return countOf(fold(t, mc), fold(p.find, mc)) === Number(args.expect_count) ? OK : no(); } return pairsOf(args).some((p) => { const mc = caseOf(args, p); return remainingFinds(fold(t, mc), fold(p.find, mc), fold(p.replace, mc)) > 0; }) ? OK : no(); }
    case "ws_slides_duplicate_slide": case "ws_slides_delete_slide": case "ws_slides_add_text_box": case "ws_slides_add_image": case "ws_slides_edit_notes": try { slideById(openPptx(bytes), args.slide_id); return OK; } catch { return no(); }
    default: return OK; // the tool's own validation (not_found, comment_not_found…) is the anchor check at apply time
  }
}

/**
 * Precondition at apply time. An undo's inverse (pre.undo_of) first requires the ORIGINAL change to still be in the
 * file exactly (its postcondition) — otherwise changed_since (spec §5.8) — and an add_tab inverse requires the tab
 * to be still empty.
 */
export function checkPre(tool, args, pre, bytes) {
  try {
    if (pre?.orig) { if (checkPost(pre.orig.tool, pre.orig.args, bytes, pre.orig.pre) !== true) return no("changed_since"); }
    if (pre?.undo_of && tool === "ws_sheets_delete_tab") { const wb = openXlsx(bytes); if (!tabExists(wb, args.title)) return no("changed_since"); if (readRange(wb, `'${sheetByName(wb, args.title).name.replace(/'/g, "''")}'`, "FORMULA").values.some((r) => r.some((v) => cellKey(v) !== ""))) return no("changed_since"); }
    const r = toolPre(tool, args, pre, bytes);
    return !r.ok && pre?.undo_of ? no("changed_since") : r;
  } catch (e) { if (e instanceof WsError) return no(); throw e; }
}

/** Is the change already in these (saved) bytes? true | false | null (cannot tell). */
export function checkPost(tool, args, bytes, pre = null) {
  try {
    switch (tool) {
      case "ws_docs_find_replace": case "ws_slides_find_replace": {
        const ps = pairsOf(args); if (ps.length !== 1 || !pre || !Number.isInteger(pre.rcount)) return null;
        const t = tool === "ws_docs_find_replace" ? docText(openDocx(bytes)) : slideTexts(openPptx(bytes), args.slide_ids);
        const mc = caseOf(args, ps[0]); const f = fold(ps[0].find, mc), r = fold(ps[0].replace, mc), h = fold(t, mc);
        if (!r) return remainingFinds(h, f, r) === 0 && pre.fcount > 0 ? true : remainingFinds(h, f, r) > 0 ? false : null;
        return remainingFinds(h, f, r) === 0 && countOf(h, r) > pre.rcount;
      }
      case "ws_docs_append": case "ws_docs_insert_at_heading": return pre && Number.isInteger(pre.count) && pre.text ? paraCount(openDocx(bytes), pre.text) > pre.count : null;
      case "ws_docs_rewrite_passages": {
        if (!pre?.new_counts) return null;
        const d = openDocx(bytes); const need = {}; for (const t of rewriteTexts(args)) need[t] = (need[t] || 0) + 1;
        return Object.entries(need).every(([t, n]) => Number.isInteger(pre.new_counts[t]) && paraCount(d, t) >= pre.new_counts[t] + n);
      }
      case "ws_sheets_write": { const want = (Array.isArray(args.values[0]) ? args.values : [args.values]); return sameWritten(want, readRange(openXlsx(bytes), args.range, "FORMULA").values); }
      case "ws_sheets_append": {
        if (!pre || !Number.isInteger(pre.last_row)) return null;
        const wb = openXlsx(bytes); const rows = appendRowsOf(args, pre.header); if (!rows) return null;
        const width = Math.max(1, ...rows.map((r) => r.length));
        return sameWritten(rows, rowsFormula(wb, args.sheet_name, pre.last_row + 1, pre.last_row + rows.length, width));
      }
      case "ws_sheets_set_number_format": { const pat = patternFor(args.pattern, args.format_type ?? "TEXT"); return numFmtCodes(openXlsx(bytes), args.range).every((row) => row.every((c) => c === pat)); }
      case "ws_sheets_add_tab": return tabExists(openXlsx(bytes), args.title);
      case "ws_sheets_rename_tab": { const wb = openXlsx(bytes); return tabExists(wb, args.new_title) && (nfc(args.title).toLowerCase() === nfc(args.new_title).toLowerCase() || !tabExists(wb, args.title)); }
      case "ws_slides_edit_text": return shapeText(shapeById(openPptx(bytes), args.object_id).sp) === args.new_text;
      default: return null; // cannot tell → ambiguous (never re-applied blindly)
    }
  } catch (e) { if (e instanceof WsError) return null; throw e; }
}
