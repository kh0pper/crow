/**
 * servers/sharing/sync-outbox-drain.js — the drain half of the stdio→gateway
 * sync outbox. Reads rows queued by servers/shared/sync-emit.js's
 * `emitOrQueue` (Task 2, this branch) and re-emits them through the live
 * `InstanceSyncManager` in STRICT mode (Task 3's `'appended'|'parked'|
 * 'failed'` per-peer disposition contract), deleting a row only once every
 * CURRENTLY PAIRED peer has a real, durable append recorded against it. See
 * docs/superpowers/specs/2026-08-15-stdio-sync-outbox-design.md, "The
 * drain" — binding authority for the mechanism below.
 *
 * Why strict + per-peer accounting instead of "delete once emitChange
 * resolves": a live (non-strict) emitChange resolving is NOT a durability
 * guarantee — entries can park in RAM on an unarmed feed, append failures
 * are swallowed, and a mid-batch revoke discards parked slots. The outbox
 * row is the ONLY durable record of a queued write; deleting it against
 * that contract would convert a survivable queue into permanent loss. So
 * each row instead carries `delivered_json` ({peerId: true} per REAL
 * append) and is deleted only when delivery covers every currently paired
 * peer — a peer whose feed won't arm blocks only its own mark; healthy
 * peers still drain and delete normally.
 */

import { ensureSyncTables } from "../shared/sync-stamp.js";

const CLAIM_STALE_MINUTES = 10;

/**
 * Serializes overlapping drainOnce calls. Same promise-chain pattern
 * instance-sync.js's `_chainAppendTask` uses per peer (`_appendLocks`), but
 * here at MODULE scope: there is exactly one sync_outbox per db, drained by
 * one process, so a single chain is the right granularity — an interval
 * tick must never overlap a slow prior batch, and the cross-process claim
 * (the UPDATE...RETURNING below) is only half the story: two overlapping
 * calls IN THIS PROCESS must not race each other's per-row unclaim/delete
 * follow-up statements either.
 */
let _drainChain = Promise.resolve();

/** Parse a `delivered_json` cell defensively — corrupt/empty JSON starts a
 *  fresh delivery map rather than throwing mid-drain. */
