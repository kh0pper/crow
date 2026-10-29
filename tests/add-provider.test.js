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
