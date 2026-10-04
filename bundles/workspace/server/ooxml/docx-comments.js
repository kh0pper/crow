/**
 * In-file .docx comments (spec §4.4): the comments ONLYOFFICE shows in its comment pane, not Nextcloud's sidebar.
 * - word/comments.xml holds every w:comment (root comments and replies alike);
 * - the body anchors a comment with w:commentRangeStart/End plus a run holding w:commentReference;
 * - threads and resolved state live in word/commentsExtended.xml: w15:commentEx keyed by the w14:paraId of the
 *   comment's LAST paragraph, with paraIdParent (a reply) and done="1" (resolved, set on the thread root);
 * - when the file has word/commentsIds.xml (Word, ONLYOFFICE) or word/commentsExtensible.xml, every new comment
 *   gets its row there too, so all the threading parts keep describing the same set of comments.
 * Every function mutates the opened package `d` and marks what it touched; the caller saves once (one version).
 */
import { randomBytes } from "node:crypto";
import { WsError } from "../result.js";
import { NS, kids, all, attr, el, parseXml, insertAfter, removeNode } from "./xml.js";
import { RUN_CONTAINERS, SEP, textMap, makeRun } from "./docx-model.js";
import { isolate, spliceText, isPlainTextParagraph } from "./docx-edit.js";
import { addRel, partsOfType, setOverride, REL } from "./opc.js";
import { scanMap, normalizeSegs, SEP as SEP_CHAR } from "./text-find.js";

const W = NS.w, W14 = NS.w14, W15 = NS.w15, W16CID = NS.w16cid, W16CEX = NS.w16cex;
const AUTHOR = "Crow bot", INITIALS = "CB";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml";

const isW = (n, local) => n && n.nodeType === 1 && n.namespaceURI === W && n.localName === local;
/** Relationship target for a new part in word/: relative when the main part sits in word/, else absolute. */
const targetFor = (d, name) => (/^word\/[^/]+$/.test(d.part) ? name : `/word/${name}`);

/** The part related to the main part by `rel`, created (root element `rootXml`) when asked. */
function relPart(d, rel, create, name, rootXml, contentType) {
  const part = partsOfType(d.pkg, d.part, rel)[0];
  if (part) return { part, doc: d.pkg.xml(part) };
  if (!create) return null;
  const p = `word/${name}`;
  d.pkg.setXml(p, parseXml(XML_DECL + rootXml, p));
  addRel(d.pkg, d.part, rel, targetFor(d, name));
  setOverride(d.pkg, p, contentType);
  return { part: p, doc: d.pkg.xml(p) };
}
const commentsPart = (d, create) => relPart(d, REL.comments, create, "comments.xml", `<w:comments xmlns:w="${W}" xmlns:w14="${W14}"/>`, `${CT}.comments+xml`);
const extPart = (d, create) => relPart(d, REL.commentsExtended, create, "commentsExtended.xml", `<w15:commentsEx xmlns:w15="${W15}"/>`, `${CT}.commentsExtended+xml`);
// optional newer parts: only kept in step when the file already has them (never created)
const idsPart = (d) => relPart(d, REL.commentsIds, false);
const cexPart = (d) => relPart(d, REL.commentsExtensible, false);

const lastPara = (c) => kids(c, W, "p").at(-1) || null;
const paraIdOf = (c) => attr(lastPara(c), W14, "paraId");
const commentText = (c) => kids(c, W, "p").map((p) => all(p, W, "t").map((t) => t.textContent).join("")).join("\n");
const exRows = (ex) => (ex ? kids(ex.doc.documentElement, W15, "commentEx") : []);

