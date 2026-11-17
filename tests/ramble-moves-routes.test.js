/**
 * Moves design Task 7 — the panel routes and the MCP tools.
 *
 * Mounted the way the gateway mounts it (stub dashboardAuth, real loopback
 * socket), on the same scratch-db pattern as tests/ramble-steps-routes.test.js.
 * The shipped moves library is empty until its content task, so the router gets
 * a small library through the `movesLibrary` test seam — the routes themselves
 * are exercised unchanged.
 *
 * What is pinned here:
 *   - every moves route is behind the session auth, like the rest of /api/ramble,
 *   - today / done / swap / log / prefs / library / copy / flow-run round-trip,
 *   - the copy route serves the approved player table, word for word as pinned,
 *   - a parse with no local model answers `no_model` and the request's words
 *     appear in no log line and in no emitted row,
 *   - a card is paid against the entry it was started for, never another one,
 *   - a Done mark the ledger cannot file leaves the chunk pay standing,
 *   - a repeated log still leaves the area it trains marked, and a week made
 *     whole three weeks back earns its row on a plain read, once,
 *   - the MCP tool refuses an activity outside the fixed vocabulary.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createRambleServer } from "../bundles/ramble/server/server.js";
import { localDay, startOfLocalDay } from "../bundles/ramble/server/eggs.js";
import { chunkPoints, MOVE_OUTDOOR_KIND } from "../bundles/ramble/server/moves/ledger.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import { OUTDOOR_SESSION_KEY, outdoorPoints } from "../bundles/ramble/server/moves/day.js";
import { AREAS } from "../bundles/ramble/server/moves/library.js";
import { weekDays, weekIdOf } from "../bundles/ramble/server/moves/week.js";
import { earnedItemId, itemById } from "../bundles/ramble/server/wardrobe.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

const source = (title) => [{ title, url: "", license: "CC0" }];
/** A library-shaped entry: the picker reads reviewed/level/equipment/skipIf/activity. */
function entry(over = {}) {
  return {
    id: "walk-10", kind: "walk", title: "A ten minute walk", minutes: 10, level: 1,
    indoor: false, activity: "walk", equipment: ["none"], tags: [],
    steps: ["Walk at an easy pace."], works: [], stretches: [], mistakes: [], skipIf: [],
    easier: null, harder: null, sources: source("Fixture"), reviewed: true, ...over,
  };
}
/**
 * A chunk that trains exactly ONE area, five to an area. The day's slots ask the
 * week plan for mobility, heart and the day's third area, and the Now slot (and
 * any slot a swap re-rolls) needs four distinct cards of its own area: the first
 * pick plus the three swaps the day allows. One area per chunk keeps the picker's
 * balance weighting from narrowing a slot's pool to the multi-area chunks alone.
 */
function areaChunks(area) {
  return [1, 2, 3, 4, 5].map((n) => entry({
    id: `${area}-${n}`, title: `A ${area} chunk, number ${n}`, areas: [area],
  }));
}
const CHUNK_AREAS = ["mobility", "heart", "lower", "upper", "core"];
const AREA_CHUNKS = CHUNK_AREAS.flatMap(areaChunks);

const MOVES_LIBRARY = [
  entry(),
  entry({
    id: "pose-test", kind: "pose", title: "A test pose", minutes: 5, indoor: true,
    activity: "yoga", pose: { joints: { hip: 90 } },
  }),
  entry({
    id: "flow-test", kind: "flow", title: "A test flow", minutes: 10, indoor: true,
    activity: "yoga", equipment: ["none"], flow: ["pose-test", "pose-test", "pose-test", "pose-test", "pose-test"]
      .map((id) => ({ id, holdSeconds: 120 })),
  }),
  // An activity outside the ledger's vocabulary: a chunk of it can be started and
  // paid, but the Done mark cannot file it. Level 9 keeps it out of the picker, so
  // today's card is never this one.
  entry({
    id: "pose-unmarkable", kind: "pose", title: "A fixture the ledger cannot mark", minutes: 10,
    indoor: true, activity: "stretching", level: 9, pose: { joints: { knee: 45 } },
  }),
  ...AREA_CHUNKS,
];

let SCRATCH, server, base, saved, rambleRouter;
const emitted = [];
const H = { "x-test-auth": "1", "content-type": "application/json" };
const get = (p) => fetch(base + p, { headers: H });
const send = (method, p, body) => fetch(base + p, { method, headers: H, body: JSON.stringify(body ?? {}) });
const authStub = (req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end());

/**
 * A second mount with its own scratch data dir, and optionally its own moves
 * library. A day's card count, its slots and a slot's swap count are facts of
 * ONE database, so a test about them opens its own instead of inheriting the
 * day this file already drew. `dir` is that scratch dir, for a test that reads
 * the rows the routes wrote.
 */
async function freshMount(library = MOVES_LIBRARY) {
  const scratch = mkdtempSync(join(tmpdir(), "ramble-moves-day-"));
  const previous = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = scratch;
  const app = express();
  app.use(rambleRouter(authStub, {
    emit: async (table, op, row) => emitted.push({ table, op, row }),
    movesLibrary: library,
  }));
  const srv = app.listen(0);
  await once(srv, "listening");
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url,
    dir: scratch,
    async close() {
      srv.close();
      if (previous === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = previous;
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-moves-routes-"));
  saved = { CROW_APP_ROOT: process.env.CROW_APP_ROOT, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
  process.env.CROW_APP_ROOT = REPO_ROOT;
  process.env.CROW_DATA_DIR = SCRATCH;
  delete process.env.CROW_DB_PATH;
  ({ default: rambleRouter } = await import(`../bundles/ramble/panel/routes.js?t=${Date.now()}`));
  const app = express();
  app.use(rambleRouter(authStub, {
    emit: async (table, op, row) => emitted.push({ table, op, row }),
    movesLibrary: MOVES_LIBRARY,
  }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await get("/api/ramble/moves/today")).status, 200, "first request creates + inits the scratch db");
});
after(async () => {
  server?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("auth: the moves API sits behind dashboardAuth", async () => {
  for (const p of [
    "/api/ramble/moves/today", "/api/ramble/moves/prefs", "/api/ramble/moves/library",
    "/api/ramble/moves/copy", "/api/ramble/moves/voice",
    "/api/ramble/moves/day", "/api/ramble/moves/outdoor/start", "/api/ramble/moves/outdoor/done",
    "/api/ramble/moves/standin",
  ]) {
    assert.equal((await fetch(base + p)).status, 401, p);
  }
});

test("GET /moves/today: a challenge from the served library, with Health, steps and the streak", async () => {
  const r = await get("/api/ramble/moves/today");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.challenge, "the injected library has candidates");
  assert.equal(body.challenge.day, localDay(Date.now()));
  assert.ok(MOVES_LIBRARY.some((e) => e.id === body.challenge.entry.id));
  assert.equal(body.challenge.done, false);
  assert.equal(body.challenge.off, false);
  assert.equal(body.challenge.swap, 0);
  assert.equal(typeof body.challenge.why, "string");
  assert.ok(Array.isArray(body.challenge.reasons));
  assert.equal("pose" in body.challenge.entry, false, "the card carries no joint-angle data");
  assert.ok(Number.isFinite(body.health.energy));
  assert.ok(Number.isFinite(body.health.max));
  assert.equal(typeof body.health.mood, "string");
  assert.equal(body.steps.goal, 6000);
  assert.equal(body.steps.steps, 0);
  assert.equal(body.streak.days, 0);
});

test("GET /moves/library: reviewed entries only, no pose data; the detail route carries it", async () => {
  const list = await (await get("/api/ramble/moves/library")).json();
  const served = ["flow-test", "pose-test", "pose-unmarkable", "walk-10", ...AREA_CHUNKS.map((e) => e.id)];
  assert.deepEqual(list.entries.map((e) => e.id).sort(), served.sort());
  assert.equal(list.entries.some((e) => "pose" in e), false);

  const detail = await (await get("/api/ramble/moves/library/pose-test")).json();
  assert.equal(detail.entry.id, "pose-test");
  assert.deepEqual(detail.entry.pose, { joints: { hip: 90 } });

  assert.equal((await get("/api/ramble/moves/library/no-such-entry")).status, 404);
  assert.equal((await get("/api/ramble/moves/library/Bad%20Id")).status, 400);
});

test("GET /moves/anatomy: the whole anatomy vocabulary, one record per structure", async () => {
  const r = await get("/api/ramble/moves/anatomy");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(Array.isArray(body.vocab), true, "the route answers a vocab array");
  assert.equal(body.vocab.length, 64, "every structure anatomy/vocab.json names");
  assert.equal(new Set(body.vocab.map((record) => record.id)).size, 64, "no id twice");
  for (const record of body.vocab) {
    assert.equal(typeof record.id, "string", "a record carries its id");
    assert.ok(["muscle", "bone", "nerve"].includes(record.layer), record.id + " names its layer");
    assert.equal(Array.isArray(record.segments), true, record.id + " names the segments it is drawn on");
  }
});

/* ---------------------------------------- the player's words (7.6) */

const COPY_PINS = JSON.parse(readFileSync(join(__dir, "ramble-moves-player-copy.pins.json"), "utf8"));
const SHIPPED_COPY = JSON.parse(readFileSync(
  join(REPO_ROOT, "bundles", "ramble", "server", "moves", "player-copy.en.json"), "utf8",
));

test("GET /moves/copy: the approved player table, and nothing but it", async () => {
  const r = await get("/api/ramble/moves/copy");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.copy["player.pause"], "Pause");
  assert.deepEqual(Object.keys(body.copy).sort(), Object.keys(SHIPPED_COPY).sort(),
    "the route serves the shipped table key for key");
  assert.equal("start" in body.copy, false, "the page's Start label is the page's, not the table's");
});

test("every word the copy route serves hashes to its pin", async () => {
  const body = await (await get("/api/ramble/moves/copy")).json();
  const keys = Object.keys(body.copy);
  assert.ok(keys.length > 0, "the route answers a table");
  assert.deepEqual(keys.sort(), Object.keys(COPY_PINS).sort(), "the served keys are the pinned ones");
  for (const [key, value] of Object.entries(body.copy)) {
    assert.equal(typeof value, "string", key + " is a string");
    assert.equal(createHash("sha256").update(value).digest("hex"), COPY_PINS[key], key + " matches its pin");
  }
});

/* ----------------------------------------- the spoken lines (8.1) */

const VOICE_PINS = JSON.parse(readFileSync(join(__dir, "ramble-moves-voice.pins.json"), "utf8"));
const SHIPPED_VOICE = JSON.parse(readFileSync(
  join(REPO_ROOT, "bundles", "ramble", "server", "moves", "voice.en.json"), "utf8",
));

/**
 * Flatten the lines the way the pins name them: arrays as "path[index]",
 * objects as "path.key". The top-level `reviewed` flag is not a spoken line,
 * so it carries no pin.
 */
function flattenLines(value, prefix, out) {
  const flat = out || {};
  for (const [key, item] of Object.entries(value)) {
    if (!prefix && key === "reviewed") continue;
    const path = prefix ? prefix + "." + key : key;
    if (Array.isArray(item)) item.forEach((v, i) => { flat[path + "[" + i + "]"] = v; });
    else if (item && typeof item === "object") flattenLines(item, path, flat);
    else flat[path] = item;
  }
  return flat;
}

test("GET /moves/voice: the shipped spoken lines, line for line", async () => {
  const r = await get("/api/ramble/moves/voice");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.lines, SHIPPED_VOICE, "the route serves the shipped lines unchanged");
});

test("every spoken line the voice route serves hashes to its pin", async () => {
  const body = await (await get("/api/ramble/moves/voice")).json();
  const flat = flattenLines(body.lines, "", null);
  const keys = Object.keys(flat);
  assert.ok(keys.length > 0, "the route answers lines");
  assert.deepEqual(keys.sort(), Object.keys(VOICE_PINS).sort(), "the served lines are the pinned ones");
  for (const [path, value] of Object.entries(flat)) {
    assert.equal(createHash("sha256").update(String(value)).digest("hex"), VOICE_PINS[path], path + " matches its pin");
  }
});

test("POST /moves/done: pays once, shows done on the card, and replays as already", async () => {
  const r = await send("POST", "/api/ramble/moves/done", {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.done.already, false);
  assert.ok(body.done.points > 0);
  assert.ok(body.done.paid > 0);
  assert.equal(body.challenge.done, true);

  const again = await (await send("POST", "/api/ramble/moves/done", {})).json();
  assert.equal(again.done.already, true);
  assert.equal(again.done.paid, 0);

  const today = await (await get("/api/ramble/moves/today")).json();
  assert.equal(today.challenge.done, true);

  assert.equal((await send("POST", "/api/ramble/moves/done", { day: "yesterday" })).status, 400);
});

test("POST /moves/swap: re-rolls the day, keeps Done, and stops after the cap", async () => {
  const r = await send("POST", "/api/ramble/moves/swap", {});
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.refused, false);
  assert.equal(body.challenge.swap, 1);
  assert.equal(body.challenge.done, true, "a swap never takes a Done back");
  assert.ok(MOVES_LIBRARY.some((e) => e.id === body.challenge.entry.id));
});

/* ------------------------------------------------ the day's own cards (7.x) */

const dayGet = (url) => fetch(url + "/api/ramble/moves/day", { headers: H });
const dayPost = (url, path, body) => fetch(url + path, {
  method: "POST", headers: H, body: JSON.stringify(body ?? {}),
});

test("GET /moves/day: the day's card count, its Now slot and one card per slot", async () => {
  const mount = await freshMount();
  try {
    const r = await dayGet(mount.url);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.day, localDay(Date.now()));
    assert.equal(body.need, 3);
    assert.equal(body.off, false);
    assert.deepEqual(body.slots.map((s) => s.slot), ["morning", "midday", "evening"]);
    assert.ok(["morning", "midday", "evening"].includes(body.nowSlot), "the Now slot is one of the day's");
    for (const slot of body.slots) {
      assert.ok(slot.entry, "every slot has a card: " + slot.slot);
      assert.ok(MOVES_LIBRARY.some((e) => e.id === slot.entry.id), "the card is from the served library");
      assert.equal("pose" in slot.entry, false, "a card carries no joint-angle data");
      assert.equal(slot.empty, false);
      assert.equal(slot.done, false);
      assert.equal(slot.standIn, false);
      assert.equal(slot.swap, 0);
      assert.ok(Array.isArray(slot.reasons));
      assert.equal(typeof slot.why, "string");
      assert.equal(typeof slot.area, "string");
      assert.equal(typeof slot.plannedArea, "string");
      assert.equal("seen" in slot, false, "the day's seen lists stay in the database");
    }

    const again = await (await dayGet(mount.url)).json();
    assert.deepEqual(again.slots, body.slots, "a second read of the day answers the same cards");
  } finally { await mount.close(); }
});

