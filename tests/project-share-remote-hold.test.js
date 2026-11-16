/**
 * Review fixes, remote tools while a bot holds a project share.
 *
 * M-A: the remote-proxy BLOCK was withheld only when a bot's MCP config was built (mcp_writer.mjs
 * holdsShare), so a share granted while a session was live kept relaying until the next respawn.
 * servers/gateway/routes/peer-relay.js now re-reads the same rule on EVERY request, after the
 * signed-actor/session checks and the enabled check: a live share (suspended ones included) is a
 * 403, a failed share read is a 503 (fail closed), and the peer never sees a refused request.
 *
 * M-B: one rule everywhere. bot-world.mjs and job_runner.mjs used to derive holdsShare from
 * loadBotShares, which leaves out archived/tombstoned projects and dead bot defs, while
 * botHoldsLiveShare (the store), the regen panel and the mcp_writer CLI use "any project_bot_shares
 * row with revoked_at IS NULL". bridge.mjs now exports that rule synchronously
 * (botHoldsLiveShareSync), and both spawn paths use it. It fails CLOSED: only a DB that predates
 * the table ("no such table") is "no share"; any other read error reports a share.
 *
 * The relay here is the real peerRelayRouter on a bare express app (the harness shape of
 * tests/peer-relay.test.js: the real per-boot actor key, the real relay token, a fresh init-db
 * database and a fake peer upstream), because the 503 leg needs an injected DB client. The world
 * and job legs run the real buildBotWorld / runJob against a stub pi.
 *
 * Scratch CROW_HOME / data dir / HOME / DB throughout: nothing here reads or writes the real
 * ~/.crow, ~/.pi, or a gateway.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "share-remote-hold-"));
const HOME = join(dir, "home");
const CROW_HOME = join(dir, "crow");
const DATA = join(dir, "data");
const DB_FILE = join(DATA, "crow.db");

mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
mkdirSync(DATA, { recursive: true });
writeFileSync(join(HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }) + "\n");

process.env.HOME = HOME;
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_FILE;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_JOURNAL_MODE = "DELETE";
// File delivery: the world/job configs are written where the test can read them back.
process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
// No gateway is reachable from here; a relay/warm call must fail at once, never hang.
process.env.CROW_GATEWAY_PORT = "1";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1000";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "8000";
process.env.PIBOT_JOB_TIMEOUT_MS = "8000";
process.env.CROW_PI_SANDBOX = "off";
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));

const PEER = "peerhold00000001";
const RELAY_BOT = "relayglass";
const SHARE_BOT = "shareglass";
const WORLD_BOT = "worldglass";
const JOB_BOT = "jobglass";
const REVOKED_BOT = "revokedglass";

// x-share: the project a relay share is granted on / revoked from mid-session.
// x-arch: an ARCHIVED project. Nothing can be granted on it any more, so its share row is written
// directly — and it must still count for the spawn-side rule.
const P_X = 401;
const P_ARCH = 402;
const P_SUSP = 403;

const SHARE_REFUSAL = /remote tools are off while this bot holds a project share/;
const READ_FAILURE = /the peer relay could not read the bot's settings/;
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

const botDef = (over = {}) => ({
  system_prompt: "You are a test bot.",
  models: { default: "stub/m1" },
  tools: { crow_mcp: ["crow-memory"], remote_mcp: [PEER + "::crow-memory"] },
  permission_policy: { bash: "deny", write_paths: [] },
  gateways: [{ type: "discord" }],
  tracker_config: { type: "none" },
  ...over,
});

let relayToken, relayBase, relay, upstream, upstreamPort, sessionId, shareSessionId;
let peerRelayRouter, createDbClient, ensurePeerRelayToken, initGatewayActorKey, signPeerRelayActor;
let relayServer, bridgeModule;
const hits = [];

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const sql = (fn) => { const c = new Database(DB_FILE); try { return fn(c); } finally { c.close(); } };
const insertShare = (projectId, botId, revokedAt = null) => sql((c) => c
  .prepare("INSERT INTO project_bot_shares (project_id, bot_id, level, revoked_at) VALUES (?,?,?,?)")
  .run(projectId, botId, "read", revokedAt));
const revokeShares = (botId) => sql((c) => c
  .prepare("UPDATE project_bot_shares SET revoked_at = datetime('now') WHERE bot_id = ? AND revoked_at IS NULL")
  .run(botId));

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: DATA, CROW_DB_PATH: DB_FILE }, cwd: REPO, stdio: "pipe",
  });
  sql((c) => {
    c.prepare("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, trusted) VALUES (?,?,?,?, 'active', 1)")
      .run(PEER, "peer", PEER, null); // the gateway_url is filled in once the fake peer listens
    const proj = c.prepare("INSERT INTO project_spaces (id, slug, name, status, archived_at) VALUES (?,?,?,?,?)");
    proj.run(P_X, "remote-hold-x", "Remote Hold X", "active", null);
    proj.run(P_ARCH, "remote-hold-archived", "Remote Hold Archived", "archived", null);
    proj.run(P_SUSP, "remote-hold-suspended", "Remote Hold Suspended", "active", null);
    const def = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)");
    for (const id of [RELAY_BOT, SHARE_BOT, WORLD_BOT, JOB_BOT, REVOKED_BOT]) def.run(id, id + " bot", JSON.stringify(botDef()));
    const sess = c.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, archived_at) VALUES (?, 'discord', 'discord:42', 'active', NULL)");
    sessionId = String(sess.run(RELAY_BOT).lastInsertRowid);
    shareSessionId = String(sess.run(SHARE_BOT).lastInsertRowid); // the suspended-share leg is another bot, so one refusal does not mask the next
    c.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)")
      .run(JSON.stringify({ remote_invocation: true }));
    // An active `project_members` row whose contact is not the local owner: while it is there the
    // share of P_SUSP is suspended (and a suspended share still blocks the remote proxy).
    c.prepare("INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?,?)")
      .run(9101, "remote-hold-guest", "Guest", "ed25519-fixture", "secp-fixture");
    c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?,?,?)").run(P_SUSP, 9101, "editor");
    // An archived-project share (written directly: grantShare refuses an archived project) and a
    // revoked one, for the spawn-side rule.
    c.prepare("INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,?)").run(P_ARCH, WORLD_BOT, "read");
    c.prepare("INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,?)").run(P_ARCH, JOB_BOT, "read");
    c.prepare("INSERT INTO project_bot_shares (project_id, bot_id, level, revoked_at) VALUES (?,?,?, datetime('now'))")
      .run(P_ARCH, REVOKED_BOT, "read");
  });

  upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const ch of req) raw += ch;
    hits.push({ path: req.url, method: req.method, headers: { ...req.headers }, body: raw });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  upstreamPort = await listen(upstream);
  sql((c) => c.prepare("UPDATE crow_instances SET gateway_url = ? WHERE id = ?").run(`http://127.0.0.1:${upstreamPort}/`, PEER));

  ({ peerRelayRouter } = await import("../servers/gateway/routes/peer-relay.js"));
  ({ createDbClient } = await import("../servers/db.js"));
  ({ ensurePeerRelayToken } = await import("../servers/gateway/local-token.js"));
  ({ initGatewayActorKey, signPeerRelayActor } = await import("../scripts/pi-bots/actor-sig.mjs"));

  const tdb = createDbClient(DB_FILE);
  try { await ensurePeerRelayToken(tdb); } finally { tdb.close(); }
  relayToken = readFileSync(join(CROW_HOME, "secrets", "peer-relay-token"), "utf8").trim();
  initGatewayActorKey();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(peerRelayRouter({
    createDbClient: () => createDbClient(DB_FILE),
    deps: {
      keyLookup: () => null,
      getCreds: () => ({ auth_token: "peer-bearer" }),
      localId: () => "inst-local-0001",
    },
  }));
  relay = http.createServer(app);
  relayBase = `http://127.0.0.1:${await listen(relay)}`;

  bridgeModule = await import("../scripts/pi-bots/bridge.mjs");
});

after(async () => {
  relay?.closeAllConnections?.(); upstream?.closeAllConnections?.();
  await Promise.all([relay, upstream].filter(Boolean).map((s) => new Promise((r) => s.close(() => r()))));
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh relay app (the 503 leg needs its own createDbClient). */
async function routerWith(over) {
  const app = express();
  app.use(express.json());
  app.use(peerRelayRouter(over));
  const srv = http.createServer(app);
  const port = await listen(srv);
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

const actorHeaders = (bot = RELAY_BOT, session = sessionId) => {
  const a = { botId: bot, sessionId: session, threadId: "discord:42", gatewayType: "discord" };
  return {
    "X-Crow-Actor-Id": a.botId, "X-Crow-Actor-Thread": a.threadId, "X-Crow-Actor-Gateway": a.gatewayType,
    "X-Crow-Actor-Session": a.sessionId, "X-Crow-Actor-Sig": signPeerRelayActor(a),
  };
};

async function relayPost({ base = relayBase, bot = RELAY_BOT, session = sessionId, path = `/peer-relay/${PEER}/memory/mcp` } = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${relayToken}`, ...actorHeaders(bot, session) },
    body: JSON.stringify(INIT),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}

// ---------------------------------------------------------------------------
// M-A — the relay re-reads the share rule on every request
// ---------------------------------------------------------------------------

test("the relay follows a share granted and revoked MID-SESSION, on the same signed session", async () => {
  hits.length = 0;
  let r = await relayPost();
  assert.equal(r.status, 200, r.text);
  assert.equal(hits.length, 1, "no share: the request reaches the peer");

  insertShare(P_X, RELAY_BOT);
  r = await relayPost();
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json?.jsonrpc, "2.0");
  assert.match(r.json.error.message, SHARE_REFUSAL);
  assert.equal(hits.length, 1, "a refused request never reaches the peer");

  revokeShares(RELAY_BOT);
  r = await relayPost();
  assert.equal(r.status, 200, "revoking the share restores the relay: " + r.text);
  assert.equal(hits.length, 2);
});

test("a SUSPENDED share (an outside member on the shared project) refuses the relay too", async () => {
  hits.length = 0;
  let r = await relayPost({ bot: SHARE_BOT, session: shareSessionId });
  assert.equal(r.status, 200, "positive control: no share, the relay works: " + r.text);

  insertShare(P_SUSP, SHARE_BOT);
  r = await relayPost({ bot: SHARE_BOT, session: shareSessionId });
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error.message, SHARE_REFUSAL);
  assert.equal(hits.length, 1, "a suspended share still relays nothing");

  revokeShares(SHARE_BOT);
});

test("a failed share read refuses 503 (fail closed), not a relay", async () => {
  hits.length = 0;
  const real = () => createDbClient(DB_FILE);
  const brokenShares = () => {
    const db = real();
    const exec = db.execute.bind(db);
    return {
      ...db,
      close: () => db.close(),
      execute: (q) => (typeof q === "object" && /project_bot_shares/.test(String(q.sql)) ? Promise.reject(new Error("disk I/O error")) : exec(q)),
    };
  };
  const r = await routerWith({
    createDbClient: brokenShares,
    deps: { keyLookup: () => null, getCreds: () => ({ auth_token: "peer-bearer" }), localId: () => "inst-local-0001" },
  });
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  let res;
  try {
    res = await relayPost({ base: r.base });
  } finally {
    console.error = orig;
    await r.close();
  }
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json?.jsonrpc, "2.0");
  assert.match(res.json.error.message, READ_FAILURE);
  assert.equal(hits.length, 0, "a share read that failed relays nothing");
  assert.ok(lines.some((l) => l.includes("[peer-relay]") && l.includes("disk I/O error")), lines.join("\n"));
  for (const l of lines) assert.ok(!l.includes(relayToken), "no relay token in a log line");
});

// ---------------------------------------------------------------------------
// M-B — one rule everywhere: bridge.botHoldsLiveShareSync
// ---------------------------------------------------------------------------

test("botHoldsLiveShareSync: an archived-project share counts, a revoked one does not, a missing table is false", () => {
  const holds = bridgeModule.botHoldsLiveShareSync;
  assert.equal(holds(WORLD_BOT), true, "a live share of an archived project is still a live share");
  assert.equal(holds(JOB_BOT), true);
  assert.equal(holds(REVOKED_BOT), false, "revoked_at set => not live");
  assert.equal(holds("no-such-bot"), false);
  assert.equal(holds(null), false);

  sql((c) => c.exec("ALTER TABLE project_bot_shares RENAME TO project_bot_shares_gone"));
  try {
    assert.equal(holds(WORLD_BOT), false, "an older DB without the table is 'no share'");
  } finally {
    sql((c) => c.exec("ALTER TABLE project_bot_shares_gone RENAME TO project_bot_shares"));
  }
  assert.equal(holds(WORLD_BOT), true, "and the live row is back afterwards");
});

test("botHoldsLiveShareSync fails CLOSED on a read error (a DB path that is not a database)", () => {
  const badDbDir = join(dir, "not-a-database");
  mkdirSync(badDbDir, { recursive: true });
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    'const m = await import("./scripts/pi-bots/bridge.mjs"); process.stdout.write(JSON.stringify({ holds: m.botHoldsLiveShareSync("reader") }));',
  ], { cwd: REPO, env: { ...process.env, CROW_DB_PATH: badDbDir }, encoding: "utf8", timeout: 120_000 });
  assert.deepEqual(JSON.parse(out), { holds: true }, "an unreadable DB reports a share");
});

test("the world builder: an archived-project share keeps the remote-proxy blocks out; a revoke restores them", { timeout: 120_000 }, async () => {
  const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
  const remoteNames = (json) => Object.keys((json && json.mcpServers) || {}).filter((n) => n.startsWith("crow-remote-"));
  const logs = [];
  const held = await buildBotWorld({ botId: WORLD_BOT, threadId: "discord:42", gatewayType: "discord", log: (m) => logs.push(String(m)) });
  assert.deepEqual(remoteNames(held.mcpConfig), [], "a live share of an archived project still blocks the proxy");
  assert.ok(logs.some((l) => SHARE_REFUSAL.test(l)), "the reason is reported: " + logs.join(" | "));

  revokeShares(WORLD_BOT);
  const free = await buildBotWorld({ botId: WORLD_BOT, threadId: "discord:42", gatewayType: "discord", log: () => {} });
  assert.equal(remoteNames(free.mcpConfig).length, 1, "a revoked share no longer holds the blocks back");
  insertShare(P_ARCH, WORLD_BOT);
});

/** A stub pi that speaks the rpc protocol and records what it was handed (PIBOT_PI_CLI). */
function writeJobStub() {
  const stub = join(dir, "stub-pi-job.mjs");
  writeFileSync(stub, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'let cfgText = null;',
    'try { cfgText = readFileSync(process.env.PI_BOT_MCP_CONFIG, "utf8"); } catch { cfgText = null; }',
    'writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify({ env: process.env, cfgText }));',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let buf = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk.toString("utf8");',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    let m; try { m = JSON.parse(line); } catch { continue; }',
    '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "share-hold-uuid" } });',
    '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
    '    else if (m.type === "prompt") { out({ type: "response", command: "prompt" });',
    '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }); }',
    '    else if (m.type === "abort") out({ type: "response", command: "abort" });',
    '  }',
    '});',
    'process.stdin.resume();',
  ].join("\n"));
  return stub;
}
process.env.PIBOT_PI_CLI = writeJobStub();

let jobSeq = 0;
/** One real runJob (stub pi), with the real bridge behind a recording wrapper. */
async function jobTurn(botId) {
  const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
  const seen = [];
  const spy = {
    ...bridgeModule,
    botHoldsLiveShareSync: (id) => { const v = bridgeModule.botHoldsLiveShareSync(id); seen.push([id, v]); return v; },
  };
  const capture = join(dir, `job-capture-${++jobSeq}.json`);
  const saved = process.env.PIBOT_TEST_CAPTURE;
  process.env.PIBOT_TEST_CAPTURE = capture;
  try {
    const logs = [];
    const r = await runJob(
      { job_id: "job-hold-" + jobSeq, bot_id: botId, goal: "do the job", escalate: 0, source: "chat", principal: null },
      { log: (m) => logs.push(String(m)), bridge: spy },
    );
    assert.ok(r && r.result != null, "the job completed against the stub: " + logs.join(" | "));
    const cap = JSON.parse(readFileSync(capture, "utf8"));
    assert.ok(cap.cfgText, "the job turn was handed its MCP config: " + logs.join(" | "));
    return { seen, logs, config: JSON.parse(cap.cfgText) };
  } finally {
    if (saved === undefined) delete process.env.PIBOT_TEST_CAPTURE; else process.env.PIBOT_TEST_CAPTURE = saved;
  }
}

test("the job path reads the same rule: holdsShare comes from botHoldsLiveShareSync", { timeout: 180_000 }, async () => {
  const held = await jobTurn(JOB_BOT);
  assert.deepEqual(held.seen, [[JOB_BOT, true]], "an archived-project live share is a held share for a job turn");

  const free = await jobTurn(REVOKED_BOT);
  assert.deepEqual(free.seen, [[REVOKED_BOT, false]], "a revoked share is not");
});