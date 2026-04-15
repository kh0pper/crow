/**
 * S3-Compatible Storage Client
 *
 * Wraps the MinIO client for bucket initialization, presigned URLs,
 * and availability checks. Supports both MinIO and any S3-compatible
 * endpoint.
 *
 * Configuration precedence (DB > env):
 *   1. If initStorage({db, identity}) has been called and the DB has
 *      storage.shared.* keys, use those (sealed secrets opened with identity).
 *   2. Otherwise fall back to MINIO_* / S3_* env vars.
 *
 * The settings save handler + the instance-sync applier must call
 * resetStorageClient() after mutating storage.shared.* so the next
 * getClient() picks up fresh config.
 */

import * as Minio from "minio";
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

/**
 * Wire the storage client to the gateway's DB + identity so getClient()
 * can prefer DB-stored shared-storage over env vars. Safe to call multiple
 * times; subsequent calls refresh the cache.
 */
export async function initStorage({ db, identity }) {
  _boot.db = db || null;
  _boot.identity = identity || null;
  clientInstance = null;
  await _reloadCachedConfig();
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
    const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
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
  } catch (err) {
    console.warn("[storage] loadSharedStorageFromDb failed:", err.message);
    return null;
  }
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
  return DEFAULT_BUCKET_BASE;
}

/**
 * Get or create the MinIO/S3 client instance.
 * Returns null if not configured.
 */
export function getClient() {
  if (clientInstance) return clientInstance;

  let host, port, useSSL, accessKey, secretKey, source;
  const cfg = _cachedDbConfig;
  if (cfg) {
    host = cfg.host;
    port = cfg.port;
    useSSL = cfg.useSSL;
    accessKey = cfg.accessKey;
    secretKey = cfg.secretKey;
    source = "db";
  } else {
    const endpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT;
    if (!endpoint) return null;
    const parsed = _splitHostPort(endpoint);
    host = parsed.host;
    port = process.env.MINIO_PORT ? parseInt(process.env.MINIO_PORT, 10) : parsed.port;
    useSSL = process.env.MINIO_USE_SSL === "true";
    accessKey = process.env.S3_ACCESS_KEY || process.env.MINIO_ROOT_USER || "crowadmin";
    secretKey = process.env.S3_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD;
    if (!secretKey) return null;
    source = "env";
  }

  clientInstance = new Minio.Client({
    endPoint: host,
    port,
    useSSL,
    accessKey,
    secretKey,
  });
  console.log(`[storage] client: endpoint=${host}:${port} source=${source}`);
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
  if (!client) throw new Error("Storage not configured. Set MINIO_ENDPOINT and MINIO_ROOT_PASSWORD in .env or configure shared storage in the Nest.");
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
