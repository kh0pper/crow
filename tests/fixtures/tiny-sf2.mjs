/**
 * A tiny but VALID SoundFont 2 file, built byte by byte here.
 *
 * The font engine's tests must not download anything, so the bank they play is
 * made in the test process. It is a real RIFF/SF2 file — `RIFF…sfbk`, a `sdta`
 * list with one `smpl` 16-bit PCM chunk, and a `pdta` list with the nine preset
 * chunks — laid out exactly as the format (and spessasynth's parser) says:
 *
 *     RIFF <size> sfbk
 *        LIST <size> INFO     ifil 2.1
 *        LIST <size> sdta     smpl <16-bit PCM, one sine loop per preset>
 *        LIST <size> pdta     phdr pbag pmod pgen inst ibag imod igen shdr
 *
 * Every preset is one sine wave that loops seamlessly: each sample's loop is
 * EXACTLY one whole number of cycles long (`freq * 2400 / 48000` is an integer
 * for all of them), so a held note is a clean, measurable tone and a test can
 * tell one preset's channel from another's by frequency alone. The tones are 80
 * Hz apart, far enough that even a short window can separate two channels. Every
 * sample ends with the 46 zero points SF2 asks for, and every zone ends with its
 * terminal generator record, so the file is a strictly valid SF2.
 *
 * | bank | program | tone |
 * |------|---------|------|
 * | 0    | 0       | 340 Hz |
 * | 0    | 1       | 420 Hz |
 * | 0    | 2..7    | 500, 580, 660, 740, 820, 900 Hz |
 * | 0    | 8       | 980 Hz, with a 4-second release |
 * | 128  | 0       | 220 Hz (the GM drum bank) |
 *
 * Bank 128 is the GM drum bank: a soundfont track that names it is played with
 * `setDrums`, so this preset is the one a drum track hears. All the samples are
 * declared at 48 kHz with root key 60, so a MIDI note 60 plays them 1:1.
 */

/** The generator operators the file uses (SF2 §8.1). */
const GENERATOR = Object.freeze({
  instrument: 41,
  sampleID: 53,
  sampleModes: 54,
  releaseVolEnv: 38,
});

/** The frames in one sample's loop, and the sample's rate. */
const LOOP_FRAMES = 2400;
const SAMPLE_RATE = 48000;

/**
 * The zero sample points every sample ends with. SF2 asks for the last 46 points
 * of a sample to be zero ("so that the sample data can be interpolated"), and a
 * strictly valid bank has them; they also mean a voice reading past the loop
 * end reads silence instead of the next sample's data.
 */
const ZERO_TAIL = 46;

/**
 * One sample is the loop plus its zero tail: the loop is exactly 2400 points and
 * the 46 points after it are silence.
 */
const SAMPLE_FRAMES = LOOP_FRAMES + ZERO_TAIL;

/** The presets this font carries, in file order, with the tone each one plays. */
export const TINY_SF2_PRESETS = Object.freeze([
  { name: "Sine 340", bank: 0, program: 0, freq: 340 },
  { name: "Sine 420", bank: 0, program: 1, freq: 420 },
  { name: "Sine 500", bank: 0, program: 2, freq: 500 },
  { name: "Sine 580", bank: 0, program: 3, freq: 580 },
  { name: "Sine 660", bank: 0, program: 4, freq: 660 },
  { name: "Sine 740", bank: 0, program: 5, freq: 740 },
  { name: "Sine 820", bank: 0, program: 6, freq: 820 },
  { name: "Sine 900", bank: 0, program: 7, freq: 900 },
  // A four-second release (2400 timecents), so a test can watch a released note
  // ring out instead of being cut.
  { name: "Sine 980 long", bank: 0, program: 8, freq: 980, release: 2400 },
  { name: "Drum 220", bank: 128, program: 0, freq: 220 },
]);

