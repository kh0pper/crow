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
const COPY = JSON.parse(readFileSync(join(MOVES, "player-copy.en.json"), "utf8"));

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

/* ================= attach: speech, tones, toggles, availability ================= */

/* Every word the tests look for is a shipped line or a shipped label. */
const CHIME_FREQ = 880;
const TICK_FREQ = 660;

/* ---------- the fakes: a clock, a voice, a speaker, storage, a tiny DOM ---------- */

function fakeTimers() {
  let now = 0;
  let next = 0;
  const queue = [];
  function setTimeout(fn, ms) {
    next += 1;
    const wait = Number(ms);
    queue.push({ id: next, at: now + (Number.isFinite(wait) && wait > 0 ? wait : 0), fn });
    return next;
  }
  function clearTimeout(id) {
    for (let i = 0; i < queue.length; i += 1) {
      if (queue[i].id === id) {
        queue.splice(i, 1);
        return;
      }
    }
  }
  function advance(ms) {
    const target = now + Number(ms);
    let guard = 0;
    for (;;) {
      let pick = -1;
      for (let i = 0; i < queue.length; i += 1) {
        if (queue[i].at > target) continue;
        if (pick < 0 || queue[i].at < queue[pick].at) pick = i;
      }
      if (pick < 0) break;
      const entry = queue.splice(pick, 1)[0];
      if (entry.at > now) now = entry.at;
      entry.fn();
      guard += 1;
      if (guard > 5000) throw new Error("timer queue will not settle");
    }
    now = target;
  }
  function times() {
    return queue.map((entry) => entry.at).sort((a, b) => a - b);
  }
  return { setTimeout, clearTimeout, advance, times, pending: () => queue.length };
}

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

/* A voice: an utterance the caller can read back, a synthesiser that records
 * what it was asked to say and cancel, and (when asked) a voiceschanged route. */
function makeSpeech(config) {
  const cfg = config || {};
  const state = { spoken: [], cancels: 0, listeners: [] };
  const synth = {
    speak(utterance) {
      if (cfg.speakThrows) throw new Error("speak refused");
      state.spoken.push(utterance);
    },
    cancel() {
      state.cancels += 1;
      if (cfg.cancelThrows) throw new Error("cancel refused");
    },
    getVoices() {
      if (cfg.getVoicesThrows) throw new Error("voices refused");
      if (typeof cfg.getVoices === "function") return cfg.getVoices();
      if (cfg.voices !== undefined) return cfg.voices;
      return [{ name: "test voice", lang: "en-GB" }];
    },
  };
  if (cfg.onVoicesProperty) {
    synth.onvoiceschanged = null;
  } else {
    synth.addEventListener = (type, fn) => {
      state.listeners.push({ type, fn });
    };
    synth.removeEventListener = (type, fn) => {
      for (let i = 0; i < state.listeners.length; i += 1) {
        if (state.listeners[i].type === type && state.listeners[i].fn === fn) {
          state.listeners.splice(i, 1);
          return;
        }
      }
    };
  }
  function fireVoicesChanged() {
    if (cfg.onVoicesProperty) {
      if (typeof synth.onvoiceschanged === "function") synth.onvoiceschanged();
      return;
    }
    const waiting = state.listeners.slice();
    for (const entry of waiting) entry.fn();
  }
  return {
    state,
    synth,
    fireVoicesChanged,
    speech: {
      synth,
      utterance(text) {
        return { text, rate: null };
      },
    },
  };
}

/* A speaker that records each tone it was asked for, as { freq, when }. */
function makeAudio() {
  const tones = [];
  let created = 0;
  function factory() {
    created += 1;
    return {
      currentTime: 0,
      destination: { name: "out" },
      createOscillator() {
        const tone = { freq: null, when: null };
        return {
          frequency: {
            get value() {
              return tone.freq;
            },
            set value(freq) {
              tone.freq = freq;
            },
          },
          connect() {},
          start(when) {
            tone.when = when;
            tones.push(tone);
          },
          stop() {},
        };
      },
      createGain() {
        return {
          gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
          connect() {},
        };
      },
    };
  }
  return { tones, factory, created: () => created };
}