/** comment id → the text between its range anchors (paragraph breaks as "\n"). */
function quotedTexts(d) {
  const open = new Map(); const out = new Map();
  const walk = (n) => {
    for (const c of kids(n)) {
      if (isW(c, "commentRangeStart")) open.set(attr(c, W, "id"), "");
      else if (isW(c, "commentRangeEnd")) { const id = attr(c, W, "id"); if (open.has(id)) { out.set(id, open.get(id)); open.delete(id); } }
      else if (isW(c, "t")) { for (const k of open.keys()) open.set(k, open.get(k) + c.textContent); }
      else if (isW(c, "p")) { walk(c); for (const k of open.keys()) open.set(k, `${open.get(k)}\n`); }
      else walk(c);
    }
  };
  walk(d.body);
  for (const [k, v] of out) out.set(k, v.replace(/\n+$/, ""));
  return out;
}

export function listComments(d, includeResolved = false) {
  const cd = commentsPart(d, false); if (!cd) return [];
  const exBy = new Map(exRows(extPart(d, false)).map((e) => [attr(e, W15, "paraId"), e]));
  const quotes = quotedTexts(d);
  const rows = kids(cd.doc.documentElement, W, "comment").map((c) => {
    const id = attr(c, W, "id"); const pid = paraIdOf(c); const e = pid ? exBy.get(pid) : null;
    return { id, author: attr(c, W, "author"), date: attr(c, W, "date") || null, content: commentText(c), quoted_text: quotes.get(id) ?? "", paraId: pid, parent: e ? attr(e, W15, "paraIdParent") : "", done: e ? attr(e, W15, "done") === "1" : false };
  });
  // replies hang off their thread root (a reply to a reply is followed up the chain); a reply whose parent is
  // missing from the file is shown as its own thread rather than lost
  const byPid = new Map(rows.filter((r) => r.paraId).map((r) => [r.paraId, r]));
  const rootOf = (r) => { const seen = new Set(); let x = r; while (x.parent && byPid.has(x.parent) && !seen.has(x)) { seen.add(x); x = byPid.get(x.parent); } return x; };
  const roots = rows.filter((r) => rootOf(r) === r);
  return roots.map((r) => ({ id: r.id, author: r.author, date: r.date, content: r.content, quoted_text: r.quoted_text, resolved: r.done, replies: rows.filter((x) => x !== r && rootOf(x) === r).map(({ id, author, date, content }) => ({ id, author, date, content })) }))
    .filter((c) => includeResolved || !c.resolved);
}

/** 8 hex digits below 0x80000000, as Word requires for paraId/textId/durableId. */
const hexId = (taken) => { for (;;) { const v = (randomBytes(4).readUInt32BE(0) & 0x7fffffff) || 1; const s = v.toString(16).toUpperCase().padStart(8, "0"); if (!taken.has(s)) { taken.add(s); return s; } } };
function takenParaIds(d) {
  const taken = new Set();
  const cd = commentsPart(d, false);
  for (const doc of [d.doc, cd?.doc].filter(Boolean)) for (const p of all(doc, W, "p")) { const v = attr(p, W14, "paraId"); if (v) taken.add(v.toUpperCase()); }
  return taken;
}
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Rows for paraId `pid` in commentsIds / commentsExtensible, when the file keeps those parts. */
function addDurableRows(d, pid, date) {
  const ids = idsPart(d); const cex = cexPart(d);
  if (!ids && !cex) return;
  const taken = new Set([...(ids ? kids(ids.doc.documentElement, W16CID, "commentId").map((e) => attr(e, W16CID, "durableId")) : []), ...(cex ? kids(cex.doc.documentElement, W16CEX, "commentExtensible").map((e) => attr(e, W16CEX, "durableId")) : [])]);
  const durable = hexId(taken);
  if (ids) { ids.doc.documentElement.appendChild(el(ids.doc, W16CID, "w16cid:commentId", { "w16cid:paraId": pid, "w16cid:durableId": durable })); d.pkg.markDirty(ids.part); }
  if (cex) { cex.doc.documentElement.appendChild(el(cex.doc, W16CEX, "w16cex:commentExtensible", { "w16cex:durableId": durable, "w16cex:dateUtc": date })); d.pkg.markDirty(cex.part); }
}

