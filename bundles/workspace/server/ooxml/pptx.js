/**
 * In-memory .pptx model and edits (spec §4.6). Every function mutates the opened package and marks what it touched
 * dirty; the caller saves once, so a tool call is one write and one version.
 * Ids: slide_id = p:sldId/@id (stable); object_id = "<slide_id>:<cNvPr id>".
 */
import { WsError } from "../result.js";
import { NS, kids, kid, all, attr, el, removeNode, parseXml, insertAfter } from "./xml.js";
import { OoxmlPackage } from "./zip.js";
import { mainPart, readRels, resolveTarget, addRel, removeRel, partsOfType, setOverride, removeOverride, relsPath, ensureDefault, REL } from "./opc.js";
import { imageSize } from "./image-size.js";
import { SEP, scanMap, normalizeSegs, spliceSegs } from "./text-find.js";

const P = NS.p, A = NS.a;
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const EMU = 914400;
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_NOTES = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const ALIGN = { START: "l", CENTER: "ctr", END: "r", JUSTIFIED: "just" };
const MAX_SLIDE_ID = 2147483647; // ST_SlideId: 256 … 2^31-1
const MAX_SHAPE_ID = 4294967295; // ST_DrawingElementId: unsignedInt
// CT_Presentation child order (the parts that matter for inserting sldIdLst / notesMasterIdLst)
const PRES_ORDER = ["sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz", "smartTags", "embeddedFontLst", "custShowLst", "photoAlbum", "custDataLst", "kinsoku", "defaultTextStyle", "modifyVerifier", "extLst"];
const MS = "http://schemas.microsoft.com/office";
// rel types whose target is shared between slides by design; anything else is copied when a slide is duplicated
const SHARED_RELS = new Set([REL.slideLayout, REL.notesMaster, REL.image, REL.slide, REL.hyperlink,
  `${NS.r}/slideMaster`, `${NS.r}/theme`, `${NS.r}/audio`, `${NS.r}/video`, `${MS}/2007/relationships/media`, `${MS}/2007/relationships/hdphoto`]);
const COMMENT_RELS = new Set([REL.comments, `${MS}/2018/10/relationships/comments`]);

// ---- model -------------------------------------------------------------------------------------------

