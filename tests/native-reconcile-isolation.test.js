/**
 * The boot native-model reconcile uses ONE instance's state and DB (queue
 * item 33). On 2026-10-16 a second gateway loaded the primary's
 * models/state.json, compared it with its own empty providers table and freed
 * the primary's port reservation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initNativeModels } from "../servers/gateway/gpu-orchestrator.js";

const scratch = mkdtempSync(join(tmpdir(), "crow-reconcile-iso-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function spies() {
  const calls = { load: 0, save: 0, reconcile: 0, upgrade: 0, list: 0 };
  return {
    calls,
    opts: {
      loadStateFn: () => { calls.load += 1; return { reservations: { "m": { port: 18100, owner: { pid: 999999999 } } }, journal: {}, registry: {} }; },
      saveStateFn: () => { calls.save += 1; },
      listProvidersAllFn: async () => { calls.list += 1; return []; },
      reconcileOnBootFn: ({ state }) => { calls.reconcile += 1; delete state.reservations.m; return { freedReservations: [{ modelId: "m" }], orphanRows: [], resumableDownloads: [] }; },
      upgradeLegacyRowsFn: async () => { calls.upgrade += 1; return []; },
      loadCatalogFn: () => ({ models: [] }),
      ownInstanceIdFn: () => "x".repeat(32),
      readOnly: false,
    },
  };
}

test("a database that is not this data dir's crow.db: nothing is loaded, upgraded, reconciled or saved", async () => {
  const dir = join(scratch, "primary-data");
  mkdirSync(dir, { recursive: true });
  const { calls, opts } = spies();
  const plan = await initNativeModels({ dir, dbPath: join(scratch, "second", "crow.db"), db: {}, ...opts });
  assert.deepEqual(plan, { freedReservations: [], orphanRows: [], resumableDownloads: [] });
  assert.deepEqual(calls, { load: 0, save: 0, reconcile: 0, upgrade: 0, list: 0 });
});

test("the data dir's own crow.db: reconcile and the legacy upgrade run as before", async () => {
  const dir = join(scratch, "own-data");
  mkdirSync(dir, { recursive: true });
  const { calls, opts } = spies();
  const plan = await initNativeModels({ dir, dbPath: join(dir, "crow.db"), db: {}, ...opts });
  assert.equal(plan.freedReservations.length, 1);
  assert.equal(calls.load, 1);
  assert.equal(calls.upgrade, 1);
  assert.equal(calls.reconcile, 1);
  assert.equal(calls.save, 1);
});

test("a symlinked crow.db (data dir links to the repo copy) counts as the same instance", async () => {
  const dir = join(scratch, "linked-data");
  const repo = join(scratch, "repo-data");
  mkdirSync(dir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "crow.db"), "");
  symlinkSync(join(repo, "crow.db"), join(dir, "crow.db"));
  const { calls, opts } = spies();
  await initNativeModels({ dir, dbPath: join(repo, "crow.db"), db: {}, ...opts });
  assert.equal(calls.reconcile, 1);
});

test("a legacy-upgrade failure never blocks the reconcile", async () => {
  const dir = join(scratch, "upgrade-throws");
  mkdirSync(dir, { recursive: true });
  const { calls, opts } = spies();
  opts.upgradeLegacyRowsFn = async () => { throw new Error("boom"); };
  await initNativeModels({ dir, dbPath: join(dir, "crow.db"), db: {}, ...opts });
  assert.equal(calls.reconcile, 1);
});

test("orchestration disabled: the reconcile only reports — no save, no download resume, no row upgrade", async () => {
  const dir = join(scratch, "read-only");
  mkdirSync(dir, { recursive: true });
  const { calls, opts } = spies();
  let enqueued = 0;
  opts.loadStateFn = () => { calls.load += 1; return { reservations: { "m": { port: 18100, owner: { pid: 999999999 } } }, journal: { "dl": { bytesDone: 1 } }, registry: {} }; };
  opts.reconcileOnBootFn = ({ state }) => { calls.reconcile += 1; return { freedReservations: [{ modelId: "m" }], orphanRows: [], resumableDownloads: [{ modelId: "dl" }] }; };
  const plan = await initNativeModels({ dir, dbPath: join(dir, "crow.db"), db: {}, ...opts, readOnly: true, enqueueDownloadFn: async () => { enqueued += 1; } });
  assert.equal(plan.freedReservations.length, 1, "still reported");
  assert.equal(calls.save, 0);
  assert.equal(calls.upgrade, 0);
  assert.equal(enqueued, 0);
});
