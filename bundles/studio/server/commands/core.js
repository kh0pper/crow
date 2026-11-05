/**
 * The Studio 1a commands.
 *
 * Importing this module registers them; nothing else here is exported. The
 * ids are the contract between the dashboard, the MCP tools and the shared
 * history:
 *
 *   song.set_meta
 *   track.add  track.remove  track.rename  track.set_device  track.set_param
 *   track.set_mix  track.lock  track.unlock
 *   scene.add  scene.rename  scene.remove
 *   clip.write  clip.edit_notes  clip.set_length  clip.rename  clip.remove
 *
 * `track.add` also makes an audio track (`kind: "audio"`), the one kind that
 * plays recorded takes, a sampler track (`kind: "sampler"`), whose kit lives in
 * the song's own banks and pads, and a soundfont track (`kind: "soundfont"`),
 * which plays one preset of one font of the song's library. A soundfont track's
 * instrument is set with `track.set_font` and `track.set_program` (see
 * `instruments.js`), never by swapping its device. The take commands themselves
 * live in `takes.js`.
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (a limit, an unknown object, a note past the clip's end) leaves the
 * document exactly as it was.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { addLimitIssue, defineCommand, StudioError } from "./registry.js";
import {
  AUDIO_DEVICE,
  BEATS_PER_BAR,
  INSTRUMENT_TYPES,
  LIMITS,
  SAMPLER_DEVICE,
  SOUNDFONT_DEVICE,
  STEP_GUARDS,
  TRACK_COLORS,
  bankEntries,
  bankMap,
  bankKey,
  cloneJson,
  clipMap,
  clipEntries,
  colorForIndex,
  findSceneIndex,
  findTrackIndex,
  getClip,
  getLibraryFont,
  getScene,
  getTrack,
  isAudioClip,
  isAudioTrack,
  isPatternClip,
  isSamplerTrack,
  isSoundfontTrack,
  newSamplerBank,
  objectMap,
  objectRef,
  padEntries,
  padKey,
  padMap,
  patternEntries,
  patternKey,
  patternMap,
  placementEntries,
  placementMap,
  songMap,
  stepEntries,
  stepKey,
  stepMap,
  takeEntries,
  takeMap,
  toPlain,
  trackList,
  sceneList,
} from "../doc.js";

/** Beats in one bar, phase 1a. */
const BEATS = BEATS_PER_BAR;

/** A track added without a device gets SunVox's plain analog synth. */
const DEFAULT_DEVICE_TYPE = "Analog generator";
const instrumentTypeSchema = z.enum(INSTRUMENT_TYPES);

/** Names (tracks, scenes, clips, params, keys) are 1-80 characters. */
const MAX_NAME = 80;

/**
 * The value a before/after entry carries when the object or field did not
 * exist. `null`, not `undefined`: a history entry is stored as JSON, which
 * drops `undefined` keys, and a dropped key would turn a deletion into a
 * no-op. See doc.js.
 */
const ABSENT = null;

/** The field prefix `track.set_param` records one controller under. */
const PARAM_FIELD_PREFIX = "device.params.";

/** The song's own object ref: meta is the one part of the song not in a container. */
const META_REF = objectRef("song", "meta");

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

const nameSchema = z.string().min(1).max(MAX_NAME);

// A controller name becomes part of a history key ("track:<id>|device.params.<name>"),
// so it may not contain the key separators, and it may not shadow Object.prototype.
const RESERVED_PARAM_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const paramNameSchema = z
  .string()
  .min(1)
  .max(MAX_NAME)
  .refine((n) => !/[.|]/.test(n) && !RESERVED_PARAM_NAMES.has(n), {
    message: 'A controller name cannot contain "." or "|" or be a reserved word.',
  });
const paramsSchema = z
  .record(paramNameSchema, z.number().finite())
  .superRefine((params, ctx) => {
    if (Object.keys(params).length > LIMITS.params) {
      addLimitIssue(ctx, `A device can have at most ${LIMITS.params} parameters.`);
    }
  })
  .describe("SunVox controller name → value");

const noteSchema = z
  .object({
    t: z.number().finite().min(0).describe("start, in beats from the clip start"),
    d: z.number().finite().positive().describe("length, in beats"),
    p: z.number().int().min(0).max(127).describe("MIDI pitch, 0-127"),
    v: z.number().int().min(1).max(127).describe("velocity, 1-127"),
  })
  .strict();

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
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

/** @returns {string} the ref of a track. */
function trackRef(id) {
  return objectRef("track", id);
}

/** @returns {string} the ref of a scene. */
function sceneRef(id) {
  return objectRef("scene", id);
}

/** @returns {string} the ref of a clip. */
function clipRef(id) {
  return objectRef("clip", id);
}

/** @returns {string} the ref of a take. */
function takeRef(id) {
  return objectRef("take", id);
}

/** @returns {string} the ref of a placement. */
function placementRef(id) {
  return objectRef("placement", id);
}

/** @returns {string} the ref of a kit bank. */
function bankRef(trackId, bankId) {
  return objectRef("bank", bankKey(trackId, bankId));
}

/** @returns {string} the ref of one pad of one bank. */
function padRef(trackId, bankId, index) {
  return objectRef("pad", padKey(trackId, bankId, index));
}

/** @returns {string} the ref of one pattern of one clip. */
function patternRef(clipId, patternId) {
  return objectRef("pattern", patternKey(clipId, patternId));
}

/** @returns {string} the ref of one step of one pattern. */
function stepRef(clipId, patternId, at, bankId, index) {
  return objectRef("step", stepKey(clipId, patternId, at, bankId, index));
}

/** @returns {number} "1 bar" vs "8 bars" without the plural bug. */
function barsText(bars) {
  return bars === 1 ? "1 bar" : `${bars} bars`;
}

/**
 * The sibling a restored track or scene should follow, for the `_after`
 * position hint doc.js reads beside `_index`. A recorded index goes stale as
 * soon as an object in front of it is removed, so a restore prefers the
 * neighbour it knew.
 * @param {Y.Map<any>|null} previous - the sibling that came before it
 * @returns {string|null}
 */
function siblingBefore(previous) {
  return idOf(previous);
}

/**
 * The sibling a restored track or scene should precede, for the `_before`
 * position hint. It is the second anchor a restore can use: when the object in
 * front of a removed one is gone too, the one behind it still says where its
 * old place was. Only a removal records one — a created track or scene is
 * appended, so nothing follows it when it appears.
 * @param {Y.Map<any>|null} next - the sibling that came after it
 * @returns {string|null}
 */
function siblingAfter(next) {
  return idOf(next);
}
/** @returns {string|null} a live object's id, or null when there is no object. */
function idOf(object) {
  const id = object?.get?.("id");
  return typeof id === "string" ? id : ABSENT;
}

/** @returns {string} "1 clip" vs "3 clips". */
function clipsText(count) {
  return count === 1 ? "1 clip" : `${count} clips`;
}

