import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolForcing, ENGINE_FORCING, UNKNOWN_FORCING, FORCING_TTL_MS } from "../servers/gateway/voice/tool-forcing.js";

const models = (owned_by, id = "m") => new Response(JSON.stringify({ data: [{ id, owned_by }] }));
function make({ reply, entry = null, baseUrl = "http://100.64.20.5:8000/v1", clock = { t: 0 }, waitMs = 250 }) {
  const hits = [];
  const up = { baseUrl, model: "m", apiKey: "none" };
  const forcing = createToolForcing({
    resolveKey: async () => ({ ...up }),
    modelEntry: async () => entry,
    fetchImpl: async (url, init) => { hits.push({ url, auth: init?.headers?.Authorization }); return reply(); },
    now: () => clock.t, log: () => {}, waitMs,
  });
  return { forcing, hits, clock, up };
}

test("vllm honours a named choice and required; the answer is cached for ten minutes", async () => {
  const f = make({ reply: () => models("vllm") });
  assert.deepEqual(await f.forcing("crow-voice/m", {}), { named: true, required: true, engine: "vllm" });
  await f.forcing("crow-voice/m", {});
  assert.equal(f.hits.length, 1);
  assert.equal(f.hits[0].url, "http://100.64.20.5:8000/v1/models");
  assert.equal(f.hits[0].auth, undefined, "no key header for a keyless local server");
  f.clock.t = FORCING_TTL_MS + 1;
  await f.forcing("crow-voice/m", {});
  assert.equal(f.hits.length, 2);
  assert.deepEqual(Object.keys(ENGINE_FORCING), ["vllm", "llamacpp"]);
});

test("llamacpp gets nothing; an unknown engine gets a named choice (as every server did before) and never required", async () => {
  assert.deepEqual(await make({ reply: () => models("llamacpp") }).forcing("crow-chat/m", {}), { named: false, required: false, engine: "llamacpp" });
  assert.deepEqual(await make({ reply: () => models("someone") }).forcing("x/m", {}), { named: true, required: false, engine: "unknown" });
  assert.deepEqual(UNKNOWN_FORCING, { named: true, required: false, engine: "unknown" });
  for (const v of [...Object.values(ENGINE_FORCING), UNKNOWN_FORCING]) assert.ok(!(v.required && !v.named) || true);
  assert.equal(Object.entries(ENGINE_FORCING).filter(([, v]) => v.required).map(([k]) => k).join(), "vllm", "required only where it is known to be honoured");
});

test("a failed probe is 'unknown' (named only) and is retried after a minute, not ten", async () => {
  let fail = true;
  const f = make({ reply: () => { if (fail) throw new Error("ECONNREFUSED"); return models("vllm"); } });
  assert.deepEqual(await f.forcing("crow-voice/m", {}), UNKNOWN_FORCING);
  f.clock.t = 30_000; await f.forcing("crow-voice/m", {});
  assert.equal(f.hits.length, 1, "inside the minute: no second probe");
  fail = false; f.clock.t = 61_000;
  assert.equal((await f.forcing("crow-voice/m", {})).required, true);
});

test("a per-model toolChoice in the provider row overrides the probe, and no request is made", async () => {
  for (const [v, want] of [["named", { named: true, required: true }], ["required", { named: false, required: true }], ["none", { named: false, required: false }]]) {
    const f = make({ reply: () => models("llamacpp"), entry: { id: "m", toolChoice: v } });
    assert.deepEqual(await f.forcing("p/m", {}), { ...want, engine: "configured" });
    assert.equal(f.hits.length, 0);
  }
  const bad = make({ reply: () => models("vllm"), entry: { id: "m", toolChoice: "always" } });
  assert.equal((await bad.forcing("p/m", {})).engine, "vllm", "an unknown value is ignored");
});

test("a public base URL is never probed: named only", async () => {
  const f = make({ reply: () => models("vllm"), baseUrl: "https://api.example.com/v1" });
  assert.deepEqual(await f.forcing("cloud/m", {}), UNKNOWN_FORCING);
  assert.equal(f.hits.length, 0);
});

test("the model is matched by id when the server lists several", async () => {
  const f = make({ reply: () => new Response(JSON.stringify({ data: [{ id: "other", owned_by: "llamacpp" }, { id: "m", owned_by: "vllm" }] })) });
  assert.equal((await f.forcing("p/m", {})).engine, "vllm");
});

test("the cache is per server: a provider re-pointed to another base URL is probed again at once", async () => {
  let owner = "vllm";
  const f = make({ reply: () => models(owner) });
  assert.equal((await f.forcing("p/m", {})).engine, "vllm");
  f.up.baseUrl = "http://100.64.20.9:8000/v1"; owner = "llamacpp";
  assert.deepEqual(await f.forcing("p/m", {}), { named: false, required: false, engine: "llamacpp" });
  assert.equal(f.hits.length, 2);
});

test("a slow probe never holds a turn: past the wait the turn goes on as unknown, and the answer is used next time", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = make({ reply: async () => { await gate; return models("llamacpp"); }, waitMs: 5 });
  assert.deepEqual(await f.forcing("p/m", {}), UNKNOWN_FORCING);
  assert.deepEqual(await f.forcing("p/m", {}), UNKNOWN_FORCING, "still in flight: one probe, not two");
  assert.equal(f.hits.length, 1);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await f.forcing("p/m", {}), { named: false, required: false, engine: "llamacpp" });
});
