import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "l2b-"));
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify({ mcpServers: {
    "crow-memory": { command: "/n", args: ["servers/memory/index.js"], env: { CROW_DB_PATH: "/db" } },
  } }));
  // This instance's home, with its relay token where the gateway mints it.
  const crowHome = join(dir, "home");
  mkdirSync(join(crowHome, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(crowHome, "secrets", "peer-relay-token"), "relay-token-fixture\n", { mode: 0o600 });
  return { dir, sessionDir, canonicalPath, crowHome };
}

test("flag OFF (default): no remote blocks even when remote_mcp is set", () => {
  const { sessionDir, canonicalPath } = fixture();
  const def = { tools: { crow_mcp: ["crow-memory"], remote_mcp: ["g1::crow-memory"] } };
  writeBotMcp(def, { sessionDir, canonicalPath, crowHome: "/tmp/none" });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(written.mcpServers["crow-memory"], "local server present");
  assert.ok(!Object.keys(written.mcpServers).some((k) => k.startsWith("crow-remote-")), "NO remote blocks when flag off");
});

test("flag ON: mints the forward-proxy block alongside local servers", () => {
  const { sessionDir, canonicalPath, crowHome } = fixture();
  const def = { tools: { crow_mcp: ["crow-memory"], remote_mcp: ["g1abcdef::crow-memory"] } };
  const res = writeBotMcp(def, {
    sessionDir, canonicalPath, crowHome,
    remoteEnabled: true,
    peerGatewayUrls: { g1abcdef: "https://g1:8444" },
  });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(written.mcpServers["crow-memory"], "local server still present");
  const remote = written.mcpServers["crow-remote-g1abcdef-crow-memory"];
  assert.ok(remote, "remote forward-proxy block minted");
  assert.equal(remote.env.CROW_REMOTE_RELAY_URL, "http://127.0.0.1:3001/peer-relay/g1abcdef/memory/mcp", "the proxy talks to this gateway's relay");
  assert.equal(remote.env.CROW_REMOTE_RELAY_TOKEN, "relay-token-fixture", "this instance's relay token, by value (its file is hidden from the sandbox)");
  assert.ok(!JSON.stringify(remote).includes("peer-relay-token"), "no path to the token file");
  assert.deepEqual(Object.keys(remote.env).filter((k) => k.startsWith("CROW_REMOTE_")).sort(), ["CROW_REMOTE_RELAY_TOKEN", "CROW_REMOTE_RELAY_URL"], "only the relay env (no bot: no actor env)");
  assert.ok(!("CROW_REMOTE_GATEWAY_URL" in remote.env), "the peer's URL never reaches the bot");
  assert.ok(!JSON.stringify(remote).includes("peer-tokens"), "no credential-store path in the block");
  assert.equal(remote.router, true, "router mode survives the writer (pi-lab registers mcp__<block>, the csv's name)");
  assert.ok(Array.isArray(res.remoteWarnings));
});

test("flag ON but addon cap → warning, no block", () => {
  const { sessionDir, canonicalPath } = fixture();
  const def = { tools: { remote_mcp: ["g1::texas-gov-data"] } };
  const res = writeBotMcp(def, { sessionDir, canonicalPath, crowHome: "/tmp/none", remoteEnabled: true, peerGatewayUrls: { g1: "https://g1:8444" } });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(!Object.keys(written.mcpServers).some((k) => k.startsWith("crow-remote-")));
  assert.ok(res.remoteWarnings.some((w) => w.includes("texas-gov-data")));
});

test("flag ON with a bot: the relay port follows opts.gatewayPort, and the block carries the actor env", () => {
  const { sessionDir, canonicalPath, crowHome } = fixture();
  const def = { tools: { remote_mcp: ["g1abcdef::crow-memory"] } };
  const res = writeBotMcp(def, {
    sessionDir, canonicalPath, crowHome, write: false,
    remoteEnabled: true, peerGatewayUrls: { g1abcdef: "https://g1:8444" },
    botId: "hank", displayName: "Hank Bot", threadId: "discord:42", gatewayType: "discord", gatewayPort: 4123, sessionId: 31,
  });
  const remote = res.json.mcpServers["crow-remote-g1abcdef-crow-memory"];
  assert.equal(remote.env.CROW_REMOTE_ACTOR_SESSION, "31", "the turn's session id reaches the block");
  assert.equal(remote.env.CROW_REMOTE_RELAY_URL, "http://127.0.0.1:4123/peer-relay/g1abcdef/memory/mcp");
  assert.equal(remote.env.CROW_REMOTE_ACTOR_ID, "hank");
  assert.equal(remote.env.CROW_REMOTE_ACTOR_THREAD, "discord:42");
  assert.equal(remote.env.CROW_REMOTE_ACTOR_GATEWAY, "discord");
  assert.equal(remote.env.CROW_ACTOR_KIND, "bot", "like every other stdio block");
  assert.equal(remote.env.CROW_ACTOR_BOT_ID, "hank");
  assert.equal(remote.env.CROW_ACTOR_BOT_NAME, "Hank Bot");
});

