import { test } from "node:test";
import assert from "node:assert/strict";
import * as H from "../servers/gateway/voice/turn-helpers.js";

test("think gate (glasses :994-1025): leading <think> never reaches speech; partial tag is held; plain text passes", () => {
  const g = H.createThinkGate();
  assert.equal(g.feed("<thi"), "");
  assert.equal(g.feed("nk>plan the answer"), "");
  assert.equal(g.feed("</think>Hello"), "Hello");
  assert.equal(g.feed(" there."), " there.");
  const p = H.createThinkGate();
  assert.equal(p.feed("  Sure"), "  Sure");
  assert.equal(p.feed("<think>not a lead"), "<think>not a lead", "only a LEADING block is gated");
});

test("sentence chunker (glasses SENTENCE_END): splits on terminal punctuation + space or newline; flush sends the tail", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); });
  await c.push("Hi there. How are");
  await c.push(" you? Fine");
  assert.deepEqual(out, ["Hi there. ", "How are you? "]);
  await c.flush();
  assert.deepEqual(out, ["Hi there. ", "How are you? ", "Fine"]);
  await c.flush();
  assert.equal(out.length, 3, "second flush is a no-op");
});

test("confirm gate (glasses :186-225): first call confirms; same tool+args+affirmative within 60 s allows; anything else re-arms", () => {
  let t = 0;
  const g = H.createConfirmGate({ now: () => t });
  const call = { deviceId: "d", eff: "crow_delete_post", args: { id: 3 } };
  assert.equal(g.check({ ...call, transcript: "delete post 3" }), "confirm");
  t = 10_000;
  assert.equal(g.check({ ...call, transcript: "yes do it" }), "allow");
  assert.equal(g.check({ ...call, transcript: "yes" }), "confirm", "consumed; re-armed");
  t = 80_000;
  assert.equal(g.check({ ...call, transcript: "yes" }), "confirm", "expired after 60 s");
  assert.equal(g.check({ ...call, args: { id: 4 }, transcript: "yes" }), "confirm", "args changed");
  assert.equal(g.check({ deviceId: "other", eff: "crow_delete_post", args: { id: 4 }, transcript: "yes" }), "confirm", "per device");
});

test("isDestructiveTool matches the glasses list + regex", () => {
  for (const n of ["crow_delete_post", "crow_unpublish_post", "crow_remove_backend", "crow_dismiss_all_notifications", "crow_destroy_x"]) assert.ok(H.isDestructiveTool(n), n);
  for (const n of ["crow_create_post", "crow_wm", "", null]) assert.ok(!H.isDestructiveTool(n), String(n));
});

test("conversation store: 24-message cap, 15-min idle reset, system dropped, never starts on an orphan tool/assistant", () => {
  let t = 0;
  const s = H.createConvoStore({ now: () => t });
  const msgs = [{ role: "system", content: "x" }];
  for (let i = 0; i < 20; i++) msgs.push({ role: "user", content: "u" + i }, { role: "assistant", content: "", tool_calls: "[]" }, { role: "tool", content: "r" });
  msgs.push({ role: "user", content: "last" }, { role: "assistant", content: "ok" });
  // 62 non-system messages: the plain last-24 window would START on a tool result (index 38 = tool).
  s.save("d", msgs);
  const kept = s.get("d");
  assert.equal(kept.length, 23, "the orphan tool result at the window's head is trimmed");
  assert.equal(kept[0].role, "user");
  assert.equal(kept.at(-1).content, "ok");
  assert.ok(!kept.some((m) => m.role === "system"));
  t = 15 * 60 * 1000 + 1;
  assert.deepEqual(s.get("d"), []);
});

test("negotiatePcm: kokoro/openai 24 kHz raw; piper strips 44 bytes; edge has no PCM path", () => {
  assert.deepEqual(H.negotiatePcm("kokoro"), { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 });
  assert.equal(H.negotiatePcm("piper").stripHeaderBytes, 44);
  assert.equal(H.negotiatePcm("edge"), null);
});

