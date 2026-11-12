/**
 * Moves design Task 5 — today's challenge, the prefs and the midnight rule.
 *
 * What is pinned here:
 *   - the pick is stable all day and re-picked on a new local day,
 *   - the stored card is reused (and swapped in place) rather than re-rolled,
 *   - a stored card that is no longer a chunk, or whose entry the library no
 *     longer holds, is re-picked with today's swap count and seen list kept,
 *     and a Done day stays Done through that replacement,
 *   - a stated limit beats even a card stored before the limit was set,
 *   - two devices that each pick converge on one card under the settings LWW,
 *     and a Done on each still credits the day once after the wallet merges,
 *   - a card picked at 23:58 and marked Done at 00:02 is filed under the day
 *     it was picked for, and the new day is untouched,
 *   - swap refuses the fourth re-roll, and never re-lands on an entry already
 *     shown today (the stored `seen` list; a one-entry day refuses),
 *   - challenges off writes the day's `moveoff` fact and shows no card,
 *   - prefs are read defensively and written strictly (an unknown limit tag
 *     is refused), and `whyLine` only ever says what the reason codes say.
 *
 * The shipped library is still empty here (Task 10 fills it), so every test
 * injects its own picker-shaped entries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import {
  recordChallengeDone, movesDay, MOVE_DONE_KIND, MOVE_INDOOR_KIND,
} from "../bundles/ramble/server/moves/ledger.js";
import { pickChallenge } from "../bundles/ramble/server/moves/picker.js";
import { applyRambleSetting, applyRambleWallet } from "../servers/sharing/instance-sync.js";
import {
  DEFAULT_PREFS, MAX_SWAPS, MOVE_OFF_KIND, PREFS_KEY, TODAY_KEY,
  MovesPrefsError, readPrefs, writePrefs, todayChallenge, todayForSurface, swapChallenge, whyLine,
} from "../bundles/ramble/server/moves/today.js";
import { forYouMoves } from "../bundles/ramble/server/for-you.js";

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();
const HOUR = 3600 * 1000;
const DAY0 = localDay(T0);

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A picker- and ledger-shaped entry; each test overrides what it is about. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "routine",
    title: "Test entry",
    minutes: 10,
    level: 1,
    indoor: true,
    activity: "bodyweight",
    equipment: ["none"],
    tags: [],
    steps: ["do the thing"],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [],
    reviewed: true,
    pose: {},
    ...over,
  };
}

/** The prefs a normal picker test opens up: every activity, every equipment. */
const PREFS = {
  on: true,
  kinds: [],
  equipment: ["none", "mat", "band", "chair", "wall"],
  limits: [],
  level: 3,
  weather: true,
};

async function readSetting(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?",
    args: [key],
  });
  return rows[0]?.value ?? null;
}

async function writeSetting(db, key, value) {
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

/** Records settings and wallet rows, in order, so a test can replay them. */
function collector() {
  const all = [];
  return {
    all,
    emit: async (table, op, row) => {
      if (table === "ramble_settings" || table === "ramble_wallet") all.push({ table, op, row });
    },
  };
}

function rowsOf(c, table, key) {
  return c.all.filter((x) => x.table === table && (key === undefined || x.row.key === key));
}

const latestOf = (c, table, key) => rowsOf(c, table, key).pop() ?? null;

/* ------------------------------------------------------------------ prefs */

test("readPrefs: defaults on a fresh db, and one junk field never blanks the rest", async () => {
  const db = await freshDb();
  assert.deepEqual(await readPrefs(db), DEFAULT_PREFS);

  await writeSetting(db, PREFS_KEY, "not json at all");
  assert.deepEqual(await readPrefs(db), DEFAULT_PREFS, "unreadable JSON falls back whole");

  await writeSetting(db, PREFS_KEY, JSON.stringify({
    on: "yes", kinds: ["yoga", "flying"], equipment: ["mat", "jetpack"],
    limits: ["knee", "elbow"], level: 9, weather: 0,
  }));
  assert.deepEqual(await readPrefs(db), {
    on: true,
    kinds: ["yoga"],
    equipment: ["mat"],
    limits: ["knee"],
    level: 2,
    weather: true,
    cards: 3,
    windows: [],
    contactsSeeMoved: true,
  }, "each field falls back alone; unknown vocabulary members are dropped");

  // Every equipment value unknown is the same statement as none at all: the
  // default ("no equipment"), never an empty list.
  await writeSetting(db, PREFS_KEY, JSON.stringify({
    ...DEFAULT_PREFS, equipment: ["jetpack", "trampoline"],
  }));
  assert.deepEqual((await readPrefs(db)).equipment, ["none", "wall"]);

  await writeSetting(db, PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, equipment: [] }));
  assert.deepEqual((await readPrefs(db)).equipment, ["none", "wall"], "an empty list reads as no equipment");
});

