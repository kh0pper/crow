/**
 * research-eval live mode, CI side (scripts/research-eval/{sampling-proxy,live}.mjs): the sampling
 * proxy against the loopback stub model, the preflight (/models and the seed/top_k/min_p probe),
 * the eval bot def, the seam checks, the retry policy, and the runner driven by the stub pi.
 *
 * The stub pi never calls a model, so a runner row here is honestly contaminated with "no model
 * request passed the sampling proxy" — the full live path needs real pi (tests/research-eval-live-real.test.js,
 * which skips without one) and is run locally before merge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStubModel } from "../scripts/lib/stub-model-server.mjs";
import { checkBotDef, checkToolGrant, checkToolSurface, DriverRefusal, LIFECYCLE_DEFAULTS } from "../scripts/lib/live-pi-driver.mjs";
import { realish, realUserCrowDir, within } from "../scripts/lib/protected-paths.mjs";
import { loadCases, CASES_DIR, caseSetIdentity } from "../scripts/research-eval/cases.mjs";
import {
  abortOnSeamFailure, armModelEntry, checkArmEndpoint, completionTokensOf, evalBotDef, EVAL_BOT_ID, LIVE_USAGE, LiveAbort,
  liveMcpOverrides, liveRunIdentity, existingRunKey, NO_JUDGE_YET, PreflightRefused, preflightModels, PROBE_PROMPT, PROBE_SEEDS,
  proveSampling, readStartMarker, retryableFailure, runLive, runLiveRows, stableStringify, TRANSPORT_FAILURE,
} from "../scripts/research-eval/live.mjs";
import { startSamplingProxy } from "../scripts/research-eval/sampling-proxy.mjs";
import { makeTemplate } from "../scripts/research-eval/scratch.mjs";
import { SAMPLING, seedFor } from "../scripts/research-eval/score.mjs";
import { FIXTURE_START_MARKER } from "../scripts/lib/eval-guard.mjs";
import { doneKeys } from "../scripts/research-eval/run.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN = join(REPO, "scripts", "research-eval", "run.mjs");
const STUB_PI = join(REPO, "tests", "fixtures", "live-pi-driver", "stub-pi.mjs");
const MODEL = "stub-m1";
const RR12 = loadCases().find((c) => c.id === "rr12");
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rr-live-")); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const post = (url, body, init = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
const parseSse = (text) => text.split("\n\n").filter(Boolean).map((b) => (b.slice(6) === "[DONE]" ? "[DONE]" : JSON.parse(b.slice(6))));

/**
 * A loopback server that models one aspect of a real sampler, for the probe tests. Everything is
 * honoured by default; each knob reproduces one way a probe can pass falsely:
 *   constant      identical text for every request (a greedy / fully field-ignoring server)
 *   seed: false   ignores the request's seed and varies per call (a fixed SERVER seed)
 *   topK: false   ignores top_k        minP: false  ignores min_p
 *   thinking      the text is in reasoning_content and content is empty (a thinking model)
 *   empty         content and reasoning_content are both empty
 */
async function samplerServer(t, { constant = false, seed = true, topK = true, minP = true, thinking = false, empty = false } = {}) {
  let n = 0;
  const bodies = [];
  const server = createServer((req, res) => {
    // It doubles as a whole arm (preflightModels reads /v1/models).
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, status: "loaded" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      bodies.push(b);
      n += 1;
      const greedy = (topK && b.top_k === 1) || (minP && b.min_p === 1);
      const text = empty ? "" : constant ? "ready" : greedy ? "greedy" : seed ? `seed:${b.seed}` : `n:${n}`;
      const message = thinking ? { role: "assistant", content: "", reasoning_content: text } : { role: "assistant", content: text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bodies };
}

/** A /models server with one fixed body (the preflight probe needs no model). */
async function modelsServer(t, body, status = 200) {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls: () => calls };
}

// ---- the sampling proxy (plan Task 4) ---------------------------------------------------------

test("the proxy pins temperature 0.7, top_p 0.95, top_k 20, min_p 0 and seed 1000+rep on every chat request", async (t) => {
  const stub = await startStubModel({ script: [{ text: "one" }, { text: "two" }] });
  t.after(() => stub.close());
  const proxy = await startSamplingProxy({ upstream: stub.baseUrl, model: MODEL, rep: 2 });
  t.after(() => proxy.close());
  // pi-ai sends only temperature: everything else is the proxy's.
  await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, temperature: 0.2, messages: [] });
  await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, messages: [], top_p: 0.5, top_k: 5, min_p: 0.1, seed: 7 });
  for (const b of stub.requests) {
    assert.deepEqual({ temperature: b.temperature, top_p: b.top_p, top_k: b.top_k, min_p: b.min_p, seed: b.seed }, { ...SAMPLING, seed: seedFor(2) });
    assert.equal(b.model, MODEL);
  }
  assert.deepEqual(proxy.requests.map((r) => r.overrode_keys), [["temperature", "top_p", "top_k", "min_p", "seed"], ["temperature", "top_p", "top_k", "min_p", "seed"]]);
  assert.deepEqual(proxy.pinnedSampling(), { ...SAMPLING, seed: 1002, uniform: true });
  assert.deepEqual(proxy.summary(), { requests: 2, overrode_keys: ["min_p", "seed", "temperature", "top_k", "top_p"], tools_ok: null });
  // A request that already carries the pre-registered values overrides nothing.
  const same = await startSamplingProxy({ upstream: stub.baseUrl, model: MODEL, rep: 2 });
  t.after(() => same.close());
  await post(`${same.baseUrl}/chat/completions`, { model: MODEL, messages: [], ...SAMPLING, seed: 1002 });
  assert.deepEqual(same.requests[0].overrode_keys, []);
});

