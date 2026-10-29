/**
 * Project services Task 17: `/services-tools/<uuid>/mcp`, the services adapter on the shared
 * loopback mount (servers/gateway/services/mount.js). Only the services checks are tested here:
 * lane B's tests/loopback-tool-mount.test.js owns the gate matrix, session binding, caps,
 * shaping, timeouts and the idle sweep.
 *
 * A scratch Crow home and database (init-db), real connections whose installed add-on entry
 * points at the fake stdio child (tests/fixtures/echo-mcp-server.mjs, run by this node; never
 * npx, uvx or a real service), the real services family token, real v3 `service` signatures
 * (signScopeActor under this process's scope key), and the real Perch engine accessor over a
 * stub engine installed with _setInteractiveEngineForTest.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "echo-mcp-server.mjs");
const HOME = mkdtempSync(join(tmpdir(), "crow-svcmount-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-svcmount-data-"));
const SKILLS = mkdtempSync(join(tmpdir(), "crow-svcmount-skills-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const C = await import("../servers/gateway/services/children.js");
const SC = await import("../servers/shared/service-connections.js");
const TC = await import("../servers/gateway/services/tool-cache.js");
const M = await import("../servers/gateway/services/mount.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const { SessionManager } = await import("../servers/gateway/session-manager.js");
const { SERVICES_TOKEN, generateBoardToken } = await import("../servers/gateway/local-token.js");
const { initGatewayActorKey, _resetActorKeyForTest, signScopeActor } = await import("../scripts/pi-bots/actor-sig.mjs");
const PI = await import("../servers/gateway/perch-interactive.js");

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const GH_TOKEN = "test-token-1";
const SPAWNS = join(HOME, "spawns.log");
const CACHE = join(HOME, TC.TOOL_CACHE_FILE);
mkdirSync(join(HOME, "secrets"), { recursive: true });
C._setChildrenForTest({ folder: { otherSecretsDirs: [] } });

// ---- scratch install: github (reveal knob on) and notion (exits at once) -------------------------

const knobs = { github: { reveal: true }, notion: { exit: true } };
function writeControl(id) {
  const dir = join(HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "echo-control.json"), JSON.stringify({ spawnLog: SPAWNS, ...knobs[id] }));
}
writeFileSync(join(HOME, "installed.json"), JSON.stringify(["github", "notion"].map((id) => ({ id, type: "mcp-server", version: "1.0.0" }))));
for (const id of ["github", "notion"]) writeControl(id);
writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({
  github: { command: "node", args: [FIXTURE], env: {} }, notion: { command: "node", args: [FIXTURE], env: {} },
}), { mode: 0o600 });

// A repo skill that declares a github tool: skills grant only crow-projects tools, so this
// must never widen a bot's service selection.
writeFileSync(join(SKILLS, "svc-skill.md"), "---\nname: svc-skill\ndescription: test skill\ntools:\n  - github/envhash\n---\nBody.\n");

const spawnCount = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, "utf8").split("\n").filter(Boolean).length : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withDb(fn) {
  const d = createDbClient(DB_PATH);
  try { return await fn(d); } finally { d.close(); }
}
function raw(fn) {
  const d = new Database(DB_PATH);
  try { d.pragma("foreign_keys = OFF"); return fn(d); } finally { d.close(); }
}

// ---- rows ------------------------------------------------------------------------------------

const P = {};      // project ids
const S = {};      // bot_sessions ids
const U = {};      // connection uuids
const live = new Set();   // session row ids the stub engine reports as serving the owner
let TOKEN, BOARD, srv, base, sessions, handle;

async function connect(serviceId, projectId, { label = "work", secrets } = {}) {
  return withDb(async (d) => {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    return SC.createConnection(d, { projectId, serviceId, accountLabel: label, secrets: secrets ?? (serviceId === "github" ? { [GH]: GH_TOKEN } : { NOTION_TOKEN: "test-token-2" }), config: {}, testedAt: new Date() }, { key });
  });
}

const defJson = (crowMcp, extra = {}) => JSON.stringify({ tools: { crow_mcp: crowMcp }, ...extra });
const setDef = (botId, crowMcp, extra = {}) => raw((d) => d.prepare("UPDATE pi_bot_defs SET definition = ? WHERE bot_id = ?").run(defJson(crowMcp, extra), botId));
const setDefProject = (botId, projectId) => raw((d) => d.prepare("UPDATE pi_bot_defs SET project_id = ? WHERE bot_id = ?").run(projectId, botId));

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  raw((d) => {
    if (!d.prepare("PRAGMA table_info(bot_jobs)").all().some((c) => c.name === "principal")) d.exec("ALTER TABLE bot_jobs ADD COLUMN principal TEXT");
    const proj = d.prepare("INSERT INTO project_spaces (slug, name) VALUES (?, ?)");
    for (const slug of ["spring", "home", "attic"]) P[slug] = Number(proj.run(slug, slug).lastInsertRowid);
    const bot = d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?, ?, ?, 1, ?)");
    bot.run("b1", "B1", defJson(["github/whoami", "github/reveal", "notion"]), P.spring);
    bot.run("b2", "B2", defJson(["github"]), P.attic);
    bot.run("b3", "B3", defJson(["crow-memory"]), P.spring);   // selects nothing of github
    bot.run("b4", "B4", defJson(["github/whoami"]), null);     // no project
    const sess = d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, project_id) VALUES (?, ?, ?, 'active', ?)");
    for (const [name, botId, gw, thread, proj] of [
      ["perch", "b1", "perch", "perch-1", "spring"], ["perch2", "b1", "perch", "perch-2", "spring"],
      ["other", "b1", "perch", "perch-3", "spring"],          // a glasses / kiosk hand-off: spawned "other"
      ["msgs", "b1", "crow-messages", "cm-1", "spring"], ["discord", "b1", "discord", "dc-1", "spring"], ["gmail", "b1", "gmail", "gm-1", "spring"],
      ["home", "b1", "perch", "perch-home", "home"], ["b3", "b3", "perch", "perch-b3", "spring"], ["b2", "b2", "perch", "perch-b2", "attic"],
      ["b4", "b4", "perch", "perch-b4", "spring"],
    ]) S[name] = Number(sess.run(botId, gw, thread, P[proj]).lastInsertRowid);
    const job = d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid, principal) VALUES (?, 'b1', 'g', 'running', ?, ?)");
    job.run("jb1", process.pid, "owner");
    job.run("jcron", process.pid, null);
  });
  for (const n of ["perch", "perch2", "msgs", "discord", "gmail", "home", "b3", "b2", "b4"]) live.add(S[n]);

  U.gh = (await connect("github", P.spring)).uuid;
  U.notion = (await connect("notion", P.spring)).uuid;
  U.old = (await connect("github", P.spring, { label: "old" })).uuid;
  await withDb((d) => SC.disconnectConnection(d, U.old));
  U.contact = (await connect("github", P.spring, { label: "theirs" })).uuid;
  raw((d) => d.prepare("UPDATE service_connections SET owner_contact_id = 1 WHERE uuid = ?").run(U.contact));
  U.attic = (await connect("github", P.attic)).uuid;
  raw((d) => d.prepare("UPDATE project_spaces SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(P.attic));
  U.home = (await connect("github", P.home)).uuid;

  _resetActorKeyForTest();
  initGatewayActorKey();
  await withDb(async (d) => { TOKEN = await SERVICES_TOKEN.rotate(d); BOARD = await generateBoardToken(d); });

  PI._setInteractiveEngineForTest({ sessionServicesLive: (id) => live.has(Number(id)) });
  sessions = new SessionManager();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  handle = M.mountServicesTools(app, {
    sessionManager: sessions, createDbClient: () => createDbClient(DB_PATH), perchEngine: await M.perchEngineAccessor(),
    crowHome: HOME, repoSkillsDir: SKILLS,
  });
  await new Promise((r) => { srv = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  handle?.stop();
  try { await sessions.closeAll(); } catch { /* closed */ }
  sessions?.dispose();
  await new Promise((r) => (srv ? srv.close(r) : r()));
  srv?.closeAllConnections?.();
  await C.stopAllChildren();
  PI._resetInteractiveEngineForTest();
  _resetActorKeyForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA, SKILLS]) rmScratch(d);
});

