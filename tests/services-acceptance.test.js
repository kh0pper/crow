/**
 * Project services Task 21: acceptance through the real rails.
 *
 * A scratch Crow home and data dir (init-db), two projects (`spring`, `kitchen`), two GitHub
 * accounts labelled "work" and "personal" plus one Home Assistant account in `spring`, and bot
 * `b1` in `spring` selecting GitHub bare and `home-assistant/whoami`. Every rail is the real one:
 *  - Perch: the real engine (createInteractiveEngine) on a recording stub PiRpc that keeps the MCP
 *    config and the `--tools` csv it was handed, with the REAL blocks seam
 *    (scripts/pi-bots/service-blocks.mjs withServiceBlocks);
 *  - a card job: runJob -> handleInbound with the recording stub pi (PIBOT_PI_CLI, fd delivery);
 *  - channel turns: handleInbound for crow-messages, discord and gmail.
 * Each captured block is then called through the real `/services-tools/<uuid>/mcp` mount over
 * HTTP (servers/gateway/services/mount.js, with the real Perch engine as its owner-turn oracle),
 * and the refusing paths are replayed against it: a non-owner session, a finished job, a bot
 * moved to another project, a disconnected account. One app instance serves the whole file, so
 * nothing here depends on a gateway restart.
 *
 * The connection's child is the fake stdio server tests/fixtures/echo-mcp-server.mjs. No npx,
 * uvx, real service, real gateway or ~/.crow is touched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "echo-mcp-server.mjs");

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), "services-acceptance-"));
const CROW_HOME = join(dir, "home");
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = CROW_HOME;
delete process.env.CROW_DB_PATH;
delete process.env.PORT;
process.env.CROW_GATEWAY_PORT = "1";          // replaced with the real mount port in before()
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";  // blocks are fd-only
process.env.CROW_PI_SANDBOX = "off";
process.env.CROW_SERVICE_CHILD_MAX = "4";      // three accounts, so all three children can live
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
// The owner's legacy add-on blocks: the labelled service blocks replace `github` and
// `home-assistant` on an owner turn, and every other turn is unchanged.
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({
  mcpServers: {
    github: { command: "node", args: [join(dir, "github.js")] },
    "home-assistant": { command: "node", args: [join(dir, "home-assistant.js")] },
  },
}));
mkdirSync(join(CROW_HOME, "skills"), { recursive: true });
mkdirSync(join(CROW_HOME, "secrets"), { recursive: true, mode: 0o700 });

const DB_FILE = join(dir, "crow.db");
const SPRING_P = 11, KITCHEN_P = 12;
const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const HA_URL = "http://127.0.0.1:8123";
const GH_WORK = "test-token-github-work";
const GH_PERSONAL = "test-token-github-personal";
const HA_TOKEN = "test-token-ha-home";
const RESOLVED = { provider: "stub", model: "m1", key: "stub/m1" };
const BLOCKS = ["github-personal", "github-work", "home-assistant-home"];

// ---- the recording stub pi (the real PiRpc spawn path) ----------------------
const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync, readFileSync, closeSync } from "node:fs";',
  'const argv = process.argv.slice(2);',
  'const ti = argv.indexOf("--tools");',
  'const cap = { tools: ti >= 0 ? argv[ti + 1] : null, cfg: null };',
  'const fdKey = process.env.PI_BOT_MCP_CONFIG_FD;',
  'if (fdKey) { try { cap.cfg = JSON.parse(readFileSync(Number(fdKey), "utf8") || "null"); } catch (e) { cap.cfg = { error: String(e && e.code) }; } try { closeSync(Number(fdKey)); } catch {} }',
  'writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify(cap));',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let buf = "";',
  'process.stdin.on("data", (c) => {',
  '  buf += c.toString("utf8"); let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "svc-uuid" } });',
  '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
  '    else if (m.type === "prompt") { out({ type: "response", command: "prompt" }); out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }); }',
  '    else if (m.type === "abort") out({ type: "response", command: "abort" });',
  '  }',
  '});',
  'process.stdin.resume();',
].join("\n"));
process.env.PIBOT_PI_CLI = STUB_PI;

// ---- installed extensions: both services run the fake echo child ------------
writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([
  { id: "github", type: "mcp-server", version: "1.0.0" },
  { id: "home-assistant", type: "mcp-server", version: "1.0.0" },
]));
writeFileSync(join(CROW_HOME, "mcp-addons.json"), JSON.stringify({
  github: { command: "node", args: [FIXTURE], env: {} },
  "home-assistant": { command: "node", args: [FIXTURE], env: {} },
}), { mode: 0o600 });
for (const id of ["github", "home-assistant"]) {
  mkdirSync(join(CROW_HOME, "bundles", id), { recursive: true });
  writeFileSync(join(CROW_HOME, "bundles", id, "echo-control.json"), JSON.stringify({}));
}

const SB = await import("../scripts/pi-bots/service-blocks.mjs");
const bridge = await import("../scripts/pi-bots/bridge.mjs");
const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
const AS = await import("../scripts/pi-bots/actor-sig.mjs");
const C = await import("../servers/gateway/services/children.js");
const M = await import("../servers/gateway/services/mount.js");
const SC = await import("../servers/shared/service-connections.js");
const SENS = await import("../servers/shared/service-sensitivity.js");
const PI = await import("../servers/gateway/perch-interactive.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");
const { SessionManager } = await import("../servers/gateway/session-manager.js");
const { SERVICES_TOKEN } = await import("../servers/gateway/local-token.js");

function raw() { return new Database(DB_FILE); }
function q(sql, ...a) { const c = raw(); try { return c.prepare(sql).all(...a); } finally { c.close(); } }
function run(sql, ...a) { const c = raw(); try { return c.prepare(sql).run(...a); } finally { c.close(); } }
async function withDb(fn) { const d = createDbClient(DB_FILE); try { return await fn(d); } finally { d.close(); } }

function defOf(crowMcp) {
  return {
    system_prompt: "You are a test bot.",
    models: { default: "stub/m1" },
    tools: { pi_builtin: ["read"], crow_mcp: crowMcp },
    permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
    session_dir: join(dir, "bots", "b1"),
  };
}
const nodeBlock = (n) => ({ command: "node", args: [join(dir, n + ".js")] });

/**
 * Connect one account through the store, exactly as the owner's connect route does it: the row
 * and its keychain secrets, then the binding and its fingerprints in the hidden secrets dir.
 */
