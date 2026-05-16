// router_tasks_smoke.mjs — deterministic smoke for the mpa-tasks routing layer.
// Run on crow: /home/kh0pp/.nvm/versions/node/v20.20.2/bin/node \
//   ~/crow/scripts/bots/router_tasks_smoke.mjs
import assert from "node:assert/strict";
import { classifyTasks } from "./tasks_classifier.mjs";

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

console.log(`\nROUTER-TASKS SMOKE OK (${pass} groups)`);
