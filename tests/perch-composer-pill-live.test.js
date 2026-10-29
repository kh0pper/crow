// The new-mode composer pill, LIVE (R1.2 PR 2, Task 4): the real Perch page in
// the real new shell, in a private headless Chrome, against a scripted
// perch-api. Static half: tests/perch-hub-render.test.js. Skips cleanly
// without Chrome. Every wait is a poll on a page condition.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-11111111";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
const streams = new Set();
function emit(type, data) {
  for (const res of streams) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    return send(res, 200, {
      birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run" }] }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (url.endsWith("/transcript")) return send(res, 200, { events: [] });
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/commands")) return send(res, 200, { commands: [{ name: "compact", description: "Compact the context" }] });
  if (url.endsWith("/models")) return send(res, 200, { models: [], default: null });
  return send(res, 200, {});
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    if (req.url.startsWith("/api/")) return send(res, 200, { items: [] });
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    if (!req.url.startsWith("/dashboard/perch")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title><p>blank</p>");
    }
    req.crowMode = { mode: "new" };
    req.crowScope = { all: true };
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en",
      variant: "shell", shell: { scope: { all: true }, projects: [], tab: "chat", getPanel: () => null } });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

after(async () => {
  for (const res of streams) res.end();
  if (server) server.close();
  if (chrome) await chrome.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(width, height) {
  const t = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
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
  const evalIn = async (expression) => {
    const out = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const waitFor = async (expression, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await evalIn(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(100);
    }
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch#${SID}` });
  await waitFor("document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent",
    "the chat to open");
  const mouse = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  };
  return {
    cdp, evalIn, waitFor,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    click: async (elId) => {
      const { x, y } = JSON.parse(await evalIn(`(function(){ var b=document.getElementById(${JSON.stringify(elId)}).getBoundingClientRect();
        return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2}); })()`));
      await mouse(x, y);
    },
    clickAt: mouse,
    key: async (key) => {
      const k = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
      return key;
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const SHOWN = (id) => `(function(){ var e=document.getElementById('${id}'); return !!e&&!e.hidden&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0; })()`;
const H = (id) => `document.getElementById('${id}').getBoundingClientRect().height`;

test("input grows to 5 lines then scrolls, resets after send", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    const one = await s.evalIn(H("perch-input"));
    assert.ok(one >= 44 && one < 60, "one line is about 44px, got " + one);
    const set = (n) => s.evalIn(`(function(){ var i=document.getElementById('perch-input'); i.focus();
      i.value=${JSON.stringify(Array.from({ length: n }, (_, k) => "line " + k).join("\n"))};
      i.dispatchEvent(new Event('input',{bubbles:true})); return i.getBoundingClientRect().height; })()`);
    const three = await set(3);
    const five = await set(5);
    const nine = await set(9);
    assert.ok(three > one && five > three, `it grows: ${one} < ${three} < ${five}`);
    assert.ok(Math.abs(nine - five) < 4, `it stops at five lines: five=${five} nine=${nine}`);
    assert.ok(await s.evalIn("(function(){ var i=document.getElementById('perch-input'); return i.scrollHeight>i.clientHeight+2; })()"),
      "beyond five lines it scrolls inside itself");
    await s.evalIn("(function(){ var i=document.getElementById('perch-input'); i.value='hello'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await s.click("perch-send");
    await s.waitFor(`document.getElementById('perch-input').value===''&&${H("perch-input")}<${one + 4}`, "the pill to shrink after send");
  } finally { await s.close(); }
});

test("Send flips to Steer during a turn and Stop stays reachable", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    assert.equal(await s.evalIn(SHOWN("perch-abort")), false, "no Stop while idle");
    // Wait for the stream to be open, then push a turn-start state frame.
    const end = Date.now() + 8000;
    while (!streams.size && Date.now() < end) await sleep(100);
    assert.ok(streams.size, "the stream opened");
    emit("state", { turnInFlight: true });
    await s.waitFor(`document.getElementById('perch-send').textContent==='Steer'&&${SHOWN("perch-abort")}`, "Steer + Stop");
    const r = await s.json(`(function(){ var a=document.getElementById('perch-abort').getBoundingClientRect(), b=document.getElementById('perch-send').getBoundingClientRect();
      return JSON.stringify({aw:a.width,ah:a.height,bh:b.height,right:a.right,vw:document.documentElement.clientWidth,sw:document.documentElement.scrollWidth}); })()`);
    assert.ok(r.ah >= 44 && r.bh >= 44, "44px targets");
    assert.ok(r.right <= r.vw && r.sw <= r.vw, "Stop is on screen with no horizontal scroll");
    emit("state", { turnInFlight: false });
    await s.waitFor(`document.getElementById('perch-send').textContent==='Send'&&!${SHOWN("perch-abort")}`, "back to Send");
  } finally { await s.close(); }
});

test('"/" opens the command menu above the pill', async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    await s.evalIn("(function(){ var i=document.getElementById('perch-input'); i.focus(); i.value='/'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await s.waitFor(SHOWN("perch-cmdmenu"), "the command menu");
    const r = await s.json(`(function(){ var m=document.getElementById('perch-cmdmenu').getBoundingClientRect(), p=document.querySelector('#perch-composer .pill-row').getBoundingClientRect();
      return JSON.stringify({mb:m.bottom,pt:p.top}); })()`);
    assert.ok(r.mb <= r.pt + 1, `the menu sits above the pill (${r.mb} <= ${r.pt})`);
  } finally { await s.close(); }
});

test("plus menu: opens, Escape closes and returns focus, outside tap closes, hidden when nothing to offer", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    assert.equal(await s.evalIn(SHOWN("perch-plus")), true, "attach is always available, so + shows");
    assert.equal(await s.evalIn(SHOWN("perch-plus-menu")), false);
    await s.click("perch-plus");
    await s.waitFor(SHOWN("perch-plus-menu"), "the menu");
    assert.equal(await s.evalIn("document.getElementById('perch-plus').getAttribute('aria-expanded')"), "true");
    assert.equal(await s.evalIn(SHOWN("perch-attach")), true);
    assert.ok(await s.evalIn(H("perch-attach")) >= 44, "44px target");
    assert.equal(await s.evalIn(SHOWN("perch-dictate")), false, "no mic without a passing probe");
    await s.key("Escape");
    await s.waitFor(`!${SHOWN("perch-plus-menu")}&&document.activeElement.id==='perch-plus'`, "Escape closes and refocuses +");
    await s.click("perch-plus");
    await s.waitFor(SHOWN("perch-plus-menu"), "reopened");
    await s.clickAt(200, 120);
    await s.waitFor(`!${SHOWN("perch-plus-menu")}&&document.getElementById('perch-plus').getAttribute('aria-expanded')==='false'`, "an outside tap closes");
    // It reacts when dictation's probe later shows the mic, and hides when nothing is left.
    await s.evalIn("(function(){ var m=document.getElementById('perch-dictate'); m.hidden=false; })()");
    assert.equal(await s.evalIn(SHOWN("perch-plus")), true);
  } finally { await s.close(); }
});

test("plus menu: a disclosure — opening focuses its first item, choosing Attach hands focus to the composer", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    await s.cdp("Page.setInterceptFileChooserDialog", { enabled: true });   // the picker never opens a real dialog
    assert.equal(await s.evalIn("document.getElementById('perch-plus').hasAttribute('aria-haspopup')"), false);
    await s.click("perch-plus");
    await s.waitFor(`${SHOWN("perch-plus-menu")}&&document.activeElement.id==='perch-attach'`, "focus on the first visible item");
    await s.click("perch-attach");
    await s.waitFor(`!${SHOWN("perch-plus-menu")}&&document.activeElement.id==='perch-input'`,
      "the menu closes and focus lands in the composer, not on the hidden entry");
  } finally { await s.close(); }
});

