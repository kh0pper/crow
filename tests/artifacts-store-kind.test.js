// Artifacts store_kind — backend pinning regression suite (plan §Tests T1-T7).
// Tests: kind='local' honored, kind='minio' enforced, fresh provisioning,
// legacy backfill, split-brain regression, migration idempotency, and
// resolver end-to-end under an availability flip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, existsSync,
  mkdirSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobStore } from "../bundles/artifacts/server/blob-store-minio.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createDbClient } from "../servers/db.js";
import { makeFakeS3 } from "./helpers/fake-s3.mjs";
import { keyOf } from "../bundles/artifacts/server/blob-store.js";

const fakeS3 = makeFakeS3;

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** Ensure the artifacts root exists (created by createBlobStore in prod). */
function ensureArtifactsDir(dir) {
  mkdirSync(join(dir, "artifacts"), { recursive: true });
}

function mkDb(dir) {
  return createDbClient(join(dir, "crow.db"));
}

// ──────────────────────────────────────────────────────────────────────
// T1 — kind='local' honored while MinIO is available
// ──────────────────────────────────────────────────────────────────────

test("T1: kind='local' honored while MinIO is available (fake s3)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);

  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";

  // Write the marker file so the backfill decides 'local'.
  const storeId = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  writeFileSync(join(dir, "artifacts", "store-id"), storeId, "utf8");

  const store = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(store.kind, "local", "store kind is local despite available MinIO");

  // Round-trip on disk: no MinIO writes.
  const buf = Buffer.from("local round-trip");
  const key = await store.put(buf);
  assert.equal(keyOf(buf), key);
  assert.equal((await store.get(key)).toString(), "local round-trip");
  assert.ok(existsSync(join(dir, "artifacts", key)), "blob lives on disk");
  // ensureBucket was NOT called.
  assert.ok(!upS3.calls.some((c) => c[0] === "ensureBucket"), "MinIO ensureBucket NOT called");
});

// ──────────────────────────────────────────────────────────────────────
// T2 — kind='minio' honored; unreachable → throws
// ──────────────────────────────────────────────────────────────────────

test("T2: kind='minio' honored: unreachable MinIO → throws; reachable → MinIO store", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);

  // Ensure store_kind=minio in DB (simulating a prior MinIO-provisioned store).
  await db.execute({
    sql: "INSERT OR REPLACE INTO artifact_store_meta (key, value) VALUES ('store_kind', 'minio')",
    args: [],
  });

  // Unreachable → throws.
  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  await assert.rejects(
    createBlobStore(db, dir, { s3: downS3, noCache: true }),
    /store_kind=minio.*MinIO.*unreachable/,
  );

  // Reachable → MinIO store works.
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const store = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(store.kind, "minio");
  const buf = Buffer.from("minio round-trip");
  const key = await store.put(buf);
  assert.equal(keyOf(buf), key);
  assert.equal((await store.get(key)).toString(), "minio round-trip");
});

// ──────────────────────────────────────────────────────────────────────
// T3 — Fresh provisioning: persist store_id + store_kind together
// ──────────────────────────────────────────────────────────────────────

test("T3: fresh provisioning persists store_id + store_kind (available→minio, unavailable→local)", async (t) => {
  // Available → minio.
  const dirA = mkdtempSync(join(tmpdir(), "artifacts-kind-t3a-"));
  t.after(() => rmSync(dirA, { recursive: true, force: true }));
  const dbA = mkDb(dirA);
  t.after(() => { try { dbA.close(); } catch {} });
  await initArtifactsTables(dbA);

  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const storeA = await createBlobStore(dbA, dirA, { s3: upS3, noCache: true });
  assert.equal(storeA.kind, "minio");
  const skA = (await dbA.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];
  assert.equal(skA.value, "minio");
  assert.ok(upS3.calls.some((c) => c[0] === "ensureBucket"));

  // Unavailable → local + marker file created by the local store.
  const dirB = mkdtempSync(join(tmpdir(), "artifacts-kind-t3b-"));
  t.after(() => rmSync(dirB, { recursive: true, force: true }));
  const dbB = mkDb(dirB);
  t.after(() => { try { dbB.close(); } catch {} });
  await initArtifactsTables(dbB);

  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  const storeB = await createBlobStore(dbB, dirB, { s3: downS3, noCache: true });
  assert.equal(storeB.kind, "local");
  const skB = (await dbB.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];
  assert.equal(skB.value, "local");
});

