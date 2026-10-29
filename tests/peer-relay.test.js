/**
 * Item 46 PR-B (B4): the loopback peer relay a pi bot's remote proxy talks to.
 *
 * The real peerRelayRouter on a bare express app (with the gateway's json
 * parser), a fresh init-db database, the real per-boot actor key and relay
 * token, and a fake upstream MCP server (the real SDK server transport) that
 * records every request it sees. Every refusal leg asserts the upstream saw
 * nothing; the positive control asserts what it saw: the peer bearer (never
 * the relay token), no X-Crow-Actor-* header, and on tools/call a remote-actor
 * signature verifyRemoteActor accepts for the bot row's id and display name.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import Database from "better-sqlite3";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createDbClient } from "../servers/db.js";
import { peerRelayRouter } from "../servers/gateway/routes/peer-relay.js";
import { ensurePeerRelayToken, validatePeerRelayToken } from "../servers/gateway/local-token.js";
import { initGatewayActorKey, signPeerRelayActor, signArtifactsActor } from "../scripts/pi-bots/actor-sig.mjs";
import { verifyRemoteActor, REMOTE_ACTOR_HEADER, REMOTE_ACTOR_SIG_HEADER, _resetRemoteActorNonces } from "../servers/shared/remote-actor.js";

const LOCAL = "inst-alpha-0001";
const BRAVO = "inst-bravo-0002";
const CHARLIE = "inst-charlie-0003";
const DELTA = "inst-delta-0004"; // selected by the bot, no crow_instances row
const ECHO = "inst-echo-0005"; // a trusted peer the bot did NOT select
const PEER_TOKENS = { [BRAVO]: "bravo-peer-bearer-" + randomBytes(6).toString("hex"), [CHARLIE]: "charlie-peer-bearer-" + randomBytes(6).toString("hex"), [ECHO]: "echo-peer-bearer-x" };
const PAIR_KEYS = { [BRAVO]: randomBytes(32).toString("hex") }; // charlie has no pair key (S-P2)
const ACTOR = { botId: "hank", threadId: "discord:42", gatewayType: "discord" };

let dir, dbPath, app, relay, relayBase, upstream, upstreamPort, relayToken;
const seen = []; // upstream requests: { path, method, headers, body }

function upstreamServer() {
  const sessions = new Map();
  const mk = () => {
    const s = new McpServer({ name: "fake-peer", version: "0" });
    s.registerTool("crow_store_memory", { description: "store", inputSchema: { content: z.string() } }, async ({ content }) => ({ content: [{ type: "text", text: "stored:" + content }] }));
    return s;
  };
  return http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ path: req.url, method: req.method, headers: { ...req.headers }, body });
    if (!req.url.endsWith("/memory/mcp")) { res.writeHead(404); return res.end(); }
    const sid = req.headers["mcp-session-id"];
    if (sid && sessions.has(sid)) return sessions.get(sid).handleRequest(req, res, body);
    if (!sid && req.method === "POST" && isInitializeRequest(body)) {
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
      await mk().connect(t);
      return t.handleRequest(req, res, body);
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "no session" }, id: null }));
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  dir = mkdtempSync(join(tmpdir(), "peer-relay-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  dbPath = join(dir, "crow.db");
  upstream = upstreamServer();
  upstreamPort = await listen(upstream);
  const d = new Database(dbPath);
  const ins = d.prepare("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, trusted) VALUES (?, ?, ?, ?, 'active', 1)");
  ins.run(BRAVO, "bravo", BRAVO, `http://127.0.0.1:${upstreamPort}/`);
  ins.run(CHARLIE, "charlie", CHARLIE, `http://127.0.0.1:${upstreamPort}/charlie`);
  ins.run(ECHO, "echo", ECHO, `http://127.0.0.1:${upstreamPort}/echo`);
  const def = { tools: { remote_mcp: [`${BRAVO}::crow-memory`, `${CHARLIE}::crow-memory`, `${DELTA}::crow-memory`, `${BRAVO}::crow-blog`] } };
  d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?, ?, ?)").run("hank", "Hank Bot", JSON.stringify(def));
  d.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)").run(JSON.stringify({ remote_invocation: true }));
  d.close();

  const tdb = createDbClient(dbPath);
  try { await ensurePeerRelayToken(tdb); } finally { tdb.close(); }
  relayToken = readFileSync(join(process.env.CROW_HOME, "peer-relay-token"), "utf8").trim();
  initGatewayActorKey();

  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(peerRelayRouter({
    createDbClient: () => createDbClient(dbPath),
    deps: {
      keyLookup: (id) => PAIR_KEYS[id] || null,
      getCreds: (id) => (PEER_TOKENS[id] ? { auth_token: PEER_TOKENS[id], signing_key: PAIR_KEYS[id] } : null),
      localId: () => LOCAL,
    },
  }));
  relay = http.createServer(app);
  relayBase = `http://127.0.0.1:${await listen(relay)}`;
});

after(async () => {
  relay?.closeAllConnections?.(); upstream?.closeAllConnections?.();
  await Promise.all([relay, upstream].filter(Boolean).map((s) => new Promise((r) => s.close(() => r()))));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { seen.length = 0; _resetRemoteActorNonces(); });

const actorHeaders = (a = ACTOR, sig = signPeerRelayActor(a)) => ({
  "X-Crow-Actor-Id": a.botId, "X-Crow-Actor-Thread": a.threadId, "X-Crow-Actor-Gateway": a.gatewayType,
  ...(sig ? { "X-Crow-Actor-Sig": sig } : {}),
});
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

async function post(path, { headers = {}, body = INIT } = {}) {
  const r = await fetch(relayBase + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: r.status, json, text };
}
const good = () => ({ Authorization: `Bearer ${relayToken}`, ...actorHeaders() });

function assertRefused(r, status, re) {
  assert.equal(r.status, status, r.text);
  assert.equal(r.json?.jsonrpc, "2.0", r.text);
  assert.match(r.json.error.message, re);
  assert.equal(seen.length, 0, "a refusal never reaches the peer");
}

test("the relay token is minted 0600 and validates; a wrong one does not", async () => {
  const db = createDbClient(dbPath);
  try {
    assert.equal(await validatePeerRelayToken(db, relayToken), true);
    assert.equal(await validatePeerRelayToken(db, relayToken + "x"), false);
    assert.equal(await validatePeerRelayToken(db, ""), false);
  } finally { db.close(); }
  const { statSync } = await import("node:fs");
  assert.equal(statSync(join(process.env.CROW_HOME, "peer-relay-token")).mode & 0o777, 0o600);
});

test("refused: no token", async () => {
  assertRefused(await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: actorHeaders() }), 401, /relay token/);
});

test("refused: a wrong token", async () => {
  assertRefused(await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: { Authorization: "Bearer nope", ...actorHeaders() } }), 401, /relay token/);
});

test("refused: a token but no actor signature, a bad one, or another kind's", async () => {
  const p = `/peer-relay/${BRAVO}/memory/mcp`;
  assertRefused(await post(p, { headers: { Authorization: `Bearer ${relayToken}` } }), 401, /actor/);
  assertRefused(await post(p, { headers: { Authorization: `Bearer ${relayToken}`, ...actorHeaders(ACTOR, "0".repeat(64)) } }), 401, /actor/);
  assertRefused(await post(p, { headers: { Authorization: `Bearer ${relayToken}`, ...actorHeaders(ACTOR, signArtifactsActor(ACTOR)) } }), 401, /actor/);
  assertRefused(await post(p, { headers: { Authorization: `Bearer ${relayToken}`, ...actorHeaders({ ...ACTOR, botId: "other" }, signPeerRelayActor(ACTOR)) } }), 401, /actor/);
});

test("refused: a request that is not a plain loopback one (forwarded from a tailnet address)", async () => {
  assertRefused(await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: { ...good(), "X-Forwarded-For": "100.64.20.7" } }), 403, /local/);
});

test("refused: remote invocation switched off", async () => {
  const d = new Database(dbPath);
  d.prepare("UPDATE dashboard_settings SET value = ? WHERE key = 'feature_flags'").run(JSON.stringify({ remote_invocation: false }));
  d.close();
  try {
    assertRefused(await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: good() }), 403, /remote invocation/);
  } finally {
    const d2 = new Database(dbPath);
    d2.prepare("UPDATE dashboard_settings SET value = ? WHERE key = 'feature_flags'").run(JSON.stringify({ remote_invocation: true }));
    d2.close();
  }
});

test("refused: a peer, or a capability of it, the bot did not select; an unknown bot", async () => {
  assertRefused(await post(`/peer-relay/${ECHO}/memory/mcp`, { headers: good() }), 403, /not selected/);
  assertRefused(await post(`/peer-relay/${BRAVO}/sharing/mcp`, { headers: good() }), 403, /not selected/);
  const ghost = { ...ACTOR, botId: "ghost" };
  assertRefused(await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: { Authorization: `Bearer ${relayToken}`, ...actorHeaders(ghost) } }), 403, /not selected/);
});

test("refused: a mount that is not a remote capability", async () => {
  assertRefused(await post(`/peer-relay/${BRAVO}/router/mcp`, { headers: good() }), 404, /mount/);
});

test("refused: an unknown peer (selected, but no trusted row)", async () => {
  assertRefused(await post(`/peer-relay/${DELTA}/memory/mcp`, { headers: good() }), 404, /peer/);
});

test("refused: a batch body", async () => {
  const r = await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: good(), body: [INIT] });
  assertRefused(r, 400, /batch requests are not relayed/);
  assert.equal(r.json.error.code, -32600);
});

async function relayClient(instanceId, extraHeaders = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${relayBase}/peer-relay/${instanceId}/memory/mcp`), {
    requestInit: { headers: { ...good(), ...extraHeaders } },
  });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(transport);
  return client;
}

test("forwarded: the peer sees its bearer, no actor headers, a session that round-trips, and a signed tools/call", async () => {
  // A forged display name in a header must never reach the label.
  const client = await relayClient(BRAVO, { "X-Crow-Actor-Name": "Evil" });
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["crow_store_memory"]);
    const r = await client.callTool({ name: "crow_store_memory", arguments: { content: "hi" } });
    assert.equal(r.content[0].text, "stored:hi");
  } finally { await client.close(); }

  assert.ok(seen.length >= 3, JSON.stringify(seen.map((s) => [s.method, s.body?.method])));
  for (const s of seen) {
    assert.equal(s.path, "/memory/mcp");
    assert.equal(s.headers.authorization, `Bearer ${PEER_TOKENS[BRAVO]}`, "the peer bearer, never the relay token");
    assert.ok(!Object.keys(s.headers).some((k) => k.startsWith("x-crow-actor")), "no local actor header reaches the peer: " + Object.keys(s.headers));
  }
  const init = seen.find((s) => s.body?.method === "initialize");
  const list = seen.find((s) => s.body?.method === "tools/list");
  const call = seen.find((s) => s.body?.method === "tools/call");
  assert.ok(init && list && call);
  assert.equal(init.headers[REMOTE_ACTOR_HEADER], undefined, "initialize is unsigned");
  assert.equal(list.headers[REMOTE_ACTOR_HEADER], undefined, "tools/list is unsigned");
  assert.ok(list.headers["mcp-session-id"], "the session id reached the peer");
  assert.equal(call.headers["mcp-session-id"], list.headers["mcp-session-id"], "and round-trips");

  const v = verifyRemoteActor({ headers: call.headers, body: call.body, peerId: LOCAL, localId: BRAVO, mount: "/memory", keyLookup: (id) => (id === LOCAL ? PAIR_KEYS[BRAVO] : null) });
  assert.deepEqual(v, { ok: true, actor: { bot: "hank", name: "Hank Bot", src: LOCAL } });
});

test("S-P2: no pair key → forwarded unsigned, one console.error for two calls, no secret in it", async () => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  let client;
  try {
    client = await relayClient(CHARLIE);
    await client.callTool({ name: "crow_store_memory", arguments: { content: "a" } });
    await client.callTool({ name: "crow_store_memory", arguments: { content: "b" } });
  } finally {
    console.error = orig;
    await client?.close();
  }
  const calls = seen.filter((s) => s.body?.method === "tools/call");
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.path, "/charlie/memory/mcp");
    assert.equal(c.headers.authorization, `Bearer ${PEER_TOKENS[CHARLIE]}`);
    assert.equal(c.headers[REMOTE_ACTOR_HEADER], undefined);
    assert.equal(c.headers[REMOTE_ACTOR_SIG_HEADER], undefined);
  }
  const relayLines = lines.filter((l) => l.includes("[peer-relay]"));
  assert.deepEqual(relayLines, [`[peer-relay] forwarding unsigned for bot hank to ${CHARLIE}: no pair key`]);
  for (const l of lines) for (const secret of [relayToken, ...Object.values(PEER_TOKENS), ...Object.values(PAIR_KEYS)]) assert.ok(!l.includes(secret), "no secret in a log line");
});

test("an unreachable peer → 502 JSON-RPC error", async () => {
  const d = new Database(dbPath);
  d.prepare("UPDATE crow_instances SET gateway_url = ? WHERE id = ?").run("http://127.0.0.1:9", BRAVO);
  d.close();
  try {
    const r = await post(`/peer-relay/${BRAVO}/memory/mcp`, { headers: good() });
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.jsonrpc, "2.0");
  } finally {
    const d2 = new Database(dbPath);
    d2.prepare("UPDATE crow_instances SET gateway_url = ? WHERE id = ?").run(`http://127.0.0.1:${upstreamPort}/`, BRAVO);
    d2.close();
  }
});

// Fix round 1: a broken database is the relay's fault, never a misleading
// "not selected"; the clock that rate-limits the unsigned log is the injected one;
// a 5xx logs a message with no secret in it.
async function routerWith(over) {
  const a = express();
  a.use(express.json());
  a.use(peerRelayRouter(over));
  const s = http.createServer(a);
  const port = await listen(s);
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}
function captureErrors() {
  const lines = []; const orig = console.error;
  console.error = (...a) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.error = orig; } };
}

test("a DB error in the bot-row lookup is a 503 with a logged reason, not a 403", async () => {
  const realDb = () => createDbClient(dbPath);
  const brokenRows = () => {
    const db = realDb();
    const exec = db.execute.bind(db);
    return { ...db, close: () => db.close(), execute: (q) => (typeof q === "object" && /FROM pi_bot_defs/.test(q.sql) ? Promise.reject(new Error("disk I/O error")) : exec(q)) };
  };
  const r = await routerWith({ createDbClient: brokenRows, deps: { getCreds: () => ({ auth_token: "x" }), keyLookup: () => null, localId: () => LOCAL } });
  const cap = captureErrors();
  let res;
  try {
    res = await fetch(`${r.base}/peer-relay/${BRAVO}/memory/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...good() }, body: JSON.stringify(INIT) });
  } finally { cap.restore(); await r.close(); }
  const j = await res.json();
  assert.equal(res.status, 503, JSON.stringify(j));
  assert.equal(j.jsonrpc, "2.0");
  assert.equal(seen.length, 0);
  assert.ok(cap.lines.some((l) => l.includes("[peer-relay]") && l.includes("disk I/O error")), cap.lines.join("\n"));
  for (const l of cap.lines) assert.ok(!l.includes(relayToken), "no token in a log line");
});

test("an internal error is a 500 that logs err.message and no secret", async () => {
  const r = await routerWith({ createDbClient: () => createDbClient(dbPath), deps: {
    getCreds: () => ({ auth_token: PEER_TOKENS[BRAVO] }), keyLookup: () => PAIR_KEYS[BRAVO], localId: () => LOCAL,
    fetchImpl: () => ({ get status() { throw new Error("upstream object exploded"); } }),
  } });
  const cap = captureErrors();
  let res;
  try {
    res = await fetch(`${r.base}/peer-relay/${BRAVO}/memory/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...good() }, body: JSON.stringify(INIT) });
  } finally { cap.restore(); await r.close(); }
  assert.equal(res.status, 500);
  assert.ok(cap.lines.some((l) => l.includes("[peer-relay]") && l.includes("upstream object exploded")), cap.lines.join("\n"));
  for (const l of cap.lines) for (const sec of [relayToken, PEER_TOKENS[BRAVO], PAIR_KEYS[BRAVO]]) assert.ok(!l.includes(sec));
});

test("the unsigned log window runs on the injected clock", async () => {
  let t = 1_000_000_000_000;
  const { _resetPeerRelayLog } = await import("../servers/gateway/routes/peer-relay.js");
  _resetPeerRelayLog();
  const r = await routerWith({ createDbClient: () => createDbClient(dbPath), deps: {
    getCreds: (id) => ({ auth_token: PEER_TOKENS[id] }), keyLookup: () => null, localId: () => LOCAL, now: () => t,
  } });
  const cap = captureErrors();
  const CALL = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "crow_store_memory", arguments: { content: "x" } } };
  const send = () => fetch(`${r.base}/peer-relay/${CHARLIE}/memory/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...good() }, body: JSON.stringify(CALL) }).then((x) => x.text());
  try {
    await send(); await send();
    t += 3_600_001; // past the hour on the injected clock only
    await send();
  } finally { cap.restore(); await r.close(); }
  assert.equal(cap.lines.filter((l) => l.startsWith("[peer-relay] forwarding unsigned")).length, 2, cap.lines.join("\n"));
});