test("SSE streams through unchanged", async (t) => {
  const stub = await startStubModel({ script: [{ text: "hello there" }] });
  t.after(() => stub.close());
  const proxy = await startSamplingProxy({ upstream: stub.baseUrl, model: MODEL, rep: 0 });
  t.after(() => proxy.close());
  const r = await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, stream: true, messages: [] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const frames = parseSse(await r.text());
  assert.equal(frames.at(-1), "[DONE]");
  const chunks = frames.slice(0, -1);
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "hello there");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  for (const c of chunks) assert.equal(c.object, "chat.completion.chunk");
});

test("only GET /v1/models and POST /v1/chat/completions for the one model are forwarded", async (t) => {
  const stub = await startStubModel({ script: [] });
  t.after(() => stub.close());
  const proxy = await startSamplingProxy({ upstream: stub.baseUrl, model: MODEL, rep: 0 });
  t.after(() => proxy.close());
  assert.equal((await fetch(`${proxy.baseUrl}/models`)).status, 200, "the models route is forwarded");
  for (const [method, path] of [["GET", "/v1/models/extra"], ["POST", "/v1/completions"], ["GET", "/v1/chat/completions"], ["PUT", "/v1/models"], ["GET", "/elsewhere"]]) {
    const r = await fetch(`${proxy.baseUrl}${path.replace(/^\/v1/, "")}`, { method, body: method === "GET" ? undefined : "{}" });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  // Another model never reaches the arm's endpoint.
  const wrong = await post(`${proxy.baseUrl}/chat/completions`, { model: "another-model", messages: [] });
  assert.equal(wrong.status, 400);
  assert.match(JSON.stringify(await wrong.json()), /serves only/);
  assert.equal(stub.requests.length, 0, "nothing reached the model");
});

test("offered tool names are recorded per request, and the summary compares them to the expected set", async (t) => {
  const stub = await startStubModel({ script: [{ text: "one" }, { text: "two" }] });
  t.after(() => stub.close());
  const tools = [{ type: "function", function: { name: "mcp__crow-projects__crow_web_search" } }, { type: "function", function: { name: "mcp__crow-projects__crow_add_source" } }];
  const proxy = await startSamplingProxy({ upstream: stub.baseUrl, model: MODEL, rep: 0, expectedTools: ["mcp__crow-projects__crow_add_source", "mcp__crow-projects__crow_web_search"] });
  t.after(() => proxy.close());
  await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, messages: [], tools });
  assert.deepEqual(proxy.requests[0].tools, ["mcp__crow-projects__crow_web_search", "mcp__crow-projects__crow_add_source"]);
  assert.equal(proxy.summary().tools_ok, true);
  // An extra tool on any request (a pi builtin, say) fails the set comparison.
  await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, messages: [], tools: [...tools, { type: "function", function: { name: "read" } }] });
  assert.equal(proxy.summary().tools_ok, false);
});

test("the proxy forwards an abort upstream (a killed turn never leaves the arm generating)", async (t) => {
  const closed = [];
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"x\":1}\n\n");
    req.on("close", () => closed.push("request"));
    res.on("close", () => closed.push("response"));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { upstream.closeAllConnections?.(); upstream.close(r); }));
  const proxy = await startSamplingProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, model: MODEL, rep: 0, idleTimeoutMs: 5_000 });
  t.after(() => proxy.close());
  const { request } = await import("node:http");
  await new Promise((resolve, reject) => {
    const req = request(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.once("data", () => { res.destroy(); resolve(); });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: MODEL, stream: true, messages: [] }));
  });
  for (let i = 0; i < 100 && closed.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(closed.sort(), ["request", "response"], "the upstream request and response were torn down");
});

test("S2: a slow SECOND request is not killed by the connect timer (one upstream socket per request)", async (t) => {
  // The first reply is immediate, so the upstream socket is pooled; the second reply's first byte
  // arrives after the connect timeout. On a reused keep-alive socket no "connect" event ever fires
  // again, so a connect timer armed on it would destroy a healthy request — which is exactly the
  // shape of a long second tool-call turn.
  let n = 0;
  const perSocket = new Map(); // inbound socket -> id, so the test can see whether one was reused
  const seen = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      n += 1;
      const mine = n;
      if (!perSocket.has(req.socket)) perSocket.set(req.socket, perSocket.size + 1);
      seen.push(perSocket.get(req.socket));
      const reply = () => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply ${mine}` } }] }));
      };
      if (mine === 1) reply(); else setTimeout(reply, 600);
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { upstream.closeAllConnections?.(); upstream.close(r); }));
  const proxy = await startSamplingProxy({
    upstream: `http://127.0.0.1:${upstream.address().port}/v1`, model: MODEL, rep: 0, connectTimeoutMs: 100, idleTimeoutMs: 10_000,
  });
  t.after(() => proxy.close());
  const first = await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, messages: [] });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).choices[0].message.content, "reply 1");
  const second = await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, messages: [] }, { signal: AbortSignal.timeout(10_000) });
  assert.equal(second.status, 200, "the second request survived its own connect wait");
  assert.equal((await second.json()).choices[0].message.content, "reply 2");
  // The mechanism: one upstream socket per request, so a connect event always fires.
  assert.deepEqual(seen, [1, 2], "each request got its own upstream socket, never a reused one");
});

