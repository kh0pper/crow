/**
 * Moves design Task 6 — flow learning (guidance fading).
 *
 * What is pinned here:
 *   - the ladder: 3 smooth runs at "full" -> "names", 3 at "names" -> "first",
 *     and a "first" run reported from memory -> "memory",
 *   - "needed help" writes nothing, so it can neither advance nor demote,
 *   - the wallet shapes: `flowrun` grows per (flow, level) by compare-and-swap,
 *     `flowmem` is a constant 1 inserted once,
 *   - idempotence: re-applying the same synced wallet rows changes nothing,
 *     and a later lamport carrying a smaller delta never shrinks a count,
 *   - `learningFlows`: flows with at least one counted run and no memory fact,
 *   - validation: a junk flowId or level throws and writes nothing at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import {
  FLOW_RUN_KIND, FLOW_MEMORY_KIND, GUIDANCE, FLOW_RUNS_TO_ADVANCE,
  LearningInputError, recordFlowRun, flowLevel, learningFlows,
} from "../bundles/ramble/server/moves/learning.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";

/** Local noon on a fixed local day, so the file is timezone-independent. */
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** Record `n` smooth runs at one level, a second apart. */
async function smooth(db, flowId, level, n, at = T0, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await recordFlowRun(db, {
      flowId, level, outcome: "smooth", now: at + i * 1000, ...opts,
    }));
  }
  return out;
}

/** Every wallet row, ordered, for a before/after comparison. */
async function snapshot(db) {
  const { rows } = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet ORDER BY kind, key",
    args: [],
  });
  return rows.map((r) => ({ kind: r.kind, key: r.key, delta: Number(r.delta) }));
}

async function walletKinds(db) {
  const { rows } = await db.execute({ sql: "SELECT DISTINCT kind FROM ramble_wallet ORDER BY kind", args: [] });
  return rows.map((r) => r.kind);
}

/* ------------------------------------------------------------- vocabulary */

test("the guidance ladder and the two wallet kinds are the fixed vocabulary", () => {
  assert.deepEqual([...GUIDANCE], ["full", "names", "first", "memory"]);
  assert.equal(FLOW_RUN_KIND, "flowrun");
  assert.equal(FLOW_MEMORY_KIND, "flowmem");
  assert.equal(FLOW_RUNS_TO_ADVANCE, 3);
});

/* --------------------------------------------------------------- the ladder */

test("3 smooth runs at full offer names; 3 at names offer first", async () => {
  const db = await freshDb();

  assert.equal(await flowLevel(db, "morning-flow"), "full", "a flow nobody has run starts with full guidance");
  await smooth(db, "morning-flow", "full", 2);
  assert.equal(await flowLevel(db, "morning-flow"), "full", "two runs are not enough");

  const third = await recordFlowRun(db, {
    flowId: "morning-flow", level: "full", outcome: "smooth", now: T0 + 2 * 1000,
  });
  assert.equal(third.counted, true);
  assert.equal(third.level, "names");
  assert.equal(await flowLevel(db, "morning-flow"), "names");
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "morning-flow:full"), 3, "the key is <flowId>:<level>");
  assert.equal(await rowDelta(db, FLOW_MEMORY_KIND, "morning-flow"), null, "no memory fact yet");

  await smooth(db, "morning-flow", "names", 2, T0 + 10 * MINUTE);
  assert.equal(await flowLevel(db, "morning-flow"), "names");

  await smooth(db, "morning-flow", "names", 1, T0 + 12 * MINUTE);
  assert.equal(await flowLevel(db, "morning-flow"), "first");
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "morning-flow:names"), 3);
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "morning-flow:full"), 3, "the earlier level's count is kept");

  // At "first" nothing further advances by counting: only memory does.
  await smooth(db, "morning-flow", "first", 5, T0 + 20 * MINUTE);
  assert.equal(await flowLevel(db, "morning-flow"), "first");
  assert.equal(await rowDelta(db, FLOW_MEMORY_KIND, "morning-flow"), null);
});

/* ---------------------------------------------------------- needed help */

test("needed help writes nothing and never demotes or advances a level", async () => {
  const db = await freshDb();

  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await recordFlowRun(db, {
      flowId: "help-flow", level: "full", outcome: "needed_help", now: T0 + i * 1000,
    });
    assert.equal(out.counted, false);
    assert.equal(out.level, "full");
  }
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "help-flow:full"), null, "not even a zero row is written");

  await smooth(db, "help-flow", "full", 3);
  assert.equal(await flowLevel(db, "help-flow"), "names");

  // A hard day at the new level changes neither the level nor the count.
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await recordFlowRun(db, {
      flowId: "help-flow", level: "names", outcome: "needed_help", now: T0 + (10 + i) * MINUTE,
    });
  }
  assert.equal(await flowLevel(db, "help-flow"), "names");
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "help-flow:names"), null);
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "help-flow:full"), 3, "never reset");

  await smooth(db, "help-flow", "names", 3, T0 + 20 * MINUTE);
  assert.equal(await flowLevel(db, "help-flow"), "first");
  await recordFlowRun(db, { flowId: "help-flow", level: "first", outcome: "needed_help", now: T0 + 30 * MINUTE });
  assert.equal(await flowLevel(db, "help-flow"), "first", "needing help at first never demotes to names");
});

