import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../servers/db.js";
import { loadRoleContext, invalidateRoleContext } from "../servers/shared/model-roles-store.js";
import { readSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { resolveProviderForTask, clearProviderTaskCache, EMBED_TASKS } from "../servers/shared/provider-task.js";
import { LEGACY_PINS, previewRoleChange, applyRoleChange } from "../servers/shared/role-change.js";

let dir, db;
const origWarn = console.warn;
const OWN = new Set(); // no own addresses: loopback still counts as here

const ins = (id, url, models, disabled = 0) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,?)",
    args: [id, url, null, "local", JSON.stringify(models), disabled],
  });
const raw = (key, value) =>
  db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [key, value] });
const bind = (id, value) => raw(`model_role.${id}`, JSON.stringify(value));
const bot = (id, value) =>
  db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
    args: [id, id.toUpperCase(), JSON.stringify({ models: { default: value }, gateways: [] })],
  });
const rowOf = async (id) =>
  (await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [`model_role.${id}`] })).rows[0]?.value ?? null;

const ENV = {}; // no env pins unless a test sets one
const ctx = () => loadRoleContext(db, { getOrCreateLocalInstanceId: () => "i-test" });
const preview = async (roleId, change, extra = {}) =>
  previewRoleChange(db, roleId, change, { ctx: await ctx(), env: ENV, ownAddrs: OWN, ...extra });
const apply = (roleId, change, opts) => applyRoleChange(db, roleId, change, { env: ENV, ownAddrs: OWN, actor: "test", ...opts });

