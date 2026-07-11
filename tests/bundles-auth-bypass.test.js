// tests/bundles-auth-bypass.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import bundlesRouter from "../servers/gateway/routes/bundles.js";

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

const SIGNED = { "content-type": "application/json", "x-crow-signature": "bogus-not-a-real-hmac" };

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
        body: JSON.stringify({ bundle_id: "uptime-kuma", collection_id: "home-server", env_vars: { PWNED: "1" } }),
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
