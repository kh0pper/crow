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
 *                     "motion|<bank>.<index>|<param>": [{step_frac, value}]}
 *   steps     Y.Map of "<clip_id>/<pattern_id>/<at>/<bank_id>.<index>" → Y.Map
 *                     {clip_id, pattern_id, at, bank_id, index, v, locks}
 *
 * A pattern's motion is one KEY per lane directly on the pattern's own map,
 * `"motion|<bank_id>.<index>|<param>"` → `[{step_frac, value}]` sorted by
 * `step_frac`, with `step_frac` a fractional step position inside the clip's
 * loop and `param` one of the pad's numeric lock fields (see `MOTION_PARAMS`).
 * One lane per key is what lets two writers move two lanes of one pattern at
 * once without either overwriting the other, and it is what keeps a lane's undo
 * from rolling back its neighbour; the snapshot still carries the lanes as one
 * plain object (`{lane: [points]}`), which `motionOf` collects read-only.
 * Nothing has to exist before the first lane write — a pattern made before
 * motion existed takes two peers' first lanes as two keys of the map it already
 * has — and motion rides ON the pattern object, so removing a pattern takes its
 * motion with it in the same step.
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
 * A song's `library` (plan 1d) lists the instruments it can play: one entry per
 * SoundFont bank, amp capture or cabinet IR, keyed by a stable id.
 *
 *   library  Y.Map of entry id → Y.Map {id, kind: "font"|"nam"|"ir", name,
 *                     source: "catalog"|"upload"|"bundled", catalog_id?,
 *                     storage_key?, upload_id?, sha256, bytes, licence,
 *                     credit, author_label}
 *
 * A soundfont track's device names one entry of the library and the preset it
 * plays — `{engine: "soundfont", font_id, bank, program}`, with bank 128 the GM
 * drum bank — so a track's instrument is a library entry plus a preset, never a
 * file of its own. The library file itself is not in the document either:
 * `storage_key` (or the entry's sha256, for a catalog file stored once per
 * instance) says where it lives.
 *
 * A song's mixer (plan 1d) is three containers and a single map, so one effect,
 * one send and one return are each one small object to edit, and two writers
 * touching two of them never overwrite each other:
 *
 *   inserts  Y.Map of insert id → Y.Map {id, owner, order, kind, bypass,
 *                     params: Y.Map (one field per parameter)}
 *   sends    Y.Map of "<track_id>/<return_id>" → Y.Map {track_id, return_id,
 *                     level_db, pre}
 *   returns  Y.Map of return id → Y.Map {id, name, gain_db, pan, mute}
 *   master   Y.Map {gain_db, target {lufs, true_peak_db}} — one per song
 *
 * An insert's `owner` is the ref of the chain it sits in — `"track:<id>"`,
 * `"return:<id>"` or `"master"` — and its `order` is a fractional place in that
 * chain, so putting an effect between two others rewrites one field and moves
 * nothing else (see `byInsertOrder`). Its `params` is a Y.Map of its own, one
 * field per parameter, so two peers editing two parameters of one insert both
 * win and one parameter is one undoable field. The parameters and their ranges
 * are the `EFFECT_PARAMS` table below, which the engine and the panel read too.
 *
 * Returns are NOT tracks: they live in `returns`, no track reader sees them,
 * and `LIMITS.tracks` never counts them. A send is keyed by the pair it joins,
 * so a track has at most one send to one return, and each send is its own
 * object.
 *
 * A song written before the mixer existed has none of the four containers: it
 * reads as empty chains, no sends, no returns and the default master (see
 * `snapshot`), and the first write makes the container it needs. A new song
 * makes all four up front, so two peers' first mixer edits merge into one
 * container instead of racing to create it.
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
 *         midiMaps: number, fontsPerSong: number,
 *         libraryEntriesPerSong: number, insertsPerChain: number,
 *         returnsPerSong: number, sendsPerTrack: number,
 *         ampInsertsPerSong: number}}
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
  // lane of hand-drawn points that stays a curve, not a sample stream. The lane
  // cap is what ONE writer may put on a pattern (motion.write); two peers' own
  // lanes merge into one pattern and the merge is not a fault (see
  // `samplerReasons`).
  motionPointsPerLane: 4096,
  motionLanesPerPattern: 32,
  // The MIDI mapping table of one song (plan 1c, Limits): every message the
  // operator's controllers drive, proposed or live.
  midiMaps: 256,
  // The instrument library (plan 1d, Limits): the hardest cap is the fonts a
  // song may hold, because each parsed font costs memory in the page.
  fontsPerSong: 32,
  libraryEntriesPerSong: 256,
  // The mixer (plan 1d, Limits): the effects of one chain, the returns of one
  // song and the sends of one track. `ampInsertsPerSong` is the one cap the
  // document does not enforce yet: an amp insert arrives with PR C, and until
  // then `insert.add` refuses the kind, so nothing can reach it.
  insertsPerChain: 8,
  returnsPerSong: 8,
  sendsPerTrack: 8,
  ampInsertsPerSong: 16,
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

/**
 * The device of a soundfont track: the one track kind that plays an instrument
 * out of the song's `library` instead of a SunVox module or a kit of pads.
 *
 * The device carries the instrument and the preset — `font_id` names a library
 * entry of kind "font", `bank` and `program` choose the preset inside it —
 * because a font plays one program at a time. Bank `GM_DRUM_BANK` means the GM
 * drum kits, which the engine sets with `setDrums` rather than by reserving a
 * channel.
 * @type {Readonly<{engine: "soundfont"}>}
 */
export const SOUNDFONT_DEVICE = Object.freeze({ engine: "soundfont" });

/** The bank a soundfont track's drum kits live in (the GM drum bank). */
export const GM_DRUM_BANK = 128;

/** The highest bank a soundfont track may name: 0-127 melodic, 128 the drums. */
export const MAX_SOUNDFONT_BANK = GM_DRUM_BANK;

/** The highest program a soundfont track may name, in either kind of bank. */
export const MAX_SOUNDFONT_PROGRAM = 127;

/** What a library entry holds: a SoundFont bank, an amp capture, or a cabinet IR. */
export const LIBRARY_KINDS = Object.freeze(["font", "nam", "ir"]);

/** Where a library entry came from: the catalog, an upload, or the bundle. */
export const LIBRARY_SOURCES = Object.freeze(["catalog", "upload", "bundled"]);

/**
 * Freeze a value and everything inside it, so a table a reader shares cannot be
 * edited by one of them. Plain objects and arrays only.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/**
 * Every effect a chain may hold (plan 1d, Task 6), with each one's parameters
 * and the range each parameter runs over. The engine (Tasks 7 to 9) and the
 * panel's insert editor (Task 10) read this one table, so a parameter's range
 * exists in exactly one place.
 *
 * A numeric parameter is `{min, max, default, unit}`; a chooser is
 * `{values, default}` and holds one of `values`. `unit` is the suffix a control
 * shows ("Hz", "dB", "ms"), and "" for a plain number. `label` is the word a
 * summary and a control use: "Added a compressor to Bass", "the reverb's mix".
 *
 * The table's key order is `EFFECT_KINDS`'s order, which is the order a menu
 * lists the effects in. `amp` is deliberately absent: an amp insert arrives
 * with plan 1d's PR C, and `insert.add` refuses that kind with its own sentence
 * until then.
 * @type {Readonly<Object<string, Readonly<{label: string, params: Readonly<Object<string, any>>}>>>}
 */
export const EFFECT_PARAMS = deepFreeze({
  eq: {
    label: "equalizer",
    params: {
      low_freq_hz: { min: 20, max: 500, default: 100, unit: "Hz" },
      low_gain_db: { min: -18, max: 18, default: 0, unit: "dB" },
      mid_freq_hz: { min: 100, max: 10000, default: 1000, unit: "Hz" },
      mid_gain_db: { min: -18, max: 18, default: 0, unit: "dB" },
      mid_q: { min: 0.1, max: 10, default: 0.7, unit: "" },
      high_freq_hz: { min: 2000, max: 20000, default: 8000, unit: "Hz" },
      high_gain_db: { min: -18, max: 18, default: 0, unit: "dB" },
    },
  },
  filter: {
    label: "filter",
    params: {
      mode: { values: ["lp", "hp", "bp"], default: "lp" },
      cutoff_hz: { min: 20, max: 20000, default: 1000, unit: "Hz" },
      resonance: { min: 0.1, max: 10, default: 0.7, unit: "" },
    },
  },
  delay: {
    label: "delay",
    params: {
      time_ms: { min: 1, max: 2000, default: 375, unit: "ms" },
      feedback: { min: 0, max: 0.95, default: 0.35, unit: "" },
      mix: { min: 0, max: 1, default: 0.3, unit: "" },
      highcut_hz: { min: 1000, max: 20000, default: 8000, unit: "Hz" },
    },
  },
  reverb: {
    label: "reverb",
    params: {
      size: { min: 0, max: 1, default: 0.5, unit: "" },
      damping: { min: 0, max: 1, default: 0.5, unit: "" },
      predelay_ms: { min: 0, max: 200, default: 20, unit: "ms" },
      mix: { min: 0, max: 1, default: 0.25, unit: "" },
    },
  },
  chorus: {
    label: "chorus",
    params: {
      rate_hz: { min: 0.05, max: 5, default: 0.8, unit: "Hz" },
      depth: { min: 0, max: 1, default: 0.5, unit: "" },
      mix: { min: 0, max: 1, default: 0.5, unit: "" },
    },
  },
  phaser: {
    label: "phaser",
    params: {
      rate_hz: { min: 0.05, max: 5, default: 0.5, unit: "Hz" },
      depth: { min: 0, max: 1, default: 0.6, unit: "" },
      feedback: { min: 0, max: 0.9, default: 0.4, unit: "" },
      mix: { min: 0, max: 1, default: 0.5, unit: "" },
    },
  },
  saturation: {
    label: "saturation",
    params: {
      drive_db: { min: 0, max: 36, default: 6, unit: "dB" },
      tone: { min: 0, max: 1, default: 0.5, unit: "" },
      output_db: { min: -24, max: 6, default: 0, unit: "dB" },
      mix: { min: 0, max: 1, default: 1, unit: "" },
    },
  },
  compressor: {
    label: "compressor",
    params: {
      detect: { values: ["peak", "rms"], default: "peak" },
      threshold_db: { min: -60, max: 0, default: -18, unit: "dB" },
      ratio: { min: 1, max: 20, default: 4, unit: "" },
      knee_db: { min: 0, max: 12, default: 6, unit: "dB" },
      attack_ms: { min: 0.1, max: 100, default: 10, unit: "ms" },
      release_ms: { min: 5, max: 2000, default: 100, unit: "ms" },
      makeup_db: { min: 0, max: 24, default: 0, unit: "dB" },
      sidechain_hp_hz: { min: 0, max: 500, default: 0, unit: "Hz" },
    },
  },
  limiter: {
    label: "limiter",
    params: {
      ceiling_db: { min: -6, max: -0.1, default: -1, unit: "dB" },
      release_ms: { min: 1, max: 1000, default: 50, unit: "ms" },
    },
  },
  gate: {
    label: "gate",
    params: {
      threshold_db: { min: -80, max: 0, default: -40, unit: "dB" },
      hysteresis_db: { min: 0, max: 12, default: 3, unit: "dB" },
      attack_ms: { min: 0.01, max: 50, default: 1, unit: "ms" },
      hold_ms: { min: 0, max: 500, default: 20, unit: "ms" },
      release_ms: { min: 5, max: 2000, default: 100, unit: "ms" },
      range_db: { min: -80, max: 0, default: -80, unit: "dB" },
    },
  },
  deesser: {
    label: "de-esser",
    params: {
      freq_hz: { min: 4000, max: 10000, default: 6500, unit: "Hz" },
      threshold_db: { min: -60, max: 0, default: -24, unit: "dB" },
      ratio: { min: 1, max: 20, default: 4, unit: "" },
    },
  },
});

/** The effects a chain may hold, in the order a menu lists them (see `EFFECT_PARAMS`). */
export const EFFECT_KINDS = Object.freeze(Object.keys(EFFECT_PARAMS));

