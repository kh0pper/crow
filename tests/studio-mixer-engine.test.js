/**
 * Studio mixer engine tests — chains, sends, returns and the metered master,
 * run in this thread, a block at a time (plan 1d, Task 9).
 *
 * `engine/studio-processor.js` is composed exactly as `engine-client.js`
 * composes it (`SOURCE_FILES`) and evaluated with the three worklet globals it
 * reads (`sampleRate`, `currentFrame`, `AudioWorkletProcessor`/`registerProcessor`)
 * supplied as arguments. No SunVox glue and no native audio: every song here is
 * built from AUDIO tracks, whose PCM voices are plain JavaScript, so a test can
 * say exactly what the master has to be, sample for sample, and can post a
 * message between two blocks — which is the only honest way to watch a chain
 * edit take effect mid-song. (The one exception is the last test, which builds
 * the real `engine-client.js` on an `OfflineAudioContext` to prove the meter,
 * the master latency and an insert fault reach a page through the port.)
 *
 * What is pinned:
 *
 *   - **The one signal path** the plan fixes: a track's inserts, then its fader
 *     and pan, then its sends (pre or post fader); a return's inserts then its
 *     fader; the sum into the master; the looper and the performance bus; the
 *     master gain and the master's inserts; then the meter and the clip.
 *   - **Sends** (`a send feeds its return pre and post fader`) — a pre send is
 *     tapped before the fader and a post send after it, and the return's own
 *     fader and pan land on both.
 *   - **Editing a chain while the song plays** (Review Focus 3): the fade is
 *     armed once and counts down per FRAME, so it lands on exactly 64 frames even
 *     when a motion curve splits a block into 32-frame runs; a second edit that
 *     lands mid-fade continues the ramp instead of restarting it; removing every
 *     insert fades out once; and the inserts an edit did not touch are never
 *     rebuilt — a reverb keeps its tail and a master limiter its delay line.
 *   - **A REPLACED segment runs both of its sides in parallel**: an insert deleted
 *     and another added in its place, an id given another kind, or the whole chain
 *     reordered. Faded one after the other the level swells (+1 to +4 dB), and the
 *     arriving insert runs on the leaving one's OUTPUT, so a new delay replays the
 *     echoes of the effect it replaced. The arriving path is primed before the
 *     weight moves, so a rebuilt master limiter holds the ceiling and does not
 *     move the time base.
 *   - **Bypass and a fault are undone from silence**: an insert that sat out a
 *     bypass (or was bypassed by the NaN guard and then armed again) starts again
 *     from a reset state, primed by its own latency and faded back in, so a
 *     limiter does not replay its old lookahead and a delay does not replay its
 *     old echoes. The master's reported delay follows the weight, so it crosses at
 *     the fade's midpoint (and a faulted limiter stops counting at once).
 *   - **A failed insert** (Review Focus 3): a block that comes back with a NaN is
 *     replaced by that insert's input, the insert is bypassed in the ENGINE (the
 *     song is never edited) and the fault is said once — an unrelated edit leaves
 *     it bypassed, and only its OWN parameters moving arms it again (once).
 *   - **A Faust insert whose module has not arrived** passes audio through and
 *     says so once, as `insert_loading` (its own message, not an engine error),
 *     and becomes a real effect when the modules land. An insert whose kind can
 *     never be built is not rebuilt on every edit.
 *   - **The meter**: the same BS.1770-4 gating `server/loudness.js` measures a
 *     render with, within 0.1 LU, and the same 4× true-peak filter; the processor
 *     posts a reading every 100 ms of audio and once on stop; and the integrated
 *     measurement's cost does not grow with the length of a Play (a fixed
 *     histogram of gating blocks, not a list). Its one approximation is measured
 *     too: a signal whose blocks sit within a bin of the relative gate is judged
 *     by that bin, which is worth up to about a LU — libebur128's own trade.
 *   - **Mute and solo** reach the sends, and a return is never muted by a solo.
 *   - **The master limiter** holds its ceiling after the performance-effects bus,
 *     and a master tap is stamped with the master chain's latency taken off so a
 *     master resample lines up with a track's.
 *   - **The CPU gate**: 8 tracks × (eq, compressor, delay), 2 returns (reverb and
 *     delay) and a master limiter render 30 s of audio faster than real time.
 *   - **The two duplicated tables**: the effect labels and the dynamics kinds the
 *     processor carries because a worklet cannot import `server/doc.js` are held
 *     against the document's own.
 *   - **The port**: the engine client's `onMeter`, `onMasterLatency`,
 *     `onInsertFault` and `lastMeter()` are what the mixer screen subscribes to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The document's tables and the render's meter: what the engine has to agree with.
import { EFFECT_PARAMS } from "../bundles/studio/server/doc.js";
import { integratedLufs, truePeakDb } from "../bundles/studio/server/loudness.js";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const FAUST_DIR = fileURLToPath(new URL("../bundles/studio/vendor/faust/", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own resolution, from inside the bundle (that is where the
// package's `"commonjs"` override for `engine/` applies).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));
const StudioMeter = bundleRequire(join(ENGINE_DIR, "meter.js"));
const StudioDynamics = bundleRequire(join(ENGINE_DIR, "dynamics.js"));
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

const SAMPLE_RATE = 48000;
const BLOCK = 128;

/** Four beats to the bar at 120 bpm: one bar of frames. */
const BAR_FRAMES = 96000;

/** The smallest valid wasm module: enough for the processor's own compile. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** The engine's own sources, read from the bundle exactly as a Node caller would. */
const SOURCE_NAMES = Object.freeze([
  "sequencer.js",
  "resample.js",
  "sampler-voice.js",
  "perf-fx.js",
  "meter.js",
  "dynamics.js",
  "faust-host.js",
  "studio-processor.js",
]);

/**
 * A stand-in for `engine/dynamics.js`: every insert of its four kinds is a plain
 * gain of `factor`. It is how a test says exactly what a chain does to a block —
 * and, with `NaN`, how it makes an insert produce the invalid sample the NaN
 * guard has to catch. NOT product code.
 * @param {number} factor the gain every insert applies
 * @param {string[]} [nanKinds] the kinds whose insert writes NaN instead
 * @param {{buildsKey?: string, brokenKinds?: string[], nanOnceKinds?: string[],
 *          latencyFrames?: number}} [extra] `buildsKey`
 *   records every `create` and `reset` on `globalThis[buildsKey]` (as
 *   `"create:<kind>"` / `"reset:<kind>"`); `brokenKinds` are kinds whose `create`
 *   throws, so their insert can never be built; `nanOnceKinds` are kinds that
 *   write NaN on the first block they are ever handed and behave afterwards (an
 *   insert that blew up once); `latencyFrames` is the delay every insert claims
 *   (a limiter's lookahead, without a limiter's arithmetic)
 * @returns {string} one classic script, ready to be concatenated into the module
 */
function stubDynamicsSource(factor, nanKinds = [], extra = {}) {
  const buildsKey = typeof extra.buildsKey === "string" ? extra.buildsKey : "";
  const brokenKinds = Array.isArray(extra.brokenKinds) ? extra.brokenKinds : [];
  const nanOnceKinds = Array.isArray(extra.nanOnceKinds) ? extra.nanOnceKinds : [];
  const latencyFrames = Number.isFinite(extra.latencyFrames) ? extra.latencyFrames : 0;
  return [
    "(function () {",
    '  "use strict";',
    '  const KINDS = Object.freeze(["compressor", "limiter", "gate", "deesser"]);',
    `  const NAN_KINDS = ${JSON.stringify(nanKinds)};`,
    `  const NAN_ONCE_KINDS = ${JSON.stringify(nanOnceKinds)};`,
    `  const BROKEN_KINDS = ${JSON.stringify(brokenKinds)};`,
    `  const BUILDS_KEY = ${JSON.stringify(buildsKey)};`,
    `  const FACTOR = ${factor};`,
    `  const LATENCY = ${latencyFrames};`,
    "  function record(entry) {",
    '    if (BUILDS_KEY === "") return;',
    "    globalThis[BUILDS_KEY].push(entry);",
    "  }",
    "  function create(kind, rate) {",
    '    record("create:" + kind);',
    "    if (BROKEN_KINDS.indexOf(kind) !== -1) throw new Error('this insert will not build');",
    "    const poison = NAN_KINDS.indexOf(kind) !== -1;",
    "    let poisonedOnce = NAN_ONCE_KINDS.indexOf(kind) !== -1;",
    "    return {",
    "      kind: kind,",
    "      rate: rate,",
    "      latencyFrames: LATENCY,",
    "      setParams: function setParams() {},",
    '      reset: function reset() { record("reset:" + kind); },',
    "      params: function params() { return {}; },",
    "      process: function process(left, right, frames) {",
    '        record("process:" + frames);',
    "        const once = poisonedOnce;",
    "        poisonedOnce = false;",
    "        for (let index = 0; index < frames; index += 1) {",
    "          if (poison || once) {",
    "            left[index] = NaN;",
    "            if (right) right[index] = NaN;",
    "          } else {",
    "            left[index] *= FACTOR;",
    "            if (right) right[index] *= FACTOR;",
    "          }",
    "        }",
    "      },",
    "    };",
    "  }",
    "  globalThis.StudioDynamics = { create: create, KINDS: KINDS };",
    "})();",
  ].join("\n");
}

/** The composed processor classes, one per set of sources (composed once each). */
const CLASSES = new Map();

/**
 * Which sources were evaluated LAST. Each composition assigns the engine
 * modules' globals (`StudioDynamics`, `StudioFaustHost`, …) on the real global
 * object, so the module a processor finds at call time is whichever was
 * evaluated last: a class is only reused when it is still that one, or a test
 * that composed a stub would keep running the stub.
 */
let LAST_KEY = null;

/**
 * Compose the worklet module exactly as `engine-client.js` composes it
 * (`SOURCE_FILES`) — or with one of the sources replaced — and evaluate it with
 * stand-in worklet globals, handing back the processor class it registered.
 * @param {{dynamics?: string}} [replace] a source to use instead of the real one
 * @returns {Function} the processor class
 */
function processorClass(replace) {
  const key = replace && replace.dynamics !== undefined ? `dynamics:${replace.dynamics}` : "real";
  const cached = CLASSES.get(key);
  if (cached && LAST_KEY === key) return cached;
  const texts = SOURCE_NAMES.map((name) => {
    if (replace && name === "dynamics.js" && replace.dynamics !== undefined) return replace.dynamics;
    return readFileSync(join(ENGINE_DIR, name), "utf8");
  });
  const source = studioEngine.composeEngineModule(texts);
  let registered = null;
  // The worklet globals `studio-processor.js` reads. `sampleRate` and
  // `currentFrame` are bare identifiers there, so they are parameters here.
  class StandInProcessor {
    constructor() {
      /** Everything this processor posts, in order. */
      this.posts = [];
      this.port = {
        onmessage: null,
        postMessage: (message) => this.posts.push(message),
        start() {},
      };
    }
  }
  const evaluate = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", source);
  evaluate(
    StandInProcessor,
    (name, cls) => {
      registered = { name: name, cls: cls };
    },
    SAMPLE_RATE,
    0,
  );
  assert.ok(registered, "the module has to register the studio processor");
  CLASSES.set(key, registered.cls);
  LAST_KEY = key;
  return registered.cls;
}

/** @returns {Promise<void>} a couple of macrotasks, so promise work settles. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Wait for something the processor posts to arrive.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether it happened in time
 */
async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle();
  return predicate();
}

/** @returns {object} one audio track. */
function audioTrack(index, overrides = {}) {
  return {
    id: `track-${index}`,
    name: `Track ${index}`,
    color: "#8FC1E8",
    device: { engine: "audio" },
    mute: false,
    solo: false,
    gain_db: 0,
    pan: 0,
    locked: false,
    ...overrides,
  };
}

/**
 * A song of audio tracks, each playing one bar of `take-1`.
 * @param {{tracks?: object[], inserts?: object, sends?: object, returns?: object,
 *          master?: object}} [parts]
 * @returns {object}
 */
