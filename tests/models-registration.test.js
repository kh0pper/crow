/**
 * Tests for the provider registration + delete flow half of
 * servers/gateway/models/manager.js (Item G, Task 7).
 *
 * Harness: freshLibsql() — the same pattern as tests/providers-upsert-noop.test.js
 * and tests/providers-reconcile-gate.test.js: `scripts/init-db.js` run against a
 * per-test tmp dir (real providers/dashboard_settings/pi_bot_defs schema, never
 * the real ~/.crow), CROW_DATA_DIR pointed at that dir so
 * getOrCreateLocalInstanceId() (called deep inside upsertProvider) writes its
 * instance-id file there too.
 *
 * The SAME tmp dir doubles as the `dir` argument to registerModel/unregisterModel
 * (state.json + the model blobs directory) — matching production, where both the
 * DB and models/state.json live under one CROW_HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerModel,
  unregisterModel,
  providerBindings,
  pickChatMutexGroup,
  sanitizeFilename,
  ProviderIdConflictError,
} from "../servers/gateway/models/manager.js";
import { loadState, saveState } from "../servers/gateway/models/state.js";
import { upsertProvider, setProviderSyncManager } from "../servers/shared/providers-db.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "models-registration-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
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

async function dbRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

function makeCatalog() {
  return {
    version: 1,
    runtime: { name: "llama.cpp", release: "b10068", assets: {} },
    models: [
      {
        id: "chat-test-model",
        family: "TestFamily",
        lab: "TestLab",
        hf_repo: "test/chat-test-model-GGUF",
        license: "apache-2.0",
        gated: false,
        task: "chat",
        context_len: 8192,
        min_runtime_version: "b10068",
        default_quant: "Q4_K_M",
        tags: ["chat"],
        notes: "test fixture",
        quants: [
          { file: "chat-test-model-Q4_K_M.gguf", quant: "Q4_K_M", size_mb: 1, min_ram_mb: 1, min_vram_mb: 0, sha256: "abc" },
        ],
      },
      {
        id: "embed-test-model",
        family: "TestEmbedFamily",
        lab: "TestLab",
        hf_repo: "test/embed-test-model-GGUF",
        license: "apache-2.0",
        gated: false,
        task: "embed",
        context_len: 512,
        min_runtime_version: "b10068",
        default_quant: "Q4_K_M",
        tags: ["embed"],
        notes: "test fixture",
        quants: [
          { file: "embed-test-model-Q4_K_M.gguf", quant: "Q4_K_M", size_mb: 1, min_ram_mb: 1, min_vram_mb: 0, sha256: "def" },
        ],
      },
    ],
  };
}

/** Insert a fake existing provider row directly (bypassing registerModel) to
 * build mutexGroup-rule fixtures. `models` entries carry `task` the same way
 * registerModel writes them. */
function seedExistingProvider(db, { id, mutexGroup, task, disabled = false }) {
  return upsertProvider(db, {
    id,
    baseUrl: `http://127.0.0.1:19999/v1`,
    apiKey: null,
    host: "local",
    bundleId: null,
    description: "fixture",
    models: [{ id: `${id}-model`, task, contextLen: 4096 }],
    disabled,
    providerType: "openai-compat",
    gpuPolicy: mutexGroup ? { runtime: "native", mutexGroup } : { runtime: "native" },
  });
}

function blobPathFor(dir, file) {
  return join(dir, "models", "blobs", sanitizeFilename(file));
}

// ---------------------------------------------------------------------------
// registerModel — row shape + ordering
// ---------------------------------------------------------------------------