test("S3: an abort before the upstream headers destroys the in-flight upstream request", async (t) => {
  // The pre-header window (a long prefill): the proxy has no upstream response to destroy yet, so
  // it must destroy the request it is awaiting.
  const closed = [];
  // The upstream RESPONSE's close is the abort signal (the request's own close fires as soon as its
  // body has been read, on Node 16+). Nothing here ever writes a response, so a close can only be
  // a teardown.
  const upstream = createServer((req, res) => {
    req.on("data", () => {});
    res.on("close", () => closed.push("response"));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { upstream.closeAllConnections?.(); upstream.close(r); }));
  const proxy = await startSamplingProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, model: MODEL, rep: 0, idleTimeoutMs: 60_000 });
  t.after(() => proxy.close());
  const { request } = await import("node:http");
  const req = request(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" } });
  req.on("error", () => { /* the abort's own error */ });
  req.end(JSON.stringify({ model: MODEL, stream: true, messages: [] }));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(closed, [], "the upstream request is still open before the abort");
  req.destroy();
  for (let i = 0; i < 100 && !closed.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(closed, ["response"], "the stub saw its request torn down, so the arm stopped generating");
});

test("the proxy's idle timeout bounds a silent upstream", async (t) => {
  // Headers, then silence: the proxy's idle bound must cut the wait short (a model that accepts and
  // then says nothing must not hold a turn open).
  const upstream = createServer((req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { upstream.closeAllConnections?.(); upstream.close(r); }));
  const proxy = await startSamplingProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, model: MODEL, rep: 0, idleTimeoutMs: 100 });
  t.after(() => proxy.close());
  const started = Date.now();
  const r = await post(`${proxy.baseUrl}/chat/completions`, { model: MODEL, messages: [] }, { signal: AbortSignal.timeout(10_000) });
  assert.equal(r.status, 200);
  await assert.rejects((async () => { for await (const _ of r.body) { /* drain until the proxy cuts it */ } })(), /terminated|ECONNRESET|aborted|other side closed/i);
  assert.ok(Date.now() - started < 5_000, "the idle wait was cut short");
});

// ---- preflight (plan Task 5, rev 2 #5, ruling S) -----------------------------------------------

test("preflight passes when /models lists exactly the model", async (t) => {
  const stub = await startStubModel({ script: [] });
  t.after(() => stub.close());
  const entry = await preflightModels({ baseUrl: stub.baseUrl, model: MODEL });
  assert.equal(entry.id, MODEL);
  // Where the server exposes a status, "loaded" passes and anything else is refused.
  const loaded = await modelsServer(t, { object: "list", data: [{ id: "m", status: { value: "loaded" } }] });
  assert.equal((await preflightModels({ baseUrl: loaded.baseUrl, model: "m" })).id, "m");
  const loading = await modelsServer(t, { data: [{ id: "m", status: { value: "unloaded" } }] });
  await assert.rejects(preflightModels({ baseUrl: loading.baseUrl, model: "m" }), (e) => e instanceof PreflightRefused && /status "unloaded"/.test(e.message));
});

test("preflight refuses unreachable, non-200, absent, extra and empty model lists", async (t) => {
  const refuse = async (baseUrl, model, re) => assert.rejects(preflightModels({ baseUrl, model }), (e) => e instanceof PreflightRefused && re.test(e.message));
  await refuse("http://127.0.0.1:1/v1", MODEL, /unreachable/);
  const bad = await modelsServer(t, { error: "nope" }, 503);
  await refuse(bad.baseUrl, MODEL, /returned 503/);
  const other = await modelsServer(t, { data: [{ id: "other" }] });
  await refuse(other.baseUrl, MODEL, /not --model/);
  const two = await modelsServer(t, { data: [{ id: MODEL }, { id: "other" }] });
  await refuse(two.baseUrl, MODEL, /single-model server/);
  const empty = await modelsServer(t, { data: [] });
  await refuse(empty.baseUrl, MODEL, /lists 0 models/);
  await refuse(two.baseUrl, MODEL, /preflight refused/);
});

test("a gateway port, a gateway path, a foreign host or a lazy loader is not an arm", () => {
  const ok = { baseUrl: "http://127.0.0.1:8010/v1", model: "m" };
  assert.doesNotThrow(() => checkArmEndpoint(ok));
  const bad = [
    [{ ...ok, baseUrl: "http://127.0.0.1:3001/v1" }, /gateway port/],
    [{ ...ok, baseUrl: "http://127.0.0.1:8010/llm/v1" }, /goes through a gateway/],
    [{ ...ok, baseUrl: "http://192.0.2.10:8030/v1" }, /not loopback and not in allowHosts/],
    [{ ...ok, baseUrl: "http://127.0.0.1:11434/v1" }, /model loader/],
    [{ ...ok, baseUrl: "http://127.0.0.1:8010/v1", gatewayPorts: [8010] }, /gateway port/],
  ];
  for (const [arm, re] of bad) assert.throws(() => checkArmEndpoint(arm), (e) => e instanceof DriverRefusal && re.test(e.message), arm.baseUrl);
  // An --allow-host entry admits the one named endpoint (a remote arm's shape).
  assert.doesNotThrow(() => checkArmEndpoint({ ...ok, baseUrl: "http://192.0.2.10:8030/v1", allowHosts: ["192.0.2.10:8030"] }));
});

