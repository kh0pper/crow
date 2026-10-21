/**
 * give-service.js — the shared "Give to…" core (board dispatch verb, task D1).
 *
 * The dashboard's POST /cards/:id/give and POST /bots/:id/tasks routes call
 * giveCard() with the dashboard's human actor and the "local" audit actor;
 * the board dispatch verb calls the same core with a bot actor. These tests
 * pin, at the service level:
 *   - the card_given audit payload (bot_id + the caller's extras, children
 *     count only when a child moved),
 *   - the actor recorded on the card's own update row AND on every child row
 *     (human for the dashboard, the bot for a bot caller),
 *   - the audit row's actor_type/actor_id as the caller passed them,
 *   - extraFields riding in the same write (card and children),
 *   - every refusal code the dashboard route has always returned, each with
 *     nothing written.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-give-service-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const TASKS = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;

const HUMAN = { kind: "human", id: null, jobId: null };
const BOT = { kind: "bot", id: "bot-1", jobId: null };

let giveCard, loadGiveTarget, giveAudit, createDbClient;
let PID, PID2;

const raw = () => new Database(DB_FILE);
const rawTasks = () => new Database(TASKS);

function seedBot(id, def, { enabled = 1, project = null } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(id, id, JSON.stringify(def), enabled, project);
  c.close();
}
function seedCard({ title = "card", boardId = null, archivedAt = null, projectId = null, parentId = null, status = "pending" } = {}) {
  const t = rawTasks();
  const r = t.prepare("INSERT INTO tasks_items (title, board_id, archived_at, project_id, parent_id, status) VALUES (?,?,?,?,?,?)")
    .run(title, boardId, archivedAt, projectId, parentId, status);
  t.close();
  return Number(r.lastInsertRowid);
}
const card = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id); t.close(); return r; };
const mutations = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM board_mutations WHERE item_id=? ORDER BY id").all(id); t.close(); return r; };
const audits = (target) => { const c = raw(); const r = c.prepare("SELECT * FROM project_audit_log WHERE action='card_given' AND target=?").all(target); c.close(); return r; };

async function withDbs(fn) {
  const tdb = createDbClient(TASKS);
  const cdb = createDbClient(DB_FILE);
  try { return await fn(tdb, cdb); } finally { tdb.close(); cdb.close(); }
}
async function refusal(promise) {
  try { await promise; } catch (err) { return err; }
  assert.fail("expected a refusal");
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = raw();
  const mk = (slug) => Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(slug, slug).lastInsertRowid);
  PID = mk("helper-board");
  PID2 = mk("other-board");
  c.close();
  seedBot("helper", { tracker_config: { type: "kanban" } }, { project: PID });
  seedBot("other", { tracker_config: { type: "kanban" } }, { project: PID2 });
  seedBot("sleeper", {}, { enabled: 0, project: PID });
  seedBot("nob", { tracker_config: { type: "none" } });

  const t = rawTasks();
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, project_id INTEGER,
    display_name TEXT, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]')`);
  t.close();

  ({ giveCard, loadGiveTarget, giveAudit } = await import("../servers/gateway/board/give-service.js"));
  ({ createDbClient } = await import("../servers/db.js"));
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

test("dashboard call: one human update row, card_given payload pinned, actor_type local", async () => {
  const id = seedCard();
  const out = await withDbs((tdb, cdb) => giveCard(tdb, cdb, {
    cardId: id, botId: "helper", actor: HUMAN, audit: { actor_type: "local", extra: { start: false } },
  }));
  assert.equal(out.projectId, PID);
  assert.equal(out.children, 0);
  assert.equal(String(out.row.bot_id), "helper");
  const row = card(id);
  assert.equal(row.project_id, PID);
  assert.equal(row.assigned_bot, "helper");
  const m = mutations(id);
  assert.equal(m.length, 1);
  assert.equal(m[0].verb, "update");
  assert.equal(m[0].actor_kind, "human");
  assert.equal(m[0].actor_id, null);
  assert.deepEqual(JSON.parse(m[0].detail_json), { project_id: [null, PID], assigned_bot: [null, "helper"] });
  const a = audits(`card:${id}`);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_type, "local");
  assert.equal(a[0].actor_id, null);
  assert.equal(a[0].project_id, PID);
  assert.deepEqual(JSON.parse(a[0].payload), { bot_id: "helper", start: false });
});

test("bot call: the bot is the actor on the card row AND every child row; audit actor_type bot with its id", async () => {
  const parent = seedCard({ title: "parent" });
  const kid = seedCard({ title: "kid", parentId: parent });
  const grandkid = seedCard({ title: "grandkid", parentId: kid });
  const out = await withDbs((tdb, cdb) => giveCard(tdb, cdb, {
    cardId: parent, botId: "other", actor: BOT,
    audit: { actor_type: "bot", actor_id: "bot-1", extra: { via: "dispatch" } },
  }));
  assert.equal(out.children, 2);
  for (const id of [parent, kid, grandkid]) {
    const m = mutations(id);
    assert.equal(m.length, 1, "one row for " + id);
    assert.equal(m[0].actor_kind, "bot");
    assert.equal(m[0].actor_id, "bot-1");
    assert.equal(card(id).project_id, PID2);
  }
  assert.equal(card(kid).assigned_bot, null, "a child is moved, never assigned");
  const a = audits(`card:${parent}`);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_type, "bot");
  assert.equal(a[0].actor_id, "bot-1");
  assert.deepEqual(JSON.parse(a[0].payload), { bot_id: "other", via: "dispatch", children: 2 });
});

test("extraFields ride in the same write, on the card and on each child", async () => {
  const parent = seedCard({ title: "parent" });
  const kid = seedCard({ title: "kid", parentId: parent });
  const t = rawTasks();
  t.prepare("UPDATE tasks_items SET autonomy='auto' WHERE id IN (?,?)").run(parent, kid);
  t.close();
  await withDbs((tdb, cdb) => giveCard(tdb, cdb, {
    cardId: parent, botId: "helper", actor: BOT,
    audit: { actor_type: "bot", actor_id: "bot-1" }, extraFields: { autonomy: "gated" },
  }));
  for (const id of [parent, kid]) {
    assert.equal(card(id).autonomy, "gated");
    const m = mutations(id);
    assert.equal(m.length, 1, "still one row each");
    assert.deepEqual(JSON.parse(m[0].detail_json).autonomy, ["auto", "gated"]);
  }
});

test("refusals keep the dashboard's codes and write nothing", async () => {
  const cases = [];
  cases.push(["missing", 999999, "helper", 404, "not_found"]);
  cases.push(["item", seedCard({ boardId: 3 }), "helper", 400, "bad_request"]);
  cases.push(["archived", seedCard({ archivedAt: "2026-01-01 00:00:00" }), "helper", 409, "archived"]);
  const p = seedCard();
  cases.push(["subtask", seedCard({ parentId: p }), "helper", 400, "bad_request"]);
  cases.push(["disabled", seedCard(), "sleeper", 400, "bot_unavailable"]);
  cases.push(["unknown", seedCard(), "ghost", 400, "bot_unavailable"]);
  cases.push(["no board", seedCard(), "nob", 409, "no_board"]);
  cases.push(["finished", seedCard({ status: "done" }), "helper", 409, "finished"]);
  for (const [label, id, bot, http, code] of cases) {
    const err = await refusal(withDbs((tdb, cdb) => giveCard(tdb, cdb, {
      cardId: id, botId: bot, actor: HUMAN, audit: { actor_type: "local" },
    })));
    assert.equal(err.http, http, label);
    assert.equal(err.code, code, label);
    assert.equal(mutations(id).length, 0, label);
    assert.equal(audits(`card:${id}`).length, 0, label);
  }
});

test("a locked card: 409 locked with the rail, nothing written", async () => {
  const id = seedCard();
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,card_id) VALUES (?,?,?,?,?,?)")
    .run("helper", "gmail", "svc-lock-" + id, "active", "run", id);
  c.close();
  const err = await refusal(withDbs((tdb, cdb) => giveCard(tdb, cdb, {
    cardId: id, botId: "helper", actor: BOT, audit: { actor_type: "bot", actor_id: "bot-1" },
  })));
  assert.equal(err.http, 409);
  assert.equal(err.code, "locked");
  assert.equal(err.rail, "session");
  assert.equal(mutations(id).length, 0);
});

test("loadGiveTarget and giveAudit are exported for the bots/:id/tasks route", async () => {
  await withDbs(async (tdb, cdb) => {
    const row = await loadGiveTarget(cdb, "helper");
    assert.equal(Number(row.project_id), PID);
    const id = seedCard();
    await giveAudit(cdb, row, id, { start: true, created: true });
    const a = audits(`card:${id}`);
    assert.equal(a.length, 1);
    assert.equal(a[0].actor_type, "local", "default actor_type stays local");
    assert.deepEqual(JSON.parse(a[0].payload), { bot_id: "helper", start: true, created: true });
  });
});
