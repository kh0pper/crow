/**
 * The Studio 1c sampler commands: a sampler track's kit of banks and pads, the
 * samples and slices the pads play, and the patterns, steps, locks and chains
 * of a pattern clip.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the panel, the gateway's sample upload finish route, the
 * MCP tools and the shared history:
 *
 *   bank.add  bank.rename
 *   pad.set  pad.assign
 *   sample.add (internal)  sample.rename  slice.set
 *   pattern.add  pattern.rename  pattern.remove  pattern.set_length
 *   pattern.set_steps_beat  pattern.set_swing
 *   step.toggle  step.set  step.clear_locks
 *   chain.set  clip.add_pattern
 *
 * Every sampler object is its own small object with its own ref (see doc.js),
 * so one pad edit never rewrites the kit's device, and two edits to different
 * pads, different steps or different locks of one step undo independently.
 *
 * Two rules the rest of the sampler leans on:
 *   - `sample.add` is Studio's own: only the gateway's upload finish route
 *     issues it, so no caller outside the process decides where a sample's
 *     audio lives.
 *   - a pad's sample and its slice are checked against the song before they are
 *     written, so a pad never points at a sound that is not there.
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (a limit, an unknown pattern, a pad still playing a slice) leaves the
 * document exactly as it was.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { addLimitIssue, defineCommand, StudioError } from "./registry.js";
import {
  DEFAULT_STEP_BEATS,
  LIMITS,
  PAD_FILTER_TYPES,
  PAD_MODES,
  SAMPLE_ORIGINS,
  SAMPLE_RATES,
  STEP_BEATS_VALUES,
  bankEntries,
  bankKey,
  bankMap,
  cloneJson,
  clipEntries,
  clipMap,
  getBank,
  getClip,
  getPad,
  getPattern,
  getSample,
  getScene,
  getStep,
  getTrack,
  isPatternClip,
  isSamplerTrack,
  lengthBarsForSteps,
  newSamplerBank,
  objectMap,
  objectRef,
  padEntries,
  padKey,
  padMap,
  patternKey,
  patternMap,
  patternsForClip,
  sampleMap,
  sliceEntries,
  sliceKey,
  sliceMap,
  stepEntries,
  stepKey,
  stepMap,
  stepsForPattern,
  toPlain,
} from "../doc.js";

/** Names (banks, pads, samples, patterns) are 1-80 characters. */
const MAX_NAME = 80;

/**
 * The value a before/after entry carries when the object or field did not
 * exist. `null`, not `undefined`: a history entry is stored as JSON, which
 * drops `undefined` keys (see doc.js).
 */
const ABSENT = null;

/** An id inside the song: 1-40 letters, digits, dashes or underscores. */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

/**
 * A sample id: the UUID the recording or import client generated. It names one
 * sample for good and becomes part of its storage key, so it is validated here
 * and never taken from an arbitrary string.
 */
const sampleIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "a sample id is a UUID, like 6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70",
  );

const nameSchema = z.string().min(1).max(MAX_NAME);

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of a track. */
function trackRef(id) {
  return objectRef("track", id);
}

/** @returns {string} the ref of a clip. */
function clipRef(id) {
  return objectRef("clip", id);
}

/** @returns {string} the ref of a kit bank. */
function bankRef(trackId, bankId) {
  return objectRef("bank", bankKey(trackId, bankId));
}

/** @returns {string} the ref of one pad of one bank. */
function padRef(trackId, bankId, index) {
  return objectRef("pad", padKey(trackId, bankId, index));
}

/** @returns {string} the ref of one sample. */
function sampleRef(id) {
  return objectRef("sample", id);
}

/** @returns {string} the ref of one slice of one sample. */
function sliceRef(sampleId, sliceId) {
  return objectRef("slice", sliceKey(sampleId, sliceId));
}

/** @returns {string} the ref of one pattern of one clip. */
function patternRef(clipId, patternId) {
  return objectRef("pattern", patternKey(clipId, patternId));
}

/** @returns {string} the ref of one step of one pattern. */
function stepRef(clipId, patternId, at, bankId, index) {
  return objectRef("step", stepKey(clipId, patternId, at, bankId, index));
}

/** Refuse with a limit message that names the limit. */
function refuseLimit(message) {
  throw new StudioError("limit", message);
}

/** Refuse with an "invalid" message. */
function refuseInvalid(message) {
  throw new StudioError("invalid", message);
}

/** Refuse with a "not_found" message. */
function refuseMissing(message) {
  throw new StudioError("not_found", message);
}

/**
 * One field of a live object as a before/after value: deep-cloned JSON, or
 * `null` when the document does not hold it.
 * @param {Y.Map<any>|null} object
 * @param {string} field
 * @returns {any}
 */
function fieldValue(object, field) {
  const value = object?.get?.(field);
  return value === undefined ? ABSENT : cloneJson(toPlain(value));
}

/** @returns {string} the name of the bank (or pattern) at one place: A, B, C… */
function letterAt(order) {
  return String.fromCharCode(65 + (Number.isInteger(order) && order >= 0 ? order % 26 : 0));
}

/** @returns {number} how many banks a track's kit holds right now. */
function bankCount(doc, trackId) {
  return bankEntries(doc).filter(({ bank }) => bank.get("track_id") === trackId).length;
}

/** @returns {string} a track's name for a summary, or its id when unknown. */
function labelOfTrack(snap, id) {
  return snap.tracks.find((track) => track.id === id)?.name ?? id;
}

/** @returns {string} a clip's name for a summary, or its id when unknown. */
function labelOfClip(snap, id) {
  return snap.clips[id]?.name ?? id;
}

/** @returns {string} a bank's name for a summary, or its id when unknown. */
function labelOfBank(snap, trackId, bankId) {
  return snap.banks?.[bankKey(trackId, bankId)]?.name ?? bankId;
}

/** @returns {string} a pattern's name for a summary, or its id when unknown. */
function labelOfPattern(snap, clipId, patternId) {
  return snap.patterns?.[patternKey(clipId, patternId)]?.name ?? patternId;
}

/** @returns {string} a sample's name for a summary, or its id when unknown. */
function labelOfSample(snap, sampleId) {
  return snap.samples?.[sampleId]?.name ?? sampleId;
}

/** @returns {Y.Map<any>} the live sampler track, or a refusal. */
function requireSamplerTrack(doc, id) {
  const track = getTrack(doc, id);
  if (!track) refuseMissing(`There is no track "${id}" in this song.`);
  if (!isSamplerTrack(track)) {
    refuseInvalid(
      `Track "${track.get("name")}" is not a sampler track; only a sampler track holds banks of pads.`,
    );
  }
  return track;
}

