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
 * Every preset is one sine wave that loops seamlessly: each sample is EXACTLY
 * one whole number of cycles long (`freq * 2400 / 48000` is an integer for all
 * of them), so a held note is a clean, measurable tone and a test can tell one
 * preset's channel from another's by frequency alone. The tones are 80 Hz
 * apart, far enough that even a short window can separate two channels.
 *
 * | bank | program | tone |
 * |------|---------|------|
 * | 0    | 0       | 340 Hz |
 * | 0    | 1       | 420 Hz |
 * | 0    | 2..7    | 500, 580, 660, 740, 820, 900 Hz |
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
});

/** The frames in one sample's loop, and the sample's rate. */
const LOOP_FRAMES = 2400;
const SAMPLE_RATE = 48000;

/**
 * One sample is the loop plus one guard frame: the last frame repeats the
 * first, so a voice reading at the loop's end never runs off the data.
 */
const SAMPLE_FRAMES = LOOP_FRAMES + 1;

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
  { name: "Drum 220", bank: 128, program: 0, freq: 220 },
]);

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
 * One sine sample's 16-bit PCM: the loop plus its guard frame, at half scale so
 * eight tracks of it still sum well under full scale.
 * @param {number} freq Hz
 * @returns {Int16Array}
 */
function sineSample(freq) {
  const data = new Int16Array(SAMPLE_FRAMES);
  for (let frame = 0; frame < SAMPLE_FRAMES; frame += 1) {
    data[frame] = Math.round(Math.sin((2 * Math.PI * freq * frame) / SAMPLE_RATE) * 0.5 * 32767);
  }
  return data;
}

/**
 * Build the whole font.
 * @returns {Uint8Array} the SF2 file's bytes
 */
export function tinySf2() {
  const presets = TINY_SF2_PRESETS;

  // --- the sample data: every preset's loop, back to back, in points --------
  const points = [];
  const samples = [];
  for (let index = 0; index < presets.length; index += 1) {
    const start = points.length;
    const pcm = sineSample(presets[index].freq);
    for (const value of pcm) points.push(value);
    samples.push({ start: start, end: start + pcm.length });
  }
  const smpl = new Bytes();
  for (const point of points) smpl.u16(point & 0xffff);
  const smplChunk = chunk("smpl", smpl.bytes());

  // --- INFO: a version and a name, which is all an SF2 needs to exist ------
  const ifil = new Bytes().u16(2).u16(1);
  const info = list("INFO", [chunk("ifil", ifil.bytes()), chunk("INAM", new TextEncoder().encode("Tiny Test Font"))]);

  // --- pdta: one preset zone and one instrument zone per preset ------------
  // A zone is its generators followed by a terminal record (operator 0, amount
  // 0); the LAST zone of a chunk does not need one, because the parser drops the
  // chunk's final record. Every index below is a running count of records.
  const presetZones = [];
  const instrumentZones = [];
  for (let index = 0; index < presets.length; index += 1) {
    presetZones.push([{ op: GENERATOR.instrument, amount: index }, { op: 0, amount: 0 }]);
    instrumentZones.push([
      { op: GENERATOR.sampleID, amount: index },
      // Loop the sample for ever: a held note is a steady tone. (The rest of the
      // envelope is SF2's own default: an instant attack, full sustain and a 1 ms
      // release, so a note off leaves nothing behind.)
      { op: GENERATOR.sampleModes, amount: 1 },
      { op: 0, amount: 0 },
    ]);
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
      .name(presets[index].name)
      .u32(samples[index].start)
      .u32(samples[index].end)
      // The loop is the whole sample, minus its guard frame, in points.
      .u32(samples[index].start)
      .u32(samples[index].start + LOOP_FRAMES)
      .u32(SAMPLE_RATE)
      .u8(60)
      .u8(0)
      .u16(0)
      // 1 = a mono sample.
      .u16(1);
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