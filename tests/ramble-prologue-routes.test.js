/**
 * Task 6 — the eggless-player routes on a genuinely virgin db.
 *
 * `tests/ramble-panel.test.js` cannot host these: that file creates ONE
 * scratch db for the whole file in declaration order and, by the time its
 * later tests run, a nest claim has already minted a starter egg and a
 * `layday` row is already banked from a POST /api/ramble/area walk taken
 * while eggless. These four assertions need a db that has never seen either.
 *
 * Harness copied by symbol from ramble-panel.test.js (mkdtemp + env setup,
 * the dynamic import of routes.js, the express app + listen, req(), and the
 * after() teardown) — see task-6-brief.md Step 1.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "ramble-prologue-routes-"));

const savedEnv = {
  CROW_APP_ROOT: process.env.CROW_APP_ROOT,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_DB_PATH: process.env.CROW_DB_PATH,
};
process.env.CROW_APP_ROOT = REPO_ROOT;
process.env.CROW_DATA_DIR = SCRATCH;
delete process.env.CROW_DB_PATH;

// Dynamic import: a static one would be hoisted above the env writes above.
const { default: rambleRouter } = await import("../bundles/ramble/panel/routes.js");

const routerInstance = rambleRouter(
  (req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()),
  { emit: () => {} },
);

const app = express();
app.use(routerInstance);
const server = app.listen(0);
await once(server, "listening");
const BASE = `http://127.0.0.1:${server.address().port}`;

const realFetch = globalThis.fetch.bind(globalThis);

function req(path, opts = {}) {
  const headers = { "x-test-auth": "1", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return realFetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function get(path) {
  const res = await req(path);
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await req(path, { method: "POST", body });
  return { status: res.status, body: await res.json() };
}

after(async () => {
  await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Declaration order matters: tests 1 and 2 assert egg: null on a virgin db,
// test 3 grants the starter egg, test 4 is order-independent. Nothing on
// these four routes mints, and none of them feeds (recordHappyDay is called
// only from pet.js:feed), so no layday row can appear either.

test("GET /api/ramble/egg reports egg: null on a fresh install and mints nothing", async () => {
  const r = await get("/api/ramble/egg");
  assert.equal(r.status, 200);
  assert.equal(r.body.egg, null);
  assert.ok(r.body.checklist, "the checklist still renders");
  assert.deepEqual(r.body.lay, { days: 0, needed: 14 });
  const again = await get("/api/ramble/egg");
  assert.equal(again.body.egg, null, "reading twice did not conjure one");
});

test("GET /api/ramble/pet carries a null egg and lay progress", async () => {
  const r = await get("/api/ramble/pet");
  assert.equal(r.status, 200);
  assert.equal(r.body.egg, null);
  assert.ok(r.body.lay, "the pet page needs the count for the eggless card");
});

test("POST /api/ramble/prologue/intro grants once and is idempotent", async () => {
  const first = await post("/api/ramble/prologue/intro", {});
  assert.equal(first.status, 200);
  assert.ok(first.body.egg, "the starter egg arrives with the first beat");
  assert.equal(first.body.intro_seen, true);

  const second = await post("/api/ramble/prologue/intro", {});
  assert.equal(second.status, 200);
  assert.equal(second.body.egg, null, "a double-tap grants nothing further");

  const state = await get("/api/ramble/prologue");
  assert.equal(state.body.intro_seen, true);
  assert.equal(state.body.granted, true);

  const egg = await get("/api/ramble/egg");
  assert.ok(egg.body.egg, "and the egg view now has something to show");
});

test("POST /api/ramble/prologue/hatch flags the second beat and is idempotent", async () => {
  assert.equal((await post("/api/ramble/prologue/hatch", {})).status, 200);
  assert.equal((await post("/api/ramble/prologue/hatch", {})).status, 200);
  assert.equal((await get("/api/ramble/prologue")).body.hatch_seen, true);
});
