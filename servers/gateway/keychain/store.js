/**
 * Crow keychain — human-facing passwords, sealed with secret-box under the keychain's OWN
 * key (keychain/key.js), LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES). Secrets leave this
 * module only through openEntrySecret / consumeFirstView / exportableEntries, whose callers
 * gate and audit them. Rows sealed under another key (a crow.db restored onto a machine
 * without the key file) are listed as readable:false and throw KeychainKeyMissingError on
 * open — never a crash, never a wrong plaintext.
 */
import { sealSecret, openSecret } from "../../sharing/secret-box.js";
import { KEYCHAIN_DDL } from "./schema.js";
import { keychainKeyState, createKeychainKey, KeychainKeyInvalidError } from "./key.js";

export const KEYCHAIN_TABLE = "crow_keychain";
export const FIRST_VIEW_MS = 30 * 60 * 1000;
const KINDS = new Set(["extension", "manual"]);
const ORIGINS = new Set(["typed", "generated", "manual"]);

export class KeychainKeyMissingError extends Error {
  constructor() {
    super("The keychain key for this password is not on this machine.");
    this.code = "KEYCHAIN_KEY_MISSING";
  }
}

const META_COLS = "id, kind, label, bundle_id, env_key, username, url, origin, status, key_id, created_at, updated_at, first_view_until";
const iso = (d) => (d instanceof Date ? d : new Date()).toISOString();
const cleanText = (v, max = 512) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).slice(0, max));
const box = (key) => ({ seed: key.seed });

function requireKey(key) {
  if (!key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed)) throw new KeychainKeyMissingError();
}

const ensured = new WeakSet();
export async function ensureKeychainTable(db) {
  if (ensured.has(db)) return;
  await db.executeMultiple(KEYCHAIN_DDL);
  ensured.add(db);
}

function toEntry(r, { now, keyId } = {}) {
  if (!r) return null;
  const { first_view_until: fvu, key_id: kid, ...rest } = r;
  return { ...rest, id: Number(r.id), readable: !!keyId && kid === keyId, first_view_pending: !!fvu && fvu > iso(now) };
}

export async function countEntries(db) {
  await ensureKeychainTable(db);
  return Number((await db.execute("SELECT COUNT(*) AS n FROM crow_keychain")).rows[0].n);
}

/**
 * The key to SAVE with (re-review m1/m2). Missing → created. Invalid (empty/damaged file) →
 * replaced only while the table is empty; otherwise KeychainKeyInvalidError, because those
 * rows may still be recoverable by restoring the file. When a key is created while rows
 * already exist (the old key was lost), onNewKey({ orphaned }) lets the caller audit it and
 * tell the user those entries need an Import.
 */
export async function ensureWriteKey(db, { crowHome, onNewKey } = {}) {
  const st = keychainKeyState({ crowHome });
  if (st.state === "ok") return st.key;
  const n = await countEntries(db);
  if (st.state === "invalid" && n > 0) throw new KeychainKeyInvalidError(st.path);
  const key = createKeychainKey({ crowHome, replaceInvalid: st.state === "invalid" });
  if (n > 0 && typeof onNewKey === "function") {
    try { await onNewKey({ orphaned: n }); } catch { /* reporting must never block a save */ }
  }
  return key;
}

export async function saveExtensionSecret(db, key, { bundleId, envKey, label, username = null, url = null, secret, origin, firstView = false, now }) {
  await ensureKeychainTable(db);
  requireKey(key);
  if (!bundleId || !envKey || typeof secret !== "string" || secret === "") throw new Error("keychain: bundleId, envKey and a secret are required");
  if (!ORIGINS.has(origin) || origin === "manual") throw new Error("keychain: origin must be typed or generated");
  const sealed = sealSecret(secret, box(key));
  const ts = iso(now);
  const fvu = firstView ? new Date((now || new Date()).getTime() + FIRST_VIEW_MS).toISOString() : null;
  const existing = (await db.execute({ sql: "SELECT id FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ?", args: [bundleId, envKey] })).rows[0];
  if (existing) {
    await db.execute({
      sql: "UPDATE crow_keychain SET label = ?, username = ?, url = ?, secret_sealed = ?, key_id = ?, origin = ?, status = 'active', first_view_until = ?, updated_at = ? WHERE id = ?",
      args: [cleanText(label) || envKey, cleanText(username), cleanText(url, 2048), sealed, key.id, origin, fvu, ts, existing.id],
    });
    return { id: Number(existing.id), created: false };
  }
  const r = await db.execute({
    sql: "INSERT INTO crow_keychain (kind, label, bundle_id, env_key, username, url, secret_sealed, key_id, origin, first_view_until, created_at, updated_at) VALUES ('extension', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [cleanText(label) || envKey, bundleId, envKey, cleanText(username), cleanText(url, 2048), sealed, key.id, origin, fvu, ts, ts],
  });
  return { id: Number(r.lastInsertRowid), created: true };
}

export async function addManualSecret(db, key, { label, username = null, url = null, secret }) {
  await ensureKeychainTable(db);
  requireKey(key);
  if (!cleanText(label) || typeof secret !== "string" || secret === "") throw new Error("keychain: a label and a secret are required");
  const ts = iso();
  const r = await db.execute({
    sql: "INSERT INTO crow_keychain (kind, label, username, url, secret_sealed, key_id, origin, created_at, updated_at) VALUES ('manual', ?, ?, ?, ?, ?, 'manual', ?, ?)",
    args: [cleanText(label), cleanText(username), cleanText(url, 2048), sealSecret(secret, box(key)), key.id, ts, ts],
  });
  return { id: Number(r.lastInsertRowid) };
}

