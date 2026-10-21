/**
 * Pending confirmations (PR 2, Task 2.2): the per-device pending store, the yes/no matcher built on
 * PR 1's isAffirmative/isNegative, and a pending entry turning the voice turn into an action turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPendingStore, matchYesNo, HANDOFF_PROPOSAL_TTL_MS } from "../servers/gateway/voice/pending.js";
import { NOT_DONE_TEXT } from "../servers/gateway/voice/turn.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";

test("the default TTL is the plan constant", () => {
  assert.equal(HANDOFF_PROPOSAL_TTL_MS, 120_000);
});

test("pending: set, get within the TTL, null past it; take removes; clear removes", () => {
  let t = 1_000;
  const p = createPendingStore({ now: () => t, ttlMs: 10_000 });
  p.set("dev-a", { kind: "routine", tool: "crow_reminder_add" });
  const e = p.get("dev-a");
  assert.equal(e.kind, "routine");
  assert.equal(e.tool, "crow_reminder_add");
  assert.equal(e.at, 1_000, "stamped when set");
  t += 10_000;
  assert.ok(p.get("dev-a"), "still there at exactly the TTL");
  t += 1;
  assert.equal(p.get("dev-a"), null, "gone past the TTL");
  assert.equal(p.get("dev-a"), null, "and dropped");
  p.set("dev-a", { kind: "handoff", bot: "writer" });
  assert.equal(p.take("dev-a").bot, "writer");
  assert.equal(p.get("dev-a"), null, "take removed it");
  assert.equal(p.take("dev-a"), null);
  p.set("dev-b", { kind: "stop" });
  p.clear("dev-b");
  assert.equal(p.get("dev-b"), null);
  assert.equal(p.get("nobody"), null);
});

test("pending: the default TTL applies and a take past it is null", () => {
  let t = 0;
  const p = createPendingStore({ now: () => t });
  p.set("d", { kind: "which" });
  t += HANDOFF_PROPOSAL_TTL_MS + 1;
  assert.equal(p.take("d"), null);
});

test("pending: devices are separate and an entry is a copy", () => {
  const p = createPendingStore({ now: () => 5 });
  const entry = { kind: "routine", args: { title: "x" } };
  p.set("a", entry);
  entry.kind = "stop";
  assert.equal(p.get("a").kind, "routine");
  assert.equal(p.get("b"), null);
});

test("matchYesNo: the listed cases (adapted to the one yes/no rule)", () => {
  assert.equal(matchYesNo("Yes please."), "yes");
  assert.equal(matchYesNo("sí, hazlo"), "yes");
  assert.equal(matchYesNo("yes go ahead and have it start right now please"), "yes");
  assert.equal(matchYesNo("yes but give it to helper", { otherBots: ["helper"] }), null);
  assert.equal(matchYesNo("no thanks"), "no");
  // Controller ruling 1: no length cap on a no; a negation up front is a no.
  assert.equal(matchYesNo("no, give it to helper instead please", { otherBots: ["helper"] }), "no");
  assert.equal(matchYesNo("what's the weather"), null);
});

test("matchYesNo: lead-in words are stripped before matching", () => {
  assert.equal(matchYesNo("hey, yes"), "yes");
  assert.equal(matchYesNo("so yeah do it"), "yes");
  assert.equal(matchYesNo("hey crow, yes please"), "yes");
  assert.equal(matchYesNo("oye, sí"), "yes");
  assert.equal(matchYesNo("bueno, dale"), "yes");
  assert.equal(matchYesNo("Crow, no"), "no");
  assert.equal(matchYesNo("okay, cancel"), "no", "ok before a no is a lead-in, not a yes");
  assert.equal(matchYesNo("okay what's the weather"), null, "ok before a question is not a yes");
  assert.equal(matchYesNo("ok"), "yes", "a bare ok is a yes");
  assert.equal(matchYesNo("okay"), "yes");
  assert.equal(matchYesNo("hey"), null);
});

test("matchYesNo: a yes that names another bot or a new target is not a plain yes", () => {
  assert.equal(matchYesNo("yes, have writer do it", { otherBots: ["writer", "helper"] }), null);
  // Fix round 1 ruling: a bare action verb is not a correction (only a new target is).
  assert.equal(matchYesNo("yes, and add milk to the list"), "yes");
  assert.equal(matchYesNo("yes but send it to my sister"), null);
  assert.equal(matchYesNo("sí, pero pásale esto a helper", { otherBots: ["helper"] }), null);
  assert.equal(matchYesNo("yes", { otherBots: ["writer"] }), "yes");
  assert.equal(matchYesNo("yes, writer", { otherBots: ["Writer"] }), null, "bot names compare without case");
});

test("matchYesNo: PR 1's negation window holds (a negated yes is a no)", () => {
  assert.equal(matchYesNo("claro que no"), "no");
  assert.equal(matchYesNo("yes, no wait"), "no");
  assert.equal(matchYesNo("never mind"), "no");
  assert.equal(matchYesNo("cancela"), "no");
  assert.equal(matchYesNo(""), null);
  assert.equal(matchYesNo(undefined), null);
});

const sayRound = (t) => [{ type: "content_delta", text: t }, { type: "done" }];

test("a pending entry makes the turn an action turn", async () => {
  // Task 3.5 adds the hand-off claim patterns ("Writer's on it!"); until then a claim claimsAction already reads.
  const h = harness({ rounds: [sayRound("Done, I've set that up for you. ")] });
  h.deps.voiceActions = { turnContext: () => ({ text: "[Pending] A reminder at noon, waiting for a yes.", pending: true }) };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hmm maybe later", sink: h.sink });
  assert.deepEqual(h.calls.spoken, [NOT_DONE_TEXT]);
  assert.equal(r.timings.claim_blocked, true);
  assert.equal(r.timings.action_guard, true);
});

test("no pending entry: the same reply is heard as is", async () => {
  const h = harness({ rounds: [sayRound("Done, I've set that up for you. ")] });
  h.deps.voiceActions = { turnContext: () => ({ text: "", pending: false }) };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hmm maybe later", sink: h.sink });
  assert.equal(r.timings.claim_blocked, undefined);
  assert.deepEqual(h.calls.spoken, ["Done, I've set that up for you."]);
});

test("afterTurn gets the device and the tool names the turn called, also on a failed turn", async () => {
  const seen = [];
  const h = harness({ rounds: [[{ type: "tool_call", id: "c1", name: "crow_projects", arguments: {} }, { type: "done" }], sayRound("Here you go. ")] });
  h.deps.voiceActions = { afterTurn: (a) => seen.push(a) };
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "list my projects", sink: h.sink });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].device.id, h.device.id);
  assert.deepEqual(seen[0].calledTools, ["crow_projects"]);
  const h2 = harness();
  const seen2 = [];
  h2.deps.createChatAdapter = async () => { throw new Error("boom"); };
  h2.deps.voiceActions = { afterTurn: (a) => seen2.push(a) };
  await h2.runner.runVoiceTurn({ db: {}, device: h2.device, transcript: "hello there", sink: h2.sink });
  assert.equal(seen2.length, 1, "called in finally");
  assert.deepEqual(seen2[0].calledTools, []);
});

test("a voiceActions fast path gets the turn's facts, tz included, and wins over opts.fastPaths", async () => {
  const got = [];
  const h = harness();
  h.deps.voiceActions = { fastPath: async (a) => { got.push(a); return { say: "Okay, cancelled.", verb: "pending_no" }; } };
  let legacy = 0;
  const r = await h.runner.runVoiceTurn({ db: { tag: 1 }, device: h.device, transcript: "no", sink: h.sink, surface: "phone", lang: "es", tz: "America/Chicago", fastPaths: async () => { legacy++; return { say: "x" }; } });
  assert.equal(legacy, 0);
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "pending_no");
  assert.deepEqual(h.calls.chatKeys, []);
  assert.equal(got.length, 1);
  const a = got[0];
  assert.equal(a.transcript, "no");
  assert.equal(a.surface, "phone");
  assert.equal(a.lang, "es");
  assert.equal(a.tz, "America/Chicago");
  assert.equal(a.device.id, h.device.id);
  assert.equal(a.db.tag, 1);
  assert.equal(a.bot.bot_id, "household");
  assert.equal(typeof a.executor?.executeToolCalls, "function");
});

test("a voiceActions fast path that returns null falls through to opts.fastPaths, then the model", async () => {
  const h = harness();
  h.deps.voiceActions = { fastPath: async () => null };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "pause", sink: h.sink, fastPaths: async () => ({ say: "Paused.", verb: "pause" }) });
  assert.equal(r.timings.verb, "pause");
  const h2 = harness();
  h2.deps.voiceActions = { fastPath: async () => null };
  await h2.runner.runVoiceTurn({ db: {}, device: h2.device, transcript: "What is the capital of Portugal?", sink: h2.sink });
  assert.equal(h2.calls.chatKeys.length, 1);
});

// ── fix round 1 ─────────────────────────────────────────────────────────────

test("fix 1: a yes with a verb and only a pronoun object is a yes; a correction names a new target", () => {
  for (const t of ["yes, add it", "yes delete it", "yes, send it", "sí, bórralo", "yes schedule it", "yes, change it"]) assert.equal(matchYesNo(t), "yes", t);
  assert.equal(matchYesNo("yes but give it to helper", { otherBots: ["helper"] }), null);
  assert.equal(matchYesNo("yes, send it to helper instead"), null);
  assert.equal(matchYesNo("yes, but rather tomorrow"), null);
  assert.equal(matchYesNo("sí, pero mejor a helper"), null);
  assert.equal(matchYesNo("sí, dáselo a beta"), null);
  assert.equal(matchYesNo("sí, en vez de eso mañana"), null);
});

test("fix 4: a leading ¡ does not stop the lead-in stripping", () => {
  assert.equal(matchYesNo("¡oye, sí!"), "yes");
  assert.equal(matchYesNo("¡Bueno, no!"), "no");
});

test("fix 2: a throwing voiceActions.fastPath never stops pause", async () => {
  const h = harness();
  h.deps.voiceActions = { fastPath: async () => { throw new Error("boom"); } };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "pause", sink: h.sink, fastPaths: async () => ({ say: "Paused.", verb: "pause" }) });
  assert.equal(r.timings.verb, "pause");
  assert.equal(r.failed, null);
  assert.ok(h.calls.logs.some((m) => /voice actions/.test(m)));
});

test("fix 2: a throwing createToolExecutor ahead of the fast paths never stops pause", async () => {
  const h = harness();
  h.deps.createToolExecutor = () => { throw new Error("no executor"); };
  const got = [];
  h.deps.voiceActions = { fastPath: async (a) => { got.push(a); return null; } };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "pause", sink: h.sink, fastPaths: async () => ({ say: "Paused.", verb: "pause" }) });
  assert.equal(r.timings.verb, "pause");
  assert.equal(got[0].executor, null);
});

test("fix 2: a throwing turnContext leaves the model turn running", async () => {
  const h = harness();
  h.deps.voiceActions = { turnContext: () => { throw new Error("ctx boom"); } };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "What is the capital of Portugal?", sink: h.sink });
  assert.equal(r.failed, null);
  assert.equal(h.calls.chatKeys.length, 1);
  assert.deepEqual(h.calls.spoken, ["Lisbon is the capital."]);
});

test("fix 4: a turnContext that returns a Promise is logged and ignored", async () => {
  const h = harness();
  h.deps.voiceActions = { turnContext: async () => ({ text: "[Pending] x", pending: true }) };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "What is the capital of Portugal?", sink: h.sink });
  assert.equal(r.failed, null);
  assert.ok(!h.log[0].messages.at(-1).content.includes("[Pending] x"));
  assert.equal(r.timings.action_guard, undefined);
  assert.ok(h.calls.logs.some((m) => /turnContext/.test(m)));
});

test("fix 4: with no bot row, fastPath gets bot null and executor null, and pause works", async () => {
  const h = harness();
  h.deps.loadBotRow = async () => null;
  const got = [];
  h.deps.voiceActions = { fastPath: async (a) => { got.push(a); return null; } };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "pause", sink: h.sink, fastPaths: async () => ({ say: "Paused.", verb: "pause" }) });
  assert.equal(got.length, 1);
  assert.equal(got[0].bot, null);
  assert.equal(got[0].executor, null);
  assert.equal(r.timings.verb, "pause");
});

test("matchYesNo: 'but' / 'pero' with more words after is a correction, not a yes", () => {
  assert.equal(matchYesNo("yes, but at four"), null);
  assert.equal(matchYesNo("sí, pero a las cuatro"), null);
  assert.equal(matchYesNo("yes"), "yes");
  assert.equal(matchYesNo("sí"), "yes");
  assert.equal(matchYesNo("no, but thanks"), "no");
});

test("matchYesNo: 'mejor', 'make it', 'at' and 'a las' with more words are a correction", () => {
  assert.equal(matchYesNo("sí, mejor mañana"), null);
  assert.equal(matchYesNo("yes, make it four"), null);
  assert.equal(matchYesNo("yes, at four"), null);
  assert.equal(matchYesNo("sí, a las cuatro"), null);
  assert.equal(matchYesNo("yes, but at five"), null);
  // Still a plain yes.
  for (const t of ["yes", "sí", "yes please", "sure", "yes, add it", "yes, make it", "sí, mejor"]) assert.equal(matchYesNo(t), "yes", t);
});
