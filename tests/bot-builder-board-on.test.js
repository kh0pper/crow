/**
 * Bot Builder rows (queue item 20, option A; T4) — "Turn on a board".
 *
 * board_on gives a bot a kanban board: a bot with no project gets a new
 * "<Name>'s board" project linked (through the same tracker write the Edit
 * tab makes); a bot that already has one keeps it. Custom trackers are
 * refused. Linking a project MOVES the bot's world root (bot-world.mjs:
 * <workspace>/bots/<id>), so the old root's sessions/, outputs/, .pi/ and
 * .mcp.json are symlinked into the new root — only where the new path is
 * free; anything in the way refuses the whole action, and nothing is ever
 * overwritten or deleted. The proof that old chats survive is the resume
 * path itself: <new root>/sessions must list the waiting transcript.
 *
 * Also: the POST goes through the real CSRF rail (403 without the token).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, lstatSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-board-on-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;

let db = null, handleBotBuilderPost = null, applyTrackerChoice = null, worldRootFor = null, translations = null, slugify = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost, applyTrackerChoice } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ worldRootFor } = await import("../scripts/pi-bots/world-root.mjs"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ slugify } = await import("../servers/shared/slugify.js"));
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function mkRes() {
  const res = { redirected: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
}
async function post(body) {
  const res = mkRes();
  await handleBotBuilderPost({ body: { action: "board_on", ...body }, headers: {} }, res, { db });
  return res.redirected;
}
async function addBot(id, name, def, projectId = null) {
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    args: [id, name, JSON.stringify(def), projectId] });
}
async function bot(id) {
  return (await db.execute({ sql: "SELECT bot_id, display_name, definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0];
}
async function project(id) {
  return (await db.execute({ sql: "SELECT * FROM project_spaces WHERE id=?", args: [id] })).rows[0];
}
async function projectCount() {
  return Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM project_spaces", args: [] })).rows[0].n);
}
const BASE_DEF = () => ({ models: { default: "p/m" }, gateways: [{ type: "perch" }], system_prompt: "Be brief.", skills: ["a"] });

test("a bot with no project gets a new '<Name>'s board' project, linked, as a kanban board", async () => {
  await addBot("plain-bot", "Plain Bot", BASE_DEF());
  const to = await post({ bot_id: "plain-bot", return: "list" });
  assert.equal(to, "/dashboard/bot-builder?saved=1");
  const row = await bot("plain-bot");
  assert.notEqual(row.project_id, null, "the project_id column is set");
  const ps = await project(row.project_id);
  assert.equal(ps.name, "Plain Bot's board");
  assert.equal(ps.tasks_db_uri, null, "the instance-global tasks.db");
  const def = JSON.parse(row.definition);
  assert.equal(def.tracker_config.type, "kanban");
  assert.equal(def.tracker_config.project_id, undefined);
  // Nothing else in the definition changes. Like the Edit tab's board save
  // (save-handlers.js, section "board"), the project lives in the column only:
  // no JSON project_id key is added.
  assert.ok(!Object.prototype.hasOwnProperty.call(def, "project_id"), "no JSON project_id copy added");
  const { tracker_config, ...rest } = def;
  assert.deepEqual(rest, BASE_DEF());
  const audit = (await db.execute({ sql: "SELECT * FROM project_audit_log WHERE project_id=?", args: [row.project_id] })).rows;
  assert.ok(audit.some((a) => a.action === "project.create" && a.actor_type === "local" && String(a.target) === "bot:plain-bot"),
    "the project creation is in the project's audit log");
});

test("old chats are carried over: the resume path at the new root finds the waiting transcript", async () => {
  const def = BASE_DEF();
  await addBot("carry-bot", "Carry Bot", def);
  // The world root BEFORE a project: <CROW_HOME>/pi-bots/<id> (bot-world.mjs).
  const oldRoot = worldRootFor({ workspaceDir: null, def, crowHome: process.env.CROW_HOME, botId: "carry-bot" });
  assert.equal(oldRoot, join(process.env.CROW_HOME, "pi-bots", "carry-bot"));
  mkdirSync(join(oldRoot, "sessions"), { recursive: true });
  writeFileSync(join(oldRoot, "sessions", "2026-10-01T10-00-00-000Z_sess-abc123.jsonl"), '{"type":"session"}\n');
  writeFileSync(join(oldRoot, ".mcp.json"), '{"mcpServers":{}}');
  mkdirSync(join(oldRoot, "outputs", "s1"), { recursive: true });
  writeFileSync(join(oldRoot, "outputs", "s1", "report.md"), "done");
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, pi_session_id, pi_session_dir, gateway_type, gateway_thread_id, status) VALUES (?,?,?,?,?,?)",
    args: ["carry-bot", "sess-abc123", oldRoot + "/sessions", "perch", "t-1", "waiting-user"] });

  assert.equal(await post({ bot_id: "carry-bot" }), "/dashboard/bot-builder?saved=1");
  const row = await bot("carry-bot");
  const ps = await project(row.project_id);
  // The same resolution buildBotWorld runs for the next turn.
  const newRoot = worldRootFor({ workspaceDir: ps.workspace_dir, def: JSON.parse(row.definition), crowHome: process.env.CROW_HOME, botId: "carry-bot" });
  assert.equal(newRoot, ps.workspace_dir + "/bots/carry-bot");
  assert.notEqual(newRoot, oldRoot, "the root really moved");
  // Resume: bridge passes --session-dir <root>/sessions + --session <id>;
  // perch-interactive's preflight lists <root>/sessions for "*<id>*.jsonl".
  const session = (await db.execute({ sql: "SELECT pi_session_id FROM bot_sessions WHERE bot_id='carry-bot'", args: [] })).rows[0];
  const found = readdirSync(join(newRoot, "sessions")).filter((f) => f.endsWith(".jsonl") && f.includes(session.pi_session_id));
  assert.equal(found.length, 1, "the waiting chat's transcript is reachable from the new root");
  assert.ok(lstatSync(join(newRoot, "sessions")).isSymbolicLink(), "linked, not copied or moved");
  assert.equal(readlinkSync(join(newRoot, "sessions")), join(oldRoot, "sessions"));
  assert.equal(readFileSync(join(newRoot, ".mcp.json"), "utf8"), '{"mcpServers":{}}');
  assert.equal(readFileSync(join(newRoot, "outputs", "s1", "report.md"), "utf8"), "done");
  assert.ok(existsSync(join(oldRoot, "sessions", "2026-10-01T10-00-00-000Z_sess-abc123.jsonl")), "the old files stay where they were");
  const audit = (await db.execute({ sql: "SELECT payload FROM project_audit_log WHERE project_id=? AND action='project.create'", args: [row.project_id] })).rows[0];
  assert.deepEqual(JSON.parse(audit.payload).carried.sort(), [".mcp.json", "outputs", "sessions"]);
});

test("something already at the new path: refused with a clear message, nothing linked, nothing changed", async () => {
  const def = BASE_DEF();
  await addBot("busy-bot", "Busy Bot", def);
  const oldRoot = join(process.env.CROW_HOME, "pi-bots", "busy-bot");
  mkdirSync(join(oldRoot, "sessions"), { recursive: true });
  writeFileSync(join(oldRoot, "sessions", "x_sess-9.jsonl"), "{}\n");
  // Predict the new project's workspace and put a real folder where the link would go.
  // project_spaces.id is a plain INTEGER PRIMARY KEY: the next id is MAX+1.
  const nextId = Number((await db.execute({ sql: "SELECT COALESCE(MAX(id),0) AS m FROM project_spaces", args: [] })).rows[0].m) + 1;
  const ws = `${dir}/projects/${slugify("Busy Bot's board")}-${nextId}/workspace`;
  const blocker = join(ws, "bots", "busy-bot", "sessions");
  mkdirSync(blocker, { recursive: true });
  writeFileSync(join(blocker, "keep.txt"), "mine");
  const before = await projectCount();

  const to = await post({ bot_id: "busy-bot" });
  assert.match(to, /^\/dashboard\/bot-builder\?error=/);
  const msg = decodeURIComponent(to.split("error=")[1]);
  assert.ok(msg.includes(blocker), "the message names the path in the way: " + msg);
  const row = await bot("busy-bot");
  assert.equal(row.project_id, null, "the bot is not linked");
  assert.deepEqual(JSON.parse(row.definition), def, "the definition is unchanged");
  assert.equal(await projectCount(), before, "the half-made project is not left behind");
  assert.ok(!lstatSync(blocker).isSymbolicLink(), "the folder in the way is not replaced");
  assert.equal(readFileSync(join(blocker, "keep.txt"), "utf8"), "mine");
  assert.ok(existsSync(join(oldRoot, "sessions", "x_sess-9.jsonl")));
});

test("type none with a project already linked: switched to kanban, the same project kept, no new one", async () => {
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Existing" })).id;
  await addBot("none-bot", "None Bot", { ...BASE_DEF(), tracker_config: { type: "none" } }, pid);
  const before = await projectCount();
  assert.equal(await post({ bot_id: "none-bot", return: "board" }), "/dashboard/bot-board?bot=none-bot");
  const row = await bot("none-bot");
  assert.equal(Number(row.project_id), pid);
  assert.equal(JSON.parse(row.definition).tracker_config.type, "kanban");
  assert.equal(await projectCount(), before);
});

test("type none with no project: a new project, kanban", async () => {
  await addBot("none-noproj", "Quiet", { ...BASE_DEF(), tracker_config: { type: "none", project_id: 99 } });
  await post({ bot_id: "none-noproj" });
  const row = await bot("none-noproj");
  assert.notEqual(row.project_id, null);
  const tc = JSON.parse(row.definition).tracker_config;
  assert.equal(tc.type, "kanban");
  assert.equal(tc.project_id, undefined, "a stale tracker_config.project_id (it overrides the column) is dropped");
});

test("a custom tracker is refused and left as it is", async () => {
  const def = { ...BASE_DEF(), tracker_config: { type: "custom", tracker_slug: "leads" } };
  await addBot("custom-bot", "Custom Bot", def);
  const before = await projectCount();
  const to = await post({ bot_id: "custom-bot" });
  assert.match(to, /^\/dashboard\/bot-builder\?bot=custom-bot&tab=tracker&error=/);
  assert.ok(decodeURIComponent(to).includes(translations["botbuilder.boardOnCustom"].en));
  assert.deepEqual(JSON.parse((await bot("custom-bot")).definition), def);
  assert.equal(await projectCount(), before);
});

test("an already-on bot: nothing written, no new project", async () => {
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "On" })).id;
  await addBot("on-bot", "On Bot", { ...BASE_DEF(), tracker_config: { type: "task-list" } }, pid);
  const stored = (await bot("on-bot")).definition;
  const before = await projectCount();
  assert.equal(await post({ bot_id: "on-bot" }), "/dashboard/bot-builder?saved=1");
  assert.equal((await bot("on-bot")).definition, stored, "byte-identical");
  assert.equal(await projectCount(), before);
});

test("return is an enum, never a URL", async () => {
  await addBot("ret-bot", "Ret Bot", BASE_DEF());
  assert.equal(await post({ bot_id: "ret-bot", return: "https://x.example/" }), "/dashboard/bot-builder?saved=1");
});

test("an unknown bot redirects with error=unknown_bot", async () => {
  assert.equal(await post({ bot_id: "never-was" }), "/dashboard/bot-builder?error=unknown_bot");
});

test("applyTrackerChoice is what the Edit tab's tracker save writes", async () => {
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Tracker" })).id;
  const def = { ...BASE_DEF(), tracker_config: { type: "custom", tracker_slug: "old", context_fields: ["a"] } };
  await addBot("tab-bot", "Tab Bot", def);
  const res = mkRes();
  await handleBotBuilderPost({ body: { action: "save_tracker", bot_id: "tab-bot", tracker_type: "kanban", project_id: String(pid) }, headers: {} }, res, { db });
  assert.match(res.redirected, /saved=1/);
  const viaTab = JSON.parse((await bot("tab-bot")).definition);
  // The legacy tab save also normalises these containers (unchanged behaviour).
  const expected = applyTrackerChoice({ ...structuredClone(def), tools: {}, permission_policy: {}, triggers: {} }, { projectId: pid, type: "kanban" });
  assert.deepEqual(viaTab, expected);
  assert.equal(Number((await bot("tab-bot")).project_id), pid);
});

test("applyTrackerChoice: custom keeps its slug fields; kanban drops them; tracker_config.project_id never survives", () => {
  const c = applyTrackerChoice({ tracker_config: { project_id: 4 } }, { projectId: 2, type: "custom", slug: " leads ", contextFields: "a, b", queueFilterKey: "k", queueFilterValue: "v" });
  assert.deepEqual(c.tracker_config, { type: "custom", tracker_slug: "leads", context_fields: ["a", "b"], queue_filter: { k: "v" } });
  assert.equal(c.project_id, 2);
  const k = applyTrackerChoice({ tracker_config: { type: "custom", tracker_slug: "x", context_fields: ["a"], queue_filter: { k: "v" } } }, { projectId: null, type: "kanban" });
  assert.deepEqual(k.tracker_config, { type: "kanban" });
  assert.equal(k.project_id, null);
});

test("bot-world.mjs resolves its world root through worldRootFor (one resolution, two callers)", () => {
  const src = readFileSync(new URL("../scripts/pi-bots/bot-world.mjs", import.meta.url), "utf8");
  assert.match(src, /const sessionDir = worldRootFor\(/);
});

// ---- the CSRF rail --------------------------------------------------------
test("board_on through the dashboard's CSRF rail: 403 without the token, a redirect with it", async () => {
  const express = (await import("express")).default;
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { default: panel } = await import("../servers/gateway/dashboard/panels/bot-builder.js");
  await addBot("rail-bot", "Rail Bot", BASE_DEF());
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { res.redirectAfterPost = (u) => res.redirect(303, u); next(); });
  // The mount order dashboard/index.js uses: csrfMiddleware on /dashboard,
  // then the generic /dashboard/:panelId route.
  app.use("/dashboard", csrfMiddleware);
  app.all("/dashboard/bot-builder", async (req, res) => {
    const out = await panel.handler(req, res, { db, layout: (o) => o.content, lang: "en" });
    if (!res.headersSent) res.send(out);
  });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}/dashboard/bot-builder`;
  try {
    const cookie = "crow_session=s1; crow_csrf=tok-abc";
    const form = (extra) => new URLSearchParams({ action: "board_on", bot_id: "rail-bot", return: "list", ...extra }).toString();
    const denied = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({}) });
    assert.equal(denied.status, 403);
    assert.equal((await bot("rail-bot")).project_id, null, "nothing happened");
    const wrong = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({ _csrf: "nope" }) });
    assert.equal(wrong.status, 403);
    const ok = await fetch(url, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form({ _csrf: "tok-abc" }) });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/dashboard/bot-builder?saved=1");
    assert.notEqual((await bot("rail-bot")).project_id, null);
  } finally { srv.close(); }
  // And the real router keeps that order.
  const idx = readFileSync(new URL("../servers/gateway/dashboard/index.js", import.meta.url), "utf8");
  const csrfAt = idx.indexOf('router.use("/dashboard", csrfMiddleware)');
  const panelAt = idx.indexOf('router.all("/dashboard/:panelId"');
  assert.ok(csrfAt > 0 && panelAt > csrfAt, "csrfMiddleware is mounted before the panel route");
});
