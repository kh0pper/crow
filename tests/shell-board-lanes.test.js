// Task 3.1: the Board tab's lanes come from real card, result, decision and session state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOARD_DEF } from "../servers/gateway/routes/board-defs.js";
import { LANES, laneOf, openDecision, groupByLane, movePlan, doneStatus, reopenStatus } from "../servers/gateway/dashboard/panels/board/lanes.js";

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

// ---- Task 3.3: lane moves map to real actions ----

const CUSTOM_DEF = { ...DEFAULT_BOARD_DEF, status_values: ["todo", "doing", "shipped", "dropped"], terminal_values: ["shipped", "dropped"] };

test("doneStatus and reopenStatus follow the card's board", () => {
  assert.equal(doneStatus(DEFAULT_BOARD_DEF), "done");
  assert.equal(reopenStatus(DEFAULT_BOARD_DEF), DEFAULT_BOARD_DEF.status_values[0]);
  assert.equal(doneStatus(CUSTOM_DEF), "shipped");
  assert.equal(reopenStatus(CUSTOM_DEF), "todo");
});

test("movePlan covers the table", () => {
  for (const def of [DEFAULT_BOARD_DEF, CUSTOM_DEF]) {
    const open = def.status_values.find((s) => !def.terminal_values.includes(s));
    const fin = doneStatus(def);
    const label = def === CUSTOM_DEF ? "custom" : "default";
    const free = { status: open };
    const held = { status: open };
    const doneCard = { status: fin };
    const recorded = { status: open };
    const asked = { status: open, action_needed: "check the numbers" };
    const latest = { id: 41, status: "recorded" };
    const P = (card, opts, to) => movePlan(card, def, opts, to);

    // same lane
    assert.deepEqual(P(free, { locked: false, latestResult: null }, "up_next"), { action: "none" }, label);
    assert.deepEqual(P(doneCard, { locked: false, latestResult: null }, "done"), { action: "none" }, label);
    // any -> working / needs_you
    for (const [card, opts] of [[free, { locked: false, latestResult: null }], [doneCard, { locked: false, latestResult: null }], [recorded, { locked: false, latestResult: latest }]]) {
      assert.deepEqual(P(card, opts, "working"), { action: "refuse", reason: "needs_session" }, label);
    }
    for (const [card, opts] of [[free, { locked: false, latestResult: null }], [doneCard, { locked: false, latestResult: null }], [held, { locked: true, latestResult: null }]]) {
      assert.deepEqual(P(card, opts, "needs_you"), { action: "refuse", reason: "needs_reason" }, label);
    }
    // working -> up_next / done
    assert.deepEqual(P(held, { locked: true, latestResult: null }, "up_next"), { action: "refuse", reason: "locked" }, label);
    assert.deepEqual(P(held, { locked: true, latestResult: null }, "done"), { action: "refuse", reason: "locked" }, label);
    // up_next -> done
    assert.deepEqual(P(free, { locked: false, latestResult: null }, "done"), { action: "move", status: fin }, label);
    // needs_you (recorded result) -> done / up_next
    assert.deepEqual(P(recorded, { locked: false, latestResult: latest }, "done"), { action: "accept", resultId: 41, status: fin }, label);
    assert.deepEqual(P(recorded, { locked: false, latestResult: latest }, "up_next"), { action: "refuse", reason: "use_review" }, label);
    // needs_you (action_needed only) -> done / up_next
    assert.deepEqual(P(asked, { locked: false, latestResult: null }, "done"), { action: "move", status: fin }, label);
    assert.deepEqual(P(asked, { locked: false, latestResult: { id: 7, status: "approved" } }, "up_next"), { action: "clear_ask" }, label);
    // done -> up_next
    assert.deepEqual(P(doneCard, { locked: false, latestResult: null }, "up_next"), { action: "move", status: reopenStatus(def) }, label);
    // needs_you (open decision) -> done / up_next
    const asking = { status: open, data_json: decision() };
    assert.deepEqual(P(asking, { locked: false, latestResult: null }, "done"), { action: "refuse", reason: "answer_first" }, label);
    assert.deepEqual(P(asking, { locked: false, latestResult: null }, "up_next"), { action: "refuse", reason: "answer_first" }, label);
  }
  // The custom board's own statuses.
  assert.deepEqual(movePlan({ status: "shipped" }, CUSTOM_DEF, { locked: false, latestResult: null }, "up_next"), { action: "move", status: "todo" });
  assert.deepEqual(movePlan({ status: "todo" }, CUSTOM_DEF, { locked: false, latestResult: null }, "done"), { action: "move", status: "shipped" });
  assert.deepEqual(movePlan({ status: "dropped" }, CUSTOM_DEF, { locked: false, latestResult: null }, "up_next"), { action: "move", status: "todo" });
});

