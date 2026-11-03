/**
 * "What needs me" (widgets phase 1, Task 1): the ONE server summary behind both the in-Crow widget
 * and the Android home-screen widget.
 *
 *   - the three sources merge in order — the Board's Needs-you lane (ranks first), voice hand-offs
 *     waiting on the phone, unread message threads — and the lock block carries a count only;
 *   - inline actions exist only for a decision's own ≤3 short options, a result (Accept / Not now)
 *     and a hand-off (Yes / No); a plan NEVER gets actions;
 *   - an expired hand-off and a thread whose newest message is not inbound-unread are left out;
 *   - a snoozed key is hidden until its time;
 *   - the all-clear state lists what the bots are working on (≤3 titles);
 *   - itemNonce is stateless and changes with the item's status or updated_at.
 *
 * Built on a scratch crow.db (init-db) and a scratch tasks.db (migrations 0001-0004), the way
 * tests/for-you-data.test.js builds them.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "widgets-needs-me-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-widgets-needs-me");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const P = {};
let createDbClient, W, M, T;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES (?,?, 'general', 'active')");
  P.garden = Number(proj.run("garden", "Garden").lastInsertRowid);
  P.other = Number(proj.run("other", "Other").lastInsertRowid);
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
  c.close();

  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  tk.close();
  const migDir = join(dir, "migrations");
  mkdirSync(migDir);
  for (const f of ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"]) {
    symlinkSync(join(REPO, "scripts", "migrations", f), join(migDir, f));
  }
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  await runMigrations({ migrationsDir: migDir, dbPath: DB_FILE, tasksDbPath: TASKS, sha: "test", log: () => {} });

  ({ createDbClient } = await import("../servers/db.js"));
  W = await import("../servers/gateway/widgets/needs-me.js");
  M = await import("../servers/gateway/for-you/morning.js");
  T = await import("../servers/gateway/dashboard/shared/i18n.js");
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.parse("2026-11-03T12:00:00Z");
const PROJECTS = () => [{ id: P.garden, slug: "garden", name: "Garden" }, { id: P.other, slug: "other", name: "Other" }];

async function load(opts = {}) {
  const tdb = createDbClient(TASKS);
  const db = createDbClient();
  try {
    return await W.loadNeedsMe(db, tdb, { now: NOW, projects: PROJECTS(), ...opts });
  } finally {
    tdb.close();
    db.close();
  }
}

// ---- scratch-store helpers ---------------------------------------------------

function resetStores() {
  const tk = new Database(TASKS);
  try {
    tk.exec("DELETE FROM tasks_items; DELETE FROM board_results; DELETE FROM board_plans; DELETE FROM board_mutations;");
  } finally { tk.close(); }
  const c = new Database(DB_FILE);
  try {
    c.exec("DELETE FROM voice_handoffs; DELETE FROM messages; DELETE FROM contacts; DELETE FROM bot_jobs; DELETE FROM bot_sessions;");
  } finally { c.close(); }
  M._resetNeedsCacheForTest();
}

let cardClock = 1;
function addCard({ title, projectId = P.garden, status = "pending", priority = 3, actionNeeded = null, decision = null }) {
  const tk = new Database(TASKS);
  try {
    const data = decision ? JSON.stringify({ decision }) : "{}";
    // A distinct updated_at per card, so a nonce can be seen to move with it.
    const stamp = `2026-11-03 10:${String(cardClock++ % 60).padStart(2, "0")}:00`;
    return Number(tk.prepare(`INSERT INTO tasks_items (title, project_id, status, priority, action_needed, data_json, updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(title, projectId, status, priority, actionNeeded, data, stamp).lastInsertRowid);
  } finally { tk.close(); }
}

function addResult(cardId, { status = "recorded", outcome = "success", actorKind = "bot" } = {}) {
  const tk = new Database(TASKS);
  try {
    return Number(tk.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, status) VALUES (?,?,?,?,?)")
      .run(cardId, actorKind, actorKind === "bot" ? "ivy" : null, outcome, status).lastInsertRowid);
  } finally { tk.close(); }
}

function addPlan(cardId, { version = 1, status = "draft", body = "1. do the thing" } = {}) {
  const tk = new Database(TASKS);
  try {
    tk.prepare("INSERT INTO board_plans (item_id, version, body_md, status, created_actor_kind) VALUES (?,?,?,?, 'bot')")
      .run(cardId, version, body, status);
  } finally { tk.close(); }
}

function addWorkingJob(cardId, jobId = `job-${cardId}`) {
  const c = new Database(DB_FILE);
  try {
    c.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id) VALUES (?, 'ivy', ?, 'queued', 'card', ?)")
      .run(jobId, `work card ${cardId}`, cardId);
  } finally { c.close(); }
}

const HEX16 = (n) => String(n).padStart(2, "0").repeat(8).slice(0, 16);
function addHandoff({ n, task, status = "awaiting_phone", createdAt = NOW, expiresAt = NOW + 600000 }) {
  const id = `vh-${HEX16(n)}`;
  const c = new Database(DB_FILE);
  try {
    c.prepare(`INSERT INTO voice_handoffs (id, kind, surface, device_id, bot_id, task, status, created_at, expires_at, updated_at)
      VALUES (?, 'handoff', 'kiosk', ?, 'ivy', ?, ?, ?, ?, ?)`)
      .run(id, `phone-${n}`, task, status, createdAt, expiresAt, createdAt);
  } finally { c.close(); }
  return id;
}

function addMessage({ contactId, name, direction, isRead, createdAt, id }) {
  const c = new Database(DB_FILE);
  try {
    if (!c.prepare("SELECT id FROM contacts WHERE id=?").get(contactId)) {
      c.prepare("INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?,?)")
        .run(contactId, `crow-${contactId}`, name, HEX16(contactId), HEX16(contactId + 1));
    }
    const sql = id != null
      ? "INSERT INTO messages (id, contact_id, content, direction, is_read, created_at) VALUES (?,?,?,?,?,?)"
      : "INSERT INTO messages (contact_id, content, direction, is_read, created_at) VALUES (?,?,?,?,?)";
    const args = id != null
      ? [id, contactId, "hello", direction, isRead, createdAt]
      : [contactId, "hello", direction, isRead, createdAt];
    c.prepare(sql).run(...args);
  } finally { c.close(); }
}

/** A decision payload the Board itself would accept (options, one recommended, first). */
function decision(labels, { recommended = 0 } = {}) {
  return {
    question: "Which one?",
    context_md: "",
    fingerprint: "fp-1",
    batch: "batch-1",
    expires: "2999-01-01",
    options: labels.map((label, i) => ({ label, consequence: "a consequence", recommended: i === recommended })),
  };
}

