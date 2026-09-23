/**
 * upsertProvider external-engine validation is TRANSITION-ONLY (spec
 * docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.2,
 * revised after review round 1): a write is refused only when it CHANGES
 * engine / bundleId / runtime and the result is invalid. Replication writes
 * rows directly, so contradictory or malformed rows are seeded here with raw
 * SQL, and today's write paths (tab re-enable, reenableProviderPreservingContent,
 * repairProviderHosts, the models.json reconciler) must keep working on them.
 *
 * Harness: freshLibsql() from providers-reconcile-gate.test.js — per-test
 * init-db'd tmp DB, CROW_DATA_DIR and CROW_MODELS_JSON pointed into it, so
 * neither the real ~/.crow nor any real models.json is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  upsertProvider, listProvidersAll, setProviderSyncManager,
  reenableProviderPreservingContent, repairProviderHosts, syncProvidersFromModelsJson,
  _resetEngineSkipLogForTest,
} from "../servers/shared/providers-db.js";

function freshLibsql(fixtureProviders = {}) {
  const dir = mkdtempSync(join(tmpdir(), "providers-ext-engine-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const fixturePath = join(dir, "models.fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ providers: fixtureProviders }));
  const prevDataDir = process.env.CROW_DATA_DIR;
  const prevModelsJson = process.env.CROW_MODELS_JSON;
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = fixturePath;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      if (prevModelsJson === undefined) delete process.env.CROW_MODELS_JSON;
      else process.env.CROW_MODELS_JSON = prevModelsJson;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ENGINE = { managed: "external", host: "raven", label: "halogen" };
const RAVEN = "http://10.0.0.126:8030/v1";
const ravenRow = (extra = {}) => ({
  id: "raven-flash-next",
  baseUrl: RAVEN,
  apiKey: null,
  host: "cloud",
  bundleId: null,
  description: "raven halogen",
  models: [{ id: "flash-next" }],
  disabled: false,
  providerType: "openai-compat",
  ...extra,
});

/** Seed a row the way replication does: raw SQL, no validation. */
async function seedRaw(db, { id, baseUrl = RAVEN, host = "cloud", bundleId = null, gpuPolicy, disabled = 0, instanceId = "peer-instance" }) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, api_key, host, bundle_id, description, models, disabled, lamport_ts, instance_id, provider_type, gpu_policy)
          VALUES (?, ?, NULL, ?, ?, NULL, '[{"id":"m"}]', ?, 5, ?, 'openai-compat', ?)`,
    args: [id, baseUrl, host, bundleId, disabled, instanceId, gpuPolicy == null ? null : (typeof gpuPolicy === "string" ? gpuPolicy : JSON.stringify(gpuPolicy))],
  });
}

async function stored(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] || null;
}
const policyOf = (row) => (row?.gpu_policy == null ? null : JSON.parse(row.gpu_policy));
const code = (c) => (err) => err?.code === c;

// --- new invalid rows are refused -------------------------------------------

test("a valid marker on a cloud row is accepted and stored", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    assert.deepEqual(policyOf(await stored(h.db, "raven-flash-next")).engine, ENGINE);
  } finally { h.cleanup(); }
});

test("a NEW row with marker + bundleId is refused (EXTERNAL_ENGINE_CONFLICT); nothing written", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ bundleId: "halogen", gpuPolicy: { engine: ENGINE } })), code("EXTERNAL_ENGINE_CONFLICT"));
    assert.equal(await stored(h.db, "raven-flash-next"), null);
  } finally { h.cleanup(); }
});

test("a NEW row with marker + native runtime is refused (EXTERNAL_ENGINE_CONFLICT)", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE, runtime: "native" } })), code("EXTERNAL_ENGINE_CONFLICT"));
  } finally { h.cleanup(); }
});

test("introducing a malformed marker is refused (EXTERNAL_ENGINE_INVALID): typo'd managed, missing host, empty host", async () => {
  const h = freshLibsql();
  try {
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: { managed: "External", host: "raven" } } })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: { managed: "external" } } })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: JSON.stringify({ engine: { managed: "external", host: "" } }) })), code("EXTERNAL_ENGINE_INVALID"));
  } finally { h.cleanup(); }
});

test("a malformed incoming gpu_policy JSON string that DIFFERS from the stored one is INVALID, not 'keep stored'", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { mutexGroup: "g" } }));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: "{not json" })), code("EXTERNAL_ENGINE_INVALID"));
    await assert.rejects(upsertProvider(h.db, ravenRow({ gpu_policy: "[1,2]" })), code("EXTERNAL_ENGINE_INVALID"));
    assert.deepEqual(policyOf(await stored(h.db, "raven-flash-next")), { mutexGroup: "g" }, "stored policy untouched");
  } finally { h.cleanup(); }
});

test("COALESCE hole: a null-policy write that NEWLY adds a bundleId to a marked row is refused", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    await assert.rejects(upsertProvider(h.db, ravenRow({ bundleId: "halogen", gpuPolicy: null })), code("EXTERNAL_ENGINE_CONFLICT"));
    const row = await stored(h.db, "raven-flash-next");
    assert.equal(row.bundle_id, null);
    assert.deepEqual(policyOf(row).engine, ENGINE, "marker untouched");
  } finally { h.cleanup(); }
});

test("no one-step adoption: a registerModel-shaped native write over a marked row is refused; unmark-then-register works", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    const native = { runtime: "native", catalogId: "x", quant: "Q4", port: 18200 };
    await assert.rejects(upsertProvider(h.db, ravenRow({ host: "local", gpuPolicy: native })), code("EXTERNAL_ENGINE_CONFLICT"));
    await upsertProvider(h.db, ravenRow({ gpuPolicy: {} })); // explicit unmark, its own write
    assert.equal(policyOf(await stored(h.db, "raven-flash-next")).engine, undefined);
    await upsertProvider(h.db, ravenRow({ host: "local", gpuPolicy: native }));
    assert.equal(policyOf(await stored(h.db, "raven-flash-next")).runtime, "native");
  } finally { h.cleanup(); }
});

test("the marking path ({...listProvidersAll row, gpuPolicy + engine}) passes; a spread re-enable of the marked row is a no-op", async () => {
  const h = freshLibsql();
  try {
    await upsertProvider(h.db, ravenRow());
    let row = (await listProvidersAll(h.db)).find((r) => r.id === "raven-flash-next");
    await upsertProvider(h.db, { ...row, gpuPolicy: { ...(row.gpuPolicy || {}), engine: ENGINE } });
    row = (await listProvidersAll(h.db)).find((r) => r.id === "raven-flash-next");
    assert.deepEqual(row.gpuPolicy.engine, ENGINE);
    assert.equal(row.host, "cloud", "host stays cloud (spec §2.1)");
    const r = await upsertProvider(h.db, { ...row, disabled: false });
    assert.equal(r.unchanged, true);
  } finally { h.cleanup(); }
});

// --- replicated contradictory / malformed rows keep accepting today's writes --

test("replicated contradictory row (marker + bundle): the tab's {...row, disabled:false} write passes", async () => {
  const h = freshLibsql();
  try {
    await seedRaw(h.db, { id: "rep-bundle", bundleId: "halogen", gpuPolicy: { engine: ENGINE }, disabled: 1 });
    const row = (await listProvidersAll(h.db)).find((r) => r.id === "rep-bundle");
    await upsertProvider(h.db, { ...row, disabled: false });
    assert.equal(Number((await stored(h.db, "rep-bundle")).disabled), 0);
  } finally { h.cleanup(); }
});

test("replicated contradictory and malformed rows: reenableProviderPreservingContent passes", async () => {
  const h = freshLibsql();
  try {
    await seedRaw(h.db, { id: "rep-native", gpuPolicy: { engine: ENGINE, runtime: "native" }, disabled: 1 });
    await seedRaw(h.db, { id: "rep-typo", gpuPolicy: { engine: { managed: "External", host: "raven" } }, disabled: 1 });
    assert.ok(await reenableProviderPreservingContent(h.db, "rep-native"));
    assert.ok(await reenableProviderPreservingContent(h.db, "rep-typo"));
    assert.equal(Number((await stored(h.db, "rep-native")).disabled), 0);
    assert.equal(Number((await stored(h.db, "rep-typo")).disabled), 0);
  } finally { h.cleanup(); }
});

test("replicated contradictory row: repairProviderHosts still repairs its host", async () => {
  const h = freshLibsql();
  try {
    // In repair scope: no bundle, no owner, written by THIS instance, host "local" but the IP is not ours.
    await seedRaw(h.db, { id: "rep-repair", host: "local", gpuPolicy: { engine: ENGINE, runtime: "native" }, instanceId: "own-instance" });
    const res = await repairProviderHosts(h.db, {
      ownInstanceId: "own-instance",
      ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]),
    });
    assert.deepEqual(res.changes.map((c) => c.id), ["rep-repair"]);
    assert.equal((await stored(h.db, "rep-repair")).host, "cloud");
  } finally { h.cleanup(); }
});

test("replicated contradictory row: the reconciler re-asserts it (same bundle, engine preserved) without failing", async () => {
  const h = freshLibsql({
    "rep-recon": { baseUrl: RAVEN, bundleId: "halogen", mutexGroup: "g", models: [{ id: "m" }] },
  });
  try {
    await seedRaw(h.db, { id: "rep-recon", bundleId: "halogen", gpuPolicy: { engine: ENGINE } });
    const res = await syncProvidersFromModelsJson(h.db, { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) });
    assert.equal(res.failed, 0);
    const p = policyOf(await stored(h.db, "rep-recon"));
    assert.equal(p.mutexGroup, "g");
    assert.deepEqual(p.engine, ENGINE);
  } finally { h.cleanup(); }
});

// --- reconciler: Q3 (engine preserved) and per-row isolation ------------------

test("Q3: the reconciler keeps a stored engine when it re-asserts a gpuPolicy", async () => {
  const h = freshLibsql({
    "raven-flash-next": { baseUrl: RAVEN, mutexGroup: "g", alwaysResident: false, models: [{ id: "flash-next" }] },
  });
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    const res = await syncProvidersFromModelsJson(h.db, { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) });
    assert.equal(res.failed, 0);
    const p = policyOf(await stored(h.db, "raven-flash-next"));
    assert.equal(p.mutexGroup, "g", "file content asserted");
    assert.deepEqual(p.engine, ENGINE, "marker survived the reconcile");
  } finally { h.cleanup(); }
});

test("reconciler isolation: one refused entry is counted each run but logged ONCE per process; the rest of the pass still runs", async () => {
  _resetEngineSkipLogForTest();
  const h = freshLibsql({
    "raven-flash-next": { baseUrl: RAVEN, bundleId: "halogen", models: [{ id: "flash-next" }] }, // newly adds a bundle to a marked row
    "fx-loop": { baseUrl: "http://127.0.0.1:8011/v1", models: [{ id: "m" }] },
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await upsertProvider(h.db, ravenRow({ gpuPolicy: { engine: ENGINE } }));
    const own = { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) };
    const first = await syncProvidersFromModelsJson(h.db, own);
    const second = await syncProvidersFromModelsJson(h.db, own); // the next hourly pass
    assert.equal(first.failed, 1);
    assert.equal(second.failed, 1);
    assert.ok(await stored(h.db, "fx-loop"), "the next entry was still seeded");
    assert.equal((await stored(h.db, "raven-flash-next")).bundle_id, null, "refused write left the row alone");
    const lines = warns.filter((w) => w.includes("[providers-reconcile] raven-flash-next skipped: EXTERNAL_ENGINE_CONFLICT"));
    assert.equal(lines.length, 1, warns.join("\n"));
  } finally {
    console.warn = origWarn;
    h.cleanup();
  }
});

// --- round 2: malformed stored policies survive spread writes; only
// EXTERNAL_ENGINE_* errors are swallowed per row ------------------------------

for (const raw of ["[1]", "7"]) {
  test(`replicated row with a non-object gpu_policy ${raw} survives the tab enable, reenable, repair and the reconciler`, async () => {
    const h = freshLibsql({
      "rep-malformed": { baseUrl: RAVEN, mutexGroup: "g", models: [{ id: "m" }] },
    });
    try {
      await seedRaw(h.db, { id: "rep-malformed", host: "local", gpuPolicy: raw, disabled: 1, instanceId: "own-instance" });
      // 1. the Providers tab's llm_provider_enable spread write
      const row = (await listProvidersAll(h.db)).find((r) => r.id === "rep-malformed");
      await upsertProvider(h.db, { ...row, disabled: false });
      // 2. reenableProviderPreservingContent
      await h.db.execute({ sql: "UPDATE providers SET disabled = 1 WHERE id = ?", args: ["rep-malformed"] });
      assert.ok(await reenableProviderPreservingContent(h.db, "rep-malformed"));
      // 3. repairProviderHosts (host "local" on a LAN IP that is not ours → repaired to cloud).
      // The two writes above re-stamped instance_id with this process's id (D3 scope).
      const writer = (await stored(h.db, "rep-malformed")).instance_id;
      const rep = await repairProviderHosts(h.db, {
        ownInstanceId: writer,
        ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]),
      });
      assert.deepEqual(rep.changes.map((c) => c.id), ["rep-malformed"]);
      // 4. the reconciler (owned entry; a valid object policy from the file)
      const res = await syncProvidersFromModelsJson(h.db, { ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.126"]) });
      assert.equal(res.failed, 0);
      assert.equal(Number((await stored(h.db, "rep-malformed")).disabled), 0);
    } finally { h.cleanup(); }
  });
}

/** Wrap a libsql client so every providers INSERT fails like a DB would. */
function failingInserts(db) {
  return {
    execute: (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (sql.trimStart().startsWith("INSERT INTO providers")) {
        return Promise.reject(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
      }
      return db.execute(q);
    },
  };
}

test("reconciler: a non-EXTERNAL_ENGINE error (DB failure) is NOT swallowed — it still surfaces", async () => {
  const h = freshLibsql({ "fx-loop": { baseUrl: "http://127.0.0.1:8011/v1", models: [{ id: "m" }] } });
  try {
    await assert.rejects(
      syncProvidersFromModelsJson(failingInserts(h.db), { ownAddrs: new Set(["localhost", "127.0.0.1", "::1"]) }),
      (err) => err.code === "SQLITE_BUSY",
    );
  } finally { h.cleanup(); }
});

test("repairProviderHosts: a non-EXTERNAL_ENGINE error is NOT swallowed", async () => {
  const h = freshLibsql();
  try {
    await seedRaw(h.db, { id: "rep-repair-fail", host: "local", gpuPolicy: null, instanceId: "own-instance" });
    await assert.rejects(
      repairProviderHosts(failingInserts(h.db), {
        ownInstanceId: "own-instance",
        ownAddrs: new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]),
      }),
      (err) => err.code === "SQLITE_BUSY",
    );
  } finally { h.cleanup(); }
});
