/**
 * Ramble Moves voice Task 8.2 — turning one segment into its spoken cues.
 *
 * The client file runs in a vm sandbox: the ramble bundle is an ESM tree, so
 * the sandbox supplies the CommonJS `module` the dual wrapper looks for (and a
 * `window` in one test, for the other half of it). Every expected word comes
 * from the shipped voice lines (server/moves/voice.en.json); no expected
 * sentence is written here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MOVES = join(ROOT, "bundles", "ramble", "server", "moves");
const AUDIO_PATH = join(ROOT, "bundles", "ramble", "panel", "static", "player-audio.js");

const SOURCE = readFileSync(AUDIO_PATH, "utf8");
const LINES = JSON.parse(readFileSync(join(MOVES, "voice.en.json"), "utf8"));

/* A copy in this realm, so a deep equal can read what the sandbox returned. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadCommonJs() {
  const sandbox = { module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: "player-audio.js" }).runInContext(sandbox);
  return sandbox.module.exports;
}

function loadBrowser() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: "player-audio.js" }).runInContext(sandbox);
  return sandbox.window.RamblePlayerAudio;
}

const API = loadCommonJs();
const fill = API.fill;

function cuesFor(segment, next, lines, guidance, ctx) {
  return plain(API.cuesFor(segment, next, lines, guidance, ctx));
}

function scriptFor(segment, next, lines, guidance, ctx) {
  return plain(API.scriptFor(segment, next, lines, guidance, ctx));
}

const NAME = "Reach up";
const NAME2 = "Fold forward";

function segment(over) {
  return {
    type: "hold",
    chunkIndex: 0,
    block: "main",
    entryId: "pose-reach",
    stepIndex: 0,
    seconds: 30,
    active: true,
    reps: null,
    side: null,
    cue: "Reach up",
    say: "Reach up tall",
    ...over,
  };
}

function ctx(over) {
  return {
    name: NAME,
    nextName: NAME2,
    isFirstWork: false,
    isLastWork: false,
    entryStart: true,
    seed: 0,
    ...over,
  };
}

function texts(cues) {
  return cues.map((cue) => cue.text);
}

function ats(cues) {
  return cues.map((cue) => cue.at);
}

/* ---------- the exported shape ---------- */

test("the api exposes cuesFor, scriptFor and fill", () => {
  assert.equal(typeof API.cuesFor, "function");
  assert.equal(typeof API.scriptFor, "function");
  assert.equal(typeof API.fill, "function");
});

test("the browser half is a window property of the same api", () => {
  const browserApi = loadBrowser();
  assert.equal(typeof browserApi.cuesFor, "function");
  assert.equal(typeof browserApi.scriptFor, "function");
  assert.equal(typeof browserApi.fill, "function");
  assert.deepEqual(
    plain(browserApi.scriptFor(segment({ seconds: 10 }), null, LINES, "memory", ctx())),
    [],
  );
});

test("the client source is a classic script with no backtick and a final newline", () => {
  assert.equal(SOURCE.includes("`"), false);
  assert.equal(SOURCE.endsWith("\n"), true);
  assert.equal(/\b(import|export)\s/.test(SOURCE), false);
});

test("fill substitutes placeholders and drops a placeholder with no value", () => {
  assert.equal(fill(LINES.leadIn.round, { n: 2 }), "Round 2. Same again.");
  assert.equal(fill(LINES.leadIn.first, { name: NAME }), "First, " + NAME + ".");
  assert.equal(fill(LINES.sides.left, {}), LINES.sides.left);
  assert.equal(fill("", { name: NAME }), "");
  assert.equal(fill(undefined, undefined), "");
});

/* ---------- full guidance ---------- */

test("full: the lead-in comes first, then the segment's own line", () => {
  const cues = cuesFor(segment(), null, LINES, "full", ctx({ isFirstWork: true }));
  assert.deepEqual(texts(cues).slice(0, 2), [
    fill(LINES.leadIn.first, { name: NAME }),
    "Reach up tall",
  ]);
  assert.deepEqual(ats(cues).slice(0, 2), [0, 0]);
});

test("full: a 30 second hold has exactly one mid-hold line at 15", () => {
  const cues = cuesFor(segment({ seconds: 30 }), null, LINES, "full", ctx());
  const mid = cues.filter((cue) => cue.text === LINES.midHold[0]);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].at, 15);
});