test("plus menu: an ask closes it", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    for (const end = Date.now() + 5000; !streams.size && Date.now() < end;) await sleep(100);
    await s.click("perch-plus");
    await s.waitFor(SHOWN("perch-plus-menu"), "the menu");
    emit("ask_user", { requestId: "q-plus", method: "confirm", title: "Keep going?" });
    await s.waitFor("!!document.querySelector('#perch-ask .ask-card')", "the ask card");
    await s.waitFor(`!${SHOWN("perch-plus-menu")}&&document.getElementById('perch-plus').getAttribute('aria-expanded')==='false'`,
      "the ask closes the + menu");
  } finally { await s.close(); }
});

test("390 px: the pill fits with no horizontal scroll, targets at least 44 px", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(390, 800);
  try {
    const r = await s.json(`(function(){
      function h(id){ return document.getElementById(id).getBoundingClientRect(); }
      var row=document.querySelector('#perch-composer .pill-row').getBoundingClientRect();
      return JSON.stringify({sw:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth,
        rowL:row.left,rowR:row.right,plusW:h('perch-plus').width,plusH:h('perch-plus').height,sendH:h('perch-send').height,
        sendR:h('perch-send').right,inputH:h('perch-input').height}); })()`);
    assert.ok(r.sw <= r.vw, `no horizontal scroll (${r.sw} <= ${r.vw})`);
    assert.ok(r.rowL >= 0 && r.rowR <= r.vw, "the pill is inside the viewport");
    for (const k of ["plusW", "plusH", "sendH", "inputH"]) assert.ok(r[k] >= 44, `${k} >= 44 (got ${r[k]})`);
  } finally { await s.close(); }
});