/* The smallest DOM the controls need: roles, text, children and clicks. */
function makeDom() {
  function node(tag) {
    const el = {
      tagName: tag,
      attrs: {},
      children: [],
      parentNode: null,
      textContent: "",
      listeners: [],
      setAttribute(name, value) {
        el.attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
      },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      removeChild(child) {
        const at = el.children.indexOf(child);
        if (at < 0) throw new Error("not a child");
        el.children.splice(at, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(type, fn) {
        el.listeners.push({ type, fn });
      },
      removeEventListener(type, fn) {
        for (let i = 0; i < el.listeners.length; i += 1) {
          if (el.listeners[i].type === type && el.listeners[i].fn === fn) {
            el.listeners.splice(i, 1);
            return;
          }
        }
      },
      click() {
        const listened = el.listeners.filter((entry) => entry.type === "click");
        for (const entry of listened) entry.fn({ type: "click" });
      },
    };
    return el;
  }
  return { doc: { createElement: (tag) => node(tag) }, host: node("div") };
}

function findByRole(node, role) {
  if (!node || !Array.isArray(node.children)) return null;
  for (const child of node.children) {
    if (child.attrs && child.attrs["data-role"] === role) return child;
    const found = findByRole(child, role);
    if (found) return found;
  }
  return null;
}

function countByRole(node, role) {
  if (!node || !Array.isArray(node.children)) return 0;
  let total = 0;
  for (const child of node.children) {
    if (child.attrs && child.attrs["data-role"] === role) total += 1;
    total += countByRole(child, role);
  }
  return total;
}

function harness(config) {
  const cfg = config || {};
  const timers = fakeTimers();
  const voice = cfg.speech === undefined ? makeSpeech(cfg.speechConfig) : null;
  const speech = cfg.speech === undefined ? voice.speech : cfg.speech;
  const audio = cfg.audio === undefined ? makeAudio() : cfg.audio;
  const storage = cfg.storage === undefined ? fakeStorage() : cfg.storage;
  const dom = cfg.dom === undefined ? makeDom() : cfg.dom;
  const opts = {
    lines: cfg.lines === undefined ? LINES : cfg.lines,
    copy: cfg.copy === undefined ? COPY : cfg.copy,
    guidance: cfg.guidance === undefined ? "full" : cfg.guidance,
    host: cfg.noDom ? undefined : dom.host,
    doc: cfg.noDom ? undefined : dom.doc,
    storage,
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    speech,
    audio: audio ? audio.factory : null,
    rate: cfg.rate,
  };
  return { control: API.attach({}, opts), opts, timers, voice, speech, audio, storage, dom };
}

function event(over) {
  const fields = over || {};
  return {
    type: "segment",
    segment: fields.segment === undefined ? segment() : fields.segment,
    next: fields.next === undefined ? null : fields.next,
    ctx: fields.ctx === undefined ? ctx() : fields.ctx,
    elapsed: fields.elapsed === undefined ? 0 : fields.elapsed,
  };
}

function spokenTexts(played) {
  return played.state.spoken.map((utterance) => utterance.text);
}

/* The tick tones heard so far: a tick sounds when its own timer fires, so this
 * counts what was really heard rather than what was once scheduled. */
function tickCount(played) {
  return played.audio.tones.filter((tone) => tone.freq === TICK_FREQ).length;
}

/* Walk the timers a second at a time and name the second of the segment each
 * new tick fell on. */
function tickSeconds(played, seconds) {
  const seen = [];
  for (let step = 1; step <= seconds; step += 1) {
    const before = tickCount(played);
    played.timers.advance(1000);
    const after = tickCount(played);
    for (let i = before; i < after; i += 1) seen.push(step);
  }
  return seen;
}

/* A routine long enough to cross every segment type the player reports. */
function routine(played) {
  const events = [
    event({ segment: segment({ type: "hold", seconds: 20 }) }),
    event({ segment: segment({ type: "hold", seconds: 20, side: "left", entryId: "pose-side" }) }),
    event({ segment: segment({ type: "switch-sides", seconds: 3, say: "", cue: "" }) }),
    event({ segment: segment({ type: "hold", seconds: 20, side: "right", entryId: "pose-side" }) }),
    event({
      segment: segment({ type: "rest", seconds: 20, say: "", cue: "" }),
      next: segment({ type: "reps", seconds: 40, reps: 10 }),
    }),
    event({ segment: segment({ type: "reps", seconds: 40, reps: 10 }), ctx: ctx({ entryStart: false }) }),
    event({ segment: segment({ type: "reps", seconds: 70, reps: 14 }), ctx: ctx({ entryStart: false }) }),
    event({ segment: segment({ type: "hold", seconds: 3 }) }),
    event({ segment: segment({ type: "timed", seconds: 45 }) }),
    event({ segment: segment({ type: "transition", seconds: 2, say: "", cue: "" }) }),
    event({ segment: segment({ type: "chunk-break", seconds: 5, say: "", cue: "" }) }),
    event({
      segment: segment({ type: "rest", seconds: 20, say: "", cue: "" }),
      next: segment({ type: "hold", seconds: 30 }),
    }),
  ];
  for (const item of events) {
    played.control.onEvent(item);
    played.timers.advance(2000);
  }
  played.control.onEvent({ type: "pause" });
  played.timers.advance(1000);
  played.control.onEvent({
    type: "resume",
    segment: segment({ type: "hold", seconds: 20 }),
    next: null,
    ctx: ctx(),
    elapsed: 4,
  });
  played.timers.advance(10000);
  played.control.onEvent({ type: "ended" });
  played.timers.advance(1000);
  played.control.onEvent({ type: "left" });
  played.timers.advance(1000);
}

/* ---------- the platform defaults ---------- */

test("attach: the new entry points are on both halves of the api", () => {
  assert.equal(typeof API.attach, "function");
  assert.equal(typeof API.defaultSpeech, "function");
  assert.equal(typeof API.defaultAudio, "function");
  const browserApi = loadBrowser();
  assert.equal(typeof browserApi.attach, "function");
  assert.equal(typeof browserApi.defaultSpeech, "function");
  assert.equal(typeof browserApi.defaultAudio, "function");
});

test("attach: a bare call with nothing to work with still returns a working handle", () => {
  const control = API.attach();
  assert.equal(control.available(), false);
  assert.equal(control.voiceOn(), true);
  assert.equal(control.soundOn(), true);
  assert.doesNotThrow(() => {
    control.onEvent({ type: "segment" });
    control.onEvent({ type: "pause" });
    control.onEvent({ type: "resume" });
    control.onEvent({ type: "ended" });
    control.onEvent({ type: "left" });
    control.setVoice(false);
    control.setSound(false);
    control.destroy();
    control.destroy();
  });
});

test("attach: defaultSpeech and defaultAudio read the browser globals", () => {
  const win = {
    speechSynthesis: { speak() {}, cancel() {}, getVoices: () => [] },
    SpeechSynthesisUtterance: function Utterance(text) {
      this.text = text;
    },
    AudioContext: function Context() {
      this.currentTime = 0;
      this.destination = { name: "out" };
      this.createOscillator = () => ({ frequency: {}, connect() {}, start() {}, stop() {} });
      this.createGain = () => ({ gain: {}, connect() {} });
    },
  };
  const speech = API.defaultSpeech(win);
  assert.equal(speech.synth, win.speechSynthesis);
  assert.equal(speech.utterance("hello").text, "hello");
  assert.equal(API.defaultSpeech({}), null);
  assert.equal(API.defaultSpeech({ speechSynthesis: {} }), null);
  assert.equal(API.defaultSpeech(), null);
  const factory = API.defaultAudio(win);
  assert.equal(typeof factory, "function");
  assert.equal(factory().destination.name, "out");
  assert.equal(API.defaultAudio({}), null);
  assert.equal(API.defaultAudio(), null);
});

test("attach: the spoken rate is 0.9 unless a rate is given", () => {
  const plainRate = harness();
  plainRate.control.onEvent(event());
  plainRate.timers.advance(1000);
  assert.equal(plainRate.voice.state.spoken.length > 0, true);
  assert.equal(plainRate.voice.state.spoken[0].rate, 0.9);

  const faster = harness({ rate: 1.15 });
  faster.control.onEvent(event());
  faster.timers.advance(1000);
  assert.equal(faster.voice.state.spoken[0].rate, 1.15);
});

/* ---------- the two device choices ---------- */

test("attach: both choices start on and are stored on the device", () => {
  const storage = fakeStorage();
  const first = harness({ storage });
  assert.equal(first.control.voiceOn(), true);
  assert.equal(first.control.soundOn(), true);

  first.control.setVoice(false);
  first.control.setSound(false);
  assert.equal(storage.getItem("ramble.player.voice"), "0");
  assert.equal(storage.getItem("ramble.player.sound"), "0");

  const second = harness({ storage });
  assert.equal(second.control.voiceOn(), false);
  assert.equal(second.control.soundOn(), false);

  second.control.setVoice(true);
  second.control.setSound(true);
  assert.equal(storage.getItem("ramble.player.voice"), "1");
  assert.equal(storage.getItem("ramble.player.sound"), "1");

  const third = harness({ storage });
  assert.equal(third.control.voiceOn(), true);
  assert.equal(third.control.soundOn(), true);
});

test("attach: no storage, or one that will not answer, still starts both on", () => {
  const none = harness({ storage: null });
  assert.equal(none.control.voiceOn(), true);
  assert.equal(none.control.soundOn(), true);

  const broken = {
    getItem() {
      throw new Error("no storage");
    },
    setItem() {
      throw new Error("no storage");
    },
  };
  const refused = harness({ storage: broken });
  assert.equal(refused.control.voiceOn(), true);
  assert.equal(refused.control.soundOn(), true);
  assert.doesNotThrow(() => {
    refused.control.setSound(false);
    refused.control.setVoice(false);
  });
  assert.equal(refused.control.soundOn(), false);
});

/* ---------- the clock, the chime and the ticks ---------- */

test("attach: a new segment cancels the speech that was running", () => {
  const played = harness();
  played.control.onEvent(event());
  played.timers.advance(1000);
  assert.equal(spokenTexts(played.voice).length > 0, true);
  played.control.onEvent(event({
    segment: segment({ entryId: "pose-fold", say: "Fold forward" }),
  }));
  assert.equal(played.voice.state.cancels, 2);
});

test("attach: pause cancels at once and drops the cues still to come", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ seconds: 30 }) }));
  assert.equal(played.voice.state.cancels, 1);
  assert.equal(spokenTexts(played.voice).length, 0);

  played.control.onEvent({ type: "pause" });
  assert.equal(played.voice.state.cancels, 2);
  assert.deepEqual(spokenTexts(played.voice), [LINES.paused]);

  played.timers.advance(60000);
  assert.deepEqual(spokenTexts(played.voice), [LINES.paused]);
});

