// tests/card-brief.test.js
//
// Track 3 Task 2 — extract the "Work the following card" prompt block out
// of bridge.mjs into a pure, DB-free helper (card-brief.mjs) so the
// interactive dispatch rail (a later task) can compose the same brief.
// BYTE-IDENTITY of the bridge's composed prompt is the binding requirement:
// this golden is copied verbatim from the current bridge.mjs:688-695
// concatenation (fixed inputs substituted for cardId/status/statuses/plan),
// and stops at "...not a status write." — the trailing channel tail
// (" Then reply with a short summary for the gateway thread. One card
// only.") is caller-side and stays in bridge.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardBriefBlock } from "../scripts/pi-bots/card-brief.mjs";

test("card brief is byte-identical to the bridge's historical block", () => {
  const expected =
    "Work the following card.\n\nCARD #42 (current board status: todo; this board's statuses: todo, doing, done).\nPLAN:\n---\n" +
    "PLAN BODY\n---\n\nUser said: \"do card 42\"\n\n" +
    "Do the work the plan describes. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=42, an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
  const got = cardBriefBlock({
    cardId: 42, tasksDbPath: "/x", userLine: 'do card 42',
    planForCard: () => "PLAN BODY",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "doing", "done"], terminals: ["done"] }),
  });
  assert.equal(got, expected);
});

test("falls back to '(no plan)' when planForCard returns nothing", () => {
  const got = cardBriefBlock({
    cardId: 7, tasksDbPath: "/x", userLine: "hi",
    planForCard: () => null,
    cardStatus: () => "doing",
    boardVocab: () => ({ statuses: ["todo", "doing", "done"], terminals: ["done"] }),
  });
  assert.match(got, /PLAN:\n---\n\(no plan\)\n---/);
});
