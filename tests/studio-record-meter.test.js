/**
 * Studio's input meter on a real audio context — the level and the waveform
 * columns the recording lane draws, posted from the worklet.
 *
 * The reading itself (`input-level.js`) is pinned in `studio-input-level.test.js`;
 * what these tests measure is the worklet and the engine hook around it, on
 * `node-web-audio-api`'s OfflineAudioContext with the real
 * `bundles/studio/engine/engine-client.js` and the real worklet files, so this is
 * the code the browser and the renderer run.
 *
 * The input is an `AudioBufferSourceNode` (a signal source, which a test may use;
 * no Studio code does), and `sampleOf(frame)` is the sample that frame carries —
 * which is how a column's frame can be read back out of its own value.
 *
 * Nothing here touches `~/.crow`; every temp file is in a fresh `mkdtemp`
 * directory, made by engine-client.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../bundles/studio/server/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own dependency, resolved from inside the bundle (that is where
// package.json declares it).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));

// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
};

const SAMPLE_RATE = 48000;

/** One column of the meter is ten milliseconds: the grid every reading uses. */
const COLUMN_FRAMES = 480;

/** One post covers a thirtieth of a second, never one render block. */
const POST_FRAMES = 1600;

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for something a worklet posts from another thread to arrive.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether it happened in time
 */
async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await delay(5);
  return predicate();
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(context) {
  try {
    // The worklet thread exits when rendering does; a second release would wait
    // for an exit that already happened, so the timer is the safety net.
    await Promise.race([
      context.audioWorklet[kWorkletRelease](),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  } catch {
    /* nothing to release */
  }
}

/**
 * One offline context with the engine on it, released on the way out.
 * @param {number} length frames
 * @returns {{context: BaseAudioContext, engine: object}}
 */
async function openEngine(length) {
  const context = new OfflineAudioContext({ numberOfChannels: 1, length: length, sampleRate: SAMPLE_RATE });
  const engine = await studioEngine.create(context, { assetBytes: ASSETS });
  return { context: context, engine: engine };
}

/**
 * Render an input through the meter and hand back every payload it posted.
 *
 * `early` runs first of all, synchronously, with the bare context right after it
 * is made: that is where a test registers its `suspend()` times, because a
 * suspend has to be recorded before the render can start. `during` runs once the
 * engine is up and before rendering starts (that is where a test turns the meter
 * on), and `between` gets the context once rendering has begun, so a suspend that
 * has landed is where a test changes the meter while audio is being rendered.
 *
 * @param {{frames: number, sampleOf: (frame: number) => number,
 *          early?: (context: object) => void,
 *          during?: (held: object) => Promise<void>|void,
 *          between?: (held: object) => Promise<void>|void}} options
 * @returns {Promise<{levels: object[], meter: object, context: object}>}
 */
async function renderInput(options) {
  const context = new OfflineAudioContext({
    numberOfChannels: 1,
    length: options.frames,
    sampleRate: SAMPLE_RATE,
  });
  if (options.early) options.early(context);
  const engine = await studioEngine.create(context, { assetBytes: ASSETS });
  let meter = null;
  let rendered = false;
  try {
    const samples = new Float32Array(options.frames);
    for (let frame = 0; frame < options.frames; frame += 1) samples[frame] = options.sampleOf(frame);
    const buffer = context.createBuffer(1, options.frames, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;

    meter = await engine.createInputMeter({ input: source, channels: 1 });
    const levels = [];
    meter.onLevel((level) => levels.push(level));

    source.start(0);
    const held = { context: context, meter: meter, levels: levels };
    if (options.during) await options.during(held);

    const rendering = context.startRendering();
    // `between` can throw, and then nothing below awaits the render.
    rendering.catch(() => {});
    if (options.between) await options.between(held);
    let timer = null;
    const tooSlow = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("the offline render did not finish in 20 s")), 20000);
    });
    try {
      await Promise.race([rendering, tooSlow]);
    } finally {
      clearTimeout(timer);
    }
    rendered = true;
    // The posts are port messages from another thread: the last one may still be
    // in flight when the render resolves.
    await waitFor(() => false, 200);
    return { levels: levels, meter: meter, context: context };
  } finally {
    if (meter) meter.dispose();
    engine.dispose();
    // A render that never got going leaves the worklet thread running.
    if (!rendered) await releaseWorklet(context);
  }
}

/** @param {number} frame @returns {number} a 440 Hz sine at half scale */
function sine440(frame) {
  return 0.5 * Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE);
}

/** @param {number} frame @returns {number} a rising ramp the frame can be read back from */
function frameRamp(frame) {
  return (frame + 1) / 100000;
}

