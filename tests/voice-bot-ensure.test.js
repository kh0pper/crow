/**
 * ensureVoiceBot: the reserved Crow voice bot row is created once at boot,
 * never rewritten, and records (without editing anything) what the old voice
 * bindings were: the dashboard bot, every device's bound bot, the carried
 * fast voice model and the carried tool selections.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "voice-bot-ensure-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

const { ensureVoiceBot, CROW_VOICE_BOT_ID, VOICE_DENY_TOOLS, voiceBotDefinition } = await import("../servers/shared/voice-bot.js");
const { listDevices } = await import("../servers/shared/device-store.js");
const { createDbClient } = await import("../servers/db.js");

const FAST = "crow-voice/qwen3.5-4b";
const PRESET = voiceBotDefinition({ preset: "fast_local", fastKey: FAST }).tools.crow_mcp;
const raw = () => new Database(DB_FILE);

async function readSetting(db, key) {
  const r = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
  return r.rows[0]?.value ?? null;
}

function seedBot(id, def, enabled = 1) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,NULL)")
    .run(id, id, typeof def === "string" ? def : JSON.stringify(def), enabled);
  c.close();
}
function setSetting(key, value) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES (?, ?)").run(key, value);
  c.close();
}
const setting = (key) => { const c = raw(); const r = c.prepare("SELECT value FROM dashboard_settings WHERE key=?").get(key); c.close(); return r?.value ?? null; };
const voiceRow = () => { const c = raw(); const r = c.prepare("SELECT * FROM pi_bot_defs WHERE bot_id=?").get(CROW_VOICE_BOT_ID); c.close(); return r; };
const voiceDef = () => JSON.parse(voiceRow().definition);
const allDefs = () => { const c = raw(); const r = c.prepare("SELECT bot_id, definition FROM pi_bot_defs WHERE bot_id <> ? ORDER BY bot_id").all(CROW_VOICE_BOT_ID); c.close(); return r; };

async function run(extra = {}) {
  const db = createDbClient();
  try {
    return await ensureVoiceBot(db, { fastKey: FAST, readSetting, listDevices, log: () => {}, ...extra });
  } finally { db.close?.(); }
}

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
});

beforeEach(() => {
  const c = raw();
  c.prepare("DELETE FROM pi_bot_defs").run();
  c.prepare("DELETE FROM providers").run();
  c.prepare("DELETE FROM dashboard_settings WHERE key IN ('kiosk_dashboard_bot_id','meta_glasses_devices')").run();
  c.close();
});

test("VOICE_DENY_TOOLS is the fixed list", () => {
  assert.deepEqual(VOICE_DENY_TOOLS, ["crow_delegate", "crow_job_status", "crow_schedule_bot", "crow_list_bot_schedules", "crow_delete_bot_schedule", "crow_discover"]);
});

test("creates the voice bot once and never rewrites it", async () => {
  assert.deepEqual(await run(), { created: true });
  const row = voiceRow();
  assert.equal(row.display_name, "Crow");
  assert.equal(row.enabled, 1);
  assert.equal(row.project_id, null);
  const def = JSON.parse(row.definition);
  assert.equal(def.kind, "voice");
  def.system_prompt = "mine";
  const c = raw(); c.prepare("UPDATE pi_bot_defs SET definition=? WHERE bot_id=?").run(JSON.stringify(def), CROW_VOICE_BOT_ID); c.close();
  assert.deepEqual(await run(), { created: false });
  assert.equal(voiceDef().system_prompt, "mine");
});

test("a disabled voice row is left alone", async () => {
  seedBot(CROW_VOICE_BOT_ID, { kind: "voice", system_prompt: "off" }, 0);
  assert.deepEqual(await run(), { created: false });
  assert.equal(voiceRow().enabled, 0);
});

test("migration records old bindings and touches nothing else", async () => {
  setSetting("kiosk_dashboard_bot_id", "helper");
  seedBot("helper", { fast_voice_model: "local-x/small", tools: { crow_mcp: [] } });
  seedBot("writer", { tools: { crow_mcp: [] } });
  const devices = JSON.stringify([
    { id: "kiosk-1", device_kind: "kiosk", bound_bot_id: "helper", last_seen: "2026-10-01T00:00:00.000Z" },
    { id: "g-1", device_kind: "glasses", bound_bot_id: "writer", last_seen: null },
    { id: "g-2", device_kind: "glasses", bound_bot_id: null },
  ]);
  setSetting("meta_glasses_devices", devices);
  const defsBefore = allDefs();
  assert.deepEqual(await run(), { created: true });
  const def = voiceDef();
  assert.equal(def.migrated_from.dashboard_bot, "helper");
  assert.equal(def.migrated_from.dashboard_setting, "helper");
  assert.deepEqual(def.migrated_from.devices, { "kiosk-1": "helper", "g-1": "writer" });
  assert.ok(!Number.isNaN(Date.parse(def.migrated_from.at)));
  assert.equal(setting("meta_glasses_devices"), devices);
  assert.equal(setting("kiosk_dashboard_bot_id"), "helper");
  assert.deepEqual(allDefs(), defsBefore);
});

test("Automatic: carries from the first enabled bot", async () => {
  seedBot("beta", {});
  seedBot("alpha", { fast_voice_model: "local-x/small" });
  const c = raw(); c.prepare("INSERT INTO providers (id, base_url, models) VALUES ('local-x','http://localhost:1/v1',?)").run(JSON.stringify([{ id: "small" }])); c.close();
  assert.deepEqual(await run(), { created: true });
  const def = voiceDef();
  assert.equal(def.migrated_from.dashboard_bot, "alpha");
  assert.equal(def.migrated_from.dashboard_setting, null);
  assert.equal(def.fast_voice_model, "local-x/small");
});

test("Automatic skips a disabled setting target and voice bots", async () => {
  setSetting("kiosk_dashboard_bot_id", "helper");
  seedBot("helper", {}, 0);
  seedBot("a.voice", { kind: "voice" });
  seedBot("beta", {});
  await run();
  assert.equal(voiceDef().migrated_from.dashboard_bot, "beta");
  assert.equal(voiceDef().migrated_from.dashboard_setting, "helper");
});

test("no enabled bot: the most recently seen device's bot is the effective one", async () => {
  seedBot("writer", { fast_voice_model: "local-x/small" }, 0);
  seedBot("helper", {}, 0);
  setSetting("meta_glasses_devices", JSON.stringify([
    { id: "k-1", device_kind: "kiosk", bound_bot_id: "helper", last_seen: "2026-01-01T00:00:00.000Z" },
    { id: "g-1", device_kind: "glasses", bound_bot_id: "writer", last_seen: "2026-09-01T00:00:00.000Z" },
  ]));
  const c = raw(); c.prepare("INSERT INTO providers (id, base_url, models) VALUES ('local-x','http://localhost:1/v1',?)").run(JSON.stringify(["small"])); c.close();
  await run();
  assert.equal(voiceDef().migrated_from.dashboard_bot, "writer");
  assert.equal(voiceDef().fast_voice_model, "local-x/small");
});

test("old voice selections are carried, minus denied tools", async () => {
  seedBot("alpha", { tools: { crow_mcp: ["crow-memory/crow_store_memory", "gmail/gmail_search", "crow-tools/crow_delegate"] } });
  seedBot("writer", { tools: { crow_mcp: ["brave-search/brave_web_search", "meta-glasses/crow_glasses_add_to_note", "gmail/gmail_search", "x/crow_discover"] } });
  setSetting("meta_glasses_devices", JSON.stringify([{ id: "g-1", device_kind: "glasses", bound_bot_id: "writer" }]));
  await run();
  const def = voiceDef();
  const tools = def.tools.crow_mcp;
  assert.deepEqual(tools.slice(0, PRESET.length), PRESET);
  assert.deepEqual(tools.slice(PRESET.length), ["gmail/gmail_search", "brave-search/brave_web_search"]);
  assert.deepEqual(def.migrated_from.tools, ["gmail/gmail_search", "brave-search/brave_web_search"]);
  assert.ok(!tools.some((t) => t.includes("crow_glasses_") || t.endsWith("/crow_delegate") || t.endsWith("/crow_discover")));
});

test("fast model carried only when it is a real provider model", async () => {
  seedBot("alpha", { fast_voice_model: "local-x/small" });
  await run();
  assert.equal(voiceDef().fast_voice_model, FAST);

  const c = raw();
  c.prepare("DELETE FROM pi_bot_defs WHERE bot_id=?").run(CROW_VOICE_BOT_ID);
  c.prepare("INSERT INTO providers (id, base_url, models) VALUES ('local-x','http://localhost:1/v1',?)").run(JSON.stringify([{ id: "small" }]));
  c.close();
  await run();
  assert.equal(voiceDef().fast_voice_model, "local-x/small");
});

test("a model id containing a slash splits on the first slash only", async () => {
  seedBot("alpha", { fast_voice_model: "local-x/org/small" });
  const c = raw(); c.prepare("INSERT INTO providers (id, base_url, models) VALUES ('local-x','http://localhost:1/v1',?)").run(JSON.stringify([{ id: "org/small" }])); c.close();
  await run();
  assert.equal(voiceDef().fast_voice_model, "local-x/org/small");
});

test("two gateways at once leave one row", async () => {
  const a = createDbClient(), b = createDbClient();
  try {
    const deps = { fastKey: FAST, readSetting, listDevices, log: () => {} };
    const results = await Promise.all([ensureVoiceBot(a, deps), ensureVoiceBot(b, deps)]);
    const c = raw(); const { n } = c.prepare("SELECT COUNT(*) AS n FROM pi_bot_defs WHERE bot_id=?").get(CROW_VOICE_BOT_ID); c.close();
    assert.equal(n, 1);
    assert.equal(results.filter((r) => r.created === true).length, 1);
  } finally { a.close?.(); b.close?.(); }
});

test("a corrupt row is left alone", async () => {
  seedBot(CROW_VOICE_BOT_ID, "{");
  assert.deepEqual(await run(), { created: false, corrupt: true });
  assert.equal(voiceRow().definition, "{");
});

test("a missing fast model throws before any DB access", async () => {
  const db = { execute: () => { throw new Error("db touched"); } };
  for (const fastKey of [undefined, null, "", 42]) {
    await assert.rejects(
      ensureVoiceBot(db, { fastKey, readSetting, listDevices, log: () => {} }),
      (e) => e.message === "fast_model_required",
    );
  }
});

test("boot hook: skipped on a --no-auth gateway, creates the row otherwise, closes its client", async () => {
  const { ensureVoiceBotAtBoot } = await import("../servers/gateway/boot/post-listen.js");
  let opened = 0, closed = 0;
  const factory = () => { opened++; const db = createDbClient(); const close = db.close?.bind(db); db.close = () => { closed++; close?.(); }; return db; };
  assert.deepEqual(await ensureVoiceBotAtBoot({ noAuth: true, dbFactory: factory }), { skipped: true });
  assert.equal(opened, 0);
  assert.equal(voiceRow(), undefined);
  const res = await ensureVoiceBotAtBoot({ noAuth: false, dbFactory: factory });
  assert.equal(res.created, true);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(voiceRow().display_name, "Crow");
});

test("boot hook: a failure is caught and logged, never thrown", async () => {
  const { ensureVoiceBotAtBoot } = await import("../servers/gateway/boot/post-listen.js");
  const res = await ensureVoiceBotAtBoot({ noAuth: false, dbFactory: () => { throw new Error("no db"); } });
  assert.equal(res.created, false);
  assert.equal(res.error, "no db");
});
