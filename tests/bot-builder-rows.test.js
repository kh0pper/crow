/**
 * Bot Builder rows (queue item 20, option A; T2/T3) — the bot list is one
 * row per bot (avatar, name, status dot, purpose, friendly model, "updated
 * N ago", Chat / Edit / ⋯) instead of a stacked key/value table. Raw ids and
 * model keys only on hover; empty fields are left out; every action the
 * table offered stays reachable through the row or its ⋯ menu.
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

const dir = mkdtempSync(join(tmpdir(), "btb-rows-"));
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
  const a = html.indexOf('class="btb-rows"');
  assert.ok(a >= 0, "the rows container must render");
  const b = html.indexOf("<turbo-stream-source");
  return html.slice(html.lastIndexOf("<", a), b > a ? b : undefined);
}

/** One row's markup, from its opening tag to the next row (or the list end). */
function rowOf(html, botId) {
  const list = listPart(html);
  const at = list.indexOf(`data-bot="${botId}"`);
  assert.ok(at >= 0, `row for ${botId}`);
  const start = list.lastIndexOf("<div", at);
  const next = list.indexOf('class="btb-row"', at);
  return list.slice(start, next > 0 ? list.lastIndexOf("<div", next) : undefined);
}

const visibleText = (h) => h.replace(/<[^>]*>/g, " ");

test("one .btb-row per bot, inside a role=list container, and no table in the list", async () => {
  const html = await render();
  const list = listPart(html);
  assert.match(list, /<div class="btb-rows" role="list">/);
  assert.equal((list.match(/class="btb-row"/g) || []).length, BOTS.length);
  assert.ok(!list.includes("<table"), "the list is rows, not a table");
  assert.equal((list.match(/role="listitem"/g) || []).length, BOTS.length);
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
  assert.match(alpha, /<span title="crow-chat\/qwen3\.6-35b-a3b">Qwen3\.6 35B A3B<\/span>/);
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
  assert.ok(!rowOf(html, "beta-home").includes("btb-row-purpose"), "no channel, no board: no purpose line");
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

test("the ⋯ menu: role=menu, hidden, Edit and Delete… on every row", async () => {
  const html = await render();
  for (const [id] of BOTS) {
    const row = rowOf(html, id);
    assert.match(row, /<button type="button" class="btb-more"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/, `${id}: trigger`);
    assert.match(row, /<div class="btb-menu" id="[^"]+" role="menu" hidden>/, `${id}: menu starts hidden`);
    assert.ok(row.includes(`href="/dashboard/bot-builder?bot=${id}&tab=ai"`), `${id}: Edit`);
    assert.ok(row.includes(`href="/dashboard/bot-builder?bot=${id}&confirm_delete=1"`), `${id}: Delete… keeps its confirmation page`);
    assert.ok(row.includes(`href="/dashboard/bot-board?bot=${id}"`), `${id}: Give a task…`);
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

test("with bots: a small Guide link beside + New bot; the big tutorial line is gone", async () => {
  const html = await render();
  assert.match(html, /<a class="btb-guide-link"[^>]*target="_blank" rel="noopener"[^>]*>Guide<\/a>/);
  assert.ok(!html.includes(translations["botbuilder.tutorialLink"].en), "the long 'New to bots?' line is demoted");
  assert.ok(html.includes('href="/dashboard/bot-builder?new=1"'), "+ New bot stays");
});

test("with no bots: the empty-state wording and the tutorial line are unchanged", async () => {
  const saved = (await db.execute({ sql: "SELECT * FROM pi_bot_defs", args: [] })).rows;
  await db.execute({ sql: "DELETE FROM pi_bot_defs", args: [] });
  try {
    const html = await render();
    assert.ok(html.includes(translations["botbuilder.emptyListWizard"].en));
    assert.ok(html.includes(translations["botbuilder.tutorialLink"].en));
    assert.ok(!html.includes('class="btb-rows"'));
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
    "botbuilder.rowEdit", "botbuilder.rowGuide", "botbuilder.rowMore", "botbuilder.boardOnWarn",
    "botbuilder.dotOn"];
  for (const k of used) {
    const e = translations[k];
    assert.ok(e && e.en && e.es && e.en !== e.es, `${k} ships en+es`);
    const en = e.en.replace(/\{n\}/, "9").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(es, new RegExp("(^|[^\\p{L}])" + en + "($|[^\\p{L}])", "u"), `${k}: English "${e.en}" in the es render`);
  }
  assert.ok(es.includes("actualizado hace 9 días"));
});