function audioSong(parts = {}) {
  const tracks = parts.tracks || [audioTrack(1)];
  const clips = {};
  for (const track of tracks) {
    clips[`clip-${track.id}`] = {
      id: `clip-${track.id}`,
      track_id: track.id,
      scene_id: "scene-1",
      name: track.name,
      length_bars: 1,
      kind: "audio",
      notes: [],
      comp: [{ take_id: "take-1", from_beat: 0, to_beat: 4 }],
    };
  }
  return {
    meta: { title: "Mixer engine probe", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: tracks,
    scenes: [{ id: "scene-1", name: "A" }],
    clips: clips,
    takes: {
      "take-1": { id: "take-1", clip_id: `clip-${tracks[0].id}`, rate: SAMPLE_RATE, offset_frames: 0, discarded: false },
    },
    inserts: parts.inserts || {},
    sends: parts.sends || {},
    returns: parts.returns || {},
    master: parts.master || { gain_db: 0, target: { lufs: -14, true_peak_db: -1 } },
    arrangement: { placements: {}, markers: {}, sections: {} },
  };
}

/** @returns {object} one insert, as `server/doc.js`'s snapshot carries it. */
function insertOf(id, owner, order, kind, params, bypass = false) {
  return { id: id, owner: owner, order: order, kind: kind, bypass: bypass, params: params };
}

/** @returns {Float32Array} one bar of a constant level, at the context's rate. */
function takeOf(level) {
  const samples = new Float32Array(BAR_FRAMES);
  samples.fill(level);
  return samples;
}

/**
 * One bar of a 200 Hz tone, at the context's rate. A constant level would be
 * DC, which the K-weighting's 38 Hz high-pass takes away — a meter reading of a
 * DC master drains to silence — so a meter test needs a tone.
 * @param {number} level
 * @param {number} [hz]
 * @returns {Float32Array}
 */
function toneTake(level, hz = 200) {
  const samples = new Float32Array(BAR_FRAMES);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * hz * index) / SAMPLE_RATE) * level;
  }
  return samples;
}

/**
 * A processor running the real worklet code, driven block by block.
 * @param {object} song the snapshot to play
 * @param {{dynamics?: string, take?: number, hold?: object[], blocks?: number}} [plan]
 * @returns {Promise<object>} the host: `post`, `flush`, `run`, `posts`
 */
async function host(song, plan = {}) {
  const ProcessorClass = processorClass(plan.dynamics === undefined ? undefined : { dynamics: plan.dynamics });
  const processor = new ProcessorClass({ processorOptions: { wasmBinary: EMPTY_WASM } });
  const posts = processor.posts;
  await settle();
  const ready = await waitFor(() => posts.some((message) => message.type === "ready"));
  assert.ok(ready, `the processor has to come up and report ready, it posted ${JSON.stringify(posts)}`);

  /** @param {object} message @returns {void} */
  const post = (message) => {
    processor.port.onmessage({ data: message });
  };

  /** @returns {Promise<void>} resolves once the processor applied everything posted. */
  const flush = async () => {
    let id = 0;
    for (const message of posts) if (message.type === "flushed") id = Math.max(id, message.id);
    id += 1;
    processor.port.onmessage({ data: { type: "flush", id: id } });
    const applied = await waitFor(() => posts.some((message) => message.type === "flushed" && message.id === id));
    if (!applied) throw new Error("the processor never answered a flush");
  };

  post({ type: "song", snapshot: song });
  const take = plan.takeSamples instanceof Float32Array ? plan.takeSamples : takeOf(plan.take === undefined ? 0.4 : plan.take);
  post({ type: "audio", take_id: "take-1", channels: [take] });
  for (const item of plan.hold || []) post({ type: "fx", name: item.name, amount: item.amount, on: true });
  post({ type: "launchScene", id: "scene-1" });
  post({ type: "play" });
  await flush();

  return {
    post: post,
    flush: flush,
    posts: posts,
    /**
     * Render `blocks` blocks and hand back the master.
     *
     * `size` is how many frames each `process()` call is handed, so a test can
     * render a part of a block (which is how a chain edit is caught mid-fade).
     * @param {number} blocks
     * @param {number} [size]
     * @returns {{left: Float32Array, right: Float32Array}}
     */
    run(blocks, size = BLOCK) {
      const total = blocks * size;
      const left = new Float32Array(total);
      const right = new Float32Array(total);
      for (let index = 0; index < blocks; index += 1) {
        const start = index * size;
        const channels = [left.subarray(start, start + size), right.subarray(start, start + size)];
        processor.process([], [channels]);
      }
      return { left: left, right: right };
    },
  };
}

