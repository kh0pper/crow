/**
 * Bar on every Crow page (2026-10-16), in a REAL browser: the artifact viewer carries the player bar and the
 * voice overlay's station keeps (re)playing through dashboard → viewer → back, by Back and by "← Library".
 *
 * tests/fixtures/bar-rig.mjs: real auth + Funnel middleware, the real kiosk runtime (B3 endpoint and the
 * /display/t/* ticket mount, MAX_CONCURRENT 2), the real artifacts router (viewer page, CSP, static files,
 * the core shell), real Turbo, the emitted player script. A private headless Chrome
 * (tests/fixtures/headless-chrome.mjs); skips with no browser unless CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { startBarRig, openTab, until, sleep, BAR } from "./fixtures/bar-rig.mjs";

const SHOTS = process.env.CROW_BAR_SHOTS_DIR || null;
let chrome = null, rig = null;

before(async () => {
  rig = await startBarRig();
  // The Crow app's WebView plays without a gesture (setMediaPlaybackRequiresUserGesture(false)).
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => { if (chrome) await chrome.close(); rig?.close(); });

async function tab(opts) {
  const tb = await openTab(chrome, opts);
  await tb.send("Network.enable");
  for (const c of rig.cookies()) await tb.send("Network.setCookie", c);
  return tb;
}
const isViewer = "!!document.getElementById('crow-artifact-viewer') && !!window.crowPlayer";
const isPage = (h) => `!!document.getElementById('h') && document.getElementById('h').textContent === ${JSON.stringify(h)} && !!window.crowPlayer`;
const playingNow = "(function(){ var a = document.getElementById('crow-audio'); return !!a && !a.paused && a.currentTime > 0.3; })()";

/** On the Nest page: the overlay plays a station and hands it to the bar (attach, load, play, detach/resume). */
async function stationOnBar(tb) {
  await tb.go(rig.base + "/dashboard/nest");
  assert.equal(await until(tb.evalIn, isPage("Nest")), true, "the Nest page loaded");
  const owner = await tb.evalIn("window.crowPlayer.kioskOwner()");
  const load = rig.playStation(owner);
  await tb.evalIn(`(function(){ var P = window.crowPlayer; P.kioskAttach(function(){}, function(){ return true; });
    P.kioskApply(${JSON.stringify(load)}); P.kioskApply({ crow: 'media', v: 1, op: 'play', id: ${JSON.stringify(load.id)} });
    P.kioskDetach({ volume: 0.8, resume: true }); })()`);
  assert.equal(await until(tb.evalIn, playingNow), true, "the station plays on the Nest bar: " + JSON.stringify({ el: await tb.evalIn("(function(){var a=document.getElementById('crow-audio');return [a.readyState,a.networkState,a.error&&a.error.code,a.currentTime,a.src.length]})()"), bar: await tb.evalIn(BAR), streams: rig.streams, logs: rig.logs }));
  return { owner, load };
}

test("(a)(b)(c) the station plays on the viewer, and after Back, and after ← Library; the server saw this tab's own nonce each time", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    const { owner } = await stationOnBar(tb);
    const g0 = rig.gets.length;
    await tb.evalIn("document.getElementById('viewer').click()");
    assert.equal(await until(tb.evalIn, isViewer), true, "the viewer loaded");
    assert.equal(await until(tb.evalIn, playingNow), true, "playing on the viewer: " + JSON.stringify(await tb.evalIn(BAR)));
    let s = await tb.evalIn(BAR);
    assert.equal(s.visible, true);
    assert.equal(s.title, "KPFT HD1");
    assert.deepEqual(rig.gets.slice(g0).map((g) => [g.owner, g.item]), [[owner, true]], "one GET, this tab's nonce, the item handed back");
    if (SHOTS) await tb.shot(join(SHOTS, "viewer-desktop-playing.png"));

    await tb.evalIn("history.back()");
    assert.equal(await until(tb.evalIn, isPage("Nest")), true);
    assert.equal(await until(tb.evalIn, playingNow), true, "playing after Back: " + JSON.stringify(await tb.evalIn(BAR)));

    await tb.evalIn("document.getElementById('viewer').click()");
    assert.equal(await until(tb.evalIn, isViewer), true);
    assert.equal(await until(tb.evalIn, playingNow), true);
    await until(tb.evalIn, "!!document.querySelector('.cv-nav-back')");
    await tb.evalIn("document.querySelector('.cv-nav-back').click()");
    assert.equal(await until(tb.evalIn, isPage("Library")), true, "← Library");
    assert.equal(await until(tb.evalIn, playingNow), true, "playing after ← Library: " + JSON.stringify(await tb.evalIn(BAR)));
    s = await tb.evalIn(BAR);
    assert.equal(s.title, "KPFT HD1");
    assert.ok(rig.gets.every((g) => g.owner === owner), "never another nonce");
    for (const l of rig.logs) assert.ok(!/\/display\/t\/[A-Za-z0-9_-]{22}/.test(l), "no ticket in the log");
  } finally { await tb.close(); }
});

