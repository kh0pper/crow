import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInstall } from "../servers/gateway/routes/bundles.js";

test("invalid bundle id → 400 invalid_id", async () => {
  const r = await validateInstall("../../etc/passwd");
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, "invalid_id");
});

test("unknown bundle → 404 not_found", async () => {
  const r = await validateInstall("definitely-not-a-real-bundle");
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.code, "not_found");
});

test("privileged/consent bundle without a token → 403 consent_required", async () => {
  // 'caddy' declares consent_required: true in its on-disk manifest.
  const r = await validateInstall("caddy", {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "consent_required");
});

test("a plain, non-consent, non-GPU bundle passes and returns its manifest + installed snapshot", async () => {
  const r = await validateInstall("uptime-kuma", { forceInstall: true });
  // forceInstall skips the hardware gate so this test is machine-independent.
  if (r.ok === false && r.code === "already_installed") return; // acceptable on a host where it's installed
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, "uptime-kuma");
  assert.ok(Array.isArray(r.installed));
  assert.equal(r.consentVerified, false);
});
