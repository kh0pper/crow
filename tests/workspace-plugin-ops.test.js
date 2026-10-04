/**
 * Task 13 (K5): the Crow ONLYOFFICE plugin's live ops (bundles/workspace/onlyoffice-plugin/ops.js), run exactly as
 * callCommand runs them (data in Asc.scope.crow, Api as a global) against builder STUBS that expose, per class,
 * only the methods the S9 probe verified on the real ONLYOFFICE 9.4 (the per-class list comes from the probe that
 * produced S9 — scripts/workspace-w2-plugin-probe/probe.js — intersected with the S9 "API present" line).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { LIVE_OPS } from "../bundles/workspace/server/queue/conditions.js";
import { FORMAT_TYPE_PATTERNS } from "../bundles/workspace/server/ooxml/xlsx.js";

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, "..");
const OPS_PATH = join(ROOT, "bundles", "workspace", "onlyoffice-plugin", "ops.js");
const { crowCommand } = require(OPS_PATH);
const S9 = readFileSync(join(ROOT, "docs", "superpowers", "specs", "2026-10-03-workspace-w2-spike-results.md"), "utf8");
const PROBE = readFileSync(join(ROOT, "scripts", "workspace-w2-plugin-probe", "probe.js"), "utf8");

// ---- what S9 verified, per editor and class -------------------------------------------------------------------
const listOf = (label) => new Set(((S9.match(new RegExp(`^${label}: (.*)$`, "m")) || [, ""])[1]).split(/,\s*/).map((s) => s.trim()).filter(Boolean));
const PRESENT = listOf("API present"); const MISSING = listOf("API missing");
// T1/T13 ruling: entries may be bare ("GetRange") or Class.method; a bare name in "missing" is unverified in EVERY
// class that probed it (a flat list cannot say which class lacked it), so one class never masks another.
const isPresent = (cls, m) => PRESENT.has(`${cls}.${m}`) || (PRESENT.has(m) && !MISSING.has(m) && !MISSING.has(`${cls}.${m}`));
function verifiedByEditor() {
  const body = PROBE.slice(PROBE.indexOf("function presenceCommand"), PROBE.indexOf("function wordEditCommand"));
  const parts = body.split(/t === "(word|cell|slide)"/); const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    const ed = (out[parts[i]] = {});
    for (const m of parts[i + 1].matchAll(/has\("(\w+)",\s*[^,]+,\s*\[([^\]]*)\]\)/g)) {
      const names = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
      ed[m[1]] = new Set([...(ed[m[1]] || []), ...names.filter((n) => isPresent(m[1], n))]);
    }
  }
  return out;
}
const V = verifiedByEditor();

test("the per-class verified set is derived from S9 + the probe (sanity)", () => {
  assert.ok(PRESENT.has("SearchAndReplace") && MISSING.has("SetBold"));
  assert.ok(V.word.ApiDocument.has("SearchAndReplace") && V.word.ApiParagraph.has("InsertParagraph"));
  assert.equal(V.word.ApiRange.size, 0, "word ApiRange methods were all missing in S9");
  assert.ok(V.cell.ApiRange.has("SetValue") && V.cell.ApiWorksheet.has("SetName") && V.cell.Api.has("AddSheet"));
  assert.ok(!V.word.ApiParagraph.has("GetStyle"), "GetStyle was probed on ApiDocument only");
});

// ---- strict stubs ---------------------------------------------------------------------------------------------
function strict(editor, cls, raw, violations) {
  return new Proxy(raw, { get(t, k) {
    if (typeof k === "string" && /^[A-Z]/.test(k) && !V[editor][cls]?.has(k)) { violations.push(`${cls}.${k}`); throw new Error(`unverified ${cls}.${k}`); }
    return t[k];
  } });
}
const textCount = (hay, needle, mc = true) => { const h = mc ? hay : hay.toLowerCase(), n = mc ? needle : needle.toLowerCase(); return n ? h.split(n).length - 1 : 0; };

