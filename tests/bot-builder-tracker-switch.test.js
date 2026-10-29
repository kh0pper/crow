/**
 * The Bot Builder "Show this bot its project's cards" switch (Advanced > Board and project).
 * Kanban and task-list read as On; none and unset read as Off. A custom-tracker bot gets no
 * switch and is never changed by a save, crafted POST included. The prompt context an On bot
 * gets is pinned byte for byte (tracker.mjs is unchanged).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import Database from "better-sqlite3";
import { decodeEntities } from "../servers/gateway/dashboard/panels/bot-builder/ui.js";

const dir = mkdtempSync(join(tmpdir(), "btb-switch-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

let db, handleBotBuilderPost, renderBotEditor, _setSourcesForTest, _setEngineStatusForTest, TC;
const BASE = { models: { default: "test-prov/model-a" }, gateways: [{ type: "perch" }], system_prompt: "x" };

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost, _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  ({ _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js"));
  TC = await import("../servers/gateway/dashboard/panels/bot-builder/tracker-choice.js");
  _setSourcesForTest({ error: null, sources: [] });
  _setEngineStatusForTest({ state: "ready", source: "test" });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models) VALUES (?,?,?)",
    args: ["test-prov", "http://127.0.0.1:1/v1", JSON.stringify([{ id: "model-a" }])] }).catch(() => {});
});
after(() => { _setSourcesForTest(null); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

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
  const res = mkRes();
  const q = { bot: botId, tab: "advanced" };
  await renderBotEditor({ method: "GET", query: q, body: {}, cookies: {}, headers: {} }, res, { db, layout: ({ content }) => content, lang, PAGE_CSS: "", botId, notice: "", q });
  return res.html;
}
async function post(body) {
  const res = mkRes();
  await handleBotBuilderPost({ body, headers: {}, cookies: {} }, res, { db });
  return res;
}


function boardForm(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const f = [...document.querySelectorAll("form")].find((x) => x.querySelector('[name="adv_section"][value="board"]'));
  assert.ok(f, "the board form renders");
  return f;
}

test("old defs map: kanban/task-list/unset on, none/custom off", () => {
  assert.equal(TC.trackerOn({ tracker_config: { type: "kanban" } }), true);
  assert.equal(TC.trackerOn({ tracker_config: { type: "task-list" } }), true);
  assert.equal(TC.trackerOn({ tracker_config: { type: "none" } }), false);
  assert.equal(TC.trackerOn({ tracker_config: {} }), true, "unset runs as kanban");
  assert.equal(TC.trackerOn({}), true);
  assert.equal(TC.trackerOn(null), true);
  assert.equal(TC.trackerOn({ tracker_config: { type: "custom", tracker_slug: "x" } }), false);
});

test("the form shows one switch, no tracker-type select and no custom inputs", async () => {
  await putBot("on-bot", { ...BASE, tracker_config: { type: "kanban" } });
  const f = boardForm(await render("on-bot"));
  const cb = f.querySelector('input[name="show_cards"]');
  assert.ok(cb && cb.hasAttribute("checked"));
  assert.equal(f.querySelector('[name="show_cards__was"]').getAttribute("value"), "on");
  for (const n of ["tracker_type", "tracker_slug", "context_fields", "queue_filter_key", "queue_filter_value"]) {
    assert.equal(f.querySelector(`[name="${n}"]`), null, n);
  }
  assert.match(await render("on-bot"), /Show this bot its project&#39;s cards|Show this bot its project's cards/);
  assert.match(await render("on-bot", "es"), /Mostrar a este bot las tarjetas de su proyecto/);
});

test("on/off save round trip", async () => {
  await putBot("rt-kanban", { ...BASE, tracker_config: { type: "kanban" } }, null);
  await putBot("rt-list", { ...BASE, tracker_config: { type: "task-list" } }, null);
  await putBot("rt-off", { ...BASE, tracker_config: { type: "none" } }, null);
  const body = async (id) => {
    const f = boardForm(await render(id));
    const b = {};
    for (const el of f.querySelectorAll("input, select")) {
      const n = el.getAttribute("name"); if (!n) continue;
      const ty = (el.getAttribute("type") || "").toLowerCase();
      if (ty === "checkbox") { if (el.hasAttribute("checked")) b[n] = el.getAttribute("value") ?? "on"; }
      else if (el.tagName === "SELECT") { const o = [...el.querySelectorAll("option")]; const s = o.find((x) => x.hasAttribute("selected")) || o[0]; b[n] = s ? (s.getAttribute("value") ?? "") : ""; }
      else if (ty !== "submit") b[n] = el.getAttribute("value") ?? "";
    }
    return b;
  };
  await putBot("rt-unset", { ...BASE }, null);
  assert.ok(boardForm(await render("rt-unset")).querySelector('input[name="show_cards"]').hasAttribute("checked"), "unset shows On");
  // untouched save changes nothing
  for (const id of ["rt-kanban", "rt-list", "rt-off", "rt-unset"]) {
    const before = await row(id);
    await post(await body(id));
    assert.equal((await row(id)).raw, before.raw, id + " untouched");
  }
  // Off for kanban and task-list
  for (const id of ["rt-kanban", "rt-list"]) {
    const b = await body(id); delete b.show_cards;
    await post(b);
    assert.equal((await row(id)).def.tracker_config.type, "none", id);
  }
  // On for the off bot writes kanban; on keeps task-list when the bot was task-list
  const b = await body("rt-off"); b.show_cards = "on";
  await post(b);
  assert.equal((await row("rt-off")).def.tracker_config.type, "kanban");
  const bu = await body("rt-unset"); delete bu.show_cards;
  await post(bu);
  assert.equal((await row("rt-unset")).def.tracker_config.type, "none", "Off on an unset bot writes none");
  const d0 = { ...BASE }; TC.applyShowCards(d0, { projectId: null, on: true });
  assert.equal(d0.tracker_config.type, "kanban", "On for an unset bot writes kanban");
  await putBot("rt-list2", { ...BASE, tracker_config: { type: "task-list" } });
  const b2 = await body("rt-list2"); b2.project_id = ""; // keep On, nothing changed
  await post(b2);
  assert.equal((await row("rt-list2")).def.tracker_config.type, "task-list");
  assert.equal(TC.applyShowCards({ tracker_config: { type: "task-list" } }, { projectId: 3, on: true }), true);
  const d = { tracker_config: { type: "task-list" } }; TC.applyShowCards(d, { projectId: 3, on: true });
  assert.equal(d.tracker_config.type, "task-list"); assert.equal(d.project_id, 3);
  // project_id is kept
  const proj = Number((await db.execute({ sql: "INSERT INTO project_spaces (slug, name, type, status) VALUES ('sw-p','Sw P','general','active')", args: [] })).lastInsertRowid);
  await putBot("rt-proj", { ...BASE, tracker_config: { type: "kanban" } }, proj);
  const b3 = await body("rt-proj"); delete b3.show_cards;
  await post(b3);
  const r = await row("rt-proj");
  assert.equal(Number(r.project_id), proj);
  assert.equal(r.def.tracker_config.type, "none");
});

const CUSTOM = { type: "custom", tracker_slug: "intake", context_fields: ["a", "b"], queue_filter: { k: "v" } };

test("custom bot untouched by a save", async () => {
  await putBot("cust", { ...BASE, tracker_config: CUSTOM }, null);
  const html = await render("cust");
  const f = boardForm(html);
  assert.equal(f.querySelector('[name="show_cards"]'), null, "no switch");
  assert.match(html, /Uses a custom tracker \(intake\)\. Leave as is\./);
  assert.match(await render("cust", "es"), /Usa un registro personalizado \(intake\)\. Déjalo así\./);
  const before = await row("cust");
  // a plain save
  const b = {};
  for (const el of f.querySelectorAll("input, select")) {
    const n = el.getAttribute("name"); if (!n) continue;
    if (el.tagName === "SELECT") { const o = [...el.querySelectorAll("option")]; const s = o.find((x) => x.hasAttribute("selected")) || o[0]; b[n] = s ? (s.getAttribute("value") ?? "") : ""; }
    else b[n] = el.getAttribute("value") ?? "";
  }
  await post(b);
  assert.deepEqual((await row("cust")).def.tracker_config, CUSTOM);
  // crafted POSTs against a custom bot: refused or ignored, never overwrite the tracker
  for (const extra of [{ show_cards: "off" }, { show_cards: "on", show_cards__was: "off" }, { show_cards__was: "on" }, { tracker_type: "none" }]) {
    await post({ ...b, ...extra });
    assert.deepEqual((await row("cust")).def.tracker_config, CUSTOM, JSON.stringify(extra));
  }
  // the legacy tracker tab post is guarded the same way
  await putBot("leg-k", { ...BASE, tracker_config: { type: "kanban" } });
  await post({ action: "save_tracker", bot_id: "leg-k", project_id: "" });
  assert.equal((await row("leg-k")).def.tracker_config.type, "none", "the legacy branch is reached (absent switch = Off)");
  await post({ action: "save_tracker", bot_id: "cust", show_cards: "off", tracker_type: "none", project_id: "" });
  assert.deepEqual((await row("cust")).def.tracker_config, CUSTOM);
  assert.equal((await row("cust")).def.tracker_config.type, "custom");
  void before;
});

test("prompt context for an On bot is byte-identical to before", async () => {
  const { getTrackerContext } = await import("../scripts/pi-bots/tracker.mjs");
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    board_id INTEGER, bot_id TEXT, assigned_bot TEXT, plan_ref TEXT,
    data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare("INSERT INTO tasks_items (title,status,priority,project_id,due_date) VALUES (?,?,?,?,?)");
  ins.run("Write plan", "pending", 1, 7, "2026-11-01"); ins.run("Ship it", "in_progress", 2, 7, null); ins.run("Done thing", "completed", 3, 7, null);
  t.close();
  // Captured from tracker.mjs before the switch existed (it is not changed by it).
  const KANBAN = "Kanban:\n  #1 [pending] Write plan\n  #2 [in_progress] Ship it\n  #3 [completed] Done thing";
  const LIST = "Task list:\n  [ ] #1 Write plan\n  [ ] #2 Ship it (in progress)\n  [ ] #3 Done thing";
  assert.equal(getTrackerContext({ tracker_config: { type: "kanban" } }, 7, process.env.CROW_TASKS_DB_PATH), KANBAN);
  assert.equal(getTrackerContext({ tracker_config: { type: "task-list" } }, 7, process.env.CROW_TASKS_DB_PATH), LIST);
  // A def saved through the switch (Off -> On, and an On bot saved Off -> On) yields the same context.
  for (const [start, want, expected] of [[{ type: "none" }, "kanban", KANBAN], [{ type: "task-list" }, "task-list", LIST]]) {
    const d = { ...BASE, tracker_config: { ...start, tracker_slug: undefined } };
    TC.applyShowCards(d, { projectId: 7, on: true });
    assert.equal(d.tracker_config.type, want);
    assert.equal(getTrackerContext(d, 7, process.env.CROW_TASKS_DB_PATH), expected);
  }
});
