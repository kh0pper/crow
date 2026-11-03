/**
 * Containment PR 6, layer 2 at the gateway: a socket the egress relay opened
 * carries the relay mark, and no /internal route answers it — whatever the
 * relay's own door allowlist did or did not catch (servers/gateway/
 * middleware/internal-guard.js).
 *
 * Real sockets: the client binds the source address with localAddress, which is
 * exactly how the relay marks its upstream connections. The guard is about the
 * SOURCE, never a header, so nothing a caller sends can undo it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { refuseRelayedInternal } from "../servers/gateway/middleware/internal-guard.js";
import { RELAY_SOURCE_V4 } from "../servers/shared/bot-doors.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let srv, port;
let hits = [];

before(async () => {
  const app = express();
  app.use(refuseRelayedInternal);
  // Deliberately the same path for both: a normal router, mounted as the real
  // actor-sign route is (router.post on an app-root router).
  app.all("/internal/actor-sign", (req, res) => { hits.push(req.path); res.json({ ok: true }); });
  app.all("/board/mcp", (req, res) => { hits.push(req.path); res.json({ ok: true }); });
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
after(async () => {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(() => r()));
});

function ask(path, localAddress, method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, localAddress,
      headers: { "content-type": "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    if (method === "POST") req.write("{}");
    req.end();
  });
}

test("a relayed socket is refused on /internal, whatever it spells", async () => {
  hits = [];
  for (const path of ["/internal/actor-sign", "/INTERNAL/actor-sign", "//internal/actor-sign",
    "/internal/actor-sign?x=1", "/Internal/Actor-Sign", "/%69nternal/actor-sign", "/%49NTERNAL/actor-sign", "/%zz/internal"]) {
    const r = await ask(path, RELAY_SOURCE_V4);
    assert.equal(r.status, 404, path);
    assert.deepEqual(JSON.parse(r.body), { error: "not found" }, path);
  }
  assert.deepEqual(hits, [], "the route handler never ran");
});

test("a plain loopback socket still reaches /internal (the guard is about the mark, not the path)", async () => {
  hits = [];
  const r = await ask("/internal/actor-sign", "127.0.0.1");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.deepEqual(hits, ["/internal/actor-sign"]);
});

test("a relayed socket is not refused off /internal: the doors keep working", async () => {
  hits = [];
  const r = await ask("/board/mcp", RELAY_SOURCE_V4, "GET");
  assert.equal(r.status, 200);
  assert.deepEqual(hits, ["/board/mcp"]);
});

test("the gateway mounts the guard before every router", () => {
  const index = readFileSync(join(ROOT, "servers/gateway/index.js"), "utf8");
  const guard = index.indexOf("app.use(refuseRelayedInternal)");
  assert.ok(guard > 0, "refuseRelayedInternal is app.use'd in servers/gateway/index.js");
  const funnel = index.indexOf("app.use(rejectFunneledMiddleware())");
  assert.ok(funnel > 0 && guard > funnel, "mounted early, right after the funnel gate");
  const mounts = index.indexOf("mountMcpServers(app");
  assert.ok(mounts > 0 && guard < mounts, "before mountMcpServers, which mounts the actor-sign router");
  const mcpMounts = readFileSync(join(ROOT, "servers/gateway/boot/mcp-mounts.js"), "utf8");
  assert.ok(mcpMounts.includes("app.use(actorSignRouter("), "the actor-sign router is mounted from mountMcpServers");
});