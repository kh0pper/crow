/**
 * Moves design Task 4.1 — a chunk is paid by its active minutes.
 *
 * What is pinned here:
 *   - a started chunk pays the chunk rate for the minutes it actually logged,
 *     incrementally: the second post pays only the difference,
 *   - a card passes its half-way mark (isChunkDone) and keeps reporting `done`
 *     after a later, lower post,
 *   - the pay comes out of the day's budget (indoor or outdoor by the entry),
 *     and stops there with `capped: true`,
 *   - a post for a card that was never started is refused and writes nothing,
 *   - `movecard` (Health paid for the card) and `movemin` (whole minutes that
 *     day) only ever grow, and the two `local.` settings rows are never emitted,
 *   - `plannedSecondsFor` reads the compiled chunk's planned time when the
 *     caller's chain names it, and the entry's own minutes otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { petState } from "../bundles/ramble/server/pet.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import {
  chunkPoints, MovesInputError, MOVE_INDOOR_KIND, MOVE_OUTDOOR_KIND, INDOOR_DAILY_CAP,
} from "../bundles/ramble/server/moves/ledger.js";
import {
  startChunk, startedEntryId, recordProgress, plannedSecondsFor, extraCardKey, extrasCount,
  MOVE_CARD_KIND, MOVE_MIN_KIND,
} from "../bundles/ramble/server/moves/progress.js";

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();
const DAY0 = localDay(T0);
const MIN = 60000;

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A library-shaped entry; the module reads id/minutes/indoor/activity. */
function entry(over = {}) {
  return {
    id: "test-entry", kind: "pose", title: "Test entry", minutes: 10, level: 1,
    indoor: true, activity: "yoga", equipment: ["none"], tags: [],
    steps: ["do the thing"], works: [], stretches: [], mistakes: [], skipIf: [],
    easier: null, harder: null, sources: [], reviewed: true, pose: {}, ...over,
  };
}

/** Records every row a call emits, whatever the table. */
function collector(seen) {
  return async (table, op, row) => { seen.push({ table, op, key: row?.key, kind: row?.kind }); };
}

async function walletRowsOf(db, kind, key) {
  const { rows } = await db.execute({
    sql: "SELECT key, delta FROM ramble_wallet WHERE kind = ? AND key = ?",
    args: [kind, key],
  });
  return rows.map((r) => ({ key: String(r.key), delta: Number(r.delta) }));
}

/* ------------------------------------------------------------ the pay rate */

test("600 active seconds of a 600-second indoor chunk pays the chunk and marks it done", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  const started = await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  assert.equal(started.startedAt, T0);

  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry({ minutes: 10 }), activeSeconds: 600, now: T0 + 11 * MIN,
  });
  assert.deepEqual(out, { paid: 12, total: 12, done: true, capped: false, accepted: 600 });
  assert.equal(chunkPoints(10), 12);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12, "the day's indoor budget paid it");
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, cardKey), [{ key: cardKey, delta: 12 }],
    "exactly one card row, holding what the card has paid");
  assert.equal((await petState(db, { now: T0 + 11 * MIN })).energy, 72, "the bird got the Health");
});

test("300 active seconds of a 600-second chunk is done and pays half; a later 600 pays only the rest", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":early";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });

  const half = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 300, now: T0 + 11 * MIN,
  });
  assert.deepEqual(
    { paid: half.paid, done: half.done, accepted: half.accepted },
    { paid: 6, done: true, accepted: 300 },
    "300 of 600 is the half-way mark, worth five minutes",
  );
  assert.equal((await petState(db, { now: T0 + 11 * MIN })).energy, 66);

  const rest = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 12 * MIN,
  });
  assert.equal(rest.paid, 6, "only the difference reaches the bird");
  assert.equal(rest.total, 12);
  assert.equal(rest.done, true);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12);
  assert.equal((await petState(db, { now: T0 + 12 * MIN })).energy, 72);
});

test("299 active seconds of 600 is not done, and pays the whole minutes it holds", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":evening";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 299, now: T0 + 11 * MIN,
  });
  assert.equal(out.done, false, "one second short of the half-way mark");
  assert.equal(out.accepted, 299);
  assert.equal(out.paid, 5, "four whole minutes is chunkPoints(4) = 5");
  assert.equal(chunkPoints(4), 5);
  assert.equal(out.total, 5);
});

