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
 * 64-frame crossfade, the reverb's tail, the stutter's beat grid, the tape
 * stop's one beat, and the looper's bar lines). A gesture inside a block is
 * applied by splitting the block at its frame, which is what the bus's `offset`
 * exists for.
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

// Both are classic scripts the worklet and Node load, so a test can require them
// directly: no engine, no worklet, no browser.
const perfFx = bundleRequire(join(ENGINE_DIR, "perf-fx.js"));
const StudioSequencer = bundleRequire(join(ENGINE_DIR, "sequencer.js"));

const RELEASE_FRAMES = perfFx.RELEASE_FRAMES;
const TAIL_FLOOR = perfFx.TAIL_FLOOR;
const TAIL_BLOCK_FRAMES = perfFx.TAIL_BLOCK_FRAMES;
const MAX_LOOP_BARS = perfFx.MAX_LOOP_BARS;

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
 * @param {number} bpm
 * @returns {number} how many frames one bar lasts at a tempo, as the bus reads it
 */
function barFramesAt(bpm) {
  return Math.round((SAMPLE_RATE * 60 * BEATS_PER_BAR) / bpm);
}

/**
 * A stereo test signal whose every frame is its own level, so a wrong frame
 * read is visible: two sines at different rates, under full scale.
 * @param {number} frames
 * @param {number} [silentFrom] the frame the signal stops dead at (the reverb's
 *   oracle: with no input a send that stays open decays exactly as a closed one)
 * @returns {{left: Float32Array, right: Float32Array}}
 */
function signalOf(frames, silentFrom) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const until = silentFrom === undefined ? frames : Math.min(frames, silentFrom);
  for (let at = 0; at < until; at += 1) {
    left[at] = Math.sin(at / 37) * 0.4;
    right[at] = Math.sin(at / 53 + 0.7) * 0.3;
  }
  return { left: left, right: right };
}

/**
 * The transport one run reads, on a grid whose bar lines sit where a sequencer's
 * would at this tempo: `barFrame` is the line the run's first frame is inside
 * (its own frame when it sits on one) and `nextBarFrame` the sequencer's next
 * line at or after it.
 * @param {number} frame the absolute frame the run's first sample sits on
 * @param {{bpm?: number, playing?: boolean, barFrame?: number|null,
 *          nextBarFrame?: number|null}} [overrides]
 * @returns {object}
 */
function transportAt(frame, overrides) {
  const options = overrides || {};
  const bpm = options.bpm === undefined ? BPM : options.bpm;
  const bar = barFramesAt(bpm);
  const barIndex = Math.floor(frame / bar);
  const onLine = frame === barIndex * bar;
  return {
    frame: frame,
    offset: 0,
    playing: true,
    bpm: bpm,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: barIndex * bar,
    nextBarFrame: onLine ? frame : (barIndex + 1) * bar,
    ...options,
  };
}

/**
 * Run the bus over a signal in 128-frame runs, exactly as the processor does:
 * `loop()` then `process()`, on a view of the run's own frames, with the
 * performance gestures applied at the frame they are scripted on (a block is
 * split at that frame, like the processor's own event runs).
 * @param {{left: Float32Array, right: Float32Array}} signal
 * @param {{hold?: object[], release?: object[], looper?: object[], stopAt?: number,
 *          bpm?: number, looperBuffers?: boolean}} [plan]
 *   `hold` is `{at, name, amount}` per hold, `release` `{at, name}` per release,
 *   `looper` `{at, action}` per command, `stopAt` the frame the transport stops
 *   at (`playing` goes false and the bar grid goes away), and `looperBuffers`
 *   hands the bus the buffers the page owns (needed by anything that records).
 * @returns {{left: Float32Array, right: Float32Array, bus: object}}
 */
