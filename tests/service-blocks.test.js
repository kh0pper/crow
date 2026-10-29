/**
 * Project services Task 18: on the owner's own turns a project's bots get one labelled MCP block
 * per connected account (scripts/pi-bots/service-blocks.mjs, the one seam withServiceBlocks), and
 * no other turn gets any.
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR) and Crow home, a scratch canonical
 * ~/.pi/agent/mcp.json (HOME), the services family token at <home>/secrets/services-token, and a
 * recording stub pi (PIBOT_PI_CLI) that reads its MCP config from the inherited fd and records its
 * --tools csv. The Perch engine runs on a fake bridge seam with the REAL withServiceBlocks. A
 * stub loopback signing relay stands in for the gateway on the key-less legs. No real pi, npx,
 * uvx, gateway or ~/.crow is touched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), "service-blocks-"));
const CROW_HOME = join(dir, "home");
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = CROW_HOME;
delete process.env.CROW_DB_PATH;
delete process.env.PORT;
process.env.CROW_GATEWAY_PORT = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
process.env.CROW_PI_SANDBOX = "off";
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
const srv = (n) => ({ command: "node", args: [join(dir, n + ".js")] });
// The owner's legacy add-on blocks: `github` is replaced by the labelled ones, `brave-search` stays.
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { github: srv("github"), "brave-search": srv("brave") } }));
mkdirSync(join(CROW_HOME, "skills"), { recursive: true });
mkdirSync(join(CROW_HOME, "secrets"), { recursive: true, mode: 0o700 });
const SERVICES_TOKEN_VALUE = "svc-family-token-0123456789abcdef";
writeFileSync(join(CROW_HOME, "secrets", "services-token"), SERVICES_TOKEN_VALUE, { mode: 0o600 });

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HOME_P = 7, SPRING_P = 8;
const KEYCHAIN_SECRET = "ghp_ThisIsTheOwnersKeychainValue000000000";

// ---- the recording stub pi -------------------------------------------------
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

const SB = await import("../scripts/pi-bots/service-blocks.mjs");
const bridge = await import("../scripts/pi-bots/bridge.mjs");
const { runJob, claimNextJob } = await import("../scripts/pi-bots/job_runner.mjs");
const AS = await import("../scripts/pi-bots/actor-sig.mjs");
const SENS = await import("../servers/shared/service-sensitivity.js");
const { writeToolCache } = await import("../servers/gateway/services/tool-cache.js");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = { work: uuid(1), personal: uuid(2), spring: uuid(3), notion: uuid(4), forged: uuid(5) };
const RESOLVED = { provider: "stub", model: "m1", key: "stub/m1" };

function raw() { return new Database(DB_FILE); }
function q(sql, ...a) { const c = raw(); try { return c.prepare(sql).all(...a); } finally { c.close(); } }
function run(sql, ...a) { const c = raw(); try { return c.prepare(sql).run(...a); } finally { c.close(); } }

function defOf(crowMcp, extra = {}) {
  return {
    system_prompt: "You are a test bot.", models: { default: "stub/m1" },
    tools: { pi_builtin: ["read"], crow_mcp: crowMcp },
    permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
    ...extra,
  };
}
function addBot(botId, crowMcp, projectId = HOME_P) {
  run("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)",
    botId, botId, JSON.stringify(defOf(crowMcp, { session_dir: join(dir, "bots", botId) })), projectId);
}
function addConnection(u, projectId, serviceId, label, slug, { bind = true } = {}) {
  run("INSERT INTO service_connections (uuid, project_id, service_id, bundle_id, method, account_label, label_slug, status) VALUES (?,?,?,?,?,?,?, 'active')",
    u, projectId, serviceId, serviceId, "paste_key", label, slug);
  if (bind) SENS.recordConnectionBinding({ uuid: u, serviceId }, { crowHome: CROW_HOME });
}

let capSeq = 0;
async function inbound(botId, opts = {}) {
  const capture = join(dir, `cap-${++capSeq}.json`);
  process.env.PIBOT_TEST_CAPTURE = capture;
  const logs = [];
  const r = await bridge.handleInbound({
    bot_id: botId, gateway_thread_id: opts.thread || ("t-" + capSeq), gateway_type: opts.gateway || "gmail",
    user_message: opts.message || "hi", job_id: opts.jobId, sendReply: async () => {}, log: (m) => logs.push(String(m)),
  });
  return { r, logs, cap: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : null };
}
async function job(row, { logs = [] } = {}) {
  const capture = join(dir, `cap-${++capSeq}.json`);
  process.env.PIBOT_TEST_CAPTURE = capture;
  const r = await runJob(row, { log: (m) => logs.push(String(m)), bridge });
  return { r, logs, cap: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : null };
}
function addJob(jobId, botId, { principal = null, cardId = null, workerPid = process.pid } = {}) {
  run("INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id, worker_pid, principal, started_at) VALUES (?,?,?,'running',?,?,?,?, datetime('now'))",
    jobId, botId, "do the thing", cardId == null ? "manual" : "card", cardId, workerPid, principal);
  return q("SELECT * FROM bot_jobs WHERE job_id=?", jobId)[0];
}
const serviceUrls = (cfg) => Object.entries((cfg && cfg.mcpServers) || {}).filter(([, b]) => b && typeof b.url === "string" && b.url.includes("/services-tools/"));

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  run("INSERT INTO project_spaces (id, slug, name) VALUES (?, 'home', 'Home')", HOME_P);
  run("INSERT INTO project_spaces (id, slug, name) VALUES (?, 'spring', 'Spring')", SPRING_P);
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
  for (let id = 41; id <= 46; id++) t.prepare("INSERT INTO tasks_items (id, title, project_id, status, assigned_bot) VALUES (?, 'card', ?, 'pending', 'hank')").run(id, HOME_P);
  t.close();
  addConnection(U.work, HOME_P, "github", "Work", "work");
  addConnection(U.personal, HOME_P, "github", "Personal", "personal");
  addConnection(U.spring, SPRING_P, "github", "Spring", "spring");
  addConnection(U.notion, HOME_P, "notion", "Notes", "notes"); // sensitive by default (Task 16c)
  addBot("hank", ["github/get_me", "notion/search"]);
  addBot("nora", ["brave-search/search"]);   // selects none of the connected services
  // A keychain value for the work account: it must never reach a block.
  const { createDbClient } = await import("../servers/db.js");
  const K = await import("../servers/gateway/keychain/store.js");
  const { createKeychainKey } = await import("../servers/gateway/keychain/key.js");
  const db = createDbClient(DB_FILE);
  try { await K.saveServiceSecret(db, createKeychainKey({ crowHome: CROW_HOME }), { connectionUuid: U.work, bundleId: "github", envKey: "GITHUB_TOKEN", secret: KEYCHAIN_SECRET }); }
  finally { db.close(); }
});
after(() => { AS._resetActorKeyForTest(); AS._resetPresignedForTest(); rmSync(dir, { recursive: true, force: true }); });

const conns = () => { const c = raw(); try { return SB.readProjectConnectionsSync(c, HOME_P); } finally { c.close(); } };
const hankDef = () => defOf(["github/get_me", "notion/search"]);
const jobActorOf = (jobId) => ({ botId: "hank", jobId, threadId: "job-" + jobId, gatewayType: "job" });

// ---------------------------------------------------------------------------
// Step 0 (plan): Task 15 is on main (verification only; nothing rebuilt here)
// ---------------------------------------------------------------------------

test("Task 15 pieces this task consumes exist: v3 service kind, scope signing, owner-job-only relay, services token", async () => {
  assert.deepEqual([...AS.SCOPE_ACTOR_KINDS], ["service"]);
  for (const f of ["signScopeActor", "verifyScopeActorSig", "scopeRefFor", "presignActors"]) assert.equal(typeof AS[f], "function", f);
  const { ACTOR_SIGN_KINDS } = await import("../servers/gateway/routes/actor-sign.js");
  assert.ok(ACTOR_SIGN_KINDS.includes("service"));
  const { SERVICES_TOKEN } = await import("../servers/gateway/local-token.js");
  assert.equal(SERVICES_TOKEN.path(), join(CROW_HOME, "secrets", "services-token"));
});

// ---------------------------------------------------------------------------
// the pure parts
// ---------------------------------------------------------------------------

test("other project: readProjectConnectionsSync reads this project's active owner rows only; null is []", () => {
  const list = conns();
  assert.deepEqual(list.map((c) => c.uuid), [U.personal, U.work, U.notion], "service, slug, id order");
  assert.ok(!list.some((c) => c.uuid === U.spring), "spring's row is not offered in home");
  assert.equal(list.find((c) => c.uuid === U.work).blockName, "github-work");
  const c = raw();
  try { assert.deepEqual(SB.readProjectConnectionsSync(c, null), []); } finally { c.close(); }
  assert.deepEqual(SB.readProjectConnectionsSync(null, HOME_P), [], "no handle, nothing");
});

test("selection (C4) and sensitivity (Task 16c): only selected, bound, non-sensitive connections are offerable", () => {
  assert.deepEqual([...SB.selectedServiceIds(hankDef(), conns())].sort(), ["github", "notion"]);
  assert.deepEqual([...SB.selectedServiceIds(defOf(["brave-search/search"]), conns())], []);
  const offer = SB.offerableConnections(hankDef(), conns(), { crowHome: CROW_HOME }).map((c) => c.uuid).sort();
  assert.deepEqual(offer, [U.personal, U.work].sort(), "notion is sensitive by default: never a block");
  // A binding mismatch (a bot rewrote the row's service_id) is never offered.
  const tampered = conns().map((c) => (c.uuid === U.notion ? { ...c, serviceId: "github", blockName: "github-notes" } : c));
  assert.ok(!SB.offerableConnections(hankDef(), tampered, { crowHome: CROW_HOME }).some((c) => c.uuid === U.notion));
});

test("two accounts two blocks: one block each, the csv names both, never the bare service", () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const a = jobActorOf("job-two-1");
  const scopeRef = AS.scopeRefFor({ jobId: a.jobId });
  const r = SB.serviceBlocksFor({ def: hankDef(), connections: conns(), actor: a, scopeRef, ownerTurn: true, crowHome: CROW_HOME, port: 4321, delivery: "fd", token: SERVICES_TOKEN_VALUE });
  assert.deepEqual(Object.keys(r.blocks).sort(), ["github-personal", "github-work"]);
  assert.deepEqual(r.byService, { github: ["github-personal", "github-work"] });
  assert.equal(r.blocks["github-work"].url, `http://127.0.0.1:4321/services-tools/${U.work}/mcp`);
  const h = r.blocks["github-work"].headers;
  assert.deepEqual(Object.keys(h).sort(), ["Authorization", "X-Crow-Actor-Gateway", "X-Crow-Actor-Id", "X-Crow-Actor-Kind", "X-Crow-Actor-Scope", "X-Crow-Actor-Sig", "X-Crow-Actor-Thread"]);
  assert.equal(h["X-Crow-Actor-Scope"], `j:job-two-1@${process.pid}`);
  assert.equal(AS.verifyScopeActorSig({ kind: "service", botId: "hank", scope: h["X-Crow-Actor-Scope"], threadId: a.threadId, gatewayType: "job", sig: h["X-Crow-Actor-Sig"] }), true);
  const { csv } = bridge.buildToolsCsv(hankDef(), { resolved: RESOLVED, serviceBlocks: r.byService, serviceSkippedTools: r.skippedTools });
  const names = csv.split(",");
  assert.ok(names.includes("mcp__github-work__get_me") && names.includes("mcp__github-personal__get_me"), csv);
  assert.ok(!names.includes("mcp__github__get_me"), csv);
  assert.ok(names.includes("mcp__notion__search"), "a service with no blocks keeps today's spelling (its server is absent, so pi has nothing)");
});

test("canonical replaced: the owner's own `github` block turns off, `brave-search` with no connection keeps its block", () => {
  const cfg = { mcpServers: { github: srv("github"), "brave-search": srv("brave") } };
  const r = { blocks: { "github-work": { url: "u" } }, byService: { github: ["github-work"] } };
  const out = SB.applyServiceBlocks(cfg, r);
  assert.deepEqual(out.mcpServers.github, { disabled: true });
  assert.deepEqual(out.mcpServers["brave-search"], srv("brave"));
  assert.deepEqual(out.mcpServers["github-work"], { url: "u" });
  assert.deepEqual(cfg.mcpServers.github, srv("github"), "a new object; the input is untouched");
  assert.equal(SB.applyServiceBlocks(null, r), null, "a failed build is not turned into a services-only config");
});

test("block carries no secret: no keychain value, only the url, the family token and the actor headers", () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const a = jobActorOf("job-nosecret");
  const r = SB.serviceBlocksFor({ def: hankDef(), connections: conns(), actor: a, scopeRef: AS.scopeRefFor({ jobId: a.jobId }), ownerTurn: true, crowHome: CROW_HOME, delivery: "fd", token: SERVICES_TOKEN_VALUE });
  assert.ok(Object.keys(r.blocks).length === 2);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(KEYCHAIN_SECRET), "the keychain value never leaves the gateway");
  for (const b of Object.values(r.blocks)) {
    assert.deepEqual(Object.keys(b).sort(), ["headers", "url"], "no env, no command, no args");
  }
});

test("reserved name (I9) and own-name dedupe (ruling 7): a config key or reserved name is skipped with the warning; the first of two equal names wins", () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const a = jobActorOf("job-reserved");
  const scopeRef = AS.scopeRefFor({ jobId: a.jobId });
  const r = SB.serviceBlocksFor({ def: hankDef(), connections: conns(), actor: a, scopeRef, ownerTurn: true, crowHome: CROW_HOME, delivery: "fd", token: SERVICES_TOKEN_VALUE, existingNames: new Set(["github-work"]) });
  assert.deepEqual(Object.keys(r.blocks), ["github-personal"]);
  assert.ok(r.warnings.includes("services: block github-work collides, skipped"), r.warnings.join("|"));
  const twice = [...conns(), { ...conns().find((c) => c.uuid === U.personal), uuid: U.forged }];
  SENS.recordConnectionBinding({ uuid: U.forged, serviceId: "github" }, { crowHome: CROW_HOME });
  const d = SB.serviceBlocksFor({ def: hankDef(), connections: twice, actor: a, scopeRef, ownerTurn: true, crowHome: CROW_HOME, delivery: "fd", token: SERVICES_TOKEN_VALUE });
  assert.equal(d.blocks["github-personal"].url.includes(U.personal), true, "first wins, in connectionsFor order");
  assert.ok(d.warnings.some((w) => /github-personal named twice/.test(w)));
  // R13: the reserved set holds the canonical config's names.
  assert.ok(SB.reservedBlockNames(CROW_HOME).has("brave-search"));
});

test("long tool names skipped (I10): a cached 50-character tool on canvas-lms-<16-char slug> goes to skippedTools, not the csv", () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const slug = "abcdefghijklmnop";
  const long = "t".repeat(50);
  const c = [{ uuid: uuid(60), serviceId: "canvas-lms", bundleId: "canvas-lms", accountLabel: "X", labelSlug: slug, blockName: "canvas-lms-" + slug }];
  SENS.recordConnectionBinding({ uuid: uuid(60), serviceId: "canvas-lms" }, { crowHome: CROW_HOME });
  const def = defOf(["canvas-lms/" + long, "canvas-lms/short"]);
  const a = jobActorOf("job-long");
  const r = SB.serviceBlocksFor({ def, connections: c, actor: a, scopeRef: AS.scopeRefFor({ jobId: a.jobId }), ownerTurn: true, crowHome: CROW_HOME, delivery: "fd", token: SERVICES_TOKEN_VALUE,
    toolsFor: () => [{ name: long }, { name: "short" }] });
  const full = `mcp__canvas-lms-${slug}__${long}`;
  assert.ok(full.length > 64);
  assert.deepEqual(r.skippedTools, [full]);
  assert.ok(r.warnings.some((w) => w.includes(full) && /over 64/.test(w)));
  const { csv } = bridge.buildToolsCsv(def, { resolved: RESOLVED, serviceBlocks: r.byService, serviceSkippedTools: r.skippedTools });
  assert.ok(!csv.includes(long), csv);
  assert.ok(csv.split(",").includes(`mcp__canvas-lms-${slug}__short`), csv);
});

test("the tool cache read is the children's (cachedServiceTools == serviceTools)", async () => {
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "github", version: "1.2.3" }]));
  writeToolCache(CROW_HOME, "github", "1.2.3", [{ name: "get_me", description: "who", inputSchema: { type: "object" } }]);
  const { serviceTools } = await import("../servers/gateway/services/children.js");
  assert.deepEqual(SB.cachedServiceTools("github", { crowHome: CROW_HOME }), serviceTools("github", { crowHome: CROW_HOME }));
  assert.equal(SB.cachedServiceTools("github", { crowHome: CROW_HOME })[0].name, "get_me");
  rmSync(join(CROW_HOME, "installed.json"));
});

test("not the owner's turn, a missing scope, file mode or the voice bot: no blocks, and the reason is logged", () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const a = jobActorOf("job-gates");
  const scopeRef = AS.scopeRefFor({ jobId: a.jobId });
  const base = { def: hankDef(), connections: conns(), actor: a, scopeRef, ownerTurn: true, crowHome: CROW_HOME, delivery: "fd", token: SERVICES_TOKEN_VALUE };
  const none = (o, warn) => { const r = SB.serviceBlocksFor({ ...base, ...o }); assert.deepEqual(r.blocks, {}); assert.ok(r.warnings.includes(warn), r.warnings.join("|")); };
  none({ ownerTurn: false }, "services: turn from job sender, owner accounts not offered");
  none({ scopeRef: null }, "services: turn from job sender, owner accounts not offered");
  none({ delivery: "file" }, SB.WARN_FILE_MODE);
  none({ token: null }, SB.WARN_UNSIGNED);
  none({ actor: { ...a, botId: "crow.voice" } }, "services: turn from job sender, owner accounts not offered");
  none({ scopeRef: "j:job-other@" + process.pid }, SB.WARN_UNSIGNED); // a scope the tuple does not name
});

test("turnScopeFor: a job is the owner's only for principal 'owner' claimed by this process; channels never; perch from the engine", () => {
  assert.deepEqual(SB.turnScopeFor({ gatewayType: "board", jobId: "job-a", principal: "owner", workerPid: process.pid }), { scopeRef: `j:job-a@${process.pid}`, ownerTurn: true, notClaimer: false });
  for (const p of [null, "other", "Owner", "device:1"]) assert.equal(SB.turnScopeFor({ gatewayType: "board", jobId: "job-a", principal: p, workerPid: process.pid }).ownerTurn, false, String(p));
  const elsewhere = SB.turnScopeFor({ gatewayType: "job", jobId: "job-a", principal: "owner", workerPid: process.pid + 1 });
  assert.equal(elsewhere.ownerTurn, false);
  assert.equal(elsewhere.notClaimer, true);
  for (const g of ["gmail", "discord", "telegram", "slack", "crow-messages", "board", undefined]) {
    assert.deepEqual(SB.turnScopeFor({ gatewayType: g, sessionRowId: 5, perchOwner: true }), { scopeRef: null, ownerTurn: false }, String(g));
  }
  assert.deepEqual(SB.turnScopeFor({ gatewayType: "perch", sessionRowId: 5, perchOwner: true }), { scopeRef: "s:5", ownerTurn: true });
  assert.deepEqual(SB.turnScopeFor({ gatewayType: "perch", sessionRowId: 5 }), { scopeRef: "s:5", ownerTurn: false });
});

test("lane A: bot_jobs.worker_pid is the claiming process's pid (a move to child-process claiming must fail this)", () => {
  run("INSERT INTO bot_jobs (job_id, bot_id, goal, status, source) VALUES ('job-claim-1','hank','g','queued','manual')");
  run("UPDATE bot_jobs SET principal='owner' WHERE job_id='job-claim-1'");
  const row = claimNextJob();
  assert.equal(row.job_id, "job-claim-1");
  assert.equal(row.worker_pid, process.pid, "the claimer is this process");
  assert.equal(SB.turnScopeFor({ gatewayType: "job", jobId: row.job_id, principal: row.principal, workerPid: row.worker_pid }).ownerTurn, true);
  // The relay and the mount use the same pid: the scope this process signs names it.
  assert.equal(AS.scopeRefFor({ jobId: row.job_id }), `j:${row.job_id}@${row.worker_pid}`);
  run("UPDATE bot_jobs SET status='done' WHERE job_id='job-claim-1'");
});

// ---------------------------------------------------------------------------
// the rails, end to end with the stub pi
// ---------------------------------------------------------------------------

test("crow-messages, discord and gmail turns get no blocks (decision 1): config without a /services-tools/ url, the warning, csv without the service", { timeout: 60_000 }, async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const today = bridge.buildToolsCsv(hankDef(), { resolved: RESOLVED }).csv;
  for (const gateway of ["crow-messages", "discord", "gmail"]) {
    const { r, logs, cap } = await inbound("hank", { gateway });
    assert.equal(r.action, "asked", gateway + ": " + JSON.stringify(r));
    assert.ok(cap && cap.cfg && cap.cfg.mcpServers, gateway + ": the stub read its config from the fd");
    assert.deepEqual(serviceUrls(cap.cfg), [], gateway);
    assert.ok(!Object.keys(cap.cfg.mcpServers).some((k) => k.startsWith("github-")), gateway);
    assert.ok(logs.includes(`services: turn from ${gateway} sender, owner accounts not offered`), gateway + ": " + logs.join("|"));
    assert.equal(cap.tools, today, gateway + ": the csv is today's, byte for byte");
    assert.ok(!cap.tools.includes("github-"), gateway);
  }
});

test("job scope (H1): an owner card job through runCardExecute -> handleInbound gets j: blocks the mount accepts; a NULL-principal card job none, and its forged scope is not the owner's", { timeout: 60_000 }, async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const owner = addJob("job-card-own", "hank", { principal: "owner", cardId: 41 });
  const { r, cap, logs } = await job(owner);
  assert.ok(r && r.result != null, JSON.stringify(r) + logs.join("|"));
  const blocks = serviceUrls(cap.cfg);
  assert.deepEqual(blocks.map(([k]) => k).sort(), ["github-personal", "github-work"], logs.join("|"));
  assert.deepEqual(cap.cfg.mcpServers.github, { disabled: true }, "the owner's legacy github block is off");
  const h = blocks[0][1].headers;
  assert.equal(h["X-Crow-Actor-Scope"], `j:job-card-own@${process.pid}`);
  assert.equal(h["X-Crow-Actor-Thread"], "board-card-41");
  assert.equal(h["X-Crow-Actor-Gateway"], "board");
  assert.equal(h.Authorization, "Bearer " + SERVICES_TOKEN_VALUE);
  assert.ok(cap.tools.split(",").includes("mcp__github-work__get_me"), cap.tools);
  assert.ok(!JSON.stringify(cap.cfg).includes(KEYCHAIN_SECRET));

  // What the mount checks, with this exact header set: the v3 signature, the live scope, the owner's turn, then authorize.
  const { createDbClient } = await import("../servers/db.js");
  const { resolveSignedScope } = await import("../servers/shared/signed-session.js");
  const { isOwnerTurnScope } = await import("../servers/shared/turn-principal.js");
  const { authorizeServiceCall } = await import("../servers/gateway/services/mount.js");
  assert.equal(AS.verifyScopeActorSig({ kind: "service", botId: "hank", scope: h["X-Crow-Actor-Scope"], threadId: h["X-Crow-Actor-Thread"], gatewayType: h["X-Crow-Actor-Gateway"], sig: h["X-Crow-Actor-Sig"] }), true);
  run("UPDATE bot_jobs SET status='running' WHERE job_id='job-card-own'"); // runJob's caller finalizes; the mount sees a running job
  const db = createDbClient(DB_FILE);
  try {
    const actor = await resolveSignedScope(db, { botId: "hank", scopeRef: h["X-Crow-Actor-Scope"], threadId: h["X-Crow-Actor-Thread"], gatewayType: h["X-Crow-Actor-Gateway"] });
    assert.ok(actor, "the scope resolves to the running card job");
    assert.equal(isOwnerTurnScope(actor), true);
    const work = blocks.find(([k]) => k === "github-work")[1].url.match(/services-tools\/([^/]+)\/mcp/)[1];
    const az = await authorizeServiceCall(db, actor, work, { crowHome: CROW_HOME });
    assert.equal(az.ok, true, JSON.stringify(az));

    const cron = addJob("job-card-cron", "hank", { principal: null, cardId: 42 });
    const c = await job(cron);
    assert.deepEqual(serviceUrls(c.cap.cfg), [], "a NULL-principal card job gets no block");
    assert.ok(c.logs.includes("services: turn from board sender, owner accounts not offered"), c.logs.join("|"));
    run("UPDATE bot_jobs SET status='running' WHERE job_id='job-card-cron'");
    // A forged one (signed in process for the cron job) is still not the owner's turn at the mount.
    const forgedScope = AS.scopeRefFor({ jobId: "job-card-cron" });
    const fa = await resolveSignedScope(db, { botId: "hank", scopeRef: forgedScope, threadId: "board-card-42", gatewayType: "board" });
    assert.ok(fa);
    assert.equal(isOwnerTurnScope(fa), false, "not_owner_turn");
  } finally { db.close(); run("UPDATE bot_jobs SET status='done' WHERE job_id IN ('job-card-own','job-card-cron')"); }
});

test("job scope: runJob for an owner generic job signs j:<job_id>@<pid> over job-<id>/job; a cron job (NULL principal) gets none", { timeout: 60_000 }, async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const own = await job(addJob("job-gen-own", "hank", { principal: "owner" }));
  const blocks = serviceUrls(own.cap.cfg);
  assert.equal(blocks.length, 2, own.logs.join("|"));
  const h = blocks[0][1].headers;
  assert.equal(h["X-Crow-Actor-Scope"], `j:job-gen-own@${process.pid}`);
  assert.equal(h["X-Crow-Actor-Thread"], "job-job-gen-own");
  assert.equal(h["X-Crow-Actor-Gateway"], "job");
  assert.equal(AS.verifyScopeActorSig({ kind: "service", botId: "hank", scope: h["X-Crow-Actor-Scope"], threadId: "job-job-gen-own", gatewayType: "job", sig: h["X-Crow-Actor-Sig"] }), true);
  assert.ok(own.cap.tools.split(",").includes("mcp__github-personal__get_me"), own.cap.tools);
  const cron = await job(addJob("job-gen-cron", "hank", { principal: null }));
  assert.deepEqual(serviceUrls(cron.cap.cfg), []);
  assert.ok(!cron.cap.tools.includes("github-"), cron.cap.tools);
  // A job some other process claimed: fail closed, and say so.
  const other = await job(addJob("job-gen-else", "hank", { principal: "owner", workerPid: process.pid + 7 }));
  assert.deepEqual(serviceUrls(other.cap.cfg), []);
  assert.ok(other.logs.includes(SB.WARN_NOT_CLAIMER), other.logs.join("|"));
  run("UPDATE bot_jobs SET status='done' WHERE job_id LIKE 'job-gen-%'");
});

test("M4: file-mode delivery gets no /services-tools/ url, and the warning", { timeout: 60_000 }, async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
  try {
    const logs = [];
    const row = addJob("job-file-own", "hank", { principal: "owner" });
    const capture = join(dir, `cap-${++capSeq}.json`);
    process.env.PIBOT_TEST_CAPTURE = capture;
    await runJob(row, { log: (m) => logs.push(String(m)), bridge });
    const cap = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(cap.cfg, null, "file mode: nothing on the fd");
    assert.ok(!cap.tools.includes("github-"), cap.tools);
    assert.ok(logs.includes(SB.WARN_FILE_MODE), logs.join("|"));
  } finally {
    process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
    run("UPDATE bot_jobs SET status='done' WHERE job_id='job-file-own'");
  }
});

test("unsigned host: no key and no presigned service signature -> no blocks, the warning, csv byte-identical to today's", { timeout: 60_000 }, async () => {
  AS._resetActorKeyForTest(); AS._resetPresignedForTest();
  const today = bridge.buildToolsCsv(hankDef(), { resolved: RESOLVED }).csv;
  const own = await job(addJob("job-unsigned", "hank", { principal: "owner", cardId: 43 })); // CROW_GATEWAY_PORT=1: the relay is unreachable
  assert.deepEqual(serviceUrls(own.cap.cfg), []);
  assert.ok(own.logs.includes(SB.WARN_UNSIGNED), own.logs.join("|"));
  assert.equal(own.cap.tools, today);
  run("UPDATE bot_jobs SET status='done' WHERE job_id='job-unsigned'");
});

test("H1-bis no-key host: a stub relay signs the service kind for the owner job in its OWN request and the v1 kinds are still presigned; for a cron job the service presign is never asked and the v1 kinds survive", { timeout: 60_000 }, async () => {
  AS._resetActorKeyForTest(); AS._resetPresignedForTest();
  const requests = [];
  const SIG = "ab".repeat(32);
  const relay = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      requests.push(b);
      const jobRow = b.jobId ? q("SELECT principal FROM bot_jobs WHERE job_id=?", b.jobId)[0] : null;
      // The real relay's rule (actor-sign.js): a scope kind for a non-owner job refuses the WHOLE request.
      if (b.kinds.includes("service") && !(jobRow && jobRow.principal === "owner")) { res.writeHead(403); return res.end("{}"); }
      const sigs = Object.fromEntries(b.kinds.map((k) => [k, SIG]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sigs }));
    });
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const savedPort = process.env.CROW_GATEWAY_PORT;
  process.env.CROW_GATEWAY_PORT = String(relay.address().port);
  try {
    const own = await job(addJob("job-relay-own", "hank", { principal: "owner", cardId: 44 }));
    const blocks = serviceUrls(own.cap.cfg);
    assert.equal(blocks.length, 2, own.logs.join("|"));
    assert.equal(blocks[0][1].headers["X-Crow-Actor-Sig"], SIG, "the relay's signature, for exactly this tuple");
    assert.ok(blocks[0][1].url.startsWith(`http://127.0.0.1:${relay.address().port}/services-tools/`), "the gateway's listen port");
    const svcReqs = requests.filter((b) => b.kinds.includes("service"));
    assert.equal(svcReqs.length, 1);
    assert.deepEqual(svcReqs[0].kinds, ["service"], "never mixed with the v1 kinds");
    assert.equal(svcReqs[0].jobId, "job-relay-own");
    assert.equal(svcReqs[0].threadId, "board-card-44");
    assert.ok(requests.some((b) => b.jobId === "job-relay-own" && b.kinds.includes("board")), "the v1 kinds were presigned too: " + JSON.stringify(requests));
    assert.ok(!own.logs.some((l) => /actor signatures unavailable/.test(l)), own.logs.join("|"));

    requests.length = 0;
    const cron = await job(addJob("job-relay-cron", "hank", { principal: null, cardId: 45 }));
    assert.deepEqual(serviceUrls(cron.cap.cfg), []);
    assert.ok(!requests.some((b) => b.kinds.includes("service")), "no service presign for a job that is not the owner's");
    assert.ok(requests.some((b) => b.jobId === "job-relay-cron" && b.kinds.includes("board")), "its board/bot signatures are still asked for");
    assert.ok(!cron.logs.some((l) => /actor signatures unavailable/.test(l)), "and granted: " + cron.logs.join("|"));
  } finally {
    process.env.CROW_GATEWAY_PORT = savedPort;
    await new Promise((r) => relay.close(r));
    AS._resetPresignedForTest();
    run("UPDATE bot_jobs SET status='done' WHERE job_id LIKE 'job-relay-%'");
  }
});

test("bindWorldSession rebuild keeps the blocks (R6 vs PR-B)", async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const { buildBotWorld, bindWorldSession } = await import("../scripts/pi-bots/bot-world.mjs");
  addJob("job-rebind", "hank", { principal: "owner", cardId: 46 });
  const world = await buildBotWorld({ botId: "hank", threadId: "board-card-46", gatewayType: "board", jobId: "job-rebind", log: () => {} });
  const prep = { piRpcOpts: { def: world.def, mcpDelivery: world.mcpDelivery, mcpConfig: world.mcpConfig } };
  const turn = SB.turnScopeFor({ gatewayType: "board", jobId: "job-rebind", principal: "owner", workerPid: process.pid });
  await SB.withServiceBlocks(world, prep, { scopeRef: turn.scopeRef, ownerTurn: turn.ownerTurn });
  assert.equal(serviceUrls(prep.piRpcOpts.mcpConfig).length, 2);
  assert.deepEqual(prep.piRpcOpts.serviceBlocks, { github: ["github-personal", "github-work"] });
  run("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status) VALUES ('hank','board','board-card-46','active')");
  const sid = q("SELECT id FROM bot_sessions WHERE gateway_thread_id='board-card-46'")[0].id;
  assert.equal(await bindWorldSession(world, { id: sid }), true, "rebuilt for the new row");
  assert.equal(serviceUrls(world.mcpConfig).length, 2, "the rebuilt config still carries the blocks");
  assert.deepEqual(world.mcpConfig.mcpServers.github, { disabled: true });
  run("UPDATE bot_jobs SET status='done' WHERE job_id='job-rebind'");
});

test("the Perch envelope lists the labelled names the spawn csv uses", async () => {
  const { default: perchRouter } = await import("../servers/gateway/routes/perch.js").catch(() => ({ default: null }));
  assert.ok(perchRouter !== undefined);
  const { toolAllowlist } = bridge;
  const offer = SB.offerableConnections(hankDef(), conns(), { crowHome: CROW_HOME });
  const names = SB.serviceBlockNames({ def: hankDef(), connections: offer, existingNames: SB.reservedBlockNames(CROW_HOME) });
  const csv = toolAllowlist(hankDef(), { serviceBlocks: names.byService, serviceSkippedTools: names.skippedTools });
  assert.ok(csv.split(",").includes("mcp__github-work__get_me"), csv);
});

// ---------------------------------------------------------------------------
// Perch: the engine with a fake bridge seam and the REAL blocks seam
// ---------------------------------------------------------------------------

let pidSeq = 800000;
function makeEngine(createInteractiveEngine, { crowMcp = ["github/get_me"], botId = "hank" } = {}) {
  const state = { instances: [] };
  class FakePi {
    constructor(o) {
      this.opts = o; this.onEvent = o.onEvent; this.turns = []; this._exitCode = null;
      this.proc = { pid: ++pidSeq }; this.piSessionId = "pisess-" + this.proc.pid;
      // The real csv assembly, so the budget check and the Session tab count what pi would get.
      this.toolsCsv = bridge.buildToolsCsv(o.def, { resolved: o.resolved, interactive: true, serviceBlocks: o.serviceBlocks || null, serviceSkippedTools: o.serviceSkippedTools || [] }).csv;
      let done; this.exited = new Promise((r) => { done = r; }); this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message) { const rec = { message }; rec.promise = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; }); this.turns.push(rec); return rec.promise; }
    trimLog() {} async abortSince() { return null; } send() {}
    async close() { this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited"); }
  }
  const def = defOf(crowMcp, { session_dir: join(dir, "bots", botId) });
  const seam = {
    PiRpc: FakePi, LIFECYCLE_DEFAULTS: { maxPi: 8 }, countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def, bot: { bot_id: args.botId }, crowHome: CROW_HOME, projectId: HOME_P, projectSpace: null, projectMembers: [],
        sessionDir: join(dir, "bots", args.botId), tasksDbPath: process.env.CROW_TASKS_DB_PATH, remoteEnabled: false, peerGatewayUrls: {},
        session: null, narrowedTools: null, gatewayType: args.gatewayType, mcpDelivery: "fd",
        mcpConfig: { mcpServers: { github: srv("github") } },
        _mcpArgs: { botId: args.botId, threadId: args.threadId, gatewayType: args.gatewayType, jobId: null },
      };
    },
    async prepareSpawn(world) {
      return { sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved: RESOLVED,
        piRpcOpts: { def: world.def, sessionDir: world.sessionDir, resolved: RESOLVED, piProvider: "stub", remoteEnabled: false, narrowedTools: null,
          mcpDelivery: world.mcpDelivery, mcpConfig: world.mcpConfig, appendSystemPromptFile: join(dir, "sys.md") } };
    },
    withServiceBlocks: SB.withServiceBlocks, offerableConnections: SB.offerableConnections,
    async warmModel() {}, async meterTurn() { return { recorded: true }; }, appendAudit() {},
    planForCard: () => null, projectContextBlock: () => "", cardStatus: () => "todo",
    boardVocab: () => ({ statuses: ["todo", "done"], terminals: ["done"] }), cardText: () => ({ title: "T", description: null }),
  };
  const engine = createInteractiveEngine({ crowHome: CROW_HOME, env: { CROW_HOME }, bridge: seam, log: () => {},
    now: () => 1_700_000_000_000, setTimer: () => 0, clearTimer: () => {} });
  return { engine, state };
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test("fd delivery carries blocks (I1) and perch row first: an owner Perch spawn signs s:<its pre-minted row> and the csv counts the blocks", { timeout: 30_000 }, async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const mod = await import("../servers/gateway/perch-interactive.js");
  const { engine, state } = makeEngine(mod.createInteractiveEngine);
  const r = await engine.spawn({ botId: "hank", principal: "owner" });
  await tick();
  const pi = state.instances[0];
  const row = q("SELECT id FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1", r.threadId)[0];
  assert.ok(row, "the spawn ends with a row");
  const blocks = serviceUrls(pi.opts.mcpConfig);
  assert.equal(blocks.length, 2);
  assert.deepEqual(pi.opts.serviceBlocks, { github: ["github-personal", "github-work"] });
  assert.deepEqual(pi.opts.mcpConfig.mcpServers.github, { disabled: true });
  const h = blocks[0][1].headers;
  assert.equal(h["X-Crow-Actor-Scope"], "s:" + row.id, "signed over that very row");
  assert.equal(h["X-Crow-Actor-Gateway"], "perch");
  assert.equal(AS.verifyScopeActorSig({ kind: "service", botId: "hank", scope: "s:" + row.id, threadId: r.threadId, gatewayType: "perch", sig: h["X-Crow-Actor-Sig"] }), true);
  assert.ok(pi.toolsCsv.split(",").includes("mcp__github-work__get_me"), "the csv the budget check counts has the expanded names: " + pi.toolsCsv);
  assert.equal(engine.sessionServicesLive(row.id), true);
  await engine.stop(r.sessionId);
});

test("the owner-message cycle-back is cheap: no restart when the bot selects none of the project's offerable connections", { timeout: 30_000 }, async () => {
  AS._resetActorKeyForTest(); AS.initGatewayActorKey();
  const mod = await import("../servers/gateway/perch-interactive.js");
  // nora selects only brave-search (and notion, sensitive, would not count either).
  const { engine, state } = makeEngine(mod.createInteractiveEngine, { crowMcp: ["brave-search/search", "notion/search"], botId: "nora" });
  const r = await engine.spawn({ botId: "nora" }); // a non-owner child
  await tick();
  assert.equal(state.instances.length, 1);
  await engine.message(r.sessionId, "mine", [], { principal: "owner" });
  await tick();
  assert.equal(state.instances.length, 1, "the same child takes the owner's message");
  assert.equal(state.instances[0].turns.length, 1);
  state.instances[0].turns[0].resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
  await engine.stop(r.sessionId);

  // A bot that does select a connected account cycles back to get its blocks.
  const h = makeEngine(mod.createInteractiveEngine);
  const r2 = await h.engine.spawn({ botId: "hank" });
  await tick();
  await h.engine.message(r2.sessionId, "mine", [], { principal: "owner" });
  await tick();
  assert.equal(h.state.instances.length, 2, "respawned for the owner");
  assert.equal(serviceUrls(h.state.instances[1].opts.mcpConfig).length, 2);
  await h.engine.stop(r2.sessionId);
});
