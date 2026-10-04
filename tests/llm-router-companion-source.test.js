// tests/llm-router-companion-source.test.js
//
// Kevin decision 2026-10-02: every device that uses the voice companion is on
// Tailscale, and r4 reaches the gateway over loopback, so the companion's
// /llm/v1 path gets the same source check as the door and /llm/acquire:
// loopback and the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) pass, a LAN
// (or any other) source is refused with 403 unless it carries a valid bearer.
process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";

let up, upUrl, srv, appUrl, acquired = [], forwarded = 0, remote = "127.0.0.1";

before(async () => {
  up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { forwarded++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  const router = llmRouterRouter({
    acquireFn: async (pid) => { acquired.push(pid); return true; },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers: {} }),
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

function chat(headers = {}) {
  acquired = []; forwarded = 0;
  return fetch(`${appUrl}/llm/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "qwen3.5-4b", messages: [{ role: "user", content: "hi" }] }),
  });
}

async function withRemote(addr, fn) {
  const prev = remote;
  remote = addr;
  try { return await fn(); } finally { remote = prev; }
}

test("a LAN source is refused on the companion path, before anything is acquired or forwarded", async () => {
  for (const addr of ["10.0.0.50", "::ffff:10.0.0.50", "192.168.1.20", "172.17.0.2", "100.128.0.1", "8.8.8.8"]) {
    await withRemote(addr, async () => {
      const r = await chat();
      assert.equal(r.status, 403, addr);
      assert.equal((await r.json()).error.code, "DOOR_SOURCE_REFUSED", addr);
      assert.deepEqual(acquired, [], `${addr}: nothing acquired`);
      assert.equal(forwarded, 0, `${addr}: nothing forwarded`);
    });
  }
});

test("loopback and the tailnet CGNAT range (and its IPv6 ULA) are accepted on the companion path", async () => {
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.64.20.1", "100.127.255.254", "fd7a:115c:a1e0::1"]) {
    await withRemote(addr, async () => {
      const r = await chat();
      assert.equal(r.status, 200, addr);
      assert.deepEqual(acquired, ["crow-voice"], `${addr}: the fast model was warmed`);
      assert.equal(forwarded, 1, `${addr}: forwarded upstream`);
    });
  }
});

test("a LAN source with a valid bearer is accepted; a wrong bearer is not", async () => {
  await withRemote("10.0.0.50", async () => {
    assert.equal((await chat({ authorization: "Bearer good-token" })).status, 200);
    assert.equal((await chat({ authorization: "Bearer nope" })).status, 403);
  });
});

test("GET /llm/v1/models follows the same rule; the health probes stay open", async () => {
  await withRemote("10.0.0.50", async () => {
    assert.equal((await fetch(`${appUrl}/llm/v1/models`)).status, 403);
    assert.equal((await fetch(`${appUrl}/llm/health`)).status, 200);
    assert.equal((await fetch(`${appUrl}/llm`)).status, 200);
  });
  await withRemote("100.64.20.1", async () => {
    assert.equal((await fetch(`${appUrl}/llm/v1/models`)).status, 200);
  });
});

test("I1: loopback carrying a forwarded public client is refused on the companion path, the door and /llm/acquire", async () => {
  const xff = { "x-forwarded-for": "168.171.4.20, 100.64.20.3" };
  const r = await chat(xff);
  assert.equal(r.status, 403);
  assert.equal(forwarded, 0);
  assert.equal((await fetch(`${appUrl}/llm/p/anything/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...xff }, body: "{}" })).status, 403);
  const a = await fetch(`${appUrl}/llm/acquire`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "8.8.8.8" }, body: JSON.stringify({ provider: "crow-chat" }) });
  assert.equal(a.status, 403);
  assert.equal((await chat({ forwarded: "for=203.0.113.9" })).status, 403);
});

test("I1: loopback with a tailnet forwarded client is allowed; plain loopback is allowed", async () => {
  assert.equal((await chat({ "x-forwarded-for": "100.64.20.4" })).status, 200);
  assert.equal(forwarded, 1);
  assert.equal((await chat()).status, 200);
});

test("I1: a public forwarded client with a valid bearer is still allowed (the bearer is the credential)", async () => {
  assert.equal((await chat({ "x-forwarded-for": "8.8.8.8", authorization: "Bearer good-token" })).status, 200);
});
