/**
 * S3-Compatible Storage Client
 *
 * Wraps the MinIO client for bucket initialization, presigned URLs,
 * and availability checks. Supports both MinIO and any S3-compatible
 * endpoint.
 *
 * Configuration precedence (hydrated > DB > env):
 *   0. A bot's MCP child is HYDRATED: the bot engine opened this instance's
 *      Shared Storage settings (in its own process, which may read the
 *      identity) and piped only the opened config into the block's env, under
 *      CROW_STORAGE_FROM_HOST=1 (see STORAGE_FROM_HOST_ENV / adoptHostStorage).
 *      Such a child never reads identity.json and never falls back to the
 *      environment, so a bot whose sandbox masks the identity file still has
 *      storage. A file-delivery bot turn gets the marker with no settings: no
 *      shared storage at all, with one line saying so.
 *   1. If initStorage({db, identity}) has been called and the DB has
 *      storage.shared.* keys, use those (sealed secrets opened with identity).
 *      The gateway, the stdio storage server and bundle MCP children all do.
 *   2. Otherwise fall back to the env: S3_ENDPOINT (+ S3_ACCESS_KEY, S3_SECRET_KEY,
 *      S3_USE_SSL, S3_REGION, S3_BUCKET_PREFIX), else the older MINIO_ENDPOINT
 *      (+ MINIO_PORT, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, MINIO_USE_SSL). Port
 *      and SSL come from the same family as the endpoint: a leftover MINIO_PORT
 *      never lands on top of S3_ENDPOINT.
 *
 * The settings save handler + the instance-sync applier must call
 * resetStorageClient() after mutating storage.shared.* so the next
 * getClient() picks up fresh config.
 *
 * OWNER PATH vs BOT PATH: an owner's own stdio server (the generated
 * ~/.pi/agent config, the combined crow-core server) has no
 * CROW_STORAGE_FROM_HOST in its env and runs rule 1 then rule 2 exactly as
 * before. A bot's child ALWAYS has the marker: `1` (the settings above were
 * piped) or `0` (a file-delivery turn, which cannot carry them, or a block
 * that does not declare `needs: ["shared-storage"]` at all) — see
 * adoptHostStorage. Rule 1 is the only code here that touches the identity or
 * the seal helpers, and it is host-side: the bot engine, the gateway, and an
 * owner's own spawn; useDbStorageConfigFromInstance reads the marker itself,
 * so even a child that skipped adoptHostStorage cannot reach it inside a bot.
 */

import * as Minio from "minio";
import { createRequire } from "node:module";
import { openSecret, isSealed } from "../sharing/secret-box.js";

const DEFAULT_BUCKET_BASE = "crow-files";
const SHARED_KEYS = [
  "storage.shared.endpoint",
  "storage.shared.use_ssl",
  "storage.shared.region",
  "storage.shared.bucket_prefix",
  "storage.shared.access_key",
  "storage.shared.secret_key",
];

let clientInstance = null;
let _boot = { db: null, identity: null };
let _cachedDbConfig = null; // parsed + opened plaintext, or null if DB has no full config
// Why this process runs with NO storage at all, or null. Set only by
// useNoStorage() (a bot turn the bridge could not hydrate): never a silent
// fallback to the env, which for a sandboxed bot points at a localhost:9000
// where nothing listens.
let _offReason = null;

/**
 * The env var a hydrated bot block carries (see adoptHostStorage).
 *
 *  "1" / "true" / "on" — the opened Shared Storage settings are in this env (S3_*).
 *  anything else that is set — a file-delivery bot turn: NO shared storage.
 *  absent — not a bot turn: the owner's own spawn, which reads the identity.
 */
export const STORAGE_FROM_HOST_ENV = "CROW_STORAGE_FROM_HOST";

/** The env names a hydrated block's opened settings travel under (never a seed). */
export const STORAGE_SETTING_ENV_NAMES = Object.freeze([
  "S3_ENDPOINT", "S3_USE_SSL", "S3_REGION", "S3_BUCKET_PREFIX", "S3_ACCESS_KEY", "S3_SECRET_KEY",
]);

/** Why a child has no storage on a file-delivery bot turn (one fixed sentence). */
export const STORAGE_OFF_FILE_DELIVERY =
  "no shared storage in this turn (a file-delivery MCP config cannot carry the credentials)";
/** Why a child has no storage when the host's settings were incomplete (one fixed sentence). */
export const STORAGE_OFF_NO_SETTINGS =
  "the shared storage settings the host sent are incomplete";


