/**
 * Studio performance effects and the looper — the master bus, frame by frame.
 *
 * Three layers are pinned here.
 *
 * **The bus itself** (`engine/perf-fx.js`) is driven with a synthetic transport
 * over a synthetic stereo signal, one 128-frame run at a time exactly as the
 * processor drives it. That is the only way to say exactly WHICH frame an
 * effect is released on: a port message posted to an offline render is applied
 * before the first block, so a mid-render release cannot be posted from
 * outside — while the release frame is what every assertion here is about (the
 * 64-frame crossfade, the reverb's tail, the stutter's capture, the tape stop's
 * one beat, and the looper's bar lines).
 *
 * **The processor** (`engine/studio-processor.js`), composed exactly as
 * `engine-client.js` composes it and run in this thread with the three worklet
 * globals it uses supplied as arguments. No SunVox glue and no native audio:
 * its song is one AUDIO track, whose PCM voices are plain JavaScript, which is
 * enough to prove the master goes through the looper and the performance bus in
 * that order and that a release hands the dry master back.
 *
 * **The engine** through `engine-client.js`, for the wiring: a held effect
 * reaches the master and the master tap (which copies it AFTER the bus), a
 * scene launch and a stop do not release it, and a release handed to the
 * processor gives back the dry master bit for bit once the crossfade is over.
 * Those renders are the very same worklet a browser runs, and read their audio
 * with `copyFromChannel()` (never `getChannelData()` in Node). A host that
 * cannot resolve `node-web-audio-api` skips them.
 *
 * At 120 bpm and 48 kHz one beat is 24,000 frames, one 1/8 is 3,000 and one bar
 * is 96,000.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own dependency, resolved from inside the bundle (that is where
// package.json declares it).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));

const SAMPLE_RATE = 48000;
const BPM = 120;
const BEATS_PER_BAR = 4;
const BEAT_FRAMES = 24000;
const BAR_FRAMES = BEAT_FRAMES * BEATS_PER_BAR;
const BLOCK = 128;

// The bus is a classic script the worklet and Node both load, so a test can
// require it directly: no engine, no worklet, no browser.
const perfFx = bundleRequire(join(ENGINE_DIR, "perf-fx.js"));

const RELEASE_FRAMES = perfFx.RELEASE_FRAMES;

/** The amount each effect is held at, chosen so its own change is unmistakable. */
const AMOUNTS = {
  filter_sweep: 0.8,
  lofi: 1,
  stutter: 0.5,
  tape_stop: 0.7,
  reverb_throw: 0.6,
};

// --- the bus, driving synthetic audio ---------------------------------------

/**
 * A stereo test signal whose every frame is its own level, so a wrong frame
 * read is visible: two sines at different rates, under full scale.
 * @param {number} frames
 * @returns {{left: Float32Array, right: Float32Array}}
 */
function signalOf(frames) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    left[at] = Math.sin(at / 37) * 0.4;
    right[at] = Math.sin(at / 53 + 0.7) * 0.3;
  }
  return { left, right };
}

/**
 * The transport one run reads, at 120 bpm and four beats to the bar: at this
 * tempo a bar is a whole 96,000 frames, so the bar lines sit on the multiples.
 * @param {number} frame the absolute frame the run's first sample sits on
 * @param {{playing?: boolean, barFrame?: number|null}} [overrides]
 * @returns {object}
 */
function transportAt(frame, overrides) {
  const barFrame = Math.floor(frame / BAR_FRAMES) * BAR_FRAMES;
  return {
    frame: frame,
    offset: 0,
    playing: true,
    bpm: BPM,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: barFrame,
    ...overrides,
  };
}

/**
 * Run the bus over a signal in 128-frame runs, exactly as the processor does:
 * `loop()` then `process()`, on a view of the run's own frames, with the
 * performance gestures applied at the run they are scripted on (the processor
 * applies them at a block's first frame).
 * @param {{left: Float32Array, right: Float32Array}} signal
 * @param {{hold?: object[], release?: object[], looper?: object[], stopAt?: number}} [plan]
 *   `hold` is `{at, name, amount}` per hold, `release` `{at, name}` per release,
 *   `looper` `{at, action}` per command, and `stopAt` the frame the transport
 *   stops at (`playing` goes false and the bar grid goes away)
 * @returns {{left: Float32Array, right: Float32Array, bus: object}}
 */
