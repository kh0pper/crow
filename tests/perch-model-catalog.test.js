// The session-free model list: one source for the launcher's picker (which has
// no session yet) and for options()'s fallback on a session with no live child.
// Two lists that could disagree about what this instance serves is the defect
// class the module exists to prevent, so this pins the SHAPE both consume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerModelList, providerModelListWarm, modelKey, chatCapable } from "../servers/gateway/perch-model-catalog.js";

const cfg = (providers) => ({ load: () => ({ providers }) });

test("every model of every provider row becomes a pi-shaped entry", async () => {
  // pi's own Model object (its rpc docs) is {id, name, provider, baseUrl, …},
  // and that is what the drawer, the launcher and annotateAvailability read.
  const list = providerModelList(cfg({
    "crow-local": { baseUrl: "http://x:8003/v1", models: [{ id: "qwen3.6-35b-a3b", name: "Qwen" }] },
    "zai-coding": { baseUrl: "https://api.z.ai/v4", models: [{ id: "glm-5.1" }, { id: "glm-5" }] },
  }));
  assert.deepEqual(list, [
    { id: "qwen3.6-35b-a3b", name: "Qwen", provider: "crow-local", baseUrl: "http://x:8003/v1" },
    { id: "glm-5.1", provider: "zai-coding", baseUrl: "https://api.z.ai/v4" },
    { id: "glm-5", provider: "zai-coding", baseUrl: "https://api.z.ai/v4" },
  ]);
});

test("baseUrl rides along on every entry — it is what the availability probe addresses", async () => {
  const list = providerModelList(cfg({ p: { baseUrl: "http://probe-me/v1", models: [{ id: "m" }] } }));
  assert.equal(list[0].baseUrl, "http://probe-me/v1");
  // A row with no baseUrl is still listed; annotateAvailability falls through
  // to the warmability question for it rather than dropping the model.
  const noUrl = providerModelList(cfg({ p: { models: [{ id: "m" }] } }));
  assert.equal(noUrl.length, 1);
  assert.equal(noUrl[0].baseUrl, null);
});

test("every field the provider row carries on a model is preserved", async () => {
  const list = providerModelList(cfg({
    p: { baseUrl: "u", models: [{ id: "m", name: "M", reasoning: true, contextWindow: 262144 }] },
  }));
  assert.equal(list[0].reasoning, true);
  assert.equal(list[0].contextWindow, 262144);
});

test("a bare id string is a model too — the shape bot-builder's loader also tolerates", async () => {
  const list = providerModelList(cfg({ p: { baseUrl: "u", models: ["plain-id"] } }));
  assert.deepEqual(list, [{ id: "plain-id", provider: "p", baseUrl: "u" }]);
});

test("models.json schema meta keys are not providers", async () => {
  const list = providerModelList(cfg({
    $schema: { models: [{ id: "nope" }] },
    real: { baseUrl: "u", models: [{ id: "yes" }] },
  }));
  assert.deepEqual(list.map((m) => m.id), ["yes"]);
});

test("junk is skipped, never rendered as an entry with no id", async () => {
  const list = providerModelList(cfg({
    empty: { baseUrl: "u", models: [] },
    nullish: null,
    notArray: { baseUrl: "u", models: "qwen" },
    idless: { baseUrl: "u", models: [{ name: "no id here" }, { id: "" }, null] },
    good: { baseUrl: "u", models: [{ id: "keep" }] },
  }));
  assert.deepEqual(list.map((m) => m.id), ["keep"]);
});

test("no registry at all is an empty list, never a throw", async () => {
  // loadProviders() reads a DB and a file; a caller listing models must not
  // 500 a page because neither is readable.
  assert.deepEqual(providerModelList({ load: () => { throw new Error("no db"); } }), []);
  assert.deepEqual(providerModelList({ load: () => null }), []);
  assert.deepEqual(providerModelList({ load: () => ({}) }), []);
  assert.deepEqual(providerModelList(cfg({})), []);
});

test("modelKey speaks the one key definition.models.default and control() both use", async () => {
  assert.equal(modelKey({ provider: "crow-local", id: "qwen3.6-35b-a3b" }), "crow-local/qwen3.6-35b-a3b");
  assert.equal(modelKey({ provider: "p" }), null);
  assert.equal(modelKey(null), null);
});

