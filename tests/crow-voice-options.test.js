import { test } from "node:test";
import assert from "node:assert/strict";
import { crowVoiceTurnOptions, VOICE_DENY_TOOLS, withVoiceProfiles, createVoiceBotLoader, CROW_VOICE_BOT_ID, isVoiceBotId, VOICE_BOT_CACHE_MS, ownToolsLoaded } from "../servers/gateway/voice/crow-voice.js";
import { voiceLine, VOICE_LINES } from "../servers/gateway/voice/voice-lines.js";
import { VOICE_DENY_TOOLS as SHARED_DENY, voiceBotDefinition } from "../servers/shared/voice-bot.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";
import { displayTurnOptions, KIOSK_DENY_TOOLS } from "../bundles/kiosk/server/runtime.js";
import { createWmStore } from "../bundles/kiosk/server/wm.js";

const fast = voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" });
const cloud = voiceBotDefinition({ preset: "cloud", fastKey: "crow-voice/qwen3.5-4b", cloudKey: "cloud-test/model" });
const f = () => true;
const g = () => false;
const ACTION_KEYS = { cantDoText: "cant_do_say", notDoneText: "not_done_say", notReadyText: "not_ready_say", memoOnlyText: "memo_only_say", unsureText: "unsure_say" };

test("crowVoiceTurnOptions: one set of voice rules (families on intent, the shared deny list, the action lines)", () => {
  const o = crowVoiceTurnOptions({ surface: "glasses", lang: "es", voiceDef: fast, actionWhen: f, actionFollowWhen: g });
  assert.equal(o.surface, "glasses");
  assert.equal(o.familiesOnIntent, true);
  assert.deepEqual(o.denyTools, VOICE_DENY_TOOLS);
  assert.equal(o.cantDoText, STRINGS.es.cant_do_say);
  for (const [opt, key] of Object.entries(ACTION_KEYS)) assert.equal(o[opt], STRINGS.es[key], opt);
  assert.equal(o.actionWhen, f);
  assert.equal(o.actionFollowWhen, g);
  assert.equal("noEscalate" in o, false, "escalation stays on for the fast preset");
  const en = crowVoiceTurnOptions({ surface: "kiosk", lang: "en", voiceDef: fast, actionWhen: f, actionFollowWhen: g });
  for (const [opt, key] of Object.entries(ACTION_KEYS)) assert.equal(en[opt], STRINGS.en[key], opt);
});

test("crowVoiceTurnOptions: a cloud def never escalates; a cloud model is not gated by families", () => {
  assert.equal(crowVoiceTurnOptions({ surface: "phone", lang: "en", voiceDef: cloud, actionWhen: f, actionFollowWhen: g }).noEscalate, true);
  const c = crowVoiceTurnOptions({ surface: "phone", lang: "en", voiceDef: cloud, cloud: true, actionWhen: f, actionFollowWhen: g });
  assert.equal(c.familiesOnIntent, false);
  assert.equal(crowVoiceTurnOptions({ surface: "phone", lang: "en", actionWhen: f, actionFollowWhen: g }).familiesOnIntent, true, "no def, no cloud flag: the default rules");
});

test("VOICE_DENY_TOOLS is the shared list, not a copy (the kiosk parity test is in kiosk-tools-truth)", () => {
  assert.equal(VOICE_DENY_TOOLS, SHARED_DENY);
});

test("voiceLine: English and Spanish have the same keys, none empty; unknown language is English", () => {
  assert.deepEqual(Object.keys(VOICE_LINES.en).sort(), Object.keys(VOICE_LINES.es).sort());
  for (const lang of ["en", "es"]) for (const [k, v] of Object.entries(VOICE_LINES[lang])) assert.ok(typeof v === "string" && v.trim(), `${lang}.${k}`);
  assert.equal(voiceLine("cant_do_say", "fr"), STRINGS.en.cant_do_say);
  assert.equal(voiceLine("no_such_line", "en"), "");
});

