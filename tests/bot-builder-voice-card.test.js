/**
 * Crow's card and the Crow voice editor in Bot Builder (PR 1, Task 1.7).
 *
 * The reserved voice bot (crow.voice) gets its own card, first in the list,
 * with no delete / board / give / use-for-voice items; "Customise" opens its
 * own editor (?bot=crow.voice, whatever the tab), whose saves are the only
 * Bot Builder writes the voice bot accepts: voice_bot_save and
 * voice_bot_preset. Both are compare-and-swaps on the rendered row (rev).
 *
 * One scratch, init-db'd crow.db (CROW_DATA_DIR in a tmp dir, never the
 * operator's ~/.crow).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-voice-card-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let db, renderBotList, renderVoiceBotEditor, handleBotBuilderPost, translations, rowRev, panel, voiceRev;
let voiceBotDefinition, DEFAULT_PERSONA, writeSetting;
const MIGRATED = { at: "2026-10-01T00:00:00.000Z", dashboard_bot: "writer", dashboard_setting: null, devices: {}, tools: ["blog/crow_list_posts"], skipped_tools: [] };
let SEED_DEF = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js"));
  ({ renderVoiceBotEditor, voiceRev } = await import("../servers/gateway/dashboard/panels/bot-builder/voice-bot-editor.js"));
  ({ handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ rowRev } = await import("../servers/gateway/dashboard/panels/bot-builder/def-adapter.js"));
  ({ default: panel } = await import("../servers/gateway/dashboard/panels/bot-builder.js"));
  ({ voiceBotDefinition, DEFAULT_PERSONA } = await import("../servers/shared/voice-bot.js"));
  ({ writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
  await db.execute({ sql: "DELETE FROM providers", args: [] });
  const prov = (id, host, models) => db.execute({ sql: "INSERT INTO providers (id, base_url, host, models, disabled) VALUES (?,?,?,?,0)",
    args: [id, "http://127.0.0.1:9/v1", host, JSON.stringify(models)] });
  await prov("crow-voice", "local", [{ id: "qwen3.5-4b", name: "Qwen3.5 4B (local, voice)" }]);
  await prov("crow-chat", "local", [{ id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B (local, chat)" }]);
  await prov("cloud-x", "cloud", [{ id: "model-y", name: "Model Y" }]);
  await writeSetting(db, "tts_profiles", JSON.stringify([{ id: "t1", name: "Kokoro", provider: "kokoro" }, { id: "t2", name: "Piper", provider: "piper" }]));
  await writeSetting(db, "stt_profiles", JSON.stringify([{ id: "s1", name: "Whisper", provider: "fasterwhisper" }]));
  SEED_DEF = voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b", migratedFrom: MIGRATED });
  SEED_DEF.tools.crow_mcp.push("blog/crow_list_posts");   // a tool the migration carried
  SEED_DEF.permission_policy.confirm.push("crow_list_posts");
  const ins = (id, name, def) => db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)", args: [id, name, JSON.stringify(def)] });
  await ins("alpha", "Alpha", { models: { default: "crow-chat/qwen3.6-35b-a3b" }, gateways: [{ type: "perch" }] });
  await ins("crow.voice", "Crow", SEED_DEF);
  await ins("writer", "Writer", { models: { default: "crow-chat/qwen3.6-35b-a3b" }, gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } });
});
after(() => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const T = (k, lang = "en") => translations[k][lang];
const voiceRow = async () => (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition, project_id FROM pi_bot_defs WHERE bot_id='crow.voice'", args: [] })).rows[0];
const voiceDef = async () => JSON.parse((await voiceRow()).definition);
const otherRows = async () => (await db.execute({ sql: "SELECT bot_id, display_name, enabled, definition FROM pi_bot_defs WHERE bot_id != 'crow.voice' ORDER BY bot_id", args: [] })).rows.map((r) => ({ ...r }));
const reset = async (def = SEED_DEF, name = "Crow") => db.execute({ sql: "UPDATE pi_bot_defs SET definition=?, display_name=?, enabled=1 WHERE bot_id='crow.voice'", args: [JSON.stringify(def), name] });

async function list(lang = "en", { kioskAvailable = false } = {}) {
  const res = { html: null, send(h) { this.html = h; return this; }, redirectAfterPost() {} };
  const headers = lang === "es" ? { cookie: "crow_lang=es" } : {};
  await renderBotList(res, { db, layout: ({ content }) => content, notice: "", PAGE_CSS: "", req: { headers, csrfToken: "tok" }, kioskAvailable });
  return res.html;
}
async function editor({ lang = "en", notice = "", kioskAvailable = false } = {}) {
  const res = { html: null, send(h) { this.html = h; return this; } };
  await renderVoiceBotEditor({ headers: lang === "es" ? { cookie: "crow_lang=es" } : {}, csrfToken: "tok", query: { bot: "crow.voice" } }, res,
    { db, layout: ({ content }) => content, lang, PAGE_CSS: "", notice, kioskAvailable });
  return res.html;
}
async function post(body, dbOver = db) {
  const res = { redirected: null, headersSent: false, redirectAfterPost(u) { this.redirected = u; this.headersSent = true; } };
  await handleBotBuilderPost({ body, headers: {} }, res, { db: dbOver });
  return res.redirected;
}
const qOf = (url) => new URL(url, "http://x").searchParams;

// ── the card ────────────────────────────────────────────────────────────────

test("the voice card renders first and has no delete", async () => {
  for (const kioskAvailable of [false, true]) {
    const html = await list("en", { kioskAvailable });
    const ids = [...html.matchAll(/data-bot="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(ids[0], "crow.voice", `the voice card comes before any other card (${ids.join(",")})`);
    assert.equal(ids.filter((x) => x === "crow.voice").length, 1, "one card for Crow, no ordinary card for its row");
    assert.ok(ids.includes("alpha") && ids.includes("writer"));
    assert.ok(!html.includes("crow.voice&confirm_delete=1") && !html.includes("crow.voice&amp;confirm_delete=1"), "no delete link for Crow");
    assert.ok(!html.includes("btb-voice-use"), "no Use for voice… anywhere");
    assert.ok(!html.includes('class="btb-voice"'), "no Answers voice on line anywhere");
    assert.ok(!html.includes('id="btb-vu"'), "no Use for voice dialog");
  }
});

test("the voice card: avatar, name, a Voice chip, the model chip, Customise to its editor; no ⋯ menu", async () => {
  const html = await list("en", { kioskAvailable: true });
  const a = html.indexOf('data-bot="crow.voice"');
  const start = html.lastIndexOf("<div", a);
  const end = html.indexOf('class="btb-botcard"', a);
  const card = html.slice(start, html.lastIndexOf("<", end));
  assert.match(card, /<span class="btb-av btb-av-l[^"]*" aria-hidden="true">C<\/span>/);
  assert.ok(card.includes(">Crow<"), "the name");
  assert.ok(card.includes(T("botbuilder.voiceChip")), "the Voice chip");
  assert.match(card, /<span class="btb-mchip" title="crow-voice\/qwen3\.5-4b">Qwen3\.5 4B<\/span>/, "the friendly model, the key on hover");
  assert.match(card, /<p class="btb-abil" data-abil-bot="crow\.voice" hidden><\/p>/, "the abilities line (filled from the Kiosk listing)");
  assert.match(card, new RegExp(`href="/dashboard/bot-builder\\?bot=crow\\.voice">${T("botbuilder.voiceCustomise")}</a>`));
  for (const bit of ["btb-more", "btb-menu", "bot-board?bot=crow.voice", "btb-give-task", "board_on"]) assert.ok(!card.includes(bit), `no ${bit} on Crow's card`);
  const noKiosk = await list("en");
  assert.ok(!noKiosk.includes("btb-abil"), "no Kiosk: no abilities line (nothing could fill it)");
});

test("the abilities line on Crow's card is painted from the Kiosk listing's voice object (one read, no writes)", async () => {
  const { parseHTML } = await import("linkedom");
  const vm = await import("node:vm");
  const html = await list("en", { kioskAvailable: true });
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  const listing = { devices: [], bots: [], pending: [], stt_profiles: [], tts_profiles: [],
    voice: { bot_id: "crow.voice", name: "Crow", fit: "full", fit_memory: "full", abilities: { items: [{ id: "lists", quick: true }], none: false }, abilities_memory: null } };
  const fetch = async (url, opts = {}) => { calls.push([opts.method || "GET", url]); return { ok: true, redirected: false, headers: { get: () => "application/json" }, json: async () => listing }; };
  const ctx = vm.createContext({ document, window: {}, fetch, JSON, String, Array, Object, Promise, encodeURIComponent });
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) if (m[1].includes("__btbVoiceAbil")) vm.runInContext(m[1], ctx);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["GET", "/api/kiosk/admin/displays"]]);
  const line = document.querySelector('.btb-abil[data-abil-bot="crow.voice"]');
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, T("botbuilder.abilBy").replace("{list}", T("botbuilder.abilLists")));
});

// ── the editor ──────────────────────────────────────────────────────────────

test("?bot=crow.voice renders the voice editor whatever tab says", async () => {
  for (const tab of [undefined, "basics", "abilities", "advanced", "nope"]) {
    let html = "";
    await panel.handler({ method: "GET", query: { bot: "crow.voice", ...(tab ? { tab } : {}) }, headers: {}, csrfToken: "tok" },
      { send: (h) => { html = h; }, redirectAfterPost() {} }, { db, lang: "en", layout: ({ content }) => content });
    assert.ok(html.includes('name="action" value="voice_bot_save"'), `tab=${tab}: the voice editor`);
    assert.ok(!html.includes('value="save_basics"') && !html.includes('class="btb-tabs"'), `tab=${tab}: not the generic editor`);
  }
});

test("the editor: every section, the rev of the rendered row, and the stored values", async () => {
  await reset();
  const html = await editor({ kioskAvailable: true });
  for (const k of ["voiceOnTitle", "voicePresetTitle", "voicePresetFast", "voicePresetCloud", "voicePresetReset", "voiceModelTitle", "voicePersonaTitle", "voiceTtsTitle", "voiceSttTitle", "voiceMemoryTitle", "voiceAbilTitle"]) {
    assert.ok(html.includes(T("botbuilder." + k)), `section ${k}`);
  }
  const rev = voiceRev(await voiceRow());
  assert.equal((html.match(new RegExp(`name="rev" value="${rev}"`, "g")) || []).length, 2, "the save and the preset forms both carry the row's rev");
  assert.match(html, /<option value="crow-voice\/qwen3\.5-4b" selected>/, "the stored model is selected");
  assert.ok(html.includes(">" + DEFAULT_PERSONA.slice(0, 40)), "the persona");
  assert.match(html, /name="enabled"[^>]*checked/);
  assert.match(html, /name="memory_tools"[^>]*checked/, "the three memory tools are selected");
  assert.match(html, /<option value="t2">Piper<\/option>/);
  assert.match(html, /name="escalation"/);
  assert.match(html, /<p class="btb-abil" data-abil-bot="crow\.voice" hidden><\/p>/);
  assert.ok(!html.includes("crow.voice&amp;confirm_delete") && !html.includes("confirm_delete=1"), "no delete in the editor");
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) { assert.ok(!m[1].includes("`")); assert.ok(!m[1].includes("${")); }
});

test("the cloud warning agrees with the turn: a DNS-named row is not proven local until marked (roles phase 2)", async () => {
  const { markLocal } = await import("../servers/shared/provider-local-marks.js");
  const { invalidateRoleContext } = await import("../servers/shared/model-roles-store.js");
  await db.execute({ sql: "INSERT INTO providers (id, base_url, host, models, disabled) VALUES (?,?,?,?,0)",
    args: ["box-x", "http://box.example.internal:8011/v1", "local", JSON.stringify([{ id: "m1", name: "M1" }])] });
  invalidateRoleContext();
  try {
    await reset({ ...SEED_DEF, fast_voice_model: "box-x/m1" });
    const before = await editor();
    assert.ok(before.includes(T("botbuilder.voiceCloudSlower")), "host 'local' on a DNS name still warns");
    assert.ok(before.includes(T("botbuilder.voiceCloudLeaves").replace("{provider}", "box-x")));
    assert.deepEqual(await markLocal(db, "box-x", { actor: "test" }), { ok: true });
    assert.ok(!(await editor()).includes(T("botbuilder.voiceCloudSlower")), "marked: no warning");
  } finally {
    await db.execute({ sql: "DELETE FROM providers WHERE id = 'box-x'", args: [] });
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = 'provider_local_marks'", args: [] });
    invalidateRoleContext();
    await reset();
  }
});

test("cloud warnings show only for a cloud model", async () => {
  await reset();
  const local = await editor();
  assert.ok(!local.includes(T("botbuilder.voiceCloudSlower")));
  assert.ok(!local.includes("what you say to Crow is sent to"));
  await reset({ ...SEED_DEF, preset: "cloud", fast_voice_model: "cloud-x/model-y" });
  const cloud = await editor();
  assert.ok(cloud.includes(T("botbuilder.voiceCloudSlower")));
  assert.ok(cloud.includes(T("botbuilder.voiceCloudLeaves").replace("{provider}", "cloud-x")), "the provider is named");
  const es = await editor({ lang: "es" });
  assert.ok(es.includes(T("botbuilder.voiceCloudLeaves", "es").replace("{provider}", "cloud-x")));
  await reset();
});

// ── the saves ───────────────────────────────────────────────────────────────

const saveBody = async (over = {}) => ({
  action: "voice_bot_save", bot_id: "crow.voice", rev: voiceRev(await voiceRow()),
  display_name: "Crow", system_prompt: "mine", fast_voice_model: "crow-voice/qwen3.5-4b", escalation: "default",
  tts_profile_id: "t2", stt_profile_id: "", memory_tools: "on", enabled: "on", handoff_enabled: "on", ...over,
});

test("save: writes only Crow's row, keeps migration, routine and handoff; memory tools on/off", async () => {
  await reset();
  const others = await otherRows();
  const policyBefore = (await voiceDef()).permission_policy;
  const url = await post(await saveBody({ display_name: "Crow Two", memory_tools: "off" }));
  assert.equal(qOf(url).get("saved"), "1", url);
  assert.equal(qOf(url).get("bot"), "crow.voice");
  const row = await voiceRow();
  const d = JSON.parse(row.definition);
  assert.equal(row.display_name, "Crow Two");
  assert.equal(d.system_prompt, "mine");
  assert.equal(d.voice.tts_profile_id, "t2");
  assert.equal(d.voice.stt_profile_id, null);
  assert.deepEqual(d.migrated_from, MIGRATED);
  assert.deepEqual(d.routine, SEED_DEF.routine);
  assert.deepEqual(d.handoff, SEED_DEF.handoff);
  assert.ok(!d.tools.crow_mcp.some((x) => x.startsWith("crow-memory/")), "memory tools off removes the three");
  assert.ok(d.tools.crow_mcp.includes("blog/crow_list_posts"), "a carried tool stays");
  assert.deepEqual(await otherRows(), others, "no other bot is touched");
  assert.deepEqual(d.permission_policy, policyBefore, "the permission policy is kept as stored");
  const on = await post(await saveBody({ memory_tools: "on", enabled: "off" }));
  assert.equal(qOf(on).get("saved"), "1");
  const d2 = await voiceDef();
  for (const t of ["crow-memory/crow_store_memory", "crow-memory/crow_search_memories", "crow-memory/crow_recall_by_context"]) assert.ok(d2.tools.crow_mcp.includes(t), t);
  assert.equal(Number((await voiceRow()).enabled), 0, "the switch turns Crow's voice off");
  await reset();
});

test("save refuses an unknown model and a stale page", async () => {
  await reset();
  const before = await voiceRow();
  const unknown = await post(await saveBody({ fast_voice_model: "nope/none" }));
  assert.ok(qOf(unknown).get("error"), unknown);
  assert.equal(qOf(unknown).get("bot"), "crow.voice");
  const stale = await post(await saveBody({ rev: "0000000000000000" }));
  assert.equal(qOf(stale).get("error"), "stale", stale);
  const noRev = await post(await saveBody({ rev: "" }));
  assert.equal(qOf(noRev).get("error"), "stale", "a post without rev is stale too");
  for (const bad of [{ display_name: "" }, { display_name: "x".repeat(41) }, { system_prompt: "x".repeat(4001) }, { tts_profile_id: "gone" }, { escalation: "sometimes" }]) {
    assert.ok(qOf(await post(await saveBody(bad))).get("error"), JSON.stringify(bad).slice(0, 60));
  }
  const after = await voiceRow();
  assert.equal(after.definition, before.definition, "the def is unchanged");
  assert.equal(after.display_name, before.display_name);
  assert.equal(Number(after.enabled), Number(before.enabled));
});

test("a preset switch keeps persona, profiles and migration", async () => {
  const def = JSON.parse(JSON.stringify(SEED_DEF));
  def.system_prompt = "mine";
  def.voice.tts_profile_id = "t2";
  await reset(def, "Crow Two");
  const others = await otherRows();
  const policyBefore = (await voiceDef()).permission_policy;
  const url = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "cloud", cloud_model: "cloud-x/model-y" });
  assert.equal(qOf(url).get("saved"), "1", url);
  const d = await voiceDef();
  assert.equal(d.preset, "cloud");
  assert.equal(d.fast_voice_model, "cloud-x/model-y");
  assert.equal(d.voice.escalation, "off", "the cloud preset's escalation");
  assert.equal(d.system_prompt, "mine");
  assert.equal(d.voice.tts_profile_id, "t2");
  assert.deepEqual(d.migrated_from, MIGRATED);
  assert.deepEqual(d.routine, SEED_DEF.routine);
  assert.deepEqual(d.handoff, SEED_DEF.handoff);
  assert.ok(d.tools.crow_mcp.includes("blog/crow_list_posts"), "the carried tool stays");
  assert.ok(d.permission_policy.confirm.includes("crow_list_posts"), "and its confirm entry");
  assert.deepEqual(d.permission_policy, policyBefore, "the permission policy is kept as stored");
  assert.deepEqual(await otherRows(), others, "no other bot is touched");
  assert.equal((await voiceRow()).display_name, "Crow Two", "the name stays");
  // back to fast and local: the quick local model, escalation on, the carried tool still there
  const back = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "fast_local" });
  assert.equal(qOf(back).get("saved"), "1", back);
  const d2 = await voiceDef();
  assert.equal(d2.preset, "fast_local");
  assert.equal(d2.fast_voice_model, "crow-voice/qwen3.5-4b");
  assert.equal(d2.voice.escalation, "default");
  assert.ok(d2.tools.crow_mcp.includes("blog/crow_list_posts"));
  assert.equal(d2.system_prompt, "mine");
  await reset();
});

test("a stale tab cannot switch Crow's voice on or off: the rev covers enabled", async () => {
  await reset();
  const first = await editor();
  const second = await editor();
  const revOf = (html) => html.match(/name="rev" value="([^"]+)"/)[1];
  assert.equal(revOf(first), revOf(second));
  const off = await post(await saveBody({ rev: revOf(first), enabled: "off" }));
  assert.equal(qOf(off).get("saved"), "1", off);
  const afterOff = await voiceRow();
  assert.equal(Number(afterOff.enabled), 0);
  const stale = await post(await saveBody({ rev: revOf(second), enabled: "on" }));
  assert.equal(qOf(stale).get("error"), "stale", "the second, now stale page is refused");
  const now = await voiceRow();
  assert.equal(Number(now.enabled), 0, "still off");
  assert.equal(now.definition, afterOff.definition);
  await reset();
});

test("compare-and-swap race: the rev matches but the row changes underneath → error=stale, nothing written", async () => {
  for (const action of ["voice_bot_save", "voice_bot_preset"]) {
    await reset();
    const raced = JSON.parse(JSON.stringify(SEED_DEF));
    raced.system_prompt = "changed underneath";
    const racing = { execute: async (q) => {
      if (/^\s*UPDATE pi_bot_defs/i.test(String(q.sql || q))) await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='crow.voice'", args: [JSON.stringify(raced)] });
      return db.execute(q);
    } };
    const body = action === "voice_bot_save" ? await saveBody({ system_prompt: "mine" })
      : { action, bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "fast_local", reset: "1" };
    const url = await post(body, racing);
    assert.equal(qOf(url).get("error"), "stale", `${action}: ${url}`);
    assert.equal((await voiceDef()).system_prompt, "changed underneath", `${action}: the racing write stands, ours wrote nothing`);
  }
  await reset();
});

test("a preset switch keeps Memory tools off; Reset to preset turns them back on", async () => {
  await reset();
  assert.equal(qOf(await post(await saveBody({ memory_tools: "off" }))).get("saved"), "1");
  const mem = (d) => d.tools.crow_mcp.filter((x) => x.startsWith("crow-memory/"));
  assert.deepEqual(mem(await voiceDef()), []);
  const sw = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "cloud", cloud_model: "cloud-x/model-y" });
  assert.equal(qOf(sw).get("saved"), "1", sw);
  assert.deepEqual(mem(await voiceDef()), [], "still off after a preset switch");
  assert.ok((await voiceDef()).tools.crow_mcp.includes("funkwhale/fw_play"), "the other preset entries are rebuilt");
  const rs = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "fast_local", reset: "1" });
  assert.equal(qOf(rs).get("saved"), "1", rs);
  assert.equal(mem(await voiceDef()).length, 3, "Reset to preset re-applies the preset list");
  await reset();
});

test("reset to preset re-applies the persona and the preset tool list, keeps migration, profiles, routine and handoff", async () => {
  const def = JSON.parse(JSON.stringify(SEED_DEF));
  def.system_prompt = "mine";
  def.voice.tts_profile_id = "t2";
  await reset(def);
  const url = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "fast_local", reset: "1" });
  assert.equal(qOf(url).get("saved"), "1", url);
  const d = await voiceDef();
  const base = voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" });
  assert.equal(d.system_prompt, DEFAULT_PERSONA);
  assert.deepEqual(d.tools.crow_mcp, base.tools.crow_mcp);
  assert.deepEqual(d.migrated_from, MIGRATED);
  assert.equal(d.voice.tts_profile_id, "t2");
  assert.deepEqual(d.routine, SEED_DEF.routine);
  await reset();
});

test("preset refuses a cloud preset without a known model, an unknown preset and a stale page; nothing is written", async () => {
  await reset();
  const before = await voiceRow();
  const rev = voiceRev(before);
  for (const body of [{ preset: "cloud", rev }, { preset: "cloud", cloud_model: "nope/none", rev }, { preset: "turbo", rev }, { preset: "fast_local", rev: "0000000000000000" }]) {
    const url = await post({ action: "voice_bot_preset", bot_id: "crow.voice", ...body });
    assert.ok(qOf(url).get("error"), JSON.stringify(body));
  }
  assert.equal(qOf(await post({ action: "voice_bot_preset", bot_id: "crow.voice", preset: "fast_local", rev: "0000000000000000" })).get("error"), "stale");
  assert.equal((await voiceRow()).definition, before.definition);
});

// ── the refusal banners (PR 0 codes) ────────────────────────────────────────

test("the PR 0 refusal codes show localized text in the banner, never the raw code", async () => {
  for (const [code, key] of [["voice_bot_readonly", "botbuilder.voiceBotReadonly"], ["voice_bot_permanent", "botbuilder.voiceBotPermanent"]]) {
    assert.equal(T(key), code === "voice_bot_readonly" ? "Crow's voice is changed in its own editor." : "Crow's voice can't be deleted. You can switch it off in its editor instead.");
    for (const lang of ["en", "es"]) {
      let html = "";
      await panel.handler({ method: "GET", query: { error: code }, headers: lang === "es" ? { cookie: "crow_lang=es" } : {}, csrfToken: "tok" },
        { send: (h) => { html = h; }, redirectAfterPost() {} }, { db, lang, layout: ({ content }) => content });
      assert.ok(html.includes(`<p class="btb-notice-err">${T(key, lang)}</p>`), `${code} ${lang}`);
      assert.ok(!html.includes(`>${code}<`), `${code} ${lang}: not the raw code`);
    }
  }
});

test("voice editor strings: en + es, differing, no backtick or dollar-brace", () => {
  const keys = Object.keys(translations).filter((k) => /^botbuilder\.voice(Bot|Cloud|Chip|Customise|Card|Editor|On|Preset|Model|Persona|Name|Prompt|Tts|Stt|Profile|Memory|Abil|Esc|Err|Fast)/.test(k));
  assert.ok(keys.length >= 20, keys.length);
  for (const k of keys) {
    const e = translations[k];
    assert.ok(e.en && e.es && e.en !== e.es, k);
    assert.ok(!/[`]|\$\{/.test(e.en + e.es), k);
  }
  assert.equal(T("botbuilder.voiceCloudSlower"), "A cloud model makes every voice turn slower than the local quick model.");
  assert.equal(T("botbuilder.voiceCloudLeaves"), "With a cloud model, what you say to Crow is sent to {provider}.");
});

// ── final-review fixes ──────────────────────────────────────────────────────

test("Memory tools off removes every crow-memory/ entry, a carried one too; a preset switch keeps it off; on adds the three back", async () => {
  const def = JSON.parse(JSON.stringify(SEED_DEF));
  def.tools.crow_mcp.push("crow-memory/crow_list_memories");   // a read-only memory tool the migration carried
  await reset(def);
  const mem = (d) => d.tools.crow_mcp.filter((x) => x.startsWith("crow-memory/"));
  assert.match(await editor(), /name="memory_tools"[^>]*checked/, "on while any memory entry is there");
  assert.equal(qOf(await post(await saveBody({ memory_tools: "off" }))).get("saved"), "1");
  assert.deepEqual(mem(await voiceDef()), [], "no crow-memory/ entry is left");
  assert.doesNotMatch(await editor(), /name="memory_tools"[^>]*checked/, "the switch shows off");
  const sw = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "cloud", cloud_model: "cloud-x/model-y" });
  assert.equal(qOf(sw).get("saved"), "1", sw);
  assert.deepEqual(mem(await voiceDef()), [], "still off after a preset switch");
  assert.equal(qOf(await post(await saveBody({ memory_tools: "on" }))).get("saved"), "1");
  assert.deepEqual(mem(await voiceDef()).sort(), ["crow-memory/crow_recall_by_context", "crow-memory/crow_search_memories", "crow-memory/crow_store_memory"]);
  await reset();
});

test("a preset switch with only a carried memory entry keeps memory on (it is on)", async () => {
  const def = JSON.parse(JSON.stringify(SEED_DEF));
  def.tools.crow_mcp = def.tools.crow_mcp.filter((x) => !x.startsWith("crow-memory/"));
  def.tools.crow_mcp.push("crow-memory/crow_list_memories");
  await reset(def);
  const sw = await post({ action: "voice_bot_preset", bot_id: "crow.voice", rev: voiceRev(await voiceRow()), preset: "fast_local" });
  assert.equal(qOf(sw).get("saved"), "1", sw);
  const mem = (await voiceDef()).tools.crow_mcp.filter((x) => x.startsWith("crow-memory/"));
  assert.ok(mem.includes("crow-memory/crow_list_memories") && mem.includes("crow-memory/crow_store_memory"), mem.join(","));
  await reset();
});

test("a corrupt voice row: the editor says it can't be read and is kept, en + es; a save is refused and writes nothing", async () => {
  await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='crow.voice'", args: ["{not json"] });
  try {
    const { escapeHtml } = await import("../servers/gateway/dashboard/shared/components.js");
    for (const lang of ["en", "es"]) {
      const html = await editor({ lang });
      assert.ok(html.includes(escapeHtml(T("botbuilder.voiceErrCorrupt", lang))), lang);
      assert.ok(!html.includes(escapeHtml(T("botbuilder.voiceErrMissing", lang))), `${lang}: not the missing-row text`);
    }
    assert.equal(T("botbuilder.voiceErrCorrupt"), "Crow's voice settings can't be read. They are kept as they are; ask for help repairing them.");
    const url = await post({ action: "voice_bot_save", bot_id: "crow.voice", rev: "x", display_name: "Crow" });
    assert.equal(qOf(url).get("error"), "voice_corrupt", url);
    assert.equal((await voiceRow()).definition, "{not json");
  } finally { await reset(); }
});

// ── the Routine section (Task 2.6) ──────────────────────────────────────────

const routineSnapshot = async () => {
  const { migrated_from, handoff, permission_policy, preset, fast_voice_model } = await voiceDef();
  return { migrated_from, handoff, permission_policy, preset, fast_voice_model };
};

test("routine settings save and validate", async () => {
  await reset();
  await db.execute({ sql: "INSERT OR IGNORE INTO project_spaces (id, name, slug) VALUES (7, 'Home', 'home')", args: [] }).catch(() => {});
  const others = await otherRows();
  const policyBefore = (await voiceDef()).permission_policy;
  const before = await routineSnapshot();
  const url = await post(await saveBody({
    routine_calendar_backend: "google", routine_calendar_id: "  family  ", routine_reminders_backend: "off",
    routine_tasks_backend: "board", routine_tasks_list: " groceries ", routine_tasks_project_id: "7", confirm: "strict",
  }));
  assert.equal(qOf(url).get("saved"), "1", url);
  const d = await voiceDef();
  assert.deepEqual(d.routine, {
    calendar: { backend: "google", calendar: "family" }, reminders: { backend: "off" },
    tasks: { backend: "board", list: "groceries", project_id: 7 },
  });
  assert.equal(d.voice.confirm, "strict");
  assert.deepEqual(d.permission_policy, policyBefore, "the permission policy is kept as stored");
  assert.deepEqual(await otherRows(), others, "no other bot is touched");
  assert.deepEqual(await routineSnapshot(), before, "nothing else in the definition moved");
  // an unknown value keeps the stored one; confirm never loosens
  const bad = await post(await saveBody({
    routine_calendar_backend: "nope", routine_reminders_backend: "workspace", routine_tasks_backend: "x",
    routine_tasks_project_id: "99999", confirm: "never",
  }));
  assert.equal(qOf(bad).get("saved"), "1", bad);
  const d2 = await voiceDef();
  assert.equal(d2.routine.calendar.backend, "google");
  assert.equal(d2.routine.reminders.backend, "off");
  assert.equal(d2.routine.tasks.backend, "board");
  assert.equal(d2.routine.tasks.project_id, 7, "a project that does not exist keeps the stored one");
  assert.equal(d2.voice.confirm, "strict", "an invalid confirm keeps the stored value");
  // from a fresh row an invalid confirm stays "standard"
  await reset();
  await post(await saveBody({ confirm: "never" }));
  assert.equal((await voiceDef()).voice.confirm, "standard");
  // empty ids clear; an over-long id is capped at 200
  await post(await saveBody({ routine_calendar_id: "c".repeat(300), routine_tasks_list: "l", routine_tasks_project_id: "7" }));
  assert.equal((await voiceDef()).routine.calendar.calendar.length, 200);
  await post(await saveBody({ routine_calendar_id: "", routine_tasks_list: "", routine_tasks_project_id: "" }));
  const d3 = await voiceDef();
  assert.deepEqual([d3.routine.calendar.calendar, d3.routine.tasks.list, d3.routine.tasks.project_id], [null, null, null]);
  // a routine save is still compare-and-swap
  const stale = await post(await saveBody({ rev: "0000000000000000", confirm: "strict", routine_tasks_backend: "off" }));
  assert.equal(qOf(stale).get("error"), "stale");
  assert.equal((await voiceDef()).voice.confirm, "standard");
  await reset();
});

test("the editor names what auto picks", async () => {
  const { connectedServers } = await import("../servers/gateway/proxy.js");
  await reset();
  connectedServers.set("t-gcal", { status: "connected", tools: [{ name: "gcal_create_event" }] });
  try {
    const html = await editor();
    assert.ok(html.includes(T("botbuilder.voiceRoutineGoogle")), "calendar auto resolves to Google");
    assert.ok(!html.includes(T("botbuilder.voiceRoutineNoCalendar")), "no no-calendar hint");
    assert.ok(html.includes(T("botbuilder.voiceRoutineWritesWhere")), "the tools write wherever these point");
    for (const n of ["routine_calendar_backend", "routine_calendar_id", "routine_reminders_backend", "routine_tasks_backend", "routine_tasks_list", "routine_tasks_project_id", "confirm"]) {
      assert.ok(html.includes(`name="${n}"`), n);
    }
    const es = await editor({ lang: "es" });
    assert.ok(es.includes(T("botbuilder.voiceRoutineGoogle", "es")));
  } finally { connectedServers.delete("t-gcal"); }
  const none = await editor();
  assert.ok(none.includes(T("botbuilder.voiceRoutineNoCalendar")), "nothing installed: the reminder hint");
  assert.ok(!none.includes(T("botbuilder.voiceRoutineGoogle")));
});

test("the editor's confirm wording and the no-calendar line say what really happens", async () => {
  await reset();
  // Standard adds at once and asks before deleting, changing or sending; strict also asks before adding.
  assert.match(T("botbuilder.voiceConfirmStandard"), /right away/);
  assert.match(T("botbuilder.voiceConfirmStandard"), /deleting, changing or sending/);
  assert.ok(!/asks once/.test(T("botbuilder.voiceConfirmStandard")));
  assert.match(T("botbuilder.voiceConfirmStrict"), /also asks before adding/);
  const html = await editor();
  assert.ok(html.includes(T("botbuilder.voiceConfirmStandard")) && html.includes(T("botbuilder.voiceConfirmStrict")));
  // No calendar and reminders off: no reminder promise, the can't-add line instead.
  await reset({ ...SEED_DEF, routine: { ...(SEED_DEF.routine || {}), reminders: { backend: "off" } } });
  for (const lang of ["en", "es"]) {
    const off = await editor({ lang });
    assert.ok(!off.includes(T("botbuilder.voiceRoutineNoCalendar", lang)), `${lang}: no reminder promise`);
    assert.ok(off.includes(T("botbuilder.voiceRoutineNoCalendarNoReminder", lang)), `${lang}: the can't-add line`);
  }
  await reset();
  const on = await editor();
  assert.ok(on.includes(T("botbuilder.voiceRoutineNoCalendar")));
  assert.ok(!on.includes(T("botbuilder.voiceRoutineNoCalendarNoReminder")));
});

// ── PR 2.1 Task 6: each calendar and list says whose it is; the editor says when Crow will ask ─────────────
test("the editor marks each calendar and list Crow's own or shared by its owner, and says when Crow will ask", async () => {
  const { connectedServers } = await import("../servers/gateway/proxy.js");
  await reset();
  const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] });
  let calendars = [
    { id: "personal", name: "Personal", owner: "Crow bot", writable: true, color: null, shared: false },
    { id: "Menu_shared_by_admin", name: "Menu (admin)", owner: "Robin", writable: true, color: null, shared: true },
  ];
  let lists = [{ id: "Chores_shared_by_admin", name: "Chores (admin)", owner: "Robin", writable: true, shared: true }];
  connectedServers.set("t-ws", { status: "connected", tools: ["ws_cal_create_event", "ws_cal_list_calendars", "ws_task_create", "ws_tasks_list_lists"].map((name) => ({ name })),
    client: { callTool: async ({ name }) => (name === "ws_cal_list_calendars" ? reply({ calendars }) : reply({ lists })) } });
  try {
    for (const lang of ["en", "es"]) {
      const html = await editor({ lang });
      assert.ok(html.includes(T("botbuilder.voiceRoutineCalendarsHere", lang)), `${lang}: the calendars are listed`);
      assert.ok(html.includes("Personal (personal): " + T("botbuilder.voiceRoutineCrowsOwn", lang)), `${lang}: Crow's own`);
      assert.ok(!/yours|tuy[oa]/.test(html.slice(html.indexOf(T("botbuilder.voiceRoutineCalendarsHere", lang)))), `${lang}: never "yours"`);
      assert.ok(html.includes(T("botbuilder.voiceRoutineSharedBy", lang).replace("{owner}", "Robin")), `${lang}: shared by the owner`);
      assert.ok(html.includes(T("botbuilder.voiceRoutineListsHere", lang)), `${lang}: the lists are listed`);
      assert.ok(!html.includes(T("botbuilder.voiceRoutineWillAskCalendar", lang)), `${lang}: Crow has its own calendar: no question`);
      assert.ok(html.includes(T("botbuilder.voiceRoutineBoard", lang)), `${lang}: auto tasks with only a shared list go to the board`);
    }
    assert.equal(T("botbuilder.voiceRoutineCrowsOwn"), "Crow's own");
    assert.equal(T("botbuilder.voiceRoutineCrowsOwn", "es"), "de Crow");
    // Only shared calendars, no Google: Crow will ask.
    calendars = calendars.slice(1);
    const ask = await editor();
    assert.ok(ask.includes(T("botbuilder.voiceRoutineWillAskCalendar")));
    assert.ok((await editor({ lang: "es" })).includes(T("botbuilder.voiceRoutineWillAskCalendar", "es")));
    // An explicit Workspace task backend with only shared lists asks too.
    await reset({ ...SEED_DEF, routine: { ...(SEED_DEF.routine || {}), tasks: { backend: "workspace" } } });
    assert.ok((await editor()).includes(T("botbuilder.voiceRoutineWillAskList")));
    // A chosen calendar: no question.
    await reset({ ...SEED_DEF, routine: { ...(SEED_DEF.routine || {}), calendar: { backend: "auto", calendar: "Menu_shared_by_admin" } } });
    assert.ok(!(await editor()).includes(T("botbuilder.voiceRoutineWillAskCalendar")));
  } finally { connectedServers.delete("t-ws"); await reset(); }
});

// ── PR 2.1 Task 7: the opt-in transcript view, saved through the same compare-and-swap ──
test("the transcript buffer switch: off by default, warns en + es, saves on and off through the CAS, a stale page writes nothing", async () => {
  await reset();
  const html = await editor();
  assert.match(html, /name="transcript_buffer"/);
  assert.doesNotMatch(html, /name="transcript_buffer"[^>]*checked/, "off by default");
  assert.ok(html.includes(T("botbuilder.voiceTranscriptsWarn")));
  assert.equal(T("botbuilder.voiceTranscriptsWarn"), "Keeps what is said to Crow on every display and phone for 15 minutes, in memory, for troubleshooting.");
  assert.ok((await editor({ lang: "es" })).includes(T("botbuilder.voiceTranscriptsWarn", "es")));
  for (const k of ["botbuilder.voiceTranscriptsTitle", "botbuilder.voiceTranscriptsLabel", "botbuilder.voiceTranscriptsWarn"]) {
    assert.ok(T(k) && T(k, "es") && T(k) !== T(k, "es"), k);
  }
  const stale = await saveBody({ transcript_buffer: "on" });
  assert.equal(qOf(await post(await saveBody({ transcript_buffer: "on" }))).get("saved"), "1");
  assert.equal((await voiceDef()).voice.transcript_buffer, true);
  assert.match(await editor(), /name="transcript_buffer"[^>]*checked/);
  assert.equal(qOf(await post({ ...stale, transcript_buffer: "" })).get("error"), "stale", "the old rev cannot turn it off");
  assert.equal((await voiceDef()).voice.transcript_buffer, true);
  assert.equal(qOf(await post(await saveBody({}))).get("saved"), "1", "unticked: absent from the form");
  assert.equal((await voiceDef()).voice.transcript_buffer, false);
  await reset();
});

test("the one-week transcript log switch: off by default, says local-only / not backed up / 7 days (en + es), saves on and off, independent of the buffer", async () => {
  await reset();
  const html = await editor();
  assert.match(html, /name="transcript_log"/);
  assert.doesNotMatch(html, /name="transcript_log"[^>]*checked/, "off by default");
  assert.ok(html.includes(T("botbuilder.voiceTranscriptLogWarn")));
  assert.match(T("botbuilder.voiceTranscriptLogWarn"), /never audio/);
  assert.match(T("botbuilder.voiceTranscriptLogWarn"), /not in Crow's backups, not synced/);
  assert.match(T("botbuilder.voiceTranscriptLogWarn"), /7 days/);
  for (const k of ["botbuilder.voiceTranscriptLogLabel", "botbuilder.voiceTranscriptLogWarn"]) assert.ok(T(k) && T(k, "es") && T(k) !== T(k, "es"), k);
  assert.equal(qOf(await post(await saveBody({ transcript_log: "on" }))).get("saved"), "1");
  assert.equal((await voiceDef()).voice.transcript_log, true);
  assert.equal((await voiceDef()).voice.transcript_buffer, false, "the buffer is a separate switch");
  assert.match(await editor(), /name="transcript_log"[^>]*checked/);
  assert.equal(qOf(await post(await saveBody({}))).get("saved"), "1", "unticked: absent from the form");
  assert.equal((await voiceDef()).voice.transcript_log, false);
  await reset();
});

test("the calendar id label says what empty means under auto: Crow's own, else Google primary, else it asks (en + es)", () => {
  const t = translations["botbuilder.voiceRoutineCalendarId"];
  assert.match(t.en, /empty: Crow picks its own calendar, else Google primary, else asks/);
  assert.match(t.es, /vacío: Crow usa su propio calendario; si no, el principal de Google; si no, pregunta/);
  assert.ok(!/never a shared one|nunca uno compartido/.test(`${t.en} ${t.es}`));
});

// ── PR 3 Task 3.10: the Hand-offs section and the log ──
test("allowed bots save and an unknown id is dropped", async () => {
  await reset();
  const url = await post(await saveBody({ allowed_bots: ["writer", "nope", "crow.voice", "writer"] }));
  assert.equal(qOf(url).get("saved"), "1");
  const d = await voiceDef();
  assert.deepEqual(d.handoff, { enabled: true, allowed_bots: ["writer"] });
  assert.match(await editor(), /name="allowed_bots" value="writer" form="btb-vsave" checked/);
  assert.doesNotMatch(await editor(), /name="allowed_bots" value="alpha"[^>]*checked/);
  // a single ticked box arrives as a string, none as nothing (= all bots)
  const SHOWN = ["alpha", "writer"];
  await post(await saveBody({ allowed_bots: "alpha", allowed_bots_shown: SHOWN }));
  assert.deepEqual((await voiceDef()).handoff.allowed_bots, ["alpha"]);
  assert.match(await editor(), /name="allowed_bots_shown" value="writer"/);
  await post(await saveBody({ allowed_bots_shown: SHOWN }));
  assert.deepEqual((await voiceDef()).handoff.allowed_bots, [], "shown and unticked: dropped");
  await reset();
});

test("a save never widens allowed_bots: a deleted bot's id stays, and a failed read keeps the list", async () => {
  const withAllowed = { ...SEED_DEF, handoff: { enabled: true, allowed_bots: ["gone"] } };
  await reset(withAllowed);
  // stored ["gone"] (no such bot), a persona-only save
  assert.equal(qOf(await post(await saveBody({ system_prompt: "new persona", allowed_bots_shown: ["alpha", "writer"] }))).get("saved"), "1");
  assert.deepEqual((await voiceDef()).handoff.allowed_bots, ["gone"]);
  // a save from a page without the field leaves it too
  await post(await saveBody({ system_prompt: "again" }));
  assert.deepEqual((await voiceDef()).handoff.allowed_bots, ["gone"]);
  // the bot table cannot be read during the save
  const broken = { execute: (q) => (typeof q === "object" && q.sql === "SELECT bot_id, definition FROM pi_bot_defs" ? Promise.reject(new Error("db down")) : db.execute(q)), close() {} };
  await reset({ ...SEED_DEF, handoff: { enabled: true, allowed_bots: ["writer"] } });
  assert.equal(qOf(await post(await saveBody({ allowed_bots: ["alpha"], allowed_bots_shown: ["alpha", "writer"] }), broken)).get("saved"), "1");
  assert.deepEqual((await voiceDef()).handoff.allowed_bots, ["writer"]);
  await reset();
});

test("the picker says when a bot is off", async () => {
  await db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 0 WHERE bot_id = 'alpha'", args: [] });
  try {
    const html = await editor();
    assert.ok(html.slice(html.indexOf('value="alpha"')).split("</li>")[0].includes(T("botbuilder.voiceHandoffBotOff")));
    assert.ok(!html.slice(html.indexOf('value="writer"')).split("</li>")[0].includes(T("botbuilder.voiceHandoffBotOff")));
  } finally { await db.execute({ sql: "UPDATE pi_bot_defs SET enabled = 1 WHERE bot_id = 'alpha'", args: [] }); }
  assert.ok(T("botbuilder.voiceHandoffBotsHint").includes("is on") && T("botbuilder.voiceHandoffBotsHint", "es").includes("activados"));
});

test("hand-offs off saves enabled:false and keeps routine settings", async () => {
  await reset();
  await post(await saveBody({ routine_tasks_list: "mine" }));
  const before = await voiceDef();
  const body = await saveBody({ routine_tasks_list: "mine" });
  delete body.handoff_enabled;
  assert.equal(qOf(await post(body)).get("saved"), "1");
  const d = await voiceDef();
  assert.equal(d.handoff.enabled, false);
  assert.deepEqual(d.routine, before.routine);
  assert.equal(d.routine.tasks.list, "mine");
  assert.doesNotMatch(await editor(), /name="handoff_enabled"[^>]*checked/);
  await reset();
});

const HO = (over) => ({ kind: "handoff", surface: "phone", device_id: "d1", bot_id: "writer", task: "t", status: "done", ...over });
async function seedLog(rows) {
  await db.execute({ sql: "DELETE FROM voice_handoffs", args: [] });
  const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
  let clock = 1_700_000_000_000;
  const store = createHandoffStore({ now: () => (clock += 60_000) });
  for (const r of rows) await store.insert(db, r);
}

test("the log lists the newest first, with drawer links", async () => {
  await reset();
  await seedLog([HO({ task: "first job", device_id: "a" }), HO({ task: "second job", device_id: "b", status: "declined", asked: null }), HO({ task: "third job", device_id: "c", status: "proposed", asked: "please do the third" })]);
  const { default: Database } = await import("better-sqlite3");
  const tdb = new Database(process.env.CROW_TASKS_DB_PATH);
  tdb.exec("CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, project_id INTEGER, board_id INTEGER, archived_at TEXT)");
  tdb.prepare("INSERT OR REPLACE INTO tasks_items (id, title) VALUES (42, 'a card')").run();
  tdb.close();
  await db.execute({ sql: "UPDATE voice_handoffs SET card_id = 42 WHERE task = 'second job'", args: [] });
  await db.execute({ sql: "UPDATE voice_handoffs SET card_id = 999 WHERE task = 'third job'", args: [] });
  const html = await editor();
  assert.ok(html.includes(T("botbuilder.voiceHandoffLogTitle")));
  assert.ok(html.indexOf("third job") < html.indexOf("second job") && html.indexOf("second job") < html.indexOf("first job"));
  assert.match(html, /href="\/dashboard\/bot-board\?card=42"/);
  assert.equal((html.match(/bot-board\?card=/g) || []).length, 1, "a card that is gone gets no link");
  assert.ok(html.includes("please do the third"));
  assert.ok(html.includes(T("botbuilder.voiceHandoffStatus_declined")), "a known status is translated");
  assert.ok((await editor({ lang: "es" })).includes(T("botbuilder.voiceHandoffStatus_declined", "es")));
  // at most 20 rows, a null asked renders cleanly
  await seedLog(Array.from({ length: 25 }, (_, i) => HO({ task: "job-" + String(i).padStart(2, "0"), device_id: "x" + i, asked: null })));
  const many = await editor();
  assert.equal((many.match(/<tr><td>/g) || []).length, 20);
  assert.ok(!many.includes("job-00") && many.includes("job-24"));
  assert.ok(!/null|undefined/.test(many.slice(many.indexOf("btb-handoff-log"))));
  await db.execute({ sql: "DELETE FROM voice_handoffs", args: [] });
  assert.ok((await editor()).includes(T("botbuilder.voiceHandoffLogEmpty")));
});

test("summaries and task text are escaped", async () => {
  await reset();
  try {
  await db.execute({ sql: "UPDATE pi_bot_defs SET display_name = ? WHERE bot_id = 'writer'", args: ["<img src=x onerror=1>"] });
  await db.execute({ sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = 'alpha'", args: [JSON.stringify({ description: "<script>alert(1)</script>", models: { default: "crow-chat/qwen3.6-35b-a3b" } })] });
  await seedLog([HO({ task: "<b>bold</b> & \"q\"", asked: "<script>x</script>", bot_id: "<i>bot</i>", surface: "<u>s</u>" })]);
  const html = await editor();
  for (const raw of ["<img src=x", "<script>alert", "<b>bold</b>", "<script>x</script>", "<i>bot</i>", "<u>s</u>"]) assert.ok(!html.includes(raw), raw);
  assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;") && html.includes("&lt;script&gt;x&lt;/script&gt;"));
  // alpha has no project: its board is off, and the hint says so
  assert.ok(html.includes(T("botbuilder.voiceHandoffBoardOff")));
  } finally {
  await db.execute({ sql: "UPDATE pi_bot_defs SET display_name = 'Writer' WHERE bot_id = 'writer'", args: [] });
  await db.execute({ sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = 'alpha'", args: [JSON.stringify({ models: { default: "crow-chat/qwen3.6-35b-a3b" }, gateways: [{ type: "perch" }] })] });
  await db.execute({ sql: "DELETE FROM voice_handoffs", args: [] });
  }
});

test("hand-off strings: en + es, differing, no backtick or dollar-brace", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("botbuilder.voiceHandoff"));
  assert.ok(keys.length >= 20);
  for (const k of keys) {
    const { en, es } = translations[k];
    assert.ok(en && es, k);
    assert.notEqual(en, es, k);
    assert.ok(!/[`]|\$\{/.test(en + es), k);
  }
});

// ── role: refs (roles phase 2, task 22) ─────────────────────────────────────

test("the voice card names a role: model and keeps the raw ref on hover", async () => {
  await reset({ ...SEED_DEF, fast_voice_model: "role:voice" });
  const html = await list("en");
  assert.match(html, /<span class="btb-mchip" title="role:voice">Voice<\/span>/);
  await reset();
});

test("a custom role's label is escaped on the card", async () => {
  const { saveCustomRole } = await import("../servers/shared/model-roles-store.js");
  const r = await saveCustomRole(db, { label: "<b>Coder</b>", capability: "chat" }, { actor: "test" });
  assert.ok(r.ok, JSON.stringify(r));
  await reset({ ...SEED_DEF, fast_voice_model: "role:" + r.id });
  const html = await list("en");
  assert.ok(html.includes("&lt;b&gt;Coder&lt;/b&gt;") && !html.includes("<b>Coder</b>"));
  await reset();
});

test("the voice editor keeps a role: ref selected first and accepts it on save; an unknown role is refused", async () => {
  await reset({ ...SEED_DEF, fast_voice_model: "role:voice" });
  const html = await editor();
  assert.ok(html.includes('<option value="role:voice" selected>Voice</option>'));
  const ok = await post(await saveBody({ fast_voice_model: "role:voice" }));
  assert.ok(!qOf(ok).get("error"), ok);
  assert.equal((await voiceDef()).fast_voice_model, "role:voice");
  const bad = await post(await saveBody({ fast_voice_model: "role:nope" }));
  assert.ok(qOf(bad).get("error"), bad);
  await reset();
});

test("a Basics save accepts a role: model without the 'not in registry' warning; an unknown role still warns", async () => {
  const { saveBasics } = await import("../servers/gateway/dashboard/panels/bot-builder/save-handlers.js");
  const run = async (key) => {
    const def = { models: { default: "crow-chat/qwen3.6-35b-a3b" } };
    const r = await saveBasics(def, { model_default: key }, { db, lang: "en", changed: () => true });
    return { def, r };
  };
  const ok = await run("role:everyday");
  assert.equal(ok.def.models.default, "role:everyday");
  assert.deepEqual(ok.r.warn, []);
  const bad = await run("role:nope");
  assert.equal(bad.r.warn.length, 1);
});

test("the Basics model select renders a held role: ref as the first option", async () => {
  const { renderBasics } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-basics.js");
  const html = await renderBasics({ req: { headers: {}, csrfToken: "t" }, db, bot: { bot_id: "alpha", display_name: "Alpha" }, botId: "alpha",
    def: { models: { default: "role:everyday" }, gateways: [{ type: "perch" }] }, lang: "en", hidden: () => "" });
  const i = html.indexOf('id="bx-model"');
  assert.ok(html.slice(i, i + 400).includes('<option value="role:everyday" selected>Builder</option>'), html.slice(i, i + 400));
});
