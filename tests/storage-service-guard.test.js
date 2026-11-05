/**
 * storage-service-guard.test.js — the gateway's start-up refusal for the legacy
 * compose storage shape (root docker-compose.yml: Garage is `--profile storage`,
 * MinIO moved to `--profile minio-legacy`).
 *
 * A `.env` carried over from before still says MINIO_ENDPOINT=minio; inside a
 * compose network that name only resolves while the minio service runs. Without
 * the guard the gateway boots and every upload dies on a DNS error, so the
 * gateway must exit 78 with one clear line instead.
 *
 * The guard is deliberately narrow, and these tests are the proof:
 *   - trips when `minio` does not resolve (ENOTFOUND / EAI_AGAIN) twice, 2 s apart;
 *   - never trips when S3_ENDPOINT is set (it wins over MINIO_*);
 *   - never trips for another endpoint value;
 *   - never trips when the lookup succeeds;
 *   - never trips on any other lookup failure (a timeout is not a missing service).
 * The resolver, the sleep and exit are injected: no DNS, no real exit, no waiting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refuseMissingMinioService, runStorageServiceGuard,
  MISSING_MINIO_MESSAGE, STORAGE_SERVICE_EXIT_CODE,
} from "../servers/gateway/boot/storage-service-guard.js";

/** A resolver that always rejects with `code`. */
const failing = (code) => async () => { throw Object.assign(new Error(`lookup failed: ${code}`), { code }); };
/** A resolver that always answers (the address is irrelevant to the guard). */
const answering = async () => ({ address: "test-address", family: 4 });

/** Run the guard with a recording log/exit/swallow-sleep. */
async function run({ env, resolve }) {
  const lines = [];
  const exits = [];
  const slept = [];
  const result = await refuseMissingMinioService({
    env,
    resolve,
    sleep: async (ms) => { slept.push(ms); },
    log: { error: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) },
    exit: (code) => exits.push(code),
  });
  return { result, lines, exits, slept };
}

// ── trips ──

test("trips on ENOTFOUND for minio: exit 78 and one exact stderr line", async () => {
  const { result, lines, exits } = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: failing("ENOTFOUND") });
  assert.equal(result.tripped, true);
  assert.deepEqual(exits, [STORAGE_SERVICE_EXIT_CODE]);
  assert.equal(STORAGE_SERVICE_EXIT_CODE, 78, "EX_CONFIG: RestartPreventExitStatus=78 stops a restart loop");
  assert.deepEqual(lines, [MISSING_MINIO_MESSAGE], "exactly one line, nothing else");
  assert.equal(MISSING_MINIO_MESSAGE,
    "MINIO_ENDPOINT=minio but no MinIO service is running. Object storage now uses Garage: " +
    "run with --profile storage and set S3_* (see .env.example), or keep MinIO with --profile minio-legacy.");
});

test("trips on EAI_AGAIN too (a temporary resolver failure, retried)", async () => {
  const { result, exits } = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: failing("EAI_AGAIN") });
  assert.equal(result.tripped, true);
  assert.deepEqual(exits, [78]);
});

test("tries twice, 2 s apart — one blip does not refuse the boot", async () => {
  let calls = 0;
  const blip = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    return { address: "test-address", family: 4 };
  };
  const { result, exits, slept } = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: blip });
  assert.equal(result.tripped, false, "the second try resolved");
  assert.deepEqual(exits, []);
  assert.equal(calls, 2);
  assert.deepEqual(slept, [2000], "exactly one 2 s gap between the two tries");
});

// ── never trips ──

test("no trip when S3_ENDPOINT is set: it wins over the dead MINIO_* name", async () => {
  const { result, exits } = await run({
    env: { MINIO_ENDPOINT: "minio", S3_ENDPOINT: "garage:3900" },
    resolve: failing("ENOTFOUND"),
  });
  assert.equal(result.tripped, false);
  assert.deepEqual(exits, []);
});

test("no trip for another endpoint value: the guard is about the compose service name only", async () => {
  for (const value of ["localhost", "127.0.0.1", "minio.example.com", " minio-other "]) {
    const { result, exits } = await run({ env: { MINIO_ENDPOINT: value }, resolve: failing("ENOTFOUND") });
    assert.equal(result.tripped, false, `MINIO_ENDPOINT=${value} must not trip`);
    assert.deepEqual(exits, []);
  }
  // Not set at all: nothing to check.
  assert.equal((await run({ env: {}, resolve: failing("ENOTFOUND") })).result.tripped, false);
});

test("no trip when the lookup succeeds (the minio service is running)", async () => {
  const { result, exits, lines } = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: answering });
  assert.equal(result.tripped, false);
  assert.deepEqual(exits, []);
  assert.deepEqual(lines, []);
});

test("no trip on a lookup failure that is not ENOTFOUND/EAI_AGAIN (a resolver timeout says nothing about the service)", async () => {
  for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", undefined]) {
    const { result, exits } = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: failing(code) });
    assert.equal(result.tripped, false, `a ${code} lookup must not refuse the boot`);
    assert.deepEqual(exits, []);
  }
});

// ── the boot wrapper never throws ──

test("runStorageServiceGuard passes the tripped verdict on without throwing", async () => {
  const exits = [];
  const r = await runStorageServiceGuard({
    env: { MINIO_ENDPOINT: "minio" },
    resolve: failing("ENOTFOUND"),
    sleep: async () => {},
    log: { error: () => {}, warn: () => {} },
    exit: (code) => exits.push(code),
  });
  assert.equal(r.tripped, true);
  assert.deepEqual(exits, [78]);
});

test("runStorageServiceGuard returns instead of throwing when the check itself fails", async () => {
  const r = await runStorageServiceGuard({
    env: { MINIO_ENDPOINT: "minio" },
    // A lookup rejecting with a non-DNS error carries no code to judge by.
    resolve: async () => { throw new Error("no code"); },
    sleep: async () => {},
    log: { error: () => {}, warn: () => {} },
    exit: () => { throw new Error("exit must not be reached"); },
  });
  assert.deepEqual(r, { tripped: false, reason: "lookup-error" });
});