function runBus(signal, plan) {
  const { hold = [], release = [], looper = [], stopAt = null } = plan || {};
  const left = Float32Array.from(signal.left);
  const right = Float32Array.from(signal.right);
  const bus = perfFx.create(SAMPLE_RATE);
  const total = left.length;
  for (let start = 0; start < total; start += BLOCK) {
    const count = Math.min(BLOCK, total - start);
    for (const item of hold) if (item.at === start) bus.hold(item.name, item.amount);
    for (const item of release) if (item.at === start) bus.release(item.name);
    for (const item of looper) if (item.at === start) bus.looper(item.action);
    const transport =
      stopAt !== null && start >= stopAt
        ? transportAt(start, { playing: false, barFrame: null })
        : transportAt(start);
    // A run's own frames, exactly what a worklet's output buffer holds: index 0
    // inside it is `transport.frame`.
    const viewLeft = left.subarray(start, start + count);
    const viewRight = right.subarray(start, start + count);
    bus.loop(viewLeft, viewRight, count, transport);
    bus.process(viewLeft, viewRight, count, transport);
  }
  return { left, right, bus };
}

/**
 * The first frame from `from` on where a render leaves the signal, or -1.
 * @param {{left: Float32Array, right: Float32Array}} out
 * @param {{left: Float32Array, right: Float32Array}} dry
 * @param {number} from
 * @returns {number}
 */
function firstDifferenceFrom(out, dry, from) {
  for (let at = Math.max(0, from); at < dry.left.length; at += 1) {
    if (out.left[at] !== dry.left[at]) return at;
    if (out.right[at] !== dry.right[at]) return at;
  }
  return -1;
}

/**
 * The last frame where a render leaves the signal, or -1.
 * @param {{left: Float32Array, right: Float32Array}} out
 * @param {{left: Float32Array, right: Float32Array}} dry
 * @returns {number}
 */
function lastDifference(out, dry) {
  for (let at = dry.left.length - 1; at >= 0; at -= 1) {
    if (out.left[at] !== dry.left[at]) return at;
    if (out.right[at] !== dry.right[at]) return at;
  }
  return -1;
}

/**
 * The largest difference between a render and the dry signal in a window.
 * @returns {number}
 */
function peakDifference(out, dry, from, to) {
  let peak = 0;
  for (let at = Math.max(0, from); at < Math.min(dry.left.length, to); at += 1) {
    peak = Math.max(peak, Math.abs(out.left[at] - dry.left[at]), Math.abs(out.right[at] - dry.right[at]));
  }
  return peak;
}

/** @returns {number} the largest absolute sample of one channel. */
function peakOf(samples, from = 0, to = samples.length) {
  let peak = 0;
  for (let at = Math.max(0, from); at < Math.min(samples.length, to); at += 1) {
    const value = Math.abs(samples[at]);
    if (value > peak) peak = value;
  }
  return peak;
}

// --- the tests ---------------------------------------------------------------

test("releasing every effect returns the exact dry signal 64 frames after release (the reverb after its tail)", () => {
  // Six seconds of signal: long enough for the reverb's tail to fall the whole
  // 120 dB back into the dry signal, and short enough to stay quick.
  const signal = signalOf(6 * SAMPLE_RATE);
  const holdAt = BLOCK * 4;
  const releaseAt = BLOCK * 40;

  /** One render with some effects held and then released together. */
  const run = (names) => {
    const plan = { hold: [], release: [] };
    for (const name of names) {
      plan.hold.push({ at: holdAt, name: name, amount: AMOUNTS[name] });
      plan.release.push({ at: releaseAt, name: name });
    }
    return runBus(signal, plan);
  };

  for (const name of perfFx.CHAIN) {
    const out = run([name]);

    // Before the hold the master is untouched, and while it is held the effect
    // is doing something: a test that never heard the effect proves nothing.
    const before = firstDifferenceFrom(out, signal, 0);
    assert.ok(
      before === -1 || before >= holdAt,
      `${name} must not change the master before it is held (first difference at ${before})`,
    );
    assert.ok(
      peakDifference(out, signal, holdAt, releaseAt) > 1e-4,
      `${name} has to change the master while it is held`,
    );

    if (name === "reverb_throw") {
      // The send closes on release and the tail rings out: once a 128-frame
      // block's peak is below −120 dBFS the state is dropped and the bus is
      // bit-exact dry again.
      const clearFrame = lastDifference(out, signal);
      assert.ok(
        clearFrame >= releaseAt,
        `the reverb's tail has to outlive the release, last difference at ${clearFrame}`,
      );
      assert.ok(
        clearFrame < releaseAt + 3 * SAMPLE_RATE,
        `the reverb's tail has to fall below −120 dBFS within a few seconds, last difference at ${clearFrame}`,
      );
      assert.ok(
        clearFrame < signal.left.length - SAMPLE_RATE,
        `the reverb's tail has to clear inside the render, last difference at ${clearFrame} of ${signal.left.length}`,
      );
      assert.equal(
        firstDifferenceFrom(out, signal, clearFrame + 1),
        -1,
        `after its tail the reverb has to leave the exact dry signal, from frame ${clearFrame + 1} on`,
      );
      continue;
    }

    // It stays applied up to the release, and 64 frames later it is gone: the
    // bus writes nothing from there on, so the master is bit-exact.
    assert.ok(
      lastDifference(out, signal) >= releaseAt,
      `${name} has to stay applied until its release frame`,
    );
    assert.equal(
      firstDifferenceFrom(out, signal, releaseAt + RELEASE_FRAMES),
      -1,
      `${name} has to leave the exact dry signal ${RELEASE_FRAMES} frames after its release`,
    );
  }

  // The effects that crossfade, all at once: held together, released together,
  // dry together.
  const crossfading = perfFx.CHAIN.filter((name) => name !== "reverb_throw");
  const together = run(crossfading);
  assert.ok(peakDifference(together, signal, holdAt, releaseAt) > 1e-4, "the chain has to be audible while held");
  assert.equal(
    firstDifferenceFrom(together, signal, releaseAt + RELEASE_FRAMES),
    -1,
    `the whole chain has to leave the exact dry signal ${RELEASE_FRAMES} frames after the release`,
  );
  assert.equal(together.bus.activeCount(), 0, "every effect has to be dropped once its crossfade is over");

  // And all five together: everything but the reverb's tail is dry by 64 frames,
  // and the reverb's state is dropped once its own tail has gone.
  const all = run(perfFx.CHAIN);
  const clearFrame = lastDifference(all, signal);
  assert.ok(clearFrame >= releaseAt, `the reverb's tail has to outlive the release, last difference at ${clearFrame}`);
  assert.equal(
    firstDifferenceFrom(all, signal, clearFrame + 1),
    -1,
    `with the reverb thrown too, the bus has to be exact dry from frame ${clearFrame + 1} on`,
  );
  assert.equal(
    all.bus.activeCount(),
    0,
    `all five effects have to be dropped in the end, still live: ${all.bus.heldNames().join(",")}`,
  );
});