test("the sampling probe proves seed, top_k and min_p AFTER a control that the arm can vary at all", async (t) => {
  const good = await samplerServer(t);
  const proof = await proveSampling({ baseUrl: good.baseUrl, model: MODEL });
  // Four control requests (four seeds) + one pair per pin.
  assert.deepEqual(proof, { seed: true, top_k: true, min_p: true, requests: 10 });
  for (const b of good.bodies) {
    assert.ok(b.max_tokens <= 16, String(b.max_tokens));
    assert.equal(b.temperature, 1, "temperature 1, so it can never greedy-fy a pair on its own");
    assert.equal(b.top_p, 1, "top_p 1, so it can never greedy-fy a pair on its own");
    assert.equal(b.stream, false);
    assert.equal(b.messages[0].content, PROBE_PROMPT);
  }
  // The control goes first, with the high-entropy prompt and four different seeds.
  assert.deepEqual(good.bodies.slice(0, 4).map((b) => b.seed), [...PROBE_SEEDS]);
  for (const b of good.bodies.slice(0, 4)) assert.deepEqual([b.top_k, b.min_p], [0, 0], "nothing is pinned in the control");
  // The pin pairs change exactly the field they test.
  assert.deepEqual(good.bodies.slice(4).map((b) => [b.top_k, b.min_p, b.seed]),
    [[0, 0, PROBE_SEEDS[0]], [0, 0, PROBE_SEEDS[0]], [1, 0, PROBE_SEEDS[0]], [1, 0, PROBE_SEEDS[1]], [0, 1, PROBE_SEEDS[0]], [0, 1, PROBE_SEEDS[1]]]);
  // A thinking model answers in reasoning_content; reading it is what keeps its proof honest.
  const thinking = await samplerServer(t, { thinking: true });
  assert.deepEqual(await proveSampling({ baseUrl: thinking.baseUrl, model: MODEL }), { seed: true, top_k: true, min_p: true, requests: 10 });
  await assert.rejects(proveSampling({ baseUrl: (await samplerServer(t, { seed: false })).baseUrl, model: MODEL }), /seed is not honoured/);
  await assert.rejects(proveSampling({ baseUrl: (await samplerServer(t, { topK: false })).baseUrl, model: MODEL }), /top_k is not honoured/);
  await assert.rejects(proveSampling({ baseUrl: (await samplerServer(t, { minP: false })).baseUrl, model: MODEL }), /min_p is not honoured/);
  await assert.rejects(proveSampling({ baseUrl: "http://127.0.0.1:1/v1", model: MODEL }), (e) => e instanceof PreflightRefused && /sampling probe could not reach/.test(e.message));
});

test("B1: the probe refuses an arm that is deterministic without the pins", async (t) => {
  // The three false passes the old three-pair probe gave, in order of how they passed:
  //  1. a server that ignores every field and is deterministic — every pair was equal;
  //  2. a server with a fixed seed of its own that ignores the request's seed — the equal pair
  //     proved nothing, because the pins were never exercised;
  //  3. a thinking model whose content is empty — every output was "" == "".
  const deterministic = await samplerServer(t, { constant: true });
  await assert.rejects(proveSampling({ baseUrl: deterministic.baseUrl, model: MODEL }),
    (e) => e instanceof PreflightRefused && /cannot prove sampling: the arm is deterministic without the pins/.test(e.message));
  assert.equal(deterministic.bodies.length, 4, "it stopped at the control: the pin pairs prove nothing on a constant arm");
  // A fixed server seed: the control varies, so only the seed pair can catch it (and it does).
  const fixedSeed = await samplerServer(t, { seed: false });
  await assert.rejects(proveSampling({ baseUrl: fixedSeed.baseUrl, model: MODEL }),
    (e) => e instanceof PreflightRefused && /seed is not honoured/.test(e.message));
  const thinkingOnly = await samplerServer(t, { thinking: true, seed: false });
  await assert.rejects(proveSampling({ baseUrl: thinkingOnly.baseUrl, model: MODEL }),
    (e) => e instanceof PreflightRefused && /seed is not honoured/.test(e.message));
  // Every output empty: refused, never read as "equal, therefore seeded".
  const blank = await samplerServer(t, { empty: true });
  await assert.rejects(proveSampling({ baseUrl: blank.baseUrl, model: MODEL }),
    (e) => e instanceof PreflightRefused && /empty completion every time/.test(e.message));
});

test("evalBotDef grants exactly the skill's crow-projects tools, selects the skill, and passes the driver's guards", async () => {
  const home = tmp();
  const def = evalBotDef({ model: MODEL, crowHome: home });
  assert.equal(def.id, EVAL_BOT_ID);
  assert.deepEqual(def.skills, ["research-pipeline"]);
  assert.deepEqual(def.tools.pi_builtin, []);
  assert.equal(def.permission_policy.bash, "deny");
  assert.deepEqual(def.permission_policy.write_paths, []);
  assert.deepEqual(def.permission_policy.read_paths, []);
  assert.equal(def.permission_policy.skill_learning, "off");
  assert.equal(def.project_id, undefined, "v1 bots are project-less");
  assert.equal(def.tools.crow_mcp.length, 13, JSON.stringify(def.tools.crow_mcp));
  for (const e of def.tools.crow_mcp) assert.match(e, /^crow-projects\/crow_[a-z_]+$/);
  assert.ok(def.tools.crow_mcp.includes("crow-projects/crow_add_source"));
  assert.ok(def.tools.crow_mcp.includes("crow-projects/crow_verify_source"));
  // The driver's own checks, against the models the run will pass.
  const models = { providers: { arm: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: MODEL }] } } };
  assert.equal(def.models.default, `arm/${MODEL}`);
  assert.doesNotThrow(() => checkBotDef(def, models, home));
  assert.doesNotThrow(() => checkToolSurface(def, { allowServers: ["crow-projects"], allowSkills: ["research-pipeline"], scratchHome: home }));
  assert.doesNotThrow(() => checkToolGrant(def));
});

