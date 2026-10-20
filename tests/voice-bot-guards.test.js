/**
 * The Crow voice bot (bot_id "crow.voice", definition.kind "voice") is no
 * ordinary bot: it cannot be deleted, edited through the generic Bot Builder
 * actions, peer-managed, listed to peers / boards / rosters / Perch,
 * delegated to, scheduled, given cards, or rewritten by the
 * artifacts-companions boot migration.
 *
 * One scratch, init-db'd crow.db (CROW_DATA_DIR in a tmp dir, never the
 * operator's ~/.crow) seeded with the voice row plus two ordinary bots.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "voice-bot-guards-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

const raw = () => new Database(DB_FILE);
const voiceRow = () => { const c = raw(); const r = c.prepare("SELECT * FROM pi_bot_defs WHERE bot_id='crow.voice'").get(); c.close(); return r; };

let db, CROW_VOICE_BOT_ID, VOICE_DEF_JSON, PID;
let handleBotBuilderPost, handleDeleteConfirm, getLocalCatalog, botPeerManageable, writeSetting;
let listAdvertisedBots, createToolExecutor, migrateArtifactsCompanions, botBoardPanel, createDbClient;
let perchServer, perchBase, boardBase, _setEngineStatusForTest;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const vb = await import("../servers/shared/voice-bot.js");
  CROW_VOICE_BOT_ID = vb.CROW_VOICE_BOT_ID;
  VOICE_DEF_JSON = JSON.stringify(vb.voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" }));

  ({ createDbClient } = await import("../servers/db.js"));
  db = createDbClient();
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity("");
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  PID = (await createProjectSpace(db, { name: "Helper's board" })).id;

  const c = raw();
  const ins = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)");
  ins.run("crow.voice", "Crow", VOICE_DEF_JSON, 1, null);
  ins.run("writer", "Writer", JSON.stringify({ gateways: [{ type: "perch" }], tools: { crow_mcp: ["artifacts/artifact_update"] } }), 1, null);
  ins.run("helper", "Helper", JSON.stringify({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }), 1, PID);
  c.close();

  ({ handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ handleDeleteConfirm } = await import("../servers/gateway/dashboard/panels/bot-builder/delete-bot.js"));
  ({ getLocalCatalog } = await import("../servers/gateway/capability-registry.js"));
  ({ botPeerManageable } = await import("../servers/gateway/bot-management-exposure.js"));
  ({ writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
  ({ listAdvertisedBots } = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js"));
  ({ createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js"));
  ({ migrateArtifactsCompanions } = await import("../scripts/pi-bots/artifacts-companions.mjs"));
  ({ default: botBoardPanel } = await import("../servers/gateway/dashboard/panels/bot-board.js"));
  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));

  // Both Perch routers, mounted the way dashboard/index.js does: CSRF first,
  // then perch-api; a session-checking stub stands in for dashboardAuth.
  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.status(401).json({ error: "unauthorized" }));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(perchApiRouter(auth, { interactiveEngine: () => ({ list: async () => [] }) }));
  router.use(perchInteractiveApiRouter(auth, {
    engine: () => ({ async checkCardFree() {}, async spawn() { throw new Error("no spawn in this test"); }, async message() {} }),
    annotate: async (m) => m, providerModels: () => [], piProviders: () => null,
  }));
  router.use(botBoardApiRouter(auth));
  app.use(router);
  await new Promise((r) => { perchServer = app.listen(0, "127.0.0.1", r); });
  perchBase = "http://127.0.0.1:" + perchServer.address().port + "/dashboard/perch-api";
  boardBase = "http://127.0.0.1:" + perchServer.address().port + "/dashboard/bot-board-api";
});

after(() => {
  try { _setEngineStatusForTest && _setEngineStatusForTest(null); } catch {}
  if (perchServer) perchServer.close();
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
const fakeRes = () => { const res = { redirected: null }; res.redirectAfterPost = (url) => { res.redirected = url; }; return res; };

test("delete is refused", async () => {
  const res = fakeRes();
  await handleDeleteConfirm({ body: { bot_id: "crow.voice" }, headers: {} }, res, { db });
  assert.equal(res.redirected, "/dashboard/bot-builder?error=voice_bot_permanent");
  assert.ok(voiceRow(), "the voice row still exists");
  assert.equal(voiceRow().definition, VOICE_DEF_JSON);
});

test("the Bot Builder delete flow reaches the permanent refusal", async () => {
  for (const bot_id of ["crow.voice", "  crow.voice "]) {
    const res = fakeRes();
    await handleBotBuilderPost({ body: { action: "delete_confirm", bot_id }, headers: {} }, res, { db });
    assert.equal(res.redirected, "/dashboard/bot-builder?error=voice_bot_permanent", JSON.stringify(bot_id));
  }
  assert.equal(voiceRow().definition, VOICE_DEF_JSON, "the voice row still exists, unchanged");
});

// Every other action handleBotBuilderPost dispatches on (VOICE_BOT_ACTIONS is
// empty in this PR, so none is allowed on the voice bot; delete_confirm is
// covered above).
const SAVE_TABS = ["basics", "abilities", "safety", "advanced", "ai", "tools", "gateways", "tracker", "skills", "triggers", "permissions"];
const ACTIONS = [
  "toggle", "board_on", "confirm_sandbox_auto", "create", "wizard_create", "toggle_peer_managed",
  "gw_share", "gw_newlink", "gw_remove", "gw_advanced_add", "regen_mcp",
  ...SAVE_TABS.map((t) => "save_" + t),
];

test("generic saves are refused", async () => {
  const before = voiceRow();
  for (const bot_id of ["crow.voice", "  crow.voice "]) {
    for (const action of ACTIONS) {
      const res = fakeRes();
      try {
        await handleBotBuilderPost({ body: { action, bot_id, display_name: "X", managed: "on", sender_pubkey: "ab".repeat(32) }, headers: {} }, res, { db });
      } catch { /* a thrown handler is a failed guard: the assertion below says so */ }
      assert.equal(res.redirected, "/dashboard/bot-builder?error=voice_bot_readonly", `${action} on ${JSON.stringify(bot_id)}`);
    }
  }
  const afterRow = voiceRow();
  assert.equal(afterRow.definition, before.definition, "definition unchanged");
  assert.equal(afterRow.enabled, before.enabled, "enabled unchanged");
  const c = raw();
  assert.equal(c.prepare("SELECT COUNT(*) AS n FROM bot_message_invites WHERE bot_id='crow.voice'").get().n, 0, "no invite minted");
  c.close();
});