async function connect(projectId, serviceId, label, values) {
  return withDb(async (d) => {
    const service = serviceById(serviceId);
    const key = await ensureWriteKey(d, { crowHome: CROW_HOME });
    const config = {}, secrets = {};
    for (const f of service.fields) (f.kind === "secret" ? secrets : config)[f.name] = values[f.name];
    const c = await SC.createConnection(d, { projectId, serviceId, accountLabel: label, config, secrets, testedAt: new Date() }, { key });
    SENS.recordConnectionBinding(c, { crowHome: CROW_HOME, service, values: { config: c.config, secrets } });
    return c;
  });
}

// ---- the Perch engine: the real one, a recording PiRpc, the real blocks seam --
let pidSeq = 800000;
const instances = [];
function makeEngine(createInteractiveEngine) {
  class FakePi {
    constructor(o) {
      this.opts = o; this.onEvent = o.onEvent; this.turns = []; this._exitCode = null;
      this.proc = { pid: ++pidSeq }; this.piSessionId = "pisess-" + this.proc.pid;
      // The real csv assembly, so the budget check counts what pi would get.
      this.toolsCsv = bridge.buildToolsCsv(o.def, {
        resolved: o.resolved, interactive: true, serviceBlocks: o.serviceBlocks || null, serviceSkippedTools: o.serviceSkippedTools || [],
      }).csv;
      let done; this.exited = new Promise((r) => { done = r; }); this._done = done;
      instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message) {
      const rec = { message };
      rec.promise = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {} async abortSince() { return null; } send() {}
    async close() { this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited"); }
  }
  const seam = {
    PiRpc: FakePi, LIFECYCLE_DEFAULTS: { maxPi: 8 }, countLivePi: () => 0,
    // The world the engine builds: the bot def as it is in crow.db NOW (so a move is seen) and
    // the def's project as the authority.
    async buildBotWorld(args) {
      const row = q("SELECT definition, display_name, project_id FROM pi_bot_defs WHERE bot_id = ?", args.botId)[0];
      assert.ok(row, "the bot def exists");
      return {
        def: JSON.parse(row.definition), bot: { bot_id: args.botId, display_name: row.display_name },
        crowHome: CROW_HOME, projectId: row.project_id == null ? null : Number(row.project_id),
        projectSpace: null, projectMembers: [], sessionDir: join(dir, "bots", args.botId),
        tasksDbPath: process.env.CROW_TASKS_DB_PATH, remoteEnabled: false, peerGatewayUrls: {},
        session: null, narrowedTools: null, gatewayType: args.gatewayType, mcpDelivery: "fd",
        mcpConfig: { mcpServers: { github: nodeBlock("github"), "home-assistant": nodeBlock("home-assistant") } },
        _mcpArgs: { botId: args.botId, threadId: args.threadId, gatewayType: args.gatewayType, jobId: null },
      };
    },
    async prepareSpawn(world) {
      return {
        sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved: RESOLVED,
        piRpcOpts: {
          def: world.def, sessionDir: world.sessionDir, resolved: RESOLVED, piProvider: "stub", remoteEnabled: false,
          narrowedTools: null, mcpDelivery: world.mcpDelivery, mcpConfig: world.mcpConfig, appendSystemPromptFile: join(dir, "sys.md"),
        },
      };
    },
    withServiceBlocks: SB.withServiceBlocks, offerableConnections: SB.offerableConnections,
    async warmModel() {}, async meterTurn() { return { recorded: true }; }, appendAudit() {},
    planForCard: () => null, projectContextBlock: () => "", cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "done"], terminals: ["done"] }), cardText: () => ({ title: "T", description: null }),
  };
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME, env: { CROW_HOME }, bridge: seam, log: () => {},
    now: () => 1_700_000_000_000, setTimer: () => 0, clearTimer: () => {},
  });
  return engine;
}
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---- HTTP against the captured block's own URL and headers -------------------
const serviceUrls = (cfg) => Object.entries((cfg && cfg.mcpServers) || {})
  .filter(([, b]) => b && typeof b.url === "string" && b.url.includes("/services-tools/"));