test("GET /moves/day: a two-card day asked for on a fresh db needs two", async () => {
  const mount = await freshMount();
  try {
    const set = await dayPost(mount.url, "/api/ramble/moves/prefs", { cards: 2 });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).prefs.cards, 2);

    const body = await (await dayGet(mount.url)).json();
    assert.equal(body.need, 2);
    assert.deepEqual(body.slots.map((s) => s.slot), ["morning", "evening"]);
    for (const slot of body.slots) assert.ok(slot.entry, "both cards were drawn: " + slot.slot);
  } finally { await mount.close(); }
});

test("POST /moves/slot/swap: re-rolls one slot, bumps its own swap, and stops at the cap", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const start = day.slots.find((s) => s.slot === "morning");
    assert.ok(start?.entry);
    const otherIds = day.slots.filter((s) => s.slot !== "morning").map((s) => s.entry.id);
    let current = start;
    const shown = [start.entry.id];

    for (let i = 1; i <= 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await dayPost(mount.url, "/api/ramble/moves/slot/swap", { slot: "morning" });
      assert.equal(r.status, 200);
      // eslint-disable-next-line no-await-in-loop
      const body = await r.json();
      assert.equal(body.refused, false, "swap " + i + " had a card to re-roll to");
      const slot = body.slots.find((s) => s.slot === "morning");
      assert.notEqual(slot.entry.id, current.entry.id, "swap " + i + " changed the slot's card");
      assert.equal(shown.includes(slot.entry.id), false, "swap " + i + " never repeats a card the slot showed");
      assert.equal(otherIds.includes(slot.entry.id), false, "swap " + i + " never takes another slot's card");
      assert.equal(slot.swap, i, "the slot's own swap count moved");
      shown.push(slot.entry.id);
      current = slot;

      for (const item of body.slots) {
        if (item.slot === "morning") continue;
        assert.equal(item.entry.id, day.slots.find((s) => s.slot === item.slot).entry.id,
          "a swap is one card: " + item.slot + " stayed put");
      }
    }

    const refused = await dayPost(mount.url, "/api/ramble/moves/slot/swap", { slot: "morning" });
    assert.equal(refused.status, 200);
    const cap = await refused.json();
    assert.equal(cap.refused, true, "the fourth swap of the slot refuses");
    const slot = cap.slots.find((s) => s.slot === "morning");
    assert.equal(slot.entry.id, current.entry.id, "the card on screen stays");
    assert.equal(slot.swap, 3, "a refused swap costs no swap");
  } finally { await mount.close(); }
});

test("POST /moves/slot/swap: a junk slot name is refused, a missing one is a 400", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const junk = await dayPost(mount.url, "/api/ramble/moves/slot/swap", { slot: "nope" });
    assert.equal(junk.status, 200);
    const body = await junk.json();
    assert.equal(body.refused, true, "a slot the day does not have refuses");
    assert.deepEqual(body.slots, day.slots, "and nothing was re-rolled");

    assert.equal((await dayPost(mount.url, "/api/ramble/moves/slot/swap", {})).status, 400,
      "a missing slot is a bad request");
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/slot/swap", { slot: 7 })).status, 400,
      "a slot that is not a string is a bad request");
  } finally { await mount.close(); }
});

test("GET /moves/today: the legacy card is the day's Now slot", async () => {
  const mount = await freshMount();
  try {
    const today = await (await fetch(mount.url + "/api/ramble/moves/today", { headers: H })).json();
    const day = await (await dayGet(mount.url)).json();
    const now = day.slots.find((s) => s.slot === day.nowSlot);
    assert.ok(now?.entry, "the Now slot holds a card");
    assert.equal(today.challenge.day, day.day);
    assert.equal(today.challenge.entry.id, now.entry.id, "one card a day, and it is the Now slot's");
    assert.deepEqual(today.challenge.reasons, now.reasons);
    assert.equal(today.challenge.why, now.why);
    assert.equal("pose" in today.challenge.entry, false);
  } finally { await mount.close(); }
});

test("GET /moves/today: a paused day emits its moveoff wallet row", async () => {
  const mount = await freshMount();
  try {
    const paused = await dayPost(mount.url, "/api/ramble/moves/prefs", { on: false });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).prefs.on, false);

    const before = emitted.length;
    const today = await (await fetch(mount.url + "/api/ramble/moves/today", { headers: H })).json();
    assert.equal(today.challenge.off, true, "the day is paused");
    assert.equal(today.challenge.entry, null, "a paused day has no card");

    const day = localDay(Date.now());
    const rows = emitted.slice(before);
    assert.ok(rows.some((e) => e.table === "ramble_wallet" && e.op === "update"
      && e.row.kind === "moveoff" && e.row.key === day),
    "the paused day's fact reaches the sync hook");
  } finally { await mount.close(); }
});