/* --------------------------------------------------------------- the budgets */

test("pay stops at the indoor budget and says so", async () => {
  const db = await freshDb();
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [MOVE_INDOOR_KIND, DAY0, 36, T0],
  });
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN,
  });
  assert.equal(out.paid, 4, "the last four of a 40-a-day budget");
  assert.equal(out.capped, true);
  assert.equal(out.total, 4, "the card row holds only what it was paid");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);
});

test("an outdoor entry draws on the outdoor budget and leaves the indoor one alone", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry({ indoor: false, activity: "walk" }), activeSeconds: 600, now: T0 + 11 * MIN,
  });
  assert.equal(out.paid, 12);
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), 12);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), null, "an outdoor card never draws the indoor budget");
});

/* ---------------------------------------------------------- no start, no pay */

test("a post for a card that was never started is refused and writes nothing", async () => {
  const db = await freshDb();
  await assert.rejects(
    () => recordProgress(db, {
      day: DAY0, cardKey: DAY0 + ":day", entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN,
    }),
    MovesInputError,
  );
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_wallet", args: [] });
  assert.equal(Number(rows[0].n), 0, "no card row, no budget row");
  assert.equal(await rowDelta(db, MOVE_CARD_KIND, DAY0 + ":day"), null);
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), null);
  await assert.rejects(
    () => recordProgress(db, { day: DAY0, cardKey: "", entry: entry(), activeSeconds: 10, now: T0 }),
    MovesInputError,
    "a junk card key is refused too",
  );
});

/* --------------------------------------------------------- minutes and growth */

test("movemin for the day grows by the whole minutes accepted, and never shrinks", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":evening";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });

  await recordProgress(db, { day: DAY0, cardKey, entry: entry(), activeSeconds: 300, now: T0 + 11 * MIN });
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), 5);

  await recordProgress(db, { day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 12 * MIN });
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), 10);

  const lower = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 120, now: T0 + 20 * MIN,
  });
  assert.equal(lower.accepted, 600, "the high-water holds");
  assert.equal(lower.paid, 0, "and there is nothing left to pay for");
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), 10, "ten minutes, never nine");
});

/* ------------------------------------------------------------- start records */

test("a start binds the card to its entry, and the first binding holds", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  assert.equal(await startedEntryId(db, cardKey), null, "a card with no start record binds nothing");

  await startChunk(db, { day: DAY0, cardKey, entryId: "test-entry", plannedSeconds: 600, now: T0 });
  assert.equal(await startedEntryId(db, cardKey), "test-entry");

  await startChunk(db, {
    day: DAY0, cardKey, entryId: "other-entry", plannedSeconds: 900, now: T0 + 5 * MIN,
  });
  assert.equal(await startedEntryId(db, cardKey), "test-entry",
    "a retried start keeps the entry the card was opened for");

  assert.equal(await startedEntryId(db, "no-such-card"), null, "an unknown card binds nothing");

  const bare = DAY0 + ":early";
  await startChunk(db, { day: DAY0, cardKey: bare, plannedSeconds: 600, now: T0 });
  assert.equal(await startedEntryId(db, bare), null, "a start that names no entry binds nothing");

  const blank = DAY0 + ":evening";
  await startChunk(db, { day: DAY0, cardKey: blank, entryId: "", plannedSeconds: 600, now: T0 });
  assert.equal(await startedEntryId(db, blank), null, "an empty entry id is no entry id");
});

