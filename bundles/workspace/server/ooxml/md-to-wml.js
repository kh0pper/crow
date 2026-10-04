/**
 * Markdown → WordprocessingML blocks. Guardrail (D7 "heading-style reset"): every paragraph is built
 * fresh — plain paragraphs get NO w:pStyle (Normal) and NO w:numPr — so inserted text can never inherit
 * a neighbouring heading's or list's properties. Soft wraps fold; two trailing spaces or "\" break.
 */
import { marked } from "marked";
import { WsError } from "../result.js";
import { NS, el, kids, kid, attr, parseXml } from "./xml.js";
import { makeRun } from "./docx-model.js";
import { addRel, REL, setOverride } from "./opc.js";

const W = NS.w;
// marked keeps entity references raw in its tokens; CommonMark decodes them in text
const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
export const safeUrl = (u) => { const s = String(u || "").trim(); if (!/^(https?:|mailto:)/i.test(s)) throw new WsError("bad_url", "links must start with http://, https:// or mailto:"); return s; };

function inline(tokens, f = {}) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === "strong") out.push(...inline(t.tokens, { ...f, b: true }));
    else if (t.type === "em") out.push(...inline(t.tokens, { ...f, i: true }));
    else if (t.type === "link") out.push(...inline(t.tokens, { ...f, link: safeUrl(t.href) }));
    else if (t.type === "br") out.push({ ...f, br: true });
    else if (t.type === "del") out.push(...inline(t.tokens, f));
    else if ((t.type === "text" || t.type === "escape") && t.tokens) out.push(...inline(t.tokens, f));
    else if (t.text !== undefined) out.push({ ...f, text: unesc(t.text).replace(/\n/g, " ") });
  }
  return out;
}

function headingStyle(d, level) {
  const id = d.styles.idByName(`heading ${level}`);
  if (id) return id;
  if (!d.styles.doc) throw new WsError("malformed_document", "this document has no styles part");
  const sd = d.styles.doc; const sid = `Heading${level}`;
  const sizes = { 1: 32, 2: 26, 3: 24, 4: 22, 5: 22, 6: 22 };
  const style = el(sd, W, "w:style", { "w:type": "paragraph", "w:styleId": sid }, [
    el(sd, W, "w:name", { "w:val": `heading ${level}` }), el(sd, W, "w:basedOn", { "w:val": "Normal" }), el(sd, W, "w:next", { "w:val": "Normal" }), el(sd, W, "w:qFormat"),
    el(sd, W, "w:pPr", {}, [el(sd, W, "w:keepNext"), el(sd, W, "w:outlineLvl", { "w:val": level - 1 })]),
    el(sd, W, "w:rPr", {}, [el(sd, W, "w:b"), el(sd, W, "w:sz", { "w:val": sizes[level] })]),
  ]);
  sd.documentElement.appendChild(style);
  d.pkg.markDirty(d.styles.part);
  d.styles.byId.set(sid, { name: `heading ${level}`, type: "paragraph", basedOn: "Normal", outline: level - 1, numId: null, ilvl: 0 });
  return sid;
}

