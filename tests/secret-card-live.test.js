// The credential card in a Perch chat, LIVE (R1.2 spec §10.1; plan Task 3): the real Perch page
// in the real new shell, in a private headless Chrome, against a scripted perch-api with one
// open password request. At 390x844 and 1280x800:
//   - the card comes back on load from GET /interactive/:sid/secret and fits the column (no
//     sideways scroll, nothing past the right edge); its targets are at least 44 px;
//   - the heading, the "<bot> asks for" line and the help line are the card's own strings, the
//     label written as text (a label holding markup stays text);
//   - Enter password shows an input type=password, autocomplete=new-password, with no name and
//     no value attribute; Not now sends { cancel: true } and leaves the field gone and empty;
//   - Save sends the value in the POST body only (never the URL), and the value never lands in
//     the DOM, web storage or the console; the card then reads "Saved…";
//   - a live `secret_request` frame draws the card, and Turbo's before-cache wipes a typed field.
// A 390 px screenshot of the open card with the field shown is saved to SECRET_CARD_SHOT (if set).
// Skips cleanly without Chrome (CROW_REQUIRE_TEST_CHROME=1 makes that a failure).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-33333333";
const BOT = "Garden assistant";
const ID1 = "a".repeat(32);
const ID2 = "b".repeat(32);
const LABEL = "Seed shop <b>account</b>";
const SECRET = "Tr0ub4dor-and-3-more-words";
const SHOT = process.env.SECRET_CARD_SHOT || "";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
const streams = new Set();
const posts = [];
let openRequest = null;

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return send(res, 200, {
      birds: [{ id: "garden-assistant", name: BOT, perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run", projectId: null, lastActivityAt: now }] }],
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
  if (url.endsWith("/secret") && req.method === "GET") return send(res, 200, openRequest);
  if (url.startsWith("/dashboard/perch-api/secret/") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({ url: req.url, body, csrf: req.headers["x-crow-csrf"] || null });
      let j = {};
      try { j = JSON.parse(body); } catch { /* bad body */ }
      openRequest = null;
      send(res, 200, j.cancel === true ? { ok: true, code: "closed" } : { ok: true, code: "saved" });
    });
    return;
  }
  if (url.endsWith("/transcript")) {
    return send(res, 200, { events: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Sign in to the seed shop for me" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I need the password for that; a card is open." }] } },
    ] });
  }
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/commands")) return send(res, 200, { commands: [] });
  if (url.endsWith("/models")) return send(res, 200, { models: [], default: null });
  return send(res, 200, {});
}
function pushFrame(frame) {
  for (const res of streams) res.write("event: " + frame.type + "\ndata: " + JSON.stringify(frame) + "\n\n");
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { tamagotchiHtml, tamagotchiTrayHtml } = await import("../servers/gateway/dashboard/shared/notifications.js");
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
    const scope = { all: true };
    req.crowScope = scope;
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang,
      headerIcons: tamagotchiHtml(lang, { sheet: true }),
      variant: "shell", shell: { scope, projects: [], tab: "chat", getPanel: () => null, tray: tamagotchiTrayHtml(lang) } });
    const db = { execute: async () => ({ rows: [] }) };
    const html = await perchHubPanel.handler(req, res, { lang, layout, db });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html", "set-cookie": "crow_csrf=tok; Path=/" }); res.end(html); }
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
const SETTLED = "document.fonts.ready.then(function(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(1); }); }); }); })";