test("liveMcpOverrides passes checkMcpOverrides for its scratch", () => {
  const home = tmp();
  const scratch = { home, fetchLogPath: join(home, "fetch.jsonl") };
  const overrides = liveMcpOverrides(scratch, join(home, "case.json"));
  assert.deepEqual(overrides["crow-projects"].env, {
    CROW_RESEARCH_EVAL: "1", CROW_HOME: home, CROW_RESEARCH_EVAL_CASE: join(home, "case.json"),
    CROW_RESEARCH_EVAL_FETCH_LOG: join(home, "fetch.jsonl"), TMPDIR: tmpdir(),
  });
  assert.equal(overrides["crow-projects"].command, process.execPath);
  // A fetch log outside the home is refused in the parent, before a scratch is spent.
  const bad = { home, fetchLogPath: join(tmpdir(), "outside-fetch.jsonl") };
  assert.throws(() => liveMcpOverrides(bad, join(home, "case.json")), /strictly inside the sealed home/);
});

// ---- the seam checks (rev 2 #3 and #14) --------------------------------------------------------

test("abortOnSeamFailure aborts on an override receipt, a tool-set or a fixture-identity mismatch", () => {
  const home = tmp();
  const okR = { threads: [{ id: "rr12-r0", turns: [{ turn: 0, mcpOverridden: ["crow-projects"] }] }] };
  const okSummary = { requests: 2, tools_ok: true };
  const events = [{ ev: "spawn", runId: "run-1" }];
  const marker = (o) => writeFileSync(join(home, FIXTURE_START_MARKER), JSON.stringify(o));
  marker({ pid: 4242, case: RR12.id, run_id: "run-1" });
  assert.equal(abortOnSeamFailure({ r: okR, summary: okSummary, scratch: { home }, caseDef: RR12, events }), undefined);
  const abort = (m, re) => assert.throws(m, (e) => e instanceof LiveAbort && re.test(e.message), String(re));
  abort(() => abortOnSeamFailure({ r: { threads: [{ id: "t", turns: [{ turn: 0, mcpOverridden: null }] }] }, summary: okSummary, scratch: { home }, caseDef: RR12, events }), /MCP override did not reach pi/);
  abort(() => abortOnSeamFailure({ r: { threads: [{ id: "t", turns: [{ turn: 0, mcpOverridden: ["crow-projects", "crow-memory"] }] }] }, summary: okSummary, scratch: { home }, caseDef: RR12, events }), /MCP override did not reach pi/);
  abort(() => abortOnSeamFailure({ r: okR, summary: { requests: 2, tools_ok: false }, scratch: { home }, caseDef: RR12, events }), /not exactly the granted set/);
  rmSync(join(home, FIXTURE_START_MARKER), { force: true });
  abort(() => abortOnSeamFailure({ r: okR, summary: okSummary, scratch: { home }, caseDef: RR12, events }), /no start marker/);
  assert.equal(readStartMarker(home), null);
  marker({ pid: 1, case: "rr01", run_id: "run-1" });
  abort(() => abortOnSeamFailure({ r: okR, summary: okSummary, scratch: { home }, caseDef: RR12, events }), /names case "rr01"/);
  marker({ pid: 1, case: RR12.id, run_id: "another-run" });
  abort(() => abortOnSeamFailure({ r: okR, summary: okSummary, scratch: { home }, caseDef: RR12, events }), /names run "another-run"/);
  assert.deepEqual(readStartMarker(home), { pid: 1, case: RR12.id, run_id: "another-run" });
  // N4: no event carrying a run id means the marker cannot be tied to this run at all — an abort,
  // not a skipped check (the stale "another-run" marker above would otherwise pass).
  abort(() => abortOnSeamFailure({ r: okR, summary: okSummary, scratch: { home }, caseDef: RR12, events: [{ ev: "spawn" }] }), /no driver event carried a run id/);
  abort(() => abortOnSeamFailure({ r: okR, summary: okSummary, scratch: { home }, caseDef: RR12, events: [] }), /no driver event carried a run id/);
});

test("readStartMarker survives a missing or malformed marker", () => {
  const home = tmp();
  assert.equal(readStartMarker(home), null);
  writeFileSync(join(home, FIXTURE_START_MARKER), "not json\n");
  assert.equal(readStartMarker(home), null);
});

// ---- retry policy (ruling R) -------------------------------------------------------------------