test("attach: later cues still fire without speech ever calling back", () => {
  const played = harness();
  played.control.onEvent(event({
    segment: segment({ type: "reps", seconds: 40, reps: 4, say: "" }),
    ctx: ctx({ entryStart: false }),
  }));
  assert.deepEqual(spokenTexts(played.voice), []);

  played.timers.advance(5000);
  assert.deepEqual(spokenTexts(played.voice), [LINES.reps.numbers[0]]);

  played.timers.advance(10000);
  assert.deepEqual(spokenTexts(played.voice), [LINES.reps.numbers[0], LINES.reps.numbers[1]]);

  played.timers.advance(60000);
  assert.deepEqual(spokenTexts(played.voice), [
    LINES.reps.numbers[0],
    LINES.reps.numbers[1],
    LINES.reps.numbers[2],
    LINES.reps.lastRep,
    LINES.close.reps,
  ]);
});

test("attach: the chime is scheduled before the first spoken line", () => {
  const played = harness();
  assert.equal(played.audio.created(), 0);
  played.control.onEvent(event({ segment: segment({ seconds: 30 }) }));
  assert.equal(played.audio.created(), 1);

  const chimes = played.audio.tones.filter((tone) => tone.freq === CHIME_FREQ);
  assert.equal(chimes.length, 1);
  const due = played.timers.times();
  assert.equal(due.length > 0, true);
  assert.equal(chimes[0].when, 0);
  assert.equal(due[0], 400);
  assert.equal(chimes[0].when <= due[0] / 1000, true);
});

