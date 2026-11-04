// 0021-satellites: four local-only tables on both rails (init-db and the numbered migration),
// idempotent, same shape. Scratch DBs only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "m0021-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const mod = await import("../scripts/migrations/0021-satellites.mjs");
const { discoverMigrations } = await import("../scripts/migrations/runner.mjs");
const S = await import("../servers/shared/satellite-schema.js");
const SYNC = await import("../servers/sharing/instance-sync.js");

const REPO = new URL("..", import.meta.url).pathname;
const dirs = [process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const shape = (d) => d.prepare(
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN (" +
  S.SATELLITE_TABLES.map(() => "?").join(",") + ") AND name NOT LIKE 'sqlite_%' ORDER BY name").all(...S.SATELLITE_TABLES);

test("0021 is discovered, id matches its filename", () => {
  assert.equal(mod.id, "0021-satellites");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations")).some((p) => p.endsWith("0021-satellites.mjs")));
});

test("migration runs twice on a temp DB: idempotent, preserves rows, four tables", () => {
  const dbPath = join(tmp("m0021-"), "crow.db");
  new Database(dbPath).close();
  assert.equal(mod.run({ dbPath }).applied, true);
  const d = new Database(dbPath);
  d.prepare("INSERT INTO satellite_bot_optins (bot_id, any_turn) VALUES ('b', 1)").run();
  d.close();
  assert.equal(mod.run({ dbPath }).applied, true);
  const e = new Database(dbPath);
  const names = e.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of S.SATELLITE_TABLES) assert.ok(names.includes(t), t);
  assert.equal(e.prepare("SELECT any_turn FROM satellite_bot_optins WHERE bot_id='b'").get().any_turn, 1);
  assert.ok(shape(e).some((r) => r.name === "idx_satellite_revocations_satellite"));
  e.close();
});

test("init-db builds the same shape as the migration (sqlite_master SQL equal)", () => {
  const initDir = tmp("m0021-init-");
  execFileSync(process.execPath, [join(REPO, "scripts", "init-db.js")], {
    env: { ...process.env, CROW_DATA_DIR: initDir, CROW_DB_PATH: join(initDir, "crow.db"), CROW_DISABLE_INSTANCE_SYNC: "1" },
    stdio: "pipe",
  });
  const migPath = join(tmp("m0021-mig-"), "crow.db");
  new Database(migPath).close();
  mod.run({ dbPath: migPath });
  const a = new Database(join(initDir, "crow.db"), { readonly: true });
  const b = new Database(migPath, { readonly: true });
  const sa = shape(a), sb = shape(b);
  a.close(); b.close();
  assert.equal(sa.filter((r) => r.type === "table").length, 4);
  assert.deepEqual(sa, sb);
});

test("all four tables are local-only and disjoint from SYNCED_TABLES", () => {
  for (const t of S.SATELLITE_TABLES) assert.ok(SYNC.LOCAL_ONLY_TABLES.includes(t), t);
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["satellites"], SYNC.LOCAL_ONLY_TABLES));
});
