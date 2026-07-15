/**
 * Crow Sharing — Shared Managers Singleton
 *
 * Hyperswarm and Nostr connections are shared across all McpServer instances
 * (stdio, gateway per-session, router dispatch). First-call-wins: dbPath is
 * ignored after the first call; real callers pass undefined and it builds from env.
 */

import { createDbClient } from "../db.js";
import { loadOrCreateIdentity } from "./identity.js";
import { PeerManager } from "./peer-manager.js";
import { SyncManager } from "./sync.js";
import { InstanceSyncManager } from "./instance-sync.js";
import { NostrManager } from "./nostr.js";
import { installNostrCrashGuard } from "./nostr-crash-guard.js";
import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";

// Singleton sharing managers — Hyperswarm and Nostr connections are shared across
// all McpServer instances (stdio, gateway per-session, router dispatch).
let _sharedManagers = null;

export function getSharedManagers(dbPath) {
  if (_sharedManagers) return _sharedManagers;

  const db = createDbClient(dbPath);
  const identity = loadOrCreateIdentity();
  const peerManager = new PeerManager(identity);
  const syncManager = new SyncManager(identity);
  const nostrManager = new NostrManager(identity, db);
  // Narrow process-level net for nostr-tools' orphaned close-race rejection
  // (2c-F1 C1b): swallows SendingOnClosedConnection, RETHROWS everything else.
  // Idempotent; installed once with the singleton that owns all relay use.
  installNostrCrashGuard();

  // Instance sync manager for cross-instance replication
  const localInstanceId = getOrCreateLocalInstanceId();
  const instanceSyncManager = new InstanceSyncManager(identity, db, localInstanceId);

  _sharedManagers = { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager, initialized: false };
  return _sharedManagers;
}

/**
 * Get the shared InstanceSyncManager instance (for use by other servers via gateway).
 * Returns null if managers haven't been initialized yet.
 */
export function getInstanceSyncManager() {
  return _sharedManagers?.instanceSyncManager || null;
}

/**
 * Peek at the singleton without constructing it.
 * Returns _sharedManagers or null — never triggers first-call construction.
 * Used by send* functions (sendRoomInvite, sendVoiceMemo, sendReaction, sendBotRelay)
 * so that a wm dynamic call before gateway boot fails soft instead of constructing
 * managers against default env.
 */
export function getManagersOrNull() {
  return _sharedManagers;
}