test("writePrefs: merges, validates, and an unknown limit tag is refused with nothing written", async () => {
  const db = await freshDb();
  const c = collector();
  const prefs = await writePrefs(db, { level: 1, kinds: ["yoga"] }, { emit: c.emit });
  assert.deepEqual(prefs, { ...DEFAULT_PREFS, level: 1, kinds: ["yoga"] });

  const row = latestOf(c, "ramble_settings", PREFS_KEY);
  assert.ok(row, "the write is emitted as a ramble_settings update");
  assert.equal(row.op, "update");
  assert.deepEqual(JSON.parse(row.row.value), prefs);
  assert.deepEqual(await readPrefs(db), prefs);

  const before = await readSetting(db, PREFS_KEY);
  await assert.rejects(() => writePrefs(db, { limits: ["elbow"] }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { kinds: ["flying"] }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { equipment: ["jetpack"] }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { level: 4 }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { on: "yes" }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { limits: "knee" }), MovesPrefsError);
  assert.equal(await readSetting(db, PREFS_KEY), before, "a rejected patch writes nothing");

  // LIMIT_TAGS is the vocabulary, not an arbitrary string.
  const withKnee = await writePrefs(db, { limits: ["knee"] });
  assert.deepEqual(withKnee.limits, ["knee"]);
});

test("prefs defaults: three cards, no windows named, contacts see a moved card", async () => {
  assert.equal(DEFAULT_PREFS.cards, 3);
  assert.deepEqual(DEFAULT_PREFS.windows, []);
  assert.equal(DEFAULT_PREFS.contactsSeeMoved, true);

  const db = await freshDb();
  const prefs = await readPrefs(db);
  assert.equal(prefs.cards, 3);
  assert.deepEqual(prefs.windows, []);
  assert.equal(prefs.contactsSeeMoved, true);
  assert.notEqual(prefs.windows, DEFAULT_PREFS.windows, "the read carries its own array");
  prefs.windows.push("midday");
  assert.deepEqual(await readPrefs(db), DEFAULT_PREFS, "a local edit does not reach the defaults");
});

test("writePrefs: cards round-trips and leaves the other fields alone", async () => {
  const db = await freshDb();
  await writePrefs(db, { level: 1, limits: ["knee"] });

  const prefs = await writePrefs(db, { cards: 2 });
  assert.equal(prefs.cards, 2);
  assert.equal(prefs.level, 1);
  assert.deepEqual(prefs.limits, ["knee"]);
  assert.equal(prefs.on, true);
  assert.deepEqual(prefs.windows, []);
  assert.equal(prefs.contactsSeeMoved, true);

  const read = await readPrefs(db);
  assert.equal(read.cards, 2);
  assert.equal(read.level, 1);

  assert.equal((await writePrefs(db, { cards: 1 })).cards, 1);
  assert.equal((await writePrefs(db, { cards: 3 })).cards, 3);
});

test("writePrefs: a cards value outside 1, 2 and 3 is refused", async () => {
  const db = await freshDb();
  const before = await readSetting(db, PREFS_KEY);
  for (const cards of [0, 4, "2", 2.5, -1, null, [2]]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => writePrefs(db, { cards }), (err) => {
      assert.ok(err instanceof MovesPrefsError);
      assert.equal(err.message, "cards must be 1, 2 or 3");
      return true;
    }, `cards ${JSON.stringify(cards)} is not a card count`);
  }
  assert.equal(await readSetting(db, PREFS_KEY), before, "a refused patch writes nothing");
  assert.equal((await readPrefs(db)).cards, 3);
});

test("readPrefs: a stored cards value outside 1, 2 and 3 reads as three", async () => {
  const db = await freshDb();
  for (const cards of [9, "x", 0, null, 1.5]) {
    await writeSetting(db, PREFS_KEY, JSON.stringify({
      cards, level: 1, limits: ["knee"], contactsSeeMoved: false, windows: ["evening"],
    }));
    const prefs = await readPrefs(db);
    assert.equal(prefs.cards, 3, `stored cards ${JSON.stringify(cards)} falls back alone`);
    assert.equal(prefs.level, 1);
    assert.deepEqual(prefs.limits, ["knee"]);
    assert.equal(prefs.contactsSeeMoved, false);
    assert.deepEqual(prefs.windows, ["evening"]);
  }
});

test("writePrefs: windows are stored in slot order, without repeats", async () => {
  const db = await freshDb();
  const prefs = await writePrefs(db, { windows: ["evening", "morning", "morning"] });
  assert.deepEqual(prefs.windows, ["morning", "evening"]);
  assert.deepEqual((await readPrefs(db)).windows, ["morning", "evening"]);

  await writePrefs(db, { windows: [] });
  assert.deepEqual((await readPrefs(db)).windows, [], "no windows named is back to the defaults");

  await writePrefs(db, { windows: ["midday", "morning", "evening"] });
  assert.deepEqual((await readPrefs(db)).windows, ["morning", "midday", "evening"]);
});

