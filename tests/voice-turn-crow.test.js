import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const CROW = { bot_id: "crow.voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b" };
const HOUSE = { bot_id: "household", display_name: "House", fast_voice_model: "crow-voice/qwen3.5-4b" };
const row = (def, enabled = 1) => ({ bot_id: def.bot_id, enabled, definition: JSON.stringify(def) });

/** The shared harness, answering as the voice bot: `rows` maps bot id → def (or a function giving the row). */
function crowHarness({ rows = { "crow.voice": CROW, household: HOUSE }, ensure, ...over } = {}) {
  const h = harness({ bot: HOUSE, ...over });
  h.calls.loads = [];
  h.calls.ensured = 0;
  h.deps.voiceBotId = "crow.voice";
  h.deps.loadBotRow = async (db, id) => {
    h.calls.loads.push(id);
    const v = rows[id];
    if (typeof v === "function") return v();
    return v ? row(v) : null;
  };
  if (ensure !== false) h.deps.ensureVoiceBot = async (db) => { h.calls.ensured++; if (typeof ensure === "function") await ensure(db); };
  return h;
}
const turn = (h, opts = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "What is the capital of Portugal?", sink: h.sink, ...opts });
const errors = (h) => h.events.filter((e) => e.type === "error");

test("answers as the voice bot whatever the device is bound to", async () => {
  const h = crowHarness();
  assert.equal(h.device.bound_bot_id, "household");
  await turn(h);
  assert.match(h.log[0].messages[0].content, /^PERSONA:Crow/);
  assert.deepEqual(errors(h), []);
});

test("opts.botId wins", async () => {
  const h = crowHarness();
  await turn(h, { botId: "household" });
  assert.match(h.log[0].messages[0].content, /^PERSONA:House/);
});

test("without deps.voiceBotId the device's bound bot answers (today's behaviour)", async () => {
  const h = crowHarness();
  delete h.deps.voiceBotId;
  await turn(h);
  assert.match(h.log[0].messages[0].content, /^PERSONA:House/);
});

test("a fast path still works with no voice bot", async () => {
  const h = crowHarness({ rows: {} });
  const r = await turn(h, { transcript: "pause", fastPaths: async () => ({ say: "Paused." }) });
  assert.equal(r.fastPath, true);
  assert.deepEqual(h.calls.spoken, ["Paused."]);
  assert.ok(!h.events.some((e) => e.type === "error" && e.code === "no_bound_bot"));
  assert.equal(h.calls.ensured, 0, "the fast path never loads or ensures the bot");
});

test("a bot created by ensure answers the same turn", async () => {
  let created = false;
  const h = crowHarness({ rows: { "crow.voice": () => (created ? row(CROW) : null) }, ensure: async () => { created = true; } });
  const r = await turn(h);
  assert.equal(h.calls.ensured, 1);
  assert.deepEqual(errors(h), []);
  assert.equal(r.failed, null);
  assert.match(h.log[0].messages[0].content, /^PERSONA:Crow/);
  assert.deepEqual(h.calls.loads, ["crow.voice", "crow.voice"], "the cached miss was dropped and the row read again");
});

test("missing voice bot: ensured once, then the no-assistant path", async () => {
  const h = crowHarness({ rows: {} });
  for (let i = 0; i < 2; i++) {
    h.c.advance(60_000);   // past the bot cache
    await assert.doesNotReject(turn(h));
  }
  assert.equal(h.calls.ensured, 1);
  const errs = errors(h);
  assert.equal(errs.length, 2);
  for (const e of errs) assert.equal(e.code, "no_bound_bot");
});

test("ensure that throws is the no-assistant path", async () => {
  const h = crowHarness({ rows: {}, ensure: async () => { throw new Error("fast_model_required"); } });
  await assert.doesNotReject(turn(h));
  assert.equal(h.calls.ensured, 1);
  assert.deepEqual(errors(h).map((e) => e.code), ["no_bound_bot"]);
});

