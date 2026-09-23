// tests/llm-router-serving-class.test.js
//
// Scope §3.3 (D7): a ServingClassError from acquireFn/warmFn maps the same
// way a box reservation does — degrade to the resident fast model with an
// "operator window" note on an escalation, or a fast 409 (never a retry)
// otherwise. /llm/acquire answers 409 serving_class_refused.
//
// Harness copied from tests/llm-router-reserved.test.js: the router's seams
// (acquireFn, resolveKeyFn, probeReadyFn, warmFn) keep this hermetic — no
// gpu-orchestrator, no providers table, a stub upstream.

process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";
import { ServingClassError } from "../servers/gateway/models/serving-class.js";

let upstream, upstreamUrl, seen, app, appUrl, srv;
let fastReady = true;
let refuseProvider = null; // providerId to refuse with a ServingClassError, or null

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
    acquireFn: async (providerId) => {
      if (providerId === refuseProvider) throw new ServingClassError("windowed", "glm");
      return true;
    },
    resolveKeyFn: async (key) => ({ baseUrl: upstreamUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => fastReady,
    warmFn: async (provider) => { throw new ServingClassError("wedge-risk", provider); },
  });
  app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});

after(() => { if (srv) srv.close(); if (upstream) upstream.close(); });

function reset() { seen = []; refuseProvider = null; }

async function chat(text) {
  const r = await fetch(`${appUrl}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "crow", messages: [{ role: "user", content: text }], stream: false }),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}

test("fast (non-escalate) request refused by serving.class -> 409 serving_class_refused, no Retry-After", async () => {
  reset(); refuseProvider = "crow-voice"; fastReady = true;
  const r = await chat("hi");
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, "serving_class_refused");
  assert.equal(r.headers.get("retry-after"), null);
  assert.equal(seen.length, 0);
});

test("escalation refused by serving.class + fast model resident -> degrades to the fast model with an operator-window note", async () => {
  reset(); refuseProvider = "crow-chat"; fastReady = true;
  const r = await chat("!escalate plan the migration");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "qwen3.5-4b", "re-routed to FAST_KEY's model");
  const last = seen[0].messages[seen[0].messages.length - 1];
  assert.equal(last.role, "system");
  assert.match(last.content, /operator window/);
});

test("POST /llm/acquire refused by serving.class -> 409 serving_class_refused", async () => {
  const r = await fetch(`${appUrl}/llm/acquire`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "big-model" }),
  });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "serving_class_refused");
});
