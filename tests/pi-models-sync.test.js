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

test("buildManagedEntries: a bundle row on an address that only looks unique-local needs the cloud allowlist", () => {
  const look = [
    { id: "fake-ula", baseUrl: "http://[fc::1]:8011/v1", apiKey: "k", bundleId: "b", disabled: false, provider_type: "openai-compat", models: [{ id: "m" }], gpuPolicy: null },
    { id: "real-ula", baseUrl: "http://[fd7a:115c:a1e0::5]:8011/v1", apiKey: "none", bundleId: "b", disabled: false, provider_type: "openai-compat", models: [{ id: "m" }], gpuPolicy: null },
  ];
  assert.deepEqual(Object.keys(buildManagedEntries(look, { doorBase: DOOR, cloudAllow: [] })), ["real-ula"]);
  assert.deepEqual(Object.keys(buildManagedEntries(look, { doorBase: DOOR, cloudAllow: ["fake-ula"] })).sort(), ["fake-ula", "real-ula"]);
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

// --- Roles phase 2, Task 17: consented cloud rows reach pi through the door ---
// as crow-c-<rowId> entries whose key is a `!cat` of the per-boot door token
// file. Fixture keys never look like real ones.
import { createHmac } from "node:crypto";
import { DOOR_ID_PREFIX, doorEntryId } from "../servers/shared/pi-models-sync.js";
import { PI_BUILTIN_PROVIDER_IDS, piCompatFor } from "../servers/shared/pi-compat.js";
import { normalizeBaseUrl } from "../servers/shared/provider-presets.js";

const SALT = "ab".repeat(32);
const TOKEN = "/tmp/x/llm-cloud-token";
const consentFor = (row, salt = SALT) => ({
  target: normalizeBaseUrl(row.baseUrl),
  keyFp: createHmac("sha256", Buffer.from(salt, "hex")).update(String(row.apiKey).trim()).digest("hex").slice(0, 16),
  at: "2026-10-29T00:00:00.000Z", by: "test",
});
const cloudRow = (id, over = {}) => ({ id, baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret-123", bundleId: null, disabled: false,
  provider_type: "openai-compat", models: [{ id: "c1" }], gpuPolicy: null, ...over });
const consentMap = (list) => Object.fromEntries(list.map((r) => [r.id, consentFor(r)]));
const doorOpts = (consentRows, over = {}) => ({ doorBase: DOOR, cloudAllow: [], cloudDoorPort: 3001, consent: consentMap(consentRows), consentSalt: SALT, tokenPath: TOKEN, ...over });

test("T17: door entry carries the file reference, never the key", () => {
  const a = cloudRow("cloud-a");
  const b = cloudRow("cloud-b", { apiKey: "fixture-b" });
  const e = buildManagedEntries([a, b], doorOpts([a], { cloudAllow: ["cloud-b"] }));
  assert.equal(DOOR_ID_PREFIX, "crow-c-");
  assert.equal(doorEntryId("cloud-a"), "crow-c-cloud-a");
  assert.deepEqual(Object.keys(e).sort(), ["cloud-b", "crow-c-cloud-a"]);
  assert.equal(e["crow-c-cloud-a"].baseUrl, "http://127.0.0.1:3001/llm/c/cloud-a/v1");
  assert.equal(e["crow-c-cloud-a"].apiKey, "!cat '/tmp/x/llm-cloud-token'");
  assert.equal(e["crow-c-cloud-a"].api, "openai-completions");
  assert.deepEqual(e["crow-c-cloud-a"].models, [{ id: "c1" }]);
  const all = JSON.stringify(e);
  assert.equal(all.includes("fixture-secret-123"), false, "the consented row's key is nowhere");
  assert.equal(JSON.stringify(e["cloud-b"]).includes("fixture-b"), true, "the allow-listed row keeps its direct entry (developer opt-in)");
  assert.equal(JSON.stringify(e["crow-c-cloud-a"]).includes("fixture-b"), false);
  assert.equal(e["cloud-a"], undefined, "no direct entry under the row's own id");
});

test("T17: no emitted id is a pi built-in", () => {
  const list = ["openai", "anthropic", "groq"].map((id) => cloudRow(id, id === "anthropic" ? { provider_type: "anthropic", baseUrl: "https://api.anthropic.com" } : {}));
  const e = buildManagedEntries(list, doorOpts(list));
  assert.deepEqual(Object.keys(e).sort(), ["crow-c-anthropic", "crow-c-groq", "crow-c-openai"]);
  for (const k of Object.keys(e)) assert.equal(PI_BUILTIN_PROVIDER_IDS.includes(k), false, k);
  assert.equal(PI_BUILTIN_PROVIDER_IDS.some((id) => id.startsWith(DOOR_ID_PREFIX)), false, "no built-in lives in the door namespace");
  assert.equal(e["crow-c-anthropic"].api, "anthropic-messages");
  assert.equal(e["crow-c-anthropic"].baseUrl, "http://127.0.0.1:3001/llm/c/anthropic", "pi's anthropic client appends /v1/messages itself");
});

test("T17: compat carried from the UPSTREAM url", () => {
  const z = cloudRow("cloud-z", { baseUrl: "https://api.z.ai/api/coding/paas/v4", models: [{ id: "glm-5.1" }] });
  const e = buildManagedEntries([z], doorOpts([z]));
  assert.ok(piCompatFor(z.baseUrl, "glm-5.1"), "the fixture has a pi rule");
  assert.deepEqual(e["crow-c-cloud-z"].models[0].compat, piCompatFor(z.baseUrl, "glm-5.1"));
  assert.equal(e["crow-c-cloud-a"], undefined);
});

test("T17: compat per model (OpenRouter's Anthropic cache control on one model only)", () => {
  const or = cloudRow("cloud-or", { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "anthropic/claude-sonnet-5.5" }, { id: "openai/gpt-6.1-terra" }] });
  const e = buildManagedEntries([or], doorOpts([or]));
  const [claude, gpt] = e["crow-c-cloud-or"].models;
  assert.equal(claude.compat.cacheControlFormat, "anthropic");
  assert.equal(gpt.compat?.cacheControlFormat, undefined);
  assert.deepEqual(gpt.compat, piCompatFor(or.baseUrl, "openai/gpt-6.1-terra"));
});

