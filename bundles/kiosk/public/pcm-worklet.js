import { createDecimator, createFrameGate } from "./resample.js";
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    const gate = createFrameGate((pcm, rms) => this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]));
    this.push = createDecimator(sampleRate, (pcm, rms) => gate.push(pcm, rms));
    this.port.onmessage = (e) => { if (e.data?.cmd === "start") gate.start(!!e.data.preroll); else if (e.data?.cmd === "stop") gate.stop(); };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.push(ch);
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