async function tab({ width, height, lang = "en" }) {
  const t = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const consoleText = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.consoleAPICalled") consoleText.push(JSON.stringify(m.params.args));
    if (m.method === "Runtime.exceptionThrown") consoleText.push(JSON.stringify(m.params.exceptionDetails));
  });
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
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch${lang === "es" ? "?lang=es" : ""}#${SID}` });
  await waitFor("!!document.querySelector('#perch-secret .secret-card')", "the password card");
  await evalIn(SETTLED);
  return {
    cdp, evalIn, waitFor, consoleText,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    type: (text) => cdp("Input.insertText", { text }),
    shot: async (file) => {
      const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const CARD = `(function(){
  function box(e){ if(!e) return null; var b=e.getBoundingClientRect(); return {l:b.left,r:b.right,t:b.top,b:b.bottom,w:b.width,h:b.height}; }
  var card=document.querySelector('#perch-secret .secret-card');
  var f=card&&card.querySelector('input');
  var buttons=card?[].slice.call(card.querySelectorAll('button')).map(function(b){ return {text:b.textContent, box:box(b)}; }):[];
  return JSON.stringify({ vw:innerWidth, sw:document.documentElement.scrollWidth, card:box(card),
    title:card&&card.querySelector('.secret-title').textContent,
    asks:card&&card.querySelector('.secret-asks')?card.querySelector('.secret-asks').textContent:null,
    help:card&&card.querySelector('.secret-help')?card.querySelector('.secret-help').textContent:null,
    result:card&&card.querySelector('.secret-result')?card.querySelector('.secret-result').textContent:null,
    boldInTitle:!!(card&&card.querySelector('b')),
    buttons:buttons,
    field:f?{ type:f.type, auto:f.getAttribute('autocomplete'), hasName:f.hasAttribute('name'), hasValueAttr:f.hasAttribute('value'),
      value:f.value, box:box(f), font:parseFloat(getComputedStyle(f).fontSize) }:null,
    inputs:document.querySelectorAll('#perch-secret input').length });
})()`;

function assertFits(m, label) {
  const at = (s) => `${s} (${label}) ${JSON.stringify(m)}`;
  assert.ok(m.sw <= m.vw, at("no horizontal scroll"));
  assert.ok(m.card && m.card.l >= 0 && m.card.r <= m.vw + 0.5, at("the card is inside the viewport"));
  for (const b of m.buttons) assert.ok(b.box.h >= 44 && b.box.w >= 44, at(`"${b.text}" is a 44 px target`));
  for (const b of m.buttons) assert.ok(b.box.r <= m.card.r + 0.5, at(`"${b.text}" stays inside the card`));
}

for (const [width, height] of [[390, 844], [1280, 800]]) {
  test(`${width} px card fits, 44 px targets, the field is type=password and empty after close`, async (t) => {
    if (!available) return t.skip("no headless Chrome");
    posts.length = 0;
    openRequest = { id: ID1, label: LABEL, kind: "password", expiresAt: Date.now() + 600000 };
    const s = await tab({ width, height });
    try {
      let m = await s.json(CARD);
      assert.equal(m.title, "🔒 Password for " + LABEL, "the label is text, markup and all");
      assert.equal(m.boldInTitle, false, "no markup from the label");
      assert.equal(m.asks, BOT + " asks for: " + LABEL);
      assert.equal(m.help, "A browser can't block screenshots; enter this where no one is watching.");
      assert.deepEqual(m.buttons.map((b) => b.text), ["Enter password", "Not now"]);
      assert.equal(m.field, null, "no field until Enter password");
      assertFits(m, width + " closed");

      // Enter password: the field.
      await s.evalIn("document.querySelector('#perch-secret .secret-enter').click(); 1");
      await s.evalIn(SETTLED);
      m = await s.json(CARD);
      assert.deepEqual(
        { type: m.field.type, auto: m.field.auto, hasName: m.field.hasName, hasValueAttr: m.field.hasValueAttr, value: m.field.value },
        { type: "password", auto: "new-password", hasName: false, hasValueAttr: false, value: "" });
      assert.ok(m.field.box.h >= 44, "the field is 44 px tall");
      assert.ok(m.field.font >= 16, "16 px text (no iOS focus zoom)");
      assert.ok(m.field.box.r <= m.card.r + 0.5, "the field stays inside the card");
      assert.deepEqual(m.buttons.map((b) => b.text), ["Save", "Not now"]);
      assertFits(m, width + " open");
      await s.type(SECRET);
      assert.equal(await s.evalIn("document.activeElement&&document.activeElement.className"), "secret-input", "the field has focus");
      if (width === 390 && SHOT) await s.shot(SHOT);

      // Not now: cancel, the field gone and empty.
      await s.evalIn("window.__f=document.querySelector('#perch-secret input'); document.querySelector('#perch-secret .secret-not-now').click(); 1");
      await s.waitFor("!!document.querySelector('#perch-secret .secret-result')", "the closed line");
      m = await s.json(CARD);
      assert.equal(m.result, "You closed the form. Nothing was sent.");
      assert.equal(m.inputs, 0, "the field is gone");
      assert.equal(await s.evalIn("window.__f.value"), "", "the old field holds nothing");
      assert.equal(await s.evalIn("window.__f.isConnected"), false);
      assert.deepEqual(posts.map((p) => [p.url, p.body, p.csrf]), [[`/dashboard/perch-api/secret/${ID1}?sid=${SID}`, '{"cancel":true}', "tok"]]);
      assert.ok(!(await s.evalIn("document.documentElement.outerHTML")).includes(SECRET));
      assertFits(m, width + " settled");
    } finally { await s.close(); }
  });
}

test("390 px: Save sends the value in the body only; it never reaches the DOM, storage, a URL or the console", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  posts.length = 0;
  openRequest = { id: ID1, label: LABEL, kind: "password", expiresAt: Date.now() + 600000 };
  const s = await tab({ width: 390, height: 844 });
  try {
    await s.evalIn("document.querySelector('#perch-secret .secret-enter').click(); 1");
    await s.type(SECRET);
    await s.evalIn("window.__f=document.querySelector('#perch-secret input'); document.querySelector('#perch-secret .secret-save').click(); 1");
    await s.waitFor("!!document.querySelector('#perch-secret .secret-result')", "the saved line");
    const m = await s.json(CARD);
    assert.equal(m.result, "Saved. Nothing about it reaches the bot except its name.");
    assert.equal(m.inputs, 0);
    assert.equal(await s.evalIn("window.__f.value"), "", "the sent field was emptied");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, `/dashboard/perch-api/secret/${ID1}?sid=${SID}`, "the value is never in the URL");
    assert.deepEqual(JSON.parse(posts[0].body), { value: SECRET });
    assert.equal(posts[0].csrf, "tok", "the X-Crow-Csrf header");
    const where = await s.json(`JSON.stringify({ html: document.documentElement.outerHTML.indexOf(${JSON.stringify(SECRET)})>=0,
      local: JSON.stringify(Object.assign({}, localStorage)).indexOf(${JSON.stringify(SECRET)})>=0,
      session: JSON.stringify(Object.assign({}, sessionStorage)).indexOf(${JSON.stringify(SECRET)})>=0,
      url: location.href.indexOf(${JSON.stringify(SECRET)})>=0 })`);
    assert.deepEqual(where, { html: false, local: false, session: false, url: false });
    assert.ok(!s.consoleText.some((l) => l.includes(SECRET)), "never in the console");
  } finally { await s.close(); }
});