test("POST /moves/swap: re-rolls the Now card and stops at the cap", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const nowSlot = day.slots.find((s) => s.slot === day.nowSlot);
    assert.ok(nowSlot?.entry, "the day's Now slot holds a card");
    let current = nowSlot.entry.id;

    for (let i = 1; i <= 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await dayPost(mount.url, "/api/ramble/moves/swap", {});
      assert.equal(r.status, 200);
      // eslint-disable-next-line no-await-in-loop
      const body = await r.json();
      assert.equal(body.refused, false, "swap " + i + " had a card to re-roll to");
      assert.notEqual(body.challenge.entry.id, current, "swap " + i + " changed the Now card");
      assert.equal(body.challenge.swap, i, "the day's swap count moved");
      current = body.challenge.entry.id;
    }

    const cap = await (await dayPost(mount.url, "/api/ramble/moves/swap", {})).json();
    assert.equal(cap.refused, true, "the fourth swap of the day refuses");
    assert.equal(cap.challenge.entry.id, current, "and the card on screen stays");
    assert.equal(cap.challenge.swap, 3, "a refused swap costs no swap");

    const after = await (await dayGet(mount.url)).json();
    const slot = after.slots.find((s) => s.slot === after.nowSlot);
    assert.equal(slot.entry.id, current, "the slot behind the Now card holds the same card");
    assert.equal(slot.swap, 3);
  } finally { await mount.close(); }
});

test("POST /moves/log: the fixed vocabulary pays Health and lands in the day's ledger", async () => {
  const r = await send("POST", "/api/ramble/moves/log", { activity: "cycle", minutes: 40, effort: "hard" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.log.points, 20, "40 min hard is worth the single-entry max");
  assert.ok(body.log.paid > 0, "the day's outdoor budget has room");
  assert.ok(body.log.paid <= 20);
  assert.equal(body.log.already, false);
  assert.ok(body.moves.logs.some((l) => l.activity === "cycle" && l.minutes === 40 && l.effort === "hard"));
  assert.ok(body.moves.outdoorPaid >= body.log.paid);

  for (const bad of [
    { activity: "skiing", minutes: 10, effort: "easy" },
    { activity: "walk", minutes: 0, effort: "easy" },
    { activity: "walk", minutes: 10, effort: "brutal" },
    { minutes: 10, effort: "easy" },
  ]) {
    assert.equal((await send("POST", "/api/ramble/moves/log", bad)).status, 400, JSON.stringify(bad));
  }
});

test("GET/POST /moves/prefs: round-trips a patch, emits the settings row, refuses junk", async () => {
  const read = await (await get("/api/ramble/moves/prefs")).json();
  assert.equal(read.prefs.level, 2);
  assert.equal(read.prefs.on, true);

  const r = await send("POST", "/api/ramble/moves/prefs", { level: 3, kinds: ["walk"], equipment: ["none", "mat"] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.prefs.level, 3);
  assert.deepEqual(body.prefs.kinds, ["walk"]);
  assert.deepEqual(body.prefs.equipment, ["none", "mat"]);
  assert.ok(emitted.some((e) => e.table === "ramble_settings" && e.row.key === "moves.prefs"));

  assert.equal((await (await get("/api/ramble/moves/prefs")).json()).prefs.level, 3);
  for (const bad of [{ level: 9 }, { kinds: ["skiing"] }, { equipment: ["trampoline"] }, { limits: ["elbow"] }, { on: "yes" }]) {
    assert.equal((await send("POST", "/api/ramble/moves/prefs", bad)).status, 400, JSON.stringify(bad));
  }
});

test("POST /moves/flow-run: the server decides the level; a client cannot jump to memory", async () => {
  const run = (extra = {}) => send("POST", "/api/ramble/moves/flow-run", { flowId: "flow-test", outcome: "smooth", ...extra });
  let r = await run({ level: "first", fromMemory: true });   // a lying client on a brand-new flow
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.memory, false, "a claimed level is ignored");
  assert.equal(body.level, "full", "it counted at the server's level");
  for (let i = 0; i < 2; i += 1) await run();                 // 3 smooth at full
  for (let i = 0; i < 3; i += 1) await run();                 // 3 smooth at names
  body = await (await run({ fromMemory: true })).json();      // now really at "first"
  assert.equal(body.memory, true);
  assert.equal(body.level, "memory");
  body = await (await run({ fromMemory: true })).json();
  assert.equal(body.counted, false, "a mastered flow has nothing left to count");

  assert.equal((await send("POST", "/api/ramble/moves/flow-run", { flowId: "walk-10", level: "full", outcome: "smooth" })).status, 400);
  assert.equal((await send("POST", "/api/ramble/moves/flow-run", { flowId: "nope", level: "full", outcome: "smooth" })).status, 400);
  assert.equal((await send("POST", "/api/ramble/moves/flow-run", { flowId: "flow-test", outcome: "sideways" })).status, 400);
});

test("POST /moves/parse: with no model it falls back, and the request's words are never logged", async () => {
  const words = "Bike ride, about 40 minutes, pretty hilly";
  const seen = [];
  const capture = (level) => {
    const original = console[level];
    console[level] = (...args) => { seen.push(args.map(String).join(" ")); };
    return () => { console[level] = original; };
  };
  const restore = ["log", "warn", "error", "info", "debug"].map(capture);
  let r;
  try {
    r = await send("POST", "/api/ramble/moves/parse", { text: words });
  } finally {
    for (const undo of restore) undo();
  }
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: false, reason: "no_model" }, "no providers/roles in a scratch db");
  const logged = seen.join("\n");
  for (const fragment of ["Bike", "hilly", "40 minutes"]) {
    assert.equal(logged.includes(fragment), false, `console output must not quote the request: ${fragment}`);
  }
  assert.equal(JSON.stringify(emitted).includes("hilly"), false, "no emitted row carries the text");

  assert.equal((await send("POST", "/api/ramble/moves/parse", {})).status, 400);
  assert.equal((await send("POST", "/api/ramble/moves/parse", { text: "   " })).status, 400);
});

/* ------------------------------------------------- chunk progress (4.1) */

/**
 * The scratch db the router itself is using, opened with the same (core) client
 * factory the router opened, so these assertions read the rows the routes wrote.
 */
async function scratchDb() {
  const { createDbClient } = await import("../bundles/ramble/server/db.js");
  return createDbClient(join(SCRATCH, "crow.db"));
}

async function walletTotal(db, day) {
  const { rows } = await db.execute({
    sql: `SELECT COALESCE(SUM(delta), 0) AS n FROM ramble_wallet
          WHERE kind IN ('moveindoor', 'moveoutdoor') AND key = ?`,
    args: [day],
  });
  return Number(rows[0]?.n) || 0;
}

async function doneCount(db, day) {
  const { rows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'movedone' AND key = ?",
    args: [day],
  });
  return Number(rows[0]?.n) || 0;
}

/** Age the start record the route just wrote: the route has no clock seam. */
async function ageStartRecord(db, cardKey, ms) {
  const key = "local.moves.started." + cardKey;
  const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
  assert.ok(rows[0], "the start route wrote a record for this card");
  const record = JSON.parse(String(rows[0].value));
  await db.execute({
    sql: "UPDATE ramble_settings SET value = ? WHERE key = ?",
    args: [JSON.stringify({ ...record, startedAt: Date.now() - ms }), key],
  });
}

test("POST /moves/start then /moves/progress: a ten-minute chunk leaves the day exactly one chunk better off", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;
  assert.ok(card, "there is a card to play");
  // The day's budgets are not what this test is about; the earlier tests in this
  // file have already spent part of them, so give the chunk room to pay in full.
  await clearBudgets(db, card.day);

  const started = await send("POST", "/api/ramble/moves/start", { cardKey: "day", entryId: card.entry.id });
  assert.equal(started.status, 200);
  const start = await started.json();
  assert.equal(start.cardKey, card.day + ":day", "the server builds the wallet key from its own day");
  assert.ok(Number.isFinite(start.startedAt));

  await ageStartRecord(db, start.cardKey, 11 * 60000);
  const before = await walletTotal(db, card.day);

  const posted = await send("POST", "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: card.entry.id, activeSeconds: 600,
  });
  assert.equal(posted.status, 200);
  const body = await posted.json();
  assert.equal(body.progress.done, true, "ten minutes of a ten-minute card is done");
  assert.equal(body.progress.accepted, 600);

  // The chunk pay and the Done mark are two different writes: the mark pays
  // nothing, so the day moves by exactly one chunk.
  const gain = (await walletTotal(db, card.day)) - before;
  assert.equal(gain, chunkPoints(10), "the wallet is exactly chunkPoints(10) higher");
  assert.equal(body.progress.paid, gain, "and that is what the post says it paid");
  assert.equal(await doneCount(db, card.day), 1, "exactly one movedone row for the day");
  assert.equal(body.challenge.done, true);
  db.close?.();
});

test("POST /moves/start and /moves/progress refuse junk: slots, key shape, and an unstarted card", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;

  assert.equal((await send("POST", "/api/ramble/moves/start", { cardKey: "bonus", entryId: card.entry.id })).status, 400,
    "a slot other than early/day/evening/extra is refused for now");
  assert.equal((await send("POST", "/api/ramble/moves/start", { cardKey: "day" })).status, 400,
    "entryId is required");
  assert.equal((await send("POST", "/api/ramble/moves/start", { cardKey: "day", entryId: "no-such-entry" })).status, 404,
    "an entry the served library does not have is a 404, like the detail route");

  for (const cardKey of ["day", card.day, card.day + ":bonus", card.day + ":x1"]) {
    const r = await send("POST", "/api/ramble/moves/progress", {
      cardKey, chunkIndex: 0, entryId: card.entry.id, activeSeconds: 60,
    });
    assert.equal(r.status, 400, `a card key that is not <day>:<slot> is refused: ${cardKey}`);
  }
  assert.equal((await send("POST", "/api/ramble/moves/progress", {
    cardKey: card.day + ":early", chunkIndex: -1, entryId: card.entry.id, activeSeconds: 60,
  })).status, 400, "chunkIndex must be a non-negative whole number");
  assert.equal((await send("POST", "/api/ramble/moves/progress", {
    cardKey: card.day + ":early", chunkIndex: 0, entryId: card.entry.id, activeSeconds: 21601,
  })).status, 400, "activeSeconds is bounded");
  assert.equal((await send("POST", "/api/ramble/moves/progress", {
    cardKey: card.day + ":early", chunkIndex: 0, entryId: "no-such-entry", activeSeconds: 60,
  })).status, 404, "an entry the served library does not have is a 404");

  const before = await walletTotal(db, card.day);
  assert.equal((await send("POST", "/api/ramble/moves/progress", {
    cardKey: card.day + ":early", chunkIndex: 0, entryId: card.entry.id, activeSeconds: 600,
  })).status, 400, "a card that was never started cannot be paid");
  assert.equal(await walletTotal(db, card.day), before, "and the refused post wrote nothing");
  db.close?.();
});

