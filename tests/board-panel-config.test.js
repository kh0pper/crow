// tests/board-panel-config.test.js
//
// Track 0 Phase A: the kanban board renders from the RESOLVED BOARD DEF —
// per-board columns, declared-field meta on card faces, def-driven drawer
// options, and the tracker path's affordances (filter bar, list toggle,
// collapsible columns) — while a def-less project stays byte-compatible with
// today's four-column board.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-panel-cfg-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

// Seed BEFORE importing (modules read env at import time).
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  // board_id + board_mutations (Track 1): moveCard (card-service) is now the
  // no-JS action=move handler's writer — it filters WHERE board_id IS NULL
  // and records every move to board_mutations. Every INSERT below omits
  // board_id, so cards land NULL — the correct card shape.
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (7,'Custom',?,?,?)")
    .run('["todo","doing","shipped"]', '["shipped"]',
      '[{"key":"phase","label":"Phase","storage":"column","options":["Drafting","Final"]}]');
  const ins = t.prepare("INSERT INTO tasks_items (id, title, project_id, status, phase) VALUES (?,?,?,?,?)");
  ins.run(1, "custom card", 7, "todo", "Drafting");
  ins.run(2, "legacy card", 3, "pending", null);
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  c.close();
}

let renderKanbanBoard, handleBotBoardPost, createDbClient;
before(async () => {
  ({ renderKanbanBoard } = await import("../servers/gateway/dashboard/panels/bot-board/html.js"));
  ({ handleBotBoardPost } = await import("../servers/gateway/dashboard/panels/bot-board/api-handlers.js"));
  ({ createDbClient } = await import("../servers/db.js"));
});

function selBot(projectId) {
  return { botId: "scout", displayName: "Scout", projectId, trackerType: "kanban", trackerSlug: null, definition: {} };
}
const layout = (o) => o.content;

async function render(projectId, q = {}) {
  const db = createDbClient();
  try {
    return await renderKanbanBoard({}, {}, {
      db, layout, selBot: selBot(projectId), bots: [], notice: "", switcher: "", q, lang: "en",
    });
  } finally { db.close(); }
}

test("a project with a custom def renders its columns, count, and move buttons", async () => {
  const html = await render(7);
  assert.ok(html.includes("--bb-cols:3"), "three configured columns");
  for (const s of ["todo", "doing", "shipped"]) {
    assert.ok(html.includes(`data-col="${s}"`), `column ${s}`);
  }
  assert.ok(!html.includes('data-col="pending"'), "builtin columns must not leak onto a configured board");
  // no-JS move buttons carry the custom values (card 1 is 'todo' → other two)
  assert.ok(html.includes('value="doing"') && html.includes('value="shipped"'), "no-JS move buttons use def values");
});

test("a def-less project renders today's four i18n-labelled columns", async () => {
  const html = await render(3);
  assert.ok(html.includes("--bb-cols:4"));
  for (const s of ["pending", "in_progress", "done", "cancelled"]) {
    assert.ok(html.includes(`data-col="${s}"`), `column ${s}`);
  }
  assert.ok(html.includes(">Pending<"), "builtin board keeps the i18n label");
});

test("declared column-backed field shows on the card face", async () => {
  const html = await render(7);
  assert.ok(/Phase:\s*Drafting|Phase<\/span>|Phase: Drafting/.test(html.replace(/<[^>]+>/g, (m) => m)) ||
    html.includes("Phase: Drafting") || /Phase[^<]*Drafting/.test(html),
    "card face carries the declared phase value");
});

test("kanban board gains the filter bar, list toggle and collapsible columns", async () => {
  const html = await render(7);
  assert.ok(html.includes("bb-search"), "search input");
  assert.ok(html.includes('data-status-filter="todo"'), "status chips from the def");
  assert.ok(html.includes("bb-view-toggle"), "list/columns toggle");
  assert.ok(html.includes("bb-col-toggle"), "collapsible columns");
  assert.ok(html.includes("bb-list-wrap"), "list view container");
});

test("drawer status options come from the def, not the hardcoded four", async () => {
  const custom = await render(7);
  assert.ok(custom.includes('<option value="todo">'), "custom option present");
  assert.ok(!custom.includes('<option value="pending">'), "builtin options must not leak");
  const builtin = await render(3);
  assert.ok(builtin.includes('<option value="pending">'), "builtin drawer keeps the four");
});

