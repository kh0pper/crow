import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFileSync, chmodSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_SOURCE_ID = "test-peer-roster123";
const TEST_AUTH_TOKEN = "cc".repeat(32); // 64 hex chars
const TEST_SIGNING_KEY = "dd".repeat(32); // 64 hex chars

// Stage a peer-tokens.json in a tmpdir and point the peer-credentials
// module at it via CROW_PEER_TOKENS_PATH. This must be set BEFORE the
// module is first imported — the file path is cached at module load.
const tmpDir = mkdtempSync(join(tmpdir(), "crow-roster-test-"));
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
const { rejectFunneledMiddleware } = await import("../servers/gateway/funnel.js");

// fakeDb: returns the local instance row for getInstance queries, and
// empty rows for everything else (buildAdvertisementPayload → listAdvertisedBots
// returns [] → bots: [] in the payload).
function fakeDb() {
  let callCount = 0;
  return {
    execute: async (opts) => {
      const sql = typeof opts === "string" ? opts : (opts?.sql ?? "");
      // getInstance looks up by id — return a matching row
      if (sql.includes("crow_instances") && sql.includes("WHERE")) {
        return {
          rows: [{ id: "local-123", name: "grackle", hostname: "grackle-host", is_home: 1 }],
        };
      }
      // listAdvertisedBots and any other query → empty result
      return { rows: [] };
    },
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
  // Funnel reject BEFORE the dashboard mount — matches the production
  // layout in servers/gateway/index.js so these tests exercise the real
  // middleware ordering, not a synthetic convenience.
  app.use(rejectFunneledMiddleware());
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

// Case 1: Correctly-signed paired peer → 200 with bots array
test("roster-advertise: valid signed GET /dashboard/advertised-bots → 200 + { bots: [] }", async () => {
  const path = "/dashboard/advertised-bots";
  const headers = signedHeaders({ method: "GET", path, body: "" });
  const r = await fetch(`${baseUrl}${path}`, { headers });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const body = await r.json();
  assert.ok(Object.hasOwn(body, "bots"), "response must have a 'bots' key");
  assert.ok(Array.isArray(body.bots), "bots must be an array");
  // In the test environment, no qualifying bots exist (no identity.json), so
  // the array is empty. The route + auth gate are the load-bearing assertions.
  assert.deepEqual(body.bots, []);
});

// Case 2: Unsigned caller → non-200 (rejected by the gate)
test("roster-advertise: unsigned GET /dashboard/advertised-bots → 401", async () => {
  const r = await fetch(`${baseUrl}/dashboard/advertised-bots`);
  assert.notEqual(r.status, 200, "unsigned request must not get 200");
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error, "signature_required");
});

// Case 3: Funnel-marked request (even if otherwise signed) → non-200
test("roster-advertise: Tailscale-Funnel-Request header → 403 (Funnel-blocked)", async () => {
  const path = "/dashboard/advertised-bots";
  const headers = signedHeaders({ method: "GET", path, body: "" });
  headers["Tailscale-Funnel-Request"] = "1";
  const r = await fetch(`${baseUrl}${path}`, { headers });
  assert.notEqual(r.status, 200, "funneled request must not get 200");
  assert.equal(r.status, 403);
  const text = await r.text();
  assert.match(text, /Forbidden/i);
});
