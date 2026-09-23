import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  seedProvidersFromModelsJson, syncProvidersFromModelsJson, upsertProvider, setProviderSyncManager,
} from "../servers/shared/providers-db.js";

const FIXTURE = {
  "fx-cloud": { baseUrl: "https://api.together.xyz/v1", models: [{ id: "a" }] },
  "fx-raven": { baseUrl: "http://10.255.254.10:8030/v1", models: [{ id: "b" }] },
  "fx-loop":  { baseUrl: "http://127.0.0.1:8003/v1", models: [{ id: "c" }] },
  "fx-tail":  { baseUrl: "http://100.100.254.10:9100/v1", models: [{ id: "d" }] },
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "providers-host-inference-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_MODELS_JSON: "" },
    stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const fixturePath = join(dir, "models.fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ providers: FIXTURE }));
  const prev = { d: process.env.CROW_DATA_DIR, m: process.env.CROW_MODELS_JSON };
  process.env.CROW_DATA_DIR = dir;
  process.env.CROW_MODELS_JSON = fixturePath;
  setProviderSyncManager(null);
  const db = createDbClient(join(dir, "crow.db"));
  return {
    db,
    cleanup() {
      if (prev.d === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev.d;
      if (prev.m === undefined) delete process.env.CROW_MODELS_JSON; else process.env.CROW_MODELS_JSON = prev.m;
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function hosts(db) {
  const { rows } = await db.execute("SELECT id, host FROM providers ORDER BY id");
  return Object.fromEntries(rows.map((r) => [r.id, r.host]));
}

test("first-boot seed infers host instead of blanket 'local'", async () => {
  const t = fresh();
  try {
    await seedProvidersFromModelsJson(t.db);
    const h = await hosts(t.db);
    assert.equal(h["fx-cloud"], "cloud");
    assert.equal(h["fx-raven"], "cloud");
    assert.equal(h["fx-loop"], "local");
    assert.equal(h["fx-tail"], "cloud"); // no lab box owns this tailnet-style address
  } finally { t.cleanup(); }
});

test("reconciler seed of an absent id: foreign → cloud, own → local", async () => {
  const t = fresh();
  try {
    const ownAddrs = new Set(["localhost", "127.0.0.1", "::1", "100.100.254.10"]);
    await syncProvidersFromModelsJson(t.db, { ownAddrs });
    const h = await hosts(t.db);
    assert.equal(h["fx-raven"], "cloud");
    assert.equal(h["fx-cloud"], "cloud");
    assert.equal(h["fx-loop"], "local");
    assert.equal(h["fx-tail"], "local");
  } finally { t.cleanup(); }
});

test("upsertProvider without a host infers it; an explicit host is kept", async () => {
  const t = fresh();
  try {
    await upsertProvider(t.db, { id: "u-raven", baseUrl: "http://10.255.254.10:8030/v1", models: [] });
    await upsertProvider(t.db, { id: "u-loop", baseUrl: "http://127.0.0.1:9/v1", models: [] });
    await upsertProvider(t.db, { id: "u-explicit", baseUrl: "http://10.255.254.10:8030/v1", host: "local", models: [] });
    const h = await hosts(t.db);
    assert.equal(h["u-raven"], "cloud");
    assert.equal(h["u-loop"], "local");
    assert.equal(h["u-explicit"], "local");
  } finally { t.cleanup(); }
});

test("the HF-token row writer uses a valid host value", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/routes/models.js"), "utf8");
  assert.equal(/host:\s*"external"/.test(src), false, 'routes/models.js must not write host:"external"');
});
