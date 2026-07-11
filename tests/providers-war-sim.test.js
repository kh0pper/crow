/**
 * providers-war-sim — T6 integration test for the owner-asserts design
 * (spec: .superpowers/sdd/providers-volatile-spec.md).
 *
 * Simulates the exact production failure the branch fixes: the fleet is in a
 * post-war state where the owner's DB row carries a NON-OWNER's stale
 * metadata at a HIGH lamport (grackle's 181-conflict assert war), and proves
 * the D6 self-heal transition end-to-end across two real DBs:
 *
 *   1. Owner A re-asserts truth → the emitted envelope lamport strictly
 *      exceeds the stale row's historical 4000 (upsert max+1 + D8 floor).
 *   2. The wire entry carries no created_at/updated_at/lamport_ts (D3) and
 *      no null gpu_policy key (D4).
 *   3. Non-owner B applies the entry → converges to truth, ZERO conflict rows.
 *   4. B's reconciler decision for the same row is skip_unowned (D1) — the
 *      war's other writer is gone.
 *   5. A re-asserting identical content is a no-op: no write, no new feed
 *      entry (D2) — the boot-churn engine is off.
 *   6. Re-delivering the same feed to B is silent re-delivery noise — still
 *      zero conflicts.
 *
 * Harness: real init-db.js schema per instance (TWO tmp dirs = two DBs, like
 * real paired instances), stub feed (no Hypercore), shared test identity so
 * sign/verify pass (pattern: tests/instance-sync.test.js).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import {
  upsertProvider, setProviderSyncManager, reconcileDecision,
} from "../servers/shared/providers-db.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const A_ID = "aaaaaaaa-0000-0000-0000-00000000000a"; // owner (crow)
const B_ID = "bbbbbbbb-0000-0000-0000-00000000000b"; // non-owner (grackle)

const dirA = mkdtempSync(join(tmpdir(), "war-sim-A-"));
const dirB = mkdtempSync(join(tmpdir(), "war-sim-B-"));
for (const dir of [dirA, dirB]) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
}
// getOrCreateLocalInstanceId (used by upsertProvider) keys on CROW_DATA_DIR.
const PREV_DATA_DIR = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = dirA;

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
    entries: [],
    get length() { return feed.entries.length; },
    async get(seq) { return feed.entries[seq]; },
    async append(entry) { feed.entries.push(entry); return feed.entries.length - 1; },
  };
  return feed;
}
const feedAtoB = makeStubFeed();
mgrA.outFeeds.set(B_ID, feedAtoB);

after(() => {
  setProviderSyncManager(null);
  if (PREV_DATA_DIR === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = PREV_DATA_DIR;
  try { dbA.close(); } catch {}
  try { dbB.close(); } catch {}
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

// The endpoint A owns; B does not (foreign address in both instances' terms —
// ownership is asserted via reconcileDecision, not live interfaces, here).
const BASE_URL = "http://100.64.77.1:8003/v1";
const STALE_MODELS = JSON.stringify([{ id: "qwen", name: "STALE Q6_K 1M", contextWindow: 1048576 }]);
const TRUTH_MODELS = [{ id: "qwen", name: "TRUTH Q5_K_XL 256K", contextWindow: 262144 }];

async function conflictCount(db) {
  const { rows } = await db.execute("SELECT COUNT(*) AS n FROM sync_conflicts");
  return Number(rows[0].n);
}

async function providerRow(db) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM providers WHERE id = ?", args: ["war-local"],
  });
  return rows[0];
}

test("war sim: owner heals a stale high-lamport fleet; non-owner is gated; converged fleet is silent", async () => {
  // ── Post-war starting state: BOTH DBs hold the non-owner's stale copy at
  //    lamport 4000 (what the 181-conflict war left behind on the live fleet).
  for (const db of [dbA, dbB]) {
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id)
            VALUES ('war-local', ?, 'local', ?, 0, 4000, ?)`,
      args: [BASE_URL, STALE_MODELS, B_ID],
    });
  }

  // ── Step 1: owner A re-asserts truth (what its post-deploy reconcile does
  //    for an owned+differs entry).
  setProviderSyncManager(mgrA);
  const res1 = await upsertProvider(dbA, {
    id: "war-local", baseUrl: BASE_URL, host: "local", models: TRUTH_MODELS,
  });
  assert.equal(res1.unchanged, undefined, "content differed — must be a real write");
  assert.equal(feedAtoB.length, 1, "exactly one wire entry emitted");

  const entry = feedAtoB.entries[0];
  assert.equal(entry.table, "providers");
  assert.ok(entry.lamport_ts > 4000,
    `envelope lamport ${entry.lamport_ts} must exceed the stale row's 4000 (upsert max+1 / D8 floor)`);
  // D3: bookkeeping columns never ride the wire.
  assert.ok(!("created_at" in entry.row), "created_at stripped (D3)");
  assert.ok(!("updated_at" in entry.row), "updated_at stripped (D3)");
  assert.ok(!("lamport_ts" in entry.row), "row lamport_ts stripped (D3 — envelope carries it)");
  // D4: null gpu_policy key dropped.
  assert.ok(!("gpu_policy" in entry.row), "null gpu_policy dropped from the wire (D4)");

  // ── Step 2: non-owner B applies the entry → converges to truth, no conflict.
  await mgrB._processNewEntries(A_ID, feedAtoB);
  const rowB = await providerRow(dbB);
  const modelsB = JSON.parse(rowB.models);
  assert.equal(modelsB[0].name, "TRUTH Q5_K_XL 256K", "B converged to the owner's truth");
  assert.equal(modelsB[0].contextWindow, 262144);
  assert.equal(Number(rowB.lamport_ts), Number(entry.lamport_ts), "B stamped the envelope lamport");
  assert.equal(await conflictCount(dbB), 0, "convergence produced zero conflict rows on B");

  // ── Step 3: B's reconciler is gated for this row (D1) — the other writer
  //    of the war is gone. (Ownership decision is the pure seam the live
  //    reconciler routes through; B does not own the endpoint.)
  assert.equal(
    reconcileDecision({ owned: false, present: true, disabled: false, force: false }),
    "skip_unowned",
    "non-owner must never assert its file copy over a present enabled row",
  );

  // ── Step 4: converged owner re-assert is a full no-op (D2) — the restart
  //    churn engine is off.
  const res2 = await upsertProvider(dbA, {
    id: "war-local", baseUrl: BASE_URL, host: "local", models: TRUTH_MODELS,
  });
  assert.equal(res2.unchanged, true, "identical content → suppressed");
  assert.equal(feedAtoB.length, 1, "no second wire entry (D2: no emit on no-op)");

  // ── Step 5: re-delivering the same feed to B is silent re-delivery noise.
  await mgrB._processNewEntries(A_ID, feedAtoB);
  assert.equal(await conflictCount(dbB), 0, "re-delivery stays conflict-free");
  assert.equal(await conflictCount(dbA), 0, "owner side clean throughout");
});