/**
 * Refuse an edit that only makes sense on a SunVox track, naming the track.
 * @param {Y.Map<any>} track
 * @param {string} what - what an audio track does not have, e.g. "SunVox module"
 * @returns {void}
 */
function refuseOnAudioTrack(track, what) {
  if (!isAudioTrack(track)) return;
  refuseInvalid(`Track "${track.get("name")}" is an audio track; it has no ${what}.`);
}

/**
 * Refuse an edit that only makes sense on a SunVox track, naming the track.
 * A sampler track's device is its kit's engine, not a module to swap: the kit
 * lives beside the device, so a device write would be a different sound.
 * @param {Y.Map<any>} track
 * @param {string} what - what a sampler track does not have
 * @returns {void}
 */
function refuseOnSamplerTrack(track, what) {
  if (!isSamplerTrack(track)) return;
  refuseInvalid(`Track "${track.get("name")}" is a sampler track; it has no ${what}.`);
}

/**
 * Refuse an edit that only makes sense on a SunVox track, for a soundfont track:
 * its instrument is a font and a preset of it, and swapping the device would
 * throw both away.
 * @param {Y.Map<any>} track
 * @returns {void}
 */
function refuseOnSoundfontTrack(track) {
  if (!isSoundfontTrack(track)) return;
  refuseInvalid(
    `Track "${track.get("name")}" is a soundfont track; a soundfont track's instrument is set with track.set_font / track.set_program.`,
  );
}

/**
 * Refuse a notes edit on a pattern clip, naming the clip.
 * @param {Y.Map<any>} clip
 * @returns {void}
 */
function refuseOnPatternClip(clip) {
  if (!isPatternClip(clip)) return;
  refuseInvalid(
    `Clip "${clip.get("name")}" holds steps and patterns rather than notes; there are no notes to write there.`,
  );
}

/**
 * Refuse a notes edit on an audio clip, naming the clip.
 * @param {Y.Map<any>} clip
 * @returns {void}
 */
function refuseOnAudioClip(clip) {
  if (!isAudioClip(clip)) return;
  refuseInvalid(
    `Clip "${clip.get("name")}" holds recorded takes rather than notes; there are no notes to write there.`,
  );
}

/**
 * Record and delete every take of the clips a removal takes with it, so one
 * undo brings the clips and their takes back together.
 * @param {Y.Doc} doc
 * @param {Set<string>} clipIds - the clips being removed
 * @param {Object<string, any>} before - the removal's before map, filled in
 * @param {Object<string, any>} after - the removal's after map, filled in
 * @returns {void}
 */
function removeTakes(doc, clipIds, before, after) {
  const takes = takeMap(doc);
  for (const { id, take } of takeEntries(doc)) {
    if (!clipIds.has(take.get("clip_id"))) continue;
    before[fieldKey(takeRef(id), "*")] = cloneJson(toPlain(take));
    after[fieldKey(takeRef(id), "*")] = ABSENT;
    takes.delete(id);
  }
}

/**
 * The takes of a clip, as the refs a lock/focus check has to see with it.
 * @param {object} snap
 * @param {string} clipId
 * @returns {string[]}
 */
function takeRefsOfClip(snap, clipId) {
  const refs = [];
  for (const take of Object.values(snap.takes ?? {})) {
    if (take.clip_id === clipId) refs.push(takeRef(take.id));
  }
  return refs;
}

/**
 * The placements that put a clip on the timeline, as refs a lock/focus check
 * has to see with the clip.
 * @param {object} snap
 * @param {string} clipId
 * @returns {string[]}
 */
function placementRefsOfClip(snap, clipId) {
  const refs = [];
  for (const placement of Object.values(snap.arrangement?.placements ?? {})) {
    if (placement.clip_id === clipId) refs.push(placementRef(placement.id));
  }
  return refs;
}

/**
 * The placements sitting on a track, as refs a lock/focus check has to see
 * with the track.
 * @param {object} snap
 * @param {string} trackId
 * @returns {string[]}
 */
function placementRefsOfTrack(snap, trackId) {
  const refs = [];
  for (const placement of Object.values(snap.arrangement?.placements ?? {})) {
    if (placement.track_id === trackId) refs.push(placementRef(placement.id));
  }
  return refs;
}

/**
 * Delete the placements of the clips a removal takes with it (and those of a
 * removed track), recording each one for the same undo step as the clip.
 *
 * A placement is the clip's other place in the song beside its scene: leaving
 * one behind would point the timeline at a clip that is gone, so it goes in
 * the same step and comes back with the clip. Nothing is created when the song
 * has no arrangement at all (see doc.js `placementEntries`).
 * @param {Y.Doc} doc
 * @param {{clipIds: Set<string>, trackIds?: Set<string>}} doomed - the clips
 *   being removed, and the tracks whose placements go too
 * @param {Object<string, any>} before - the removal's before map, filled in
 * @param {Object<string, any>} after - the removal's after map, filled in
 * @returns {void}
 */
function removePlacements(doc, { clipIds, trackIds = new Set() }, before, after) {
  const doomed = placementEntries(doc).filter(({ placement }) =>
    clipIds.has(placement.get("clip_id")) || trackIds.has(placement.get("track_id")));
  if (doomed.length === 0) return;
  const placements = placementMap(doc);
  for (const { id, placement } of doomed) {
    before[fieldKey(placementRef(id), "*")] = cloneJson(toPlain(placement));
    after[fieldKey(placementRef(id), "*")] = ABSENT;
    placements.delete(id);
  }
}

/**
 * Record and delete one kind of sampler object a removal takes with it: every
 * entry in `doomed` is captured under its own `"<ref>|*"` key and deleted, so
 * one undo puts all of them back in the same step.
 * @param {Y.Doc} doc
 * @param {"bank"|"pad"|"pattern"|"step"} kind
 * @param {Array<{id: string, [key: string]: Y.Map<any>}>} doomed
 * @param {(doc: Y.Doc) => Y.Map<any>} mapOf - the container's writing accessor
 * @param {Object<string, any>} before - the removal's before map, filled in
 * @param {Object<string, any>} after - the removal's after map, filled in
 * @returns {void}
 */
function removeSamplerKind(doc, kind, doomed, mapOf, before, after) {
  if (doomed.length === 0) return;
  const map = mapOf(doc);
  for (const entry of doomed) {
    const ref = objectRef(kind, entry.id);
    before[fieldKey(ref, "*")] = cloneJson(toPlain(entry[kind]));
    after[fieldKey(ref, "*")] = ABSENT;
    map.delete(entry.id);
  }
}