let rpcId = 0;
const rpcBody = (method, params) => ({ jsonrpc: "2.0", id: ++rpcId, method, params });
async function blockSend(block, body, { sid } = {}) {
  const res = await fetch(block.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...block.headers,
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  const ct = res.headers.get("content-type") || "";
  if (text) {
    if (ct.includes("text/event-stream")) {
      const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop();
      if (data) { try { json = JSON.parse(data); } catch { json = null; } }
    } else {
      try { json = JSON.parse(text); } catch { json = null; }
    }
  }
  return { status: res.status, text, json, sid: res.headers.get("mcp-session-id") };
}
const initOf = (block) => blockSend(block, rpcBody("initialize", {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "acceptance", version: "1" },
}));
async function openBlock(block) {
  const r = await initOf(block);
  assert.equal(r.status, 200, `${block.url}: initialize ${r.status} ${r.text}`);
  assert.ok(r.sid, "a session id");
  return r.sid;
}
const callWhoami = (block, sid) => blockSend(block, rpcBody("tools/call", { name: "whoami", arguments: {} }), { sid });
const textOf = (r) => (r.json?.result?.content || []).map((c) => c.text).join("\n");
const errMsg = (r) => r.json?.error?.message;
/** Call whoami on every block and return what the child answered. */
async function whoamiEverywhere(blocks) {
  const out = {};
  for (const [name, block] of Object.entries(blocks)) {
    const sid = await openBlock(block);
    const r = await callWhoami(block, sid);
    assert.equal(r.status, 200, `${name}: ${r.text}`);
    assert.equal(r.json?.result?.isError, undefined, `${name}: ${textOf(r)}`);
    const info = JSON.parse(textOf(r));
    assert.ok(Array.isArray(info.keys), `${name}: ${textOf(r)}`);
    out[name] = info;
  }
  return out;
}