/** A word document: paragraphs [{text, style}], styles present by name. Records every mutating call. */
function wordStub(paras, { styles = ["Normal", "Heading 1", "Heading 2", "Heading 3"], throwOn = null } = {}) {
  const violations = [], calls = [];
  const S = (cls, raw) => strict("word", cls, raw, violations);
  const style = (n) => S("ApiStyle", { _name: n });
  const mkP = (text = "", st = "Normal") => {
    const raw = { _text: text, _style: st };
    const p = S("ApiParagraph", raw);
    raw.GetText = () => raw._text;
    raw.AddText = (t) => { calls.push(["AddText", t]); raw._text += t; return S("ApiRun", {}); };
    raw.SetStyle = (s) => { calls.push(["SetStyle", s._name]); raw._style = s._name; return true; };
    raw.InsertParagraph = (np, pos, ret) => { calls.push(["InsertParagraph", np._text, pos]); const i = model.paras.indexOf(p); model.paras.splice(pos === "after" ? i + 1 : i, 0, np); return ret ? np : true; };
    return p;
  };
  const model = { paras: paras.map((x) => mkP(x.text, x.style)) };
  const all = () => model.paras.map((p) => p._text).join("\n");
  const d = S("ApiDocument", {
    GetAllParagraphs: () => model.paras.slice(),
    GetAllHeadingParagraphs: () => model.paras.filter((p) => /^Heading/.test(p._style)),
    GetStyle: (n) => (styles.includes(n) ? style(n) : null),
    // one hit per OCCURRENCE (so expect_count logic is exercised)
    Search: (t, mc = true) => Array.from({ length: textCount(all(), String(t), mc) }, () => S("ApiRange", {})),
    SearchAndReplace: (o) => {
      calls.push(["SearchAndReplace", o]); if (throwOn === "SearchAndReplace") throw new Error("boom");
      for (const p of model.paras) p._text = o.matchCase === false ? p._text.replace(new RegExp(o.searchString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), o.replaceString) : p._text.split(o.searchString).join(o.replaceString);
    },
    Push: (p) => { calls.push(["Push", p._text]); if (throwOn === "Push" && calls.filter((c) => c[0] === "Push").length > 1) throw new Error("boom"); model.paras.push(p); return true; },
  });
  const Api = S("Api", { GetDocument: () => d, CreateParagraph: () => mkP("") });
  return { Api, calls, violations, texts: () => model.paras.map((p) => p._text), styles: () => model.paras.map((p) => p._style) };
}

/** A workbook: {tab: {A1: value}}; GetValue returns strings like the editor. */
function cellStub(tabs, { throwOnSet = 0 } = {}) {
  const violations = [], calls = []; let sets = 0;
  const S = (cls, raw) => strict("cell", cls, raw, violations);
  const model = Object.entries(tabs).map(([name, cells]) => ({ name, cells: { ...cells }, fmt: {} }));
  const cellsOf = (addr) => { const [a, b = a] = addr.split(":"); const p = (x) => { const m = /^([A-Z]+)(\d+)$/.exec(x); return [m[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0), Number(m[2])]; };
    const [c1, r1] = p(a), [c2, r2] = p(b); const out = []; const name = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(`${name(c)}${r}`); return out; };
  const ws = (sh) => S("ApiWorksheet", {
    GetRange: (addr) => S("ApiRange", {
      GetValue: () => { const v = sh.cells[addr]; return v === undefined || v === null ? "" : String(v); },
      SetValue: (v) => { sets += 1; if (throwOnSet && sets === throwOnSet) throw new Error("boom"); calls.push(["SetValue", sh.name, addr, v]); sh.cells[addr] = v; },
      SetNumberFormat: (f) => { calls.push(["SetNumberFormat", sh.name, addr, f]); for (const a of cellsOf(addr)) sh.fmt[a] = f; },
    }),
    SetName: (n) => { calls.push(["SetName", sh.name, n]); sh.name = n; },
  });
  const find = (n) => model.find((s) => s.name.toLowerCase() === String(n).toLowerCase());
  const Api = S("Api", {
    GetSheet: (n) => { const s = find(n); return s ? ws(s) : null; },
    AddSheet: (n) => { calls.push(["AddSheet", n]); const s = { name: n, cells: {}, fmt: {} }; model.push(s); },
  });
  return { Api, calls, violations, tab: (n) => find(n) };
}