beforeEach(() => resetStores());

// ---- the summary -------------------------------------------------------------

test("merges the board lane, phone hand-offs and unread threads", async () => {
  const card = addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });
  const handoff = addHandoff({ n: 1, task: "Water the beds" });
  addMessage({ contactId: 11, name: "Example Peer", direction: "received", isRead: 0, createdAt: "2026-11-03T11:00:00Z" });

  const s = await load();
  assert.equal(s.id, "needs-me");
  assert.equal(s.title, "What needs me");
  assert.equal(s.state, "ok");
  assert.equal(s.headline, "3 waiting");
  assert.equal(s.more_href, "/dashboard/bot-board");
  assert.equal(s.updated_at, new Date(NOW).toISOString());
  assert.deepEqual(s.items.map((i) => i.kind), ["decision", "handoff", "message"]);
  assert.deepEqual(s.items.map((i) => i.key), [`card:${card}:decision`, `handoff:${handoff}`, "message:11"]);
  assert.deepEqual(s.items.map((i) => i.project), ["Garden", null, null]);
  assert.equal(s.items[0].title, "Choose a mulch");
  assert.equal(s.items[1].title, "Water the beds");
  assert.equal(s.items[2].title, "Example Peer");
  assert.equal(s.items[0].href, `/dashboard/bot-board?card=${card}`, "the one \"open this card\" link");
  assert.equal(s.items[1].href, `/dashboard/voice/handoffs/${handoff}`);
  assert.deepEqual(s.lock, { count: 3, label: "3 waiting" });
  assert.deepEqual(s.doing, [], "with work waiting there is no all-clear block");
  assert.equal(T.t("widgets.needsMe.title", "es"), "Lo que me espera");
  assert.equal(T.t("widgets.needsMe.waiting", "es"), "{n} en espera");
});

