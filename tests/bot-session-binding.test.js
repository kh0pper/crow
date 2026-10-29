/**
 * Item 46 PR-B (B6): a bot turn's MCP config binds the turn's bot session.
 *
 * The real handleInbound (bridge.mjs → bot-world.mjs → mcp_writer.mjs) with a
 * protocol-speaking stub pi that records the per-bot config it was handed
 * (file delivery, so the stub can read it). Legs:
 *   - in-gateway (this process holds the key): the FIRST turn of a new thread
 *     gets a peer-relay signature bound to the row the turn creates, and the
 *     turn still creates exactly one row; a second turn keeps the same id;
 *   - key-less host (no key; a fake loopback signing relay on
 *     CROW_GATEWAY_PORT): no signing request is made before the row exists,
 *     one is made with the new row's id, and the config carries the relay's
 *     signature for exactly that session.
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
const dir = mkdtempSync(join(tmpdir(), "bot-session-binding-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "5000";
process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
process.env.PI_MODELS_JSON = join(dir, "models.json");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));
writeFileSync(join(process.env.CROW_HOME, "peer-relay-token"), "relay-token-x", { mode: 0o600 });

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PEER = "inst-bravo-0002";

const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync, readFileSync } from "node:fs";',
  'let mcp = null;',
  'try { mcp = JSON.parse(readFileSync(process.env.PI_BOT_MCP_CONFIG, "utf8")); } catch (e) { mcp = { error: String(e && e.code) }; }',
  'writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify({ mcp }));',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let buf = "", seq = 0;',
  'process.stdin.on("data", (c) => {',
  '  buf += c.toString("utf8"); let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "bind-uuid" } });',
  '    else if (m.type === "get_session_stats") { seq++; out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: seq, output: seq, cacheRead: 0 } } }); }',
  '    else if (m.type === "prompt") { out({ type: "response", command: "prompt" }); out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }); }',
  '    else if (m.type === "abort") out({ type: "response", command: "abort" });',
  '  }',
  '});',
  'process.stdin.resume();',
].join("\n"));
process.env.PIBOT_PI_CLI = STUB_PI;

const { handleInbound } = await import("../scripts/pi-bots/bridge.mjs");
const { initGatewayActorKey, _resetActorKeyForTest, verifyPeerRelayActorSig, _resetPresignedForTest } = await import("../scripts/pi-bots/actor-sig.mjs");

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = new Database(DB_FILE);
  const def = {
    system_prompt: "You are a test bot.", models: { default: "stub/m1" },
    tools: { pi_builtin: ["read"], crow_mcp: [], remote_mcp: [`${PEER}::crow-memory`] },
    permission_policy: { bash: "deny", write_paths: [], multi_agent: false },
    session_dir: join(dir, "bots", "hank"),
  };
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)").run("hank", "Hank", JSON.stringify(def));
  c.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)").run(JSON.stringify({ remote_invocation: true }));
  c.prepare("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, trusted) VALUES (?, 'bravo', ?, 'http://127.0.0.1:9/', 'active', 1)").run(PEER, PEER);
  c.close();
});
after(() => rmSync(dir, { recursive: true, force: true }));

function rows(thread) {
  const c = new Database(DB_FILE);
  const r = c.prepare("SELECT id, status FROM bot_sessions WHERE bot_id='hank' AND gateway_thread_id=? ORDER BY id").all(thread);
  c.close();
  return r;
}

async function turn(thread, leg) {
  const capture = join(dir, `capture-${leg}.json`);
  if (existsSync(capture)) rmSync(capture);
  process.env.PIBOT_TEST_CAPTURE = capture;
  const result = await handleInbound({ bot_id: "hank", gateway_thread_id: thread, gateway_type: "gmail", user_message: "hi", sendReply: async () => {}, log: () => {} });
  const { mcp } = JSON.parse(readFileSync(capture, "utf8"));
  const name = Object.keys(mcp.mcpServers || {}).find((k) => k.startsWith("crow-remote-"));
  assert.ok(name, "the remote block reached pi: " + JSON.stringify(mcp));
  return { result, env: mcp.mcpServers[name].env };
}

const actorOf = (env) => ({ botId: env.CROW_REMOTE_ACTOR_ID, sessionId: env.CROW_REMOTE_ACTOR_SESSION, threadId: env.CROW_REMOTE_ACTOR_THREAD, gatewayType: env.CROW_REMOTE_ACTOR_GATEWAY });

test("in-gateway: the first turn of a new thread is bound to the row it creates; the next turn keeps it", { timeout: 60_000 }, async () => {
  _resetActorKeyForTest();
  initGatewayActorKey();
  assert.deepEqual(rows("gmail-t1"), [], "no row before the first turn");
  const first = await turn("gmail-t1", "t1a");
  assert.equal(first.result.action, "asked");
  const after1 = rows("gmail-t1");
  assert.equal(after1.length, 1, "exactly one row, as before");
  assert.equal(first.env.CROW_REMOTE_ACTOR_SESSION, String(after1[0].id), "the config names the row the turn created");
  assert.equal(verifyPeerRelayActorSig({ ...actorOf(first.env), sig: first.env.CROW_REMOTE_ACTOR_SIG }), true);
  assert.equal(verifyPeerRelayActorSig({ ...actorOf(first.env), sessionId: String(after1[0].id + 1), sig: first.env.CROW_REMOTE_ACTOR_SIG }), false);

  const second = await turn("gmail-t1", "t1b");
  assert.equal(second.env.CROW_REMOTE_ACTOR_SESSION, String(after1[0].id));
  assert.equal(rows("gmail-t1").length, 1);
  assert.equal(verifyPeerRelayActorSig({ ...actorOf(second.env), sig: second.env.CROW_REMOTE_ACTOR_SIG }), true);
});

test("key-less host: signatures come from the gateway's relay, only once the session row exists", { timeout: 60_000 }, async () => {
  _resetActorKeyForTest();
  _resetPresignedForTest();
  const asked = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    asked.push({ url: req.url, body, sessionRows: rows(body.threadId).length });
    res.writeHead(200, { "content-type": "application/json" });
    // A distinct, recognisable signature per kind and session.
    const sigs = {};
    for (const k of body.kinds) sigs[k] = (k === "peer-relay" ? "e" : "f").repeat(48) + String(body.sessionId || "0").padStart(16, "0");
    res.end(JSON.stringify({ sigs }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const savedPort = process.env.CROW_GATEWAY_PORT;
  process.env.CROW_GATEWAY_PORT = String(srv.address().port);
  try {
    const first = await turn("gmail-t2", "t2a");
    const id = rows("gmail-t2")[0].id;
    assert.equal(asked.length, 1, "one signing request: none before the row existed: " + JSON.stringify(asked));
    assert.equal(asked[0].url, "/internal/actor-sign");
    assert.equal(asked[0].sessionRows, 1, "the row existed when the host asked");
    assert.equal(asked[0].body.sessionId, String(id));
    assert.equal(asked[0].body.botId, "hank");
    assert.ok(asked[0].body.kinds.includes("peer-relay"));
    assert.equal(first.env.CROW_REMOTE_ACTOR_SESSION, String(id));
    assert.equal(first.env.CROW_REMOTE_ACTOR_SIG, "e".repeat(48) + String(id).padStart(16, "0"), "the gateway's signature for exactly this session");
    // The next turn presigns at build time (the row exists) and does not rebuild.
    await turn("gmail-t2", "t2b");
    assert.equal(asked.length, 2);
    assert.equal(asked[1].body.sessionId, String(id));
  } finally {
    if (savedPort === undefined) delete process.env.CROW_GATEWAY_PORT; else process.env.CROW_GATEWAY_PORT = savedPort;
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(() => r()));
    _resetPresignedForTest();
  }
});
