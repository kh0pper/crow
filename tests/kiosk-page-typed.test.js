/**
 * Queue item 17 (page half): type to Crow, and turn voice off with one tap.
 *
 * The page-side decisions (state.js, no DOM), the composer/toggle markup the page is built on
 * (kiosk.html), and the strings both languages need. The running page itself is
 * tests/kiosk-typed-live.test.js; the reply/caption path stays the one a spoken turn uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { STRINGS } from "../bundles/kiosk/server/strings.js";
import * as state from "../bundles/kiosk/public/state.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), "utf8");
/** An absent export is the missing feature, reported per case instead of as a module-load error. */
const fn = (name) => { assert.equal(typeof state[name], "function", `state.js exports ${name}()`); return state[name]; };
const val = (name) => { assert.ok(name in state, `state.js exports ${name}`); return state[name]; };

test("state.js: the voice-off storage key and the 500-character cap", () => {
  assert.equal(val("LS_VOICE_OFF"), "crow.kiosk.voice_off");
  assert.equal(val("MAX_TEXT_CHARS"), 500);
});

test("composeText: trimmed, cut to 500 characters, \"\" for a non-string or a blank one", () => {
  const composeText = fn("composeText");
  assert.equal(composeText("hello crow"), "hello crow");
  assert.equal(composeText("  hello  "), "hello");
  assert.equal(composeText("\n\t read the news \r\n"), "read the news");
  assert.equal(composeText("x".repeat(600)), "x".repeat(500), "longer text is cut at 500");
  assert.equal(composeText(`  ${"y".repeat(600)}  `), "y".repeat(500), "cut after the trim");
  assert.equal(composeText("z".repeat(500)), "z".repeat(500), "exactly the cap is kept whole");
  for (const v of ["", " ", "\n\t ", null, undefined, 42, true, {}, [], ["hi"]]) assert.equal(composeText(v), "", String(v));
});

test("voiceOffFromStorage: only the stored \"1\" means off", () => {
  const voiceOffFromStorage = fn("voiceOffFromStorage");
  assert.equal(voiceOffFromStorage("1"), true);
  for (const v of ["0", "", "true", " 1", "1 ", null, undefined, 1, true, {}]) assert.equal(voiceOffFromStorage(v), false, String(v));
});

const TAP_CASES = [
  [{ playing: true, birdState: "speaking", turnOpen: false }, "barge"],
  [{ playing: true, birdState: "idle", turnOpen: false }, "barge"],
  [{ playing: false, birdState: "speaking", turnOpen: false }, "barge"],
  [{ playing: false, birdState: "listening", turnOpen: true }, "stop"],
  [{ playing: false, birdState: "idle", turnOpen: true }, "stop"],
  [{ playing: false, birdState: "thinking", turnOpen: false }, "ignore"],
  [{ playing: false, birdState: "idle", turnOpen: false }, "start"],
];

test("tapDecision with voice on (false or absent): the whole existing table is unchanged", () => {
  const tapDecision = fn("tapDecision");
  for (const [input, want] of TAP_CASES) {
    const base = { halted: false, ...input };
    assert.equal(tapDecision(base), want, JSON.stringify(base));
    assert.equal(tapDecision({ ...base, voiceOff: false }), want, JSON.stringify(base));
  }
  assert.equal(tapDecision({ halted: false, playing: false, birdState: "idle", turnOpen: false, starting: true }), "ignore");
  assert.equal(tapDecision({ halted: false, playing: false, birdState: "idle", turnOpen: false, starting: true, voiceOff: false }), "ignore");
});

test("tapDecision with voice off: a slow reply or a playing one is cancelled (B5); an inert bird otherwise; a halted page still resumes", () => {
  const tapDecision = fn("tapDecision");
  for (const birdState of ["idle", "listening"]) {
    for (const turnOpen of [false, true]) {
      for (const starting of [false, true]) {
        const input = { halted: false, playing: false, birdState, turnOpen, starting, voiceOff: true };
        assert.equal(tapDecision(input), "ignore", JSON.stringify(input));
      }
    }
  }
  for (const birdState of ["thinking", "speaking"]) {
    for (const turnOpen of [false, true]) {
      for (const starting of [false, true]) {
        const input = { halted: false, playing: false, birdState, turnOpen, starting, voiceOff: true };
        assert.equal(tapDecision(input), "barge", `a slow reply can be cancelled (${JSON.stringify(input)})`);
      }
    }
  }
  for (const birdState of ["idle", "listening", "thinking", "speaking"]) {
    for (const turnOpen of [false, true]) {
      const input = { halted: false, playing: true, birdState, turnOpen, starting: false, voiceOff: true };
      assert.equal(tapDecision(input), "barge", `a playing reply is cancelled (${JSON.stringify(input)})`);
    }
  }
  assert.equal(tapDecision({ halted: true, playing: true, birdState: "speaking", turnOpen: true, voiceOff: true }), "resume", "halted is decided first");
  assert.equal(tapDecision({ halted: true, playing: false, birdState: "thinking", turnOpen: false, voiceOff: true }), "resume");
});

