/**
 * The operator's dispatch grant: POST /card/:id/dispatch-grant on the
 * dashboard router, the grant cleared on every assignee change, GET exposing
 * it, and the card drawer's checkbox.
 *
 * Route: dashboard-auth only, CSRF-railed, human actor, a `dispatch_grant`
 * mutation; only the card's current bot can be granted; a revoke always
 * goes through. Clearing: updateCard (the single assignee writer the edit
 * route, giveCard and Perch's attach share) drops dispatch_grants whenever
 * assigned_bot changes (no MCP verb can change an existing card's assignee). UI: the emitted client parses, has no raw backtick,
 * never uses innerHTML in the grant block, and every new string has en and
 * es text.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { BOARD_PLANS_DDL, BOARD_RESULTS_DDL } from "../scripts/migrations/0004-track1-card-model.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-dispatch-grant-"));
const savedEnv = {
  CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_DB_PATH: process.env.CROW_DB_PATH, CROW_TASKS_DB_PATH: process.env.CROW_TASKS_DB_PATH,
  CROW_CSRF_STRICT: process.env.CROW_CSRF_STRICT,
};
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
delete process.env.CROW_CSRF_STRICT;
const DB_FILE = join(dir, "crow.db");
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const REPO = new URL("..", import.meta.url).pathname;

const HUMAN = { kind: "human", id: null, jobId: null };
const BOT_A = { kind: "bot", id: "bot-a", jobId: null };

let createCard, updateCard, giveCard, createDbClient, dispatchCard;
let tdb, cdb, PID_A, PID_B;
let server, base;

const rawTasks = () => new Database(TASKS);
const card = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id); t.close(); return r; };
const grantsOf = (id) => { const g = JSON.parse(card(id).data_json || "{}").dispatch_grants; return g === undefined ? null : g; };
const mutations = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM board_mutations WHERE item_id=? ORDER BY id").all(id); t.close(); return r; };
function setGrants(id, bots) {
  const t = rawTasks();
  t.prepare("UPDATE tasks_items SET data_json=json_set(data_json,'$.dispatch_grants',json(?)) WHERE id=?").run(JSON.stringify(bots), id);
  t.close();
}
function seedBot(id, project) {
  const c = new Database(DB_FILE);
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)")
    .run(id, id, JSON.stringify({ tracker_config: { type: "kanban" } }), project);
  c.close();
}
const opCard = async (fields = {}) =>
  (await createCard(tdb, { title: "op card", project_id: PID_A, assigned_bot: "bot-a", ...fields }, HUMAN)).id;

function post(path, body, headers = {}) {
  return fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
const grantReq = (id, body, headers) => post("/card/" + id + "/dispatch-grant", body, headers);

async function mount(auth) {
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter(auth));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { srv, base: "http://127.0.0.1:" + srv.address().port + "/dashboard/bot-board-api" };
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = new Database(DB_FILE);
  const mk = (slug) => Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(slug, slug).lastInsertRowid);
  PID_A = mk("a-board");
  PID_B = mk("b-board");
  c.close();
  seedBot("bot-a", PID_A);
  seedBot("bot-b", PID_B);

  const t = rawTasks();
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, project_id INTEGER,
    display_name TEXT, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]')`);
  t.exec(BOARD_PLANS_DDL);
  t.exec(BOARD_RESULTS_DDL);
  const def = t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values) VALUES (?,?,?,?)");
  for (const p of [PID_A, PID_B]) def.run(p, "b" + p, '["pending","in_progress","done"]', '["done"]');
  t.prepare("INSERT INTO board_defs (slug, display_name, status_values, terminal_values) VALUES ('trk','Trk','[\"open\"]','[]')").run();
  t.close();

  ({ createCard, updateCard } = await import("../servers/gateway/board/card-service.js"));
  ({ giveCard } = await import("../servers/gateway/board/give-service.js"));
  ({ dispatchCard } = await import("../servers/gateway/board/dispatch-service.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  tdb = createDbClient(TASKS);
  cdb = createDbClient(DB_FILE);
  ({ srv: server, base } = await mount((req, res, next) => next()));
});

after(() => {
  if (server) server.close();
  try { tdb.close(); } catch {}
  try { cdb.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ---- the route ----

test("grant then revoke: data_json toggles, each change records a human dispatch_grant row, GET exposes the grants", async () => {
  const id = await opCard();
  const r1 = await grantReq(id, { bot_id: "bot-a", granted: true });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, dispatch_grants: ["bot-a"] });
  assert.deepEqual(grantsOf(id), ["bot-a"]);

  const g1 = await (await fetch(base + "/card/" + id)).json();
  assert.deepEqual(g1.dispatch_grants, ["bot-a"], "GET exposes the grants");
  assert.ok(!Object.hasOwn(g1.card, "data_json"), "the raw blob stays off the card");
  assert.equal(g1.decision, null, "the sibling decision key is unaffected");
  assert.equal(g1.human_created, true, "an operator-created card");

  const r2 = await grantReq(id, { bot_id: "bot-a", granted: false });
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true, dispatch_grants: [] });
  assert.equal(grantsOf(id), null, "an empty grant list leaves no key behind");
  assert.deepEqual((await (await fetch(base + "/card/" + id)).json()).dispatch_grants, []);

  const rows = mutations(id).filter((m) => m.verb === "dispatch_grant");
  assert.equal(rows.length, 2);
  for (const m of rows) { assert.equal(m.actor_kind, "human"); assert.equal(m.actor_id, null); }
  assert.deepEqual(rows.map((m) => JSON.parse(m.detail_json)),
    [{ bot_id: "bot-a", granted: true }, { bot_id: "bot-a", granted: false }]);
});

test("a repeat toggle that changes nothing writes no mutation", async () => {
  const id = await opCard();
  await grantReq(id, { bot_id: "bot-a", granted: true });
  const n = mutations(id).length;
  const r = await grantReq(id, { bot_id: "bot-a", granted: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, dispatch_grants: ["bot-a"] });
  const r2 = await grantReq(await opCard(), { bot_id: "bot-a", granted: false });
  assert.equal(r2.status, 200);
  assert.equal(mutations(id).length, n);
});

test("the grant keeps every other data_json key", async () => {
  const id = await opCard();
  const t = rawTasks();
  t.prepare("UPDATE tasks_items SET data_json=? WHERE id=?").run(JSON.stringify({ keep: 1 }), id);
  t.close();
  await grantReq(id, { bot_id: "bot-a", granted: true });
  assert.deepEqual(JSON.parse(card(id).data_json), { keep: 1, dispatch_grants: ["bot-a"] });
  await grantReq(id, { bot_id: "bot-a", granted: false });
  assert.deepEqual(JSON.parse(card(id).data_json), { keep: 1 });
});

test("only the card's current bot can be granted; a revoke always goes through", async () => {
  const id = await opCard();
  const other = await grantReq(id, { bot_id: "bot-b", granted: true });
  assert.equal(other.status, 400);
  assert.equal((await other.json()).code, "not_assigned");
  const none = await opCard({ assigned_bot: null });
  assert.equal((await grantReq(none, { bot_id: "bot-a", granted: true })).status, 400);
  assert.equal(grantsOf(id), null);
  assert.equal(grantsOf(none), null);

  setGrants(id, ["bot-a", "bot-b"]); // a stale entry from before this rule
  const rev = await grantReq(id, { bot_id: "bot-b", granted: false });
  assert.equal(rev.status, 200);
  assert.deepEqual(grantsOf(id), ["bot-a"]);
});

test("unknown card, tracker item, subtask grant and archived card are refused, nothing written", async () => {
  assert.equal((await grantReq(999999, { bot_id: "bot-a", granted: true })).status, 404);
  const t = rawTasks();
  const trk = t.prepare("SELECT id FROM board_defs WHERE slug='trk'").get().id;
  const item = Number(t.prepare("INSERT INTO tasks_items (board_id, title, status, assigned_bot) VALUES (?, 'it', 'open', 'bot-a')").run(trk).lastInsertRowid);
  t.close();
  assert.equal((await grantReq(item, { bot_id: "bot-a", granted: true })).status, 404, "a tracker item is not a card");

  const parent = await opCard();
  const kid = (await createCard(tdb, { title: "kid", parent_id: parent, assigned_bot: "bot-a" }, HUMAN)).id;
  const sub = await grantReq(kid, { bot_id: "bot-a", granted: true });
  assert.equal(sub.status, 400);
  assert.equal((await sub.json()).code, "subtask");

  const arch = await opCard();
  const t2 = rawTasks();
  t2.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(arch);
  t2.close();
  const ra = await grantReq(arch, { bot_id: "bot-a", granted: true });
  assert.equal(ra.status, 409);
  assert.equal((await ra.json()).code, "archived");
  for (const x of [kid, arch]) assert.equal(grantsOf(x), null);
  assert.equal(mutations(kid).filter((m) => m.verb === "dispatch_grant").length, 0);
});

test("bad bodies are 400", async () => {
  const id = await opCard();
  for (const body of [{}, { bot_id: "bot-a" }, { bot_id: "", granted: true }, { bot_id: 5, granted: true }, { bot_id: "bot-a", granted: "yes" }]) {
    assert.equal((await grantReq(id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await grantReq("abc", { bot_id: "bot-a", granted: true })).status, 400);
  assert.equal(grantsOf(id), null);
});

test("a request without the dashboard session is refused like the sibling routes", async () => {
  const { srv, base: b } = await mount((req, res) => res.status(401).json({ error: "unauthorized" }));
  try {
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot_id: "bot-a", granted: true }) };
    const sibling = await fetch(b + "/card/1/decision", opts);
    const mine = await fetch(b + "/card/1/dispatch-grant", opts);
    assert.equal(sibling.status, 401);
    assert.equal(mine.status, sibling.status);
  } finally { srv.close(); }
});

test("a session request without the CSRF token is refused; with it, it goes through", async () => {
  const id = await opCard();
  const cookie = { cookie: "crow_session=s1; crow_csrf=tok-1" };
  const none = await grantReq(id, { bot_id: "bot-a", granted: true }, cookie);
  assert.equal(none.status, 403);
  const wrong = await grantReq(id, { bot_id: "bot-a", granted: true }, { ...cookie, "x-crow-csrf": "tok-2" });
  assert.equal(wrong.status, 403);
  assert.equal(grantsOf(id), null);
  const ok = await grantReq(id, { bot_id: "bot-a", granted: true }, { ...cookie, "x-crow-csrf": "tok-1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(grantsOf(id), ["bot-a"]);
});

// ---- clearing on every assignee change ----

test("the edit route's reassignment clears the grants (and records it); an edit that keeps the bot does not", async () => {
  const id = await opCard();
  setGrants(id, ["bot-a"]);
  const keep = await post("/card/" + id, { title: "renamed", assigned_bot: "bot-a" });
  assert.equal(keep.status, 200);
  assert.deepEqual(grantsOf(id), ["bot-a"], "same bot: grant stays");

  const r = await post("/card/" + id, { title: "renamed", assigned_bot: "bot-b" });
  assert.equal(r.status, 200);
  assert.equal(card(id).assigned_bot, "bot-b");
  assert.equal(grantsOf(id), null);
  const upd = mutations(id).filter((m) => m.verb === "update").pop();
  assert.deepEqual(JSON.parse(upd.detail_json).dispatch_grants, [["bot-a"], null]);

  const id2 = await opCard();
  setGrants(id2, ["bot-a"]);
  await post("/card/" + id2, { title: "x", assigned_bot: "" });
  assert.equal(card(id2).assigned_bot, null);
  assert.equal(grantsOf(id2), null, "unassigning clears too");
});

test("updateCard clears grants on an assignee change, from any actor", async () => {
  const id = await opCard();
  setGrants(id, ["bot-a"]);
  await updateCard(tdb, id, { assigned_bot: "bot-b" }, BOT_A);
  assert.equal(grantsOf(id), null);
  await updateCard(tdb, id, { assigned_bot: "bot-a" }, HUMAN);
  assert.equal(grantsOf(id), null, "reassigning back does not bring a grant back");
});

test("giveCard clears grants when it moves the card to another bot", async () => {
  const id = await opCard();
  setGrants(id, ["bot-a"]);
  await giveCard(tdb, cdb, { cardId: id, botId: "bot-b", actor: HUMAN });
  assert.equal(card(id).assigned_bot, "bot-b");
  assert.equal(grantsOf(id), null);
});

test("a dashboard grant is what lets a bot-created card be dispatched, once", async () => {
  const id = (await createCard(tdb, { title: "bot card", project_id: PID_A, assigned_bot: "bot-a" }, BOT_A)).id;
  assert.equal((await (await fetch(base + "/card/" + id)).json()).human_created, false, "a bot-created card");
  await assert.rejects(dispatchCard(tdb, cdb, { itemId: id, toBot: "bot-b" }, BOT_A), (e) => e.code === "not_granted");
  assert.equal((await grantReq(id, { bot_id: "bot-a", granted: true })).status, 200);
  const out = await dispatchCard(tdb, cdb, { itemId: id, toBot: "bot-b" }, BOT_A);
  assert.equal(out.to, "bot-b");
  assert.equal(grantsOf(id), null, "spent");
});

// ---- the card drawer ----

const UI_KEYS = [
  "botboard.grant.label", "botboard.grant.hint", "botboard.grant.failed", "botboard.grant.ownCard",
  "board.mutationVerb.dispatch", "board.mutationVerb.dispatch_grant",
];

test("every new string has en and es text, and the two differ", async () => {
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const k of UI_KEYS) {
    const v = translations[k];
    assert.ok(v && v.en && v.es, k + " needs en and es");
    assert.notEqual(v.en, v.es, k + " es must be a real translation");
  }
  assert.equal(translations["botboard.grant.label"].en, "Let this bot hand the card to another bot");
});

test("the emitted client parses, has no raw backtick, splices renderGrant in and labels the new verbs", async () => {
  const { clientJs } = await import("../servers/gateway/dashboard/panels/bot-board/client.js");
  const { grantJs } = await import("../servers/gateway/dashboard/panels/bot-board/grant-client.js");
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const lang of ["en", "es"]) {
    const m = clientJs("bot-1", "kanban", 9, null, null, lang, false).match(/^<script>([\s\S]*)<\/script>$/);
    assert.ok(m, "one inline script");
    const src = m[1];
    assert.ok(!src.includes("`"), "no raw backtick (" + lang + ")");
    assert.doesNotThrow(() => new Function(src), "client parses (" + lang + ")");
    assert.ok(src.includes("function renderGrant("), "renderGrant spliced in");
    assert.match(src, /renderDecision\(r\.j\.decision\);\s*renderGrant\(c,r\.j\.dispatch_grants,r\.j\.human_created===true\);/, "hydrated off the card GET");
    assert.ok(src.includes("dispatch:'") && src.includes("dispatch_grant:'"), "history labels for the new verbs");
    assert.ok(src.includes(translations["board.mutationVerb.dispatch_grant"][lang]));
    const block = grantJs(lang);
    assert.ok(!block.includes("innerHTML"), "the grant block never uses innerHTML");
    assert.ok(block.includes(translations["botboard.grant.label"][lang].replace(/'/g, "\\'")));
  }
  const es = grantJs("es");
  assert.ok(!es.includes(translations["botboard.grant.label"].en), "no English in the es emission");
});

test("the drawer has an empty #bb-d-grant mount and the stylesheet styles it", async () => {
  const { drawerMarkup } = await import("../servers/gateway/dashboard/panels/bot-board/html.js");
  const { botBoardStyles } = await import("../servers/gateway/dashboard/panels/bot-board/css.js");
  for (const lang of ["en", "es"]) {
    const html = drawerMarkup(lang);
    const at = html.indexOf('<div id="bb-d-grant"></div>');
    assert.ok(at > html.indexOf('id="bb-d-autonomy"'), "below the autonomy select");
    assert.ok(at < html.indexOf('id="bb-d-save"'), "above the save button");
  }
  assert.ok(botBoardStyles().includes(".bb-grant"));
});

// A tiny DOM: enough for renderGrant. innerHTML is a trap.
function fakeDom() {
  const byId = {};
  function el(tag) {
    const e = {
      tagName: tag, children: [], className: "", textContent: "", type: "", checked: false, disabled: false, id: "",
      appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; return c; },
      setAttribute(k, v) { this[k] = v; },
    };
    Object.defineProperty(e, "innerHTML", { set() { throw new Error("innerHTML used"); } });
    return e;
  }
  const mountEl = el("div");
  byId["bb-d-grant"] = mountEl;
  return { document: { createElement: el }, $: (id) => byId[id], mountEl, find: (id) => byId[id] };
}

async function drive(card, grants, reply, humanCreated = false) {
  const { grantJs } = await import("../servers/gateway/dashboard/panels/bot-board/grant-client.js");
  const dom = fakeDom();
  const calls = [];
  const env = {
    document: dom.document, $: dom.$,
    clearEl: (e) => { e.children = []; },
    msg: (e, t) => { if (e) e.textContent = t; },
    errText: (r, f) => (r.j && (r.j.reason || r.j.error)) || f,
    api: (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve(reply); },
    cur: { id: card ? card.id : null },
  };
  const fn = new Function(...Object.keys(env), grantJs("en") + "; return renderGrant;");
  const renderGrant = fn(...Object.values(env));
  renderGrant(card, grants, humanCreated);
  return { dom, calls, renderGrant };
}

test("the checkbox shows only for a live top-level card with a bot, reflects the grant, and posts the toggle", async () => {
  for (const c of [null, { id: 1, assigned_bot: null, parent_id: null }, { id: 1, assigned_bot: "bot-a", parent_id: 3 },
    { id: 1, assigned_bot: "bot-a", parent_id: null, archived_at: "2026-01-01" }]) {
    const { dom } = await drive(c, []);
    assert.equal(dom.mountEl.children.length, 0, JSON.stringify(c));
  }
  const { dom, calls } = await drive({ id: 7, assigned_bot: "bot-a", parent_id: null, archived_at: null }, ["bot-a"],
    { ok: true, status: 200, j: { ok: true, dispatch_grants: [] } });
  const cb = dom.find("bb-d-grant-cb");
  assert.ok(cb && cb.type === "checkbox");
  assert.equal(cb.checked, true);
  cb.checked = false;
  cb.onchange();
  assert.deepEqual(calls, [{ method: "POST", path: "/card/7/dispatch-grant", body: { bot_id: "bot-a", granted: false } }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(cb.checked, false);
  assert.equal(cb.disabled, false);
});

test("a refused toggle puts the checkbox back and shows the error", async () => {
  const { dom } = await drive({ id: 8, assigned_bot: "bot-a", parent_id: null, archived_at: null }, [],
    { ok: false, status: 400, j: { error: "not this bot" } });
  const cb = dom.find("bb-d-grant-cb");
  cb.checked = true;
  cb.onchange();
  await new Promise((r) => setImmediate(r));
  assert.equal(cb.checked, false);
  const text = JSON.stringify(dom.mountEl.children.map((c) => c.textContent));
  assert.ok(text.includes("not this bot"));
});

test("on an operator-created card the drawer shows a note instead of the checkbox", async () => {
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const { dom, calls } = await drive({ id: 9, assigned_bot: "bot-a", parent_id: null, archived_at: null }, [], null, true);
  assert.equal(dom.find("bb-d-grant-cb"), undefined, "no checkbox");
  assert.equal(dom.mountEl.children.length, 1);
  assert.equal(dom.mountEl.children[0].textContent, translations["botboard.grant.ownCard"].en);
  assert.equal(calls.length, 0);
  const none = await drive({ id: 9, assigned_bot: null, parent_id: null, archived_at: null }, [], null, true);
  assert.equal(none.dom.mountEl.children.length, 0, "no bot, no note");
});
