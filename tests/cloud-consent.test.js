// tests/cloud-consent.test.js — which cloud provider rows bots may use (roles
// phase 2 Task 15). Consent is per box (instance scope, never synced), pinned
// to the row's normalised address and a salted fingerprint of its key, so a
// row a peer rewrites through sync stops working until this box agrees again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { createDbClient } from "../servers/db.js";
import {
  readCloudConsent, grantCloudConsent, revokeCloudConsent, consentVerdict, seedCloudConsent,
  readCloudConsentSalt, CLOUD_CONSENT_KEY, CLOUD_CONSENT_SALT_KEY,
} from "../servers/shared/cloud-consent.js";
import { isInstanceScope, isSyncable } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { addProvider } from "../servers/gateway/ai/add-provider.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";
import tab from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const OWN = "a".repeat(32);
const PEER = "b".repeat(32);
const KEY_A = "fixture-cloud-key-a";
const KEY_P = "fixture-cloud-key-p";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cloud-consent-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const db = createDbClient(join(dir, "crow.db"));
  return { db, cleanup() { try { db.close(); } catch {} rmScratch(dir); } };
}
const dbs = [];
after(() => { for (const d of dbs) d.cleanup(); });
function newDb() { const d = fresh(); dbs.push(d); return d.db; }

const ins = (db, id, url, { key = null, instanceId = OWN, disabled = 0, models = [{ id: "c1" }] } = {}) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, lamport_ts, instance_id, provider_type) VALUES (?,?,?,?,?,?,1,?,?)",
    args: [id, url, key, "cloud", JSON.stringify(models), disabled, instanceId, "openai"],
  });
const rowOf = async (db, id) => {
  const r = (await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] })).rows[0];
  return { id: r.id, baseUrl: r.base_url, apiKey: r.api_key };
};
const rawConsent = async (db) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [CLOUD_CONSENT_KEY] })).rows[0]?.value ?? null;
const verdictOf = async (db, id) => consentVerdict(await rowOf(db, id), (await readCloudConsent(db))[id], { salt: await readCloudConsentSalt(db) });

async function seeded() {
  const db = newDb();
  await ins(db, "cloud-a", "https://api.example.com/v1/acct-a", { key: KEY_A });
  await ins(db, "cloud-p", "https://api.example.com/v1", { key: KEY_P, instanceId: PEER });
  return db;
}

test("both keys are instance scope and never synced", () => {
  for (const k of [CLOUD_CONSENT_KEY, CLOUD_CONSENT_SALT_KEY]) {
    assert.equal(isInstanceScope(k), true, k);
    assert.equal(isSyncable(k), false, k);
  }
  assert.equal(CLOUD_CONSENT_KEY, "llm_cloud_door_rows");
  assert.equal(CLOUD_CONSENT_SALT_KEY, "llm_cloud_consent_salt");
});

test("the seed grants only rows this box wrote, once", async () => {
  const db = await seeded();
  await ins(db, "cloud-null", "https://api.example.com/v1/n", { key: KEY_P, instanceId: null });
  await ins(db, "cloud-empty", "https://api.example.com/v1/e", { key: KEY_P, instanceId: "" });
  await ins(db, "cloud-off", "https://api.example.com/v1/o", { key: KEY_A, disabled: 1 });
  await ins(db, "local-chat", "http://127.0.0.1:8003/v1");
  await ins(db, "local-lan", "http://192.168.1.5:8000/v1");
  const first = await seedCloudConsent(db, { ownInstanceId: OWN });
  assert.deepEqual(first.seeded, ["cloud-a"]);
  const c = await readCloudConsent(db);
  assert.deepEqual(Object.keys(c), ["cloud-a"]);
  assert.equal(c["cloud-a"].target, "https://api.example.com/v1/acct-a");
  assert.match(c["cloud-a"].keyFp, /^[0-9a-f]{16}$/);
  assert.equal(typeof c["cloud-a"].at, "string");
  assert.equal(c["cloud-a"].by, "seed");
  assert.equal(await verdictOf(db, "cloud-a"), "ok");

  // Second call: the key exists, nothing happens (even for a new own row).
  await ins(db, "cloud-b", "https://api.example.com/v1/b", { key: KEY_A });
  const second = await seedCloudConsent(db, { ownInstanceId: OWN });
  assert.deepEqual(second.seeded, []);
  assert.deepEqual(Object.keys(await readCloudConsent(db)), ["cloud-a"]);
});