test("ensure is never called for a bot that is not the reserved voice bot", async () => {
  const h = crowHarness({ rows: {} });
  await turn(h, { botId: "household" });
  assert.equal(h.calls.ensured, 0);
  assert.deepEqual(errors(h).map((e) => e.code), ["no_bound_bot"]);
});

test("a disabled voice bot is the no-assistant path", async () => {
  const h = crowHarness({ rows: { "crow.voice": () => row(CROW, 0), household: HOUSE } });
  await turn(h);
  assert.deepEqual(errors(h).map((e) => e.code), ["no_bound_bot"]);
  assert.equal(h.log.length, 0, "no model was called");
});

test("escalation off never calls the router", async () => {
  const h = crowHarness({ route: "escalate", rows: { "crow.voice": { ...CROW, voice: { escalation: "off" } } } });
  const r = await turn(h, { transcript: "set a timer" });
  assert.equal(h.calls.routed.length, 0);
  assert.equal(r.route, "fast");
  assert.equal(r.escalated, false);
  const on = crowHarness({ route: "escalate", probe: () => true });
  const r2 = await turn(on, { transcript: "set a timer" });
  assert.equal(on.calls.routed.length, 1, "the default still asks the router");
  assert.equal(r2.escalated, true);
});

test("surface is recorded and unknown is kiosk", async () => {
  const cases = [["glasses", "glasses"], ["phone", "phone"], ["kiosk", "kiosk"], ["tv", "kiosk"], [undefined, "kiosk"]];
  for (const [surface, want] of cases) {
    const h = crowHarness();
    const r = await turn(h, surface === undefined ? {} : { surface });
    assert.equal(r.timings.surface, want, String(surface));
  }
});

test("a bot-defs change (deps.botDefsGeneration) drops the cached bot before the 30 s cache runs out", async () => {
  let gen = 0;
  let persona = "Crow";
  const h = crowHarness({ rows: { "crow.voice": () => row({ ...CROW, display_name: persona }) } });
  h.deps.botDefsGeneration = () => gen;
  await turn(h);
  persona = "Crow2";
  await turn(h);
  assert.match(h.log[1].messages[0].content, /^PERSONA:Crow\b/, "cached inside 30 s");
  gen++;
  await turn(h);
  assert.match(h.log[2].messages[0].content, /^PERSONA:Crow2/);
});

test("defaultVoiceDeps: the voice bot id, a real ensure, and one defs-changed subscription per process", async () => {
  const bus = (await import("../servers/shared/event-bus.js")).default;
  const { defaultVoiceDeps } = await import("../servers/gateway/voice/turn.js");
  const a = await defaultVoiceDeps();
  const n = bus.listenerCount("pibots:defs-changed");
  const b = await defaultVoiceDeps();
  assert.equal(bus.listenerCount("pibots:defs-changed"), n, "a second call does not subscribe again");
  assert.equal(a.voiceBotId, "crow.voice");
  assert.equal(typeof a.ensureVoiceBot, "function");
  const before = b.botDefsGeneration();
  bus.emit("pibots:defs-changed", { bot_id: "crow.voice" });
  assert.equal(a.botDefsGeneration(), before + 1);
});

// ── Task 1.5: a voice bot asks for a spoken yes before it deletes, changes or sends ──
const VOICE = { ...CROW, kind: "voice" };
const callRound = (tc) => [tc, { type: "done" }];
const sayRound = (text) => [{ type: "content_delta", text }, { type: "done" }];
const lastToolText = (h, i) => h.log[i].messages.at(-1).content;

test("a voice bot asks before a send", async () => {
  const send = { type: "tool_call", id: "s1", name: "gmail_send_to_self", arguments: { subject: "Milk", body: "Buy milk" } };
  const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["gmail_send_to_self"], rounds: [callRound(send), sayRound("Are you sure?"), callRound(send), sayRound("Sent.")] });
  await turn(h, { transcript: "email me a note to buy milk" });
  assert.deepEqual(h.calls.executed, [], "the first turn never runs the send");
  assert.match(lastToolText(h, 1), /Confirmation required/);
  await turn(h, { transcript: "yes" });
  assert.deepEqual(h.calls.executed, ["gmail_send_to_self"], "the yes with the same args runs it");
});

