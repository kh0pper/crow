/**
 * providers-host-repair-sim — two-instance simulation of the host repair
 * (spec: docs/superpowers/specs/2026-09-22-provider-host-identity-design.md §3.4, §4.1).
 *
 * Proves the repair can never start a sync war: each instance runs its full
 * hourly reconcile (`syncProvidersFromModelsJson`, which asserts owned
 * models.json entries and then calls `repairProviderHosts`) over its own
 * address set, and the two instances exchange feeds after every round.
 *
 *   A. A's bad write (host "raven") converges to "cloud" on both sides with
 *      one wire entry, and the clocks stop.
 *   B. The owner (B) asserts "local" for its own endpoint; the non-owner (A)
 *      never fights it (D3), so nothing is emitted and B's lamport stays 50.
 *   C. A bundle row B re-stamped (the live crow-chat case) is out of repair
 *      scope, so B never rewrites A's endpoint.
 *   D. Co-owners that compute the same value converge with zero conflicts.
 *
 * Harness copied from tests/providers-war-sim.test.js: two init-db'd tmp
 * dirs, shared test identity, one InstanceSyncManager per side, stub feeds.
 * Each stub feed carries a unique key so the applied-seq cursor
 * (sync_state.last_applied_seq_per_peer) never carries over between tests.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import {
  setProviderSyncManager, syncProvidersFromModelsJson,
} from "../servers/shared/providers-db.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const A_ID = "a".repeat(32); // crow
const B_ID = "b".repeat(32); // grackle

const dirA = mkdtempSync(join(tmpdir(), "host-repair-sim-A-"));
const dirB = mkdtempSync(join(tmpdir(), "host-repair-sim-B-"));
for (const dir of [dirA, dirB]) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
}
// getOrCreateLocalInstanceId reads $CROW_DATA_DIR/instance-id — write both
// before any upsert.
writeFileSync(join(dirA, "instance-id"), A_ID);
writeFileSync(join(dirB, "instance-id"), B_ID);

const PREV_DATA_DIR = process.env.CROW_DATA_DIR;
const PREV_MODELS_JSON = process.env.CROW_MODELS_JSON;

const TEST_PRIV = Buffer.alloc(32, 0xCD);
const IDENTITY = {
  ed25519Priv: TEST_PRIV,
  ed25519Pubkey: Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex"),
};

const dbA = createDbClient(join(dirA, "crow.db"));
const dbB = createDbClient(join(dirB, "crow.db"));
const mgrA = new InstanceSyncManager(IDENTITY, dbA, A_ID);
const mgrB = new InstanceSyncManager(IDENTITY, dbB, B_ID);
mgrA.feedsDisabled = false;
mgrB.feedsDisabled = false;

function makeStubFeed() {
  const feed = {
    key: randomBytes(32),
    entries: [],
    get length() { return feed.entries.length; },
    async get(seq) { return feed.entries[seq]; },
    async append(entry) { feed.entries.push(entry); return feed.entries.length - 1; },
  };
  return feed;
}

after(() => {
  setProviderSyncManager(null);
  if (PREV_DATA_DIR === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = PREV_DATA_DIR;
  if (PREV_MODELS_JSON === undefined) delete process.env.CROW_MODELS_JSON;
  else process.env.CROW_MODELS_JSON = PREV_MODELS_JSON;
  try { dbA.close(); } catch {}
  try { dbB.close(); } catch {}
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

const ADDRS_A = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.237", "100.118.41.122"]);
const ADDRS_B = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.21", "100.121.254.89"]);

const EMPTY = { providers: {} };

/** Per-scenario, per-side models.json fixtures (a shared file would seed B's rows into A's/C's tables). */
function writeFixtures(scenario, fileA, fileB) {
  writeFileSync(join(dirA, `models-${scenario}.json`), JSON.stringify(fileA));
  writeFileSync(join(dirB, `models-${scenario}.json`), JSON.stringify(fileB));
}

async function side(which, scenario) {
  const dir = which === "A" ? dirA : dirB;
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = join(dir, `models-${scenario}.json`);
  setProviderSyncManager(which === "A" ? mgrA : mgrB);
}

async function conflictCount(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_conflicts");
  return Number(rows[0].n);
}

