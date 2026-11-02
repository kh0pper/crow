// The tracker/project pickers after the switch: both archive markers hide a project from the
// Bot Builder project picker (the board list half lives in tests/board-mcp.test.js), a bot already linked to an archived project
// stays linked, the legacy tracker save moves the link without touching the tracker, and a
// custom tracker with no slug has copy instead of "(?)". Scratch env only; never touches ~/.crow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";

const dir = mkdtempSync(join(tmpdir(), "tracker-pickers-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

const BASE = { models: { default: "test-prov/model-a" }, gateways: [{ type: "perch" }], system_prompt: "x" };

let db, handleBotBuilderPost, renderBotEditor, _setSourcesForTest, _setEngineStatusForTest;
let liveId, statusArchivedId, deletedId;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();


  const project = async (slug, name, status, archivedAt) => Number((await db.execute({
    sql: "INSERT INTO project_spaces (slug, name, type, status, archived_at) VALUES (?,?,?,?,?)",
    args: [slug, name, "general", status, archivedAt],
  })).lastInsertRowid);
  liveId = await project("tp-live", "TP Live", "active", null);
  statusArchivedId = await project("tp-status", "TP Status Archived", "archived", null);
  deletedId = await project("tp-deleted", "TP Deleted", "active", "2026-10-01 00:00:00");

  ({ handleBotBuilderPost, _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  ({ _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js"));
  _setSourcesForTest({ error: null, sources: [] });
  _setEngineStatusForTest({ state: "ready", source: "test" });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES (?,?,?)",
    args: ["test-prov", "http://127.0.0.1:1/v1", JSON.stringify([{ id: "model-a" }])] }).catch(() => {});

});

after(async () => {
  _setSourcesForTest(null);
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function putBot(botId, def, projectId = null) {
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [botId, "Bot " + botId, JSON.stringify(def), projectId] });
}
async function row(botId) {
  const r = (await db.execute({ sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
  return { def: JSON.parse(r.definition), project_id: r.project_id, raw: r.definition };
}
const mkRes = () => {
  const res = { html: null, redirected: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = (u) => { res.redirected = u; };
  return res;
};
async function render(botId, lang = "en") {
  // The legacy ?tab=tracker alias lands on Advanced with the Board section open.
  const res = mkRes();
  const q = { bot: botId, tab: "tracker" };
  await renderBotEditor({ method: "GET", query: q, body: {}, cookies: {}, headers: {} }, res, { db, layout: ({ content }) => content, lang, PAGE_CSS: "", botId, notice: "", q });
  return res.html;
}
async function post(body) {
  const res = mkRes();
  await handleBotBuilderPost({ body, headers: {}, cookies: {} }, res, { db });
  return res;
}
function projectSelect(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const sel = document.querySelector('select[name="project_id"]');
  assert.ok(sel, "the project picker renders");
  return sel;
}
const optionValues = (sel) => [...sel.querySelectorAll("option")].map((o) => o.getAttribute("value"));

// F9.1 — the Bot Builder project picker
test("the project picker lists only the live project", async () => {
  await putBot("tp-picker", { ...BASE, tracker_config: { type: "kanban" } }, liveId);
  const values = optionValues(projectSelect(await render("tp-picker")));
  assert.ok(values.includes(String(liveId)), "the live project is offered");
  assert.ok(!values.includes(String(statusArchivedId)), "a status-archived project is hidden");
  assert.ok(!values.includes(String(deletedId)), "a project with archived_at set is hidden");
});

test("a bot linked to a status-archived project still shows it selected", async () => {
  await putBot("tp-linked", { ...BASE, tracker_config: { type: "kanban" } }, statusArchivedId);
  const sel = projectSelect(await render("tp-linked"));
  const selected = sel.querySelector("option[selected]");
  assert.ok(selected, "the linked project stays selected");
  assert.equal(selected.getAttribute("value"), String(statusArchivedId));
  assert.match(selected.textContent, /\(archived\)/);
});

// F2 / F9.3 — the legacy tracker save
test("a legacy tracker save without show_cards__was moves the link and leaves the tracker alone", async () => {
  await putBot("tp-legacy", { ...BASE, tracker_config: { type: "task-list", queue_filter: { k: "v" } } }, statusArchivedId);
  await post({ action: "save_tracker", bot_id: "tp-legacy", project_id: String(liveId) });
  const r = await row("tp-legacy");
  assert.equal(r.def.tracker_config.type, "task-list", "the tracker type is not rewritten");
  assert.deepEqual(r.def.tracker_config, { type: "task-list", queue_filter: { k: "v" } }, "the tracker is untouched");
  assert.equal(Number(r.project_id), liveId, "the project link moves");
  assert.equal(Number(r.def.project_id), liveId, "the JSON copy stays in step with the column");
});

// F9.4 / F1 — the custom tracker with no slug
test("a custom tracker with no slug renders the no-slug copy, not a placeholder", async () => {
  await putBot("tp-custom", { ...BASE, tracker_config: { type: "custom" } }, null);
  const html = await render("tp-custom");
  assert.match(html, /Uses a custom tracker with no board chosen\. Leave as is\./);
  assert.doesNotMatch(html, /\(\?\)/, "no (?) placeholder reaches the page");
});
