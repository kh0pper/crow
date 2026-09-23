import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { repairProviderHosts, syncProvidersFromModelsJson, setProviderSyncManager } from "../servers/shared/providers-db.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";

const PEER = "49cf71ca878643ba7717f344329266fd";
const CROW = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237", "100.118.41.122"]);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "providers-host-repair-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const prev = { d: process.env.CROW_DATA_DIR, m: process.env.CROW_MODELS_JSON };
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = "";
  const own = getOrCreateLocalInstanceId(); // creates <dir>/instance-id
  const calls = [];
  setProviderSyncManager({ feedsDisabled: false, emitChange: async (...a) => { calls.push(a); } });
  const db = createDbClient(join(dir, "crow.db"));
  return {
    db, own, calls,
    cleanup() {
      setProviderSyncManager(null);
      if (prev.d === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev.d;
      if (prev.m === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prev.m;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function insert(db, id, host, baseUrl, instanceId, { bundleId = null, disabled = 0, gpuPolicy = null } = {}) {
  await db.execute({
    sql: `INSERT INTO providers (id, base_url, host, bundle_id, models, disabled, lamport_ts, instance_id, gpu_policy)
          VALUES (?, ?, ?, ?, '[]', ?, 10, ?, ?)`,
    args: [id, baseUrl, host, bundleId, disabled, instanceId, gpuPolicy ? JSON.stringify(gpuPolicy) : null],
  });
}
async function get(db, id) {
  const { rows } = await db.execute({ sql: "SELECT host, lamport_ts FROM providers WHERE id = ?", args: [id] });
  return rows[0];
}

test("repairs exactly this instance's in-scope bad writes, nothing else; idempotent", async () => {
  const t = fresh();
  try {
    await insert(t.db, "raven-halogen-smoke", "local", "http://10.0.0.126:8731/v1", t.own);
    await insert(t.db, "raven-flash-next", "raven", "http://10.0.0.126:8030/v1", t.own);
    await insert(t.db, "peer-wrote-local", "local", "http://10.0.0.126:9999/v1", PEER);
    await insert(t.db, "own-addr-local", "local", "http://100.118.41.122:8003/v1", t.own);
    await insert(t.db, "dns-local", "local", "https://api.z.ai/v4", t.own);
    await insert(t.db, "cloud-ok", "cloud", "https://api.together.xyz/v1", t.own);
    await insert(t.db, "bundle-foreign", "local", "http://10.0.0.126:7000/v1", t.own, { bundleId: "b" });
    await insert(t.db, "disabled-foreign", "local", "http://10.0.0.126:7001/v1", t.own, { disabled: 1 });
    await insert(t.db, "hf-token", "external", "https://huggingface.co", t.own, { disabled: 1, gpuPolicy: { local_only: true } });

    const res = await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: CROW });
    assert.deepEqual(res.changes.map((c) => c.id).sort(), ["raven-flash-next", "raven-halogen-smoke"]);
    for (const id of ["raven-halogen-smoke", "raven-flash-next"]) assert.equal((await get(t.db, id)).host, "cloud");
    for (const [id, h] of [["peer-wrote-local", "local"], ["own-addr-local", "local"], ["dns-local", "local"],
                           ["bundle-foreign", "local"], ["disabled-foreign", "local"], ["hf-token", "external"]]) {
      assert.equal((await get(t.db, id)).host, h, id);
    }
    assert.equal(t.calls.length, 2, "exactly two sync emits");

    const lamport = (await get(t.db, "raven-flash-next")).lamport_ts;
    const res2 = await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: CROW });
    assert.equal(res2.repaired, 0);
    assert.equal(t.calls.length, 2);
    assert.equal((await get(t.db, "raven-flash-next")).lamport_ts, lamport);
  } finally { t.cleanup(); }
});

test("G1 boot race: no CGNAT own address → 100.x rows untouched; loopback-only → nothing", async () => {
  const t = fresh();
  try {
    await insert(t.db, "tail-local", "local", "http://100.99.0.1:8003/v1", t.own);
    await insert(t.db, "tail-invalid", "raven", "http://100.99.0.2:8003/v1", t.own);
    const noTs = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]);
    assert.equal((await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: noTs })).repaired, 0);
    const loop = new Set(["localhost", "127.0.0.1", "::1"]);
    assert.equal((await repairProviderHosts(t.db, { ownInstanceId: t.own, ownAddrs: loop })).repaired, 0);
    assert.equal((await get(t.db, "tail-local")).host, "local");
    assert.equal((await get(t.db, "tail-invalid")).host, "raven");
  } finally { t.cleanup(); }
});

test("syncProvidersFromModelsJson runs the repair even with no models.json, and reports it", async () => {
  const t = fresh();
  try {
    await insert(t.db, "raven-flash-next", "raven", "http://10.0.0.126:8030/v1", t.own);
    const res = await syncProvidersFromModelsJson(t.db, { ownAddrs: CROW });
    assert.equal(res.repaired, 1);
    assert.equal((await get(t.db, "raven-flash-next")).host, "cloud");
  } finally { t.cleanup(); }
});
