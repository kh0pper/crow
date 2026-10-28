// Redesign P5 Task 5.1: a board call can prove which chat it came from.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initGatewayActorKey, _resetActorKeyForTest, signActor,
  signBoardActor, verifyBoardActorSig, signArtifactsActor,
  signBoardThreadActor, verifyBoardThreadActorSig,
} from "../scripts/pi-bots/actor-sig.mjs";
import { crowServerCatalog } from "../scripts/pi-bots/crow-server-catalog.mjs";
import { resolveActor } from "../servers/gateway/board-mcp.js";

const T = { botId: "b1", threadId: "perch-7", gatewayType: "perch" };

beforeEach(() => { _resetActorKeyForTest(); initGatewayActorKey(); });

const extra = (headers) => ({ authInfo: { clientId: "local-mcp" }, requestInfo: { headers } });
const hdrs = (id, boardSig, thread, gateway, threadSig) => ({
  "x-crow-actor-kind": "bot", "x-crow-actor-id": id, "x-crow-actor-sig": boardSig,
  ...(thread ? { "x-crow-actor-thread": thread } : {}),
  ...(gateway ? { "x-crow-actor-gateway": gateway } : {}),
  ...(threadSig ? { "x-crow-actor-thread-sig": threadSig } : {}),
});

test("a board-thread signature verifies", () => {
  const sig = signBoardThreadActor(T);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyBoardThreadActorSig({ ...T, sig }), true);
  assert.equal(verifyBoardThreadActorSig({ ...T, threadId: "perch-8", sig }), false);
  assert.equal(verifyBoardThreadActorSig({ ...T, gatewayType: "discord", sig }), false);
});

test("a phone signature is refused", () => {
  const sig = signActor({ kind: "bot", ...T });
  assert.equal(verifyBoardThreadActorSig({ ...T, sig }), false);
});

test("an artifacts or board signature is refused", () => {
  assert.equal(verifyBoardThreadActorSig({ ...T, sig: signArtifactsActor(T) }), false);
  assert.equal(verifyBoardThreadActorSig({ ...T, sig: signBoardActor({ botId: "b1", jobId: "perch-7" }) }), false);
  // and the reverse: a thread signature is no board signature
  assert.equal(verifyBoardActorSig({ botId: "b1", jobId: "perch-7", sig: signBoardThreadActor(T) }), false);
});

test("no key: nothing is signed", () => {
  _resetActorKeyForTest();
  assert.equal(signBoardThreadActor(T), null);
  assert.equal(verifyBoardThreadActorSig({ ...T, sig: "a".repeat(64) }), false);
});

test("boardBlock signs the thread only when it has one", () => {
  const home = mkdtempSync(join(tmpdir(), "board-thread-"));
  try {
    writeFileSync(join(home, "board-token"), "tok", { mode: 0o600 });
    const without = crowServerCatalog(home, { botId: "b1", jobId: "j7" }).servers.board.headers;
    assert.deepEqual(Object.keys(without).sort(),
      ["Authorization", "X-Crow-Actor-Id", "X-Crow-Actor-Kind", "X-Crow-Actor-Sig", "X-Crow-Job-Id"]);
    assert.equal(without["X-Crow-Actor-Sig"], signBoardActor({ botId: "b1", jobId: "j7" }));
    const withT = crowServerCatalog(home, { botId: "b1", jobId: "j7", threadId: "perch-7", gatewayType: "perch" }).servers.board.headers;
    assert.equal(withT["X-Crow-Actor-Thread"], "perch-7");
    assert.equal(withT["X-Crow-Actor-Gateway"], "perch");
    assert.equal(withT["X-Crow-Actor-Thread-Sig"], signBoardThreadActor(T));
    for (const k of Object.keys(without)) assert.equal(withT[k], without[k], `${k} unchanged`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("existing board tools still see the same actor, plus thread", () => {
  const bs = signBoardActor({ botId: "b1" });
  const a = resolveActor(extra(hdrs("b1", bs)), verifyBoardActorSig, verifyBoardThreadActorSig);
  assert.deepEqual({ kind: a.kind, id: a.id, jobId: a.jobId }, { kind: "bot", id: "b1", jobId: null });
  assert.equal(a.thread, null);
  const ts = signBoardThreadActor(T);
  const b = resolveActor(extra(hdrs("b1", bs, "perch-7", "perch", ts)), verifyBoardActorSig, verifyBoardThreadActorSig);
  assert.deepEqual(b.thread, { id: "perch-7", gateway: "perch" });
  assert.equal(b.id, "b1");
});

test("another bot's thread is refused", () => {
  const ts2 = signBoardThreadActor({ ...T, botId: "b2" });
  const a = resolveActor(extra(hdrs("b1", signBoardActor({ botId: "b1" }), "perch-7", "perch", ts2)), verifyBoardActorSig, verifyBoardThreadActorSig);
  assert.equal(a.id, "b1");
  assert.equal(a.thread, null);
});

test("thread headers are refused without a verifier, a signature, or matching fields", () => {
  const bs = signBoardActor({ botId: "b1" });
  const ts = signBoardThreadActor(T);
  assert.equal(resolveActor(extra(hdrs("b1", bs, "perch-7", "perch", ts)), verifyBoardActorSig).thread, null, "no thread verifier");
  assert.equal(resolveActor(extra(hdrs("b1", bs, "perch-7", "perch")), verifyBoardActorSig, verifyBoardThreadActorSig).thread, null, "no sig");
  assert.equal(resolveActor(extra(hdrs("b1", bs, "perch-9", "perch", ts)), verifyBoardActorSig, verifyBoardThreadActorSig).thread, null, "tampered thread");
  assert.equal(resolveActor(extra(hdrs("b1", bs, "perch-7", "perch", ts)), verifyBoardActorSig, () => { throw new Error("x"); }).thread, null, "throwing verifier");
  // an unattributed caller never gets a thread
  assert.equal(resolveActor(extra(hdrs("b1", "0".repeat(64), "perch-7", "perch", ts)), verifyBoardActorSig, verifyBoardThreadActorSig).thread, undefined);
});
