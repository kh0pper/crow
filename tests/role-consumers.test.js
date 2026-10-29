import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../servers/db.js";
import { scanSlots } from "../servers/shared/model-consumers.js";
import { loadRoleContext, readBindings, readCustomRoleDefs } from "../servers/shared/model-roles-store.js";
import { SMART_TIER_ROLES } from "../servers/gateway/ai/smart-router.js";
import { rolesReaching, JOB_ROLES, listRoleConsumers } from "../servers/shared/role-consumers.js";

let dir, db;
const origWarn = console.warn;

const ins = (id, url, models) =>
  db.execute({
    sql: "INSERT INTO providers (id, base_url, api_key, host, models, disabled) VALUES (?,?,?,?,?,0)",
    args: [id, url, null, "local", JSON.stringify(models)],
  });
const setting = (key, value) =>
  db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: [key, JSON.stringify(value)] });
const bot = (id, value) =>
  db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)",
    args: [id, id.toUpperCase(), JSON.stringify({ models: { default: value }, gateways: [] })],
  });

before(async () => {
  console.warn = () => {};
  dir = mkdtempSync(join(tmpdir(), "role-consumers-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT NOT NULL, api_key TEXT, host TEXT, bundle_id TEXT,
      description TEXT, models TEXT NOT NULL DEFAULT '[]', disabled INTEGER DEFAULT 0, lamport_ts INTEGER DEFAULT 0,
      instance_id TEXT, provider_type TEXT, gpu_policy TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
  `);
  await ins("local-chat", "http://192.168.1.5:8000/v1", [{ id: "m1" }]);
  await ins("local-voice", "http://192.168.1.5:8011/v1", [{ id: "m2" }]);
  await bot("b1", "role:everyday");
  await bot("b2", "role:quick");
  await bot("b3", "local-chat/m1");
  await db.execute({ sql: "INSERT INTO schedules (task) VALUES (?)", args: ["pipeline:botcron:b2"] });
  await setting("model_role.everyday", { model: "local-chat/m1", fallback: ["quick"] });
  await setting("model_role.quick", { model: "local-voice/m2" });
});
after(() => { console.warn = origWarn; rmSync(dir, { recursive: true, force: true }); });

const ctx = async () => ({ bindings: await readBindings(db), customDefs: await readCustomRoleDefs(db) });
const roleCtx = () => loadRoleContext(db, { getOrCreateLocalInstanceId: () => "i-test" });
const scan = () => scanSlots(db, { withUnattended: true, includeSubagents: false, tasksDbPaths: [] });
const list = async (roleId, extra = {}) =>
  listRoleConsumers(db, roleId, { slots: await scan(), roleCtx: await roleCtx(), isPrimary: true, ...extra });
const ids = (arr) => arr.map((c) => c.id);
const byId = (arr, id) => arr.find((c) => c.id === id);

test("reach: a role plus every role whose bound ref or fallback chain reaches it", async () => {
  const r = rolesReaching("quick", await ctx());
  assert.ok(r instanceof Set);
  for (const id of ["quick", "everyday", "coordinator"]) assert.ok(r.has(id), id);
  assert.equal(r.has("voice"), false);
  // a custom role bound to role:quick reaches it; an unknown slot-only id does not
  const c = rolesReaching("quick", { bindings: { "c-x": { model: "role:quick" } }, extraIds: ["c-ghost"] });
  assert.ok(c.has("c-x"));
  assert.equal(c.has("c-ghost"), false);
});

test("JOB_ROLES is frozen and names every smart-router tier", () => {
  assert.ok(Object.isFrozen(JOB_ROLES));
  assert.equal(JOB_ROLES["llm-router:fast"], "voice");
  assert.equal(JOB_ROLES["llm-router:escalate"], "everyday");
  for (const [tier, role] of Object.entries(SMART_TIER_ROLES)) assert.equal(JOB_ROLES[`smart-router:${tier}`], role);
  assert.equal(JOB_ROLES.embed, "embed");
  assert.equal(JOB_ROLES.rerank, "rerank");
  assert.equal(JOB_ROLES.safety, "safety");
});

test("groups: unattended, bots with via, jobs; keepsOwnModel", async () => {
  const q = await list("quick");
  assert.deepEqual(Object.keys(q).sort(), ["bots", "jobs", "keepsOwnModel", "notAffected", "otherCrows", "subagents", "unattended"]);
  assert.deepEqual(ids(q.unattended), ["b2"]);
  assert.deepEqual(byId(q.unattended, "b2").via, ["quick"]);
  assert.deepEqual(ids(q.bots), ["b1"]);
  assert.deepEqual(byId(q.bots, "b1").via, ["everyday", "quick"]);
  assert.equal(byId(q.bots, "b1").kind, "bot");
  assert.equal(byId(q.bots, "b1").field, "models.default");
  assert.ok(byId(q.jobs, "llm-router:escalate"));
  assert.deepEqual(byId(q.jobs, "llm-router:escalate").via, ["everyday", "quick"]);
  assert.ok(byId(q.jobs, "smart-router:fast"));
  assert.equal(byId(q.jobs, "smart-router:fast").labelKey, "settings.providers.job.smart.fast");
  assert.equal(byId(q.jobs, "llm-router:fast"), undefined); // voice does not reach quick
  assert.deepEqual(q.otherCrows, []);
  assert.deepEqual(q.keepsOwnModel, []);

  const e = await list("everyday");
  assert.deepEqual(ids(e.keepsOwnModel), ["b3"]);
  assert.equal(e.keepsOwnModel[0].field, "models.default");
  assert.deepEqual(ids(e.bots), ["b1"]);
  assert.deepEqual(ids(e.unattended), ["b2"]); // quick falls back to everyday by default
  assert.deepEqual(byId(e.unattended, "b2").via, ["quick", "everyday"]);
});

test("vision tier listed (I11)", async () => {
  const slots = await scan();
  const v = slots.find((s) => s.id === "smart-router:vision");
  assert.ok(v);
  assert.equal(v.value, null);
  assert.equal(v.dynamic, true);
  for (const tier of Object.keys(SMART_TIER_ROLES)) assert.ok(slots.some((s) => s.id === `smart-router:${tier}`), tier);
  const r = await listRoleConsumers(db, "vision", { slots, roleCtx: await roleCtx(), isPrimary: true });
  assert.deepEqual(ids(r.jobs), ["smart-router:vision"]);
});

test("env not affected", async () => {
  const saved = process.env.COMPANION_ESCALATION_MODEL;
  let slots;
  try {
    process.env.COMPANION_ESCALATION_MODEL = "local-chat/m9";
    slots = await scan();
  } finally {
    if (saved === undefined) delete process.env.COMPANION_ESCALATION_MODEL; else process.env.COMPANION_ESCALATION_MODEL = saved;
  }
  const r = await listRoleConsumers(db, "quick", { slots, roleCtx: await roleCtx(), isPrimary: true });
  assert.ok(byId(r.notAffected, "llm-router:escalate"));
  assert.equal(byId(r.notAffected, "llm-router:escalate").field, "env:COMPANION_ESCALATION_MODEL");
  assert.equal(byId(r.jobs, "llm-router:escalate"), undefined);
});

test("co-hosted lists no sub-agents", async () => {
  await setting("model_role_subagents", { scout: { role: "quick" }, other: { role: "voice" } });
  try {
    assert.deepEqual((await list("quick", { isPrimary: false })).subagents, []);
    const p = await list("quick", { isPrimary: true });
    assert.deepEqual(ids(p.subagents), ["scout"]);
    assert.equal(p.subagents[0].kind, "subagent");
    assert.deepEqual(p.subagents[0].via, ["quick"]);
    // the default follows isDefaultCrowHome(env)
    const co = await listRoleConsumers(db, "quick", { slots: await scan(), roleCtx: await roleCtx(), env: { CROW_HOME: join(dir, "other-home") } });
    assert.deepEqual(co.subagents, []);
  } finally {
    await db.execute("DELETE FROM dashboard_settings WHERE key = 'model_role_subagents'");
  }
});

test("scans once itself when no slots are passed", async () => {
  const r = await listRoleConsumers(db, "quick", { roleCtx: await roleCtx(), isPrimary: true });
  assert.ok(byId(r.bots, "b1"));
});

test("dead slots are never listed", async () => {
  const slots = await scan();
  const dead = { kind: "gateway", id: "b9", label: "B9", field: "gateways[0].fast_voice_model", value: "role:quick", unattended: false, peerManaged: false, dead: true };
  const r = await listRoleConsumers(db, "quick", { slots: [...slots, dead], roleCtx: await roleCtx(), isPrimary: true });
  for (const group of Object.values(r)) assert.equal(byId(group, "b9"), undefined);
});

test("a phone slot lands in jobs", async () => {
  await db.execute({ sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?,?)", args: ["phone_local_model", "role:quick"] });
  try {
    const r = await list("quick");
    const p = byId(r.jobs, "phone_local_model");
    assert.ok(p);
    assert.equal(p.kind, "phone");
    assert.equal(p.labelKey, "settings.providers.phone.local");
    assert.deepEqual(p.via, ["quick"]);
    assert.equal(byId(r.bots, "phone_local_model"), undefined);
  } finally {
    await db.execute("DELETE FROM dashboard_settings WHERE key = 'phone_local_model'");
  }
});

test("env passed in is honoured when listRoleConsumers scans itself", async () => {
  assert.equal(process.env.COMPANION_ESCALATION_MODEL, undefined);
  const env = { COMPANION_ESCALATION_MODEL: "local-chat/m9" };
  const r = await listRoleConsumers(db, "quick", { roleCtx: await roleCtx(), isPrimary: true, env });
  assert.equal(byId(r.notAffected, "llm-router:escalate").field, "env:COMPANION_ESCALATION_MODEL");
  assert.equal(byId(r.jobs, "llm-router:escalate"), undefined);
});

test("a failed sub-agent read or role resolve logs one line and still lists", async () => {
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    const failing = {
      execute: (q) => (Array.isArray(q?.args) && q.args.includes("model_role_subagents")
        ? Promise.reject(new Error("database is locked")) : db.execute(q)),
    };
    const rc = await roleCtx();
    // a provider on an instance-id host with no ownInstanceId makes resolveRoleKey throw
    const bad = { ...rc, ownInstanceId: undefined, providers: rc.providers.map((p) => ({ ...p, host: "a".repeat(32) })) };
    const r = await listRoleConsumers(failing, "quick", { slots: await scan(), roleCtx: bad, isPrimary: true });
    assert.deepEqual(r.subagents, []);
    assert.deepEqual(r.keepsOwnModel, []);
    assert.ok(byId(r.bots, "b1"));
    assert.equal(lines.filter((l) => /sub-agent map unreadable: database is locked/.test(l)).length, 1);
    assert.equal(lines.filter((l) => /role:quick did not resolve/.test(l)).length, 1);
    assert.ok(lines.every((l) => l.startsWith("[roles] listRoleConsumers:")));
  } finally {
    console.warn = () => {};
  }
});
