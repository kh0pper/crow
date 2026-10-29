/**
 * Project-service secrets in the masking sets (project services Task 9 carry, lane A's ruling):
 * a kind 'service' keychain value counts only when the operator recorded its hash from the
 * dashboard (recordServiceSecretValues) and it is strong. It joins the display set and the
 * gateway's own approval-card mask, and never the card set pi is handed. Every value here is an
 * obvious fake built at runtime; every path is a scratch dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const SV = await import("../servers/shared/secret-values.js");
const { collectSecretValueSets, refreshSecretValuesFile } = await import("../servers/shared/secret-values-collect.js");
const { maskSecretsDetailed, maskSecrets } = await import("../servers/shared/secret-mask.js");
const { sealSecret } = await import("../servers/sharing/secret-box.js");
const { KEYCHAIN_DDL } = await import("../servers/gateway/keychain/schema.js");

const KEY_ID = "0123456789abcdef";
const SERVICE_TOKEN = "test-token-" + "Svc9x" + "Ab3x".repeat(4);        // shell-safe, strong
const DOTTED_TOKEN = "fakeHaTok3n" + ".sec0nd-Part9" + ".thirdPart7x";   // HA/Discord-shaped (dots)
const MANUAL = "N0t_a-real_pw9";

function scratchInstance() {
  const root = mkdtempSync(join(tmpdir(), "crow-secret-svc-"));
  const home = join(root, "home");
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  const seed = randomBytes(32);
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: KEY_ID, key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  db.close();
  return { home, data, seed, env: { CROW_HOME: home, CROW_DATA_DIR: data } };
}

function insert(I, kind, value, { uuid = null, envKey = null } = {}) {
  const db = new Database(join(I.data, "crow.db"));
  db.prepare("INSERT INTO crow_keychain (kind,label,bundle_id,env_key,secret_sealed,key_id,origin,connection_uuid) VALUES (?,?,?,?,?,?,?,?)")
    .run(kind, "l", kind === "manual" ? null : "github", envKey, sealSecret(value, { seed: I.seed }), KEY_ID, kind === "manual" ? "manual" : "typed", uuid);
  db.close();
}

/** What the connect route does: the keychain row, then the operator's hash. */
function connect(I, value, uuid = "00000000-0000-4000-8000-000000000001") {
  insert(I, "service", value, { uuid, envKey: "GITHUB_PERSONAL_ACCESS_TOKEN" });
  SV.recordServiceSecretValues([value], I.env);
}

test("(a) an operator-recorded service secret a bot echoes is hidden on the gateway's approval card", () => {
  const I = scratchInstance();
  connect(I, SERVICE_TOKEN);
  refreshSecretValuesFile({ env: I.env, write: false });
  const r = maskSecretsDetailed("curl -H 'Authorization: Bearer " + SERVICE_TOKEN + "' https://api.example.test/user", { card: true });
  assert.equal(r.text.includes(SERVICE_TOKEN), false, "the card hides it");
  assert.equal(r.count, 1);
  assert.ok(SV.getApprovalCardValues().includes(SERVICE_TOKEN));
  SV.primeSecretValues([], []);
});

test("(b) what pi is handed (the fd payload and the values file) never holds a service value", () => {
  const I = scratchInstance();
  insert(I, "manual", MANUAL);
  SV.recordCardSecret([MANUAL], I.env);
  connect(I, SERVICE_TOKEN);
  const r = refreshSecretValuesFile({ env: I.env });
  const payload = SV.secretValuesPayload(SV.getCardValues());
  assert.equal(payload, MANUAL + "\n", "the card set alone");
  assert.equal(payload.includes(SERVICE_TOKEN), false);
  assert.equal(readFileSync(r.path, "utf8").includes(SERVICE_TOKEN), false, "the values file pi-lab reads");
  assert.ok(SV.getApprovalCardValues().includes(SERVICE_TOKEN), "the gateway's own card mask still has it");
  assert.ok(readFileSync(SV.secretValuesDisplayPath(I.env), "utf8").split("\n").includes(SERVICE_TOKEN), "the display file has it");
  SV.primeSecretValues([], []);
});

