/**
 * Flow learning — guidance fading (moves design Task 6; private engineering
 * notes).
 *
 * A guided flow starts with the full script ("full"), then asks for less as the
 * player demonstrably knows it: three smooth runs with full guidance earn a
 * "names" run, three smooth runs with names earn a "first" run, and reporting a
 * "first" run as done FROM MEMORY earns "memory" — no guidance at all. Nothing
 * here ever demotes: a run that needed help counts nothing, so a hard day can
 * never take back what the player has learned.
 *
 * TWO WALLET FACTS, BOTH GROWING:
 *   flowrun  key `<flowId>:<level>`, delta = smooth runs done at that level
 *   flowmem  key `<flowId>`,         delta 1 once the flow was done from memory
 *
 * ⚠ SYNC SAFETY. applyRambleWallet merges a key conflict with MAX(delta), so a
 * row that only ever grows converges exactly (the same rule as steps.js and
 * moves/ledger.js). `flowrun` is moved ONLY by compare-and-swap (`casDelta`):
 * the read and the write are separate, so two concurrent runs of the same flow
 * can lose one increment — which only ever means the player sees the next level
 * one run later, never a count that shrinks. `flowmem` is a constant 1 inserted
 * once (`insertOnce`).
 *
 * ⚠ NO FREE TEXT. A flowId is a library entry id (lowercase letters, digits and
 * dashes) and the level is one of a fixed four-word vocabulary. Nothing the
 * user typed is stored here, and a validation failure writes nothing at all.
 *
 * Works without a model: this module is purely bookkeeping over the fixed
 * vocabulary, and a parse that fails or times out simply never calls it.
 */
import { rowDelta, insertOnce, casDelta } from "../steps.js";

/** Wallet kind: key `<flowId>:<level>`, delta = smooth runs at that level. Grows, CAS. */
export const FLOW_RUN_KIND = "flowrun";
/** Wallet kind: key `<flowId>`, delta 1 — the flow was done from memory. */
export const FLOW_MEMORY_KIND = "flowmem";

/** The guidance ladder, most help first. */
export const GUIDANCE = Object.freeze(["full", "names", "first", "memory"]);

/** A run can be done at these levels; "memory" has no script left to run. */
export const FLOW_RUN_LEVELS = Object.freeze(["full", "names", "first"]);

/** Smooth runs needed at a level before the next one is offered. */
export const FLOW_RUNS_TO_ADVANCE = 3;

const FLOW_ID_RE = /^[a-z0-9-]{1,80}$/;

export class LearningInputError extends Error {
  constructor(message) { super(message); this.name = "LearningInputError"; }
}

/**
 * A flow id is an entry id, never user prose: lowercase ASCII, digits and
 * dashes, at most 80 characters. Rejected values are not echoed (an invalid id
 * could be anything, and nothing user-typed belongs in an error string here).
 */
function assertFlowId(flowId) {
  if (typeof flowId !== "string" || !FLOW_ID_RE.test(flowId)) {
    throw new LearningInputError("flowId must be 1-80 lowercase letters, digits or dashes");
  }
  return flowId;
}

function assertRunLevel(level) {
  if (!FLOW_RUN_LEVELS.includes(level)) {
    throw new LearningInputError("level must be one of " + FLOW_RUN_LEVELS.join(", "));
  }
  return level;
}

/** Smooth runs recorded at one level, floored at 0 (a junk row reads as none). */
async function runsAt(db, flowId, level) {
  const delta = await rowDelta(db, FLOW_RUN_KIND, `${flowId}:${level}`);
  return Math.max(0, Math.floor(Number(delta) || 0));
}

/** True when the flow's memory fact is present (delta 1; a junk 0 never counts). */
async function rememberedFlow(db, flowId) {
  const delta = await rowDelta(db, FLOW_MEMORY_KIND, flowId);
  return delta !== null && Number(delta) > 0;
}

/**
 * The guidance level for a flow:
 *   - a `flowmem` fact wins outright ("memory"),
 *   - three smooth runs at "first" keep it at "first" (only memory is further),
 *   - three smooth runs at "names" make it "first",
 *   - three smooth runs at "full" make it "names",
 *   - otherwise "full".
 *
 * Only smooth runs are ever counted, so "needed help" can neither advance nor
 * demote a level: the ladder is monotone.
 */
