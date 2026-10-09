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
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
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
 * Per-process memo of the backend decision, keyed by the RESOLVED dataDir and
 * cached as the in-flight promise so two simultaneous first calls cannot
 * decide separately (review L1). The boot MCP mount and the panel routes'
 * lazy init must receive the SAME store instance even if MinIO reachability
 * flips between the two calls. (The 2026-10-09 split-brain: boot chose local
 * while MinIO's lazily-cached Nest config was still loading, the panel init
 * chose MinIO and overrode the content resolver — writes went to disk, reads
 * went to an empty bucket, every framed view 404'd.)
 *
 * Test seams (opts): `s3` injects a fake s3-client module; `noCache` bypasses
 * the memo READ (the call still seeds it — a later default call sees the same
 * instance); `forceKind` bypasses the decision AND the memo entirely.
 * @type {Map<string, Promise<object>>}
 */
const CACHE = new Map();

async function resolveS3(opts) {
  let s3 = opts.s3 || null;
  if (!s3) { try { s3 = await appImport("servers/storage/s3-client.js"); } catch { s3 = null; } }
  return s3;
}

/** Does this database already hold artifact versions? (anything to orphan) */
async function hasVersions(db) {
  const { rows } = await db.execute({ sql: "SELECT 1 FROM artifact_versions LIMIT 1", args: [] });
  return rows.length > 0;
}

/** The first blob key of the oldest version row, or null. */
async function sampleKey(db) {
  const r = (await db.execute({ sql: "SELECT files_json FROM artifact_versions ORDER BY rowid ASC LIMIT 1", args: [] })).rows[0];
  if (!r) return null;
  try {
    const f = JSON.parse(r.files_json);
    const k = Array.isArray(f) && f[0] ? String(f[0].key || "") : "";
    return KEY_RE.test(k) ? k : null;
  } catch { return null; }
}

/** Read-only MinIO probe helper: marker/key reads with NO bucket creation. */
function minioProbe(storeId, s3, dataDir) {
  return createMinioBlobStore({ storeId, s3, bucket: artifactsBucket(s3), lockPath: join(dataDir, "artifacts", "write-lock.db") });
}

/** Wrap a store so every write path fails loudly (review R1/R3): a
 *  provisional backend decision must never put bytes — or a marker — where a
 *  later boot would read them as positive evidence. */
function readOnlyStore(store) {
  const refuse = (op) => async () => {
    throw new Error(`artifact storage: backend unresolved (no store marker matched and the MinIO backend could not be probed) — ${op} refused on the provisional read-only store`);
  };
  return { ...store, readOnly: true, put: refuse("put"), del: refuse("del"), writeMarker: refuse("writeMarker") };
}

/**
 * Decide which backend this instance's artifacts live on, and how firm that
 * decision is: 'stored' (the persisted store_kind row), 'pin' (positive
 * evidence — persist it) or 'provisional' (a guess — do NOT persist, and the
 * store is read-only so it can never manufacture evidence for itself).
 *
 * The persisted `store_kind` row is authoritative once written: 'local' stays
 * local even when MinIO is reachable; 'minio' stays MinIO and fails loudly
 * when unreachable — no silent fallback in either direction.
 *
 * When the row is absent (fresh install, or upgrade from before kinds):
 *   1. local marker file `<dataDir>/artifacts/store-id` matching the DB
 *      store_id → local (positive).
 *   2. MinIO reachable and the bucket marker `<store_id>/store-id` matches →
 *      minio (positive).
 *   3. the DB holds NO versions → genuinely fresh, nothing to orphan →
 *      decide by MinIO availability (positive; review R1: pinning here is
 *      safe, and a down backend on a fresh DB must not stay provisional or
 *      its first write would plant a local marker and hijack rule 1 later).
 *   4. versions EXIST but no marker matched → ask where the content actually
 *      lives (oldest version's first key): on local disk → local; reachable
 *      MinIO has it → minio (positive; review R3: a lost local marker must
 *      never flip an existing store onto an empty bucket).
 *   5. still ambiguous (MinIO down and unprobeable, or the content is on
 *      NEITHER backend) → provisional local, READ-ONLY, not persisted: a
 *      wrong permanent guess would orphan every existing blob. A later boot
 *      with positive evidence decides correctly.
 * @returns {Promise<{ kind: "local"|"minio", state: "stored"|"pin"|"provisional" }>}
 */
async function resolveStoreKind(db, dataDir, opts) {
  const row = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [] })).rows[0];
  if (row && (row.value === "local" || row.value === "minio")) return { kind: row.value, state: "stored" };

  const sid = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [] })).rows[0];
  const storeId = sid && sid.value;
  if (!storeId) throw new Error("artifact storage: no store_id — initArtifactsTables must run before createBlobStore");

  const root = join(dataDir, "artifacts");

  // 1. local marker on disk for THIS database's store id.
  let marker = null;
  try { marker = readFileSync(join(root, "store-id"), "utf8").trim() || null; } catch { /* no marker */ }
  if (marker === storeId) return { kind: "local", state: "pin" };

  const s3 = await resolveS3(opts);
  const available = !!(s3 && await s3.isAvailable().catch(() => false));

  // 2. bucket marker written by a MinIO-provisioned store (read-only probe).
  if (available) {
    try { if ((await minioProbe(storeId, s3, dataDir).readMarker()) === storeId) return { kind: "minio", state: "pin" }; }
    catch { /* no derivable bucket or unreadable marker: fall through */ }
  }

  // 3. fresh database: nothing to orphan — availability IS the decision.
  if (!(await hasVersions(db))) return { kind: available ? "minio" : "local", state: "pin" };

  // 4. versions exist: ask where the oldest version's first blob actually is.
  const key = await sampleKey(db);
  if (key) {
    if (existsSync(join(root, key))) return { kind: "local", state: "pin" };
    if (available) {
      try { if (await minioProbe(storeId, s3, dataDir).has(key)) return { kind: "minio", state: "pin" }; }
      catch { /* probe failed: fall through to provisional */ }
    }
  }

  // 5. ambiguous → provisional, read-only, unpersisted.
  return { kind: "local", state: "provisional" };
}

