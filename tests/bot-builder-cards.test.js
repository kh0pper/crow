/**
 * Bot Builder cards (queue item 20, option B; T2/T3) — the bot list is one
 * compact card per bot (large initial avatar, name + status dot, purpose,
 * model chip, "updated N ago", a No board chip, Chat / Edit / ⋯ along the
 * bottom) in a grid that ends in a dashed "+ New bot" tile, instead of a
 * stacked key/value table. Raw ids and model keys only on hover; empty fields
 * are left out; every action the table offered stays reachable through the
 * card or its ⋯ popover menu.
 *
 * Fixture mirrors the five bot shapes a real install carries: three with no
 * tracker and no project, one kanban bot with a project, one of type none.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-cards-"));
process.env.CROW_DATA_DIR = dir;

let db = null, renderBotList = null, translations = null, PROJECT_ID = null;

const BOTS = [
  ["alpha-home", "Alpha Home", { models: { default: "crow-chat/qwen3.6-35b-a3b" }, gateways: [{ type: "companion", device_id: "d1" }] }],
  ["beta-home", "Beta Home", { models: { default: "zai/glm-5.1" }, gateways: [] }],
  ["gamma-glasses", "Gamma Glasses", { models: { default: "crow-voice/qwen3.5-4b" }, gateways: [{ type: "glasses", device_id: "d2" }] }],
  ["helper", "Helper", { models: { default: "crow-chat/qwen3.6-35b-a3b" }, gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }],
  ["assistant", "Assistant", { models: { default: "zai/glm-5.1" }, gateways: [{ type: "perch" }], tracker_config: { type: "none" } }],
];

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  await db.execute({ sql: "DELETE FROM providers", args: [] });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: ["crow-chat", "http://127.0.0.1:9999/v1", JSON.stringify([{ id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B (local, chat)" }])] });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: ["zai", "http://127.0.0.1:9998/v1", JSON.stringify([{ id: "glm-5.1", name: "Z.AI GLM-5.1" }])] });
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  PROJECT_ID = (await createProjectSpace(db, { name: "Helper's board" })).id;
  for (const [id, name, def] of BOTS) {
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at) VALUES (?,?,?,1,?,datetime('now','-9 days'))",
      args: [id, name, JSON.stringify(def), id === "helper" ? PROJECT_ID : null],
    });
  }
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

async function render(lang = "en", { csrf = "tok123" } = {}) {
  const res = { html: null, send(h) { this.html = h; return this; }, redirectAfterPost() {} };
  const headers = lang === "es" ? { cookie: "crow_lang=es" } : {};
  await renderBotList(res, { db, layout: ({ content }) => content, notice: "", PAGE_CSS: "", req: { headers, csrfToken: csrf } });
  return res.html;
}

/** The list section only (the run monitor below is a table on purpose). */
function listPart(html) {
  const a = html.indexOf('class="btb-cards"');
  assert.ok(a >= 0, "the card grid must render");
  const b = html.indexOf("<turbo-stream-source");
  return html.slice(html.lastIndexOf("<", a), b > a ? b : undefined);
}

/** One card's markup, from its opening tag to the next card (or the New tile). */
function rowOf(html, botId) {
  const list = listPart(html);
  const at = list.indexOf(`data-bot="${botId}"`);
  assert.ok(at >= 0, `card for ${botId}`);
  const start = list.lastIndexOf("<div", at);
  const ends = [list.indexOf('class="btb-botcard"', at), list.indexOf('class="btb-botcard-new"', at)].filter((n) => n > 0);
  const next = ends.length ? Math.min(...ends) : -1;
  return list.slice(start, next > 0 ? list.lastIndexOf("<", next) : undefined);
}

const visibleText = (h) => h.replace(/<[^>]*>/g, " ");

