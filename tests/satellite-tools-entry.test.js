// Satellite tool entry (SAT-7 part A, spec §5.3, §9.1, §9.2): the entry a satellite-hosted bundle
// contributes to connectedServers — prefix + pinned-list filtering, the pin/state refusals, the
// signed call with X-Crow-Sat-Caller, the 256 KiB text-only cap, the D22 `artifacts` refusal, and
// the local-tool-wins rule. A fake satellite fetch (tests/helpers/fake-satellite-mgmt.js) verifies
// every signature, so no socket is used.
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HOME = mkdtempSync(join(tmpdir(), "sattools-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "sattools-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const store = await import("../servers/gateway/satellites/store.js");
const TE = await import("../servers/gateway/satellites/tool-entry.js");
const { callerContext } = await import("../servers/gateway/caller-context.js");
const { connectedServers, createProxyServer } = await import("../servers/gateway/proxy.js");
const { createRouterServer } = await import("../servers/gateway/router.js");
const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
const { SessionManager } = await import("../servers/gateway/session-manager.js");
const { mountMcpServer } = await import("../servers/gateway/routes/mcp.js");
const { createMgmtFake, makeSatelliteRow, demoTools, toolsHash } = await import("./helpers/fake-satellite-mgmt.js");
const { createSatellitePoller } = await import("../servers/gateway/satellites/poller.js");

const OWNER = { caller: "owner-local", peer: false, crossHost: false, botId: null };
const asOwner = (fn) => callerContext.run(OWNER, fn);
const cb = (registered) => registered.callback || registered.handler;
const MCP_REQUESTS = (fake) => fake.state.requests.filter((r) => r.path.startsWith("/satellite/v1/mcp"));

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "sattools-db-"));
  dirs.push(dir);
  return createDbClient(join(dir, "crow.db"));
}

/** Route handler the fake satellite uses for tools/call (tools/list keeps the fake's default). */
function callRoutes(fake, seen) {
  fake.table["POST /satellite/v1/mcp/:bundle"] = ({ params, body, caller }) => {
    if (body.method === "tools/list") return { status: 200, json: { jsonrpc: "2.0", id: body.id, result: { tools: fake.state.tools[params.bundle] } } };
    const name = body.params?.name;
    seen.push({ bundle: params.bundle, name, caller });
    const ok = (result) => ({ status: 200, json: { jsonrpc: "2.0", id: body.id, result } });
    if (name === "demo_big") return ok({ content: [{ type: "text", text: "x".repeat(262200) }] });
    if (name === "demo_image") return ok({ content: [{ type: "image", mimeType: "image/png", data: "AAAA" }, { type: "text", text: "ok" }] });
    if (name === "demo_fail") return { status: 200, json: { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "upstream detail that must never be echoed" } } };
    return ok({ content: [{ type: "text", text: `ran ${name}` }] });
  };
}

function writeInstalled(list) {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(list, null, 2));
}

/** The extra tools every fixture pins (the cap, the image drop and the upstream error). */
const EXTRA_TOOLS = [
  { name: "demo_big", description: "big", inputSchema: { type: "object", properties: {} } },
  { name: "demo_image", description: "image", inputSchema: { type: "object", properties: {} } },
  { name: "demo_fail", description: "fails", inputSchema: { type: "object", properties: {} } },
];

/**
 * A paired satellite + one satellite-hosted bundle (`bundle`) whose pin is `pinned` (null: no pin),
 * installed.json already recorded, and the entry built by the real refresh.
 */