test("a bus with nothing held costs the master nothing", () => {
  const signal = signalOf(BLOCK * 8);
  const out = runBus(signal);
  assert.equal(out.bus.activeCount(), 0, "an idle bus holds no effect state");
  assert.deepEqual(out.bus.heldNames(), [], "an idle bus applies nothing");
  assert.equal(firstDifferenceFrom(out, signal, 0), -1, "an idle bus has to leave the master bit for bit");
});

test("a stopped transport keeps a held stutter repeating and a held tape stop silent", () => {
  const signal = signalOf(BAR_FRAMES);
  const holdAt = BLOCK * 8;
  const stopAt = BLOCK * 200; // 25,600 frames: well inside the stutter's loop
  const sliceFrames = BEAT_FRAMES / 8; // the 1/8 a stutter at amount 0.5 holds

  const stutter = runBus(signal, {
    hold: [{ at: holdAt, name: "stutter", amount: 0.5 }],
    stopAt: stopAt,
  });
  // The captured slice keeps looping after the transport stops: the effect runs
  // on its own captured frames, not on the playhead.
  for (const at of [stopAt, stopAt + 1, stopAt + 1000, BAR_FRAMES - 1]) {
    const wanted = signal.left[holdAt + ((at - holdAt) % sliceFrames)];
    assert.equal(stutter.left[at], wanted, `frame ${at} has to repeat the captured slice after the stop`);
  }

  const tape = runBus(signal, {
    hold: [{ at: holdAt, name: "tape_stop", amount: 1 }],
    stopAt: stopAt,
  });
  // Its one-beat ramp is long over: silence, and it stays silent.
  for (const at of [stopAt, stopAt + 1, stopAt + 20000, BAR_FRAMES - 1]) {
    assert.equal(tape.left[at], 0, `frame ${at} is past the tape stop's beat and has to be silent`);
    assert.equal(tape.right[at], 0, `frame ${at} is past the tape stop's beat and has to be silent on the right`);
  }
});

