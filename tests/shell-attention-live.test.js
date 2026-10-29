// The "Needs attention" group in the mascot sheet, LIVE: the real shell chrome
// (renderLayout, variant shell, the mascot and its tray) in a private headless
// Chrome, with the fragment and count routes scripted to carry a foreign
// Funnel mapping and an update issue. Checks, at 390 and 1280 px:
//   - the sheet opens with "Needs attention" first, then the tray;
//   - ?sheet=attention opens the sheet once and drops the parameter;
//   - 390 px: the text column is at least 120 px, each action is a 44 px
//     target on its own line under the text, nothing scrolls sideways;
//   - the mascot's badge counts notifications plus attention.
// Set ATTENTION_SHOT to a file path to save the 390 px screenshot.
// Skips cleanly without Chrome (CROW_REQUIRE_TEST_CHROME=1 makes that fatal).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { foreignMappingKey } from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { fill, t } from "../servers/gateway/dashboard/shared/i18n.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SHOT = process.env.ATTENTION_SHOT || "";
const FOREIGN_KEY = foreignMappingKey(":3008", ["/s", "/s-assets"]);
const ISSUES = [
  // As exposureSignal builds it: severity info, the real label, a hashed ack key.
  { id: "exposure:foreign::3008", severity: "info", label: fill(t("signals.exposure.foreign", "en"), { list: "/s, /s-assets → :3008" }), actionLabel: t("signals.exposure.action", "en"), actionHref: "/dashboard/settings?section=connections", ack: { kind: "exposure-foreign", key: FOREIGN_KEY } },
  { id: "updates", severity: "info", label: "An update is available: 1.4.2", actionLabel: "Open updates", actionHref: "/dashboard/settings?section=updates", ack: null },
];
const acked = new Set();
let lastAck = null;

let chrome = null, server = null, port = 0, HOST = "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  HOST = chrome.pageHost;
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { tamagotchiHtml, tamagotchiTrayHtml, tamagotchiJs } = await import("../servers/gateway/dashboard/shared/notifications.js");
  const { attentionGroupHtml } = await import("../servers/gateway/dashboard/shell/attention.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const lang = /[?&]lang=es\b/.test(req.url) ? "es" : "en";
    if (url === "/dashboard/attention/fragment") {
      // Like the real route: the language comes from the crow_lang cookie.
      const fragLang = /(?:^|;\s*)crow_lang=es\b/.test(req.headers.cookie || "") ? "es" : "en";
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      return res.end(attentionGroupHtml(ISSUES.filter((i) => !(i.ack && acked.has(i.ack.key))), fragLang));
    }
    // The real route's two hops: POST ack -> back (or /dashboard/attention) ->
    // the page with ?sheet=attention (the real GET /dashboard/attention in new mode).
    if (url === "/dashboard/health/ack" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const f = new URLSearchParams(body);
        lastAck = Object.fromEntries(f);
        if (f.get("kind") === "exposure-foreign" && f.get("key") && f.get("_csrf")) acked.add(f.get("key"));
        const back = f.get("back") || "";
        res.writeHead(303, { location: /^\/dashboard\/[^/]/.test(back) ? back : "/dashboard/attention" });
        res.end();
      });
      return;
    }
    if (url === "/dashboard/attention") {
      res.writeHead(303, { location: "/dashboard/perch?sheet=attention" });
      return res.end();
    }
    if (url === "/api/notifications/count") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ count: 2, attention: ISSUES.filter((i) => !(i.ack && acked.has(i.ack.key))).length, health: null }));
    }
    if (url.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ notifications: [], items: [] })); }
    if (url.startsWith("/vendor/turbo")) { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(turbo); }
    if (!url.startsWith("/dashboard/")) { res.writeHead(404); return res.end(); }
    const html = renderLayout({ title: "Attention", content: '<p id="body-p">page</p>', activePanel: "perch", panels: [], lang, scripts: tamagotchiJs(lang),
      headerIcons: tamagotchiHtml(lang, { sheet: true }),
      variant: "shell", shell: { scope: { all: true }, projects: [], tab: "chat", getPanel: () => null, tray: tamagotchiTrayHtml(lang) } });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

