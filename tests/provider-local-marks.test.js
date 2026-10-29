// tests/provider-local-marks.test.js — the strict local check and the
// operator's "This is local" mark (roles phase 2 Task 19, Kevin's Q2).
//
// A provider on a DNS name is "not proven local" (the strict check). The
// operator can mark such a row "This is local" on this box; the mark pins the
// hostname shown, so a peer rewriting the base URL lapses it. A one-time
// upgrade marks rows whose name resolves to this box. The classifier and
// safety never use marks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";
import { createDbClient } from "../servers/db.js";
import {
  readLocalMarks, markLocal, unmarkLocal, isStrictCloud, strictVoiceKeysInUse, upgradeLocalMarks,
  logStrictDisagreement, localMarkTokenFor, LOCAL_MARKS_KEY, LOCAL_MARKS_SEEDED_KEY, LOCAL_NOTICE_SHOWN_KEY,
} from "../servers/shared/provider-local-marks.js";
import { isCloudKey, whereItRuns } from "../servers/shared/model-roles.js";
import { loadRoleContext, setBinding, invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { listRolePicks } from "../servers/shared/role-picks.js";
import { previewRoleChange, applyRoleChange } from "../servers/shared/role-change.js";
import { isInstanceScope, isSyncable } from "../servers/gateway/dashboard/settings/sync-allowlist.js";
import { ensureCloudConsentSalt } from "../servers/shared/cloud-consent.js";
import { providerRowToObject } from "../servers/shared/provider-row.js";
import tab from "../servers/gateway/dashboard/settings/sections/llm/providers-tab.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const OWN = new Set();
const ENV = {};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "local-marks-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  const path = join(dir, "crow.db");
  const db = createDbClient(path);
  dbPaths.set(db, path);
  return { db, cleanup() { try { db.close(); } catch {} rmScratch(dir); } };
}
const dbPaths = new WeakMap();
const dbs = [];
after(() => { for (const d of dbs) d.cleanup(); });

const ins = (db, id, url, host, models) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled, lamport_ts, instance_id) VALUES (?,?,?,?,?,0,1,?)",
    args: [id, url, null, host, JSON.stringify(models.map((m) => ({ id: m }))), "a".repeat(32)],
  });
const setRaw = (db, key, value) =>
  db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [key, value] });
const getRaw = async (db, key) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] })).rows[0]?.value ?? null;
const providersOf = async (db) => (await db.execute("SELECT * FROM providers")).rows.map(providerRowToObject);
const notificationCount = async (db) => Number((await db.execute("SELECT COUNT(*) AS n FROM notifications")).rows[0].n);

const ADDRS = { "box.example.internal": "127.0.0.1", "nas.example.internal": "192.168.1.40", "proxy.example.internal": "127.0.0.1" };
const lookupFn = async (host) => {
  if (!ADDRS[host]) throw new Error(`ENOTFOUND ${host}`);
  return [{ address: ADDRS[host], family: 4 }];
};

/** The brief's fixture: voice fast on lan-dns, phone local on other-dns. */
async function seeded() {
  const d = fresh(); dbs.push(d);
  const { db } = d;
  await ins(db, "lan-dns", "http://box.example.internal:8011/v1", "local", ["m1"]);
  await ins(db, "other-dns", "http://nas.example.internal:8011/v1", "local", ["m2"]);
  await ins(db, "pub-ip", "https://203.0.113.9/v1", "local", ["p1"]);
  await setBinding(db, "voice", { model: "lan-dns/m1" }, { actor: "test" });
  await setRaw(db, "phone_local_model", "other-dns/m2");
  invalidateRoleContext();
  return db;
}