export function openPptx(bytes) {
  const pkg = OoxmlPackage.open(bytes); const part = mainPart(pkg); const doc = pkg.xml(part);
  if (doc.documentElement.namespaceURI !== P || doc.documentElement.localName !== "presentation") throw new WsError("wrong_type", "this is not a PowerPoint (.pptx) deck");
  const deck = { pkg, part, doc };
  loadSlides(deck);
  return deck;
}
function loadSlides(deck) {
  const rels = readRels(deck.pkg, deck.part);
  deck.slides = kids(kid(deck.doc.documentElement, P, "sldIdLst"), P, "sldId").map((e, index) => {
    const rid = attr(e, NS.r, "id"); const r = rels.find((x) => x.id === rid && !x.external);
    if (!r) throw new WsError("malformed_document", `slide ${e.getAttribute("id")} has no slide part`);
    return { el: e, id: e.getAttribute("id"), rid, part: resolveTarget(deck.part, r.target), index };
  });
}
export function slideById(deck, id) {
  const s = deck.slides.find((x) => x.id === String(id));
  if (!s) throw new WsError("slide_not_found", `No slide ${id}. Slides: ${deck.slides.map((x) => x.id).join(", ") || "(none)"}`);
  return s;
}
const spTree = (doc) => kid(kid(doc.documentElement, P, "cSld"), P, "spTree");
const shapesOf = (doc) => all(spTree(doc), P, "sp");
const OBJECTS = new Set(["sp", "pic", "graphicFrame"]);
/** Text shapes, pictures and graphic frames (tables, charts) in document order, groups included. */
const objectsOf = (doc) => Array.from(spTree(doc).getElementsByTagNameNS(P, "*")).filter((e) => OBJECTS.has(e.localName));
const nvId = (o) => kid(kids(o, P)[0], P, "cNvPr");
const phType = (sp) => { const ph = kid(kid(kid(sp, P, "nvSpPr"), P, "nvPr"), P, "ph"); return ph ? ph.getAttribute("type") || "body" : null; };
export function paraText(p) { let s = ""; for (const c of kids(p, A)) { if (c.localName === "r" || c.localName === "fld") s += kid(c, A, "t")?.textContent || ""; else if (c.localName === "br") s += "\n"; } return s; }
export const shapeText = (sp) => kids(kid(sp, P, "txBody"), A, "p").map(paraText).join("\n");
function objectInfo(o) {
  if (o.localName === "sp") return { kind: phType(o) || "shape", text: shapeText(o) };
  if (o.localName === "pic") return { kind: "picture", text: "" };
  const tbl = all(o, A, "tbl")[0];
  if (tbl) return { kind: "table", text: kids(tbl, A, "tr").map((tr) => kids(tr, A, "tc").map((tc) => kids(kid(tc, A, "txBody"), A, "p").map(paraText).join("\n")).join("\t")).join("\n") };
  return { kind: "graphic", text: "" };
}
const notesPart = (deck, s) => partsOfType(deck.pkg, s.part, REL.notesSlide)[0] || null;
export function notesText(deck, s) {
  const np = notesPart(deck, s); if (!np) return "";
  const body = shapesOf(deck.pkg.xml(np)).find((sp) => phType(sp) === "body");
  return body ? shapeText(body) : "";
}
export function shapeById(deck, objectId) {
  const m = /^(\d+):(\d+)$/.exec(String(objectId)); if (!m) throw new WsError("bad_args", "object_id looks like '256:3' (slide_id:shape id)");
  const slide = slideById(deck, m[1]);
  const sp = objectsOf(deck.pkg.xml(slide.part)).find((x) => nvId(x)?.getAttribute("id") === m[2]);
  if (!sp) throw new WsError("shape_not_found", `No shape ${objectId} (ws_slides_get_structure lists them)`);
  return { slide, sp };
}
/** A shape whose text can be edited (p:sp); pictures and tables are refused. */
function textShape(deck, objectId) {
  const r = shapeById(deck, objectId);
  if (r.sp.localName !== "sp") throw new WsError("bad_args", `${objectId} is a ${objectInfo(r.sp).kind}, not a text shape`);
  return r;
}
export function readDeck(deck, includeNotes = true) {
  return deck.slides.map((s) => {
    const doc = deck.pkg.xml(s.part);
    const title = shapesOf(doc).find((sp) => ["title", "ctrTitle"].includes(phType(sp)));
    return {
      slide_id: s.id, index: s.index, title: title ? shapeText(title) : "",
      shapes: objectsOf(doc).filter((o) => nvId(o)).map((o) => ({ object_id: `${s.id}:${nvId(o).getAttribute("id")}`, name: nvId(o).getAttribute("name"), ...objectInfo(o) })),
      ...(includeNotes ? { notes: notesText(deck, s) } : {}),
    };
  });
}

// ---- find / replace ----------------------------------------------------------------------------------

/** Paragraph text map: a:r/a:t segments; a line break, a field or any foreign child (math, …) is a separator. */
function textMap(p) {
  const segs = []; let text = "";
  for (const c of kids(p)) {
    if (c.namespaceURI === A && (c.localName === "pPr" || c.localName === "endParaRPr")) continue;
    const t = c.namespaceURI === A && c.localName === "r" ? kid(c, A, "t") : null;
    if (t) { const v = t.textContent; segs.push({ t, run: c, start: text.length, end: text.length + v.length }); text += v; }
    else text += SEP;
  }
  return { text, segs };
}
const dropRun = (g) => removeNode(g.run); // an emptied a:r goes (a:r without text is pointless)