function newComment(d, content) {
  const cd = commentsPart(d, true); const doc = cd.doc;
  const used = [...kids(doc.documentElement, W, "comment").map((c) => attr(c, W, "id")), ...["commentRangeStart", "commentRangeEnd", "commentReference"].flatMap((n) => all(d.body, W, n).map((x) => attr(x, W, "id")))];
  const id = String(Math.max(-1, ...used.map(Number).filter(Number.isFinite)) + 1);
  const taken = takenParaIds(d);
  const lines = String(content).normalize("NFC").split("\n");
  const paras = lines.map((line) => el(doc, W, "w:p", { "w14:paraId": hexId(taken), "w14:textId": hexId(taken) }, [makeRun(doc, line, null)]));
  const date = now();
  doc.documentElement.appendChild(el(doc, W, "w:comment", { "w:id": id, "w:author": AUTHOR, "w:date": date, "w:initials": INITIALS }, paras));
  d.pkg.markDirty(cd.part);
  const pid = attr(paras.at(-1), W14, "paraId");
  addDurableRows(d, pid, date);
  return { id, pid };
}

/** Set paraIdParent / done on the commentEx row of `pid` (row created when missing). */
function setEx(d, pid, { parent, done }) {
  const ex = extPart(d, true);
  let e = exRows(ex).find((x) => attr(x, W15, "paraId") === pid);
  if (!e) { e = el(ex.doc, W15, "w15:commentEx", { "w15:paraId": pid }); ex.doc.documentElement.appendChild(e); }
  if (parent !== undefined) e.setAttributeNS(W15, "w15:paraIdParent", parent);
  if (done !== undefined) e.setAttributeNS(W15, "w15:done", done ? "1" : "0");
  d.pkg.markDirty(ex.part);
}

const refRun = (doc, id) => el(doc, W, "w:r", {}, [el(doc, W, "w:commentReference", { "w:id": id })]);
const marker = (d, local, id) => all(d.body, W, local).find((x) => attr(x, W, "id") === String(id)) || null;
/** The run holding w:commentReference for `id`. */
const refRunOf = (d, id) => { const r = marker(d, "commentReference", id); return r && isW(r.parentNode, "r") ? r.parentNode : null; };

export function addComment(d, content, quotedText) {
  const doc = d.doc;
  let first, last;
  if (quotedText) {
    const needle = String(quotedText).normalize("NFC");
    for (const p of all(d.body, W, "p")) {
      const s = scanMap(textMap(p), needle, true); if (!s.hits.length) continue;
      if (!s.normalized) normalizeSegs(textMap(p).segs); // only the paragraph that is anchored is touched
      const runs = isolate(p, s.hits[0], s.hits[0] + needle.length); first = runs[0]; last = runs.at(-1); break;
    }
    if (!first) throw new WsError("not_found", `quoted_text "${quotedText}" was not found in the document body (a quote cannot cross a tab or line break)`);
  } else {
    const p = kids(d.body, W, "p")[0]; if (!p) throw new WsError("bad_args", "the document has no body paragraph to attach a comment to");
    const inner = kids(p).filter((c) => !isW(c, "pPr")); first = inner[0] || null; last = inner.at(-1) || null;
    if (!first) { const r = makeRun(doc, "", null); p.appendChild(r); first = last = r; }
  }
  const { id, pid } = newComment(d, content);
  first.parentNode.insertBefore(el(doc, W, "w:commentRangeStart", { "w:id": id }), first);
  const end = el(doc, W, "w:commentRangeEnd", { "w:id": id }); insertAfter(end, last); insertAfter(refRun(doc, id), end);
  setEx(d, pid, { done: false }); d.pkg.markDirty(d.part);
  return { comment_id: id };
}

