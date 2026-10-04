/**
 * In-memory .docx edits (spec §4.3). Every function mutates the opened package `d` and marks the parts it
 * touched dirty; the caller (docxWrite) saves once, so a whole tool call is one write and one version.
 */
import { WsError } from "../result.js";
import { NS, kids, kid, el, insertAfter, removeNode, parseXml } from "./xml.js";
import { textMap, runsOf, paragraphText, topBlocks, allParagraphs, makeRun, preserve, setOrdered, RPR_ORDER } from "./docx-model.js";
import { sectionRange } from "./docx-read.js";
import { markdownToBlocks, safeUrl } from "./md-to-wml.js";
import { addRel, removeRel, REL, ensureDefault } from "./opc.js";
import { imageSize } from "./image-size.js";
import { scanMap, normalizeSegs, spliceSegs } from "./text-find.js";

const W = NS.w;
const KEEP_ON_REWRITE = new Set(["pPr", "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd", "proofErr"]);
const RANGE_END = new Set(["bookmarkEnd", "commentRangeEnd"]);
// what a plain-text run may hold; anything else (drawing, field chars, footnote refs, objects…) is not plain text
const PLAIN_RUN = new Set(["rPr", "t", "tab", "br", "cr", "lastRenderedPageBreak", "softHyphen", "noBreakHyphen"]);
// every element child (any namespace) is checked: a foreign one (mc:AlternateContent shapes, m:oMath, w14:*) is never plain
const isW = (c, names) => c.namespaceURI === W && names.has(c.localName);
const COMMENT_RUN = new Set(["rPr", "commentReference"]);
const isCommentRef = (c) => c.namespaceURI === W && c.localName === "r" && kids(c, W, "commentReference").length > 0 && kids(c).every((k) => isW(k, COMMENT_RUN));
/**
 * A paragraph whose whole text may be replaced: only plain runs, comment markers and range anchors. Links,
 * fields (fldSimple/fldChar), tracked changes, content controls, images and note references would be lost or
 * left unbalanced, so those paragraphs are refused (spec §8 remedy: edit them with find_replace).
 */
export const isPlainTextParagraph = (p) => kids(p).every((c) => isW(c, KEEP_ON_REWRITE) || isCommentRef(c) || (c.namespaceURI === W && c.localName === "r" && kids(c).every((k) => isW(k, PLAIN_RUN))));

// ---- text search -------------------------------------------------------------------------------------
// A paragraph's text is its w:t segments joined, with SEP for every tab/break/drawing/field (docx-model textMap),
// so a match can span runs (and the bookmarks/comment anchors between them) but never a tab or a line break.
// The matching itself is the shared, pure core in text-find.js (NFC and NFD spellings are equal).

/** Pure: match offsets in the NFC form of p. Never touches p. */
const scan = (p, find, matchCase) => scanMap(textMap(p), find, matchCase);
/** Only for a paragraph that IS hit: store its w:t text NFC so the scan offsets apply; returns the fresh map. */
function prepareHit(p, normalized) {
  if (!normalized) normalizeSegs(textMap(p).segs);
  return textMap(p);
}

/** A w:t emptied by an edit goes, and so does its run when nothing but w:rPr is left. */
function dropIfEmpty(g) {
  if (g.t.textContent) return;
  removeNode(g.t);
  if (!kids(g.run, W).some((c) => c.localName !== "rPr")) removeNode(g.run);
}

/** Replace [start,end) of a docx text map by repl in the run where the match starts; the other runs are trimmed. */
export const spliceText = (segs, start, end, repl) => spliceSegs(segs, start, end, repl, { touch: preserve, drop: dropIfEmpty });

export function findReplace(d, pairs, matchCase = true) {
  const results = []; let total = 0;
  for (const pr of pairs) {
    const find = String(pr.find ?? "").normalize("NFC"); const repl = String(pr.replace ?? "").normalize("NFC");
    if (!find) throw new WsError("bad_args", "find text cannot be empty");
    const mc = pr.match_case ?? matchCase; let count = 0;
    for (const { p, part } of allParagraphs(d)) {
      const s = scan(p, find, mc);
      if (!s.hits.length) continue;
      const map = prepareHit(p, s.normalized);
      for (const at of [...s.hits].reverse()) spliceText(map.segs, at, at + find.length, repl);
      count += s.hits.length; d.pkg.markDirty(part);
    }
    results.push({ find: pr.find, occurrences: count }); total += count;
  }
  return { results, total };
}

