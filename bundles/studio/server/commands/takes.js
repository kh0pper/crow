/**
 * The Studio 1b take commands: recordings, the comp that says which take
 * plays where, and the audio clip that holds both.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the panel, the gateway's upload finish route, the MCP
 * tools and the shared history:
 *
 *   take.add  take.discard  take.restore  take.keep  take.set_offset
 *   clip.set_comp  clip.add_audio
 *
 * A take is one recording that lives in the song's `takes` map and names the
 * audio clip it was recorded into. A clip's `comp` is a list of segments
 * `{take_id, from_beat, to_beat}`: which take plays over which beats. Each
 * command is one history step, and every `apply` validates everything it needs
 * before it writes anything, so a refusal leaves the document exactly as it
 * was.
 *
 * Two rules that the rest of 1b leans on:
 *   - `take.add` carries no caller-supplied trust: it is the gateway's upload
 *     finish route that issues it, and the take's storage key is part of the
 *     take the route built, never a path a caller talks us into.
 *   - `take.discard` is people-only: an agent may keep, comp and re-offset a
 *     take, but only the operator throws a recording away.
 */

import { z } from "zod";
import { addLimitIssue, defineCommand, StudioError } from "./registry.js";
import {
  BEATS_PER_BAR,
  LIMITS,
  cloneJson,
  clipEntries,
  clipMap,
  getClip,
  getScene,
  getTake,
  getTrack,
  isAudioClip,
  isAudioTrack,
  objectMap,
  objectRef,
  takeMap,
  takesForClip,
  toPlain,
} from "../doc.js";

/** Beats in one bar, phase 1b. */
const BEATS = BEATS_PER_BAR;

/** The sample rates a take may have been recorded at (spec §18). */
export const TAKE_RATES = Object.freeze([44100, 48000, 88200, 96000]);

/** The sample cap of one take: 1200 s of 48 kHz stereo (spec §5.7). */
export const MAX_TAKE_SAMPLES = 115200000;

/** `MAX_TAKE_SAMPLES` with its thousands separators, for refusal messages. */
const MAX_TAKE_SAMPLES_TEXT = "115,200,000";

/** Names (clips, tracks, scenes) are 1-80 characters. */
const MAX_NAME = 80;

/**
 * The value a before/after entry carries when the object or field did not
 * exist. `null`, not `undefined`: a history entry is stored as JSON, which
 * drops `undefined` keys (see doc.js).
 */
const ABSENT = null;

/** A clip, track or scene id: 1-40 letters, digits, dashes or underscores. */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

/**
 * A take id: the UUID the recording client generated. It is used as a path
 * segment under the song's take prefix and as the name of its staging
 * directory, so it is validated here and never taken from an arbitrary string.
 */
const takeIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "a take id is a UUID, like 6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70",
  );

const nameSchema = z.string().min(1).max(MAX_NAME);

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of a clip. */
function clipRef(id) {
  return objectRef("clip", id);
}

/** @returns {string} the ref of a take. */
function takeRef(id) {
  return objectRef("take", id);
}

/** @returns {string} the ref of a track. */
function trackRef(id) {
  return objectRef("track", id);
}

/**
 * One field of a live object as a before/after value: deep-cloned JSON, or
 * `null` when the document does not hold it.
 * @param {Y.Map<any>} object
 * @param {string} field
 * @returns {any}
 */
function fieldValue(object, field) {
  const value = object?.get?.(field);
  return value === undefined ? ABSENT : cloneJson(toPlain(value));
}

/** Refuse with a limit message that names the limit. */
function refuseLimit(message) {
  throw new StudioError("limit", message);
}

/** Refuse with an "invalid" message. */
function refuseInvalid(message) {
  throw new StudioError("invalid", message);
}

/** @returns {string} "1 bar" vs "8 bars" without the plural bug. */
function barsText(bars) {
  return bars === 1 ? "1 bar" : `${bars} bars`;
}

/** @returns {string} a beat position without float noise. */
function beatText(beats) {
  return String(Math.round(beats * 1000) / 1000);
}

/** @returns {number} a clip's length in beats. */
function lengthBeats(clip) {
  const bars = clip.get("length_bars");
  return (typeof bars === "number" && Number.isFinite(bars) ? bars : 1) * BEATS;
}

