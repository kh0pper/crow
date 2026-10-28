/**
 * Item 46 follow-up, PR-A, on REAL gateways paired by the real CLI (tests/fixtures/peer-pair.mjs).
 *
 * A paired instance that writes a Workspace comment here, by any peer path (another instance's voice
 * bot through /router/mcp crow_tools, or a direct MCP client on /tools/mcp), is labelled
 * "Crow (via <this instance's own row name for that peer>)", with a short id suffix when that name is
 * not unique. Nothing the caller claims becomes the label. Positive control: the owner's own comment
 * (local MCP token) still reads "Crow", as before. (Artifacts are closed to peers: tests/peer-label.test.js.)
 *
 * B runs the real Workspace add-on (mcp-addons.json → bundles/workspace/server/index.js) against the
 * hermetic fake Nextcloud in this process.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Instance, pairInto, until, sha, REPO } from "./fixtures/peer-pair.mjs";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { idSuffix } from "../servers/shared/peer-label.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
// The pair CLI enrolls under $HOSTNAME; pin it per instance so the test never sees the real host's name.
class Named extends Instance { get env() { return { ...super.env, HOSTNAME: this.name }; } }
const OWNER_IP = { ip: "100.64.20.250" };
let A, B, C, fake, ownerToken;
const clients = [];

function installWorkspace(inst) {
  const dir = join(inst.dir, "bundles", "workspace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"),
    "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n", { mode: 0o600 });
  writeFileSync(join(inst.dir, "mcp-addons.json"), JSON.stringify({
    workspace: { command: "node", args: ["server/index.js"], cwd: join(REPO, "bundles", "workspace"),
      env: { WORKSPACE_NC_INTERNAL_URL: fake.ncUrl, WORKSPACE_OO_INTERNAL_URL: fake.ooUrl } },
  }), { mode: 0o600 });
  inst.sql("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('remote_exposed_tools', ?)", [JSON.stringify(["workspace"])]);
}

async function mcp(url, bearer) {
  const c = new Client({ name: "via-label-test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  clients.push(c);
  return c;
}
const body = (r) => JSON.parse(r.content[0].text);
const owner = async () => mcp(`${await B.urlFor(OWNER_IP)}/tools/mcp`, ownerToken);
const peerTools = async (from) => mcp(`${await B.urlFor(from)}/tools/mcp`, from.tokens()[B.id].auth_token);
const put = (name) => fake.addFile(`S/${name}`, readFileSync(join(FIX, "rich.docx")), { owner: "admin" });
async function authorOf(path, commentId) {
  const r = body(await (await owner()).callTool({ name: "ws_docs_list_comments", arguments: { path, include_resolved: true } }));
  return r.data.comments.find((x) => x.id === commentId)?.author;
}

/** Another instance's voice bot: the real buildRemoteVoiceContext + callRemote, run as `from`. */
async function voiceComment(from, path, content) {
  const url = await B.urlFor(from);
  const mod = (p) => JSON.stringify(new URL(`../${p}`, import.meta.url).href);
  const code = `
    const { buildRemoteVoiceContext } = await import(${mod("servers/gateway/ai/remote-voice-tools.js")});
    const { createDbClient } = await import(${mod("servers/db.js")});
    const db = createDbClient();
    const ctx = await buildRemoteVoiceContext(db, { bot_id: "hank", display_name: "Hank", tools: { remote_mcp: [${JSON.stringify(`${B.id}::workspace`)}] } }, {
      readSettingFn: async () => JSON.stringify({ remote_invocation: true }),
      getPeerGatewayUrls: async () => new Map([[${JSON.stringify(B.id)}, ${JSON.stringify(url)}]]),
    });
    if (!ctx) { console.log("RESULT null"); process.exit(0); }
    const r = await ctx.callRemote("ws_docs_add_comment", { path: ${JSON.stringify(path)}, content: ${JSON.stringify(content)} });
    await ctx.close();
    console.log("RESULT " + r.content[0].text);
    process.exit(0);`;
  const r = await from.runAs(code);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`voice child failed: ${r.err.slice(-2000)}`);
  return JSON.parse(line.slice(7));
}