/** Run the self-contained command as callCommand would: data in Asc.scope, Api as a global. */
function run(stub, tool, args, pre = null) {
  globalThis.Api = stub.Api; globalThis.Asc = { scope: { crow: JSON.parse(JSON.stringify({ tool, args, pre })) } };
  try { return crowCommand(); } finally { delete globalThis.Api; delete globalThis.Asc; }
}
/** T13 fix A: the plugin reports NO inverse (Crow derives the undo server-side from its own record). */
const noInverse = (r) => assert.ok(!("inverse" in r), "the plugin never reports an inverse");
const clean = (stub) => assert.deepEqual(stub.violations, [], "only S9-verified builder methods, per class");
const NOTHING = { ok: false, applied_nothing: true };

// ---- docs -----------------------------------------------------------------------------------------------------
test("find_replace: precondition first, then SearchAndReplace, no inverse reported", () => {
  const s = wordStub([{ text: "Tortillas" }]);
  const r = run(s, "ws_docs_find_replace", { pairs: [{ find: "Tortillas", replace: "Totopos" }] });
  assert.equal(r.ok, true); assert.deepEqual(s.calls[0], ["SearchAndReplace", { searchString: "Tortillas", replaceString: "Totopos", matchCase: true }]);
  assert.deepEqual(s.texts(), ["Totopos"]);
  noInverse(r);
   clean(s);
  const ci = wordStub([{ text: "tortillas" }]);
  const r2 = run(ci, "ws_docs_find_replace", { find: "Tortillas", replace: "Tacos", match_case: false });
  assert.equal(r2.ok, true); assert.equal(ci.calls[0][1].matchCase, false);
  const miss = wordStub([{ text: "nada" }]);
  assert.deepEqual(run(miss, "ws_docs_find_replace", { find: "Tortillas", replace: "x" }), { ...NOTHING, reason: "target_changed" });
  assert.deepEqual(miss.calls, [], "nothing changed");
  const two = wordStub([{ text: "a b" }]);
  assert.equal(run(two, "ws_docs_find_replace", { pairs: [{ find: "a", replace: "x" }, { find: "b", replace: "y" }] }).applied_nothing, true);
  assert.deepEqual(two.calls, []);
});

test("find_replace: find/replace typed decomposed (NFD) are searched NFC, like the file engine (M2)", () => {
  const s = wordStub([{ text: "jalape\u00f1o" }]);
  const r = run(s, "ws_docs_find_replace", { find: "jalapen\u0303o", replace: "pin\u0303a" });
  assert.equal(r.ok, true); assert.deepEqual(s.calls[0][1], { searchString: "jalape\u00f1o", replaceString: "pi\u00f1a", matchCase: true });
  assert.deepEqual(s.texts(), ["pi\u00f1a"]);
});

test("find_replace: a replacement that contains the find text is not a failed postcondition", () => {
  const s = wordStub([{ text: "un taco" }]);
  const r = run(s, "ws_docs_find_replace", { find: "taco", replace: "tacos" });
  assert.equal(r.ok, true); assert.deepEqual(s.texts(), ["un tacos"]);
});

test("append: every new paragraph gets its style explicitly (Normal; Heading N for #), soft wraps fold", () => {
  const s = wordStub([{ text: "Recetas", style: "Heading 1" }]);
  const r = run(s, "ws_docs_append", { markdown: "Uno\n\nDos" });
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls.filter((c) => c[0] === "SetStyle").map((c) => c[1]), ["Normal", "Normal"]);
  assert.deepEqual(s.texts(), ["Recetas", "Uno", "Dos"]); assert.deepEqual(s.styles(), ["Heading 1", "Normal", "Normal"]);
  noInverse(r);
   clean(s);
  const h = wordStub([]);
  assert.equal(run(h, "ws_docs_append", { markdown: "## Cena  \nlarga\n\nTacos al pastor\ncon piña" }).applied_nothing, true, "a hard break (two trailing spaces) is close-time only");
  const h2 = wordStub([]);
  assert.equal(run(h2, "ws_docs_append", { markdown: "## Cena ##\n\nTacos al pastor\ncon piña" }).ok, true);
  assert.deepEqual(h2.texts(), ["Cena", "Tacos al pastor con piña"]); assert.deepEqual(h2.styles(), ["Heading 2", "Normal"]);
  clean(h2);
});

