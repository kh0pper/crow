// tests/bundles-auth-bypass.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bundles.js resolves BUNDLES_DIR/INSTALLED_PATH/MCP_ADDONS_PATH from CROW_HOME at
// module load. Point it at a scratch dir BEFORE importing it: a test that reaches an
// install path must never be able to write the operator's real ~/.crow (it has —
// a bogus-signature RED run against this exact test installed uptime-kuma, real
// docker-compose-up-and-all, on the operator's live host).
process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-test-home-"));
const { default: bundlesRouter } = await import("../servers/gateway/routes/bundles.js");

/** Boot the bundles router alone (as the signed-header bypass reaches it) on an ephemeral port. */
async function withRouter(fn) {
  const app = express();
  app.use(express.json());
  app.use(bundlesRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

// "x-crow-source" is required to get PAST missing_x_crow_source (cross-host-auth.js:427)
// and into the credential/HMAC branch (unknown_peer, since "not-a-real-peer" has no
// signing key). Without it every request short-circuits one branch too early and the
// test would pass even if the credential/HMAC check itself regressed.
const SIGNED = {
  "content-type": "application/json",
  "x-crow-signature": "bogus-not-a-real-hmac",
  "x-crow-source": "not-a-real-peer",
};

test("a bogus x-crow-signature is rejected on every state-changing bundles route", async () => {
  await withRouter(async (base) => {
    for (const path of [
      "/bundles/api/install",
      "/bundles/api/uninstall",
      "/bundles/api/install-set",
      "/bundles/api/restart",     // unauthenticated gateway restart / DoS if unguarded
      "/bundles/api/env",         // unauthenticated secret write if unguarded
    ]) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: SIGNED,
        // "../etc/passwd" can never resolve to a real, installable bundle — even if
        // the auth mount regresses and this request reaches the handler, it fails
        // with 400 invalid_id rather than actually installing something on the host.
        body: JSON.stringify({ bundle_id: "../etc/passwd", collection_id: "home-server", env_vars: { PWNED: "1" } }),
      });
      assert.ok(
        res.status === 401 || res.status === 403,
        `${path} accepted a bogus signature (status ${res.status}) — the x-crow-signature bypass is open`,
      );
    }
  });
});

test("unsigned requests fall through (the dashboard path still works — optional:true)", async () => {
  await withRouter(async (base) => {
    // No signature header → middleware calls next(); the route's own validation answers.
    const res = await fetch(base + "/bundles/api/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: "../etc/passwd" }),
    });
    assert.equal(res.status, 400, "unsigned requests must reach the route (400 invalid id), not be blocked by xhostVerify");
  });
});