async function setup({
  bundle = "demo", pinned = demoTools(EXTRA_TOOLS), reported = undefined, servers = connectedServers,
  status = "active", unreachableSince = null, extraInstalled = [], log = () => {},
} = {}) {
  const db = freshDb();
  await db.executeMultiple(SATELLITE_DDL);
  const fake = createMgmtFake();
  const seen = [];
  callRoutes(fake, seen);
  // The satellite's own cached list is what it reports a hash for.
  if (pinned) fake.state.tools[bundle] = pinned;
  const { row } = await makeSatelliteRow(db, fake, { status });
  const pinnedJson = pinned === null ? null : JSON.stringify(pinned);
  const reportedJson = reported === undefined ? JSON.stringify(fake.statusBody()) : reported;
  await store.updateSatelliteStatus(db, fake.satId, {
    last_status_json: reportedJson === null ? null : JSON.stringify({ v: 1, polled_at: new Date().toISOString(), status: JSON.parse(reportedJson), health: null, error: null, alerts: { psi: false, tools: {} } }),
    ...(unreachableSince ? { unreachable_since: unreachableSince } : {}),
  });
  if (pinnedJson) {
    await store.putToolPin(db, {
      satellite_id: fake.satId, bundle, version: "1.0.0", tools_sha256: toolsHash(pinned), tools_json: pinnedJson, approved_at: "2026-11-01T00:00:00Z",
    });
  }
  writeInstalled([{ id: bundle, mode: "satellite", host: fake.satId, version: "1.0.0" }, ...extraInstalled]);
  const out = await TE.refreshSatelliteEntries({ db, dbFactory: () => db, servers, fetchImpl: fake.fetchImpl, log });
  return { db, fake, seen, row, entry: servers.get(bundle), out };
}

afterEach(() => { connectedServers.clear(); });

// ── entry building ─────────────────────────────────────────────────────────────────────────────

test("a satellite bundle gets one entry: isRemote false, isSatellite true, only prefix + pinned names", async () => {
  const { entry } = await setup();
  assert.ok(entry, "the entry exists");
  assert.equal(entry.isSatellite, true);
  assert.equal(entry.isRemote, false);
  assert.equal(entry.status, "connected");
  assert.deepEqual(entry.tools.map((t) => t.name).sort(), ["demo_big", "demo_create", "demo_fail", "demo_image", "demo_list"]);
  assert.equal(connectedServers.get("demo"), entry, "keyed by the bundle id");
});

test("a name without the bundle prefix is dropped, and so is a pinned name the pin does not list", async () => {
  const pinned = [...demoTools(), { name: "other_bundle_tool", description: "nope", inputSchema: { type: "object" } }];
  const { fake, entry } = await setup({ pinned });
  assert.deepEqual(entry.tools.map((t) => t.name).sort(), ["demo_create", "demo_list"], "other_bundle_tool is not `demo_*`");
  // A call to a name that is not published never reaches the network either.
  const before = fake.state.requests.length;
  const r = await asOwner(() => entry.client.callTool({ name: "other_bundle_tool", arguments: {} }));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /These tools changed; approve them on the Servers page\./);
  assert.equal(fake.state.requests.length, before, "no network call");
});

test("no pin row: no tools, and every call is refused before any network call", async () => {
  const { fake, entry } = await setup({ pinned: null });
  assert.deepEqual(entry.tools, []);
  const before = fake.state.requests.length;
  for (const name of ["demo_list", "demo_create"]) {
    const r = await asOwner(() => entry.client.callTool({ name, arguments: {} }));
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /These tools changed; approve them on the Servers page\./);
  }
  assert.equal(fake.state.requests.length, before);
});