test("writePrefs: a window name outside the slots is refused", async () => {
  const db = await freshDb();
  const before = await readSetting(db, PREFS_KEY);
  for (const windows of [["noon"], ["morning", "noon"], "morning", 3, null]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => writePrefs(db, { windows }), (err) => {
      assert.ok(err instanceof MovesPrefsError);
      assert.equal(err.message, "windows must be drawn from morning, midday, evening");
      return true;
    }, `windows ${JSON.stringify(windows)} is not a slot list`);
  }
  assert.equal(await readSetting(db, PREFS_KEY), before, "a refused patch writes nothing");
});

test("writePrefs: contactsSeeMoved is a boolean and round-trips", async () => {
  const db = await freshDb();
  const prefs = await writePrefs(db, { contactsSeeMoved: false });
  assert.equal(prefs.contactsSeeMoved, false);
  assert.equal(prefs.cards, 3, "the other fields stay put");
  assert.equal((await readPrefs(db)).contactsSeeMoved, false);

  for (const value of ["no", 0, 1, null]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => writePrefs(db, { contactsSeeMoved: value }), MovesPrefsError);
  }
  assert.equal((await readPrefs(db)).contactsSeeMoved, false, "a refused patch changes nothing");

  assert.equal((await writePrefs(db, { contactsSeeMoved: true })).contactsSeeMoved, true);
});

test("writePrefs: a field this build does not know is still refused", async () => {
  const db = await freshDb();
  await assert.rejects(() => writePrefs(db, { lvl: 1 }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { card: 2 }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { window: ["midday"] }), MovesPrefsError);
  await assert.rejects(() => writePrefs(db, { cards: 2, extra: true }), MovesPrefsError);
  assert.equal(await readSetting(db, PREFS_KEY), null, "a refused patch writes nothing");
});

/* ------------------------------------------------------------ the pick */

test("the pick is stable within the day and changes on a new day", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = [entry({ id: "a-1" }), entry({ id: "b-2" })];
  const picks = [];

  for (let i = 0; i < 14; i += 1) {
    const t = new Date(2026, 9, 5 + i, 12, 0, 0).getTime();
    // eslint-disable-next-line no-await-in-loop
    const first = await todayChallenge(db, { now: t, library: lib });
    // eslint-disable-next-line no-await-in-loop
    const again = await todayChallenge(db, { now: t + HOUR, library: lib });
    assert.ok(first && again);
    assert.equal(first.day, localDay(t));
    assert.equal(first.off, false);
    assert.equal(first.done, false);
    assert.equal(first.swap, 0);
    assert.equal(first.entry.id, again.entry.id, "the same day returns the stored card");
    assert.deepEqual(again.reasons, first.reasons);
    assert.equal(again.why, first.why);
    assert.equal(again.why, whyLine(first.reasons), "the line is built from the fact codes");
    picks.push(first.entry.id);

    // The card really is in the synced settings row, not just re-computed.
    // eslint-disable-next-line no-await-in-loop
    const stored = JSON.parse(await readSetting(db, TODAY_KEY));
    assert.equal(stored.day, localDay(t));
    assert.equal(stored.entryId, first.entry.id);
    assert.equal(stored.swap, 0);
  }

  assert.ok(new Set(picks).size > 1, "the seeded day hash must move over two weeks: " + picks.join(","));
});

test("the stored card comes back as the library's live entry object", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = [entry({ id: "only-1" })];
  const first = await todayChallenge(db, { now: T0, library: lib });
  lib[0] = { ...lib[0], title: "Updated title" };
  const again = await todayChallenge(db, { now: T0 + 1000, library: lib });
  assert.equal(again.entry.title, "Updated title", "the stored pick is re-resolved, never copied into settings");
});

test("an empty library returns null and stores nothing", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  assert.equal(await todayChallenge(db, { now: T0, library: [] }), null);
  assert.equal(await readSetting(db, TODAY_KEY), null);
});

