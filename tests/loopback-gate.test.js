import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loopbackActorGate, readActorHeaders, noteRefusedOnce, _resetRefusedLogForTest } from "../servers/gateway/loopback-gate.js";
import { callerContext, currentCaller } from "../servers/gateway/caller-context.js";

beforeEach(() => { _resetRefusedLogForTest(); delete process.env.CROW_TRUSTED_PROXIES; });

const req = (over = {}) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { authorization: "Bearer tok" }, ...over });
const deps = (over = {}) => ({
  validateToken: async (t) => t === "tok",
  verify: () => ({ kind: "bot", botId: "b1" }),
  resolve: async () => ({ scope: "s1" }),
  ...over,
});
const boom = () => { throw new Error("boom"); };

test("happy path merges the resolved scope into the actor", async () => {
  const r = await loopbackActorGate(req(), deps());
  assert.deepEqual(r, { ok: true, actor: { kind: "bot", botId: "b1", scope: "s1" } });
  assert.ok(!JSON.stringify(r).includes("tok"), "M9: the raw bearer never leaves the gate");
});
test("step 2: non-local peer, instanceAuth, crossHostAuth -> 404", async () => {
  for (const r of [req({ socket: { remoteAddress: "100.64.20.5" } }), req({ instanceAuth: {} }), req({ crossHostAuth: {} }),
    req({ headers: { authorization: "Bearer tok", "x-forwarded-for": "100.64.20.5" } })]) {
    assert.deepEqual(await loopbackActorGate(r, deps()), { ok: false, status: 404, code: "not_found" });
  }
});
test("step 3: missing, malformed or rejected token -> 401; scheme is case-insensitive", async () => {
  const bad = { ok: false, status: 401, code: "bad_token" };
  assert.deepEqual(await loopbackActorGate(req({ headers: {} }), deps()), bad);
  assert.deepEqual(await loopbackActorGate(req({ headers: { authorization: "Basic tok" } }), deps()), bad);
  assert.deepEqual(await loopbackActorGate(req({ headers: { authorization: "Bearer nope" } }), deps()), bad);
  assert.deepEqual(await loopbackActorGate(req({ headers: { authorization: "Bearer tok" } }), deps({ validateToken: async () => "yes" })), bad);
  assert.equal((await loopbackActorGate(req({ headers: { authorization: "bEaReR tok" } }), deps())).ok, true);
});
test("step 4: verify null (sync or async) -> 403", async () => {
  const un = { ok: false, status: 403, code: "unattributed" };
  assert.deepEqual(await loopbackActorGate(req(), deps({ verify: () => null })), un);
  assert.deepEqual(await loopbackActorGate(req(), deps({ verify: async () => null })), un);
  assert.equal((await loopbackActorGate(req(), deps({ verify: async () => ({ kind: "bot" }) }))).ok, true);
});
test("step 5: resolve null -> 403", async () => {
  assert.deepEqual(await loopbackActorGate(req(), deps({ resolve: async () => null })), { ok: false, status: 403, code: "unattributed" });
});
test("a throw in any step yields that step's refusal", async () => {
  assert.deepEqual(await loopbackActorGate({ get socket() { throw new Error("x"); }, headers: {} }, deps()), { ok: false, status: 404, code: "not_found" });
  assert.deepEqual(await loopbackActorGate(req(), deps({ validateToken: boom })), { ok: false, status: 401, code: "bad_token" });
  assert.deepEqual(await loopbackActorGate(req(), deps({ validateToken: async () => boom() })), { ok: false, status: 401, code: "bad_token" });
  assert.deepEqual(await loopbackActorGate(req(), deps({ verify: boom })), { ok: false, status: 403, code: "unattributed" });
  assert.deepEqual(await loopbackActorGate(req(), deps({ resolve: async () => boom() })), { ok: false, status: 403, code: "unattributed" });
});
test("noteRefusedOnce logs once per hour per tag+reason", () => {
  const logs = [];
  const log = (m) => logs.push(m);
  assert.equal(noteRefusedOnce("t", "r", { now: 0, log }), true);
  assert.equal(noteRefusedOnce("t", "r", { now: 3_599_999, log }), false);
  assert.equal(noteRefusedOnce("t", "other", { now: 1, log }), true);
  assert.equal(noteRefusedOnce("u", "r", { now: 1, log }), true);
  assert.equal(noteRefusedOnce("t", "r", { now: 3_600_000, log }), true);
  assert.deepEqual(logs.slice(0, 1), ["[t] refused: r"]);
  assert.equal(logs.length, 4);
});
test("noteRefusedOnce is LRU-capped at 64 keys", () => {
  const log = () => {};
  for (let i = 0; i < 64; i++) noteRefusedOnce("t", `r${i}`, { now: 0, log });
  assert.equal(noteRefusedOnce("t", "r0", { now: 1, log }), false); // still held
  noteRefusedOnce("t", "r64", { now: 1, log });                       // evicts the oldest (r0 was re-checked, not refreshed)
  assert.equal(noteRefusedOnce("t", "r0", { now: 2, log }), true);    // evicted -> logs again
  assert.equal(noteRefusedOnce("t", "r64", { now: 2, log }), false);
});
test("readActorHeaders", () => {
  assert.deepEqual(readActorHeaders({
    "x-crow-actor-kind": " bot ", "x-crow-actor-id": ["b1", "b2"], "x-crow-actor-scope": "s", "x-crow-actor-thread": "t",
    "x-crow-actor-gateway": "job", "x-crow-actor-sig": "abc",
  }), { kind: "bot", botId: "b1", scopeRef: "s", threadId: "t", gatewayType: "job", sig: "abc" });
  assert.deepEqual(readActorHeaders({}), { kind: undefined, botId: undefined, scopeRef: undefined, threadId: undefined, gatewayType: undefined, sig: undefined });
});
test("callerContext / currentCaller", () => {
  assert.equal(currentCaller(), null);
  callerContext.run({ who: "x" }, () => assert.deepEqual(currentCaller(), { who: "x" }));
});