test("registerModel: writes a provider row with the FINAL base_url, models[], and native gpu_policy", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const result = await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });

    assert.equal(result.id, "chat-test-model");
    assert.match(result.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(result.baseUrl, `http://127.0.0.1:${result.port}/v1`);

    const row = await dbRow(db, "chat-test-model");
    assert.ok(row, "provider row exists");
    assert.equal(row.base_url, result.baseUrl, "row's base_url is already the FINAL url, not a placeholder");
    assert.equal(row.disabled, 0);

    const models = JSON.parse(row.models);
    assert.deepEqual(models, [{ id: "chat-test-model", task: "chat", contextLen: 8192 }]);

    const gpuPolicy = JSON.parse(row.gpu_policy);
    assert.equal(gpuPolicy.runtime, "native");
    assert.equal(gpuPolicy.mutexGroup, "local-llm", "sole chat model with no existing groups falls back to local-llm");
  } finally { cleanup(); }
});

test("registerModel: allocates a port already recorded in state.json reservations before returning", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const result = await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });
    const state = loadState(dir);
    assert.ok(state.reservations["chat-test-model"], "port reservation persisted");
    assert.equal(state.reservations["chat-test-model"].port, result.port);
    assert.ok(state.registry["chat-test-model"], "registry entry persisted for later unregister");
    assert.equal(state.registry["chat-test-model"].file, "chat-test-model-Q4_K_M.gguf");
    assert.equal(state.registry["chat-test-model"].quant, "Q4_K_M");
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// registerModel + loadProviders() — no invisible-registration window
// (Item G, PR G-F, defect 2: the DEFAULT invalidateCacheFn used to be the
// plain sync invalidateProvidersCache(), which only clears the cache — the
// very next loadProviders() call fires an un-awaited background DB refresh
// and returns the stale/models.json-fallback snapshot in the meantime.
// A start-route lookup immediately after a fresh native registration saw
// the models.json fallback, found no such provider, and 409'd NOT_NATIVE
// for a model that was already durably registered.)
// ---------------------------------------------------------------------------

test("registerModel: the registered provider is visible to the very next loadProviders() call — no stale-cache window, no sleep/poll", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const { loadProviders, invalidateProvidersCache } = await import("../servers/shared/providers.js");
    // Start from a deterministic cold cache regardless of what earlier
    // tests in this process left behind.
    invalidateProvidersCache();

    await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });

    // Deliberately NO await/sleep/poll here — the very next synchronous
    // loadProviders() call (the same one the start route's
    // maybeAcquireLocalProvider makes) must already see the fresh row.
    const cfg = loadProviders();
    const p = cfg.providers["chat-test-model"];
    assert.ok(p, "the just-registered provider is visible on the very next loadProviders() call");
    assert.equal(p.gpuPolicy?.runtime, "native");
  } finally { cleanup(); }
});

test("registerModel: invalidates the providers cache exactly once, AFTER the row is durably written", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const order = [];
    let sawRowAtInvalidateTime = null;
    await registerModel({
      modelId: "chat-test-model",
      catalog: makeCatalog(),
      db,
      dir,
      upsertProviderFn: async (...args) => {
        order.push("upsert");
        const { upsertProvider } = await import("../servers/shared/providers-db.js");
        return upsertProvider(...args);
      },
      invalidateCacheFn: async () => {
        order.push("invalidate");
        sawRowAtInvalidateTime = await dbRow(db, "chat-test-model");
      },
    });
    assert.deepEqual(order, ["upsert", "invalidate"], "cache invalidation happens after the DB write, not before");
    assert.ok(sawRowAtInvalidateTime, "the row was already visible to a DB read at invalidate-time");
  } finally { cleanup(); }
});

