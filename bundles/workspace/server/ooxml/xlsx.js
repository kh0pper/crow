/** SpreadsheetML model for the Sheets tools (spec §4.5): ranges, styled writes, formula freshness, merged/shared-formula guards, tab ops. */
import { WsError } from "../result.js";
import { NS, kids, kid, attr, el, removeNode, parseXml } from "./xml.js";
import { OoxmlPackage } from "./zip.js";
import { mainPart, readRels, resolveTarget, addRel, removeRel, partsOfType, setOverride, removeOverride, relsPath, REL } from "./opc.js";
import { formatValue, codeFor, isDateCode, dateToSerial } from "./xlsx-format.js";

const S = NS.s;
const XM = "http://schemas.microsoft.com/office/excel/2006/main";
export const MAX_CELLS = 50000;
export const colName = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const colNum = (s) => [...s.toUpperCase()].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
export function parseA1(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) throw new WsError("bad_range", `"${ref}" is not a cell like B3`);
  const p = { c: colNum(m[1]), r: Number(m[2]) };
  if (p.c > 16384 || p.r < 1 || p.r > 1048576) throw new WsError("bad_range", `"${ref}" is outside the sheet (max XFD1048576)`);
  return p;
}
const a1 = (r, c) => `${colName(c)}${r}`;
/** Position of a stored cell; every writer we target (ONLYOFFICE, Excel, LibreOffice, openpyxl) writes @r. */
function posOf(cell) {
  const r = cell.getAttribute("r");
  if (!r) throw new WsError("malformed_document", "this sheet has cells without a reference (r attribute); open and save it in the editor first");
  return parseA1(r);
}
const TAB_BAD = /[[\]:*?/\\]/;
export function checkTabName(wb, name, except = null) {
  const s = String(name).normalize("NFC");
  if (!s || s.length > 31 || TAB_BAD.test(s) || s.startsWith("'") || s.endsWith("'")) throw new WsError("bad_args", "tab names are 1-31 characters without [ ] : * ? / \\ and cannot start or end with '");
  if (wb.sheets.some((x) => x !== except && x.name.toLowerCase() === s.toLowerCase())) throw new WsError("bad_args", `a tab named "${s}" already exists`);
  return s;
}

export function openXlsx(bytes) {
  const pkg = OoxmlPackage.open(bytes);
  const part = mainPart(pkg);
  const doc = pkg.xml(part);
  if (doc.documentElement.localName !== "workbook") throw new WsError("wrong_type", "this is not an Excel (.xlsx) workbook");
  const rels = readRels(pkg, part);
  const sheets = kids(kid(doc.documentElement, S, "sheets"), S, "sheet").map((e, index) => {
    const rid = attr(e, NS.r, "id"); const rel = rels.find((r) => r.id === rid);
    return { el: e, name: e.getAttribute("name"), sheetId: Number(e.getAttribute("sheetId")), rid, state: e.getAttribute("state") || "visible", part: rel ? resolveTarget(part, rel.target) : null, index };
  });
  const sstPart = partsOfType(pkg, part, REL.sharedStrings)[0] || null;
  const sst = sstPart ? kids(pkg.xml(sstPart).documentElement, S, "si").map((si) => Array.from(si.getElementsByTagNameNS(S, "t")).filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join("")) : [];
  const stylesPart = partsOfType(pkg, part, REL.styles)[0] || null;
  const sdoc = stylesPart ? pkg.xml(stylesPart) : null;
  const numFmts = new Map(sdoc ? kids(kid(sdoc.documentElement, S, "numFmts"), S, "numFmt").map((n) => [Number(n.getAttribute("numFmtId")), n.getAttribute("formatCode")]) : []);
  const xfs = sdoc ? kids(kid(sdoc.documentElement, S, "cellXfs"), S, "xf") : [];
  return { pkg, part, doc, sheets, sst, styles: { part: stylesPart, doc: sdoc, numFmts, xfs } };
}

export function sheetByName(wb, name) {
  const want = String(name).normalize("NFC");
  const s = wb.sheets.find((x) => x.name.normalize("NFC") === want) || wb.sheets.find((x) => x.name.normalize("NFC").toLowerCase() === want.toLowerCase());
  if (!s) throw new WsError("tab_not_found", `No tab "${name}". Tabs: ${wb.sheets.map((x) => x.name).join(", ")}`);
  return s;
}
/** "sheet" for a worksheet, "chart" for a chartsheet, else the root element name (dialogsheet, …). */
function tabKind(wb, s) {
  if (!s.part || !wb.pkg.has(s.part)) return "missing";
  const n = wb.pkg.xml(s.part).documentElement.localName;
  return n === "worksheet" ? "sheet" : n === "chartsheet" ? "chart" : n;
}
function sheetDoc(wb, s) {
  if (!s.part || !wb.pkg.has(s.part)) throw new WsError("malformed_document", `tab "${s.name}" has no worksheet part`);
  const doc = wb.pkg.xml(s.part);
  if (doc.documentElement.localName !== "worksheet") throw new WsError("unsupported", `tab "${s.name}" is not a worksheet (chart sheets are not supported)`);
  return doc;
}
function sheetData(wb, s) {
  const root = sheetDoc(wb, s).documentElement; const sd = kid(root, S, "sheetData");
  if (!sd) throw new WsError("malformed_document", `tab "${s.name}" has no sheetData`);
  return sd;
}