test("a stated limit always wins — even over a card stored before the limit was set", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const KNEE = entry({ id: "knee-1", skipIf: ["knee"] });
  const SAFE = entry({ id: "safe-1" });
  const lib = [KNEE, SAFE];

  // The picker is pure (day + inputs decide the card), so find the day whose
  // seeded pick is the knee entry BEFORE touching the db — scanning days on
  // the db would let the history rollover change later picks.
  let found = null;
  for (let i = 0; i < 400 && found === null; i += 1) {
    const t = new Date(2026, 9, 5 + i, 12, 0, 0).getTime();
    const pick = pickChallenge({
      day: localDay(t), hourLocal: 12, weather: null, prefs: PREFS, history: {}, library: lib, swap: 0,
    });
    if (pick?.entryId === "knee-1") found = t;
  }
  assert.ok(found, "the fixture needs a day that picks the knee entry");

  const before = await todayChallenge(db, { now: found, library: lib });
  assert.equal(before.entry.id, "knee-1", "the card on screen is the knee entry ...");

  await writePrefs(db, { limits: ["knee"] });
  const shown = await todayChallenge(db, { now: found, library: lib });
  assert.equal(shown.entry.id, "safe-1", "the knee card must be replaced, not left on screen");
  assert.equal(JSON.parse(await readSetting(db, TODAY_KEY)).entryId, "safe-1");

  for (let s = 0; s < MAX_SWAPS; s += 1) {
    // eslint-disable-next-line no-await-in-loop
    const swapped = await swapChallenge(db, { now: found + (s + 1) * 1000, library: lib });
    assert.notEqual(swapped.entry.id, "knee-1", "swap must never re-offer a ruled-out entry");
  }
  const refused = await swapChallenge(db, { now: found + 10_000, library: lib });
  assert.equal(refused.refused, true);
  assert.notEqual(refused.entry.id, "knee-1");
  assert.equal(refused.entry.id, "safe-1", "one eligible entry: the card on screen stays");
});

/* ------------------------------------------------- picks that are not chunks */

test("a stored pick that is not a chunk is replaced by one, keeping the swap count and the seen list", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const SHORT = entry({ id: "short-1", kind: "exercise", minutes: 3 });
  const CHUNK = entry({ id: "chunk-1" });
  await writeSetting(db, TODAY_KEY, JSON.stringify({
    day: DAY0, entryId: "short-1", swap: 1, seen: ["short-1"], reasons: [], why: "",
  }));

  const shown = await todayChallenge(db, { now: T0, library: [SHORT, CHUNK] });
  assert.equal(shown.entry.id, "chunk-1", "a card shorter than a chunk is not left on screen");
  assert.equal(shown.swap, 1, "a re-pick keeps the day's swap count");
  assert.ok(shown.seen.includes("short-1"), "the replaced card stays in the day's seen list");
  assert.ok(shown.seen.includes("chunk-1"));

  const stored = JSON.parse(await readSetting(db, TODAY_KEY));
  assert.equal(stored.day, DAY0);
  assert.equal(stored.entryId, "chunk-1", "the stored row names the chunk now");
  assert.equal(stored.swap, 1);
  assert.deepEqual(stored.seen, shown.seen);
});

test("a stored routine under ten minutes, and a stored id the library no longer holds, are both re-picked", async () => {
  const SHORT_ROUTINE = entry({ id: "r-5", minutes: 5 });
  const CHUNK = entry({ id: "chunk-1" });
  for (const entryId of ["r-5", "gone-9"]) {
    const db = await freshDb();
    // eslint-disable-next-line no-await-in-loop
    await writePrefs(db, PREFS);
    // eslint-disable-next-line no-await-in-loop
    await writeSetting(db, TODAY_KEY, JSON.stringify({
      day: DAY0, entryId, swap: 2, seen: [entryId], reasons: [], why: "",
    }));

    // eslint-disable-next-line no-await-in-loop
    const shown = await todayChallenge(db, { now: T0, library: [SHORT_ROUTINE, CHUNK] });
    assert.equal(shown.entry.id, "chunk-1", "a stored " + entryId + " is not reused");
    assert.equal(shown.swap, 2);
    assert.ok(shown.seen.includes(entryId));
    // eslint-disable-next-line no-await-in-loop
    const stored = JSON.parse(await readSetting(db, TODAY_KEY));
    assert.equal(stored.entryId, "chunk-1");
    assert.equal(stored.swap, 2);
  }
});

test("a stored chunk is kept exactly, and reusing it writes nothing", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const CHUNK = entry({ id: "chunk-1" });
  await writeSetting(db, TODAY_KEY, JSON.stringify({
    day: DAY0, entryId: "chunk-1", swap: 1, seen: ["chunk-1"], reasons: [], why: "kept",
  }));
  const c = collector();

  const shown = await todayChallenge(db, { now: T0, library: [CHUNK], emit: c.emit });
  assert.equal(shown.entry, CHUNK, "the same live entry object comes back");
  assert.equal(shown.swap, 1);
  assert.deepEqual(shown.seen, ["chunk-1"]);
  assert.equal(shown.why, "kept");
  assert.deepEqual(rowsOf(c, "ramble_settings", TODAY_KEY), [], "a reuse writes no card row");
});

