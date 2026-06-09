import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPeerBotDef, patchPeerBot, setPeerBotEnabled } from "../servers/gateway/bot-federation-client.js";

function fakeForward(captured) {
  return async (args) => { captured.push(args); return { ok: true, status: 200, body: { ok: true } }; };
}

test("fetchPeerBotDef signs a GET to the def path with the right audit action", async () => {
  const cap = [];
  await fetchPeerBotDef({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "scout" }, fakeForward(cap));
  assert.equal(cap[0].method, "GET");
  assert.equal(cap[0].path, "/dashboard/bot-federation/def/scout");
  assert.equal(cap[0].targetInstanceId, "peerY");
  assert.equal(cap[0].auditAction, "federation.bot.def");
});

test("patchPeerBot POSTs {patch} with the patch audit action", async () => {
  const cap = [];
  await patchPeerBot({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "scout", patch: { system_prompt: "x" } }, fakeForward(cap));
  assert.equal(cap[0].method, "POST");
  assert.equal(cap[0].path, "/dashboard/bot-federation/patch/scout");
  assert.deepEqual(cap[0].body, { patch: { system_prompt: "x" } });
  assert.equal(cap[0].auditAction, "federation.bot.patch");
});

test("setPeerBotEnabled POSTs {enabled} with the enabled audit action", async () => {
  const cap = [];
  await setPeerBotEnabled({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "scout", enabled: 0 }, fakeForward(cap));
  assert.equal(cap[0].path, "/dashboard/bot-federation/enabled/scout");
  assert.deepEqual(cap[0].body, { enabled: 0 });
  assert.equal(cap[0].auditAction, "federation.bot.enabled");
});

test("botId is URL-encoded in the path", async () => {
  const cap = [];
  await fetchPeerBotDef({ db: {}, sourceInstanceId: "me", instanceId: "peerY", botId: "a/b z" }, fakeForward(cap));
  assert.equal(cap[0].path, "/dashboard/bot-federation/def/a%2Fb%20z");
});