function usedRange(wb, s) {
  const dim = kid(sheetDoc(wb, s).documentElement, S, "dimension")?.getAttribute("ref");
  if (dim && dim.includes(":")) { const [a, b] = dim.split(":").map(parseA1); return { r1: a.r, c1: a.c, r2: b.r, c2: b.c }; }
  let r2 = 1, c2 = 1;
  for (const row of kids(sheetData(wb, s), S, "row")) for (const c of kids(row, S, "c")) { const p = posOf(c); r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c); }
  return { r1: 1, c1: 1, r2, c2 };
}

export function parseRange(wb, str) {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))(?:!(.+))?$/.exec(String(str).trim());
  if (!m) throw new WsError("bad_range", `"${str}" is not a range like Tab!A1:C10`);
  const sheet = sheetByName(wb, (m[1] ? m[1].replace(/''/g, "'") : m[2]).trim());
  if (!m[3]) return { sheet, ...usedRange(wb, sheet) };
  const [x, y = x, extra] = m[3].split(":");
  if (extra !== undefined) throw new WsError("bad_range", `"${str}" is not a range like Tab!A1:C10`);
  if (/^[A-Za-z]{1,3}$/.test(x) && /^[A-Za-z]{1,3}$/.test(y)) { const u = usedRange(wb, sheet); const [c1, c2] = [colNum(x), colNum(y)].sort((p, q) => p - q); return { sheet, r1: 1, c1, r2: u.r2, c2 }; }
  const a = parseA1(x), b = parseA1(y);
  return { sheet, r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}
const cellCount = (R) => (R.r2 - R.r1 + 1) * (R.c2 - R.c1 + 1);

/** row number → {row, cells: Map(col → <c>)}; built once per operation. */
function grid(wb, s) {
  const m = new Map();
  // <col min max style> ranges, for new cells in rows without their own format
  m.colStyles = kids(kid(sheetDoc(wb, s).documentElement, S, "cols"), S, "col").filter((c) => c.getAttribute("style")).map((c) => ({ min: Number(c.getAttribute("min")), max: Number(c.getAttribute("max")), style: c.getAttribute("style") }));
  for (const row of kids(sheetData(wb, s), S, "row")) {
    const cells = new Map(); for (const c of kids(row, S, "c")) cells.set(posOf(c).c, c);
    m.set(Number(row.getAttribute("r")), { row, cells });
  }
  return m;
}

function ensureCell(wb, s, g, r, c) {
  const doc = sheetDoc(wb, s); const sd = sheetData(wb, s);
  let entry = g.get(r);
  if (!entry) {
    const row = el(doc, S, "row", { r });
    // keep <row> elements in ascending r order (Review Focus 5); appending past the last row is the common case
    const rows = kids(sd, S, "row"); const last = rows.at(-1);
    const before = !last || Number(last.getAttribute("r")) < r ? null : rows.find((x) => Number(x.getAttribute("r")) > r) || null;
    sd.insertBefore(row, before);
    entry = { row, cells: new Map() }; g.set(r, entry);
  }
  entry.row.removeAttribute("spans"); // optional hint; stale after a write
  let cell = entry.cells.get(c);
  if (!cell) {
    // a new cell inherits the row's style (customFormat="1"), else the covering column's style, as editors do
    const rowStyle = entry.row.getAttribute("customFormat") === "1" || entry.row.getAttribute("customFormat") === "true" ? entry.row.getAttribute("s") : null;
    const style = rowStyle || g.colStyles?.find((x) => c >= x.min && c <= x.max)?.style || null;
    cell = el(doc, S, "c", { r: a1(r, c), s: style && style !== "0" ? style : undefined });
    const after = [...entry.cells.keys()].filter((k) => k > c).sort((p, q) => p - q)[0];
    entry.row.insertBefore(cell, after === undefined ? null : entry.cells.get(after));
    entry.cells.set(c, cell);
  }
  return cell;
}

function fmtOf(wb, cell) {
  const i = Number(cell?.getAttribute("s") || 0); const xf = wb.styles.xfs[i];
  const id = xf ? Number(xf.getAttribute("numFmtId") || 0) : 0;
  return { id, code: codeFor(id, wb.styles.numFmts.get(id)) };
}

function sharedMaster(wb, s, si) {
  for (const row of kids(sheetData(wb, s), S, "row")) for (const c of kids(row, S, "c")) { const f = kid(c, S, "f"); if (f && f.getAttribute("t") === "shared" && f.getAttribute("si") === si && f.getAttribute("ref")) return { cell: c, f }; }
  return null;
}
/** Shift relative A1 references by (dr, dc); string literals and $-anchored parts are kept. */
export function shiftFormula(text, dr, dc) {
  return text.replace(/("(?:[^"]|"")*")|(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\d(A-Za-z_])/g, (m, str, d1, col, d2, row, off, all) => {
    if (str) return str;
    if (off > 0 && /[A-Za-z_\d.]/.test(all[off - 1])) return m;
    return `${d1}${d1 ? col : colName(colNum(col) + dc)}${d2}${d2 ? row : Number(row) + dr}`;
  });
}

