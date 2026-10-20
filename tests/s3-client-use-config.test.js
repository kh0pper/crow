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
