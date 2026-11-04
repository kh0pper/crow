/**
 * Studio calibration detector worklet — the listening end of a loopback.
 *
 * `engine-client.js` loads this file with its own `audioWorklet.addModule()`,
 * separate from the engine module. Classic script: no imports, one
 * `registerProcessor()` call at the end.
 *
 * ## What it measures
 *
 * The main thread forwards every click the emitter reports as
 * `{type:"expect", frame}` (frames are the AudioContext's, the same clock the
 * emitter and the engine use). For each of those frames the detector searches
 * its input from that frame to `frame + round(0.25 × sampleRate)` for the lag
 * whose normalised cross-correlation with the known click template is greatest:
 *
 *     r(lag) = Σ x[frame+lag+i]·t[i] / (‖x‖·‖t‖),  i = 0 … 47
 *
 * where `x` is the input mixed to mono by averaging its channels. That is the
 * round trip of the cable, the interface's converters and both buffers, in
 * frames. It answers `{type:"heard", frame, lag_frames, correlation}` when the
 * peak r is at least 0.5, and `{type:"missed", frame}` otherwise — including
 * when the expectation arrived after its window had already left the buffer, so
 * every expectation is always answered exactly once.
 *
 * The template is rebuilt here with the same arithmetic the emitter uses (48
 * samples of a 1 kHz sine under a Hann window, peak −6 dBFS), because the two
 * worklets share no module scope: only the constants and the formula are
 * duplicated.
 *
 * ## Buffering
 *
 * The detector keeps the last 10 s of its mono input in a ring buffer and only
 * ever reads what it has buffered. The expectations come from the main thread,
 * which can fall behind the audio thread (a busy page, or an offline render
 * that runs faster than real time), so the buffer is long enough to hold a
 * whole calibration run: a late expectation still finds its click. Within that: an expectation for a window that has not
 * arrived yet waits, and one for a window that has been overwritten is answered
 * `missed` rather than measured against the wrong audio. The full lag scan is
 * about `0.25 × sampleRate × 48` multiply-adds per click; calibration runs at
 * half a second per click, so the cost is harmless (and a block that goes over
 * its quantum only during calibration is inaudible).
 *
 * ## Output
 *
 * The detector has one output that is always silence: it exists so the node can
 * be pulled by the graph through a gain of 0 (see `engine-client.js`), because
 * a host only runs processors the destination can reach. `process()` never
 * throws; a fault is reported once and the block stays silent.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-calibrate-detector";

  /** The click's length, in samples (one period of 1 kHz at 48 kHz). */
  const TEMPLATE_SAMPLES = 48;

  /** The click's pitch, in Hz. */
  const CLICK_HZ = 1000;

  /** The click's amplitude, −6 dBFS. */
  const CLICK_PEAK = 0.5012;

  /** How far past the expected frame the detector searches, in seconds. */
  const SEARCH_SECONDS = 0.25;

  /** The lowest peak correlation that counts as the click. */
  const MIN_CORRELATION = 0.5;

  /** How much input the ring buffer keeps, in seconds: a whole calibration run. */
  const BUFFER_SECONDS = 10;

  /** Slack on top of the search window, so a block never splits a needed sample. */
  const SLACK_SAMPLES = 256;

  /**
   * The AudioWorkletGlobalScope's `currentFrame`, or null in a host without it.
   * @returns {number|null}
   */
  function contextFrameNow() {
    if (typeof currentFrame === "undefined") return null;
    return typeof currentFrame === "number" && Number.isFinite(currentFrame) ? currentFrame : null;
  }

  /**
   * The known click: a 1 kHz sine under a 48-sample Hann window, scaled to the
   * click's peak. The emitter builds the same array (`calibrate-emitter.js`).
   * @param {number} rate the context's sample rate, in Hz
   * @returns {Float32Array} `TEMPLATE_SAMPLES` samples
   */
  function clickTemplate(rate) {
    const samples = new Float32Array(TEMPLATE_SAMPLES);
    for (let index = 0; index < TEMPLATE_SAMPLES; index += 1) {
      const sine = Math.sin((2 * Math.PI * CLICK_HZ * index) / rate);
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (TEMPLATE_SAMPLES - 1));
      samples[index] = sine * hann * CLICK_PEAK;
    }
    return samples;
  }

  /**
   * @param {Float32Array} samples
   * @returns {number} the Euclidean length of the vector
   */
  function lengthOf(samples) {
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
    return Math.sqrt(sum);
  }

  /** One AudioWorkletProcessor that finds the emitted clicks in its input. */
  class CalibrateDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
      super();

      /** The click it is looking for. */
      this.template = clickTemplate(sampleRate);
      this.templateLength = lengthOf(this.template);

      /** How many lags to try: 0 to this many frames past the expected frame. */
      this.search = Math.max(0, Math.round(sampleRate * SEARCH_SECONDS));

      /** The mono ring buffer, and how many frames have been written into it. */
      this.capacity = Math.max(
        Math.round(sampleRate * BUFFER_SECONDS) + SLACK_SAMPLES,
        this.search + TEMPLATE_SAMPLES + SLACK_SAMPLES,
      );
      this.buffer = new Float32Array(this.capacity);
      this.written = 0;

      /** This processor's own frame counter and its offset to the context's. */
      this.frame = 0;
      this.frameOffset = null;

      /** Expectations not answered yet: `{frame, local}` (frame is the context's). */
      this.pending = [];

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
     * One `expect` message: the context frame a click was emitted on.
     * @param {object} message
     * @returns {void}
     */
    receive(message) {
      if (!message || typeof message !== "object" || message.type !== "expect") return;
      const frame = Number(message.frame);
      if (!Number.isFinite(frame)) return;
      const whole = Math.trunc(frame);
      this.pending.push({ frame: whole, local: whole - this.contextOffset() });
    }

    /**
     * One block: buffer the input, then answer every expectation whose window
     * has fully arrived (or has already been overwritten).
     * @param {Float32Array[][]} inputs `inputs[0]` is the loopback's input
     * @param {Float32Array[][]} outputs `outputs[0]` is always silence
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const count = output && output[0] ? output[0].length : 0;
      if (!output || count === 0) return true;
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0);
      try {
        // Frozen at the first block, while `this.frame` is that block's start.
        this.contextOffset();
        this.capture(inputs && inputs[0], count);
        this.settle();
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
     * Push one block of input into the ring buffer, mixed to mono by averaging
     * the channels that carry data.
     * @param {Float32Array[]|undefined} input
     * @param {number} count
     * @returns {void}
     */
    capture(input, count) {
      const channels = input && input.length > 0 ? input : null;
      for (let at = 0; at < count; at += 1) {
        let sum = 0;
        let used = 0;
        if (channels) {
          for (let channel = 0; channel < channels.length; channel += 1) {
            const data = channels[channel];
            if (!data || at >= data.length) continue;
            sum += data[at];
            used += 1;
          }
        }
        this.buffer[this.written % this.capacity] = used > 0 ? sum / used : 0;
        this.written += 1;
      }
    }

    /**
     * Answer every expectation the buffer can speak for, keeping the rest.
     * @returns {void}
     */
    settle() {
      if (this.pending.length === 0) return;
      const oldest = Math.max(0, this.written - this.capacity);
      const waiting = [];
      for (let at = 0; at < this.pending.length; at += 1) {
        const expectation = this.pending[at];
        if (expectation.local < oldest) {
          // Its window has been overwritten: the expectation came too late to
          // measure, which is a miss, not a measurement of other audio.
          this.port.postMessage({ type: "missed", frame: expectation.frame });
          continue;
        }
        if (expectation.local + this.search + TEMPLATE_SAMPLES > this.written) {
          waiting.push(expectation);
          continue;
        }
        const best = this.searchAt(expectation.local);
        if (best.correlation >= MIN_CORRELATION) {
          this.port.postMessage({
            type: "heard",
            frame: expectation.frame,
            lag_frames: best.lag,
            correlation: best.correlation,
          });
        } else {
          this.port.postMessage({ type: "missed", frame: expectation.frame });
        }
      }
      this.pending = waiting;
    }

    /**
     * The lag with the greatest normalised cross-correlation, over the search
     * window that starts at one buffered frame.
     * @param {number} local the frame the search starts on
     * @returns {{lag: number, correlation: number}}
     */
    searchAt(local) {
      const template = this.template;
      const templateLength = this.templateLength;
      const capacity = this.capacity;
      let bestLag = 0;
      let best = 0;
      for (let lag = 0; lag <= this.search; lag += 1) {
        const start = local + lag;
        let dot = 0;
        let energy = 0;
        for (let index = 0; index < TEMPLATE_SAMPLES; index += 1) {
          const sample = this.buffer[(start + index) % capacity];
          dot += sample * template[index];
          energy += sample * sample;
        }
        if (!(energy > 0)) continue;
        const correlation = dot / (Math.sqrt(energy) * templateLength);
        if (correlation > best) {
          best = correlation;
          bestLag = lag;
        }
      }
      return { lag: bestLag, correlation: best };
    }

    /**
     * The offset from this processor's frames to the context's, measured once
     * (on a Node host `currentFrame` stays 0, so it is the first block's frame).
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

  registerProcessor(PROCESSOR_NAME, CalibrateDetectorProcessor);
})();