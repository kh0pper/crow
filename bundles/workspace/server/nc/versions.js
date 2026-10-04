import { WsError } from "../result.js";
import { NS, xmlEscape } from "../ooxml/xml.js";
import { ncFetch, httpFail } from "./http.js";
import { parseMultistatus, propText } from "./multistatus.js";

const base = (cfg, fileId) => `${cfg.ncUrl}/remote.php/dav/versions/${encodeURIComponent(cfg.user)}/versions/${Number(fileId)}`;
const vid = (s) => { if (!/^\d{1,12}$/.test(String(s))) throw new WsError("bad_version_id", "not a Workspace version id"); return String(s); };

/** Versions of a file, newest id first (Nextcloud 34 lists the current file too; id = mtime seconds). */
export async function listVersions(cfg, fileId) {
  const r = await ncFetch(cfg, "PROPFIND", `${base(cfg, fileId)}/`, { headers: { Depth: "1", "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getlastmodified/><d:getcontentlength/><nc:version-label/><nc:version-author/></d:prop></d:propfind>` });
  if (r.status !== 207) throw httpFail(r, "list versions");
  return parseMultistatus(await r.text())
    .map((x) => ({ versionId: (x.href.match(/\/versions\/\d+\/(\d+)\/?$/) || [])[1], props: x.props }))
    .filter((x) => x.versionId)
    .map(({ versionId, props }) => ({ versionId, modified: new Date(Number(versionId) * 1000).toISOString(), size: Number(propText(props, NS.d, "getcontentlength") || 0), label: propText(props, NS.nc, "version-label") || "", author: propText(props, NS.nc, "version-author") || "" }))
    .sort((a, b) => Number(b.versionId) - Number(a.versionId));
}

export async function labelVersion(cfg, fileId, versionId, label) {
  const r = await ncFetch(cfg, "PROPPATCH", `${base(cfg, fileId)}/${vid(versionId)}`, { headers: { "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:set><d:prop><nc:version-label>${xmlEscape(label)}</nc:version-label></d:prop></d:set></d:propertyupdate>` });
  if (r.status !== 207) throw httpFail(r, "label the version");
}

/** Returns the raw response: the caller (write protocol) decides how to treat 423 vs other failures. */
export async function restoreVersion(cfg, fileId, versionId) {
  return ncFetch(cfg, "MOVE", `${base(cfg, fileId)}/${vid(versionId)}`, { headers: { Destination: `${cfg.ncUrl}/remote.php/dav/versions/${encodeURIComponent(cfg.user)}/restore/target` } });
}
