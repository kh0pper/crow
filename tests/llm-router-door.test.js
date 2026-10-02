// tests/llm-router-door.test.js
process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";
import { isTrustedDoorSource } from "../servers/gateway/models/door-resolve.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";
import { ServingClassError } from "../servers/gateway/models/serving-class.js";

let up, upUrl, seen, srv, appUrl, acquired, remote = "127.0.0.1";

before(async () => {
  up = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  const providers = {
    "crow-chat": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 1 } },
    "crow-voice": { baseUrl: upUrl, apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
    "crow-embed": { baseUrl: upUrl, doorUrl: "http://100.64.9.1:3001/llm/p/crow-embed/v1", apiKey: "none", models: [{ id: "qwen3-embedding-0.6b" }], gpuPolicy: { runtime: "native", owner: "me", port: 2 } },
    "crow-local-27b": { baseUrl: upUrl, apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow" } } },
    "crow-local-27b-copilot": { baseUrl: upUrl, apiKey: "none", models: [{ id: "qwen3.8-27b" }], gpuPolicy: { engine: { managed: "external", host: "crow" } } },
    "peer-door": { baseUrl: "http://127.0.0.1:9/llm/p/peer-door/v1", apiKey: "none", models: [{ id: "far" }], gpuPolicy: { runtime: "native", owner: "other", port: 3 } },
    "qwen-cloud": { baseUrl: "https://example.com/v1", apiKey: "sk-x", models: [{ id: "qwen3.8-max" }] },
    "crow-reserved": { baseUrl: upUrl, doorUrl: "http://d/llm/p/crow-reserved/v1", apiKey: "none", models: [{ id: "r" }], gpuPolicy: { runtime: "native", owner: "me", port: 4 } },
    "crow-wedge": { baseUrl: upUrl, doorUrl: "http://d/llm/p/crow-wedge/v1", apiKey: "none", models: [{ id: "w" }], gpuPolicy: { runtime: "native", owner: "me", port: 5 } },
  };
  const router = llmRouterRouter({
    acquireFn: async (pid) => {
      acquired.push(pid);
      if (pid === "crow-reserved") throw new ReservedError({ owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: [] }, pid);
      if (pid === "crow-wedge") throw new ServingClassError("wedge-risk", "crow-wedge");
      return true;
    },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers }),
    remoteAddressFn: () => remote,
    doorAuthFn: async (token) => token === "good-token",
  });
  const app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); up?.close(); });

