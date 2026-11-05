/**
 * A tiny but VALID SoundFont 3 (SF3) file, built here from a committed Ogg
 * Vorbis sample.
 *
 * An SF3 is an SF2 whose `smpl` chunk holds compressed (Ogg Vorbis) sample
 * bytes, whose sample header has bit 16 (`0x10`) set in its sample type, and
 * whose `dwStart`/`dwEnd` are BYTE offsets into the `smpl` chunk (an
 * uncompressed SF2 header holds sample points instead). The loop points of a
 * compressed sample are points relative to the decoded sample's start.
 *
 * The audio is `tests/fixtures/tiny-sine.ogg`: 0.25 s of 440 Hz mono at
 * 44.1 kHz, made with
 *
 *     ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.25" \
 *       -ac 1 -c:a libvorbis -q:a 2 -map_metadata -1 -fflags +bitexact \
 *       tests/fixtures/tiny-sine.ogg
 *
 * Nothing is generated at test time: the Ogg file is committed, and this
 * module only wraps it in the RIFF/pdta structure (the parts an SF3 shares with
 * SF2 come from `buildSoundFont` in `tiny-sf2.mjs`).
 */
import { readFileSync } from "node:fs";
import { buildSoundFont } from "./tiny-sf2.mjs";

/** The committed Ogg Vorbis sample, read once. */
const OGG_BYTES = new Uint8Array(readFileSync(new URL("./tiny-sine.ogg", import.meta.url)));

/** The sample rate the Ogg stream carries (the sine was made at 44.1 kHz). */
export const TINY_SF3_SAMPLE_RATE = 44100;

/**
 * The presets this bank carries. One preset, one sample: the engine test only
 * needs a real compressed sample it can watch decode at load.
 */
export const TINY_SF3_PRESETS = Object.freeze([{ name: "Sine 440", bank: 0, program: 0, freq: 440 }]);

/**
 * Walk the Ogg page headers and return the largest granule position: the exact
 * number of PCM sample points the stream decodes to. That is the loop end (in
 * points, relative to the sample start) an SF3 sample header has to carry.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function oggGranulePosition(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0;
  let granule = 0;
  while (position + 27 <= bytes.length) {
    // Every page starts with "OggS".
    if (bytes[position] !== 0x4f || bytes[position + 1] !== 0x67 || bytes[position + 2] !== 0x67 || bytes[position + 3] !== 0x53) break;
    const low = view.getUint32(position + 6, true);
    const high = view.getUint32(position + 10, true);
    // -1 (all bits set) marks a page that finishes no packet.
    if (!(low === 0xffffffff && high === 0xffffffff)) granule = high * 0x100000000 + low;
    const segments = bytes[position + 26];
    let payload = 0;
    for (let index = 0; index < segments; index += 1) payload += bytes[position + 27 + index];
    position += 27 + segments + payload;
  }
  return granule;
}

/** The decoded length of the committed Ogg sample, in points. */
export const TINY_SF3_DECODED_SAMPLES = oggGranulePosition(OGG_BYTES);

/** The decoded Float32 bytes one sample of this bank takes at load. */
export const TINY_SF3_DECODED_BYTES = TINY_SF3_DECODED_SAMPLES * 4;

/**
 * Build the whole SF3 bank.
 * @returns {Uint8Array} the file's bytes
 */
export function tinySf3() {
  return buildSoundFont({
    presets: TINY_SF3_PRESETS,
    version: [3, 0],
    samples: [
      {
        name: "Sine 440",
        // The Ogg stream itself: an SF3's `smpl` chunk is the compressed bytes.
        data: OGG_BYTES,
        // Compressed samples address their data in BYTES of the smpl chunk.
        start: 0,
        end: OGG_BYTES.length,
        // The loop is in points relative to the decoded sample's start.
        loopStart: 0,
        loopEnd: TINY_SF3_DECODED_SAMPLES,
        sampleRate: TINY_SF3_SAMPLE_RATE,
        compressed: true,
      },
    ],
  });
}