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
 *
 * The two other exports serve take uploads: `wavHeader()` is the 44-byte frame a
 * take's staged chunks are streamed behind, and `decodeWav()` reads a PCM file
 * back as float channels (16- or 24-bit, plain or extensible) so a host can
 * load what it stored.
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
    at = writeSample(file, at, left[frame]);
    at = writeSample(file, at, right[frame]);
  }
  return file;
}

/**
 * Write one float as a 24-bit little-endian two's-complement integer.
 *
 * The bytes go straight into the file's `Uint8Array` (indexed assignment) rather
 * than through a `DataView`: that is one bounds check per byte instead of a
 * method call per byte, and there are six bytes in every frame of a render.
 *
 * @param {Uint8Array} bytes the file being built
 * @param {number} at byte offset to write at
 * @param {number} value a sample in [-1, 1]
 * @returns {number} the offset just past the sample
 */
function writeSample(bytes, at, value) {
  const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  let integer = Math.round(sample * FULL_SCALE);
  if (integer < 0) integer += 0x1000000; // 24-bit two's complement
  bytes[at] = integer & 0xff;
  bytes[at + 1] = (integer >> 8) & 0xff;
  bytes[at + 2] = (integer >> 16) & 0xff;
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

// --- Reading and framing ----------------------------------------------------

/** WAVE_FORMAT_PCM: uncompressed little-endian integers. */
const FORMAT_PCM = 1;

/** WAVE_FORMAT_EXTENSIBLE: a `fmt ` chunk whose real format is its sub-format. */
const FORMAT_EXTENSIBLE = 0xfffe;

/** The bit depths a Studio take may hold: 16-bit material, or 24-bit takes. */
const BITS = Object.freeze([16, 24]);

/** How many channels a take can have; more is a file Studio cannot play. */
const MAX_DECODE_CHANNELS = 8;

/** The format codes worth naming in a refusal. */
const FORMAT_NAMES = Object.freeze({
  [FORMAT_PCM]: "PCM",
  [FORMAT_EXTENSIBLE]: "extensible",
  3: "IEEE float",
  6: "A-law",
  7: "mu-law",
});

/**
 * The canonical 44-byte RIFF/WAVE header of a 24-bit PCM file.
 *
 * This is the framing half of `encodeWav24`: a take's WAV is uploaded as this
 * header followed by its staged chunk files, so the bytes are never assembled
 * into one buffer in the gateway.
 *
 * @param {number} frames how many frames the `data` chunk holds
 * @param {number} channels 1 or 2 (anything 1-255 is written faithfully)
 * @param {number} rate samples per second
 * @returns {Buffer} exactly 44 bytes
 * @throws {Error} when the counts are not whole (or the rate is not positive)
 */
export function wavHeader(frames, channels, rate) {
  const frameCount = Number(frames);
  const channelCount = Number(channels);
  const sampleRate = Math.round(Number(rate));
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new Error("wavHeader needs a whole, non-negative frame count");
  }
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 255) {
    throw new Error("wavHeader needs a whole channel count of 1 to 255");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("wavHeader needs a positive integer sample rate");
  }

  const blockAlign = channelCount * BYTES_PER_SAMPLE;
  const dataBytes = frameCount * blockAlign;
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, 4); // everything after this field
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // the PCM format chunk's own size
  header.writeUInt16LE(FORMAT_PCM, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Read a PCM WAV back as float channels in [-1, 1].
 *
 * Handles what a take can arrive as: 16-bit or 24-bit little-endian PCM,
 * either plain (`WAVE_FORMAT_PCM`) or wrapped in `WAVE_FORMAT_EXTENSIBLE`
 * with a PCM sub-format. Unknown chunks (`LIST`, `fact`, `bext`…) are skipped,
 * and no chunk other than `fmt ` and `data` is required.
 *
 * The full scale is 2^(bits-1) - 1, the same convention `encodeWav24` uses, so
 * encoding and decoding the same samples is exact.
 *
 * @param {Uint8Array|Buffer} bytes the whole file
 * @returns {{rate: number, channels: Float32Array[]}}
 * @throws {Error} naming the format code (or the bit depth) it cannot read
 */
export function decodeWav(bytes) {
  if (!bytes || typeof bytes.length !== "number") {
    throw new TypeError("decodeWav needs the file's bytes");
  }
  const offset = Number(bytes.byteOffset ?? 0);
  const length = Number(bytes.byteLength ?? bytes.length);
  const view = new DataView(bytes.buffer, offset, length);
  if (length < 12 || asciiAt(view, 0, 4) !== "RIFF" || asciiAt(view, 8, 4) !== "WAVE") {
    throw new Error("That is not a RIFF/WAVE file.");
  }

  let format = null;
  let data = null;
  let at = 12;
  while (at + 8 <= length) {
    const id = asciiAt(view, at, 4);
    const chunkSize = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = Math.min(length, start + chunkSize);
    if (id === "fmt ") format = readFormat(view, start, end - start);
    else if (id === "data") data = { start, end };
    // A chunk of an odd size is followed by one pad byte.
    at = start + chunkSize + (chunkSize % 2);
  }

  if (!format) throw new Error("That WAV has no format chunk, so Studio cannot read it.");
  if (!data) throw new Error("That WAV has no data chunk, so there is nothing to read.");

  const bytesPerSample = format.bits / 8;
  const blockAlign = format.channels * bytesPerSample;
  const frames = Math.floor((data.end - data.start) / blockAlign);
  const channels = [];
  for (let channel = 0; channel < format.channels; channel += 1) channels.push(new Float32Array(frames));

  const fullScale = Math.pow(2, format.bits - 1) - 1;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const sampleAt = data.start + frame * blockAlign + channel * bytesPerSample;
      const value = format.bits === 16 ? view.getInt16(sampleAt, true) : readInt24(view, sampleAt);
      channels[channel][frame] = value / fullScale;
    }
  }
  return { rate: format.rate, channels };
}

