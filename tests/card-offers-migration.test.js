// 0011-card-offers: the card_offers table (a card a bot offered in a Perch chat) on both rails —
// init-db's CREATE and this numbered migration. DDL only; additive, no SCHEMA_GENERATION bump.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0011-card-offers.mjs";

const { run, id, CARD_OFFERS_DDL } = mod;
const REPO = new URL("..", import.meta.url).pathname;

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function shape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const out = {
    cols: d.prepare("PRAGMA table_info(card_offers)").all(),
    idx: d.prepare("PRAGMA index_list(card_offers)").all().map(({ seq, ...rest }) => rest),
    idxCols: d.prepare("PRAGMA index_info(idx_card_offers_thread)").all().map((c) => c.name),
    sql: d.prepare("SELECT sql FROM sqlite_master WHERE name='card_offers'").get()?.sql ?? null,
  };
  d.close();
  return out;
}

test("the module id matches its filename", () => {
  assert.equal(id, "0011-card-offers");
});

test("the shape matches what init-db produces", () => {
  const dir = tmp("offers-init-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const want = shape(join(dir, "crow.db"));
  const fresh = join(tmp("offers-fresh-"), "crow.db");
  new Database(fresh).close();
  run({ dbPath: fresh, log: () => {} });
  assert.ok(want.cols.length > 0, "init-db created card_offers");
  assert.deepEqual(want.idxCols, ["thread_id", "status"]);
  assert.deepEqual(shape(fresh), want);
});

test("the DDL is byte-identical to init-db's block", () => {
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.ok(init.includes(CARD_OFFERS_DDL));
});

test("run is idempotent", () => {
  const dbPath = join(tmp("offers-idem-"), "crow.db");
  new Database(dbPath).close();
  const r1 = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare("INSERT INTO card_offers (bot_id, thread_id, title, project_id) VALUES ('b1','perchlive-a','T',1)").run();
  db.close();
  const r2 = run({ dbPath, log: () => {} });
  const db2 = new Database(dbPath, { readonly: true });
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM card_offers").get().n, 1);
  db2.close();
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);
});

test("it never drops or deletes", () => {
  const src = readFileSync(new URL("../scripts/migrations/0011-card-offers.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
});

test("an absent table is created, and nothing else is touched", () => {
  const dbPath = join(tmp("offers-abs-"), "crow.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, card_id INTEGER)");
  const before = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  db.close();
  assert.equal(run({ dbPath, log: () => {} }).applied, true);
  const d = new Database(dbPath, { readonly: true });
  const now = d.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  d.close();
  for (const b of before) assert.deepEqual(now.find((x) => x.name === b.name), b);
  // bot_sessions' AUTOINCREMENT already made sqlite_sequence, so only 0011's own objects are new.
  assert.deepEqual(now.filter((x) => !before.some((b) => b.name === x.name)).map((x) => x.name).sort(),
    ["card_offers", "idx_card_offers_thread"]);
});

test("the CHECKs hold: a title of 1-500 characters, a known status", () => {
  const db = new Database(":memory:");
  db.exec(CARD_OFFERS_DDL);
  const ins = db.prepare("INSERT INTO card_offers (bot_id, thread_id, title, project_id, status) VALUES ('b','t',?,1,?)");
  assert.throws(() => ins.run("", "pending"), /CHECK constraint failed/);
  assert.throws(() => ins.run("x".repeat(501), "pending"), /CHECK constraint failed/);
  assert.throws(() => ins.run("ok", "maybe"), /CHECK constraint failed/);
  ins.run("x".repeat(500), "accepted");
  db.close();
});

test("0011 never fails on a busy db: the DDL lands", async () => {
  const dbPath = join(tmp("offers-busy-"), "crow.db");
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  seed.exec("CREATE TABLE filler (x INTEGER)");
  seed.close();
  // A second PROCESS holds the write lock for ~600 ms (well under busy_timeout): a same-process
  // holder could never release while run()'s synchronous busy wait blocks the event loop.
  const holder = spawn(process.execPath, ["-e", `
    const Database = require(${JSON.stringify(join(REPO, "node_modules", "better-sqlite3"))});
    const d = new Database(${JSON.stringify(dbPath)});
    d.exec("BEGIN IMMEDIATE"); d.exec("INSERT INTO filler VALUES (1)");
    process.stdout.write("locked\\n");
    setTimeout(() => { d.exec("COMMIT"); d.close(); process.exit(0); }, 600);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((r2) => holder.once("exit", r2));
  await new Promise((resolve, reject) => {
    holder.stdout.on("data", (b) => { if (String(b).includes("locked")) resolve(); });
    holder.on("exit", (c) => reject(new Error("holder exited early: " + c)));
  });
  const t0 = Date.now();
  const r = run({ dbPath, log: () => {} });
  assert.equal(r.applied, true);
  assert.ok(Date.now() - t0 >= 300, "it waited for the lock rather than failing");
  await exited;
  const d = new Database(dbPath, { readonly: true });
  assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE name='card_offers'").get());
  d.close();
});
