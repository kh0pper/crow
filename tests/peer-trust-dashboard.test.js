/**
 * PT-1, dashboard side: the SSO accept route applies the one trust predicate
 * and answers every refusal with one body; the Nest shows peer-trust items.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRealDb } from "./fixtures/sync-fleet.mjs";

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("U9 (dashboard): the SSO accept route checks peerTrust and has one refusal body", () => {
  const s = src("servers/gateway/dashboard/index.js");
  const i = s.indexOf('router.get("/dashboard/sso/accept"');
  assert.ok(i > 0);
  const body = s.slice(i, s.indexOf("// --- Protected routes ---", i));
  assert.match(body, /\bpeerTrust\(/);
  assert.doesNotMatch(body, /Unknown source instance|is not trusted|Invalid SSO ticket/, "no per-reason refusal text");
  assert.ok((body.match(/Single sign-on refused\./g) || []).length >= 4);
});

test("both 2FA completions turn a refused SSO mint into the login page, not a 500", () => {
  const s = src("servers/gateway/dashboard/index.js");
  assert.equal((s.match(/err\?\.code !== "sso_refused"/g) || []).length, 3, "TOTP, recovery and accept all handle sso_refused");
  assert.match(src("servers/gateway/dashboard/shared/i18n.js"), /"login\.ssoRefused":/);
});

test("the Revoke confirm text says the key is deleted and re-pairing undoes it (en + es)", () => {
  const line = src("servers/gateway/dashboard/shared/i18n.js").split("\n").find((l) => l.includes('"settings.pairedRevokeConfirm"'));
  assert.match(line, /signing key is deleted now/);
  assert.match(line, /re-pair/);
  assert.doesNotMatch(line, /crow_update_instance/);
});

test("Nest: peer-trust items appear as issues (lookup failure warn; untrusted and orphan info)", async () => {
  const { collectHealthSignals, invalidateHealthCache } = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  const h = await import("../servers/shared/peer-trust-health.js");
  const d = mkdtempSync(join(tmpdir(), "pt-nest-"));
  const db = await makeRealDb(d);
  try {
    h._resetPeerTrustHealth();
    h.recordTrustLookupFailure("peer-x", "boom");
    h.setUntrustedWithCreds([{ id: "peer-y", name: "Laptop" }]);
    h.setOrphanKeys(["peer-z"]);
    invalidateHealthCache();
    const r = await collectHealthSignals(db, { lang: "en" });
    const ids = r.issues.map((i) => i.id);
    assert.ok(ids.includes("peer-trust:lookup:peer-x"));
    assert.ok(ids.includes("peer-trust:untrusted:peer-y"));
    assert.ok(ids.includes("peer-trust:orphan:peer-z"));
    assert.equal(r.issues.find((i) => i.id === "peer-trust:lookup:peer-x").severity, "warn");
    assert.match(r.issues.find((i) => i.id === "peer-trust:untrusted:peer-y").label, /Laptop.*re-pair or revoke/);
    h._resetPeerTrustHealth();
    invalidateHealthCache();
    const clean = await collectHealthSignals(db, { lang: "en" });
    assert.equal(clean.issues.some((i) => i.id.startsWith("peer-trust:")), false, "positive control: no items when healthy");
  } finally { try { db.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
});