test("a Done day stays Done when its stored card is replaced", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const CHUNK = entry({ id: "chunk-1" });
  const SHORT = entry({ id: "short-1", kind: "exercise", minutes: 3 });
  await recordChallengeDone(db, { day: DAY0, entry: CHUNK, now: T0 });
  await writeSetting(db, TODAY_KEY, JSON.stringify({
    day: DAY0, entryId: "short-1", swap: 0, seen: ["short-1"], reasons: [], why: "",
  }));

  const shown = await todayChallenge(db, { now: T0 + 1000, library: [SHORT, CHUNK] });
  assert.equal(shown.entry.id, "chunk-1");
  assert.equal(shown.done, true, "Done is read from the day's movedone row, not from the card");
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1, "the day keeps its one Done row");
  assert.equal((await movesDay(db, { day: DAY0 })).done, true);
});

test("todayForSurface replaces a stored card that is not a chunk too", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const SHORT = entry({ id: "short-1", kind: "exercise", minutes: 3 });
  const CHUNK = entry({ id: "chunk-1" });
  await writeSetting(db, TODAY_KEY, JSON.stringify({
    day: DAY0, entryId: "short-1", swap: 3, seen: ["short-1"], reasons: [], why: "",
  }));

  const shown = await todayForSurface(db, { now: T0, library: [SHORT, CHUNK] });
  assert.equal(shown.entry.id, "chunk-1");
  assert.equal(shown.swap, 3);
  const stored = JSON.parse(await readSetting(db, TODAY_KEY));
  assert.equal(stored.entryId, "chunk-1");
  assert.equal(stored.swap, 3);
});

/* ----------------------------------------------------------------- swap */

test("swap re-rolls the stored card, counts up to 3, and the fourth refuses", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  // Four entries: a full day shows one card and at most three swaps, and no
  // swap may repeat one, so four is exactly enough for every swap to land.
  const lib = ["a-1", "b-2", "c-3", "d-4"].map((id) => entry({ id }));
  const c = collector();

  const first = await todayChallenge(db, { now: T0, library: lib, emit: c.emit });
  assert.equal(first.swap, 0);
  const shown = [first.entry.id];

  let last = first;
  for (const want of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    last = await swapChallenge(db, { now: T0 + want * 1000, library: lib, emit: c.emit });
    assert.equal(last.refused, false);
    assert.equal(last.swap, want);
    assert.equal(last.off, false);
    assert.equal(last.done, false);
    assert.equal(last.why, whyLine(last.reasons));
    assert.equal(shown.includes(last.entry.id), false, "a swap never re-lands on a shown entry");
    shown.push(last.entry.id);
    // eslint-disable-next-line no-await-in-loop
    const stored = JSON.parse(await readSetting(db, TODAY_KEY));
    assert.equal(stored.swap, want);
    assert.equal(stored.entryId, last.entry.id);
    assert.deepEqual(stored.seen, shown, "the day's shown ids travel in the same synced row");
  }

  const emitsBefore = rowsOf(c, "ramble_settings", TODAY_KEY).length;
  const refused = await swapChallenge(db, { now: T0 + 4000, library: lib, emit: c.emit });
  assert.equal(refused.refused, true, "at most 3 swaps a day");
  assert.equal(refused.swap, MAX_SWAPS);
  assert.equal(refused.entry.id, last.entry.id, "the last card stays on screen");
  assert.equal(rowsOf(c, "ramble_settings", TODAY_KEY).length, emitsBefore, "a refused swap writes nothing");
  assert.equal(JSON.parse(await readSetting(db, TODAY_KEY)).swap, MAX_SWAPS);
});

