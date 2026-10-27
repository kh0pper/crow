// 0010-shell-items: the shell_items table (a project for Perch threads, artifacts and Workspace
// files) on both rails — init-db's CREATE and this numbered migration — plus its best-effort backfill.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0010-shell-items.mjs";

const { run, id, SHELL_ITEMS_DDL } = mod;

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
    cols: d.prepare("PRAGMA table_info(shell_items)").all(),
    idx: d.prepare("PRAGMA index_list(shell_items)").all().map(({ seq, ...rest }) => rest),
  };
  d.close();
  return out;
}

test("the module id matches its filename", () => {
  assert.equal(id, "0010-shell-items");
});

test("the shape matches what init-db produces", () => {
  const dir = tmp("shell-init-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe" });
  const want = shape(join(dir, "crow.db"));
  const fresh = join(tmp("shell-fresh-"), "crow.db");
  const db = new Database(fresh);
  db.exec(SHELL_ITEMS_DDL);
  db.close();
  assert.ok(want.cols.length > 0, "init-db created shell_items");
  assert.deepEqual(shape(fresh), want);
});

test("a thread row cannot carry a card", () => {
  const db = new Database(":memory:");
  db.exec(SHELL_ITEMS_DDL);
  assert.throws(
    () => db.prepare("INSERT INTO shell_items (item_kind,item_ref,project_id,card_id,set_by) VALUES ('perch_thread','perchlive-a',NULL,7,'origin')").run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test("run is idempotent", () => {
  const dbPath = join(tmp("shell-idem-"), "crow.db");
  new Database(dbPath).close();
  const r1 = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare("INSERT INTO shell_items (item_kind,item_ref,set_by) VALUES ('artifact','art_1','operator')").run();
  const n1 = db.prepare("SELECT COUNT(*) AS n FROM shell_items").get().n;
  db.close();
  const r2 = run({ dbPath, log: () => {} });
  const db2 = new Database(dbPath, { readonly: true });
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM shell_items").get().n, n1);
  db2.close();
  assert.equal(r1.applied, true);
  assert.equal(r2.applied, true);
});

test("it never drops or deletes", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/migrations/0010-shell-items.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
});

test("bot_sessions is untouched", () => {
  const dbPath = join(tmp("shell-bs-"), "crow.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, card_id INTEGER)");
  const before = db.prepare("PRAGMA table_info(bot_sessions)").all();
  db.close();
  run({ dbPath, log: () => {} });
  const after_ = new Database(dbPath, { readonly: true });
  assert.deepEqual(after_.prepare("PRAGMA table_info(bot_sessions)").all(), before);
  after_.close();
});

test("the DDL is byte-identical to init-db's block", async () => {
  const { readFileSync } = await import("node:fs");
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.ok(init.includes(SHELL_ITEMS_DDL));
});
