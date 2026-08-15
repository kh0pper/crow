/**
 * A card job must execute through the BRIDGE, not through runJob's generic goal
 * path. This is a safety property, not a style preference: bridge.handleInbound
 * owns the card prompt — project context block, card number, current board
 * status, the current board_plans record (D-T1.4) — and the board_report_result
 * terminal-state contract (D-T1.5).
 *
 * A generic job gets none of that: the bot's own policy, a bare goal string, an
 * empty temp dir. So a routing regression silently removes the floor, which is
 * why every case below also fails loudly if the generic path is reached.
 *
 * D-T1.7: planning retired with plan_ref/planCard — a card job is execution
 * only now (runCardJob no longer branches on card_action). Plans are
 * board_plans records, edited via board_save_plan/board_approve_plan, never
 * dispatched as a job.
 *
 * Nothing here spawns pi or opens a real database: the bridge module is
 * injected, and CROW_DB_PATH is pinned to a throwaway dir as a belt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { escalateRequested, stripEscalateToken } from "../scripts/pi-bots/model_resolver.mjs";

const scratch = mkdtempSync(join(tmpdir(), "botjobs-routing-"));
process.env.CROW_DB_PATH = join(scratch, "crow.db");
process.on("exit", () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

const loadRunner = () => import("../scripts/pi-bots/job_runner.mjs");

/** Any bridge member a card job must NOT touch blows up with this marker. */
const GENERIC = () => { throw new Error("REACHED_GENERIC: generic path must not be reached for a card job"); };