test("peers cannot see or manage it", async () => {
  await writeSetting(db, "feature_flags", JSON.stringify({ remote_bot_management: true }), { scope: "local" });
  await writeSetting(db, "remote_managed_bots", JSON.stringify(["crow.voice", "writer"]), { scope: "local" });
  const cat = await getLocalCatalog(db, { crowHome: join(dir, "nonexistent-home"), instanceId: "self" });
  const ids = cat.bots.map((b) => b.bot_id);
  assert.ok(!ids.includes(CROW_VOICE_BOT_ID));
  assert.ok(ids.includes("writer") && ids.includes("helper"));
  assert.equal(await botPeerManageable(db, "crow.voice"), false);
  assert.equal(await botPeerManageable(db, "writer"), true, "an opted-in ordinary bot stays manageable");
});

test("boards, rosters and delegation leave it out", async () => {
  assert.ok(voiceRow(), "precondition: the voice row is seeded");
  // The bot-board list (the picker links one row per listed bot).
  const res = { redirect() {}, headersSent: false };
  const html = await botBoardPanel.handler({ method: "GET", query: {}, headers: {}, csrfToken: "tok-1" }, res,
    { db, layout: (o) => o.content, lang: "en" });
  const hrefs = [...String(html).matchAll(/href="\/dashboard\/bot-board\?bot=([^"&]+)"/g)].map((m) => decodeURIComponent(m[1]));
  assert.ok(hrefs.includes("helper"), "the board lists ordinary bots");
  assert.ok(!hrefs.includes("crow.voice"), "the board leaves the voice bot out");

  // The crow-messages roster, even when the voice row (tampered) carries an advertised gateway.
  const c = raw();
  const adv = JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] });
  c.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id='crow.voice'").run(adv);
  c.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id='writer'").run(adv);
  c.close();
  let roster;
  try { roster = (await listAdvertisedBots(db)).map((b) => b.botId); }
  finally {
    const c2 = raw();
    c2.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id='crow.voice'").run(VOICE_DEF_JSON);
    c2.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id='writer'")
      .run(JSON.stringify({ gateways: [{ type: "perch" }], tools: { crow_mcp: ["artifacts/artifact_update"] } }));
    c2.close();
  }
  assert.deepEqual(roster, ["writer"]);

  // Delegation and scheduling.
  const ex = createToolExecutor({ botDef: { bot_id: "writer" } });
  try {
    const d = await ex.executeTool("crow_delegate", { goal: "x", bot: "crow.voice" });
    assert.equal(d.isError, true);
    assert.match(d.result, /cannot take background jobs/);
    const s = await ex.executeTool("crow_schedule_bot", { goal: "x", cron: "0 9 * * *", bot: "crow.voice" });
    assert.equal(s.isError, true);
    assert.match(s.result, /cannot take background jobs/);
  } finally { await ex.close(); }
  const c3 = raw();
  assert.equal(c3.prepare("SELECT COUNT(*) AS n FROM bot_jobs WHERE bot_id='crow.voice'").get().n, 0);
  assert.equal(c3.prepare("SELECT COUNT(*) AS n FROM schedules WHERE task LIKE '%crow.voice%'").get().n, 0);
  c3.close();

  // Give a card.
  _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const r = await fetch(perchBase + "/bots/crow.voice/tasks", {
    method: "POST", headers: { "content-type": "application/json", ...AUTHED }, body: JSON.stringify({ title: "x" }),
  });
  const body = await r.json().catch(() => null);
  assert.equal(r.status, 400);
  assert.equal(body && body.error, "bot_unavailable");
});

