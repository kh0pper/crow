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

// --- request shape: a paired instance sends one plain JSON-RPC object per POST ---
const peerReq = (body, method = "POST") => ({ method, body, instanceAuth: { instance: { id: "peer-1" } } });
async function gate(prefix, req, exposed, connectedServers = new Map()) {
  const res = fakeRes();
  const audits = [];
  const allowed = await enforcePeerExposure({
    prefix, req, res, db: {}, connectedServers,
    exposedSetOverride: new Set(exposed), auditFn: async (_db, r) => { audits.push(r); },
    emitFn: async () => {},
  });
  return { allowed, res, audits };
}

test("peer batch carrying a tools/call for an unexposed tool is refused + audited, on every mount kind", async () => {
  const connected = new Map([["texas-gov-data", { status: "connected", tools: [{ name: "tx_query" }] }]]);
  const batches = {
    "/memory": [callBody("crow_store_memory")],
    "/router": [callBody("crow_memory"), callBody("crow_tools", { action: "tx_query" }, 2)],
    "/tools": [callBody("tx_query")],
    "/tools-readonly": [callBody("tx_query")],
    "/board": [callBody("add_card")],
    "": [callBody("crow_store_memory")],
  };
  for (const [prefix, batch] of Object.entries(batches)) {
    const { allowed, res, audits } = await gate(prefix, peerReq(batch), [], connected);
    assert.equal(allowed, false, `${prefix || "(root)"}: batch refused`);
    assert.equal(res.statusCode, 403, prefix);
    assert.equal(res.body.jsonrpc, "2.0");
    assert.equal(res.body.id, null);
    assert.equal(typeof res.body.error?.code, "number");
    assert.equal(audits.length, 1, `${prefix}: the refusal is audited`);
    assert.equal(audits[0].httpStatus, 403);
    assert.equal(audits[0].sourceInstanceId, "peer-1");
    assert.equal(audits[0].direction, "inbound");
    assert.equal(audits[0].error, "not_single_request");
  }
});

test("peer batch of only non-tools/call messages is refused too", async () => {
  const { allowed, res, audits } = await gate("/memory", peerReq([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }]), ["crow-memory"]);
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(audits[0]?.error, "not_single_request");
});

test("peer batch of exposed tools/calls is refused (shape, not exposure, decides)", async () => {
  const { allowed } = await gate("/memory", peerReq([callBody("crow_store_memory")]), ["crow-memory"]);
  assert.equal(allowed, false);
});

test("peer POST bodies that are not a plain object are refused", async () => {
  for (const body of [[], "tools/call", 7, true, null, undefined]) {
    const { allowed, res } = await gate("/memory", peerReq(body), ["crow-memory"]);
    assert.equal(allowed, false, `body ${JSON.stringify(body)}`);
    assert.equal(res.statusCode, 403);
  }
  const sse = await gate("/memory", peerReq([callBody("crow_store_memory")]), ["crow-memory"]);
  assert.equal(sse.allowed, false, "the SSE messages POST takes the same rule");
});

test("peer single exposed tools/call is allowed; single unexposed one is denied", async () => {
  const ok = await gate("/memory", peerReq(callBody("crow_store_memory")), ["crow-memory"]);
  assert.equal(ok.allowed, true);
  assert.equal(ok.res.headersSent, false);
  const no = await gate("/memory", peerReq(callBody("crow_store_memory")), []);
  assert.equal(no.allowed, false);
  assert.equal(no.res.body.error.code, -32001);
  assert.equal(no.audits[0].error, "not_exposed");
});

test("peer GET/DELETE without a body (session stream, session close) still pass", async () => {
  for (const method of ["GET", "DELETE"]) {
    for (const body of [undefined, {}]) {
      const { allowed, res, audits } = await gate("/memory", peerReq(body, method), []);
      assert.equal(allowed, true, `${method} ${JSON.stringify(body)}`);
      assert.equal(res.headersSent, false);
      assert.equal(audits.length, 0);
    }
  }
  const arr = await gate("/memory", peerReq([callBody("crow_store_memory")], "GET"), []);
  assert.equal(arr.allowed, false, "an array body is refused whatever the verb");
});

test("owner (non-peer) batches are not touched by the peer gate", async () => {
  const res = fakeRes();
  const allowed = await enforcePeerExposure({
    prefix: "/memory", req: { method: "POST", body: [callBody("crow_store_memory")] }, res, db: {},
    connectedServers: new Map(), exposedSetOverride: new Set(), auditFn: async () => { throw new Error("no audit expected"); },
  });
  assert.equal(allowed, true);
  assert.equal(res.headersSent, false);
});

test("resolver: an array or non-object body never resolves to allow", () => {
  assert.equal(resolveCalledCanonicalId("/memory", [callBody("crow_store_memory")]), null);
  assert.equal(resolveCalledCanonicalId("/router", [{ method: "tools/list" }]), null);
  assert.equal(resolveCalledCanonicalId("/tools", "x"), null);
  assert.equal(resolveCalledCanonicalId("/memory", undefined), "__allow__", "no body (GET/DELETE) is unchanged");
});