async function tab(path, { width = 390, height = 844, dark = false } = {}) {
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
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  });
  const ev = async (expression) => {
    const out = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const until = async (expression, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) {
        let where = "";
        try { where = await ev("location.href + ' body=' + document.body.className"); } catch {}
        throw new Error("timed out waiting for " + what + " at " + where + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
      }
      await sleep(100);
    }
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Network.clearBrowserCookies");
  if (/[?&]lang=es\b/.test(path)) await cdp("Network.setCookie", { name: "crow_lang", value: "es", url: `http://${HOST}:${port}/` });
  await cdp("Network.setCookie", { name: "crow_csrf", value: "tok-live", url: `http://${HOST}:${port}/` });
  await cdp("Page.navigate", { url: `http://${HOST}:${port}${path}` });
  await until("document.readyState==='complete'&&!!document.getElementById('crow-bird-btn')", "the page");
  // Fonts and two frames settle before any layout check.
  await ev("document.fonts.ready.then(function(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); }); })");
  return {
    ev, until,
    shot: async (file) => {
      const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); },
  };
}

const SETTLED = "document.fonts.ready.then(function(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(1); }); }); }); })";
const GEOMETRY = `(function(){
  var d=document.getElementById('shell-avatar'), slot=d.querySelector('[data-shell-attention]');
  var tray=d.querySelector('.shell-crow-tray');
  var rows=[].slice.call(slot.querySelectorAll('.shell-attn-row')).map(function(r){
    var tx=r.querySelector('.shell-attn-text').getBoundingClientRect();
    var acts=[].slice.call(r.querySelectorAll('.shell-attn-action,.shell-attn-btn')).map(function(a){ var b=a.getBoundingClientRect(); return {t:b.top,h:b.height,w:b.width,l:b.left}; });
    return { textW:tx.width, textL:tx.left, textB:tx.bottom, acts:acts };
  });
  var inner=d.querySelector('.shell-sheet-inner');
  return { open:d.open, rows:rows, headings:[].slice.call(d.querySelectorAll('.shell-heading')).map(function(h){ return h.textContent.trim(); }),
    slotBeforeTray: !!(slot.compareDocumentPosition(tray) & 4), sw:document.documentElement.scrollWidth, vw:innerWidth,
    innerOverflow: inner.scrollWidth>inner.clientWidth+1 };
})()`;

for (const [lang, heading] of [["en", "Needs attention"], ["es", "Necesita atención"]]) {
  test(`${lang}: the sheet opens with Needs attention first, then the tray`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    const p = await tab(`/dashboard/perch?lang=${lang}`);
    try {
      // Prefetched at page load: the group is in the closed sheet already.
      await p.until("document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===2", "the prefetched group");
      await p.ev("document.getElementById('crow-bird-btn').click(); 1");
      assert.equal(await p.ev("document.getElementById('shell-avatar').open && document.querySelectorAll('[data-shell-attention] .shell-attn-row').length"), 2, "rows are there at the moment of opening");
      await p.ev(SETTLED);
      const g = JSON.parse(await p.ev(`JSON.stringify(${GEOMETRY})`));
      assert.equal(g.headings[0], heading);
      assert.equal(g.headings[1], lang === "es" ? "Notificaciones" : "Notifications");
      assert.equal(g.slotBeforeTray, true);
      assert.equal(g.rows.length, 2);
      // A second open re-fetches (the group is not stale-cached): close, reopen.
      await p.ev("document.getElementById('shell-avatar').close(); 1");
      await p.until("document.getElementById('crow-bird-btn').getAttribute('aria-expanded')==='false'", "the tray reset");
      await p.ev("document.getElementById('crow-bird-btn').click(); 1");
      await p.until("document.getElementById('shell-avatar').open && document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===2", "the reopened sheet");
    } finally { await p.close(); }
  });
}

test("?sheet=attention opens the sheet once and drops the parameter", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await tab("/dashboard/perch?sheet=attention&keep=1");
  try {
    await p.until("document.getElementById('shell-avatar').open", "the sheet to open on its own");
    assert.equal(await p.ev("location.search"), "?keep=1", "only the sheet parameter is removed");
    await p.until("document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===2", "the group");
    await p.ev("document.getElementById('shell-avatar').close(); 1");
    await p.ev(SETTLED);
    await sleep(300);
    assert.equal(await p.ev("document.getElementById('shell-avatar').open"), false, "it does not reopen by itself");
  } finally { await p.close(); }
});

