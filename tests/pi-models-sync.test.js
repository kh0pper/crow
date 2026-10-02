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
  assert.deepEqual(e["crow-chat"].models, [{ id: "qwen3.6-35b-a3b", contextWindow: 262144 }]);
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