test("(c) a service row a bot inserted, with no recorded hash, masks nothing", () => {
  const I = scratchInstance();
  insert(I, "service", SERVICE_TOKEN, { uuid: "00000000-0000-4000-8000-000000000002", envKey: "GITHUB_PERSONAL_ACCESS_TOKEN" });
  const sets = collectSecretValueSets({ env: I.env });
  assert.deepEqual(sets.service, []);
  assert.equal(sets.display.includes(SERVICE_TOKEN), false, "not on display paths either");
  assert.equal(sets.card.includes(SERVICE_TOKEN), false);
  refreshSecretValuesFile({ env: I.env, write: false });
  assert.equal(maskSecretsDetailed("echo " + SERVICE_TOKEN, { card: true }).text.includes(SERVICE_TOKEN), true, "the card shows it as written");
  // A manual row flipped to 'service' by a bot is no different: no hash, no mask.
  SV.recordCardSecret([MANUAL], I.env);
  insert(I, "service", MANUAL, { uuid: "00000000-0000-4000-8000-000000000003", envKey: "GITHUB_PERSONAL_ACCESS_TOKEN" });
  assert.equal(collectSecretValueSets({ env: I.env }).service.includes(MANUAL), false, "a card hash is not a service hash");
  SV.primeSecretValues([], []);
});

test("(c) weak or untrusted: a recorded but weak value never counts; no sandbox means no service value on cards", () => {
  const I = scratchInstance();
  connect(I, "short7x");
  assert.deepEqual(collectSecretValueSets({ env: I.env }).service, [], "under 8 characters");
  connect(I, SERVICE_TOKEN, "00000000-0000-4000-8000-000000000004");
  refreshSecretValuesFile({ env: I.env, write: false, cardTrusted: false });
  assert.deepEqual(SV.getApprovalCardValues(), [], "a bot could have written the hash list");
  SV.primeSecretValues([], []);
});

test("(d) display masking covers a dotted HA/Discord-shaped token after a connect", () => {
  const I = scratchInstance();
  insert(I, "service", DOTTED_TOKEN, { uuid: "00000000-0000-4000-8000-000000000005", envKey: "HA_TOKEN" });
  assert.equal(collectSecretValueSets({ env: I.env }).display.includes(DOTTED_TOKEN), false, "before the connect records it");
  SV.recordServiceSecretValues([DOTTED_TOKEN], I.env);
  const sets = collectSecretValueSets({ env: I.env });
  assert.ok(sets.display.includes(DOTTED_TOKEN));
  refreshSecretValuesFile({ env: I.env, write: false });
  SV.invalidateSecretValues();
  assert.equal(maskSecrets("ha said: token " + DOTTED_TOKEN + " ok", { values: SV.getSecretValues({ env: I.env }) }).includes(DOTTED_TOKEN), false);
  SV.primeSecretValues([], []);
});

test("recording writes only a hash (600, hidden dir), joins this process's display set at once, and is idempotent", () => {
  const I = scratchInstance();
  SV.primeSecretValues([], []);
  SV.recordServiceSecretValues([SERVICE_TOKEN, SERVICE_TOKEN], I.env);
  const p = join(I.home, "secrets", SV.SERVICE_HASHES_FILENAME);
  const text = readFileSync(p, "utf8");
  assert.equal(text.includes(SERVICE_TOKEN), false, "never the value");
  assert.equal(text.trim().split("\n").length, 1);
  assert.equal(SV.readServiceHashes(I.env).has(SV.cardHashOf(SERVICE_TOKEN)), true);
  assert.equal(SV.readCardHashes(I.env).has(SV.cardHashOf(SERVICE_TOKEN)), false, "not the card list");
  SV.invalidateSecretValues();
  assert.ok(SV.getSecretValues({ env: I.env }).includes(SERVICE_TOKEN), "display masking in this process before any spawn");
  assert.equal(SV.getCardValues().includes(SERVICE_TOKEN), false);
  SV.primeSecretValues([], []);
});