test("one .btb-botcard per bot in a role=list grid, no table, and no option-A rows", async () => {
  const html = await render();
  const list = listPart(html);
  assert.match(list, /<div class="btb-cards" role="list">/);
  assert.equal((list.match(/class="btb-botcard"/g) || []).length, BOTS.length);
  assert.ok(!list.includes("<table"), "the list is cards, not a table");
  assert.ok(!html.includes("btb-row"), "the option-A rows are gone");
  // five bot cards plus the New bot tile, all list items of the grid
  assert.equal((list.match(/role="listitem"/g) || []).length, BOTS.length + 1);
  assert.ok(html.includes("window.__btbRowMenu"), "the ⋯ menu script ships with the list");
});

test("each card: a large initial avatar, then the name block; Chat / Edit / ⋯ in a footer at the bottom", async () => {
  const card = rowOf(await render(), "helper");
  assert.match(card, /<div class="btb-botcard-top"><span class="btb-av btb-av-l btb-hue-\d" aria-hidden="true">H<\/span>/);
  const foot = card.indexOf('class="btb-botcard-foot"');
  assert.ok(foot > card.indexOf('class="btb-botcard-meta"'), "the footer comes after the meta line");
  for (const bit of ['href="/dashboard/perch?bot=helper"', 'href="/dashboard/bot-builder?bot=helper&tab=ai"', 'class="btb-more"']) {
    assert.ok(card.indexOf(bit) > foot, `${bit} sits in the footer`);
  }
  assert.ok(card.indexOf('class="btb-menu') > card.indexOf('class="btb-more"'), "the menu follows its trigger");
});

test("the grid ends in a dashed + New bot tile linking to the wizard", async () => {
  const list = listPart(await render());
  const tile = list.slice(list.indexOf('class="btb-botcard-new"'));
  assert.ok(list.indexOf('class="btb-botcard-new"') > list.lastIndexOf('class="btb-botcard"'), "the tile is last");
  assert.match(tile, /<a class="btb-botcard-new-link" href="\/dashboard\/bot-builder\?new=1">/);
  assert.ok(tile.includes(translations["botbuilder.rowNewBot"].en));
  assert.ok(tile.includes(translations["botbuilder.newTileHint"].en));
});

test("the bot id is never visible text — only in title= and hrefs", async () => {
  const html = await render();
  for (const [id, name] of BOTS) {
    const row = rowOf(html, id);
    assert.ok(row.includes(name), `${id}: display name visible`);
    assert.ok(row.includes(`title="${id}"`), `${id}: id on hover`);
    // ids that are also plain words ("helper", "assistant") are part of the
    // display name; check the hyphenated ids, which no name contains.
    if (id.includes("-")) assert.ok(!visibleText(row).includes(id), `${id}: id leaked into visible text`);
  }
});

test("no dashes for empty fields; friendly model visible with the raw key on hover; updated N days ago", async () => {
  const html = await render();
  for (const [id] of BOTS) assert.ok(!visibleText(rowOf(html, id)).includes("—"), `${id}: no em dash placeholder`);
  const alpha = rowOf(html, "alpha-home");
  assert.match(alpha, /<span class="btb-mchip" title="crow-chat\/qwen3\.6-35b-a3b">Qwen3\.6 35B A3B<\/span>/);
  assert.ok(!visibleText(alpha).includes("crow-chat/"), "the raw key is not visible text");
  assert.ok(visibleText(rowOf(html, "beta-home")).includes("Z.AI GLM-5.1"));
  assert.ok(visibleText(rowOf(html, "gamma-glasses")).includes("qwen3.5-4b"), "unknown provider falls back to the model id");
  assert.ok(alpha.includes("updated 9 days ago"));
});

test("purpose line: from the channels; left out when there is nothing to say", async () => {
  const html = await render();
  assert.ok(rowOf(html, "alpha-home").includes("AI Companion on a display"));
  assert.ok(rowOf(html, "gamma-glasses").includes("Voice assistant on your glasses"));
  assert.ok(rowOf(html, "helper").includes("Chats in Perch"));
  assert.ok(!rowOf(html, "beta-home").includes("btb-botcard-purpose"), "no channel, no board: no purpose line");
});

