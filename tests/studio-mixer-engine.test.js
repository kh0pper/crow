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
 *   - **Editing a chain while the song plays** (Review Focus 3): old → new over
 *     exactly 64 frames, linearly, with no step bigger than the ramp.
 *   - **A failed insert** (Review Focus 3): a block that comes back with a NaN is
 *     replaced by that insert's input, the insert is bypassed in the ENGINE (the
 *     song is never edited) and the fault is said once — and a rebuild of it
 *     clears the fault.
 *   - **A Faust insert whose module has not arrived** passes audio through and
 *     says so once, and becomes a real effect when the modules land.
 *   - **The meter**: the same BS.1770-4 gating `server/loudness.js` measures a
 *     render with, within 0.1 LU, and the same 4× true-peak filter; and the
 *     processor posts a reading every 100 ms of audio and once on stop.
 *   - **Mute and solo** reach the sends, and a return is never muted by a solo.
 *   - **The master limiter** holds its ceiling after the performance-effects bus.
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
 * @returns {string} one classic script, ready to be concatenated into the module
 */
function stubDynamicsSource(factor, nanKinds = []) {
  return [
    "(function () {",
    '  "use strict";',
    '  const KINDS = Object.freeze(["compressor", "limiter", "gate", "deesser"]);',
    `  const NAN_KINDS = ${JSON.stringify(nanKinds)};`,
    `  const FACTOR = ${factor};`,
    "  function create(kind, rate) {",
    "    const poison = NAN_KINDS.indexOf(kind) !== -1;",
    "    return {",
    "      kind: kind,",
    "      rate: rate,",
    "      latencyFrames: 0,",
    "      setParams: function setParams() {},",
    "      reset: function reset() {},",
    "      params: function params() { return {}; },",
    "      process: function process(left, right, frames) {",
    "        for (let index = 0; index < frames; index += 1) {",
    "          if (poison) {",
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
  post({ type: "audio", take_id: "take-1", channels: [takeOf(plan.take === undefined ? 0.4 : plan.take)] });
  for (const item of plan.hold || []) post({ type: "fx", name: item.name, amount: item.amount, on: true });
  post({ type: "launchScene", id: "scene-1" });
  post({ type: "play" });
  await flush();

  return {
    post: post,
    flush: flush,
    posts: posts,
    /**
     * Render `blocks` blocks of 128 frames and hand back the master.
     * @param {number} blocks
     * @returns {{left: Float32Array, right: Float32Array}}
     */
    run(blocks) {
      const total = blocks * BLOCK;
      const left = new Float32Array(total);
      const right = new Float32Array(total);
      for (let index = 0; index < blocks; index += 1) {
        const start = index * BLOCK;
        const channels = [left.subarray(start, start + BLOCK), right.subarray(start, start + BLOCK)];
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

/** @returns {number} a level in dB as an amplitude. */
function amplitudeOf(db) {
  return Math.pow(10, db / 20);
}

/** The direct level of a track at 0 dB and centre: 0.4 × cos(π/4). */
const DIRECT = 0.4 * Math.cos(Math.PI / 4);

/** The constant-power gain of a centred pan, which a return's own fader applies. */
const CENTRE = Math.cos(Math.PI / 4);

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
  const said = hostUnderTest.posts.filter(
    (message) => message.type === "error" && String(message.error).includes("is still loading."),
  );
  assert.equal(said.length, 1, `one "still loading" per insert, got ${said.length}: ${JSON.stringify(said)}`);
  assert.equal(said[0].error, "reverb on Track 1 is still loading.", "the sentence names the effect and the track");

  // The modules arrive: the processor compiles them and builds the chains
  // again, so the reverb becomes a real insert (over a crossfade, while the
  // song plays).
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
    hostUnderTest.posts.filter((message) => message.type === "error").length,
    1,
    "a load that worked is not reported again",
  );
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