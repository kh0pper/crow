/**
 * Ramble moves — the two leftover rules from the moves design review (private
 * engineering notes): Task 5 minor 4 (a swap could re-land on the card it
 * replaced) and Task 7 minor 3 (the prefs body accepted anything).
 *
 * What is pinned here:
 *   - the picker's `exclude` input is part of the deterministic input, and an
 *     exclude that takes the last candidate away answers null (never an
 *     excluded entry),
 *   - a swap never re-lands on an entry already shown today, and the day's
 *     `seen` list rides in the same synced `moves.today` row,
 *   - a day with one eligible entry refuses exactly the way the day's last
 *     swap refuses: same card, same shape, nothing written,
 *   - a `moves.today` row written before `seen` existed still reads and swaps
 *     correctly,
 *   - the prefs body is strict: an unknown key, a wrong type or a non-object
 *     body is a 400 naming the field (through movesInput / bad), a partial
 *     patch still merges, and both body shapes (bare fields, `patch` wrapper)
 *     work.
 *
 * The prefs half mounts the real router on a scratch db, like
 * tests/ramble-moves-routes.test.js; the swap half uses in-memory ramble dbs
 * with an injected library, like tests/ramble-moves-today.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { pickChallenge } from "../bundles/ramble/server/moves/picker.js";
import {
  DEFAULT_PREFS, MAX_SWAPS, PREFS_KEY, TODAY_KEY,
  readPrefs, writePrefs, todayChallenge, swapChallenge, whyLine,
} from "../bundles/ramble/server/moves/today.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A picker-shaped entry; each test overrides only what it is about. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "exercise",
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

/**
 * Five interchangeable entries: at noon none is slot-preferred, so every card
 * is equally likely and only the seed (day + swap) decides.
 */
const LIB = ["a-1", "b-2", "c-3", "d-4", "e-5"].map((id) => entry({ id }));

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

/* ------------------------------------------------------- the picker's exclude */

test("pickChallenge: exclude is a deterministic input, and null when it empties the field", () => {
  const base = {
    day: "2026-09-14", hourLocal: 12, weather: null, prefs: PREFS, history: {}, library: LIB, swap: 1,
  };
  const pick = pickChallenge(base);
  assert.ok(pick);

  // Ids that are not candidates change nothing.
  assert.deepEqual(pickChallenge({ ...base, exclude: ["not-in-this-library"] }), pick);
  // Junk in the list is dropped, not treated as "exclude everything".
  assert.deepEqual(pickChallenge({ ...base, exclude: [null, "", 7, {}] }), pick);

  // Same inputs plus the same exclude, same pick — the determinism survives.
  const excluded = pickChallenge({ ...base, exclude: [pick.entryId] });
  assert.deepEqual(pickChallenge({ ...base, exclude: [pick.entryId] }), excluded);
  assert.notEqual(excluded.entryId, pick.entryId, "an excluded id is never picked");

  // Every candidate excluded: null, never an excluded entry handed back.
  assert.equal(pickChallenge({ ...base, exclude: LIB.map((e) => e.id) }), null);
  assert.equal(pickChallenge({ ...base, library: [LIB[0]], exclude: ["a-1"] }), null);
});

/* ------------------------------------------------------ swap never repeats */

test("a swap never re-lands on an entry shown today, across many days", async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const db = await freshDb();
    // eslint-disable-next-line no-await-in-loop
    await writePrefs(db, PREFS);
    const t = new Date(2026, 9, 5 + i, 12, 0, 0).getTime();

    // eslint-disable-next-line no-await-in-loop
    const today = await todayChallenge(db, { now: t, library: LIB });
    assert.ok(today);
    const shown = [today.entry.id];
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(JSON.parse(await readSetting(db, TODAY_KEY)).seen, shown, "the first pick starts `seen`");

    for (let s = 0; s < MAX_SWAPS; s += 1) {
      // eslint-disable-next-line no-await-in-loop
      const swapped = await swapChallenge(db, { now: t + (s + 1) * 1000, library: LIB });
      assert.equal(swapped.refused, false, "the library has enough entries for every swap");
      assert.equal(shown.includes(swapped.entry.id), false,
        "swap " + (s + 1) + " re-landed on " + swapped.entry.id + " (shown: " + shown.join(",") + ")");
      shown.push(swapped.entry.id);
      // eslint-disable-next-line no-await-in-loop
      const stored = JSON.parse(await readSetting(db, TODAY_KEY));
      assert.equal(stored.entryId, swapped.entry.id);
      assert.deepEqual(stored.seen, shown, "the day's shown ids travel in the same synced row");
      assert.ok(stored.seen.length <= MAX_SWAPS + 1, "one id per card a day can show");
    }
    db.close();
  }
});