test("instance scope: the three keys are instance scope and never synced", () => {
  for (const k of [LOCAL_MARKS_KEY, LOCAL_MARKS_SEEDED_KEY, LOCAL_NOTICE_SHOWN_KEY]) {
    assert.equal(isInstanceScope(k), true, k);
    assert.equal(isSyncable(k), false, k);
  }
  assert.deepEqual([LOCAL_MARKS_KEY, LOCAL_MARKS_SEEDED_KEY, LOCAL_NOTICE_SHOWN_KEY],
    ["provider_local_marks", "provider_local_marks_seeded", "provider_local_notice_shown"]);
});

test("strictVoiceKeysInUse lists the voice fast key and the phone local key", async () => {
  const db = await seeded();
  const keys = await strictVoiceKeysInUse(db, { env: ENV });
  assert.ok(keys.includes("lan-dns/m1"), keys.join(","));
  assert.ok(keys.includes("other-dns/m2"), keys.join(","));
});

test("auto-mark own-box names: only the name that resolves to this box is marked; one notification; a second run does nothing", async () => {
  const db = await seeded();
  const before = await notificationCount(db);
  const r = await upgradeLocalMarks(db, { lookupFn, ownAddrs: OWN, env: ENV });
  assert.deepEqual(r.marked, ["lan-dns"]);
  assert.deepEqual(r.affected, ["other-dns"]);
  assert.deepEqual(r.errors, []);
  const marks = await readLocalMarks(db);
  assert.deepEqual(Object.keys(marks), ["lan-dns"]);
  assert.equal(marks["lan-dns"].host, "box.example.internal");
  assert.equal(marks["lan-dns"].by, "upgrade");
  assert.equal(await notificationCount(db), before + 1);
  const n = (await db.execute("SELECT title, action_url FROM notifications ORDER BY id DESC LIMIT 1")).rows[0];
  assert.match(n.title, /other-dns/);
  assert.match(n.action_url, /section=llm&tab=providers/);
  assert.ok(await getRaw(db, LOCAL_MARKS_SEEDED_KEY));
  assert.ok(await getRaw(db, LOCAL_NOTICE_SHOWN_KEY));

  let calls = 0;
  const again = await upgradeLocalMarks(db, { lookupFn: async (h) => { calls++; return lookupFn(h); }, ownAddrs: OWN, env: ENV });
  assert.deepEqual(again.marked, []);
  assert.deepEqual(again.affected, []);
  assert.equal(calls, 0, "no lookups on a second run");
  assert.equal(await notificationCount(db), before + 1);
});

test("flagged cloud stays cloud (N4): a host:cloud row is never marked and is strict cloud", async () => {
  const db = await seeded();
  await ins(db, "proxy", "http://proxy.example.internal:8030/v1", "cloud", ["m3"]);
  await ins(db, "flag-lan", "http://100.64.20.5:8030/v1", "cloud", ["m4"]);
  await setBinding(db, "voice", { model: "proxy/m3" }, { actor: "test" });
  invalidateRoleContext();
  let looked = [];
  const r = await upgradeLocalMarks(db, { lookupFn: async (h) => { looked.push(h); return lookupFn(h); }, ownAddrs: OWN, env: ENV });
  assert.equal(r.marked.includes("proxy"), false);
  assert.equal(looked.includes("proxy.example.internal"), false, "a flagged row is not even looked up");
  assert.equal(Object.hasOwn(await readLocalMarks(db), "proxy"), false);
  assert.deepEqual(await markLocal(db, "proxy", { actor: "t" }), { ok: false, reason: "flagged_cloud" });
  const providers = await providersOf(db);
  const localMarks = await readLocalMarks(db);
  assert.equal(isStrictCloud("proxy/m3", { providers, localMarks, ownAddrs: OWN }), true);
  assert.equal(isStrictCloud("flag-lan/m4", { providers, localMarks, ownAddrs: OWN }), true);
  // A mark that somehow exists for a flagged row never makes it local.
  const forged = { ...localMarks, proxy: { host: "proxy.example.internal", at: "x", by: "x" } };
  assert.equal(isStrictCloud("proxy/m3", { providers, localMarks: forged, ownAddrs: OWN }), true);
  assert.equal(isCloudKey("proxy/m3", { providers, localMarks: forged, ownAddrs: OWN }), true);
});