/** @returns {number} the largest |sample| of a run. */
function peakOf(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * The SMALLEST peak of any window of `size` frames in a stretch of a run: the
 * level the audio never drops below there, whatever the phase of the signal does
 * inside a window. A dropout or a pair of sources out of phase with each other
 * shows up in it, where the peak of the whole stretch would not.
 * @param {Float32Array} samples
 * @param {number} from
 * @param {number} to
 * @param {number} size frames per window
 * @returns {number}
 */
function leastWindowPeak(samples, from, to, size) {
  let least = Infinity;
  for (let start = from; start + size <= to; start += size) {
    let peak = 0;
    for (let at = start; at < start + size; at += 1) {
      const value = Math.abs(samples[at]);
      if (value > peak) peak = value;
    }
    if (peak < least) least = peak;
  }
  return least === Infinity ? 0 : least;
}

/** @returns {number} the first index where two runs differ, or -1. */
function firstDifference(out, other, from = 0) {
  const count = Math.min(out.left.length, other.left.length);
  for (let index = from; index < count; index += 1) {
    if (out.left[index] !== other.left[index] || out.right[index] !== other.right[index]) return index;
  }
  return -1;
}

/** @returns {number} the largest frame-to-frame step of a run's left channel. */
function largestStep(out, from = 0, to = out.left.length) {
  let step = 0;
  for (let index = Math.max(1, from); index < to; index += 1) {
    const value = Math.abs(out.left[index] - out.left[index - 1]);
    if (value > step) step = value;
  }
  return step;
}

/**
 * The root-mean-square of a run's left channel over a window.
 * @param {{left: Float32Array}} out
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function rmsOf(out, from, to) {
  let sum = 0;
  let count = 0;
  for (let index = Math.max(0, from); index < Math.min(out.left.length, to); index += 1) {
    sum += out.left[index] * out.left[index];
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** @returns {number} a level in dB as an amplitude. */
function amplitudeOf(db) {
  return Math.pow(10, db / 20);
}

/** The direct level of a track at 0 dB and centre: 0.4 × cos(π/4). */
const DIRECT = 0.4 * Math.cos(Math.PI / 4);

/** The constant-power gain of a centred pan, which a return's own fader applies. */
const CENTRE = Math.cos(Math.PI / 4);

/** @returns {object} one sampler track (silent unless a pad is triggered). */
function samplerTrack(overrides = {}) {
  return audioTrack(1, { name: "Curve", device: { engine: "sampler" }, ...overrides });
}

/**
 * A song whose blocks are cut into 32-frame runs: a silent sampler track whose
 * pattern carries a motion curve (the motion grid is what splits a block into
 * runs), plus the audio track under test. The sampler plays no step and has no
 * PCM loaded, so the master is the audio track's chain output alone.
 * @param {object} [parts] the same parts `audioSong` takes
 * @returns {object}
 */
function motionSong(parts = {}) {
  const song = audioSong({ ...parts, tracks: [samplerTrack(), audioTrack(2)] });
  song.clips["clip-track-1"] = {
    id: "clip-track-1",
    track_id: "track-1",
    scene_id: "scene-1",
    name: "Curve",
    length_bars: 1,
    length_steps: 16,
    step_beats: 0.25,
    swing: 0,
    chain: [],
    kind: "pattern",
    notes: [],
  };
  song.patterns = {
    "clip-track-1/a": {
      id: "a",
      clip_id: "clip-track-1",
      name: "A",
      order: 0,
      motion: {
        "bank-a.0|gain_db": [
          { step_frac: 0, value: -60 },
          { step_frac: 15, value: -6 },
        ],
      },
    },
  };
  return song;
}

test("a send feeds its return pre and post fader", async () => {
  const returns = { "ret-1": { id: "ret-1", name: "Hall", gain_db: 0, pan: 0, mute: false } };
  const sendOf = (pre, levelDb = 0) => ({
    "track-1/ret-1": { track_id: "track-1", return_id: "ret-1", level_db: levelDb, pre: pre },
  });

  // No send at all: the return is silent and the master is the track alone.
  const dry = (await host(audioSong({ returns }))).run(2);
  assert.ok(
    Math.abs(dry.left[BLOCK] - DIRECT) < 1e-6,
    `the dry master has to be the track's own output, got ${dry.left[BLOCK]} for ${DIRECT}`,
  );

  // A POST send taps the fader's output (the track at 0 dB, so DIRECT) and the
  // return applies its own 0 dB centre fader: DIRECT × cos(π/4) more.
  const post = (await host(audioSong({ returns, sends: sendOf(false) }))).run(2);
  const wantedPost = DIRECT + DIRECT * CENTRE;
  assert.ok(
    Math.abs(post.left[BLOCK] - wantedPost) < 1e-6,
    `a post send has to add the fader's output through the return (${wantedPost}), got ${post.left[BLOCK]}`,
  );

  // A PRE send taps the chain's output BEFORE the fader and the pan: the mono
  // 0.4 take itself, not its 0 dB centre level.
  const pre = (await host(audioSong({ returns, sends: sendOf(true) }))).run(2);
  const wantedPre = DIRECT + 0.4 * CENTRE;
  assert.ok(
    Math.abs(pre.left[BLOCK] - wantedPre) < 1e-6,
    `a pre send has to add the pre-fader signal through the return (${wantedPre}), got ${pre.left[BLOCK]}`,
  );

  // Turn the track down 6 dB: the track halves, the PRE send does not move, the
  // POST send halves with the fader. That is the whole difference between them.
  const quiet = [audioTrack(1, { gain_db: -6 })];
  const half = amplitudeOf(-6);
  const quietPre = (await host(audioSong({ tracks: quiet, returns, sends: sendOf(true) }))).run(2);
  const quietPost = (await host(audioSong({ tracks: quiet, returns, sends: sendOf(false) }))).run(2);
  assert.ok(
    Math.abs(quietPre.left[BLOCK] - (DIRECT * half + 0.4 * CENTRE)) < 1e-6,
    `a pre send is before the fader, so −6 dB must not move it, got ${quietPre.left[BLOCK]}`,
  );
  assert.ok(
    Math.abs(quietPost.left[BLOCK] - (DIRECT * half + DIRECT * half * CENTRE)) < 1e-6,
    `a post send is after the fader, so −6 dB must halve it too, got ${quietPost.left[BLOCK]}`,
  );
});

test("mute and solo apply to sends", async () => {
  const returns = { "ret-1": { id: "ret-1", name: "Hall", gain_db: 0, pan: 0, mute: false } };
  const bothSends = {
    "track-1/ret-1": { track_id: "track-1", return_id: "ret-1", level_db: 0, pre: false },
    "track-2/ret-1": { track_id: "track-2", return_id: "ret-1", level_db: 0, pre: true },
  };

  // A muted track's sends are silent, pre and post alike: the master is exactly
  // the same song with no sends in it at all, bit for bit.
  const muted = [audioTrack(1, { mute: true }), audioTrack(2, { mute: true })];
  const mutedWithSends = (await host(audioSong({ tracks: muted, returns, sends: bothSends }))).run(3);
  const mutedWithout = (await host(audioSong({ tracks: muted, returns }))).run(3);
  assert.equal(firstDifference(mutedWithSends, mutedWithout), -1, "a muted track's sends have to be silent");

  // A soloed track's sends play: the soloed track's send adds its return level.
  const soloQuiet = [audioTrack(1, { solo: true }), audioTrack(2, { mute: true })];
  const soloWith = (await host(audioSong({ tracks: soloQuiet, returns, sends: {
    "track-1/ret-1": { track_id: "track-1", return_id: "ret-1", level_db: 0, pre: false },
  } }))).run(3);
  const soloWithout = (await host(audioSong({ tracks: soloQuiet, returns }))).run(3);
  assert.ok(
    Math.abs(soloWith.left[BLOCK] - soloWithout.left[BLOCK] - DIRECT * CENTRE) < 1e-6,
    `a soloed track's send has to play: ${soloWithout.left[BLOCK]} → ${soloWith.left[BLOCK]}`,
  );

  // A track another track's solo silences sends nothing either.
  const soloElsewhere = [audioTrack(1), audioTrack(2, { solo: true, mute: true })];
  const keptWith = (await host(audioSong({ tracks: soloElsewhere, returns, sends: bothSends }))).run(3);
  const keptWithout = (await host(audioSong({ tracks: soloElsewhere, returns }))).run(3);
  assert.equal(
    firstDifference(keptWith, keptWithout),
    -1,
    "a track another track's solo silences must not feed a return",
  );

  // The return is never muted by a solo: the soloed track's send still arrives
  // while the OTHER track is silenced.
  const soloedReturn = [audioTrack(1, { solo: true }), audioTrack(2, { mute: true })];
  const soloReturn = (await host(audioSong({ tracks: soloedReturn, returns, sends: {
    "track-1/ret-1": { track_id: "track-1", return_id: "ret-1", level_db: -6, pre: false },
  } }))).run(2);
  assert.ok(
    Math.abs(soloReturn.left[BLOCK] - (DIRECT + DIRECT * amplitudeOf(-6) * CENTRE)) < 1e-6,
    `the return has to play at the soloed track's send level, got ${soloReturn.left[BLOCK]}`,
  );
});

test("editing a chain while playing crossfades", async () => {
  // Every insert of this engine halves its input, so the two sides of the fade
  // are two exact numbers: DIRECT before the insert and DIRECT / 2 after it.
  const dynamics = stubDynamicsSource(0.5);
  const drySong = audioSong();
  const editedSong = audioSong({
    inserts: { "ins-half": insertOf("ins-half", "track:track-1", 1, "compressor", {}) },
  });

  const hostUnderTest = await host(drySong, { dynamics });
  const before = hostUnderTest.run(4);
  assert.ok(Math.abs(before.left[BLOCK * 3] - DIRECT) < 1e-6, "the unedited track has to play at its own level");

  // The edit arrives while the song plays: the next block swaps the chain in and
  // crossfades old → new over exactly 64 frames.
  hostUnderTest.post({ type: "song", snapshot: editedSong });
  await hostUnderTest.flush();
  const after = hostUnderTest.run(2);

  const oldLevel = DIRECT;
  const newLevel = DIRECT / 2;
  for (let at = 0; at < 64; at += 1) {
    // 1/64 of the way on the first frame, all the way on the 64th.
    const weight = (at + 1) / 64;
    const wanted = newLevel * weight + oldLevel * (1 - weight);
    assert.ok(
      Math.abs(after.left[at] - wanted) < 1e-6,
      `frame ${at} of the crossfade has to be ${wanted}, got ${after.left[at]}`,
    );
  }
  assert.ok(
    Math.abs(after.left[64] - newLevel) < 1e-7,
    `the 64th frame is the new chain's own output (${newLevel}), got ${after.left[64]}`,
  );
  assert.ok(
    Math.abs(after.left[BLOCK] - newLevel) < 1e-7,
    `and it stays there (${newLevel}), got ${after.left[BLOCK]}`,
  );

  // No click: no step is bigger than the ramp's own step (plus rounding).
  const ramp = Math.abs(oldLevel - newLevel) / 64;
  assert.ok(
    largestStep(after, 0, 2 * BLOCK) <= ramp + 1e-7,
    `the crossfade must not step more than its own ramp (${ramp}), largest step was ${largestStep(after, 0, 2 * BLOCK)}`,
  );

  // With the transport stopped there is no fade at all: the first block already
  // plays the new chain.
  const stopped = await host(editedSong, { dynamics });
  const stoppedOut = stopped.run(1);
  assert.ok(
    Math.abs(stoppedOut.left[0] - newLevel) < 1e-7,
    `a chain built before Play needs no crossfade, got ${stoppedOut.left[0]} for ${newLevel}`,
  );
});

test("a chain edit fades over exactly 64 frames while a motion curve splits the block", async () => {
  // A motion curve cuts every block into 32-frame runs, so this is the case the
  // fade used to lose: a fade that restarted per run could never finish. The
  // insert's own process() calls prove the runs really are that short.
  const key = "__builds_motion_fade";
  globalThis[key] = [];
  const dynamics = stubDynamicsSource(0.5, [], { buildsKey: key });
  const plain = motionSong();
  const edited = motionSong({
    inserts: { "ins-half": insertOf("ins-half", "track:track-2", 1, "compressor", {}) },
  });

  const hostUnderTest = await host(plain, { dynamics });
  const before = hostUnderTest.run(4);
  assert.ok(
    Math.abs(before.left[BLOCK * 3] - DIRECT) < 1e-6,
    `the unedited track has to play at its own level, got ${before.left[BLOCK * 3]}`,
  );

  hostUnderTest.post({ type: "song", snapshot: edited });
  await hostUnderTest.flush();
  const after = hostUnderTest.run(2);

  const oldLevel = DIRECT;
  const newLevel = DIRECT / 2;
  for (let at = 0; at < 64; at += 1) {
    // 1/64 of the way on the first frame, all the way on the 64th — counted in
    // frames, so the runs the curve cut the block into cannot restart it.
    const weight = (at + 1) / 64;
    const wanted = newLevel * weight + oldLevel * (1 - weight);
    assert.ok(
      Math.abs(after.left[at] - wanted) < 1e-6,
      `frame ${at} of the fade has to be ${wanted}, got ${after.left[at]}`,
    );
  }
  assert.ok(
    Math.abs(after.left[64] - newLevel) < 1e-7,
    `the 64th frame is the new chain's own output (${newLevel}), got ${after.left[64]}`,
  );
  assert.ok(
    Math.abs(after.left[BLOCK] - newLevel) < 1e-7,
    `and it stays there (${newLevel}), got ${after.left[BLOCK]}`,
  );

  // The motion grid was really in play: the insert only ever saw 32-frame runs.
  const runs = globalThis[key].filter((entry) => entry.startsWith("process:"));
  assert.ok(runs.length >= 8, `the insert has to have run, got ${runs.length} calls`);
  for (const entry of runs) {
    assert.equal(entry, "process:32", "a motion curve has to cut every block into 32-frame runs");
  }

  const ramp = Math.abs(oldLevel - newLevel) / 64;
  assert.ok(
    largestStep(after, 0, 2 * BLOCK) <= ramp + 1e-7,
    `the fade must not step more than its own ramp (${ramp}), largest step was ${largestStep(after, 0, 2 * BLOCK)}`,
  );
});

test("a second edit during a fade does not click or restart from zero", async () => {
  const dynamics = stubDynamicsSource(0.5);
  const one = audioSong({
    inserts: { "ins-a": insertOf("ins-a", "track:track-1", 1, "compressor", {}) },
  });
  const two = audioSong({
    inserts: {
      "ins-a": insertOf("ins-a", "track:track-1", 1, "compressor", {}),
      "ins-b": insertOf("ins-b", "track:track-1", 2, "compressor", {}),
    },
  });

  const hostUnderTest = await host(audioSong(), { dynamics });
  hostUnderTest.run(2);

  // Edit one, then catch it a third of the way through its fade.
  hostUnderTest.post({ type: "song", snapshot: one });
  await hostUnderTest.flush();
  const first = hostUnderTest.run(1, 20);
  for (let at = 0; at < 20; at += 1) {
    const wet = (at + 1) / 64;
    const wanted = DIRECT * (1 - 0.5 * wet);
    assert.ok(
      Math.abs(first.left[at] - wanted) < 1e-6,
      `frame ${at} of the first fade has to be ${wanted}, got ${first.left[at]}`,
    );
  }

  // A second edit arrives while insert A is still fading in. It must keep A's
  // weight where it was (a continuation, not a restart) and fade B in on top.
  hostUnderTest.post({ type: "song", snapshot: two });
  await hostUnderTest.flush();
  const second = hostUnderTest.run(1, 20);
  for (let at = 0; at < 20; at += 1) {
    const wetA = (21 + at) / 64;
    const wetB = (at + 1) / 64;
    const wanted = DIRECT * (1 - 0.5 * wetA) * (1 - 0.5 * wetB);
    assert.ok(
      Math.abs(second.left[at] - wanted) < 1e-6,
      `frame ${at} after the second edit has to be ${wanted}, got ${second.left[at]}`,
    );
  }
  // The tell for a restart: the dry level again, which is what A had already
  // faded away from.
  assert.ok(
    second.left[0] < DIRECT * 0.93,
    `the second edit must not restart the first fade, got ${second.left[0]} for ${DIRECT}`,
  );
  const ramp = DIRECT / 64;
  assert.ok(
    largestStep(second) <= ramp + 1e-7,
    `no frame of the joined fade may step more than one ramp step (${ramp}), largest step was ${largestStep(second)}`,
  );
});

test("removing every insert while playing fades once", async () => {
  const dynamics = stubDynamicsSource(0.5);
  const withInsert = audioSong({
    inserts: { "ins-half": insertOf("ins-half", "track:track-1", 1, "compressor", {}) },
  });
  const hostUnderTest = await host(withInsert, { dynamics });
  const before = hostUnderTest.run(4);
  assert.ok(
    Math.abs(before.left[BLOCK * 3] - DIRECT / 2) < 1e-7,
    `the insert has to halve the track, got ${before.left[BLOCK * 3]}`,
  );

  hostUnderTest.post({ type: "song", snapshot: audioSong() });
  await hostUnderTest.flush();
  const after = hostUnderTest.run(2);
  for (let at = 0; at < 64; at += 1) {
    // The insert's weight goes 1 → 0 over 64 frames, so its output fades back
    // to the dry track exactly once.
    const wet = (63 - at) / 64;
    const wanted = DIRECT * (1 - 0.5 * wet);
    assert.ok(
      Math.abs(after.left[at] - wanted) < 1e-6,
      `frame ${at} of the fade-out has to be ${wanted}, got ${after.left[at]}`,
    );
  }
  assert.ok(Math.abs(after.left[64] - DIRECT) < 1e-7, `the 64th frame is the dry track, got ${after.left[64]}`);
  for (let at = 64; at < after.left.length; at += 1) {
    assert.ok(
      Math.abs(after.left[at] - DIRECT) < 1e-7,
      `the fade has to happen once: frame ${at} came back at ${after.left[at]}`,
    );
  }
  const ramp = Math.abs(DIRECT - DIRECT / 2) / 64;
  assert.ok(
    largestStep(after, 0, 2 * BLOCK) <= ramp + 1e-7,
    `the fade-out must not step more than its own ramp (${ramp}), largest step was ${largestStep(after, 0, 2 * BLOCK)}`,
  );
});

test("turning a master limiter's bypass off while playing does not replay old audio", async () => {
  // The limiter holds a ceiling while the track is loud, so its lookahead and its
  // gain envelope are full of the loud moment. Bypassing it stops running it at
  // all (`runChainList` never touches a runner whose weight is 0), so everything
  // it holds stays frozen where it was. Lifting the bypass must not play that
  // back: the 72 frames of old audio in its lookahead, or the reduction it was
  // holding, are the sound of the moment it was switched off.
  //
  // The track is a CONSTANT level, so a delay of any length is invisible in the
  // comparison and what is left to hear is the frozen state itself.
  const loud = 0.9;
  const quiet = 0.05;
  const take = new Float32Array(BAR_FRAMES);
  take.fill(loud);
  take.fill(quiet, 3200);
  const limiter = insertOf("ins-limiter", "master", 1, "limiter", { ceiling_db: -6, release_ms: 60 });
  const songOf = (bypass) => audioSong({ inserts: { "ins-limiter": { ...limiter, bypass: bypass } } });
  const ceiling = amplitudeOf(-6);
  const quietLevel = quiet * CENTRE;

  const hostUnderTest = await host(songOf(false), { takeSamples: take });
  const loudOut = hostUnderTest.run(20);
  const loudPeak = peakOf(loudOut.left);
  assert.ok(
    loudPeak <= ceiling + 1e-6 && loudPeak > ceiling * 0.9,
    `the limiter has to be holding its ceiling first, peak was ${loudPeak} for ${ceiling}`,
  );

  // Bypass it, let the fade finish, then play on into the quiet part: the insert
  // is out of the path and still holding the loud moment.
  hostUnderTest.post({ type: "song", snapshot: songOf(true) });
  await hostUnderTest.flush();
  hostUnderTest.run(2);
  hostUnderTest.run(4);
  const quietDry = hostUnderTest.run(2);
  assert.ok(
    Math.abs(peakOf(quietDry.left) - quietLevel) < 1e-6,
    `a bypassed limiter plays the track itself (${quietLevel}), peak was ${peakOf(quietDry.left)}`,
  );
  // The master's reported delay follows the weight: a bypassed limiter delays
  // nothing, so the number comes back to 0 as the fade passes its midpoint.
  assert.deepEqual(
    hostUnderTest.posts.filter((message) => message.type === "master_latency").map((message) => message.ms),
    [1.5, 0],
    "the bypass has to take the master's delay away once it is more than half out",
  );

  // Lift the bypass. The insert comes back with its state thrown away, so from
  // its first frame the master is the quiet track — never a replay of the loud
  // audio its lookahead was holding.
  hostUnderTest.post({ type: "song", snapshot: songOf(false) });
  await hostUnderTest.flush();
  const back = hostUnderTest.run(8);

  // What a FRESH limiter fed the same (quiet) input plays, for the comparison.
  const freshTake = new Float32Array(BAR_FRAMES);
  freshTake.fill(quiet);
  const fresh = await host(songOf(false), { takeSamples: freshTake });
  const freshOut = fresh.run(24);
  const window = 8 * BLOCK;
  const freshWindow = freshOut.left.subarray(16 * BLOCK, 16 * BLOCK + window);
  for (let at = 0; at < window; at += 1) {
    assert.ok(
      Math.abs(back.left[at] - freshWindow[at]) < 1e-6,
      `frame ${at} after the bypass was lifted has to be the fresh limiter's own output ` +
        `(${freshWindow[at]}), got ${back.left[at]} — its old lookahead or gain envelope was replayed`,
    );
  }
  // And the delay comes back the same way, at the fade's midpoint — once.
  assert.deepEqual(
    hostUnderTest.posts.filter((message) => message.type === "master_latency").map((message) => message.ms),
    [1.5, 0, 1.5],
    "lifting the bypass has to give the master its limiter's lookahead back, once",
  );
});

test("turning a delay's bypass off does not replay its old echoes", async () => {
  // A burst into a fully wet delay, then silence: the delay's line holds the
  // echoes. Bypassed, its weight reaches 0, `runChainList` stops running it and
  // the line stays exactly where it was; lifting the bypass empties it into the
  // master unless the insert starts again from silence.
  const delay = insertOf("ins-delay", "track:track-1", 1, "delay", {
    time_ms: 100,
    feedback: 0.5,
    mix: 1,
    highcut_hz: 20000,
  });
  const songOf = (bypass) => audioSong({ inserts: { "ins-delay": { ...delay, bypass: bypass } } });
  const burst = toneTake(0.4, 200);
  burst.fill(0, 4800);
  const modules = {
    delay: {
      wasm: new Uint8Array(readFileSync(join(FAUST_DIR, "delay.wasm"))).buffer,
      json: readFileSync(join(FAUST_DIR, "delay.json"), "utf8"),
    },
  };

  const hostUnderTest = await host(songOf(false), { takeSamples: burst });
  hostUnderTest.post({ type: "faust-modules", modules: modules });
  await hostUnderTest.flush();
  const ringing = hostUnderTest.run(60);
  const echoRms = rmsOf(ringing, 7000, 7680);
  assert.ok(echoRms > 1e-3, `the delay has to be echoing before the edit, rms was ${echoRms}`);

  // Bypass it: 64 frames of fade, and then the line is frozen where it stands.
  hostUnderTest.post({ type: "song", snapshot: songOf(true) });
  await hostUnderTest.flush();
  hostUnderTest.run(2);
  // Play on in the silence the insert is holding, then lift the bypass.
  hostUnderTest.run(4);
  hostUnderTest.post({ type: "song", snapshot: songOf(false) });
  await hostUnderTest.flush();
  const back = hostUnderTest.run(20);
  assert.ok(
    peakOf(back.left) < 1e-6,
    `a delay lifted out of bypass has to start from silence, peak was ${peakOf(back.left)}`,
  );
});

test("swapping one compressor for another does not swell the level", async () => {
  // One position, two inserts: the first is deleted and the second added, which
  // used to fade the two one after the other. Half in, half in, the signal then
  // passes two +6 dB stages at once — a swell of about +1 dB over either steady
  // state. Side by side, with one weight between their OUTPUTS, the level can only
  // ever move between the two steady states.
  const compressor = (id, thresholdDb) =>
    insertOf(id, "track:track-1", 1, "compressor", {
      threshold_db: thresholdDb,
      ratio: 1,
      knee_db: 0,
      makeup_db: 6,
      attack_ms: 10,
      release_ms: 100,
      detect: "peak",
    });
  const first = { "ins-a": compressor("ins-a", 0) };
  const second = { "ins-b": compressor("ins-b", -1) };
  const steadyOf = async (inserts) => {
    const probe = await host(audioSong({ inserts: inserts }), { take: 0.2 });
    return peakOf(probe.run(4).left.subarray(2 * BLOCK));
  };
  const steadyA = await steadyOf(first);
  const steadyB = await steadyOf(second);
  assert.ok(
    Math.abs(20 * Math.log10(steadyA / steadyB)) < 0.01,
    `the two settings are the same level by design (${steadyA} / ${steadyB})`,
  );

  const hostUnderTest = await host(audioSong({ inserts: first }), { take: 0.2 });
  hostUnderTest.run(4);
  hostUnderTest.post({ type: "song", snapshot: audioSong({ inserts: second }) });
  await hostUnderTest.flush();
  const swapped = hostUnderTest.run(2);
  const loudest = Math.max(steadyA, steadyB);
  const peak = peakOf(swapped.left);
  assert.ok(
    peak <= loudest * amplitudeOf(0.1),
    `a swapped insert must not swell the level: peak ${20 * Math.log10(peak / loudest)} dB over ` +
      `the steady state (allowed: 0.1 dB), ${loudest} → ${peak}`,
  );
  // And it does arrive at the new insert's own level.
  assert.ok(
    Math.abs(20 * Math.log10(peakOf(swapped.left.subarray(BLOCK)) / steadyB)) < 0.01,
    `the new insert has to be the one playing afterwards, ${peakOf(swapped.left.subarray(BLOCK))} for ${steadyB}`,
  );
});

test("reordering two inserts does not swell the level", async () => {
  // A reorder rebuilds every insert, and it used to fade the whole chain out and
  // the whole new chain in, insert by insert: four +6 dB stages at half weight
  // instead of two at full. The old order and the new one now run in parallel, so
  // the level only moves between two equal steady states.
  const compressor = (id, thresholdDb) =>
    insertOf(id, `track:track-1`, 0, "compressor", {
      threshold_db: thresholdDb,
      ratio: 1,
      knee_db: 0,
      makeup_db: 6,
      attack_ms: 10,
      release_ms: 100,
      detect: "peak",
    });
  const ab = { "ins-a": compressor("ins-a", 0), "ins-b": compressor("ins-b", -1) };
  const ba = {
    "ins-a": { ...ab["ins-a"], order: 2 },
    "ins-b": { ...ab["ins-b"], order: 1 },
  };
  const steadyOf = async (inserts) => {
    const probe = await host(audioSong({ inserts: inserts }), { take: 0.2 });
    return peakOf(probe.run(4).left.subarray(2 * BLOCK));
  };
  const steadyAB = await steadyOf(ab);
  const steadyBA = await steadyOf(ba);

  const hostUnderTest = await host(audioSong({ inserts: ab }), { take: 0.2 });
  hostUnderTest.run(4);
  hostUnderTest.post({ type: "song", snapshot: audioSong({ inserts: ba }) });
  await hostUnderTest.flush();
  const reordered = hostUnderTest.run(2);
  const loudest = Math.max(steadyAB, steadyBA);
  const peak = peakOf(reordered.left);
  assert.ok(
    peak <= loudest * amplitudeOf(0.1),
    `a reorder must not swell the level: peak ${20 * Math.log10(peak / loudest)} dB over the steady ` +
      `state (allowed: 0.1 dB), ${loudest} → ${peak}`,
  );
});

test("a new delay never hears the removed effect", async () => {
  // A ringing delay replaced by another delay in the same position. Faded one
  // after the other, the new delay's input is the old one's OUTPUT, so it echoes
  // echoes of an effect the song no longer has. Side by side, it only ever hears
  // the signal that arrived — here, the silence after the burst.
  const ringing = insertOf("ins-ringing", "track:track-1", 1, "delay", {
    time_ms: 100,
    feedback: 0.5,
    mix: 1,
    highcut_hz: 20000,
  });
  const fresh = insertOf("ins-fresh", "track:track-1", 1, "delay", {
    time_ms: 50,
    feedback: 0.9,
    mix: 1,
    highcut_hz: 20000,
  });
  const burst = toneTake(0.4, 200);
  burst.fill(0, 4800);
  const modules = {
    delay: {
      wasm: new Uint8Array(readFileSync(join(FAUST_DIR, "delay.wasm"))).buffer,
      json: readFileSync(join(FAUST_DIR, "delay.json"), "utf8"),
    },
  };

  const hostUnderTest = await host(audioSong({ inserts: { "ins-ringing": ringing } }), { takeSamples: burst });
  hostUnderTest.post({ type: "faust-modules", modules: modules });
  await hostUnderTest.flush();
  hostUnderTest.run(60);

  hostUnderTest.post({ type: "song", snapshot: audioSong({ inserts: { "ins-fresh": fresh } }) });
  await hostUnderTest.flush();
  const after = hostUnderTest.run(20);
  // The new delay's own delay is 50 ms (2400 frames), so anything the OLD one put
  // in its line would come back from there on. Nothing may.
  const later = peakOf(after.left.subarray(2400));
  assert.ok(
    later < 1e-6,
    `the new delay must not echo the effect it replaced, peak after its own delay was ${later}`,
  );
});

test("re-arming a faulted insert fades it back in instead of switching hard", async () => {
  // An insert that blew up once and then behaves: the guard bypasses it on its
  // first block, and turning its own parameters arms it again. Arming it resets
  // it, so what comes back is a fresh insert at another level — it has to arrive
  // over the chain's own 64 frames rather than as a step in the master.
  const dynamics = stubDynamicsSource(0.5, [], { nanOnceKinds: ["gate"] });
  const songOf = (thresholdDb) =>
    audioSong({ inserts: { "ins-once": insertOf("ins-once", "track:track-1", 1, "gate", { threshold_db: thresholdDb }) } });
  const hostUnderTest = await host(songOf(-20), { dynamics });
  const faulted = hostUnderTest.run(2);
  assert.ok(
    Math.abs(faulted.left[BLOCK] - DIRECT) < 1e-6,
    `the block the insert poisoned has to be its input, got ${faulted.left[BLOCK]}`,
  );
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "insert_fault").length,
    1,
    "the fault is said once",
  );

  hostUnderTest.post({ type: "song", snapshot: songOf(-30) });
  await hostUnderTest.flush();
  const rearmed = hostUnderTest.run(2);
  const newLevel = DIRECT / 2;
  for (let at = 0; at < 64; at += 1) {
    // 1/64 of the way on the first frame, all the way on the 64th.
    const weight = (at + 1) / 64;
    const wanted = newLevel * weight + DIRECT * (1 - weight);
    assert.ok(
      Math.abs(rearmed.left[at] - wanted) < 1e-6,
      `frame ${at} after the re-arm has to be ${wanted}, got ${rearmed.left[at]} — it switched hard instead of fading in`,
    );
  }
  assert.ok(
    Math.abs(rearmed.left[BLOCK] - newLevel) < 1e-7,
    `and it settles at the insert's own level (${newLevel}), got ${rearmed.left[BLOCK]}`,
  );
  const ramp = Math.abs(DIRECT - newLevel) / 64;
  assert.ok(
    largestStep(rearmed, 0, 2 * BLOCK) <= ramp + 1e-7,
    `the re-arm must not step more than its own ramp (${ramp}), largest step was ${largestStep(rearmed, 0, 2 * BLOCK)}`,
  );
});

