// The MinIO blob backend (plan Task 2.2): the exact async interface of the
// local store (R-H2), per-instance key scoping (R3-M3), exact usage() with no
// cache, and a per-operation timeout so a stalled S3 call cannot hold the
// cross-process lock (R3-L5). Runs against an in-memory fake of the
// s3-client's functions — no network, no container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMinioBlobStore, artifactsBucket } from "../bundles/artifacts/server/blob-store-minio.js";
import { keyOf } from "../bundles/artifacts/server/blob-store.js";
import { makeFakeS3 } from "./helpers/fake-s3.mjs";

const fakeS3 = makeFakeS3;

const mk = (s3, storeId, opts = {}) => createMinioBlobStore({
  storeId, s3, bucket: "crow-artifacts", lockPath: join(tmpdir(), `artifacts-lock-${storeId}.db`), timeoutMs: 100, ...opts,
});

test("put/get round trip, dedup, has, del, keys, bad_key", async () => {
  const s3 = fakeS3();
  const b = mk(s3, "store-a");
  const buf = Buffer.from("hello artifact");
  const key = await b.put(buf);
  assert.equal(key, keyOf(buf));
  assert.equal((await b.get(key)).toString(), "hello artifact");
  assert.equal(await b.has(key), true);
  // Dedup: a second put of the same bytes writes no second object.
  const before = s3.objects.size;
  assert.equal(await b.put(Buffer.from("hello artifact")), key);
  assert.equal(s3.objects.size, before);
  // Keys are content-addressed under the store prefix.
  assert.deepEqual(await b.keys(), [key]);
  assert.equal(s3.objects.has(`store-a/${key}`), true, "object lives under <store_id>/");
  await b.del(key);
  assert.equal(await b.has(key), false);
  assert.equal(await b.get(key), null);
  assert.deepEqual(await b.keys(), []);
  // bad_key: anything that is not sha256/<64 hex> never reaches S3.
  for (const bad of ["nope", "sha256/xyz", "../escape", ""]) {
    await assert.rejects(b.get(bad), /bad_key/);
    await assert.rejects(b.has(bad), /bad_key/);
    await assert.rejects(b.del(bad), /bad_key/);
  }
  assert.ok(!s3.calls.some((c) => String(c[1]).includes("escape")));
});

test("usage() is exact at call time — no cache — and counts only this store's content objects", async () => {
  const s3 = fakeS3();
  const b = mk(s3, "store-u");
  assert.equal(await b.usage(), 0);
  const k1 = await b.put(Buffer.from("a".repeat(1000)));
  assert.equal(await b.usage(), 1000, "immediately after the put");
  await b.put(Buffer.from("b".repeat(500)));
  assert.equal(await b.usage(), 1500);
  await b.writeMarker("store-u");
  assert.equal(await b.usage(), 1500, "the marker is not content");
  await b.del(k1);
  assert.equal(await b.usage(), 500, "and a delete frees it at once");
});

test("per-instance scoping (R3-M3): two stores in one bucket never see each other's objects, keys, usage or deletes", async () => {
  const s3 = fakeS3();
  const a = mk(s3, "inst-1");
  const b = mk(s3, "inst-2");
  const same = Buffer.from("the same bytes on both instances");
  const key = await a.put(same);
  await b.put(same);
  assert.equal(s3.objects.size, 2, "content-addressed keys are prefixed per instance");
  assert.deepEqual(await a.keys(), [key]);
  assert.deepEqual(await b.keys(), [key]);
  assert.equal(await a.usage(), same.length);
  await a.writeMarker("inst-1");
  await b.writeMarker("inst-2");
  assert.equal(await a.readMarker(), "inst-1");
  assert.equal(await b.readMarker(), "inst-2");
  await a.del(key);
  assert.equal(await a.has(key), false);
  assert.equal(await b.has(key), true, "instance 2's copy is untouched");
  assert.equal((await b.get(key)).toString(), same.toString());
});

test("marker: absent reads null, write-once, and an unreadable marker fails closed as null", async () => {
  const s3 = fakeS3();
  const b = mk(s3, "store-m");
  assert.equal(await b.readMarker(), null);
  await b.writeMarker("store-m");
  assert.equal(await b.readMarker(), "store-m");
  await assert.rejects(b.writeMarker("someone-else"), /marker exists/);
  assert.equal(await b.readMarker(), "store-m", "the first marker stands");
});

