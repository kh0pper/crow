/**
 * Bot Board picker (queue item 20, option B; T7) — the page title is just
 * "Bot Board"; the bot is picked from a name BUTTON (avatar + name + ▾) that
 * opens a sheet listing the bots with their card counts (a <details>, so it
 * works without JS; a bottom sheet on a phone, a popover on wide), instead of
 * a <select> printing "(kanban)"/"(none)". Bots whose board is off show "No
 * board yet" + a Turn on form in the sheet, and get a "Turn on a board" panel
 * on the page instead of a dead-end sentence. On a phone the lanes become
 * tabs; the bot status strip (roost) is hidden on phones.
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

let db = null, panel = null, translations = null, botBoardStyles = null, PID = null, PID2 = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  PID = (await createProjectSpace(db, { name: "Helper's board" })).id;
  PID2 = (await createProjectSpace(db, { name: "Solo's board" })).id;
  const add = (id, name, def, pid, enabled = 1) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)",
    args: [id, name, JSON.stringify(def), enabled, pid] });
  await add("assistant", "Assistant", { gateways: [{ type: "perch" }], tracker_config: { type: "none" } }, null);
  await add("helper", "Helper", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }, PID);
  await add("noproj", "No Project Bot", { gateways: [] }, null);
  await add("sleeper", "Sleeper", {}, null, 0);
  await add("solo", "Solo", { gateways: [], tracker_config: { type: "kanban" } }, PID2);
  await add("tinker", "Tinker", { gateways: [], tracker_config: { type: "custom" } }, null);

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
  ins.run("solo card", PID2, null, null);
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

function picker(html) {
  const a = html.indexOf('<details class="bb-picker"');
  assert.ok(a >= 0, "the picker renders");
  return html.slice(a, html.indexOf("</details>", a));
}
function sheetRow(html, id) {
  const p = picker(html);
  const at = p.indexOf(`bot=${id}"`);
  assert.ok(at >= 0, `a sheet row for ${id}`);
  const open = p.lastIndexOf("<li", at);
  return p.slice(open, p.indexOf("</li>", at));
}

test("the layout title is exactly 'Bot Board' on every board view", async () => {
  for (const q of [{}, { bot: "helper" }, { bot: "assistant" }, { bot: "noproj" }]) {
    assert.equal((await render(q)).title, "Bot Board", JSON.stringify(q));
  }
});

test("no <select> picker, no chip strip, and no raw '(kanban)' / '(none)'", async () => {
  for (const q of [{}, { bot: "helper" }, { bot: "assistant" }]) {
    const { html } = await render(q);
    assert.ok(!html.includes('<select id="bb-bot"'), "the native select is gone");
    assert.ok(!html.includes("bb-chips-bots"), "the option-A chip strip is gone");
    // (the emitted drawer JS legitimately contains "appendChild(none)", so the
    // check is on rendered markup: the picker and any option text)
    assert.doesNotMatch(html, /<option[^>]*>[^<]*\((kanban|none|task-list)\)/);
    assert.doesNotMatch(picker(html), /\((kanban|none|task-list)\)/);
  }
});

test("the name button: avatar + the selected bot's name + ▾, as the <summary> of a closed <details>", async () => {
  const p = picker((await render({ bot: "helper" })).html);
  assert.match(p, /^<details class="bb-picker">/, "closed by default");
  const sum = p.slice(p.indexOf("<summary"), p.indexOf("</summary>"));
  assert.match(sum, /^<summary class="bb-pick-btn"><span class="bb-pick-av bb-hue-\d" aria-hidden="true">H<\/span>/);
  assert.match(sum, /<span class="bb-sr">Bot: <\/span><span class="bb-pick-name">Helper<\/span>/);
  assert.match(sum, /<span class="bb-pick-car" aria-hidden="true">▾<\/span>$/);
});

test("the sheet: a titled list, one plain link per enabled bot, board-on bots first, the selected one aria-current", async () => {
  const p = picker((await render({ bot: "helper" })).html);
  assert.match(p, /<div class="bb-sheet" role="group" aria-labelledby="bb-sheet-h"><p class="bb-sheet-h" id="bb-sheet-h">Show the board for…<\/p>/);
  const hrefs = [...p.matchAll(/<a [^>]*href="\/dashboard\/bot-board\?bot=([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["helper", "solo", "assistant", "noproj", "tinker"], "enabled bots only, board-off last");
  assert.match(sheetRow((await render({ bot: "helper" })).html, "helper"), /<a class="bb-pick-row on" href="\/dashboard\/bot-board\?bot=helper" aria-current="page"/);
  assert.equal((p.match(/aria-current=/g) || []).length, 1);
});

test("board-on rows show a card count (top-level, not archived), singular and plural", async () => {
  const { html } = await render({ bot: "helper" });
  assert.match(sheetRow(html, "helper"), /<small>2 cards<\/small>/);
  assert.match(sheetRow(html, "solo"), /<small>1 card<\/small>/);
});

test("board-off rows: 'No board yet' and a Turn on form (CSRF, return=board); a custom bot with no slug links to Edit", async () => {
  const { html } = await render({ bot: "helper" });
  for (const id of ["assistant", "noproj"]) {
    const row = sheetRow(html, id);
    assert.match(row, /^<li class="bb-pick-row nob">/, id);
    assert.ok(row.includes("<small>No board yet</small>"), id);
    const form = row.slice(row.indexOf("<form"), row.indexOf("</form>"));
    assert.match(form, /method="POST" action="\/dashboard\/bot-builder"/, id);
    assert.ok(form.includes('name="action" value="board_on"'), id);
    assert.ok(form.includes(`name="bot_id" value="${id}"`), id);
    assert.ok(form.includes('name="return" value="board"'), id);
    assert.ok(form.includes('name="_csrf" value="tok-1"'), id);
    assert.ok(form.includes(">Turn on</button>"), id);
  }
  const tinker = sheetRow(html, "tinker");
  assert.ok(!tinker.includes("<form"), "custom with no slug: no Turn on form");
  assert.ok(tinker.includes('href="/dashboard/bot-builder?bot=tinker&tab=tracker"'));
  const p = picker(html);
  assert.ok(p.includes(translations["botbuilder.boardOnWarn"].en), "the Turn on effect is stated in the sheet");
});

test("with an unknown ?bot the button reads 'Choose a bot'", async () => {
  const p = picker((await render({ bot: "nope" })).html);
  assert.match(p, /<span class="bb-pick-name">Choose a bot<\/span>/);
  assert.equal((p.match(/aria-current=/g) || []).length, 0);
});

test("the picker script: bound once, closes on Escape (focus back to the button) and on an outside click; no backticks", async () => {
  const { html } = await render({ bot: "helper" });
  const m = html.match(/<script>(\(function\(\)\{\s*if \(window\.__bbPicker\)[\s\S]*?)<\/script>/);
  assert.ok(m, "the picker script ships with the board");
  assert.ok(!m[1].includes("`"));
  assert.doesNotThrow(() => new Function(m[1]));
  assert.ok(m[1].includes("'Escape'"));
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

test("a failed Turn on lands back here with its error shown, escaped", async () => {
  const { html } = await render({ bot: "assistant", error: "Can't link <b>x</b> & \"y\"" });
  assert.ok(html.includes('<p class="bb-msg err">Can&#39;t link &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</p>') ||
    html.includes('<p class="bb-msg err">Can\'t link &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</p>'), "the error, escaped");
  assert.ok(!html.includes("<b>x</b>"), "never raw");
  assert.ok(html.includes('name="action" value="board_on"'), "the Turn-on panel is still there to retry");
  const { html: clean } = await render({ bot: "assistant" });
  assert.ok(!clean.includes('class="bb-msg err"'), "no error, no message");
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

test("on the kanban board: lane tabs (hidden until the script runs), one per column with its count", async () => {
  const { html } = await render({ bot: "helper" });
  const a = html.indexOf('<div class="bb-lane-tabs"');
  assert.ok(a >= 0, "lane tabs render");
  const tabs = html.slice(a, html.indexOf("</div>", a));
  assert.match(tabs, /^<div class="bb-lane-tabs" role="tablist" aria-label="Lanes" hidden>/);
  const ids = [...tabs.matchAll(/<button type="button" role="tab" id="bb-tab-(\d+)" data-lane="([^"]+)" aria-controls="bb-col-(\d+)" aria-selected="false">/g)].map((m) => m[2]);
  assert.deepEqual(ids, ["pending", "in_progress", "done", "cancelled"], "every column the board shows, incl. the default def's cancelled");
  // the same count the column header shows (the board lists sub-cards too)
  assert.match(tabs, /data-lane="pending"[^>]*>Pending <span class="bb-lane-n">3<\/span><\/button>/);
  assert.match(html, /<div class="bb-col" id="bb-col-0" data-col="pending"/);
  assert.ok(html.indexOf("bb-lane-tabs") < html.indexOf('id="bb-board"'), "the tabs sit above the board");
  assert.match(html, /if \(window\.__bbLaneTabs\)/, "the lane-tab script ships with the board");
});

test("Spanish: the panel copy is translated", async () => {
  const { html } = await render({ bot: "assistant" }, "es");
  assert.ok(html.includes(translations["botboard.turnOnTitle"].es.replace("{name}", "Assistant")));
  const p = picker(html);
  for (const k of ["botboard.pickerNoBoard", "botboard.pickerTitle", "botboard.pickerTurnOn"]) {
    assert.ok(p.includes(translations[k].es), `${k}: es`);
    assert.ok(translations[k].en !== translations[k].es && !html.includes(">" + translations[k].en + "<"), `${k}: no English`);
  }
});

test("CSS: a bottom sheet on a phone, a popover on wide; lane tabs on phones only; the status strip hidden on phones only", () => {
  const css = botBoardStyles();
  assert.match(css, /\.bb-sheet\{[^}]*position:absolute/);
  assert.match(css, /@media \(max-width:640px\)\{[^]*?\.bb-sheet\{position:fixed;left:0;right:0;bottom:0/);
  assert.match(css, /@media \(max-width:640px\)\{[^]*?\.bb-board\.bb-tabbed \.bb-col:not\(\.bb-lane-cur\)\{display:none\}/);
  assert.match(css, /@media \(min-width:641px\)\{\.bb-lane-tabs\{display:none !important\}\}/);
  assert.match(css, /@media \(max-width:\s*640px\)\s*\{[^}]*\.bb-roost\{display:none\}/);
});