/**
 * Delete the sampler objects a clip removal (or a track removal, through its
 * clips) takes with it: the patterns of those clips and their steps, and —
 * when a track goes — its banks and all their pads. Each one is captured for
 * the same undo step, so one undo brings the kit and its patterns back.
 *
 * A sample stays: it belongs to the song, not to the track that plays it.
 * @param {Y.Doc} doc
 * @param {{clipIds?: Set<string>, trackIds?: Set<string>}} doomed - the clips
 *   and tracks being removed
 * @param {Object<string, any>} before - the removal's before map, filled in
 * @param {Object<string, any>} after - the removal's after map, filled in
 * @returns {void}
 */
function removeSamplerObjects(doc, { clipIds = new Set(), trackIds = new Set() }, before, after) {
  removeSamplerKind(
    doc,
    "step",
    stepEntries(doc).filter(({ step }) => clipIds.has(step.get("clip_id"))),
    stepMap,
    before,
    after,
  );
  removeSamplerKind(
    doc,
    "pattern",
    patternEntries(doc).filter(({ pattern }) => clipIds.has(pattern.get("clip_id"))),
    patternMap,
    before,
    after,
  );
  removeSamplerKind(
    doc,
    "pad",
    padEntries(doc).filter(({ pad }) => trackIds.has(pad.get("track_id"))),
    padMap,
    before,
    after,
  );
  removeSamplerKind(
    doc,
    "bank",
    bankEntries(doc).filter(({ bank }) => trackIds.has(bank.get("track_id"))),
    bankMap,
    before,
    after,
  );
}

/**
 * The patterns and steps of a clip, as refs a lock/focus check has to see with
 * it.
 * @param {object} snap
 * @param {string} clipId
 * @returns {string[]}
 */
function samplerRefsOfClip(snap, clipId) {
  const refs = [];
  for (const pattern of Object.values(snap.patterns ?? {})) {
    if (pattern.clip_id !== clipId) continue;
    refs.push(patternRef(clipId, pattern.id));
  }
  for (const step of Object.values(snap.steps ?? {})) {
    if (step.clip_id !== clipId) continue;
    refs.push(stepRef(step.clip_id, step.pattern_id, step.at, step.bank_id, step.index));
  }
  return refs;
}

/**
 * A sampler track's kit and its clips' patterns, as refs a lock/focus check
 * has to see with the track.
 * @param {object} snap
 * @param {string} trackId
 * @returns {string[]}
 */
function samplerRefsOfTrack(snap, trackId) {
  const refs = [];
  for (const bank of Object.values(snap.banks ?? {})) {
    if (bank.track_id === trackId) refs.push(bankRef(trackId, bank.id));
  }
  for (const pad of Object.values(snap.pads ?? {})) {
    if (pad.track_id === trackId) refs.push(padRef(trackId, pad.bank_id, pad.index));
  }
  for (const clip of Object.values(snap.clips)) {
    if (clip.track_id === trackId) refs.push(...samplerRefsOfClip(snap, clip.id));
  }
  return refs;
}

/**
 * Clamp an audio clip's comp to a (possibly shorter) clip: a segment that runs
 * past the new end is cut there, and one that starts past it goes away.
 * @param {Array<{take_id: string, from_beat: number, to_beat: number}>} segments
 * @param {number} limit - the new length in beats
 * @returns {Array<{take_id: string, from_beat: number, to_beat: number}>}
 */
function clampComp(segments, limit) {
  const out = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const from = typeof segment?.from_beat === "number" ? segment.from_beat : 0;
    const to = typeof segment?.to_beat === "number" ? segment.to_beat : 0;
    if (from >= limit) continue;
    out.push({ take_id: segment.take_id, from_beat: from, to_beat: Math.min(to, limit) });
  }
  return out;
}

/**
 * Keep a clip's placements valid when the clip's length changes.
 *
 * A placement starts inside its clip, so an offset that no longer fits is
 * folded back into the clip the way the clip loops under a placement longer
 * than it — `offset % length` — which keeps it on the sixteenth-of-a-beat grid,
 * because both the offset and the length are whole grid steps. Each offset that
 * actually changes is recorded as one `placement:<id>|offset_beats` pair, so the
 * clip's own length change and the placements it moved undo together.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @param {number} lengthBeats - the clip's length after the change
 * @param {Object<string, any>} before - the step's before map, filled in
 * @param {Object<string, any>} after - the step's after map, filled in
 * @returns {void}
 */
function wrapPlacementOffsets(doc, clipId, lengthBeats, before, after) {
  if (!(lengthBeats > 0)) return;
  for (const { id, placement } of placementEntries(doc)) {
    if (placement.get("clip_id") !== clipId) continue;
    const offset = Number(placement.get("offset_beats")) || 0;
    const wrapped = offset % lengthBeats;
    if (wrapped === offset) continue;
    const ref = placementRef(id);
    before[fieldKey(ref, "offset_beats")] = offset;
    after[fieldKey(ref, "offset_beats")] = wrapped;
    placement.set("offset_beats", wrapped);
  }
}

/** @returns {string} a beat or bar position without float noise. */
function beatText(beats) {
  return String(Math.round(beats * 1000) / 1000);
}

/** @returns {string} "0.5 left", "0.25 right" or "centre". */
function panText(pan) {
  if (pan === 0) return "centre";
  return `${Math.abs(pan)} ${pan < 0 ? "left" : "right"}`;
}

/** @returns {number} the clip length those notes need, in whole bars, at least one. */
function lengthForNotes(notes) {
  let end = 0;
  for (const note of notes) end = Math.max(end, note.t + note.d);
  return Math.max(1, Math.ceil(end / BEATS));
}

/** @returns {string} the first palette colour no existing track uses, wrapping once they all are. */
function nextTrackColor(doc) {
  const used = new Set();
  for (const item of trackList(doc).toArray()) {
    const color = item?.get?.("color");
    if (typeof color === "string") used.add(color.toLowerCase());
  }
  for (const color of TRACK_COLORS) {
    if (!used.has(color.toLowerCase())) return color;
  }
  return colorForIndex(trackList(doc).length);
}

/** @returns {Y.Map<any>} the live track, or a "not_found" refusal. */
function requireTrack(doc, id) {
  const track = getTrack(doc, id);
  if (!track) throw new StudioError("not_found", `There is no track "${id}" in this song.`);
  return track;
}

/** @returns {Y.Map<any>} the live scene, or a "not_found" refusal. */
function requireScene(doc, id) {
  const scene = getScene(doc, id);
  if (!scene) throw new StudioError("not_found", `There is no scene "${id}" in this song.`);
  return scene;
}

/** @returns {Y.Map<any>} the live clip, or a "not_found" refusal. */
function requireClip(doc, id) {
  const clip = getClip(doc, id);
  if (!clip) throw new StudioError("not_found", `There is no clip "${id}" in this song.`);
  return clip;
}

/** Refuse with a limit message that names the limit. */
function refuseLimit(message) {
  throw new StudioError("limit", message);
}

/** Refuse with an "invalid" message. */
function refuseInvalid(message) {
  throw new StudioError("invalid", message);
}

