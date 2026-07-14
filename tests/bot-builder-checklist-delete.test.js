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

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ renderReadiness } = await import("../servers/gateway/dashboard/panels/bot-builder/checklist.js"));
  ({ deleteBlastRadius, handleDeleteConfirm, renderDeleteConfirm } =
    await import("../servers/gateway/dashboard/panels/bot-builder/delete-bot.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

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
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  await writeSetting(db, "remote_managed_bots", JSON.stringify([botId, "other-bot"]), { scope: "local" });
}

const countIn = async (table, botId) =>
  Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE bot_id=?`, args: [botId] })).rows[0].n);

test("blast radius reports sessions/acl/seen counts", async () => {
  await seedBot("doomed-bot");
  const br = await deleteBlastRadius(db, "doomed-bot");
  assert.equal(br.sessions, 1);
  assert.equal(br.acl, 1);
  assert.equal(br.seen, 1);
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