/** @returns {Y.Map<any>} the live bank of that track, or a refusal. */
function requireBank(doc, trackId, bankId) {
  const bank = getBank(doc, trackId, bankId);
  if (!bank) refuseMissing(`There is no bank "${bankId}" on track "${trackId}" in this song.`);
  return bank;
}

/** @returns {Y.Map<any>} the live pad of that bank, or a refusal. */
function requirePad(doc, trackId, bankId, index) {
  const pad = getPad(doc, trackId, bankId, index);
  if (!pad) {
    refuseMissing(`There is no pad ${index + 1} in bank "${bankId}" of track "${trackId}" in this song.`);
  }
  return pad;
}

/** @returns {Y.Map<any>} the live pattern clip, or a refusal. */
function requirePatternClip(doc, id) {
  const clip = getClip(doc, id);
  if (!clip) refuseMissing(`There is no clip "${id}" in this song.`);
  if (!isPatternClip(clip)) {
    refuseInvalid(
      `Clip "${clip.get("name")}" holds notes rather than steps and patterns; pattern clips are made with clip.add_pattern.`,
    );
  }
  return clip;
}

/** @returns {Y.Map<any>} the live pattern of that clip, or a refusal. */
function requirePattern(doc, clipId, patternId) {
  const pattern = getPattern(doc, clipId, patternId);
  if (!pattern) {
    refuseMissing(`There is no pattern "${patternId}" on clip "${clipId}" in this song.`);
  }
  return pattern;
}

/** @returns {Y.Map<any>} the live sample, or a refusal. */
function requireSample(doc, id) {
  const sample = getSample(doc, id);
  if (!sample) refuseMissing(`There is no sample "${id}" in this song.`);
  return sample;
}

/** @returns {Y.Map<any>} the live step, or a refusal. */
function requireStep(doc, args) {
  const step = getStep(doc, args.clip_id, args.pattern_id, args.at, args.bank_id, args.index);
  if (!step) {
    refuseInvalid(
      `There is no step at position ${args.at} of pattern "${args.pattern_id}" for pad ${args.index + 1} of bank "${args.bank_id}"; add it with step.toggle first.`,
    );
  }
  return step;
}

/**
 * Refuse a step position outside a pattern's loop, naming the limit.
 * @param {number} at
 * @returns {void}
 */
function checkStepPosition(at) {
  if (at < LIMITS.stepPositions) return;
  refuseLimit(
    `A pattern holds at most ${LIMITS.stepPositions} step positions, numbered 0 to ${LIMITS.stepPositions - 1}; there is no step ${at}.`,
  );
}

/**
 * Refuse a clip whose step count would leave the limit, naming it.
 * @param {number} lengthSteps
 * @returns {void}
 */
function checkLengthSteps(lengthSteps) {
  if (lengthSteps <= LIMITS.stepPositions) return;
  refuseLimit(
    `A pattern holds at most ${LIMITS.stepPositions} step positions; ${lengthSteps} is more.`,
  );
}

/** @returns {string[]} the pattern ids of a clip, in the order they were added. */
function patternIdsOf(snap, clipId) {
  return Object.values(snap.patterns ?? {})
    .filter((pattern) => pattern.clip_id === clipId)
    .sort((a, b) => a.order - b.order)
    .map((pattern) => pattern.id);
}

/**
 * Refuse a step that names a pad its clip's track does not have.
 * @param {Y.Doc} doc
 * @param {Y.Map<any>} clip
 * @param {string} bankId
 * @param {number} index
 * @returns {void}
 */
function checkPadOnTrack(doc, clip, bankId, index) {
  if (getPad(doc, clip.get("track_id"), bankId, index)) return;
  refuseMissing(
    `Track "${clip.get("track_id")}" of clip "${clip.get("name")}" has no pad ${index + 1} in bank "${bankId}".`,
  );
}

/** The per-pad settings a step may lock, with each one's range. */
const lockFields = {
  pitch: z.number().int().min(-24).max(24).describe("semitones, -24 to +24"),
  gain_db: z.number().finite().min(-60).max(12).describe("level in dB, -60 to +12"),
  cutoff_hz: z.number().finite().min(20).max(20000).describe("the pad filter's cutoff, 20-20000 Hz"),
  resonance: z.number().finite().min(0).max(1).describe("the pad filter's resonance, 0-1"),
  decay_ms: z.number().finite().min(0).max(10000).describe("decay in ms, 0-10000"),
  release_ms: z.number().finite().min(0).max(10000).describe("release in ms, 0-10000"),
  pan: z.number().finite().min(-1).max(1).describe("pan, -1 left to +1 right"),
  reverse: z.boolean().describe("play the sound backwards"),
};

/** What one step overrides for its own voice: pad fields and their values. */
const locksSchema = z
  .object({
    pitch: lockFields.pitch.optional(),
    gain_db: lockFields.gain_db.optional(),
    cutoff_hz: lockFields.cutoff_hz.optional(),
    resonance: lockFields.resonance.optional(),
    decay_ms: lockFields.decay_ms.optional(),
    release_ms: lockFields.release_ms.optional(),
    pan: lockFields.pan.optional(),
    reverse: lockFields.reverse.optional(),
  })
  .strict()
  .describe(`the pad fields this one step overrides; at most ${LIMITS.locksPerStep}`);