test("390 px: a live frame draws the card, and Turbo's before-cache wipes a typed field", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  posts.length = 0;
  openRequest = { id: ID1, label: null, kind: "password", expiresAt: Date.now() + 600000 };
  const s = await tab({ width: 390, height: 844 });
  try {
    let m = await s.json(CARD);
    assert.equal(m.title, "🔒 Password", "no label: the plain heading");
    assert.equal(m.asks, null);
    // The bot's card settles from another tab, then a new one arrives on the stream.
    pushFrame({ type: "secret_request", id: ID1, label: null, state: "done" });
    await s.waitFor("!!document.querySelector('#perch-secret .secret-result')", "the settled card");
    pushFrame({ type: "secret_request", id: ID2, label: "Garden club", state: "open" });
    await s.waitFor("(document.querySelector('#perch-secret .secret-title')||{}).textContent==='🔒 Password for Garden club'", "the new card");
    await s.evalIn("document.querySelector('#perch-secret .secret-enter').click(); 1");
    await s.type(SECRET);
    // A replay of the same open card never wipes what is being typed.
    pushFrame({ type: "secret_request", id: ID2, label: "Garden club", state: "open" });
    await sleep(200);
    assert.equal(await s.evalIn("document.querySelector('#perch-secret input').value.length"), SECRET.length);
    await s.evalIn("window.__f=document.querySelector('#perch-secret input'); document.dispatchEvent(new Event('turbo:before-cache')); 1");
    assert.equal(await s.evalIn("window.__f.value"), "");
    assert.equal(await s.evalIn("document.querySelectorAll('#perch-secret input').length"), 0, "no field in the snapshot");
    assert.equal(posts.length, 0, "nothing was sent");
  } finally { await s.close(); }
});