/**
 * Wire the storage client to the gateway's DB + identity so getClient()
 * can prefer DB-stored shared-storage over env vars. Safe to call multiple
 * times; subsequent calls refresh the cache.
 */
export async function initStorage({ db, identity }) {
  _boot.db = db || null;
  _boot.identity = identity || null;
  _offReason = null;
  clientInstance = null;
  await _reloadCachedConfig();
}

/**
 * A stdio server's boot (servers/storage/index.js, the combined crow-core server): the
 * same initStorage the gateway runs, with this instance's identity. The identity is
 * loaded, never created: a stdio child must not mint an instance identity, and without
 * one there are no sealed settings to open. Never throws; returns whether it wired up.
 */
export async function initStorageFromInstance(db) {
  // A bot's child: the bridge already decided, and identity.json is never touched (it may be
  // masked, and it is the one file no bot process reads). "off" is a file-delivery turn.
  if (adoptHostStorage()) return storageFromHostMode() === "on";
  try {
    const { loadIdentityIfPresent } = await import("../sharing/identity.js");
    const identity = loadIdentityIfPresent();
    if (!identity) return false;
    await initStorage({ db, identity });
    return true;
  } catch (err) {
    console.error(`[storage] initStorage failed (env fallback remains active): ${err.message}`);
    return false;
  }
}

/**
 * Use a shared-storage config that the caller already opened (the result of
 * loadSharedStorageFromDb) WITHOUT keeping the identity that opened it. For
 * bundle MCP children: they need the storage credentials, not the instance's
 * root seed, so they open the config, wipe the identity and hand only the
 * config here. resetStorageClient() cannot reload it (no db/identity kept).
 */
export function useStorageConfig(cfg) {
  _boot = { db: null, identity: null };
  _cachedDbConfig = cfg || null;
  _offReason = null;
  clientInstance = null;
}

/**
 * This process runs with NO shared storage: no cached config, and getClient() answers null
 * however the environment looks. One warning line, once, naming the reason (never a value).
 * For a file-delivery bot turn (adoptHostStorage).
 */
export function useNoStorage(reason = STORAGE_OFF_NO_SETTINGS) {
  const text = String(reason);
  const first = _offReason !== text; // one line per reason, not one per storage call
  _boot = { db: null, identity: null };
  _cachedDbConfig = null;
  _offReason = text;
  clientInstance = null;
  if (first) console.error(`[storage] ${text}`);
  return false;
}

/** Why this process has no storage (`null` when it may have one). */
export function storageOffReason() {
  return _offReason;
}

/**
 * What the bridge put in this process's env: "on" (the opened Shared Storage settings are
 * here), "off" (a bot turn with no shared storage at all), or null (not a bot turn — an
 * owner's own stdio spawn, which reads the identity exactly as before).
 */
export function storageFromHostMode(env = process.env) {
  const raw = String(((env || {})[STORAGE_FROM_HOST_ENV]) ?? "").trim().toLowerCase();
  if (raw === "") return null;
  return raw === "1" || raw === "true" || raw === "on" ? "on" : "off";
}

/**
 * The env a hydrated MCP block carries: the opened settings as S3_* (the same names the env
 * fallback reads, so nothing downstream changes shape) plus the marker. Only these seven —
 * no MINIO_*, no CROW_*, no seed, no seal key.
 * @param {object} cfg the opened config (loadSharedStorageFromDb / envStorageConfig)
 */
export function storageHydrationEnv(cfg) {
  return {
    [STORAGE_FROM_HOST_ENV]: "1",
    S3_ENDPOINT: String(cfg.endpoint || `${cfg.host}:${cfg.port}`),
    S3_USE_SSL: cfg.useSSL ? "true" : "false",
    S3_REGION: cfg.region || "us-east-1",
    S3_BUCKET_PREFIX: cfg.bucketPrefix || "crow",
    S3_ACCESS_KEY: String(cfg.accessKey || ""),
    S3_SECRET_KEY: String(cfg.secretKey || ""),
  };
}

/**
 * The ONE call a bot's storage-using child makes at boot (crow-storage,
 * initStorageFromInstance; studio, sunvox-studio and data-dashboard, at their storage
 * bootstrap).
 *
 *   "hydrated" — the bridge piped this instance's opened settings (marker "1"): use them,
 *                and never read identity.json or the env fallback.
 *   "off"      — a bot turn: NO shared storage at all. A file-delivery config cannot carry
 *                the credentials, so the child refuses instead of falling back to whatever
 *                env it inherited (for a sandboxed bot that is localhost:9000, where nothing
 *                listens — the silent breakage this replaces). One warning line says so.
 *   null       — not a bot turn (an owner's own spawn): the caller keeps today's path.
 * @returns {"hydrated"|"off"|null}
 */
