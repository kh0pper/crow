// One assignment guard for every card path: the voice bot (crow.voice) never takes a card, and a
// missing or disabled bot never does either. Covers the shared helper, the board MCP's
// board_create_item / board_update_item, the dashboard card routes and the give service's create.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-assign-guard-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const TASKS = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let assertAssignableBot, cdb, tdb, tools, server, boardBase, PID;
const raw = () => new Database(DB_FILE);
const rawTasks = () => new Database(TASKS);
const cards = () => { const t = rawTasks(); const r = t.prepare("SELECT * FROM tasks_items ORDER BY id").all(); t.close(); return r; };
const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  cdb = createDbClient(DB_FILE);
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  PID = (await createProjectSpace(cdb, { name: "Guard board" })).id;
  const { voiceBotDefinition } = await import("../servers/shared/voice-bot.js");
  const c = raw();
  const ins = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)");
  ins.run("crow.voice", "Crow", JSON.stringify(voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" })), 1, null);
  ins.run("helper", "Helper", JSON.stringify({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }), 1, PID);
  ins.run("off", "Off", JSON.stringify({ gateways: [{ type: "perch" }] }), 0, PID);
  c.close();
  const t = rawTasks();
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, due_date TEXT, phase TEXT, owner TEXT,
    tags TEXT, parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  t.close();

  ({ assertAssignableBot } = await import("../servers/gateway/board/bot-lookup.js"));
  tdb = createDbClient(TASKS);
  const sig = await import("../scripts/pi-bots/actor-sig.mjs");
  sig.initGatewayActorKey();
  const { createBoardMcpServer } = await import("../servers/gateway/board-mcp.js");
  server = createBoardMcpServer({ cdb, tdb, verifyActor: sig.verifyBoardActorSig, verifyThread: sig.verifyBoardThreadActorSig });
  tools = server._registeredTools;

  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.status(401).json({ error: "unauthorized" }));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(botBoardApiRouter(auth));
  app.use(router);
  await new Promise((r) => { server.http = app.listen(0, "127.0.0.1", r); });
  boardBase = "http://127.0.0.1:" + server.http.address().port + "/dashboard/bot-board-api";
});

after(() => {
  try { server.http.close(); cdb.close(); tdb.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const extra = { authInfo: { clientId: "local-mcp" }, requestInfo: { headers: {} } };
const post = async (path, body) => {
  const r = await fetch(boardBase + path, { method: "POST", headers: { "content-type": "application/json", ...AUTHED }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("assertAssignableBot refuses the voice bot and a missing or disabled bot, and accepts an enabled one", async () => {
  for (const bad of ["crow.voice", "off", "ghost", "", null, undefined]) {
    await assert.rejects(assertAssignableBot(cdb, bad), (e) => e.code === "bad_bot" && e.http === 400, String(bad));
  }
  assert.equal(await assertAssignableBot(cdb, "helper"), undefined);
});

test("board_create_item refuses assigned_bot crow.voice", async () => {
  const before = cards().length;
  const r = await tools.board_create_item.handler({ title: "x", assigned_bot: "crow.voice" }, extra);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /voice bot never takes cards/);
  assert.equal(cards().length, before, "no card was made");
});

test("board_create_item accepts an enabled ordinary bot", async () => {
  const r = await tools.board_create_item.handler({ title: "ok", assigned_bot: "helper" }, extra);
  assert.notEqual(r.isError, true, r.content[0].text);
  assert.equal(cards().at(-1).assigned_bot, "helper");
});

test("board_update_item cannot set assigned_bot at all", async () => {
  const [seed] = cards().filter((c) => c.assigned_bot === "helper");
  const before = JSON.stringify(seed);
  const parsed = tools.board_update_item.inputSchema.safeParse({ id: seed.id, assigned_bot: "crow.voice" });
  assert.ok(!parsed.success || !("assigned_bot" in parsed.data), "the schema drops assigned_bot");
  if (parsed.success) await tools.board_update_item.handler(parsed.data, extra);
  const t = rawTasks();
  const after_ = JSON.stringify(t.prepare("SELECT * FROM tasks_items WHERE id=?").get(seed.id));
  t.close();
  assert.equal(after_.replace(/"updated_at":"[^"]*"/, ""), before.replace(/"updated_at":"[^"]*"/, ""));
  assert.equal(JSON.parse(after_).assigned_bot, "helper");
});

test("the dashboard assign route refuses crow.voice", async () => {
  const t = rawTasks();
  const id = Number(t.prepare("INSERT INTO tasks_items (title, assigned_bot) VALUES ('c','helper')").run().lastInsertRowid);
  t.close();
  const r = await post(`/card/${id}`, { title: "c", assigned_bot: "crow.voice" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "bot_unavailable");
  const off = await post(`/card/${id}`, { title: "c", assigned_bot: "off" });
  assert.equal(off.status, 400);
  assert.equal(off.body.code, undefined);
  const ok = await post(`/card/${id}`, { title: "c", assigned_bot: "helper" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("the dashboard execute route refuses a card already carrying crow.voice", async () => {
  const t = rawTasks();
  const id = Number(t.prepare("INSERT INTO tasks_items (title, assigned_bot) VALUES ('v','crow.voice')").run().lastInsertRowid);
  t.close();
  const r = await post(`/card/${id}/execute`, {});
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "bot_unavailable");
});

test("the give service's create path refuses crow.voice before touching tasks.db", async () => {
  const { createTaskForBot } = await import("../servers/gateway/board/give-service.js");
  const before = cards().length;
  let opened = false;
  await assert.rejects(createTaskForBot(cdb, () => { opened = true; return tdb; }, "crow.voice", { title: "t" }), (e) => e.http === 400);
  assert.equal(opened, false);
  assert.equal(cards().length, before);
});