test("a second start keeps the first record, and the settings rows stay local and unemitted", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  const first = await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const second = await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 900, now: T0 + 5 * MIN });
  assert.equal(second.startedAt, first.startedAt, "a retried start keeps the session's anchor");

  const { rows } = await db.execute({ sql: "SELECT key, value FROM ramble_settings", args: [] });
  const keys = rows.map((r) => String(r.key));
  assert.deepEqual(keys.filter((k) => k.includes(cardKey)).every((k) => k.startsWith("local.")), true,
    "every row written for this card is a `local.` key: " + keys.join(", "));
  const startedRow = rows.find((r) => String(r.key) === "local.moves.started." + cardKey);
  assert.ok(startedRow, "the start record exists");
  assert.deepEqual(JSON.parse(String(startedRow.value)), { startedAt: T0, plannedSeconds: 600, entryId: null },
    "and it still carries the first plan");

  const emitted = [];
  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN, emit: collector(emitted),
  });
  assert.equal(out.paid, 12);
  assert.equal(emitted.filter((e) => e.table === "ramble_settings").length, 0,
    "no `local.` settings row is ever emitted");
  assert.ok(emitted.some((e) => e.kind === MOVE_CARD_KIND), "the card's wallet row is emitted");
});

/* ------------------------------------------------------------ planned length */

function holdEntry(over = {}) {
  return entry({ id: "hold-test", kind: "pose", minutes: 1, steps: ["Hold."], ...over });
}

function flowEntry(over = {}) {
  return entry({
    id: "flow-test", kind: "flow", minutes: 10, rounds: 2,
    flow: [{ id: "hold-test", holdSeconds: 30 }], ...over,
  });
}

test("plannedSecondsFor: the compiled chunk when the chain names it, else the entry's minutes", () => {
  const library = [holdEntry(), flowEntry()];
  const flow = library[1];

  // No chain: the entry's stated minutes.
  assert.equal(plannedSecondsFor({ entryId: "flow-test", library, entry: flow }), 600);
  assert.equal(plannedSecondsFor({ entryId: "flow-test", entry: entry({ minutes: 12 }) }), 720);
  assert.equal(plannedSecondsFor({ chain: [], entryId: "flow-test", library, entry: flow }), 600,
    "an empty chain is no chain");

  // One chunk: the compiler's own count — two rounds of a 30-second hold, the
  // opening round eased in at half time.
  const planned = plannedSecondsFor({
    chain: [{ chunkId: "flow-test", extraRounds: 0 }], entryId: "flow-test", library, entry: flow,
  });
  assert.equal(planned, 45);
  assert.ok(Number.isInteger(planned) && planned > 0);

  // A chain that does not name the entry (and one the compiler refuses) falls
  // back to the entry's minutes rather than failing.
  assert.equal(plannedSecondsFor({
    chain: [{ chunkId: "flow-test", extraRounds: 0 }], entryId: "other-id", library, entry: flow,
  }), 600);
  assert.equal(plannedSecondsFor({
    chain: [{ chunkId: "no-such-chunk", extraRounds: 0 }], entryId: "no-such-chunk", library, entry: flow,
  }), 600);
});

/* ---------------------------------------------------------------- growth only */

test("a lower post after a full one leaves movecard and moveindoor exactly as they were", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  await recordProgress(db, { day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN });

  const before = {
    card: await walletRowsOf(db, MOVE_CARD_KIND, cardKey),
    indoor: await walletRowsOf(db, MOVE_INDOOR_KIND, DAY0),
    minutes: await walletRowsOf(db, MOVE_MIN_KIND, DAY0),
    energy: (await petState(db, { now: T0 + 30 * MIN })).energy,
  };
  const lower = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 200, now: T0 + 30 * MIN,
  });
  assert.deepEqual(
    { paid: lower.paid, total: lower.total, done: lower.done, accepted: lower.accepted },
    { paid: 0, total: 12, done: true, accepted: 600 },
    "a late lower post reports the high-water and pays nothing",
  );
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, cardKey), before.card);
  assert.deepEqual(await walletRowsOf(db, MOVE_INDOOR_KIND, DAY0), before.indoor);
  assert.deepEqual(await walletRowsOf(db, MOVE_MIN_KIND, DAY0), before.minutes);
  assert.equal((await petState(db, { now: T0 + 30 * MIN })).energy, before.energy);
});

test("two posts for one card at the same instant pay the chunk once", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const at = T0 + 11 * MIN;
  const [a, b] = await Promise.all([
    recordProgress(db, { day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: at }),
    recordProgress(db, { day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: at }),
  ]);
  assert.equal(a.paid + b.paid, 12, "one chunk's worth between them");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12);
  assert.equal((await walletRowsOf(db, MOVE_CARD_KIND, cardKey))[0].delta, 12);
});