test("only transport failures are re-rolled: 5xx, connection errors, survivors and a missing session", () => {
  for (const why of ["model call failed: Connection error", "model call failed: status 500 from the provider", "ECONNRESET while reading",
    // N2: a 4xx-looking PORT is not a client error — the old /\b4[0-9]{2}\b/ refused to retry this.
    "model call failed: ECONNRESET at 127.0.0.1:443", "model call failed: socket hang up (:8443)",
    "child exited 0 without a done event; killTree survivors: 41", "run processes survived the thread: 42 killed",
    "cannot find the pi session file for a completed turn; refusing to report it"]) {
    assert.equal(retryableFailure(why), true, why);
  }
  for (const why of ["turn 0 of rr12-r0 exceeded 900000 ms", "model call failed: 400: bad request", "context length exceeded",
    "model call failed: status 429", "model call failed: HTTP 403 forbidden", "conversation exceeded wallMs", "child exited 4 without a turn-end", "", null]) {
    assert.equal(retryableFailure(why), false, String(why));
  }
});

test("completionTokensOf sums assistant usage.output, and is null when no message carries one", () => {
  const line = (m) => JSON.stringify({ type: "message", message: m });
  const log = [
    JSON.stringify({ type: "session", id: "s" }),
    line({ role: "user", content: [{ type: "text", text: "hi" }] }),
    line({ role: "assistant", content: [{ type: "text", text: "a" }], usage: { input: 10, output: 7 } }),
    line({ role: "toolResult", content: [{ type: "text", text: "r" }], usage: { output: 100 } }),
    line({ role: "assistant", content: [{ type: "text", text: "b" }], usage: { input: 4, output: 3 } }),
  ].join("\n");
  assert.equal(completionTokensOf(log), 10);
  assert.equal(completionTokensOf(line({ role: "assistant", content: [] })), null);
  assert.equal(completionTokensOf(""), null);
});

// ---- the runner, with the stub pi (plan Task 7) ------------------------------------------------

let templateP;
const tpl = () => (templateP ??= makeTemplate({ botId: EVAL_BOT_ID }));
test.after(async () => (await templateP?.catch(() => null))?.cleanup());

const caseSet = () => caseSetIdentity(CASES_DIR);
const identityFor = (baseUrl) => liveRunIdentity({
  model: MODEL, baseUrl, botDefSha: "def-sha", piSha: "pi-sha", skillSha: "skill-sha", caseSet: caseSet(),
});

/** The runner's options against a stub model (the stub pi never calls it). */
async function runnerOpts(t, over = {}) {
  const stub = await startStubModel({ script: [] });
  t.after(() => stub.close());
  const dir = tmp();
  const out = join(dir, "rows.jsonl");
  return {
    stub,
    out,
    opts: {
      cases: [RR12], arm: "stub-arm", model: MODEL, baseUrl: stub.baseUrl, piCli: STUB_PI, piLab: REPO,
      prodMaxPi: LIFECYCLE_DEFAULTS.maxPi, reps: 1, out, template: await tpl(), caseSet: caseSet(),
      identity: identityFor(stub.baseUrl), botDefSha: "def-sha", log: () => {}, ...over,
    },
  };
}

test("runLiveRows with the stub pi writes one contaminated row per (case, rep): no model request was proxied", async (t) => {
  const { out, opts } = await runnerOpts(t, { reps: 2 });
  const res = await runLiveRows(opts);
  assert.equal(res.rows, 2);
  assert.equal(res.stop, null);
  const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.case, r.rep]), [[RR12.id, 0], [RR12.id, 1]]);
  for (const r of rows) {
    assert.equal(r.ok, false);
    assert.equal(r.contaminated, "no model request passed the sampling proxy");
    assert.equal(r.attempts, 1, "not retried: it is not a transport failure");
    assert.deepEqual(r.attempt_reasons, []);
    assert.equal(r.config.mode, "live");
    assert.equal(r.config.judge, null, "--no-judge: no judge identity in the row");
    assert.deepEqual(r.config.case_set, caseSet(), "the case-set identity rides in config");
    assert.equal(r.config.gateway, "eval");
    assert.match(r.config.bot_def_sha, /^[a-z0-9-]+$/);
    assert.deepEqual(r.sampling_proxy, { requests: 0, overrode_keys: [], tools_ok: null });
    assert.ok(within(realish(out), realish(tmpdir())));
  }
  // The same (case, rep) again in a NEW run: a reused scratch would be refused by the driver
  // ("thread rr12-r0 was already run in this scratch home"), so this proves a fresh scratch each.
  const again = join(tmp(), "again.jsonl");
  const second = await runLiveRows({ ...opts, out: again });
  assert.equal(second.rows, 2);
  assert.equal(JSON.parse(readFileSync(again, "utf8").split("\n")[0]).contaminated, "no model request passed the sampling proxy");
});

test("--resume skips the (arm, case, rep) already in the file", async (t) => {
  const { out, opts } = await runnerOpts(t);
  assert.equal((await runLiveRows(opts)).rows, 1);
  const res = await runLiveRows({ ...opts, done: doneKeys(out), out: join(tmp(), "other.jsonl") });
  assert.equal(res.rows, 0);
  assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 1);
});

test("a config change refuses --resume", async (t) => {
  const { out, opts } = await runnerOpts(t);
  assert.equal((await runLiveRows(opts)).rows, 1);
  const prev = existingRunKey(out);
  assert.equal(prev.key, identityFor(opts.baseUrl).key);
  const changed = liveRunIdentity({ model: "another-model", baseUrl: opts.baseUrl, botDefSha: "def-sha", piSha: "pi-sha", skillSha: "skill-sha", caseSet: caseSet() });
  assert.notEqual(changed.key, prev.key);
  assert.equal(existingRunKey(join(tmp(), "absent.jsonl")), null);
});