/* ------------------------------------------------------------------ memory */

test("a first-level smooth run reported from memory writes flowmem and settles on memory", async () => {
  const db = await freshDb();
  await smooth(db, "memory-flow", "full", 3);
  await smooth(db, "memory-flow", "names", 3, T0 + 10 * MINUTE);
  assert.equal(await flowLevel(db, "memory-flow"), "first");

  const atNames = await smooth(db, "memory-flow", "names", 1, T0 + 20 * MINUTE, { fromMemory: true });
  assert.equal(atNames[0].memory, false, "fromMemory below first proves nothing");
  assert.equal(await rowDelta(db, FLOW_MEMORY_KIND, "memory-flow"), null);

  const helped = await recordFlowRun(db, {
    flowId: "memory-flow", level: "first", outcome: "needed_help", now: T0 + 21 * MINUTE, fromMemory: true,
  });
  assert.equal(helped.memory, false, "only a smooth run can be reported as known from memory");
  assert.equal(await rowDelta(db, FLOW_MEMORY_KIND, "memory-flow"), null);

  const out = await recordFlowRun(db, {
    flowId: "memory-flow", level: "first", outcome: "smooth", now: T0 + 22 * MINUTE, fromMemory: true,
  });
  assert.equal(out.counted, true);
  assert.equal(out.memory, true);
  assert.equal(out.level, "memory");
  assert.equal(await rowDelta(db, FLOW_MEMORY_KIND, "memory-flow"), 1);
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "memory-flow:first"), 1, "the run still counts at first");

  // Memory is the top of the ladder: another flowmem insert cannot double it,
  // and no amount of help afterwards takes it away.
  await recordFlowRun(db, { flowId: "memory-flow", level: "first", outcome: "smooth", now: T0 + 23 * MINUTE, fromMemory: true });
  assert.equal(await rowDelta(db, FLOW_MEMORY_KIND, "memory-flow"), 1);
  await recordFlowRun(db, { flowId: "memory-flow", level: "full", outcome: "needed_help", now: T0 + 24 * MINUTE });
  assert.equal(await flowLevel(db, "memory-flow"), "memory");
});

/* --------------------------------------------------- compare-and-swap growth */

test("a flowrun row grows by compare-and-swap from whatever it already holds", async () => {
  const db = await freshDb();
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [FLOW_RUN_KIND, "steady-flow:full", 2, T0],
  });

  const out = await recordFlowRun(db, {
    flowId: "steady-flow", level: "full", outcome: "smooth", now: T0 + 1000,
  });
  assert.equal(out.counted, true);
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "steady-flow:full"), 3);
  assert.equal(await flowLevel(db, "steady-flow"), "names", "a row merged from a peer counts as runs");

  // A row already carried past the threshold is never written back down.
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [FLOW_RUN_KIND, "far-flow:full", 7, T0],
  });
  await recordFlowRun(db, { flowId: "far-flow", level: "full", outcome: "smooth", now: T0 + 2000 });
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "far-flow:full"), 8);
  assert.equal(await flowLevel(db, "far-flow"), "names");
});

/* -------------------------------------------------------------- validation */

test("a junk flowId or level throws and writes nothing", async () => {
  const db = await freshDb();
  const bad = [
    () => recordFlowRun(db, { flowId: "Morning-Flow", level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "", level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "flow with space", level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "flow:full", level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "a".repeat(81), level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: 42, level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: undefined, level: "full", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "good-flow", level: "memory", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "good-flow", level: "guided", outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "good-flow", level: null, outcome: "smooth", now: T0 }),
    () => recordFlowRun(db, { flowId: "good-flow", outcome: "smooth", now: T0 }),
    () => flowLevel(db, "not a flow"),
    () => flowLevel(db, null),
  ];
  for (const fn of bad) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(fn, LearningInputError);
  }
  assert.deepEqual(await snapshot(db), [], "a rejected run writes no ledger row and stores no free text");

  // A valid run after the rejections is unaffected.
  await recordFlowRun(db, { flowId: "good-flow", level: "full", outcome: "smooth", now: T0 });
  assert.deepEqual(await walletKinds(db), [FLOW_RUN_KIND], "only the learning rows: no seed, no pet charge");
  assert.equal(await rowDelta(db, FLOW_RUN_KIND, "good-flow:full"), 1);
});

/* ------------------------------------------------------------- sync safety */