// ---- actors and the HTTP client ------------------------------------------------------------------

const SESS_TUPLE = {
  perch: ["perch-1", "perch"], perch2: ["perch-2", "perch"], other: ["perch-3", "perch"], msgs: ["cm-1", "crow-messages"],
  discord: ["dc-1", "discord"], gmail: ["gm-1", "gmail"], home: ["perch-home", "perch"], b3: ["perch-b3", "perch"],
  b2: ["perch-b2", "perch"], b4: ["perch-b4", "perch"],
};
const SESS_BOT = { b3: "b3", b2: "b2", b4: "b4" };
function sessActor(name, { sendAs } = {}) {
  const botId = SESS_BOT[name] || "b1";
  const [threadId, gatewayType] = SESS_TUPLE[name];
  const sig = signScopeActor({ kind: "service", botId, sessionId: S[name], threadId, gatewayType });
  assert.ok(sig, "signed");
  return { botId, scope: `s:${sendAs ?? S[name]}`, threadId, gatewayType, sig };
}
function jobActor(jobId) {
  const tuple = { threadId: `job-${jobId}`, gatewayType: "job" };
  return { botId: "b1", scope: `j:${jobId}@${process.pid}`, ...tuple, sig: signScopeActor({ kind: "service", botId: "b1", jobId, ...tuple }) };
}
const headersOf = (a) => ({
  "x-crow-actor-kind": "service", "x-crow-actor-id": a.botId, "x-crow-actor-scope": a.scope,
  "x-crow-actor-thread": a.threadId, "x-crow-actor-gateway": a.gatewayType, "x-crow-actor-sig": a.sig,
});