/** The comment `id` with the paraId of its last paragraph (one is given to a comment that has none). */
function findComment(d, id) {
  const cd = commentsPart(d, false);
  const c = cd && kids(cd.doc.documentElement, W, "comment").find((x) => attr(x, W, "id") === String(id));
  if (!c) throw new WsError("comment_not_found", `No comment ${id} in this document (ws_docs_list_comments lists them).`);
  let pid = paraIdOf(c);
  if (!pid) {
    let p = lastPara(c); if (!p) { p = el(cd.doc, W, "w:p"); c.appendChild(p); }
    pid = hexId(takenParaIds(d)); p.setAttributeNS(W14, "w14:paraId", pid); d.pkg.markDirty(cd.part);
    addDurableRows(d, pid, attr(c, W, "date") || now());
  }
  const e = exRows(extPart(d, false)).find((x) => attr(x, W15, "paraId") === pid);
  return { c, pid, done: e ? attr(e, W15, "done") === "1" : false, parent: e ? attr(e, W15, "paraIdParent") : "" };
}

export function replyComment(d, id, content) {
  const root = findComment(d, id);
  if (root.parent) throw new WsError("bad_args", `Comment ${id} is itself a reply; reply to the thread's first comment.`);
  const r = newComment(d, content);
  // the reply shares the root's range and has its own reference mark (as Word and ONLYOFFICE write it)
  const s = marker(d, "commentRangeStart", id), e = marker(d, "commentRangeEnd", id), ref = refRunOf(d, id);
  if (s && e) {
    insertAfter(el(d.doc, W, "w:commentRangeStart", { "w:id": r.id }), s);
    const ne = el(d.doc, W, "w:commentRangeEnd", { "w:id": r.id }); insertAfter(ne, ref && ref.previousSibling === e ? ref : e);
    insertAfter(refRun(d.doc, r.id), ne);
  } else if (ref) insertAfter(refRun(d.doc, r.id), ref);
  d.pkg.markDirty(d.part);
  setEx(d, r.pid, { parent: root.pid, done: false });
  return { comment_id: r.id };
}

export function resolveComment(d, id) {
  const root = findComment(d, id);
  if (root.parent) throw new WsError("bad_args", `Comment ${id} is a reply; resolve the thread's first comment.`);
  if (root.done) return { resolved: true, already_resolved: true };
  setEx(d, root.pid, { done: true });
  return { resolved: true };
}

/** Text offsets (in docx-model textMap terms) of comment `id`'s anchors inside paragraph p. */
function anchorOffsets(p, id) {
  let len = 0, s = null, e = null;
  const walk = (n) => {
    for (const c of kids(n, W)) {
      if (c.localName === "commentRangeStart" && attr(c, W, "id") === id) s = len;
      else if (c.localName === "commentRangeEnd" && attr(c, W, "id") === id) e = len;
      else if (c.localName === "r") { for (const k of kids(c, W)) { if (k.localName === "t") len += k.textContent.length; else if (SEP.has(k.localName)) len += 1; } }
      else if (RUN_CONTAINERS.has(c.localName)) walk(c);
    }
  };
  walk(p); return { s, e };
}
const paragraphOf = (n) => { while (n && !isW(n, "p")) n = n.parentNode; return n; };

const NO_ANCHOR = "Crow could not find the highlighted text for this comment (it was removed, is empty, or spans paragraphs), so nothing was changed. Highlight the text again within one paragraph and ask again.";
const CROSSES_BREAK = "The highlighted text includes a tab, line break, image or field, so Crow left it unchanged. Highlight just the words to change and ask again.";

/**
 * Replace ONLY the comment's anchored text, reply with `summary`, resolve. Refused (not_plain_text, nothing written)
 * when the anchored paragraph holds links, fields, tracked changes, images or other non-text content. Without a
 * usable anchor it replies with the reason and leaves the thread unresolved.
 */
