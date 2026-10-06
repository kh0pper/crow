/**
 * The turn context ([Now] date/time, [Display] open windows) rides on the user message; a small
 * model sometimes reads it back as part of its answer (live 2026-10-05: "Okay." → "[Now] Monday,
 * October 5, 2026, 7:23 PM (time zone America/Chicago) [Display] Open windows: none. Got it. …").
 * The echo gate removes it from what is spoken, captioned and saved, across streaming chunk
 * boundaries, and leaves every other bracket alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContextEchoGate, stripContextEcho, withTurnContext, TURN_CONTEXT_NOTE } from "../servers/gateway/voice/context-echo.js";

const NOW = "[Now] Monday, October 5, 2026, 7:23 PM (time zone America/Chicago)";
const DISPLAY = "[Display] Open windows: none.";
const CTX = `${NOW}\n${DISPLAY}`;
const LIVE = "[Now] Monday, October 5, 2026, 7:23 PM (time zone America/Chicago) [Display] Open windows: none. Got it. Is there anything specific you'd like me to help with?";
const ANSWER = "Got it. Is there anything specific you'd like me to help with?";

/** Stream `text` through a fresh gate in the given pieces; → everything the gate let out. */
function stream(pieces, contexts = [CTX]) {
  const g = createContextEchoGate(contexts);
  let out = "";
  for (const p of pieces) out += g.feed(p);
  return out + g.flush();
}
const chars = (s) => [...s];

test("the exact live reply: the echoed [Now] and [Display] lines are gone, the answer stays", () => {
  assert.equal(stripContextEcho(LIVE, [CTX]), ANSWER);
});

test("the live reply streamed one character at a time", () => {
  assert.equal(stream(chars(LIVE)), ANSWER);
});

test("the live reply split in two at EVERY position (each tag and line cut across chunks)", () => {
  for (let i = 0; i <= LIVE.length; i++) {
    assert.equal(stream([LIVE.slice(0, i), LIVE.slice(i)]), ANSWER, `split at ${i}: ${JSON.stringify(LIVE.slice(Math.max(0, i - 6), i))}|`);
  }
});

test("the live reply in three pieces at every pair of positions inside the context", () => {
  const end = LIVE.indexOf("Got it.");
  for (let i = 0; i < end; i += 3) {
    for (let j = i; j <= end + 2; j += 4) {
      assert.equal(stream([LIVE.slice(0, i), LIVE.slice(i, j), LIVE.slice(j)]), ANSWER, `split at ${i}/${j}`);
    }
  }
});

test("nothing that could still be an echo is let out early: a chunk ending inside a tag is held", () => {
  const g = createContextEchoGate([CTX]);
  assert.equal(g.feed("Sure. [No"), "Sure. ");
  assert.equal(g.feed("w] Monday, October 5"), "");
  assert.equal(g.feed(", 2026, 7:23 PM (time zone America/Chicago) It is late."), "It is late.");
  assert.equal(g.flush(), "");
});

test("the context lines exactly as injected (one per line, blank line after)", () => {
  assert.equal(stripContextEcho(`${CTX}\n\n${ANSWER}`, [CTX]), ANSWER);
});

test("an echo in the middle of an answer is removed with its trailing space", () => {
  assert.equal(stripContextEcho(`Sure. ${DISPLAY} It is sunny.`, [CTX]), "Sure. It is sunny.");
  assert.equal(stream(chars(`Sure. ${DISPLAY} It is sunny.`)), "Sure. It is sunny.");
});

test("only one of the lines echoed, either one", () => {
  assert.equal(stripContextEcho(`${DISPLAY} Hello!`, [CTX]), "Hello!");
  assert.equal(stripContextEcho(`${NOW} Hello!`, [CTX]), "Hello!");
});

test("whitespace and case differences in the echo still match the injected line", () => {
  assert.equal(stripContextEcho("[Now]  monday, October 5, 2026,\n7:23 PM (time zone America/Chicago)\nHello.", [CTX]), "Hello.");
});

test("a tag the model reworded: the tag and its sentence go, the answer after it stays", () => {
  assert.equal(stripContextEcho("[Now] It is Monday evening. Got it.", [CTX]), "Got it.");
  assert.equal(stripContextEcho("[Display] No windows are open.\nHow can I help?", [CTX]), "How can I help?");
  assert.equal(stream(chars("[Now] It is Monday evening. Got it.")), "Got it.");
});

test("a reworded tag line that never ends: dropped at the end of the stream (the turn's no-text fallback then speaks)", () => {
  assert.equal(stream(chars("[Display] nothing open")), "");
});

test("the extra note lines (e.g. a must-run note) are removed when passed as context", () => {
  const MUST = "[Display] Nothing has been put on the screen in this turn yet. Call crow_wm now.";
  assert.equal(stripContextEcho(`${MUST} Here is your list.`, [CTX, MUST]), "Here is your list.");
});

test("the per-turn note line is itself removed if echoed", () => {
  const ctx = withTurnContext(CTX, "Okay.");
  assert.equal(stripContextEcho(`${TURN_CONTEXT_NOTE} Got it.`, [CTX, TURN_CONTEXT_NOTE]), "Got it.");
  assert.ok(ctx.includes(TURN_CONTEXT_NOTE));
});

test("legitimate brackets in a normal answer are never touched", () => {
  const samples = [
    "Press [Enter] to continue.",
    "The array is [1, 2, 3].",
    "It said [sic] in the original.",
    "Open the [Now Playing] screen.",
    "Ratings [now] are higher.",
    "A lone [ bracket and a ] closer.",
    "Ends with an open bracket [",
    "Ends inside a tag-looking word [Disp",
  ];
  for (const s of samples) {
    assert.equal(stripContextEcho(s, [CTX]), s, s);
    assert.equal(stream(chars(s)), s, `streamed: ${s}`);
  }
});

test("with no turn context the gate passes everything through untouched, bracket tags included", () => {
  assert.equal(stream(chars(LIVE), []), LIVE);
  assert.equal(stripContextEcho(LIVE, [null, ""]), LIVE);
});

test("the tags are read off the context itself: a glasses context with [Now] only does not strip [Display]", () => {
  assert.equal(stripContextEcho(`${NOW} ${DISPLAY} Hi.`, [NOW]), `${DISPLAY} Hi.`);
});

test("withTurnContext: the context lines, the note line, a blank line, then the user's own words last", () => {
  assert.equal(withTurnContext(CTX, "Okay."), `${CTX}\n${TURN_CONTEXT_NOTE}\n\nOkay.`);
  assert.equal(withTurnContext("", "Okay."), "Okay.");
  assert.equal(withTurnContext(null, "Okay."), "Okay.");
  assert.match(TURN_CONTEXT_NOTE, /^\[[A-Z][a-z]+\] /, "the note is a tagged line too, so an echo of it is removed");
});
