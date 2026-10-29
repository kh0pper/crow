/**
 * Crow keychain — human-facing passwords, sealed with secret-box under the keychain's OWN
 * key (keychain/key.js), LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES). Secrets leave this
 * module only through openEntrySecret / consumeFirstView / exportableEntries, whose callers
 * gate and audit them, and serviceSecretsFor, which only the gateway's own connection test and
 * child spawn read (a project connection's secrets, kind 'service', keyed by connection uuid). Rows sealed under another key (a crow.db restored onto a machine
 * without the key file) are listed as readable:false and throw KeychainKeyMissingError on
 * open — never a crash, never a wrong plaintext.
 */
import { sealSecret, openSecret } from "../../sharing/secret-box.js";
import { KEYCHAIN_DDL, KEYCHAIN_CONNECTION_COLUMN, KEYCHAIN_SERVICE_INDEX_DDL } from "./schema.js";
import { keychainKeyState, createKeychainKey, KeychainKeyInvalidError } from "./key.js";

export const KEYCHAIN_TABLE = "crow_keychain";
export const FIRST_VIEW_MS = 30 * 60 * 1000;
const KINDS = new Set(["extension", "manual", "service"]);
const ORIGINS = new Set(["typed", "generated", "manual"]);

export class KeychainKeyMissingError extends Error {
  constructor() {
    super("The keychain key for this password is not on this machine.");
    this.code = "KEYCHAIN_KEY_MISSING";
  }
}

/** A kind 'service' row belongs to a project connection: it goes only with that connection. */
export class KeychainServiceRowError extends Error {
  constructor() {
    super("This key belongs to a project connection. Disconnect it on the project's Services page instead.");
    this.code = "KEYCHAIN_SERVICE_ROW";
  }
}

const META_COLS = "id, kind, label, bundle_id, env_key, username, url, origin, status, key_id, created_at, updated_at, first_view_until, connection_uuid";
const iso = (d) => (d instanceof Date ? d : new Date()).toISOString();
const cleanText = (v, max = 512) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).slice(0, max));
const box = (key) => ({ seed: key.seed });

function requireKey(key) {
  if (!key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed)) throw new KeychainKeyMissingError();
}

// Per client, the in-flight (then settled) ensure. Concurrent first callers share one promise, so
// the PRAGMA-then-ALTER below runs once; a failed ensure is forgotten, so the next call retries.
const ensuring = new WeakMap();
export function ensureKeychainTable(db) {
  let p = ensuring.get(db);
  if (!p) {
    p = runKeychainEnsure(db);
    ensuring.set(db, p);
    p.catch(() => { if (ensuring.get(db) === p) ensuring.delete(db); });
  }
  return p;
}