test("MULTI-INSTANCE: synced flow rows converge, and re-applying them changes nothing", async () => {
  const a = await freshDb();
  const b = await freshDb();
  const ops = [];
  const emit = async (table, op, row) => { if (table === "ramble_wallet") ops.push([op, row]); };

  // sun-flow: all the way from full to memory. rain-flow: only to names.
  await smooth(a, "sun-flow", "full", 3, T0, { emit });
  await smooth(a, "sun-flow", "names", 3, T0 + 10 * MINUTE, { emit });
  await smooth(a, "rain-flow", "full", 3, T0 + 20 * MINUTE, { emit });
  const mem = await recordFlowRun(a, {
    flowId: "sun-flow", level: "first", outcome: "smooth", now: T0 + 30 * MINUTE, fromMemory: true, emit,
  });
  assert.equal(mem.level, "memory");
  assert.ok(ops.length >= 8, "the sequence really did write ledger rows");

  for (const [op, row] of ops) await applyRambleWallet(b, op, row, 1);
  assert.equal(await flowLevel(b, "sun-flow"), "memory");
  assert.equal(await flowLevel(b, "rain-flow"), "names");
  assert.equal(await rowDelta(b, FLOW_RUN_KIND, "sun-flow:full"), 3);
  assert.equal(await rowDelta(b, FLOW_RUN_KIND, "sun-flow:names"), 3);
  assert.equal(await rowDelta(b, FLOW_RUN_KIND, "sun-flow:first"), 1);
  assert.equal(await rowDelta(b, FLOW_MEMORY_KIND, "sun-flow"), 1);

  const before = await snapshot(b);
  // Idempotent re-delivery of every row, and a later lamport carrying a
  // SMALLER delta: MAX(delta) means a peer can never take learning away.
  for (const [op, row] of ops) await applyRambleWallet(b, op, row, 2);
  await applyRambleWallet(b, "update", {
    kind: FLOW_RUN_KIND, key: "rain-flow:full", delta: 1, created_at: T0,
  }, 9);
  await applyRambleWallet(b, "update", {
    kind: FLOW_MEMORY_KIND, key: "sun-flow", delta: 0, created_at: T0,
  }, 9);
  assert.deepEqual(await snapshot(b), before);
  assert.equal(await flowLevel(b, "sun-flow"), "memory");
  assert.equal(await flowLevel(b, "rain-flow"), "names");
});

/* ------------------------------------------------------------ learningFlows */

test("learningFlows lists flows with a counted run and no memory fact, in library order", async () => {
  const library = [
    { id: "flow-a", kind: "flow" },
    { id: "flow-b", kind: "flow" },
    { id: "pose-a", kind: "pose" },
    { id: "flow-c", kind: "flow" },
  ];
  const db = await freshDb();
  assert.deepEqual(await learningFlows(db, library), [], "a fresh player has no flows to resume");

  await recordFlowRun(db, { flowId: "flow-a", level: "full", outcome: "smooth", now: T0 });
  assert.deepEqual(await learningFlows(db, library), ["flow-a"]);

  // A pose is never a flow, even if it somehow has a run row; a flow absent
  // from the library is never listed.
  await recordFlowRun(db, { flowId: "pose-a", level: "full", outcome: "smooth", now: T0 + 1000 });
  await recordFlowRun(db, { flowId: "ghost-flow", level: "full", outcome: "smooth", now: T0 + 2000 });
  assert.deepEqual(await learningFlows(db, library), ["flow-a"]);

  await recordFlowRun(db, { flowId: "flow-b", level: "full", outcome: "smooth", now: T0 + 3000 });
  assert.deepEqual(await learningFlows(db, library), ["flow-a", "flow-b"]);

  // A memory fact retires a flow from the list.
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)",
    args: [FLOW_MEMORY_KIND, "flow-b", T0],
  });
  assert.deepEqual(await learningFlows(db, library), ["flow-a"]);

  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)",
    args: [FLOW_MEMORY_KIND, "flow-a", T0],
  });
  assert.deepEqual(await learningFlows(db, library), []);
});

test("learningFlows ignores zero-delta markers and levels outside the vocabulary", async () => {
  const db = await freshDb();
  const library = [
    { id: "flow-d", kind: "flow" },
    { id: "flow-e", kind: "flow" },
  ];

  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 0, ?)",
    args: [FLOW_RUN_KIND, "flow-d:full", T0],
  });
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 5, ?)",
    args: [FLOW_RUN_KIND, "flow-e:sometimes", T0],
  });
  assert.deepEqual(await learningFlows(db, library), []);

  // Growing the zero marker to 1 makes flow-d a real resume candidate.
  await recordFlowRun(db, { flowId: "flow-d", level: "full", outcome: "smooth", now: T0 + 1000 });
  assert.deepEqual(await learningFlows(db, library), ["flow-d"]);
});

test("learningFlows accepts a Map library and tolerates a missing one", async () => {
  const db = await freshDb();
  await recordFlowRun(db, { flowId: "flow-a", level: "full", outcome: "smooth", now: T0 });
  const entries = [
    { id: "flow-a", kind: "flow" },
    { id: "pose-a", kind: "pose" },
  ];
  const map = new Map(entries.map((e) => [e.id, e]));
  assert.deepEqual(await learningFlows(db, map), ["flow-a"]);

  assert.deepEqual(await learningFlows(db, null), []);
  assert.deepEqual(await learningFlows(db, undefined), []);
  assert.deepEqual(await learningFlows(db, []), []);
});