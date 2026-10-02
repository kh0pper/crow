/**
 * The 60 s federation probe (proxy.js loadRemoteInstances) against a revoke
 * (review I2 / C1). Driven for real: a scratch DB via CROW_DB_PATH, a stubbed
 * global fetch, and the module's own connectedServers map.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { loadRemoteInstances, connectedServers } from "../servers/gateway/proxy.js";
import { revokeInstance } from "../servers/gateway/instance-registry.js";
import { getPeerProbeHealth, _resetPeerProbeHealth } from "../servers/gateway/peer-probe-health.js";

const dir = mkdtempSync(join(tmpdir(), "probe-revoke-"));
const saved = { CROW_DB_PATH: process.env.CROW_DB_PATH, CROW_DATA_DIR: process.env.CROW_DATA_DIR };
process.env.CROW_DB_PATH = join(dir, "crow.db");
process.env.CROW_DATA_DIR = dir;
writeFileSync(join(dir, "instance-id"), "self\n");
const realFetch = globalThis.fetch;
const db = createDbClient(join(dir, "crow.db"));

after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { db.close?.(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

await db.execute(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT NOT NULL, crow_id TEXT NOT NULL,
  hostname TEXT, gateway_url TEXT, is_home INTEGER DEFAULT 0, auth_token_hash TEXT, last_seen_at TEXT,
  status TEXT DEFAULT 'active', trusted INTEGER DEFAULT 1, updated_at TEXT)`);

async function status(id) {
  return (await db.execute({ sql: "SELECT status FROM crow_instances WHERE id = ?", args: [id] })).rows[0]?.status;
}

test("a revoke that lands while the probe is in flight is not overwritten by the failure path", async () => {
  _resetPeerProbeHealth();
  await db.execute("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status) VALUES ('p1', 'P1', 'c', 'http://127.0.0.1:9', 'active')");
  globalThis.fetch = async () => {
    await revokeInstance(db, "p1"); // the operator revokes mid-probe
    throw new Error("connect ECONNREFUSED");
  };
  const warn = console.warn; console.warn = () => {};
  try { await loadRemoteInstances(); } finally { console.warn = warn; }
  assert.equal(await status("p1"), "revoked", "the probe's 'offline' write must not clobber the revoke");
  assert.ok(getPeerProbeHealth().p1?.failingSince, "the failed probe is still recorded for the peers signal");
});

test("a live federated connection to a peer revoked elsewhere is dropped on the next probe", async () => {
  await db.execute("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status) VALUES ('p2', 'P2', 'c', 'http://127.0.0.1:9', 'active')");
  let closed = 0;
  connectedServers.set("instance-p2", { client: { close() { closed++; } }, tools: [], status: "connected", isRemote: true, instanceId: "p2" });
  // Revoked by ANOTHER process: a direct row write, no in-process bus event.
  await db.execute("UPDATE crow_instances SET status = 'revoked' WHERE id = 'p2'");
  globalThis.fetch = async () => { throw new Error("unreachable"); };
  const warn = console.warn; console.warn = () => {};
  try { await loadRemoteInstances(); } finally { console.warn = warn; }
  assert.equal(connectedServers.has("instance-p2"), false);
  assert.equal(closed, 1);
});

test("an in-process revoke drops the live federated connection immediately (bus event)", async () => {
  await db.execute("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status) VALUES ('p3', 'P3', 'c', 'http://127.0.0.1:9', 'active')");
  let closed = 0;
  connectedServers.set("instance-p3", { client: { close() { closed++; } }, tools: [], status: "connected", isRemote: true, instanceId: "p3" });
  await revokeInstance(db, "p3");
  assert.equal(connectedServers.has("instance-p3"), false);
  assert.equal(closed, 1);
});

test("a connected peer whose /health fails is recorded as failing and its last_seen_at is not refreshed", async () => {
  _resetPeerProbeHealth();
  await db.execute("INSERT INTO crow_instances (id, name, crow_id, gateway_url, status, last_seen_at) VALUES ('p4', 'P4', 'c', 'http://127.0.0.1:9', 'active', '2000-01-01 00:00:00')");
  connectedServers.set("instance-p4", { client: { close() {} }, tools: [], status: "connected", isRemote: true, instanceId: "p4" });
  globalThis.fetch = async () => { throw new Error("timeout"); };
  const warn = console.warn; const log = console.log; console.warn = () => {}; console.log = () => {};
  try { await loadRemoteInstances(); } finally { console.warn = warn; console.log = log; }
  const { rows } = await db.execute("SELECT last_seen_at FROM crow_instances WHERE id = 'p4'");
  assert.equal(rows[0].last_seen_at, "2000-01-01 00:00:00");
  assert.ok(getPeerProbeHealth().p4?.failingSince);
  connectedServers.delete("instance-p4");
});
