/**
 * Card database resolution when `project_spaces.tasks_db_uri` is a `file:` URI.
 *
 * WHY THIS EXISTS. Production stores that column as a URI —
 * `file:/home/kh0pp/.crow-r4/data/tasks.db` on r4 — and better-sqlite3 has no
 * URI support at all: `new Database("file:/x")` raises SQLITE_CANTOPEN because
 * it treats the whole string as a relative filename. Every test written for the
 * job rail seeded a PLAIN path (or the global fallback), so nothing ever
 * exercised the form production actually holds, and the board-dispatch plan's
 * Global Constraints asserted the opposite — "bridge.mjs's db() helper handles
 * the scheme" — which was never true.
 *
 * The failure is asymmetric, which is what made it hard to see:
 *   - resetStrandedCardBestEffort CATCHES and returns false, so an un-strand
 *     silently does nothing and the card stays stranded at stage='executing' —
 *     precisely the failure the un-strand rail exists to prevent.
 *   - tracker.mjs's readers THROW uncaught, because tracker.mjs carries its own
 *     duplicate db() helper with the same defect.
 *
 * So the fix belongs at the one place both modules resolve a path, and these
 * tests pin BOTH shapes: the silent-false path must now really update a row,
 * and the throwing paths must now really read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { resolveSqlitePath } from "../scripts/pi-bots/instance-paths.mjs";

// ── unit: the normalizer ────────────────────────────────────────────

test("resolveSqlitePath leaves a plain absolute path untouched", () => {
  assert.equal(resolveSqlitePath("/home/k/.crow/data/tasks.db"), "/home/k/.crow/data/tasks.db");
});

test("resolveSqlitePath strips the scheme from the form production stores", () => {
  // Exactly what r4 holds in project_spaces.tasks_db_uri.
  assert.equal(
    resolveSqlitePath("file:/home/kh0pp/.crow-r4/data/tasks.db"),
    "/home/kh0pp/.crow-r4/data/tasks.db",
  );
});

test("resolveSqlitePath handles the three-slash and authority forms", () => {
  assert.equal(resolveSqlitePath("file:///var/lib/tasks.db"), "/var/lib/tasks.db");
  assert.equal(resolveSqlitePath("file://localhost/var/lib/tasks.db"), "/var/lib/tasks.db");
});

test("resolveSqlitePath drops SQLite URI query parameters", () => {
  // SQLite's own URI syntax allows ?mode=ro&cache=shared. Left on the string,
  // they become part of the filename and the open fails.
  assert.equal(resolveSqlitePath("file:/var/lib/tasks.db?mode=ro&cache=shared"), "/var/lib/tasks.db");
});

test("resolveSqlitePath percent-decodes", () => {
  assert.equal(resolveSqlitePath("file:/var/my%20data/tasks.db"), "/var/my data/tasks.db");
});

test("resolveSqlitePath passes through non-strings and :memory: unchanged", () => {
  assert.equal(resolveSqlitePath(":memory:"), ":memory:");
  assert.equal(resolveSqlitePath(null), null);
  assert.equal(resolveSqlitePath(undefined), undefined);
});

test("resolveSqlitePath does not mangle a path that merely contains 'file:'", () => {
  // Only a leading scheme is a scheme.
  assert.equal(resolveSqlitePath("/var/file:weird/tasks.db"), "/var/file:weird/tasks.db");
});

// ── integration: the real bridge + tracker against a file: URI ──────

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crow-file-uri-"));
  const crowDb = join(dir, "crow.db");
  const tasksDb = join(dir, "tasks.db");

  const t = new Database(tasksDb);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT, description TEXT,
    status TEXT, priority INTEGER, project_id INTEGER, parent_id INTEGER, stage TEXT,
    assigned_bot TEXT, plan_ref TEXT, created_at TEXT, updated_at TEXT);`);
  t.prepare("INSERT INTO tasks_items (id,title,status,project_id,stage) VALUES (7,?,?,1,?)")
    .run("stranded card", "in_progress", "executing");
  t.prepare("INSERT INTO tasks_items (id,title,status,project_id,stage) VALUES (8,?,?,1,?)")
    .run("finished card", "done", "done");
  t.close();

  const c = new Database(crowDb);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, slug TEXT, name TEXT,
    workspace_dir TEXT, storage_prefix TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
  CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT,
    enabled INTEGER, project_id INTEGER, created_at TEXT, updated_at TEXT);
  CREATE TABLE project_members (project_id INTEGER, member_id TEXT, role TEXT);`);
  // The URI form, not a plain path. This single character is the whole bug.
  c.prepare("INSERT INTO project_spaces (id,slug,name,tasks_db_uri) VALUES (1,?,?,?)")
    .run("proj", "Proj", "file:" + tasksDb);
  c.prepare("INSERT INTO pi_bot_defs (bot_id,display_name,definition,enabled,project_id) VALUES (?,?,?,1,1)")
    .run("uri-bot", "URI Bot", JSON.stringify({ engine: "pi", tracker_config: { type: "kanban" }, tools: {} }));
  c.close();

  return { dir, crowDb, tasksDb };
}

// bridge.mjs and tracker.mjs resolve their databases from CROW_DB_PATH at
// import time, so the env must be set before the first import in this process.
const F = fixture();
process.env.CROW_DB_PATH = F.crowDb;
const B = await import("../scripts/pi-bots/bridge.mjs");
const TR = await import("../scripts/pi-bots/tracker.mjs");

test("cardsDbForBot still returns the stored URI verbatim", () => {
  // The resolution layer is not the place to rewrite what the DB holds; the
  // OPEN is. Keeping this verbatim means logs still name the configured value.
  assert.equal(B.cardsDbForBot("uri-bot"), "file:" + F.tasksDb);
});

test("un-strand actually resets a stranded card when the project stores a file: URI", () => {
  const logs = [];
  const ok = B.resetStrandedCardBestEffort(B.cardsDbForBot("uri-bot"), 7, (m) => logs.push(m));

  assert.equal(ok, true, "must report success, not the silent false that left cards stranded");

  const t = new Database(F.tasksDb);
  const row = t.prepare("SELECT status, stage FROM tasks_items WHERE id=7").get();
  t.close();
  assert.equal(row.status, "pending", "the row must really be updated, not just reported");
  assert.equal(row.stage, "backlog");
  assert.deepEqual(logs, [], "a successful reset logs nothing");
});

test("un-strand still refuses to roll back a terminal card through a file: URI", () => {
  // The AND status NOT IN ('done','cancelled') guard must survive the fix.
  const ok = B.resetStrandedCardBestEffort(B.cardsDbForBot("uri-bot"), 8);
  assert.equal(ok, false);

  const t = new Database(F.tasksDb);
  const row = t.prepare("SELECT status, stage FROM tasks_items WHERE id=8").get();
  t.close();
  assert.equal(row.status, "done", "a finished card must not be reopened");
  assert.equal(row.stage, "done");
});

test("tracker readers no longer throw through a file: URI", () => {
  const uri = B.cardsDbForBot("uri-bot");
  assert.equal(TR.cardStatus(8, uri), "done");
  assert.match(TR.kanbanText(1, uri), /#8 \[done\] finished card/);
  assert.match(
    TR.getTrackerContext({ tracker_config: { type: "kanban" } }, 1, uri),
    /Kanban:/,
  );
});

test("a plain path still works — the fix must not regress the common case", () => {
  assert.equal(TR.cardStatus(8, F.tasksDb), "done");
  assert.equal(B.resetStrandedCardBestEffort(F.tasksDb, 8), false);
});

test.after(() => rmSync(F.dir, { recursive: true, force: true }));
