/**
 * SAT-7 part B: `/satellite-tools/<satellite_id>/<bundle>/mcp`, the satellite adapter on the
 * shared loopback mount (servers/gateway/satellites/tools-mount.js). Only what differs from the
 * services family is tested here: lane B's tests/loopback-tool-mount.test.js owns the gate
 * matrix, the session binding, the caps, shaping, timeouts and the idle sweep.
 *
 * A scratch Crow home and database (init-db), a paired satellite built by the in-test fake
 * (tests/helpers/fake-satellite-mgmt.js: it verifies every request signature and signs every
 * answer, so no socket is used and no real host is named), the part A entry from the real
 * refresh, the real satellite-tools family token, real v3 `satellite-tools` signatures under this
 * process's scope key, and a stub Perch engine for the owner-session rule.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-sattools-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-sattools-data-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const { SessionManager } = await import("../servers/gateway/session-manager.js");
const { SATELLITE_TOOLS_TOKEN, SERVICES_TOKEN, generateBoardToken } = await import("../servers/gateway/local-token.js");
const { initGatewayActorKey, _resetActorKeyForTest, signScopeActor } = await import("../scripts/pi-bots/actor-sig.mjs");
const TE = await import("../servers/gateway/satellites/tool-entry.js");
const store = await import("../servers/gateway/satellites/store.js");
const M = await import("../servers/gateway/satellites/tools-mount.js");
const { createMgmtFake, makeSatelliteRow, demoTools, toolsHash } = await import("./helpers/fake-satellite-mgmt.js");

const BUNDLE = "demo";
const OWNER = "b1";          // granted demo_list + demo_create, hosted, enabled
const UNGRANTED = "b2";      // granted nothing of the bundle
const BOT_SESS = {};         // name -> bot_sessions.id
const live = new Set();      // session row ids the stub engine reports as serving the owner
const audit = [];
const servers = new Map();
let fake, satId, TOKEN, SERVICES_TOK, BOARD, srv, base, sessions, handle, calls, entryDb;

const raw = (fn) => {
  const d = new Database(DB_PATH);
  try { return fn(d); } finally { d.close(); }
};
const withDb = async (fn) => { const d = createDbClient(DB_PATH); try { return await fn(d); } finally { d.close(); } };
const defJson = (crowMcp) => JSON.stringify({ tools: { crow_mcp: crowMcp } });
const setDef = (botId, crowMcp) => raw((d) => d.prepare("UPDATE pi_bot_defs SET definition = ? WHERE bot_id = ?").run(defJson(crowMcp), botId));

/** The satellite's tools/call answers; every call is recorded with the caller the fake verified. */
function callRoutes(f) {
  f.table["POST /satellite/v1/mcp/:bundle"] = ({ params, body, caller }) => {
    if (body.method === "tools/list") return { status: 200, json: { jsonrpc: "2.0", id: body.id, result: { tools: f.state.tools[params.bundle] } } };
    calls.push({ bundle: params.bundle, name: body.params?.name, caller, headers: null });
    const ok = (result) => ({ status: 200, json: { jsonrpc: "2.0", id: body.id, result } });
    return ok({ content: [{ type: "text", text: `ran ${body.params?.name}` }] });
  };
}

/** Write installed.json: this satellite hosts `bundle`; optionally also another satellite's bundle. */
function writeInstalled(extra = []) {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: BUNDLE, mode: "satellite", host: satId, version: "1.0.0" }, ...extra], null, 2));
}

/** Rebuild the part A entries from the current db + installed.json (as the poller does). */
async function refresh(serversMap = servers) {
  // The entry's client keeps this client (closeDb:false), so it must outlive the test's calls.
  return TE.refreshSatelliteEntries({ db: entryDb, dbFactory: () => entryDb, servers: serversMap, fetchImpl: fake.fetchImpl, log: () => {} });
}

