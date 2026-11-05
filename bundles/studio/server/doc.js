/**
 * Studio song document — the Yjs shape every command edits, plus the small
 * helpers the commands, the history and the session hub share.
 *
 * One song is one `Y.Doc` holding a single `Y.Map` named "song":
 *
 *   meta    plain object {title, bpm, meter: [4, 4], key}
 *   tracks  Y.Array of Y.Map {id, name, color, device {engine, type, params},
 *                            mute, solo, gain_db, pan, locked}
 *   scenes  Y.Array of Y.Map {id, name}
 *   clips   Y.Map of clip id → Y.Map {id, track_id, scene_id, name,
 *                            length_bars, notes: [{t, d, p, v}]}, plus
 *                            kind: "audio" and comp: [Segment] on a recorded
 *                            (audio) clip
 *   takes   Y.Map of take id → Y.Map {id, clip_id, storage_key, rate,
 *                            channels, frames, offset_frames, compensated,
 *                            bpm, recorded_at, author_label, discarded}
 *   arrangement  Y.Map of three Y.Maps:
 *                placements  placement id → Y.Map {id, track_id, clip_id,
 *                            start_bar, bars, offset_beats, fade_in_beats,
 *                            fade_out_beats}
 *                markers     marker id → Y.Map {id, bar, name}
 *                sections    section id → Y.Map {id, start_bar, end_bar, name}
 *
 * A take is one recording on disk that an audio clip comps from. A segment is
 * `{take_id, from_beat, to_beat}` and says which take plays over which beats
 * of its clip. A song written before takes existed has no `takes` container:
 * every reader treats that as an empty map (see `readContainer`).
 *
 * The arrangement is the song laid out on a timeline instead of in scenes: a
 * placement puts a clip on a track at a bar, a marker names one bar, and a
 * section names a range of bars. A song written before the timeline existed
 * has no `arrangement` container either, and then it has no placements,
 * markers or sections (see `readArrangement`). Bars are whole numbers from 0;
 * a placement's `offset_beats` says how far into its clip it starts, and its
 * fades are in beats (linear, and only meaningful on an audio placement).
 *
 * A sampler track (device `{engine: "sampler"}`) plays a kit, and its clips
 * are patterns. The kit and the patterns are their own top-level containers,
 * keyed by stable ids, so one pad or one step is one small object to edit:
 *
 *   samples   Y.Map of sample id → Y.Map {id, storage_key, rate, channels,
 *                     frames, name, origin, author_label}
 *   slices    Y.Map of "<sample_id>/<slice_id>" → Y.Map {id, sample_id,
 *                     start_frame, end_frame}
 *   banks     Y.Map of "<track_id>/<bank_id>" → Y.Map {id, track_id, name, order}
 *   pads      Y.Map of "<track_id>/<bank_id>/<index>" → Y.Map {track_id,
 *                     bank_id, index, sample_id, slice_id, name, mode, pitch,
 *                     gain_db, pan, attack_ms, decay_ms, sustain, release_ms,
 *                     filter {type, cutoff_hz, resonance}, choke, reverse}
 *   patterns  Y.Map of "<clip_id>/<pattern_id>" → Y.Map {id, clip_id, name, order,
 *                     motion}
 *   steps     Y.Map of "<clip_id>/<pattern_id>/<at>/<bank_id>.<index>" → Y.Map
 *                     {clip_id, pattern_id, at, bank_id, index, v, locks}
 *
 * A pattern's `motion` is a nested `Y.Map`: one KEY per lane, `<bank_id>.<index>|<param>`
 * → `[{step_frac, value}]` sorted by `step_frac`, with `step_frac` a fractional
 * step position inside the clip's loop and `param` one of the pad's numeric lock
 * fields (see `MOTION_PARAMS`). One lane per key is what lets two writers move
 * two lanes of one pattern at once without either overwriting the other, and it
 * is what keeps a lane's undo from rolling back its neighbour; the snapshot
 * still carries the lanes as one plain object (`{lane: [points]}`). Motion rides
 * ON the pattern object rather than in a container of its own, so removing a
 * pattern takes its motion with it in the same step. A pattern written before
 * the lanes had a map of their own holds them in one plain object under the same
 * key; `motionOf` reads both, and the first lane write upgrades the pattern in
 * place (`patternMotionMap`).
 *
 * A sampler track's device says only `{engine: "sampler"}`: the kit lives in
 * `banks` and `pads`, never inside the device, so editing one pad never
 * rewrites the track. A pattern clip is a clip with `kind: "pattern"`: it
 * holds `notes: []`, its `length_steps` and `step_beats` (its loop is
 * `length_steps × step_beats` beats), its `swing` and its `chain` of pattern
 * ids. Its `length_bars` is derived from those (see `lengthBarsForSteps`) and
 * kept in the clip, so scenes and placements measure a pattern clip exactly
 * as they measure any other clip.
 *
 * A MIDI mapping (plan 1c, Task 8) routes one incoming message — a note, a
 * control change or a program change on one named controller — to one
 * allow-listed live action. Mappings are their own top-level container keyed by
 * stable ids:
 *
 *   midi_maps  Y.Map of mapping id → Y.Map {id, device_name, message {type,
 *                     channel, number}, action {kind, …}, set_by, proposed,
 *                     accepted_action}
 *
 * `set_by` says who set the mapping ("operator" or "agent") and `proposed`
 * says whether it is still waiting for the operator's yes. A mapping is live
 * only when `proposed` is false AND its `action` still deep-equals its
 * `accepted_action`: that pair is what the router reads (see `routeFor` in
 * commands/midi.js), so an action edited after the accept stops routing.
 *
 * A note is in beats: `t` its start, `d` its length, `p` a MIDI pitch (0-127)
 * and `v` a velocity (1-127). Everything except the three containers is plain
 * JSON, so `snapshot()` is a round trip away from the wire, storage or a
 * command's before/after map.
 *
 * Nothing in this module opens a transaction for an edit: commands and history
 * entries run inside the caller's `doc.transact(...)` (the session hub owns
 * that), so one command is one Yjs update and one history step. `newSongDoc()`
 * is the one exception — it creates a song inside a transaction of its own.
 *
 * "The object or field was not there" is spelled `null` everywhere, never
 * `undefined`: a history entry is persisted with `JSON.stringify`, which drops
 * `undefined` keys, and a dropped key would turn "delete this object" into "do
 * nothing".
 */

import * as Y from "yjs";

/**
 * What one song may hold (spec §1, phase 1a), plus the per-device controller
 * cap and the per-clip take cap of 1b and the sampler's caps of 1c. Commands
 * refuse past these with a plain-English message naming the limit.
 * @type {{tracks: number, notesPerClip: number, scenes: number, clipBars: number,
 *         params: number, takesPerClip: number, placements: number,
 *         arrangementBars: number, markers: number, sections: number,
 *         banksPerKit: number, padsPerBank: number, samplesPerSong: number,
 *         sampleSamples: number, slicesPerSample: number,
 *         stepPositions: number, stepEntriesPerPattern: number,
 *         patternsPerClip: number, chainLength: number, locksPerStep: number,
 *         motionPointsPerLane: number, motionLanesPerPattern: number,
 *         midiMaps: number}}
 */
/**
 * The SunVox modules a Studio track may use as its instrument in 1a: the
 * self-contained synthesizers. Other generator-flagged modules need inputs
 * Studio does not provide yet (Input, Sampler and Vorbis player need audio;
 * MultiSynth and Velocity2Ctl only route control to other modules).
 */
export const INSTRUMENT_TYPES = Object.freeze(["Analog generator", "DrumSynth", "Generator", "SpectraVoice"]);

export const LIMITS = Object.freeze({
  tracks: 16,
  notesPerClip: 4096,
  scenes: 64,
  clipBars: 64,
  params: 64,
  takesPerClip: 64,
  // The timeline: 2048 blocks on it, ending at bar 999, with 256 markers and
  // 128 sections along the way (plan 1b, Global Constraints).
  placements: 2048,
  arrangementBars: 999,
  markers: 256,
  sections: 128,
  // The sampler (plan 1c, Limits): a kit of banks of pads, samples with their
  // slices, pattern clips of steps, and the chains that loop them.
  banksPerKit: 8,
  padsPerBank: 16,
  samplesPerSong: 512,
  sampleSamples: 5760000,
  slicesPerSample: 64,
  stepPositions: 64,
  stepEntriesPerPattern: 1024,
  patternsPerClip: 16,
  chainLength: 64,
  locksPerStep: 8,
  // A pattern's motion lanes (plan 1c, Task 10): one lane per pad field, and a
  // lane of hand-drawn points that stays a curve, not a sample stream.
  motionPointsPerLane: 4096,
  motionLanesPerPattern: 32,
  // The MIDI mapping table of one song (plan 1c, Limits): every message the
  // operator's controllers drive, proposed or live.
  midiMaps: 256,
});

/**
 * The smallest step a placement's offset into its clip may take: a sixteenth
 * of a beat, so a split lands on the grid every sequencer draws.
 */
export const OFFSET_STEP_BEATS = 1 / 16;

/**
 * The device of an audio track: the one track kind that plays recorded takes
 * instead of SunVox notes. It carries no module and no controllers.
 * @type {Readonly<{engine: "audio"}>}
 */
export const AUDIO_DEVICE = Object.freeze({ engine: "audio" });

/**
 * The device of a sampler track: the one track kind that plays a kit of pads
 * instead of a SunVox module. It carries no module and no controllers; its
 * banks and pads live in the song's own `banks` and `pads` containers.
 * @type {Readonly<{engine: "sampler"}>}
 */
export const SAMPLER_DEVICE = Object.freeze({ engine: "sampler" });

/** The step lengths a pattern may use, in beats (16ths, 8ths, 32nds, quarters). */
export const STEP_BEATS_VALUES = Object.freeze([0.125, 0.25, 0.5, 1]);

/** A new pattern's step length: a sixteenth note. */
export const DEFAULT_STEP_BEATS = 0.25;

/** The sample rates a sample may hold (the rates an import may land at). */
export const SAMPLE_RATES = Object.freeze([44100, 48000, 88200, 96000]);

/** How a sample came to be in the song. */
export const SAMPLE_ORIGINS = Object.freeze(["import", "record", "resample"]);

/** The three MIDI messages a mapping may answer: a note, a control, a program change. */
export const MIDI_MESSAGE_TYPES = Object.freeze(["note", "cc", "pc"]);

/** Who set one MIDI mapping: the operator, or an agent proposing one. */
export const MIDI_SET_BY = Object.freeze(["operator", "agent"]);

/** The filter kinds one pad may use; "off" is a pad that filters nothing. */
export const PAD_FILTER_TYPES = Object.freeze(["off", "lp", "hp", "bp"]);

/** The two ways a pad's voice ends: it runs out, or its step releases it. */
export const PAD_MODES = Object.freeze(["oneshot", "gate"]);

/**
 * The pad fields a motion lane may sweep, each with the range the pad's own
 * field holds. They are exactly the pad's numeric lock fields: a lane overrides
 * one of them for every voice of its pad while the pattern plays, below a
 * step's lock (see the plan's Task 10).
 * @type {Readonly<Object<string, Readonly<number[]>>>}
 */
export const MOTION_PARAM_RANGES = Object.freeze({
  pitch: Object.freeze([-24, 24]),
  gain_db: Object.freeze([-60, 12]),
  pan: Object.freeze([-1, 1]),
  attack_ms: Object.freeze([0, 10000]),
  decay_ms: Object.freeze([0, 10000]),
  sustain: Object.freeze([0, 1]),
  release_ms: Object.freeze([0, 10000]),
  cutoff_hz: Object.freeze([20, 20000]),
  resonance: Object.freeze([0, 1]),
});

/** The pad fields one motion lane may sweep, in the order the pad controls list them. */
export const MOTION_PARAMS = Object.freeze(Object.keys(MOTION_PARAM_RANGES));

/** 1a is four beats to the bar, in every scene. */
export const BEATS_PER_BAR = 4;

/** Name of the song's root Y.Map. */
export const SONG_MAP = "song";

/** Track colours, handed out in this order and then repeated. */
export const TRACK_COLORS = Object.freeze([
  "#E8C07A",
  "#E39A8E",
  "#B6D98A",
  "#8FC1E8",
  "#C7A7E6",
  "#9AD6CF",
  "#F0B37E",
  "#A9C7A3",
]);

/**
 * A field a command never wrote: the object or field did not exist, or the
 * value deletes it. `null` rather than `undefined`, so the marker survives the
 * JSON round trip through storage (see the header).
 */
const ABSENT = null;

/** Key separator between an object ref ("clip:abc") and one of its fields. */
const FIELD_SEPARATOR = "|";

/**
 * Prefix of a field path that reaches one controller inside a track's device,
 * e.g. `"device.params.Cutoff"`. The controller name is everything after the
 * prefix, taken verbatim, so a name containing a dot still names one
 * controller.
 */
const PARAM_FIELD_PREFIX = "device.params.";

/**
 * Prefix of a field path that reaches one lock inside a step's `locks`, e.g.
 * `"locks.cutoff_hz"`. The lock name is everything after the prefix, taken
 * verbatim, so each lock is its own field and stays undoable on its own.
 */
const LOCK_FIELD_PREFIX = "locks.";

/**
 * The key a command's `apply` hangs its history *guards* on.
 *
 * A guard is a field that must still hold the value it held when the step was
 * recorded for a later undo to mean anything, but which the undo never writes
 * back: a controller value only means what it meant inside the device it was
 * set on. A Symbol rather than a `"<ref>|<field>"` key, so it can never be
 * mistaken for history content; `makeEntry` (history.js) moves it into
 * `inverse.guards` when the step is recorded.
 */