test("Chat only for perch-attached bots", async () => {
  const html = await render();
  for (const id of ["helper", "assistant"]) {
    assert.ok(rowOf(html, id).includes(`href="/dashboard/perch?bot=${id}"`), `${id}: Chat link`);
  }
  for (const id of ["alpha-home", "beta-home", "gamma-glasses"]) {
    assert.ok(!rowOf(html, id).includes("/dashboard/perch?bot="), `${id}: no Chat`);
  }
});

test("the ⋯ menu: a role=menu popover, hidden, Edit and Delete… on every card", async () => {
  const html = await render();
  for (const [id] of BOTS) {
    const row = rowOf(html, id);
    assert.match(row, /<button type="button" class="btb-more"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/, `${id}: trigger`);
    assert.match(row, /<div class="btb-menu btb-pop" id="[^"]+" role="menu" hidden>/, `${id}: menu starts hidden`);
    assert.ok(row.includes(`href="/dashboard/bot-builder?bot=${id}&tab=ai"`), `${id}: Edit`);
    assert.ok(row.includes(`href="/dashboard/bot-builder?bot=${id}&confirm_delete=1"`), `${id}: Delete… keeps its confirmation page`);
    // PR 2: the board-on bot's "Give a task…" opens the give dialog
    // (tests/bot-builder-give-task.test.js); the others link to their board.
    if (id === "helper") assert.ok(row.includes('class="btb-give-task" data-bot-id="helper"'), `${id}: Give a task… dialog`);
    else assert.ok(row.includes(`href="/dashboard/bot-board?bot=${id}"`), `${id}: Give a task…`);
  }
});

test("the ⋯ menu: Open board for the board-on bot only; a Turn-on form for the others", async () => {
  const html = await render();
  const helper = rowOf(html, "helper");
  assert.ok(helper.includes(">Open board<"), "helper: Open board");
  assert.ok(!helper.includes('value="board_on"'), "helper: no Turn-on form");
  for (const id of ["alpha-home", "beta-home", "gamma-glasses", "assistant"]) {
    const row = rowOf(html, id);
    assert.ok(!row.includes(">Open board<"), `${id}: no Open board`);
    const form = row.slice(row.indexOf("<form"), row.indexOf("</form>"));
    assert.match(form, /method="POST" action="\/dashboard\/bot-builder"/, `${id}: a POST form`);
    assert.ok(form.includes('name="action" value="board_on"'), `${id}: action=board_on`);
    assert.ok(form.includes(`name="bot_id" value="${id}"`), `${id}: bot_id`);
    assert.ok(form.includes('name="return" value="list"'), `${id}: return=list`);
    assert.ok(form.includes('name="_csrf" value="tok123"'), `${id}: CSRF input`);
  }
});

test("the Turn-on prompt says the folder moves and the bot will see its cards", async () => {
  const row = rowOf(await render(), "beta-home");
  assert.ok(row.includes(translations["botbuilder.boardOnWarn"].en), "the warning rides with the Turn-on button");
  assert.ok(translations["botbuilder.boardOnWarn"].en.includes("every chat"));
});

test("Project link only for the bot with a project", async () => {
  const html = await render();
  assert.ok(rowOf(html, "helper").includes(`href="/dashboard/projects?view=${PROJECT_ID}"`));
  for (const id of ["alpha-home", "beta-home", "gamma-glasses", "assistant"]) {
    assert.ok(!rowOf(html, id).includes("/dashboard/projects?view="), `${id}: no Project link`);
  }
});

test("a No board chip on the four bots whose board is off", async () => {
  const html = await render();
  assert.ok(!rowOf(html, "helper").includes("btb-nob"));
  for (const id of ["alpha-home", "beta-home", "gamma-glasses", "assistant"]) {
    assert.match(rowOf(html, id), /<span class="btb-nob">No board<\/span>/, id);
  }
});