const SESSION_TUPLE = {
  perch: ["perch-1", "perch", OWNER],
  perchOther: ["perch-2", "perch", OWNER],   // a Perch session the engine does not report
  discord: ["dc-1", "discord", OWNER],
  gmail: ["gm-1", "gmail", OWNER],
  ungranted: ["perch-b2", "perch", UNGRANTED],
};
function sessActor(name, over = {}) {
  const [threadId, gatewayType, botId] = SESSION_TUPLE[name];
  const sessionId = BOT_SESS[name];
  const sig = signScopeActor({ kind: "satellite-tools", botId, sessionId, threadId, gatewayType });
  assert.ok(sig, "signed");
  return { kind: "satellite-tools", botId, scope: `s:${sessionId}`, threadId, gatewayType, sig, ...over };
}
function jobActor(jobId, botId = OWNER) {
  const tuple = { threadId: `job-${jobId}`, gatewayType: "job" };
  return { kind: "satellite-tools", botId, scope: `j:${jobId}@${process.pid}`, ...tuple, sig: signScopeActor({ kind: "satellite-tools", botId, jobId, ...tuple }) };
}
const headersOf = (a) => ({
  "x-crow-actor-kind": a.kind, "x-crow-actor-id": a.botId, "x-crow-actor-scope": a.scope,
  "x-crow-actor-thread": a.threadId, "x-crow-actor-gateway": a.gatewayType, "x-crow-actor-sig": a.sig,
});

let rpcId = 0;
async function send(body, o = {}) {
  const path = o.path ?? `/satellite-tools/${o.sat ?? satId}/${o.bundle ?? BUNDLE}/mcp`;
  const headers = {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
    ...(o.actor === null ? {} : headersOf(o.actor ?? sessActor("perch"))),
    ...(o.sid ? { "mcp-session-id": o.sid } : {}),
    ...(o.headers || {}),
  };
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
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
async function open(o = {}) {
  const r = await send(initBody(), o);
  assert.equal(r.status, 200, `initialize: ${r.status} ${r.text}`);
  assert.ok(r.sid, "a session id");
  return r.sid;
}
const listTools = (sid, o = {}) => send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }, { sid, ...o });
const callTool = (sid, name, args = {}, o = {}) => send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, { sid, ...o });
const names = (r) => (r.json?.result?.tools || []).map((t) => t.name).sort();
const textOf = (r) => r.json?.result?.content?.map((c) => c.text).join("\n");
const errMsg = (r) => r.json?.error?.message;
const lastOutcome = () => audit.at(-1)?.outcome;
const mcpCalls = () => fake.state.requests.filter((r) => r.path.startsWith("/satellite/v1/mcp/"));

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  fake = createMgmtFake();
  satId = fake.satId;
  calls = [];
  callRoutes(fake);
  fake.state.tools[BUNDLE] = demoTools();

  // Rows: two bots, their sessions and jobs. `principal` arrives with a later migration; this
  // scratch DB adds it, as tests/services-mount.test.js does.
  raw((d) => {
    if (!d.prepare("PRAGMA table_info(bot_jobs)").all().some((c) => c.name === "principal")) d.exec("ALTER TABLE bot_jobs ADD COLUMN principal TEXT");
    const bot = d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?, ?, ?, ?)");
    bot.run(OWNER, "B1", defJson(["demo/demo_list", "demo/demo_create"]), 1);
    bot.run(UNGRANTED, "B2", defJson(["crow-memory"]), 1);
    bot.run("b3", "B3", defJson(["demo/demo_list"]), 0); // disabled: no live scope at all
    const sess = d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status) VALUES (?, ?, ?, 'active')");
    for (const [name, [thread, gw, botId]] of Object.entries(SESSION_TUPLE)) BOT_SESS[name] = Number(sess.run(botId, gw, thread).lastInsertRowid);
    const job = d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid, principal) VALUES (?, ?, 'g', ?, ?, ?)");
    job.run("job-own-1", OWNER, "running", process.pid, "owner");
    job.run("job-cron-1", OWNER, "running", process.pid, null);
  });
  live.add(BOT_SESS.perch);
  live.add(BOT_SESS.ungranted);

  _resetActorKeyForTest();
  initGatewayActorKey();
  await withDb(async (d) => {
    TOKEN = await SATELLITE_TOOLS_TOKEN.rotate(d);
    SERVICES_TOK = await SERVICES_TOKEN.rotate(d);
    BOARD = await generateBoardToken(d);
  });

  // crow's side of an already-paired satellite: the row, the mgmt key, the approved pin.
  entryDb = createDbClient(DB_PATH);
  await makeSatelliteRow(entryDb, fake);
  await store.updateSatelliteStatus(entryDb, satId, {
    last_status_json: JSON.stringify({ v: 1, polled_at: new Date().toISOString(), status: fake.statusBody(), health: null, error: null, alerts: { psi: false, tools: {} } }),
  });
  await store.putToolPin(entryDb, {
    satellite_id: satId, bundle: BUNDLE, version: "1.0.0", tools_sha256: toolsHash(demoTools()),
    tools_json: JSON.stringify(demoTools()), approved_at: "2026-11-01T00:00:00Z",
  });
  writeInstalled();
  await refresh();

  sessions = new SessionManager();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  handle = M.mountSatelliteTools(app, {
    sessionManager: sessions, createDbClient: () => createDbClient(DB_PATH), servers,
    perchEngine: { sessionServicesLive: (id) => live.has(Number(id)) },
    onAudit: (e) => audit.push(e),
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
  try { entryDb?.close(); } catch { /* closed */ }
  _resetActorKeyForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA]) rmScratch(d);
});