test("artifacts migration skips it", async () => {
  const budgetFor = async () => ({ cap: null, countFor: () => 0 });
  // The real scratch DB, fresh marker.
  const out = await migrateArtifactsCompanions(db, { log: () => {}, budgetFor });
  assert.ok(out.updated.includes("writer"), "the migration ran over ordinary bots");
  assert.ok(!out.updated.includes("crow.voice"));
  assert.equal(voiceRow().definition, VOICE_DEF_JSON, "byte-identical");

  // A voice def that WOULD be rewritten (it holds artifact_update), under the
  // reserved id and under another id, and a corrupt row under the reserved id.
  const other = createDbClient(join(dir, "artifacts-mig.db"));
  try {
    await other.executeMultiple(`
      CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER, created_at TEXT, updated_at TEXT);`);
    const withU = JSON.stringify({ kind: "voice", tools: { crow_mcp: ["artifacts/artifact_update"] } });
    const corrupt = JSON.stringify({ tools: { crow_mcp: ["artifacts/artifact_update"] } });
    const ins = (id, d) => other.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)", args: [id, id, d] });
    await ins("crow.voice", corrupt);
    await ins("helper", withU);
    await ins("writer", corrupt);
    const o2 = await migrateArtifactsCompanions(other, { log: () => {}, budgetFor });
    assert.deepEqual(o2.updated, ["writer"]);
    const defOf = async (id) => (await other.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0].definition;
    assert.equal(await defOf("crow.voice"), corrupt, "a corrupt row under the reserved id is never rewritten");
    assert.equal(await defOf("helper"), withU, "a kind:voice def is never rewritten");
  } finally { other.close(); }
});

test("Perch listings leave it out", async () => {
  assert.ok(voiceRow(), "precondition: the voice row is seeded");
  for (const path of ["/bots", "/roost"]) {
    const r = await fetch(perchBase + path, { headers: AUTHED });
    assert.equal(r.status, 200, path);
    const body = await r.json();
    const list = path === "/bots" ? body.bots : body.birds;
    const ids = list.map((b) => b.id);
    assert.ok(ids.includes("writer") && ids.includes("helper"), path);
    assert.ok(!ids.includes("crow.voice"), path);
  }
});