function parseDelivered(json) {
  try {
    const obj = JSON.parse(json ?? "{}");
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/**
 * The emit-target set a row must be delivered to before it can be deleted:
 * crow_instances rows with status IN ('active','offline') — the exact set
 * `InstanceSyncManager.emitChange` itself broadcasts to. An 'offline' peer
 * is still a target (it retains queued rows indefinitely, by design —
 * durability over a peer that may reconnect); only 'paused'/'revoked' peers
 * drop out of the target set.
 */
async function getPairedPeerIds(db, localInstanceId) {
  const { rows } = await db.execute({
    sql: "SELECT id FROM crow_instances WHERE status IN ('active','offline') AND id != ?",
    args: [localInstanceId ?? ""],
  });
  return rows.map((r) => r.id);
}

async function unclaimRow(db, id, deliveredJson) {
  await db.execute({
    sql: "UPDATE sync_outbox SET delivered_json = ?, claimed_at = NULL WHERE id = ?",
    args: [JSON.stringify(deliveredJson), id],
  });
}

async function unclaimIds(db, ids) {
  if (ids.length === 0) return;
  await db.execute({
    sql: `UPDATE sync_outbox SET claimed_at = NULL WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
}

async function deleteRow(db, id) {
  await db.execute({ sql: "DELETE FROM sync_outbox WHERE id = ?", args: [id] });
}

/**
 * Claim up to batchSize queued rows in ONE autocommit statement — no BEGIN
 * IMMEDIATE (the shared client's `batch()` is deferred-transaction and a
 * raw multi-await BEGIN would sweep concurrent gateway statements into the
 * claim; spec "The drain"). A row claimed within the last
 * CLAIM_STALE_MINUTES is excluded (another drainer — or this process's own
 * prior batch — owns it); an older claim is presumed abandoned (crashed
 * drain, killed process) and reclaimed. Stale-reclaim double-emit is
 * idempotent redelivery (equivalence skip at apply).
 *
 * Returned rows are re-sorted by id in JS rather than trusted verbatim from
 * RETURNING's row order — "drain order = local write order" (ORDER BY id
 * ASC) is a hard requirement (peer causal order), and the subquery's own
 * ORDER BY only orders the CLAIM, not necessarily the RETURNING projection.
 */
async function claimBatch(db, batchSize) {
  const { rows } = await db.execute({
    sql: `UPDATE sync_outbox SET claimed_at = datetime('now')
          WHERE id IN (
            SELECT id FROM sync_outbox
            WHERE claimed_at IS NULL OR claimed_at < datetime('now', '-${CLAIM_STALE_MINUTES} minutes')
            ORDER BY id ASC LIMIT ?
          )
          RETURNING *`,
    args: [batchSize],
  });
  return [...rows].sort((a, b) => a.id - b.id);
}

async function drainOnceInner(mgr, db, { batchSize }) {
  if (!mgr || mgr.feedsDisabled) {
    // A --no-auth companion shares the primary's db and must never claim or
    // drive rows meant for the owner's drain — same class of guard as
    // emitOrQueue's isDeploymentEligible / persistSyncDeploymentVerdict.
    return { emitted: 0, deleted: 0, parkedPeers: [] };
  }

  // A fresh install (or one that has never had a stdio/queued write) may
  // never have run emitOrQueue's ensureSyncTables — the drain must not
  // crash on "no such table: sync_outbox" every boot until the first queue
  // happens. Idempotent CREATE TABLE IF NOT EXISTS.
  await ensureSyncTables(db);

  const claimed = await claimBatch(db, batchSize);
  let emitted = 0;
  let deleted = 0;
  const parkedPeers = new Set();

  for (let i = 0; i < claimed.length; i++) {
    const row = claimed[i];

    let parsedRow;
    try {
      parsedRow = JSON.parse(row.row_json);
    } catch (err) {
      console.warn(
        `[sync-outbox-drain] corrupt row_json in sync_outbox id=${row.id} table=${row.table_name} — dropping: ${err.message}`,
      );
      await deleteRow(db, row.id);
      deleted++;
      continue;
    }

    let result;
    try {
      result = await mgr.emitChange(row.table_name, row.op, parsedRow, {
        lamportTs: row.lamport_ts,
        strict: true,
      });
    } catch (err) {
      // Strict emit found at least one currently-targeted peer that parked
      // or failed. MUTATION-TEST GUARD (per task brief): never delete on
      // this path, even partially — merge whatever DID durably append into
      // delivered_json, unclaim THIS row (so it retries next tick, not in
      // 10 minutes), unclaim every OTHER row this batch's single claim
      // UPDATE already grabbed but that we haven't reached yet (leaving
      // them claimed would strand them behind the stale window instead of
      // retrying next tick too), and STOP — a later row must not be
      // delivered ahead of one that isn't durably accounted for yet.
      const dispositions = err?.dispositions || {};
      const appended = Array.isArray(err?.appended) ? err.appended : [];
      for (const [peerId, disposition] of Object.entries(dispositions)) {
        if (disposition !== "appended") parkedPeers.add(peerId);
      }
      const delivered = parseDelivered(row.delivered_json);
      for (const peerId of appended) delivered[peerId] = true;
      await unclaimRow(db, row.id, delivered);
      emitted++;

      const rest = claimed.slice(i + 1).map((r) => r.id);
      await unclaimIds(db, rest);
      break;
    }

    if (result === null) {
      // Belt-and-braces (spec): a row queued before the syncability gate
      // existed, or one whose row/table is no longer syncable. Nothing to
      // deliver, ever — drop it rather than let it wedge claimed/reclaimed
      // forever and eventually cap-evict real rows.
      await deleteRow(db, row.id);
      deleted++;
      continue;
    }

    // Success shape: { lamport, appended: [peerIds] }.
    emitted++;
    const delivered = parseDelivered(row.delivered_json);
    for (const peerId of result.appended) delivered[peerId] = true;

    const pairedIds = await getPairedPeerIds(db, mgr.localInstanceId);
    // Zero-paired-peers equivalence: Array.prototype.every() over an empty
    // array is vacuously true, so a row queued with no currently paired
    // peers deletes on its first drain pass. This is deliberate LIVE-EMIT
    // PARITY, not a gap — a live emitChange with zero paired peers also
    // "delivers" to nowhere and simply proceeds; the outbox existing at all
    // must not manufacture a stronger delivery guarantee than a live write
    // ever had.
    const coversAll = pairedIds.every((peerId) => delivered[peerId] === true);

    if (coversAll) {
      await deleteRow(db, row.id);
      deleted++;
    } else {
      await unclaimRow(db, row.id, delivered);
    }
  }

  if (emitted > 0 || deleted > 0) {
    console.log(
      `[sync-outbox-drain] drained batch: emitted=${emitted} deleted=${deleted}` +
        (parkedPeers.size > 0 ? ` parkedPeers=${[...parkedPeers].join(",")}` : ""),
    );
  }

  return { emitted, deleted, parkedPeers: [...parkedPeers] };
}

/**
 * Drain up to batchSize queued sync_outbox rows. Refuses (no-op, zero
 * counts, no db touch) when the manager's feeds are disabled. Serialized
 * against any other in-flight drainOnce call in this process via the
 * module-level `_drainChain` — mirrors instance-sync.js's per-peer
 * `_appendLocks` pattern, at outbox granularity instead of per-peer.
 * @param {object} mgr - InstanceSyncManager (or manager-shaped stub: feedsDisabled, emitChange, localInstanceId)
 * @param {object} db - db client
 * @param {{batchSize?: number}} [opts]
 * @returns {Promise<{emitted: number, deleted: number, parkedPeers: string[]}>}
 */
export async function drainOnce(mgr, db, { batchSize = 100 } = {}) {
  const prior = _drainChain;
  const next = prior.catch(() => {}).then(() => drainOnceInner(mgr, db, { batchSize }));
  _drainChain = next.catch(() => {});
  return next;
}

/**
 * Boot pass + recurring interval drain. `boot/mcp-mounts.js` has no
 * shutdown hook to clear this in (spec-noted), so the interval timer is
 * unref()'d — it must never by itself keep the process alive.
 * @param {object} mgr
 * @param {object} db
 * @param {{intervalMs?: number}} [opts]
 * @returns {{stop(): void}}
 */
export function startOutboxDrain(mgr, db, { intervalMs = 60000 } = {}) {
  const tick = () => {
    drainOnce(mgr, db).catch((err) => {
      console.warn(`[sync-outbox-drain] drain pass failed: ${err?.message ?? err}`);
    });
  };
  tick(); // boot pass
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Health surface: outbox depth + oldest-row age (spec "Observability" —
 * "health surface gains outbox depth + oldest-row age").
 * @param {object} db
 * @returns {Promise<{depth: number, oldestAgeMs: number|null}>}
 */
export async function getStats(db) {
  await ensureSyncTables(db); // same fresh-install guard as drainOnceInner
  const { rows } = await db.execute(
    "SELECT COUNT(*) AS depth, MIN(created_at) AS oldest FROM sync_outbox",
  );
  const depth = Number(rows[0]?.depth ?? 0);
  const oldest = rows[0]?.oldest ?? null;
  const oldestAgeMs = oldest ? Date.now() - new Date(String(oldest).replace(" ", "T") + "Z").getTime() : null;
  return { depth, oldestAgeMs };
}
