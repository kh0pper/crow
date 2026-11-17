// tests/provider-change-watch.test.js
/**
 * A provider row written OUTSIDE the gateway process (a script or CLI calling
 * upsertProvider on the same providers table) never reaches
 * setProviderChangeHook, so pi's models.json used to miss it until the hourly
 * reconcile or a restart. `providersFingerprint` + `createProviderChangeWatch`
 * are the fix: one cheap aggregate polled on a short interval.
 *
 * Harness: a real crow.db in a throwaway dir (freshLibsql pattern from
 * providers-upsert-noop.test.js). CROW_DATA_DIR points at the tmp dir before
 * any upsert, so getOrCreateLocalInstanceId() writes its instance-id file
 * there and never in a real ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDbClient } from "../servers/db.js";
import { providersFingerprint, upsertProvider } from "../servers/shared/providers-db.js";
import { createProviderChangeWatch } from "../servers/shared/provider-change-watch.js";
import { syncPiModelsJson } from "../servers/shared/pi-models-sync.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "provider-watch-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createDbClient(join(dir, "crow.db"));
  return {
    dir, db,
    cleanup() {
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A bundle row: local-class, so pi's models.json treats it as managed and
// writes it as a plain entry (no door, no consent).
const ROW = {
  id: "watch-probe",
  baseUrl: "http://127.0.0.1:18100/v1",
  apiKey: null,
  host: "local",
  bundleId: "watch-probe-bundle",
  description: "provider-change-watch fixture",
  models: [{ id: "m" }],
  providerType: null,
  disabled: false,
};

// --------------------------------------------------------------- fingerprint

test("providersFingerprint moves on insert, on a disabled flip and on delete, and is stable when nothing changed", async () => {
  const fx = freshDb();
  try {
    const empty = await providersFingerprint(fx.db);
    assert.equal(empty, "0||0|0");

    await upsertProvider(fx.db, { ...ROW, apiKey: "sk-test-secret-1" });
    const inserted = await providersFingerprint(fx.db);
    assert.notEqual(inserted, empty, "an insert moves it");
    assert.equal(await providersFingerprint(fx.db), inserted, "two calls with no change in between agree");

    assert.equal(inserted.includes("sk-test-secret-1"), false, "no credential text in the fingerprint");

    await upsertProvider(fx.db, { ...ROW, apiKey: "sk-test-secret-1", disabled: true });
    const disabled = await providersFingerprint(fx.db);
    assert.notEqual(disabled, inserted, "a disabled flag change moves it");
    assert.equal(disabled.includes("sk-test-secret-1"), false);

    await fx.db.execute({ sql: "DELETE FROM providers WHERE id = ?", args: [ROW.id] });
    const deleted = await providersFingerprint(fx.db);
    assert.notEqual(deleted, disabled, "a delete moves it");
    assert.equal(deleted, empty, "a hard delete returns to the empty-table fingerprint");
  } finally {
    fx.cleanup();
  }
});

// -------------------------------------------------------------------- watch

test("watch: the baseline poll reports nothing; a changed fingerprint reports once; unchanged stays silent", async () => {
  let fp = "a";
  let calls = 0;
  const watch = createProviderChangeWatch({ fingerprintFn: async () => fp, onChange: () => { calls++; } });

  await watch.poll();
  assert.equal(calls, 0, "the first value ever seen is only the baseline");
  await watch.poll();
  assert.equal(calls, 0, "unchanged");

  fp = "b";
  await watch.poll();
  assert.equal(calls, 1, "a different value reports once");
  await watch.poll();
  assert.equal(calls, 1, "the new value became the baseline");

  fp = "c";
  await watch.poll();
  assert.equal(calls, 2, "the watch keeps working after it has fired");
});

test("watch: a throwing fingerprintFn or onChange never escapes poll and keeps the old baseline", async () => {
  let calls = 0;
  let fpMode = "ok";
  let onChangeMode = "ok";
  let value = "a";
  const watch = createProviderChangeWatch({
    fingerprintFn: async () => {
      if (fpMode === "boom") throw new Error("db gone");
      return value;
    },
    onChange: () => {
      calls++;
      if (onChangeMode === "boom") throw new Error("sync blew up");
    },
  });

  await watch.poll(); // baseline "a"

  fpMode = "boom";
  await watch.poll(); // swallowed, nothing reported
  assert.equal(calls, 0);

  fpMode = "ok";
  value = "b";
  onChangeMode = "boom";
  await watch.poll(); // onChange throws: swallowed, baseline NOT advanced
  assert.equal(calls, 1);

  onChangeMode = "ok";
  await watch.poll(); // the same change is retried
  assert.equal(calls, 2);
  await watch.poll();
  assert.equal(calls, 2, "and now the baseline has moved");
});

test("watch: polls never overlap", async () => {
  let value = "a";
  let fpCalls = 0;
  let calls = 0;
  const watch = createProviderChangeWatch({
    fingerprintFn: async () => {
      fpCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return value;
    },
    onChange: () => { calls++; },
  });

  await watch.poll(); // baseline
  assert.equal(fpCalls, 1);

  value = "b";
  const first = watch.poll();
  const second = watch.poll(); // in flight → returns at once
  await Promise.all([first, second]);
  assert.equal(calls, 1, "one change, one call, even with overlapping ticks");
  assert.equal(fpCalls, 2, "the overlapping poll never ran a second query");
});

test("watch: start() arms the injected interval and stop() clears it", () => {
  const armed = [];
  const cleared = [];
  const handle = { unrefed: false, unref() { this.unrefed = true; } };
  const watch = createProviderChangeWatch({
    fingerprintFn: async () => "a",
    onChange: () => {},
    intervalMs: 4321,
    setIntervalFn: (fn, ms) => { armed.push({ fn, ms }); return handle; },
    clearIntervalFn: (h) => { cleared.push(h); },
  });

  watch.start();
  assert.equal(armed.length, 1);
  assert.equal(armed[0].ms, 4321);
  assert.equal(typeof armed[0].fn, "function");
  assert.equal(handle.unrefed, true, "the timer never holds the process open");

  watch.start(); // idempotent: no second timer
  assert.equal(armed.length, 1);

  watch.stop();
  assert.deepEqual(cleared, [handle]);
  watch.stop();
  assert.equal(cleared.length, 1);

  watch.start(); // re-arms after a stop
  assert.equal(armed.length, 2);
  watch.stop();
});

// ------------------------------------------- out-of-process reproduction

test("a row written with no change hook reaches pi's models.json after one poll", async () => {
  const fx = freshDb();
  const scratch = mkdtempSync(join(tmpdir(), "provider-watch-pi-"));
  try {
    const target = join(scratch, "models.json");
    let onChangeFired = 0;
    const watch = createProviderChangeWatch({
      fingerprintFn: () => providersFingerprint(fx.db),
      onChange: async () => {
        onChangeFired++;
        await syncPiModelsJson(fx.db, { path: target, doorBase: null, cloudAllow: [] });
      },
    });

    await watch.poll(); // baseline: the table is empty, so is models.json
    assert.equal(onChangeFired, 0);

    // The writer is outside the gateway process: no change hook is set for it.
    await upsertProvider(fx.db, ROW);
    await watch.poll();

    assert.equal(onChangeFired, 1);
    const written = JSON.parse(readFileSync(target, "utf8"));
    assert.ok(written.providers[ROW.id], "the new row is now a managed entry in pi's models.json");
    assert.equal(written.providers[ROW.id].baseUrl, ROW.baseUrl);
    assert.deepEqual(written.providers[ROW.id].models, [{ id: "m" }]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    fx.cleanup();
  }
});