test("the accepted seconds are clamped to the wall clock, whatever the client claims", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 4 * MIN,
  });
  assert.ok(out.accepted < 600, "four minutes of wall clock cannot credit ten");
  assert.equal(out.accepted, Math.floor(240 * 1.1));
  assert.equal(out.done, false);
});

/* ------------------------------------------------- retries, order, cheating */

test("the same post twice pays once and moves no row the second time", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const post = () => recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN,
  });

  const first = await post();
  assert.deepEqual(first, { paid: 12, total: 12, done: true, capped: false, accepted: 600 });
  const before = {
    card: await walletRowsOf(db, MOVE_CARD_KIND, cardKey),
    indoor: await walletRowsOf(db, MOVE_INDOOR_KIND, DAY0),
    minutes: await walletRowsOf(db, MOVE_MIN_KIND, DAY0),
  };

  const second = await post();
  assert.deepEqual(
    { paid: second.paid, total: second.total, accepted: second.accepted, done: second.done },
    { paid: 0, total: 12, accepted: 600, done: true },
    "a retried post is already paid for",
  );
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, cardKey), before.card);
  assert.deepEqual(await walletRowsOf(db, MOVE_INDOOR_KIND, DAY0), before.indoor);
  assert.deepEqual(await walletRowsOf(db, MOVE_MIN_KIND, DAY0), before.minutes);
});

test("a 200-second post arriving after a 500-second one changes nothing and still reports done", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });

  const longer = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 500, now: T0 + 11 * MIN,
  });
  assert.equal(longer.accepted, 500);
  assert.equal(longer.paid, chunkPoints(8), "eight whole minutes");
  assert.equal(longer.done, true);
  const before = {
    card: await walletRowsOf(db, MOVE_CARD_KIND, cardKey),
    indoor: await walletRowsOf(db, MOVE_INDOOR_KIND, DAY0),
    minutes: await walletRowsOf(db, MOVE_MIN_KIND, DAY0),
  };

  const later = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 200, now: T0 + 12 * MIN,
  });
  assert.deepEqual(
    { paid: later.paid, accepted: later.accepted, total: later.total, done: later.done },
    { paid: 0, accepted: longer.accepted, total: longer.total, done: true },
    "a later, lower post neither pays nor takes the half-way mark back",
  );
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, cardKey), before.card);
  assert.deepEqual(await walletRowsOf(db, MOVE_INDOOR_KIND, DAY0), before.indoor);
  assert.deepEqual(await walletRowsOf(db, MOVE_MIN_KIND, DAY0), before.minutes);
});

test("active seconds far beyond the wall clock are cut to the clock plus 10%", async () => {
  const db = await freshDb();
  const cardKey = DAY0 + ":day";
  await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 6000, now: T0 + 100 * 1000,
  });
  assert.equal(out.accepted, 110, "100 seconds of wall clock is 110 accepted at most");
  assert.equal(out.paid, chunkPoints(1));
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), 1);
});

/* ---------------------------------------------------------------- day rule */

test("a card key from an older day is credited to today; yesterday keeps yesterday", async () => {
  const db = await freshDb();
  const stale = localDay(T0 - 2 * 86400000);
  const yesterday = localDay(T0 - 86400000);
  const staleKey = stale + ":day";
  const yesterdayKey = yesterday + ":evening";
  assert.notEqual(stale, DAY0);
  assert.notEqual(yesterday, DAY0);

  await startChunk(db, { day: stale, cardKey: staleKey, plannedSeconds: 600, now: T0 });
  const moved = await recordProgress(db, {
    day: stale, cardKey: staleKey, entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN,
  });
  assert.equal(moved.paid, 12);

  // The wallet carries the day the pay landed on, and the rest of the key. The
  // start record keeps the key the start was given, so the post still found it.
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, DAY0 + ":day"), [{ key: DAY0 + ":day", delta: 12 }]);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12, "today's budget paid it");
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), 10, "and today's minutes count it");
  for (const [kind, key] of [
    [MOVE_CARD_KIND, staleKey], [MOVE_INDOOR_KIND, stale], [MOVE_MIN_KIND, stale],
  ]) {
    assert.equal(await rowDelta(db, kind, key), null, `nothing is filed under the stale day: ${kind} ${key}`);
  }

  await startChunk(db, { day: yesterday, cardKey: yesterdayKey, plannedSeconds: 600, now: T0 });
  const kept = await recordProgress(db, {
    day: yesterday, cardKey: yesterdayKey, entry: entry(), activeSeconds: 600, now: T0 + 12 * MIN,
  });
  assert.equal(kept.paid, 12);
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, yesterdayKey), [{ key: yesterdayKey, delta: 12 }]);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, yesterday), 12, "yesterday's own budget paid it");
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, yesterday), 10);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12, "and today's is untouched by it");
});