test("lookup failure retries: a timed-out lookup leaves the seeded flag unset and the row in errors", async () => {
  const db = await seeded();
  const hang = (h) => (h === "nas.example.internal" ? new Promise(() => {}) : lookupFn(h));
  const r = await upgradeLocalMarks(db, { lookupFn: hang, ownAddrs: OWN, env: ENV, timeoutMs: 30 });
  assert.deepEqual(r.errors, ["other-dns"]);
  assert.deepEqual(r.marked, ["lan-dns"]);
  assert.equal(await getRaw(db, LOCAL_MARKS_SEEDED_KEY), null);
  // The next boot retries, and this time succeeds.
  const r2 = await upgradeLocalMarks(db, { lookupFn, ownAddrs: OWN, env: ENV });
  assert.deepEqual(r2.errors, []);
  assert.deepEqual(r2.affected, ["other-dns"]);
  assert.ok(await getRaw(db, LOCAL_MARKS_SEEDED_KEY));
});

test("a lookup that throws goes to errors too", async () => {
  const db = await seeded();
  const r = await upgradeLocalMarks(db, { lookupFn: async () => { throw new Error("ESERVFAIL"); }, ownAddrs: OWN, env: ENV });
  assert.deepEqual(r.errors.sort(), ["lan-dns", "other-dns"]);
  assert.deepEqual(r.marked, []);
  assert.equal(await getRaw(db, LOCAL_MARKS_SEEDED_KEY), null);
});

test("marks never relax the classifier (minor e): safety still refuses a marked row", async () => {
  const db = await seeded();
  assert.deepEqual(await markLocal(db, "other-dns", { actor: "t" }), { ok: true });
  const localMarks = await readLocalMarks(db);
  const ctx = await loadRoleContext(db, { maxAgeMs: 0 });
  assert.deepEqual(ctx.localMarks, localMarks, "the role context carries the marks");
  const picks = listRolePicks("safety", { ctx, ownAddrs: OWN, localMarks });
  const p = picks.find((x) => x.key === "other-dns/m2");
  assert.ok(p, "other-dns/m2 is listed");
  assert.equal(p.allowed, false);
  const change = { model: "other-dns/m2" };
  const pv = await previewRoleChange(db, "safety", change, { ctx, env: ENV, ownAddrs: OWN, localMarks });
  const r = await applyRoleChange(db, "safety", change, { env: ENV, ownAddrs: OWN, localMarks, actor: "t", previewHash: pv.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cloud_refused");
});

test("marks honoured and lapse: a marked row is local until its host changes", async () => {
  const db = await seeded();
  const before = await providersOf(db);
  assert.equal(isCloudKey("lan-dns/m1", { providers: before, ownAddrs: OWN }), true, "a DNS name is not proven local");
  assert.deepEqual(await markLocal(db, "lan-dns", { actor: "t" }), { ok: true });
  const localMarks = await readLocalMarks(db);
  assert.equal(isCloudKey("lan-dns/m1", { providers: before, localMarks, ownAddrs: OWN }), false);
  assert.equal(isStrictCloud("lan-dns/m1", { providers: before, localMarks, ownAddrs: OWN }), false);
  assert.notEqual(whereItRuns("lan-dns/m1", { providers: before, localMarks, ownAddrs: OWN }), "unproven");
  // A peer rewrites the base URL to another host: the mark lapses.
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["http://elsewhere.example.internal:8011/v1", "lan-dns"] });
  const afterRows = await providersOf(db);
  assert.equal(isCloudKey("lan-dns/m1", { providers: afterRows, localMarks, ownAddrs: OWN }), true);
  assert.equal(isStrictCloud("lan-dns/m1", { providers: afterRows, localMarks, ownAddrs: OWN }), true);
  // Unmarking removes it.
  await unmarkLocal(db, "lan-dns");
  assert.deepEqual(await readLocalMarks(db), {});
});