export function findReplaceDeck(deck, pairs, matchCase = true, scope = "slides", slideIds = null) {
  if (!["slides", "notes", "all"].includes(scope)) throw new WsError("bad_args", "scope must be slides, notes or all");
  const chosen = slideIds ? slideIds.map((id) => slideById(deck, id)) : deck.slides;
  // scope "slides" never even resolves a notes part: notes are separate parts and only notes/all loads them
  const parts = [];
  for (const s of chosen) { if (scope !== "notes") parts.push(s.part); if (scope !== "slides") { const np = notesPart(deck, s); if (np) parts.push(np); } }
  const results = []; let total = 0;
  for (const pr of pairs) {
    const find = String(pr.find ?? "").normalize("NFC"); const repl = String(pr.replace ?? "").normalize("NFC");
    if (!find) throw new WsError("bad_args", "find text cannot be empty");
    const mc = pr.match_case ?? matchCase; let count = 0;
    for (const part of parts) {
      for (const p of all(deck.pkg.xml(part), A, "p")) {
        const map = textMap(p); const s = scanMap(map, find, mc);
        if (!s.hits.length) continue;
        if (!s.normalized) normalizeSegs(map.segs); // only a paragraph that is hit is rewritten
        const fresh = textMap(p);
        for (const at of [...s.hits].reverse()) spliceSegs(fresh.segs, at, at + find.length, repl, { drop: dropRun });
        count += s.hits.length; deck.pkg.markDirty(part);
      }
    }
    results.push({ find: pr.find, occurrences: count }); total += count;
  }
  return { results, total };
}

// ---- presentation.xml helpers ------------------------------------------------------------------------

/** The child `name` of p:presentation, created in schema order when missing. */
function presChild(deck, name) {
  const root = deck.doc.documentElement;
  let e = kid(root, P, name);
  if (!e) {
    const idx = PRES_ORDER.indexOf(name);
    e = el(deck.doc, P, `p:${name}`);
    root.insertBefore(e, kids(root).find((c) => c.namespaceURI === P && PRES_ORDER.indexOf(c.localName) > idx) || null);
    deck.pkg.markDirty(deck.part);
  }
  return e;
}
const sectionIds = (deck) => all(deck.doc.documentElement, P14, "sldId");
/** Put new slide id `id` into the section of slide `neighbor` (after it), or first in the first section. */
function sectionAdd(deck, id, neighbor) {
  const ref = neighbor ? sectionIds(deck).find((e) => e.getAttribute("id") === neighbor) : null;
  if (ref) { insertAfter(el(deck.doc, P14, "p14:sldId", { id }), ref); return; }
  const lst = all(deck.doc.documentElement, P14, "sldIdLst")[0];
  if (lst) lst.insertBefore(el(deck.doc, P14, "p14:sldId", { id }), lst.firstChild);
}

function nextSlideId(deck) {
  const used = new Set(deck.slides.map((s) => Number(s.id)));
  const max = Math.max(255, ...used);
  if (max < MAX_SLIDE_ID) return max + 1;
  for (let i = 256; i <= MAX_SLIDE_ID; i++) if (!used.has(i)) return i;
  throw new WsError("too_large", "no free slide id");
}
function insertSldId(deck, rid, index, sectionNeighbor) {
  const lst = presChild(deck, "sldIdLst");
  const id = nextSlideId(deck);
  const e = el(deck.doc, P, "p:sldId", { id, "r:id": rid });
  const at = index === undefined || index === null ? null : kids(lst, P, "sldId")[index] || null;
  // section of the slide just before the new one (or none → first section)
  const before = at ? kids(lst, P, "sldId")[kids(lst, P, "sldId").indexOf(at) - 1] : kids(lst, P, "sldId").at(-1);
  lst.insertBefore(e, at);
  sectionAdd(deck, String(id), sectionNeighbor ?? before?.getAttribute("id"));
  deck.pkg.markDirty(deck.part); loadSlides(deck);
  return String(id);
}

// ---- add / duplicate / delete / reorder --------------------------------------------------------------

function layouts(deck) {
  const master = partsOfType(deck.pkg, deck.part, `${NS.r}/slideMaster`);
  const fromMasters = master.flatMap((m) => partsOfType(deck.pkg, m, REL.slideLayout));
  const list = fromMasters.length ? [...new Set(fromMasters)] : deck.pkg.names().filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
  return list.map((part) => ({ part, name: kid(deck.pkg.xml(part).documentElement, P, "cSld")?.getAttribute("name") || "" }));
}
/** First free `${dir}/${stem}N${ext}` (names compared case-insensitively). */
function freeName(pkg, dir, stem, ext) {
  const taken = new Set(pkg.names().map((n) => n.toLowerCase()));
  let n = 1; while (taken.has(`${dir}/${stem}${n}${ext}`.toLowerCase())) n++;
  return `${dir}/${stem}${n}${ext}`;
}
const fileOf = (part) => part.split("/").pop();
const EMPTY_SLIDE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld xmlns:a="${A}" xmlns:r="${NS.r}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