test("a 440 Hz sine at 0.5 posts peak 0.5 within 0.02 and rms near 0.354", async () => {
  const { levels } = await renderInput({
    frames: Math.round(1.5 * SAMPLE_RATE),
    sampleOf: sine440,
    during: ({ meter }) => meter.setActive(true),
  });

  assert.ok(levels.length > 0, "the meter posted while the lane was shown");
  const loud = levels.filter((level) => level.peak > 0.4);
  assert.ok(loud.length > 0, "some window covers the sine");
  for (const level of loud) {
    assert.ok(
      Math.abs(level.peak - 0.5) <= 0.02,
      `peak should be 0.5, was ${level.peak} at frame ${level.frame}`,
    );
    assert.ok(
      Math.abs(level.rms - 0.5 / Math.SQRT2) <= 0.02,
      `rms should be about 0.354, was ${level.rms} at frame ${level.frame}`,
    );
    assert.equal(level.clipped, false, "half scale never latches CLIP");
  }
});

test("posts arrive about thirty times a second of audio, not once a block", async () => {
  const seconds = 2;
  const { levels } = await renderInput({
    frames: seconds * SAMPLE_RATE,
    sampleOf: sine440,
    during: ({ meter }) => meter.setActive(true),
  });

  const perBlock = (seconds * SAMPLE_RATE) / 128;
  assert.ok(perBlock > 700, "a per-block meter would post hundreds of times a second");
  assert.ok(
    levels.length >= 30 * seconds * 0.8 && levels.length <= 30 * seconds * 1.2,
    `expected about ${30 * seconds} posts in ${seconds} s, got ${levels.length}`,
  );
});

test("every column's frame is the context frame of its first sample", async () => {
  const { levels } = await renderInput({
    frames: SAMPLE_RATE,
    sampleOf: frameRamp,
    during: ({ meter }) => meter.setActive(true),
  });

  assert.ok(levels.length > 0, "the meter posted");
  let previousLevel = null;
  let previousFrame = null;
  for (const level of levels) {
    // A window closes on the block that reaches it, so a post is stamped with a
    // render block's first frame and its columns are the ones that closed by then.
    assert.equal(level.frame % 128, 0, `a post starts on a render block, got ${level.frame}`);
    if (previousLevel !== null) assert.ok(level.frame > previousLevel.frame, "posts come in order");
    previousLevel = level;
    for (let at = 0; at + 2 < level.cols.length; at += 3) {
      const frame = level.cols[at];
      const min = level.cols[at + 1];
      // The ramp rises, so a column's minimum IS its first sample: reading the
      // value back names the frame that sample was rendered at.
      assert.equal(
        Math.round(min * 100000) - 1,
        frame,
        `column ${at / 3} of the post at ${level.frame} names frame ${frame}`,
      );
      if (previousFrame !== null) assert.equal(frame, previousFrame + COLUMN_FRAMES, "columns follow each other");
      previousFrame = frame;
    }
  }
  assert.equal(levels[0].frame, 0, "the first window opens on the input's first frame");
  assert.equal(levels[0].cols[0], 0, "and its first column starts there too");
});

test("dispose takes the meter out of the graph and no post arrives after it", async () => {
  const { levels } = await renderInput({
    frames: Math.round(0.5 * SAMPLE_RATE),
    sampleOf: sine440,
    during: ({ meter }) => {
      meter.setActive(true);
      meter.dispose();
    },
  });

  assert.deepEqual(levels, [], "a disposed meter is not pulled, so it never measures");
});

test("setActive false stops the posts and setActive true resumes them", { timeout: 60000 }, async () => {
  // Suspends land on whole render blocks: 188 * 128 and 750 * 128.
  const offAt = 188 * 128;
  const onAt = 750 * 128;
  const frames = Math.round(3 * SAMPLE_RATE);

  let off;
  let on;
  const { levels } = await renderInput({
    frames: frames,
    sampleOf: sine440,
    // Registered first, long before startRendering(): the suspend is recorded
    // asynchronously, and one made right before the render starts is sometimes
    // refused with InvalidStateError.
    early: (context) => {
      off = context.suspend(offAt / SAMPLE_RATE);
      on = context.suspend(onAt / SAMPLE_RATE);
    },
    during: ({ meter }) => meter.setActive(true),
    between: async ({ context, meter }) => {
      await off;
      meter.setActive(false);
      await context.resume();
      await on;
      meter.setActive(true);
      await context.resume();
    },
  });

  assert.ok(levels.length > 0, "the meter posted at all");
  // A window that was already open when `off` arrived may still land, and one
  // that starts just after `on` may be short; the frames in between are the
  // silence the lane was hidden for.
  const between = levels.filter((level) => level.frame >= offAt + 4 * POST_FRAMES && level.frame < onAt);
  assert.deepEqual(
    between.map((level) => level.frame),
    [],
    "no post comes from the stretch the meter was off",
  );
  assert.ok(
    levels.some((level) => level.frame >= onAt),
    "and turning it on again starts them",
  );
});

