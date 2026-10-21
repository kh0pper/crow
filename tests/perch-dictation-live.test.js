// Perch composer dictation, LIVE: the real page through the real dashboard
// shell, in a private headless Chrome (tests/fixtures/headless-chrome.mjs)
// started with Chrome's fake microphone (--use-fake-device-for-media-stream,
// a beep) and the permission prompt auto-accepted. The perch-api is scripted:
// GET/POST /dictation answer whatever each case sets — no speech-to-text
// server is involved at all. 127.0.0.1 is a secure context, so
// getUserMedia and MediaRecorder are real.
//
// getUserMedia, AudioContext and the Android app's CrowAudioPort are
// instrumented before the page runs (Page.addScriptToEvaluateOnNewDocument),
// keeping every stream and context so a case can assert the tracks ended and
// the context closed. Every wait is a poll on a page condition.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-11111111";
const SID2 = "perchlive-22222222";

let CDP = "", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;

// ---- scripted perch-api ----------------------------------------------------
let probe, probeHits, dictPosts, dictQueue, dictDelayMs, sent, streams;
function resetApi() {
  probe = { available: true, maxSeconds: 60, cloud: false, profileTag: "tag-1" };
  probeHits = 0; dictPosts = []; dictQueue = []; dictDelayMs = 0; sent = []; streams = [];
}
resetApi();

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function broadcast(type, data) {
  for (const r of streams) r.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/dictation")) {
    if (req.method === "GET") { probeHits++; return sendJson(res, 200, probe); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    dictPosts.push({ headers: req.headers, body });
    const next = dictQueue.shift() || { status: 200, body: { text: "canned words", language: "en", duration: 1 } };
    const reply = () => sendJson(res, next.status, next.body);
    if (dictDelayMs) return setTimeout(reply, dictDelayMs);
    return reply();
  }
  if (url.endsWith("/roost")) {
    return sendJson(res, 200, {
      birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: [SID, SID2].map((sid) => ({ sessionId: sid, state: "awake", cardId: null, pendingUi: false, control: "run" })) }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    streams.push(res);
    req.on("close", () => { streams = streams.filter((s) => s !== res); });
    return;
  }
  if (url.endsWith("/message") || url.endsWith("/steer")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    sent.push({ path: url, body: j });
    return sendJson(res, 202, { ok: true });
  }
  if (url.endsWith("/transcript")) return sendJson(res, 200, { events: [] });
  if (url.endsWith("/options")) return sendJson(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/models")) return sendJson(res, 200, { models: [], default: null });
  return sendJson(res, 200, {});
}

before(async () => {
  chrome = await startHeadlessChrome({ extraArgs: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    if (!req.url.startsWith("/dashboard/perch")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title><p>blank</p>");
    }
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

after(async () => { for (const s of streams) s.end(); if (server) { server.closeAllConnections?.(); server.close(); } if (chrome) await chrome.close(); });
beforeEach(() => resetApi());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Installed before every document: keeps every stream and AudioContext the
 *  page makes, records CrowAudioPort messages, and lets a case hold
 *  getUserMedia on a deferred promise or make it reject. */
const INSTRUMENT = `(function(){
  var D=window.__dict={streams:[],ctxs:[],port:[],gum:'real',held:null,gumCalls:0,constraints:null};
  document.cookie='crow_csrf=csrf-live-token; path=/';
  var md=navigator.mediaDevices;
  if(md&&md.getUserMedia){
    var real=md.getUserMedia.bind(md);
    md.getUserMedia=function(c){
      D.gumCalls++; D.constraints=c;
      if(D.gum==='deny') return Promise.reject(new DOMException('denied','NotAllowedError'));
      var p=real(c).then(function(s){ D.streams.push(s); return s; });
      if(D.gum==='defer') return new Promise(function(res,rej){ D.held=function(){ p.then(res,rej); }; });
      return p;
    };
  }
  var RAC=window.AudioContext;
  if(RAC){ window.AudioContext=function(o){ var c=new RAC(o); D.ctxs.push(c); return c; }; window.AudioContext.prototype=RAC.prototype; }
  window.CrowAudioPort={postMessage:function(m){ D.port.push(JSON.parse(m).op); }};
  var RMR=window.MediaRecorder;
  if(RMR){ D.recs=[]; window.MediaRecorder=function(st,o){ var r=new RMR(st,o); D.recs.push(r); return r; };
    window.MediaRecorder.prototype=RMR.prototype; window.MediaRecorder.isTypeSupported=RMR.isTypeSupported.bind(RMR); }
})();`;

async function tab(width, height, { hash = SID } = {}) {
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
      if (Date.now() > end) throw new Error("timed out waiting for " + what + " (" + expression + ")");
      await sleep(80);
    }
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch#${hash}` });
  await waitFor("document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent", "the chat");
  return {
    cdp, evalIn, waitFor,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    click: async (elId) => {
      const { x, y } = JSON.parse(await evalIn(`(function(){ var b=document.getElementById(${JSON.stringify(elId)}).getBoundingClientRect();
        return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2}); })()`));
      for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    escape: async () => {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const STATE = `(function(){
  function shown(id){ var e=document.getElementById(id); return !!e&&getComputedStyle(e).display!=='none'&&!e.closest('[hidden]'); }
  var D=window.__dict||{};
  var tracks=[]; (D.streams||[]).forEach(function(s){ s.getTracks().forEach(function(t){ tracks.push(t.readyState); }); });
  return JSON.stringify({
    state: document.getElementById('perch-composer').getAttribute('data-dictation'),
    mic: shown('perch-dictate'), bar: shown('perch-dictation-bar'), hint: shown('perch-dictation-hint'),
    hintText: document.getElementById('perch-dictation-hint').textContent,
    status: document.getElementById('perch-dict-status').textContent,
    time: document.getElementById('perch-dict-time').textContent,
    retry: shown('perch-dict-retry'),
    input: document.getElementById('perch-input').value,
    inputShown: shown('perch-input'),
    active: document.activeElement&&document.activeElement.id,
    tracks: tracks, ctxs: (D.ctxs||[]).map(function(c){ return c.state; }),
    port: D.port||[], gumCalls: D.gumCalls||0,
    sendWord: document.querySelector('#perch-dict-send .dict-word').textContent,
    sendLabel: document.getElementById('perch-dict-send').getAttribute('aria-label')
  });
})()`;

const RECORDING = "document.getElementById('perch-composer').getAttribute('data-dictation')==='recording'";
const IDLE = "document.getElementById('perch-composer').getAttribute('data-dictation')==='idle'";
const MIC_SHOWN = "getComputedStyle(document.getElementById('perch-dictate')).display!=='none'";
const allEnded = (st) => st.tracks.length > 0 && st.tracks.every((x) => x === "ended");
const allClosed = (st) => st.ctxs.length > 0 && st.ctxs.every((x) => x === "closed");

async function record(s) {
  await s.waitFor(MIC_SHOWN, "the mic");
  await s.click("perch-dictate");
  await s.waitFor(RECORDING, "recording");
}

// ---------------------------------------------------------------------------

for (const [w, h] of [[412, 730], [1280, 900]]) {
  test(`live @${w}x${h}: (a) mic shows 'Dictate'; (b) the bar, focus on Done, the timer; (c) Done appends the text`, async (t) => {
    if (!available) return t.skip("no headless Chrome");
    const s = await tab(w, h);
    try {
      await s.waitFor(MIC_SHOWN, "the mic to show once the probe says yes");
      const micWord = await s.evalIn("(function(){ var sp=document.querySelector('#perch-dictate span'); return sp.offsetWidth>0?sp.textContent:''; })()");
      assert.equal(micWord, "Dictate", "a visible word at every width");
      await s.evalIn("document.getElementById('perch-input').value='Pre typed'; 'ok'");
      await s.click("perch-dictate");
      await s.waitFor(RECORDING, "recording");
      let st = await s.json(STATE);
      assert.equal(st.bar, true);
      assert.equal(st.inputShown, false, "the bar replaces the textarea");
      assert.equal(st.active, "perch-dict-done", "focus moves to Done");
      assert.equal(st.status, "Recording");
      const words = await s.json(`JSON.stringify(Array.from(document.querySelectorAll('#perch-dictation-bar .dict-word')).map(function(e){ return getComputedStyle(e).display!=='none'; }))`);
      if (w >= 600) assert.ok(words.every(Boolean), "words beside the icons at 600px and wider");
      else {
        assert.ok(words.every((x) => !x), "icon-only on a phone");
        const names = await s.json(`JSON.stringify(['perch-dict-cancel','perch-dict-done','perch-dict-send'].map(function(id){ return document.getElementById(id).getAttribute('aria-label'); }))`);
        assert.deepEqual(names, ["Cancel", "Done", "Send"]);
      }
      await s.waitFor("document.getElementById('perch-dict-time').textContent==='0:01'", "the timer to reach 0:01", 5000);
      await s.click("perch-dict-done");
      await s.waitFor("document.getElementById('perch-input').value==='Pre typed canned words'", "the transcript in the composer");
      st = await s.json(STATE);
      assert.equal(st.state, "idle");
      assert.equal(st.active, "perch-input", "focus returns to the textarea");
      assert.equal(await s.evalIn("document.getElementById('perch-input').readOnly||document.getElementById('perch-input').disabled"), false);
      assert.equal(dictPosts.length, 1);
      const p = dictPosts[0];
      assert.match(p.headers["content-type"], /^audio\/webm/);
      assert.equal(p.headers["x-crow-csrf"], "csrf-live-token");
      assert.equal(p.headers["x-crow-dictation-profile"], "tag-1");
      assert.ok(p.body.length > 0);
      assert.equal(p.body.subarray(0, 4).toString("hex"), "1a45dfa3", "a real webm container");
      assert.ok(allEnded(st), "tracks ended: " + JSON.stringify(st.tracks));
      assert.ok(allClosed(st), "AudioContext closed: " + JSON.stringify(st.ctxs));
      assert.deepEqual(st.port, ["captureStarting", "captureEnded"], "the app's audio port hears a pair");
      assert.equal(st.hint, false, "no cloud hint for a local profile");
    } finally { await s.close(); }
  });
}

test("live (d): ↑ sends the transcript at once; with a turn in flight it reads Steer and steers", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    await record(s);
    await s.click("perch-dict-send");
    await s.waitFor(IDLE, "back to idle");
    for (const end = Date.now() + 3000; !sent.length && Date.now() < end;) await sleep(50);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, `/dashboard/perch-api/interactive/${SID}/message`);
    assert.equal(sent[0].body.message, "canned words");
    assert.equal(await s.evalIn("document.getElementById('perch-input').value"), "");

    broadcast("state", { state: "awake", turnInFlight: true });
    await s.waitFor("document.getElementById('perch-send').textContent==='Steer'", "the turn to be in flight");
    await record(s);
    const st = await s.json(STATE);
    assert.equal(st.sendWord, "Steer");
    assert.equal(st.sendLabel, "Steer");
    await s.click("perch-dict-send");
    for (const end = Date.now() + 3000; sent.length < 2 && Date.now() < end;) await sleep(50);
    assert.equal(sent[1].path, `/dashboard/perch-api/interactive/${SID}/steer`);
  } finally { await s.close(); }
});

test("live (e): ✕ and Escape drop the recording — no POST, mic released, composer unchanged, focus on the mic", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    await s.evalIn("document.getElementById('perch-input').value='keep me'; 'ok'");
    await record(s);
    await s.click("perch-dict-cancel");
    await s.waitFor(IDLE, "idle after ✕");
    let st = await s.json(STATE);
    assert.equal(st.bar, false);
    assert.equal(st.input, "keep me");
    assert.equal(st.active, "perch-dictate");
    assert.ok(allEnded(st)); assert.ok(allClosed(st));
    assert.deepEqual(st.port, ["captureStarting", "captureEnded"]);

    await s.evalIn("window.__docKeys=0; document.addEventListener('keydown',function(){ window.__docKeys++; }); 'ok'");
    await record(s);
    await s.escape();
    await s.waitFor(IDLE, "idle after Escape");
    st = await s.json(STATE);
    assert.equal(await s.evalIn("window.__docKeys"), 0, "Escape stopped at the bar");
    assert.equal(st.input, "keep me");
    assert.equal(st.active, "perch-dictate");
    assert.ok(allEnded(st)); assert.ok(allClosed(st));
    await sleep(300);
    assert.equal(dictPosts.length, 0, "nothing was uploaded");
  } finally { await s.close(); }
});

test("live (f): a failed transcription keeps the clip for Retry (same bytes); profile_changed re-probes and keeps it", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    dictQueue = [{ status: 502, body: { error: "stt_failed" } }];
    await record(s);
    await s.click("perch-dict-done");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='error'", "the error");
    let st = await s.json(STATE);
    assert.equal(st.status, "Couldn't transcribe");
    assert.equal(st.retry, true);
    await s.click("perch-dict-retry");
    await s.waitFor("document.getElementById('perch-input').value==='canned words'", "Retry to land the text");
    assert.equal(dictPosts.length, 2);
    assert.ok(dictPosts[0].body.equals(dictPosts[1].body), "the Blob was uploaded twice with identical bytes");

    dictQueue = [{ status: 409, body: { error: "profile_changed" } }];
    const before = probeHits;
    probe = { ...probe, profileTag: "tag-2" };
    await record(s);
    await s.click("perch-dict-done");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='error'", "profile_changed");
    st = await s.json(STATE);
    assert.match(st.status, /settings changed/);
    assert.equal(st.retry, true, "the Blob is kept");
    for (const end = Date.now() + 3000; probeHits === before && Date.now() < end;) await sleep(50);
    assert.ok(probeHits > before, "the hint is refreshed by a re-probe");
    await s.click("perch-dict-retry");
    await s.waitFor("/canned words canned words$/.test(document.getElementById('perch-input').value)", "Retry after the re-probe");
    assert.equal(dictPosts.at(-1).headers["x-crow-dictation-profile"], "tag-2", "Retry carries the new tag");
  } finally { await s.close(); }
});

test("live (g): an unavailable probe leaves the composer exactly as it is without dictation", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  probe = { available: false, reason: "unreachable", maxSeconds: 60, cloud: false };
  const s = await tab(412, 730);
  try {
    for (const end = Date.now() + 3000; probeHits < 1 && Date.now() < end;) await sleep(50);
    await sleep(200);
    const st = await s.json(STATE);
    assert.equal(st.mic, false);
    assert.equal(st.bar, false);
    const geo = await s.json(`(function(){
      function r(){ var a=document.getElementById('perch-send').getBoundingClientRect(), b=document.getElementById('perch-composer').getBoundingClientRect();
        return [a.left,a.top,a.width,a.height,b.height].map(Math.round); }
      var withD=r();
      ['perch-dictate','perch-dictation-bar','perch-dictation-hint'].forEach(function(id){ var e=document.getElementById(id); e.parentNode.removeChild(e); });
      document.getElementById('perch-composer').classList.remove('has-dictate');
      return JSON.stringify({withD:withD, without:r()});
    })()`);
    assert.deepEqual(geo.withD, geo.without, "Send and the composer are where they are without dictation");
  } finally { await s.close(); }
  // Available but idle: the bar is not displayed either.
  resetApi();
  const s2 = await tab(412, 730);
  try {
    await s2.waitFor(MIC_SHOWN, "the mic");
    const st = await s2.json(STATE);
    assert.equal(st.bar, false);
    assert.equal(st.state, "idle");
  } finally { await s2.close(); }
});

test("live (h): a denied microphone shows the blocked note and leaves the composer intact", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    await s.evalIn("document.getElementById('perch-input').value='draft'; window.__dict.gum='deny'; 'ok'");
    await s.waitFor(MIC_SHOWN, "the mic");
    await s.click("perch-dictate");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='error'", "the error");
    let st = await s.json(STATE);
    assert.equal(st.status, "Microphone blocked: allow it in the browser or Crow app settings");
    assert.equal(st.retry, false, "nothing to retry without a recording");
    assert.ok(allClosed(st));
    assert.deepEqual(st.port, ["captureStarting", "captureEnded"]);
    await s.click("perch-dict-cancel");
    await s.waitFor(IDLE, "idle");
    st = await s.json(STATE);
    assert.equal(st.input, "draft");
    assert.equal(st.inputShown, true);
  } finally { await s.close(); }
});