test("a status tools entry with no sha256 (error entry) means no tools", async () => {
  const body = { ...fakeBody(), tools: { demo: { version: "1.0.0", error: "tools_too_large" } } };
  const { fake, entry } = await setup({ reported: JSON.stringify(body) });
  assert.deepEqual(entry.tools, []);
  const before = fake.state.requests.length;
  const r = await asOwner(() => entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(r.isError, true);
  assert.equal(fake.state.requests.length, before);
});

function fakeBody() {
  return createMgmtFake().statusBody();
}

test("the pin is what publishes: a later change empties nothing but refuses, and re-approval republishes", async () => {
  const { db, fake, row } = await setup();
  const entry = connectedServers.get("demo");
  assert.equal(entry.tools.length, 5);
  // The satellite reports a NEW hash: calls are refused (tools stay listed) and nothing is sent.
  const changed = [...demoTools(), { name: "demo_extra", description: "new", inputSchema: { type: "object" } }];
  await store.updateSatelliteStatus(db, fake.satId, {
    last_status_json: JSON.stringify({ v: 1, status: { ...fake.statusBody(), tools: { demo: { version: "1.0.0", sha256: toolsHash(changed) } } }, alerts: { psi: false, tools: {} } }),
  });
  await TE.refreshSatelliteEntries({ db, dbFactory: () => db, fetchImpl: fake.fetchImpl });
  assert.equal(connectedServers.get("demo"), entry, "the same entry object is refreshed in place");
  assert.equal(entry.tools.length, 5, "a changed hash does not silently drop the approved list");
  const before = fake.state.requests.length;
  const refused = await asOwner(() => entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /These tools changed/);
  assert.equal(fake.state.requests.length, before);
  // Re-approving the new list republishes the extra tool.
  await store.putToolPin(db, {
    satellite_id: fake.satId, bundle: "demo", version: "1.0.0", tools_sha256: toolsHash(changed), tools_json: JSON.stringify(changed), approved_at: "x",
  });
  fake.state.tools.demo = changed;
  await store.updateSatelliteStatus(db, row.id, {
    last_status_json: JSON.stringify({ v: 1, status: fake.statusBody(), alerts: { psi: false, tools: {} } }),
  });
  await TE.refreshSatelliteEntries({ db, dbFactory: () => db, fetchImpl: fake.fetchImpl });
  assert.deepEqual(entry.tools.map((t) => t.name).sort(), ["demo_create", "demo_extra", "demo_list"]);
});

// ── the refusals ──────────────────────────────────────────────────────────────────────────────

test("peer: true is refused BEFORE any fetch", async () => {
  const { fake, entry } = await setup();
  const before = fake.state.requests.length;
  const r = await callerContext.run({ caller: null, peer: true, crossHost: false, botId: null },
    () => entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "demo_list is not available here.");
  assert.equal(fake.state.requests.length, before, "not even /health was fetched");
});

test("no caller store (and a bot-less unknown caller) is refused before any fetch", async () => {
  const { fake, entry } = await setup();
  const before = fake.state.requests.length;
  const outside = await entry.client.callTool({ name: "demo_list", arguments: {} });
  assert.equal(outside.isError, true);
  assert.equal(outside.content[0].text, "demo_list is not available here.");
  const odd = await callerContext.run({ caller: "somebody", peer: false, crossHost: false, botId: null },
    () => entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(odd.content[0].text, "demo_list is not available here.");
  assert.equal(fake.state.requests.length, before);
});

test("a revoked satellite is not available here; an unreachable one names the time and the server", async () => {
  const revoked = await setup();
  await store.markRevoked(revoked.db, revoked.fake.satId, new Date().toISOString());
  const r1 = await asOwner(() => revoked.entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(r1.isError, true);
  assert.equal(r1.content[0].text, "demo_list is not available here.");

  connectedServers.clear();
  const down = await setup({ status: "unreachable", unreachableSince: "2026-11-01T10:33:00.000Z" });
  const before = down.fake.state.requests.length;
  const r2 = await asOwner(() => down.entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /^black-swan-test is unreachable \(since 10:33 UTC\)\.$/);
  assert.equal(down.fake.state.requests.length, before);
});

// ── the result cap ───────────────────────────────────────────────────────────────────────────

test("more than 256 KiB serialized is 'result too large (N KiB)'", async () => {
  const { entry } = await setup();
  const r = await asOwner(() => entry.client.callTool({ name: "demo_big", arguments: {} }));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^result too large \(\d+ KiB\)$/);
});

test("a non-text item is dropped with one note; the text survives", async () => {
  const { entry } = await setup();
  const r = await asOwner(() => entry.client.callTool({ name: "demo_image", arguments: {} }));
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.content.map((c) => c.type), ["text", "text"]);
  assert.equal(r.content[0].text, "ok");
  assert.match(r.content[1].text, /1 non-text item dropped/);
});

test("an upstream JSON-RPC error never echoes its text", async () => {
  const { entry } = await setup();
  const r = await asOwner(() => entry.client.callTool({ name: "demo_fail", arguments: {} }));
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "demo_fail failed.");
});

