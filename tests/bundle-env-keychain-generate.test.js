/** generate + keychain + store_as, generatable opt-in (Crow keychain, Task 2). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const S = await import("../servers/gateway/bundle-env-secrets.js");
const P = await import("../servers/gateway/keychain/argon2-phc.js");
const scratch = (p) => mkdtempSync(join(tmpdir(), p));

const VW = {
  id: "vw-demo",
  env_vars: [
    { name: "VW_DOMAIN", default: "http://localhost:8097" },
    { name: "VW_ADMIN_TOKEN", secret: true, generate: "secret", keychain: true, store_as: "argon2id", keychain_url: "${VW_DOMAIN}/admin" },
    { name: "VW_PLAIN", secret: true, generate: "secret", keychain: true },
    { name: "VW_INTERNAL", generate: "secret" },
    { name: "VW_ADMIN_PASSWORD", secret: true, generatable: true, propagate: false },
    { name: "VW_API_KEY", secret: true },
  ],
};

test("argon2idPhc emits the exact Vaultwarden-accepted PHC shape and verifies", () => {
  const phc = P.argon2idPhc("token-123");
  assert.match(phc, /^\$argon2id\$v=19\$m=65540,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(P.verifyArgon2idPhc("token-123", phc), true);
  assert.equal(P.verifyArgon2idPhc("token-124", phc), false);
  assert.equal(P.verifyArgon2idPhc("token-123", "$argon2id$garbage"), false);
});

test("a fixed salt gives a deterministic hash (the format is not a random blob)", () => {
  const salt = Buffer.alloc(16, 7);
  assert.equal(P.argon2idPhc("x", { salt }), P.argon2idPhc("x", { salt }));
});

test("C5 — planGeneratedEnv persists NOTHING until persist(); then the retained copy holds the HASH", () => {
  const home = scratch("h-");
  const plan = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d-"), crowHome: home });
  assert.deepEqual(Object.keys(plan.minted).sort(), ["VW_ADMIN_TOKEN", "VW_PLAIN"], "VW_INTERNAL is not keychain:true");
  assert.match(plan.minted.VW_ADMIN_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(P.verifyArgon2idPhc(plan.minted.VW_ADMIN_TOKEN, plan.env.VW_ADMIN_TOKEN), true);
  assert.equal(plan.env.VW_PLAIN, plan.minted.VW_PLAIN, "no store_as → plaintext in .env");
  assert.equal(existsSync(S.retainedEnvPath(home, "vw-demo")), false, "nothing on disk before the keychain save");
  plan.persist();
  const text = readFileSync(S.retainedEnvPath(home, "vw-demo"), "utf8");
  assert.equal(S.parseEnvText(text).VW_ADMIN_TOKEN, plan.env.VW_ADMIN_TOKEN);
  assert.ok(!text.includes(plan.minted.VW_ADMIN_TOKEN));
});

test("C5 — an un-persisted plan (keychain save failed) mints a NEW token on retry", () => {
  const home = scratch("h-");
  const a = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d1-"), crowHome: home });
  const b = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d2-"), crowHome: home });
  assert.notEqual(b.minted.VW_ADMIN_TOKEN, a.minted.VW_ADMIN_TOKEN);
});

test("reinstall after persist mints nothing: the stored hash is reused and `minted` is empty", () => {
  const home = scratch("h-");
  const first = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d1-"), crowHome: home });
  first.persist();
  const second = S.planGeneratedEnv("vw-demo", VW, { destDir: scratch("d2-"), crowHome: home });
  assert.deepEqual(second.env, first.env);
  assert.deepEqual(second.minted, {});
});

test("an installed .env value (e.g. a typed legacy plaintext token) wins and is not re-hashed", () => {
  const dest = scratch("d-");
  writeFileSync(join(dest, ".env"), "VW_ADMIN_TOKEN=legacy-typed-token\n");
  const { env, minted } = S.planGeneratedEnv("vw-demo", VW, { destDir: dest, crowHome: scratch("h-") });
  assert.equal(env.VW_ADMIN_TOKEN, "legacy-typed-token");
  assert.equal(minted.VW_ADMIN_TOKEN, undefined);
});

test("C5 — resolveGeneratedEnv refuses keychain manifests; still works (and persists) for plain ones", () => {
  assert.throws(() => S.resolveGeneratedEnv("vw-demo", VW, { destDir: scratch("d-"), crowHome: scratch("h-") }), /planGeneratedEnv/);
  const home = scratch("h-");
  const out = S.resolveGeneratedEnv("plain", { env_vars: [{ name: "X", generate: "secret" }] }, { destDir: scratch("d-"), crowHome: home });
  assert.match(out.X, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(existsSync(S.retainedEnvPath(home, "plain")));
});

test("Q1 — keychain eligibility is opt-in; third-party secrets are not offered", () => {
  assert.deepEqual(S.keychainGeneratedKeys(VW), ["VW_ADMIN_TOKEN", "VW_PLAIN"]);
  assert.deepEqual(S.keychainEligibleKeys(VW), ["VW_ADMIN_PASSWORD"], "VW_API_KEY (third-party) is not eligible");
  assert.equal(S.expandKeychainTemplate("${VW_DOMAIN}/admin", { VW_DOMAIN: "http://h:1" }), "http://h:1/admin");
  assert.equal(S.expandKeychainTemplate("${VW_DOMAIN}/admin", { VW_DOMAIN: "" }), null, "a blank var drops the field");
  assert.equal(S.expandKeychainTemplate("${NOPE}", {}), null);
  assert.equal(S.expandKeychainTemplate("admin", {}), "admin");
  assert.equal(S.expandKeychainTemplate(undefined, {}), null);
});

test("bundle contract: store_as / keychain / generatable combinations", () => {
  const base = { id: "x", name: "x", description: "d", type: "bundle", category: "productivity", version: "1.0.0" };
  const errs = (env_vars) => validateManifest({ ...base, env_vars }, scratch("b-")).errors.join("\n");
  assert.match(errs([{ name: "A", store_as: "argon2id", generate: "secret" }]), /store_as.*keychain/);
  assert.match(errs([{ name: "A", store_as: "argon2id", keychain: true }]), /store_as.*generate/);
  assert.match(errs([{ name: "A", store_as: "bcrypt", generate: "secret", keychain: true }]), /store_as/);
  assert.match(errs([{ name: "A", keychain: true }]), /keychain.*secret/);
  assert.match(errs([{ name: "A", generatable: true, propagate: false }]), /generatable needs secret/);
  assert.match(errs([{ name: "A", generatable: true, secret: true }]), /generatable needs propagate: false/);
  assert.match(errs([{ name: "A", generatable: true, secret: true, propagate: false, generate: "secret" }]), /cannot be combined with generate/);
  // F1: keychain_configure is a boolean, only meaningful on keychain/generatable fields
  assert.match(errs([{ name: "A", generatable: true, secret: true, propagate: false, keychain_configure: "no" }]), /keychain_configure.*boolean/);
  assert.match(errs([{ name: "A", secret: true, keychain_configure: false }]), /keychain_configure only applies/);
  assert.doesNotMatch(errs([{ name: "A", generatable: true, secret: true, propagate: false, keychain_configure: false }]), /keychain_configure/);
  assert.doesNotMatch(errs([
    { name: "A", secret: true, generate: "secret", keychain: true, store_as: "argon2id" },
    { name: "B", secret: true, generatable: true, propagate: false },
  ]), /store_as|keychain|generatable/);
});
