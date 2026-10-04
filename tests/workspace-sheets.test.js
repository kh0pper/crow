import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";
import { assertOnlyPartsChanged, partText } from "./helpers/ooxml-assert.js";
import { OoxmlPackage } from "../bundles/workspace/server/ooxml/zip.js";
import { formatValue, isDateCode } from "../bundles/workspace/server/ooxml/xlsx-format.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
let fake, call, close;
const bytesOf = (p) => fake.node(p).bytes;
const put = (name, src) => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
const puts = () => fake.calls.filter((c) => c.method === "PUT").length;
before(async () => { fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" }); ({ call, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

test("rich.xlsx: formatted read; openpyxl formulas have no cached value → stale_formulas", async () => {
  put("r.xlsx", "rich.xlsx");
  const r = await call("ws_sheets_read", { path: "S/r.xlsx", range: "Recetas!A1:E2" });
  assert.deepEqual(r.data.values[0], ["Nombre", "Porciones", "Costo", "Fecha", "Total"]);
  assert.equal(r.data.values[1][2], "12.50");
  assert.equal(r.data.stale_formulas, true);
  const f = await call("ws_sheets_read", { path: "S/r.xlsx", range: "Recetas!E2", value_render_option: "FORMULA" });
  assert.equal(f.data.values[0][0], "=B2*C2");
  assert.equal((await call("ws_sheets_read", { path: "S/r.xlsx", range: "Recetas!A1", value_render_option: "PRETTY" })).success, false);
});

test("oo-rich.xlsx (ONLYOFFICE-saved): cached values are present and formatted", async () => {
  put("o.xlsx", "oo-rich.xlsx");
  const r = await call("ws_sheets_read", { path: "S/o.xlsx", range: "Recetas!E2:E4" });
  assert.deepEqual(r.data.values.map((x) => x[0]), ["50", "120", "61"]);
  assert.equal(r.data.stale_formulas, false);
  const t = await call("ws_sheets_read", { path: "S/o.xlsx", range: "'Menú semanal'!A1:B1" });
  assert.deepEqual(t.data.values[0], ["Jueves", "Tacos"]);
});

test("an edited workbook still opens in LibreOffice (spec §10.1 smoke check, xlsx)", async () => {
  put("lo.xlsx", "oo-rich.xlsx");
  await call("ws_sheets_write", { path: "S/lo.xlsx", range: "Recetas!A30", values: [["=SUM(B2:B4)"]] });
  // also exercise the structural edits: new tab part/rel/override, new numFmt-cloned xf, rename across sheet + chart
  assert.equal((await call("ws_sheets_batch_update", { path: "S/lo.xlsx", ops: [{ op: "add_tab", title: "Compras" }, { op: "write", range: "Compras!B2", values: [["007"]] }, { op: "set_number_format", range: "Compras!A1:A3", pattern: "0.0%" }, { op: "rename_tab", title: "Recetas", new_title: "Recetas 2026" }] })).success, true);
  const { sofficeOpens } = await import("./helpers/ooxml-assert.js");
  if (sofficeOpens(bytesOf("S/lo.xlsx"), "xlsx") === null) console.log("# soffice not installed: LibreOffice smoke check skipped");
});

test("write keeps cell styles, sets fullCalcOnLoad, drops calcChain, touches only the sheet/workbook parts", async () => {
  put("w.xlsx", "oo-rich.xlsx");
  const before = bytesOf("S/w.xlsx");
  const r = await call("ws_sheets_write", { path: "S/w.xlsx", range: "Recetas!B2:C2", values: [5, "13.75"] });
  assert.equal(r.data.updated_cells, 2); assert.ok(r.data.version_id);
  const after = bytesOf("S/w.xlsx");
  assertOnlyPartsChanged(before, after, [/^xl\/worksheets\/sheet\d+\.xml$/, "xl/workbook.xml", "xl/calcChain.xml", "[Content_Types].xml", "xl/_rels/workbook.xml.rels"]);
  assert.match(partText(after, "xl/workbook.xml"), /fullCalcOnLoad="1"/);
  assert.ok(!OoxmlPackage.open(after).has("xl/calcChain.xml"));
  const sheetBefore = partText(before, "xl/worksheets/sheet1.xml").match(/<c r="C2"[^>]*s="(\d+)"/)[1];
  assert.match(partText(after, "xl/worksheets/sheet1.xml"), new RegExp(`<c r="C2"[^>]*s="${sheetBefore}"`));
  assert.equal((await call("ws_sheets_read", { path: "S/w.xlsx", range: "Recetas!C2" })).data.values[0][0], "13.75");
});

test("write beyond used range keeps row order and grows <dimension> (Review Focus 5)", async () => {
  put("b.xlsx", "rich.xlsx");
  await call("ws_sheets_write", { path: "S/b.xlsx", range: "Recetas!A10", values: [["Flan", 6]] });
  const xml = partText(bytesOf("S/b.xlsx"), "xl/worksheets/sheet1.xml");
  const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b));
  assert.match(xml, /<dimension ref="A1:E10"\/>/);
});

