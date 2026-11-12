/**
 * Task 1.1 — the add-on secret classifier, the sealing predicate, the entry-field reader,
 * and the unsealer role registry.
 *
 * Everything here is a pure function of its arguments (no DB, no ~/.crow): secrets are
 * sentinels, and no console output this module produces may contain one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  ADDON_KEYCHAIN_FIELD, ADDON_KEY_KIND, ADDON_SECRET_SHARES, MIGRATION_ROW_CONFLICT,
  addonSecretsSealingOn, isAddonSecretKey, keychainEnvNames, processUnsealer,
  registerAddonUnsealer, sealableEnv,
} from "../servers/shared/addon-secrets.js";
import { captureOutput } from "./helpers/sentinel-scan.mjs";

const SENTINEL = "sentinel-" + randomUUID();
const SENTINEL2 = "sentinel-" + randomUUID();
const SENTINEL3 = "sentinel-" + randomUUID();
const tmp = () => mkdtempSync(join(tmpdir(), "crow-addon-secrets-"));

// ─── the on-disk contract constants ─────────────────────────────────────────

test("constants: the field, the kind, the conflict rule, and the frozen share table", () => {
  assert.equal(ADDON_KEYCHAIN_FIELD, "keychainEnv");
  assert.equal(ADDON_KEY_KIND, "extension");
  assert.equal(MIGRATION_ROW_CONFLICT, "file");
  assert.deepEqual(ADDON_SECRET_SHARES, { "sunvox-studio": { funkwhale: ["FUNKWHALE_URL", "FUNKWHALE_ACCESS_TOKEN"] } });
  assert.ok(Object.isFrozen(ADDON_SECRET_SHARES), "the switch is a code change, not a runtime toggle");
  assert.ok(Object.isFrozen(ADDON_SECRET_SHARES["sunvox-studio"]));
  assert.ok(Object.isFrozen(ADDON_SECRET_SHARES["sunvox-studio"].funkwhale));
});

// ─── isAddonSecretKey ───────────────────────────────────────────────────────

test("classifier: a secret-marked credential is a secret; locations, public halves, ids and plain counters are not", () => {
  assert.equal(isAddonSecretKey("HA_TOKEN", { name: "HA_TOKEN", secret: true }), true);
  assert.equal(isAddonSecretKey("HA_TOKEN"), true, "the name alone reads like a credential");
  assert.equal(isAddonSecretKey("HA_PASSWORD", { name: "HA_PASSWORD" }), true);
  assert.equal(isAddonSecretKey("MCP_API_KEY", { name: "MCP_API_KEY" }), true);

  for (const name of ["GOOGLE_TOKEN_FILE", "HA_URL", "FOO_BASE_URL", "X_PATH", "CACHE_DIR", "BROKER_HOST", "WEB_PORT"]) {
    assert.equal(isAddonSecretKey(name, { name }), false, `${name} is a location, not a credential`);
  }
  assert.equal(isAddonSecretKey("MASTODON_VAPID_PUBLIC_KEY", { name: "MASTODON_VAPID_PUBLIC_KEY", generate: "vapid_public_key" }), false);
  assert.equal(isAddonSecretKey("MASTODON_VAPID_PUBLIC_KEY"), false, "a public half is public by name too");
  assert.equal(isAddonSecretKey("GARAGE_KEY_ID", { name: "GARAGE_KEY_ID", generate: "garage_key_id" }), false);
  assert.equal(isAddonSecretKey("MAX_TOKENS"), false, "a counter is not a credential");
});

test("classifier: a store_as field is never sealed (its keychain row holds the plaintext), an explicit secret:true wins", () => {
  assert.equal(isAddonSecretKey("WORKSPACE_ADMIN_PASSWORD_HASH", { name: "WORKSPACE_ADMIN_PASSWORD_HASH", store_as: "WORKSPACE_ADMIN_PASSWORD" }), false);
  assert.equal(isAddonSecretKey("VAPID_PUBLIC_KEY", { name: "VAPID_PUBLIC_KEY", secret: true }), true, "the manifest may override the name rule");
  assert.equal(isAddonSecretKey("SOME_NAME", { name: "SOME_NAME", secret: true }), true);
});

test("classifier: generate kinds — a credential kind is sealed, a public one is not", () => {
  for (const generate of ["secret", "laravel_key", "vapid_private_key", "hex32"]) {
    assert.equal(isAddonSecretKey("SOMETHING_ODD", { name: "SOMETHING_ODD", generate }), true, generate);
  }
  for (const generate of ["vapid_public_key", "garage_key_id"]) {
    assert.equal(isAddonSecretKey("SOMETHING_ODD", { name: "SOMETHING_ODD", generate }), false, generate);
  }
});

test("classifier: a loader name is never a secret, whatever the manifest says", () => {
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "PYTHONSTARTUP", "node_options"]) {
    assert.equal(isAddonSecretKey(name, { name, secret: true }), false, name);
    assert.equal(isAddonSecretKey(name, { name, generate: "secret" }), false, name);
  }
});

// ─── sealableEnv ────────────────────────────────────────────────────────────

const MANIFEST = {
  env_vars: [
    { name: "HA_TOKEN", secret: true },
    { name: "HA_URL" },
    { name: "GOOGLE_TOKEN_FILE" },
    { name: "MAX_TOKENS", default: "2048" },
    { name: "WORKSPACE_ADMIN_PASSWORD", secret: true, keychain_configure: false },
    { name: "WORKSPACE_ADMIN_PASSWORD_HASH", store_as: "WORKSPACE_ADMIN_PASSWORD" },
    { name: "NODE_OPTIONS" },
  ],
};

test("sealableEnv: only the credential goes to the keychain; a default value, a store_as hash and a non-configure field stay plain", () => {
  const out = sealableEnv({
    HA_TOKEN: SENTINEL,
    HA_URL: "http://ha.local:8123",
    GOOGLE_TOKEN_FILE: "/tmp/google-token.json",
    MAX_TOKENS: "2048",
    WORKSPACE_ADMIN_PASSWORD: SENTINEL2,
    WORKSPACE_ADMIN_PASSWORD_HASH: SENTINEL3,
    NODE_OPTIONS: "--require /tmp/x.js",
  }, MANIFEST);
  assert.deepEqual(out.seal, { HA_TOKEN: SENTINEL });
  assert.deepEqual(Object.keys(out.keep).sort(), [
    "GOOGLE_TOKEN_FILE", "HA_URL", "MAX_TOKENS", "NODE_OPTIONS", "WORKSPACE_ADMIN_PASSWORD", "WORKSPACE_ADMIN_PASSWORD_HASH",
  ]);
  assert.equal(out.keep.MAX_TOKENS, "2048", "equal to the manifest default: nothing to keep secret");
});

test("sealableEnv: a listed name is authoritative — sealed even when the classifier would keep it plain", () => {
  const out = sealableEnv({ HA_URL: "http://ha.local:8123", SOME_SETTING: SENTINEL, MAX_TOKENS: "4096" }, MANIFEST, {
    listed: ["HA_URL", "SOME_SETTING", "MAX_TOKENS"],
  });
  assert.deepEqual(out.seal, { HA_URL: "http://ha.local:8123", SOME_SETTING: SENTINEL, MAX_TOKENS: "4096" });
  assert.deepEqual(out.keep, {});
});

test("sealableEnv: empty, non-string and loader values are never sealed; no manifest at all still reads the name", () => {
  const out = sealableEnv({ HA_TOKEN: SENTINEL, EMPTY_ONE: "", NULL_ONE: null, NODE_OPTIONS: "--require x", OTHER_TOKEN: SENTINEL2 }, null);
  assert.deepEqual(out.seal, { HA_TOKEN: SENTINEL, OTHER_TOKEN: SENTINEL2 });
  assert.deepEqual(Object.keys(out.keep).sort(), ["EMPTY_ONE", "NODE_OPTIONS", "NULL_ONE"]);
});

test("sealableEnv: nothing to do for an empty or missing env", () => {
  assert.deepEqual(sealableEnv({}, MANIFEST), { seal: {}, keep: {} });
  assert.deepEqual(sealableEnv(null, null), { seal: {}, keep: {} });
});

// ─── addonSecretsSealingOn ──────────────────────────────────────────────────

test("sealing predicate: PR1 ships OFF, the operator can say 0, and a split-DB host is off even when it says 1", () => {
  const dir = tmp();
  assert.equal(addonSecretsSealingOn({}), false, "PR1: nothing seals until the switch is explicitly 1");
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "0" }), false);
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "0", CROW_HOME: join(dir, "home") }), false, "0 wins everywhere");
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "1" }), true);
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "yes" }), false, "only the exact 1 enables it");
});

test("sealing predicate: a DB that is not the data dir's own crow.db on the host-default home is a split-DB host", () => {
  const dir = tmp();
  // Host-default home (no CROW_HOME) with the DB somewhere else: two gateways could share
  // the home while writing different crow.db files, so no seal could be proven.
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "1", CROW_DB_PATH: join(dir, "other", "crow.db") }), false);
  // The DB in the instance's own data dir is fine.
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "1", CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db") }), true);
  // A separate CROW_HOME is a separate instance: no split.
  assert.equal(addonSecretsSealingOn({ CROW_ADDON_SECRETS_KEYCHAIN: "1", CROW_HOME: join(dir, "home"), CROW_DB_PATH: join(dir, "db", "crow.db") }), true);
});

// ─── keychainEnvNames ───────────────────────────────────────────────────────

test("keychainEnvNames: env-shaped names only, deduped, loader names dropped, capped at 64", () => {
  assert.deepEqual(keychainEnvNames({ keychainEnv: ["HA_TOKEN", "HA_TOKEN", "FUNKWHALE_URL"] }), ["HA_TOKEN", "FUNKWHALE_URL"]);
  assert.deepEqual(keychainEnvNames({}), []);
  assert.deepEqual(keychainEnvNames(null), []);
  assert.deepEqual(keychainEnvNames({ keychainEnv: "HA_TOKEN" }), [], "a bare string is not a list");
  assert.deepEqual(keychainEnvNames({ keychainEnv: ["../x", "LD_PRELOAD", "NODE_OPTIONS", 42, null, {}, "OK_KEY", "x-y"] }), ["OK_KEY"]);

  const many = Array.from({ length: 70 }, (_, i) => `EXTRA_KEY_${i}`);
  const capped = keychainEnvNames({ keychainEnv: many });
  assert.equal(capped.length, 64, "at most 64 names");
  assert.deepEqual(capped, many.slice(0, 64));
});

test("keychainEnvNames: the drop log names names only — never an entry's value", (t) => {
  const out = captureOutput(t);
  keychainEnvNames({ keychainEnv: ["LD_PRELOAD", SENTINEL, 7] });
  const text = out.text();
  assert.match(text, /LD_PRELOAD/, "a name-shaped drop is worth naming");
  assert.match(text, /non-name entr/, "a non-name entry is reported as a count");
  assert.equal(text.split(SENTINEL).length - 1, 0, "a malformed entry could hold a value there — never print it");
});

// ─── the unsealer role registry ─────────────────────────────────────────────

test("unsealer registry: one role per process; a second, different role throws", () => {
  assert.equal(processUnsealer(), null, "nothing registered yet");
  assert.throws(() => registerAddonUnsealer("wall"), /not an unsealer role/);
  assert.throws(() => registerAddonUnsealer(undefined), /not an unsealer role/);
  assert.equal(processUnsealer(), null, "a refused role registers nothing");
  registerAddonUnsealer("gateway");
  assert.equal(processUnsealer(), "gateway");
  assert.equal(registerAddonUnsealer("gateway"), "gateway", "idempotent for the same role");
  assert.throws(() => registerAddonUnsealer("satellite"), /already registered as the gateway unsealer/);
  assert.equal(processUnsealer(), "gateway", "a refused second role changes nothing");
});

// ─── the module stays DB-path free (a child / CLI / the wall imports it) ────

test("the shared module resolves no paths and imports neither servers/db.js nor routes/bundles.js", () => {
  const src = readFileSync(new URL("../servers/shared/addon-secrets.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+"[^"]*servers\/db\.js"/);
  assert.doesNotMatch(src, /from\s+"[^"]*routes\/bundles\.js"/);
  assert.doesNotMatch(src, /resolveDbPath|resolveDataDir/);
  assert.match(src, /createRequire/, "the one DB handle is required lazily, at the moment a read needs it");
});

// ─── public hygiene (this repo is public) ──────────────────────────────────

test("public hygiene: every file these tasks add or touch passes the repo's content rules", async () => {
  const { checkContent, loadAllowlist } = await import("../scripts/check-public-hygiene.mjs");
  const allow = loadAllowlist(readFileSync(new URL("../scripts/public-hygiene-allowlist.txt", import.meta.url), "utf8"));
  const files = [
    "servers/shared/addon-secrets.js",
    "servers/gateway/addon-keys-paths.js",
    "servers/gateway/addon-secrets-seal.js",
    "servers/gateway/keychain/store.js",
    "tests/helpers/sentinel-scan.mjs",
    "tests/addon-secrets-classify.test.js",
    "tests/addon-secrets-hydrate.test.js",
    "tests/addon-secrets-seal.test.js",
    "tests/keychain-extension-sync.test.js",
  ];
  const violations = [];
  for (const f of files) {
    violations.push(...checkContent(f, readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), { allow }));
  }
  assert.deepEqual(violations, [], "no hostname, personal address, phone, credential or mail header");
});