// ---- the real rails' recorders ---------------------------------------------
let capSeq = 0;
function nextCapture() { const p = join(dir, `cap-${++capSeq}.json`); process.env.PIBOT_TEST_CAPTURE = p; return p; }
const readCapture = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
async function inbound(botId, opts = {}) {
  const capture = nextCapture();
  const logs = [];
  const r = await bridge.handleInbound({
    bot_id: botId, gateway_thread_id: opts.thread || ("t-" + capSeq), gateway_type: opts.gateway || "gmail",
    user_message: opts.message || "hi", job_id: opts.jobId, sendReply: async () => {}, log: (m) => logs.push(String(m)),
  });
  return { r, logs, cap: readCapture(capture) };
}
async function job(row, logs = []) {
  const capture = nextCapture();
  const r = await runJob(row, { log: (m) => logs.push(String(m)), bridge });
  return { r, logs, cap: readCapture(capture) };
}
function addJob(jobId, botId, { principal = null, cardId = null } = {}) {
  run(
    "INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id, worker_pid, principal, started_at) " +
    "VALUES (?,?,?,'running',?,?,?,?, datetime('now'))",
    jobId, botId, "do the thing", cardId == null ? "manual" : "card", cardId, process.pid, principal,
  );
  return q("SELECT * FROM bot_jobs WHERE job_id = ?", jobId)[0];
}

// ---- the whole file's state ------------------------------------------------
let ENG = null, app = null, srvHttp = null, sessions = null, handle = null, mountBase = "", TOKEN = null;
const U = {};          // connection uuids
const audit = [];       // the mount's onAudit events
const lastOutcome = () => audit.at(-1)?.outcome;
const S = {};           // steps' captured blocks/sessions

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  run("INSERT INTO project_spaces (id, slug, name) VALUES (?, 'spring', 'Spring')", SPRING_P);
  run("INSERT INTO project_spaces (id, slug, name) VALUES (?, 'kitchen', 'Kitchen')", KITCHEN_P);
  run("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('b1','B1',?,1,?)",
    JSON.stringify(defOf(["github", "home-assistant/whoami"])), SPRING_P);

  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO tasks_items (id, title, project_id, status, assigned_bot) VALUES (61, 'the card', ?, 'pending', 'b1')").run(SPRING_P);
  t.close();

  U.work = (await connect(SPRING_P, "github", "work", { [GH]: GH_WORK })).uuid;
  U.personal = (await connect(SPRING_P, "github", "personal", { [GH]: GH_PERSONAL })).uuid;
  U.home = (await connect(SPRING_P, "home-assistant", "home", { HA_URL, HA_TOKEN })).uuid;

  AS._resetActorKeyForTest();
  AS.initGatewayActorKey();
  await withDb(async (d) => { TOKEN = await SERVICES_TOKEN.rotate(d); });

  // The real engine, installed as this process's singleton: the mount asks it whose turn it is.
  ENG = makeEngine(PI.createInteractiveEngine);
  PI._setInteractiveEngineForTest(ENG);

  sessions = new SessionManager();
  app = express();
  app.use(express.json({ limit: "1mb" }));
  handle = M.mountServicesTools(app, {
    sessionManager: sessions,
    createDbClient: () => createDbClient(DB_FILE),
    perchEngine: await M.perchEngineAccessor(),
    crowHome: CROW_HOME,
    onAudit: (e) => audit.push(e),
  });
  await new Promise((r) => { srvHttp = app.listen(0, "127.0.0.1", r); });
  mountBase = `http://127.0.0.1:${srvHttp.address().port}`;
  // The blocks name the gateway's listen port, so it must be the mount's own port.
  process.env.CROW_GATEWAY_PORT = String(srvHttp.address().port);
});

after(async () => {
  try { handle?.stop(); } catch { /* stopped */ }
  try { await sessions?.closeAll(); } catch { /* closed */ }
  try { sessions?.dispose(); } catch { /* disposed */ }
  await new Promise((r) => (srvHttp ? srvHttp.close(r) : r()));
  srvHttp?.closeAllConnections?.();
  try { await ENG?.stopAll(); } catch { /* stopped */ }
  try { await C.stopAllChildren(); } catch { /* stopped */ }
  PI._resetInteractiveEngineForTest();
  AS._resetActorKeyForTest();
  AS._resetPresignedForTest();
  rmScratch(dir);
});

// ---------------------------------------------------------------------------
// (a) the Perch owner turn
// ---------------------------------------------------------------------------