test("the default source really is loadProviders — the established session-free path", async () => {
  // A precondition test, not a behaviour one: prove the module resolves its
  // real dependency and returns an array here, so a renamed export cannot wait
  // to bite the first operator who opens the launcher on a live box.
  const list = providerModelList();
  assert.ok(Array.isArray(list), "the DB/models.json-backed default must return a list, whatever this host has");
});

// ---------------------------------------------------------------------------
// Fix round 1 Q7 — an endpoint that answers is not a model you can talk to.
// ---------------------------------------------------------------------------

test("embedding and reranker entries are not offered as session models", async () => {
  // Measured on the live R4 registry: grackle-embed/qwen3-embedding-0.6b and
  // grackle-rerank/qwen3-reranker-0.6b were listed reading "— up", because
  // annotateAvailability answers "did anything answer at this address" and an
  // embedding server does. One tap from being a session's model, and every
  // turn on it would fail.
  const list = providerModelList(cfg({
    "grackle-embed": { baseUrl: "http://g:9100/v1", models: [{ id: "qwen3-embedding-0.6b", task: "embed", dim: 1024 }] },
    "grackle-rerank": { baseUrl: "http://g:9101/v1", models: [{ id: "qwen3-reranker-0.6b", task: "score" }] },
    "crow-local": { baseUrl: "http://c:8003/v1", models: [{ id: "qwen3.6-35b-a3b" }] },
  }));
  assert.deepEqual(list.map(modelKey), ["crow-local/qwen3.6-35b-a3b"]);
});

test("the exclusion is by TASK, and covers both spellings the repo uses", async () => {
  // Provider rows on this instance say task:"embed"/"score"; the model catalog
  // vocabulary (scripts/validate-model-catalog.js:75) says
  // "embedding"/"rerank". Both are non-chat and both are excluded.
  for (const task of ["embed", "embedding", "rerank", "score", "classify", "EMBED"]) {
    assert.equal(chatCapable({ id: "m", task }), false, task + " must not be offered");
  }
});

test("no task at all means chat — most provider rows never tag their models", async () => {
  // A strict allowlist would empty the picker on this instance: not one
  // crow-local/zai-coding/qwen-cloud entry carries a task field.
  assert.equal(chatCapable({ id: "m" }), true);
  assert.equal(chatCapable({ id: "m", task: null }), true);
  assert.equal(chatCapable({ id: "m", task: "chat" }), true);
  // vision, deliberately: models/manager.js's own isChatClassRow counts
  // task:"vision" as chat-class, and a -vl-…-instruct model serves chat
  // completions. Filtering it out would drop a model an operator can use.
  assert.equal(chatCapable({ id: "qwen3-vl-4b-instruct-fp8", task: "vision" }), true);
});

// ---------------------------------------------------------------------------
// Fix round 1 Q6 — the cold-cache window
// ---------------------------------------------------------------------------

test("the warm variant does not try to warm an INJECTED loader", async () => {
  // A test seam has no cache to refresh, and warming one would reach for the
  // real DB from a hermetic test.
  assert.deepEqual(await providerModelListWarm(cfg({})), []);
  assert.deepEqual((await providerModelListWarm(cfg({ p: { baseUrl: "u", models: [{ id: "m" }] } }))).map(modelKey),
    ["p/m"]);
});

// ---------------------------------------------------------------------------
// The picker view — pickerModels / scopeOf / loadPiProviderNames
// (Kevin 2026-10-02: "an outdated list of models … a ton of stale entries",
// and raven-flash-next, his production model, could not be found in it)
// ---------------------------------------------------------------------------

const {
  pickerModels, scopeOf, loadPiProviderNames, referencedModelKeys,
} = await import("../servers/gateway/perch-model-catalog.js");

test("provider rows stamp managed/external only when true — a plain row keeps its old shape", async () => {
  const list = providerModelList(cfg({
    plain: { baseUrl: "u", models: [{ id: "a" }] },
    bundled: { baseUrl: "u2", bundleId: "b", models: [{ id: "b" }] },
    gufo: { baseUrl: "http://10.0.0.126:8030/v1", gpuPolicy: { engine: { managed: "external" } }, models: [{ id: "c" }] },
  }));
  assert.deepEqual(list[0], { id: "a", provider: "plain", baseUrl: "u" });
  assert.equal(list[1].managed, true);
  assert.equal(list[2].managed, true);
  assert.equal(list[2].external, true);
});