test("a DriverRefusal aborts before any row is written", async (t) => {
  const { out, opts } = await runnerOpts(t, { piCli: join(tmpdir(), "no-such-pi") });
  await assert.rejects(runLiveRows(opts), (e) => e instanceof DriverRefusal && /piCli/.test(e.message));
  assert.equal(existsSync(out), false, "no row was written");
});

test("a mid-run preflight failure stops the run and keeps the rows already written", async (t) => {
  let calls = 0;
  const flaky = createServer((req, res) => {
    calls += 1;
    const ok = calls === 1;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { data: [{ id: MODEL }] } : { error: "draining" }));
  });
  await new Promise((r) => flaky.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { flaky.closeAllConnections?.(); flaky.close(r); }));
  const baseUrl = `http://127.0.0.1:${flaky.address().port}/v1`;
  const out = join(tmp(), "rows.jsonl");
  await assert.rejects(runLiveRows({
    cases: [RR12], arm: "stub-arm", model: MODEL, baseUrl, piCli: STUB_PI, piLab: REPO, reps: 2,
    prodMaxPi: LIFECYCLE_DEFAULTS.maxPi, out, template: await tpl(), caseSet: caseSet(), identity: identityFor(baseUrl), botDefSha: "def-sha",
  }), (e) => e instanceof PreflightRefused && /returned 503/.test(e.message));
  const rows = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, "the unit that ran keeps its row");
  assert.equal(rows[0].rep, 0);
});

test("a transport failure is retried with the same seed, at most MAX_ATTEMPTS, then the row is contaminated", async (t) => {
  // PIBOT_TEST_NO_JSONL: the stub pi writes no session file, which is the driver's SESSION_MISSING.
  const { out, opts } = await runnerOpts(t, { parentEnv: { ...process.env, PIBOT_TEST_NO_JSONL: "1" } });
  const logs = [];
  const res = await runLiveRows({ ...opts, log: (m) => logs.push(m) });
  assert.equal(res.rows, 1);
  const row = JSON.parse(readFileSync(out, "utf8").trim());
  assert.equal(row.ok, false);
  assert.equal(row.contaminated, TRANSPORT_FAILURE(3));
  assert.equal(row.attempts, 3);
  assert.equal(row.attempt_reasons.length, 3, "every attempt's reason is kept");
  for (const r of row.attempt_reasons) assert.match(r, /cannot find the pi session file/);
  assert.equal(logs.filter((m) => /: transport failure \(/.test(m)).length, 2);
});

test("a model 400 is flagged, never re-rolled", async (t) => {
  const { out, opts } = await runnerOpts(t, { parentEnv: { ...process.env, PIBOT_TEST_MODEL_ERROR_ON_TURN: "1" } });
  const res = await runLiveRows(opts);
  assert.equal(res.rows, 1);
  const row = JSON.parse(readFileSync(out, "utf8").trim());
  assert.equal(row.ok, false);
  assert.match(row.contaminated, /model call failed: 400/);
  assert.equal(row.attempts, 1);
});

// ---- the CLI (plan Task 7) ---------------------------------------------------------------------

const liveArg = (over = {}) => ({
  mode: "live", "no-judge": "1", arm: "stub-arm", "base-url": "http://127.0.0.1:9/v1", model: MODEL,
  out: join(tmp(), "rows.jsonl"), "pi-cli": STUB_PI, "pi-lab": REPO, "prod-max-pi": String(LIFECYCLE_DEFAULTS.maxPi),
  "window-end": new Date(Date.now() + 3_600_000).toISOString(), ...over,
});

test("live mode refuses a judge config, a missing --no-judge, and missing flags", async () => {
  const say = [];
  const log = (m) => say.push(m);
  assert.equal(await runLive({ ...liveArg(), "judge-config": "/x.json" }, { log }), 2);
  assert.deepEqual(say, [NO_JUDGE_YET]);
  say.length = 0;
  const noJudge = liveArg(); delete noJudge["no-judge"];
  assert.equal(await runLive(noJudge, { log }), 2);
  assert.match(say.join("\n"), /explicit --no-judge/);
  say.length = 0;
  for (const k of ["arm", "base-url", "model", "out", "pi-cli", "pi-lab", "prod-max-pi", "window-end"]) {
    assert.equal(await runLive({ ...liveArg(), [k]: undefined }, { log }), 2, k);
    assert.match(say.join("\n"), new RegExp(`--${k}\\b`), k);
    say.length = 0;
  }
});

test("live mode refuses --concurrency>1, a past window, a bad --reps and an unsafe --out", async () => {
  const say = [];
  const log = (m) => say.push(m);
  assert.equal(await runLive(liveArg({ concurrency: "4" }), { log }), 2);
  assert.match(say.join("\n"), /--concurrency must be 1/);
  say.length = 0;
  assert.equal(await runLive(liveArg({ "window-end": new Date(Date.now() - 60_000).toISOString() }), { log }), 2);
  assert.match(say.join("\n"), /in the past/);
  say.length = 0;
  assert.equal(await runLive(liveArg({ reps: "0" }), { log }), 2);
  assert.match(say.join("\n"), /--reps/);
  for (const out of [join(REPO, "rows.jsonl"), join(REPO, "scripts", "research-eval", "rows.jsonl"), join(realUserCrowDir(), "rows.jsonl")]) {
    say.length = 0;
    assert.equal(await runLive(liveArg({ out }), { log }), 2, out);
    assert.match(say.join("\n"), /must not be inside/, out);
  }
  for (const out of [join(REPO, "rows.jsonl"), join(realUserCrowDir(), "rows.jsonl")]) {
    say.length = 0;
    assert.equal(await runLive(liveArg({ "sessions-dir": out }), { log }), 2, out);
    assert.match(say.join("\n"), /--sessions-dir must not be inside/, out);
  }
  assert.ok(!existsSync(join(REPO, "rows.jsonl")));
});

test("live mode's endpoint check runs before anything is built or sent", async () => {
  const say = [];
  assert.equal(await runLive(liveArg({ "base-url": "http://127.0.0.1:3001/v1" }), { log: (m) => say.push(m) }), 2);
  assert.match(say.join("\n"), /gateway port/);
  assert.equal(await runLive(liveArg({ "base-url": "http://192.0.2.10:8030/v1" }), { log: (m) => say.push(m) }), 2);
  assert.match(say.join("\n"), /not loopback/);
});

test("an unreachable arm is exit 4, and no row is written", async () => {
  const out = join(tmp(), "rows.jsonl");
  const say = [];
  assert.equal(await runLive(liveArg({ "base-url": "http://127.0.0.1:1/v1", out }), { log: (m) => say.push(m) }), 4);
  assert.match(say.join("\n"), /preflight refused/);
  assert.equal(existsSync(out), false);
});

test("the whole CLI runs a unit, then --resume refuses a changed config", async (t) => {
  // A seeded arm: the probe needs a server that varies without the pins and honours them.
  const arm = await samplerServer(t);
  const cases = tmp();
  writeFileSync(join(cases, `${RR12.id}.json`), JSON.stringify(RR12));
  const out = join(tmp(), "rows.jsonl");
  const arg = liveArg({ "base-url": arm.baseUrl, out, cases, reps: "1" });
  const say = [];
  // The stub pi never asks the model for anything: one honest contaminated row, exit 0.
  assert.equal(await runLive(arg, { log: (m) => say.push(m) }), 0, say.join("\n"));
  assert.match(say.join("\n"), /sampling proof: the arm varies without the pins, and seed, top_k and min_p are honoured/);
  const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contaminated, "no model request passed the sampling proxy");
  assert.deepEqual(rows[0].config.case_set, caseSetIdentity(cases));
  // Same invocation with --resume: nothing left to do.
  say.length = 0;
  assert.equal(await runLive({ ...arg, resume: "1" }, { log: (m) => say.push(m) }), 0, say.join("\n"));
  assert.match(say.join("\n"), /0 rows written/);
  // A different model is a different run: --resume refuses it.
  say.length = 0;
  assert.equal(await runLive({ ...arg, resume: "1", model: "stub-m2" }, { log: (m) => say.push(m) }), 2);
  assert.match(say.join("\n"), /--resume refused/);
  // A different case set too.
  say.length = 0;
  const otherCases = tmp();
  writeFileSync(join(otherCases, `${RR12.id}.json`), JSON.stringify({ ...RR12, prompt: `${RR12.prompt} (rewritten)` }));
  assert.equal(await runLive({ ...arg, resume: "1", cases: otherCases }, { log: (m) => say.push(m) }), 2);
  assert.match(say.join("\n"), /--resume refused/);
});

