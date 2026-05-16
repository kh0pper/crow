// router_tasks_smoke.mjs — deterministic smoke for the mpa-tasks routing layer.
// Run on crow: /home/kh0pp/.nvm/versions/node/v20.20.2/bin/node \
//   ~/crow/scripts/bots/router_tasks_smoke.mjs
import assert from "node:assert/strict";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { classifyTasks } from "./tasks_classifier.mjs";
import { classify, handoffToTasks } from "./router_dispatch.mjs";

let pass = 0;
function t(name, fn) { fn(); pass++; console.log("ok -", name); }

// TASKS-positive: must route to mpa-tasks (classifyTasks returns true)
const TASKS_YES = [
  ["", "add a task to file the USPTO trademark by Friday"],
  ["", "what's on my task list?"],
  ["", "show my overdue tasks"],
  ["", "mark task 12 done"],
  ["", "complete task #3"],
  ["", "reprioritize task 5 to priority 5"],
  ["", "take task 2 and research the TESS conflicts for me"],
  ["my to-do list", "what is left?"],
  ["", "create a new task: draft the founding narrative, due 2026-05-20"],
];
// TASKS-negative: must NOT route to mpa-tasks (classifyTasks returns false).
// NOTE (revision 15): anchored-INTENT phrases ('run pir sync', 'draft
// applications', 'help', 'show pir digest') are NOT tested here — they never
// reach classifyTasks (classify() anchored-matches them upstream). They are
// asserted only via the Task 1.3 ordering group. TASKS_NO keeps only
// genuinely-freeform negatives.
const TASKS_NO = [
  ["", "what is the status of my FWISD PIRs?"],          // PIR freeform → improvise
  ["", "find me director-level federal-programs jobs in Houston"], // job-search freeform
  ["", "can you summarize the latest education news?"],   // generic → improvise
  ["", "thanks, that looks good"],                        // affirmation, no task language
];

t("TASKS positives route true", () => {
  for (const [s, b] of TASKS_YES) assert.equal(classifyTasks(s, b), true, `expected TASKS: ${JSON.stringify([s,b])}`);
});
t("TASKS negatives route false", () => {
  for (const [s, b] of TASKS_NO) assert.equal(classifyTasks(s, b), false, `expected NOT TASKS: ${JSON.stringify([s,b])}`);
});

t("handoffToTasks writes an mpa-tasks row + json_patch merge keeps work_task_id", () => {
  const MPA_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
  const tid = "smoke-tasks-thread-0001";
  const convId = `mpa-tasks:thread:${tid}`;
  const db = new Database(MPA_DB);
  db.prepare("DELETE FROM bot_conversations WHERE id = ?").run(convId);
  const r = handoffToTasks({ threadId: tid, msgId: "m1", sender: "kevin.hopper1@gmail.com",
                             subject: "smoke", body: "add a task: smoke check" });
  assert.equal(r.convId, convId);
  const row = db.prepare("SELECT bot_id, status, current_step, gmail_thread_id, payload FROM bot_conversations WHERE id = ?").get(convId);
  assert.equal(row.bot_id, "mpa-tasks");
  assert.equal(row.current_step, "queued");
  assert.equal(row.gmail_thread_id, tid);
  assert.equal(JSON.parse(row.payload).sender_addr, "kevin.hopper1@gmail.com");
  assert.equal(JSON.parse(row.payload).latest_message_id, "m1");
  // Simulate the converse pipeline persisting work_task_id into the row's payload.
  db.prepare("UPDATE bot_conversations SET payload = json_patch(payload, '{\"work_task_id\":99}') WHERE id = ?").run(convId);
  // A second user reply re-handoffs: idempotent UPSERT + json_patch merge (Phase 9.7 parity).
  handoffToTasks({ threadId: tid, msgId: "m2", sender: "kevin.hopper1@gmail.com",
                   subject: "smoke", body: "second message" });
  const p2 = JSON.parse(db.prepare("SELECT payload FROM bot_conversations WHERE id = ?").get(convId).payload);
  assert.equal(p2.latest_message_id, "m2");   // merged-over by the new handoff
  assert.equal(p2.body, "second message");    // merged-over
  assert.equal(p2.work_task_id, 99);          // survived the json_patch merge
  db.prepare("DELETE FROM bot_conversations WHERE id = ?").run(convId);
  db.close();
});

t("ordering: anchored INTENTS win over TASKS", () => {
  // Exact commands must still anchored-match (classify != null), so the TASKS
  // branch is never reached for them (it lives inside the !intent fallback).
  for (const b of ["run pir sync", "draft applications", "help", "show pir digest"]) {
    assert.notEqual(classify("", b), null, `expected anchored INTENT for: ${b}`);
  }
  // A freeform task request does NOT anchored-match, so it reaches classifyTasks.
  assert.equal(classify("", "add a task to call the attorney"), null);
  assert.equal(classifyTasks("", "add a task to call the attorney"), true);
});

console.log(`\nROUTER-TASKS SMOKE OK (${pass} groups)`);