test("stutter repeats the current 1/8 in time", () => {
  const signal = signalOf(BEAT_FRAMES + 2000);
  const holdAt = BLOCK * 8;
  const sliceFrames = BEAT_FRAMES / 8;

  const out = runBus(signal, { hold: [{ at: holdAt, name: "stutter", amount: 0.5 }] });

  // Before the hold the master is untouched, and the difference starts exactly
  // when the captured slice starts looping.
  assert.equal(
    firstDifferenceFrom(out, signal, 0),
    holdAt + sliceFrames,
    "the stutter must not touch the master until its captured slice starts looping",
  );
  // The slice is captured as it plays, so it passes the live signal through
  // while it fills, and loops it from the frame after it is full.
  for (let at = holdAt; at < holdAt + sliceFrames; at += 1) {
    assert.equal(out.left[at], signal.left[at], `frame ${at} is the slice being captured, which plays live`);
  }
  for (let at = holdAt + sliceFrames; at < out.left.length; at += 1) {
    const wanted = signal.left[holdAt + ((at - holdAt) % sliceFrames)];
    assert.equal(out.left[at], wanted, `frame ${at} has to repeat the 1/8 captured at frame ${holdAt}`);
    const wantedRight = signal.right[holdAt + ((at - holdAt) % sliceFrames)];
    assert.equal(out.right[at], wantedRight, `frame ${at} has to repeat the 1/8 on the right too`);
  }

  // The division follows the amount: 0.9 is a 1/16, and the repetition has that
  // period instead.
  const fast = runBus(signal, { hold: [{ at: holdAt, name: "stutter", amount: 0.9 }] });
  const sixteenth = BEAT_FRAMES / 16;
  for (const at of [holdAt + sixteenth + 10, holdAt + 2 * sixteenth + 10, holdAt + 5 * sixteenth + 10]) {
    assert.equal(
      fast.left[at],
      signal.left[holdAt + ((at - holdAt) % sixteenth)],
      `frame ${at} has to repeat a 1/16 when the amount is 0.9`,
    );
  }
});

test("tape stop reaches silence in one beat", () => {
  const signal = signalOf(BEAT_FRAMES + 20000);
  const holdAt = BLOCK * 8;

  const out = runBus(signal, { hold: [{ at: holdAt, name: "tape_stop", amount: 1 }] });

  // The read head starts at the write head: the frame it is held on is played as
  // it is (speed 1), and the stop drifts behind it from there.
  assert.ok(
    Math.abs(out.left[holdAt] - signal.left[holdAt]) < 1e-12,
    `the tape stop's own frame has to be the live frame, got ${out.left[holdAt]} for ${signal.left[holdAt]}`,
  );
  assert.ok(
    peakOf(out.left, holdAt, holdAt + BEAT_FRAMES) > 0.01,
    "the tape stop has to keep sounding through its beat",
  );

  // One beat after the hold, the speed has reached 0 and there is nothing left.
  for (const at of [holdAt + BEAT_FRAMES, holdAt + BEAT_FRAMES + 1, holdAt + BEAT_FRAMES + 5000, out.left.length - 1]) {
    assert.equal(out.left[at], 0, `frame ${at} is past the tape stop's one beat and has to be silent`);
    assert.equal(out.right[at], 0, `frame ${at} is past the tape stop's one beat and has to be silent on the right`);
  }

  // A release hands the master back: the effect fades out over 64 frames and is
  // then gone, whatever it was doing.
  const releaseAt = holdAt + BLOCK * 4;
  const released = runBus(signal, {
    hold: [{ at: holdAt, name: "tape_stop", amount: 1 }],
    release: [{ at: releaseAt, name: "tape_stop" }],
  });
  assert.equal(
    firstDifferenceFrom(released, signal, releaseAt + RELEASE_FRAMES),
    -1,
    "a released tape stop has to leave the exact dry signal",
  );
});

test("looper records a bar and plays it back", () => {
  const signal = signalOf(2 * BAR_FRAMES + 4096);
  const out = runBus(signal, {
    looper: [
      // Frame 0 is a bar line: the recording starts there.
      { at: 0, action: "record" },
      // Asked for mid-bar, so it takes the bar line after it: the take is one bar.
      { at: BAR_FRAMES / 2, action: "play" },
    ],
  });

  // Recording does not change what is heard.
  assert.equal(firstDifferenceFrom(out, signal, 0), BAR_FRAMES, "recording must not change the master");

  // The take loops from the bar line it was finished on, mixed into the master.
  for (const at of [BAR_FRAMES, BAR_FRAMES + 1, BAR_FRAMES + 50000, 2 * BAR_FRAMES - 1, 2 * BAR_FRAMES + 1000]) {
    const held = at < 2 * BAR_FRAMES ? at - BAR_FRAMES : at - 2 * BAR_FRAMES;
    const wantedLeft = Math.fround(signal.left[at] + signal.left[held]);
    const wantedRight = Math.fround(signal.right[at] + signal.right[held]);
    assert.equal(out.left[at], wantedLeft, `frame ${at} has to be the master plus the take's frame ${held}`);
    assert.equal(out.right[at], wantedRight, `frame ${at} has to be the master plus the take's frame ${held}`);
  }

  // The buffer holds whole bars of the master it recorded.
  const take = out.bus.take();
  assert.equal(take.rate, SAMPLE_RATE, "the take names the engine's rate");
  assert.equal(take.bars, 1, "one bar was recorded");
  assert.equal(take.channels.length, 2, "the take is stereo");
  assert.equal(take.channels[0].length, BAR_FRAMES, "the take is exactly one bar long");
  assert.equal(take.channels[0][0], signal.left[0], "the take starts where the bar did");
  assert.equal(take.channels[0][BAR_FRAMES - 1], signal.left[BAR_FRAMES - 1], "and ends where it did");

  // `stop` leaves the take alone, `clear` empties it at once.
  out.bus.looper("stop");
  assert.equal(out.bus.take().bars, 1, "stopping the looper keeps the take");
  out.bus.looper("clear");
  assert.equal(out.bus.take().bars, 0, "clearing the looper empties it");
  assert.equal(out.bus.take().channels[0].length, 0, "a cleared take has nothing to read");
});