/** The pad's own settings, the ones `pad.set` may change. */
const padFieldsSchema = z
  .object({
    name: nameSchema.optional().describe("what the pad is called"),
    mode: z.enum(PAD_MODES).optional().describe('"oneshot" plays to the end, "gate" releases at the step end'),
    pitch: lockFields.pitch.optional(),
    gain_db: lockFields.gain_db.optional(),
    pan: lockFields.pan.optional(),
    attack_ms: z.number().finite().min(0).max(10000).optional().describe("attack in ms, 0-10000"),
    decay_ms: lockFields.decay_ms.optional(),
    sustain: z.number().finite().min(0).max(1).optional().describe("sustain level, 0-1"),
    release_ms: lockFields.release_ms.optional(),
    filter: z
      .object({
        type: z.enum(PAD_FILTER_TYPES).describe('"off", "lp", "hp" or "bp"'),
        cutoff_hz: z.number().finite().min(20).max(20000).describe("cutoff in Hz, 20-20000"),
        resonance: z.number().finite().min(0).max(1).describe("resonance, 0-1"),
      })
      .strict()
      .optional()
      .describe("the pad's filter, all three fields together"),
    choke: z.number().int().min(0).max(8).optional().describe("choke group, 0 for none, 1-8"),
    reverse: z.boolean().optional(),
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, "pad.set needs at least one field to change")
  .describe("the pad fields to change, each one its own history field");

/** The sample the gateway's upload finish route hands `sample.add`. */
const sampleSchema = z
  .object({
    id: sampleIdSchema.describe("the sample's id, as the upload built it"),
    storage_key: z
      .string()
      .min(1)
      .max(512)
      .describe("where the sample's WAV lives in storage, as the gateway built it"),
    rate: z
      .number()
      .int()
      .refine((rate) => SAMPLE_RATES.includes(rate), {
        message: `a sample's rate is one of ${SAMPLE_RATES.join(", ")}`,
      })
      .describe("the sample rate it holds"),
    channels: z.number().int().min(1).max(2).describe("1 or 2 channels"),
    frames: z.number().int().min(1).describe("how many frames it holds"),
    name: nameSchema.describe("what the sample is called"),
    origin: z.enum(SAMPLE_ORIGINS).describe('"import", "record" or "resample"'),
    author_label: nameSchema.describe("who brought it in, as the panel names them"),
  })
  .strict()
  .superRefine((sample, ctx) => {
    if (sample.frames * sample.channels > LIMITS.sampleSamples) {
      addLimitIssue(
        ctx,
        `A sample can hold at most ${LIMITS.sampleSamples} samples (frames × channels); this one would hold ${sample.frames * sample.channels}.`,
      );
    }
  });

/** One slice of a sample: a range of its frames with an id of its own. */
const sliceSchema = z
  .object({
    id: idSchema.optional().describe("the slice's id; one is generated when omitted"),
    start_frame: z.number().int().min(0).describe("the frame it starts on, from 0"),
    end_frame: z.number().int().min(1).describe("the frame it ends on, not included"),
  })
  .strict();

/** @returns {object[]} every pad in the song, as plain objects. */
function padsPlain(doc) {
  return padEntries(doc).map(({ pad }) => toPlain(pad));
}

// --- Banks and pads ---------------------------------------------------------

defineCommand({
  id: "bank.add",
  title: "Add a bank of pads to a sampler track's kit",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("your id for the bank; one is generated when omitted"),
      track_id: idSchema.describe("the sampler track whose kit gains a bank"),
      name: nameSchema.optional().describe("the bank's name; the next letter of the kit when omitted"),
    })
    .strict(),
  summary(args, snap) {
    const order = Object.values(snap.banks ?? {}).filter((bank) => bank.track_id === args.track_id).length;
    const name = args.name ?? letterAt(order);
    return `Added bank "${name}" to track "${labelOfTrack(snap, args.track_id)}" (${LIMITS.padsPerBank} pads)`;
  },
  touches(args) {
    // The bank's pads are named by their index, so the refs a lock or focus
    // check sees are exactly the objects this step makes.
    const refs = [bankRef(args.track_id, args.id)];
    for (let index = 0; index < LIMITS.padsPerBank; index += 1) {
      refs.push(padRef(args.track_id, args.id, index));
    }
    refs.push(trackRef(args.track_id));
    return refs;
  },
  /**
   * A new bank arrives with its sixteen empty pads in the same step, so one
   * undo takes the bank and its pads back together.
   */
  apply(doc, args) {
    requireSamplerTrack(doc, args.track_id);
    if (getBank(doc, args.track_id, args.id)) {
      refuseInvalid(`A bank with id "${args.id}" already exists on that track.`);
    }
    const order = bankCount(doc, args.track_id);
    if (order >= LIMITS.banksPerKit) {
      refuseLimit(`A kit can have at most ${LIMITS.banksPerKit} banks.`);
    }
    const { bank, pads } = newSamplerBank(args.track_id, args.id, args.name ?? letterAt(order), order);
    bankMap(doc).set(bankKey(args.track_id, bank.id), objectMap(bank));
    const before = { [fieldKey(bankRef(args.track_id, bank.id), "*")]: ABSENT };
    const after = { [fieldKey(bankRef(args.track_id, bank.id), "*")]: cloneJson(bank) };
    const padsMap = padMap(doc);
    for (const pad of pads) {
      padsMap.set(padKey(pad.track_id, pad.bank_id, pad.index), objectMap(pad));
      const field = fieldKey(padRef(pad.track_id, pad.bank_id, pad.index), "*");
      before[field] = ABSENT;
      after[field] = cloneJson(pad);
    }
    return { before, after };
  },
});

defineCommand({
  id: "bank.rename",
  title: "Rename a bank of pads",
  schema: z
    .object({
      track_id: idSchema.describe("the track the bank belongs to"),
      bank_id: idSchema.describe("the bank to rename"),
      name: nameSchema.describe("what it is called now"),
    })
    .strict(),
  summary(args, snap) {
    return `Renamed bank "${labelOfBank(snap, args.track_id, args.bank_id)}" to "${args.name}"`;
  },
  touches(args) {
    return [bankRef(args.track_id, args.bank_id), trackRef(args.track_id)];
  },
  apply(doc, args) {
    requireSamplerTrack(doc, args.track_id);
    const bank = requireBank(doc, args.track_id, args.bank_id);
    const ref = bankRef(args.track_id, args.bank_id);
    const before = fieldValue(bank, "name");
    bank.set("name", args.name);
    return { before: { [fieldKey(ref, "name")]: before }, after: { [fieldKey(ref, "name")]: args.name } };
  },
});

defineCommand({
  id: "pad.set",
  title: "Change one pad's settings",
  schema: z
    .object({
      track_id: idSchema.describe("the sampler track"),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: z.number().int().min(0).max(LIMITS.padsPerBank - 1).describe("the pad, 0-15"),
      fields: padFieldsSchema,
    })
    .strict(),
  summary(args, snap) {
    return `Set ${Object.keys(args.fields).join(", ")} on pad ${args.index + 1} of bank "${labelOfBank(snap, args.track_id, args.bank_id)}"`;
  },
  touches(args) {
    return [padRef(args.track_id, args.bank_id, args.index), trackRef(args.track_id)];
  },
  /**
   * Each field is recorded under its own key, so two edits to different
   * settings of one pad — or to two different pads — undo independently.
   */
  apply(doc, args) {
    requireSamplerTrack(doc, args.track_id);
    requireBank(doc, args.track_id, args.bank_id);
    const pad = requirePad(doc, args.track_id, args.bank_id, args.index);
    const ref = padRef(args.track_id, args.bank_id, args.index);
    const before = {};
    const after = {};
    for (const [field, value] of Object.entries(args.fields)) {
      const current = fieldValue(pad, field);
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      before[fieldKey(ref, field)] = current;
      after[fieldKey(ref, field)] = cloneJson(value);
      pad.set(field, cloneJson(value));
    }
    return { before, after };
  },
});