test("swap 1 gives B after A, later swaps give neither, and a one-entry day refuses", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);

  const a = await todayChallenge(db, { now: T0, library: LIB });
  const b = await swapChallenge(db, { now: T0 + 1000, library: LIB });
  assert.notEqual(b.entry.id, a.entry.id, "swap 1 is a different card than A");
  const c = await swapChallenge(db, { now: T0 + 2000, library: LIB });
  assert.equal([a.entry.id, b.entry.id].includes(c.entry.id), false, "swap 2 is neither A nor B");
  const d = await swapChallenge(db, { now: T0 + 3000, library: LIB });
  assert.equal([a.entry.id, b.entry.id, c.entry.id].includes(d.entry.id), false, "swap 3 is new too");

  // Nothing else eligible: a one-entry library leaves only today's card, so the
  // swap keeps it and answers the refused shape.
  const soloLib = [entry({ id: "only-1" })];
  const soloDb = await freshDb();
  await writePrefs(soloDb, PREFS);
  const solo = await todayChallenge(soloDb, { now: T0, library: soloLib });
  const rowBefore = await readSetting(soloDb, TODAY_KEY);
  const refused = await swapChallenge(soloDb, { now: T0 + 1000, library: soloLib });
  assert.equal(refused.refused, true);
  assert.equal(refused.entry.id, solo.entry.id, "today's entry stays on screen");
  assert.equal(refused.swap, solo.swap, "a refused swap costs no swap");
  assert.equal(refused.off, false);
  assert.equal(await readSetting(soloDb, TODAY_KEY), rowBefore, "a refused swap writes nothing");

  // The same answer shape the day's last swap gives: same keys, same card.
  const capRefused = await swapChallenge(db, { now: T0 + 4000, library: LIB });
  assert.equal(capRefused.refused, true, "the fourth swap of the day still refuses");
  assert.equal(capRefused.entry.id, d.entry.id, "and it keeps the card on screen");
  assert.deepEqual(Object.keys(refused).sort(), Object.keys(capRefused).sort(),
    "a swap with nothing else eligible answers exactly like the cap refusal");
});

/* ------------------------------------------------------------- back-compat */

test("a stored moves.today from before `seen` still reads and swaps correctly", async () => {
  const db = await freshDb();
  await writePrefs(db, PREFS);
  const day = localDay(T0);

  // The row an older build wrote: no `seen` at all.
  await writeSetting(db, TODAY_KEY, JSON.stringify({
    day, entryId: "a-1", swap: 0, reasons: ["slot:day"], why: whyLine(["slot:day"]),
  }));

  const today = await todayChallenge(db, { now: T0, library: LIB });
  assert.equal(today.entry.id, "a-1", "the old row still reads as today's card");
  assert.deepEqual(today.seen, ["a-1"], "no seen list reads as the card on screen");

  const swapped = await swapChallenge(db, { now: T0 + 1000, library: LIB });
  assert.equal(swapped.refused, false);
  assert.notEqual(swapped.entry.id, "a-1", "and the swap still refuses to repeat it");
  const stored = JSON.parse(await readSetting(db, TODAY_KEY));
  assert.equal(stored.swap, 1);
  assert.deepEqual(stored.seen, ["a-1", swapped.entry.id], "the new row carries the list from now on");

  // Junk in the field reads the same as absent.
  await writeSetting(db, TODAY_KEY, JSON.stringify({
    day, entryId: "a-1", swap: 0, seen: "a-1,b-2",
  }));
  const junk = await todayChallenge(db, { now: T0 + 2000, library: LIB });
  assert.equal(junk.entry.id, "a-1");
  assert.deepEqual(junk.seen, ["a-1"]);
});

/* ------------------------------------------------ the prefs body is strict */

