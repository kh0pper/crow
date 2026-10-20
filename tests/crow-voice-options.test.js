import { test } from "node:test";
import assert from "node:assert/strict";
import { crowVoiceTurnOptions, VOICE_DENY_TOOLS } from "../servers/gateway/voice/crow-voice.js";
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

test("VOICE_DENY_TOOLS is the shared list, not a copy; the kiosk's own list matches it", () => {
  assert.equal(VOICE_DENY_TOOLS, SHARED_DENY);
  assert.deepEqual([...KIOSK_DENY_TOOLS].sort(), [...VOICE_DENY_TOOLS].sort());
  assert.ok(Object.isFrozen(KIOSK_DENY_TOOLS));
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