defineCommand({
  id: "pad.assign",
  title: "Put a sample or one of its slices on a pad",
  schema: z
    .object({
      track_id: idSchema.describe("the sampler track"),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: z.number().int().min(0).max(LIMITS.padsPerBank - 1).describe("the pad, 0-15"),
      sample_id: sampleIdSchema.describe("the sample the pad plays"),
      slice_id: idSchema.optional().describe("one slice of that sample; the whole sample when omitted"),
    })
    .strict(),
  summary(args, snap) {
    const which = args.slice_id === undefined ? "sample" : "a slice of the sample";
    return `Put ${which} "${labelOfSample(snap, args.sample_id)}" on pad ${args.index + 1} of bank "${labelOfBank(snap, args.track_id, args.bank_id)}"`;
  },
  // The sample is read, not written: naming it here would make the lock check
  // treat every track that plays it as touched, so a shared sample could not be
  // put on an unlocked track's pad while a locked track also played it.
  touches(args) {
    return [
      padRef(args.track_id, args.bank_id, args.index),
      trackRef(args.track_id),
    ];
  },
  apply(doc, args) {
    requireSamplerTrack(doc, args.track_id);
    requireBank(doc, args.track_id, args.bank_id);
    const pad = requirePad(doc, args.track_id, args.bank_id, args.index);
    const sample = requireSample(doc, args.sample_id);
    const sliceId = args.slice_id ?? ABSENT;
    if (sliceId !== ABSENT) {
      const known = sliceEntries(doc).some(
        ({ slice }) => slice.get("sample_id") === args.sample_id && slice.get("id") === sliceId,
      );
      if (!known) refuseInvalid(`Sample "${sample.get("name")}" has no slice "${sliceId}".`);
    }

    const ref = padRef(args.track_id, args.bank_id, args.index);
    const before = {};
    const after = {};
    for (const [field, value] of [["sample_id", args.sample_id], ["slice_id", sliceId]]) {
      const current = fieldValue(pad, field);
      if (current === value) continue;
      before[fieldKey(ref, field)] = current;
      after[fieldKey(ref, field)] = value;
      pad.set(field, value);
    }
    return { before, after };
  },
});

// --- Samples and slices -----------------------------------------------------

defineCommand({
  id: "sample.add",
  // Only the gateway's sample upload finish route issues this, through the hub
  // with `internal: true`: a sample is audio in storage, and nobody outside
  // Studio decides where that lives.
  internal: true,
  title: "Add an uploaded sample to the song",
  schema: z
    .object({ sample: sampleSchema.describe("the sample the gateway finished uploading") })
    .strict(),
  summary(args) {
    return `Added the sample "${args.sample.name}"`;
  },
  touches(args) {
    return [sampleRef(args.sample.id)];
  },
  apply(doc, args) {
    if (getSample(doc, args.sample.id)) {
      refuseInvalid(`A sample with id "${args.sample.id}" already exists in this song.`);
    }
    const count = sampleEntriesCount(doc);
    if (count >= LIMITS.samplesPerSong) {
      refuseLimit(`A song can hold at most ${LIMITS.samplesPerSong} samples.`);
    }
    const sample = cloneJson(args.sample);
    sampleMap(doc).set(sample.id, objectMap(sample));
    const ref = sampleRef(sample.id);
    return { before: { [fieldKey(ref, "*")]: ABSENT }, after: { [fieldKey(ref, "*")]: cloneJson(sample) } };
  },
});

/** @returns {number} how many samples the song holds right now. */
function sampleEntriesCount(doc) {
  return Object.keys(toPlain(sampleMap(doc)) ?? {}).length;
}

/**
 * The tracks whose pads play one sample, as track refs a lock or focus check
 * has to see with the sample: an edit to a sound is a write to every track
 * that plays it.
 * @param {object} snap
 * @param {string} sampleId
 * @returns {string[]}
 */
function sampleTrackRefs(snap, sampleId) {
  const ids = new Set();
  for (const pad of Object.values(snap.pads ?? {})) {
    if (pad.sample_id === sampleId) ids.add(pad.track_id);
  }
  return [...ids].map((id) => trackRef(id));
}

defineCommand({
  id: "sample.rename",
  title: "Rename a sample",
  schema: z
    .object({
      sample_id: sampleIdSchema.describe("the sample to rename"),
      name: nameSchema.describe("what it is called now"),
    })
    .strict(),
  summary(args, snap) {
    return `Renamed the sample "${labelOfSample(snap, args.sample_id)}" to "${args.name}"`;
  },
  touches(args, snap) {
    return [sampleRef(args.sample_id), ...sampleTrackRefs(snap, args.sample_id)];
  },
  apply(doc, args) {
    const sample = requireSample(doc, args.sample_id);
    const ref = sampleRef(args.sample_id);
    const before = fieldValue(sample, "name");
    sample.set("name", args.name);
    return { before: { [fieldKey(ref, "name")]: before }, after: { [fieldKey(ref, "name")]: args.name } };
  },
});

