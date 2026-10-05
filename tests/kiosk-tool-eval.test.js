import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CASES, FIXTURE, judge, matches, sampleCalls, make } from "../scripts/kiosk-eval/cases.mjs";
import { HELD_OUT } from "../scripts/kiosk-eval/held-out.mjs";
import { createProductDisplay, singleToolDefinition, toSingle, fromSingle, PERSONA, HISTORY } from "../scripts/kiosk-eval/product.mjs";
import { preflight, runTurn, runAll, MAX_ATTEMPTS, shippedCase } from "../scripts/kiosk-eval/run.mjs";
import { verdict, summarize, paired, signTestP, SIGN_ALPHA, FLOORS } from "../scripts/kiosk-eval/report.mjs";
import { displayTurnOptions } from "../bundles/kiosk/server/runtime.js";
import { buildToolDefinitions, WM_VERBS, MEDIA_VERBS, SHOW_KINDS } from "../bundles/kiosk/server/tools.js";

/** A scripted model: plan(n, tools, opts) → [{ name, args }] to call, or a string to say. */
function scripted(plan) {
  let n = 0;
  const seen = [];
  return {
    seen,
    async *chatStream(messages, tools, opts) {
      n += 1;
      seen.push({ tools: tools.map((t) => t.name), choice: opts?.toolChoice ?? null, last: messages.at(-1).content, system: messages[0].content, messages: messages.length });
      const out = plan(n, tools, opts);
      if (typeof out === "string") yield { type: "content_delta", text: out };
      else for (const [i, c] of out.entries()) yield { type: "tool_call", id: `c${n}_${i}`, name: c.name, arguments: c.args };
      yield { type: "done" };
    },
  };
}
const NOTHING = async () => ({ named: false, required: false, engine: "llamacpp" });
const NAMED = async () => ({ named: true, required: true, engine: "vllm" });
const display = (c, arm, chat, forcing = NOTHING) => (o) => createProductDisplay({ ...o, chat, forcing });
/** A model that makes exactly the case's sample calls (all in its first round), then says a closing sentence. */
const perfect = (c, arm) => scripted((n) => (n === 1 && c.expect ? sampleCalls(c).map((x) => (arm === "single" ? toSingle(x) : x)) : "All set."));

