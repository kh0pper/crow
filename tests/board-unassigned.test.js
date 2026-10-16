/**
 * Unassigned cards (queue item 20, PR 2; T5 + T8): a card that belongs to no
 * board — `board_id IS NULL AND project_id IS NULL` — used to appear nowhere.
 * listUnassignedCards() reads them from the instance-global tasks.db only;
 * the kanban view and the Turn-on view render them as an Unassigned lane.
 *
 * Excluded: tracker items (board_id set), archived cards, subtasks
 * (parent_id), cards already on a project, and cards in a terminal status
 * (done/cancelled — the builtin def's terminals, since a project-less card
 * has no board def of its own).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-unassigned-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

let createDbClient, listUnassignedCards, db, panel, translations, PID;
const ids = {};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare("INSERT INTO tasks_items (title, project_id, board_id, parent_id, archived_at, status, assigned_bot, priority, tags) VALUES (?,?,?,?,?,?,?,?,?)");
  const add = (k, o) => { ids[k] = Number(ins.run(o.title || k, o.project ?? null, o.board ?? null, o.parent ?? null, o.archived ?? null, o.status || "pending", o.bot ?? null, o.priority ?? 3, o.tags ?? null).lastInsertRowid); };
  add("loose", { tags: "home,urgent" });
  add("item", { board: 4 });
  add("archived", { archived: "2026-10-01 00:00:00" });
  add("sub", { parent: 1 });
  add("onboard", { project: 9 });
  add("given", { bot: "hank" });
  add("done", { status: "done" });
  add("cancelled", { status: "cancelled" });
  add("doing", { status: "in_progress", priority: 1 });
  t.close();
  ({ createDbClient } = await import("../servers/db.js"));
  ({ listUnassignedCards } = await import("../servers/gateway/dashboard/panels/bot-board/data-queries.js"));

  // crow.db side, for the panel renders (T8/T9): a board-on Perch bot, a
  // board-on bot with no Perch channel, and two board-off bots.
  db = createDbClient();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  PID = (await createProjectSpace(db, { name: "Hank's board" })).id;
  const PID2 = (await createProjectSpace(db, { name: "Glassy's board" })).id;
  const addBot = (id, name, def, pid) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [id, name, JSON.stringify(def), pid] });
  await addBot("hank", "Hank", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }, PID);
  await addBot("glassy", "Glassy", { gateways: [{ type: "glasses" }] }, PID2);
  await addBot("assistant", "Assistant", { gateways: [{ type: "perch" }], tracker_config: { type: "none" } }, null);
  await addBot("noproj", "No Project", { gateways: [] }, null);
  ({ default: panel } = await import("../servers/gateway/dashboard/panels/bot-board.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});
after(() => { try { db && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

async function render(query = {}, lang = "en") {
  const layout = (o) => o.content;
  const res = { redirect() {}, headersSent: false };
  return panel.handler({ method: "GET", query, headers: {}, csrfToken: "tok-1" }, res, { db, layout, lang });
}

/** The element opened at `start` (a "<div" index), up to its matching </div>. */
function elementAt(html, start) {
  let depth = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  for (let m; (m = re.exec(html));) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (!depth) return html.slice(start, m.index + 6);
  }
  return html.slice(start);
}
function lane(html) {
  const a = html.indexOf('data-col="__unassigned"');
  if (a < 0) return null;
  return elementAt(html, html.lastIndexOf("<div", a));
}

async function list() {
  const tdb = createDbClient(process.env.CROW_TASKS_DB_PATH);
  try { return await listUnassignedCards(tdb); } finally { tdb.close(); }
}

test("a top-level card with no board and no project is unassigned", async () => {
  const rows = await list();
  const loose = rows.find((r) => Number(r.id) === ids.loose);
  assert.ok(loose, "the loose card is listed");
  assert.equal(loose.title, "loose");
  assert.equal(loose.tags, "home,urgent");
  assert.ok(loose.created_at, "carries created_at for the 'added N ago' line");
});

test("tracker items, archived cards, subtasks and cards on a project are not", async () => {
  const got = new Set((await list()).map((r) => Number(r.id)));
  for (const k of ["item", "archived", "sub", "onboard"]) assert.ok(!got.has(ids[k]), k + " must not be listed");
});

test("cards in a terminal status (done, cancelled) are not", async () => {
  const got = new Set((await list()).map((r) => Number(r.id)));
  assert.ok(!got.has(ids.done));
  assert.ok(!got.has(ids.cancelled));
  assert.ok(got.has(ids.doing), "a non-terminal status other than pending still counts");
});

test("a card with assigned_bot but no project is still unassigned and carries the bot", async () => {
  const given = (await list()).find((r) => Number(r.id) === ids.given);
  assert.ok(given);
  assert.equal(given.assigned_bot, "hank");
});

test("ordered by priority, then id", async () => {
  const rows = await list();
  assert.equal(Number(rows[0].id), ids.doing, "priority 1 first");
  const rest = rows.slice(1).map((r) => Number(r.id));
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
});

// ---- T8: the Unassigned lane on the board ----

test("on a board-on bot's kanban board the lane is the FIRST child of #bb-board", async () => {
  const html = await render({ bot: "hank" });
  const b = html.indexOf('id="bb-board"');
  assert.ok(b > 0);
  const firstChild = html.indexOf("<div", html.indexOf(">", b));
  assert.match(html.slice(firstChild, firstChild + 200), /^<div class="bb-lane-un" id="bb-col-un" data-col="__unassigned"/);
});

test("the lane is not a status column: no bb-col class, so it is never a drop target or a filter count", async () => {
  const l = lane(await render({ bot: "hank" }));
  assert.ok(!/class="bb-col[ "]/.test(l.slice(0, l.indexOf(">"))));
  assert.ok(!l.includes('class="bb-card'), "its cards are not status-board cards either");
});