test("full: the mid-hold line follows the seed", () => {
  const cues = cuesFor(segment({ seconds: 24 }), null, LINES, "full", ctx({ seed: 3 }));
  assert.equal(cues[2].text, LINES.midHold[3]);
  assert.equal(cues[2].at, 12);
  const other = cuesFor(segment({ seconds: 24 }), null, LINES, "full", ctx({ seed: 12 }));
  assert.equal(other[2].text, LINES.midHold[2]);
});

test("full: a 10 second hold has no mid-hold line", () => {
  const cues = cuesFor(segment({ seconds: 10 }), null, LINES, "full", ctx());
  const mids = cues.filter((cue) => LINES.midHold.indexOf(cue.text) >= 0);
  assert.deepEqual(mids, []);
});

test("full: a 20 second hold has one mid-hold line, at 10", () => {
  const cues = cuesFor(segment({ seconds: 20 }), null, LINES, "full", ctx());
  const mids = cues.filter((cue) => LINES.midHold.indexOf(cue.text) >= 0);
  assert.equal(mids.length, 1);
  assert.equal(mids[0].at, 10);
});

test("full: a hold closes at the end with close.hold", () => {
  const cues = cuesFor(segment({ seconds: 30 }), null, LINES, "full", ctx());
  const last = cues[cues.length - 1];
  assert.equal(last.text, LINES.close.hold);
  assert.equal(last.at, 30);
});

test("full: a hold with a side closes with close.side", () => {
  const cues = cuesFor(segment({ seconds: 30, side: "left" }), null, LINES, "full", ctx());
  assert.equal(cues[cues.length - 1].text, LINES.close.side);
});

test("full: a timed segment closes with close.timed", () => {
  const cues = cuesFor(segment({ type: "timed", seconds: 45 }), null, LINES, "full", ctx());
  assert.equal(cues[cues.length - 1].text, LINES.close.timed);
  assert.equal(cues[cues.length - 1].at, 45);
});

test("full: a reps segment closes with close.reps", () => {
  const cues = cuesFor(
    segment({ type: "reps", seconds: 40, reps: 10, say: "" }),
    null, LINES, "full", ctx(),
  );
  assert.equal(cues[cues.length - 1].text, LINES.close.reps);
  assert.equal(cues[cues.length - 1].at, 40);
});

/* ---------- reps counting ---------- */

test("full: 10 reps are counted one by one, the last in place of its number", () => {
  const cues = cuesFor(
    segment({ type: "reps", seconds: 40, reps: 10, say: "" }),
    null, LINES, "full", ctx({ entryStart: false }),
  );
  const counted = texts(cues).slice(0, 10);
  assert.deepEqual(counted, LINES.reps.numbers.slice(0, 9).concat(LINES.reps.lastRep));
  assert.equal(counted.indexOf(LINES.reps.numbers[9]), -1);
});

test("full: 14 reps speak the even numbers and always the last", () => {
  const cues = cuesFor(
    segment({ type: "reps", seconds: 70, reps: 14, say: "" }),
    null, LINES, "full", ctx({ entryStart: false }),
  );
  const expected = [];
  for (let i = 1; i <= 14; i += 1) {
    if (i % 2 !== 0) continue;
    expected.push(i === 14 ? LINES.reps.lastRep : LINES.reps.numbers[i - 1]);
  }
  assert.deepEqual(texts(cues).slice(0, expected.length), expected);
  assert.equal(cues.length, expected.length + 1);
});

test("full: rep counts land at seconds * (i - 0.5) / reps", () => {
  const cues = cuesFor(
    segment({ type: "reps", seconds: 30, reps: 3, say: "" }),
    null, LINES, "full", ctx({ entryStart: false }),
  );
  assert.deepEqual(ats(cues), [5, 15, 25, 30]);
  assert.deepEqual(texts(cues), [
    LINES.reps.numbers[0],
    LINES.reps.numbers[1],
    LINES.reps.lastRep,
    LINES.close.reps,
  ]);
});

test("full: a reps segment says its own line before the counts", () => {
  const cues = cuesFor(
    segment({ type: "reps", seconds: 30, reps: 3, say: "Eight small circles" }),
    null, LINES, "full", ctx(),
  );
  assert.deepEqual(texts(cues).slice(0, 3), [
    fill(LINES.leadIn.next, { name: NAME }),
    "Eight small circles",
    LINES.reps.numbers[0],
  ]);
});

/* ---------- quiet segments ---------- */

test("full: switch-sides says the switch line at 0", () => {
  const cues = cuesFor(segment({ type: "switch-sides", seconds: 3, say: "" }), null, LINES, "full", ctx());
  assert.deepEqual(cues, [{ at: 0, text: LINES.switchSides }]);
});