afterEach(() => { audit.length = 0; });

// ── the gate as this family configures it ─────────────────────────────────────────────────────────

test("a non-local caller gets the empty 404, and nothing reaches the satellite", async () => {
  const before = fake.state.requests.length;
  const r = await send(initBody(), { headers: { "x-forwarded-for": "100.64.20.9" } });
  assert.equal(r.status, 404);
  assert.equal(r.text, "", "empty body: the route is not there for a remote caller");
  assert.equal(fake.state.requests.length, before);
});

test("token x family: this family's token opens the door; another family's, the board token and none are 401", async () => {
  for (const [label, token] of [["services family token", SERVICES_TOK], ["board token", BOARD], ["none", null]]) {
    const r = await send(initBody(), { token });
    assert.equal(r.status, 401, `${label}: ${r.status} ${r.text}`);
    assert.equal(r.json?.jsonrpc, "2.0", `${label}: JSON-RPC shaped`);
  }
  // The service signature is another KIND, and a lifetime live here: still refused, before authorize.
  const asService = (() => {
    const a = sessActor("perch");
    return { ...a, kind: "service", sig: signScopeActor({ kind: "service", botId: a.botId, sessionId: BOT_SESS.perch, threadId: a.threadId, gatewayType: a.gatewayType }) };
  })();
  const r = await send(initBody(), { actor: asService });
  assert.equal(r.status, 403);
  assert.equal(errMsg(r), "A signed bot is required.");
  assert.equal(lastOutcome(), "refused:unattributed");
});

test("a satellite-tools signature on an owner Perch turn is accepted; the list is the granted tools only", async () => {
  const sid = await open();
  assert.deepEqual(names(await listTools(sid)), ["demo_create", "demo_list"]);
});

// ── whose turn (Q2) ──────────────────────────────────────────────────────────────────────────────

test("Q2: a Discord turn is not_owner_turn for an opted-out bot, and the same bot with the opt-in is allowed", async () => {
  let r = await send(initBody(), { actor: sessActor("discord") });
  assert.equal(r.status, 403);
  assert.equal(errMsg(r), "Not available on this turn.");
  assert.equal(lastOutcome(), "refused:not_owner_turn");
  // Gmail is the same rule.
  assert.equal((await send(initBody(), { actor: sessActor("gmail") })).status, 403);
  await withDb((d) => store.setBotOptin(d, OWNER, true));
  try {
    const sid = await open({ actor: sessActor("discord") });
    assert.deepEqual(names(await listTools(sid, { actor: sessActor("discord") })), ["demo_create", "demo_list"]);
    const call = await callTool(sid, "demo_list", {}, { actor: sessActor("discord") });
    assert.equal(textOf(call), "ran demo_list", call.text);
  } finally {
    await withDb((d) => store.setBotOptin(d, OWNER, false));
  }
  // The opt-in is per bot: the ungranted bot's opt-in changes nothing (it has no grant).
  await withDb((d) => store.setBotOptin(d, UNGRANTED, true));
  try {
    r = await send(initBody(), { actor: sessActor("ungranted") });
    assert.equal(r.status, 403);
    assert.equal(errMsg(r), "Not available on this turn.");
    assert.equal(lastOutcome(), "refused:not_granted");
  } finally {
    await withDb((d) => store.setBotOptin(d, UNGRANTED, false));
  }
});