// ---- whole-paragraph rewrite -------------------------------------------------------------------------

export function setParagraphText(d, p, text) {
  if (!isPlainTextParagraph(p)) throw new WsError("not_plain_text", "that paragraph holds a link, field, image, tracked change or note reference; edit it with ws_docs_find_replace instead");
  const lines = String(text).normalize("NFC").split("\n");
  const pPr = kid(p, W, "pPr");
  const firstRun = runsOf(p).find((r) => !isCommentRef(r)); const rPr = firstRun ? kid(firstRun, W, "rPr") : null; const rPrCopy = rPr ? rPr.cloneNode(true) : null;
  for (const c of kids(p)) if (!isW(c, KEEP_ON_REWRITE) && !isCommentRef(c)) removeNode(c);
  // the new text goes before the first range end (inside bookmarks and comment ranges) and before the comment marker
  const anchor = kids(p, W).find((c) => RANGE_END.has(c.localName) || isCommentRef(c)) || null;
  p.insertBefore(makeRun(d.doc, lines[0], rPrCopy), anchor);
  let prev = p;
  for (const line of lines.slice(1)) {
    const np = el(d.doc, W, "w:p");
    if (pPr) { const c = pPr.cloneNode(true); for (const s of kids(c, W, "sectPr")) c.removeChild(s); np.appendChild(c); }
    np.appendChild(makeRun(d.doc, line, rPrCopy));
    insertAfter(np, prev); prev = np;
  }
  d.pkg.markDirty(d.part);
}

/** How rewrite_passages reads a match_prefix, and which body paragraph it picks (the first unused one that starts with it). */
export const passagePrefix = (s) => String(s ?? "").normalize("NFC").trim().slice(0, 100);
export const findPassage = (paras, prefix, used = new Set()) => paras.find((x) => !used.has(x) && paragraphText(x).normalize("NFC").replace(/^\s+/, "").startsWith(prefix));
/** Final review I1: an optional expect_text pins the passage's WHOLE current text (NFC), so a prefix match alone never rewrites a paragraph someone edited since. */
export const expectsOk = (p, expectText) => expectText === undefined || expectText === null || paragraphText(p).normalize("NFC") === String(expectText).normalize("NFC");

export function rewritePassages(d, passages) {
  const used = new Set(); const paras = kids(d.body, W, "p");
  const results = passages.map((ps) => {
    const prefix = passagePrefix(ps.match_prefix);
    if (!prefix) return { match_prefix: ps.match_prefix, matched: false, reason: "Empty match_prefix" };
    const p = findPassage(paras, prefix, used);
    if (!p) return { match_prefix: ps.match_prefix, matched: false, reason: "No paragraph starts with this prefix" };
    if (!expectsOk(p, ps.expect_text)) return { match_prefix: ps.match_prefix, matched: false, reason: "text_changed" };
    if (!isPlainTextParagraph(p)) return { match_prefix: ps.match_prefix, matched: false, reason: "not_plain_text" };
    used.add(p); const original_length = paragraphText(p).length;
    setParagraphText(d, p, ps.new_text);
    return { match_prefix: ps.match_prefix, matched: true, original_length, new_length: String(ps.new_text).length };
  });
  return { results };
}

// ---- styling -----------------------------------------------------------------------------------------

