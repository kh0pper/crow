/** Box-filter decimation to 16 kHz PCM16, emitted as fixed 20 ms frames with their RMS. */
export function createDecimator(inRate, onFrame, frameSize = 320, outRate = 16000) {
  const ratio = inRate / outRate;
  let phase = 0, acc = 0, cnt = 0, n = 0, sumSq = 0;
  let out = new Int16Array(frameSize);
  return function push(samples) {
    for (let i = 0; i < samples.length; i++) {
      acc += samples[i]; cnt++; phase += 1;
      if (phase >= ratio) {
        phase -= ratio;
        let v = acc / cnt;
        acc = 0; cnt = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        out[n++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
        sumSq += v * v;
        if (n === frameSize) { onFrame(out, Math.sqrt(sumSq / frameSize)); out = new Int16Array(frameSize); n = 0; sumSq = 0; }
      }
    }
  };
}

/**
 * Runs INSIDE the AudioWorklet (review m7): while idle, frames go into a 1.0 s
 * ring and NOTHING is posted to the main thread (no 50 Hz messages at idle on a
 * Pi 3). start(withPreroll) flushes the ring first (wake word, K2) then posts live
 * frames; stop() goes back to ring-only.
 */
export function createFrameGate(post, maxFrames = 50) {
  const ring = [];
  let capturing = false;
  return {
    push(pcm, rms) {
      if (capturing) { post(pcm, rms); return; }
      ring.push([pcm, rms]);
      if (ring.length > maxFrames) ring.shift();
    },
    start(withPreroll) {
      if (withPreroll) for (const [p, r] of ring) post(p, r);
      ring.length = 0;
      capturing = true;
    },
    stop() { capturing = false; },
    get ringSize() { return ring.length; },
  };
}
