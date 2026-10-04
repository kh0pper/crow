/*
 * Crow live edits (K5, spec §5.7): the ops the plugin applies inside the open editor.
 *
 * ONE self-contained function. ONLYOFFICE 9.4 serialises it for Asc.plugin.callCommand and runs it through
 * AscCommon.safePluginEval, so it may use ONLY the global Api, the data in Asc.scope.crow ({tool, args, pre}) and
 * its own locals: no closures over plugin scope, no new Function/eval, no async, no generators, ES5 syntax.
 * The op table, the helpers and the dispatch are all written inside it. The server never sends code: ops arrive
 * as data and run through this fixed table.
 *
 * Builder methods: only those the S9 probe verified on the real 9.4 editor, per class
 * (tests/workspace-plugin-ops.test.js enforces it). Each op mirrors its file-level op and, in order:
 *   1. checks its precondition on the live document (anchor exists, snapshot equal) — failing → applied_nothing;
 *   2. applies the change;
 *   3. checks its postcondition in the same command, and returns its exact inverse (or null → undo via versions).
 * Anything the editor cannot reproduce exactly as the file engine would returns applied_nothing
 * ("needs_close_apply") BEFORE touching the document, so the change is applied when the file is closed.
 * Returns {ok, applied_nothing?, reason?, inverse?}.
 */
