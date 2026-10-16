/**
 * Bar on every Crow page (2026-10-16): NEW tabs, in a REAL browser. Once the artifact viewer carries the bar,
 * "Open in new window" opens a second bar-carrying tab every time. The rules (player.js):
 *  - H2 kiosk: a tab that did not start with its own nonce (new, or duplicated: its copied nonce is claimed by
 *    the live tab and re-minted) is never handed the item and never clears the shared marker;
 *  - H3 local: a playing item auto-resumes only in the tab that was playing it (the tab flag, consumed at load);
 *    a new or duplicated tab shows it paused, without pulsing;
 *  - the owning tab whose session is gone (restart, stop elsewhere, logout) says "Playback ended" (Q1).
 * Rig: tests/fixtures/bar-rig.mjs. Skips with no browser unless CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { startBarRig, openTab, until, sleep, BAR } from "./fixtures/bar-rig.mjs";

let chrome = null, rig = null;
before(async () => {
  rig = await startBarRig();
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => { if (chrome) await chrome.close(); rig?.close(); });

async function tab(targetId = null) {
  const tb = await openTab(chrome, { targetId });
  await tb.send("Network.enable");
  for (const c of rig.cookies()) await tb.send("Network.setCookie", c);
  return tb;
}
const isViewer = "!!document.getElementById('crow-artifact-viewer') && !!window.crowPlayer";
const isNest = "!!document.getElementById('h') && document.getElementById('h').textContent === 'Nest' && !!window.crowPlayer";
const playingNow = "(function(){ var a = document.getElementById('crow-audio'); return !!a && !a.paused && a.currentTime > 0.3; })()";
/** Long enough for the nonce claim (300 ms) and the GET to settle. */
const settle = () => sleep(1500);

async function stationOnBar(tb) {
  await tb.go(rig.base + "/dashboard/nest");
  assert.equal(await until(tb.evalIn, isNest), true);
  const owner = await tb.evalIn("window.crowPlayer.kioskOwner()");
  const load = rig.playStation(owner);
  await tb.evalIn(`(function(){ var P = window.crowPlayer; P.kioskAttach(function(){}, function(){ return true; });
    P.kioskApply(${JSON.stringify(load)}); P.kioskApply({ crow: 'media', v: 1, op: 'play', id: ${JSON.stringify(load.id)} });
    P.kioskDetach({ volume: 0.8, resume: true }); })()`);
  assert.equal(await until(tb.evalIn, playingNow), true);
  return owner;
}
async function localOnBar(tb) {
  await tb.go(rig.base + "/dashboard/nest");
  assert.equal(await until(tb.evalIn, isNest), true);
  await tb.evalIn("window.crowPlayer.load('/media/tone.wav', 'Episode 12', 'A podcast')");
  assert.equal(await until(tb.evalIn, playingNow), true);
  await sleep(300);
}
/** window.open from `from` (a real gesture): sessionStorage is copied, as "Duplicate tab" does. → the new tab. */
async function duplicate(from, path) {
  const beforeIds = new Set((await (await fetch(chrome.cdp + "/json/list")).json()).map((x) => x.id));
  await from.evalIn(`(window.open(${JSON.stringify(path)}), true)`, { gesture: true });
  let id = null;
  for (let i = 0; i < 50 && !id; i++) {
    await sleep(100);
    id = (await (await fetch(chrome.cdp + "/json/list")).json()).find((x) => x.type === "page" && !beforeIds.has(x.id))?.id || null;
  }
  assert.ok(id, "the duplicated tab opened");
  return tab(id);
}
const clearStorage = (tb) => tb.evalIn("(function(){ try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true; })()");

