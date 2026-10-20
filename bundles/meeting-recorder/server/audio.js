/**
 * Meeting Recorder — reading 16-bit mono WAV and choosing where to cut it.
 *
 * The worker cuts a meeting into chunks no longer than one Whisper decoder window (30 s), each
 * cut placed at the quietest 100 ms frame inside [min, max] seconds of the chunk start, so a cut
 * lands in a pause rather than through a word. A chunk that fits one window gives
 * condition_on_previous_text nothing to condition on, which is what stops the decoder looping.
 *
 * Everything here is plain Node: the file is read in fixed-size blocks, never whole, so a
 * ninety-minute meeting (about 170 MB of PCM) costs one small buffer and an array of frame
 * energies.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const HEADER_PROBE = 64 * 1024;

/**
 * Parse a RIFF/WAVE header from a path or a Buffer. Walks the chunk list, because ffmpeg can put
 * a LIST chunk between fmt and data. Accepts only 16-bit PCM mono: that is what the worker's own
 * ffmpeg call writes, and anything else means the file is not the one we made.
 */
export function readWavHeader(source) {
  let buf;
  let fileBytes;
  if (Buffer.isBuffer(source)) {
    buf = source;
    fileBytes = source.length;
  } else {
    const fd = openSync(source, "r");
    try {
      buf = Buffer.alloc(HEADER_PROBE);
      const n = readSync(fd, buf, 0, HEADER_PROBE, 0);
      buf = buf.subarray(0, n);
      fileBytes = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  }
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt");
      if (fmt.format !== 1 && fmt.format !== 0xfffe) throw new Error("WAV is not PCM");
      if (fmt.channels !== 1) throw new Error("WAV is not mono");
      if (fmt.bitsPerSample !== 16) throw new Error("WAV is not 16-bit");
      // A streamed WAV can carry a placeholder size; the bytes on disk are the truth.
      const onDisk = Math.max(0, fileBytes - body);
      // ffmpeg killed mid-write can leave 0; a streamed WAV can leave 0xFFFFFFFF.
      let dataBytes = size === 0 || size === 0xffffffff || size > onDisk ? onDisk : size;
      dataBytes -= dataBytes % 2;
      return { sampleRate: fmt.sampleRate, channels: 1, bitsPerSample: 16, dataOffset: body, dataBytes };
    }
    pos = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Seconds of audio a parsed header describes. */
export const wavSeconds = (h) => h.dataBytes / (h.sampleRate * 2);

/** Mean-square energy of each frameMs frame of a WAV on disk (the last partial frame included). */
export function frameEnergies(path, header, frameMs = 100) {
  const frameSamples = Math.max(1, Math.round((header.sampleRate * frameMs) / 1000));
  const totalSamples = header.dataBytes / 2;
  const frames = Math.ceil(totalSamples / frameSamples);
  const out = new Float64Array(frames);
  const block = Buffer.alloc(frameSamples * 2 * 512);
  const fd = openSync(path, "r");
  try {
    let sample = 0;
    let frame = 0;
    let acc = 0;
    let inFrame = 0;
    while (sample < totalSamples) {
      const want = Math.min(block.length, (totalSamples - sample) * 2);
      const got = readSync(fd, block, 0, want, header.dataOffset + sample * 2);
      if (got <= 0) break;
      for (let i = 0; i + 1 < got; i += 2) {
        const v = block.readInt16LE(i);
        acc += v * v;
        inFrame++;
        if (inFrame === frameSamples) {
          out[frame++] = acc / inFrame;
          acc = 0;
          inFrame = 0;
        }
      }
      sample += got >> 1;
    }
    if (inFrame > 0 && frame < frames) out[frame++] = acc / inFrame;
    return frame === frames ? out : out.subarray(0, frame);
  } finally {
    closeSync(fd);
  }
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Choose chunk boundaries. While more than maxS seconds remain, cut at the lowest-energy frame
 * whose start lies in [start + minS, start + maxS] (the last one on a tie), at that frame's start.
 * The last chunk takes what is left. Returns [[startS, endS], ...] in seconds.
 */
export function planChunks(energies, { frameMs = 100, minS = 20, maxS = 30, totalS }) {
  const step = frameMs / 1000;
  const total = totalS ?? energies.length * step;
  if (!(total > 0)) return [];
  const chunks = [];
  let start = 0;
  while (total - start > maxS + 1e-9) {
    const lo = Math.ceil((start + minS) / step - 1e-9);
    const hi = Math.min(energies.length - 1, Math.floor((start + maxS) / step + 1e-9));
    let best = lo;
    // On a tie the later frame wins: flat audio is cut at max, giving the fewest cuts.
    for (let f = lo; f <= hi; f++) if (energies[f] <= energies[best]) best = f;
    const cut = round1(Math.min(best * step, start + maxS));
    if (!(cut > start)) break; // defensive: never loop without progress
    chunks.push([round1(start), cut]);
    start = cut;
  }
  chunks.push([round1(start), round1(total)]);
  return chunks;
}

/** A standalone 16-bit mono WAV of [startS, endS) of the file, read straight from disk. */
export function wavSpan(path, header, startS, endS) {
  const first = Math.max(0, Math.round(startS * header.sampleRate));
  const last = Math.min(header.dataBytes / 2, Math.round(endS * header.sampleRate));
  const bytes = Math.max(0, last - first) * 2;
  const out = Buffer.alloc(44 + bytes);
  writeHeader(out, header.sampleRate, bytes);
  if (bytes) {
    const fd = openSync(path, "r");
    try {
      readSync(fd, out, 44, bytes, header.dataOffset + first * 2);
    } finally {
      closeSync(fd);
    }
  }
  return out;
}

function writeHeader(buf, sampleRate, dataBytes) {
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
}

/** Encode Int16 samples as a 16-bit mono WAV Buffer. */
export function encodeWav(samples, sampleRate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  writeHeader(out, sampleRate, samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}
