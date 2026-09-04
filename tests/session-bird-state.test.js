// tests/session-bird-state.test.js
//
// sessionBirdState() (servers/gateway/dashboard/panels/bot-board/data-queries.js)
// is the pure fold from an engine session snapshot to the single bird glyph
// the board/roost draw for it — no DB, no server, no engine needed to test it
// directly.
//
// I3 (final review): "working" used to be granted to ANY awake session, with
// no check that a turn was actually in flight — an idle-awake session
// (parked between turns, e.g. right after dispatch claimed the card but
// before message() fired, or between a reply and the next send) drew the
// same active-work glyph as a session mid-turn. Gated on turnInFlight now
// that snapshot()/stateEvent() both expose it (perch-interactive.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionBirdState } from "../servers/gateway/dashboard/panels/bot-board/data-queries.js";

test("sessionBirdState: null session draws nothing", () => {
  assert.equal(sessionBirdState(null), null);
  assert.equal(sessionBirdState(undefined), null);
});

test("sessionBirdState: pendingUi always wins — 'waiting', regardless of state or turnInFlight", () => {
  assert.equal(sessionBirdState({ pendingUi: { requestId: "q1" }, state: "awake", turnInFlight: false }), "waiting");
  assert.equal(sessionBirdState({ pendingUi: { requestId: "q1" }, state: "hibernating", turnInFlight: false }), "waiting");
});

// I3's core fix.
test("sessionBirdState: awake + turnInFlight=true is 'working'", () => {
  assert.equal(sessionBirdState({ state: "awake", turnInFlight: true }), "working");
});

test("sessionBirdState: awake + turnInFlight=false (idle-awake, parked between turns) draws NO bird", () => {
  assert.equal(sessionBirdState({ state: "awake", turnInFlight: false }), null);
});

test("sessionBirdState: awake with turnInFlight undefined (an older/unmigrated snapshot shape) draws NO bird — fails closed, not open", () => {
  assert.equal(sessionBirdState({ state: "awake" }), null);
});

test("sessionBirdState: hibernating is 'hibernating' regardless of turnInFlight", () => {
  assert.equal(sessionBirdState({ state: "hibernating", turnInFlight: false }), "hibernating");
  assert.equal(sessionBirdState({ state: "hibernating", turnInFlight: true }), "hibernating");
});

test("sessionBirdState: any other state (stopped, unknown) draws nothing", () => {
  assert.equal(sessionBirdState({ state: "stopped", turnInFlight: true }), null);
  assert.equal(sessionBirdState({ state: "something-else" }), null);
});