function post(path, body, headers = {}) {
  seen = []; acquired = [];
  return fetch(`${appUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("isTrustedDoorSource: loopback and tailnet only", () => {
  for (const a of ["127.0.0.1", "::1", "100.64.0.1", "100.118.41.122", "100.127.255.254", "fd7a:115c:a1e0::1"]) assert.equal(isTrustedDoorSource(a), true, a);
  for (const a of ["10.0.0.50", "192.168.1.2", "172.17.0.2", "100.128.0.1", "8.8.8.8", ""]) assert.equal(isTrustedDoorSource(a), false, a);
});

test("header-addressed chat forwards to that provider with its bare model id; external engines are never acquired", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] }, { "X-Crow-Provider": "crow-local-27b-copilot" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].path, "/v1/chat/completions");
  assert.equal(seen[0].body.model, "qwen3.8-27b");
  assert.deepEqual(acquired, []);
});

test("qualified chat warms a native provider before forwarding", async () => {
  await post("/llm/v1/chat/completions", { model: "crow-chat/qwen3.6-35b-a3b", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(acquired, ["crow-chat"]);
  assert.equal(seen[0].body.model, "qwen3.6-35b-a3b");
});

test("the provider-scoped path addresses crow-chat even with a companion-alias model id", async () => {
  const r = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [{ role: "user", content: "hello there" }] });
  assert.equal(r.status, 200);
  assert.deepEqual(acquired, ["crow-chat"]);
  const m = await (await fetch(`${appUrl}/llm/p/crow-chat/v1/models`)).json();
  assert.deepEqual(m.data.map((x) => x.id), ["qwen3.6-35b-a3b"]);
  assert.equal((await fetch(`${appUrl}/llm/p/qwen-cloud/v1/models`)).status, 404);
});

test("embeddings forward through the provider path", async () => {
  const r = await post("/llm/p/crow-embed/v1/embeddings", { model: "qwen3-embedding-0.6b", input: "x" });
  assert.equal(r.status, 200);
  assert.equal(seen[0].path, "/v1/embeddings");
});

test("companion alias ids still route by heuristics", async () => {
  await post("/llm/v1/chat/completions", { model: "qwen3.5-4b", messages: [{ role: "user", content: "hello there" }] });
  assert.deepEqual(acquired, ["crow-voice"]);
});

test("an ambiguous bare id answers 400 with candidates", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-27b", messages: [] });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.candidates.length, 2);
});

test("unmanaged (cloud) rows are refused, never proxied", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "qwen3.8-max", messages: [] }, { "X-Crow-Provider": "qwen-cloud" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "NOT_FORWARDABLE");
  assert.equal(seen.length, 0);
});

test("a second hop answers 508", async () => {
  const r = await post("/llm/v1/chat/completions", { model: "peer-door/far", messages: [] }, { "X-Crow-Door-Hop": "1" });
  assert.equal(r.status, 508);
});

test("a LAN source is refused for door addressing unless it carries a valid bearer; the companion path too (Kevin decision 2026-10-02)", async () => {
  remote = "10.0.0.50";
  try {
    const r = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [] });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, "DOOR_SOURCE_REFUSED");
    assert.deepEqual(acquired, [], "nothing was started");
    const ok = await post("/llm/p/crow-chat/v1/chat/completions", { model: "qwen3.6-35b-a3b", messages: [] }, { authorization: "Bearer good-token" });
    assert.equal(ok.status, 200);
    const c = await post("/llm/v1/chat/completions", { model: "qwen3.5-4b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(c.status, 403, "the companion path is source-checked too (Kevin decision 2026-10-02)");
    assert.deepEqual(acquired, [], "nothing was started for the refused companion turn");
  } finally { remote = "127.0.0.1"; }
});

test("/llm/acquire: a LAN source is refused, loopback still works", async () => {
  remote = "10.0.0.50";
  try {
    const r = await post("/llm/acquire", { provider: "crow-chat" });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "DOOR_SOURCE_REFUSED");
  } finally { remote = "127.0.0.1"; }
  const ok = await post("/llm/acquire", { provider: "crow-chat" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test("the router refuses Funnel-headed requests itself", async () => {
  for (const path of ["/llm/v1/chat/completions", "/llm/p/crow-chat/v1/chat/completions", "/llm/v1/embeddings"]) {
    const r = await post(path, { model: "qwen3.5-4b", messages: [] }, { "tailscale-funnel-request": "?1" });
    assert.equal(r.status, 403, path);
  }
  const g = await fetch(`${appUrl}/llm/v1/models`, { headers: { "tailscale-funnel-request": "?1" } });
  assert.equal(g.status, 403);
});

test("door parity: 409 while reserved, 409 for a serving-class refusal", async () => {
  const a = await post("/llm/p/crow-reserved/v1/chat/completions", { model: "r", messages: [] });
  assert.equal(a.status, 409);
  assert.equal((await a.json()).error.code, "box_reserved");
  const b = await post("/llm/p/crow-wedge/v1/chat/completions", { model: "w", messages: [] });
  assert.equal(b.status, 409);
  assert.equal((await b.json()).error.code, "serving_class_refused");
});

test("GET /llm/v1/models lists companion ids then forwardable door models", async () => {
  const ids = (await (await fetch(`${appUrl}/llm/v1/models`)).json()).data.map((m) => m.id);
  assert.ok(ids.includes("qwen3.5-4b") && ids.includes("qwen3.6-35b-a3b"));
  assert.ok(ids.includes("crow-local-27b-copilot/qwen3.8-27b"));
  assert.equal(ids.some((i) => i.startsWith("qwen-cloud/")), false);
});