test("(a) a Perch owner turn captures labelled blocks for both GitHub accounts and Home Assistant, and the mount answers whoami on each", { timeout: 120_000 }, async () => {
  const r = await ENG.spawn({ botId: "b1", principal: "owner" });
  await tick();
  const pi = instances.at(-1);
  assert.ok(pi, "a child started");
  const blocks = Object.fromEntries(serviceUrls(pi.opts.mcpConfig));
  assert.deepEqual(Object.keys(blocks).sort(), BLOCKS, "one block per account; the bare service ids are replaced");
  assert.deepEqual(pi.opts.mcpConfig.mcpServers.github, { disabled: true });
  assert.deepEqual(pi.opts.mcpConfig.mcpServers["home-assistant"], { disabled: true });
  const names = pi.toolsCsv.split(",");
  assert.ok(names.includes("mcp__github-work"), "the bare GitHub selection names both blocks: " + pi.toolsCsv);
  assert.ok(names.includes("mcp__home-assistant-home__whoami"), pi.toolsCsv);

  const row = q("SELECT id FROM bot_sessions WHERE gateway_thread_id = ? ORDER BY id DESC LIMIT 1", r.threadId)[0];
  assert.ok(row, "the spawn stamped a session row");
  assert.equal(ENG.sessionServicesLive(row.id), true, "the mount will see this session as the owner's");
  for (const block of Object.values(blocks)) {
    assert.ok(block.url.startsWith(mountBase + "/services-tools/"), block.url);
    assert.equal(block.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(block.headers["X-Crow-Actor-Scope"], "s:" + row.id);
    assert.equal(block.headers["X-Crow-Actor-Gateway"], "perch");
  }

  const answers = await whoamiEverywhere(blocks);
  assert.ok(answers["github-work"].keys.includes(GH), "the work child got its token");
  assert.ok(answers["github-personal"].keys.includes(GH), "the personal child got its token");
  assert.ok(answers["home-assistant-home"].keys.includes("HA_URL") && answers["home-assistant-home"].keys.includes("HA_TOKEN"));
  S.perch = { sessionId: r.sessionId, blocks };
});

// ---------------------------------------------------------------------------
// (b) the card job rail
// ---------------------------------------------------------------------------

test("(b) an owner card job through runJob captures the same three blocks; the mount serves them while the job runs and refuses them once it is done", { timeout: 120_000 }, async () => {
  const row = addJob("job-accept-card", "b1", { principal: "owner", cardId: 61 });
  const { r, logs, cap } = await job(row);
  assert.ok(r && r.result != null, JSON.stringify(r) + " " + logs.join("|"));
  assert.ok(cap && cap.cfg && cap.cfg.mcpServers, "the stub pi read its config from the fd");
  const blocks = Object.fromEntries(serviceUrls(cap.cfg));
  assert.deepEqual(Object.keys(blocks).sort(), BLOCKS, logs.join("|"));
  assert.deepEqual(cap.cfg.mcpServers.github, { disabled: true });
  for (const block of Object.values(blocks)) {
    assert.equal(block.headers["X-Crow-Actor-Scope"], `j:job-accept-card@${process.pid}`);
    assert.equal(block.headers["X-Crow-Actor-Thread"], "board-card-61");
    assert.equal(block.headers["X-Crow-Actor-Gateway"], "board");
  }
  await whoamiEverywhere(blocks);

  // The job's caller finalizes the row: the scope is no longer a running job, so the mount refuses.
  run("UPDATE bot_jobs SET status = 'completed', ended_at = datetime('now') WHERE job_id = 'job-accept-card'");
  audit.length = 0;
  const refusedAfter = await initOf(blocks["github-work"]);
  assert.equal(refusedAfter.status, 403, refusedAfter.text);
  assert.equal(errMsg(refusedAfter), "A signed bot is required.");
  assert.equal(lastOutcome(), "refused:unattributed");
  S.job = { blocks };
});

// ---------------------------------------------------------------------------
// (c) the channels get nothing
// ---------------------------------------------------------------------------

test("(c) crow-messages, discord and gmail turns capture no blocks and no labelled tool names", { timeout: 120_000 }, async () => {
  for (const gateway of ["crow-messages", "discord", "gmail"]) {
    const { r, logs, cap } = await inbound("b1", { gateway });
    assert.equal(r.action, "asked", `${gateway}: ${JSON.stringify(r)}`);
    assert.ok(cap && cap.cfg && cap.cfg.mcpServers, `${gateway}: the stub read its config`);
    assert.deepEqual(serviceUrls(cap.cfg), [], gateway);
    assert.ok(!Object.keys(cap.cfg.mcpServers).some((k) => k.startsWith("github-") || k.startsWith("home-assistant-")), gateway);
    const csvNames = String(cap.tools || "").split(",");
    for (const name of BLOCKS) {
      assert.ok(!csvNames.some((n) => n === `mcp__${name}` || n.startsWith(`mcp__${name}__`)), `${gateway}: ${name} is not in the csv (${cap.tools})`);
    }
    assert.ok(logs.includes(`services: turn from ${gateway} sender, owner accounts not offered`), `${gateway}: ${logs.join("|")}`);
  }
});

// ---------------------------------------------------------------------------
// a non-owner turn on the live Perch session
// ---------------------------------------------------------------------------

test("replaying (a)'s headers once the Perch session is not the owner's turn is 403 not_owner_turn", { timeout: 120_000 }, async () => {
  const before = instances.length;
  await ENG.message(S.perch.sessionId, "hello from someone else", [], { principal: "other" });
  await tick();
  assert.ok(instances.length > before, "the child was cycled for a non-owner turn");
  const cycled = instances.at(-1);
  assert.deepEqual(serviceUrls(cycled.opts.mcpConfig), [], "the cycled child holds no blocks");
  for (const turn of cycled.turns) turn.resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();

  audit.length = 0;
  const r = await initOf(S.perch.blocks["github-work"]);
  assert.equal(r.status, 403, r.text);
  assert.equal(errMsg(r), "Not available on this turn.");
  assert.equal(lastOutcome(), "refused:not_owner_turn");
  await ENG.stop(S.perch.sessionId);
});

// ---------------------------------------------------------------------------
// the bot's def moves to another project
// ---------------------------------------------------------------------------

test("a moved bot: the old s: headers are 403 wrong_project, and the next Perch spawn in the new project captures no blocks", { timeout: 120_000 }, async () => {
  // A live owner session while the def still says spring: these are the "old" headers.
  const own = await ENG.spawn({ botId: "b1", principal: "owner" });
  await tick();
  const before = Object.fromEntries(serviceUrls(instances.at(-1).opts.mcpConfig));
  assert.deepEqual(Object.keys(before).sort(), BLOCKS);

  run("UPDATE pi_bot_defs SET project_id = ? WHERE bot_id = 'b1'", KITCHEN_P);
  audit.length = 0;
  const refused = await initOf(before["github-work"]);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(errMsg(refused), "Not available on this turn.");
  assert.equal(lastOutcome(), "refused:wrong_project");

  const moved = await ENG.spawn({ botId: "b1", principal: "owner" });
  await tick();
  const pi = instances.at(-1);
  assert.deepEqual(serviceUrls(pi.opts.mcpConfig), [], "kitchen has no connections");
  assert.ok(!pi.toolsCsv.split(",").some((n) => n.startsWith("mcp__github-work") || n.startsWith("mcp__home-assistant-home")), pi.toolsCsv);
  await ENG.stop(moved.sessionId);
  await ENG.stop(own.sessionId);

  run("UPDATE pi_bot_defs SET project_id = ? WHERE bot_id = 'b1'", SPRING_P);
});

// ---------------------------------------------------------------------------
// an account is disconnected
// ---------------------------------------------------------------------------

test("a disconnected account: the next owner turn captures the remaining two blocks, and the old uuid's headers are 409 not_active", { timeout: 120_000 }, async () => {
  const first = await ENG.spawn({ botId: "b1", principal: "owner" });
  await tick();
  const before = Object.fromEntries(serviceUrls(instances.at(-1).opts.mcpConfig));
  assert.deepEqual(Object.keys(before).sort(), BLOCKS);

  await withDb((d) => SC.disconnectConnection(d, U.personal));

  const next = await ENG.spawn({ botId: "b1", principal: "owner" });
  await tick();
  const remaining = Object.fromEntries(serviceUrls(instances.at(-1).opts.mcpConfig));
  assert.deepEqual(Object.keys(remaining).sort(), ["github-work", "home-assistant-home"], "personal is gone from the turn");
  await whoamiEverywhere(remaining);

  audit.length = 0;
  const gone = await initOf(before["github-personal"]);
  assert.equal(gone.status, 409, gone.text);
  assert.equal(errMsg(gone), "This connection is turned off.");
  assert.equal(lastOutcome(), "refused:not_active");

  await ENG.stop(next.sessionId);
  await ENG.stop(first.sessionId);
});