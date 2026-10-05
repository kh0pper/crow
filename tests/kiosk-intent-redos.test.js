/**
 * Every matcher that reads a spoken transcript (or a model-written display command) must
 * run in time linear in a SHORT, capped input. The time/date shortcut used to be one RegExp
 * of the shape ^(?:(?:lead|lead|…) )*(?:core|…)(?: (?:tail|…))*$ whose lead-ins overlap
 * ("hey crow" is also "hey" + "crow"): 24 repeats of "hey crow " plus a mismatch took a
 * quarter of a second, doubling every repeat. It is now a word-list comparison.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchClockFastPath, CLOCK_PHRASES } from "../bundles/kiosk/server/clock.js";
import { wantsDisplay, wantsNewDisplay, newDisplayKind, parseKioskCommand, matchWmFastPath, createWmStore, isPlaceholderText } from "../bundles/kiosk/server/wm.js";
import { wantsMemory } from "../bundles/kiosk/server/memory-intent.js";
import { INTENT_MAX_CHARS, intentText } from "../bundles/kiosk/server/intent-text.js";

const store = createWmStore({ setTimer: () => ({}), clearTimer: () => {} });
const MATCHERS = {
  matchClockFastPath: (s) => matchClockFastPath(s, { now: 0, tz: "UTC" }),
  wantsDisplay, wantsNewDisplay, newDisplayKind, wantsMemory,
  matchWmFastPath: (s) => matchWmFastPath(s, store, "d", null),
  parseKioskCommand, isPlaceholderText, intentText,
};
const BUDGET_MS = 50;
/** CPU time of one call, in ms (user + system: not fooled by a busy machine's wall clock). */
function cpuMs(fn) { const a = process.cpuUsage(); fn(); const d = process.cpuUsage(a); return (d.user + d.system) / 1000; }

const RUNS = [" ", "what ", "a ", "hey crow ", "ok ", "okay ", "so and um ", "show me ", "put ", "set a ", "timer ", "remember ", "what s my ", "que ", "oye crow ", "por favor ", "display a | ", "|", "| ", "<a", "recipe a | b | ", "timer 1 minute ", "1 ", "\n", "á", "’"];
const TAILS = ["", "!", " x", " what time is it", " zzz what time is it now please x", " | <title>"];

test("adversarial input: 50,000-repeat runs, with and without a trailing mismatch — every matcher answers well inside 50 ms of CPU time", () => {
  for (const [name, fn] of Object.entries(MATCHERS)) {
    fn("warm up what time is it");
    for (const run of RUNS) {
      for (const tail of TAILS) {
        const input = run.repeat(50_000) + tail;
        const ms = cpuMs(() => fn(input));
        assert.ok(ms < BUDGET_MS, `${name} took ${ms.toFixed(1)} ms on ${JSON.stringify(run)} × 50,000 + ${JSON.stringify(tail)}`);
      }
    }
  }
});

test("adversarial input UNDER the length cap: overlapping lead-ins and tails cannot blow up (the flagged pattern doubled per repeat)", () => {
  const cases = [];
  for (const unit of ["hey crow ", "ok crow ", "okay ok ", "so and ", "oye crow ", "por favor crow ", "hey crow hey ok okay so and um uh well "]) {
    const n = Math.floor((INTENT_MAX_CHARS - 40) / unit.length);
    for (const tail of ["x", "what time is it x", "what time is", "que hora es x", "the", ""]) cases.push(unit.repeat(n) + tail);
  }
  for (const tail of ["now ", "please ", "right now ", "today ", "for today ", "por favor ", "hoy "]) {
    const n = Math.floor((INTENT_MAX_CHARS - 40) / tail.length);
    cases.push("what time is it " + tail.repeat(n) + "x", "whats the date " + tail.repeat(n) + "tomorrow", "x " + tail.repeat(n));
  }
  for (const input of cases) {
    assert.ok(input.length <= INTENT_MAX_CHARS, "the case is inside the cap");
    for (const [name, fn] of Object.entries(MATCHERS)) {
      const ms = cpuMs(() => fn(input));
      assert.ok(ms < BUDGET_MS, `${name} took ${ms.toFixed(1)} ms on ${JSON.stringify(input.slice(0, 60))}… (${input.length} chars)`);
    }
    assert.equal(matchClockFastPath(input, { now: 0, tz: "UTC" }), null, `not a clock question: ${input.slice(0, 40)}…`);
  }
});

test("the length cap: an utterance longer than the cap is never a shortcut, and the intent matchers read only its first part", () => {
  assert.ok(INTENT_MAX_CHARS >= 200 && INTENT_MAX_CHARS <= 600, "a few hundred characters");
  const long = "what time is it" + " ".repeat(INTENT_MAX_CHARS);
  assert.equal(matchClockFastPath(long, { now: 0, tz: "UTC" }), null);
  assert.equal(matchWmFastPath("close all" + " ".repeat(INTENT_MAX_CHARS), store, "d", null), null);
  assert.equal(intentText("A".repeat(10_000)).length, INTENT_MAX_CHARS);
  assert.equal(intentText("  Show   ME, the list!  "), "show me the list");
  assert.equal(intentText(null), "");
  assert.equal(intentText({ toString() { throw new Error("no"); } }), "");
  const pad = "blah ".repeat(INTENT_MAX_CHARS);
  assert.equal(wantsDisplay(`show me the list ${pad}`), true, "intent at the start is seen");
  assert.equal(wantsDisplay(`${pad} show me the list`), false, "text past the cap is not read");
  assert.equal(wantsMemory(`remember the milk ${pad}`), true);
  assert.equal(wantsMemory(`${pad} remember the milk`), false);
  assert.equal(wantsNewDisplay(`${pad} show me the list`), false);
});

test("the clock matcher has no pattern built from the phrase table: it compares word lists", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../bundles/kiosk/server/clock.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /new RegExp\(/, "no generated regular expression");
  assert.doesNotMatch(src, /\)\*|\)\+|\*\)|\+\)/, "no quantified group");
  // …and still answers everything the table lists, with lead-ins and tails in any number.
  for (const [key, t] of Object.entries(CLOCK_PHRASES)) {
    for (const core of t.cores) {
      const q = `${t.leads.slice(0, 3).join(" ")} ${core} ${t.tails.slice(0, 2).join(" ")}`;
      assert.ok(matchClockFastPath(q, { now: 0, tz: "UTC" }), `${key}: ${q}`);
    }
  }
});

test("a display command is parsed without a slow pattern, and behaves as before", () => {
  const big = "display " + "x ".repeat(3000) + "| " + "y ".repeat(3000);
  assert.ok(cpuMs(() => parseKioskCommand(big)) < BUDGET_MS);
  assert.deepEqual(parseKioskCommand("display Shopping list | milk, eggs").window.title, "Shopping list");
  assert.equal(parseKioskCommand("display Notes | a || b").window.blocks.length, 3, "a double bar is a paragraph break, not the title bar");
  assert.equal(parseKioskCommand("display one || two").window.title, "Info", "no single bar: no title");
  assert.equal(parseKioskCommand("display Plan |first, then second").window.title, "Plan");
  assert.equal(parseKioskCommand("display | text only").window.title, "Info");
  assert.equal(parseKioskCommand("display " + "z".repeat(20_000)).op, "open", "an over-long command is cut, not refused");
});
