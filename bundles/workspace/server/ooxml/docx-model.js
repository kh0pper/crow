import { WsError } from "../result.js";
import { NS, kids, kid, all, attr, el } from "./xml.js";
import { OoxmlPackage } from "./zip.js";
import { mainPart, partsOfType, REL } from "./opc.js";

const W = NS.w;
export const RUN_CONTAINERS = new Set(["hyperlink", "ins", "smartTag", "sdt", "sdtContent", "fldSimple", "customXml", "moveTo"]);
export const SEP = new Set(["tab", "br", "cr", "drawing", "object", "pict", "fldChar", "instrText", "sym", "footnoteReference", "endnoteReference", "commentReference", "ptab"]);
export const RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"];

export const on = (pr, name) => { const e = kid(pr, W, name); if (!e) return false; const v = attr(e, W, "val"); return !["0", "false", "off", "none"].includes(v); };

/** Insert/replace/remove child `name` of `parent` keeping schema order. node=null removes. */
export function setOrdered(parent, order, name, node) {
  for (const c of kids(parent, W, name)) parent.removeChild(c);
  if (!node) return;
  const idx = order.indexOf(name);
  const after = kids(parent, W).find((c) => order.indexOf(c.localName) > idx);
  parent.insertBefore(node, after || null);
}

function loadStyles(pkg, part) {
  const sp = partsOfType(pkg, part, REL.styles)[0] || null;
  const byId = new Map();
  const doc = sp ? pkg.xml(sp) : null;
  if (doc) for (const s of kids(doc.documentElement, W, "style")) {
    const pPr = kid(s, W, "pPr"); const ol = kid(pPr, W, "outlineLvl"); const np = kid(pPr, W, "numPr");
    byId.set(attr(s, W, "styleId"), { name: attr(kid(s, W, "name"), W, "val"), type: attr(s, W, "type"), basedOn: attr(kid(s, W, "basedOn"), W, "val"), outline: ol ? Number(attr(ol, W, "val")) : null, numId: np ? attr(kid(np, W, "numId"), W, "val") : null, ilvl: np ? Number(attr(kid(np, W, "ilvl"), W, "val") || 0) : 0 });
  }
  const chain = (id, f, depth = 0) => { const s = byId.get(id); if (!s || depth > 12) return null; const v = f(s); return v !== null && v !== undefined ? v : s.basedOn ? chain(s.basedOn, f, depth + 1) : null; };
  return {
    part: sp, doc, byId,
    headingLevel: (id) => chain(id, (s) => { const m = /^heading ([1-9])$/i.exec(s.name); if (m) return Number(m[1]) <= 6 ? Number(m[1]) : 0; return s.outline !== null && s.outline <= 5 ? s.outline + 1 : null; }) || 0,
    numPr: (id) => chain(id, (s) => (s.numId ? { numId: s.numId, ilvl: s.ilvl } : null)),
    idByName: (name) => { for (const [id, s] of byId) if (s.name.toLowerCase() === name.toLowerCase()) return id; return null; },
  };
}

function loadNumbering(pkg, part) {
  const np = partsOfType(pkg, part, REL.numbering)[0] || null;
  const doc = np ? pkg.xml(np) : null;
  const fmt = (numId, ilvl) => {
    if (!doc) return "bullet";
    const num = kids(doc.documentElement, W, "num").find((n) => attr(n, W, "numId") === String(numId));
    const absId = num ? attr(kid(num, W, "abstractNumId"), W, "val") : null;
    const abs = kids(doc.documentElement, W, "abstractNum").find((a) => attr(a, W, "abstractNumId") === absId);
    const lvl = abs ? kids(abs, W, "lvl").find((l) => Number(attr(l, W, "ilvl")) === Number(ilvl)) : null;
    return lvl ? attr(kid(lvl, W, "numFmt"), W, "val") || "bullet" : "bullet";
  };
  return { part: np, doc, fmt };
}

export function openDocx(bytes) {
  const pkg = OoxmlPackage.open(bytes);
  const part = mainPart(pkg);
  const doc = pkg.xml(part);
  if (doc.documentElement.namespaceURI !== W || doc.documentElement.localName !== "document") throw new WsError("wrong_type", "this is not a Word (.docx) document");
  const body = kid(doc.documentElement, W, "body");
  return { pkg, part, doc, body, styles: loadStyles(pkg, part), numbering: loadNumbering(pkg, part) };
}

export function paragraphHeadingLevel(d, p) {
  const pPr = kid(p, W, "pPr");
  const ol = kid(pPr, W, "outlineLvl");
  if (ol) { const v = Number(attr(ol, W, "val")); if (v >= 0 && v <= 5) return v + 1; }
  const ps = kid(pPr, W, "pStyle");
  return ps ? d.styles.headingLevel(attr(ps, W, "val")) : 0;
}
export function paragraphNum(d, p) {
  const pPr = kid(p, W, "pPr"); const np = kid(pPr, W, "numPr");
  if (np) { const numId = attr(kid(np, W, "numId"), W, "val"); if (numId === "0") return null; return { numId, ilvl: Number(attr(kid(np, W, "ilvl"), W, "val") || 0) }; }
  const ps = kid(pPr, W, "pStyle"); return ps ? d.styles.numPr(attr(ps, W, "val")) : null;
}
export function runsOf(p) {
  const out = [];
  const walk = (n) => { for (const c of kids(n, W)) { if (c.localName === "r") out.push(c); else if (RUN_CONTAINERS.has(c.localName)) walk(c); } };
  walk(p); return out;
}
export function runText(r) { let s = ""; for (const c of kids(r, W)) { if (c.localName === "t") s += c.textContent; else if (c.localName === "tab") s += "\t"; else if (c.localName === "br" || c.localName === "cr") s += "\n"; } return s; }
export const paragraphText = (p) => runsOf(p).map(runText).join("");
export function textMap(p) {
  const segs = []; let text = "";
  for (const r of runsOf(p)) for (const c of kids(r, W)) {
    if (c.localName === "t") { const v = c.textContent; segs.push({ t: c, run: r, start: text.length, end: text.length + v.length }); text += v; }
    else if (SEP.has(c.localName)) text += "\u0000";
  }
  return { text, segs };
}
export const topBlocks = (d) => kids(d.body, W).filter((n) => n.localName === "p" || n.localName === "tbl" || n.localName === "sdt");
export function allParagraphs(d) {
  const out = all(d.body, W, "p").map((p) => ({ p, part: d.part }));
  for (const part of [...partsOfType(d.pkg, d.part, REL.header), ...partsOfType(d.pkg, d.part, REL.footer)]) for (const p of all(d.pkg.xml(part), W, "p")) out.push({ p, part });
  return out;
}
export const preserve = (t) => t.setAttributeNS(NS.xml, "xml:space", "preserve");
export function makeRun(doc, text, rPr) {
  const r = el(doc, W, "w:r");
  if (rPr) r.appendChild(rPr.cloneNode(true));
  const parts = String(text).split("\t");
  parts.forEach((piece, i) => { if (i) r.appendChild(el(doc, W, "w:tab")); if (piece) { const t = el(doc, W, "w:t", {}, [piece]); preserve(t); r.appendChild(t); } });
  return r;
}