/**
 * Refuse notes that run past the end of their clip.
 * @param {Array<{t: number, d: number}>} notes
 * @param {number} lengthBars
 * @param {string} label - what the message calls the clip
 */
function checkNotesFit(notes, lengthBars, label) {
  const limit = lengthBars * BEATS;
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.t + note.d > limit) {
      refuseInvalid(
        `Note ${index + 1} ends at beat ${beatText(note.t + note.d)}, past the ${barsText(lengthBars)} of "${label}".`,
      );
    }
  }
}

// --- Song -------------------------------------------------------------------

defineCommand({
  id: "song.set_meta",
  title: "Change the song's title, tempo or key",
  schema: z
    .object({
      title: nameSchema.optional().describe("the song title"),
      bpm: z.number().int().min(20).max(300).optional().describe("tempo, 20-300"),
      // A fresh schema, not nameSchema: the JSON-schema export turns a reused
      // instance into a $ref, which the tool-schema audit refuses.
      key: z.string().min(1).max(MAX_NAME).optional().describe('the musical key, e.g. "C major"'),
    })
    .strict()
    .refine(
      (args) => args.title !== undefined || args.bpm !== undefined || args.key !== undefined,
      "song.set_meta needs at least one of title, bpm or key",
    ),
  summary(args) {
    const parts = [];
    if (args.title !== undefined) parts.push(`title "${args.title}"`);
    if (args.bpm !== undefined) parts.push(`${args.bpm} bpm`);
    if (args.key !== undefined) parts.push(`key ${args.key}`);
    return `Set the song's ${parts.join(", ")}`;
  },
  touches() {
    return [META_REF];
  },
  apply(doc, args) {
    const current = toPlain(songMap(doc).get("meta")) ?? {};
    const next = { ...current };
    const before = {};
    const after = {};
    for (const field of ["title", "bpm", "key"]) {
      if (args[field] === undefined) continue;
      before[fieldKey(META_REF, field)] = current[field] ?? ABSENT;
      after[fieldKey(META_REF, field)] = args[field];
      next[field] = args[field];
    }
    songMap(doc).set("meta", next);
    return { before, after };
  },
});

// --- Tracks -----------------------------------------------------------------

defineCommand({
  id: "track.add",
  title: "Add an instrument track",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("your id for the track; one is generated when omitted"),
      name: nameSchema,
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "a colour is #rrggbb")
        .optional()
        .describe("the track colour; one from the palette is used when omitted"),
      device: z
        .object({
          engine: z.literal("sunvox").default("sunvox"),
          type: instrumentTypeSchema.describe('a SunVox instrument: one of ' + INSTRUMENT_TYPES.join(", ")),
          params: paramsSchema.default({}),
        })
        .strict()
        .optional()
        .describe("an instrument; the analog generator when omitted"),
      gain_db: z.number().finite().min(-60).max(12).optional(),
      pan: z.number().finite().min(-1).max(1).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      kind: z
        .enum(["sunvox", "audio", "sampler", "soundfont"])
        .optional()
        .describe(
          'what the track plays: "sunvox" (the default), "audio" for recorded takes, "sampler" for a kit of pads, or "soundfont" for an instrument from the song\'s library',
        ),
      font_id: idSchema
        .optional()
        .describe(
          'a soundfont track\'s instrument: a font in the song\'s library; the track plays its first preset until track.set_program chooses another',
        ),
    })
    .strict(),
  summary(args, snap) {
    if (args.kind === "audio") return `Added audio track "${args.name}"`;
    if (args.kind === "sampler") return `Added sampler track "${args.name}"`;
    if (args.kind === "soundfont") {
      return args.font_id === undefined
        ? `Added soundfont track "${args.name}"`
        : `Added soundfont track "${args.name}" (${labelOfFont(snap, args.font_id)})`;
    }
    return `Added track "${args.name}" (${args.device?.type ?? DEFAULT_DEVICE_TYPE})`;
  },
  touches(args) {
    return [trackRef(args.id)];
  },
  /**
   * A sampler track arrives with its kit: bank "A" and its sixteen empty pads,
   * created in the same step as the track, so one undo takes the whole thing
   * back and no track is ever left with a kit it does not have.
   *
   * A soundfont track arrives pointed at one font of the song's library (or at
   * none, and then it is silent until `track.set_font` chooses one), playing
   * program 0 of bank 0: the instrument is a library entry plus a preset, so
   * the track holds nothing but the two, and `font_id` must already be in the
   * library.
   */
  apply(doc, args) {
    const tracks = trackList(doc);
    if (tracks.length >= LIMITS.tracks) {
      refuseLimit(`A song can have at most ${LIMITS.tracks} tracks.`);
    }
    if (findTrackIndex(doc, args.id) >= 0) {
      refuseInvalid(`A track with id "${args.id}" already exists in this song.`);
    }
    const audio = args.kind === "audio";
    const sampler = args.kind === "sampler";
    const soundfont = args.kind === "soundfont";
    if ((audio || sampler || soundfont) && args.device !== undefined) {
      refuseInvalid(
        audio
          ? `An audio track has no instrument; leave the device out when adding one.`
          : sampler
            ? `A sampler track has no SunVox module; leave the device out when adding one.`
            : `A soundfont track's instrument is its font; leave the device out and name a font_id instead.`,
      );
    }
    if (!soundfont && args.font_id !== undefined) {
      refuseInvalid(
        `A font_id belongs to a soundfont track; add the track with kind "soundfont" to play a font.`,
      );
    }
    if (soundfont && args.font_id !== undefined && !getLibraryFont(doc, args.font_id)) {
      refuseInvalid(
        `The song's library has no font with id "${args.font_id}"; add the font to the library before a track plays it.`,
      );
    }
    const index = tracks.length;
    const track = {
      id: args.id,
      name: args.name,
      color: args.color ?? nextTrackColor(doc),
      device: audio
        ? { ...AUDIO_DEVICE }
        : sampler
          ? { ...SAMPLER_DEVICE }
          : soundfont
            ? { ...SOUNDFONT_DEVICE, font_id: args.font_id ?? ABSENT, bank: 0, program: 0 }
            : {
                engine: "sunvox",
                type: args.device?.type ?? DEFAULT_DEVICE_TYPE,
                params: { ...(args.device?.params ?? {}) },
              },
      mute: args.mute ?? false,
      solo: args.solo ?? false,
      gain_db: args.gain_db ?? 0,
      pan: args.pan ?? 0,
      locked: false,
    };
    const previous = index > 0 ? tracks.get(index - 1) : null;
    tracks.push([objectMap(track)]);
    const before = { [fieldKey(trackRef(track.id), "*")]: ABSENT };
    const after = {
      [fieldKey(trackRef(track.id), "*")]: {
        ...cloneJson(track),
        _index: index,
        _after: siblingBefore(previous),
      },
    };

    if (sampler) {
      const bankId = randomUUID();
      const { bank, pads } = newSamplerBank(track.id, bankId, "A", 0);
      bankMap(doc).set(bankKey(track.id, bankId), objectMap(bank));
      const bankField = fieldKey(bankRef(track.id, bankId), "*");
      before[bankField] = ABSENT;
      after[bankField] = cloneJson(bank);
      const padsMap = padMap(doc);
      for (const pad of pads) {
        const key = padKey(track.id, bankId, pad.index);
        padsMap.set(key, objectMap(pad));
        const field = fieldKey(padRef(track.id, bankId, pad.index), "*");
        before[field] = ABSENT;
        after[field] = cloneJson(pad);
      }
    }

    return { before, after };
  },
});

