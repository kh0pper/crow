/**
 * Studio calibration emitter worklet — the click end of a loopback measurement.
 *
 * `engine-client.js` loads this file with its own `audioWorklet.addModule()`
 * (`engine/calibrate-emitter.js`), separate from the engine module, so a
 * calibration runs on the same AudioContext as the engine without being part of
 * it. Like every worklet here it is a classic script: no imports, no exports,
 * one `registerProcessor()` call at the end.
 *
 * ## What it plays
 *
 * One short click every `interval_frames` (500 ms by default): 48 samples of a
 * 1 kHz sine under a Hann window, peak −6 dBFS (0.5012), identical on both
 * output channels. The detector (`calibrate-detector.js`) rebuilds the very
 * same template from the same arithmetic — the constants and the formula live
 * in both files on purpose, so nothing has to be handed over the port.
 *
 * The first click lands on frame `first_frame` (default: one whole interval in),
 * so the loopback chain is running before it sounds. After `clicks` clicks (16
 * by default) the emitter is silence; it keeps writing zeros.
 *
 * ## Frames
 *
 * Each click is reported once as `{type:"click", frame}` in the CONTEXT's
 * frames: the AudioWorkletGlobalScope's shared `currentFrame` plus the offset
 * measured at the first block (the same rule `studio-processor.js` documents —
 * on a Node host that global stays 0, so the clock is counted from the first
 * block). The main thread forwards each frame to the detector as
 * `{type:"expect", frame}`, which is what makes the lag a measurement of the
 * round trip rather than of anything inside one processor.
 *
 * `process()` never throws: a fault is reported once and the block is silence,
 * because a throw out of an AudioWorkletProcessor takes the host's audio thread
 * down.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-calibrate-emitter";

  /** The click's length: one period of 1 kHz at a 48 kHz rate. */
  const CLICK_SAMPLES = 48;

  /** The click's pitch, in Hz. */
  const CLICK_HZ = 1000;

  /** The click's amplitude: −6 dBFS. */
  const CLICK_PEAK = 0.5012;

  /** The gap between clicks when the caller names none, in seconds. */
  const DEFAULT_INTERVAL_SECONDS = 0.5;

  /** How many clicks the emitter plays when the caller names none. */
  const DEFAULT_CLICKS = 16;

  /**
   * @param {unknown} value a caller's number
   * @param {number} fallback the value to use when it is not a number
   * @param {number} minimum the smallest value allowed
   * @returns {number} a whole number, at least `minimum`
   */
  function wholeAtLeast(value, fallback, minimum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const whole = Math.round(number);
    return whole < minimum ? minimum : whole;
  }

  /**
   * The AudioWorkletGlobalScope's `currentFrame`, or null in a host without it.
   * `typeof` on an undeclared identifier is safe and is the only way to ask for
   * a worklet global without assuming the host provides one.
   * @returns {number|null}
   */
  function contextFrameNow() {
    if (typeof currentFrame === "undefined") return null;
    return typeof currentFrame === "number" && Number.isFinite(currentFrame) ? currentFrame : null;
  }

  /**
   * The click, sample by sample: a 1 kHz sine under a 48-sample Hann window,
   * scaled to the click's peak. The detector builds the same array.
   * @param {number} rate the context's sample rate, in Hz
   * @returns {Float32Array} `CLICK_SAMPLES` samples
   */
  function clickTemplate(rate) {
    const samples = new Float32Array(CLICK_SAMPLES);
    for (let index = 0; index < CLICK_SAMPLES; index += 1) {
      const sine = Math.sin((2 * Math.PI * CLICK_HZ * index) / rate);
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (CLICK_SAMPLES - 1));
      samples[index] = sine * hann * CLICK_PEAK;
    }
    return samples;
  }

  /** One AudioWorkletProcessor that clicks a loopback cable. */
  class CalibrateEmitterProcessor extends AudioWorkletProcessor {
    /**
     * @param {{processorOptions?: {interval_frames?: number, first_frame?: number,
     *          clicks?: number}}} options
     */
    constructor(options) {
      super();
      const processorOptions = (options && options.processorOptions) || {};

      /** Frames between two click starts. */
      this.interval = wholeAtLeast(
        processorOptions.interval_frames,
        Math.round(sampleRate * DEFAULT_INTERVAL_SECONDS),
        CLICK_SAMPLES,
      );

      /** How many clicks to play in total. */
      this.clicks = wholeAtLeast(processorOptions.clicks, DEFAULT_CLICKS, 0);

      /** The context frame the first click starts on. */
      this.firstFrame = wholeAtLeast(processorOptions.first_frame, this.interval, 0);

      /** The click, built once from this context's rate. */
      this.template = clickTemplate(sampleRate);

      /** This processor's own frame counter (see `contextOffset`). */
      this.frame = 0;

      /** The context's frame minus this processor's, measured once. */
      this.frameOffset = null;

      /** How many clicks have been posted so far. */
      this.posted = 0;

      /** Where inside the click being written the next sample comes from. */
      this.cursor = -1;

      /** Whether a fault has been reported already. */
      this.failureReported = false;
    }

    /**
     * One block: the clicks that start inside it, and the samples a click that
     * started in an earlier block still owes the output.
     * @param {Float32Array[][]} inputs unused — the emitter is a source
     * @param {Float32Array[][]} outputs `outputs[0]` holds the stereo pair
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const count = output && output[0] ? output[0].length : 0;
      if (!output || count === 0) return true;
      // The host may reuse its buffers, and this file only adds to them.
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0);
      try {
        this.block(output, count);
      } catch (error) {
        if (!this.failureReported) {
          this.failureReported = true;
          this.report(error);
        }
      }
      this.frame += count;
      return true;
    }

    /**
     * @param {Float32Array[]} output one Float32Array per output channel
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    block(output, count) {
      const start = this.frame;
      const offset = this.contextOffset();
      const left = output[0];
      const right = output.length > 1 ? output[1] : null;

      for (let at = 0; at < count; at += 1) {
        const frame = start + at;

        // Every click whose own frame has arrived (one per interval; the `<=`
        // only guards against a host that replays a frame twice).
        while (this.posted < this.clicks && this.firstFrame + this.posted * this.interval <= frame) {
          const clickFrame = this.firstFrame + this.posted * this.interval;
          this.posted += 1;
          this.cursor = 0;
          this.port.postMessage({ type: "click", frame: offset + clickFrame });
        }

        if (this.cursor < 0) continue;
        if (this.cursor >= CLICK_SAMPLES) {
          this.cursor = -1;
          continue;
        }
        const sample = this.template[this.cursor];
        this.cursor += 1;
        left[at] += sample;
        if (right) right[at] += sample;
      }
    }

    /**
     * The offset from this processor's frames to the context's, measured once at
     * the first block from the shared `currentFrame` (see the file header).
     * @returns {number}
     */
    contextOffset() {
      if (this.frameOffset === null) {
        const now = contextFrameNow();
        this.frameOffset = now === null ? 0 : now - this.frame;
      }
      return this.frameOffset;
    }

    /**
     * Report a fault to the client as a string it can log.
     * @param {unknown} error
     * @returns {void}
     */
    report(error) {
      const text = error && error.message ? error.message : String(error);
      this.port.postMessage({ type: "error", error: text });
    }
  }

  registerProcessor(PROCESSOR_NAME, CalibrateEmitterProcessor);
})();