/* ------------------------------------- retries, order, cheating (4.2) */

/** The day's whole budget in both kinds: a chunk that must pay in full gets room. */
async function clearBudgets(db, day) {
  await db.execute({
    sql: "DELETE FROM ramble_wallet WHERE kind IN ('moveindoor', 'moveoutdoor') AND key = ?",
    args: [day],
  });
}

test("POST /moves/start cardKey extra: any served entry, and its key pays through once", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;
  const other = MOVES_LIBRARY.find((e) => e.id !== card.entry.id);
  assert.ok(other, "the fixture library has an entry that is not today's card");
  // Same as above: the day's budgets, not the key's pay-through, are under test.
  await clearBudgets(db, card.day);

  const started = await send("POST", "/api/ramble/moves/start", { cardKey: "extra", entryId: other.id });
  assert.equal(started.status, 200, "an extra may be started from any served entry");
  const start = await started.json();
  assert.match(start.cardKey, /^\d{4}-\d{2}-\d{2}:x:[A-Za-z0-9_.-]{1,64}:\d{1,12}$/);
  assert.equal(start.cardKey.slice(0, 10), localDay(Date.now()), "the server stamps its own day");
  assert.ok(start.cardKey.startsWith(start.cardKey.slice(0, 10) + ":x:" + other.id + ":"));
  assert.ok(Number.isFinite(start.startedAt));

  await ageStartRecord(db, start.cardKey, 11 * 60000);
  const before = await walletTotal(db, card.day);
  const posted = await send("POST", "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: other.id, activeSeconds: 600,
  });
  assert.equal(posted.status, 200);
  const body = await posted.json();
  assert.ok(body.progress.paid > 0, "the extra's key is the one its start answered with");
  assert.equal(body.progress.accepted, 600);
  const gain = (await walletTotal(db, card.day)) - before;
  assert.equal(gain, body.progress.paid);

  const again = await send("POST", "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: other.id, activeSeconds: 600,
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).progress.paid, 0, "the retry pays nothing");
  assert.equal(await walletTotal(db, card.day), before + gain, "and moves no row");
  db.close?.();
});

test("two concurrent identical progress posts pay once in total", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;
  await clearBudgets(db, card.day);

  const start = await (await send("POST", "/api/ramble/moves/start", {
    cardKey: "evening", entryId: card.entry.id,
  })).json();
  await ageStartRecord(db, start.cardKey, 11 * 60000);
  const before = await walletTotal(db, card.day);

  const post = () => send("POST", "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: card.entry.id, activeSeconds: 600,
  });
  const [a, b] = await Promise.all([post(), post()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const [pa, pb] = [(await a.json()).progress, (await b.json()).progress];

  const gain = (await walletTotal(db, card.day)) - before;
  assert.equal(gain, chunkPoints(10), "the day is exactly one chunk's points better off");
  assert.equal(pa.paid + pb.paid, gain, "and that is all the two of them paid together");
  assert.equal([pa, pb].filter((p) => p.paid > 0).length, 1, "one of the two paid, the other found it done");
  db.close?.();
});

test("progress refuses the old x1 shape, a mismatched entry and a malformed extra key", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;
  const other = MOVES_LIBRARY.find((e) => e.id !== card.entry.id);
  const before = await walletTotal(db, card.day);
  const post = (cardKey, entryId) => send("POST", "/api/ramble/moves/progress", {
    cardKey, chunkIndex: 0, entryId, activeSeconds: 600,
  });

  assert.equal((await post(card.day + ":x1", card.entry.id)).status, 400, "the retired numbering");

  const start = await (await send("POST", "/api/ramble/moves/start", {
    cardKey: "extra", entryId: card.entry.id,
  })).json();
  assert.equal((await post(start.cardKey, other.id)).status, 400,
    "an extra's key names its own entry");
  assert.equal((await post(card.day + ":x:" + card.entry.id, card.entry.id)).status, 400,
    "an extra key without its start second");
  assert.equal(await walletTotal(db, card.day), before, "none of the refused posts wrote anything");
  db.close?.();
});

/* ------------------------------------------- the entry a card was started for */

test("a start binds its card to one entry: a post naming a different entry is refused", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;
  const other = MOVES_LIBRARY.find((e) => e.id !== card.entry.id);

  const started = await send("POST", "/api/ramble/moves/start", { cardKey: "early", entryId: card.entry.id });
  assert.equal(started.status, 200);
  const start = await started.json();
  await ageStartRecord(db, start.cardKey, 11 * 60000);

  const before = await walletTotal(db, card.day);
  const posted = await send("POST", "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: other.id, activeSeconds: 600,
  });
  assert.equal(posted.status, 400, "the card was started for today's entry, not this one");
  assert.match((await posted.json()).error, /different entry/);
  assert.equal(await walletTotal(db, card.day), before, "and the refused post wrote nothing");
  db.close?.();
});

test("a Done mark that cannot be filed leaves the pay standing and answers 200", async () => {
  const db = await scratchDb();
  const card = (await (await get("/api/ramble/moves/today")).json()).challenge;
  await clearBudgets(db, card.day);
  const unmarkable = MOVES_LIBRARY.find((e) => e.id === "pose-unmarkable");
  assert.ok(unmarkable, "the fixture library serves an entry the ledger cannot mark");

  const started = await send("POST", "/api/ramble/moves/start", {
    cardKey: "extra", entryId: unmarkable.id,
  });
  assert.equal(started.status, 200);
  const start = await started.json();
  assert.ok(start.cardKey.startsWith(card.day + ":x:" + unmarkable.id + ":"));
  await ageStartRecord(db, start.cardKey, 11 * 60000);

  const doneBefore = await doneCount(db, card.day);
  const before = await walletTotal(db, card.day);
  const posted = await send("POST", "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: unmarkable.id, activeSeconds: 600,
  });
  assert.equal(posted.status, 200, "a paid post is never a 500 over its Done mark");
  const body = await posted.json();
  assert.equal(body.progress.done, true, "the chunk passed its half-way mark");
  assert.ok(body.progress.paid > 0, "and the pay made stands");
  assert.equal((await walletTotal(db, card.day)) - before, body.progress.paid);
  assert.equal(await doneCount(db, card.day), doneBefore, "the post filed no movedone row");
  db.close?.();
});

/* --------------------------------------------------------------- MCP tools */

const COMPRESSED = (s) => "02" + createHash("sha256").update(s).digest("hex");
const FAKE_DERIVE = (seed, botId) => ({ secp256k1Pubkey: COMPRESSED(seed + botId), secp256k1Priv: Buffer.from(botId) });
const IDENTITY = {
  crowId: "crow_MOVES_TEST", secp256k1Pubkey: COMPRESSED("moves-real"), secp256k1Priv: Buffer.from("moves-real"),
};

test("MCP: ramble_moves_today reads, ramble_moves_log refuses an unknown activity", async () => {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const handlers = {};
  createRambleServer(db, {
    _exposeHandlers: handlers,
    identity: IDENTITY,
    seed: "seed",
    _derive: FAKE_DERIVE,
    emit: async () => {},
  });

  const today = await handlers.ramble_moves_today({});
  assert.ok(!today.isError, today.content?.[0]?.text);
  const state = JSON.parse(today.content[0].text);
  // The shipped library is empty until its content task, so a null card is the
  // normal answer here; once content lands the card must still be shaped.
  assert.ok(state.challenge === null || (state.challenge && state.challenge.entry));
  assert.ok(Number.isFinite(state.health.energy));
  assert.equal(state.streak.days, 0);

  const rejected = await handlers.ramble_moves_log({ activity: "skiing", minutes: 10, effort: "easy" });
  assert.ok(rejected.isError, "an off-vocabulary activity never reaches the ledger");

  const logged = await handlers.ramble_moves_log({ activity: "walk", minutes: 10, effort: "easy" });
  assert.ok(!logged.isError, logged.content?.[0]?.text);
  const log = JSON.parse(logged.content[0].text);
  assert.equal(log.points, 12);
  assert.equal(log.paid, 12);
  assert.equal(log.already, false);
  assert.ok(log.logs.some((l) => l.activity === "walk" && l.minutes === 10 && l.effort === "easy"));

  const prefs = JSON.parse((await handlers.ramble_moves_prefs({})).content[0].text);
  assert.equal(prefs.prefs.level, 2);
  const written = JSON.parse((await handlers.ramble_moves_prefs({ patch: { level: 1, on: false } })).content[0].text);
  assert.equal(written.prefs.level, 1);
  assert.equal(written.prefs.on, false);
  const junk = await handlers.ramble_moves_prefs({ patch: { level: 7 } });
  assert.ok(junk.isError);

  db.close();
});

/* ---------------------------------- a finished chunk marks its slot (4.3) */

/** The scratch db the mount at `dir` opened, so these tests read the rows it wrote. */
async function mountDb(dir) {
  const { createDbClient } = await import("../bundles/ramble/server/db.js");
  return createDbClient(join(dir, "crow.db"));
}

/** The keys of one wallet kind: all of them, or just the one asked for. */
async function walletKeys(db, kind, key) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ?"
      + (key === undefined ? "" : " AND key = ?") + " ORDER BY key",
    args: key === undefined ? [kind] : [kind, key],
  });
  return rows.map((row) => String(row.key));
}