test("a dropped connection is '<tool> failed.' with no upstream text", async () => {
  const { fake, entry } = await setup();
  fake.state.unreachable = true;
  const r = await asOwner(() => entry.client.callTool({ name: "demo_list", arguments: {} }));
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "demo_list failed.");
});

// ── the callers on the crow side ─────────────────────────────────────────────────────────────

test("owner-remote through the real /tools mount: the signed X-Crow-Sat-Caller is the ALS caller", async () => {
  const { fake, seen } = await setup();
  const app = express();
  app.use(express.json());
  // An authenticated mount (OAuth or the local MCP token) with no instanceAuth is the owner remotely.
  mountMcpServer(app, "/tools", createProxyServer, new SessionManager(), (_q, _s, n) => n());
  const http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/tools/mcp`)));
    const listed = await client.listTools();
    assert.ok(listed.tools.some((t) => t.name === "demo_list"), "the satellite tool is listed for the owner");
    const res = await client.callTool({ name: "demo_list", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.equal(res.content[0].text, "ran demo_list");
  } finally {
    await client.close().catch(() => {});
    await new Promise((r) => http.close(r));
  }
  const mcp = MCP_REQUESTS(fake);
  // The tool list is crow's own (the approved pin), so only the call goes to the satellite.
  assert.equal(mcp.length, 1, "one signed tools/call");
  assert.match(mcp[0].body, /"method":"tools\/call"/);
  assert.equal(mcp[0].headers["X-Crow-Sat-Caller"], "owner-remote");
  assert.deepEqual(seen, [{ bundle: "demo", name: "demo_list", caller: "owner-remote" }]);
});

test("a no-auth mount runs with no caller: the satellite tool refuses and is not listed", async () => {
  const { fake } = await setup();
  const app = express();
  app.use(express.json());
  mountMcpServer(app, "/tools", createProxyServer, new SessionManager(), null);
  const http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const client = new Client({ name: "t", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/tools/mcp`)));
    const listed = await client.listTools();
    assert.ok(listed.tools.some((t) => t.name === "demo_list"), "still listed (the mount is not the gate)");
    const before = fake.state.requests.length;
    const res = await client.callTool({ name: "demo_list", arguments: {} });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, "demo_list is not available here.");
    assert.equal(fake.state.requests.length, before, "refused before any network call");
  } finally {
    await client.close().catch(() => {});
    await new Promise((r) => http.close(r));
  }
});

test("owner-local through the real tool-executor; every other executor gets no store", async () => {
  const { fake, seen } = await setup();
  const owner = createToolExecutor({ principal: "owner" });
  const r1 = await owner.executeTool("demo_list", {});
  assert.equal(r1.isError, false);
  assert.equal(r1.result, "ran demo_list");
  assert.deepEqual(seen, [{ bundle: "demo", name: "demo_list", caller: "owner-local" }]);
  assert.equal(MCP_REQUESTS(fake)[0].headers["X-Crow-Sat-Caller"], "owner-local", "the signed header is the ALS caller");
  await owner.close();

  // No principal (voice, a bound bot, a peer-relayed task): no store at all, refused before network.
  const plain = createToolExecutor();
  const before = fake.state.requests.length;
  const r2 = await plain.executeTool("demo_list", {});
  assert.equal(r2.isError, true);
  assert.match(r2.result, /demo_list is not available here\./);
  // A peer-relayed task gets the explicit peer store: the satellite source is hidden from it
  // entirely (not even listed), and nothing reaches the satellite.
  const peer = createToolExecutor({ peerActor: true });
  const r3 = await peer.executeTool("demo_list", {});
  assert.equal(r3.isError, true);
  assert.match(r3.result, /Unknown tool: demo_list|demo_list is not available here\./);
  assert.equal(fake.state.requests.length, before);
  await plain.close(); await peer.close();
});

