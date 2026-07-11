/**
 * providers-sync wire hygiene — design items D3/D4/D8/D9 of
 * .superpowers/sdd/providers-volatile-spec.md.
 *
 *   D3: EXCLUDED_COLUMNS.providers strips created_at/updated_at/lamport_ts.
 *   D4: OUTBOUND_TRANSFORMS.providers drops a null gpu_policy from the wire
 *       (tested behaviorally through emitChange — the transform itself is
 *       module-private, matching shouldSyncRow).
 *   D8: emitChange floors the lamport counter at the outgoing row's own
 *       lamport_ts, so the envelope always exceeds it even after a
 *       sync_state counter reset (DB recovery).
 *   D9: shouldSyncRow('providers') rejects loopback base_urls in both
 *       directions (emit and apply).
 *
 * Harness follows tests/instance-sync.test.js: real init-db.js schema in a
 * tmp dir, fixed ed25519 identity, stub outbound feeds (no Hypercore).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  InstanceSyncManager,
  EXCLUDED_COLUMNS,
  shouldSyncRowForTest,
} from "../servers/sharing/instance-sync.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

// ── Shared setup ─────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "crow-provsync-test-"));

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
  cwd: join(import.meta.dirname, ".."),
});

const DB_PATH = join(tmpDir, "crow.db");

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const TEST_PRIV = Buffer.alloc(32, 0xcd);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

let managerSeq = 0;

/**
 * Manager with a stub outbound feed capturing appended entries, and the
 * sync_state counter pre-set to `counter`. feedsDisabled forced off so the
 * test outcome doesn't depend on the runner's argv/env.
 */
async function makeManager({ counter = 0 } = {}) {
  const db = createDbClient(DB_PATH);
  const instanceId = `prov-test-${++managerSeq}`;
  const mgr = new InstanceSyncManager(IDENTITY, db, instanceId);
  mgr.feedsDisabled = false;
  await db.execute({
    sql: "INSERT OR REPLACE INTO sync_state (instance_id, local_counter) VALUES (?, ?)",
    args: [instanceId, counter],
  });
  const entries = [];
  mgr.outFeeds = new Map([["peer-1", { append: async (e) => { entries.push(e); } }]]);
  return { mgr, db, entries };
}

// A syncable (non-loopback) providers row skeleton.
function providerRow(overrides = {}) {
  return {
    id: "crow-local",
    name: "crow llama.cpp",
    base_url: "http://100.118.41.122:8003/v1",
    models: '[{"id":"m1"}]',
    ...overrides,
  };
}

// ── D9: loopback emit/apply gate via shouldSyncRowForTest ────────────────────

test("D9: loopback base_urls never sync; tailnet/LAN/cloud do; malformed/missing are defensive-false", () => {
  const cases = [
    ["http://localhost:3001/llm/v1", false],
    ["http://127.0.0.1:8011/v1", false],
    ["http://[::1]:8080/v1", false],
    ["http://100.118.41.122:8003/v1", true],
    ["http://10.0.0.21:9005/v1", true],
    ["https://api.example.com/v1", true],
  ];
  for (const [base_url, expected] of cases) {
    assert.equal(
      shouldSyncRowForTest("providers", providerRow({ base_url })),
      expected,
      `base_url=${base_url} should be ${expected}`,
    );
  }
  // Missing / malformed base_url → defensive false.
  const noUrl = providerRow();
  delete noUrl.base_url;
  assert.equal(shouldSyncRowForTest("providers", noUrl), false, "missing base_url");
  assert.equal(shouldSyncRowForTest("providers", providerRow({ base_url: "not a url" })), false, "malformed base_url");
  assert.equal(shouldSyncRowForTest("providers", null), false, "null row");
});

// ── D3: excluded bookkeeping columns ─────────────────────────────────────────

test("D3: EXCLUDED_COLUMNS.providers is exactly created_at/updated_at/lamport_ts", () => {
  assert.deepEqual(
    [...EXCLUDED_COLUMNS.providers].sort(),
    ["created_at", "lamport_ts", "updated_at"],
  );
});

// ── D4: null gpu_policy dropped from the wire (via emitChange) ───────────────

test("D4: null gpu_policy key is ABSENT from the emitted entry row", async () => {
  const { mgr, entries } = await makeManager();
  const row = providerRow({ gpu_policy: null });
  const snapshot = structuredClone(row);

  const ts = await mgr.emitChange("providers", "update", row);
  assert.ok(ts !== null, "emitChange should emit for a non-loopback providers row");
  assert.equal(entries.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(entries[0].row, "gpu_policy"),
    false,
    "null gpu_policy must not ride the wire",
  );
  // Transform must be pure — the caller's row object is untouched.
  assert.deepEqual(row, snapshot, "input row must not be mutated");
});

test("D4: non-null gpu_policy rides the wire unchanged", async () => {
  const { mgr, entries } = await makeManager();
  const row = providerRow({ gpu_policy: '{"mutexGroup":"x"}' });
  const snapshot = structuredClone(row);

  await mgr.emitChange("providers", "update", row);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].row.gpu_policy, '{"mutexGroup":"x"}');
  assert.deepEqual(row, snapshot, "input row must not be mutated");
});

// ── D8: envelope counter floor ───────────────────────────────────────────────

test("D8: counter behind row.lamport_ts (post-reset) → envelope exceeds the row's lamport", async () => {
  const { mgr, entries } = await makeManager({ counter: 5 });
  const row = providerRow({ lamport_ts: 4000 });

  const ts = await mgr.emitChange("providers", "update", row);
  assert.ok(ts > 4000, `envelope lamport ${ts} must exceed row.lamport_ts 4000`);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].lamport_ts > 4000);
});

test("D8: counter already ahead of row.lamport_ts → floor never lowers it", async () => {
  const { mgr, entries } = await makeManager({ counter: 9000 });
  const row = providerRow({ lamport_ts: 4000 });

  const ts = await mgr.emitChange("providers", "update", row);
  assert.ok(ts > 9000, `envelope lamport ${ts} must exceed prior counter 9000`);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].lamport_ts > 9000);
});

// ── D3+D4 integration through emitChange ─────────────────────────────────────

test("D3+D4 integration: bookkeeping columns and null gpu_policy all stripped; content intact", async () => {
  const { mgr, entries } = await makeManager();
  const row = providerRow({
    created_at: "2026-07-01 00:00:00",
    updated_at: "2026-07-11 12:00:00",
    lamport_ts: 42,
    gpu_policy: null,
  });

  await mgr.emitChange("providers", "update", row);
  assert.equal(entries.length, 1);
  const wireRow = entries[0].row;
  for (const key of ["created_at", "updated_at", "lamport_ts", "gpu_policy"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(wireRow, key),
      false,
      `${key} must not ride the wire`,
    );
  }
  assert.equal(wireRow.base_url, "http://100.118.41.122:8003/v1");
  assert.equal(wireRow.models, '[{"id":"m1"}]');
  assert.equal(wireRow.id, "crow-local");
});
