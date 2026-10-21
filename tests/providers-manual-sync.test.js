/**
 * providers-manual-sync — the Settings "Sync bundle providers" button
 * (LLM Orchestrator → Providers) must NEVER turn a provider back on.
 *
 * Before: the button ran syncProvidersFromModelsJson(db, { force: true }),
 * which re-asserted every owned DISABLED row from models.json with
 * disabled:false (and flipped unowned disabled rows back on), replicating the
 * change to peers. On a host whose models.json still lists retired models,
 * one click resurrected all of them.
 *
 * Now the button runs the `manual` mode: it only refreshes rows that are
 * already enabled. Disabled rows (retired models, uninstalled bundles) are
 * never touched, and rows missing from the DB are never added (a fresh local
 * stamp could overwrite a peer's copy of that row fleet-wide).
 *
 * Hermetic: per-test scratch CROW_DATA_DIR + a fixture models.json fed via
 * the CROW_MODELS_JSON seam; injected ownAddrs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";

const FIXTURE = {
  // owned (loopback) and present+disabled in the DB: a retired local model
  "fx-retired-owned": { baseUrl: "http://127.0.0.1:8004/v1", models: [{ id: "big" }] },
  // unowned (TEST-NET-3) and present+disabled
  "fx-retired-unowned": { baseUrl: "http://203.0.113.9:9100/v1", models: [{ id: "x" }] },
  // owned, present and enabled: still re-asserted from the file
  "fx-live-owned": { baseUrl: "http://127.0.0.1:8011/v1", models: [{ id: "fresh-model" }] },
  // absent from the DB: never added by the button
  "fx-new": { baseUrl: "http://127.0.0.1:8099/v1", models: [{ id: "n" }] },
  // absent, names a bundle (e.g. one that was uninstalled): never added
  "fx-new-gone-bundle": { baseUrl: "http://127.0.0.1:8097/v1", bundleId: "gone-bundle", models: [{ id: "g" }] },
};

const OWN = new Set(["localhost", "127.0.0.1", "::1"]);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "providers-manual-sync-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const fixturePath = join(dir, "models.fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ providers: FIXTURE }));
  const prev = { d: process.env.CROW_DATA_DIR, m: process.env.CROW_MODELS_JSON };
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = fixturePath;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  const emits = [];
  setProviderSyncManager({ feedsDisabled: false, emitChange: async (...a) => { emits.push(a); } });
  return {
    db, emits,
    cleanup() {
      setProviderSyncManager(null);
      if (prev.d === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev.d;
      if (prev.m === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prev.m;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function insertRow(db, id, baseUrl, disabled, models = [{ id: "old" }]) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id)
          VALUES (?, ?, 'local', ?, ?, 1, 'some-instance')`,
    args: [id, baseUrl, JSON.stringify(models), disabled ? 1 : 0],
  });
}

async function rowOf(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] || null;
}

async function seedPresentRows(db) {
  await insertRow(db, "fx-retired-owned", FIXTURE["fx-retired-owned"].baseUrl, true);
  await insertRow(db, "fx-retired-unowned", FIXTURE["fx-retired-unowned"].baseUrl, true);
  await insertRow(db, "fx-live-owned", FIXTURE["fx-live-owned"].baseUrl, false);
}

test("manual sync never re-enables a disabled row (owned or unowned)", async () => {
  const { db, cleanup } = fresh();
  try {
    await seedPresentRows(db);
    await syncProvidersFromModelsJson(db, { manual: true, ownAddrs: OWN });
    assert.equal(Number((await rowOf(db, "fx-retired-owned")).disabled), 1, "owned retired row stays off");
    assert.equal(Number((await rowOf(db, "fx-retired-unowned")).disabled), 1, "unowned retired row stays off");
    assert.deepEqual(JSON.parse((await rowOf(db, "fx-retired-owned")).models), [{ id: "old" }],
      "a disabled row's content is not re-asserted either");
  } finally { cleanup(); }
});

test("manual sync still refreshes an enabled owned row from the file", async () => {
  const { db, cleanup } = fresh();
  try {
    await seedPresentRows(db);
    await syncProvidersFromModelsJson(db, { manual: true, ownAddrs: OWN });
    const live = await rowOf(db, "fx-live-owned");
    assert.equal(Number(live.disabled), 0);
    assert.equal(JSON.parse(live.models)[0].id, "fresh-model");
  } finally { cleanup(); }
});

test("manual sync never adds a row that is missing from the DB, and emits nothing for disabled rows", async () => {
  const { db, cleanup, emits } = fresh();
  try {
    await seedPresentRows(db);
    const res = await syncProvidersFromModelsJson(db, { manual: true, ownAddrs: OWN });
    assert.equal(await rowOf(db, "fx-new"), null, "missing row is not added");
    assert.equal(await rowOf(db, "fx-new-gone-bundle"), null, "missing bundle row is not added");
    assert.equal(res.skipped_absent, 2);
    assert.equal(res.reenabled, 0);
    const emittedIds = emits.map(([, , row]) => row && row.id);
    assert.ok(emittedIds.includes("fx-live-owned"), "sanity: the spy sees real emits (the refreshed enabled row)");
    assert.ok(!emittedIds.includes("fx-retired-owned") && !emittedIds.includes("fx-retired-unowned"),
      `nothing about a disabled row reaches the sync wire (emitted: ${emittedIds.join(",")})`);
  } finally { cleanup(); }
});

test("the old forced sync really did resurrect retired rows (the bug this replaces)", async () => {
  const { db, cleanup } = fresh();
  try {
    await seedPresentRows(db);
    await syncProvidersFromModelsJson(db, { force: true, ownAddrs: OWN });
    assert.equal(Number((await rowOf(db, "fx-retired-owned")).disabled), 0);
    assert.equal(Number((await rowOf(db, "fx-retired-unowned")).disabled), 0);
  } finally { cleanup(); }
});

test("manual and force cannot be combined", async () => {
  const { db, cleanup } = fresh();
  try {
    await assert.rejects(
      syncProvidersFromModelsJson(db, { manual: true, force: true, ownAddrs: OWN }),
      /manual/,
    );
  } finally { cleanup(); }
});

test("the Providers tab button runs the manual sync (no row comes back on)", async () => {
  const { db, cleanup } = fresh();
  try {
    await seedPresentRows(db);
    const tab = (await import("../servers/gateway/dashboard/settings/sections/llm/providers-tab.js")).default;
    let redirected = null;
    const res = { redirectAfterPost(u) { redirected = u; } };
    const handled = await tab.handleAction({ req: { body: { action: "llm_provider_sync" } }, res, db, action: "llm_provider_sync" });
    assert.equal(handled, true);
    assert.ok(redirected, "redirects back to the tab");
    assert.equal(Number((await rowOf(db, "fx-retired-owned")).disabled), 1, "retired owned row stays off");
    assert.equal(Number((await rowOf(db, "fx-retired-unowned")).disabled), 1, "retired unowned row stays off");
    assert.equal(await rowOf(db, "fx-new"), null, "the button adds nothing");
  } finally { cleanup(); }
});
