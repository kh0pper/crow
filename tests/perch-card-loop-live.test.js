// Redesign P5, Task 5.5: the chat-to-card loop in a real browser.
//
// The real Perch page (the production layout) runs in a private headless Chrome at phone
// 390x844, in en and es, against a scripted perch-api that stands in for the gateway AND the
// engine: it keeps one small piece of state (offer, card, result, decision) and records every
// POST the page makes, so the test can prove what the bot was and was not sent.
//
// The loop: the offer shows -> Make card (the system note and the chip "#n . Up next" show;
// the engine got no message) -> a recorded result is injected -> Accept (the chip reads Done;
// still no message) -> an open decision is injected -> its recommended option is tapped (the
// chips go away). Every wait is a poll on a page condition. Set SHELL_SHOTS_DIR for screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-c4a1d100";
const SHOTS = process.env.SHELL_SHOTS_DIR || "";
const LANES = { en: { up_next: "Up next", done: "Done" }, es: { up_next: "Lo siguiente", done: "Hecho" } };

let chrome = null, server = null, port = 0, HOST = "127.0.0.1", lang = "en";
let panel, renderLayout;
/** The scripted world: what the server would answer, and every POST the page made. */
let W;
function fresh() {
  W = { offer: { id: 7, status: "pending", title: "Draft the garden reply", cardId: null, projectId: 3, projectName: "Garden" },
    card: null, result: null, decisions: [], posts: [] };
}
const messages = () => W.posts.filter((p) => p.url.endsWith("/message"));

function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise((r) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { try { r(JSON.parse(s || "null")); } catch { r(null); } }); }); }

async function api(req, res) {
  const url = req.url.split("?")[0];
  if (req.method === "POST") {
    const b = await body(req);
    W.posts.push({ url, body: b });
    let m;
    if ((m = url.match(/\/offers\/(\d+)\/decide$/))) {
      if (b.accept) { W.offer.status = "accepted"; W.offer.cardId = 41; W.card = { id: 41, title: W.offer.title, projectId: 3, lane: "up_next" }; }
      else W.offer.status = "declined";
      return json(res, 200, { ok: true, status: W.offer.status, cardId: W.offer.cardId, projectId: 3, attached: true });
    }
    if (url.endsWith("/cards/41/accept")) {
      if (!W.result || b.result_id !== W.result.id) return json(res, 409, { error: "stale" });
      W.result = null; W.card.lane = "done";
      return json(res, 200, { ok: true });
    }
    if (url.endsWith("/bot-board-api/card/41/decision") || url.includes("/decision")) { W.decisions = []; return json(res, 200, { ok: true }); }
    if (url.endsWith("/message")) return json(res, 202, { turnId: "t1" });
    return json(res, 200, {});
  }
  if (url.endsWith("/roost")) {
    return json(res, 200, { birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "idle",
      sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run" }] }], occupiedCardIds: [] });
  }
  if (url.endsWith("/events")) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.write(": open\n\n"); return; }
  if (url.endsWith("/transcript")) {
    return json(res, 200, { events: [
      { type: "message", message: { role: "user", content: [{ text: "Can you put the garden reply on my board?" }] } },
      { type: "message", message: { role: "assistant", content: [{ text: "Yes. I can make a card for it." }] } } ] });
  }
  if (url.endsWith("/offers")) return json(res, 200, { offers: W.offer.status === "declined" ? [] : [W.offer] });
  if (url.endsWith("/card")) return json(res, 200, { card: W.card, result: W.result, decisions: W.decisions });
  if (url.endsWith("/options")) return json(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/models")) return json(res, 200, { models: [], default: null });
  return json(res, 200, {});
}

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  HOST = chrome.pageHost;
  ({ default: panel } = await import("../servers/gateway/dashboard/panels/perch-hub.js"));
  ({ renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js"));
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return api(req, res);
    if (req.url.startsWith("/dashboard/bot-board-api/")) return api(req, res);
    if (req.url.startsWith("/api/artifacts/")) return json(res, 200, { items: [] });
    if (req.url.startsWith("/vendor/turbo")) { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(turbo); }
    if (!req.url.startsWith("/dashboard/perch")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>blank</title><p>blank</p>"); }
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [panel], lang });
    const html = await panel.handler(req, res, { lang, layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) { server.closeAllConnections?.(); server.close(); } if (chrome) await chrome.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openChat() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const errors = [];
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text); });
  const ev = async (expression) => {
    const o = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what + (errors.length ? "; page errors: " + errors.slice(-3).join(" | ") : ""));
      await sleep(80);
    }
  };
  const base = `http://${HOST}:${port}`;
  await cdp("Page.enable"); await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp("Network.enable");
  await cdp("Network.setCookie", { name: "crow_csrf", value: "tok", url: base, path: "/" });
  await cdp("Page.navigate", { url: base + "/dashboard/perch#" + SID });
  await until("document.body.getAttribute('data-view')==='chat'&&document.querySelectorAll('#perch-transcript .entry').length>=2", "the chat to load");
  const click = async (sel) => {
    await until(`!!document.querySelector(${JSON.stringify(sel)})`, "element " + sel);
    const p = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({block:'center'}); var b=e.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(SHOTS, name + ".png"), Buffer.from(data, "base64"));
  };
  return { ev, until, click, shot, errors, cdp, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}