test("each unassigned card: title, tags, 'added N ago', data-card-id and a Give to… button", async () => {
  const l = lane(await render({ bot: "hank" }));
  const n = (l.match(/class="bb-un-card"/g) || []).length;
  assert.equal(n, 3, "loose, given, doing");
  const card = l.slice(l.indexOf(`data-card-id="${ids.loose}"`));
  assert.match(l, new RegExp(`<div class="bb-un-card" data-card-id="${ids.loose}">`));
  assert.ok(card.includes(">loose<"));
  assert.ok(card.includes(">home<") && card.includes(">urgent<"), "tags as pills");
  assert.match(card, /added (just now|\d+ (minute|hour|day|month)s? ago)/);
  assert.match(card, new RegExp(`<button type="button" class="btn btn-secondary btn-sm bb-give-btn" data-card-id="${ids.loose}" data-card-title="loose" aria-haspopup="dialog" aria-controls="bb-give" aria-label="Give “loose” to a bot">Give to…</button>`));
});

test("a card that only carries assigned_bot says who it was last given to", async () => {
  const l = lane(await render({ bot: "hank" }));
  const at = l.indexOf(`data-card-id="${ids.given}"`);
  assert.ok(l.slice(at, l.indexOf("bb-give-btn", at)).includes("Last given to Hank"));
});

test("--bb-cols counts the lane (n+1) and the lane is the first phone tab", async () => {
  const html = await render({ bot: "hank" });
  assert.match(html, /id="bb-board" data-statuses="[^"]*" style="--bb-cols:5"/);
  const tabs = html.slice(html.indexOf('<div class="bb-lane-tabs"'));
  assert.match(tabs, /^<div class="bb-lane-tabs"[^>]*><button type="button" role="tab" id="bb-tab-un" data-lane="__unassigned" aria-controls="bb-col-un" aria-selected="false">Unassigned <span class="bb-lane-n">3<\/span><\/button>/);
});

test("the board-off (Turn-on) view shows the lane too, so its cards can go to another bot", async () => {
  for (const bot of ["assistant", "noproj"]) {
    const html = await render({ bot });
    assert.ok(html.includes('name="action" value="board_on"'), bot);
    const l = lane(html);
    assert.ok(l, bot + ": lane");
    assert.equal((l.match(/bb-give-btn/g) || []).length, 3, bot);
  }
});

// ---- T9: the Give sheet markup (server side) ----

function sheet(html) {
  const a = html.indexOf('<div class="bb-give" id="bb-give"');
  assert.ok(a >= 0, "the give sheet renders");
  return elementAt(html, a);
}

test("the give sheet: a modal dialog, hidden, titled; board-on bots as radios with data-perch, board-off bots with a Turn on form", async () => {
  const s = sheet(await render({ bot: "hank" }));
  assert.match(s, /^<div class="bb-give" id="bb-give" role="dialog" aria-modal="true" aria-labelledby="bb-give-h" hidden>/);
  assert.match(s, /<input type="radio" name="bb-give-bot" value="hank" data-perch="1" data-name="Hank">/);
  assert.match(s, /<input type="radio" name="bb-give-bot" value="glassy" data-perch="0" data-name="Glassy">/);
  assert.ok(s.indexOf('value="hank"') < s.indexOf('value="assistant"'), "board-on first");
  for (const id of ["assistant", "noproj"]) {
    assert.ok(!s.includes(`name="bb-give-bot" value="${id}"`), id + " is not pickable");
    const at = s.indexOf(`name="bot_id" value="${id}"`);
    assert.ok(at > 0, id + ": a Turn on form");
    const form = s.slice(s.lastIndexOf("<form", at), s.indexOf("</form>", at));
    assert.ok(form.includes('value="board_on"') && form.includes('name="_csrf" value="tok-1"') && form.includes('name="return" value="board"'));
  }
});

test("the give sheet: 'Add to board for later' is checked by default, 'Start now' is not", async () => {
  const s = sheet(await render({ bot: "hank" }));
  assert.match(s, /<input type="radio" name="bb-give-when" value="later" checked>/);
  assert.match(s, /<input type="radio" name="bb-give-when" value="now">/);
  assert.ok(s.includes(translations["botboard.giveNowNeedsPerch"].en), "the why-not-now hint ships (hidden)");
});

test("Spanish: the lane, its cards and the sheet carry no English", async () => {
  const html = await render({ bot: "hank" }, "es");
  const l = lane(html), s = sheet(html);
  for (const k of ["botboard.unassignedLane", "botboard.giveTo", "botboard.giveLater", "botboard.giveNow", "botboard.giveWhichBot"]) {
    assert.ok((l + s).includes(translations[k].es), k);
    assert.ok(!(l + s).includes(">" + translations[k].en + "<"), k + " (en)");
  }
  assert.match(l, /añadida (ahora mismo|hace)/);
});

test("with no unassigned cards: no lane, --bb-cols back to n, no lane tab; the board-off view keeps a one-line hint", async () => {
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE project_id IS NULL AND board_id IS NULL").run();
  t.close();
  const html = await render({ bot: "hank" });
  assert.equal(lane(html), null);
  assert.match(html, /style="--bb-cols:4"/);
  assert.ok(!html.includes('id="bb-tab-un"'));
  assert.ok(!html.includes(translations["botboard.unassignedHint"].en), "no hint on a board-on board");
  const off = await render({ bot: "assistant" });
  assert.equal(lane(off), null);
  assert.ok(off.includes(translations["botboard.unassignedHint"].en));
});