// ──────────────────────────────────────────────────────────────────────
// T4 — Legacy backfill
// ──────────────────────────────────────────────────────────────────────

test("T4: legacy backfill — marker matches → 'local'; no marker + s3 → 'minio'", async (t) => {
  // Marker matches: store_id pre-existed, marker file matches → 'local'.
  const dirMatch = mkdtempSync(join(tmpdir(), "artifacts-kind-t4m-"));
  t.after(() => rmSync(dirMatch, { recursive: true, force: true }));
  const dbMatch = mkDb(dirMatch);
  t.after(() => { try { dbMatch.close(); } catch {} });
  await initArtifactsTables(dbMatch);
  ensureArtifactsDir(dirMatch);

  // Simulate an upgrade: delete the auto-inserted store_kind so the
  // backfill has to decide again.
  await dbMatch.execute({
    sql: "DELETE FROM artifact_store_meta WHERE key='store_kind'", args: [],
  });

  const sidMatch = (await dbMatch.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  writeFileSync(join(dirMatch, "artifacts", "store-id"), sidMatch, "utf8");

  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const storeMatch = await createBlobStore(dbMatch, dirMatch, { s3: upS3, noCache: true });
  assert.equal(storeMatch.kind, "local");
  const skM = (await dbMatch.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];
  assert.equal(skM.value, "local");

  // No marker + available s3 → 'minio'.
  const dirNoMatch = mkdtempSync(join(tmpdir(), "artifacts-kind-t4n-"));
  t.after(() => rmSync(dirNoMatch, { recursive: true, force: true }));
  const dbNoMatch = mkDb(dirNoMatch);
  t.after(() => { try { dbNoMatch.close(); } catch {} });
  await initArtifactsTables(dbNoMatch);

  // Delete auto-inserted store_kind.
  await dbNoMatch.execute({
    sql: "DELETE FROM artifact_store_meta WHERE key='store_kind'", args: [],
  });
  ensureArtifactsDir(dirNoMatch);
  // Do NOT write a marker file.

  const upS3b = fakeS3();
  upS3b.isAvailable = async () => true;
  upS3b.defaultBucket = () => "crow-files";
  const storeNoMatch = await createBlobStore(dbNoMatch, dirNoMatch, { s3: upS3b, noCache: true });
  assert.equal(storeNoMatch.kind, "minio");
  const skN = (await dbNoMatch.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];
  assert.equal(skN.value, "minio");
});

// ──────────────────────────────────────────────────────────────────────
// T5 — Split-brain regression pin (THE critical prod sequence)
// ──────────────────────────────────────────────────────────────────────

test("T5: split-brain regression — same (db, dataDir), availability flip, identical backend", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);

  // Write the marker file so the first call decides 'local'.
  const sid = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  writeFileSync(join(dir, "artifacts", "store-id"), sid, "utf8");

  // Call 1: MinIO unavailable → local (persisted).
  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  const store1 = await createBlobStore(db, dir, { s3: downS3, noCache: true });
  assert.equal(store1.kind, "local");

  // Call 2: availability flips to true → same instance (memoized).
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const store2 = await createBlobStore(db, dir, { s3: upS3 });
  assert.equal(store2.kind, "local", "second call still local (kind persisted + memoized)");
  assert.strictEqual(store2, store1, "same instance returned (memoized)");

  // Write data to the memoized store.
  const buf = Buffer.from("split-brain test");
  const key = await store1.put(buf);
  assert.equal((await store1.get(key)).toString(), "split-brain test");
  // No MinIO objects created.
  assert.ok(!upS3.objects.has(`${sid}/${key}`), "no MinIO write from local store");
});

// ──────────────────────────────────────────────────────────────────────
// T6 — Migration idempotency
// ──────────────────────────────────────────────────────────────────────