test("a mark write invalidates the role context", async () => {
  const db = await seeded();
  const c1 = await loadRoleContext(db);
  assert.deepEqual(c1.localMarks, {});
  await markLocal(db, "lan-dns", { actor: "t" });
  const c2 = await loadRoleContext(db);
  assert.ok(c2.localMarks["lan-dns"], "the cached context was dropped");
  await unmarkLocal(db, "lan-dns");
  const c3 = await loadRoleContext(db);
  assert.deepEqual(c3.localMarks, {});
});

test("public refused: markLocal on a public or documentation IP literal gives public_address", async () => {
  const db = await seeded();
  assert.deepEqual(await markLocal(db, "pub-ip", { actor: "t" }), { ok: false, reason: "public_address" });
  // Every other IP literal (private, tailnet, loopback) is refused too: its address already decides.
  await ins(db, "lan-ip", "http://100.64.20.5:8030/v1", "local", ["q1"]);
  await ins(db, "loop-ip", "http://127.0.0.1:8030/v1", "local", ["q2"]);
  await ins(db, "v6-ip", "http://[fd00::5]:8030/v1", "local", ["q3"]);
  for (const id of ["lan-ip", "loop-ip", "v6-ip"]) {
    assert.deepEqual(await markLocal(db, id, { actor: "t" }), { ok: false, reason: "ip_literal" }, id);
  }
  assert.deepEqual(await readLocalMarks(db), {});
  assert.deepEqual(await markLocal(db, "nope", { actor: "t" }), { ok: false, reason: "not_found" });
});

test("markLocal with a stale page token is refused as changed", async () => {
  const db = await seeded();
  const salt = await ensureCloudConsentSalt(db);
  const row = (await providersOf(db)).find((p) => p.id === "other-dns");
  const token = localMarkTokenFor(row, salt);
  await db.execute({ sql: "UPDATE providers SET base_url = ? WHERE id = ?", args: ["http://moved.example.internal:8011/v1", "other-dns"] });
  assert.deepEqual(await markLocal(db, "other-dns", { actor: "t", expect: { token } }), { ok: false, reason: "changed" });
  assert.deepEqual(await markLocal(db, "other-dns", { actor: "t", expect: { token: "" } }), { ok: false, reason: "changed" });
  assert.deepEqual(await readLocalMarks(db), {});
  const now = (await providersOf(db)).find((p) => p.id === "other-dns");
  assert.deepEqual(await markLocal(db, "other-dns", { actor: "t", expect: { token: localMarkTokenFor(now, salt) } }), { ok: true });
  assert.equal((await readLocalMarks(db))["other-dns"].host, "moved.example.internal");
});

test("disagreement logged once per consumer and key", () => {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    logStrictDisagreement("voice", "other-dns/m2", { strictCloud: true, oldCloud: false });
    logStrictDisagreement("voice", "other-dns/m2", { strictCloud: true, oldCloud: false });
    logStrictDisagreement("voice", "same/m", { strictCloud: true, oldCloud: true });
    logStrictDisagreement("voice", "rev/m", { strictCloud: false, oldCloud: true }); // no reverse wording
  } finally { console.warn = orig; }
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "[roles] voice other-dns/m2: not proven local under the strict check (the old check said local)");
});