function cellValue(wb, s, cell, mode) {
  if (!cell) return { v: "", stale: false };
  const t = cell.getAttribute("t") || "n"; const vEl = kid(cell, S, "v"); const f = kid(cell, S, "f");
  let raw = vEl ? vEl.textContent : null;
  if (t === "s" && raw !== null) raw = wb.sst[Number(raw)] ?? "";
  if (t === "inlineStr") raw = Array.from(kid(cell, S, "is")?.getElementsByTagNameNS(S, "t") || []).filter((x) => x.parentNode.localName !== "rPh").map((x) => x.textContent).join("");
  if (mode === "FORMULA" && f) {
    let text = f.textContent;
    if (!text && f.getAttribute("t") === "shared") { const m = sharedMaster(wb, s, f.getAttribute("si")); if (m) { const a = posOf(m.cell), b = posOf(cell); text = shiftFormula(m.f.textContent, b.r - a.r, b.c - a.c); } }
    return { v: `=${text}`, stale: false };
  }
  // a formula with no cached result: no <v>, or an empty <v/> that is not a string result (openpyxl writes <v></v>)
  const stale = !!f && (vEl === null || (vEl.textContent === "" && t !== "str"));
  if (raw === null || (stale && raw === "")) return { v: "", stale };
  if (mode !== "FORMATTED_VALUE") return { v: t === "n" ? Number(raw) : t === "b" ? raw === "1" : raw, stale };
  return { v: formatValue(raw, t === "s" || t === "inlineStr" || t === "str" ? "s" : t, fmtOf(wb, cell)), stale };
}

export function readRange(wb, range, mode = "FORMATTED_VALUE") {
  if (!["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"].includes(mode)) throw new WsError("bad_args", "value_render_option must be FORMATTED_VALUE, UNFORMATTED_VALUE or FORMULA");
  const R = parseRange(wb, range);
  if (cellCount(R) > MAX_CELLS) throw new WsError("too_large", `read at most ${MAX_CELLS} cells per call (asked for ${cellCount(R)}); split the range`);
  const g = grid(wb, R.sheet); const values = []; let stale = false;
  for (let r = R.r1; r <= R.r2; r++) {
    const cells = g.get(r)?.cells; const row = [];
    for (let c = R.c1; c <= R.c2; c++) { const x = cellValue(wb, R.sheet, cells?.get(c) || null, mode); stale ||= x.stale; row.push(x.v); }
    while (row.length && row.at(-1) === "") row.pop();
    values.push(row);
  }
  while (values.length && !values.at(-1).length) values.pop();
  return { range: `${R.sheet.name}!${a1(R.r1, R.c1)}:${a1(R.r2, R.c2)}`, values, stale_formulas: stale };
}

function merges(wb, s) {
  return kids(kid(sheetDoc(wb, s).documentElement, S, "mergeCells"), S, "mergeCell").map((m) => { const [a, b = a] = m.getAttribute("ref").split(":").map(parseA1); return { ref: m.getAttribute("ref"), r1: a.r, c1: a.c, r2: b.r, c2: b.c }; });
}
const overlaps = (g, R) => !(g.r2 < R.r1 || g.r1 > R.r2 || g.c2 < R.c1 || g.c1 > R.c2);

/** Review Focus 5: refuse writes into a merged area's non-anchor cells and partial shared-formula overwrites. */
function guardTargets(wb, s, R) {
  for (const m of merges(wb, s)) {
    if (!overlaps(m, R)) continue;
    for (let r = Math.max(m.r1, R.r1); r <= Math.min(m.r2, R.r2); r++) for (let c = Math.max(m.c1, R.c1); c <= Math.min(m.c2, R.c2); c++)
      if (!(r === m.r1 && c === m.c1)) throw new WsError("merged_cell", `${a1(r, c)} is inside the merged area ${m.ref}; write to its top-left cell ${a1(m.r1, m.c1)} instead.`);
  }
  for (const row of kids(sheetData(wb, s), S, "row")) for (const c of kids(row, S, "c")) {
    const f = kid(c, S, "f"); const ref = f?.getAttribute("t") === "shared" ? f.getAttribute("ref") : null;
    if (!ref) continue;
    const [a, b = a] = ref.split(":").map(parseA1); const g = { r1: a.r, c1: a.c, r2: b.r, c2: b.c };
    const covers = R.r1 <= g.r1 && R.r2 >= g.r2 && R.c1 <= g.c1 && R.c2 >= g.c2;
    if (overlaps(g, R) && !covers) throw new WsError("shared_formula", `Those cells are part of a shared formula over ${ref}. Write the whole range ${ref} at once, or edit it in the editor.`);
  }
}

