// tasks_classifier.mjs — single source of truth for "is this inbound email a
// task-LIST-MANAGEMENT request?" routing hint for router_dispatch.mjs.
//
// Contract: called ONLY AFTER the anchored-regex classify() in
// router_dispatch.mjs has returned null (i.e. it is NOT one of the exact
// deterministic INTENTS: run pir sync / show pir digest / start job search /
// draft applications / rematch pir / help). So those never reach here.
//
// Returns true  -> route to bot_id='mpa-tasks' (converse pipeline)
//         false -> let the existing improvise (bot_id='router') fallback handle it.
//
// Heuristics are intentionally LOOSER than the anchored INTENTS (this is a
// routing hint, not a deterministic action), but guarded so PIR/job-search
// freeform questions do NOT get stolen from improvise.

const TASK_SIGNALS = [
  /\b(add|create|make|new)\s+(a\s+|another\s+)?task\b/i,
  /\bwhat'?s?\s+(on\s+)?my\s+(task\s+|to-?do\s+)?list\b/i,
  /\b(show|list|what\s+are|see)\s+(me\s+)?(my\s+)?(pending|overdue|open|all\s+)?\s*tasks?\b/i,
  /\b(my|the)\s+to-?do\s+list\b/i,
  /\bmark\s+(task\s+)?#?\d+\s+(as\s+)?(done|complete|completed|finished)\b/i,
  /\b(complete|close|finish|done\s+with)\s+task\s+#?\d+\b/i,
  /\b(reopen|re-?open)\s+task\s+#?\d+\b/i,
  /\b(re-?prioriti[sz]e|change\s+(the\s+)?priority|bump\s+(the\s+)?priority|set\s+priority)\b/i,
  /\b(take|work\s+on|start\s+(working\s+)?on|handle|do)\s+task\s+#?\d+\b/i,
  /\b(update|edit|change|reschedule|push\s+back|move)\s+task\s+#?\d+\b/i,
  /\badd\s+a\s+subtask\b/i,
];

// If the message is clearly a PIR or job-search FREEFORM question, do NOT
// claim it for tasks even if a weak token coincides. (Exact PIR/job INTENTS
// never reach here — they are anchored-matched upstream.)
const NOT_TASKS_CONTEXT = [
  /\bpir\b|\bpublic\s+information\s+request\b|\bopen\s+records\b/i,
  /\b(job|jobs|application|applications|candidate|resume|posting)\b/i,
];

export function classifyTasks(subject, body) {
  const hay = `${subject || ""}\n${body || ""}`;
  const hasTaskSignal = TASK_SIGNALS.some((re) => re.test(hay));
  if (!hasTaskSignal) return false;
  // A task signal that ALSO carries a strong PIR/job context AND does NOT
  // explicitly say "task" is ambiguous -> defer to improvise. But an explicit
  // "task" word wins (e.g. "add a task to follow up on the FWISD PIR" IS a
  // task-management request).
  const saysTaskWord = /\btask\b|\bto-?do\b/i.test(hay);
  const pirOrJob = NOT_TASKS_CONTEXT.some((re) => re.test(hay));
  if (pirOrJob && !saysTaskWord) return false;
  return true;
}
