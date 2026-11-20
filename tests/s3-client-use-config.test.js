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

/** Run `fn` with a fixed env, restoring every name afterwards. */
function withEnv(over, fn) {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, over);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the env path carries S3_BUCKET_PREFIX too, so a custom prefix never writes crow-files", () => {
  withEnv({ S3_ENDPOINT: "127.0.0.1:3900", S3_SECRET_KEY: "s", S3_BUCKET_PREFIX: "inst9" }, () => {
    const env = s3.envStorageConfig();
    assert.equal(env.bucketPrefix, "inst9");
    assert.equal(env.endpoint, "127.0.0.1:3900");
    s3.useStorageConfig(null); // no opened config: the env path decides
    assert.equal(s3.defaultBucket(), "inst9-files");
    assert.equal(s3.isConfigured(), true);
  });
  s3.useStorageConfig(null);
  assert.equal(s3.defaultBucket(), "crow-files", "no prefix configured: the legacy bucket");
});

test("a bot turn with no shared storage (marker off) has NO client, whatever the env says", () => {
  withEnv({ S3_ENDPOINT: "localhost:9000", S3_ACCESS_KEY: "a", S3_SECRET_KEY: "b" }, () => {
    assert.equal(s3.adoptHostStorage({ CROW_STORAGE_FROM_HOST: "0" }), "off");
    assert.equal(s3.getClient(), null, "never the inherited localhost fallback");
    assert.equal(s3.isConfigured(), false);
    assert.equal(s3.getStorageOrigin(), null);
    assert.equal(s3.storageOffReason(), s3.STORAGE_OFF_FILE_DELIVERY);
  });
  s3.useStorageConfig(null);
});

test("the marker is honoured BEFORE the identity load, even by a child that never called adoptHostStorage", async () => {
  // A bundle can import this module without adopting anything first (an undeclared consumer, or
  // an installed copy from before its `needs` bump). Marker 0 must therefore stop it here: no
  // identity read, no DB read, no env fallback.
  const saved = process.env.CROW_STORAGE_FROM_HOST;
  let touched = 0;
  try {
    process.env.CROW_STORAGE_FROM_HOST = "0";
    const db = { execute: async () => { touched += 1; return { rows: [] }; } };
    assert.equal(await s3.useDbStorageConfigFromInstance(db), false, "no settings, and no owner path");
    assert.equal(touched, 0, "the DB is never read: opening the identity is what would read it");
    assert.equal(s3.getClient(), null, "and the inherited env is not a fallback");
    assert.equal(s3.storageOffReason(), s3.STORAGE_OFF_FILE_DELIVERY);
    // Marker 1 is the hydrated turn: the spawning process already wired these settings, so the
    // answer is true — and still no identity, and no DB read.
    process.env.CROW_STORAGE_FROM_HOST = "1";
    process.env.S3_ENDPOINT = "127.0.0.1:19998";
    process.env.S3_SECRET_KEY = "piped-secret";
    assert.equal(await s3.useDbStorageConfigFromInstance({ execute: async () => { touched += 1; return { rows: [] }; } }), true);
    assert.equal(touched, 0);
    assert.equal(s3.isConfigured(), true);
  } finally {
    for (const k of ["S3_ENDPOINT", "S3_SECRET_KEY"]) delete process.env[k];
    if (saved === undefined) delete process.env.CROW_STORAGE_FROM_HOST;
    else process.env.CROW_STORAGE_FROM_HOST = saved;
    s3.useStorageConfig(null);
  }
});

test("a hydrated block (marker on) is configured from the piped S3_* and never from the identity", () => {
  const env = { CROW_STORAGE_FROM_HOST: "1", S3_ENDPOINT: "127.0.0.1:19999", S3_SECRET_KEY: "piped", S3_BUCKET_PREFIX: "fx" };
  assert.equal(s3.adoptHostStorage(env), "hydrated");
  assert.equal(s3.isConfigured(), true);
  assert.equal(s3.getStorageOrigin(), "http://127.0.0.1:19999");
  assert.equal(s3.defaultBucket(), "fx-files");
  // The marker is also what a child checks to skip identity.js entirely.
  assert.equal(s3.storageFromHostMode({}), null, "no marker: the owner's own spawn");
  assert.equal(s3.storageFromHostMode({ CROW_STORAGE_FROM_HOST: "off" }), "off");
  s3.useStorageConfig(null);
});
