/** ws_drive_read_file (spec §4.2): office files through the readers, text files as UTF-8, everything else null. */
import { openDocx } from "./docx-model.js";
import { toMarkdown } from "./docx-read.js";
import { openXlsx, readRange } from "./xlsx.js";
import { openPptx, readDeck } from "./pptx.js";

const csv = (row) => row.map((v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",");
const TEXT_EXT = /\.(txt|text|md|markdown|csv|tsv|json|ics|vcf|xml|html?|ya?ml|log|ini|conf)$/i;
const isTextMime = (mime) => /^text\/[^\s;]+/i.test(String(mime || "").trim());
const quoteTab = (name) => `'${name.replace(/'/g, "''")}'`;

function sheetText(wb, s) {
  if (!s.part) return `## ${s.name}`;
  if (wb.pkg.xml(s.part).documentElement.localName !== "worksheet") return `## ${s.name}\n(chart sheet, no cells)`;
  try { return `## ${s.name}\n${readRange(wb, quoteTab(s.name)).values.map(csv).join("\n")}`; }
  catch (e) { if (e.code === "too_large") return `## ${s.name}\n(${e.message}; read it with ws_sheets_read in parts)`; throw e; }
}

/** name + bytes (+ the DAV content type) → text, or null when the file is not a document or text file. */
export function extractText(name, bytes, mime = "") {
  if (/\.docx$/i.test(name)) return toMarkdown(openDocx(bytes));
  if (/\.xlsx$/i.test(name)) { const wb = openXlsx(bytes); return wb.sheets.map((s) => sheetText(wb, s)).join("\n\n"); }
  if (/\.pptx$/i.test(name)) return readDeck(openPptx(bytes), true).map((s, i) => [`## Slide ${i + 1}: ${s.title}`, ...s.shapes.filter((x) => x.text && x.text !== s.title).map((x) => x.text), s.notes ? `Notes: ${s.notes}` : ""].filter(Boolean).join("\n")).join("\n\n");
  if (TEXT_EXT.test(name) || isTextMime(mime)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; } // not valid UTF-8 → not text
  }
  return null;
}
