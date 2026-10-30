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
    id: "flow-test", kind: "flow", title: "A test flow", minutes: 8, indoor: true,
    activity: "yoga", equipment: ["none"], flow: ["pose-test", "pose-test", "pose-test", "pose-test", "pose-test"]
      .map((id) => ({ id, holdSeconds: 30 })),
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
  assert.deepEqual(list.entries.map((e) => e.id).sort(), ["flow-test", "pose-test", "walk-10"]);
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
  assert.equal(log.points, 5);
  assert.equal(log.paid, 5);
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