/** Split `run` so that tNode's text from `offset` on (and every later child) moves to a new run after it. */
function splitRun(run, tNode, offset) {
  const doc = run.ownerDocument; const text = tNode.textContent;
  if (offset <= 0 || offset >= text.length) return;
  const nr = el(doc, W, "w:r"); const rPr = kid(run, W, "rPr"); if (rPr) nr.appendChild(rPr.cloneNode(true));
  const nt = el(doc, W, "w:t", {}, [text.slice(offset)]); preserve(nt); nr.appendChild(nt);
  let sib = tNode.nextSibling; while (sib) { const next = sib.nextSibling; nr.appendChild(sib); sib = next; }
  tNode.textContent = text.slice(0, offset); preserve(tNode);
  insertAfter(nr, run);
}
/** Move `node` and every later sibling into a new run (same w:rPr) right after `run`. */
function splitBefore(run, node) {
  const nr = el(run.ownerDocument, W, "w:r"); const rPr = kid(run, W, "rPr"); if (rPr) nr.appendChild(rPr.cloneNode(true));
  for (let n = node; n;) { const next = n.nextSibling; nr.appendChild(n); n = next; }
  insertAfter(nr, run);
}
const elementSibling = (n, dir) => { for (let x = n[dir]; x; x = x[dir]) if (x.nodeType === 1) return x; return null; };
const contentBefore = (t) => { const x = elementSibling(t, "previousSibling"); return x && !(x.namespaceURI === W && x.localName === "rPr") ? x : null; };
/**
 * Split runs at the match edges; returns the runs that hold exactly [start,end). An edge inside a w:t splits it;
 * an edge between two children of one run (text right after a tab or before a break) splits the run there, so
 * the returned runs never carry text or tabs from outside the range.
 */
export function isolate(p, start, end) {
  for (const pos of [end, start]) {
    const segs = textMap(p).segs.filter((s) => s.end > s.start);
    const g = segs.find((s) => s.start < pos && pos < s.end);
    if (g) { splitRun(g.run, g.t, pos - g.start); continue; }
    if (pos === end) { const a = segs.find((s) => s.end === pos && elementSibling(s.t, "nextSibling")); if (a) splitBefore(a.run, elementSibling(a.t, "nextSibling")); }
    if (pos === start) { const b = segs.find((s) => s.start === pos && contentBefore(s.t)); if (b) splitBefore(b.run, b.t); }
  }
  return [...new Set(textMap(p).segs.filter((s) => s.start >= start && s.end <= end && s.end > s.start).map((s) => s.run))];
}

export function formatText(d, find, occurrence, style) {
  const keys = ["bold", "italic", "underline", "link_url", "color_hex"].filter((k) => style[k] !== undefined && style[k] !== null);
  if (!keys.length) throw new WsError("no_style", "give at least one of bold, italic, underline, link_url, color_hex");
  if (style.color_hex !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(style.color_hex)) throw new WsError("bad_color", "color_hex must be 6 hex digits");
  const url = style.link_url !== undefined ? safeUrl(style.link_url) : null;
  const needle = String(find).normalize("NFC");
  const all = [];
  for (const { p, part } of allParagraphs(d)) { const s = scan(p, needle, true); for (const h of s.hits) all.push({ p, part, h, normalized: s.normalized }); }
  if (!all.length) throw new WsError("not_found", `"${find}" was not found`);
  const chosen = occurrence === -1 ? all : [all[occurrence]].filter(Boolean);
  if (!chosen.length) throw new WsError("bad_args", `occurrence ${occurrence} is out of range (found ${all.length})`);
  for (const c of chosen) prepareHit(c.p, c.normalized); // only paragraphs that are actually edited
  for (const { p, part, h } of [...chosen].reverse()) {
    const runs = isolate(p, h, h + needle.length);
    const doc = p.ownerDocument;
    for (const r of runs) {
      let rPr = kid(r, W, "rPr"); if (!rPr) { rPr = el(doc, W, "w:rPr"); r.insertBefore(rPr, r.firstChild); }
      const flag = (name, v) => setOrdered(rPr, RPR_ORDER, name, v ? el(doc, W, `w:${name}`) : el(doc, W, `w:${name}`, { "w:val": "0" }));
      if (style.bold !== undefined) flag("b", style.bold);
      if (style.italic !== undefined) flag("i", style.italic);
      if (style.underline !== undefined) setOrdered(rPr, RPR_ORDER, "u", el(doc, W, "w:u", { "w:val": style.underline ? "single" : "none" }));
      if (style.color_hex !== undefined) setOrdered(rPr, RPR_ORDER, "color", el(doc, W, "w:color", { "w:val": style.color_hex.replace("#", "").toUpperCase() }));
    }
    if (url) {
      const parents = new Set(runs.map((r) => r.parentNode));
      const parent = [...parents][0];
      const inLink = [...parents].some((x) => x.localName === "hyperlink");
      if (inLink && (parents.size > 1 || runsOf(parent).some((r) => !runs.includes(r) && kids(r, W, "t").some((t) => t.textContent)))) throw new WsError("bad_args", "part of that text is already a link; give the whole link text to change where it points");
      if (parents.size > 1) throw new WsError("bad_args", "that text crosses a field or tracked change; format a smaller piece");
      if (inLink) {
        // the match is the whole link: re-point it, and drop the old relationship when nothing else uses it
        const old = parent.getAttributeNS(NS.r, "id");
        const relId = addRel(d.pkg, part, REL.hyperlink, url, true);
        parent.setAttributeNS(NS.r, "r:id", relId);
        parent.removeAttributeNS(W, "anchor"); // else Word appends #anchor to the new URL
        if (old && !relUsed(p.ownerDocument, old)) removeRel(d.pkg, part, old);
      } else {
        const relId = addRel(d.pkg, part, REL.hyperlink, url, true);
        // wrap the runs and anything between them (bookmarks, comment anchors) in one w:hyperlink
        const h = el(doc, W, "w:hyperlink", { "r:id": relId }); const last = runs.at(-1);
        parent.insertBefore(h, runs[0]);
        for (let n = h.nextSibling; n;) { const next = n.nextSibling; h.appendChild(n); if (n === last) break; n = next; }
      }
    }
    d.pkg.markDirty(part);
  }
  return chosen.length;
}