export function adoptHostStorage(env = process.env) {
  const mode = storageFromHostMode(env);
  if (mode === null) return null;
  if (mode === "on") {
    const cfg = envStorageConfig(env);
    if (cfg && cfg.secretKey) {
      useStorageConfig(cfg);
      return "hydrated";
    }
    // A hydrated block with no usable endpoint is a bridge bug: fail closed rather than fall
    // back to ambient env the child happened to inherit.
    useNoStorage(STORAGE_OFF_NO_SETTINGS);
    return "off";
  }
  useNoStorage(STORAGE_OFF_FILE_DELIVERY);
  return "off";
}

/**
 * Bundle MCP children: open the instance's Shared Storage settings once with `identity`,
 * zero the identity's key buffers straight away, and keep only the opened config
 * (useStorageConfig). Returns true when the DB held a full config. With none, the env
 * fallback stays in effect.
 */
export async function useDbStorageConfig({ db, identity }) {
  if (!db || !identity) return false;
  let cfg = null;
  try {
    cfg = await loadSharedStorageFromDb(db, identity);
  } finally {
    for (const v of Object.values(identity)) if (v instanceof Uint8Array) v.fill(0);
  }
  if (cfg) useStorageConfig(cfg);
  return !!cfg;
}

/**
 * A bundle child's OWNER path — the operator's own stdio spawn — load this instance's identity
 * (only if it exists; a stdio child never mints one), open the Shared Storage settings and keep
 * only the opened config.
 *
 * The identity import is lazy and lives HERE, so no bundle child contains a seed reference at
 * all (tests/bot-seed-import-guard.test.js). A BOT turn never reaches the identity: the marker is
 * read FIRST (adoptHostStorage), so a child that forgot to call adoptHostStorage at boot — an
 * undeclared consumer, a copy from before its `needs` bump — still cannot take this path. With:
 *
 *   "hydrated" — the spawning process already piped the opened settings: adoptHostStorage wired
 *                them, nothing is read here;
 *   "off"      — a bot turn with NO shared storage (a file-delivery config): adoptHostStorage
 *                turned the env fallback off too, and the identity is never touched.
 *
 * @returns {Promise<boolean>} true when a config was wired up from the DB
 */
export async function useDbStorageConfigFromInstance(db) {
  const hostStorage = adoptHostStorage();
  if (hostStorage !== null) return hostStorage === "hydrated";
  if (!db) return false;
  try {
    const { loadIdentityIfPresent } = await import("../sharing/identity.js");
    const identity = typeof loadIdentityIfPresent === "function" ? loadIdentityIfPresent() : null;
    if (!identity) return false;
    return await useDbStorageConfig({ db, identity });
  } catch {
    return false; // no identity, or an unreadable one: the env fallback stays in effect
  }
}

/**
 * Read the six storage.shared.* keys. Returns null if any required field is
 * missing (endpoint, access_key, secret_key) so getClient() falls back cleanly
 * during a half-synced window. Secrets are opened via secret-box; if opening
 * fails (wrong identity, tampering), throws.
 */
export async function loadSharedStorageFromDb(db, identity) {
  if (!db || !identity) return null;
  try {
    const placeholders = SHARED_KEYS.map(() => "?").join(",");
    const { rows } = await db.execute({
      sql: `SELECT key, value FROM dashboard_settings WHERE key IN (${placeholders})`,
      args: SHARED_KEYS,
    });
    return _configFromRows(rows, identity);
  } catch (err) {
    console.warn("[storage] loadSharedStorageFromDb failed:", err.message);
    return null;
  }
}

/**
 * Why a host-side read of the instance's Shared Storage settings has no config.
 *
 *   SHARED_STORAGE_NO_SETTINGS — a normal state: no identity file on this host at all, or the six
 *     storage.shared.* rows are not all there (an env-only install). Nothing is wrong.
 *   SHARED_STORAGE_UNREADABLE  — a fault: the DB could not be opened or read, a sealed value
 *     could not be opened (wrong identity, tampering), or the identity file exists but cannot be
 *     opened (permissions, corrupt JSON, an encrypted seed with no passphrase).
 *
 * The bot engine reports the two differently (one warning each): "not configured" and
 * "could not be read" are not the same line to the operator, and neither may ever be
 * confused with the operator's own storage environment in the S3_* or MINIO_* names (a bot
 * never gets those).
 */
