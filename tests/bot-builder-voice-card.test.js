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
  tts_profile_id: "t2", stt_profile_id: "", memory_tools: "on", enabled: "on", ...over,
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