/**
 * Build the store for a resolved kind. kind='minio' THROWS when MinIO is
 * unreachable (the loud failure the mount catch reports); it never falls back
 * to local silently.
 */
async function buildStore(db, dataDir, kind, opts) {
  const root = join(dataDir, "artifacts");
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, "write-lock.db");
  if (kind === "local") {
    const { createLocalBlobStore } = await import("./blob-store.js");
    return createLocalBlobStore(root);
  }
  if (kind !== "minio") throw new Error(`artifact storage: unknown store kind '${kind}'`);
  const s3 = await resolveS3(opts);
  if (!s3 || !await s3.isAvailable().catch(() => false)) throw new Error("artifact storage: store_kind=minio but MinIO is unreachable");
  const r = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [] })).rows[0];
  const storeId = r && r.value;
  if (!storeId) throw new Error("artifact storage: store_kind=minio but this database has no store_id");
  const bucket = artifactsBucket(s3);
  await s3.ensureBucket(bucket);   // a broken shared-storage config fails loudly: the mount catch reports it
  return createMinioBlobStore({ storeId, s3, bucket, lockPath });
}

async function openStore(db, dataDir, opts) {
  const { kind, state } = await resolveStoreKind(db, dataDir, opts);
  let store = await buildStore(db, dataDir, kind, opts);
  if (state === "stored") {
    console.log(`[artifacts] blob store: ${kind} (pinned)`);
  } else if (state === "pin") {
    await db.execute({ sql: "INSERT OR REPLACE INTO artifact_store_meta (key, value) VALUES ('store_kind', ?)", args: [kind] });
    console.log(`[artifacts] blob store: ${kind} (pinned in store_kind)`);
  } else {
    store = readOnlyStore(store);
    console.warn(`[artifacts] blob store: local (PROVISIONAL, read-only, not pinned): artifact versions exist but no store marker matched and the MinIO backend could not be probed — refusing to guess a permanent backend or accept writes`);
  }
  return store;
}

/**
 * The blob store for this instance (spec §11 + backend pinning): ONE backend
 * decision per process per resolved dataDir (see CACHE), pinned in
 * artifact_store_meta (store_kind) whenever the decision rests on positive
 * evidence, so neither a momentary MinIO outage nor a lazily-loaded storage
 * config can ever split reads and writes across backends again. The lock
 * always lives on local disk (SQLite fcntl locking is the mechanism).
 * @param {object} db      an initialised artifact DB (initArtifactsTables has run)
 * @param {string} dataDir the instance data directory (blobs live under <dataDir>/artifacts)
 * @param {object} [opts]  { s3, noCache, forceKind } — test seams (see CACHE).
 */
export function createBlobStore(db, dataDir, opts = {}) {
  if (opts.forceKind) return buildStore(db, dataDir, opts.forceKind, opts);
  const cacheKey = resolve(dataDir);
  if (!opts.noCache && CACHE.has(cacheKey)) return CACHE.get(cacheKey);
  const p = openStore(db, dataDir, opts);
  CACHE.set(cacheKey, p);   // a noCache call still SEEDS the memo (T5)
  p.catch(() => { if (CACHE.get(cacheKey) === p) CACHE.delete(cacheKey); });
  return p;
}