function runBus(signal, plan) {
  const options = plan || {};
  const bpm = options.bpm === undefined ? BPM : options.bpm;
  const left = Float32Array.from(signal.left);
  const right = Float32Array.from(signal.right);
  const bus = perfFx.create(SAMPLE_RATE);
  if (options.looperBuffers === true) {
    const frames = MAX_LOOP_BARS * barFramesAt(bpm);
    bus.setLooperBuffers(new Float32Array(frames), new Float32Array(frames));
  }
  const events = [];
  for (const item of options.hold || []) {
    events.push({ at: item.at, apply: () => bus.hold(item.name, item.amount) });
  }
  for (const item of options.release || []) {
    events.push({ at: item.at, apply: () => bus.release(item.name) });
  }
  for (const item of options.looper || []) {
    events.push({ at: item.at, apply: () => bus.looper(item.action) });
  }
  events.sort((one, other) => one.at - other.at);
  const stopAt = options.stopAt === undefined ? null : options.stopAt;
  const total = left.length;
  let next = 0;
  for (let start = 0; start < total; start += BLOCK) {
    const count = Math.min(BLOCK, total - start);
    const transport =
      stopAt !== null && start >= stopAt
        ? transportAt(start, { bpm: bpm, playing: false, barFrame: null, nextBarFrame: null })
        : transportAt(start, { bpm: bpm });

    // The gestures that land inside this block, and the frames that split it.
    const inside = [];
    const cuts = [];
    while (next < events.length && events[next].at < start + count) {
      const item = events[next];
      next += 1;
      const offset = Math.max(0, Math.min(count, item.at - start));
      inside.push({ offset: offset, apply: item.apply });
      if (offset > 0 && cuts.indexOf(offset) === -1) cuts.push(offset);
    }
    cuts.sort((one, other) => one - other);
    const points = [0].concat(cuts, [count]);
    const viewLeft = left.subarray(start, start + count);
    const viewRight = right.subarray(start, start + count);
    for (let at = 0; at < points.length - 1; at += 1) {
      const from = points[at];
      const to = points[at + 1];
      for (const item of inside) {
        if (item.offset === from) item.apply();
      }
      const run = { ...transport, offset: from };
      bus.loop(viewLeft, viewRight, to - from, run);
      bus.process(viewLeft, viewRight, to - from, run);
    }
  }
  return { left: left, right: right, bus: bus };
}

/**
 * The first frame from `from` on where two renders differ, or -1.
 * @param {{left: Float32Array, right: Float32Array}} out
 * @param {{left: Float32Array, right: Float32Array}} other
 * @param {number} from
 * @returns {number}
 */
function firstDifferenceFrom(out, other, from) {
  for (let at = Math.max(0, from); at < other.left.length; at += 1) {
    if (out.left[at] !== other.left[at]) return at;
    if (out.right[at] !== other.right[at]) return at;
  }
  return -1;
}

/**
 * The last frame where a render leaves the dry signal, or -1.
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
 * The largest difference between a render and another in a window.
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

/** @returns {number} the largest step between two neighbouring samples of one channel. */
function largestStep(samples, from, to) {
  let step = 0;
  for (let at = Math.max(1, from); at < Math.min(samples.length, to); at += 1) {
    step = Math.max(step, Math.abs(samples[at] - samples[at - 1]));
  }
  return step;
}

// --- the tests ---------------------------------------------------------------

test("a short reverb throw keeps its tail", () => {
  // A 20 ms burst thrown into the reverb and let go 1,000 frames later: the send
  // closes long before the combs and allpasses have emptied, so the tail is
  // still in the delay lines when the return first falls quiet.
  //
  // The oracle is the same bus with the throw never released: with no input after
  // the burst a send that stays open feeds exactly the zeros a closed one does,
  // so its state decays frame for frame like the released one's — and it is never
  // cleared. The fixed bus may only differ from it once the tail really is below
  // −120 dBFS.
  const burst = 20; // milliseconds
  const burstFrames = Math.round((burst / 1000) * SAMPLE_RATE);
  const signal = { left: new Float32Array(3 * SAMPLE_RATE), right: new Float32Array(3 * SAMPLE_RATE) };
  for (let at = 2000; at < 2000 + burstFrames; at += 1) {
    signal.left[at] = Math.sin(at * 0.3) * 0.8;
    signal.right[at] = Math.sin(at * 0.31) * 0.7;
  }

  const released = runBus(signal, {
    hold: [{ at: 2000, name: "reverb_throw", amount: 1 }],
    release: [{ at: 3000, name: "reverb_throw" }],
  });
  const oracle = runBus(signal, { hold: [{ at: 2000, name: "reverb_throw", amount: 1 }] });

  assert.ok(peakOf(oracle.left, 0, 4000) > 0.01, "the throw has to be audible, or this test proves nothing");
  assert.ok(
    peakOf(oracle.left, 3000, 3000 + burstFrames) > 0.001,
    "the burst has to reach the return before the send closes",
  );

  const cleared = firstDifferenceFrom(released, oracle, 0);
  assert.ok(cleared > 3000, `the tail has to outlive the release before anything is cleared, first difference at ${cleared}`);
  assert.ok(
    cleared > 3000 + SAMPLE_RATE / 10,
    `a short throw's tail must not be cut a few frames after the send closes, first difference at ${cleared}`,
  );

  // The block before the clear was genuinely quiet, on the lines as well as on the
  // return: the clear is only judged there.
  const quiet = Math.max(
    peakOf(oracle.left, cleared - TAIL_BLOCK_FRAMES, cleared),
    peakOf(oracle.right, cleared - TAIL_BLOCK_FRAMES, cleared),
  );
  assert.ok(quiet < TAIL_FLOOR, `the tail may only be cleared below −120 dBFS, it was ${quiet}`);

  // From there on the difference is below −120 dBFS: nothing left to hear.
  const residual = Math.max(
    peakOf(released.left.map((value, at) => value - oracle.left[at]), cleared, released.left.length),
    peakOf(released.right.map((value, at) => value - oracle.right[at]), cleared, released.right.length),
  );
  assert.ok(residual < TAIL_FLOOR, `after the clear the difference has to be below −120 dBFS, it was ${residual}`);
});

