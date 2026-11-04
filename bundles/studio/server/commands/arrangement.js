/**
 * The Studio 1b arrangement commands: the song laid out on a timeline instead
 * of in scenes.
 *
 * Importing this module registers them, exactly as `core.js` does. The ids are
 * the contract between the panel, the MCP tools and the shared history:
 *
 *   arrangement.place  arrangement.move  arrangement.resize  arrangement.split
 *   arrangement.set_fades  arrangement.remove  arrangement.record_performance
 *   marker.add  marker.rename  marker.remove
 *   section.add  section.set  section.remove
 *
 * The song's `arrangement` holds three maps (see doc.js): `placements` (a clip
 * on a track at a bar, with the offset into the clip and its fades),
 * `markers` (one bar with a name) and `sections` (a range of bars with a name).
 * Each one is its own object with its own ref — `placement:<id>`,
 * `marker:<id>`, `section:<id>` — so two steps that touch two placements undo
 * independently, the way two takes do.
 *
 * Every `apply` validates everything it needs before it writes anything, so a
 * refusal (a limit, an unknown clip, an overlap on a track) leaves the document
 * exactly as it was. The rules the whole song must keep are also checked by
 * `checkInvariants()` (doc.js), because that is what the history dry-runs an
 * undo against:
 *
 *   - placements on one track never overlap;
 *   - a placement plays a clip of its own track;
 *   - nothing on the timeline runs past bar 999;
 *   - an arrangement holds at most 2048 placements, a song 256 markers and 128
 *     sections;
 *   - sections never overlap each other.
 *
 * None of these is people-only or Studio's own: the operator and the agent lay
 * the song out the same way, under the same lock checks (a placement maps to
 * its track for the lock check, so a locked track's placements are off-limits
 * to an agent).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { addLimitIssue, defineCommand, StudioError } from "./registry.js";
import {
  BEATS_PER_BAR,
  LIMITS,
  cloneJson,
  getClip,
  getMarker,
  getPlacement,
  getSection,
  getTrack,
  markerEntries,
  markerMap,
  objectMap,
  objectRef,
  onOffsetGrid,
  placementEntries,
  placementMap,
  sectionEntries,
  sectionMap,
  toPlain,
} from "../doc.js";

/** Beats in one bar, phase 1b. */
const BEATS = BEATS_PER_BAR;

/** Names (markers and sections) are 1-80 characters. */
const MAX_NAME = 80;

/**
 * The value a before/after entry carries when the object did not exist.
 * `null`, not `undefined`: a history entry is stored as JSON, which drops
 * `undefined` keys (see doc.js).
 */
const ABSENT = null;

/** A placement, marker or section id: 1-40 letters, digits, dashes or underscores. */
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "an id is 1-40 letters, digits, dashes or underscores");

const nameSchema = z.string().min(1).max(MAX_NAME);

/** @returns {string} the key a before/after map files one field under. */
function fieldKey(ref, field) {
  return `${ref}|${field}`;
}

/** @returns {string} the ref of a placement. */
function placementRef(id) {
  return objectRef("placement", id);
}

/** @returns {string} the ref of a marker. */
function markerRef(id) {
  return objectRef("marker", id);
}

/** @returns {string} the ref of a section. */
function sectionRef(id) {
  return objectRef("section", id);
}