export function addSlide(deck, layoutName = "Blank", index) {
  const ls = layouts(deck); const L = ls.find((l) => l.name.toLowerCase() === String(layoutName).trim().toLowerCase());
  if (!L) throw new WsError("bad_args", `No layout "${layoutName}". Layouts: ${ls.map((l) => l.name).join(", ")}`);
  const part = freeName(deck.pkg, "ppt/slides", "slide", ".xml");
  const doc = parseXml(EMPTY_SLIDE, part); const tree = spTree(doc);
  for (const sp of shapesOf(deck.pkg.xml(L.part))) {
    const t = phType(sp); if (!t || ["dt", "ftr", "sldNum"].includes(t)) continue;
    const nv = doc.importNode(kid(sp, P, "nvSpPr"), true);
    tree.appendChild(el(doc, P, "p:sp", {}, [nv, el(doc, P, "p:spPr"), el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr"), el(doc, A, "a:lstStyle"), el(doc, A, "a:p")])]));
  }
  deck.pkg.setXml(part, doc);
  addRel(deck.pkg, part, REL.slideLayout, `../slideLayouts/${fileOf(L.part)}`);
  setOverride(deck.pkg, part, CT_SLIDE);
  const rid = addRel(deck.pkg, deck.part, REL.slide, `slides/${fileOf(part)}`);
  return { slide_id: insertSldId(deck, rid, index), layout: L.name };
}

/** Elements of `doc` that reference relationship `id` through any r:* attribute. */
function refsTo(doc, id) {
  const out = [];
  for (const e of Array.from(doc.getElementsByTagName("*"))) for (const a of Array.from(e.attributes)) if (a.namespaceURI === NS.r && a.value === id) { out.push(e); break; }
  return out;
}
/** Drop an element that references a removed relationship (its whole p:ext when it sits in an extension list). */
function dropRef(e) {
  let n = e; while (n.parentNode && !(n.namespaceURI === P && n.localName === "ext")) n = n.parentNode;
  const target = n.parentNode ? n : e; const lst = target.parentNode;
  removeNode(target);
  if (lst && lst.localName === "extLst" && !kids(lst).length) removeNode(lst);
}

/**
 * Copy `src` (and, recursively, every part it owns) for a duplicated slide. Shared targets (layouts, images,
 * media, …) stay shared; comments are not copied. `remap` maps old → new part names (so the copied notes'
 * back-link points at the new slide). Relationship ids are kept, so the copied XML needs no rewrite.
 */
function clonePart(deck, src, remap, budget) {
  if (remap.has(src)) return remap.get(src);
  if (++budget.n > 200) throw new WsError("too_large", "that slide owns too many parts to duplicate");
  const file = fileOf(src); const dir = src.slice(0, src.length - file.length - 1);
  const m = /^(.*?)(\d*)(\.[^.]+)$/.exec(file) || [null, file, "", ""];
  const dst = freeName(deck.pkg, dir, m[1], m[3]);
  remap.set(src, dst);
  deck.pkg.setBytes(dst, deck.pkg.bytes(src));
  const ct = overrideOf(deck.pkg, src); if (ct) setOverride(deck.pkg, dst, ct);
  const rels = readRels(deck.pkg, src);
  if (rels.length) {
    deck.pkg.setBytes(relsPath(dst), deck.pkg.bytes(relsPath(src)));
    const rdoc = deck.pkg.xml(relsPath(dst)); const dropped = [];
    for (const re of kids(rdoc.documentElement, NS.rel, "Relationship")) {
      const type = re.getAttribute("Type"); if (re.getAttribute("TargetMode") === "External") continue;
      const target = resolveTarget(src, re.getAttribute("Target"));
      if (COMMENT_RELS.has(type)) { dropped.push(re.getAttribute("Id")); removeNode(re); continue; }
      const next = SHARED_RELS.has(type) ? remap.get(target) : deck.pkg.has(target) ? clonePart(deck, target, remap, budget) : null;
      if (next && next !== target) re.setAttribute("Target", re.getAttribute("Target").replace(/[^/]+$/, fileOf(next)));
    }
    deck.pkg.markDirty(relsPath(dst));
    if (dropped.length && /\.xml$/i.test(dst)) { const doc = deck.pkg.xml(dst); for (const id of dropped) for (const e of refsTo(doc, id)) dropRef(e); deck.pkg.markDirty(dst); }
  }
  return dst;
}
function overrideOf(pkg, part) {
  const o = kids(pkg.xml("[Content_Types].xml").documentElement, NS.ct, "Override").find((e) => e.getAttribute("PartName") === `/${part}`);
  return o ? o.getAttribute("ContentType") : null;
}

export function duplicateSlide(deck, slideId) {
  const s = slideById(deck, slideId);
  const part = clonePart(deck, s.part, new Map(), { n: 0 });
  setOverride(deck.pkg, part, CT_SLIDE);
  const rid = addRel(deck.pkg, deck.part, REL.slide, `slides/${fileOf(part)}`);
  return { slide_id: insertSldId(deck, rid, s.index + 1, s.id) };
}

/** All relationships in the package, with the part they belong to. */
function allRels(pkg) {
  const out = [];
  for (const n of pkg.names().filter((x) => /(^|\/)_rels\/[^/]*\.rels$/.test(x))) {
    const source = n === "_rels/.rels" ? "" : n.replace(/_rels\/([^/]+)\.rels$/, "$1");
    for (const r of readRels(pkg, source)) out.push({ ...r, source, resolved: r.external ? null : resolveTarget(source, r.target) });
  }
  return out;
}
function removePart(pkg, p) {
  pkg.remove(p); removeOverride(pkg, p);
  if (pkg.has(relsPath(p))) pkg.remove(relsPath(p));
}

export function deleteSlide(deck, slideId) {
  const s = slideById(deck, slideId); const np = notesPart(deck, s);
  const gone = new Set([s.part, np].filter(Boolean));
  // links from other parts that jump to this slide: the a:hlinkClick/a:hlinkMouseOver goes with the relationship
  const inbound = allRels(deck.pkg).filter((r) => r.resolved === s.part && !gone.has(r.source) && r.source !== deck.part);
  for (const r of inbound) {
    const doc = deck.pkg.xml(r.source);
    const refs = refsTo(doc, r.id);
    const other = refs.find((e) => !(e.namespaceURI === A && ["hlinkClick", "hlinkMouseOver"].includes(e.localName)));
    if (other) throw new WsError("unsupported", `${r.source} refers to this slide in a way Crow cannot unlink (${other.localName}); delete the slide in the editor`);
  }
  for (const r of inbound) { for (const e of refsTo(deck.pkg.xml(r.source), r.id)) removeNode(e); deck.pkg.markDirty(r.source); removeRel(deck.pkg, r.source, r.id); }
  // presentation.xml: the slide list, custom shows and sections
  removeNode(s.el);
  for (const e of all(deck.doc.documentElement, P, "sld")) if (attr(e, NS.r, "id") === s.rid) removeNode(e);
  for (const e of sectionIds(deck)) if (e.getAttribute("id") === s.id) removeNode(e);
  removeRel(deck.pkg, deck.part, s.rid);
  // the slide, its notes, and every part only they used (images, comments, charts…), with rels and overrides
  let candidates = [...gone].flatMap((p) => readRels(deck.pkg, p).filter((r) => !r.external).map((r) => resolveTarget(p, r.target)));
  for (const p of gone) removePart(deck.pkg, p);
  while (candidates.length) {
    const used = new Set(allRels(deck.pkg).map((r) => r.resolved));
    const orphans = [...new Set(candidates)].filter((p) => deck.pkg.has(p) && !used.has(p));
    candidates = orphans.flatMap((p) => readRels(deck.pkg, p).filter((r) => !r.external).map((r) => resolveTarget(p, r.target)));
    for (const p of orphans) removePart(deck.pkg, p);
  }
  deck.pkg.markDirty(deck.part); loadSlides(deck);
  return { deleted: s.id };
}

/** Google semantics: insertion_index is a position in the slide order BEFORE the move. */
export function reorderSlides(deck, slideIds, insertionIndex) {
  if (new Set(slideIds.map(String)).size !== slideIds.length) throw new WsError("bad_args", "slide_ids has duplicates");
  const moving = slideIds.map((id) => slideById(deck, id));
  const rest = deck.slides.filter((s) => !moving.includes(s));
  const at = deck.slides.slice(0, Math.max(0, insertionIndex)).filter((s) => !moving.includes(s)).length;
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  const lst = kid(deck.doc.documentElement, P, "sldIdLst");
  for (const s of order) lst.appendChild(s.el);
  // sections must list the slides in sldIdLst order: a moved slide joins the section of the slide before it
  // (moving to the front: they join the first remaining slide's section, before it)
  if (sectionIds(deck).length) {
    const find = (id) => sectionIds(deck).find((e) => e.getAttribute("id") === id) || null;
    for (const s of moving) removeNode(find(s.id));
    const fresh = moving.map((s) => el(deck.doc, P14, "p14:sldId", { id: s.id }));
    const after = at > 0 ? find(rest[at - 1].id) : null; const before = at === 0 && rest.length ? find(rest[0].id) : null;
    if (after) { let a = after; for (const e of fresh) { insertAfter(e, a); a = e; } }
    else if (before) for (const e of fresh) before.parentNode.insertBefore(e, before);
    else { const lst = all(deck.doc.documentElement, P14, "sldIdLst")[0]; for (const e of fresh) lst.appendChild(e); }
  }
  deck.pkg.markDirty(deck.part); loadSlides(deck);
  return { order: deck.slides.map((s) => s.id) };
}

// ---- shapes ------------------------------------------------------------------------------------------

function nextShapeId(doc) {
  const used = new Set(all(doc.documentElement, P, "cNvPr").map((e) => Number(e.getAttribute("id")) || 0));
  const max = Math.max(1, ...used);
  if (max < MAX_SHAPE_ID) return max + 1;
  let i = 2; while (used.has(i)) i++; return i;
}
const inch = (v) => Math.round(Number(v) * EMU);
const xfrm = (doc, { x, y, width, height }) => el(doc, A, "a:xfrm", {}, [el(doc, A, "a:off", { x: inch(x), y: inch(y) }), el(doc, A, "a:ext", { cx: inch(width), cy: inch(height) })]);

export function addTextBox(deck, slideId, text, { x = 1, y = 1, width = 8, height = 1, font_size } = {}) {
  const s = slideById(deck, slideId); const doc = deck.pkg.xml(s.part); const id = nextShapeId(doc);
  const rPr = () => el(doc, A, "a:rPr", { sz: font_size ? Math.round(font_size * 100) : undefined, dirty: "0" });
  const paras = String(text).normalize("NFC").split("\n").map((line) => el(doc, A, "a:p", {}, line ? [el(doc, A, "a:r", {}, [rPr(), el(doc, A, "a:t", {}, [line])])] : [el(doc, A, "a:endParaRPr", { sz: font_size ? Math.round(font_size * 100) : undefined, dirty: "0" })]));
  const sp = el(doc, P, "p:sp", {}, [
    el(doc, P, "p:nvSpPr", {}, [el(doc, P, "p:cNvPr", { id, name: `TextBox ${id}` }), el(doc, P, "p:cNvSpPr", { txBox: "1" }), el(doc, P, "p:nvPr")]),
    el(doc, P, "p:spPr", {}, [xfrm(doc, { x, y, width, height }), el(doc, A, "a:prstGeom", { prst: "rect" }, [el(doc, A, "a:avLst")]), el(doc, A, "a:noFill")]),
    el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr", { wrap: "square", rtlCol: "0" }, [el(doc, A, "a:spAutoFit")]), el(doc, A, "a:lstStyle"), ...paras]),
  ]);
  spTree(doc).appendChild(sp); deck.pkg.markDirty(s.part);
  return { object_id: `${s.id}:${id}` };
}

export function addImage(deck, slideId, bytes, { x = 1, y = 1, width = 4, height = 3 } = {}) {
  const { type } = imageSize(bytes); // bad_image for non-images and sides over 65535 px
  const s = slideById(deck, slideId); const doc = deck.pkg.xml(s.part);
  const media = freeName(deck.pkg, "ppt/media", "crow-image-", `.${type}`);
  deck.pkg.setBytes(media, new Uint8Array(bytes)); ensureDefault(deck.pkg, type, `image/${type}`);
  const rid = addRel(deck.pkg, s.part, REL.image, `../media/${fileOf(media)}`);
  const id = nextShapeId(doc);
  const pic = el(doc, P, "p:pic", {}, [
    el(doc, P, "p:nvPicPr", {}, [el(doc, P, "p:cNvPr", { id, name: `Picture ${id}` }), el(doc, P, "p:cNvPicPr", {}, [el(doc, A, "a:picLocks", { noChangeAspect: "1" })]), el(doc, P, "p:nvPr")]),
    el(doc, P, "p:blipFill", {}, [el(doc, A, "a:blip", { "r:embed": rid }), el(doc, A, "a:stretch", {}, [el(doc, A, "a:fillRect")])]),
    el(doc, P, "p:spPr", {}, [xfrm(doc, { x, y, width, height }), el(doc, A, "a:prstGeom", { prst: "rect" }, [el(doc, A, "a:avLst")])]),
  ]);
  spTree(doc).appendChild(pic); deck.pkg.markDirty(s.part);
  return { object_id: `${s.id}:${id}`, image_part: media };
}

const RPR_KIDS = ["ln", "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "effectLst", "effectDag", "highlight", "uLnTx", "uLn", "uFillTx", "uFill", "latin", "ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"];
const FILLS = ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
function setRprChild(rPr, name, node) {
  for (const c of kids(rPr, A)) if (c.localName === name || (name === "solidFill" && FILLS.includes(c.localName))) rPr.removeChild(c);
  const idx = RPR_KIDS.indexOf(name); rPr.insertBefore(node, kids(rPr, A).find((c) => RPR_KIDS.indexOf(c.localName) > idx) || null);
}
export function formatShapeText(deck, objectId, st) {
  const keys = ["bold", "italic", "underline", "font_size", "color_hex", "font_family"].filter((k) => st[k] !== undefined && st[k] !== null);
  if (!keys.length) throw new WsError("no_style", "give at least one of bold, italic, underline, font_size, color_hex, font_family");
  if (st.color_hex !== undefined && st.color_hex !== null && !/^#?[0-9a-fA-F]{6}$/.test(st.color_hex)) throw new WsError("bad_color", "color_hex must be 6 hex digits");
  const { slide, sp } = textShape(deck, objectId); const doc = sp.ownerDocument; let n = 0;
  for (const r of all(sp, A, "r")) {
    let rPr = kid(r, A, "rPr"); if (!rPr) { rPr = el(doc, A, "a:rPr"); r.insertBefore(rPr, r.firstChild); }
    if (st.bold != null) rPr.setAttribute("b", st.bold ? "1" : "0");
    if (st.italic != null) rPr.setAttribute("i", st.italic ? "1" : "0");
    if (st.underline != null) rPr.setAttribute("u", st.underline ? "sng" : "none");
    if (st.font_size != null) rPr.setAttribute("sz", String(Math.round(st.font_size * 100)));
    if (st.color_hex != null) setRprChild(rPr, "solidFill", el(doc, A, "a:solidFill", {}, [el(doc, A, "a:srgbClr", { val: st.color_hex.replace("#", "").toUpperCase() })]));
    if (st.font_family != null) setRprChild(rPr, "latin", el(doc, A, "a:latin", { typeface: st.font_family }));
    n++;
  }
  if (n) deck.pkg.markDirty(slide.part);
  return n;
}
export function formatParagraphs(deck, objectId, alignment) {
  if (!ALIGN[alignment]) throw new WsError("bad_args", "alignment must be START, CENTER, END or JUSTIFIED");
  const { slide, sp } = textShape(deck, objectId); const doc = sp.ownerDocument; let n = 0;
  for (const p of all(sp, A, "p")) { let pPr = kid(p, A, "pPr"); if (!pPr) { pPr = el(doc, A, "a:pPr"); p.insertBefore(pPr, p.firstChild); } pPr.setAttribute("algn", ALIGN[alignment]); n++; }
  if (n) deck.pkg.markDirty(slide.part);
  return n;
}
/** New paragraphs for `text` ("\n" → paragraphs) carrying a copy of pPr / rPr / endParaRPr. */
function makeParas(doc, text, { pPr, rPr, endRPr }) {
  return String(text).normalize("NFC").split("\n").map((line) => {
    const p = el(doc, A, "a:p", {}, [pPr ? pPr.cloneNode(true) : null]);
    if (line) {
      const r = rPr ? rPr.cloneNode(true) : el(doc, A, "a:rPr");
      r.removeAttribute("err"); // a spelling flag belongs to the old text
      p.appendChild(el(doc, A, "a:r", {}, [r, el(doc, A, "a:t", {}, [line])]));
    }
    if (endRPr) p.appendChild(endRPr.cloneNode(true));
    return p;
  });
}
function bodyOf(sp) {
  let tb = kid(sp, P, "txBody");
  if (!tb) { const doc = sp.ownerDocument; tb = el(doc, P, "p:txBody", {}, [el(doc, A, "a:bodyPr"), el(doc, A, "a:lstStyle")]); sp.appendChild(tb); }
  return tb;
}
/** Replace the shape's text: the first a:pPr and the first run's a:rPr are reapplied to every new paragraph. */
function setBodyText(sp, text) {
  const doc = sp.ownerDocument; const tb = bodyOf(sp); const ps = kids(tb, A, "p");
  const r0 = all(tb, A, "r")[0];
  const fmt = { pPr: ps[0] ? kid(ps[0], A, "pPr") : null, rPr: r0 ? kid(r0, A, "rPr") : null, endRPr: ps[0] ? kid(ps[0], A, "endParaRPr") : null };
  for (const p of ps) tb.removeChild(p);
  for (const p of makeParas(doc, text, fmt)) tb.appendChild(p);
}
export function editShapeText(deck, objectId, text) {
  const { slide, sp } = textShape(deck, objectId);
  setBodyText(sp, text); deck.pkg.markDirty(slide.part); return true;
}

// ---- notes -------------------------------------------------------------------------------------------

/** notesMasterIdLst must name the notes master once a notes slide exists (python-pptx decks omit it). */
export function ensureNotesMasterId(deck) {
  const rel = readRels(deck.pkg, deck.part).find((r) => r.type === REL.notesMaster && !r.external);
  if (!rel || kids(kid(deck.doc.documentElement, P, "notesMasterIdLst"), P, "notesMasterId").length) return;
  presChild(deck, "notesMasterIdLst").appendChild(el(deck.doc, P, "p:notesMasterId", { "r:id": rel.id }));
  deck.pkg.markDirty(deck.part);
}
function createNotes(deck, s) {
  const master = partsOfType(deck.pkg, deck.part, REL.notesMaster)[0];
  if (!master) throw new WsError("no_notes_master", "This deck has no notes master, so speaker notes cannot be added here; add them once in the editor.");
  const part = freeName(deck.pkg, "ppt/notesSlides", "notesSlide", ".xml");
  deck.pkg.setXml(part, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:notes xmlns:a="${A}" xmlns:r="${NS.r}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`, part));
  addRel(deck.pkg, part, REL.notesMaster, `../notesMasters/${fileOf(master)}`);
  addRel(deck.pkg, part, REL.slide, `../slides/${fileOf(s.part)}`);
  addRel(deck.pkg, s.part, REL.notesSlide, `../notesSlides/${fileOf(part)}`);
  setOverride(deck.pkg, part, CT_NOTES);
  ensureNotesMasterId(deck);
  return part;
}
export function editNotes(deck, slideId, text, mode = "replace") {
  if (!["replace", "append"].includes(mode)) throw new WsError("bad_args", "mode must be replace or append");
  const s = slideById(deck, slideId); const np = notesPart(deck, s) || createNotes(deck, s);
  const body = shapesOf(deck.pkg.xml(np)).find((sp) => phType(sp) === "body");
  if (!body) throw new WsError("no_notes_master", "This slide's notes page has no text area");
  if (mode === "append" && shapeText(body)) {
    // new paragraphs after the existing ones, formatted like the last paragraph; the old text is untouched
    const tb = bodyOf(body); const last = kids(tb, A, "p").at(-1); const lr = all(last, A, "r").at(-1);
    for (const p of makeParas(body.ownerDocument, text, { pPr: kid(last, A, "pPr"), rPr: lr ? kid(lr, A, "rPr") : null, endRPr: kid(last, A, "endParaRPr") })) tb.appendChild(p);
  } else setBodyText(body, text);
  deck.pkg.markDirty(np); return true;
}