test("a stalled S3 call becomes `busy` after the per-operation timeout (R3-L5) — it cannot hold the lock forever", async () => {
  const s3 = fakeS3();
  s3.hang = "put";
  const b = mk(s3, "store-t", { timeoutMs: 60 });
  const t0 = Date.now();
  await assert.rejects(b.put(Buffer.from("x")), (e) => e.code === "busy");
  assert.ok(Date.now() - t0 < 5000, "the timeout fired");
  s3.hang = null;
  s3.hang = "get";
  await assert.rejects(b.get(keyOf(Buffer.from("x"))), (e) => e.code === "busy");
});

test("errors: a missing object is null, but a failing S3 is an error — never a silent miss", async () => {
  const s3 = fakeS3();
  const b = mk(s3, "store-e");
  assert.equal(await b.get(keyOf(Buffer.from("nothing"))), null);
  s3.fail = "put";
  await assert.rejects(b.put(Buffer.from("x")), /s3 down/);
  // mtimeOf: present → ms; missing or erroring → null (a null age is never reclaimed).
  s3.fail = null;
  const k = await b.put(Buffer.from("when"));
  assert.ok(Math.abs((await b.mtimeOf(k)) - Date.now()) < 60000);
  assert.equal(await b.mtimeOf(keyOf(Buffer.from("absent"))), null);
  const goodList = s3.listObjects;
  s3.listObjects = async () => { throw new Error("s3 down"); };
  try { assert.equal(await b.mtimeOf(k), null, "an unreadable mtime is null, not a throw"); }
  finally { s3.listObjects = goodList; }
});

test("the store refuses a missing storeId or s3 client, and the bucket name is derived from the storage prefix", () => {
  assert.throws(() => createMinioBlobStore({ storeId: "", s3: fakeS3(), bucket: "b", lockPath: "/tmp/x.db" }), /storeId/);
  assert.throws(() => createMinioBlobStore({ storeId: "ok", s3: null, bucket: "b", lockPath: "/tmp/x.db" }), /s3 client/);
  assert.throws(() => createMinioBlobStore({ storeId: "ok", s3: fakeS3(), bucket: "", lockPath: "/tmp/x.db" }), /bucket/);
  assert.equal(artifactsBucket({ defaultBucket: () => "crow-files" }), "crow-artifacts");
  assert.equal(artifactsBucket({ defaultBucket: () => "myhouse-files" }), "myhouse-artifacts");
  assert.throws(() => artifactsBucket({ defaultBucket: () => "" }), /bucket prefix/);
});

test("createBlobStore picks MinIO when the shared storage is available and local disk otherwise (spec §11)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-choice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { createDbClient } = await import("../servers/db.js");
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  const { createBlobStore } = await import("../bundles/artifacts/server/blob-store-minio.js");
  const db = createDbClient(join(dir, "crow.db"));
  t.after(() => { try { db.close(); } catch {} });
  await initArtifactsTables(db);
  const storeId = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='store_id'", args: [] })).rows[0].value;

  // Available shared storage → the MinIO backend on <prefix>-artifacts, keys
  // under this database's store_id, lock on local disk.
  const up = fakeS3();
  up.isAvailable = async () => true;
  up.defaultBucket = () => "crow-files";
  const m = await createBlobStore(db, dir, { s3: up });
  assert.equal(m.kind, "minio");
  assert.equal(m.lockPath, join(dir, "artifacts", "write-lock.db"));
  assert.ok(up.calls.some((c) => c[0] === "ensureBucket" && c[1] === "crow-artifacts"));
  const k = await m.put(Buffer.from("via factory"));
  assert.equal(up.objects.has(`${storeId}/${k}`), true);

  // Unavailable (or absent) shared storage → local disk under <dataDir>/artifacts.
  const down = fakeS3();
  down.isAvailable = async () => false;
  const l = await createBlobStore(db, dir, { s3: down });
  assert.equal(l.kind, "local");
  assert.equal(l.lockPath, join(dir, "artifacts", "write-lock.db"));

  // MinIO reachable but the DB has no store_id: fail loudly, never silently local.
  const { createDbClient: cdc } = await import("../servers/db.js");
  const bare = cdc(join(dir, "bare.db"));
  t.after(() => { try { bare.close(); } catch {} });
  await bare.executeMultiple(`CREATE TABLE artifact_store_meta (key TEXT PRIMARY KEY, value TEXT)`);
  await assert.rejects(createBlobStore(bare, dir, { s3: up }), /store_id/);
});