/**
 * The Float32 bytes the decoded samples of the whole font take: one `SAMPLE_FRAMES`
 * Float32 per preset. The font host counts this against its cap on top of the
 * file's own bytes, so the engine tests can name a cap in exactly those terms.
 */
export const TINY_SF2_DECODED_BYTES = TINY_SF2_PRESETS.length * SAMPLE_FRAMES * 4;

/** A little-endian byte builder: the whole file is one of these. */
class Bytes {
  constructor() {
    /** @type {number[]} */
    this.values = [];
  }

  /**
   * @param {number} value
   * @returns {this}
   */
  u8(value) {
    this.values.push(value & 0xff);
    return this;
  }

  /**
   * @param {number} value
   * @returns {this}
   */
  u16(value) {
    this.values.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  /**
   * @param {number} value
   * @returns {this}
   */
  u32(value) {
    this.values.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  /**
   * @param {string} text four ASCII characters
   * @returns {this}
   */
  fourcc(text) {
    for (let at = 0; at < 4; at += 1) this.values.push(text.charCodeAt(at) & 0x7f);
    return this;
  }

  /**
   * A 20-byte SF2 name: ASCII, NUL padded (19 characters at most, so the name
   * is always terminated).
   * @param {string} text
   * @returns {this}
   */
  name(text) {
    const bytes = Array.from(new TextEncoder().encode(text)).slice(0, 19);
    this.values.push(...bytes);
    while (bytes.length < 20) {
      this.values.push(0);
      bytes.push(0);
    }
    return this;
  }

  /**
   * @param {Uint8Array|number[]} bytes
   * @returns {this}
   */
  raw(bytes) {
    this.values.push(...bytes);
    return this;
  }

  /** @returns {Uint8Array} */
  bytes() {
    return Uint8Array.from(this.values);
  }
}

/**
 * A RIFF chunk: its four-character id, its size (which excludes the pad byte),
 * its data, and the pad byte that keeps the next chunk even.
 * @param {string} id
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function chunk(id, data) {
  const out = new Bytes();
  out.fourcc(id).u32(data.length).raw(data);
  if (data.length % 2 !== 0) out.u8(0);
  return out.bytes();
}

/**
 * A RIFF `LIST` chunk: its type comes first and IS counted in the size.
 * @param {string} type four ASCII characters
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function list(type, parts) {
  const data = new Bytes();
  data.fourcc(type);
  for (const part of parts) data.raw(part);
  return chunk("LIST", data.bytes());
}

/**
 * One sine sample's 16-bit PCM: the loop, then its zero tail (46 points, as SF2
 * asks for), at half scale so eight tracks of it still sum well under full
 * scale.
 * @param {number} freq Hz
 * @returns {Int16Array}
 */
function sineSample(freq) {
  const data = new Int16Array(SAMPLE_FRAMES);
  for (let frame = 0; frame < LOOP_FRAMES; frame += 1) {
    data[frame] = Math.round(Math.sin((2 * Math.PI * freq * frame) / SAMPLE_RATE) * 0.5 * 32767);
  }
  return data;
}

/**
 * Build the whole font.
 * @param {{presets?: ReadonlyArray<{name: string, bank: number, program: number,
 *   freq: number, release?: number}>}} [options] `presets` defaults to the
 *   font's own ten; an empty list builds a valid bank that carries NO preset,
 *   which the engine refuses
 * @returns {Uint8Array} the SF2 file's bytes
 */
export function tinySf2(options = {}) {
  const presets = Array.isArray(options.presets) ? options.presets : TINY_SF2_PRESETS;

  // --- the sample data: every preset's loop, back to back, in points --------
  const samples = [];
  let offsetPoints = 0;
  for (let index = 0; index < presets.length; index += 1) {
    const pcm = sineSample(presets[index].freq);
    const data = new Uint8Array(pcm.length * 2);
    const view = new DataView(data.buffer);
    for (let frame = 0; frame < pcm.length; frame += 1) view.setInt16(frame * 2, pcm[frame], true);
    samples.push({
      name: presets[index].name,
      data: data,
      // For an uncompressed sample the SF2 header holds POINTS (the parser
      // multiplies them by two to find the byte).
      start: offsetPoints,
      end: offsetPoints + pcm.length,
      loopStart: offsetPoints,
      loopEnd: offsetPoints + LOOP_FRAMES,
      sampleRate: SAMPLE_RATE,
      compressed: false,
    });
    offsetPoints += pcm.length;
  }
  return buildSoundFont({ presets: presets, samples: samples, version: [2, 1] });
}

/**
 * Lay a SoundFont file out around ready-made sample data. Shared by `tinySf2`
 * (16-bit PCM) and `tinySf3` (Ogg Vorbis, sample type bit 16 set): the two
 * differ only in the bytes in `smpl` and how the sample header names them.
 * @param {{presets: ReadonlyArray<object>, samples: ReadonlyArray<{
 *   name: string, data: Uint8Array, start: number, end: number,
 *   loopStart: number, loopEnd: number, sampleRate: number,
 *   compressed: boolean}>, version?: [number, number]}} [options]
 *   `start`/`end` are POINTS for an uncompressed sample and BYTES of the Ogg
 *   stream for a compressed one, exactly as SF2 / SF3 write them
 * @returns {Uint8Array} the file's bytes
 */
export function buildSoundFont(options = {}) {
  const presets = Array.isArray(options.presets) ? options.presets : [];
  const samples = Array.isArray(options.samples) ? options.samples : [];
  const version = Array.isArray(options.version) ? options.version : [2, 1];

  // --- the sample data: every sample's bytes, back to back ------------------
  const smpl = new Bytes();
  for (let index = 0; index < samples.length; index += 1) smpl.raw(samples[index].data);
  // A bank carries sample data even when it has nothing to play (a 46-point
  // silent "sample" nothing references), so the chunk is never empty.
  if (smpl.values.length === 0) for (let index = 0; index < ZERO_TAIL; index += 1) smpl.u16(0);
  const smplChunk = chunk("smpl", smpl.bytes());

  // --- INFO: a version, the sample engine and a name ---------------------
  // `isng` names the synthesis engine the bank was made for (SF2 requires it);
  // `INAM` is the bank's name.
  const ifil = new Bytes().u16(version[0]).u16(version[1]);
  const isng = new TextEncoder().encode("EMU8000");
  const info = list("INFO", [
    chunk("ifil", ifil.bytes()),
    chunk("isng", isng),
    chunk("INAM", new TextEncoder().encode("Tiny Test Font")),
  ]);

  // --- pdta: one preset zone and one instrument zone per preset ------------
  // Every zone is its generators followed by a terminal record (operator 0,
  // amount 0), which is where the spec puts it; the parser drops the LAST record
  // of a chunk (it is the terminal of the last zone), so the final zone needs no
  // special case. Every index below is a running count of records.
  const presetZones = [];
  const instrumentZones = [];
  for (let index = 0; index < presets.length; index += 1) {
    presetZones.push([{ op: GENERATOR.instrument, amount: index }, { op: 0, amount: 0 }]);
    const zone = [
      { op: GENERATOR.sampleID, amount: index },
      // Loop the sample for ever: a held note is a steady tone. (The rest of the
      // envelope is SF2's own default: an instant attack, full sustain and a 1 ms
      // release, so a note off leaves nothing behind — unless the preset names
      // its own release, as the long one does.)
      { op: GENERATOR.sampleModes, amount: 1 },
    ];
    if (Number(presets[index].release) > 0) {
      // releaseVolEnv, in timecents: 1200 per octave of seconds, so 2400 is 4 s.
      zone.push({ op: GENERATOR.releaseVolEnv, amount: Math.round(presets[index].release) });
    }
    // The zone's terminal record is last, as the spec lays a zone out.
    zone.push({ op: 0, amount: 0 });
    instrumentZones.push(zone);
  }
  const presetGenerators = [];
  const instrumentGenerators = [];
  for (const zone of presetZones) for (const generator of zone) presetGenerators.push(generator);
  for (const zone of instrumentZones) for (const generator of zone) instrumentGenerators.push(generator);
  // Each bag's record index at the start of its zone: a running count of the
  // records emitted above.
  const presetBags = [];
  const instrumentBags = [];
  let presetGenCursor = 0;
  let instrumentGenCursor = 0;
  for (let index = 0; index < presets.length; index += 1) {
    presetBags.push({ gen: presetGenCursor, mod: 0 });
    presetGenCursor += presetZones[index].length;
    instrumentBags.push({ gen: instrumentGenCursor, mod: 0 });
    instrumentGenCursor += instrumentZones[index].length;
  }

  const phdr = new Bytes();
  for (let index = 0; index < presets.length; index += 1) {
    phdr
      .name(presets[index].name)
      .u16(presets[index].program)
      // The bank word: 0-127 melodic, or 128 + the program's bank for the drums.
      .u16(presets[index].bank)
      .u16(index)
      .u32(0)
      .u32(0)
      .u32(0);
  }
  phdr.name("EOP").u16(0).u16(0).u16(presets.length).u32(0).u32(0).u32(0);

  const pbag = new Bytes();
  for (const bag of presetBags) pbag.u16(bag.gen).u16(bag.mod);
  pbag.u16(presetGenCursor).u16(0);

  const pmod = new Bytes().u16(0).u16(0).u16(0).u16(0).u16(0);

  const pgen = new Bytes();
  for (const generator of presetGenerators) pgen.u16(generator.op).u16(generator.amount & 0xffff);

  const inst = new Bytes();
  for (let index = 0; index < presets.length; index += 1) {
    inst.name(presets[index].name).u16(index);
  }
  inst.name("EOI").u16(presets.length);

  const ibag = new Bytes();
  for (const bag of instrumentBags) ibag.u16(bag.gen).u16(bag.mod);
  ibag.u16(instrumentGenCursor).u16(0);

  const imod = new Bytes().u16(0).u16(0).u16(0).u16(0).u16(0);

  const igen = new Bytes();
  for (const generator of instrumentGenerators) igen.u16(generator.op).u16(generator.amount & 0xffff);

  const shdr = new Bytes();
  for (let index = 0; index < samples.length; index += 1) {
    shdr
      .name(samples[index].name)
      .u32(samples[index].start)
      .u32(samples[index].end)
      // The loop, in points: for an uncompressed sample the absolute point, for
      // an SF3 sample the point relative to the decoded sample's start.
      .u32(samples[index].loopStart)
      .u32(samples[index].loopEnd)
      .u32(samples[index].sampleRate)
      .u8(60)
      .u8(0)
      .u16(0)
      // 1 = a mono sample; bit 16 (0x10) marks Ogg Vorbis data (SF3).
      .u16(samples[index].compressed ? 0x11 : 1);
  }
  shdr.name("EOS").u32(0).u32(0).u32(0).u32(0).u32(0).u8(0).u8(0).u16(0).u16(0);

  const pdta = list("pdta", [
    chunk("phdr", phdr.bytes()),
    chunk("pbag", pbag.bytes()),
    chunk("pmod", pmod.bytes()),
    chunk("pgen", pgen.bytes()),
    chunk("inst", inst.bytes()),
    chunk("ibag", ibag.bytes()),
    chunk("imod", imod.bytes()),
    chunk("igen", igen.bytes()),
    chunk("shdr", shdr.bytes()),
  ]);

  const body = new Bytes().fourcc("sfbk").raw(info).raw(list("sdta", [smplChunk])).raw(pdta);
  const file = new Bytes().fourcc("RIFF").u32(body.values.length).raw(body.bytes());
  return file.bytes();
}