test("with bots: + New bot in the toolbar, and 'New to bots?' is one quiet line UNDER the grid", async () => {
  const html = await render();
  const grid = html.indexOf('class="btb-cards"');
  assert.match(html.slice(0, grid), /<a class="btn btn-primary btn-sm" href="\/dashboard\/bot-builder\?new=1">\+ New bot<\/a>/);
  assert.ok(!html.slice(0, grid).includes(translations["botbuilder.tutorialLink"].en), "no tutorial line above the grid");
  const help = html.indexOf('<p class="btb-helpline">');
  assert.ok(help > html.indexOf('class="btb-botcard-new"'), "the line follows the grid");
  assert.match(html.slice(help), /^<p class="btb-helpline"><a href="[^"]+" target="_blank" rel="noopener">New to bots\? Read the step-by-step tutorial<\/a><\/p>/);
  assert.ok(!html.includes("btb-guide-link"), "the option-A Guide link is gone");
});

test("with no bots: the empty-state wording and the tutorial line are unchanged", async () => {
  const saved = (await db.execute({ sql: "SELECT * FROM pi_bot_defs", args: [] })).rows;
  await db.execute({ sql: "DELETE FROM pi_bot_defs", args: [] });
  try {
    const html = await render();
    assert.ok(html.includes(translations["botbuilder.emptyListWizard"].en));
    assert.ok(html.includes(translations["botbuilder.tutorialLink"].en));
    assert.ok(!html.includes('class="btb-cards"'));
    assert.ok(!html.includes('class="btb-helpline"'), "the hero carries the tutorial; no second quiet line");
  } finally {
    for (const r of saved) {
      await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at) VALUES (?,?,?,?,?,?)",
        args: [r.bot_id, r.display_name, r.definition, r.enabled, r.project_id, r.updated_at] });
    }
  }
});

test("the run monitor and Quick create stay below the list", async () => {
  const html = await render();
  assert.ok(html.includes('id="pibot-sessions-tbody"'));
  assert.ok(html.includes('value="create"'));
});

test("Spanish render carries none of the new English strings", async () => {
  const es = await render("es");
  const used = ["botbuilder.purposePerch", "botbuilder.purposeGlasses", "botbuilder.purposeCompanion",
    "botbuilder.updatedAgoDays", "botbuilder.rowNoBoard", "botbuilder.rowOpenBoard", "botbuilder.rowTurnOn",
    "botbuilder.rowGiveTask", "botbuilder.rowSessions", "botbuilder.rowProject", "botbuilder.rowDelete",
    "botbuilder.rowEdit", "botbuilder.newTileHint", "botbuilder.rowMore", "botbuilder.boardOnWarn",
    "botbuilder.dotOn"];
  for (const k of used) {
    const e = translations[k];
    assert.ok(e && e.en && e.es && e.en !== e.es, `${k} ships en+es`);
    const en = e.en.replace(/\{n\}/, "9").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(es, new RegExp("(^|[^\\p{L}])" + en + "($|[^\\p{L}])", "u"), `${k}: English "${e.en}" in the es render`);
  }
  assert.ok(es.includes("actualizado hace 9 días"));
});

test("CSS: one column on a phone, three on a wide screen; the popover renders inline on a phone", async () => {
  const { botBuilderStyles } = await import("../servers/gateway/dashboard/panels/bot-builder/css.js");
  const css = botBuilderStyles();
  assert.match(css, /\.btb-cards\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /@media\s*\(min-width:1024px\)\{[^{}]*\.btb-cards\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.btb-pop\{[^}]*position:absolute/);
  assert.match(css, /@media\s*\(max-width:640px\)\{[^{}]*\.btb-pop\{position:static/);
  assert.match(css, /\.btb-botcard-new\{[^}]*border:1px dashed/);
  assert.ok(!css.includes(".btb-row"), "the option-A row rules are gone");
});
