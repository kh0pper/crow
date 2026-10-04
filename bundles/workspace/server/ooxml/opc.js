import { WsError } from "../result.js";
import { NS, parseXml, kids, el, attr, removeNode } from "./xml.js";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL = Object.freeze({
  officeDocument: `${R}/officeDocument`, styles: `${R}/styles`, numbering: `${R}/numbering`, hyperlink: `${R}/hyperlink`, image: `${R}/image`,
  comments: `${R}/comments`, commentsExtended: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
  header: `${R}/header`, footer: `${R}/footer`, worksheet: `${R}/worksheet`, sharedStrings: `${R}/sharedStrings`, calcChain: `${R}/calcChain`,
  slide: `${R}/slide`, slideLayout: `${R}/slideLayout`, notesSlide: `${R}/notesSlide`, notesMaster: `${R}/notesMaster`, chart: `${R}/chart`,
  pivotCacheDefinition: `${R}/pivotCacheDefinition`, drawing: `${R}/drawing`,
});
const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

export function relsPath(part) { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; }
export function resolveTarget(fromPart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) { if (seg === "..") base.pop(); else if (seg && seg !== ".") base.push(seg); }
  return base.join("/");
}
function relsDoc(pkg, part, create) {
  const p = relsPath(part);
  if (!pkg.has(p)) { if (!create) return null; pkg.setXml(p, parseXml(EMPTY_RELS, p)); }
  return pkg.xml(p);
}
export function readRels(pkg, part) {
  const doc = relsDoc(pkg, part, false);
  return doc ? kids(doc.documentElement, NS.rel, "Relationship").map((e) => ({ id: e.getAttribute("Id"), type: e.getAttribute("Type"), target: e.getAttribute("Target"), external: e.getAttribute("TargetMode") === "External" })) : [];
}
export function addRel(pkg, part, type, target, external = false) {
  const doc = relsDoc(pkg, part, true);
  const ids = new Set(kids(doc.documentElement, NS.rel, "Relationship").map((e) => e.getAttribute("Id")));
  let n = ids.size + 1; while (ids.has(`rId${n}`)) n++;
  const id = `rId${n}`;
  doc.documentElement.appendChild(el(doc, NS.rel, "Relationship", { Id: id, Type: type, Target: target, TargetMode: external ? "External" : undefined }));
  pkg.markDirty(relsPath(part));
  return id;
}
export function removeRel(pkg, part, id) {
  const doc = relsDoc(pkg, part, false); if (!doc) return;
  for (const e of kids(doc.documentElement, NS.rel, "Relationship")) if (e.getAttribute("Id") === id) removeNode(e);
  pkg.markDirty(relsPath(part));
}
export function relTarget(pkg, part, id) { const r = readRels(pkg, part).find((x) => x.id === id); return r ? (r.external ? r.target : resolveTarget(part, r.target)) : null; }
export const partsOfType = (pkg, part, type) => readRels(pkg, part).filter((r) => r.type === type && !r.external).map((r) => resolveTarget(part, r.target)).filter((p) => pkg.has(p));
export function mainPart(pkg) {
  const r = readRels(pkg, "").find((x) => x.type === REL.officeDocument);
  if (!r) throw new WsError("malformed_document", "the office file has no main part");
  return resolveTarget("", r.target);
}
function types(pkg) { return pkg.xml("[Content_Types].xml"); }
export function ensureDefault(pkg, ext, ct) {
  const doc = types(pkg);
  if (kids(doc.documentElement, NS.ct, "Default").some((e) => e.getAttribute("Extension").toLowerCase() === ext.toLowerCase())) return;
  doc.documentElement.insertBefore(el(doc, NS.ct, "Default", { Extension: ext, ContentType: ct }), kids(doc.documentElement, NS.ct, "Override")[0] || null);
  pkg.markDirty("[Content_Types].xml");
}
export function setOverride(pkg, partName, ct) {
  const doc = types(pkg);
  const name = partName.startsWith("/") ? partName : `/${partName}`;
  const ex = kids(doc.documentElement, NS.ct, "Override").find((e) => e.getAttribute("PartName") === name);
  if (ex) ex.setAttribute("ContentType", ct); else doc.documentElement.appendChild(el(doc, NS.ct, "Override", { PartName: name, ContentType: ct }));
  pkg.markDirty("[Content_Types].xml");
}
export function removeOverride(pkg, partName) {
  const doc = types(pkg); const name = partName.startsWith("/") ? partName : `/${partName}`;
  for (const e of kids(doc.documentElement, NS.ct, "Override")) if (e.getAttribute("PartName") === name) removeNode(e);
  pkg.markDirty("[Content_Types].xml");
}
export { attr };
