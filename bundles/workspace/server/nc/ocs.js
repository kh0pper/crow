import { WsError } from "../result.js";
import { ncFetch, httpFail } from "./http.js";
import { parseMultistatus, propText } from "./multistatus.js";
import { NS } from "../ooxml/xml.js";
import { joinPath, principalUrl } from "./paths.js";

export async function ocsGet(cfg, path) {
  const r = await ncFetch(cfg, "GET", `${cfg.ncUrl}${path}${path.includes("?") ? "&" : "?"}format=json`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw httpFail(r, "ask Workspace");
  const j = await r.json(); return j?.ocs ? j.ocs.data : j;
}
export async function ocsPost(cfg, path, form) {
  const r = await ncFetch(cfg, "POST", `${cfg.ncUrl}${path}?format=json`, { headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const j = await r.json().catch(() => null);
  if (!r.ok || (j?.ocs?.meta && j.ocs.meta.status !== "ok")) throw new WsError("share_failed", j?.ocs?.meta?.message || `Workspace refused (HTTP ${r.status})`);
  return j.ocs.data;
}
const nameCache = new Map();
export async function displayName(cfg, uid) {
  if (nameCache.has(uid)) return nameCache.get(uid);
  const r = await ncFetch(cfg, "PROPFIND", principalUrl(cfg, uid), { headers: { Depth: "0", "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>` });
  const name = r.status === 207 ? (propText(parseMultistatus(await r.text())[0]?.props || new Map(), NS.d, "displayname") || uid) : uid;
  nameCache.set(uid, name); return name;
}
export const myShares = (cfg, segs) => ocsGet(cfg, `/ocs/v2.php/apps/files_sharing/api/v1/shares?path=${encodeURIComponent(`/${joinPath(segs)}`)}`);
export const createUserShare = (cfg, segs, user, permissions) => ocsPost(cfg, "/ocs/v2.php/apps/files_sharing/api/v1/shares", { path: `/${joinPath(segs)}`, shareType: "0", shareWith: user, permissions: String(permissions) });
