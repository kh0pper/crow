/**
 * Item 46 PR-B on REAL gateways paired by the real CLI (tests/fixtures/peer-pair.mjs), MUTUAL: both
 * directions between alpha (A) and bravo (B), plus charlie (C) as a third peer.
 *
 * A peer's call reads "<bot> (bot from <this instance's name for the peer>)" only when the peer's GATEWAY
 * signed which bot made it, with the pair subkey of the bearer-authenticated peer
 * (servers/shared/remote-actor.js, verified in servers/gateway/routes/mcp.js). Every forged, replayed,
 * re-pointed or third-party actor is downgraded to PR-A's "Crow (via <name>)" and the call still runs.
 * Each downgrade is pinned by the receiver's own log line for its reason (rate-limited per hour, so
 * each (instance, source, reason) triple is asserted once; usedPairs enforces that).
 *
 * The test plays a sending gateway only where it says so (signRemoteActor with the sender's real
 * signing_key, read from the sender's own credential store, sent as raw HTTP with the sender's bearer).
 * The voice legs run the real buildRemoteVoiceContext in a child with the sender's env, and the pi leg
 * runs the real peerRelayRouter + writeBotMcp + crow-remote-proxy child in a child with A's env.
 *
 * Covered elsewhere: E-P0 (A's real gateway mounts the relay; 401 without the relay token, with the
 * board token, with the token but no actor sig) is tests/peer-relay-gateway.test.js. E-M2 (an OLD
 * sender, which never signs, to a new receiver) is E-F1 below: an unsigned peer call. E-M1 (new sender,
 * old receiver) is tests/remote-actor-mixed-version.test.js. E-R2 (research reads a peer as UNKNOWN,
 * never a bot) is the unit regression in tests/peer-label.test.js: forwardActorMeta never passes
 * allowRemoteBot, so a verified remoteActor cannot reach it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Named, installWorkspace, pairInto, until, sha, settingsRevoke, hasMarker, REPO } from "./fixtures/peer-pair.mjs";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { idSuffix } from "../servers/shared/peer-label.js";
import { signRemoteActor } from "../servers/shared/remote-actor.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
const OWNER_IP = { ip: "100.64.20.250" };
let A, B, C, D, fake;
const ownerTokens = new Map();
const clients = [];

// ---- log assertions (I4) ----
const usedPairs = new Set();
const logOffset = (inst) => inst.log.length;
function claim(key) {
  if (usedPairs.has(key)) throw new Error(`log triple asserted twice in this run (rate-limited, so vacuous): ${key.replace(/\n/g, " | ")}`);
  usedPairs.add(key);
}
async function lineAfter(inst, offset, line) {
  const seen = () => inst.log.slice(offset).split("\n").some((l) => l.trim() === line);
  assert.ok(await until(seen, 10_000, 100), `${inst.name} never logged "${line}" after the request\n${inst.log.slice(offset).slice(-2500)}`);
}
/** `inst` logged the downgrade of `source`'s call on `mount` for exactly `reason`, after `offset`. */
async function reasonAfter(inst, offset, source, mount, reason) {
  claim(`no\n${inst.id}\n${source.id}\n${reason}`);
  await lineAfter(inst, offset, `[remote-actor] downgraded a call from ${source.id} on ${mount}: ${reason}`);
}
/** `inst` logged that it accepted `bot` from `source` on `mount`, after `offset`. */
async function acceptedAfter(inst, offset, source, bot, mount) {
  claim(`ok\n${inst.id}\n${source.id}\n${bot}\n${mount}`);
  await lineAfter(inst, offset, `[remote-actor] accepted bot ${bot} from ${source.id} on ${mount}`);
}