test("an ordinary bot is unaffected by the voice bot's spoken yes", async () => {
  const send = { type: "tool_call", id: "s1", name: "gmail_send_to_self", arguments: { subject: "Milk" } };
  const sched = { type: "tool_call", id: "c1", name: "crow_create_schedule", arguments: { task: "pipeline:botcron:writer", cron_expression: "0 9 * * *" } };
  const h = crowHarness({ chatTools: ["gmail_send_to_self", "crow_create_schedule"], rounds: [callRound(send), sayRound("Sent."), callRound(sched), sayRound("Scheduled.")] });
  await turn(h, { botId: "household", transcript: "email me" });
  assert.deepEqual(h.calls.executed, ["gmail_send_to_self"]);
  await turn(h, { botId: "household", transcript: "schedule the writer" });
  assert.deepEqual(h.calls.executed, ["gmail_send_to_self", "crow_create_schedule"]);
});

test("a voice bot's schedule create waits for the yes, direct or through the memory proxy", async () => {
  const direct = { type: "tool_call", id: "c1", name: "crow_create_schedule", arguments: { task: "Water the plants", cron_expression: "0 9 * * *" } };
  const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_create_schedule"], rounds: [callRound(direct), sayRound("Sure?"), callRound(direct), sayRound("Scheduled.")] });
  await turn(h, { transcript: "remind me to water the plants every morning" });
  assert.deepEqual(h.calls.executed, []);
  assert.match(lastToolText(h, 1), /Confirmation required/);
  await turn(h, { transcript: "yes" });
  assert.deepEqual(h.calls.executed, ["crow_create_schedule"]);

  const proxied = { type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "update_context_section", params: { section_key: "notes", content: "x" } } };
  const p = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_memory"], rounds: [callRound(proxied), sayRound("Sure?"), callRound(proxied), sayRound("Done.")] });
  await turn(p, { transcript: "change my notes", memoryOn: true });
  assert.deepEqual(p.calls.executed, []);
  assert.match(lastToolText(p, 1), /Confirmation required/);
  await turn(p, { transcript: "yes", memoryOn: true });
  assert.deepEqual(p.calls.executed, ["crow_memory"]);
});

test("a voice bot never schedules background bot work: a pipeline: task is refused and never executed", async () => {
  const direct = { type: "tool_call", id: "c1", name: "crow_create_schedule", arguments: { task: "pipeline:botcron:writer", cron_expression: "0 9 * * *" } };
  const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_create_schedule"], rounds: [callRound(direct), sayRound("I can't."), callRound(direct), sayRound("I can't.")] });
  await turn(h, { transcript: "have the writer run every morning" });
  assert.deepEqual(h.calls.executed, []);
  assert.doesNotMatch(lastToolText(h, 1), /Confirmation required/, "refused outright, never asked");
  assert.match(lastToolText(h, 1), /bot/i);
  await turn(h, { transcript: "yes" });
  assert.deepEqual(h.calls.executed, [], "a yes does not run it either");

  const proxied = { type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "update_schedule", params: { id: 3, task: "pipeline:botcron:writer" } } };
  const p = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_memory"], rounds: [callRound(proxied), sayRound("I can't.")] });
  await turn(p, { transcript: "move the writer job", memoryOn: true });
  assert.deepEqual(p.calls.executed, []);
  assert.doesNotMatch(lastToolText(p, 1), /Confirmation required/);
});