/** @returns {string} the ref of a track. */
function trackRef(id) {
  return objectRef("track", id);
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

/** @returns {number} a clip's length in bars, at least one. */
function clipBars(clip) {
  const bars = Number(clip?.get?.("length_bars"));
  return Number.isInteger(bars) && bars >= 1 ? bars : 1;
}

/** @returns {number} a clip's length in beats. */
function clipLengthBeats(clip) {
  return clipBars(clip) * BEATS;
}

/** @returns {number} `value` folded into `[0, length)`. */
function modulo(value, length) {
  if (!(length > 0)) return 0;
  return ((value % length) + length) % length;
}

/** @returns {string} a track's name for a message, or its id when unknown. */
function labelOfTrack(snap, id) {
  return snap.tracks.find((track) => track.id === id)?.name ?? id;
}

/** @returns {string} a clip's name for a message, or its id when unknown. */
function labelOfClip(snap, id) {
  return snap.clips[id]?.name ?? id;
}

/** @returns {object|null} one placement from a snapshot, or null. */
function placementOf(snap, id) {
  return snap.arrangement?.placements?.[id] ?? null;
}

/** @returns {object|null} one marker from a snapshot, or null. */
function markerOf(snap, id) {
  return snap.arrangement?.markers?.[id] ?? null;
}

/** @returns {object|null} one section from a snapshot, or null. */
function sectionOf(snap, id) {
  return snap.arrangement?.sections?.[id] ?? null;
}

/** @returns {Y.Map<any>} the live track, or a "not_found" refusal. */
function requireTrack(doc, id) {
  const track = getTrack(doc, id);
  if (!track) throw new StudioError("not_found", `There is no track "${id}" in this song.`);
  return track;
}

/** @returns {Y.Map<any>} the live clip, or a "not_found" refusal. */
function requireClip(doc, id) {
  const clip = getClip(doc, id);
  if (!clip) throw new StudioError("not_found", `There is no clip "${id}" in this song.`);
  return clip;
}

/** @returns {Y.Map<any>} the live placement, or a "not_found" refusal. */
function requirePlacement(doc, id) {
  const placement = getPlacement(doc, id);
  if (!placement) throw new StudioError("not_found", `There is no placement "${id}" in this song.`);
  return placement;
}

/** @returns {Y.Map<any>} the live marker, or a "not_found" refusal. */
function requireMarker(doc, id) {
  const marker = getMarker(doc, id);
  if (!marker) throw new StudioError("not_found", `There is no marker "${id}" in this song.`);
  return marker;
}

/** @returns {Y.Map<any>} the live section, or a "not_found" refusal. */
function requireSection(doc, id) {
  const section = getSection(doc, id);
  if (!section) throw new StudioError("not_found", `There is no section "${id}" in this song.`);
  return section;
}

/**
 * Refuse a placement whose clip belongs to another track.
 *
 * A placement plays a clip of its own track: a clip has one track, so moving a
 * placement to a different track is only allowed when that is the clip's own
 * track.
 * @param {Y.Map<any>} clip
 * @param {string} trackId
 * @returns {void}
 */
function checkClipOnTrack(clip, trackId) {
  if (clip.get("track_id") === trackId) return;
  refuseInvalid(
    `Clip "${clip.get("name")}" belongs to track "${clip.get("track_id")}", not "${trackId}"; a placement only plays a clip of its own track.`,
  );
}

/**
 * Check one placement against the bar limits of the arrangement and against
 * the clip it plays, throwing a refusal that names the limit or the problem.
 * @param {Y.Map<any>} clip
 * @param {{start_bar: number, bars: number, offset_beats: number,
 *          fade_in_beats: number, fade_out_beats: number}} placement
 * @returns {void}
 */
function checkPlacementFit(clip, placement) {
  const end = placement.start_bar + placement.bars;
  if (end > LIMITS.arrangementBars) {
    refuseLimit(
      `The arrangement ends at bar ${LIMITS.arrangementBars}; this placement would end at bar ${end}.`,
    );
  }
  const length = clipLengthBeats(clip);
  if (!(placement.offset_beats >= 0) || placement.offset_beats >= length) {
    refuseInvalid(
      `A placement starts inside its clip, so its offset is under the ${barsText(clipBars(clip))} of "${clip.get("name")}"; ${beatText(placement.offset_beats)} beats is not.`,
    );
  }
  if (!onOffsetGrid(placement.offset_beats)) {
    refuseInvalid(
      `A placement's offset is on the sixteenth-of-a-beat grid; ${beatText(placement.offset_beats)} beats is not.`,
    );
  }
  if (!(placement.fade_in_beats >= 0) || !(placement.fade_out_beats >= 0)) {
    refuseInvalid("A fade is 0 beats or more; a negative fade has no meaning.");
  }
  if (placement.fade_in_beats + placement.fade_out_beats > placement.bars * BEATS) {
    refuseInvalid(
      `A placement fades over at most its own length: ${barsText(placement.bars)} is ${placement.bars * BEATS} beats, and this one would fade in over ${beatText(placement.fade_in_beats)} and out over ${beatText(placement.fade_out_beats)}.`,
    );
  }
}

/** @returns {{start: number, end: number}} the bars a live placement covers. */
function liveRange(placement) {
  const start = Number(placement.get("start_bar"));
  const bars = Number(placement.get("bars"));
  return { start, end: start + (Number.isFinite(bars) ? bars : 0) };
}

/** @returns {boolean} whether two half-open bar ranges share a bar. */
function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Refuse a placement that would sit on top of another placement on its track.
 *
 * `candidate` names its own id, which is left out of the scan: moving or
 * resizing a placement must not collide with itself.
 * @param {Y.Doc} doc
 * @param {{id: string, track_id: string, start_bar: number, bars: number}} candidate
 * @returns {void}
 */
function checkFreeLane(doc, candidate) {
  const range = { start: candidate.start_bar, end: candidate.start_bar + candidate.bars };
  for (const { id, placement } of placementEntries(doc)) {
    if (id === candidate.id) continue;
    if (placement.get("track_id") !== candidate.track_id) continue;
    const other = liveRange(placement);
    if (!rangesOverlap(range, other)) continue;
    const trackName = getTrack(doc, candidate.track_id)?.get?.("name") ?? candidate.track_id;
    const clip = getClip(doc, placement.get("clip_id"));
    const clipName = clip?.get?.("name") ?? placement.get("clip_id");
    refuseInvalid(
      `A placement of clip "${clipName}" already runs from bar ${other.start} to bar ${other.end} on track "${trackName}"; placements on one track cannot overlap.`,
    );
  }
}

/** @returns {string} a placement's clip and bar for a summary line. */
function placementLabel(snap, id) {
  const placement = placementOf(snap, id);
  if (!placement) return id;
  return `clip "${labelOfClip(snap, placement.clip_id)}" (bar ${placement.start_bar})`;
}

/** One placement of a recorded performance. */
const performedSchema = z
  .object({
    id: idSchema.optional().describe("your id for the placement; one is generated when omitted"),
    track_id: idSchema.describe("the track it was played on"),
    clip_id: idSchema.describe("the clip it plays; the clip must belong to that track"),
    start_bar: z.number().int().min(0).describe("the bar it starts at, from 0"),
    bars: z.number().int().min(1).describe("how many bars it lasts"),
  })
  .strict();

// --- Placements -------------------------------------------------------------

defineCommand({
  id: "arrangement.place",
  title: "Place a clip on the timeline",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("your id for the placement; one is generated when omitted"),
      track_id: idSchema.describe("the track the placement sits on"),
      clip_id: idSchema.describe("the clip it plays; the clip must belong to that track"),
      start_bar: z.number().int().min(0).describe("the bar it starts at, from 0; the timeline starts at bar 0"),
      bars: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("how many bars it lasts; the clip's own length when omitted"),
    })
    .strict(),
  summary(args, snap) {
    const bars = args.bars ?? snap.clips[args.clip_id]?.length_bars ?? 1;
    return `Placed clip "${labelOfClip(snap, args.clip_id)}" at bar ${args.start_bar} on ${labelOfTrack(snap, args.track_id)} (${barsText(bars)})`;
  },
  touches(args) {
    return [placementRef(args.id), trackRef(args.track_id)];
  },
  apply(doc, args) {
    requireTrack(doc, args.track_id);
    const clip = requireClip(doc, args.clip_id);
    checkClipOnTrack(clip, args.track_id);
    if (getPlacement(doc, args.id)) {
      refuseInvalid(`A placement with id "${args.id}" already exists in this song.`);
    }
    if (placementEntries(doc).length >= LIMITS.placements) {
      refuseLimit(`An arrangement can hold at most ${LIMITS.placements} placements.`);
    }

    const placement = {
      id: args.id,
      track_id: args.track_id,
      clip_id: args.clip_id,
      start_bar: args.start_bar,
      bars: args.bars ?? clipBars(clip),
      offset_beats: 0,
      fade_in_beats: 0,
      fade_out_beats: 0,
    };
    checkPlacementFit(clip, placement);
    checkFreeLane(doc, placement);

    placementMap(doc).set(placement.id, objectMap(placement));
    const ref = placementRef(placement.id);
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(placement) },
    };
  },
});