defineCommand({
  id: "track.remove",
  title: "Remove a track and its clips",
  schema: z.object({ track_id: idSchema }).strict(),
  summary(args, snap) {
    const clips = Object.values(snap.clips).filter((clip) => clip.track_id === args.track_id);
    return clips.length === 0
      ? `Removed track "${labelOfTrack(snap, args.track_id)}"`
      : `Removed track "${labelOfTrack(snap, args.track_id)}" and its ${clipsText(clips.length)}`;
  },
  touches(args, snap) {
    const refs = [trackRef(args.track_id)];
    for (const clip of Object.values(snap.clips)) {
      if (clip.track_id !== args.track_id) continue;
      refs.push(clipRef(clip.id));
      refs.push(...takeRefsOfClip(snap, clip.id));
      refs.push(...placementRefsOfClip(snap, clip.id));
    }
    // A placement on this track whose clip has drifted elsewhere is still that
    // track's block, and it goes with the track.
    for (const ref of placementRefsOfTrack(snap, args.track_id)) {
      if (!refs.includes(ref)) refs.push(ref);
    }
    // A sampler track's kit and its clips' patterns go with it.
    refs.push(...samplerRefsOfTrack(snap, args.track_id));
    return refs;
  },
  apply(doc, args) {
    const index = findTrackIndex(doc, args.track_id);
    if (index < 0) throw new StudioError("not_found", `There is no track "${args.track_id}" in this song.`);
    const track = getTrack(doc, args.track_id);
    const clips = clipEntries(doc).filter(({ clip }) => clip.get("track_id") === args.track_id);
    const tracks = trackList(doc);
    const previous = index > 0 ? tracks.get(index - 1) : null;
    const next = index + 1 < tracks.length ? tracks.get(index + 1) : null;

    const before = {
      [fieldKey(trackRef(args.track_id), "*")]: {
        ...cloneJson(toPlain(track)),
        _index: index,
        _after: siblingBefore(previous),
        _before: siblingAfter(next),
      },
    };
    const after = { [fieldKey(trackRef(args.track_id), "*")]: ABSENT };
    for (const { id, clip } of clips) {
      before[fieldKey(clipRef(id), "*")] = cloneJson(toPlain(clip));
      after[fieldKey(clipRef(id), "*")] = ABSENT;
    }
    // A recorded take belongs to its clip, so it goes with it and comes back
    // with it, in the same step. So does every placement that put the clip on
    // the timeline, every placement sitting on the track itself, and — on a
    // sampler track — the kit and the patterns of the clips that go.
    const removedClips = new Set(clips.map(({ id }) => id));
    removeTakes(doc, removedClips, before, after);
    removePlacements(doc, { clipIds: removedClips, trackIds: new Set([args.track_id]) }, before, after);
    removeSamplerObjects(doc, { clipIds: removedClips, trackIds: new Set([args.track_id]) }, before, after);

    const clipsMap = clipMap(doc);
    for (const { id } of clips) clipsMap.delete(id);
    trackList(doc).delete(index, 1);
    return { before, after };
  },
});