test("a Spanish yes confirms a pending send; a Spanish no declines it", async () => {
  const send = { type: "tool_call", id: "s1", name: "gmail_send_to_self", arguments: { subject: "Leche" } };
  for (const yes of ["sí", "Sí.", "sí, hazlo", "¡Sí!", "claro", "dale", "vale", "de acuerdo", "adelante", "si"]) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["gmail_send_to_self"], rounds: [callRound(send), sayRound("¿Seguro?"), callRound(send), sayRound("Enviado.")] });
    await turn(h, { transcript: "mándame un correo" });
    assert.deepEqual(h.calls.executed, [], yes);
    await turn(h, { transcript: yes });
    assert.deepEqual(h.calls.executed, ["gmail_send_to_self"], yes);
  }
  for (const no of ["no, espera", "espera", "cancela eso", "para"]) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["gmail_send_to_self"], rounds: [callRound(send), sayRound("¿Seguro?"), callRound(send), sayRound("Vale.")] });
    await turn(h, { transcript: "mándame un correo" });
    await turn(h, { transcript: no });
    assert.deepEqual(h.calls.executed, [], no);
  }
});

test("the remaining voice confirms: a context section add, a direct schedule update, a proxied schedule create", async () => {
  const cases = [
    ["crow_add_context_section", { type: "tool_call", id: "a1", name: "crow_add_context_section", arguments: { section_key: "notes", content: "x" } }],
    ["crow_update_schedule", { type: "tool_call", id: "u1", name: "crow_update_schedule", arguments: { id: 3, cron_expression: "0 8 * * *" } }],
    ["crow_memory", { type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "create_schedule", params: { task: "Water the plants", cron_expression: "0 9 * * *" } } }],
  ];
  for (const [tool, tc] of cases) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: [tool], rounds: [callRound(tc), sayRound("Sure?"), callRound(tc), sayRound("Done.")] });
    await turn(h, { transcript: "do the thing", memoryOn: true });
    assert.deepEqual(h.calls.executed, [], tool);
    assert.match(lastToolText(h, 1), /Confirmation required/, tool);
    await turn(h, { transcript: "yes", memoryOn: true });
    assert.deepEqual(h.calls.executed, [tool], tool);
  }
});

test("a voice bot never re-enables a schedule or creates a pipeline: one through the proxy: refused outright", async () => {
  const cases = [
    ["crow_memory", { type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "create_schedule", params: { task: "pipeline:botcron:writer", cron_expression: "0 9 * * *" } } }],
    ["crow_update_schedule", { type: "tool_call", id: "u1", name: "crow_update_schedule", arguments: { id: 3, enabled: true } }],
    ["crow_memory", { type: "tool_call", id: "m2", name: "crow_memory", arguments: { action: "update_schedule", params: { id: 3, enabled: true } } }],
  ];
  for (const [tool, tc] of cases) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: [tool], rounds: [callRound(tc), sayRound("I can't."), callRound(tc), sayRound("I can't.")] });
    await turn(h, { transcript: "turn the writer job back on", memoryOn: true });
    assert.deepEqual(h.calls.executed, [], JSON.stringify(tc.arguments));
    assert.doesNotMatch(lastToolText(h, 1), /Confirmation required/);
    await turn(h, { transcript: "yes", memoryOn: true });
    assert.deepEqual(h.calls.executed, [], "a yes does not run it either");
  }
  // An ordinary bot is unaffected.
  const tc = { type: "tool_call", id: "u1", name: "crow_update_schedule", arguments: { id: 3, enabled: true } };
  const o = crowHarness({ chatTools: ["crow_update_schedule"], rounds: [callRound(tc), sayRound("Done.")] });
  await turn(o, { botId: "household", transcript: "turn it back on" });
  assert.deepEqual(o.calls.executed, ["crow_update_schedule"]);
});

// ── final-review fixes ──────────────────────────────────────────────────────