test("the swap cap cannot be reopened by a same-day re-pick", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = [
    entry({ id: "knee-a", skipIf: ["knee"] }),
    entry({ id: "knee-b", skipIf: ["knee"] }),
    entry({ id: "safe-1" }),
    entry({ id: "safe-2" }),
  ];

  // The picker is pure, so replay the day's swaps in memory with the same
  // exclude rule the module uses, and find a day whose THIRD swap lands on a
  // knee-tagged card: only then does a later knee limit really rule the stored
  // card out and force the same-day re-pick this test is about.
  const replay = (t) => {
    const day = localDay(t);
    const seen = [];
    let pick = pickChallenge({
      day, hourLocal: 12, weather: null, prefs: PREFS,
      history: { done: {}, skipped: {} }, library: lib, swap: 0,
    });
    if (pick) seen.push(pick.entryId);
    for (let s = 1; s <= MAX_SWAPS; s += 1) {
      pick = pickChallenge({
        day, hourLocal: 12, weather: null, prefs: PREFS,
        history: { done: {}, skipped: {} }, library: lib, swap: s, exclude: seen,
      });
      if (!pick) break;
      seen.push(pick.entryId);
    }
    return pick;
  };
  let found = null;
  for (let i = 0; i < 400 && found === null; i += 1) {
    const t = new Date(2026, 9, 5 + i, 12, 0, 0).getTime();
    if (replay(t)?.entryId?.startsWith("knee-")) found = t;
  }
  assert.ok(found, "the fixture needs a day whose swap-3 card is knee-tagged");

  assert.ok(await todayChallenge(db, { now: found, library: lib }));
  for (let s = 0; s < MAX_SWAPS; s += 1) {
    // eslint-disable-next-line no-await-in-loop
    const swapped = await swapChallenge(db, { now: found + (s + 1) * 1000, library: lib });
    assert.equal(swapped.refused, false);
  }
  assert.equal(JSON.parse(await readSetting(db, TODAY_KEY)).swap, MAX_SWAPS);
  const capped = await todayChallenge(db, { now: found + 5000, library: lib });
  assert.deepEqual(capped.entry.skipIf, ["knee"], "the capped card is the knee entry");

  // The new limit rules the stored card out, so today's card is re-picked.
  await writePrefs(db, { limits: ["knee"] });
  const rePicked = await todayChallenge(db, { now: found + 6000, library: lib });
  assert.deepEqual(rePicked.entry.skipIf, [], "the ruled-out card is replaced");
  assert.equal(rePicked.swap, MAX_SWAPS, "a same-day re-pick keeps the day's swap count");
  assert.equal(JSON.parse(await readSetting(db, TODAY_KEY)).swap, MAX_SWAPS);

  const refused = await swapChallenge(db, { now: found + 7000, library: lib });
  assert.equal(refused.refused, true, "a re-pick must not hand out fresh swaps");
  assert.equal(refused.swap, MAX_SWAPS);
  assert.equal(refused.entry.id, rePicked.entry.id);
});

test("a stored swap beyond the cap is clamped, never reset to 0", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = [entry({ id: "a-1" }), entry({ id: "b-2" })];
  await todayChallenge(db, { now: T0, library: lib });
  const stored = JSON.parse(await readSetting(db, TODAY_KEY));
  await writeSetting(db, TODAY_KEY, JSON.stringify({ ...stored, swap: MAX_SWAPS + 6 }));

  const read = await todayChallenge(db, { now: T0 + 1000, library: lib });
  assert.equal(read.swap, MAX_SWAPS);
  assert.equal((await swapChallenge(db, { now: T0 + 2000, library: lib })).refused, true);
});

test("swap on a brand-new day starts the count over", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = ["a-1", "b-2", "c-3", "d-4"].map((id) => entry({ id }));
  for (let s = 0; s < MAX_SWAPS; s += 1) {
    // eslint-disable-next-line no-await-in-loop
    await swapChallenge(db, { now: T0 + s * 1000, library: lib });
  }
  assert.equal((await swapChallenge(db, { now: T0 + 4000, library: lib })).refused, true);
  const next = await swapChallenge(db, { now: T0 + 24 * HOUR, library: lib });
  assert.equal(next.refused, false);
  assert.equal(next.swap, 1);
  assert.equal(next.day, localDay(T0 + 24 * HOUR));
});

/* -------------------------------------------------------------- midnight */

test("MIDNIGHT: a card picked at 23:58 and Done at 00:02 credits the picked day, never both", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = [entry({ id: "mid-1", minutes: 10 })];

  const pickedAt = new Date(2026, 9, 5, 23, 58, 0).getTime();
  const doneAt = new Date(2026, 9, 6, 0, 2, 0).getTime();
  const picked = await todayChallenge(db, { now: pickedAt, library: lib });
  assert.equal(picked.day, localDay(pickedAt));

  // The route reads `day` off this card — that is the whole midnight rule.
  assert.notEqual(localDay(doneAt), picked.day, "the fixture really does cross local midnight");
  const done = await recordChallengeDone(db, { day: picked.day, entry: picked.entry, now: doneAt });
  assert.equal(done.day, picked.day);
  assert.equal(done.paid, 12);
  assert.equal((await movesDay(db, { day: picked.day })).done, true);

  // The same card's second tap pays nothing.
  const again = await recordChallengeDone(db, { day: picked.day, entry: picked.entry, now: doneAt + 1000 });
  assert.equal(again.already, true);
  assert.equal(again.paid, 0);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, picked.day), 1);

  // The new day is a fresh card and its own Done.
  const next = await todayChallenge(db, { now: doneAt, library: lib });
  assert.equal(next.day, localDay(doneAt));
  assert.equal(next.done, false);
  assert.equal((await movesDay(db, { day: next.day })).done, false);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, next.day), null);
});

/* --------------------------------------------------- two devices, one day */