/** @returns {Y.Map<any>} the live audio clip, or a "not_found"/"invalid" refusal. */
function requireAudioClip(doc, id) {
  const clip = getClip(doc, id);
  if (!clip) throw new StudioError("not_found", `There is no clip "${id}" in this song.`);
  if (!isAudioClip(clip)) {
    refuseInvalid(`Clip "${clip.get("name")}" holds notes; takes belong to an audio clip.`);
  }
  return clip;
}

/**
 * The live take, checked to belong to the clip the command names.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @param {string} takeId
 * @returns {Y.Map<any>}
 */
function requireTakeOfClip(doc, clipId, takeId) {
  const take = getTake(doc, takeId);
  if (!take) throw new StudioError("not_found", `There is no take "${takeId}" in this song.`);
  if (take.get("clip_id") !== clipId) {
    refuseInvalid(`Take "${takeId}" belongs to clip "${take.get("clip_id")}", not "${clipId}".`);
  }
  return take;
}

/** @returns {object[]} a clip's comp as plain segments. */
function compOf(clip) {
  const comp = toPlain(clip.get("comp"));
  return Array.isArray(comp) ? comp : [];
}

/**
 * Validate a comp, returning it as plain segments.
 *
 * A comp is in beat order and has no gaps it cannot explain: every segment has
 * `from < to`, sits inside `[0, length_bars*4]`, and plays a take of this very
 * clip that is not discarded. Anything else is refused with a message naming
 * the segment and the problem.
 * @param {Y.Doc} doc
 * @param {Y.Map<any>} clip
 * @param {string} clipId
 * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} segments
 * @returns {Array<{take_id: string, from_beat: number, to_beat: number}>}
 * @throws {StudioError} code "invalid" naming the segment and what is wrong
 */
function checkComp(doc, clip, clipId, segments) {
  const limit = lengthBeats(clip);
  const bars = clip.get("length_bars");
  const takes = new Map(takesForClip(doc, clipId).map(({ id, take }) => [id, take]));
  const out = [];
  let previous = null;

  segments.forEach((segment, index) => {
    const which = `Segment ${index + 1}`;
    if (!(segment.from_beat < segment.to_beat)) {
      refuseInvalid(
        `${which} ends at beat ${beatText(segment.to_beat)}, before it starts at beat ${beatText(segment.from_beat)}.`,
      );
    }
    if (segment.from_beat < 0 || segment.to_beat > limit) {
      refuseInvalid(
        `${which} runs from beat ${beatText(segment.from_beat)} to beat ${beatText(segment.to_beat)}, outside the ${barsText(bars)} of that clip.`,
      );
    }
    if (previous && segment.from_beat < previous.from_beat) {
      refuseInvalid(
        `${which} starts at beat ${beatText(segment.from_beat)}, before the segment in front of it; a comp is in beat order.`,
      );
    }
    if (previous && segment.from_beat < previous.to_beat) {
      refuseInvalid(
        `${which} starts at beat ${beatText(segment.from_beat)}, inside the segment that ends at beat ${beatText(previous.to_beat)}; a comp cannot overlap itself.`,
      );
    }
    const take = takes.get(segment.take_id);
    if (!take) {
      refuseInvalid(`${which} plays take "${segment.take_id}", which is not a take of that clip.`);
    }
    if (take.get("discarded") === true) {
      refuseInvalid(`${which} plays take "${segment.take_id}", which is discarded.`);
    }
    previous = segment;
    out.push({ take_id: segment.take_id, from_beat: segment.from_beat, to_beat: segment.to_beat });
  });

  return out;
}

/** @returns {string} the whole clip as one segment of one take. */
function wholeClipComp(clip, takeId) {
  return [{ take_id: takeId, from_beat: 0, to_beat: lengthBeats(clip) }];
}

/** @returns {string} a track's name for a summary, or its id when unknown. */
function labelOfTrack(snap, id) {
  return snap.tracks.find((track) => track.id === id)?.name ?? id;
}

/** @returns {string} a scene's name for a summary, or its id when unknown. */
function labelOfScene(snap, id) {
  return snap.scenes.find((scene) => scene.id === id)?.name ?? id;
}