test("registerModel: allocates the port BEFORE inserting the provider row", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const order = [];
    const { allocatePort } = await import("../servers/gateway/models/state.js");
    await registerModel({
      modelId: "chat-test-model",
      catalog: makeCatalog(),
      db,
      dir,
      allocatePortFn: async (...args) => {
        order.push("allocatePort");
        return allocatePort(...args);
      },
      upsertProviderFn: async (...args) => {
        order.push("upsertRow");
        const { upsertProvider } = await import("../servers/shared/providers-db.js");
        return upsertProvider(...args);
      },
    });
    assert.deepEqual(order, ["allocatePort", "upsertRow"]);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// registerModel — mutexGroup rule
// ---------------------------------------------------------------------------

test("registerModel: chat-class model joins the existing group with the MOST chat-class members", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    // group "vram-a": 1 chat-class member
    await seedExistingProvider(db, { id: "existing-a", mutexGroup: "vram-a", task: "chat" });
    // group "vram-b": 2 chat-class members
    await seedExistingProvider(db, { id: "existing-b1", mutexGroup: "vram-b", task: "chat" });
    await seedExistingProvider(db, { id: "existing-b2", mutexGroup: "vram-b", task: "chat" });
    // a disabled row in vram-b's would-be-bigger group must NOT count
    await seedExistingProvider(db, { id: "existing-b3-disabled", mutexGroup: "vram-b", task: "chat", disabled: true });
    // a non-chat (embed) row in a third group must NOT count as chat-class
    await seedExistingProvider(db, { id: "existing-c", mutexGroup: "vram-c", task: "embed" });

    const result = await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });
    const gpuPolicy = JSON.parse((await dbRow(db, "chat-test-model")).gpu_policy);
    assert.equal(gpuPolicy.mutexGroup, "vram-b");
    assert.equal(result.gpuPolicy.mutexGroup, "vram-b");
  } finally { cleanup(); }
});

test("registerModel: chat-class model falls back to local-llm when no group has any chat-class member", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    // A group exists, but its only member is embed-class -> doesn't count.
    await seedExistingProvider(db, { id: "existing-embed", mutexGroup: "vram-a", task: "embed" });

    await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });
    const gpuPolicy = JSON.parse((await dbRow(db, "chat-test-model")).gpu_policy);
    assert.equal(gpuPolicy.mutexGroup, "local-llm");
  } finally { cleanup(); }
});

test("registerModel: embed-class model gets NO mutexGroup key at all", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    // Even with an existing chat group present, embed models never join it.
    await seedExistingProvider(db, { id: "existing-a", mutexGroup: "vram-a", task: "chat" });

    const result = await registerModel({ modelId: "embed-test-model", catalog: makeCatalog(), db, dir });
    const row = await dbRow(db, "embed-test-model");
    const gpuPolicy = JSON.parse(row.gpu_policy);
    assert.equal(gpuPolicy.runtime, "native");
    assert.ok(!("mutexGroup" in gpuPolicy), "embed-class rows carry no mutexGroup property");
    assert.ok(!("mutexGroup" in result.gpuPolicy));
  } finally { cleanup(); }
});

test("pickChatMutexGroup: pure function, exhaustive over the rule (unit-level, no DB)", () => {
  assert.equal(pickChatMutexGroup([]), "local-llm");
  assert.equal(
    pickChatMutexGroup([{ disabled: false, gpuPolicy: { mutexGroup: "g1" }, models: [{ task: "chat" }] }]),
    "g1",
  );
  assert.equal(
    pickChatMutexGroup([
      { disabled: false, gpuPolicy: { mutexGroup: "g1" }, models: [{ task: "chat" }] },
      { disabled: false, gpuPolicy: { mutexGroup: "g2" }, models: [{ task: "chat" }] },
      { disabled: false, gpuPolicy: { mutexGroup: "g2" }, models: [{ task: "chat" }] },
    ]),
    "g2",
    "the group with more chat-class members wins",
  );
  assert.equal(
    pickChatMutexGroup([{ disabled: false, gpuPolicy: { mutexGroup: "g1" }, models: [{ task: "embed" }] }]),
    "local-llm",
    "a group whose only member is embed-class doesn't count",
  );
  assert.equal(
    pickChatMutexGroup([{ disabled: true, gpuPolicy: { mutexGroup: "g1" }, models: [{ task: "chat" }] }]),
    "local-llm",
    "disabled rows don't count",
  );
  assert.equal(
    pickChatMutexGroup([{ disabled: false, gpuPolicy: {}, models: [{ task: "chat" }] }]),
    "local-llm",
    "a row with no mutexGroup at all doesn't count",
  );
});