test("attach: a 20 second hold ticks on its last three seconds", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  assert.equal(tickCount(played), 0, "nothing sounds before its second comes");
  assert.deepEqual(tickSeconds(played, 25), [17, 18, 19]);

  const timed = harness();
  timed.control.onEvent(event({ segment: segment({ type: "timed", seconds: 20 }) }));
  assert.deepEqual(tickSeconds(timed, 25), []);
});

test("attach: tones only sound while the sound choice is on", () => {
  const played = harness();
  played.control.setSound(false);
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  played.timers.advance(25000);
  assert.deepEqual(played.audio.tones, []);
  assert.equal(played.audio.created(), 0);

  played.control.setSound(true);
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  played.timers.advance(25000);
  assert.equal(played.audio.tones.length, 4, "the chime and the three ticks");
});

test("attach: voice off schedules nothing spoken", () => {
  const played = harness();
  played.control.setVoice(false);
  played.control.onEvent(event());
  played.timers.advance(60000);
  assert.deepEqual(spokenTexts(played.voice), []);
});

test("attach: resume says its line and picks the cues up from where they were", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ seconds: 30 }) }));
  played.timers.advance(5000);
  const heard = spokenTexts(played.voice);
  assert.equal(heard.indexOf(LINES.paused), -1);

  played.control.onEvent({ type: "pause" });
  assert.deepEqual(spokenTexts(played.voice).slice(heard.length), [LINES.paused]);

  played.control.onEvent({
    type: "resume",
    segment: segment({ seconds: 30 }),
    next: null,
    ctx: ctx(),
    elapsed: 10,
  });
  const afterResume = spokenTexts(played.voice);
  assert.equal(afterResume[afterResume.length - 1], LINES.resume);

  played.timers.advance(6000);
  assert.equal(spokenTexts(played.voice).indexOf(LINES.midHold[0]) >= 0, true);

  played.timers.advance(20000);
  const finished = spokenTexts(played.voice);
  assert.equal(finished[finished.length - 1], LINES.close.hold);
});

/* ---------- the fixes the review asked for ---------- */

test("fix: a skip drops the ticks of the segment left behind", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  played.timers.advance(5000);
  assert.equal(tickCount(played), 0);

  played.control.onEvent(event({
    segment: segment({ type: "timed", seconds: 20, entryId: "pose-fold" }),
  }));
  assert.deepEqual(tickSeconds(played, 20), [], "the hold's ticks went with it");
});

test("fix: a pause takes the ticks still to come with it", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  played.timers.advance(10000);
  played.control.onEvent({ type: "pause" });
  assert.deepEqual(tickSeconds(played, 20), []);
});

test("fix: a resume plays each remaining tick once, on its own second", () => {
  const hold = segment({ type: "hold", seconds: 20 });
  const played = harness();
  played.control.onEvent(event({ segment: hold }));
  played.timers.advance(10000);
  played.control.onEvent({ type: "pause" });
  played.control.onEvent({
    type: "resume",
    segment: hold,
    next: null,
    ctx: ctx(),
    elapsed: 12,
  });

  /* Twelve seconds in, 17, 18 and 19 are still to come: five, six and seven
   * seconds after the clock starts again, each one once. */
  assert.equal(tickCount(played), 0, "a resume schedules no tick of its own on the spot");
  played.timers.advance(5000);
  assert.equal(tickCount(played), 1);
  played.timers.advance(1000);
  assert.equal(tickCount(played), 2);
  played.timers.advance(1000);
  assert.equal(tickCount(played), 3);
  played.timers.advance(10000);
  assert.equal(tickCount(played), 3, "nothing sounds twice");
});

test("fix: destroy takes the ticks still to come with it", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  played.timers.advance(5000);
  played.control.destroy();
  assert.deepEqual(tickSeconds(played, 20), []);
});

test("fix: a sound choice turned off silences the ticks already due", () => {
  const played = harness();
  played.control.onEvent(event({ segment: segment({ type: "hold", seconds: 20 }) }));
  played.timers.advance(5000);
  played.control.setSound(false);
  assert.deepEqual(tickSeconds(played, 20), []);
});