async function runKeychainEnsure(db) {
  await db.executeMultiple(KEYCHAIN_DDL);
  // A table created before migration 0019 lacks connection_uuid: add it before the index on it.
  const cols = (await db.execute("PRAGMA table_info(crow_keychain)")).rows.map((r) => r.name);
  if (!cols.includes(KEYCHAIN_CONNECTION_COLUMN.column)) await db.execute(KEYCHAIN_CONNECTION_COLUMN.ddl);
  await db.executeMultiple(KEYCHAIN_SERVICE_INDEX_DDL);
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

/**
 * A project connection's secret (kind 'service'), keyed by the connection's uuid, never its local
 * id: an id differs between machines, so an imported row could otherwise attach to someone else's
 * connection. Upsert on (connection_uuid, env_key). A row without a uuid is refused (the unique
 * index treats NULL uuids as distinct, so it could not stop duplicates).
 */
export async function saveServiceSecret(db, key, { connectionUuid, bundleId = null, envKey, label, secret, now } = {}) {
  await ensureKeychainTable(db);
  requireKey(key);
  if (typeof connectionUuid !== "string" || connectionUuid.trim() === "") throw new Error("keychain: a service secret needs a connection uuid");
  if (!envKey || typeof envKey !== "string" || typeof secret !== "string" || secret === "") throw new Error("keychain: envKey and a secret are required");
  const sealed = sealSecret(secret, box(key));
  const ts = iso(now);
  const lbl = cleanText(label) || envKey;
  const bundle = cleanText(bundleId, 200);
  const existing = (await db.execute({ sql: "SELECT id FROM crow_keychain WHERE kind = 'service' AND connection_uuid = ? AND env_key = ?", args: [connectionUuid, envKey] })).rows[0];
  // ON CONFLICT covers a concurrent first save for the same pair (the partial unique index).
  const r = await db.execute({
    sql: `INSERT INTO crow_keychain (kind, label, bundle_id, env_key, secret_sealed, key_id, origin, status, connection_uuid, created_at, updated_at)
          VALUES ('service', ?, ?, ?, ?, ?, 'typed', 'active', ?, ?, ?)
          ON CONFLICT (connection_uuid, env_key) WHERE kind = 'service' DO UPDATE SET
            label = excluded.label, bundle_id = excluded.bundle_id, secret_sealed = excluded.secret_sealed, key_id = excluded.key_id,
            origin = 'typed', status = 'active', first_view_until = NULL, updated_at = excluded.updated_at
          RETURNING id`,
    args: [lbl, bundle, envKey, sealed, key.id, connectionUuid, ts, ts],
  });
  return { id: Number(r.rows[0].id), created: !existing };
}

/**
 * Gateway-internal: a connection's secrets as {envKey: plaintext}, for the connection's own child
 * and live test only (never a response, log or audit row). Only active rows sealed under this key,
 * and only env keys the service itself declares (allowedKeys): any other key on a row is never
 * returned. No key, no uuid or no allowedKeys → {} (fails closed). A row that fails to open is skipped.
 */
export async function serviceSecretsFor(db, key, connectionUuid, { allowedKeys } = {}) {
  await ensureKeychainTable(db);
  if (!key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed)) return {};
  if (typeof connectionUuid !== "string" || connectionUuid === "" || !Array.isArray(allowedKeys) || allowedKeys.length === 0) return {};
  const allowed = new Set(allowedKeys.filter((k) => typeof k === "string" && k));
  const { rows } = await db.execute({
    sql: "SELECT env_key, secret_sealed FROM crow_keychain WHERE kind = 'service' AND connection_uuid = ? AND key_id = ? AND status = 'active' ORDER BY id",
    args: [connectionUuid, key.id],
  });
  const out = {};
  for (const r of rows) {
    if (!allowed.has(r.env_key)) continue;
    try {
      const v = openSecret(r.secret_sealed, box(key));
      if (typeof v === "string" && v) out[r.env_key] = v;
    } catch { /* damaged row: skip, never log */ }
  }
  return out;
}

/** Removes every secret of one connection (disconnect). */
export async function deleteServiceSecrets(db, connectionUuid) {
  await ensureKeychainTable(db);
  if (typeof connectionUuid !== "string" || connectionUuid === "") return { deleted: 0 };
  const r = await db.execute({ sql: "DELETE FROM crow_keychain WHERE kind = 'service' AND connection_uuid = ?", args: [connectionUuid] });
  return { deleted: r.rowsAffected };
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

/** Deletes one entry. A service row is refused (KeychainServiceRowError): disconnect its connection. */
export async function deleteEntry(db, id) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "DELETE FROM crow_keychain WHERE id = ? AND kind != 'service'", args: [Number(id)] });
  if (r.rowsAffected > 0) return true;
  const svc = await db.execute({ sql: "SELECT 1 FROM crow_keychain WHERE id = ? AND kind = 'service'", args: [Number(id)] });
  if (svc.rows.length) throw new KeychainServiceRowError();
  return false;
}

export async function markBundleRemoved(db, bundleId) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed', first_view_until = NULL, updated_at = ? WHERE kind IN ('extension', 'service') AND bundle_id = ? AND status = 'active'", args: [iso(), bundleId] });
  return r.rowsAffected;
}

/** Whether an extension entry (any status) exists for bundle+key. */
export async function hasExtensionEntry(db, bundleId, envKey) {
  await ensureKeychainTable(db);
  const r = await db.execute({ sql: "SELECT 1 FROM crow_keychain WHERE kind = 'extension' AND bundle_id = ? AND env_key = ? LIMIT 1", args: [bundleId, envKey] });
  return r.rows.length > 0;
}

export async function reactivateBundleEntries(db, bundleId, envKeys) {
  await ensureKeychainTable(db);
  let n = 0;
  for (const k of envKeys || []) {
    const r = await db.execute({ sql: "UPDATE crow_keychain SET status = 'active', updated_at = ? WHERE kind = 'extension' AND bundle_id = ? AND env_key = ? AND status = 'extension_removed'", args: [iso(), bundleId, k] });
    n += r.rowsAffected;
  }
  // A reinstall brings back every project connection's secrets for this bundle.
  const svc = await db.execute({ sql: "UPDATE crow_keychain SET status = 'active', updated_at = ? WHERE kind = 'service' AND bundle_id = ? AND status = 'extension_removed'", args: [iso(), bundleId] });
  return n + svc.rowsAffected;
}

