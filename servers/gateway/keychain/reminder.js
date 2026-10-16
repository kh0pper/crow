/**
 * Keychain Export reminder (recovery keys, queue item 30, decision 2026-10-16).
 *
 * A key Crow GENERATES for an extension (an admin password, a data encryption key) exists
 * only on this machine: the keychain never syncs, and backups never copy secrets/. The
 * user's passphrase-encrypted Export is the one off-machine copy. So while a generated
 * key is in no Export, the Nest shows an info issue (health signal "keychainExport").
 *
 * "In no Export" = created after the last successful export (or there was never one).
 * The time is a LOCAL setting (not in the sync allowlist): another instance's export says
 * nothing about this machine's keys. audit_log is not used: it is pruned after 90 days.
 */
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";
import { ensureKeychainTable } from "./store.js";

export const LAST_EXPORT_SETTING = "keychain_last_export_at";

/** Call after an Export file was sealed and is about to be sent. */
export async function recordKeychainExport(db, at = new Date()) {
  await writeSetting(db, LAST_EXPORT_SETTING, at.toISOString(), { scope: "local" });
}

export async function lastKeychainExport(db) {
  const v = await readSetting(db, LAST_EXPORT_SETTING);
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Active generated extension entries created after the last export (all when none). */
export async function unexportedGeneratedCount(db) {
  await ensureKeychainTable(db);
  const since = await lastKeychainExport(db);
  const { rows } = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM crow_keychain
          WHERE kind = 'extension' AND origin = 'generated' AND status = 'active'
            AND (? IS NULL OR created_at > ?)`,
    args: [since, since],
  });
  return Number(rows[0]?.n ?? 0);
}
