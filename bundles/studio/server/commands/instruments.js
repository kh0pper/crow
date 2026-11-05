/**
 * The Studio 1d instrument commands: which font a soundfont track plays, and
 * which preset of it.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the panel's instrument picker, the MCP tools and the
 * shared history:
 *
 *   track.set_font  track.set_program
 *
 * Both write one field of the track's device — `device.font_id`, and
 * `device.bank` / `device.program` — so the font a track plays and the preset
 * it plays undo on their own (see doc.js `fieldPath`).
 *
 * The one rule both keep: a track that plays a font is a soundfont track, and
 * the two commands are the ONLY way its instrument changes. `track.add` makes
 * such a track (`kind: "soundfont"`, with an optional `font_id`), and
 * `track.set_device` / `track.set_param` refuse it, because swapping the device
 * would throw the font and the preset away at once.
 *
 * A program is shown the way musicians count: the GM program table below is
 * 1-based in every sentence, so program 0 is "program 1 (Acoustic Grand Piano)".
 * Bank 128 is the GM drum bank, and there a program names a drum kit: its
 * program 0 is "Standard kit".
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (an unknown track, a font that is not in the library, a program out
 * of range) leaves the document exactly as it was.
 */

import { z } from "zod";
import { defineCommand, StudioError } from "./registry.js";
import {
  GM_DRUM_BANK,
  MAX_SOUNDFONT_BANK,
  MAX_SOUNDFONT_PROGRAM,
  cloneJson,
  getLibraryFont,
  getTrack,
  isSoundfontTrack,
  objectRef,
  toPlain,
} from "../doc.js";

/**
 * The General MIDI program names, in program order (0-127). They are what the
 * plan shows beside a program number, and what the instrument picker labels a
 * bank's presets with until a parsed font says otherwise.
 * @type {Readonly<string[]>}
 */
export const GM_PROGRAMS = Object.freeze([
  "Acoustic Grand Piano",
  "Bright Acoustic Piano",
  "Electric Grand Piano",
  "Honky-tonk Piano",
  "Electric Piano 1",
  "Electric Piano 2",
  "Harpsichord",
  "Clavinet",
  "Celesta",
  "Glockenspiel",
  "Music Box",
  "Vibraphone",
  "Marimba",
  "Xylophone",
  "Tubular Bells",
  "Dulcimer",
  "Drawbar Organ",
  "Percussive Organ",
  "Rock Organ",
  "Church Organ",
  "Reed Organ",
  "Accordion",
  "Harmonica",
  "Tango Accordion",
  "Acoustic Guitar (nylon)",
  "Acoustic Guitar (steel)",
  "Electric Guitar (jazz)",
  "Electric Guitar (clean)",
  "Electric Guitar (muted)",
  "Overdriven Guitar",
  "Distortion Guitar",
  "Guitar Harmonics",
  "Acoustic Bass",
  "Electric Bass (finger)",
  "Electric Bass (pick)",
  "Fretless Bass",
  "Slap Bass 1",
  "Slap Bass 2",
  "Synth Bass 1",
  "Synth Bass 2",
  "Violin",
  "Viola",
  "Cello",
  "Contrabass",
  "Tremolo Strings",
  "Pizzicato Strings",
  "Orchestral Harp",
  "Timpani",
  "String Ensemble 1",
  "String Ensemble 2",
  "SynthStrings 1",
  "SynthStrings 2",
  "Choir Aahs",
  "Voice Oohs",
  "Synth Voice",
  "Orchestra Hit",
  "Trumpet",
  "Trombone",
  "Tuba",
  "Muted Trumpet",
  "French Horn",
  "Brass Section",
  "SynthBrass 1",
  "SynthBrass 2",
  "Soprano Sax",
  "Alto Sax",
  "Tenor Sax",
  "Baritone Sax",
  "Oboe",
  "English Horn",
  "Bassoon",
  "Clarinet",
  "Piccolo",
  "Flute",
  "Recorder",
  "Pan Flute",
  "Blown Bottle",
  "Shakuhachi",
  "Whistle",
  "Ocarina",
  "Lead 1 (square)",
  "Lead 2 (sawtooth)",
  "Lead 3 (calliope)",
  "Lead 4 (chiff)",
  "Lead 5 (charang)",
  "Lead 6 (voice)",
  "Lead 7 (fifths)",
  "Lead 8 (bass + lead)",
  "Pad 1 (new age)",
  "Pad 2 (warm)",
  "Pad 3 (polysynth)",
  "Pad 4 (choir)",
  "Pad 5 (bowed)",
  "Pad 6 (metallic)",
  "Pad 7 (halo)",
  "Pad 8 (sweep)",
  "FX 1 (rain)",
  "FX 2 (soundtrack)",
  "FX 3 (crystal)",
  "FX 4 (atmosphere)",
  "FX 5 (brightness)",
  "FX 6 (goblins)",
  "FX 7 (echoes)",
  "FX 8 (sci-fi)",
  "Sitar",
  "Banjo",
  "Shamisen",
  "Koto",
  "Kalimba",
  "Bag pipe",
  "Fiddle",
  "Shanai",
  "Tinkle Bell",
  "Agogo",
  "Steel Drums",
  "Woodblock",
  "Taiko Drum",
  "Melodic Tom",
  "Synth Drum",
  "Reverse Cymbal",
  "Guitar Fret Noise",
  "Breath Noise",
  "Seashore",
  "Bird Tweet",
  "Telephone Ring",
  "Helicopter",
  "Applause",
  "Gunshot",
]);

