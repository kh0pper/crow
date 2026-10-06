/** Mic capture (AEC/NS/AGC on, spec §7.3) and in-page playback (so Chromium's echo canceller sees it). */
import { playStartPerfTime } from "./metrics.js";

/** The capture worklet is added to an AudioContext once: a phone opens the mic again at every tap (F6). */
const worklets = new WeakSet();
export async function openMic(ctx, onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  if (!worklets.has(ctx)) {
    try { await ctx.audioWorklet.addModule("/display/assets/pcm-worklet.js"); }
    catch (err) { stream.getTracks().forEach((t) => t.stop()); throw err; }
    worklets.add(ctx);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e) => onFrame(e.data.pcm, e.data.rms, performance.now());
  src.connect(node);
  return {
    start(preroll) { node.port.postMessage({ cmd: "start", preroll: !!preroll }); },
    stop() { node.port.postMessage({ cmd: "stop" }); },
    close() { try { src.disconnect(); node.disconnect(); } catch {} stream.getTracks().forEach((t) => t.stop()); },
  };
}

/**
 * One microphone at a time (review H3): every caller of acquire() during an open waits for the SAME open, so a
 * second tap can never start a second stream. release() during an open closes what that open returns. open() →
 * Promise<mic with close()>; now() → ms (the open time is kept for the turn's metrics).
 */
export function createMicGate(open, now = () => performance.now()) {
  let mic = null, pending = null, dropped = false, lastMs = null;
  return {
    get current() { return mic; },
    opening: () => pending !== null,
    acquire() {
      if (mic) return Promise.resolve(mic);
      if (pending) { dropped = false; return pending; }
      dropped = false;
      const t0 = now();
      pending = Promise.resolve().then(open).then(
        (m) => { pending = null; if (dropped) { try { m.close(); } catch {} return null; } mic = m; lastMs = now() - t0; return m; },
        (err) => { pending = null; throw err; });
      return pending;
    },
    release() { if (pending) dropped = true; if (mic) { const m = mic; mic = null; try { m.close(); } catch {} } },
    takeOpenMs() { const v = lastMs; lastMs = null; return v; },
  };
}

/**
 * Sequential playback of the server's sentence buffers. `playing` covers buffers still
 * being decoded (the server's idle can arrive before an mp3 decode finishes, ruling F3).
 * onDrained fires once when the last source ends naturally; flush() (a barge) never fires it,
 * and buffers queued before a flush never start after it. After a flush the player is muted:
 * frames still in flight are dropped until the next begin() (tts_start). onFirstPlay(at, tag) carries the
 * tag given to begin() so the page attributes the play time to the right turn.
 */
export function createPlayer(ctx, { onLevel, onFirstPlay, onDrained }) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.connect(ctx.destination);
  const data = new Uint8Array(analyser.fftSize);
  const sources = new Set();
  let codec = "pcm", rate = 24000, nextAt = 0, first = true, tag = null, level = null, chain = Promise.resolve(), gen = 0, pending = 0, muted = false;
  const startLevel = () => {
    if (level) return;
    level = setInterval(() => {                     // ~15 Hz beak level, only while audio plays
      analyser.getByteTimeDomainData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) { const x = (data[i] - 128) / 128; s += x * x; }
      onLevel(Math.min(1, Math.sqrt(s / data.length) * 4));
    }, 66);
  };
  const stopLevel = () => { clearInterval(level); level = null; onLevel(0); };
  const maybeDrained = () => { if (!sources.size && !pending) { stopLevel(); onDrained(); } };
  async function play(buf, g) {
    let ab;
    if (codec === "pcm") {
      const i16 = new Int16Array(buf, 0, buf.byteLength >> 1);
      ab = ctx.createBuffer(1, i16.length, rate);
      const ch = ab.getChannelData(0);
      for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    } else {
      ab = await ctx.decodeAudioData(buf.slice(0));
    }
    if (g !== gen) return;
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(analyser);
    const when = Math.max(ctx.currentTime + 0.02, nextAt);
    src.start(when);
    nextAt = when + ab.duration;
    sources.add(src);
    src.onended = () => { sources.delete(src); maybeDrained(); };
    startLevel();                                   // every start: a drained inter-sentence gap stopped it
    if (first) {
      first = false;
      onFirstPlay(playStartPerfTime({ nowPerf: performance.now(), ctxCurrentTime: ctx.currentTime, startWhen: when, outputLatency: ctx.outputLatency || ctx.baseLatency || 0 }), tag);
    }
  }
  return {
    // nextAt is NOT reset: an announcement that follows a turn queues after it instead of overlapping.
    begin(c, sr, t = null) { codec = c === "mp3" ? "mp3" : "pcm"; rate = sr || 24000; first = true; tag = t; muted = false; },
    push(buf) {
      if (muted) return;                            // in-flight audio from before a barge (until the next tts_start)
      const g = gen;
      pending++;
      chain = chain.then(() => (g === gen ? play(buf, g) : null)).catch(() => {}).then(() => {
        if (g !== gen) return;
        pending--;
        maybeDrained();
      });
    },
    flush() {
      gen++;
      muted = true;
      pending = 0;
      for (const s of sources) { s.onended = null; try { s.stop(); } catch {} }
      sources.clear(); nextAt = 0; chain = Promise.resolve(); stopLevel();
    },
    get playing() { return sources.size > 0 || pending > 0; },
    get sampling() { return level != null; },
  };
}