test("I2: a fast viewer → Back → viewer loop (and a podcast-like track) never loses the bar; a refused stream (429) is named in the ring and the log", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    await stationOnBar(tb);
    // Each page leaves the moment its audio starts: the old page's stream is still closing as the next one opens.
    for (let i = 0; i < 4; i++) {
      await tb.evalIn("document.getElementById('viewer').click()");
      assert.equal(await until(tb.evalIn, isViewer), true);
      await until(tb.evalIn, "(function(){ var a = document.getElementById('crow-audio'); return !!a && !a.paused && a.currentTime > 0; })()", 5000);
      await tb.evalIn("history.back()");
      assert.equal(await until(tb.evalIn, isPage("Nest")), true);
      await until(tb.evalIn, "(function(){ var a = document.getElementById('crow-audio'); return !!a && !a.paused && a.currentTime > 0; })()", 5000);
    }
    await tb.evalIn("document.getElementById('viewer').click()");
    assert.equal(await until(tb.evalIn, isViewer), true);
    const ok = await until(tb.evalIn, playingNow, 12000);
    const s = await tb.evalIn(BAR);
    const refused = rig.streams.filter((x) => x.status === 429).length;
    t.diagnostic(`stream requests: ${rig.streams.filter((x) => x.start).length}, refused 429: ${refused}`);
    assert.equal(ok, true, `still playing after the loop (429s: ${refused}): ` + JSON.stringify(s));
    assert.equal(s.visible, true);
    // A track (not a station: it seeks, it is not live) through the same loop.
    await tb.evalIn("history.back()");
    assert.equal(await until(tb.evalIn, isPage("Nest")), true);
    const owner = await tb.evalIn("window.crowPlayer.kioskOwner()");
    const load = rig.playStation(owner, "Episode 12", "podcast");
    await tb.evalIn(`(function(){ var P = window.crowPlayer; P.kioskAttach(function(){}, function(){ return true; });
      P.kioskApply(${JSON.stringify(load)}); P.kioskApply({ crow: 'media', v: 1, op: 'play', id: ${JSON.stringify(load.id)} });
      P.kioskDetach({ volume: 0.8, resume: true }); })()`);
    assert.equal(await until(tb.evalIn, playingNow), true);
    for (let i = 0; i < 2; i++) {
      await tb.evalIn("document.getElementById('viewer').click()");
      assert.equal(await until(tb.evalIn, isViewer), true);
      assert.equal(await until(tb.evalIn, playingNow), true, "the track on the viewer: " + JSON.stringify(await tb.evalIn(BAR)));
      await tb.evalIn("history.back()");
      assert.equal(await until(tb.evalIn, isPage("Nest")), true);
      assert.equal(await until(tb.evalIn, playingNow), true, "the track after Back");
    }
    assert.equal((await tb.evalIn(BAR)).title, "Episode 12");
    if (refused) {
      assert.ok(rig.logs.some((l) => /429/.test(l)), "a 429 is logged by the ticket mount");
      assert.ok(s.ring.some((l) => /media error/.test(l)), "and named in the bar's ring");
    }
  } finally { await tb.close(); }
});

