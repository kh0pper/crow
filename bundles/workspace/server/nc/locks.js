import { docSession } from "./onlyoffice.js";
import { displayName } from "./ocs.js";

export function lockInfo(e) {
  if (!e.lock) return null;
  return { type: e.lockType === 1 ? "editor" : "person", ownerType: e.lockType, owner: e.lockOwner, ownerName: e.lockOwnerName || e.lockOwner, since: e.lockTime ? new Date(e.lockTime * 1000).toISOString() : null };
}

const names = (xs) => (xs.length <= 1 ? xs[0] || "Someone" : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * Explain a lock (spec §5.2/§5.3). Keys on nc:lock + lock-owner-type ONLY: while ONLYOFFICE holds a file
 * nc:lock-owner is NULL (spike S6), so the owner string is never consulted. Type 1 (app) = the editor;
 * 0 (user) / 2 (token) = a person's manual lock, which is never overridden.
 */
export async function classifyLock(cfg, e) {
  const l = lockInfo(e);
  if (l.ownerType !== 1) {
    const who = l.ownerName || "Someone";
    return { code: "locked_by_person", message: `${who} locked "${e.name}" in Workspace. Ask them to unlock it, or try later.`, data: { open_by: [who], since: l.since, lock_type: "person", can_proceed: false } };
  }
  const s = await docSession(cfg, e.fileId);
  // `known`, not `live`: a locked file whose key is cached with no users is still being saved after its last editor
  // left (the connector unlocks once that save lands) — not a stale lock.
  if (!s.known) {
    return { code: "stale_editor_lock", message: `"${e.name}" is still marked as open in the editor, but nobody is editing it. Ask ${e.ownerName || "the file's owner"} to open the file's ⋯ menu in Workspace and choose Unlock, then try again.`, data: { since: l.since, lock_type: "editor", can_proceed: false, owner: e.ownerName } };
  }
  const who = await Promise.all(s.uids.map((u) => displayName(cfg, u)));
  return {
    code: "open_in_editor", key: s.key, users: s.users,
    message: `${names(who)} ${who.length > 1 ? "have" : "has"} "${e.name}" open in the editor.`,
    data: { open_by: who, since: l.since, lock_type: "editor", can_proceed: true },
  };
}
