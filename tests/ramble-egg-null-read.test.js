/**
 * Task 2 review finding 2 — regression coverage for the null-egg guard.
 *
 * Both `GET /api/ramble/pet` (bundles/ramble/panel/routes.js) and the
 * `ramble_pet_state` MCP tool (bundles/ramble/server/server.js) used to do
 * `egg.egg.percent` unguarded. Once `eggState` can legitimately return
 * `egg: null` (spec 2026-09-08 §4.1), that throws — a 500 from the route, an
 * `isError` result from the tool. Every other suite that exercises these two
 * reads mints an egg at module load (a deliberate Task 2 fixture repair), so
 * none of them would have caught a regression back to the unguarded form.
 * This file's whole purpose is to drive each read against a virgin db that
 * has NEVER minted an egg.
 *
 * Each test gets its own fresh scratch dir / db — a dedicated file rather
 * than reusing `tests/ramble-panel.test.js` or `tests/ramble-tools.test.js`,
 * both of which mint an egg once at module load for the rest of their run
 * and so cannot produce a virgin db partway through.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");

test("GET /api/ramble/pet on a virgin db (no egg ever minted) reports egg: null, not a crash", async () => {
  const SCRATCH = mkdtempSync(join(tmpdir(), "ramble-egg-null-route-"));
  const savedEnv = {
    CROW_APP_ROOT: process.env.CROW_APP_ROOT,
    CROW_DATA_DIR: process.env.CROW_DATA_DIR,
    CROW_DB_PATH: process.env.CROW_DB_PATH,
  };
  process.env.CROW_APP_ROOT = REPO_ROOT;
  process.env.CROW_DATA_DIR = SCRATCH;
  delete process.env.CROW_DB_PATH;

  let server;
  try {
    // Dynamic import so the env above is in place before the bundle's
    // BUNDLE_DIR / db-path resolution runs.
    const { default: rambleRouter } = await import(`../bundles/ramble/panel/routes.js?t=${Date.now()}`);
    const routerInstance = rambleRouter((req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()));
    const app = express();
    app.use(routerInstance);
    server = app.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    // The FIRST request to hit this router lazily creates+inits the scratch
    // db (routes.js ensureLoaded()) — nothing else has touched ramble_eggs.
    const res = await fetch(`${base}/api/ramble/pet`, { headers: { "x-test-auth": "1" } });
    assert.equal(res.status, 200, "must not 500 for a virgin db with no egg");
    const body = await res.json();
    assert.equal(body.egg, null, "no egg exists, so the read must report null — not a phantom 0%-warmth egg");
  } finally {
    if (server) await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("ramble_pet_state on a virgin db (no egg ever minted) reports egg: null, not isError", async () => {
  const { initRambleTables } = await import("../bundles/ramble/server/init-tables.js");
  const { createRambleServer } = await import("../bundles/ramble/server/server.js");

  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  // Deliberately no mintIncubatingEgg call — this db has never had one.

  const handlers = {};
  const identity = { crowId: "crow_virgin", secp256k1Pubkey: "02" + "aa".repeat(32), secp256k1Priv: Buffer.from("virgin") };
  createRambleServer(db, { _exposeHandlers: handlers, identity, seed: "seed", emit: async () => {} });

  const r = await handlers.ramble_pet_state({});
  assert.ok(!r.isError, `ramble_pet_state must not error for a virgin db: ${r.isError ? r.content?.[0]?.text : ""}`);
  const state = JSON.parse(r.content[0].text);
  assert.equal(state.egg, null, "no egg exists, so the read must report null — not a phantom 0%-warmth egg");
});
