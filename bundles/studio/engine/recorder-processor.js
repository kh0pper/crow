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
 * - `{type:"gate", anchorFrame, loopFrames, fromFrames, toFrames,
 *   offsetFrames, activeFrom}` — a punch: the same stretch of every loop pass
 *   is the only part of the take that holds the input (see "The gate" below).
 * - `{type:"gate_off"}` — no gate: every captured frame is the input again.
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
 * ## The gate
 *
 * A punch range is one stretch of a clip, and a loop-recorded pass is that
 * clip: the range applies to EVERY pass, so the gate is periodic rather than a
 * list — nothing to top up, nothing to allocate, no cap on the number of
 * ranges. The worklet keeps two preallocated slots (`gateCurrent` in force,
 * `gateNext` waiting) and a message fills `next` in place; `next` becomes
 * `current` on the first block whose start is at or after its `activeFrom`, so
 * a slot is only ever swapped between blocks. A gate is defined only for
 * frames at or after `anchor + offsetFrames` (before that the take is open), so
 * a gate that arrives before the arm frame — or a replacement mid-pass, sent
 * with the next pass's own start — never gates a pass that is already running.
 *
 * Inside a gate a frame is recorded as digital silence when it lies outside
 * `[on, off)` of its pass. It is still counted and chunked, so a gated pass
 * keeps its full length, its chunk numbering and its `segment` entry: a take's
 * beat 0 stays the clip's beat 0. Pass membership uses the same rounded
 * boundaries the page's splits do (`anchor + round(k * loopFrames) +
 * offsetFrames`), and `on`/`off` are the expression `panel/punch.js`
 * `passGateRanges` uses — `round(anchor + k * loopFrames + offsetFrames +
 * fromFrames)` and the same with `toFrames` — so the gate and the page agree on
 * a frame, including at a seam where the loop length is not a whole number of
 * frames.
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

  /**
   * How much input the recorder keeps before it is armed, in seconds. An arm
   * frame always arrives late: it comes from a launch report the engine posts
   * after that frame has played, plus the trip through the main thread. With
   * the last few seconds kept, the take still starts exactly on its frame.
   */
  const PREROLL_SECONDS = 4;

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

  /**
   * @param {unknown} value a number a client sent
   * @returns {number|null} the number, or null when it is not a finite one
   */
  function reading(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  /**
   * A gate slot with nothing in it. Two of these live for the whole processor;
   * a message fills one in place and `swapGate()` trades the two.
   * @returns {{anchorFrame: number, loopFrames: number, fromFrames: number,
   *            toFrames: number, offsetFrames: number, activeFrom: number}}
   */
  function emptyGate() {
    return { anchorFrame: 0, loopFrames: 0, fromFrames: 0, toFrames: 0, offsetFrames: 0, activeFrom: 0 };
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

      /**
       * The pre-roll ring: the most recent input frames, interleaved, and the
       * absolute frame just after the newest one kept.
       */
      this.prerollFrames = Math.max(128, Math.round(PREROLL_SECONDS * sampleRate));
      this.preroll = new Float32Array(this.prerollFrames * this.channels);
      this.prerollEnd = null;

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

      /**
       * The punch gate: two preallocated slots, `current` (in force) and `next`
       * (waiting for its `activeFrom`). A message fills `next`; the block loop
       * swaps the two objects, never their fields, so nothing is allocated on
       * the audio thread. With both slots off the recorder is exactly the
       * recorder it was before the gate existed.
       */
      this.gateCurrent = emptyGate();
      this.gateNext = emptyGate();
      this.gateCurrentOn = false;
      this.gateNextOn = false;

      this.port.onmessage = (event) => {
        try {
          this.receive(event && event.data);
        } catch (error) {
          this.report(error);
        }
      };
    }

    /**
     * One message from the client: arm, stop, split or gate.
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
        return;
      }
      if (message.type === "gate") {
        this.receiveGate(message);
        return;
      }
      if (message.type === "gate_off") {
        this.gateCurrentOn = false;
        this.gateNextOn = false;
        return;
      }
    }

    /**
     * A punch range: fill the waiting slot with it. The slot becomes the gate
     * from the first block that starts at or after `activeFrom`.
     * @param {object} message
     * @returns {void}
     */
    receiveGate(message) {
      const anchorFrame = reading(message.anchorFrame);
      const loopFrames = reading(message.loopFrames);
      const fromFrames = reading(message.fromFrames);
      const toFrames = reading(message.toFrames);
      const offsetFrames = message.offsetFrames === undefined ? 0 : reading(message.offsetFrames);
      const activeFrom = message.activeFrom === undefined ? null : reading(message.activeFrom);
      if (
        anchorFrame === null ||
        loopFrames === null ||
        fromFrames === null ||
        toFrames === null ||
        offsetFrames === null ||
        (message.activeFrom !== undefined && activeFrom === null)
      ) {
        this.complain("a gate needs a frame for every one of its numbers");
        return;
      }
      if (!(loopFrames > 0)) {
        this.complain("a gate needs a pass longer than no frames");
        return;
      }
      if (!(toFrames > fromFrames)) {
        this.complain("a gate has to end after it begins");
        return;
      }
      const slot = this.gateNext;
      slot.anchorFrame = anchorFrame;
      slot.loopFrames = loopFrames;
      slot.fromFrames = fromFrames;
      slot.toFrames = toFrames;
      slot.offsetFrames = offsetFrames;
      slot.activeFrom = activeFrom === null ? anchorFrame + offsetFrames : activeFrom;
      this.gateNextOn = true;
    }

    /**
     * Make the waiting slot the gate when this block is old enough for it. A slot
     * changes between blocks only, so a replacement sent mid-pass leaves the pass
     * that is running on the range it started with.
     * @param {number} base this block's first context frame
     * @returns {void}
     */
    swapGate(base) {
      if (!this.gateNextOn) return;
      if (base < this.gateNext.activeFrom) return;
      const incoming = this.gateNext;
      this.gateNext = this.gateCurrent;
      this.gateCurrent = incoming;
      this.gateCurrentOn = true;
      this.gateNextOn = false;
    }

    /**
     * Whether this frame is outside the open range of its pass, and so recorded
     * as silence. Nothing is gated before the gate's own first frame, and a
     * recorder with no gate passes every frame.
     * @param {number} frame the absolute frame
     * @returns {boolean}
     */
    gateSilentAt(frame) {
      if (!this.gateCurrentOn) return false;
      const gate = this.gateCurrent;
      const anchor = gate.anchorFrame;
      const offset = gate.offsetFrames;
      const loop = gate.loopFrames;
      // The gate is defined only from the take's first frame: before it every
      // frame is the input, so a gate can never bite into a pass already running.
      if (frame < anchor + offset) return false;
      // Which pass, then corrected by one against the same rounded boundaries
      // the page's splits use — so a fractional pass length can never put the
      // first frame of a pass inside the previous pass's range, or the last frame
      // of a pass outside its own.
      let pass = Math.floor((frame - anchor - offset) / loop);
      if (frame < anchor + Math.round(pass * loop) + offset) pass -= 1;
      else if (frame >= anchor + Math.round((pass + 1) * loop) + offset) pass += 1;
      const on = Math.round(anchor + pass * loop + offset + gate.fromFrames);
      const off = Math.round(anchor + pass * loop + offset + gate.toFrames);
      return frame < on || frame >= off;
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
      this.swapGate(base);
      const first = input && input[0] ? input[0] : null;

      // Armed on a frame that has already gone by: start there from the
      // pre-roll. Frames older than the pre-roll are silence, so the take still
      // begins on its frame and lines up with the song.
      if (!this.started && this.armFrame !== null && this.armFrame < base) {
        this.begin();
        let past = this.armFrame;
        const pastAt = (channel) => this.prerollSample(past, channel);
        for (; past < base; past += 1) {
          if (this.step(past, pastAt)) return;
        }
      }

      // One reader for the whole block (no closure per frame on the audio
      // thread); it reads the frame `at` points to.
      let at = 0;
      const sampleAt = (channel) => {
        const data = input && input[channel] ? input[channel] : first;
        return data && at < data.length ? data[at] : 0;
      };
      for (at = 0; at < count; at += 1) {
        const frame = base + at;
        if (!this.started) {
          this.keepPreroll(frame, sampleAt);
          if (this.armFrame === null || frame < this.armFrame) continue;
          this.begin();
        }
        if (this.step(frame, sampleAt)) return;
      }
    }

    /** Capture begins: the first segment opens on the arm frame. */
    begin() {
      this.started = true;
      this.segment = 0;
      this.segmentStart = this.armFrame;
      this.segmentFrames = 0;
      this.chunkIndex = 0;
    }

    /**
     * Keep one input frame in the pre-roll ring.
     * @param {number} frame the absolute frame
     * @param {(channel: number) => number} sampleAt
     * @returns {void}
     */
    keepPreroll(frame, sampleAt) {
      const slot = frame % this.prerollFrames;
      for (let channel = 0; channel < this.channels; channel += 1) {
        this.preroll[slot * this.channels + channel] = sampleAt(channel);
      }
      this.prerollEnd = frame + 1;
    }

    /**
     * One channel of a past frame from the pre-roll, or silence when that
     * frame is older than the pre-roll (or was never seen).
     * @param {number} frame
     * @param {number} channel
     * @returns {number}
     */
    prerollSample(frame, channel) {
      if (this.prerollEnd === null || frame >= this.prerollEnd || frame < this.prerollEnd - this.prerollFrames) {
        return 0;
      }
      return this.preroll[(frame % this.prerollFrames) * this.channels + channel];
    }

    /**
     * Capture one frame: apply the splits that fall on it, stop on the stop
     * frame, otherwise add its samples to the open chunk.
     * @param {number} frame the absolute frame
     * @param {(channel: number) => number} sampleAt
     * @returns {boolean} true when the recording finished on this frame
     */
    step(frame, sampleAt) {
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
        return true;
      }

      // A frame outside the punch range is recorded as digital silence; it is
      // still counted, so the pass keeps its full length and chunk numbering.
      const silent = this.gateSilentAt(frame);
      for (let channel = 0; channel < this.channels; channel += 1) {
        this.pending[this.pendingFrames * this.channels + channel] = silent ? 0 : sampleAt(channel);
      }
      this.pendingFrames += 1;
      this.segmentFrames += 1;
      if (this.pendingFrames >= this.chunkFrames) this.flushChunk();
      return false;
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
     * Report a message the recorder could not use, without stopping: a gate
     * with a bad number is ignored and the take carries on ungated by it.
     * @param {string} text
     * @returns {void}
     */
    complain(text) {
      this.port.postMessage({ type: "error", error: text });
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