test("a Perch session the engine does not report as serving the owner is not_owner_turn", async () => {
  const r = await send(initBody(), { actor: sessActor("perchOther") });
  assert.equal(r.status, 403);
  assert.equal(errMsg(r), "Not available on this turn.");
  assert.equal(lastOutcome(), "refused:not_owner_turn");
});

// ── the satellite, the host and the grant ────────────────────────────────────────────────────────

test("a revoked satellite is not_active (409); an unknown one is not_found (404, empty)", async () => {
  await withDb((d) => store.markRevoked(d, satId, new Date().toISOString()));
  try {
    const r = await send(initBody());
    assert.equal(r.status, 409);
    assert.equal(errMsg(r), "This connection is turned off.");
    assert.equal(lastOutcome(), "refused:not_active");
  } finally {
    await withDb((d) => store.updateSatelliteStatus(d, satId, { status: "active" }));
  }
  const r = await send(initBody(), { sat: "not-a-satellite" });
  assert.equal(r.status, 404);
  assert.equal(r.text, "");
  assert.equal(lastOutcome(), "refused:not_found");
});

test("a bundle this satellite does not host is not_found; a bundle hosted elsewhere is not_found too", async () => {
  let r = await send(initBody(), { bundle: "elsewhere" });
  assert.equal(r.status, 404);
  assert.equal(r.text, "");
  assert.equal(lastOutcome(), "refused:not_found");
  // installed.json says another satellite hosts it: still not this route.
  writeInstalled([{ id: "elsewhere", mode: "satellite", host: "some-other-satellite", version: "1.0.0" }]);
  try {
    r = await send(initBody(), { bundle: "elsewhere" });
    assert.equal(r.status, 404);
    assert.equal(lastOutcome(), "refused:not_found");
  } finally {
    writeInstalled();
  }
});

// F6: a real, ACTIVE second satellite. This bundle lives on satellite A, so B's route is not a route.
test("F6: a bundle hosted on satellite A is not_found through a real, active satellite B's route", async () => {
  const second = createMgmtFake();
  await makeSatelliteRow(entryDb, second, { name: "second-sat" });
  const before = mcpCalls().length;
  const beforeA = fake.state.requests.length;
  const r = await send(initBody(), { sat: second.satId, bundle: BUNDLE });
  assert.equal(r.status, 404);
  assert.equal(r.text, "", "the empty not_found body");
  assert.equal(lastOutcome(), "refused:not_found");
  assert.equal(mcpCalls().length, before, "nothing reached either satellite");
  assert.equal(fake.state.requests.length, beforeA, "satellite A was never called");
  assert.deepEqual(second.state.requests, [], "satellite B was never called");
  // The bundle stays reachable at its own host's route.
  assert.equal((await send(initBody())).status, 200);
});

// F4: the upstream only ever calls the route's OWN satellite entry.
test("F4: a local entry with the same bundle id is never called through this mount", async () => {
  let localCalls = 0;
  const local = {
    isSatellite: false, tools: [...demoTools()], status: "connected",
    client: { callTool: async () => { localCalls += 1; return { content: [{ type: "text", text: "local" }] }; } },
  };
  const foreign = {
    isSatellite: true, satelliteId: "some-other-satellite", tools: [...demoTools()], status: "connected",
    client: { callTool: async () => { localCalls += 1; return { content: [{ type: "text", text: "foreign" }] }; } },
  };
  const ctx = { satelliteId: satId, bundle: BUNDLE, botId: OWNER, allowedTools: ["demo_list"], secrets: [] };
  for (const entry of [local, foreign]) {
    const up = M.satelliteToolsUpstream({ servers: new Map([[BUNDLE, entry]]) });
    assert.deepEqual(await up.listTools(ctx), [], "no tools are offered by another entry");
    assert.deepEqual(await up.callTool(ctx, "demo_list", {}), { code: "not_active" });
  }
  assert.equal(localCalls, 0, "neither entry was called");
  // The route's own satellite entry is used.
  const own = { isSatellite: true, satelliteId: satId, tools: [...demoTools()], client: { callTool: async () => ({ content: [{ type: "text", text: "own" }] }) } };
  const up = M.satelliteToolsUpstream({ servers: new Map([[BUNDLE, own]]) });
  assert.deepEqual((await up.listTools(ctx)).map((t) => t.name).sort(), ["demo_create", "demo_list"]);
  assert.equal((await up.callTool(ctx, "demo_list", {})).content[0].text, "own");
});