before(async () => {
  fake = await startFakeNextcloud();
  fake.addFolder("S", { owner: "admin" });
  A = await new Named("alpha", "100.64.20.11").init();
  B = await new Named("bravo", "100.64.20.12").init();
  // C enrolls under the SAME name as A: the name is the peer's choice, so it cannot be trusted to be unique.
  C = await new Named("alpha", "100.64.20.13").init();
  installWorkspace(B);
  ownerToken = randomBytes(32).toString("hex");
  B.sql("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('mcp_local_token_hash', ?)", [sha(ownerToken)]);
  await A.boot();
  const r = await pairInto(A, B);
  if (r.code !== 0) throw new Error(`pairing A into B failed: ${r.out}`);
  const ok = await until(async () => {
    try { return (await (await owner()).listTools()).tools.some((t) => t.name === "ws_docs_add_comment"); } catch { return false; }
  }, 60_000, 500);
  if (!ok) throw new Error(`Workspace add-on never connected on B\n${B.log.slice(-3000)}`);
});

after(async () => {
  for (const c of clients) { try { await c.close(); } catch { /* gone */ } }
  for (const i of [A, B, C]) { try { await i?.cleanup(); } catch { /* gone */ } }
  fake?.close();
});

test("positive control: the owner's own comment on B still reads 'Crow'", async () => {
  put("own.docx");
  const a = body(await (await owner()).callTool({ name: "ws_docs_add_comment", arguments: { path: "S/own.docx", content: "mine" } }));
  assert.equal(a.success, true, JSON.stringify(a));
  assert.equal(await authorOf("S/own.docx", a.data.comment_id), "Crow");
});

test("another instance's voice bot (callRemote → /router/mcp crow_tools) reads 'Crow (via alpha)'", async () => {
  put("voice.docx");
  const a = await voiceComment(A, "S/voice.docx", "from the voice bot");
  assert.equal(a.success, true, JSON.stringify(a));
  assert.equal(await authorOf("S/voice.docx", a.data.comment_id), "Crow (via alpha)");
});

test("a peer's direct /tools/mcp call reads 'Crow (via alpha)', whatever actor it claims in _meta", async () => {
  put("claim.docx");
  const c = await peerTools(A);
  const a = body(await c.callTool({ name: "ws_docs_add_comment", arguments: { path: "S/claim.docx", content: "claimed" },
    _meta: { "crow/actor": { kind: "bot", id: "owner", name: "Alex" } } }));
  assert.equal(a.success, true, JSON.stringify(a));
  const author = await authorOf("S/claim.docx", a.data.comment_id);
  assert.equal(author, "Crow (via alpha)");
  assert.doesNotMatch(author, /Alex|\(bot/);
});

test("a second peer enrolled under the same name: both are told apart by an id suffix", async () => {
  await C.boot();
  const r = await pairInto(C, B);
  assert.equal(r.code, 0, r.out);
  await until(async () => {
    try { return (await (await owner()).listTools()).tools.some((t) => t.name === "ws_docs_add_comment"); } catch { return false; }
  }, 60_000, 500);
  put("dupA.docx"); put("dupC.docx");
  const a = await voiceComment(A, "S/dupA.docx", "from a");
  const c = body(await (await peerTools(C)).callTool({ name: "ws_docs_add_comment", arguments: { path: "S/dupC.docx", content: "from c" } }));
  assert.equal(a.success && c.success, true);
  const la = await authorOf("S/dupA.docx", a.data.comment_id);
  const lc = await authorOf("S/dupC.docx", c.data.comment_id);
  assert.equal(la, `Crow (via alpha [${idSuffix(A.id)}])`);
  assert.equal(lc, `Crow (via alpha [${idSuffix(C.id)}])`);
  assert.notEqual(la, lc);
});