/** {count, bad}: visible buttons/links in the loop's UI, and those under 44x44. */
const SMALL = `(function(){ var bad=[], count=0;
  document.querySelectorAll('.perch-offer button, .perch-review button, .perch-cardchip a').forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++; if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;
const NO_H_SCROLL = "document.documentElement.scrollWidth <= window.innerWidth";
async function targets(p, min, tag) {
  const r = await p.ev(SMALL);
  assert.ok(r.count >= min, `${tag}: ${r.count} visible controls, expected at least ${min}`);
  assert.deepEqual(r.bad, [], `${tag}: every control is at least 44 px`);
  assert.equal(await p.ev(NO_H_SCROLL), true, `${tag}: no sideways scroll`);
}

for (const l of ["en", "es"]) {
  test(`390x844 ${l}: offer, Make card, result, Accept, decision, all in one chat; the bot is sent nothing`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    lang = l; fresh();
    const p = await openChat();
    try {
      assert.equal(await p.ev("document.documentElement.lang"), l);
      // 1. The offer.
      await p.until("!!document.querySelector('.perch-offer .offer-make')", "the offer card");
      assert.equal(await p.ev("document.querySelector('.perch-offer .art-title').textContent"), "Draft the garden reply");
      assert.equal(await p.ev("document.querySelector('.perch-offer .art-meta').textContent"), "Garden");
      await targets(p, 2, "offer");
      await p.shot(`p5-${l}-1-offer`);

      // 2. Make card: the note and the chip, and not one message to the bot.
      await p.click(".perch-offer .offer-make");
      await p.until("!!document.querySelector('.perch-sysnote') && !!document.querySelector('.perch-cardchip .cardchip-lane')", "the note and the chip");
      assert.equal(await p.ev("document.querySelectorAll('.perch-offer').length"), 0, "the offer is gone");
      const note = await p.ev("document.querySelector('.perch-sysnote .sysnote-text').textContent");
      assert.ok(note.includes("41") && note.includes("Garden"), `the note names the card and the board: ${note}`);
      assert.equal(await p.ev("document.querySelector('.perch-cardchip .cardchip-ref').textContent.indexOf('#41')>=0"), true);
      assert.equal(await p.ev("document.querySelector('.perch-cardchip .cardchip-lane').textContent"), LANES[l].up_next);
      assert.equal(await p.ev("document.querySelectorAll('.perch-sysnote.entry, .perch-sysnote .what').length"), 0, "the note is not a message");
      assert.deepEqual(messages(), [], "Make card sent the bot nothing");
      await targets(p, 2, "chip");
      await p.shot(`p5-${l}-2-chip`);

      // 3. A recorded result arrives (the bot finished); the next turn end / reload draws it.
      W.result = { id: 90, outcome: "success", summaryMd: "Drafted the reply and saved it." };
      await p.ev("location.reload(); true");
      await p.until("!!document.querySelector('.perch-review .review-accept')", "the review chips");
      assert.equal(await p.ev("document.querySelectorAll('.perch-review .review-change, .perch-review .review-notnow').length"), 2);
      await targets(p, 4, "result chips");
      await p.shot(`p5-${l}-3-result`);

      // 4. Accept: the card is Done, still nothing sent to the bot.
      await p.click(".perch-review .review-accept");
      await p.until(`document.querySelector('.perch-cardchip .cardchip-lane') && document.querySelector('.perch-cardchip .cardchip-lane').textContent===${JSON.stringify(LANES[l].done)} && !document.querySelector('.perch-review')`, "the chip to read Done");
      const acc = W.posts.find((x) => x.url.endsWith("/cards/41/accept"));
      assert.deepEqual(acc && acc.body, { result_id: 90 }, "Accept posts the result the chat showed");
      assert.deepEqual(messages(), [], "Accept sent the bot nothing");
      assert.equal(await p.ev(NO_H_SCROLL), true);
      await p.shot(`p5-${l}-4-done`);

      // 5. An open decision: tap the recommended option; the chips go away.
      W.decisions = [{ cardId: 41, question: "Which tone should the reply take?", options: [
        { index: 0, label: "Warm and short", recommended: true, consequence: "Fastest to send." },
        { index: 1, label: "Formal", recommended: false, consequence: "Longer." } ] }];
      await p.ev("location.reload(); true");
      await p.until("!!document.querySelector('.perch-review .review-opt-rec')", "the decision chips");
      await targets(p, 4, "decision chips");
      await p.shot(`p5-${l}-5-decision`);
      await p.click(".perch-review .review-opt-rec");
      await p.until("!document.querySelector('.perch-review')", "the decision chips to go");
      const dec = W.posts.find((x) => x.url.includes("/decision"));
      assert.deepEqual(dec && dec.body, { index: 0 }, "the recommended option was sent");
      assert.deepEqual(messages(), [], "the whole loop sent the bot no message");
      assert.equal(await p.ev(NO_H_SCROLL), true);
      assert.deepEqual(p.errors, [], "no page errors");
    } finally { await p.close(); lang = "en"; }
  });
}