test("providers tab: the This-is-local checkbox shows for other-dns, not for a public IP row; posting it marks the row", async () => {
  const db = await seeded();
  await ins(db, "pub-real", "https://203.0.113.20/v1", "cloud", ["p2"]);
  const render = (lang = "en") => tab.render({ req: { query: {} }, db, lang, piAgentDir: null, tasksDbPaths: [] });
  const html = await render();
  const label = t("providers.isLocal", "en");
  const formFor = (id) => {
    const re = new RegExp(`<form[^>]*class="[^"]*llm-local-mark[^"]*"[^>]*>(?:(?!</form>)[\\s\\S])*name="id" value="${id}"(?:(?!</form>)[\\s\\S])*</form>`);
    return html.match(re)?.[0] || null;
  };
  const f = formFor("other-dns");
  assert.ok(f, "a checkbox form for other-dns");
  assert.match(f, /value="llm_provider_mark_local"/);
  assert.match(f, /role="checkbox" aria-checked="false"/);
  assert.ok(f.includes(label));
  assert.match(f, /name="local_token" value="[0-9a-f]{32}"/);
  assert.equal(formFor("pub-real"), null, "no checkbox on a public IP row");
  assert.equal(formFor("pub-ip"), null, "no checkbox on a documentation IP row");
  assert.ok((await render("es")).includes(t("providers.isLocal", "es")));

  const token = f.match(/name="local_token" value="([0-9a-f]{32})"/)[1];
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; }, status() { return this; }, type() { return this; }, send() {} };
  const handled = await tab.handleAction({ req: { body: { action: "llm_provider_mark_local", id: "other-dns", local_token: token } }, res, db, action: "llm_provider_mark_local" });
  assert.equal(handled, true);
  assert.match(redirected, /section=llm&tab=providers/);
  assert.equal((await readLocalMarks(db))["other-dns"].host, "nas.example.internal");

  const html2 = await tab.render({ req: { query: {} }, db, lang: "en", piAgentDir: null, tasksDbPaths: [] });
  assert.match(html2, /value="llm_provider_unmark_local"[\s\S]*?name="id" value="other-dns"[\s\S]*?aria-checked="true"/);
  await tab.handleAction({ req: { body: { action: "llm_provider_unmark_local", id: "other-dns" } }, res, db, action: "llm_provider_unmark_local" });
  assert.deepEqual(await readLocalMarks(db), {});

  // A stale token: refused, redirected with the "changed" note, nothing marked.
  await tab.handleAction({ req: { body: { action: "llm_provider_mark_local", id: "other-dns", local_token: "0".repeat(32) } }, res, db, action: "llm_provider_mark_local" });
  assert.match(redirected, /local=changed/);
  assert.deepEqual(await readLocalMarks(db), {});
});

test("models page: the local notice banner shows the affected rows and can be dismissed", async () => {
  const db = await seeded();
  await upgradeLocalMarks(db, { lookupFn, ownAddrs: OWN, env: ENV });
  const { default: models, localNoticeHtml } = await import("../servers/gateway/dashboard/settings/sections/models.js");
  const notice = await localNoticeHtml(db, { lang: "en", env: ENV, ownAddrs: OWN });
  assert.ok(notice.includes("other-dns"), notice);
  assert.equal(notice.includes("lan-dns"), false, "a marked row is not listed");
  assert.match(notice, /value="models_local_notice_dismiss"/);
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  const handled = await models.handleAction({ req: { body: { action: "models_local_notice_dismiss" } }, res, db, action: "models_local_notice_dismiss" });
  assert.equal(handled, true);
  assert.match(redirected, /section=models/);
  assert.equal(await localNoticeHtml(db, { lang: "en", env: ENV, ownAddrs: OWN }), "");
});

test("models page: no banner while nothing is affected", async () => {
  const db = await seeded();
  await markLocal(db, "lan-dns", { actor: "t" });
  await markLocal(db, "other-dns", { actor: "t" });
  const { localNoticeHtml } = await import("../servers/gateway/dashboard/settings/sections/models.js");
  assert.equal(await localNoticeHtml(db, { lang: "en", env: ENV, ownAddrs: OWN }), "");
});