test("a negated Spanish or English yes never confirms a pending delete, and declines it", async () => {
  const del = { type: "tool_call", id: "d1", name: "crow_delete_post", arguments: { id: 3 } };
  for (const no of ["claro que no", "Claro que no, no lo borres", "of course not", "yes, no wait"]) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_delete_post"], rounds: [callRound(del), sayRound("¿Seguro?"), callRound(del), sayRound("Vale.")] });
    await turn(h, { transcript: "borra el post 3" });
    await turn(h, { transcript: no });
    assert.deepEqual(h.calls.executed, [], no);
    assert.match(lastToolText(h, 3), /Confirmation required/, `${no}: still asks`);
  }
  for (const yes of ["sí", "claro", "dale", "yes please"]) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_delete_post"], rounds: [callRound(del), sayRound("¿Seguro?"), callRound(del), sayRound("Hecho.")] });
    await turn(h, { transcript: "borra el post 3" });
    await turn(h, { transcript: yes });
    assert.deepEqual(h.calls.executed, ["crow_delete_post"], yes);
  }
});

test("a voice bot's notification settings change waits for the yes, direct or through the memory proxy; a get does not", async () => {
  const cases = [
    ["crow_notification_settings", { type: "tool_call", id: "n1", name: "crow_notification_settings", arguments: { action: "set", types_enabled: ["reminder"] } }],
    ["crow_memory", { type: "tool_call", id: "n2", name: "crow_memory", arguments: { action: "notification_settings", params: { action: "set", types_enabled: [] } } }],
  ];
  for (const [tool, tc] of cases) {
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: [tool], rounds: [callRound(tc), sayRound("Sure?"), callRound(tc), sayRound("Done.")] });
    await turn(h, { transcript: "turn off my notifications", memoryOn: true });
    assert.deepEqual(h.calls.executed, [], tool);
    assert.match(lastToolText(h, 1), /Confirmation required/, tool);
    await turn(h, { transcript: "yes", memoryOn: true });
    assert.deepEqual(h.calls.executed, [tool], tool);
  }
  const get = { type: "tool_call", id: "n3", name: "crow_notification_settings", arguments: { action: "get" } };
  const g = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_notification_settings"], rounds: [callRound(get), sayRound("All on.")] });
  await turn(g, { transcript: "which notifications are on" });
  assert.deepEqual(g.calls.executed, ["crow_notification_settings"], "a read needs no yes");
  // An ordinary bot is unaffected.
  const set = cases[0][1];
  const o = crowHarness({ chatTools: ["crow_notification_settings"], rounds: [callRound(set), sayRound("Done.")] });
  await turn(o, { botId: "household", transcript: "turn off my notifications" });
  assert.deepEqual(o.calls.executed, ["crow_notification_settings"]);
});

test("the confirm question for a proxied schedule delete says delete and names the schedule", async () => {
  const tc = { type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "update_schedule", params: { id: 3, delete: true } } };
  const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_memory"], rounds: [callRound(tc), sayRound("Sure?")] });
  await turn(h, { transcript: "delete the plants reminder", memoryOn: true });
  assert.deepEqual(h.calls.executed, []);
  assert.match(lastToolText(h, 1), /Are you sure you want to delete schedule 3\?/);
});

test("the voice system message is byte-identical on two turns with different transcripts and per-turn context", async () => {
  const { generateSystemPrompt } = await import("../servers/gateway/ai/system-prompt.js");
  const { voiceBotDefinition } = await import("../servers/shared/voice-bot.js");
  const def = { ...voiceBotDefinition({ preset: "fast_local", fastKey: "crow-voice/qwen3.5-4b" }), bot_id: "crow.voice", display_name: "Crow" };
  const h = crowHarness({ rows: { "crow.voice": def }, rounds: [sayRound("Lisbon."), sayRound("Two timers.")] });
  h.deps.generateSystemPrompt = generateSystemPrompt;
  await turn(h, { transcript: "What is the capital of Portugal?", turnContext: "Open windows: none." });
  h.c.advance(5_000);
  await turn(h, { transcript: "How many timers are running?", turnContext: "Open windows: timer 1, timer 2." });
  assert.equal(h.log.length, 2);
  const s0 = h.log[0].messages[0], s1 = h.log[1].messages[0];
  assert.equal(s0.role, "system");
  assert.ok(s0.content.length > 0);
  assert.equal(s1.content, s0.content, "byte-identical system message");
  assert.ok(!/Open windows/.test(s0.content), "per-turn context never rides on the system message");
  assert.match(h.log[1].messages.at(-1).content, /timer 1, timer 2/, "it rides on the user message");
});