defineCommand({
  id: "slice.set",
  title: "Replace the slices of a sample",
  schema: z
    .object({
      sample_id: sampleIdSchema.describe("the sample to chop"),
      slices: z
        .array(sliceSchema)
        .describe("the whole slice set, in order; it replaces the sample's slices"),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.slices.length > LIMITS.slicesPerSample) {
        addLimitIssue(
          ctx,
          `A sample can have at most ${LIMITS.slicesPerSample} slices; this set would have ${args.slices.length}.`,
        );
      }
    }),
  summary(args, snap) {
    const count = args.slices.length;
    const pieces = count === 1 ? "1 slice" : `${count} slices`;
    return `Chopped the sample "${labelOfSample(snap, args.sample_id)}" into ${pieces}`;
  },
  touches(args, snap) {
    // The slices this step writes come first (the ones it names and the ones
    // already there), then the sample they belong to.
    const refs = [];
    for (const slice of args.slices) {
      if (typeof slice.id === "string") refs.push(sliceRef(args.sample_id, slice.id));
    }
    for (const { id } of sliceEntriesPlain(snap, args.sample_id)) {
      refs.push(sliceRef(args.sample_id, id));
    }
    refs.push(sampleRef(args.sample_id));
    return refs;
  },
  /**
   * The set replaces what was there, slice by slice: a kept slice id whose
   * range moved is one whole-slice write, so two re-chops of different slices
   * stay apart in the history. A slice a pad still plays cannot be removed —
   * that would leave the pad pointing at nothing.
   */
  apply(doc, args) {
    const sample = requireSample(doc, args.sample_id);
    const frames = Number(sample.get("frames")) || 0;
    const existing = new Map();
    for (const { id, slice } of sliceEntriesPlainDoc(doc, args.sample_id)) existing.set(id, slice);

    const next = new Map();
    for (const [index, slice] of args.slices.entries()) {
      const which = `Slice ${index + 1}`;
      if (!(slice.start_frame < slice.end_frame)) {
        refuseInvalid(
          `${which} ends at frame ${slice.end_frame}, before it starts at ${slice.start_frame}.`,
        );
      }
      if (slice.end_frame > frames) {
        refuseInvalid(
          `${which} ends at frame ${slice.end_frame}, past the ${frames} frames of sample "${sample.get("name")}".`,
        );
      }
      const id = slice.id ?? randomUUID();
      if (next.has(id)) refuseInvalid(`${which} repeats the slice id "${id}"; a slice id names one slice.`);
      next.set(id, {
        id,
        sample_id: args.sample_id,
        start_frame: slice.start_frame,
        end_frame: slice.end_frame,
      });
    }

    for (const pad of padsPlain(doc)) {
      if (pad.sample_id !== args.sample_id) continue;
      if (typeof pad.slice_id !== "string") continue;
      if (next.has(pad.slice_id)) continue;
      refuseInvalid(
        `Pad ${pad.index + 1} of bank "${pad.bank_id}" still plays slice "${pad.slice_id}" of this sample; clear that pad before removing the slice.`,
      );
    }

    const slices = sliceChanges(next, existing);
    const before = {};
    const after = {};
    if (Object.keys(slices.removed).length + Object.keys(slices.written).length > 0) {
      const map = sliceMap(doc);
      for (const [id, slice] of Object.entries(slices.removed)) {
        before[fieldKey(sliceRef(args.sample_id, id), "*")] = slice;
        after[fieldKey(sliceRef(args.sample_id, id), "*")] = ABSENT;
        map.delete(sliceKey(args.sample_id, id));
      }
      for (const [id, slice] of Object.entries(slices.written)) {
        const was = existing.get(id);
        const field = fieldKey(sliceRef(args.sample_id, id), "*");
        before[field] = was ? cloneJson(was) : ABSENT;
        after[field] = cloneJson(slice);
        map.set(sliceKey(args.sample_id, id), objectMap(slice));
      }
    }
    return { before, after };
  },
});

/**
 * The slices a `slice.set` removes and the ones it writes: the ids that are
 * gone from the new set, and the ids whose range moved or that are new.
 * @param {Map<string, object>} next - the new slice set
 * @param {Map<string, object>} existing - the slices there now
 * @returns {{removed: Object<string, object>, written: Object<string, object>}}
 */
function sliceChanges(next, existing) {
  const removed = {};
  const written = {};
  for (const [id, slice] of existing) {
    if (!next.has(id)) removed[id] = cloneJson(slice);
  }
  for (const [id, slice] of next) {
    const was = existing.get(id);
    if (was && was.start_frame === slice.start_frame && was.end_frame === slice.end_frame) continue;
    written[id] = slice;
  }
  return { removed, written };
}

/** @returns {Array<{id: string, slice: object}>} a sample's slices, plain, from a snapshot. */
function sliceEntriesPlain(snap, sampleId) {
  const out = [];
  for (const [key, slice] of Object.entries(snap.slices ?? {})) {
    if (slice.sample_id !== sampleId) continue;
    out.push({ id: slice.id ?? key, slice });
  }
  return out;
}

/** @returns {Array<{id: string, slice: object}>} a sample's slices, plain, from the document. */
function sliceEntriesPlainDoc(doc, sampleId) {
  const out = [];
  for (const { slice } of sliceEntries(doc)) {
    if (slice.get("sample_id") !== sampleId) continue;
    out.push({ id: slice.get("id"), slice: toPlain(slice) });
  }
  return out;
}

// --- Patterns ---------------------------------------------------------------