test("boot: upgradeLocalMarksAtBoot uses its own client, closes it, never throws, and skips a --no-auth gateway", async () => {
  const { upgradeLocalMarksAtBoot } = await import("../servers/gateway/boot/admin-api.js");
  let closed = 0, ran = 0;
  const fake = { close() { closed++; } };
  await upgradeLocalMarksAtBoot({ dbFactory: () => fake, upgradeFn: async (db) => { ran++; assert.equal(db, fake); throw new Error("boom"); } });
  assert.equal(ran, 1);
  assert.equal(closed, 1);
  const r = await upgradeLocalMarksAtBoot({ noAuth: true, dbFactory: () => { throw new Error("must not open"); } });
  assert.deepEqual(r, { skipped: true });
  // A factory that throws is swallowed too.
  await upgradeLocalMarksAtBoot({ dbFactory: () => { throw new Error("no db"); } });
});

// ---- fix round 1 -----------------------------------------------------------------

const door = (id, host, upstream, extra = {}) => ({
  id, baseUrl: `http://${host}:3001/llm/p/${upstream}/v1`, bundleId: "fixture-bundle", host: "local", models: [{ id: "m" }], ...extra,
});

test("three hops: a marked DNS door, then a cloud-flagged door on 100.64.20.7, then loopback, reads cloud", () => {
  const providers = [
    door("a", "gw.example.internal", "b"),
    door("b", "100.64.20.7", "c", { host: "cloud" }),
    { id: "c", baseUrl: "http://127.0.0.1:8011/v1", host: "local", models: [{ id: "m" }] },
  ];
  const localMarks = { a: { host: "gw.example.internal", at: "x", by: "t" } };
  assert.equal(isCloudKey("a/m", { providers, localMarks, ownAddrs: OWN }), false, "the walk alone says local");
  assert.equal(isStrictCloud("a/m", { providers, localMarks, ownAddrs: OWN }), true);
  assert.equal(isStrictCloud("b/m", { providers, localMarks, ownAddrs: OWN }), true);
  // Without the flag the same chain is local.
  const unflagged = providers.map((p) => (p.id === "b" ? { ...p, host: "local" } : p));
  assert.equal(isStrictCloud("a/m", { providers: unflagged, localMarks, ownAddrs: OWN }), false);
  // An unmarked DNS hop anywhere in the chain is strict cloud.
  assert.equal(isStrictCloud("a/m", { providers: unflagged, localMarks: {}, ownAddrs: OWN }), true);
});

test("a lookup answering loopback plus a foreign address does not mark", async () => {
  const db = await seeded();
  const mixed = async (h) => (h === "box.example.internal"
    ? [{ address: "127.0.0.1", family: 4 }, { address: "198.51.100.7", family: 4 }]
    : lookupFn(h));
  const r = await upgradeLocalMarks(db, { lookupFn: mixed, ownAddrs: OWN, env: ENV });
  assert.deepEqual(r.marked, []);
  assert.deepEqual(r.affected.sort(), ["lan-dns", "other-dns"]);
  assert.deepEqual(await readLocalMarks(db), {});
});

test("a name resolving to one of this box's own addresses is marked", async () => {
  const db = await seeded();
  const r = await upgradeLocalMarks(db, { lookupFn, ownAddrs: new Set(["192.168.1.40"]), env: ENV });
  assert.deepEqual(r.marked.sort(), ["lan-dns", "other-dns"]);
  assert.deepEqual(r.affected, []);
  assert.equal((await readLocalMarks(db))["other-dns"].host, "nas.example.internal");
});

test("a row flagged cloud after it was marked is strict cloud", async () => {
  const db = await seeded();
  assert.deepEqual(await markLocal(db, "lan-dns", { actor: "t" }), { ok: true });
  const localMarks = await readLocalMarks(db);
  assert.equal(isStrictCloud("lan-dns/m1", { providers: await providersOf(db), localMarks, ownAddrs: OWN }), false);
  // A peer's sync rewrites the stored host to "cloud"; the mark stays stored but no longer counts.
  await db.execute({ sql: "UPDATE providers SET host = 'cloud' WHERE id = ?", args: ["lan-dns"] });
  const now = await providersOf(db);
  assert.equal(isStrictCloud("lan-dns/m1", { providers: now, localMarks, ownAddrs: OWN }), true);
  assert.equal(isCloudKey("lan-dns/m1", { providers: now, localMarks, ownAddrs: OWN }), true);
});