test("a faulted master limiter stops counting as the master's delay", async () => {
  // A master insert that claims the limiter's lookahead and then blows up: the
  // guard turns it into a pass-through, so the master path is not delayed any
  // more, and the number a tap and the meter carry has to say so at once — the
  // latency is read after every run of the master chain, not once per build.
  const dynamics = stubDynamicsSource(1, ["limiter"], { latencyFrames: 72 });
  const song = audioSong({ inserts: { "ins-limiter": insertOf("ins-limiter", "master", 1, "limiter", {}) } });
  const hostUnderTest = await host(song, { dynamics });
  const latencies = () =>
    hostUnderTest.posts.filter((message) => message.type === "master_latency").map((message) => message.ms);
  hostUnderTest.run(2);
  assert.deepEqual(
    latencies(),
    [1.5, 0],
    `the build names the lookahead and the fault takes it back, got ${JSON.stringify(latencies())}`,
  );
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "insert_fault").length,
    1,
    "the insert says why it is gone once",
  );
});

test("an edit that lands inside a blend's fade does not click", async () => {
  // A replaced insert starts a blend (the old path against the new one) and a
  // second edit arrives 20 frames in, while that blend is still fading: the chain
  // cannot be taken apart position by position any more, so the whole thing — the
  // live blend and all — becomes the leaving path of a new blend. The two inserts
  // are compressors that only apply their makeup gain, so the levels are exact
  // numbers: DIRECT for 0 dB, twice that for +6 dB.
  const compressor = (id, order, makeupDb) =>
    insertOf(id, "track:track-1", order, "compressor", {
      threshold_db: 0,
      ratio: 1,
      knee_db: 0,
      makeup_db: makeupDb,
      attack_ms: 10,
      release_ms: 100,
      detect: "peak",
    });
  const plain = audioSong({ inserts: { "ins-a": compressor("ins-a", 1, 0) } });
  const loud = audioSong({ inserts: { "ins-b": compressor("ins-b", 1, 6) } });
  const both = audioSong({
    inserts: { "ins-b": compressor("ins-b", 1, 6), "ins-c": compressor("ins-c", 2, 0) },
  });

  const hostUnderTest = await host(plain);
  hostUnderTest.run(4);
  hostUnderTest.post({ type: "song", snapshot: loud });
  await hostUnderTest.flush();
  // 20 of the fade's 64 frames: the weight is 20/64 of the way to the +6 dB insert.
  const stepped = hostUnderTest.run(1, 20);
  const sixDb = amplitudeOf(6);
  const midway = DIRECT * (1 + (20 / 64) * (sixDb - 1));
  assert.ok(
    Math.abs(stepped.left[19] - midway) < 1e-6,
    `the first fade has to stand at ${midway} twenty frames in, got ${stepped.left[19]}`,
  );
  hostUnderTest.post({ type: "song", snapshot: both });
  await hostUnderTest.flush();
  const after = hostUnderTest.run(2);

  // The chain the second edit arrives at is two inserts again (a +6 dB one and a
  // 0 dB one, so twice DIRECT), and the fade has to start from where the first one
  // had got to instead of jumping to either end of it.
  const from = midway;
  const to = DIRECT * sixDb;
  const first = from * (63 / 64) + to * (1 / 64);
  assert.ok(
    Math.abs(after.left[0] - first) < 1e-6,
    `the second edit has to fade on from where the first was (${first}), got ${after.left[0]} — a blend ` +
      "that was frozen or dropped instead of kept would step to one of its ends here",
  );
  assert.ok(
    Math.abs(after.left[BLOCK] - to) < 1e-6,
    `and the chain has to settle on the new level (${to}), got ${after.left[BLOCK]}`,
  );
  const ramp = Math.abs(to - from) / 64;
  assert.ok(
    largestStep(after) <= ramp + 1e-6,
    `nothing may step more than one frame of the joined fade (${ramp}), largest step was ${largestStep(after)}`,
  );
});

