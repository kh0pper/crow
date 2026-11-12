/**
 * Ramble moves — the picker offers only chunks (moves design Task 5.2; private
 * engineering notes).
 *
 * The library still holds the single poses and the short exercises, because
 * Learn browses them; a CARD is a different thing. `pickChallenge` filters on
 * library.js's `isChunk`, so whatever the day, the hour, the weather, the
 * equipment or the limit set, today's challenge is a flow, routine, landmark
 * or walk of at least CHUNK_MIN_MINUTES — or null.
 *
 * What is pinned here:
 *   - the property, over every equipment subset (32), every single limit tag
 *     and no limit, levels 1-3, clear and rainy weather, and 30 consecutive
 *     days: a pick is null or a chunk of 10 minutes or more that really is in
 *     the library,
 *   - a library of nothing but a pose and a 5-minute exercise picks nothing,
 *     and adding one 10-minute flow makes that flow the card,
 *   - a stored prefs row saying ["none"] keeps it (a stored row is never
 *     rewritten by a default), while a fresh db starts at ["none", "wall"].
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  EQUIPMENT, LIMIT_TAGS, isChunk, servedLibrary,
} from "../bundles/ramble/server/moves/library.js";
import { pickChallenge } from "../bundles/ramble/server/moves/picker.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { DEFAULT_PREFS, PREFS_KEY, readPrefs } from "../bundles/ramble/server/moves/today.js";

const LIB_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), "..", "bundles", "ramble", "server", "moves", "library",
);

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A picker-shaped entry; each test overrides exactly what it is about. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "flow",
    title: "Test entry",
    minutes: 10,
    level: 1,
    indoor: true,
    activity: "yoga",
    equipment: ["none"],
    tags: [],
    areas: ["mobility"],
    steps: ["do the thing"],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [],
    reviewed: true,
    ...over,
  };
}

const PREFS = {
  on: true,
  kinds: [],
  equipment: ["none", "wall"],
  limits: [],
  level: 3,
  weather: true,
};

test("every pick is a chunk of 10 minutes or more, over equipment, limits, levels, weather and 30 days", () => {
  const library = servedLibrary(LIB_DIR);
  assert.ok(library.length > 0, "the shipped library has entries");
  // The filter has something to exclude: the poses and short exercises Learn
  // still browses are served, and they are not cards.
  assert.ok(library.some((e) => !isChunk(e)), "the library still holds entries that are not chunks");
  const byId = new Map(library.map((e) => [e.id, e]));

  const dayKeys = [];
  for (let i = 0; i < 30; i += 1) dayKeys.push("2026-10-" + String(i + 1).padStart(2, "0"));
  const hours = [8, 12, 18];
  const weathers = [null, { rain: 90, temp: 10, code: 0 }];
  const limitSets = [null];
  for (const tag of LIMIT_TAGS) limitSets.push([tag]);
  const history = { done: {}, skipped: {}, learning: [] };

  let picks = 0;
  for (let mask = 0; mask < 32; mask += 1) {
    const equipment = EQUIPMENT.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const limits of limitSets) {
      for (const level of [1, 2, 3]) {
        // One prefs object per combination, reused: the picker never mutates it.
        const prefs = {
          on: true, kinds: [], equipment, limits: limits ?? [], level, weather: true,
        };
        for (const weather of weathers) {
          for (let d = 0; d < dayKeys.length; d += 1) {
            const picked = pickChallenge({
              day: dayKeys[d],
              hourLocal: hours[d % hours.length],
              weather,
              prefs,
              history,
              library,
              swap: 0,
            });
            if (picked === null) continue;
            picks += 1;
            const chosen = byId.get(picked.entryId);
            assert.ok(chosen, "the pick is in the library: " + picked.entryId);
            assert.equal(isChunk(chosen), true,
              "a card is never a " + chosen.kind + ": " + chosen.id);
            assert.ok(chosen.minutes >= 10, "a card lasts at least 10 minutes: " + chosen.id);
          }
        }
      }
    }
  }
  assert.ok(picks > 0, "some combination really does offer a card");
});

test("poses and short exercises are never cards; one 10-minute flow is the card", () => {
  const pose = entry({
    id: "pose-1", kind: "pose", title: "A pose", minutes: 1, activity: "yoga", areas: ["mobility"],
  });
  const shortExercise = entry({
    id: "short-1", kind: "exercise", title: "A short exercise", minutes: 5,
    activity: "bodyweight", areas: ["upper"],
  });
  const flow = entry({
    id: "flow-1", kind: "flow", title: "A mobility flow", minutes: 10, areas: ["mobility"],
  });

  for (let i = 0; i < 30; i += 1) {
    const day = "2026-10-" + String(i + 1).padStart(2, "0");
    assert.equal(
      pickChallenge({ day, hourLocal: 12, weather: null, prefs: PREFS, history: {}, library: [pose, shortExercise], swap: 0 }),
      null,
      "nothing short of a chunk is ever the day's card",
    );
    const picked = pickChallenge({
      day, hourLocal: 12, weather: null, prefs: PREFS, history: {},
      library: [pose, shortExercise, flow], swap: 0,
    });
    assert.ok(picked, "the flow is pickable");
    assert.equal(picked.entryId, "flow-1", "and it is the only card there is");
  }
});

test("a stored prefs row saying no equipment is kept; a fresh db starts with none and wall", async () => {
  const stored = await freshDb();
  await stored.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [PREFS_KEY, JSON.stringify({ equipment: ["none"] })],
  });
  assert.deepEqual((await readPrefs(stored)).equipment, ["none"],
    "a user who stored no equipment keeps it: a default never overwrites a row");

  const fresh = await freshDb();
  assert.deepEqual((await readPrefs(fresh)).equipment, ["none", "wall"]);
  assert.deepEqual(await readPrefs(fresh), DEFAULT_PREFS);
});