test("fix: a later line replaces the one still being said, the ones at the start do not", () => {
  const played = harness();
  /* Three reps in nine seconds: the counts fall at 1.5, 4.5 and 7.5, and the
   * close at 9. */
  const reps = segment({ type: "reps", seconds: 9, reps: 3, say: "Small circles" });
  played.control.onEvent(event({ segment: reps }));
  assert.equal(played.voice.state.cancels, 1, "the new segment cancels what ran before it");

  /* The lead-in and the segment's own line both fall at 0: the second one does
   * not cut the first off. */
  played.timers.advance(1400);
  assert.equal(played.voice.state.cancels, 1);
  assert.deepEqual(spokenTexts(played.voice), [
    fill(LINES.leadIn.next, { name: NAME }),
    reps.say,
  ]);

  played.timers.advance(100);
  assert.equal(played.voice.state.cancels, 2, "the first count replaces the line at the start");
  played.timers.advance(3000);
  assert.equal(played.voice.state.cancels, 3, "the second count replaces the first");
  played.timers.advance(3000);
  assert.equal(played.voice.state.cancels, 4, "the third count replaces the second");
  played.timers.advance(1500);
  assert.equal(played.voice.state.cancels, 5, "the close replaces the third count");
});

test("fix: a cue that was already spoken is not spoken again on a resume", () => {
  const reps = segment({ type: "reps", seconds: 40, reps: 4, say: "" });
  const played = harness();
  played.control.onEvent(event({ segment: reps, ctx: ctx({ entryStart: false }) }));
  played.timers.advance(20000);
  assert.deepEqual(spokenTexts(played.voice), [LINES.reps.numbers[0], LINES.reps.numbers[1]]);

  played.control.onEvent({ type: "pause" });
  played.control.onEvent({
    type: "resume",
    segment: reps,
    next: null,
    ctx: ctx({ entryStart: false }),
    elapsed: 20,
  });
  played.timers.advance(30000);

  const said = spokenTexts(played.voice);
  assert.equal(said.filter((line) => line === LINES.reps.numbers[0]).length, 1, "the first count is not said twice");
  assert.equal(said.filter((line) => line === LINES.reps.numbers[1]).length, 1, "nor the second");
  assert.equal(said.filter((line) => line === LINES.reps.numbers[2]).length, 1, "the counts still to come are said once");
  assert.equal(said.filter((line) => line === LINES.reps.lastRep).length, 1);
  assert.equal(said[said.length - 1], LINES.close.reps);
});

test("fix: a line due at the start that the pause came before is spoken on the resume", () => {
  const hold = segment({ seconds: 20 });
  const played = harness();
  played.control.onEvent(event({ segment: hold }));
  /* The line at the start waits out the chime's lead, so a pause inside that
   * first moment comes before it. */
  played.timers.advance(200);
  assert.deepEqual(spokenTexts(played.voice), []);

  played.control.onEvent({ type: "pause" });
  played.control.onEvent({
    type: "resume",
    segment: hold,
    next: null,
    ctx: ctx(),
    elapsed: 0.2,
  });
  played.timers.advance(1000);
  assert.deepEqual(spokenTexts(played.voice), [
    LINES.paused,
    LINES.resume,
    fill(LINES.leadIn.next, { name: NAME }),
    hold.say,
  ]);
});

test("fix: turning the voice off and on again keeps the segment's later lines", () => {
  const played = harness();
  played.control.onEvent(event({
    segment: segment({ type: "reps", seconds: 40, reps: 4, say: "" }),
    ctx: ctx({ entryStart: false }),
  }));
  played.timers.advance(5000);
  assert.deepEqual(spokenTexts(played.voice), [LINES.reps.numbers[0]]);

  played.control.setVoice(false);
  played.timers.advance(10000);
  assert.deepEqual(spokenTexts(played.voice), [LINES.reps.numbers[0]],
    "the count that came due while the voice was off is not heard");

  played.control.setVoice(true);
  played.timers.advance(30000);
  const said = spokenTexts(played.voice);
  assert.equal(said.indexOf(LINES.reps.numbers[1]), -1, "the count that went by stays unsaid");
  assert.equal(said.indexOf(LINES.reps.numbers[2]) >= 0, true, "the rest of the segment speaks");
  assert.equal(said[said.length - 1], LINES.close.reps);
});

test("fix: the voices property goes back to the handler that was there, and only ours", () => {
  const previous = function () {};
  const property = makeSpeech({ onVoicesProperty: true });
  property.synth.onvoiceschanged = previous;
  const played = harness({ speech: property.speech });
  assert.notEqual(property.synth.onvoiceschanged, previous,
    "the voice watches the property while it runs");

  played.control.destroy();
  assert.equal(property.synth.onvoiceschanged, previous, "the handler that was there comes back");

  /* A handler someone else puts in its place is theirs to keep. */
  const taken = makeSpeech({ onVoicesProperty: true });
  const other = function () {};
  const second = harness({ speech: taken.speech });
  taken.synth.onvoiceschanged = other;
  second.control.destroy();
  assert.equal(taken.synth.onvoiceschanged, other);
});

/* ---------- the toggles ---------- */