test("pcmStream strips a header, passes the abort signal to synth, and yields nothing once aborted", async () => {
  const seen = [];
  const adapter = { async *synthesize(text, voice, opts) { seen.push(opts); yield Buffer.alloc(40, 1); yield Buffer.alloc(10, 2); yield Buffer.alloc(6, 3); } };
  const out = [];
  for await (const c of H.pcmStream(adapter, "hi", "v", { synthFormat: undefined, stripHeaderBytes: 44 })) out.push(c);
  assert.equal(Buffer.concat(out).length, 12);
  const live = new AbortController();
  for await (const c of H.pcmStream(adapter, "hi", "v", H.negotiatePcm("kokoro"), { signal: live.signal })) out.push(c);
  assert.equal(seen.at(-1).signal, live.signal, "the abort signal reaches the provider call");
  assert.equal(seen.at(-1).format, "pcm");
  const ac = new AbortController(); ac.abort();
  const calls = seen.length;
  const none = [];
  for await (const c of H.pcmStream(adapter, "hi", "v", H.negotiatePcm("kokoro"), { signal: ac.signal })) none.push(c);
  assert.equal(none.length, 0);
  assert.equal(seen.length, calls, "an already-aborted turn never calls the provider");
});

test("wrapPcmAsWav writes a 44-byte RIFF header for 16 kHz mono s16", () => {
  const w = H.wrapPcmAsWav(Buffer.alloc(320), 16000);
  assert.equal(w.length, 364);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(40), 320);
});

test("smoke 2026-10-04 lever 3: firstClauseEnd — a clause of 3+ words, a sentence, or 8 complete words; never inside 1,000 or 3:30", () => {
  const cut = (s) => { const e = H.firstClauseEnd(s); return e < 0 ? null : s.slice(0, e); };
  assert.equal(cut("Lisbon is the capital, and "), "Lisbon is the capital, ");
  assert.equal(cut("Sure, "), null, "a 1-word clause waits (no lone 'Sure,' with a falling tone)");
  assert.equal(cut("Sure, Lisbon is the capital. It"), "Sure, Lisbon is the capital. ", "then the sentence end wins");
  assert.equal(cut("It costs 1,000 dollars and "), null, "a number comma is not a clause");
  assert.equal(cut("The meeting is at 3:30 today and it will "), "The meeting is at 3:30 today and it ", "8 complete words");
  assert.equal(cut("one two three four five six seven eight"), null, "the 8th word may still be growing");
  assert.equal(cut("The answer is simple — it is "), "The answer is simple — ");
  assert.equal(cut("First of all; the "), "First of all; ");
  assert.equal(cut("A leap year has 366 days. It "), "A leap year has 366 days. ");
  assert.equal(cut("Hi."), null, "no trailing space: the sentence may continue (3.5)");
});

test("smoke 2026-10-04 lever 3: chunker with firstClause splits once, then sentences; the default (glasses) is unchanged", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); }, { firstClause: true });
  for (const t of ["Lisbon", " is", " the", " capital", " of", " Portugal,", " a", " city", " by", " the", " sea.", " It", " is", " old,", " and", " lovely"]) await c.push(t);
  await c.flush();
  assert.deepEqual(out, ["Lisbon is the capital of Portugal, ", "a city by the sea. ", "It is old, and lovely"]);
  const g = [];
  const d = H.createSentenceChunker(async (s) => { g.push(s); });
  await d.push("Lisbon is the capital, a city. It");
  await d.flush();
  assert.deepEqual(g, ["Lisbon is the capital, a city. ", "It"]);
});

test("review I2/M8/M9: leading whitespace never uses up the first-clause split; a dash is not a word; CLAUSE_END has no shared /g state", async () => {
  const out = [];
  const c = H.createSentenceChunker(async (s) => { out.push(s); }, { firstClause: true });
  await c.push("\n\n");
  await c.push("Lisbon is the capital, and a city by the sea. It is old.");
  await c.flush();
  assert.deepEqual(out.map((s) => s.trim()), ["Lisbon is the capital,", "and a city by the sea.", "It is old."]);
  assert.equal(H.firstClauseEnd("Okay — sure, "), -1, "'Okay — sure,' is two words: wait");
  assert.equal(H.firstClauseEnd("The ratio is 3 - 2 and "), -1, "a spaced hyphen is not a clause break");
  assert.equal(H.CLAUSE_END.global, false);
});

