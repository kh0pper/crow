/**
 * Ramble moves — program stages (moves design, the stage program; private
 * engineering notes).
 *
 * What is pinned here:
 *   - the stage a routine is at: 1 with no row, the row's delta afterwards, and
 *     junk clamped into 1..STAGES_MAX,
 *   - a finished staged routine is recorded once per week, an entry with no id
 *     or no stages records nothing, and older weeks' staged lists are dropped,
 *   - an offer needs a WHOLE-BODY week (a `weekfull` wallet row). The week of
 *     `now` is asked first and the week before it second, and a whole-body week
 *     with nothing to offer falls through to the one before it; a routine with
 *     no stages, a routine already at its last stage and a routine done in a
 *     week that was not whole-body are never offered,
 *   - nothing raises a stage but accepting one: offering many times, days
 *     apart, writes no wallet row and no setting at all,
 *   - accepting raises the stage by exactly one, by compare-and-swap: a second
 *     answer in the same week is refused, two calls started together take one
 *     stage between them, and a stale read loses the swap and writes nothing,
 *   - declining records the answer and no stage row, so the same week is not
 *     asked again while a later whole-body week is,
 *   - a staged routine still plans at least 600 seconds at every stage it
 *     carries.
 *
 * The library here is built in-test; nothing here reads the shipped moves
 * library. Days are fixed local noons, so no test depends on the machine's
 * timezone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { STAGES_MAX } from "../bundles/ramble/server/moves/library.js";
import { weekIdOf } from "../bundles/ramble/server/moves/week.js";
import { readJson } from "../bundles/ramble/server/moves/today.js";
import { WEEKFULL_KIND } from "../bundles/ramble/server/wardrobe.js";
import {
  ANSWERED_KEY, STAGED_PREFIX, STAGE_KIND,
  acceptStage, declineStage, noteRoutineDone, offerStage, stageOf,
} from "../bundles/ramble/server/moves/stages.js";

const require = createRequire(import.meta.url);
const SESSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)), "..",
  "bundles", "ramble", "server", "moves", "session.cjs",
);
const { MIN_STAGE_SECONDS, compileSession } = require(SESSION_PATH);

/* ---------- fixed days ---------- */

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const noon = (year, month, date) => new Date(year, month - 1, date, 12, 0, 0, 0).getTime();

const NOW_W46 = noon(2026, 11, 12);
const NOW_W47 = noon(2026, 11, 18);
const DAY_W44 = "2026-10-29";
const DAY_W45 = "2026-11-05";
const DAY_W46 = "2026-11-12";
const DAY_W47 = "2026-11-17";

const W44 = "2026-W44";
const W45 = "2026-W45";
const W46 = "2026-W46";
const W47 = "2026-W47";

/* ---------- fixture library ---------- */

const POSE_IDS = ["pose-w1", "pose-w2", "pose-m1", "pose-m2", "pose-c1", "pose-c2"];

function poseEntry(id) {
  return {
    id,
    kind: "pose",
    minutes: 1,
    pose: { rootAngle: 30 },
    steps: [{ text: id + " text", cue: id + " cue", say: id + " say" }],
  };
}

function exerciseEntry(id) {
  return {
    id,
    kind: "exercise",
    minutes: 1,
    reps: 10,
    poses: [{ rootAngle: 1 }, { rootAngle: 2 }],
    steps: [{ text: id + " text", cue: id + " cue", say: id + " say" }],
  };
}

/** Warm-up 2 x 60 s, main 3 x (60 s + 10 s rest), cool-down 2 x 60 s: 660 s at two rounds. */
const BLOCKS = {
  warmup: [{ id: "pose-w1", seconds: 60 }, { id: "pose-w2", seconds: 60 }],
  main: [
    { id: "pose-m1", seconds: 60, restSeconds: 10 },
    { id: "ex-reps", seconds: 60, restSeconds: 10 },
    { id: "pose-m2", seconds: 60, restSeconds: 10 },
  ],
  cooldown: [{ id: "pose-c1", seconds: 60 }, { id: "pose-c2", seconds: 60 }],
};

function routineEntry(id, over = {}) {
  return {
    id,
    kind: "routine",
    minutes: 11,
    rounds: 2,
    steps: [{ text: "blocks in order", cue: "blocks", say: "work through the blocks" }],
    blocks: BLOCKS,
    ...over,
  };
}

