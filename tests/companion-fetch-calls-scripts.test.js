/**
 * bundles/companion/scripts/fetch-calls-scripts.sh — the companion gets the Calls
 * extension's browser scripts from the gateway (no host mount of other extensions'
 * folders). Runs the real script with bash + curl against a loopback HTTP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "bundles", "companion", "scripts", "fetch-calls-scripts.sh");

function runScript(out, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile("bash", [SCRIPT, out], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 }, (err) => {
      resolve({ code: err ? (err.code ?? 1) : 0, ms: Date.now() - t0 });
    });
  });
}

function serve(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("Calls on: both scripts are written under <out>/scripts", async () => {
  const srv = await serve((req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=UTF-8");
    if (req.url === "/calls/scripts/crow-calls-webrtc.js") return res.end("window.A=1;");
    if (req.url === "/calls/scripts/crow-calls-panel.js") return res.end("window.B=2;");
    res.statusCode = 404; res.end();
  });
  const out = mkdtempSync(join(tmpdir(), "calls-ok-"));
  const r = await runScript(out, { CROW_CALLS_SCRIPTS_URL: `http://127.0.0.1:${srv.address().port}/calls/scripts` });
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(out, "scripts", "crow-calls-webrtc.js"), "utf8"), "window.A=1;");
  assert.equal(readFileSync(join(out, "scripts", "crow-calls-panel.js"), "utf8"), "window.B=2;");
});

test("Calls off (404): exits 1 at once and leaves no scripts dir (the injector is skipped)", async () => {
  const srv = await serve((req, res) => { res.statusCode = 404; res.end("no"); });
  const out = mkdtempSync(join(tmpdir(), "calls-off-"));
  const r = await runScript(out, { CROW_CALLS_SCRIPTS_URL: `http://127.0.0.1:${srv.address().port}/calls/scripts`, CROW_CALLS_WAIT_SECONDS: "20" });
  srv.close();
  assert.equal(r.code, 1);
  assert.ok(r.ms < 5000, `a 404 must not wait (${r.ms} ms)`);
  assert.equal(existsSync(join(out, "scripts")), false);
});

test("gateway not up: retries, then gives up after the wait", async () => {
  const srv = await serve(() => {});
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // nothing listens on it now
  const out = mkdtempSync(join(tmpdir(), "calls-down-"));
  const r = await runScript(out, { CROW_CALLS_SCRIPTS_URL: `http://127.0.0.1:${port}/calls/scripts`, CROW_CALLS_WAIT_SECONDS: "3" });
  assert.equal(r.code, 1);
  assert.ok(r.ms >= 2500 && r.ms < 15000, `bounded retry (${r.ms} ms)`);
  assert.equal(existsSync(join(out, "scripts")), false);
});

test("an empty 200 body is not accepted", async () => {
  const srv = await serve((req, res) => { res.setHeader("Content-Type", "application/javascript"); res.end(""); });
  const out = mkdtempSync(join(tmpdir(), "calls-empty-"));
  const r = await runScript(out, { CROW_CALLS_SCRIPTS_URL: `http://127.0.0.1:${srv.address().port}/calls/scripts` });
  srv.close();
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(out, "scripts")), false);
});

test("a 200 that is not JavaScript (an HTML page, another listener) is never inlined", async () => {
  const srv = await serve((req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<html>login</html>"); });
  const out = mkdtempSync(join(tmpdir(), "calls-html-"));
  const r = await runScript(out, { CROW_CALLS_SCRIPTS_URL: `http://127.0.0.1:${srv.address().port}/calls/scripts` });
  srv.close();
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(out, "scripts")), false);
});
