/**
 * The off-site backup key (spec §12.1): 32 random bytes kept in crow's own keychain, NOT derived
 * from the identity seed, sealed like any other keychain entry and therefore carried by the
 * owner's passphrase-encrypted Export — that export is the single recovery root for a vault file.
 *
 * The entry has a fixed identity (kind "extension", bundle "offsite-backup", env key
 * CROW_OFFSITE_BACKUP_KEY), so the restore CLI finds it inside an export with no DB at all. It is
 * "generated" (Crow made it), which also puts it under the existing "this key is in no Export"
 * reminder until the owner exports — exactly the gate part B's upload needs.
 *
 * The key leaves this module only as a Buffer for the upload/verify code: it is never logged and
 * never returned from a route.
 */
import { randomBytes } from "node:crypto";
import { ensureKeychainTable, openEntrySecret, saveExtensionSecret } from "../keychain/store.js";
import { entryInLastExport } from "../keychain/reminder.js";
import { OFFSITE_KEY, encodeVaultKey, keyId, vaultKeyFromSecret } from "../../shared/crow-vault.js";

// Two first callers must never mint two keys (the second would overwrite the first's row and
// orphan every vault file sealed with it). One in-flight ensure per db client.
const inflight = new WeakMap();

const ROW_SQL = "SELECT id FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ?";
const ROW_ARGS = [OFFSITE_KEY.bundleId, OFFSITE_KEY.envKey];

/**
 * The off-site key, created on first call and reused forever after.
 * Returns { key: Buffer, key_id: string, id: number, created: boolean }.
 */
export async function ensureOffsiteKey(db, keychainKey) {
  if (!db || typeof db.execute !== "function") throw new Error("ensureOffsiteKey: a db client is required");
  const running = inflight.get(db);
  if (running) return running;
  const p = createOrRead(db, keychainKey);
  inflight.set(db, p);
  const clear = () => { if (inflight.get(db) === p) inflight.delete(db); };
  p.then(clear, clear);
  return p;
}

async function createOrRead(db, keychainKey) {
  await ensureKeychainTable(db);
  const row = (await db.execute({ sql: ROW_SQL, args: ROW_ARGS })).rows[0];
  if (row) {
    // KEYCHAIN_KEY_MISSING when the row was sealed under another key: the caller must Import an
    // export, not replace the key (that would make every existing vault file unreadable).
    const secret = await openEntrySecret(db, keychainKey, row.id);
    const key = vaultKeyFromSecret(secret);
    if (!key) throw new Error(`the off-site backup key entry (id ${row.id}) does not hold a 32-byte key; restore it from a keychain Export instead of replacing it`);
    return { key, key_id: keyId(key), id: Number(row.id), created: false };
  }
  const key = randomBytes(32);
  const { id } = await saveExtensionSecret(db, keychainKey, {
    systemOwner: true, // the one caller allowed to write the reserved id
    bundleId: OFFSITE_KEY.bundleId,
    envKey: OFFSITE_KEY.envKey,
    label: OFFSITE_KEY.label,
    secret: encodeVaultKey(key),
    origin: "generated",
  });
  return { key, key_id: keyId(key), id, created: true };
}

/**
 * Whether the newest recorded keychain Export holds the off-site key (part B's upload gate: a
 * backup nobody can decrypt is worse than no backup). Fails closed — no entry, no export
 * snapshot, or a DB without the settings tables all read as "not exported yet".
 */
export async function offsiteKeyInExport(db) {
  try {
    await ensureKeychainTable(db);
    const row = (await db.execute({ sql: ROW_SQL, args: ROW_ARGS })).rows[0];
    if (!row) return false;
    return (await entryInLastExport(db, Number(row.id))) === true;
  } catch {
    return false;
  }
}