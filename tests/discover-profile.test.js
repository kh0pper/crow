/**
 * /discover/profile field-name regression (follow-up pool, twin of the #165
 * identity-fields fix): the identity object's fields are ed25519Pubkey /
 * secp256k1Pubkey (identity.js), but the endpoint read identity.ed25519Public
 * / identity.secp256k1Public — shipping `undefined` pubkeys in the public
 * discovery profile, which breaks any client trying to add the discovered
 * contact by key.
 *
 * CROW_DATA_DIR is pointed at a scratch dir BEFORE any import that touches
 * identity.js (its DATA_DIR binds at module load) — a fresh throwaway
 * identity is generated there; the real ~/.crow is never read or written.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "discover-profile-"));
const PREV = process.env.CROW_DATA_DIR;
process.env.CROW_DATA_DIR = dir;

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
  cwd: join(import.meta.dirname, ".."),
});

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { createClient } = await import("@libsql/client");
const { mountPeerPublicApi } = await import("../servers/gateway/boot/peer-public-api.js");
const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
const express = (await import("express")).default;

const db = createClient({ url: "file:" + join(dir, "crow.db") });

after(() => {
  try { db.close(); } catch {}
  if (PREV === undefined) delete process.env.CROW_DATA_DIR;
  else process.env.CROW_DATA_DIR = PREV;
  rmSync(dir, { recursive: true, force: true });
});

test("/discover/profile ships REAL hex pubkeys (not undefined) when discovery is enabled", async () => {
  await db.execute("INSERT INTO dashboard_settings (key, value) VALUES ('discovery_enabled', 'true')");
  await db.execute("INSERT INTO dashboard_settings (key, value) VALUES ('discovery_name', 'Test Crow')");

  const app = express();
  await mountPeerPublicApi(app, {
    authMiddleware: null,
    relayDb: db,
    loadDynamicBackends: async () => {},
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/discover/profile`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const identity = loadOrCreateIdentity();
    assert.equal(body.crow_discovery, true);
    assert.equal(body.crow_id, identity.crowId);
    assert.equal(body.display_name, "Test Crow");
    // The regression: these two were undefined (identity.ed25519Public /
    // identity.secp256k1Public do not exist) and vanished from the JSON.
    assert.match(String(body.ed25519_pubkey), /^[0-9a-f]{64}$/, "ed25519_pubkey must be 32-byte hex");
    assert.equal(body.ed25519_pubkey, identity.ed25519Pubkey);
    assert.match(String(body.secp256k1_pubkey), /^[0-9a-f]{66}$/, "secp256k1_pubkey must be 33-byte compressed hex");
    assert.equal(body.secp256k1_pubkey, identity.secp256k1Pubkey);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("/discover/profile stays 404 when discovery is disabled", async () => {
  await db.execute("UPDATE dashboard_settings SET value = 'false' WHERE key = 'discovery_enabled'");
  const app = express();
  await mountPeerPublicApi(app, {
    authMiddleware: null,
    relayDb: db,
    loadDynamicBackends: async () => {},
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/discover/profile`);
    assert.equal(res.status, 404);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
