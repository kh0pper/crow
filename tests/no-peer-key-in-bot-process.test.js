/**
 * Item 46 PR-B (B4), Kevin's ruling: no pair key, signing key or peer bearer
 * ever reaches a bot or pi process. The pi bot's remote proxy talks to a
 * loopback relay on its own gateway, and only the gateway signs.
 *
 * Static: the modules that build a pi/bot child's env or MCP blocks never name
 * the peer credential store, and the proxy's import graph never reaches the
 * modules that read it. Runtime: with a canary credential store on disk (and
 * named in the parent env), the real writer's blocks and the real spawn-env
 * scrub carry no canary and no store path, and the real proxy child, spawned
 * the way pi spawns it with the store chmod 000, connects to its relay while
 * holding no canary in its environment and no descriptor on the store.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, chmodSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";
import { filterSpawnEnv } from "../scripts/pi-bots/bridge.mjs";
import { buildBotBaseEnv, stripPeerCredentialEnv } from "../servers/shared/bot-env.js";
import { initGatewayActorKey, verifyPeerRelayActorSig } from "../scripts/pi-bots/actor-sig.mjs";

const REPO = resolve(import.meta.dirname, "..");
const FORBIDDEN = ["CROW_PEER_TOKENS_PATH", "peer-tokens.json", "getPeerCreds", "loadPeerCreds", "signing_key"];
// Every module that builds a pi or bot child's env, or the MCP blocks pi spawns
// from. servers/shared/bot-env.js is the scrubber that removes the store's env
// name, so it names it on purpose and is checked at runtime below instead.
const BUILDERS = [
  "scripts/pi-bots/remote-blocks.mjs", "scripts/pi-bots/crow-remote-proxy.mjs", "scripts/pi-bots/mcp_writer.mjs",
  "scripts/pi-bots/actor-env.mjs", "scripts/pi-bots/crow-server-catalog.mjs", "scripts/pi-bots/bot-world.mjs",
  "scripts/pi-bots/bridge.mjs", "scripts/pi-bots/job_runner.mjs", "scripts/pi-bots/bot-workspace-env.mjs",
  "scripts/pi-bots/pi_sandbox.mjs", "scripts/pi-bots/mcp-delivery.mjs", "servers/gateway/perch-interactive.js",
];

test("static: no env/block builder names the peer credential store", () => {
  for (const rel of BUILDERS) {
    const src = readFileSync(join(REPO, rel), "utf8");
    for (const s of FORBIDDEN) assert.ok(!src.includes(s), `${rel} contains ${s}`);
  }
});

/** Relative static + literal dynamic imports of a module, resolved to absolute paths. */
function relativeImports(file) {
  const src = readFileSync(file, "utf8");
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
  for (let m; (m = re.exec(src));) out.add(resolve(dirname(file), m[1]));
  return [...out];
}

test("static: the proxy's import graph never reaches the credential store or the pair-key reader", () => {
  const seen = new Set();
  const stack = [join(REPO, "scripts/pi-bots/crow-remote-proxy.mjs")];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of relativeImports(f)) if (existsSync(dep)) stack.push(dep);
  }
  const rel = [...seen].map((f) => f.slice(REPO.length + 1));
  assert.ok(rel.includes("servers/shared/json-schema-to-zod.js"), "the walk follows relative imports: " + rel);
  for (const bad of ["servers/shared/peer-credentials.js", "servers/shared/sync-pair-binding.js"]) {
    assert.ok(!rel.includes(bad), `${bad} is in the proxy's import graph: ${rel.join(", ")}`);
  }
});

// ---- runtime ----

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "no-peer-key-")));
const CANARY_TOKEN = "canary-bearer-" + randomBytes(8).toString("hex");
const CANARY_KEY = randomBytes(32).toString("hex"); // a valid-looking signing key, unique to this run
const CANARIES = [CANARY_TOKEN, CANARY_KEY];
const PEER = "inst-bravo-" + randomBytes(4).toString("hex");
const RELAY_TOKEN = "relay-" + randomBytes(16).toString("hex");
let child = null;
const servers = [];
after(async () => {
  if (child && child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  try { chmodSync(join(scratch, "crowhome", "peer-tokens.json"), 0o600); } catch {}
  rmSync(scratch, { recursive: true, force: true });
});

function fakeRelay(onRequest) {
  const sessions = new Map();
  return http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    onRequest({ url: req.url, method: req.method, headers: { ...req.headers }, body });
    const sid = req.headers["mcp-session-id"];
    if (sid && sessions.has(sid)) return sessions.get(sid).handleRequest(req, res, body);
    if (req.method === "POST" && isInitializeRequest(body)) {
      const s = new McpServer({ name: "fake-relay", version: "0" });
      s.registerTool("crow_search_memories", { description: "search", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "none" }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
      await s.connect(t);
      return t.handleRequest(req, res, body);
    }
    res.writeHead(405); res.end();
  });
}

