import { test } from "node:test";
import assert from "node:assert/strict";
import { planInstallSet, validateCollectionServerSide, needsConfigKeys } from "../servers/gateway/routes/bundles.js";
import { getCollection } from "../servers/gateway/dashboard/panels/extensions/collections.js";

test("server-side re-validation accepts the shipped collections", () => {
  for (const id of ["home-server", "education", "research", "development"]) {
    const r = validateCollectionServerSide(getCollection(id));
    assert.equal(r.ok, true, `${id}: ${r.error}`);
  }
});

test("server-side re-validation REFUSES a tampered collection carrying a consent-required member", () => {
  // 'caddy' has consent_required: true on disk. A tampered collections.json must not smuggle it in.
  const tampered = { id: "evil", name: "Evil", description: "", icon: "home", members: [{ id: "caddy", kind: "deploys" }] };
  const r = validateCollectionServerSide(tampered);
  assert.equal(r.ok, false);
  assert.match(r.error, /consent|privileged/i);
});

test("server-side re-validation REFUSES a member that isn't on disk", () => {
  const bogus = { id: "x", name: "X", description: "", icon: "home", members: [{ id: "not-a-bundle", kind: "deploys" }] };
  assert.equal(validateCollectionServerSide(bogus).ok, false);
});

test("the display plan marks already-installed members as skipped", () => {
  const plan = planInstallSet({
    id: "t", members: [{ id: "uptime-kuma", kind: "deploys" }, { id: "definitely-not-installed-xyz", kind: "deploys" }],
  });
  assert.equal(plan.length, 2);
  for (const p of plan) assert.ok(["install", "skip"].includes(p.action));
  const bad = plan.find((p) => p.id === "definitely-not-installed-xyz");
  assert.equal(bad.action, "skip");
  assert.match(bad.reason, /not found/i);
});

test("needsConfigKeys reports manifest-required keys that are EMPTY in the written .env, and nothing else", () => {
  // Keys satisfied by .env.example defaults (DB passwords, secret keys) are already
  // configured — flagging them would invite a post-init change that breaks the app.
  const keys = needsConfigKeys("jellyfin", {
    JELLYFIN_URL: "http://localhost:8096",
    JELLYFIN_API_KEY: "",
  });
  assert.deepEqual(keys, ["JELLYFIN_API_KEY"]);
  assert.deepEqual(needsConfigKeys("jellyfin", { JELLYFIN_URL: "http://x", JELLYFIN_API_KEY: "abc" }), []);
});