const scalar = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v);
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/**
 * USER_ENTERED: "=…" → formula (no cached <v>), numeric text → number, TRUE/FALSE → boolean, ISO date into a
 * date-formatted cell → serial; text-formatted ("@") cells keep strings as text. RAW (Google semantics): JSON
 * numbers/booleans keep their type, strings are never parsed. The cell's s (style) attribute is always kept.
 */
function setCell(wb, s, cell, value, input) {
  const doc = sheetDoc(wb, s);
  for (const ch of Array.from(cell.childNodes)) cell.removeChild(ch);
  cell.removeAttribute("t");
  cell.removeAttribute("cm"); cell.removeAttribute("vm"); // cell/value metadata (dynamic arrays, rich values) belongs to the old value
  const v = scalar(value);
  const put = (t, child) => { if (t) cell.setAttribute("t", t); if (child) cell.appendChild(child); };
  if (v === "") return;
  if (typeof v === "boolean") return put("b", el(doc, S, "v", {}, [v ? "1" : "0"]));
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new WsError("bad_args", "numbers must be finite"); return put(null, el(doc, S, "v", {}, [String(v)])); }
  const str = String(v).normalize("NFC");
  if (input === "USER_ENTERED" && fmtOf(wb, cell).code !== "@") {
    if (str.startsWith("=") && str.length > 1) return put(null, el(doc, S, "f", {}, [str.slice(1)]));
    if (NUM.test(str.trim()) && Number.isFinite(Number(str))) return put(null, el(doc, S, "v", {}, [String(Number(str))]));
    if (/^(true|false)$/i.test(str)) return put("b", el(doc, S, "v", {}, [/^true$/i.test(str) ? "1" : "0"]));
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (dm && isDateCode(fmtOf(wb, cell).code)) return put(null, el(doc, S, "v", {}, [String(dateToSerial(+dm[1], +dm[2], +dm[3]))]));
  }
  if (str.length > 32767) throw new WsError("bad_args", "a cell holds at most 32,767 characters");
  const t = el(doc, S, "t", {}, [str]); t.setAttributeNS(NS.xml, "xml:space", "preserve");
  put("inlineStr", el(doc, S, "is", {}, [t]));
}

/** <dimension> grows to cover the write; inserted right after <sheetPr> when missing (CT_Worksheet order). */
function growDimension(wb, s, R) {
  const root = sheetDoc(wb, s).documentElement; const doc = root.ownerDocument;
  const u = usedRange(wb, s); const dim = kid(root, S, "dimension");
  const ref = `${a1(Math.min(u.r1, R.r1), Math.min(u.c1, R.c1))}:${a1(Math.max(u.r2, R.r2), Math.max(u.c2, R.c2))}`;
  if (dim) { dim.setAttribute("ref", ref); return; }
  const sheetPr = kid(root, S, "sheetPr");
  root.insertBefore(el(doc, S, "dimension", { ref }), sheetPr ? sheetPr.nextSibling : root.firstChild);
}

/** fullCalcOnLoad + drop calcChain (part, relationship, override) so editors recalculate (spec §4.5). */
export function markRecalc(wb) {
  const root = wb.doc.documentElement;
  let calc = kid(root, S, "calcPr");
  if (!calc) {
    calc = el(wb.doc, S, "calcPr", { calcId: "0" });
    // CT_Workbook order: … sheets, functionGroups, externalReferences, definedNames, calcPr …
    const after = ["definedNames", "externalReferences", "functionGroups", "sheets"].map((n) => kid(root, S, n)).find(Boolean);
    root.insertBefore(calc, after ? after.nextSibling : null);
  }
  calc.setAttribute("fullCalcOnLoad", "1");
  for (const cc of readRels(wb.pkg, wb.part).filter((r) => r.type === REL.calcChain)) {
    const p = resolveTarget(wb.part, cc.target);
    if (wb.pkg.has(p)) wb.pkg.remove(p);
    removeRel(wb.pkg, wb.part, cc.id); removeOverride(wb.pkg, p);
  }
  wb.pkg.markDirty(wb.part);
}

function toRows(values) {
  if (!Array.isArray(values) || !values.length) throw new WsError("bad_args", "values cannot be empty");
  const rows = values.every(Array.isArray) ? values : values.some(Array.isArray) ? null : [values];
  if (!rows) throw new WsError("bad_args", "values must be one row (a flat list) or a list of rows, not a mix");
  if (!rows.some((r) => r.length)) throw new WsError("bad_args", "values cannot be empty");
  return rows;
}

