/**
 * The ONE peer-revoke operation (review C1, 2026-10-02).
 *
 * Both doors call this: the crow_revoke_instance MCP tool and the dashboard
 * Settings → Paired Instances Revoke button. Before it existed the dashboard
 * only flipped the row, so the revoked peer's open out-feed kept receiving
 * every emit and its in-feed kept being applied until a restart.
 *
 * Steps:
 *   1. revokeInstance(): status='revoked', auth token cleared, instances.json
 *      entry removed, bus `crow_instances:row_updated` (the gateway proxy
 *      drops its federated MCP client on that event).
 *   2. instanceSyncManager.teardownRevokedPeer(): close the peer's feeds and
 *      destroy its dedicated tailnet-sync stream.
 *   3. A system notification.
 *
 * When the revoke runs in a process WITHOUT the feeds-owning manager (the
 * stdio crow-sharing MCP mount), step 2 cannot reach the gateway's feeds.
 * The status row is then the backstop: InstanceSyncManager.emitChange never
 * targets a revoked peer and _processNewEntriesInner never applies one, and
 * the proxy's 60 s probe drops a revoked peer's connection.
 */

import { getInstance, revokeInstance } from "../gateway/instance-registry.js";
import { createNotification } from "../shared/notifications.js";

let _mgrResolverForTest = null;
/** Test seam: resolve the sync manager for revokePeer calls that pass none. */
export function _setSyncManagerResolverForTest(fn) { _mgrResolverForTest = fn; }

async function defaultManager() {
  if (_mgrResolverForTest) return _mgrResolverForTest();
  try {
    const { getInstanceSyncManager } = await import("./managers.js");
    return getInstanceSyncManager();
  } catch {
    return null;
  }
}

/**
 * @param {object} db
 * @param {string} id
 * @param {object} [opts]
 * @param {object|null} [opts.instanceSyncManager]  defaults to the process singleton
 * @param {string|null} [opts.localInstanceId]      refuse revoking this instance's own row
 * @returns {Promise<{ok: true, instance: object} | {ok: false, reason: "not_found"|"home"|"self"|"already_revoked"}>}
 */
export async function revokePeer(db, id, { instanceSyncManager, localInstanceId = null } = {}) {
  const existing = id ? await getInstance(db, id) : null;
  if (!existing) return { ok: false, reason: "not_found" };
  if (Number(existing.is_home)) return { ok: false, reason: "home" };
  if (localInstanceId && id === localInstanceId) return { ok: false, reason: "self" };

  await revokeInstance(db, id);

  const mgr = instanceSyncManager === undefined ? await defaultManager() : instanceSyncManager;
  if (mgr && typeof mgr.teardownRevokedPeer === "function") {
    try { await mgr.teardownRevokedPeer(id); } catch (err) {
      console.warn(`[revoke-peer] feed teardown for ${String(id).slice(0, 12)} failed: ${err.message}`);
    }
  }

  try {
    await createNotification(db, {
      title: `Instance revoked: ${existing.name || String(id).slice(0, 16)}`,
      type: "system",
      source: "instance-registry",
    });
  } catch {}

  return { ok: true, instance: existing };
}