test("decision card with ≤3 short options gets inline actions; a 4th option or a 25-char label gives none", async () => {
  const short = addCard({ title: "Short options", priority: 1, decision: decision(["Mulch", "Compost"]) });
  const four = addCard({ title: "Four options", priority: 2, decision: decision(["One", "Two", "Three", "Four"]) });
  const long = addCard({ title: "Long label", priority: 3, decision: decision(["x".repeat(25), "Ok"]) });

  const s = await load();
  assert.equal(s.items.length, 3);
  const byKey = new Map(s.items.map((i) => [i.key, i]));
  assert.deepEqual(byKey.get(`card:${short}:decision`).actions, [
    { id: "option:0", label: "Mulch", style: "primary" },
    { id: "option:1", label: "Compost", style: "plain" },
  ], "the recommended option is primary");
  assert.deepEqual(byKey.get(`card:${four}:decision`).actions, [], "a 4th option opens the card");
  assert.deepEqual(byKey.get(`card:${long}:decision`).actions, [], "a 25-char label opens the card");
});

test("a plan item never has actions", async () => {
  // A bot that wants its plan approved asks on the card (action_needed), which is the Board's own
  // needs-you rule; the plan itself is the card's current plan record.
  const card = addCard({ title: "Approve the rebuild plan", actionNeeded: "Approve the plan" });
  addPlan(card, { version: 2, status: "draft" });

  const s = await load();
  assert.equal(s.items.length, 1);
  const [item] = s.items;
  assert.equal(item.kind, "plan");
  assert.equal(item.key, `card:${card}:plan:2`);
  assert.equal(item.actions.length, 0, "plans never get inline actions");
  assert.equal(item.href, `/dashboard/bot-board?card=${card}`, "the plan opens its card");
  assert.equal(item.project, "Garden");
});

test("result item has accept and not_now actions", async () => {
  const card = addCard({ title: "Soil test" });
  const result = addResult(card);

  const s = await load();
  assert.equal(s.items.length, 1);
  const [item] = s.items;
  assert.equal(item.kind, "result");
  assert.equal(item.key, `card:${card}:result:${result}`);
  assert.deepEqual(item.actions, [
    { id: "accept", label: "Accept", style: "primary" },
    { id: "not_now", label: "Not now", style: "plain" },
  ]);
});

test("handoff item has yes and no actions; an expired awaiting_phone row is not listed", async () => {
  const fresh = addHandoff({ n: 2, task: "Book the van", createdAt: NOW - 1000, expiresAt: NOW + 60000 });
  addHandoff({ n: 3, task: "Already lapsed", createdAt: NOW - 2000, expiresAt: NOW - 1 });

  const s = await load();
  assert.equal(s.items.length, 1, "an expired row is not waiting on the phone any more");
  const [item] = s.items;
  assert.equal(item.key, `handoff:${fresh}`);
  assert.equal(item.kind, "handoff");
  assert.equal(item.project, null);
  assert.deepEqual(item.actions, [
    { id: "yes", label: "Yes", style: "primary" },
    { id: "no", label: "No", style: "plain" },
  ]);
  assert.deepEqual(s.lock, { count: 1, label: "1 waiting" });
});

test("message item is open-only and counts only threads whose newest message is received and unread", async () => {
  addMessage({ contactId: 21, name: "Example One", direction: "received", isRead: 0, createdAt: "2026-11-03T10:00:00Z" });
  addMessage({ contactId: 22, name: "Example Two", direction: "received", isRead: 0, createdAt: "2026-11-03T09:00:00Z" });
  addMessage({ contactId: 22, name: "Example Two", direction: "sent", isRead: 1, createdAt: "2026-11-03T10:30:00Z" });
  addMessage({ contactId: 23, name: "Example Three", direction: "received", isRead: 1, createdAt: "2026-11-03T10:00:00Z" });

  const s = await load();
  assert.deepEqual(s.items.map((i) => i.key), ["message:21"], "only the thread whose newest message is inbound and unread");
  assert.equal(s.items[0].kind, "message");
  assert.deepEqual(s.items[0].actions, [], "messages are deep-link only");
  assert.equal(s.items[0].title, "Example One");
});

test("snoozed keys are left out until their time", async () => {
  const card = addCard({ title: "Snooze me", decision: decision(["Yes please", "Not yet"]) });
  const key = `card:${card}:decision`;

  const hidden = await load({ snoozed: { [key]: NOW + 3600000 } });
  assert.deepEqual(hidden.items, []);
  assert.equal(hidden.state, "empty");
  assert.equal(hidden.lock.count, 0);

  const shown = await load({ snoozed: { [key]: NOW - 1 } });
  assert.deepEqual(shown.items.map((i) => i.key), [key], "past its time the item is back");
});

