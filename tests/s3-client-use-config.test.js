/**
 * useStorageConfig: a bundle child hands the s3-client an already-opened
 * shared-storage config; the client uses it (bucket prefix, origin) and keeps
 * no identity around to reload with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as s3 from "../servers/storage/s3-client.js";

test("useStorageConfig: the opened config drives bucket and origin; null falls back to the env defaults", () => {
  s3.useStorageConfig({ endpoint: "127.0.0.1:19999", host: "127.0.0.1", port: 19999, useSSL: false, region: "us-east-1", bucketPrefix: "inst2", accessKey: "a", secretKey: "b" });
  assert.equal(s3.defaultBucket(), "inst2-files");
  assert.equal(s3.getStorageOrigin(), "http://127.0.0.1:19999");
  assert.ok(s3.getClient(), "a client is built from the config");
  s3.resetStorageClient(); // no db/identity kept: nothing to reload, config stays
  assert.equal(s3.defaultBucket(), "inst2-files");
  s3.useStorageConfig(null);
  assert.equal(s3.defaultBucket(), "crow-files");
});

test("env fallback: MINIO_PORT applies only to MINIO_ENDPOINT, never on top of S3_ENDPOINT", () => {
  const s3env = s3.envStorageConfig({ S3_ENDPOINT: "100.64.20.5:3900", S3_ACCESS_KEY: "GKabc", S3_SECRET_KEY: "s", MINIO_PORT: "9000", MINIO_USE_SSL: "true" });
  assert.equal(s3env.port, 3900, "a leftover MINIO_PORT does not redirect Garage's endpoint");
  assert.equal(s3env.useSSL, false, "a leftover MINIO_USE_SSL does not apply either");
  assert.equal(s3env.accessKey, "GKabc");
  assert.equal(s3env.region, "us-east-1");
  const minio = s3.envStorageConfig({ MINIO_ENDPOINT: "localhost", MINIO_PORT: "9000", MINIO_ROOT_PASSWORD: "p", MINIO_USE_SSL: "true" });
  assert.equal(minio.host, "localhost");
  assert.equal(minio.port, 9000);
  assert.equal(minio.useSSL, true);
  assert.equal(minio.accessKey, "crowadmin");
  assert.equal(s3.envStorageConfig({}), null);
  assert.equal(s3.envStorageConfig({ S3_ENDPOINT: "h:3900", S3_REGION: "garage" }).region, "garage");
});

test("the client is built with an explicit region (Garage refuses any other)", () => {
  s3.useStorageConfig({ endpoint: "127.0.0.1:3900", host: "127.0.0.1", port: 3900, useSSL: false, region: "us-east-1", bucketPrefix: "crow", accessKey: "a", secretKey: "b" });
  assert.equal(s3.getClient().region, "us-east-1");
  assert.equal(s3.isConfigured(), true);
  s3.useStorageConfig(null);
});

test("useDbStorageConfig wipes the identity's key buffers whether or not the DB held a config", async () => {
  const identity = { seed: new Uint8Array([1, 2, 3]), privKey: new Uint8Array([4, 5]), id: "x" };
  const db = { execute: async () => ({ rows: [] }) };
  assert.equal(await s3.useDbStorageConfig({ db, identity }), false);
  assert.deepEqual([...identity.seed, ...identity.privKey], [0, 0, 0, 0, 0]);
});
