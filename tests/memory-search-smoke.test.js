/**
 * Memory store+search smoke (W5.5) — pins that crow_search_memories keeps
 * working through the sqlite-vec legacy-path removal. The embedding provider
 * may or may not be reachable in this env; FTS results are always merged in,
 * so the assertion is provider-independent.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
let dataDir;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memsmoke-"));
  process.env.CROW_DATA_DIR = dataDir;
  process.env.CROW_DB_PATH = join(dataDir, "t.db");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env }, stdio: "pipe", cwd: repoRoot,
  });
});

test("store a memory, then find it via crow_search_memories", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMemoryServer } = await import("../servers/memory/server.js");

  const server = createMemoryServer();
  const client = new Client({ name: "memsmoke", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const stored = await client.callTool({
    name: "crow_store_memory",
    arguments: { content: "The heron lands at xylophone bridge", category: "general" },
  });
  assert.ok(!stored.isError, JSON.stringify(stored.content));

  const found = await client.callTool({
    name: "crow_search_memories",
    arguments: { query: "xylophone" },
  });
  assert.ok(!found.isError, JSON.stringify(found.content));
  const text = found.content.map((c) => c.text || "").join("\n");
  assert.match(text, /xylophone bridge/);

  await client.close();
  rmSync(dataDir, { recursive: true, force: true });
});
