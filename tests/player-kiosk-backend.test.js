/**
 * Kiosk B3: the dashboard player bar's `kiosk` backend (servers/gateway/dashboard/shared/player.js).
 * The EMITTED script (playerBarJs) runs here against a linkedom document with a stubbed media element,
 * fake storage, fake timers and a fake fetch, so the validator embedded in it is the one tested.
 *
 *  - attached (the Talk to Crow frame is open): the frame drives the element with validated ops and
 *    hears the element's events back; the bar never calls the server.
 *  - detached (overlay closed, or after a reload): the bar's controls and the element's ended/error/stall
 *    go to /api/kiosk/session/media (POST {do,id,owner}, X-Crow-Csrf; GET with X-Crow-Owner).
 *  - S3: no ticket path is ever written to storage. S8: a 409 (or 401) clears the bar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { playerBarHtml, playerBarJs } from "../servers/gateway/dashboard/shared/player.js";

const T1 = "AbCdEfGhIjKlMnOpQrSt_-";
const T2 = "ZyXwVuTsRqPoNmLkJiHg-_";
const P1 = `/display/t/${T1}/stream`;
const P2 = `/display/t/${T2}/stream`;
const LOAD = { crow: "media", v: 1, op: "load", id: "m1", url: P1, title: "Morning Mix", subtitle: "Station", source: "radio", live: true, volume: 0.5, paused: false, has_next: false, has_previous: false };
const OWNER_RE = /^[A-Za-z0-9_-]{16,64}$/;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function mkStorage(map) {
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

/**
 * respond(url, opts) → { status, body } (default: 200 with an empty view).
 * local / session: Maps that stand for this tab's storage (pass the same ones again to "reload").
 */
function harness({ local = new Map(), session = new Map(), respond, BroadcastChannel } = {}) {
  session.set("crow-glasses-bundle", "false");          // no glasses probe traffic
  const { document, window } = parseHTML(`<html><head></head><body>${playerBarHtml("en")}</body></html>`);
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "other=1; crow_csrf=csrf-abc; x=2" });
  const audio = document.getElementById("crow-audio");
  const calls = [];
  let src = "";
  Object.assign(audio, { paused: true, ended: false, volume: 1, currentTime: 0, duration: NaN, refuse: null });
  const fire = (type) => audio.dispatchEvent(new window.Event(type));
  Object.defineProperty(audio, "src", { configurable: true, get: () => src, set: (v) => { src = String(v); calls.push(["src", src]); audio.paused = true; } });
  audio.play = () => {
    calls.push(["play"]);
    if (audio.refuse) { const e = new Error("refused"); e.name = audio.refuse; return Promise.reject(e); }
    if (audio.paused) { audio.paused = false; fire("play"); fire("playing"); }
    return Promise.resolve();
  };
  audio.pause = () => { calls.push(["pause"]); if (!audio.paused) { audio.paused = true; fire("pause"); } };
  audio.load = () => { calls.push(["load"]); };
  const realRemove = audio.removeAttribute.bind(audio);
  audio.removeAttribute = (k) => { if (k === "src") { src = ""; calls.push(["src", ""]); } return realRemove(k); };

  let clock = 0;
  const timers = [];
  const setT = (fn, ms) => { const t = { fn, at: clock + (ms || 0), dead: false }; timers.push(t); return t; };
  const clearT = (t) => { if (t) t.dead = true; };
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true; clock = due.at; due.fn();
    }
    clock = end;
  };
  const fetches = [];
  const fetch = (url, opts = {}) => {
    const rec = { url, method: (opts.method || "GET").toUpperCase(), headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
    fetches.push(rec);
    const r = (respond && respond(rec)) || { status: 200, body: { item: null, state: "none", has_next: false, has_previous: false, volume: 80, muted: false } };
    return Promise.resolve({ status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body });
  };
  const handlers = {};
  const navigator = { mediaSession: { metadata: null, setActionHandler: (k, fn) => { handlers[k] = fn; } } };
  function MediaMetadata(m) { Object.assign(this, m); }
  const listeners = {};
  const win = {
    innerWidth: 1200,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  const crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } };
  const noop = () => {};
  new Function("window", "document", "localStorage", "sessionStorage", "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "navigator", "MediaMetadata", "EventSource", "console", "crypto", "BroadcastChannel", playerBarJs("en"))(
    win, document, mkStorage(local), mkStorage(session), fetch, setT, clearT, () => 0, noop, navigator, MediaMetadata, undefined, { warn: noop, log: noop }, crypto, BroadcastChannel);
  const P = win.crowPlayer;
  const posted = [];
  let live = true;
  const attach = () => P.kioskAttach((m) => posted.push(m), () => live);
  const $ = (id) => document.getElementById(id);
  return {
    P, win, window, document, audio, calls, fire, fetches, posted, advance, handlers, local, session, attach, $,
    setLive: (v) => { live = v; },
    shown: () => $("crow-player-bar").style.display !== "none",
    events: (type) => posted.filter((m) => m.type === type),
    srcSets: () => calls.filter((c) => c[0] === "src" && c[1]).length,
  };
}
const view = (item, extra = {}) => ({ item, state: "playing", has_next: false, has_previous: false, volume: 80, muted: false, ...extra });
const ITEM1 = { id: "m1", url: P1, title: "Song One", subtitle: "Artist", source: "music", form: "audio", live: false };
const ITEM2 = { id: "m2", url: P2, title: "Song Two", subtitle: "Artist", source: "music", form: "audio", live: false };

