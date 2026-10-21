import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import {
  scanSlots, isUnattended, loadUnattendedContext, consumersOfRole, consumersOfModel, piConfigRefs,
} from "../servers/shared/model-consumers.js";

let dir, db, projStore, mainStore;

const def = (extra) => JSON.stringify({ models: { default: "local-chat/m1" }, gateways: [], ...extra });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "model-consumers-"));
  db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL DEFAULT '* * * * *');
    CREATE TABLE bot_jobs (job_id TEXT PRIMARY KEY, bot_id TEXT, status TEXT);
    CREATE TABLE bot_registry (bot_id TEXT PRIMARY KEY);
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, tasks_db_uri TEXT);
  `);
  mainStore = join(dir, "tasks.db");
  projStore = join(dir, "proj.db");
  for (const p of [mainStore, projStore]) {
    const h = new Database(p);
    h.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, assigned_bot TEXT, archived_at TEXT)");
    if (p === projStore) h.prepare("INSERT INTO tasks_items (assigned_bot) VALUES ('carded')").run();
    if (p === projStore) h.prepare("INSERT INTO tasks_items (assigned_bot, archived_at) VALUES ('perchy', '2026-01-01')").run();
    h.close();
  }
  await db.execute({ sql: "INSERT INTO project_spaces (tasks_db_uri) VALUES (?)", args: [`file:${projStore}`] });
  const bots = {
    heartbeat: def({ triggers: undefined }),
    perchy: def({ gateways: [{ type: "perch", fast_voice_model: "local-voice/v1" }], models: { default: "role:everyday", escalation: "cloud-a/m9" } }),
    gmailer: def({ gateways: [{ type: "gmail" }] }),
    glasses: def({ gateways: [{ type: "glasses" }], fast_voice_model: "local-voice/v1" }),
    carded: def({ gateways: [{ type: "perch" }] }),
  };
  for (const [id, d] of Object.entries(bots)) {
    await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)", args: [id, id, d] });
  }
  await db.execute({ sql: "INSERT INTO schedules (task) VALUES (?)", args: ["pipeline:botcron:heartbeat"] });
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('remote_managed_bots', ?), ('phone_local_model','local-chat/m1')", args: [JSON.stringify(["glasses"])] });
});

after(() => { db?.close?.(); rmSync(dir, { recursive: true, force: true }); });

const unattendedOf = async (id) => {
  const row = (await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [id] })).rows[0];
  const d = JSON.parse(row.definition);
  return isUnattended(d, await loadUnattendedContext(db, id, { tasksDbPaths: [mainStore, projStore] }));
};

test("isUnattended: heartbeat true, perch-only false, gmail true, glasses true, carded true", async () => {
  assert.equal(await unattendedOf("heartbeat"), true);
  assert.equal(await unattendedOf("perchy"), false); // its only card is archived
  assert.equal(await unattendedOf("gmailer"), true);
  assert.equal(await unattendedOf("glasses"), true);
  assert.equal(await unattendedOf("carded"), true);
});

test("isUnattended: open jobs and registry rows count; missing tables and files never throw", async () => {
  assert.equal(isUnattended({ gateways: [] }, { openJobs: 1 }), true);
  assert.equal(isUnattended({ gateways: [] }, { registryRow: true }), true);
  assert.equal(isUnattended({ gateways: [{ type: "perch" }] }, {}), false);
  const bare = createDbClient(join(dir, "bare.db"));
  const ctx = await loadUnattendedContext(bare, "x", { tasksDbPaths: [join(dir, "nope.db")] });
  assert.deepEqual(ctx, { botcron: false, openJobs: 0, assignedCards: 0, registryRow: false });
  bare.close?.();
  await db.execute("INSERT INTO bot_jobs VALUES ('j1','jobby','running')");
  assert.equal((await loadUnattendedContext(db, "jobby", { tasksDbPaths: [] })).openJobs, 1);
});

test("scanSlots: one slot per non-empty field; gateway fast_voice_model is dead; peerManaged and phone", async () => {
  const slots = await scanSlots(db, { tasksDbPaths: [mainStore, projStore] });
  const bot = slots.filter((s) => s.kind === "bot" || s.kind === "gateway");
  assert.equal(bot.filter((s) => s.id === "perchy").length, 3);
  const gw = bot.find((s) => s.kind === "gateway");
  assert.equal(gw.dead, true);
  assert.equal(gw.field, "gateways[0].fast_voice_model");
  assert.equal(bot.filter((s) => s.id === "heartbeat").length, 1);
  assert.equal(slots.find((s) => s.id === "glasses" && s.field === "models.default").peerManaged, true);
  assert.equal(slots.find((s) => s.id === "heartbeat").unattended, true);
  assert.equal(slots.find((s) => s.id === "perchy" && s.field === "models.default").unattended, false);
  assert.equal(slots.find((s) => s.kind === "phone").value, "local-chat/m1");
  assert.ok(slots.some((s) => s.kind === "job" && s.id === "llm-router:fast" && s.value));
  assert.ok(slots.some((s) => s.kind === "job" && s.id === "smart-router:fast" && s.providerOnly === true));
  const embed = slots.find((s) => s.id === "embed");
  assert.equal(embed.dynamic, true);
  assert.equal(embed.value, null);
  assert.equal(slots.find((s) => s.kind === "job" && s.id === "safety").dynamic, true);
});

test("consumersOfRole is transitive over fallback chains", () => {
  const slots = [
    { kind: "bot", id: "a", field: "models.default", value: "role:everyday" },
    { kind: "bot", id: "b", field: "models.default", value: "role:quick" },
    { kind: "bot", id: "c", field: "models.default", value: "role:expert" },
    { kind: "bot", id: "d", field: "models.default", value: "local-chat/m1" },
  ];
  const got = consumersOfRole(slots, "quick", { bindings: { everyday: { fallback: ["quick"] } } });
  assert.deepEqual(got.map((s) => s.id).sort(), ["a", "b"]);
  assert.deepEqual(consumersOfRole(slots, "expert", {}).map((s) => s.id), ["c"]);
});

test("consumersOfModel: raw equal plus roles bound to the key", () => {
  const slots = [
    { id: "a", value: "local-chat/m1" },
    { id: "b", value: "role:everyday" },
    { id: "c", value: "role:deep" },
  ];
  const got = consumersOfModel(slots, "local-chat/m1", { bindings: { everyday: { model: "local-chat/m1" }, deep: { model: "cloud-a/m9", fallback: [] } } });
  assert.deepEqual(got.map((s) => s.id).sort(), ["a", "b"]);
  // deep falls back to everyday by default, so it can land on the key too
  const wide = consumersOfModel(slots, "local-chat/m1", { bindings: { everyday: { model: "local-chat/m1" }, deep: { model: "cloud-a/m9" } } });
  assert.deepEqual(wide.map((s) => s.id).sort(), ["a", "b", "c"]);
});

test("piConfigRefs and subagent slots from a temp pi dir", async () => {
  const pi = join(dir, "pi");
  mkdirSync(join(pi, "agents"), { recursive: true });
  writeFileSync(join(pi, "settings.json"), JSON.stringify({ subagent: { modelOverrides: { scout: "local-chat/m1" }, rolePins: { scout: false } } }));
  writeFileSync(join(pi, "agents", "planner.md"), "---\nname: planner\nmodel: cloud-a/m9\n---\nbody");
  const refs = piConfigRefs(pi);
  assert.deepEqual(refs["local-chat"], ["subagent:scout"]);
  assert.deepEqual(refs["cloud-a"], ["agent:planner"]);
  assert.ok(Object.values(refs).some((l) => l.includes("code:LOCAL_FALLBACK")));
  assert.ok(Object.values(refs).some((l) => l.includes("code:MULTI_AGENT_CAPABLE")));
  assert.ok(piConfigRefs(join(dir, "missing")) && typeof piConfigRefs(null) === "object");
  const slots = await scanSlots(db, { includeSubagents: true, piAgentDir: pi, tasksDbPaths: [] });
  const scout = slots.find((s) => s.kind === "subagent" && s.id === "scout");
  assert.equal(scout.pinnedInPi, true);
  assert.equal(scout.value, "local-chat/m1");
  assert.equal(slots.find((s) => s.id === "planner").value, "cloud-a/m9");
  assert.equal((await scanSlots(db, { includeSubagents: true, tasksDbPaths: [] })).some((s) => s.kind === "subagent"), false);
});
