import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDbClient } from "../servers/db.js";
import { SessionManager } from "../servers/gateway/session-manager.js";
import { mountMcpServer } from "../servers/gateway/routes/mcp.js";
import { localTokenAuthMiddleware, generatePhoneToken, generateBoardToken } from "../servers/gateway/local-token.js";
import { initPhoneTables } from "../bundles/phone/server/init-tables.js";
import { createPhoneMcpServer, resolvePhoneActor, deliverToFromActor } from "../bundles/phone/server/mcp.js";
import { getCall } from "../bundles/phone/server/store.js";
import { crowServerCatalog } from "../scripts/pi-bots/crow-server-catalog.mjs";

const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR };
const s = {};

before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "phone-mcp-home-"));
  process.env.CROW_HOME = s.home; process.env.CROW_DATA_DIR = join(s.home, "data");
  s.db = createDbClient(join(s.home, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (key, instance_id));`);
  await initPhoneTables(s.db);
  s.phoneToken = await generatePhoneToken(s.db);
  s.boardToken = await generateBoardToken(s.db);
  const app = express();
  app.use(express.json());
  app.use(localTokenAuthMiddleware(s.db));
  const noAuth = (req, res) => res.status(401).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: "unauthorized" } });
  const sm = new SessionManager();
  mountMcpServer(app, "/phone", () => createPhoneMcpServer({ db: s.db, ownerNumber: "+15129372366" }), sm, noAuth);
  mountMcpServer(app, "/memory", () => new McpServer({ name: "stub", version: "0" }), sm, noAuth);
  s.http = app.listen(0); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
});

after(async () => {
  await new Promise((r) => s.http.close(r));
  try { s.db.close(); } catch {}
  rmSync(s.home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function client(path, token, headers = {}) {
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}${path}`),
    { requestInit: { headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } } });
  const c = new Client({ name: "phone-test", version: "0" }); await c.connect(t); return c;
}
const payload = (r) => JSON.parse(r.content[0].text);
const botHeaders = { "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": "bobby", "X-Crow-Actor-Thread": "discord:42", "X-Crow-Actor-Gateway": "discord" };
const args = { business_name: "Smile Dental", number: "512-555-0101", goal: "Book a cleaning", language: "en",
  limits: { days_of_week: ["tue"] }, shareable: { name: "Kevin" } };

test("phone token works on /phone/mcp only; board token does not", async () => {
  const c = await client("/phone/mcp", s.phoneToken, botHeaders);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["phone_call_result", "phone_call_status", "phone_cancel", "phone_plan_call"]);
  await c.close();
  await assert.rejects(client("/phone/mcp", s.boardToken));
  await assert.rejects(client("/memory/mcp", s.phoneToken));
});

test("phone_plan_call records the bot actor and deliver_to, never dials", async () => {
  const c = await client("/phone/mcp", s.phoneToken, botHeaders);
  const r = payload(await c.callTool({ name: "phone_plan_call", arguments: args }));
  assert.equal(r.status, "awaiting_approval");
  const row = await getCall(s.db, r.call_id);
  assert.equal(row.created_by.id, "bobby");
  assert.deepEqual(row.deliver_to, { kind: "gateway", gateway_type: "discord", gateway_thread_id: "discord:42" });
  assert.equal(row.status, "awaiting_approval");
  await c.close();
});

test("phone_plan_call rejects blocked numbers with a clear error", async () => {
  const c = await client("/phone/mcp", s.phoneToken, botHeaders);
  for (const number of ["911", "+19005551234", "512-937-2366"]) {
    const r = await c.callTool({ name: "phone_plan_call", arguments: { ...args, number } });
    assert.equal(r.isError, true, number);
  }
  await c.close();
});

test("phone_call_status never returns transcript text", async () => {
  const c = await client("/phone/mcp", s.phoneToken, botHeaders);
  const { call_id } = payload(await c.callTool({ name: "phone_plan_call", arguments: args }));
  await s.db.execute({ sql: "UPDATE phone_calls SET transcript_json = ? WHERE id = ?", args: [JSON.stringify([{ type: "farend", text: "secret" }]), call_id] });
  const st = payload(await c.callTool({ name: "phone_call_status", arguments: { call_id } }));
  assert.equal(JSON.stringify(st).includes("secret"), false);
  await c.close();
});

