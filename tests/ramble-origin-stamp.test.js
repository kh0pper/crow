/**
 * Fix round 3 (review N-5, N-2): the REAL emit doors stamp `lamport_origin`
 * on a Ramble LWW row, and a failed guarded ALTER degrades to the pre-origin
 * stamp instead of losing the stamp (live path) or the whole queued batch.
 *
 * Both doors are driven for real: `InstanceSyncManager.emitChange` (live,
 * with a stub outbound feed) and `emitOrQueue` with no manager (the stdio
 * queue door). Real init-db.js schema in a tmpdir, never the live ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-ramble-origin-stamp-"));
const prevDataDir = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = tmpDir; // the queue door's instance-id file lives here

function freshDbPath(name) {
  const dir = join(tmpDir, name);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return join(dir, "crow.db");
}

const TEST_PRIV = Buffer.alloc(32, 0x5a);
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex") };
const LIVE_ID = "cccccccc-0000-4000-8000-0000000000c1";

before(() => { _setEligibilityForTest(() => true); });
after(() => {
  _setEligibilityForTest(null);
  if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = prevDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function liveManager(db) {
  const mgr = new InstanceSyncManager(IDENTITY, db, LIVE_ID);
  mgr.feedsDisabled = false;
  const entries = [];
  mgr.outFeeds = new Map([["peer-1", { append: async (e) => { entries.push(e); } }]]);
  return { mgr, entries };
}

/** The db client with every `ALTER TABLE` refused — a BUSY or read-only DB as far as the guarded ALTER can tell. */
function alterRefusing(db) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return (q) => {
          const sql = typeof q === "string" ? q : q?.sql;
          if (/^\s*ALTER TABLE/i.test(String(sql))) return Promise.reject(new Error("SQLITE_BUSY: injected"));
          return target.execute(q);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** A pre-origin ramble_eggs table (the shape an older bundle copy created). */
async function legacyEggsTable(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS ramble_eggs (
    egg_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'shelf', warmth INTEGER NOT NULL DEFAULT 0,
    species TEXT, seed INTEGER, found_cell TEXT, found_week TEXT, from_crow_id TEXT,
    created_at INTEGER NOT NULL, hatched_at INTEGER, lamport_ts INTEGER DEFAULT 0, shelf_origin TEXT)`);
}
async function insertEgg(db, id) {
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES (?, 'shelf', 0, 1000)", args: [id] });
  return (await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [id] })).rows[0];
}
async function stampOf(db, id, withOrigin = true) {
  const cols = withOrigin ? "lamport_ts, lamport_origin" : "lamport_ts";
  return (await db.execute({ sql: `SELECT ${cols} FROM ramble_eggs WHERE egg_id = ?`, args: [id] })).rows[0];
}

/* ------------------------------------------------------------- N-5: coverage */

test("LIVE door: emitChange stamps a Ramble egg with its Lamport AND this instance's id", async () => {
  const db = createDbClient(freshDbPath("live-ok"));
  await initRambleTables(db);
  const { mgr, entries } = liveManager(db);
  const row = await insertEgg(db, "e-live");
  const ts = await mgr.emitChange("ramble_eggs", "insert", row);
  assert.ok(Number(ts) > 0, "a Lamport was minted");
  const st = await stampOf(db, "e-live");
  assert.equal(Number(st.lamport_ts), Number(ts));
  assert.equal(st.lamport_origin, LIVE_ID, "the local row records who wrote this Lamport");
  assert.equal(entries.at(-1)?.instance_id, LIVE_ID, "and the wire entry carries the same id");
});

test("QUEUE door: emitOrQueue with no manager stamps the row with the local instance id in its atomic batch", async () => {
  const db = createDbClient(freshDbPath("queue-ok"));
  await initRambleTables(db);
  const row = await insertEgg(db, "e-queue");
  const res = await emitOrQueue(null, db, "ramble_eggs", "insert", row);
  assert.ok(res && res.queued, "queued");
  const st = await stampOf(db, "e-queue");
  assert.equal(Number(st.lamport_ts), res.lamport);
  assert.equal(st.lamport_origin, getOrCreateLocalInstanceId());
  const { rows } = await db.execute("SELECT count(*) AS n FROM sync_outbox WHERE table_name = 'ramble_eggs'");
  assert.equal(Number(rows[0].n), 1);
});

test("QUEUE door, preserve-lamport: the origin is stamped with the caller's literal Lamport", async () => {
  const db = createDbClient(freshDbPath("queue-preserve"));
  await initRambleTables(db);
  const row = await insertEgg(db, "e-pres");
  const res = await emitOrQueue(null, db, "ramble_eggs", "update", row, { lamportTs: 77 });
  assert.deepEqual(res, { queued: true, lamport: 77 });
  const st = await stampOf(db, "e-pres");
  assert.equal(Number(st.lamport_ts), 77);
  assert.equal(st.lamport_origin, getOrCreateLocalInstanceId());
});

/* ------------------------------------------- N-2: a failed ALTER degrades */

test("N-2 LIVE: when the guarded ALTER fails, emitChange still stamps the Lamport (pre-origin shape)", async () => {
  const real = createDbClient(freshDbPath("live-busy"));
  await legacyEggsTable(real);
  const db = alterRefusing(real);
  const { mgr } = liveManager(db);
  const row = await insertEgg(db, "e-live-busy");
  const ts = await mgr.emitChange("ramble_eggs", "insert", row);
  assert.ok(Number(ts) > 0);
  const st = await stampOf(real, "e-live-busy", false);
  assert.equal(Number(st.lamport_ts), Number(ts),
    "without N-2 the stamp named a missing column, failed silently, and left lamport_ts at 0");
});

test("N-2 QUEUE: when the guarded ALTER fails, the atomic batch still lands (stamp + outbox row)", async () => {
  const real = createDbClient(freshDbPath("queue-busy"));
  await legacyEggsTable(real);
  const db = alterRefusing(real);
  const row = await insertEgg(db, "e-queue-busy");
  const res = await emitOrQueue(null, db, "ramble_eggs", "insert", row);
  assert.ok(res && res.queued, "without N-2 the whole batch failed and the op was dropped");
  const st = await stampOf(real, "e-queue-busy", false);
  assert.equal(Number(st.lamport_ts), res.lamport);
  const { rows } = await real.execute("SELECT count(*) AS n FROM sync_outbox WHERE table_name = 'ramble_eggs'");
  assert.equal(Number(rows[0].n), 1);
});