test("kiosk displayTurnOptions merges the shared rules first; the display's own lines and deny list still hold", () => {
  const ctx = { store: createWmStore(), deviceId: "k1", caps: { windows: ["timer"], max_windows: 2, screen: { w: 800, h: 480 }, audio: { out: true } }, lang: "es", sources: [], items: [], emit: () => {}, surface: "phone" };
  const seen = [];
  const crowVoice = { turnOptions: (a) => { seen.push(a); return { ...crowVoiceTurnOptions(a), cantDoText: "SHARED" }; }, VOICE_DENY_TOOLS };
  const o = displayTurnOptions(ctx, { settings: { lang: "es" }, crowVoice });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].surface, "phone");
  assert.equal(seen[0].lang, "es");
  assert.equal(typeof seen[0].actionWhen, "function");
  assert.equal(o.surface, "phone");
  assert.equal(o.familiesOnIntent, true);
  assert.equal(o.cantDoText, STRINGS.es.cant_do_say, "the kiosk's own line wins");
  assert.deepEqual(o.denyTools, KIOSK_DENY_TOOLS);
  // A cloud model turns the family gate off through the shared rules.
  const oc = displayTurnOptions(ctx, { settings: { lang: "es" }, crowVoice, cloud: true });
  assert.equal(oc.familiesOnIntent, false);
  // Without the shared module (the evaluation, older callers): today's options.
  const plain = displayTurnOptions(ctx, { settings: { lang: "es" } });
  assert.equal(plain.familiesOnIntent, true);
  assert.deepEqual(plain.denyTools, KIOSK_DENY_TOOLS);
  assert.equal(typeof plain.actionWhen, "function");
});

test("withVoiceProfiles: the voice bot's speaking voice and speech recognition replace the device's, on a copy", () => {
  const device = Object.freeze({ id: "d1", tts_profile_id: "t1", stt_profile_id: "s1", kiosk_settings: { lang: "en" } });
  const def = { ...fast, voice: { ...fast.voice, tts_profile_id: "t2" } };
  const out = withVoiceProfiles(device, def);
  assert.equal(out.tts_profile_id, "t2");
  assert.equal(out.stt_profile_id, "s1", "a null STT choice keeps the device's");
  assert.notEqual(out, device, "a copy");
  assert.deepEqual(device, { id: "d1", tts_profile_id: "t1", stt_profile_id: "s1", kiosk_settings: { lang: "en" } }, "the input is not mutated");
  assert.equal(withVoiceProfiles(device, { ...fast, voice: { ...fast.voice, stt_profile_id: "s2" } }).stt_profile_id, "s2");
  assert.equal(withVoiceProfiles(device, fast).tts_profile_id, "t1", "null keeps t1");
  assert.equal(withVoiceProfiles(device, fast), device, "nothing to replace: the device unchanged");
  assert.equal(withVoiceProfiles(device, null), device, "no voice bot: the device unchanged");
  assert.equal(withVoiceProfiles(device, { voice: "corrupt" }), device);
});

test("crow-voice re-exports the reserved id and its test", () => {
  assert.equal(CROW_VOICE_BOT_ID, "crow.voice");
  assert.equal(isVoiceBotId("crow.voice"), true);
  assert.equal(isVoiceBotId("helper"), false);
});

/** A db stand-in: the voice bot row and the providers rows, counting reads. */
function fakeDb({ row, providers = {}, fail = false } = {}) {
  const reads = { bot: 0, provider: 0 };
  return {
    reads,
    async execute({ sql, args }) {
      if (fail) throw new Error("db down");
      if (/FROM pi_bot_defs/.test(sql)) { reads.bot++; assert.equal(args[0], CROW_VOICE_BOT_ID); return { rows: row ? [row] : [] }; }
      if (/FROM providers/.test(sql)) { reads.provider++; const p = providers[args[0]]; return { rows: p ? [p] : [] }; }
      throw new Error("unexpected sql " + sql);
    },
  };
}

test("loadVoiceBot: the voice bot and whether its fast model is a cloud provider (host \"cloud\")", async () => {
  const cloudDb = fakeDb({ row: { definition: JSON.stringify(cloud), enabled: 1 }, providers: { "cloud-test": { host: "cloud" } } });
  const c = await createVoiceBotLoader()(cloudDb);
  assert.equal(c.def.fast_voice_model, "cloud-test/model");
  assert.equal(c.cloud, true);
  const localDb = fakeDb({ row: { definition: JSON.stringify(fast), enabled: 1 }, providers: { "crow-voice": { host: "local" } } });
  assert.equal((await createVoiceBotLoader()(localDb)).cloud, false);
  const noProvider = fakeDb({ row: { definition: JSON.stringify(cloud), enabled: 1 } });
  assert.equal((await createVoiceBotLoader()(noProvider)).cloud, false, "no provider row: not cloud");
  // The provider id is the part before the FIRST "/".
  const slashes = { ...fast, fast_voice_model: "cloud-test/org/model" };
  const sDb = fakeDb({ row: { definition: JSON.stringify(slashes), enabled: 1 }, providers: { "cloud-test": { host: "cloud" } } });
  assert.equal((await createVoiceBotLoader()(sDb)).cloud, true);
});

