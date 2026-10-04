/**
 * K5 authorization (T13 fix B): may this ONLYOFFICE session user WRITE this file? Decided server-side from what
 * crow-bot can see in Nextcloud — never from token claims (S9: no claim differs between edit and view tokens, and
 * info.users lists viewers too). Fail closed: anything unverifiable → false → the change applies at close.
 *
 * Verified limit (READ-ONLY probes as crow-bot against NC 34.0.4 on crow, 2026-10-04):
 * - PROPFIND oc:owner-id on the file → the owner's uid (e.g. "admin"). The owner can write.
 * - OCS GET files_sharing/api/v1/shares/inherited?path=<file> → USER shares on the file's ANCESTOR folders made by
 *   others (e.g. {share_type 0, share_with "alex", permissions 31} on "Casa Nueva"), with their permission bits.
 * - OCS GET files_sharing/api/v1/shares?path=<file>&reshares=true → user shares on the file itself.
 * - crow-bot cannot list group members (no admin rights), so a person who can edit only through a GROUP share
 *   (share_type 1), a link or a federated share is unverifiable → treated as view-only.
 * Write = permission bit 2 (update) on a user share with share_with == uid (any matching share suffices).
 * Share acceptance (fix2 N2): the probe showed OCS `status` on these shares is the sharee's PRESENCE object
 * ({"status":"offline",…}), not an acceptance state; a NUMERIC status (Nextcloud's IShare pending 0 / accepted 1 /
 * rejected 2) is honoured when present — only 1 counts. Pending shares are otherwise not visible to crow-bot
 * (shares/pending lists only its own), so a not-yet-accepted share without a numeric status cannot be told apart.
 */
import { stat, resolveRef } from "../nc/dav.js";
import { splitPath } from "../nc/paths.js";
import { ocsGet } from "../nc/ocs.js";

const UPDATE = 2;
const SHARES = "/ocs/v2.php/apps/files_sharing/api/v1/shares";
const list = (d) => (Array.isArray(d) ? d : d ? [d] : []);

async function entryOf(cfg, fileId, path) {
  if (path) { try { const e = await stat(cfg, splitPath(path)); if (Number(e.fileId) === Number(fileId)) return e; } catch { /* moved: find it by id */ } }
  const e = await stat(cfg, await resolveRef(cfg, { file_id: Number(fileId) }));
  return Number(e.fileId) === Number(fileId) ? e : null;
}

/** → true only when crow-bot can SEE that `uid` may write file `fileId` (owner, or a user share with update). */
export async function userCanWrite(cfg, fileId, uid, path = null) {
  if (!uid || typeof uid !== "string") return false;
  try {
    const e = await entryOf(cfg, fileId, path);
    if (!e) return false;
    if (e.ownerId && String(e.ownerId) === uid) return true;
    const p = encodeURIComponent(`/${e.path}`);
    const [direct, inherited] = await Promise.all([ocsGet(cfg, `${SHARES}?path=${p}&reshares=true`), ocsGet(cfg, `${SHARES}/inherited?path=${p}`)]);
    // fix3 R3: a numeric STRING ("0") is a numeric status too
    const accepted = (s) => { const st = typeof s?.status === "string" && /^\d+$/.test(s.status) ? Number(s.status) : s?.status; return typeof st !== "number" || st === 1; };
    return [...list(direct), ...list(inherited)].some((s) => Number(s?.share_type) === 0 && String(s?.share_with) === uid && accepted(s) && (Number(s?.permissions) & UPDATE) === UPDATE);
  } catch { return false; }
}