/** A routine with three stages, one with four, and one with none. */
const GROW_THREE = routineEntry("grow-three", {
  stages: [{ rounds: 1 }, { reps: 4 }, { rounds: 3 }],
});
const GROW_FOUR = routineEntry("grow-four", {
  stages: [{ rounds: 1 }, { rounds: 2 }, { reps: 4 }, { rounds: 3 }],
});
const PLAIN = routineEntry("plain-one");

const LIB = [
  ...POSE_IDS.map((id) => poseEntry(id)),
  exerciseEntry("ex-reps"),
  GROW_THREE,
  GROW_FOUR,
  PLAIN,
];

/** The library entry a routine id names. */
const entryOf = (id) => LIB.find((entry) => entry.id === id);

/* ---------- db helpers ---------- */

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A whole-body week, as the ledger records it: one row per ISO week id. */
async function weekfull(db, weekId) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)",
    args: [WEEKFULL_KIND, weekId, NOW_W46],
  });
}

/** Put a routine's stage row where a test needs it, absent row or not. */
async function setStage(db, routineId, delta) {
  await db.execute({
    sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(kind, key) DO UPDATE SET delta = excluded.delta`,
    args: [STAGE_KIND, routineId, delta, NOW_W46],
  });
}

async function walletRows(db) {
  const result = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ramble_wallet", args: [] });
  return Number(result.rows[0].n);
}

async function settingsRows(db) {
  const result = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ramble_settings", args: [] });
  return Number(result.rows[0].n);
}

async function stagedKeys(db) {
  const result = await db.execute({
    sql: "SELECT key FROM ramble_settings WHERE key LIKE ? ORDER BY key",
    args: [STAGED_PREFIX + "%"],
  });
  return result.rows.map((row) => String(row.key));
}

/**
 * A db whose SECOND read of a routine's stage row is answered from before
 * another instance moved that row to stage 2 — and which really moves it right
 * after that read. That is the "somebody else wrote between my read and my
 * write" case, without needing two real instances.
 */
function staleStageDb(db) {
  const real = db.execute.bind(db);
  let stageReads = 0;
  return {
    execute: async (statement) => {
      const result = await real(statement);
      const sql = String(statement?.sql ?? "");
      const kind = Array.isArray(statement?.args) ? statement.args[0] : null;
      if (kind === STAGE_KIND && sql.trim().startsWith("SELECT delta FROM ramble_wallet")) {
        stageReads += 1;
        if (stageReads === 2) {
          await real({
            sql: "UPDATE ramble_wallet SET delta = 2 WHERE kind = ? AND key = ?",
            args: [STAGE_KIND, String(statement.args[1])],
          });
        }
      }
      return result;
    },
  };
}

/* ---------- stageOf ---------- */

test("stageOf: 1 with no row, the row's own delta, and junk clamped to 1..4", async () => {
  const db = await freshDb();
  assert.equal(await stageOf(db, "grow-four"), 1, "no row is the first stage");
  for (const junk of [undefined, null, "", 3, {}, ["grow-four"]]) {
    assert.equal(await stageOf(db, junk), 1, "an id that is no id is the first stage: " + String(junk));
  }

  await setStage(db, "grow-four", 1);
  assert.equal(await stageOf(db, "grow-four"), 1);
  await setStage(db, "grow-four", 2);
  assert.equal(await stageOf(db, "grow-four"), 2);
  await setStage(db, "grow-four", STAGES_MAX);
  assert.equal(await stageOf(db, "grow-four"), STAGES_MAX);

  for (const [junk, want] of [[0, 1], [-5, 1], [STAGES_MAX + 3, STAGES_MAX]]) {
    await setStage(db, "grow-four", junk);
    assert.equal(await stageOf(db, "grow-four"), want, "a junk delta of " + junk);
  }
  assert.equal(await stageOf(db, "grow-three"), 1, "another routine keeps its own row");
});

/* ---------- noteRoutineDone ---------- */

test("noteRoutineDone records an id once per week and ignores an entry with nothing to record", async () => {
  const db = await freshDb();
  const key = STAGED_PREFIX + W46;

  assert.equal(await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") }), true);
  assert.equal(weekIdOf(NOW_W46), W46);
  assert.deepEqual(await readJson(db, key), ["grow-four"]);

  assert.equal(await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") }), true,
    "a repeat is still recorded");
  assert.deepEqual(await readJson(db, key), ["grow-four"], "a repeat adds nothing");

  assert.equal(await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-three") }), true);
  assert.deepEqual((await readJson(db, key)).slice().sort(), ["grow-four", "grow-three"]);

  const recorded = await readJson(db, key);
  const rows = await settingsRows(db);
  for (const entry of [entryOf("plain-one"), { stages: [{}] }, { id: "", stages: [{}] }, null, "grow-four"]) {
    assert.equal(await noteRoutineDone(db, { day: DAY_W46, entry }), false,
      "nothing to record: " + JSON.stringify(entry));
  }
  for (const day of ["", "2026-11-31", "12-11-2026", "2026-11-12T12:00", null, undefined]) {
    assert.equal(await noteRoutineDone(db, { day, entry: entryOf("grow-four") }), false,
      "no week for the day " + String(day));
  }
  assert.deepEqual(await readJson(db, key), recorded, "a refused note writes nothing");
  assert.equal(await settingsRows(db), rows, "and adds no settings row");
});

test("noteRoutineDone keeps only the current and the previous week's staged rows", async () => {
  const db = await freshDb();
  const note = (day, id) => noteRoutineDone(db, { day, entry: entryOf(id) });

  await note(DAY_W44, "grow-four");
  assert.equal(weekIdOf(noon(2026, 10, 29)), W44);
  assert.deepEqual(await stagedKeys(db), [STAGED_PREFIX + W44]);

  await note(DAY_W45, "grow-four");
  assert.deepEqual(await stagedKeys(db), [STAGED_PREFIX + W44, STAGED_PREFIX + W45],
    "the previous week is kept");

  await note(DAY_W46, "grow-four");
  assert.deepEqual(await stagedKeys(db), [STAGED_PREFIX + W45, STAGED_PREFIX + W46],
    "the week before the previous one is dropped");
  assert.deepEqual(await readJson(db, STAGED_PREFIX + W45), ["grow-four"], "and the kept list is unchanged");
  assert.deepEqual(await readJson(db, STAGED_PREFIX + W46), ["grow-four"]);
});

/* ---------- offerStage ---------- */

test("offerStage is null without a whole-body week, and offers the routine once its week is whole", async () => {
  const db = await freshDb();
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), null, "nothing recorded yet");

  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), null,
    "the week the routine was done in was not whole-body");

  await weekfull(db, W46);
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), "grow-four");
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB.slice() }), "grow-four",
    "another array holding the same entries offers the same routine");
});

test("offerStage: a routine with no stages, and a routine at its last stage, are never offered", async () => {
  const db = await freshDb();
  await weekfull(db, W46);

  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("plain-one") });
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), null,
    "a routine the library gives no stages is not offered");

  const db2 = await freshDb();
  await weekfull(db2, W46);
  await noteRoutineDone(db2, { day: DAY_W46, entry: entryOf("grow-three") });
  await setStage(db2, "grow-three", 2);
  assert.equal(await offerStage(db2, { now: NOW_W46, library: LIB }), "grow-three",
    "one stage short of its last is still offered");
  await setStage(db2, "grow-three", 3);
  assert.equal(await offerStage(db2, { now: NOW_W46, library: LIB }), null,
    "its last stage is not offered");
  await setStage(db2, "grow-three", STAGES_MAX);
  assert.equal(await offerStage(db2, { now: NOW_W46, library: LIB }), null,
    "a stage at the cap is not offered");
});

test("offerStage: a routine done in a week that was not whole-body is not offered", async () => {
  const db = await freshDb();
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });
  await weekfull(db, W45);
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), null,
    "this week has no whole-body row and last week staged nothing");
});

test("offerStage: last week's whole-body week still offers this week", async () => {
  const db = await freshDb();
  await noteRoutineDone(db, { day: DAY_W45, entry: entryOf("grow-four") });
  await weekfull(db, W45);
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), "grow-four");
});

test("offerStage: a whole-body week with nothing staged falls through to the week before", async () => {
  const db = await freshDb();
  await noteRoutineDone(db, { day: DAY_W45, entry: entryOf("grow-four") });
  await weekfull(db, W45);
  await weekfull(db, W46);

  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), "grow-four",
    "this week is whole-body but staged nothing, so last week's routine is asked");

  assert.deepEqual(
    await acceptStage(db, { routineId: "grow-four", now: NOW_W46, library: LIB }),
    { ok: true, stage: 2 },
    "the routine last week asked about can be accepted this week",
  );
  assert.deepEqual(await readJson(db, ANSWERED_KEY), { "grow-four": W45 },
    "the week whose offer was answered is last week's");
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), null,
    "and that week does not ask again");
});

test("offerStage: this week's answered routine falls through to last week's other staged routine", async () => {
  const db = await freshDb();
  await noteRoutineDone(db, { day: DAY_W45, entry: entryOf("grow-four") });
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-three") });
  await weekfull(db, W45);
  await weekfull(db, W46);

  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), "grow-three",
    "this week's routine comes first");
  assert.deepEqual(
    await declineStage(db, { routineId: "grow-three", now: NOW_W46, library: LIB }),
    { ok: true },
  );

  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), "grow-four",
    "this week has nothing unanswered left, so last week's routine is asked");
  assert.deepEqual(await readJson(db, ANSWERED_KEY), { "grow-three": W46 },
    "declining wrote this week's answer and nothing else");
  assert.equal(await stageOf(db, "grow-three"), 1, "and left the declined routine where it was");
});

test("offerStage: when both weeks offer, this week's routine wins", async () => {
  const db = await freshDb();
  await noteRoutineDone(db, { day: DAY_W45, entry: entryOf("grow-four") });
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-three") });
  await weekfull(db, W45);
  await weekfull(db, W46);

  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), "grow-three",
    "two whole-body weeks with a routine each: the newer one is asked");
  assert.equal(await offerStage(db, { now: NOW_W47, library: LIB }), "grow-three",
    "and the week after still asks the newer of the two remaining weeks");
});

test("a stage never rises by itself: offering many times, days apart, writes nothing", async () => {
  const db = await freshDb();
  await weekfull(db, W46);
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });

  const wallet = await walletRows(db);
  const settings = await settingsRows(db);

  for (let step = 0; step < 12; step += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await offerStage(db, { now: NOW_W46 + step * 6 * 3600 * 1000, library: LIB }), "grow-four");
  }
  assert.equal(await stageOf(db, "grow-four"), 1, "still the first stage");

  // Days later: the next week asks about it through last week's whole-body row.
  assert.equal(await offerStage(db, { now: NOW_W47, library: LIB }), "grow-four");
  assert.equal(await stageOf(db, "grow-four"), 1, "still the first stage, a week on");

  assert.equal(await walletRows(db), wallet, "offering adds no wallet row");
  assert.equal(await settingsRows(db), settings, "offering writes no setting");
});

/* ---------- acceptStage ---------- */

test("acceptStage: refuses a routine nobody offered, then raises the stage by exactly one", async () => {
  const db = await freshDb();
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });

  assert.deepEqual(
    await acceptStage(db, { routineId: "grow-four", now: NOW_W46, library: LIB }),
    { ok: false, reason: "not-offered" },
    "no whole-body week yet",
  );
  assert.equal(await readJson(db, ANSWERED_KEY), null, "a refusal records no answer");
  assert.equal(await stageOf(db, "grow-four"), 1, "and no stage row");

  await weekfull(db, W46);
  const emitted = [];
  const out = await acceptStage(db, {
    routineId: "grow-four", now: NOW_W46, library: LIB,
    emit: async (...args) => { emitted.push(args); },
  });
  assert.deepEqual(out, { ok: true, stage: 2 });
  assert.equal(await stageOf(db, "grow-four"), 2);

  assert.equal(emitted.length, 1, "one wallet row is emitted");
  const [table, op, row] = emitted[0];
  assert.equal(table, "ramble_wallet");
  assert.equal(op, "update");
  assert.equal(row.kind, STAGE_KIND);
  assert.equal(row.key, "grow-four");
  assert.equal(row.delta, 2);
  assert.deepEqual(await readJson(db, ANSWERED_KEY), { "grow-four": W46 });

  assert.deepEqual(
    await acceptStage(db, { routineId: "grow-four", now: NOW_W46, library: LIB }),
    { ok: false, reason: "not-offered" },
    "the same week cannot take a second stage",
  );
  assert.equal(await stageOf(db, "grow-four"), 2, "so the stage rose by one in total");

  assert.deepEqual(
    await acceptStage(db, { routineId: "plain-one", now: NOW_W46, library: LIB }),
    { ok: false, reason: "not-offered" },
    "a routine nobody offered is refused",
  );
  assert.deepEqual(
    await acceptStage(db, { routineId: "grow-four", now: NOW_W47, library: LIB }),
    { ok: false, reason: "not-offered" },
    "and a week with nothing staged offers nothing",
  );
});

test("two instances racing from one offer take one stage between them", async () => {
  const db = await freshDb();
  await weekfull(db, W46);
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });
  const wallet = await walletRows(db);

  const outcomes = await Promise.all([
    acceptStage(db, { routineId: "grow-four", now: NOW_W46, library: LIB }),
    acceptStage(db, { routineId: "grow-four", now: NOW_W46, library: LIB }),
  ]);

  const wins = outcomes.filter((out) => out.ok === true);
  assert.equal(wins.length, 1, "one accept wins");
  assert.deepEqual(wins[0], { ok: true, stage: 2 });
  for (const out of outcomes.filter((candidate) => candidate.ok !== true)) {
    assert.ok(["lost", "not-offered"].includes(out.reason), "the other is refused: " + String(out.reason));
  }
  assert.equal(await stageOf(db, "grow-four"), 2, "the stage rose by one in total");
  assert.equal(await walletRows(db), wallet + 1, "and only one stage row was written");
});

test("a stale instance loses the compare-and-swap and writes nothing more", async () => {
  const db = await freshDb();
  await weekfull(db, W46);
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });
  // The row this instance reads, which another instance then moves on.
  await setStage(db, "grow-four", 1);
  const settings = await settingsRows(db);

  const emitted = [];
  const out = await acceptStage(staleStageDb(db), {
    routineId: "grow-four", now: NOW_W46, library: LIB,
    emit: async (...args) => { emitted.push(args); },
  });

  assert.deepEqual(out, { ok: false, reason: "lost" });
  assert.equal(await stageOf(db, "grow-four"), 2, "the other instance's stage stands");
  assert.equal(await readJson(db, ANSWERED_KEY), null, "a lost accept records no answer");
  assert.equal(await settingsRows(db), settings, "and writes no setting");
  assert.deepEqual(emitted, [], "and emits nothing");
});

/* ---------- declineStage ---------- */

test("declineStage records the answer, writes no stage row, and a later whole-body week asks again", async () => {
  const db = await freshDb();
  await weekfull(db, W46);
  await noteRoutineDone(db, { day: DAY_W46, entry: entryOf("grow-four") });

  assert.deepEqual(
    await declineStage(db, { routineId: "plain-one", now: NOW_W46, library: LIB }),
    { ok: false, reason: "not-offered" },
    "nobody offered that routine",
  );
  assert.equal(await readJson(db, ANSWERED_KEY), null);

  const wallet = await walletRows(db);
  assert.deepEqual(await declineStage(db, { routineId: "grow-four", now: NOW_W46, library: LIB }), { ok: true });
  assert.deepEqual(await readJson(db, ANSWERED_KEY), { "grow-four": W46 });
  assert.equal(await walletRows(db), wallet, "declining writes no wallet row");
  assert.equal(await stageOf(db, "grow-four"), 1, "and no stage row: the stage stays where it was");
  assert.equal(await offerStage(db, { now: NOW_W46, library: LIB }), null,
    "the same week is not asked again");

  await weekfull(db, W47);
  await noteRoutineDone(db, { day: DAY_W47, entry: entryOf("grow-four") });
  assert.equal(await offerStage(db, { now: NOW_W47, library: LIB }), "grow-four",
    "a later whole-body week offers it again");
  assert.equal(await stageOf(db, "grow-four"), 1, "still the stage the player was at");
});

/* ---------- the session a stage compiles to ---------- */

test("a staged routine still plans at least 600 seconds at every stage it carries", () => {
  assert.equal(MIN_STAGE_SECONDS, 600);
  assert.equal(GROW_FOUR.stages.length, STAGES_MAX, "the fixture routine has every stage");

  const plain = compileSession([{ chunkId: "grow-four", extraRounds: 0 }], LIB);
  assert.equal(plain.chunks.length, 1);
  assert.ok(plain.chunks[0].plannedSeconds >= MIN_STAGE_SECONDS);

  for (let stage = 0; stage < GROW_FOUR.stages.length; stage += 1) {
    const timeline = compileSession([{ chunkId: "grow-four", extraRounds: 0 }], LIB, { stage });
    assert.equal(timeline.chunks.length, 1, "stage " + stage);
    assert.ok(timeline.chunks[0].plannedSeconds >= MIN_STAGE_SECONDS,
      "stage " + stage + " plans " + timeline.chunks[0].plannedSeconds + " s");
  }
});