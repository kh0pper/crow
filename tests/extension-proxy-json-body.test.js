/**
 * The extension proxy must forward JSON request bodies.
 *
 * The gateway installs a GLOBAL `express.json()` (index.js — "Body parsing with
 * size limit", skipped only for /llm and /s/:surface/feedback) long before
 * boot/late-mounts.js mounts the extension proxy at app root. By the time the
 * proxy runs, that parser has already drained `req` into `req.body`, so piping
 * `req` upstream sends the original Content-Length with ZERO bytes behind it.
 * The backend then waits for a body that never arrives and never answers.
 *
 * The user-visible shape of that is the worst kind: the request HANGS. No
 * error, no rejected promise, no log line on either side — a client doing
 * `fetch(...).then(r => r.json())` simply never resolves. That is what "press
 * Spawn on Crow and nothing happens" was: POST /proxy/perch-hub/api/hub/spawn
 * hanging forever, while the very same POST straight to the hub on 127.0.0.1
 * answered in under 2ms.
 *
 * It bites JSON only. `express.json()` claims a request by Content-Type, so the
 * hub's urlencoded login form and every GET were unaffected — which is exactly
 * why the page rendered fine and only the API calls died.
 *
 * These run the REAL proxy router against a REAL stub upstream, with the real
 * global parser in front of it, because the bug lives in the interaction of
 * those three and is invisible to any one of them alone.
 *
 * ⚠ Every request here is bounded by a timeout. Without the fix these tests
 * FAIL on that timeout rather than hanging the suite forever.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-body-"));
process.env.CROW_HOME = CROW_HOME;

after(() => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

const { default: extensionProxyFactory } =
  await import("../servers/gateway/routes/extension-proxy.js");

/** Write installed.json + a manifest so getProxiedExtensions() sees the bundle. */
function installWebUiBundle(id, webUI) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", webUI }));
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle" }]));
}

/**
 * Upstream that reads the raw request stream the way the vendored perch hub
 * does (`hub/server.mjs` accumulates `data` and answers on `end`) — so a body
 * that never arrives produces a hang here too, not a tidy error.
 */
async function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body, contentType: req.headers["content-type"] ?? null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echoed: body }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, port: server.address().port };
}

/** Gateway with the global body parser in front of the real proxy router. */
async function startGateway() {
  const app = express();
  // Mirrors servers/gateway/index.js: a global express.json() that every path
  // except /llm and /s/:surface/feedback passes through.
  const jsonParser = express.json({ limit: "1mb" });
  const hasOwnParser = (p) => p.startsWith("/llm") || /^\/s\/[^/]+\/feedback$/.test(p);
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : jsonParser(req, res, next)));

  const { router } = extensionProxyFactory((req, res, next) => next());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, port: server.address().port };
}

/**
 * Close a server AND drop any keep-alive sockets. The proxy keeps an upstream
 * connection open, so a bare close() never resolves and the file would hang
 * after the assertions had already decided the outcome.
 */
function shutdown(server) {
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
}

/** POST with a hard timeout — the pre-fix failure mode is an infinite hang. */
function post(port, path, payload, { contentType = "application/json", timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": contentType, "content-length": Buffer.byteLength(data) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`request hung for ${timeoutMs}ms — the body never reached the backend`));
    });
    req.end(data);
  });
}

// ---------------------------------------------------------------------------

test("a JSON POST through the extension proxy delivers its body to the backend", async () => {
  const up = await startUpstream();
  installWebUiBundle("perch-hub", { port: up.port });
  const gw = await startGateway();
  try {
    const payload = { cwd: "/home/kh0pp/r4-tehcy", prompt: "hello" };
    const res = await post(gw.port, "/proxy/perch-hub/api/hub/spawn", payload);

    assert.equal(res.status, 200, "the proxied POST must complete, not hang");
    assert.equal(up.seen.length, 1, "the backend must have served exactly one request");
    assert.equal(up.seen[0].url, "/api/hub/spawn", "the /proxy/<id> prefix is stripped before the hub sees it");
    assert.deepEqual(JSON.parse(up.seen[0].body), payload,
      "the backend must receive the ORIGINAL body — a drained stream sends Content-Length with no bytes");
  } finally {
    shutdown(gw.server); shutdown(up.server);
  }
});

test("the forwarded Content-Length matches the bytes actually sent", async () => {
  // A body re-written with the wrong length is the other half of this bug:
  // too long and the backend blocks waiting for the remainder, too short and
  // the JSON arrives truncated. Non-ASCII makes byte-length differ from
  // string-length, which is precisely where a naive re-write goes wrong.
  const up = await startUpstream();
  installWebUiBundle("perch-hub", { port: up.port });
  const gw = await startGateway();
  try {
    const payload = { cwd: "/home/kh0pp/r4-tehcy", note: "café ☕ über — naïve" };
    const res = await post(gw.port, "/proxy/perch-hub/api/hub/spawn", payload);

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(up.seen[0].body), payload,
      "a multi-byte body must arrive whole — neither truncated nor left blocking");
  } finally {
    shutdown(gw.server); shutdown(up.server);
  }
});

test("a non-JSON POST body is still forwarded untouched", async () => {
  // The global parser only claims application/json, so urlencoded bodies were
  // never drained and reached the backend by simply being piped. Whatever
  // fixes the JSON case must not regress the path that always worked — the
  // hub's own login form is urlencoded.
  const up = await startUpstream();
  installWebUiBundle("perch-hub", { port: up.port });
  const gw = await startGateway();
  try {
    const res = await post(gw.port, "/proxy/perch-hub/login", "token=abc123",
      { contentType: "application/x-www-form-urlencoded" });

    assert.equal(res.status, 200);
    assert.equal(up.seen[0].body, "token=abc123", "urlencoded bodies must pass through unchanged");
  } finally {
    shutdown(gw.server); shutdown(up.server);
  }
});