test("peer-written rows fail closed: a null or missing instance id is never seeded", async () => {
  const db = newDb();
  await ins(db, "cloud-null", "https://api.example.com/v1", { key: KEY_P, instanceId: null });
  const r = await seedCloudConsent(db, { ownInstanceId: OWN });
  assert.deepEqual(r.seeded, []);
  assert.equal(await verdictOf(db, "cloud-null"), "not_consented");
  // No own id known: nothing is seeded, and the key stays absent so a later boot can.
  const db2 = newDb();
  await ins(db2, "cloud-a", "https://api.example.com/v1", { key: KEY_A, instanceId: null });
  assert.deepEqual((await seedCloudConsent(db2, { ownInstanceId: null })).seeded, []);
  assert.deepEqual((await seedCloudConsent(db2, { ownInstanceId: "" })).seeded, []);
  assert.equal(await rawConsent(db2), null);
});

test("a sync-style rewrite of the host, of only the path, or of only the key stops the row", async () => {
  const db = await seeded();
  await seedCloudConsent(db, { ownInstanceId: OWN });
  assert.equal(await verdictOf(db, "cloud-a"), "ok");

  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://198.51.100.4/v1", "cloud-a"] });
  assert.equal(await verdictOf(db, "cloud-a"), "host_changed");

  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://api.example.com/v1/acct-b", "cloud-a"] });
  assert.equal(await verdictOf(db, "cloud-a"), "host_changed");

  // Normalisation: case of the host and a trailing slash are the same address.
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://API.Example.com/v1/acct-a/", "cloud-a"] });
  assert.equal(await verdictOf(db, "cloud-a"), "ok");

  await db.execute({ sql: "UPDATE providers SET api_key = ? WHERE id = ?", args: ["fixture-cloud-key-other", "cloud-a"] });
  assert.equal(await verdictOf(db, "cloud-a"), "key_changed");
  await db.execute({ sql: "UPDATE providers SET api_key = NULL WHERE id = ?", args: ["cloud-a"] });
  assert.equal(await verdictOf(db, "cloud-a"), "key_changed");
});

test("the stored value holds neither the key nor its plain sha256; the fingerprint is salted per box", async () => {
  const db = await seeded();
  await seedCloudConsent(db, { ownInstanceId: OWN });
  const raw = await rawConsent(db);
  const plain = createHash("sha256").update(KEY_A).digest("hex");
  assert.ok(!raw.includes(KEY_A));
  assert.ok(!raw.includes(plain));
  assert.ok(!raw.includes(plain.slice(0, 16)));
  const salt = await readCloudConsentSalt(db);
  assert.match(salt, /^[0-9a-f]{64}$/);

  // Another box, same row and key: another salt, another fingerprint.
  const db2 = await seeded();
  await seedCloudConsent(db2, { ownInstanceId: OWN });
  assert.notEqual(await readCloudConsentSalt(db2), salt);
  assert.notEqual((await readCloudConsent(db2))["cloud-a"].keyFp, (await readCloudConsent(db))["cloud-a"].keyFp);

  // The salt is minted once and kept.
  await grantCloudConsent(db, "cloud-p", { actor: "t" });
  assert.equal(await readCloudConsentSalt(db), salt);
});

test("consentVerdict fails closed without a salt or an entry", async () => {
  const db = await seeded();
  await seedCloudConsent(db, { ownInstanceId: OWN });
  const row = await rowOf(db, "cloud-a");
  const entry = (await readCloudConsent(db))["cloud-a"];
  assert.equal(consentVerdict(row, entry, { salt: null }), "key_changed");
  assert.equal(consentVerdict(row, undefined, { salt: await readCloudConsentSalt(db) }), "not_consented");
  assert.equal(consentVerdict(row, null, { salt: await readCloudConsentSalt(db) }), "not_consented");
  assert.equal(consentVerdict(row, { target: 5 }, { salt: await readCloudConsentSalt(db) }), "not_consented");
});

