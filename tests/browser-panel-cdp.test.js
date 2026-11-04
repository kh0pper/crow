/**
 * Browser CDP gate, PR 1: the dashboard's status probes.
 *
 * Both the panel page and GET /api/browser/status used to shell out to curl with the CDP URL,
 * which could never carry a token without putting it on a command line. They now use
 * server/cdp-probe.js: 2xx is connected, 401 is "CDP token rejected", and — while the
 * container is still the ungated one — an unauthenticated 2xx raises the rebuild warning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "feedface".repeat(8); // 64 hex chars: the shape hex32 mints
const WARNING = "The browser's debugging port is not gated yet; the next browser update closes it.";

// The panel resolves instance.js / cdp-probe.js from an INSTALLED copy (CROW_HOME), and those
// resolve the app repo through CROW_APP_ROOT; build that shape in a scratch dir.
process.env.CROW_APP_ROOT = ROOT;

function makeHome({ port, token = null }) {
  const home = mkdtempSync(join(tmpdir(), "crow-browser-panel-"));
  const server = join(home, "bundles", "browser", "server");
  mkdirSync(server, { recursive: true });
  for (const f of ["instance.js", "app-root.js", "cdp-probe.js"]) copyFileSync(join(ROOT, "bundles", "browser", "server", f), join(server, f));
  const lines = ["CROW_BROWSER_CDP_PORT=" + port, "CROW_BROWSER_CONTAINER_NAME=crow-browser-panel-test"];
  if (token) lines.push("CROW_BROWSER_CDP_TOKEN=" + token);
  writeFileSync(join(home, "bundles", "browser", ".env"), lines.join("\n") + "\n");
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "browser", type: "bundle" }]));
  return home;
}

/** A fake DevTools endpoint; `auth` decides the status for a request's Authorization header. */
async function withEndpoint(auth, fn) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const header = req.headers.authorization || null;
    seen.push({ url: req.url, header });
    res.writeHead(auth(header), { "content-type": "application/json" });
    res.end(JSON.stringify({ Browser: "Test/1.0" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(srv.address().port, seen);
  } finally {
    try { srv.closeAllConnections(); } catch { /* nothing open */ }
    await new Promise((r) => srv.close(r));
  }
}

async function withHome(home, fn) {
  const prev = { CROW_HOME: process.env.CROW_HOME, CROW_BROWSER_CDP_PORT: process.env.CROW_BROWSER_CDP_PORT, CROW_BROWSER_CDP_TOKEN: process.env.CROW_BROWSER_CDP_TOKEN };
  process.env.CROW_HOME = home;
  delete process.env.CROW_BROWSER_CDP_PORT;
  delete process.env.CROW_BROWSER_CDP_TOKEN;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function renderPanel() {
  const { default: panel } = await import("../bundles/browser/panel/browser.js");
  const html = await panel.handler({ query: {}, headers: {} }, {}, { db: {}, layout: (o) => o.content, appRoot: ROOT, lang: "en" });
  return String(html);
}

async function fetchStatus() {
  const { default: browserRouter } = await import("../bundles/browser/panel/routes.js");
  const app = express();
  app.use(browserRouter((req, res, next) => next()));
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try {
    const r = await fetch("http://127.0.0.1:" + srv.address().port + "/api/browser/status");
    return await r.json();
  } finally {
    try { srv.closeAllConnections(); } catch { /* nothing open */ }
    await new Promise((r) => srv.close(r));
  }
}

const gated = (header) => (header === `Bearer ${TOKEN}` ? 200 : 401);

test("panel: a gated endpoint answering 2xx reads as Connected, with no warning", async () => {
  await withEndpoint(gated, async (port, seen) => {
    await withHome(makeHome({ port, token: TOKEN }), async () => {
      const html = await renderPanel();
      assert.match(html, /Connected/);
      assert.ok(!html.includes(WARNING), "no rebuild warning when the door really is gated");
      assert.ok(!html.includes(TOKEN), "the token is never rendered into the page");
    });
    assert.deepEqual(seen.map((s) => s.header), [null, `Bearer ${TOKEN}`], "the ungated probe carries no token; the gated one does");
  });
});

test("panel: while the container is ungated, an unauthenticated 2xx raises the rebuild warning", async () => {
  await withEndpoint(() => 200, async (port, seen) => {
    await withHome(makeHome({ port, token: TOKEN }), async () => {
      const html = await renderPanel();
      assert.ok(html.includes(WARNING), "the operator is told the port is not gated yet");
      assert.match(html, /Connected/, "today's browser still answers");
      assert.ok(!html.includes(TOKEN));
    });
    assert.deepEqual(seen.map((s) => s.header), [null, `Bearer ${TOKEN}`], "the warning's probe never puts the token anywhere");
  });
});

test("panel: 401 reads as not connected (CDP token rejected)", async () => {
  await withEndpoint(() => 401, async (port) => {
    await withHome(makeHome({ port, token: TOKEN }), async () => {
      const html = await renderPanel();
      assert.match(html, /Not connected \(CDP token rejected\)/);
      assert.ok(!html.includes(WARNING), "401 means it IS gated: nothing to warn about");
      assert.ok(!html.includes(TOKEN));
    });
  });
});

test("panel: with no token, the probe is the plain unauthenticated request, and no warning", async () => {
  await withEndpoint(() => 200, async (port, seen) => {
    await withHome(makeHome({ port }), async () => {
      const html = await renderPanel();
      assert.match(html, /Connected/);
      assert.ok(!html.includes(WARNING), "nothing is configured to warn about");
    });
    assert.deepEqual(seen.map((s) => s.header), [null], "one request, no header");
  });
});

test("panel: an endpoint that is down reads as Disconnected", async () => {
  // A port nothing listens on: bind then close to get one.
  const srv = http.createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  await withHome(makeHome({ port, token: TOKEN }), async () => {
    const html = await renderPanel();
    assert.match(html, /Disconnected/);
    assert.ok(!html.includes(WARNING));
  });
});

test("GET /api/browser/status: the same probe, reported as data", async () => {
  await withEndpoint(gated, async (port) => {
    await withHome(makeHome({ port, token: TOKEN }), async () => {
      assert.deepEqual(await fetchStatus(), { containerRunning: false, cdpConnected: true, cdpTokenRejected: false, cdpUngated: false });
    });
  });
  await withEndpoint(() => 401, async (port) => {
    await withHome(makeHome({ port, token: TOKEN }), async () => {
      assert.deepEqual(await fetchStatus(), { containerRunning: false, cdpConnected: false, cdpTokenRejected: true, cdpUngated: false });
    });
  });
  await withEndpoint(() => 200, async (port) => {
    await withHome(makeHome({ port, token: TOKEN }), async () => {
      assert.deepEqual(await fetchStatus(), { containerRunning: false, cdpConnected: true, cdpTokenRejected: false, cdpUngated: true });
    });
  });
});