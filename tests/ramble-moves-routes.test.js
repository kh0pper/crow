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
 *   - today / done / swap / log / prefs / library / flow-run round-trip,
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { createRambleServer } from "../bundles/ramble/server/server.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { chunkPoints } from "../bundles/ramble/server/moves/ledger.js";

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
];

let SCRATCH, server, base, saved;
const emitted = [];
const H = { "x-test-auth": "1", "content-type": "application/json" };
const get = (p) => fetch(base + p, { headers: H });
const send = (method, p, body) => fetch(base + p, { method, headers: H, body: JSON.stringify(body ?? {}) });

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-moves-routes-"));
  saved = { CROW_APP_ROOT: process.env.CROW_APP_ROOT, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
  process.env.CROW_APP_ROOT = REPO_ROOT;
  process.env.CROW_DATA_DIR = SCRATCH;
  delete process.env.CROW_DB_PATH;
  const { default: rambleRouter } = await import(`../bundles/ramble/panel/routes.js?t=${Date.now()}`);
  const app = express();
  app.use(rambleRouter((req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()), {
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
  for (const p of ["/api/ramble/moves/today", "/api/ramble/moves/prefs", "/api/ramble/moves/library"]) {
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
  assert.deepEqual(list.entries.map((e) => e.id).sort(), ["flow-test", "pose-test", "pose-unmarkable", "walk-10"]);
  assert.equal(list.entries.some((e) => "pose" in e), false);

  const detail = await (await get("/api/ramble/moves/library/pose-test")).json();
  assert.equal(detail.entry.id, "pose-test");
  assert.deepEqual(detail.entry.pose, { joints: { hip: 90 } });

  assert.equal((await get("/api/ramble/moves/library/no-such-entry")).status, 404);
  assert.equal((await get("/api/ramble/moves/library/Bad%20Id")).status, 400);
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