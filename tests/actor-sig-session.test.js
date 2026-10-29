// Item 46 PR-B (B6): session-bound actor signatures (v2) and the presigned
// cache a key-less bot host fills from its gateway's loopback signing relay.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import {
  setActorKey, signActor, verifyActorSig, _resetActorKeyForTest, initGatewayActorKey,
  signBoardActor, signArtifactsActor, signBoardThreadActor,
  SESSION_ACTOR_KINDS, signSessionActor, verifySessionActorSig,
  signPeerRelayActor, verifyPeerRelayActorSig,
  presignActors, _resetPresignedForTest,
} from "../scripts/pi-bots/actor-sig.mjs";
import * as actorSig from "../scripts/pi-bots/actor-sig.mjs";

const KEY_HEX = "11".repeat(32);
const S = { botId: "hank", sessionId: "7", threadId: "discord:42", gatewayType: "discord" };
const hmac = (msg) => createHmac("sha256", Buffer.from(KEY_HEX, "hex")).update(msg).digest("hex");

beforeEach(() => { _resetActorKeyForTest(); _resetPresignedForTest(); });

test("the only session kind is peer-relay; no service kind is minted or exported", () => {
  assert.deepEqual([...SESSION_ACTOR_KINDS], ["peer-relay"]);
  assert.ok(Object.isFrozen(SESSION_ACTOR_KINDS));
  assert.equal(actorSig.signServiceActor, undefined);
  assert.equal(actorSig.verifyServiceActorSig, undefined);
  initGatewayActorKey();
  assert.equal(signSessionActor({ kind: "service", ...S }), null, "no code path mints a service signature");
  assert.equal(actorSig.signKindForTuple("service", S), null);
});

test("v2 vectors: the MAC is JSON(['crow-actor-v2', kind, bot, session, thread, gateway]), trimmed", () => {
  setActorKey(KEY_HEX);
  const want = hmac(JSON.stringify(["crow-actor-v2", "peer-relay", "hank", "7", "discord:42", "discord"]));
  assert.equal(signPeerRelayActor(S), want);
  assert.equal(signSessionActor({ kind: "peer-relay", ...S }), want);
  assert.equal(signPeerRelayActor({ ...S, sessionId: 7 }), want, "a numeric id signs as its decimal string");
  assert.equal(signPeerRelayActor({ botId: " hank ", sessionId: " 7 ", threadId: " discord:42", gatewayType: "discord " }), want);
});

test("v1 kinds are byte-identical to before", () => {
  setActorKey(KEY_HEX);
  assert.equal(signActor({ kind: "bot", botId: "hank", threadId: "discord:42", gatewayType: "discord" }),
    hmac(JSON.stringify(["crow-actor-v1", "bot", "hank", "discord:42", "discord"])));
  assert.equal(signBoardActor({ botId: "hank", jobId: "j1" }), hmac(JSON.stringify(["crow-actor-v1", "board", "hank", "j1", ""])));
  assert.equal(signArtifactsActor(S), hmac(JSON.stringify(["crow-actor-v1", "artifacts", "hank", "discord:42", "discord"])));
  assert.equal(signBoardThreadActor(S), hmac(JSON.stringify(["crow-actor-v1", "board-thread", "hank", "discord:42", "discord"])));
});

test("a v2 signature for session 7 fails for session 8, another bot, another kind, and as v1", () => {
  initGatewayActorKey();
  const sig = signPeerRelayActor(S);
  assert.equal(verifyPeerRelayActorSig({ ...S, sig }), true, "positive control");
  assert.equal(verifyPeerRelayActorSig({ ...S, sessionId: "8", sig }), false, "bound to the session");
  assert.equal(verifyPeerRelayActorSig({ ...S, botId: "other", sig }), false, "bound to the bot");
  assert.equal(verifyPeerRelayActorSig({ ...S, threadId: "discord:43", sig }), false, "bound to the thread");
  assert.equal(verifyPeerRelayActorSig({ ...S, gatewayType: "gmail", sig }), false, "bound to the gateway");
  assert.equal(verifyActorSig({ kind: "peer-relay", ...S, sig }), false, "not a v1 signature of the same kind");
  assert.equal(verifyPeerRelayActorSig({ ...S, sig: signActor({ kind: "peer-relay", ...S }) }), false, "a v1 one is not a v2 one");
  assert.equal(verifySessionActorSig({ kind: "peer-relay", ...S, sig }), true, "the generic verifier agrees");
});

test("v2 refuses a session id that is not a positive decimal integer, and kinds outside the set", () => {
  initGatewayActorKey();
  for (const sessionId of [undefined, null, "", "0", "-1", "07", "1.5", "abc", "1e3", 0, -3, 1.5]) {
    assert.equal(signPeerRelayActor({ ...S, sessionId }), null, `sessionId ${JSON.stringify(sessionId)}`);
    assert.equal(verifyPeerRelayActorSig({ ...S, sessionId, sig: "a".repeat(64) }), false);
  }
  assert.equal(signSessionActor({ kind: "bot", ...S }), null, "v2 only for session kinds");
  assert.equal(signSessionActor({ kind: "board", ...S }), null);
  assert.equal(signPeerRelayActor({ ...S, botId: "" }), null);
});

// ---- the presigned cache ----

function signingRelay(handler) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const { status = 200, body } = await handler(seen[seen.length - 1]);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