test("an ungranted bot is not_granted before any session exists: no list, no call, nothing fetched", async () => {
  const before = mcpCalls().length;
  const r = await send(initBody(), { actor: sessActor("ungranted") });
  assert.equal(r.status, 403);
  assert.equal(errMsg(r), "Not available on this turn.");
  assert.equal(lastOutcome(), "refused:not_granted");
  assert.equal(r.sid, null, "no MCP session is opened");
  assert.equal(mcpCalls().length, before, "nothing reached the satellite for an ungranted bot");
});

test("the grant is the filter: only granted tools are listed, another name is refused, and a revoked grant ends the session's access", async () => {
  setDef(OWNER, ["demo/demo_list"]);
  try {
    const sid = await open();
    assert.deepEqual(names(await listTools(sid)), ["demo_list"], "the ungranted tool of a granted bundle is not offered");
    const before = mcpCalls().length;
    const call = await callTool(sid, "demo_create");
    assert.equal(call.json?.result?.isError, true);
    assert.equal(textOf(call), "Not available on this turn.");
    assert.equal(lastOutcome(), "refused:not_granted");
    assert.equal(mcpCalls().length, before, "a name outside the grant never leaves the gateway");
  } finally {
    setDef(OWNER, ["demo/demo_list", "demo/demo_create"]);
  }
  // A live session whose grant goes away is refused outright on its next request (authorize runs
  // again), which is stronger than an empty listing.
  const sid2 = await open();
  assert.equal(names(await listTools(sid2)).length, 2);
  setDef(OWNER, ["crow-memory"]);
  try {
    const r = await listTools(sid2);
    assert.equal(r.status, 403);
    assert.equal(errMsg(r), "Not available on this turn.");
    assert.equal(lastOutcome(), "refused:not_granted");
  } finally {
    setDef(OWNER, ["demo/demo_list", "demo/demo_create"]);
  }
});

test("a disabled bot has no live scope at all (unattributed), even with a granted bundle", async () => {
  const sessionId = raw((d) => Number(d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status) VALUES ('b3','perch','perch-b3','active')").run().lastInsertRowid));
  const sig = signScopeActor({ kind: "satellite-tools", botId: "b3", sessionId, threadId: "perch-b3", gatewayType: "perch" });
  const r = await send(initBody(), { actor: { kind: "satellite-tools", botId: "b3", scope: `s:${sessionId}`, threadId: "perch-b3", gatewayType: "perch", sig } });
  assert.equal(r.status, 403);
  assert.equal(errMsg(r), "A signed bot is required.");
});

// ── the call itself ─────────────────────────────────────────────────────────────────────────────

test("the satellite sees X-Crow-Sat-Caller = bot:<id>, and the bot reads the answer", async () => {
  const sid = await open();
  calls.length = 0;
  const r = await callTool(sid, "demo_list");
  assert.equal(textOf(r), "ran demo_list", r.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].caller, `bot:${OWNER}`);
  const sent = mcpCalls().filter((q) => q.body.includes("tools/call")).at(-1);
  assert.equal(sent.headers["X-Crow-Sat-Caller"], `bot:${OWNER}`, "the signed header carries the bot");
});

test("an owner job works through this mount too", async () => {
  const sid = await open({ actor: jobActor("job-own-1") });
  const r = await callTool(sid, "demo_create", { name: "a thing" }, { actor: jobActor("job-own-1") });
  assert.equal(textOf(r), "ran demo_create", r.text);
  assert.equal(calls.at(-1).caller, `bot:${OWNER}`);
});

test("a pin mismatch through this mount is tools_changed, and nothing is fetched", async () => {
  const sid = await open();
  const changed = [...demoTools(), { name: "demo_extra", description: "new", inputSchema: { type: "object", properties: {} } }];
  await withDb((d) => store.updateSatelliteStatus(d, satId, {
    last_status_json: JSON.stringify({ v: 1, status: { ...fake.statusBody(), tools: { [BUNDLE]: { version: "1.0.0", sha256: toolsHash(changed) } } }, alerts: { psi: false, tools: {} } }),
  }));
  try {
    const before = mcpCalls().length;
    const r = await callTool(sid, "demo_list");
    assert.equal(r.json?.result?.isError, true);
    assert.equal(textOf(r), "These tools changed; approve them on the Servers page.");
    assert.equal(lastOutcome(), "error:tools_changed");
    assert.equal(mcpCalls().length, before, "no tools/call left the gateway");
  } finally {
    await withDb((d) => store.updateSatelliteStatus(d, satId, {
      last_status_json: JSON.stringify({ v: 1, status: fake.statusBody(), alerts: { psi: false, tools: {} } }),
    }));
  }
  // Approved again: the same session calls it.
  assert.equal(textOf(await callTool(sid, "demo_list")), "ran demo_list");
});

