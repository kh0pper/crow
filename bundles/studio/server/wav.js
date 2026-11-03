/**
 * 24-bit WAV encoding — the container a Studio render is stored in.
 *
 * One shape only: a canonical 44-byte RIFF/WAVE header, PCM (format 1), two
 * channels, 24-bit little-endian interleaved samples. That is what a browser
 * `<audio>` element, `ffmpeg` and every DAW read without being told anything,
 * and 24 bits keeps a hard-clipped Studio master above the noise floor of the
 * 16-bit default.
 *
 * Samples come in as floats in [-1, 1] (the engine's own range — its master
 * stage is a hard clip at ±1.0), are clamped back into it in case a caller
 * hands over something wider, and are scaled by 2^23 - 1 and rounded to the
 * nearest integer. Nothing here applies dither: the render is a measurement of
 * the engine, so the only thing this file may do is quantise it.
 *
 * No dependencies, no I/O: the caller decides where the bytes go.
 */

/** Bytes in one 24-bit sample. */
const BYTES_PER_SAMPLE = 3;

/** Channels every Studio render has. */
const CHANNELS = 2;

/** The canonical PCM RIFF header length. */
const HEADER_BYTES = 44;

/** 24-bit signed full scale, 2^23 - 1. */
const FULL_SCALE = 8388607;

/** One 24-bit frame's byte length (both channels). */
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;

/**
 * Encode two float channels as a 24-bit stereo WAV file.
 *
 * The two channels are read in lockstep and cut to the shorter of them, so a
 * caller that hands over mismatched arrays still gets a well-formed file.
 *
 * @param {Float32Array|Float64Array|number[]} left the left channel, -1..1
 * @param {Float32Array|Float64Array|number[]} right the right channel, -1..1
 * @param {number} sampleRate samples per second (48000 for every Studio render)
 * @returns {Uint8Array} the whole file: header followed by interleaved samples
 */
export function encodeWav24(left, right, sampleRate) {
  if (!left || !right || typeof left.length !== "number" || typeof right.length !== "number") {
    throw new TypeError("encodeWav24 needs two channels of samples");
  }
  const rate = Math.round(Number(sampleRate));
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("encodeWav24 needs a positive integer sample rate");
  }

  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * BLOCK_ALIGN;
  const file = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(file.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true); // everything after this field
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // the PCM format chunk's own size
  view.setUint16(20, 1, true); // format 1: PCM, uncompressed
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * BLOCK_ALIGN, true); // byte rate
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bits per sample

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let at = HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    at = writeSample(view, at, left[frame]);
    at = writeSample(view, at, right[frame]);
  }
  return file;
}

/**
 * Write one float as a 24-bit little-endian two's-complement integer.
 * @param {DataView} view
 * @param {number} at byte offset to write at
 * @param {number} value a sample in [-1, 1]
 * @returns {number} the offset just past the sample
 */
function writeSample(view, at, value) {
  const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  let integer = Math.round(sample * FULL_SCALE);
  if (integer < 0) integer += 0x1000000; // 24-bit two's complement
  view.setUint8(at, integer & 0xff);
  view.setUint8(at + 1, (integer >> 8) & 0xff);
  view.setUint8(at + 2, (integer >> 16) & 0xff);
  return at + BYTES_PER_SAMPLE;
}

/**
 * Write ASCII into a DataView (the RIFF chunk ids).
 * @param {DataView} view
 * @param {number} at
 * @param {string} text
 * @returns {void}
 */
function writeAscii(view, at, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(at + index, text.charCodeAt(index));
}