defineCommand({
  id: "pattern.add",
  title: "Add a pattern to a pattern clip",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("your id for the pattern; one is generated when omitted"),
      clip_id: idSchema.describe("the pattern clip"),
      name: nameSchema.optional().describe("the pattern's name; the next letter when omitted"),
    })
    .strict(),
  summary(args, snap) {
    const order = patternIdsOf(snap, args.clip_id).length;
    const name = args.name ?? letterAt(order);
    return `Added pattern "${name}" to clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args) {
    return [patternRef(args.clip_id, args.id), clipRef(args.clip_id)];
  },
  apply(doc, args) {
    requirePatternClip(doc, args.clip_id);
    if (getPattern(doc, args.clip_id, args.id)) {
      refuseInvalid(`A pattern with id "${args.id}" already exists on that clip.`);
    }
    const existing = patternsForClip(doc, args.clip_id);
    if (existing.length >= LIMITS.patternsPerClip) {
      refuseLimit(`A pattern clip can hold at most ${LIMITS.patternsPerClip} patterns.`);
    }
    const pattern = {
      id: args.id,
      clip_id: args.clip_id,
      name: args.name ?? letterAt(existing.length),
      order: existing.length,
    };
    patternMap(doc).set(patternKey(args.clip_id, pattern.id), objectMap(pattern));
    const ref = patternRef(args.clip_id, pattern.id);
    return { before: { [fieldKey(ref, "*")]: ABSENT }, after: { [fieldKey(ref, "*")]: cloneJson(pattern) } };
  },
});

defineCommand({
  id: "pattern.rename",
  title: "Rename a pattern",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      pattern_id: idSchema.describe("the pattern to rename"),
      name: nameSchema.describe("what it is called now"),
    })
    .strict(),
  summary(args, snap) {
    return `Renamed pattern "${labelOfPattern(snap, args.clip_id, args.pattern_id)}" to "${args.name}"`;
  },
  touches(args) {
    return [patternRef(args.clip_id, args.pattern_id), clipRef(args.clip_id)];
  },
  apply(doc, args) {
    requirePatternClip(doc, args.clip_id);
    const pattern = requirePattern(doc, args.clip_id, args.pattern_id);
    const ref = patternRef(args.clip_id, args.pattern_id);
    const before = fieldValue(pattern, "name");
    pattern.set("name", args.name);
    return { before: { [fieldKey(ref, "name")]: before }, after: { [fieldKey(ref, "name")]: args.name } };
  },
});

defineCommand({
  id: "pattern.remove",
  title: "Remove a pattern and its steps",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      pattern_id: idSchema.describe("the pattern to remove"),
    })
    .strict(),
  summary(args, snap) {
    return `Removed pattern "${labelOfPattern(snap, args.clip_id, args.pattern_id)}" from clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args, snap) {
    const refs = [patternRef(args.clip_id, args.pattern_id), clipRef(args.clip_id)];
    for (const step of Object.values(snap.steps ?? {})) {
      if (step.clip_id !== args.clip_id || step.pattern_id !== args.pattern_id) continue;
      refs.push(stepRef(step.clip_id, step.pattern_id, step.at, step.bank_id, step.index));
    }
    return refs;
  },
  /**
   * Its steps go with it, and so does its place in the clip's chain: a chain
   * cannot name a pattern that is gone. Both come back in the same undo.
   */
  apply(doc, args) {
    const clip = requirePatternClip(doc, args.clip_id);
    const pattern = requirePattern(doc, args.clip_id, args.pattern_id);
    if (patternsForClip(doc, args.clip_id).length <= 1) {
      refuseInvalid(
        `Clip "${clip.get("name")}" has one pattern; a pattern clip keeps at least one, so remove the clip instead.`,
      );
    }

    const ref = patternRef(args.clip_id, args.pattern_id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(pattern)) };
    const after = { [fieldKey(ref, "*")]: ABSENT };
    const doomed = stepsForPattern(doc, args.clip_id, args.pattern_id);
    if (doomed.length > 0) {
      const steps = stepMap(doc);
      for (const { id, step } of doomed) {
        const stepField = fieldKey(
          stepRef(args.clip_id, args.pattern_id, step.get("at"), step.get("bank_id"), step.get("index")),
          "*",
        );
        before[stepField] = cloneJson(toPlain(step));
        after[stepField] = ABSENT;
        steps.delete(id);
      }
    }
    patternMap(doc).delete(patternKey(args.clip_id, args.pattern_id));

    const chain = toPlain(clip.get("chain"));
    if (Array.isArray(chain) && chain.includes(args.pattern_id)) {
      const next = chain.filter((entry) => entry !== args.pattern_id);
      const clipField = fieldKey(clipRef(args.clip_id), "chain");
      before[clipField] = cloneJson(chain);
      after[clipField] = cloneJson(next);
      clip.set("chain", cloneJson(next));
    }
    return { before, after };
  },
});

defineCommand({
  id: "pattern.set_length",
  title: "Set how many step positions a pattern clip's loop has",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      length_steps: z
        .number()
        .int()
        .min(1)
        .describe(`the loop's step positions, 1-${LIMITS.stepPositions}`),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.length_steps > LIMITS.stepPositions) {
        addLimitIssue(
          ctx,
          `A pattern holds at most ${LIMITS.stepPositions} step positions; ${args.length_steps} is more.`,
        );
      }
    }),
  summary(args, snap) {
    return `Set clip "${labelOfClip(snap, args.clip_id)}" to ${args.length_steps} step positions`;
  },
  touches(args, snap) {
    const refs = [clipRef(args.clip_id)];
    for (const step of Object.values(snap.steps ?? {})) {
      if (step.clip_id !== args.clip_id || step.at < args.length_steps) continue;
      refs.push(stepRef(step.clip_id, step.pattern_id, step.at, step.bank_id, step.index));
    }
    return refs;
  },
  /**
   * A shorter loop drops the steps at or past its new end: they could not play,
   * and leaving them behind would break the rule that a step sits inside its
   * pattern. They are captured, so one undo brings them back with the length.
   */
  apply(doc, args) {
    const clip = requirePatternClip(doc, args.clip_id);
    checkLengthSteps(args.length_steps);
    const ref = clipRef(args.clip_id);
    const before = { [fieldKey(ref, "length_steps")]: fieldValue(clip, "length_steps") };
    const after = { [fieldKey(ref, "length_steps")]: args.length_steps };
    clip.set("length_steps", args.length_steps);

    const steps = stepMap(doc);
    for (const { id, step } of stepsOfClip(doc, args.clip_id)) {
      if (step.at < args.length_steps) continue;
      const field = fieldKey(stepRef(args.clip_id, step.pattern_id, step.at, step.bank_id, step.index), "*");
      before[field] = cloneJson(step);
      after[field] = ABSENT;
      steps.delete(id);
    }

    const bars = lengthBarsForSteps(args.length_steps, Number(clip.get("step_beats")) || DEFAULT_STEP_BEATS);
    if (bars !== fieldValue(clip, "length_bars")) {
      before[fieldKey(ref, "length_bars")] = fieldValue(clip, "length_bars");
      after[fieldKey(ref, "length_bars")] = bars;
      clip.set("length_bars", bars);
    }
    return { before, after };
  },
});

/** @returns {Array<{id: string, step: object}>} every step of one clip, plain. */
function stepsOfClip(doc, clipId) {
  const out = [];
  for (const { id, step } of stepEntries(doc)) {
    const plain = toPlain(step);
    if (!plain || plain.clip_id !== clipId) continue;
    out.push({ id, step: plain });
  }
  return out;
}

defineCommand({
  id: "pattern.set_steps_beat",
  title: "Set the step length of a pattern clip",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      step_beats: z
        .number()
        .finite()
        .refine((value) => STEP_BEATS_VALUES.includes(value), {
          message: `a step is one of ${STEP_BEATS_VALUES.join(", ")} beats`,
        })
        .describe(`the step length in beats: ${STEP_BEATS_VALUES.join(", ")}`),
    })
    .strict(),
  summary(args, snap) {
    return `Set clip "${labelOfClip(snap, args.clip_id)}" to ${args.step_beats}-beat steps`;
  },
  touches(args) {
    return [clipRef(args.clip_id)];
  },
  apply(doc, args) {
    const clip = requirePatternClip(doc, args.clip_id);
    const ref = clipRef(args.clip_id);
    const before = { [fieldKey(ref, "step_beats")]: fieldValue(clip, "step_beats") };
    const after = { [fieldKey(ref, "step_beats")]: args.step_beats };
    clip.set("step_beats", args.step_beats);
    // The loop is measured in bars everywhere else, so the derived length moves
    // with the step in the same step.
    const bars = lengthBarsForSteps(Number(clip.get("length_steps")) || 1, args.step_beats);
    if (bars !== fieldValue(clip, "length_bars")) {
      before[fieldKey(ref, "length_bars")] = fieldValue(clip, "length_bars");
      after[fieldKey(ref, "length_bars")] = bars;
      clip.set("length_bars", bars);
    }
    return { before, after };
  },
});