test("a chain with an insert that cannot be built is not rebuilt on every edit", async () => {
  const key = "__builds_broken_insert";
  globalThis[key] = [];
  const dynamics = stubDynamicsSource(0.5, [], { buildsKey: key, brokenKinds: ["gate"] });
  const doomed = insertOf("ins-doomed", "track:track-1", 1, "gate", {});
  const songOf = (inserts) => audioSong({ inserts: inserts });

  const hostUnderTest = await host(songOf({ "ins-doomed": doomed }), { dynamics });
  hostUnderTest.run(2);
  const builds = () => globalThis[key].filter((entry) => entry === "create:gate").length;
  const errors = () => hostUnderTest.posts.filter((message) => message.type === "error");
  assert.equal(builds(), 1, "the insert is built once and cannot be built");
  assert.equal(errors().length, 1, `one report for an insert that will not build, got ${errors().length}`);
  assert.equal(errors()[0].error, "gate on Track 1 could not be built: this insert will not build");

  // Two snapshots that change another insert's parameters, one that edits the
  // chain around it (an insert added), and one that edits another chain
  // entirely: none of them is a reason to try building it again.
  const edited = [
    songOf({
      "ins-doomed": doomed,
      "ins-comp": insertOf("ins-comp", "track:track-1", 2, "compressor", { threshold_db: -12 }),
    }),
    songOf({
      "ins-doomed": doomed,
      "ins-comp": insertOf("ins-comp", "track:track-1", 2, "compressor", { threshold_db: -18 }),
    }),
    songOf({ "ins-doomed": doomed, "ins-limiter": insertOf("ins-limiter", "master", 1, "limiter", {}) }),
    songOf({ "ins-doomed": doomed }),
  ];
  for (const snapshot of edited) {
    hostUnderTest.post({ type: "song", snapshot: snapshot });
    await hostUnderTest.flush();
    hostUnderTest.run(1);
  }
  assert.equal(builds(), 1, `an insert that cannot be built must not be rebuilt on every edit, got ${builds()}`);
  assert.equal(errors().length, 1, "and must not be reported again");

  // The chain still plays: what is left of it halves the track.
  hostUnderTest.post({ type: "song", snapshot: edited[1] });
  await hostUnderTest.flush();
  const out = hostUnderTest.run(2);
  assert.ok(
    Math.abs(out.left[Math.round(BLOCK * 1.5)] - DIRECT / 2) < 1e-6,
    `the inserts that do build have to run, got ${out.left[Math.round(BLOCK * 1.5)]}`,
  );
});

test("an unrelated edit does not re-arm a faulted insert; changing its params does, once", async () => {
  const key = "__builds_fault_latch";
  globalThis[key] = [];
  const dynamics = stubDynamicsSource(0.5, ["gate"], { buildsKey: key });
  const songOf = (params, gainDb) =>
    audioSong({
      tracks: [audioTrack(1, { gain_db: gainDb })],
      inserts: { "ins-nan": insertOf("ins-nan", "track:track-1", 1, "gate", params) },
    });
  const hostUnderTest = await host(songOf({ threshold_db: -20 }, 0), { dynamics });
  const faults = () => hostUnderTest.posts.filter((message) => message.type === "insert_fault");

  const out = hostUnderTest.run(4);
  assert.ok(
    Math.abs(out.left[BLOCK * 3] - DIRECT) < 1e-6,
    `the poisoned block has to be the insert's input, got ${out.left[BLOCK * 3]}`,
  );
  assert.equal(faults().length, 1, "the fault is said once");

  // An unrelated edit — the track's fader — leaves the insert bypassed: it is
  // not re-armed, not reset, and says nothing.
  hostUnderTest.post({ type: "song", snapshot: songOf({ threshold_db: -20 }, -6) });
  await hostUnderTest.flush();
  const quiet = hostUnderTest.run(2);
  assert.ok(
    Math.abs(quiet.left[Math.round(BLOCK * 1.5)] - DIRECT * amplitudeOf(-6)) < 1e-6,
    `the bypassed insert has to stay bypassed, got ${quiet.left[Math.round(BLOCK * 1.5)]}`,
  );
  assert.equal(faults().length, 1, "an unrelated edit must not re-arm a faulted insert");
  assert.equal(
    globalThis[key].filter((entry) => entry === "reset:gate").length,
    0,
    "and must not reset it either",
  );

  // Its OWN parameters moving arms it again — once — and resetting it is how
  // the NaN it is holding is thrown away.
  hostUnderTest.post({ type: "song", snapshot: songOf({ threshold_db: -30 }, -6) });
  await hostUnderTest.flush();
  const rearmed = hostUnderTest.run(2);
  assert.ok(
    Math.abs(rearmed.left[BLOCK + 64] - DIRECT * amplitudeOf(-6)) < 1e-6,
    `the re-armed insert has to run (and be caught) again, got ${rearmed.left[BLOCK + 64]}`,
  );
  assert.equal(faults().length, 2, "its own parameters moving arms it once");
  assert.equal(
    globalThis[key].filter((entry) => entry === "reset:gate").length,
    1,
    "and clearing the fault resets the insert",
  );

  // Changing something else again does not arm it a third time.
  hostUnderTest.post({ type: "song", snapshot: songOf({ threshold_db: -30 }, -12) });
  await hostUnderTest.flush();
  hostUnderTest.run(2);
  assert.equal(faults().length, 2, "an unrelated edit after the re-arm must not arm it again");
  assert.equal(
    globalThis[key].filter((entry) => entry === "create:gate").length,
    1,
    "and the insert is never rebuilt for a parameter turn",
  );
});

test("an insert that produces NaN is bypassed and reported", async () => {
  // The "gate" insert writes NaN; everything else halves.
  const dynamics = stubDynamicsSource(0.5, ["gate"]);
  const song = audioSong({
    inserts: { "ins-nan": insertOf("ins-nan", "track:track-1", 1, "gate", { threshold_db: -20 }) },
  });
  const hostUnderTest = await host(song, { dynamics });
  const out = hostUnderTest.run(4);

  // The block the insert poisoned is replaced by the insert's own input, so the
  // master is the dry track: nothing of the NaN reaches a sample.
  for (const at of [0, 1, BLOCK, 3 * BLOCK + 5]) {
    assert.ok(
      Math.abs(out.left[at] - DIRECT) < 1e-6,
      `frame ${at} has to be the insert's input, got ${out.left[at]}`,
    );
    assert.ok(
      Math.abs(out.right[at] - DIRECT) < 1e-6,
      `frame ${at} of the right channel too, got ${out.right[at]}`,
    );
  }
  assert.ok(Number.isFinite(peakOf(out.left)) && Number.isFinite(peakOf(out.right)), "no NaN may reach the master");

  const faults = hostUnderTest.posts.filter((message) => message.type === "insert_fault");
  assert.equal(faults.length, 1, `the fault is said once, not once per block (got ${faults.length})`);
  assert.equal(faults[0].insert_id, "ins-nan", "the fault names the insert");
  assert.equal(
    faults[0].message,
    "gate on Track 1 produced an invalid sample; it is bypassed.",
    "the sentence names the effect and the track",
  );

  // A later rebuild of that insert — here it becomes a compressor — clears the
  // fault, so the chain runs again (and halves, this time).
  hostUnderTest.post({
    type: "song",
    snapshot: audioSong({
      inserts: { "ins-nan": insertOf("ins-nan", "track:track-1", 1, "compressor", {}) },
    }),
  });
  await hostUnderTest.flush();
  const rebuilt = hostUnderTest.run(2);
  assert.ok(
    Math.abs(rebuilt.left[2 * BLOCK - 1] - DIRECT / 2) < 1e-7,
    `a rebuilt insert has to run again, its fault cleared, got ${rebuilt.left[2 * BLOCK - 1]}`,
  );
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "insert_fault").length,
    1,
    "clearing the fault is not another fault",
  );
});

test("a Faust insert that is still loading passes audio and says so once", async () => {
  // This engine has `faust-host.js` but no compiled effect modules yet (the page
  // posts them a moment after the engine comes up): the reverb is a pass-through
  // that plays the song and says it is still loading — once.
  const song = audioSong({
    inserts: { "ins-reverb": insertOf("ins-reverb", "track:track-1", 1, "reverb", { size: 0.6, mix: 0.5 }) },
  });
  const hostUnderTest = await host(song);
  const dry = hostUnderTest.run(4);
  for (const at of [0, BLOCK, 3 * BLOCK + 7]) {
    assert.ok(
      Math.abs(dry.left[at] - DIRECT) < 1e-6,
      `a loading insert passes audio through, frame ${at} was ${dry.left[at]}`,
    );
  }
  const said = hostUnderTest.posts.filter((message) => message.type === "insert_loading");
  assert.equal(said.length, 1, `one "still loading" per insert, got ${said.length}: ${JSON.stringify(said)}`);
  assert.equal(said[0].insert_id, "ins-reverb", "the message names the insert");
  assert.equal(said[0].message, "reverb on Track 1 is still loading.", "the sentence names the effect and the track");
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "error").length,
    0,
    "a load in progress is not an engine error and never reaches onError",
  );

  // The modules arrive: the processor compiles them and builds the chains
  // again, so the reverb becomes a real insert (faded in while the song plays).
  const modules = {};
  modules.reverb = {
    wasm: new Uint8Array(readFileSync(join(FAUST_DIR, "reverb.wasm"))).buffer,
    json: readFileSync(join(FAUST_DIR, "reverb.json"), "utf8"),
  };
  hostUnderTest.post({ type: "faust-modules", modules: modules });
  await hostUnderTest.flush();
  const withReverb = hostUnderTest.run(8);
  assert.ok(firstDifference(withReverb, dry) !== -1, "once its module is compiled the reverb has to change the master");
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "insert_loading").length,
    1,
    "a load that worked is not reported again",
  );
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "error").length,
    0,
    "and it never said anything on the error channel",
  );
  // The module arrived, so this insert is live from here on: a snapshot that
  // changes something else must not rebuild it as "still loading" again.
  hostUnderTest.post({ type: "song", snapshot: song });
  await hostUnderTest.flush();
  hostUnderTest.run(2);
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "insert_loading").length,
    1,
    "an insert with its module is never loading again",
  );
});

