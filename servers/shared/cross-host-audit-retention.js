/**
 * Bounded retention for cross_host_calls — the federation audit table that
 * has corrupted crow's DB twice (2026-06-14, 2026-07-02) as an unbounded
 * append-only, high-write table. This is the root-cause fix: keep the table
 * small so there is far less corruption surface and any recovery is fast.
 *
 * Retention default is 14 days, NOT 7 — health-signals.js's
 * `integrationsSignal` (:493-506) reads a 7-day window to find the latest
 * failing peer per instance. A 7-day retention would let the prune delete
 * that "latest failing peer" row out from under it and silence the warning,
 * reintroducing the exact silent-degradation failure mode this hardening is
 * meant to fix. 14 days keeps a comfortable margin over both known readers
 * (the dashboard audit-log view's 24h window, and the 7-day integrations
 * signal) while still keeping the table tiny.
 *
 * This function is deliberately unable to make things worse: it NEVER
 * rejects/throws, under any failure (missing table, closed db, malformed
 * disk image, IOERR, whatever) — a failure here must not take down boot or
 * cascade into another outage.
 */

/**
 * @param {{execute: Function}} db - a db client (createDbClient() shape).
 * @param {{retentionDays?: number}} [opts]
 * @returns {Promise<{deleted: number, checkpointed: boolean}>} never rejects.
 */
export async function pruneCrossHostAudit(db, opts = {}) {
  const retentionDays = Number.isFinite(opts.retentionDays) ? opts.retentionDays : 14;

  try {
    let deleted = 0;
    try {
      const result = await db.execute({
        sql: "DELETE FROM cross_host_calls WHERE at < datetime('now', ?)",
        args: [`-${retentionDays} days`],
      });
      deleted = Number(result?.rowsAffected || 0);
    } catch (err) {
      console.warn("[cross-host-audit-retention] prune failed (non-fatal):", err?.message || err);
      return { deleted: 0, checkpointed: false };
    }

    // Best-effort checkpoint. In WAL mode this reclaims the space just
    // freed by the DELETE above; in DELETE-journal mode (low-RAM hosts,
    // see db.js resolveJournalMode) it's a harmless no-op. Never allowed
    // to fail the whole call — a checkpoint failure must not propagate.
    let checkpointed = false;
    try {
      await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      checkpointed = true;
    } catch (err) {
      console.warn("[cross-host-audit-retention] checkpoint failed (non-fatal):", err?.message || err);
    }

    return { deleted, checkpointed };
  } catch (err) {
    // Belt-and-suspenders: any unexpected synchronous throw (e.g. a db
    // handle that isn't even shaped right) must still resolve, not reject.
    console.warn("[cross-host-audit-retention] unexpected error (non-fatal):", err?.message || err);
    return { deleted: 0, checkpointed: false };
  }
}