/**
 * The drum kits of the GM drum bank (bank 128), by the program number each kit
 * sits at. Program 0 is the standard kit; the gaps between the named kits are
 * left to a font's own kits, which the picker reads from the parsed font.
 * @type {Readonly<Object<string, string>>}
 */
export const GM_DRUM_KITS = Object.freeze({
  0: "Standard kit",
  8: "Room kit",
  16: "Power kit",
  24: "Electronic kit",
  25: "TR-808 kit",
  32: "Jazz kit",
  40: "Brush kit",
  48: "Orchestra kit",
  56: "SFX kit",
});

/** An id inside the song: 1-40 letters, digits, dashes or underscores. */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

/** The value a before/after entry carries when the field did not exist. */
const ABSENT = null;

/**
 * What one preset is called: a GM program's name, or — for a bank a font holds
 * beyond GM — nothing, which leaves the number to speak for itself.
 * @param {number} bank
 * @param {number} program
 * @returns {string|null}
 */
export function presetName(bank, program) {
  if (bank === GM_DRUM_BANK) return GM_DRUM_KITS[program] ?? null;
  if (!Number.isInteger(program) || program < 0 || program >= GM_PROGRAMS.length) return null;
  return GM_PROGRAMS[program];
}

/**
 * One preset in words, counted the way musicians count: "program 1 (Acoustic
 * Grand Piano)", or "drum kit 1 (Standard kit)" in the drum bank. A preset the
 * GM table does not name keeps its number and loses the parenthesis.
 * @param {number} bank
 * @param {number} program
 * @returns {string}
 */
export function presetLabel(bank, program) {
  const name = presetName(bank, program);
  if (bank === GM_DRUM_BANK) {
    return name === null ? `drum kit ${program + 1}` : `drum kit ${program + 1} (${name})`;
  }
  return name === null ? `program ${program + 1}` : `program ${program + 1} (${name})`;
}

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of a track. */
function trackRef(id) {
  return objectRef("track", id);
}

/** Refuse with an "invalid" message. */
function refuseInvalid(message) {
  throw new StudioError("invalid", message);
}

/** @returns {string} a track's name for a summary, or its id when unknown. */
function labelOfTrack(snap, id) {
  return snap.tracks.find((track) => track.id === id)?.name ?? id;
}

/** @returns {string} a library entry's name for a summary, or its id when unknown. */
function labelOfFont(snap, id) {
  return snap.library?.[id]?.name ?? id;
}

/** @returns {Y.Map<any>} the live track, or a "not_found" refusal. */
function requireTrack(doc, id) {
  const track = getTrack(doc, id);
  if (!track) throw new StudioError("not_found", `There is no track "${id}" in this song.`);
  return track;
}

/**
 * Refuse an instrument edit on a track that does not play a font, naming it: a
 * SunVox track's instrument is its module, and a sampler or audio track's is
 * its kit or its takes.
 * @param {Y.Map<any>} track
 * @returns {void}
 */
