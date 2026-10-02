// tests/pi-models-sync.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManagedEntries, mergeManaged, piModelsSyncPath, syncPiModelsJson, CROW_MANAGED_KEY } from "../servers/shared/pi-models-sync.js";

const DOOR = "http://100.64.9.1:3001/llm/v1";
const rows = [
  { id: "crow-chat", baseUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: null, bundleId: null, disabled: false, provider_type: "openai-compat",
    models: [{ id: "qwen3.6-35b-a3b", contextWindow: 262144 }], gpuPolicy: { runtime: "native", owner: "me", port: 18102 } },
  { id: "qwen3.5-4b", baseUrl: "http://127.0.0.1:18100/v1", apiKey: null, bundleId: null, disabled: false, provider_type: null,
    models: [{ id: "qwen3.5-4b" }], gpuPolicy: { runtime: "native", mutexGroup: "local-llm" } },
  { id: "crow-voice", baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", disabled: false, provider_type: "openai-compat", models: [{ id: "qwen3.5-4b" }], gpuPolicy: null },
  { id: "crow-embed", baseUrl: "http://100.64.9.1:3001/llm/p/crow-embed/v1", apiKey: null, bundleId: null, disabled: false, provider_type: "openai-compat",
    models: [{ id: "qwen3-embedding-0.6b", task: "embedding" }], gpuPolicy: { runtime: "native", owner: "me", port: 18101 } },
  { id: "Qwen Cloud", baseUrl: "https://maas.example.com/v1", apiKey: "sk-live", bundleId: null, disabled: false, provider_type: "openai-compat", models: [{ id: "qwen3.8-max" }], gpuPolicy: null },
  { id: "crow-swap-agentic", baseUrl: "http://localhost:3001/llm/v1", apiKey: "none", bundleId: null, disabled: false, provider_type: "openai-compat", models: [{ id: "crow" }], gpuPolicy: null },
  { id: "anthropic-x", baseUrl: "https://api.anthropic.com", apiKey: "k", bundleId: null, disabled: false, provider_type: "anthropic", models: [{ id: "c" }], gpuPolicy: null },
  { id: "old", baseUrl: "http://100.64.9.1:8009/v1", apiKey: "none", bundleId: "b", disabled: true, provider_type: "openai-compat", models: [{ id: "n" }], gpuPolicy: null },
];

test("buildManagedEntries: managed local rows only; native rows get this gateway's provider door; embeddings dropped", () => {
  const e = buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: [] });
  assert.deepEqual(Object.keys(e).sort(), ["crow-chat", "crow-voice", "qwen3.5-4b"]);
  assert.equal(e["crow-chat"].baseUrl, "http://100.64.9.1:3001/llm/p/crow-chat/v1");
  assert.equal(e["qwen3.5-4b"].baseUrl, "http://100.64.9.1:3001/llm/p/qwen3.5-4b/v1", "a loopback-stored native row still goes through the door");
  assert.equal(e["crow-chat"].apiKey, "none");
  assert.equal(e["crow-chat"].api, "openai-completions");
  assert.deepEqual(e["crow-chat"].models, [{ id: "qwen3.6-35b-a3b", contextWindow: 262144, maxTokens: 16384 }], "I3: maxTokens = min(pi default 16384, contextWindow/2)");
  assert.equal(e["crow-embed"], undefined, "an embedding-only provider is not a chat model for pi");
  assert.equal(e["crow-swap-agentic"], undefined, "an unmanaged alias row is skipped");
  assert.equal(e["Qwen Cloud"], undefined, "cloud rows need the explicit allowlist");
});

test("buildManagedEntries: an allow-listed cloud row is included with its DB key", () => {
  const e = buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: ["Qwen Cloud"] });
  assert.equal(e["Qwen Cloud"].apiKey, "sk-live");
  assert.equal(e["anthropic-x"], undefined, "non-OpenAI types never");
});

test("mergeManaged: adds, updates, removes managed ids; hand-written entries are never touched", () => {
  const file = {
    providers: {
      "crow-local": { baseUrl: "http://100.64.9.1:8003/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }] },
      "crow-voice": { baseUrl: "http://hand-written/v1", apiKey: "none", models: [{ id: "qwen3.5-4b" }] },
      "gone": { baseUrl: "http://x/v1", apiKey: "none", models: [] },
      "Qwen Cloud": { baseUrl: "https://maas.example.com/v1", apiKey: "sk-stale", models: [] },
    },
    [CROW_MANAGED_KEY]: ["gone", "Qwen Cloud"],
  };
  const { json, added, updated, removed } = mergeManaged(file, buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: ["Qwen Cloud"] }));
  assert.deepEqual(added, ["crow-chat", "qwen3.5-4b"]);
  assert.deepEqual(updated, ["Qwen Cloud"]);
  assert.deepEqual(removed, ["gone"]);
  assert.equal(json.providers["crow-local"].baseUrl, "http://100.64.9.1:8003/v1");
  assert.equal(json.providers["crow-voice"].baseUrl, "http://hand-written/v1", "a hand-written id wins over a DB row");
  assert.equal(json.providers["Qwen Cloud"].apiKey, "sk-live");
});

