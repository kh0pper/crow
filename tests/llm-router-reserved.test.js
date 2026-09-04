// tests/llm-router-reserved.test.js
//
// Scope §3.3: while the box is reserved, /llm/v1 DEGRADES instead of
// stalling — an escalation whose acquire is refused is served by the resident
// fast model (with a system note), or answered 503 box_reserved with a
// Retry-After when even the fast model is not resident. Nothing retries, and
// no request waits 240 s for a model that will never start. /llm/acquire
// answers 409 box_reserved.
//
// The router's seams (acquireFn, resolveKeyFn, probeReadyFn, warmFn) keep
// this hermetic: no gpu-orchestrator, no providers table, a stub upstream.

process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";
import { ReservedError } from "../servers/gateway/box-reservation.js";

const RES = { owner: "win", reason: "bench", started_at: "2026-09-04T20:00:00.000Z", expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), allow: ["crow-embed"], corrupt: false, key: "k" };

let upstream, upstreamUrl, seen, app, appUrl, srv;
let fastReady = true;
let acquireCalls = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const router = llmRouterRouter({
    acquireFn: async (providerId, opts) => {
      acquireCalls.push({ providerId, opts });
      if (providerId === "crow-chat") throw new ReservedError(RES, providerId);
      if (providerId === "crow-voice" && !fastReady) throw new ReservedError(RES, providerId);
      return true;
    },
    resolveKeyFn: async (key) => ({ baseUrl: upstreamUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => fastReady,
    warmFn: async (provider) => { throw new ReservedError(RES, provider); },
  });
  app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});

after(() => { if (srv) srv.close(); if (upstream) upstream.close(); });

function reset() { seen = []; acquireCalls = []; }

async function chat(text) {
  let r;
  try { r = await fetch(`${appUrl}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-crow-client": "test" },
    body: JSON.stringify({ model: "crow", messages: [{ role: "user", content: text }], stream: false }),
  }); } catch (e) { throw new Error("fetch to " + appUrl + " failed: " + (e.cause && (e.cause.code + " " + e.cause.message))); }
  return { status: r.status, headers: r.headers, body: await r.json() };
}

test("escalation refused by a reservation + fast model resident -> served by the fast model with a system note", async () => {
  reset(); fastReady = true;
  const r = await chat("!escalate plan the migration");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "qwen3.5-4b", "re-routed to FAST_KEY's model");
  const last = seen[0].messages[seen[0].messages.length - 1];
  assert.equal(last.role, "system");
  assert.match(last.content, /reserved \(by win until /);
  assert.match(seen[0].messages[0].content, /^plan the migration/, "the !escalate token is still stripped");
  assert.deepEqual(acquireCalls.map((c) => c.providerId), ["crow-chat"], "no second acquire, no retry");
});

test("escalation refused + fast model NOT resident -> 503 box_reserved with Retry-After, nothing forwarded", async () => {
  reset(); fastReady = false;
  const r = await chat("!escalate hi");
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "box_reserved");
  assert.equal(r.body.error.owner, "win");
  assert.equal(r.body.error.expires_at, RES.expires_at);
  assert.ok(r.body.error.retry_after >= 60);
  assert.equal(r.headers.get("retry-after"), String(r.body.error.retry_after));
  assert.equal(seen.length, 0);
});

test("fast request refused (fast model cold and not allowed) -> 503 box_reserved", async () => {
  reset(); fastReady = false;
  const r = await chat("hi");
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "box_reserved");
  assert.equal(seen.length, 0);
});

test("fast request with acquire OK -> unchanged forwarding, no system note", async () => {
  reset(); fastReady = true;
  const r = await chat("hi");
  assert.equal(r.status, 200);
  assert.equal(seen[0].model, "qwen3.5-4b");
  assert.ok(!seen[0].messages.some((m) => m.role === "system" && /reserved/.test(m.content)));
});

test("POST /llm/acquire refused by a reservation -> 409 box_reserved", async () => {
  const r = await fetch(`${appUrl}/llm/acquire`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "crow-chat" }),
  });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "box_reserved");
  assert.equal(body.owner, "win");
});