test("append: markdown the editor cannot reproduce exactly (emphasis, lists, links, tables, code, missing heading style) → close-time, nothing touched", () => {
  for (const md of ["**negrita**", "- uno\n- dos", "1. uno", "[x](https://a.b)", "| a | b |", "    code", "> cita", "https://example.com", "a &amp; b", "Título\n===", "x\\", "#### Sin estilo"]) {
    const s = wordStub([]);
    assert.deepEqual(run(s, "ws_docs_append", { markdown: md }), { ...NOTHING, reason: "needs_close_apply" }, md);
    assert.deepEqual(s.calls.filter((c) => c[0] !== "AddText" && c[0] !== "SetStyle"), [], `${md}: the document is untouched`);
  }
});

test("insert_at_heading: after the (case-insensitive) heading, in order, Normal style; ambiguous/missing heading → close-time", () => {
  const s = wordStub([{ text: "Menú", style: "Heading 1" }, { text: "viejo" }, { text: "Otro", style: "Heading 1" }]);
  const r = run(s, "ws_docs_insert_at_heading", { heading: " menú ", markdown: "Lunes\n\nMartes" });
  assert.equal(r.ok, true);
  assert.deepEqual(s.texts(), ["Menú", "Lunes", "Martes", "viejo", "Otro"]); assert.deepEqual(s.styles(), ["Heading 1", "Normal", "Normal", "Normal", "Heading 1"]);
  noInverse(r);
   clean(s);
  assert.deepEqual(run(wordStub([{ text: "Otro", style: "Heading 1" }]), "ws_docs_insert_at_heading", { heading: "Menú", markdown: "x" }), { ...NOTHING, reason: "target_changed" });
  const dup = wordStub([{ text: "Menú", style: "Heading 1" }, { text: "Menú", style: "Heading 2" }]);
  assert.equal(run(dup, "ws_docs_insert_at_heading", { heading: "Menú", markdown: "x" }).applied_nothing, true); assert.deepEqual(dup.calls, []);
});

test("rewrite_passages: the whole paragraph is replaced in place (SearchAndReplace keeps the first run's formatting and the paragraph style)", () => {
  const s = wordStub([{ text: "Lunes: tacos", style: "Quote" }, { text: "Martes: sopa" }]);
  const r = run(s, "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Lunes", new_text: "Lunes: enchiladas" }] });
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls, [["SearchAndReplace", { searchString: "Lunes: tacos", replaceString: "Lunes: enchiladas", matchCase: true }]], "no RemoveAllElements/AddText: the run keeps its formatting");
  assert.deepEqual(s.texts(), ["Lunes: enchiladas", "Martes: sopa"]); assert.deepEqual(s.styles(), ["Quote", "Normal"]);
  noInverse(r);
   clean(s);
  // two paragraphs start with the prefix, or the paragraph text also occurs inside another one → close-time
  const amb = wordStub([{ text: "Lunes: tacos" }, { text: "Lunes: sopa" }]);
  assert.equal(run(amb, "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Lunes", new_text: "x" }] }).applied_nothing, true);
  const inner = wordStub([{ text: "Lunes" }, { text: "El Lunes es día de tacos" }]);
  assert.equal(run(inner, "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Lunes", new_text: "x" }] }).applied_nothing, true);
  assert.equal(run(wordStub([{ text: "Lunes" }]), "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Martes", new_text: "x" }] }).reason, "target_changed");
  assert.equal(run(wordStub([{ text: "Lunes" }]), "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Lunes", new_text: "a\nb" }] }).applied_nothing, true);
  assert.deepEqual(amb.calls, []); assert.deepEqual(inner.calls, []);
});