test("looperTake returns the recorded bars", async (t) => {
  // Two whole bars captured, read the way the processor's `looper_take` message
  // reads them: whole bars only, never a partial one.
  const signal = signalOf(3 * BAR_FRAMES);
  const out = runBus(signal, {
    looper: [
      { at: 0, action: "record" },
      // A block after the first bar line, so the take closes on the second one.
      { at: BAR_FRAMES + BLOCK, action: "play" },
    ],
  });
  const take = out.bus.take();
  assert.equal(take.bars, 2, "the take is two bars");
  assert.equal(take.channels[0].length, 2 * BAR_FRAMES, "two bars of frames");
  assert.equal(take.channels[0][2 * BAR_FRAMES - 1], signal.left[2 * BAR_FRAMES - 1], "the take holds the master");

  // Mid-recording, the take answers the whole bars it has so far.
  const recording = runBus(signalOf(BAR_FRAMES + 1000), { looper: [{ at: 0, action: "record" }] });
  const partial = recording.bus.take();
  assert.equal(partial.bars, 1, "a recording in its second bar has one whole bar to hand over");
  assert.equal(partial.channels[0].length, BAR_FRAMES, "and hands over exactly that");

  // And the engine's own round trip: `looperTake()` answers over the port with
  // the same shape (nothing recorded, so no bars).
  const tools = await engineTools();
  if (!tools) {
    t.skip(engineSkipReason());
    return;
  }
  const fromEngine = await tools.looperTake();
  assert.ok(Array.isArray(fromEngine.channels), "looperTake has to answer with channels");
  assert.equal(fromEngine.channels.length, 2, "the looper's take is stereo");
  assert.equal(fromEngine.rate, SAMPLE_RATE, "the take names the context's rate");
  assert.equal(fromEngine.bars, 0, "a looper that has recorded nothing has no bars to give");
});

test("overdub adds the live master to the take", () => {
  const signal = signalOf(3 * BAR_FRAMES);
  const firstAt = BAR_FRAMES + 1000;
  const secondAt = 2 * BAR_FRAMES + 1000;
  const out = runBus(signal, {
    looper: [
      { at: 0, action: "record" },
      // On the first bar line: the one-bar take closes there and starts
      // overdubbing from its own top.
      { at: BAR_FRAMES, action: "overdub" },
    ],
  });

  // The first pass is the take it recorded: the bar it played, one bar later.
  assert.equal(
    out.left[firstAt],
    Math.fround(signal.left[firstAt] + signal.left[1000]),
    "the first pass of the take is the bar it recorded",
  );
  // The overdub added the live master into the take as it went, so the second
  // pass carries that frame's own level on top of what the take held.
  const held = Math.fround(signal.left[1000] + signal.left[firstAt]);
  assert.equal(
    out.left[secondAt],
    Math.fround(signal.left[secondAt] + held),
    "the overdubbed pass has to hold the take plus the master it added",
  );
});

// --- the engine --------------------------------------------------------------

/** What a test is told when this host cannot load the engine at all. */
let engineSkip = "";

/** @returns {string} why the engine tests cannot run here. */
function engineSkipReason() {
  return `no offline audio engine in this host (${engineSkip})`;
}

/** @returns {object|null} the engine's tools, or null when this host has none. */
let engineToolsPromise;
async function engineTools() {
  if (engineToolsPromise === undefined) {
    engineToolsPromise = (async () => {
      try {
        const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
        const client = bundleRequire(join(ENGINE_DIR, "engine-client.js"));
        const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);
        return {
          OfflineAudioContext: OfflineAudioContext,
          client: client,
          releaseSymbol: kWorkletRelease,
          assets: {
            "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
            "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
            "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
            "perf-fx.js": readFileSync(join(ENGINE_DIR, "perf-fx.js"), "utf8"),
            "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
            "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
            "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
          },
        };
      } catch (error) {
        engineSkip = String((error && error.message) || error);
        return null;
      }
    })();
  }
  const tools = await engineToolsPromise;
  if (!tools) return null;
  return {
    render: (song, options) => renderFxSong(tools, song, options),
    looperTake: () => looperTakeFromEngine(tools),
  };
}