test("T6: init-tables twice → single store_id row, store_kind stable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t6-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });

  // First call: creates tables, inserts store_id. Fresh install → no
  // store_kind set (decided at provisioning time by createBlobStore).
  await initArtifactsTables(db);
  const sid1 = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  const sk1 = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];

  // Second call: same tables exist, store_id already there.
  await initArtifactsTables(db);
  const sid2 = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  const sk2 = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];

  assert.equal(sid1, sid2, "store_id unchanged on second init");
  // store_kind is either null both times (fresh) or the same both times
  // (upgrade with a pre-existing kind). Either way: stable.
  assert.deepEqual(
    sk1 ? { kind: sk1.value } : null,
    sk2 ? { kind: sk2.value } : null,
    "store_kind stable across init calls",
  );
});

// ──────────────────────────────────────────────────────────────────────
// T7 — Resolver end-to-end under an availability flip
// ──────────────────────────────────────────────────────────────────────

test("T7: write via mount-store readable via panel resolver under availability flip", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t7-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);

  // Write a marker file so both call sites decide 'local'.
  const sid = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  writeFileSync(join(dir, "artifacts", "store-id"), sid, "utf8");

  // The "mount" call site (boot): MinIO unavailable → local.
  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  const mountStore = await createBlobStore(db, dir, { s3: downS3, noCache: true });
  assert.equal(mountStore.kind, "local");

  // Write an artifact through the mount store.
  const content = Buffer.from("<html><body>hello artifact</body></html>");
  const key = await mountStore.put(content);
  assert.ok(mountStore.has(key), "blob written via mount store");

  // Simulate the "panel init" call site arriving later with MinIO available.
  // Memoization ensures the SAME local store is returned.
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const panelStore = await createBlobStore(db, dir, { s3: upS3 });

  assert.equal(panelStore.kind, "local", "panel init still uses local (memoized)");
  assert.strictEqual(panelStore, mountStore, "same instance — no split brain");

  // Read back through the panel store.
  assert.ok(panelStore.has(key), "blob readable via panel store");
  const read = await panelStore.get(key);
  assert.equal(read.toString(), content.toString(), "content matches");
});

// ──────────────────────────────────────────────────────────────────────
// T8 — forceKind escape hatch lets tests simulate a flip
// ──────────────────────────────────────────────────────────────────────

test("T8: forceKind escape hatch — two calls with forceKind get different decisions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t8-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);

  // forceKind='local' → local store regardless of s3 state.
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const storeLocal = await createBlobStore(db, dir, { s3: upS3, noCache: true, forceKind: "local" });
  assert.equal(storeLocal.kind, "local");

  // forceKind='minio' → minio store (with available s3).
  const storeMinio = await createBlobStore(db, dir, { s3: upS3, noCache: true, forceKind: "minio" });
  assert.equal(storeMinio.kind, "minio");
  assert.notStrictEqual(storeLocal, storeMinio, "different instances from forceKind");
});

// ──────────────────────────────────────────────────────────────────────
// T9 — noCache bypasses the memo but still honours persisted store_kind
// ──────────────────────────────────────────────────────────────────────

test("T9: noCache bypasses the memo but still honours persisted store_kind", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t9-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);

  // Write marker → first call persists store_kind='local'.
  const sid = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;
  writeFileSync(join(dir, "artifacts", "store-id"), sid, "utf8");

  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  const store1 = await createBlobStore(db, dir, { s3: downS3, noCache: true });
  assert.equal(store1.kind, "local");

  // noCache=true, available s3, but store_kind persisted → still local.
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const store2 = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(store2.kind, "local", "persisted store_kind overrides s3 availability");
});

// ──────────────────────────────────────────────────────────────────────
// Helpers for version-bearing databases (R1/R3 scenarios)
// ──────────────────────────────────────────────────────────────────────

const SAMPLE_KEY = "sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A minimal version row referencing SAMPLE_KEY (the decision code only ever
 *  reads files_json / existence — never the artifact itself). */