test("live (i): a session switch while recording releases the mic; a late transcript never lands in the new session", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    await record(s);
    await s.evalIn(`location.hash='${SID2}'; 'ok'`);
    await s.waitFor(`document.getElementById('perch-composer').getAttribute('data-dictation')==='idle'&&location.hash==='#${SID2}'`, "the switch");
    let st = await s.json(STATE);
    assert.equal(st.bar, false);
    assert.ok(allEnded(st)); assert.ok(allClosed(st));

    await s.evalIn(`location.hash='${SID}'; 'ok'`);
    await s.waitFor(`location.hash==='#${SID}'&&getComputedStyle(document.getElementById('perch-dictate')).display!=='none'`, "back on the first session");
    dictDelayMs = 800;
    await record(s);
    await s.click("perch-dict-done");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='transcribing'", "transcribing");
    await s.evalIn(`location.hash='${SID2}'; 'ok'`);
    for (const end = Date.now() + 3000; dictPosts.length < 1 && Date.now() < end;) await sleep(50);
    await sleep(1200);
    st = await s.json(STATE);
    assert.equal(st.input, "", "the first session's transcript must not land in the second");
    assert.equal(st.state, "idle");
    assert.equal(sent.length, 0);
  } finally { await s.close(); }
});

test("live (j): 412px at the largest text size — the bar and the wrapped send row fit, with a turn in flight too", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(412, 730);
  try {
    await s.evalIn("document.documentElement.setAttribute('data-text-size','xlarge'); 'ok'");
    await record(s);
    const bar = await s.json(`(function(){
      var b=document.getElementById('perch-dictation-bar'), up=document.getElementById('perch-dict-send').getBoundingClientRect();
      var tabs=document.getElementById('perch-tabs').getBoundingClientRect();
      return JSON.stringify({sw:b.scrollWidth,cw:b.clientWidth,upIn:up.right<=innerWidth&&up.left>=0&&up.bottom<=innerHeight,
        tabs:tabs.height>0&&tabs.bottom<=innerHeight+1,h:document.documentElement.scrollWidth>document.documentElement.clientWidth});
    })()`);
    assert.ok(bar.sw <= bar.cw, `the bar overflows: ${bar.sw} > ${bar.cw}`);
    assert.equal(bar.upIn, true, "↑ inside the viewport");
    assert.equal(bar.tabs, true, "the bottom tabs stay visible");
    assert.equal(bar.h, false, "no horizontal page scroll");
    await s.click("perch-dict-cancel");
    await s.waitFor(IDLE, "idle");
    broadcast("state", { state: "awake", turnInFlight: true });
    await s.waitFor("document.getElementById('perch-send').textContent==='Steer'", "a turn in flight");
    const row = await s.json(`(function(){
      var r=document.querySelector('#perch-composer .send-row');
      function inV(id){ var b=document.getElementById(id).getBoundingClientRect(); return b.width>0&&b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&b.top>=0; }
      return JSON.stringify({sw:r.scrollWidth,cw:r.clientWidth,dictate:inV('perch-dictate'),steer:inV('perch-send'),stop:inV('perch-abort')});
    })()`);
    assert.ok(row.sw <= row.cw, `.send-row overflows: ${row.sw} > ${row.cw}`);
    assert.equal(row.dictate, true, "Dictate inside the viewport");
    assert.equal(row.steer, true, "Steer inside the viewport");
    assert.equal(row.stop, true, "Stop inside the viewport");
  } finally { await s.close(); }
});