/** @returns {object} one track, one scene, one clip of Analog generator notes. */
function fxSong() {
  return {
    meta: { title: "Performance effects", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Lead",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: -6,
        pan: 0,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "One",
        length_bars: 1,
        notes: [
          { t: 0, d: 2, p: 60, v: 100 },
          { t: 2, d: 1.5, p: 67, v: 90 },
        ],
      },
    },
  };
}

/**
 * Release the worklet thread of a context that never rendered.
 * @param {BaseAudioContext} context
 * @param {Function} symbol
 * @returns {Promise<void>}
 */
async function releaseWorklet(context, symbol) {
  try {
    await context.audioWorklet[symbol]();
  } catch {
    /* nothing to release */
  }
}

/**
 * Render one song offline through the real engine, with a script the test runs
 * between the song and the render (holds, launches, stops).
 * @param {object} tools
 * @param {object} song
 * @param {{seconds?: number, tap?: boolean, hold?: object[], release?: string[],
 *          script?: (client: object) => void}} [options]
 * @returns {Promise<{left: Float32Array, right: Float32Array, taps: object[]}>}
 */
async function renderFxSong(tools, song, options = {}) {
  const seconds = options.seconds === undefined ? 1.5 : options.seconds;
  const context = new tools.OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let client = null;
  let rendered = false;
  const taps = [];
  try {
    client = await tools.client.create(context, { assetBytes: tools.assets });
    if (options.tap === true) client.onTap((block) => taps.push(block));
    client.setSong(song);
    for (const item of options.hold || []) client.fxHold(item.name, item.amount);
    for (const name of options.release || []) client.fxRelease(name);
    if (typeof options.script === "function") {
      options.script(client);
    } else {
      client.launchScene(song.scenes[0].id);
      client.play();
    }
    client.node.connect(context.destination);
    if (options.tap === true) client.tap("master", true);
    await client.flush();
    const buffer = await context.startRendering();
    rendered = true;
    // copyFromChannel, never getChannelData: see renderSong in server/render.js.
    const left = new Float32Array(buffer.length);
    const right = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    return { left, right, taps };
  } finally {
    if (client) client.dispose();
    if (!rendered) await releaseWorklet(context, tools.releaseSymbol);
  }
}

/** @returns {Promise<object>} `looperTake()` on a fresh engine, nothing rendered. */
async function looperTakeFromEngine(tools) {
  const context = new tools.OfflineAudioContext({ numberOfChannels: 2, length: BLOCK, sampleRate: SAMPLE_RATE });
  let client = null;
  try {
    client = await tools.client.create(context, { assetBytes: tools.assets });
    await client.flush();
    return await client.looperTake();
  } finally {
    if (client) client.dispose();
    await releaseWorklet(context, tools.releaseSymbol);
  }
}

test("an effect held across a scene launch and a stop is still held until release", async (t) => {
  const tools = await engineTools();
  if (!tools) {
    t.skip(engineSkipReason());
    return;
  }

  const song = fxSong();
  const dry = await tools.render(song, { seconds: 1.5 });
  const held = await tools.render(song, {
    seconds: 1.5,
    script(client) {
      client.fxHold("lofi", 1);
      client.launchScene("scene-1");
      client.play();
    },
  });
  assert.ok(peakOf(dry.left) > 0.001, `the song has to be audible, peak was ${peakOf(dry.left)}`);
  assert.ok(
    peakDifference(held, dry, 0, dry.left.length) > 1e-4,
    "a held lo-fi has to change the master, or this test proves nothing",
  );

  // The same hold, but with a stop, a relaunch and a whole new song between the
  // hold and the render: a scene launch, a stop and a pattern change are none of
  // the performance bus's business.
  const heldAcross = await tools.render(song, {
    seconds: 1.5,
    script(client) {
      client.fxHold("lofi", 1);
      client.launchScene("scene-1");
      client.stopAll();
      client.stop();
      client.play();
      client.setSong(song);
      client.launchScene("scene-1");
    },
  });
  assert.equal(
    firstDifferenceFrom(heldAcross, held, 0),
    -1,
    "a scene launch, a stop and a song update must not release a held effect",
  );
});