test("(a) H2: tab A plays the station; a NEW tab B opens the viewer: B shows no bar, never takes the item, leaves A's marker; A's reload restores its bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await tab();
  let b = null;
  try {
    const owner = await stationOnBar(a);
    const marker = await a.evalIn("localStorage.getItem('crow-player-state')");
    assert.equal(marker, JSON.stringify({ backend: "kiosk", title: "KPFT HD1" }));
    b = await tab();
    const g0 = rig.gets.length;
    await b.go(rig.base + rig.viewerHref);
    assert.equal(await until(b.evalIn, isViewer), true);
    await settle();
    const s = await b.evalIn(BAR);
    assert.equal(s.visible, false, "B: no bar " + JSON.stringify(s));
    assert.equal(s.marker, marker, "A's marker untouched");
    const bGets = rig.gets.slice(g0);
    assert.equal(bGets.length, 1);
    assert.notEqual(bGets[0].owner, owner, "B asked with its own nonce");
    assert.equal(bGets[0].item, false, "and was handed nothing");
    assert.equal(await a.evalIn(playingNow), true, "A still plays");
    await b.close(); b = null;
    await a.send("Page.reload");
    assert.equal(await until(a.evalIn, isNest), true);
    assert.equal(await until(a.evalIn, playingNow), true, "A's reload restores: " + JSON.stringify(await a.evalIn(BAR)));
    assert.equal((await a.evalIn(BAR)).title, "KPFT HD1");
  } finally { if (b) await b.close(); await clearStorage(a); await a.close(); }
});

test("(a') H2 duplicated: a tab opened from A (sessionStorage copied, nonce included) re-mints, shows no bar, keeps A's marker; A keeps its nonce and its bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await tab();
  let d = null;
  try {
    const owner = await stationOnBar(a);
    const marker = await a.evalIn("localStorage.getItem('crow-player-state')");
    d = await duplicate(a, rig.viewerHref);
    assert.equal(await until(d.evalIn, isViewer), true);
    await settle();
    const s = await d.evalIn(BAR);
    assert.equal(s.visible, false, JSON.stringify(s));
    assert.equal(s.marker, marker);
    assert.notEqual(await d.evalIn("window.crowPlayer.kioskOwner()"), owner, "the copy re-minted");
    assert.equal(await a.evalIn("window.crowPlayer.kioskOwner()"), owner);
    assert.equal(await a.evalIn(playingNow), true);
    await d.close(); d = null;
    await a.send("Page.reload");
    assert.equal(await until(a.evalIn, playingNow), true, "A's reload still restores");
  } finally { if (d) await d.close(); await clearStorage(a); await a.close(); }
});

test("(b)(c) H3: a playing local item — a NEW tab shows it paused, never plays, never pulses; the SAME tab's reload resumes it", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await tab();
  let b = null;
  try {
    await localOnBar(a);
    b = await tab();
    await b.go(rig.base + rig.viewerHref);
    assert.equal(await until(b.evalIn, isViewer), true);
    await settle();
    const s = await b.evalIn(BAR);
    assert.equal(s.visible, true, "B shows the item");
    assert.equal(s.title, "Episode 12");
    assert.equal(s.paused, true, "no second copy of the podcast");
    assert.equal(s.pulse, false, "paused WITHOUT pulsing");
    await b.close(); b = null;
    const was = await a.evalIn("document.getElementById('crow-audio').currentTime");
    await a.send("Page.reload");
    assert.equal(await until(a.evalIn, isNest), true);
    assert.equal(await until(a.evalIn, playingNow), true, "the same tab resumes: " + JSON.stringify(await a.evalIn(BAR)));
    const now = await a.evalIn("document.getElementById('crow-audio').currentTime");
    assert.ok(now >= was - 0.5, "from where it was, not from the start: " + now + " vs " + was);
  } finally { if (b) await b.close(); await clearStorage(a); await a.close(); }
});