test("a decision and a recorded result: the decision wins (Ruling P2)", () => {
  const card = { status: "pending", data_json: decision() };
  const latest = { id: 9, status: "recorded" };
  for (const to of ["done", "up_next"]) {
    assert.deepEqual(movePlan(card, DEFAULT_BOARD_DEF, { locked: false, latestResult: latest }, to), { action: "refuse", reason: "answer_first" });
  }
});

test("into Working is always refused", () => {
  for (const card of [{ status: "pending" }, { status: "in_progress" }, { status: "done" }, { status: "pending", action_needed: "x" }]) {
    assert.deepEqual(movePlan(card, DEFAULT_BOARD_DEF, { locked: false, latestResult: null }, "working"), { action: "refuse", reason: "needs_session" });
  }
});

test("a held card is never moved or cleared by a lane move, but a result can still be accepted", () => {
  const asked = { status: "pending", action_needed: "x" };
  assert.deepEqual(movePlan(asked, DEFAULT_BOARD_DEF, { locked: true, latestResult: null }, "up_next"), { action: "refuse", reason: "locked" });
  assert.deepEqual(movePlan(asked, DEFAULT_BOARD_DEF, { locked: true, latestResult: null }, "done"), { action: "refuse", reason: "locked" });
  assert.deepEqual(movePlan({ status: "done" }, DEFAULT_BOARD_DEF, { locked: true, latestResult: null }, "up_next"), { action: "refuse", reason: "locked" });
  assert.deepEqual(movePlan({ status: "pending" }, DEFAULT_BOARD_DEF, { locked: true, latestResult: { id: 3, status: "recorded" } }, "done"), { action: "accept", resultId: 3, status: "done" });
});

test("an unknown lane is refused", () => {
  assert.deepEqual(movePlan({ status: "pending" }, DEFAULT_BOARD_DEF, { locked: false, latestResult: null }, "nowhere"), { action: "refuse", reason: "bad_lane" });
});

test("a decision answered in chat leaves Needs you: the lane comes from the card's other rules", () => {
  const def = DEFAULT_BOARD_DEF;
  const src = { source: { thread_id: "perchlive-q" } };
  const open = { status: "pending", data_json: decision(src) };
  assert.equal(laneOf(open, def, { locked: false }), "needs_you");
  const answered = decision({ ...src, chosen: { index: 0, label: "a" } });
  assert.equal(laneOf({ status: "pending", data_json: answered }, def, { locked: false }), "up_next");
  assert.equal(laneOf({ status: "pending", data_json: answered }, def, { locked: true }), "working");
  assert.equal(laneOf({ status: "done", data_json: answered }, def, { locked: false }), "done", "#535 closes the card");
  assert.equal(laneOf({ status: "pending", data_json: answered, latest_result_status: "recorded" }, def, { locked: false }), "needs_you",
    "a result still open keeps it in Needs you");
  assert.equal(movePlan({ status: "pending", data_json: answered }, def, { locked: false, latestResult: null }, "done").action, "move",
    "no answer_first once answered");
});
