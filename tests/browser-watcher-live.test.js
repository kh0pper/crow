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

// A red block at the top (say, an account summary above the fold), a long gap,
// then a green block far down the page that the bot scrolls to.
const PAGE = `<!doctype html><html><head><title>tile</title>
<style>html{scrollbar-width:none}html,body{margin:0;background:#fff}#top{height:1500px;background:#d00000}#gap{height:3000px}#mark{height:2500px;background:#00b000}</style>
</head><body><div id="top"></div><div id="gap"></div><div id="mark"></div></body></html>`;

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

/** Decode a JPEG in a scratch tab and sample its pixels → { w, h, samples: [[r,g,b]…] }. */
async function samplePixels(tab, buf) {
  const expr = `(async () => {
    const img = new Image(); img.src = "data:image/jpeg;base64,${buf.toString("base64")}"; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const px = (x, y) => Array.from(g.getImageData(x | 0, y | 0, 1, 1).data.slice(0, 3));
    const w = img.width, h = img.height;
    return JSON.stringify({ w, h, samples: [px(5, 5), px(w / 2, h / 2), px(w - 5, h - 5), px(5, h - 5), px(w - 5, 5)] });
  })()`;
  const out = await tab.cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return JSON.parse(out.result.value);
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
    assert.ok(shot && Buffer.isBuffer(shot.buf), "a final shot");
    assert.equal(shot.hostname, HOST, "the hostname read from CDP with the shot");
    const size = W.jpegSize(shot.buf);
    assert.ok(size && size.w <= 1280 && size.w >= 1200, `final shot ${size && size.w}x${size && size.h}`);
    assert.equal(await w.captureFinal(SID, { gen: l.gen + 1 }), null, "never at another gen");

    // a scrolled HiDPI page (1000 CSS px at 2x = 2000 device px): the shot is
    // what is on screen — the green block far down — never the document top
    await bot.cdp("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false });
    await bot.cdp("Runtime.evaluate", { expression: "document.getElementById('mark').scrollIntoView(); window.scrollY" });
    await sleep(400);
    const scrolled = await w.captureFinal(SID, { gen: l.gen });
    assert.ok(scrolled, "a shot of the scrolled page");
    const decoder = await botTab();
    try {
      const px = await samplePixels(decoder, scrolled.buf);
      assert.ok(px.w <= 1280 && px.w >= 1000 && Math.abs(px.w / px.h - 1000 / 700) < 0.02, `hidpi shot ${px.w}x${px.h}: the whole viewport, ≤ 1280`);
      for (const [r, g, b] of px.samples) {
        assert.ok(g > 120 && r < 90 && b < 90, `the scrolled-to green block fills the shot (saw ${r},${g},${b}; all ${JSON.stringify(px)})`);
      }
    } finally { await decoder.close(); }

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