test("T17: unconsented or moved rows get no entry", () => {
  const peer = cloudRow("cloud-peer");
  const moved = cloudRow("cloud-moved");
  const rekeyed = cloudRow("cloud-rekeyed");
  const consent = { "cloud-moved": consentFor({ ...moved, baseUrl: "https://elsewhere.example.com/v1" }), "cloud-rekeyed": consentFor({ ...rekeyed, apiKey: "fixture-old" }) };
  const e = buildManagedEntries([peer, moved, rekeyed], doorOpts([], { consent }));
  assert.deepEqual(Object.keys(e), []);
  const noSalt = buildManagedEntries([peer], doorOpts([peer], { consentSalt: null }));
  assert.deepEqual(Object.keys(noSalt), [], "no salt to check the key with: no entry");
});

test("T17: disabled, local_only, plain-http and unsupported-type rows get no door entry", () => {
  const list = [
    cloudRow("off", { disabled: true }),
    cloudRow("lo", { gpuPolicy: { local_only: true } }),
    cloudRow("plain", { baseUrl: "http://api.example.com/v1" }),
    cloudRow("gem", { provider_type: "google" }),
    cloudRow("emb", { models: [{ id: "e", task: "embedding" }] }),
  ];
  assert.deepEqual(Object.keys(buildManagedEntries(list, doorOpts(list))), []);
});

test("T17: cloudDoorPort null gives exactly today's output", () => {
  const a = cloudRow("cloud-a");
  const today = buildManagedEntries([...rows, a], { doorBase: DOOR, cloudAllow: ["Qwen Cloud"] });
  const off = buildManagedEntries([...rows, a], { ...doorOpts([a], { cloudAllow: ["Qwen Cloud"] }), cloudDoorPort: null });
  assert.deepEqual(off, today);
});