/* ------------------------------------------------------------- extra cards */

test("extraCardKey is deterministic and stamped with the start second", () => {
  const at = T0 + 1000;
  const key = extraCardKey(DAY0, "test-entry", at);
  assert.equal(key, DAY0 + ":x:test-entry:" + Math.floor(at / 1000));
  assert.equal(extraCardKey(DAY0, "test-entry", at), key, "same inputs, same key");
  assert.match(key, /^\d{4}-\d{2}-\d{2}:x:[A-Za-z0-9_.-]{1,64}:\d{1,12}$/);
  assert.notEqual(extraCardKey(DAY0, "test-entry", at + 1000), key,
    "a second extra of the same entry started at another second is another card");
});

test("two extras of one entry are two cards, and extrasCount counts them", async () => {
  const db = await freshDb();
  assert.equal(await extrasCount(db, DAY0), 0, "a day with no extras counts none");
  assert.equal(await extrasCount(db, "junk"), 0);
  assert.equal(await extrasCount(db, DAY0 + ":x:%"), 0, "the day must be a day");

  const firstAt = T0 + 1000;
  const secondAt = T0 + 2 * MIN;
  const keys = [extraCardKey(DAY0, "test-entry", firstAt), extraCardKey(DAY0, "test-entry", secondAt)];
  const posts = [[keys[0], firstAt, 600], [keys[1], secondAt, 300]];
  const paid = [];
  for (const [key, startedAt, activeSeconds] of posts) {
    await startChunk(db, { day: DAY0, cardKey: key, plannedSeconds: 600, now: startedAt });
    const out = await recordProgress(db, {
      day: DAY0, cardKey: key, entry: entry(), activeSeconds, now: startedAt + 11 * MIN,
    });
    paid.push(out.paid);
  }
  assert.deepEqual(paid, [12, 6], "each extra pays its own minutes");

  // Two distinct keys, so a MAX merge of one can never hide the other.
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, keys[0]), [{ key: keys[0], delta: 12 }]);
  assert.deepEqual(await walletRowsOf(db, MOVE_CARD_KIND, keys[1]), [{ key: keys[1], delta: 6 }]);
  assert.equal(await extrasCount(db, DAY0), 2);
  assert.equal(await extrasCount(db, localDay(T0 - 86400000)), 0, "another day has none");
  assert.equal(await rowDelta(db, MOVE_MIN_KIND, DAY0), 15, "ten minutes then five, for the one day");
});

test("startChunk records an extra under its own key, and a retried start keeps its anchor", async () => {
  const db = await freshDb();
  const cardKey = extraCardKey(DAY0, "test-entry", T0);
  const first = await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 600, now: T0 });
  assert.equal(first.startedAt, T0);
  const retried = await startChunk(db, { day: DAY0, cardKey, plannedSeconds: 900, now: T0 + 5 * MIN });
  assert.equal(retried.startedAt, T0, "the retry keeps the session's anchor");

  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_settings WHERE key = ?",
    args: ["local.moves.started." + cardKey],
  });
  assert.equal(rows.length, 1, "one start record, under the extra's own key");

  const out = await recordProgress(db, {
    day: DAY0, cardKey, entry: entry(), activeSeconds: 600, now: T0 + 11 * MIN,
  });
  assert.equal(out.paid, 12, "and the extra pays through on the key it started with");
  assert.equal(await extrasCount(db, DAY0), 1);
});