/**
 * Read the `fmt ` chunk's fields, refusing a format Studio cannot decode.
 * @param {DataView} view
 * @param {number} start the chunk's payload offset
 * @param {number} available how many payload bytes are there
 * @returns {{channels: number, rate: number, bits: number}}
 * @throws {Error} naming the format code or the bit depth
 */
function readFormat(view, start, available) {
  if (available < 16) throw new Error("That WAV's format chunk is too short to read.");
  const tag = view.getUint16(start, true);
  const channels = view.getUint16(start + 2, true);
  const rate = view.getUint32(start + 4, true);
  const bits = view.getUint16(start + 14, true);

  let code = tag;
  if (tag === FORMAT_EXTENSIBLE) {
    // The real format is the first 16 bits of the sub-format GUID, at byte 24.
    if (available < 40) throw new Error("That WAV's extensible format chunk is too short to read.");
    code = view.getUint16(start + 24, true);
  }
  if (code !== FORMAT_PCM) {
    const name = FORMAT_NAMES[code];
    throw new Error(
      `Unsupported WAV format code ${code}${name ? ` (${name})` : ""}; Studio reads 16-bit and 24-bit PCM.`,
    );
  }
  if (!BITS.includes(bits)) {
    throw new Error(`Unsupported WAV bit depth ${bits}; Studio reads 16-bit and 24-bit PCM.`);
  }
  if (channels < 1) throw new Error(`That WAV has ${channels} channels, so there is nothing to read.`);
  if (channels > MAX_DECODE_CHANNELS) {
    throw new Error(
      `That WAV has ${channels} channels; Studio reads up to ${MAX_DECODE_CHANNELS}, and a take has 1 or 2.`,
    );
  }
  if (rate <= 0) throw new Error(`That WAV's sample rate is ${rate}, and Studio needs a positive rate to place it.`);
  return { channels, rate, bits };
}

/**
 * Read four ASCII characters at one offset.
 * @param {DataView} view
 * @param {number} at
 * @param {number} count
 * @returns {string}
 */
function asciiAt(view, at, count) {
  let text = "";
  for (let index = 0; index < count; index += 1) text += String.fromCharCode(view.getUint8(at + index));
  return text;
}

/**
 * Read one 24-bit little-endian two's-complement sample, sign-extended.
 * @param {DataView} view
 * @param {number} at
 * @returns {number}
 */
function readInt24(view, at) {
  const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
  return value >= 0x800000 ? value - 0x1000000 : value;
}