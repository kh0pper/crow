/**
 * Item 46 PR-B: the receiving gateway's MCP mount verifies a peer gateway's signed remote actor.
 *
 * A real mountMcpServer on a loopback port, a tiny MCP server whose tool echoes extra.authInfo.extra, and a
 * private peer-tokens.json (mode 0600, via CROW_PEER_TOKENS_PATH in its own temp dir, removed after) holding each
 * peer's signing_key. The
 * peer identity is set by a stand-in for instanceAuthMiddleware (req.instanceAuth), as the bearer check would.
 * Every negative leg has a positive control in the same harness, and no failure ever refuses the call.
 */
import "./fixtures/short-boot-grace.mjs"; // before remote-actor.js loads
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mountMcpServer } from "../servers/gateway/routes/mcp.js";
import { SessionManager } from "../servers/gateway/session-manager.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";
import {
  signRemoteActor, signingFetch, REMOTE_ACTOR_HEADER, REMOTE_ACTOR_SIG_HEADER,
  _resetRemoteActorNonces, _resetRemoteActorLog,
} from "../servers/shared/remote-actor.js";

const ALPHA = "inst-alpha-0001";
const CHARLIE = "inst-charlie-0003";
const KEYS = { [ALPHA]: randomBytes(32).toString("hex"), [CHARLIE]: randomBytes(32).toString("hex") };
const PEER_HEADER = "x-test-peer"; // test stand-in for the bearer: names which peer instanceAuth resolved

let http, base, localId, sm, tokensDir, savedTokensPath;

function makeServer() {
  const s = new McpServer({ name: "echo", version: "0" });
  s.registerTool("echo_auth", { description: "echo", inputSchema: {} }, async (_a, extra) => ({
    content: [{ type: "text", text: JSON.stringify(extra?.authInfo?.extra ?? null) }],
  }));
  return s;
}

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  const store = Object.fromEntries(Object.entries(KEYS).map(([id, k]) => [id, { signing_key: k }]));
  // Never in the suite's shared scratch CROW_HOME: peer-tokens.json is resolved per call from this env.
  tokensDir = mkdtempSync(join(tmpdir(), "remote-actor-mount-"));
  savedTokensPath = process.env.CROW_PEER_TOKENS_PATH;
  const p = join(tokensDir, "peer-tokens.json");
  process.env.CROW_PEER_TOKENS_PATH = p;
  writeFileSync(p, JSON.stringify(store), { mode: 0o600 });
  chmodSync(p, 0o600);
  localId = getOrCreateLocalInstanceId();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.headers[PEER_HEADER];
    if (id) req.instanceAuth = { instance: { id }, peerName: id === ALPHA ? "alpha" : "charlie" };
    next();
  });
  sm = new SessionManager();
  const deny = (_q, res) => res.status(401).json({ error: "no" });
  for (const prefix of ["/tools", "/memory"]) mountMcpServer(app, prefix, makeServer, sm, deny);
  http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  base = `http://127.0.0.1:${http.address().port}`;
});
after(async () => {
  await sm.closeAll().catch(() => {});
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
  if (savedTokensPath === undefined) delete process.env.CROW_PEER_TOKENS_PATH;
  else process.env.CROW_PEER_TOKENS_PATH = savedTokensPath;
  rmSync(tokensDir, { recursive: true, force: true });
});
beforeEach(() => { _resetRemoteActorNonces(); _resetRemoteActorLog(); });

