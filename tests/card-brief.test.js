// tests/card-brief.test.js
//
// Track 3 Task 2 — the "Work the following card" prompt block lives in a
// pure, DB-free helper (card-brief.mjs) so the mail/discord bridge and the
// interactive dispatch rail compose the same brief by construction (both
// call this one builder — byte-identity between the two callers is
// guaranteed without a golden per caller). Track 3 acceptance F1: the brief
// carries the card's own title and description, so a card with no plan
// record still tells the bot what to do. The trailing channel tail (" Then
// reply with a short summary for the gateway thread. One card only.") is
// caller-side and stays in bridge.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardBriefBlock } from "../scripts/pi-bots/card-brief.mjs";

test("card brief carries the card's title and description above the plan", () => {
  const expected =
    "Work the following card.\n\nCARD #42 — Fix the login redirect (current board status: todo; this board's statuses: todo, doing, done).\n" +
    "DESCRIPTION:\n---\nUsers land on /dashboard/login twice.\n---\nPLAN:\n---\n" +
    "PLAN BODY\n---\n\nUser said: \"do card 42\"\n\n" +
    "Do the work the plan describes; if there is no plan, do what the card's title and description ask. You may use board_move_item to update this card's status " +
    "as you go (only ever use this board's statuses). When you are done, call board_report_result " +
    "with item_id=42, an outcome of success/failure/partial, and a summary_md describing " +
    "what you did — that call is what ends the run, not a status write.";
  const got = cardBriefBlock({
    cardId: 42, tasksDbPath: "/x", userLine: 'do card 42',
    planForCard: () => "PLAN BODY",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "doing", "done"], terminals: ["done"] }),
    cardText: () => ({ title: "Fix the login redirect", description: "Users land on /dashboard/login twice." }),
  });
  assert.equal(got, expected);
});

test("no plan + no description: both blocks say so, title still present", () => {
  const got = cardBriefBlock({
    cardId: 7, tasksDbPath: "/x", userLine: "Work this card.",
    planForCard: () => null, cardStatus: () => "pending",
    boardVocab: () => ({ statuses: ["pending", "done"], terminals: ["done"] }),
    cardText: () => ({ title: "Say hello", description: null }),
  });
  assert.match(got, /^Work the following card\.\n\nCARD #7 — Say hello \(current board status: pending; this board's statuses: pending, done\)\.\nDESCRIPTION:\n---\n\(none\)\n---\nPLAN:\n---\n\(no plan\)\n---\n/);
});

test("cardText omitted (legacy caller): no title dash, description (none)", () => {
  const got = cardBriefBlock({
    cardId: 9, tasksDbPath: "/x", userLine: "x",
    planForCard: () => "P", cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo"], terminals: [] }),
  });
  assert.match(got, /^Work the following card\.\n\nCARD #9 \(current board status: todo; this board's statuses: todo\)\.\nDESCRIPTION:\n---\n\(none\)\n---\n/);
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
