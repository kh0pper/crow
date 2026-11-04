/**
 * Take storage — `servers/storage/s3-client.js`, narrowed to the calls the take
 * uploads and the audio route make, plus the one query the audio route needs
 * from the database (the project's storage prefix).
 *
 * ## Availability is decided per call, never at import
 *
 * The instance's object storage can be configured *after* the gateway booted:
 * the Nest's Shared Storage page saves `storage.shared.*` and calls
 * `resetStorageClient()`, and an operator may install File Storage hours into a
 * session. So this adapter is always built, and every method asks
 * `isConfigured()` (and takes `getClient()`) at the moment it runs. A gateway
 * that recorded takes before storage existed therefore starts streaming them
 * the moment it exists, with no restart.
 *
 * ## One sentence for every storage failure
 *
 * When storage is not configured, or a bucket call fails for a reason that is
 * not the caller's (a refused connection, a bad credential, a missing bucket),
 * the caller gets a 503 carrying one fixed sentence instead of a driver error
 * that names an endpoint, a bucket or a key. The original goes to the log. A
 * refusal that already has an HTTP meaning (`error.status`) is passed through
 * untouched, so a real 404 or 409 from higher up is never flattened into 503.
 *
 * `getObject` is the one exception: it does not wrap its errors, because the
 * audio route has to tell a missing object (`NotFound` / `NoSuchKey`, a 404)
 * from an unreachable store (a 503). It still refuses up front when storage is
 * not configured.
 *
 * ## No app modules
 *
 * Nothing here imports from `servers/…`: the client module and the database
 * client arrive injected, so the same code runs in the gateway, in a test with
 * fakes, and in an installed copy of the bundle.
 */

/** What a caller is told when storage cannot be reached (503). */
const UNAVAILABLE_TEXT = "Crow storage is not available on this instance.";

/** The bucket name used when the client module answers none (`crow-files`). */
const DEFAULT_BUCKET = "crow-files";

/** @returns {Error} the one refusal a route maps to 503. */
function unavailable() {
  const error = new Error(UNAVAILABLE_TEXT);
  error.status = 503;
  return error;
}

/**
 * Build the take storage adapter for one gateway process.
 *
 * @param {object} options
 * @param {{isConfigured?: Function, getClient?: Function, defaultBucket?: Function,
 *          ensureBucket: Function, deleteObject: Function, getBucketStats: Function,
 *          getObject: Function}|null} options.client
 *   the storage client module (`servers/storage/s3-client.js`, or a stand-in in
 *   a test). Null — or a module whose `isConfigured()` says false — makes every
 *   call refuse with 503, which is what an instance without shared storage is.
 * @param {object} options.db a libsql-compatible client (`execute({sql, args})`),
 *   read for `project_spaces.storage_prefix`
 * @returns {{putObjectStream: Function, deleteObject: Function, getBucketStats: Function,
 *            defaultBucket: Function, getObject: Function, storagePrefixFor: Function}}
 */
export function createTakeStorage({ client = null, db } = {}) {
  if (!db || typeof db.execute !== "function") {
    throw new TypeError("createTakeStorage needs a database client");
  }

  /**
   * The live storage client, or a 503 refusal. Read on every call: a
   * `resetStorageClient()` between two calls is picked up by the next one.
   * @returns {object} the underlying MinIO/S3 client
   */
  function liveClient() {
    const configured =
      !!client && (typeof client.isConfigured === "function" ? client.isConfigured() === true : true);
    const sdk = client && typeof client.getClient === "function" ? client.getClient() : null;
    if (!configured || !sdk) throw unavailable();
    return sdk;
  }

  /** @returns {string} the bucket to use, the client's default when none is named. */
  function bucketOf(bucket) {
    if (bucket) return String(bucket);
    return typeof client?.defaultBucket === "function" ? String(client.defaultBucket()) : DEFAULT_BUCKET;
  }

  /**
   * Turn one bucket failure into the 503 the routes hand on, keeping the real
   * error in the log (and as `cause`, for anyone debugging from the code). A
   * failure that already carries an HTTP meaning of its own is passed through
   * untouched.
   * @param {string} what - the call that failed, for the log line
   * @param {unknown} error
   * @returns {Error} the error to throw
   */
  function refused(what, error) {
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return error;
    console.warn(`[studio] take storage ${what} failed:`, error?.message || error);
    const failure = unavailable();
    failure.cause = error;
    return failure;
  }

  return {
    /**
     * Stream one finished take's WAV into the bucket with its size known up
     * front, so a 345 MB take never has to fit in memory.
     * @param {string} key
     * @param {AsyncIterable<Uint8Array>|object} stream
     * @param {number} size
     * @param {{bucket?: string, contentType?: string}} [options]
     * @returns {Promise<void>}
     */
    async putObjectStream(key, stream, size, options = {}) {
      const sdk = liveClient();
      const bucket = bucketOf(options.bucket);
      const metaData = options.contentType ? { "Content-Type": options.contentType } : {};
      try {
        await client.ensureBucket(bucket);
        await sdk.putObject(bucket, key, stream, size, metaData);
      } catch (error) {
        throw refused("upload", error);
      }
    },

    /**
     * Delete one object, for a take whose upload could not be completed.
     * @param {string} key
     * @param {string} [bucket]
     * @returns {Promise<void>}
     */
    async deleteObject(key, bucket) {
      liveClient();
      try {
        await client.deleteObject(key, bucketOf(bucket));
      } catch (error) {
        throw refused("delete", error);
      }
    },

    /**
     * The bucket's totals, which the quota check reads. Without storage this
     * refuses rather than answering zero, so a finish cannot quietly pass a
     * quota it could not check.
     * @param {string} [bucket]
     * @returns {Promise<{fileCount: number, totalSizeBytes: number}>}
     */
    async getBucketStats(bucket) {
      liveClient();
      try {
        return await client.getBucketStats(bucketOf(bucket));
      } catch (error) {
        throw refused("statistics", error);
      }
    },

    /**
     * Open one object for the audio route.
     *
     * Errors are the caller's to sort (`NotFound` / `NoSuchKey` is a 404), so
     * this one does not flatten them; it only refuses up front when this
     * instance has no storage at all.
     * @param {string} key
     * @param {{bucket?: string}} [options]
     * @returns {Promise<{stream: object, stat: {size?: number}}>}
     */
    async getObject(key, options = {}) {
      liveClient();
      return client.getObject(key, { bucket: bucketOf(options.bucket) });
    },

    /** @returns {string} the bucket a take is filed under. */
    defaultBucket() {
      return bucketOf(undefined);
    },

    /**
     * The project's storage prefix (`project_spaces.storage_prefix`), which
     * every key a take may be played from is built on. Empty when the project
     * has none, so a key naming any prefix at all is then refused.
     * @param {number|null} projectId
     * @returns {Promise<string>}
     */
    async storagePrefixFor(projectId) {
      if (projectId == null) return "";
      const { rows } = await db.execute({
        sql: "SELECT storage_prefix FROM project_spaces WHERE id = ?",
        args: [Number(projectId)],
      });
      const prefix = rows && rows[0] ? rows[0].storage_prefix : null;
      return typeof prefix === "string" ? prefix : "";
    },
  };
}