// ---------------------------------------------------------------------------
// registerModel — provider-id collision guard (fix round 1)
// ---------------------------------------------------------------------------

test("registerModel: refuses to clobber a foreign existing provider row at the same id", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    // A user's own unrelated cloud provider happens to share the catalog's
    // model id (coincidence, e.g. hand-configured before the catalog
    // existed). NOT native-tagged, NOT ours.
    const foreign = {
      id: "chat-test-model",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-real-secret-do-not-touch",
      host: "cloud",
      bundleId: null,
      description: "my own cloud provider",
      models: [{ id: "gpt-lookalike", name: "Some Cloud Model" }],
      disabled: false,
      providerType: "openai-compat",
      gpuPolicy: null,
    };
    await upsertProvider(db, foreign);
    const before = await dbRow(db, "chat-test-model");

    await assert.rejects(
      () => registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir }),
      (err) => {
        assert.ok(err instanceof ProviderIdConflictError);
        assert.equal(err.code, "PROVIDER_ID_CONFLICT");
        assert.equal(err.modelId, "chat-test-model");
        return true;
      },
    );

    const after = await dbRow(db, "chat-test-model");
    assert.equal(after.base_url, before.base_url);
    assert.equal(after.api_key, before.api_key);
    assert.equal(after.host, before.host);
    assert.equal(after.models, before.models);
    assert.equal(after.gpu_policy, before.gpu_policy);
    assert.equal(after.lamport_ts, before.lamport_ts, "no write at all happened -- not even a no-op upsert bump");

    const state = loadState(dir);
    assert.equal(state.reservations["chat-test-model"], undefined, "no port reservation leaked by the rejected call");
    assert.equal(state.registry["chat-test-model"], undefined, "no registry entry leaked by the rejected call");
  } finally { cleanup(); }
});

test("registerModel: a native row for a DIFFERENT catalog model at a colliding id is also refused", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    // Native-tagged, but for a different model's id -- still not "ours" for
    // THIS registration.
    await upsertProvider(db, {
      id: "chat-test-model",
      baseUrl: "http://127.0.0.1:18150/v1",
      apiKey: null,
      host: "local",
      bundleId: null,
      description: "native, but a different model",
      models: [{ id: "some-other-catalog-id", task: "chat", contextLen: 4096 }],
      disabled: false,
      providerType: "openai-compat",
      gpuPolicy: { runtime: "native" },
    });

    await assert.rejects(
      () => registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir }),
      ProviderIdConflictError,
    );

    const state = loadState(dir);
    assert.equal(state.reservations["chat-test-model"], undefined);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// unregisterModel — order + effects
// ---------------------------------------------------------------------------

async function registerAndDownload(db, dir, modelId = "chat-test-model") {
  const result = await registerModel({ modelId, catalog: makeCatalog(), db, dir });
  const dest = blobPathFor(dir, "chat-test-model-Q4_K_M.gguf");
  mkdirSync(join(dir, "models", "blobs"), { recursive: true });
  writeFileSync(dest, "fake gguf bytes");
  return { result, dest };
}

test("unregisterModel: order is stop -> releasePort -> deleteFile -> deleteRow -> invalidateCache", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    await registerAndDownload(db, dir);
    const order = [];
    const { releasePort } = await import("../servers/gateway/models/state.js");
    const { disableProvider } = await import("../servers/shared/providers-db.js");

    await unregisterModel({
      modelId: "chat-test-model",
      db,
      dir,
      runtimeHandle: { live: true, stop: async () => { order.push("stop"); } },
      releasePortFn: (...args) => { order.push("releasePort"); return releasePort(...args); },
      unlinkFn: (...args) => {
        order.push("deleteFile");
        return unlinkSync(...args);
      },
      disableProviderFn: (...args) => { order.push("deleteRow"); return disableProvider(...args); },
      invalidateCacheFn: () => { order.push("invalidateCache"); },
    });

    assert.deepEqual(order, ["stop", "releasePort", "deleteFile", "deleteRow", "invalidateCache"]);
  } finally { cleanup(); }
});

