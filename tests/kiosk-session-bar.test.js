/**
 * Kiosk B3 (voice-overlay audio through the player bar), the hand-off protocol between the
 * Talk to Crow frame and the dashboard's player bar. Part 1: the pure validator the parent
 * runs on every `{ crow: "media" }` message (security invariant S2) before the bar is touched.
 * The same function text is embedded in the dashboard script (validatorSource), so this file
 * checks both the module export and the emitted source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KIOSK_MEDIA_V, FRAME_OPS, TICKET_PATH_RE, ITEM_ID_RE, validateFrameMessage, validatorSource } from "../servers/gateway/dashboard/shared/kiosk-media-protocol.js";
import { TICKET_ID } from "../bundles/kiosk/server/tickets.js";

const T = "AbCdEfGhIjKlMnOpQrSt_-";          // 22 characters, the ticket alphabet
const URL_OK = `/display/t/${T}/stream`;
const LOAD = { crow: "media", v: 1, op: "load", id: "m12", url: URL_OK, title: "Morning Mix", subtitle: "Station", source: "radio", live: true, volume: 0.5, paused: false, has_next: false, has_previous: false };

/** The emitted copy, evaluated the way the dashboard script does (no module scope). */
const emitted = new Function(validatorSource() + "\nreturn validateFrameMessage;")();

for (const [name, validate] of [["module", validateFrameMessage], ["emitted source", emitted]]) {
  test(`S2 validator table (${name}): every bad message is dropped whole`, () => {
    const bad = [
      ["https host", { ...LOAD, url: `https://evil.example/display/t/${T}/stream` }],
      ["protocol-relative", { ...LOAD, url: `//evil.example/display/t/${T}/stream` }],
      ["21-char ticket", { ...LOAD, url: `/display/t/${T.slice(1)}/stream` }],
      ["23-char ticket", { ...LOAD, url: `/display/t/${T}x/stream` }],
      ["query", { ...LOAD, url: `${URL_OK}?x` }],
      ["dot-dot", { ...LOAD, url: `${URL_OK}/..` }],
      ["javascript:", { ...LOAD, url: "javascript:alert(1)" }],
      ["non-ticket path", { ...LOAD, url: "/dashboard/settings" }],
      ["unknown op", { crow: "media", v: 1, op: "eval", id: "m1" }],
      ["detach is not a frame op", { crow: "media", v: 1, op: "detach", volume: 1, resume: true }],
      ["title 81", { ...LOAD, title: "x".repeat(81) }],
      ["subtitle 81", { ...LOAD, subtitle: "x".repeat(81) }],
      ["non-string title", { ...LOAD, title: 5 }],
      ["v:2", { ...LOAD, v: 2 }],
      ["v missing", (() => { const m = { ...LOAD }; delete m.v; return m; })()],
      ["not crow:media", { ...LOAD, crow: "media-event" }],
      ["__proto__ key", JSON.parse(`{"crow":"media","v":1,"op":"play","id":"m1","__proto__":{"x":1}}`)],
      ["unknown key", { ...LOAD, onload: "x" }],
      ["array payload", [LOAD]],
      ["null", null],
      ["string", "load"],
      ["bad id", { ...LOAD, id: "m" }],
      ["id too long", { ...LOAD, id: "m1234567890" }],
      ["id not m-number", { crow: "media", v: 1, op: "pause", id: "x1" }],
      ["play without id", { crow: "media", v: 1, op: "play" }],
      ["stop without id", { crow: "media", v: 1, op: "stop" }],
      ["volume without id", { crow: "media", v: 1, op: "volume", volume: 0.5 }],
      ["non-finite volume", { crow: "media", v: 1, op: "volume", id: "m1", volume: Infinity }],
      ["string volume", { crow: "media", v: 1, op: "volume", id: "m1", volume: "0.5" }],
      ["non-boolean live", { ...LOAD, live: "yes" }],
      ["non-boolean paused", { ...LOAD, paused: 1 }],
      ["source 17", { ...LOAD, source: "x".repeat(17) }],
      ["url missing", (() => { const m = { ...LOAD }; delete m.url; return m; })()],
    ];
    assert.ok(bad.length >= 12);
    for (const [why, msg] of bad) assert.equal(validate(msg), null, why);
  });

  test(`good messages round-trip as fresh plain objects (${name})`, () => {
    const out = validate(LOAD);
    assert.deepEqual(out, { op: "load", id: "m12", url: URL_OK, title: "Morning Mix", subtitle: "Station", source: "radio", live: true, volume: 0.5, paused: false, has_next: false, has_previous: false });
    assert.notEqual(out, LOAD);
    // Defaults for the optional load fields; volume is clamped, not refused.
    assert.deepEqual(validate({ crow: "media", v: 1, op: "load", id: "m1", url: URL_OK, title: "T", volume: 7 }),
      { op: "load", id: "m1", url: URL_OK, title: "T", subtitle: "", source: "", live: false, volume: 1, paused: false, has_next: false, has_previous: false });
    assert.equal(validate({ crow: "media", v: 1, op: "volume", id: "m1", volume: -3 }).volume, 0);
    assert.deepEqual(validate({ crow: "media", v: 1, op: "play", id: "m1" }), { op: "play", id: "m1" });
    assert.deepEqual(validate({ crow: "media", v: 1, op: "pause", id: "m1" }), { op: "pause", id: "m1" });
    assert.deepEqual(validate({ crow: "media", v: 1, op: "stop", id: "m1" }), { op: "stop", id: "m1" });
    assert.deepEqual(validate({ crow: "media", v: 1, op: "volume", id: "m1", volume: 0.25 }), { op: "volume", id: "m1", volume: 0.25 });
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });
}

