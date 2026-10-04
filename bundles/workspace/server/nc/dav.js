import { WsError } from "../result.js";
import { NS, xmlEscape, kid } from "../ooxml/xml.js";
import { splitPath, joinPath, filesUrl, hrefToSegs } from "./paths.js";
import { ncFetch, readCapped, httpFail } from "./http.js";
import { parseMultistatus, propText } from "./multistatus.js";

const PROPS = "<d:getetag/><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><oc:fileid/><oc:permissions/><oc:owner-id/><oc:owner-display-name/><nc:lock/><nc:lock-owner-type/><nc:lock-owner/><nc:lock-owner-displayname/><nc:lock-time/>";
const PROPFIND = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop>${PROPS}</d:prop></d:propfind>`;
export const normEtag = (e) => String(e || "").replace(/^W\//, "").replace(/^"|"$/g, "").replace(/&quot;/g, "");

function toEntry(cfg, r) {
  const segs = hrefToSegs(cfg, r.href);
  const t = (ns, l) => propText(r.props, ns, l);
  const isFolder = !!kid(r.props.get(`${NS.d}|resourcetype`), NS.d, "collection");
  const lm = t(NS.d, "getlastmodified");
  const lock = ["1", "true"].includes(String(t(NS.nc, "lock") || "").trim());
  return {
    path: joinPath(segs), name: segs.at(-1) || "", isFolder, fileId: Number(t(NS.oc, "fileid")),
    etag: normEtag(t(NS.d, "getetag")), mtime: lm ? Math.floor(Date.parse(lm) / 1000) : 0, modified: lm ? new Date(lm).toISOString() : null,
    size: Number(t(NS.d, "getcontentlength") || 0), mime: t(NS.d, "getcontenttype") || (isFolder ? "inode/directory" : "application/octet-stream"),
    permissions: t(NS.oc, "permissions") || "", ownerId: t(NS.oc, "owner-id") || "", ownerName: t(NS.oc, "owner-display-name") || "",
    lock, lockType: lock ? Number(t(NS.nc, "lock-owner-type") ?? -1) : null, lockOwner: lock ? t(NS.nc, "lock-owner") : null,
    lockOwnerName: lock ? t(NS.nc, "lock-owner-displayname") : null, lockTime: lock ? Number(t(NS.nc, "lock-time") || 0) : null,
  };
}

async function propfind(cfg, segs, depth) {
  const res = await ncFetch(cfg, "PROPFIND", filesUrl(cfg, segs) + (depth ? "/" : ""), { headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" }, body: PROPFIND });
  if (res.status === 404) throw new WsError("not_found", `Nothing named "${joinPath(segs)}" in Crow's Workspace drive (it may not be shared with Crow bot).`);
  if (res.status !== 207) throw httpFail(res, "read the folder");
  const entries = parseMultistatus(await res.text()).map((r) => toEntry(cfg, r));
  if (!entries.length) throw new WsError("not_found", `Nothing named "${joinPath(segs)}" in Crow's Workspace drive (it may not be shared with Crow bot).`);
  return entries;
}

export async function resolveRef(cfg, ref = {}) {
  if (ref.file_id !== undefined && ref.file_id !== null) {
    if (!Number.isInteger(ref.file_id) || ref.file_id <= 0) throw new WsError("bad_ref", "file_id must be a positive whole number");
    const hits = await search(cfg, `<d:eq><d:prop><oc:fileid/></d:prop><d:literal>${ref.file_id}</d:literal></d:eq>`, [], 1);
    if (!hits.length) throw new WsError("not_found", `No file with id ${ref.file_id} is shared with Crow bot`);
    return splitPath(hits[0].path);
  }
  if (typeof ref.path !== "string") throw new WsError("bad_ref", "give a path (or file_id)");
  return splitPath(ref.path);
}

export async function stat(cfg, ref) { return (await propfind(cfg, Array.isArray(ref) ? ref : await resolveRef(cfg, ref), 0))[0]; }
export async function list(cfg, segs) { const [self, ...children] = await propfind(cfg, segs, 1); if (!self.isFolder) throw new WsError("not_a_folder", `"${self.path}" is a file, not a folder`); return children; }