test("a pin mismatch refuses through createProxyServer, the router and the tool-executor — no fetch", async () => {
  const { db, fake } = await setup();
  // The satellite reports a different hash than the pin it was approved with.
  const changed = [...demoTools(), { name: "demo_extra", description: "new", inputSchema: { type: "object" } }];
  await store.updateSatelliteStatus(db, fake.satId, {
    last_status_json: JSON.stringify({ v: 1, status: { ...fake.statusBody(), tools: { demo: { version: "1.0.0", sha256: toolsHash(changed) } } }, alerts: { psi: false, tools: {} } }),
  });
  await TE.refreshSatelliteEntries({ db, dbFactory: () => db, fetchImpl: fake.fetchImpl });
  const before = fake.state.requests.length;

  const viaProxy = await asOwner(async () => cb(createProxyServer()._registeredTools.demo_list)({}, {}));
  assert.equal(viaProxy.isError, true);
  assert.match(viaProxy.content[0].text, /These tools changed/);

  const router = createRouterServer();
  const viaRouter = await asOwner(async () => cb(router._registeredTools.crow_tools)({ action: "demo_list", params: {} }, {}));
  assert.equal(viaRouter.isError, true);
  assert.match(viaRouter.content[0].text, /These tools changed/);

  const exec = createToolExecutor({ principal: "owner" });
  const viaExec = await exec.executeTool("demo_list", {});
  assert.equal(viaExec.isError, true);
  assert.match(viaExec.result, /These tools changed/);
  await exec.close();

  assert.equal(fake.state.requests.length, before, "no tools/call left the gateway");
});

// ── D22 and name clashes ────────────────────────────────────────────────────────────────────

test("the bundle id `artifacts` gets no entry (D22) and logs one line", async () => {
  const lines = [];
  const db = freshDb();
  await db.executeMultiple(SATELLITE_DDL);
  const fake = createMgmtFake();
  await makeSatelliteRow(db, fake);
  writeInstalled([{ id: "artifacts", mode: "satellite", host: fake.satId, version: "1.0.0" }]);
  const servers = new Map();
  await TE.refreshSatelliteEntries({ db, servers, dbFactory: () => db, fetchImpl: fake.fetchImpl, log: (m) => lines.push(m) });
  assert.equal(servers.has("artifacts"), false);
  const mine = lines.filter((l) => l.includes("artifacts"));
  assert.equal(mine.length, 1, JSON.stringify(lines));
  assert.match(mine[0], /reserved name/);
});

test("a local source with the same tool name wins over the satellite", async () => {
  const calls = [];
  connectedServers.set("local-ext", {
    client: { async callTool({ name }) { calls.push(`local:${name}`); return { content: [{ type: "text", text: "local answer" }] }; } },
    tools: [{ name: "demo_list", description: "same name", inputSchema: { type: "object" } }],
    status: "connected",
  });
  const { fake } = await setup(); // bundle "demo" sorts BEFORE "local-ext" by id
  const srv = createProxyServer();
  assert.deepEqual(Object.keys(srv._registeredTools).filter((n) => n === "demo_list"), ["demo_list"]);
  const res = await asOwner(async () => cb(srv._registeredTools.demo_list)({}, {}));
  assert.equal(res.content[0].text, "local answer");
  assert.deepEqual(calls, ["local:demo_list"]);
  assert.equal(MCP_REQUESTS(fake).length, 0, "the satellite was never called");
});

test("refresh drops the entry when the install record goes away", async () => {
  const { db, fake } = await setup();
  assert.ok(connectedServers.get("demo"));
  writeInstalled([]);
  await TE.refreshSatelliteEntries({ db, dbFactory: () => db, fetchImpl: fake.fetchImpl });
  assert.equal(connectedServers.get("demo"), undefined);
});

