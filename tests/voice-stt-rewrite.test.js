/**
 * PR 2.1 Task 4: a misheard leading "add" ("Had coffee Tuesday at 9") is put back before any part of the turn
 * reads the transcript, and only then ([r2 I6]).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sttRewrite, isObjectWord, hasDayTime } from "../servers/gateway/voice/stt-rewrite.js";
import { phraseWords } from "../servers/gateway/voice/tool-families.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";
import { createPendingStore, chainVoiceActions } from "../servers/gateway/voice/pending.js";

test("the misheard 'add' is rewritten", () => {
  assert.deepEqual(sttRewrite("Had coffee Tuesday at 9"), { text: "add coffee Tuesday at 9", from: "had" });
  assert.deepEqual(sttRewrite("Ad lunch tomorrow at noon."), { text: "add lunch tomorrow at noon.", from: "ad" });
  assert.deepEqual(sttRewrite("And coffee at 9 am"), { text: "add coffee at 9 am", from: "and" });
  assert.deepEqual(sttRewrite("at dentist to my calendar"), { text: "add dentist to my calendar", from: "at" });
  assert.deepEqual(sttRewrite("had coffee Tuesday at 9", { lang: "en" }).from, "had");
});

test("never rewritten: a plain sentence, a bare day or time, Spanish", () => {
  for (const t of ["had a great day on Tuesday", "and tomorrow?", "and on Friday?", "at nine tomorrow add lunch", "and then what",
    "had coffee", "and coffee?", "had lunch yesterday", "add coffee Tuesday at 9", "at four", "and at five", "had 2 meetings today",
    "and dinner tomorrow?", "and Ann's party on Saturday?", "had lunch on Friday?"]) {
    assert.equal(sttRewrite(t), null, t);
  }
  assert.equal(sttRewrite("Had coffee Tuesday at 9", { lang: "es" }), null, "es is never rewritten");
  assert.equal(sttRewrite(""), null);
  assert.equal(sttRewrite(null), null);
});

test("the word tests", () => {
  for (const w of ["coffee", "lunch", "cafe"]) assert.equal(isObjectWord(w), true, w);
  for (const w of ["a", "the", "great", "tuesday", "tomorrow", "nine", "9", "on", "martes", "dos"]) assert.equal(isObjectWord(w), false, w);
  for (const t of ["Tuesday", "at 9", "9 am", "next week", "a las 9", "a la una", "el martes", "at nine", "9pm", "tonight", "October 27"]) {
    assert.equal(hasDayTime(phraseWords(t)), true, t);
  }
  for (const t of ["two minutes", "coffee", "for 5 seconds", "with mom", "yesterday"]) assert.equal(hasDayTime(phraseWords(t)), false, t);
});

// ─── In the turn ───
const FAST = "crow-voice/qwen3.5-4b";
const CROW = { bot_id: "crow.voice", kind: "voice", display_name: "Crow", fast_voice_model: FAST };
const OTHER = { bot_id: "other", display_name: "Other", fast_voice_model: FAST };
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
function rwHarness(over = {}) {
  const h = harness({ chatTools: [], bot: CROW, rounds: [says("Okay. ")], ...over });
  h.deps.toolFamilies = createToolFamilies({ manifests: {} });
  h.deps.chooseVoiceRoute = () => ({ route: "fast", reason: null, key: FAST });
  return h;
}
const turn = (h, transcript, opts = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript, sink: h.sink, familiesOnIntent: true, lang: "en", ownTools: [], ...opts });
const userOf = (h) => h.log[0].messages.at(-1).content;

test("in the turn: the rewritten text is what the caption, the model and the saved conversation see", async () => {
  const h = rwHarness();
  const r = await turn(h, "Had coffee Tuesday at 9");
  assert.equal(r.timings.stt_rewrite, "had");
  assert.equal(r.transcript, "add coffee Tuesday at 9");
  assert.deepEqual(h.events.filter((e) => e.type === "transcript_final").map((e) => e.text), ["add coffee Tuesday at 9"]);
  assert.ok(String(userOf(h)).endsWith("add coffee Tuesday at 9"), userOf(h));
  const saved = h.runner.convo.get(h.device.id);
  assert.equal(saved.find((m) => m.role === "user").content, "add coffee Tuesday at 9");
});

test("in the turn: no rewrite for another bot, in Spanish, or while a question waits", async () => {
  const other = rwHarness({ bot: OTHER });
  const r1 = await turn(other, "Had coffee Tuesday at 9");
  assert.equal(r1.timings.stt_rewrite, undefined);
  assert.equal(r1.transcript, "Had coffee Tuesday at 9");

  const es = rwHarness();
  const r2 = await turn(es, "Had coffee Tuesday at 9", { lang: "es" });
  assert.equal(r2.timings.stt_rewrite, undefined);

  const pending = createPendingStore();
  const h = rwHarness();
  h.deps.voiceActions = chainVoiceActions([{ turnContext: ({ device }) => (pending.get(device.id) ? { text: "[Pending] Add it?", pending: true } : null) }]);
  pending.set(h.device.id, { kind: "routine", say: "Add it?" });
  const r3 = await turn(h, "Had coffee Tuesday at 9");
  assert.equal(r3.timings.stt_rewrite, undefined, "a pending question: the words are left as heard");
  assert.equal(r3.transcript, "Had coffee Tuesday at 9");
  const r4 = await turn(h, "at four");
  assert.equal(r4.transcript, "at four");
  assert.equal(r4.timings.stt_rewrite, undefined);
});
