// Crow Artifacts Task 3.4 — the D4 "Create a board card" factory: a trusted
// round becomes a GATED card whose PLAN carries exactly the round snapshot
// text (a dispatch prompt reads the plan records). Harness mirrors
// tests/board-card-service.test.js: real migrations 0001–0004 over a tmpdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import { makeArtifactBoardCard } from "../servers/gateway/board/artifact-card.js";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artcard-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");
  const c = new Database(dbPath);
  c.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
  // The factory's only crow.db need: the artifact title lookup.
  c.exec("CREATE TABLE artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  c.prepare("INSERT INTO artifacts (id, title) VALUES ('art_t1', 'Quarterly mockup')").run();
  c.close();
  const t = new Database(tasksDbPath);
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();
  return { root, dbPath, tasksDbPath };
}

async function withStore(fn) {
  const f = fixture();
  try {
    await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });
    const db = createDbClient(f.dbPath);
    try {
      await fn({ db, tasksDbPath: () => f.tasksDbPath, tasksFile: f.tasksDbPath });
    } finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}

function readTasks(tasksFile) {
  const t = new Database(tasksFile, { readonly: true });
  try {
    return {
      card: t.prepare("SELECT * FROM tasks_items ORDER BY id DESC LIMIT 1").get(),
      plan: t.prepare("SELECT * FROM board_plans ORDER BY id DESC LIMIT 1").get(),
      mutation: t.prepare("SELECT * FROM board_mutations WHERE verb='create' ORDER BY id DESC LIMIT 1").get(),
    };
  } finally { t.close(); }
}

test("a trusted round becomes a gated card whose plan carries exactly the snapshot text", async () => {
  await withStore(async ({ db, tasksDbPath, tasksFile }) => {
    const create = makeArtifactBoardCard({ db, tasksDbPath });
    const TEXT = "[Crow Artifacts feedback round 5]\nMake the header green — owner words only.";
    const cardId = await create({ round: { id: 5, artifact_id: "art_t1", kind: "round" }, text: TEXT });
    assert.ok(Number.isInteger(cardId) && cardId > 0);
    const { card, plan, mutation } = readTasks(tasksFile);
    assert.equal(card.id, cardId);
    assert.equal(card.title, "Artifacts round 5: Quarterly mockup");
    assert.equal(card.autonomy, "gated", "the owner's go is still required");
    assert.equal(card.status, "pending");
    assert.equal(card.tags, "artifacts");
    assert.equal(plan.item_id, cardId);
    assert.equal(plan.version, 1);
    assert.equal(plan.body_md, TEXT, "the plan is EXACTLY the round snapshot — the dispatch prompt reads it");
    assert.equal(mutation.verb, "create");
    assert.equal(mutation.actor_kind, "human", "created on the owner's behalf");
  });
});

test("an Ask round says 'question'; a missing artifact falls back to a plain title (never throws)", async () => {
  await withStore(async ({ db, tasksDbPath, tasksFile }) => {
    const create = makeArtifactBoardCard({ db, tasksDbPath });
    await create({ round: { id: 9, artifact_id: "art_t1", kind: "ask" }, text: "q" });
    assert.equal(readTasks(tasksFile).card.title, "Artifacts question 9: Quarterly mockup");
    const id2 = await create({ round: { id: 11, artifact_id: "art_gone", kind: "round" }, text: "t" });
    const { card } = readTasks(tasksFile);
    assert.equal(card.id, id2);
    assert.equal(card.title, "Artifacts round 11", "fallback title without the artifact row");
  });
});

test("a second card gets its own plan version 1 (plans never collide across cards)", async () => {
  await withStore(async ({ db, tasksDbPath, tasksFile }) => {
    const create = makeArtifactBoardCard({ db, tasksDbPath });
    await create({ round: { id: 1, artifact_id: "art_t1", kind: "round" }, text: "first" });
    await create({ round: { id: 2, artifact_id: "art_t1", kind: "round" }, text: "second" });
    const t = new Database(tasksFile, { readonly: true });
    try {
      const plans = t.prepare("SELECT item_id, version, body_md FROM board_plans ORDER BY id").all();
      assert.equal(plans.length, 2);
      assert.deepEqual(plans.map((p) => p.body_md), ["first", "second"]);
      assert.ok(plans.every((p) => p.version === 1));
    } finally { t.close(); }
  });
});