test("run.mjs --mode=live without the required flags exits 2 with the live usage", () => {
  const r = spawnSync(process.execPath, [RUN, "--mode=live", "--no-judge", `--out=${join(tmp(), "x.jsonl")}`], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /live mode needs/);
  assert.match(r.stderr, new RegExp(LIVE_USAGE.split("\n")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60)));
  const judge = spawnSync(process.execPath, [RUN, "--mode=live", "--judge-config=/x.json"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(judge.status, 2);
  assert.match(judge.stderr, new RegExp(NO_JUDGE_YET.replace(/[()]/g, "\\$&")));
});

test("stableStringify is order-independent and liveRunIdentity keys on every part", () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
  const base = { model: MODEL, baseUrl: "http://127.0.0.1:9/v1", botDefSha: "d", piSha: "p", skillSha: "s", caseSet: caseSet() };
  const a = liveRunIdentity(base);
  for (const over of [{ model: "other" }, { baseUrl: "http://127.0.0.1:10/v1" }, { botDefSha: "d2" }, { piSha: "p2" },
    { skillSha: "s2" }, { caseSet: { dir: "/elsewhere", sha: "x" } }, { judgeName: "some-judge" },
    // N3: the pi model entry is part of the run's identity, so --resume cannot quietly change it.
    { piModel: { maxTokens: 4096 } }]) {
    assert.notEqual(liveRunIdentity({ ...base, ...over }).key, a.key, JSON.stringify(over));
  }
  assert.equal(liveRunIdentity(base).key, a.key);
  assert.deepEqual(liveRunIdentity({ ...base, piModel: { maxTokens: 4096 } }).pi_model, { maxTokens: 4096 });
});

test("N3: the arm's model entry keeps --model as its id, whatever --pi-model carries", () => {
  assert.deepEqual(armModelEntry(MODEL, null), { id: MODEL });
  assert.deepEqual(armModelEntry(MODEL, { maxTokens: 4096 }), { maxTokens: 4096, id: MODEL });
  // A pi-model file naming its own id must not redirect the run (the proxy would refuse it).
  assert.deepEqual(armModelEntry(MODEL, { id: "another-model" }), { id: MODEL });
});