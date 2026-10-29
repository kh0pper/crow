/**
 * Item 46 PR-B Task B3: the in-process voice path signs a bot's calls to a
 * peer with the gateway-signed remote actor. A loopback MCP server records
 * what actually arrives on the wire. See the private engineering notes.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  REMOTE_ACTOR_HEADER, REMOTE_ACTOR_SIG_HEADER, verifyRemoteActor, _resetRemoteActorNonces,
} from "../servers/shared/remote-actor.js";
import { buildRemoteVoiceContext, _resetRemoteVoiceCacheForTests, _resetVoiceUnsignedLogForTests } from "../servers/gateway/ai/remote-voice-tools.js";

const KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TOKEN = "fake-peer-bearer-not-a-secret";
const PEER = "bravo-peer-instance";
const LOCAL = "alpha-local-instance";

const scratch = mkdtempSync(join(tmpdir(), "ra-senders-"));
const tokensPath = join(scratch, "peer-tokens.json");
process.env.CROW_PEER_TOKENS_PATH = tokensPath;
function writeStore(obj) { writeFileSync(tokensPath, JSON.stringify(obj), { mode: 0o600 }); }

const captured = [];
const server = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : undefined;
  captured.push({ url: req.url, headers: req.headers, body });
  const s = new McpServer({ name: "fake-peer", version: "0.0.1" });
  s.tool("crow_discover", "d", { category: z.string().optional() }, async () => ({
    content: [{ type: "text", text: "  cap-one:\n    - fw_search: find music\n" }] }));
  s.tool("crow_tools", "t", { action: z.string(), params: z.any().optional() }, async () => ({
    content: [{ type: "text", text: "done" }] }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await s.connect(t);
  await t.handleRequest(req, res, body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_BASE = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); server.closeAllConnections?.(); rmSync(scratch, { recursive: true, force: true }); });

const botDef = { bot_id: "hank", display_name: "Hank", tools: { remote_mcp: [`${PEER}::cap-one`], crow_mcp: [] } };
const deps = () => ({
  readSettingFn: async () => JSON.stringify({ remote_invocation: true }),
  getPeerGatewayUrls: async () => new Map([[PEER, URL_BASE]]),
  getLocalId: () => LOCAL,
});
const toolCalls = () => captured.filter((c) => c.body?.method === "tools/call" && c.body.params.name === "crow_tools");
const verifyReq = (c, over = {}) => verifyRemoteActor({
  headers: c.headers, body: c.body, peerId: LOCAL, localId: PEER, mount: "/router", keyLookup: () => KEY, processStartMs: 0, ...over,
});

beforeEach(() => {
  captured.length = 0;
  _resetRemoteActorNonces(); _resetRemoteVoiceCacheForTests(); _resetVoiceUnsignedLogForTests();
  writeStore({ [PEER]: { auth_token: TOKEN, signing_key: KEY } });
});

function captureErr(fn) {
  const out = []; const orig = console.error;
  console.error = (...a) => out.push(a.join(" "));
  return fn().then((r) => { console.error = orig; return out; }, (e) => { console.error = orig; throw e; });
}

test("S-V1 a bound bot's tool call is signed; discovery and handshake carry no actor", async () => {
  const ctx = await buildRemoteVoiceContext(null, botDef, deps());
  assert.ok(ctx);
  await ctx.callRemote("fw_search", { q: "x" });
  await ctx.close();
  const calls = toolCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  const v = verifyReq(calls[0]);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.actor.bot, "hank");
  assert.equal(v.actor.name, "Hank");
  // src is this instance's id: verifying as a different peer id fails
  assert.equal(verifyReq(calls[0], { peerId: "someone-else", keyLookup: () => KEY }).ok, false);
  const others = captured.filter((c) => !calls.includes(c));
  assert.ok(others.length >= 3, "initialize / tools/list / discovery call were captured");
  for (const c of others) {
    assert.equal(c.headers[REMOTE_ACTOR_HEADER], undefined);
    assert.equal(c.headers[REMOTE_ACTOR_SIG_HEADER], undefined);
  }
  assert.ok(others.some((c) => c.body?.params?.name === "crow_discover"));
});

test("S-V2 no pair key: the call still succeeds unsigned and one line is logged, never a secret", async () => {
  writeStore({ [PEER]: { auth_token: TOKEN } });
  const ctx = await buildRemoteVoiceContext(null, botDef, deps());
  const lines = await captureErr(async () => {
    const r1 = await ctx.callRemote("fw_search", { q: "x" });
    const r2 = await ctx.callRemote("fw_search", { q: "y" });
    assert.equal(r1.content[0].text, "done");
    assert.equal(r2.content[0].text, "done");
  });
  await ctx.close();
  const calls = toolCalls();
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.headers[REMOTE_ACTOR_HEADER], undefined);
  const mine = lines.filter((l) => l.includes("[voice-remote] sending unsigned"));
  assert.equal(mine.length, 1);
  assert.ok(mine[0].includes(PEER));
  for (const l of lines) { assert.ok(!l.includes(KEY)); assert.ok(!l.includes(TOKEN)); }
});

test("S-V3 concurrent calls have distinct nonces; a replay is rejected", async () => {
  const ctx = await buildRemoteVoiceContext(null, botDef, deps());
  await Promise.all([ctx.callRemote("fw_search", { q: "a" }), ctx.callRemote("fw_search", { q: "a" })]);
  await ctx.close();
  const calls = toolCalls();
  assert.equal(calls.length, 2);
  const nonce = (c) => JSON.parse(Buffer.from(c.headers[REMOTE_ACTOR_HEADER], "base64url").toString()).nonce;
  assert.notEqual(nonce(calls[0]), nonce(calls[1]));
  _resetRemoteActorNonces();
  assert.equal(verifyReq(calls[0]).ok, true);
  assert.equal(verifyReq(calls[1]).ok, true);
  assert.equal(verifyReq(calls[0]).reason, "replay");
});

test("S-V4 a bot without a valid bot_id stays unsigned, and the bot name falls back to the id", async () => {
  const ctx = await buildRemoteVoiceContext(null, { ...botDef, bot_id: "bad id!" }, deps());
  await ctx.callRemote("fw_search", {});
  await ctx.close();
  assert.equal(toolCalls()[0].headers[REMOTE_ACTOR_HEADER], undefined);

  _resetRemoteVoiceCacheForTests(); captured.length = 0;
  const ctx2 = await buildRemoteVoiceContext(null, { ...botDef, display_name: undefined }, deps());
  await ctx2.callRemote("fw_search", {});
  await ctx2.close();
  const v = verifyReq(toolCalls()[0]);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.actor.name, "hank");
});
