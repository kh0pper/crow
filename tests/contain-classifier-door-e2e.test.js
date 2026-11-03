// A contained bot's bash-auto classifier, end to end: the URL containedClassifierBlock builds, a
// header-less POST (pi-lab's bot-bash-auto sends no Authorization and refuses redirects), through
// the real egress relay (its socket carries the relay mark, a loopback address), into the real
// /llm/p provider door, out to a stub classifier that answers SAFE.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";
import { startEgressRelay } from "../scripts/pi-bots/pi_egress.mjs";
import { containedClassifierBlock } from "../scripts/pi-bots/pi_contain_agent.mjs";

const ROW = "classifier-row";
const MODEL = "safety-small";
let up, srv, relay, gwPort, upSeen = [];
const scratch = mkdtempSync(join(tmpdir(), "classifier-e2e-"));

before(async () => {
  up = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      upSeen.push({ path: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "SAFE" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  const providers = { [ROW]: { baseUrl: upUrl, apiKey: "none", models: [{ id: MODEL }], gpuPolicy: { runtime: "native", owner: "me", port: 1 } } };
  // No remoteAddressFn: the door judges the REAL socket address, which is the relay's mark.
  const router = llmRouterRouter({
    acquireFn: async () => true,
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers }),
    recordUsageFn: async () => {},
  });
  const app = express();
  app.use(router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  gwPort = srv.address().port;
  relay = await startEgressRelay({ dir: join(scratch, "relay"), botId: "classifier-bot", gatewayPort: gwPort, log: () => {} });
});
after(async () => {
  try { await relay?.close(); } catch {}
  srv?.closeAllConnections?.(); up?.closeAllConnections?.(); srv?.close(); up?.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("a header-less classifier POST through the relay reaches the provider door and gets SAFE", async () => {
  // The block a contained bot gets: the provider door on its own gateway.
  const block = containedClassifierBlock(
    { url: "http://127.0.0.1:8011/v1", model: MODEL, timeout_ms: 5000 },
    { ok: true, providerId: ROW, model: MODEL, url: "http://127.0.0.1:8011/v1", source: "auto" },
    // The row in the shape the bridge reads it (providerRowToObject): a bundle-served local model.
    { gatewayPort: gwPort, rows: [{ id: ROW, provider_type: "openai", baseUrl: "http://127.0.0.1:8011/v1", models: [{ id: MODEL }], host: "local", disabled: false, bundleId: "classifier-bundle" }], log: () => {} },
  );
  assert.ok(block, "a contained bot keeps its classifier");
  const url = new URL(block.url.replace(/\/+$/, "") + "/chat/completions");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(Number(url.port), gwPort);

  // pi-lab's request shape: JSON body, Content-Type only, no Authorization, no redirect allowed.
  const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ls -la" }], max_tokens: 4 });
  const reply = await new Promise((resolve, reject) => {
    const s = connect(relay.socketPath);
    let out = "";
    s.on("connect", () => s.write(`PORT ${gwPort}\nPOST ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${gwPort}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
    s.on("data", (d) => { out += d; });
    s.on("end", () => resolve(out));
    s.on("error", reject);
    setTimeout(() => { s.destroy(); resolve(out); }, 8000);
  });
  const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(reply) || [])[1]);
  assert.equal(status, 200, "the door answered directly (no redirect, no auth refusal): " + reply.slice(0, 200));
  assert.match(reply, /SAFE/, "the classifier's verdict came back");
  assert.equal(upSeen.length, 1, "the stub classifier was reached once");
  assert.equal(upSeen[0].body.model, MODEL);
});
