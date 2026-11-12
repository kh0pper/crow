// Satellite tools on the owner paths only (SAT-7 part A, spec §9.1, §9.2): the listings a PEER
// sees never carry a satellite source, `remote_exposed_tools` can never make one remotable, and
// every satellite tool is write-class unless the owner marked it read against the pinned list.
// The fixture is the same fake-satellite one as satellite-tools-entry.test.js (no sockets).
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satpaths-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satpaths-data-"));
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
const { getChatTools } = await import("../servers/gateway/ai/tool-executor.js");
const { resolveCalledCanonicalId, enforcePeerExposure } = await import("../servers/gateway/peer-exposure.js");
const { classifyTool } = await import("../servers/shared/tool-classify.js");
const { catalogFromProbe } = await import("../servers/gateway/dashboard/panels/bot-builder/tool-access.js");
const { createMgmtFake, makeSatelliteRow, demoTools, toolsHash } = await import("./helpers/fake-satellite-mgmt.js");

const OWNER = { caller: "owner-local", peer: false, crossHost: false, botId: null };
const PEER = { caller: null, peer: true, crossHost: false, botId: null };
const as = (ctx, fn) => callerContext.run(ctx, fn);
const cb = (registered) => registered.callback || registered.handler;

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "satpaths-db-"));
  dirs.push(dir);
  return createDbClient(join(dir, "crow.db"));
}

/** One paired satellite hosting bundle "demo" (pinned), plus a plain local extension. */
async function fixture() {
  const db = freshDb();
  await db.executeMultiple(SATELLITE_DDL);
  const fake = createMgmtFake();
  const seen = [];
  fake.table["POST /satellite/v1/mcp/:bundle"] = ({ params, body, caller }) => {
    if (body.method === "tools/list") return { status: 200, json: { jsonrpc: "2.0", id: body.id, result: { tools: fake.state.tools[params.bundle] } } };
    seen.push({ name: body.params?.name, caller });
    return { status: 200, json: { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ran" }] } } };
  };
  await makeSatelliteRow(db, fake);
  const pinned = demoTools();
  await store.putToolPin(db, {
    satellite_id: fake.satId, bundle: "demo", version: "1.0.0", tools_sha256: toolsHash(pinned), tools_json: JSON.stringify(pinned),
    read_marks_json: JSON.stringify(["demo_list"]), approved_at: "2026-11-01T00:00:00Z",
  });
  await store.updateSatelliteStatus(db, fake.satId, {
    last_status_json: JSON.stringify({ v: 1, status: fake.statusBody(), health: null, error: null, alerts: { psi: false, tools: {} } }),
  });
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "demo", mode: "satellite", host: fake.satId, version: "1.0.0" }]));
  await TE.refreshSatelliteEntries({ db, dbFactory: () => db, fetchImpl: fake.fetchImpl });
  connectedServers.set("local-ext", {
    client: { async callTool() { return { content: [{ type: "text", text: "local" }] }; } },
    tools: [{ name: "local_only_tool", description: "l", inputSchema: { type: "object" } }],
    status: "connected",
  });
  return { db, fake, pinned, seen };
}

afterEach(() => { connectedServers.clear(); });

const CALL = (name) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

test("a peer's /tools listing omits the satellite source, the owner's includes it", async () => {
  const { fake } = await fixture();
  const peerNames = await as(PEER, async () => Object.keys(createProxyServer()._registeredTools));
  assert.ok(peerNames.includes("local_only_tool"));
  assert.ok(!peerNames.some((n) => n.startsWith("demo_")), `peer saw ${JSON.stringify(peerNames)}`);
  const before = fake.state.requests.length;
  const peerTool = await as(PEER, async () => createProxyServer()._registeredTools.demo_list);
  assert.equal(peerTool, undefined, "the tool is not registered at all for a peer");
  assert.equal(fake.state.requests.length, before);

  const ownerNames = await as(OWNER, async () => Object.keys(createProxyServer()._registeredTools));
  assert.ok(ownerNames.includes("demo_list"), JSON.stringify(ownerNames));
  assert.ok(ownerNames.includes("demo_create"));
});

test("the router lists satellite tools for the owner and omits them for a peer", async () => {
  const { fake, seen } = await fixture();
  const discover = (ctx, args) => as(ctx, async () => cb(createRouterServer()._registeredTools.crow_discover)(args, {}));

  const ownerList = await discover(OWNER, { category: "tools" });
  assert.match(ownerList.content[0].text, /demo_list/);

  const peerList = await discover(PEER, { category: "tools" });
  assert.doesNotMatch(peerList.content[0].text, /demo_list/);
  assert.match(peerList.content[0].text, /local_only_tool/);

  const peerNoCategory = await discover(PEER, {});
  assert.doesNotMatch(peerNoCategory.content[0].text, /tools\/demo/);

  const ownerCall = await as(OWNER, async () => cb(createRouterServer()._registeredTools.crow_tools)({ action: "demo_list", params: {} }, {}));
  assert.equal(ownerCall.isError, undefined);
  assert.deepEqual(seen, [{ name: "demo_list", caller: "owner-local" }]);

  const before = fake.state.requests.length;
  const peerCall = await as(PEER, async () => cb(createRouterServer()._registeredTools.crow_tools)({ action: "demo_list", params: {} }, {}));
  assert.match(peerCall.content[0].text, /not found in any connected integration/);
  assert.equal(fake.state.requests.length, before, "a peer's crow_tools call never reached the satellite");
});

