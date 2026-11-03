// The staged send card in a Perch chat, LIVE (spec §12; plan Task 4): the real Perch page in the
// real new shell, in a private headless Chrome, against a scripted perch-api holding one staged
// draft. At 390x844 and 1280x800:
//   - the card comes back on load from GET /interactive/:sid/staged and fits the column (no
//     sideways scroll, nothing past the right edge); every target is at least 44 px;
//   - the recipients, the subject and the full body are the row's own text — a body that looks like
//     markup stays text — and the "no yes" line is there;
//   - Send posts { content_hash } to /staged/:id/send with the CSRF header, and the card then reads
//     "Sent <time> to <recipients>".
// The scripted API stands in for the gateway AND Gmail (the fake-gmail fixture is server-side): what
// this file proves is the browser half — the payload Send carries and what the operator sees.
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
const SID = "perchlive-44444444";
const BOT = "Correspondence bot";
const ID = "ss-1111111111111111";
const HASH = "f".repeat(64);
const SUBJECT = "Quarterly numbers <b>for review</b>";
const BODY = "Line one of the draft.\nLine two, with <b>markup</b> that must stay text.\n\nA long last line that has to wrap inside the card instead of widening the column: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.";
const SHOT = process.env.STAGED_CARD_SHOT || "";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
const streams = new Set();
const posts = [];

const ROW = {
  id: ID,
  state: "staged",
  snapshot: {
    to: ["alex@example.com"], cc: ["bob@example.com"],
    bcc: ["cara@example.com"], subject: SUBJECT, body: BODY,
  },
  contentHash: HASH,
  placeholders: [],
  newRecipients: ["cara@example.com"],
  sendable: true,
  failReason: null,
  tainted: true,
  providerDraftId: "draft-live-1",
};

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return send(res, 200, {
      birds: [{ id: "correspondence-bot", name: BOT, perch_attached: true, state: "working",
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
  if (url.endsWith("/staged") && req.method === "GET") return send(res, 200, { items: [ROW] });
  if (url.startsWith("/dashboard/perch-api/staged/") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({ url: req.url, body, csrf: req.headers["x-crow-csrf"] || null });
      send(res, 200, { ok: true, state: "sent", messageId: "msg-live-1" });
    });
    return;
  }
  if (url.endsWith("/transcript")) {
    return send(res, 200, { events: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Draft the quarterly note" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Drafted it in Gmail — a card is open." }] } },
    ] });
  }
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

async function tab({ width, height }) {
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
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch#${SID}` });
  await waitFor("!!document.querySelector('#perch-transcript .staged-card')", "the staged card");
  await evalIn(SETTLED);
  return {
    cdp, evalIn, waitFor, consoleText,
    json: async (expression) => JSON.parse(await evalIn(expression)),
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
  var card=document.querySelector('#perch-transcript .staged-card');
  var buttons=card?[].slice.call(card.querySelectorAll('button, a.staged-gmail')).map(function(b){ return {text:b.textContent, box:box(b)}; }):[];
  var body=card&&card.querySelector('.staged-body');
  return JSON.stringify({ vw:innerWidth, sw:document.documentElement.scrollWidth, card:box(card),
    title:card&&card.querySelector('.staged-title').textContent,
    labels:[].slice.call(card?card.querySelectorAll('.staged-label'):[]).map(function(n){ return n.textContent; }),
    rcpts:[].slice.call(card?card.querySelectorAll('.staged-addr'):[]).map(function(n){ return n.textContent; }),
    newMarks:[].slice.call(card?card.querySelectorAll('.staged-new'):[]).map(function(n){ return n.textContent; }),
    subject:card&&card.querySelector('.staged-subject').textContent,
    body:body&&body.textContent,
    bodyWrap:body?getComputedStyle(body).whiteSpace:null,
    yes:card&&card.querySelector('.staged-yes').textContent,
    taint:card&&card.querySelector('.staged-taint')?card.querySelector('.staged-taint').textContent:null,
    status:card&&card.querySelector('.staged-status')?card.querySelector('.staged-status').textContent:null,
    boldInCard:!!(card&&card.querySelector('b')),
    buttons:buttons });
})()`;

function assertFits(m, label) {
  const at = (s) => `${s} (${label}) ${JSON.stringify(m)}`;
  assert.ok(m.sw <= m.vw, at("no horizontal scroll"));
  assert.ok(m.card && m.card.l >= 0 && m.card.r <= m.vw + 0.5, at("the card is inside the viewport"));
  for (const b of m.buttons) {
    assert.ok(b.box.h >= 44 && b.box.w >= 44, at(`"${b.text}" is a 44 px target`));
    assert.ok(b.box.r <= m.card.r + 0.5, at(`"${b.text}" stays inside the card`));
  }
}

for (const [width, height] of [[390, 844], [1280, 800]]) {
  test(`${width} px card fits, 44 px targets, Send round trip against fake-gmail`, async (t) => {
    if (!available) return t.skip("no headless Chrome");
    posts.length = 0;
    const s = await tab({ width, height });
    try {
      let m = await s.json(CARD);
      assert.equal(m.title, "Draft email");
      assert.deepEqual(m.labels, ["To", "Cc", "Bcc", "Subject", "Message"], "bcc is labelled");
      assert.deepEqual(m.rcpts, ["alex@example.com", "bob@example.com", "cara@example.com"]);
      assert.deepEqual(m.newMarks, ["new"], "the new recipient is marked once");
      assert.equal(m.subject, SUBJECT, "the subject is text, markup and all");
      assert.equal(m.body, BODY, "the whole body, unchanged");
      assert.equal(m.bodyWrap, "pre-wrap", "newlines are shown as written");
      assert.equal(m.yes, "Nothing goes out without your yes.");
      assert.equal(m.taint, "Written from outside content: read it before sending.");
      assert.equal(m.boldInCard, false, "markup in the draft is never markup on the card");
      assert.deepEqual(m.buttons.map((b) => b.text), ["Send", "Edit", "Ask for a change", "Not now"]);
      assertFits(m, width + " staged");
      if (width === 390 && SHOT) await s.shot(SHOT);

      // Send: the round trip. The POST carries the hash the card showed, and only that.
      await s.evalIn("document.querySelector('.staged-send').click(); 1");
      await s.waitFor("(document.querySelector('#perch-transcript .staged-status')||{}).textContent&&(document.querySelector('#perch-transcript .staged-status')||{}).textContent.indexOf('Sent ')===0", "the sent line");
      await s.evalIn(SETTLED);
      assert.equal(posts.length, 1, "one POST");
      assert.equal(posts[0].url, `/dashboard/perch-api/staged/${ID}/send`);
      assert.equal(posts[0].csrf, "tok", "the X-Crow-Csrf header");
      assert.deepEqual(JSON.parse(posts[0].body), { content_hash: HASH });
      m = await s.json(CARD);
      assert.match(m.status, /^Sent .+ to alex@example\.com, bob@example\.com, cara@example\.com$/, m.status);
      assert.deepEqual(m.buttons, [], "no actions left once it is sent");
      assertFits(m, width + " sent");
    } finally { await s.close(); }
  });
}