test("attach: the toggles flip a choice, repaint and destroy cleanly", () => {
  const played = harness();
  const container = findByRole(played.dom.host, "audio-controls");
  assert.notEqual(container, null);
  assert.equal(countByRole(played.dom.host, "audio-controls"), 1);

  const sound = findByRole(played.dom.host, "sound-toggle");
  assert.notEqual(sound, null);
  assert.equal(sound.textContent, COPY["player.sound"]);
  assert.equal(sound.attrs["aria-pressed"], "true");
  sound.click();
  assert.equal(played.control.soundOn(), false);
  assert.equal(played.storage.getItem("ramble.player.sound"), "0");
  const repainted = findByRole(played.dom.host, "sound-toggle");
  assert.notEqual(repainted, sound);
  assert.equal(repainted.attrs["aria-pressed"], "false");
  assert.deepEqual(sound.listeners, []);

  const voice = findByRole(played.dom.host, "voice-toggle");
  assert.notEqual(voice, null);
  assert.equal(voice.textContent, COPY["player.voice"]);
  voice.click();
  assert.equal(played.control.voiceOn(), false);
  assert.equal(played.storage.getItem("ramble.player.voice"), "0");

  played.control.destroy();
  assert.equal(findByRole(played.dom.host, "audio-controls"), null);
  assert.deepEqual(played.dom.host.children, []);
});

test("attach: a copy without a word leaves that control out", () => {
  const played = harness({ copy: {} });
  assert.notEqual(findByRole(played.dom.host, "audio-controls"), null);
  assert.equal(findByRole(played.dom.host, "sound-toggle"), null);
  assert.equal(findByRole(played.dom.host, "voice-toggle"), null);
  assert.equal(findByRole(played.dom.host, "voice-unavailable"), null);
});

test("attach: no host or doc means no controls and no throw", () => {
  const played = harness({ noDom: true });
  assert.equal(played.dom.host.children.length, 0);
  assert.doesNotThrow(() => {
    played.control.onEvent(event());
    played.timers.advance(3000);
    played.control.setSound(false);
    played.control.setVoice(false);
    played.control.destroy();
  });
});

/* ---------- availability: the three cases in focus ---------- */

test("attach: voice is there when the synthesiser names a voice", () => {
  const played = harness();
  assert.equal(played.control.available(), true);
  assert.notEqual(findByRole(played.dom.host, "voice-toggle"), null);
  assert.equal(findByRole(played.dom.host, "voice-unavailable"), null);
});

test("attach: no speech object at all is unavailable, with the note in its place", () => {
  const played = harness({ speech: null });
  assert.equal(played.control.available(), false);
  assert.notEqual(findByRole(played.dom.host, "sound-toggle"), null);
  assert.equal(findByRole(played.dom.host, "voice-toggle"), null);
  const note = findByRole(played.dom.host, "voice-unavailable");
  assert.notEqual(note, null);
  assert.equal(note.textContent, COPY["player.voiceUnavailable"]);
});

test("attach: an empty, a throwing or a shapeless voice list is unavailable", () => {
  const empty = harness({ speechConfig: { voices: [] } });
  assert.equal(empty.control.available(), false);
  assert.notEqual(findByRole(empty.dom.host, "voice-unavailable"), null);
  assert.equal(findByRole(empty.dom.host, "voice-toggle"), null);

  const refused = harness({ speechConfig: { getVoicesThrows: true } });
  assert.equal(refused.control.available(), false);
  assert.notEqual(findByRole(refused.dom.host, "voice-unavailable"), null);

  const shapeless = harness({ speechConfig: { getVoices: () => ({ length: 1 }) } });
  assert.equal(shapeless.control.available(), false);
  assert.notEqual(findByRole(shapeless.dom.host, "voice-unavailable"), null);
});

test("attach: voices that arrive late turn the note into the toggle", () => {
  let voices = [];
  const late = makeSpeech({ getVoices: () => voices });
  const played = harness({ speech: late.speech });
  assert.equal(played.control.available(), false);
  assert.notEqual(findByRole(played.dom.host, "voice-unavailable"), null);
  assert.equal(findByRole(played.dom.host, "voice-toggle"), null);

  voices = [{ name: "arrived", lang: "en-GB" }];
  late.fireVoicesChanged();
  assert.equal(played.control.available(), true);
  assert.equal(findByRole(played.dom.host, "voice-unavailable"), null);
  const toggle = findByRole(played.dom.host, "voice-toggle");
  assert.notEqual(toggle, null);
  assert.equal(toggle.textContent, COPY["player.voice"]);
  assert.equal(toggle.attrs["aria-pressed"], "true");

  let later = [];
  const property = makeSpeech({ getVoices: () => later, onVoicesProperty: true });
  const byProperty = harness({ speech: property.speech });
  assert.equal(byProperty.control.available(), false);
  later = [{ name: "arrived" }];
  property.fireVoicesChanged();
  assert.equal(byProperty.control.available(), true);
  assert.notEqual(findByRole(byProperty.dom.host, "voice-toggle"), null);
  assert.equal(findByRole(byProperty.dom.host, "voice-unavailable"), null);
});

