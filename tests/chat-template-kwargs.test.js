/**
 * Thinking-suppression chain (C1 Task 1): catalog `chat_template_kwargs` ->
 * scoped `--jinja` on native start -> provider row `chatTemplateKwargs` ->
 * resolve-profile healing fallback -> chat.js's `chatStreamOptionsFor` pure
 * helper -> the openai adapter's `chat_template_kwargs` pass-through
 * (verified separately at ai/adapters/openai.js:142-148).
 *
 * This file drives the REAL mechanisms, not mocks of them:
 *   - the real catalog JSON (registry/model-catalog.json) for the
 *     first_run_default assertion and the resolve-profile healing fallback
 *     (qwen3-4b's real entry, patched by this task, is the fixture);
 *   - `acquireProvider` (the real native-start path in gpu-orchestrator.js,
 *     mirroring tests/gpu-orchestrator-native.test.js's injection style) for
 *     the scoped --jinja assertion;
 *   - a real sqlite DB (scripts/init-db.js schema) + the real
 *     `upsertProvider` writer for the resolve-profile tests, mirroring
 *     tests/providers-sync-wire.test.js / tests/providers-backfill.test.js.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { upsertProvider } from "../servers/shared/providers-db.js";
import { resolveProviderConfig } from "../servers/gateway/ai/resolve-profile.js";
import { acquireProvider, _setNativeHandleForTest } from "../servers/gateway/gpu-orchestrator.js";
import { chatStreamOptionsFor } from "../servers/gateway/routes/chat.js";
import { _resetProviderHealth } from "../servers/gateway/provider-health.js";

// --- catalog: first_run_default carries the suppression default ---------

test("catalog first_run_default carries enable_thinking:false", async () => {
  const catalog = JSON.parse(await readFile(new URL("../registry/model-catalog.json", import.meta.url), "utf8"));
  const def = catalog.models.find((m) => m.first_run_default);
  assert.ok(def, "a first_run_default model must exist");
  assert.deepEqual(def.chat_template_kwargs, { enable_thinking: false });
});

// --- scoped --jinja on the real native-start path ------------------------

/** A native provider row shaped like manager.js's registerModel output,
 * mirroring tests/gpu-orchestrator-native.test.js's `nativeProv`. */
function nativeProv(port, alias, extra = {}) {
  const { gpuPolicy, ...rest } = extra;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: "local",
    bundleId: null,
    models: [{ id: alias, task: "chat" }],
    gpuPolicy: { runtime: "native", ...gpuPolicy },
    ...rest,
  };
}

function fakeHandle() {
  return {
    live: true,
    async stop() { this.live = false; },
    status() { return { live: this.live }; },
  };
}

function baseNativeOpts({ cfg, identityProbeFn, loadCatalogFn, startCalls }) {
  return {
    cfg,
    identityProbeFn,
    acquireHostLockFn: () => () => {},
    startModelFn: (params) => {
      startCalls.push(params);
      return fakeHandle();
    },
    ensureRuntimeFn: async () => "/fake/runtimes/llamacpp/b1/llama-server",
    loadStateFn: () => ({ registry: { "qwen3-4b": { file: "model.gguf" } } }),
    resolveDataDirFn: () => "/fake/crow-home",
    loadCatalogFn,
    getCachedProbeFn: () => ({ platform: "linux", accel: "cpu" }),
    readinessTimeoutMs: 200,
    readinessPollMs: 5,
    readinessInitialDelayMs: 0,
  };
}

test("native start threads --jinja when the catalog entry carries chat_template_kwargs", async () => {
  _resetProviderHealth();
  _setNativeHandleForTest("qwen3-4b", null);
  const cfg = { providers: { "qwen3-4b": nativeProv(9401, "qwen3-4b") } };
  // First call is the pre-start fast-path check (must miss so a start is
  // actually attempted); subsequent calls are the post-start readiness
  // poll (mirrors tests/gpu-orchestrator-native.test.js's pattern).
  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    return probeCalls === 1 ? "down" : "resident";
  };
  const startCalls = [];
  const loadCatalogFn = () => ({
    runtime: { release: "b1", assets: {} },
    models: [{ id: "qwen3-4b", chat_template_kwargs: { enable_thinking: false } }],
  });
  const ok = await acquireProvider("qwen3-4b", baseNativeOpts({ cfg, identityProbeFn, loadCatalogFn, startCalls }));
  assert.equal(ok, true);
  assert.equal(startCalls.length, 1);
  assert.ok(Array.isArray(startCalls[0].extraArgs) && startCalls[0].extraArgs.includes("--jinja"),
    `expected extraArgs to include --jinja, got ${JSON.stringify(startCalls[0].extraArgs)}`);
});

