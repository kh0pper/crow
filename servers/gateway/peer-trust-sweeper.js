/**
 * Peer-trust sweeper and boot reconciliation (PT-1).
 *
 * Request-time gates (peer-trust.js) refuse a revoked, paused or untrusted
 * peer on its next request. This module handles what a request gate cannot:
 *
 *   - Open sockets. A revoke written by ANOTHER process (the stdio
 *     crow-sharing MCP server) cannot reach this gateway's MCP sessions, sync
 *     streams or feeds. Every 10 s, and at once on any
 *     `crow_instances:row_updated` bus event, every peer that fails the trust
 *     predicate has its open MCP sessions closed, its feeds and dedicated sync
 *     stream torn down, and its tagged SSO sessions deleted.
 *   - Leftover signing keys. A revoked peer's credential-store entry is
 *     deleted only when it was minted strictly BEFORE the revoke (the
 *     minted-before rule). An enroll writes its new key before it flips the
 *     row from revoked to active, so a key minted after the revoke belongs to
 *     a re-pair in flight and is kept. The row is read before the store lock;
 *     the FILE is re-read inside it, which is what protects a fresh key.
 *   - Reporting. Rows that fail the predicate but still hold a bearer or a
 *     key ("paired but not trusted: re-pair or revoke") and store entries
 *     with no row (orphans) become Nest health items. Neither is ever
 *     changed automatically: nothing is auto-promoted, and an orphan may be
 *     an enroll that wrote its key before inserting its row.
 *
 * Before the FIRST reconcile on a host, a mode-0600 snapshot of the whole
 * store is written (`<store>.pre-pt1.<ts>`); the operator shreds it once the
 * final key set is verified. A marker file records that it was taken.
 */

import { existsSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { TRUSTED_PEER_SQL } from "../shared/peer-trust.js";
import { updatePeerCreds, entryMintMs, loadPeerCreds, peerTokensPath } from "../shared/peer-credentials.js";
import { setUntrustedWithCreds, setOrphanKeys } from "../shared/peer-trust-health.js";
import { closeSessionsOwnedByEverywhere, countSessionsOwnedByEverywhere, peerSessionOwner } from "./session-manager.js";
import bus from "../shared/event-bus.js";

export const SWEEP_INTERVAL_MS = 10_000;

/** SQLite datetime('now') text (UTC, no zone) → epoch ms. */
export function sqliteUtcMs(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
}

const _sameSecondLogged = new Set();

/**
 * Write the one-time pre-PT-1 snapshot of the store (0600), once per host.
 * @returns {string|null} the snapshot path when one was written
 */
export function snapshotStoreOnce({ now = () => Date.now() } = {}) {
  const store = peerTokensPath();
  const marker = `${store}.pre-pt1.done`;
  if (existsSync(marker) || !existsSync(store)) return null;
  const snap = `${store}.pre-pt1.${now()}`;
  copyFileSync(store, snap);
  chmodSync(snap, 0o600);
  writeFileSync(marker, `${new Date(now()).toISOString()}\n`, { mode: 0o600 });
  console.log(`[peer-trust] pre-PT-1 snapshot of the credential store written (mode 600): ${snap} — shred it once the final key set is verified`);
  return snap;
}

/**
 * Reconcile the credential store against crow_instances. Idempotent.
 * @returns {Promise<{deleted: string[], keptSameSecond: string[], orphans: string[], untrusted: string[]}>}
 */
export async function reconcilePeerCreds(db, { localInstanceId = null } = {}) {
  // Rows first (async), then the synchronous store lock.
  const { rows } = await db.execute({
    sql: `SELECT id, name, status, updated_at, auth_token_hash, (${TRUSTED_PEER_SQL}) AS ok FROM crow_instances`,
    args: [],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const revoked = rows.filter((r) => r.status === "revoked");

  const deleted = [];
  const keptSameSecond = [];
  if (revoked.length) {
    updatePeerCreds((all) => {
      let changed = false;
      for (const r of revoked) {
        const entry = all[r.id];
        if (!entry) continue;
        const R = sqliteUtcMs(r.updated_at);
        const M = entryMintMs(entry);
        if (!Number.isFinite(R)) continue; // no revoke time: never guess
        if (M < R) {
          delete all[r.id];
          deleted.push(r.id);
          changed = true;
        } else if (M < R + 1000) {
          // Minted within the revoke's second: kept (unusable behind the row
          // gate; a re-pair overwrites it).
          keptSameSecond.push(r.id);
        }
      }
      return changed ? {} : { write: false };
    });
  }
  for (const id of deleted) console.log(`[peer-trust] deleted the signing key of revoked peer ${id} (minted before its revoke)`);
  for (const id of keptSameSecond) {
    if (_sameSecondLogged.has(id)) continue;
    _sameSecondLogged.add(id);
    console.warn(`[peer-trust] revoked peer ${id} has a key minted in the same second as its revoke; kept (refused by the row gate)`);
  }

  const store = loadPeerCreds();
  const orphans = Object.keys(store).filter((id) => !byId.has(id));
  const untrustedRows = rows.filter((r) => r.id !== localInstanceId && r.status !== "revoked" && Number(r.ok) !== 1
    && (r.auth_token_hash || store[r.id]));
  setOrphanKeys(orphans);
  setUntrustedWithCreds(untrustedRows.map((r) => ({ id: r.id, name: r.name })));
  return { deleted, keptSameSecond, orphans, untrusted: untrustedRows.map((r) => r.id) };
}

/**
 * Tear down what a not-trusted peer still has open in THIS process.
 * @returns {Promise<string[]>} ids torn down
 */
export async function teardownUntrustedPeers(db, { instanceSyncManager = null, localInstanceId = null } = {}) {
  const { rows } = await db.execute({
    sql: `SELECT id FROM crow_instances WHERE NOT (${TRUSTED_PEER_SQL}) AND id != ?`,
    args: [localInstanceId || ""],
  });
  const done = [];
  for (const { id } of rows) {
    // Read first: a sweep writes only when there is something to delete
    // (a write every 10 s per revoked peer would contend with real writers).
    try {
      const tag = `dashboard sso src:${id}`;
      const { rows: sso } = await db.execute({
        sql: "SELECT 1 FROM oauth_tokens WHERE client_id = 'dashboard' AND scopes = ? LIMIT 1",
        args: [tag],
      });
      if (sso.length) {
        await db.execute({ sql: "DELETE FROM oauth_tokens WHERE client_id = 'dashboard' AND scopes = ?", args: [tag] });
      }
    } catch { /* best effort; the revoke itself already deleted them */ }
    const owner = peerSessionOwner(id);
    const sessions = countSessionsOwnedByEverywhere(owner);
    const mgr = instanceSyncManager;
    const feeds = Boolean(mgr && (mgr.inFeeds?.has?.(id) || mgr.outFeeds?.has?.(id) || mgr.hasActiveStream?.(id)));
    if (!sessions && !feeds) continue;
    if (sessions) await closeSessionsOwnedByEverywhere(owner);
    if (feeds && typeof mgr.teardownRevokedPeer === "function") {
      try { await mgr.teardownRevokedPeer(id); } catch (err) {
        console.warn(`[peer-trust] teardown for ${String(id).slice(0, 12)} failed: ${err.message}`);
      }
    }
    done.push(id);
  }
  return done;
}

/**
 * Start the sweeper. Runs the boot reconcile (with the one-time snapshot)
 * first, then every `intervalMs` and on every row_updated bus event.
 * @returns {{ stop(): void, runNow(): Promise<void> }}
 */
export function startPeerTrustSweeper({ db, getInstanceSyncManager = () => null, localInstanceId = null, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  let running = null;
  let again = false;
  const runOnce = async () => {
    try {
      await reconcilePeerCreds(db, { localInstanceId });
      await teardownUntrustedPeers(db, { instanceSyncManager: getInstanceSyncManager(), localInstanceId });
    } catch (err) {
      console.warn(`[peer-trust] sweep failed: ${err.message}`);
    }
  };
  const run = () => {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await runOnce(); } while (again);
    })().finally(() => { running = null; });
    return running;
  };
  try { snapshotStoreOnce(); } catch (err) {
    console.warn(`[peer-trust] pre-PT-1 snapshot failed: ${err.message}`);
  }
  const onRow = () => { run(); };
  bus.on("crow_instances:row_updated", onRow);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return {
    stop() { clearInterval(timer); bus.off?.("crow_instances:row_updated", onRow); },
    runNow: run,
  };
}

/** Exposed for the T11 sidecar: the reconcile against the env's own DB/store. */
export async function reconcileFromEnv() {
  const { createDbClient } = await import("../db.js");
  const db = createDbClient();
  try { return await reconcilePeerCreds(db); } finally { try { db.close(); } catch { /* ignore */ } }
}

