/**
 * providers-upsert-noop — D2 of the providers-sync volatile-models spec
 * (.superpowers/sdd/providers-volatile-spec.md).
 *
 * upsertProvider must suppress no-op writes: when the write-image (the exact
 * values the INSERT would compute) matches the stored row on every content
 * column, it returns { id, lamport_ts, unchanged: true } with NO DB write,
 * NO lamport bump, and NO emitChange. Any real change (or an absent row)
 * keeps today's write+bump+emit behavior exactly.
 *
 * Comparator normalization under test (R1-F6):
 *   - disabled: 0/1-vs-bool equivalence both sides
 *   - api_key: null ≡ "" (both mean "no key")
 *   - models / gpu_policy: canonical deep-equal on parsed JSON
 *     (key-order-insensitive, arrays order-sensitive)
 *   - gpu_policy incoming null ≡ unchanged (mirrors the write path's COALESCE)
 *   - corrupt DB-side JSON → CHANGED (R2-m3 fail-open: the good content heals
 *     the row; fail-closed would make corruption permanent)
 *
 * Harness: freshLibsql() pattern from accept-idempotent.test.js. The test
 * process sets CROW_DATA_DIR to the per-test tmp dir BEFORE any upsert so
 * getOrCreateLocalInstanceId() (instance-registry.js:333) writes its
 * instance-id file there — the real ~/.crow is never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertProvider, setProviderSyncManager } from "../servers/shared/providers-db.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "providers-upsert-noop-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  // getOrCreateLocalInstanceId() keys on process.env.CROW_DATA_DIR — point it
  // at the tmp dir so the instance-id file lands there, never in ~/.crow.
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir, db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Spy on the sync manager exactly the way emitSync consumes it
// (providers-db.js: _syncManager.emitChange("providers", op, row)).
function spySyncManager() {
  const calls = [];
  setProviderSyncManager({ emitChange: async (...a) => { calls.push(a); } });
  return calls;
}

// A provider covering every content column, with nested models structure.
function baseProvider() {
  return {
    id: "noop-test-prov",
    baseUrl: "http://100.118.41.122:8003/v1",
    apiKey: null,
    host: "local",
    bundleId: null,
    description: "no-op suppression test provider",
    models: [
      {
        id: "m1",
        name: "Model One",
        contextWindow: 262144,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0 },
      },
      { id: "m2", name: "Model Two", contextWindow: 8192 },
    ],
    disabled: false,
    providerType: "openai-compat",
    gpuPolicy: { mutexGroup: "vram", alwaysResident: false, defaultMember: true },
  };
}

async function dbRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

// --- a. identical re-upsert → unchanged, lamport stable, ONE emit ---
test("identical re-upsert is a no-op: unchanged:true, lamport stable, emitChange called exactly once", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    const first = await upsertProvider(db, baseProvider());
    assert.equal(calls.length, 1, "insert emits once");
    assert.notEqual(first.unchanged, true, "insert is not 'unchanged'");
    const tsAfterInsert = Number((await dbRow(db, "noop-test-prov")).lamport_ts);

    const second = await upsertProvider(db, baseProvider());
    assert.equal(second.unchanged, true, "identical re-upsert reports unchanged");
    assert.equal(calls.length, 1, "no second emit for unchanged content");
    const tsAfterNoop = Number((await dbRow(db, "noop-test-prov")).lamport_ts);
    assert.equal(tsAfterNoop, tsAfterInsert, "lamport_ts not bumped in DB");
  } finally { cleanup(); }
});

// --- b. each content column changed one at a time → write + bump + second emit ---
const columnMutations = {
  base_url: (p) => { p.baseUrl = "http://100.121.254.89:9999/v1"; },
  api_key: (p) => { p.apiKey = "sk-changed"; },
  host: (p) => { p.host = "cloud"; },
  bundle_id: (p) => { p.bundleId = "some-bundle"; },
  description: (p) => { p.description = "changed description"; },
  "models nested value": (p) => { p.models[0].name = "Model One Renamed"; },
  disabled: (p) => { p.disabled = true; },
  provider_type: (p) => { p.providerType = "anthropic"; },
  "gpu_policy object": (p) => { p.gpuPolicy = { mutexGroup: "vram-b", alwaysResident: true, defaultMember: true }; },
};

for (const [column, mutate] of Object.entries(columnMutations)) {
  test(`changed column '${column}' → write + lamport bump + second emit`, async () => {
    const { db, cleanup } = freshLibsql();
    try {
      const calls = spySyncManager();
      const first = await upsertProvider(db, baseProvider());
      const changed = baseProvider();
      mutate(changed);
      const second = await upsertProvider(db, changed);
      assert.notEqual(second.unchanged, true, `'${column}' change must not be suppressed`);
      assert.equal(calls.length, 2, `'${column}' change emits a second time`);
      assert.ok(Number(second.lamport_ts) > Number(first.lamport_ts), `'${column}' change bumps lamport`);
      const row = await dbRow(db, "noop-test-prov");
      assert.equal(Number(row.lamport_ts), Number(second.lamport_ts), "DB row carries the bumped lamport");
    } finally { cleanup(); }
  });
}

// --- c. disabled trap: false vs stored 0, and 0 vs false ---
test("disabled trap: disabled:false re-upsert over DB-stored 0 is unchanged; 0-vs-false equivalent", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    await upsertProvider(db, baseProvider()); // stores disabled = 0
    const again = baseProvider();
    again.disabled = false;
    const res = await upsertProvider(db, again);
    assert.equal(res.unchanged, true, "false over stored 0 is unchanged");

    const zero = baseProvider();
    zero.disabled = 0;
    const res2 = await upsertProvider(db, zero);
    assert.equal(res2.unchanged, true, "disabled:0 ≡ disabled:false");
    assert.equal(calls.length, 1, "only the original insert emitted");
  } finally { cleanup(); }
});

// --- d. models key-order shuffle → unchanged ---
test("models with shuffled object key order are unchanged (canonical deep-equal, not string compare)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    await upsertProvider(db, baseProvider());
    const shuffled = baseProvider();
    shuffled.models = [
      {
        cost: { output: 0, input: 0 },
        input: ["text"],
        reasoning: true,
        contextWindow: 262144,
        name: "Model One",
        id: "m1",
      },
      { contextWindow: 8192, id: "m2", name: "Model Two" },
    ];
    const res = await upsertProvider(db, shuffled);
    assert.equal(res.unchanged, true, "key-order shuffle is not a change");
    assert.equal(calls.length, 1, "no emit for key-order shuffle");
  } finally { cleanup(); }
});

// --- e. nested contextWindow change inside models[0] → CHANGED ---
test("nested contextWindow change inside models[0] is detected as CHANGED", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    await upsertProvider(db, baseProvider());
    const changed = baseProvider();
    changed.models[0].contextWindow = 1048576; // the exact live-drift value
    const res = await upsertProvider(db, changed);
    assert.notEqual(res.unchanged, true, "nested contextWindow change must write");
    assert.equal(calls.length, 2, "nested change emits");
  } finally { cleanup(); }
});

// --- f. api_key null vs "" → unchanged ---
test("api_key null ≡ '' (both mean no key) → unchanged", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    const p = baseProvider();
    p.apiKey = null;
    await upsertProvider(db, p);
    const empty = baseProvider();
    empty.apiKey = "";
    const res = await upsertProvider(db, empty);
    assert.equal(res.unchanged, true, "'' over stored null is unchanged");
    assert.equal(calls.length, 1, "no emit for null-vs-empty api_key");
  } finally { cleanup(); }
});

// --- g. gpu_policy incoming null/undefined over a stored policy → unchanged (COALESCE) ---
test("gpu_policy: stored policy + incoming gpuPolicy undefined/null → unchanged (COALESCE semantics)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    await upsertProvider(db, baseProvider()); // stores a gpu_policy
    const noPolicy = baseProvider();
    delete noPolicy.gpuPolicy; // undefined
    const res = await upsertProvider(db, noPolicy);
    assert.equal(res.unchanged, true, "undefined gpuPolicy leaves the column untouched → unchanged");

    const nullPolicy = baseProvider();
    nullPolicy.gpuPolicy = null;
    const res2 = await upsertProvider(db, nullPolicy);
    assert.equal(res2.unchanged, true, "null gpuPolicy also unchanged");
    assert.equal(calls.length, 1, "no emit for null-policy re-upserts");

    const row = await dbRow(db, "noop-test-prov");
    assert.ok(row.gpu_policy, "stored gpu_policy preserved");
  } finally { cleanup(); }
});

// --- h. corrupt DB JSON → CHANGED (R2-m3 fail-open), row healed ---
test("corrupt DB models JSON → CHANGED (fail-open): identical re-upsert writes, emits, and heals the row", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    await upsertProvider(db, baseProvider());
    await db.execute({
      sql: "UPDATE providers SET models = ? WHERE id = ?",
      args: ["{bad json", "noop-test-prov"],
    });
    const res = await upsertProvider(db, baseProvider());
    assert.notEqual(res.unchanged, true, "corrupt DB JSON must be treated as CHANGED (fail-open)");
    assert.equal(calls.length, 2, "healing write emits");
    const row = await dbRow(db, "noop-test-prov");
    assert.doesNotThrow(() => {
      const parsed = JSON.parse(row.models);
      assert.equal(parsed[0].id, "m1");
    }, "row healed: models parses again");
  } finally { cleanup(); }
});

// --- i. return shape on the unchanged path ---
test("unchanged path returns { id, lamport_ts: <number>, unchanged: true }", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    spySyncManager();
    const first = await upsertProvider(db, baseProvider());
    const res = await upsertProvider(db, baseProvider());
    assert.equal(res.id, "noop-test-prov");
    assert.equal(res.unchanged, true);
    assert.equal(typeof res.lamport_ts, "number", "lamport_ts is a plain Number (libsql may hand back BigInt)");
    assert.equal(res.lamport_ts, Number(first.lamport_ts), "unchanged path reports the current row lamport");
  } finally { cleanup(); }
});