defineCommand({
  id: "arrangement.move",
  title: "Move a placement to another bar or track",
  schema: z
    .object({
      id: idSchema.describe("the placement to move"),
      start_bar: z.number().int().min(0).optional().describe("the bar it now starts at, from 0"),
      track_id: idSchema.optional().describe("the track it now sits on; the clip must belong to it"),
    })
    .strict()
    .refine(
      (args) => args.start_bar !== undefined || args.track_id !== undefined,
      "arrangement.move needs start_bar, track_id or both",
    ),
  summary(args, snap) {
    const placement = placementOf(snap, args.id);
    const at = args.start_bar ?? placement?.start_bar ?? 0;
    const track = args.track_id ?? placement?.track_id ?? "";
    return `Moved the placement of ${placementLabel(snap, args.id)} to bar ${at} on ${labelOfTrack(snap, track)}`;
  },
  touches(args) {
    return args.track_id === undefined
      ? [placementRef(args.id)]
      : [placementRef(args.id), trackRef(args.track_id)];
  },
  apply(doc, args) {
    const placement = requirePlacement(doc, args.id);
    const clip = requireClip(doc, placement.get("clip_id"));
    const currentStart = Number(placement.get("start_bar"));
    const currentTrack = placement.get("track_id");
    const startBar = args.start_bar ?? currentStart;
    const trackId = args.track_id ?? currentTrack;

    if (trackId !== currentTrack) {
      requireTrack(doc, trackId);
      checkClipOnTrack(clip, trackId);
    }

    const next = {
      id: args.id,
      track_id: trackId,
      start_bar: startBar,
      bars: Number(placement.get("bars")),
      offset_beats: Number(placement.get("offset_beats")),
      fade_in_beats: Number(placement.get("fade_in_beats")) || 0,
      fade_out_beats: Number(placement.get("fade_out_beats")) || 0,
    };
    checkPlacementFit(clip, next);
    checkFreeLane(doc, next);

    const ref = placementRef(args.id);
    const before = {};
    const after = {};
    if (startBar !== currentStart) {
      before[fieldKey(ref, "start_bar")] = currentStart;
      after[fieldKey(ref, "start_bar")] = startBar;
      placement.set("start_bar", startBar);
    }
    if (trackId !== currentTrack) {
      before[fieldKey(ref, "track_id")] = currentTrack;
      after[fieldKey(ref, "track_id")] = trackId;
      placement.set("track_id", trackId);
    }
    return { before, after };
  },
});