export const STEP_GUARDS = Symbol("studio.step-guards");

/**
 * The ref a command, a lock or a history entry names one object by.
 * @param {"song"|"track"|"scene"|"clip"|"take"|"placement"|"marker"|"section"|"motion"} kind
 * @param {string} id
 * @returns {string} e.g. `"clip:abc"`, `"take:abc"`, or `"song:meta"` for the song itself
 */
export function objectRef(kind, id) {
  return `${kind}:${id}`;
}

/**
 * Split an object reference back into its kind and id.
 * @param {string} ref
 * @returns {{kind: string, id: string}|null} null when `ref` is not a ref
 */
export function parseObjectRef(ref) {
  const text = String(ref ?? "");
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) return null;
  return { kind: text.slice(0, at), id: text.slice(at + 1) };
}

/**
 * Split a before/after key ("clip:abc|notes") into its ref and field.
 * @param {string} key
 * @returns {{ref: string, field: string}|null}
 */
export function splitRefField(key) {
  const text = String(key ?? "");
  const at = text.lastIndexOf(FIELD_SEPARATOR);
  if (at <= 0 || at === text.length - 1) return null;
  return { ref: text.slice(0, at), field: text.slice(at + 1) };
}

/**
 * Deep-copy a plain JSON value, so a command's before/after never aliases the
 * live document (or the caller's argument object).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneJson(value) {
  if (value === undefined || value === null) return ABSENT;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Convert a Yjs value to plain JSON: Y.Map → object, Y.Array → array, plain
 * values deep-copied.
 * @param {unknown} value
 * @returns {any}
 */
export function toPlain(value) {
  if (value instanceof Y.Map) {
    const object = {};
    for (const [key, item] of value.entries()) object[key] = toPlain(item);
    return object;
  }
  if (value instanceof Y.Array) return value.toArray().map((item) => toPlain(item));
  if (value === null || typeof value !== "object") return value;
  return cloneJson(value);
}

/**
 * Build the Y.Map a command inserts for a new track, scene or clip.
 * @param {object} object
 * @returns {Y.Map<any>}
 */
export function objectMap(object) {
  return new Y.Map(Object.entries(object ?? {}));
}

/**
 * Build the Y.Map a command inserts for a new pattern: its own fields plus the
 * nested `motion` map every pattern carries from the moment it exists.
 *
 * The map has to be there BEFORE two writers can move two lanes of the pattern:
 * a `motion` key created concurrently on two instances is two maps, and Yjs
 * keeps only one of them. With the (empty) container created once, alongside the
 * pattern that owns it, each lane write is its own key inside the very same
 * map, and a lane another instance moves at the same moment is never lost
 * (`setMotionLane`).
 * @param {object} pattern the pattern's own fields (`id`, `clip_id`, `name`, `order`)
 * @returns {Y.Map<any>}
 */
export function newPatternMap(pattern) {
  const map = objectMap(pattern);
  map.set("motion", new Y.Map());
  return map;
}

/**
 * The palette colour for the nth track of a song.
 * @param {number} index
 * @returns {string}
 */