test("a card whose status is off the def still renders — extra column, never hidden", async () => {
  // Reachable today: the stdio tasks door and the bridge's own prompt write
  // legacy statuses ('pending'/'done') onto boards configured without them,
  // and the CHECK that used to stop them is gone. Hiding the card would also
  // deadlock /board-def saves (the no-orphan guard names a card nobody can see).
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("INSERT INTO tasks_items (id, title, project_id, status) VALUES (99,'stray legacy card',7,'pending')").run();
  t.close();
  try {
    const html = await render(7);
    assert.ok(html.includes('data-col="pending"'), "off-def status gets its own column");
    assert.ok(html.includes("stray legacy card"), "the card itself is visible");
    assert.ok(html.includes("--bb-cols:4"), "column count includes the extra column");
  } finally {
    const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
    t2.prepare("DELETE FROM tasks_items WHERE id=99").run();
    t2.close();
  }
});

test("board renders the configure button and the settings drawer", async () => {
  const html = await render(7);
  assert.ok(html.includes('id="bb-cfg-open"'), "configure button");
  assert.ok(html.includes('id="bb-cfg"'), "settings drawer");
  assert.ok(html.includes("Board settings"), "cfg i18n (en)");
  assert.ok(html.includes('data-project="7"'), "drawer carries the project id");
  // ES parity spot check via the i18n table itself
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.equal(t("botboard.cfgTitle", "es"), "Ajustes del tablero");
  assert.equal(t("botboard.cfgOpenBtn", "es"), "Configurar tablero");
});

test("client filter/search machinery is mode-aware — kanban cards match too", async () => {
  const { clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js");
  const js = clientJs("scout", "kanban", 7, null, null, "en");
  // The applyFilters selector must not be tracker-only: kanban faces carry no
  // data-item-type, and a tracker-only selector zeroes every column count at
  // load and makes search/chips inert (review finding, client.js:492).
  const occurrences = js.split("TRACKER_TYPE==='custom'?'.bb-card[data-item-type=\"tracker\"]':'.bb-card'").length - 1;
  assert.equal(occurrences, 2, "both applyFilters and buildListTable use the mode-aware selector");
  // The board-config reload check compares against the configured list stamped
  // at render (data-statuses), never the rendered columns — off-def extras
  // would otherwise reload the page every 10s forever.
  assert.ok(js.includes("data-statuses"), "reload check reads the stamped configured list");
  const rendered = await render(7);
  assert.ok(rendered.includes('data-statuses='), "render stamps the configured list");
});

test("no-JS move validates against the def", async () => {
  const calls = [];
  const res = { redirectAfterPost: (u) => calls.push(u) };
  const db = createDbClient();
  try {
    await handleBotBoardPost({ body: { action: "move", card_id: "1", status: "doing", bot: "scout" } }, res, { db });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes("err="), "on-list value accepted: " + calls[0]);
    const t = new Database(process.env.CROW_TASKS_DB_PATH);
    assert.equal(t.prepare("SELECT status FROM tasks_items WHERE id=1").get().status, "doing");
    t.prepare("UPDATE tasks_items SET status='todo' WHERE id=1").run();
    t.close();

    await handleBotBoardPost({ body: { action: "move", card_id: "1", status: "done", bot: "scout" } }, res, { db });
    assert.ok(calls[1].includes("err=bad_move"), "off-list value refused: " + calls[1]);
    const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
    assert.equal(t2.prepare("SELECT status FROM tasks_items WHERE id=1").get().status, "todo", "card untouched");
    t2.close();
  } finally { db.close(); }
});

test("emitted client script parses as JavaScript in both board modes", async () => {
  // The client script is emitted from a template literal, where a single-escaped
  // sequence like '\n' becomes a REAL newline inside a quoted string in the
  // browser — one SyntaxError kills the whole script: no bb-js class (the no-JS
  // move buttons stay visible), no card-click drawer, no filters. Caught live on
  // r4 2026-08-11 (Configure-drawer split('\n')). Parse what we actually serve.
  const { clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js");
  for (const [label, js] of [
    ["kanban", clientJs("scout", "kanban", 7, null, null, "en")],
    ["tracker", clientJs("scout", "custom", null, "pir", [{ key: "phase", label: "Phase" }], "es")],
  ]) {
    const body = js.replace(/^<script>/, "").replace(/<\/script>$/, "");
    assert.doesNotThrow(() => new Function(body), `${label} client script must parse`);
  }
});
