/** XML helpers for DAV responses and OOXML parts. xmldom, no entity expansion, DOCTYPE refused. */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { WsError } from "../result.js";

export const NS = Object.freeze({
  d: "DAV:", oc: "http://owncloud.org/ns", nc: "http://nextcloud.org/ns", cal: "urn:ietf:params:xml:ns:caldav", card: "urn:ietf:params:xml:ns:carddav",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main", r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main", p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  s: "http://schemas.openxmlformats.org/spreadsheetml/2006/main", rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types", wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture", c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml", w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  w16cid: "http://schemas.microsoft.com/office/word/2016/wordml/cid", w16cex: "http://schemas.microsoft.com/office/word/2018/wordml/cex",
  xml: "http://www.w3.org/XML/1998/namespace",
});

export function parseXml(text, name = "xml") {
  if (/<!DOCTYPE/i.test(text)) throw new WsError("malformed_document", `${name}: DOCTYPE declarations are not allowed`);
  let doc;
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== "warning") throw new Error(msg); } }).parseFromString(text, "application/xml");
  } catch { throw new WsError("malformed_document", `${name}: not well-formed XML`); }
  if (!doc?.documentElement) throw new WsError("malformed_document", `${name}: empty XML`);
  doc.__decl = (text.match(/^\s*<\?xml[^?]*\?>/) || [""])[0].trim();
  return doc;
}

/** Serialize, keeping the original XML declaration (xmldom may drop it). */
export function serializeXml(doc) {
  let s = new XMLSerializer().serializeToString(doc);
  if (doc.__decl && !s.startsWith("<?xml")) s = `${doc.__decl}\r\n${s}`;
  return s;
}

export const isEl = (n, ns, local) => n && n.nodeType === 1 && (!ns || n.namespaceURI === ns) && (!local || n.localName === local);
export const kids = (node, ns, local) => Array.from(node?.childNodes || []).filter((n) => isEl(n, ns, local));
export const kid = (node, ns, local) => kids(node, ns, local)[0] || null;
export const all = (node, ns, local) => Array.from(node.getElementsByTagNameNS(ns, local));
export const attr = (node, ns, local) => (node ? (ns ? node.getAttributeNS(ns, local) : node.getAttribute(local)) : "") || "";

/** Create an element; attrs keys may be "w:val" style (namespace from NS by prefix) or plain. */
export function el(doc, ns, qname, attrs = {}, children = []) {
  const e = doc.createElementNS(ns, qname);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    const i = k.indexOf(":");
    if (i > 0) e.setAttributeNS(NS[k.slice(0, i)], k, String(v)); else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  return e;
}

export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
export function insertAfter(node, ref) { ref.parentNode.insertBefore(node, ref.nextSibling); }
export function removeNode(n) { n?.parentNode?.removeChild(n); }