test("a negation in the first words is never a yes, and always a no (claro que no, of course not, yes no)", () => {
  for (const t of ["claro que no", "Claro que no, no lo borres", "of course not", "yes, no wait", "Yes no", "sí, pero no", "dale, nunca", "ok don't", "yeah, dont", "claro, tampoco", "yes never mind", "of course not!"]) {
    assert.equal(H.isAffirmative(t), false, `${t}: not a yes`);
    assert.equal(H.isNegative(t), true, `${t}: a no`);
  }
  for (const t of ["sí", "Sí.", "claro", "dale", "yes please", "yes do it", "vale", "de acuerdo", "ok"]) {
    assert.equal(H.isAffirmative(t), true, `${t}: a yes`);
    assert.equal(H.isNegative(t), false, `${t}: not a no`);
  }
  for (const t of ["no", "nope", "no, espera", "cancel", "para", "never mind"]) assert.equal(H.isNegative(t), true, t);
  // A negation late in a long yes does not undo it (only the first few words count).
  assert.equal(H.isAffirmative("yes go ahead and delete the one that is no longer needed"), true);
});

test("the confirm gate never allows a pending delete on a negated yes", () => {
  for (const no of ["claro que no", "Claro que no, no lo borres", "of course not", "yes, no wait"]) {
    let t = 0;
    const g = H.createConfirmGate({ now: () => t });
    const call = { deviceId: "d", eff: "crow_delete_post", args: { id: 3 } };
    assert.equal(g.check({ ...call, transcript: "delete post 3" }), "confirm");
    t = 1000;
    assert.equal(g.check({ ...call, transcript: no }), "confirm", no);
  }
  for (const yes of ["sí", "claro", "dale", "yes please"]) {
    let t = 0;
    const g = H.createConfirmGate({ now: () => t });
    const call = { deviceId: "d", eff: "crow_delete_post", args: { id: 3 } };
    g.check({ ...call, transcript: "delete post 3" });
    t = 1000;
    assert.equal(g.check({ ...call, transcript: yes }), "allow", yes);
  }
});

test("the confirm question names what happens: proxied args are read, a schedule delete says delete", () => {
  const d = H.describeDestructiveAction;
  assert.equal(d({ name: "crow_update_schedule", arguments: { id: 3, delete: true } }), "delete schedule 3");
  const P = { via: "crow_memory" };
  assert.equal(d({ name: "crow_update_schedule", arguments: { action: "update_schedule", params: { id: 3, delete: true } } }, P), "delete schedule 3");
  assert.equal(d({ name: "crow_update_schedule", arguments: { action: "update_schedule", params: { id: 3, cron_expression: "0 8 * * *" } } }, P), "update schedule 3");
  assert.equal(d({ name: "crow_delete_memory", arguments: { action: "delete_memory", params: { id: 12 } } }, P), "delete memory 12");
  assert.equal(d({ name: "crow_update_context_section", arguments: { action: "update_context_section", params: { section_key: "notes" } } }, P), "update context section notes");
  assert.equal(d({ name: "crow_delete_post", arguments: { id: 3 } }), "delete post 3", "the direct form is unchanged");
  assert.equal(d({ name: "crow_delete_post", arguments: {} }), "delete post");
});

test("security: a proxied call is described ONLY from params (what the executor runs); a direct one only from its own args", () => {
  const d = H.describeDestructiveAction;
  // The executor runs a category proxy with args.params alone: a top-level id or delete is never what runs.
  assert.equal(d({ name: "crow_update_schedule", arguments: { action: "update_schedule", id: 9, params: { id: 3, delete: true } } }, { via: "crow_memory" }), "delete schedule 3");
  assert.equal(d({ name: "crow_update_schedule", arguments: { action: "update_schedule", id: 9, delete: true, params: { id: 3 } } }, { via: "crow_memory" }), "update schedule 3");
  // A direct tool gets its args as they are; a stray params object is not what runs.
  assert.equal(d({ name: "crow_update_schedule", arguments: { id: 3, params: { id: 9, delete: true } } }), "update schedule 3");
});

