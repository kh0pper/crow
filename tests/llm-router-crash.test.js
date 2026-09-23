// tests/llm-router-crash.test.js
//
// Final-review fix wave, item 1 (pre-existing bug, fixed alongside
// serving.class): Express 4 does not catch an async route handler's
// rejection. `handleChat`'s acquire-catch rethrows any acquireFn failure
// that is neither a ServingClassError nor a ReservedError (the `else if
// (!(err instanceof ReservedError)) { throw err; }` branch in
// servers/gateway/routes/llm-router.js). Before the fix, mounting
// `router.post("/llm/v1/chat/completions", (req, res) => handleChat(req,
// res, deps))` let that rethrow escape as an UNHANDLED REJECTION —
// nostr-crash-guard treats that as fatal and kills the gateway, leaving the
// client hanging. The route now wraps the call in a `.catch` that answers a
// clean 502 instead.
//
// Harness copied from tests/llm-router-serving-class.test.js: the router's
// seams (acquireFn, resolveKeyFn, probeReadyFn) keep this hermetic — no
// gpu-orchestrator, no providers table, no real upstream is ever dialed
// (the crash happens before any upstream fetch).

process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";

let app, appUrl, srv;

before(async () => {
  const router = llmRouterRouter({
    acquireFn: async () => { throw new Error("db locked"); },
    resolveKeyFn: async (key) => ({ baseUrl: "http://127.0.0.1:1/v1", model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => false,
  });
  app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});

after(() => { if (srv) srv.close(); });

test("acquireFn throwing a plain Error is caught by the route (502), not left as an unhandled rejection", async () => {
  const unhandled = [];
  const l = (err) => unhandled.push(err);
  process.on("unhandledRejection", l);
  try {
    const r = await fetch(`${appUrl}/llm/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error.message, /db locked/);
    await new Promise((res) => setImmediate(res));
    assert.equal(
      unhandled.length,
      0,
      `unexpected unhandled rejection(s): ${unhandled.map((e) => e?.stack || e).join("\n")}`
    );
  } finally {
    process.off("unhandledRejection", l);
  }
});