export function writeRange(wb, range, values, input = "USER_ENTERED") {
  if (!["USER_ENTERED", "RAW"].includes(input)) throw new WsError("bad_args", "value_input_option must be USER_ENTERED or RAW");
  const rows = toRows(values); const R0 = parseRange(wb, range);
  const R = { ...R0, r2: R0.r1 + rows.length - 1, c2: R0.c1 + Math.max(...rows.map((x) => x.length)) - 1 };
  if (cellCount(R) > MAX_CELLS) throw new WsError("too_large", `write at most ${MAX_CELLS} cells per call`);
  if (R.c2 > 16384 || R.r2 > 1048576) throw new WsError("bad_range", "the write runs past the edge of the sheet (XFD1048576)");
  guardTargets(wb, R.sheet, R);
  const g = grid(wb, R.sheet); let n = 0;
  rows.forEach((row, i) => row.forEach((v, j) => { setCell(wb, R.sheet, ensureCell(wb, R.sheet, g, R.r1 + i, R.c1 + j), v, input); n++; }));
  growDimension(wb, R.sheet, R);
  wb.pkg.markDirty(R.sheet.part); markRecalc(wb);
  return { cells: n, range: `${R.sheet.name}!${a1(R.r1, R.c1)}:${a1(R.r2, R.c2)}` };
}

const qualified = (s, ref) => `'${s.name.replace(/'/g, "''")}'!${ref}`;

export function appendRows(wb, sheetName, values, input = "USER_ENTERED") {
  const s = sheetByName(wb, sheetName);
  if (values && !Array.isArray(values) && typeof values === "object") values = [values];
  if (!Array.isArray(values) || !values.length) throw new WsError("bad_args", "values cannot be empty");
  const isDict = (v) => v && typeof v === "object" && !Array.isArray(v);
  let rows;
  if (values.every(isDict)) {
    if (values.every((o) => !Object.keys(o).length)) throw new WsError("bad_args", "values cannot be empty");
    const u = usedRange(wb, s);
    const header = (readRange(wb, qualified(s, `A1:${colName(Math.max(1, u.c2))}1`)).values[0] || []).map(String);
    rows = values.map((o) => {
      const bad = Object.keys(o).filter((k) => !header.includes(k.normalize("NFC")));
      if (bad.length) throw new WsError("bad_args", `Unknown column(s) ${bad.join(", ")}. Headers: ${header.join(", ")}`);
      const norm = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.normalize("NFC"), v]));
      return header.map((h) => (Object.hasOwn(norm, h) ? norm[h] : ""));
    });
  } else if (values.some(isDict) && !values.every(Array.isArray)) throw new WsError("bad_args", "values must be rows or dicts, not a mix");
  else rows = toRows(values);
  let last = 0;
  for (const row of kids(sheetData(wb, s), S, "row")) if (kids(row, S, "c").some((c) => kid(c, S, "v") || kid(c, S, "is") || kid(c, S, "f"))) last = Math.max(last, Number(row.getAttribute("r")));
  const r = writeRange(wb, qualified(s, `A${last + 1}`), rows, input);
  return { range: r.range, rows: rows.length };
}

export function tabsInfo(wb) {
  return wb.sheets.map((s) => {
    const kind = tabKind(wb, s);
    if (kind !== "sheet") return { sheet_id: s.sheetId, index: s.index, title: s.name, kind, rows: 0, cols: 0, frozen_rows: 0, frozen_cols: 0, hidden: s.state !== "visible" };
    const doc = sheetDoc(wb, s); const pane = kid(kid(kid(doc.documentElement, S, "sheetViews"), S, "sheetView"), S, "pane");
    const frozen = pane && /frozen/.test(pane.getAttribute("state") || "");
    const u = usedRange(wb, s);
    return { sheet_id: s.sheetId, index: s.index, title: s.name, kind, rows: u.r2, cols: u.c2, frozen_rows: frozen ? Number(pane.getAttribute("ySplit") || 0) : 0, frozen_cols: frozen ? Number(pane.getAttribute("xSplit") || 0) : 0, hidden: s.state !== "visible" };
  });
}