test("the status poll refreshes entry.tools (a pin approved mid-run is live without a restart)", async () => {
  const { db, fake } = await setup();
  const entry = connectedServers.get("demo");
  assert.equal(entry.tools.length, 5);
  const next = [...demoTools(EXTRA_TOOLS), { name: "demo_new", description: "new", inputSchema: { type: "object", properties: {} } }];
  fake.state.tools.demo = next;
  await store.putToolPin(db, {
    satellite_id: fake.satId, bundle: "demo", version: "1.1.0", tools_sha256: toolsHash(next), tools_json: JSON.stringify(next), approved_at: "x",
  });
  const poller = createSatellitePoller({ dbFactory: () => db, closeDb: false, fetchImpl: fake.fetchImpl, notify: async () => {} });
  await poller.tick();
  assert.equal(connectedServers.get("demo"), entry, "same entry, refreshed in place");
  assert.ok(entry.tools.some((t) => t.name === "demo_new"), JSON.stringify(entry.tools.map((t) => t.name)));
  const r = await asOwner(() => entry.client.callTool({ name: "demo_new", arguments: {} }));
  assert.equal(r.content[0].text, "ran demo_new");
});
test("ownerSession (the dashboard chat) reaches the satellite as owner-local but never stamps an owner job principal", async () => {
  const { fake, seen } = await setup();
  const chat = createToolExecutor({ ownerSession: true });
  const r = await chat.executeTool("demo_list", {});
  assert.equal(r.isError, false);
  assert.deepEqual(seen, [{ bundle: "demo", name: "demo_list", caller: "owner-local" }]);
  assert.equal(MCP_REQUESTS(fake)[0].headers["X-Crow-Sat-Caller"], "owner-local");
  await chat.close();
  // The job principal stays the services rule (opts.principal only): check the source, since a
  // delegate needs the bot tables. ownerSession must not appear in the jobPrincipal expression.
  const src = (await import("node:fs")).readFileSync(new URL("../servers/gateway/ai/tool-executor.js", import.meta.url), "utf8");
  assert.match(src, /const jobPrincipal = opts\.principal === "owner" \? "owner" : null;/);
  // And the dashboard chat route adds only ownerSession for a local password session, never a
  // principal (the principal stays chatExecutorOptions' pinned-project rule).
  const chatSrc = (await import("node:fs")).readFileSync(new URL("../servers/gateway/routes/chat.js", import.meta.url), "utf8");
  const execLine = chatSrc.split("\n").find((l) => l.includes("const execOpts = {"));
  assert.ok(execLine, "the chat route builds execOpts");
  assert.match(execLine, /ownerTurn \? \{ ownerSession: true \}/);
  assert.doesNotMatch(execLine, /principal/);
});

test("a peer-relayed executor's crow_discover never lists a satellite tool", async () => {
  const { fake } = await setup();
  const before = fake.state.requests.length;
  const peer = createToolExecutor({ peerActor: true });
  const r = await peer.executeTool("crow_discover", { category: "tools" });
  assert.doesNotMatch(String(r.result), /demo_list|\bdemo\b/, "no satellite source in a peer's listing");
  const owner = createToolExecutor({ principal: "owner" });
  const o = await owner.executeTool("crow_discover", { category: "tools" });
  assert.match(String(o.result), /demo_list|\bdemo\b/, "the owner's listing has it (the test is not vacuous)");
  assert.equal(fake.state.requests.length, before, "listings never reach the satellite");
  await peer.close(); await owner.close();
});

test("a name that passes the prefix but is not in the pinned list is never published or called", async () => {
  // demo_unknown matches the bundle prefix, but the owner never approved it (not in the pin).
  const { fake } = await setup();
  const entry = connectedServers.get("demo");
  assert.ok(!entry.tools.some((t) => t.name === "demo_unknown"));
  const before = fake.state.requests.length;
  const r = await asOwner(() => entry.client.callTool({ name: "demo_unknown", arguments: {} }));
  assert.equal(r.isError, true);
  assert.equal(fake.state.requests.length, before);
});