test("an exception before any change → applied_nothing; after a change → not (unknown_after_claim on the server)", () => {
  const before = wordStub([{ text: "Tortillas" }], { throwOn: "SearchAndReplace" });
  assert.deepEqual(run(before, "ws_docs_find_replace", { find: "Tortillas", replace: "x" }), { ok: false, applied_nothing: false, reason: "api_error" }, "SearchAndReplace may have changed text before throwing");
  const mid = wordStub([], { throwOn: "Push" });
  assert.deepEqual(run(mid, "ws_docs_append", { markdown: "a\n\nb" }), { ok: false, applied_nothing: false, reason: "api_error" });
  const early = { Api: { GetDocument: () => { throw new Error("no document"); } } };
  assert.deepEqual(run(early, "ws_docs_append", { markdown: "a" }), { ok: false, applied_nothing: true, reason: "api_error" });
});

// ---- sheets ---------------------------------------------------------------------------------------------------
test("sheets_write: precondition = the cells' queued values; integers/text/formulas as the editor would enter them", () => {
  const s = cellStub({ Menu: { B2: "tacos", C2: 3 } });
  const r = run(s, "ws_sheets_write", { range: "Menu!B2:C2", values: [["enchiladas", "12"]], value_input_option: "USER_ENTERED" }, { cells: [["tacos", 3]] });
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls, [["SetValue", "Menu", "B2", "enchiladas"], ["SetValue", "Menu", "C2", "12"]]);
  noInverse(r);
   clean(s);
  const flat = cellStub({ "Mi tab": {} });
  assert.equal(run(flat, "ws_sheets_write", { range: "'Mi tab'!A1", values: ["=SUM(B1:B2)", 5] }, { cells: [] }).ok, true);
  assert.deepEqual(flat.calls.map((c) => c.slice(2)), [["A1", "=SUM(B1:B2)"], ["B1", 5]]);
  const changed = cellStub({ Menu: { B2: "sopa" } });
  assert.deepEqual(run(changed, "ws_sheets_write", { range: "Menu!B2", values: [["x"]] }, { cells: [["tacos"]] }), { ...NOTHING, reason: "target_changed" });
  for (const [values, pre, why] of [[[["x"]], { cells: [["=A1"]] }, "formula target"], [[["1.5"]], { cells: [] }, "locale-dependent decimal"], [[["2026-11-01"]], { cells: [] }, "date"], [[[true]], { cells: [] }, "boolean"], [[["TRUE"]], { cells: [] }, "boolean text"], [[["'007"]], { cells: [] }, "quote prefix"], [[[{ a: 1 }]], { cells: [] }, "object"]]) {
    const st = cellStub({ Menu: {} });
    assert.equal(run(st, "ws_sheets_write", { range: "Menu!A1", values }, pre).applied_nothing, true, why); assert.deepEqual(st.calls, [], why);
  }
  for (const range of ["A1", "Menu!A:A", "Menu", "Nope!A1"]) assert.equal(run(cellStub({ Menu: {} }), "ws_sheets_write", { range, values: [["x"]] }, { cells: [] }).applied_nothing, true, range);
  const raw = cellStub({ Menu: {} });
  assert.equal(run(raw, "ws_sheets_write", { range: "Menu!A1", values: [["007"]], value_input_option: "RAW" }, { cells: [] }).applied_nothing, true, "RAW text cannot be forced in the editor");
  assert.equal(run(cellStub({ Menu: {} }), "ws_sheets_write", { range: "Menu!A1", values: [[7]], value_input_option: "RAW" }, { cells: [] }).ok, true, "RAW numbers are fine");
});

