import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseVoiceRoute, VOICE_ROUTE_KEYS } from "../servers/gateway/routes/llm-router.js";
import { LATENCY_QUESTIONS } from "../bundles/kiosk/server/questions.js";

const u = (content) => [{ role: "system", content: "s" }, { role: "user", content }];

test("plain question → fast", () => {
  assert.deepEqual(chooseVoiceRoute(u("What is the capital of Portugal?"), { hasTools: true }),
    { route: "fast", reason: null, key: VOICE_ROUTE_KEYS.fast });
});

test("!escalate → manual escalation", () => {
  const r = chooseVoiceRoute(u("!escalate explain entropy"), { hasTools: false });
  assert.equal(r.route, "escalate"); assert.equal(r.reason, "manual"); assert.equal(r.key, VOICE_ROUTE_KEYS.escalate);
});

test("action verb escalates only when tools are on the table", () => {
  assert.equal(chooseVoiceRoute(u("play some jazz"), { hasTools: true }).reason, "tool-intent");
  assert.equal(chooseVoiceRoute(u("play some jazz"), { hasTools: false }).route, "fast");
});

test("recent tool context is sticky (tool message within the lookback)", () => {
  const msgs = [...u("set a timer"), { role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "1", name: "crow_wm" }]) },
    { role: "tool", content: "{}", tool_call_id: "1" }, { role: "assistant", content: "Done." }, { role: "user", content: "thanks" }];
  assert.equal(chooseVoiceRoute(msgs, { hasTools: true }).route, "escalate");
});

test("every scripted latency question routes fast on a kiosk (tools always present)", () => {
  assert.equal(LATENCY_QUESTIONS.length, 20);
  assert.equal(new Set(LATENCY_QUESTIONS).size, 20);
  for (const q of LATENCY_QUESTIONS) {
    assert.equal(chooseVoiceRoute(u(q), { hasTools: true }).route, "fast", q);
    assert.ok(q.split(/\s+/).length <= 12, `short question: ${q}`);
  }
});

test("actionIntent (the voice turn: an action request whose tools the quick model was not offered) escalates; without it nothing changes", () => {
  const r = chooseVoiceRoute(u("Add a car appointment for Monday to my calendar"), { hasTools: true, actionIntent: true });
  assert.deepEqual(r, { route: "escalate", reason: "action-intent", key: VOICE_ROUTE_KEYS.escalate });
  assert.equal(chooseVoiceRoute(u("Add a car appointment for Monday to my calendar"), { hasTools: true }).route, "fast", "the regex alone does not cover it");
  assert.equal(chooseVoiceRoute(u("What is the capital of Portugal?"), { hasTools: false, actionIntent: false }).route, "fast");
  assert.equal(chooseVoiceRoute(u("!escalate add it"), { hasTools: true, actionIntent: true }).reason, "manual", "the typed token still wins");
});

test("COMPANION_TOOL_ESCALATION=0 turns action-intent escalation off too", async () => {
  const { execFileSync } = await import("node:child_process");
  const url = new URL("../servers/gateway/routes/llm-router.js", import.meta.url).href;
  const code = `const m = await import(${JSON.stringify(url)}); process.stdout.write(m.chooseVoiceRoute([{ role: "user", content: "add it to my calendar" }], { hasTools: true, actionIntent: true }).route);`;
  const run = (v) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, COMPANION_TOOL_ESCALATION: v }, encoding: "utf8" });
  assert.equal(run("0"), "fast");
  assert.equal(run("1"), "escalate");
});