test("a bundle with no pin publishes no tool at all, and the mount lists nothing for it", async () => {
  await withDb((d) => store.deleteToolPins(d, satId, BUNDLE));
  await refresh();
  try {
    const before = mcpCalls().length;
    const sid = await open();
    assert.deepEqual(names(await listTools(sid)), []);
    const r = await callTool(sid, "demo_list");
    // Nothing was published, so the session has no tools/call handler to reach: the SDK answers
    // its own "Method not found". Either way the call never leaves the gateway.
    assert.ok(r.json?.error || r.json?.result?.isError === true, r.text);
    assert.equal(mcpCalls().length, before, "no tools/call left the gateway");
  } finally {
    await withDb((d) => store.putToolPin(d, {
      satellite_id: satId, bundle: BUNDLE, version: "1.0.0", tools_sha256: toolsHash(demoTools()),
      tools_json: JSON.stringify(demoTools()), approved_at: "2026-11-01T00:00:00Z",
    }));
    await refresh();
  }
});

test("authorizeSatelliteCall: the codes behind the fixed texts, request-independent", async () => {
  await withDb(async (d) => {
    const a = (o) => ({ scope: "session", botId: OWNER, gatewayType: "perch", defProjectId: null, sessionProjectId: null, ...o });
    const engine = { sessionServicesLive: (id) => live.has(Number(id)) };
    const code = async (actor, params = { sat: satId, bundle: BUNDLE }, opts = {}) => (await M.authorizeSatelliteCall(d, actor, params, { engine, ...opts })).code ?? "ok";
    assert.equal(await code(a({ id: BOT_SESS.perch })), "ok");
    assert.equal(await code(a({ scope: "job", principal: "owner" })), "ok");
    assert.equal(await code(a({ scope: "job", principal: null })), "not_owner_turn");
    assert.equal(await code(a({ id: BOT_SESS.perchOther })), "not_owner_turn");
    const un = await M.authorizeSatelliteCall(d, a({ botId: UNGRANTED, id: BOT_SESS.ungranted }), { sat: satId, bundle: BUNDLE }, { engine });
    assert.equal(un.code, "not_granted", JSON.stringify({ un, id: BOT_SESS.ungranted, live: [...live] }));
    assert.equal(await code(a({ botId: "b3", id: BOT_SESS.perch })), "not_granted", "a disabled bot");
    assert.equal(await code(a({ botId: "nobody", id: BOT_SESS.perch })), "not_granted", "no such bot def");
    assert.equal(await code(a({ id: BOT_SESS.perch }), { sat: "nope", bundle: BUNDLE }), "not_found");
    assert.equal(await code(a({ id: BOT_SESS.perch }), { sat: satId, bundle: "elsewhere" }), "not_found");
    assert.equal(await code(a({ scope: "board" })), "not_granted");
    assert.equal(await code(null), "not_granted");
    const ok = await M.authorizeSatelliteCall(d, a({ id: BOT_SESS.perch }), { sat: satId, bundle: BUNDLE }, { engine });
    assert.deepEqual(ok.ctx.allowedTools.sort(), ["demo_create", "demo_list"]);
    assert.equal(ok.ctx.ownerTurn, true);
    assert.deepEqual(ok.ctx.secrets, [], "a satellite never hands crow's secrets to the redactor");
    // The grant readers are the spellings Bot Builder writes.
    assert.deepEqual(M.satelliteGrants({ tools: { crow_mcp: ["demo/demo_list", "demo__demo_create", "demo", "demo2/x", "other/demo_list"] } }, BUNDLE).sort(), ["demo_create", "demo_list"]);
    assert.deepEqual(M.satelliteGrants({ tools: { crow_mcp: ["demo"] } }, BUNDLE), [], "a bare bundle name grants nothing");
  });
});