test("security: proxyArgsConflict flags a described field whose top-level and params values disagree", () => {
  const c = (args) => H.proxyArgsConflict({ name: "crow_memory", arguments: args });
  assert.equal(c({ action: "update_schedule", id: 9, params: { id: 3, delete: true } }), true);
  assert.equal(c({ action: "update_schedule", delete: false, params: { id: 3, delete: true } }), true);
  assert.equal(c({ action: "update_context_section", section_key: "a", params: { section_key: "b" } }), true);
  assert.equal(c({ action: "create_schedule", task: "x", params: { task: "pipeline:botcron:writer" } }), true);
  assert.equal(c({ action: "update_schedule", id: 3, params: { id: 3, delete: true } }), false, "the same value is consistent");
  assert.equal(c({ action: "update_schedule", params: { id: 3, delete: true } }), false);
  assert.equal(c({ action: "update_schedule", id: 9, params: {} }), true, "a top-level value the run never sees is a disagreement (round 2)");
  assert.equal(H.isProxyCall({ name: "crow_memory", arguments: { action: "x" } }), true);
  assert.equal(H.isProxyCall({ name: "crow_memory", arguments: {} }), false);
  assert.equal(H.isProxyCall({ name: "crow_update_schedule", arguments: { action: "x" } }), false);
});

// ── security fix round 2: crow_tools is a proxy too ─────────────────────────

test("security 2: crow_tools is described from what handleExternalTool runs (params, the arguments unwrap, the flat fallback)", () => {
  const d = H.describeDestructiveAction;
  const ct = (args) => ({ name: "trello_delete_card", arguments: args });
  assert.equal(H.isProxyCall({ name: "crow_tools", arguments: { action: "trello_delete_card" } }), true);
  assert.equal(d(ct({ action: "trello_delete_card", params: { id: 5 } }), { via: "crow_tools" }), "trello delete card 5", "the regression shape names id 5");
  assert.equal(d(ct({ action: "trello_delete_card", params: { arguments: { id: 7 } } }), { via: "crow_tools" }), "trello delete card 7", "the arguments unwrap");
  assert.equal(d(ct({ action: "trello_delete_card", id: 8 }), { via: "crow_tools" }), "trello delete card 8", "the flat fallback, as the local executor runs it");
  assert.deepEqual(H.executedProxyArgs({ name: "crow_tools", arguments: { action: "x", params: { arguments: { id: 7 }, note: "n" } } }), { id: 7 });
  assert.deepEqual(H.executedProxyArgs({ name: "crow_tools", arguments: { action: "x", params: { arguments: { id: 7 }, a: 1, b: 2 } } }), { arguments: { id: 7 }, a: 1, b: 2 }, "more than two keys: no unwrap");
  assert.deepEqual(H.executedProxyArgs({ name: "crow_memory", arguments: { action: "x", id: 9, params: { id: 3 } } }), { id: 3 });
});

test("security 2: the conflict check covers crow_tools and every layer; \"3\" and 3 agree", () => {
  const c = (args, name = "crow_tools") => H.proxyArgsConflict({ name, arguments: args });
  assert.equal(c({ action: "trello_delete_card", id: 9, params: { id: 5 } }), true, "the spoof shape");
  assert.equal(c({ action: "trello_delete_card", params: { id: 9, arguments: { id: 5 } } }), true, "params beside the unwrapped arguments");
  assert.equal(c({ action: "trello_delete_card", params: { id: 5 } }), false);
  assert.equal(c({ action: "trello_delete_card", id: 5, params: { id: 5 } }), false);
  assert.equal(c({ action: "trello_delete_card", id: 8 }), false, "the flat fallback runs the top-level values");
  assert.equal(c({ action: "update_schedule", id: "3", params: { id: 3, delete: true } }, "crow_memory"), false, "\"3\" and 3 are the same id");
  assert.equal(c({ action: "update_schedule", id: "4", params: { id: 3 } }, "crow_memory"), true, "a true disagreement is still one");
  assert.equal(H.reliesOnFlatFallback({ name: "crow_tools", arguments: { action: "x", id: 8 } }), true);
  assert.equal(H.reliesOnFlatFallback({ name: "crow_tools", arguments: { action: "x", params: { id: 8 } } }), false);
  assert.equal(H.reliesOnFlatFallback({ name: "crow_memory", arguments: { action: "x", id: 8 } }), false);
});

test("security 2: one proxy matcher — tool-executor uses the shared one", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/ai/tool-executor.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /crow_\(memory\|projects/, "no second copy of the category regex in the executor");
  const helpers = readFileSync(new URL("../servers/gateway/voice/turn-helpers.js", import.meta.url), "utf8");
  assert.doesNotMatch(helpers, /crow_\(memory\|projects/, "nor in turn-helpers");
  const shared = await import("../servers/gateway/ai/proxy-args.js");
  assert.ok(shared.CATEGORY_PROXY_RE.test("crow_memory") && !shared.CATEGORY_PROXY_RE.test("crow_tools"));
});