defineCommand({
  id: "arrangement.resize",
  title: "Make a placement longer or shorter",
  schema: z
    .object({
      id: idSchema.describe("the placement to resize"),
      bars: z.number().int().min(1).describe("its new length in bars"),
    })
    .strict(),
  summary(args, snap) {
    return `Resized the placement of ${placementLabel(snap, args.id)} to ${barsText(args.bars)}`;
  },
  touches(args) {
    return [placementRef(args.id)];
  },
  apply(doc, args) {
    const placement = requirePlacement(doc, args.id);
    const clip = requireClip(doc, placement.get("clip_id"));
    const currentBars = Number(placement.get("bars"));
    const next = {
      id: args.id,
      track_id: placement.get("track_id"),
      start_bar: Number(placement.get("start_bar")),
      bars: args.bars,
      offset_beats: Number(placement.get("offset_beats")),
      fade_in_beats: Number(placement.get("fade_in_beats")) || 0,
      fade_out_beats: Number(placement.get("fade_out_beats")) || 0,
    };
    checkPlacementFit(clip, next);
    checkFreeLane(doc, next);
    placement.set("bars", args.bars);
    const ref = placementRef(args.id);
    return {
      before: { [fieldKey(ref, "bars")]: currentBars },
      after: { [fieldKey(ref, "bars")]: args.bars },
    };
  },
});

