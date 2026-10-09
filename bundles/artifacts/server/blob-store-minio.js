// Crow Artifacts — the MinIO blob backend (plan Task 2.2). Exactly the local
// store's async interface (R-H2), backed by the s3-client the gateway already
// uses, so an install with shared storage keeps artifacts beside its files.
//
// Per-instance isolation (R3-M3): the bucket is `<bucket prefix>-artifacts`
// (the prefix from `storage.shared.bucket_prefix`, via the s3-client's
// defaultBucket()) AND every key lives under `<store_id>/`, where store_id is
// this database's own id (artifact_store_meta). keys(), usage(), the marker
// (`<store_id>/store-id`) and every delete are scoped to that prefix: two
// instances sharing one MinIO never see each other's objects.
//
// S3 calls carry a per-operation timeout (R3-L5) so a stalled putObject
// cannot hold every writer inside the cross-process lock: default 30 s, then
// `busy` (the store's writers surface it; nothing is half-written — an S3 PUT
// is atomic, so this backend needs no tmp/ dir and reports no temp objects).
//
// usage() is EXACT with no cache: one scoped listing per call, summed. That
// is one listing per write, inside the lock — acceptable at the D17 scale
// (2 GB / 20 versions: thousands of objects at most). The only allowed
// optimisation (plan Task 2.2) is a running total kept INSIDE the lock; none
// is implemented.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { appImport } from "./app-root.js";
import { keyOf } from "./blob-store.js";

const KEY_RE = /^sha256\/[0-9a-f]{64}$/;
export const DEFAULT_S3_TIMEOUT_MS = 30000;

/** True for minio-js "object missing" errors (stat/get on an absent key). */
function isNotFound(e) {
  const code = String((e && e.code) || "");
  return code === "NotFound" || code === "NoSuchKey" || /not\s*(found|exist)/i.test(String((e && e.message) || ""));
}

/**
 * @param {object} o
 * @param {string} o.storeId  this database's artifact_store_meta store_id
 * @param {object} o.s3       the s3-client module (or an in-memory fake):
 *   { ensureBucket, uploadObject, getObject, deleteObject, listObjects }
 * @param {string} o.bucket   e.g. "crow-artifacts"
 * @param {string} o.lockPath local SQLite lock file (servers/shared/sqlite-lock.js)
 * @param {number} [o.timeoutMs]
 */
export function createMinioBlobStore({ storeId, s3, bucket, lockPath, timeoutMs = DEFAULT_S3_TIMEOUT_MS }) {
  if (!storeId || !/^[A-Za-z0-9_-]{1,128}$/.test(String(storeId))) throw new Error("createMinioBlobStore: storeId required");
  if (!s3 || typeof s3.listObjects !== "function") throw new Error("createMinioBlobStore: an s3 client is required");
  if (!bucket) throw new Error("createMinioBlobStore: bucket required");
  const P = `${storeId}/`;
  const MARKER = `${P}store-id`;
  const full = (key) => { if (!KEY_RE.test(key)) throw new Error("bad_key"); return P + key; };
  const timed = (promise, label) => {
    let t;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(`artifact storage ${label} timed out`), { code: "busy" })), timeoutMs); }),
    ]).finally(() => clearTimeout(t));
  };
  const list = (prefix) => timed(s3.listObjects({ bucket, prefix }), "list");
  const readAll = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); };
  const exact = async (objKey) => (await list(objKey)).find((o) => o.name === objKey) || null;

  async function has(key) { return !!(await exact(full(key))); }
  async function get(key) {
    const fk = full(key);
    let r;
    try { r = await timed(s3.getObject(fk, { bucket }), "get"); } catch (e) { if (isNotFound(e)) return null; throw e; }
    return readAll(r.stream);
  }
  async function readMarker() {
    try {
      const r = await timed(s3.getObject(MARKER, { bucket }), "marker-read");
      const s = (await readAll(r.stream)).toString("utf8").trim();
      return s || null;
    } catch { return null; }   // absent OR unreadable: storeMatches() fails closed on null
  }

  return {
    kind: "minio",
    lockPath,
    keyOf,
    async put(buf) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      const key = keyOf(b);
      const fk = full(key);
      if (await has(key)) return key;
      await timed(s3.uploadObject(fk, b, { bucket }), "put");
      return key;
    },
    get,
    has,
    async del(key) {
      try { await timed(s3.deleteObject(full(key), bucket), "delete"); } catch (e) { if (!isNotFound(e)) throw e; }
    },
    async keys() {
      const out = [];
      for (const o of await list(`${P}sha256/`)) {
        const k = o.name.slice(P.length);
        if (KEY_RE.test(k)) out.push(k);
      }
      return out;
    },
    // Exact at call time: the sha256/ objects under THIS store's prefix (the
    // marker is not content; there are no temp objects on this backend).
    async usage() {
      let n = 0;
      for (const o of await list(`${P}sha256/`)) n += Number(o.size) || 0;
      return n;
    },
    // Unknown or unreadable age reads as null, and reconcileBlobs never
    // reclaims a null-mtime object — a failing stat can never cause a delete.
    async mtimeOf(key) {
      try { const o = await exact(full(key)); return o && o.lastModified ? new Date(o.lastModified).getTime() : null; } catch { return null; }
    },
    readMarker,
    // S3 has no O_EXCL: check-then-write, matching store.js's rule that the
    // marker is written only on first use of an EMPTY store (it re-checks
    // keys() before calling). A lost race between two different databases on
    // one prefix is out of scope: one MinIO prefix belongs to one instance.
    async writeMarker(id) {
      if (await readMarker()) throw new Error("marker exists");
      await timed(s3.uploadObject(MARKER, Buffer.from(String(id)), { bucket }), "marker-write");
    },
  };
}

/** The artifacts bucket for the configured storage: `<prefix>-artifacts`. */
export function artifactsBucket(s3) {
  const def = typeof s3.defaultBucket === "function" ? String(s3.defaultBucket() || "") : "";
  const prefix = def.replace(/-files$/, "");
  if (!prefix) throw new Error("artifact storage: cannot derive a bucket prefix");
  return `${prefix}-artifacts`;
}

/**
 * The store for this instance (spec §11): MinIO when the shared storage is
 * available, else local disk under `<dataDir>/artifacts`. The lock always
 * lives on local disk (SQLite fcntl locking is the mechanism).
 * @param {object} db  an initialised artifact DB (initArtifactsTables has run)
 * @param {string} dataDir
 * @param {object} [opts]  { s3 }: inject the s3-client module (tests); default
 *   is the app's own servers/storage/s3-client.js via app-root.
 */
export async function createBlobStore(db, dataDir, opts = {}) {
  const root = join(dataDir, "artifacts");
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, "write-lock.db");
  let s3 = opts.s3 || null;
  if (!s3) { try { s3 = await appImport("servers/storage/s3-client.js"); } catch { s3 = null; } }
  if (s3 && await s3.isAvailable().catch(() => false)) {
    const r = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [] })).rows[0];
    const storeId = r && r.value;
    if (!storeId) throw new Error("artifact storage: MinIO is available but this database has no store_id");
    const bucket = artifactsBucket(s3);
    await s3.ensureBucket(bucket);   // a broken shared-storage config fails loudly: the mount catch reports it
    return createMinioBlobStore({ storeId, s3, bucket, lockPath });
  }
  const { createLocalBlobStore } = await import("./blob-store.js");
  return createLocalBlobStore(root);
}
