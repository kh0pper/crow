/**
 * Live browser tile, Task 6, LIVE: the tile in a real Perch thread, in a real
 * headless Chrome (tests/fixtures/headless-chrome.mjs, port mode) at phone
 * width.
 *
 * The page is the real Perch hub (panel handler + layout). Its tile traffic
 * goes through the REAL perch-api router behind the REAL dashboardAuth and
 * csrfMiddleware: the browser carries Serve's headers (serveHeaders, set on
 * every request with Network.setExtraHTTPHeaders, this process standing in for
 * tailscaled via actAsServe) and a real session row in a scratch crow.db.
 * Server side only the engine and its watcher are stubs: a fake session whose
 * subscribe() feeds the SSE, and a watcher that holds the lease for that
 * session and serves one real JPEG frame. The final shot is a real
 * storeShot() row + file, served by the real workspace route; Delete goes
 * through the real DELETE route. The rest of the hub's fetches (roost,
 * transcript, options) are scripted, as in perch-hub-render.test.js.
 *
 * Asserts: Live with the hostname and the frame, then Done with the shot;
 * ≥ 44 px targets at 390 px; no sideways scroll; light and dark; polls carry
 * vw and stop after done; Delete removes the tile, the row and the file; a
 * reload puts a kept shot back after its anchor chip, never as a file card.
 *
 * CROW_REQUIRE_TEST_CHROME=1 makes a missing Chrome a failure, not a skip.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // the browser's loopback socket stands in for tailscaled's

const dir = mkdtempSync(join(tmpdir(), "perch-browser-tile-live-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;
const ROOT = join(dir, "delivered");

const SID = "perchlive-b7111e00";
const BOT = "r4-assistant";
const HOST = "tile.example.test";
const API = "/dashboard/perch-api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome = null, server = null, base = "", shots = null, createDbClient = null;
let JPEG_B64 = "";
let transcriptEvents = [];
const subs = new Set();
const polls = [];
const watcher = {
  holder: SID,
  frame: null,
  enabled: () => true,
  async isHolder(sid) { return this.holder === sid; },
  async available() { return true; },
  async frameAfter(sid, after, { timeoutMs, signal, phone }) {
    polls.push({ sid, after, phone, at: Date.now() });
    if (this.frame && this.frame.seq > after) return this.frame;
    await new Promise((r) => {
      const t = setTimeout(r, Math.min(timeoutMs, 400));
      signal?.addEventListener("abort", () => { clearTimeout(t); r(); });
    });
    return this.frame && this.frame.seq > after ? this.frame : null;
  },
};
const engine = {
  async get(sid) { return sid === SID ? { sessionId: SID, botId: BOT, threadId: SID, outputsDir: null } : null; },
  async subscribe(sid, cb) { subs.add(cb); return () => subs.delete(cb); },
  get browserWatcher() { return watcher; },
  get browserTakeOver() { return takeOver; },
};
const emit = (ev) => { for (const cb of subs) cb(ev); };

function scripted(req, res) {
  const url = req.url.split("?")[0];
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.endsWith("/roost")) {
    return send(200, { birds: [{ id: BOT, name: "R4 Assistant", perch_attached: true, state: "working",
      sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, label: null }] }], occupiedCardIds: [] });
  }
  if (url.endsWith("/transcript")) return send(200, { events: transcriptEvents });
  if (url.endsWith("/options")) return send(200, { models: [], thinkingLevels: ["off"], current: null, source: "child" });
  return send(200, {});
}
/** The four tile routes (and the shot's workspace url) go to the real router. */
const REAL = /^\/dashboard\/perch-api\/interactive\/[^/]+\/(events|files\/history|browser\/frame|browser-shots\/[^/]+|workspace\/.+)$/;
/** Task 7: the take-over routes go to the real router too. */
const REAL_TAKE_OVER = /^\/dashboard\/perch-api\/browser\/(take-over|hand-back|heartbeat|state)$/;
const LEASE = join(dir, "browser-lease");
let leaseMod = null, takeOver = null;

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken, dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')").run(hashToken("live-sess"));
  c.close();
  const delivered = await import("../servers/shared/perch-delivered.js");
  delivered.registerDeliveredRoot(ROOT);
  shots = await import("../servers/gateway/browser-tile/shots.js");
  ({ createDbClient } = await import("../servers/db.js"));
  leaseMod = await import("../servers/shared/browser-lease.js");
  const { createTakeOver } = await import("../servers/gateway/browser-tile/take-over.js");
  // The real controller on a real lease dir; its onHeld is the engine's operator frame.
  takeOver = createTakeOver({ dir: () => LEASE, onHeld: (held) => emit({ type: "browser", phase: "operator", anchor: "call_to1", held }) });
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const path = req.url.split("?")[0];
    if (REAL.test(path) || REAL_TAKE_OVER.test(path)) return next();
    if (path === "/proxy/browser/vnc.html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>vnc</title><body>vnc stand-in</body>"); return; }
    if (path.startsWith("/dashboard/perch-api/") || path.startsWith("/api/") || path.startsWith("/dashboard/bot-board-api/")) return scripted(req, res);
    if (path === "/dashboard/perch") {
      const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
      return Promise.resolve(perchHubPanel.handler(req, res, { lang: "en", layout })).then((html) => {
        if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
      });
    }
    res.writeHead(404); res.end();
  });
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(perchInteractiveApiRouter(dashboardAuth, { engine: () => engine, annotate: async (m) => m, providerModels: () => [], piProviders: () => null }));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); server.close(); }
  takeOver?.close();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One tab on its own DevTools socket. */