test("re-holding the reverb in its tail does not cut it", () => {
  // A burst, a release, then the button again while the tail still rings: the send
  // reopens and the state carries on, so the render is the never-released oracle's
  // frame for frame until the tail has genuinely decayed. A re-hold that reset the
  // reverb would empty the lines and drop the return to nothing at the re-hold.
  const signal = { left: new Float32Array(3 * SAMPLE_RATE), right: new Float32Array(3 * SAMPLE_RATE) };
  for (let at = 2000; at < 2960; at += 1) {
    signal.left[at] = Math.sin(at * 0.3) * 0.8;
    signal.right[at] = Math.sin(at * 0.31) * 0.7;
  }
  // A second burst right after the re-hold, so a reopened send is audible and a
  // cleared one is not.
  for (let at = 5200; at < 5500; at += 1) {
    signal.left[at] = Math.sin(at * 0.17) * 0.6;
    signal.right[at] = Math.sin(at * 0.19) * 0.5;
  }

  const reheld = runBus(signal, {
    hold: [
      { at: 2000, name: "reverb_throw", amount: 1 },
      { at: 5200, name: "reverb_throw", amount: 1 },
    ],
    release: [
      { at: 3000, name: "reverb_throw" },
      { at: 6000, name: "reverb_throw" },
    ],
  });
  const oracle = runBus(signal, { hold: [{ at: 2000, name: "reverb_throw", amount: 1 }] });

  const cleared = firstDifferenceFrom(reheld, oracle, 0);
  assert.ok(cleared > 6000, `the tail has to survive the re-hold, first difference at ${cleared}`);
  const quiet = Math.max(
    peakOf(oracle.left, cleared - TAIL_BLOCK_FRAMES, cleared),
    peakOf(oracle.right, cleared - TAIL_BLOCK_FRAMES, cleared),
  );
  assert.ok(quiet < TAIL_FLOOR, `the re-held tail may only end below −120 dBFS, it was ${quiet}`);
});

test("re-holding a crossfading effect continues from its wet state", () => {
  // 1/8 at 120 bpm; the hold at 4,000 sits inside the division that begins at
  // 3,000, so the slice is [3,000, 6,000) and the repeat starts on that grid at
  // 6,000. The release at 7,000 starts the 64-frame crossfade; the re-hold 10
  // frames later picks the wet signal up where it is and ramps back up at the
  // same rate — it does not reset the effect and does not restart its capture.
  const signal = signalOf(BEAT_FRAMES + 8000);
  const plan = (releaseAt) => ({
    hold: [
      { at: 4000, name: "stutter", amount: 0.5 },
      ...(releaseAt === null ? [] : [{ at: releaseAt + 10, name: "stutter", amount: 0.5 }]),
    ],
    release: releaseAt === null ? [] : [{ at: releaseAt, name: "stutter" }],
  });
  const reheld = runBus(signal, plan(7000));
  const continuous = runBus(signal, plan(null));

  // The stutter is back at full wet ten frames after the re-hold (the crossfade
  // runs back up at the same rate it ran down), still repeating its own slice.
  for (const at of [7100, 7500, 8000, 8999]) {
    assert.equal(reheld.left[at], signal.left[at - 3000], `frame ${at} has to repeat the held slice, not restart`);
    assert.equal(reheld.right[at], signal.right[at - 3000], `frame ${at} has to repeat the held slice on the right`);
  }
  // The ramp back up runs ten frames (it had faded ten frames down), so from
  // 7021 on it is the never-released render, frame for frame: the re-hold
  // continued the effect rather than restarting it.
  assert.equal(
    firstDifferenceFrom(reheld, continuous, 7021),
    -1,
    "a re-hold has to carry the effect on from where it was, not start it again",
  );
  // No click: through the release and the re-hold the output never steps further
  // than the crossfade's own per-frame step on top of the signal's.
  const signalStep = largestStep(signal.left, 6900, 7100);
  const outStep = largestStep(reheld.left, 6900, 7100);
  assert.ok(
    outStep < signalStep * 3,
    `a re-hold must not click: largest step ${outStep} against the signal's own ${signalStep}`,
  );
});