test("native start omits --jinja when the catalog entry has no chat_template_kwargs", async () => {
  _resetProviderHealth();
  _setNativeHandleForTest("qwen3-4b", null);
  const cfg = { providers: { "qwen3-4b": nativeProv(9402, "qwen3-4b") } };
  let probeCalls = 0;
  const identityProbeFn = async () => {
    probeCalls += 1;
    return probeCalls === 1 ? "down" : "resident";
  };
  const startCalls = [];
  const loadCatalogFn = () => ({
    runtime: { release: "b1", assets: {} },
    models: [{ id: "qwen3-4b" }],
  });
  const ok = await acquireProvider("qwen3-4b", baseNativeOpts({ cfg, identityProbeFn, loadCatalogFn, startCalls }));
  assert.equal(ok, true);
  assert.equal(startCalls.length, 1);
  assert.ok(!startCalls[0].extraArgs || startCalls[0].extraArgs.length === 0,
    `expected extraArgs to be absent/empty, got ${JSON.stringify(startCalls[0].extraArgs)}`);
});

// --- resolve-profile: provider-row patterns -------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "crow-chat-template-kwargs-test-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
  cwd: join(import.meta.dirname, ".."),
});
const db = createDbClient(join(tmpDir, "crow.db"));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("resolveProviderConfig returns chatTemplateKwargs from a provider row that carries it", async () => {
  await upsertProvider(db, {
    id: "kwargs-row-a",
    baseUrl: "http://127.0.0.1:9410/v1",
    host: "local",
    bundleId: null,
    description: "test",
    models: [{ id: "qwen3-4b", task: "chat", contextLen: 8192, chatTemplateKwargs: { enable_thinking: false } }],
    disabled: false,
    providerType: null,
  });
  const cfg = await resolveProviderConfig(db, "kwargs-row-a", "qwen3-4b");
  assert.deepEqual(cfg.chatTemplateKwargs, { enable_thinking: false });
});

test("resolveProviderConfig returns undefined chatTemplateKwargs for a row without it and no native gpu_policy", async () => {
  await upsertProvider(db, {
    id: "kwargs-row-b",
    baseUrl: "http://127.0.0.1:9411/v1",
    host: "local",
    bundleId: null,
    description: "test",
    models: [{ id: "some-model", task: "chat", contextLen: 8192 }],
    disabled: false,
    providerType: null,
  });
  const cfg = await resolveProviderConfig(db, "kwargs-row-b", "some-model");
  assert.equal(cfg.chatTemplateKwargs, undefined);
});

test("resolveProviderConfig heals a pre-Task-1 native row (no chatTemplateKwargs) from the catalog", async () => {
  // Pre-Task-1 registration shape: models[] entry has no chatTemplateKwargs
  // field at all, but gpu_policy.runtime is "native" and the provider id IS
  // the catalog model id (qwen3-4b) — exactly crow prod's shape before this
  // change shipped.
  await upsertProvider(db, {
    id: "qwen3-4b",
    baseUrl: "http://127.0.0.1:9412/v1",
    host: "local",
    bundleId: null,
    description: "test",
    models: [{ id: "qwen3-4b" }],
    disabled: false,
    providerType: null,
    gpuPolicy: { runtime: "native", mutexGroup: "local-llm" },
  });
  const cfg = await resolveProviderConfig(db, "qwen3-4b", "qwen3-4b");
  assert.deepEqual(cfg.chatTemplateKwargs, { enable_thinking: false });
});

// --- chatStreamOptionsFor: pure helper -------------------------------------

test("chatStreamOptionsFor threads chatTemplateKwargs when present", () => {
  const sig = new AbortController().signal;
  const opts = chatStreamOptionsFor({ chatTemplateKwargs: { enable_thinking: false } }, sig);
  assert.deepEqual(opts, { signal: sig, chatTemplateKwargs: { enable_thinking: false } });
});

test("chatStreamOptionsFor omits the key for a null cfg", () => {
  const sig = new AbortController().signal;
  const opts = chatStreamOptionsFor(null, sig);
  assert.deepEqual(opts, { signal: sig });
  assert.ok(!("chatTemplateKwargs" in opts));
});

test("chatStreamOptionsFor omits the key for a cfg with no chatTemplateKwargs", () => {
  const sig = new AbortController().signal;
  const opts = chatStreamOptionsFor({}, sig);
  assert.deepEqual(opts, { signal: sig });
  assert.ok(!("chatTemplateKwargs" in opts));
});