test("(d) a local https item on the viewer: the viewer's CSP allows it (media-src https:), no media-src violation", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    await tb.go(rig.base + rig.viewerHref);
    assert.equal(await until(tb.evalIn, isViewer), true);
    const csp = await tb.evalIn("fetch(location.href).then(function(r){ return r.headers.get('content-security-policy'); })");
    assert.match(csp, /media-src 'self' https: blob:/);
    await tb.evalIn("window.__v = []; document.addEventListener('securitypolicyviolation', function(e){ window.__v.push(e.violatedDirective + ' ' + e.blockedURI); });");
    // https cannot be served cheaply here: the same-origin tone plays, and an https src raises no media-src violation.
    await tb.evalIn("window.crowPlayer.load('/media/tone.wav', 'Episode 12')");
    assert.equal(await until(tb.evalIn, playingNow), true);
    await tb.evalIn("(function(){ var a = new Audio(); a.src = 'https://podcast.invalid/ep.mp3'; a.load(); })()");
    await sleep(800);
    assert.deepEqual((await tb.evalIn("window.__v")).filter((v) => /media-src/.test(v)), []);
    await tb.evalIn("window.crowPlayer.close()");
  } finally { await tb.close(); }
});

test("(f) H4: Perch's sheet frames the viewer: the frame has NO bar, and the server saw exactly one GET (the top page's)", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    await stationOnBar(tb);
    const g0 = rig.gets.length;
    await tb.go(rig.base + "/dashboard/perch");
    assert.equal(await until(tb.evalIn, isPage("Perch")), true);
    assert.equal(await until(tb.evalIn, "(function(){ var d = document.getElementById('sheet').contentDocument; return !!d && !!d.getElementById('crow-artifact-viewer') && d.readyState === 'complete'; })()"), true, "the viewer loaded in the frame");
    await sleep(800);
    assert.equal(await tb.evalIn("!!document.getElementById('sheet').contentDocument.getElementById('crow-player-bar')"), false, "no bar inside the frame");
    assert.equal(await tb.evalIn("typeof document.getElementById('sheet').contentWindow.crowPlayer"), "undefined", "no second player in the tab");
    assert.equal(rig.gets.length - g0, 1, "one GET: " + JSON.stringify(rig.gets.slice(g0)));
    assert.equal(await until(tb.evalIn, playingNow), true, "the Perch page's own bar plays");
    assert.equal(await tb.evalIn("document.querySelectorAll('audio').length + document.getElementById('sheet').contentDocument.querySelectorAll('audio').length"), 1, "one audio element in the tab");
  } finally { await tb.close(); }
});

for (const [name, width, height, mobile] of [["phone", 390, 844, true], ["wide", 1280, 800, false]]) {
  test(`(g) layout ${name} ${width}×${height}: the bar spans from the left edge, reserves its height, never covers the comment sheet/column; no horizontal scroll`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const tb = await tab({ width, height, mobile });
    try {
      await tb.go(rig.base + rig.viewerHref);
      assert.equal(await until(tb.evalIn, isViewer), true);
      await tb.evalIn("window.crowPlayer.load('/media/tone.wav', 'Episode 12', 'A podcast')");
      assert.equal(await until(tb.evalIn, playingNow), true);
      await sleep(300);
      await tb.evalIn("window.scrollTo(0, document.documentElement.scrollHeight)");
      await sleep(300);
      const g = await tb.evalIn(`(function(){
        var bar = document.getElementById('crow-player-bar').getBoundingClientRect();
        var side = document.querySelector('.cv-side'); var sb = side ? side.getBoundingClientRect() : null;
        var stage = document.querySelector('.cv-stage'); var st = stage ? stage.getBoundingClientRect() : null;
        return { barLeft: bar.left, barTop: bar.top, barH: bar.height, innerW: window.innerWidth,
          reserve: getComputedStyle(document.documentElement).getPropertyValue('--crow-player-h').trim(),
          sideBottom: sb && sb.height ? sb.bottom : null, sidePos: side ? getComputedStyle(side).position : null,
          stageBottom: st ? st.bottom : null, scrollW: document.documentElement.scrollWidth };
      })()`);
      if (SHOTS) await tb.shot(join(SHOTS, `viewer-${name}-${width}.png`));
      assert.equal(g.barLeft, 0, "no sidebar offset on the viewer");
      assert.ok(g.barH > 0 && g.reserve === Math.round(g.barH) + "px" || g.reserve === g.barH + "px", JSON.stringify(g));
      assert.ok(g.sideBottom != null, "the viewer drew its comment " + (mobile ? "sheet" : "column") + ": " + JSON.stringify(g));
      assert.ok(g.sideBottom <= g.barTop + 0.5, "the sheet/column ends above the bar: " + JSON.stringify(g));
      if (g.stageBottom != null) assert.ok(g.stageBottom <= g.barTop + 0.5, "scrolled to the end, the frame ends above the bar: " + JSON.stringify(g));
      assert.ok(g.scrollW <= g.innerW, "no horizontal scroll: " + JSON.stringify(g));
      await tb.evalIn("window.crowPlayer.close()");
    } finally { await tb.close(); }
  });
}