let rpcId = 0;
async function send(uuid, body, o = {}) {
  const headers = {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
    ...headersOf(o.actor ?? sessActor("perch")),
    ...(o.sid ? { "mcp-session-id": o.sid } : {}),
    ...(o.headers || {}),
  };
  const res = await fetch(`${base}/services-tools/${uuid}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  if (text) {
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop();
      json = data ? JSON.parse(data) : null;
    } else { try { json = JSON.parse(text); } catch { json = null; } }
  }
  return { status: res.status, text, json, sid: res.headers.get("mcp-session-id") };
}
const initBody = () => ({ jsonrpc: "2.0", id: ++rpcId, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const init = (uuid, o) => send(uuid, initBody(), o);
async function open(uuid, o = {}) {
  const r = await init(uuid, o);
  assert.equal(r.status, 200, `initialize: ${r.status} ${r.text}`);
  assert.ok(r.sid);
  return r.sid;
}
const listTools = (uuid, sid, o = {}) => send(uuid, { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }, { sid, ...o });
const callTool = (uuid, sid, name, args = {}, o = {}) => send(uuid, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, { sid, ...o });
const names = (r) => (r.json?.result?.tools || []).map((t) => t.name).sort();
const textOf = (r) => r.json?.result?.content?.map((c) => c.text).join("\n");
const errMsg = (r) => r.json?.error?.message;

// ---- refusals first: no cached tool list exists yet, so any start would leave one ----------------

test("refusals never start the child: every refused initialize leaves the child stopped and writes no tool cache", async () => {
  assert.equal(existsSync(CACHE), false, "no cache before the first start");
  const before = spawnCount();
  const cases = [
    ["non-loopback (a forwarded caller)", U.gh, { headers: { "x-forwarded-for": "203.0.113.9" } }, 404, null],
    ["no token", U.gh, { token: null }, 401, null],
    ["the board token", U.gh, { get token() { return BOARD; } }, 401, null],
    ["a bad signature", U.gh, { actor: { ...sessActor("perch"), sig: "0".repeat(64) } }, 403, "A signed bot is required."],
    ["s:<perch> signed, s:<perch2> sent", U.gh, { actor: sessActor("perch", { sendAs: S.perch2 }) }, 403, "A signed bot is required."],
    ["a Crow messages session", U.gh, { actor: sessActor("msgs") }, 403, "Not available on this turn."],
    ["a Discord session", U.gh, { actor: sessActor("discord") }, 403, "Not available on this turn."],
    ["a Gmail session", U.gh, { actor: sessActor("gmail") }, 403, "Not available on this turn."],
    ["a Perch session not serving the owner (sessionServicesLive false)", U.gh, { actor: sessActor("other") }, 403, "Not available on this turn."],
    ["a cron job (principal NULL)", U.gh, { actor: jobActor("jcron") }, 403, "Not available on this turn."],
    ["a session in another project", U.gh, { actor: sessActor("home") }, 403, "Not available on this turn."],
    ["a bot with no project", U.gh, { actor: sessActor("b4") }, 403, "Not available on this turn."],
    ["unselected service refused", U.gh, { actor: sessActor("b3") }, 403, "Not available on this turn."],
    ["disconnected", U.old, {}, 409, "This connection is turned off."],
    ["archived project", U.attic, { actor: sessActor("b2") }, 409, "This connection is turned off."],
    ["owner_contact_id = 1", U.contact, {}, 403, "Not available on this turn."],
    ["unknown uuid", "00000000-0000-4000-8000-00000000dead", {}, 404, null],
  ];
  for (const [label, uuid, o, status, message] of cases) {
    const r = await init(uuid, o);
    assert.equal(r.status, status, `${label}: ${r.status} ${r.text}`);
    if (message) assert.equal(errMsg(r), message, label);
    else if (status === 404) assert.equal(r.text, "", `${label}: empty body`);
    assert.equal(r.sid, null, `${label}: no session`);
    for (const u of Object.values(U)) assert.equal(C.childState(u), "stopped", `${label}: ${u} never started`);
  }
  assert.equal(spawnCount(), before, "nothing spawned");
  assert.equal(existsSync(CACHE), false, "no tool cache written");
});

test("authorizeServiceCall: the codes behind the fixed texts, request-independent", async () => {
  await withDb(async (d) => {
    const a = (o) => ({ scope: "session", botId: "b1", defProjectId: P.spring, sessionProjectId: P.spring, ...o });
    const code = async (actor, uuid = U.gh) => (await M.authorizeServiceCall(d, actor, uuid, { crowHome: HOME, repoSkillsDir: SKILLS })).code ?? "ok";
    assert.equal(await code(a()), "ok");
    assert.equal(await code(a({ scope: "job", sessionProjectId: undefined })), "ok", "a job has no session project");
    assert.equal(await code(a({ sessionProjectId: P.home })), "wrong_project");
    assert.equal(await code(a({ defProjectId: P.home, sessionProjectId: P.home })), "wrong_project");
    assert.equal(await code(a({ defProjectId: null })), "wrong_project");
    assert.equal(await code(a({ botId: "b3" })), "not_selected");
    assert.equal(await code(a({ botId: "nobody" })), "not_selected");
    assert.equal(await code(a(), U.old), "not_active");
    assert.equal(await code(a(), U.contact), "owner_mismatch");
    assert.equal(await code(a(), "nope"), "not_found");
    assert.equal(await code(a({ scope: "board" })), "not_granted");
    assert.equal(await code(null), "not_granted");
    const ok = await M.authorizeServiceCall(d, a(), U.gh, { crowHome: HOME, repoSkillsDir: SKILLS });
    assert.deepEqual(ok.ctx.allowedTools.sort(), ["reveal", "whoami"]);
    assert.equal(ok.ctx.serviceId, "github");
    const bare = await M.authorizeServiceCall(d, a({ botId: "b2", defProjectId: P.attic, sessionProjectId: P.attic }), U.attic, { crowHome: HOME });
    assert.equal(bare.code, "not_active", "archived");
  });
  assert.deepEqual(M.serviceSelection(["github"], "github"), { allowedTools: null });
  assert.deepEqual(M.serviceSelection(["github/a", "github__b", "githubx/c", "gh"], "github"), { allowedTools: ["a", "b"] });
  assert.equal(M.serviceSelection(["githubx", "crow-memory"], "github"), null);
});

// ---- the happy path ----------------------------------------------------------------------------

test("happy path + onInitialize: no cache → initialize starts the child once; tools/list lists exactly the selected tools; a call succeeds", async () => {
  const before = spawnCount();
  const sid = await open(U.gh);
  assert.equal(spawnCount(), before + 1, "one start, to fill the cache");
  assert.ok(existsSync(CACHE), "the cache is written");
  assert.deepEqual(names(await listTools(U.gh, sid)), ["reveal", "whoami"]);
  const r = await callTool(U.gh, sid, "whoami");
  assert.equal(r.json?.result?.isError, undefined, textOf(r));
  assert.ok(JSON.parse(textOf(r)).keys.includes(GH));

  // With a cache, initialize starts nothing.
  await C.stopChild(U.gh);
  const n = spawnCount();
  const sid2 = await open(U.gh);
  assert.equal(spawnCount(), n, "a cached list: no start at initialize");
  assert.equal(C.childState(U.gh), "stopped");
  assert.deepEqual(names(await listTools(U.gh, sid2)), ["reveal", "whoami"]);
  assert.equal(C.childState(U.gh), "stopped", "listing never starts the child");
});

test("job rail: an owner job works; once the job completes its scope is unattributed", async () => {
  const sid = await open(U.gh, { actor: jobActor("jb1") });
  const r = await callTool(U.gh, sid, "whoami", {}, { actor: jobActor("jb1") });
  assert.ok(JSON.parse(textOf(r)).keys.includes(GH));
  raw((d) => d.prepare("UPDATE bot_jobs SET status = 'completed' WHERE job_id = 'jb1'").run());
  try {
    const after = await callTool(U.gh, sid, "whoami", {}, { actor: jobActor("jb1") });
    assert.equal(after.status, 403);
    assert.equal(errMsg(after), "A signed bot is required.");
  } finally {
    raw((d) => d.prepare("UPDATE bot_jobs SET status = 'running' WHERE job_id = 'jb1'").run());
  }
});

test("moved bot refused: the def moves to another project; the old s: row and its signature are refused (wrong_project)", async () => {
  const sid = await open(U.gh);
  setDefProject("b1", P.home);
  try {
    const r = await callTool(U.gh, sid, "whoami");
    assert.equal(r.status, 403);
    assert.equal(errMsg(r), "Not available on this turn.");
    const again = await init(U.gh);
    assert.equal(again.status, 403);
    // Its new project's connection is refused too: the session still sits in the old project.
    assert.equal((await init(U.home)).status, 403);
  } finally {
    setDefProject("b1", P.spring);
  }
});

test("tool outside the selection refused: not listed, and calling it errors; a skill's github entry grants nothing; the def's entry does", async () => {
  const sid = await open(U.gh);
  assert.ok(!names(await listTools(U.gh, sid)).includes("envhash"));
  const r = await callTool(U.gh, sid, "envhash", { name: GH });
  assert.equal(r.json?.result?.isError, true);
  assert.equal(textOf(r), "Not available on this turn.");
  assert.equal((await callTool(U.gh, sid, "crash")).json?.result?.isError, true);

  setDef("b1", ["github/whoami", "notion"], { skills: ["svc-skill"] });
  try {
    const s2 = await open(U.gh);
    assert.deepEqual(names(await listTools(U.gh, s2)), ["whoami"], "a skill declaring github/envhash grants nothing");
    assert.equal(textOf(await callTool(U.gh, s2, "envhash", { name: GH })), "Not available on this turn.");
    setDef("b1", ["github/whoami", "github/envhash"]);
    const s3 = await open(U.gh);
    assert.deepEqual(names(await listTools(U.gh, s3)), ["envhash", "whoami"]);
    const ok = await callTool(U.gh, s3, "envhash", { name: GH });
    assert.equal(JSON.parse(textOf(ok)).present, true);
  } finally {
    setDef("b1", ["github/whoami", "github/reveal", "notion"]);
  }
});

test("unselected service refused inside a live session: the selection is dropped after initialize", async () => {
  const sid = await open(U.gh);
  setDef("b1", ["notion"]);
  try {
    const r = await callTool(U.gh, sid, "whoami");
    assert.equal(r.status, 403);
    assert.equal(errMsg(r), "Not available on this turn.");
  } finally {
    setDef("b1", ["github/whoami", "github/reveal", "notion"]);
  }
});

test("later refusal applies to a live MCP session: the Perch session stops serving the owner → the next call is 403", async () => {
  const sid = await open(U.gh, { actor: sessActor("perch2") });
  assert.ok(JSON.parse(textOf(await callTool(U.gh, sid, "whoami", {}, { actor: sessActor("perch2") }))).keys);
  live.delete(S.perch2);
  try {
    const r = await callTool(U.gh, sid, "whoami", {}, { actor: sessActor("perch2") });
    assert.equal(r.status, 403);
    assert.equal(errMsg(r), "Not available on this turn.");
  } finally {
    live.add(S.perch2);
  }
});

test("child restarted between calls: each call resolves its child, so the second call starts it again and lastUsedAt advances", async () => {
  const sid = await open(U.gh);
  const a = JSON.parse(textOf(await callTool(U.gh, sid, "whoami")));
  const t1 = C.listChildren().find((c) => c.uuid === U.gh).lastUsedAt;
  await C.stopChild(U.gh);
  assert.equal(C.childState(U.gh), "stopped");
  await sleep(5);
  const r = await callTool(U.gh, sid, "whoami");
  const b = JSON.parse(textOf(r));
  assert.notEqual(a.pid, b.pid, "a fresh child");
  assert.ok(C.listChildren().find((c) => c.uuid === U.gh).lastUsedAt > t1);
});

test("child results are redacted with the connection's values", async () => {
  const sid = await open(U.gh);
  const r = await callTool(U.gh, sid, "reveal");
  assert.ok(!r.text.includes(GH_TOKEN), "the token never reaches the bot");
  assert.equal(textOf(r), "the token is [redacted] ok");
});

test("error text: a child error carrying the token is '<tool> failed.' only", async () => {
  knobs.github = { reveal: true, throwWhoami: true };
  writeControl("github");
  await C.stopChild(U.gh);
  try {
    const sid = await open(U.gh);
    const r = await callTool(U.gh, sid, "whoami");
    assert.equal(r.json?.result?.isError, true);
    assert.equal(textOf(r), "whoami failed.");
    assert.ok(!r.text.includes(GH_TOKEN));
  } finally {
    knobs.github = { reveal: true };
    writeControl("github");
    await C.stopChild(U.gh);
  }
});

test("init failure: no cached list and a child that cannot start → 502 child_unavailable, no session", async () => {
  const r = await init(U.notion);
  assert.equal(r.status, 502);
  assert.equal(errMsg(r), "This service isn't running right now.");
  assert.equal(r.sid, null);
});

test("an 'error' row ensureChild still retries (child_unavailable) keeps listing and calling; a failed live test is not_active", async () => {
  await withDb((d) => SC.recordChildFailure(d, U.gh));
  try {
    assert.ok(await withDb((d) => C.listedTools(d, U.gh, { crowHome: HOME })), "listedTools keeps a retryable row's tools");
    const sid = await open(U.gh);
    assert.deepEqual(names(await listTools(U.gh, sid)), ["reveal", "whoami"]);
    assert.ok(JSON.parse(textOf(await callTool(U.gh, sid, "whoami"))).keys.includes(GH), "the start puts the row back to active");
    await withDb((d) => SC.recordTest(d, U.gh, { ok: false, error: "auth_failed" }));
    assert.equal(await withDb((d) => C.listedTools(d, U.gh, { crowHome: HOME })), null, "auth_failed: no tools");
    const r = await init(U.gh);
    assert.equal(r.status, 409);
    assert.equal(errMsg(r), "This connection is turned off.");
  } finally {
    await withDb((d) => SC.recordTest(d, U.gh, { ok: true }));
  }
});

test("perchEngineAccessor is synchronous, never creates an engine, and fails closed", async () => {
  const get = await M.perchEngineAccessor();
  assert.equal(typeof get().sessionServicesLive, "function", "the installed engine");
  const none = await M.perchEngineAccessor(async () => { throw new Error("gone"); });
  assert.equal(none(), null);
  const empty = await M.perchEngineAccessor(async () => ({ getInteractiveEngine: ({ createIfMissing }) => (createIfMissing ? { made: true } : null) }));
  assert.equal(empty(), null, "createIfMissing:false");
});