test("scopeOf: loopback, LAN, tailnet and bare host names are on your network; the rest is cloud", () => {
  for (const u of ["http://127.0.0.1:18100/v1", "http://localhost:3001/llm/v1", "http://10.0.0.126:8030/v1",
                   "http://192.168.1.5/v1", "http://172.20.0.2/v1", "http://100.64.20.1:8003/v1",
                   "https://crow.example.ts.net:8444/v1", "http://[::1]:8000/v1",
                   "http://[fd7a:115c:a1e0::1]/v1", "http://grackle:9100/v1", "http://nas.local/v1"]) {
    assert.equal(scopeOf(u), "network", u);
  }
  for (const u of ["https://api.z.ai/api/coding/paas/v4", "https://coding-intl.dashscope.aliyuncs.com/v1",
                   "http://8.8.8.8/v1", "http://100.128.0.1/v1", "http://172.32.0.1/v1", null, "", "not a url"]) {
    assert.equal(scopeOf(u), "cloud", String(u));
  }
});

const PI = { custom: new Set(["crow-local", "zai-coding", "raven-flash-next"]), builtin: new Set(["zai", "openai"]),
  keyed: new Set(["openai"]) };
const keys = (l) => l.map((m) => m.provider + "/" + m.id);

test("aliases of one endpoint+model collapse to ONE entry, the rest kept as aliases", () => {
  const out = pickerModels([
    { provider: "crow-chat", id: "q35", baseUrl: "http://100.64.20.1:8003/v1", managed: true, availability: "up" },
    { provider: "crow-local", id: "q35", baseUrl: "http://100.64.20.1:8003/v1", name: "Qwen 35B", availability: "up" },
    { provider: "crow-swap-agentic", id: "q35", baseUrl: "http://100.64.20.1:8003/v1/", managed: true, availability: "up" },
  ], { pi: PI });
  // Fix round 1 I1: aliases fold only within the same runnability, so the one
  // pi can spawn stays its own entry and the two bundle rows fold together.
  assert.deepEqual(keys(out), ["crow-local/q35", "crow-chat/q35"]);
  assert.equal(out[0].runnable, true);
  assert.equal(out[0].aliases, undefined);
  assert.equal(out[1].runnable, false);
  assert.deepEqual(out[1].aliases, ["crow-swap-agentic/q35"]);
});

test("I1: a bot naming an unrunnable alias never swallows the runnable one from another bot's picker", () => {
  const rows = [
    { provider: "crow-chat", id: "qwen3.6-35b-a3b", baseUrl: "http://100.64.20.1:8003/v1", managed: true, availability: "up" },
    { provider: "crow-local", id: "qwen3.6-35b-a3b", baseUrl: "http://100.64.20.1:8003/v1", availability: "up" },
  ];
  // Bot A is set to crow-chat/…; this is bot B's launcher (default elsewhere).
  const forB = pickerModels(rows, { pi: PI, referenced: ["crow-chat/qwen3.6-35b-a3b"], defaultKey: "zai-coding/glm-5" });
  const local = forB.find((m) => m.provider === "crow-local");
  assert.ok(local, "crow-local is still offered");
  assert.equal(local.runnable, true);
  // And bot A's own launcher keeps its (unrunnable) default visible too.
  const forA = pickerModels(rows, { pi: PI, defaultKey: "crow-chat/qwen3.6-35b-a3b" });
  assert.deepEqual(keys(forA), ["crow-chat/qwen3.6-35b-a3b", "crow-local/qwen3.6-35b-a3b"]);
  assert.equal(forA[0].runnable, false);
});

test("the kept entry carries its group's best availability", () => {
  const [m] = pickerModels([
    { provider: "a", id: "m", baseUrl: "http://x/v1", availability: "unavailable", managed: true },
    { provider: "b", id: "m", baseUrl: "http://x/v1", availability: "on_demand" },
  ]);
  assert.equal(m.provider, "a");
  assert.equal(m.availability, "on_demand");
});

