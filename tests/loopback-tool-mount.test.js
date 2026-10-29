/**
 * The shared loopback MCP mount (servers/gateway/loopback-tool-mount.js),
 * end to end on a bare express app with ONE test-only example mount
 * ("example-tools", ":uuid", actor kind "service"): a fresh init-db database,
 * a real path-scoped family token, the real per-boot scope key, real v3
 * signatures, and a fake upstream that records every call. The socket is
 * loopback because the test fetches 127.0.0.1; "not local" is driven with a
 * forwarding header and with CROW_TRUSTED_PROXIES.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDbClient } from "../servers/db.js";
import { SessionManager } from "../servers/gateway/session-manager.js";
import { currentCaller } from "../servers/gateway/caller-context.js";
import {
  pathScopedToken, SATELLITE_TOOLS_TOKEN, generateLocalToken, generateBoardToken, generatePeerRelayToken,
  generatePhoneToken, generateModelsToken, generateArtifactsToken, rotateLlmCloudToken,
} from "../servers/gateway/local-token.js";
import {
  initGatewayActorKey, _resetActorKeyForTest, signScopeActor, signActor, signPeerRelayActor, verifyScopeActorSig,
} from "../scripts/pi-bots/actor-sig.mjs";
import {
  mountLoopbackMcp, loopbackErrorText, LOOPBACK_ERROR_TEXT, _buildLoopbackServerForTest,
} from "../servers/gateway/loopback-tool-mount.js";

const UUID = "11111111-2222-4333-8444-555555555555";
const PATH = `/example-tools/${UUID}/mcp`;
const SECRET = "secret-1-long";
// main's redactSecrets default floor (MIN_SECRET_LENGTH 4): SHORT4 is redacted, SHORT3 is not.
const SHORT4 = "Zq7w";
const SHORT3 = "Qx3";
const TIMEOUT_MS = 400;

let dir, dbPath, srv, base, sessions, TOKEN, savedDbPath;
const SESS = {};
const tokens = {};
const audit = [];
const calls = [];          // every upstream.callTool: { name, args, meta, caller, signal }
const state = {};          // knobs the authorize / upstream read
const resetState = () => Object.assign(state, { deny: null, initFail: null, hide: new Set(["hidden"]), release: null, started: 0, stuck: [] });

const EXAMPLE_TOKEN = () => pathScopedToken({
  name: "example-tools", hashKey: "mcp_example_tools_token_hash", createdKey: "mcp_example_tools_token_created", home: dir,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await sleep(5); } };

const TOOLS = [
  { name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "who", description: "who", inputSchema: { type: "object", properties: {} } },
  { name: "hidden", description: "filtered", inputSchema: { type: "object", properties: {} } },
  { name: "boom", description: "throws", inputSchema: { type: "object", properties: {} } },
  { name: "boom_code", description: "throws a code", inputSchema: { type: "object", properties: {} } },
  { name: "iserr", description: "isError", inputSchema: { type: "object", properties: {} } },
  { name: "usertext", description: "userText", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "big", inputSchema: { type: "object", properties: { n: { type: "number" } } } },
  { name: "image", description: "image", inputSchema: { type: "object", properties: { n: { type: "number" } } } },
  { name: "mixed", description: "resource item", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "waits for its signal", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "waits for release", inputSchema: { type: "object", properties: {} } },
  { name: "leaky", description: "fields outside the allowlist", inputSchema: { type: "object", properties: {} } },
  { name: "stuck", description: "ignores its signal", inputSchema: { type: "object", properties: {} } },
  { name: "typed", description: "a required number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } },
];

const upstream = {
  listTools: async () => TOOLS,
  onInitialize: async () => {
    if (state.initFail === "throw") throw new Error(`child gone ${SECRET}`);
    if (state.initFail) return { code: state.initFail };
  },
  callTool: async (ctx, name, args, { signal, meta }) => {
    const rec = { name, args, meta, caller: currentCaller(), signal, ctx };
    calls.push(rec);
    switch (name) {
      case "echo": return { content: [{ type: "text", text: `ECHO ${args.text}` }], structuredContent: { leak: SECRET } };
      case "who": return { content: [{ type: "text", text: JSON.stringify(currentCaller()) }] };
      case "hidden": return { content: [{ type: "text", text: "should never run" }] };
      case "boom": throw new Error(`exploded with ${SECRET} inside`);
      case "boom_code": throw Object.assign(new Error(`down ${SECRET}`), { code: "unreachable" });
      case "iserr": return { isError: true, content: [{ type: "text", text: `failed near ${SECRET}` }] };
      case "usertext": return { content: [{ type: "text", text: "fine" }], userText: "USERTEXT-LEAK", message: "MESSAGE-LEAK" };
      case "big": return { content: [{ type: "text", text: "x".repeat(args.n) }] };
      case "image": return { content: [{ type: "text", text: "pic" }, { type: "image", mimeType: "image/png", data: "A".repeat(args.n) }] };
      case "leaky": return { content: [
        { type: "text", text: "kept", _meta: { note: SECRET }, annotations: { audience: [SECRET] } },
        { type: "resource", resource: { uri: `file:///${SECRET}`, text: `body ${SECRET}` } },
        { type: "weird", text: SECRET },
        { type: "image", mimeType: "text/html", data: "QUJD" },
        { type: "image", mimeType: "image/png", data: "not base64 at all!" },
        { type: "image", mimeType: "image/png", data: "QUJD", _meta: { s: SECRET }, annotations: { a: SECRET } },
      ], structuredContent: { s: SECRET }, _meta: { s: SECRET } };
      case "stuck": return await new Promise((res) => { state.stuck.push(() => res({ content: [{ type: "text", text: "late" }] })); });
      case "typed": return { content: [{ type: "text", text: `n=${args.n}` }] };
      case "mixed": return { content: [{ type: "text", text: "kept" }, { type: "resource", resource: { uri: "file:///x", text: "dropped" } }] };
      case "slow": return await new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true }));
      case "hang": state.started++; return await new Promise((res, rej) => {
        signal.addEventListener("abort", () => rej(signal.reason), { once: true });
        state.release = () => res({ content: [{ type: "text", text: "released" }] });
      });
      default: throw new Error("unknown");
    }
  },
};

async function authorize({ db, req, params, actor }) {
  assert.ok(db && typeof db.execute === "function", "authorize gets the db");
  if (state.deny === "throw") throw new Error(`authorize blew up ${SECRET}`);
  if (state.deny === "null") return null;
  if (state.deny) return { ok: false, code: state.deny };
  // A per-request value, so a test can tell the live ctx from a closure.
  const nonce = req.headers["x-test-nonce"] || null;
  return { ok: true, ctx: { secrets: [SECRET, SHORT4, SHORT3], uuid: params.uuid, botId: actor.botId, nonce } };
}

const toolFilter = (ctx, tool) => !state.hide.has(tool.name) && !(ctx.nonce === "deny-echo" && tool.name === "echo");

function mountOpts(over = {}) {
  return {
    family: "example-tools", params: ":uuid", actorKind: "service", token: EXAMPLE_TOKEN(), authorize, upstream, toolFilter,
    resultCap: { maxBytes: 4096, contentTypes: ["text", "image"] }, callTimeoutMs: TIMEOUT_MS, maxInFlight: 2,
    onAudit: (e) => audit.push(e), sessionManager: sessions, createDbClient: () => createDbClient(dbPath), ...over,
  };
}

// ---- actors ----
const jobActor = (botId = "hank", jobId = "job-own-1", tuple = { threadId: `job-${jobId}`, gatewayType: "job" }) => ({
  kind: "service", botId, scope: `j:${jobId}`, ...tuple, sig: signScopeActor({ kind: "service", botId, jobId, ...tuple }),
});
const sessActor = (name = "live", botId = "hank", threadId = "t-100", gatewayType = "gmail") => ({
  kind: "service", botId, scope: `s:${SESS[name]}`, threadId, gatewayType, sig: signScopeActor({ kind: "service", botId, sessionId: SESS[name], threadId, gatewayType }),
});
function actorHeaders(a) {
  const h = {};
  const set = (k, v) => { if (v !== undefined && v !== null) h[k] = String(v); };
  set("x-crow-actor-kind", a.kind); set("x-crow-actor-id", a.botId); set("x-crow-actor-scope", a.scope);
  set("x-crow-actor-thread", a.threadId); set("x-crow-actor-gateway", a.gatewayType); set("x-crow-actor-sig", a.sig);
  return h;
}

// ---- HTTP client ----
let rpcId = 0;
async function send(body, o = {}) {
  const headers = {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
    ...(o.actor === null ? {} : actorHeaders(o.actor ?? jobActor())),
    ...(o.sid ? { "mcp-session-id": o.sid } : {}),
    ...(o.headers || {}),
  };
  const res = await fetch(base + (o.path ?? PATH), {
    method: o.method ?? "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal,
  });
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
async function open(actor, o = {}) {
  const r = await send(initBody(), { actor, ...o });
  assert.equal(r.status, 200, `initialize: ${r.status} ${r.text}`);
  assert.ok(r.sid, "a session id");
  return r.sid;
}
const listTools = (sid, o = {}) => send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }, { sid, ...o });
const callTool = (sid, name, args = {}, o = {}) =>
  send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args, ...(o.meta ? { _meta: o.meta } : {}) } }, { sid, ...o });
const textOf = (r) => r.json?.result?.content?.map((c) => c.text).join("\n");

const assertEmpty404 = (r, msg) => { assert.equal(r.status, 404, msg); assert.equal(r.text, "", `${msg}: empty body`); };

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  dir = mkdtempSync(join(tmpdir(), "loopback-mount-"));
  dbPath = join(dir, "crow.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: dbPath }, cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  const d = new Database(dbPath);
  d.exec("ALTER TABLE bot_jobs ADD COLUMN principal TEXT"); // arrives with a later migration
  const bot = d.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?, ?, '{}', 1, ?)");
  bot.run("hank", "Hank", 42);
  bot.run("otto", "Otto", null);
  const ins = d.prepare("INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, status, archived_at) VALUES (?, ?, ?, ?, ?)");
  for (const [name, b, gw, thread, status, archived] of [
    ["live", "hank", "gmail", "t-100", "active", null], ["archived", "hank", "gmail", "t-102", "active", "2026-10-01 00:00:00"],
    ["other", "hank", "gmail", "t-104", "active", null],
  ]) SESS[name] = String(ins.run(b, gw, thread, status, archived).lastInsertRowid);
  const job = d.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, worker_pid, card_id, principal) VALUES (?, ?, 'g', ?, ?, ?, 'owner')");
  job.run("job-own-1", "hank", "running", process.pid, null);
  job.run("job-fin-1", "hank", "completed", process.pid, null);
  job.run("job-card-1", "hank", "running", process.pid, 5);
  job.run("job-otto-1", "otto", "running", process.pid, null);
  d.close();

  // The session logger (createMcpHandler) writes to CROW_DB_PATH: point it at this database.
  savedDbPath = process.env.CROW_DB_PATH;
  process.env.CROW_DB_PATH = dbPath;
  _resetActorKeyForTest();
  initGatewayActorKey();
  const db = createDbClient(dbPath);
  TOKEN = await EXAMPLE_TOKEN().rotate(db);
  tokens.local = await generateLocalToken(db);
  tokens.board = await generateBoardToken(db);
  tokens.relay = await generatePeerRelayToken(db);
  tokens.otherFamily = await SATELLITE_TOOLS_TOKEN.rotate(db);
  // The file-backed doors write their raw token under the crow home: keep them in this test's dir.
  const savedHome = process.env.CROW_HOME;
  process.env.CROW_HOME = dir;
  try {
    tokens.phone = await generatePhoneToken(db);
    tokens.models = await generateModelsToken(db);
    tokens.artifacts = await generateArtifactsToken(db);
    tokens.cloudDoor = await rotateLlmCloudToken(db);
  } finally {
    if (savedHome === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = savedHome;
  }
  db.close();

  sessions = new SessionManager();
  const app = express();
  // Test seam: a request that came through the instance / cross-host auth paths.
  app.use((req, _res, next) => {
    if (req.headers["x-test-instance-auth"]) req.instanceAuth = { instance: { id: "peer-1" } };
    if (req.headers["x-test-cross-host"]) req.crossHostAuth = { host: "peer-1" };
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  mountLoopbackMcp(app, mountOpts());
  await new Promise((r) => { srv = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  try { await sessions.closeAll(); } catch {}
  sessions?.dispose();
  await new Promise((r) => (srv ? srv.close(r) : r()));
  srv?.closeAllConnections?.();
  _resetActorKeyForTest();
  if (savedDbPath === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = savedDbPath;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { resetState(); calls.length = 0; audit.length = 0; });

// ---------------------------------------------------------------- mount time

test("mount-time validation: required options, family shape, kind, exactly one of token/validateToken", () => {
  const app = express();
  assert.doesNotThrow(() => mountLoopbackMcp(app, mountOpts({ family: "example-two" })));
  assert.doesNotThrow(() => mountLoopbackMcp(app, mountOpts({ family: "example-three", token: undefined, validateToken: async () => false })));
  const bad = [
    { family: "Bad" }, { family: "x" }, { family: "a/b" }, { params: "" }, { params: undefined },
    { actorKind: "bot" }, { actorKind: "satellite-tools" }, { actorKind: undefined },
    { token: undefined }, { validateToken: async () => true }, { token: {} },
    { authorize: undefined }, { upstream: {} }, { upstream: { listTools() {} } }, { toolFilter: undefined },
    { resultCap: undefined }, { resultCap: { maxBytes: 0, contentTypes: ["text"] } }, { resultCap: { maxBytes: 10 } },
    { callTimeoutMs: undefined }, { callTimeoutMs: 0 }, { maxInFlight: 0 }, { sessionManager: undefined }, { createDbClient: undefined },
    { onAudit: "nope" },
  ];
  for (const b of bad) assert.throws(() => mountLoopbackMcp(app, mountOpts(b)), TypeError, JSON.stringify(Object.keys(b)) + JSON.stringify(b));
  // maxInFlight defaults (omitted is fine)
  assert.doesNotThrow(() => mountLoopbackMcp(app, mountOpts({ family: "example-four", maxInFlight: undefined })));
});

test("the error table: en + es, every code, KiB and tool substitution", () => {
  assert.equal(loopbackErrorText("unattributed"), "A signed bot is required.");
  for (const c of ["not_owner_turn", "scope_unknown", "wrong_project", "not_selected", "owner_mismatch", "not_granted"]) assert.equal(loopbackErrorText(c), "Not available on this turn.");
  assert.equal(loopbackErrorText("not_active"), "This connection is turned off.");
  assert.equal(loopbackErrorText("busy"), "Busy, try again in a moment.");
  assert.equal(loopbackErrorText("child_unavailable"), "This service isn't running right now.");
  assert.equal(loopbackErrorText("not_installed"), "This service isn't running right now.");
  assert.equal(loopbackErrorText("unreachable"), "The server is unreachable.");
  assert.equal(loopbackErrorText("tools_changed"), "These tools changed; approve them on the Servers page.");
  assert.equal(loopbackErrorText("timeout"), "Timed out after 60 s. It may still have finished; check before trying again.");
  assert.equal(loopbackErrorText("too_large", { kib: 300 }), "Result too large (300 KiB).");
  assert.equal(loopbackErrorText("whatever", { tool: "echo" }), "echo failed.");
  assert.equal(loopbackErrorText("unattributed", { lang: "es" }), "Se requiere un bot firmado.");
  assert.equal(loopbackErrorText("whatever", { tool: "echo", lang: "es" }), "echo falló.");
  assert.deepEqual(Object.keys(LOOPBACK_ERROR_TEXT.en).sort(), Object.keys(LOOPBACK_ERROR_TEXT.es).sort(), "es covers every en code");
});

// ---------------------------------------------------------------- gate

test("a method other than POST/GET/DELETE is 405", async () => {
  const r = await send(initBody(), { method: "PUT" });
  assert.equal(r.status, 405);
  assert.equal(calls.length, 0);
});

test("not local: a forwarding header, instanceAuth, crossHostAuth, a CROW_TRUSTED_PROXIES loopback socket -> 404 empty, upstream untouched", async () => {
  assertEmpty404(await send(initBody(), { headers: { "x-forwarded-for": "100.64.20.5" } }), "forwarded");
  assertEmpty404(await send(initBody(), { headers: { "tailscale-user-login": "alex@example.com" } }), "tailscale header");
  assertEmpty404(await send(initBody(), { headers: { "x-test-instance-auth": "1" } }), "instanceAuth");
  assertEmpty404(await send(initBody(), { headers: { "x-test-cross-host": "1" } }), "crossHostAuth");
  const saved = process.env.CROW_TRUSTED_PROXIES;
  try {
    process.env.CROW_TRUSTED_PROXIES = "loopback";
    assertEmpty404(await send(initBody()), "trusted-proxy loopback socket");
  } finally {
    if (saved === undefined) delete process.env.CROW_TRUSTED_PROXIES; else process.env.CROW_TRUSTED_PROXIES = saved;
  }
  assert.equal(calls.length, 0, "upstream untouched");
  assert.ok(audit.every((e) => e.outcome === "refused:not_found"));
});

test("token x door: only this family's token opens the mount; every other token or none -> 401", async () => {
  const others = {
    local: tokens.local, board: tokens.board, relay: tokens.relay, otherFamily: tokens.otherFamily,
    phone: tokens.phone, models: tokens.models, artifacts: tokens.artifacts, cloudDoor: tokens.cloudDoor, random: "f".repeat(64),
  };
  for (const [name, t] of Object.entries(others)) assert.match(t, /^[0-9a-f]{64}$/, `${name} minted`);
  for (const [name, t] of Object.entries(others)) {
    const r = await send(initBody(), { token: t });
    assert.equal(r.status, 401, name);
    assert.equal(r.json?.jsonrpc, "2.0", `${name}: JSON-RPC shaped`);
    assert.ok(r.json?.error?.message, name);
  }
  assert.equal((await send(initBody(), { token: null })).status, 401, "no token");
  assert.equal((await send(initBody(), { headers: { authorization: `Basic ${TOKEN}` }, token: null })).status, 401, "not a bearer");
  assert.equal(calls.length, 0);
  assert.ok(audit.length >= 11 && audit.every((e) => e.outcome === "refused:bad_token"));
});

test("signatures: missing, other kind, v1, v2 peer-relay, s:12 signed / s:13 sent, archived session, finished job, foreign card tuple -> 403", async () => {
  const live = sessActor("live");
  const other = sessActor("other", "hank", "t-104", "gmail");
  const v1 = signActor({ kind: "bot", botId: "hank", threadId: "t-100", gatewayType: "gmail" });
  const v2 = signPeerRelayActor({ botId: "hank", sessionId: SESS.live, threadId: "t-100", gatewayType: "gmail" });
  assert.ok(v1 && v2, "v1/v2 signatures exist under the v1/v2 key");
  const cases = {
    missingSig: { ...jobActor(), sig: undefined },
    otherKind: { ...jobActor(), kind: "bot" },
    v1AsBot: { kind: "bot", botId: "hank", threadId: "t-100", gatewayType: "gmail", sig: v1 },
    v1AsService: { ...live, sig: v1 },
    v2AsPeerRelay: { kind: "peer-relay", botId: "hank", scope: live.scope, threadId: "t-100", gatewayType: "gmail", sig: v2 },
    v2AsService: { ...live, sig: v2 },
    swappedScope: { ...live, scope: other.scope }, // s:<live> signed, s:<other> sent
    archived: sessActor("archived", "hank", "t-102", "gmail"),
    finishedJob: jobActor("hank", "job-fin-1"),
    foreignCard: jobActor("hank", "job-card-1", { threadId: "board-card-6", gatewayType: "board" }),
    wrongBot: { ...jobActor(), botId: "otto" },
  };
  for (const [name, a] of Object.entries(cases)) {
    const r = await send(initBody(), { actor: a });
    assert.equal(r.status, 403, name);
    assert.equal(r.json?.error?.message, "A signed bot is required.", name);
  }
  // The positive controls: the right card tuple, a live session, a running job.
  for (const a of [jobActor("hank", "job-card-1", { threadId: "board-card-5", gatewayType: "board" }), live, jobActor()]) await open(a);
  assert.equal(calls.length, 0);
});

test("a valid v3 signature for one bot naming ANOTHER bot's running owner job -> 403 unattributed", async () => {
  // hank signs j:job-otto-1 under the real scope key: the signature verifies,
  // but the job belongs to otto, so the scope never resolves to hank.
  const a = jobActor("hank", "job-otto-1");
  assert.equal(verifyScopeActorSig(a), true, "the signature itself is valid");
  const r = await send(initBody(), { actor: a });
  assert.equal(r.status, 403);
  assert.equal(r.json?.error?.message, "A signed bot is required.");
  assert.equal(calls.length, 0, "upstream untouched");
  assert.ok(audit.some((e) => e.outcome === "refused:unattributed"), JSON.stringify(audit));
  // The positive control: otto's own signature for the same job opens.
  await open(jobActor("otto", "job-otto-1"));
});

test("a throw in each gate step is that step's refusal, never a 500", async () => {
  const app = express();
  app.use(express.json());
  const sm = new SessionManager();
  const knobs = { tokenThrow: false, verifyThrow: false, resolveThrow: false };
  mountLoopbackMcp(app, mountOpts({
    family: "example-throws", sessionManager: sm,
    token: { validate: async (db, t) => { if (knobs.tokenThrow) throw new Error("x"); return t === TOKEN; } },
    deps: {
      verifyScopeActorSig: (a) => { if (knobs.verifyThrow) throw new Error("x"); return true; },
      resolveSignedScope: async () => { if (knobs.resolveThrow) throw new Error("x"); return { scope: "job", id: "job-own-1", botId: "hank", threadId: "job-job-own-1", gatewayType: "job", defProjectId: 42, principal: "owner" }; },
    },
  }));
  const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const path = `/example-throws/${UUID}/mcp`;
  const at = (o = {}) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, ...actorHeaders(jobActor()), ...o },
    body: JSON.stringify(initBody()),
  });
  try {
    knobs.tokenThrow = true; assert.equal((await at()).status, 401, "validateToken throws -> 401"); knobs.tokenThrow = false;
    knobs.verifyThrow = true; assert.equal((await at()).status, 403, "verify throws -> 403"); knobs.verifyThrow = false;
    knobs.resolveThrow = true; assert.equal((await at()).status, 403, "resolve throws -> 403"); knobs.resolveThrow = false;
    state.deny = "throw";
    const r = await at();
    assert.equal(r.status, 403, "authorize throws -> 403");
    const body = await r.text();
    assert.ok(!body.includes(SECRET), "the thrown message never reaches the caller");
    state.deny = null;
    const ok = await at();
    assert.equal(ok.status, 200, "and with nothing throwing it opens");
    await ok.text();
  } finally {
    await sm.closeAll(); sm.dispose();
    await new Promise((r) => s.close(r)); s.closeAllConnections?.();
  }
});

test("a JSON-RPC batch is 400 (-32600)", async () => {
  const r = await send([initBody(), { jsonrpc: "2.0", id: 99, method: "tools/list" }]);
  assert.equal(r.status, 400);
  assert.equal(r.json?.error?.code, -32600);
  assert.equal(calls.length, 0);
});

test("Spanish text via Accept-Language", async () => {
  const r = await send(initBody(), { actor: { ...jobActor(), sig: undefined }, headers: { "accept-language": "es-MX,es;q=0.9" } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.message, "Se requiere un bot firmado.");
  const sid = await open(jobActor());
  state.hide.add("echo");
  const t = await callTool(sid, "echo", { text: "x" }, { headers: { "accept-language": "es" } });
  assert.equal(t.json.result.isError, true);
  assert.equal(textOf(t), "No disponible en este turno.");
});

// ---------------------------------------------------------------- MCP sessions

test("sessions are bound to bot + scope: another bot's session id -> 404, the same bot under another scope -> 404", async () => {
  const sid = await open(jobActor());
  assert.equal((await listTools(sid)).status, 200, "the opener can use it");
  assertEmpty404(await listTools(sid, { actor: jobActor("otto", "job-otto-1") }), "another bot");
  assertEmpty404(await listTools(sid, { actor: sessActor("live") }), "same bot, other scope");
  assertEmpty404(await callTool(sid, "echo", { text: "x" }, { actor: jobActor("otto", "job-otto-1") }), "another bot's call");
  assert.equal(calls.length, 0);
  // GET / DELETE are bound the same way
  assertEmpty404(await send(undefined, { method: "DELETE", sid, actor: jobActor("otto", "job-otto-1") }), "DELETE by another bot");
  const del = await send(undefined, { method: "DELETE", sid });
  assert.equal(del.status, 200, "the opener can close it");
});

test("authorize runs on every request: refusal at initialize and later inside an open session", async () => {
  for (const [code, status, msg] of [
    ["not_active", 409, "This connection is turned off."], ["not_owner_turn", 403, "Not available on this turn."],
    ["something_new", 403, "Not available on this turn."], ["null", 403, "Not available on this turn."], ["throw", 403, "Not available on this turn."],
  ]) {
    state.deny = code;
    const r = await send(initBody());
    assert.equal(r.status, status, code);
    assert.equal(r.json?.error?.message, msg, code);
  }
  state.deny = "not_found";
  assertEmpty404(await send(initBody()), "not_found is an empty 404");
  state.deny = null;
  const sid = await open(jobActor());
  state.deny = "not_active";
  const r = await callTool(sid, "echo", { text: "x" });
  assert.equal(r.status, 409, "flipped inside an open session");
  assert.equal(calls.length, 0, "refused before any upstream work");
  state.deny = null;
  assert.equal(textOf(await callTool(sid, "echo", { text: "x" })), "ECHO x");
});

test("onInitialize failing -> 502 with the fixed text (throw or {code}); nothing leaks", async () => {
  for (const f of ["throw", "child_unavailable", "not_installed"]) {
    state.initFail = f;
    const r = await send(initBody());
    assert.equal(r.status, 502, f);
    assert.equal(r.json?.error?.message, "This service isn't running right now.", f);
    assert.ok(!r.text.includes(SECRET));
  }
});

// ---------------------------------------------------------------- tool calls

test("the tool filter applies on tools/list and on every tools/call (live context)", async () => {
  const sid = await open(jobActor());
  let names = (await listTools(sid)).json.result.tools.map((t) => t.name);
  assert.ok(names.includes("echo") && !names.includes("hidden"), "hidden filtered at list");
  // Hidden when the session opened: still refused with the fixed text, and audited.
  const r = await callTool(sid, "hidden");
  assert.equal(r.json.result.isError, true);
  assert.equal(textOf(r), "Not available on this turn.");
  assert.ok(audit.some((e) => e.tool === "hidden" && e.outcome === "refused:not_granted"), "hidden call audited");
  // and un-hiding it inside the session makes it callable (registered, filtered live)
  state.hide.delete("hidden");
  assert.ok((await listTools(sid)).json.result.tools.some((t) => t.name === "hidden"), "listed once the filter passes");
  assert.equal(textOf(await callTool(sid, "hidden")), "should never run");
  calls.length = 0;
  state.hide.add("hidden");
  // flip the filter inside the open session: list and call follow the live ctx
  state.hide.add("echo");
  names = (await listTools(sid)).json.result.tools.map((t) => t.name);
  assert.ok(!names.includes("echo"), "echo now filtered at list");
  assert.equal(textOf(await callTool(sid, "echo", { text: "x" })), "Not available on this turn.");
  assert.equal(calls.length, 0, "a filtered tool never reaches the upstream");
  assert.ok(audit.some((e) => e.tool === "echo" && e.outcome === "refused:not_granted"));
});

test("_meta crow.dev/* keys are stripped from request meta and args before the upstream sees them", async () => {
  const sid = await open(jobActor());
  const r = await callTool(sid, "echo", { text: "m", _meta: { "crow.dev/caller": "owner", keep: 1 } }, { meta: { "crow.dev/actor": "forged", progressToken: 7, other: "ok" } });
  assert.equal(textOf(r), "ECHO m");
  const c = calls.at(-1);
  assert.equal(c.meta["crow.dev/actor"], undefined);
  assert.equal(c.meta.other, "ok");
  assert.equal(c.args._meta?.["crow.dev/caller"], undefined);
  assert.equal(c.args._meta?.keep, 1);
  assert.equal(Object.keys(c.meta).some((k) => k.startsWith("crow.dev/")), false);
});

test("the upstream sees the ALS caller store; without one the call is refused and the upstream untouched", async () => {
  const sid = await open(jobActor());
  await callTool(sid, "who");
  const caller = calls.at(-1).caller;
  assert.equal(caller.caller, "bot:hank");
  assert.equal(caller.botId, "hank");
  assert.equal(caller.peer, false);
  assert.equal(caller.crossHost, false);
  assert.equal(caller.family, "example-tools");
  assert.equal(caller.scopeRef, "j:job-own-1");
  assert.equal(caller.projectId, 42);
  assert.equal(caller.ctx.uuid, UUID);
  // Outside any request (no ALS store): refused, upstream untouched.
  calls.length = 0;
  const server = await _buildLoopbackServerForTest(mountOpts(), { secrets: [] });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  const r = await client.callTool({ name: "echo", arguments: { text: "x" } });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "A signed bot is required.");
  assert.equal(calls.length, 0);
  await client.close();
});

test("caps: content types dropped with a note; images count toward the byte cap", async () => {
  const sid = await open(jobActor());
  const mixed = await callTool(sid, "mixed");
  const items = mixed.json.result.content;
  assert.equal(items.some((c) => c.type === "resource"), false, "resource item dropped");
  assert.equal(items[0].text, "kept");
  assert.equal(items.length, 2, "one note line added");
  assert.match(items[1].text, /1 item/);
  const okImg = await callTool(sid, "image", { n: 1000 });
  assert.equal(okImg.json.result.isError, undefined);
  assert.equal(okImg.json.result.content[1].type, "image");
  const bigImg = await callTool(sid, "image", { n: 6000 });
  assert.equal(bigImg.json.result.isError, true);
  assert.match(textOf(bigImg), /^Result too large \(\d+ KiB\)\.$/);
  const big = await callTool(sid, "big", { n: 8000 });
  assert.equal(textOf(big), "Result too large (8 KiB).");
  assert.ok(audit.some((e) => e.tool === "big" && e.outcome === "error:too_large"));
});

test("timeout -> the fixed timeout text; disconnect aborts the upstream signal", async () => {
  const sid = await open(jobActor());
  const t0 = Date.now();
  const r = await callTool(sid, "slow");
  assert.ok(Date.now() - t0 >= TIMEOUT_MS - 20, "waited for the timeout");
  assert.equal(r.json.result.isError, true);
  assert.equal(textOf(r), `Timed out after ${TIMEOUT_MS / 1000} s. It may still have finished; check before trying again.`);
  assert.equal(calls.at(-1).signal.aborted, true);
  assert.ok(audit.some((e) => e.tool === "slow" && e.outcome === "error:timeout"));

  calls.length = 0;
  const ac = new AbortController();
  const p = callTool(sid, "slow", {}, { signal: ac.signal }).catch((e) => e);
  await until(() => calls.length === 1);
  const started = Date.now();
  ac.abort();
  await p;
  await until(() => calls[0].signal.aborted, TIMEOUT_MS);
  assert.ok(Date.now() - started < TIMEOUT_MS, "aborted by the disconnect, not the timeout");
  assert.notEqual(calls[0].signal.reason?.name, "TimeoutError");
});

test("in-flight cap per mount key -> busy", async () => {
  const sid = await open(jobActor());
  const a = callTool(sid, "hang");
  const b = callTool(sid, "hang");
  await until(() => state.started === 2);
  const c = await callTool(sid, "echo", { text: "third" });
  assert.equal(c.json.result.isError, true);
  assert.equal(textOf(c), "Busy, try again in a moment.");
  assert.equal(calls.filter((x) => x.name === "echo").length, 0, "the busy call never reached the upstream");
  await Promise.all([a, b]); // both end at the timeout
  assert.equal(textOf(await callTool(sid, "echo", { text: "after" })), "ECHO after", "slots free again");
});

test("errors and redaction: a thrown secret -> '<tool> failed.'; known codes -> table text; isError and normal results redacted; userText ignored", async () => {
  const sid = await open(jobActor());
  const boom = await callTool(sid, "boom");
  assert.equal(boom.json.result.isError, true);
  assert.equal(textOf(boom), "boom failed.");
  assert.ok(!boom.text.includes(SECRET));
  const code = await callTool(sid, "boom_code");
  assert.equal(textOf(code), "The server is unreachable.");
  assert.ok(!code.text.includes(SECRET));
  const iserr = await callTool(sid, "iserr");
  assert.equal(iserr.json.result.isError, true);
  assert.equal(textOf(iserr), "failed near [redacted]");
  const echo = await callTool(sid, "echo", { text: `hi ${SECRET}` });
  assert.equal(textOf(echo), "ECHO hi [redacted]");
  assert.ok(!echo.text.includes(SECRET), "structuredContent is not passed through");
  const ut = await callTool(sid, "usertext");
  assert.equal(textOf(ut), "fine");
  assert.ok(!ut.text.includes("USERTEXT-LEAK") && !ut.text.includes("MESSAGE-LEAK"));
});

test("redaction uses the shared redactSecrets with its default floor: a 4-char secret is redacted, a 3-char one is not", async () => {
  const sid = await open(jobActor());
  const r = await callTool(sid, "echo", { text: `a ${SHORT4} b ${SHORT3} c` });
  assert.equal(textOf(r), `ECHO a [redacted] b ${SHORT3} c`);
});

test("audit: one event per tools/call and per refusal, never args, results, headers or tokens", async () => {
  const sid = await open(jobActor());
  await callTool(sid, "echo", { text: "PAYLOAD-xyz" });
  await callTool(sid, "boom");
  await send(initBody(), { token: "f".repeat(64) });
  const calls2 = audit.filter((e) => e.method === "tools/call");
  assert.equal(calls2.length, 2);
  const ok = calls2.find((e) => e.tool === "echo");
  assert.equal(ok.outcome, "ok");
  assert.equal(ok.family, "example-tools");
  assert.equal(ok.key, UUID);
  assert.equal(ok.botId, "hank");
  assert.equal(ok.scopeRef, "j:job-own-1");
  assert.equal(typeof ok.ms, "number");
  assert.ok(ok.bytes > 0);
  assert.equal(typeof ok.ts, "string");
  assert.equal(calls2.find((e) => e.tool === "boom").outcome, "error:failed");
  assert.ok(audit.some((e) => e.outcome === "refused:bad_token"));
  const allowed = new Set(["ts", "family", "key", "botId", "scopeRef", "method", "tool", "outcome", "ms", "bytes"]);
  for (const e of audit) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected audit key ${k}`);
  const dump = JSON.stringify(audit);
  for (const bad of ["PAYLOAD-xyz", "ECHO", SECRET, TOKEN, "exploded"]) assert.ok(!dump.includes(bad), `audit leaks ${bad}`);
});

test("the default audit sink (no onAudit): a refusal logs once, an ok call is counted on the session", async () => {
  const app = express();
  app.use(express.json());
  const sm = new SessionManager();
  mountLoopbackMcp(app, mountOpts({ family: "example-default", sessionManager: sm, onAudit: undefined }));
  const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const saved = base;
  const warn = console.warn;
  const warned = [];
  try {
    base = `http://127.0.0.1:${s.address().port}`;
    const p = `/example-default/${UUID}/mcp`;
    console.warn = (...a) => { warned.push(a.join(" ")); };
    assert.equal((await send(initBody(), { path: p, token: "f".repeat(64) })).status, 401);
    console.warn = warn;
    assert.deepEqual(warned, ["[example-default] refused: refused:bad_token"], "noteRefusedOnce ran");
    const sid = await open(jobActor(), { path: p });
    assert.equal(textOf(await callTool(sid, "echo", { text: "d" }, { path: p })), "ECHO d");
    await sm.closeAll();
    const db = new Database(dbPath, { readonly: true });
    let row;
    try {
      await until(() => (row = db.prepare("SELECT tool_call_count, tool_calls_summary FROM mcp_sessions WHERE session_id = ?").get(sid))?.tool_call_count != null);
    } finally { db.close(); }
    assert.equal(row.tool_call_count, 1, "recordToolCall counted the ok call");
    assert.deepEqual(JSON.parse(row.tool_calls_summary), { echo: 1 });
  } finally {
    console.warn = warn;
    base = saved;
    await sm.closeAll(); sm.dispose();
    await new Promise((r) => s.close(r)); s.closeAllConnections?.();
  }
});

// ---------------------------------------------------------------- fix round 1

test("S1: the in-flight slot is held until the upstream itself settles, not freed at the timeout", async () => {
  const sid = await open(jobActor());
  const a = callTool(sid, "stuck");
  const b = callTool(sid, "stuck");
  const [ra, rb] = await Promise.all([a, b]);
  assert.match(textOf(ra), /^Timed out after/);
  assert.match(textOf(rb), /^Timed out after/);
  assert.equal(state.stuck.length, 2, "both upstream calls are still running");
  const c = await callTool(sid, "echo", { text: "third" });
  assert.equal(textOf(c), "Busy, try again in a moment.", "abandoned-but-running calls still hold their slots");
  state.stuck.shift()();
  await sleep(20);
  assert.equal(textOf(await callTool(sid, "echo", { text: "freed" })), "ECHO freed", "a settled upstream frees its slot");
  state.stuck.shift()();
});

test("S2: results are rebuilt from an allowlist: no resource, unknown type, bad image, _meta or annotations reaches the client", async () => {
  const sid = await open(jobActor());
  const r = await callTool(sid, "leaky");
  assert.equal(r.status, 200);
  const res = r.json.result;
  assert.deepEqual(Object.keys(res).sort(), ["content"]);
  assert.deepEqual(res.content[0], { type: "text", text: "kept" });
  assert.deepEqual(res.content[1], { type: "image", mimeType: "image/png", data: "QUJD" });
  assert.equal(res.content.length, 3);
  assert.match(res.content[2].text, /^4 item/);
  for (const frag of [SECRET, "secret-1", "file:///", "weird", "text/html"]) assert.ok(!r.text.includes(frag), `leaks ${frag}`);
  assert.throws(() => mountLoopbackMcp(express(), mountOpts({ family: "example-res", resultCap: { maxBytes: 10, contentTypes: ["text", "resource"] } })), TypeError);
});

test("I2: tool calls read the LIVE request ctx, not the one the session opened with", async () => {
  const sid = await open(jobActor(), { headers: { "x-test-nonce": "n1" } });
  await callTool(sid, "echo", { text: "a" }, { headers: { "x-test-nonce": "n2" } });
  assert.equal(calls.at(-1).ctx.nonce, "n2", "the second request's ctx");
  assert.equal(calls.at(-1).caller.ctx.nonce, "n2");
  const names = (await listTools(sid, { headers: { "x-test-nonce": "deny-echo" } })).json.result.tools.map((t) => t.name);
  assert.ok(!names.includes("echo"), "a ctx-based filter hides it at list");
  calls.length = 0;
  const r = await callTool(sid, "echo", { text: "b" }, { headers: { "x-test-nonce": "deny-echo" } });
  assert.equal(textOf(r), "Not available on this turn.");
  assert.equal(calls.length, 0);
  assert.equal(textOf(await callTool(sid, "echo", { text: "c" }, { headers: { "x-test-nonce": "n3" } })), "ECHO c");
});

test("I3: a schema-validation failure gets the fixed text and an audit event", async () => {
  const sid = await open(jobActor());
  const r = await callTool(sid, "typed", { n: "not a number" });
  assert.equal(r.json.result.isError, true);
  assert.equal(textOf(r), "The arguments for typed are not valid.");
  assert.ok(audit.some((e) => e.tool === "typed" && e.outcome === "refused:invalid_args"));
  assert.equal(calls.length, 0);
  assert.equal(textOf(await callTool(sid, "typed", { n: 3 })), "n=3");
});

test("M2: the mount key encodes each param, so a/b + c and a + b/c never collide", async () => {
  const app = express();
  app.use(express.json());
  const sm = new SessionManager();
  mountLoopbackMcp(app, mountOpts({ family: "example-pair", params: ":a/:b", sessionManager: sm }));
  const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const saved = base;
  try {
    base = `http://127.0.0.1:${s.address().port}`;
    await send(initBody(), { path: "/example-pair/a%2Fb/c/mcp", token: "f".repeat(64) });
    await send(initBody(), { path: "/example-pair/a/b%2Fc/mcp", token: "f".repeat(64) });
    assert.deepEqual(audit.map((e) => e.key), ["a%2Fb/c", "a/b%2Fc"]);
  } finally {
    base = saved;
    sm.dispose();
    await new Promise((r) => s.close(r)); s.closeAllConnections?.();
  }
});

test("M1: no session store is created for a request authorize refuses", async () => {
  const sm = new SessionManager();
  const app = express();
  app.use(express.json());
  mountLoopbackMcp(app, mountOpts({ family: "example-peek", sessionManager: sm }));
  const s = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const saved = base;
  try {
    base = `http://127.0.0.1:${s.address().port}`;
    state.deny = "not_granted";
    assert.equal((await send(initBody(), { path: `/example-peek/${UUID}/mcp`, sid: "00000000-0000-4000-8000-000000000000" })).status, 403);
    assert.equal((await send(initBody(), { path: `/example-peek/${UUID}/mcp` })).status, 403);
    assert.equal(sm.stores.size, 0, "no store before authorize passes");
  } finally {
    base = saved;
    sm.dispose();
    await new Promise((r) => s.close(r)); s.closeAllConnections?.();
  }
});