test("(f) data usage: a PAUSED local item's page loads (its own tab's reload, a new tab's viewer) ask for no media; a tap there plays from the saved position", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await tab();
  let b = null;
  try {
    await localOnBar(a);
    await sleep(1200);
    await a.evalIn("window.crowPlayer.toggle()");
    assert.equal(await until(a.evalIn, "document.getElementById('crow-audio').paused"), true);
    const at = await a.evalIn("document.getElementById('crow-audio').currentTime");
    assert.ok(at > 1, "played a while: " + at);
    await a.go(rig.base + "/dashboard/artifacts");   // the paused tab moves on (pagehide saves wasPlaying:false)
    assert.equal(await until(a.evalIn, "!!document.getElementById('h') && document.getElementById('h').textContent === 'Library' && !!window.crowPlayer"), true);
    const m0 = rig.mediaHits.length;
    await a.send("Page.reload");
    assert.equal(await until(a.evalIn, "!!window.crowPlayer"), true);
    b = await tab();
    await b.go(rig.base + rig.viewerHref);
    assert.equal(await until(b.evalIn, isViewer), true);
    await settle();
    assert.equal(rig.mediaHits.length - m0, 0, "no metadata fetch on a paused item's page load: " + JSON.stringify(rig.mediaHits.slice(m0)));
    const s = await b.evalIn(BAR);
    assert.equal(s.visible, true);
    assert.equal(s.paused, true);
    assert.ok(Math.abs(JSON.parse(s.marker).time - at) < 0.3, "the position survives both page loads: " + s.marker + " vs " + at);
    await b.close(); b = null;
    await a.evalIn("window.crowPlayer.toggle()", { gesture: true });
    assert.equal(await until(a.evalIn, playingNow), true, JSON.stringify(await a.evalIn(BAR)));
    const now = await a.evalIn("document.getElementById('crow-audio').currentTime");
    assert.ok(now >= at - 0.3 && now < at + 3, "a tap plays from the saved position: " + now + " vs " + at);
  } finally { if (b) await b.close(); await clearStorage(a); await a.close(); }
});

test("(d) H3 duplicated: a tab opened from a tab that is playing a local item shows it paused (the live tab's flag is never in sessionStorage)", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await tab();
  let d = null;
  try {
    await localOnBar(a);
    // A has been reloaded once already in its life? Make it so: the flag then passed through sessionStorage.
    await a.send("Page.reload");
    assert.equal(await until(a.evalIn, playingNow), true);
    assert.equal(await a.evalIn("sessionStorage.getItem('crow-player-tab')"), null, "consumed at load");
    d = await duplicate(a, rig.viewerHref);
    assert.equal(await until(d.evalIn, isViewer), true);
    await settle();
    const s = await d.evalIn(BAR);
    assert.equal(s.visible, true);
    assert.equal(s.paused, true, JSON.stringify(s));
    assert.equal(s.pulse, false);
    assert.equal(await a.evalIn(playingNow), true, "A plays on");
  } finally { if (d) await d.close(); await clearStorage(a); await a.close(); }
});

test("(e) the owning tab whose session ended elsewhere (stopped from another device) while it was away: coming back says Playback ended and drops the marker", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const a = await tab();
  try {
    await stationOnBar(a);
    // Leave first, THEN stop: a page still open when the stream is cut notices by itself (the element's retry
    // gets a 404, the bar asks the server, says Playback ended and drops the marker), so a reload racing that
    // would find no marker. That page's own answer is right; this test is about the restore.
    await a.go("about:blank");
    assert.equal(await until(a.evalIn, "location.href === 'about:blank' && document.readyState === 'complete'"), true);
    rig.k.media.stop(rig.displayId);
    await a.go(rig.base + "/dashboard/nest");
    assert.equal(await until(a.evalIn, isNest), true);
    assert.equal(await until(a.evalIn, `(function(){ var s = ${BAR}; return s.visible && s.subtitle === 'Playback ended'; })()`), true, JSON.stringify(await a.evalIn(BAR)));
    const s = await a.evalIn(BAR);
    assert.equal(s.title, "KPFT HD1");
    assert.equal(s.marker, null);
  } finally { await clearStorage(a); await a.close(); }
});