const WORKSHEET_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
export function addTab(wb, title, index) {
  const name = checkTabName(wb, title);
  let n = 1; while (wb.pkg.has(`xl/worksheets/sheet${n}.xml`)) n++;
  const part = `xl/worksheets/sheet${n}.xml`;
  wb.pkg.setXml(part, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${S}" xmlns:r="${NS.r}"><dimension ref="A1"/><sheetData/></worksheet>`, part));
  const rid = addRel(wb.pkg, wb.part, REL.worksheet, resolveRelative(wb.part, part));
  setOverride(wb.pkg, part, WORKSHEET_CT);
  const sheetsEl = kid(wb.doc.documentElement, S, "sheets");
  const sheetId = Math.max(0, ...wb.sheets.map((s) => s.sheetId)) + 1;
  const e = el(wb.doc, S, "sheet", { name, sheetId, "r:id": rid });
  const at = index === undefined ? null : kids(sheetsEl, S, "sheet")[index] || null;
  sheetsEl.insertBefore(e, at);
  const fresh = { el: e, name, sheetId, rid, state: "visible", part };
  wb.sheets = kids(sheetsEl, S, "sheet").map((x, i) => ({ ...(wb.sheets.find((s) => s.el === x) || fresh), index: i }));
  shiftLocalSheetIds(wb, (l) => (at && l >= wb.sheets.find((s) => s.el === e).index ? l + 1 : l));
  wb.pkg.markDirty(wb.part);
  return { sheet_id: sheetId, title: name, index: wb.sheets.find((s) => s.el === e).index };
}
/** Relationship target for `part` relative to the workbook part's folder. */
function resolveRelative(fromPart, part) { const dir = fromPart.split("/").slice(0, -1).join("/"); return dir && part.startsWith(`${dir}/`) ? part.slice(dir.length + 1) : `/${part}`; }
function shiftLocalSheetIds(wb, fn) {
  for (const dn of kids(kid(wb.doc.documentElement, S, "definedNames"), S, "definedName")) {
    const l = dn.getAttribute("localSheetId"); if (l === null || l === "") continue;
    const nl = fn(Number(l)); if (nl === null) removeNode(dn); else dn.setAttribute("localSheetId", String(nl));
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoteTab = (n) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
/** Rewrite Tab! references (quoted or bare) outside "string literals". */
export function rewriteRefs(text, oldName, newName) {
  const q = new RegExp(`'${esc(oldName.replace(/'/g, "''"))}'!`, "g");
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(oldName) ? new RegExp(`(?<![A-Za-z0-9_.'])${esc(oldName)}!`, "g") : null;
  const to = `${quoteTab(newName)}!`;
  return text.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2) return part;
    const out = part.replace(q, to);
    return plain ? out.replace(plain, to) : out;
  }).join("");
}

export function renameTab(wb, title, newTitle) {
  const s = sheetByName(wb, title); const name = checkTabName(wb, newTitle, s);
  for (const pc of wb.pkg.names().filter((n) => /pivotCacheDefinition\d*\.xml$/.test(n))) {
    for (const ws of Array.from(wb.pkg.xml(pc).getElementsByTagNameNS(S, "worksheetSource"))) if (ws.getAttribute("sheet") === s.name) throw new WsError("pivot_refuses", "A pivot table reads from this tab; rename it in the editor instead.");
  }
  const old = s.name;
  for (const t of wb.sheets) {
    if (tabKind(wb, t) !== "sheet") continue; // chart sheets hold no formulas; their charts are rewritten below
    const doc = sheetDoc(wb, t); let dirty = false;
    const fix = (node) => { const n = rewriteRefs(node.textContent, old, name); if (n !== node.textContent) { node.textContent = n; dirty = true; } };
    // cell formulas, data-validation formula1/2, conditional-format <formula>, and x14 extension xm:f (x14:dataValidation / x14:conditionalFormatting)
    for (const [ns, local] of [[S, "f"], [S, "formula1"], [S, "formula2"], [S, "formula"], [XM, "f"]]) for (const node of Array.from(doc.getElementsByTagNameNS(ns, local))) fix(node);
    for (const h of Array.from(doc.getElementsByTagNameNS(S, "hyperlink"))) {
      const loc = h.getAttribute("location"); if (!loc) continue;
      const n = rewriteRefs(loc, old, name); if (n !== loc) { h.setAttribute("location", n); dirty = true; }
    }
    if (dirty) wb.pkg.markDirty(t.part);
  }
  for (const dn of kids(kid(wb.doc.documentElement, S, "definedNames"), S, "definedName")) { const n = rewriteRefs(dn.textContent, old, name); if (n !== dn.textContent) dn.textContent = n; }
  for (const cp of wb.pkg.names().filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))) {
    const doc = wb.pkg.xml(cp); let dirty = false;
    for (const f of Array.from(doc.getElementsByTagNameNS(NS.c, "f"))) { const n = rewriteRefs(f.textContent, old, name); if (n !== f.textContent) { f.textContent = n; dirty = true; } }
    if (dirty) wb.pkg.markDirty(cp);
  }
  s.el.setAttribute("name", name); s.name = name; wb.pkg.markDirty(wb.part);
  return { old_title: old, title: name };
}

export function deleteTab(wb, title) {
  const s = sheetByName(wb, title);
  if (wb.sheets.filter((x) => x.state === "visible" && x !== s).length === 0) throw new WsError("last_tab", "A workbook needs at least one visible tab.");
  const idx = s.index;
  removeNode(s.el); removeRel(wb.pkg, wb.part, s.rid);
  if (s.part) { if (wb.pkg.has(s.part)) wb.pkg.remove(s.part); removeOverride(wb.pkg, s.part); if (wb.pkg.has(relsPath(s.part))) wb.pkg.remove(relsPath(s.part)); }
  shiftLocalSheetIds(wb, (l) => (l === idx ? null : l > idx ? l - 1 : l));
  const bv = kid(kid(wb.doc.documentElement, S, "bookViews"), S, "workbookView");
  if (bv) for (const a of ["activeTab", "firstSheet"]) { const v = Number(bv.getAttribute(a) || 0); if (v === idx) bv.setAttribute(a, "0"); else if (v > idx) bv.setAttribute(a, String(v - 1)); }
  wb.sheets = wb.sheets.filter((x) => x !== s).map((x, i) => ({ ...x, index: i }));
  wb.pkg.markDirty(wb.part); markRecalc(wb);
  return { deleted: s.name };
}

