// Loopback mount helper (spec §4.1): the scope-bound (v3) actor signature,
// signed with a SECOND per-boot key that only the gateway holds.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  initGatewayActorKey, setActorKey, _resetActorKeyForTest, _resetPresignedForTest,
  signActor, verifyActorSig, signPeerRelayActor, verifyPeerRelayActorSig, verifySessionActorSig,
  presignActors, signKindForTuple,
  SCOPE_ACTOR_KINDS, scopeRefFor, signScopeActor, verifyScopeActorSig,
} from "../scripts/pi-bots/actor-sig.mjs";

const S = { kind: "service", botId: "hank", sessionId: "7", threadId: "t-100", gatewayType: "gmail" };
const J = { kind: "service", botId: "hank", jobId: "job-abc123-x9y8z7", threadId: "job-job-abc123-x9y8z7", gatewayType: "job" };
const v = (a, scope) => ({ kind: a.kind, botId: a.botId, scope, threadId: a.threadId, gatewayType: a.gatewayType });

beforeEach(() => { _resetActorKeyForTest(); _resetPresignedForTest(); });

test("the scope kinds are exactly ['service'], frozen", () => {
  assert.deepEqual([...SCOPE_ACTOR_KINDS], ["service"]);
  assert.ok(Object.isFrozen(SCOPE_ACTOR_KINDS));
});

test("scopeRefFor: a job wins whenever one exists; else a valid session; else null", () => {
  assert.equal(scopeRefFor({ sessionId: "7" }), "s:7");
  assert.equal(scopeRefFor({ sessionId: 7 }), "s:7");
  assert.equal(scopeRefFor({ jobId: "job-a-b" }), "j:job-a-b");
  assert.equal(scopeRefFor({ sessionId: "7", jobId: "job-a-b" }), "j:job-a-b", "job wins (H1)");
  for (const bad of [{}, { sessionId: "0" }, { sessionId: "07" }, { sessionId: "x" }, { jobId: "" }, { jobId: "  " },
    { jobId: "a b" }, { jobId: "x".repeat(129) }, { jobId: "job/../x" }, { jobId: 5 }]) {
    assert.equal(scopeRefFor(bad), null, JSON.stringify(bad));
  }
  assert.equal(scopeRefFor({ sessionId: "7", jobId: "a b" }), null, "a malformed job never falls back to the session");
});

test("v3 round trip for s: and j:, and the message vector", () => {
  initGatewayActorKey();
  const ss = signScopeActor(S), sj = signScopeActor(J);
  assert.match(ss, /^[0-9a-f]{64}$/);
  assert.match(sj, /^[0-9a-f]{64}$/);
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig: ss }), true);
  assert.equal(verifyScopeActorSig({ ...v(J, "j:" + J.jobId), sig: sj }), true);
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig: ss.toUpperCase() }), true, "hex case-insensitive");
  assert.equal(verifyScopeActorSig({ ...v(S, " s:7 "), botId: " hank ", sig: ss }), true, "fields trimmed, like v1/v2");
});

test("job wins when both ids are given", () => {
  initGatewayActorKey();
  const both = signScopeActor({ ...J, sessionId: "7" });
  assert.equal(both, signScopeActor(J));
  assert.equal(verifyScopeActorSig({ ...v(J, "j:" + J.jobId), sig: both }), true);
  assert.equal(verifyScopeActorSig({ ...v(J, "s:7"), sig: both }), false);
});

test("v3 never verifies as v1/v2 and v1/v2 never verify as v3", () => {
  initGatewayActorKey();
  const s3 = signScopeActor(S);
  assert.equal(verifyActorSig({ kind: "service", botId: "hank", threadId: S.threadId, gatewayType: S.gatewayType, sig: s3 }), false);
  assert.equal(verifySessionActorSig({ kind: "peer-relay", botId: "hank", sessionId: "7", threadId: S.threadId, gatewayType: S.gatewayType, sig: s3 }), false);
  assert.equal(verifyPeerRelayActorSig({ botId: "hank", sessionId: "7", threadId: S.threadId, gatewayType: S.gatewayType, sig: s3 }), false);
  const s1 = signActor({ kind: "service", botId: "hank", threadId: S.threadId, gatewayType: S.gatewayType });
  const s2 = signPeerRelayActor({ botId: "hank", sessionId: "7", threadId: S.threadId, gatewayType: S.gatewayType });
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig: s1 }), false);
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), kind: "service", sig: s2 }), false);
});

