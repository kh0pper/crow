import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bus from "../servers/shared/event-bus.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
let SCRATCH, server, base, saved, createDbClient;
// ONE SQLite engine per process: always the bundle's own client (core
// better-sqlite3), opened and closed per use — never @libsql on this file.
async function withDb(fn) { const db = createDbClient(); try { return await fn(db); } finally { db.close(); } }
const emitted = [];
const H = { "x-test-auth": "1", "content-type": "application/json" };
const get = (p) => fetch(base + p, { headers: H });
const post = (p, body) => fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-wardrobe-routes-"));
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
  assert.equal((await get("/api/ramble/wardrobe")).status, 200, "first request creates + inits the scratch db");
  ({ createDbClient } = await import("../bundles/ramble/server/db.js"));
  await withDb(async (db) => {
    await db.execute("INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'grant', 30, 1)");
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2)");
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1', 'incubating', 3, 3)");
    await db.execute("INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'b1') ON CONFLICT(owner) DO UPDATE SET active_egg_id = 'b1'");
  });
});
after(async () => {
  server?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("GET /api/ramble/wardrobe: the catalogue, the balance, the bird you are", async () => {
  const w = await (await get("/api/ramble/wardrobe")).json();
  assert.equal(w.seed, 30);
  assert.ok(w.items.length >= 7);
  assert.deepEqual(w.active, { egg_id: "b1", species: "crow", seed: 1, outfit: {} });
});

test("buy: 200 then 409 owned; 409 short; 400 junk", async () => {
  let r = await post("/api/ramble/wardrobe/buy", { item: "hat.beanie" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, item: "hat.beanie", seed: 18 });
  assert.ok(emitted.some((e) => e.table === "ramble_wallet" && e.row.kind === "spend"));
  r = await post("/api/ramble/wardrobe/buy", { item: "hat.beanie" });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "owned");
  r = await post("/api/ramble/wardrobe/buy", { item: "glasses.shades" });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "short");
  for (const body of [{}, { item: 7 }, { item: "hat.monocle" }, { item: "x".repeat(500) }]) {
    assert.equal((await post("/api/ramble/wardrobe/buy", body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
});

test("outfit: wear, poke the bus, show on GET /api/ramble/pet; refusals map to statuses", async () => {
  const pokes = [];
  const listener = (p) => pokes.push(p);
  bus.on("ramble:outfit-changed", listener);
  try {
    let r = await post("/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.beanie" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { outfit: { hat: "beanie" } });
    assert.deepEqual(pokes, [{ egg_id: "b1" }]);
    const pet = await (await get("/api/ramble/pet")).json();
    assert.deepEqual(pet.bird, { egg_id: "b1", species: "crow", seed: 1, outfit: { hat: "beanie" } });
    r = await post("/api/ramble/birds/b1/outfit", { slot: "hat", item: null });
    assert.deepEqual(await r.json(), { outfit: {} });

    const cases = [
      ["/api/ramble/birds/b1/outfit", { slot: "wings", item: "hat.bow" }, 400],
      ["/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.monocle" }, 400],
      ["/api/ramble/birds/b1/outfit", { slot: "scarf", item: "hat.beanie" }, 400],
      ["/api/ramble/birds/b1/outfit", { slot: "hat" }, 400],
      ["/api/ramble/birds/nope/outfit", { slot: "hat", item: "hat.beanie" }, 404],
      ["/api/ramble/birds/e1/outfit", { slot: "hat", item: "hat.beanie" }, 409],
      ["/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.leaf" }, 409],
      ["/api/ramble/birds/" + "x".repeat(200) + "/outfit", { slot: "hat", item: "hat.beanie" }, 400],
    ];
    for (const [p, body, status] of cases) assert.equal((await post(p, body)).status, status, `${p} ${JSON.stringify(body)}`);
    assert.equal(pokes.length, 2, "only successful changes poke");
  } finally { bus.off("ramble:outfit-changed", listener); }
});

test("the per-pin bird route stays PLAIN (D10) whatever the bird is wearing", async () => {
  await post("/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.beanie" });
  const svg = await (await get("/api/ramble/bird/crow/1.svg")).text();
  const { createRequire } = await import("node:module");
  const Bird = createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.cjs");
  assert.ok(svg.includes(Bird.drawBird(Bird.rollGenome(1, "crow"), undefined)));
});