test("empty state says All clear and lists what bots are doing", async () => {
  const first = addCard({ title: "Draft the letter", priority: 1 });
  const second = addCard({ title: "Check the fence", priority: 2 });
  const third = addCard({ title: "Sort the seeds", priority: 3 });
  const fourth = addCard({ title: "One job too many", priority: 4 });
  for (const id of [first, second, third, fourth]) addWorkingJob(id);

  const s = await load();
  assert.equal(s.state, "empty");
  assert.equal(s.headline, "All clear");
  assert.deepEqual(s.items, []);
  assert.deepEqual(s.doing, ["Draft the letter", "Check the fence", "Sort the seeds"], "the Board's in-progress lane, at most three titles");
  assert.deepEqual(s.lock, { count: 0, label: "0 waiting" });

  const es = await load({ lang: "es" });
  assert.equal(es.headline, "Todo en orden");
  assert.equal(es.title, "Lo que me espera");
});

test("order: board needs-you rank first, then hand-offs, then messages, newest first within each; capped at NEEDS_ME_MAX", async () => {
  const a = addCard({ title: "Board A", priority: 1, decision: decision(["Alpha", "Beta"]) });
  const b = addCard({ title: "Board B", priority: 2, decision: decision(["Gamma", "Delta"]) });
  const newer = addHandoff({ n: 4, task: "Newer hand-off", createdAt: NOW - 1000 });
  const older = addHandoff({ n: 5, task: "Older hand-off", createdAt: NOW - 5000 });
  addMessage({ contactId: 31, name: "Newer thread", direction: "received", isRead: 0, createdAt: "2026-11-03T11:00:00Z" });
  addMessage({ contactId: 32, name: "Older thread", direction: "received", isRead: 0, createdAt: "2026-11-03T08:00:00Z" });

  const s = await load();
  assert.equal(W.NEEDS_ME_MAX, 5);
  assert.equal(s.items.length, W.NEEDS_ME_MAX, "the widget shows the top five");
  assert.deepEqual(s.items.map((i) => i.key), [
    `card:${a}:decision`, `card:${b}:decision`, `handoff:${newer}`, `handoff:${older}`, "message:31",
  ]);
  assert.deepEqual(s.items.map((i) => i.title), ["Board A", "Board B", "Newer hand-off", "Older hand-off", "Newer thread"]);
  assert.deepEqual(s.lock, { count: 6, label: "6 waiting" }, "the count is everything waiting, not just what fits");
});

test("itemNonce changes when status or updated_at changes", () => {
  const base = { kind: "decision", id: 7, status: "pending", updated_at: "2026-11-03 10:00:00", version: null };
  const nonce = W.itemNonce(base);
  assert.match(nonce, /^[0-9a-f]{16}$/);
  assert.equal(W.itemNonce({ ...base }), nonce, "the same state is the same nonce");
  assert.notEqual(W.itemNonce({ ...base, status: "in_progress" }), nonce, "a status change moves it");
  assert.notEqual(W.itemNonce({ ...base, updated_at: "2026-11-03 10:00:01" }), nonce, "so does an updated_at change");
  assert.notEqual(W.itemNonce({ ...base, version: 2 }), nonce, "and a new plan/result version");
});

test("lock block never contains a title", async () => {
  addCard({ title: "Secret reorg", decision: decision(["Cut the budget", "Keep it"]) });
  addHandoff({ n: 6, task: "Secret hand-off task" });
  addMessage({ contactId: 41, name: "Example Person", direction: "received", isRead: 0, createdAt: "2026-11-03T11:00:00Z" });

  const s = await load();
  assert.deepEqual(Object.keys(s.lock).sort(), ["count", "label"], "the lock block is a count and a label, nothing else");
  const text = JSON.stringify(s.lock);
  for (const item of s.items) assert.ok(!text.includes(item.title), `the lock block leaks no item title: ${item.title}`);
  for (const leak of ["Secret", "Example Person", "Garden", "cut the budget"]) {
    assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `the lock block leaks no ${JSON.stringify(leak)}`);
  }
  assert.equal(s.lock.label, "3 waiting");
});