test("getChatTools never offers a satellite tool to a peer turn", async () => {
  await fixture();
  const ownerNames = getChatTools().map((t) => t.name);
  const peerNames = getChatTools({ peer: true }).map((t) => t.name);
  assert.ok(!ownerNames.includes("demo_list"), "not promoted by name — it rides crow_tools");
  const ownerWrapper = getChatTools().find((t) => t.name === "crow_tools");
  assert.match(ownerWrapper.description, /\[demo\]: .*demo_list/);
  const peerWrapper = getChatTools({ peer: true }).find((t) => t.name === "crow_tools");
  assert.match(peerWrapper.description, /local_only_tool/, "the local extension is still offered");
  assert.doesNotMatch(peerWrapper.description, /demo_list/, "the satellite source is not");
  assert.ok(!peerNames.some((n) => n.startsWith("demo_")));
});

test("remote_exposed_tools can never make a satellite capability remotable", async () => {
  await fixture();
  assert.equal(resolveCalledCanonicalId("/tools", CALL("demo_list"), connectedServers), null);
  assert.equal(resolveCalledCanonicalId("/tools-demo", CALL("demo_list"), connectedServers), null);
  assert.equal(resolveCalledCanonicalId("/router", { method: "tools/call", params: { name: "crow_tools", arguments: { action: "demo_list" } } }, connectedServers), null);
  // …and even a hand-edited allowlist naming the bundle id is denied (fail closed).
  const res = { headersSent: false, status() { return this; }, json(b) { this.body = b; this.headersSent = true; } };
  const allowed = await enforcePeerExposure({
    prefix: "/tools", res, db: null, connectedServers,
    req: { instanceAuth: { instance: { id: "p1" } }, body: CALL("demo_list") },
    exposedSetOverride: new Set(["demo", "local-ext"]),
    auditFn: async () => {}, emitFn: async () => {},
  });
  assert.equal(allowed, false);
  assert.equal(res.body.error.code, -32001);
});

test("every reader of mcp-addons.json skips a satellite record (never a local EXTENSION)", async () => {
  await fixture();
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({ demo: { transport: "satellite", satellite_id: "sat_test", bundle: "demo" } }));
  const { extraServersFromExtensions } = await import("../scripts/pi-bots/mcp_writer.mjs");
  const { crowServerCatalog } = await import("../scripts/pi-bots/crow-server-catalog.mjs");
  const { listInstalledExtensions } = await import("../scripts/pi-bots/ext_registry.mjs");
  const def = { tools: { crow_mcp: ["demo/demo_list"] } };
  assert.deepEqual(extraServersFromExtensions(def, HOME, { canonical: { mcpServers: {} } }),
    { servers: {}, needsKeys: {} }, "no pi block is minted");
  assert.ok(!listInstalledExtensions(HOME).some((e) => e.id === "demo"), "not an installed local extension");
  const cat = crowServerCatalog(HOME, { node: process.execPath });
  assert.equal(cat.servers.demo, undefined, "no spawnable catalog block");
  assert.match(String(cat.unconfigured.demo || ""), /satellite/);
});

test("classifyTool: a satellite tool named like a read is write, read only when the owner marked it", async () => {
  const { db, fake, pinned } = await fixture();
  const gitea = { name: "gitea_list_repos" };
  assert.equal(classifyTool(gitea), "read", "the name rule alone would call it a read");
  assert.equal(classifyTool(gitea, { isSatellite: true }), "write");
  assert.equal(classifyTool({ name: "gitea_create_issue" }, { isSatellite: true }), "write");
  assert.equal(classifyTool(gitea, { isSatellite: true, readMarks: ["gitea_list_repos"] }), "read");
  assert.equal(classifyTool(gitea, { isSatellite: true, readMarks: new Set(["other"]) }), "write");

  // The marks come from the pin, never from the satellite.
  const marks = await store.getReadMarks(db, fake.satId, "demo");
  assert.deepEqual(marks, ["demo_list"]);
  const catalog = catalogFromProbe(pinned, { isSatellite: true, readMarks: marks });
  assert.deepEqual(catalog.map((t) => [t.name, t.access]), [["demo_list", "read"], ["demo_create", "write"]]);

  // A new pin replaces the marks (approveTools stores "[]" unless the hash is unchanged).
  await store.putToolPin(db, {
    satellite_id: fake.satId, bundle: "demo", version: "1.0.0", tools_sha256: toolsHash(pinned), tools_json: JSON.stringify(pinned),
    read_marks_json: "[]", approved_at: "2026-11-02T00:00:00Z",
  });
  assert.deepEqual(await store.getReadMarks(db, fake.satId, "demo"), []);
});