test("live (k): a microphone that arrives after ✕, a session switch or a hidden page is released at once", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  for (const how of ["cancel", "switch", "hide"]) {
    resetApi();
    const s = await tab(1280, 900);
    try {
      await s.evalIn("window.__dict.gum='defer'; 'ok'");
      await s.waitFor(MIC_SHOWN, "the mic");
      await s.click("perch-dictate");
      await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='starting'&&!!window.__dict.held", "starting, with getUserMedia held");
      assert.match((await s.json(STATE)).status, /Starting microphone/);
      if (how === "cancel") await s.click("perch-dict-cancel");
      else if (how === "switch") await s.evalIn(`location.hash='${SID2}'; 'ok'`);
      else await s.evalIn("Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden';}}); document.dispatchEvent(new Event('visibilitychange')); 'ok'");
      await s.waitFor(IDLE, how + " → idle");
      await s.evalIn("window.__dict.held(); 'ok'");
      await s.waitFor("window.__dict.streams.length===1", "the held stream to resolve");
      await s.waitFor("window.__dict.streams[0].getTracks().every(function(t){return t.readyState==='ended';})", how + ": its tracks end at once");
      await sleep(200);
      const st = await s.json(STATE);
      assert.equal(st.state, "idle", how + ": no recording starts");
      assert.equal(st.bar, false);
      assert.ok(allClosed(st), how + ": context closed");
      assert.equal(dictPosts.length, 0);
    } finally { await s.close(); }
  }
});