test("TWO DEVICES: picks converge under the settings LWW, and Done pays once across the wallet merge", async () => {
  const a = await freshDb();
  const b = await freshDb();
  await writePrefs(a, PREFS);
  await writePrefs(b, PREFS);
  const lib = [entry({ id: "dev-1" }), entry({ id: "dev-2", kind: "flow", activity: "yoga" })];
  const ca = collector();
  const cb = collector();

  // Both open Ramble on a new day and each picks; one then swaps. Find a day
  // where the swap really lands on a different card.
  let at = null;
  let pickA = null;
  let pickB = null;
  for (let i = 0; i < 30 && pickB === null; i += 1) {
    const t = new Date(2026, 9, 5 + i, 12, 0, 0).getTime();
    // eslint-disable-next-line no-await-in-loop
    const outA = await todayChallenge(a, { now: t, library: lib, emit: ca.emit });
    // eslint-disable-next-line no-await-in-loop
    let outB = await todayChallenge(b, { now: t, library: lib, emit: cb.emit });
    // Day one is symmetric (both histories empty), so the seeded pick agrees.
    // Later days can legitimately differ: a swap on B folds a different entry
    // into B's history than A folds in, which is why the LWW row exists.
    if (i === 0) assert.equal(outB.entry.id, outA.entry.id, "the same seeded inputs agree on both devices");
    for (let s = 0; s < MAX_SWAPS && outB.entry.id === outA.entry.id; s += 1) {
      // eslint-disable-next-line no-await-in-loop
      outB = await swapChallenge(b, { now: t + (s + 1) * 1000, library: lib, emit: cb.emit });
    }
    if (outB.entry.id !== outA.entry.id) { at = t; pickA = outA; pickB = outB; }
  }
  assert.ok(pickB, "the fixture needs a day where a swap changes the card");

  // The local rows are stamped as if each side had emitted at its own lamport:
  // A's pick is older (1), B's swap is newer (2).
  const rowA = latestOf(ca, "ramble_settings", TODAY_KEY);
  const rowB = latestOf(cb, "ramble_settings", TODAY_KEY);
  await applyRambleSetting(a, rowA.op, rowA.row, 1);
  await applyRambleSetting(b, rowB.op, rowB.row, 2);

  // Cross-apply: B's newer card wins on A, A's older card loses on B.
  await applyRambleSetting(a, rowB.op, rowB.row, 2);
  await applyRambleSetting(b, rowA.op, rowA.row, 1);

  const settledA = await todayChallenge(a, { now: at + 60_000, library: lib });
  const settledB = await todayChallenge(b, { now: at + 60_000, library: lib });
  assert.equal(settledA.entry.id, pickB.entry.id, "the newer moves.today wins on both devices");
  assert.equal(settledB.entry.id, pickB.entry.id);
  assert.equal(settledA.swap, pickB.swap);
  assert.equal(settledB.swap, pickB.swap);

  // Each device marks the SAME card Done; the wallet merges afterwards.
  const doneA = await recordChallengeDone(a, {
    day: settledA.day, entry: settledA.entry, now: at + 120_000, emit: ca.emit,
  });
  const doneB = await recordChallengeDone(b, {
    day: settledB.day, entry: settledB.entry, now: at + 120_000, emit: cb.emit,
  });
  assert.equal(doneA.paid, 12);
  assert.equal(doneB.paid, 12);

  for (const { op, row } of rowsOf(ca, "ramble_wallet")) await applyRambleWallet(b, op, row, 1);
  for (const { op, row } of rowsOf(cb, "ramble_wallet")) await applyRambleWallet(a, op, row, 1);

  for (const db of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    const day = await movesDay(db, { day: settledA.day });
    assert.equal(day.done, true, "the day is marked done on both");
    assert.equal(day.indoorPaid, 12, "and paid once: MAX(delta) converges, it does not sum");
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await rowDelta(db, MOVE_DONE_KIND, settledA.day), 1);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, settledA.day), 12);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await todayChallenge(db, { now: at + 180_000, library: lib })).done, true);
  }
});

/* ------------------------------------------------------------- one assembly */

test("ONE ASSEMBLY: weather the user turned off never reaches the picker, on either surface", async () => {
  // An outdoor-only library: if the rainy forecast were weighed, the picker's
  // indoor-only rule would leave nothing and the card would be null.
  const OUTDOOR = entry({ id: "out-1", kind: "walk", activity: "walk", indoor: false });
  const rainy = { rain: 90, temp: 12, code: 61 };

  const onDb = await freshDb();
  await writePrefs(onDb, PREFS);
  assert.equal(
    await todayForSurface(onDb, { now: T0, weather: rainy, library: [OUTDOOR] }), null,
    "with weather on, the fixture really is rained out",
  );

  const offDb = await freshDb();
  await writePrefs(offDb, { ...PREFS, weather: false });
  const shown = await todayForSurface(offDb, { now: T0, weather: rainy, library: [OUTDOOR] });
  assert.ok(shown, "with weather off the picker is never told it rains");
  assert.equal(shown.entry.id, "out-1");
  assert.equal(shown.reasons.includes("rain_later"), false);
  assert.equal(shown.reasons.includes("cold"), false);
});