test("bypassing an eq in front of a return's reverb keeps the reverb tail", async () => {
  // A 100 ms tone burst into a fully wet reverb, through an equalizer, and then
  // 60 ms of silence: what the master carries by the time the edit arrives is
  // the reverb's own tail. Bypassing the equalizer is a chain edit, and the
  // reverb behind it must keep its state — a rebuilt reverb would start from
  // silence, which on a fully wet reverb is a hole where the tail was.
  const returns = { "ret-1": { id: "ret-1", name: "Hall", gain_db: 0, pan: 0, mute: false } };
  const inserts = {
    "ins-eq": insertOf("ins-eq", "return:ret-1", 1, "eq", { low_freq_hz: 200, low_gain_db: 9, mid_gain_db: 0, high_gain_db: 0 }),
    "ins-rev": insertOf("ins-rev", "return:ret-1", 2, "reverb", { size: 0.85, damping: 0.1, predelay_ms: 0, mix: 1 }),
  };
  const sends = { "track-1/ret-1": { track_id: "track-1", return_id: "ret-1", level_db: 0, pre: true } };
  const songOf = (bypassEq) =>
    audioSong({
      tracks: [audioTrack(1, { gain_db: -60 })],
      returns: returns,
      sends: sends,
      inserts: {
        "ins-eq": { ...inserts["ins-eq"], bypass: bypassEq },
        "ins-rev": inserts["ins-rev"],
      },
    });
  // A tone for 100 ms, then silence.
  const burst = toneTake(0.4, 200);
  burst.fill(0, 4800);

  const modules = {};
  for (const kind of ["eq", "reverb"]) {
    modules[kind] = {
      wasm: new Uint8Array(readFileSync(join(FAUST_DIR, `${kind}.wasm`))).buffer,
      json: readFileSync(join(FAUST_DIR, `${kind}.json`), "utf8"),
    };
  }

  const edited = await host(songOf(false), { takeSamples: burst });
  edited.post({ type: "faust-modules", modules: modules });
  await edited.flush();
  const untouched = await host(songOf(false), { takeSamples: burst });
  untouched.post({ type: "faust-modules", modules: modules });
  await untouched.flush();

  // 60 blocks is 7680 frames: the burst ended at 4800, so the tail is ringing.
  const beforeEdit = edited.run(60);
  const reference = untouched.run(60);
  const preRms = rmsOf(beforeEdit, 7680 - 64, 7680);
  assert.ok(preRms > 1e-4, `the reverb tail has to be ringing before the edit, got ${preRms}`);

  edited.post({ type: "song", snapshot: songOf(true) });
  await edited.flush();
  const afterEdit = edited.run(2);
  const afterReference = untouched.run(2);

  // The tail carries on as it would have: the equalizer faded out in front of a
  // reverb whose input is silence, and what the reverb still hears of it is the
  // equalizer's own decay. A reverb that had been rebuilt instead would have
  // started from silence — a hole where the tail was, an order of magnitude
  // bigger than this.
  const tolerance = Math.max(1e-6, preRms * 0.05);
  for (let at = 0; at < 256; at += 1) {
    assert.ok(
      Math.abs(afterEdit.left[at] - afterReference.left[at]) < tolerance,
      `frame ${at} after the edit has to be the same tail (${afterReference.left[at]}), got ${afterEdit.left[at]}`,
    );
  }
  const tailRms = rmsOf(afterEdit, 0, 64);
  const referenceRms = rmsOf(afterReference, 0, 64);
  assert.ok(
    tailRms > 0.5 * referenceRms,
    `a rebuilt reverb would have started from silence instead of ringing on (${referenceRms} → ${tailRms})`,
  );
  assert.ok(
    largestStep(beforeEdit, 7680 - 64, 7680) > 0,
    "the tail has to be moving for the continuity check to mean anything",
  );
});

test("adding an eq to the master while playing keeps the limiter's output continuous", async () => {
  // The master limiter looks 1.5 ms (72 frames at 48 kHz) ahead, so a rebuilt
  // one would output 72 frames of the silence of an empty delay line — longer
  // than the 64-frame fade. Adding an equalizer IN FRONT of it must not cut it.
  const limiter = insertOf("ins-limiter", "master", 2, "limiter", { ceiling_db: -1.5, release_ms: 60 });
  const equalizer = insertOf("ins-eq", "master", 1, "eq", {
    low_freq_hz: 200,
    low_gain_db: 6,
    mid_freq_hz: 900,
    mid_gain_db: 0,
    mid_q: 1,
    high_freq_hz: 6000,
    high_gain_db: 0,
  });
  const plain = audioSong({ inserts: { "ins-limiter": limiter } });
  const editedSong = audioSong({ inserts: { "ins-eq": equalizer, "ins-limiter": limiter } });

  const hostUnderTest = await host(plain, { takeSamples: toneTake(0.4, 200) });
  hostUnderTest.post({
    type: "faust-modules",
    modules: {
      eq: {
        wasm: new Uint8Array(readFileSync(join(FAUST_DIR, "eq.wasm"))).buffer,
        json: readFileSync(join(FAUST_DIR, "eq.json"), "utf8"),
      },
    },
  });
  await hostUnderTest.flush();

  const before = hostUnderTest.run(30);
  const latencyPosts = () => hostUnderTest.posts.filter((message) => message.type === "master_latency");
  assert.equal(latencyPosts().length, 1, "the master chain's latency is posted once for the limiter");
  const preRms = rmsOf(before, 30 * BLOCK - 240, 30 * BLOCK);
  const preStep = largestStep(before, 30 * BLOCK - 240, 30 * BLOCK);
  assert.ok(preRms > 0.1, `the limited master has to be playing, got ${preRms}`);
  assert.ok(preStep > 0, "the tone has to be moving for the step check to mean anything");

  hostUnderTest.post({ type: "song", snapshot: editedSong });
  await hostUnderTest.flush();
  const after = hostUnderTest.run(2);

  // No frame of silence: the window the empty lookahead would have swallowed is
  // full of the limiter's own (already primed) output.
  assert.ok(
    peakOf(after.left.subarray(0, 72)) > 0.1,
    `a rebuilt limiter would have output silence for 72 frames, peak was ${peakOf(after.left.subarray(0, 72))}`,
  );
  assert.ok(
    rmsOf(after, 0, 240) > 0.5 * preRms,
    `the limiter's output has to stay continuous (${preRms} before), got ${rmsOf(after, 0, 240)}`,
  );
  // No click: the added equalizer fades in, so nothing steps more than the
  // equalized tone itself does.
  assert.ok(
    largestStep(after, 0, 2 * BLOCK) <= preStep * 2.5 + 1e-4,
    `the added equalizer must not step more than the audio (${preStep}), largest step was ${largestStep(after, 0, 2 * BLOCK)}`,
  );
  // And the equalizer really is in the path now (its +6 dB is audible), with the
  // limiter's delay unchanged — it was reused, not rebuilt.
  const postRms = rmsOf(after, BLOCK, 2 * BLOCK);
  assert.ok(
    postRms > preRms * 1.2,
    `the added equalizer has to change the master (${preRms} → ${postRms})`,
  );
  assert.equal(latencyPosts().length, 1, "a reused limiter keeps the master chain's latency where it was");
});

test("moving an eq across the master limiter keeps the ceiling and does not jump in time", async () => {
  // A reorder of the master chain rebuilds every insert, the limiter included,
  // and a rebuilt limiter has an empty lookahead (72 frames of silence) and a cold
  // gain envelope. Faded out and in one after the other, the master would be
  // unlimited for that window and the time base would move twice (the old delay
  // out, the new one in). The two chains run in parallel instead, the old one
  // holding the master while the new limiter's lookahead fills.
  //
  // The tone is 2400 Hz, so twenty frames hold a whole period and the peak of any
  // twenty-frame window is the level itself — the fade's own level can be read
  // without the phase of the signal getting into it. The equalizer is a −2 dB
  // HIGH shelf, in front of the limiter and then behind it: its own settling is
  // over in a few frames, so what is left in the measurement is the fade.
  const limiter = (order) => insertOf("ins-limiter", "master", order, "limiter", { ceiling_db: -6, release_ms: 60 });
  const equalizer = (order) =>
    insertOf("ins-eq", "master", order, "eq", {
      low_freq_hz: 200,
      low_gain_db: 0,
      mid_gain_db: 0,
      high_freq_hz: 2000,
      high_gain_db: -2,
    });
  // eq → limiter, then limiter → eq: the equalizer has moved across the limiter.
  const beforeSong = () => audioSong({ inserts: { "ins-eq": equalizer(1), "ins-limiter": limiter(2) } });
  const afterSong = () => audioSong({ inserts: { "ins-limiter": limiter(1), "ins-eq": equalizer(2) } });
  const eqModule = {
    eq: {
      wasm: new Uint8Array(readFileSync(join(FAUST_DIR, "eq.wasm"))).buffer,
      json: readFileSync(join(FAUST_DIR, "eq.json"), "utf8"),
    },
  };
  const ceiling = amplitudeOf(-6);
  const latencyPosts = (probe) => probe.posts.filter((message) => message.type === "master_latency");
  const tone = 2400;

  // 1. The ceiling. The master is limited before the edit, and the limiter's own
  // delay (72 frames) is the chain's latency on both sides of it.
  const loud = await host(beforeSong(), { takeSamples: toneTake(0.9, tone) });
  loud.post({ type: "faust-modules", modules: eqModule });
  await loud.flush();
  const beforeEdit = loud.run(30);
  assert.ok(
    peakOf(beforeEdit.left) <= ceiling + 1e-6 && peakOf(beforeEdit.left) > ceiling * 0.9,
    `the limiter has to be holding its ceiling before the edit, peak was ${peakOf(beforeEdit.left)}`,
  );
  assert.equal(latencyPosts(loud).length, 1, "one latency for one build");
  const preLeast = leastWindowPeak(beforeEdit.left, 30 * BLOCK - 240, 30 * BLOCK, 20);
  assert.ok(preLeast > 0.1, `the limited master has to be playing, its window peak was ${preLeast}`);

  loud.post({ type: "song", snapshot: afterSong() });
  await loud.flush();
  const afterEdit = loud.run(8);
  assert.ok(
    peakOf(afterEdit.left) <= ceiling + 1e-6,
    `the reordered master must never pass the ceiling, peak was ${peakOf(afterEdit.left)}`,
  );
  // No hole while the arriving limiter's lookahead fills, and no comb while the
  // two paths are both in the mix: every window of the fade stays between the two
  // steady states the chain has on either side of the edit, which is what the old
  // path holding the master until the new one has primed buys.
  const postLeast = leastWindowPeak(afterEdit.left, 6 * BLOCK, 8 * BLOCK, 20);
  const least = leastWindowPeak(afterEdit.left, 0, 400, 20);
  assert.ok(
    least > 0.98 * Math.min(preLeast, postLeast),
    `the master must not dip while the new limiter's lookahead fills (its quietest window is ${least}, ` +
      `against ${preLeast} before the edit and ${postLeast} after it)`,
  );
  assert.ok(
    peakOf(afterEdit.left) <= Math.max(preLeast, postLeast) * amplitudeOf(0.1),
    `the fade must not swell over either steady state (${preLeast} / ${postLeast}), peak was ${peakOf(afterEdit.left)}`,
  );
  assert.equal(
    latencyPosts(loud).length,
    1,
    `a rebuilt limiter keeps the master's delay where it was, it must not be changed twice: ${JSON.stringify(
      latencyPosts(loud).map((message) => message.ms),
    )}`,
  );

  // 2. The time base. At a level the limiter never reduces, its output is the
  // input delayed by exactly its lookahead, so the chain after the edit has to
  // match the reordered chain run from the start sample for sample — a timeline
  // that moved (the old delay going out while the new one came in) would put the
  // tone a phase away from it.
  const quiet = 0.2;
  const moved = await host(beforeSong(), { takeSamples: toneTake(quiet, tone) });
  moved.post({ type: "faust-modules", modules: eqModule });
  await moved.flush();
  moved.run(30);
  moved.post({ type: "song", snapshot: afterSong() });
  await moved.flush();
  const movedOut = moved.run(40);

  const reference = await host(afterSong(), { takeSamples: toneTake(quiet, tone) });
  reference.post({ type: "faust-modules", modules: eqModule });
  await reference.flush();
  const referenceOut = reference.run(70);

  // After the fade (72 frames of priming and 72 of ramp) and past the filters'
  // own settling, the two have to be the same audio at the same absolute frames.
  const from = 30 * BLOCK + 3000;
  let worst = 0;
  for (let at = 3000; at < 4000; at += 1) {
    const difference = Math.abs(movedOut.left[at] - referenceOut.left[from + at]);
    if (difference > worst) worst = difference;
  }
  assert.ok(
    worst < 1e-4,
    `moving the eq across the limiter must not move the master in time: the worst difference from the ` +
      `same chain built from the start was ${worst} (a 72-frame jump would be about ${quiet * CENTRE})`,
  );
  assert.ok(peakOf(referenceOut.left) > 0.01, "the reference has to be playing for the comparison to mean anything");
});

