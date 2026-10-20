/**
 * Where a render or a composed project goes after the engine is done:
 * Crow storage (MinIO/S3 through the app's own s3-client, plus the
 * storage_files row the Files panel and /blog/media read) and the
 * done-notification. Dependencies are passed in, so the tests run with fakes.
 *
 * The rules mirror crow_upload_file (servers/storage/server.js): the same
 * MAX_UPLOAD_SIZE and STORAGE_QUOTA_MB limits, the same key sanitising, and
 * an uploaded object is removed again when its row cannot be written.
 */

/** reference_type values this bundle may set. Others (research_source,
 *  research_note) carry project ACL checks in the storage server, which a
 *  bundle must not bypass. blog_post makes the file publicly readable at
 *  /blog/media/<key>, which is what a song page's player fetches. */
import { randomBytes } from "node:crypto";

export const REFERENCE_TYPES = Object.freeze(["blog_post"]);

const envInt = (k, d) => { const v = parseInt(process.env[k] || "", 10); return Number.isFinite(v) && v > 0 ? v : d; };
export const defaultMaxBytes = () => envInt("MAX_UPLOAD_SIZE", 100 * 1024 * 1024);
export const defaultQuotaBytes = () => envInt("STORAGE_QUOTA_MB", 5120) * 1024 * 1024;

export const URL_EXPIRY_S = 3600;

const MIME = Object.freeze({ wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", sunvox: "application/octet-stream" });
export const mimeFor = (ext) => MIME[String(ext).toLowerCase()] || "application/octet-stream";

/**
 * save_to_storage semantics. → "save" | "skip-unavailable" | "off".
 * Omitted: save when storage is up, otherwise keep the local file and say so.
 * true: storage is required. false: local file only.
 */
export function storageMode(requested, available) {
  if (requested === false) return "off";
  if (available) return "save";
  if (requested === true) throw new Error("storage is not available (the server needs MINIO_ENDPOINT and its credentials); retry without save_to_storage to keep only the local file");
  return "skip-unavailable";
}

/**
 * Upload `buf` and record it. → { storage_key, bucket, size_bytes, url, url_expires_in_s,
 * media_path? (blog_post: the public song-page path), gateway_path? (signed-in download path) }
 */
export async function saveToStorage({
  s3, db, buf, fileName, mimeType, kind, referenceType = null, referenceId = null,
  maxBytes = defaultMaxBytes(), quotaBytes = defaultQuotaBytes(), now = Date.now(),
  rand = () => randomBytes(4).toString("hex"),
}) {
  if (referenceType != null && !REFERENCE_TYPES.includes(referenceType)) {
    throw new Error(`reference_type must be one of ${REFERENCE_TYPES.join(", ")}`);
  }
  if (!["renders", "projects"].includes(kind)) throw new Error(`bad storage kind ${kind}`);
  if (buf.length > maxBytes) {
    throw new Error(`the file is ${buf.length} bytes, larger than the storage upload limit (${maxBytes} bytes, MAX_UPLOAD_SIZE); render to mp3 or ogg, or a shorter project`);
  }
  const bucket = s3.defaultBucket();
  const stats = await s3.getBucketStats(bucket);
  if (stats.totalSizeBytes + buf.length > quotaBytes) {
    throw new Error(`storage quota exceeded (${Math.round(quotaBytes / 1024 / 1024)} MB, STORAGE_QUOTA_MB); delete files to free space`);
  }
  const safe = String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "sunvox";
  // A random part keeps keys unguessable: a blog_post file is public at /blog/media/<key>.
  const key = `sunvox-studio/${kind}/${now}-${rand()}-${safe}`;
  await s3.uploadObject(key, buf, { bucket, contentType: mimeType });
  try {
    await db.execute({
      sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [key, String(fileName).slice(0, 500), mimeType || null, buf.length, bucket, referenceType, referenceId ?? null],
    });
  } catch (err) {
    try { await s3.deleteObject(key, bucket); } catch { /* best effort, as crow_upload_file */ }
    throw err;
  }
  let url = null;
  try { url = await s3.getPresignedUrl(key, { bucket, expiry: URL_EXPIRY_S }); } catch { url = null; }
  const out = { storage_key: key, bucket, size_bytes: buf.length, url, url_expires_in_s: url ? URL_EXPIRY_S : null };
  if (referenceType === "blog_post") out.media_path = `/blog/media/${key}`;
  else out.gateway_path = `/storage/file/${key}`;
  return out;
}

/** The done-notification (Crow's bell). Never throws: a failure is reported in the result. */
export async function notifyDone({ createNotification, db }, { name, format, duration_s, storage_key = null }) {
  try {
    const row = await createNotification(db, {
      type: "media",
      source: "sunvox-studio",
      title: `Render ready: ${String(name).slice(0, 80)}`,
      body: `${duration_s} s ${format}${storage_key ? `, storage key ${storage_key}` : ""}`,
      action_url: storage_key ? "/dashboard/files" : null,
    });
    // createNotification returns null when the type is switched off in the notification settings.
    return row == null ? { notified: false, error: "media notifications are switched off" } : { notified: true };
  } catch (err) {
    return { notified: false, error: err.message };
  }
}
