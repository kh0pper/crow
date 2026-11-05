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
 *   - never trips when a COMPLETE Shared Storage config is stored in the DB, which is
 *     what servers/storage/s3-client.js uses FIRST (env is only its fallback);
 *   - never trips for another endpoint value;
 *   - never trips when the lookup succeeds;
 *   - never trips on any other lookup failure (a timeout is not a missing service).
 * The resolver, the sleep, exit and the DB reader are injected: no DNS, no real exit,
 * no waiting. The DB reader itself is exercised for real (temp data dir, real identity,
 * real sealed settings) in the last test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  refuseMissingMinioService, runStorageServiceGuard, readSharedStorageEndpoint,
  MISSING_MINIO_MESSAGE, STORAGE_SERVICE_EXIT_CODE,
} from "../servers/gateway/boot/storage-service-guard.js";

/** A resolver that always rejects with `code`. */
const failing = (code) => async () => { throw Object.assign(new Error(`lookup failed: ${code}`), { code }); };
/** A resolver that always answers (the address is irrelevant to the guard). */
const answering = async () => ({ address: "test-address", family: 4 });
/** No Shared Storage in the DB (the default for these cases: the env decides). */
const noDb = async () => null;

/** Run the guard with a recording log/exit/swallow-sleep. */
async function run({ env, resolve, sharedEndpoint = noDb }) {
  const lines = [];
  const exits = [];
  const slept = [];
  const result = await refuseMissingMinioService({
    env,
    sharedEndpoint,
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

test("no trip when the DB holds a complete Shared Storage config: the client prefers the DB over env", async () => {
  // The compose host this protects: .env still says MINIO_ENDPOINT=minio, but storage
  // is a Garage configured in Settings → Shared Storage, so getClient() never looks at
  // MINIO_* and the missing `minio` service costs nothing.
  const { result, exits, lines } = await run({
    env: { MINIO_ENDPOINT: "minio" },
    resolve: failing("ENOTFOUND"),
    sharedEndpoint: async () => "garage:3900",
  });
  assert.deepEqual(result, { tripped: false, reason: "db-storage-configured" });
  assert.deepEqual(exits, []);
  assert.deepEqual(lines, []);
});

test("the DB is only read after the two env short-circuits (a normal boot never touches it)", async () => {
  let reads = 0;
  const count = async () => { reads += 1; return null; };
  await run({ env: { S3_ENDPOINT: "garage:3900", MINIO_ENDPOINT: "minio" }, resolve: failing("ENOTFOUND"), sharedEndpoint: count });
  await run({ env: { MINIO_ENDPOINT: "localhost" }, resolve: failing("ENOTFOUND"), sharedEndpoint: count });
  await run({ env: {}, resolve: failing("ENOTFOUND"), sharedEndpoint: count });
  assert.equal(reads, 0, "no settings read on a boot the env already answers");
  await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: answering, sharedEndpoint: count });
  assert.equal(reads, 1, "the legacy shape does ask once, before DNS");
});

test("an unreadable settings read falls back to the env verdict instead of refusing a boot on its own", async () => {
  const boom = async () => { throw new Error("dashboard_settings is locked"); };
  // The service answers: no trip, and the failure is only a warning.
  const ok = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: answering, sharedEndpoint: boom });
  assert.equal(ok.result.tripped, false);
  assert.deepEqual(ok.exits, []);
  assert.equal(ok.lines.length, 1);
  assert.match(ok.lines[0], /^WARN \[storage-guard\] Shared Storage settings unreadable/);
  // The service really is gone: the env verdict still holds.
  const gone = await run({ env: { MINIO_ENDPOINT: "minio" }, resolve: failing("ENOTFOUND"), sharedEndpoint: boom });
  assert.equal(gone.result.tripped, true);
  assert.deepEqual(gone.exits, [78]);
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
    sharedEndpoint: noDb,
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
    sharedEndpoint: noDb,
    // A lookup rejecting with a non-DNS error carries no code to judge by.
    resolve: async () => { throw new Error("no code"); },
    sleep: async () => {},
    log: { error: () => {}, warn: () => {} },
    exit: () => { throw new Error("exit must not be reached"); },
  });
  assert.deepEqual(r, { tripped: false, reason: "lookup-error" });
});

// ── the real reader (no stubs: temp data dir, real identity, real sealed settings) ──

test("readSharedStorageEndpoint: no identity → null; a complete sealed config → its endpoint; a partial one → null", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crow-guard-db-"));
  const prevData = process.env.CROW_DATA_DIR;
  const prevDb = process.env.CROW_DB_PATH;
  process.env.CROW_DATA_DIR = dataDir;
  process.env.CROW_DB_PATH = join(dataDir, "crow.db");
  try {
    // First boot shape: no identity, so no sealed settings — and the client would
    // have no DB config either, so null is the honest answer, not a failure.
    assert.equal(await readSharedStorageEndpoint(), null);

    // A real instance identity (created in this temp dir) and a real DB table.
    const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
    const { sealSecret } = await import("../servers/sharing/secret-box.js");
    const identity = loadOrCreateIdentity();
    const db = new Database(join(dataDir, "crow.db"));
    db.exec("CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT)");
    const put = db.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, ?)");
    put.run("storage.shared.endpoint", "garage:3900");
    // Endpoint alone is a half-synced window: s3-client keeps using env, and so does the guard.
    assert.equal(await readSharedStorageEndpoint(), null);
    put.run("storage.shared.access_key", sealSecret("GKabcd0123456789abcdef01", identity));
    put.run("storage.shared.secret_key", sealSecret("a".repeat(64), identity));
    db.close();

    assert.equal(await readSharedStorageEndpoint(), "garage:3900", "the same complete config the client would use");
  } finally {
    if (prevData === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevData;
    if (prevDb === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDb;
    rmSync(dataDir, { recursive: true, force: true });
  }
});