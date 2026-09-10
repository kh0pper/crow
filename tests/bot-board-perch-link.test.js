/**
 * Nav-gap fix, Task B — the bot board must link BACK to Perch. Perch already
 * links to the board (perch-hub/html.js's <nav class="machines">); before
 * this fix the reverse link did not exist, so an operator on the board had
 * no way back to the chat surface.
 *
 * Harness mirrors tests/roost-strip-ui.test.js: a hand-rolled scratch
 * tasks.db/crow.db, minus init-db.js, with just the tables the handler
 * actually touches on this path — plus pi_bot_defs (empty), which is what
 * bot-board.js's tableMissing() gates the whole panel on. An empty
 * pi_bot_defs still reaches the switcher/perch-link markup (the "no bot
 * selected" branch renders it too), so no bot fixture row is needed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "bot-board-perch-link-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  c.exec(`CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.close();
}

let botBoardPanel, createDbClient;
before(async () => {
  ({ default: botBoardPanel } = await import("../servers/gateway/dashboard/panels/bot-board.js"));
  ({ createDbClient } = await import("../servers/db.js"));
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

const layout = (o) => o.content;

async function render(lang = "en") {
  const db = createDbClient();
  try {
    return await botBoardPanel.handler({ method: "GET", query: {} }, {}, { db, layout, lang });
  } finally { db.close(); }
}

test("the bot board links back to Perch", async () => {
  const html = await render("en");
  assert.match(html, /<a href="\/dashboard\/perch"[^>]*>[^<]*<\/a>/, "a plain anchor to /dashboard/perch must render");
});

test("the perch link text is i18n'd, not hardcoded, and differs between en and es", async () => {
  const en = await render("en");
  const es = await render("es");
  const enMatch = en.match(/<a href="\/dashboard\/perch"[^>]*>([^<]*)<\/a>/);
  const esMatch = es.match(/<a href="\/dashboard\/perch"[^>]*>([^<]*)<\/a>/);
  assert.ok(enMatch, "en render must carry the link");
  assert.ok(esMatch, "es render must carry the link");
  assert.notEqual(enMatch[1], "", "link text must not be empty");
  assert.notEqual(enMatch[1], esMatch[1], "es text must be a real translation, not a copy of en");
});