export function colorForIndex(index) {
  const at = ((Math.trunc(index) % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length;
  return TRACK_COLORS[at];
}

/**
 * Create an empty song document.
 *
 * A new song has no tracks, scenes or clips: `track.add`, `scene.add` and
 * `clip.write` fill it in.
 * @param {{title?: string, bpm?: number, key?: string}} [meta]
 * @returns {Y.Doc}
 */
export function newSongDoc({ title = "Untitled song", bpm = 120, key = "C major" } = {}) {
  const doc = new Y.Doc();
  const song = doc.getMap(SONG_MAP);
  doc.transact(() => {
    song.set("meta", { title, bpm, meter: [4, 4], key });
    song.set("tracks", new Y.Array());
    song.set("scenes", new Y.Array());
    song.set("clips", new Y.Map());
    song.set("takes", new Y.Map());
    song.set(
      "arrangement",
      new Y.Map([
        ["placements", new Y.Map()],
        ["markers", new Y.Map()],
        ["sections", new Y.Map()],
      ]),
    );
  }, "studio:new-song");
  return doc;
}

/**
 * The song's root map.
 * @param {Y.Doc} doc
 * @returns {Y.Map<any>}
 */
export function songMap(doc) {
  return doc.getMap(SONG_MAP);
}

/**
 * The tracks array. Writers use this; it creates the array if a document was
 * built without one.
 * @param {Y.Doc} doc
 * @returns {Y.Array<Y.Map<any>>}
 */
export function trackList(doc) {
  return ensureContainer(doc, "tracks", () => new Y.Array());
}

/**
 * The scenes array. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Array<Y.Map<any>>}
 */
export function sceneList(doc) {
  return ensureContainer(doc, "scenes", () => new Y.Array());
}

/**
 * The clips map, keyed by clip id. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function clipMap(doc) {
  return ensureContainer(doc, "clips", () => new Y.Map());
}

/**
 * The takes map, keyed by take id. Writers use this; a song written before
 * takes existed gets the container when it is first written to.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function takeMap(doc) {
  return ensureContainer(doc, "takes", () => new Y.Map());
}

/**
 * Every take in the song, in the order the map holds them. A song without a
 * takes container has none.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, take: Y.Map<any>}>}
 */
export function takeEntries(doc) {
  const takes = readContainer(doc, "takes");
  if (!(takes instanceof Y.Map)) return [];
  const out = [];
  for (const [id, take] of takes.entries()) {
    if (take instanceof Y.Map) out.push({ id, take });
  }
  return out;
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live take object, or null
 */
export function getTake(doc, id) {
  const takes = readContainer(doc, "takes");
  if (!(takes instanceof Y.Map)) return null;
  const take = takes.get(id);
  return take instanceof Y.Map ? take : null;
}

/**
 * Every take recorded into one clip.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @returns {Array<{id: string, take: Y.Map<any>}>}
 */
export function takesForClip(doc, clipId) {
  return takeEntries(doc).filter(({ take }) => take.get("clip_id") === clipId);
}

/**
 * The arrangement container — placements, markers and sections. Writers use
 * this; a song written before the timeline existed gets it on first write.
 * @param {Y.Doc} doc
 * @returns {Y.Map<any>}
 */
export function arrangementContainer(doc) {
  return ensureContainer(doc, "arrangement", () => new Y.Map());
}

/**
 * The placements map, keyed by placement id. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function placementMap(doc) {
  return ensureArrangementMap(doc, "placements");
}

/**
 * The markers map, keyed by marker id. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function markerMap(doc) {
  return ensureArrangementMap(doc, "markers");
}

/**
 * The sections map, keyed by section id. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function sectionMap(doc) {
  return ensureArrangementMap(doc, "sections");
}

/**
 * Every placement in the song, in the order the map holds them. A song without
 * an arrangement has none.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, placement: Y.Map<any>}>}
 */
export function placementEntries(doc) {
  return objectEntries(readArrangementMap(doc, "placements"), "placement");
}

/**
 * Every marker in the song. A song without an arrangement has none.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, marker: Y.Map<any>}>}
 */
export function markerEntries(doc) {
  return objectEntries(readArrangementMap(doc, "markers"), "marker");
}

/**
 * Every section in the song. A song without an arrangement has none.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, section: Y.Map<any>}>}
 */
export function sectionEntries(doc) {
  return objectEntries(readArrangementMap(doc, "sections"), "section");
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live placement object, or null
 */
export function getPlacement(doc, id) {
  return liveObject(readArrangementMap(doc, "placements"), id);
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live marker object, or null
 */
export function getMarker(doc, id) {
  return liveObject(readArrangementMap(doc, "markers"), id);
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live section object, or null
 */
export function getSection(doc, id) {
  return liveObject(readArrangementMap(doc, "sections"), id);
}

/**
 * Every placement that puts one clip on the timeline.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @returns {Array<{id: string, placement: Y.Map<any>}>}
 */
export function placementsForClip(doc, clipId) {
  return placementEntries(doc).filter(({ placement }) => placement.get("clip_id") === clipId);
}

/**
 * Every placement sitting on one track.
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @returns {Array<{id: string, placement: Y.Map<any>}>}
 */
export function placementsForTrack(doc, trackId) {
  return placementEntries(doc).filter(({ placement }) => placement.get("track_id") === trackId);
}

/**
 * Whether a value sits on the sixteenth-of-a-beat grid a placement's offset
 * uses. A float sum can land a hair off the grid, so the comparison allows a
 * thousandth of a step.
 * @param {number} beats
 * @returns {boolean}
 */
export function onOffsetGrid(beats) {
  if (typeof beats !== "number" || !Number.isFinite(beats)) return false;
  const steps = beats / OFFSET_STEP_BEATS;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** @returns {Y.Map<any>} the named sub-map of the arrangement, created when missing. */
function ensureArrangementMap(doc, key) {
  const arrangement = arrangementContainer(doc);
  const current = arrangement.get(key);
  if (current instanceof Y.Map) return current;
  const created = new Y.Map();
  arrangement.set(key, created);
  return created;
}

/** @returns {Y.Map<any>|null} the named sub-map of the arrangement, or null. */
function readArrangementMap(doc, key) {
  const arrangement = songMap(doc).get("arrangement");
  if (!(arrangement instanceof Y.Map)) return null;
  const current = arrangement.get(key);
  return current instanceof Y.Map ? current : null;
}

/** @returns {Array<{id: string, [key]: Y.Map<any>}>} the live Y.Maps of one container. */
function objectEntries(map, key) {
  if (!(map instanceof Y.Map)) return [];
  const out = [];
  for (const [id, value] of map.entries()) {
    if (value instanceof Y.Map) out.push({ id, [key]: value });
  }
  return out;
}

/** @returns {Y.Map<any>|null} one live object of a container, or null. */
function liveObject(map, id) {
  if (!(map instanceof Y.Map)) return null;
  const value = map.get(id);
  return value instanceof Y.Map ? value : null;
}

/**
 * Whether a track plays recorded takes rather than a SunVox module.
 * @param {Y.Map<any>|null|undefined} track
 * @returns {boolean}
 */
export function isAudioTrack(track) {
  return deviceEngine(track) === AUDIO_DEVICE.engine;
}

/**
 * Whether a clip holds recorded takes (an audio clip) rather than notes.
 * @param {Y.Map<any>|null|undefined} clip
 * @returns {boolean}
 */
export function isAudioClip(clip) {
  return clip?.get?.("kind") === "audio";
}

/** @returns {string|null} the engine a track's device names, when it names one. */
function deviceEngine(track) {
  if (!track || typeof track.get !== "function") return null;
  const device = track.get("device");
  const plain = device instanceof Y.Map ? toPlain(device) : device;
  const engine = plain && typeof plain === "object" ? plain.engine : null;
  return typeof engine === "string" ? engine : null;
}

/** @returns {any} the stored container, created (and stored) when missing. */
function ensureContainer(doc, key, make) {
  const song = songMap(doc);
  const current = song.get(key);
  if (current instanceof Y.Map || current instanceof Y.Array) return current;
  const created = make();
  song.set(key, created);
  return created;
}

/** @returns {any} the stored container, or null when the document has none. */
function readContainer(doc, key) {
  const current = songMap(doc).get(key);
  if (current instanceof Y.Map || current instanceof Y.Array) return current;
  return null;
}

/**
 * Position of a track in the song's track order.
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {number} -1 when the song has no such track
 */
export function findTrackIndex(doc, id) {
  const tracks = readContainer(doc, "tracks");
  if (!(tracks instanceof Y.Array)) return -1;
  const items = tracks.toArray();
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.get?.("id") === id) return index;
  }
  return -1;
}

/**
 * Position of a scene in the song's scene order.
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {number} -1 when the song has no such scene
 */
export function findSceneIndex(doc, id) {
  const scenes = readContainer(doc, "scenes");
  if (!(scenes instanceof Y.Array)) return -1;
  const items = scenes.toArray();
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.get?.("id") === id) return index;
  }
  return -1;
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live track object, or null
 */
export function getTrack(doc, id) {
  const index = findTrackIndex(doc, id);
  if (index < 0) return null;
  const track = readContainer(doc, "tracks").get(index);
  return track instanceof Y.Map ? track : null;
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live scene object, or null
 */
export function getScene(doc, id) {
  const index = findSceneIndex(doc, id);
  if (index < 0) return null;
  const scene = readContainer(doc, "scenes").get(index);
  return scene instanceof Y.Map ? scene : null;
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live clip object, or null
 */
export function getClip(doc, id) {
  const clips = readContainer(doc, "clips");
  if (!(clips instanceof Y.Map)) return null;
  const clip = clips.get(id);
  return clip instanceof Y.Map ? clip : null;
}

/**
 * Every clip in the song, in the order the map holds them.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, clip: Y.Map<any>}>}
 */
export function clipEntries(doc) {
  const clips = readContainer(doc, "clips");
  if (!(clips instanceof Y.Map)) return [];
  const out = [];
  for (const [id, clip] of clips.entries()) {
    if (clip instanceof Y.Map) out.push({ id, clip });
  }
  return out;
}

/**
 * Every clip placed on one track.
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @returns {Array<{id: string, clip: Y.Map<any>}>}
 */
export function clipsForTrack(doc, trackId) {
  return clipEntries(doc).filter(({ clip }) => clip.get("track_id") === trackId);
}

/**
 * Every clip placed in one scene.
 * @param {Y.Doc} doc
 * @param {string} sceneId
 * @returns {Array<{id: string, clip: Y.Map<any>}>}
 */
export function clipsForScene(doc, sceneId) {
  return clipEntries(doc).filter(({ clip }) => clip.get("scene_id") === sceneId);
}

// --- The sampler's containers -----------------------------------------------

/**
 * The samples map, keyed by sample id. Writers use this; a song written before
 * the sampler existed gets the container the first time it is written to.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function sampleMap(doc) {
  return ensureContainer(doc, "samples", () => new Y.Map());
}

/**
 * The slices map, keyed by "<sample_id>/<slice_id>".
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function sliceMap(doc) {
  return ensureContainer(doc, "slices", () => new Y.Map());
}

/**
 * The banks map, keyed by "<track_id>/<bank_id>".
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function bankMap(doc) {
  return ensureContainer(doc, "banks", () => new Y.Map());
}

/**
 * The pads map, keyed by "<track_id>/<bank_id>/<index>".
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function padMap(doc) {
  return ensureContainer(doc, "pads", () => new Y.Map());
}

/**
 * The patterns map, keyed by "<clip_id>/<pattern_id>".
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function patternMap(doc) {
  return ensureContainer(doc, "patterns", () => new Y.Map());
}

/**
 * The steps map, keyed by "<clip_id>/<pattern_id>/<at>/<bank_id>.<index>".
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function stepMap(doc) {
  return ensureContainer(doc, "steps", () => new Y.Map());
}

/**
 * The MIDI mappings map, keyed by mapping id. Writers use this; a song written
 * before the MIDI page existed gets the container the first time it is written
 * to.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function midiMap(doc) {
  return ensureContainer(doc, "midi_maps", () => new Y.Map());
}

/**
 * Every MIDI mapping in the song, in the order the map holds them.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, mapping: Y.Map<any>}>}
 */
export function midiEntries(doc) {
  return objectEntries(readContainer(doc, "midi_maps"), "mapping");
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live MIDI mapping, or null
 */
export function getMidiMapping(doc, id) {
  return liveObject(readContainer(doc, "midi_maps"), id);
}

/**
 * The key one sample's slice lives under in the song's `slices` map.
 * @param {string} sampleId
 * @param {string} sliceId
 * @returns {string}
 */
export function sliceKey(sampleId, sliceId) {
  return `${sampleId}/${sliceId}`;
}

/**
 * The key one bank lives under in the song's `banks` map.
 * @param {string} trackId
 * @param {string} bankId
 * @returns {string}
 */
export function bankKey(trackId, bankId) {
  return `${trackId}/${bankId}`;
}

/**
 * The key one pad lives under in the song's `pads` map.
 * @param {string} trackId
 * @param {string} bankId
 * @param {number} index
 * @returns {string}
 */
export function padKey(trackId, bankId, index) {
  return `${trackId}/${bankId}/${index}`;
}

/**
 * The key one pattern lives under in the song's `patterns` map.
 * @param {string} clipId
 * @param {string} patternId
 * @returns {string}
 */
export function patternKey(clipId, patternId) {
  return `${clipId}/${patternId}`;
}

/**
 * The key one step lives under in the song's `steps` map. A step is one pad at
 * one position of one pattern, so the key names all three and nothing here is
 * an array index.
 * @param {string} clipId
 * @param {string} patternId
 * @param {number} at
 * @param {string} bankId
 * @param {number} index
 * @returns {string}
 */
export function stepKey(clipId, patternId, at, bankId, index) {
  return `${clipId}/${patternId}/${at}/${bankId}.${index}`;
}

/**
 * The name one motion lane goes by: the pad it sweeps and the field it moves,
 * e.g. `"kit-a.3|cutoff_hz"`. A lane is one pad field of one pattern, so this
 * name is the lane's whole identity.
 * @param {string} bankId
 * @param {number} index
 * @param {string} param
 * @returns {string}
 */
export function motionLane(bankId, index, param) {
  return `${bankId}.${index}|${param}`;
}

/**
 * The key one motion lane lives under in the synthetic `motion` refs: the clip
 * and the pattern name it, then the lane itself. (A lane is stored inside its
 * pattern's `motion` field; this key is what makes one lane one history field.)
 * @param {string} clipId
 * @param {string} patternId
 * @param {string} lane
 * @returns {string}
 */
export function motionKey(clipId, patternId, lane) {
  return `${clipId}/${patternId}/${lane}`;
}

/**
 * Split a motion ref id back into its clip, its pattern and its lane.
 * @param {string} id - `"<clip_id>/<pattern_id>/<bank_id>.<index>|<param>"`
 * @returns {{clipId: string, patternId: string, lane: string}|null}
 */
export function motionParts(id) {
  const text = String(id ?? "");
  const first = text.indexOf("/");
  const second = first < 0 ? -1 : text.indexOf("/", first + 1);
  if (first <= 0 || second < 0 || second === text.length - 1) return null;
  return { clipId: text.slice(0, first), patternId: text.slice(first + 1, second), lane: text.slice(second + 1) };
}

/**
 * Split one motion lane name back into the pad it sweeps and the field it moves.
 * @param {string} lane - `"<bank_id>.<index>|<param>"`
 * @returns {{bankId: string, index: number, param: string}|null}
 */
export function motionLaneParts(lane) {
  const text = String(lane ?? "");
  const bar = text.lastIndexOf("|");
  if (bar <= 0 || bar === text.length - 1) return null;
  const pad = text.slice(0, bar);
  const dot = pad.lastIndexOf(".");
  if (dot <= 0) return null;
  const index = Number(pad.slice(dot + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { bankId: pad.slice(0, dot), index, param: text.slice(bar + 1) };
}

/**
 * A pattern's motion lanes as plain JSON, keyed by lane name.
 * @param {Y.Map<any>|null|undefined} pattern
 * @returns {Object<string, Array<{step_frac: number, value: number}>>} empty when
 *   the pattern has no motion
 */
export function motionOf(pattern) {
  const stored = pattern?.get?.("motion");
  if (stored === undefined || stored === null) return {};
  const plain = toPlain(stored);
  return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {};
}

/**
 * A pattern's motion as the live `Y.Map` its lanes are stored in: one key per
 * lane, so two writers moving different lanes of one pattern never touch the
 * same field, and a lane's undo leaves its neighbours exactly as they are.
 *
 * A pattern whose lanes still live in one plain object (a song written before
 * the map existed) is upgraded in place when `create` is set: the object's lanes
 * are copied into a fresh `Y.Map` under the same key, unchanged, so a snapshot
 * reads the same before and after the upgrade.
 * @param {Y.Map<any>} pattern - the live pattern
 * @param {boolean} [create] make (and store) the lane map when the pattern has none
 * @returns {Y.Map<any>|null} the lane map, or `null` with `create` false
 */
export function patternMotionMap(pattern, create = false) {
  const stored = pattern?.get?.("motion");
  if (stored instanceof Y.Map) return stored;
  if (!create) return null;
  const legacy = stored && typeof stored === "object" && !Array.isArray(stored) ? toPlain(stored) ?? {} : {};
  const map = new Y.Map();
  pattern.set("motion", map);
  for (const lane of Object.keys(legacy)) {
    if (!Array.isArray(legacy[lane])) continue;
    map.set(lane, cloneJson(legacy[lane]));
  }
  return map;
}

/**
 * Write one lane of a pattern's motion, or (with `null`) take it away: one key
 * of one `Y.Map`, and nothing else in the song is touched.
 *
 * The container stays even when its last lane goes (a pattern always carries
 * one — see `newPatternMap`), so a lane written on one instance and a lane
 * written on another at the same moment are two keys of one map, never two
 * maps competing for one key. A pattern whose lanes still live in a plain
 * object is upgraded on the way (`patternMotionMap`).
 * @param {Y.Map<any>} pattern - the live pattern
 * @param {string} lane - `<bank_id>.<index>|<param>`
 * @param {Array<{step_frac: number, value: number}>|null|undefined} points
 * @returns {boolean} whether the document changed
 */
export function setMotionLane(pattern, lane, points) {
  const removing = points === null || points === undefined;
  if (removing && !Object.hasOwn(motionOf(pattern), lane)) return false;
  const map = patternMotionMap(pattern, true);
  if (removing) map.delete(lane);
  else map.set(lane, cloneJson(points));
  return true;
}

/**
 * Every sample in the song, in the order the map holds them. A song without a
 * samples container has none.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, sample: Y.Map<any>}>}
 */
export function sampleEntries(doc) {
  return objectEntries(readContainer(doc, "samples"), "sample");
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live sample, or null
 */
export function getSample(doc, id) {
  return liveObject(readContainer(doc, "samples"), id);
}

/**
 * Every slice in the song, keyed "<sample_id>/<slice_id>".
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, slice: Y.Map<any>}>}
 */
export function sliceEntries(doc) {
  return objectEntries(readContainer(doc, "slices"), "slice");
}

/**
 * @param {Y.Doc} doc
 * @param {string} sampleId
 * @param {string} sliceId
 * @returns {Y.Map<any>|null} the live slice, or null
 */
export function getSlice(doc, sampleId, sliceId) {
  return liveObject(readContainer(doc, "slices"), sliceKey(sampleId, sliceId));
}

/**
 * Every slice of one sample.
 * @param {Y.Doc} doc
 * @param {string} sampleId
 * @returns {Array<{id: string, slice: Y.Map<any>}>}
 */
export function slicesForSample(doc, sampleId) {
  return sliceEntries(doc).filter(({ slice }) => slice.get("sample_id") === sampleId);
}

/**
 * Every bank in the song, keyed "<track_id>/<bank_id>".
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, bank: Y.Map<any>}>}
 */
export function bankEntries(doc) {
  return objectEntries(readContainer(doc, "banks"), "bank");
}

/**
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @param {string} bankId
 * @returns {Y.Map<any>|null} the live bank, or null
 */
export function getBank(doc, trackId, bankId) {
  return liveObject(readContainer(doc, "banks"), bankKey(trackId, bankId));
}

/**
 * Every bank of one track's kit.
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @returns {Array<{id: string, bank: Y.Map<any>}>}
 */
export function banksForTrack(doc, trackId) {
  return bankEntries(doc).filter(({ bank }) => bank.get("track_id") === trackId);
}

/**
 * Every pad in the song, keyed "<track_id>/<bank_id>/<index>".
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, pad: Y.Map<any>}>}
 */
export function padEntries(doc) {
  return objectEntries(readContainer(doc, "pads"), "pad");
}

/**
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @param {string} bankId
 * @param {number} index
 * @returns {Y.Map<any>|null} the live pad, or null
 */
export function getPad(doc, trackId, bankId, index) {
  return liveObject(readContainer(doc, "pads"), padKey(trackId, bankId, index));
}

/**
 * Every pad of one bank, in the order the map holds them.
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @param {string} bankId
 * @returns {Array<{id: string, pad: Y.Map<any>}>}
 */
export function padsForBank(doc, trackId, bankId) {
  return padEntries(doc).filter(
    ({ pad }) => pad.get("track_id") === trackId && pad.get("bank_id") === bankId,
  );
}

/**
 * Every pattern in the song, keyed "<clip_id>/<pattern_id>".
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, pattern: Y.Map<any>}>}
 */
export function patternEntries(doc) {
  return objectEntries(readContainer(doc, "patterns"), "pattern");
}

/**
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @param {string} patternId
 * @returns {Y.Map<any>|null} the live pattern, or null
 */
export function getPattern(doc, clipId, patternId) {
  return liveObject(readContainer(doc, "patterns"), patternKey(clipId, patternId));
}

/**
 * Every pattern of one pattern clip.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @returns {Array<{id: string, pattern: Y.Map<any>}>}
 */
export function patternsForClip(doc, clipId) {
  return patternEntries(doc).filter(({ pattern }) => pattern.get("clip_id") === clipId);
}

/**
 * Every step in the song, keyed
 * "<clip_id>/<pattern_id>/<at>/<bank_id>.<index>".
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, step: Y.Map<any>}>}
 */
export function stepEntries(doc) {
  return objectEntries(readContainer(doc, "steps"), "step");
}

/**
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @param {string} patternId
 * @param {number} at
 * @param {string} bankId
 * @param {number} index
 * @returns {Y.Map<any>|null} the live step, or null
 */
export function getStep(doc, clipId, patternId, at, bankId, index) {
  return liveObject(readContainer(doc, "steps"), stepKey(clipId, patternId, at, bankId, index));
}

/**
 * Every step of one pattern.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @param {string} patternId
 * @returns {Array<{id: string, step: Y.Map<any>}>}
 */
export function stepsForPattern(doc, clipId, patternId) {
  return stepEntries(doc).filter(
    ({ step }) => step.get("clip_id") === clipId && step.get("pattern_id") === patternId,
  );
}

/**
 * Every step of every pattern of one clip.
 * @param {Y.Doc} doc
 * @param {string} clipId
 * @returns {Array<{id: string, step: Y.Map<any>}>}
 */
export function stepsForClip(doc, clipId) {
  return stepEntries(doc).filter(({ step }) => step.get("clip_id") === clipId);
}

/**
 * A pad with nothing on it: the shape every pad carries and the engine reads.
 * @param {string} trackId
 * @param {string} bankId
 * @param {number} index - 0-15
 * @returns {{track_id: string, bank_id: string, index: number, sample_id: null,
 *            slice_id: null, name: string, mode: string, pitch: number,
 *            gain_db: number, pan: number, attack_ms: number, decay_ms: number,
 *            sustain: number, release_ms: number,
 *            filter: {type: string, cutoff_hz: number, resonance: number},
 *            choke: number, reverse: boolean}}
 */
export function defaultPad(trackId, bankId, index) {
  return {
    track_id: trackId,
    bank_id: bankId,
    index,
    sample_id: ABSENT,
    slice_id: ABSENT,
    name: "",
    mode: "oneshot",
    pitch: 0,
    gain_db: 0,
    pan: 0,
    attack_ms: 0,
    decay_ms: 0,
    sustain: 1,
    release_ms: 0,
    filter: { type: "off", cutoff_hz: 20000, resonance: 0 },
    choke: 0,
    reverse: false,
  };
}

/**
 * A new bank and its sixteen empty pads, in the order they are written: a bank
 * always holds all sixteen pads, so a pad is an object from the start.
 * @param {string} trackId
 * @param {string} bankId
 * @param {string} name
 * @param {number} order - its place in the kit, from 0
 * @returns {{bank: object, pads: object[]}}
 */
export function newSamplerBank(trackId, bankId, name, order) {
  const bank = { id: bankId, track_id: trackId, name, order };
  const pads = [];
  for (let index = 0; index < LIMITS.padsPerBank; index += 1) {
    pads.push(defaultPad(trackId, bankId, index));
  }
  return { bank, pads };
}

/**
 * The bars a pattern clip's loop fills: `length_steps × step_beats` beats,
 * rounded up to whole bars, and at least one.
 * @param {number} lengthSteps
 * @param {number} stepBeats
 * @returns {number}
 */
export function lengthBarsForSteps(lengthSteps, stepBeats) {
  const steps = numberOr(lengthSteps, LIMITS.stepPositions / 4);
  const beats = numberOr(stepBeats, DEFAULT_STEP_BEATS);
  return Math.max(1, Math.ceil((steps * beats) / BEATS_PER_BAR));
}

/**
 * Whether a track plays a kit of pads rather than a SunVox module.
 * @param {Y.Map<any>|null|undefined} track
 * @returns {boolean}
 */
export function isSamplerTrack(track) {
  return deviceEngine(track) === SAMPLER_DEVICE.engine;
}

/**
 * Whether a clip holds steps and patterns (a pattern clip) rather than notes.
 * @param {Y.Map<any>|null|undefined} clip
 * @returns {boolean}
 */
export function isPatternClip(clip) {
  return clip?.get?.("kind") === "pattern";
}

/**
 * The tracks whose pads play one sample — the write a sample edit is, judged on
 * its effect: re-chopping or renaming a sample touches every track that plays
 * it, so a lock check has to see those tracks.
 * @param {object} snap - a snapshot
 * @param {string} sampleId
 * @returns {string[]} the track ids, sorted, each once
 */
export function sampleUsers(snap, sampleId) {
  if (typeof sampleId !== "string" || sampleId === "") return [];
  const ids = new Set();
  for (const pad of Object.values(snap?.pads ?? {})) {
    if (pad?.sample_id !== sampleId) continue;
    if (typeof pad.track_id === "string" && pad.track_id !== "") ids.add(pad.track_id);
  }
  return [...ids].sort();
}

/**
 * The whole song as plain JSON — the shape clients, the sequencer and a render
 * read, and the value two hubs compare after a restart.
 *
 * The arrangement is always there, even on a song written before the timeline
 * existed: an empty `{placements: {}, markers: {}, sections: {}}` reads the
 * same as a song with no arrangement container.
 * @param {Y.Doc} doc
 * @returns {{meta: {title: string, bpm: number, meter: number[], key: string},
 *            tracks: object[], scenes: object[], clips: Object<string, object>,
 *            takes: Object<string, object>,
 *            samples: Object<string, object>, slices: Object<string, object>,
 *            banks: Object<string, object>, pads: Object<string, object>,
 *            patterns: Object<string, object>, steps: Object<string, object>,
 *            midi_maps: Object<string, object>,
 *            arrangement: {placements: Object<string, object>,
 *                          markers: Object<string, object>,
 *                          sections: Object<string, object>}}}
 *   The sampler's six containers are plain objects keyed by each object's own
 *   ref id — a sample by its id, a slice by "<sample_id>/<slice_id>", a bank by
 *   "<track_id>/<bank_id>", a pad by "<track_id>/<bank_id>/<index>", a pattern
 *   by "<clip_id>/<pattern_id>" and a step by
 *   "<clip_id>/<pattern_id>/<at>/<bank_id>.<index>" — so the engine can read a
 *   pad or a step without walking the track or the clip. A pattern carries its
 *   own `motion` lanes (lane name → sorted points), which is how the engine
 *   reads a curve without a second lookup. A song written before the sampler
 *   existed reads all six as empty objects.
 *   `midi_maps` is a plain object too, keyed by the mapping's own id, so the
 *   page and the router read the whole table in one place; a song nobody has
 *   mapped a controller in reads it as an empty object.
 */
export function snapshot(doc) {
  const song = songMap(doc);

  const meta = toPlain(song.get("meta")) ?? {};
  const tracksValue = readContainer(doc, "tracks");
  const scenesValue = readContainer(doc, "scenes");

  const clips = [];
  const clipsValue = readContainer(doc, "clips");
  if (clipsValue instanceof Y.Map) {
    for (const [id, clip] of clipsValue.entries()) {
      clips.push([id, normalizeClip(id, clip)]);
    }
  }

  const takes = [];
  const takesValue = readContainer(doc, "takes");
  if (takesValue instanceof Y.Map) {
    for (const [id, take] of takesValue.entries()) {
      takes.push([id, normalizeTake(id, take)]);
    }
  }

  return {
    meta: {
      ...meta,
      title: typeof meta.title === "string" ? meta.title : "Untitled song",
      bpm: numberOr(meta.bpm, 120),
      meter: Array.isArray(meta.meter) && meta.meter.length === 2 ? meta.meter.map((beat) => numberOr(beat, 4)) : [4, 4],
      key: typeof meta.key === "string" ? meta.key : "C major",
    },
    tracks: tracksValue instanceof Y.Array ? tracksValue.toArray().map(normalizeTrack) : [],
    scenes: scenesValue instanceof Y.Array ? scenesValue.toArray().map(normalizeScene) : [],
    // Object.fromEntries defines own properties, so a clip id like "__proto__"
    // stays an ordinary key instead of touching the object's prototype.
    clips: Object.fromEntries(clips),
    takes: Object.fromEntries(takes),
    samples: snapshotContainer(doc, "samples", normalizeSample),
    slices: snapshotContainer(doc, "slices", normalizeSlice),
    banks: snapshotContainer(doc, "banks", normalizeBank),
    pads: snapshotContainer(doc, "pads", normalizePad),
    patterns: snapshotContainer(doc, "patterns", normalizePattern),
    steps: snapshotContainer(doc, "steps", normalizeStep),
    midi_maps: snapshotContainer(doc, "midi_maps", normalizeMidiMapping),
    arrangement: snapshotArrangement(doc),
  };
}

/**
 * One of the sampler's containers as a snapshot carries it: a plain object
 * keyed by the map's own key (each of those is the object's ref id).
 * @param {Y.Doc} doc
 * @param {string} key - the container's name in the song map
 * @param {(id: string, value: any) => object} normalize
 * @returns {Object<string, object>} empty when the song has no such container
 */
function snapshotContainer(doc, key, normalize) {
  const entries = [];
  const value = readContainer(doc, key);
  if (value instanceof Y.Map) {
    for (const [id, object] of value.entries()) entries.push([id, normalize(id, object)]);
  }
  // Object.fromEntries defines own properties, so a key like "__proto__" stays
  // an ordinary key (see the clips above).
  return Object.fromEntries(entries);
}

/**
 * The arrangement as a snapshot carries it: three plain objects keyed by id.
 * @param {Y.Doc} doc
 * @returns {{placements: Object<string, object>, markers: Object<string, object>,
 *            sections: Object<string, object>}}
 */
function snapshotArrangement(doc) {
  const placements = [];
  const placementsValue = readArrangementMap(doc, "placements");
  if (placementsValue instanceof Y.Map) {
    for (const [id, placement] of placementsValue.entries()) {
      placements.push([id, normalizePlacement(id, placement)]);
    }
  }
  const markers = [];
  const markersValue = readArrangementMap(doc, "markers");
  if (markersValue instanceof Y.Map) {
    for (const [id, marker] of markersValue.entries()) {
      markers.push([id, normalizeMarker(id, marker)]);
    }
  }
  const sections = [];
  const sectionsValue = readArrangementMap(doc, "sections");
  if (sectionsValue instanceof Y.Map) {
    for (const [id, section] of sectionsValue.entries()) {
      sections.push([id, normalizeSection(id, section)]);
    }
  }
  return {
    placements: Object.fromEntries(placements),
    markers: Object.fromEntries(markers),
    sections: Object.fromEntries(sections),
  };
}

/**
 * What is wrong with a song document, in plain English.
 *
 * The rules every command keeps, checked over a whole document at once:
 *   - a song holds at most `LIMITS.tracks` tracks and `LIMITS.scenes` scenes;
 *   - no two tracks, scenes or clips share an id;
 *   - every clip sits on a track and in a scene the song still has;
 *   - a clip's notes end inside its own length, the rule `clip.write`,
 *     `clip.edit_notes` and `clip.set_length` enforce on their own edits (four
 *     beats to the bar, see `BEATS_PER_BAR`);
 *   - a clip holds at most `LIMITS.takesPerClip` takes;
 *   - every take names an audio clip the song still has;
 *   - an audio clip's comp is in beat order, inside the clip, and every one of
 *     its segments names a take of that clip that is not discarded — the rule
 *     `clip.set_comp` enforces on its own edits;
 *   - the sampler's objects hang together: a bank sits on a sampler track, a
 *     pad's sample is in the song and the slice it names is a slice of that
 *     sample, every chain entry is a pattern of its own clip, every step names
 *     a pad of its clip's track inside its clip's step positions, and the
 *     counts stay inside their limits (banks per kit, pads per bank, samples
 *     per song, slices per sample, patterns per clip, chain length, step
 *     entries per pattern, locks per step) — the rules the sampler commands
 *     enforce on their own edits;
 *   - a song holds at most `LIMITS.midiMaps` MIDI mappings, and no two live
 *     ones answer the same message on the same controller (one message has one
 *     live action) — the rules the midi commands enforce on their own edits;
 *   - the arrangement holds at most `LIMITS.placements` placements,
 *     `LIMITS.markers` markers and `LIMITS.sections` sections, ends at bar
 *     `LIMITS.arrangementBars`, has no two placements overlapping on one
 *     track and no two sections overlapping each other, and every placement
 *     still names a clip of its own track — the rules the arrangement
 *     commands enforce on their own edits.
 *
 * The history dry-runs an undo's plan on a clone of the document and calls
 * this, so a plan that would leave the song in one of these states is refused
 * whole instead of leaving a clip pointing at a track that is gone.
 * @param {Y.Doc} doc
 * @returns {string[]} one plain-English reason per problem; empty when the
 *   document is consistent
 */
export function checkInvariants(doc) {
  const song = snapshot(doc);
  const reasons = [];

  if (song.tracks.length > LIMITS.tracks) {
    reasons.push(`The song would have ${song.tracks.length} tracks; a song can have at most ${LIMITS.tracks} tracks.`);
  }
  if (song.scenes.length > LIMITS.scenes) {
    reasons.push(`The song would have ${song.scenes.length} scenes; a song can have at most ${LIMITS.scenes} scenes.`);
  }

  reasons.push(...duplicateIdReasons(song.tracks, "track"));
  reasons.push(...duplicateIdReasons(song.scenes, "scene"));
  reasons.push(...duplicateIdReasons(Object.values(song.clips), "clip"));
  reasons.push(...duplicateIdReasons(Object.values(song.takes), "take"));

  const trackIds = new Set(song.tracks.map((track) => track.id));
  const sceneIds = new Set(song.scenes.map((scene) => scene.id));

  const takesById = new Map();
  const takesPerClip = new Map();
  for (const take of Object.values(song.takes)) {
    takesById.set(take.id, take);
    takesPerClip.set(take.clip_id, (takesPerClip.get(take.clip_id) ?? 0) + 1);
    const owner = song.clips[take.clip_id];
    if (!owner) {
      reasons.push(`The take "${take.id}" would be left without its clip: there is no clip "${take.clip_id}" in the song.`);
    } else if (owner.kind !== "audio") {
      const ownerLabel = owner.name === "" ? `clip "${owner.id}"` : `clip "${owner.name}"`;
      reasons.push(`The take "${take.id}" would belong to the ${ownerLabel}, which holds notes rather than a recording.`);
    }
  }

  for (const clip of Object.values(song.clips)) {
    const label = clip.name === "" ? `clip "${clip.id}"` : `clip "${clip.name}"`;
    if (!trackIds.has(clip.track_id)) {
      reasons.push(`The ${label} would be left without its track: there is no track "${clip.track_id}" in the song.`);
    }
    if (!sceneIds.has(clip.scene_id)) {
      reasons.push(`The ${label} would be left without its scene: there is no scene "${clip.scene_id}" in the song.`);
    }
    const limit = clip.length_bars * BEATS_PER_BAR;
    if (clip.kind === "audio") {
      const count = takesPerClip.get(clip.id) ?? 0;
      if (count > LIMITS.takesPerClip) {
        reasons.push(
          `The ${label} would have ${count} takes; a clip can have at most ${LIMITS.takesPerClip} takes.`,
        );
      }
      reasons.push(...segmentReasons(clip, label, takesById, limit));
    }
    for (let index = 0; index < clip.notes.length; index += 1) {
      const note = clip.notes[index];
      if (note.t + note.d > limit) {
        reasons.push(
          `Note ${index + 1} in the ${label} would end at beat ${beatText(note.t + note.d)}, past its ${barsText(clip.length_bars)}.`,
        );
        break;
      }
    }
  }

  reasons.push(...arrangementReasons(song));
  reasons.push(...samplerReasons(song));
  reasons.push(...midiReasons(song));

  return reasons;
}

/**
 * What is wrong with a song's arrangement, in plain English.
 *
 * Placements are checked against the tracks and clips they name, against the
 * 999-bar end of the timeline and against each other on one track; markers and
 * sections against the same end, their own counts, and each other. Overlaps
 * are found by sorting each track's (or the sections') ranges by start, so a
 * full 2048-placement song is one pass, not a quadratic scan.
 * @param {object} song - a snapshot
 * @returns {string[]}
 */
function arrangementReasons(song) {
  const arrangement = song.arrangement ?? { placements: {}, markers: {}, sections: {} };
  const placements = Object.values(arrangement.placements ?? {});
  const markers = Object.values(arrangement.markers ?? {});
  const sections = Object.values(arrangement.sections ?? {});
  const reasons = [];

  if (placements.length > LIMITS.placements) {
    reasons.push(
      `The arrangement would hold ${placements.length} placements; an arrangement can hold at most ${LIMITS.placements} placements.`,
    );
  }
  if (markers.length > LIMITS.markers) {
    reasons.push(
      `The song would hold ${markers.length} markers; a song can hold at most ${LIMITS.markers} markers.`,
    );
  }
  if (sections.length > LIMITS.sections) {
    reasons.push(
      `The song would hold ${sections.length} sections; a song can hold at most ${LIMITS.sections} sections.`,
    );
  }

  reasons.push(...duplicateIdReasons(placements, "placement"));
  reasons.push(...duplicateIdReasons(markers, "marker"));
  reasons.push(...duplicateIdReasons(sections, "section"));

  const byTrack = new Map();
  for (const placement of placements) {
    const which = `The placement "${placement.id}"`;
    const track = song.tracks.find((item) => item.id === placement.track_id);
    const clip = song.clips[placement.clip_id];
    if (!track) {
      reasons.push(`${which} would be left without its track: there is no track "${placement.track_id}" in the song.`);
    }
    if (!clip) {
      reasons.push(`${which} would be left without its clip: there is no clip "${placement.clip_id}" in the song.`);
    } else if (clip.track_id !== placement.track_id) {
      reasons.push(
        `${which} would play clip "${clip.id}", which sits on track "${clip.track_id}", not "${placement.track_id}".`,
      );
    }
    if (placement.start_bar + placement.bars > LIMITS.arrangementBars) {
      reasons.push(
        `${which} would end at bar ${placement.start_bar + placement.bars}, past the ${LIMITS.arrangementBars}-bar end of the arrangement.`,
      );
    }
    if (!onOffsetGrid(placement.offset_beats)) {
      reasons.push(
        `${which} would start at an offset of ${placement.offset_beats} beats, which is off the sixteenth-of-a-beat grid.`,
      );
    }
    if (placement.fade_in_beats + placement.fade_out_beats > placement.bars * BEATS_PER_BAR) {
      reasons.push(
        `${which} would fade in over ${placement.fade_in_beats} and out over ${placement.fade_out_beats} beats, longer than its ${barsText(placement.bars)}.`,
      );
    }
    const lane = byTrack.get(placement.track_id) ?? [];
    lane.push(placement);
    byTrack.set(placement.track_id, lane);
  }
  for (const [trackId, lane] of byTrack) {
    lane.sort((a, b) => a.start_bar - b.start_bar);
    for (let index = 1; index < lane.length; index += 1) {
      const previous = lane[index - 1];
      const current = lane[index];
      if (current.start_bar >= previous.start_bar + previous.bars) continue;
      reasons.push(`The placements "${previous.id}" and "${current.id}" would overlap on track "${trackId}".`);
    }
  }

  for (const marker of markers) {
    if (marker.bar > LIMITS.arrangementBars) {
      reasons.push(
        `The marker "${marker.id}" would sit at bar ${marker.bar}, past the ${LIMITS.arrangementBars}-bar end of the arrangement.`,
      );
    }
  }

  for (const section of sections) {
    const which = `The section "${section.id}"`;
    if (!(section.start_bar < section.end_bar)) {
      reasons.push(`${which} would end at bar ${section.end_bar}, before it starts at bar ${section.start_bar}.`);
    }
    if (section.end_bar > LIMITS.arrangementBars) {
      reasons.push(`${which} would end at bar ${section.end_bar}, past the ${LIMITS.arrangementBars}-bar end of the arrangement.`);
    }
  }
  const ordered = [...sections].sort((a, b) => a.start_bar - b.start_bar);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.start_bar >= previous.end_bar) continue;
    reasons.push(`The sections "${previous.id}" and "${current.id}" would overlap.`);
  }

  return reasons;
}

/**
 * What is wrong with a song's sampler objects, in plain English.
 *
 * The rules one sampler edit can look after on its own, checked over the whole
 * song at once: every bank sits on a sampler track, every pad's sample is in
 * the song and the slice it names belongs to that sample, every chain entry is
 * a pattern of its own clip, every step names a pad of its clip's track inside
 * the clip's step positions, every motion lane names a pad field of the clip's
 * track with its points inside the loop and inside that field's own range, a
 * slice stays inside its sample's frames, and no count outgrows its limit
 * (banks per kit, pads per bank, samples per song, slices per sample, patterns
 * per clip, chain length, step entries per pattern, locks per step, motion
 * points per lane, motion lanes per pattern).
 *
 * The history dry-runs an undo's plan on a clone and calls this, so a plan that
 * would leave, say, a pad pointing at a slice a newer edit removed is refused
 * whole instead of half-landing.
 * @param {object} song - a snapshot
 * @returns {string[]}
 */
function samplerReasons(song) {
  const reasons = [];
  const samples = Object.values(song.samples ?? {});
  const slices = Object.values(song.slices ?? {});
  const banks = Object.values(song.banks ?? {});
  const pads = Object.values(song.pads ?? {});
  const patterns = Object.values(song.patterns ?? {});
  const steps = Object.values(song.steps ?? {});

  if (samples.length + slices.length + banks.length + pads.length + patterns.length + steps.length === 0) {
    return reasons;
  }

  // Samples: the rate an import may land at, and the 60-second cap.
  if (samples.length > LIMITS.samplesPerSong) {
    reasons.push(
      `The song would hold ${samples.length} samples; a song can hold at most ${LIMITS.samplesPerSong} samples.`,
    );
  }
  const samplesById = new Map();
  for (const sample of samples) {
    samplesById.set(sample.id, sample);
    const which = `The sample "${nameOrId(sample.name, sample.id)}"`;
    if (!SAMPLE_RATES.includes(sample.rate)) {
      reasons.push(`${which} would have a rate of ${sample.rate} Hz; a sample's rate is one of ${SAMPLE_RATES.join(", ")}.`);
    }
    if (!(sample.frames > 0)) reasons.push(`${which} would hold no frames.`);
    if (sample.frames * sample.channels > LIMITS.sampleSamples) {
      reasons.push(
        `${which} would hold ${sample.frames * sample.channels} samples; a sample can hold at most ${LIMITS.sampleSamples} (frames × channels).`,
      );
    }
  }

  // Slices: each one is inside its sample's frames, and there are few enough.
  const slicesByKey = new Map();
  const slicesPerSample = new Map();
  for (const slice of slices) {
    const which = `The slice "${slice.id}" of sample "${slice.sample_id}"`;
    slicesByKey.set(sliceKey(slice.sample_id, slice.id), slice);
    slicesPerSample.set(slice.sample_id, (slicesPerSample.get(slice.sample_id) ?? 0) + 1);
    const sample = samplesById.get(slice.sample_id);
    if (!sample) {
      reasons.push(`${which} would be left without its sample: there is no sample "${slice.sample_id}" in the song.`);
      continue;
    }
    if (!(slice.start_frame >= 0 && slice.start_frame < slice.end_frame && slice.end_frame <= sample.frames)) {
      reasons.push(
        `${which} would run from frame ${slice.start_frame} to frame ${slice.end_frame}, outside the ${sample.frames} frames of that sample.`,
      );
    }
  }
  for (const [sampleId, count] of slicesPerSample) {
    if (count <= LIMITS.slicesPerSample) continue;
    const label = nameOrId(samplesById.get(sampleId)?.name, sampleId);
    reasons.push(
      `The sample "${label}" would have ${count} slices; a sample can have at most ${LIMITS.slicesPerSample} slices.`,
    );
  }

  // Banks: on a sampler track, and no more than a kit holds.
  const tracksById = new Map(song.tracks.map((track) => [track.id, track]));
  const bankKeys = new Set();
  const banksPerTrack = new Map();
  for (const bank of banks) {
    bankKeys.add(bankKey(bank.track_id, bank.id));
    banksPerTrack.set(bank.track_id, (banksPerTrack.get(bank.track_id) ?? 0) + 1);
    const which = `The bank "${nameOrId(bank.name, bank.id)}"`;
    const track = tracksById.get(bank.track_id);
    if (!track) {
      reasons.push(`${which} would be left without its track: there is no track "${bank.track_id}" in the song.`);
    } else if (track.device?.engine !== SAMPLER_DEVICE.engine) {
      reasons.push(`${which} would sit on track "${nameOrId(track.name, track.id)}", which is not a sampler track.`);
    }
  }
  for (const [trackId, count] of banksPerTrack) {
    if (count <= LIMITS.banksPerKit) continue;
    const label = nameOrId(tracksById.get(trackId)?.name, trackId);
    reasons.push(`The kit of track "${label}" would have ${count} banks; a kit can have at most ${LIMITS.banksPerKit} banks.`);
  }

  // Pads: a bank's own pad, playing a sample of the song and a slice of it.
  const padKeys = new Set();
  for (const pad of pads) {
    padKeys.add(padKey(pad.track_id, pad.bank_id, pad.index));
    const which = `The pad ${Number(pad.index) + 1} of bank "${pad.bank_id}"`;
    if (!bankKeys.has(bankKey(pad.track_id, pad.bank_id))) {
      reasons.push(`${which} would be left without its bank: track "${pad.track_id}" has no bank "${pad.bank_id}".`);
      continue;
    }
    if (!(Number.isInteger(pad.index) && pad.index >= 0 && pad.index < LIMITS.padsPerBank)) {
      reasons.push(
        `${which} would sit at index ${pad.index}; a bank holds ${LIMITS.padsPerBank} pads, numbered 0 to ${LIMITS.padsPerBank - 1}.`,
      );
    }
    if (pad.sample_id === ABSENT) {
      if (pad.slice_id !== ABSENT) reasons.push(`${which} would play a slice without a sample.`);
      continue;
    }
    if (!samplesById.has(pad.sample_id)) {
      reasons.push(`${which} would play sample "${pad.sample_id}", which is not in the song.`);
      continue;
    }
    if (pad.slice_id === ABSENT) continue;
    if (!slicesByKey.has(sliceKey(pad.sample_id, pad.slice_id))) {
      reasons.push(
        `${which} would play slice "${pad.slice_id}", which is not a slice of sample "${pad.sample_id}".`,
      );
    }
  }

  // Patterns, their clips and their chains.
  const patternKeys = new Set();
  const patternsPerClip = new Map();
  for (const pattern of patterns) {
    patternKeys.add(patternKey(pattern.clip_id, pattern.id));
    patternsPerClip.set(pattern.clip_id, (patternsPerClip.get(pattern.clip_id) ?? 0) + 1);
    const clip = song.clips[pattern.clip_id];
    const which = `The pattern "${nameOrId(pattern.name, pattern.id)}"`;
    if (!clip) {
      reasons.push(`${which} would be left without its clip: there is no clip "${pattern.clip_id}" in the song.`);
    } else if (clip.kind !== "pattern") {
      reasons.push(`${which} would sit on clip "${nameOrId(clip.name, clip.id)}", which holds notes rather than patterns.`);
    }
  }
  for (const [clipId, count] of patternsPerClip) {
    if (count <= LIMITS.patternsPerClip) continue;
    const clip = song.clips[clipId];
    const label = nameOrId(clip?.name, clipId);
    reasons.push(`The clip "${label}" would hold ${count} patterns; a pattern clip can hold at most ${LIMITS.patternsPerClip} patterns.`);
  }
  for (const clip of Object.values(song.clips)) {
    if (clip.kind !== "pattern") continue;
    const which = `The clip "${nameOrId(clip.name, clip.id)}"`;
    const chain = Array.isArray(clip.chain) ? clip.chain : [];
    if (chain.length > LIMITS.chainLength) {
      reasons.push(`${which} would chain ${chain.length} patterns; a chain is at most ${LIMITS.chainLength} long.`);
    }
    for (const entry of chain) {
      if (patternKeys.has(patternKey(clip.id, entry))) continue;
      reasons.push(`${which} would chain "${entry}", which is not a pattern of that clip.`);
    }
    if (!(clip.length_steps >= 1 && clip.length_steps <= LIMITS.stepPositions)) {
      reasons.push(
        `${which} would have ${clip.length_steps} step positions; a pattern holds 1 to ${LIMITS.stepPositions}.`,
      );
    }
    if (!STEP_BEATS_VALUES.includes(clip.step_beats)) {
      reasons.push(`${which} would use a step of ${clip.step_beats} beats; a step is one of ${STEP_BEATS_VALUES.join(", ")}.`);
    }
    if (!(clip.swing >= 0 && clip.swing <= 0.75)) {
      reasons.push(`${which} would swing ${clip.swing}; swing is between 0 and 0.75.`);
    }
  }

  // Steps: on a pattern of their clip, on a pad of their track, inside the loop.
  const stepsPerPattern = new Map();
  for (const step of steps) {
    const key = patternKey(step.clip_id, step.pattern_id);
    const which = `The step at position ${step.at} of pattern "${step.pattern_id}"`;
    stepsPerPattern.set(key, (stepsPerPattern.get(key) ?? 0) + 1);
    if (!patternKeys.has(key)) {
      reasons.push(
        `${which} would be left without its pattern: clip "${step.clip_id}" has no pattern "${step.pattern_id}".`,
      );
      continue;
    }
    const clip = song.clips[step.clip_id];
    const positions = Number(clip?.length_steps) || 0;
    if (!(Number.isInteger(step.at) && step.at >= 0 && step.at < positions)) {
      reasons.push(
        `${which} would sit outside the ${positions} step positions of clip "${nameOrId(clip?.name, step.clip_id)}".`,
      );
    }
    if (!padKeys.has(padKey(clip?.track_id ?? "", step.bank_id, step.index))) {
      reasons.push(
        `${which} would name a pad that is not on the clip's track: there is no pad ${Number(step.index) + 1} in bank "${step.bank_id}".`,
      );
    }
    const lockCount = Object.keys(step.locks ?? {}).length;
    if (lockCount > LIMITS.locksPerStep) {
      reasons.push(`${which} would carry ${lockCount} locks; a step carries at most ${LIMITS.locksPerStep} locks.`);
    }
  }
  for (const [key, count] of stepsPerPattern) {
    if (count <= LIMITS.stepEntriesPerPattern) continue;
    reasons.push(
      `A pattern would hold ${count} steps; a pattern can hold at most ${LIMITS.stepEntriesPerPattern} steps.`,
    );
  }

  // Motion: one lane per pad field, each point inside the loop and inside the
  // field's own range. A lane names a pad of the clip's track and a field the
  // pad's own controls offer, so a curve can never aim at something the pad
  // does not have.
  for (const pattern of patterns) {
    const motion = pattern.motion && typeof pattern.motion === "object" ? pattern.motion : {};
    const lanes = Object.keys(motion);
    if (lanes.length === 0) continue;
    const clip = song.clips[pattern.clip_id];
    const which = `The pattern "${nameOrId(pattern.name, pattern.id)}"`;
    if (lanes.length > LIMITS.motionLanesPerPattern) {
      reasons.push(
        `${which} would hold ${lanes.length} motion lanes; a pattern holds at most ${LIMITS.motionLanesPerPattern} motion lanes.`,
      );
    }
    const positions = Number(clip?.length_steps) || 0;
    const trackId = typeof clip?.track_id === "string" ? clip.track_id : "";
    for (const lane of lanes) {
      const laneParts = motionLaneParts(lane);
      if (!laneParts) {
        reasons.push(`${which} would hold the motion lane "${lane}", which names no pad and parameter.`);
        continue;
      }
      const range = MOTION_PARAM_RANGES[laneParts.param];
      if (!range) {
        reasons.push(
          `${which} would sweep "${laneParts.param}" on pad ${laneParts.index + 1}, which is not one of a pad's numeric fields (${MOTION_PARAMS.join(", ")}).`,
        );
        continue;
      }
      if (trackId !== "" && !padKeys.has(padKey(trackId, laneParts.bankId, laneParts.index))) {
        reasons.push(
          `${which} would sweep pad ${laneParts.index + 1} of bank "${laneParts.bankId}", which is not on the clip's track.`,
        );
        continue;
      }
      const points = Array.isArray(motion[lane]) ? motion[lane] : [];
      if (points.length > LIMITS.motionPointsPerLane) {
        reasons.push(
          `${which} would hold ${points.length} motion points on one lane; a lane holds at most ${LIMITS.motionPointsPerLane} motion points.`,
        );
        continue;
      }
      if (!(positions > 0)) continue;
      for (const point of points) {
        const stepFrac = Number(point.step_frac);
        const amount = Number(point.value);
        if (!(stepFrac >= 0 && stepFrac < positions)) {
          reasons.push(
            `${which} would put a motion point at step ${beatText(stepFrac)}, outside its ${positions} step positions.`,
          );
          break;
        }
        if (!(amount >= range[0] && amount <= range[1])) {
          reasons.push(
            `${which} would sweep "${laneParts.param}" to ${amount} on pad ${laneParts.index + 1}, outside its ${range[0]} to ${range[1]}.`,
          );
          break;
        }
      }
    }
  }

  return reasons;
}

/**
 * What is wrong with a song's MIDI mappings, in plain English.
 *
 * Two rules, both of which the midi commands keep on their own edits: the table
 * stays inside `LIMITS.midiMaps`, and no two live mappings answer the same
 * message on the same controller — one message has one live action, so the
 * router can never have to choose between two of them.
 * @param {object} song - a snapshot
 * @returns {string[]}
 */
function midiReasons(song) {
  const mappings = Object.values(song.midi_maps ?? {});
  const reasons = [];
  if (mappings.length > LIMITS.midiMaps) {
    reasons.push(
      `The song would hold ${mappings.length} MIDI mappings; a song can hold at most ${LIMITS.midiMaps} MIDI mappings.`,
    );
  }

  const live = mappings.filter((mapping) => mapping.proposed !== true);
  for (let index = 0; index < live.length; index += 1) {
    for (let other = index + 1; other < live.length; other += 1) {
      if (live[index].device_name !== live[other].device_name) continue;
      if (!sameMessage(live[index].message, live[other].message)) continue;
      reasons.push(
        `The mappings "${live[index].id}" and "${live[other].id}" would both be live for ${messageName(live[index].message)} on "${live[index].device_name}"; one message has one live action.`,
      );
    }
  }
  return reasons;
}

/** @returns {boolean} whether two MIDI messages are the same message. */
function sameMessage(left, right) {
  if (!left || !right) return false;
  return left.type === right.type && left.channel === right.channel && left.number === right.number;
}

/** @returns {string} a message in words, for a message about the mappings. */
function messageName(message) {
  const number = Number(message?.number);
  if (message?.type === "note") return `note ${number}`;
  if (message?.type === "cc") return `control change ${number}`;
  return `program change ${number}`;
}

/** @returns {string} a name for a message, or the id when it has none. */
function nameOrId(name, id) {
  return typeof name === "string" && name !== "" ? name : id;
}

/**
 * What is wrong with one audio clip's comp, in plain English.
 * @param {object} clip - the clip from a snapshot (it carries `kind: "audio"`)
 * @param {string} label - what the messages call the clip
 * @param {Map<string, object>} takesById - every take in the song
 * @param {number} limit - the clip's length in beats
 * @returns {string[]}
 */
function segmentReasons(clip, label, takesById, limit) {
  const reasons = [];
  const segments = Array.isArray(clip.comp) ? clip.comp : [];
  let previous = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const which = `Segment ${index + 1} of the ${label}`;
    if (!(segment.from_beat < segment.to_beat)) {
      reasons.push(
        `${which} would end at beat ${beatText(segment.to_beat)}, before it starts at beat ${beatText(segment.from_beat)}.`,
      );
      continue;
    }
    if (segment.from_beat < 0 || segment.to_beat > limit) {
      reasons.push(
        `${which} would run from beat ${beatText(segment.from_beat)} to beat ${beatText(segment.to_beat)}, outside the ${barsText(clip.length_bars)} of that clip.`,
      );
      continue;
    }
    if (previous && segment.from_beat < previous.from_beat) {
      reasons.push(
        `${which} would start at beat ${beatText(segment.from_beat)}, before the segment in front of it; segments go in beat order.`,
      );
      continue;
    }
    if (previous && segment.from_beat < previous.to_beat) {
      reasons.push(
        `${which} would start at beat ${beatText(segment.from_beat)}, inside the segment that ends at beat ${beatText(previous.to_beat)}.`,
      );
      continue;
    }
    previous = segment;
    const take = takesById.get(segment.take_id);
    if (!take || take.clip_id !== clip.id) {
      reasons.push(`${which} would play take "${segment.take_id}", which is not a take of that clip.`);
      continue;
    }
    if (take.discarded) {
      reasons.push(`${which} would play take "${take.id}", which is discarded.`);
    }
  }
  return reasons;
}

/** @returns {string[]} one reason per id that two objects of this list share. */
function duplicateIdReasons(items, label) {
  const seen = new Set();
  const reported = new Set();
  const reasons = [];
  for (const item of items) {
    const id = typeof item?.id === "string" ? item.id : "";
    if (seen.has(id) && !reported.has(id)) {
      reported.add(id);
      reasons.push(`The song would have two ${label}s with the id "${id}".`);
    }
    seen.add(id);
  }
  return reasons;
}

/** @returns {string} a beat position without float noise. */
function beatText(beats) {
  return String(Math.round(beats * 1000) / 1000);
}

/** @returns {string} "1 bar" vs "8 bars" without the plural bug. */
function barsText(bars) {
  return bars === 1 ? "1 bar" : `${bars} bars`;
}

/**
 * Write a before/after map back onto a document — the second half of an undo
 * or a redo.
 *
 * Keys are `"<ref>|<field>"`:
 *   - `"track:abc|gain_db"` sets one field of that track;
 *   - `"track:abc|device.params.Cutoff"` sets one controller value inside the
 *     track's device and leaves its other controllers alone;
 *   - `"clip:abc|*"` with an object (re)creates the whole clip, and with
 *     `null` deletes it;
 *   - `"take:abc|*"` does the same for a take, and `"take:abc|offset_frames"`
 *     writes one field of it;
 *   - `"sample:abc|*"`, `"slice:<sample>/<slice>|*"`, `"bank:<track>/<bank>|*"`,
 *     `"pad:<track>/<bank>/<index>|*"`, `"pattern:<clip>/<pattern>|*"` and
 *     `"step:<clip>/<pattern>/<at>/<bank>.<index>|*"` do the same for a sampler
 *     object, and a plain field name (or `"locks.<name>"`) writes one field of
 *     one of them — which is how one pad, one step or one lock undoes without
 *     touching its neighbours;
 *   - `"midi:abc|*"` does the same for one MIDI mapping, and a plain field name
 *     (`"proposed"`, `"accepted_action"`, `"action"`) writes one field of it;
 *   - `"motion:<clip>/<pattern>/<bank>.<index>|<param>|*"` writes ONE motion
 *     lane of one pattern: an array of `{step_frac, value}` points, or `null`
 *     to take the lane away. A lane is one key of its pattern's nested `motion`
 *     map, so its other lanes are left exactly as they are — two lanes of one
 *     pattern undo independently, and two writers on different lanes never
 *     overwrite each other;
 *   - `"placement:abc|*"`, `"marker:abc|*"` and `"section:abc|*"` do the same
 *     for the three arrangement objects, and `"placement:abc|bars"` (and its
 *     siblings) writes one field of one of them;
 *   - `"track:abc|*"` and `"scene:abc|*"` do the same at the object's original
 *     position, carried inside the object JSON as `_index`, `_after` and
 *     `_before` (stripped again on the way in and out, so they never show up
 *     in a snapshot).
 *
 * `_index`, `_after` and `_before` are position hints, not song data:
 * `snapshot()` drops them, and `readField()` strips them from what it reads, so
 * a stored creation value compares cleanly with the document. `_after` is the
 * id of the sibling the object followed when it was recorded and wins on
 * restore when that sibling is still there; `_before` is the id of the sibling
 * that followed it (recorded when an object is removed) and is the second
 * anchor, so removing one object and then another in front of it can be undone
 * in the order it happened; `_index` is the last fallback, clamped to the list,
 * so restoring a track after an unrelated one was removed does not push it to
 * the wrong place.
 *
 * Runs inside the caller's transaction, like every other edit.
 * @param {Y.Doc} doc
 * @param {Map<string, any>|Object<string, any>|null} plan
 * @returns {void}
 */
export function applyBeforeAfter(doc, plan) {
  if (!plan) return;
  const entries = plan instanceof Map ? [...plan.entries()] : Object.entries(plan);
  for (const [key, value] of entries) {
    const split = splitRefField(key);
    if (!split) throw new Error(`Studio: "${key}" is not a "<ref>|<field>" before/after key`);
    const target = parseObjectRef(split.ref);
    if (!target) throw new Error(`Studio: "${split.ref}" is not an object reference`);
    switch (target.kind) {
      case "song":
        writeMeta(doc, split.field, value);
        break;
      case "track":
        writeListObject(doc, "tracks", target.id, split.field, value, "track");
        break;
      case "scene":
        writeListObject(doc, "scenes", target.id, split.field, value, "scene");
        break;
      case "clip":
        writeClip(doc, target.id, split.field, value);
        break;
      case "take":
        writeTake(doc, target.id, split.field, value);
        break;
      case "sample":
      case "slice":
      case "bank":
      case "pad":
      case "pattern":
      case "step":
      case "midi":
        writeContainerObject(doc, target.kind, target.id, split.field, value);
        break;
      case "motion":
        writeMotionLane(doc, target.id, split.field, value);
        break;
      case "placement":
      case "marker":
      case "section":
        writeArrangementObject(doc, target.kind, target.id, split.field, value);
        break;
      default:
        throw new Error(`Studio: "${target.kind}" is not an object kind`);
    }
  }
}

/**
 * Read one value out of the document by object ref and field.
 *
 * The companion of `applyBeforeAfter`: an undo checks a command's `after`
 * against what the document holds now, key by key.
 * @param {Y.Doc} doc
 * @param {string} ref - e.g. `"clip:abc"` or `"song:meta"`
 * @param {string} [field] - "*" for the whole object (the default), a plain
 *   field name, or a controller path like `"device.params.Cutoff"`
 * @returns {any} the value as the document holds it, or `null` when the object
 *   or the field is not there. A whole track or scene carries its current
 *   `_index` and `_after` (the id of the sibling before it), matching the JSON
 *   a creating command wrote; any position hint stored inside the object is
 *   stripped first, so it never shows up in a snapshot or a comparison. A
 *   `_before` hint is only an anchor for a restore (see `applyBeforeAfter`),
 *   so it is never reported here.
 */
export function readField(doc, ref, field = "*") {
  const target = parseObjectRef(ref);
  if (!target) return ABSENT;

  if (target.kind === "song") {
    const meta = songMap(doc).get("meta");
    if (meta === undefined) return ABSENT;
    return field === "*" ? toPlain(meta) : readPath(meta, fieldPath(field));
  }

  if (target.kind === "clip") {
    const clip = getClip(doc, target.id);
    if (!clip) return ABSENT;
    if (field === "*") return toPlain(clip);
    return readPath(clip, fieldPath(field));
  }

  if (target.kind === "take") {
    const take = getTake(doc, target.id);
    if (!take) return ABSENT;
    if (field === "*") return toPlain(take);
    return readPath(take, fieldPath(field));
  }

  if (OBJECT_MAP_OF[target.kind]) {
    const object = containerObject(doc, target.kind, target.id);
    if (!object) return ABSENT;
    if (field === "*") return toPlain(object);
    return readPath(object, fieldPath(field));
  }

  if (target.kind === "motion") {
    const parts = motionParts(target.id);
    const pattern = parts ? getPattern(doc, parts.clipId, parts.patternId) : null;
    if (!pattern) return ABSENT;
    const motion = motionOf(pattern);
    if (!Object.hasOwn(motion, parts.lane)) return ABSENT;
    return cloneJson(motion[parts.lane]);
  }

  if (target.kind === "placement" || target.kind === "marker" || target.kind === "section") {
    const object = arrangementObject(doc, target.kind, target.id);
    if (!object) return ABSENT;
    if (field === "*") return toPlain(object);
    return readPath(object, fieldPath(field));
  }

  if (target.kind === "track" || target.kind === "scene") {
    const list = readContainer(doc, target.kind === "track" ? "tracks" : "scenes");
    if (!(list instanceof Y.Array)) return ABSENT;
    const items = list.toArray();
    const index = items.findIndex((item) => item instanceof Y.Map && item.get("id") === target.id);
    if (index < 0) return ABSENT;
    const object = items[index];
    if (field === "*") {
      const { _index, _after, _before, ...plain } = toPlain(object) ?? {};
      const previous = index > 0 ? items[index - 1] : null;
      return {
        ...plain,
        _index: index,
        _after: typeof previous?.get?.("id") === "string" ? previous.get("id") : ABSENT,
      };
    }
    return readPath(object, fieldPath(field));
  }

  return ABSENT;
}

/**
 * The keys a history field path names, outermost first.
 *
 * `"device.params.Cutoff"` is `["device", "params", "Cutoff"]`; anything else
 * is one field of the object, so a plain field name can never be mistaken for
 * a path.
 * @param {string} field
 * @returns {string[]}
 */
function fieldPath(field) {
  if (field.startsWith(PARAM_FIELD_PREFIX) && field.length > PARAM_FIELD_PREFIX.length) {
    return ["device", "params", field.slice(PARAM_FIELD_PREFIX.length)];
  }
  // One lock inside a step's `locks`: two edits to different locks of one step
  // then undo independently (a step carries at most eight of them).
  if (field.startsWith(LOCK_FIELD_PREFIX) && field.length > LOCK_FIELD_PREFIX.length) {
    return ["locks", field.slice(LOCK_FIELD_PREFIX.length)];
  }
  // The device-type guard a set_param entry carries (read-only, never restored).
  if (field === "device.type") return ["device", "type"];
  return [field];
}

/**
 * Follow a field path down a Y.Map (or plain object) and return the value as
 * plain JSON.
 * @param {any} source
 * @param {string[]} path
 * @returns {any} the value, or `null` when the path is not there
 */
function readPath(source, path) {
  let value = source;
  for (const key of path) {
    if (value instanceof Y.Map) value = value.get(key);
    else if (value !== null && typeof value === "object") value = value[key];
    else return ABSENT;
  }
  return value === undefined ? ABSENT : toPlain(value);
}

/** Write one field (or the whole value) of the song's meta. */
function writeMeta(doc, field, value) {
  const song = songMap(doc);
  if (field === "*") {
    if (value === ABSENT) song.delete("meta");
    else song.set("meta", cloneJson(value) ?? {});
    return;
  }
  const next = { ...(toPlain(song.get("meta")) ?? {}) };
  if (value === ABSENT) delete next[field];
  else next[field] = cloneJson(value);
  song.set("meta", next);
}

/**
 * Write one field of a live object: a plain field (`"gain_db"`), or one entry
 * of a nested object field (`"device.params.Cutoff"`). A `null` value deletes
 * the field, or the named entry of the nested object.
 * @param {Y.Map<any>} item
 * @param {string} field
 * @param {any} value
 */
function writeField(item, field, value) {
  const path = fieldPath(field);
  if (path.length === 1) {
    if (value === ABSENT) item.delete(field);
    else item.set(field, cloneJson(value));
    return;
  }
  const [outer, ...inner] = path;
  const next = cloneJson(toPlain(item.get(outer))) ?? {};
  assignPath(next, inner, value);
  item.set(outer, next);
}

/**
 * Set (or with `null`, delete) the value a nested path names, creating the
 * objects on the way when they are missing.
 * @param {object} target
 * @param {string[]} path
 * @param {any} value
 */
function assignPath(target, path, value) {
  let node = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (node[key] === null || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  }
  const last = path[path.length - 1];
  if (value === ABSENT) delete node[last];
  else node[last] = cloneJson(value);
}

/** Write one field of a track/scene, or (re)create/delete the whole object. */
function writeListObject(doc, containerKey, id, field, value, label) {
  const list = ensureContainer(doc, containerKey, () => new Y.Array());
  const items = list.toArray();
  const index = items.findIndex((item) => item instanceof Y.Map && item.get("id") === id);

  if (field === "*") {
    if (value === ABSENT) {
      if (index >= 0) list.delete(index, 1);
      return;
    }
    const object = cloneJson(value) ?? {};
    const afterId = typeof object._after === "string" ? object._after : null;
    const beforeId = typeof object._before === "string" ? object._before : null;
    const wanted = Number.isInteger(object._index) ? object._index : null;
    delete object._after;
    delete object._before;
    delete object._index;
    const created = objectMap(object);
    if (index >= 0) list.delete(index, 1);
    list.insert(positionFor(list, afterId, beforeId, wanted), [created]);
    return;
  }

  if (index < 0) throw new Error(`Studio: there is no ${label} "${id}" to write to`);
  writeField(items[index], field, value);
}

/**
 * Where a (re)stored track or scene goes, from what the entry recorded about
 * its old place: the siblings on either side of it and its index.
 *
 * The two siblings bracket the place it held. `_after` — the sibling it
 * followed — is still there means the place is at or behind that one;
 * `_before` — the sibling that followed it — is still there means it is at or
 * before that one. A recorded index goes stale in both directions (a removal
 * in front of it pulls the place left, a restore in front of it pushes it
 * right), so it only chooses the exact spot inside the bracket, clamped to the
 * list. With both neighbours gone, the index alone answers, clamped as before.
 *
 * Keeping the whole bracket is what lets two removals be undone in the order
 * they happened: each one still finds the far end of its old place.
 * @param {Y.Array<any>} list - the list after the object itself was removed
 * @param {string|null} afterId - the sibling to follow, when there was one
 * @param {string|null} beforeId - the sibling to precede, when there was one
 * @param {number|null} wanted - the recorded index, when there was one
 * @returns {number}
 */
function positionFor(list, afterId, beforeId, wanted) {
  const items = list.toArray();
  const indexOf = (id) =>
    id === null ? -1 : items.findIndex((item) => item instanceof Y.Map && item.get("id") === id);

  const afterAt = indexOf(afterId);
  const beforeAt = indexOf(beforeId);
  const lowest = afterAt >= 0 ? afterAt + 1 : 0;
  const highest = beforeAt >= 0 ? beforeAt : items.length;
  const fallback = wanted === null ? highest : Math.max(0, Math.min(wanted, items.length));
  return Math.max(lowest, Math.min(fallback, highest));
}

/** Write one field of a clip, or (re)create/delete the whole clip. */
function writeClip(doc, id, field, value) {
  const clips = clipMap(doc);
  if (field === "*") {
    if (value === ABSENT) {
      clips.delete(id);
      return;
    }
    const object = cloneJson(value) ?? {};
    delete object._index;
    clips.set(id, objectMap({ ...object, id: object.id ?? id }));
    return;
  }
  const clip = clips.get(id);
  if (!(clip instanceof Y.Map)) throw new Error(`Studio: there is no clip "${id}" to write to`);
  writeField(clip, field, value);
}

/** Write one field of a take, or (re)create/delete the whole take. */
function writeTake(doc, id, field, value) {
  const takes = takeMap(doc);
  if (field === "*") {
    if (value === ABSENT) {
      takes.delete(id);
      return;
    }
    const object = cloneJson(value) ?? {};
    delete object._index;
    takes.set(id, objectMap({ ...object, id: object.id ?? id }));
    return;
  }
  const take = takes.get(id);
  if (!(take instanceof Y.Map)) throw new Error(`Studio: there is no take "${id}" to write to`);
  writeField(take, field, value);
}

/** Which song container each id-keyed object kind lives in. */
const OBJECT_MAP_OF = Object.freeze({
  sample: "samples",
  slice: "slices",
  bank: "banks",
  pad: "pads",
  pattern: "patterns",
  step: "steps",
  midi: "midi_maps",
});

/** @returns {Y.Map<any>|null} one live sample, slice, bank, pad, pattern, step or MIDI mapping, or null. */
function containerObject(doc, kind, id) {
  const key = OBJECT_MAP_OF[kind];
  if (!key) return null;
  return liveObject(readContainer(doc, key), id);
}

/**
 * Write one field of a sampler object or a MIDI mapping, or (re)create/delete
 * it whole.
 *
 * A pad and a step carry no `id` of their own: their container key is their
 * identity (`<track>/<bank>/<index>` and `<clip>/<pattern>/<at>/<bank>.<index>`),
 * so nothing here invents one. A sample, slice, bank, pattern and MIDI mapping
 * do carry one, and it is the same value their key holds.
 *
 * A pattern's motion is written as the nested `Y.Map` of one key per lane
 * (`setPatternMotion`), never as a plain object: a whole-pattern restore (an
 * undo of `pattern.remove`, say) puts its lanes back as keys, so the pattern it
 * restores is still two writers' safe.
 */
function writeContainerObject(doc, kind, id, field, value) {
  const key = OBJECT_MAP_OF[kind];
  if (field === "*" && value === ABSENT) {
    const existing = readContainer(doc, key);
    if (existing instanceof Y.Map) existing.delete(id);
    return;
  }
  const map = ensureContainer(doc, key, () => new Y.Map());
  if (field === "*") {
    const object = cloneJson(value) ?? {};
    delete object._index;
    const hasOwnId = kind !== "pad" && kind !== "step";
    const stored = hasOwnId ? { ...object, id: object.id ?? id } : object;
    const created = objectMap(stored);
    if (kind === "pattern") setPatternMotion(created, stored.motion);
    map.set(id, created);
    return;
  }
  const object = map.get(id);
  if (!(object instanceof Y.Map)) throw new Error(`Studio: there is no ${kind} "${id}" to write to`);
  if (kind === "pattern" && field === "motion") {
    setPatternMotion(object, value === ABSENT ? null : value);
    return;
  }
  writeField(object, field, value);
}

/**
 * Replace a pattern's whole motion with a map of one key per lane.
 *
 * This is the one way a motion object goes into the document as a whole (an
 * undo restoring a whole pattern, or a `pattern|motion` field write); every
 * other write touches a single lane key (`writeMotionLane`). The map is always
 * stored, even when it holds no lane: a missing container is what lets two
 * instances create it at once and lose one of the two lanes (see
 * `newPatternMap`).
 * @param {Y.Map<any>} pattern - the live pattern
 * @param {unknown} value - `{lane: points}` as a snapshot spells it, or `null`
 * @returns {void}
 */
function setPatternMotion(pattern, value) {
  const motion = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const lanes = new Y.Map();
  for (const lane of Object.keys(motion)) {
    if (!Array.isArray(motion[lane])) continue;
    lanes.set(lane, cloneJson(motion[lane]));
  }
  // The container is always there, even empty: a pattern without one would let
  // two writers create the key at once, and one of the two lanes would be lost.
  pattern.set("motion", lanes);
}

/** Which sub-map of the arrangement each arrangement object kind lives in. */
const ARRANGEMENT_MAP_OF = Object.freeze({
  placement: "placements",
  marker: "markers",
  section: "sections",
});

/** @returns {Y.Map<any>|null} one live placement, marker or section, or null. */
function arrangementObject(doc, kind, id) {
  const key = ARRANGEMENT_MAP_OF[kind];
  if (!key) return null;
  return liveObject(readArrangementMap(doc, key), id);
}

/** Write one field of a placement, marker or section, or recreate/delete it whole. */
function writeArrangementObject(doc, kind, id, field, value) {
  const key = ARRANGEMENT_MAP_OF[kind];
  const map = ensureArrangementMap(doc, key);
  if (field === "*") {
    if (value === ABSENT) {
      map.delete(id);
      return;
    }
    const object = cloneJson(value) ?? {};
    delete object._index;
    map.set(id, objectMap({ ...object, id: object.id ?? id }));
    return;
  }
  const object = map.get(id);
  if (!(object instanceof Y.Map)) throw new Error(`Studio: there is no ${kind} "${id}" to write to`);
  writeField(object, field, value);
}

/**
 * Write one motion lane of one pattern, or (with `null`) take it away.
 *
 * A lane is one KEY of its pattern's `motion` map (`patternMotionMap`), so this
 * touches that one key and nothing else: another lane, written by this page or
 * by someone else at the same moment, is never overwritten. The pattern itself
 * must be there — motion belongs to a pattern, and removing the pattern removes
 * every lane of it in the same step.
 * @param {Y.Doc} doc
 * @param {string} id - `"<clip_id>/<pattern_id>/<lane>"`
 * @param {string} field - always `"*"`: a lane is one whole field
 * @param {any} value - the lane's points, or `null`
 * @returns {void}
 */
function writeMotionLane(doc, id, field, value) {
  if (field !== "*") {
    throw new Error(`Studio: "motion:${id}|${field}" is not how one motion lane is written; a lane is one whole field`);
  }
  const parts = motionParts(id);
  if (!parts) throw new Error(`Studio: "motion:${id}" does not name a clip, a pattern and a lane`);
  const pattern = getPattern(doc, parts.clipId, parts.patternId);
  if (!pattern) {
    if (value === ABSENT) return;
    throw new Error(`Studio: there is no pattern "${parts.patternId}" on clip "${parts.clipId}" to write motion to`);
  }
  // Taking a lane away that is not there writes nothing at all — not even the
  // empty map an upgrade would make.
  if (value === ABSENT) setMotionLane(pattern, parts.lane, null);
  else setMotionLane(pattern, parts.lane, value);
}

/** @returns {any} the value without its internal `_index`/`_after`/`_before` hints. */
function stripHints(value) {
  const object = toPlain(value) ?? {};
  if (object && typeof object === "object" && ("_index" in object || "_after" in object || "_before" in object)) {
    const { _index, _after, _before, ...rest } = object;
    return rest;
  }
  return object;
}

/** @returns {number} value when it is a finite number, else the fallback. */
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** @returns {number} value when it is a finite integer, else the fallback. */
function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

/** A track as a snapshot carries it: every field present, nothing extra. */
function normalizeTrack(value) {
  const plain = stripHints(value);
  const device = plain.device && typeof plain.device === "object" ? plain.device : {};
  const engine = typeof device.engine === "string" ? device.engine : "sunvox";
  return {
    id: typeof plain.id === "string" ? plain.id : "",
    name: typeof plain.name === "string" ? plain.name : "",
    color: typeof plain.color === "string" ? plain.color : TRACK_COLORS[0],
    // A track that plays no SunVox module carries exactly {engine}: an audio
    // track plays takes, and a sampler track plays the kit that lives in the
    // song's own banks and pads (never inside this device).
    device: engine === AUDIO_DEVICE.engine || engine === SAMPLER_DEVICE.engine
      ? { engine }
      : {
          engine,
          type: typeof device.type === "string" ? device.type : "",
          params: device.params && typeof device.params === "object" ? cloneJson(device.params) : {},
        },
    mute: plain.mute === true,
    solo: plain.solo === true,
    gain_db: numberOr(plain.gain_db, 0),
    pan: numberOr(plain.pan, 0),
    locked: plain.locked === true,
  };
}

/** A scene as a snapshot carries it. */
function normalizeScene(value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : "",
    name: typeof plain.name === "string" ? plain.name : "",
  };
}

/**
 * A clip as a snapshot carries it, with its notes as plain {t, d, p, v}.
 *
 * A SunVox clip carries no `kind` (an absent kind is "notes"); an audio clip
 * adds `kind: "audio"` and its comp, and a pattern clip adds `kind: "pattern"`
 * with its step length, swing and chain, so a reader can tell the three apart
 * without a second lookup. A pattern clip's `length_bars` is derived from its
 * loop (`length_steps × step_beats`) rather than read from the document, so it
 * always measures what the pattern plays.
 */
function normalizeClip(id, value) {
  const plain = stripHints(value);
  const notes = Array.isArray(plain.notes) ? plain.notes : [];
  const clip = {
    id: typeof plain.id === "string" ? plain.id : id,
    track_id: typeof plain.track_id === "string" ? plain.track_id : "",
    scene_id: typeof plain.scene_id === "string" ? plain.scene_id : "",
    name: typeof plain.name === "string" ? plain.name : "",
    length_bars: integerOr(plain.length_bars, 1),
    notes: notes.map((note) => {
      const item = note && typeof note === "object" ? note : {};
      return {
        t: numberOr(item.t, 0),
        d: numberOr(item.d, 0),
        p: integerOr(item.p, 60),
        v: integerOr(item.v, 100),
      };
    }),
  };
  if (plain.kind === "pattern") {
    const lengthSteps = integerOr(plain.length_steps, 16);
    const stepBeats = STEP_BEATS_VALUES.includes(plain.step_beats) ? plain.step_beats : DEFAULT_STEP_BEATS;
    const swing = Math.min(0.75, Math.max(0, numberOr(plain.swing, 0)));
    return {
      ...clip,
      notes: [],
      kind: "pattern",
      length_steps: lengthSteps,
      step_beats: stepBeats,
      swing,
      chain: Array.isArray(plain.chain) ? plain.chain.filter((entry) => typeof entry === "string") : [],
      length_bars: lengthBarsForSteps(lengthSteps, stepBeats),
    };
  }
  if (plain.kind !== "audio") return clip;
  return { ...clip, kind: "audio", comp: normalizeSegments(plain.comp) };
}

/** A comp as a snapshot carries it, with its segments as plain {take_id, from_beat, to_beat}. */
function normalizeSegments(value) {
  const segments = Array.isArray(value) ? value : [];
  return segments.map((segment) => {
    const item = segment && typeof segment === "object" ? segment : {};
    return {
      take_id: typeof item.take_id === "string" ? item.take_id : "",
      from_beat: numberOr(item.from_beat, 0),
      to_beat: numberOr(item.to_beat, 0),
    };
  });
}

/**
 * A sample as a snapshot carries it: every field present, nothing extra. The
 * audio itself is not in the document — `storage_key` says where it lives.
 */
function normalizeSample(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    storage_key: typeof plain.storage_key === "string" ? plain.storage_key : "",
    rate: integerOr(plain.rate, 48000),
    channels: integerOr(plain.channels, 1),
    frames: integerOr(plain.frames, 0),
    name: typeof plain.name === "string" ? plain.name : "",
    origin: SAMPLE_ORIGINS.includes(plain.origin) ? plain.origin : SAMPLE_ORIGINS[0],
    author_label: typeof plain.author_label === "string" ? plain.author_label : "",
  };
}

/** A slice as a snapshot carries it: every field present, nothing extra. */
function normalizeSlice(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id.split("/").pop() ?? id,
    sample_id: typeof plain.sample_id === "string" ? plain.sample_id : "",
    start_frame: integerOr(plain.start_frame, 0),
    end_frame: integerOr(plain.end_frame, 0),
  };
}

/** A bank as a snapshot carries it: every field present, nothing extra. */
function normalizeBank(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id.split("/").pop() ?? id,
    track_id: typeof plain.track_id === "string" ? plain.track_id : "",
    name: typeof plain.name === "string" ? plain.name : "",
    order: integerOr(plain.order, 0),
  };
}

/**
 * A pad as a snapshot carries it: every field present, nothing extra. An empty
 * pad carries `sample_id: null`, which is how "no sound on this pad" is spelled.
 */
function normalizePad(id, value) {
  const plain = stripHints(value);
  const filter = plain.filter && typeof plain.filter === "object" ? plain.filter : {};
  return {
    track_id: typeof plain.track_id === "string" ? plain.track_id : "",
    bank_id: typeof plain.bank_id === "string" ? plain.bank_id : "",
    index: integerOr(plain.index, 0),
    sample_id: typeof plain.sample_id === "string" ? plain.sample_id : ABSENT,
    slice_id: typeof plain.slice_id === "string" ? plain.slice_id : ABSENT,
    name: typeof plain.name === "string" ? plain.name : "",
    mode: PAD_MODES.includes(plain.mode) ? plain.mode : PAD_MODES[0],
    pitch: numberOr(plain.pitch, 0),
    gain_db: numberOr(plain.gain_db, 0),
    pan: numberOr(plain.pan, 0),
    attack_ms: numberOr(plain.attack_ms, 0),
    decay_ms: numberOr(plain.decay_ms, 0),
    sustain: numberOr(plain.sustain, 1),
    release_ms: numberOr(plain.release_ms, 0),
    filter: {
      type: PAD_FILTER_TYPES.includes(filter.type) ? filter.type : PAD_FILTER_TYPES[0],
      cutoff_hz: numberOr(filter.cutoff_hz, 20000),
      resonance: numberOr(filter.resonance, 0),
    },
    choke: integerOr(plain.choke, 0),
    reverse: plain.reverse === true,
  };
}

/** A pattern as a snapshot carries it: every field present, nothing extra. */
function normalizePattern(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id.split("/").pop() ?? id,
    clip_id: typeof plain.clip_id === "string" ? plain.clip_id : "",
    name: typeof plain.name === "string" ? plain.name : "",
    order: integerOr(plain.order, 0),
    motion: normalizeMotion(plain.motion),
  };
}

/**
 * A pattern's motion lanes as a snapshot carries them: lane name → its points,
 * sorted by step position. A point that is not two finite numbers is dropped,
 * so the engine and the checks only ever read a usable curve.
 * @param {unknown} value
 * @returns {Object<string, Array<{step_frac: number, value: number}>>}
 */
function normalizeMotion(value) {
  const motion = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const out = {};
  if (!motion) return out;
  for (const lane of Object.keys(motion)) {
    const raw = motion[lane];
    if (!Array.isArray(raw)) continue;
    const points = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const stepFrac = Number(item.step_frac);
      const amount = Number(item.value);
      if (!Number.isFinite(stepFrac) || !Number.isFinite(amount)) continue;
      points.push({ step_frac: stepFrac, value: amount });
    }
    points.sort(byMotionStep);
    if (points.length > 0) out[lane] = points;
  }
  return out;
}

/** @returns {number} the step order of two motion points. */
function byMotionStep(a, b) {
  return a.step_frac - b.step_frac;
}

/** A step as a snapshot carries it: every field present, nothing extra. */
function normalizeStep(id, value) {
  const plain = stripHints(value);
  return {
    clip_id: typeof plain.clip_id === "string" ? plain.clip_id : "",
    pattern_id: typeof plain.pattern_id === "string" ? plain.pattern_id : "",
    at: integerOr(plain.at, 0),
    bank_id: typeof plain.bank_id === "string" ? plain.bank_id : "",
    index: integerOr(plain.index, 0),
    v: integerOr(plain.v, 100),
    locks: plain.locks && typeof plain.locks === "object" ? cloneJson(plain.locks) : {},
  };
}

/**
 * A MIDI mapping as a snapshot carries it: every field present, nothing extra.
 *
 * `accepted_action` is `null` until the operator accepts the mapping, and
 * `proposed` is what says whether it is waiting: only a mapping with
 * `proposed: false` whose `action` still equals its `accepted_action` is live.
 */
function normalizeMidiMapping(id, value) {
  const plain = stripHints(value);
  const message = plain.message && typeof plain.message === "object" ? plain.message : {};
  const action = plain.action && typeof plain.action === "object" ? plain.action : {};
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    device_name: typeof plain.device_name === "string" ? plain.device_name : "",
    message: {
      type: MIDI_MESSAGE_TYPES.includes(message.type) ? message.type : MIDI_MESSAGE_TYPES[0],
      channel: integerOr(message.channel, 1),
      number: integerOr(message.number, 0),
    },
    action: {
      ...cloneJson(action),
      kind: typeof action.kind === "string" ? action.kind : "",
    },
    set_by: MIDI_SET_BY.includes(plain.set_by) ? plain.set_by : MIDI_SET_BY[0],
    proposed: plain.proposed === true,
    accepted_action:
      plain.accepted_action && typeof plain.accepted_action === "object"
        ? cloneJson(plain.accepted_action)
        : ABSENT,
  };
}