async function row(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

const deliver = (feed, mgr, fromId) => mgr._processNewEntries(fromId, feed);

let feedAtoB;
let feedBtoA;

/** Clean both DBs (rows, conflicts, applied-seq cursors) and build fresh keyed feeds. */
async function reset() {
  for (const db of [dbA, dbB]) {
    await db.execute("DELETE FROM providers");
    await db.execute("DELETE FROM sync_conflicts");
    await db.execute("DELETE FROM sync_state");
  }
  feedAtoB = makeStubFeed();
  feedBtoA = makeStubFeed();
  mgrA.outFeeds.set(B_ID, feedAtoB);
  mgrB.outFeeds.set(A_ID, feedBtoA);
}

async function round(scenario, addrsA, addrsB) {
  await side("A", scenario);
  await syncProvidersFromModelsJson(dbA, { ownAddrs: addrsA });
  await side("B", scenario);
  await syncProvidersFromModelsJson(dbB, { ownAddrs: addrsB });
  await deliver(feedAtoB, mgrB, A_ID);
  await deliver(feedBtoA, mgrA, B_ID);
}

test("scenario A: A's bad host write converges to cloud on both sides; clocks stop", async () => {
  await reset();
  writeFixtures("A", EMPTY, EMPTY);
  for (const db of [dbA, dbB]) {
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, lamport_ts, instance_id, bundle_id)
            VALUES ('raven-x', 'http://10.0.0.126:8030/v1', 'raven', 50, ?, NULL)`,
      args: [A_ID],
    });
  }

  await round("A", ADDRS_A, ADDRS_B);
  await round("A", ADDRS_A, ADDRS_B);
  const lampA2 = Number((await row(dbA, "raven-x")).lamport_ts);
  const lampB2 = Number((await row(dbB, "raven-x")).lamport_ts);
  await round("A", ADDRS_A, ADDRS_B);
  await round("A", ADDRS_A, ADDRS_B);

  const a = await row(dbA, "raven-x");
  const b = await row(dbB, "raven-x");
  assert.equal(a.host, "cloud", "A repaired its own bad write");
  assert.equal(b.host, "cloud", "B converged to A's repair");
  assert.equal(Number(a.lamport_ts), Number(b.lamport_ts), "lamports equal");
  assert.equal(feedAtoB.length, 1, "exactly one wire entry from A");
  assert.equal(feedBtoA.length, 0, "B never emitted");
  assert.equal(await conflictCount(dbA) + await conflictCount(dbB), 0, "no conflicts");
  assert.equal(Number(a.lamport_ts), lampA2, "A's clock stopped after round 2");
  assert.equal(Number(b.lamport_ts), lampB2, "B's clock stopped after round 2");
});

test("scenario B: the owner asserts local and the non-owner never fights it", async () => {
  await reset();
  writeFixtures("B", EMPTY, {
    providers: {
      "grackle-embed": { baseUrl: "http://100.121.254.89:9100/v1", host: "local", models: [{ id: "e" }] },
    },
  });
  for (const db of [dbA, dbB]) {
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, models, bundle_id, gpu_policy, lamport_ts, instance_id)
            VALUES ('grackle-embed', 'http://100.121.254.89:9100/v1', 'local', '[{"id":"e"}]', NULL, NULL, 50, ?)`,
      args: [B_ID],
    });
  }

  await round("B", ADDRS_A, ADDRS_B);
  await round("B", ADDRS_A, ADDRS_B);
  const lampB2 = Number((await row(dbB, "grackle-embed")).lamport_ts);
  await round("B", ADDRS_A, ADDRS_B);
  await round("B", ADDRS_A, ADDRS_B);
  const lampB4 = Number((await row(dbB, "grackle-embed")).lamport_ts);

  // 1. Clock-climb check FIRST: a fight shows up as B's lamport rising round over round.
  assert.equal(lampB4, lampB2, `B's lamport climbed between round 2 (${lampB2}) and round 4 (${lampB4}) — sync war`);
  assert.equal(lampB2, 50, "B's lamport stays 50 (owned assert is a no-op)");
  // 2. Both rows local.
  assert.equal((await row(dbA, "grackle-embed")).host, "local", "A's copy stays local");
  assert.equal((await row(dbB, "grackle-embed")).host, "local", "B's copy stays local");
  // 3. Nothing on the wire.
  assert.equal(feedAtoB.length, 0, "A never emitted (D3: not its write)");
  assert.equal(feedBtoA.length, 0, "B's owned assert was a no-op");
  // 4. No conflicts.
  assert.equal(await conflictCount(dbA) + await conflictCount(dbB), 0, "no conflicts");
});

test("scenario C: a bundle row B re-stamped (crow-chat case) is never repaired by B", async () => {
  await reset();
  writeFixtures("C", EMPTY, EMPTY);
  for (const db of [dbA, dbB]) {
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, lamport_ts, instance_id, bundle_id)
            VALUES ('crow-swap-agentic', 'http://100.118.41.122:8003/v1', 'local', 50, ?, 'llamacpp-vulkan-qwen36-35b-a3b')`,
      args: [B_ID],
    });
  }

  for (let i = 0; i < 4; i++) await round("C", ADDRS_A, ADDRS_B);

  assert.equal((await row(dbA, "crow-swap-agentic")).host, "local", "A's copy stays local");
  assert.equal((await row(dbB, "crow-swap-agentic")).host, "local", "B's copy stays local");
  assert.equal(feedBtoA.length, 0, "B never rewrote A's endpoint");
  assert.equal(await conflictCount(dbA) + await conflictCount(dbB), 0, "no conflicts");
});

test("scenario D: co-owners computing the same value converge with zero conflicts", async () => {
  await reset();
  writeFixtures("D", EMPTY, EMPTY);
  for (const [db, id] of [[dbA, A_ID], [dbB, B_ID]]) {
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, lamport_ts, instance_id)
            VALUES ('raven-y', 'http://10.0.0.126:8030/v1', 'raven', 50, ?)`,
      args: [id],
    });
  }

  for (let i = 0; i < 4; i++) await round("D", ADDRS_A, ADDRS_A);

  const a = await row(dbA, "raven-y");
  const b = await row(dbB, "raven-y");
  assert.equal(a.host, "cloud", "A's copy repaired to cloud");
  assert.equal(b.host, "cloud", "B's copy repaired to cloud");
  assert.equal(Number(a.lamport_ts), Number(b.lamport_ts), "lamports equal");
  // rowsEquivalent ignores lamport_ts/instance_id, so the equal-data deliveries
  // are skipped. Spec §4.1's "<=1" remains the documented bound.
  assert.equal(await conflictCount(dbA) + await conflictCount(dbB), 0, "exactly 0 conflicts");
});