test("attach: a full routine never throws without a voice", () => {
  assert.doesNotThrow(() => routine(harness({ speech: null })));
});

test("attach: a full routine never throws with an empty voice list", () => {
  assert.doesNotThrow(() => routine(harness({ speechConfig: { voices: [] } })));
});

test("attach: a full routine never throws while the voices are still coming", () => {
  let voices = [];
  const late = makeSpeech({ getVoices: () => voices });
  const played = harness({ speech: late.speech });
  assert.doesNotThrow(() => {
    played.control.onEvent(event());
    played.timers.advance(1000);
    assert.equal(played.control.available(), false);
    voices = [{ name: "arrived" }];
    late.fireVoicesChanged();
    assert.equal(played.control.available(), true);
    routine(played);
  });
});

test("attach: a synth whose speak and cancel throw never throws out of onEvent", () => {
  const played = harness({ speechConfig: { speakThrows: true, cancelThrows: true } });
  assert.doesNotThrow(() => {
    played.control.onEvent(event());
    played.timers.advance(2000);
    played.control.onEvent({ type: "pause" });
    played.timers.advance(1000);
    played.control.onEvent({
      type: "resume",
      segment: segment({ type: "hold", seconds: 20 }),
      next: null,
      ctx: ctx(),
      elapsed: 1,
    });
    played.timers.advance(40000);
    played.control.onEvent({ type: "ended" });
    played.control.onEvent(null);
    played.control.onEvent({});
    played.control.setVoice(false);
    played.control.setSound(false);
    played.control.destroy();
  });
});

/* ============ the player and the voice, in one page ============ */
/*
 * player.js reports every move, player-audio.js speaks to it, and the two
 * scripts are loaded here exactly as the panel loads them: plain script tags
 * into one context, over a fake DOM and an injected clock. The routine is the
 * panel's own chain shape, compiled by the session engine on the way in.
 */

const SESSION_SRC = readFileSync(join(MOVES, "session.cjs"), "utf8");
const FIGURE_SRC = readFileSync(join(MOVES, "figure.cjs"), "utf8");
const PLAYER_SRC = readFileSync(join(ROOT, "bundles", "ramble", "panel", "static", "player.js"), "utf8");

/* The routine the page plays: a warm-up hold, a counted set with a rest, and a
 * closing hold. */
const PAGE_LIB = [
  {
    id: "pose-reach",
    kind: "pose",
    title: "Reach up",
    minutes: 1,
    pose: { rootAngle: 4, shoulderL: 150, shoulderR: 150 },
    steps: [{ text: "Reach up tall", cue: "Reach up tall", say: "Reach up tall" }],
  },
  {
    id: "pose-fold",
    kind: "pose",
    title: "Fold forward",
    minutes: 1,
    pose: { rootAngle: 80, shoulderL: 40, shoulderR: 40 },
    steps: [{ text: "Fold forward", cue: "Fold forward", say: "Fold forward" }],
  },
  {
    id: "ex-arms",
    kind: "exercise",
    title: "Arm circles",
    minutes: 1,
    reps: 4,
    poses: [{ shoulderL: 20, shoulderR: 20 }, { shoulderL: 120, shoulderR: 120 }],
    steps: [{ text: "Small circles", cue: "Small circles", say: "Small circles" }],
  },
  {
    id: "chunk-page",
    kind: "routine",
    title: "Page routine",
    minutes: 10,
    rounds: 1,
    steps: [{ text: "warm-up, main, cool-down", cue: "warm-up", say: "warm-up" }],
    blocks: {
      warmup: [{ id: "pose-reach", seconds: 20 }],
      main: [{ id: "ex-arms", seconds: 30, restSeconds: 5 }, { id: "pose-reach", seconds: 20 }],
      cooldown: [{ id: "pose-fold", seconds: 20 }],
    },
  },
];
const PAGE_CHAIN = [{ chunkId: "chunk-page" }];
const PAGE_COPY = { ...COPY, start: "Start", safety: "" };

/* The smallest DOM the player and the voice's controls need between them. */
class PageNode {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.create(null);
    this.listeners = Object.create(null);
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.clientWidth = 0;
  }
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
  addEventListener(type, fn) {
    const list = this.listeners[type] || (this.listeners[type] = []);
    list.push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    this.listeners[type] = list.filter((one) => one !== fn);
  }
  setAttribute(name, value) {
    this.attrs[String(name)] = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }
  appendChild(child) {
    if (child.parentNode && typeof child.parentNode.removeChild === "function") {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((one) => one !== child);
    if (child && child.parentNode === this) child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  focus() {}
  blur() {}
  closest() {
    return null;
  }
  click() {
    (this.listeners.click || []).slice().forEach((fn) => fn({ target: this }));
  }
}

function pageRole(host, role) {
  const queue = host.children.slice();
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.getAttribute("data-role") === role) return node;
    if (node.children.length > 0) queue.push(...node.children);
  }
  return null;
}

/* session.cjs, figure.cjs, player.js and player-audio.js, in the order the
 * panel sends them, over one fake page. */