/** A take as a snapshot carries it: every field present, nothing extra. */
function normalizeTake(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    clip_id: typeof plain.clip_id === "string" ? plain.clip_id : "",
    storage_key: typeof plain.storage_key === "string" ? plain.storage_key : "",
    rate: integerOr(plain.rate, 48000),
    channels: integerOr(plain.channels, 1),
    frames: integerOr(plain.frames, 0),
    offset_frames: integerOr(plain.offset_frames, 0),
    compensated: plain.compensated === true,
    bpm: numberOr(plain.bpm, 120),
    recorded_at: typeof plain.recorded_at === "string" ? plain.recorded_at : "",
    author_label: typeof plain.author_label === "string" ? plain.author_label : "",
    discarded: plain.discarded === true,
  };
}

/** A placement as a snapshot carries it: every field present, nothing extra. */
function normalizePlacement(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    track_id: typeof plain.track_id === "string" ? plain.track_id : "",
    clip_id: typeof plain.clip_id === "string" ? plain.clip_id : "",
    start_bar: integerOr(plain.start_bar, 0),
    bars: integerOr(plain.bars, 1),
    offset_beats: numberOr(plain.offset_beats, 0),
    fade_in_beats: numberOr(plain.fade_in_beats, 0),
    fade_out_beats: numberOr(plain.fade_out_beats, 0),
  };
}

/** A marker as a snapshot carries it: every field present, nothing extra. */
function normalizeMarker(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    bar: integerOr(plain.bar, 0),
    name: typeof plain.name === "string" ? plain.name : "",
  };
}

/** A section as a snapshot carries it: every field present, nothing extra. */
function normalizeSection(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    start_bar: integerOr(plain.start_bar, 0),
    end_bar: integerOr(plain.end_bar, 0),
    name: typeof plain.name === "string" ? plain.name : "",
  };
}
/**
 * The document's full Yjs state as bytes (for persistence and byte-level comparisons).
 * @param {Y.Doc} doc
 * @returns {Uint8Array}
 */
export function encodeDocState(doc) {
  return Y.encodeStateAsUpdate(doc);
}