// ─── the emitted script ─────────────────────────────────────────────────────

test("the emitted player script parses, carries the shared validator, and has no backtick", () => {
  for (const lang of ["en", "es"]) {
    const js = playerBarJs(lang);
    assert.doesNotThrow(() => new Function(js));
    assert.ok(!js.includes("`"));
    assert.match(js, /function validateFrameMessage\(/, "the validator from kiosk-media-protocol.js is embedded");
  }
});

// ─── T7: attached ───────────────────────────────────────────────────────────

test("attached load: the title is text, src is the ticket path, the bar shows, a live item hides the seek bar", () => {
  const h = harness();
  h.attach();
  h.P.kioskApply({ ...LOAD, title: "<b>Bold</b>" });
  assert.equal(h.P.getBackend(), "kiosk");
  assert.equal(h.$("crow-player-title").textContent, "<b>Bold</b>");
  assert.equal(h.$("crow-player-title").querySelector("b"), null, "never parsed as markup");
  assert.equal(h.audio.src, P1);
  assert.equal(h.audio.volume, 0.5);
  assert.ok(h.shown());
  assert.equal(h.$("crow-player-seek-wrap").style.display, "none", "a station has no seek bar");
  assert.equal(h.$("crow-player-source").textContent, "radio");
  assert.equal(h.calls.filter((c) => c[0] === "play").length, 0, "load never plays by itself: the frame asks");
  assert.equal(h.fetches.length, 0);
});

test("attached load: ⏮/⏭ follow has_previous/has_next; a library track keeps the seek bar", () => {
  const h = harness();
  h.attach();
  h.P.kioskApply({ ...LOAD, live: false, has_next: true, has_previous: false });
  assert.equal(h.$("crow-player-next").style.display, "block");
  assert.equal(h.$("crow-player-prev").style.display, "none");
  assert.equal(h.$("crow-player-seek-wrap").style.display, "block");
  h.P.kioskApply({ ...LOAD, id: "m2", url: P2, live: false, has_next: false, has_previous: true });
  assert.equal(h.$("crow-player-next").style.display, "none");
  assert.equal(h.$("crow-player-prev").style.display, "block");
});

test("attached: the same id + url again keeps src (a reopened overlay finds the radio still playing) and reports it playing", () => {
  const h = harness();
  h.attach();
  h.P.kioskApply(LOAD);
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  h.posted.length = 0;
  h.P.kioskApply(LOAD);
  assert.equal(h.srcSets(), 1, "src set once");
  assert.equal(h.audio.paused, false);
  assert.deepEqual(h.events("playing").map((m) => [m.crow, m.v, m.id]), [["media-event", 1, "m1"]]);
});

test("attached play: the result is posted back, ok or with the refusal's name", async () => {
  const h = harness();
  h.attach();
  h.P.kioskApply(LOAD);
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  await flush();
  assert.deepEqual(h.events("play-result").map((m) => [m.id, m.ok]), [["m1", true]]);
  assert.ok(h.events("playing").length >= 1, "the element's own events go back too");
  h.audio.pause();
  h.audio.refuse = "NotAllowedError";
  h.posted.length = 0;
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  await flush();
  assert.deepEqual(h.events("play-result").map((m) => [m.id, m.ok, m.name]), [["m1", false, "NotAllowedError"]]);
});

test("attached pause/volume/stop act on the element; ended is posted to the frame and never skips or calls the server", async () => {
  const h = harness();
  h.attach();
  h.P.kioskApply(LOAD);
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  h.P.kioskApply({ crow: "media", v: 1, op: "volume", id: "m1", volume: 0.075 });
  assert.equal(h.audio.volume, 0.075);
  h.P.kioskApply({ crow: "media", v: 1, op: "pause", id: "m1" });
  assert.equal(h.audio.paused, true);
  h.fire("ended");
  h.fire("error");
  h.advance(20_000);
  await flush();
  assert.equal(h.events("ended").length, 1);
  assert.equal(h.fetches.length, 0, "attached: the frame reports, the bar never POSTs");
  h.P.kioskApply({ crow: "media", v: 1, op: "stop", id: "m1" });
  assert.equal(h.shown(), false);
  assert.equal(h.P.getBackend(), "local");
  await flush();
  assert.equal(h.fetches.length, 0);
});

test("review 3: an op for another id, or with the bar not on the kiosk backend, never touches what plays", () => {
  const h = harness();
  h.attach();
  h.P.load("/media/a.mp3", "A podcast");
  h.audio.paused = false;
  for (const op of ["play", "pause", "stop"]) h.P.kioskApply({ crow: "media", v: 1, op, id: "m1" });
  h.P.kioskApply({ crow: "media", v: 1, op: "volume", id: "m1", volume: 0 });
  assert.equal(h.P.getBackend(), "local");
  assert.equal(h.audio.src, "/media/a.mp3");
  assert.equal(h.audio.volume, 1);
  assert.equal(h.audio.paused, false);
  assert.ok(h.shown());
  // On the kiosk backend, a stale id is ignored too.
  h.P.kioskApply(LOAD);
  h.P.kioskApply({ crow: "media", v: 1, op: "stop", id: "m9" });
  h.P.kioskApply({ crow: "media", v: 1, op: "volume", id: "m9", volume: 0 });
  assert.ok(h.shown());
  assert.equal(h.audio.volume, 0.5);
});

test("S2 at the bar too: a message the shared validator refuses is dropped whole", () => {
  const h = harness();
  h.attach();
  for (const bad of [{ ...LOAD, url: `https://evil.example${P1}` }, { ...LOAD, url: `${P1}?x` }, { ...LOAD, op: "eval" }, { ...LOAD, v: 2 }, [LOAD], null, "load"]) h.P.kioskApply(bad);
  assert.equal(h.P.getBackend(), "local");
  assert.equal(h.shown(), false);
  assert.equal(h.srcSets(), 0);
});

test("attached: ⏭/⏮/⏯/■ go to the frame as commands (the frame tells the server, and its mic gate decides a resume)", () => {
  const h = harness();
  h.attach();
  h.P.kioskApply({ ...LOAD, live: false, has_next: true });
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  h.P.next(); h.P.prev();
  assert.deepEqual(h.events("cmd").map((m) => [m.id, m.do]), [["m1", "next"], ["m1", "previous"]]);
  const plays = h.calls.filter((c) => c[0] === "play").length;
  h.P.toggle();
  assert.equal(h.audio.paused, false, "the bar's ⏯ never pauses the element itself while attached");
  assert.equal(h.events("cmd").at(-1).do, "pause");
  h.audio.pause();                                  // the frame's answer: a pause op
  h.handlers.play();                                // MediaSession / a headset button
  assert.equal(h.events("cmd").at(-1).do, "resume");
  assert.equal(h.calls.filter((c) => c[0] === "play").length, plays, "review: the bar's own play never bypasses the frame's mic gate");
  h.P.stop();
  assert.deepEqual(h.events("cmd").map((m) => m.do), ["next", "previous", "pause", "resume", "stop"]);
  assert.equal(h.shown(), false);
  assert.equal(h.fetches.length, 0);
});

test("detach: the frame's un-ducked level and resume are applied; afterwards nothing is posted to the frame", async () => {
  const h = harness();
  h.attach();
  h.P.kioskApply(LOAD);
  h.P.kioskApply({ crow: "media", v: 1, op: "volume", id: "m1", volume: 0.07 });
  h.P.kioskApply({ crow: "media", v: 1, op: "pause", id: "m1" });
  h.P.kioskDetach({ volume: 0.5, resume: true });
  assert.equal(h.audio.volume, 0.5);
  assert.equal(h.audio.paused, false, "the overlay closed while the music was held: it comes back");
  h.posted.length = 0;
  h.fire("pause");
  assert.equal(h.posted.length, 0);
  // A detach without a state (the backstop) changes nothing about the level.
  h.P.kioskDetach();
  assert.equal(h.audio.volume, 0.5);
});

test("review 2: 'attached' is computed live — a frame that has gone (Android Back swapped the body) counts as detached", async () => {
  const h = harness();
  h.attach();
  h.P.kioskApply({ ...LOAD, live: false });
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  h.setLive(false);
  h.posted.length = 0;
  h.fire("ended");
  await flush();
  assert.equal(h.posted.length, 0);
  assert.deepEqual(h.fetches.map((f) => [f.method, f.body && f.body.do, f.body && f.body.id]), [["POST", "ended", "m1"]]);
});

// ─── T8: detached ───────────────────────────────────────────────────────────

/** A bar playing ITEM1 detached (loaded through the frame, which then closed). */
function detached(respond) {
  const h = harness({ respond });
  h.attach();
  h.P.kioskApply({ crow: "media", v: 1, op: "load", id: "m1", url: P1, title: "Song One", subtitle: "Artist", source: "music", live: false, volume: 0.5, paused: false, has_next: true, has_previous: true });
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  h.P.kioskDetach({ volume: 0.5, resume: false });
  h.posted.length = 0;
  return h;
}

test("detached: every control POSTs {do, id, owner} with the CSRF header; ⏯ pauses at once", async () => {
  let n = 0;
  const h = detached((r) => (r.method === "POST" ? { status: 200, body: view(ITEM1, { state: r.body.do === "pause" ? "paused" : "playing" }) } : null));
  h.P.toggle(); await flush();
  assert.equal(h.audio.paused, true);
  h.P.toggle(); await flush();
  h.P.next(); await flush();
  h.P.prev(); await flush();
  const posts = h.fetches.filter((f) => f.method === "POST");
  assert.deepEqual(posts.map((f) => f.body.do), ["pause", "resume", "next", "previous"]);
  for (const f of posts) {
    n++;
    assert.equal(f.url, "/api/kiosk/session/media");
    assert.equal(f.body.id, "m1");
    assert.match(f.body.owner, OWNER_RE);
    assert.equal(f.body.owner, h.P.kioskOwner());
    assert.equal(f.headers["X-Crow-Csrf"], "csrf-abc");
    assert.equal(f.headers["Content-Type"], "application/json");
    assert.deepEqual(Object.keys(f.body).sort(), ["do", "id", "owner"]);
  }
  assert.equal(n, 4);
  assert.equal(h.posted.length, 0, "nothing to a frame that is gone");
});

test("detached ■ and ×: POST stop and the bar hides (decision c)", async () => {
  for (const verb of ["stop", "close"]) {
    const h = detached();
    h.P[verb]();
    await flush();
    assert.deepEqual(h.fetches.map((f) => [f.method, f.body.do, f.body.id]), [["POST", "stop", "m1"]], verb);
    assert.equal(h.shown(), false);
    assert.equal(h.audio.paused, true);
    assert.equal(h.P.getBackend(), "local");
  }
});

test("detached ended: POST {do:'ended', id} and the answer's next item loads and plays, at the server's level", async () => {
  const h = detached((r) => (r.method === "POST" ? { status: 200, body: view(ITEM2, { volume: 60 }) } : null));
  h.fire("ended");
  await flush();
  assert.deepEqual(h.fetches.map((f) => [f.body.do, f.body.id]), [["ended", "m1"]]);
  assert.equal(h.audio.src, P2);
  assert.equal(h.$("crow-player-title").textContent, "Song Two");
  assert.equal(h.audio.paused, false);
  assert.ok(Math.abs(h.audio.volume - 10 ** ((60 - 100) / 40)) < 1e-9, "0–100 from the server → the element's level");
  // The next control names the NEW id.
  h.P.next(); await flush();
  assert.equal(h.fetches.at(-1).body.id, "m2");
});

test("detached error: POST {do:'error'}; an empty answer clears the bar", async () => {
  const h = detached((r) => (r.method === "POST" ? { status: 200, body: view(null, { state: "none" }) } : null));
  h.fire("error");
  await flush();
  assert.deepEqual(h.fetches.map((f) => f.body.do), ["error"]);
  assert.equal(h.shown(), false);
});

test("review 9: detached, the kiosk backend keeps a stall watchdog that POSTs error; playing in time disarms it", async () => {
  const h = detached();
  h.fire("waiting");
  h.advance(10_000);
  h.fire("playing");
  h.advance(30_000);
  await flush();
  assert.equal(h.fetches.length, 0);
  h.fire("stalled");
  h.advance(15_000);
  await flush();
  assert.deepEqual(h.fetches.map((f) => [f.body.do, f.body.id]), [["error", "m1"]]);
});

test("S8: a 409 (superseded) clears the bar and never adopts anything; so does a 401", async () => {
  for (const status of [409, 401]) {
    const h = detached(() => ({ status, body: { error: "x" } }));
    h.P.next();
    await flush();
    assert.equal(h.shown(), false, String(status));
    assert.equal(h.P.getBackend(), "local");
    assert.equal(h.local.get("crow-player-state"), undefined, "the marker goes too");
  }
});

test("D4: a station reload answers retry_ms; the bar asks again (GET with its owner) after that time", async () => {
  const radio = { ...ITEM1, source: "radio", live: true };
  let gets = 0;
  const h = detached((r) => {
    if (r.method === "POST") return { status: 200, body: view({ ...radio, url: null }, { retry_ms: 3000 }) };
    gets++;
    return { status: 200, body: view({ ...radio, id: "m3", url: P2 }) };
  });
  h.fire("error");
  await flush();
  assert.equal(gets, 0);
  h.advance(2999); await flush();
  assert.equal(gets, 0);
  h.advance(1); await flush();
  assert.equal(gets, 1);
  const g = h.fetches.find((f) => f.method === "GET");
  assert.equal(g.url, "/api/kiosk/session/media");
  assert.equal(g.headers["X-Crow-Owner"], h.P.kioskOwner());
  assert.equal(h.audio.src, P2);
  assert.equal(h.audio.paused, false);
});

test("review 4: the bar leaving the kiosk backend (the Media app plays something) POSTs stop for its item", async () => {
  const h = detached();
  h.P.load("/media/b.mp3", "Other");
  await flush();
  assert.deepEqual(h.fetches.map((f) => [f.method, f.body.do, f.body.id]), [["POST", "stop", "m1"]]);
  assert.equal(h.P.getBackend(), "local");
  assert.equal(h.audio.src, "/media/b.mp3");
});

test("MediaSession next/pause on the lock screen reach the endpoint", async () => {
  const h = detached((r) => ({ status: 200, body: view(ITEM2) }));
  h.handlers.nexttrack();
  await flush();
  assert.deepEqual(h.fetches.map((f) => f.body.do), ["next"]);
});

test("S3: saveState writes no ticket path — every stored value is free of /display/t/", async () => {
  const local = new Map(), session = new Map();
  const h = harness({ local, session });
  h.attach();
  h.P.kioskApply(LOAD);
  h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
  h.fire("pause"); h.fire("play");
  h.advance(10_000);
  h.document.dispatchEvent(new h.window.Event("turbo:before-visit"));
  h.P.kioskDetach({ volume: 0.5, resume: false });
  h.advance(10_000);
  await flush();
  const stored = [...local.values(), ...session.values()];
  assert.ok(local.has("crow-player-state"), "the reload marker is written");
  assert.deepEqual(JSON.parse(local.get("crow-player-state")), { backend: "kiosk", title: "Morning Mix" });
  for (const v of stored) assert.ok(!String(v).includes("/display/t/"), v);
});

test("a reload restores by GET (with the tab's owner kept in sessionStorage); it plays only if play succeeds, else ⏯ pulses", async () => {
  const local = new Map([["crow-player-state", JSON.stringify({ backend: "kiosk", title: "Song One" })]]);
  const session = new Map([["crow-kiosk-bar-owner", "Owner_nonce-0123456789"]]);
  const h = harness({ local, session, respond: (r) => (r.method === "GET" ? { status: 200, body: view(ITEM1) } : null) });
  await flush();
  assert.equal(h.P.kioskOwner(), "Owner_nonce-0123456789");
  assert.deepEqual(h.fetches.map((f) => [f.method, f.url, f.headers["X-Crow-Owner"]]), [["GET", "/api/kiosk/session/media", "Owner_nonce-0123456789"]]);
  assert.equal(h.P.getBackend(), "kiosk");
  assert.equal(h.audio.src, P1);
  assert.equal(h.audio.paused, false);
  assert.ok(h.shown());

  const h2 = harness({ local: new Map(local), session: new Map(session), respond: (r) => (r.method === "GET" ? { status: 200, body: view(ITEM1) } : null) });
  h2.audio.refuse = "NotAllowedError";
  await flush();
  assert.ok(h2.shown());
  assert.equal(h2.audio.paused, true);
  assert.match(h2.$("crow-player-toggle").style.animation, /crow-pulse/);
});

test("a reload marker with nothing to restore (404: no kiosk; or an empty view) clears itself; a paused session stays paused", async () => {
  for (const r of [{ status: 404, body: { error: "not_found" } }, { status: 200, body: view(null) }]) {
    const local = new Map([["crow-player-state", JSON.stringify({ backend: "kiosk", title: "x" })]]);
    const h = harness({ local, respond: () => r });
    await flush();
    assert.equal(h.shown(), false);
    assert.equal(local.has("crow-player-state"), false);
  }
  const local = new Map([["crow-player-state", JSON.stringify({ backend: "kiosk", title: "x" })]]);
  const h = harness({ local, respond: () => ({ status: 200, body: view(ITEM1, { state: "paused" }) }) });
  await flush();
  assert.ok(h.shown());
  assert.equal(h.calls.filter((c) => c[0] === "play").length, 0);
});

test("the owner nonce: minted once per tab into sessionStorage, the server's shape, and never in localStorage", () => {
  const session = new Map(), local = new Map();
  const h = harness({ local, session });
  const o = h.P.kioskOwner();
  assert.match(o, OWNER_RE);
  assert.equal(h.P.kioskOwner(), o);
  assert.equal(session.get("crow-kiosk-bar-owner"), o);
  for (const v of local.values()) assert.ok(!String(v).includes(o));
  const again = harness({ session });
  assert.equal(again.P.kioskOwner(), o, "a reload of the same tab keeps it");
});

test("no fetch at all on a plain page load (no kiosk marker): the kiosk backend costs nothing until used", async () => {
  const h = harness();
  await flush();
  assert.equal(h.fetches.length, 0);
});

// ─── B3 client review ───────────────────────────────────────────────────────

/** A fake BroadcastChannel bus: a message reaches every OTHER open channel of the same name, asynchronously. */
function bcBus() {
  const chans = [];
  function BC(name) { this.name = name; this.onmessage = null; this.closed = false; chans.push(this); }
  BC.prototype.postMessage = function (data) {
    for (const c of chans) if (c !== this && c.name === this.name && !c.closed) setImmediate(() => c.onmessage && c.onmessage({ data: structuredClone(data) }));
  };
  BC.prototype.close = function () { this.closed = true; };
  return { BC, chans };
}
const KEY = "crow-kiosk-bar-owner";
const NONCE = "Owner_nonce-0123456789";

test("review 1: a duplicated tab (sessionStorage copied) finds its nonce held by a live tab and mints its own before it restores", async () => {
  const bus = bcBus();
  const a = harness({ session: new Map([[KEY, NONCE]]), BroadcastChannel: bus.BC });
  await flush(); a.advance(5000); await flush();
  assert.equal(a.P.kioskOwner(), NONCE, "alone: a reload keeps its nonce");
  const marker = JSON.stringify({ backend: "kiosk", title: "Song One" });
  const b = harness({ session: new Map([[KEY, NONCE]]), local: new Map([["crow-player-state", marker]]), BroadcastChannel: bus.BC, respond: (r) => (r.method === "GET" ? { status: 200, body: view(ITEM1) } : null) });
  assert.equal(b.fetches.length, 0, "the restore waits for the claim");
  await flush();
  const o = b.P.kioskOwner();
  assert.notEqual(o, NONCE);
  assert.match(o, OWNER_RE);
  assert.equal(b.session.get(KEY), o, "stored for this tab's reloads");
  assert.equal(a.P.kioskOwner(), NONCE, "the original keeps it");
  assert.deepEqual(b.fetches.map((f) => [f.method, f.headers["X-Crow-Owner"]]), [["GET", o]]);
});

test("review 1: a reload with nobody answering keeps the nonce and restores after the claim window; no BroadcastChannel restores at once", async () => {
  const bus = bcBus();
  const marker = JSON.stringify({ backend: "kiosk", title: "Song One" });
  const respond = (r) => (r.method === "GET" ? { status: 200, body: view(ITEM1) } : null);
  const h = harness({ session: new Map([[KEY, NONCE]]), local: new Map([["crow-player-state", marker]]), BroadcastChannel: bus.BC, respond });
  await flush();
  assert.equal(h.fetches.length, 0);
  h.advance(1000); await flush();
  assert.deepEqual(h.fetches.map((f) => [f.method, f.headers["X-Crow-Owner"]]), [["GET", NONCE]]);
  assert.equal(h.P.kioskOwner(), NONCE);
  function Broken() { throw new Error("no channel"); }
  const g = harness({ session: new Map([[KEY, NONCE]]), local: new Map([["crow-player-state", marker]]), BroadcastChannel: Broken, respond });
  assert.equal(g.fetches.length, 1, "degrades: restores at once with the stored nonce");
  assert.equal(g.fetches[0].headers["X-Crow-Owner"], NONCE);
});

test("review 2 (S3): leaving the kiosk backend through setBackend silences the element and drops the ticket src", () => {
  for (const type of ["local", "glasses"]) {
    const h = harness();
    h.attach();
    h.P.kioskApply(LOAD);
    h.P.kioskApply({ crow: "media", v: 1, op: "play", id: "m1" });
    h.P.setBackend(type);
    assert.equal(h.audio.paused, true, type);
    assert.equal(h.audio.src, "", type);
  }
});

test("review 2 (S3): saveState never stores a ticket src, whatever the backend", () => {
  const local = new Map();
  const h = harness({ local });
  h.P.load("/media/a.mp3", "A");
  h.audio.src = P1;
  h.document.dispatchEvent(new h.window.Event("turbo:before-visit"));
  for (const v of local.values()) assert.ok(!String(v).includes("/display/t/"), v);
});

test("review 4: a 403 clears the bar like a 401", async () => {
  const h = detached(() => ({ status: 403, body: { error: "forbidden" } }));
  h.P.next();
  await flush();
  assert.equal(h.shown(), false);
  assert.equal(h.P.getBackend(), "local");
});

test("review 4: a 5xx answering a detached ended/error keeps the bar, paused, ⏯ pulsing; a tap sends the report again", async () => {
  for (const verb of ["ended", "error"]) {
    let fail = true;
    const h = detached((r) => (r.method === "POST" ? (fail ? { status: 503, body: {} } : { status: 200, body: view(ITEM2) }) : null));
    h.fire(verb);
    await flush();
    assert.ok(h.shown(), verb);
    assert.equal(h.P.getBackend(), "kiosk");
    assert.equal(h.audio.paused, true);
    assert.match(h.$("crow-player-toggle").style.animation, /crow-pulse/);
    fail = false;
    h.P.toggle();
    await flush();
    assert.deepEqual(h.fetches.map((f) => f.body.do), [verb, verb], "the tap retries what the server never heard");
    assert.equal(h.audio.src, P2);
  }
  // Other verbs failing with a 5xx change nothing.
  const h = detached(() => ({ status: 500, body: {} }));
  h.P.next();
  await flush();
  assert.ok(h.shown());
  assert.doesNotMatch(String(h.$("crow-player-toggle").style.animation || ""), /crow-pulse/);
});

test("review 5: a reload during a station retry (url:null) keeps the saved title on the bar and asks again after retry_ms", async () => {
  const radio = { ...ITEM1, source: "radio", live: true };
  let gets = 0;
  const local = new Map([["crow-player-state", JSON.stringify({ backend: "kiosk", title: "Morning Mix" })]]);
  const h = harness({ local, respond: (r) => {
    if (r.method !== "GET") return null;
    gets++;
    return gets === 1 ? { status: 200, body: view({ ...radio, url: null }, { retry_ms: 2000 }) } : { status: 200, body: view(radio) };
  } });
  await flush();
  assert.equal(gets, 1);
  assert.ok(h.shown(), "the bar stays");
  assert.equal(h.$("crow-player-title").textContent, "Morning Mix");
  assert.ok(local.has("crow-player-state"), "the marker stays");
  h.advance(1999); await flush();
  assert.equal(gets, 1);
  h.advance(1); await flush();
  assert.equal(gets, 2);
  assert.equal(h.audio.src, P1);
  assert.equal(h.audio.paused, false);
  assert.equal(h.$("crow-player-title").textContent, "Song One");
});
