export function lockInfo(e) {
  if (!e.lock) return null;
  return { type: e.lockType === 1 ? "editor" : "person", ownerType: e.lockType, owner: e.lockOwner, ownerName: e.lockOwnerName || e.lockOwner, since: e.lockTime ? new Date(e.lockTime * 1000).toISOString() : null };
}
