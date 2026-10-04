/**
 * Spec 2026-10-04 §5–§7: the walking API on the ramble panel router, mounted
 * the way the gateway mounts it (stub dashboardAuth, real loopback socket).
 * One SQLite engine per file: the bundle's own createDbClient, closed per use.
 * The router uses the real clock, so a run straddling local midnight could
 * flake (the test and the server would disagree on "today"); accepted —
 * the arithmetic is pinned with frozen clocks in tests/ramble-steps.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bus from "../servers/shared/event-bus.js";
import { localDay } from "../bundles/ramble/server/eggs.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
let SCRATCH, server, base, saved, createDbClient;
async function withDb(fn) { const db = createDbClient(); try { return await fn(db); } finally { db.close(); } }
const emitted = [];
const pokes = [];
const onWalked = (p) => pokes.push(p);
const H = { "x-test-auth": "1", "content-type": "application/json" };
const get = (p) => fetch(base + p, { headers: H });
const send = (method, p, body) => fetch(base + p, { method, headers: H, body: JSON.stringify(body) });
const DEV = "cccccccc-1111-2222-3333-444444444444";

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-steps-routes-"));
  saved = { CROW_APP_ROOT: process.env.CROW_APP_ROOT, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
  process.env.CROW_APP_ROOT = REPO_ROOT;
  process.env.CROW_DATA_DIR = SCRATCH;
  delete process.env.CROW_DB_PATH;
  const { default: rambleRouter } = await import(`../bundles/ramble/panel/routes.js?t=${Date.now()}`);
  const app = express();
  app.use(rambleRouter((req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()), {
    emit: async (table, op, row) => emitted.push({ table, op, row }),
  }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  bus.on("ramble:walked-changed", onWalked);
  assert.equal((await get("/api/ramble/steps")).status, 200, "first request creates + inits the scratch db");
  ({ createDbClient } = await import("../bundles/ramble/server/db.js"));
});
after(async () => {
  bus.off("ramble:walked-changed", onWalked);
  server?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("auth: the walking API sits behind dashboardAuth", async () => {
  assert.equal((await fetch(base + "/api/ramble/steps")).status, 401);
});

test("GET /api/ramble/steps: the day, and the steps-home marker is touched", async () => {
  const st = await (await get("/api/ramble/steps")).json();
  assert.deepEqual([st.goal, st.steps, st.walked, st.settings.nudge], [6000, 0, false, true]);
  const seen = await withDb(async (db) => (await db.execute("SELECT value FROM ramble_settings WHERE key = 'local.steps.seen_at'")).rows[0]?.value);
  assert.ok(Number(seen) > 0);
});

test("POST /api/ramble/steps/reading: a phone booted a second ago is credited and the row is emitted", async () => {
  const r = await send("POST", "/api/ramble/steps/reading", { device_id: DEV, counter: 100, elapsed_ms: 1000, boot_count: 3 });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reading.credited, 100);
  assert.equal(body.steps, 100);
  assert.ok(emitted.some((e) => e.table === "ramble_wallet" && e.row.kind === "steps" && e.row.delta === 100));
});

test("POST /api/ramble/steps/reading: junk is a 400, never a 500", async () => {
  for (const body of [
    {}, { device_id: "x", counter: 1, elapsed_ms: 1 }, { device_id: DEV, counter: -1, elapsed_ms: 1 },
    { device_id: DEV, counter: 1.5, elapsed_ms: 1 }, { device_id: DEV, counter: 1, elapsed_ms: "1" },
    { device_id: DEV, counter: 1, elapsed_ms: 1, boot_count: "two" },
  ]) {
    assert.equal((await send("POST", "/api/ramble/steps/reading", body)).status, 400, JSON.stringify(body));
  }
});

test("POST /api/ramble/steps/walked: idempotent, mood not seed, pokes the badge once, shows on the pet", async () => {
  const before = pokes.length;
  let r = await send("POST", "/api/ramble/steps/walked", {});
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.deepEqual([body.already, body.checked_in, body.walked, body.seed_today], [false, true, true, 0]);
  r = await send("POST", "/api/ramble/steps/walked", {});
  body = await r.json();
  assert.equal(body.already, true);
  assert.equal(pokes.length - before, 1, "one poke for the new fact");
  const pet = await (await get("/api/ramble/pet")).json();
  assert.equal(pet.walked_today, true);
});

test("PUT /api/ramble/steps/settings: validates, persists, emits; lowering the goal under today's steps completes it", async () => {
  for (const body of [{}, { goal: 1999 }, { goal: 6000.5 }, { goal: "6000" }, { nudge: "yes" }]) {
    assert.equal((await send("PUT", "/api/ramble/steps/settings", body)).status, 400, JSON.stringify(body));
  }
  await withDb((db) => db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, 2500, ?)",
    args: [`${localDay(Date.now())}:dddddddd-0000-0000-0000-000000000000`, Date.now()],
  }));
  const r = await send("PUT", "/api/ramble/steps/settings", { goal: 2000, nudge: false });
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.deepEqual([st.goal, st.goal_met, st.seed_today, st.settings.nudge], [2000, true, 3, false]);
  assert.ok(emitted.some((e) => e.table === "ramble_settings" && e.row.key === "steps.goal" && e.row.value === "2000"));
});