test("ttsStartDecision with voice off: nothing plays and nothing is booked as the turn's own audio", () => {
  const ttsStartDecision = fn("ttsStartDecision");
  const live = { ended: true, done: null, barged: false };
  const announcement = { ended: true, done: {}, barged: true };
  for (const turn of [live, announcement, { ended: false, done: null, barged: false }, null]) {
    assert.deepEqual(ttsStartDecision(turn, { voiceOff: true }), { play: false, own: false }, JSON.stringify(turn));
  }
  // Voice on (false or absent): the existing answers stay exactly as they are.
  assert.deepEqual(ttsStartDecision(live), { play: true, own: true });
  assert.deepEqual(ttsStartDecision(live, { voiceOff: false }), { play: true, own: true });
  assert.deepEqual(ttsStartDecision(announcement), { play: true, own: false });
  assert.deepEqual(ttsStartDecision(announcement, { voiceOff: false }), { play: true, own: false });
  assert.deepEqual(ttsStartDecision({ ended: true, done: null, barged: true }), { play: false, own: false });
  assert.deepEqual(ttsStartDecision(null), { play: true, own: false });
});

test("kiosk.html: the tools row with the two icon buttons, and the composer form under the captions", () => {
  const html = read("kiosk.html");
  const { document } = parseHTML(html);

  const tools = document.querySelector(".k-tools");
  assert.ok(tools, ".k-tools holds the two icon buttons");
  assert.deepEqual([...tools.querySelectorAll("button")].map((b) => b.id), ["type-btn", "voice-btn"]);
  for (const b of tools.querySelectorAll("button")) {
    assert.equal(b.getAttribute("type"), "button", `#${b.id} is a real button, not a form submit`);
    assert.equal(b.getAttribute("style"), null, `#${b.id} carries no inline style`);
    assert.ok(b.querySelector("svg"), `#${b.id} draws an inline SVG icon`);
    assert.doesNotMatch(b.textContent, /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `#${b.id} is not an emoji`);
  }
  const voiceBtn = document.getElementById("voice-btn");
  assert.ok(voiceBtn, "#voice-btn");
  assert.equal(voiceBtn.getAttribute("data-voice"), "on", "the page ships with voice on");

  const form = document.getElementById("compose");
  assert.ok(form, "#compose");
  assert.equal(form.tagName, "FORM");
  assert.equal(form.classList.contains("k-compose"), true);
  assert.equal(form.hasAttribute("hidden"), true, "the composer ships closed");
  assert.equal(form.getAttribute("style"), null);
  const captions = document.getElementById("captions");
  assert.ok(captions, "#captions");
  assert.equal(form.parentElement, captions.parentElement, "the composer sits in the captions' flow, not inside them");
  const siblings = [...form.parentElement.children];
  assert.ok(siblings.indexOf(captions) < siblings.indexOf(form), "and below the captions");

  const input = form.querySelector("input");
  assert.ok(input, "#compose-text");
  assert.equal(input.id, "compose-text");
  assert.equal(input.getAttribute("type"), "text");
  assert.equal(input.getAttribute("maxlength"), "500");
  assert.equal(input.getAttribute("autocomplete"), "off");
  assert.equal(input.getAttribute("enterkeyhint"), "send");
  assert.equal(input.getAttribute("style"), null);

  const send = form.querySelector("button");
  assert.ok(send, "#compose-send");
  assert.equal(send.id, "compose-send");
  assert.equal(send.getAttribute("type"), "submit");
  assert.equal(send.getAttribute("style"), null);
  assert.equal(form.querySelectorAll("input").length, 1, "one text field");
});