test("40 utterances: unique ids c01–c40, 32 en + 8 es, four open-card title cases, four no-call cases", () => {
  assert.equal(CASES.length, 40);
  assert.deepEqual(CASES.map((c) => c.id), Array.from({ length: 40 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`));
  assert.equal(CASES.filter((c) => c.lang === "es").length, 8);
  assert.equal(CASES.filter((c) => [].concat(c.expect || []).some((w) => w.notTitle || w.sameTitle)).length, 4);
  assert.equal(CASES.filter((c) => c.expect === null).length, 4);
  for (const c of CASES) assert.ok(typeof c.say === "string" && c.say.length > 5 && c.say.length <= 120, c.id);
});

test("the product's own gates, on every utterance: the tool it needs is OFFERED, and no no-model path answers it", async () => {
  const must = [];
  for (const c of CASES) {
    const d = createProductDisplay({ surface: "four", chat: scripted(() => "x"), forcing: NOTHING, state: c.state || {}, lang: c.lang });
    const g = d.gates(c.say);
    for (const w of [].concat(c.expect || [])) assert.ok(g.offered.includes(w.tool), `${c.id}: ${w.tool} is not offered for "${c.say}" (offered: ${g.offered.join(", ") || "nothing"})`);
    assert.equal(await d.fastPaths(c.say), null, `${c.id}: a no-model path answered an utterance that is meant for the model`);
    // A plain question: with a window open (revision 4) the two display tools, never required; with none, crow_wm at most.
    if (c.expect === null) {
      const allowed = c.state?.windows?.length ? ["crow_show", "crow_wm"] : ["crow_wm"];
      assert.deepEqual(g.offered.filter((t) => !allowed.includes(t)), [], `${c.id}: a plain question is offered ${allowed.join(" + ")} at most`);
      assert.equal(g.must, null, `${c.id}: nothing is required of a plain question`);
    }
    if (g.must) must.push(`${c.id}:${g.must.replace("crow_", "")}`);
  }
  // Which utterances the product REQUIRES a call on (text held, forced where the engine allows). The report states these counts.
  assert.deepEqual(must, [
    "c01:play", "c02:play", "c03:play", "c04:play", "c05:play", "c06:play", "c07:play", "c08:play", "c09:play", "c10:play",
    "c11:open", "c12:open", "c13:open", "c15:open", "c16:open",
    "c17:show", "c18:show", "c19:show", "c20:show", "c21:show", "c22:show", "c23:show", "c24:show", "c25:show", "c26:show", "c27:show", "c28:show", "c29:show", "c30:show",
  ]);
});

test("every utterance can be completed through the product, on both arms: the sample calls give a correct turn", async () => {
  for (const c of CASES) for (const arm of ["four", "single"]) {
    const chat = perfect(c, arm);
    const row = await runTurn(c, arm, display(c, arm, chat));
    assert.equal(row.ok, true, `${c.id}/${arm}: ${JSON.stringify({ tools: row.tools, calls: row.calls, failed: row.failed })}`);
    assert.equal(row.offered_expected, true);
    if (row.must) assert.equal(row.must_done, true, `${c.id}/${arm}`);
  }
});

test("a model that only talks: plain questions are correct; every must-run utterance ends on the could-not line (wrong, and truthful); the rest are wrong", async () => {
  for (const c of CASES) for (const arm of ["four", "single"]) {
    const row = await runTurn(c, arm, display(c, arm, scripted(() => "Sure, that is done.")));
    assert.equal(row.ok, c.expect === null, `${c.id}/${arm}`);
    if (row.must) assert.deepEqual([row.must_done, row.failed, row.requests], [false, "display_missed", 2], `${c.id}/${arm}: the claim is never the ending`);
    assert.equal(summarize([{ ...row, id: c.id, trial: 0, set: "main", arm }]).untruthful.length, 0);
  }
});

test("the forcing rule is the product's: an engine that honours a named choice gets one on a must-run utterance, and only then", async () => {
  const c19 = CASES.find((c) => c.id === "c19"), c37 = CASES.find((c) => c.id === "c37"), c31 = CASES.find((c) => c.id === "c31");
  const a = perfect(c19, "four");
  const row = await runTurn(c19, "four", display(c19, "four", a, NAMED));
  assert.deepEqual([a.seen[0].tools, a.seen[0].choice, row.tool_choice, row.requests], [["crow_show"], { name: "crow_show" }, "named", 1]);
  const s = perfect(c19, "single");
  await runTurn(c19, "single", display(c19, "single", s, NAMED));
  assert.deepEqual([s.seen[0].tools, s.seen[0].choice], [["crow_do"], { name: "crow_do" }], "the control is forced by the same rule");
  const p = perfect(c37, "four");
  await runTurn(c37, "four", display(c37, "four", p, NAMED));
  assert.deepEqual([p.seen[0].tools, p.seen[0].choice], [["crow_show", "crow_wm"], null], "a plain question with a card up: offered, never forced");
  const k = perfect(c31, "four");
  const r31 = await runTurn(c31, "four", display(c31, "four", k, NAMED));
  assert.equal(k.seen[0].choice, null, "a compound request is never narrowed or forced");
  assert.equal(r31.ok, true);
  assert.equal(r31.requests, 2, "both results went back to the model, which finished the sentence");
});

test("the request is a real assistant's: persona, saved history, the memory tool under the product's rule, the turn's own context lines", async () => {
  const c27 = CASES.find((c) => c.id === "c27"), c29 = CASES.find((c) => c.id === "c29"), c31 = CASES.find((c) => c.id === "c31");
  const a = perfect(c27, "four");
  await runTurn(c27, "four", display(c27, "four", a));
  assert.ok(a.seen[0].system.startsWith(PERSONA) && /shared home display/.test(a.seen[0].system));
  assert.equal(a.seen[0].messages, 1 + HISTORY.length + 1);
  assert.match(a.seen[0].last, /^\[Now\] .*\n\[Display\] Open windows: 1 card\.\n\nNow show me a list of three vegetables\.$/, "new content: counts only, no title to copy");
  const b = perfect(c29, "four");
  await runTurn(c29, "four", display(c29, "four", b));
  assert.match(b.seen[0].last, /The card "Fruits" now says: one; two\./);
  const k = perfect(c31, "four");
  await runTurn(c31, "four", display(c31, "four", k));
  assert.match(k.seen[0].last, /Paused: Morning Mix \(radio\)\./);
  const mem = scripted(() => "You told me it was maple.");
  const d = createProductDisplay({ surface: "four", chat: mem, forcing: NOTHING });
  await d.ask("What did I tell you about the wifi?");
  assert.deepEqual(mem.seen[0].tools, ["crow_memory"], "memory is offered when the words ask for it");
  const plain = scripted((n) => (n === 1 ? [{ name: "crow_memory", args: { action: "search_memories" } }] : "Lisbon."));
  const row = await runTurn(CASES.find((c) => c.id === "c37"), "four", display(null, "four", plain));
  assert.deepEqual([row.ok, row.tools], [true, ["crow_memory:not_offered"]], "and a memory call on a plain question is refused, not run");
});

test("judging: the end result, not the wording — a refused call put right is correct; an extra action, a wrong title, a failed turn are wrong", async () => {
  const c19 = CASES.find((c) => c.id === "c19"), c27 = CASES.find((c) => c.id === "c27"), c29 = CASES.find((c) => c.id === "c29"), c21 = CASES.find((c) => c.id === "c21");
  const retry = scripted((n) => (n === 1 ? [{ name: "crow_show", args: { kind: "list", title: "<title>", body: "x" } }] : [{ name: "crow_show", args: c19.expect.sample }]));
  assert.equal((await runTurn(c19, "four", display(c19, "four", retry))).ok, true);
  const reuse = scripted(() => [{ name: "crow_show", args: { kind: "list", title: "Fruits", body: "carrot\npea" } }]);
  assert.equal((await runTurn(c27, "four", display(c27, "four", reuse))).ok, false, "a new subject under the open card's title");
  const other = scripted((n) => (n === 1 ? [{ name: "crow_show", args: { kind: "list", title: "Groceries", body: "grapes" } }] : "Added."));
  const r29 = await runTurn(c29, "four", display(c29, "four", other));
  assert.deepEqual([r29.ok, r29.failed], [false, "display_missed"]);
  const wrongTime = scripted(() => [{ name: "crow_show", args: { kind: "timer", title: "Pasta", body: "12 minutes" } }]);
  assert.equal((await runTurn(c21, "four", display(c21, "four", wrongTime))).ok, false, "a timer of the wrong length");
  assert.equal(judge(c19, { calls: [{ tool: "crow_show", args: c19.expect.sample, result: { ok: true, outcome: "shown" } }], spoken: "Here's Three fruits.", failed: "error" }), false);
  assert.equal(judge(c19, { calls: [{ tool: "crow_show", args: c19.expect.sample, result: { ok: true, outcome: "shown" } }], spoken: "x", other: ["crow_memory"] }), false);
  assert.equal(matches(c19.expect, { tool: "crow_show", args: c19.expect.sample, result: { ok: false, outcome: "invalid" } }), false, "a call that did not execute is not a match");
  assert.deepEqual(fromSingle(toSingle({ name: "crow_show", args: { kind: "list", title: "A", body: "b\nc" } }).args), { name: "crow_show", args: { kind: "list", title: "A", body: "b\nc" } });
});

test("the descriptions do not contain the answers: no example in a tool description appears in any utterance or sample, and the control has an example per verb", () => {
  const four = buildToolDefinitions({ windows: FIXTURE.windows, sources: FIXTURE.sources, items: FIXTURE.items, verbs: [...WM_VERBS, ...MEDIA_VERBS] });
  const single = singleToolDefinition({ sources: FIXTURE.sources, items: FIXTURE.items, verbs: [...WM_VERBS, ...MEDIA_VERBS], kinds: SHOW_KINDS });
  const quoted = (d) => [...d.description.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const hay = [...CASES, ...HELD_OUT].flatMap((c) => [c.say, ...[].concat(c.expect || []).flatMap((w) => Object.values(w.sample || {}))]).join("\n").toLowerCase();
  const structural = new Set(["auto", "list", "close", "play", "open", "show", "launcher"]);   // enumeration values, not content
  for (const d of [...four, single]) for (const ex of quoted(d)) {
    for (const part of ex.split(/\\n|\n|\|/).map((x) => x.trim()).filter((x) => x.length > 3 && !structural.has(x))) assert.ok(!hay.includes(part), `${d.name}: the example ${JSON.stringify(part)} is in the evaluation set`);
  }
  for (const verb of ["play", "open", "show", "close"]) assert.match(single.description, new RegExp(`do "${verb}"`), `the control has an example for ${verb}`);
  assert.equal(four.filter((d) => /Example:/.test(d.description)).length, 3, "crow_play, crow_show and crow_wm carry one example each; crow_open's list is its own example");
});

test("the held-out set: empty until the main session writes it; then 20 utterances h01–h20 in the same shape, none of them in the 40", () => {
  assert.ok(HELD_OUT.length === 0 || HELD_OUT.length === 20, "all twenty or none");
  const said = new Set(CASES.map((c) => c.say.toLowerCase()));
  HELD_OUT.forEach((c, i) => {
    assert.equal(c.id, `h${String(i + 1).padStart(2, "0")}`);
    assert.ok(["en", "es"].includes(c.lang) && typeof c.say === "string" && c.say.length > 5 && c.say.length <= 120 && !said.has(c.say.toLowerCase()), c.id);
    for (const w of [].concat(c.expect || [])) assert.ok(["crow_play", "crow_open", "crow_show", "crow_wm"].includes(w.tool) && w.sample, c.id);
  });
  assert.equal(typeof make.show, "function");
});

test("a failed request is not a wrong answer: the turn is retried, then the run stops with no verdict; a vanished model stops it at once", async () => {
  const c = CASES.find((x) => x.id === "c19");
  let fail = 2;
  const flaky = { async *chatStream() { if (fail > 0) { fail -= 1; throw new Error("ECONNRESET"); } yield { type: "tool_call", id: "a", name: "crow_show", arguments: c.expect.sample }; yield { type: "done" }; } };
  const rows = [], logs = [];
  const base = { sets: [["main", [c]]], trials: 1, check: async () => ({ ok: true, engine: "vllm" }), write: (r) => rows.push(r), pause: async () => {}, log: (m) => logs.push(m) };
  const ok = await runAll({ ...base, make: (o) => createProductDisplay({ ...o, chat: o.surface === "four" ? flaky : perfect(c, "single"), forcing: NOTHING }) });
  assert.deepEqual([ok.aborted, rows.length, rows.every((r) => r.ok)], [undefined, 2, true], "two failures, then the answer: scored on the answer");
  assert.equal(logs.length, 2);
  rows.length = 0;
  const dead = { async *chatStream() { throw new Error("ETIMEDOUT"); } };
  const stop = await runAll({ ...base, make: (o) => createProductDisplay({ ...o, chat: dead, forcing: NOTHING }) });
  assert.match(stop.aborted, new RegExp(`failed ${MAX_ATTEMPTS} times`));
  assert.equal(rows.length, 0, "no row is written for a turn that never got an answer");
  let listed = true;
  const gone = await runAll({ ...base, check: async () => ({ ok: listed }), make: (o) => { listed = false; return createProductDisplay({ ...o, chat: dead, forcing: NOTHING }); } });
  assert.match(gone.aborted, /went away/);
});

test("the run interleaves the arms per utterance, writes each row as it exists, and resumes without repeating", async () => {
  const list = CASES.filter((c) => ["c19", "c37", "c32"].includes(c.id));
  const order = [];
  const mk = (o) => createProductDisplay({ ...o, chat: scripted(() => "Okay."), forcing: NOTHING });
  const base = { sets: [["main", list]], trials: 2, make: mk, check: async () => ({ ok: true }), pause: async () => {} };
  await runAll({ ...base, write: (r) => order.push(r.key) });
  assert.deepEqual(order.slice(0, 6).map((k) => k.split("|").slice(1).join("/")), ["c19/four", "c19/single", "c32/single", "c32/four", "c37/four", "c37/single"]);
  assert.equal(order.length, 12);
  const again = [];
  await runAll({ ...base, done: new Set(order.slice(0, 7)), write: (r) => again.push(r.key) });
  assert.deepEqual(again, order.slice(7));
});

test("the runner never forces with required, talks only to the model server, and sends nothing to a server that does not list the model", async () => {
  const src = readFileSync(new URL("../scripts/kiosk-eval/run.mjs", import.meta.url), "utf8") + readFileSync(new URL("../scripts/kiosk-eval/product.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /["']required["']/);
  assert.doesNotMatch(src, /llm\/v1/, "never a gateway route");
  const sent = [];
  const listed = async (url) => { sent.push(url); return new Response(JSON.stringify({ data: [{ id: "small", owned_by: "vllm" }] })); };
  assert.deepEqual(await preflight({ baseUrl: "http://203.0.113.9:8000/v1", model: "small", fetchImpl: listed }), { ok: true, engine: "vllm" });
  assert.deepEqual(await preflight({ baseUrl: "http://203.0.113.9:8000/v1", model: "other", fetchImpl: listed }), { ok: false, reason: "not_resident" });
  assert.deepEqual(await preflight({ baseUrl: "http://203.0.113.9:8000/v1", model: "small", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), { ok: false, reason: "not_resident" });
  assert.ok(sent.every((u) => u.endsWith("/models")), "preflight only reads the model list");
});

test("verdict: a paired sign test per model and set (stop only when four tools are worse beyond chance), an absolute floor per model, the held-out set; an incomplete run has no verdict", () => {
  const rows = ({ four, single, heldFour = 54, heldSingle = 54, trials = 3, forced = null, untruthful = 0, offered = 20 }) => {
    const out = [];
    for (let t = 0; t < trials; t += 1) for (let i = 0; i < 60; i += 1) for (const arm of ["four", "single"]) {
      const set = i < 40 ? "main" : "held";
      const idx = set === "main" ? t * 40 + i : t * 20 + (i - 40);
      const good = set === "main" ? (arm === "four" ? four : single) : (arm === "four" ? heldFour : heldSingle);
      const must = i % 2 === 0;
      const bad = arm === "four" && must && set === "main" && untruthful > out.filter((r) => r.must && !r.must_done && r.failed === null).length;
      out.push({ key: `${t}|x${i}|${arm}`, trial: t, id: `x${i}`, set, arm, ok: idx < good, must, must_done: must && !bad, failed: null, offered_expected: set === "main" || i - 40 < offered,
        tool_choice: must ? (forced === null ? "none" : "named") : null, requests: must && forced !== null && idx >= forced ? 2 : 1, corrected: false, tools: [] });
    }
    return out;
  };
  const rep = (label, o) => ({ label, engine: label === "quick" ? "vllm" : "llamacpp", rows: rows(o) });
  // The sign test itself.
  assert.equal(signTestP(0, 0), 1);
  assert.ok(Math.abs(signTestP(0, 3) - 0.125) < 1e-9, "three disagreeing pairs, all against four tools: p = 1/8");
  assert.ok(signTestP(0, 12) < 0.001 && signTestP(5, 5) > 0.5);
  const pr = paired(rows({ four: 100, single: 103 }), "main");
  assert.deepEqual([pr.pairs, pr.better, pr.worse], [120, 0, 3]);
  const good = verdict([rep("quick", { four: 100, single: 101, forced: 200 }), rep("larger", { four: 110, single: 112 })]);
  assert.deepEqual([good.pass, good.complete, good.gates.filter((g) => !g.pass)], [true, true, []]);
  assert.match(good.gates.find((g) => /quick: four tools against one, the 40/.test(g.id)).detail, /difference -0\.8 points; of 120 pairs four was right alone on 0, wrong alone on 1/);
  assert.equal(verdict([rep("quick", { four: 100, single: 103, forced: 200 }), rep("larger", { four: 110, single: 110 })]).pass, true, "three worse in 120 is within chance: not a stop");
  const worse = verdict([rep("quick", { four: 100, single: 112, forced: 200 }), rep("larger", { four: 110, single: 110 })]);
  assert.equal(worse.pass, false, "twelve worse and none better is beyond chance");
  assert.match(worse.gates.find((g) => !g.pass).id, /quick: four tools against one, the 40/);
  assert.equal(verdict([rep("quick", { four: 100, single: 100, forced: 200 }), rep("larger", { four: 110, single: 110, heldFour: 40, heldSingle: 54 })]).pass, false, "the held-out set decides too");
  const floor = verdict([rep("quick", { four: 80, single: 80, forced: 200 }), rep("larger", { four: 110, single: 110 })]);
  assert.equal(floor.pass, false, "equal arms, but under the quick model's floor");
  assert.deepEqual(floor.gates.filter((g) => !g.pass).map((g) => g.id), [`quick: the four-tool arm is right on at least ${FLOORS.quick} of the 40`]);
  assert.equal(verdict([rep("quick", { four: 100, single: 100, forced: 200 }), rep("larger", { four: 90, single: 90 })]).pass, false, `the larger model has its own floor (${FLOORS.larger})`);
  assert.equal(SIGN_ALPHA, 0.025);
  assert.equal(verdict([rep("quick", { four: 100, single: 100, forced: 200, offered: 16 }), rep("larger", { four: 110, single: 110, offered: 16 })]).pass, false, "the product must offer the right tool on 17 of the 20 held out");
  const lie = verdict([rep("quick", { four: 100, single: 100, forced: 200, untruthful: 1 }), rep("larger", { four: 110, single: 110 })]);
  assert.equal(lie.pass, false);
  assert.match(lie.gates.find((g) => !g.pass).id, /ended on a claim/);
  assert.equal(verdict([rep("quick", { four: 100, single: 100, forced: 10 }), rep("larger", { four: 110, single: 110 })]).pass, false, "forced calls that do not arrive in the first request");
  const one = verdict([rep("quick", { four: 110, single: 100, forced: 200 })]);
  assert.deepEqual([one.pass, one.complete], [false, false]);
  assert.match(one.missing.join(" "), /larger model did not run/);
  const noHeld = verdict([{ label: "quick", rows: rows({ four: 100, single: 100, forced: 200 }).filter((r) => r.set === "main") }, rep("larger", { four: 110, single: 110 })]);
  assert.equal(noHeld.complete, false, "no verdict until the held-out set has been written and run");
  const withShipped = verdict([rep("quick", { four: 100, single: 100, forced: 200 }), rep("larger", { four: 110, single: 110 }), { label: "shipped", rows: rows({ four: 10, single: 100 }) }]);
  assert.equal(withShipped.pass, true, "the shipped leg is reported, never gated");
});

// ── WM1a revision 3 ──────────────────────────────────────────────────────────────────────────────
test("an empty answer or one cut at the token limit is a FAILED request, retried like one — never scored as a wrong answer", async () => {
  const c = CASES.find((x) => x.id === "c19");
  for (const bad of [
    { async *chatStream() { yield { type: "done", usage: { output_tokens: 0 } }; } },
    { async *chatStream(m, t, opts) { yield { type: "content_delta", text: "Sure, here is a very long" }; yield { type: "done", usage: { output_tokens: opts.maxTokens } }; } },
  ]) {
    const row = await runTurn(c, "four", (o) => createProductDisplay({ ...o, chat: bad, forcing: NOTHING }));
    assert.ok(row.errors.length > 0 && /empty completion|token limit/.test(row.errors[0]), JSON.stringify(row.errors));
    const rows = [];
    const res = await runAll({ sets: [["main", [c]]], trials: 1, make: (o) => createProductDisplay({ ...o, chat: bad, forcing: NOTHING }), check: async () => ({ ok: true }), write: (r) => rows.push(r), pause: async () => {} });
    assert.match(res.aborted, new RegExp(`failed ${MAX_ATTEMPTS} times`));
    assert.equal(rows.length, 0);
  }
});

test("one set of turn options: the evaluation runs the runtime's own displayTurnOptions, and the shipped leg sees the shipped surface", async () => {
  const src = readFileSync(new URL("../scripts/kiosk-eval/product.mjs", import.meta.url), "utf8");
  assert.match(src, /displayTurnOptions\(ctx,/);
  assert.doesNotMatch(src, /displayPromptSuffix|matchClockFastPath|kioskNowContext/, "nothing the runtime builds is rebuilt by hand");
  const d = createProductDisplay({ surface: "four", chat: scripted(() => "x"), forcing: NOTHING });
  assert.match(d.options.promptSuffix, /see, time, follow, open or play something/, "the fixture display has every tool");
  const ship = createProductDisplay({ surface: "four", chat: scripted(() => "x"), forcing: NOTHING, shipped: true });
  assert.match(ship.options.promptSuffix, /see, time or follow something;/);
  assert.deepEqual(ship.options.extraTools.map((t) => t.definition.name), ["crow_show", "crow_wm"]);
  const shippedIds = CASES.filter(shippedCase).map((c) => c.id);
  assert.deepEqual(shippedIds, ["c17", "c18", "c19", "c20", "c21", "c22", "c23", "c24", "c25", "c26", "c27", "c28", "c29", "c30", "c32", "c35", "c37", "c38", "c40"]);
  for (const c of CASES.filter(shippedCase)) {
    const row = await runTurn(c, "four", (o) => createProductDisplay({ ...o, chat: perfect(c, "four"), forcing: NOTHING, shipped: true }));
    assert.equal(row.ok, true, `${c.id} can be completed on the shipped surface`);
  }
  const same = displayTurnOptions({ store: d.store, deviceId: "x", caps: FIXTURE.caps, lang: "en", sources: [], items: [], emit: () => {} }, { settings: { lang: "en" } });
  assert.equal(same.promptSuffix, ship.options.promptSuffix, "the same function, the same text");
});

test("displayTurnOptions: onToolResult is passed through to the voice turn unchanged, and the display tools are never wrapped by it", async () => {
  const store = createProductDisplay({ surface: "four", chat: scripted(() => "x"), forcing: NOTHING }).store;
  const ctx = { store, deviceId: "otr", caps: FIXTURE.caps, lang: "en", sources: [], items: [], emit: () => {} };
  const hook = async () => "replaced";
  const withHook = displayTurnOptions(ctx, { settings: { lang: "en" }, onToolResult: hook });
  const without = displayTurnOptions(ctx, { settings: { lang: "en" } });
  assert.equal(withHook.onToolResult, hook);
  assert.equal("onToolResult" in without, false);
  assert.deepEqual(withHook.extraTools.map((t) => Object.keys(t).sort()), without.extraTools.map((t) => Object.keys(t).sort()), "the same display tools, not wrapped");
  const show = withHook.extraTools.find((x) => x.definition.name === "crow_show");
  assert.equal(JSON.parse(await show.execute({ kind: "list", title: "Fruits", body: "a\nb" }, { transcript: "Show me a list of fruits." })).outcome, "shown", "a display result is never replaced");
});

// ── Revision 5: the rerun's guards and the scorer's timer rule ──────────────────────────────────
import { heldOutSpent, outGuard } from "../scripts/kiosk-eval/run.mjs";
import { HELD_OUT_R1 } from "../scripts/kiosk-eval/held-out-r1.mjs";

test("the spent run-1 set is kept verbatim, a run refuses while HELD_OUT is (or overlaps) it, and a new set must not overlap the rule tests' examples", () => {
  assert.equal(HELD_OUT_R1.length, 20);
  assert.equal(heldOutSpent(HELD_OUT_R1, HELD_OUT_R1), true);
  assert.equal(heldOutSpent([{ say: "Something brand new to say." }], HELD_OUT_R1), false);
  assert.equal(heldOutSpent([], HELD_OUT_R1), false);
  const rules = readFileSync(new URL("../tests/kiosk-offer-rules.test.js", import.meta.url), "utf8").toLowerCase();
  if (!heldOutSpent()) {
    for (const c of HELD_OUT) {
      assert.ok(!HELD_OUT_R1.some((s) => s.say.toLowerCase() === c.say.toLowerCase()), `${c.id} is a spent utterance`);
      assert.ok(!rules.includes(c.say.toLowerCase()), `${c.id} is an example in the rule tests`);
    }
  }
});

test("a rerun writes into a NEW file: an existing non-empty output is refused unless --resume", () => {
  const fs = { exists: (f) => f === "/x/old.jsonl" || f === "/x/empty.jsonl", read: (f) => (f === "/x/old.jsonl" ? '{"header":true}\n' : "") };
  assert.match(outGuard("/x/old.jsonl", false, fs), /exists and is not empty/);
  assert.equal(outGuard("/x/old.jsonl", true, fs), null);
  assert.equal(outGuard("/x/empty.jsonl", false, fs), null);
  assert.equal(outGuard("/x/new.jsonl", false, fs), null);
});

test("scorer: a change to an open timer that leaves a SECOND timer of that name is wrong; the product changes the one timer", async () => {
  const c = { id: "t1", lang: "en", state: { windows: [make.timer("Bread")] }, say: "Better make that eight minutes instead.", expect: make.show("timer", { title: "Bread", body: "8 minutes" }, { sameTitle: "Bread" }) };
  const call = { tool: "crow_show", args: { kind: "timer", title: "Bread", body: "8 minutes" }, result: { ok: true, outcome: "updated" } };
  assert.equal(judge(c, { calls: [call], spoken: "Okay.", windows: [{ kind: "timer", title: "Bread" }, { kind: "timer", title: "Bread" }] }), false);
  assert.equal(judge(c, { calls: [call], spoken: "Okay.", windows: [{ kind: "timer", title: "Bread" }] }), true);
  const chat = scripted((n) => (n === 1 ? [{ name: "crow_show", args: { kind: "timer", title: "Bread", body: "8 minutes" } }] : "Done."));
  const row = await runTurn(c, "four", (o) => createProductDisplay({ ...o, chat, forcing: NOTHING }));
  assert.equal(row.ok, true, JSON.stringify(row.calls));
});

test("report: plain questions asked with a window open that changed the screen anyway are counted (reported, not gated)", () => {
  const rows = [
    { set: "main", arm: "four", trial: 0, id: "a", ok: false, plain: true, window_open: true, changed: true, offered_expected: true, tools: [], must: false },
    { set: "main", arm: "four", trial: 0, id: "b", ok: true, plain: true, window_open: true, changed: false, offered_expected: true, tools: [], must: false },
    { set: "main", arm: "single", trial: 0, id: "a", ok: false, plain: true, window_open: true, changed: true, offered_expected: true, tools: [], must: false },
  ];
  assert.deepEqual(summarize(rows).plain_window, { total: 2, changed: 1 });
});