async function addFakeVersion(db, artifactId = "art_test") {
  await db.execute({
    sql: "INSERT INTO artifacts (id, title, type) VALUES (?,?,?)",
    args: [artifactId, "test", "document"],
  });
  await db.execute({
    sql: `INSERT INTO artifact_versions (artifact_id, n, state, files_json, size, content_hash, made_by, untrusted_input)
          VALUES (?, 1, 'current', ?, 1, 'hash', 'bot', 1)`,
    args: [artifactId, JSON.stringify([{ path: "index.html", key: SAMPLE_KEY, contentType: "text/html", size: 1 }])],
  });
}

// ──────────────────────────────────────────────────────────────────────
// T10 — configured-but-down MinIO with EXISTING versions: provisional local,
//       read-only, NOT persisted; bucket marker pins minio when it returns
// ──────────────────────────────────────────────────────────────────────

test("T10: configured-but-down + versions → provisional READ-ONLY local (not persisted); bucket marker → minio persisted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t10-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);
  await addFakeVersion(db);

  const sid = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;

  // MinIO configured (getClient returns a client) but unreachable, versions
  // exist, no marker anywhere: ambiguous — provisional, read-only, unpersisted.
  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  downS3.getClient = () => ({});
  const s1 = await createBlobStore(db, dir, { s3: downS3, noCache: true });
  assert.equal(s1.kind, "local");
  assert.equal(s1.readOnly, true, "provisional store is read-only");
  await assert.rejects(s1.put(Buffer.from("nope")), /read-only|unresolved/);
  await assert.rejects(s1.writeMarker(sid), /read-only|unresolved/);
  assert.ok(!existsSync(join(dir, "artifacts", "store-id")), "no marker planted by the provisional store (R1)");
  const skRows = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows;
  assert.equal(skRows.length, 0, "provisional decision must NOT persist store_kind");

  // MinIO returns and the bucket carries this database's marker: positive
  // evidence → 'minio', persisted.
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  upS3.getClient = () => ({});
  await upS3.uploadObject(`${sid}/store-id`, Buffer.from(sid), { bucket: "crow-artifacts" });
  const s2 = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(s2.kind, "minio", "bucket marker is positive evidence for minio");
  const sk2 = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];
  assert.equal(sk2.value, "minio", "positive decision persists");
});

// T11 — not-configured storage (no getClient) + down + fresh: local IS positive → persisted
test("T11: shared storage not configured at all → local persisted (only possible backend)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t11-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);

  const absentS3 = fakeS3();           // fakes model "module present, no client"
  absentS3.isAvailable = async () => false;
  const s = await createBlobStore(db, dir, { s3: absentS3, noCache: true });
  assert.equal(s.kind, "local");
  const sk = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [],
  })).rows[0];
  assert.equal(sk.value, "local", "local-only install pins its kind");
});

// ──────────────────────────────────────────────────────────────────────
// T12 — R1 exact sequence: a MinIO-provisioned DB through a MinIO outage
//       (provisional read-only, nothing planted), then MinIO returns:
//       pinned minio and the pre-existing blob is readable — never orphaned.
// ──────────────────────────────────────────────────────────────────────

test("T12: MinIO-provisioned DB survives an outage: provisional refuses writes, reboot with MinIO up pins minio and reads the old blob", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t12-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);
  await addFakeVersion(db);
  const sid = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;

  // The MinIO side of a healthy minio-provisioned store: marker + the blob.
  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  upS3.getClient = () => ({});
  await upS3.uploadObject(`${sid}/store-id`, Buffer.from(sid), { bucket: "crow-artifacts" });
  await upS3.uploadObject(`${sid}/${SAMPLE_KEY}`, Buffer.from("old blob"), { bucket: "crow-artifacts" });

  // Process 1: MinIO goes down. Provisional local, read-only, nothing planted.
  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  downS3.getClient = () => ({});
  const s1 = await createBlobStore(db, dir, { s3: downS3, noCache: true });
  assert.equal(s1.kind, "local");
  assert.equal(s1.readOnly, true);
  await assert.rejects(s1.put(Buffer.from("would orphan")), /read-only|unresolved/);
  assert.ok(!existsSync(join(dir, "artifacts", "store-id")), "no local marker planted (R1 leak path)");
  const sk1 = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [] })).rows;
  assert.equal(sk1.length, 0, "kind not persisted during the outage");

  // Process 2 (reboot): MinIO is back → bucket marker → pinned minio, and the
  // pre-existing blob reads fine.
  const s2 = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(s2.kind, "minio");
  assert.equal((await s2.get(SAMPLE_KEY)).toString(), "old blob", "existing MinIO blob was never orphaned");
  const sk2 = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [] })).rows[0];
  assert.equal(sk2.value, "minio");
});