export async function listEntries(db, { now, keyId = null } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute(`SELECT ${META_COLS} FROM crow_keychain ORDER BY status ASC, label COLLATE NOCASE ASC, id ASC`);
  return rows.map((r) => toEntry(r, { now, keyId }));
}

export async function getEntry(db, id, { now, keyId = null } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: `SELECT ${META_COLS} FROM crow_keychain WHERE id = ?`, args: [Number(id)] });
  return toEntry(rows[0], { now, keyId });
}

export async function pendingFirstViews(db, { now, keyId = null } = {}) {
  await ensureKeychainTable(db);
  const { rows } = await db.execute({ sql: `SELECT ${META_COLS} FROM crow_keychain WHERE first_view_until IS NOT NULL AND first_view_until > ? ORDER BY id`, args: [iso(now)] });
  return rows.map((r) => toEntry(r, { now, keyId })).filter((e) => e.readable);
}

async function sealedRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT secret_sealed, key_id FROM crow_keychain WHERE id = ?", args: [Number(id)] });
  return rows[0] || null;
}

/** Plaintext; null when the id does not exist; KeychainKeyMissingError when sealed under another key. */
export async function openEntrySecret(db, key, id) {
  await ensureKeychainTable(db);
  const row = await sealedRow(db, id);
  if (!row) return null;
  if (!key || row.key_id !== key.id) throw new KeychainKeyMissingError();
  return openSecret(row.secret_sealed, box(key));
}

/** Atomically spends a live first-view grant. Plaintext once, then null forever. */
export async function consumeFirstView(db, key, id, { now } = {}) {
  await ensureKeychainTable(db);
  const row = await sealedRow(db, id);
  if (row && (!key || row.key_id !== key.id)) throw new KeychainKeyMissingError();
  const { rows } = await db.execute({
    sql: "UPDATE crow_keychain SET first_view_until = NULL WHERE id = ? AND first_view_until IS NOT NULL AND first_view_until > ? RETURNING secret_sealed",
    args: [Number(id), iso(now)],
  });
  if (!rows[0]) return null;
  return openSecret(rows[0].secret_sealed, box(key));
}

export async function deleteEntry(db, id) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "DELETE FROM crow_keychain WHERE id = ?", args: [Number(id)] });
  return r.rowsAffected > 0;
}

export async function markBundleRemoved(db, bundleId) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed', first_view_until = NULL, updated_at = ? WHERE kind = 'extension' AND bundle_id = ? AND status = 'active'", args: [iso(), bundleId] });
  return r.rowsAffected;
}

export async function reactivateBundleEntries(db, bundleId, envKeys) {
  await ensureKeychainTable(db);
  let n = 0;
  for (const k of envKeys || []) {
    const r = await db.execute({ sql: "UPDATE crow_keychain SET status = 'active', updated_at = ? WHERE kind = 'extension' AND bundle_id = ? AND env_key = ? AND status = 'extension_removed'", args: [iso(), bundleId, k] });
    n += r.rowsAffected;
  }
  return n;
}

/** Every READABLE entry with its plaintext, for the user's passphrase-encrypted Export. */
export async function exportableEntries(db, key) {
  requireKey(key);
  const out = [];
  for (const e of await listEntries(db, { keyId: key.id })) {
    if (!e.readable) continue;
    out.push({ kind: e.kind, label: e.label, bundle_id: e.bundle_id, env_key: e.env_key, username: e.username, url: e.url, origin: e.origin, status: e.status, secret: await openEntrySecret(db, key, e.id) });
  }
  return out;
}

/**
 * Import entries from a decrypted Export. Never overwrites a READABLE entry: an extension
 * entry whose bundle+key already has a readable row is skipped, and so is a manual entry
 * with the same label+username+url as a readable one. Unreadable rows (old key) for the
 * same bundle+key ARE replaced — that is the "restored on a new machine" recovery path.
 */
export async function importEntries(db, key, entries) {
  requireKey(key);
  const current = await listEntries(db, { keyId: key.id });
  let imported = 0;
  let skipped = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.secret !== "string" || e.secret === "" || !KINDS.has(e.kind) || !cleanText(e.label)) { skipped++; continue; }
    if (e.kind === "extension") {
      if (!e.bundle_id || !e.env_key) { skipped++; continue; }
      if (current.some((c) => c.kind === "extension" && c.bundle_id === e.bundle_id && c.env_key === e.env_key && c.readable)) { skipped++; continue; }
      const origin = e.origin === "generated" ? "generated" : "typed";
      const { id } = await saveExtensionSecret(db, key, { bundleId: e.bundle_id, envKey: e.env_key, label: e.label, username: e.username, url: e.url, secret: e.secret, origin });
      if (e.status === "extension_removed") await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed' WHERE id = ?", args: [id] });
      imported++;
    } else {
      const dup = current.some((c) => c.kind === "manual" && c.readable && c.label === cleanText(e.label) && (c.username || null) === cleanText(e.username) && (c.url || null) === cleanText(e.url, 2048));
      if (dup) { skipped++; continue; }
      await addManualSecret(db, key, { label: e.label, username: e.username, url: e.url, secret: e.secret });
      imported++;
    }
  }
  return { imported, skipped };
}