function numberingDoc(d) {
  if (d.numbering.doc) return d.numbering.doc;
  const part = "word/numbering.xml";
  const doc = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="${W}"/>`, part);
  d.pkg.setXml(part, doc);
  addRel(d.pkg, d.part, REL.numbering, "numbering.xml");
  setOverride(d.pkg, part, "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml");
  d.numbering.doc = doc; d.numbering.part = part;
  return doc;
}

function listNumId(d, ordered) {
  const doc = numberingDoc(d); const root = doc.documentElement; const want = ordered ? "decimal" : "bullet";
  let abs = kids(root, W, "abstractNum").find((a) => { const l0 = kids(a, W, "lvl").find((l) => attr(l, W, "ilvl") === "0"); return l0 && attr(kid(l0, W, "numFmt"), W, "val") === want; });
  if (!abs) {
    const id = Math.max(-1, ...kids(root, W, "abstractNum").map((a) => Number(attr(a, W, "abstractNumId")))) + 1;
    abs = el(doc, W, "w:abstractNum", { "w:abstractNumId": id }, [0, 1, 2].map((i) => el(doc, W, "w:lvl", { "w:ilvl": i }, [
      el(doc, W, "w:start", { "w:val": 1 }), el(doc, W, "w:numFmt", { "w:val": want }), el(doc, W, "w:lvlText", { "w:val": ordered ? `%${i + 1}.` : ["•", "◦", "▪"][i] }), el(doc, W, "w:lvlJc", { "w:val": "left" }),
      el(doc, W, "w:pPr", {}, [el(doc, W, "w:ind", { "w:left": 720 * (i + 1), "w:hanging": 360 })]),
    ])));
    root.insertBefore(abs, kids(root, W, "num")[0] || null);
  }
  const absId = attr(abs, W, "abstractNumId");
  if (!ordered) { const ex = kids(root, W, "num").find((n) => attr(kid(n, W, "abstractNumId"), W, "val") === absId); if (ex) return attr(ex, W, "numId"); }
  // an ordered list always gets its own w:num restarting at 1
  const numId = Math.max(0, ...kids(root, W, "num").map((n) => Number(attr(n, W, "numId")))) + 1;
  const num = el(doc, W, "w:num", { "w:numId": numId }, [el(doc, W, "w:abstractNumId", { "w:val": absId }), ordered ? el(doc, W, "w:lvlOverride", { "w:ilvl": 0 }, [el(doc, W, "w:startOverride", { "w:val": 1 })]) : null]);
  // w:num elements precede w:numIdMacAtCleanup (schema order)
  root.insertBefore(num, kids(root, W, "numIdMacAtCleanup")[0] || null);
  d.pkg.markDirty(d.numbering.part);
  return String(numId);
}

function runsInto(d, p, specs) {
  const doc = d.doc; const linkStyle = d.styles.idByName("Hyperlink");
  let link = null, host = p;
  for (const s of specs) {
    if ((s.link || null) !== link) {
      link = s.link || null;
      if (link) { host = el(doc, W, "w:hyperlink", { "r:id": addRel(d.pkg, d.part, REL.hyperlink, link, true) }); p.appendChild(host); } else host = p;
    }
    if (s.br) { host.appendChild(el(doc, W, "w:r", {}, [el(doc, W, "w:br")])); continue; }
    if (!s.text) continue;
    const rPr = el(doc, W, "w:rPr", {}, [
      s.link && linkStyle ? el(doc, W, "w:rStyle", { "w:val": linkStyle }) : null,
      s.b ? el(doc, W, "w:b") : null, s.i ? el(doc, W, "w:i") : null,
      s.link && !linkStyle ? el(doc, W, "w:color", { "w:val": "1155CC" }) : null, s.link && !linkStyle ? el(doc, W, "w:u", { "w:val": "single" }) : null,
    ]);
    host.appendChild(makeRun(doc, s.text, rPr.childNodes.length ? rPr : null));
  }
}

/** A fresh paragraph: w:pPr only when the markdown asked for a heading style or a list (never inherited). */
function para(d, { style, numId, ilvl = 0 }, specs) {
  const doc = d.doc;
  const pPr = style || numId ? el(doc, W, "w:pPr", {}, [style ? el(doc, W, "w:pStyle", { "w:val": style }) : null, numId ? el(doc, W, "w:numPr", {}, [el(doc, W, "w:ilvl", { "w:val": ilvl }), el(doc, W, "w:numId", { "w:val": numId })]) : null]) : null;
  const p = el(doc, W, "w:p", {}, [pPr]);
  runsInto(d, p, specs);
  return p;
}

function table(d, t) {
  const doc = d.doc; const n = t.header.length; const tw = Math.floor(9000 / Math.max(1, n));
  const grid = d.styles.idByName("Table Grid");
  const border = (name) => el(doc, W, `w:${name}`, { "w:val": "single", "w:sz": 4, "w:space": 0, "w:color": "auto" });
  const tblPr = el(doc, W, "w:tblPr", {}, [grid ? el(doc, W, "w:tblStyle", { "w:val": grid }) : null, el(doc, W, "w:tblW", { "w:w": 0, "w:type": "auto" }), grid ? null : el(doc, W, "w:tblBorders", {}, ["top", "left", "bottom", "right", "insideH", "insideV"].map(border))]);
  const row = (cells, header) => el(doc, W, "w:tr", {}, cells.map((c) => el(doc, W, "w:tc", {}, [el(doc, W, "w:tcPr", {}, [el(doc, W, "w:tcW", { "w:w": tw, "w:type": "dxa" })]), para(d, {}, inline(c.tokens, header ? { b: true } : {}))])));
  return el(doc, W, "w:tbl", {}, [tblPr, el(doc, W, "w:tblGrid", {}, Array.from({ length: n }, () => el(doc, W, "w:gridCol", { "w:w": tw }))), row(t.header, true), ...t.rows.map((r) => row(r, false))]);
}

function blockInto(d, t, out, depth, listNum) {
  switch (t.type) {
    case "heading": out.push(para(d, { style: headingStyle(d, Math.min(t.depth, 6)) }, inline(t.tokens))); break;
    case "paragraph": out.push(para(d, {}, inline(t.tokens))); break;
    case "text": out.push(para(d, {}, inline(t.tokens || [{ type: "text", text: t.text }]))); break;
    case "list": {
      const numId = listNum?.ordered === t.ordered ? listNum.numId : listNumId(d, t.ordered);
      for (const item of t.items) {
        const [first, ...rest] = item.tokens;
        const lead = first && (first.type === "text" || first.type === "paragraph");
        out.push(para(d, { numId, ilvl: depth }, lead ? inline(first.tokens || [{ type: "text", text: first.text }]) : []));
        for (const sub of lead ? rest : item.tokens) blockInto(d, sub, out, sub.type === "list" ? Math.min(depth + 1, 2) : depth, { ordered: t.ordered, numId });
      }
      break;
    }
    case "table": out.push(table(d, t)); break;
    case "blockquote": for (const s of t.tokens) blockInto(d, s, out, depth, listNum); break;
    case "code": for (const line of t.text.split("\n")) out.push(para(d, {}, [{ text: line }])); break;
    default: break; // space, hr, html, def: no output
  }
}

export function markdownToBlocks(d, md) {
  const out = [];
  for (const t of marked.lexer(String(md ?? "").replace(/\r\n?/g, "\n"), { gfm: true })) blockInto(d, t, out, 0, null);
  return out;
}