export function applyCommentEdit(d, id, replaceText, summary) {
  const root = findComment(d, id);
  if (root.parent) throw new WsError("bad_args", `Comment ${id} is a reply; use the thread's first comment.`);
  if (root.done) throw new WsError("already_resolved", `Comment ${id} is already resolved.`);
  const repl = String(replaceText).normalize("NFC");
  if (/[\t\r\n]/.test(repl)) throw new WsError("bad_args", "replace_text must be plain text without tabs or line breaks");
  const startEl = marker(d, "commentRangeStart", id);
  const p = startEl ? paragraphOf(startEl) : null;
  const off = p ? anchorOffsets(p, String(id)) : { s: null, e: null };
  if (!p || off.s === null || off.e === null || off.e <= off.s) {
    replyComment(d, id, NO_ANCHOR);
    return { applied: false, reason: "no_anchor", left_unresolved: true };
  }
  if (!isPlainTextParagraph(p)) throw new WsError("not_plain_text", "the commented paragraph holds a link, field, image, tracked change or note reference; Crow will not rewrite it. Edit it with ws_docs_find_replace instead.");
  const map = textMap(p);
  if (map.text.slice(off.s, off.e).includes(SEP_CHAR)) {
    replyComment(d, id, CROSSES_BREAK);
    return { applied: false, reason: "crosses_break", left_unresolved: true };
  }
  spliceText(map.segs, off.s, off.e, repl);
  d.pkg.markDirty(d.part);
  replyComment(d, id, summary); resolveComment(d, id);
  return { applied: true };
}

/**
 * Exact inverse of add_comment (ws__docs_delete_comment): removes comment `id` from comments.xml, its range markers,
 * its reference run, its commentEx row and its commentsIds / commentsExtensible rows. Refused (target_changed) when
 * the thread has replies (someone answered it) or, with `content`, when its text is no longer what Crow wrote.
 */
export function deleteComment(d, id, { content } = {}) {
  const cd = commentsPart(d, false);
  const c = cd && kids(cd.doc.documentElement, W, "comment").find((x) => attr(x, W, "id") === String(id));
  if (!c) throw new WsError("target_changed", `comment ${id} is no longer in the document`);
  if (content !== undefined && content !== null && commentText(c).normalize("NFC") !== String(content).normalize("NFC")) throw new WsError("target_changed", `comment ${id} was edited since`);
  const pid = paraIdOf(c); const ex = extPart(d, false);
  if (pid && exRows(ex).some((e) => attr(e, W15, "paraIdParent") === pid)) throw new WsError("target_changed", `comment ${id} has replies now; it was not removed`);
  removeNode(c); d.pkg.markDirty(cd.part);
  for (const local of ["commentRangeStart", "commentRangeEnd"]) for (const m of all(d.body, W, local).filter((x) => attr(x, W, "id") === String(id))) removeNode(m);
  for (const ref of all(d.body, W, "commentReference").filter((x) => attr(x, W, "id") === String(id))) {
    const run = ref.parentNode;
    if (isW(run, "r") && kids(run).every((k) => k === ref || isW(k, "rPr"))) removeNode(run); else removeNode(ref);
  }
  d.pkg.markDirty(d.part);
  if (pid) {
    const row = exRows(ex).find((e) => attr(e, W15, "paraId") === pid);
    if (row) { removeNode(row); d.pkg.markDirty(ex.part); }
    const ids = idsPart(d); const cex = cexPart(d);
    const idRows = ids ? kids(ids.doc.documentElement, W16CID, "commentId").filter((e) => attr(e, W16CID, "paraId") === pid) : [];
    const durable = new Set(idRows.map((e) => attr(e, W16CID, "durableId")));
    if (idRows.length) { idRows.forEach(removeNode); d.pkg.markDirty(ids.part); }
    const cexRows = cex ? kids(cex.doc.documentElement, W16CEX, "commentExtensible").filter((e) => durable.has(attr(e, W16CEX, "durableId"))) : [];
    if (cexRows.length) { cexRows.forEach(removeNode); d.pkg.markDirty(cex.part); }
  }
  return { deleted: String(id) };
}