/**
 * One effect kind's entry in `EFFECT_PARAMS`, or null. An OWN-property lookup:
 * a kind or parameter name comes from a peer or an agent, and "constructor" or
 * "__proto__" must not resolve to something Object.prototype carries.
 * @param {string} kind
 * @returns {{label: string, params: Object}|null}
 */
export function effectSpec(kind) {
  return typeof kind === "string" && Object.hasOwn(EFFECT_PARAMS, kind) ? EFFECT_PARAMS[kind] : null;
}

/**
 * One parameter's range in one effect kind, or null (own properties only, as
 * `effectSpec`).
 * @param {string} kind
 * @param {string} name
 * @returns {Object|null}
 */
export function effectParamSpec(kind, name) {
  const spec = effectSpec(kind);
  return spec && typeof name === "string" && Object.hasOwn(spec.params, name) ? spec.params[name] : null;
}

/**
 * The ranges the mixer's own levels run over (plan 1d, Task 6): the master's
 * gain in dB and its loudness target in LUFS with its true-peak ceiling in
 * dBTP, a return's level and pan, and the level of one send.
 * @type {Readonly<{master: {gain_db: number[], lufs: number[], true_peak_db: number[]},
 *                  return: {gain_db: number[], pan: number[]},
 *                  send: {level_db: number[]}}>}
 */
export const MIXER_RANGES = deepFreeze({
  master: { gain_db: [-24, 12], lufs: [-30, -6], true_peak_db: [-6, -0.1] },
  return: { gain_db: [-60, 12], pan: [-1, 1] },
  send: { level_db: [-60, 6] },
});

/**
 * The master a song starts with, and what every reader sees when a song has no
 * master yet: no gain change, and the -14 LUFS streaming reference with a
 * -1 dBTP ceiling.
 * @type {Readonly<{gain_db: number, target: Readonly<{lufs: number, true_peak_db: number}>}>}
 */
export const DEFAULT_MASTER = deepFreeze({ gain_db: 0, target: { lufs: -14, true_peak_db: -1 } });

/** The longest name a return may carry, in characters. */
export const MAX_RETURN_NAME = 64;

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
 * Prefix of a field path that reaches one field of a track's device, e.g.
 * `"device.font_id"` on a soundfont track, or the `"device.type"` guard a
 * controller edit carries.
 */
const DEVICE_FIELD_PREFIX = "device.";

/**
 * Prefix of a field path that reaches one lock inside a step's `locks`, e.g.
 * `"locks.cutoff_hz"`. The lock name is everything after the prefix, taken
 * verbatim, so each lock is its own field and stays undoable on its own.
 */
const LOCK_FIELD_PREFIX = "locks.";

/**
 * Prefix of a field path that reaches one parameter inside an insert's `params`,
 * e.g. `"params.mix"`. The parameter name is everything after the prefix, taken
 * verbatim: `params` is a Y.Map of its own, so one parameter is one key of it and
 * two peers editing two parameters of one insert both win.
 */
const PARAMS_FIELD_PREFIX = "params.";

/**
 * Prefix of one motion lane's own key on its pattern's map, e.g.
 * `"motion|<bank_id>.<index>|<param>"`. The lane name is everything after the
 * prefix, taken verbatim: a lane is one key of the pattern it belongs to, so
 * two writers never touch the same field (see `setMotionLane`).
 */
const MOTION_FIELD_PREFIX = "motion|";

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
 * The ref of a song's one master: the only object a ref names without an id.
 * @type {string}
 */
export const MASTER_REF = "master";

/**
 * The ref a command, a lock or a history entry names one object by.
 * @param {"song"|"track"|"scene"|"clip"|"take"|"placement"|"marker"|"section"|"motion"|"library"|"insert"|"send"|"return"} kind
 * @param {string} id
 * @returns {string} e.g. `"clip:abc"`, `"take:abc"`, or `"song:meta"` for the song itself
 */
export function objectRef(kind, id) {
  return `${kind}:${id}`;
}

/**
 * Split an object reference back into its kind and id.
 *
 * A song's master is the one object with no id of its own, so the bare ref
 * `"master"` is the one ref without a colon; every other ref is
 * `"<kind>:<id>"`.
 * @param {string} ref
 * @returns {{kind: string, id: string}|null} null when `ref` is not a ref
 */