/** Whether any element of the part still references relationship `id` (r:id, r:embed, r:link, …). */
function relUsed(doc, id) {
  for (const e of Array.from(doc.getElementsByTagName("*"))) for (const a of Array.from(e.attributes)) if (a.namespaceURI === NS.r && a.value === id) return true;
  return false;
}

// ---- block insertion ---------------------------------------------------------------------------------

const sectPr = (d) => kids(d.body, W, "sectPr").at(-1) || null;
export function insertBlocksAt(d, before, nodes) { for (const n of nodes) d.body.insertBefore(n, before); if (nodes.length) d.pkg.markDirty(d.part); }
export function appendMarkdown(d, md) { const nodes = markdownToBlocks(d, md); insertBlocksAt(d, sectPr(d), nodes); return nodes.length; }
export function insertAtHeading(d, heading, md) {
  const r = sectionRange(d, heading); const blocks = topBlocks(d);
  const nodes = markdownToBlocks(d, md); insertBlocksAt(d, blocks[r.start].nextSibling, nodes); return nodes.length;
}
/**
 * Exact inverse of append / insert_at_heading (ws__docs_remove_paragraphs_exact): removes the consecutive top-level
 * paragraphs whose texts equal `texts` exactly (NFC). With `afterHeading` they must sit right after that heading,
 * with `atEnd` they must be the last body blocks; otherwise the run must occur exactly once in the document.
 * Anything else (text changed, moved, ambiguous) → target_changed and nothing is touched.
 */
export function removeParagraphsExact(d, texts, { afterHeading, atEnd = false } = {}) {
  if (!Array.isArray(texts) || !texts.length || texts.some((t) => typeof t !== "string")) throw new WsError("bad_args", "texts must be a non-empty list of paragraph texts");
  const want = texts.map((t) => t.normalize("NFC"));
  const blocks = topBlocks(d);
  const at = (i) => i >= 0 && i + want.length <= blocks.length && want.every((t, k) => blocks[i + k].localName === "p" && paragraphText(blocks[i + k]).normalize("NFC") === t);
  let starts;
  if (afterHeading !== undefined && afterHeading !== null) {
    let r; try { r = sectionRange(d, afterHeading); } catch (e) { if (e.code === "heading_not_found") throw new WsError("target_changed", `the heading "${afterHeading}" is gone`); throw e; }
    starts = [r.start + 1];
  } else if (atEnd) starts = [blocks.length - want.length];
  else starts = blocks.map((_, i) => i);
  const hits = starts.filter(at);
  if (hits.length !== 1) throw new WsError("target_changed", hits.length ? "those paragraphs occur more than once; Crow will not guess which to remove" : "those paragraphs are no longer there exactly as Crow added them");
  for (const b of blocks.slice(hits[0], hits[0] + want.length)) removeNode(b);
  d.pkg.markDirty(d.part);
  return want.length;
}
/** Heading-to-heading: removes every block after the heading up to the next same-or-higher heading, then inserts. */
export function replaceSection(d, heading, md) {
  const r = sectionRange(d, heading); const blocks = topBlocks(d);
  const removed = blocks.slice(r.start + 1, r.end);
  const before = blocks[r.end] || sectPr(d);
  for (const b of removed) removeNode(b);
  if (removed.length) d.pkg.markDirty(d.part);
  const nodes = markdownToBlocks(d, md); insertBlocksAt(d, before, nodes);
  return { removed: removed.length, inserted: nodes.length };
}