test("full: a rest before work names what is next", () => {
  const rest = segment({ type: "rest", seconds: 20, say: "", cue: "" });
  const next = segment({ type: "hold", seconds: 30 });
  const cues = cuesFor(rest, next, LINES, "full", ctx());
  assert.deepEqual(cues, [
    { at: 0, text: fill(LINES.rest.withNext, { next: NAME2 }) },
  ]);
});

test("full: a rest says nothing without a next name or a work next", () => {
  const rest = segment({ type: "rest", seconds: 20, say: "" });
  const next = segment({ type: "hold", seconds: 30 });
  assert.deepEqual(cuesFor(rest, next, LINES, "full", ctx({ nextName: "" })), []);
  assert.deepEqual(cuesFor(rest, null, LINES, "full", ctx()), []);
  assert.deepEqual(
    cuesFor(rest, segment({ type: "switch-sides", seconds: 3 }), LINES, "full", ctx()),
    [],
  );
  assert.deepEqual(
    cuesFor(rest, segment({ type: "chunk-break", seconds: 5 }), LINES, "full", ctx()),
    [],
  );
});

test("full: transition and chunk-break segments say nothing", () => {
  assert.deepEqual(
    cuesFor(segment({ type: "transition", seconds: 2, say: "Reach up tall" }), null, LINES, "full", ctx()),
    [],
  );
  assert.deepEqual(
    cuesFor(segment({ type: "chunk-break", seconds: 5, say: "Reach up tall" }), null, LINES, "full", ctx()),
    [],
  );
});

/* ---------- guidance levels ---------- */

test("names: lead-ins only, whatever the segment asks for", () => {
  const hold = cuesFor(segment({ seconds: 40 }), null, LINES, "names", ctx());
  assert.deepEqual(hold, [{ at: 0, text: fill(LINES.leadIn.next, { name: NAME }) }]);
  const reps = cuesFor(
    segment({ type: "reps", seconds: 40, reps: 4, say: "Small circles" }),
    null, LINES, "names", ctx({ isFirstWork: true }),
  );
  assert.deepEqual(reps, [{ at: 0, text: fill(LINES.leadIn.first, { name: NAME }) }]);
});

test("names: a rest or switch-sides segment says nothing", () => {
  assert.deepEqual(
    cuesFor(segment({ type: "rest", seconds: 20, say: "" }), segment(), LINES, "names", ctx()),
    [],
  );
  assert.deepEqual(
    cuesFor(segment({ type: "switch-sides", seconds: 3 }), null, LINES, "names", ctx()),
    [],
  );
});

test("first: only the session's first lead-in, nothing else", () => {
  const cues = cuesFor(segment({ seconds: 40 }), null, LINES, "first", ctx({ isFirstWork: true }));
  assert.deepEqual(cues, [{ at: 0, text: fill(LINES.leadIn.first, { name: NAME }) }]);
  const reps = cuesFor(
    segment({ type: "reps", seconds: 40, reps: 5, say: "Small circles" }),
    null, LINES, "first", ctx({ isFirstWork: true }),
  );
  assert.equal(reps.length, 1);
});

test("first: a segment that is not the first says nothing", () => {
  assert.deepEqual(cuesFor(segment({ seconds: 40 }), null, LINES, "first", ctx()), []);
  assert.deepEqual(
    cuesFor(segment({ seconds: 40 }), null, LINES, "first", ctx({ isLastWork: true })),
    [],
  );
});

test("memory: no cues at all", () => {
  assert.deepEqual(cuesFor(segment({ seconds: 40 }), null, LINES, "memory", ctx({ isFirstWork: true })), []);
  assert.deepEqual(
    cuesFor(segment({ type: "reps", seconds: 40, reps: 4, say: "Small circles" }), null, LINES, "memory", ctx()),
    [],
  );
  assert.deepEqual(cuesFor(segment({ type: "rest", seconds: 20 }), segment(), LINES, "memory", ctx()), []);
});

test("an undefined guidance level is full", () => {
  const cues = cuesFor(segment({ seconds: 30 }), null, LINES, undefined, ctx({ isFirstWork: true }));
  assert.deepEqual(texts(cues).slice(-1), [LINES.close.hold]);
});

/* ---------- lead-in variants ---------- */

