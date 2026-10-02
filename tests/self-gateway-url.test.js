/**
 * Self-row gateway_url (queued minor 2026-09-24): an operator can now pin
 * the URL peers dial via CROW_PEER_GATEWAY_URL, and it corrects a drifted
 * existing row. CROW_GATEWAY_URL is NOT used: it is the public URL (on crow,
 * the Funnel host, which refuses private routes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { configuredSelfGatewayUrl, ensureLocalInstanceRegistered } from "../servers/gateway/instance-registry.js";

test("configuredSelfGatewayUrl: only CROW_PEER_GATEWAY_URL, validated and normalized", () => {
  assert.equal(configuredSelfGatewayUrl({}), null);
  assert.equal(configuredSelfGatewayUrl({ CROW_GATEWAY_URL: "https://crow.example.ts.net" }), null);
  assert.equal(configuredSelfGatewayUrl({ CROW_PEER_GATEWAY_URL: "https://r4.example.ts.net:8449/" }), "https://r4.example.ts.net:8449");
  assert.equal(configuredSelfGatewayUrl({ CROW_PEER_GATEWAY_URL: "http://0.0.0.0:3001" }), null);
  assert.equal(configuredSelfGatewayUrl({ CROW_PEER_GATEWAY_URL: "not a url" }), null);
  assert.equal(configuredSelfGatewayUrl({ CROW_PEER_GATEWAY_URL: "ftp://x.example" }), null);
  for (const lo of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001", "https://app.localhost"]) {
    assert.equal(configuredSelfGatewayUrl({ CROW_PEER_GATEWAY_URL: lo }), null, lo);
  }
});

async function withSelfRow(gatewayUrl, fn) {
  const dir = mkdtempSync(join(tmpdir(), "self-gw-"));
  const prev = process.env.CROW_DATA_DIR;
  process.env.CROW_DATA_DIR = dir;
  writeFileSync(join(dir, "instance-id"), "self\n");
  const db = createDbClient(join(dir, "crow.db"));
  try {
    await db.execute(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, crow_id TEXT, hostname TEXT,
      tailscale_ip TEXT, gateway_url TEXT, sync_url TEXT, sync_profile TEXT, topics TEXT, is_home INTEGER DEFAULT 0,
      auth_token_hash TEXT, status TEXT DEFAULT 'active', trusted INTEGER DEFAULT 0, directory TEXT,
      last_seen_at TEXT, updated_at TEXT)`);
    await db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, gateway_url) VALUES ('self', 'me', 'c', ?)", args: [gatewayUrl] });
    await fn(db);
  } finally {
    if (prev === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prev;
    db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const urlOf = async (db) => (await db.execute("SELECT gateway_url FROM crow_instances WHERE id = 'self'")).rows[0].gateway_url;

test("a configured URL corrects a drifted existing self row", async () => {
  await withSelfRow("https://r4.example.ts.net:8448", async (db) => {
    await ensureLocalInstanceRegistered(db, { crowId: "c", gatewayUrl: "https://r4.example.ts.net:8449", gatewayUrlConfigured: true });
    assert.equal(await urlOf(db), "https://r4.example.ts.net:8449");
  });
});

test("an auto-detected URL never overwrites an existing self row", async () => {
  await withSelfRow("https://r4.example.ts.net:8448", async (db) => {
    await ensureLocalInstanceRegistered(db, { crowId: "c", gatewayUrl: "https://r4.example.ts.net:9999" });
    assert.equal(await urlOf(db), "https://r4.example.ts.net:8448");
  });
});
