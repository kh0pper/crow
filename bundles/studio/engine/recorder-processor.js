/**
 * Studio recorder worklet — turns a live input into 24-bit take chunks.
 *
 * `engine-client.js` loads this file with its own `audioWorklet.addModule()`,
 * separate from the engine module. Classic script: no imports, one
 * `registerProcessor()` call at the end.
 *
 * ## One clock with the engine
 *
 * Frames here are the AudioContext's, exactly like the engine's launch reports
 * (`studio-processor.js`): the worklet scope's shared `currentFrame` plus the
 * offset measured once at the first block. That is what lets the panel arm a
 * take on the very frame a launch took effect (Task 2's `onLaunch`), and stop it
 * on a bar line, without either worklet knowing anything about the other.
 *
 * ## What it is told
 *
 * client → recorder:
 *
 * - `{type:"arm", frame}` — start capturing AT this frame (inclusive).
 * - `{type:"stop", frame}` — stop AT this frame (exclusive).
 * - `{type:"split", frames:[…]}` — absolute frames at which a new take segment
 *   begins (loop recording: one pass, one take). Segments are numbered from 0
 *   and `segment` in every chunk names the one it belongs to.
 *
 * recorder → client:
 *
 * - `{type:"chunk", segment, index, bytes}` — 24-bit little-endian interleaved
 *   PCM covering whole frames, at most 1048576 bytes, in order within a
 *   segment; `index` restarts at 0 for each segment. The `bytes` ArrayBuffer is
 *   transferred, not copied.
 * - `{type:"done", segments:[{segment, start_frame, frames}]}` — posted once,
 *   as soon as the stop frame is reached.
 * - `{type:"error", error}` — a fault, reported once.
 *
 * ## Encoding
 *
 * A sample is clamped to [-1, 1] and scaled by 2^23 − 1, then written as a
 * 24-bit two's-complement little-endian integer — the same convention as
 * `server/wav.js` (`encodeWav24`, `wavHeader`, `decodeWav`), so a take's WAV
 * built in the gateway from these chunks reads back sample-exact.
 *
 * ## Output
 *
 * The recorder's own output is always silence; it has one so the graph can pull
 * it through a gain of 0 (`engine-client.js` explains why). `process()` never
 * throws: a fault is reported once and the take stops rather than taking the
 * host's audio thread down with it.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-recorder";

  /** The largest chunk this worklet posts, in bytes (1 MiB). */
  const CHUNK_BYTES = 1048576;

  /** Bytes in one 24-bit sample. */
  const BYTES_PER_SAMPLE = 3;

  /** 24-bit signed full scale, 2^23 − 1 — the same as `server/wav.js`. */
  const FULL_SCALE = 8388607;

  /** 2^24, added to a negative integer to make it 24-bit two's complement. */
  const TWO_POW_24 = 0x1000000;

  /**
   * The AudioWorkletGlobalScope's `currentFrame`, or null in a host without it.
   * @returns {number|null}
   */
  function contextFrameNow() {
    if (typeof currentFrame === "undefined") return null;
    return typeof currentFrame === "number" && Number.isFinite(currentFrame) ? currentFrame : null;
  }

  /**
   * @param {unknown} value a frame a client sent
   * @returns {number|null} a whole frame number, or null when it is not one
   */
  function wholeFrame(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  /** One AudioWorkletProcessor that records an input as 24-bit PCM chunks. */
  class StudioRecorderProcessor extends AudioWorkletProcessor {
    /** @param {{processorOptions?: {channels?: number}}} options */
    constructor(options) {
      super();
      const processorOptions = (options && options.processorOptions) || {};

      /** How many channels the take has: 1 or 2. */
      this.channels = Number(processorOptions.channels) === 2 ? 2 : 1;

      /**
       * Frames per chunk: as many whole frames as fit in `CHUNK_BYTES`. A
       * chunk therefore never splits a frame, which is what makes the gateway's
       * concatenation of the staged chunk files a plain byte stream.
       */
      this.chunkFrames = Math.max(1, Math.floor(CHUNK_BYTES / (BYTES_PER_SAMPLE * this.channels)));

      /** Samples waiting for their chunk, interleaved, and how many frames that is. */
      this.pending = new Float32Array(this.chunkFrames * this.channels);
      this.pendingFrames = 0;

      /** The chunk number inside the current segment (it restarts at each split). */
      this.chunkIndex = 0;

      /** The segment being recorded, and the frames it has so far. */
      this.segment = 0;
      this.segmentStart = null;
      this.segmentFrames = 0;

      /** Every finished segment, in order, for the `done` message. */
      this.segments = [];

      /** The frame to start at, and the frame to stop at (both absolute). */
      this.armFrame = null;
      this.stopFrame = null;

      /** The split frames still to come, sorted, and the next one to apply. */
      this.splits = [];
      this.nextSplit = 0;

      /** Whether capture has begun, and whether it is over. */
      this.started = false;
      this.stopped = false;

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
     * One message from the client: arm, stop or split.
     * @param {object} message
     * @returns {void}
     */
    receive(message) {
      if (!message || typeof message !== "object") return;
      if (message.type === "arm") {
        const frame = wholeFrame(message.frame);
        if (frame !== null) this.armFrame = frame;
        return;
      }
      if (message.type === "stop") {
        const frame = wholeFrame(message.frame);
        if (frame !== null) this.stopFrame = frame;
        return;
      }
      if (message.type === "split") {
        const frames = [];
        for (const value of Array.isArray(message.frames) ? message.frames : []) {
          const frame = wholeFrame(value);
          if (frame !== null) frames.push(frame);
        }
        frames.sort((left, right) => left - right);
        this.splits = frames;
        this.nextSplit = 0;
      }
    }

    /**
     * One block: capture the frames between `arm` and `stop`, cutting a new
     * segment at every split frame.
     * @param {Float32Array[][]} inputs `inputs[0]` is the live input
     * @param {Float32Array[][]} outputs `outputs[0]` is always silence
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const count = output && output[0] ? output[0].length : 0;
      if (!output || count === 0) return true;
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0);
      try {
        this.contextOffset();
        this.block(inputs && inputs[0], count);
      } catch (error) {
        this.report(error);
      }
      this.frame += count;
      return true;
    }

    /**
     * Capture one block, frame by frame, on the context's clock.
     * @param {Float32Array[]|undefined} input one Float32Array per input channel
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    block(input, count) {
      if (this.stopped) return;
      const base = this.contextOffset() + this.frame;
      const first = input && input[0] ? input[0] : null;

      for (let at = 0; at < count; at += 1) {
        const frame = base + at;

        if (!this.started) {
          if (this.armFrame === null || frame < this.armFrame) continue;
          this.started = true;
          this.segment = 0;
          this.segmentStart = this.armFrame;
          this.segmentFrames = 0;
          this.chunkIndex = 0;
        }

        // A split closes the open segment and opens the next one on its own
        // frame. A split at or before the segment's own start is history.
        while (this.nextSplit < this.splits.length) {
          const split = this.splits[this.nextSplit];
          if (this.segmentStart !== null && split <= this.segmentStart) {
            this.nextSplit += 1;
            continue;
          }
          if (split > frame) break;
          this.closeSegment(split);
          this.nextSplit += 1;
        }

        if (this.stopFrame !== null && frame >= this.stopFrame) {
          this.finish();
          return;
        }

        for (let channel = 0; channel < this.channels; channel += 1) {
          const data = input && input[channel] ? input[channel] : first;
          this.pending[this.pendingFrames * this.channels + channel] = data && at < data.length ? data[at] : 0;
        }
        this.pendingFrames += 1;
        this.segmentFrames += 1;
        if (this.pendingFrames >= this.chunkFrames) this.flushChunk();
      }
    }

    /**
     * Finish the segment being recorded and start the next one at `nextStart`.
     * @param {number} nextStart the absolute frame the next segment begins on
     * @returns {void}
     */
    closeSegment(nextStart) {
      this.flushChunk();
      if (this.segmentFrames > 0) {
        this.segments.push({ segment: this.segment, start_frame: this.segmentStart, frames: this.segmentFrames });
      }
      this.segment += 1;
      this.segmentStart = nextStart;
      this.segmentFrames = 0;
      this.chunkIndex = 0;
    }

    /**
     * The stop frame arrived: flush the last chunk, close the last segment and
     * tell the client. Nothing is captured after this.
     * @returns {void}
     */
    finish() {
      if (this.stopped) return;
      this.stopped = true;
      this.flushChunk();
      if (this.segmentFrames > 0) {
        this.segments.push({ segment: this.segment, start_frame: this.segmentStart, frames: this.segmentFrames });
      }
      this.segmentFrames = 0;
      this.port.postMessage({ type: "done", segments: this.segments });
    }

    /**
     * Encode the samples waiting for a chunk as 24-bit little-endian interleaved
     * PCM and post them. The bytes cover whole frames only.
     * @returns {void}
     */
    flushChunk() {
      const frames = this.pendingFrames;
      if (frames <= 0) return;
      const channels = this.channels;
      const bytes = new Uint8Array(frames * channels * BYTES_PER_SAMPLE);
      let at = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          const value = this.pending[frame * channels + channel];
          const sample = Number.isFinite(value) ? (value > 1 ? 1 : value < -1 ? -1 : value) : 0;
          let integer = Math.round(sample * FULL_SCALE);
          if (integer < 0) integer += TWO_POW_24;
          bytes[at] = integer & 0xff;
          bytes[at + 1] = (integer >> 8) & 0xff;
          bytes[at + 2] = (integer >> 16) & 0xff;
          at += BYTES_PER_SAMPLE;
        }
      }
      this.pendingFrames = 0;
      const index = this.chunkIndex;
      this.chunkIndex += 1;
      this.post({ type: "chunk", segment: this.segment, index: index, bytes: bytes.buffer }, bytes.buffer);
    }

    /**
     * Post one message, transferring its buffer when the host's port allows it.
     * @param {object} message
     * @param {ArrayBuffer} [transfer]
     * @returns {void}
     */
    post(message, transfer) {
      if (transfer) {
        try {
          this.port.postMessage(message, [transfer]);
          return;
        } catch {
          /* a port without a transfer list still gets the message, copied */
        }
      }
      this.port.postMessage(message);
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
     * capturing: a take half-written by a broken block is not a take.
     * @param {unknown} error
     * @returns {void}
     */
    report(error) {
      this.stopped = true;
      if (this.failureReported) return;
      this.failureReported = true;
      const text = error && error.message ? error.message : String(error);
      this.port.postMessage({ type: "error", error: text });
    }
  }

  registerProcessor(PROCESSOR_NAME, StudioRecorderProcessor);
})();