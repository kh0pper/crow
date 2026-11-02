/**
 * The extension proxy never lets http-proxy-middleware subscribe its own "upgrade" listener.
 *
 * With `ws: true`, http-proxy-middleware 3 calls server.on('upgrade', handleUpgrade) on the
 * FIRST HTTP request it proxies. That listener matches every path (default pathFilter "/") and
 * proxies the upgrade before setupWebSocket's origin/session checks finish, and it turns the
 * explicit `.upgrade()` into a no-op. So after one page load, any WebSocket upgrade, with no
 * cookie, reached the extension backend. Real router, real upstream, real sockets.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-noauto-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = CROW_HOME;   // the session check never opens a real database
process.env.CROW_DB_PATH = join(CROW_HOME, "crow.db");
after(() => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

const { default: extensionProxyFactory } = await import("../servers/gateway/routes/extension-proxy.js");

/** Every socket a server accepts, so teardown can end upgraded ones too (server.close waits on them). */
function track(server) { const set = new Set(); server.on("connection", (s) => { set.add(s); s.on("close", () => set.delete(s)); }); return () => { for (const s of set) s.destroy(); }; }

/** An upstream that serves HTTP and records every upgrade it is handed (and answers 101). */
async function startUpstream() {
  const upgrades = [];
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("upstream ok"); });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.end();
  });
  const kill = track(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, upgrades, kill, port: server.address().port };
}

/** A raw upgrade request; resolves with the first response line (or "" if the socket just closes). */
function rawUpgrade(port, path, headers = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
    });
    let buf = "";
    const done = () => resolve(buf.split("\r\n")[0] || "");
    s.on("data", (c) => { buf += c; if (buf.includes("\r\n")) { s.destroy(); done(); } });
    s.on("close", done);
    s.on("error", done);
    s.setTimeout(3000, () => { s.destroy(); done(); });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

test("after a proxied page load, a cookieless upgrade (to the extension or anywhere) never reaches the backend; the explicit post-auth upgrade still does", async () => {
  const up = await startUpstream();
  const dir = join(CROW_HOME, "bundles", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id: "demo", name: "demo", type: "bundle", webUI: { port: up.port } }));
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "demo", type: "bundle" }]));

  let proxy = null;
  const { createProxyMiddleware } = await import("http-proxy-middleware");
  const { router, setupWebSocket } = extensionProxyFactory((req, res, next) => next(), {
    createProxy: (opts) => (proxy = createProxyMiddleware(opts)),
  });
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  const killGateway = track(server);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  setupWebSocket(server);
  // Stand-in for "the auth checks passed": a second gateway route that calls the explicit upgrade.
  server.on("upgrade", (req, socket, head) => { if (req.url === "/authorized/demo") { req.url = "/proxy/demo/ws-ok"; proxy.upgrade(req, socket, head); } });
  try {
    const before = server.listenerCount("upgrade");
    const page = await get(port, "/proxy/demo/");
    assert.equal(page.body, "upstream ok", "the page is proxied");
    assert.equal(server.listenerCount("upgrade"), before, "the proxied page load subscribed no upgrade listener of its own");

    await rawUpgrade(port, "/proxy/demo/ws");          // no cookie: setupWebSocket refuses it
    await rawUpgrade(port, "/blog/anything");          // a path no extension owns
    assert.deepEqual(up.upgrades, [], "neither upgrade reached the backend");

    const line = await rawUpgrade(port, "/authorized/demo");
    assert.match(line, /101/, "the explicit upgrade (after auth) is proxied");
    assert.deepEqual(up.upgrades, ["/ws-ok"]);
  } finally {
    killGateway(); up.kill();
    await new Promise((r) => server.close(r));
    await new Promise((r) => up.server.close(r));
  }
});
