/**
 * add-provider — test a key in plain terms, choose an id, write one row
 * (roles phase 2b, Task 9). Every upstream call is a stub requestFn that
 * records the URL and headers; no real provider is ever called. Fixture keys
 * are made-up strings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { testProviderKey, providerIdFor, modelEntryFor, addProvider } from "../servers/gateway/ai/add-provider.js";
import { gatewayPort } from "../servers/gateway/models/door.js";
import { safeRequest } from "../servers/gateway/models/safe-upstream.js";
import { createServer } from "node:http";

function reply(status, body = {}, headers = {}) {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return { status, headers, stream: Readable.from([buf]) };
}

/** A requestFn stub: `routes` maps a URL (or "*") to a reply factory or an Error. */
function stubRequest(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: { ...(opts?.headers || {}) }, mode: opts?.mode });
    const r = routes[url] ?? routes["*"];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(url, opts);
    return reply(404);
  };
  fn.calls = calls;
  return fn;
}
const errWith = (code) => Object.assign(new Error(code.toLowerCase()), { code });
const modelsBody = (ids) => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

test("codes", async () => {
  const cases = [
    [() => reply(401), "key_rejected"],
    [() => reply(403), "key_rejected"],
    [() => reply(429), "rate_limited"],
    [() => reply(302, "", { location: "https://elsewhere.example.com/" }), "provider_error"],
    [() => reply(500), "provider_error"],
    [errWith("TIMEOUT"), "unreachable"],
    [errWith("ECONNREFUSED"), "unreachable"],
    [errWith("UPSTREAM_ADDRESS_REFUSED"), "forbidden_target"],
  ];
  for (const [r, code] of cases) {
    const requestFn = stubRequest({ "*": r });
    const out = await testProviderKey({ presetId: "openai", apiKey: "fixture-key-a" }, { requestFn });
    assert.equal(out.code, code, code);
    assert.equal(out.ok, false);
    assert.equal(out.host, "api.openai.com");
  }
  const five = await testProviderKey({ presetId: "openai", apiKey: "fixture-key-a" }, { requestFn: stubRequest({ "*": () => reply(503) }) });
  assert.equal(five.status, 503);

  const never = stubRequest({ "*": () => reply(200, modelsBody(["m"])) });
  const refuse = async (input, code) => {
    const out = await testProviderKey(input, { requestFn: never });
    assert.equal(out.code, code, JSON.stringify(input));
    assert.equal(out.ok, false);
  };
  await refuse({ presetId: "other", baseUrl: "ftp://x", apiKey: "fixture-key-a" }, "bad_url");
  await refuse({ presetId: "other", baseUrl: "not a url", apiKey: "fixture-key-a" }, "bad_url");
  await refuse({ presetId: "other", baseUrl: "", apiKey: "fixture-key-a" }, "bad_url");
  await refuse({ presetId: "other", baseUrl: "http://169.254.169.254/v1", apiKey: "fixture-key-a" }, "forbidden_target");
  await refuse({ presetId: "other", baseUrl: `http://127.0.0.1:${gatewayPort()}/llm/v1`, apiKey: "fixture-key-a" }, "forbidden_target");
  await refuse({ presetId: "other", baseUrl: `http://localhost:${gatewayPort()}/v1`, apiKey: "fixture-key-a" }, "forbidden_target");
  await refuse({ presetId: "other", baseUrl: "http://192.168.1.20:3001/llm/p/x/v1", apiKey: "fixture-key-a" }, "forbidden_target");
  await refuse({ presetId: "openai", baseUrl: "http://0.0.0.0:8080/v1", apiKey: "fixture-key-a" }, "forbidden_target");
  await refuse({ presetId: "openai", baseUrl: "http://10.0.0.5:8080/v1", apiKey: "fixture-key-a" }, "forbidden_target");
  await refuse({ presetId: "openai", apiKey: "fixture-key-a\u0007" }, "bad_key");
  await refuse({ presetId: "openai", apiKey: "   " }, "bad_key");
  await refuse({ presetId: "openai", apiKey: "fixture key" }, "bad_key");
  await refuse({ presetId: "zai", variantId: "nope", apiKey: "fixture-key-a" }, "bad_url");
  assert.equal(never.calls.length, 0);

  const trim = stubRequest({ "*": () => reply(200, modelsBody(["gpt-6.1-sol"])) });
  const ok = await testProviderKey({ presetId: "openai", apiKey: " fixture-key-a\n" }, { requestFn: trim });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, "ok");
  assert.equal(trim.calls[0].headers.Authorization, "Bearer fixture-key-a");
  assert.equal(trim.calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(trim.calls[0].mode, "cloud");
  assert.deepEqual(ok.models, ["gpt-6.1-sol"]);
  // test and list share a path: one request, not two.
  assert.equal(trim.calls.length, 1);
});

