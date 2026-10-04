/** The ONLY place a Nextcloud files URL is built (spec §7.1). */
import { WsError } from "../result.js";
const BAD = /[\u0000-\u001f\u007f\\]/;

export function splitPath(p) {
  if (typeof p !== "string") throw new WsError("bad_path", "path must be text");
  const s = p.normalize("NFC");
  if (s.length > 4096) throw new WsError("bad_path", "path is too long");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(file|data|javascript|mailto):/i.test(s)) throw new WsError("bad_path", "use a path inside Crow's Workspace drive, not a URL"); // "Notas: casa/x.docx" is a fine name
  const body = s.replace(/^\//, "").replace(/\/$/, "");
  if (!body) throw new WsError("bad_path", "path is empty; use \"\" only where a folder may be the drive root");
  const segs = body.split("/");
  assertSegs(segs);
  return segs;
}

/** The one segment rule: used by splitPath, hrefToSegs and filesUrl, so no URL can ever hop to a parent. */
function assertSegs(segs) {
  for (const seg of segs) {
    if (typeof seg !== "string" || seg === "" || seg === "." || seg === "..") throw new WsError("bad_path", "path segments cannot be empty, '.' or '..'");
    if (seg.includes("/") || BAD.test(seg)) throw new WsError("bad_path", "path contains a slash, control character or backslash inside a name");
    if (Buffer.byteLength(seg) > 255) throw new WsError("bad_path", "a name in the path is longer than 255 bytes");
  }
}

/** Folder params may be "" (drive root). */
export const splitFolder = (p) => (p === undefined || p === null || p === "" || p === "/" ? [] : splitPath(p));
export const joinPath = (segs) => segs.join("/");
export const filesRoot = (cfg) => `${cfg.ncUrl}/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
export function filesUrl(cfg, segs) {
  assertSegs(segs);
  return segs.length ? `${filesRoot(cfg)}/${segs.map((s) => encodeURIComponent(s)).join("/")}` : filesRoot(cfg);
}

export function hrefToSegs(cfg, href) {
  const prefix = `/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) throw new WsError("bad_path", "the server answered with a path outside Crow's drive");
  let segs;
  try { segs = path.slice(prefix.length).split("/").filter(Boolean).map((s) => decodeURIComponent(s).normalize("NFC")); }
  catch { throw new WsError("bad_path", "the server answered with a malformed path"); }
  assertSegs(segs);
  return segs;
}

// ---------- CalDAV / CardDAV (Task 10) ----------
// Hrefs here are server-relative paths ("/remote.php/dav/…"). Every href that arrives from a server response or
// from the undo journal goes through pimHrefToSegs + pimHref, so a hostile or confused answer (an encoded "..",
// an encoded slash, another user's home, the files tree) can never become a request URL.
const PIM_ROOTS = Object.freeze({ cal: "calendars", card: "addressbooks/users" });
export function pimHome(cfg, kind) {
  if (!Object.hasOwn(PIM_ROOTS, kind)) throw new WsError("bad_path", "unknown collection kind");
  return `/remote.php/dav/${PIM_ROOTS[kind]}/${encodeURIComponent(cfg.user)}/`;
}
/** [collectionId] → collection href (trailing slash); [collectionId, objectName] → object href. */
export function pimHref(cfg, kind, segs) {
  if (!Array.isArray(segs) || segs.length < 1 || segs.length > 2) throw new WsError("bad_path", "a calendar/contact path has one or two parts");
  assertSegs(segs);
  return `${pimHome(cfg, kind)}${encodeURIComponent(segs[0])}/${segs.length === 2 ? encodeURIComponent(segs[1]) : ""}`;
}
/** Server/journal href → validated segments ([] = the home itself). Throws bad_path for anything outside the home. */
export function pimHrefToSegs(cfg, kind, href) {
  const homeP = pimHome(cfg, kind);
  let path;
  try { path = /^https?:\/\//i.test(String(href)) ? new URL(href).pathname : String(href); }
  catch { throw new WsError("bad_path", "the server answered with a malformed path"); }
  if (!path.startsWith(homeP)) throw new WsError("bad_path", "the server answered with a path outside Crow bot's calendars/address books");
  const rest = path.slice(homeP.length).replace(/\/$/, "");
  if (!rest) return [];
  let segs;
  try { segs = rest.split("/").map((s) => decodeURIComponent(s)); }
  catch { throw new WsError("bad_path", "the server answered with a malformed path"); }
  if (segs.length > 2) throw new WsError("bad_path", "the server answered with a path nested too deep");
  assertSegs(segs);
  return segs;
}
/** The kind ("cal" | "card") whose home contains href, or null. */
export const pimKindOf = (cfg, href) => Object.keys(PIM_ROOTS).find((k) => { try { return String(href).startsWith(pimHome(cfg, k)); } catch { return false; } }) || null;
/** Request URLs: always rebuilt from validated segments. */
export const pimHomeUrl = (cfg, kind) => `${cfg.ncUrl}${pimHome(cfg, kind)}`;
export function pimCollectionUrl(cfg, kind, href) {
  const segs = pimHrefToSegs(cfg, kind, href);
  if (segs.length !== 1) throw new WsError("bad_path", "expected a calendar or address book");
  return `${cfg.ncUrl}${pimHref(cfg, kind, segs)}`;
}
export function pimObjectUrl(cfg, href) {
  const kind = pimKindOf(cfg, href); if (!kind) throw new WsError("bad_path", "not a calendar or contact path");
  const segs = pimHrefToSegs(cfg, kind, href);
  if (segs.length !== 2) throw new WsError("bad_path", "expected an event or contact");
  return `${cfg.ncUrl}${pimHref(cfg, kind, segs)}`;
}
export function principalUrl(cfg, uid) { assertSegs([uid]); return `${cfg.ncUrl}/remote.php/dav/principals/users/${encodeURIComponent(uid)}/`; }