test("T17: the token path is single-quoted for /bin/sh, an embedded quote escaped as '\\''", () => {
  const a = cloudRow("cloud-a");
  const e = buildManagedEntries([a], doorOpts([a], { tokenPath: "/tmp/it's here/llm-cloud-token" }));
  assert.equal(e["crow-c-cloud-a"].apiKey, "!cat '/tmp/it'\\''s here/llm-cloud-token'");
  const none = buildManagedEntries([a], doorOpts([a], { tokenPath: null }));
  assert.deepEqual(Object.keys(none), [], "no token path: no door entry");
});

test("T17: namespace collision — a row named crow-c-x gets no entry and one log line", () => {
  const x = cloudRow("crow-c-x");
  const lx = { ...base, id: "crow-c-local" };
  const logs = [];
  const e = buildManagedEntries([x, lx], { ...doorOpts([x]), log: (m) => logs.push(m) });
  assert.deepEqual(Object.keys(e), []);
  assert.equal(logs.length, 2, "one line per colliding row");
  assert.match(logs[0], /crow-c-x/);
});

test("T17: the merged file validates, and a hand-written crow-c-* entry wins", () => {
  const a = cloudRow("cloud-a");
  const hand = { baseUrl: "http://hand/v1", apiKey: "none", models: [{ id: "h" }] };
  const { json } = mergeManaged({ providers: { "crow-c-cloud-a": hand } }, buildManagedEntries([a], doorOpts([a])));
  assert.deepEqual(json.providers["crow-c-cloud-a"], hand);
  assert.deepEqual(json[CROW_MANAGED_KEY], []);
  const fresh = mergeManaged({ providers: {} }, buildManagedEntries([...rows, a], doorOpts([a]))).json;
  assert.deepEqual(validatePiModelsJson(fresh), []);
  assert.ok(fresh.providers["crow-c-cloud-a"]);
});

test("T17: syncPiModelsJson leaves hand-written entries byte-identical (scratch file only)", async () => {
  const { mkdtempSync, writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "crow-t17-models-"));
  const path = join(dir, "models.json");
  const original = {
    providers: {
      "zeta-hand": { models: [{ id: "z", name: "Zed" }], apiKey: "!cat /some/where", baseUrl: "https://zeta.example.com/v1", api: "openai-completions" },
      "alpha-hand": { baseUrl: "http://100.64.20.5:8003/v1", apiKey: "none", models: [{ id: "a", contextWindow: 8192, compat: { supportsStore: false } }] },
    },
    defaultProvider: "zeta-hand",
  };
  const text = JSON.stringify(original, null, 2) + "\n";
  wf(path, text);
  const a = cloudRow("cloud-a");
  const r = await syncPiModelsJson({}, { path, ...doorOpts([a]), listProvidersAllFn: async () => [...rows, a] });
  assert.ok(r.added.includes("crow-c-cloud-a"));
  const after = rf(path, "utf8");
  const parsed = JSON.parse(after);
  assert.deepEqual(Object.keys(parsed.providers).slice(0, 2), ["zeta-hand", "alpha-hand"], "hand-written keys keep their order, first");
  for (const id of ["zeta-hand", "alpha-hand"]) {
    const block = JSON.stringify({ [id]: original.providers[id] }, null, 2).split("\n").slice(1, -1).map((l) => "  " + l).join("\n");
    assert.ok(after.includes(block), `${id} is byte-identical in the written text`);
  }
  assert.equal(parsed.defaultProvider, "zeta-hand");
  const stripped = { ...parsed, providers: Object.fromEntries(Object.entries(parsed.providers).filter(([k]) => !parsed[CROW_MANAGED_KEY].includes(k))) };
  delete stripped[CROW_MANAGED_KEY];
  assert.equal(JSON.stringify(stripped, null, 2) + "\n", text, "removing Crow's entries gives back the original bytes");
  assert.equal(after.includes("fixture-secret-123"), false);
});