test("live (l): the page going hidden while recording stops and transcribes into the composer", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(412, 730);
  try {
    await record(s);
    await s.evalIn("Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden';}}); document.dispatchEvent(new Event('visibilitychange')); 'ok'");
    await s.waitFor("document.getElementById('perch-input').value==='canned words'", "the text to land");
    assert.equal(dictPosts.length, 1);
    assert.ok(allEnded(await s.json(STATE)));
  } finally { await s.close(); }
});

test("live (m): a cloud profile shows 'Transcribed by …' under the bar; a local one does not", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  probe = { available: true, maxSeconds: 120, cloud: true, provider: "Groq Whisper", profileTag: "tag-c" };
  const s = await tab(412, 730);
  try {
    let st = await s.json(STATE);
    assert.equal(st.hint, false, "not while idle");
    await record(s);
    st = await s.json(STATE);
    assert.equal(st.hint, true);
    assert.equal(st.hintText, "Transcribed by Groq Whisper");
    assert.equal(await s.evalIn("document.getElementById('perch-dictation-hint').hasAttribute('aria-live')"), false);
    await s.click("perch-dict-cancel");
  } finally { await s.close(); }
});

test("live (n): a local player track pauses while recording and resumes after; glasses playback is left alone", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    const stub = (backend) => `window.crowPlayer={playing:true,toggles:0,backend:'${backend}',
      isPlaying:function(){return this.playing;},getBackend:function(){return this.backend;},
      toggle:function(){this.playing=!this.playing;this.toggles++;}}; 'ok'`;
    await s.evalIn(stub("local"));
    await record(s);
    assert.equal(await s.evalIn("window.crowPlayer.playing"), false, "paused while the mic is open");
    await s.click("perch-dict-done");
    await s.waitFor(IDLE, "idle");
    assert.equal(await s.evalIn("window.crowPlayer.playing"), true, "resumed after");
    assert.equal(await s.evalIn("window.crowPlayer.toggles"), 2);

    await s.evalIn(stub("glasses"));
    await record(s);
    await s.click("perch-dict-cancel");
    await s.waitFor(IDLE, "idle");
    assert.equal(await s.evalIn("window.crowPlayer.toggles"), 0, "glasses playback untouched");
  } finally { await s.close(); }
});

