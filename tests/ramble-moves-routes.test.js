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
import { localDay } from "../bundles/ramble/server/eggs.js";
import { chunkPoints, MOVE_OUTDOOR_KIND } from "../bundles/ramble/server/moves/ledger.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import { OUTDOOR_SESSION_KEY, outdoorPoints } from "../bundles/ramble/server/moves/day.js";

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