test("runtime: no canary in the blocks, the spawn env, or the running proxy child", { timeout: 60_000 }, async () => {
  const crowHome = join(scratch, "crowhome");
  const sessionDir = join(scratch, "session");
  mkdirSync(crowHome, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const store = join(crowHome, "peer-tokens.json");
  writeFileSync(store, JSON.stringify({ [PEER]: { auth_token: CANARY_TOKEN, signing_key: CANARY_KEY } }), { mode: 0o600 });
  writeFileSync(join(crowHome, "peer-relay-token"), RELAY_TOKEN, { mode: 0o600 });
  initGatewayActorKey();

  const relayed = [];
  const relay = fakeRelay((r) => relayed.push(r));
  servers.push(relay);
  const relayPort = await new Promise((r) => relay.listen(0, "127.0.0.1", () => r(relay.address().port)));

  const def = {
    display_name: "Hank Bot",
    tools: { crow_mcp: [], remote_mcp: [`${PEER}::crow-memory`] },
    // A def naming the store must not get it into pi's env.
    spawn_env: { CROW_PEER_TOKENS_PATH: store, HARMLESS_FLAG: "1" },
  };
  const actor = { botId: "hank", threadId: "discord:42", gatewayType: "discord" };
  const res = writeBotMcp(def, {
    sessionDir, crowHome, canonical: { mcpServers: {} }, write: false,
    remoteEnabled: true, peerGatewayUrls: { [PEER]: "http://127.0.0.1:9" },
    botId: actor.botId, threadId: actor.threadId, gatewayType: actor.gatewayType, displayName: "Hank Bot",
    gatewayPort: relayPort,
  });
  assert.deepEqual(res.remoteWarnings, []);
  const text = JSON.stringify(res.json);
  for (const c of CANARIES) assert.ok(!text.includes(c), "no canary in the bot's MCP config");
  for (const s of ["peer-tokens.json", "CROW_PEER_TOKENS_PATH", "CROW_REMOTE_GATEWAY_URL"]) assert.ok(!text.includes(s), `no ${s} in the config`);
  const name = Object.keys(res.json.mcpServers).find((k) => k.startsWith("crow-remote-"));
  const block = res.json.mcpServers[name];
  assert.ok(block, text);
  assert.equal(block.env.CROW_REMOTE_RELAY_URL, `http://127.0.0.1:${relayPort}/peer-relay/${PEER}/memory/mcp`);
  assert.equal(verifyPeerRelayActorSig({ ...actor, sig: block.env.CROW_REMOTE_ACTOR_SIG }), true);

  // pi's base env, from a parent (gateway) env that names the store itself.
  const parentEnv = { ...process.env, CROW_PEER_TOKENS_PATH: store };
  for (const mode of ["scrubbed", "passthrough"]) {
    const src = mode === "passthrough" ? { ...parentEnv, CROW_BOT_ENV_PASSTHROUGH: "1" } : parentEnv;
    const base = stripPeerCredentialEnv(buildBotBaseEnv(src));
    assert.ok(!("CROW_PEER_TOKENS_PATH" in base), `${mode}: the base env carries no store path`);
  }
  const fromDef = filterSpawnEnv(def);
  assert.ok(!("CROW_PEER_TOKENS_PATH" in fromDef), "a def's spawn_env cannot name the store");
  assert.equal(fromDef.HARMLESS_FLAG, "1");
  const spawnEnv = { ...stripPeerCredentialEnv(buildBotBaseEnv(parentEnv)), ...fromDef };
  const envText = JSON.stringify(spawnEnv);
  for (const c of CANARIES) assert.ok(!envText.includes(c));
  assert.ok(!envText.includes(store), "the spawn env never names the store");

  // Spawn the real proxy exactly as pi would, with the store unreadable.
  chmodSync(store, 0o000);
  child = spawn(block.command, block.args, { env: { ...spawnEnv, ...block.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const deadline = Date.now() + 30_000;
  while (!relayed.some((r) => r.body?.method === "tools/list")) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail("proxy never connected: " + stderr);
    await new Promise((r) => setTimeout(r, 100));
  }
  const init = relayed.find((r) => r.body?.method === "initialize");
  assert.equal(init.url, `/peer-relay/${PEER}/memory/mcp`);
  assert.equal(init.headers.authorization, `Bearer ${RELAY_TOKEN}`, "the proxy presents the relay token");
  assert.equal(init.headers["x-crow-actor-id"], "hank");
  assert.equal(verifyPeerRelayActorSig({ botId: init.headers["x-crow-actor-id"], threadId: init.headers["x-crow-actor-thread"], gatewayType: init.headers["x-crow-actor-gateway"], sig: init.headers["x-crow-actor-sig"] }), true);
  for (const r of relayed) for (const c of CANARIES) assert.ok(!JSON.stringify(r.headers).includes(c));

  const environ = readFileSync(`/proc/${child.pid}/environ`, "utf8");
  for (const c of CANARIES) assert.ok(!environ.includes(c), "no canary in the proxy's environment");
  assert.ok(!environ.includes("CROW_PEER_TOKENS_PATH="), "no store path in the proxy's environment");
  const fds = readdirSync(`/proc/${child.pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${child.pid}/fd/${fd}`); } catch { return ""; } });
  assert.ok(!fds.some((l) => l.includes("peer-tokens")), "no descriptor on the store: " + fds.join(", "));
});