test("a master tap is stamped with the master chain's latency taken off", async () => {
  const limiter = insertOf("ins-limiter", "master", 1, "limiter", { ceiling_db: -1.5, release_ms: 60 });
  const latencyFrames = Math.round(StudioDynamics.MASTER_LOOKAHEAD_SECONDS * SAMPLE_RATE);

  const limited = await host(audioSong({ inserts: { "ins-limiter": limiter } }));
  limited.post({ type: "tap", target: "master", on: true });
  await limited.flush();
  limited.run(2);
  const taps = limited.posts.filter((message) => message.type === "tap_block" && message.target === "master");
  assert.equal(taps.length, 2, `a tap posts one block per block, got ${taps.length}`);
  assert.equal(
    taps[0].frame,
    -latencyFrames,
    `the first block's master tap is that many frames late (${latencyFrames}), got ${taps[0].frame}`,
  );
  assert.equal(
    taps[1].frame - taps[0].frame,
    BLOCK,
    "and the blocks are still one block apart",
  );
  assert.equal(taps[0].channels.length, 2, "a master tap carries the stereo master");

  // Without a master limiter there is no latency to take off.
  const plain = await host(audioSong());
  plain.post({ type: "tap", target: "master", on: true });
  await plain.flush();
  plain.run(2);
  const plainTaps = plain.posts.filter((message) => message.type === "tap_block" && message.target === "master");
  assert.equal(plainTaps[0].frame, 0, `a master with no latency is stamped where it is, got ${plainTaps[0].frame}`);
  assert.equal(plainTaps[1].frame, BLOCK);
});

test("the meter matches the server's loudness within 0.1 LU", () => {
  const rate = SAMPLE_RATE;
  const seconds = 4;
  const frames = rate * seconds;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  // Four seconds of a 997 Hz tone that is quiet for two of them: the relative
  // gate has to throw the quiet half away, which is the part a plain mean would
  // get wrong.
  for (let index = 0; index < frames; index += 1) {
    const level = index < frames / 2 ? amplitudeOf(-30) : amplitudeOf(-6);
    const value = Math.sin((2 * Math.PI * 997 * index) / rate) * level;
    left[index] = value;
    right[index] = value;
  }

  const meter = StudioMeter.create(rate);
  meter.reset();
  // Fed in blocks of a size that is not the processor's own: the windows are
  // counted in frames, so the block size cannot change a reading.
  let cursor = 0;
  let size = 37;
  while (cursor < frames) {
    const count = Math.min(size, frames - cursor);
    meter.process(left.subarray(cursor, cursor + count), right.subarray(cursor, cursor + count), count);
    cursor += count;
    size = size === 37 ? 91 : 37;
  }
  const reading = meter.read();
  const wanted = integratedLufs(left, right, rate);
  assert.ok(
    Math.abs(reading.integrated - wanted) <= 0.1,
    `the meter's integrated loudness has to match loudness.js (${wanted} LUFS), got ${reading.integrated}`,
  );
  // The momentary window is the last 400 ms, which a steady tone reads as the
  // same loudness a 400 ms block of it measures.
  const windowStart = frames - Math.round(rate * 0.4);
  const momentaryWanted = integratedLufs(
    left.subarray(windowStart),
    right.subarray(windowStart),
    rate,
  );
  assert.ok(
    Math.abs(reading.momentary - momentaryWanted) <= 0.1,
    `the momentary reading has to match a 400 ms block (${momentaryWanted}), got ${reading.momentary}`,
  );

  // A steady tone has ONE loudness: the momentary (400 ms), short-term (3 s) and
  // integrated readings all agree with each other and with loudness.js, which is
  // what proves the three windows are measuring the same thing.
  const steadyFrames = Math.round(rate * 3.5);
  const steadyLeft = new Float32Array(steadyFrames);
  const steadyRight = new Float32Array(steadyFrames);
  for (let index = 0; index < steadyFrames; index += 1) {
    const value = Math.sin((2 * Math.PI * 997 * index) / rate) * amplitudeOf(-9);
    steadyLeft[index] = value;
    steadyRight[index] = value;
  }
  const steadyMeter = StudioMeter.create(rate);
  steadyMeter.reset();
  for (let cursor = 0, step = 64; cursor < steadyFrames; cursor += step, step = step === 64 ? 128 : 64) {
    const count = Math.min(step, steadyFrames - cursor);
    steadyMeter.process(
      steadyLeft.subarray(cursor, cursor + count),
      steadyRight.subarray(cursor, cursor + count),
      count,
    );
  }
  const steady = steadyMeter.read();
  const steadyWanted = integratedLufs(steadyLeft, steadyRight, rate);
  for (const field of ["momentary", "short_term", "integrated"]) {
    assert.ok(
      Math.abs(steady[field] - steadyWanted) <= 0.1,
      `a steady tone's ${field} reading has to be its loudness (${steadyWanted} LUFS), got ${steady[field]}`,
    );
  }

  // The K-weighting is derived for the rate in hand (only 48 kHz is published),
  // so the agreement has to hold at the other two rates a Studio context runs at.
  for (const otherRate of [44100, 96000]) {
    const count = Math.round(otherRate * 2);
    const otherLeft = new Float32Array(count);
    const otherRight = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const value = Math.sin((2 * Math.PI * 997 * index) / otherRate) * amplitudeOf(-12);
      otherLeft[index] = value;
      otherRight[index] = value;
    }
    const otherMeter = StudioMeter.create(otherRate);
    otherMeter.reset();
    for (let cursor = 0; cursor < count; cursor += 128) {
      const step = Math.min(128, count - cursor);
      otherMeter.process(otherLeft.subarray(cursor, cursor + step), otherRight.subarray(cursor, cursor + step), step);
    }
    const otherWanted = integratedLufs(otherLeft, otherRight, otherRate);
    assert.ok(
      Math.abs(otherMeter.read().integrated - otherWanted) <= 0.1,
      `at ${otherRate} Hz the meter has to match loudness.js (${otherWanted} LUFS), got ${otherMeter.read().integrated}`,
    );
  }

  // The true peak is the render's own measurement, through the very same 4×
  // filter (`engine/dynamics.js`'s branches, which a test holds to
  // `server/loudness.js`'s).
  const wantedPeak = truePeakDb(left, right, rate);
  assert.ok(
    Math.abs(reading.true_peak_db - wantedPeak) <= 0.01,
    `the meter's true peak has to match loudness.js (${wantedPeak} dBTP), got ${reading.true_peak_db}`,
  );
  assert.deepEqual(
    Array.from(StudioMeter.TRUE_PEAK_PHASES[1]),
    Array.from(StudioDynamics.TRUE_PEAK_PHASES[1]),
    "the meter's interpolation filter has to be the limiter's, and so loudness.js's",
  );

  // A reset starts the integrated measurement again and clears the peak hold.
  meter.reset();
  const reset = meter.read();
  assert.equal(reset.integrated, -Infinity, "a reset drops the integrated measurement");
  assert.equal(reset.true_peak_db, -Infinity, "and the true-peak hold");
});

test("the meter's gate holds up on a signal whose blocks straddle it", () => {
  // The integrated measurement is libebur128's histogram: a gating block's power is
  // summed into one 0.1 LU bin and the block is JUDGED by that bin's mean, so a
  // block within a bin of the relative gate can land on the wrong side of it. What
  // that costs is measured here against the exact per-block gating of
  // `server/loudness.js`, on the two signals it matters for.
  const rate = SAMPLE_RATE;
  const seconds = 8;
  const frames = rate * seconds;

  /**
   * The meter and loudness.js on one signal, which is `levelDbAt(frame)`.
   * @param {(index: number) => number} levelDbAt
   * @returns {{meter: number, wanted: number, gap: number}}
   */
  const compare = (levelDbAt) => {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      const value = Math.sin((2 * Math.PI * 997 * index) / rate) * amplitudeOf(levelDbAt(index));
      left[index] = value;
      right[index] = value;
    }
    const meter = StudioMeter.create(rate);
    meter.reset();
    for (let cursor = 0; cursor < frames; cursor += BLOCK) {
      const count = Math.min(BLOCK, frames - cursor);
      meter.process(left.subarray(cursor, cursor + count), right.subarray(cursor, cursor + count), count);
    }
    const reading = meter.read();
    const wanted = integratedLufs(left, right, rate);
    return { meter: reading.integrated, wanted: wanted, gap: Math.abs(reading.integrated - wanted) };
  };

  // Alternating loud and quiet seconds, ten LU apart: the quiet ones fall below
  // the relative gate and the blocks that straddle a section boundary land in its
  // neighbourhood. This is the ordinary case, and what it achieves is 0.01 LU —
  // the histogram stores each block's exact power, so the only thing quantised is
  // which side of the gate a BIN lands on, and no bin holds blocks on both sides
  // of it here. (Measured gap: about 1e-15 LU, so the tolerance has room.)
  const sections = compare((index) => (Math.floor(index / rate) % 2 === 0 ? -12 : -22));
  assert.ok(
    sections.gap <= 0.01,
    `a signal whose quiet sections straddle the relative gate has to stay within 0.01 LU of ` +
      `loudness.js (${sections.wanted} LUFS), got ${sections.meter} (${sections.gap} LU apart)`,
  );

  // The case the histogram actually loses: the quiet section's blocks alternate
  // 0.04 LU apart, so they share ONE bin whose mean sits on the gate — the bin
  // decides for all of them, and the quiet half of the Play goes in or out
  // together. That is worth up to a LU here (0.92 LU measured), not the 0.1 LU a
  // single block can be misjudged by, because each block the gate lets in or keeps
  // out moves the mean by its own share of the Play. The bound is stated, not
  // tightened: it is libebur128's own approximation, and every block this signal
  // has within a bin of the gate is in that bin on purpose.
  const piled = compare((index) => {
    if (Math.floor(index / rate) % 2 === 0) return -12;
    return -12 - 12.788 + (Math.floor(index / 4800) % 2 === 0 ? 0.02 : -0.02);
  });
  assert.ok(
    piled.gap <= 1,
    `a bin holding blocks on both sides of the relative gate may decide for all of them, but no ` +
      `more than 1 LU away from loudness.js (${piled.wanted} LUFS), got ${piled.meter} (${piled.gap} LU apart)`,
  );
});

test("the processor posts a meter reading every 100 ms of audio and once on stop", async () => {
  const hostUnderTest = await host(audioSong({ master: { gain_db: 0, target: { lufs: -14, true_peak_db: -1 } } }));
  // 100 ms is 37.5 blocks of 128 frames: two blocks past that has to have posted.
  const blocks = Math.ceil((SAMPLE_RATE * 0.1) / BLOCK) + 2;
  hostUnderTest.run(blocks);
  const readings = hostUnderTest.posts.filter((message) => message.type === "meter");
  assert.ok(readings.length >= 1, `a playing song has to meter, it posted ${readings.length}`);
  const latest = readings[readings.length - 1];
  for (const field of ["momentary", "short_term", "integrated", "true_peak_db", "latency_ms"]) {
    assert.equal(typeof latest[field], "number", `a meter reading carries ${field}`);
  }
  assert.equal(latest.latency_ms, 0, "a master with no limiter puts no delay on the master path");

  // Stop: one more reading, so the master strip keeps the number the song ended
  // on, and no readings after that while the transport stands still.
  hostUnderTest.post({ type: "stop" });
  await hostUnderTest.flush();
  hostUnderTest.run(2);
  const afterStop = hostUnderTest.posts.filter((message) => message.type === "meter");
  assert.equal(afterStop.length, readings.length + 1, "a stop posts exactly one more reading");
  hostUnderTest.run(2);
  assert.equal(
    hostUnderTest.posts.filter((message) => message.type === "meter").length,
    afterStop.length,
    "a stopped transport does not keep metering",
  );
});

test("the meter's update cost does not grow with playing time", () => {
  // The integrated measurement is a fixed histogram of gating blocks. Feeding it
  // a minute of audio must leave a reading's work exactly where it was after ten
  // seconds: `stats.lastReadBins` counts the bins a `read()` actually VISITED —
  // the occupied ones, which is the part of the work the audio decides — and it
  // is the same number whatever `stats.blocks` has grown to (the old block list
  // walked every block it held, with a log10 each, so a long Play got slower).
  // The grid the walk covers is fixed at `HISTOGRAM_BINS` either way.
  const rate = SAMPLE_RATE;
  const meter = StudioMeter.create(rate);
  meter.reset();
  const block = 4800;
  const frames = new Float32Array(block * 4);
  const tone = new Float32Array(block * 4);
  for (const target of [tone, frames]) {
    for (let at = 0; at < target.length; at += 1) {
      target[at] = Math.sin((2 * Math.PI * 997 * at) / rate) * amplitudeOf(-12);
    }
  }

  /** Feed `seconds` of the tone, in 100 ms blocks, and time the read at the end. */
  const feed = (seconds) => {
    const blocks = Math.round(seconds * 10);
    for (let index = 0; index < blocks; index += 1) {
      meter.process(frames, frames, block);
    }
    const started = process.hrtime.bigint();
    const reading = meter.read();
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    return { reading: reading, blocks: meter.stats.blocks, bins: meter.stats.lastReadBins, ms: elapsed };
  };

  const early = feed(10);
  const late = feed(50);
  assert.ok(early.blocks > 60, `ten seconds have to fill the histogram, got ${early.blocks} blocks`);
  assert.ok(
    late.blocks > early.blocks * 5,
    `a minute of Play has to hold six times the blocks, got ${early.blocks} → ${late.blocks}`,
  );
  // One steady tone puts every block in the same bin (one or two, if it sits on
  // a bin's edge), so a reading touches a handful of slots rather than the grid.
  assert.ok(
    early.bins > 0 && early.bins <= 4,
    `a steady tone has to occupy one or two of the ${StudioMeter.HISTOGRAM_BINS} bins, visited ${early.bins}`,
  );
  assert.equal(
    late.bins,
    early.bins,
    `a reading's work must not grow with playing time, ${early.bins} → ${late.bins}`,
  );
  assert.ok(
    StudioMeter.HISTOGRAM_BINS <= 1024,
    `the histogram has to stay small enough to walk every 100 ms, got ${StudioMeter.HISTOGRAM_BINS}`,
  );
  // The same reading either way, and no slower after a minute.
  assert.ok(
    Math.abs(late.reading.integrated - early.reading.integrated) < 0.01,
    `the same tone has to read the same (${early.reading.integrated} → ${late.reading.integrated})`,
  );
  assert.ok(
    late.ms <= early.ms * 2 + 2,
    `a reading after a minute must not cost more than one after ten seconds (${early.ms.toFixed(3)} → ${late.ms.toFixed(3)} ms)`,
  );
});