/** Start one of the day's own slot cards by its slot name, and finish it. */
async function playSlotCard(mount, db, day, slot) {
  const card = day.slots.find((item) => item.slot === slot);
  assert.ok(card?.entry, "the day holds a card for " + slot);
  const started = await dayPost(mount.url, "/api/ramble/moves/start", {
    cardKey: slot, entryId: card.entry.id,
  });
  assert.equal(started.status, 200, "a start names the day's " + slot + " card");
  const start = await started.json();
  assert.equal(start.cardKey, day.day + ":" + slot, "the key names the slot it closes");
  await ageStartRecord(db, start.cardKey, 11 * 60000);
  const posted = await dayPost(mount.url, "/api/ramble/moves/progress", {
    cardKey: start.cardKey, chunkIndex: 0, entryId: card.entry.id, activeSeconds: 600,
  });
  assert.equal(posted.status, 200, "the finished " + slot + " chunk posts");
  const body = await posted.json();
  assert.equal(body.progress.done, true, "ten minutes of a ten-minute card is done");
  return body;
}

/**
 * A chunk per area that can balance a day. A landmark is a card (chunk-shaped,
 * never a walk), so a finished one is the day's balance as well as its slot.
 */
function balanceChunk(area, n) {
  return entry({
    id: `mark-${area}-${n}`,
    kind: "landmark",
    title: `A ${area} landmark, number ${n}`,
    minutes: 10,
    areas: area === "mobility" ? ["mobility"] : [area, "mobility"],
  });
}
const BALANCE_LIBRARY = CHUNK_AREAS.flatMap((area) => [1, 2, 3, 4, 5].map((n) => balanceChunk(area, n)));