// ---- the Bot Board API (routes/bot-board-api.js) ----
const TASKS_SCHEMA = `CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')));`;
const tasks = () => { const t = new Database(process.env.CROW_TASKS_DB_PATH); t.exec(TASKS_SCHEMA); return t; };
const seedCard = (assigned) => { const t = tasks(); const id = Number(t.prepare("INSERT INTO tasks_items (title, assigned_bot) VALUES (?,?)").run("card", assigned).lastInsertRowid); t.close(); return id; };
const cardRow = (id) => { const t = tasks(); const r = t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id); t.close(); return r; };
const voiceJobs = () => { const c = raw(); try { return c.prepare("SELECT COUNT(*) AS n FROM bot_jobs WHERE bot_id='crow.voice'").get().n; } catch { return 0; } finally { c.close(); } };
const boardPost = async (path, body) => {
  const r = await fetch(boardBase + path, { method: "POST", headers: { "content-type": "application/json", ...AUTHED }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("the Bot Board cannot assign a card to it or run a card with it", async () => {
  assert.ok(voiceRow(), "precondition: the voice row is seeded");
  // Assign: refused, the card keeps its bot.
  const id = seedCard("writer");
  const before = cardRow(id);
  const r = await boardPost(`/card/${id}`, { title: "card", assigned_bot: "crow.voice" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body && r.body.code, "bot_unavailable");
  assert.deepEqual(cardRow(id), before, "the card is unchanged");
  // Sanity: an ordinary reassignment still works on the same route.
  const ok = await boardPost(`/card/${id}`, { title: "card", assigned_bot: "helper" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(cardRow(id).assigned_bot, "helper");

  // Execute a card already carrying the voice bot (assigned before this guard): refused, no job.
  const vid = seedCard("crow.voice");
  const vbefore = cardRow(vid);
  const e = await boardPost(`/card/${vid}/execute`, {});
  assert.equal(e.status, 400, JSON.stringify(e.body));
  assert.equal(e.body && e.body.code, "bot_unavailable");
  assert.equal(voiceJobs(), 0, "no bot_jobs row for the voice bot");
  assert.deepEqual(cardRow(vid), vbefore);
});

test("the Bot Board cannot approve a skill onto it", async () => {
  // A (tampered) voice def with a session dir and a staged proposal: the
  // route would otherwise promote it and append to def.skills.
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const sess = join(dir, "voice-session");
  mkdirSync(join(sess, "proposed-skills"), { recursive: true });
  writeFileSync(join(sess, "proposed-skills", "tidy-notes.md"), "# tidy notes\nKeep notes tidy.\n");
  const tampered = JSON.stringify({ ...JSON.parse(VOICE_DEF_JSON), session_dir: sess });
  const c = raw(); c.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id='crow.voice'").run(tampered); c.close();
  try {
    const r = await boardPost("/bot/crow.voice/proposed-skill/approve", { name: "tidy-notes", content: "# tidy notes\nKeep notes tidy.\n" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body && r.body.code, "bot_unavailable");
    assert.equal(voiceRow().definition, tampered, "the definition is byte-identical");
    assert.equal(existsSync(join(process.env.CROW_HOME, "skills", "tidy-notes.md")), false, "no skill was promoted");
  } finally {
    const c2 = raw(); c2.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id='crow.voice'").run(VOICE_DEF_JSON); c2.close();
  }
});

// ---- background-job producers and the runner (scripts/pi-bots) ----
const SPAWNED = () => { throw new Error("REACHED_PI: a voice job must fail before any bot load or pi spawn"); };

test("the job runner fails a queued voice job before any pi work", async () => {
  const { runOnce, runJob, ensureBotJobsSchema } = await import("../scripts/pi-bots/job_runner.mjs");
  const c = raw();
  ensureBotJobsSchema(c);
  assert.equal(c.prepare("SELECT COUNT(*) AS n FROM bot_jobs WHERE status='queued'").get().n, 0, "precondition: nothing else queued");
  c.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, source) VALUES ('job-voice-1','crow.voice','x','queued','chat')").run();
  c.close();
  const fakeBridge = { loadBot: SPAWNED, handleInbound: SPAWNED, PiRpc: SPAWNED };
  const out = await runOnce({ log: () => {}, bridge: fakeBridge });
  assert.equal(out.ran, "job-voice-1");
  assert.equal(out.status, "failed");
  const c2 = raw();
  const job = c2.prepare("SELECT status, error FROM bot_jobs WHERE job_id='job-voice-1'").get();
  c2.close();
  assert.equal(job.status, "failed");
  assert.match(job.error, /cannot take background jobs/);

  // A kind:"voice" definition under any other id is refused the same way.
  await assert.rejects(
    runJob({ job_id: "job-voice-2", bot_id: "helper", goal: "x", source: "chat" },
      { log: () => {}, bridge: { loadBot: () => ({ def: JSON.parse(VOICE_DEF_JSON), project_id: null }), PiRpc: SPAWNED } }),
    /cannot take background jobs/);
});

test("a botcron schedule for the voice bot advances without enqueuing; the schedule row stays", async () => {
  const { tickBotSchedules } = await import("../scripts/pi-bots/bot_scheduler.mjs");
  const c = raw();
  const sid = Number(c.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:crow.voice", "*/5 * * * *", JSON.stringify({ goal: "daily digest" }), "2020-01-01T00:00:00.000Z").lastInsertRowid);
  c.close();
  const r = tickBotSchedules();
  assert.equal(r.fired, 0);
  const c2 = raw();
  const sch = c2.prepare("SELECT next_run, last_run FROM schedules WHERE id=?").get(sid);
  const n = c2.prepare("SELECT COUNT(*) AS n FROM bot_jobs WHERE bot_id='crow.voice' AND source='schedule'").get().n;
  c2.close();
  assert.equal(n, 0, "no bot_jobs row for the voice bot");
  assert.ok(sch, "the schedule row still exists");
  assert.ok(sch.next_run > "2020-01-01" && sch.last_run, "advanced, like any schedule that cannot enqueue");
});

test("ordinary bot schedules still enqueue", async () => {
  const { tickBotSchedules } = await import("../scripts/pi-bots/bot_scheduler.mjs");
  const c = raw();
  const sid = Number(c.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:writer", "*/5 * * * *", JSON.stringify({ goal: "weekly notes" }), "2020-01-01T00:00:00.000Z").lastInsertRowid);
  c.close();
  assert.equal(tickBotSchedules().fired, 1);
  const c2 = raw();
  const job = c2.prepare("SELECT bot_id, goal, status FROM bot_jobs WHERE schedule_id=?").get(sid);
  c2.close();
  assert.deepEqual({ ...job }, { bot_id: "writer", goal: "weekly notes", status: "queued" });
});

test("crow_create_schedule refuses the voice bot's botcron task (trimmed) and inserts no row; other tasks still create", async () => {
  const { createMemoryServer } = await import("../servers/memory/server.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const server = createMemoryServer(DB_FILE);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const count = (like) => { const c = raw(); const n = c.prepare("SELECT COUNT(*) AS n FROM schedules WHERE task LIKE ?").get(like).n; c.close(); return n; };
  const before = count("%crow.voice%");
  try {
    for (const task of ["pipeline:botcron:crow.voice", "  pipeline:botcron:crow.voice \n"]) {
      const r = await client.callTool({ name: "crow_create_schedule", arguments: { task, cron_expression: "0 9 * * *" } });
      assert.match(r.content[0].text, /cannot take background jobs/);
    }
    assert.equal(count("%crow.voice%"), before, "no new schedules row for the voice bot");
    const ok = await client.callTool({ name: "crow_create_schedule", arguments: { task: "pipeline:botcron:alpha", cron_expression: "0 9 * * *" } });
    assert.match(ok.content[0].text, /Schedule created/);
    const ok2 = await client.callTool({ name: "crow_create_schedule", arguments: { task: "water the plants", cron_expression: "0 9 * * *" } });
    assert.match(ok2.content[0].text, /Schedule created/);
    assert.equal(count("pipeline:botcron:alpha"), 1);
  } finally { await client.close(); }
});
