import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCalledCanonicalId, enforcePeerExposure } from "../servers/gateway/peer-exposure.js";

const callBody = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args || {} } });

// --- resolver (pure) ---
test("core prefixes map to canonical ids", () => {
  assert.equal(resolveCalledCanonicalId("/memory", callBody("crow_store_memory")), "crow-memory");
  assert.equal(resolveCalledCanonicalId("", callBody("crow_store_memory")), "crow-memory");
  assert.equal(resolveCalledCanonicalId("/projects", callBody("x")), "crow-projects");
  assert.equal(resolveCalledCanonicalId("/research", callBody("x")), "crow-projects");
  assert.equal(resolveCalledCanonicalId("/sharing", callBody("x")), "crow-sharing");
  assert.equal(resolveCalledCanonicalId("/storage", callBody("x")), "crow-storage");
  assert.equal(resolveCalledCanonicalId("/blog-mcp", callBody("x")), "crow-blog");
});

test("router category tool → crow-<cat>; discover allowed; relay denied", () => {
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_memory")), "crow-memory");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_blog")), "crow-blog");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_discover")), "__allow__");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_tools", { instance_id: "p2", action: "x" })), null);
});

test("non-tools/call methods are not gated (allow)", () => {
  assert.equal(resolveCalledCanonicalId("/memory", { method: "tools/list", id: 1 }), "__allow__");
  assert.equal(resolveCalledCanonicalId("/memory", { method: "initialize", id: 1 }), "__allow__");
  assert.equal(resolveCalledCanonicalId("/router", {}), "__allow__");
});

test("proxy/addon tool resolves via connectedServers; unknown → null", () => {
  const connected = new Map([
    ["texas-gov-data", { isAddon: true, status: "connected", tools: [{ name: "tx_query" }, { name: "tx_lookup" }] }],
    ["trello", { status: "connected", tools: [{ name: "add_card" }] }],
  ]);
  assert.equal(resolveCalledCanonicalId("/tools", callBody("tx_query"), connected), "texas-gov-data");
  assert.equal(resolveCalledCanonicalId("/tools-readonly", callBody("tx_lookup"), connected), "texas-gov-data");
  assert.equal(resolveCalledCanonicalId("/router", callBody("crow_tools", { action: "add_card" }), connected), "trello");
  assert.equal(resolveCalledCanonicalId("/tools", callBody("does_not_exist"), connected), null);
});

test("unknown prefix → null (fail closed)", () => {
  assert.equal(resolveCalledCanonicalId("/mystery", callBody("x")), null);
});

// --- gate (enforcePeerExposure) ---
function fakeRes() {
  return {
    statusCode: null, body: null, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.headersSent = true; return this; },
    type() { return this; },
  };
}

test("local-operator call (no instanceAuth) is never gated → allowed, no audit", async () => {
  const req = { body: callBody("crow_store_memory") }; // no req.instanceAuth
  const res = fakeRes();
  let audited = false;
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(), auditFn: async () => { audited = true; },
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
  assert.equal(audited, false);
});

test("peer call to a non-exposed capability is rejected + audited (default-deny)", async () => {
  const req = { body: callBody("crow_store_memory"), instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  let rec = null;
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(), // memory NOT exposed
    auditFn: async (_db, r) => { rec = r; },
  });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, -32001);
  assert.ok(rec && rec.error === "not_exposed");
  assert.equal(rec.direction, "inbound");
  assert.equal(rec.sourceInstanceId, "peer-1");
  assert.equal(rec.bundleId, "crow-memory");
});

test("peer call to an exposed capability passes (and audits allow)", async () => {
  const req = { body: callBody("crow_store_memory"), instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  let rec = null;
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(["crow-memory"]),
    auditFn: async (_db, r) => { rec = r; },
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
  assert.ok(rec && rec.httpStatus === 200 && !rec.error);
});

test("peer tools/list is allowed (discovery) without exposure", async () => {
  const req = { body: { method: "tools/list", id: 9 }, instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(), auditFn: async () => {},
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
});

test("unresolvable peer tools/call is denied (fail closed)", async () => {
  const req = { body: callBody("whatever"), instanceAuth: { instance: { id: "peer-1" } } };
  const res = fakeRes();
  const allowed = await enforcePeerExposure({
    prefix: "/mystery", req, res, db: {}, connectedServers: new Map(),
    exposedSetOverride: new Set(["crow-memory"]), auditFn: async () => {},
  });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
});