test("grant, re-grant and revoke", async () => {
  const db = await seeded();
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  assert.deepEqual(await grantCloudConsent(db, "cloud-p", { actor: "dashboard:owner" }), { ok: true });
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  assert.equal((await readCloudConsent(db))["cloud-p"].by, "dashboard:owner");
  await db.execute({ sql: "UPDATE providers SET api_key = ? WHERE id = ?", args: ["fixture-cloud-key-q", "cloud-p"] });
  assert.equal(await verdictOf(db, "cloud-p"), "key_changed");
  await grantCloudConsent(db, "cloud-p", { actor: "dashboard:owner" });
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  assert.deepEqual(await revokeCloudConsent(db, "cloud-p"), { ok: true });
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  assert.equal((await grantCloudConsent(db, "no-such-row", { actor: "t" })).ok, false);
  assert.equal((await readCloudConsent(db))["no-such-row"], undefined);
});

test("parallel grants do not lose each other", async () => {
  const db = await seeded();
  for (let i = 0; i < 6; i++) await ins(db, `cloud-${i}`, `https://api.example.com/v1/${i}`, { key: KEY_A });
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => grantCloudConsent(db, `cloud-${i}`, { actor: "t" })));
  assert.deepEqual(Object.keys(await readCloudConsent(db)).sort(), [0, 1, 2, 3, 4, 5].map((i) => `cloud-${i}`));
});

// --- the providers-tab switch ------------------------------------------------

function fakeRes() {
  return { redirected: null, redirectAfterPost(u) { this.redirected = u; }, status() { return this; }, type() { return this; }, send() { return this; } };
}

test("the providers tab shows a switch on cloud rows only, and its actions grant and revoke", async () => {
  const db = await seeded();
  await ins(db, "local-chat", "http://127.0.0.1:8003/v1");
  const render = (lang = "en") => tab.render({ db, lang, piAgentDir: null, tasksDbPaths: [] });
  let h = await render();
  const label = t("providers.botsMayUse", "en");
  assert.equal(label, "Let bots use this provider");
  assert.equal(t("providers.botsMayUse", "es"), "Permitir que los bots usen este proveedor");
  assert.ok(h.includes(label));
  assert.match(h, /name="action" value="llm_provider_bots_allow"[\s\S]*?name="id" value="cloud-p"/);
  const localRow = h.slice(h.indexOf(">local-chat<"));
  const localTr = localRow.slice(0, localRow.indexOf("</tr>"));
  assert.ok(!localTr.includes("llm_provider_bots_"), "no switch on a local row");
  assert.ok((await render("es")).includes(t("providers.botsMayUse", "es")));

  const res = fakeRes();
  const handled = await tab.handleAction({ req: { body: { action: "llm_provider_bots_allow", id: "cloud-p" } }, res, db, action: "llm_provider_bots_allow" });
  assert.equal(handled, true);
  assert.equal(res.redirected, "?section=llm&tab=providers");
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  assert.equal((await readCloudConsent(db))["cloud-p"].by, "dashboard:owner");
  h = await render();
  assert.match(h, /name="action" value="llm_provider_bots_deny"[\s\S]*?name="id" value="cloud-p"/);
  assert.match(h, /role="switch" aria-checked="true"/);

  await tab.handleAction({ req: { body: { action: "llm_provider_bots_deny", id: "cloud-p" } }, res: fakeRes(), db, action: "llm_provider_bots_deny" });
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");

  // A row whose address changed since consent reads as off, so ticking it agrees again.
  await grantCloudConsent(db, "cloud-p", { actor: "t" });
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://198.51.100.4/v1", "cloud-p"] });
  h = await render();
  const pRow = h.slice(h.indexOf(">cloud-p<"));
  assert.match(pRow.slice(0, pRow.indexOf("</tr>")), /llm_provider_bots_allow/);
});