test("the snapshot cloud flag ignores the marks the role context carries", async () => {
  const db = await seeded();
  await setBinding(db, "everyday", { model: "lan-dns/m1" }, { actor: "t" });
  await markLocal(db, "lan-dns", { actor: "t" });
  const ctx = await loadRoleContext(db, { maxAgeMs: 0 });
  assert.ok(ctx.localMarks["lan-dns"], "the context carries the mark");
  const { buildRoleSnapshot } = await import("../servers/shared/model-roles-snapshot.js");
  const snap = buildRoleSnapshot(ctx);
  assert.equal(snap.roles.everyday.resolved, "lan-dns/m1");
  assert.equal(snap.roles.everyday.cloud, true, "a marked DNS row is still cloud for pi");
});

test("the bot classifier ignores marks: a safety role on a marked DNS row is not used", async () => {
  const db = await seeded();
  await setBinding(db, "safety", { model: "other-dns/m2" }, { actor: "t" });
  await markLocal(db, "other-dns", { actor: "t" });
  const { default: Database } = await import("better-sqlite3");
  const conn = new Database(dbPaths.get(db), { readonly: true });
  try {
    const { readBotClassifierSync } = await import("../scripts/pi-bots/bot-classifier.mjs");
    const sel = readBotClassifierSync(conn, { localInstanceId: "a".repeat(32) });
    assert.notEqual(sel.source, "role", JSON.stringify(sel));
    assert.equal(sel.ok && sel.model === "m2", false, JSON.stringify(sel));
  } finally { conn.close(); }
});

test("picks and the change preview use the context's marks; safety's picks and preview stay unmarked", async () => {
  const db = await seeded();
  const ctx0 = await loadRoleContext(db, { maxAgeMs: 0 });
  const pick = (roleId, ctx) => listRolePicks(roleId, { ctx, ownAddrs: OWN }).find((x) => x.key === "lan-dns/m1");
  assert.equal(pick("everyday", ctx0).where, "unproven");
  const pv0 = await previewRoleChange(db, "everyday", { model: "lan-dns/m1" }, { ctx: ctx0, env: ENV, ownAddrs: OWN });
  assert.ok(pv0.cloud, "unmarked: the sheet warns");

  await markLocal(db, "lan-dns", { actor: "t" });
  const ctx = await loadRoleContext(db, { maxAgeMs: 0 });
  assert.equal(pick("everyday", ctx).where, "other_box", "the picks list honours the mark");
  const pv = await previewRoleChange(db, "everyday", { model: "lan-dns/m1" }, { ctx, env: ENV, ownAddrs: OWN });
  assert.equal(pv.cloud, null, "marked: no cloud warning");
  assert.equal(pv.next.where, "other_box");

  // Safety: unmarked whatever the context carries.
  const sp = pick("safety", ctx);
  assert.equal(sp.where, "unproven");
  assert.equal(sp.allowed, false);
  const spv = await previewRoleChange(db, "safety", { model: "lan-dns/m1" }, { ctx, env: ENV, ownAddrs: OWN });
  assert.ok(spv.cloud, "safety's preview still warns");
  assert.equal(spv.next.where, "unproven");
  assert.ok(spv.refused.length, "and refuses");
  // Even an explicit marks argument does not reach safety.
  const spv2 = await previewRoleChange(db, "safety", { model: "lan-dns/m1" }, { ctx, env: ENV, ownAddrs: OWN, localMarks: ctx.localMarks });
  assert.ok(spv2.cloud);

  // A preview hash from the page's preview still applies (same marks on both sides).
  const r = await applyRoleChange(db, "everyday", { model: "lan-dns/m1" }, { env: ENV, ownAddrs: OWN, actor: "t", previewHash: pv.previewHash, ackUnattended: true });
  assert.equal(r.ok, true, r.reason);
});