/** @returns {string} a clip's name for a summary, or its id when unknown. */
function labelOfClip(snap, id) {
  return snap.clips[id]?.name ?? id;
}

/** The take shape `take.add` accepts: no field is guessed except `clip_id`. */
const takeSchema = z
  .object({
    id: takeIdSchema,
    clip_id: idSchema.optional().describe("the clip the take was recorded into; defaults to the command's clip_id"),
    storage_key: z
      .string()
      .min(1)
      .max(512)
      .describe("where the take's WAV lives in storage, as the gateway built it"),
    rate: z
      .number()
      .int()
      .refine((rate) => TAKE_RATES.includes(rate), {
        message: `a take's rate is one of ${TAKE_RATES.join(", ")}`,
      })
      .describe("the sample rate it was recorded at; a host's context rate"),
    channels: z.number().int().min(1).max(2).describe("1 or 2 channels"),
    frames: z.number().int().min(1).describe("how many frames it holds"),
    offset_frames: z
      .number()
      .int()
      .min(0)
      .describe("the interface round trip it was recorded with, in frames"),
    compensated: z.boolean().describe("whether that offset came from a calibration"),
    bpm: z.number().finite().min(20).max(300).describe("the song's tempo when it was recorded"),
    recorded_at: z.string().min(1).max(64).describe("when it was recorded, ISO 8601"),
    author_label: z.string().min(1).max(MAX_NAME).describe("who recorded it, as the panel names them"),
    discarded: z
      .boolean()
      .refine((discarded) => discarded === false, "a new take is not discarded")
      .describe("false; a take is discarded later, by a person"),
  })
  .strict()
  .superRefine((take, ctx) => {
    if (take.frames * take.channels > MAX_TAKE_SAMPLES) {
      addLimitIssue(
        ctx,
        `A take can hold at most ${MAX_TAKE_SAMPLES_TEXT} samples (frames × channels); this one would hold ${take.frames * take.channels}.`,
      );
    }
    if (take.offset_frames >= take.frames) {
      ctx.addIssue({
        code: "custom",
        path: ["offset_frames"],
        message: "the offset is smaller than the take's frames, because it is cut from its start",
      });
    }
  });

/** One piece of a comp. */
const segmentSchema = z
  .object({
    take_id: takeIdSchema.describe("the take that plays there"),
    from_beat: z.number().finite().min(0).describe("the beat it starts at, in beats from the clip start"),
    to_beat: z.number().finite().positive().describe("the beat it ends at, in beats from the clip start"),
  })
  .strict();

// --- Takes ------------------------------------------------------------------

defineCommand({
  id: "take.add",
  // Only the gateway's upload finish route issues this, through the hub with
  // `internal: true`: a take is a recording, and nobody outside Studio may
  // invent one.
  internal: true,
  title: "Add a recorded take to an audio clip",
  schema: z
    .object({
      clip_id: idSchema,
      take: takeSchema.describe("the take the gateway finished uploading"),
    })
    .strict(),
  summary(args) {
    return `Added a take to clip "${args.clip_id}"`;
  },
  touches(args, snap) {
    const refs = [takeRef(args.take.id), clipRef(args.clip_id)];
    const clip = snap.clips[args.clip_id];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireAudioClip(doc, args.clip_id);
    if (args.take.clip_id !== undefined && args.take.clip_id !== args.clip_id) {
      refuseInvalid(`That take names clip "${args.take.clip_id}", not "${args.clip_id}".`);
    }
    if (getTake(doc, args.take.id)) {
      refuseInvalid(`A take with id "${args.take.id}" already exists in this song.`);
    }
    const recorded = takesForClip(doc, args.clip_id);
    if (recorded.length >= LIMITS.takesPerClip) {
      refuseLimit(`A clip can have at most ${LIMITS.takesPerClip} takes.`);
    }

    const take = { ...cloneJson(args.take), clip_id: args.clip_id, discarded: false };
    takeMap(doc).set(take.id, objectMap(take));

    const before = { [fieldKey(takeRef(take.id), "*")]: ABSENT };
    const after = { [fieldKey(takeRef(take.id), "*")]: cloneJson(take) };

    // The first take of a clip becomes its comp, so a fresh recording is
    // audible without anyone choosing a range. Later takes leave the comp as
    // it is: whoever is comping decides.
    const comp = compOf(clip);
    if (comp.length === 0) {
      const whole = wholeClipComp(clip, take.id);
      clip.set("comp", cloneJson(whole));
      before[fieldKey(clipRef(args.clip_id), "comp")] = cloneJson(comp);
      after[fieldKey(clipRef(args.clip_id), "comp")] = cloneJson(whole);
    }
    return { before, after };
  },
});

