/**
 * Studio input meter worklet — the armed input's level and waveform columns,
 * posted from the audio thread.
 *
 * `engine-client.js` loads this file with its own `audioWorklet.addModule()`,
 * after `input-level.js`, whose `globalThis.StudioInputLevel` it uses. Classic
 * script: no imports, one `registerProcessor()` call at the end.
 *
 * ## The DRY input, and nothing else
 *
 * The input an operator arms is what a take holds (the take is the dry signal;
 * "hear the chain" never changes it), so the meter, the peak hold and the live
 * waveform read that same input before any effect. The master's meter
 * (`engine/meter.js`) is a different thing and stays where it is.
 *
 * ## What it is told
 *
 * client → meter:
 *
 * - `{type:"on"}` — start measuring. Nothing is posted before this.
 * - `{type:"off"}` — stop measuring; a window already in progress is dropped, so
 *   no post ever spans the silence while the lane was hidden.
 * - `{type:"clear", seq}` — let the CLIP latch go, naming the page's own clear
 *   counter. Every level payload after it carries that number as `clearSeq`, so
 *   the page can drop a `clipped` flag that was read before the clear it sent.
 *
 * meter → client:
 *
 * - `{type:"level", frame, peak, rms, clipped, clearSeq, cols}` — one payload,
 *   about thirty times a second of rendered audio, never once per block. `frame`
 *   is the CONTEXT frame of the window's first sample (the worklet scope's
 *   `currentFrame` plus the offset `recorder-processor.js` measures the same
 *   way), and `cols` is a `Float32Array` of `3 * n` values `frame, min, max`
 *   per finished column, oldest first. The page maps a column to song time as
 *   `frame - rec.offset_frames`, so the drawn waveform lands where the take
 *   will sit. `clearSeq` is a plain number beside them, never an object.
 * - `{type:"error", error}` — a fault, reported once; the meter then stops
 *   posting rather than filling the page's queue.
 *
 * ## The audio-thread rules
 *
 * `process()` allocates nothing: the whole reading lives in the core's
 * preallocated rings and scalars (`input-level.js`), the payload a post carries
 * is the one object `drain()` builds, and the block loop only touches numbers.
 * A post is a `drain()` of what finished since the last one; the page never
 * polls, and a hidden lane costs only the `process()` call.
 *
 * ## Output
 *
 * The meter's own output is always silence; it has one so the graph can pull it
 * through a gain of 0 (`engine-client.js` explains why, and the recorder has the
 * same arrangement). `process()` never throws: a fault is reported once and
 * measuring stops.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-input-meter";

  /**
   * The AudioWorkletGlobalScope's `currentFrame`, or null in a host without it.
   * @returns {number|null}
   */
  function contextFrameNow() {
    if (typeof currentFrame === "undefined") return null;
    return typeof currentFrame === "number" && Number.isFinite(currentFrame) ? currentFrame : null;
  }

  /** One AudioWorkletProcessor that meters an input and posts its columns. */
  class StudioInputMeterProcessor extends AudioWorkletProcessor {
    /** @param {{processorOptions?: {channels?: number}}} options */
    constructor(options) {
      super();
      const processorOptions = (options && options.processorOptions) || {};

      /** How many channels the input has: 1 or 2 (both are read when there are two). */
      this.channels = Number(processorOptions.channels) === 2 ? 2 : 1;

      /** The reading itself: preallocated rings, one square root per post. */
      this.core = new StudioInputLevel.InputLevelCore({
        sampleRate: typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : undefined,
      });

      /** Whether a lane is showing this input: nothing is posted until it is. */
      this.active = false;

      /** This processor's own frame counter and its offset to the context's. */
      this.frame = 0;
      this.frameOffset = null;

      /** Whether a fault has been reported already. */
      this.failureReported = false;

      this.port.onmessage = (event) => {
        try {
          this.receive(event && event.data);
        } catch (error) {
          this.report(error);
        }
      };
    }

    /**
     * One message from the client: on, off or clear.
     * @param {object} message
     * @returns {void}
     */
    receive(message) {
      if (!message || typeof message !== "object") return;
      if (message.type === "on") {
        this.resume();
        return;
      }
      if (message.type === "off") {
        this.active = false;
        return;
      }
      if (message.type === "clear") this.core.clearClip(message.seq);
    }

    /**
     * Start measuring: the window and the column in progress begin again, and so
     * does the ring, so a post never mixes frames from before the lane was shown
     * into a reading after it — a column that closed while the lane was hidden is
     * dropped rather than posted late. Nothing is allocated and the CLIP latch is
     * left alone (the page owns that). A repeated `on` (a redraw, a lane moved) is
     * not a restart.
     * @returns {void}
     */
    resume() {
      if (this.active) return;
      this.active = true;
      this.core.head = 0;
      this.core.count = 0;
      this.core.columnFrames = 0;
      this.core.postCount = 0;
      this.core.postPeak = 0;
      this.core.postSumSq = 0;
      this.core.postElapsed = 0;
      this.core.postDue = false;
    }

    /**
     * One block: measure it when the lane is shown, and post the payload the
     * core says is due. The output is silence either way.
     * @param {Float32Array[][]} inputs `inputs[0]` is the armed input
     * @param {Float32Array[][]} outputs `outputs[0]` is always silence
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const count = output && output[0] ? output[0].length : 0;
      if (!output || count === 0) return true;
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0);
      try {
        this.block(inputs && inputs[0], count);
      } catch (error) {
        this.report(error);
      }
      // The block counter runs whether or not the lane is shown: it is what
      // puts a column on the context's clock, not on a clock of its own.
      this.frame += count;
      return true;
    }

    /**
     * Measure one block and post when a window closed.
     * @param {Float32Array[]|undefined} input one Float32Array per input channel
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    block(input, count) {
      if (!this.active) return;
      const first = input && input[0] ? input[0] : null;
      // A stereo arm meters BOTH channels: the second one rides beside the
      // first, so a signal that only reaches the right channel still moves the
      // meter, the peak hold and the lane's columns.
      const second = this.channels === 2 && input && input[1] ? input[1] : null;
      const base = this.contextOffset() + this.frame;
      if (!this.core.process(base, first, count, second)) return;
      // The drained payload is the one object a post carries; the type it
      // travels under is all this file adds to it.
      const payload = this.core.drain();
      payload.type = "level";
      this.port.postMessage(payload);
    }

    /**
     * The offset from this processor's frames to the context's, measured once
     * (see the file header; on a Node host `currentFrame` stays 0).
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
     * Report a fault to the client as a string it can log, once, and stop
     * measuring: a meter that keeps posting after a broken block floods the
     * page with readings it cannot trust.
     * @param {unknown} error
     * @returns {void}
     */
    report(error) {
      this.active = false;
      if (this.failureReported) return;
      this.failureReported = true;
      const text = error && error.message ? error.message : String(error);
      this.port.postMessage({ type: "error", error: text });
    }
  }

  registerProcessor(PROCESSOR_NAME, StudioInputMeterProcessor);
})();