test("unregisterModel: skips stop() when no runtimeHandle is given (or it isn't live)", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    await registerAndDownload(db, dir);
    const order = [];
    await unregisterModel({
      modelId: "chat-test-model",
      db,
      dir,
      releasePortFn: (state, id) => { order.push("releasePort"); state.reservations && delete state.reservations[id]; },
      unlinkFn: () => { order.push("deleteFile"); },
      disableProviderFn: async () => { order.push("deleteRow"); return { ok: true }; },
      invalidateCacheFn: () => { order.push("invalidateCache"); },
    });
    assert.deepEqual(order, ["releasePort", "deleteFile", "deleteRow", "invalidateCache"]);

    const order2 = [];
    await registerAndDownload(db, dir, "chat-test-model");
    await unregisterModel({
      modelId: "chat-test-model",
      db,
      dir,
      runtimeHandle: { live: false, stop: async () => { order2.push("stop"); } },
      releasePortFn: (state, id) => { order2.push("releasePort"); state.reservations && delete state.reservations[id]; },
      unlinkFn: () => { order2.push("deleteFile"); },
      disableProviderFn: async () => { order2.push("deleteRow"); return { ok: true }; },
      invalidateCacheFn: () => { order2.push("invalidateCache"); },
    });
    assert.deepEqual(order2, ["releasePort", "deleteFile", "deleteRow", "invalidateCache"], "live:false never calls stop()");
  } finally { cleanup(); }
});

test("unregisterModel: real effects — releases the port, deletes the blob, soft-deletes the row", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const { dest } = await registerAndDownload(db, dir);
    assert.ok(existsSync(dest), "fixture: blob exists before unregister");

    const outcome = await unregisterModel({ modelId: "chat-test-model", db, dir });
    assert.equal(outcome.deleted, true);
    assert.equal(outcome.disabled, true);

    assert.ok(!existsSync(dest), "blob deleted from disk");

    const state = loadState(dir);
    assert.equal(state.reservations["chat-test-model"], undefined, "port reservation released");
    assert.equal(state.registry["chat-test-model"], undefined, "registry entry cleared");

    const row = await dbRow(db, "chat-test-model");
    assert.equal(Number(row.disabled), 1, "provider row soft-deleted (disabled=1), not hard-deleted");
  } finally { cleanup(); }
});

test("unregisterModel: missing blob (already deleted) is not an error", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const { result } = await (async () => ({ result: await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir }) }))();
    void result;
    // No file ever written to disk for this model.
    const outcome = await unregisterModel({ modelId: "chat-test-model", db, dir });
    assert.equal(outcome.deleted, false);
    assert.equal(outcome.disabled, true);
  } finally { cleanup(); }
});

test("register -> unregister -> re-register cycle: port freed and re-used, disabled flips back to 0, no stale base_url", async () => {
  const { db, dir, cleanup } = freshLibsql();
  try {
    const first = await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });
    const firstPort = first.port;

    const rowAfterFirst = await dbRow(db, "chat-test-model");
    assert.equal(Number(rowAfterFirst.disabled), 0);

    await unregisterModel({ modelId: "chat-test-model", db, dir });
    const rowAfterUnregister = await dbRow(db, "chat-test-model");
    assert.equal(Number(rowAfterUnregister.disabled), 1, "soft-deleted, not hard-deleted");
    const stateAfterUnregister = loadState(dir);
    assert.equal(stateAfterUnregister.reservations["chat-test-model"], undefined, "port freed");

    // Re-register must NOT be treated as a foreign-id collision: the
    // surviving (disabled) row is still native-tagged for this exact
    // catalog model, so ownership holds even though state.registry was
    // cleared by unregister.
    const second = await registerModel({ modelId: "chat-test-model", catalog: makeCatalog(), db, dir });

    assert.equal(second.port, firstPort, "the freed port is the lowest free port again, so it's re-used");
    assert.equal(second.baseUrl, `http://127.0.0.1:${firstPort}/v1`, "no stale base_url from the torn-down registration");

    const rowAfterSecond = await dbRow(db, "chat-test-model");
    assert.equal(Number(rowAfterSecond.disabled), 0, "disabled flips back to 0");
    assert.equal(rowAfterSecond.base_url, second.baseUrl);

    const stateAfterSecond = loadState(dir);
    assert.equal(stateAfterSecond.reservations["chat-test-model"].port, firstPort);
    assert.ok(stateAfterSecond.registry["chat-test-model"], "registry entry rewritten on re-register");
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// providerBindings
// ---------------------------------------------------------------------------

async function seedAiProfiles(db, profiles) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value) VALUES ('ai_profiles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [JSON.stringify(profiles)],
  });
}

