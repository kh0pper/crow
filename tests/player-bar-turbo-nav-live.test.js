/**
 * The player bar's <audio> across Turbo Drive visits, in a REAL browser (bar-handoff fix, 2026-10-16).
 *
 * Root cause found on the phone ("play kpft", close the overlay, open Messages → the bar is paused): the
 * <audio> was data-turbo-permanent INSIDE the data-turbo-permanent bar. Turbo's Bardo then handles both: the
 * bar is moved into the new body (with the audio in it), and afterwards the audio is "preserved" a second
 * time — replaced in the bar by a cloneNode() copy, while its placeholder sits in the discarded new bar, so
 * the real element is left OUTSIDE the document. Chrome pauses a media element removed from the document.
 * The page then shows a dead clone and the player's closure drives a detached element (which is why ▶ then
 * "worked" across every later visit: nothing could remove it again).
 *
 * Here: real Turbo 8.0.5 (the vendored file), the real emitted player script, real media playback, a
 * private headless Chrome (tests/fixtures/headless-chrome.mjs). Skips with no browser unless
 * CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { playerBarHtml, playerBarJs } from "../servers/gateway/dashboard/shared/player.js";

const TURBO = readFileSync(new URL("../servers/gateway/public/vendor/turbo-8.0.5.umd.js", import.meta.url), "utf8");
/** Two minutes of a quiet 8 kHz tone: long enough to still be playing after a few visits. */
function wav(sec) {
  const n = 8000 * sec, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(10 * Math.sin(i / 5));
  return b;
}
const WAV = wav(120);
const page = (n) => `<!doctype html><html><head><meta charset="utf-8"><script>${TURBO}</script></head><body>
<h1>page ${n}</h1><a id="go" href="/p${n === 1 ? 2 : 1}">next</a>
${playerBarHtml("en")}
<script>${playerBarJs("en")}</script></body></html>`;

let chrome = null, server = null, base = "";
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/a.wav" || req.url.startsWith("/display/t/")) { res.writeHead(200, { "content-type": "audio/wav", "content-length": WAV.length }); return res.end(WAV); }
    if (req.url === "/p1" || req.url === "/p2") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page(req.url === "/p2" ? 2 : 1)); }
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  // The Crow app's WebView plays without a gesture (setMediaPlaybackRequiresUserGesture(false)).
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => { server?.closeAllConnections?.(); server?.close(); if (chrome) await chrome.close(); });

async function tab() {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expression) => { const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return o.exceptionDetails ? { threw: o.exceptionDetails.text } : o.result.value; };
  await send("Page.enable");
  return { send, evalIn, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(evalIn, expr, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await evalIn(expr); if (v === true || Date.now() > end) return v; await sleep(100); }
}
/** What the test needs to know after a visit: is the element the player drives the one on the page, and playing? */
const STATE = `(function(){ var d = document.getElementById('crow-audio'); return { h1: document.querySelector('h1').textContent, same: d === window.__a, inDoc: window.__a.isConnected, inBar: document.getElementById('crow-player-bar').contains(window.__a), paused: window.__a.paused, playing: window.crowPlayer.isPlaying(), pauses: window.__pauses }; })()`;

test("playing audio survives a Turbo visit and a Back (restore) visit: the same element stays in the bar and keeps playing", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    await tb.send("Page.navigate", { url: base + "/p1" });
    assert.equal(await until(tb.evalIn, "!!(window.crowPlayer && document.getElementById('crow-audio'))"), true);
    await tb.evalIn(`(function(){ window.__a = document.getElementById('crow-audio'); window.__pauses = 0; window.__a.addEventListener('pause', function(){ window.__pauses++; }); window.crowPlayer.load('/a.wav', 'A tone'); })()`);
    assert.equal(await until(tb.evalIn, "window.crowPlayer.isPlaying() && window.__a.currentTime > 0.2"), true, "it plays before any visit");

    await tb.evalIn("document.getElementById('go').click()");
    assert.equal(await until(tb.evalIn, "document.querySelector('h1').textContent === 'page 2'"), true);
    await sleep(600);
    let s = await tb.evalIn(STATE);
    assert.deepEqual({ same: s.same, inDoc: s.inDoc, inBar: s.inBar, paused: s.paused, playing: s.playing, pauses: s.pauses },
      { same: true, inDoc: true, inBar: true, paused: false, playing: true, pauses: 0 }, "after a visit: " + JSON.stringify(s));

    await tb.evalIn("history.back()");
    assert.equal(await until(tb.evalIn, "document.querySelector('h1').textContent === 'page 1'"), true);
    await sleep(600);
    s = await tb.evalIn(STATE);
    assert.deepEqual({ same: s.same, inDoc: s.inDoc, paused: s.paused, pauses: s.pauses }, { same: true, inDoc: true, paused: false, pauses: 0 }, "after Back: " + JSON.stringify(s));
    assert.equal(await tb.evalIn("document.querySelectorAll('#crow-audio').length"), 1, "one element, never a clone beside it");
  } finally { await tb.close(); }
});

test("the kiosk hand-off: overlay audio handed to the bar (detach, resume) keeps playing through a Turbo visit", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    await tb.send("Page.navigate", { url: base + "/p1" });
    assert.equal(await until(tb.evalIn, "!!(window.crowPlayer && document.getElementById('crow-audio'))"), true);
    // The validator only accepts ticket paths; serve the tone at one (any 22-char ticket id).
    await tb.evalIn(`(function(){
      window.__a = document.getElementById('crow-audio'); window.__pauses = 0; window.__a.addEventListener('pause', function(){ window.__pauses++; });
      var P = window.crowPlayer;
      P.kioskAttach(function(){}, function(){ return true; });
      P.kioskApply({ crow: 'media', v: 1, op: 'load', id: 'm1', url: '/display/t/AbCdEfGhIjKlMnOpQrSt_-/stream', title: 'KPFT', subtitle: '', source: 'radio', live: true, volume: 0.5, paused: false, has_next: false, has_previous: false });
      P.kioskApply({ crow: 'media', v: 1, op: 'pause', id: 'm1' });
      P.kioskDetach({ volume: 0.8, resume: true });
    })()`);
    assert.equal(await until(tb.evalIn, "!window.__a.paused && window.__a.currentTime > 0.2"), true, "detach with resume plays in the bar");
    await tb.evalIn("document.getElementById('go').click()");
    assert.equal(await until(tb.evalIn, "document.querySelector('h1').textContent === 'page 2'"), true);
    await sleep(600);
    const s = await tb.evalIn(STATE);
    assert.deepEqual({ same: s.same, inDoc: s.inDoc, paused: s.paused, pauses: s.pauses }, { same: true, inDoc: true, paused: false, pauses: 0 }, JSON.stringify(s));
  } finally { await tb.close(); }
});