// ── security fix round ──────────────────────────────────────────────────────

test("security: notification settings ask unless every present action field is get (direct and proxied)", async () => {
  const ask = [
    ["crow_notification_settings", { action: "set" }],
    ["crow_notification_settings", { action: "get", params: { action: "set" } }],
    ["crow_notification_settings", { params: { action: "get" }, action: "set" }],
    ["crow_notification_settings", {}],
    ["crow_memory", { action: "notification_settings", params: { action: "set" } }],
    ["crow_memory", { action: "notification_settings", params: {} }],
  ];
  for (const [tool, args] of ask) {
    const tc = { type: "tool_call", id: "n1", name: tool, arguments: args };
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: [tool], rounds: [callRound(tc), sayRound("Sure?")] });
    await turn(h, { transcript: "change my notifications", memoryOn: true });
    assert.deepEqual(h.calls.executed, [], JSON.stringify(args));
    assert.match(lastToolText(h, 1), /Confirmation required/, JSON.stringify(args));
  }
  const free = [
    ["crow_notification_settings", { action: "get" }],
    ["crow_notification_settings", { action: "get", params: { action: "get" } }],
    ["crow_memory", { action: "notification_settings", params: { action: "get" } }],
  ];
  for (const [tool, args] of free) {
    const tc = { type: "tool_call", id: "n2", name: tool, arguments: args };
    const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: [tool], rounds: [callRound(tc), sayRound("All on.")] });
    await turn(h, { transcript: "which notifications are on", memoryOn: true });
    assert.deepEqual(h.calls.executed, [tool], JSON.stringify(args));
  }
});

test("security: a proxied call whose top-level and params values disagree is refused outright, never executed", async () => {
  const tc = { type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "update_schedule", id: 9, params: { id: 3, delete: true } } };
  const h = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_memory"], rounds: [callRound(tc), sayRound("I can't."), callRound(tc), sayRound("I can't.")] });
  await turn(h, { transcript: "change schedule 9", memoryOn: true });
  assert.deepEqual(h.calls.executed, []);
  assert.doesNotMatch(lastToolText(h, 1), /Confirmation required/, "refused, never asked");
  await turn(h, { transcript: "yes", memoryOn: true });
  assert.deepEqual(h.calls.executed, [], "a yes does not run it either");
  // Consistent values: the question describes params, and the yes runs it.
  const ok = { type: "tool_call", id: "m2", name: "crow_memory", arguments: { action: "update_schedule", id: 3, params: { id: 3, delete: true } } };
  const k = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_memory"], rounds: [callRound(ok), sayRound("Sure?"), callRound(ok), sayRound("Deleted.")] });
  await turn(k, { transcript: "delete schedule 3", memoryOn: true });
  assert.match(lastToolText(k, 1), /Are you sure you want to delete schedule 3\?/);
  await turn(k, { transcript: "yes", memoryOn: true });
  assert.deepEqual(k.calls.executed, ["crow_memory"]);
  // Direct calls are unchanged: described from their own args, never refused for a stray params object.
  const direct = { type: "tool_call", id: "u1", name: "crow_update_schedule", arguments: { id: 3, delete: true } };
  const dh = crowHarness({ rows: { "crow.voice": VOICE }, chatTools: ["crow_update_schedule"], rounds: [callRound(direct), sayRound("Sure?")] });
  await turn(dh, { transcript: "delete schedule 3" });
  assert.match(lastToolText(dh, 1), /Are you sure you want to delete schedule 3\?/);
  // An ordinary bot is unaffected by the voice-only refusal.
  const o = crowHarness({ chatTools: ["crow_memory"], rounds: [callRound(tc), sayRound("Done.")] });
  await turn(o, { botId: "household", transcript: "change schedule 9", memoryOn: true });
  assert.deepEqual(o.calls.executed, ["crow_memory"]);
});