test("a held effect reaches the master and the master tap copies it", async (t) => {
  const tools = await engineTools();
  if (!tools) {
    t.skip(engineSkipReason());
    return;
  }

  const song = fxSong();
  const dry = await tools.render(song, { seconds: 1, tap: true });
  const held = await tools.render(song, { seconds: 1, tap: true, hold: [{ name: "lofi", amount: 1 }] });

  assert.ok(peakOf(dry.left) > 0.001, `the song has to be audible, peak was ${peakOf(dry.left)}`);
  assert.ok(
    peakDifference(held, dry, 0, dry.left.length) > 1e-4,
    "a held lo-fi has to change the master, or this test proves nothing",
  );

  // The master tap copies the master AFTER the performance bus: what it
  // delivers is exactly the rendered channel, held or not — never the dry mix a
  // bus effect would hide.
  for (const render of [dry, held]) {
    const delivered = [];
    for (const block of render.taps) {
      assert.equal(block.target, "master", "the tap names the master");
      for (let at = 0; at < block.channels[0].length; at += 1) delivered.push(block.channels[0][at]);
    }
    assert.ok(delivered.length >= render.left.length, `the tap has to cover the render, got ${delivered.length}`);
    for (let at = 0; at < render.left.length; at += 1) {
      assert.equal(delivered[at], render.left[at], `tap frame ${at} has to be the master after the bus`);
    }
  }
});

test("a released effect gives the dry master back after its 64 frames", async (t) => {
  const tools = await engineTools();
  if (!tools) {
    t.skip(engineSkipReason());
    return;
  }

  const song = fxSong();
  const dry = await tools.render(song, { seconds: 1 });
  assert.ok(peakOf(dry.left) > 0.001, `the song has to be audible, peak was ${peakOf(dry.left)}`);

  // Held and released before the first block: the crossfade runs over the
  // render's first 64 frames and the effect is dropped there. The reverb throw
  // is the exception — its send closes and its tail rings on — so it is pinned
  // by the bus test above.
  for (const name of ["stutter", "tape_stop", "filter_sweep", "lofi"]) {
    const render = await tools.render(song, {
      seconds: 1,
      hold: [{ name: name, amount: AMOUNTS[name] }],
      release: [name],
    });
    assert.equal(
      firstDifferenceFrom(render, dry, RELEASE_FRAMES),
      -1,
      `${name} has to leave the exact dry master ${RELEASE_FRAMES} frames after its release`,
    );
  }
});

// --- the processor, in a stand-in worklet scope ------------------------------
//
// The real `studio-processor.js` composed exactly as `engine-client.js` composes
// it, run in this thread with the three worklet globals it uses (`sampleRate`,
// `currentFrame`, `AudioWorkletProcessor`/`registerProcessor`) supplied as
// arguments. No SunVox glue and no native audio: the song below is one AUDIO
// track, whose PCM voices are plain JavaScript, which is enough to prove that
// the master goes through the looper and the performance bus in that order and
// that a release hands the dry master back. It runs on every host, including
// one whose bundle cannot load `node-web-audio-api`.

/** The smallest valid wasm module: enough for the processor's own compile. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** @returns {object} the engine client's classic script, as a Node module. */
function engineClientApi() {
  return bundleRequire(join(ENGINE_DIR, "engine-client.js"));
}

/**
 * Compose and evaluate the worklet module with stand-in worklet globals, and
 * hand back the processor class it registered.
 * @returns {{name: string, cls: Function, posts: object[]}}
 */
function loadProcessorClass() {
  const names = ["sequencer.js", "resample.js", "sampler-voice.js", "perf-fx.js", "studio-processor.js"];
  const texts = names.map((name) => readFileSync(join(ENGINE_DIR, name), "utf8"));
  const source = engineClientApi().composeEngineModule(texts);
  const posts = [];
  let registered = null;
  // The worklet globals `studio-processor.js` reads. `sampleRate` and
  // `currentFrame` are bare identifiers there, so they are parameters here.
  class StandInProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => posts.push(message),
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
  return { name: registered.name, cls: registered.cls, posts: posts };
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
async function waitFor(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle();
  return predicate();
}

/** @returns {object} one audio track whose clip plays a one-bar take. */
function audioSong() {
  return {
    meta: { title: "Bus probe", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Guitar",
        color: "#8FC1E8",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "One",
        length_bars: 1,
        kind: "audio",
        notes: [],
        comp: [{ take_id: "take-1", from_beat: 0, to_beat: 4 }],
      },
    },
    takes: {
      "take-1": {
        id: "take-1",
        clip_id: "clip-1",
        rate: SAMPLE_RATE,
        offset_frames: 0,
        discarded: false,
      },
    },
    arrangement: { placements: {}, markers: {}, sections: {} },
  };
}

/** @returns {Float32Array} one bar of a constant 0.4, at the context's rate. */
function takeOfOneBar() {
  const samples = new Float32Array(BAR_FRAMES);
  samples.fill(0.4);
  return samples;
}

/**
 * A processor running the real worklet code, with helpers to post messages and
 * render blocks.
 * @param {{hold?: object[], release?: string[]}} [plan]
 * @returns {Promise<{post: Function, flush: Function, run: Function, posts: object[]}>}
 */
