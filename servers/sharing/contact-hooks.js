/**
 * contact-hooks.js — the boot-time wiring of the instance-sync contact hooks.
 *
 * Extracted from boot/mcp-mounts.js so the pairing can be unit-tested. It is a
 * PAIRING, and that is the whole point: `onContactSynced` wires a contact that
 * arrived from a paired instance into the live layer, and `onContactDeleted`
 * tears that same wiring down when a delete arrives. Shipping one without the
 * other leaves a peer holding a Nostr relay subscription, per-contact sync feeds
 * and a DHT topic for a row it just removed — and the deleted contact's next DM
 * resurfaces it as a message request on that peer (design §4.3).
 *
 * Both callbacks are fire-and-forget: `_applyContact` invokes them inside its
 * own try/catch, and the underlying wire/unwire helpers are individually
 * guarded, so neither can throw into the sync apply loop.
 */

/**
 * Attach both contact hooks to an InstanceSyncManager.
 *
 * @param {object|null} syncManager                the InstanceSyncManager (null in --no-auth boots)
 * @param {object}      deps
 * @param {Function}    deps.wireSyncedContact     (managers, row) => void
 * @param {Function}    deps.unwireContact         (managers, row) => void
 * @param {Function}    deps.getManagers           () => managers | null
 * @returns {boolean}   true when the hooks were attached
 */
export function attachContactSyncHooks(syncManager, { wireSyncedContact, unwireContact, getManagers } = {}) {
  if (!syncManager) return false;
  if (typeof wireSyncedContact !== "function" || typeof unwireContact !== "function" || typeof getManagers !== "function") {
    return false;
  }
  syncManager.onContactSynced = (row) => { wireSyncedContact(getManagers(), row); };
  syncManager.onContactDeleted = (row) => { unwireContact(getManagers(), row); };
  return true;
}