// ---- MCP helpers ----
const put = (name) => fake.addFile(`S/${name}`, readFileSync(join(FIX, "rich.docx")), { owner: "admin" });
const body = (r) => JSON.parse(r.content[0].text);
async function owner(inst) {
  const c = new Client({ name: "remote-actor-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${await inst.urlFor(OWNER_IP)}/tools/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${ownerTokens.get(inst)}` } } }));
  clients.push(c);
  return c;
}
async function authorOf(inst, path, commentId) {
  const r = body(await (await owner(inst)).callTool({ name: "ws_docs_list_comments", arguments: { path, include_resolved: true } }));
  return r.data.comments.find((x) => x.id === commentId)?.author;
}
async function workspaceUp(inst) {
  const ok = await until(async () => {
    try { return (await (await owner(inst)).listTools()).tools.some((t) => t.name === "ws_docs_add_comment"); } catch { return false; }
  }, 60_000, 500);
  if (!ok) throw new Error(`Workspace add-on never connected on ${inst.name}\n${inst.log.slice(-3000)}`);
}

const commentCall = (path, content) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ws_docs_add_comment", arguments: { path, content } } });
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "remote-actor-test", version: "1" } } };

/** One raw JSON-RPC request on a fresh peer session: `from`'s bearer on `to`'s `mount`, extra headers on the call only. */
async function peerPost(from, to, { mount = "/tools", rpc, headers = {}, bearer = from.tokens()[to.id]?.auth_token }) {
  const url = `${await to.urlFor(from)}${mount}/mcp`;
  const base = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer || "none"}` };
  const init = await fetch(url, { method: "POST", headers: base, body: JSON.stringify(INIT) });
  const initText = await init.text();
  if (init.status !== 200) return { initStatus: init.status, status: null, json: null, text: initText };
  const h = { ...base, "mcp-session-id": init.headers.get("mcp-session-id") };
  await (await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
  const r = await fetch(url, { method: "POST", headers: { ...h, ...headers }, body: JSON.stringify(rpc) });
  const text = await r.text();
  let json = null;
  const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  try { json = JSON.parse(data.length ? data[data.length - 1] : text); } catch { json = null; }
  return { initStatus: 200, status: r.status, json, text };
}

/** The sending gateway's own signature, played by the test: `from`'s real signing_key for `keyFor` (default `to`). */
function sign(from, to, rpc, { bot = "hank", name = "Hank", mount = "/tools", aud = to.id, src = from.id, key } = {}) {
  const signingKeyHex = key ?? from.tokens()[to.id].signing_key;
  const h = signRemoteActor({ signingKeyHex, bot, name, src, aud, mount, body: rpc });
  assert.ok(h, "signRemoteActor produced headers");
  return h;
}

/** A Workspace comment by `from` on `to` (raw peer call), and its rendered author on `to`. */
async function commentAs(from, to, file, { headers = {}, rpc = null, mount = "/tools" } = {}) {
  put(file);
  const call = rpc ?? commentCall(`S/${file}`, `from ${from.name}`);
  const r = await peerPost(from, to, { mount, rpc: call, headers });
  assert.equal(r.status, 200, `the call runs: ${r.text.slice(0, 500)}`);
  const res = JSON.parse(r.json.result.content[0].text);
  assert.equal(res.success, true, JSON.stringify(res));
  return authorOf(to, `S/${file}`, res.data.comment_id);
}

const mod = (p) => JSON.stringify(new URL(`../${p}`, import.meta.url).href);

/** `from`'s voice bot: the real buildRemoteVoiceContext + callRemote, run in a child with `from`'s env. */
async function voiceComment(from, to, bot, file) {
  put(file);
  const url = await to.urlFor(from);
  const code = `
    const { buildRemoteVoiceContext } = await import(${mod("servers/gateway/ai/remote-voice-tools.js")});
    const { createDbClient } = await import(${mod("servers/db.js")});
    const db = createDbClient();
    const ctx = await buildRemoteVoiceContext(db, { bot_id: ${JSON.stringify(bot.id)}, display_name: ${JSON.stringify(bot.name)}, tools: { remote_mcp: [${JSON.stringify(`${to.id}::workspace`)}] } }, {
      readSettingFn: async () => JSON.stringify({ remote_invocation: true }),
      getPeerGatewayUrls: async () => new Map([[${JSON.stringify(to.id)}, ${JSON.stringify(url)}]]),
    });
    if (!ctx) { console.log("RESULT null"); process.exit(0); }
    const r = await ctx.callRemote("ws_docs_add_comment", { path: ${JSON.stringify(`S/${file}`)}, content: "from a voice bot" });
    await ctx.close();
    console.log("RESULT " + r.content[0].text);
    process.exit(0);`;
  const r = await from.runAs(code);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`voice child failed: ${r.err.slice(-2000)}`);
  const res = JSON.parse(line.slice(7));
  assert.equal(res?.success, true, JSON.stringify(res));
  return authorOf(to, `S/${file}`, res.data.comment_id);
}

before(async () => {
  fake = await startFakeNextcloud();
  fake.addFolder("S", { owner: "admin" });
  A = await new Named("alpha", "100.64.20.11").init();
  B = await new Named("bravo", "100.64.20.12").init();
  C = await new Named("charlie", "100.64.20.13").init();
  // E-F7: a fourth instance that enrolls on B under A's name (paired in that leg).
  D = await new Named("alpha", "100.64.20.14").init();
  installWorkspace(A, fake);
  installWorkspace(B, fake, { exposed: ["workspace", "crow-memory", "crow-artifacts"] });
  // E-R1: B runs the real Artifacts mount (core-mounted when the bundle is installed).
  mkdirSync(join(B.dir, "bundles"), { recursive: true });
  symlinkSync(join(REPO, "bundles", "artifacts"), join(B.dir, "bundles", "artifacts"), "dir");
  for (const inst of [A, B]) {
    const t = randomBytes(32).toString("hex");
    ownerTokens.set(inst, t);
    inst.sql("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('mcp_local_token_hash', ?)", [sha(t)]);
  }
  await Promise.all([A.boot(), C.boot()]);
  for (const [enroller, peer] of [[A, B], [C, B], [C, A]]) {
    const r = await pairInto(enroller, peer);
    if (r.code !== 0) throw new Error(`pairing ${enroller.name} into ${peer.name} failed: ${r.out}`);
  }
  // The enrollee names itself to the enroller by its OS hostname (routes/instance-enroll.js peer_name),
  // which a test cannot pin per instance: A's operator names its row for B, as Settings would. The label
  // only ever reads the receiver's own row, so this is the name B's calls carry on A.
  assert.equal(A.sql("UPDATE crow_instances SET name = 'bravo' WHERE id = ?", [B.id]).changes, 1);
  for (const [x, y] of [[A, B], [B, A], [C, B], [C, A]]) {
    if (!x.tokens()[y.id]?.auth_token || !x.tokens()[y.id]?.signing_key) throw new Error(`${x.name} holds no credentials for ${y.name}`);
  }
  await Promise.all([workspaceUp(A), workspaceUp(B)]);
});

after(async () => {
  for (const c of clients) { try { await c.close(); } catch { /* gone */ } }
  for (const i of [A, B, C, D]) { try { await i?.cleanup(); } catch { /* gone */ } }
  fake?.close();
});

test("E-V1: A's voice bot reads 'Hank (bot from alpha)' on B, and B's reads 'Bea (bot from bravo)' on A", async () => {
  let off = logOffset(B);
  assert.equal(await voiceComment(A, B, { id: "hank", name: "Hank" }, "v1a.docx"), "Hank (bot from alpha)");
  await acceptedAfter(B, off, A, "hank", "/router");
  off = logOffset(A);
  assert.equal(await voiceComment(B, A, { id: "bea", name: "Bea" }, "v1b.docx"), "Bea (bot from bravo)");
  await acceptedAfter(A, off, B, "bea", "/router");
});

test("E-P1: A's pi bot reaches B through A's relay (real router, writer and proxy child); B accepts bot hank on /memory", { timeout: 120_000 }, async () => {
  A.sql("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)", [JSON.stringify({ remote_invocation: true })]);
  const def = { tools: { crow_mcp: [], remote_mcp: [`${B.id}::crow-memory`] } };
  A.sql("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition) VALUES ('hank', 'Hank', ?)", [JSON.stringify(def)]);
  // A's row for B holds the tailnet-shaped address; the relay's fetch seam maps it to B's Serve relay.
  const stored = String(A.row(B.id).gateway_url).replace(/\/+$/, "");
  const real = await B.urlFor(A);
  const marker = `relay-marker-${randomBytes(6).toString("hex")}`;
  const sessionDir = join(A.dir, "pi-session");
  const code = `
    const express = (await import("express")).default;
    const { peerRelayRouter } = await import(${mod("servers/gateway/routes/peer-relay.js")});
    const { createDbClient } = await import(${mod("servers/db.js")});
    const { initGatewayActorKey } = await import(${mod("scripts/pi-bots/actor-sig.mjs")});
    const { writeBotMcp } = await import(${mod("scripts/pi-bots/mcp_writer.mjs")});
    const { buildBotBaseEnv } = await import(${mod("servers/shared/bot-env.js")});
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    initGatewayActorKey();
    const STORED = ${JSON.stringify(stored)}, REAL = ${JSON.stringify(real)};
    const fetchImpl = (url, init) => globalThis.fetch(String(url).startsWith(STORED) ? REAL + String(url).slice(STORED.length) : url, init);
    const app = express();
    app.use(express.json());
    app.use(peerRelayRouter({ createDbClient, deps: { fetchImpl } }));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const res = writeBotMcp(${JSON.stringify(def)}, {
      sessionDir: ${JSON.stringify(sessionDir)}, crowHome: process.env.CROW_HOME, canonical: { mcpServers: {} }, write: false,
      remoteEnabled: true, peerGatewayUrls: { [${JSON.stringify(B.id)}]: STORED },
      botId: "hank", threadId: "discord:7", gatewayType: "discord", displayName: "Hank", gatewayPort: server.address().port,
    });
    const name = Object.keys(res.json.mcpServers).find((k) => k.startsWith("crow-remote-"));
    const block = res.json.mcpServers[name];
    const transport = new StdioClientTransport({ command: block.command, args: block.args, env: { ...buildBotBaseEnv(process.env), ...block.env }, stderr: "pipe" });
    let childErr = ""; transport.stderr?.on("data", (d) => { childErr += d; });
    const client = new Client({ name: "pi-standin", version: "1" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const r = await client.callTool({ name: "crow_store_memory", arguments: { content: ${JSON.stringify(marker)}, category: "general", importance: 5 } });
    await client.close();
    server.closeAllConnections?.(); server.close();
    console.log("RESULT " + JSON.stringify({ block, warnings: res.remoteWarnings, tools, isError: !!r.isError, text: r.content?.[0]?.text ?? null, childErr }));
    process.exit(0);`;
  const off = logOffset(B);
  const r = await A.runAs(code, { timeout: 90_000 });
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `relay child failed: ${r.err.slice(-3000)}`);
  const out = JSON.parse(line.slice(7));
  assert.deepEqual(out.warnings, []);
  assert.ok(out.tools.includes("crow_store_memory"), `B's memory tools reach the proxy: ${out.tools} ${out.childErr}`);
  assert.equal(out.isError, false, out.text);
  assert.equal(hasMarker(B, marker), true, "the call ran on B");
  await acceptedAfter(B, off, A, "hank", "/memory");
  // The minted block carries no peer credential, key or store path.
  const blockText = JSON.stringify(out.block);
  const creds = A.tokens()[B.id];
  for (const s of [creds.auth_token, creds.signing_key, "CROW_PEER_TOKENS_PATH", "peer-tokens.json"]) {
    assert.ok(!blockText.includes(s), `the bot's MCP block names ${s === creds.auth_token ? "the peer bearer" : s === creds.signing_key ? "the pair key" : s}`);
  }
  assert.ok(!("CROW_PEER_TOKENS_PATH" in out.block.env));
  assert.match(out.block.env.CROW_REMOTE_RELAY_URL, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/peer-relay/${B.id}/memory/mcp$`));
});

test("E-F1 (and E-M2, an unsigned sender): a direct /tools call claiming bot 'Alex' in _meta reads 'Crow (via alpha)'", async () => {
  const rpc = commentCall("S/f1.docx", "claimed");
  rpc.params._meta = { "crow/actor": { kind: "bot", id: "alex", name: "Alex", instance: "x" } };
  const author = await commentAs(A, B, "f1.docx", { rpc });
  assert.equal(author, "Crow (via alpha)");
  assert.doesNotMatch(author, /Alex|\(bot/);
});

test("E-F2 on B: A's bearer with headers signed by a random key is 'via' + bad_sig; A's real pair key is 'bot from'", async () => {
  const forged = commentCall("S/f2-forged.docx", "forged");
  let off = logOffset(B);
  assert.equal(await commentAs(A, B, "f2-forged.docx", { rpc: forged, headers: sign(A, B, forged, { key: randomBytes(32).toString("hex") }) }), "Crow (via alpha)");
  await reasonAfter(B, off, A, "/tools", "bad_sig");
  const honest = commentCall("S/f2-ok.docx", "honest");
  off = logOffset(B);
  assert.equal(await commentAs(A, B, "f2-ok.docx", { rpc: honest, headers: sign(A, B, honest) }), "Hank (bot from alpha)");
  await acceptedAfter(B, off, A, "hank", "/tools");
});

test("E-F2 on A (mirror): B's bearer with a random key is 'via' + bad_sig; B's real pair key is 'bot from'", async () => {
  const forged = commentCall("S/f2m-forged.docx", "forged");
  let off = logOffset(A);
  assert.equal(await commentAs(B, A, "f2m-forged.docx", { rpc: forged, headers: sign(B, A, forged, { bot: "bea", name: "Bea", key: randomBytes(32).toString("hex") }) }), "Crow (via bravo)");
  await reasonAfter(A, off, B, "/tools", "bad_sig");
  const honest = commentCall("S/f2m-ok.docx", "honest");
  off = logOffset(A);
  assert.equal(await commentAs(B, A, "f2m-ok.docx", { rpc: honest, headers: sign(B, A, honest, { bot: "bea", name: "Bea" }) }), "Bea (bot from bravo)");
  await acceptedAfter(A, off, B, "bea", "/tools");
});

test("E-F3: an argument tampered after signing is 'via' + digest_mismatch", async () => {
  const rpc = commentCall("S/f3.docx", "what was signed");
  const headers = sign(A, B, rpc);
  rpc.params.arguments.content = "what was sent";
  const off = logOffset(B);
  assert.equal(await commentAs(A, B, "f3.docx", { rpc, headers }), "Crow (via alpha)");
  await reasonAfter(B, off, A, "/tools", "digest_mismatch");
});

test("E-F4: the same signed request sent twice: first 'bot from', second 'via' + replay", async () => {
  put("f4.docx");
  const rpc = commentCall("S/f4.docx", "once");
  const headers = sign(A, B, rpc);
  const first = await peerPost(A, B, { rpc, headers });
  const firstId = JSON.parse(first.json.result.content[0].text).data.comment_id;
  assert.equal(await authorOf(B, "S/f4.docx", firstId), "Hank (bot from alpha)");
  const off = logOffset(B);
  const second = await peerPost(A, B, { rpc, headers });
  assert.equal(second.status, 200, "a replay still runs");
  const secondRes = JSON.parse(second.json.result.content[0].text);
  assert.equal(secondRes.success, true, JSON.stringify(secondRes));
  assert.equal(await authorOf(B, "S/f4.docx", secondRes.data.comment_id), "Crow (via alpha)");
  await reasonAfter(B, off, A, "/tools", "replay");
});

test("E-F5: C posing as A (C's bearer, C's key, src = A) is 'Crow (via charlie)' + src_mismatch; C's honest bot is 'bot from charlie'", async () => {
  const posing = commentCall("S/f5-pose.docx", "i am alpha");
  let off = logOffset(B);
  assert.equal(await commentAs(C, B, "f5-pose.docx", { rpc: posing, headers: sign(C, B, posing, { src: A.id }) }), "Crow (via charlie)");
  await reasonAfter(B, off, C, "/tools", "src_mismatch");
  const honest = commentCall("S/f5-ok.docx", "i am charlie");
  off = logOffset(B);
  assert.equal(await commentAs(C, B, "f5-ok.docx", { rpc: honest, headers: sign(C, B, honest) }), "Hank (bot from charlie)");
  await acceptedAfter(B, off, C, "hank", "/tools");
});

test("E-F6a: A's real B key with aud = C, sent to B, is 'via' + aud_mismatch", async () => {
  const rpc = commentCall("S/f6a.docx", "for charlie");
  const off = logOffset(B);
  assert.equal(await commentAs(A, B, "f6a.docx", { rpc, headers: sign(A, B, rpc, { aud: C.id }) }), "Crow (via alpha)");
  await reasonAfter(B, off, A, "/tools", "aud_mismatch");
});

// E-F6b: E-F2 already owns (B, source A, bad_sig), so this leg runs the same shape on A with source C:
// C's real B-bound headers (C's key for B, aud B) presented to A with C's own bearer for A.
test("E-F6b: a peer's headers bound to another pair (C's B key, aud B) sent to A are 'via' + bad_sig", async () => {
  const rpc = commentCall("S/f6b.docx", "meant for bravo");
  const off = logOffset(A);
  assert.equal(await commentAs(C, A, "f6b.docx", { rpc, headers: sign(C, B, rpc) }), "Crow (via charlie)");
  await reasonAfter(A, off, C, "/tools", "bad_sig");
});

test("wrong mount: headers signed for /router sent to /tools are 'via' + mount_mismatch", async () => {
  const rpc = commentCall("S/mount.docx", "signed for router");
  const off = logOffset(B);
  assert.equal(await commentAs(A, B, "mount.docx", { rpc, headers: sign(A, B, rpc, { mount: "/router" }) }), "Crow (via alpha)");
  await reasonAfter(B, off, A, "/tools", "mount_mismatch");
});

test("E-R1: Artifacts stays closed to a peer, even with a valid signed actor and the capability listed", async () => {
  const rpc = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "artifact_find", arguments: {} } };
  const r = await peerPost(A, B, { mount: "/artifacts", rpc, headers: sign(A, B, rpc, { mount: "/artifacts" }) });
  assert.equal(r.initStatus, 200, `positive control: B mounts /artifacts and a peer may open a session: ${r.text.slice(0, 300)}`);
  assert.equal(r.status, 403, `the peer's tools/call is refused: ${r.text.slice(0, 300)}`);
  assert.match(String(r.json?.error?.message), /not exposed for remote invocation/, "refused by the exposure gate: " + r.text.slice(0, 300));
});

test("E-F7: C enrolled on B under A's name: both signed bots carry PR-A's id suffix and differ", { timeout: 120_000 }, async () => {
  await D.boot();
  const p = await pairInto(D, B);
  assert.equal(p.code, 0, p.out);
  await workspaceUp(B);
  const a = commentCall("S/f7a.docx", "from a");
  const d = commentCall("S/f7d.docx", "from the other alpha");
  const la = await commentAs(A, B, "f7a.docx", { rpc: a, headers: sign(A, B, a) });
  const ld = await commentAs(D, B, "f7d.docx", { rpc: d, headers: sign(D, B, d) });
  assert.equal(la, `Hank (bot from alpha [${idSuffix(A.id)}])`);
  assert.equal(ld, `Hank (bot from alpha [${idSuffix(D.id)}])`);
  assert.notEqual(la, ld);
});

test("E-R3 (last): after Settings revokes A on B, A's bearer is refused", async () => {
  const before = await peerPost(A, B, { rpc: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
  assert.equal(before.initStatus, 200, "positive control: A's bearer opens a session before the revoke");
  const rv = await settingsRevoke(B, A.id);
  assert.equal(rv.status, 303, JSON.stringify(rv));
  assert.match(String(rv.location), /revoked=1/);
  const after = await peerPost(A, B, { rpc: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
  assert.notEqual(after.initStatus, 200, `A's bearer is refused after the revoke: ${after.text.slice(0, 300)}`);
});