test("sheets_append: header precondition, rows after the queued last row (which must still be the last), dicts keyed by header", () => {
  const s = cellStub({ Menu: { A1: "Día", B1: "Plato", A2: "Lunes", B2: "Tacos" } });
  const pre = { header: ["Día", "Plato"], last_row: 2 };
  const r = run(s, "ws_sheets_append", { sheet_name: "Menu", values: [{ Plato: "Sopa", "Día": "Martes" }] }, pre);
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls, [["SetValue", "Menu", "A3", "Martes"], ["SetValue", "Menu", "B3", "Sopa"]]);
  noInverse(r);
   clean(s);
  const rows = cellStub({ Menu: { A1: "Día", B1: "Plato", A2: "Lunes" } });
  assert.equal(run(rows, "ws_sheets_append", { sheet_name: "Menu", values: [["Mar", ""], ["Mié", 4]] }, pre).ok, true);
  assert.deepEqual(rows.calls.map((c) => c.slice(2)), [["A3", "Mar"], ["A4", "Mié"], ["B4", 4]], "empty cells are left empty");
  const cases = [
    [{ Menu: { A1: "Day", B1: "Plato", A2: "x" } }, "header changed"],
    [{ Menu: { A1: "Día", B1: "Plato", A2: "x", A3: "typed in the editor" } }, "a row was added after it was queued"],
    [{ Menu: { A1: "Día", B1: "Plato" } }, "the queued last row was emptied"],
  ];
  for (const [tabs, why] of cases) { const st = cellStub(tabs); assert.equal(run(st, "ws_sheets_append", { sheet_name: "Menu", values: [["a", "b"]] }, pre).applied_nothing, true, why); assert.deepEqual(st.calls, [], why); }
  assert.equal(run(cellStub({ Menu: { A1: "Día", B1: "Plato", A2: "x" } }), "ws_sheets_append", { sheet_name: "Menu", values: [{ Precio: 3 }] }, pre).applied_nothing, true, "unknown column");
  assert.equal(run(cellStub({ Menu: { A1: "Día", A2: "x" } }), "ws_sheets_append", { sheet_name: "Menu", values: [["a"]] }, { header: ["Día"] }).applied_nothing, true, "no queued last row");
  const mid = cellStub({ Menu: { A1: "Día", B1: "Plato", A2: "x" } }, { throwOnSet: 2 });
  assert.deepEqual(run(mid, "ws_sheets_append", { sheet_name: "Menu", values: [["a", "b"]] }, pre), { ok: false, applied_nothing: false, reason: "api_error" });
});

test("sheets_set_number_format: the format_type patterns match the file engine", () => {
  for (const [type, pattern] of Object.entries(FORMAT_TYPE_PATTERNS)) {
    const s = cellStub({ Menu: {} });
    const r = run(s, "ws_sheets_set_number_format", { range: "Menu!A2:B3", format_type: type }, { s_attrs: [["0", null], ["3", "3"]] });
    assert.equal(r.ok, true, type);
    assert.deepEqual(s.calls, [["SetNumberFormat", "Menu", "A2:B3", pattern]], type);
    noInverse(r);
     clean(s);
  }
  const p = cellStub({ Menu: {} });
  assert.equal(run(p, "ws_sheets_set_number_format", { range: "Menu!C1", pattern: "0.0" }, null).ok, true);
  assert.deepEqual(p.calls, [["SetNumberFormat", "Menu", "C1", "0.0"]]);
  assert.equal(run(cellStub({ Menu: {} }), "ws_sheets_set_number_format", { range: "Menu!A:A" }, null).applied_nothing, true);
  assert.equal(run(cellStub({ Menu: {} }), "ws_sheets_set_number_format", { range: "Menu!A1", format_type: "BOGUS" }, null).applied_nothing, true);
});

test("sheets_rename_tab: tab-existence preconditions, postcondition; add_tab is close-time only (it would switch the person's tab)", () => {
  assert.equal(LIVE_OPS.has("ws_sheets_add_tab"), false);
  assert.deepEqual(run(cellStub({ Menu: {} }), "ws_sheets_add_tab", { title: "Compras" }), { ...NOTHING, reason: "unsupported" });
  const rn = cellStub({ Menu: {} });
  const r2 = run(rn, "ws_sheets_rename_tab", { title: "Menu", new_title: "Menú" });
  assert.equal(r2.ok, true); assert.ok(rn.tab("Menú"));
  noInverse(r2);  clean(rn);
  assert.equal(run(cellStub({ Otra: {} }), "ws_sheets_rename_tab", { title: "Menu", new_title: "X" }).reason, "target_changed");
  assert.equal(run(cellStub({ Menu: {}, X: {} }), "ws_sheets_rename_tab", { title: "Menu", new_title: "x" }).reason, "target_changed");
  assert.equal(run(cellStub({ Menu: {} }), "ws_sheets_rename_tab", { title: "Menu", new_title: "MENU" }).ok, true, "a case-only rename");
});