test("the protocol constants: v1, the fixed op list, the item id shape", () => {
  assert.equal(KIOSK_MEDIA_V, 1);
  assert.deepEqual([...FRAME_OPS], ["load", "play", "pause", "volume", "stop"]);
  assert.ok(Object.isFrozen(FRAME_OPS));
  assert.ok(ITEM_ID_RE.test("m1") && ITEM_ID_RE.test("m123456789") && !ITEM_ID_RE.test("m1234567890"));
});

test("one source of truth: the ticket path pattern is the kiosk's own ticket id inside /display/t/…/stream", () => {
  assert.equal(TICKET_PATH_RE.source, "^\\/display\\/t\\/" + TICKET_ID.source.slice(1, -1) + "\\/stream$");
  assert.ok(TICKET_PATH_RE.test(URL_OK));
});

test("the emitted source is safe inside the dashboard's template-literal script: no backtick, no ${", () => {
  const src = validatorSource();
  assert.ok(!src.includes("`"));
  assert.ok(!src.includes("${"));
  assert.match(src, /function validateFrameMessage\(/);
});

// ─── Part 2 (T9): crow-talk.js, the hand-off in the dashboard document ───────────────────────────
import { parseHTML } from "linkedom";
import { crowTalkJs, crowTalkOverlayHtml, CROW_TALK_PATH } from "../servers/gateway/dashboard/shared/crow-talk.js";
import { tamagotchiHtml } from "../servers/gateway/dashboard/shared/notifications.js";

const ORIGIN = "https://crow.example.ts.net:8444";

/** The talk script against a linkedom page; `player` false = a dashboard whose player bar has no kiosk backend. */
function talk({ player = true } = {}) {
  const { document, window } = parseHTML(`<html><body>${crowTalkOverlayHtml("en")}<header>${tamagotchiHtml("en", { talkAvailable: true })}</header></body></html>`);
  const calls = [];
  const crowPlayer = player ? {
    kioskAttach: (post, isLive) => calls.push(["attach", post, isLive]),
    kioskApply: (m) => calls.push(["apply", m]),
    kioskDetach: (s) => calls.push(["detach", s]),
  } : undefined;
  const win = { document, location: { origin: ORIGIN }, navigator: {}, crowPlayer, _l: {}, addEventListener: (type, fn) => { (win._l[type] ||= []).push(fn); } };
  new Function("window", "document", "location", "navigator", "setTimeout", "clearTimeout", "Date", crowTalkJs())(win, document, win.location, win.navigator, setTimeout, clearTimeout, Date);
  const overlay = document.getElementById("crow-talk-overlay");
  const frame = () => overlay.querySelector("iframe");
  const framePosts = [];
  let release = { volume: 0.4, resume: true };
  const open = () => {
    win.openCrowTalk();
    const fw = { postMessage: (m, origin) => framePosts.push([m, origin]), crowKioskRelease: () => { calls.push(["release"]); return release; } };
    Object.defineProperty(frame(), "contentWindow", { configurable: true, value: fw });
    return fw;
  };
  const send = (data, { origin = ORIGIN, source } = {}) => win._l.message.forEach((fn) => fn({ data, origin, source }));
  return { win, document, window, overlay, frame, open, send, calls, framePosts, setRelease: (r) => { release = r; }, of: (k) => calls.filter((c) => c[0] === k) };
}

test("T9/D1: the overlay asks for bar mode (?bar=1) only when the player bar has the kiosk backend", () => {
  const a = talk();
  a.win.openCrowTalk();
  assert.equal(a.frame().getAttribute("src"), CROW_TALK_PATH + "?bar=1");
  const b = talk({ player: false });
  b.win.openCrowTalk();
  assert.equal(b.frame().getAttribute("src"), CROW_TALK_PATH, "an old core / no bar: today's in-page audio");
});

test("T9: a valid load from the live frame attaches the bar once and reaches kioskApply exactly once", () => {
  const h = talk();
  const fw = h.open();
  h.send(LOAD, { source: fw });
  h.send({ crow: "media", v: 1, op: "play", id: "m12" }, { source: fw });
  assert.equal(h.of("attach").length, 1);
  assert.deepEqual(h.of("apply").map((c) => c[1].op), ["load", "play"]);
  // The post function targets this origin only, and isLive follows the frame.
  const [, post, isLive] = h.of("attach")[0];
  post({ crow: "media-event", v: 1, id: "m12", type: "playing" });
  assert.deepEqual(h.framePosts, [[{ crow: "media-event", v: 1, id: "m12", type: "playing" }, ORIGIN]]);
  assert.equal(isLive(), true);
  h.win.closeCrowTalk();
  assert.equal(isLive(), false, "a removed frame is not live");
});

test("S1: refuses another origin / another window; S2: a bad url or an unknown op never reaches the bar", () => {
  const h = talk();
  const fw = h.open();
  h.send(LOAD, { origin: "https://evil.example", source: fw });
  h.send(LOAD, { source: {} });
  h.send(LOAD, { source: null });
  h.send({ ...LOAD, url: `https://evil.example${URL_OK}` }, { source: fw });
  h.send({ ...LOAD, op: "eval" }, { source: fw });
  h.send({ ...LOAD, v: 2 }, { source: fw });
  h.send([LOAD], { source: fw });
  assert.equal(h.of("apply").length, 0);
  assert.equal(h.of("attach").length, 0);
  // No frame open: nothing either.
  const g = talk();
  g.send(LOAD, { source: null });
  assert.equal(g.of("apply").length, 0);
});

test("review 1: close hands crowKioskRelease()'s {volume, resume} to kioskDetach, after the release, and once", () => {
  const h = talk();
  const fw = h.open();
  h.send(LOAD, { source: fw });
  h.win.closeCrowTalk();
  assert.deepEqual(h.calls.filter((c) => c[0] !== "apply" && c[0] !== "attach").map((c) => c[0]), ["release", "detach"]);
  assert.deepEqual(h.of("detach")[0][1], { volume: 0.4, resume: true });
  assert.equal(h.frame(), null);
  // A page that returns nothing (an older kiosk copy) still detaches, with no state.
  const g = talk();
  const gw = g.open();
  g.setRelease(undefined);
  g.send(LOAD, { source: gw });
  g.win.closeCrowTalk();
  assert.deepEqual(g.of("detach").map((c) => c[1]), [null]);
});

test("review 2: a Turbo visit (Android Back) closes the overlay the same way: release, then detach — on turbo:visit, so the shell's turbo:before-render listener count stays 1 (perch-hub-stream-leak)", () => {
  const h = talk();
  const fw = h.open();
  h.send(LOAD, { source: fw });
  h.document.dispatchEvent(new h.window.Event("turbo:before-render"));
  assert.equal(h.calls.filter((c) => c[0] === "detach").length, 0, "no before-render listener of its own");
  const ev = new h.window.Event("turbo:visit");
  h.document.dispatchEvent(ev);
  assert.deepEqual(h.calls.filter((c) => c[0] === "release" || c[0] === "detach").map((c) => c[0]), ["release", "detach"]);
  assert.equal(h.overlay.classList.contains("active"), false);
});

test("T9: messages from the previous frame are ignored after a reopen; the new frame attaches afresh", () => {
  const h = talk();
  const old = h.open();
  h.send(LOAD, { source: old });
  h.win.closeCrowTalk();
  const fresh = h.open();
  h.send(LOAD, { source: old });
  assert.equal(h.of("apply").length, 1, "the old window is not the frame any more");
  h.send(LOAD, { source: fresh });
  assert.equal(h.of("apply").length, 2);
  assert.equal(h.of("attach").length, 2);
});

test("bar-handoff (hypothesis 4): a pause/stop the closing frame posts during its release (its media-view letting go) lands after the close and never reaches the bar", () => {
  const h = talk();
  const fw = h.open();
  h.send(LOAD, { source: fw });
  // The frame's own teardown posts these; postMessage delivers them as later tasks, i.e. after closeTalk returned.
  const late = [{ crow: "media", v: 1, op: "pause", id: "m12" }, { crow: "media", v: 1, op: "stop", id: "m12" }];
  h.win.closeCrowTalk();
  for (const m of late) h.send(m, { source: fw });
  assert.deepEqual(h.of("apply").map((c) => c[1].op), ["load"], "nothing after the close");
  assert.deepEqual(h.calls.map((c) => c[0]).slice(-2), ["release", "detach"]);
});
