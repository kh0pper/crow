import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { writeFileSync, chmodSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_SOURCE_ID = "test-peer-mw-1";
const TEST_AUTH_TOKEN = "cc".repeat(32); // 64 hex chars
const TEST_SIGNING_KEY = "dd".repeat(32); // 64 hex chars

// Stage peer-tokens.json BEFORE the module import — the path is cached at load.
const tmpDir = mkdtempSync(join(tmpdir(), "crow-xhost-mw-test-"));
const peerTokensPath = join(tmpDir, "peer-tokens.json");
writeFileSync(peerTokensPath, JSON.stringify({
  [TEST_SOURCE_ID]: {
    auth_token: TEST_AUTH_TOKEN,
    signing_key: TEST_SIGNING_KEY,
    inbound_token: TEST_AUTH_TOKEN,
    created_at: new Date().toISOString(),
    rotated_at: null,
  },
}), { mode: 0o600 });
chmodSync(peerTokensPath, 0o600);
process.env.CROW_PEER_TOKENS_PATH = peerTokensPath;

const { signRequest, _resetNonceCache, crossHostVerifyMiddleware } =
  await import("../servers/shared/cross-host-auth.js");

// Audit sink: capture every audit INSERT the middleware issues. The trust
// lookup (PT-1) reads the peer's crow_instances row: TEST_SOURCE_ID is a
// trusted active peer whose bearer hash matches TEST_AUTH_TOKEN. The row
// matrix itself (untrusted/paused/revoked/missing) is exercised on a REAL DB
// in tests/peer-trust.test.js (U1).
const { createHash } = await import("node:crypto");
const PEER_ROW = {
  id: TEST_SOURCE_ID, status: "active", trusted: 1,
  auth_token_hash: createHash("sha256").update(TEST_AUTH_TOKEN).digest("hex"),
};
const auditStmts = [];
const fakeDb = {
  execute: async (stmt) => {
    if (/FROM crow_instances/.test(stmt.sql)) {
      return { rows: stmt.args[0] === TEST_SOURCE_ID ? [PEER_ROW] : [] };
    }
    auditStmts.push(stmt);
    return { rows: [], rowsAffected: 1 };
  },
  close: () => {},
};
// Every refusal after the source header has one body; the reason is the
// audit row's `error` column (args index 10).
const lastAuditError = () => auditStmts[auditStmts.length - 1]?.args?.[10] ?? null;

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());

  // federation-style: signature required, empty body canonicalizes to ""
  app.get(
    "/required",
    crossHostVerifyMiddleware(fakeDb, { optional: false, audit: "test.required", emptyBodyString: "" }),
    (req, res) => res.json({ reached: true, valid: req.crossHostAuth?.valid === true }),
  );

  // bundles-style: signature optional (pass-through), empty body → "{}"
  app.post(
    "/optional",
    crossHostVerifyMiddleware(fakeDb, {
      optional: true,
      audit: (req) => `bundle.${req.path.split("/").pop() || ""}`,
      auditBundleId: true,
    }),
    (req, res) => res.json({ reached: true, crossHost: req.crossHostAuth || null }),
  );

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  try { unlinkSync(peerTokensPath); } catch {}
});

test("required mode: no signature → 401 signature_required", async () => {
  const r = await fetch(`${baseUrl}/required`);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "signature_required");
});

test("optional mode: no signature → passes through to the handler", async () => {
  const r = await fetch(`${baseUrl}/optional`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle_id: "demo" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reached, true);
  assert.equal(body.crossHost, null); // middleware never set req.crossHostAuth
});

test("signature present but X-Crow-Source missing → 401 missing_x_crow_source", async () => {
  const r = await fetch(`${baseUrl}/required`, {
    headers: {
      "X-Crow-Signature": "ab".repeat(32),
      "X-Crow-Timestamp": String(Date.now()),
      "X-Crow-Nonce": "0".repeat(32),
    },
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "missing_x_crow_source");
});

test("unknown peer → 401 peer_auth_failed + audit row with the reason", async () => {
  const auditCountBefore = auditStmts.length;
  const r = await fetch(`${baseUrl}/required`, {
    headers: {
      "X-Crow-Signature": "ab".repeat(32),
      "X-Crow-Timestamp": String(Date.now()),
      "X-Crow-Nonce": "0".repeat(32),
      "X-Crow-Source": "nobody-knows-me",
    },
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "peer_auth_failed");
  assert.equal(lastAuditError(), "peer_not_trusted:unknown");
  assert.ok(auditStmts.length > auditCountBefore, "expected an audit INSERT");
  assert.match(auditStmts[auditStmts.length - 1].sql, /INSERT INTO cross_host_calls/);
});

test("bad signature (path tampered) → 401 peer_auth_failed, audit hmac_mismatch", async () => {
  _resetNonceCache();
  const headers = signRequest({
    method: "GET",
    path: "/required",
    body: "",
    authToken: TEST_AUTH_TOKEN,
    signingKey: TEST_SIGNING_KEY,
    sourceInstanceId: TEST_SOURCE_ID,
  });
  const r = await fetch(`${baseUrl}/required?tampered=1`, { headers });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "peer_auth_failed");
  assert.equal(lastAuditError(), "hmac_mismatch");
});

test("valid signed GET in required mode → 200, req.crossHostAuth.valid", async () => {
  _resetNonceCache();
  const headers = signRequest({
    method: "GET",
    path: "/required",
    body: "",
    authToken: TEST_AUTH_TOKEN,
    signingKey: TEST_SIGNING_KEY,
    sourceInstanceId: TEST_SOURCE_ID,
  });
  const r = await fetch(`${baseUrl}/required`, { headers });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reached, true);
  assert.equal(body.valid, true);
});

test("valid signed POST in optional mode → 200, crossHostAuth carries source", async () => {
  _resetNonceCache();
  const rawBody = JSON.stringify({ bundle_id: "demo-bundle" });
  const headers = signRequest({
    method: "POST",
    path: "/optional",
    body: rawBody,
    authToken: TEST_AUTH_TOKEN,
    signingKey: TEST_SIGNING_KEY,
    sourceInstanceId: TEST_SOURCE_ID,
  });
  const r = await fetch(`${baseUrl}/optional`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: rawBody,
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reached, true);
  assert.equal(body.crossHost.valid, true);
  assert.equal(body.crossHost.sourceInstanceId, TEST_SOURCE_ID);
});

test("optional mode: INVALID signature must 401, never fall through to the handler", async () => {
  _resetNonceCache();
  const rawBody = JSON.stringify({ bundle_id: "demo-bundle" });
  const headers = signRequest({
    method: "POST",
    path: "/optional",
    body: rawBody,
    authToken: TEST_AUTH_TOKEN,
    signingKey: TEST_SIGNING_KEY,
    sourceInstanceId: TEST_SOURCE_ID,
  });
  // Tamper the query string after signing — canonical path no longer matches.
  const r = await fetch(`${baseUrl}/optional?tampered=1`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: rawBody,
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "peer_auth_failed");
  assert.equal(lastAuditError(), "hmac_mismatch");
});