defineCommand({
  id: "track.rename",
  title: "Rename a track",
  schema: z.object({ track_id: idSchema, name: nameSchema }).strict(),
  summary(args, snap) {
    return `Renamed track "${labelOfTrack(snap, args.track_id)}" to "${args.name}"`;
  },
  touches(args) {
    return [trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    const ref = trackRef(args.track_id);
    const before = fieldValue(track, "name");
    track.set("name", args.name);
    return { before: { [fieldKey(ref, "name")]: before }, after: { [fieldKey(ref, "name")]: args.name } };
  },
});

defineCommand({
  id: "track.set_device",
  title: "Give a track a different SunVox module",
  schema: z
    .object({
      track_id: idSchema,
      type: instrumentTypeSchema.describe('a SunVox instrument: one of ' + INSTRUMENT_TYPES.join(", ")),
      params: paramsSchema.default({}).describe("the new module's controller values; they replace the old ones"),
    })
    .strict(),
  summary(args, snap) {
    return `Set track "${labelOfTrack(snap, args.track_id)}" to the "${args.type}" module`;
  },
  touches(args, snap) {
    return [trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    refuseOnAudioTrack(track, "SunVox module to swap");
    refuseOnSamplerTrack(track, "SunVox module to swap");
    refuseOnSoundfontTrack(track);
    const ref = trackRef(args.track_id);
    const before = fieldValue(track, "device");
    const device = { engine: "sunvox", type: args.type, params: { ...paramsDefaults(args.params) } };
    track.set("device", device);
    return {
      before: { [fieldKey(ref, "device")]: before },
      after: { [fieldKey(ref, "device")]: cloneJson(device) },
    };
  },
});

defineCommand({
  id: "track.set_param",
  title: "Set one SunVox controller value on a track",
  schema: z
    .object({
      track_id: idSchema,
      name: paramNameSchema.describe('the controller name, e.g. "Cutoff"'),
      value: z.number().finite().describe("the controller value, within the module's own range"),
    })
    .strict(),
  summary(args, snap) {
    return `Set "${args.name}" to ${args.value} on track "${labelOfTrack(snap, args.track_id)}"`;
  },
  touches(args) {
    return [trackRef(args.track_id)];
  },
  /**
   * Only the controller this call changed is recorded, under
   * `device.params.<name>`: two later edits of different controllers on the
   * same track then undo independently instead of conflicting over the whole
   * device object.
   */
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    refuseOnAudioTrack(track, "SunVox controller to set");
    refuseOnSamplerTrack(track, "SunVox controller to set");
    refuseOnSoundfontTrack(track);
    const ref = trackRef(args.track_id);
    const device = toPlain(track.get("device")) ?? {
      engine: "sunvox",
      type: DEFAULT_DEVICE_TYPE,
      params: {},
    };
    const params = { ...(device.params ?? {}) };
    const before = Object.hasOwn(params, args.name) ? cloneJson(params[args.name]) : ABSENT;
    if (before === ABSENT && Object.keys(params).length >= LIMITS.params) {
      refuseLimit(`A device can have at most ${LIMITS.params} parameters.`);
    }
    const deviceType = typeof device.type === "string" ? device.type : ABSENT;
    params[args.name] = args.value;
    track.set("device", { ...device, params });
    const field = fieldKey(ref, `${PARAM_FIELD_PREFIX}${args.name}`);
    const after = { [field]: args.value };
    // A controller value only means what it meant inside the device it was set
    // on, so the step guards on the device type: undoing it after a device swap
    // is a reported conflict instead of a write into the new module. A guard is
    // compared by the history, never restored.
    after[STEP_GUARDS] = { [fieldKey(ref, "device.type")]: deviceType };
    return { before: { [field]: before }, after };
  },
});

defineCommand({
  id: "track.set_mix",
  title: "Set a track's level, pan, mute or solo",
  schema: z
    .object({
      track_id: idSchema,
      gain_db: z.number().finite().min(-60).max(12).optional().describe("level in dB, -60 to +12"),
      pan: z.number().finite().min(-1).max(1).optional().describe("pan, -1 left to +1 right"),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
    })
    .strict()
    .refine(
      (args) => args.gain_db !== undefined || args.pan !== undefined || args.mute !== undefined || args.solo !== undefined,
      "track.set_mix needs at least one of gain_db, pan, mute or solo",
    ),
  summary(args, snap) {
    const parts = [];
    if (args.gain_db !== undefined) parts.push(`gain ${args.gain_db} dB`);
    if (args.pan !== undefined) parts.push(`pan ${panText(args.pan)}`);
    if (args.mute !== undefined) parts.push(args.mute ? "muted" : "unmuted");
    if (args.solo !== undefined) parts.push(args.solo ? "soloed" : "unsoloed");
    return `Mixed track "${labelOfTrack(snap, args.track_id)}": ${parts.join(", ")}`;
  },
  touches(args) {
    return [trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    const ref = trackRef(args.track_id);
    const before = {};
    const after = {};
    for (const field of ["gain_db", "pan", "mute", "solo"]) {
      if (args[field] === undefined) continue;
      before[fieldKey(ref, field)] = fieldValue(track, field);
      after[fieldKey(ref, field)] = args[field];
      track.set(field, args[field]);
    }
    return { before, after };
  },
});

defineCommand({
  id: "track.lock",
  title: "Lock a track so agents cannot edit it (people only)",
  humanOnly: true,
  schema: z.object({ track_id: idSchema }).strict(),
  summary(args, snap) {
    return `Locked track "${labelOfTrack(snap, args.track_id)}"`;
  },
  touches(args) {
    return [trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    const ref = trackRef(args.track_id);
    const before = track.get("locked") === true;
    track.set("locked", true);
    return { before: { [fieldKey(ref, "locked")]: before }, after: { [fieldKey(ref, "locked")]: true } };
  },
});

defineCommand({
  id: "track.unlock",
  title: "Unlock a track (people only)",
  humanOnly: true,
  schema: z.object({ track_id: idSchema }).strict(),
  summary(args, snap) {
    return `Unlocked track "${labelOfTrack(snap, args.track_id)}"`;
  },
  touches(args) {
    return [trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    const ref = trackRef(args.track_id);
    const before = track.get("locked") === true;
    track.set("locked", false);
    return { before: { [fieldKey(ref, "locked")]: before }, after: { [fieldKey(ref, "locked")]: false } };
  },
});

// --- Scenes -----------------------------------------------------------------

defineCommand({
  id: "scene.add",
  title: "Add a scene (a column in the session grid)",
  idField: "id",
  schema: z.object({ id: idSchema.optional().describe("your id for the scene; one is generated when omitted"), name: nameSchema }).strict(),
  summary(args) {
    return `Added scene "${args.name}"`;
  },
  touches(args) {
    return [sceneRef(args.id)];
  },
  apply(doc, args) {
    const scenes = sceneList(doc);
    if (scenes.length >= LIMITS.scenes) {
      refuseLimit(`A song can have at most ${LIMITS.scenes} scenes.`);
    }
    if (findSceneIndex(doc, args.id) >= 0) {
      refuseInvalid(`A scene with id "${args.id}" already exists in this song.`);
    }
    const index = scenes.length;
    const scene = { id: args.id, name: args.name };
    const previous = index > 0 ? scenes.get(index - 1) : null;
    scenes.push([objectMap(scene)]);
    return {
      before: { [fieldKey(sceneRef(scene.id), "*")]: ABSENT },
      after: {
        [fieldKey(sceneRef(scene.id), "*")]: {
          ...cloneJson(scene),
          _index: index,
          _after: siblingBefore(previous),
        },
      },
    };
  },
});

defineCommand({
  id: "scene.rename",
  title: "Rename a scene",
  schema: z.object({ scene_id: idSchema, name: nameSchema }).strict(),
  summary(args, snap) {
    return `Renamed scene "${labelOfScene(snap, args.scene_id)}" to "${args.name}"`;
  },
  touches(args) {
    return [sceneRef(args.scene_id)];
  },
  apply(doc, args) {
    const scene = requireScene(doc, args.scene_id);
    const ref = sceneRef(args.scene_id);
    const before = fieldValue(scene, "name");
    scene.set("name", args.name);
    return { before: { [fieldKey(ref, "name")]: before }, after: { [fieldKey(ref, "name")]: args.name } };
  },
});

defineCommand({
  id: "scene.remove",
  title: "Remove a scene and its clips",
  schema: z.object({ scene_id: idSchema }).strict(),
  summary(args, snap) {
    const clips = Object.values(snap.clips).filter((clip) => clip.scene_id === args.scene_id);
    return clips.length === 0
      ? `Removed scene "${labelOfScene(snap, args.scene_id)}"`
      : `Removed scene "${labelOfScene(snap, args.scene_id)}" and its ${clipsText(clips.length)}`;
  },
  touches(args, snap) {
    const refs = [sceneRef(args.scene_id)];
    for (const clip of Object.values(snap.clips)) {
      if (clip.scene_id !== args.scene_id) continue;
      refs.push(clipRef(clip.id));
      refs.push(trackRef(clip.track_id));
      refs.push(...takeRefsOfClip(snap, clip.id));
      refs.push(...placementRefsOfClip(snap, clip.id));
      refs.push(...samplerRefsOfClip(snap, clip.id));
    }
    return refs;
  },
  apply(doc, args) {
    const index = findSceneIndex(doc, args.scene_id);
    if (index < 0) throw new StudioError("not_found", `There is no scene "${args.scene_id}" in this song.`);
    const scene = getScene(doc, args.scene_id);
    const clips = clipEntries(doc).filter(({ clip }) => clip.get("scene_id") === args.scene_id);
    const scenes = sceneList(doc);
    const previous = index > 0 ? scenes.get(index - 1) : null;
    const next = index + 1 < scenes.length ? scenes.get(index + 1) : null;

    const before = {
      [fieldKey(sceneRef(args.scene_id), "*")]: {
        ...cloneJson(toPlain(scene)),
        _index: index,
        _after: siblingBefore(previous),
        _before: siblingAfter(next),
      },
    };
    const after = { [fieldKey(sceneRef(args.scene_id), "*")]: ABSENT };
    for (const { id, clip } of clips) {
      before[fieldKey(clipRef(id), "*")] = cloneJson(toPlain(clip));
      after[fieldKey(clipRef(id), "*")] = ABSENT;
    }
    // The clips' takes, their patterns and steps, and the placements that put
    // those clips on the timeline go with them, captured for the same undo step.
    const removedClips = new Set(clips.map(({ id }) => id));
    removeTakes(doc, removedClips, before, after);
    removePlacements(doc, { clipIds: removedClips }, before, after);
    removeSamplerObjects(doc, { clipIds: removedClips }, before, after);

    const clipsMap = clipMap(doc);
    for (const { id } of clips) clipsMap.delete(id);
    sceneList(doc).delete(index, 1);
    return { before, after };
  },
});

// --- Clips ------------------------------------------------------------------

defineCommand({
  id: "clip.write",
  title: "Write a clip's notes (creates it, or replaces its notes)",
  idField: "clip_id",
  schema: z
    .object({
      clip_id: idSchema.optional().describe("the clip to replace; a new clip is created when omitted"),
      track_id: idSchema.describe("the track the clip plays on"),
      scene_id: idSchema.describe("the scene the clip sits in"),
      name: nameSchema,
      length_bars: z.number().int().min(1).optional().describe("clip length in bars; derived from the notes when omitted"),
      notes: z.array(noteSchema),
    })
    .strict(),
  summary(args, snap) {
    const bars = args.length_bars ?? lengthForNotes(args.notes);
    return `Wrote "${args.name}" (${barsText(bars)}) on ${labelOfTrack(snap, args.track_id)}, ${labelOfScene(snap, args.scene_id)}`;
  },
  touches(args) {
    return [clipRef(args.clip_id), trackRef(args.track_id)];
  },
  apply(doc, args) {
    const track = requireTrack(doc, args.track_id);
    requireScene(doc, args.scene_id);
    const existingAudio = getClip(doc, args.clip_id);
    if (existingAudio) {
      refuseOnAudioClip(existingAudio);
      refuseOnPatternClip(existingAudio);
    }
    if (isAudioTrack(track)) {
      refuseInvalid(`Track "${track.get("name")}" is an audio track; use clip.add_audio to make a clip on it.`);
    }
    if (isSamplerTrack(track)) {
      refuseInvalid(
        `Track "${track.get("name")}" is a sampler track; use clip.add_pattern to make a pattern clip on it.`,
      );
    }

    if (args.notes.length > LIMITS.notesPerClip) {
      refuseLimit(`A clip can have at most ${LIMITS.notesPerClip} notes.`);
    }
    const lengthBars = args.length_bars ?? lengthForNotes(args.notes);
    if (lengthBars > LIMITS.clipBars) {
      refuseLimit(`A clip can be at most ${LIMITS.clipBars} bars long.`);
    }
    checkNotesFit(args.notes, lengthBars, args.name);

    const ref = clipRef(args.clip_id);
    const existing = getClip(doc, args.clip_id);
    if (existing) {
      const trackId = existing.get("track_id");
      if (trackId !== args.track_id || existing.get("scene_id") !== args.scene_id) {
        refuseInvalid(
          `Clip "${existing.get("name")}" is already placed on another track or scene; write the notes to a new clip id to move it.`,
        );
      }
      const before = {
        [fieldKey(ref, "name")]: fieldValue(existing, "name"),
        [fieldKey(ref, "length_bars")]: fieldValue(existing, "length_bars"),
        [fieldKey(ref, "notes")]: fieldValue(existing, "notes"),
      };
      const notes = cloneJson(args.notes);
      existing.set("name", args.name);
      existing.set("length_bars", lengthBars);
      existing.set("notes", notes);
      return {
        before,
        after: {
          [fieldKey(ref, "name")]: args.name,
          [fieldKey(ref, "length_bars")]: lengthBars,
          [fieldKey(ref, "notes")]: cloneJson(notes),
        },
      };
    }

    const clip = {
      id: args.clip_id,
      track_id: args.track_id,
      scene_id: args.scene_id,
      name: args.name,
      length_bars: lengthBars,
      notes: cloneJson(args.notes),
    };
    clipMap(doc).set(clip.id, objectMap(clip));
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(clip) },
    };
  },
});

defineCommand({
  id: "clip.edit_notes",
  title: "Add, remove or move notes in a clip by index",
  schema: z
    .object({
      clip_id: idSchema,
      add: z.array(noteSchema).optional().describe("notes to append"),
      remove: z
        .array(z.number().int().min(0))
        .optional()
        .describe("indexes in the clip's note list to delete; indexes are the clip's own order"),
      move: z
        .array(
          z
            .object({
              index: z.number().int().min(0).describe("index after the removals have been applied"),
              t: z.number().finite().min(0).describe("new start, in beats"),
              d: z.number().finite().positive().optional().describe("new length, in beats"),
            })
            .strict(),
        )
        .optional()
        .describe("notes to retime"),
    })
    .strict()
    .refine(
      (args) => (args.add?.length ?? 0) + (args.remove?.length ?? 0) + (args.move?.length ?? 0) > 0,
      "clip.edit_notes needs at least one of add, remove or move",
    ),
  summary(args, snap) {
    const parts = [];
    if (args.add?.length) parts.push(`${args.add.length} added`);
    if (args.remove?.length) parts.push(`${args.remove.length} removed`);
    if (args.move?.length) parts.push(`${args.move.length} moved`);
    return `Edited "${labelOfClip(snap, args.clip_id)}": ${parts.join(", ")}`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [clipRef(args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireClip(doc, args.clip_id);
    refuseOnAudioClip(clip);
    refuseOnPatternClip(clip);
    const name = clip.get("name") ?? args.clip_id;
    const lengthBars = clip.get("length_bars") ?? 1;
    const limit = lengthBars * BEATS;
    const before = toPlain(clip.get("notes")) ?? [];

    let notes = cloneJson(before);
    if (args.remove?.length) {
      const drop = new Set();
      for (const index of args.remove) {
        if (index >= notes.length) {
          refuseInvalid(`There is no note at index ${index} in "${name}"; it has ${notes.length} notes.`);
        }
        drop.add(index);
      }
      notes = notes.filter((_, index) => !drop.has(index));
    }
    for (const move of args.move ?? []) {
      if (move.index >= notes.length) {
        refuseInvalid(`There is no note at index ${move.index} in "${name}" after the removals; it has ${notes.length} notes.`);
      }
      const note = { ...notes[move.index], t: move.t };
      if (move.d !== undefined) note.d = move.d;
      if (note.t + note.d > limit) {
        refuseInvalid(`The note at index ${move.index} would end at beat ${beatText(note.t + note.d)}, past the ${barsText(lengthBars)} of "${name}".`);
      }
      notes[move.index] = note;
    }
    if (args.add?.length) {
      const added = cloneJson(args.add);
      added.forEach((note, index) => {
        if (note.t + note.d > limit) {
          refuseInvalid(`Added note ${index + 1} ends at beat ${beatText(note.t + note.d)}, past the ${barsText(lengthBars)} of "${name}".`);
        }
      });
      notes = [...notes, ...added];
    }
    if (notes.length > LIMITS.notesPerClip) {
      refuseLimit(`A clip can have at most ${LIMITS.notesPerClip} notes.`);
    }

    clip.set("notes", notes);
    return {
      before: { [fieldKey(clipRef(args.clip_id), "notes")]: cloneJson(before) },
      after: { [fieldKey(clipRef(args.clip_id), "notes")]: cloneJson(notes) },
    };
  },
});

defineCommand({
  id: "clip.set_length",
  title: "Set a clip's length in bars",
  schema: z.object({ clip_id: idSchema, length_bars: z.number().int().min(1) }).strict(),
  summary(args, snap) {
    return `Set clip "${labelOfClip(snap, args.clip_id)}" to ${barsText(args.length_bars)}`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [clipRef(args.clip_id), ...placementRefsOfClip(snap, args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireClip(doc, args.clip_id);
    if (isPatternClip(clip)) {
      refuseInvalid(
        `Clip "${clip.get("name")}" is a pattern clip; its length comes from its steps, so set them with pattern.set_length.`,
      );
    }
    if (args.length_bars > LIMITS.clipBars) {
      refuseLimit(`A clip can be at most ${LIMITS.clipBars} bars long.`);
    }
    const name = clip.get("name") ?? args.clip_id;
    const ref = clipRef(args.clip_id);
    const lengthBeats = args.length_bars * BEATS;

    // An audio clip has no notes to fit, but its comp says which take plays
    // over which beats: a shorter clip cuts the segment that crosses its new
    // end and drops the ones that start past it.
    if (isAudioClip(clip)) {
      const beforeLength = fieldValue(clip, "length_bars");
      const beforeComp = fieldValue(clip, "comp") ?? [];
      const nextComp = clampComp(beforeComp, lengthBeats);
      const compChanged = JSON.stringify(nextComp) !== JSON.stringify(beforeComp);
      clip.set("length_bars", args.length_bars);
      const before = { [fieldKey(ref, "length_bars")]: beforeLength };
      const after = { [fieldKey(ref, "length_bars")]: args.length_bars };
      if (compChanged) {
        clip.set("comp", nextComp);
        before[fieldKey(ref, "comp")] = beforeComp;
        after[fieldKey(ref, "comp")] = cloneJson(nextComp);
      }
      // Its placements keep starting inside it: an offset past the new end
      // wraps into the shorter clip, in the same step.
      wrapPlacementOffsets(doc, args.clip_id, lengthBeats, before, after);
      return { before, after };
    }

    const notes = toPlain(clip.get("notes")) ?? [];
    for (const note of notes) {
      if (note.t + note.d > lengthBeats) {
        refuseInvalid(`Clip "${name}" has notes past ${barsText(args.length_bars)}; move or remove them first.`);
      }
    }
    const before = { [fieldKey(ref, "length_bars")]: fieldValue(clip, "length_bars") };
    const after = { [fieldKey(ref, "length_bars")]: args.length_bars };
    clip.set("length_bars", args.length_bars);
    wrapPlacementOffsets(doc, args.clip_id, lengthBeats, before, after);
    return { before, after };
  },
});

defineCommand({
  id: "clip.rename",
  title: "Rename a clip",
  schema: z.object({ clip_id: idSchema, name: nameSchema }).strict(),
  summary(args, snap) {
    return `Renamed clip "${labelOfClip(snap, args.clip_id)}" to "${args.name}"`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [clipRef(args.clip_id)];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireClip(doc, args.clip_id);
    const before = fieldValue(clip, "name");
    clip.set("name", args.name);
    return {
      before: { [fieldKey(clipRef(args.clip_id), "name")]: before },
      after: { [fieldKey(clipRef(args.clip_id), "name")]: args.name },
    };
  },
});

defineCommand({
  id: "clip.remove",
  title: "Remove a clip",
  schema: z.object({ clip_id: idSchema }).strict(),
  summary(args, snap) {
    const clip = snap.clips[args.clip_id];
    if (!clip) return `Removed clip "${args.clip_id}"`;
    return `Removed clip "${clip.name}" from ${labelOfTrack(snap, clip.track_id)}, ${labelOfScene(snap, clip.scene_id)}`;
  },
  touches(args, snap) {
    const clip = snap.clips[args.clip_id];
    const refs = [
      clipRef(args.clip_id),
      ...takeRefsOfClip(snap, args.clip_id),
      ...placementRefsOfClip(snap, args.clip_id),
      ...samplerRefsOfClip(snap, args.clip_id),
    ];
    if (clip) refs.push(trackRef(clip.track_id));
    return refs;
  },
  apply(doc, args) {
    const clip = requireClip(doc, args.clip_id);
    const ref = clipRef(args.clip_id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(clip)) };
    const after = { [fieldKey(ref, "*")]: ABSENT };
    // Its recorded takes go with it, captured for the same undo step, and so
    // do its patterns and steps and every placement that put it on the
    // timeline.
    removeTakes(doc, new Set([args.clip_id]), before, after);
    removePlacements(doc, { clipIds: new Set([args.clip_id]) }, before, after);
    removeSamplerObjects(doc, { clipIds: new Set([args.clip_id]) }, before, after);
    clipMap(doc).delete(args.clip_id);
    return { before, after };
  },
});

// --- Summary helpers over a plain snapshot ----------------------------------

/** @returns {object|null} the track in a snapshot, by id. */
function trackOf(snap, id) {
  return snap.tracks.find((track) => track.id === id) ?? null;
}

/** @returns {object|null} the scene in a snapshot, by id. */
function sceneOf(snap, id) {
  return snap.scenes.find((scene) => scene.id === id) ?? null;
}

/** @returns {string} a track's name for a summary, or its id when unknown. */
function labelOfTrack(snap, id) {
  return trackOf(snap, id)?.name ?? id;
}

/** @returns {string} a scene's name for a summary, or its id when unknown. */
function labelOfScene(snap, id) {
  return sceneOf(snap, id)?.name ?? id;
}

/** @returns {string} a clip's name for a summary, or its id when unknown. */
function labelOfClip(snap, id) {
  return snap.clips[id]?.name ?? id;
}

/** @returns {string} a library entry's name for a summary, or its id when unknown. */
function labelOfFont(snap, id) {
  return snap.library?.[id]?.name ?? id;
}

/** @returns {object} a device param record, safe to spread. */
function paramsDefaults(params) {
  return params && typeof params === "object" ? params : {};
}