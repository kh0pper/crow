// tests/board-stages.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGES, isStage, stageToStatus, effectiveStage, statusToStage, TERMINAL_STAGES }
  from "../servers/gateway/routes/board-stages.js";

test("stage vocabulary and projection", () => {
  assert.deepEqual(STAGES, ["backlog", "planning", "ready", "executing", "done", "cancelled"]);
  assert.equal(stageToStatus("backlog"), "pending");
  assert.equal(stageToStatus("planning"), "pending");
  assert.equal(stageToStatus("ready"), "pending");
  assert.equal(stageToStatus("executing"), "in_progress");
  assert.equal(stageToStatus("done"), "done");
  assert.equal(stageToStatus("cancelled"), "cancelled");
  assert.ok(TERMINAL_STAGES.has("done") && TERMINAL_STAGES.has("cancelled"));
  assert.ok(isStage("ready") && !isStage("pending") && !isStage(""));
});

test("effectiveStage: explicit stage wins; legacy null-stage derives from status+plan", () => {
  assert.equal(effectiveStage({ stage: "planning", status: "pending" }, true), "planning");
  assert.equal(effectiveStage({ stage: null, status: "done" }, false), "done");
  assert.equal(effectiveStage({ stage: null, status: "cancelled" }, true), "cancelled");
  assert.equal(effectiveStage({ stage: null, status: "in_progress" }, false), "executing");
  assert.equal(effectiveStage({ stage: null, status: "pending" }, true), "ready");   // spec: null stage + plan = Ready
  assert.equal(effectiveStage({ stage: null, status: "pending" }, false), "backlog"); // spec: null stage, no plan = Backlog
  assert.equal(effectiveStage({ stage: "bogus", status: "pending" }, false), "backlog"); // invalid stored stage falls back
});

test("statusToStage: bot-written status reconciles onto stage, preserving pre-exec refinement", () => {
  assert.equal(statusToStage("done", "executing"), "done");
  assert.equal(statusToStage("cancelled", "ready"), "cancelled");
  assert.equal(statusToStage("in_progress", "ready"), "executing");
  assert.equal(statusToStage("pending", "planning"), "planning"); // bot bounced it back: keep refinement
  assert.equal(statusToStage("pending", "executing"), "ready");   // was executing, bot reset: Ready (plan exists by then)
  assert.equal(statusToStage("pending", null), "ready");
});
