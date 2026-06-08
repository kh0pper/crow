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
  return { dir, sessionDir, canonicalPath };
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
  const { sessionDir, canonicalPath } = fixture();
  const def = { tools: { crow_mcp: ["crow-memory"], remote_mcp: ["g1abcdef::crow-memory"] } };
  const res = writeBotMcp(def, {
    sessionDir, canonicalPath, crowHome: "/tmp/none",
    remoteEnabled: true,
    peerGatewayUrls: { g1abcdef: "https://g1:8444" },
  });
  const written = JSON.parse(readFileSync(join(sessionDir, ".mcp.json"), "utf8"));
  assert.ok(written.mcpServers["crow-memory"], "local server still present");
  const remote = written.mcpServers["crow-remote-g1abcdef-crow-memory"];
  assert.ok(remote, "remote forward-proxy block minted");
  assert.equal(remote.env.CROW_REMOTE_GATEWAY_URL, "https://g1:8444");
  assert.equal(remote.env.CROW_REMOTE_MOUNT, "/memory");
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
