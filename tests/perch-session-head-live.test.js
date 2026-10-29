// The new-mode session head, LIVE (R1.2 PR 2 final review): the real Perch
// page in the real new shell, in a private headless Chrome, against a
// scripted perch-api with a session filed to a project. Phone 390 px (en and
// es): Back is a 44 px "←" icon with an accessible name, and the bot name and
// "# project · day" line are not clipped. Desktop 1280 px: Back shows for a
// filed session (it goes to the project home) and the subtitle is not
// clipped by the ident button's -8px pull. Skips cleanly without Chrome.
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
const PROJECT = { id: 1, slug: "backyard-garden", name: "Backyard garden plan" };   // 20 characters

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
let filed = true;
const streams = new Set();
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return send(res, 200, {
      birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run",
          projectId: filed ? PROJECT.id : null, lastActivityAt: now }] }],
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
  if (url.endsWith("/commands")) return send(res, 200, { commands: [] });
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
    const lang = /[?&]lang=es\b/.test(req.url) ? "es" : "en";
    req.crowMode = { mode: "new" };
    req.crowScope = { all: true };
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang,
      variant: "shell", shell: { scope: { all: true }, projects: [], tab: "chat", getPanel: () => null } });
    const db = { execute: async () => ({ rows: [PROJECT] }) };
    const html = await perchHubPanel.handler(req, res, { lang, layout, db });
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

async function tab(width, height, lang = "en") {
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
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch${lang === "es" ? "?lang=es" : ""}#${SID}` });
  await waitFor("document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent" +
    "&&!!document.getElementById('perch-ident-sub').textContent", "the chat and its head to open");
  return {
    evalIn, waitFor,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const HEAD = `(function(){
  function box(e){ var b=e.getBoundingClientRect(); return {l:b.left,r:b.right,w:b.width,h:b.height}; }
  function shown(e){ return !!e&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0; }
  var back=document.getElementById('perch-back'), name=document.getElementById('perch-bot-name'),
      sub=document.getElementById('perch-ident-sub'), btn=document.getElementById('perch-ident-btn');
  var head=btn.closest('.perch-head'), hb=box(head), bb=box(btn), sb=box(sub);
  return JSON.stringify({ backShown:shown(back), back:box(back), backName:back.getAttribute('aria-label'),
    backText:back.textContent.trim(), name:name.textContent,
    nameClipped:name.scrollWidth>name.clientWidth, sub:sub.textContent,
    subClipped:sub.scrollWidth>sub.clientWidth, subW:sb.w,
    btnInHead:bb.l>=hb.l-0.5&&bb.r<=hb.r+0.5, subInBtn:sb.r<=bb.r+0.5,
    sw:document.documentElement.scrollWidth, vw:innerWidth });
})()`;

for (const lang of ["en", "es"]) {
  test(`390 px (${lang}): Back is a 44 px icon with its name; the bot name and the project line are not clipped`, async (t) => {
    if (!available) return t.skip("no headless Chrome");
    filed = true;
    const s = await tab(390, 844, lang);
    try {
      const m = await s.json(HEAD);
      assert.equal(m.backShown, true);
      assert.equal(m.backText, "←");
      assert.equal(m.backName, lang === "es" ? "Volver al inicio del proyecto" : "Back to the project home");
      assert.ok(m.back.w >= 44 && m.back.h >= 44 && m.back.w <= 48, `Back is a 44 px icon (${m.back.w}x${m.back.h})`);
      assert.equal(m.sub, "# " + PROJECT.name + " · " + (lang === "es" ? "hoy" : "today"));
      assert.equal(m.name, "R4 Assistant");
      assert.equal(m.nameClipped, false, "the bot name is not clipped");
      assert.equal(m.subClipped, false, `the project line is not clipped (${m.subW}px)`);
      assert.equal(m.btnInHead, true, "the ident button stays inside the head row");
      assert.ok(m.sw <= m.vw, "no horizontal scroll");
    } finally { await s.close(); }
  });
}

test("1280 px: a filed session shows Back to the project home, and the project line is not clipped", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  filed = true;
  const s = await tab(1280, 900);
  try {
    const m = await s.json(HEAD);
    assert.equal(m.backShown, true, "Back exists on desktop for a filed session");
    assert.equal(m.backName, "Back to the project home");
    assert.ok(m.back.w >= 44 && m.back.h >= 44);
    assert.equal(m.subClipped, false, `the project line is not clipped (${m.subW}px)`);
    assert.equal(m.subInBtn, true, "the subtitle ends inside its button");
    assert.equal(m.nameClipped, false);
  } finally { await s.close(); }
});

test("1280 px: an unfiled session has no Back (the Sessions list beside it is the way back); 390 px it goes to the list", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  filed = false;
  try {
    const d = await tab(1280, 900);
    try {
      const m = await d.json(HEAD);
      assert.equal(m.backShown, false);
    } finally { await d.close(); }
    const p = await tab(390, 844);
    try {
      const m = await p.json(HEAD);
      assert.equal(m.backShown, true);
      assert.equal(m.backName, "Back to the sessions");
      await p.evalIn("document.getElementById('perch-back').click(); 1");
      await p.waitFor("document.body.getAttribute('data-view')!=='chat'", "the list");
    } finally { await p.close(); }
  } finally { filed = true; }
});