test("loadVoiceBot: a missing, disabled or corrupt row, or a db error, is null; nothing throws", async () => {
  assert.equal(await createVoiceBotLoader()(fakeDb({})), null);
  assert.equal(await createVoiceBotLoader()(fakeDb({ row: { definition: JSON.stringify(fast), enabled: 0 } })), null);
  assert.equal(await createVoiceBotLoader()(fakeDb({ row: { definition: "{not json", enabled: 1 } })), null);
  assert.equal(await createVoiceBotLoader()(fakeDb({ row: { definition: "[1]", enabled: 1 } })), null);
  assert.equal(await createVoiceBotLoader()(fakeDb({ fail: true })), null);
});

test("loadVoiceBot: cached 30 s, and a bot-defs change reloads it at once", async () => {
  assert.equal(VOICE_BOT_CACHE_MS, 30_000);
  let t = 1_000, gen = 0;
  const load = createVoiceBotLoader({ now: () => t, generation: () => gen });
  const db = fakeDb({ row: { definition: JSON.stringify(fast), enabled: 1 } });
  await load(db); await load(db);
  assert.equal(db.reads.bot, 1, "one read inside the cache window");
  t += 30_000;
  await load(db);
  assert.equal(db.reads.bot, 2, "re-read after 30 s");
  gen++;
  await load(db);
  assert.equal(db.reads.bot, 3, "pibots:defs-changed (a new generation) re-reads at once");
});

// PR 2.1 Task 4: does the voice bot have Crow's own tools at hand (the kiosk's command-vocabulary STT prompt)?
test("ownToolsLoaded: the voice bot with at least one routine backend resolved; never a network call", () => {
  assert.equal(ownToolsLoaded(null), false);
  assert.equal(ownToolsLoaded({ bot_id: "helper" }), false, "not the voice bot");
  assert.equal(ownToolsLoaded(fast), true, "the defaults: Crow's own reminders and the board need no add-on");
  const none = { ...fast, routine: { calendar: { backend: "google" }, reminders: { backend: "off" }, tasks: { backend: "workspace" } } };
  assert.equal(ownToolsLoaded(none), false, "nothing resolves without the add-ons");
  assert.equal(ownToolsLoaded(none, new Set(["gcal_create_event"])), true, "a connected calendar");
  assert.equal(ownToolsLoaded(none, () => new Set(["ws_task_create"])), true, "a function is read");
  assert.equal(ownToolsLoaded(none, () => { throw new Error("x"); }), false, "a throwing reader is no add-on");
});

test("crowVoiceTurnOptions: the claim-retry hint (PR 2.1 Task 5) in the surface's language, word for word turn.js's default", async () => {
  const { HINT_TEXT } = await import("../servers/gateway/voice/turn.js");
  assert.equal(crowVoiceTurnOptions({ surface: "kiosk", lang: "en", actionWhen: f, actionFollowWhen: g }).hintText, HINT_TEXT);
  const es = crowVoiceTurnOptions({ surface: "glasses", lang: "es", actionWhen: f, actionFollowWhen: g }).hintText;
  assert.equal(es, VOICE_LINES.es.hint_say);
  assert.notEqual(es, HINT_TEXT);
});

test("the kiosk passes the shared hint through unchanged (no kiosk change needed)", () => {
  const ctx = { store: createWmStore(), deviceId: "k1", caps: { windows: ["timer"], max_windows: 2, screen: { w: 800, h: 480 }, audio: { out: true } }, lang: "es", sources: [], items: [], emit: () => {}, surface: "kiosk" };
  const o = displayTurnOptions(ctx, { settings: { lang: "es" }, crowVoice: { turnOptions: crowVoiceTurnOptions, VOICE_DENY_TOOLS } });
  assert.equal(o.hintText, VOICE_LINES.es.hint_say);
});

test("crowVoiceTurnOptions: relayThreadId passes through, blank is dropped", () => {
  assert.equal(crowVoiceTurnOptions({ surface: "phone", lang: "en", relayThreadId: "thread-1" }).relayThreadId, "thread-1");
  for (const blank of [undefined, null, "", "   ", 7]) {
    assert.equal("relayThreadId" in crowVoiceTurnOptions({ surface: "phone", lang: "en", relayThreadId: blank }), false, String(blank));
  }
});