test("mergeManaged is idempotent", () => {
  const entries = buildManagedEntries(rows, { doorBase: DOOR, cloudAllow: [] });
  const once = mergeManaged({ providers: {} }, entries).json;
  const twice = mergeManaged(once, entries);
  assert.deepEqual([twice.added, twice.updated, twice.removed], [[], [], []]);
});

test("piModelsSyncPath: explicit path; primary home only when pi is installed; kill switch", () => {
  const home = "/home/u";
  const yes = { existsFn: () => true, piCliFn: () => ({ cliPath: "/x/cli.js" }) };
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home, ...yes }), "/home/u/.pi/agent/models.json");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home, existsFn: () => false, piCliFn: yes.piCliFn }), null, "no ~/.pi/agent: never create one");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow", home, existsFn: () => true, piCliFn: () => null }), null, "no pi installed");
  assert.equal(piModelsSyncPath({ env: {}, crowHome: "/home/u/.crow-r4", home, ...yes }), null);
  assert.equal(piModelsSyncPath({ env: { CROW_PI_MODELS_SYNC_PATH: "/x/models.json" }, crowHome: "/home/u/.crow-r4", home, ...yes }), "/x/models.json");
  assert.equal(piModelsSyncPath({ env: { CROW_PI_MODELS_SYNC: "0" }, crowHome: "/home/u/.crow", home, ...yes }), null);
});