defineCommand({
  id: "arrangement.split",
  title: "Split a placement in two at a bar",
  schema: z
    .object({
      id: idSchema.describe("the placement to split"),
      at_bar: z
        .number()
        .int()
        .min(1)
        .describe("the bar line it splits on; it has to be strictly inside the placement"),
      new_id: idSchema
        .optional()
        .describe("your id for the second half; one is generated when omitted"),
    })
    .strict(),
  summary(args, snap) {
    return `Split the placement of ${placementLabel(snap, args.id)} at bar ${args.at_bar}`;
  },
  touches(args) {
    return args.new_id === undefined
      ? [placementRef(args.id)]
      : [placementRef(args.id), placementRef(args.new_id)];
  },
  /**
   * The first half keeps the id, its fades on the outside and its offset; the
   * second half gets a new id, starts at the split, and continues the clip
   * where the first one stopped — so the two together play exactly what the one
   * placement played, without a gap or a repeat. The fades on the new inner
   * edge are 0: a split is not a crossfade.
   */
  apply(doc, args) {
    const placement = requirePlacement(doc, args.id);
    const clip = requireClip(doc, placement.get("clip_id"));
    const start = Number(placement.get("start_bar"));
    const bars = Number(placement.get("bars"));
    if (!(args.at_bar > start && args.at_bar < start + bars)) {
      refuseInvalid(
        `A split happens inside the placement: this one runs from bar ${start} to bar ${start + bars}, and bar ${args.at_bar} is not strictly inside it.`,
      );
    }
    const secondId = args.new_id ?? randomUUID();
    if (getPlacement(doc, secondId)) {
      refuseInvalid(`A placement with id "${secondId}" already exists in this song.`);
    }
    if (placementEntries(doc).length >= LIMITS.placements) {
      refuseLimit(`An arrangement can hold at most ${LIMITS.placements} placements.`);
    }

    const offset = Number(placement.get("offset_beats")) || 0;
    const oldFadeIn = Number(placement.get("fade_in_beats")) || 0;
    const oldFadeOut = Number(placement.get("fade_out_beats")) || 0;
    const firstBars = args.at_bar - start;
    const secondBars = start + bars - args.at_bar;
    const trackId = placement.get("track_id");

    const first = {
      id: args.id,
      track_id: trackId,
      start_bar: start,
      bars: firstBars,
      offset_beats: offset,
      fade_in_beats: oldFadeIn,
      fade_out_beats: 0,
    };
    const second = {
      id: secondId,
      track_id: trackId,
      clip_id: placement.get("clip_id"),
      start_bar: args.at_bar,
      bars: secondBars,
      offset_beats: modulo(offset + firstBars * BEATS, clipLengthBeats(clip)),
      fade_in_beats: 0,
      fade_out_beats: oldFadeOut,
    };
    checkPlacementFit(clip, first);
    checkPlacementFit(clip, second);

    // The two halves exactly fill the space the one placement had, so the only
    // lane that can matter is the first half's own: it was checked when the
    // placement was placed and neither half grows past the old range.
    placement.set("bars", firstBars);
    placement.set("fade_out_beats", 0);
    placementMap(doc).set(second.id, objectMap(second));

    const ref = placementRef(args.id);
    const secondRef = placementRef(second.id);
    const before = {
      [fieldKey(ref, "bars")]: bars,
      [fieldKey(secondRef, "*")]: ABSENT,
    };
    const after = {
      [fieldKey(ref, "bars")]: firstBars,
      [fieldKey(secondRef, "*")]: cloneJson(second),
    };
    if (oldFadeOut !== 0) {
      before[fieldKey(ref, "fade_out_beats")] = oldFadeOut;
      after[fieldKey(ref, "fade_out_beats")] = 0;
    }
    return { before, after };
  },
});

defineCommand({
  id: "arrangement.set_fades",
  title: "Set a placement's fade in and fade out",
  schema: z
    .object({
      id: idSchema.describe("the placement whose fades to set"),
      fade_in_beats: z.number().finite().min(0).describe("the linear fade in, in beats"),
      fade_out_beats: z.number().finite().min(0).describe("the linear fade out, in beats"),
    })
    .strict(),
  summary(args, snap) {
    return `Faded the placement of ${placementLabel(snap, args.id)} in over ${beatText(args.fade_in_beats)} and out over ${beatText(args.fade_out_beats)} beats`;
  },
  touches(args) {
    return [placementRef(args.id)];
  },
  apply(doc, args) {
    const placement = requirePlacement(doc, args.id);
    const clip = requireClip(doc, placement.get("clip_id"));
    const next = {
      id: args.id,
      track_id: placement.get("track_id"),
      start_bar: Number(placement.get("start_bar")),
      bars: Number(placement.get("bars")),
      offset_beats: Number(placement.get("offset_beats")) || 0,
      fade_in_beats: args.fade_in_beats,
      fade_out_beats: args.fade_out_beats,
    };
    checkPlacementFit(clip, next);

    const ref = placementRef(args.id);
    const beforeIn = Number(placement.get("fade_in_beats")) || 0;
    const beforeOut = Number(placement.get("fade_out_beats")) || 0;
    placement.set("fade_in_beats", args.fade_in_beats);
    placement.set("fade_out_beats", args.fade_out_beats);
    return {
      before: {
        [fieldKey(ref, "fade_in_beats")]: beforeIn,
        [fieldKey(ref, "fade_out_beats")]: beforeOut,
      },
      after: {
        [fieldKey(ref, "fade_in_beats")]: args.fade_in_beats,
        [fieldKey(ref, "fade_out_beats")]: args.fade_out_beats,
      },
    };
  },
});