async function seedBot(db, { botId, definition }) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?, ?, ?)",
    args: [botId, botId, JSON.stringify(definition)],
  });
}

test("providerBindings: finds a pointer-mode ai_profiles entry bound to the provider id", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await seedAiProfiles(db, [
      { id: "p1", kind: "chat", name: "Bound Profile", provider_id: "chat-test-model", model_id: "chat-test-model" },
      { id: "p2", kind: "chat", name: "Other Profile", provider_id: "some-other-provider", model_id: "x" },
      { id: "p3", kind: "auto", name: "Auto Profile" },
    ]);
    const { profiles, bots } = await providerBindings(db, "chat-test-model");
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].id, "p1");
    assert.deepEqual(bots, []);
  } finally { cleanup(); }
});

test("providerBindings: finds a bot bound via models.default / models.escalation / fast_voice_model", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await seedBot(db, {
      botId: "bot-default",
      definition: { models: { default: "chat-test-model/chat-test-model" } },
    });
    await seedBot(db, {
      botId: "bot-escalation",
      definition: { models: { default: "other-provider/x", escalation: "chat-test-model/chat-test-model" } },
    });
    await seedBot(db, {
      botId: "bot-fast-voice",
      definition: { models: { default: "other-provider/x" }, fast_voice_model: "chat-test-model/chat-test-model" },
    });
    await seedBot(db, {
      botId: "bot-unbound",
      definition: { models: { default: "other-provider/x" } },
    });

    const { profiles, bots } = await providerBindings(db, "chat-test-model");
    assert.deepEqual(profiles, []);
    const ids = bots.map((b) => b.bot_id).sort();
    assert.deepEqual(ids, ["bot-default", "bot-escalation", "bot-fast-voice"]);
  } finally { cleanup(); }
});

test("providerBindings: a provider id prefix must not false-match a different provider (e.g. 'chat-test' vs 'chat-test-model')", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await seedBot(db, { botId: "bot-a", definition: { models: { default: "chat-test/some-model" } } });
    const { bots } = await providerBindings(db, "chat-test-model");
    assert.deepEqual(bots, [], "prefix match requires the '/' boundary, not a bare string prefix");
  } finally { cleanup(); }
});

test("providerBindings: empty case — a provider with no profile or bot bindings returns both empty", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    await seedAiProfiles(db, [{ id: "p1", kind: "chat", name: "Unrelated", provider_id: "unrelated-provider" }]);
    await seedBot(db, { botId: "bot-a", definition: { models: { default: "unrelated-provider/x" } } });

    const { profiles, bots } = await providerBindings(db, "chat-test-model");
    assert.deepEqual(profiles, []);
    assert.deepEqual(bots, []);
  } finally { cleanup(); }
});

test("providerBindings: no ai_profiles row / no pi_bot_defs rows at all -> both empty, no throw", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const { profiles, bots } = await providerBindings(db, "chat-test-model");
    assert.deepEqual(profiles, []);
    assert.deepEqual(bots, []);
  } finally { cleanup(); }
});
