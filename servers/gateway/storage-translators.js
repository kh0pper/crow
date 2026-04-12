/**
 * Per-app S3 schema translators.
 *
 * Different federated apps expect object-storage credentials under different
 * env var names (or inside different YAML blocks). When the Crow MinIO
 * bundle is installed, each federated bundle that needs object storage
 * pulls the canonical Crow S3 credentials through one of these translators
 * at install time and writes the app-specific env vars into its
 * docker-compose .env file.
 *
 * The canonical Crow shape is:
 *   {
 *     endpoint: "http://minio:9000",   // service:port on crow-federation network
 *     region:   "us-east-1",
 *     bucket:   "crow-<app>",          // caller-chosen, per app
 *     accessKey: "<random or shared>",
 *     secretKey: "<random or shared>",
 *     forcePathStyle: true,            // MinIO requires path-style
 *   }
 *
 * Each translator returns an env-var object ready to write to the app
 * bundle's .env file. The installer never reads secrets back out of the
 * translated object — it writes once, then the app container reads from
 * its own env.
 *
 * PeerTube note: upstream removed YAML-only overrides in favor of
 * PEERTUBE_OBJECT_STORAGE_* env vars starting in v6; if PeerTube ever
 * reverts that, we'd need a sidecar entrypoint wrapper that writes
 * /config/production.yaml. Until then env vars suffice.
 */

/**
 * @typedef {Object} CrowS3
 * @property {string} endpoint    - Full URL incl. scheme and port
 * @property {string} [region]    - Defaults to us-east-1
 * @property {string} bucket      - Bucket name (caller-chosen)
 * @property {string} accessKey
 * @property {string} secretKey
 * @property {boolean} [forcePathStyle]
 */

function urlParts(endpoint) {
  // Strip scheme so "host:port" form is usable where some apps want it.
  const m = endpoint.match(/^(https?):\/\/([^/]+)(\/.*)?$/);
  if (!m) throw new Error(`Invalid S3 endpoint URL: ${endpoint}`);
  return { scheme: m[1], authority: m[2], path: m[3] || "/" };
}

export const TRANSLATORS = {
  /**
   * Mastodon — S3_* (documented at
   * https://docs.joinmastodon.org/admin/optional/object-storage/).
   */
  mastodon(crow) {
    const { scheme, authority } = urlParts(crow.endpoint);
    return {
      S3_ENABLED: "true",
      S3_BUCKET: crow.bucket,
      AWS_ACCESS_KEY_ID: crow.accessKey,
      AWS_SECRET_ACCESS_KEY: crow.secretKey,
      S3_REGION: crow.region || "us-east-1",
      S3_PROTOCOL: scheme,
      S3_HOSTNAME: authority,
      S3_ENDPOINT: crow.endpoint,
      S3_FORCE_SINGLE_REQUEST: "true",
    };
  },

  /**
   * PeerTube — PEERTUBE_OBJECT_STORAGE_* (documented at
   * https://docs.joinpeertube.org/admin/remote-storage). Videos,
   * streaming playlists, originals, web-videos all share the same
   * credentials but take per-prefix buckets in upstream. We point them
   * all at `<bucket>` and let operators split later via manual YAML.
   */
  peertube(crow) {
    return {
      PEERTUBE_OBJECT_STORAGE_ENABLED: "true",
      PEERTUBE_OBJECT_STORAGE_ENDPOINT: crow.endpoint,
      PEERTUBE_OBJECT_STORAGE_REGION: crow.region || "us-east-1",
      PEERTUBE_OBJECT_STORAGE_ACCESS_KEY_ID: crow.accessKey,
      PEERTUBE_OBJECT_STORAGE_SECRET_ACCESS_KEY: crow.secretKey,
      PEERTUBE_OBJECT_STORAGE_UPLOAD_ACL_PUBLIC: "public-read",
      PEERTUBE_OBJECT_STORAGE_UPLOAD_ACL_PRIVATE: "private",
      PEERTUBE_OBJECT_STORAGE_VIDEOS_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_STREAMING_PLAYLISTS_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_WEB_VIDEOS_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_ORIGINAL_VIDEO_FILES_BUCKET_NAME: crow.bucket,
      PEERTUBE_OBJECT_STORAGE_USER_EXPORTS_BUCKET_NAME: crow.bucket,
    };
  },

  /**
   * Pixelfed — AWS_* + FILESYSTEM_CLOUD=s3 (documented at
   * https://docs.pixelfed.org/running-pixelfed/object-storage.html).
   */
  pixelfed(crow) {
    return {
      FILESYSTEM_CLOUD: "s3",
      PF_ENABLE_CLOUD: "true",
      AWS_ACCESS_KEY_ID: crow.accessKey,
      AWS_SECRET_ACCESS_KEY: crow.secretKey,
      AWS_DEFAULT_REGION: crow.region || "us-east-1",
      AWS_BUCKET: crow.bucket,
      AWS_URL: crow.endpoint,
      AWS_ENDPOINT: crow.endpoint,
      AWS_USE_PATH_STYLE_ENDPOINT: crow.forcePathStyle !== false ? "true" : "false",
    };
  },

  /**
   * Funkwhale — AWS_* + FUNKWHALE-specific (documented at
   * https://docs.funkwhale.audio/admin/configuration.html#s3-storage).
   */
  funkwhale(crow) {
    return {
      AWS_ACCESS_KEY_ID: crow.accessKey,
      AWS_SECRET_ACCESS_KEY: crow.secretKey,
      AWS_STORAGE_BUCKET_NAME: crow.bucket,
      AWS_S3_ENDPOINT_URL: crow.endpoint,
      AWS_S3_REGION_NAME: crow.region || "us-east-1",
      AWS_LOCATION: "",
      AWS_QUERYSTRING_AUTH: "true",
      AWS_QUERYSTRING_EXPIRE: "3600",
    };
  },
};

export const SUPPORTED_APPS = Object.keys(TRANSLATORS);

/**
 * Translate Crow's canonical S3 credentials into env vars for the given app.
 * Throws on unknown app.
 */
export function translate(app, crow) {
  const fn = TRANSLATORS[app];
  if (!fn) {
    throw new Error(
      `No S3 translator for "${app}". Supported: ${SUPPORTED_APPS.join(", ")}`,
    );
  }
  const missing = ["endpoint", "bucket", "accessKey", "secretKey"].filter(
    (k) => !crow?.[k],
  );
  if (missing.length) {
    throw new Error(
      `Crow S3 credentials incomplete: missing ${missing.join(", ")}`,
    );
  }
  return fn(crow);
}