/** Every READABLE entry with its plaintext, for the user's passphrase-encrypted Export. */
export async function exportableEntries(db, key) {
  requireKey(key);
  const out = [];
  for (const e of await listEntries(db, { keyId: key.id })) {
    if (!e.readable) continue;
    out.push({ kind: e.kind, label: e.label, bundle_id: e.bundle_id, env_key: e.env_key, username: e.username, url: e.url, origin: e.origin, status: e.status, connection_uuid: e.connection_uuid || null, secret: await openEntrySecret(db, key, e.id) });
  }
  return out;
}

/**
 * Every readable entry's plaintext, SYNCHRONOUSLY, from a better-sqlite3 handle (the bot
 * engine's driver). Only for the bot secret-values file (servers/shared/secret-values-collect.js),
 * which hides these values from approval cards and pushes; never returned to a client.
 * Rows sealed under another key, a missing table, or a row that fails to open are skipped.
 */
export function readableSecretsSync(rawDb, key) {
  if (!key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed)) return [];
  let rows;
  try {
    rows = rawDb.prepare("SELECT id, kind, label, secret_sealed FROM crow_keychain WHERE key_id = ?").all(key.id);
  } catch {
    return [];
  }
  const out = [];
  for (const r of rows) {
    try {
      const v = openSecret(r.secret_sealed, box(key));
      if (typeof v === "string" && v) out.push({ id: Number(r.id), kind: r.kind, label: r.label, secret: v });
    } catch { /* damaged row: skip */ }
  }
  return out;
}

/**
 * Import entries from a decrypted Export. Never overwrites a READABLE entry: an extension
 * entry whose bundle+key already has a readable row is skipped, and so is a manual entry
 * with the same label+username+url as a readable one. Unreadable rows (old key) for the
 * same bundle+key ARE replaced — that is the "restored on a new machine" recovery path.
 * A service entry keeps its connection_uuid as is and is matched on (uuid, env_key) only: it is
 * never attached to a local connection by id or label. A uuid no local connection has stays
 * unattached for good (uuids are never reused), so its secret reaches no child.
 */
export async function importEntries(db, key, entries) {
  requireKey(key);
  const current = await listEntries(db, { keyId: key.id });
  let imported = 0;
  let skipped = 0;
  const ids = [];
  for (let e of Array.isArray(entries) ? entries : []) {
    // A non-http(s) url is dropped (not the entry) so an otherwise-good export still imports.
    if (e && typeof e.url === "string" && e.url && !/^https?:\/\//i.test(e.url)) e = { ...e, url: null };
    if (!e || typeof e.secret !== "string" || e.secret === "" || !KINDS.has(e.kind) || !cleanText(e.label)) { skipped++; continue; }
    if (e.kind === "extension") {
      if (!e.bundle_id || !e.env_key) { skipped++; continue; }
      if (current.some((c) => c.kind === "extension" && c.bundle_id === e.bundle_id && c.env_key === e.env_key && c.readable)) { skipped++; continue; }
      const origin = e.origin === "generated" ? "generated" : "typed";
      const { id } = await saveExtensionSecret(db, key, { bundleId: e.bundle_id, envKey: e.env_key, label: e.label, username: e.username, url: e.url, secret: e.secret, origin });
      if (e.status === "extension_removed") await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed' WHERE id = ?", args: [id] });
      ids.push(id);
      imported++;
    } else if (e.kind === "service") {
      const uuid = typeof e.connection_uuid === "string" ? e.connection_uuid.trim() : "";
      if (!uuid || !e.env_key) { skipped++; continue; }
      if (current.some((c) => c.kind === "service" && c.connection_uuid === uuid && c.env_key === e.env_key && c.readable)) { skipped++; continue; }
      const { id } = await saveServiceSecret(db, key, { connectionUuid: uuid, bundleId: e.bundle_id || null, envKey: e.env_key, label: e.label, secret: e.secret });
      if (e.status === "extension_removed") await db.execute({ sql: "UPDATE crow_keychain SET status = 'extension_removed' WHERE id = ?", args: [id] });
      ids.push(id);
      imported++;
    } else {
      const dup = current.some((c) => c.kind === "manual" && c.readable && c.label === cleanText(e.label) && (c.username || null) === cleanText(e.username) && (c.url || null) === cleanText(e.url, 2048));
      if (dup) { skipped++; continue; }
      await addManualSecret(db, key, { label: e.label, username: e.username, url: e.url, secret: e.secret });
      imported++;
    }
  }
  return { imported, skipped, ids };
}