/** A client on `mount` as peer `peerId`; `sign(body)` returns extra headers for each tools/call (or null). */
async function connect({ mount = "/tools", peerId = ALPHA, fetchImpl } = {}) {
  const asPeer = (url, init = {}) => (fetchImpl || fetch)(url, { ...init, headers: withHeaders(init.headers, { [PEER_HEADER]: peerId }) });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${mount}/mcp`), { fetch: asPeer }));
  return client;
}
const echo = async (client) => {
  const r = await client.callTool({ name: "echo_auth", arguments: {} });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
};
const withHeaders = (h, add) => {
  const out = new Headers(h || {});
  for (const [k, v] of Object.entries(add)) out.set(k, v);
  return out;
};
/** fetch that adds `headersFor(body)` to every tools/call POST. */
const headerFetch = (headersFor) => async (url, init = {}) => {
  let body = null;
  try { body = typeof init.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
  const add = body && !Array.isArray(body) && body.method === "tools/call" ? headersFor(body) : null;
  return fetch(url, add ? { ...init, headers: withHeaders(init.headers, add) } : init);
};
const signFor = ({ key = KEYS[ALPHA], src = ALPHA, mount = "/tools", bot = "hank", name = "Hank" } = {}) =>
  (body) => signRemoteActor({ signingKeyHex: key, bot, name, src, aud: localId, mount, body });
function captureWarn() {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}
const HANK = { peerName: "alpha", remoteActor: { kind: "bot", id: "hank", name: "Hank", instanceId: ALPHA } };

test("M-1: a call signed with the pair key carries remoteActor next to peerName", async () => {
  const sf = signingFetch({
    keyLookup: (aud) => (aud === localId ? KEYS[ALPHA] : null), src: ALPHA, aud: localId, mount: "/tools", bot: "hank", name: "Hank",
  });
  const c = await connect({ fetchImpl: sf });
  try { assert.deepEqual(await echo(c), HANK); } finally { await c.close(); }
});

test("M-2: no headers: no remoteActor, the call still succeeds", async () => {
  const c = await connect();
  try { assert.deepEqual(await echo(c), { peerName: "alpha" }); } finally { await c.close(); }
});

test("M-3: a bad signature downgrades (bad_sig logged after the offset); positive control first", async () => {
  const good = await connect({ fetchImpl: headerFetch(signFor()) });
  try { assert.deepEqual(await echo(good), HANK); } finally { await good.close(); }
  const bad = await connect({ fetchImpl: headerFetch((b) => ({ ...signFor()(b), [REMOTE_ACTOR_SIG_HEADER]: "0".repeat(64) })) });
  const cap = captureWarn();
  const offset = cap.lines.length;
  let got;
  try { got = await echo(bad); } finally { cap.restore(); await bad.close(); }
  assert.deepEqual(got, { peerName: "alpha" });
  const after = cap.lines.slice(offset);
  assert.ok(after.some((l) => l.includes("[remote-actor]") && l.includes("bad_sig") && l.includes(ALPHA)), JSON.stringify(after));
  assert.ok(after.every((l) => !l.includes(KEYS[ALPHA])), "never logs the key");
});

test("M-4: headers signed for /memory and sent to /tools are mount_mismatch; positive control on /memory", async () => {
  const ok = await connect({ mount: "/memory", fetchImpl: headerFetch(signFor({ mount: "/memory" })) });
  try { assert.deepEqual(await echo(ok), HANK); } finally { await ok.close(); }
  const c = await connect({ fetchImpl: headerFetch(signFor({ mount: "/memory" })) });
  const cap = captureWarn();
  let got;
  try { got = await echo(c); } finally { cap.restore(); await c.close(); }
  assert.deepEqual(got, { peerName: "alpha" });
  assert.ok(cap.lines.some((l) => l.includes("mount_mismatch")), JSON.stringify(cap.lines));
});

test("M-5: a batch array body is never verified (no remoteActor, no throw); a single call is", async () => {
  const c = await connect({ fetchImpl: headerFetch(signFor()) });
  assert.deepEqual(await echo(c), HANK);
  const sessionId = c.transport?.sessionId; // the session stays open for the raw batch below
  const body = [{ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "echo_auth", arguments: {} } }];
  const headers = {
    "content-type": "application/json", accept: "application/json, text/event-stream", [PEER_HEADER]: ALPHA,
    "mcp-protocol-version": "2025-03-26",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...signFor()(body[0]),
  };
  const res = await fetch(`${base}/tools/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  await c.close();
  assert.notEqual(res.status, 500, text);
  assert.ok(!text.includes("remoteActor"), text);
  assert.ok(text.includes("peerName"), "the batched call ran: " + text);
});

test("M-6: C posing as A (C's key, src = A, under C's peer identity) is src_mismatch; C as itself is accepted", async () => {
  const asSelf = await connect({ peerId: CHARLIE, fetchImpl: headerFetch(signFor({ key: KEYS[CHARLIE], src: CHARLIE })) });
  try {
    assert.deepEqual(await echo(asSelf), { peerName: "charlie", remoteActor: { kind: "bot", id: "hank", name: "Hank", instanceId: CHARLIE } });
  } finally { await asSelf.close(); }
  const c = await connect({ peerId: CHARLIE, fetchImpl: headerFetch(signFor({ key: KEYS[CHARLIE], src: ALPHA })) });
  const cap = captureWarn();
  let got;
  try { got = await echo(c); } finally { cap.restore(); await c.close(); }
  assert.deepEqual(got, { peerName: "charlie" });
  assert.ok(cap.lines.some((l) => l.includes("src_mismatch")), JSON.stringify(cap.lines));
});

test("M-7: replaying identical headers is a replay; the first use is accepted", async () => {
  let saved = null;
  const replayFetch = headerFetch((b) => (saved ||= signFor()(b)));
  const c = await connect({ fetchImpl: replayFetch });
  const cap = captureWarn();
  let first, second;
  try { first = await echo(c); second = await echo(c); } finally { cap.restore(); await c.close(); }
  assert.ok(saved?.[REMOTE_ACTOR_HEADER], "the first call was signed");
  assert.deepEqual(first, HANK);
  assert.deepEqual(second, { peerName: "alpha" });
  assert.ok(cap.lines.some((l) => l.includes("replay")), JSON.stringify(cap.lines));
});

test("an accepted actor is logged as accepted (the line the two-gateway test observes)", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  const c = await connect({ fetchImpl: headerFetch(signFor()) });
  try { assert.deepEqual(await echo(c), HANK); } finally { console.log = orig; await c.close(); }
  assert.ok(lines.some((l) => l.includes(`[remote-actor] accepted bot hank from ${ALPHA} on /tools`)), JSON.stringify(lines));
});