defineCommand({
  id: "pattern.set_swing",
  title: "Set how much a pattern clip swings",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      swing: z.number().finite().min(0).max(0.75).describe("swing, 0 (straight) to 0.75"),
    })
    .strict(),
  summary(args, snap) {
    return `Set clip "${labelOfClip(snap, args.clip_id)}" to swing ${args.swing}`;
  },
  touches(args) {
    return [clipRef(args.clip_id)];
  },
  apply(doc, args) {
    const clip = requirePatternClip(doc, args.clip_id);
    const ref = clipRef(args.clip_id);
    const before = fieldValue(clip, "swing");
    clip.set("swing", args.swing);
    return { before: { [fieldKey(ref, "swing")]: before }, after: { [fieldKey(ref, "swing")]: args.swing } };
  },
});

// --- Steps and locks --------------------------------------------------------

defineCommand({
  id: "step.toggle",
  title: "Put a step on a pattern, or take it off",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      pattern_id: idSchema.describe("the pattern"),
      at: z.number().int().min(0).describe(`the step position, 0-${LIMITS.stepPositions - 1}`),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: z.number().int().min(0).max(LIMITS.padsPerBank - 1).describe("the pad, 0-15"),
      v: z.number().int().min(1).max(127).optional().describe("velocity, 1-127; 100 when omitted"),
    })
    .strict(),
  summary(args, snap) {
    const has = Boolean(
      snap.steps?.[stepKey(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index)],
    );
    return `${has ? "Took the step off" : "Put a step on"} pattern "${labelOfPattern(snap, args.clip_id, args.pattern_id)}" at position ${args.at}`;
  },
  touches(args) {
    return [
      stepRef(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index),
      patternRef(args.clip_id, args.pattern_id),
      clipRef(args.clip_id),
    ];
  },
  apply(doc, args) {
    const clip = requirePatternClip(doc, args.clip_id);
    requirePattern(doc, args.clip_id, args.pattern_id);
    checkStepPosition(args.at);
    checkPadOnTrack(doc, clip, args.bank_id, args.index);

    const key = stepKey(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index);
    const ref = stepRef(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index);
    const existing = getStep(doc, args.clip_id, args.pattern_id, args.at, args.bank_id, args.index);
    if (existing) {
      const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(existing)) };
      stepMap(doc).delete(key);
      return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
    }

    if (stepsForPattern(doc, args.clip_id, args.pattern_id).length >= LIMITS.stepEntriesPerPattern) {
      refuseLimit(`A pattern can hold at most ${LIMITS.stepEntriesPerPattern} steps.`);
    }
    const step = {
      clip_id: args.clip_id,
      pattern_id: args.pattern_id,
      at: args.at,
      bank_id: args.bank_id,
      index: args.index,
      v: args.v ?? 100,
      locks: {},
    };
    stepMap(doc).set(key, objectMap(step));
    return { before: { [fieldKey(ref, "*")]: ABSENT }, after: { [fieldKey(ref, "*")]: cloneJson(step) } };
  },
});

defineCommand({
  id: "step.set",
  title: "Set a step's velocity or its parameter locks",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      pattern_id: idSchema.describe("the pattern"),
      at: z.number().int().min(0).describe("the step position"),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: z.number().int().min(0).max(LIMITS.padsPerBank - 1).describe("the pad, 0-15"),
      v: z.number().int().min(1).max(127).optional().describe("velocity, 1-127"),
      locks: locksSchema.optional().describe("the locks to set; they merge into the step's own"),
    })
    .strict()
    .refine(
      (args) => args.v !== undefined || args.locks !== undefined,
      "step.set needs at least one of v or locks",
    ),
  summary(args, snap) {
    const parts = [];
    if (args.v !== undefined) parts.push(`velocity ${args.v}`);
    if (args.locks !== undefined) parts.push(`${Object.keys(args.locks).length} lock(s)`);
    return `Set ${parts.join(" and ")} on position ${args.at} of pattern "${labelOfPattern(snap, args.clip_id, args.pattern_id)}"`;
  },
  touches(args) {
    return [
      stepRef(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index),
      patternRef(args.clip_id, args.pattern_id),
      clipRef(args.clip_id),
    ];
  },
  /**
   * Each lock is recorded under its own `locks.<name>` key, so a step's new
   * cutoff and an older velocity edit never conflict over the step, and two
   * different steps are two different objects altogether.
   */
  apply(doc, args) {
    requirePatternClip(doc, args.clip_id);
    requirePattern(doc, args.clip_id, args.pattern_id);
    const step = requireStep(doc, args);
    const ref = stepRef(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index);

    // Everything is worked out and checked before the first write, so a refusal
    // (a step over its lock limit) leaves the step exactly as it was.
    const beforeLocks = toPlain(step.get("locks")) ?? {};
    const nextLocks = { ...beforeLocks };
    const lockChanges = {};
    for (const [name, value] of Object.entries(args.locks ?? {})) {
      if (nextLocks[name] === value) continue;
      lockChanges[name] = Object.hasOwn(nextLocks, name) ? cloneJson(nextLocks[name]) : ABSENT;
      nextLocks[name] = value;
    }
    if (Object.keys(nextLocks).length > LIMITS.locksPerStep) {
      refuseLimit(`A step can carry at most ${LIMITS.locksPerStep} locks.`);
    }

    const before = {};
    const after = {};
    if (args.v !== undefined) {
      const current = fieldValue(step, "v");
      if (current !== args.v) {
        before[fieldKey(ref, "v")] = current;
        after[fieldKey(ref, "v")] = args.v;
        step.set("v", args.v);
      }
    }
    if (Object.keys(lockChanges).length > 0) {
      for (const [name, current] of Object.entries(lockChanges)) {
        before[fieldKey(ref, `locks.${name}`)] = current;
        after[fieldKey(ref, `locks.${name}`)] = cloneJson(args.locks[name]);
      }
      step.set("locks", cloneJson(nextLocks));
    }
    return { before, after };
  },
});

