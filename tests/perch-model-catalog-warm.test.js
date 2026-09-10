// Fix round 1 Q6 — the session-free catalogue was EMPTY on its first call.
//
// `loadProviders()` is synchronous by contract (providers.js: hot-path callers
// that cannot be made async), so on a cold process it returns
// `_cache || loadFromModelsJson()` and fires an UNAWAITED DB refresh. With no
// models.json — which is the shipped state — the first call answers 0 models
// and the second, ~1.5 s later, answers all of them. Measured against
// ~/.crow-r4: 0, then 32.
//
// In that window `GET /bots/:id/models` served `{models: []}` (the client
// self-heals on the next poll) and a hibernating session's `options()` served
// `[]`, which the drawer renders as the empty, disabled dropdown this whole
// task exists to remove — and `loadOptions` runs once per `openSession` and
// never retries.
//
// SEPARATE FILE, deliberately: the provider cache is module-level, so this has
// to be the FIRST call in its process. Any sibling test that lists models
// first would warm the cache and turn this into a tautology.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-catalog-warm-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
// "" means "no models.json anywhere" (models-json-paths.js). Without this the
// sync loader could find a repo-local file and answer non-empty, which would
// make the assertion below pass for the wrong reason.
process.env.CROW_MODELS_JSON = "";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  const db = new Database(join(dir, "crow.db"));
  db.prepare(
    "INSERT INTO providers (id, base_url, host, models, disabled) VALUES (?,?,?,?,0)"
  ).run("crow-local", "http://127.0.0.1:8003/v1",
    "local", JSON.stringify([{ id: "qwen3.6-35b-a3b", name: "Qwen" }]));
  db.close();
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

test("the FIRST call answers the real catalogue, not the cold-cache empty one", async () => {
  const { providerModelList, providerModelListWarm } =
    await import("../servers/gateway/perch-model-catalog.js");

  // The sync loader, cold, on a host with no models.json: this is the [] the
  // route and the drawer were being served. Asserted so the test below cannot
  // silently stop proving anything if that ever changes.
  assert.deepEqual(providerModelList(), [],
    "precondition: the synchronous loader really is empty on a cold cache");

  const warm = await providerModelListWarm();
  assert.deepEqual(warm.map((m) => m.provider + "/" + m.id), ["crow-local/qwen3.6-35b-a3b"],
    "the awaited variant must not hand back the empty list the sync one has");
});
