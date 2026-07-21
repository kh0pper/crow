/**
 * Item 5 PR2 (spec §D4/§D5): readiness checklist honesty + delete with full
 * cleanup. The two executable honesty gates the spec's adversarial rounds
 * demanded: a zero-provider definition renders NOT-ready (round-1 C1 — never
 * a false green via the resolveModel fallback), and a gmail gateway with an
 * empty allowlist renders NOT-ready (round-2 MAJOR-B — deaf-bot false green).
 * Delete: recreate-after-delete gets a clean slate on the in-scope tables.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-checklist-del-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let renderReadiness, deleteBlastRadius, handleDeleteConfirm, renderDeleteConfirm;
let translations = null;
let _setEngineStatusForTest, _setBotRuntimeStatusForTest, writeSetting;

const origCrowHomeForEngineTests = process.env.CROW_HOME;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  // botIdentityFor (used by the delete cascade + these tests) derives from
  // the instance identity — create one in the scratch data dir first.
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity("");
  ({ renderReadiness } = await import("../servers/gateway/dashboard/panels/bot-builder/checklist.js"));
  ({ deleteBlastRadius, handleDeleteConfirm, renderDeleteConfirm } =
    await import("../servers/gateway/dashboard/panels/bot-builder/delete-bot.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ _setEngineStatusForTest, _setBotRuntimeStatusForTest } =
    await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  ({ writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function resetEnginePins() {
  _setEngineStatusForTest(null);
  _setBotRuntimeStatusForTest(null);
  if (origCrowHomeForEngineTests === undefined) delete process.env.CROW_HOME;
  else process.env.CROW_HOME = origCrowHomeForEngineTests;
}

const addProvider = (id, models) => db.execute({
  sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
  args: [id, "http://127.0.0.1:9999/v1", JSON.stringify(models)],
});
const clearProviders = () => db.execute({ sql: "DELETE FROM providers", args: [] });

function mkBot(defOverrides = {}, enabled = 1) {
  return {
    bot_id: "check-bot",
    display_name: "Check Bot",
    enabled,
    definition: JSON.stringify({
      models: { default: "prov/m1" },
      tools: { pi_builtin: ["read"], crow_mcp: ["crow-tasks/tasks_list"] },
      skills: [],
      system_prompt: "do things",
      gateways: [],
      permission_policy: { bash: "deny", external_send: "draft_only", skill_learning: "off" },
      ...defOverrides,
    }),
  };
}
const defOf = (bot) => JSON.parse(bot.definition);

// ---- checklist honesty ----

test("zero providers: Model row is NOT-ready, shows the configured key, never the fallback", async () => {
  await clearProviders();
  const bot = mkBot({ models: { default: "ghost/model" } });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /&#10007;/, "error icon rendered");
  assert.ok(html.includes("ghost/model"), "shows the CONFIGURED key");
  assert.ok(!html.includes("crow-local/qwen3.6-35b-a3b"), "NEVER the hardcoded fallback (round-1 C1)");
});

test("configured model present in providers: Model row is ready", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const bot = mkBot();
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.ok(html.includes("<code>prov/m1</code>"));
  await clearProviders();
});

test("gmail with empty allowlist: Channel row is NOT-ready (deaf-bot guard, round-2 MAJOR-B)", async () => {
  const bot = mkBot({ gateways: [{ type: "gmail", address: "me+bot@x.com", allowlist: [] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.ok(html.includes("allowlist"), "names the missing field");
  assert.match(html, /setup incomplete/, "incomplete state copy");
});

test("gmail fully configured: Channel row is ready with address + allowed count", async () => {
  const bot = mkBot({ gateways: [{ type: "gmail", address: "me+bot@x.com", allowlist: ["a@x.com", "b@y.com"] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.ok(html.includes("me+bot@x.com"));
  assert.ok(html.includes("2 allowed sender(s)"));
});

test("no gateway: Channel row warns but does not error", async () => {
  const bot = mkBot({ gateways: [] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /none yet/);
});

test("companion without a device: NOT-ready; discord with only a token: ready (fail-open)", async () => {
  const kiosk = mkBot({ gateways: [{ type: "companion" }] });
  assert.match(await renderReadiness(db, kiosk, defOf(kiosk), "en"), /setup incomplete \(device_id\)/);
  const dc = mkBot({ gateways: [{ type: "discord", token: "t", allowlist: [], channel_ids: [] }] });
  const html = await renderReadiness(db, dc, defOf(dc), "en");
  assert.ok(!html.includes("setup incomplete"), "discord token-only must not false-red");
});

test("disabled bot: Status row warns; missing prompt warns; es renders without bare keys", async () => {
  const bot = mkBot({ system_prompt: "" }, 0);
  const en = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(en, /disabled — the bot ignores everything/);
  assert.match(en, /no instructions yet/);
  const es = await renderReadiness(db, bot, defOf(bot), "es");
  assert.ok(!/botbuilder\.[a-zA-Z_]/.test(es), "no bare i18n keys in es");
  assert.match(es, /desactivado/);
});

// ---- "Bot engine" row (C4 Task 9) ----
//
// Reuses the SAME pins the Gateways-tab save gate (Task 7/8) uses
// (engine-gate.js's _setEngineStatusForTest/_setBotRuntimeStatusForTest) so
// these tests are deterministic regardless of what's actually installed on
// the host running the suite (see bot-builder-engine-gate.test.js's header
// comment for why the real engineStatus()'s "global" rung can't be relied
// on here). botRuntimeActive(db) resolution isn't pinned — it reads the
// real feature_flags setting + isMpaHost(), exactly like the save-gate
// tests do, since CROW_DATA_DIR here is a plain scratch dir (isMpaHost()
// false) unless a test explicitly points CROW_HOME at a ".crow-mpa" path.

test("no engine-channel gateway (crow-messages only): 'Bot engine' row absent", async () => {
  const bot = mkBot({ gateways: [{ type: "crow-messages", allow_paired_instances: true }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.ok(!html.includes("Bot engine"), "row must not render when no gateway needs the engine");
});

test("no gateways at all: 'Bot engine' row absent", async () => {
  const bot = mkBot({ gateways: [] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.ok(!html.includes("Bot engine"));
});

test("engine installing: 'Bot engine' row WARNs with 'installing…'", async () => {
  _setEngineStatusForTest({ state: "installing" });
  const bot = mkBot({ gateways: [{ type: "discord", token: "t", allowlist: [], channel_ids: [] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /Bot engine/);
  assert.match(html, /installing…/);
  resetEnginePins();
});

test("engine absent: 'Bot engine' row ERRs with a fix action that opens the Task-8 modal", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const bot = mkBot({ gateways: [{ type: "gmail", address: "a@b.c", allowlist: ["a@b.c"] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /Bot engine/);
  assert.match(html, /not installed on this instance yet/);
  assert.match(html, /onclick="window\.__crowEngineGateOpen\(\)"/, "fix action opens the Task-8 modal hook");
  assert.match(html, />Install bot engine</);
  resetEnginePins();
});

test("engine unhealthy: 'Bot engine' row ERRs with the last error + retry time", async () => {
  _setEngineStatusForTest({ state: "unhealthy", error: "spawn ENOENT", retryAt: "2026-07-21T00:00:00.000Z" });
  const bot = mkBot({ gateways: [{ type: "telegram", token: "t" }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /Bot engine/);
  assert.match(html, /spawn ENOENT/);
  assert.match(html, /2026-07-21T00:00:00\.000Z/);
  resetEnginePins();
});

test("engine ready + gateway-mode runtime flag OFF: 'Bot engine' row is DISARMED (WARN) with the Task-7 one-click enable", async () => {
  _setEngineStatusForTest({ state: "ready", source: "bundle", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "gateway" });
  await writeSetting(db, "feature_flags", JSON.stringify({ bot_runtime: false }), { scope: "local" });
  const bot = mkBot({ gateways: [{ type: "slack", token: "t" }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /Bot engine/);
  assert.match(html, /bot runtime is off on this instance/);
  assert.match(html, /id="bot-runtime-enable-btn"/, "same one-click enable mechanism as Task 8's warn banner");
  assert.match(html, /id="bot-runtime-enable-status"/);
  resetEnginePins();
});

test("engine ready + gateway-mode runtime flag ON: 'Bot engine' row is READY (OK) showing the resolution source", async () => {
  _setEngineStatusForTest({ state: "ready", source: "bundle", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "gateway" });
  await writeSetting(db, "feature_flags", JSON.stringify({ bot_runtime: true }), { scope: "local" });
  const bot = mkBot({ gateways: [{ type: "discord", token: "t", allowlist: [], channel_ids: [] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /Bot engine/);
  assert.match(html, /installed \(source: bundle\)/);
  assert.ok(!html.includes("bot-runtime-enable-btn"), "no disarmed fix action when the runtime is armed");
  assert.ok(!html.includes("managed by system services"), "no external-mode note in gateway mode");
  resetEnginePins();
});

test("engine ready + runtime mode 'external': 'Bot engine' row is READY (OK) with the external-mode note, never disarmed", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "external" });
  await writeSetting(db, "feature_flags", JSON.stringify({ bot_runtime: false }), { scope: "local" });
  const bot = mkBot({ gateways: [{ type: "gmail", address: "a@b.c", allowlist: ["a@b.c"] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "en");
  assert.match(html, /Bot engine/);
  assert.match(html, /installed \(source: env\)/);
  assert.match(html, /managed by system services/, "external note appended for mode==='external'");
  assert.ok(!html.includes("bot-runtime-enable-btn"), "external mode is never disarmed regardless of the flag");
  resetEnginePins();
});

test("es rendering of the engine row has no bare i18n keys", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const bot = mkBot({ gateways: [{ type: "gmail", address: "a@b.c", allowlist: ["a@b.c"] }] });
  const html = await renderReadiness(db, bot, defOf(bot), "es");
  assert.ok(!/botbuilder\.[a-zA-Z_]/.test(html), "no bare i18n keys in es");
  assert.match(html, /Motor de bots/);
  resetEnginePins();
});

// ---- delete ----

function mkRes() {
  const res = { redirected: null, html: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  res.send = (html) => { res.html = html; return res; };
  return res;
}

async function seedBot(botId) {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: [botId, "Doomed", JSON.stringify({ gateways: [{ type: "gmail", address: "a@b.c", allowlist: ["x@y.z"] }] })],
  });
  await db.execute({ sql: "INSERT INTO bot_sessions (bot_id, status, gateway_thread_id) VALUES (?,?,?)", args: [botId, "done", "t1"] });
  await db.execute({ sql: "INSERT INTO bot_message_seen (bot_id, event_id) VALUES (?,?)", args: [botId, "ev1"] });
  await db.execute({
    sql: "INSERT INTO bot_skill_events (bot_id, skill_name, action) VALUES (?,?,?)",
    args: [botId, "sk", "propose"],
  });
  await db.execute({
    sql: "INSERT INTO bot_message_acl (bot_id, sender_pubkey) VALUES (?,?)",
    args: [botId, "ab".repeat(32)],
  });
  await db.execute({
    sql: "INSERT INTO bot_message_invites (bot_id, token) VALUES (?,?)",
    args: [botId, "tok-" + botId],
  });
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  await writeSetting(db, "remote_managed_bots", JSON.stringify([botId, "other-bot"]), { scope: "local" });
  // Local-bot contact (same crow_id delete-bot derives) + a DM message —
  // exercises the disclosed FK cascade (PR #191 review M1/m4).
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  const crowId = admin.botIdentityFor(botId).crowId;
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type, origin) VALUES (?,?,1,?,?,'crow','local-bot')",
    args: [crowId, "Doomed", "cd".repeat(32), "ef".repeat(32)],
  });
  const cid = Number((await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id=?", args: [crowId] })).rows[0].id);
  await db.execute({
    sql: "INSERT INTO messages (contact_id, content, direction) VALUES (?,?,'sent')",
    args: [cid, "hello bot"],
  });
  // Bound device (JSON blob in dashboard_settings) — exercises unbind (m4).
  const { pairDevice, updateDeviceProfiles } = await import("../bundles/meta-glasses/server/device-store.js");
  await pairDevice(db, { id: "dev-" + botId, name: "Test Device", generation: "unknown" });
  await updateDeviceProfiles(db, "dev-" + botId, { bound_bot_id: botId });
  return { crowId, cid };
}

const countIn = async (table, botId) =>
  Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE bot_id=?`, args: [botId] })).rows[0].n);

test("blast radius reports sessions/acl/seen/invites/messages/devices", async () => {
  await seedBot("doomed-bot");
  const br = await deleteBlastRadius(db, "doomed-bot");
  assert.equal(br.sessions, 1);
  assert.equal(br.acl, 1);
  assert.equal(br.seen, 1);
  assert.equal(br.invites, 1);
  assert.equal(br.messages, 1, "DM history count disclosed (review M1)");
  assert.equal(br.boundDevices.length, 1, "bound device reported");
});

test("confirm page renders radius + CSRF + delete_confirm form; unknown bot handled upstream", async () => {
  const bot = (await db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE bot_id='doomed-bot'", args: [] })).rows[0];
  const res = mkRes();
  await renderDeleteConfirm({ headers: {}, query: {} }, res, {
    db, layout: ({ content }) => content, lang: "en", PAGE_CSS: "", bot,
  });
  assert.match(res.html, /delete_confirm/);
  assert.match(res.html, /name="_csrf"/);
  assert.match(res.html, /gmail/);
  assert.match(res.html, /KEPT/);
});

test("delete_confirm removes every in-scope row + the remote_managed_bots entry (clean slate)", async () => {
  const res = mkRes();
  await handleDeleteConfirm({ body: { action: "delete_confirm", bot_id: "doomed-bot" } }, res, { db });
  assert.match(res.redirected, /deleted=doomed-bot/);
  for (const tbl of ["pi_bot_defs", "bot_sessions", "bot_message_seen", "bot_skill_events", "bot_message_acl", "bot_message_invites"]) {
    assert.equal(await countIn(tbl, "doomed-bot"), 0, `${tbl} must be clean`);
  }
  const { readSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const list = JSON.parse(await readSetting(db, "remote_managed_bots"));
  assert.deepEqual(list, ["other-bot"], "only the deleted bot leaves the managed list");
  // Disclosed FK cascade fired: the local-bot contact and its DM history are gone.
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  const crowId = admin.botIdentityFor("doomed-bot").crowId;
  const contacts = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM contacts WHERE crow_id=?", args: [crowId] })).rows[0].n;
  assert.equal(Number(contacts), 0, "local-bot contact deleted");
  const msgs = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id=m.contact_id)", args: [] })).rows[0].n;
  assert.equal(Number(msgs), 0, "no orphan messages — cascade removed the DM history");
  // Device unbound (best-effort step actually ran).
  const { listDevices } = await import("../bundles/meta-glasses/server/device-store.js");
  const dev = (await listDevices(db)).find((d) => d.id === "dev-doomed-bot");
  assert.ok(dev, "device still paired");
  assert.ok(!dev.bound_bot_id, "device unbound from the deleted bot");
  // Recreate same id: fresh insert works and sees zero stale rows.
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('doomed-bot','Reborn','{}',1)",
    args: [],
  });
  assert.equal(await countIn("bot_message_seen", "doomed-bot"), 0, "recreated bot must not inherit dedup rows");
});

test("delete_confirm on an unknown bot: error redirect, nothing thrown", async () => {
  const res = mkRes();
  await handleDeleteConfirm({ body: { action: "delete_confirm", bot_id: "never-was" } }, res, { db });
  assert.match(res.redirected, /error=unknown_bot/);
});

// ---- i18n parity for the PR2 keys ----

test("every PR2 key ships en+es with es differing from en", () => {
  const keys = Object.keys(translations).filter((k) =>
    k.startsWith("botbuilder.check") || k.startsWith("botbuilder.del") ||
    ["botbuilder.reviewAdvancedSummary", "botbuilder.deleteBotLink"].includes(k));
  assert.ok(keys.length >= 35, "expected the PR2 key set, got " + keys.length);
  for (const k of keys) {
    const e = translations[k];
    assert.ok(e.en && e.es, `${k} must have en+es`);
    assert.notEqual(e.en, e.es, `${k} es must differ from en`);
  }
});
