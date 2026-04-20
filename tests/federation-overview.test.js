import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFileSync, chmodSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_SOURCE_ID = "test-peer-abc123";
const TEST_AUTH_TOKEN = "aa".repeat(32); // 64 hex chars
const TEST_SIGNING_KEY = "bb".repeat(32); // 64 hex chars

// Stage a peer-tokens.json in a tmpdir and point the peer-credentials
// module at it via CROW_PEER_TOKENS_PATH. This must be set BEFORE the
// module is first imported — the file path is cached at module load.
const tmpDir = mkdtempSync(join(tmpdir(), "crow-federation-test-"));
const peerTokensPath = join(tmpDir, "peer-tokens.json");
const peerTokensContent = {
  [TEST_SOURCE_ID]: {
    auth_token: TEST_AUTH_TOKEN,
    signing_key: TEST_SIGNING_KEY,
    inbound_token: TEST_AUTH_TOKEN,
    created_at: new Date().toISOString(),
    rotated_at: null,
  },
};
writeFileSync(peerTokensPath, JSON.stringify(peerTokensContent), { mode: 0o600 });
chmodSync(peerTokensPath, 0o600);
process.env.CROW_PEER_TOKENS_PATH = peerTokensPath;

// Import AFTER the env var is set.
const { signRequest, _resetNonceCache } = await import("../servers/shared/cross-host-auth.js");
const { default: federationRouterFactory } = await import("../servers/gateway/routes/federation.js");

function fakeDb() {
  return {
    execute: async () => ({
      rows: [{ id: "local-123", name: "grackle", hostname: "grackle-host", is_home: 1 }],
    }),
    close: () => {},
  };
}

// Share ONE express server across every test in this file. Creating a
// fresh listener per-test caused the node test runner to see "async
// activity after test ended" when fetch's default HTTP agent held
// keep-alive sockets open briefly after server.close().
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/dashboard", federationRouterFactory({ createDbClient: fakeDb }));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(() => resolve()));
  }
  try { unlinkSync(peerTokensPath); } catch {}
});

function signedHeaders({ method, path, body = "" }) {
  _resetNonceCache();
  return signRequest({
    method,
    path,
    body,
    authToken: TEST_AUTH_TOKEN,
    signingKey: TEST_SIGNING_KEY,
    sourceInstanceId: TEST_SOURCE_ID,
  });
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("federation: unsigned GET /dashboard/overview → 401 signature_required", async () => {
  const r = await fetch(`${baseUrl}/dashboard/overview`);
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error, "signature_required");
});

test("federation: signed request with missing X-Crow-Source → 401", async () => {
  const r = await fetch(`${baseUrl}/dashboard/overview`, {
    headers: {
      "X-Crow-Signature": "deadbeef".repeat(8),
      "X-Crow-Timestamp": String(Date.now()),
      "X-Crow-Nonce": "0".repeat(32),
    },
  });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error, "missing_x_crow_source");
});

test("federation: signed request from unknown peer → 401 unknown_peer", async () => {
  const r = await fetch(`${baseUrl}/dashboard/overview`, {
    headers: {
      "X-Crow-Signature": "a".repeat(64),
      "X-Crow-Timestamp": String(Date.now()),
      "X-Crow-Nonce": "0".repeat(32),
      "X-Crow-Source": "unknown-peer-id",
    },
  });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error, "unknown_peer");
});

test("federation: valid signed GET /dashboard/overview → 200 + schema", async () => {
  const path = "/dashboard/overview";
  const headers = signedHeaders({ method: "GET", path, body: "" });
  const r = await fetch(`${baseUrl}${path}`, { headers });
  assert.equal(r.status, 200);
  const body = await r.json();

  assert.ok(body.instance, "instance missing");
  assert.equal(body.instance.name, "grackle");
  assert.equal(body.instance.hostname, "grackle-host");
  assert.equal(body.instance.is_home, true);

  assert.ok(Array.isArray(body.tiles), "tiles not an array");
  assert.ok(body.health, "health missing");
  assert.equal(body.health.status, "ok");
  assert.ok(body.health.checkedAt, "health.checkedAt missing");

  for (const t of body.tiles) {
    assert.equal(typeof t.id, "string", `tile.id: ${JSON.stringify(t)}`);
    assert.equal(typeof t.name, "string", `tile.name: ${JSON.stringify(t)}`);
    assert.equal(typeof t.icon, "string", `tile.icon: ${JSON.stringify(t)}`);
    assert.equal(typeof t.pathname, "string", `tile.pathname: ${JSON.stringify(t)}`);
    assert.ok(
      ["local-panel", "bundle", "instance"].includes(t.category),
      `tile.category: ${JSON.stringify(t)}`,
    );
    assert.ok(t.pathname.startsWith("/"), `tile.pathname not absolute: ${t.pathname}`);
    assert.ok(!/^javascript:/i.test(t.pathname), "javascript: URI must never be emitted");
  }
});

test("federation: replay of same signed request → 401 nonce_replay", async () => {
  const path = "/dashboard/overview";
  _resetNonceCache();
  const headers = signRequest({
    method: "GET",
    path,
    body: "",
    authToken: TEST_AUTH_TOKEN,
    signingKey: TEST_SIGNING_KEY,
    sourceInstanceId: TEST_SOURCE_ID,
  });

  const first = await fetch(`${baseUrl}${path}`, { headers });
  assert.equal(first.status, 200, "first call should succeed");

  const second = await fetch(`${baseUrl}${path}`, { headers });
  assert.equal(second.status, 401, "second call with same nonce should 401");
  const body = await second.json();
  assert.equal(body.error, "nonce_replay");
});

test("federation: mismatched signature → 401 hmac_mismatch", async () => {
  const path = "/dashboard/overview";
  const headers = signedHeaders({ method: "GET", path, body: "" });
  const r = await fetch(`${baseUrl}${path}?drift=1`, { headers });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error, "hmac_mismatch");
});