test("the switch actions go through the settings action path (session- and CSRF-gated)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/dashboard/index.js"), "utf8");
  assert.match(src, /router\.use\("\/dashboard", csrfMiddleware\)/);
  const llm = readFileSync(join(import.meta.dirname, "..", "servers/gateway/dashboard/settings/sections/llm.js"), "utf8");
  assert.match(llm, /handleAction: providersTab\.handleAction/);
});

// --- addProvider grants ------------------------------------------------------

test("addProvider grants the new row and re-grants on reuse", async () => {
  const db = newDb();
  const okTest = async () => ({ ok: true, code: "ok", models: ["c1"], host: "api.openai.com", baseUrl: "https://api.openai.com/v1" });
  const out = await addProvider(db, { presetId: "openai", apiKey: KEY_A, modelIds: ["c1"] }, { testFn: okTest, invalidateFn: () => {} });
  assert.equal(out.ok, true);
  assert.equal(out.reuse, false);
  const id = out.providerId;
  assert.equal(await verdictOf(db, id), "ok");
  // The row is this box's own (upsertProvider stamps its instance id).
  assert.equal((await db.execute({ sql: "SELECT instance_id FROM providers WHERE id = ?", args: [id] })).rows[0].instance_id, getOrCreateLocalInstanceId());

  await revokeCloudConsent(db, id);
  const again = await addProvider(db, { presetId: "openai", apiKey: KEY_A, modelIds: ["c1"] }, { testFn: okTest, invalidateFn: () => {} });
  assert.equal(again.reuse, true);
  assert.equal(again.providerId, id);
  assert.equal(await verdictOf(db, id), "ok");
});

test("a failing consent write after the save still reads as saved", async () => {
  const db = newDb();
  const okTest = async () => ({ ok: true, code: "ok", models: ["c1"], host: "api.openai.com", baseUrl: "https://api.openai.com/v1" });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let out;
  try {
    out = await addProvider(db, { presetId: "openai", apiKey: KEY_A, modelIds: ["c1"] }, {
      testFn: okTest, invalidateFn: () => {}, onAdded: async () => { throw new Error("disk full"); },
    });
  } finally { console.warn = orig; }
  assert.equal(out.ok, true);
  assert.ok(warns.some((w) => /disk full/.test(w)), JSON.stringify(warns));
  assert.ok(!warns.some((w) => w.includes(KEY_A)));
});

// --- boot step ---------------------------------------------------------------

test("boot wiring: the consent seed runs in the authenticated branch after the reconcile", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/boot/admin-api.js"), "utf8");
  const r = src.indexOf("await reconcile();");
  assert.ok(r > 0);
  const call = src.indexOf("await seedCloudConsentAtBoot();", r);
  assert.ok(call > r, "seeded after the provider reconcile");
  assert.ok(src.indexOf("if (noAuth)") < r, "inside the branch that skips --no-auth");
});

test("the boot seed never throws and always closes its own client", async () => {
  const { seedCloudConsentAtBoot } = await import("../servers/gateway/boot/admin-api.js");
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let closed = 0;
  try {
    await seedCloudConsentAtBoot(() => { throw new Error("cannot open"); }, { ownInstanceId: OWN });
    await seedCloudConsentAtBoot(() => ({ execute: async () => { throw new Error("db gone"); }, close: () => { closed++; throw new Error("close failed"); } }), { ownInstanceId: OWN });
  } finally { console.warn = orig; }
  assert.equal(closed, 1);
  assert.equal(warns.length, 2, JSON.stringify(warns));
  assert.match(warns[0], /\[cloud-consent\] Seed skipped: cannot open/);

  const db = await seeded();
  let dbClosed = 0;
  await seedCloudConsentAtBoot(() => ({ execute: (...a) => db.execute(...a), close: () => { dbClosed++; } }), { ownInstanceId: OWN });
  assert.equal(dbClosed, 1);
  assert.deepEqual(Object.keys(await readCloudConsent(db)), ["cloud-a"]);
});