export function parseObjectRef(ref) {
  const text = String(ref ?? "");
  if (text === MASTER_REF) return { kind: "master", id: "master" };
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
 * Build the Y.Map a command inserts for a new pattern: its own fields, and
 * nothing else.
 *
 * A lane needs no container of its own: every lane is its own key of this very
 * map (`setMotionLane`), so two instances that write two lanes of the pattern at
 * the same moment write two different keys and neither is lost, whether the
 * pattern was made a moment ago or before motion existed.
 * @param {object} pattern the pattern's own fields (`id`, `clip_id`, `name`, `order`)
 * @returns {Y.Map<any>}
 */
export function newPatternMap(pattern) {
  return objectMap(pattern);
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
 * `clip.write` fill it in. Its mixer containers and its master exist from the
 * start, empty, so two peers' first effects, sends or returns merge into the
 * container they both already have (a song written before the mixer existed
 * gets each container when it is first written to; see the header).
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
    song.set("inserts", new Y.Map());
    song.set("sends", new Y.Map());
    song.set("returns", new Y.Map());
    song.set("master", new Y.Map());
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

// --- The instrument library --------------------------------------------------

/**
 * The library map, keyed by entry id. Writers use this; a song written before
 * the library existed gets the container the first time it is written to.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function libraryMap(doc) {
  return ensureContainer(doc, "library", () => new Y.Map());
}

/**
 * Every library entry in the song, in the order the map holds them. A song
 * without a library has none.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, entry: Y.Map<any>}>}
 */
export function libraryEntries(doc) {
  return objectEntries(readContainer(doc, "library"), "entry");
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live library entry, or null
 */
export function getLibraryEntry(doc, id) {
  return liveObject(readContainer(doc, "library"), id);
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live library entry, when it is a font
 */
export function getLibraryFont(doc, id) {
  const entry = getLibraryEntry(doc, id);
  return entry && entry.get("kind") === LIBRARY_KINDS[0] ? entry : null;
}

// --- The mixer's containers --------------------------------------------------

/**
 * The inserts map, keyed by insert id. Writers use this; a song written before
 * the mixer existed gets the container the first time an effect is added.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function insertMap(doc) {
  return ensureContainer(doc, "inserts", () => new Y.Map());
}

/**
 * Every insert in the song, in the order the map holds them.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, insert: Y.Map<any>}>}
 */
export function insertEntries(doc) {
  return objectEntries(readContainer(doc, "inserts"), "insert");
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live insert, or null
 */
export function getInsert(doc, id) {
  return liveObject(readContainer(doc, "inserts"), id);
}

/**
 * An insert's live params map — one key per parameter, created from what the
 * insert holds when it has none (an insert restored by an older peer, say).
 * Commands write one parameter by setting one key of it.
 * @param {Y.Map<any>} insert - the live insert
 * @returns {Y.Map<any>}
 */
export function insertParamsMap(insert) {
  return paramsMapOf(insert);
}

/**
 * The chain one owner's inserts make, in the order the engine runs them:
 * ascending `order`, with the id breaking a tie (two midpoints can land on the
 * same double after many moves). Read-only: it changes nothing.
 * @param {Y.Doc} doc
 * @param {string} owner - `"track:<id>"`, `"return:<id>"` or `"master"`
 * @returns {Array<{id: string, insert: Y.Map<any>}>}
 */
export function insertsForOwner(doc, owner) {
  return insertEntries(doc)
    .filter(({ insert }) => insert.get("owner") === owner)
    .sort((a, b) => byInsertOrder(a.insert, b.insert));
}

/**
 * The order two inserts of one chain stand in: by `order`, then by id.
 *
 * `order` is fractional, so an effect placed between two others takes the
 * midpoint of their orders and nothing else in the chain moves. A tie can only
 * come from two midpoints landing on the same double, and the id keeps the
 * chain stable when it does.
 * @param {Y.Map<any>|object} a
 * @param {Y.Map<any>|object} b
 * @returns {number}
 */
export function byInsertOrder(a, b) {
  const orderA = readNumber(a, "order");
  const orderB = readNumber(b, "order");
  if (orderA !== orderB) return orderA - orderB;
  const idA = readString(a, "id");
  const idB = readString(b, "id");
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * The owner an insert's `owner` field names, when it names one: a track's
 * chain, a return's chain, or the master's.
 *
 * The master is exactly the bare ref `MASTER_REF`: it is the one object with no
 * id of its own, so `"master:anything"` names nothing at all (a command refuses
 * it and `checkInvariants` reports it) rather than quietly becoming the song's
 * master.
 * @param {unknown} owner - e.g. `"track:bass"`, `"return:a"` or `"master"`
 * @returns {{kind: "track"|"return"|"master", id: string}|null}
 */
export function insertOwnerOf(owner) {
  if (owner === MASTER_REF) return { kind: "master", id: "master" };
  const target = parseObjectRef(owner);
  if (!target) return null;
  if (target.kind !== "track" && target.kind !== "return") return null;
  return { kind: target.kind, id: target.id };
}

/**
 * The key one send lives under in the song's `sends` map: the track and the
 * return it joins. Two tracks' ids and two returns' ids never contain the
 * separator, so one pair is one key.
 * @param {string} trackId
 * @param {string} returnId
 * @returns {string}
 */
export function sendKey(trackId, returnId) {
  return `${trackId}/${returnId}`;
}

/**
 * Split a send's key back into the track and the return it joins.
 * @param {string} key - `"<track_id>/<return_id>"`
 * @returns {{trackId: string, returnId: string}|null}
 */
export function sendParts(key) {
  const text = String(key ?? "");
  const at = text.indexOf("/");
  if (at <= 0 || at === text.length - 1) return null;
  return { trackId: text.slice(0, at), returnId: text.slice(at + 1) };
}

/**
 * The sends map, keyed by `"<track_id>/<return_id>"`. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function sendMap(doc) {
  return ensureContainer(doc, "sends", () => new Y.Map());
}

/**
 * Every send in the song, in the order the map holds them.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, send: Y.Map<any>}>}
 */
export function sendEntries(doc) {
  return objectEntries(readContainer(doc, "sends"), "send");
}

/**
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @param {string} returnId
 * @returns {Y.Map<any>|null} the live send between that track and that return, or null
 */
export function getSend(doc, trackId, returnId) {
  return liveObject(readContainer(doc, "sends"), sendKey(trackId, returnId));
}

/**
 * Every send one track feeds.
 * @param {Y.Doc} doc
 * @param {string} trackId
 * @returns {Array<{id: string, send: Y.Map<any>}>}
 */
export function sendsForTrack(doc, trackId) {
  return sendEntries(doc).filter(({ send }) => send.get("track_id") === trackId);
}

/**
 * Every send that feeds one return.
 * @param {Y.Doc} doc
 * @param {string} returnId
 * @returns {Array<{id: string, send: Y.Map<any>}>}
 */
export function sendsForReturn(doc, returnId) {
  return sendEntries(doc).filter(({ send }) => send.get("return_id") === returnId);
}

/**
 * The returns map, keyed by return id. Writers use this. A return is a mixer
 * channel of its own, never a track.
 * @param {Y.Doc} doc
 * @returns {Y.Map<Y.Map<any>>}
 */
export function returnMap(doc) {
  return ensureContainer(doc, "returns", () => new Y.Map());
}

/**
 * Every return in the song, in the order the map holds them.
 * @param {Y.Doc} doc
 * @returns {Array<{id: string, return: Y.Map<any>}>}
 */
export function returnEntries(doc) {
  return objectEntries(readContainer(doc, "returns"), "return");
}

/**
 * @param {Y.Doc} doc
 * @param {string} id
 * @returns {Y.Map<any>|null} the live return, or null
 */
export function getReturn(doc, id) {
  return liveObject(readContainer(doc, "returns"), id);
}

/**
 * The song's one master map, created when the song has none. Writers use this.
 * @param {Y.Doc} doc
 * @returns {Y.Map<any>}
 */
export function masterMap(doc) {
  return ensureContainer(doc, "master", () => new Y.Map());
}

/**
 * The master as plain JSON with every default filled in. A song written before
 * the mixer existed reads as `DEFAULT_MASTER` here without anything being
 * written to its document.
 * @param {Y.Doc} doc
 * @returns {{gain_db: number, target: {lufs: number, true_peak_db: number}}}
 */
export function masterSettings(doc) {
  const master = readContainer(doc, "master");
  return normalizeMaster(master instanceof Y.Map ? master : null);
}

/**
 * The parameters one effect starts with: every parameter of the kind at its
 * default, as a fresh plain object a command can store.
 * @param {string} kind - one of `EFFECT_KINDS`
 * @returns {Object<string, number|string>} empty when the kind is not in the table
 */
export function defaultEffectParams(kind) {
  const spec = effectSpec(kind);
  if (!spec) return {};
  const params = {};
  for (const [name, field] of Object.entries(spec.params)) params[name] = field.default;
  return params;
}

/**
 * The word one effect kind goes by in a sentence: "compressor", "de-esser", or
 * the kind itself when the table does not know it.
 * @param {string} kind
 * @returns {string}
 */
export function effectLabel(kind) {
  return effectSpec(kind)?.label ?? String(kind ?? "");
}

/** @returns {any} one field of a live Y.Map or of a plain object. */
function readValue(object, key) {
  return object instanceof Y.Map ? object.get(key) : object?.[key];
}

/** @returns {number} one field as a finite number, else 0. */
function readNumber(object, key) {
  const value = readValue(object, key);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** @returns {string} one field as a string, else "". */
function readString(object, key) {
  const value = readValue(object, key);
  return typeof value === "string" ? value : "";
}

/**
 * The tracks that play one library entry — the question "is this entry in use?"
 * is asked on its effect: a font is in use exactly while a soundfont track's
 * `font_id` names it.
 *
 * Inserts arrive in PR B and C of plan 1d: an amp insert's `model_id` and
 * `ir_id` name a capture and a cabinet the same way, and they join this list
 * here rather than at each caller.
 * @param {object|Y.Doc} source - a snapshot, or a document (one is taken)
 * @param {string} id - the library entry's id
 * @returns {string[]} the track ids, sorted, each once
 */
export function libraryUsers(source, id) {
  if (typeof id !== "string" || id === "") return [];
  const song = songPlain(source);
  const ids = new Set();
  for (const track of song.tracks ?? []) {
    if (track?.device?.engine !== SOUNDFONT_DEVICE.engine) continue;
    if (track.device.font_id !== id) continue;
    if (typeof track.id === "string" && track.id !== "") ids.add(track.id);
  }
  return [...ids].sort();
}

/**
 * Whether anything in the song uses one library entry: a track's font_id now,
 * and an amp insert's model_id or ir_id once the mixer exists (see
 * `libraryUsers`). This is the check `library.remove` and the agent sound guard
 * are built on.
 * @param {object|Y.Doc} source - a snapshot, or a document
 * @param {string} id
 * @returns {boolean}
 */
export function libraryUses(source, id) {
  return libraryUsers(source, id).length > 0;
}

/**
 * A snapshot of whatever a reader handed in: a plain song as it is, a document
 * taken through `snapshot()`.
 * @param {object|Y.Doc|string} source - a snapshot, or a document
 * @returns {object}
 */
function songPlain(source) {
  if (source && typeof source === "object" && Array.isArray(source.tracks)) return source;
  if (source && typeof source.getMap === "function") return snapshot(source);
  return { tracks: [], library: {} };
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
 * and the pattern name it, then the lane itself. (A lane is its own
 * `motion|<lane>` key on the pattern; this key is what makes one lane one
 * history field.)
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
 *
 * Read-only, so a snapshot of a pattern nobody has swept writes nothing to the
 * document: the lanes are the pattern's own `"motion|<lane>"` keys, collected
 * here into the one object a snapshot, a history entry and the engine read.
 * @param {Y.Map<any>|Object<string, any>|null|undefined} pattern
 * @returns {Object<string, Array<{step_frac: number, value: number}>>} empty when
 *   the pattern has no motion
 */
export function motionOf(pattern) {
  const motion = {};
  if (!pattern || typeof pattern !== "object") return motion;
  const entries = typeof pattern.entries === "function" ? pattern.entries() : Object.entries(pattern);
  for (const [key, value] of entries) {
    if (typeof key !== "string" || !key.startsWith(MOTION_FIELD_PREFIX)) continue;
    if (!Array.isArray(value)) continue;
    motion[key.slice(MOTION_FIELD_PREFIX.length)] = toPlain(value);
  }
  return motion;
}

/**
 * Write one lane of a pattern's motion, or (with `null`) take it away: one key
 * of the pattern's own map, and nothing else in the song is touched.
 *
 * The key is created by the very write that needs it, so a pattern made before
 * motion existed needs no upgrade: a lane written on one instance and a lane
 * written on another at the same moment are two keys of one map, never two
 * maps competing for one key.
 * @param {Y.Map<any>} pattern - the live pattern
 * @param {string} lane - `<bank_id>.<index>|<param>`
 * @param {Array<{step_frac: number, value: number}>|null|undefined} points
 * @returns {boolean} whether the document changed
 */
export function setMotionLane(pattern, lane, points) {
  const key = MOTION_FIELD_PREFIX + String(lane);
  const removing = points === null || points === undefined;
  if (removing) {
    if (pattern.get(key) === undefined) return false;
    pattern.delete(key);
    return true;
  }
  pattern.set(key, cloneJson(points));
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
 * Whether a track plays an instrument out of the song's library rather than a
 * SunVox module or a kit of pads.
 * @param {Y.Map<any>|null|undefined} track
 * @returns {boolean}
 */
export function isSoundfontTrack(track) {
  return deviceEngine(track) === SOUNDFONT_DEVICE.engine;
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
 *            library: Object<string, object>,
 *            inserts: Object<string, object>, sends: Object<string, object>,
 *            returns: Object<string, object>,
 *            master: {gain_db: number, target: {lufs: number, true_peak_db: number}},
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
 *   `library` is the song's instrument library, a plain object keyed by the
 *   entry's own id; a song written before the library existed reads it as an
 *   empty object, so every reader sees the same shape either way.
 *   `inserts` is keyed by insert id, `sends` by "<track_id>/<return_id>" and
 *   `returns` by return id, and an insert's nested `params` arrives as one plain
 *   object of parameter name → value. `master` is always there — a song with no
 *   master reads the defaults — so the engine, the panel and a render all see
 *   the same shape.
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
    library: snapshotContainer(doc, "library", normalizeLibraryEntry),
    inserts: snapshotContainer(doc, "inserts", normalizeInsert),
    sends: snapshotContainer(doc, "sends", normalizeSend),
    returns: snapshotContainer(doc, "returns", normalizeReturn),
    master: masterSettings(doc),
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
 *   - the song's library stays inside its caps (`LIMITS.libraryEntriesPerSong`
 *     entries, `LIMITS.fontsPerSong` fonts), every entry says what kind of file
 *     it is, and every soundfont track's `font_id` names a font of that library
 *     with a bank and a program inside the ranges a font has — the rules
 *     `library.*` and `track.set_font` / `track.set_program` enforce on their
 *     own edits. The library and the soundfont devices are read from the
 *     document, not from the snapshot: see `libraryReasons` and
 *     `soundfontDeviceReasons` for why a malformed stored value is reported
 *     rather than tidied into a valid one;
 *   - the arrangement holds at most `LIMITS.placements` placements,
 *     `LIMITS.markers` markers and `LIMITS.sections` sections, ends at bar
 *     `LIMITS.arrangementBars`, has no two placements overlapping on one
 *     track and no two sections overlapping each other, and every placement
 *     still names a clip of its own track — the rules the arrangement
 *     commands enforce on their own edits;
 *   - the mixer hangs together: every insert sits in a chain of a track, a
 *     return or the master that the song still holds and is one of
 *     `EFFECT_KINDS`, every send names a track and a return the song holds, the
 *     master's gain and target are inside `MIXER_RANGES`, and no count outgrows
 *     its limit (inserts per chain, returns per song, sends per track) — the
 *     rules the mixer commands enforce on their own edits.
 *
 * The history dry-runs an undo's plan on a clone of the document and calls
 * `invariantReasons`, so a plan that would leave the song in one of these
 * states is refused whole instead of leaving a clip pointing at a track that is
 * gone. Every reason carries the stable id of the check that raised it and of
 * the object it is about, so the history can tell a violation the plan inherits
 * from one it makes worse without comparing the sentences (see `dryRun` in
 * history.js).
 * @param {Y.Doc} doc
 * @returns {string[]} one plain-English reason per problem; empty when the
 *   document is consistent
 */
export function checkInvariants(doc) {
  return invariantReasons(doc).map((item) => item.text);
}

/**
 * One invariant reason: which check found something (`code`), on what
 * (`subject`) and how much of it (`count`, for the checks that count).
 *
 * `subject` is the object's stable id and never a name — a track, clip, insert,
 * return, take, sampler object or history-stable key such as a send's
 * `<track>/<return>`, an insert parameter's `<insert>/<param>`, a motion lane's
 * key, or a pair of ids in a fixed order (`"a|b"`) for a violation two objects
 * make together — and `"song"`/`"master"` for the song's own numbers. Nothing
 * in it is an array index, so a step that inserts or removes an object does not
 * move every reason behind it. Two reasons share a subject when they are about
 * the same object, which is how a plan that adds a second offender of one kind
 * is told from one that leaves the first where it was.
 * @param {string} code
 * @param {string} subject
 * @param {string} text
 * @param {number} [count]
 * @returns {{code: string, subject: string, text: string, count?: number}}
 */
function reason(code, subject, text, count) {
  const item = { code, subject, text };
  if (typeof count === "number") item.count = count;
  return item;
}

/**
 * The same checks as `checkInvariants`, one structured reason each.
 *
 * `code` is the check's stable kebab-case id, `subject` the stable id of the
 * object it is about, and `text` exactly the sentence `checkInvariants`
 * reports. A count-based check also carries `count`, the number it found, so a
 * plan that makes the very same violation worse (one more note past a clip's
 * end, one more effect in an over-full chain, a third object with an id the
 * song already holds twice) is visible even when the sentence reads the same.
 *
 * There is at most one reason per object and check: a motion lane with two bad
 * points is one sentence — the first bad point's first failing check — with
 * both points counted on it.
 *
 * The history dry-runs an undo against these keyed by `code` + `subject` — not
 * by the sentence: two orphan sends from one missing track read alike, and
 * keying on the text would swallow the second one.
 * @param {Y.Doc} doc
 * @returns {Array<{code: string, subject: string, text: string, count?: number}>}
 */
export function invariantReasons(doc) {
  const song = snapshot(doc);
  const reasons = [];

  if (song.tracks.length > LIMITS.tracks) {
    reasons.push(
      reason(
        "too-many-tracks",
        "song",
        `The song would have ${song.tracks.length} tracks; a song can have at most ${LIMITS.tracks} tracks.`,
        song.tracks.length,
      ),
    );
  }
  if (song.scenes.length > LIMITS.scenes) {
    reasons.push(
      reason(
        "too-many-scenes",
        "song",
        `The song would have ${song.scenes.length} scenes; a song can have at most ${LIMITS.scenes} scenes.`,
        song.scenes.length,
      ),
    );
  }

  reasons.push(...duplicateIdReasons(song.tracks, "track", "duplicate-track-id"));
  reasons.push(...duplicateIdReasons(song.scenes, "scene", "duplicate-scene-id"));
  reasons.push(...duplicateIdReasons(Object.values(song.clips), "clip", "duplicate-clip-id"));
  reasons.push(...duplicateIdReasons(Object.values(song.takes), "take", "duplicate-take-id"));

  const trackIds = new Set(song.tracks.map((track) => track.id));
  const sceneIds = new Set(song.scenes.map((scene) => scene.id));

  const takesById = new Map();
  const takesPerClip = new Map();
  for (const take of Object.values(song.takes)) {
    takesById.set(take.id, take);
    takesPerClip.set(take.clip_id, (takesPerClip.get(take.clip_id) ?? 0) + 1);
    const owner = song.clips[take.clip_id];
    if (!owner) {
      reasons.push(
        reason(
          "take-without-clip",
          take.id,
          `The take "${take.id}" would be left without its clip: there is no clip "${take.clip_id}" in the song.`,
        ),
      );
    } else if (owner.kind !== "audio") {
      const ownerLabel = owner.name === "" ? `clip "${owner.id}"` : `clip "${owner.name}"`;
      reasons.push(
        reason(
          "take-on-notes-clip",
          take.id,
          `The take "${take.id}" would belong to the ${ownerLabel}, which holds notes rather than a recording.`,
        ),
      );
    }
  }

  for (const clip of Object.values(song.clips)) {
    const label = clip.name === "" ? `clip "${clip.id}"` : `clip "${clip.name}"`;
    if (!trackIds.has(clip.track_id)) {
      reasons.push(
        reason(
          "clip-without-track",
          clip.id,
          `The ${label} would be left without its track: there is no track "${clip.track_id}" in the song.`,
        ),
      );
    }
    if (!sceneIds.has(clip.scene_id)) {
      reasons.push(
        reason(
          "clip-without-scene",
          clip.id,
          `The ${label} would be left without its scene: there is no scene "${clip.scene_id}" in the song.`,
        ),
      );
    }
    const limit = clip.length_bars * BEATS_PER_BAR;
    if (clip.kind === "audio") {
      const count = takesPerClip.get(clip.id) ?? 0;
      if (count > LIMITS.takesPerClip) {
        reasons.push(
          reason(
            "too-many-takes",
            clip.id,
            `The ${label} would have ${count} takes; a clip can have at most ${LIMITS.takesPerClip} takes.`,
            count,
          ),
        );
      }
      reasons.push(...segmentReasons(clip, label, takesById, limit));
    }
    // The clip's notes are checked for one sentence but counted whole: the
    // first note past the end is what a reader wants to see, and how many there
    // are is what tells a plan that adds another from one that leaves them be.
    let late = 0;
    let firstLate = null;
    for (let index = 0; index < clip.notes.length; index += 1) {
      const note = clip.notes[index];
      if (note.t + note.d <= limit) continue;
      late += 1;
      if (firstLate === null) firstLate = { index, end: note.t + note.d };
    }
    if (firstLate !== null) {
      reasons.push(
        reason(
          "note-past-clip-end",
          clip.id,
          `Note ${firstLate.index + 1} in the ${label} would end at beat ${beatText(firstLate.end)}, past its ${barsText(clip.length_bars)}.`,
          late,
        ),
      );
    }
  }

  reasons.push(...arrangementReasons(song));
  reasons.push(...samplerReasons(song));
  reasons.push(...midiReasons(song));
  reasons.push(...libraryReasons(song, doc));
  reasons.push(...soundfontDeviceReasons(doc));
  reasons.push(...mixerReasons(song));

  return reasons;
}

/**
 * What is wrong with a song's mixer, in plain English.
 *
 * The rules one mixer edit can look after on its own, checked over the whole
 * song at once: every insert sits in the chain of a track, a return or the
 * master the song still holds and is one of `EFFECT_KINDS`; every send names a
 * track and a return the song still holds; the master's gain and its loudness
 * target stay inside `MIXER_RANGES`; and no count outgrows its limit — the
 * effects of one chain, the returns of one song and the sends of one track.
 *
 * The values are checked as well as the structure, and against the same tables
 * the commands check them with: every parameter an insert holds is a parameter
 * its kind has, inside that parameter's own range or one of its values; a
 * return's gain and pan and a send's level are inside `MIXER_RANGES`; and so are
 * the master's three numbers. A `normalizeInsert` keeps a number that is out of
 * range but not one that is the wrong type, so those are the values a
 * hand-written or restored one can be off in — checked exactly the way a
 * command checks them.
 *
 * The history dry-runs an undo's plan on a clone and calls this, so a plan that
 * would remove a track's chain without putting the track back, or leave a send
 * pointing at a return that is gone, is refused whole instead of half-landing.
 * Only a reason the plan *creates* blocks it (see `dryRun` in history.js).
 *
 * The amp cap (`LIMITS.ampInsertsPerSong`) is not checked here: no effect of
 * kind `amp` can enter the document until PR C, which adds the cap with the
 * kind.
 * @param {object} song - a snapshot
 * @returns {Array<{code: string, subject: string, text: string, count?: number}>}
 */
function mixerReasons(song) {
  const reasons = [];
  const inserts = Object.values(song.inserts ?? {});
  const sends = Object.values(song.sends ?? {});
  const returns = Object.values(song.returns ?? {});
  const trackIds = new Set(song.tracks.map((track) => track.id));
  const returnIds = new Set(returns.map((item) => item.id));
  const [returnGainLow, returnGainHigh] = MIXER_RANGES.return.gain_db;
  const [returnPanLow, returnPanHigh] = MIXER_RANGES.return.pan;
  const [sendLow, sendHigh] = MIXER_RANGES.send.level_db;

  if (returns.length > LIMITS.returnsPerSong) {
    reasons.push(
      reason(
        "too-many-returns",
        "song",
        `The song would hold ${returns.length} returns; a song can hold at most ${LIMITS.returnsPerSong} returns.`,
        returns.length,
      ),
    );
  }
  reasons.push(...duplicateIdReasons(returns, "return", "duplicate-return-id"));
  for (const item of returns) {
    const which = `The return "${nameOrId(item.name, item.id)}"`;
    if (!(item.gain_db >= returnGainLow && item.gain_db <= returnGainHigh)) {
      reasons.push(
        reason(
          "return-gain-range",
          item.id,
          `${which} would be at ${item.gain_db} dB; a return runs from ${returnGainLow} to ${returnGainHigh} dB.`,
        ),
      );
    }
    if (!(item.pan >= returnPanLow && item.pan <= returnPanHigh)) {
      reasons.push(
        reason(
          "return-pan-range",
          item.id,
          `${which} would be panned to ${item.pan}; a return's pan runs from ${returnPanLow} to ${returnPanHigh}.`,
        ),
      );
    }
  }

  const perChain = new Map();
  for (const insert of inserts) {
    const which = `The insert "${insert.id}"`;
    const owner = insertOwnerOf(insert.owner);
    if (!owner) {
      reasons.push(
        reason(
          "insert-owner-invalid",
          insert.id,
          `${which} would sit in the chain "${insert.owner}", which is not a track, a return or the master.`,
        ),
      );
      continue;
    }
    if (owner.kind === "track" && !trackIds.has(owner.id)) {
      reasons.push(
        reason(
          "insert-without-track",
          insert.id,
          `${which} would be left without its track: there is no track "${owner.id}" in the song.`,
        ),
      );
      continue;
    }
    if (owner.kind === "return" && !returnIds.has(owner.id)) {
      reasons.push(
        reason(
          "insert-without-return",
          insert.id,
          `${which} would be left without its return: there is no return "${owner.id}" in the song.`,
        ),
      );
      continue;
    }
    if (!effectSpec(insert.kind)) {
      reasons.push(
        reason(
          "insert-kind-unknown",
          insert.id,
          `${which} would be a "${insert.kind}", which is not one of the effects a chain holds (${EFFECT_KINDS.join(", ")}).`,
        ),
      );
    } else {
      reasons.push(...insertParamReasons(which, insert, insert.kind, insert.params));
    }
    perChain.set(insert.owner, (perChain.get(insert.owner) ?? 0) + 1);
  }
  for (const [owner, count] of perChain) {
    if (count <= LIMITS.insertsPerChain) continue;
    const where = chainWhere(song, owner);
    reasons.push(
      reason(
        "chain-over-limit",
        owner,
        `The chain on ${where} would hold ${count} effects; a chain holds at most ${LIMITS.insertsPerChain} effects.`,
        count,
      ),
    );
  }

  const perTrack = new Map();
  for (const send of sends) {
    // One send is one object, so its reasons are about the pair it joins — not
    // about its track, which two sends of one track share: a plan that fixes one
    // of them and breaks another is then two different subjects, not one.
    const key = sendKey(send.track_id, send.return_id);
    if (!trackIds.has(send.track_id)) {
      reasons.push(
        reason(
          "send-without-track",
          key,
          `A send would be left without its track: there is no track "${send.track_id}" in the song.`,
        ),
      );
      continue;
    }
    if (!returnIds.has(send.return_id)) {
      reasons.push(
        reason(
          "send-without-return",
          key,
          `The send from "${send.track_id}" would be left without its return: there is no return "${send.return_id}" in the song.`,
        ),
      );
      continue;
    }
    if (!(send.level_db >= sendLow && send.level_db <= sendHigh)) {
      reasons.push(
        reason(
          "send-level-range",
          key,
          `The send from "${send.track_id}" would be at ${send.level_db} dB; a send runs from ${sendLow} to ${sendHigh} dB.`,
        ),
      );
    }
    perTrack.set(send.track_id, (perTrack.get(send.track_id) ?? 0) + 1);
  }
  for (const [trackId, count] of perTrack) {
    if (count <= LIMITS.sendsPerTrack) continue;
    const track = song.tracks.find((item) => item.id === trackId);
    reasons.push(
      reason(
        "too-many-sends",
        trackId,
        `Track "${nameOrId(track?.name, trackId)}" would feed ${count} returns; a track sends to at most ${LIMITS.sendsPerTrack} returns.`,
        count,
      ),
    );
  }

  const master = song.master ?? DEFAULT_MASTER;
  const gain = master.gain_db;
  if (!(gain >= MIXER_RANGES.master.gain_db[0] && gain <= MIXER_RANGES.master.gain_db[1])) {
    reasons.push(
      reason(
        "master-gain-range",
        "master",
        `The master's gain would be ${gain} dB; it runs from ${MIXER_RANGES.master.gain_db[0]} to ${MIXER_RANGES.master.gain_db[1]} dB.`,
      ),
    );
  }
  const target = master.target ?? DEFAULT_MASTER.target;
  const lufs = target.lufs;
  const peak = target.true_peak_db;
  if (!(lufs >= MIXER_RANGES.master.lufs[0] && lufs <= MIXER_RANGES.master.lufs[1])) {
    reasons.push(
      reason(
        "master-lufs-range",
        "master",
        `The master's target would be ${lufs} LUFS; a target runs from ${MIXER_RANGES.master.lufs[0]} to ${MIXER_RANGES.master.lufs[1]} LUFS.`,
      ),
    );
  }
  if (!(peak >= MIXER_RANGES.master.true_peak_db[0] && peak <= MIXER_RANGES.master.true_peak_db[1])) {
    reasons.push(
      reason(
        "master-peak-range",
        "master",
        `The master's true-peak ceiling would be ${peak} dBTP; it runs from ${MIXER_RANGES.master.true_peak_db[0]} to ${MIXER_RANGES.master.true_peak_db[1]} dBTP.`,
      ),
    );
  }

  return reasons;
}

/**
 * What is wrong with the parameters one insert holds, in plain English: a
 * parameter its kind does not have, a chooser set to a value that is not one of
 * its own, a number outside the range the table gives it.
 *
 * These are the values a snapshot can carry off the table: `normalizeInsert`
 * keeps a number that is out of range (the type is right) and drops one of the
 * wrong type, and it keeps every parameter as it is when the kind itself is
 * unknown (reported by the caller instead). Each message names the insert, the
 * parameter and the range, the way a command's refusal does.
 * @param {string} which - what the sentence calls the insert, e.g. `The insert "i1"`
 * @param {object} insert - the insert itself, for the subject its reasons carry
 * @param {string} kind - one of `EFFECT_KINDS`
 * @param {Object<string, any>} params - the insert's parameters
 * @returns {Array<{code: string, subject: string, text: string}>}
 */
function insertParamReasons(which, insert, kind, params) {
  const reasons = [];
  for (const [name, value] of Object.entries(params ?? {})) {
    const field = effectParamSpec(kind, name);
    // One parameter is one subject, so a plan that brings one into range and
    // pushes another out of it is not mistaken for leaving the insert alone.
    const subject = `${insert.id}/${name}`;
    if (!field) {
      reasons.push(
        reason(
          "insert-param-unknown",
          subject,
          `${which} would hold a parameter "${name}", which the ${effectLabel(kind)} does not have.`,
        ),
      );
      continue;
    }
    if (field.values) {
      if (!field.values.includes(value)) {
        reasons.push(
          reason(
            "insert-param-not-a-value",
            subject,
            `${which} would set "${name}" to ${typeof value === "string" ? `"${value}"` : String(value)}; it is one of ${field.values.join(", ")}.`,
          ),
        );
      }
      continue;
    }
    if (value >= field.min && value <= field.max) continue;
    reasons.push(
      reason(
        "insert-param-range",
        subject,
        `${which} would set "${name}" to ${value}; it runs from ${field.min} to ${field.max}${field.unit ? ` ${field.unit}` : ""}.`,
      ),
    );
  }
  return reasons;
}

/**
 * What a sentence calls the chain one owner's inserts sit in: `the master`, or
 * the track's or return's name.
 * @param {object} song - a snapshot
 * @param {string} owner - `"track:<id>"`, `"return:<id>"` or `"master"`
 * @returns {string}
 */
function chainWhere(song, owner) {
  const target = insertOwnerOf(owner);
  if (!target) return `"${owner}"`;
  if (target.kind === "master") return "the master";
  if (target.kind === "track") {
    const track = song.tracks.find((item) => item.id === target.id);
    return `track "${nameOrId(track?.name, target.id)}"`;
  }
  const item = (song.returns ?? {})[target.id];
  return `return "${nameOrId(item?.name, target.id)}"`;
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
 * @returns {Array<{code: string, subject: string, text: string, count?: number}>}
 */
function arrangementReasons(song) {
  const arrangement = song.arrangement ?? { placements: {}, markers: {}, sections: {} };
  const placements = Object.values(arrangement.placements ?? {});
  const markers = Object.values(arrangement.markers ?? {});
  const sections = Object.values(arrangement.sections ?? {});
  const reasons = [];

  if (placements.length > LIMITS.placements) {
    reasons.push(
      reason(
        "too-many-placements",
        "arrangement",
        `The arrangement would hold ${placements.length} placements; an arrangement can hold at most ${LIMITS.placements} placements.`,
        placements.length,
      ),
    );
  }
  if (markers.length > LIMITS.markers) {
    reasons.push(
      reason(
        "too-many-markers",
        "song",
        `The song would hold ${markers.length} markers; a song can hold at most ${LIMITS.markers} markers.`,
        markers.length,
      ),
    );
  }
  if (sections.length > LIMITS.sections) {
    reasons.push(
      reason(
        "too-many-sections",
        "song",
        `The song would hold ${sections.length} sections; a song can hold at most ${LIMITS.sections} sections.`,
        sections.length,
      ),
    );
  }

  reasons.push(...duplicateIdReasons(placements, "placement", "duplicate-placement-id"));
  reasons.push(...duplicateIdReasons(markers, "marker", "duplicate-marker-id"));
  reasons.push(...duplicateIdReasons(sections, "section", "duplicate-section-id"));

  const byTrack = new Map();
  for (const placement of placements) {
    const which = `The placement "${placement.id}"`;
    const track = song.tracks.find((item) => item.id === placement.track_id);
    const clip = song.clips[placement.clip_id];
    if (!track) {
      reasons.push(
        reason(
          "placement-without-track",
          placement.id,
          `${which} would be left without its track: there is no track "${placement.track_id}" in the song.`,
        ),
      );
    }
    if (!clip) {
      reasons.push(
        reason(
          "placement-without-clip",
          placement.id,
          `${which} would be left without its clip: there is no clip "${placement.clip_id}" in the song.`,
        ),
      );
    } else if (clip.track_id !== placement.track_id) {
      reasons.push(
        reason(
          "placement-clip-other-track",
          placement.id,
          `${which} would play clip "${clip.id}", which sits on track "${clip.track_id}", not "${placement.track_id}".`,
        ),
      );
    }
    if (placement.start_bar + placement.bars > LIMITS.arrangementBars) {
      reasons.push(
        reason(
          "placement-past-end",
          placement.id,
          `${which} would end at bar ${placement.start_bar + placement.bars}, past the ${LIMITS.arrangementBars}-bar end of the arrangement.`,
        ),
      );
    }
    if (!onOffsetGrid(placement.offset_beats)) {
      reasons.push(
        reason(
          "placement-offset-grid",
          placement.id,
          `${which} would start at an offset of ${placement.offset_beats} beats, which is off the sixteenth-of-a-beat grid.`,
        ),
      );
    }
    if (placement.fade_in_beats + placement.fade_out_beats > placement.bars * BEATS_PER_BAR) {
      reasons.push(
        reason(
          "placement-fades-too-long",
          placement.id,
          `${which} would fade in over ${placement.fade_in_beats} and out over ${placement.fade_out_beats} beats, longer than its ${barsText(placement.bars)}.`,
        ),
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
      // The pair is what overlaps, so the pair is the subject — in a fixed
      // order, so which of the two the sort met second cannot matter.
      reasons.push(
        reason(
          "placements-overlap",
          pairKey(previous.id, current.id),
          `The placements "${previous.id}" and "${current.id}" would overlap on track "${trackId}".`,
        ),
      );
    }
  }

  for (const marker of markers) {
    if (marker.bar > LIMITS.arrangementBars) {
      reasons.push(
        reason(
          "marker-past-end",
          marker.id,
          `The marker "${marker.id}" would sit at bar ${marker.bar}, past the ${LIMITS.arrangementBars}-bar end of the arrangement.`,
        ),
      );
    }
  }

  for (const section of sections) {
    const which = `The section "${section.id}"`;
    if (!(section.start_bar < section.end_bar)) {
      reasons.push(
        reason(
          "section-empty",
          section.id,
          `${which} would end at bar ${section.end_bar}, before it starts at bar ${section.start_bar}.`,
        ),
      );
    }
    if (section.end_bar > LIMITS.arrangementBars) {
      reasons.push(
        reason(
          "section-past-end",
          section.id,
          `${which} would end at bar ${section.end_bar}, past the ${LIMITS.arrangementBars}-bar end of the arrangement.`,
        ),
      );
    }
  }
  const ordered = [...sections].sort((a, b) => a.start_bar - b.start_bar);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.start_bar >= previous.end_bar) continue;
    reasons.push(
      reason(
        "sections-overlap",
        pairKey(previous.id, current.id),
        `The sections "${previous.id}" and "${current.id}" would overlap.`,
      ),
    );
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
 * points per lane).
 *
 * The number of motion lanes of one pattern is deliberately NOT checked here. A
 * lane is its own key of its pattern, so two peers writing their own lanes at
 * the same moment can merge into a pattern past `LIMITS.motionLanesPerPattern`
 * — and that is a merge, not a fault: the per-writer limit lives in
 * `motion.write`, a merged pattern is still a pattern the song can play, and no
 * undo elsewhere in the song may be refused because of it.
 *
 * The history dry-runs an undo's plan on a clone and calls this, so a plan that
 * would leave, say, a pad pointing at a slice a newer edit removed is refused
 * whole instead of half-landing.
 * @param {object} song - a snapshot
 * @returns {Array<{code: string, subject: string, text: string, count?: number}>}
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
      reason(
        "too-many-samples",
        "song",
        `The song would hold ${samples.length} samples; a song can hold at most ${LIMITS.samplesPerSong} samples.`,
        samples.length,
      ),
    );
  }
  const samplesById = new Map();
  for (const sample of samples) {
    samplesById.set(sample.id, sample);
    const which = `The sample "${nameOrId(sample.name, sample.id)}"`;
    if (!SAMPLE_RATES.includes(sample.rate)) {
      reasons.push(
        reason(
          "sample-rate",
          sample.id,
          `${which} would have a rate of ${sample.rate} Hz; a sample's rate is one of ${SAMPLE_RATES.join(", ")}.`,
        ),
      );
    }
    if (!(sample.frames > 0)) {
      reasons.push(reason("sample-empty", sample.id, `${which} would hold no frames.`));
    }
    if (sample.frames * sample.channels > LIMITS.sampleSamples) {
      reasons.push(
        reason(
          "sample-too-long",
          sample.id,
          `${which} would hold ${sample.frames * sample.channels} samples; a sample can hold at most ${LIMITS.sampleSamples} (frames × channels).`,
        ),
      );
    }
  }

  // Slices: each one is inside its sample's frames, and there are few enough.
  const slicesByKey = new Map();
  const slicesPerSample = new Map();
  for (const slice of slices) {
    const which = `The slice "${slice.id}" of sample "${slice.sample_id}"`;
    const key = sliceKey(slice.sample_id, slice.id);
    slicesByKey.set(key, slice);
    slicesPerSample.set(slice.sample_id, (slicesPerSample.get(slice.sample_id) ?? 0) + 1);
    const sample = samplesById.get(slice.sample_id);
    if (!sample) {
      reasons.push(
        reason(
          "slice-without-sample",
          key,
          `${which} would be left without its sample: there is no sample "${slice.sample_id}" in the song.`,
        ),
      );
      continue;
    }
    if (!(slice.start_frame >= 0 && slice.start_frame < slice.end_frame && slice.end_frame <= sample.frames)) {
      reasons.push(
        reason(
          "slice-outside-sample",
          key,
          `${which} would run from frame ${slice.start_frame} to frame ${slice.end_frame}, outside the ${sample.frames} frames of that sample.`,
        ),
      );
    }
  }
  for (const [sampleId, count] of slicesPerSample) {
    if (count <= LIMITS.slicesPerSample) continue;
    const label = nameOrId(samplesById.get(sampleId)?.name, sampleId);
    reasons.push(
      reason(
        "too-many-slices",
        sampleId,
        `The sample "${label}" would have ${count} slices; a sample can have at most ${LIMITS.slicesPerSample} slices.`,
        count,
      ),
    );
  }

  // Banks: on a sampler track, and no more than a kit holds.
  const tracksById = new Map(song.tracks.map((track) => [track.id, track]));
  const bankKeys = new Set();
  const banksPerTrack = new Map();
  for (const bank of banks) {
    const key = bankKey(bank.track_id, bank.id);
    bankKeys.add(key);
    banksPerTrack.set(bank.track_id, (banksPerTrack.get(bank.track_id) ?? 0) + 1);
    const which = `The bank "${nameOrId(bank.name, bank.id)}"`;
    const track = tracksById.get(bank.track_id);
    if (!track) {
      reasons.push(
        reason(
          "bank-without-track",
          key,
          `${which} would be left without its track: there is no track "${bank.track_id}" in the song.`,
        ),
      );
    } else if (track.device?.engine !== SAMPLER_DEVICE.engine) {
      reasons.push(
        reason(
          "bank-not-on-sampler-track",
          key,
          `${which} would sit on track "${nameOrId(track.name, track.id)}", which is not a sampler track.`,
        ),
      );
    }
  }
  for (const [trackId, count] of banksPerTrack) {
    if (count <= LIMITS.banksPerKit) continue;
    const label = nameOrId(tracksById.get(trackId)?.name, trackId);
    reasons.push(
      reason(
        "too-many-banks",
        trackId,
        `The kit of track "${label}" would have ${count} banks; a kit can have at most ${LIMITS.banksPerKit} banks.`,
        count,
      ),
    );
  }

  // Pads: a bank's own pad, playing a sample of the song and a slice of it.
  const padKeys = new Set();
  for (const pad of pads) {
    const key = padKey(pad.track_id, pad.bank_id, pad.index);
    padKeys.add(key);
    const which = `The pad ${Number(pad.index) + 1} of bank "${pad.bank_id}"`;
    if (!bankKeys.has(bankKey(pad.track_id, pad.bank_id))) {
      reasons.push(
        reason(
          "pad-without-bank",
          key,
          `${which} would be left without its bank: track "${pad.track_id}" has no bank "${pad.bank_id}".`,
        ),
      );
      continue;
    }
    if (!(Number.isInteger(pad.index) && pad.index >= 0 && pad.index < LIMITS.padsPerBank)) {
      reasons.push(
        reason(
          "pad-index-range",
          key,
          `${which} would sit at index ${pad.index}; a bank holds ${LIMITS.padsPerBank} pads, numbered 0 to ${LIMITS.padsPerBank - 1}.`,
        ),
      );
    }
    if (pad.sample_id === ABSENT) {
      if (pad.slice_id !== ABSENT) {
        reasons.push(reason("pad-slice-without-sample", key, `${which} would play a slice without a sample.`));
      }
      continue;
    }
    if (!samplesById.has(pad.sample_id)) {
      reasons.push(
        reason(
          "pad-sample-missing",
          key,
          `${which} would play sample "${pad.sample_id}", which is not in the song.`,
        ),
      );
      continue;
    }
    if (pad.slice_id === ABSENT) continue;
    if (!slicesByKey.has(sliceKey(pad.sample_id, pad.slice_id))) {
      reasons.push(
        reason(
          "pad-slice-missing",
          key,
          `${which} would play slice "${pad.slice_id}", which is not a slice of sample "${pad.sample_id}".`,
        ),
      );
    }
  }

  // Patterns, their clips and their chains.
  const patternKeys = new Set();
  const patternsPerClip = new Map();
  for (const pattern of patterns) {
    const key = patternKey(pattern.clip_id, pattern.id);
    patternKeys.add(key);
    patternsPerClip.set(pattern.clip_id, (patternsPerClip.get(pattern.clip_id) ?? 0) + 1);
    const clip = song.clips[pattern.clip_id];
    const which = `The pattern "${nameOrId(pattern.name, pattern.id)}"`;
    if (!clip) {
      reasons.push(
        reason(
          "pattern-without-clip",
          key,
          `${which} would be left without its clip: there is no clip "${pattern.clip_id}" in the song.`,
        ),
      );
    } else if (clip.kind !== "pattern") {
      reasons.push(
        reason(
          "pattern-on-notes-clip",
          key,
          `${which} would sit on clip "${nameOrId(clip.name, clip.id)}", which holds notes rather than patterns.`,
        ),
      );
    }
  }
  for (const [clipId, count] of patternsPerClip) {
    if (count <= LIMITS.patternsPerClip) continue;
    const clip = song.clips[clipId];
    const label = nameOrId(clip?.name, clipId);
    reasons.push(
      reason(
        "too-many-patterns",
        clipId,
        `The clip "${label}" would hold ${count} patterns; a pattern clip can hold at most ${LIMITS.patternsPerClip} patterns.`,
        count,
      ),
    );
  }
  for (const clip of Object.values(song.clips)) {
    if (clip.kind !== "pattern") continue;
    const which = `The clip "${nameOrId(clip.name, clip.id)}"`;
    const chain = Array.isArray(clip.chain) ? clip.chain : [];
    if (chain.length > LIMITS.chainLength) {
      reasons.push(
        reason(
          "pattern-chain-too-long",
          clip.id,
          `${which} would chain ${chain.length} patterns; a chain is at most ${LIMITS.chainLength} long.`,
          chain.length,
        ),
      );
    }
    for (const entry of chain) {
      if (patternKeys.has(patternKey(clip.id, entry))) continue;
      reasons.push(
        reason("chain-missing-pattern", clip.id, `${which} would chain "${entry}", which is not a pattern of that clip.`),
      );
    }
    if (!(clip.length_steps >= 1 && clip.length_steps <= LIMITS.stepPositions)) {
      reasons.push(
        reason(
          "step-positions-range",
          clip.id,
          `${which} would have ${clip.length_steps} step positions; a pattern holds 1 to ${LIMITS.stepPositions}.`,
        ),
      );
    }
    if (!STEP_BEATS_VALUES.includes(clip.step_beats)) {
      reasons.push(
        reason(
          "step-beats",
          clip.id,
          `${which} would use a step of ${clip.step_beats} beats; a step is one of ${STEP_BEATS_VALUES.join(", ")}.`,
        ),
      );
    }
    if (!(clip.swing >= 0 && clip.swing <= 0.75)) {
      reasons.push(
        reason("swing-range", clip.id, `${which} would swing ${clip.swing}; swing is between 0 and 0.75.`),
      );
    }
  }

  // Steps: on a pattern of their clip, on a pad of their track, inside the loop.
  const stepsPerPattern = new Map();
  for (const step of steps) {
    const key = patternKey(step.clip_id, step.pattern_id);
    const which = `The step at position ${step.at} of pattern "${step.pattern_id}"`;
    const where = stepKey(step.clip_id, step.pattern_id, step.at, step.bank_id, step.index);
    stepsPerPattern.set(key, (stepsPerPattern.get(key) ?? 0) + 1);
    if (!patternKeys.has(key)) {
      reasons.push(
        reason(
          "step-without-pattern",
          where,
          `${which} would be left without its pattern: clip "${step.clip_id}" has no pattern "${step.pattern_id}".`,
        ),
      );
      continue;
    }
    const clip = song.clips[step.clip_id];
    const positions = Number(clip?.length_steps) || 0;
    if (!(Number.isInteger(step.at) && step.at >= 0 && step.at < positions)) {
      reasons.push(
        reason(
          "step-past-loop",
          where,
          `${which} would sit outside the ${positions} step positions of clip "${nameOrId(clip?.name, step.clip_id)}".`,
        ),
      );
    }
    if (!padKeys.has(padKey(clip?.track_id ?? "", step.bank_id, step.index))) {
      reasons.push(
        reason(
          "step-pad-missing",
          where,
          `${which} would name a pad that is not on the clip's track: there is no pad ${Number(step.index) + 1} in bank "${step.bank_id}".`,
        ),
      );
    }
    const lockCount = Object.keys(step.locks ?? {}).length;
    if (lockCount > LIMITS.locksPerStep) {
      reasons.push(
        reason(
          "too-many-locks",
          where,
          `${which} would carry ${lockCount} locks; a step carries at most ${LIMITS.locksPerStep} locks.`,
          lockCount,
        ),
      );
    }
  }
  for (const [key, count] of stepsPerPattern) {
    if (count <= LIMITS.stepEntriesPerPattern) continue;
    reasons.push(
      reason(
        "too-many-steps",
        key,
        `A pattern would hold ${count} steps; a pattern can hold at most ${LIMITS.stepEntriesPerPattern} steps.`,
        count,
      ),
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
    const positions = Number(clip?.length_steps) || 0;
    const trackId = typeof clip?.track_id === "string" ? clip.track_id : "";
    for (const lane of lanes) {
      const laneParts = motionLaneParts(lane);
      const where = motionKey(pattern.clip_id, pattern.id, lane);
      if (!laneParts) {
        reasons.push(
          reason(
            "motion-lane-invalid",
            where,
            `${which} would hold the motion lane "${lane}", which names no pad and parameter.`,
          ),
        );
        continue;
      }
      const range = MOTION_PARAM_RANGES[laneParts.param];
      if (!range) {
        reasons.push(
          reason(
            "motion-param-unknown",
            where,
            `${which} would sweep "${laneParts.param}" on pad ${laneParts.index + 1}, which is not one of a pad's numeric fields (${MOTION_PARAMS.join(", ")}).`,
          ),
        );
        continue;
      }
      if (trackId !== "" && !padKeys.has(padKey(trackId, laneParts.bankId, laneParts.index))) {
        reasons.push(
          reason(
            "motion-pad-missing",
            where,
            `${which} would sweep pad ${laneParts.index + 1} of bank "${laneParts.bankId}", which is not on the clip's track.`,
          ),
        );
        continue;
      }
      const points = Array.isArray(motion[lane]) ? motion[lane] : [];
      if (points.length > LIMITS.motionPointsPerLane) {
        reasons.push(
          reason(
            "too-many-motion-points",
            where,
            `${which} would hold ${points.length} motion points on one lane; a lane holds at most ${LIMITS.motionPointsPerLane} motion points.`,
            points.length,
          ),
        );
        continue;
      }
      if (!(positions > 0)) continue;
      // One lane is one sentence — the one the check has always reported: the
      // first bad point's first failing check. Every bad point of the lane is
      // counted on it, so one more point off the loop is still visible even
      // though the sentence does not change (two peers' writes can leave a lane
      // with points neither of them wrote alone).
      let bad = 0;
      let firstBad = null;
      for (const point of points) {
        const stepFrac = Number(point.step_frac);
        const amount = Number(point.value);
        const outside = !(stepFrac >= 0 && stepFrac < positions);
        const offRange = !(amount >= range[0] && amount <= range[1]);
        if (!outside && !offRange) continue;
        bad += 1;
        if (firstBad === null) firstBad = { outside, stepFrac, amount };
      }
      if (firstBad === null) continue;
      if (firstBad.outside) {
        reasons.push(
          reason(
            "motion-point-past-loop",
            where,
            `${which} would put a motion point at step ${beatText(firstBad.stepFrac)}, outside its ${positions} step positions.`,
            bad,
          ),
        );
        continue;
      }
      reasons.push(
        reason(
          "motion-point-range",
          where,
          `${which} would sweep "${laneParts.param}" to ${firstBad.amount} on pad ${laneParts.index + 1}, outside its ${range[0]} to ${range[1]}.`,
          bad,
        ),
      );
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
 * @returns {Array<{code: string, subject: string, text: string, count?: number}>}
 */
function midiReasons(song) {
  const mappings = Object.values(song.midi_maps ?? {});
  const reasons = [];
  if (mappings.length > LIMITS.midiMaps) {
    reasons.push(
      reason(
        "too-many-midi-maps",
        "song",
        `The song would hold ${mappings.length} MIDI mappings; a song can hold at most ${LIMITS.midiMaps} MIDI mappings.`,
        mappings.length,
      ),
    );
  }

  const live = mappings.filter((mapping) => mapping.proposed !== true);
  for (let index = 0; index < live.length; index += 1) {
    for (let other = index + 1; other < live.length; other += 1) {
      if (live[index].device_name !== live[other].device_name) continue;
      if (!sameMessage(live[index].message, live[other].message)) continue;
      reasons.push(
        reason(
          "midi-duplicate-message",
          pairKey(live[index].id, live[other].id),
          `The mappings "${live[index].id}" and "${live[other].id}" would both be live for ${messageName(live[index].message)} on "${live[index].device_name}"; one message has one live action.`,
        ),
      );
    }
  }
  return reasons;
}

/**
 * What is wrong with a song's instrument library, in plain English.
 *
 * The rules one library edit can look after on its own, checked over the whole
 * song at once: the library stays inside its caps, every entry says what kind of
 * file it is, and every soundfont track names a font the song still holds. The
 * history dry-runs an undo's plan on a clone and calls this, so a plan that
 * would remove a font a track still plays is refused whole — the same rule
 * `library.remove` and the agent's sound guard keep on their own edits.
 *
 * The entries are counted as the DOCUMENT stores them, not as a snapshot tidies
 * them up: `normalizeLibraryEntry` reads an unknown kind as a font, so a song
 * holding one entry of kind `"wav"` would both pass unnoticed and be counted
 * against the font cap. A kind that is not a font, a capture or a cabinet is
 * reported here and is not one of the three.
 * @param {object} song - a snapshot
 * @param {Y.Doc} doc - the live document, read as it stores what it stores
 * @returns {Array<{code: string, subject: string, text: string, count?: number}>}
 */
function libraryReasons(song, doc) {
  const reasons = [];
  const entries = Object.values(song.library ?? {});

  if (entries.length > LIMITS.libraryEntriesPerSong) {
    reasons.push(
      reason(
        "too-many-library-entries",
        "song",
        `The song's library would hold ${entries.length} entries; a song's library holds at most ${LIMITS.libraryEntriesPerSong} entries.`,
        entries.length,
      ),
    );
  }
  reasons.push(...duplicateIdReasons(entries, "library entry", "duplicate-library-entry-id"));

  const fontIds = new Set();
  let fonts = 0;
  for (const [id, entry] of storedLibraryEntries(doc)) {
    if (!(entry instanceof Y.Map)) {
      reasons.push(
        reason(
          "library-entry-empty",
          id,
          `The library entry "${id}" would not hold anything; a library entry is a font, a capture or a cabinet.`,
        ),
      );
      continue;
    }
    const kind = entry.get("kind");
    if (kind === LIBRARY_KINDS[0]) {
      fonts += 1;
      fontIds.add(id);
      continue;
    }
    if (LIBRARY_KINDS.includes(kind)) continue;
    reasons.push(
      reason(
        "library-entry-kind",
        id,
        `The library entry "${nameOrId(entry.get("name"), id)}" would have the kind ${describeValue(kind)}; a library entry is a font, a capture or a cabinet.`,
      ),
    );
  }
  if (fonts > LIMITS.fontsPerSong) {
    reasons.push(
      reason(
        "too-many-fonts",
        "song",
        `The song's library would hold ${fonts} fonts; a song can hold at most ${LIMITS.fontsPerSong} fonts.`,
        fonts,
      ),
    );
  }

  for (const track of song.tracks ?? []) {
    if (track?.device?.engine !== SOUNDFONT_DEVICE.engine) continue;
    const which = `The track "${nameOrId(track.name, track.id)}"`;
    const fontId = track.device.font_id ?? ABSENT;
    if (fontId !== ABSENT && !fontIds.has(fontId)) {
      reasons.push(
        reason(
          "track-font-missing",
          track.id,
          `${which} would play the font "${fontId}", which is not in the song's library.`,
        ),
      );
    }
  }
  return reasons;
}

/**
 * What is wrong with the presets a song's soundfont devices name, read from the
 * document instead of from a snapshot.
 *
 * `normalizeTrack` reads a `font_id` that is not a string as nothing at all and
 * a bank or a program that is not an integer as 0, which is the right way for a
 * reader to get a usable value and the wrong way to check one: a stored
 * `font_id: 7` or `bank: "grand"` would pass every range check by having been
 * replaced first. So this check reads the device as the song holds it, and
 * reports a font id that is neither a string nor nothing, and a bank or a
 * program that is not an integer inside the range a font has (bank 0-127
 * melodic, 128 the GM drums; program 0-127).
 *
 * The agent's sound guard reads a font id the same lenient way, and in the other
 * direction: anything but nothing is an instrument the track plays (see
 * `trackHoldsSound` in hub.js).
 * @param {Y.Doc} doc
 * @returns {Array<{code: string, subject: string, text: string}>}
 */
function soundfontDeviceReasons(doc) {
  const reasons = [];
  const tracks = readContainer(doc, "tracks");
  if (!(tracks instanceof Y.Array)) return reasons;
  for (const track of tracks.toArray()) {
    if (!(track instanceof Y.Map)) continue;
    const device = toPlain(track.get("device"));
    const plain = device && typeof device === "object" ? device : {};
    if (plain.engine !== SOUNDFONT_DEVICE.engine) continue;
    const which = `The track "${nameOrId(track.get("name"), track.get("id"))}"`;
    const subject = String(track.get("id") ?? "");
    const fontId = plain.font_id;
    if (!(typeof fontId === "string" || fontId === ABSENT || fontId === undefined)) {
      reasons.push(
        reason(
          "font-id-type",
          subject,
          `${which} would name the font ${describeValue(fontId)}; a font id is a string, or nothing at all.`,
        ),
      );
    }
    const bank = plain.bank;
    if (!(Number.isInteger(bank) && bank >= 0 && bank <= MAX_SOUNDFONT_BANK)) {
      reasons.push(
        reason(
          "font-bank-range",
          subject,
          `${which} would play bank ${describeValue(bank)}; a soundfont track plays banks 0 to ${MAX_SOUNDFONT_BANK - 1}, or ${GM_DRUM_BANK} for the drums.`,
        ),
      );
    }
    const program = plain.program;
    if (!(Number.isInteger(program) && program >= 0 && program <= MAX_SOUNDFONT_PROGRAM)) {
      reasons.push(
        reason(
          "font-program-range",
          subject,
          `${which} would play program ${describeValue(program)}; a soundfont track plays programs 0 to ${MAX_SOUNDFONT_PROGRAM}.`,
        ),
      );
    }
  }
  return reasons;
}

/**
 * One song's library as the document itself holds it: each key and its entry,
 * untouched by a snapshot's normalising.
 * @param {Y.Doc} doc
 * @returns {Array<[string, any]>} empty when the song has no library
 */
function storedLibraryEntries(doc) {
  const library = readContainer(doc, "library");
  return library instanceof Y.Map ? [...library.entries()] : [];
}

/**
 * One stored value as a sentence names it: `"font-a"`, `7`, `true`, `a list`,
 * `an object`, or `nothing` when the field is not there at all.
 * @param {any} value
 * @returns {string}
 */
function describeValue(value) {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "a list";
  if (value && typeof value === "object") return "an object";
  return "nothing";
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
 * @returns {Array<{code: string, subject: string, text: string}>}
 */
function segmentReasons(clip, label, takesById, limit) {
  const reasons = [];
  const segments = Array.isArray(clip.comp) ? clip.comp : [];
  let previous = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const which = `Segment ${index + 1} of the ${label}`;
    // A segment's place in the comp is its sentence, never its identity: an
    // earlier segment inserted by another step must not make this one look
    // like a new offender. Its own id when it has one, else what it plays and
    // where it starts.
    const subject =
      typeof segment.id === "string" && segment.id !== ""
        ? `${clip.id}#${segment.id}`
        : `${clip.id}#${segment.take_id}@${beatText(segment.from_beat)}`;
    if (!(segment.from_beat < segment.to_beat)) {
      reasons.push(
        reason(
          "segment-empty",
          subject,
          `${which} would end at beat ${beatText(segment.to_beat)}, before it starts at beat ${beatText(segment.from_beat)}.`,
        ),
      );
      continue;
    }
    if (segment.from_beat < 0 || segment.to_beat > limit) {
      reasons.push(
        reason(
          "segment-outside-clip",
          subject,
          `${which} would run from beat ${beatText(segment.from_beat)} to beat ${beatText(segment.to_beat)}, outside the ${barsText(clip.length_bars)} of that clip.`,
        ),
      );
      continue;
    }
    if (previous && segment.from_beat < previous.from_beat) {
      reasons.push(
        reason(
          "segment-order",
          subject,
          `${which} would start at beat ${beatText(segment.from_beat)}, before the segment in front of it; segments go in beat order.`,
        ),
      );
      continue;
    }
    if (previous && segment.from_beat < previous.to_beat) {
      reasons.push(
        reason(
          "segment-overlap",
          subject,
          `${which} would start at beat ${beatText(segment.from_beat)}, inside the segment that ends at beat ${beatText(previous.to_beat)}.`,
        ),
      );
      continue;
    }
    previous = segment;
    const take = takesById.get(segment.take_id);
    if (!take || take.clip_id !== clip.id) {
      reasons.push(
        reason(
          "segment-take-missing",
          subject,
          `${which} would play take "${segment.take_id}", which is not a take of that clip.`,
        ),
      );
      continue;
    }
    if (take.discarded) {
      reasons.push(
        reason("segment-take-discarded", subject, `${which} would play take "${take.id}", which is discarded.`),
      );
    }
  }
  return reasons;
}

/**
 * One reason per id that two objects of this list share, carrying how many hold
 * it: the sentence is the one it always was, and the count is what tells a third
 * copy of the id from the second.
 * @param {Array<object>} items
 * @param {string} label - what the sentence calls the objects, e.g. `"clip"`
 * @param {string} code - the check's stable id, e.g. `"duplicate-clip-id"`
 * @returns {Array<{code: string, subject: string, text: string, count: number}>}
 */
function duplicateIdReasons(items, label, code) {
  const counts = new Map();
  for (const item of items) {
    const id = typeof item?.id === "string" ? item.id : "";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const reasons = [];
  for (const [id, count] of counts) {
    if (count < 2) continue;
    // The sentence stays the one it always was; the count is what tells a third
    // copy of the id from the second the song already held.
    reasons.push(reason(code, id, `The song would have two ${label}s with the id "${id}".`, count));
  }
  return reasons;
}

/**
 * Two objects' ids as one subject, in a fixed order: the pair is the offender,
 * so which of the two a scan happened to meet first cannot change what the
 * reason is about.
 * @param {string} left
 * @param {string} right
 * @returns {string}
 */
function pairKey(left, right) {
  return left <= right ? `${left}|${right}` : `${right}|${left}`;
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
 *     track's device and leaves its other controllers alone, and
 *     `"track:abc|device.font_id"` (and its siblings) sets one field of a
 *     soundfont track's device, so a font change and a program change undo
 *     independently;
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
 *   - `"library:abc|*"` does the same for one library entry, and
 *     `"library:abc|credit"` (and its siblings) writes one field of one;
 *   - `"insert:abc|*"` does the same for one insert, and
 *     `"insert:abc|params.mix"` writes ONE parameter of one insert — a
 *     parameter is its own field of the insert's `params` map, so it undoes
 *     alone and two peers editing two parameters of one insert both win —
 *     while `"insert:abc|order"` (and its siblings) writes one field;
 *   - `"send:<track>/<return>|*"` does the same for one send, and a plain field
 *     name (`"level_db"`, `"pre"`) writes one field of it;
 *   - `"return:abc|*"` does the same for one return, and a plain field name
 *     (`"name"`, `"gain_db"`, `"pan"`, `"mute"`) writes one field of one;
 *   - `"master|gain_db"` and `"master|target"` write the master's two fields,
 *     and `"master|*"` writes the master whole (a `null` writes the defaults
 *     back rather than taking the master away: every song has one);
 *   - `"motion:<clip>/<pattern>/<bank>.<index>|<param>|*"` writes ONE motion
 *     lane of one pattern: an array of `{step_frac, value}` points, or `null`
 *     to take the lane away. A lane is one key of its pattern
 *     (`"motion|<lane>"`), so its other lanes are left exactly as they are —
 *     two lanes of one pattern undo independently, and two writers on different
 *     lanes never overwrite each other;
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
      case "library":
      case "insert":
      case "send":
      case "return":
        writeContainerObject(doc, target.kind, target.id, split.field, value);
        break;
      case "master":
        writeMaster(doc, split.field, value);
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

  if (target.kind === "master") {
    // Every song has a master: a song without one reads the defaults, exactly as
    // the snapshot, the engine and the panel see it. So `master|gain_db` answers
    // the value the song plays with, not "nothing" (see `masterSettings`).
    const master = masterSettings(doc);
    if (field === "*") return master;
    if (field === "target") return cloneJson(master.target);
    const value = master[field];
    return value === undefined ? ABSENT : cloneJson(value);
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
 * `"device.params.Cutoff"` is `["device", "params", "Cutoff"]`; a soundfont
 * track's `"device.font_id"` is `["device", "font_id"]`; anything else is one
 * field of the object, so a plain field name can never be mistaken for a path.
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
  // One parameter inside an insert's `params`: one field of one effect, so a
  // parameter undoes alone whatever its neighbours hold.
  if (field.startsWith(PARAMS_FIELD_PREFIX) && field.length > PARAMS_FIELD_PREFIX.length) {
    return ["params", field.slice(PARAMS_FIELD_PREFIX.length)];
  }
  // One field inside a track's device: a soundfont track's instrument is the
  // pair (font, preset), so setting the font and setting the program are two
  // fields of one device and undo on their own. `device.type` is the
  // device-type guard a set_param entry carries (read-only, never restored).
  if (field.startsWith(DEVICE_FIELD_PREFIX) && field.length > DEVICE_FIELD_PREFIX.length) {
    return ["device", field.slice(DEVICE_FIELD_PREFIX.length)];
  }
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
  library: "library",
  insert: "inserts",
  send: "sends",
  return: "returns",
});

/** @returns {Y.Map<any>|null} one live object of an id-keyed container (a sample, insert, send, return, …), or null. */
function containerObject(doc, kind, id) {
  const key = OBJECT_MAP_OF[kind];
  if (!key) return null;
  return liveObject(readContainer(doc, key), id);
}

/**
 * Write one field of a sampler object, a MIDI mapping, a library entry, an
 * insert, a send or a return, or (re)create/delete it whole.
 *
 * A pad and a step carry no `id` of their own: their container key is their
 * identity (`<track>/<bank>/<index>` and `<clip>/<pattern>/<at>/<bank>.<index>`),
 * so nothing here invents one. A send carries no id either: the pair it joins
 * (`<track>/<return>`) is its identity. A sample, slice, bank, pattern, MIDI
 * mapping, library entry, insert and return do carry one, and it is the same
 * value their key holds.
 *
 * A pattern's motion is stored as one key per lane on the pattern's own map
 * (`setMotionLane`), and a whole-pattern restore (an undo of `pattern.remove`,
 * say) puts each lane back under its own key (`patternMapFrom`), so the pattern
 * it restores is still two writers' safe. An insert's `params` is handled the
 * same way by `writeInsert`: it is a map of its own, one key per parameter.
 */
function writeContainerObject(doc, kind, id, field, value) {
  const key = OBJECT_MAP_OF[kind];
  if (field === "*" && value === ABSENT) {
    const existing = readContainer(doc, key);
    if (existing instanceof Y.Map) existing.delete(id);
    return;
  }
  const map = ensureContainer(doc, key, () => new Y.Map());
  if (kind === "insert") {
    writeInsert(map, id, field, value);
    return;
  }
  if (field === "*") {
    const object = cloneJson(value) ?? {};
    delete object._index;
    const hasOwnId = kind !== "pad" && kind !== "step" && kind !== "send";
    const stored = hasOwnId ? { ...object, id: object.id ?? id } : object;
    map.set(id, kind === "pattern" ? patternMapFrom(stored) : objectMap(stored));
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
 * Write one field of an insert, or (re)create/delete it whole.
 *
 * `params` is the one nested container the song's objects have: it holds one key
 * per parameter, so `insert.set` of one parameter is one field write that undoes
 * alone, and two peers editing two parameters of one insert both keep their
 * writes. Every way an insert is written — a creation, a whole-object restore —
 * builds it as that same map, so a restored insert is still editable one
 * parameter at a time.
 * @param {Y.Map<any>} map - the live inserts map
 * @param {string} id
 * @param {string} field - `"*"`, `"params"`, `"params.<name>"` or a plain field
 * @param {any} value
 * @returns {void}
 */
function writeInsert(map, id, field, value) {
  if (field === "*") {
    const object = cloneJson(value) ?? {};
    delete object._index;
    const params = paramsObject(object.params);
    delete object.params;
    const stored = objectMap({ ...object, id: object.id ?? id });
    stored.set("params", objectMap(params));
    map.set(id, stored);
    return;
  }
  const insert = map.get(id);
  if (!(insert instanceof Y.Map)) throw new Error(`Studio: there is no insert "${id}" to write to`);
  if (field === "params") {
    replaceParams(insert, value);
    return;
  }
  if (field.startsWith(PARAMS_FIELD_PREFIX)) {
    const params = paramsMapOf(insert);
    const name = field.slice(PARAMS_FIELD_PREFIX.length);
    if (value === ABSENT) params.delete(name);
    else params.set(name, cloneJson(value));
    return;
  }
  writeField(insert, field, value);
}

/** @returns {Y.Map<any>} an insert's params map, made from what it holds when it has none. */
function paramsMapOf(insert) {
  const current = insert.get("params");
  if (current instanceof Y.Map) return current;
  const created = new Y.Map(Object.entries(paramsObject(current)));
  insert.set("params", created);
  return created;
}

/**
 * Replace an insert's whole parameter set, keeping each parameter its own key:
 * the named parameters are written and the ones the value does not name are
 * taken away, so a parameter another instance moved is either kept whole or
 * removed whole, never half-overwritten.
 * @param {Y.Map<any>} insert - the live insert
 * @param {any} value - a plain `{name: value}` object, or `null` for none
 * @returns {void}
 */
function replaceParams(insert, value) {
  const params = paramsMapOf(insert);
  const wanted = paramsObject(value);
  for (const [name, item] of Object.entries(wanted)) params.set(name, cloneJson(item));
  for (const name of [...params.keys()]) {
    if (Object.hasOwn(wanted, name)) continue;
    params.delete(name);
  }
}

/** @returns {Object<string, any>} a live or plain parameter map as a plain object. */
function paramsObject(value) {
  const plain = toPlain(value);
  return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {};
}

/**
 * Write the song's master: one of its two fields, or the whole of it.
 *
 * The master is the one object every song has, so a write of `null` puts the
 * default back (gain 0, the -14 LUFS target with a -1 dBTP ceiling) rather than
 * taking the map away: a reader never has to ask whether the master is there.
 * `target` is one field, written whole, because that is how a command and the
 * panel set it: one `master.set` is one or two field writes.
 * @param {Y.Doc} doc
 * @param {string} field - `"*"`, `"gain_db"` or `"target"`
 * @param {any} value
 * @returns {void}
 */
function writeMaster(doc, field, value) {
  const master = masterMap(doc);
  if (field === "*") {
    const plain = value === ABSENT ? cloneJson(DEFAULT_MASTER) : cloneJson(value);
    master.set("gain_db", numberOr(plain?.gain_db, DEFAULT_MASTER.gain_db));
    master.set("target", normalizeMaster(plain).target);
    return;
  }
  if (field !== "gain_db" && field !== "target") {
    throw new Error(`Studio: the master has no field "${field}"; it has gain_db and target`);
  }
  if (value === ABSENT) {
    master.set(field, cloneJson(DEFAULT_MASTER[field]));
    return;
  }
  master.set(field, field === "target" ? normalizeMaster({ target: value }).target : cloneJson(value));
}

/**
 * Build the map one pattern is stored as: its own fields plus one key per
 * motion lane (`motion|<lane>` → its points), which is how a whole-pattern
 * restore writes its curves back.
 *
 * An entry recorded while the lanes still travelled as one plain object under
 * `motion` has it spread into those same per-lane keys, so a restore does not
 * lose a curve it was recorded with.
 * @param {object} object the pattern, as a snapshot or a history entry holds it
 * @returns {Y.Map<any>}
 */
function patternMapFrom(object) {
  const fields = { ...object };
  const motion = fields.motion && typeof fields.motion === "object" && !Array.isArray(fields.motion) ? fields.motion : null;
  delete fields.motion;
  const map = objectMap(fields);
  if (!motion) return map;
  for (const lane of Object.keys(motion)) {
    if (!Array.isArray(motion[lane])) continue;
    map.set(MOTION_FIELD_PREFIX + lane, cloneJson(motion[lane]));
  }
  return map;
}

/**
 * Replace a pattern's whole motion with one key per lane.
 *
 * This is the one way a motion object goes into the document as a whole (a
 * `pattern|motion` field write); every other write touches a single lane key
 * (`writeMotionLane`, `setMotionLane`). It writes the lanes it is given under
 * their own keys and takes away the ones the value does not name, so a lane
 * another instance moves is either kept whole or removed whole, never
 * half-overwritten.
 * @param {Y.Map<any>} pattern - the live pattern
 * @param {unknown} value - `{lane: points}` as a snapshot spells it, or `null`
 * @returns {void}
 */
function setPatternMotion(pattern, value) {
  const motion = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const wanted = new Set();
  for (const lane of Object.keys(motion)) {
    if (!Array.isArray(motion[lane])) continue;
    wanted.add(lane);
    pattern.set(MOTION_FIELD_PREFIX + lane, cloneJson(motion[lane]));
  }
  for (const key of [...pattern.keys()]) {
    if (typeof key !== "string" || !key.startsWith(MOTION_FIELD_PREFIX)) continue;
    if (wanted.has(key.slice(MOTION_FIELD_PREFIX.length))) continue;
    pattern.delete(key);
  }
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
 * A lane is one KEY of its pattern's own map (`setMotionLane`), so this touches
 * that one key and nothing else: another lane, written by this page or by
 * someone else at the same moment, is never overwritten. The pattern itself
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
  // Taking a lane away that is not there writes nothing at all.
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
    // A track that plays no SunVox module carries only the fields its own kind
    // reads: an audio track plays takes, a sampler track plays the kit that
    // lives in the song's own banks and pads, and a soundfont track plays one
    // preset of one library font (see SOUNDFONT_DEVICE). None of them keeps a
    // SunVox module or its controllers inside the device.
    device: engine === AUDIO_DEVICE.engine || engine === SAMPLER_DEVICE.engine
      ? { engine }
      : engine === SOUNDFONT_DEVICE.engine
        ? {
            engine,
            font_id: typeof device.font_id === "string" ? device.font_id : ABSENT,
            bank: integerOr(device.bank, 0),
            program: integerOr(device.program, 0),
          }
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
    motion: normalizeMotion(motionOf(value)),
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

/**
 * A library entry as a snapshot carries it: every field present, nothing extra.
 *
 * The file itself is never in the document. A catalog entry says which catalog
 * row it is (`catalog_id`) and where the instance keeps its copy
 * (`storage_key`); an uploaded one names the upload it came from (`upload_id`).
 * `sha256` and `bytes` are what the server checked before the entry was added,
 * and `licence` and `credit` are what the picker shows beside the instrument.
 */
function normalizeLibraryEntry(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    kind: LIBRARY_KINDS.includes(plain.kind) ? plain.kind : LIBRARY_KINDS[0],
    name: typeof plain.name === "string" ? plain.name : "",
    source: LIBRARY_SOURCES.includes(plain.source) ? plain.source : LIBRARY_SOURCES[1],
    catalog_id: typeof plain.catalog_id === "string" ? plain.catalog_id : ABSENT,
    storage_key: typeof plain.storage_key === "string" ? plain.storage_key : ABSENT,
    upload_id: typeof plain.upload_id === "string" ? plain.upload_id : ABSENT,
    sha256: typeof plain.sha256 === "string" ? plain.sha256 : "",
    bytes: integerOr(plain.bytes, 0),
    licence: typeof plain.licence === "string" ? plain.licence : "",
    credit: typeof plain.credit === "string" ? plain.credit : "",
    author_label: typeof plain.author_label === "string" ? plain.author_label : "",
  };
}

/**
 * An insert as a snapshot carries it: every field present, nothing extra, and
 * its parameters as one plain object.
 *
 * A parameter whose stored value is not the type the kind has, or is missing
 * altogether, reads as its default — the way `normalizePad` reads a broken
 * field. A number that IS a number is kept as it is, even out of range, which
 * is what lets a hand-written or restored value be reported instead of quietly
 * tidied into a valid one.
 */
function normalizeInsert(id, value) {
  const plain = stripHints(value);
  const kind = typeof plain.kind === "string" ? plain.kind : "";
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    owner: typeof plain.owner === "string" ? plain.owner : "",
    order: numberOr(plain.order, 0),
    kind,
    bypass: plain.bypass === true,
    params: normalizeEffectParams(kind, plain.params),
  };
}

/**
 * One effect's parameters as a snapshot carries them: every parameter the kind
 * has, in the table's order, each at its stored value when that value has the
 * right type and at its default otherwise.
 * @param {string} kind
 * @param {unknown} stored - the insert's `params`, live or plain
 * @returns {Object<string, number|string>}
 */
function normalizeEffectParams(kind, stored) {
  const params = plainParamsOf(stored);
  const spec = effectSpec(kind);
  if (!spec) return { ...params };
  const out = {};
  for (const [name, field] of Object.entries(spec.params)) {
    const value = params[name];
    if (field.values) out[name] = field.values.includes(value) ? value : field.default;
    else out[name] = typeof value === "number" && Number.isFinite(value) ? value : field.default;
  }
  return out;
}

/** @returns {Object<string, any>} a live or plain parameter map as plain JSON. */
function plainParamsOf(stored) {
  if (!stored || typeof stored !== "object") return {};
  const plain = toPlain(stored);
  return plain && typeof plain === "object" ? plain : {};
}

/**
 * A send as a snapshot carries it: every field present, nothing extra. The key
 * it lives under says which track and return it joins, so a send whose own
 * fields were damaged still reads as the pair it is.
 */
function normalizeSend(id, value) {
  const plain = stripHints(value);
  const parts = sendParts(id);
  return {
    track_id: typeof plain.track_id === "string" ? plain.track_id : parts?.trackId ?? "",
    return_id: typeof plain.return_id === "string" ? plain.return_id : parts?.returnId ?? "",
    level_db: numberOr(plain.level_db, 0),
    pre: plain.pre === true,
  };
}

/** A return as a snapshot carries it: every field present, nothing extra. */
function normalizeReturn(id, value) {
  const plain = stripHints(value);
  return {
    id: typeof plain.id === "string" ? plain.id : id,
    name: typeof plain.name === "string" ? plain.name : "",
    gain_db: numberOr(plain.gain_db, 0),
    pan: numberOr(plain.pan, 0),
    mute: plain.mute === true,
  };
}

/**
 * The master as a snapshot carries it: every field present, the fields a song
 * does not hold filled in from `DEFAULT_MASTER`. Read-only — a song with no
 * master is not written to by being read.
 */
function normalizeMaster(value) {
  const plain = stripHints(value);
  const target = plain.target && typeof plain.target === "object" ? plain.target : {};
  return {
    gain_db: numberOr(plain.gain_db, DEFAULT_MASTER.gain_db),
    target: {
      lufs: numberOr(target.lufs, DEFAULT_MASTER.target.lufs),
      true_peak_db: numberOr(target.true_peak_db, DEFAULT_MASTER.target.true_peak_db),
    },
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