test("public models list still tests the key (OpenRouter /key first)", async () => {
  const requestFn = stubRequest({
    "https://openrouter.ai/api/v1/key": () => reply(200, { data: { label: "x" } }),
    "https://openrouter.ai/api/v1/models": () => reply(200, modelsBody(["a/b", "c/d"])),
  });
  const out = await testProviderKey({ presetId: "openrouter", apiKey: "or-fixture" }, { requestFn });
  assert.equal(requestFn.calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(requestFn.calls[0].headers.Authorization, "Bearer or-fixture");
  assert.equal(requestFn.calls[1].url, "https://openrouter.ai/api/v1/models");
  assert.equal(out.ok, true);
  assert.deepEqual(out.models, ["a/b", "c/d"]);

  // A rejected key stops before the list.
  const bad = stubRequest({ "https://openrouter.ai/api/v1/key": () => reply(401) });
  const r = await testProviderKey({ presetId: "openrouter", apiKey: "or-fixture" }, { requestFn: bad });
  assert.equal(r.code, "key_rejected");
  assert.equal(bad.calls.length, 1);

  // A list failure after a passing test is still ok, with models: null.
  const listFails = stubRequest({
    "https://openrouter.ai/api/v1/key": () => reply(200, {}),
    "https://openrouter.ai/api/v1/models": () => reply(500),
  });
  const lf = await testProviderKey({ presetId: "openrouter", apiKey: "or-fixture" }, { requestFn: listFails });
  assert.equal(lf.ok, true);
  assert.equal(lf.models, null);
});

test("anthropic headers", async () => {
  const requestFn = stubRequest({ "*": () => reply(200, { data: [{ id: "claude-x", type: "model" }], has_more: false }) });
  const out = await testProviderKey({ presetId: "anthropic", apiKey: "fixture-key-a" }, { requestFn });
  assert.equal(out.ok, true);
  const h = requestFn.calls[0].headers;
  assert.equal(h["x-api-key"], "fixture-key-a");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(Object.keys(h).some((k) => k.toLowerCase() === "authorization"), false);
  assert.match(requestFn.calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
  assert.deepEqual(out.models, ["claude-x"]);
});

test("zai variants pick their base URL", async () => {
  const requestFn = stubRequest({ "*": () => reply(200, modelsBody(["glm-x"])) });
  await testProviderKey({ presetId: "zai", variantId: "coding", apiKey: "fixture-key-a" }, { requestFn });
  assert.equal(requestFn.calls[0].url, "https://api.z.ai/api/coding/paas/v4/models");
});

test("big list capped at 2,000 ids", async () => {
  const ids = Array.from({ length: 3000 }, (_, i) => `m-${i}`);
  const requestFn = stubRequest({ "*": () => reply(200, modelsBody(ids)) });
  const out = await testProviderKey({ presetId: "openai", apiKey: "fixture-key-a" }, { requestFn });
  assert.equal(out.ok, true);
  assert.equal(out.models.length, 2000);
  assert.equal(out.truncated, true);
});

test("a Google-shaped listing gives bare model ids (F2)", async () => {
  const listing = { object: "list", data: [
    { id: "models/gemini-3.8-flash", object: "model" }, { id: "models/gemini-embedding-2", object: "model" },
    { id: "gemini-3.8-flash", object: "model" }, { id: "plain-id", object: "model" },
  ] };
  const requestFn = stubRequest({ "*": () => reply(200, listing) });
  const out = await testProviderKey({ presetId: "google", apiKey: "fixture-key-g" }, { requestFn });
  assert.equal(out.ok, true);
  assert.deepEqual(out.models, ["gemini-3.8-flash", "gemini-embedding-2", "plain-id"]);
});

test("modelEntryFor writes a task for every non-chat kind; a saved realtime model is not a chat pick (F1)", async () => {
  assert.equal(modelEntryFor("openai", "gpt-realtime-2.1-mini").task, "realtime");
  assert.equal(modelEntryFor("google", "gemini-3.8-live").task, "realtime");
  assert.equal(modelEntryFor("openai", "gpt-6.1-sol").task, undefined);
  const { listRolePicks } = await import("../servers/shared/role-picks.js");
  const models = [modelEntryFor("openai", "gpt-realtime-2.1-mini"), modelEntryFor("openai", "gpt-6-luna")];
  const providers = [{ id: "cloud-a", baseUrl: "https://api.openai.com/v1", host: "cloud", disabled: false, models }];
  const ctx = {
    bindings: {}, customDefs: {}, providers, models: { providers: { "cloud-a": { models } } },
    catalog: [], ownInstanceId: () => "i-test",
  };
  for (const roleId of ["voice", "everyday", "quick"]) {
    const keys = listRolePicks(roleId, { ctx, ownAddrs: new Set() }).map((p) => p.key);
    assert.ok(keys.includes("cloud-a/gpt-6-luna"), roleId);
    assert.ok(!keys.includes("cloud-a/gpt-realtime-2.1-mini"), roleId);
  }
});

test("providerIdFor: free id, same account reuses, another account gets -2", () => {
  const rows = [{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-a" }];
  assert.deepEqual(providerIdFor("anthropic", { rows, baseUrl: "https://api.anthropic.com", apiKey: "k" }), { id: "anthropic", reuse: false });
  assert.deepEqual(providerIdFor("openai", { rows, baseUrl: "https://API.openai.com/v1/", apiKey: "fixture-key-a" }), { id: "openai", reuse: true });
  assert.deepEqual(providerIdFor("openai", { rows, baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-b" }), { id: "openai-2", reuse: false });
  const more = [...rows, { id: "openai-2", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-b" }];
  assert.deepEqual(providerIdFor("openai", { rows: more, baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-b" }), { id: "openai-2", reuse: true });
  assert.deepEqual(providerIdFor("openai", { rows: more, baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-c" }), { id: "openai-3", reuse: false });

  const custom = providerIdFor("other", { rows: [], baseUrl: "http://192.168.1.20:11434/v1", apiKey: "k" });
  assert.deepEqual(custom, { id: "custom-192-168-1-20", reuse: false });
  const long = providerIdFor("other", { rows: [], baseUrl: "https://a-very-long-inference-host-name.models.example.com/v1", apiKey: "k" });
  assert.ok(long.id.startsWith("custom-") && long.id.length <= 32, long.id);
  assert.ok(!/-$/.test(long.id));
  const taken = providerIdFor("other", { rows: [{ id: long.id, baseUrl: "https://elsewhere.example.com/v1", apiKey: "k" }], baseUrl: "https://a-very-long-inference-host-name.models.example.com/v1", apiKey: "k" });
  assert.ok(taken.id.endsWith("-2") && taken.id.length <= 32, taken.id);
  for (const r of [custom, long, taken]) assert.ok(!r.id.startsWith("crow-c-"));
});

test("modelEntryFor reads the recommendations", () => {
  assert.deepEqual(modelEntryFor("openai", "text-embedding-3-large"), { id: "text-embedding-3-large", task: "embedding" });
  const vision = modelEntryFor("openai", "gpt-6.1-terra");
  assert.deepEqual(vision.input, ["text", "image"]);
  assert.equal(vision.contextWindow, 1050000);
  assert.equal(modelEntryFor("openai", "gpt-6.1-sol").contextWindow, 1050000);
  assert.equal(modelEntryFor("openai", "gpt-6-astra").input, undefined);
  assert.deepEqual(modelEntryFor("openai", "gpt-6.1-sol").input, ["text", "image"]); // listed as a vision alternative
  assert.deepEqual(modelEntryFor("openai", "not-in-the-file"), { id: "not-in-the-file" });
  assert.deepEqual(modelEntryFor("other", "m7"), { id: "m7" });
});

function harness({ rows = [], test: testResult } = {}) {
  const writes = [];
  let invalidated = 0;
  const added = [];
  return {
    writes, added, get invalidated() { return invalidated; },
    seams: {
      upsertProviderFn: async (db, p) => { writes.push(p); return { id: p.id, lamport_ts: 1 }; },
      invalidateFn: () => { invalidated++; },
      listRowsFn: async () => rows,
      testFn: testResult ? async () => testResult : undefined,
      onAdded: (id) => { added.push(id); },
    },
  };
}
const okTest = (models = ["gpt-6.1-sol", "text-embedding-3-large"], baseUrl = "https://api.openai.com/v1") =>
  ({ ok: true, code: "ok", models, host: new URL(baseUrl).hostname, baseUrl });

test("addProvider writes one shape", async () => {
  const h = harness({ test: okTest() });
  const out = await addProvider({}, { presetId: "openai", apiKey: " fixture-key-a ", modelIds: ["gpt-6.1-sol", "text-embedding-3-large"] }, h.seams);
  assert.equal(out.ok, true);
  assert.equal(out.providerId, "openai");
  assert.equal(out.reuse, false);
  assert.equal(h.writes.length, 1);
  const w = h.writes[0];
  assert.deepEqual(Object.keys(w).sort(), ["apiKey", "baseUrl", "bundleId", "description", "disabled", "host", "id", "models", "providerType"].sort());
  assert.equal(w.baseUrl, "https://api.openai.com/v1");
  assert.equal(w.apiKey, "fixture-key-a");
  assert.equal(w.host, "cloud");
  assert.equal(w.bundleId, null);
  assert.equal(w.description, "OpenAI");
  assert.equal(w.disabled, false);
  assert.equal(w.providerType, "openai");
  assert.deepEqual(w.models, [{ id: "gpt-6.1-sol", input: ["text", "image"], contextWindow: 1050000 }, { id: "text-embedding-3-large", task: "embedding" }]);
  assert.equal(h.invalidated, 1);
  assert.deepEqual(h.added, ["openai"]);
});

test("addProvider refuses a failed test and writes nothing", async () => {
  const h = harness({ test: { ok: false, code: "key_rejected", status: 401, models: null, host: "api.openai.com" } });
  const out = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds: ["gpt-6.1-sol"] }, h.seams);
  assert.deepEqual(out, { ok: false, code: "key_rejected", status: 401 });
  assert.equal(h.writes.length, 0);
  assert.equal(h.invalidated, 0);
  assert.deepEqual(h.added, []);
  // not_found is a pass only for "other" with a typed id.
  const nf = { ok: false, code: "not_found", status: 404, models: null, host: "api.openai.com", baseUrl: "https://api.openai.com/v1" };
  const h2 = harness({ test: nf });
  assert.equal((await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds: ["m7"] }, h2.seams)).code, "not_found");
  const h3 = harness({ test: { ...nf, host: "192.168.1.20", baseUrl: "http://192.168.1.20:8080/v1" } });
  assert.equal((await addProvider({}, { presetId: "other", baseUrl: "http://192.168.1.20:8080/v1", apiKey: "fixture-key-a", modelIds: [] }, h3.seams)).code, "not_found");
  assert.equal(h2.writes.length + h3.writes.length, 0);
});

test("no models endpoint allows a typed id (other, /models 404)", async () => {
  const h = harness();
  const requestFn = stubRequest({ "http://192.168.1.20:8080/v1/models": () => reply(404) });
  const out = await addProvider({}, { presetId: "other", baseUrl: "http://192.168.1.20:8080/v1", apiKey: "fixture-key-a", modelIds: ["m7"] },
    { ...h.seams, testFn: (input) => testProviderKey(input, { requestFn }) });
  assert.equal(out.ok, true);
  assert.equal(requestFn.calls[0].mode, "other");
  assert.deepEqual(h.writes[0].models, [{ id: "m7" }]);
  assert.equal(out.test.code, "not_found");
});

test("second key gets -2; same key updates in place", async () => {
  const rows = [{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-a", models: [{ id: "gpt-6.1-sol" }] }];
  const h = harness({ rows, test: okTest() });
  const b = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-b", modelIds: ["gpt-6.1-sol"] }, h.seams);
  assert.equal(b.providerId, "openai-2");
  assert.equal(b.reuse, false);
  assert.equal(h.writes[0].id, "openai-2");
  const a = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds: ["gpt-6.1-sol"] }, h.seams);
  assert.equal(a.providerId, "openai");
  assert.equal(a.reuse, true);
  assert.equal(h.writes[1].id, "openai");
});

test("reuse keeps a bound model (I9: union of stored and ticked)", async () => {
  const stored = [{ id: "gpt-6.1-sol", contextWindow: 1050000, custom: "kept" }];
  const rows = [{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-a", models: stored }];
  const h = harness({ rows, test: okTest() });
  const out = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds: ["text-embedding-3-large", "gpt-6.1-sol"] }, h.seams);
  assert.equal(out.reuse, true);
  assert.deepEqual(h.writes[0].models, [
    { id: "gpt-6.1-sol", contextWindow: 1050000, custom: "kept" },
    { id: "text-embedding-3-large", task: "embedding" },
  ]);
});

test("other on a LAN address infers host", async () => {
  const base = "http://192.168.1.20:11434/v1";
  const h = harness({ test: okTest(["llama-x"], base) });
  const out = await addProvider({}, { presetId: "other", baseUrl: base, apiKey: "fixture-key-a", modelIds: ["llama-x"] }, h.seams);
  assert.equal(out.ok, true);
  assert.equal(out.providerId, "custom-192-168-1-20");
  assert.equal(h.writes[0].host, undefined);
  assert.equal(h.writes[0].providerType, "openai-compat");
  assert.equal(h.writes[0].baseUrl, base);
});

test("bad model ids are refused", async () => {
  const h = harness({ test: okTest() });
  for (const modelIds of [["bad\nid"], [""], ["x".repeat(300)], "gpt-6.1-sol", [7]]) {
    const out = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds }, h.seams);
    assert.equal(out.ok, false, JSON.stringify(modelIds));
    assert.equal(out.code, "bad_model");
  }
  assert.equal(h.writes.length, 0);
});

test("key never echoed or logged", async () => {
  const KEY = "fixture-secret-123";
  const captured = [];
  const orig = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    orig[m] = console[m];
    console[m] = (...args) => { captured.push(args.map((a) => (a instanceof Error ? a.stack + a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  }
  const results = [];
  try {
    for (const route of [() => reply(200, modelsBody(["gpt-6.1-sol"])), () => reply(401, { error: { message: "bad" } }), errWith("TIMEOUT"), () => reply(302)]) {
      const requestFn = stubRequest({ "*": route });
      const testFn = (input) => testProviderKey(input, { requestFn });
      results.push(await testFn({ presetId: "openai", apiKey: KEY }));
      const h = harness();
      results.push(await addProvider({}, { presetId: "openai", apiKey: KEY, modelIds: ["gpt-6.1-sol"] }, { ...h.seams, testFn }));
    }
    // A failing write is reported by code, and only err.message is logged.
    const h = harness({ test: okTest() });
    results.push(await addProvider({}, { presetId: "openai", apiKey: KEY, modelIds: ["gpt-6.1-sol"] }, {
      ...h.seams, upsertProviderFn: async () => { throw new Error("disk full"); },
    }));
  } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
  }
  assert.equal(results.at(-1).ok, false);
  assert.equal(results.at(-1).code, "save_failed");
  for (const r of results) assert.ok(!JSON.stringify(r).includes(KEY), JSON.stringify(r));
  for (const line of captured) assert.ok(!line.includes(KEY), line);
});

test("other accepts an empty key and sends no Authorization; presets still need one", async () => {
  const base = "http://192.168.1.20:11434/v1";
  for (const apiKey of ["", "  ", undefined]) {
    const requestFn = stubRequest({ "*": () => reply(200, modelsBody(["llama-x"])) });
    const out = await testProviderKey({ presetId: "other", baseUrl: base, apiKey }, { requestFn });
    assert.equal(out.ok, true, JSON.stringify(apiKey));
    assert.deepEqual(requestFn.calls[0].headers, {});
  }
  // A non-empty key on other is still validated, and sent.
  const bad = stubRequest({ "*": () => reply(200, modelsBody(["llama-x"])) });
  assert.equal((await testProviderKey({ presetId: "other", baseUrl: base, apiKey: "fixture key" }, { requestFn: bad })).code, "bad_key");
  assert.equal(bad.calls.length, 0);
  const keyed = stubRequest({ "*": () => reply(200, modelsBody(["llama-x"])) });
  await testProviderKey({ presetId: "other", baseUrl: base, apiKey: " fixture-key-a " }, { requestFn: keyed });
  assert.equal(keyed.calls[0].headers.Authorization, "Bearer fixture-key-a");
  // Presets still refuse an empty key.
  const never = stubRequest({ "*": () => reply(200, modelsBody(["m"])) });
  assert.equal((await testProviderKey({ presetId: "openai", apiKey: "" }, { requestFn: never })).code, "bad_key");
  assert.equal(never.calls.length, 0);

  // The row stores no key, and re-adding the same keyless server reuses it.
  const h = harness();
  const requestFn = stubRequest({ "*": () => reply(200, modelsBody(["llama-x"])) });
  const seams = { ...h.seams, testFn: (input) => testProviderKey(input, { requestFn }) };
  const first = await addProvider({}, { presetId: "other", baseUrl: base, apiKey: "", modelIds: ["llama-x"] }, seams);
  assert.equal(first.ok, true);
  assert.equal(h.writes[0].apiKey, null);
  const rows = [{ id: first.providerId, baseUrl: base, apiKey: null, models: [{ id: "llama-x" }] }];
  const again = await addProvider({}, { presetId: "other", baseUrl: base, apiKey: "", modelIds: ["llama-x"] }, { ...seams, listRowsFn: async () => rows });
  assert.deepEqual([again.providerId, again.reuse], [first.providerId, true]);
});

test("a base URL with a query or fragment is bad_url", async () => {
  const never = stubRequest({ "*": () => reply(200, modelsBody(["m"])) });
  for (const baseUrl of ["http://192.168.1.20:8080/v1?x=1", "http://192.168.1.20:8080/v1#frag", "http://192.168.1.20:8080/v1?", "https://api.openai.com/v1?x=1#f"]) {
    const presetId = baseUrl.includes("openai") ? "openai" : "other";
    const out = await testProviderKey({ presetId, baseUrl, apiKey: "fixture-key-a" }, { requestFn: never });
    assert.equal(out.code, "bad_url", baseUrl);
  }
  assert.equal(never.calls.length, 0);
});

test("a slow-drip key test gives unreachable within the timeout", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const t = setInterval(() => res.write(" "), 300);
    res.on("close", () => clearInterval(t));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const lookupFn = (name, opts, cb) => (opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4));
    const requestFn = (url, opts) => safeRequest(url, { ...opts, lookupFn });
    const started = Date.now();
    const out = await testProviderKey({ presetId: "other", baseUrl: `http://drip.test:${port}/v1`, apiKey: "fixture-key-a" }, { requestFn, timeoutMs: 1000 });
    const took = Date.now() - started;
    assert.equal(out.code, "unreachable");
    assert.equal(out.ok, false);
    assert.ok(took < 1500, `took ${took} ms`);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("two concurrent adds with different keys land under different ids", async () => {
  const rows = [{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-a", models: [] }];
  const seams = {
    listRowsFn: async () => rows.map((r) => ({ ...r })),
    upsertProviderFn: async (db, p) => {
      await new Promise((r) => setTimeout(r, 20)); // a slow write widens the race
      const i = rows.findIndex((r) => r.id === p.id);
      if (i >= 0) rows[i] = { ...p }; else rows.push({ ...p });
      return { id: p.id };
    },
    invalidateFn: () => {},
    testFn: async () => okTest(),
  };
  const [b, c] = await Promise.all([
    addProvider({}, { presetId: "openai", apiKey: "fixture-key-b", modelIds: ["gpt-6.1-sol"] }, seams),
    addProvider({}, { presetId: "openai", apiKey: "fixture-key-c", modelIds: ["gpt-6.1-sol"] }, seams),
  ]);
  assert.deepEqual([b.providerId, c.providerId].sort(), ["openai-2", "openai-3"]);
  assert.deepEqual(rows.map((r) => [r.id, r.apiKey]).sort(), [["openai", "fixture-key-a"], ["openai-2", "fixture-key-b"], ["openai-3", "fixture-key-c"]]);
  // A failed write releases the lock for the next add.
  const failing = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-d", modelIds: [] }, { ...seams, upsertProviderFn: async () => { throw new Error("busy"); } });
  assert.equal(failing.code, "save_failed");
  const next = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-d", modelIds: [] }, seams);
  assert.equal(next.providerId, "openai-4");
});

test("reuse keeps the stored bundleId and description", async () => {
  const rows = [{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key-a", bundleId: "some-bundle", description: "Work account", models: [] }];
  const h = harness({ rows, test: okTest() });
  const out = await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds: ["gpt-6.1-sol"] }, h.seams);
  assert.equal(out.reuse, true);
  assert.equal(h.writes[0].bundleId, "some-bundle");
  assert.equal(h.writes[0].description, "Work account");
  // A stored row without a description gets the preset label.
  const h2 = harness({ rows: [{ ...rows[0], description: null, bundleId: null }], test: okTest() });
  await addProvider({}, { presetId: "openai", apiKey: "fixture-key-a", modelIds: [] }, h2.seams);
  assert.equal(h2.writes[0].description, "OpenAI");
  assert.equal(h2.writes[0].bundleId, null);
});

// --- Task 11: "Use the recommended models for roles you haven't set" ---------

import { mkdtempSync as mkTmp, writeFileSync as writeTmp, rmSync as rmTmp } from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { join as joinPath } from "node:path";
import { createDbClient } from "../servers/db.js";
import { invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { clearProviderTaskCache } from "../servers/shared/provider-task.js";
import { planRecommended, combinedPreview, applyRecommended } from "../servers/gateway/ai/add-provider.js";
import { checkStamp } from "../servers/shared/pick-checks.js";

const PLAN_NOW = new Date("2026-10-28T12:00:00Z");
const PLAN_OWN = new Set();
const PLAN_KEY = "fixture-key-p11";
const recEntry = (id, kind = "chat") => ({ model_id: id, id_verified: true, kind, status: "stable", retires: null });
function planRecFile() {
  const f = joinPath(mkTmp(joinPath(osTmp(), "plan-recs-")), "recs.json");
  writeTmp(f, JSON.stringify({
    schema_version: 1, accessed: "2026-10-01", review_by: "2027-01-28", source_notes: "",
    providers: { openai: { roles: {
      coordinator: [recEntry("gpt-6.1-sol")],
      deep: [recEntry("gpt-6.1-sol")],
      quick: [recEntry("gpt-6-luna")],
      everyday: [recEntry("gpt-6-luna")],
      expert: [recEntry("gpt-6-luna")],
      voice: [recEntry("gpt-6-luna")],
      embed: [recEntry("text-embedding-3-large", "embed")],
    } } },
  }));
  return f;
}
const PLAN_REC = { file: planRecFile() };
const CLOUD_MODELS = [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }, { id: "text-embedding-3-large", task: "embedding" }];
const OK_CHECKS = {
  "cloud-a": {
    "gpt-6-luna|chat": { ok: true, code: "ok", at: "2026-10-28T00:00:00Z" },
    "text-embedding-3-large|embed": { ok: true, code: "ok", at: "2026-10-28T00:00:00Z" },
    "gpt-6.1-sol|chat": { ok: false, code: "no_tool_call", at: "2026-10-28T00:00:00Z" },
  },
};

// Stored checks carry the stamp of the row they ran against (F3).
const PLAN_STAMP = checkStamp({ apiKey: PLAN_KEY, baseUrl: "https://api.openai.com/v1" });
const stampChecks = (checks) => Object.fromEntries(Object.entries(checks).map(([pid, byModel]) => [pid,
  Object.fromEntries(Object.entries(byModel).filter(([, c]) => c).map(([k, c]) => [k, pid === "cloud-a" ? { ...PLAN_STAMP, ...c } : c]))]));

async function planDb({ localEmbed = true, checks = OK_CHECKS, everyday = true, smartChat = false } = {}) {
  const dir = mkTmp(joinPath(osTmp(), "plan-rec-"));
  const db = createDbClient(joinPath(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
    CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, status TEXT, trusted INTEGER DEFAULT 0);
  `);
  const ins = (id, url, models, key = null, host = "local") => db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,0)",
    args: [id, url, key, host, JSON.stringify(models)],
  });
  const raw = (k, v) => db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [k, v] });
  await ins("local-chat", "http://127.0.0.1:8003/v1", [{ id: "m1" }]);
  await ins("local-voice", "http://127.0.0.1:8011/v1", [{ id: "m2" }]);
  if (localEmbed) await ins("local-emb", "http://127.0.0.1:8020/v1", [{ id: "e1", task: "embedding" }]);
  await ins("cloud-a", "https://api.openai.com/v1", CLOUD_MODELS, PLAN_KEY, "cloud");
  await raw("model_role.voice", JSON.stringify({ model: "local-voice/m2", seeded: true }));
  if (everyday) await raw("model_role.everyday", JSON.stringify({ model: "local-chat/m1" }));
  if (checks) await raw("provider_pick_checks", JSON.stringify(stampChecks(checks)));
  if (smartChat) await raw("feature_flags", JSON.stringify({ smart_chat: true }));
  invalidateRoleContext();
  clearProviderTaskCache();
  return { db, raw, close: () => { try { db.close(); } catch {} rmTmp(dir, { recursive: true, force: true }); } };
}
const planOpts = (extra = {}) => ({
  env: {}, ownAddrs: PLAN_OWN, now: PLAN_NOW, recOpts: PLAN_REC,
  localInstanceId: () => "i-self", classifierStatusFn: async () => ({ state: "missing" }), ...extra,
});
const whyOf = (list, roleId) => list.find((x) => x.roleId === roleId)?.why;
const bindingOf = async (db, id) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [`model_role.${id}`] })).rows[0]?.value ?? null;

test("fresh-install defaults are opt-in (I8)", async () => {
  const h = await planDb();
  try {
    const plan = await planRecommended(h.db, "cloud-a", planOpts());
    // embed runs today through the automatic pick: offered, never pre-ticked.
    assert.equal(whyOf(plan.optIn, "embed"), "runs_today");
    assert.equal(plan.optIn.find((x) => x.roleId === "embed").key, "cloud-a/text-embedding-3-large");
    assert.ok(plan.optIn.find((x) => x.roleId === "embed").current, "the model running today is shown");
    assert.equal(whyOf(plan.optIn, "voice"), "seeded");
    assert.ok(plan.optIn.find((x) => x.roleId === "voice").current?.key, "what voice runs today is shown");
    // quick falls back to the chosen everyday today: opt-in, not pre-ticked.
    assert.equal(whyOf(plan.optIn, "quick"), "runs_today");
    assert.equal(whyOf(plan.skipped, "everyday"), "set");
    assert.deepEqual(plan.apply.map((x) => x.roleId), ["expert"]);
    assert.equal(plan.apply[0].key, "cloud-a/gpt-6-luna");
    assert.equal(typeof plan.apply[0].preview.previewHash, "string");
    for (const r of ["critic", "vision", "rerank"]) assert.equal(whyOf(plan.skipped, r), "none_offered", r);
    // A plan never carries the key.
    assert.ok(!JSON.stringify(plan).includes(PLAN_KEY));
  } finally { h.close(); }
});

test("failed or untested picks are never applied", async () => {
  const h = await planDb();
  try {
    const plan = await planRecommended(h.db, "cloud-a", planOpts());
    assert.equal(whyOf(plan.skipped, "coordinator"), "failed_check");
    assert.equal(whyOf(plan.skipped, "deep"), "failed_check");
    assert.ok(!plan.apply.some((x) => x.key === "cloud-a/gpt-6.1-sol"));
    assert.ok(!plan.optIn.some((x) => x.key === "cloud-a/gpt-6.1-sol"));
  } finally { h.close(); }
  const empty = await planDb({ checks: null });
  try {
    const plan = await planRecommended(empty.db, "cloud-a", planOpts());
    assert.deepEqual(plan.apply, []);
    assert.deepEqual(plan.optIn, []);
    for (const r of ["coordinator", "deep", "quick", "everyday", "expert", "voice", "embed"]) {
      assert.equal(whyOf(plan.skipped, r), "not_tested", r);
    }
  } finally { empty.close(); }
});

test("a pick the row does not list is not_listed; an embed pick needs an embed check", async () => {
  const h = await planDb({
    checks: { "cloud-a": { ...OK_CHECKS["cloud-a"], "text-embedding-3-large|embed": undefined, "text-embedding-3-large|chat": { ok: true, code: "ok" } } },
  });
  try {
    await h.db.execute({ sql: "UPDATE providers SET models = ? WHERE id = 'cloud-a'", args: [JSON.stringify([{ id: "gpt-6.1-sol" }, { id: "text-embedding-3-large", task: "embedding" }])] });
    invalidateRoleContext();
    const plan = await planRecommended(h.db, "cloud-a", planOpts());
    assert.equal(whyOf(plan.skipped, "expert"), "not_listed");
    // A chat check of the same id does not count for embed.
    assert.equal(whyOf(plan.skipped, "embed"), "not_tested");
  } finally { h.close(); }
});

test("the same id re-added with a new key, or at a new address, is not tested (F3)", async () => {
  for (const [col, value] of [["api_key", "fixture-key-rotated"], ["base_url", "https://api.openai.com/v1/proxy"]]) {
    const h = await planDb();
    try {
      assert.deepEqual((await planRecommended(h.db, "cloud-a", planOpts())).apply.map((x) => x.roleId), ["expert"]);
      if (col === "api_key") {
        await h.db.execute("DELETE FROM providers WHERE id = 'cloud-a'");
        await h.db.execute({
          sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES ('cloud-a', ?, ?, 'cloud', ?, 0)",
          args: ["https://api.openai.com/v1", value, JSON.stringify(CLOUD_MODELS)],
        });
      } else {
        await h.db.execute({ sql: `UPDATE providers SET ${col} = ? WHERE id = 'cloud-a'`, args: [value] });
      }
      invalidateRoleContext();
      const plan = await planRecommended(h.db, "cloud-a", planOpts());
      assert.deepEqual(plan.apply, [], col);
      assert.deepEqual(plan.optIn, [], col);
      // (An address off the preset is not a preset row at all; the check stamp is covered in pick-probe.)
      if (col === "api_key") for (const r of ["expert", "quick", "embed"]) assert.equal(whyOf(plan.skipped, r), "not_tested", `${col} ${r}`);
    } finally { h.close(); }
  }
});

test("a dead-end chain (not_available): unbound is filled pre-ticked, chosen or seeded is opt-in (L1)", async () => {
  const { buildRoleRows } = await import("../servers/gateway/dashboard/settings/sections/models/rows.js");
  const deadEnd = (over) => async (db, o) => (await buildRoleRows(db, o)).map((r) => (over[r.id] ? { ...r, ...over[r.id], status: { code: "not_available" } } : r));
  const h = await planDb();
  try {
    // expert unbound, coordinator chosen, voice seeded, all dead-ending; quick a fallback today; embed cloud.
    const plan = await planRecommended(h.db, "cloud-a", planOpts({
      buildRowsFn: deadEnd({ expert: { chosen: false, seeded: false }, quick: { chosen: true, seeded: false }, voice: { seeded: true, chosen: false } }),
    }));
    assert.deepEqual(plan.apply.map((x) => x.roleId), ["expert"]);
    assert.equal(typeof plan.apply[0].preview.previewHash, "string");
    assert.equal(whyOf(plan.optIn, "quick"), "not_available");
    assert.equal(whyOf(plan.optIn, "voice"), "not_available");
    assert.equal(whyOf(plan.optIn, "embed"), "runs_today");
    assert.equal(whyOf(plan.skipped, "everyday"), "set");
    // An unbound cloud embed that dead-ends is still never pre-ticked.
    const emb = await planRecommended(h.db, "cloud-a", planOpts({ buildRowsFn: deadEnd({ embed: { chosen: false, seeded: false } }) }));
    assert.equal(whyOf(emb.optIn, "embed"), "cloud");
    assert.ok(!emb.apply.some((x) => x.roleId === "embed"));
  } finally { h.close(); }
});

test("a retryable check is not tested, never failed_check (L2)", async () => {
  const h = await planDb({ checks: { "cloud-a": { ...OK_CHECKS["cloud-a"],
    "gpt-6-luna|chat": { ok: false, code: "http_429", at: "2026-10-28T00:00:00Z" },
    "text-embedding-3-large|embed": { ok: false, code: "unreachable", at: "2026-10-28T00:00:00Z" } } } });
  try {
    const plan = await planRecommended(h.db, "cloud-a", planOpts());
    for (const r of ["expert", "quick", "voice", "embed"]) assert.equal(whyOf(plan.skipped, r), "not_tested", r);
    // A definite failure is still a failure.
    assert.equal(whyOf(plan.skipped, "coordinator"), "failed_check");
  } finally { h.close(); }
});

test("a provider with no preset offers nothing", async () => {
  const h = await planDb();
  try {
    const plan = await planRecommended(h.db, "local-chat", planOpts());
    assert.deepEqual(plan.apply, []);
    assert.deepEqual(plan.optIn, []);
    assert.ok(plan.skipped.every((s) => s.why === "none_offered"));
    assert.deepEqual(await planRecommended(h.db, "no-such-row", planOpts()), { apply: [], optIn: [], skipped: [] });
  } finally { h.close(); }
});

test("cloud embed is never pre-ticked", async () => {
  const h = await planDb({ localEmbed: false });
  try {
    const plan = await planRecommended(h.db, "cloud-a", planOpts());
    assert.ok(plan.optIn.some((x) => x.roleId === "embed"));
    assert.ok(!plan.apply.some((x) => x.roleId === "embed"));
  } finally { h.close(); }
  // Even when nothing runs embeddings today (rows say not_set), a cloud pick stays opt-in.
  const h2 = await planDb({ localEmbed: false });
  try {
    const { buildRoleRows } = await import("../servers/gateway/dashboard/settings/sections/models/rows.js");
    const buildRowsFn = async (db, o) => (await buildRoleRows(db, o)).map((r) => (r.id === "embed" ? { ...r, status: { code: "not_set" }, model: null } : r));
    const plan = await planRecommended(h2.db, "cloud-a", planOpts({ buildRowsFn }));
    const e = plan.optIn.find((x) => x.roleId === "embed");
    assert.ok(e, "embed is opt-in");
    assert.equal(e.why, "cloud");
    assert.ok(!plan.apply.some((x) => x.roleId === "embed"));
  } finally { h2.close(); }
});

test("one warning: the combined preview lists a shared consumer once", async () => {
  const h = await planDb({ everyday: false, smartChat: true });
  try {
    const plan = await planRecommended(h.db, "cloud-a", planOpts());
    assert.deepEqual(plan.apply.map((x) => x.roleId).sort(), ["everyday", "expert", "quick"]);
    // The router's fast tier follows quick, which falls back to everyday: two previews list it.
    const per = plan.apply.reduce((n, x) => n + x.preview.consumers.jobs.filter((c) => c.id === "smart-router:fast").length, 0);
    assert.ok(per >= 2, `listed by ${per} item previews`);
    const c = await combinedPreview(h.db, plan.apply, planOpts());
    assert.equal(c.needs.ackCloud, true);
    assert.equal(c.consumers.jobs.filter((x) => x.id === "smart-router:fast").length, 1);
    assert.equal(c.cloud.host, "api.openai.com");
    assert.match(c.previewHash, /^[0-9a-f]{64}$/);
    // The hash changes when any one item's preview changes (a new bot now follows expert).
    await h.db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
      args: ["b-new", "B", JSON.stringify({ models: { default: "role:expert" }, gateways: [] })],
    });
    invalidateRoleContext();
    const c2 = await combinedPreview(h.db, plan.apply, planOpts());
    assert.notEqual(c2.previewHash, c.previewHash);
  } finally { h.close(); }
});

test("apply needs acks and a fresh hash", async () => {
  const h = await planDb({ everyday: false, smartChat: true });
  try {
    const opts = planOpts();
    const plan = await planRecommended(h.db, "cloud-a", opts);
    const roles = [...plan.apply.map((x) => x.roleId), "voice"];
    const items = roles.map((r) => [...plan.apply, ...plan.optIn].find((x) => x.roleId === r));
    const { previewHash } = await combinedPreview(h.db, items, opts);
    const before = await Promise.all(roles.map((r) => bindingOf(h.db, r)));

    const noAck = await applyRecommended(h.db, "cloud-a", { ...opts, roles, previewHash, actor: "test" });
    assert.deepEqual(noAck.applied, []);
    assert.deepEqual(noAck.refused.map((x) => x.roleId).sort(), [...roles].sort());
    assert.ok(noAck.refused.every((x) => x.reason === "needs_ack_unattended" || x.reason === "needs_ack_cloud"));
    const cloudOnly = await applyRecommended(h.db, "cloud-a", { ...opts, roles, previewHash, actor: "test", ackUnattended: true });
    assert.ok(cloudOnly.refused.every((x) => x.reason === "needs_ack_cloud"));
    const stale = await applyRecommended(h.db, "cloud-a", { ...opts, roles, previewHash: "0".repeat(64), actor: "test", ackUnattended: true, ackCloud: true });
    assert.ok(stale.refused.length === roles.length && stale.refused.every((x) => x.reason === "preview_changed"));
    const bogus = await applyRecommended(h.db, "cloud-a", { ...opts, roles: [...roles, "coordinator"], previewHash, actor: "test", ackUnattended: true, ackCloud: true });
    assert.deepEqual(bogus.applied, []);
    // A role the fresh plan no longer offers refuses everything as preview_changed, with the fresh plan (F9).
    assert.equal(bogus.refused.length, roles.length + 1);
    assert.ok(bogus.refused.every((x) => x.reason === "preview_changed"));
    assert.ok(Array.isArray(bogus.plan?.apply) && Array.isArray(bogus.plan?.optIn) && Array.isArray(bogus.plan?.skipped));
    assert.ok(!bogus.plan.apply.concat(bogus.plan.optIn).some((x) => x.roleId === "coordinator"));
    assert.ok(!JSON.stringify(bogus).includes(PLAN_KEY));
    assert.deepEqual(await Promise.all(roles.map((r) => bindingOf(h.db, r))), before, "nothing written");

    const ok = await applyRecommended(h.db, "cloud-a", { ...opts, roles, previewHash, actor: "test", ackUnattended: true, ackCloud: true });
    assert.deepEqual(ok.refused, []);
    assert.deepEqual(ok.applied.map((x) => x.roleId).sort(), [...roles].sort());
    for (const r of roles) {
      const b = JSON.parse(await bindingOf(h.db, r));
      assert.equal(b.model, "cloud-a/gpt-6-luna", r);
      assert.notEqual(b.seeded, true, r);
      assert.equal(b.by, "test");
    }
    // Visible core chat roles still empty: vision has no pick here; rerank and media never count.
    assert.ok(ok.stillEmpty.includes("vision"));
    for (const r of [...roles, "rerank", "image", "video", "stt", "tts"]) assert.ok(!ok.stillEmpty.includes(r), r);
  } finally { h.close(); }
});

test("a write failing midway is reported as partial, never as success", async () => {
  const h = await planDb({ everyday: false });
  try {
    const opts = planOpts();
    const plan = await planRecommended(h.db, "cloud-a", opts);
    const { previewHash } = await combinedPreview(h.db, plan.apply, opts);
    const roles = plan.apply.map((x) => x.roleId);
    const { applyRoleChange } = await import("../servers/shared/role-change.js");
    let n = 0;
    const applyRoleChangeFn = async (...a) => (++n === 2 ? { ok: false, reason: "follows_primary" } : applyRoleChange(...a));
    const r = await applyRecommended(h.db, "cloud-a", { ...opts, roles, previewHash, actor: "test", ackUnattended: true, ackCloud: true, applyRoleChangeFn });
    assert.equal(r.applied.length, roles.length - 1);
    assert.deepEqual(r.refused, [{ roleId: roles[1], reason: "follows_primary" }]);
    const thrown = await applyRecommended(h.db, "cloud-a", {
      ...opts, roles: [roles[1]], previewHash: (await combinedPreview(h.db, [plan.apply[1]], opts)).previewHash,
      actor: "test", ackUnattended: true, ackCloud: true, applyRoleChangeFn: async () => { throw new Error("disk"); },
    });
    assert.deepEqual(thrown.applied, []);
    assert.deepEqual(thrown.refused, [{ roleId: roles[1], reason: "save_failed" }]);
    assert.equal(await bindingOf(h.db, roles[1]), null);
    // A throw after the write landed (a listener, a cache clear) still reports it applied.
    const late = await applyRecommended(h.db, "cloud-a", {
      ...opts, roles: [roles[1]], previewHash: (await combinedPreview(h.db, [plan.apply[1]], opts)).previewHash,
      actor: "test", ackUnattended: true, ackCloud: true,
      applyRoleChangeFn: async (...a) => { await applyRoleChange(...a); throw new Error("listener"); },
    });
    assert.deepEqual(late.refused, []);
    assert.deepEqual(late.applied.map((x) => x.roleId), [roles[1]]);
    assert.equal(JSON.parse(await bindingOf(h.db, roles[1])).model, "cloud-a/gpt-6-luna");
  } finally { h.close(); }
});

test("a state change after the preview refuses every role and writes nothing", async () => {
  for (const staleCtx of [false, true]) {
    const h = await planDb({ everyday: false, smartChat: true });
    try {
      const opts = planOpts();
      const { loadRoleContext } = await import("../servers/shared/model-roles-store.js");
      const ctxBefore = await loadRoleContext(h.db, { maxAgeMs: 0, getOrCreateLocalInstanceId: () => "i-self" });
      const plan = await planRecommended(h.db, "cloud-a", opts);
      const roles = plan.apply.map((x) => x.roleId);
      assert.ok(roles.includes("expert"));
      const { previewHash } = await combinedPreview(h.db, plan.apply, opts);
      if (staleCtx) {
        // A binding change only a fresh context sees: coordinator now falls back to expert.
        await h.raw("model_role.coordinator", JSON.stringify({ model: "local-chat/m1", fallback: ["expert"] }));
      } else {
        await h.db.execute({
          sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
          args: ["b-late", "B", JSON.stringify({ models: { default: "role:expert" }, gateways: [] })],
        });
      }
      invalidateRoleContext();
      assert.notEqual((await combinedPreview(h.db, plan.apply, opts)).previewHash, previewHash, `the change moves the hash, staleCtx=${staleCtx}`);
      const r = await applyRecommended(h.db, "cloud-a", {
        ...opts, ...(staleCtx ? { ctx: ctxBefore } : {}), roles, previewHash, actor: "test", ackUnattended: true, ackCloud: true,
      });
      assert.deepEqual(r.applied, [], `staleCtx=${staleCtx}`);
      assert.equal(r.refused.length, roles.length);
      assert.ok(r.refused.every((x) => x.reason === "preview_changed"), `staleCtx=${staleCtx}`);
      for (const role of roles) assert.equal(await bindingOf(h.db, role), null, `${role} staleCtx=${staleCtx}`);
    } finally { h.close(); }
  }
});

test("a role with no row is skipped as unknown, not set", async () => {
  const h = await planDb();
  try {
    const { buildRoleRows } = await import("../servers/gateway/dashboard/settings/sections/models/rows.js");
    const buildRowsFn = async (db, o) => (await buildRoleRows(db, o)).filter((r) => r.id !== "expert");
    const plan = await planRecommended(h.db, "cloud-a", planOpts({ buildRowsFn }));
    assert.equal(whyOf(plan.skipped, "expert"), "unknown");
    assert.ok(!plan.apply.some((x) => x.roleId === "expert"));
  } finally { h.close(); }
});

test("stillEmpty lists only built-in visible core chat roles", async () => {
  const h = await planDb();
  try {
    const { buildRoleRows } = await import("../servers/gateway/dashboard/settings/sections/models/rows.js");
    const buildRowsFn = async (db, o) => [
      ...(await buildRoleRows(db, o)),
      { id: "c-notes", kind: "chat", hidden: false, status: { code: "not_set" }, chosen: false, seeded: false, group: "custom" },
    ];
    const r = await applyRecommended(h.db, "cloud-a", { ...planOpts({ buildRowsFn }), roles: [] });
    assert.ok(r.stillEmpty.includes("vision"));
    assert.ok(!r.stillEmpty.includes("c-notes"), "custom roles never count");
    for (const x of ["stt", "tts", "rerank", "image", "video"]) assert.ok(!r.stillEmpty.includes(x), x);
  } finally { h.close(); }
});

// --- Alibaba Model Studio: a POST key test, no listing (ninth preset) ----------------

const MS_INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

/** A requestFn stub that keeps each request's method and parsed body. */
function stubPost(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: { ...(opts?.headers || {}) }, mode: opts?.mode, timeoutMs: opts?.timeoutMs,
      body: typeof opts?.body === "string" ? JSON.parse(opts.body) : opts?.body });
    const r = routes[url] ?? routes["*"];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(url, opts);
    return reply(404);
  };
  fn.calls = calls;
  return fn;
}

test("modelstudio: the key test is one POST to chat/completions in cloud mode; a 2xx is ok with no models", async () => {
  const requestFn = stubPost({ "*": () => reply(200, { choices: [{ message: { content: "o" } }] }) });
  const out = await testProviderKey({ presetId: "modelstudio", apiKey: " fixture-ms-key-1 " }, { requestFn });
  assert.equal(out.ok, true);
  assert.equal(out.code, "ok");
  assert.equal(out.models, null, "no listing");
  assert.equal(out.baseUrl, MS_INTL);
  assert.equal(out.host, "dashscope-intl.aliyuncs.com");
  assert.equal(requestFn.calls.length, 1, "no second listing request");
  const c = requestFn.calls[0];
  assert.equal(c.url, `${MS_INTL}/chat/completions`);
  assert.equal(c.method, "POST");
  assert.equal(c.mode, "cloud");
  assert.equal(c.headers.Authorization, "Bearer fixture-ms-key-1");
  assert.equal(c.headers["content-type"], "application/json");
  // Thinking off: qwen3.8-flash thinks by default, which a one-token key test must not wait on.
  assert.deepEqual(c.body, { model: "qwen3.8-flash", messages: [{ role: "user", content: "ok" }], max_tokens: 1, enable_thinking: false });
  assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 8000);
});

test("modelstudio: the region variant picks its base URL; an unknown region is bad_url", async () => {
  const want = {
    us: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    cn: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    hk: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
    intl: MS_INTL,
  };
  for (const [variantId, base] of Object.entries(want)) {
    const requestFn = stubPost({ "*": () => reply(200, {}) });
    const out = await testProviderKey({ presetId: "modelstudio", variantId, apiKey: "fixture-ms-key-1" }, { requestFn });
    assert.equal(out.ok, true, variantId);
    assert.equal(requestFn.calls[0].url, `${base}/chat/completions`, variantId);
  }
  const never = stubPost({ "*": () => reply(200, {}) });
  assert.equal((await testProviderKey({ presetId: "modelstudio", variantId: "payg", apiKey: "fixture-ms-key-1" }, { requestFn: never })).code, "bad_url");
  assert.equal((await testProviderKey({ presetId: "modelstudio", apiKey: "  " }, { requestFn: never })).code, "bad_key");
  assert.equal(never.calls.length, 0);
});

test("modelstudio: the POST test keeps the same codes", async () => {
  const cases = [
    [() => reply(401, { error: { code: "invalid_api_key" } }), "key_rejected"],
    [() => reply(403), "key_rejected"],
    [() => reply(429), "rate_limited"],
    [() => reply(404), "not_found"],
    [() => reply(400, { error: { code: "InvalidParameter" } }), "provider_error"],
    [() => reply(500), "provider_error"],
    [errWith("TIMEOUT"), "unreachable"],
    [errWith("ECONNREFUSED"), "unreachable"],
    [errWith("UPSTREAM_ADDRESS_REFUSED"), "forbidden_target"],
  ];
  for (const [r, code] of cases) {
    const requestFn = stubPost({ "*": r });
    const out = await testProviderKey({ presetId: "modelstudio", apiKey: "fixture-ms-key-1" }, { requestFn });
    assert.equal(out.code, code, code);
    assert.equal(out.ok, false);
    assert.equal(out.models, null);
    assert.equal(requestFn.calls.length, 1);
  }
});

test("modelstudio: an answer that never finishes is unreachable within the one deadline", async () => {
  const stalled = () => ({ status: 200, headers: {}, stream: new Readable({ read() {} }) });
  const requestFn = stubPost({ "*": stalled });
  const started = Date.now();
  const out = await testProviderKey({ presetId: "modelstudio", apiKey: "fixture-ms-key-1" }, { requestFn, timeoutMs: 300 });
  assert.equal(out.code, "unreachable");
  assert.ok(Date.now() - started < 1500);
  assert.ok(requestFn.calls[0].timeoutMs <= 300);
});

test("modelstudio: addProvider saves recommended and typed ids with no listing; a bad typed id is bad_model", async () => {
  const msTest = { ok: true, code: "ok", status: 200, models: null, host: "dashscope-intl.aliyuncs.com", baseUrl: MS_INTL };
  const h = harness({ test: msTest });
  const out = await addProvider({}, { presetId: "modelstudio", apiKey: "fixture-ms-key-1", modelIds: ["qwen3.8-flash", "text-embedding-v4", "qwen-typed-by-hand"] }, h.seams);
  assert.equal(out.ok, true);
  assert.equal(out.providerId, "modelstudio");
  const w = h.writes[0];
  assert.equal(w.baseUrl, MS_INTL);
  assert.equal(w.host, "cloud");
  assert.equal(w.providerType, "openai");
  assert.equal(w.description, "Alibaba Model Studio (Singapore)");
  assert.deepEqual(w.models, [
    { id: "qwen3.8-flash", input: ["text", "image"], contextWindow: 1000000 },
    { id: "text-embedding-v4", task: "embedding", contextWindow: 8192 },
    { id: "qwen-typed-by-hand" },
  ]);
  const bad = harness({ test: msTest });
  for (const modelIds of [["bad\nid"], ["x".repeat(300)]]) {
    assert.equal((await addProvider({}, { presetId: "modelstudio", apiKey: "fixture-ms-key-1", modelIds }, bad.seams)).code, "bad_model");
  }
  assert.equal(bad.writes.length, 0);
  // A failed test still refuses: not_found is a pass only for "other".
  const nf = harness({ test: { ok: false, code: "not_found", status: 404, models: null, host: "dashscope-intl.aliyuncs.com" } });
  assert.equal((await addProvider({}, { presetId: "modelstudio", apiKey: "fixture-ms-key-1", modelIds: ["qwen3.8-flash"] }, nf.seams)).code, "not_found");
});