test("bot catalog includes /phone/mcp with bot, thread and gateway headers", () => {
  const home = mkdtempSync(join(tmpdir(), "phone-cat-"));
  writeFileSync(join(home, "phone-token"), "tok", { mode: 0o600 });
  const { servers } = crowServerCatalog(home, { botId: "bobby", threadId: "perch-7", gatewayType: "perch", gatewayPort: 3999 });
  assert.equal(servers.phone.url, "http://127.0.0.1:3999/phone/mcp");
  assert.equal(servers.phone.headers["X-Crow-Actor-Thread"], "perch-7");
  assert.equal(servers.phone.headers["X-Crow-Actor-Gateway"], "perch");
  rmSync(home, { recursive: true, force: true });
});

test("catalog: board token only -> board present, no unconfigured.board, no phone", () => {
  const home = mkdtempSync(join(tmpdir(), "phone-cat-b-"));
  writeFileSync(join(home, "board-token"), "btok", { mode: 0o600 });
  const { servers, unconfigured } = crowServerCatalog(home, { botId: "bobby" });
  assert.ok(servers.board);
  assert.equal(unconfigured.board, undefined);
  assert.equal(servers.phone, undefined);
  rmSync(home, { recursive: true, force: true });
});

test("catalog: phone token only -> phone present and board reason preserved", () => {
  const home = mkdtempSync(join(tmpdir(), "phone-cat-p-"));
  writeFileSync(join(home, "phone-token"), "tok", { mode: 0o600 });
  const { servers, unconfigured } = crowServerCatalog(home, { botId: "bobby" });
  assert.ok(servers.phone);
  assert.ok(unconfigured.board);
  rmSync(home, { recursive: true, force: true });
});

test("ownerNumber may be a function evaluated per call", async () => {
  let owner = "+15125550000";
  const app = express(); app.use(express.json());
  app.use(localTokenAuthMiddleware(s.db));
  const noAuth = (req, res) => res.status(401).json({});
  mountMcpServer(app, "/phone", () => createPhoneMcpServer({ db: s.db, ownerNumber: () => owner }), new SessionManager(), noAuth);
  const http = app.listen(0); await new Promise((r) => http.once("listening", r));
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/phone/mcp`),
    { requestInit: { headers: { ...botHeaders, Authorization: `Bearer ${s.phoneToken}` } } });
  const c = new Client({ name: "t", version: "0" }); await c.connect(t);
  const a2 = { ...args, number: "512-555-0199" };
  assert.notEqual((await c.callTool({ name: "phone_plan_call", arguments: a2 })).isError, true);
  owner = "+15125550199";
  assert.equal((await c.callTool({ name: "phone_plan_call", arguments: a2 })).isError, true);
  await c.close(); await new Promise((r) => http.close(r));
});

test("bot actors can only read their own calls; session actors read any", async () => {
  const bob = await client("/phone/mcp", s.phoneToken, botHeaders);
  const { call_id } = payload(await bob.callTool({ name: "phone_plan_call", arguments: args }));
  const other = await client("/phone/mcp", s.phoneToken, { ...botHeaders, "X-Crow-Actor-Id": "mallory" });
  for (const name of ["phone_call_status", "phone_call_result"]) {
    const r = await other.callTool({ name, arguments: { call_id } });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0].text, /forbidden/);
    assert.notEqual((await bob.callTool({ name, arguments: { call_id } })).isError, true, name);
  }
  const owner = await client("/phone/mcp", s.phoneToken);
  assert.notEqual((await owner.callTool({ name: "phone_call_status", arguments: { call_id } })).isError, true);
  await bob.close(); await other.close(); await owner.close();
});

test("resolvePhoneActor ignores actor headers from non-local auth; unknown gateway -> null", () => {
  const a = resolvePhoneActor({ authInfo: { clientId: "instance:abc" }, requestInfo: { headers: {
    "x-crow-actor-kind": "bot", "x-crow-actor-id": "evil", "x-crow-actor-thread": "discord:1", "x-crow-actor-gateway": "discord" } } });
  assert.equal(a.kind, "session");
  assert.equal(deliverToFromActor({ kind: "bot", id: "b", thread: "t", gateway: "gmail" }), null);
});