test("presign: a key-less process uses its gateway's signatures for the exact tuple only", async () => {
  // The gateway's key, played by the test; this process then forgets it.
  setActorKey(KEY_HEX);
  const want = {
    bot: signActor({ kind: "bot", botId: "hank", threadId: "discord:42", gatewayType: "discord" }),
    board: signBoardActor({ botId: "hank", jobId: "j1" }),
    artifacts: signArtifactsActor(S),
    "board-thread": signBoardThreadActor(S),
    "peer-relay": signPeerRelayActor(S),
  };
  _resetActorKeyForTest();
  const { srv, seen, url } = await signingRelay(() => ({ body: { sigs: want } }));
  try {
    assert.equal(signPeerRelayActor(S), null, "nothing before the presign");
    const ok = await presignActors({ gatewayUrl: url, ...S, jobId: "j1", kinds: Object.keys(want) });
    assert.equal(ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/internal/actor-sign");
    assert.deepEqual(seen[0].body, { botId: "hank", sessionId: "7", threadId: "discord:42", gatewayType: "discord", jobId: "j1", kinds: Object.keys(want) });

    assert.equal(signActor({ kind: "bot", botId: "hank", threadId: "discord:42", gatewayType: "discord" }), want.bot);
    assert.equal(signBoardActor({ botId: "hank", jobId: "j1" }), want.board);
    assert.equal(signArtifactsActor(S), want.artifacts);
    assert.equal(signBoardThreadActor(S), want["board-thread"]);
    assert.equal(signPeerRelayActor(S), want["peer-relay"]);
    // Exact tuple only.
    assert.equal(signPeerRelayActor({ ...S, sessionId: "8" }), null, "another session");
    assert.equal(signPeerRelayActor({ ...S, botId: "other" }), null, "another bot");
    assert.equal(signArtifactsActor({ ...S, threadId: "discord:43" }), null, "another thread");
    assert.equal(signBoardActor({ botId: "hank", jobId: "j2" }), null, "another job");
    assert.equal(signBoardActor({ botId: "hank" }), null, "no job");
    // Verification never consults the cache.
    assert.equal(verifyPeerRelayActorSig({ ...S, sig: want["peer-relay"] }), false, "no key → nothing verifies");
  } finally { await close(srv); }
});

test("presign: with a key in this process the cache is never used", async () => {
  const bogus = "b".repeat(64);
  const { srv, url } = await signingRelay(() => ({ body: { sigs: { "peer-relay": bogus } } }));
  try {
    assert.equal(await presignActors({ gatewayUrl: url, ...S, kinds: ["peer-relay"] }), true);
    assert.equal(signPeerRelayActor(S), bogus, "positive control: the cache answers without a key");
    initGatewayActorKey();
    const own = signPeerRelayActor(S);
    assert.notEqual(own, bogus);
    assert.equal(verifyPeerRelayActorSig({ ...S, sig: own }), true);
  } finally { await close(srv); }
});

test("presign never throws: a refusal, junk, or an unreachable gateway leaves no signature", async () => {
  const cases = [
    () => ({ status: 403, body: { error: "forbidden" } }),
    () => ({ body: { sigs: { "peer-relay": "not-hex" } } }),
    () => ({ body: { nope: true } }),
  ];
  for (const handler of cases) {
    _resetPresignedForTest();
    const { srv, url } = await signingRelay(handler);
    try {
      assert.equal(await presignActors({ gatewayUrl: url, ...S, kinds: ["peer-relay"] }), false);
      assert.equal(signPeerRelayActor(S), null);
    } finally { await close(srv); }
  }
  assert.equal(await presignActors({ gatewayUrl: "http://127.0.0.1:9", ...S, kinds: ["peer-relay"], timeoutMs: 2000 }), false);
  assert.equal(await presignActors({ gatewayUrl: "http://127.0.0.1:9", botId: "", kinds: ["peer-relay"] }), false, "no bot → no request");
  assert.equal(signPeerRelayActor(S), null);
});

test("presign: a kind the gateway did not return, or one never asked for, is not cached", async () => {
  const { srv, url } = await signingRelay(() => ({ body: { sigs: { "peer-relay": "c".repeat(64), service: "d".repeat(64) } } }));
  try {
    assert.equal(await presignActors({ gatewayUrl: url, ...S, kinds: ["peer-relay"] }), true);
    assert.equal(signPeerRelayActor(S), "c".repeat(64));
    assert.equal(signSessionActor({ kind: "service", ...S }), null, "a returned service sig is never cached");
    assert.equal(signArtifactsActor(S), null, "artifacts was not returned");
  } finally { await close(srv); }
});

test("presign: the cache is bounded", async () => {
  const { srv, url } = await signingRelay((r) => ({ body: { sigs: { "peer-relay": (Number(r.body.sessionId) % 10).toString().repeat(64) } } }));
  try {
    for (let i = 1; i <= 300; i++) await presignActors({ gatewayUrl: url, ...S, sessionId: String(i), kinds: ["peer-relay"] });
    assert.equal(signPeerRelayActor({ ...S, sessionId: "300" }), "0".repeat(64), "the newest stays");
    assert.equal(signPeerRelayActor({ ...S, sessionId: "1" }), null, "the oldest is evicted");
  } finally { await close(srv); }
});