/** Default pattern per format_type (Google Sheets NumberFormat types); an explicit pattern always wins. */
export const FORMAT_TYPE_PATTERNS = Object.freeze({ TEXT: "@", NUMBER: "#,##0.00", PERCENT: "0.00%", CURRENCY: '"$"#,##0.00', DATE: "yyyy-mm-dd", TIME: "h:mm:ss", DATE_TIME: "yyyy-mm-dd h:mm:ss", SCIENTIFIC: "0.00E+00" });
export function patternFor(pattern, formatType = "TEXT") {
  if (pattern !== undefined && pattern !== null && pattern !== "") return String(pattern);
  const p = FORMAT_TYPE_PATTERNS[String(formatType).toUpperCase()];
  if (!p) throw new WsError("bad_args", `format_type must be one of ${Object.keys(FORMAT_TYPE_PATTERNS).join(", ")}`);
  return p;
}

export function setNumberFormat(wb, range, pattern = "@") {
  if (!wb.styles.doc) throw new WsError("malformed_document", "this workbook has no styles part");
  const R = parseRange(wb, range);
  if (cellCount(R) > MAX_CELLS) throw new WsError("too_large", `format at most ${MAX_CELLS} cells per call`);
  const sd = wb.styles.doc; const root = sd.documentElement;
  let id = [...wb.styles.numFmts].find(([, code]) => code === pattern)?.[0];
  if (id === undefined && pattern === "@") id = 49; // built-in text format
  if (id === undefined) {
    let nf = kid(root, S, "numFmts"); if (!nf) { nf = el(sd, S, "numFmts", { count: 0 }); root.insertBefore(nf, kids(root)[0] || null); }
    id = Math.max(163, ...wb.styles.numFmts.keys()) + 1;
    nf.appendChild(el(sd, S, "numFmt", { numFmtId: id, formatCode: pattern })); nf.setAttribute("count", String(kids(nf, S, "numFmt").length));
    wb.styles.numFmts.set(id, pattern);
  }
  const cellXfs = kid(root, S, "cellXfs");
  if (!cellXfs || !wb.styles.xfs.length) throw new WsError("malformed_document", "this workbook has no cell formats (cellXfs)");
  const memo = new Map();
  const xfFor = (base) => {
    if (memo.has(base)) return memo.get(base);
    const src = wb.styles.xfs[base] || wb.styles.xfs[0];
    const clone = src.cloneNode(true); clone.setAttribute("numFmtId", String(id)); clone.setAttribute("applyNumberFormat", "1");
    const ser = clone.toString(); let found = wb.styles.xfs.findIndex((x) => x.toString() === ser);
    if (found < 0) { cellXfs.appendChild(clone); wb.styles.xfs.push(clone); cellXfs.setAttribute("count", String(wb.styles.xfs.length)); found = wb.styles.xfs.length - 1; }
    memo.set(base, found); return found;
  };
  const g = grid(wb, R.sheet); let n = 0;
  for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) { const cell = ensureCell(wb, R.sheet, g, r, c); cell.setAttribute("s", String(xfFor(Number(cell.getAttribute("s") || 0)))); n++; }
  growDimension(wb, R.sheet, R);
  wb.pkg.markDirty(wb.styles.part); wb.pkg.markDirty(R.sheet.part);
  return n;
}

// ---- queue guards and exact inverse ops (Task 12, K5) -------------------------------------------------

/** The last row holding a value or formula (what appendRows writes after); 0 for an empty tab. */
export function lastDataRow(wb, sheetName) {
  const s = sheetByName(wb, sheetName); let last = 0;
  for (const row of kids(sheetData(wb, s), S, "row")) if (kids(row, S, "c").some((c) => kid(c, S, "v") || kid(c, S, "is") || kid(c, S, "f"))) last = Math.max(last, Number(row.getAttribute("r")));
  return last;
}
/** Row 1 of a tab over its used columns, FORMULA mode, as strings (the header append keys dicts by). */
export function headerRow(wb, sheetName) {
  const s = sheetByName(wb, sheetName); const u = usedRange(wb, s);
  return (readRange(wb, qualified(s, `A1:${colName(Math.max(1, u.c2))}1`), "FORMULA").values[0] || []).map((v) => String(v ?? ""));
}
/** FORMULA-mode rows r1..r2 over columns 1..width of a tab. */
export function rowsFormula(wb, sheetName, r1, r2, width) {
  const s = sheetByName(wb, sheetName);
  if (r2 < r1) return [];
  return readRange(wb, qualified(s, `A${r1}:${colName(Math.max(1, width))}${r2}`), "FORMULA").values;
}
/** The number-format code of every cell in a range ("General" for a missing cell). */
export function numFmtCodes(wb, range) {
  const R = parseRange(wb, range);
  if (cellCount(R) > MAX_CELLS) throw new WsError("too_large", `at most ${MAX_CELLS} cells`);
  const g = grid(wb, R.sheet); const out = [];
  for (let r = R.r1; r <= R.r2; r++) { const row = []; for (let c = R.c1; c <= R.c2; c++) row.push(fmtOf(wb, g.get(r)?.cells.get(c) || null).code); out.push(row); }
  return out;
}

