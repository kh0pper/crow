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
 *
 * A take is one recording on disk that an audio clip comps from. A segment is
 * `{take_id, from_beat, to_beat}` and says which take plays over which beats
 * of its clip. A song written before takes existed has no `takes` container:
 * every reader treats that as an empty map (see `readContainer`).
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
 * cap and the per-clip take cap of 1b. Commands refuse past these with a
 * plain-English message naming the limit.
 * @type {{tracks: number, notesPerClip: number, scenes: number, clipBars: number,
 *         params: number, takesPerClip: number}}
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
});

/**
 * The device of an audio track: the one track kind that plays recorded takes
 * instead of SunVox notes. It carries no module and no controllers.
 * @type {Readonly<{engine: "audio"}>}
 */
export const AUDIO_DEVICE = Object.freeze({ engine: "audio" });

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
 * @param {"song"|"track"|"scene"|"clip"|"take"} kind
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

/**
 * The whole song as plain JSON — the shape clients, the sequencer and a render
 * read, and the value two hubs compare after a restart.
 * @param {Y.Doc} doc
 * @returns {{meta: {title: string, bpm: number, meter: number[], key: string},
 *            tracks: object[], scenes: object[], clips: Object<string, object>,
 *            takes: Object<string, object>}}
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
 *     `clip.set_comp` enforces on its own edits.
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

  return reasons;
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
    // An audio track has no module and no controllers: its device is exactly
    // {engine: "audio"}, never an empty set of SunVox fields.
    device: engine === AUDIO_DEVICE.engine
      ? { engine: AUDIO_DEVICE.engine }
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
 * adds `kind: "audio"` and its comp, so a reader can tell the two apart
 * without a second lookup.
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
/**
 * The document's full Yjs state as bytes (for persistence and byte-level comparisons).
 * @param {Y.Doc} doc
 * @returns {Uint8Array}
 */
export function encodeDocState(doc) {
  return Y.encodeStateAsUpdate(doc);
}