test("T7 restart: the item cannot come back — after a reload the bar says Playback ended (the old title, never a ticket path), × dismisses; in place, the cut stream ends it the same way", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const tb = await tab();
  try {
    await stationOnBar(tb);
    await tb.evalIn("document.getElementById('viewer').click()");
    assert.equal(await until(tb.evalIn, isViewer), true);
    assert.equal(await until(tb.evalIn, playingNow), true);
    rig.restart();
    // In place: the relayed stream is cut; the bar reports it and the restarted server knows nothing → ended.
    assert.equal(await until(tb.evalIn, `(function(){ var s = ${BAR}; return s.visible && s.subtitle === 'Playback ended'; })()`, 30000), true, "in place: " + JSON.stringify(await tb.evalIn(BAR)));
    // A reload after a restart: the tab's own session cannot come back.
    await stationOnBar(tb);
    await tb.evalIn("document.getElementById('viewer').click()");
    assert.equal(await until(tb.evalIn, playingNow), true);
    rig.restart();
    await tb.send("Page.reload");
    assert.equal(await until(tb.evalIn, isViewer), true);
    assert.equal(await until(tb.evalIn, `(function(){ var s = ${BAR}; return s.visible && s.subtitle === 'Playback ended'; })()`), true, JSON.stringify(await tb.evalIn(BAR)));
    const s = await tb.evalIn(BAR);
    assert.equal(s.title, "KPFT HD1");
    assert.ok(!/\/display\/t\//.test(s.title + s.subtitle));
    assert.equal(s.toggleDisabled, true);
    assert.equal(s.marker, null, "the marker is gone");
    if (SHOTS) await tb.shot(join(SHOTS, "viewer-playback-ended.png"));
    await tb.evalIn("document.getElementById('crow-player-close').click()");
    assert.equal((await tb.evalIn(BAR)).visible, false, "× dismisses it");
  } finally { await tb.close(); }
});

test("(e) Chrome's DEFAULT autoplay policy, a real click into the viewer: the bar is visible AND (playing OR ⏯ pulsing) — never hidden", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const plain = await startHeadlessChrome();
  if (!plain) return t.skip("no second headless Chrome");
  const tb = await openTab(plain);
  try {
    await tb.send("Network.enable");
    for (const c of rig.cookies()) await tb.send("Network.setCookie", c);
    await tb.go(rig.base + "/dashboard/nest");
    assert.equal(await until(tb.evalIn, isPage("Nest")), true);
    // The overlay's hand-off follows a real gesture (the user spoke after tapping Talk to Crow).
    await tb.click("#h");
    const owner = await tb.evalIn("window.crowPlayer.kioskOwner()");
    const load = rig.playStation(owner);
    await tb.evalIn(`(function(){ var P = window.crowPlayer; P.kioskAttach(function(){}, function(){ return true; });
      P.kioskApply(${JSON.stringify(load)}); P.kioskApply({ crow: 'media', v: 1, op: 'play', id: ${JSON.stringify(load.id)} });
      P.kioskDetach({ volume: 0.8, resume: true }); })()`, { gesture: true });
    assert.equal(await until(tb.evalIn, playingNow), true, "plays on the Nest bar");
    await tb.click("#viewer");
    assert.equal(await until(tb.evalIn, isViewer), true);
    const ok = await until(tb.evalIn, `(function(){ var s = ${BAR}; return s.visible && (s.playing || s.pulse); })()`, 10000);
    const s = await tb.evalIn(BAR);
    t.diagnostic(`default autoplay policy after a real click: ${s.playing ? "plays" : s.pulse ? "refused, ⏯ pulses" : "neither"}`);
    assert.equal(ok, true, JSON.stringify(s));
    assert.equal(s.title, "KPFT HD1");
  } finally { await tb.close(); await plain.close(); }
});
