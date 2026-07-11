// servers/gateway/routes/board-stages.js
// Board–plan unification: the stage model. `stage` is the CANONICAL board
// column; legacy `status` is a projection (stageToStatus) written in the same
// statement by every stage writer. The bridge is the single reconciler for
// bot-written status flips (statusToStage). Pure module — no I/O.
export const STAGES = ["backlog", "planning", "ready", "executing", "done", "cancelled"];
export const TERMINAL_STAGES = new Set(["done", "cancelled"]);

const STAGE_TO_STATUS = {
  backlog: "pending", planning: "pending", ready: "pending",
  executing: "in_progress", done: "done", cancelled: "cancelled",
};

export function isStage(v) { return STAGES.includes(String(v)); }

export function stageToStatus(stage) { return STAGE_TO_STATUS[String(stage)] || "pending"; }

// Null/invalid stage (pre-migration cards) derives a stage from the legacy
// status: terminal maps 1:1, in_progress → executing, pending → Ready when a
// plan file exists else Backlog (spec "stage regression guard").
export function effectiveStage(card, planExists) {
  if (card && card.stage != null && isStage(card.stage)) return String(card.stage);
  const s = String((card && card.status) || "pending");
  if (s === "done") return "done";
  if (s === "cancelled") return "cancelled";
  if (s === "in_progress") return "executing";
  return planExists ? "ready" : "backlog";
}

// Post-turn reconciliation: a bot flipped tasks_items.status via tasks_* mid
// run; fold that back onto stage. Pre-execution refinements survive a bounce
// back to pending; a pending after executing means the work stopped → Ready.
export function statusToStage(status, prevStage) {
  const s = String(status || "pending");
  if (s === "done") return "done";
  if (s === "cancelled") return "cancelled";
  if (s === "in_progress") return "executing";
  if (prevStage && ["backlog", "planning", "ready"].includes(String(prevStage))) return String(prevStage);
  return "ready";
}