async function processorHost(plan) {
  const { hold = [], release = [] } = plan || {};
  const loaded = loadProcessorClass();
  const processor = new loaded.cls({ processorOptions: { wasmBinary: EMPTY_WASM } });
  await settle();
  const ready = await waitFor(() => loaded.posts.some((message) => message.type === "ready"));
  assert.ok(ready, `the processor has to come up and report ready, it posted ${JSON.stringify(loaded.posts)}`);

  /** @param {object} message @returns {void} */
  const post = (message) => {
    processor.port.onmessage({ data: message });
  };

  /** @returns {Promise<void>} resolves once the processor applied everything posted. */
  const flush = async () => {
    let id = 0;
    for (const message of loaded.posts) if (message.type === "flushed") id = Math.max(id, message.id);
    id += 1;
    processor.port.onmessage({ data: { type: "flush", id: id } });
    const applied = await waitFor(
      () => loaded.posts.some((message) => message.type === "flushed" && message.id === id),
    );
    if (!applied) throw new Error("the processor never answered a flush");
  };

  post({ type: "song", snapshot: audioSong() });
  post({ type: "audio", take_id: "take-1", channels: [takeOfOneBar()] });
  for (const item of hold) post({ type: "fx", name: item.name, amount: item.amount, on: true });
  for (const name of release) post({ type: "fx", name: name, amount: 0, on: false });
  post({ type: "launchScene", id: "scene-1" });
  post({ type: "play" });
  await flush();

  return {
    post: post,
    flush: flush,
    posts: loaded.posts,
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

test("the processor runs the bus after the mix and gives the dry master back after a release", async () => {
  const dry = await processorHost();
  const dryMaster = dry.run(8);
  // One audio track at 0 dB and centre: 0.4 × cos(π/4).
  const wanted = 0.4 * Math.cos(Math.PI / 4);
  assert.ok(
    Math.abs(dryMaster.left[BLOCK] - wanted) < 1e-6,
    `the dry master has to be the track's own output, got ${dryMaster.left[BLOCK]} for ${wanted}`,
  );

  const held = await processorHost({ hold: [{ name: "lofi", amount: 1 }] });
  const heldMaster = held.run(8);
  assert.ok(
    peakDifference(heldMaster, dryMaster, 0, 8 * BLOCK) > 1e-4,
    "a held lo-fi has to change the master the processor renders",
  );
  // Four bits and a −60 dBFS noise floor: every frame lands on the 1/8 grid,
  // give or take that noise.
  for (const at of [BLOCK, BLOCK + 1, 4 * BLOCK]) {
    const quantised = Math.round(heldMaster.left[at] * 8) / 8;
    assert.ok(
      Math.abs(heldMaster.left[at] - quantised) < 0.01,
      `frame ${at} has to be a 4-bit level, got ${heldMaster.left[at]}`,
    );
  }

  const released = await processorHost({ hold: [{ name: "lofi", amount: 1 }], release: ["lofi"] });
  const releasedMaster = released.run(8);
  assert.equal(
    firstDifferenceFrom(releasedMaster, dryMaster, RELEASE_FRAMES),
    -1,
    `the processor has to hand back the exact dry master from ${RELEASE_FRAMES} frames after the release`,
  );
});

test("the processor records a bar into the looper and answers looper_take", async () => {
  const host = await processorHost();
  // A recording starts on the next bar line — and the transport is parked on
  // bar 0's line, so it starts at once.
  host.post({ type: "looper", action: "record" });
  const firstBar = host.run(BAR_FRAMES / BLOCK);
  // Mid-bar: asked to play, the take closes on the bar line after it.
  host.post({ type: "looper", action: "play" });
  host.run(BLOCK);
  host.post({ type: "looper_take", id: 7 });

  const answer = host.posts.find((message) => message.type === "looper_buffer" && message.id === 7);
  assert.ok(answer, "a looper_take has to be answered with a looper_buffer");
  assert.equal(answer.bars, 1, "the take is exactly the one bar it recorded");
  assert.equal(answer.rate, SAMPLE_RATE, "the take names the context's rate");
  assert.equal(answer.channels.length, 2, "the take is stereo");
  assert.equal(answer.channels[0].length, BAR_FRAMES, "the take is one bar of frames");

  // What it recorded is the master as it was BEFORE the effects, i.e. this
  // song's own audio track, frame for frame.
  for (const at of [0, 1, BLOCK, BAR_FRAMES - 1]) {
    assert.equal(answer.channels[0][at], firstBar.left[at], `take frame ${at} has to be the master it recorded`);
    assert.equal(answer.channels[1][at], firstBar.right[at], `take frame ${at} has to be the master it recorded`);
  }
});