export async function flowLevel(db, flowId) {
  assertFlowId(flowId);
  if (await rememberedFlow(db, flowId)) return "memory";
  if (await runsAt(db, flowId, "first") >= FLOW_RUNS_TO_ADVANCE) return "first";
  if (await runsAt(db, flowId, "names") >= FLOW_RUNS_TO_ADVANCE) return "first";
  if (await runsAt(db, flowId, "full") >= FLOW_RUNS_TO_ADVANCE) return "names";
  return "full";
}

/**
 * Record the outcome of one flow run at the guidance level it was done with.
 *
 * `outcome: "smooth"` counts (one `flowrun` increment at that level, by
 * compare-and-swap). `"needed_help"` writes nothing — the run is a fact about
 * the day, not about what the player has learned. A smooth run at "first"
 * reported with `fromMemory: true` also writes the `flowmem` fact, and from then
 * on `flowLevel` answers "memory"; that fact is recorded whether or not the
 * counter's compare-and-swap was won (remembering the flow does not depend on
 * who won the count).
 *
 * Returns `{ flowId, level, counted, memory }`, where `level` is the level in
 * force AFTER this run and `memory` says whether the `flowmem` fact exists.
 * Validates before writing anything: a junk flowId or level throws
 * `LearningInputError` and leaves the ledger untouched.
 */
export async function recordFlowRun(db, {
  flowId, level, outcome, now = Date.now(), fromMemory = false, emit,
} = {}) {
  assertFlowId(flowId);
  assertRunLevel(level);
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const smooth = outcome === "smooth";

  let counted = false;
  if (smooth) {
    const key = `${flowId}:${level}`;
    const existing = await rowDelta(db, FLOW_RUN_KIND, key);
    const held = existing === null ? null : Math.max(0, Math.floor(Number(existing) || 0));
    counted = await casDelta(db, FLOW_RUN_KIND, key, held, (held ?? 0) + 1, at, emit);
  }

  if (smooth && level === "first" && fromMemory === true) {
    await insertOnce(db, FLOW_MEMORY_KIND, flowId, 1, at, emit);
  }

  const memory = await rememberedFlow(db, flowId);
  return { flowId, level: await flowLevel(db, flowId), counted, memory };
}

/** Normalize a library (array or id->entry Map) to its flow entry ids, in order. */
function flowIds(library) {
  const out = [];
  const seen = new Set();
  const take = (entry) => {
    if (!entry || entry.kind !== "flow") return;
    const id = entry.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  if (Array.isArray(library)) {
    for (const entry of library) take(entry);
  } else if (library instanceof Map) {
    for (const entry of library.values()) take(entry);
  }
  return out;
}

/**
 * The flows worth drawing attention to: a flow in `library` with at least one
 * counted run and no `flowmem` fact yet. A flow with no runs is untouched (not
 * a candidate for a "pick up where you left off" prompt), and a flow the player
 * already knows from memory needs no reminder at all.
 *
 * Reads only, and tolerant of the merged shape: a `flowrun` row with delta 0
 * (a marker) or with a level outside the fixed vocabulary does not count.
 */
export async function learningFlows(db, library) {
  const flows = flowIds(library);
  if (flows.length === 0) return [];

  const { rows } = await db.execute({
    sql: "SELECT kind, key FROM ramble_wallet WHERE kind IN (?, ?) AND delta > 0",
    args: [FLOW_RUN_KIND, FLOW_MEMORY_KIND],
  });
  const started = new Set();
  const remembered = new Set();
  for (const row of rows || []) {
    const key = String(row.key);
    if (row.kind === FLOW_MEMORY_KIND) { remembered.add(key); continue; }
    const at = key.lastIndexOf(":");
    if (at <= 0) continue;
    if (!FLOW_RUN_LEVELS.includes(key.slice(at + 1))) continue;
    started.add(key.slice(0, at));
  }
  return flows.filter((id) => started.has(id) && !remembered.has(id));
}