defineCommand({
  id: "take.discard",
  title: "Discard a take and take it out of the comp (people only)",
  humanOnly: true,
  schema: z.object({ clip_id: idSchema, take_id: takeIdSchema }).strict(),
  summary(args, snap) {
    return `Discarded a take in clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [takeRef(args.take_id), clipRef(args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireAudioClip(doc, args.clip_id);
    const take = requireTakeOfClip(doc, args.clip_id, args.take_id);
    if (take.get("discarded") === true) {
      refuseInvalid(`Take "${args.take_id}" is already discarded.`);
    }

    const before = { [fieldKey(takeRef(args.take_id), "discarded")]: false };
    const after = { [fieldKey(takeRef(args.take_id), "discarded")]: true };

    // A discarded take cannot play, so its segments go in the same step; the
    // undo brings the flag and the comp back together.
    const comp = compOf(clip);
    const kept = comp.filter((segment) => segment.take_id !== args.take_id);
    if (kept.length !== comp.length) {
      clip.set("comp", cloneJson(kept));
      before[fieldKey(clipRef(args.clip_id), "comp")] = cloneJson(comp);
      after[fieldKey(clipRef(args.clip_id), "comp")] = cloneJson(kept);
    }
    take.set("discarded", true);
    return { before, after };
  },
});

defineCommand({
  id: "take.restore",
  title: "Restore a discarded take",
  schema: z.object({ clip_id: idSchema, take_id: takeIdSchema }).strict(),
  summary(args, snap) {
    return `Restored a take in clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [takeRef(args.take_id), clipRef(args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    requireAudioClip(doc, args.clip_id);
    const take = requireTakeOfClip(doc, args.clip_id, args.take_id);
    if (take.get("discarded") !== true) {
      refuseInvalid(`Take "${args.take_id}" is not discarded, so there is nothing to restore.`);
    }
    take.set("discarded", false);
    const ref = takeRef(args.take_id);
    return {
      before: { [fieldKey(ref, "discarded")]: true },
      after: { [fieldKey(ref, "discarded")]: false },
    };
  },
});

defineCommand({
  id: "take.keep",
  title: "Keep one take over the whole clip",
  schema: z.object({ clip_id: idSchema, take_id: takeIdSchema }).strict(),
  summary(args, snap) {
    return `Kept one take over the whole of clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [clipRef(args.clip_id), takeRef(args.take_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireAudioClip(doc, args.clip_id);
    const take = requireTakeOfClip(doc, args.clip_id, args.take_id);
    if (take.get("discarded") === true) {
      refuseInvalid(`Take "${args.take_id}" is discarded; restore it before keeping it.`);
    }
    const before = compOf(clip);
    const whole = wholeClipComp(clip, args.take_id);
    clip.set("comp", cloneJson(whole));
    const ref = clipRef(args.clip_id);
    return {
      before: { [fieldKey(ref, "comp")]: cloneJson(before) },
      after: { [fieldKey(ref, "comp")]: cloneJson(whole) },
    };
  },
});

defineCommand({
  id: "take.set_offset",
  title: "Correct a take's latency offset",
  schema: z
    .object({
      clip_id: idSchema,
      take_id: takeIdSchema,
      offset_frames: z.number().int().min(0).describe("the round trip to cut from the take's start, in frames"),
      compensated: z.boolean().describe("true when the offset came from a calibration"),
    })
    .strict(),
  summary(args, snap) {
    const how = args.compensated ? "a calibrated" : "an uncalibrated";
    return `Set ${how} offset of ${args.offset_frames} frames on a take in clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [takeRef(args.take_id), clipRef(args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    requireAudioClip(doc, args.clip_id);
    const take = requireTakeOfClip(doc, args.clip_id, args.take_id);
    const frames = Number(take.get("frames") ?? 0);
    if (args.offset_frames >= frames) {
      refuseInvalid(
        `A take's offset is cut from its start, so it is smaller than its ${frames} frames; ${args.offset_frames} is not.`,
      );
    }

    const beforeOffset = fieldValue(take, "offset_frames");
    const beforeCompensated = fieldValue(take, "compensated");
    take.set("offset_frames", args.offset_frames);
    take.set("compensated", args.compensated);

    const ref = takeRef(args.take_id);
    return {
      before: {
        [fieldKey(ref, "offset_frames")]: beforeOffset,
        [fieldKey(ref, "compensated")]: beforeCompensated,
      },
      after: {
        [fieldKey(ref, "offset_frames")]: args.offset_frames,
        [fieldKey(ref, "compensated")]: args.compensated,
      },
    };
  },
});

// --- Comps ------------------------------------------------------------------

defineCommand({
  id: "clip.set_comp",
  title: "Choose which take plays over which beats of an audio clip",
  schema: z
    .object({
      clip_id: idSchema,
      segments: z
        .array(segmentSchema)
        .describe("the whole comp, in beat order; it replaces the clip's comp"),
    })
    .strict(),
  summary(args, snap) {
    const count = args.segments.length;
    const pieces = count === 1 ? "1 segment" : `${count} segments`;
    return `Comp: ${pieces} of clip "${labelOfClip(snap, args.clip_id)}"`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [clipRef(args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    for (const segment of args.segments) refs.push(takeRef(segment.take_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireAudioClip(doc, args.clip_id);
    const segments = checkComp(doc, clip, args.clip_id, args.segments);
    const before = compOf(clip);
    clip.set("comp", cloneJson(segments));
    const ref = clipRef(args.clip_id);
    return {
      before: { [fieldKey(ref, "comp")]: cloneJson(before) },
      after: { [fieldKey(ref, "comp")]: cloneJson(segments) },
    };
  },
});

// --- Audio clips ------------------------------------------------------------

defineCommand({
  id: "clip.add_audio",
  title: "Add an audio clip to an audio track",
  idField: "clip_id",
  schema: z
    .object({
      clip_id: idSchema.optional().describe("your id for the clip; one is generated when omitted"),
      track_id: idSchema.describe("the audio track it plays on"),
      scene_id: idSchema.describe("the scene it sits in"),
      length_bars: z.number().int().min(1).describe("clip length in bars"),
      name: nameSchema.optional().describe("the clip name; the track's name when omitted"),
    })
    .strict(),
  summary(args, snap) {
    const name = args.name ?? labelOfTrack(snap, args.track_id);
    return `Added audio clip "${name}" (${barsText(args.length_bars)}) on ${labelOfTrack(snap, args.track_id)}, ${labelOfScene(snap, args.scene_id)}`;
  },
  touches(args) {
    return [clipRef(args.clip_id), trackRef(args.track_id)];
  },
  apply(doc, args) {
    if (getClip(doc, args.clip_id)) {
      refuseInvalid(`A clip with id "${args.clip_id}" already exists in this song.`);
    }
    const track = getTrack(doc, args.track_id);
    if (!track) throw new StudioError("not_found", `There is no track "${args.track_id}" in this song.`);
    const scene = getScene(doc, args.scene_id);
    if (!scene) throw new StudioError("not_found", `There is no scene "${args.scene_id}" in this song.`);
    if (!isAudioTrack(track)) {
      refuseInvalid(
        `Track "${track.get("name")}" is not an audio track; write notes on it with clip.write instead.`,
      );
    }
    if (args.length_bars > LIMITS.clipBars) {
      refuseLimit(`A clip can be at most ${LIMITS.clipBars} bars long.`);
    }
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
      length_bars: args.length_bars,
      kind: "audio",
      notes: [],
      comp: [],
    };
    clipMap(doc).set(clip.id, objectMap(clip));
    const ref = clipRef(clip.id);
    return { before: { [fieldKey(ref, "*")]: ABSENT }, after: { [fieldKey(ref, "*")]: cloneJson(clip) } };
  },
});