test("/api/roles picks and preview agree with the Models page chip", async () => {
  const db = await seeded();
  await markLocal(db, "lan-dns", { actor: "t" });
  const express = (await import("express")).default;
  const { default: rolesApiRouter } = await import("../servers/gateway/routes/roles-api.js");
  const app = express();
  app.use(express.json());
  const dbFactory = () => new Proxy(db, { get: (tgt, k) => (k === "close" ? () => {} : Reflect.get(tgt, k)) });
  app.use(rolesApiRouter({ dbFactory, sessionGate: (_q, _r, n) => n(), env: {}, ownAddrs: OWN, localInstanceId: () => "i-self", recommendedFn: () => [] }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const picks = await (await fetch(`${base}/api/roles/everyday/picks`)).json();
    assert.equal(picks.picks.find((x) => x.key === "lan-dns/m1")?.where, "other_box");
    const safety = await (await fetch(`${base}/api/roles/safety/picks`)).json();
    const sp = safety.picks.find((x) => x.key === "lan-dns/m1");
    assert.equal(sp?.where, "unproven");
    assert.equal(sp?.allowed, false);
    const pv = await (await fetch(`${base}/api/roles/everyday/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "lan-dns/m1" }) })).json();
    assert.equal(pv.cloud, null);
    const spv = await (await fetch(`${base}/api/roles/safety/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "lan-dns/m1" }) })).json();
    assert.ok(spv.cloud);
  } finally { server.close(); }
});

test("a failed notification leaves the done flag unset; the next boot sends it", async () => {
  const db = await seeded();
  const r = await upgradeLocalMarks(db, { lookupFn, ownAddrs: OWN, env: ENV, notifyFn: async () => { throw new Error("delivery down"); } });
  assert.deepEqual(r.affected, ["other-dns"]);
  assert.equal(await getRaw(db, LOCAL_MARKS_SEEDED_KEY), null);
  assert.equal(await getRaw(db, LOCAL_NOTICE_SHOWN_KEY), null);
  let sent = 0;
  await upgradeLocalMarks(db, { lookupFn, ownAddrs: OWN, env: ENV, notifyFn: async () => { sent++; } });
  assert.equal(sent, 1);
  assert.ok(await getRaw(db, LOCAL_MARKS_SEEDED_KEY));
  assert.ok(await getRaw(db, LOCAL_NOTICE_SHOWN_KEY));
});

test("two upgrades at once in one process share one run, even through separate clients", async () => {
  const db = await seeded();
  const db2 = createDbClient(dbPaths.get(db));
  try {
    let lookups = 0, release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (h) => { lookups++; await gate; return lookupFn(h); };
    const p1 = upgradeLocalMarks(db, { lookupFn: slow, ownAddrs: OWN, env: ENV, notifyFn: async () => {} });
    const p2 = upgradeLocalMarks(db2, { lookupFn: slow, ownAddrs: OWN, env: ENV, notifyFn: async () => {} });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, b, "the same result object");
    assert.equal(lookups, 2, "one lookup per candidate row, not two runs");
  } finally { db2.close(); }
});

test("providers tab: a refused mark redirects with its reason and shows its line", async () => {
  const db = await seeded();
  let redirected = null;
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  await tab.handleAction({ req: { body: { action: "llm_provider_mark_local", id: "pub-ip", local_token: "0".repeat(32) } }, res, db, action: "llm_provider_mark_local" });
  assert.match(redirected, /local=public_address$/);
  const html = await tab.render({ req: { query: { local: "ip_literal" } }, db, lang: "es", piAgentDir: null, tasksDbPaths: [] });
  assert.ok(html.includes(t("providers.localRefused.ip_literal", "es")));
  const plain = await tab.render({ req: { query: { local: "<script>" } }, db, lang: "en", piAgentDir: null, tasksDbPaths: [] });
  assert.equal(plain.includes("<script>"), false);
});
