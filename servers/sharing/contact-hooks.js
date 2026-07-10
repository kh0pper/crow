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
 * The two hooks are deliberately asymmetric:
 *   - `onContactSynced` is fire-and-forget. `_afterContactApplied` invokes it as
 *     `Promise.resolve(...).catch(() => {})`; it wires UP a row that already
 *     exists and nothing follows it, so there is no ordering hazard.
 *   - `onContactDeleted` RETURNS its promise, because `_applyContact` awaits the
 *     hook and then issues `DELETE FROM contacts`. Teardown must finish first.
 *     Today that would hold anyway — `unsubscribeFromContact` is synchronous, so
 *     the FK-critical step completes before the first real `await` — but relying
 *     on that is a hidden dependency: making it async later would silently
 *     reopen the window `deleteContactLocal` calls load-bearing. Returning the
 *     promise makes the existing `await` real.
 *
 * Neither can throw into the sync apply loop: `_applyContact` wraps the call and
 * the underlying wire/unwire helpers are individually guarded.
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
  syncManager.onContactDeleted = (row) => unwireContact(getManagers(), row); // returned: _applyContact awaits this before DELETE
  return true;
}
