/**
 * PR-A (audit item 5) — the combined multi-question ask card's PURE logic.
 *
 * `buildAskScript` compiles a combined card's structured answers into the
 * ordered `select`/`input` responses that drive pi-lab ask-user.ts's
 * `runTuiFlow` to completion. These strings must match ask-user.ts BYTE FOR
 * BYTE (U+2026 ellipsis, U+2014 em-dash, U+2500 box-drawing) or the child's
 * `rows.indexOf(choice)` misses — which, in a multi-select, loops forever.
 *
 * No DB, no engine, no spawn: this file pins the pure contract. The engine's
 * dance integration (notify → combined card → replay) lives in
 * tests/perch-interactive.test.js. The child-side replica these strings are
 * validated against end-to-end is /tmp/pr-a-prototype/dance.mjs (prototype).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASK_OTHER,
  askOptionRow,
  askDoneRow,
  buildAskScript,
} from "../servers/gateway/perch-interactive.js";

const opt = (label, description) => (description === undefined ? { label } : { label, description });

// ---------------------------------------------------------------------------
// byte-exact constants (drift here silently wedges a live child)
// ---------------------------------------------------------------------------

test("ask constants are byte-identical to pi-lab ask-user.ts", () => {
  // OTHER = "Other…" with U+2026 HORIZONTAL ELLIPSIS (e2 80 a6)
  assert.equal(ASK_OTHER, "Other\u2026");
  assert.equal(Buffer.from(ASK_OTHER, "utf8").toString("hex"), "4f74686572e280a6");
  // optionRow separator = " — " with U+2014 EM DASH (e2 80 94)
  assert.equal(askOptionRow(opt("L", "D")), "L \u2014 D");
  assert.equal(Buffer.from(askOptionRow(opt("L", "D")), "utf8").toString("hex"), "4c20e280942044");
  // no description → bare label, no separator
  assert.equal(askOptionRow(opt("L")), "L");
  // checked marks
  assert.equal(askOptionRow(opt("L"), true), "[x] L");
  assert.equal(askOptionRow(opt("L"), false), "[ ] L");
  assert.equal(askOptionRow(opt("L"), undefined), "L");
  // done row = "── done (n selected) ──" with U+2500 BOX DRAWINGS LIGHT (e2 94 80) ×2
  assert.equal(askDoneRow(2), "\u2500\u2500 done (2 selected) \u2500\u2500");
  assert.equal(askDoneRow(0), "\u2500\u2500 done \u2500\u2500");
  assert.equal(Buffer.from(askDoneRow(0).slice(0, 2), "utf8").toString("hex"), "e29480e29480");
});

// ---------------------------------------------------------------------------
// single-select
// ---------------------------------------------------------------------------

test("single-select: a chosen label emits ONE bare row response", () => {
  const q = [{ question: "Which?", options: [opt("a", "first"), opt("b")] }];
  const script = buildAskScript(q, [{ selected: ["b"], other: null }]);
  assert.deepEqual(script, [{ method: "select", value: "b" }]);
});

test("single-select: a chosen label WITH description emits 'label — desc'", () => {
  const q = [{ question: "Which?", options: [opt("a", "first"), opt("b")] }];
  const script = buildAskScript(q, [{ selected: ["a"], other: null }]);
  assert.deepEqual(script, [{ method: "select", value: "a \u2014 first" }]);
});

test("single-select: Other free-text emits select(OTHER) then input(text)", () => {
  const q = [{ question: "Which?", options: [opt("a")] }];
  const script = buildAskScript(q, [{ selected: [], other: "custom" }]);
  assert.deepEqual(script, [
    { method: "select", value: ASK_OTHER },
    { method: "input", value: "custom" },
  ]);
});

test("single-select: Other text is trimmed", () => {
  const q = [{ question: "Which?", options: [opt("a")] }];
  const script = buildAskScript(q, [{ selected: [], other: "  padded  " }]);
  assert.deepEqual(script[1], { method: "input", value: "padded" });
});

test("single-select: label + other both present is lossless (rides free text)", () => {
  // runTuiFlow's single-select can only express ONE answer, so when the hub
  // somehow carries both the script prefers the lossless Other path.
  const q = [{ question: "Edge?", options: [opt("a"), opt("b")] }];
  const script = buildAskScript(q, [{ selected: ["a"], other: "but also b" }]);
  assert.deepEqual(script, [
    { method: "select", value: ASK_OTHER },
    { method: "input", value: "a, but also b" },
  ]);
});

test("single-select: `labels` is accepted as an alias for `selected`", () => {
  const q = [{ question: "Which?", options: [opt("a"), opt("b")] }];
  const script = buildAskScript(q, [{ labels: ["b"] }]);
  assert.deepEqual(script, [{ method: "select", value: "b" }]);
});

// ---------------------------------------------------------------------------
// multi-select
// ---------------------------------------------------------------------------

test("multi-select: two labels toggle in order, then the done row carries the count", () => {
  const q = [{ question: "Flags?", multiSelect: true, options: [opt("a", "first"), opt("b"), opt("c")] }];
  const script = buildAskScript(q, [{ selected: ["a", "c"], other: null }]);
  assert.deepEqual(script, [
    { method: "select", value: "[ ] a \u2014 first" },   // unchecked at pick time
    { method: "select", value: "[ ] c" },
    { method: "select", value: "\u2500\u2500 done (2 selected) \u2500\u2500" },
  ]);
});

test("multi-select: labels + Other text, done count includes the free text", () => {
  const q = [{ question: "Toppings?", multiSelect: true, options: [opt("cheese"), opt("ham")] }];
  const script = buildAskScript(q, [{ selected: ["ham"], other: "pineapple" }]);
  assert.deepEqual(script, [
    { method: "select", value: "[ ] ham" },
    { method: "select", value: ASK_OTHER },
    { method: "input", value: "pineapple" },
    { method: "select", value: "\u2500\u2500 done (2 selected) \u2500\u2500" },
  ]);
});

test("multi-select: Other only", () => {
  const q = [{ question: "Toppings?", multiSelect: true, options: [opt("cheese")] }];
  const script = buildAskScript(q, [{ selected: [], other: "everything" }]);
  assert.deepEqual(script, [
    { method: "select", value: ASK_OTHER },
    { method: "input", value: "everything" },
    { method: "select", value: "\u2500\u2500 done (1 selected) \u2500\u2500" },
  ]);
});

test("multi-select: empty selection emits a bare done row (0 selected)", () => {
  const q = [{ question: "None?", multiSelect: true, options: [opt("a")] }];
  const script = buildAskScript(q, [{ selected: [], other: null }]);
  assert.deepEqual(script, [{ method: "select", value: "\u2500\u2500 done \u2500\u2500" }]);
});

test("multi-select: duplicate labels are de-duplicated (a Set, like runTuiFlow's picked)", () => {
  const q = [{ question: "Dup?", multiSelect: true, options: [opt("a"), opt("b")] }];
  const script = buildAskScript(q, [{ selected: ["a", "a", "b"], other: null }]);
  assert.deepEqual(script, [
    { method: "select", value: "[ ] a" },
    { method: "select", value: "[ ] b" },
    { method: "select", value: "\u2500\u2500 done (2 selected) \u2500\u2500" },
  ]);
});

// ---------------------------------------------------------------------------
// multi-question
// ---------------------------------------------------------------------------

test("four mixed questions compile in order (the full ask_user shape)", () => {
  const q = [
    { question: "Q1?", header: "One", options: [opt("x", "ex"), opt("y")] },
    { question: "Q2?", multiSelect: true, options: [opt("p"), opt("q"), opt("r")] },
    { question: "Q3?", options: [opt("m"), opt("n")] },
    { question: "Q4?", multiSelect: true, header: "Four", options: [opt("s"), opt("t")] },
  ];
  const answers = [
    { selected: ["y"], other: null },
    { selected: ["p", "q", "r"], other: null },
    { selected: [], other: "free three" },
    { selected: ["t"], other: "extra" },
  ];
  const script = buildAskScript(q, answers);
  assert.deepEqual(script, [
    { method: "select", value: "y" },                                    // Q1
    { method: "select", value: "[ ] p" },                                 // Q2
    { method: "select", value: "[ ] q" },
    { method: "select", value: "[ ] r" },
    { method: "select", value: "\u2500\u2500 done (3 selected) \u2500\u2500" },
    { method: "select", value: ASK_OTHER },                              // Q3 (other)
    { method: "input", value: "free three" },
    { method: "select", value: "[ ] t" },                                 // Q4
    { method: "select", value: ASK_OTHER },
    { method: "input", value: "extra" },
    { method: "select", value: "\u2500\u2500 done (2 selected) \u2500\u2500" },
  ]);
});

test("missing answers for a trailing question still compile its (empty) part", () => {
  const q = [
    { question: "Q1?", options: [opt("a")] },
    { question: "Q2?", multiSelect: true, options: [opt("b")] },
  ];
  const script = buildAskScript(q, [{ selected: ["a"] }]);  // no answer for Q2
  assert.deepEqual(script, [
    { method: "select", value: "a" },
    { method: "select", value: "\u2500\u2500 done \u2500\u2500" },          // Q2 empty → bare done
  ]);
});

// ---------------------------------------------------------------------------
// null (drift / malformed) — the caller degrades honestly, never throws
// ---------------------------------------------------------------------------

test("null on a label absent from its options (drift)", () => {
  const q = [{ question: "Q?", options: [opt("a")] }];
  // single-select: an unknown label falls to the lossless Other path, NOT null
  assert.ok(buildAskScript(q, [{ selected: ["zzz"], other: null }]));
  // multi-select: an unknown label cannot be toggled → null (degrade)
  const mq = [{ question: "Q?", multiSelect: true, options: [opt("a")] }];
  assert.equal(buildAskScript(mq, [{ selected: ["zzz"], other: null }]), null);
});

test("null on malformed questions", () => {
  assert.equal(buildAskScript(null, []), null);
  assert.equal(buildAskScript([], []), null);
  assert.equal(buildAskScript([{ question: "Q?" }], [{}]), null);           // no options
  assert.equal(buildAskScript([{ question: "Q?", options: [] }], [{}]), null); // empty options
});

test("never throws on garbage answers", () => {
  const q = [{ question: "Q?", options: [opt("a")] }];
  for (const bad of [null, undefined, [], [null], [{}], [{ selected: "nope" }], [{ other: 123 }]]) {
    assert.doesNotThrow(() => buildAskScript(q, bad));
  }
});
