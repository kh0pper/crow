/**
 * providers-reconcile-gate — D1/D5/R2-C1 of the providers-sync volatile-models
 * spec (.superpowers/sdd/providers-volatile-spec.md).
 *
 * D1: syncProvidersFromModelsJson is single-writer by endpoint ownership —
 * only the instance whose addresses match an entry's baseUrl asserts that
 * entry over an existing DB row; absent rows are seeded by anyone; unowned
 * present rows are sync-authoritative and skipped (counted skipped_unowned).
 * Force flips unowned+disabled rows back to enabled WITHOUT asserting file
 * content (reenableProviderPreservingContent — parsed shape round-trip, no
 * models double-encode, R2-M2).
 *
 * Coverage strategy (Item 4 PR1: models.json search paths are redirected
 * per-process via the CROW_MODELS_JSON seam — see
 * servers/shared/models-json-paths.js — so this file is HERMETIC: it never
 * reads the host's real models.json, which the repo no longer ships, and it
 * never writes the live config/models.json or ~/.pi/agent/models.json):
 *   1. reconcileDecision — exported pure decision table, exhaustive matrix.
 *   2. reenableProviderPreservingContent — direct row insert + round-trip
 *      double-encode proof.
 *   3. syncProvidersFromModelsJson with injectable ownAddrs against a
 *      FIXTURE models.json written into the per-test tmp dir.
 *   4. reconcileIntervalMs env-override parsing (D5).
 *
 * Harness: freshLibsql() pattern from providers-upsert-noop.test.js —
 * CROW_DATA_DIR is pointed at a per-test tmp dir BEFORE any upsert so
 * getOrCreateLocalInstanceId() never touches the real ~/.crow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcileDecision,
  reenableProviderPreservingContent,
  syncProvidersFromModelsJson,
  setProviderSyncManager,
} from "../servers/shared/providers-db.js";
import { reconcileIntervalMs } from "../servers/gateway/boot/admin-api.js";

// Hermetic models.json fixture: two loopback entries (co-owned by every
// instance) and three tailnet entries across two IPs, so "claim one IP"
// moves exactly its entries out of skipped_unowned while another IP's entry
// stays unowned. Written into each test's tmp dir and pointed at via the
// CROW_MODELS_JSON seam — the host's real files are never read or written.
const FIXTURE_PROVIDERS = {
  "fx-loop-a": { baseUrl: "http://localhost:8011/v1", models: [{ id: "m-a" }] },
  "fx-loop-b": { baseUrl: "http://127.0.0.1:8003/v1", models: [{ id: "m-b" }] },
  "fx-tail-a": { baseUrl: "http://100.77.0.1:8011/v1", models: [{ id: "m-c" }] },
  "fx-tail-b": { baseUrl: "http://100.77.0.1:8003/v1", models: [{ id: "m-d" }] },
  "fx-tail-c": { baseUrl: "http://100.77.0.2:9100/v1", models: [{ id: "m-e" }] },
};

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "providers-reconcile-gate-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const fixturePath = join(dir, "models.fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ providers: FIXTURE_PROVIDERS }));
  const prevDataDir = process.env.CROW_DATA_DIR;
  const prevModelsJson = process.env.CROW_MODELS_JSON;
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = fixturePath;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir, db,
    cleanup() {
      setProviderSyncManager(null);
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      if (prevModelsJson === undefined) delete process.env.CROW_MODELS_JSON;
      else process.env.CROW_MODELS_JSON = prevModelsJson;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function spySyncManager() {
  const calls = [];
  setProviderSyncManager({ emitChange: async (...a) => { calls.push(a); } });
  return calls;
}

// Expectations derive from the same fixture the seam feeds the reconciler —
// deterministic, host-independent.
function mergedModelsJsonEntries() {
  return Object.entries(FIXTURE_PROVIDERS).filter(([id]) => !id.startsWith("$"));
}

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
function hostnameOf(baseUrl) {
  try { return new URL(baseUrl).hostname.replace(/^\[|\]$/g, ""); } catch { return null; }
}

// --- 1. reconcileDecision: exhaustive matrix ---------------------------------

const MATRIX = [
  // [owned, present, disabled, force] → expected
  // Absent rows always seed (any instance may insert; cloud rows seed-once).
  [false, false, false, false, "seed"],
  [false, false, false, true,  "seed"],
  [false, false, true,  false, "seed"], // disabled is meaningless when absent
  [false, false, true,  true,  "seed"],
  [true,  false, false, false, "seed"],
  [true,  false, false, true,  "seed"],
  [true,  false, true,  false, "seed"],
  [true,  false, true,  true,  "seed"],
  // Owned + enabled → assert regardless of force (D2 makes converged a no-op).
  [true,  true,  false, false, "assert"],
  [true,  true,  false, true,  "assert"],
  // Owned + disabled → today's semantics: skip unless force (full re-assert).
  [true,  true,  true,  false, "skip_disabled"],
  [true,  true,  true,  true,  "assert"],
  // Unowned + enabled → DB/sync authoritative. Force does NOT override (R-Q1).
  [false, true,  false, false, "skip_unowned"],
  [false, true,  false, true,  "skip_unowned"],
  // Unowned + disabled → skip; force flips enabled WITHOUT asserting content.
  [false, true,  true,  false, "skip_disabled"],
  [false, true,  true,  true,  "reenable"],
];

test("reconcileDecision: exhaustive owned×present×disabled×force matrix", () => {
  for (const [owned, present, disabled, force, expected] of MATRIX) {
    assert.equal(
      reconcileDecision({ owned, present, disabled, force }),
      expected,
      `owned=${owned} present=${present} disabled=${disabled} force=${force}`,
    );
  }
  // Sanity: the matrix really is the full 2^4 space.
  assert.equal(MATRIX.length, 16);
});

// --- 2. reenableProviderPreservingContent: no double-encode (R2-M2) ----------

const REENABLE_ID = "reenable-gate-test";
const REENABLE_MODELS = [
  {
    id: "m1",
    name: "Model One",
    contextWindow: 262144,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0 },
  },
  { id: "m2", name: "Model Two", contextWindow: 8192 },
];

async function insertDisabledUnownedRow(db) {
  await db.execute({
    sql: `INSERT INTO providers
          (id, base_url, api_key, host, bundle_id, description, models, disabled, lamport_ts, instance_id, provider_type, gpu_policy)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 5, 'peer-instance', ?, ?)`,
    args: [
      REENABLE_ID,
      "http://203.0.113.9:9999/v1", // TEST-NET-3: owned by nobody
      null, "local", "some-bundle", "unowned disabled row",
      JSON.stringify(REENABLE_MODELS),
      "openai-compat",
      JSON.stringify({ mutexGroup: "peer-vram", alwaysResident: false, defaultMember: true }),
    ],
  });
}

test("reenableProviderPreservingContent: flips disabled→0, models survives as an ARRAY (no double-encode), content preserved, re-enable emits", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    await insertDisabledUnownedRow(db);

    const res = await reenableProviderPreservingContent(db, REENABLE_ID);
    assert.ok(res, "returns the upsert result");
    assert.notEqual(res.unchanged, true, "disabled flip is a real change");
    assert.equal(calls.length, 1, "re-enable propagates to peers (one emit)");

    const { rows } = await db.execute({
      sql: "SELECT * FROM providers WHERE id = ?", args: [REENABLE_ID],
    });
    const row = rows[0];
    assert.equal(Number(row.disabled), 0, "row re-enabled");

    // R2-M2 double-encode proof: one JSON.parse must yield the original
    // ARRAY. A raw SELECT* spread would have stored a JSON string OF a
    // string — the first parse would yield a string and a second parse
    // would succeed. Here the second parse must THROW.
    const parsed = JSON.parse(row.models);
    assert.ok(Array.isArray(parsed), "models parses to an array on the FIRST parse");
    assert.deepEqual(parsed, REENABLE_MODELS, "DB content preserved exactly (not asserted from file)");
    assert.throws(() => JSON.parse(parsed), "second parse throws — proves models was not double-encoded");

    // Other content preserved (never asserted from models.json).
    assert.equal(row.base_url, "http://203.0.113.9:9999/v1");
    assert.equal(row.description, "unowned disabled row");
    assert.deepEqual(JSON.parse(row.gpu_policy), { mutexGroup: "peer-vram", alwaysResident: false, defaultMember: true });
  } finally { cleanup(); }
});

test("reenableProviderPreservingContent: unknown id returns null, no write, no emit", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const calls = spySyncManager();
    const res = await reenableProviderPreservingContent(db, "does-not-exist");
    assert.equal(res, null);
    assert.equal(calls.length, 0);
  } finally { cleanup(); }
});

// --- 3. syncProvidersFromModelsJson: injectable ownAddrs against real files --

test("ownership gate end-to-end: seed-all → loopback-only skips unowned → adding a tailnet IP claims its entries", async () => {
  const entries = mergedModelsJsonEntries();
  assert.ok(entries.length > 0, "fixture sanity: at least one entry");

  const loopbackOnly = new Set(LOOPBACK);
  const loopbackIds = entries.filter(([, p]) => loopbackOnly.has(hostnameOf(p.baseUrl))).map(([id]) => id);
  const nonLoopback = entries.filter(([, p]) => {
    const h = hostnameOf(p.baseUrl);
    return h !== null && !loopbackOnly.has(h);
  });
  assert.ok(nonLoopback.length > 0, "fixture sanity: tailnet-addressed entries present");

  const { db, cleanup } = freshLibsql();
  try {
    setProviderSyncManager(null);

    // Call 1: fresh DB, loopback-only ownAddrs → every entry is ABSENT →
    // seed path regardless of ownership.
    const first = await syncProvidersFromModelsJson(db, { ownAddrs: new Set(LOOPBACK) });
    assert.equal(first.upserted, entries.length, "all entries seed on an empty DB");
    assert.equal(first.skipped_unowned, 0, "absence beats ownership");
    assert.equal(first.unchanged, 0);
    assert.equal(first.reenabled, 0);
    assert.equal(first.skipped_disabled, 0);

    // Snapshot an unowned row's lamport so we can prove call 2 didn't touch it.
    const probeId = nonLoopback[0][0];
    const lamportOf = async (id) => Number(
      (await db.execute({ sql: "SELECT lamport_ts FROM providers WHERE id = ?", args: [id] })).rows[0].lamport_ts,
    );
    const probeTsAfterSeed = await lamportOf(probeId);

    // Call 2: same loopback-only ownAddrs, rows now PRESENT → non-loopback
    // entries are unowned and skipped; loopback entries are co-owned →
    // evaluated as assert, converged content → D2 unchanged.
    const second = await syncProvidersFromModelsJson(db, { ownAddrs: new Set(LOOPBACK) });
    assert.equal(second.skipped_unowned, entries.length - loopbackIds.length,
      "every non-loopback entry counted skipped_unowned");
    assert.equal(second.unchanged, loopbackIds.length,
      "loopback entries evaluated as owned, converged → unchanged");
    assert.equal(second.upserted, 0, "converged run writes nothing");
    assert.equal(await lamportOf(probeId), probeTsAfterSeed, "unowned row untouched (no lamport bump)");

    // Call 3: claim one tailnet IP. Its entries flip from skipped_unowned to
    // owned+unchanged — observable ONLY via the counters (content identical,
    // D2 suppresses writes), which is exactly what makes the counter
    // semantics testable.
    const claimedIp = hostnameOf(nonLoopback[0][1].baseUrl);
    const claimedCount = nonLoopback.filter(([, p]) => hostnameOf(p.baseUrl) === claimedIp).length;
    const third = await syncProvidersFromModelsJson(db, {
      ownAddrs: new Set([...LOOPBACK, claimedIp]),
    });
    assert.equal(third.skipped_unowned, entries.length - loopbackIds.length - claimedCount,
      `claiming ${claimedIp} removes its ${claimedCount} entries from skipped_unowned`);
    assert.equal(third.unchanged, loopbackIds.length + claimedCount,
      "claimed entries evaluated as owned (unchanged, content converged)");
    assert.equal(third.upserted, 0);
  } finally { cleanup(); }
});

test("force + unowned + disabled: real reconciler run re-enables without asserting file content is required only when ids collide with models.json — direct-insert ids never assert", async () => {
  // An id NOT in models.json is never visited by the reconciler at all —
  // prove the gate leaves foreign rows completely alone under force.
  const { db, cleanup } = freshLibsql();
  try {
    setProviderSyncManager(null);
    await insertDisabledUnownedRow(db); // id not present in any models.json
    const res = await syncProvidersFromModelsJson(db, { force: true, ownAddrs: new Set(LOOPBACK) });
    assert.equal(res.reenabled, 0, "rows absent from models.json are never touched");
    const { rows } = await db.execute({
      sql: "SELECT disabled FROM providers WHERE id = ?", args: [REENABLE_ID],
    });
    assert.equal(Number(rows[0].disabled), 1, "foreign disabled row stays disabled");
  } finally { cleanup(); }
});

// --- 4. D5: RECONCILE interval env override ----------------------------------

test("reconcileIntervalMs: default 1h, env override parses, garbage/zero/negative fall back", () => {
  assert.equal(reconcileIntervalMs({}), 3600_000);
  assert.equal(reconcileIntervalMs({ CROW_PROVIDERS_RECONCILE_MS: "60000" }), 60000);
  assert.equal(reconcileIntervalMs({ CROW_PROVIDERS_RECONCILE_MS: "banana" }), 3600_000);
  assert.equal(reconcileIntervalMs({ CROW_PROVIDERS_RECONCILE_MS: "0" }), 3600_000);
  assert.equal(reconcileIntervalMs({ CROW_PROVIDERS_RECONCILE_MS: "-5" }), 3600_000);
});
