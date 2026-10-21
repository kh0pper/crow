// ncFetch and pooled keep-alive sockets the server already closed. Seen as the T10-I3 calendar flake: a long repeat
// expansion kept the event loop busy past the server's 5 s keep-alive timeout, so the next request went out on a
// socket the server had already closed and failed with ECONNRESET ("workspace_unreachable").
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ncFetch } from "../bundles/workspace/server/nc/http.js";

const cfg = { user: "crow-bot", appPassword: "pw" };
// fetch hands a socket back to its pool a few loop turns after the body is read; give it that time (in the real
// failure the socket had sat idle for seconds)
const idle = async (res) => { await res.text(); await new Promise((r) => setTimeout(r, 50)); };
/** A fresh origin per case (so the client pool starts empty) whose second request on a kept-alive socket is reset:
 *  the server already dropped that socket and the client did not notice in time. */
async function staleSocketServer(fn) {
  const seen = []; const perSocket = new WeakMap();
  const server = http.createServer((req, res) => {
    const n = (perSocket.get(req.socket) || 0) + 1; perSocket.set(req.socket, n);
    seen.push(`${req.method} #${n}`);
    if (n > 1) { req.socket.resetAndDestroy(); return; }
    req.resume(); req.on("end", () => res.end("ok"));
  });
  server.keepAliveTimeout = 60000;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${server.address().port}/`, seen); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

for (const method of ["PROPFIND", "REPORT", "GET", "PUT", "DELETE"]) {
  test(`${method} that lands on a socket the server already closed is resent once, on a fresh connection`, () => staleSocketServer(async (base, seen) => {
    await idle(await ncFetch(cfg, "GET", base)); // leaves an idle kept-alive socket in the pool
    const r = await ncFetch(cfg, method, base, { body: method === "PUT" ? "x" : undefined });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ["GET #1", `${method} #2`, `${method} #1`]);
  }));
}

for (const method of ["POST", "MOVE"]) {
  test(`${method} is never resent: a reset is workspace_unreachable and the request went out once`, () => staleSocketServer(async (base, seen) => {
    await idle(await ncFetch(cfg, "GET", base));
    await assert.rejects(ncFetch(cfg, method, base, { body: method === "POST" ? "x" : undefined }), { code: "workspace_unreachable" });
    assert.deepEqual(seen, ["GET #1", `${method} #2`]);
  }));
}

test("a server that is down stays workspace_unreachable (refused connections are not retried)", async () => {
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${dead.address().port}/`; await new Promise((r) => dead.close(r));
  await assert.rejects(ncFetch(cfg, "GET", url), { code: "workspace_unreachable" });
});