test("ONE ASSEMBLY: the panel's helper and For You's module pick the same entry for one day", async () => {
  const panelDb = await freshDb();
  const forYouDb = await freshDb();
  await writePrefs(panelDb, PREFS);
  await writePrefs(forYouDb, PREFS);
  const lib = [entry({ id: "a-1" }), entry({ id: "b-2", kind: "flow", activity: "yoga" })];

  const panel = await todayForSurface(panelDb, { now: T0, weather: { rain: 80 }, library: lib });
  const forYou = await forYouMoves(forYouDb, { now: T0, weather: { rain: 80 }, library: lib });
  assert.ok(panel && forYou.challenge);
  assert.equal(forYou.challenge.entryId, panel.entry.id, "one assembly, one pick");
  assert.equal(forYou.challenge.why, panel.why);

  // The language rides through the same function, so For You is not stuck in English.
  const esDb = await freshDb();
  await writePrefs(esDb, PREFS);
  const es = await todayForSurface(esDb, { now: T0, weather: null, lang: "es", library: lib });
  assert.equal(es.why, whyLine(es.reasons, "es"));
  assert.notEqual(es.why, whyLine(es.reasons, "en"));
});

/* ------------------------------------------------------------------ off */

test("challenges off: todayChallenge returns an off card and writes the pause fact once", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const lib = [entry({ id: "a-1" })];
  assert.ok(await todayChallenge(db, { now: T0, library: lib }));

  await writePrefs(db, { on: false });
  const c = collector();
  const off = await todayChallenge(db, { now: T0, library: lib, emit: c.emit });
  assert.equal(off.off, true);
  assert.equal(off.entry, null);
  assert.equal(off.done, false);
  assert.equal(off.why, "");
  assert.equal(await rowDelta(db, MOVE_OFF_KIND, DAY0), 1, "the pause is a wallet fact for the local day");

  const noon = await todayChallenge(db, { now: T0 + HOUR, library: lib, emit: c.emit });
  assert.equal(noon.off, true);
  assert.equal(rowsOf(c, "ramble_wallet", DAY0).length, 1, "a second read the same day writes nothing more");

  const swapped = await swapChallenge(db, { now: T0 + 2 * HOUR, library: lib, emit: c.emit });
  assert.equal(swapped.off, true);
  assert.equal(swapped.entry, null);

  // Back on: today gets a card again.
  await writePrefs(db, { on: true });
  const on = await todayChallenge(db, { now: T0 + 3 * HOUR, library: lib });
  assert.equal(on.off, false);
  assert.equal(on.entry.id, "a-1");
});

test("the pause fact is keyed by the local day, so a new day pauses again", async () => {
  const db = await freshDb();
  await writePrefs(db, { on: false });
  const lib = [entry({ id: "a-1" })];
  await todayChallenge(db, { now: T0, library: lib });
  await todayChallenge(db, { now: T0 + 24 * HOUR, library: lib });
  assert.equal(await rowDelta(db, MOVE_OFF_KIND, DAY0), 1);
  assert.equal(await rowDelta(db, MOVE_OFF_KIND, localDay(T0 + 24 * HOUR)), 1);
});

/* ---------------------------------------------------------------- whyLine */

test("whyLine: template sentences from the fact codes, en and es, first two only", () => {
  assert.equal(whyLine(["slot:early"], "en"), "A good way to start the morning.");
  assert.equal(whyLine(["slot:early"], "es"), "Una buena forma de empezar la mañana.");
  assert.equal(whyLine(["slot:day"]), "A good way to break up the day.");
  assert.equal(whyLine(["slot:evening"], "es"), "Una buena forma de cerrar el día.");
  assert.equal(whyLine(["rain_later"], "en"), "Rain is likely later.");
  assert.equal(whyLine(["rain_later"], "es"), "Es probable que llueva más tarde.");
  assert.equal(whyLine(["cold"]), "It's cold out.");
  assert.equal(whyLine(["hot"], "es"), "Hace calor afuera.");
  assert.equal(whyLine(["liked:yoga"]), "You like this kind.");
  assert.equal(whyLine(["liked:band"], "es"), "Te gusta este tipo.");
  assert.equal(whyLine(["learning_flow"]), "A flow you're learning.");
  assert.equal(whyLine(["easy_day"], "es"), "Uno fácil hoy.");

  assert.equal(
    whyLine(["slot:early", "rain_later", "cold"]),
    "A good way to start the morning. Rain is likely later.",
    "only the first two that apply",
  );
  assert.equal(whyLine(["nonsense", "learning_flow"]), "A flow you're learning.", "unknown codes are ignored");
  assert.equal(whyLine([], "en"), "");
  assert.equal(whyLine(null), "");
  assert.equal(whyLine(["easy_day"], "fr"), "An easy one today.", "an unknown language falls back to en");
});