test("clearClip names its sequence, and every reading after it carries it", { timeout: 60000 }, async () => {
  // Suspends land on whole render blocks, as they do above.
  const firstClearAt = 375 * 128;
  const secondClearAt = 750 * 128;
  const frames = Math.round(3 * SAMPLE_RATE);

  let first;
  let second;
  const { levels } = await renderInput({
    frames: frames,
    // Full scale for the first two windows, which latches CLIP once; the rest of
    // the render is far too quiet to latch it again.
    sampleOf: (frame) => (frame < 2 * POST_FRAMES ? 1 : 0.25),
    // Registered first, long before startRendering(): the suspend is recorded
    // asynchronously, and one made right before the render starts is sometimes
    // refused with InvalidStateError.
    early: (context) => {
      first = context.suspend(firstClearAt / SAMPLE_RATE);
      second = context.suspend(secondClearAt / SAMPLE_RATE);
    },
    during: ({ meter }) => meter.setActive(true),
    between: async ({ context, meter }) => {
      await first;
      meter.clearClip(3);
      await context.resume();
      await second;
      meter.clearClip();
      await context.resume();
    },
  });

  // Read the posts in the order they arrived, not against the suspend times.
  // Under load the worklet runs behind the render thread, so the suspend can
  // resolve and the clear can be sent while the worklet is still a few blocks
  // before that frame: a post stamped below a suspend time may already carry
  // the sequence that clear named. The order of the posts is what holds.
  const seqs = levels.map((level) => level.clearSeq);
  for (const seq of seqs) {
    assert.equal(typeof seq, "number", "the sequence is a plain number on the level");
    assert.ok(seq === 0 || seq === 3, `a post carries 0 or the named 3, got ${seq}`);
  }

  // Zeros, then threes, then zeros: never back and forth.
  assert.match(
    seqs.map((seq) => (seq === 0 ? "0" : "3")).join(""),
    /^0*3+0*$/,
    "a post carries the sequence the last clear named: none, then 3, then none again, never back and forth",
  );
  assert.ok(seqs.includes(3), "a clear that names a sequence reaches the posts after it");
  assert.equal(seqs[seqs.length - 1], 0, "and after a clear that names no sequence it is 0");

  // Half a second of margin at the start, well before any clear is sent.
  const start = levels.filter((level) => level.frame < firstClearAt / 2);
  assert.ok(start.length > 0, "the meter posted from the full-scale start");
  assert.deepEqual(start.map((level) => level.clearSeq), start.map(() => 0), "no clear had been named yet");
  assert.ok(start.some((level) => level.clipped), "the full-scale start latched CLIP");

  assert.ok(
    levels.some((level) => level.frame > firstClearAt + 8 * POST_FRAMES),
    "the meter keeps posting after the clear",
  );
});

test("createInputMeter with no input is refused the way createRecorder is", async () => {
  const { context, engine } = await openEngine(128);
  try {
    const meterRefusal = engine.createInputMeter({});
    const recorderRefusal = engine.createRecorder({});
    await assert.rejects(meterRefusal, {
      message: "StudioEngine: createInputMeter needs an input (a MediaStream or an AudioNode)",
    });
    await assert.rejects(recorderRefusal, {
      message: "StudioEngine: createRecorder needs an input (a MediaStream or an AudioNode)",
    });
  } finally {
    engine.dispose();
    await releaseWorklet(context);
  }
});

test("WORKLET_FILES loads the level core before the meter, and the asset route serves both", () => {
  const files = studioEngine.WORKLET_FILES;
  const level = files.indexOf("input-level.js");
  const meter = files.indexOf("input-meter-processor.js");
  assert.ok(level >= 0, "input-level.js is a worklet file");
  assert.ok(meter >= 0, "input-meter-processor.js is a worklet file");
  assert.ok(level < meter, "the core's file has to be added before the meter that reads it");

  // The browser fetches each worklet by name from the asset route, which answers
  // only for the files in its own map.
  const web = readFileSync(join(SERVER_DIR, "web.js"), "utf8");
  const start = web.indexOf("const ASSET_FILES = new Map([");
  assert.ok(start >= 0, "web.js has the asset map");
  const assets = web.slice(start, web.indexOf("]);", start));
  for (const name of ["input-level.js", "input-meter-processor.js"]) {
    assert.ok(assets.includes(`["${name}", join("engine", "${name}")]`), `the asset route serves ${name}`);
  }
});