async function openTab() {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    let v;
    while (Date.now() < end) { try { v = await evaluate(expression); } catch (e) { v = String(e.message).slice(0, 200); } if (v === true || (v && typeof v === "object")) return v; await sleep(100); }
    throw new Error("timed out waiting for: " + expression + " (last " + JSON.stringify(v) + ")");
  };
  const close = async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); };
  return { id: tab.id, send, evaluate, waitFor, close };
}

async function storeShot(anchor) {
  const db = createDbClient();
  try {
    return await shots.storeShot(db, { sessionId: SID, botId: BOT, threadId: SID },
      { buf: Buffer.from(JPEG_B64, "base64"), hostname: HOST, anchor, now: new Date() });
  } finally { db.close(); }
}
const shotRows = () => { const c = new Database(join(dir, "crow.db")); const r = c.prepare("SELECT id FROM perch_session_files WHERE kind='browser_shot'").all(); c.close(); return r; };

const MEASURE = `(function(){
  var t=document.querySelector('.ph-btile'); if(!t) return null;
  function box(sel){ var n=t.querySelector(sel); if(!n||n.hidden) return null; var r=n.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right),left:Math.round(r.left)}; }
  var r=t.getBoundingClientRect();
  return { phase:t.getAttribute('data-phase'), host:t.querySelector('.bt-host').textContent,
    state:t.querySelector('.bt-state').textContent,
    imgSrc:(t.querySelector('.bt-img').getAttribute('src')||'').slice(0,40),
    imgLoaded:t.querySelector('.bt-img').naturalWidth>0 && t.querySelector('.bt-img').complete,
    take:box('.bt-take'), del:box('.bt-del'), frame:box('.bt-frame'),
    tile:{left:Math.round(r.left),right:Math.round(r.right)},
    vw:innerWidth, docScroll:document.documentElement.scrollWidth, bodyScroll:document.body.scrollWidth,
    trScroll:(function(){ var tr=document.getElementById('perch-transcript'); return tr.scrollWidth-tr.clientWidth; })(),
    header:(function(){ var h=document.getElementById('perch-browser-status'); return h.hidden?null:h.textContent; })(),
    afterChip:(function(){ var p=t.previousElementSibling; return p?p.getAttribute('data-call'):null; })(),
    bg:getComputedStyle(t).backgroundColor };
})()`;

