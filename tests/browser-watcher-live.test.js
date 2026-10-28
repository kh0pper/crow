/**
 * Live browser tile, Task 5, LIVE: the gateway's read-only watcher against a
 * real headless Chrome (tests/fixtures/headless-chrome.mjs, port mode) playing
 * this instance's crow-browser.
 *
 * A scratch CROW_HOME lists `browser` in installed.json and its bundle .env
 * names the fixture's DevTools port, so the watcher resolves the endpoint the
 * production way. The test plays the bot: it opens its own tab, drives it on
 * its own DevTools connection (navigate, a wide viewport) and holds the lease
 * with that tab's targetId, as the browser MCP server does. A second tab stays
 * on about:blank and must never be the one watched.
 *
 * Asserts: a real attach to exactly the leased targetId, a JPEG screencast
 * frame, the domain read from CDP, a final shot ≤ 1280 px wide from a 1600 px
 * page, and no URL or hostname anywhere in the captured log output.
 *
 * CROW_REQUIRE_TEST_CHROME=1 makes a missing Chrome a failure, not a skip.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const dir = mkdtempSync(join(tmpdir(), "browser-watcher-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
delete process.env.CROW_DB_PATH;

const SID = "perchlive-live0001";
const HOST = "tile.example.test";
const PATH = "/secret-path/account?token=s3cr3t";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome = null, server = null, port = 0, W = null, lease = null;
const logLines = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };

const PAGE = `<!doctype html><html><head><title>tile</title>
<style>html,body{margin:0;height:100%;background:linear-gradient(90deg,#c33,#36c)}h1{font:48px sans-serif;color:#fff;padding:40px}</style>
</head><body><h1>The bot's page</h1></body></html>`;

before(async () => {
  chrome = await startHeadlessChrome({ extraArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  if (!chrome) return;
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const cdpPort = new URL(chrome.cdp).port;
  mkdirSync(join(HOME, "bundles", "browser"), { recursive: true });
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "browser" }]));
  writeFileSync(join(HOME, "bundles", "browser", ".env"), `CROW_BROWSER_CDP_PORT=${cdpPort}\nCROW_BROWSER_CONTAINER_NAME=crow-browser-live-test\n`);
  W = await import("../servers/gateway/browser-tile/watcher.js");
  lease = await import("../servers/shared/browser-lease.js");
  // capture everything this process prints while the watcher runs
  for (const k of Object.keys(realConsole)) console[k] = (...a) => { logLines.push(a.join(" ")); };
});

after(async () => {
  Object.assign(console, realConsole);
  if (server) await new Promise((r) => server.close(r));
  if (chrome) await chrome.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** The bot's own tab and DevTools connection (the MCP server's side, not the watcher's). */
async function botTab() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  return { targetId: t.id, cdp, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}

test("live: the watcher attaches to the leased page, streams a JPEG, reads the domain, shoots ≤ 1280 px", async (t) => {
  if (!chrome) { t.skip("no headless Chrome (set CROW_REQUIRE_TEST_CHROME=1 to require one)"); return; }
  assert.equal(await W.resolveCdpUrl({ crowHome: HOME }), chrome.cdp, "the endpoint comes from this instance's .env");

  const bot = await botTab();
  const leases = [];
  const w = W.createWatcher({
    crowHome: HOME,
    log: (m) => console.log("[perch-interactive] " + m),
    onLease: (l, extra) => leases.push({ gen: l.gen, ...extra }),
  });
  try {
    assert.equal(w.enabled(), true);
    await bot.cdp("Page.enable");
    await bot.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await bot.cdp("Page.navigate", { url: `http://${HOST}:${port}${PATH}` });
    await sleep(300);

    const dirL = join(HOME, "browser-lease");
    const holder = { kind: "bot", sessionId: SID, botId: "botty" };
    const got = await lease.acquire(dirL, holder);
    assert.equal(got.ok, true);
    const l = await lease.beginCall(dirL, holder, { callId: "c1", pid: process.pid, targetId: bot.targetId });

    // the domain, from CDP, via the 1 s lease poll
    for (let i = 0; i < 60 && !leases.some((x) => x.domain === HOST); i++) await sleep(100);
    assert.ok(leases.some((x) => x.domain === HOST), "the lease watch reported the leased page's hostname");
    assert.equal(w.hostname(), HOST);

    // a screencast frame
    let frame = null;
    for (let i = 0; i < 8 && !frame; i++) frame = await w.frameAfter(SID, 0, { timeoutMs: 2000 });
    assert.ok(frame, "a frame arrived");
    assert.equal(w._attachedForTest(), bot.targetId, "attached to exactly the leased targetId");
    const jpeg = Buffer.from(frame.jpegB64, "base64");
    assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8", "a JPEG");
    assert.ok(frame.w > 0 && frame.w <= 640 && frame.h <= 400, `screencast size ${frame.w}x${frame.h}`);
    assert.deepEqual(W.jpegSize(jpeg), { w: frame.w, h: frame.h });

    // another session never gets this page
    assert.equal(await w.frameAfter("perchlive-other001", 0, { timeoutMs: 200 }), null);

    // the final shot: a 1600 px page comes back ≤ 1280 px wide
    const shot = await w.captureFinal(SID, { gen: l.gen });
    assert.ok(Buffer.isBuffer(shot), "a final shot");
    const size = W.jpegSize(shot);
    assert.ok(size && size.w <= 1280 && size.w >= 1200, `final shot ${size && size.w}x${size && size.h}`);
    assert.equal(await w.captureFinal(SID, { gen: l.gen + 1 }), null, "never at another gen");

    // the lease is released: the screencast stops
    await lease.endCall(dirL, holder, { callId: "c1" });
    await lease.release(dirL, SID);
    for (let i = 0; i < 30 && w._attachedForTest(); i++) await sleep(100);
    assert.equal(w._attachedForTest(), null, "detached once nobody holds the browser");
  } finally {
    w.close();
    await bot.close();
  }

  const out = logLines.join("\n");
  for (const needle of [HOST, "secret-path", "s3cr3t", "http://", "ws://", "127.0.0.1", "devtools/"]) {
    assert.equal(out.includes(needle), false, "no '" + needle + "' in the log output");
  }
});
