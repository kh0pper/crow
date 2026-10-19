/**
 * Legacy native provider rows (queue item 33, part 2).
 *
 * Rows registered before the catalog/port fields existed carry a gpu_policy
 * of only `{ runtime: "native", mutexGroup }`. The Model Catalog offers Edit
 * only for rows whose `catalogId` resolves (`registered-rows.js` inCatalog),
 * so such a row had no Edit and no repair path. The boot upgrade fills the
 * missing keys from the catalog, the base_url and the local registry — for
 * this instance's own rows only, never overwriting a key, idempotently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planLegacyRowUpgrades, applyLegacyRowUpgrades } from "../servers/gateway/models/legacy-row-upgrade.js";
import { registeredSnapshot } from "../servers/gateway/models/registered-rows.js";

const OWN = "a".repeat(32);
const PEER = "b".repeat(32);

const catalog = {
  models: [
    { id: "small-chat", task: "chat", quants: [{ quant: "Q4_K_M" }, { quant: "Q8_0" }] },
    { id: "embedder", task: "embed", quants: [{ quant: "Q8_0" }] },
  ],
};

// The exact shape of the 2026-10-16 row: legacy policy, loopback base_url,
// last written by this instance.
function legacyRow(over = {}) {
  return {
    id: "small-chat",
    baseUrl: "http://127.0.0.1:18100/v1",
    apiKey: null,
    host: "local",
    bundleId: null,
    provider_type: "openai-compat",
    description: null,
    models: [{ id: "small-chat", task: "chat", contextLen: 32768 }],
    gpuPolicy: { runtime: "native", mutexGroup: "local-llm" },
    disabled: false,
    lamport_ts: 1,
    instance_id: OWN,
    ...over,
  };
}

const state = { reservations: {}, journal: {}, registry: { "small-chat@Q4_K_M": { catalogId: "small-chat", quant: "Q4_K_M", file: "x.gguf" } } };

test("the prod-shape legacy row gets catalogId, port, quant and owner — and nothing else changes", () => {
  const plans = planLegacyRowUpgrades({ rows: [legacyRow()], catalog, state, ownInstanceId: OWN });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, "small-chat");
  assert.deepEqual(plans[0].gpuPolicy, {
    runtime: "native", mutexGroup: "local-llm",
    catalogId: "small-chat", port: 18100, quant: "Q4_K_M", owner: OWN,
  });
  assert.deepEqual(plans[0].filled.sort(), ["catalogId", "owner", "port", "quant"]);
});

test("a row last written by another instance is never planned", () => {
  assert.deepEqual(planLegacyRowUpgrades({ rows: [legacyRow({ instance_id: PEER })], catalog, state, ownInstanceId: OWN }), []);
});

test("a row whose gpu_policy names another owner is never planned, even if we wrote it last", () => {
  const row = legacyRow({ gpuPolicy: { runtime: "native", owner: PEER } });
  assert.deepEqual(planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN }), []);
});

test("a row with no owner evidence at all is skipped", () => {
  assert.deepEqual(planLegacyRowUpgrades({ rows: [legacyRow({ instance_id: null })], catalog, state, ownInstanceId: OWN }), []);
  assert.deepEqual(planLegacyRowUpgrades({ rows: [legacyRow()], catalog, state, ownInstanceId: null }), []);
});

test("an explicit own owner qualifies even when another instance relayed the row last", () => {
  const row = legacyRow({ instance_id: PEER, gpuPolicy: { runtime: "native", owner: OWN } });
  const plans = planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].filled.sort(), ["catalogId", "port", "quant"]);
});

test("existing keys are never overwritten", () => {
  const row = legacyRow({ gpuPolicy: { runtime: "native", catalogId: "small-chat", quant: "Q8_0" } });
  const [p] = planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN });
  assert.equal(p.gpuPolicy.quant, "Q8_0", "a recorded quant stays");
  assert.equal(p.gpuPolicy.port, 18100);
  assert.deepEqual(p.filled.sort(), ["owner", "port"]);
});

test("a complete row plans nothing (idempotent)", () => {
  const row = legacyRow({ gpuPolicy: { runtime: "native", catalogId: "small-chat", quant: "Q4_K_M", port: 18100, owner: OWN } });
  assert.deepEqual(planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN }), []);
});

test("non-candidates: not native, disabled, bundle rows, external engines", () => {
  const rows = [
    legacyRow({ id: "a", gpuPolicy: null }),
    legacyRow({ id: "b", disabled: true }),
    legacyRow({ id: "c", bundleId: "some-bundle" }),
    legacyRow({ id: "d", gpuPolicy: { runtime: "native", engine: { managed: "external" } } }),
  ];
  assert.deepEqual(planLegacyRowUpgrades({ rows, catalog, state, ownInstanceId: OWN }), []);
});

test("all or nothing: a row without a loopback base_url and valid port is never touched", () => {
  for (const baseUrl of ["http://127.0.0.1:3001/llm/p/small-chat/v1", "http://100.64.20.5:18100/v1", "http://10.0.0.9:18100/v1", "http://127.0.0.1/v1", "not a url", "http://127.0.0.1:80/v1", "https://127.0.0.1:18100/v1"]) {
    assert.deepEqual(planLegacyRowUpgrades({ rows: [legacyRow({ baseUrl })], catalog, state, ownInstanceId: OWN }), [], baseUrl);
  }
  for (const [baseUrl, port] of [["http://localhost:18105/v1", 18105], ["http://[::1]:18107/v1", 18107]]) {
    const [p] = planLegacyRowUpgrades({ rows: [legacyRow({ baseUrl })], catalog, state, ownInstanceId: OWN });
    assert.equal(p.gpuPolicy.port, port, baseUrl);
  }
});

test("a LAN-address legacy row keeps working: no owner is written without a port", async () => {
  const row = legacyRow({ baseUrl: "http://10.0.0.9:18100/v1" });
  assert.deepEqual(planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN }), []);
});

test("a recorded port that disagrees with the base_url is left alone", () => {
  const row = legacyRow({ gpuPolicy: { runtime: "native", port: 18111 } });
  assert.deepEqual(planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN }), []);
});

test("catalogId needs exactly one catalog model the row actually serves", () => {
  const none = legacyRow({ models: [{ id: "unknown-model" }] });
  const [p1] = planLegacyRowUpgrades({ rows: [none], catalog, state, ownInstanceId: OWN });
  assert.equal(p1?.gpuPolicy.catalogId, undefined, "no catalog match → no catalogId");
  const two = legacyRow({ models: [{ id: "small-chat" }, { id: "embedder" }] });
  const [p2] = planLegacyRowUpgrades({ rows: [two], catalog, state, ownInstanceId: OWN });
  assert.equal(p2?.gpuPolicy.catalogId, undefined, "ambiguous → no catalogId");
});

test("quant only when exactly one registry entry has that catalogId", () => {
  const twoQuants = { ...state, registry: { ...state.registry, "small-chat@Q8_0": { catalogId: "small-chat", quant: "Q8_0" } } };
  const [p] = planLegacyRowUpgrades({ rows: [legacyRow()], catalog, state: twoQuants, ownInstanceId: OWN });
  assert.equal(p.gpuPolicy.quant, undefined);
  assert.equal(p.gpuPolicy.catalogId, "small-chat");
  const [q] = planLegacyRowUpgrades({ rows: [legacyRow()], catalog, state: { registry: {} }, ownInstanceId: OWN });
  assert.equal(q.gpuPolicy.quant, undefined);
});

test("a row with a port and no catalog match gains nothing and is not written", () => {
  const row = legacyRow({ models: [{ id: "unknown-model" }], gpuPolicy: { runtime: "native", port: 18100 } });
  assert.deepEqual(planLegacyRowUpgrades({ rows: [row], catalog, state, ownInstanceId: OWN }), []);
});

function fakeDb(rows) {
  return { rows };
}

test("apply: upserts the full row with the merged policy once; a second run upserts nothing", async () => {
  const rows = [legacyRow(), legacyRow({ id: "peer-row", instance_id: PEER })];
  const upserts = [];
  const deps = {
    db: fakeDb(rows),
    listProvidersAllFn: async (db) => db.rows.map((r) => ({ ...r, gpuPolicy: r.gpuPolicy ? { ...r.gpuPolicy } : null })),
    upsertProviderFn: async (db, p) => {
      upserts.push(p);
      const i = db.rows.findIndex((r) => r.id === p.id);
      db.rows[i] = { ...db.rows[i], gpuPolicy: p.gpuPolicy, instance_id: OWN };
      return { id: p.id, lamport_ts: 2 };
    },
    catalog, state, ownInstanceId: OWN, log: () => {},
  };
  const first = await applyLegacyRowUpgrades(deps);
  assert.deepEqual(first.map((u) => u.id), ["small-chat"]);
  assert.equal(upserts.length, 1);
  const u = upserts[0];
  assert.equal(u.baseUrl, "http://127.0.0.1:18100/v1", "base_url unchanged");
  assert.deepEqual(u.models, legacyRow().models, "models unchanged");
  assert.equal(u.host, "local");
  assert.equal(u.providerType, "openai-compat");
  assert.equal(u.disabled, false);
  assert.equal(u.gpuPolicy.mutexGroup, "local-llm");
  const second = await applyLegacyRowUpgrades(deps);
  assert.deepEqual(second, []);
  assert.equal(upserts.length, 1, "idempotent: no second write");
  assert.equal(rows.find((r) => r.id === "peer-row").gpuPolicy.catalogId, undefined, "peer row untouched");
});

test("apply never throws: a failing upsert is logged and the rest continue", async () => {
  const rows = [legacyRow({ id: "small-chat" }), legacyRow({ id: "embed-row", models: [{ id: "embedder" }], baseUrl: "http://127.0.0.1:18101/v1", gpuPolicy: { runtime: "native" } })];
  const logs = [];
  const out = await applyLegacyRowUpgrades({
    db: fakeDb(rows),
    listProvidersAllFn: async (db) => db.rows,
    upsertProviderFn: async (db, p) => { if (p.id === "small-chat") throw new Error("disk full"); return { id: p.id }; },
    catalog, state, ownInstanceId: OWN, log: (m) => logs.push(m),
  });
  assert.deepEqual(out.map((u) => u.id), ["embed-row"]);
  assert.ok(logs.some((l) => /small-chat.*disk full/.test(l)), logs.join("\n"));
});

test("after the upgrade the Model Catalog row is in-catalog (Edit is offered)", () => {
  const snap = (gp) => registeredSnapshot({
    core: {
      providers: () => ({ "small-chat": { gpuPolicy: gp } }),
      listing: () => [{ provider: "small-chat", managed: "native", status: "stopped", mutexGroup: "local-llm" }],
    },
    catalog, orchestrationDisabled: false, env: {},
  }).rows[0];
  assert.equal(snap(legacyRow().gpuPolicy).inCatalog, false, "before: no Edit");
  const [p] = planLegacyRowUpgrades({ rows: [legacyRow()], catalog, state, ownInstanceId: OWN });
  assert.equal(snap(p.gpuPolicy).inCatalog, true, "after: Edit");
});

test("end to end: an upgraded legacy row can be Edited (re-registered) and keeps its port", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createDbClient } = await import("../servers/db.js");
  const { listProvidersAll, upsertProvider } = await import("../servers/shared/providers-db.js");
  const { registerModel } = await import("../servers/gateway/models/manager.js");
  const { loadState, saveState } = await import("../servers/gateway/models/state.js");

  const dir = mkdtempSync(join(tmpdir(), "legacy-edit-"));
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createDbClient(join(dir, "crow.db"));
  try {
    const own = "c".repeat(32);
    await db.execute({
      sql: `INSERT INTO providers (id, base_url, host, models, disabled, lamport_ts, instance_id, provider_type, gpu_policy)
            VALUES (?, ?, 'local', ?, 0, 1, ?, 'openai-compat', ?)`,
      args: ["small-chat", "http://127.0.0.1:18100/v1", JSON.stringify([{ id: "small-chat", task: "chat", contextLen: 8192 }]), own,
        JSON.stringify({ runtime: "native", mutexGroup: "local-llm" })],
    });
    const fullCatalog = {
      version: 1,
      runtime: { name: "llama.cpp", release: "b10068", assets: {} },
      models: [{
        id: "small-chat", family: "Small", lab: "Lab", hf_repo: "t/small-chat-GGUF", license: "apache-2.0", gated: false,
        task: "chat", context_len: 8192, min_runtime_version: "b10068", default_quant: "Q4_K_M", tags: ["chat"],
        quants: [{ file: "small-chat-Q4_K_M.gguf", quant: "Q4_K_M", size_mb: 1, min_ram_mb: 1, min_vram_mb: 0, sha256: "abc" }],
      }],
    };
    const st = { reservations: {}, journal: {}, registry: { "small-chat@Q4_K_M": { catalogId: "small-chat", quant: "Q4_K_M", file: "small-chat-Q4_K_M.gguf" } }, conversions: {} };
    saveState(dir, st);

    const done = await applyLegacyRowUpgrades({ db, listProvidersAllFn: listProvidersAll, upsertProviderFn: upsertProvider, catalog: fullCatalog, state: loadState(dir), ownInstanceId: own, log: () => {} });
    assert.deepEqual(done.map((d) => d.id), ["small-chat"]);
    const again = await applyLegacyRowUpgrades({ db, listProvidersAllFn: listProvidersAll, upsertProviderFn: upsertProvider, catalog: fullCatalog, state: loadState(dir), ownInstanceId: own, log: () => {} });
    assert.deepEqual(again, [], "second boot: nothing to do");

    const res = await registerModel({
      modelId: "small-chat", quant: "Q4_K_M", providerId: "small-chat", catalog: fullCatalog, db, dir,
      mutexGroup: "local-llm", keepAdoptedFiles: true,
      ownInstanceIdFn: () => own, tailnetIpFn: () => null, gatewayPortFn: () => 3001,
      allocatePortFn: async () => { throw new Error("Edit must reuse the recorded port, not allocate"); },
      invalidateCacheFn: async () => {},
    });
    assert.equal(res.port, 18100, "Edit kept the legacy port");
    assert.equal(loadState(dir).reservations["small-chat"].port, 18100, "and re-recorded its reservation");
  } finally {
    try { db.close(); } catch {}
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
