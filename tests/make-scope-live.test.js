// The Make tab from a card's chat, LIVE (R1.2 PR 3): in a new-mode session
// that has a card, the shell's Make tab opens "This card"; when the session
// closes (or has no card) it goes back to the server's link. Skips cleanly
// without Chrome.
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
let withCard = true;
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
          projectId: PROJECT.id, lastActivityAt: now }] }],
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
  if (url.endsWith("/card")) return send(res, 200, withCard ? { card: { id: 42, title: "Plan the beds", lane: "doing", projectId: PROJECT.id, href: "/dashboard/bot-board?card=42" } } : { card: null });
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
      variant: "shell", shell: { scope: { all: true }, projects: [], tab: "chat", getPanel: (id) => (id === "make" ? {} : null) } });
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


const MAKE = "document.querySelector('a.shell-tab[data-shell-tab=\"make\"]').getAttribute('href')";

test("in a card session the Make tab opens This card", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  withCard = true;
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const s = await tab(w, h);
    try {
      await s.waitFor("document.getElementById('perch-card-line')&&!document.getElementById('perch-card-line').hidden", "the card line");
      assert.equal(await s.evalIn(MAKE), "/dashboard/make?scope=card:42&project=" + PROJECT.slug, `${w}px`);
    } finally { await s.close(); }
  }
});

test("make tab resets when the card session closes; no card, no change", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  withCard = true;
  const s = await tab(390, 844);
  try {
    await s.waitFor(MAKE + ".indexOf('scope=card:42')>-1", "Make scoped to the card");
    await s.evalIn("location.hash=''; 1");
    await s.waitFor("document.body.getAttribute('data-view')!=='chat'", "the list");
    await s.waitFor(MAKE + "==='/dashboard/make'", "Make back to the server link");
  } finally { await s.close(); }
  withCard = false;
  const n = await tab(1280, 900);
  try {
    await sleep(400);
    assert.equal(await n.evalIn(MAKE), "/dashboard/make", "a session without a card leaves Make alone");
  } finally { await n.close(); withCard = true; }
});