before(async () => {
  console.warn = () => {};
  dir = mkdtempSync(join(tmpdir(), "role-change-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (key, instance_id));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
  `);
});
after(() => { console.warn = origWarn; rmSync(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.executeMultiple("DELETE FROM providers; DELETE FROM dashboard_settings; DELETE FROM dashboard_settings_overrides; DELETE FROM pi_bot_defs;");
  await ins("local-chat", "http://127.0.0.1:8003/v1", [{ id: "m1" }]);
  await ins("local-voice", "http://127.0.0.1:8011/v1", [{ id: "m2" }]);
  // A public literal, so whereItRuns says "cloud". A documentation-range literal
  // (203.0.113.x) still counts as cloud for isCloudKey, but whereItRuns labels it
  // "unproven", not "cloud".
  await ins("cloud-a", "https://8.8.8.8/v1", [{ id: "c1" }]);
  await ins("emb-a", "http://127.0.0.1:8020/v1", [{ id: "e1", task: "embed" }, { id: "e2", task: "embed" }]);
  await ins("emb-b", "http://127.0.0.1:8021/v1", [{ id: "e1", task: "embed" }]);
  for (const k of Object.keys(ENV)) delete ENV[k];
  invalidateRoleContext();
  clearProviderTaskCache();
});

test("LEGACY_PINS is frozen and names each pin", () => {
  assert.ok(Object.isFrozen(LEGACY_PINS));
  assert.deepEqual(LEGACY_PINS, {
    embed: { setting: "embed_provider", env: "CROW_EMBED_PROVIDER" },
    rerank: { setting: "rerank_provider", env: "CROW_RERANK_PROVIDER" },
    safety: { setting: "bot_safety_classifier" },
  });
});

test("cloud behind a working local model warns", async () => {
  await bind("expert", { model: "cloud-a/c1" });
  const p = await preview("everyday", { model: "local-chat/m1", fallback: ["expert"] });
  assert.equal(p.next.key, "local-chat/m1");
  assert.equal(p.next.where, "here");
  assert.deepEqual(p.cloud, { host: "8.8.8.8", viaRole: "everyday", model: "cloud-a/c1", now: false });
  assert.equal(p.needs.ackCloud, true);
});

test("clearing reaches cloud through the default chain", async () => {
  await bind("quick", { model: "cloud-a/c1" });
  await bind("everyday", { model: "local-chat/m1", fallback: [] });
  const p = await preview("everyday", { model: null });
  assert.equal(p.current.key, "local-chat/m1");
  assert.equal(p.next.key, "cloud-a/c1");
  assert.equal(p.next.where, "cloud");
  assert.equal(p.cloud.now, true);
  assert.equal(p.cloud.viaRole, "everyday");
});

test("consumers of a fallback-served role", async () => {
  await db.execute("UPDATE providers SET disabled = 1 WHERE id = 'local-chat'");
  await bind("everyday", { model: "local-chat/m1", fallback: ["quick"] });
  const p = await preview("quick", { model: "cloud-a/c1" });
  assert.ok(p.consumers.jobs.some((c) => c.id === "llm-router:escalate"));
  assert.deepEqual(p.needs, { ackUnattended: true, ackCloud: true });
});

test("local rebind has no cloud", async () => {
  const p = await preview("quick", { model: "local-chat/m1" });
  assert.equal(p.cloud, null);
  assert.equal(p.needs.ackCloud, false);
  assert.deepEqual(p.refused, []);
});

test("local rebind under a cloud consumer has no cloud", async () => {
  await bind("everyday", { model: "cloud-a/c1", fallback: ["quick"] });
  const p = await preview("quick", { model: "local-chat/m1" });
  assert.equal(p.cloud, null);
  assert.equal(p.needs.ackCloud, false);
});

test("the hypothetical context never mutates the memoized one", async () => {
  await bind("quick", { model: "local-chat/m1" });
  const c = await ctx();
  const before = JSON.stringify(c.bindings);
  await previewRoleChange(db, "quick", { model: "cloud-a/c1" }, { ctx: c, env: ENV, ownAddrs: OWN });
  assert.equal(JSON.stringify(c.bindings), before);
});

test("acks and hash enforced", async () => {
  const change = { model: "cloud-a/c1" };
  const p = await preview("quick", change);
  assert.match(p.previewHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.needs, { ackUnattended: true, ackCloud: true });

  let r = await apply("quick", change, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "preview_changed");
  assert.ok(r.preview && r.preview.previewHash);

  r = await apply("quick", change, { previewHash: p.previewHash });
  assert.equal(r.reason, "needs_ack_unattended");
  assert.equal(await rowOf("quick"), null);

  r = await apply("quick", change, { previewHash: p.previewHash, ackUnattended: true });
  assert.equal(r.reason, "needs_ack_cloud");
  assert.equal(await rowOf("quick"), null);

  await bot("b9", "role:quick");
  r = await apply("quick", change, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.reason, "preview_changed");
  assert.ok(r.preview.consumers.bots.some((c) => c.id === "b9") || r.preview.consumers.unattended.some((c) => c.id === "b9"));
  assert.equal(await rowOf("quick"), null);

  const p2 = await preview("quick", change);
  r = await apply("quick", change, { previewHash: p2.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.ok, true);
  const stored = JSON.parse(await rowOf("quick"));
  assert.equal(stored.model, "cloud-a/c1");
  assert.equal("seeded" in stored, false);
  assert.equal(stored.by, "test");
});

test("safety refuses cloud on the server", async () => {
  const change = { model: "cloud-a/c1" };
  const p = await preview("safety", change);
  const r = await apply("safety", change, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cloud_refused");
  assert.equal(await rowOf("safety"), null);
});

test("classifier refusal listed", async () => {
  await bind("safety", { model: "role:quick" });
  const p = await preview("quick", { model: "cloud-a/c1" });
  assert.ok(p.refused.some((x) => x.id === "safety" && x.labelKey === "settings.providers.job.safety"));
});

test("phone local slot refusal listed", async () => {
  await raw("phone_local_model", "role:quick");
  const p = await preview("quick", { model: "cloud-a/c1" });
  assert.ok(p.refused.some((x) => x.id === "phone_local_model" && x.labelKey === "settings.providers.phone.local"));
  const q = await preview("quick", { model: "local-chat/m1" });
  assert.deepEqual(q.refused, []);
});

test("pin shown and replaced", async () => {
  await raw("embed_provider", "emb-a");
  const dbFactory = () => ({ execute: (...a) => db.execute(...a) });
  const resolve = () => resolveProviderForTask({ tasks: EMBED_TASKS, envVar: "CROW_EMBED_PROVIDER", settingKey: "embed_provider", roleId: "embed", dbFactory });
  assert.equal(await resolve(), "emb-a"); // and now cached

  const p = await preview("embed", { model: "emb-b/e1" });
  assert.deepEqual(p.pin, { setting: "embed_provider", value: "emb-a" });
  assert.equal(p.envPinned, false);
  assert.equal(p.reembed, true);
  const same = await preview("embed", { model: "emb-a/e2" });
  assert.equal(same.reembed, false);

  const r = await apply("embed", { model: "emb-b/e1" }, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true, replacePin: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(await readSetting(db, "embed_provider"), "");
  assert.equal(await resolve(), "emb-b");
});

test("env pin never touched", async () => {
  ENV.CROW_EMBED_PROVIDER = "emb-a";
  const p = await preview("embed", { model: "emb-b/e1" });
  assert.equal(p.envPinned, true);
  const r = await apply("embed", { model: "emb-b/e1" }, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true, replacePin: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(ENV.CROW_EMBED_PROVIDER, "emb-a");
  assert.equal(p.reembed, false); // the env still decides the provider
});

test("safety onto a cloud model on a disabled provider is refused", async () => {
  await db.execute("UPDATE providers SET disabled = 1 WHERE id = 'cloud-a'");
  const change = { model: "cloud-a/c1" };
  const p = await preview("safety", change);
  const r = await apply("safety", change, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.reason, "cloud_refused");
  assert.equal(await rowOf("safety"), null);
});

test("safety onto a local model with a cloud fallback is refused", async () => {
  await bind("quick", { model: "cloud-a/c1" });
  const change = { model: "local-chat/m1", fallback: ["quick"] };
  const p = await preview("safety", change);
  assert.equal(p.next.key, "local-chat/m1");
  const r = await apply("safety", change, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.reason, "cloud_refused");
  assert.equal(await rowOf("safety"), null);
});

test("safety onto a local model with only local fallbacks applies", async () => {
  await bind("quick", { model: "local-voice/m2" });
  const change = { model: "local-chat/m1", fallback: ["quick"] };
  const p = await preview("safety", change);
  assert.equal(p.cloud, null);
  const r = await apply("safety", change, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(JSON.parse(await rowOf("safety")).model, "local-chat/m1");
});

test("a quick rebind that moves no job needs no ackUnattended", async () => {
  ENV.CROW_SMART_ROUTER_FAST = "local-chat/m1"; // the fast tier is set by env: not affected
  await bind("everyday", { model: "local-voice/m2", fallback: [] });
  const change = { model: "local-chat/m1" };
  const p = await preview("quick", change);
  assert.ok(p.consumers.notAffected.some((c) => c.id === "smart-router:fast"));
  assert.deepEqual(p.needs, { ackUnattended: false, ackCloud: false });
  const r = await apply("quick", change, { previewHash: p.previewHash });
  assert.equal(r.ok, true, r.reason);
});

test("a fallback-only exposure needs only ackCloud", async () => {
  await bind("everyday", { model: "local-chat/m1", fallback: ["expert"] });
  const change = { model: "cloud-a/c1" };
  const p = await preview("expert", change);
  assert.ok(p.consumers.jobs.some((c) => c.id === "llm-router:escalate")); // listed, but it does not move
  assert.deepEqual(p.cloud, { host: "8.8.8.8", viaRole: "expert", model: "cloud-a/c1", now: true });
  assert.deepEqual(p.needs, { ackUnattended: false, ackCloud: true });
  let r = await apply("expert", change, { previewHash: p.previewHash });
  assert.equal(r.reason, "needs_ack_cloud");
  r = await apply("expert", change, { previewHash: p.previewHash, ackCloud: true });
  assert.equal(r.ok, true, r.reason);
});

test("replacePin false leaves the pin in place", async () => {
  await raw("embed_provider", "emb-a");
  const change = { model: "emb-b/e1" };
  const p = await preview("embed", change);
  const r = await apply("embed", change, { previewHash: p.previewHash, ackUnattended: true, ackCloud: true, replacePin: false });
  assert.equal(r.ok, true, r.reason);
  assert.equal(await readSetting(db, "embed_provider"), "emb-a");
});

test("the hash covers the fresh cloud pairs and envPinned", async () => {
  await ins("cloud-b", "https://8.8.4.4/v1", [{ id: "c2" }]);
  await bind("expert", { model: "cloud-a/c1" });
  const change = { model: "local-chat/m1", fallback: ["expert", "critic"] };
  const a = await preview("everyday", change);
  await bind("critic", { model: "cloud-b/c2" }); // one more fresh pair, same first pair
  const b = await preview("everyday", change);
  assert.deepEqual(b.cloud, a.cloud);
  assert.equal(b.next.key, a.next.key);
  assert.notEqual(b.previewHash, a.previewHash);

  const e1 = await preview("embed", { model: "emb-b/e1" });
  ENV.CROW_EMBED_PROVIDER = "emb-a";
  const e2 = await preview("embed", { model: "emb-b/e1" });
  assert.equal(e2.envPinned, true);
  assert.notEqual(e1.previewHash, e2.previewHash);
});