// ---- images ------------------------------------------------------------------------------------------

function nextDocPrId(d) {
  const docs = new Set([d.doc, ...allParagraphs(d).map((x) => x.p.ownerDocument)]); // body, headers, footers
  let max = 0;
  for (const doc of docs) for (const e of Array.from(doc.getElementsByTagNameNS(NS.wp, "docPr"))) max = Math.max(max, Number(e.getAttribute("id")) || 0);
  return max + 1;
}

/** Find anchorText inside one w:t; returns {part, target} where target is a run holding exactly that text. */
function anchorRun(d, anchorText) {
  const want = String(anchorText).normalize("NFC");
  for (const { p, part } of allParagraphs(d)) {
    for (const g of textMap(p).segs) {
      const norm = g.t.textContent.normalize("NFC"); const off = norm.indexOf(want);
      if (off < 0) continue;
      if (norm !== g.t.textContent) g.t.textContent = norm;
      splitRun(g.run, g.t, off + want.length);
      if (off > 0) { splitRun(g.run, g.t, off); return { part, target: g.run.nextSibling }; }
      if (kids(g.run, W).some((c) => c !== g.t && c.localName !== "rPr")) {
        // the run also holds earlier text/tabs: move just this w:t into its own run
        const nr = el(p.ownerDocument, W, "w:r"); const rPr = kid(g.run, W, "rPr"); if (rPr) nr.appendChild(rPr.cloneNode(true));
        nr.appendChild(g.t); insertAfter(nr, g.run); return { part, target: nr };
      }
      return { part, target: g.run };
    }
  }
  throw new WsError("not_found", `anchor_text "${anchorText}" was not found inside a single run`);
}

export function insertImage(d, bytes, { anchorText, index = 0, maxWidthPt = 450 } = {}) {
  const { type, width, height } = imageSize(bytes);
  const ext = type; // png | jpeg | gif
  const loc = anchorText ? anchorRun(d, anchorText) : null;
  const part = loc ? loc.part : d.part;
  const doc = loc ? loc.target.ownerDocument : d.doc;
  // spec §4.3: word/media/imageN.<ext>, N the first free number (names compared case-insensitively)
  const taken = new Set(d.pkg.names().map((n) => n.toLowerCase()));
  let n = 1; while ([...taken].some((x) => x.startsWith(`word/media/image${n}.`))) n++;
  const media = `image${n}.${ext}`;
  d.pkg.setBytes(`word/media/${media}`, new Uint8Array(bytes));
  ensureDefault(d.pkg, ext, `image/${type}`);
  const target = part.startsWith("word/") && !part.slice(5).includes("/") ? `media/${media}` : `/word/media/${media}`;
  const rid = addRel(d.pkg, part, REL.image, target);
  const pxW = width * 9525, pxH = height * 9525; const maxW = Math.round(maxWidthPt * 12700);
  const cx = Math.min(pxW, maxW); const cy = Math.round(pxH * (cx / pxW));
  const id = nextDocPrId(d);
  const frag = parseXml(`<w:r xmlns:w="${W}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:r="${NS.r}"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${media}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`, "image-run");
  const run = doc.importNode(frag.documentElement, true);
  // drop the fragment's own xmlns attributes; the serializer declares any prefix the part does not already have
  for (const a of Array.from(run.attributes)) if (a.name.startsWith("xmlns:")) run.removeAttribute(a.name);
  if (loc) { loc.target.parentNode.replaceChild(run, loc.target); d.pkg.markDirty(part); return { placed: "anchor", image_part: `word/media/${media}`, width_pt: cx / 12700, height_pt: cy / 12700 }; }
  const blocks = topBlocks(d); const p = el(d.doc, W, "w:p", {}, [run]);
  insertBlocksAt(d, blocks[Math.max(0, Math.min(index ?? 0, blocks.length))] || sectPr(d), [p]);
  return { placed: "index", image_part: `word/media/${media}`, width_pt: cx / 12700, height_pt: cy / 12700 };
}
