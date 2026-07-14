/**
 * models-json-seam — spec §2.1 (Item 4 PR1, F-N1 fold): the models.json
 * search paths must be overridable via CROW_MODELS_JSON so tests and
 * fresh-install audits can run hermetically — an empty override means "no
 * models.json anywhere" (fresh-install simulation), a path list means "read
 * exactly these". Both readers (providers-db.js seed/sync and providers.js
 * runtime loader) must honor it at CALL time, not module-load time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";

import { modelsJsonSearchPaths } from "../servers/shared/models-json-paths.js";
import { seedProvidersFromModelsJson } from "../servers/shared/providers-db.js";

const REPO = resolve(import.meta.dirname, "..");

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    });
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "models-json-seam-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  const prevDataDir = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
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

test("CROW_MODELS_JSON='' means NO search paths (fresh-install simulation)", async () => {
  await withEnv("CROW_MODELS_JSON", "", () => {
    assert.deepEqual(modelsJsonSearchPaths(), []);
  });
});

test("CROW_MODELS_JSON=colon-list overrides the default paths exactly", async () => {
  await withEnv("CROW_MODELS_JSON", "/tmp/a.json:/tmp/b.json", () => {
    assert.deepEqual(modelsJsonSearchPaths(), ["/tmp/a.json", "/tmp/b.json"]);
  });
});

test("unset CROW_MODELS_JSON keeps the three default locations", async () => {
  await withEnv("CROW_MODELS_JSON", undefined, () => {
    const paths = modelsJsonSearchPaths();
    assert.equal(paths.length, 3);
    assert.ok(paths[0].endsWith("models.json") && !paths[0].includes("config"));
    assert.ok(paths[1].endsWith(join("config", "models.json")));
    assert.ok(paths[2].endsWith(join(".pi", "agent", "models.json")));
  });
});

test("seedProvidersFromModelsJson seeds nothing under an empty override", async () => {
  const { db, cleanup } = freshDb();
  try {
    await withEnv("CROW_MODELS_JSON", "", async () => {
      const r = await seedProvidersFromModelsJson(db);
      assert.equal(r.seeded, 0);
      const { rows } = await db.execute("SELECT COUNT(*) AS n FROM providers");
      assert.equal(Number(rows[0].n), 0);
    });
  } finally { cleanup(); }
});

test("seedProvidersFromModelsJson seeds exactly the fixture entries under a path override", async () => {
  const { dir, db, cleanup } = freshDb();
  try {
    const fixture = join(dir, "fixture-models.json");
    writeFileSync(fixture, JSON.stringify({
      providers: {
        "fixture-local": { baseUrl: "http://localhost:9999/v1", models: [{ id: "m1" }] },
        "fixture-tailnet": { baseUrl: "http://100.99.99.99:8000/v1", models: [{ id: "m2" }] },
      },
    }));
    await withEnv("CROW_MODELS_JSON", fixture, async () => {
      const r = await seedProvidersFromModelsJson(db);
      assert.equal(r.seeded, 2);
      assert.equal(r.source, fixture);
      const { rows } = await db.execute("SELECT id FROM providers ORDER BY id");
      assert.deepEqual(rows.map((x) => x.id), ["fixture-local", "fixture-tailnet"]);
    });
  } finally { cleanup(); }
});