test("an execute card job reaches handleInbound with the board --inject payload, carrying job_id", async () => {
  // The payload must match what bot-board-api.js's detached `--inject` child
  // has always sent, so handleInbound composes the SAME card prompt (project
  // context + board status + the current board_plans record). Re-implementing
  // prompt composition in the runner is how dispatcher and bridge drift apart.
  // job_id (D-T1.5, Task 7 — the missing link in the chain): runCardExecute
  // must forward job.job_id so it reaches buildBotWorld -> writeBotMcp -> the
  // board entry's X-Crow-Job-Id header, which is what lets the job-rail lock
  // exemption match a job-dispatched auto-move against its OWN bot_jobs row.
  let payload = null;
  const fakeBridge = {
    handleInbound: async (o) => {
      payload = o;
      await o.sendReply("Card #120 done: shipped the thing.");
      return { action: "executed", cardId: 120, cardStatus: "done",
        piSessionId: "sess-abc", toolCalls: [{ tool: "tasks_update" }, { tool: "write" }], replyPreview: "Card #120 done" };
    },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  const r = await runJob(
    { job_id: "j4", bot_id: "b1", source: "card", card_action: "execute", card_id: 120, goal: "execute #120" },
    { log: () => {}, bridge: fakeBridge },
  );

  assert.equal(payload.bot_id, "b1");
  assert.equal(payload.gateway_type, "board");
  assert.equal(payload.gateway_thread_id, "board-card-120");
  assert.equal(payload.user_message, "execute #120");
  assert.equal(payload.job_id, "j4", "job_id must reach handleInbound for the X-Crow-Job-Id header chain");
  assert.equal(typeof payload.sendReply, "function", "handleInbound awaits sendReply — omitting it crashes the turn");

  assert.equal(r.result, "Card #120 done: shipped the thing.");
  // tool_calls is an INTEGER column; handleInbound returns the ARRAY.
  assert.equal(r.toolCalls, 2);
  assert.equal(r.sessionId, "sess-abc");
});

test("an escalated execute job carries the inbound-only !escalate token", async () => {
  // Escalation rides the committed operator token rather than a second
  // mechanism: handleInbound detects it on the raw message and strips it
  // before the prompt is built.
  let msg = null;
  const fakeBridge = {
    handleInbound: async (o) => { msg = o.user_message; await o.sendReply("ok"); return { action: "executed", toolCalls: [] }; },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  await runJob(
    { job_id: "j5", bot_id: "b1", source: "card", card_action: "execute", card_id: 42, escalate: 1 },
    { log: () => {}, bridge: fakeBridge },
  );
  // Proven against the real detector/stripper, not a copy of the regex.
  assert.equal(escalateRequested(msg), true, "the bridge must see an escalation request");
  assert.equal(stripEscalateToken(msg), "execute #42",
    "after stripping, the prompt text must be byte-identical to an un-escalated dispatch");
});

test("an execute job deferred for pi capacity completes as a result, not a failure", async () => {
  const fakeBridge = {
    handleInbound: async () => ({ action: "deferred", reason: "pi-capacity", livePi: 2 }),
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  const r = await runJob(
    { job_id: "j6", bot_id: "b1", source: "card", card_action: "execute", card_id: 42 },
    { log: () => {}, bridge: fakeBridge },
  );
  assert.equal(r.result, "deferred: pi-capacity");
  assert.equal(r.toolCalls, 0);
});

test("an execute job whose bridge turn errored fails the job", async () => {
  const fakeBridge = {
    handleInbound: async (o) => { await o.sendReply("(bridge error: pi died)"); return { action: "error", error: "pi died" }; },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  await assert.rejects(
    () => runJob({ job_id: "j7", bot_id: "b1", source: "card", card_action: "execute", card_id: 42 }, { log: () => {}, bridge: fakeBridge }),
    /card execute failed: pi died/,
  );
});

test("a card job with no usable card_id fails before touching the bridge", async () => {
  const fakeBridge = {
    handleInbound: async () => { throw new Error("handleInbound must not be reached without a card id"); },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  for (const card_id of [null, 0, "abc"]) {
    await assert.rejects(
      () => runJob({ job_id: "j8", bot_id: "b1", source: "card", card_action: "execute", card_id }, { log: () => {}, bridge: fakeBridge }),
      /card job has no usable card_id/,
      "card_id " + JSON.stringify(card_id) + " must be rejected, not sent to the bridge",
    );
  }
});

test("a card job defaults to the execute path when card_action is absent", async () => {
  let reached = false;
  const fakeBridge = {
    handleInbound: async (o) => { reached = true; await o.sendReply("ok"); return { action: "executed", toolCalls: [] }; },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  await runJob({ job_id: "j9", bot_id: "b1", source: "card", card_id: 5 }, { log: () => {}, bridge: fakeBridge });
  assert.equal(reached, true);
});

test("a card job STILL executes even when card_action='plan' (D-T1.7: no plan branch survives)", async () => {
  // A stray legacy 'plan' row (the deploy step drains these before cutover,
  // but this pins the code path itself, not just the operational runbook): a
  // card job is execution, full stop — runCardJob no longer branches on
  // card_action at all.
  let reached = false;
  const fakeBridge = {
    handleInbound: async (o) => { reached = true; await o.sendReply("ok"); return { action: "executed", toolCalls: [] }; },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  await runJob({ job_id: "j12", bot_id: "b1", source: "card", card_id: 88, card_action: "plan" }, { log: () => {}, bridge: fakeBridge });
  assert.equal(reached, true, "card_action='plan' must still route to handleInbound — there is no other card-job path left");
});

test("a job carrying a card_id routes to the bridge even when source is not 'card'", async () => {
  // The gate is structural as well as declarative, on purpose. Nothing
  // validates bot_jobs.source on the way in — enqueueJob passes opts.source
  // straight through and the DDL has no CHECK — so a row with card_id set but
  // source NULL / 'Card' / 'board' would otherwise fall through to the generic
  // body and run board work under the bot's OWN permission policy with a bare
  // goal string. The floor must not depend on one caller typing one literal.
  for (const source of [null, undefined, "board", "Card"]) {
    let reached = false;
    const fakeBridge = {
      handleInbound: async (o) => { reached = true; await o.sendReply("ok"); return { action: "executed", toolCalls: [] }; },
      loadBot: GENERIC,
    };
    const { runJob } = await loadRunner();
    const r = await runJob(
      { job_id: "j11", bot_id: "b1", source, card_id: 77, card_action: "execute" },
      { log: () => {}, bridge: fakeBridge },
    );
    assert.equal(reached, true, "card_id=77 with source=" + JSON.stringify(source) + " must still reach the bridge");
    assert.equal(r.result, "ok");
  }
});

test("a non-card job still takes the generic path", async () => {
  const fakeBridge = {
    handleInbound: async () => { throw new Error("handleInbound must not be called for a scheduled job"); },
    loadBot: GENERIC,
  };
  const { runJob } = await loadRunner();
  await assert.rejects(
    () => runJob({ job_id: "j10", bot_id: "b1", source: "schedule", goal: "heartbeat" }, { log: () => {}, bridge: fakeBridge }),
    /REACHED_GENERIC/,
    "a scheduled job must still run the generic body",
  );
});