test("refuses merged non-anchor; refuses partial shared-formula overwrite (Review Focus 5)", async () => {
  put("m.xlsx", "rich.xlsx");
  const m = await call("ws_sheets_write", { path: "S/m.xlsx", range: "Recetas!B6", values: [["x"]] });
  assert.equal(m.code, "merged_cell"); assert.match(m.error, /A6/);
  assert.equal((await call("ws_sheets_write", { path: "S/m.xlsx", range: "Recetas!A6", values: [["ok"]] })).success, true);
  const pkg = OoxmlPackage.open(bytesOf("S/m.xlsx"));
  const x = pkg.text("xl/worksheets/sheet1.xml").replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (m, r, a, inner) => {
    if (r === "2") return `<row r="2"${a}>${inner}<c r="F2"><f t="shared" ref="F2:F4" si="0">B2+1</f></c></row>`;
    if (r === "3" || r === "4") return `<row r="${r}"${a}>${inner}<c r="F${r}"><f t="shared" si="0"/></c></row>`;
    return m;
  });
  const { strToU8 } = await import("fflate"); pkg.setBytes("xl/worksheets/sheet1.xml", strToU8(x));
  fake.addFile("S/sf.xlsx", Buffer.from(pkg.save()));
  const part = await call("ws_sheets_write", { path: "S/sf.xlsx", range: "Recetas!F3", values: [["1"]] });
  assert.equal(part.code, "shared_formula"); assert.match(part.error, /F2:F4/);
  assert.equal((await call("ws_sheets_read", { path: "S/sf.xlsx", range: "Recetas!F3", value_render_option: "FORMULA" })).data.values[0][0], "=B3+1");
  assert.equal((await call("ws_sheets_write", { path: "S/sf.xlsx", range: "Recetas!F2:F4", values: [[1], [2], [3]] })).success, true);
});

test("USER_ENTERED vs RAW; text-formatted cells keep leading zeros", async () => {
  put("u.xlsx", "rich.xlsx");
  await call("ws_sheets_set_number_format", { path: "S/u.xlsx", range: "Recetas!A20" });
  await call("ws_sheets_write", { path: "S/u.xlsx", range: "Recetas!A20:D20", values: [["007", "=B2*2", "TRUE", "3.5"]] });
  const r = await call("ws_sheets_read", { path: "S/u.xlsx", range: "Recetas!A20:D20", value_render_option: "FORMULA" });
  assert.deepEqual(r.data.values[0], ["007", "=B2*2", true, 3.5]);
  await call("ws_sheets_write", { path: "S/u.xlsx", range: "Recetas!A21:B21", values: [["=1+1", 4]], value_input_option: "RAW" });
  assert.deepEqual((await call("ws_sheets_read", { path: "S/u.xlsx", range: "Recetas!A21:B21", value_render_option: "UNFORMATTED_VALUE" })).data.values[0], ["=1+1", 4]);
});

test("append maps dicts by header row and refuses unknown keys", async () => {
  put("a.xlsx", "rich.xlsx");
  const r = await call("ws_sheets_append", { path: "S/a.xlsx", sheet_name: "Recetas", values: [{ Nombre: "Mole", Porciones: 8 }, { Nombre: "Sopa", Costo: 3 }] });
  assert.equal(r.data.range, "Recetas!A7:E8");
  const bad = await call("ws_sheets_append", { path: "S/a.xlsx", sheet_name: "Recetas", values: [{ Sabor: "x" }] });
  assert.equal(bad.code, "bad_args"); assert.match(bad.error, /Nombre/);
  assert.equal((await call("ws_sheets_append", { path: "S/a.xlsx", sheet_name: "Recetas", values: [] })).code, "bad_args");
});