test("syncPiModelsJson writes 0600, skips a no-op, and retries when the file changed under it", async () => {
  let content = JSON.stringify({ providers: {} });
  const writes = [];
  let reads = 0;
  // The second read (the pre-rename re-check) sees a hand edit that landed meanwhile.
  const readFileFn = () => { reads++; if (reads === 2) content = JSON.stringify({ providers: { "hand": { baseUrl: "http://h/v1", apiKey: "none", models: [{ id: "h" }] } } }); return content; };
  const writeFileAtomicFn = (p, data, mode) => { writes.push({ mode }); content = data; };
  const res = await syncPiModelsJson({}, { path: "/tmp/pi/models.json", doorBase: DOOR, cloudAllow: [], listProvidersAllFn: async () => rows, readFileFn, writeFileAtomicFn });
  assert.deepEqual(res.added.sort(), ["crow-chat", "crow-voice", "qwen3.5-4b"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, 0o600);
  assert.ok(JSON.parse(content).providers.hand, "the concurrent hand edit survived (re-read + retry)");
  const n = writes.length;
  await syncPiModelsJson({}, { path: "/tmp/pi/models.json", doorBase: DOOR, cloudAllow: [], listProvidersAllFn: async () => rows, readFileFn: () => content, writeFileAtomicFn });
  assert.equal(writes.length, n, "no-op run does not rewrite");
});

test("syncPiModelsJson refuses to clobber an unparseable file", async () => {
  await assert.rejects(
    syncPiModelsJson({}, { path: "/tmp/x.json", doorBase: DOOR, listProvidersAllFn: async () => rows, readFileFn: () => "{not json", writeFileAtomicFn: () => { throw new Error("must not write"); } }),
    /not valid JSON/,
  );
});

// --- Final fix wave (I2, I3, minor 2, minor 7) -----------------------------
// pi validates the WHOLE models.json against a TypeBox schema
// (@earendil-works/pi-coding-agent 0.85.1, dist/core/model-config.js
// ModelDefinitionSchema) and on ANY failure loads ZERO custom providers.
import { validatePiModelsJson } from "../servers/shared/pi-models-sync.js";

const base = { id: "bad", baseUrl: "http://100.64.9.1:8011/v1", apiKey: "none", bundleId: "b", disabled: false, provider_type: "openai-compat", gpuPolicy: null };

test("I2: off-schema model fields are coerced or dropped, and the output validates", () => {
  const e = buildManagedEntries([{ ...base, models: [
    { id: "m1", name: "", input: ["text", "audio"], contextWindow: "not-a-number", reasoning: "yes", maxTokens: -5 },
    { id: "m2", name: "  Nice  ", input: ["audio"], contextWindow: "32768", reasoning: "true" },
    { id: "", name: "x" },
  ] }], { doorBase: DOOR });
  const [m1, m2] = e.bad.models;
  assert.equal(e.bad.models.length, 2, "an empty id is dropped");
  assert.deepEqual(m1, { id: "m1", input: ["text"] }, "empty name, unknown input value, non-numeric/negative numbers and a non-boolean dropped");
  assert.equal(m2.name, "Nice");
  assert.equal(m2.input, undefined, "an input list with no valid value is dropped");
  assert.equal(m2.contextWindow, 32768, "a numeric string is coerced");
  assert.equal(m2.reasoning, true);
  assert.deepEqual(validatePiModelsJson({ providers: e }), []);
});

test("I2: validatePiModelsJson catches what pi's schema rejects", () => {
  assert.ok(validatePiModelsJson({ providers: { p: { models: [{ id: "a", name: "" }] } } }).length > 0);
  assert.ok(validatePiModelsJson({ providers: { p: { models: [{ id: "a", input: ["audio"] }] } } }).length > 0);
  assert.ok(validatePiModelsJson({ providers: { p: { models: [{ id: "a", contextWindow: "1" }] } } }).length > 0);
  assert.ok(validatePiModelsJson({ providers: { p: { baseUrl: "" } } }).length > 0);
  assert.ok(validatePiModelsJson({}).length > 0, "providers is required");
  assert.deepEqual(validatePiModelsJson({ $crowManaged: ["p"], providers: { p: { baseUrl: "http://x/v1", apiKey: "none", api: "openai-completions", models: [{ id: "a", contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text", "image"] }] } } }), []);
});

test("I2: an invalid merged file is never written; the old file is kept", async () => {
  const hand = JSON.stringify({ providers: { hand: { baseUrl: "http://h/v1", apiKey: "none", models: [{ id: "h", name: "" }] } } });
  let wrote = false;
  await assert.rejects(
    syncPiModelsJson({}, { path: "/tmp/pi/models.json", doorBase: DOOR, cloudAllow: [], listProvidersAllFn: async () => rows, readFileFn: () => hand, writeFileAtomicFn: () => { wrote = true; } }),
    /fails pi's schema/,
  );
  assert.equal(wrote, false);
});

test("I3: contextLen maps to contextWindow and maxTokens is capped at min(row or pi default 16384, contextWindow/2)", () => {
  const e = buildManagedEntries([
    { ...base, id: "crow-voice", models: [{ id: "qwen3.5-4b", contextLen: 8192 }] },
    { ...base, id: "big", models: [{ id: "b", contextLen: 262144 }] },
    { ...base, id: "own", models: [{ id: "o", contextWindow: 32768, maxTokens: 30000 }] },
    { ...base, id: "small-max", models: [{ id: "s", contextLen: 32768, maxTokens: 2048 }] },
    { ...base, id: "none", models: [{ id: "n" }] },
  ], { doorBase: DOOR });
  assert.equal(e["crow-voice"].models[0].contextWindow, 8192);
  assert.ok(e["crow-voice"].models[0].maxTokens < 8192);
  assert.equal(e["crow-voice"].models[0].maxTokens, 4096);
  assert.equal(e.big.models[0].maxTokens, 16384, "pi's own default stays the ceiling");
  assert.equal(e.own.models[0].maxTokens, 16384);
  assert.equal(e["small-max"].models[0].maxTokens, 2048, "a smaller row value wins");
  assert.equal(e.none.models[0].contextWindow, undefined);
  assert.equal(e.none.models[0].maxTokens, undefined, "no context known: leave pi's defaults alone");
});

test("minor 2: a public-address row needs the cloud allowlist even when it carries door_forward or a bundleId", () => {
  const cloudy = [
    { ...base, id: "cloud-optin", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "sk-paid", bundleId: null, gpuPolicy: { door_forward: true }, models: [{ id: "glm" }] },
    { ...base, id: "cloud-bundle", baseUrl: "https://maas.example.com/v1", apiKey: "sk-paid", bundleId: "x", models: [{ id: "q" }] },
  ];
  assert.deepEqual(Object.keys(buildManagedEntries(cloudy, { doorBase: DOOR, cloudAllow: [] })), []);
  assert.deepEqual(Object.keys(buildManagedEntries(cloudy, { doorBase: DOOR, cloudAllow: ["cloud-bundle"] })), ["cloud-bundle"]);
});

test("minor 3: the M1 boot hook closes its DB client on every run", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "boot", "admin-api.js"), "utf8");
  const at = src.indexOf("syncPiModelsJson(db,");
  assert.ok(at > 0, "the run passes a named client");
  assert.match(src.slice(at, at + 600), /finally \{\s*try \{ db\.close\(\); \}/);
});
