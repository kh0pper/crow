/**
 * Boot-time redaction of old conflict snapshots (security audit N1b-7, fix
 * round 2).
 *
 * Before conflict snapshots were stripped, `sync_conflicts.winning_data` for a
 * providers conflict was a raw `SELECT *` of THIS device's row — its `api_key` —
 * and `losing_data` could be an old peer's wire row that still carried one. The
 * settings page renders both in full and `crow_list_sync_conflicts` returns a
 * prefix of them, so rows saved before the fix are a standing exposure.
 *
 * This is a one-time repair, run once per boot like the other boot repairs
 * (servers/gateway/boot/post-listen.js): for every `sync_conflicts` row with
 * `table_name = 'providers'`, parse both snapshots, drop the table's local-only
 * columns (instance-sync.js LOCAL_ONLY_COLUMNS — the single source of truth) and
 * write them back ONLY when something actually changed. Idempotent: a second run
 * finds nothing to do. A row is never deleted and `resolved` is never touched —
 * the operator's review history survives, minus the secret.
 *
 * No schema change: this rewrites two TEXT columns in place.
 *
 * Never throws: a caller on the boot path must not be taken down by a corrupt
 * snapshot. A blob that cannot be parsed is left exactly as it is (this repair
 * cannot redact what it cannot read, and destroying a conflict is worse).
 */
import { LOCAL_ONLY_COLUMNS, stripConflictSnapshot } from "./instance-sync.js";

/** Tables this repair rewrites — the ones whose snapshots can hold a key. */
const TABLES = Object.freeze(Object.keys(LOCAL_ONLY_COLUMNS));

/**
 * Redact local-only columns from every stored conflict snapshot of `tables`.
 *
 * @param {object} db
 * @param {{ tables?: string[] }} [opts] — test seam; defaults to every table that
 *   has local-only columns (today: `providers`).
 * @returns {Promise<number>} how many conflict rows were rewritten
 */
export async function redactConflictSnapshots(db, { tables = TABLES } = {}) {
  const wanted = [...tables].filter((t) => LOCAL_ONLY_COLUMNS[t]);
  if (wanted.length === 0) return 0;
  const placeholders = wanted.map(() => "?").join(", ");
  const { rows } = await db.execute({
    sql: `SELECT id, table_name, winning_data, losing_data FROM sync_conflicts
           WHERE table_name IN (${placeholders})`,
    args: wanted,
  });

  let changed = 0;
  for (const row of rows) {
    const win = stripConflictSnapshot(row.table_name, row.winning_data);
    const lose = stripConflictSnapshot(row.table_name, row.losing_data);
    if (win === row.winning_data && lose === row.losing_data) continue; // nothing to redact
    await db.execute({
      sql: "UPDATE sync_conflicts SET winning_data = ?, losing_data = ? WHERE id = ?",
      args: [win, lose, row.id],
    });
    changed += 1;
  }
  return changed;
}

/**
 * The boot entry point: run the repair, log exactly one line with the count, and
 * never throw (see the module docblock).
 *
 * @param {object} db
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<number>} how many conflict rows were rewritten (0 on error)
 */
export async function redactConflictSnapshotsAtBoot(db, { log = console.log } = {}) {
  try {
    const changed = await redactConflictSnapshots(db);
    log(`[sync-conflicts] key redaction: ${changed} stored conflict snapshot row(s) rewritten`);
    return changed;
  } catch (err) {
    log(`[sync-conflicts] key redaction skipped: ${err?.message || err}`);
    return 0;
  }
}