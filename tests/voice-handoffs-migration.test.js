// 0018-voice-handoffs: the voice_handoffs table (the log of every voice hand-off and spoken stop) on
// both rails — init-db's CREATE and this numbered migration. DDL only; additive, no SCHEMA_GENERATION
// bump. The table is local-only: it never replicates to a paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0018-voice-handoffs.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";

const { run, id, VOICE_HANDOFFS_DDL } = mod;
const REPO = new URL("..", import.meta.url).pathname;
const SYNC = await import("../servers/sharing/instance-sync.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const INDEXES = ["idx_voice_handoffs_card", "idx_voice_handoffs_device", "idx_voice_handoffs_phone_open", "idx_voice_handoffs_status"];

function shape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const out = {
    cols: d.prepare("PRAGMA table_info(voice_handoffs)").all(),
    idx: d.prepare("PRAGMA index_list(voice_handoffs)").all().map(({ seq, ...rest }) => rest)
      .sort((a, b) => a.name.localeCompare(b.name)),
    idxCols: Object.fromEntries(INDEXES.map((n) => [n, d.prepare(`PRAGMA index_info(${n})`).all().map((c) => c.name)])),
    sql: d.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name='voice_handoffs' ORDER BY name").all(),
  };
  d.close();
  return out;
}

test("the module id matches its filename", () => {
  assert.equal(id, "0018-voice-handoffs");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations")).some((p) => p.endsWith("/0018-voice-handoffs.mjs")));
});

test("the shape matches what init-db produces", () => {
  const dir = tmp("vh-init-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const want = shape(join(dir, "crow.db"));
  const fresh = join(tmp("vh-fresh-"), "crow.db");
  new Database(fresh).close();
  run({ dbPath: fresh, log: () => {} });
  assert.ok(want.cols.length > 0, "init-db created voice_handoffs");
  assert.ok(want.cols.some((c) => c.name === "lang"), "the lang column is there");
  assert.deepEqual(want.idxCols.idx_voice_handoffs_phone_open, ["device_id", "kind"]);
  assert.equal(want.idx.find((i) => i.name === "idx_voice_handoffs_phone_open").unique, 1);
  assert.equal(want.idx.find((i) => i.name === "idx_voice_handoffs_phone_open").partial, 1);
  assert.deepEqual(shape(fresh), want);
});

test("the DDL is byte-identical to init-db's block", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.ok(init.includes(`await initTable("voice_handoffs table", \`${VOICE_HANDOFFS_DDL}\`);`));
});

test("there is no CHECK on status or kind (validated in JS)", () => {
  assert.doesNotMatch(VOICE_HANDOFFS_DDL, /CHECK/);
});

test("run is idempotent", () => {
  const dbPath = join(tmp("vh-idem-"), "crow.db");
  new Database(dbPath).close();
  const r1 = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO voice_handoffs (id, surface, device_id, bot_id, task, status, created_at, updated_at)
              VALUES ('vh-1','dashboard','d1','writer','T','proposed',1,1)`).run();
  db.close();
  const r2 = run({ dbPath, log: () => {} });
  const db2 = new Database(dbPath, { readonly: true });
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM voice_handoffs").get().n, 1);
  db2.close();
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);
});

test("it never drops or deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0018-voice-handoffs.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
});

test("an absent table is created, and nothing else is touched", () => {
  const dbPath = join(tmp("vh-abs-"), "crow.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, card_id INTEGER)");
  const before = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  db.close();
  assert.equal(run({ dbPath, log: () => {} }).applied, true);
  const d = new Database(dbPath, { readonly: true });
  const now = d.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  d.close();
  for (const b of before) assert.deepEqual(now.find((x) => x.name === b.name), b);
  // The TEXT primary key makes SQLite's own autoindex beside the four declared ones.
  assert.deepEqual(now.filter((x) => !before.some((b) => b.name === x.name)).map((x) => x.name).sort(),
    ["sqlite_autoindex_voice_handoffs_1", ...INDEXES, "voice_handoffs"].sort());
});

test("voice_handoffs is local-only", () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("voice_handoffs"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("voice_handoffs"));
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", "voice_handoffs"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("voice_handoffs", { id: "vh-1" }), false);
});