test("GET /moves/day: a fresh day is not complete and writes no moveall row", async () => {
  const mount = await freshMount();
  try {
    const body = await (await dayGet(mount.url)).json();
    assert.equal(body.complete, false, "nothing has been finished yet");
    const db = await mountDb(mount.dir);
    try {
      assert.deepEqual(await walletKeys(db, "moveall"), [], "an unfinished day settles nothing");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("POST /moves/start by slot name: a finished card closes its own slot", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const db = await mountDb(mount.dir);
    try {
      for (const slot of ["morning", "midday"]) {
        // eslint-disable-next-line no-await-in-loop
        const body = await playSlotCard(mount, db, day, slot);
        assert.equal(body.dayDone.fresh, true, "the " + slot + " slot row is new");
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await walletKeys(db, "moveslot", day.day + ":" + slot)).length, 1,
          "one moveslot row for " + slot);
      }

      // `evening` is both one of the day's own slot names and one of the
      // strip's older ones. The day's slot decides first, so the evening card
      // starts under its own name whichever slot the clock calls "now".
      const evening = day.slots.find((item) => item.slot === "evening");
      assert.ok(evening?.entry, "the day holds an evening card");
      const body = await playSlotCard(mount, db, day, "evening");
      assert.equal(body.dayDone.fresh, true, "the evening slot row is new");
      assert.equal((await walletKeys(db, "moveslot", day.day + ":evening")).length, 1,
        "one moveslot row for evening");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("POST /moves/start evening: the day's evening card starts by its own name", async () => {
  const mount = await freshMount();
  const realNow = Date.now;
  // The clock is pinned to 09:30 local, where the day's Now slot is the midday
  // one, so the evening card is NOT the card on screen.
  const morning = new Date(new Date(realNow()).setHours(9, 30, 0, 0)).getTime();
  Date.now = () => morning;
  try {
    const day = await (await dayGet(mount.url)).json();
    assert.equal(day.nowSlot, "midday", "the clock names the midday slot");
    assert.equal(day.need, 3);
    const evening = day.slots.find((item) => item.slot === "evening");
    const nowSlot = day.slots.find((item) => item.slot === day.nowSlot);
    assert.ok(evening?.entry, "the day holds an evening card");
    assert.ok(nowSlot?.entry, "and a Now card");
    assert.notEqual(evening.entry.id, nowSlot.entry.id, "the evening card is not the Now card");

    const started = await dayPost(mount.url, "/api/ramble/moves/start", {
      cardKey: "evening", entryId: evening.entry.id,
    });
    assert.equal(started.status, 200, "the day's own evening slot answers its own name");
    const start = await started.json();
    assert.equal(start.cardKey, day.day + ":evening");

    const db = await mountDb(mount.dir);
    try {
      await ageStartRecord(db, start.cardKey, 11 * 60000);
      const posted = await dayPost(mount.url, "/api/ramble/moves/progress", {
        cardKey: start.cardKey, chunkIndex: 0, entryId: evening.entry.id, activeSeconds: 600,
      });
      assert.equal(posted.status, 200);
      const body = await posted.json();
      assert.equal(body.progress.done, true);
      assert.equal(body.dayDone.fresh, true, "the done post closed the evening slot");
      assert.deepEqual(await walletKeys(db, "moveslot", day.day + ":evening"),
        [day.day + ":evening"]);
    } finally { db.close?.(); }
  } finally {
    Date.now = realNow;
    await mount.close();
  }
});

test("POST /moves/start cardKey day: the old name closes the slot the entry sits in", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const nowSlot = day.slots.find((item) => item.slot === day.nowSlot);
    assert.ok(nowSlot?.entry, "the Now slot holds a card");
    const db = await mountDb(mount.dir);
    try {
      const started = await dayPost(mount.url, "/api/ramble/moves/start", {
        cardKey: "day", entryId: nowSlot.entry.id,
      });
      assert.equal(started.status, 200);
      const start = await started.json();
      assert.equal(start.cardKey, day.day + ":day", "the old key names no slot of the day");
      await ageStartRecord(db, start.cardKey, 11 * 60000);
      const posted = await dayPost(mount.url, "/api/ramble/moves/progress", {
        cardKey: start.cardKey, chunkIndex: 0, entryId: nowSlot.entry.id, activeSeconds: 600,
      });
      assert.equal(posted.status, 200);
      const body = await posted.json();
      assert.equal(body.progress.done, true);
      assert.equal(body.dayDone.fresh, true);
      assert.deepEqual(await walletKeys(db, "moveslot"), [day.day + ":" + day.nowSlot],
        "the entry names the slot it sits in");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("a finished extra closes no slot but marks the areas it trains", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const chunk = MOVES_LIBRARY.find((e) => e.id === "mobility-1");
    assert.ok(chunk, "the fixture library serves a single-area chunk");
    const db = await mountDb(mount.dir);
    try {
      const started = await dayPost(mount.url, "/api/ramble/moves/start", {
        cardKey: "extra", entryId: chunk.id,
      });
      assert.equal(started.status, 200);
      const start = await started.json();
      await ageStartRecord(db, start.cardKey, 11 * 60000);
      const posted = await dayPost(mount.url, "/api/ramble/moves/progress", {
        cardKey: start.cardKey, chunkIndex: 0, entryId: chunk.id, activeSeconds: 600,
      });
      assert.equal(posted.status, 200);
      const body = await posted.json();
      assert.equal(body.progress.done, true);
      assert.equal(body.dayDone.fresh, true, "the area row is new");
      assert.deepEqual(await walletKeys(db, "moveslot"), [], "an extra closes no slot");
      assert.deepEqual(await walletKeys(db, "movearea", day.day + ":mobility"),
        [day.day + ":mobility"], "the area it trains is marked");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("POST /moves/start morning: another slot's card is refused", async () => {
  const mount = await freshMount();
  try {
    const day = await (await dayGet(mount.url)).json();
    const other = day.slots.find((item) => item.slot !== "morning");
    assert.ok(other?.entry, "the day holds a card that is not the morning one");
    const refused = await dayPost(mount.url, "/api/ramble/moves/start", {
      cardKey: "morning", entryId: other.entry.id,
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /today's card/);
  } finally { await mount.close(); }
});

test("GET /moves/day: every slot finished by the player completes the day, once", async () => {
  const mount = await freshMount(BALANCE_LIBRARY);
  try {
    // Two cards, both named by the day's own slots, so both are started by name.
    const set = await dayPost(mount.url, "/api/ramble/moves/prefs", {
      cards: 2, windows: ["morning", "midday"],
    });
    assert.equal(set.status, 200);
    const day = await (await dayGet(mount.url)).json();
    assert.deepEqual(day.slots.map((item) => item.slot), ["morning", "midday"]);
    assert.equal(day.need, 2);
    assert.equal(day.complete, false);

    const db = await mountDb(mount.dir);
    try {
      for (const item of day.slots) {
        // eslint-disable-next-line no-await-in-loop
        const body = await playSlotCard(mount, db, day, item.slot);
        assert.equal(body.dayDone.fresh, true, item.slot + " closed its slot");
      }

      const settled = await (await dayGet(mount.url)).json();
      assert.equal(settled.complete, true, "every slot finished and the day balanced");
      assert.equal((await walletKeys(db, "moveall", day.day)).length, 1, "the cache row landed once");

      const again = await (await dayGet(mount.url)).json();
      assert.equal(again.complete, true);
      assert.equal((await walletKeys(db, "moveall", day.day)).length, 1,
        "a second read settles nothing new");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

/* ----------------------------------------------- outdoor sessions (5.x) */

/** Age the open outdoor session: the routes have no clock seam of their own. */
async function ageOutdoorSession(db, ms) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [OUTDOOR_SESSION_KEY],
  });
  assert.ok(rows[0], "the outdoor start wrote a session row");
  const row = JSON.parse(String(rows[0].value));
  await db.execute({
    sql: "UPDATE ramble_settings SET value = ? WHERE key = ?",
    args: [JSON.stringify({ ...row, startedAt: Date.now() - ms }), OUTDOOR_SESSION_KEY],
  });
}

test("POST /moves/outdoor/start: a walk opens one session, and a retried start keeps its anchor", async () => {
  const mount = await freshMount();
  try {
    const first = await dayPost(mount.url, "/api/ramble/moves/outdoor/start", { entryId: "walk-10" });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.ok(Number.isFinite(body.startedAt));
    assert.equal(body.entryId, "walk-10");
    assert.match(body.sessionKey, /^\d{4}-\d{2}-\d{2}:o:\d+$/);
    assert.ok(body.sessionKey.startsWith(localDay(body.startedAt) + ":o:"));

    const again = await (await dayPost(mount.url, "/api/ramble/moves/outdoor/start", { entryId: "walk-10" })).json();
    assert.equal(again.startedAt, body.startedAt, "a retried or reloaded start keeps the original anchor");
    assert.equal(again.sessionKey, body.sessionKey, "and the same session key");

    const pose = await dayPost(mount.url, "/api/ramble/moves/outdoor/start", { entryId: "pose-test" });
    assert.equal(pose.status, 400, "only a walk opens a session");
    assert.match((await pose.json()).error, /walk/);
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/outdoor/start", { entryId: "no-such-entry" })).status, 404,
      "an entry the served library does not have is a 404");
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/outdoor/start", {})).status, 400,
      "an entry is required");
  } finally { await mount.close(); }
});

test("GET /moves/day carries the open outdoor session so a reload can resume it", async () => {
  const mount = await freshMount();
  try {
    const before = await (await dayGet(mount.url)).json();
    assert.equal(before.outdoor, null, "no session before one is started");

    const start = await (await dayPost(mount.url, "/api/ramble/moves/outdoor/start", { entryId: "walk-10" })).json();
    const body = await (await dayGet(mount.url)).json();
    assert.ok(body.outdoor, "the day carries the session");
    assert.equal(body.outdoor.startedAt, start.startedAt);
    assert.equal(body.outdoor.sessionKey, start.sessionKey);
    assert.equal(body.outdoor.entryId, "walk-10");
    assert.equal(body.outdoor.finished, false);
  } finally { await mount.close(); }
});

test("POST /moves/outdoor/done: pays by the minutes, fills cards, and answers the fresh day", async () => {
  const mount = await freshMount();
  try {
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/outdoor/done", {})).status, 400,
      "there is no session to finish");

    const db = await mountDb(mount.dir);
    try {
      await dayPost(mount.url, "/api/ramble/moves/outdoor/start", { entryId: "walk-10" });
      await ageOutdoorSession(db, 20 * 60000);

      const r = await dayPost(mount.url, "/api/ramble/moves/outdoor/done", {});
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.minutes, 20);
      assert.equal(body.paid, outdoorPoints(20), "the session pays its minutes through the outdoor budget");
      assert.equal(body.walkedNew, true, "twenty minutes badges the walk");
      assert.equal(body.filled.length, 2, "a twenty minute walk stands in for two of the day's three cards");
      assert.equal(body.needsBalance, true, "one card is always left for a balancing chunk");
      assert.ok(body.day, "the answer carries the fresh day payload");
      assert.equal(body.day.day, localDay(Date.now()));
      assert.equal(body.day.slots.filter((s) => s.done).length, body.filled.length,
        "the day shows the cards the walk filled");
      assert.equal(body.day.outdoor.finished, true, "and the session reads as finished");
      assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, body.day.day), outdoorPoints(20));

      const paid = await rowDelta(db, MOVE_OUTDOOR_KIND, body.day.day);
      const again = await (await dayPost(mount.url, "/api/ramble/moves/outdoor/done", {})).json();
      assert.equal(again.minutes, 20);
      assert.equal(again.paid, 0, "a second finish of the same session pays nothing more");
      assert.equal(again.filled.length, body.filled.length, "and fills nothing more");
      assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, body.day.day), paid, "and moves no row");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

/* ---------------------------------------------------------- stand-ins (6.x) */

test("POST /moves/log carries key and area, and that log stands in for a card", async () => {
  const mount = await freshMount();
  try {
    const day = localDay(Date.now());
    const logged = await dayPost(mount.url, "/api/ramble/moves/log", {
      activity: "yoga", minutes: 12, effort: "easy",
    });
    assert.equal(logged.status, 200);
    const body = await logged.json();
    assert.match(body.log.key, new RegExp(`^${day}:\\d+:yoga:12:easy$`));
    assert.equal(body.log.area, "mobility", "the activity's own area when none is named");

    const r = await dayPost(mount.url, "/api/ramble/moves/standin", {
      source: "log", logKey: body.log.key,
    });
    assert.equal(r.status, 200);
    const answer = await r.json();
    assert.equal(answer.standIn.ok, true);
    assert.ok(["morning", "midday", "evening"].includes(answer.standIn.slot));
    assert.equal(answer.day.day, day);
    const filled = answer.day.slots.find((item) => item.slot === answer.standIn.slot);
    assert.ok(filled, "the slot the stand-in took is one of the day's");
    assert.equal(filled.done, true, "the stand-in closed it");
    assert.equal(filled.standIn, true, "and marked it as a stand-in");

    // A yoga log with a mobility area is the balancing chunk the day kept open.
    const db = await mountDb(mount.dir);
    try {
      assert.deepEqual(await walletKeys(db, "movebal", day), [day]);
      assert.deepEqual(await walletKeys(db, "moveslot"), [day + ":" + answer.standIn.slot],
        "one card, and only the one the stand-in named");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("POST /moves/standin: a refusal is a 409 with the day's reason", async () => {
  const mount = await freshMount();
  try {
    const steps = await dayPost(mount.url, "/api/ramble/moves/standin", { source: "steps" });
    assert.equal(steps.status, 409);
    const body = await steps.json();
    assert.equal(body.error, "goal_not_reached");
    assert.equal(body.standIn.ok, false);
    assert.equal(body.standIn.reason, "goal_not_reached");

    const noLog = await dayPost(mount.url, "/api/ramble/moves/standin", { source: "log" });
    assert.equal(noLog.status, 409, "a log stand-in with no log key is the day's refusal");
    assert.equal((await noLog.json()).error, "no_log");

    assert.equal((await dayPost(mount.url, "/api/ramble/moves/standin", {})).status, 400,
      "source is required");
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/standin", { source: 7 })).status, 400,
      "a source that is not a string is a bad request");
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/standin", {
      source: "log", logKey: "x".repeat(97),
    })).status, 400, "a log key is bounded");
  } finally { await mount.close(); }
});

/* ------------------------------------------ the day payload's extras (10.1) */

/**
 * A library that lets a stated limit be seen to bite: every chunk of an area
 * carries the knee tag, and the one chunk per area that does not needs a mat —
 * out of reach until the user says they have one, so the first day can only
 * draw a knee-tagged card.
 */
function limitLibrary() {
  return CHUNK_AREAS.flatMap((area) => [
    ...[1, 2, 3, 4, 5].map((n) => entry({
      id: `${area}-knee-${n}`, title: `A ${area} chunk, number ${n}`, areas: [area], skipIf: ["knee"],
    })),
    entry({ id: `${area}-mat`, title: `A ${area} mat chunk`, areas: [area], equipment: ["mat"] }),
  ]);
}

/** One wallet row, written the way the ledger writes it. */
async function walletFact(db, kind, key, delta = 1) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [kind, key, delta, 0],
  });
}

test("day payload: the bird, Health, hearts, steps, the streak, the week and the setup ride along", async () => {
  const mount = await freshMount();
  try {
    const r = await dayGet(mount.url);
    assert.equal(r.status, 200);
    const body = await r.json();

    assert.equal(body.bird, null, "no bird has hatched on a fresh db");
    assert.ok(Number.isFinite(body.health.energy));
    assert.ok(Number.isFinite(body.health.max));
    assert.equal(typeof body.health.mood, "string");
    assert.equal(typeof body.hearts, "number");
    assert.deepEqual(Object.keys(body.steps).sort(), ["day", "goal", "goal_met", "steps", "walked"]);
    assert.equal(body.steps.day, localDay(Date.now()));
    assert.equal(body.steps.goal, 6000);
    assert.equal(body.steps.steps, 0);
    assert.equal(body.streak.days, 0);
    assert.equal(body.streak.doneToday, 0);
    assert.equal(body.streak.need, body.need, "the streak carries the day's card count");
    assert.equal(typeof body.week.total, "number");
    assert.equal(body.setup.needed, true, "nothing has been stated yet");

    // The fields the day answered before are still there beside them.
    assert.equal(body.day, localDay(Date.now()));
    assert.equal(body.off, false);
    assert.equal(body.complete, false);
    assert.ok(Array.isArray(body.slots));

    // A swap answers the same payload, so the extras travel with it too.
    const slot = body.slots[0].slot;
    const swapped = await (await dayPost(mount.url, "/api/ramble/moves/slot/swap", { slot })).json();
    assert.equal("bird" in swapped, true);
    assert.ok(Number.isFinite(swapped.health.energy));
    assert.equal(typeof swapped.streak.doneToday, "number");
    assert.equal(typeof swapped.week.total, "number");
    assert.equal(typeof swapped.setup.needed, "boolean");
  } finally { await mount.close(); }
});

test("day payload: streak.doneToday counts the day's own moveslot rows", async () => {
  const mount = await freshMount();
  try {
    const first = await (await dayGet(mount.url)).json();
    assert.equal(first.streak.doneToday, 0);
    const day = first.day;
    const db = await mountDb(mount.dir);
    try {
      await walletFact(db, "moveslot", day + ":morning");
      await walletFact(db, "moveslot", day + ":midday");
      // Not one of the day's slot names, so it is no card of it.
      await walletFact(db, "moveslot", day + ":early");

      const after = await (await dayGet(mount.url)).json();
      assert.equal(after.streak.doneToday, 2, "two of the day's slots are finished");
      assert.equal(after.streak.need, after.need);
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("day payload: streak.doneToday never exceeds the day's own card count", async () => {
  const mount = await freshMount(BALANCE_LIBRARY);
  try {
    const set = await dayPost(mount.url, "/api/ramble/moves/prefs", {
      cards: 2, windows: ["morning", "midday"],
    });
    assert.equal(set.status, 200);
    const first = await (await dayGet(mount.url)).json();
    assert.equal(first.need, 2, "the day holds two cards");
    assert.deepEqual(first.slots.map((item) => item.slot), ["morning", "midday"]);
    const day = first.day;
    const db = await mountDb(mount.dir);
    try {
      // Three finished slots, from a day that had more windows than this one.
      for (const slot of ["morning", "midday", "evening"]) {
        // eslint-disable-next-line no-await-in-loop
        await walletFact(db, "moveslot", day + ":" + slot);
      }
      const after = await (await dayGet(mount.url)).json();
      assert.equal(after.streak.need, 2);
      assert.equal(after.streak.doneToday, 2, "a two-card day can only have two done");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("day payload: the extras ride on a plain read and on a swap answer alike", async () => {
  const mount = await freshMount();
  try {
    const body = await (await dayGet(mount.url)).json();
    const extras = ["bird", "health", "hearts", "steps", "streak", "week", "setup"];
    for (const field of extras) {
      assert.equal(Object.prototype.hasOwnProperty.call(body, field), true,
        "a read of the day carries " + field);
    }
    assert.equal(body.streak.need, body.need, "the streak reads the day's own count");

    const swapped = await (await dayPost(mount.url, "/api/ramble/moves/slot/swap", {
      slot: body.slots[0].slot,
    })).json();
    for (const field of extras) {
      assert.equal(Object.prototype.hasOwnProperty.call(swapped, field), true,
        "and so does a swap's answer: " + field);
    }
    assert.deepEqual(Object.keys(swapped.steps).sort(), ["day", "goal", "goal_met", "steps", "walked"]);
    assert.equal(swapped.streak.need, swapped.need);
    assert.equal(swapped.setup.needed, body.setup.needed);
  } finally { await mount.close(); }
});

test("day payload: the setup is needed until a prefs row or an answer exists", async () => {
  const fresh = await freshMount();
  try {
    assert.equal((await (await dayGet(fresh.url)).json()).setup.needed, true);
  } finally { await fresh.close(); }

  // A prefs row written before the first read of the day is an answer too.
  const stated = await freshMount();
  try {
    assert.equal((await dayPost(stated.url, "/api/ramble/moves/prefs", { level: 1 })).status, 200);
    assert.equal((await (await dayGet(stated.url)).json()).setup.needed, false);
  } finally { await stated.close(); }

  const answered = await freshMount();
  try {
    assert.equal((await dayPost(answered.url, "/api/ramble/moves/setup", {})).status, 200);
    assert.equal((await (await dayGet(answered.url)).json()).setup.needed, false);
  } finally { await answered.close(); }
});

test("day payload: POST /moves/setup with an empty body stores the skip defaults", async () => {
  const mount = await freshMount();
  try {
    // The setup route sits behind the session auth like the rest of the moves API.
    assert.equal((await fetch(mount.url + "/api/ramble/moves/setup", { method: "POST" })).status, 401);

    const r = await dayPost(mount.url, "/api/ramble/moves/setup", {});
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual([...body.prefs.equipment].sort(), ["none", "wall"]);
    assert.deepEqual(body.prefs.limits, []);
    assert.equal(body.prefs.level, 2);
    assert.ok(body.day, "the answer carries the fresh day");
    assert.equal(body.day.day, localDay(Date.now()));
    assert.ok(Array.isArray(body.day.slots));
    assert.equal(body.day.setup.needed, false);

    const db = await mountDb(mount.dir);
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM ramble_settings WHERE key = ?", args: ["moves.setup.seen"],
      });
      assert.equal(rows.length, 1, "the answer is marked as seen");
      assert.equal(JSON.parse(String(rows[0].value)), true);
    } finally { db.close?.(); }

    // A post with no body at all is the same skip.
    const bare = await fetch(mount.url + "/api/ramble/moves/setup", { method: "POST", headers: H });
    assert.equal(bare.status, 200);
    assert.deepEqual([...(await bare.json()).prefs.limits], []);
  } finally { await mount.close(); }
});

test("day payload: POST /moves/setup stores what it was given, with none always present", async () => {
  const mount = await freshMount();
  try {
    const r = await dayPost(mount.url, "/api/ramble/moves/setup", {
      equipment: ["mat", "wall"], limits: ["knee"], level: 3,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual([...body.prefs.equipment].sort(), ["mat", "none", "wall"], "none is always in the kit");
    assert.deepEqual(body.prefs.limits, ["knee"]);
    assert.equal(body.prefs.level, 3);
    assert.equal(body.day.setup.needed, false);
    assert.deepEqual(body.day.slots.map((item) => item.slot), ["morning", "midday", "evening"]);

    const stored = await (await fetch(mount.url + "/api/ramble/moves/prefs", { headers: H })).json();
    assert.equal(stored.prefs.level, 3, "the answer was stored as the live prefs");
    assert.deepEqual(stored.prefs.limits, ["knee"]);

    assert.equal((await dayPost(mount.url, "/api/ramble/moves/setup", { limits: ["elbow"] })).status, 400,
      "a limit outside the fixed vocabulary is a bad request");
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/setup", { level: 9 })).status, 400,
      "a level that is not 1, 2 or 3 is a bad request");
  } finally { await mount.close(); }
});

test("day payload: a limit added through the prefs re-picks the day's affected card", async () => {
  const mount = await freshMount(limitLibrary());
  try {
    const first = await (await dayGet(mount.url)).json();
    // The morning slot asks the week plan for mobility, and every mobility
    // chunk within reach without a mat carries the knee tag.
    const slot = first.slots.find((item) => item.plannedArea === "mobility" && item.entry);
    assert.ok(slot, "the day holds a card for the mobility slot");
    assert.ok(slot.entry.skipIf.includes("knee"), "the card on screen is knee-tagged");

    const set = await dayPost(mount.url, "/api/ramble/moves/prefs", {
      limits: ["knee"], equipment: ["none", "mat", "wall"],
    });
    assert.equal(set.status, 200);

    const after = await (await dayGet(mount.url)).json();
    const repicked = after.slots.find((item) => item.slot === slot.slot);
    assert.ok(repicked?.entry, "the slot still holds a card");
    assert.equal(repicked.entry.skipIf.includes("knee"), false, "the stated limit ruled the old card out");
    assert.equal(repicked.entry.id, slot.plannedArea + "-mat", "the card that needs the mat is the one left");
    assert.notEqual(repicked.entry.id, slot.entry.id, "and it is not the card that was on screen");
  } finally { await mount.close(); }
});

test("day payload: two reads of a finished day settle it once", async () => {
  const mount = await freshMount();
  try {
    const first = await (await dayGet(mount.url)).json();
    assert.equal(first.complete, false, "nothing has been finished yet");
    const day = first.day;
    const db = await mountDb(mount.dir);
    try {
      // A day finished the way a peer's rows would leave it: every slot of its
      // own and its balance.
      for (const slot of ["morning", "midday", "evening"]) {
        // eslint-disable-next-line no-await-in-loop
        await walletFact(db, "moveslot", day + ":" + slot);
      }
      await walletFact(db, "movebal", day);

      const settled = await (await dayGet(mount.url)).json();
      assert.equal(settled.complete, true, "the day is complete from its rows");
      assert.equal(settled.streak.doneToday, 3, "all three of its slots are finished");
      assert.equal((await walletKeys(db, "moveall", day)).length, 1, "the settle wrote its cache row once");

      const again = await (await dayGet(mount.url)).json();
      assert.equal(again.complete, true);
      assert.equal((await walletKeys(db, "moveall", day)).length, 1,
        "a second read settles nothing new");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

/* ------------------------------------------------------------- the week (11.x) */

const weekGet = (url) => fetch(url + "/api/ramble/moves/week", { headers: H });

/** The week's days, the two of them that are not today, so a mark never collides. */
function twoDaysButToday() {
  const today = localDay(Date.now());
  return weekDays(weekIdOf(Date.now())).filter((day) => day !== today).slice(0, 2);
}

/** Two days in each of the five areas: a whole-body week. */
async function fillWholeWeek(db) {
  for (const day of twoDaysButToday()) {
    for (const area of AREAS) {
      // eslint-disable-next-line no-await-in-loop
      await walletFact(db, "movearea", day + ":" + area);
    }
  }
}

test("week: a fresh week is empty, seven days long, and writes no weekfull row", async () => {
  const mount = await freshMount();
  try {
    const r = await weekGet(mount.url);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.weekId, weekIdOf(Date.now()));
    assert.deepEqual(body.marks, { upper: [], core: [], lower: [], heart: [], mobility: [] });
    assert.equal(body.total, 0);
    assert.equal(body.full, false);
    assert.deepEqual(body.strip.map((day) => day.day), weekDays(body.weekId),
      "the strip is the whole week, Monday first");
    assert.equal(body.strip.length, 7);
    for (const day of body.strip) {
      assert.equal(day.minutes, 0, "no minutes on " + day.day);
      assert.deepEqual(day.areas, [], "no areas on " + day.day);
    }
    assert.ok(Array.isArray(body.comingUp));
    assert.equal(body.stageOffer, null);
    assert.equal(body.earned, null);

    const db = await mountDb(mount.dir);
    try {
      assert.deepEqual(await walletKeys(db, "weekfull"), [],
        "a read of a week that is not whole-body writes nothing");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("week: a whole-body week answers full, writes one weekfull row, and names the kerchief", async () => {
  const mount = await freshMount();
  try {
    const fresh = await (await weekGet(mount.url)).json();
    assert.equal(fresh.full, false, "nothing has filled the week yet");
    const weekId = fresh.weekId;

    const db = await mountDb(mount.dir);
    try {
      await fillWholeWeek(db);

      const body = await (await weekGet(mount.url)).json();
      assert.equal(body.weekId, weekId);
      assert.equal(body.total, 10);
      assert.equal(body.full, true);
      assert.deepEqual(await walletKeys(db, "weekfull", weekId), [weekId],
        "the week's earned row landed once");

      const itemId = earnedItemId(weekId);
      assert.equal(body.earned.itemId, itemId);
      assert.equal(body.earned.name, itemById(itemId).name);

      const again = await (await weekGet(mount.url)).json();
      assert.equal(again.full, true);
      assert.deepEqual(again.earned, body.earned);
      assert.deepEqual(await walletKeys(db, "weekfull"), [weekId],
        "a second read of a settled week writes no row");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("week: a log marks the area it trains, and a short or repeated one marks nothing new", async () => {
  const mount = await freshMount();
  try {
    const today = localDay(Date.now());
    const walk = await dayPost(mount.url, "/api/ramble/moves/log", {
      activity: "walk", minutes: 20, effort: "moderate",
    });
    assert.equal(walk.status, 200);

    const db = await mountDb(mount.dir);
    try {
      let week = await (await weekGet(mount.url)).json();
      assert.ok(week.marks.heart.includes(today), "a twenty minute walk marks the heart");

      const band = await dayPost(mount.url, "/api/ramble/moves/log", {
        activity: "band", minutes: 20, effort: "moderate", area: "lower",
      });
      assert.equal(band.status, 200);
      week = await (await weekGet(mount.url)).json();
      assert.ok(week.marks.lower.includes(today), "the area the log names is the one marked");

      const before = await walletKeys(db, "movearea");
      const short = await dayPost(mount.url, "/api/ramble/moves/log", {
        activity: "walk", minutes: 5, effort: "easy",
      });
      assert.equal(short.status, 200);
      week = await (await weekGet(mount.url)).json();
      assert.deepEqual(week.marks.heart, [today], "a five minute note trains nothing");
      assert.deepEqual(await walletKeys(db, "movearea"), before, "and writes no area row");

      const repeat = await dayPost(mount.url, "/api/ramble/moves/log", {
        activity: "walk", minutes: 20, effort: "moderate",
      });
      assert.equal(repeat.status, 200, "a repeated log is not an error");
      assert.deepEqual(await walletKeys(db, "movearea"), before, "and marks nothing new");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("week: a repeated log still leaves the area it trains marked", async () => {
  const mount = await freshMount();
  try {
    const today = localDay(Date.now());
    const log = { activity: "walk", minutes: 20, effort: "moderate" };
    assert.equal((await dayPost(mount.url, "/api/ramble/moves/log", log)).status, 200);

    const db = await mountDb(mount.dir);
    try {
      const mark = today + ":heart";
      assert.deepEqual(await walletKeys(db, "movearea", mark), [mark], "the first log marked the heart");
      await db.execute({
        sql: "DELETE FROM ramble_wallet WHERE kind = ? AND key = ?",
        args: ["movearea", mark],
      });
      assert.deepEqual(await walletKeys(db, "movearea"), [], "the mark is gone before the repeat");

      const repeat = await dayPost(mount.url, "/api/ramble/moves/log", log);
      assert.equal(repeat.status, 200);
      assert.equal((await repeat.json()).log.already, true, "the same minute's log is a repeat");
      assert.deepEqual(await walletKeys(db, "movearea", mark), [mark],
        "and the repeat puts the mark back");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("week: a week made whole three weeks back earns its row on a plain read, once", async () => {
  const mount = await freshMount();
  try {
    // The first read is what creates and sets up the scratch db this test writes
    // into; on a fresh week it settles nothing.
    assert.equal((await (await weekGet(mount.url)).json()).weekId, weekIdOf(Date.now()));
    const db = await mountDb(mount.dir);
    try {
      // The local day three weeks back, at its noon, named the way the router
      // names it: a day of that week rather than an instant inside it.
      const pastDay = localDay(startOfLocalDay(Date.now()) - 21 * 86400000 + 43200000);
      const pastWeek = weekIdOf(new Date(pastDay + "T12:00:00").getTime());
      const days = weekDays(pastWeek);
      assert.equal(days.length, 7, "the day names a real week");
      assert.notEqual(pastWeek, weekIdOf(Date.now()), "and it is not the week of now");

      for (const day of [days[0], days[1]]) {
        for (const area of AREAS) {
          // eslint-disable-next-line no-await-in-loop
          await walletFact(db, "movearea", day + ":" + area);
        }
      }
      assert.deepEqual(await walletKeys(db, "weekfull"), [], "nothing is settled before the rows are whole");

      const week = await (await weekGet(mount.url)).json();
      assert.equal(week.weekId, weekIdOf(Date.now()), "the answer is still this week");
      assert.deepEqual(await walletKeys(db, "weekfull"), [pastWeek],
        "the whole week three weeks back earned its own row");

      await (await weekGet(mount.url)).json();
      assert.deepEqual(await walletKeys(db, "weekfull"), [pastWeek],
        "and a second read of it settles nothing new");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

/**
 * A library of routines that each carry stages, so a played card can be staged
 * and then offered by a whole-body week. Every routine trains the core, and the
 * picker falls back to core for the slots that ask for another area.
 */
function stagedRoutine(id, n) {
  return entry({
    id,
    kind: "routine",
    title: "A staged routine, number " + n,
    minutes: 10,
    activity: "bodyweight",
    areas: ["core"],
    stages: [{ rounds: 1 }, { rounds: 2 }],
  });
}
const STAGE_LIBRARY = [1, 2, 3, 4, 5].map((n) => stagedRoutine("stage-routine-" + n, n));

test("week: a played staged routine in a whole-body week is offered, and no then yes answer it", async () => {
  const mount = await freshMount(STAGE_LIBRARY);
  try {
    const day = await (await dayGet(mount.url)).json();
    const db = await mountDb(mount.dir);
    try {
      const first = day.slots[0];
      assert.ok(first?.entry, "the day holds a card");
      const played = await playSlotCard(mount, db, day, first.slot);
      assert.equal(played.dayDone.fresh, true, "the card closed its slot");
      const firstId = first.entry.id;

      await fillWholeWeek(db);
      let week = await (await weekGet(mount.url)).json();
      assert.equal(week.full, true);
      assert.ok(week.stageOffer, "a whole-body week with a played routine offers a stage");
      assert.equal(week.stageOffer.routineId, firstId);
      assert.equal(week.stageOffer.title, first.entry.title);
      assert.equal(week.stageOffer.stage, 1);
      assert.equal(week.stageOffer.total, 2);

      const no = await dayPost(mount.url, "/api/ramble/moves/stage", {
        routineId: firstId, answer: "no",
      });
      assert.equal(no.status, 200);
      const declined = await no.json();
      assert.equal(declined.ok, true);
      assert.equal(declined.stageOffer, null, "the week is not asked about it again");
      assert.equal("stage" in declined, false, "a no moves no stage");
      assert.deepEqual(await walletKeys(db, "stage"), [], "declining writes no stage row");

      const second = day.slots.find((item) => item.entry && item.entry.id !== firstId);
      assert.ok(second?.entry, "the day holds a second card");
      await playSlotCard(mount, db, day, second.slot);
      week = await (await weekGet(mount.url)).json();
      assert.ok(week.stageOffer, "the second routine is a fresh offer");
      assert.equal(week.stageOffer.routineId, second.entry.id);

      const yes = await dayPost(mount.url, "/api/ramble/moves/stage", {
        routineId: second.entry.id, answer: "yes",
      });
      assert.equal(yes.status, 200);
      const accepted = await yes.json();
      assert.equal(accepted.ok, true);
      assert.equal(accepted.stage, 2, "the stage row moved to 2");
      assert.equal(accepted.stageOffer, null, "and that routine is not asked again");
      assert.deepEqual(await walletKeys(db, "stage"), [second.entry.id],
        "one stage row, keyed by the routine");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("week: the stage route refuses a junk answer and a routine nobody offered", async () => {
  const mount = await freshMount(STAGE_LIBRARY);
  try {
    const db = await mountDb(mount.dir);
    try {
      const maybe = await dayPost(mount.url, "/api/ramble/moves/stage", {
        routineId: "stage-routine-1", answer: "maybe",
      });
      assert.equal(maybe.status, 400, "only yes and no are answers");
      assert.equal((await dayPost(mount.url, "/api/ramble/moves/stage", { answer: "yes" })).status, 400,
        "routineId is required");

      const notOffered = await dayPost(mount.url, "/api/ramble/moves/stage", {
        routineId: "stage-routine-1", answer: "yes",
      });
      assert.equal(notOffered.status, 200);
      const body = await notOffered.json();
      assert.equal(body.ok, false);
      assert.equal(body.reason, "not-offered");
      assert.equal("stage" in body, false);
      assert.equal(body.stageOffer, null);
      assert.deepEqual(await walletKeys(db, "stage"), [], "a refusal writes no stage row");
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});

test("week: the wardrobe lists the earned kerchief and not the other four", async () => {
  const mount = await freshMount();
  try {
    const fresh = await (await weekGet(mount.url)).json();
    assert.equal(fresh.full, false);

    const db = await mountDb(mount.dir);
    try {
      await fillWholeWeek(db);
      const week = await (await weekGet(mount.url)).json();
      assert.equal(week.full, true);
      const earnedId = week.earned.itemId;

      const wardrobe = await (await fetch(mount.url + "/api/ramble/wardrobe", { headers: H })).json();
      const listed = wardrobe.items.map((item) => item.id);
      assert.ok(listed.includes(earnedId), "the earned kerchief is on the sheet");
      for (const id of ["scarf.kerchief1", "scarf.kerchief2", "scarf.kerchief3", "scarf.kerchief4", "scarf.kerchief5"]) {
        if (id === earnedId) continue;
        assert.equal(listed.includes(id), false, "a kerchief not earned yet is no offer: " + id);
      }
      const item = wardrobe.items.find((it) => it.id === earnedId);
      assert.equal(item.owned, true);
    } finally { db.close?.(); }
  } finally { await mount.close(); }
});