function requireSoundfontTrack(track) {
  if (isSoundfontTrack(track)) return;
  refuseInvalid(
    `Track "${track.get("name")}" does not play a font; only a soundfont track plays an instrument from the library.`,
  );
}

/** @returns {Y.Map<any>} the live font entry, or an "invalid" refusal naming the id. */
function requireFont(doc, id) {
  const entry = getLibraryFont(doc, id);
  if (!entry) {
    refuseInvalid(
      `The song's library has no font with id "${id}"; add the font to the library before a track plays it.`,
    );
  }
  return entry;
}

/** @returns {object} a track's device as plain JSON, never a live reference. */
function deviceOf(track) {
  const device = toPlain(track.get("device"));
  return device && typeof device === "object" ? device : { engine: "soundfont" };
}

defineCommand({
  id: "track.set_font",
  title: "Choose the instrument a soundfont track plays",
  schema: z
    .object({
      track_id: idSchema.describe("the soundfont track"),
      font_id: idSchema.describe("a font in the song's library"),
    })
    .strict(),
  summary(args, snap) {
    return `Set track "${labelOfTrack(snap, args.track_id)}" to the font "${labelOfFont(snap, args.font_id)}"`;
  },
  /**
   * Only the track: the write is one field of its own device, and the font's
   * entry stays exactly where it is. So neither a lock on the library entry nor
   * a lock on ANOTHER track that happens to play the same font says anything
   * about this edit — a font is shared, a track's instrument is its own.
   * Removing the font from the library is the edit that would leave this track
   * silent, and `library.remove` names every track that plays it (see `touches`
   * there).
   */
  touches(args) {
    return [trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    requireSoundfontTrack(track);
    requireFont(doc, args.font_id);
    const ref = trackRef(args.track_id);
    const device = deviceOf(track);
    const before = Object.hasOwn(device, "font_id") ? cloneJson(device.font_id ?? ABSENT) : ABSENT;
    track.set("device", { ...device, font_id: args.font_id });
    // Only `font_id` is written: the entry's name stays in the library, so two
    // tracks playing one font both follow a rename of it.
    return {
      before: { [fieldKey(ref, "device.font_id")]: before },
      after: { [fieldKey(ref, "device.font_id")]: args.font_id },
    };
  },
});

defineCommand({
  id: "track.set_program",
  title: "Choose the preset a soundfont track plays",
  schema: z
    .object({
      track_id: idSchema.describe("the soundfont track"),
      bank: z
        .number()
        .int()
        .min(0)
        .max(MAX_SOUNDFONT_BANK)
        .describe(`the bank, 0-${MAX_SOUNDFONT_BANK - 1}; ${GM_DRUM_BANK} is the GM drum bank`),
      program: z
        .number()
        .int()
        .min(0)
        .max(MAX_SOUNDFONT_PROGRAM)
        .describe(`the preset, 0-${MAX_SOUNDFONT_PROGRAM}; in the drum bank it names a kit`),
    })
    .strict(),
  summary(args, snap) {
    const bank = args.bank === 0 || args.bank === GM_DRUM_BANK ? "" : ` of bank ${args.bank}`;
    return `Set track "${labelOfTrack(snap, args.track_id)}" to ${presetLabel(args.bank, args.program)}${bank}`;
  },
  touches(args) {
    return [trackRef(args.track_id)];
  },
  /**
   * Bank and program are two fields of the device, recorded as two: a later
   * program change on the same bank undoes on its own. A program change never
   * changes the sound an agent may not change — the font stays put — so the
   * change is an ordinary edit for an agent (plan 1d, Global Constraints).
   */
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    requireSoundfontTrack(track);
    const ref = trackRef(args.track_id);
    const device = deviceOf(track);
    const beforeBank = Object.hasOwn(device, "bank") ? cloneJson(device.bank) : ABSENT;
    const beforeProgram = Object.hasOwn(device, "program") ? cloneJson(device.program) : ABSENT;
    track.set("device", { ...device, bank: args.bank, program: args.program });
    return {
      before: {
        [fieldKey(ref, "device.bank")]: beforeBank,
        [fieldKey(ref, "device.program")]: beforeProgram,
      },
      after: {
        [fieldKey(ref, "device.bank")]: args.bank,
        [fieldKey(ref, "device.program")]: args.program,
      },
    };
  },
});