// ──────────────────────────────────────────────────────────────────────
// T13 — R2: an already-stored kind logs quietly (no PROVISIONAL warning)
// ──────────────────────────────────────────────────────────────────────

test("T13: a stored store_kind never logs the PROVISIONAL warning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t13-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);
  await db.execute({
    sql: "INSERT OR REPLACE INTO artifact_store_meta (key, value) VALUES ('store_kind', 'local')", args: [],
  });

  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    const s = await createBlobStore(db, dir, { s3: null, noCache: true });
    assert.equal(s.kind, "local");
  } finally { console.warn = orig; }
  assert.equal(warnings.length, 0, "stored kind must log quietly (no PROVISIONAL warn on every boot)");
});

// ──────────────────────────────────────────────────────────────────────
// T14 — R3: versions + local content + LOST marker + MinIO reachable →
//       content probe pins local (never flips onto the empty bucket)
// ──────────────────────────────────────────────────────────────────────

test("T14: lost local marker with local content never flips to MinIO (content probe pins local)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t14-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);
  await addFakeVersion(db);

  // The blob exists ONLY on local disk; the marker file is gone (lost).
  mkdirSync(join(dir, "artifacts", "sha256"), { recursive: true });
  writeFileSync(join(dir, "artifacts", SAMPLE_KEY), "local content");

  const upS3 = fakeS3();               // MinIO reachable, bucket EMPTY
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  const s = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(s.kind, "local", "content probe finds the blob on disk → local pinned");
  const sk = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [] })).rows[0];
  assert.equal(sk.value, "local");
  assert.equal((await s.get(SAMPLE_KEY)).toString(), "local content");
});

// ──────────────────────────────────────────────────────────────────────
// T15 — R1 fix: FRESH db + configured-but-down MinIO → local pinned outright
//       (nothing to orphan; provisional here would let the first write plant
//       a marker and hijack rule 1 forever)
// ──────────────────────────────────────────────────────────────────────

test("T15: fresh database + configured-but-down MinIO → local PINNED (not provisional)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t15-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);

  const downS3 = fakeS3();
  downS3.isAvailable = async () => false;
  downS3.getClient = () => ({});       // configured but down
  const s = await createBlobStore(db, dir, { s3: downS3, noCache: true });
  assert.equal(s.kind, "local");
  assert.notEqual(s.readOnly, true, "fresh installs are writable");
  const sk = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [] })).rows[0];
  assert.equal(sk.value, "local", "fresh + down pins local outright (R1 fix)");
  // And writes work.
  const key = await s.put(Buffer.from("fresh write"));
  assert.equal((await s.get(key)).toString(), "fresh write");
});

// ──────────────────────────────────────────────────────────────────────
// T16 — R3 minio arm: versions + content only in the bucket + no markers →
//       content probe pins minio
// ──────────────────────────────────────────────────────────────────────

test("T16: content only in MinIO + no markers anywhere → probe pins minio", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-kind-t16-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = mkDb(dir);
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  ensureArtifactsDir(dir);
  await addFakeVersion(db);
  const sid = (await db.execute({
    sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [],
  })).rows[0].value;

  const upS3 = fakeS3();
  upS3.isAvailable = async () => true;
  upS3.defaultBucket = () => "crow-files";
  // The blob is in the bucket but NO bucket marker exists.
  await upS3.uploadObject(`${sid}/${SAMPLE_KEY}`, Buffer.from("bucket content"), { bucket: "crow-artifacts" });

  const s = await createBlobStore(db, dir, { s3: upS3, noCache: true });
  assert.equal(s.kind, "minio", "content probe finds the blob in the bucket → minio pinned");
  const sk = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_kind'", args: [] })).rows[0];
  assert.equal(sk.value, "minio");
  assert.equal((await s.get(SAMPLE_KEY)).toString(), "bucket content");
});