const changed = (msg) => new WsError("target_changed", msg);
/** Normalised cell value for comparisons: "" for empty, booleans as TRUE/FALSE, numbers and numeric text as numbers. */
export function cellKey(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  const s = String(v).normalize("NFC");
  if (/^(true|false)$/i.test(s)) return s.toUpperCase();
  if (NUM.test(s.trim()) && Number.isFinite(Number(s))) return String(Number(s));
  return s;
}
const rowKeys = (row) => { const k = (row || []).map(cellKey); while (k.length && k.at(-1) === "") k.pop(); return k; };
export const sameRows = (a, b) => { const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) if (JSON.stringify(rowKeys(a[i])) !== JSON.stringify(rowKeys(b[i]))) return false; return true; };

/** A cell an editor would create from nothing at (r, c): no content and only the inherited (row/column) style. */
function bareCell(cell, entry, g, c) {
  if (cell.childNodes.length || cell.getAttribute("t")) return false;
  const extra = Array.from(cell.attributes).filter((a) => a.name !== "r" && a.name !== "s"); if (extra.length) return false;
  const s = cell.getAttribute("s");
  if (!s || s === "0") return true;
  const rowStyle = ["1", "true"].includes(entry.row.getAttribute("customFormat")) ? entry.row.getAttribute("s") : null;
  return s === (rowStyle || g.colStyles?.find((x) => c >= x.min && c <= x.max)?.style || null);
}
function dropBare(entry, g, c, sd) {
  const cell = entry.cells.get(c);
  if (cell && bareCell(cell, entry, g, c)) { removeNode(cell); entry.cells.delete(c); }
  if (!entry.cells.size && Array.from(entry.row.attributes).every((a) => a.name === "r" || a.name === "spans") && !entry.row.childNodes.length) { sd.removeChild(entry.row); g.delete(Number(entry.row.getAttribute("r"))); }
}
/** The tab's <dimension> as it was before the change: a ref, or "" when the tab had none (undefined/null: leave it). */
function setDimension(wb, s, ref) {
  if (ref === undefined || ref === null) return;
  const dim = kid(sheetDoc(wb, s).documentElement, S, "dimension");
  if (ref === "") { if (dim) removeNode(dim); return; }
  if (!/^[A-Z]{1,3}\d{1,7}(:[A-Z]{1,3}\d{1,7})?$/.test(ref)) throw new WsError("bad_args", "dimension must look like A1:E6 (or \"\" for none)");
  if (dim) dim.setAttribute("ref", ref);
}
/** The tab's current <dimension> ref, "" when it has none (to record before a change). */
export function dimensionOf(wb, sheetName) { return kid(sheetDoc(wb, sheetByName(wb, sheetName)).documentElement, S, "dimension")?.getAttribute("ref") ?? ""; }

/**
 * Inverse of an append (ws__sheets_clear_rows_exact): rows from_row… must hold EXACTLY `values` (FORMULA mode) and be
 * the last data rows of the tab; their values are cleared and the cells/rows the append created are removed.
 * `dimension` (optional) restores the tab's <dimension> ref. Anything else → target_changed, nothing touched.
 */
export function clearRowsExact(wb, sheetName, fromRow, values, { dimension } = {}) {
  const s = sheetByName(wb, sheetName);
  if (!Number.isInteger(fromRow) || fromRow < 1) throw new WsError("bad_args", "from_row must be a row number");
  if (!Array.isArray(values) || !values.length || !values.every(Array.isArray)) throw new WsError("bad_args", "values must be the appended rows (a list of rows)");
  const width = Math.max(1, ...values.map((r) => r.length)); const r2 = fromRow + values.length - 1;
  if (!sameRows(rowsFormula(wb, s.name, fromRow, r2, width), values)) throw changed(`rows ${fromRow}-${r2} of "${s.name}" no longer hold exactly the appended values`);
  if (lastDataRow(wb, s.name) !== r2) throw changed(`"${s.name}" has data below the appended rows`);
  const g = grid(wb, s); const sd = sheetData(wb, s); let n = 0;
  for (let r = fromRow; r <= r2; r++) {
    const entry = g.get(r); if (!entry) continue;
    for (const c of [...entry.cells.keys()].sort((p, q) => p - q)) {
      const cell = entry.cells.get(c); if (c > width && !cell.childNodes.length) continue;
      if (c > width) throw changed(`row ${r} of "${s.name}" holds more than the appended values`);
      for (const ch of Array.from(cell.childNodes)) cell.removeChild(ch);
      for (const a of ["t", "cm", "vm"]) cell.removeAttribute(a);
      n++; dropBare(entry, g, c, sd);
    }
  }
  setDimension(wb, s, dimension);
  wb.pkg.markDirty(s.part); markRecalc(wb);
  return n;
}