test("kiosk.js (source): the voice-off flag is a per-device setting in localStorage, and the page has no per-tab store", () => {
  const src = read("kiosk.js");
  assert.doesNotMatch(src, /sessionStorage/, "nothing in the page reads or writes sessionStorage");
  assert.doesNotMatch(src, /const store = \(/, "no storage factory: ls is the plain localStorage object");
  assert.match(src, /const ls = \{\n  get\(k\)/, "ls reaches localStorage directly");
  assert.match(src, /setVoiceOff\(voiceOffFromStorage\(ls\.get\(LS_VOICE_OFF\)\), true\)/, "the boot state comes from localStorage alone");
  const setter = src.slice(src.indexOf("function setVoiceOff("), src.indexOf("function sendTyped("));
  assert.match(setter, /if \(voiceOff\) ls\.set\(LS_VOICE_OFF, "1"\); else ls\.del\(LS_VOICE_OFF\);/, "off is written there, on is cleared there");
});

test("sendTyped (source): a finished mic turn is let go once the words have gone, so its settle cannot open an unasked follow-up", () => {
  const src = read("kiosk.js");
  const body = src.slice(src.indexOf("function sendTyped()"), src.indexOf("async function onTap()"));
  const sent = body.indexOf('send({ type: "text_turn"');
  assert.ok(sent >= 0, "sendTyped sends the text_turn frame");
  assert.match(body, /if \(turn && turn\.done\) turn = null;/, "the stale-turn guard, exactly so");
  assert.ok(body.indexOf("turn = null") > sent, "dropped only after the frame left");
  assert.ok(body.indexOf("typed = { id, text }") < body.indexOf("turn = null"), "and after the field was cleared and the words kept");
});

test("sendTyped (source), B4: with voice on the reply's audio output is set up in the gesture, and the microphone is never opened", () => {
  const src = read("kiosk.js");
  // The output setup is split out of ensureAudio(): a typed message needs a player, never a mic.
  const out = src.slice(src.indexOf("function ensureOutput()"), src.indexOf("async function ensureAudio()"));
  assert.ok(out.length > 50, "ensureOutput() is the output half of ensureAudio()");
  assert.match(out, /if \(!ctx\) ctx = new AudioContext\(\{ latencyHint: "interactive" \}\)/);
  assert.match(out, /if \(!player\) \{?\s*\n?\s*player = createPlayer\(ctx, \{/);
  assert.doesNotMatch(out, /openMic|micGate|getUserMedia/, "no microphone in the output setup");
  const audio = src.slice(src.indexOf("async function ensureAudio()"), src.indexOf("function onFrame("));
  assert.match(audio, /ensureOutput\(\)/, "the mic path sets the output up first, as today");
  assert.match(audio, /micGate\.acquire\(\)/);
  const body = src.slice(src.indexOf("function sendTyped()"), src.indexOf("async function onTap()"));
  const branch = body.slice(body.indexOf("if (!voiceOff)"), body.indexOf('send({ type: "text_turn"'));
  assert.match(branch, /ensureOutput\(\)/, "the typed message sets the output up itself");
  assert.match(branch, /player\?\.playing/, "a reply still playing is replaced by this message");
  assert.match(branch, /player\.flush\(\)/);
  assert.match(branch, /barge_in/);
  assert.ok(branch.indexOf("barge_in") < branch.indexOf("ensureOutput()"), "flushed and barged before the new turn");
  assert.doesNotMatch(body, /ensureAudio|openMic|micGate/, "a typed message never opens the mic");
});

test("B11: the message box is labelled with the same string as its placeholder", () => {
  const src = read("kiosk.js");
  const mount = src.slice(src.indexOf("function mountUi()"), src.indexOf("async function ensureOutput()"));
  assert.match(mount, /const ph = t\("type_placeholder"\);/, "the label text is the placeholder string");
  assert.match(mount, /\.placeholder = ph;/, "still the placeholder");
  assert.match(mount, /setAttribute\("aria-label", ph\)/, "and the same string is the accessible name");
});

test("B9: hello carries the stored voice-off choice, on the session socket and on the paired one", () => {
  const src = read("kiosk.js");
  const connect = src.slice(src.indexOf("function connect()"), src.indexOf("const send = "));
  assert.match(connect, /const hello = SESSION \? \{ type: "hello", mode: "session", csrf: cookie\("crow_csrf"\), caps: CAPS, tz: TZ, owner: barOwner \} : \{ type: "hello", device_id: id, token: tok, caps: CAPS, tz: TZ \};/, "one hello object for both sockets");
  assert.match(connect, /if \(voiceOff\) hello\.voice_off = true;/, "the stored choice rides it");
  assert.ok(connect.indexOf("hello.voice_off") < connect.indexOf("sock.send(JSON.stringify(hello))"), "set before it is sent");
});

test("B1 (css): the now-playing chip steps above an open composer, which it used to sit over and eat the taps of", () => {
  const css = read("kiosk.css");
  assert.match(css, /\.k-compose:not\(\[hidden\]\) ~ \.k-np-chip \{[^}]*bottom:\s*\d+px/, "a sibling rule lifts the chip while the composer is open");
});

test("B3 (css): the caption box is capped and scrolls, so a long reply cannot push the composer off the page", () => {
  const css = read("kiosk.css");
  const i = css.indexOf(".k-captions {");
  assert.ok(i >= 0, ".k-captions");
  const rule = css.slice(i, css.indexOf("}", i));
  assert.match(rule, /max-height:\s*\d/, ".k-captions has a max-height");
  assert.match(rule, /overflow:\s*auto/, "and it scrolls");
});

const NEW_KEYS = ["type_open", "type_close", "type_placeholder", "type_send", "voice_turn_off", "voice_turn_on", "voice_off_hint"];

test("strings: the seven new keys exist in en and es, and none is empty", () => {
  for (const k of NEW_KEYS) {
    assert.equal(typeof STRINGS.en?.[k], "string", `en.${k}`);
    assert.equal(typeof STRINGS.es?.[k], "string", `es.${k}`);
    assert.ok(STRINGS.en[k].trim(), `en.${k} is not empty`);
    assert.ok(STRINGS.es[k].trim(), `es.${k} is not empty`);
  }
});