/**
 * Trust-gate regression test.
 *
 * forwardSignedRequest MUST reject any request to a peer with trusted=0
 * BEFORE firing the HTTP call. This test runs the full forwarder path
 * against fake DB rows and asserts:
 *   - trusted=0 peer → structured error `target_not_trusted`, NO fetch
 *   - trusted=1 peer with no credentials → `missing_peer_credentials`,
 *     NO fetch
 *
 * Regression guard: without this, a future refactor that moves the trust
 * check after the fetch would silently leak HMAC-signed requests to
 * freshly-revoked peers for up to 30s.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "crow-trust-gate-test-"));
writeFileSync(join(tmp, "peer-tokens.json"), "{}", { mode: 0o600 });
process.env.CROW_PEER_TOKENS_PATH = join(tmp, "peer-tokens.json");

const { forwardSignedRequest } = await import("../servers/shared/peer-forward.js");

function makeDb(instanceRow) {
  return {
    execute: async (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (sql.includes("FROM cross_host_calls")) return { rows: [] };
      if (sql.startsWith("INSERT INTO cross_host_calls")) return { rowsAffected: 1 };
      // getInstance query
      return { rows: instanceRow ? [instanceRow] : [] };
    },
    close: () => {},
  };
}

// Spy fetch so we can assert it never fired. Use globalThis.fetch so we
// can restore it — tests run sequentially.
let fetchCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response("", { status: 200 });
  };
});

test("trust-gate: trusted=0 peer → target_not_trusted, NO HTTP fetch", async () => {
  const db = makeDb({
    id: "peer-untrusted",
    trusted: 0,
    status: "active",
    gateway_url: "https://untrusted.ts.net",
  });

  const r = await forwardSignedRequest({
    db,
    sourceInstanceId: "local",
    targetInstanceId: "peer-untrusted",
    method: "GET",
    path: "/dashboard/overview",
    auditAction: "federation.overview",
    actor: "trust-gate-test",
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, "target_not_trusted");
  assert.equal(fetchCalls, 0, "fetch must NOT fire for untrusted peer");
});

test("trust-gate: peer not in registry → target_not_registered, NO fetch", async () => {
  const db = makeDb(null);
  const r = await forwardSignedRequest({
    db,
    sourceInstanceId: "local",
    targetInstanceId: "peer-missing",
    method: "GET",
    path: "/dashboard/overview",
    auditAction: "federation.overview",
  });
  assert.equal(r.error, "target_not_registered");
  assert.equal(fetchCalls, 0);
});

test("trust-gate: trusted=1 with missing peer-tokens creds → missing_peer_credentials, NO fetch", async () => {
  const db = makeDb({
    id: "peer-no-creds",
    trusted: 1,
    status: "active",
    gateway_url: "https://nocreds.ts.net",
  });
  const r = await forwardSignedRequest({
    db,
    sourceInstanceId: "local",
    targetInstanceId: "peer-no-creds",
    method: "GET",
    path: "/dashboard/overview",
    auditAction: "federation.overview",
  });
  assert.equal(r.error, "missing_peer_credentials");
  assert.equal(fetchCalls, 0, "fetch must NOT fire without valid peer creds");
});

test("trust-gate: trusted=1 without gateway_url → target_has_no_gateway_url, NO fetch", async () => {
  const db = makeDb({
    id: "peer-no-url",
    trusted: 1,
    status: "active",
    gateway_url: null,
  });
  const r = await forwardSignedRequest({
    db,
    sourceInstanceId: "local",
    targetInstanceId: "peer-no-url",
    method: "GET",
    path: "/dashboard/overview",
    auditAction: "federation.overview",
  });
  assert.equal(r.error, "target_has_no_gateway_url");
  assert.equal(fetchCalls, 0);
});

// Restore real fetch when the suite ends.
test("trust-gate: restore fetch (cleanup)", () => {
  globalThis.fetch = realFetch;
  assert.equal(typeof globalThis.fetch, "function");
});
