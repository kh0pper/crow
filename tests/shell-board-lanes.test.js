// Task 3.1: the Board tab's lanes come from real card, result, decision and session state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOARD_DEF } from "../servers/gateway/routes/board-defs.js";
import { LANES, laneOf, openDecision, groupByLane } from "../servers/gateway/dashboard/panels/board/lanes.js";

const decision = (extra = {}) => JSON.stringify({ decision: { question: "q", options: [{ label: "a" }, { label: "b" }], ...extra } });

test("a recorded result needs you even while locked", () => {
  assert.equal(laneOf({ status: "in_progress", latest_result_status: "recorded" }, DEFAULT_BOARD_DEF, { locked: true }), "needs_you");
});

test("action_needed needs you; blank does not", () => {
  assert.equal(laneOf({ status: "pending", action_needed: " review it " }, DEFAULT_BOARD_DEF, { locked: false }), "needs_you");
  assert.equal(laneOf({ status: "pending", action_needed: "   " }, DEFAULT_BOARD_DEF, { locked: false }), "up_next");
});

test("an open decision needs you; a chosen or expired one doesn't", () => {
  const def = DEFAULT_BOARD_DEF;
  assert.equal(laneOf({ status: "pending", data_json: decision() }, def, { locked: false }), "needs_you");
  assert.equal(laneOf({ status: "pending", data_json: JSON.parse(decision()) }, def, { locked: false }), "needs_you");
  assert.equal(laneOf({ status: "pending", data_json: decision({ chosen: { index: 0 } }) }, def, { locked: false }), "up_next");
  assert.equal(laneOf({ status: "pending", data_json: decision({ expired_at: "2026-10-01" }) }, def, { locked: true }), "working");
  assert.equal(laneOf({ status: "pending", data_json: "{not json" }, def, { locked: false }), "up_next");
  assert.equal(openDecision({ data_json: null }), false);
  assert.equal(openDecision({}), false);
  assert.equal(openDecision({ data_json: '{"x":1}' }), false);
});

test("in progress without a session is up next", () => {
  assert.equal(laneOf({ status: "in_progress" }, DEFAULT_BOARD_DEF, { locked: false }), "up_next");
});

test("a held card is working", () => {
  assert.equal(laneOf({ status: "pending" }, DEFAULT_BOARD_DEF, { locked: true }), "working");
});

test("terminal per the card's own board", () => {
  const def = { ...DEFAULT_BOARD_DEF, status_values: ["pending", "shipped", "done"], terminal_values: ["shipped"] };
  assert.equal(laneOf({ status: "shipped" }, def, { locked: false }), "done");
  assert.equal(laneOf({ status: "done" }, def, { locked: false }), "up_next");
});

test("a cancelled card is done", () => {
  assert.equal(laneOf({ status: "cancelled", latest_result_status: "recorded" }, DEFAULT_BOARD_DEF, { locked: true }), "done");
});

test("groupByLane uses each card's project def", () => {
  const shipDef = { ...DEFAULT_BOARD_DEF, terminal_values: ["shipped"] };
  const defs = new Map([[1, shipDef], [null, DEFAULT_BOARD_DEF]]);
  const cards = [
    { id: 3, project_id: 1, status: "shipped", priority: 1 },
    { id: 2, project_id: 2, status: "done", priority: 1 },   // no entry -> null entry
    { id: 1, project_id: 1, status: "done", priority: 1 },
    { id: 5, project_id: 2, status: "pending", priority: 0 },
    { id: 4, project_id: 2, status: "pending", priority: 0 },
    { id: 6, project_id: 2, status: "pending", priority: 2 },
  ];
  const lockMap = new Map(cards.map((c) => [c.id, c.id === 6])); // every id present, mostly false
  const g = groupByLane(cards, defs, lockMap);
  assert.deepEqual(Object.keys(g), LANES);
  assert.deepEqual(g.done.map((c) => c.id), [2, 3]);
  assert.deepEqual(g.up_next.map((c) => c.id), [4, 5, 1]);
  assert.deepEqual(g.working.map((c) => c.id), [6]);
  assert.deepEqual(g.needs_you, []);
});

test("groupByLane falls back to the default def when no null entry", () => {
  const g = groupByLane([{ id: 1, project_id: 9, status: "cancelled" }], new Map(), new Map());
  assert.equal(g.done.length, 1);
});