defineCommand({
  id: "step.clear_locks",
  title: "Clear a step's parameter locks",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      pattern_id: idSchema.describe("the pattern"),
      at: z.number().int().min(0).describe("the step position"),
      bank_id: idSchema.describe("the bank the pad sits in"),
      index: z.number().int().min(0).max(LIMITS.padsPerBank - 1).describe("the pad, 0-15"),
    })
    .strict(),
  summary(args, snap) {
    return `Cleared the locks on position ${args.at} of pattern "${labelOfPattern(snap, args.clip_id, args.pattern_id)}"`;
  },
  touches(args) {
    return [
      stepRef(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index),
      patternRef(args.clip_id, args.pattern_id),
      clipRef(args.clip_id),
    ];
  },
  apply(doc, args) {
    requirePatternClip(doc, args.clip_id);
    requirePattern(doc, args.clip_id, args.pattern_id);
    const step = requireStep(doc, args);
    const ref = stepRef(args.clip_id, args.pattern_id, args.at, args.bank_id, args.index);
    const locks = toPlain(step.get("locks")) ?? {};
    const before = {};
    const after = {};
    for (const [name, value] of Object.entries(locks)) {
      before[fieldKey(ref, `locks.${name}`)] = cloneJson(value);
      after[fieldKey(ref, `locks.${name}`)] = ABSENT;
    }
    if (Object.keys(before).length > 0) step.set("locks", {});
    return { before, after };
  },
});

// --- Chains and pattern clips -----------------------------------------------

defineCommand({
  id: "chain.set",
  title: "Set the order a pattern clip's chain plays",
  schema: z
    .object({
      clip_id: idSchema.describe("the pattern clip"),
      chain: z
        .array(idSchema)
        .describe(`the pattern ids to play in order, then loop; at most ${LIMITS.chainLength}`),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.chain.length > LIMITS.chainLength) {
        addLimitIssue(
          ctx,
          `A chain is at most ${LIMITS.chainLength} entries long; this one would have ${args.chain.length}.`,
        );
      }
    }),
  summary(args, snap) {
    const count = args.chain.length;
    return count === 0
      ? `Cleared the chain of clip "${labelOfClip(snap, args.clip_id)}"`
      : `Chained ${count} pattern(s) on clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args) {
    const refs = [clipRef(args.clip_id)];
    for (const id of args.chain) refs.push(patternRef(args.clip_id, id));
    return refs;
  },
  apply(doc, args) {
    const clip = requirePatternClip(doc, args.clip_id);
    for (const id of args.chain) {
      if (getPattern(doc, args.clip_id, id)) continue;
      refuseInvalid(
        `Clip "${clip.get("name")}" has no pattern "${id}"; a chain plays patterns of its own clip.`,
      );
    }
    const ref = clipRef(args.clip_id);
    const before = fieldValue(clip, "chain");
    clip.set("chain", cloneJson(args.chain));
    return {
      before: { [fieldKey(ref, "chain")]: before },
      after: { [fieldKey(ref, "chain")]: cloneJson(args.chain) },
    };
  },
});

defineCommand({
  id: "clip.add_pattern",
  title: "Add a pattern clip to a sampler track",
  idField: "clip_id",
  schema: z
    .object({
      clip_id: idSchema.optional().describe("your id for the clip; one is generated when omitted"),
      track_id: idSchema.describe("the sampler track it plays on"),
      scene_id: idSchema.describe("the scene it sits in"),
      length_steps: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`the loop's step positions, 1-${LIMITS.stepPositions}; 16 when omitted`),
      name: nameSchema.optional().describe("the clip name; the track's name when omitted"),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.length_steps !== undefined && args.length_steps > LIMITS.stepPositions) {
        addLimitIssue(
          ctx,
          `A pattern holds at most ${LIMITS.stepPositions} step positions; ${args.length_steps} is more.`,
        );
      }
    }),
  summary(args, snap) {
    const length = args.length_steps ?? 16;
    return `Added pattern clip "${args.name ?? labelOfTrack(snap, args.track_id)}" (${length} steps) on ${labelOfTrack(snap, args.track_id)}`;
  },
  touches(args) {
    // The clip's first pattern is "a" (see apply), so the pattern a lock or
    // focus check sees is the one this step makes.
    return [clipRef(args.clip_id), patternRef(args.clip_id, "a"), trackRef(args.track_id)];
  },
  /**
   * A new pattern clip arrives with its first pattern, "A", in the same step: a
   * pattern clip with no pattern would play nothing, and one is always there.
   */
  apply(doc, args) {
    if (getClip(doc, args.clip_id)) {
      refuseInvalid(`A clip with id "${args.clip_id}" already exists in this song.`);
    }
    const track = getTrack(doc, args.track_id);
    if (!track) refuseMissing(`There is no track "${args.track_id}" in this song.`);
    const scene = getScene(doc, args.scene_id);
    if (!scene) refuseMissing(`There is no scene "${args.scene_id}" in this song.`);
    if (!isSamplerTrack(track)) {
      refuseInvalid(
        `Track "${track.get("name")}" is not a sampler track; write notes with clip.write instead.`,
      );
    }
    const lengthSteps = args.length_steps ?? 16;
    checkLengthSteps(lengthSteps);
    const occupant = clipEntries(doc).find(
      ({ clip }) => clip.get("track_id") === args.track_id && clip.get("scene_id") === args.scene_id,
    );
    if (occupant) {
      refuseInvalid(
        `Track "${track.get("name")}" already plays clip "${occupant.clip.get("name")}" in "${scene.get("name")}"; one track plays one clip per scene.`,
      );
    }

    const clip = {
      id: args.clip_id,
      track_id: args.track_id,
      scene_id: args.scene_id,
      name: args.name ?? track.get("name"),
      length_bars: lengthBarsForSteps(lengthSteps, DEFAULT_STEP_BEATS),
      kind: "pattern",
      notes: [],
      length_steps: lengthSteps,
      step_beats: DEFAULT_STEP_BEATS,
      swing: 0,
      chain: [],
    };
    clipMap(doc).set(clip.id, objectMap(clip));
    // The first pattern's id is fixed to "a": the clip's ref prefixes it, so it
    // still names one pattern for good, and a reader that only knows the clip
    // can name its first pattern without a lookup.
    const pattern = { id: "a", clip_id: clip.id, name: "A", order: 0 };
    patternMap(doc).set(patternKey(clip.id, pattern.id), objectMap(pattern));
    return {
      before: {
        [fieldKey(clipRef(clip.id), "*")]: ABSENT,
        [fieldKey(patternRef(clip.id, pattern.id), "*")]: ABSENT,
      },
      after: {
        [fieldKey(clipRef(clip.id), "*")]: cloneJson(clip),
        [fieldKey(patternRef(clip.id, pattern.id), "*")]: cloneJson(pattern),
      },
    };
  },
});