defineCommand({
  id: "arrangement.remove",
  title: "Remove a placement from the timeline",
  schema: z.object({ id: idSchema.describe("the placement to remove") }).strict(),
  summary(args, snap) {
    return `Removed the placement of ${placementLabel(snap, args.id)}`;
  },
  touches(args) {
    return [placementRef(args.id)];
  },
  apply(doc, args) {
    const placement = requirePlacement(doc, args.id);
    const ref = placementRef(args.id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(placement)) };
    placementMap(doc).delete(args.id);
    return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
  },
});

defineCommand({
  id: "arrangement.record_performance",
  title: "Write a recorded performance into the timeline",
  schema: z
    .object({
      placements: z
        .array(performedSchema)
        .min(1)
        .describe("what the performance played, in the order it was played"),
    })
    .strict(),
  summary(args) {
    const count = args.placements.length;
    return count === 1
      ? "Wrote a recorded performance into the timeline: 1 placement"
      : `Wrote a recorded performance into the timeline: ${count} placements`;
  },
  touches(args) {
    const refs = [];
    for (const item of args.placements) {
      if (typeof item.id === "string" && item.id !== "") refs.push(placementRef(item.id));
      refs.push(trackRef(item.track_id));
    }
    return refs;
  },
  /**
   * All-or-nothing: everything the performance would place is checked first
   * (its clip on its track, the bar limits, the placement cap, the overlaps
   * with the song and inside the performance itself) and only then written, so
   * a performance that cannot land whole lands not at all, as one step.
   */
  apply(doc, args) {
    const existing = placementEntries(doc).length;
    if (existing + args.placements.length > LIMITS.placements) {
      refuseLimit(`An arrangement can hold at most ${LIMITS.placements} placements.`);
    }

    const built = [];
    const seen = new Set();
    for (const item of args.placements) {
      requireTrack(doc, item.track_id);
      const clip = requireClip(doc, item.clip_id);
      checkClipOnTrack(clip, item.track_id);
      const id = item.id ?? randomUUID();
      if (getPlacement(doc, id) || seen.has(id)) {
        refuseInvalid(`A placement with id "${id}" already exists in this song.`);
      }
      seen.add(id);
      const placement = {
        id,
        track_id: item.track_id,
        clip_id: item.clip_id,
        start_bar: item.start_bar,
        bars: item.bars,
        offset_beats: 0,
        fade_in_beats: 0,
        fade_out_beats: 0,
      };
      checkPlacementFit(clip, placement);
      checkFreeLane(doc, placement);
      for (const other of built) {
        if (other.track_id !== placement.track_id) continue;
        const a = { start: other.start_bar, end: other.start_bar + other.bars };
        const b = { start: placement.start_bar, end: placement.start_bar + placement.bars };
        if (!rangesOverlap(a, b)) continue;
        refuseInvalid(
          `Two placements of this performance would overlap on track "${labelOfTrackId(doc, placement.track_id)}": the ones at bar ${other.start_bar} and bar ${placement.start_bar}.`,
        );
      }
      built.push(placement);
    }

    const map = placementMap(doc);
    const before = {};
    const after = {};
    for (const placement of built) {
      map.set(placement.id, objectMap(placement));
      const ref = placementRef(placement.id);
      before[fieldKey(ref, "*")] = ABSENT;
      after[fieldKey(ref, "*")] = cloneJson(placement);
    }
    return { before, after };
  },
});

/** @returns {string} a track's name read from the live document, or its id. */
function labelOfTrackId(doc, id) {
  return getTrack(doc, id)?.get?.("name") ?? id;
}

// --- Markers ----------------------------------------------------------------

