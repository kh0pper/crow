/**
 * Bot Board picker (queue item 20, option A; T7) — the page title is just
 * "Bot Board", the bot is picked from a strip of chips (plain links, so it
 * works without JS) instead of a <select> printing "(kanban)"/"(none)", and a
 * bot whose board is off gets a "Turn on a board" panel instead of a
 * dead-end sentence. The bot status strip (roost) is hidden on phones.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "bot-board-picker-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

let db = null, panel = null, translations = null, botBoardStyles = null, PID = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  PID = (await createProjectSpace(db, { name: "Helper's board" })).id;
  const add = (id, name, def, pid, enabled = 1) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)",
    args: [id, name, JSON.stringify(def), enabled, pid] });
  await add("assistant", "Assistant", { gateways: [{ type: "perch" }], tracker_config: { type: "none" } }, null);
  await add("helper", "Helper", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }, PID);
  await add("noproj", "No Project Bot", { gateways: [] }, null);
  await add("sleeper", "Sleeper", {}, null, 0);

  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare("INSERT INTO tasks_items (title, project_id, parent_id, archived_at) VALUES (?,?,?,?)");
  ins.run("one", PID, null, null);
  ins.run("two", PID, null, null);
  ins.run("archived", PID, null, "2026-10-01 00:00:00");
  ins.run("subtask", PID, 1, null);
  ins.run("loose", null, null, null);
  t.close();

  ({ default: panel } = await import("../servers/gateway/dashboard/panels/bot-board.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ botBoardStyles } = await import("../servers/gateway/dashboard/panels/bot-board/css.js"));
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

async function render(query = {}, lang = "en") {
  let title = null;
  const layout = (o) => { title = o.title; return o.content; };
  const res = { redirect() {}, headersSent: false };
  const html = await panel.handler({ method: "GET", query, headers: {}, csrfToken: "tok-1" }, res, { db, layout, lang });
  return { html, title };
}

function chips(html) {
  const a = html.indexOf('<nav class="bb-chips-bots"');
  assert.ok(a >= 0, "the chip strip renders");
  return html.slice(a, html.indexOf("</nav>", a));
}

test("the layout title is exactly 'Bot Board' on every board view", async () => {
  for (const q of [{}, { bot: "helper" }, { bot: "assistant" }, { bot: "noproj" }]) {
    assert.equal((await render(q)).title, "Bot Board", JSON.stringify(q));
  }
});

test("no <select> picker and no raw '(kanban)' / '(none)'", async () => {
  for (const q of [{}, { bot: "helper" }, { bot: "assistant" }]) {
    const { html } = await render(q);
    assert.ok(!html.includes('<select id="bb-bot"'), "the native select is gone");
    // (the emitted drawer JS legitimately contains "appendChild(none)", so the
    // check is on rendered markup: the picker and any option text)
    assert.doesNotMatch(html, /<option[^>]*>[^<]*\((kanban|none|task-list)\)/);
    assert.doesNotMatch(chips(html), /\((kanban|none|task-list)\)/);
  }
});

test("one <a> chip per enabled bot, board-on bots first, the selected one aria-current", async () => {
  const strip = chips((await render({ bot: "helper" })).html);
  assert.match(strip, /aria-label="Bot"/);
  const hrefs = [...strip.matchAll(/<a [^>]*href="\/dashboard\/bot-board\?bot=([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["helper", "assistant", "noproj"], "enabled bots only, board-on first");
  assert.match(strip, /<a class="bb-bchip on" href="\/dashboard\/bot-board\?bot=helper" aria-current="page"/);
  assert.equal((strip.match(/aria-current=/g) || []).length, 1);
});

test("board-on chips show a card count (top-level, not archived); board-off chips are dashed 'no board'", async () => {
  const strip = chips((await render({ bot: "helper" })).html);
  const helper = strip.slice(strip.indexOf("bot=helper"), strip.indexOf("</a>", strip.indexOf("bot=helper")));
  assert.match(helper, /<span class="bb-bchip-n"[^>]*>2<\/span>/);
  for (const id of ["assistant", "noproj"]) {
    const at = strip.indexOf(`bot=${id}"`);
    const open = strip.lastIndexOf("<a ", at);
    const chip = strip.slice(open, strip.indexOf("</a>", at));
    assert.match(chip, /class="bb-bchip nob"/, id);
    assert.ok(chip.includes("no board"), id);
  }
});

test("a type-none bot gets the Turn-on panel, not 'This bot has no tracker.'", async () => {
  const { html } = await render({ bot: "assistant" });
  assert.ok(!html.includes(translations["botboard.noTracker"].en));
  const form = html.slice(html.indexOf('<form method="POST" action="/dashboard/bot-builder"'));
  assert.ok(form.length > 0 && html.includes('<form method="POST" action="/dashboard/bot-builder"'), "a Turn-on form");
  assert.ok(form.includes('name="action" value="board_on"'));
  assert.ok(form.includes('name="bot_id" value="assistant"'));
  assert.ok(form.includes('name="return" value="board"'));
  assert.ok(form.includes('name="_csrf" value="tok-1"'));
  assert.ok(html.includes("Assistant has no board"));
  assert.ok(html.includes(translations["botbuilder.boardOnWarn"].en), "the effect is stated before the button");
});

test("a kanban bot with no project gets the same panel, not the noProjectLinked dead end", async () => {
  const { html } = await render({ bot: "noproj" });
  assert.ok(!html.includes(translations["botboard.noProjectLinked"].en));
  assert.ok(html.includes('name="bot_id" value="noproj"'));
  assert.ok(html.includes('name="action" value="board_on"'));
});

test("the selected bot's name is a visually hidden heading, not a repeated 'Board — <name>' title", async () => {
  const { html } = await render({ bot: "helper" });
  assert.ok(!html.includes("Board — Helper"));
  assert.match(html, /<h2 class="bb-sr">Helper<\/h2>/);
});

test("Spanish: the panel copy is translated", async () => {
  const { html } = await render({ bot: "assistant" }, "es");
  assert.ok(html.includes(translations["botboard.turnOnTitle"].es.replace("{name}", "Assistant")));
  assert.ok(chips(html).includes(translations["botboard.chipNoBoard"].es));
  assert.ok(!html.includes(translations["botboard.chipNoBoard"].en));
});

test("CSS: the chip strip scrolls inside itself; the bot status strip is hidden on phones only", () => {
  const css = botBoardStyles();
  assert.match(css, /\.bb-chips-bots\{[^}]*display:flex[^}]*overflow-x:auto/);
  assert.match(css, /@media \(max-width:\s*640px\)\s*\{[^}]*\.bb-roost\{display:none\}/);
});