function pageBoot() {
  const host = new PageNode("div");
  const clock = {
    time: 0,
    intervals: [],
    now() {
      return this.time;
    },
    setInterval(fn) {
      this.intervals.push(fn);
      return this.intervals.length;
    },
    clearInterval() {},
  };
  const doc = {
    hidden: false,
    createElement: (tag) => new PageNode(tag),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = { console, document: doc, matchMedia: () => ({ matches: true }) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SESSION_SRC, { filename: "session.cjs" }).runInContext(sandbox);
  new vm.Script(FIGURE_SRC, { filename: "figure.cjs" }).runInContext(sandbox);
  new vm.Script(PLAYER_SRC, { filename: "player.js" }).runInContext(sandbox);
  new vm.Script(SOURCE, { filename: "player-audio.js" }).runInContext(sandbox);
  return { sandbox, host, clock, doc };
}

/* One page with the voice attached the way the panel attaches it: into a slot
 * of its own, which goes on the player's host once the player has built its
 * screen. */
function pageMount(config) {
  const cfg = config || {};
  const page = pageBoot();
  const timers = fakeTimers();
  const audio = makeAudio();
  const slot = page.doc.createElement("div");
  const voice = page.sandbox.window.RamblePlayerAudio.attach(null, {
    lines: cfg.lines === undefined ? LINES : cfg.lines,
    copy: COPY,
    guidance: "full",
    host: slot,
    doc: page.doc,
    storage: fakeStorage(),
    timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    speech: cfg.speech === undefined ? null : cfg.speech,
    audio: audio.factory,
  });
  const player = page.sandbox.RamblePlayer.mount(page.host, {
    chain: PAGE_CHAIN,
    library: PAGE_LIB,
    copy: PAGE_COPY,
    guidance: "full",
    clock: page.clock,
    reducedMotion: true,
    onEvent: (ev) => voice.onEvent(ev),
  });
  page.host.appendChild(slot);
  return { page, timers, audio, voice, player, slot };
}

/* One second of the session: the injected clock moves and the player's own
 * beat reads it, with the voice's timers running alongside. */
function pageSecond(played) {
  played.page.clock.time += 1000;
  const beat = played.page.clock.intervals[0];
  if (typeof beat === "function") beat();
  played.timers.advance(1000);
}

function pageRun(played) {
  const start = pageRole(played.page.host, "start");
  if (!start) return 0;
  start.click();
  let seconds = 0;
  while (!played.player.state().ended && seconds < 600) {
    pageSecond(played);
    seconds += 1;
  }
  return seconds;
}

/* Every string the shipped lines file carries, as a pattern that accepts a
 * filled placeholder. */
function linePatterns() {
  const strings = [];
  (function walk(value) {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  })(LINES);
  return strings.map((template) => {
    const parts = template.split(/\{[a-z]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp("^" + parts.join(".+") + "$");
  });
}

/* The words the library itself carries: a step's own text, cue and say are
 * spoken as they are. */
function libraryWords() {
  const out = new Set();
  (function walk(value) {
    if (typeof value === "string") out.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  })(PAGE_LIB);
  return out;
}

test("integration: a page with no voice at all plays the whole routine without a throw", () => {
  const played = pageMount({ speech: null });
  assert.equal(played.voice.available(), false, "this page has no voice to speak with");

  /* The two labels the controls carry are the copy's own words. */
  const sound = pageRole(played.page.host, "sound-toggle");
  assert.notEqual(sound, null);
  assert.equal(sound.textContent, COPY["player.sound"]);
  const note = pageRole(played.page.host, "voice-unavailable");
  assert.notEqual(note, null, "the note stands where the voice toggle would be");
  assert.equal(note.textContent, COPY["player.voiceUnavailable"]);
  assert.equal(pageRole(played.page.host, "voice-toggle"), null);

  let seconds = 0;
  assert.doesNotThrow(() => {
    seconds = pageRun(played);
  });
  assert.equal(played.player.state().ended, true, "the routine reached its end");
  assert.ok(seconds > 90 && seconds < 600, "it ran the timeline it was given");

  /* The tones are the voice's, and they were scheduled from the player's own
   * moves rather than by a timer of its own. */
  assert.equal(played.audio.created() > 0, true, "the tone context was made when the session started");
  assert.equal(played.audio.tones.some((tone) => tone.freq === CHIME_FREQ), true, "a chime marks the work segments");

  /* Nothing is left speaking once the player is taken down. */
  assert.doesNotThrow(() => {
    played.player.destroy();
    played.voice.destroy();
  });
  assert.equal(pageRole(played.page.host, "audio-controls"), null);
});

test("integration: with a voice present every spoken line is a shipped line or the library's own text", () => {
  const spoken = makeSpeech();
  const played = pageMount({ speech: spoken.speech });
  assert.equal(played.voice.available(), true);
  assert.notEqual(pageRole(played.page.host, "voice-toggle"), null);

  assert.doesNotThrow(() => pageRun(played));
  assert.equal(played.player.state().ended, true);

  const said = spokenTexts(spoken);
  assert.ok(said.length > 0, "the page's voice spoke during the routine");
  const patterns = linePatterns();
  const words = libraryWords();
  for (const line of said) {
    const shipped = patterns.some((pattern) => pattern.test(line));
    assert.ok(shipped || words.has(line), "neither a shipped line nor the library's own text: " + line);
  }
});