test("tampering any field fails; another kind fails; bad shapes fail", () => {
  initGatewayActorKey();
  const sig = signScopeActor(J);
  const base = v(J, "j:" + J.jobId);
  assert.equal(verifyScopeActorSig({ ...base, sig }), true, "positive control");
  for (const [name, over] of Object.entries({
    bot: { botId: "otto" }, scope: { scope: "j:job-other" }, "scope kind": { scope: "s:7" }, thread: { threadId: "job-x" },
    gateway: { gatewayType: "board" }, kind: { kind: "peer-relay" }, "unknown kind": { kind: "bot" },
    "no bot": { botId: "" }, "bad scope": { scope: "x:1" }, "bad session scope": { scope: "s:07" }, "no scope": { scope: undefined },
  })) assert.equal(verifyScopeActorSig({ ...base, ...over, sig }), false, name);
  for (const bad of [undefined, null, "", "zz".repeat(32), sig.slice(1), sig + "0", 12]) {
    assert.equal(verifyScopeActorSig({ ...base, sig: bad }), false, String(bad));
  }
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  assert.equal(verifyScopeActorSig({ ...base, sig: flipped }), false);
  assert.equal(signScopeActor({ ...J, kind: "peer-relay" }), null, "only scope kinds");
  assert.equal(signScopeActor({ ...J, botId: "" }), null);
  assert.equal(signScopeActor({ kind: "service", botId: "hank" }), null, "no scope");
});

test("a v1/v2 key installed with setActorKey (the Discord child) cannot mint or verify v3", () => {
  _resetActorKeyForTest();
  assert.equal(setActorKey("22".repeat(32)), true);
  assert.equal(signScopeActor(S), null);
  assert.equal(signScopeActor(J), null);
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig: "a".repeat(64) }), false);
  assert.equal(signKindForTuple("service", J), null, "the relay path needs the scope key too");
  // The v1/v2 key still works for its own kinds.
  assert.match(signActor({ kind: "bot", botId: "hank" }), /^[0-9a-f]{64}$/);
});

test("initGatewayActorKey returns the 32-byte v1/v2 key, never the scope key", () => {
  const k = initGatewayActorKey();
  assert.ok(Buffer.isBuffer(k));
  assert.equal(k.length, 32);
  assert.equal(initGatewayActorKey(), k, "idempotent");
  const msg = JSON.stringify(["crow-actor-v3", "service", "hank", "s:7", "t-100", "gmail"]);
  const withReturned = createHmac("sha256", k).update(msg).digest("hex");
  const sig = signScopeActor(S);
  assert.notEqual(sig, withReturned, "v3 is not signed with the handed-off key");
  // The returned key, installed elsewhere, cannot verify it either.
  _resetActorKeyForTest();
  setActorKey(k);
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig }), false);
});

test("_resetActorKeyForTest resets the scope key: a new boot invalidates old v3 sigs", () => {
  initGatewayActorKey();
  const sig = signScopeActor(S);
  _resetActorKeyForTest();
  assert.equal(signScopeActor(S), null);
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig }), false);
  initGatewayActorKey();
  assert.equal(verifyScopeActorSig({ ...v(S, "s:7"), sig }), false, "the scope key is per boot");
});

test("signKindForTuple: a scope kind signs with the scope key for a JOB tuple only (never an s: scope)", () => {
  initGatewayActorKey();
  const sig = signKindForTuple("service", { botId: J.botId, jobId: J.jobId, threadId: J.threadId, gatewayType: J.gatewayType });
  assert.equal(sig, signScopeActor(J));
  assert.equal(verifyScopeActorSig({ ...v(J, "j:" + J.jobId), sig }), true);
  assert.equal(signKindForTuple("service", { ...J, sessionId: "7" }), sig, "job first");
  assert.equal(signKindForTuple("service", { botId: "hank", sessionId: "7", threadId: "t-100", gatewayType: "gmail" }), null, "§4.4: no s: through the relay");
});

test("presign: with no keys, a stub relay's service sig is used for exactly that job tuple", async () => {
  const X = "e".repeat(64);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ sigs: { service: X } }) }; };
  const ok = await presignActors({ gatewayUrl: "http://127.0.0.1:1", botId: J.botId, jobId: J.jobId, threadId: J.threadId, gatewayType: J.gatewayType, kinds: ["service"], fetchImpl });
  assert.equal(ok, true);
  assert.deepEqual(seen[0].kinds, ["service"]);
  assert.equal(signScopeActor(J), X);
  assert.equal(signScopeActor({ ...J, sessionId: "7" }), X, "job first: the same message");
  assert.equal(signScopeActor({ ...J, jobId: "job-other", threadId: "job-job-other" }), null, "another job");
  assert.equal(signScopeActor({ ...J, threadId: "job-x" }), null, "another thread");
  assert.equal(signScopeActor(S), null, "a session scope");
  assert.equal(verifyScopeActorSig({ ...v(J, "j:" + J.jobId), sig: X }), false, "verification never reads the cache");
});
