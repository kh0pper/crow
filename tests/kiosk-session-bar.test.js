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