let SCRATCH;
let server;
let base;
let saved;

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-moves-leftovers-"));
  saved = {
    CROW_APP_ROOT: process.env.CROW_APP_ROOT,
    CROW_DATA_DIR: process.env.CROW_DATA_DIR,
    CROW_DB_PATH: process.env.CROW_DB_PATH,
  };
  process.env.CROW_APP_ROOT = REPO_ROOT;
  process.env.CROW_DATA_DIR = SCRATCH;
  delete process.env.CROW_DB_PATH;
  const { default: rambleRouter } = await import(`../bundles/ramble/panel/routes.js?t=${Date.now()}`);
  const app = express();
  app.use(rambleRouter((req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()), {
    emit: async () => {},
  }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

const H = { "x-test-auth": "1", "content-type": "application/json" };

async function getPrefs() {
  return (await (await fetch(base + "/api/ramble/moves/prefs", { headers: H })).json()).prefs;
}

function postPrefs(body) {
  return fetch(base + "/api/ramble/moves/prefs", { method: "POST", headers: H, body: JSON.stringify(body) });
}

test("prefs: an unknown key is a 400 that names it, and nothing is written", async () => {
  const before = await getPrefs();
  const cases = [
    [{ lvl: 2 }, "lvl"],
    [{ level: 1, kind: "yoga" }, "kind"],
    [{ patch: { nope: true } }, "nope"],
    [{ moving: true }, "moving"],
  ];
  for (const [body, field] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await postPrefs(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    // eslint-disable-next-line no-await-in-loop
    const { error } = await r.json();
    assert.match(String(error), new RegExp(field), "the 400 names the field: " + JSON.stringify(body));
  }
  assert.deepEqual(await getPrefs(), before, "a rejected patch writes nothing");
});

test("prefs: a wrong type is a 400 naming the field", async () => {
  for (const [body, field] of [
    [{ on: "yes" }, "on"],
    [{ weather: "off" }, "weather"],
    [{ level: "2" }, "level"],
    [{ level: 4 }, "level"],
    [{ kinds: "yoga" }, "kinds"],
    [{ kinds: ["flying"] }, "kinds"],
    [{ equipment: "mat" }, "equipment"],
    [{ limits: null }, "limits"],
    [{ limits: ["elbow"] }, "limits"],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await postPrefs(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    // eslint-disable-next-line no-await-in-loop
    const { error } = await r.json();
    assert.match(String(error), new RegExp(field), "the 400 names the field: " + JSON.stringify(body));
  }
});

test("prefs: an array or a string body is a 400, not a silent no-op", async () => {
  for (const body of [[], ["level", 1], [{ level: 1 }], "level", 2, true, { patch: [] }, { patch: "level" }]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await postPrefs(body)).status, 400, JSON.stringify(body));
  }
});

test("prefs: a bare partial patch merges, the patch wrapper works, and the rest is untouched", async () => {
  const start = await getPrefs();
  assert.deepEqual(start, DEFAULT_PREFS);

  const bare = await postPrefs({ level: 1, kinds: ["yoga"] });
  assert.equal(bare.status, 200);
  const merged = { ...DEFAULT_PREFS, level: 1, kinds: ["yoga"] };
  assert.deepEqual((await bare.json()).prefs, merged);
  assert.deepEqual(await getPrefs(), merged, "the other prefs are unchanged");

  const wrapped = await postPrefs({ patch: { equipment: ["none", "mat"] } });
  assert.equal(wrapped.status, 200);
  const next = { ...merged, equipment: ["none", "mat"] };
  assert.deepEqual((await wrapped.json()).prefs, next);
  assert.deepEqual(await getPrefs(), next, "level and kinds survive a wrapped patch");

  // An empty body is the no-op patch it always was.
  assert.equal((await postPrefs({})).status, 200);
  assert.deepEqual(await getPrefs(), next);

  // The write is strict on the way to the row too, so an MCP/in-process caller
  // cannot slip an unknown field past the route.
  const db = await freshDb();
  await assert.rejects(() => writePrefs(db, { lvl: 2 }), (err) => {
    assert.equal(err.name, "MovesPrefsError");
    assert.match(err.message, /lvl/);
    return true;
  });
  assert.deepEqual(await readPrefs(db), DEFAULT_PREFS, "a refused patch leaves the prefs row alone");
  await assert.rejects(() => writePrefs(db, []), (err) => err.name === "MovesPrefsError");
  assert.equal(await readSetting(db, PREFS_KEY), null, "nothing was ever written");
});