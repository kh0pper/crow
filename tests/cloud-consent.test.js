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
import * as consentMod from "../servers/shared/cloud-consent.js";
import {
  readCloudConsent, grantCloudConsent, revokeCloudConsent, consentVerdict, consentTokenFor,
  readCloudConsentSalt, ensureCloudConsentSalt, CLOUD_CONSENT_KEY, CLOUD_CONSENT_SALT_KEY,
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
/** Grant as the switch does: with the token for the row as it is now (what a page would render). */
async function tick(db, id, actor = "t") {
  const salt = await ensureCloudConsentSalt(db);
  return grantCloudConsent(db, id, { actor, expect: { consentToken: consentTokenFor(await rowOf(db, id), salt) } });
}

test("both keys are instance scope and never synced", () => {
  for (const k of [CLOUD_CONSENT_KEY, CLOUD_CONSENT_SALT_KEY]) {
    assert.equal(isInstanceScope(k), true, k);
    assert.equal(isSyncable(k), false, k);
  }
  assert.equal(CLOUD_CONSENT_KEY, "llm_cloud_door_rows");
  assert.equal(CLOUD_CONSENT_SALT_KEY, "llm_cloud_consent_salt");
});

test("nothing is consented automatically: no seed export, and boot grants nothing", async () => {
  // A seed would have to trust providers.instance_id, which a peer controls through sync.
  assert.equal(consentMod.seedCloudConsent, undefined);
  const admin = await import("../servers/gateway/boot/admin-api.js");
  assert.equal(admin.seedCloudConsentAtBoot, undefined);
  const src = readFileSync(join(import.meta.dirname, "..", "servers/gateway/boot/admin-api.js"), "utf8");
  // Task 17: admin-api reads consent for the pi models.json sync, and only reads.
  // A TRIPWIRE, not a proof: these regexes catch the obvious regression (a
  // grant, seed or ensure call, or a whole-module import, added to
  // admin-api.js), but a template-literal import specifier or a helper module
  // that wraps grantCloudConsent would slip past them. Review such changes.
  const imports = [...src.matchAll(/\{([^}]*)\}\s*=\s*await import\(["'][^"']*cloud-consent\.js["']\)/g)].map((m) => m[1]);
  assert.ok(!/from ["'][^"']*cloud-consent/.test(src), "no static import");
  assert.equal(imports.length, (src.match(/import\(["'][^"']*cloud-consent/g) || []).length, "every import of it names what it takes");
  for (const names of imports) for (const n of names.split(",").map((x) => x.trim()).filter(Boolean)) {
    assert.ok(["readCloudConsent", "readCloudConsentSalt", "onCloudConsentChange"].includes(n), `admin-api imports only readers: ${n}`);
  }
  assert.ok(!/grantCloudConsent|seedCloudConsent|ensureCloudConsentSalt/.test(src));
  // Rows claiming this box's id (or none) stay unconsented until an explicit act.
  const db = await seeded();
  await ins(db, "cloud-own", "https://api.example.com/v1/own", { key: KEY_A, instanceId: getOrCreateLocalInstanceId() });
  await ins(db, "cloud-null", "https://api.example.com/v1/n", { key: KEY_P, instanceId: null });
  assert.deepEqual(await readCloudConsent(db), {});
  for (const id of ["cloud-a", "cloud-p", "cloud-own", "cloud-null"]) assert.equal(await verdictOf(db, id), "not_consented", id);
});

test("a sync-style rewrite of the host, of only the path, or of only the key stops the row", async () => {
  const db = await seeded();
  assert.deepEqual(await tick(db, "cloud-a"), { ok: true });
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
  await tick(db, "cloud-a");
  const raw = await rawConsent(db);
  const plain = createHash("sha256").update(KEY_A).digest("hex");
  assert.ok(!raw.includes(KEY_A));
  assert.ok(!raw.includes(plain));
  assert.ok(!raw.includes(plain.slice(0, 16)));
  const salt = await readCloudConsentSalt(db);
  assert.match(salt, /^[0-9a-f]{64}$/);

  // Another box, same row and key: another salt, another fingerprint.
  const db2 = await seeded();
  await tick(db2, "cloud-a");
  assert.notEqual(await readCloudConsentSalt(db2), salt);
  assert.notEqual((await readCloudConsent(db2))["cloud-a"].keyFp, (await readCloudConsent(db))["cloud-a"].keyFp);

  // The salt is minted once and kept.
  await tick(db, "cloud-p");
  assert.equal(await readCloudConsentSalt(db), salt);
});

test("consentVerdict takes the row's own entry only, and fails closed", async () => {
  const db = await seeded();
  await tick(db, "cloud-a");
  const row = await rowOf(db, "cloud-a");
  const all = await readCloudConsent(db);
  const salt = await readCloudConsentSalt(db);
  assert.equal(consentVerdict(row, all["cloud-a"], { salt }), "ok");
  assert.equal(consentVerdict(row, all, { salt }), "not_consented", "the whole map is not an entry");
  assert.equal(consentVerdict(row, all["cloud-a"], { salt: null }), "key_changed");
  assert.equal(consentVerdict(row, undefined, { salt }), "not_consented");
  assert.equal(consentVerdict(row, null, { salt }), "not_consented");
  assert.equal(consentVerdict(row, { target: 5 }, { salt }), "not_consented");
});

test("a grant needs what was seen: a token or the written URL and key; a rewrite in between is refused", async () => {
  const db = await seeded();
  const salt = await ensureCloudConsentSalt(db);
  // No expectation at all: refused.
  assert.deepEqual(await grantCloudConsent(db, "cloud-p", { actor: "t" }), { ok: false, reason: "changed" });
  assert.deepEqual(await grantCloudConsent(db, "cloud-p", { actor: "t", expect: {} }), { ok: false, reason: "changed" });
  // The token rendered for the row as it was; then a peer rewrites the host before the click.
  const seenToken = consentTokenFor(await rowOf(db, "cloud-p"), salt);
  assert.match(seenToken, /^[0-9a-f]{32}$/);
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://198.51.100.4/v1", "cloud-p"] });
  assert.deepEqual(await grantCloudConsent(db, "cloud-p", { actor: "t", expect: { consentToken: seenToken } }), { ok: false, reason: "changed" });
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  // A key rewrite between render and click: refused too.
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://api.example.com/v1", "cloud-p"] });
  const t2 = consentTokenFor(await rowOf(db, "cloud-p"), salt);
  await db.execute({ sql: "UPDATE providers SET api_key = ? WHERE id = ?", args: ["fixture-cloud-key-q", "cloud-p"] });
  assert.equal((await grantCloudConsent(db, "cloud-p", { actor: "t", expect: { consentToken: t2 } })).reason, "changed");
  // The written-values form.
  assert.equal((await grantCloudConsent(db, "cloud-p", { actor: "t", expect: { baseUrl: "https://api.example.com/v1", apiKey: KEY_P } })).reason, "changed");
  assert.deepEqual(await grantCloudConsent(db, "cloud-p", { actor: "t", expect: { baseUrl: "https://api.example.com/v1/", apiKey: "fixture-cloud-key-q" } }), { ok: true });
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  // The token never carries the key or keyFp.
  const entry = (await readCloudConsent(db))["cloud-p"];
  assert.ok(!seenToken.includes(entry.keyFp));
});

test("the token is bound to the row id: same address and key, another row, another token", async () => {
  const db = newDb();
  await ins(db, "cloud-x", "https://api.example.com/v1", { key: KEY_A });
  await ins(db, "cloud-y", "https://api.example.com/v1", { key: KEY_A });
  const salt = await ensureCloudConsentSalt(db);
  const tx = consentTokenFor(await rowOf(db, "cloud-x"), salt);
  const ty = consentTokenFor(await rowOf(db, "cloud-y"), salt);
  assert.notEqual(tx, ty);
  assert.deepEqual(await grantCloudConsent(db, "cloud-y", { actor: "t", expect: { consentToken: tx } }), { ok: false, reason: "changed" });
  assert.equal(await verdictOf(db, "cloud-y"), "not_consented");
  assert.deepEqual(await grantCloudConsent(db, "cloud-x", { actor: "t", expect: { consentToken: tx } }), { ok: true });
  assert.equal(await verdictOf(db, "cloud-y"), "not_consented", "granting x never grants y");
});

test("grant refuses rows that are not cloud rows, or are disabled", async () => {
  const db = newDb();
  await ins(db, "local-chat", "http://127.0.0.1:8003/v1");
  await ins(db, "local-lan", "http://192.168.1.5:8000/v1");
  await ins(db, "tail", "https://crow.example.ts.net/v1");
  await ins(db, "meta", "http://169.254.169.254/v1");
  await ins(db, "door", "https://api.example.com/llm/v1");
  await ins(db, "cloud-off", "https://api.example.com/v1/o", { key: KEY_A, disabled: 1 });
  const salt = await ensureCloudConsentSalt(db);
  for (const id of ["local-chat", "local-lan", "tail", "meta", "door"]) {
    const r = await grantCloudConsent(db, id, { actor: "t", expect: { consentToken: consentTokenFor(await rowOf(db, id), salt) } });
    assert.deepEqual(r, { ok: false, reason: "not_cloud" }, id);
  }
  assert.deepEqual(await grantCloudConsent(db, "cloud-off", { actor: "t", expect: { consentToken: consentTokenFor(await rowOf(db, "cloud-off"), salt) } }), { ok: false, reason: "disabled" });
  assert.deepEqual(await readCloudConsent(db), {});
});

test("grant, re-grant and revoke", async () => {
  const db = await seeded();
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  assert.deepEqual(await tick(db, "cloud-p", "dashboard:owner"), { ok: true });
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  assert.equal((await readCloudConsent(db))["cloud-p"].by, "dashboard:owner");
  await db.execute({ sql: "UPDATE providers SET api_key = ? WHERE id = ?", args: ["fixture-cloud-key-q", "cloud-p"] });
  assert.equal(await verdictOf(db, "cloud-p"), "key_changed");
  await tick(db, "cloud-p", "dashboard:owner");
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  assert.deepEqual(await revokeCloudConsent(db, "cloud-p"), { ok: true });
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  assert.equal((await grantCloudConsent(db, "no-such-row", { actor: "t", expect: { consentToken: "0".repeat(32) } })).reason, "not_found");
  assert.equal((await readCloudConsent(db))["no-such-row"], undefined);
});

test("T17: grant and revoke tell the change listeners (the pi models.json sync); a refused grant does not", async () => {
  const db = await seeded();
  const seen = [];
  const off = consentMod.onCloudConsentChange((e) => seen.push(e.id));
  try {
    await tick(db, "cloud-p");
    await grantCloudConsent(db, "cloud-p", { actor: "t", expect: {} });
    await revokeCloudConsent(db, "cloud-p");
    await revokeCloudConsent(db, "cloud-p");
  } finally { off(); }
  assert.deepEqual(seen, ["cloud-p", "cloud-p"], "one for the grant, one for the revoke; none for the refusal or the no-op");
});

test("parallel grants do not lose each other", async () => {
  const db = await seeded();
  for (let i = 0; i < 6; i++) await ins(db, `cloud-${i}`, `https://api.example.com/v1/${i}`, { key: KEY_A });
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => tick(db, `cloud-${i}`)));
  assert.deepEqual(Object.keys(await readCloudConsent(db)).sort(), [0, 1, 2, 3, 4, 5].map((i) => `cloud-${i}`));
});

// --- the providers-tab switch ------------------------------------------------

function fakeRes() {
  return { redirected: null, redirectAfterPost(u) { this.redirected = u; }, status() { return this; }, type() { return this; }, send() { return this; } };
}
/** The <tr> for provider `id` in rendered html. */
function trOf(h, id) {
  const at = h.indexOf(`>${id}<`);
  assert.ok(at > 0, `row ${id} rendered`);
  const start = h.lastIndexOf("<tr", at);
  return h.slice(start, h.indexOf("</tr>", at));
}
const tokenIn = (tr) => tr.match(/name="consent_token" value="([0-9a-f]{32})"/)?.[1] ?? null;
const post = (db, action, body) => {
  const res = fakeRes();
  return tab.handleAction({ req: { body: { action, ...body }, query: {} }, res, db, action }).then((handled) => ({ handled, res }));
};

test("the providers tab shows a switch on each cloud row (own token, never keyFp) and none on local rows", async () => {
  const db = await seeded();
  await ins(db, "local-chat", "http://127.0.0.1:8003/v1");
  const render = (lang = "en", query = {}) => tab.render({ req: { query }, db, lang, piAgentDir: null, tasksDbPaths: [] });
  let h = await render();
  const label = t("providers.botsMayUse", "en");
  assert.equal(label, "Let bots use this provider");
  assert.equal(t("providers.botsMayUse", "es"), "Permitir que los bots usen este proveedor");
  const pTr = trOf(h, "cloud-p"), aTr = trOf(h, "cloud-a");
  for (const tr of [pTr, aTr]) {
    assert.ok(tr.includes(label));
    assert.match(tr, /name="action" value="llm_provider_bots_allow"/);
    assert.match(tr, /role="switch" aria-checked="false"/);
    assert.ok(tokenIn(tr));
  }
  assert.notEqual(tokenIn(pTr), tokenIn(aTr), "each row has its own token");
  assert.ok(!trOf(h, "local-chat").includes("llm_provider_bots_"), "no switch on a local row");
  assert.ok((await render("es")).includes(t("providers.botsMayUse", "es")));

  // Allow with the rendered token.
  const { handled, res } = await post(db, "llm_provider_bots_allow", { id: "cloud-p", consent_token: tokenIn(pTr) });
  assert.equal(handled, true);
  assert.equal(res.redirected, "?section=llm&tab=providers");
  assert.equal(await verdictOf(db, "cloud-p"), "ok");
  assert.equal((await readCloudConsent(db))["cloud-p"].by, "dashboard:owner");
  assert.equal(await verdictOf(db, "cloud-a"), "not_consented", "only the row clicked");
  h = await render();
  const onTr = trOf(h, "cloud-p");
  assert.match(onTr, /name="action" value="llm_provider_bots_deny"/);
  assert.match(onTr, /role="switch" aria-checked="true"/);
  const entry = (await readCloudConsent(db))["cloud-p"];
  assert.ok(!h.includes(entry.keyFp), "the page never shows keyFp");
  assert.ok(!h.includes(KEY_P), "the page never shows the key");

  await post(db, "llm_provider_bots_deny", { id: "cloud-p" });
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  // Allow with no token, or a wrong one: refused.
  assert.equal((await post(db, "llm_provider_bots_allow", { id: "cloud-p" })).res.redirected, "?section=llm&tab=providers&bots=changed");
  await post(db, "llm_provider_bots_allow", { id: "cloud-p", consent_token: tokenIn(aTr) });
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
});

test("a row rewritten between render and click is refused, with a plain line", async () => {
  const db = await seeded();
  const render = (query = {}) => tab.render({ req: { query }, db, lang: "en", piAgentDir: null, tasksDbPaths: [] });
  const seen = tokenIn(trOf(await render(), "cloud-p"));
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://198.51.100.4/v1", "cloud-p"] });
  const { res } = await post(db, "llm_provider_bots_allow", { id: "cloud-p", consent_token: seen });
  assert.equal(res.redirected, "?section=llm&tab=providers&bots=changed");
  assert.equal(await verdictOf(db, "cloud-p"), "not_consented");
  const line = t("providers.botsChanged", "en");
  assert.equal(line, "This provider changed since the page loaded. Check it and try again.");
  assert.equal(t("providers.botsChanged", "es"), "Este proveedor cambió desde que se cargó la página. Revísalo y vuelve a intentarlo.");
  assert.ok((await render({ bots: "changed" })).includes(line));
  assert.ok(!(await render()).includes(line));
  // The fresh render's token works for the address shown now.
  const fresh = tokenIn(trOf(await render(), "cloud-p"));
  assert.notEqual(fresh, seen);
  await post(db, "llm_provider_bots_allow", { id: "cloud-p", consent_token: fresh });
  assert.equal(await verdictOf(db, "cloud-p"), "ok");

  // A consented row whose address then changed reads as off, so ticking it agrees again.
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://203.0.113.9/v1", "cloud-p"] });
  assert.match(trOf(await render(), "cloud-p"), /llm_provider_bots_allow/);
});

test("when the salt can't be created, the switch renders disabled with a plain line", async () => {
  const db = await seeded();
  const noSalt = {
    execute: (q) => {
      const sql = typeof q === "string" ? q : q.sql;
      if (/INSERT OR IGNORE INTO dashboard_settings/.test(sql)) return Promise.reject(new Error("read-only"));
      return db.execute(q);
    },
  };
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let h, hEs;
  try {
    h = await tab.render({ req: { query: {} }, db: noSalt, lang: "en", piAgentDir: null, tasksDbPaths: [] });
    hEs = await tab.render({ req: { query: {} }, db: noSalt, lang: "es", piAgentDir: null, tasksDbPaths: [] });
  } finally { console.warn = orig; }
  const tr = trOf(h, "cloud-p");
  assert.match(tr, /role="switch" aria-checked="false" disabled/);
  assert.ok(!tr.includes("llm_provider_bots_"), "no action to post");
  assert.ok(!tr.includes("consent_token"), "no tokenless form");
  assert.equal(t("providers.botsUnavailable", "en"), "Can't set this right now. Reload the page.");
  assert.ok(tr.includes("Can&#39;t set this right now. Reload the page.") || tr.includes("Can't set this right now. Reload the page."));
  assert.ok(trOf(hEs, "cloud-p").includes(t("providers.botsUnavailable", "es")));
  assert.ok(warns.some((w) => /consent salt/.test(w)));
});

// --- addProvider grants ------------------------------------------------------

const okTest = async () => ({ ok: true, code: "ok", models: ["c1"], host: "api.openai.com", baseUrl: "https://api.openai.com/v1" });

test("addProvider grants the new row and re-grants on reuse", async () => {
  const db = newDb();
  const out = await addProvider(db, { presetId: "openai", apiKey: KEY_A, modelIds: ["c1"] }, { testFn: okTest, invalidateFn: () => {} });
  assert.equal(out.ok, true);
  assert.equal(out.reuse, false);
  assert.equal(out.consent, "granted");
  const id = out.providerId;
  assert.equal(await verdictOf(db, id), "ok");
  assert.equal((await readCloudConsent(db))[id].by, "add-provider");

  await revokeCloudConsent(db, id);
  const again = await addProvider(db, { presetId: "openai", apiKey: KEY_A, modelIds: ["c1"] }, { testFn: okTest, invalidateFn: () => {} });
  assert.equal(again.reuse, true);
  assert.equal(again.providerId, id);
  assert.equal(again.consent, "granted");
  assert.equal(await verdictOf(db, id), "ok");
});

test("addProvider consents only to what it wrote: a rewrite before the grant fails it", async () => {
  const db = newDb();
  const { upsertProvider } = await import("../servers/shared/providers-db.js");
  // A sync apply lands between the save and the grant.
  const raceUpsert = async (d, p) => {
    const r = await upsertProvider(d, p);
    await d.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["https://198.51.100.4/v1", p.id] });
    return r;
  };
  const out = await addProvider(db, { presetId: "openai", apiKey: KEY_A, modelIds: ["c1"] }, { testFn: okTest, invalidateFn: () => {}, upsertProviderFn: raceUpsert });
  assert.equal(out.ok, true);
  assert.equal(out.consent, "failed");
  assert.equal(await verdictOf(db, out.providerId), "not_consented");
});

test("addProvider: a local 'other' server needs no consent; a failing grant still reads as saved", async () => {
  const db = newDb();
  const local = await addProvider(db, { presetId: "other", baseUrl: "http://127.0.0.1:8003/v1", apiKey: "", modelIds: ["m1"] }, {
    testFn: async () => ({ ok: true, code: "ok", models: ["m1"], host: "127.0.0.1", baseUrl: "http://127.0.0.1:8003/v1" }), invalidateFn: () => {},
  });
  assert.equal(local.ok, true);
  assert.equal(local.consent, "not_needed");

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
  assert.equal(out.consent, "failed");
  assert.ok(warns.some((w) => /disk full/.test(w)), JSON.stringify(warns));
  assert.ok(!warns.some((w) => w.includes(KEY_A)));
});

test("the add sheet shows a line when the grant failed (en and es)", async () => {
  assert.match(t("models.add.botsFailed", "en"), /Let bots use this provider/);
  assert.match(t("models.add.botsFailed", "es"), /Permitir que los bots usen este proveedor/);
  const ui = readFileSync(join(import.meta.dirname, "..", "servers/gateway/dashboard/shared/add-provider-ui.js"), "utf8");
  assert.match(ui, /botsFailed: '\$\{tJs\("models\.add\.botsFailed", lang\)\}'/);
  assert.match(ui, /d\.consent === 'failed' \? T\.saved \+ ' ' \+ T\.botsFailed : T\.saved/);
  const api = readFileSync(join(import.meta.dirname, "..", "servers/gateway/routes/roles-api.js"), "utf8");
  assert.match(api, /providerId: r\.providerId, consent \}/);
});

// --- Final fix wave F2: one door-eligibility rule ---------------------------

test("F2: cloudDoorEligible is the door's own rule: enabled, cloud, https, keyed, openai or anthropic, not local only, not crow-c-*", () => {
  const ok = { id: "cloud-a", baseUrl: "https://api.example.com/v1", apiKey: KEY_A, provider_type: "openai", models: [{ id: "c1" }] };
  assert.equal(consentMod.cloudDoorEligible(ok), true);
  assert.equal(consentMod.cloudDoorIneligibleReason(ok), null);
  for (const t of [null, undefined, "", "openai-compat", "openai", "anthropic"]) {
    assert.equal(consentMod.cloudDoorEligible({ ...ok, provider_type: t }), true, `type ${t}`);
  }
  const cases = [
    [{ ...ok, disabled: true }, "disabled"],
    [{ ...ok, baseUrl: "http://127.0.0.1:8003/v1" }, "not_cloud"],
    [{ ...ok, baseUrl: "http://169.254.169.254/v1" }, "not_cloud"],
    [{ ...ok, id: "crow-c-cloud-a" }, "reserved_id"],
    [{ ...ok, id: "CROW-C-x" }, "reserved_id"],
    [{ ...ok, gpuPolicy: { local_only: true } }, "local_only"],
    [{ ...ok, gpu_policy: { local_only: true } }, "local_only"],
    [{ ...ok, baseUrl: "http://api.example.com/v1" }, "insecure"],
    [{ ...ok, provider_type: "gemini" }, "unsupported_type"],
    [{ ...ok, provider_type: "Anthropic" }, "unsupported_type"],
    [{ ...ok, apiKey: "" }, "no_key"],
    [{ ...ok, apiKey: "  " }, "no_key"],
    [{ ...ok, apiKey: "none" }, "no_key"],
    [{ ...ok, apiKey: null }, "no_key"],
  ];
  for (const [row, why] of cases) {
    assert.equal(consentMod.cloudDoorIneligibleReason(row), why, JSON.stringify(row));
    assert.equal(consentMod.cloudDoorEligible(row), false, why);
  }
  // The door's test seams: a plain-http fake upstream may be let through.
  const fake = { ...ok, baseUrl: "http://up.example.test:9/v1" };
  assert.equal(consentMod.cloudDoorIneligibleReason(fake), "insecure");
  assert.equal(consentMod.cloudDoorIneligibleReason(fake, { allowInsecure: () => true }), null);
});

test("F2: grant refuses a cloud row the door would never serve (not_eligible), and records nothing", async () => {
  const db = newDb();
  await ins(db, "cloud-h", "http://api.example.com/v1", { key: KEY_A });
  await ins(db, "cloud-nokey", "https://api.example.com/v1/n");
  await ins(db, "cloud-lo", "https://api.example.com/v1/l", { key: KEY_A });
  await db.execute({ sql: "UPDATE providers SET gpu_policy = ? WHERE id = ?", args: [JSON.stringify({ local_only: true }), "cloud-lo"] });
  await ins(db, "cloud-g", "https://api.example.com/v1/g", { key: KEY_A });
  await db.execute({ sql: "UPDATE providers SET provider_type = ? WHERE id = ?", args: ["gemini", "cloud-g"] });
  await ins(db, "crow-c-cloud-a", "https://api.example.com/v1/r", { key: KEY_A });
  for (const id of ["cloud-h", "cloud-nokey", "cloud-lo", "cloud-g", "crow-c-cloud-a"]) {
    assert.deepEqual(await tick(db, id), { ok: false, reason: "not_eligible" }, id);
  }
  // addProvider's own write path is refused the same way.
  assert.deepEqual(await grantCloudConsent(db, "cloud-h", { actor: "t", expect: { baseUrl: "http://api.example.com/v1", apiKey: KEY_A } }), { ok: false, reason: "not_eligible" });
  assert.deepEqual(await readCloudConsent(db), {});
});

test("F2: addProvider on a cloud server the door would never serve (plain http) records no consent and reports not_needed", async () => {
  const db = newDb();
  const out = await addProvider(db, { presetId: "other", baseUrl: "http://api.example.com/v1", apiKey: KEY_A, modelIds: ["m1"] }, {
    testFn: async () => ({ ok: true, code: "ok", models: ["m1"], host: "api.example.com", baseUrl: "http://api.example.com/v1" }), invalidateFn: () => {},
  });
  assert.equal(out.ok, true);
  assert.equal(out.consent, "not_needed");
  assert.deepEqual(await readCloudConsent(db), {});
});

test("F2: an enabled cloud row the door would never serve shows a disabled switch with a plain reason, and no token", async () => {
  const db = newDb();
  await ins(db, "cloud-h", "http://api.example.com/v1", { key: KEY_A });
  await ins(db, "cloud-nokey", "https://api.example.com/v1/n");
  await ins(db, "cloud-g", "https://api.example.com/v1/g", { key: KEY_A });
  await db.execute({ sql: "UPDATE providers SET provider_type = ? WHERE id = ?", args: ["gemini", "cloud-g"] });
  await ins(db, "cloud-lo", "https://api.example.com/v1/l", { key: KEY_A });
  await db.execute({ sql: "UPDATE providers SET gpu_policy = ? WHERE id = ?", args: [JSON.stringify({ local_only: true }), "cloud-lo"] });
  await ins(db, "cloud-a", "https://api.example.com/v1/a", { key: KEY_A });
  for (const lang of ["en", "es"]) {
    const h = await tab.render({ req: { query: {} }, db, lang, piAgentDir: null, tasksDbPaths: [] });
    for (const [id, why] of [["cloud-h", "insecure"], ["cloud-nokey", "no_key"], ["cloud-g", "unsupported_type"], ["cloud-lo", "local_only"]]) {
      const tr = trOf(h, id);
      const reason = t(`providers.botsIneligible.${why}`, lang);
      assert.ok(reason && reason !== `providers.botsIneligible.${why}`, `${lang} ${why} has copy`);
      assert.ok(tr.includes(escapeAttr(reason)), `${lang} ${id} shows its reason`);
      assert.match(tr, /role="switch" aria-checked="false" disabled/, `${id} switch is disabled`);
      assert.ok(!tr.includes("llm_provider_bots_allow"), `${id} has no allow form`);
      assert.equal(tokenIn(tr), null, `${id} carries no token`);
    }
    assert.match(trOf(h, "cloud-a"), /llm_provider_bots_allow/, "an eligible row keeps its live switch");
  }
});

test("F2: a row that became ineligible after consent keeps a switch that only turns off", async () => {
  const db = newDb();
  await ins(db, "cloud-a", "https://api.example.com/v1/a", { key: KEY_A });
  assert.deepEqual(await tick(db, "cloud-a"), { ok: true });
  await db.execute({ sql: "UPDATE providers SET gpu_policy = ? WHERE id = ?", args: [JSON.stringify({ local_only: true }), "cloud-a"] });
  const tr = trOf(await tab.render({ req: { query: {} }, db, lang: "en", piAgentDir: null, tasksDbPaths: [] }), "cloud-a");
  assert.match(tr, /name="action" value="llm_provider_bots_deny"/);
  assert.ok(!tr.includes("llm_provider_bots_allow"));
  assert.ok(tr.includes(escapeAttr(t("providers.botsIneligible.local_only", "en"))));
  await post(db, "llm_provider_bots_deny", { id: "cloud-a" });
  assert.deepEqual(await readCloudConsent(db), {});
});
function escapeAttr(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