test("the master limiter holds the ceiling after the perf-FX bus", async () => {
  // 0.9 through a centred fader is 0.636 per channel: above a −6 dB ceiling.
  const ceilingDb = -6;
  const ceiling = amplitudeOf(ceilingDb);
  const limiter = { "ins-limiter": insertOf("ins-limiter", "master", 9, "limiter", { ceiling_db: ceilingDb, release_ms: 60 }) };

  const limited = await host(audioSong({ inserts: limiter }), { take: 0.9 });
  assert.equal(
    limited.posts.filter((message) => message.type === "master_latency").length,
    1,
    "the master chain's latency is posted once per build",
  );
  const direct = StudioDynamics.create("limiter", SAMPLE_RATE, { master: true });
  assert.equal(direct.latencyFrames, Math.round(0.0015 * SAMPLE_RATE), "a master limiter has the lookahead");
  const plain = await host(audioSong(), { take: 0.9 });
  const plainOut = plain.run(8);
  assert.ok(
    Math.abs(peakOf(plainOut.left) - 0.9 * CENTRE) < 1e-6,
    `the track has to play past the ceiling on its own, peak was ${peakOf(plainOut.left)}`,
  );
  const out = limited.run(8);
  assert.ok(
    peakOf(out.left) > 0.3,
    `the limited master has to be audible, peak was ${peakOf(out.left)}`,
  );
  assert.ok(
    peakOf(out.left) <= ceiling + 1e-6 && peakOf(out.right) <= ceiling + 1e-6,
    `the limiter has to hold ${ceilingDb} dB, peak was ${peakOf(out.left)}`,
  );
  const latency = limited.posts.find((message) => message.type === "master_latency");
  assert.ok(
    Math.abs(latency.ms - StudioDynamics.MASTER_LOOKAHEAD_SECONDS * 1000) < 0.01,
    `the master limiter's lookahead is the master's delay, got ${latency.ms} ms (${JSON.stringify(limited.posts.map((m) => m.type))})`,
  );
  const measured = truePeakDb(out.left, out.right, SAMPLE_RATE);
  assert.ok(
    measured <= ceilingDb + 0.1,
    `the render's own true-peak meter has to agree (${ceilingDb} dBTP), it read ${measured}`,
  );

  // The performance bus runs BEFORE the master chain: a held lo-fi quantises the
  // master to a 1/8 grid (0.636 → 0.625, which is past the ceiling), and the
  // limiter after it still holds the ceiling.
  const busAndLimiter = await host(audioSong({ inserts: limiter }), {
    take: 0.9,
    hold: [{ name: "lofi", amount: 1 }],
  });
  const held = busAndLimiter.run(8);
  assert.ok(
    peakOf(held.left) <= ceiling + 1e-6,
    `the limiter has to hold after the bus, peak was ${peakOf(held.left)}`,
  );

  // Without the limiter the same held lo-fi DOES pass the ceiling, so the number
  // above really is the limiter's doing and not the bus's.
  const busOnly = await host(audioSong(), { take: 0.9, hold: [{ name: "lofi", amount: 1 }] });
  const unLimited = busOnly.run(8);
  assert.ok(
    peakOf(unLimited.left) > ceiling * 1.1,
    `without a limiter the bus has to pass the ceiling, peak was ${peakOf(unLimited.left)}`,
  );
});

test("a mixed song renders faster than real time in Node", async (t) => {
  const seconds = 30;
  const insert = (id, owner, order, kind) => insertOf(id, owner, order, kind, {});
  const inserts = {};
  const sends = {};
  const tracks = [];
  // Eight tracks, each with an equalizer, a compressor and a delay — the plan's
  // own mix — all sending to the two returns.
  for (let index = 1; index <= 8; index += 1) {
    tracks.push(audioTrack(index, { gain_db: -12, pan: index % 2 === 0 ? 0.3 : -0.3 }));
    inserts[`eq-${index}`] = insert(`eq-${index}`, `track:track-${index}`, 1, "eq");
    inserts[`comp-${index}`] = insert(`comp-${index}`, `track:track-${index}`, 2, "compressor");
    inserts[`delay-${index}`] = insert(`delay-${index}`, `track:track-${index}`, 3, "delay");
    sends[`track-${index}/ret-1`] = { track_id: `track-${index}`, return_id: "ret-1", level_db: -12, pre: false };
    sends[`track-${index}/ret-2`] = { track_id: `track-${index}`, return_id: "ret-2", level_db: -18, pre: true };
  }
  inserts["ret-1-reverb"] = insert("ret-1-reverb", "return:ret-1", 1, "reverb");
  inserts["ret-2-delay"] = insert("ret-2-delay", "return:ret-2", 1, "delay");
  inserts["master-limiter"] = insert("master-limiter", "master", 1, "limiter");

  const song = audioSong({
    tracks: tracks,
    inserts: inserts,
    sends: sends,
    returns: {
      "ret-1": { id: "ret-1", name: "Hall", gain_db: -6, pan: 0.2, mute: false },
      "ret-2": { id: "ret-2", name: "Echo", gain_db: -9, pan: -0.2, mute: false },
    },
    master: { gain_db: -2, target: { lufs: -14, true_peak_db: -1 } },
  });

  // The compiled Faust effects, handed over exactly as `engine-client.js` posts
  // them, so the eight equalizers, the nine delays and the reverb are the real
  // wasm inserts and not pass-throughs.
  const modules = {};
  for (const kind of ["eq", "delay", "reverb"]) {
    modules[kind] = {
      wasm: new Uint8Array(readFileSync(join(FAUST_DIR, `${kind}.wasm`))).buffer,
      json: readFileSync(join(FAUST_DIR, `${kind}.json`), "utf8"),
    };
  }
  const hostUnderTest = await host(song, { take: 0.2 });
  hostUnderTest.post({ type: "faust-modules", modules: modules });
  await hostUnderTest.flush();
  // Every insert of this mix is a compiled effect and they are all in: from the
  // moment the modules land, nothing is "still loading" any more, and nothing
  // says anything on the error channel either. (The song was posted a moment
  // before its effects, so the one "still loading" each insert said first is
  // behind us — that is a load in progress, not a failure.)
  const afterModules = hostUnderTest.posts.length;
  assert.deepEqual(
    hostUnderTest.posts.filter((message) => message.type === "error"),
    [],
    "a mix whose effects are all compiled reports no error",
  );

  const blocks = Math.round((SAMPLE_RATE * seconds) / BLOCK);
  const started = process.hrtime.bigint();
  const out = hostUnderTest.run(blocks);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
  const ratio = elapsed / seconds;
  t.diagnostic(
    `8 tracks × (eq, compressor, delay), 2 returns and a master limiter: ${seconds} s of audio in ${elapsed.toFixed(2)} s (${(1 / ratio).toFixed(1)}× real time)`,
  );
  assert.ok(peakOf(out.left) > 0, "the mix has to be audible for the measurement to mean anything");
  assert.ok(
    ratio < 1,
    `a mixed song has to render faster than real time; ${seconds} s took ${elapsed.toFixed(2)} s (${ratio.toFixed(2)}×)`,
  );
  // And while it rendered, not one insert said it was still loading: the
  // compiled effects are live, so the mix really is the one measured above.
  assert.deepEqual(
    hostUnderTest.posts.slice(afterModules).filter((message) => message.type === "insert_loading"),
    [],
    "with the compiled effects posted, no insert is still loading",
  );
  assert.deepEqual(
    hostUnderTest.posts.slice(afterModules).filter((message) => message.type === "error"),
    [],
    "and no insert complained while the mix rendered",
  );
});

test("the engine client hands the meter, the latency and an insert fault to the page", async () => {
  // The same messages, through the port the panel subscribes to (plan 1d,
  // Tasks 9 and 10): `onMeter` follows the readings, `onMasterLatency` the delay
  // the master chain puts on the master path, and `lastMeter()` reads back the
  // newest one. This is the one test that builds a real engine client, so the
  // assets it needs are read here.
  const assets = {
    "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
    "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  };
  for (const name of SOURCE_NAMES) assets[name] = readFileSync(join(ENGINE_DIR, name), "utf8");
  const seconds = 1;
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: assets });
    const readings = [];
    const latencies = [];
    const faults = [];
    engine.onMeter((reading) => readings.push(reading));
    engine.onMasterLatency((latency) => latencies.push(latency));
    engine.onInsertFault((fault) => faults.push(fault));
    engine.setSong(
      audioSong({ inserts: { "ins-limiter": insertOf("ins-limiter", "master", 1, "limiter", { ceiling_db: -3 }) } }),
    );
    // The take the clip plays, so the master is not silence (a silent master
    // reads -Infinity LUFS, which is honest but proves nothing here).
    await engine.loadAudio("take-1", [toneTake(0.4)], SAMPLE_RATE);
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    assert.equal(buffer.length, Math.round(seconds * SAMPLE_RATE), "the render has to happen");
    // The render posts its readings as it goes; the port delivers them a moment
    // after `startRendering()` resolves.
    const delivered = await waitFor(() => readings.length > 0);
    assert.ok(delivered, "the page has to receive meter readings while the song plays");
    const latest = readings[readings.length - 1];
    for (const field of ["momentary", "short_term", "integrated", "true_peak_db", "latency_ms"]) {
      assert.ok(
        Number.isFinite(latest[field]),
        `a reading carries a finite ${field}, got ${latest[field]} (after ${readings.length} readings)`,
      );
    }
    assert.ok(
      Math.abs(latest.latency_ms - 1.5) < 0.01,
      `a reading names the master limiter's lookahead, got ${latest.latency_ms} ms`,
    );
    // The master chain is built once for the song and once more when the page's
    // compiled Faust effects land (engine-client posts them after the engine comes
    // up), so the delay is posted once per build — always the same number.
    assert.ok(latencies.length >= 1, "the master chain's latency is posted");
    for (const latency of latencies) {
      assert.ok(Math.abs(latency.ms - 1.5) < 0.01, `the master's delay is 1.5 ms, got ${latency.ms}`);
    }
    assert.deepEqual(faults, [], "a healthy chain reports no insert fault");
    assert.deepEqual(
      engine.lastMeter(),
      readings[readings.length - 1],
      "lastMeter() hands back the newest reading, as a copy",
    );
  } finally {
    if (engine) engine.dispose();
    if (!rendered) {
      try {
        await context.audioWorklet[kWorkletRelease]();
      } catch {
        /* nothing to release */
      }
    }
  }
});

test("the engine's duplicated tables match the document's", () => {
  // A worklet cannot import `server/doc.js`, so the processor carries the effect
  // labels (for its fault and loading sentences) and the dynamics kinds. Both
  // copies are pinned here: a label renamed in one place has to move in the
  // other, or the panel would name an effect the engine's messages do not.
  const LABELS = {
    eq: "equalizer",
    filter: "filter",
    delay: "delay",
    reverb: "reverb",
    chorus: "chorus",
    phaser: "phaser",
    saturation: "saturation",
    compressor: "compressor",
    limiter: "limiter",
    gate: "gate",
    deesser: "de-esser",
  };
  for (const kind of Object.keys(EFFECT_PARAMS)) {
    assert.equal(LABELS[kind], EFFECT_PARAMS[kind].label, `the ${kind} label has to match EFFECT_PARAMS`);
  }
  assert.deepEqual(
    StudioDynamics.KINDS.slice(),
    ["compressor", "limiter", "gate", "deesser"],
    "the four JavaScript dynamics are the ones the processor routes to StudioDynamics",
  );
});