test("releasing every effect returns the exact dry signal 64 frames after release (the reverb after its tail)", () => {
  // Five seconds of signal: long enough for the reverb's tail to fall the whole
  // 120 dB back into the dry signal, and short enough to stay quick.
  //
  // The reverb's clear is judged against an ORACLE: the same bus with the throw
  // never released, over a copy of the signal that stops dead at the release. With
  // no input after that frame a send that stays open feeds exactly the zeros a
  // closed one does, so the oracle's state decays frame for frame like the closed
  // send's — and it is never cleared. The fixed bus may only differ from it once
  // the tail really is below −120 dBFS.
  const releaseBase = BLOCK * 40;
  const signal = signalOf(5 * SAMPLE_RATE);
  const tailSignal = signalOf(5 * SAMPLE_RATE, releaseBase);
  const holdAt = BLOCK * 4;

  /** One render of one signal with some effects held and then released together. */
  const run = (names, releaseAt, source) => {
    const plan = { hold: [], release: [] };
    for (const name of names) {
      plan.hold.push({ at: holdAt, name: name, amount: AMOUNTS[name] });
      if (releaseAt !== null) plan.release.push({ at: releaseAt, name: name });
    }
    return runBus(source === undefined ? signal : source, plan);
  };

  // Released on a block's first frame, one frame in, and on its last frame: the
  // crossfade is counted in frames, so where the block boundary falls must not
  // matter at all.
  for (const releaseOffset of [0, 1, 127]) {
    const releaseAt = releaseBase + releaseOffset;

    for (const name of perfFx.CHAIN) {
      if (name === "reverb_throw") {
        // The send closes on release and the tail rings out; the oracle says when
        // that tail has genuinely gone.
        const out = run([name], releaseAt, tailSignal);
        const oracle = run([name], null, tailSignal);
        assert.ok(
          peakOf(oracle.left, 0, 4000) > 1e-6,
          "the throw has to be doing something, or this test proves nothing",
        );
        const cleared = firstDifferenceFrom(out, oracle, 0);
        assert.ok(
          cleared >= releaseAt,
          `the reverb's tail has to outlive the release, first difference at ${cleared}`,
        );
        assert.ok(
          cleared < tailSignal.left.length - SAMPLE_RATE,
          `the reverb's tail has to clear inside the render, first difference at ${cleared} of ${tailSignal.left.length}`,
        );
        const quiet = Math.max(
          peakOf(oracle.left, cleared - TAIL_BLOCK_FRAMES, cleared),
          peakOf(oracle.right, cleared - TAIL_BLOCK_FRAMES, cleared),
        );
        assert.ok(quiet < TAIL_FLOOR, `the reverb may only be cleared below −120 dBFS, it was ${quiet}`);
        const residual = Math.max(
          peakOf(out.left.map((value, at) => value - oracle.left[at]), cleared, out.left.length),
          peakOf(out.right.map((value, at) => value - oracle.right[at]), cleared, out.right.length),
        );
        assert.ok(residual < TAIL_FLOOR, `after the clear the reverb must be inaudible, it was ${residual}`);
        continue;
      }

      const out = run([name], releaseAt);

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
    const together = run(crossfading, releaseAt);
    assert.ok(peakDifference(together, signal, holdAt, releaseAt) > 1e-4, "the chain has to be audible while held");
    assert.equal(
      firstDifferenceFrom(together, signal, releaseAt + RELEASE_FRAMES),
      -1,
      `the whole chain has to leave the exact dry signal ${RELEASE_FRAMES} frames after the release`,
    );
    assert.equal(together.bus.activeCount(), 0, "every effect has to be dropped once its crossfade is over");

    // And all five together: everything but the reverb's tail is dry by 64 frames,
    // and the reverb's state is dropped once its own tail has gone.
    const all = run(perfFx.CHAIN, releaseAt);
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
  }
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
  // The held 1/8 keeps repeating after the transport stops: the effect runs on its
  // own captured frames, not on the playhead. The slice is the division the hold
  // sits inside — [0, 3000) here — so its repeats land on 0, 3000, 6000.
  for (const at of [stopAt, stopAt + 1, stopAt + 1000, BAR_FRAMES - 1]) {
    const wanted = signal.left[at % sliceFrames];
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
  // A hold part way through a division: 4,000 is inside the 1/8 that begins at
  // 3,000. The slice is that whole division, so the repeats start ON the 1/8 grid
  // (6,000, 9,000, …) — not at the hold frame plus a division.
  const signal = signalOf(BEAT_FRAMES + 8000);
  const holdAt = 4000;
  const division = BEAT_FRAMES / 8;
  const boundary = 3000;

  const out = runBus(signal, { hold: [{ at: holdAt, name: "stutter", amount: 0.5 }] });

  // The bus does not touch the master before the hold, and the part of the slice
  // that has already played is repeated out of its trailing ring: the live signal
  // passes through while the rest of the slice is captured.
  assert.equal(firstDifferenceFrom(out, signal, 0), boundary + division, "nothing is repeated before the grid line");
  for (let at = holdAt; at < boundary + division; at += 1) {
    assert.equal(out.left[at], signal.left[at], `frame ${at} is the slice being captured, which plays live`);
  }
  for (let at = boundary + division; at < out.left.length; at += 1) {
    const wanted = signal.left[boundary + ((at - boundary - division) % division)];
    assert.equal(out.left[at], wanted, `frame ${at} has to repeat the 1/8 that began at frame ${boundary}`);
    assert.equal(
      out.right[at],
      signal.right[boundary + ((at - boundary - division) % division)],
      `frame ${at} has to repeat the 1/8 on the right too`,
    );
  }
  // Each repeat begins exactly on a division line.
  for (const at of [boundary + division, boundary + 2 * division, boundary + 3 * division]) {
    assert.equal(out.left[at], signal.left[boundary], `the repeat at frame ${at} has to start on the 1/8 grid`);
  }

  // The division follows the amount: 0.9 is a 1/16, on the same grid.
  const fast = runBus(signal, { hold: [{ at: holdAt, name: "stutter", amount: 0.9 }] });
  const sixteenth = BEAT_FRAMES / 16;
  const fastBoundary = 3000;
  for (const at of [fastBoundary + sixteenth, fastBoundary + 2 * sixteenth, fastBoundary + 5 * sixteenth]) {
    assert.equal(
      fast.left[at],
      signal.left[fastBoundary],
      `the 1/16 repeat at frame ${at} has to start on its own division line`,
    );
  }
  for (const at of [fastBoundary + sixteenth + 10, fastBoundary + 2 * sixteenth + 10, fastBoundary + 5 * sixteenth + 10]) {
    assert.equal(
      fast.left[at],
      signal.left[fastBoundary + ((at - fastBoundary - sixteenth) % sixteenth)],
      `frame ${at} has to repeat a 1/16 when the amount is 0.9`,
    );
  }
});

test("tape stop reaches silence in one beat", () => {
  // Two tempos: at each the ramp is exactly one beat from the hold frame, and the
  // stop must still be sounding right up to the end of it — a ramp that goes
  // quiet early is a ramp that is not one beat long.
  for (const bpm of [120, 40]) {
    const beat = (SAMPLE_RATE * 60) / bpm;
    const holdAt = BLOCK * 8;
    const signal = signalOf(Math.ceil(holdAt + beat + 20000));

    const out = runBus(signal, { bpm: bpm, hold: [{ at: holdAt, name: "tape_stop", amount: 1 }] });

    // The read head starts at the write head: the frame it is held on is played as
    // it is (speed 1), and the stop drifts behind it from there.
    assert.ok(
      Math.abs(out.left[holdAt] - signal.left[holdAt]) < 1e-12,
      `at ${bpm} bpm the tape stop's own frame has to be the live frame, got ${out.left[holdAt]} for ${signal.left[holdAt]}`,
    );
    assert.ok(
      peakOf(out.left, holdAt, holdAt + beat) > 0.01,
      `the tape stop at ${bpm} bpm has to keep sounding through its beat`,
    );
    // Not silent before the beat ends: the head is still moving, almost still.
    assert.ok(
      peakOf(out.left, holdAt + beat - 1000, holdAt + beat) > 1e-4,
      `the tape stop at ${bpm} bpm must not fall silent before its beat is over`,
    );

    // One beat after the hold, the speed has reached 0 and there is nothing left.
    for (const at of [holdAt + beat, holdAt + beat + 1, holdAt + beat + 5000, out.left.length - 1]) {
      assert.equal(out.left[at], 0, `at ${bpm} bpm, frame ${at} is past the tape stop's one beat and has to be silent`);
      assert.equal(out.right[at], 0, `at ${bpm} bpm, frame ${at} has to be silent on the right too`);
    }
  }

  // A release hands the master back: the effect fades out over 64 frames and is
  // then gone, whatever it was doing.
  const signal = signalOf(BEAT_FRAMES + 20000);
  const holdAt = BLOCK * 8;
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
    looperBuffers: true,
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

  // The buffer holds whole bars of the master it recorded, and is the page's: the
  // looper hands it over, the page copies it, and the same pair comes back.
  const take = out.bus.takeLooperBuffers();
  assert.ok(take, "a looper with buffers has a take to hand over");
  assert.equal(take.rate, SAMPLE_RATE, "the take names the engine's rate");
  assert.equal(take.bars, 1, "one bar was recorded");
  assert.equal(take.frames, BAR_FRAMES, "the take is exactly one bar long");
  assert.equal(take.left[0], signal.left[0], "the take starts where the bar did");
  assert.equal(take.left[BAR_FRAMES - 1], signal.left[BAR_FRAMES - 1], "and ends where it did");
  // While the buffers are away the looper has no take to give, and contributes
  // silence; handing them back resumes it from where it was.
  assert.equal(out.bus.takeLooperBuffers(), null, "buffers that are already out cannot be handed out twice");
  out.bus.setLooperBuffers(take.left, take.right);

  // `stop` leaves the take alone, `clear` empties it at once.
  out.bus.looper("stop");
  const stopped = out.bus.takeLooperBuffers();
  assert.equal(stopped.bars, 1, "stopping the looper keeps the take");
  out.bus.setLooperBuffers(stopped.left, stopped.right);
  out.bus.looper("clear");
  const cleared = out.bus.takeLooperBuffers();
  assert.equal(cleared.bars, 0, "clearing the looper empties it");
  assert.equal(cleared.frames, 0, "a cleared take has nothing to read");
});

test("with the transport stopped the looper acts at once", () => {
  // A stopped transport reports no bar line at all. Reading `Number(null)` as 0
  // would quantize the command to a bar line 96,000 frames away; the command has
  // to act on its own block instead.
  const bus = perfFx.create(SAMPLE_RATE);
  const frames = MAX_LOOP_BARS * BAR_FRAMES;
  bus.setLooperBuffers(new Float32Array(frames), new Float32Array(frames));
  const stopped = (frame) => ({
    frame: frame,
    offset: 0,
    playing: false,
    bpm: BPM,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: null,
    nextBarFrame: null,
  });
  /** @returns {Float32Array} one block of a level, through the looper. */
  const block = (frame, level) => {
    const left = new Float32Array(BLOCK).fill(level);
    bus.loop(left, null, BLOCK, stopped(frame));
    return left;
  };

  bus.looper("record");
  block(0, 0.25);
  bus.looper("play");
  const played = block(BLOCK, 0.5);
  for (const at of [0, 1, BLOCK - 1]) {
    assert.equal(
      played[at],
      Math.fround(0.5 + 0.25),
      `frame ${at} has to play the take on the very block the command landed in`,
    );
  }

  const take = bus.takeLooperBuffers();
  assert.ok(take, "the recording captured the command's own block");
  assert.equal(take.bars, 1, "a stopped transport still takes whole bars");
  assert.equal(take.frames, BAR_FRAMES, "the take is one whole bar, padded with silence");
  assert.equal(take.left[0], 0.25, "the take holds the block the record landed in");
  assert.equal(take.left[BLOCK], 0, "and silence after it");

  // A transport that leaves the bar fields out altogether reads the same way: no
  // bar line means no grid, not bar 0.
  const bare = perfFx.create(SAMPLE_RATE);
  bare.setLooperBuffers(new Float32Array(frames), new Float32Array(frames));
  bare.looper("record");
  const recorded = new Float32Array(BLOCK).fill(0.4);
  bare.loop(recorded, null, BLOCK, { frame: 0, offset: 0, playing: true, bpm: BPM, beatsPerBar: BEATS_PER_BAR });
  bare.looper("play");
  const replayed = new Float32Array(BLOCK);
  bare.loop(replayed, null, BLOCK, { frame: BLOCK, offset: 0, playing: true, bpm: BPM, beatsPerBar: BEATS_PER_BAR });
  assert.equal(replayed[0], Math.fround(0.4), "a missing bar line acts at once too, on the command's block");
});

test("a recording ends at the last whole bar the buffers hold", () => {
  // The buffers are the page's, and they decide how long a take can be: one and a
  // half bars fit one whole bar, so the recording closes itself there instead of
  // running past the end of the buffer.
  const bus = perfFx.create(SAMPLE_RATE);
  const frames = BAR_FRAMES + BAR_FRAMES / 2;
  bus.setLooperBuffers(new Float32Array(frames), new Float32Array(frames));
  bus.looper("record");
  const left = new Float32Array(2 * BAR_FRAMES);
  for (let at = 0; at < left.length; at += 1) left[at] = Math.sin(at / 37) * 0.4;
  bus.loop(left, null, left.length, transportAt(0));

  const take = bus.takeLooperBuffers();
  assert.ok(take, "the recording has a take");
  assert.equal(take.bars, 1, "one whole bar fits, so the take is one bar");
  assert.equal(take.frames, BAR_FRAMES);
  assert.equal(take.left[BAR_FRAMES - 1], left[BAR_FRAMES - 1], "the take is the master it recorded");
});

test("stop during a recording keeps its whole bars", () => {
  const signal = signalOf(4 * BAR_FRAMES);
  const out = runBus(signal, {
    looperBuffers: true,
    looper: [
      { at: 0, action: "record" },
      // Mid-way through the third bar: the stop lands on the bar line after it, so
      // the take is the three whole bars that were recorded up to there.
      { at: 2 * BAR_FRAMES + 5000, action: "stop" },
    ],
  });
  const take = out.bus.takeLooperBuffers();
  assert.ok(take, "a stopped recording has to keep what it captured");
  assert.equal(take.bars, 3, "the whole bars recorded up to the bar line the stop landed on");
  assert.equal(take.frames, 3 * BAR_FRAMES);
  for (const at of [0, 1, BAR_FRAMES, 3 * BAR_FRAMES - 1]) {
    assert.equal(take.left[at], signal.left[at], `take frame ${at} has to be the master it recorded`);
  }
  out.bus.setLooperBuffers(take.left, take.right);

  // Play resumes from it: asked on a bar line, the take loops into the master from
  // its own top.
  out.bus.looper("play");
  const silent = new Float32Array(BLOCK);
  out.bus.loop(silent, null, BLOCK, {
    frame: 4 * BAR_FRAMES,
    offset: 0,
    playing: true,
    bpm: BPM,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: 4 * BAR_FRAMES,
    nextBarFrame: 4 * BAR_FRAMES,
  });
  assert.equal(silent[0], signal.left[0], "a play after the stop resumes from the take's first frame");
  assert.equal(silent[10], signal.left[10], "and runs on through it");

  // A recording that never finished a whole bar is discarded instead.
  const short = perfFx.create(SAMPLE_RATE);
  short.setLooperBuffers(new Float32Array(MAX_LOOP_BARS * BAR_FRAMES), new Float32Array(MAX_LOOP_BARS * BAR_FRAMES));
  const stopped = (frame) => ({
    frame: frame,
    offset: 0,
    playing: false,
    bpm: BPM,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: null,
    nextBarFrame: null,
  });
  const left = new Float32Array(BLOCK).fill(0.3);
  short.looper("record");
  short.loop(left, null, BLOCK, stopped(0));
  short.looper("stop");
  short.loop(new Float32Array(BLOCK), null, BLOCK, stopped(BLOCK));
  const discarded = short.takeLooperBuffers();
  assert.ok(discarded, "the buffers are still the page's");
  assert.equal(discarded.bars, 0, "a recording with no whole bar is discarded");
  assert.equal(discarded.frames, 0);
});

test("a looper command after a tempo change lands on the sequencer's bar line", () => {
  // The real sequencer, played at 120 bpm and retuned to 97 bpm part way through a
  // beat: it rebases beat 0, so the playhead's bar line and the next one are no
  // longer `barFrame + barFrames` at the new tempo. The looper takes the line the
  // sequencer reports, so a command never starts a frame early or a bar late.
  const seq = StudioSequencer.create({ sampleRate: SAMPLE_RATE });
  const snapshot = (bpm) => ({
    meta: { title: "Tempo", bpm: bpm, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Lead",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {},
  });
  seq.setSong(snapshot(BPM));
  seq.play();
  seq.block(0, 12806);
  seq.setSong(snapshot(97));

  const bpm = 97;
  const barFrames = barFramesAt(bpm);
  const total = 400000;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let at = 0; at < total; at += 1) {
    left[at] = at / 1e6;
    right[at] = -at / 1e6;
  }

  const bus = perfFx.create(SAMPLE_RATE);
  const buffers = MAX_LOOP_BARS * barFrames;
  bus.setLooperBuffers(new Float32Array(buffers), new Float32Array(buffers));
  const lines = { barFrame: null, nextBarFrame: null, bar: null };

  let frame = 12806;
  seq.barLines(lines);
  const wantedLine = lines.nextBarFrame;
  assert.ok(Number.isFinite(wantedLine), "the sequencer has to have a bar line while it plays");
  assert.notEqual(
    lines.barFrame + barFrames,
    wantedLine,
    "this tempo change has to put the two lines apart, or this test proves nothing",
  );

  bus.looper("record");
  const transport = {
    frame: frame,
    offset: 0,
    playing: true,
    bpm: bpm,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: lines.barFrame,
    nextBarFrame: wantedLine,
  };
  const end = wantedLine + barFrames;
  while (frame < end) {
    // Read the lines exactly where the processor does: before the sequencer moves
    // its clock to the end of the block.
    seq.barLines(lines);
    transport.frame = frame;
    transport.barFrame = lines.barFrame;
    transport.nextBarFrame = lines.nextBarFrame;
    const viewLeft = left.subarray(frame, frame + BLOCK);
    const viewRight = right.subarray(frame, frame + BLOCK);
    bus.loop(viewLeft, viewRight, BLOCK, transport);
    bus.process(viewLeft, viewRight, BLOCK, transport);
    seq.block(frame, BLOCK);
    frame += BLOCK;
  }

  const take = bus.takeLooperBuffers();
  assert.ok(take, "the recording has a take to read");
  assert.equal(take.bars, 1, "one whole bar of the new tempo");
  assert.equal(take.frames, barFrames, "the take is one bar long at the tempo the recording started on");
  assert.equal(take.left[0], left[wantedLine], `the recording has to start on the sequencer's bar line ${wantedLine}`);
  assert.notEqual(take.left[0], left[lines.barFrame + barFrames], "and not a frame off it");
});

test("looperTake returns the recorded bars", async (t) => {
  // Two whole bars captured by the bus, read the way the page reads them: the
  // buffers are handed over, the page copies the loop's frames, and the same pair
  // goes back to the looper.
  const signal = signalOf(3 * BAR_FRAMES);
  const out = runBus(signal, {
    looperBuffers: true,
    looper: [
      { at: 0, action: "record" },
      // A block after the first bar line, so the take closes on the second one.
      { at: BAR_FRAMES + BLOCK, action: "play" },
    ],
  });
  const take = out.bus.takeLooperBuffers();
  assert.equal(take.bars, 2, "the take is two bars");
  assert.equal(take.frames, 2 * BAR_FRAMES, "two bars of frames");
  assert.equal(take.left[2 * BAR_FRAMES - 1], signal.left[2 * BAR_FRAMES - 1], "the take holds the master");

  // Mid-recording, the take answers the whole bars it has so far.
  const recording = runBus(signalOf(BAR_FRAMES + 1000), {
    looperBuffers: true,
    looper: [{ at: 0, action: "record" }],
  });
  const partial = recording.bus.takeLooperBuffers();
  assert.equal(partial.bars, 1, "a recording in its second bar has one whole bar to hand over");
  assert.equal(partial.frames, BAR_FRAMES, "and hands over exactly that");

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

test("a take is clipped to full scale", () => {
  // The looper taps the master BEFORE the clip, so a take can hold values past
  // full scale; the page's copy is clipped, and the loop it hands back is not
  // otherwise touched.
  const signal = signalOf(BAR_FRAMES + 1000);
  for (let at = 0; at < signal.left.length; at += 1) signal.left[at] *= 4;
  for (let at = 0; at < signal.right.length; at += 1) signal.right[at] *= 4;

  const out = runBus(signal, {
    looperBuffers: true,
    looper: [{ at: 0, action: "record" }],
  });
  const take = out.bus.takeLooperBuffers();
  assert.equal(take.bars, 1, "one bar recorded");
  assert.ok(peakOf(take.left, 0, take.frames) > 1, "the loop really does hold values past full scale");

  const copy = engineClientApi().copyLooperChannel(take.left, take.frames);
  assert.equal(copy.length, take.frames, "the copy is the loop's own length");
  let clipped = 0;
  for (let at = 0; at < copy.length; at += 1) {
    const value = copy[at];
    assert.ok(value >= -1 && value <= 1, `copy frame ${at} has to be within [−1, 1], it was ${value}`);
    if (value === 1 || value === -1) clipped += 1;
    const raw = take.left[at];
    if (raw > 1) assert.equal(value, 1, `copy frame ${at} has to be clipped to 1`);
    else if (raw < -1) assert.equal(value, -1, `copy frame ${at} has to be clipped to −1`);
    else assert.equal(value, raw, `copy frame ${at} has to be the loop's own sample`);
  }
  assert.ok(clipped > 0, "the copy has to have clipped something, or this test proves nothing");
});

test("overdub adds the live master to the take", () => {
  const signal = signalOf(3 * BAR_FRAMES);
  const firstAt = BAR_FRAMES + 1000;
  const secondAt = 2 * BAR_FRAMES + 1000;
  const out = runBus(signal, {
    looperBuffers: true,
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
    return { left: left, right: right, taps: taps };
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
  // The looper's buffers are the page's; a real client sizes them from the song's
  // tempo, and nothing here allocates them in the processor.
  const looperFrames = MAX_LOOP_BARS * BAR_FRAMES;
  post({ type: "looper_buffers", left: new Float32Array(looperFrames), right: new Float32Array(looperFrames) });
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
  assert.equal(answer.frames, BAR_FRAMES, "the take is one bar of frames");
  assert.ok(answer.left instanceof Float32Array, "the take hands the looper's own buffers over");
  assert.ok(answer.right instanceof Float32Array, "and the other channel with them");
  assert.equal(answer.left.length, MAX_LOOP_BARS * BAR_FRAMES, "the buffers are the page's, whole");

  // What it recorded is the master as it was BEFORE the effects, i.e. this
  // song's own audio track, frame for frame.
  for (const at of [0, 1, BLOCK, BAR_FRAMES - 1]) {
    assert.equal(answer.left[at], firstBar.left[at], `take frame ${at} has to be the master it recorded`);
    assert.equal(answer.right[at], firstBar.right[at], `take frame ${at} has to be the master it recorded`);
  }
});