defineCommand({
  id: "marker.add",
  title: "Add a marker at a bar",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("your id for the marker; one is generated when omitted"),
      bar: z.number().int().min(0).describe("the bar it marks, from 0"),
      name: nameSchema.describe("what the marker says"),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.bar > LIMITS.arrangementBars) {
        addLimitIssue(
          ctx,
          `The arrangement ends at bar ${LIMITS.arrangementBars}; a marker marks a bar from 0 to ${LIMITS.arrangementBars}.`,
        );
      }
    }),
  summary(args) {
    return `Added marker "${args.name}" at bar ${args.bar}`;
  },
  touches(args) {
    return [markerRef(args.id)];
  },
  apply(doc, args) {
    if (getMarker(doc, args.id)) {
      refuseInvalid(`A marker with id "${args.id}" already exists in this song.`);
    }
    if (markerEntries(doc).length >= LIMITS.markers) {
      refuseLimit(`A song can hold at most ${LIMITS.markers} markers.`);
    }
    const marker = { id: args.id, bar: args.bar, name: args.name };
    markerMap(doc).set(marker.id, objectMap(marker));
    const ref = markerRef(marker.id);
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(marker) },
    };
  },
});

defineCommand({
  id: "marker.rename",
  title: "Rename a marker",
  schema: z
    .object({ id: idSchema.describe("the marker to rename"), name: nameSchema.describe("what it says now") })
    .strict(),
  summary(args, snap) {
    return `Renamed marker "${markerOf(snap, args.id)?.name ?? args.id}" to "${args.name}"`;
  },
  touches(args) {
    return [markerRef(args.id)];
  },
  apply(doc, args) {
    const marker = requireMarker(doc, args.id);
    const ref = markerRef(args.id);
    const before = typeof marker.get("name") === "string" ? marker.get("name") : ABSENT;
    marker.set("name", args.name);
    return { before: { [fieldKey(ref, "name")]: before }, after: { [fieldKey(ref, "name")]: args.name } };
  },
});

defineCommand({
  id: "marker.remove",
  title: "Remove a marker",
  schema: z.object({ id: idSchema.describe("the marker to remove") }).strict(),
  summary(args, snap) {
    return `Removed marker "${markerOf(snap, args.id)?.name ?? args.id}"`;
  },
  touches(args) {
    return [markerRef(args.id)];
  },
  apply(doc, args) {
    const marker = requireMarker(doc, args.id);
    const ref = markerRef(args.id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(marker)) };
    markerMap(doc).delete(args.id);
    return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
  },
});

// --- Sections ---------------------------------------------------------------

/**
 * Check a section's range: it ends after it starts, and inside the last bar of
 * the arrangement.
 * @param {number} startBar
 * @param {number} endBar
 * @returns {void}
 */
function checkSectionRange(startBar, endBar) {
  if (!(startBar < endBar)) {
    refuseInvalid(`A section ends after it starts: this one would run from bar ${startBar} to bar ${endBar}.`);
  }
  if (endBar > LIMITS.arrangementBars) {
    refuseLimit(
      `The arrangement ends at bar ${LIMITS.arrangementBars}; this section would end at bar ${endBar}.`,
    );
  }
}

/**
 * Refuse a section that would overlap another one.
 * @param {Y.Doc} doc
 * @param {number} startBar
 * @param {number} endBar
 * @param {string|null} exceptId - the section being moved, left out of the scan
 * @returns {void}
 */
function checkSectionsClear(doc, startBar, endBar, exceptId = null) {
  const range = { start: startBar, end: endBar };
  for (const { id, section } of sectionEntries(doc)) {
    if (id === exceptId) continue;
    const other = { start: Number(section.get("start_bar")), end: Number(section.get("end_bar")) };
    if (!rangesOverlap(range, other)) continue;
    refuseInvalid(
      `The section "${section.get("name")}" already runs from bar ${other.start} to bar ${other.end}; sections cannot overlap.`,
    );
  }
}