test("390 px: text column >= 120 px, actions >= 44 px on their own line, no sideways overflow", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  for (const dark of [false, true]) {
    const p = await tab("/dashboard/perch", { width: 390, dark });
    try {
      await p.ev("document.getElementById('crow-bird-btn').click(); 1");
      await p.until("document.getElementById('shell-avatar').open && document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===2", "the rows");
      await p.ev(SETTLED);
      const g = JSON.parse(await p.ev(`JSON.stringify(${GEOMETRY})`));
      const at = (s) => `${s} ${JSON.stringify(g)}`;
      assert.ok(g.sw <= g.vw, at("no horizontal scroll"));
      assert.equal(g.innerOverflow, false, at("the sheet does not overflow sideways"));
      assert.equal(g.rows[0].acts.length, 2, "the foreign row has its link and its ack button");
      assert.equal(g.rows[1].acts.length, 1);
      for (const r of g.rows) {
        assert.ok(r.textW >= 120, at("the text column is at least 120 px"));
        for (const a of r.acts) {
          assert.ok(a.h >= 44, at("the action is a 44 px target"));
          assert.ok(a.t >= r.textB - 0.5, at("the action sits under the text"));
        }
        assert.ok(Math.abs(r.acts[0].l - r.textL) <= 1, at("the first action is aligned with the text"));
      }
      if (SHOT && !dark) await p.shot(SHOT);
    } finally { await p.close(); }
  }
});

test("1280 px: the group fits the sheet", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await tab("/dashboard/perch", { width: 1280, height: 800 });
  try {
    await p.ev("document.getElementById('crow-bird-btn').click(); 1");
    await p.until("document.getElementById('shell-avatar').open && document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===2", "the rows");
    await p.ev(SETTLED);
    const g = JSON.parse(await p.ev(`JSON.stringify(${GEOMETRY})`));
    assert.ok(g.sw <= g.vw && g.innerOverflow === false);
    for (const r of g.rows) { assert.ok(r.textW >= 120); for (const a of r.acts) assert.ok(a.h >= 44); }
  } finally { await p.close(); }
});

test("badge includes attention", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await tab("/dashboard/perch");
  try {
    // count 2 + attention 2
    await p.until("document.getElementById('crow-bubble-count') && document.getElementById('crow-bubble-count').textContent==='4' && document.getElementById('crow-bubble').style.display!=='none'", "the badge to read 4");
  } finally { await p.close(); }
});

test("This is expected: two 303 hops, the sheet reopens on the same page with that row gone", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  acked.clear(); lastAck = null;
  const p = await tab("/dashboard/bot-builder?x=1");
  try {
    await p.until("document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===2", "the prefetched group");
    // The ack form returns to this page with the sheet open (not to Chat).
    assert.equal(await p.ev("document.querySelector('[data-shell-attention] input[name=back]').value"), "/dashboard/bot-builder?x=1&sheet=attention");
    await p.ev("document.getElementById('crow-bird-btn').click(); 1");
    await p.until("document.getElementById('shell-avatar').open", "the sheet");
    await p.ev("document.querySelector('[data-shell-attention] .shell-attn-btn--quiet').click(); 1");
    await p.until("location.pathname==='/dashboard/bot-builder' && document.getElementById('shell-avatar').open && document.querySelectorAll('[data-shell-attention] .shell-attn-row').length===1", "the sheet reopened with one row");
    assert.equal(await p.ev("location.search"), "?x=1", "the sheet parameter is dropped again");
    assert.match(await p.ev("document.querySelector('[data-shell-attention]').textContent"), /An update is available/);
    assert.doesNotMatch(await p.ev("document.querySelector('[data-shell-attention]').textContent"), /3008/);
    assert.deepEqual(lastAck, { _csrf: "tok-live", kind: "exposure-foreign", key: FOREIGN_KEY, back: "/dashboard/bot-builder?x=1&sheet=attention" });
    await p.until("document.getElementById('crow-bubble-count').textContent==='3'", "the badge: 2 notifications + 1 issue");
  } finally { await p.close(); acked.clear(); }
});

test("a repeated ?sheet= on the page is not duplicated in the back path", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  const p = await tab("/dashboard/perch?sheet=attention&sheet=attention");
  try {
    await p.until("document.querySelectorAll('[data-shell-attention] input[name=back]').length>0", "the group");
    const back = await p.ev("document.querySelector('[data-shell-attention] input[name=back]').value");
    assert.equal((back.match(/sheet=/g) || []).length, 1, back);
  } finally { await p.close(); }
});