test("among equally runnable aliases the referenced row, then the managed row, is canonical", () => {
  const rows = [
    { provider: "a", id: "m", baseUrl: "http://x/v1", availability: "up" },
    { provider: "b", id: "m", baseUrl: "http://x/v1", availability: "up", managed: true },
  ];
  assert.deepEqual(keys(pickerModels(rows)), ["b/m"], "managed wins when nothing references either");
  assert.deepEqual(keys(pickerModels(rows, { referenced: ["a/m"] })), ["a/m"], "a bot's reference wins over managed");
  assert.deepEqual(keys(pickerModels(rows, { defaultKey: "a/m" })), ["a/m"], "the default is never folded away");
});

test("the same model id on DIFFERENT endpoints is two models, not one", () => {
  const out = pickerModels([
    { provider: "crow-voice", id: "qwen3.5-4b", baseUrl: "http://100.64.20.1:8011/v1" },
    { provider: "qwen3.5-4b", id: "qwen3.5-4b", baseUrl: "http://127.0.0.1:18100/v1" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.label).sort(), ["qwen3.5-4b (crow-voice)", "qwen3.5-4b (qwen3.5-4b)"],
    "the provider is named only because the two would otherwise read the same");
});

test("runnable: pi's models.json, then pi's KEYED built-ins (case-insensitive), else not", () => {
  const out = pickerModels([
    { provider: "crow-local", id: "a", baseUrl: "http://x/v1" },
    { provider: "ZAI", id: "b", baseUrl: "https://api.z.ai/v4" },
    { provider: "OpenAI", id: "d", baseUrl: "https://api.openai.com/v1" },
    { provider: "cloud-openai-08a50004", id: "c", baseUrl: "https://dashscope.example/v1" },
  ], { pi: PI });
  const by = Object.fromEntries(out.map((m) => [m.provider, m.runnable]));
  assert.deepEqual(by, { "crow-local": true, ZAI: false, OpenAI: true, "cloud-openai-08a50004": false },
    "fix round 1 I2: zai is a pi built-in, but with no key pi fails every turn — can't run in a bot");
  assert.ok(pickerModels([{ provider: "p", id: "m", baseUrl: "u" }]).every((m) => !("runnable" in m)),
    "no pi answer is UNKNOWN, never false");
  assert.equal(pickerModels([{ provider: "nope", id: "m" }], { pi: PI, runnableAll: true })[0].runnable, true,
    "a live child's own list is runnable by definition");
});

test("order: the default first, then on-network, then cloud; usable before unusable, then by label", () => {
  const out = pickerModels([
    { provider: "zai-coding", id: "glm-5", name: "GLM-5", baseUrl: "https://api.z.ai/v4", availability: "up" },
    { provider: "cloud-x", id: "dead", name: "Aardvark", baseUrl: "https://c.example/v1", availability: "up" },
    { provider: "crow-local-27b", id: "27b", name: "Qwen 27B", baseUrl: "http://100.64.20.1:8006/v1", availability: "unavailable" },
    { provider: "raven-flash-next", id: "fn", name: "Flash Next", baseUrl: "http://10.0.0.126:8030/v1", availability: "up", external: true },
    { provider: "crow-local", id: "q35", name: "Qwen 35B", baseUrl: "http://100.64.20.1:8003/v1", availability: "up" },
  ], { pi: { custom: new Set(["zai-coding", "crow-local-27b", "raven-flash-next", "crow-local"]), builtin: new Set() },
       defaultKey: "zai-coding/glm-5" });
  assert.deepEqual(keys(out), [
    "zai-coding/glm-5",                  // the bot's default, whatever group it is in
    "raven-flash-next/fn", "crow-local/q35",   // network, usable, by label
    "crow-local-27b/27b",                // network, nothing answering
    "cloud-x/dead",                      // cloud, pi cannot spawn it
  ]);
  assert.deepEqual(out.map((m) => m.group), ["cloud", "network", "network", "network", "cloud"]);
});

test("an external engine is on your network even when its address would not say so", () => {
  const [m] = pickerModels([{ provider: "gufo", id: "x", baseUrl: "https://gufo.example.com/v1", external: true }]);
  assert.equal(m.group, "network");
});

test("pickerModels never throws on junk and keeps every keyed entry", () => {
  assert.deepEqual(pickerModels(null), []);
  assert.deepEqual(pickerModels([null, {}, { provider: "p" }]), []);
  assert.equal(pickerModels([{ provider: "p", id: "m" }])[0].label, "m");
});

test("loadPiProviderNames reads pi's models.json (PI_MODELS_JSON wins) and the installed pi's built-ins", async () => {
  const files = {
    "/pi/models.json": JSON.stringify({ providers: { "Qwen Cloud": {}, "crow-local": {}, $schema: {} } }),
  };
  const read = (p) => { if (p in files) return files[p]; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
  const AI = "/g/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai";
  const list = (d) => {
    if (d === AI + "/dist/providers") return ["zai.models.js", "openai.models.js", "index.js"];
    throw new Error("ENOENT");
  };
  const cli = () => ({ cliPath: "/g/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" });
  const imported = [];
  const importer = async (p) => { imported.push(p); return { getEnvApiKey: (prov, env) => (prov === "openai" ? env.OPENAI_API_KEY : undefined) }; };
  const r = await loadPiProviderNames({ env: { PI_MODELS_JSON: "/pi/models.json", HOME: "/h", OPENAI_API_KEY: "k" },
    read, list, cli, importer });
  assert.deepEqual([...r.custom].sort(), ["crow-local", "qwen cloud"]);
  assert.deepEqual([...r.builtin].sort(), ["openai", "zai"]);
  assert.deepEqual([...r.keyed], ["openai"], "the installed pi-ai's own getEnvApiKey decides");
  assert.deepEqual(imported, [AI + "/dist/env-api-keys.js"]);

  // models.json under PI_CODING_AGENT_DIR / HOME; no installed pi → the snapshots.
  files["/h/.pi/agent/models.json"] = JSON.stringify({ providers: { mine: {} } });
  const r2 = await loadPiProviderNames({ env: { HOME: "/h", ZAI_API_KEY: "z" }, read, list, cli: () => null });
  assert.deepEqual([...r2.custom], ["mine"]);
  assert.ok(r2.builtin.has("zai") && r2.builtin.has("anthropic"), "falls back to the pi 0.85.1 snapshot");
  assert.deepEqual([...r2.keyed], ["zai"], "the env-var snapshot: ZAI_API_KEY keys zai");

  // auth.json keys a built-in too.
  files["/a/auth.json"] = JSON.stringify({ groq: { type: "api_key", key: "x" } });
  const r4 = await loadPiProviderNames({ env: { PI_CODING_AGENT_DIR: "/a" }, read, list, cli: () => null });
  assert.deepEqual([...r4.keyed], ["groq"]);

  // No models.json and no keys: built-ins only, none keyed — a known answer.
  const r3 = await loadPiProviderNames({ env: { HOME: "/nowhere" }, read, list, cli: () => null });
  assert.equal(r3.custom.size, 0);
  assert.equal(r3.keyed.size, 0);

  // A models.json that does not parse: UNKNOWN, not "nothing runs".
  files["/bad.json"] = "{ not json";
  assert.equal(await loadPiProviderNames({ env: { PI_MODELS_JSON: "/bad.json" }, read, list, cli: () => null }), null);
});

test("loadPiProviderNames against the real installed pi: zai with no key is not keyed", async () => {
  const r = await loadPiProviderNames({ env: { HOME: "/nonexistent-home", PATH: process.env.PATH } });
  assert.ok(r && r.builtin.has("zai"));
  assert.equal(r.keyed.has("zai"), false);
  assert.equal((await loadPiProviderNames({ env: { HOME: "/nonexistent-home", ZAI_API_KEY: "z" } })).keyed.has("zai"), true);
});

test("referencedModelKeys collects every bot's default and escalation keys", () => {
  const keysOut = referencedModelKeys([
    { definition: JSON.stringify({ models: { default: "crow-local/q", escalation: "zai-coding/glm-5.1" } }) },
    { definition: JSON.stringify({ models: null }) },
    { definition: "{broken" },
    null,
  ]);
  assert.deepEqual([...keysOut].sort(), ["crow-local/q", "zai-coding/glm-5.1"]);
  assert.equal(referencedModelKeys(null).size, 0);
});