export const SHARED_STORAGE_NO_SETTINGS = "no-settings";
export const SHARED_STORAGE_UNREADABLE = "unreadable";

/**
 * The same read through a SYNCHRONOUS read-only sqlite handle, for the bot engine's hydrate
 * step: it builds an in-memory MCP config in one synchronous pass (the same shape as
 * readAddonSecretsSync), so it cannot await a driver. `dbPath` is this instance's crow.db
 * (botsDbPath() in the bot engine); the handle is opened read-only, closed here, and never
 * touches the identity file itself — the caller hands the identity in.
 *
 * Answers WHY there is no config (see SHARED_STORAGE_NO_SETTINGS / SHARED_STORAGE_UNREADABLE):
 * a caller that must tell "nothing configured" from "could not read it" needs the difference.
 * @returns {{ok: true, config: object} | {ok: false, reason: "no-settings"|"unreadable"}}
 */
export function readSharedStorageSettingsSync(dbPath, identity) {
  if (typeof dbPath !== "string" || dbPath === "" || !identity) {
    return { ok: false, reason: SHARED_STORAGE_NO_SETTINGS };
  }
  let db = null;
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3");
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    const placeholders = SHARED_KEYS.map(() => "?").join(",");
    const rows = db.prepare(`SELECT key, value FROM dashboard_settings WHERE key IN (${placeholders})`)
      .all(...SHARED_KEYS);
    const config = _configFromRows(rows, identity);
    // Rows present but incomplete is the same normal state as no rows at all.
    return config ? { ok: true, config } : { ok: false, reason: SHARED_STORAGE_NO_SETTINGS };
  } catch (err) {
    console.warn("[storage] shared storage settings could not be read:", err.message);
    return { ok: false, reason: SHARED_STORAGE_UNREADABLE };
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
}

/**
 * The opened config from the synchronous reader, or null for BOTH "no settings" and
 * "could not read it". Callers that must tell them apart use readSharedStorageSettingsSync.
 * @returns {object|null}
 */
export function loadSharedStorageFromDbSync(dbPath, identity) {
  const read = readSharedStorageSettingsSync(dbPath, identity);
  return read.ok ? read.config : null;
}

/**
 * The six storage.shared.* rows as an opened config. THE one place the key names, the seal
 * opening and the endpoint parsing live — the async and the sync reader (and the sync one's
 * caller in the bot engine) share it, so the two cannot drift.
 */
function _configFromRows(rows, identity) {
  const kv = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  const endpoint = kv["storage.shared.endpoint"];
  const accessSealed = kv["storage.shared.access_key"];
  const secretSealed = kv["storage.shared.secret_key"];
  if (!endpoint || !accessSealed || !secretSealed) return null;
  const accessKey = isSealed(accessSealed) ? openSecret(accessSealed, identity) : accessSealed;
  const secretKey = isSealed(secretSealed) ? openSecret(secretSealed, identity) : secretSealed;
  const { host, port } = _splitHostPort(endpoint);
  return {
    endpoint,
    host,
    port,
    useSSL: kv["storage.shared.use_ssl"] === "true" || kv["storage.shared.use_ssl"] === "1",
    region: kv["storage.shared.region"] || "us-east-1",
    bucketPrefix: kv["storage.shared.bucket_prefix"] || "crow",
    accessKey,
    secretKey,
  };
}

async function _reloadCachedConfig() {
  if (!_boot.db || !_boot.identity) { _cachedDbConfig = null; return; }
  _cachedDbConfig = await loadSharedStorageFromDb(_boot.db, _boot.identity);
}