function crowCommand() {
  var job = (Asc.scope && Asc.scope.crow) || {};
  var tool = String(job.tool || ""), a = job.args || {}, pre = job.pre || null, touched = false;
  var TOOLS = ["ws_docs_find_replace", "ws_docs_append", "ws_docs_insert_at_heading", "ws_docs_rewrite_passages",
    "ws_sheets_write", "ws_sheets_append", "ws_sheets_set_number_format", "ws_sheets_add_tab", "ws_sheets_rename_tab"];
  // = FORMAT_TYPE_PATTERNS in server/ooxml/xlsx.js (the test pins them equal)
  var FORMATS = { TEXT: "@", NUMBER: "#,##0.00", PERCENT: "0.00%", CURRENCY: "\"$\"#,##0.00", DATE: "yyyy-mm-dd", TIME: "h:mm:ss", DATE_TIME: "yyyy-mm-dd h:mm:ss", SCIENTIFIC: "0.00E+00" };

  function no(reason) { return { ok: false, applied_nothing: true, reason: reason || "target_changed" }; }
  function broke(reason) { return { ok: false, applied_nothing: false, reason: reason }; }
  function done(inverse) { return { ok: true, inverse: inverse || null }; }
  function str(s) { return s === null || s === undefined ? "" : String(s); }
  function nfc(s) { return str(s).normalize("NFC"); }
  function trim(s) { return str(s).replace(/^\s+|\s+$/g, ""); }
  // JSON data from Asc.scope: a list is an object with a numeric length and splice (no free identifier `Array`)
  function isList(x) { return !!x && typeof x === "object" && typeof x.length === "number" && typeof x.splice === "function"; }

  // ---- docs ----------------------------------------------------------------------------------------------------
  function hits(d, s, mc) { var r = d.Search(s, mc); return r ? r.length : 0; }
  function paraTexts(d) { var ps = d.GetAllParagraphs() || [], out = [], i; for (i = 0; i < ps.length; i++) out.push(nfc(ps[i].GetText())); return out; }
  function countParas(d, t) { var all = paraTexts(d), n = 0, i; for (i = 0; i < all.length; i++) if (trim(all[i]) === t) n++; return n; }
  // The markdown subset md-to-wml turns into plain paragraphs (soft wraps fold to one space) and ATX headings.
  // Emphasis, lists, links/autolinks, tables, code, quotes, entities, hard breaks, setext headings → null.
  function blocks(md) {
    var lines = str(md).replace(/\r\n?/g, "\n").split("\n"), out = [], cur = null, i, raw, line, h, t;
    for (i = 0; i < lines.length; i++) {
      raw = lines[i]; line = trim(raw);
      if (!line) { cur = null; continue; }
      if (!cur && /^( {4}|\t)/.test(raw)) return null;
      if (/[*_`\[\]<>|\\~\t]|&[#A-Za-z0-9]+;|https?:\/\/|www\.|mailto:|\S@\S/i.test(line) || / {2,}$/.test(raw)) return null;
      if (/^([-+]|\d+[.)])(\s|$)/.test(line) || /^(=+|-+)$/.test(line)) return null;
      h = /^(#{1,6})(?:\s+(.*))?$/.exec(line);
      if (h) { t = trim(str(h[2]).replace(/(^|\s+)#+$/, "")); if (!t) return null; out.push({ text: nfc(t), level: h[1].length }); cur = null; continue; }
      if (cur) cur.text += " " + nfc(line); else { cur = { text: nfc(line), level: 0 }; out.push(cur); }
    }
    return out.length ? out : null;
  }
  // Every new paragraph gets its style explicitly (D7 heading reset: never inherited from the neighbour).
  function specsFor(d, md) {
    var bl = blocks(md), normal, out = [], i, st;
    if (!bl) return null;
    normal = d.GetStyle("Normal"); if (!normal) return null;
    for (i = 0; i < bl.length; i++) {
      st = bl[i].level ? d.GetStyle("Heading " + bl[i].level) : normal;
      if (!st) return null;
      out.push({ text: bl[i].text, style: st });
    }
    return out;
  }
  function build(spec) { var p = Api.CreateParagraph(); p.AddText(spec.text); p.SetStyle(spec.style); return p; }
  function textsOf(specs) { var out = [], i; for (i = 0; i < specs.length; i++) out.push(specs[i].text); return out; }
  function sameFirst(specs) { var n = 0, i; for (i = 0; i < specs.length; i++) if (specs[i].text === specs[0].text) n++; return n; }

  // ---- sheets --------------------------------------------------------------------------------------------------
  function colNum(s) { var n = 0, i; for (i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
  function colName(n) { var s = "", m; while (n > 0) { m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; }
  // "Tab!B2", "'My tab'!B2:C9" → {sheet, part, c1, r1, c2, r2}; no tab, whole rows/columns or names → null
  function rng(s) {
    var t = trim(s), m = /^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/.exec(t), r;
    if (!m) return null;
    r = { sheet: m[1] ? m[1].replace(/''/g, "'") : m[2], part: t.slice(0, t.lastIndexOf("!")), c1: colNum(m[3].toUpperCase()), r1: Number(m[4]) };
    r.c2 = m[5] ? colNum(m[5].toUpperCase()) : r.c1; r.r2 = m[6] ? Number(m[6]) : r.r1;
    return r.r1 >= 1 && r.c1 >= 1 && r.c2 >= r.c1 && r.r2 >= r.r1 && r.c2 <= 16384 && r.r2 <= 1048576 ? r : null;
  }
  function addr(c, r) { return colName(c) + r; }
  function valueAt(ws, c, r) { return str(ws.GetRange(addr(c, r)).GetValue()); }
  // A value the editor stores exactly as the file engine's input mode would, or undefined (→ close-time apply).
  // Integers and text are locale-independent; decimals, dates, booleans and quote-prefixed text are not.
  function cellIn(v, raw) {
    var s, t;
    if (typeof v === "number") return v === v && v !== 1 / 0 && v !== -1 / 0 ? v : undefined;
    if (v === null || v === "") return "";
    if (typeof v !== "string" || v.length > 32767) return undefined;
    s = nfc(v); t = trim(s);
    if (s !== t) return undefined;
    if (raw) return undefined; // RAW keeps strings as text: the editor would parse them
    if (/^=./.test(t)) return t;
    if (/^[-+]?\d{1,15}$/.test(t)) return t;
    if (/^'/.test(t) || /^(true|false)$/i.test(t) || /^[\s\d.,%$€£+\-:\/()eE]+$/.test(t)) return undefined;
    return t;
  }
  // Does the cell (as the editor reads it) still hold what the file held when the change was queued?
  function samePre(got, want) {
    if (want === null || want === undefined || want === "") return got === "";
    if (typeof want === "number") return got !== "" && Number(got) === want;
    if (typeof want !== "string" || /^=/.test(want)) return false; // booleans, formulas: the editor shows results
    return nfc(got) === nfc(want);
  }
  function landed(got, v) {
    if (typeof v === "number") return Number(got) === v;
    if (/^=/.test(v)) return true; // a formula reads back as its result
    if (/^[-+]?\d+$/.test(v)) return got === v || Number(got) === Number(v);
    return nfc(got) === v;
  }
  function rowsOf(vals) {
    if (!vals || typeof vals !== "object") return null;
    if (!isList(vals)) return [vals];
    if (!vals.length) return null;
    var i, rows = 0;
    for (i = 0; i < vals.length; i++) if (isList(vals[i])) rows++;
    return rows === vals.length ? vals : rows === 0 ? [vals] : null;
  }
  function tabNameOk(n) { return typeof n === "string" && n.length >= 1 && n.length <= 31 && !/[\[\]:*?\/\\]/.test(n) && !/^'|'$/.test(n); }
  function writeCells(ws, r1, c1, rows, skipEmpty) {
    var i, j, v;
    touched = true;
    for (i = 0; i < rows.length; i++) for (j = 0; j < rows[i].length; j++) { v = rows[i][j]; if (v !== "" || !skipEmpty) ws.GetRange(addr(c1 + j, r1 + i)).SetValue(v); }
    for (i = 0; i < rows.length; i++) for (j = 0; j < rows[i].length; j++) { v = rows[i][j]; if (v === "" ? valueAt(ws, c1 + j, r1 + i) !== "" : !landed(valueAt(ws, c1 + j, r1 + i), v)) return false; }
    return true;
  }
  function encode(vals, raw) {
    var rows = rowsOf(vals), out = [], i, j, row, v;
    if (!rows) return null;
    for (i = 0; i < rows.length; i++) {
      row = [];
      for (j = 0; j < rows[i].length; j++) { v = cellIn(rows[i][j], raw); if (v === undefined) return null; row.push(v); }
      out.push(row);
    }
    return out;
  }

  var L = {
    ws_docs_find_replace: function () {
      var pairs = a.pairs || (a.find !== undefined ? [{ find: a.find, replace: a.replace, match_case: a.match_case }] : []);
      if (pairs.length !== 1) return no("needs_close_apply");
      var f = str(pairs[0].find), r = str(pairs[0].replace), mc = pairs[0].match_case !== undefined ? pairs[0].match_case !== false : a.match_case !== false;
      if (!f || /[\t\r\n]/.test(f + r)) return no("needs_close_apply");
      var d = Api.GetDocument(), n = hits(d, f, mc);
      if (!n) return no("target_changed");
      var rBefore = r ? hits(d, r, mc) : 0, fold = function (s) { return mc ? s : s.toLowerCase(); }, nested = !!r && fold(r).indexOf(fold(f)) >= 0;
      touched = true;
      d.SearchAndReplace({ searchString: f, replaceString: r, matchCase: mc });
      if ((!nested && hits(d, f, mc) !== 0) || (r && hits(d, r, mc) < 1)) return broke("postcondition");
      // exact inverse only when the replacement did not exist before and the case is known (count-checked at undo)
      return done(mc && r && !rBefore && !nested && f.indexOf(r) < 0 ? [{ tool: "ws_docs_find_replace", args: { pairs: [{ find: r, replace: f }], expect_count: n } }] : null);
    },
    ws_docs_append: function () {
      var d = Api.GetDocument(), specs = specsFor(d, a.markdown), i;
      if (!specs) return no("needs_close_apply");
      var first = specs[0].text, before = countParas(d, first);
      touched = true;
      for (i = 0; i < specs.length; i++) d.Push(build(specs[i]));
      if (countParas(d, first) !== before + sameFirst(specs)) return broke("postcondition");
      return done(specs.length <= 500 ? [{ tool: "ws__docs_remove_paragraphs_exact", args: { texts: textsOf(specs), at_end: true } }] : null);
    },
    ws_docs_insert_at_heading: function () {
      var d = Api.GetDocument(), want = trim(nfc(a.heading)).toLowerCase(), hs = d.GetAllHeadingParagraphs() || [], at = null, n = 0, i, p, prev;
      if (!want) return no("target_changed");
      for (i = 0; i < hs.length; i++) if (trim(nfc(hs[i].GetText())).toLowerCase() === want) { n++; at = hs[i]; }
      if (!n) return no("target_changed");
      if (n > 1) return no("needs_close_apply"); // the file engine takes the first one; Crow does not guess in the editor
      var specs = specsFor(d, a.markdown);
      if (!specs) return no("needs_close_apply");
      var first = specs[0].text, before = countParas(d, first);
      touched = true; prev = at;
      for (i = 0; i < specs.length; i++) { p = build(specs[i]); prev = prev.InsertParagraph(p, "after", true) || p; }
      if (countParas(d, first) !== before + sameFirst(specs)) return broke("postcondition");
      return done(specs.length <= 500 ? [{ tool: "ws__docs_remove_paragraphs_exact", args: { texts: textsOf(specs), after_heading: str(a.heading) } }] : null);
    },
    // Each paragraph is rewritten as ONE SearchAndReplace of its whole text, which keeps the paragraph style and the
    // first run's formatting (what the file op does). The text must be unique in the document, so nothing else moves.
    ws_docs_rewrite_passages: function () {
      var ps = a.passages || [], d = Api.GetDocument(), all = d.GetAllParagraphs() || [], tx = paraTexts(d), plan = [], used = {}, inv = [], i, j, at, m, prefix, nt, full, ip;
      if (!ps.length) return no("target_changed");
      for (i = 0; i < ps.length; i++) {
        prefix = trim(nfc(ps[i].match_prefix)).slice(0, 100); nt = nfc(ps[i].new_text);
        if (!prefix) return no("target_changed");
        if (/[\t\r\n]/.test(nt)) return no("needs_close_apply");
        at = -1; m = 0;
        for (j = 0; j < tx.length; j++) if (!used[j] && tx[j].replace(/^\s+/, "").indexOf(prefix) === 0) { m++; if (at < 0) at = j; }
        if (!m) return no("target_changed");
        if (m > 1) return no("needs_close_apply");
        full = str(all[at].GetText());
        if (!full || /[\t\r\n]/.test(full) || hits(d, full, true) !== 1) return no("needs_close_apply");
        used[at] = true; plan.push({ full: full, nt: nt });
      }
      touched = true;
      for (i = 0; i < plan.length; i++) d.SearchAndReplace({ searchString: plan[i].full, replaceString: plan[i].nt, matchCase: true });
      tx = paraTexts(d);
      for (i = 0; i < plan.length; i++) {
        if (plan[i].nt ? hits(d, plan[i].nt, true) < 1 : hits(d, plan[i].full, true) !== 0) return broke("postcondition");
        ip = trim(plan[i].nt).slice(0, 100); m = 0;
        for (j = 0; j < tx.length; j++) if (ip && tx[j].replace(/^\s+/, "").indexOf(ip) === 0) m++;
        if (inv && m === 1) inv.push({ match_prefix: ip, new_text: plan[i].full }); else inv = null; // ambiguous undo → versions
      }
      return done(inv ? [{ tool: "ws_docs_rewrite_passages", args: { passages: inv } }] : null);
    },
    ws_sheets_write: function () {
      var R = rng(a.range), raw = a.value_input_option === "RAW", rows = encode(a.values, raw), ws, i, j, old = [], row, want;
      if (!R || !rows || !pre || !isList(pre.cells)) return no("needs_close_apply");
      ws = Api.GetSheet(R.sheet);
      if (!ws) return no("target_changed");
      for (i = 0; i < rows.length; i++) {
        row = [];
        for (j = 0; j < rows[i].length; j++) {
          want = pre.cells[i] && pre.cells[i][j] !== undefined ? pre.cells[i][j] : "";
          if (typeof want === "boolean" || (typeof want === "string" && /^=/.test(want))) return no("needs_close_apply");
          if (!samePre(valueAt(ws, R.c1 + j, R.r1 + i), want)) return no("target_changed");
          row.push(want === null ? "" : want);
        }
        old.push(row);
      }
      if (!writeCells(ws, R.r1, R.c1, rows)) return broke("postcondition");
      return done([{ tool: "ws_sheets_write", args: { range: R.part + "!" + addr(R.c1, R.r1), values: old, value_input_option: "RAW" } }]);
    },
    ws_sheets_append: function () {
      var vals = a.values, header = pre && isList(pre.header) ? pre.header : null, last = pre ? pre.last_row : null, ws, rows, width, i, j, k, any, src, keys;
      if (typeof last !== "number" || last < 0 || last % 1 !== 0 || !header) return no("needs_close_apply");
      if (vals && typeof vals === "object" && !isList(vals)) vals = [vals];
      if (isList(vals) && vals.length && vals[0] && typeof vals[0] === "object" && !isList(vals[0])) {
        src = [];
        for (i = 0; i < vals.length; i++) {
          if (!vals[i] || typeof vals[i] !== "object" || isList(vals[i])) return no("needs_close_apply");
          keys = {}; for (k in vals[i]) if (vals[i].hasOwnProperty(k)) keys[nfc(k)] = vals[i][k];
          for (k in keys) if (keys.hasOwnProperty(k)) { any = false; for (j = 0; j < header.length; j++) if (header[j] === k) any = true; if (!any) return no("needs_close_apply"); }
          src.push([]); for (j = 0; j < header.length; j++) src[i].push(keys.hasOwnProperty(header[j]) ? keys[header[j]] : "");
        }
        vals = src;
      }
      rows = encode(vals, a.value_input_option === "RAW");
      if (!rows) return no("needs_close_apply");
      ws = Api.GetSheet(str(a.sheet_name));
      if (!ws) return no("target_changed");
      for (j = 0; j < header.length; j++) if (nfc(valueAt(ws, j + 1, 1)) !== nfc(header[j])) return no("target_changed");
      width = header.length; for (i = 0; i < rows.length; i++) if (rows[i].length > width) width = rows[i].length;
      if (width < 1) width = 1;
      // the queued last row must still be the last: non-empty, and nothing typed below it since
      if (last >= 1) { any = false; for (j = 1; j <= width; j++) if (valueAt(ws, j, last) !== "") any = true; if (!any) return no("target_changed"); }
      for (i = last + 1; i <= last + rows.length + 20; i++) for (j = 1; j <= width; j++) if (valueAt(ws, j, i) !== "") return no("target_changed");
      if (!writeCells(ws, last + 1, 1, rows, true)) return broke("postcondition");
      var plain = true; for (i = 0; i < rows.length; i++) for (j = 0; j < rows[i].length; j++) if (typeof rows[i][j] === "string" && /^=/.test(rows[i][j])) plain = false;
      return done(plain && rows.length <= 10000 ? [{ tool: "ws__sheets_clear_rows_exact", args: { sheet: str(a.sheet_name), from_row: last + 1, values: rows.slice(0) } }] : null);
    },
    ws_sheets_set_number_format: function () {
      var R = rng(a.range), ft = str(a.format_type || "TEXT").toUpperCase(), pattern = a.pattern ? str(a.pattern) : FORMATS.hasOwnProperty(ft) ? FORMATS[ft] : "", ws, sa = pre && pre.s_attrs, fits, i;
      if (!R || !pattern) return no("needs_close_apply");
      ws = Api.GetSheet(R.sheet);
      if (!ws) return no("target_changed");
      touched = true;
      ws.GetRange(addr(R.c1, R.r1) + (R.c2 !== R.c1 || R.r2 !== R.r1 ? ":" + addr(R.c2, R.r2) : "")).SetNumberFormat(pattern);
      // no verified read-back of a number format: the saved file is checked at close (R-LIVE)
      fits = isList(sa) && sa.length === R.r2 - R.r1 + 1;
      for (i = 0; fits && i < sa.length; i++) fits = isList(sa[i]) && sa[i].length === R.c2 - R.c1 + 1;
      return done(fits ? [{ tool: "ws__sheets_restore_styles", args: { range: str(a.range), s_attrs: sa, pattern: pattern } }] : null);
    },
    ws_sheets_add_tab: function () {
      var t = a.title;
      if (!tabNameOk(t) || (a.index !== undefined && a.index !== null)) return no("needs_close_apply");
      if (Api.GetSheet(t)) return no("target_changed");
      touched = true;
      Api.AddSheet(t);
      if (!Api.GetSheet(t)) return broke("postcondition");
      return done([{ tool: "ws_sheets_delete_tab", args: { title: t } }]);
    },
    ws_sheets_rename_tab: function () {
      var t = str(a.title), nt = a.new_title, ws;
      if (!t || !tabNameOk(nt)) return no("needs_close_apply");
      ws = Api.GetSheet(t);
      if (!ws) return no("target_changed");
      if (Api.GetSheet(nt) && nt.toLowerCase() !== t.toLowerCase()) return no("target_changed");
      touched = true;
      ws.SetName(nt);
      if (!Api.GetSheet(nt)) return broke("postcondition");
      return done([{ tool: "ws_sheets_rename_tab", args: { title: nt, new_title: t } }]);
    },
  };

  var known = false, i;
  for (i = 0; i < TOOLS.length; i++) if (TOOLS[i] === tool) known = true;
  if (!known) return no("unsupported");
  try { return L[tool](); } catch (e) { return { ok: false, applied_nothing: !touched, reason: "api_error" }; }
}

if (typeof module !== "undefined" && module.exports) module.exports = { crowCommand: crowCommand };