// ---- board entry (Track 1 Task 7, D-T1.3/D-T1.5) ----------------------------
// A direct {url, headers} MCP block at THIS instance's /board/mcp mount —
// unlike every other entry (a stdio spawn block), there is nothing to spawn.
// Bearer = the raw board token read off <crowHome>/board-token; actor headers
// carry botId/jobId so board-mcp.js's resolveActor can attribute a mutation
// (and result-service.js's lock exemption can match it against the SAME
// bot_sessions/bot_jobs rows those ids name).

function boardFixture(token) {
  const dir = mkdtempSync(join(tmpdir(), "board-entry-"));
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify({ mcpServers: {} }));
  if (token != null) writeFileSync(join(dir, "board-token"), token);
  return { dir, sessionDir, canonicalPath };
}

test("board entry: url + Authorization Bearer <raw token> + actor headers when botId/jobId are known", () => {
  const { dir, sessionDir, canonicalPath } = boardFixture("raw-board-token-abc123");
  const def = { tools: { crow_mcp: ["board"] } };
  const res = writeBotMcp(def, {
    sessionDir, canonicalPath, crowHome: dir,
    botId: "railbot", jobId: "job-xyz",
  });
  assert.ok(res.servers.includes("board"), "board reported as an active server");
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  const board = written.mcpServers.board;
  assert.ok(board, "board entry present");
  assert.equal(board.url, "http://127.0.0.1:3001/board/mcp", "default loopback gateway port");
  assert.equal(board.headers.Authorization, "Bearer raw-board-token-abc123");
  assert.equal(board.headers["X-Crow-Actor-Kind"], "bot");
  assert.equal(board.headers["X-Crow-Actor-Id"], "railbot");
  assert.equal(board.headers["X-Crow-Job-Id"], "job-xyz");
});

test("board entry: X-Crow-Job-Id omitted when no jobId is known (a chat turn, not a job dispatch)", () => {
  const { dir, sessionDir, canonicalPath } = boardFixture("tok");
  const def = { tools: { crow_mcp: ["board"] } };
  writeBotMcp(def, { sessionDir, canonicalPath, crowHome: dir, botId: "railbot" });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.equal(written.mcpServers.board.headers["X-Crow-Actor-Id"], "railbot");
  assert.ok(!("X-Crow-Job-Id" in written.mcpServers.board.headers));
});

test("board entry honors CROW_GATEWAY_PORT for the loopback URL", () => {
  const { dir, sessionDir, canonicalPath } = boardFixture("tok");
  const prev = process.env.CROW_GATEWAY_PORT;
  process.env.CROW_GATEWAY_PORT = "4009";
  try {
    writeBotMcp({ tools: { crow_mcp: ["board"] } }, { sessionDir, canonicalPath, crowHome: dir, botId: "b1" });
  } finally {
    if (prev === undefined) delete process.env.CROW_GATEWAY_PORT; else process.env.CROW_GATEWAY_PORT = prev;
  }
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.equal(written.mcpServers.board.url, "http://127.0.0.1:4009/board/mcp");
});

test("board entry: missing token file omits the entry gracefully (never crashes config generation)", () => {
  const { dir, sessionDir, canonicalPath } = boardFixture(null); // no board-token file written
  const def = { tools: { crow_mcp: ["board"] } };
  const res = writeBotMcp(def, { sessionDir, canonicalPath, crowHome: dir, botId: "railbot" });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.equal(written.mcpServers.board.disabled, true, "no crash — disabled like any other not-available-right-now server");
  assert.ok(res.warnings.some((w) => w.includes("board")), "the reason surfaces in the warnings a bot actually asked for");
  assert.ok(!res.servers.includes("board"));
});

test("a bot that never selects 'board' sees no entry and no warning, even with a token present", () => {
  const { dir, sessionDir, canonicalPath } = boardFixture(null); // token absent too — must still be silent
  const def = { tools: { crow_mcp: ["crow-memory"] } };
  writeFileSync(canonicalPath, JSON.stringify({ mcpServers: {
    "crow-memory": { command: "/n", args: ["servers/memory/index.js"], env: { CROW_DB_PATH: "/db" } },
  } }));
  const res = writeBotMcp(def, { sessionDir, canonicalPath, crowHome: dir, botId: "railbot" });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(!("board" in written.mcpServers), "unselected server is omitted entirely, not even disabled — it was never canonical either");
  assert.ok(!res.warnings.some((w) => w.includes("board")), "never warn about a server the bot didn't ask for");
});