export async function getFile(cfg, segs, { maxBytes }) {
  const res = await ncFetch(cfg, "GET", filesUrl(cfg, segs), { timeoutMs: 120000 });
  if (!res.ok) throw httpFail(res, "read the file");
  const bytes = await readCapped(res, maxBytes);
  const lm = res.headers.get("last-modified");
  return { bytes, etag: normEtag(res.headers.get("etag")), mtime: lm ? Math.floor(Date.parse(lm) / 1000) : 0 };
}

export function putFile(cfg, segs, bytes, { ifMatch, ifNoneMatch, contentType } = {}) {
  const headers = { "Content-Type": contentType || "application/octet-stream" };
  if (ifMatch) headers["If-Match"] = `"${normEtag(ifMatch)}"`;
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return ncFetch(cfg, "PUT", filesUrl(cfg, segs), { headers, body: bytes, timeoutMs: 120000 });
}

export async function mkcol(cfg, segs) { const r = await ncFetch(cfg, "MKCOL", filesUrl(cfg, segs)); if (r.status === 405) return false; if (r.status !== 201) throw httpFail(r, "create the folder"); return true; }
async function moveOrCopy(cfg, method, from, to) {
  const r = await ncFetch(cfg, method, filesUrl(cfg, from), { headers: { Destination: filesUrl(cfg, to), Overwrite: "F" } });
  if (r.status === 412) throw new WsError("exists", `"${joinPath(to)}" already exists`);
  if (![201, 204].includes(r.status)) throw httpFail(r, method === "MOVE" ? "move it" : "copy it");
}
export const move = (cfg, from, to) => moveOrCopy(cfg, "MOVE", from, to);
export const copy = (cfg, from, to) => moveOrCopy(cfg, "COPY", from, to);
export async function remove(cfg, segs) { const r = await ncFetch(cfg, "DELETE", filesUrl(cfg, segs)); if (r.status !== 204) throw httpFail(r, "move it to the trash"); }

async function search(cfg, where, scopeSegs, limit, foldersOnly = false) {
  // Sabre URL-decodes the scope href: encode each segment (a name with "%" or "#" must survive), then XML-escape.
  const scope = `/files/${encodeURIComponent(cfg.user)}${scopeSegs.length ? `/${scopeSegs.map((x) => xmlEscape(encodeURIComponent(x))).join("/")}` : ""}`;
  const w = foldersOnly ? `<d:and>${where}<d:is-collection/></d:and>` : where;
  const body = `<?xml version="1.0" encoding="UTF-8"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:basicsearch><d:select><d:prop>${PROPS}</d:prop></d:select><d:from><d:scope><d:href>${scope}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where>${w}</d:where><d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby><d:limit><d:nresults>${limit}</d:nresults></d:limit></d:basicsearch></d:searchrequest>`;
  const res = await ncFetch(cfg, "SEARCH", `${cfg.ncUrl}/remote.php/dav/`, { headers: { "Content-Type": "text/xml; charset=utf-8" }, body });
  if (res.status !== 207) throw httpFail(res, "search");
  return parseMultistatus(await res.text()).map((r) => toEntry(cfg, r)).filter((e) => e.path);
}

export function searchNames(cfg, { scopeSegs = [], like, eq, foldersOnly = false, limit = 20 }) {
  if (like !== undefined) {
    const lit = xmlEscape(String(like).normalize("NFC").replace(/[\\%_]/g, (c) => `\\${c}`));
    return search(cfg, `<d:like><d:prop><d:displayname/></d:prop><d:literal>%${lit}%</d:literal></d:like>`, scopeSegs, limit, foldersOnly);
  }
  return search(cfg, `<d:eq><d:prop><d:displayname/></d:prop><d:literal>${xmlEscape(String(eq).normalize("NFC"))}</d:literal></d:eq>`, scopeSegs, limit, foldersOnly);
}