test("live: Live with the hostname and a real frame, then Done with the shot; 44 px targets at 390 px, no sideways scroll, light and dark; Delete; reload in place", { timeout: 90_000 }, async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  // A real JPEG from this Chrome.
  {
    const cap = await openTab();
    try {
      await cap.send("Page.enable");
      await cap.send("Page.navigate", { url: "data:text/html,<body style='margin:0;background:%23264;height:100vh'></body>" });
      await sleep(300);
      JPEG_B64 = (await cap.send("Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 320, height: 200, scale: 1 } })).data;
    } finally { await cap.close(); }
  }
  assert.ok(JPEG_B64.length > 100);
  watcher.frame = { seq: 1, jpegB64: JPEG_B64, w: 320, h: 200 };
  transcriptEvents = [{ type: "message", timestamp: new Date(Date.now() - 60000).toISOString(), message: { role: "user", content: "look this up" } }];

  const tab = await openTab();
  try {
    await tab.send("Network.enable");
    await tab.send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.com") });
    await tab.send("Network.setCookie", { name: "crow_session", value: "live-sess", url: base });
    await tab.send("Network.setCookie", { name: "crow_csrf", value: "tok-live", url: base });
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await tab.send("Page.enable");
    await tab.send("Page.navigate", { url: base + "/dashboard/perch#" + SID });
    await tab.waitFor("document.body.getAttribute('data-view')==='chat'");
    const until = Date.now() + 10000;
    while (!subs.size && Date.now() < until) await sleep(50);
    assert.ok(subs.size >= 1, "the real SSE route subscribed (auth passed)");
    await tab.waitFor("document.querySelector('#perch-transcript .entry.user')!==null");

    // The bot's first browser call, then the gateway's live frame.
    emit({ type: "tool", name: "mcp__browser__crow_browser_navigate", phase: "start", isError: false, toolCallId: "call_live1", argsText: "{}" });
    emit({ type: "browser", phase: "live", anchor: "call_live1", domain: HOST, gen: 1 });
    await tab.waitFor("(function(){ var i=document.querySelector('.ph-btile[data-phase=\"live\"] .bt-img'); return !!i&&i.naturalWidth>0; })()");
    const liveM = await tab.evaluate(MEASURE);
    assert.equal(liveM.phase, "live");
    assert.equal(liveM.state, "Live");
    assert.equal(liveM.host, HOST);
    assert.match(liveM.imgSrc, /^data:image\/jpeg;base64,/);
    assert.equal(liveM.afterChip, "call_live1", "right after its anchor chip");
    assert.equal(liveM.header, "Using the browser · " + HOST);
    assert.ok(liveM.take && liveM.take.h >= 44 && liveM.take.w >= 44, "Take over ≥ 44 px: " + JSON.stringify(liveM.take));
    assert.ok(liveM.frame.h >= 44);
    assert.equal(liveM.del, null, "no Delete while live");
    assert.ok(liveM.docScroll <= liveM.vw && liveM.bodyScroll <= liveM.vw, "no sideways page scroll: " + JSON.stringify(liveM));
    assert.ok(liveM.trScroll <= 0, "the transcript does not scroll sideways");
    assert.ok(liveM.tile.left >= 0 && liveM.tile.right <= liveM.vw);
    assert.ok(polls.length >= 1, "the real frame route reached the watcher");
    assert.ok(polls.every((p) => p.sid === SID && p.phone === true), "vw=390 is a phone viewer");
    const lightBg = liveM.bg;

    // dark: the same tokens, the dark card
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(150);
    const darkBg = (await tab.evaluate(MEASURE)).bg;
    assert.notEqual(darkBg, lightBg, "the tile follows the dark theme");
    assert.equal(darkBg, "rgb(27, 36, 43)", "dark --card");
    assert.equal(lightBg, "rgb(255, 255, 255)", "light --card");
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

    // Turn end: the gateway stored the final shot, then said done.
    const shot = await storeShot("call_live1");
    emit({ type: "tool", name: "mcp__browser__crow_browser_navigate", phase: "end", isError: false, toolCallId: "call_live1", resultText: "ok" });
    emit({ type: "browser", phase: "done", anchor: "call_live1", domain: HOST,
      shot: { id: shot.id, url: API + "/interactive/" + SID + "/workspace/" + encodeURIComponent(shot.name) }, note: null });
    await tab.waitFor("(function(){ var i=document.querySelector('.ph-btile[data-phase=\"done\"] .bt-img'); return !!i&&i.complete&&i.naturalWidth>0; })()");
    const doneM = await tab.evaluate(MEASURE);
    assert.equal(doneM.state, "Done");
    assert.equal(doneM.host, HOST);
    assert.match(doneM.imgSrc, /^\/dashboard\/perch-api\/interactive\//, "the shot, through the real workspace route");
    assert.ok(doneM.imgLoaded);
    assert.equal(doneM.take, null, "no Take over on a frozen tile");
    assert.ok(doneM.del && doneM.del.h >= 44 && doneM.del.w >= 44, "Delete ≥ 44 px: " + JSON.stringify(doneM.del));
    assert.equal(doneM.header, null, "the header line is gone");
    assert.ok(doneM.docScroll <= doneM.vw && doneM.trScroll <= 0, "no sideways scroll when done");
    await sleep(600);
    const n = polls.length;
    await sleep(1500);
    assert.equal(polls.length, n, "no frame polls after done");

    // Delete screenshot: the real DELETE (CSRF header), then the tile leaves.
    await tab.evaluate("document.querySelector('.ph-btile .bt-del').click()");
    await tab.waitFor("document.querySelector('.ph-btile')===null");
    assert.equal(shotRows().length, 0, "the row is gone");
    assert.equal(readdirSync(join(ROOT, SID)).length, 0, "and its file");

    // Reload: a kept shot comes back frozen right after its anchor chip.
    const kept = await storeShot("call_hist");
    transcriptEvents = [
      { type: "message", timestamp: new Date(Date.now() - 60000).toISOString(), message: { role: "user", content: "again" } },
      { type: "message", timestamp: new Date(Date.now() - 50000).toISOString(), message: { role: "toolResult", toolCallId: "call_hist", toolName: "mcp__browser", content: "ok" } },
      { type: "message", timestamp: new Date(Date.now() - 40000).toISOString(), message: { role: "assistant", content: "done" } },
    ];
    await tab.send("Page.reload");
    await tab.waitFor("(function(){ var i=document.querySelector('.ph-btile[data-phase=\"done\"] .bt-img'); return !!i&&i.complete&&i.naturalWidth>0; })()");
    const re = await tab.evaluate(MEASURE);
    assert.equal(re.afterChip, "call_hist", "in its turn's place");
    assert.equal(re.host, HOST, "the host from the shot's name");
    assert.equal(await tab.evaluate("document.querySelectorAll('.filecard').length"), 0, "never a sent-file card");
    assert.equal(await tab.evaluate("document.querySelectorAll('.ph-btile').length"), 1);
    void kept;
  } finally {
    await tab.close();
  }
});

test("live: Take over opens the sheet with the noVNC iframe; Hand back closes it; the waiting bot's next call runs; a real targetId reached the lease", { timeout: 90_000 }, async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const { installLeaseGuard } = await import("../bundles/browser/server/lease-guard.js");
  const { EventEmitter } = await import("node:events");
  // The bot's own page, and the guard's targetId read the way server.js does
  // it: Target.getTargetInfo on that page's own CDP session.
  const botPage = await openTab();
  const fake = { handlers: {}, tool(name, ...rest) { this.handlers[name] = rest.at(-1); } };
  installLeaseGuard(fake, {
    lease: leaseMod, dir: LEASE, env: { PI_BOT_PERCH_SESSION_ID: SID, PI_BOT_ID: BOT }, pid: process.pid,
    getTargetId: async () => (await botPage.send("Target.getTargetInfo")).targetInfo.targetId,
    proc: new EventEmitter(), exit: () => {},
  });
  const acted = [];
  fake.tool("crow_browser_click", "stub", {}, async (a) => { acted.push(a); return { content: [{ type: "text", text: "clicked" }] }; });
  const botCall = (a) => fake.handlers.crow_browser_click(a, {});
  const tab = await openTab();
  try {
    assert.match((await botCall({ n: 1 })).content.map((c) => c.text).join(" "), /clicked/);
    const l1 = await leaseMod.readLease(LEASE);
    assert.equal(l1.holder.sessionId, SID);
    assert.equal(l1.targetId, botPage.id, "a real Chrome targetId was recorded in the lease");

    watcher.frame = { seq: 1, jpegB64: JPEG_B64, w: 320, h: 200 };
    transcriptEvents = [{ type: "message", timestamp: new Date(Date.now() - 60000).toISOString(), message: { role: "user", content: "log in for me" } }];
    await tab.send("Network.enable");
    await tab.send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.com") });
    await tab.send("Network.setCookie", { name: "crow_session", value: "live-sess", url: base });
    await tab.send("Network.setCookie", { name: "crow_csrf", value: "tok-live", url: base });
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await tab.send("Page.enable");
    await tab.send("Page.navigate", { url: base + "/dashboard/perch#" + SID });
    await tab.waitFor("document.body.getAttribute('data-view')==='chat'");
    await tab.waitFor("document.querySelector('#perch-transcript .entry.user')!==null");
    emit({ type: "tool", name: "mcp__browser__crow_browser_click", phase: "start", isError: false, toolCallId: "call_to1", argsText: "{}" });
    emit({ type: "browser", phase: "live", anchor: "call_to1", domain: HOST, gen: 1 });
    await tab.waitFor("document.querySelector('.ph-btile[data-phase=\"live\"] .bt-take')!==null");

    // Take over: the sheet, the real route, the operator's holding.
    await tab.evaluate("document.querySelector('.ph-btile[data-phase=\"live\"] .bt-take').click()");
    await tab.waitFor("(function(){ var f=document.querySelector('.ph-tosheet iframe.to-vnc'); return !!f; })()");
    const sheet = await tab.evaluate(`(function(){
      var s=document.querySelector('.ph-tosheet'), r=s.getBoundingClientRect(), f=s.querySelector('iframe.to-vnc'), b=s.querySelector('.to-back').getBoundingClientRect();
      return { left:r.left, top:r.top, w:Math.round(r.width), h:Math.round(r.height), vw:innerWidth, vh:innerHeight,
        src:f.getAttribute('src'), fh:Math.round(f.getBoundingClientRect().height), host:s.querySelector('.to-host').textContent,
        back:{ w:Math.round(b.width), h:Math.round(b.height) }, backText:s.querySelector('.to-back').textContent,
        docScroll:document.documentElement.scrollWidth };
    })()`);
    assert.deepEqual([sheet.left, sheet.top, sheet.w, sheet.h], [0, 0, sheet.vw, sheet.vh], "full screen: " + JSON.stringify(sheet));
    assert.equal(sheet.src, "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false");
    assert.ok(sheet.fh > 300, "the viewer fills the sheet: " + sheet.fh);
    assert.equal(sheet.host, HOST);
    assert.equal(sheet.backText, "Hand back");
    assert.ok(sheet.back.h >= 44 && sheet.back.w >= 44, "Hand back ≥ 44 px: " + JSON.stringify(sheet.back));
    assert.ok(sheet.docScroll <= sheet.vw);
    assert.equal(takeOver.state(), "held");
    assert.equal((await leaseMod.readLease(LEASE)).holder.kind, "operator");
    await tab.waitFor("document.getElementById('perch-browser-status').textContent==='Waiting for you'");
    assert.equal(await tab.evaluate("(function(){ var e=document.querySelector('.ph-tosheet .to-status'); return e.hidden?null:e.textContent; })()"), "Waiting for you", "the sheet says the bot is paused");
    await tab.waitFor("(function(){ var f=document.querySelector('iframe.to-vnc'); try{ return f.contentDocument&&f.contentDocument.body&&f.contentDocument.body.textContent==='vnc stand-in'; }catch(e){ return false; } })()");

    // The bot calls while the operator has it: it waits, never acts.
    let waited = null;
    const pending = botCall({ n: 2 }).then((r) => { waited = r; });
    await sleep(1200);
    assert.equal(waited, null, "the bot waits on the operator");
    assert.equal(acted.length, 1);

    // Hand back: the real route, the sheet closes, the bot's wait ends without acting.
    await tab.evaluate("document.querySelector('.ph-tosheet .to-back').click()");
    await tab.waitFor("document.querySelector('.ph-tosheet')===null");
    await pending;
    assert.equal(waited.content[0].text, "The operator handed the browser back; call again.");
    assert.equal(acted.length, 1, "the waited call never acted");
    assert.equal(takeOver.state(), "idle");
    assert.equal((await leaseMod.readLease(LEASE)).holder, null);
    await tab.waitFor("document.getElementById('perch-browser-status').textContent==='Using the browser · " + HOST + "'");
    const next = await botCall({ n: 3 });
    assert.match(next.content.map((c) => c.text).join(" "), /clicked/, "the bot's next call runs");
    assert.equal(acted.length, 2);
    assert.equal((await leaseMod.readLease(LEASE)).targetId, botPage.id);

    // Leaving the sheet (a reload) keeps the holding, and "You have the browser · Hand back" stays reachable.
    await tab.evaluate("document.querySelector('.ph-btile[data-phase=\"live\"] .bt-take').click()");
    await tab.waitFor("document.querySelector('.ph-tosheet iframe.to-vnc')!==null");
    await tab.send("Page.reload");
    await tab.waitFor("(function(){ var b=document.getElementById('perch-browser-mine'); return !!b&&!b.hidden; })()");
    assert.equal(await tab.evaluate("document.querySelector('.ph-tosheet')"), null, "the sheet did not come back by itself");
    assert.equal(takeOver.state(), "held", "a reload never hands back");
    const mine = await tab.evaluate("(function(){ var b=document.getElementById('perch-browser-mine'), r=b.getBoundingClientRect(); return { text:b.textContent, h:Math.round(r.height) }; })()");
    assert.equal(mine.text, "You have the browser · Hand back");
    assert.ok(mine.h >= 44);
    await tab.evaluate("document.getElementById('perch-browser-mine').click()");
    await tab.waitFor("document.getElementById('perch-browser-mine').hidden===true");
    assert.equal(takeOver.state(), "idle");
    assert.equal((await leaseMod.readLease(LEASE)).holder, null);
  } finally {
    await tab.close();
    await botPage.close();
  }
});
