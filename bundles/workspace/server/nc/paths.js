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
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") throw new WsError("bad_path", "path segments cannot be empty, '.' or '..'");
    if (BAD.test(seg)) throw new WsError("bad_path", "path contains a control character or backslash");
    if (Buffer.byteLength(seg) > 255) throw new WsError("bad_path", "a name in the path is longer than 255 bytes");
  }
  return segs;
}

/** Folder params may be "" (drive root). */
export const splitFolder = (p) => (p === undefined || p === null || p === "" || p === "/" ? [] : splitPath(p));
export const joinPath = (segs) => segs.join("/");
export const filesRoot = (cfg) => `${cfg.ncUrl}/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
export const filesUrl = (cfg, segs) => `${filesRoot(cfg)}/${segs.map((s) => encodeURIComponent(s)).join("/")}`;

export function hrefToSegs(cfg, href) {
  const prefix = `/remote.php/dav/files/${encodeURIComponent(cfg.user)}`;
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) throw new WsError("bad_path", "the server answered with a path outside Crow's drive");
  return path.slice(prefix.length).split("/").filter(Boolean).map((s) => decodeURIComponent(s).normalize("NFC"));
}