test("live (phone): Send stays reachable with the mic shown and the player bar reserve set", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(412, 730);
  try {
    await s.waitFor(MIC_SHOWN, "the mic");
    await s.evalIn("document.documentElement.style.setProperty('--crow-player-h','64px'); 'ok'");
    await sleep(100);
    const r = await s.json(`(function(){ var b=document.getElementById('perch-send').getBoundingClientRect();
      return JSON.stringify({ok:b.bottom<=innerHeight&&b.top>=0&&b.right<=innerWidth&&b.left>=0}); })()`);
    assert.equal(r.ok, true);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// review fixes (2026-10-21)
// ---------------------------------------------------------------------------

const LIST_VIEW = "document.body.getAttribute('data-view')!=='chat'";

test("live (o): back to the list while the mic is starting — the late stream is stopped, nothing uploads", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(412, 730);
  try {
    await s.evalIn("window.__dict.gum='defer'; 'ok'");
    await s.waitFor(MIC_SHOWN, "the mic");
    await s.click("perch-dictate");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='starting'&&!!window.__dict.held", "starting");
    await s.click("perch-back");
    await s.waitFor(LIST_VIEW, "the list");
    assert.equal((await s.json(STATE)).state, "idle");
    await s.evalIn("window.__dict.held(); 'ok'");
    await s.waitFor("window.__dict.streams.length===1&&window.__dict.streams[0].getTracks().every(function(t){return t.readyState==='ended';})", "the late stream's tracks to end");
    await sleep(400);
    const st = await s.json(STATE);
    assert.equal(st.state, "idle");
    assert.equal((await s.evalIn("(window.__dict.recs||[]).length")), 0, "no recorder was ever started");
    assert.deepEqual(st.port, ["captureStarting", "captureEnded"]);
    assert.equal(dictPosts.length, 0);
  } finally { await s.close(); }
});

test("live (p): back to the list while recording — the mic is released and nothing uploads", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(412, 730);
  try {
    await record(s);
    await s.click("perch-back");
    await s.waitFor(LIST_VIEW, "the list");
    await s.waitFor(IDLE, "idle");
    const st = await s.json(STATE);
    assert.ok(allEnded(st), "tracks ended: " + JSON.stringify(st.tracks));
    assert.ok(allClosed(st));
    assert.deepEqual(st.port, ["captureStarting", "captureEnded"]);
    await sleep(800);
    assert.equal(dictPosts.length, 0, "a hidden composer never uploads");
  } finally { await s.close(); }
});

