// pm-workspace Monday sync never files cards into a project that is not live (spec §15): a board
// whose kanban target is a deleted project's tombstone (or an archived project) is skipped with a
// log line, before any Monday call; a board on a live project still syncs (its fetch is reached).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

test("a board whose target project is deleted or archived is skipped; a live one still syncs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-monday-dead-"));
  const original = globalThis.fetch;
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" }, stdio: "pipe", cwd: REPO_ROOT });
    const c = new Database(join(dir, "crow.db"));
    c.exec(`CREATE TABLE IF NOT EXISTS pm_sync_state (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, board_id TEXT, item_id TEXT,
              local_kind TEXT, local_id INTEGER, content_hash TEXT, monday_updated_at TEXT, last_synced_at TEXT, UNIQUE(board_id, item_id));
            CREATE TABLE IF NOT EXISTS pm_sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT DEFAULT (datetime('now')),
              direction TEXT, board_id TEXT, action TEXT, item_ref TEXT, detail TEXT, ok INTEGER);`);
    const ins = c.prepare("INSERT INTO project_spaces (slug, name, status, archived_at) VALUES (?, ?, ?, ?)");
    const dead = Number(ins.run("gone-deleted-1", "Gone", "archived", "2026-10-29 00:00:00").lastInsertRowid);
    const shelved = Number(ins.run("shelved", "Shelved", "archived", null).lastInsertRowid);
    const live = Number(ins.run("live", "Live", "active", null).lastInsertRowid);
    c.close();
    const t = new Database(join(dir, "tasks.db"));
    t.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, status TEXT, priority INTEGER, due_date TEXT, phase TEXT, owner TEXT, tags TEXT, project_id INTEGER, archived_at TEXT, updated_at TEXT, completed_at TEXT)");
    t.close();

    const board = (id, pid) => ({ board_id: id, mode: "twoway", target: { kind: "kanban", project_id: pid }, column_map: {} });
    const cfg = join(dir, "sync.json");
    writeFileSync(cfg, JSON.stringify({ boards: [board("101", dead), board("102", shelved), board("103", live)] }));

    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("stub: Monday unreachable"); };

    const { createDbClient } = await import("../servers/db.js");
    const { runSync } = await import("../bundles/pm-workspace/server/sync/monday.js");
    const db = createDbClient(join(dir, "crow.db"));
    try {
      const r = await runSync(db, { SYNC_CONFIG_FILE: cfg, MONDAY_TOKEN: "test-token", CROW_TASKS_DB_PATH: join(dir, "tasks.db") });
      assert.ok(r.boards, JSON.stringify(r));
      const byBoard = Object.fromEntries(r.boards.map((b) => [b.board_id, b]));
      assert.equal(byBoard["101"].skipped, "project_not_live");
      assert.equal(byBoard["102"].skipped, "project_not_live");
      assert.equal(byBoard["103"].ok, false, "control: the live board reached Monday (the stub throws)");
      assert.ok(calls >= 1, "control: fetch was called for the live board only");
      const skips = (await db.execute("SELECT board_id FROM pm_sync_log WHERE action = 'skip_project_not_live' ORDER BY board_id")).rows.map((x) => x.board_id);
      assert.deepEqual(skips, ["101", "102"]);
    } finally { db.close(); }
    const t2 = new Database(join(dir, "tasks.db"));
    assert.equal(t2.prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n, 0);
    t2.close();
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
