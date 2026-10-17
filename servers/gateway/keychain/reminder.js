/**
 * Keychain Export reminder (recovery keys, queue item 30, decision 2026-10-16).
 *
 * A key an extension saved to the keychain (Crow generated it, or it was kept from an older
 * install) exists only on this machine: the keychain never syncs, and backups never copy
 * secrets/. The user's passphrase-encrypted Export is the one off-machine copy. So while an
 * extension entry is in no Export, the Nest shows an info issue (health signal
 * "keychainExport"), and the install log says so.
 *
 * "In an Export" = the entry's sealed value was fingerprinted by the last export, or it came
 * in through an Import (it is in that file). A re-sealed value (a re-mint, a re-save) has a
 * new fingerprint, so it counts again. The fingerprints are a LOCAL setting (not in the sync
 * allowlist): another instance's export says nothing about this machine's keys. audit_log is
 * not used: it is pruned after 90 days. Manual entries are the user's own and never counted.
 */
import { createHash } from "node:crypto";
import { readSetting, writeSetting } from "../dashboard/settings/registry.js";
import { ensureKeychainTable } from "./store.js";

export const LAST_EXPORT_SETTING = "keychain_export_fingerprints";

const fp = (sealed) => createHash("sha256").update(String(sealed)).digest("hex").slice(0, 32);

async function readState(db) {
  try {
    const v = JSON.parse((await readSetting(db, LAST_EXPORT_SETTING)) || "null");
    if (v && typeof v === "object" && v.fp && typeof v.fp === "object") return v;
  } catch { /* none or damaged: nothing counts as exported */ }
  return { at: null, fp: {} };
}

async function rows(db, keyId, { activeOnly = true, ids = null } = {}) {
  await ensureKeychainTable(db);
  const { rows: r } = await db.execute({ sql: `SELECT id, secret_sealed FROM crow_keychain WHERE kind = 'extension' AND key_id = ?${activeOnly ? " AND status = 'active'" : ""}`, args: [String(keyId || "")] });
  return ids ? r.filter((x) => ids.has(Number(x.id))) : r;
}
const activeRows = (db, keyId, ids = null) => rows(db, keyId, { ids });

/**
 * Fingerprints of every readable extension entry (any status: the Export carries removed
 * extensions' entries too). Take it BEFORE the Export is built, so an entry saved while it
 * is sealed counts as not exported (a false reminder, never a false all-clear).
 */
export async function exportSnapshot(db, keyId) {
  const fps = {};
  for (const r of await rows(db, keyId, { activeOnly: false })) fps[Number(r.id)] = fp(r.secret_sealed);
  return fps;
}

/** After an Export built from `snapshot` was sealed. */
export async function recordKeychainExport(db, keyId, snapshot = null, at = new Date()) {
  const fps = snapshot || (await exportSnapshot(db, keyId));
  await writeSetting(db, LAST_EXPORT_SETTING, JSON.stringify({ at: at.toISOString(), fp: fps }), { scope: "local" });
}

/** After an Import: the imported entries are in the file they came from. */
export async function recordKeychainImport(db, keyId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const st = await readState(db);
  for (const r of await activeRows(db, keyId, new Set(ids.map(Number)))) st.fp[Number(r.id)] = fp(r.secret_sealed);
  await writeSetting(db, LAST_EXPORT_SETTING, JSON.stringify(st), { scope: "local" });
}

export async function lastKeychainExport(db) {
  return (await readState(db)).at;
}

/** Active, readable extension entries whose current sealed value is in no Export. */
export async function unexportedCount(db, keyId) {
  if (!keyId) return 0;
  const st = await readState(db);
  let n = 0;
  for (const r of await activeRows(db, keyId)) if (st.fp[Number(r.id)] !== fp(r.secret_sealed)) n++;
  return n;
}
