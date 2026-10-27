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
 *   2. PT-1: delete the peer's signing key from peer-tokens.json, under the
 *      store lock and unconditionally (this is the authoritative revoke act).
 *      Skipped, and reported as `store_mismatch`, when the resolved store and
 *      the open DB do not belong to the same instance; the owning gateway's
 *      trust sweeper then deletes it (servers/gateway/peer-trust-sweeper.js).
 *   3. PT-1: end the SSO sessions the peer minted (scopes
 *      'dashboard sso src:<id>') and any untagged legacy SSO sessions.
 *   4. instanceSyncManager.teardownRevokedPeer(): close the peer's feeds and
 *      destroy its dedicated tailnet-sync stream; close the MCP sessions the
 *      peer opened in this process.
 *   5. A system notification.
 *
 * A key-only id (a store entry with no crow_instances row) is purged too,
 * under the same store guard, and returns `{ ok: true, orphan: true }`.
 *
 * When the revoke runs in a process WITHOUT the feeds-owning manager (the
 * stdio crow-sharing MCP mount), step 2 cannot reach the gateway's feeds.
 * The status row is then the backstop: InstanceSyncManager.emitChange never
 * targets a revoked peer and _processNewEntriesInner never applies one, and
 * the proxy's 60 s probe drops a revoked peer's connection.
 */

import { getInstance, revokeInstance } from "../gateway/instance-registry.js";
import { createNotification } from "../shared/notifications.js";
import { deletePeerCreds, getPeerCreds, peerTokensPath } from "../shared/peer-credentials.js";
import { resolveInstanceDataDir, resolveCrowHome, sameDbLocation, isWithin } from "../shared/crow-home.js";
import { resolveDbPath } from "../db.js";

/**
 * True when this process's credential store and DB belong to one instance:
 * the DB is the instance data dir's crow.db, and both the data dir and the
 * store sit in the instance home. An install whose data dir lives outside
 * its home is always reported as a mismatch; the gateway's sweeper then
 * deletes the key (≤10 s). Realpath comparisons (a string compare misfires on a
 * symlinked data dir). Exported for tests.
 */
export function storeMatchesDb(env = process.env) {
  try {
    const dataDir = resolveInstanceDataDir(env);
    const home = resolveCrowHome(env);
    return sameDbLocation(resolveDbPath(), dataDir) && isWithin(dataDir, home) && isWithin(peerTokensPath(), home);
  } catch {
    return false;
  }
}

function deleteCredsGuarded(id) {
  if (!storeMatchesDb()) {
    console.warn(`[revoke-peer] credential store ${peerTokensPath()} does not belong to the open DB (${resolveDbPath()}); key for ${String(id).slice(0, 12)} NOT deleted here — the owning gateway's sweeper deletes it`);
    return { creds_deleted: false, reason: "store_mismatch" };
  }
  try {
    return { creds_deleted: deletePeerCreds(id) };
  } catch (err) {
    console.error(`[revoke-peer] could not delete the signing key for ${String(id).slice(0, 12)}: ${err.message} (the row gate already refuses it)`);
    return { creds_deleted: false, reason: "error" };
  }
}

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
  if (!existing) {
    // A key with no row cannot be revoked through the row; purge the key.
    if (id && (!localInstanceId || id !== localInstanceId) && getPeerCreds(id)) {
      const creds = deleteCredsGuarded(id);
      return { ok: creds.creds_deleted === true, orphan: true, ...creds, ...(creds.creds_deleted ? {} : { reason: creds.reason }) };
    }
    return { ok: false, reason: "not_found" };
  }
  if (Number(existing.is_home)) return { ok: false, reason: "home" };
  if (localInstanceId && id === localInstanceId) return { ok: false, reason: "self" };

  // 1. The row first: authoritative across processes; nulls the bearer hash.
  await revokeInstance(db, id);

  // 2. The signing key.
  const creds = deleteCredsGuarded(id);

  // 3. SSO sessions the peer minted, plus legacy untagged ones (≤24 h).
  try {
    await db.execute({
      sql: "DELETE FROM oauth_tokens WHERE client_id = 'dashboard' AND scopes IN (?, 'dashboard sso')",
      args: [`dashboard sso src:${id}`],
    });
  } catch (err) {
    console.warn(`[revoke-peer] SSO session cleanup for ${String(id).slice(0, 12)} failed: ${err.message}`);
  }

  // 4. Feeds, the dedicated sync stream, and MCP sessions in this process.
  const mgr = instanceSyncManager === undefined ? await defaultManager() : instanceSyncManager;
  if (mgr && typeof mgr.teardownRevokedPeer === "function") {
    try { await mgr.teardownRevokedPeer(id); } catch (err) {
      console.warn(`[revoke-peer] feed teardown for ${String(id).slice(0, 12)} failed: ${err.message}`);
    }
  }
  try {
    const { closeSessionsOwnedByEverywhere, peerSessionOwner } = await import("../gateway/session-manager.js");
    await closeSessionsOwnedByEverywhere(peerSessionOwner(id));
  } catch (err) {
    console.warn(`[revoke-peer] MCP session teardown for ${String(id).slice(0, 12)} failed: ${err.message}`);
  }

  try {
    await createNotification(db, {
      title: `Instance revoked: ${existing.name || String(id).slice(0, 16)} (signing key ${creds.creds_deleted ? "deleted" : "pending deletion"})`,
      type: "system",
      source: "instance-registry",
    });
  } catch {}

  return { ok: true, instance: existing, ...creds };
}