test("lead-in: first, last, next side and next", () => {
  const first = cuesFor(segment({ seconds: 30 }), null, LINES, "names", ctx({ isFirstWork: true }));
  assert.deepEqual(texts(first), [fill(LINES.leadIn.first, { name: NAME })]);

  const last = cuesFor(segment({ seconds: 30 }), null, LINES, "names", ctx({ isLastWork: true }));
  assert.deepEqual(texts(last), [fill(LINES.leadIn.last, { name: NAME })]);

  const nextSide = cuesFor(
    segment({ seconds: 30, side: "right" }), null, LINES, "names", ctx(),
  );
  assert.deepEqual(texts(nextSide), [
    fill(LINES.leadIn.nextSide, { name: NAME, side: LINES.sides.right }),
  ]);

  const next = cuesFor(segment({ seconds: 30 }), null, LINES, "names", ctx());
  assert.deepEqual(texts(next), [fill(LINES.leadIn.next, { name: NAME })]);
});

test("lead-in: the first one wins over the last one", () => {
  const cues = cuesFor(
    segment({ seconds: 30 }), null, LINES, "names", ctx({ isFirstWork: true, isLastWork: true }),
  );
  assert.deepEqual(texts(cues), [fill(LINES.leadIn.first, { name: NAME })]);
});

test("lead-in: only at a segment that starts its entry", () => {
  assert.deepEqual(cuesFor(segment(), null, LINES, "names", ctx({ entryStart: false })), []);
  assert.deepEqual(cuesFor(segment(), null, LINES, "names", ctx({ entryStart: undefined })), []);
});

test("lead-in: nothing spoken without a name", () => {
  assert.deepEqual(cuesFor(segment(), null, LINES, "names", ctx({ name: "" })), []);
  assert.deepEqual(cuesFor(segment(), null, LINES, "names", ctx({ name: undefined })), []);
});

test("lead-in: a side without a side word is not spoken", () => {
  const lines = { ...LINES, sides: {} };
  assert.deepEqual(
    cuesFor(segment({ side: "left" }), null, lines, "names", ctx()),
    [],
  );
});

test("a partial reps group keeps the default counting rule", () => {
  const lines = { reps: { numbers: LINES.reps.numbers, lastRep: LINES.reps.lastRep } };
  const cues = cuesFor(
    segment({ type: "reps", seconds: 24, reps: 4, say: "" }),
    null, lines, "full", ctx({ entryStart: false }),
  );
  assert.deepEqual(texts(cues), [
    LINES.reps.numbers[0],
    LINES.reps.numbers[1],
    LINES.reps.numbers[2],
    LINES.reps.lastRep,
  ]);
});

/* ---------- ordering and tolerance ---------- */

test("cues are sorted by at", () => {
  const cues = cuesFor(
    segment({ type: "reps", seconds: 40, reps: 6 }), null, LINES, "full", ctx({ isFirstWork: true }),
  );
  const sorted = ats(cues).slice().sort((a, b) => a - b);
  assert.deepEqual(ats(cues), sorted);
});

test("scriptFor is the cue text in order", () => {
  const seg = segment({ seconds: 30 });
  assert.deepEqual(scriptFor(seg, null, LINES, "full", ctx()), texts(cuesFor(seg, null, LINES, "full", ctx())));
  assert.deepEqual(scriptFor(seg, null, LINES, "memory", ctx()), []);
});

test("a missing segment, next, lines or ctx does not throw", () => {
  assert.deepEqual(cuesFor(undefined, undefined, undefined, undefined, undefined), []);
  assert.deepEqual(cuesFor(null, null, null, "full", null), []);
  assert.deepEqual(cuesFor(segment({ say: "" }), null, {}, "full", ctx()), []);
  assert.deepEqual(cuesFor(segment({ say: "" }), null, undefined, "full", ctx()), []);
  assert.deepEqual(
    cuesFor(segment({ type: "reps", seconds: 40, reps: 4, say: "" }), null, {}, "full", ctx()),
    [],
  );
  assert.deepEqual(cuesFor(segment({ type: "rest", seconds: 20 }), segment(), {}, "full", ctx()), []);
  assert.deepEqual(cuesFor(segment({ type: "switch-sides", seconds: 3 }), null, {}, "full", ctx()), []);
});

test("the test file ends with a newline", () => {
  const self = readFileSync(join(HERE, "ramble-moves-voice.test.js"), "utf8");
  assert.equal(self.endsWith("\n"), true);
});

test("a partial lines object speaks what it has", () => {
  const lines = { leadIn: { next: LINES.leadIn.next }, midHold: [LINES.midHold[1]] };
  const cues = cuesFor(segment({ seconds: 30 }), null, lines, "full", ctx());
  assert.deepEqual(texts(cues), [
    fill(LINES.leadIn.next, { name: NAME }),
    "Reach up tall",
    LINES.midHold[1],
  ]);
});
