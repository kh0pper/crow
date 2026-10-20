import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CROW_VOICE_BOT_ID, DEFAULT_PERSONA, isVoiceBotId, voiceBotDefinition, normalizeVoiceSettings,
} from "../servers/shared/voice-bot.js";

test("fast_local preset: a voice bot that can never run pi work", () => {
  const d = voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" });
  assert.equal(d.kind, "voice"); assert.equal(d.engine, "voice"); assert.equal(d.preset, "fast_local");
  assert.deepEqual(d.gateways, []); assert.deepEqual(d.tracker_config, { type: "none" });
  assert.equal(d.fast_voice_model, "crow-voice/qwen3.5-4b"); assert.equal(d.system_prompt, DEFAULT_PERSONA);
  assert.deepEqual(d.skills, []); assert.deepEqual(d.tools.pi_builtin, []);
  assert.equal(d.permission_policy.bash, "deny"); assert.equal(d.permission_policy.external_send, "draft_only");
  assert.equal(d.permission_policy.self_authoring, false); assert.equal(d.permission_policy.skill_learning, "off");
  assert.deepEqual(normalizeVoiceSettings(d).handoff, { enabled: true, allowed_bots: [] });
  assert.equal(normalizeVoiceSettings(d).confirm, "standard");
  assert.ok(d.tools.crow_mcp.includes("crow-memory/crow_store_memory"));
  assert.equal("migrated_from" in d, false);
  assert.equal(voiceBotDefinition({ preset: "fast_local", fastKey: "a/b", migratedFrom: "old" }).migrated_from, "old");
});
test("cloud preset needs a cloud model and turns escalation off", () => {
  assert.throws(() => voiceBotDefinition({ preset: "cloud", fastKey: "crow-voice/qwen3.5-4b" }), /cloud_model_required/);
  const d = voiceBotDefinition({ preset: "cloud", fastKey: "crow-voice/qwen3.5-4b", cloudKey: "cloud-x/model-y" });
  assert.equal(d.fast_voice_model, "cloud-x/model-y"); assert.equal(normalizeVoiceSettings(d).escalation, "off");
});
test("normalizeVoiceSettings tolerates garbage and never loosens", () => {
  const s = normalizeVoiceSettings({ kind: "voice", voice: "x", routine: 5, handoff: { allowed_bots: "writer", enabled: "yes" } });
  assert.equal(s.confirm, "standard"); assert.equal(s.escalation, "default");
  assert.deepEqual(s.handoff, { enabled: true, allowed_bots: [] });
  assert.deepEqual([s.routine.calendar.backend, s.routine.reminders.backend, s.routine.tasks.backend], ["auto", "auto", "auto"]);
  assert.equal(normalizeVoiceSettings({ kind: "voice", voice: { confirm: "never" } }).confirm, "standard");
  assert.equal(normalizeVoiceSettings({ kind: "voice", handoff: { enabled: false } }).handoff.enabled, false);
  assert.equal(normalizeVoiceSettings({ preset: "bogus" }).preset, "fast_local");
  assert.equal(normalizeVoiceSettings(null).preset, "fast_local");
  assert.deepEqual(normalizeVoiceSettings({ routine: { tasks: { backend: "nope", list: "L", project_id: 3 } } }).routine.tasks,
    { backend: "auto", list: "L", project_id: 3 });
});
test("the reserved id is exact", () => {
  assert.equal(isVoiceBotId("crow.voice"), true);
  for (const x of ["crow-voice", "", null, undefined, "CROW.VOICE"]) assert.equal(isVoiceBotId(x), false);
  assert.equal(CROW_VOICE_BOT_ID, "crow.voice");
});