function _splitHostPort(endpoint) {
  // Accepts "host", "host:port", or "scheme://host:port" — only the host:port
  // matters; scheme is taken from the use_ssl flag.
  let s = String(endpoint).trim();
  s = s.replace(/^https?:\/\//, "");
  // Strip any trailing path
  s = s.split("/")[0];
  const colon = s.lastIndexOf(":");
  if (colon === -1) return { host: s, port: 9000 };
  const host = s.slice(0, colon);
  const port = parseInt(s.slice(colon + 1), 10) || 9000;
  return { host, port };
}

/**
 * Invalidate the cached client + DB config. The next getClient() call will
 * rebuild from DB (if initStorage was wired) or env. Called by the Shared
 * Storage save handler and the debounced instance-sync applier.
 */
export function resetStorageClient() {
  clientInstance = null;
  if (_offReason) return; // a bot turn with no storage stays that way for this process
  if (_boot.db && _boot.identity) {
    // Fire-and-forget cache refresh. Next getClient() will see updated cache.
    _reloadCachedConfig().catch((err) =>
      console.warn("[storage] resetStorageClient reload failed:", err.message),
    );
  }
}

/**
 * Default bucket for the user-uploads surface. Prefix derives from DB config
 * when present; falls back to the legacy `crow-files` constant.
 */
export function defaultBucket() {
  if (_cachedDbConfig?.bucketPrefix) return `${_cachedDbConfig.bucketPrefix}-files`;
  // The env path carries a prefix too (S3_BUCKET_PREFIX): a customised prefix must not write
  // into crow-files. Read lazily, so a hydrated/a DB config always wins.
  const env = envStorageConfig();
  if (env?.bucketPrefix) return `${env.bucketPrefix}-files`;
  return DEFAULT_BUCKET_BASE;
}

/**
 * Browser-reachable origin for the configured storage endpoint — e.g.
 * "http://localhost:9000" or "https://s3.example.com:443". Returns
 * null when storage isn't configured. Used by the gateway CSP middleware
 * to allow <img src="..."> with presigned URLs without enabling a
 * blanket host. The origin is taken from the DB config if present; env
 * fallback reads MINIO_ENDPOINT + MINIO_USE_SSL.
 */
export function getStorageOrigin() {
  if (_offReason) return null;
  const cfg = _cachedDbConfig;
  if (cfg?.host) {
    const scheme = cfg.useSSL ? "https" : "http";
    return `${scheme}://${cfg.host}:${cfg.port || (cfg.useSSL ? 443 : 9000)}`;
  }
  const env = envStorageConfig();
  if (!env) return null;
  return `${env.useSSL ? "https" : "http"}://${env.host}:${env.port}`;
}

/**
 * The env fallback, or null when no endpoint is set. S3_* wins over MINIO_*; the port
 * and SSL flag are read from the endpoint's own family only (MINIO_PORT applies to
 * MINIO_ENDPOINT, never to S3_ENDPOINT). Credentials keep their old fallback order.
 */
export function envStorageConfig(env = process.env) {
  const s3 = env.S3_ENDPOINT;
  const endpoint = s3 || env.MINIO_ENDPOINT;
  if (!endpoint) return null;
  const parsed = _splitHostPort(endpoint);
  const port = (!s3 && parseInt(env.MINIO_PORT, 10)) || parsed.port;
  const useSSL = String((s3 ? env.S3_USE_SSL : env.MINIO_USE_SSL) || "").toLowerCase() === "true";
  return {
    source: s3 ? "S3_ENDPOINT" : "MINIO_ENDPOINT",
    endpoint: `${parsed.host}:${port}`,
    host: parsed.host,
    port,
    useSSL,
    region: env.S3_REGION || "us-east-1",
    // The DB settings have always carried a bucket prefix; the env path did not, so a
    // customised prefix silently wrote into crow-files. Same default as the DB read.
    bucketPrefix: env.S3_BUCKET_PREFIX || "",
    accessKey: env.S3_ACCESS_KEY || env.MINIO_ROOT_USER || "crowadmin",
    secretKey: env.S3_SECRET_KEY || env.MINIO_ROOT_PASSWORD || "",
  };
}

/** True when storage is configured at all (hydrated/DB settings, or a usable env fallback). */
export function isConfigured() {
  if (_offReason) return false;
  if (_cachedDbConfig) return true;
  const env = envStorageConfig();
  return !!(env && env.secretKey);
}

/**
 * Get or create the MinIO/S3 client instance.
 * Returns null if not configured.
 */
export function getClient() {
  if (_offReason) return null; // a bot turn with no shared storage: never the env fallback
  if (clientInstance) return clientInstance;

  let host, port, useSSL, accessKey, secretKey, region, source;
  const cfg = _cachedDbConfig;
  if (cfg) {
    ({ host, port, useSSL, accessKey, secretKey } = cfg);
    region = cfg.region || "us-east-1";
    source = "db";
  } else {
    const env = envStorageConfig();
    if (!env || !env.secretKey) return null;
    ({ host, port, useSSL, accessKey, secretKey, region } = env);
    source = `env ${env.source}`;
  }

  // region explicitly: Garage refuses any region but its s3_region, and without one
  // minio-js may first ask the server which region a bucket is in.
  clientInstance = new Minio.Client({
    endPoint: host,
    port,
    useSSL,
    accessKey,
    secretKey,
    region,
  });
  // stderr, not stdout: the stdio storage server speaks MCP on stdout.
  console.error(`[storage] client: endpoint=${host}:${port} source=${source}`);
  return clientInstance;
}

/**
 * Check if the S3/MinIO backend is available and responding.
 */
export async function isAvailable() {
  const client = getClient();
  if (!client) return false;
  try {
    await client.listBuckets();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the default bucket exists. Creates it if missing.
 * @param {string} [bucket]
 */
export async function ensureBucket(bucket) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured. Install File Storage (Garage) from Extensions, or configure Shared Storage in the Nest.");
  const target = bucket || defaultBucket();
  const exists = await client.bucketExists(target);
  if (!exists) {
    await client.makeBucket(target);
  }
}

/**
 * Upload a Buffer to S3.
 * @param {string} key - Object key (path in bucket)
 * @param {Buffer} data - File data
 * @param {object} [opts]
 * @param {string} [opts.bucket]
 * @param {string} [opts.contentType]
 */
export async function uploadObject(key, data, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  const bucket = opts.bucket || defaultBucket();
  await ensureBucket(bucket);
  const metaData = opts.contentType ? { "Content-Type": opts.contentType } : {};
  await client.putObject(bucket, key, data, data.length, metaData);
}

/**
 * Generate a presigned download URL.
 * @param {string} key
 * @param {object} [opts]
 * @param {string} [opts.bucket]
 * @param {number} [opts.expiry] - Seconds (default 3600 = 1 hour)
 */
export async function getPresignedUrl(key, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  const bucket = opts.bucket || defaultBucket();
  const expiry = opts.expiry || 3600;
  return client.presignedGetObject(bucket, key, expiry);
}

/**
 * Generate a presigned upload URL for direct browser uploads.
 * @param {string} key
 * @param {object} [opts]
 * @param {string} [opts.bucket]
 * @param {number} [opts.expiry] - Seconds (default 3600)
 */
export async function getPresignedUploadUrl(key, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  const bucket = opts.bucket || defaultBucket();
  const expiry = opts.expiry || 3600;
  await ensureBucket(bucket);
  return client.presignedPutObject(bucket, key, expiry);
}

/**
 * Get an object as a readable stream.
 * @param {string} key
 * @param {object} [opts]
 * @param {string} [opts.bucket]
 * @returns {Promise<{stream: ReadableStream, stat: {size: number, metaData: object}}>}
 */
export async function getObject(key, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  const bucket = opts.bucket || defaultBucket();
  const stat = await client.statObject(bucket, key);
  const stream = await client.getObject(bucket, key);
  return { stream, stat };
}

/**
 * Delete an object from S3.
 * @param {string} key
 * @param {string} [bucket]
 */
export async function deleteObject(key, bucket) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  await client.removeObject(bucket || defaultBucket(), key);
}

/**
 * List objects in a bucket with optional prefix filter.
 * @param {object} [opts]
 * @param {string} [opts.bucket]
 * @param {string} [opts.prefix]
 * @returns {Promise<Array<{name: string, size: number, lastModified: Date}>>}
 */
export async function listObjects(opts = {}) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  const bucket = opts.bucket || defaultBucket();
  await ensureBucket(bucket);

  return new Promise((resolve, reject) => {
    const objects = [];
    const stream = client.listObjectsV2(bucket, opts.prefix || "", true);
    stream.on("data", (obj) => objects.push(obj));
    stream.on("error", reject);
    stream.on("end", () => resolve(objects));
  });
}

/**
 * Get bucket statistics (total size, file count).
 * @param {string} [bucket]
 */
export async function getBucketStats(bucket) {
  const objects = await listObjects({ bucket: bucket || defaultBucket() });
  const totalSize = objects.reduce((sum, obj) => sum + (obj.size || 0), 0);
  return { fileCount: objects.length, totalSizeBytes: totalSize };
}

// Blocked MIME types (executables)
const BLOCKED_MIME_TYPES = new Set([
  "application/x-executable",
  "application/x-msdos-program",
  "application/x-msdownload",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-bat",
  "application/x-msi",
]);

/**
 * Validate that a MIME type is allowed for upload.
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isAllowedMimeType(mimeType) {
  if (!mimeType) return true; // Allow unknown types
  return !BLOCKED_MIME_TYPES.has(mimeType);
}
