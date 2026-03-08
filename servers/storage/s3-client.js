/**
 * S3-Compatible Storage Client
 *
 * Wraps the MinIO client for bucket initialization, presigned URLs,
 * and availability checks. Supports both MinIO and any S3-compatible
 * endpoint via environment variables.
 */

import * as Minio from "minio";

const DEFAULT_BUCKET = "crow-files";

let clientInstance = null;

/**
 * Get or create the MinIO/S3 client instance.
 * Returns null if not configured.
 */
export function getClient() {
  if (clientInstance) return clientInstance;

  const endpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT;
  if (!endpoint) return null;

  const port = parseInt(process.env.MINIO_PORT || "9000", 10);
  const useSSL = process.env.MINIO_USE_SSL === "true";
  const accessKey = process.env.S3_ACCESS_KEY || process.env.MINIO_ROOT_USER || "crowadmin";
  const secretKey = process.env.S3_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD;

  if (!secretKey) return null;

  clientInstance = new Minio.Client({
    endPoint: endpoint,
    port,
    useSSL,
    accessKey,
    secretKey,
  });

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
export async function ensureBucket(bucket = DEFAULT_BUCKET) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured. Set MINIO_ENDPOINT and MINIO_ROOT_PASSWORD in .env");
  const exists = await client.bucketExists(bucket);
  if (!exists) {
    await client.makeBucket(bucket);
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
  const bucket = opts.bucket || DEFAULT_BUCKET;
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
  const bucket = opts.bucket || DEFAULT_BUCKET;
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
  const bucket = opts.bucket || DEFAULT_BUCKET;
  const expiry = opts.expiry || 3600;
  await ensureBucket(bucket);
  return client.presignedPutObject(bucket, key, expiry);
}

/**
 * Delete an object from S3.
 * @param {string} key
 * @param {string} [bucket]
 */
export async function deleteObject(key, bucket = DEFAULT_BUCKET) {
  const client = getClient();
  if (!client) throw new Error("Storage not configured");
  await client.removeObject(bucket, key);
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
  const bucket = opts.bucket || DEFAULT_BUCKET;
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
export async function getBucketStats(bucket = DEFAULT_BUCKET) {
  const objects = await listObjects({ bucket });
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