// ---- the command as a whole -----------------------------------------------------------------------------------
test("every LIVE_OPS tool has an op; an unknown tool is refused; slides are close-time only (no verified text access)", () => {
  for (const tool of LIVE_OPS) {
    const st = tool.startsWith("ws_sheets") ? cellStub({ Menu: {} }) : wordStub([]);
    assert.notEqual(run(st, tool, {}, null).reason, "unsupported", tool);
  }
  assert.deepEqual(run(wordStub([]), "ws_docs_format_text", { find: "a", bold: true }), { ...NOTHING, reason: "unsupported" });
  assert.equal(run(wordStub([]), "toString", {}).reason, "unsupported");
  assert.ok(!LIVE_OPS.has("ws_slides_edit_text") && !LIVE_OPS.has("ws_slides_find_replace"));
});

test("crowCommand is self-contained: ES5, no new Function/eval/async/generators, no free identifiers besides Api, Asc and a few builtins", () => {
  const src = crowCommand.toString();
  assert.doesNotMatch(src, /new Function|\beval\(|\basync\b|function\s*\*|=>/);
  const ast = acorn.parse(`(${src})`, { ecmaVersion: 5 }); // ES5: no arrows, let/const, templates, classes
  const declared = new Set(); const used = new Set();
  walk.full(ast, (node, st, type) => {
    if (type === "VariablePattern") declared.add(node.name);
    else if (node.type === "Identifier" && type !== "VariablePattern") used.add(node.name);
  });
  walk.simple(ast, { CatchClause: (n) => declared.add(n.param.name) });
  const free = [...used].filter((n) => !declared.has(n) && !["Api", "Asc", "String", "Number", "undefined"].includes(n));
  assert.deepEqual(free, [], "only Api/Asc.scope and its own locals");
  assert.ok(used.has("Api") && used.has("Asc"));
  const tail = readFileSync(OPS_PATH, "utf8");
  assert.match(tail, /if \(typeof module !== "undefined"[^\n]*module\.exports = \{ crowCommand/);
});

test("ops.js only calls builder methods the S9 probe found", () => {
  const src = readFileSync(OPS_PATH, "utf8");
  const presentBare = new Set([...PRESENT].map((m) => m.split(".").pop()).filter((m) => !MISSING.has(m)));
  const used = new Set([...src.matchAll(/\.(Get[A-Z]\w+|Set[A-Z]\w+|Search\w*|Create\w+|Push|Add\w+|Insert\w+|Remove\w+)\(/g)].map((x) => x[1]));
  assert.ok(used.size > 5);
  for (const m of used) assert.ok(presentBare.has(m), `ops.js uses ${m}, which S9 did not verify`);
});

test("final I1: rewrite_passages expect_text — the full paragraph text must equal it, else close-time (needs_close_apply), nothing touched", () => {
  const s = wordStub([{ text: "Lunes: tacos y sopa" }, { text: "Martes: sopa" }]);
  const r = run(s, "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Lunes", new_text: "Lunes: enchiladas", expect_text: "Lunes: tacos" }] });
  assert.equal(r.ok, false); assert.equal(r.applied_nothing, true); assert.equal(r.reason, "needs_close_apply");
  assert.deepEqual(s.calls, []);
  const ok = wordStub([{ text: "Lunes: tacos" }]);
  assert.equal(run(ok, "ws_docs_rewrite_passages", { passages: [{ match_prefix: "Lunes", new_text: "Lunes: enchiladas", expect_text: "Lunes: tacos" }] }).ok, true);
  assert.deepEqual(ok.texts(), ["Lunes: enchiladas"]);
});