defineCommand({
  id: "section.add",
  title: "Add a section of bars",
  idField: "id",
  schema: z
    .object({
      id: idSchema.optional().describe("your id for the section; one is generated when omitted"),
      start_bar: z.number().int().min(0).describe("the first bar of the section"),
      end_bar: z.number().int().min(1).describe("the bar it ends on, not included; after start_bar"),
      name: nameSchema.describe("what the section is called"),
    })
    .strict()
    .superRefine((args, ctx) => {
      if (args.end_bar > LIMITS.arrangementBars) {
        addLimitIssue(
          ctx,
          `The arrangement ends at bar ${LIMITS.arrangementBars}; a section ends at bar ${LIMITS.arrangementBars} or earlier.`,
        );
      }
    }),
  summary(args) {
    return `Added section "${args.name}" from bar ${args.start_bar} to bar ${args.end_bar}`;
  },
  touches(args) {
    return [sectionRef(args.id)];
  },
  apply(doc, args) {
    checkSectionRange(args.start_bar, args.end_bar);
    if (getSection(doc, args.id)) {
      refuseInvalid(`A section with id "${args.id}" already exists in this song.`);
    }
    if (sectionEntries(doc).length >= LIMITS.sections) {
      refuseLimit(`A song can hold at most ${LIMITS.sections} sections.`);
    }
    checkSectionsClear(doc, args.start_bar, args.end_bar);
    const section = {
      id: args.id,
      start_bar: args.start_bar,
      end_bar: args.end_bar,
      name: args.name,
    };
    sectionMap(doc).set(section.id, objectMap(section));
    const ref = sectionRef(section.id);
    return {
      before: { [fieldKey(ref, "*")]: ABSENT },
      after: { [fieldKey(ref, "*")]: cloneJson(section) },
    };
  },
});

defineCommand({
  id: "section.set",
  title: "Change a section's bars or name",
  schema: z
    .object({
      id: idSchema.describe("the section to change"),
      start_bar: z.number().int().min(0).optional().describe("its new first bar"),
      end_bar: z.number().int().min(1).optional().describe("its new end bar, not included"),
      name: nameSchema.optional().describe("its new name"),
    })
    .strict()
    .refine(
      (args) => args.start_bar !== undefined || args.end_bar !== undefined || args.name !== undefined,
      "section.set needs start_bar, end_bar or name",
    )
    .superRefine((args, ctx) => {
      if (args.end_bar !== undefined && args.end_bar > LIMITS.arrangementBars) {
        addLimitIssue(
          ctx,
          `The arrangement ends at bar ${LIMITS.arrangementBars}; a section ends at bar ${LIMITS.arrangementBars} or earlier.`,
        );
      }
    }),
  summary(args, snap) {
    const section = sectionOf(snap, args.id);
    const start = args.start_bar ?? section?.start_bar ?? 0;
    const end = args.end_bar ?? section?.end_bar ?? 0;
    return `Set section "${args.name ?? section?.name ?? args.id}" to bars ${start}-${end}`;
  },
  touches(args) {
    return [sectionRef(args.id)];
  },
  apply(doc, args) {
    const section = requireSection(doc, args.id);
    const currentStart = Number(section.get("start_bar"));
    const currentEnd = Number(section.get("end_bar"));
    const nextStart = args.start_bar ?? currentStart;
    const nextEnd = args.end_bar ?? currentEnd;
    checkSectionRange(nextStart, nextEnd);
    checkSectionsClear(doc, nextStart, nextEnd, args.id);

    const ref = sectionRef(args.id);
    const before = {};
    const after = {};
    if (nextStart !== currentStart) {
      before[fieldKey(ref, "start_bar")] = currentStart;
      after[fieldKey(ref, "start_bar")] = nextStart;
      section.set("start_bar", nextStart);
    }
    if (nextEnd !== currentEnd) {
      before[fieldKey(ref, "end_bar")] = currentEnd;
      after[fieldKey(ref, "end_bar")] = nextEnd;
      section.set("end_bar", nextEnd);
    }
    if (args.name !== undefined) {
      before[fieldKey(ref, "name")] = typeof section.get("name") === "string" ? section.get("name") : ABSENT;
      after[fieldKey(ref, "name")] = args.name;
      section.set("name", args.name);
    }
    return { before, after };
  },
});

defineCommand({
  id: "section.remove",
  title: "Remove a section",
  schema: z.object({ id: idSchema.describe("the section to remove") }).strict(),
  summary(args, snap) {
    return `Removed section "${sectionOf(snap, args.id)?.name ?? args.id}"`;
  },
  touches(args) {
    return [sectionRef(args.id)];
  },
  apply(doc, args) {
    const section = requireSection(doc, args.id);
    const ref = sectionRef(args.id);
    const before = { [fieldKey(ref, "*")]: cloneJson(toPlain(section)) };
    sectionMap(doc).delete(args.id);
    return { before, after: { [fieldKey(ref, "*")]: ABSENT } };
  },
});