test("tabs: add, rename rewrites formulas and chart refs, delete; get_tabs reports frozen panes", async () => {
  put("t.xlsx", "rich.xlsx");
  await call("ws_sheets_add_tab", { path: "S/t.xlsx", title: "Compras" });
  await call("ws_sheets_rename_tab", { path: "S/t.xlsx", title: "Recetas", new_title: "Recetas 2026" });
  const b = bytesOf("S/t.xlsx");
  assert.match(partText(b, "xl/worksheets/sheet2.xml"), /'Recetas 2026'!A2/);
  const chartPart = Object.keys((await import("fflate")).unzipSync(new Uint8Array(b))).find((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
  // fixture fact: rich.xlsx xl/charts/chart1.xml has <f>'Recetas'!C1</f> (series name, no $) and
  // <f>'Recetas'!$C$2:$C$4</f> (values); the brief's `'Recetas 2026'!$C$1` exists in neither, so both real refs are asserted.
  assert.match(partText(b, chartPart), /<f>'Recetas 2026'!C1<\/f>/);
  assert.match(partText(b, chartPart), /'Recetas 2026'!\$C\$2:\$C\$4/);
  const tabs = await call("ws_sheets_get_tabs", { path: "S/t.xlsx" });
  assert.deepEqual(tabs.data.tabs.map((t) => t.title), ["Recetas 2026", "Menú semanal", "Compras"]);
  assert.equal(tabs.data.tabs[0].frozen_rows, 1);
  assert.equal((await call("ws_sheets_delete_tab", { path: "S/t.xlsx", title: "Compras" })).success, true);
  assert.equal((await call("ws_sheets_add_tab", { path: "S/t.xlsx", title: "bad/name" })).code, "bad_args");
});

test("batch_update applies typed ops in one version; create with tabs; last tab cannot be deleted", async () => {
  put("bu.xlsx", "rich.xlsx");
  const p0 = puts();
  const r = await call("ws_sheets_batch_update", { path: "S/bu.xlsx", ops: [{ op: "add_tab", title: "X" }, { op: "write", range: "X!A1", values: [["hola"]] }, { op: "rename_tab", title: "X", new_title: "Y" }] });
  assert.equal(r.success, true); assert.equal(puts() - p0, 1);
  const c = await call("ws_sheets_create", { title: "Índice de recetas", folder: "S", tabs: ["Recetas"] });
  assert.equal(c.data.created, true);
  assert.equal((await call("ws_sheets_delete_tab", { path: c.data.path, title: "Recetas" })).code, "last_tab");
});

test("formatValue: dates, thousands, percent, General, text, booleans (spec §4.5 unit)", () => {
  assert.equal(formatValue(45567, "n", { code: "yyyy-mm-dd" }), "2024-10-02");
  assert.equal(formatValue(1234.5, "n", { code: "#,##0.00" }), "1,234.50");
  assert.equal(formatValue(0.25, "n", { code: "0%" }), "25%");
  assert.equal(formatValue("12.5", "n", { code: "0.00" }), "12.50");
  assert.equal(formatValue(-1234, "n", { code: "#,##0" }), "-1,234");
  assert.equal(formatValue(0.1 + 0.2, "n", { code: "General" }), "0.3");
  assert.equal(formatValue("007", "s", { code: "@" }), "007");
  assert.equal(formatValue("1", "b", { code: "General" }), "TRUE");
  assert.equal(formatValue(45567.5, "n", { code: "yyyy-mm-dd h:mm" }), "2024-10-02 12:00");
  assert.equal(formatValue(45567.75, "n", { code: "h:mm AM/PM" }), "6:00 PM");
  assert.equal(formatValue(45567, "n", { code: "d-mmm-yy" }), "2-Oct-24");
  assert.equal(formatValue("", "n", { code: "0.00" }), "");
  assert.equal(isDateCode("yyyy-mm-dd"), true);
  assert.equal(isDateCode('0.00" days"'), false);
  assert.equal(isDateCode("General"), false);
});

test("sheet read is capped at 50,000 cells per call (global constraint)", async () => {
  put("cap.xlsx", "rich.xlsx");
  const over = await call("ws_sheets_read", { path: "S/cap.xlsx", range: "Recetas!A1:Z2000" }); // 26 × 2000 = 52,000
  assert.equal(over.code, "too_large"); assert.match(over.error, /50000/);
  const at = await call("ws_sheets_read", { path: "S/cap.xlsx", range: "Recetas!A1:Y2000" }); // 25 × 2000 = 50,000
  assert.equal(at.success, true);
  assert.equal((await call("ws_sheets_write", { path: "S/cap.xlsx", range: "Recetas!A1", values: Array.from({ length: 2001 }, () => Array(25).fill(1)) })).code, "too_large");
});

test("oo-rich.xlsx (ONLYOFFICE, no <dimension>): write beyond used range inserts ordered rows and a schema-placed <dimension> (Review Focus 5)", async () => {
  put("ob.xlsx", "oo-rich.xlsx");
  assert.equal((await call("ws_sheets_write", { path: "S/ob.xlsx", range: "Recetas!A10", values: [["Flan", 6]] })).success, true);
  await call("ws_sheets_write", { path: "S/ob.xlsx", range: "Recetas!A8", values: [["Atole"]] });
  const xml = partText(bytesOf("S/ob.xlsx"), "xl/worksheets/sheet1.xml");
  const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [1, 2, 3, 4, 6, 8, 10]);
  assert.match(xml, /<\/sheetPr><dimension ref="A1:E10"\/><sheetViews>/); // CT_Worksheet order: sheetPr, dimension, sheetViews
  const r = await call("ws_sheets_read", { path: "S/ob.xlsx", range: "Recetas!A8:B10" });
  assert.deepEqual(r.data.values, [["Atole"], [], ["Flan", "6"]]);
});

test("oo-rich.xlsx: merged non-anchor refused with the anchor named; partial shared formula E2:E4 refused, whole group allowed (Review Focus 5)", async () => {
  put("om.xlsx", "oo-rich.xlsx");
  const m = await call("ws_sheets_write", { path: "S/om.xlsx", range: "Recetas!C6", values: [["x"]] });
  assert.equal(m.code, "merged_cell"); assert.match(m.error, /A6:C6/); assert.match(m.error, /top-left cell A6/);
  const p = await call("ws_sheets_write", { path: "S/om.xlsx", range: "Recetas!D3:E3", values: [["x", 1]] });
  assert.equal(p.code, "shared_formula"); assert.match(p.error, /E2:E4/);
  const f = await call("ws_sheets_read", { path: "S/om.xlsx", range: "Recetas!E2:E4", value_render_option: "FORMULA" });
  assert.deepEqual(f.data.values.map((x) => x[0]), ["=B2*C2", "=B3*C3", "=B4*C4"]);
  const w = await call("ws_sheets_write", { path: "S/om.xlsx", range: "Recetas!E2:E4", values: [["=B2+C2"], ["=B3+C3"], ["=B4+C4"]] });
  assert.equal(w.success, true);
  const after = await call("ws_sheets_read", { path: "S/om.xlsx", range: "Recetas!E2:E4" });
  assert.equal(after.data.stale_formulas, true); // written formulas carry no cached <v>
  assert.doesNotMatch(partText(bytesOf("S/om.xlsx"), "xl/worksheets/sheet1.xml"), /t="shared"/);
});

test("RAW: JSON numbers/booleans keep their type, strings are never parsed", async () => {
  put("raw.xlsx", "rich.xlsx");
  await call("ws_sheets_write", { path: "S/raw.xlsx", range: "Recetas!A22", values: [["12", "TRUE", "2026-10-02", 7, false]], value_input_option: "RAW" });
  const r = await call("ws_sheets_read", { path: "S/raw.xlsx", range: "Recetas!A22:E22", value_render_option: "UNFORMATTED_VALUE" });
  assert.deepEqual(r.data.values[0], ["12", "TRUE", "2026-10-02", 7, false]);
});

test("append: schema accepts an empty list so the handler answers bad_args in the envelope (F7)", async () => {
  put("ae.xlsx", "rich.xlsx");
  for (const values of [[], [[]], {}]) {
    const r = await call("ws_sheets_append", { path: "S/ae.xlsx", sheet_name: "Recetas", values });
    assert.equal(r.success, false); assert.equal(r.code, "bad_args", JSON.stringify(values));
  }
});

// ---- fix round 1 ----
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
async function withEdits(src, edits) {
  const { strToU8 } = await import("fflate");
  const pkg = OoxmlPackage.open(readFileSync(join(FIX, src)));
  for (const [part, fn] of Object.entries(edits)) pkg.setBytes(part, strToU8(fn(pkg.has(part) ? pkg.text(part) : "")));
  return Buffer.from(pkg.save());
}
const chartsheetEdits = {
  "xl/workbook.xml": (x) => x.replace("</sheets>", `<sheet xmlns:r="${RNS}" name="Gráfico" sheetId="9" r:id="rIdCS"/></sheets>`),
  "xl/_rels/workbook.xml.rels": (x) => x.replace("</Relationships>", `<Relationship Id="rIdCS" Type="${RNS}/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`),
  "xl/chartsheets/sheet1.xml": () => `<?xml version="1.0" encoding="UTF-8"?><chartsheet xmlns="${MAIN}"><sheetViews><sheetView workbookViewId="0"/></sheetViews></chartsheet>`,
};

test("a chart sheet tab: get_tabs reports kind chart, rename_tab still works and rewrites chart refs (I1)", async () => {
  fake.addFile("S/cs.xlsx", await withEdits("rich.xlsx", chartsheetEdits), { owner: "admin" });
  const tabs = await call("ws_sheets_get_tabs", { path: "S/cs.xlsx" });
  assert.equal(tabs.success, true);
  assert.deepEqual(tabs.data.tabs.map((t) => [t.title, t.kind]), [["Recetas", "sheet"], ["Menú semanal", "sheet"], ["Gráfico", "chart"]]);
  assert.deepEqual({ ...tabs.data.tabs[2], sheet_id: 0, index: 0 }, { sheet_id: 0, index: 0, title: "Gráfico", kind: "chart", rows: 0, cols: 0, frozen_rows: 0, frozen_cols: 0, hidden: false });
  assert.equal((await call("ws_sheets_rename_tab", { path: "S/cs.xlsx", title: "Recetas", new_title: "Recetas 2026" })).success, true);
  const b = bytesOf("S/cs.xlsx");
  assert.match(partText(b, "xl/charts/chart1.xml"), /'Recetas 2026'!\$C\$2:\$C\$4/);
  assert.match(partText(b, "xl/worksheets/sheet2.xml"), /'Recetas 2026'!A2/);
  assert.equal((await call("ws_sheets_rename_tab", { path: "S/cs.xlsx", title: "Gráfico", new_title: "Gráfico 2" })).success, true);
  assert.equal((await call("ws_sheets_read", { path: "S/cs.xlsx", range: "'Gráfico 2'!A1" })).code, "unsupported");
});

test("rename_tab rewrites data validations, conditional formats, x14 xm:f and hyperlink locations (I2)", async () => {
  const XMNS = "http://schemas.microsoft.com/office/excel/2006/main";
  const bytes = await withEdits("rich.xlsx", {
    "xl/worksheets/sheet1.xml": (x) => x.replace("</mergeCells>", `</mergeCells>`
      + `<conditionalFormatting sqref="B2:B4"><cfRule type="expression" priority="1"><formula>B2&gt;'Menú semanal'!$C$1</formula></cfRule></conditionalFormatting>`
      + `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A2:A4"><formula1>'Menú semanal'!$A$1:$A$3</formula1><formula2>"'Menú semanal'!kept"</formula2></dataValidation></dataValidations>`
      + `<hyperlinks><hyperlink ref="A1" location="'Menú semanal'!A1" display="Menú"/></hyperlinks>`)
      .replace("</worksheet>", `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations xmlns:xm="${XMNS}" count="1"><x14:dataValidation type="list"><x14:formula1><xm:f>'Menú semanal'!$B$1:$B$2</xm:f></x14:formula1><xm:sqref>C2:C4</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>`),
  });
  fake.addFile("S/dv.xlsx", bytes, { owner: "admin" });
  assert.equal((await call("ws_sheets_rename_tab", { path: "S/dv.xlsx", title: "Menú semanal", new_title: "Menú 2026" })).success, true);
  const x = partText(bytesOf("S/dv.xlsx"), "xl/worksheets/sheet1.xml");
  assert.match(x, /<formula1>'Menú 2026'!\$A\$1:\$A\$3<\/formula1>/);
  assert.match(x, /<formula2>"'Menú semanal'!kept"<\/formula2>/); // string literal untouched
  assert.match(x, /<formula>B2&gt;'Menú 2026'!\$C\$1<\/formula>/);
  assert.match(x, /<xm:f>'Menú 2026'!\$B\$1:\$B\$2<\/xm:f>/);
  assert.match(x, /location="'Menú 2026'!A1"/);
  assert.doesNotMatch(x, /'Menú semanal'!\$/);
});

test("new cells inherit the row style (customFormat) else the column style; overwriting drops cm/vm (controller ruling)", async () => {
  const bytes = await withEdits("oo-rich.xlsx", {
    "xl/worksheets/sheet1.xml": (x) => x
      .replace("<sheetData>", `<cols><col min="4" max="5" width="12" style="3" customWidth="1"/></cols><sheetData>`)
      .replace(`<row r="6">`, `<row r="5" s="2" customFormat="1"></row><row r="6">`)
      .replace(`<c r="B3"><v>6</v></c>`, `<c r="B3" cm="1" vm="2"><v>6</v></c>`),
  });
  fake.addFile("S/st.xlsx", bytes, { owner: "admin" });
  const w = await call("ws_sheets_write", { path: "S/st.xlsx", range: "Recetas!A5:E5", values: [["Mole", 8, 3, 4, 5]] });
  assert.equal(w.success, true);
  await call("ws_sheets_write", { path: "S/st.xlsx", range: "Recetas!D9", values: [[1234.5]] });
  await call("ws_sheets_write", { path: "S/st.xlsx", range: "Recetas!B3", values: [[7]] });
  await call("ws_sheets_append", { path: "S/st.xlsx", sheet_name: "Recetas", values: [["Sopa", 2, 1, 99]] });
  const x = partText(bytesOf("S/st.xlsx"), "xl/worksheets/sheet1.xml");
  for (const ref of ["A5", "B5", "D5", "E5"]) assert.match(x, new RegExp(`<c r="${ref}" s="2"`), `${ref} takes the row style`);
  assert.match(x, /<c r="D9" s="3"/); // column style (numFmt 4 "#,##0.00")
  assert.match(x, /<c r="D10" s="3"/); // appended row, column style
  assert.match(x, /<c r="A10"(?! s=)/); // no column/row style → no s
  assert.match(x, /<c r="B3"><v>7<\/v><\/c>/); // cm/vm dropped
  assert.equal((await call("ws_sheets_read", { path: "S/st.xlsx", range: "Recetas!D9" })).data.values[0][0], "1,234.50");
});

test("set_number_format: format_type picks a default pattern; an explicit pattern wins (G1)", async () => {
  put("nf.xlsx", "rich.xlsx");
  const p = await call("ws_sheets_set_number_format", { path: "S/nf.xlsx", range: "Recetas!C3", format_type: "PERCENT" });
  assert.equal(p.data.pattern, "0.00%");
  assert.equal((await call("ws_sheets_read", { path: "S/nf.xlsx", range: "Recetas!C3" })).data.values[0][0], "2000.00%");
  assert.match(partText(bytesOf("S/nf.xlsx"), "xl/styles.xml"), /<numFmt numFmtId="164" formatCode="0.00%"\/>/);
  const q = await call("ws_sheets_set_number_format", { path: "S/nf.xlsx", range: "Recetas!C4", format_type: "PERCENT", pattern: "0.0" });
  assert.equal(q.data.pattern, "0.0");
  assert.equal((await call("ws_sheets_read", { path: "S/nf.xlsx", range: "Recetas!C4" })).data.values[0][0], "15.3");
  const expect = { TEXT: "@", NUMBER: "#,##0.00", CURRENCY: '"$"#,##0.00', DATE: "yyyy-mm-dd", TIME: "h:mm:ss", DATE_TIME: "yyyy-mm-dd h:mm:ss", SCIENTIFIC: "0.00E+00" };
  for (const [format_type, pattern] of Object.entries(expect)) assert.equal((await call("ws_sheets_set_number_format", { path: "S/nf.xlsx", range: "Recetas!B4", format_type })).data.pattern, pattern);
  assert.equal((await call("ws_sheets_read", { path: "S/nf.xlsx", range: "Recetas!B4" })).data.values[0][0], "4.00E+00");
  const b = await call("ws_sheets_batch_update", { path: "S/nf.xlsx", ops: [{ op: "set_number_format", range: "Recetas!B2", format_type: "CURRENCY" }, { op: "set_number_format", range: "Recetas!B3", format_type: "BOGUS" }] });
  assert.equal(b.code, "bad_args"); assert.match(b.error, /CURRENCY/);
  assert.equal((await call("ws_sheets_batch_update", { path: "S/nf.xlsx", ops: [{ op: "set_number_format", range: "Recetas!B2", format_type: "CURRENCY" }] })).success, true);
  assert.equal((await call("ws_sheets_read", { path: "S/nf.xlsx", range: "Recetas!B2" })).data.values[0][0], "$4.00");
});