test("live (q): a recorder error mid-recording still transcribes what was captured", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  try {
    await record(s);
    await sleep(1300);
    await s.evalIn("window.__dict.recs[window.__dict.recs.length-1].dispatchEvent(new Event('error')); 'ok'");
    await s.waitFor("document.getElementById('perch-input').value==='canned words'", "the text to land");
    assert.equal(dictPosts.length, 1);
    assert.ok(dictPosts[0].body.length > 0);
    assert.equal(dictPosts[0].body.subarray(0, 4).toString("hex"), "1a45dfa3");
  } finally { await s.close(); }
});

test("live (r): keyboard focus never drops to <body> — Cancel while transcribing, Retry on error, the textarea after Send", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900);
  const active = () => s.evalIn("document.activeElement&&document.activeElement.id");
  try {
    dictDelayMs = 700;
    await record(s);
    await s.click("perch-dict-done");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='transcribing'", "transcribing");
    assert.equal(await active(), "perch-dict-cancel");
    await s.waitFor(IDLE, "idle");
    assert.equal(await active(), "perch-input");

    dictDelayMs = 0;
    dictQueue = [{ status: 502, body: { error: "stt_failed" } }];
    await record(s);
    await s.click("perch-dict-done");
    await s.waitFor("document.getElementById('perch-composer').getAttribute('data-dictation')==='error'", "the error");
    assert.equal(await active(), "perch-dict-retry");
    await s.click("perch-dict-cancel");
    await s.waitFor(IDLE, "idle");

    await record(s);
    await s.click("perch-dict-send");
    await s.waitFor(IDLE, "idle after Send");
    for (const end = Date.now() + 3000; !sent.length && Date.now() < end;) await sleep(50);
    assert.equal(sent.length, 1);
    assert.equal(await active(), "perch-input");
  } finally { await s.close(); }
});
