/**
 * Studio sequencer — the pure half of the engine.
 *
 * For one block of audio frames it says which notes start and which stop, on
 * which track, and nothing else: no Web Audio, no SunVox, no imports, no
 * clock of its own. The same file runs inside the AudioWorklet in a browser
 * and, as a classic script, inside Node's worklet-less offline render, so the
 * two hosts read the song exactly the same way.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioSequencer` for the worklet scope and `module.exports` when
 * a CommonJS `module` exists. `engine/package.json` marks the directory
 * `"type": "commonjs"` so a Node `require()` of this file works inside the
 * bundle's ESM tree; the browser never looks at that file.
 *
 * ## Time
 *
 * Everything is measured in frames from the start of the transport.
 * `framesPerBeat = sampleRate * 60 / bpm` may be fractional, so every event
 * frame is `Math.round(originFrame + beat * framesPerBeat)` — an absolute
 * position rounded once — never a running total of per-block sums, which is
 * what makes two different block sizes produce the very same events.
 *
 * `block(frameStart, frames)` must be called with contiguous frame starts. It
 * returns events carrying `frame` as an offset inside that block
 * (`0 <= frame < frames`), sorted by frame and, at one frame, offs before ons.
 *
 * ## Sounding notes: the open set
 *
 * Every "on" this file emits registers an entry in an OPEN set, keyed by track
 * and pitch, holding the frame its off is owed at. "off" events are emitted
 * from that set and from nowhere else, so:
 *
 * - a note can never be released twice (the entry is removed when it is
 *   emitted, when it is re-triggered, or when it is force-closed);
 * - a note can never be left stuck: an entry is either reached by the block
 *   that covers its own off frame, capped at its clip's loop end or its
 *   segment's end, or closed by `reconcile()` when a state change makes it
 *   invalid (its note deleted or moved, its clip removed or shortened, its
 *   track removed, muted or out-soloed);
 * - an off whose frame fell before the block being built — the transport was
 *   stopped and then the host asked for a later block — is emitted at frame 0
 *   of that block instead of being dropped.
 *
 * A re-trigger of a pitch that is still sounding emits its off at the same
 * frame, before the new on (the sort below puts offs first). Two notes of one
 * pitch starting on the very same frame cannot be told apart by an engine, so
 * they share one on and one off.
 *
 * Forced offs (a state change, not a musical note end) are queued and emitted
 * at frame 0 of the next block. A mutator is never called from inside
 * `block()` in 1a, so that queue is always flushed by a later block.
 *
 * ## Session view
 *
 * One clip sounds per track at a time. `launchClip` / `launchScene` /
 * `stopTrack` / `stopAll` are quantized to the next bar while the transport
 * runs, and take effect at the first bar when it does not. A launch closes the
 * track's segment at that boundary; the notes still sounding from the replaced
 * clip get their off there.
 *
 * A clip loops over `length_bars * 4` beats and a note crossing the loop end
 * is cut there. Notes are emitted only for tracks that are not muted and, when
 * any track is soloed, only for the soloed ones.
 *
 * ## Arrangement view
 *
 * `setMode("arrangement")` plays the song's timeline instead of the session
 * grid: each track plays the placement under the playhead, starting at that
 * placement's `offset_beats` into its clip, and a placement longer than its
 * clip loops it. Launches are ignored in this mode — `launchScene`,
 * `launchClip`, `stopTrack` and `stopAll` do nothing and report nothing — and
 * so is the session's own state: switching mode closes every sounding note and
 * voice and resets what each track plays.
 *
 * `seek(bar)` moves the arrangement playhead: the next block plays from that
 * bar, and the notes and voices that were sounding are closed first. `play()`
 * starts from the seek bar, which is bar 0 until it is moved. A seek in the
 * session view changes nothing that is playing: it only remembers the bar a
 * later switch to the arrangement starts at, and `setMode()` keeps that bar
 * rather than resetting it.
 *
 * The placements are played, not the placement list: two adjacent placements
 * of one clip whose clip time continues exactly — the two halves
 * `arrangement.split` makes — are joined into one segment, so a note keeps its
 * off across the split and a take keeps playing without a restart or a
 * crossfade. Two placements that fade at the seam are never joined: the earlier
 * one's fade out ramps its own voice down, and the later one's fade in has to
 * start a new voice at silence.
 *
 * A placement's fades are linear gain ramps, and only audio placements have
 * them. They are emitted as
 *
 *     {frame, type: "fade", track_id, voice, from, to, frames}
 *
 * where `frame` is the frame the ramp starts at and `frames` its length: at
 * offset `i` inside it the voice's gain is `from + (to - from) * i / frames`.
 * The host multiplies that with the voice's crossfade envelope. Every voice a
 * window covers gets one: a fade is placed on the voice that sounds at its
 * first frame (so a comp boundary inside a fade out moves the rest of the ramp
 * to the voice that plays on), and a voice started inside a window picks the
 * ramp up where it is — `from` is the gain the window holds at that frame and
 * `frames` what is left of it.
 *
 * ## Audio clips
 *
 * A clip whose `kind` is `"audio"` holds no notes: it plays recorded takes
 * through a comp, `comp: [{take_id, from_beat, to_beat}]` over the clip's own
 * beats. For every comp segment that starts sounding — on a launch, on a loop
 * restart, or when the playhead crosses its `from_beat` — this file emits
 *
 *     {frame, type: "audio", track_id, take_id, take_frame, voice}
 *
 * and for the end of that segment (or of the clip, or of the transport) an
 * `{frame, type: "audio_stop", track_id, voice}`. The take is laid out so that
 * take frame `offset_frames` (scaled to this host's rate) sounds at clip beat
 * 0, so at clip beat `b` the take frame is
 * `round(b * framesPerBeat) + round(offset_frames * rate / take.rate)`. A take
 * that the song marks `discarded` never sounds at all; a take the song does
 * not have still starts, so a host can say which one it is missing.
 *
 * Each audio track has TWO voices, taken in turn (0, 1, 0, …) at consecutive
 * segment starts, so the host can crossfade one segment into the next. The
 * stops travel through an open set of their own, with the same rules as the
 * notes above (re-trigger offs first at one frame, never released twice, never
 * left sounding, forced stops paid at frame 0 of the next block).
 *
 * The takes a song carries arrive in `snapshot.takes` (see `server/doc.js`):
 * the comp only needs their rate and their recorded offset, which are read
 * once per `setSong()` like the rest of the song.
 *
 * ## Pattern clips
 *
 * A sampler track's clip is a pattern: `kind: "pattern"`, with a step length
 * (`length_steps × step_beats` beats is one pattern's loop, `L` below) and its
 * patterns, whose steps live in the song's own `steps` container. Its notes are
 * empty. For every step that sounds this file emits
 *
 *     {frame, type: "pad", track_id, bank_id, index, v, locks, gate_frames}
 *
 * A pad trigger is not a note: nothing is released, so it has no entry in the
 * open set — the pad's own mode (one-shot or gate) decides how its voice ends,
 * which is the processor's business. `gate_frames` is the plain step length in
 * frames (`step_beats × framesPerBeat`), which a `gate` pad releases at.
 *
 * **Swing.** A step sounds `at × step_beats` beats into its pattern's loop, and
 * an ODD step is delayed by `swing × step_beats` beats more (swing is 0 to
 * 0.75; 0.5 with 16th steps is a 1/32 note, a 0.125-beat delay). The onset is a
 * beat turned into a frame by `beatToFrame()` — one absolute rounding, like
 * every other event here, never a running total of per-step deltas — and the
 * delay never moves `gate_frames`.
 *
 * **Chains.** A clip's chain is a list of its own pattern ids. One pattern's
 * loop is `L = length_steps × step_beats` beats and the clip's cycle is
 * `L × max(1, chain.length)` beats; the pattern a clip plays at clip-relative
 * beat `b` is `chain[floor(b / L) mod chain.length]` when the chain is not
 * empty, and the clip's FIRST pattern (the lowest `order`, then the id) when it
 * is. That answer is derived from `b` alone, never from what played before, so
 * a seek, a relaunch or an arrangement placement lands on the very same
 * pattern. A pattern change inside a chain cuts nothing: no pad is ever
 * released here, so a sample plays across the seam unless its own pad's choke
 * group ends it.
 *
 * **Both views.** In the session view a launched pattern clip plays its chain
 * from cycle beat 0 and loops the cycle. In the arrangement view a placement of
 * a pattern clip plays the cycle from `offset_beats` into it and loops it for
 * the placement's length; adjacent placements whose clip time continues are one
 * segment, exactly as they are for other clips. A song update — a chain edit, a
 * swing change — is read when the next block is built, so it applies from that
 * block at the clip-relative beat the playhead has reached, and nothing already
 * emitted is emitted a second time.
 *
 * ## Launch reports
 *
 * Every launch this file APPLIES is reported in the very block it takes effect
 * in. The array `block()` returns carries that block's reports as a
 * non-enumerable `launches` property, so the events themselves keep the shape
 * every caller already reads. One report is
 * `{track_id, clip_id|null, scene_id|null, bar, frame}`:
 *
 * - `frame` is the offset inside that block of the boundary frame
 *   (`0 <= frame < frames`), so a host adds its own frame at the block's start
 *   to get an absolute frame;
 * - `bar` is the 0-based bar the launch took effect at;
 * - `clip_id` is `null` for a stop;
 * - a scene launch reports one entry per track it changed, all with that
 *   scene's id, and a track already playing the clip it is asked for is not a
 *   change and is not reported. A `stopTrack` / `stopAll` report carries the
 *   scene of the clip it replaces, when that clip is known.
 *
 * A launch scheduled while the transport is stopped takes effect at beat 0, so
 * it is reported in the block that starts the transport, not in the block the
 * launch was asked in.
 *
 * `stop()` halts the transport: every sounding note gets its off at the
 * current frame, the position goes back to 1.1.1, and the clips that were
 * sounding stay armed so `play()` starts them again from the transport's
 * beginning.
 *
 * ## Tempo
 *
 * A `setSong()` that changes the tempo rebases the transport so the playhead
 * keeps its beat position: the beat under the playhead stays the same beat and
 * every following note is re-mapped through beats. Launch boundaries are
 * stored in beats, so a scheduled launch follows a tempo change too.
 *
 * ## Song shape
 *
 * The snapshot is `bundles/studio/server/doc.js`'s: `meta.bpm`,
 * `tracks[{id, mute, solo}]`, `scenes[{id}]`,
 * `clips{id: {id, track_id, scene_id, length_bars, notes[{t, d, p, v}],
 * kind?, comp?, length_steps?, step_beats?, swing?, chain?}}` with `t`/`d` in
 * beats, `p` a MIDI pitch and `v` a velocity (a pattern clip's notes are empty:
 * it carries its `length_steps`, its `step_beats`, its `swing` and its `chain`
 * of pattern ids instead),
 * `takes{id: {id, clip_id, rate, offset_frames, discarded}}` for the takes
 * an audio clip's comp plays, and for the sampler
 * `patterns{"<clip_id>/<pattern_id>": {id, clip_id, order, name}}` and
 * `steps{"<clip_id>/<pattern_id>/<at>/<bank_id>.<index>": {clip_id,
 * pattern_id, at, bank_id, index, v, locks}}` for a pattern clip's steps.
 */
(function () {
  "use strict";

  /** 1a is four beats to the bar, in every song. */
  const BEATS_PER_BAR = 4;

  /** A pattern's step positions when the document names none, and their limit. */
  const DEFAULT_STEP_POSITIONS = 16;
  const MAX_STEP_POSITIONS = 64;

  /** A pattern's step length when the document names none: a sixteenth note. */
  const DEFAULT_STEP_BEATS = 0.25;

  /** The most a pattern may swing, in step lengths (the document's own cap). */
  const MAX_SWING = 0.75;

  /** Shared empties, so a song of pattern clips allocates nothing per read. */
  const EMPTY_STEPS = Object.freeze([]);
  const EMPTY_LOCKS = Object.freeze({});
  /** A pattern clip's pattern id → its steps. Never written to. */
  const EMPTY_PATTERN_STEPS = new Map();

  /** A beat holds four sixteenths, which `position()` reports. */
  const SIXTEENTHS_PER_BEAT = 4;

  /** The tempo a song without a usable `meta.bpm` plays at. */
  const DEFAULT_BPM = 120;

  /** The rate a host that names none is assumed to run at. */
  const DEFAULT_SAMPLE_RATE = 48000;

  /**
   * Slack, in beats, for a beat compared against a frame position: small enough
   * to be below one frame, large enough to survive the rounding.
   */
  const EPSILON_BEATS = 1e-9;

  /**
   * Create a sequencer for one host. One instance follows one song.
   *
   * A launch while the transport has not advanced past beat 0 (before the
   * first block, or while stopped) takes effect at beat 0, so the first bar of
   * the transport plays it.
   *
   * @param {{sampleRate?: number}} [options] the host's sample rate
   * @returns {{setSong: function(object): void,
   *            launchScene: function(string): void,
   *            launchClip: function(string): void,
   *            stopTrack: function(string): void,
   *            stopAll: function(): void,
   *            play: function(): void,
   *            stop: function(): void,
   *            setMode: function(string): void,
   *            seek: function(number): void,
   *            block: function(number, number): Array<object>,
   *            nextBarFrame: function(): {bar: number, beat: number, frame: number},
   *            barLines: function(object): {barFrame: number|null,
   *              nextBarFrame: number|null, bar: number|null},
   *            position: function(): {bar: number, beat: number, sixteenth: number},
   *            isPlaying: function(): boolean}}
   */
  function create(options) {
    const opts = options || {};
    const sampleRate = positive(opts.sampleRate) || DEFAULT_SAMPLE_RATE;

    /** The song, re-read on every `setSong()`. */
    let tracks = [];
    let trackIndex = new Map();
    let clips = new Map();
    /** take id → {id, clip_id, rate, offsetFrames (in this host's frames), discarded}. */
    let takes = new Map();
    /** The timeline's placements, in bar order (see `readPlacements`). */
    let placements = [];
    let framesPerBeat = framesPerBeatFor(sampleRate, DEFAULT_BPM);

    /** Which view the transport plays: the session grid or the timeline. */
    let mode = "session";

    /** The arrangement playhead, in beats from bar 0 (see `seek`). */
    let arrangementBeat = 0;

    /**
     * Whether the next block has to start its audio from the timeline afresh:
     * set by `seek()`, `setMode()` and an arrangement `play()`, where the
     * playhead jumps and no comp segment boundary happens to be there.
     */
    let resync = false;

    /** Transport state. */
    let playing = false;
    let originFrame = null; // absolute frame of beat 0 for this transport run
    let currentFrame = null; // absolute frame just past the last processed block
    let lastFrame = null; // absolute frame of the last processed frame

    /**
     * The object `barLines()` reads the next boundary into, so that answering the
     * performance bus's bar question every block allocates nothing at all.
     */
    const barScratch = { bar: 0, beat: 0, frame: 0 };

    /** track id → [{track_id, clipId, startBeat, endBeat}] in beat order. */
    const segments = new Map();

    /**
     * The sounding notes, `track_id + ":" + p` → entry. An entry holds the note
     * it was started from (so a later song can be checked against it), the
     * segment and loop iteration that owns it, and the frame its off is owed.
     */
    const open = new Map();

    /** Entries closed by a state change: owed an off at frame 0 of the next block. */
    const forced = [];

    /**
     * The sounding audio voices, `track_id + ":" + voice` → entry. The audio
     * twin of `open`: an entry holds the take it plays and the frame its stop
     * is owed at, so a voice is stopped exactly once and never left sounding.
     */
    const openAudio = new Map();

    /** Audio voices a state change closed: owed a stop at frame 0 of the next block. */
    const forcedAudio = [];

    /** track id → the voice its last segment start took, so the next one takes the other. */
    const lastVoice = new Map();

    /**
     * The fades that start inside the block being built, each waiting for the
     * voice that sounds at its first frame (see `placeFades`). Reused like
     * `events`.
     */
    const fadeQueue = [];

    /** The events of the block being built. Reused; a block allocates nothing. */
    const events = [];

    /**
     * The launches applied in the block being built, in block frames. Reused
     * like `events`, and hung off it as a non-enumerable `launches` property:
     * the events array keeps exactly the shape callers already iterate.
     */
    const launches = [];
    Object.defineProperty(events, "launches", {
      value: launches,
      enumerable: false,
      writable: false,
      configurable: false,
    });

    /**
     * Launches scheduled but not yet inside a processed block, in the order
     * they were asked for: `{track_id, clip_id, scene_id, atBeat}`. The
     * boundary frame is derived from `atBeat` when the block is built, so a
     * tempo change moves a scheduled launch with the bars.
     */
    const pending = [];

    // --- song ------------------------------------------------------------

    /**
     * Replace the song. The playhead keeps its beat position (a tempo change
     * rebases the transport), segments whose clip the new song no longer has
     * stop at once, and every sounding note that the new song makes invalid —
     * deleted, moved, shortened, cut by a shorter clip, on a removed track, on
     * a track that became inaudible — is closed at the current frame.
     * @param {object} snapshot the song as `doc.js`'s `snapshot()` returns it
     */
    function setSong(snapshot) {
      const next = readSong(snapshot);

      // Tempo first: everything below measures the playhead in beats, and the
      // rebase is what keeps that measurement unchanged.
      if (playing && originFrame !== null && next.framesPerBeat !== framesPerBeat) {
        rebaseTempo(next.framesPerBeat);
      }

      // The session view keeps the clips it plays across an edit; the
      // arrangement is re-read from the timeline below instead.
      if (mode === "session") {
        for (const [trackId, segs] of segments) {
          if (!next.trackIndex.has(trackId)) {
            segments.delete(trackId);
            continue;
          }
          let kept = 0;
          for (let at = 0; at < segs.length; at += 1) {
            const seg = segs[at];
            if (seg.clipId !== null) {
              const clip = next.clips.get(seg.clipId);
              // A clip that is gone, or that moved to another track, cannot keep
              // sounding here; `reconcile` closes the notes the segment owed.
              if (!clip || clip.track_id !== seg.track_id) continue;
            }
            segs[kept] = seg;
            kept += 1;
          }
          segs.length = kept;
          if (kept === 0) segments.delete(trackId);
        }
      }

      tracks = next.tracks;
      trackIndex = next.trackIndex;
      clips = next.clips;
      takes = next.takes;
      framesPerBeat = next.framesPerBeat;
      placements = next.placements;
      if (mode === "arrangement") {
        rebuildArrangement();
        if (playing) {
          // A rebuild makes new segment objects for everything it had to
          // change. The voices that still hold their placement and their take
          // are pointed at them rather than cut, and the next block starts
          // whatever the new timeline holds at the playhead.
          followVoices(frameNow());
          resync = true;
        }
      }
      prunePending();

      reconcile(currentFrame === null ? 0 : currentFrame);
    }

    /**
     * Rebase the transport onto a new tempo: the beat under the playhead stays
     * the same beat, which moves beat 0 to a new frame. Every open note keeps
     * its off at the beat it was owed, re-mapped through the new tempo.
     * @param {number} nextFramesPerBeat the new frames one beat lasts
     */
    function rebaseTempo(nextFramesPerBeat) {
      const previousFramesPerBeat = framesPerBeat;
      const frameNow = currentFrame === null ? (originFrame === null ? 0 : originFrame) : currentFrame;
      const beatNow = Math.max(0, (frameNow - originFrame) / previousFramesPerBeat);

      originFrame = frameNow - beatNow * nextFramesPerBeat;

      for (const entry of open.values()) {
        entry.offFrame = Math.round(originFrame + entry.offBeat * nextFramesPerBeat);
      }
    }

    /**
     * @param {object} snapshot the song in the shape the header documents
     * @returns {{bpm: number, framesPerBeat: number, tracks: object[], trackIndex: Map, clips: Map}}
     */
    function readSong(snapshot) {
      const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
      const meta = snap.meta && typeof snap.meta === "object" ? snap.meta : {};
      const bpm = positive(meta.bpm) || DEFAULT_BPM;

      const list = [];
      const index = new Map();
      const rawTracks = Array.isArray(snap.tracks) ? snap.tracks : [];
      for (const item of rawTracks) {
        if (!item || typeof item.id !== "string" || item.id === "") continue;
        if (index.has(item.id)) continue;
        index.set(item.id, list.length);
        list.push({ id: item.id, mute: item.mute === true, solo: item.solo === true });
      }

      const byId = new Map();
      const rawClips = snap.clips && typeof snap.clips === "object" ? snap.clips : {};
      for (const id of Object.keys(rawClips)) {
        const clip = readClip(id, rawClips[id]);
        if (clip) byId.set(id, clip);
      }

      const takesById = new Map();
      const rawTakes = snap.takes && typeof snap.takes === "object" ? snap.takes : {};
      for (const id of Object.keys(rawTakes)) {
        const value = rawTakes[id];
        const take = readTake(id, value);
        if (take) takesById.set(id, take);
      }

      attachPatternSteps(byId, snap);

      return {
        bpm: bpm,
        framesPerBeat: framesPerBeatFor(sampleRate, bpm),
        tracks: list,
        trackIndex: index,
        clips: byId,
        takes: takesById,
        placements: readPlacements(snap.arrangement),
      };
    }

    /**
     * Give every pattern clip its patterns: their steps, its chain and the
     * pattern an empty chain falls back to (the FIRST one — the lowest `order`,
     * then the id — so a song whose patterns were written in any order still
     * plays the same one).
     *
     * Each pattern's step list is built once here, sorted and validated, so the
     * block path only ever walks a plain array. A step outside the clip's step
     * positions cannot sound and is dropped. A chain entry that names no
     * pattern of its own clip (the document refuses those, but a song can
     * arrive mid-edit) keeps its place in the chain: its slot is silent and the
     * cycle keeps its length. Only a chain with no pattern left to play at all
     * falls back to the first pattern.
     * @param {Map} clipsById the clips this song was read into
     * @param {object} snapshot the song in the shape `doc.js` writes
     * @returns {void}
     */
    function attachPatternSteps(clipsById, snapshot) {
      const patterns = snapshot.patterns && typeof snapshot.patterns === "object" ? snapshot.patterns : {};
      const steps = snapshot.steps && typeof snapshot.steps === "object" ? snapshot.steps : {};

      /** clip id → the first pattern of that clip. */
      const firstByClip = new Map();
      /** clip id → every pattern id it holds. */
      const idsByClip = new Map();
      /** clip id → pattern id → its steps, sorted below. */
      const listsByClip = new Map();

      for (const key of Object.keys(patterns)) {
        const pattern = patterns[key];
        if (!pattern || typeof pattern !== "object") continue;
        const clipId = typeof pattern.clip_id === "string" ? pattern.clip_id : "";
        if (clipId === "" || !clipsById.has(clipId)) continue;
        const clip = clipsById.get(clipId);
        if (!clip || !clip.pattern) continue;
        const id =
          typeof pattern.id === "string" && pattern.id !== ""
            ? pattern.id
            : String(key).split("/").pop() || String(key);
        const order = Number(pattern.order);
        const entry = { id: id, order: Number.isFinite(order) ? order : 0 };
        const current = firstByClip.get(clipId);
        if (!current || entry.order < current.order || (entry.order === current.order && entry.id < current.id)) {
          firstByClip.set(clipId, entry);
        }
        let ids = idsByClip.get(clipId);
        if (!ids) {
          ids = new Map();
          idsByClip.set(clipId, ids);
        }
        ids.set(id, true);
        let lists = listsByClip.get(clipId);
        if (!lists) {
          lists = new Map();
          listsByClip.set(clipId, lists);
        }
        if (!lists.has(id)) lists.set(id, []);
      }

      for (const key of Object.keys(steps)) {
        const step = steps[key];
        if (!step || typeof step !== "object") continue;
        const clipId = typeof step.clip_id === "string" ? step.clip_id : "";
        const patternId = typeof step.pattern_id === "string" ? step.pattern_id : "";
        const clip = clipId === "" ? null : clipsById.get(clipId);
        if (!clip || !clip.pattern) continue;
        const ids = idsByClip.get(clipId);
        if (!ids || !ids.has(patternId)) continue;

        const at = Math.trunc(Number(step.at));
        if (!Number.isFinite(at) || at < 0 || at >= clip.lengthSteps) continue;
        const index = Math.trunc(Number(step.index));
        if (!Number.isFinite(index) || index < 0) continue;
        const velocity = Math.round(Number(step.v));
        listsByClip.get(clipId).get(patternId).push({
          at: at,
          bank_id: typeof step.bank_id === "string" ? step.bank_id : "",
          index: index,
          v: Number.isFinite(velocity) ? clamp(velocity, 1, 127) : 100,
          locks: step.locks && typeof step.locks === "object" ? step.locks : EMPTY_LOCKS,
        });
      }

      for (const [clipId, clip] of clipsById) {
        if (!clip.pattern) continue;
        const lists = listsByClip.get(clipId);
        if (!lists) {
          // A pattern clip with no patterns at all plays nothing.
          clip.chain = EMPTY_STEPS;
          clip.chainPlays = false;
          continue;
        }
        for (const list of lists.values()) list.sort(byStep);
        const first = firstByClip.get(clipId);
        clip.patternSteps = lists;
        clip.firstPattern = first ? first.id : null;
        // The chain is NOT compacted: an entry naming no pattern of this clip
        // keeps its slot and plays silence there. Only when no entry names a
        // pattern is there no chain to play, and the first pattern stands in.
        clip.chainPlays = clip.chain.some((patternId) => lists.has(patternId));
      }
    }

    /**
     * Read the timeline: the placements that can play, in bar order. A song
     * written before the timeline existed, or one whose arrangement names a
     * track or bar it cannot have, simply has fewer of them.
     * @param {unknown} value the snapshot's `arrangement`
     * @returns {Array<{id: string, track_id: string, clip_id: string,
     *                  start_bar: number, bars: number, offset_beats: number,
     *                  fade_in_beats: number, fade_out_beats: number}>}
     */
    function readPlacements(value) {
      const arrangement = value && typeof value === "object" ? value : {};
      const raw =
        arrangement.placements && typeof arrangement.placements === "object" ? arrangement.placements : {};
      const list = [];
      for (const id of Object.keys(raw)) {
        const item = raw[id];
        if (!item || typeof item !== "object") continue;
        if (typeof item.track_id !== "string" || typeof item.clip_id !== "string") continue;
        const startBar = Number(item.start_bar);
        const bars = Number(item.bars);
        const offset = Number(item.offset_beats);
        if (!Number.isFinite(startBar) || !Number.isFinite(bars) || bars <= 0) continue;
        if (!Number.isFinite(offset) || offset < 0) continue;
        list.push({
          id: typeof item.id === "string" && item.id !== "" ? item.id : id,
          track_id: item.track_id,
          clip_id: item.clip_id,
          start_bar: Math.max(0, Math.trunc(startBar)),
          bars: Math.max(1, Math.trunc(bars)),
          offset_beats: offset,
          fade_in_beats: fadeBeats(item.fade_in_beats),
          fade_out_beats: fadeBeats(item.fade_out_beats),
        });
      }
      list.sort(byStartBar);
      return list;
    }

    /**
     * Read one recorded take: the comp needs its rate (to scale the offset it
     * was recorded with onto this host's frames) and whether a person threw it
     * away. A take without a usable rate is assumed to be at this host's rate.
     * @returns {{id: string, clip_id: string, rate: number, offsetFrames: number, discarded: boolean}|null}
     */
    function readTake(id, value) {
      if (!value || typeof value !== "object") return null;
      const rate = positive(value.rate) || sampleRate;
      const offset = Number(value.offset_frames);
      const offsetFrames = Number.isFinite(offset) ? Math.round(offset) : 0;
      return {
        id: typeof value.id === "string" && value.id !== "" ? value.id : id,
        clip_id: typeof value.clip_id === "string" ? value.clip_id : "",
        rate: rate,
        // The very frame of the take that sounds at clip beat 0 in this host.
        offsetFrames: Math.round((offsetFrames * sampleRate) / rate),
        discarded: value.discarded === true,
      };
    }

    /**
     * Read one clip, dropping the notes that cannot sound and sorting the rest
     * by `t` once — the block path only ever binary-searches this list.
     *
     * A pattern clip's loop is its own `length_steps × step_beats` beats (not
     * the bars the document derives for scene and placement lengths), its swing
     * and its chain are read here, and its steps arrive from
     * `attachPatternSteps`.
     * @returns {{id: string, track_id: string, scene_id: string, lengthBeats: number,
     *            notes: object[], pattern: boolean, stepBeats: number, swing: number,
     *            chain: string[], chainPlays: boolean, firstPattern: string|null,
     *            patternSteps: Map<string, object[]>}|null}
     */
    function readClip(id, value) {
      if (!value || typeof value !== "object") return null;
      const pattern = value.kind === "pattern";
      const bars = positive(value.length_bars);
      const lengthSteps = pattern ? stepPositionsOf(value) : 0;
      const stepBeats = pattern ? stepBeatsOf(value) : 0;
      const lengthBeats = pattern ? lengthSteps * stepBeats : (bars || 1) * BEATS_PER_BAR;

      const notes = [];
      const rawNotes = Array.isArray(value.notes) ? value.notes : [];
      for (const item of rawNotes) {
        if (!item || typeof item !== "object") continue;
        const t = Number(item.t);
        const d = Number(item.d);
        const p = Number(item.p);
        const v = Number(item.v);
        if (!Number.isFinite(t) || !Number.isFinite(d) || !Number.isFinite(p) || !Number.isFinite(v)) continue;
        // A note that starts at or past the loop end, or has no length,
        // cannot sound; dropping it here keeps every later check simple.
        if (t < 0 || d <= 0 || t >= lengthBeats) continue;
        notes.push({ t: t, d: d, p: clamp(Math.round(p), 0, 127), v: clamp(Math.round(v), 1, 127) });
      }
      notes.sort(byStartBeat);

      return {
        id: typeof value.id === "string" && value.id !== "" ? value.id : id,
        track_id: typeof value.track_id === "string" ? value.track_id : "",
        scene_id: typeof value.scene_id === "string" ? value.scene_id : "",
        lengthBeats: lengthBeats,
        audio: value.kind === "audio",
        notes: notes,
        comp: value.kind === "audio" ? readComp(value.comp, lengthBeats) : [],
        pattern: pattern,
        lengthSteps: lengthSteps,
        stepBeats: stepBeats,
        swing: pattern ? swingOf(value) : 0,
        chain: pattern ? chainOf(value) : EMPTY_STEPS,
        chainPlays: false,
        firstPattern: null,
        patternSteps: EMPTY_PATTERN_STEPS,
      };
    }

    /**
     * Read an audio clip's comp: the segments that can sound, in beat order.
     * A segment outside the clip or without a length is dropped here, so the
     * block path never has to check one again.
     * @param {unknown} value
     * @param {number} lengthBeats the clip's length
     * @returns {Array<{take_id: string, from_beat: number, to_beat: number}>}
     */
    function readComp(value, lengthBeats) {
      const parts = [];
      const raw = Array.isArray(value) ? value : [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.take_id !== "string" || item.take_id === "") continue;
        const from = Number(item.from_beat);
        const to = Number(item.to_beat);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        if (from < 0 || to > lengthBeats || !(to > from)) continue;
        parts.push({ take_id: item.take_id, from_beat: from, to_beat: to });
      }
      parts.sort(byFromBeat);
      return parts;
    }

    // --- launch ----------------------------------------------------------

    /**
     * Launch every clip of one scene's row: each track with a clip in that
     * scene plays it, and each track without one stops.
     * @param {string} scene_id
     */
    function launchScene(scene_id) {
      if (mode === "arrangement") return;
      const sceneId = scene_id === null || scene_id === undefined ? "" : String(scene_id);
      if (sceneId === "") return;
      const at = launchBeat();
      for (const track of tracks) {
        const clip = clipFor(track.id, sceneId);
        // Every track of the row is reported, an empty slot included (as a
        // stop): a recording armed on an empty audio slot starts on this
        // very frame, and Record to timeline sees the whole row.
        applyLaunch(track.id, clip ? clip.id : null, sceneId, at, true);
      }
      reconcile(frameNow());
    }

    /**
     * Launch one clip on its own track, replacing whatever that track plays.
     * A clip id the song does not have, or a clip whose track is gone, is
     * ignored.
     * @param {string} clip_id
     */
    function launchClip(clip_id) {
      if (mode === "arrangement") return;
      const clip = clips.get(clip_id === null || clip_id === undefined ? "" : String(clip_id));
      if (!clip) return;
      if (!trackIndex.has(clip.track_id)) return;
      applyLaunch(clip.track_id, clip.id, sceneOf(clip), launchBeat());
      reconcile(frameNow());
    }

    /**
     * Stop one track at the next bar, with offs for its sounding notes.
     * An unknown track id is ignored.
     * @param {string} track_id
     */
    function stopTrack(track_id) {
      if (mode === "arrangement") return;
      const trackId = track_id === null || track_id === undefined ? "" : String(track_id);
      if (!trackIndex.has(trackId)) return;
      // No scene is named: the report falls back to the scene of the clip the
      // stop replaces (see `applyLaunch`).
      applyLaunch(trackId, null, undefined, launchBeat());
      reconcile(frameNow());
    }

    /** Stop every track at the next bar, with offs for their sounding notes. */
    function stopAll() {
      // The session's transport gestures have no meaning on the timeline: its
      // placements, not launches, decide what sounds.
      if (mode === "arrangement") return;
      const at = launchBeat();
      if (!playing || originFrame === null) {
        forceCloseAll(frameNow());
        forceCloseAllAudio();
        segments.clear();
        // Nothing is scheduled any more, so no scheduled launch can land.
        pending.length = 0;
        return;
      }
      for (const track of tracks) {
        if (!segments.has(track.id)) continue;
        applyLaunch(track.id, null, undefined, at);
      }
      // A note (or voice) whose segment was already gone still stops here.
      for (const entry of open.values()) capOff(entry, at);
      for (const entry of openAudio.values()) capAudioOff(entry, at);
      reconcile(frameNow());
    }

    /**
     * Start the transport from its beginning, playing the clips that were
     * sounding, from beat 0. The position resets to 1.1.1.
     */
    function play() {
      if (mode === "arrangement") {
        // The timeline is not armed by launches: it plays wherever the seek
        // bar left it, so every block from here starts from the placement the
        // playhead sits in.
        forceCloseAll(frameNow());
        forceCloseAllAudio();
        segments.clear();
        pending.length = 0;
        rebuildArrangement();
        playing = true;
        originFrame = null;
        currentFrame = null;
        lastFrame = null;
        resync = true;
        return;
      }
      const keep = currentClips();
      forceCloseAll(frameNow());
      forceCloseAllAudio();
      segments.clear();
      for (const [trackId, clipId] of keep) {
        segments.set(trackId, [{ track_id: trackId, clipId: clipId, startBeat: 0, endBeat: null }]);
      }
      keepFirstBarLaunches();
      playing = true;
      originFrame = null;
      currentFrame = null;
      lastFrame = null;
    }

    /**
     * Choose what the transport plays: the session grid (launches arm clips) or
     * the song's arrangement (its placements, on the timeline). Switching
     * closes every sounding note and voice — their offs are owed at frame 0 of
     * the next block — and resets what each track plays, so nothing from the
     * other view survives.
     * @param {"session"|"arrangement"} nextMode anything else means "session"
     */
    function setMode(nextMode) {
      const wanted = nextMode === "arrangement" ? "arrangement" : "session";
      if (wanted === mode) return;
      mode = wanted;
      forceCloseAll(frameNow());
      forceCloseAllAudio();
      pending.length = 0;
      segments.clear();
      if (mode === "arrangement") rebuildArrangement();
      if (playing) {
        // The playhead goes back to the start of the new view's timeline.
        originFrame = null;
        lastFrame = null;
        resync = true;
      }
      reconcile(frameNow());
    }

    /**
     * Move the arrangement playhead to a bar: the next block plays from that
     * bar, and the notes and voices that were sounding are closed first. A
     * seek while the transport is stopped only moves the bar `play()` starts
     * from, and a seek in the session view only stores the bar: the session's
     * transport, its sounding notes and its scheduled launches are none of a
     * timeline seek's business.
     * @param {number} bar the 0-based bar; anything below 0 is bar 0
     */
    function seek(bar) {
      const value = Number(bar);
      if (!Number.isFinite(value)) return;
      arrangementBeat = Math.max(0, Math.trunc(value)) * BEATS_PER_BAR;
      if (mode !== "arrangement") return;
      forceCloseAll(frameNow());
      forceCloseAllAudio();
      pending.length = 0;
      rebuildArrangement();
      if (playing) {
        // The next block re-anchors beat 0 so that the playhead sits on the bar
        // that was asked for, and starts the takes the timeline holds there.
        originFrame = null;
        lastFrame = null;
        resync = true;
      }
      reconcile(frameNow());
    }

    /**
     * Build the tracks' playback segments from the song's arrangement.
     *
     * One segment per placement, except that two adjacent placements of one
     * clip whose clip time continues exactly — the two halves
     * `arrangement.split` makes — are joined into one: that is what makes a
     * split inaudible. "Exactly" is measured on the cycle the clip actually
     * plays, which for a pattern clip is its chain's whole length: two
     * adjacent placements that each start at offset 0 restart the chain (a, a),
     * they do not carry on into its second pattern (a, b). A seam either side
     * fades at is never joined: those two halves need two voices, one ramping
     * down at the seam and one starting clean after it.
     *
     * A segment is reused from the previous build when nothing it depends on
     * changed, so a song update that touches something else does not cut the
     * notes it is playing (their open entries hold their segment).
     */
    function rebuildArrangement() {
      const reuse = new Map();
      for (const segs of segments.values()) {
        for (const seg of segs) {
          if (typeof seg.key === "string") reuse.set(seg.key, seg);
        }
      }

      /** track id → the segments built for it so far, in bar order. */
      const built = new Map();
      for (const placement of placements) {
        if (!trackIndex.has(placement.track_id)) continue;
        const clip = clips.get(placement.clip_id);
        if (!clip || !(clip.lengthBeats > 0)) continue;

        const start = placement.start_bar * BEATS_PER_BAR;
        const end = start + placement.bars * BEATS_PER_BAR;
        let list = built.get(placement.track_id);
        if (!list) {
          list = [];
          built.set(placement.track_id, list);
        }

        const previous = list.length > 0 ? list[list.length - 1] : null;
        // A fade at the seam means the two halves have to be two voices: the
        // earlier one ramps down on its own voice and the later one starts
        // clean, so joining them would fade the second half into silence.
        // Fades only apply to audio placements; a note clip keeps its split.
        const seamFades =
          previous !== null &&
          clip.audio &&
          (previous.parts[previous.parts.length - 1].fade_out_beats > 0 || placement.fade_in_beats > 0);
        if (
          previous &&
          !seamFades &&
          previous.clipId === clip.id &&
          previous.endBeat === start &&
          continuesClip(previous, placement, cycleBeatsOf(clip))
        ) {
          previous.endBeat = end;
          previous.parts.push(placement);
          continue;
        }

        list.push({
          key: null,
          track_id: placement.track_id,
          clipId: clip.id,
          // The beat at which clip beat 0 of the first loop iteration sits: a
          // placement starting at `offset_beats` into its clip began earlier.
          startBeat: start - placement.offset_beats,
          // Nothing of the placement sounds before it actually starts.
          audibleFrom: start,
          endBeat: end,
          parts: [placement],
          fades: null,
        });
      }

      segments.clear();
      for (const [trackId, list] of built) {
        const segs = [];
        for (const seg of list) {
          const key = segmentKey(seg);
          const kept = reuse.get(key);
          if (kept) {
            segs.push(kept);
            continue;
          }
          const clip = clips.get(seg.clipId);
          seg.key = key;
          seg.fades = clip && clip.audio ? fadesOf(seg.parts) : [];
          segs.push(seg);
        }
        if (segs.length > 0) segments.set(trackId, segs);
      }
    }

    /**
     * @param {object} clip a clip a segment plays
     * @returns {number} the beats one whole cycle of it lasts: a pattern clip
     *   cycles on its chain (a silent entry still takes its slot), every other
     *   clip on its own length
     */
    function cycleBeatsOf(clip) {
      const slots = cycleOf(clip).length;
      return clip.lengthBeats * (slots > 0 ? slots : 1);
    }

    /**
     * @param {object} seg a segment built from its placements
     * @param {object} placement the next placement on that track
     * @param {number} cycleBeats the beats one cycle of the clip lasts
     * @returns {boolean} whether the next placement continues the clip exactly
     *   where the segment stops (the two halves of a split do)
     */
    function continuesClip(seg, placement, cycleBeats) {
      const atEnd = wrapBeats(seg.endBeat - seg.startBeat, cycleBeats);
      const atStart = wrapBeats(placement.offset_beats, cycleBeats);
      return Math.abs(atEnd - atStart) < EPSILON_BEATS;
    }

    /**
     * @param {object} seg a segment built from its placements
     * @returns {string} a key that changes whenever anything the segment plays
     *   changes, so an unchanged segment is reused across song updates
     */
    function segmentKey(seg) {
      const parts = [];
      for (const part of seg.parts) {
        parts.push(
          [
            part.id,
            part.clip_id,
            part.track_id,
            part.start_bar,
            part.bars,
            part.offset_beats,
            part.fade_in_beats,
            part.fade_out_beats,
          ].join(":"),
        );
      }
      return seg.track_id + "|" + parts.join("+");
    }

    /**
     * The linear fades a segment plays, in the order they start: each of its
     * placements' fade in at its own start and its fade out before its own end.
     * @param {object[]} parts the placements the segment is made of
     * @returns {Array<{beat: number, from: number, to: number, beats: number}>}
     */
    function fadesOf(parts) {
      const fades = [];
      for (const part of parts) {
        const start = part.start_bar * BEATS_PER_BAR;
        const end = start + part.bars * BEATS_PER_BAR;
        if (part.fade_in_beats > 0) {
          fades.push({ beat: start, from: 0, to: 1, beats: part.fade_in_beats });
        }
        if (part.fade_out_beats > 0) {
          fades.push({ beat: end - part.fade_out_beats, from: 1, to: 0, beats: part.fade_out_beats });
        }
      }
      fades.sort(byFadeBeat);
      return fades;
    }

    /**
     * Collect the fades of one segment that start inside this block. They are
     * placed on the voice that sounds at the fade's own first frame, which is
     * only known once every comp boundary of this block has been laid down, so
     * `placeFades()` runs after the segment loop (see the header).
     * @param {object} seg
     * @param {number} frameStart
     * @param {number} frames
     */
    function queueFades(seg, frameStart, frames) {
      const fades = seg.fades;
      if (!fades || fades.length === 0) return;
      const frameEnd = frameStart + frames;
      for (let at = 0; at < fades.length; at += 1) {
        const fade = fades[at];
        const length = Math.round(fade.beats * framesPerBeat);
        if (!(length > 0)) continue;
        const frame = beatToFrame(fade.beat);
        if (frame < frameStart || frame >= frameEnd) continue;
        fadeQueue.push({
          track_id: seg.track_id,
          fade: fade,
          frame: frame,
          from: fade.from,
          to: fade.to,
          frames: length,
        });
      }
    }

    /**
     * Emit the fades collected this block, each on the voice that sounds at its
     * first frame. A comp boundary inside a fade out moves the rest of the ramp
     * to the voice that plays on, which is why the voice is looked up here
     * instead of remembered from the last start.
     * @param {number} frameStart
     */
    function placeFades(frameStart) {
      for (let at = 0; at < fadeQueue.length; at += 1) {
        const item = fadeQueue[at];
        const voice = voiceSoundingAt(item.track_id, item.frame);
        if (voice === null) continue;
        events.push({
          frame: item.frame - frameStart,
          track_id: item.track_id,
          type: "fade",
          voice: voice,
          from: item.from,
          to: item.to,
          frames: item.frames,
        });
      }
      fadeQueue.length = 0;
    }

    /**
     * Give a voice that starts inside a fade window the rest of that ramp: the
     * gain the window holds at its first frame becomes the ramp's `from` and
     * what is left of the window its `frames`.
     * @param {object} seg the segment the voice plays
     * @param {number} voice the voice it starts on
     * @param {number} startFrame the absolute frame it starts at
     * @param {number} frameStart the block's first frame
     */
    function emitFadeAtStart(seg, voice, startFrame, frameStart) {
      const fades = seg.fades;
      if (!fades || fades.length === 0) return;
      for (let at = 0; at < fades.length; at += 1) {
        const fade = fades[at];
        const length = Math.round(fade.beats * framesPerBeat);
        if (!(length > 0)) continue;
        const fadeFrame = beatToFrame(fade.beat);
        // A window that starts at (or after) this frame belongs to the voice
        // that sounds then: `queueFades()`/`startAudio()` of that start places
        // it, so this one only takes the windows already running.
        if (fadeFrame >= startFrame) continue;
        const remaining = fadeFrame + length - startFrame;
        if (!(remaining > 0)) continue;
        events.push({
          frame: startFrame - frameStart,
          track_id: seg.track_id,
          type: "fade",
          voice: voice,
          from: fadeGainAt(fade, startFrame, length),
          to: fade.to,
          frames: remaining,
        });
      }
    }

    /**
     * @param {{beat: number, from: number, to: number, beats: number}} fade
     * @param {number} frame the absolute frame to read
     * @param {number} length the fade's length in frames
     * @returns {number} the gain the linear ramp holds at that frame
     */
    function fadeGainAt(fade, frame, length) {
      const passed = frame - beatToFrame(fade.beat);
      if (passed <= 0) return fade.from;
      if (passed >= length) return fade.to;
      return fade.from + ((fade.to - fade.from) * passed) / length;
    }

    /**
     * @param {string} trackId
     * @param {number} frame an absolute frame
     * @returns {number|null} the voice of that track which sounds at that frame,
     *   the one that started last when two are crossfading
     */
    function voiceSoundingAt(trackId, frame) {
      let found = null;
      for (const entry of openAudio.values()) {
        if (entry.track_id !== trackId) continue;
        if (entry.startFrame > frame) continue;
        if (entry.offFrame <= frame) continue;
        if (found === null || entry.startFrame >= found.startFrame) found = entry;
      }
      return found === null ? null : found.voice;
    }

    /**
     * Keep the voices the timeline still holds after a rebuild: one whose
     * placement and take still cover the playhead is pointed at the segment the
     * rebuild made for it (so a fade or a name change does not cut it), and one
     * whose placement, take or clip changed is closed, so the next block starts
     * the take the new timeline has there.
     * @param {number} frameStart the frame the playhead sits at
     */
    function followVoices(frameStart) {
      if (openAudio.size === 0) return;
      const soloMode = anySoloed();
      const beat = (frameStart - originFrame) / framesPerBeat;
      for (const entry of Array.from(openAudio.values())) {
        const segs = segments.get(entry.track_id);
        const clip = clips.get(entry.clipId);
        const take = takes.get(entry.takeId);
        const seg = segs ? audibleSegment(segs, beat) : null;
        const holding =
          seg !== null &&
          seg.clipId === entry.clipId &&
          clip !== undefined &&
          clip.audio &&
          clip.lengthBeats > 0 &&
          audible(entry.track_id, soloMode) &&
          !(take && take.discarded);
        const at = holding ? clipPositionAt(seg, clip, beat) : null;
        const part = at === null ? null : compPartAt(clip, entry.takeId, at.clipBeat);
        if (!part) {
          forceCloseAudio(entry, frameStart);
          continue;
        }
        const segEndBeat = seg.endBeat === null ? Infinity : seg.endBeat;
        entry.seg = seg;
        entry.clipId = clip.id;
        entry.fromBeat = part.from_beat;
        entry.loopStart = at.loopStart;
        entry.offBeat = Math.min(at.loopStart + part.to_beat, segEndBeat);
        entry.offFrame = beatToFrame(entry.offBeat);
        // The take frame it is already reading stays: the voice plays on.
      }
    }

    /**
     * @param {object} clip an audio clip
     * @param {string} takeId
     * @param {number} clipBeat how far into the clip the playhead sits
     * @returns {object|null} the comp segment of that take holding that beat
     */
    function compPartAt(clip, takeId, clipBeat) {
      const parts = clip.comp;
      for (let at = 0; at < parts.length; at += 1) {
        const part = parts[at];
        if (part.take_id !== takeId) continue;
        if (part.from_beat <= clipBeat && clipBeat < part.to_beat) return part;
      }
      return null;
    }

    /**
     * Where a playhead sits inside the clip a segment plays.
     * @param {object} seg
     * @param {object} clip
     * @param {number} beat the transport beat of the playhead
     * @returns {{loopStart: number, clipBeat: number}} the beat that loop
     *   iteration started at, and how far into the clip the playhead is
     */
    function clipPositionAt(seg, clip, beat) {
      let loop = Math.max(0, Math.floor((beat - seg.startBeat) / clip.lengthBeats));
      let loopStart = seg.startBeat + loop * clip.lengthBeats;
      let clipBeat = beat - loopStart;
      // A playhead a hair below a loop boundary belongs to the next pass.
      if (clipBeat >= clip.lengthBeats - EPSILON_BEATS) {
        loop += 1;
        loopStart += clip.lengthBeats;
        clipBeat = beat - loopStart;
      }
      if (clipBeat < 0) clipBeat = 0;
      return { loopStart: loopStart, clipBeat: clipBeat };
    }

    /**
     * Start the takes the timeline holds at this block's first frame: after a
     * seek, a mode switch or an arrangement `play()`, nothing is sounding yet,
     * and a placement's comp segment need not begin on the frame the playhead
     * landed on. Every audible audio track plays the comp segment the playhead
     * sits in, from the take frame that belongs to that position.
     * @param {number} frameStart
     */
    function resyncArrangement(frameStart) {
      const soloMode = anySoloed();
      const beat = (frameStart - originFrame) / framesPerBeat;
      for (const segs of segments.values()) {
        if (segs.length === 0) continue;
        // The placement the playhead is IN: a placement that starts part-way
        // into its clip has a segment beginning before it is audible, so the
        // segment with the highest start beat behind the playhead can be one
        // whose own bars have not begun yet.
        const seg = audibleSegment(segs, beat);
        if (!seg || seg.clipId === null) continue;
        if (!audible(seg.track_id, soloMode)) continue;
        const clip = clips.get(seg.clipId);
        if (!clip || !clip.audio || !(clip.lengthBeats > 0)) continue;

        const at = clipPositionAt(seg, clip, beat);
        const segEndBeat = seg.endBeat === null ? Infinity : seg.endBeat;
        for (let index = 0; index < clip.comp.length; index += 1) {
          const part = clip.comp[index];
          if (!(part.from_beat <= at.clipBeat && at.clipBeat < part.to_beat)) continue;
          const stopBeat = Math.min(at.loopStart + part.to_beat, segEndBeat);
          if (!(stopBeat > beat)) continue;
          startAudio(seg, clip, part, at.loopStart, at.clipBeat, stopBeat, frameStart, frameStart);
        }
      }
    }

    /**
     * Stop the transport: every sounding note gets its off at the current
     * frame, the position returns to 1.1.1, and the sounding clips stay armed
     * for the next `play()`.
     */
    function stop() {
      if (mode === "arrangement") {
        // The seek bar is kept, so `play()` picks the timeline up there again.
        forceCloseAll(frameNow());
        forceCloseAllAudio();
        playing = false;
        originFrame = null;
        lastFrame = null;
        return;
      }
      const keep = currentClips();
      forceCloseAll(frameNow());
      forceCloseAllAudio();
      segments.clear();
      for (const [trackId, clipId] of keep) {
        segments.set(trackId, [{ track_id: trackId, clipId: clipId, startBeat: 0, endBeat: null }]);
      }
      keepFirstBarLaunches();
      playing = false;
      originFrame = null;
      lastFrame = null;
    }

    /**
     * Apply one launch and remember to report it.
     *
     * The report is made when the block that holds the boundary frames is
     * built, so a launch that changes nothing — the track already plays that
     * clip, or a stop for a track that is already silent — is not reported.
     * @param {string} trackId
     * @param {string|null} clipId the clip to play, `null` to stop
     * @param {string|null|undefined} sceneId the scene being launched, or
     *   `undefined` to fall back to the scene of the clip being replaced
     * @param {number} atBeat the boundary the launch takes effect at
     */
    function applyLaunch(trackId, clipId, sceneId, atBeat, always = false) {
      const segs = segments.get(trackId);
      const replaced = segs ? clipAtBeat(segs, atBeat) : null;
      scheduleAt(trackId, clipId, atBeat);
      const applied = clipAtBeat(segmentsOf(trackId), atBeat);
      if (applied === replaced && !always) return;

      let scene = sceneId;
      if (scene === undefined || scene === null) {
        // A stop names no scene of its own, so the report carries the one of
        // the clip it replaced; a track that played nothing has none.
        const replacedClip = replaced === null ? null : clips.get(replaced);
        scene = replacedClip ? sceneOf(replacedClip) : null;
      }
      // A launch for a boundary that has not been reached yet supersedes the
      // one already waiting for it on this track: only the launch the track
      // actually ends up playing took effect.
      for (let at = pending.length - 1; at >= 0; at -= 1) {
        if (pending[at].track_id === trackId && pending[at].atBeat === atBeat) pending.splice(at, 1);
      }
      pending.push({ track_id: trackId, clip_id: applied, scene_id: scene, atBeat: atBeat });
    }

    /**
     * Report the launches whose boundary frame falls inside this block.
     * @param {number} frameStart
     * @param {number} frames
     */
    function reportLaunches(frameStart, frames) {
      // Nothing takes effect while the transport is not running: a launch for
      // bar 0 waits for the block that actually starts it.
      if (pending.length === 0 || !playing || originFrame === null) return;
      const frameEnd = frameStart + frames;
      let kept = 0;
      for (let at = 0; at < pending.length; at += 1) {
        const entry = pending[at];
        const frame = beatToFrame(entry.atBeat);
        if (frame >= frameEnd) {
          pending[kept] = entry;
          kept += 1;
          continue;
        }
        launches.push({
          track_id: entry.track_id,
          clip_id: entry.clip_id,
          scene_id: entry.scene_id === undefined ? null : entry.scene_id,
          bar: Math.round(entry.atBeat / BEATS_PER_BAR),
          // A boundary the transport has already gone past (a tempo change can
          // bring one forward) takes effect at the block's first frame.
          frame: frame <= frameStart ? 0 : frame - frameStart,
        });
      }
      pending.length = kept;
      if (launches.length > 1) launches.sort(byLaunchFrame);
    }

    /**
     * Drop the scheduled launches that have no target in the song any more.
     */
    function prunePending() {
      if (pending.length === 0) return;
      let kept = 0;
      for (let at = 0; at < pending.length; at += 1) {
        const entry = pending[at];
        if (!trackIndex.has(entry.track_id)) continue;
        if (entry.clip_id !== null && !clips.has(entry.clip_id)) continue;
        pending[kept] = entry;
        kept += 1;
      }
      pending.length = kept;
    }

    /**
     * Keep only the launches scheduled for bar 0: `play()` and `stop()` both
     * put the playhead back at beat 0, so those are the only boundaries that
     * still exist. A bar-0 launch is reported in the block that starts the new
     * run.
     */
    function keepFirstBarLaunches() {
      if (pending.length === 0) return;
      let kept = 0;
      for (let at = 0; at < pending.length; at += 1) {
        if (pending[at].atBeat !== 0) continue;
        pending[kept] = pending[at];
        kept += 1;
      }
      pending.length = kept;
    }

    /**
     * Where one track's clip stands in beat order. Clips scheduled for a
     * later bar are removed; the one playing right now is closed at `atBeat`
     * (its sounding notes get an off there) and the new one starts at it.
     * @param {string} trackId
     * @param {string|null} clipId
     * @param {number} atBeat
     */
    function scheduleAt(trackId, clipId, atBeat) {
      const segs = segmentsOf(trackId);
      for (let at = segs.length - 1; at >= 0; at -= 1) {
        if (segs[at].startBeat >= atBeat) segs.splice(at, 1);
      }
      const last = segs.length > 0 ? segs[segs.length - 1] : null;
      if (last && (last.endBeat === null || last.endBeat > atBeat)) closeSegment(last, atBeat);
      segs.push({
        track_id: trackId,
        clipId: clipId === null ? null : String(clipId),
        startBeat: atBeat,
        endBeat: null,
      });
    }

    /**
     * End one segment at a beat: every note it still sounds is capped there,
     * or closed at once when the boundary has already gone by.
     * @param {object} seg the segment to end
     * @param {number} atBeat
     */
    function closeSegment(seg, atBeat) {
      seg.endBeat = atBeat;
      if (!playing || originFrame === null) return;
      const atFrame = beatToFrame(atBeat);
      const now = frameNow();
      for (const entry of open.values()) {
        if (entry.seg !== seg) continue;
        if (atFrame <= now) forceClose(entry, atFrame);
        else capOff(entry, atBeat);
      }
      for (const entry of openAudio.values()) {
        if (entry.seg !== seg) continue;
        if (atFrame <= now) forceCloseAudio(entry, atFrame);
        else capAudioOff(entry, atBeat);
      }
    }

    /**
     * The one check every state change runs: a sounding note survives only if
     * the same clip still plays on its track, the note (`t`, `d`, `p`) is
     * still in that clip, and the track is still audible. Survivors have their
     * off re-derived from the song as it is now (a shorter clip or loop end
     * may have moved it earlier); everything else is closed at `atFrame`.
     * @param {number} atFrame the frame a closed note's off is owed at
     */
    function reconcile(atFrame) {
      reconcileAudio(atFrame);
      if (open.size === 0) return;
      const soloMode = anySoloed();
      const beat = currentBeat();

      for (const entry of open.values()) {
        const clip = clips.get(entry.clipId);
        if (!stillSounding(entry, clip, soloMode, beat)) {
          forceClose(entry, atFrame);
          continue;
        }

        let offBeat = entry.loopStart + entry.t + entry.d;
        const loopEnd = entry.loopStart + clip.lengthBeats;
        if (loopEnd < offBeat) offBeat = loopEnd;
        if (entry.seg.endBeat !== null && entry.seg.endBeat < offBeat) offBeat = entry.seg.endBeat;
        entry.offBeat = offBeat;
        entry.offFrame = beatToFrame(offBeat);

        // A clip that got shorter can leave the note's whole tail behind the
        // playhead; it stops where the playhead is.
        if (entry.offFrame <= atFrame) forceClose(entry, atFrame);
      }
    }

    /**
     * The audio twin of `reconcile`: a sounding voice survives only while its
     * clip still plays on its track, its take is still not discarded, and its
     * comp segment is still there (with the same start; a segment that only
     * got shorter pulls its stop forward instead of closing it).
     * @param {number} atFrame the frame a closed voice's stop is owed at
     */
    function reconcileAudio(atFrame) {
      if (openAudio.size === 0) return;
      for (const entry of openAudio.values()) {
        const clip = clips.get(entry.clipId);
        const segs = segments.get(entry.track_id);
        const take = takes.get(entry.takeId);
        const alive =
          clip !== undefined &&
          clip.audio &&
          entry.seg.clipId === entry.clipId &&
          segs !== undefined &&
          segs.indexOf(entry.seg) !== -1 &&
          !(take && take.discarded);
        const part = alive ? compPartOf(clip, entry) : null;
        if (!part) {
          forceCloseAudio(entry, atFrame);
          continue;
        }
        const partEnd = entry.loopStart + part.to_beat;
        const segEnd = entry.seg.endBeat === null ? Infinity : entry.seg.endBeat;
        capAudioOff(entry, Math.min(partEnd, segEnd));
      }
    }

    /**
     * @returns {object|null} the comp segment an open voice is playing, matched
     *   by take and start beat (its length may have changed since)
     */
    function compPartOf(clip, entry) {
      const parts = clip.comp;
      for (let at = 0; at < parts.length; at += 1) {
        if (parts[at].take_id === entry.takeId && parts[at].from_beat === entry.fromBeat) return parts[at];
      }
      return null;
    }

    /**
     * @returns {boolean} whether a sounding note is still part of the song
     */
    function stillSounding(entry, clip, soloMode, beat) {
      if (!clip || clip.lengthBeats <= 0) return false;
      if (clip.track_id !== entry.track_id) return false;
      if (!audible(entry.track_id, soloMode)) return false;

      const seg = entry.seg;
      if (seg.clipId !== entry.clipId) return false;
      if (seg.startBeat > beat) return false;
      if (seg.endBeat !== null && seg.endBeat <= beat) return false;

      const segs = segments.get(entry.track_id);
      if (!segs || segs.indexOf(seg) === -1) return false;

      return hasNote(clip.notes, entry.t, entry.d, entry.p);
    }

    /**
     * @returns {boolean} whether a clip still holds a note with these values
     */
    function hasNote(notes, t, d, p) {
      for (let at = lowerBound(notes, t); at < notes.length; at += 1) {
        const note = notes[at];
        if (note.t !== t) return false;
        if (note.d === d && note.p === p) return true;
      }
      return false;
    }

    /** @returns {number} the bar boundary a launch takes effect at, in beats. */
    function launchBeat() {
      if (!playing || originFrame === null) return 0;
      return nextBarFrom(frameNow(), originFrame, framesPerBeat).beat;
    }

    /**
     * The next bar boundary from the transport position right now, in this
     * sequencer's own frames — the answer to a host's `nextBarFrame` request.
     *
     * While the transport runs it is the boundary the next launch would take
     * effect at (the same rounding `launchBeat` uses). While it is stopped, or
     * before its first block, bar 0 starts at the next block's first frame.
     * @returns {{bar: number, beat: number, frame: number}} `bar` is 0-based
     */
    function nextBarFrame() {
      if (playing && originFrame !== null) {
        return nextBarFrom(frameNow(), originFrame, framesPerBeat);
      }
      // Stopped: the bar the playhead would start at — bar 0 in the session,
      // the seek bar on the timeline.
      const beat = originBeat();
      return { bar: Math.round(beat / BEATS_PER_BAR), beat: beat, frame: frameNow() };
    }

    /**
     * Fill a caller's own object with the bar lines around the playhead, in this
     * sequencer's own frames, WITHOUT allocating one: a host that reads them on
     * every block (the performance bus's looper quantizes to them) must not make
     * garbage on the audio thread.
     *
     * `barFrame` is the line the playhead is inside and `nextBarFrame` the next
     * line at or after the next block's first frame, both from the very same
     * rounding `nextBarFrom` applies. The previous line is therefore never a
     * rounded difference — `round(origin + bar * barFrames) - barFrames` is a
     * frame away from `round(origin + (bar - 1) * barFrames)` at a fractional
     * frames-per-beat, which would start a quantized command off the grid.
     *
     * A stopped transport (or one that has not run yet) has no grid at all, so
     * both answers are null: there is no bar for a command to wait for.
     * @param {{barFrame: number|null, nextBarFrame: number|null, bar: number|null}} target
     * @returns {object} the same object, filled in
     */
    function barLines(target) {
      const out = target && typeof target === "object" ? target : {};
      if (!playing || originFrame === null) {
        out.barFrame = null;
        out.nextBarFrame = null;
        out.bar = null;
        return out;
      }
      const barFrames = BEATS_PER_BAR * framesPerBeat;
      const frame = frameNow();
      const next = nextBarInto(barScratch, frame, originFrame, framesPerBeat);
      out.bar = next.bar;
      out.nextBarFrame = next.frame;
      if (next.frame <= frame || next.bar < 1) {
        out.barFrame = Math.round(originFrame + next.bar * barFrames);
      } else {
        out.barFrame = Math.round(originFrame + (next.bar - 1) * barFrames);
      }
      return out;
    }

    // --- block -----------------------------------------------------------

    /**
     * One block of audio: the note and audio events whose frame falls inside it.
     * @param {number} frameStart absolute frame of the block's first frame
     * @param {number} frames how many frames the block holds
     * @returns {Array<{frame: number, track_id: string, type: string,
     *                  p?: number, v?: number, take_id?: string,
     *                  take_frame?: number, voice?: number}>} events in
     *   block-relative frames, sorted by frame with the stops ("off",
     *   "audio_stop") before the starts at one frame. The array also carries
     *   this block's launch reports as a non-enumerable `launches` property
     *   (see the header).
     */
    function block(frameStart, frames) {
      const start = Math.trunc(Number(frameStart));
      const count = Math.trunc(Number(frames));
      launches.length = 0;
      if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) {
        events.length = 0;
        return events;
      }

      if (playing) {
        // Beat 0 of the transport sits on the timeline's bar 0 in session mode
        // and on the arrangement playhead's beat in arrangement mode — which is
        // what makes `position()` and the bar boundaries read the timeline's
        // own bars after a seek.
        if (originFrame === null) originFrame = start - originBeat() * framesPerBeat;
        if (currentFrame === null || start > currentFrame) currentFrame = start;
      }

      const out = emitBlock(start, count);
      currentFrame = start + count;
      lastFrame = start + count - 1;
      return out;
    }

    /**
     * @returns {object[]} the events inside [frameStart, frameStart + frames)
     */
    function emitBlock(frameStart, frames) {
      events.length = 0;
      fadeQueue.length = 0;
      const frameEnd = frameStart + frames;

      emitForced();

      if (playing && originFrame !== null) {
        pruneEndedSegments(frameStart);

        // A playhead that jumped (a seek, a mode switch, an arrangement play)
        // starts the takes the timeline holds where it landed, before the
        // block's own comp boundaries are looked for.
        if (resync) {
          resync = false;
          if (mode === "arrangement") resyncArrangement(frameStart);
        }

        const soloMode = anySoloed();
        const beatFrom = (frameStart - originFrame) / framesPerBeat;
        const beatTo = (frameEnd - originFrame) / framesPerBeat;
        // One frame, plus the epsilon: the window is in beats, the events in
        // rounded frames, so the note search must look slightly wider.
        const slack = 1 / framesPerBeat + EPSILON_BEATS;

        for (const segs of segments.values()) {
          if (segs.length === 0) continue;
          if (!audible(segs[0].track_id, soloMode)) continue;

          for (let at = 0; at < segs.length; at += 1) {
            const seg = segs[at];
            if (seg.clipId === null) continue;
            const clip = clips.get(seg.clipId);
            if (!clip || clip.lengthBeats <= 0) continue;

            const segEndBeat = seg.endBeat === null ? Infinity : seg.endBeat;
            const segEndFrame = seg.endBeat === null ? Infinity : beatToFrame(seg.endBeat);
            const winStart = beatFrom > seg.startBeat ? beatFrom : seg.startBeat;
            const winEnd = beatTo < segEndBeat ? beatTo : segEndBeat;
            if (!(winEnd > winStart)) continue;

            const length = clip.lengthBeats;
            const notes = clip.notes;
            // One loop iteration either side of the window: the window is
            // measured in beats and the events in rounded frames.
            const first = Math.max(0, Math.floor((winStart - seg.startBeat) / length) - 1);
            const last = Math.floor((winEnd - seg.startBeat) / length) + 1;

            if (clip.audio) {
              emitAudio(seg, clip, first, last, segEndBeat, frameStart, frameEnd);
              queueFades(seg, frameStart, frames);
              continue;
            }

            if (clip.pattern) {
              emitPads(seg, clip, first, last, segEndBeat, segEndFrame, frameStart, frameEnd);
              continue;
            }

            for (let loop = first; loop <= last; loop += 1) {
              const loopStart = seg.startBeat + loop * length;
              if (loopStart >= segEndBeat) break;
              const loopEnd = loopStart + length;
              const low = winStart - loopStart - slack;
              const high = winEnd - loopStart + slack;

              for (let index = lowerBound(notes, low); index < notes.length; index += 1) {
                const note = notes[index];
                if (note.t > high) break;

                const onBeat = loopStart + note.t;
                // A placement that starts part-way into its clip does not
                // start the notes that began before it: they were already
                // sounding when the playhead got here, or never were.
                if (seg.audibleFrom !== undefined && onBeat < seg.audibleFrom - EPSILON_BEATS) continue;
                const onFrame = beatToFrame(onBeat);
                if (onFrame < frameStart || onFrame >= frameEnd) continue;
                // The same frame rule a segment's off uses, so a note that
                // would start at the segment's last frame is not started.
                if (onFrame >= segEndFrame) continue;

                let offBeat = onBeat + note.d;
                if (loopEnd < offBeat) offBeat = loopEnd;
                if (segEndBeat < offBeat) offBeat = segEndBeat;
                if (offBeat <= onBeat) continue;

                startNote(seg.track_id, note, seg, loopStart, offBeat, onFrame, frameStart);
              }
            }
          }
        }

        // Every comp boundary of this block has been laid down, so the fades
        // that start inside it can go to the voice that sounds then.
        placeFades(frameStart);
      }

      // Offs come from the open set alone. One that fell before this block was
      // owed but not emitted yet — the transport was stopped, or the host
      // skipped frames — so it is paid at frame 0 rather than dropped.
      for (const entry of open.values()) {
        if (entry.offFrame >= frameEnd) continue;
        open.delete(entry.key);
        events.push({
          frame: entry.offFrame <= frameStart ? 0 : entry.offFrame - frameStart,
          track_id: entry.track_id,
          type: "off",
          p: entry.p,
          v: entry.v,
        });
      }

      // An audio voice stops where its comp segment ends, exactly like a note's
      // off, and one that fell behind is paid at frame 0 rather than dropped.
      for (const entry of openAudio.values()) {
        if (entry.offFrame >= frameEnd) continue;
        openAudio.delete(entry.key);
        events.push({
          frame: entry.offFrame <= frameStart ? 0 : entry.offFrame - frameStart,
          track_id: entry.track_id,
          type: "audio_stop",
          voice: entry.voice,
        });
      }

      events.sort(compareEvents);
      // The launches this block applied, reported after the notes they brought
      // in: a host posts them as they are, so their offsets are framed against
      // the very block start the events use.
      reportLaunches(frameStart, frames);
      return events;
    }

    /**
     * Emit the offs a state change owes, at frame 0 of this block.
     */
    function emitForced() {
      if (forced.length === 0 && forcedAudio.length === 0) return;
      for (const entry of forced) {
        events.push({ frame: 0, track_id: entry.track_id, type: "off", p: entry.p, v: entry.v });
      }
      forced.length = 0;
      for (const stop of forcedAudio) {
        events.push({ frame: 0, track_id: stop.track_id, type: "audio_stop", voice: stop.voice });
      }
      forcedAudio.length = 0;
    }

    /**
     * Emit the audio events of one audio clip's segments inside this block:
     * one start per comp segment whose first frame falls in it. The stop is
     * owed through the open set below, so a segment that also ends in this
     * block still leaves in the right order.
     * @param {object} seg the track's segment playing the clip
     * @param {object} clip an audio clip
     * @param {number} first the first loop iteration to look at
     * @param {number} last the last loop iteration to look at
     * @param {number} segEndBeat the beat the segment is cut at (`Infinity` for none)
     * @param {number} frameStart
     * @param {number} frameEnd
     */
    function emitAudio(seg, clip, first, last, segEndBeat, frameStart, frameEnd) {
      const parts = clip.comp;
      for (let loop = first; loop <= last; loop += 1) {
        const loopStart = seg.startBeat + loop * clip.lengthBeats;
        if (loopStart >= segEndBeat) break;
        for (let at = 0; at < parts.length; at += 1) {
          const part = parts[at];
          let startBeat = loopStart + part.from_beat;
          let clipBeat = part.from_beat;
          // A placement begins where its clip time says it does, which can be
          // inside a comp segment: the voice then starts at the placement's
          // own first frame, at the take frame that segment holds there.
          if (seg.audibleFrom !== undefined && startBeat < seg.audibleFrom) {
            startBeat = seg.audibleFrom;
            clipBeat = seg.audibleFrom - loopStart;
          }
          if (startBeat >= segEndBeat) continue;
          const startFrame = beatToFrame(startBeat);
          if (startFrame < frameStart || startFrame >= frameEnd) continue;
          const stopBeat = Math.min(loopStart + part.to_beat, segEndBeat);
          if (!(stopBeat > startBeat)) continue;
          startAudio(seg, clip, part, loopStart, clipBeat, stopBeat, startFrame, frameStart);
        }
      }
    }

    /**
     * Start one comp segment on the next voice of its track, register its stop
     * in the open set, and emit the event.
     *
     * A take the song marks discarded is skipped: the comp still names it (the
     * document refuses that, but a song can arrive mid-edit), and no voice
     * should ever be started for it.
     * @param {object} seg
     * @param {object} clip
     * @param {{take_id: string, from_beat: number, to_beat: number}} part
     * @param {number} loopStart the beat this loop iteration starts at
     * @param {number} clipBeat how far into the clip the sound starts (a comp
     *   segment's own start, or further in when a placement began mid-segment)
     * @param {number} stopBeat the beat its stop is owed at
     * @param {number} startFrame the absolute frame the segment starts sounding at
     * @param {number} frameStart the block's first frame
     */
    function startAudio(seg, clip, part, loopStart, clipBeat, stopBeat, startFrame, frameStart) {
      const trackId = seg.track_id;
      const take = takes.get(part.take_id);
      if (take && take.discarded) return;

      const takeFrame = Math.round(clipBeat * framesPerBeat) + (take ? take.offsetFrames : 0);

      // A start that lands on a voice already playing that take at that very
      // position is not a start at all: the sound continues. That is what
      // joins the two halves of a split, which `rebuildArrangement` keeps in
      // ONE segment (two placements that fade at the seam are two segments, so
      // they get two voices), and what stops a seek's own start from being
      // doubled.
      if (mode === "arrangement") {
        const continuing = continuingVoice(seg, part.take_id, startFrame, takeFrame);
        if (continuing) {
          continuing.clipId = clip.id;
          continuing.seg = seg;
          continuing.fromBeat = part.from_beat;
          continuing.loopStart = loopStart;
          continuing.offBeat = stopBeat;
          continuing.offFrame = beatToFrame(stopBeat);
          return;
        }
      }

      const voice = lastVoice.get(trackId) === 0 ? 1 : 0;
      lastVoice.set(trackId, voice);

      // A third start inside one take's lifetime re-uses a voice that is still
      // sounding: it is released first, at this very frame (the sort puts the
      // stop in front of the start).
      const key = audioKey(trackId, voice);
      if (openAudio.has(key)) {
        openAudio.delete(key);
        events.push({ frame: startFrame - frameStart, track_id: trackId, type: "audio_stop", voice: voice });
      }

      openAudio.set(key, {
        key: key,
        track_id: trackId,
        voice: voice,
        clipId: clip.id,
        seg: seg,
        takeId: part.take_id,
        fromBeat: part.from_beat,
        loopStart: loopStart,
        offBeat: stopBeat,
        offFrame: beatToFrame(stopBeat),
        startFrame: startFrame,
        takeFrame: takeFrame,
      });

      events.push({
        frame: startFrame - frameStart,
        track_id: trackId,
        type: "audio",
        take_id: part.take_id,
        take_frame: takeFrame,
        voice: voice,
      });

      // A voice that starts inside a fade window plays the rest of that ramp:
      // the window's gain at this frame is where it picks up.
      emitFadeAtStart(seg, voice, startFrame, frameStart);
    }

    /**
     * @param {object} seg the segment the new comp segment would play in
     * @param {string} takeId
     * @param {number} startFrame the frame a new comp segment would start at
     * @param {number} takeFrame the take frame that start would read
     * @returns {object|null} the open voice that is already playing that very
     *   take frame in that very segment, if there is one
     */
    function continuingVoice(seg, takeId, startFrame, takeFrame) {
      for (const entry of openAudio.values()) {
        // Only inside one segment: a start in the segment after it is a new
        // sound (a split that fades at the seam is two of them).
        if (entry.seg !== seg) continue;
        if (entry.takeId !== takeId) continue;
        const position = entry.takeFrame + (startFrame - entry.startFrame);
        // One frame of slack: the frame a beat lands on is rounded, so a
        // continuing take can be a frame off the recomputed position.
        if (Math.abs(position - takeFrame) <= 1) return entry;
      }
      return null;
    }

    /**
     * Emit the pad triggers of one pattern clip inside this block.
     *
     * The clip is walked in PATTERN SLOTS of one pattern's loop each
     * (`L = length_steps × step_beats` beats): slot `k` starts at
     * `seg.startBeat + k × L` and plays the pattern the chain names for it
     * (`chain[k mod chain.length]`, or the clip's first pattern when the chain
     * is empty), so the pattern follows from the beat alone — a seek, a
     * relaunch and a placement's `offset_beats` all land on the same one.
     *
     * A step sounds `at × step_beats` beats into its pattern's slot, an odd one
     * delayed by `swing × step_beats`, and its `gate_frames` is the step's own
     * length in frames, untouched by the swing. Nothing is registered in an
     * open set: the pad's mode decides how the voice ends, and a pattern change
     * inside a chain therefore cuts nothing.
     * @param {object} seg the track's segment playing the clip
     * @param {object} clip a pattern clip, with each pattern's steps sorted
     * @param {number} first the first pattern slot to look at
     * @param {number} last the last pattern slot to look at
     * @param {number} segEndBeat the beat the segment is cut at (`Infinity` for none)
     * @param {number} segEndFrame the frame the segment is cut at (`Infinity` for none)
     * @param {number} frameStart
     * @param {number} frameEnd
     * @returns {void}
     */
    function emitPads(seg, clip, first, last, segEndBeat, segEndFrame, frameStart, frameEnd) {
      const chain = cycleOf(clip);
      const chainLength = chain.length;
      const stepBeats = clip.stepBeats;
      const swing = clip.swing;
      const gateFrames = Math.max(1, Math.round(stepBeats * framesPerBeat));

      for (let slot = first; slot <= last; slot += 1) {
        const slotStart = seg.startBeat + slot * clip.lengthBeats;
        if (slotStart >= segEndBeat) break;
        const patternId = chainLength > 0 ? chain[slot % chainLength] : clip.firstPattern;
        if (patternId === null) break;
        const steps = clip.patternSteps.get(patternId);
        // A chain entry that names no pattern of this clip (or one with no
        // steps) keeps its slot and plays nothing in it: the cycle around it
        // keeps its length.
        if (!steps || steps.length === 0) continue;

        for (let at = 0; at < steps.length; at += 1) {
          const step = steps[at];
          // An odd step waits for the swing: a delay in beats, rounded once
          // together with the absolute position it moves.
          const delayed = step.at % 2 === 0 ? 0 : swing * stepBeats;
          const onBeat = slotStart + step.at * stepBeats + delayed;
          // A placement that starts part-way into its clip does not play the
          // steps that began before it, exactly as it does not start notes.
          if (seg.audibleFrom !== undefined && onBeat < seg.audibleFrom - EPSILON_BEATS) continue;
          const onFrame = beatToFrame(onBeat);
          if (onFrame < frameStart || onFrame >= frameEnd) continue;
          if (onFrame >= segEndFrame) continue;

          events.push({
            frame: onFrame - frameStart,
            track_id: seg.track_id,
            type: "pad",
            bank_id: step.bank_id,
            index: step.index,
            v: step.v,
            locks: step.locks,
            gate_frames: gateFrames,
          });
        }
      }
    }

    /**
     * Close one sounding voice now: its stop is owed at frame 0 of the next
     * block, like a forced note off.
     * @param {object} entry an entry of the open audio set
     * @param {number} atFrame the frame the state change happened at
     */
    function forceCloseAudio(entry, atFrame) {
      if (openAudio.get(entry.key) !== entry) return;
      openAudio.delete(entry.key);
      entry.offFrame = atFrame;
      forcedAudio.push({ track_id: entry.track_id, voice: entry.voice });
    }

    /** Close every sounding voice now, for a stop or a restart. */
    function forceCloseAllAudio() {
      if (openAudio.size === 0) return;
      for (const entry of openAudio.values()) {
        forcedAudio.push({ track_id: entry.track_id, voice: entry.voice });
      }
      openAudio.clear();
    }

    /**
     * Bring one open voice's stop forward, never later.
     * @param {object} entry
     * @param {number} beat
     */
    function capAudioOff(entry, beat) {
      if (!(beat < entry.offBeat)) return;
      entry.offBeat = beat;
      entry.offFrame = beatToFrame(beat);
    }

    /**
     * Register one sounding note and emit its on. A pitch that is still open
     * on this track is released first, at this frame — unless it was struck at
     * this very frame, in which case the two notes are one: the on is already
     * out and the later note simply borrows it.
     * @param {string} trackId
     * @param {object} note the clip's note
     * @param {object} seg the segment this note plays in
     * @param {number} loopStart the beat this loop iteration starts at
     * @param {number} offBeat the beat the note's off is owed at
     * @param {number} onFrame the absolute frame of the note's on
     * @param {number} frameStart the block's first frame
     */
    function startNote(trackId, note, seg, loopStart, offBeat, onFrame, frameStart) {
      const key = trackId + ":" + note.p;
      const previous = open.get(key);
      if (previous) {
        if (previous.onFrame === onFrame) {
          previous.v = note.v;
          previous.clipId = seg.clipId;
          previous.seg = seg;
          previous.t = note.t;
          previous.d = note.d;
          previous.loopStart = loopStart;
          previous.offBeat = offBeat;
          previous.offFrame = beatToFrame(offBeat);
          return;
        }

        const at = previous.offFrame < onFrame ? previous.offFrame : onFrame;
        open.delete(key);
        events.push({
          frame: at <= frameStart ? 0 : at - frameStart,
          track_id: trackId,
          type: "off",
          p: previous.p,
          v: previous.v,
        });
      }

      open.set(key, {
        key: key,
        track_id: trackId,
        p: note.p,
        v: note.v,
        clipId: seg.clipId,
        seg: seg,
        t: note.t,
        d: note.d,
        loopStart: loopStart,
        onFrame: onFrame,
        offBeat: offBeat,
        offFrame: beatToFrame(offBeat),
      });

      events.push({ frame: onFrame - frameStart, track_id: trackId, type: "on", p: note.p, v: note.v });
    }

    /**
     * Close one sounding note now: its off is owed at frame 0 of the next
     * block, whichever frame the state change happened at.
     * @param {object} entry an entry of the open set
     * @param {number} atFrame the frame the state change happened at
     */
    function forceClose(entry, atFrame) {
      if (open.get(entry.key) !== entry) return;
      open.delete(entry.key);
      entry.offFrame = atFrame;
      forced.push(entry);
    }

    /**
     * Close every sounding note now, for a stop, a restart or a song that no
     * longer holds any of them.
     * @param {number} atFrame
     */
    function forceCloseAll(atFrame) {
      if (open.size === 0) return;
      for (const entry of open.values()) {
        entry.offFrame = atFrame;
        forced.push(entry);
      }
      open.clear();
    }

    /**
     * Bring one open note's off forward, never later.
     * @param {object} entry
     * @param {number} beat
     */
    function capOff(entry, beat) {
      if (beat >= entry.offBeat) return;
      entry.offBeat = beat;
      entry.offFrame = beatToFrame(beat);
    }

    /**
     * Drop ended segments, and only when one ended: their notes were capped
     * when the segment closed, so nothing still reads them.
     * @param {number} frameStart
     */
    function pruneEndedSegments(frameStart) {
      for (const segs of segments.values()) {
        let ended = 0;
        while (ended < segs.length) {
          const seg = segs[ended];
          if (seg.endBeat === null) break;
          if (beatToFrame(seg.endBeat) > frameStart) break;
          ended += 1;
        }
        if (ended === 0) continue;
        const trackId = segs[0].track_id;
        segs.splice(0, ended);
        if (segs.length === 0) segments.delete(trackId);
      }
    }

    /**
     * Where the last processed frame sits, 1-based.
     * @returns {{bar: number, beat: number, sixteenth: number}}
     */
    function position() {
      if (originFrame === null) return { bar: 1, beat: 1, sixteenth: 1 };
      const frame = lastFrame === null ? originFrame : lastFrame;
      const beats = Math.max(0, (frame - originFrame) / framesPerBeat);
      const barIndex = Math.floor(beats / BEATS_PER_BAR);
      const inBar = beats - barIndex * BEATS_PER_BAR;
      const beatIndex = Math.floor(inBar);
      const sixteenthIndex = Math.floor((inBar - beatIndex) * SIXTEENTHS_PER_BEAT);
      return { bar: barIndex + 1, beat: beatIndex + 1, sixteenth: sixteenthIndex + 1 };
    }

    // --- small helpers over this instance's state ------------------------

    /** @returns {number} the transport position in beats. */
    function currentBeat() {
      if (originFrame === null) return 0;
      const frame = frameNow();
      return Math.max(0, (frame - originFrame) / framesPerBeat);
    }

    /** @returns {number} the first frame the next block will process. */
    function frameNow() {
      return currentFrame === null ? (originFrame === null ? 0 : originFrame) : currentFrame;
    }

    /** @returns {number} the absolute frame of a beat of the transport. */
    function beatToFrame(beat) {
      const origin = originFrame === null ? 0 : originFrame;
      return Math.round(origin + beat * framesPerBeat);
    }

    /** @returns {Array} this track's segments, created on first use. */
    function segmentsOf(trackId) {
      let segs = segments.get(trackId);
      if (!segs) {
        segs = [];
        segments.set(trackId, segs);
      }
      return segs;
    }

    /** @returns {object|null} the segment of `segs` that sounds at `beat`. */
    function audibleSegment(segs, beat) {
      let found = null;
      for (const seg of segs) {
        // A placement that begins part-way into its clip has a segment whose
        // own bars start before it is audible (its `startBeat` is where clip
        // beat 0 of it would sit): the playhead is in it only from
        // `audibleFrom` on, and the placement before it holds the playhead
        // until then.
        if (seg.startBeat > beat) continue;
        if (seg.endBeat !== null && seg.endBeat <= beat) continue;
        if (seg.audibleFrom !== undefined && beat < seg.audibleFrom - EPSILON_BEATS) continue;
        found = seg;
      }
      return found;
    }

    /** @returns {Map<string, string>} track id → the clip it sounds now. */
    function currentClips() {
      const out = new Map();
      const beat = originFrame === null ? 0 : currentBeat();
      for (const segs of segments.values()) {
        const seg = audibleSegment(segs, beat);
        if (seg && seg.clipId !== null) out.set(seg.track_id, seg.clipId);
      }
      return out;
    }

    /**
     * @param {object[]} segs a track's segments, in beat order
     * @param {number} beat
     * @returns {string|null} the clip these segments sound at `beat`, `null`
     *   for a stop (or no segment at all)
     */
    function clipAtBeat(segs, beat) {
      const seg = audibleSegment(segs, beat);
      return seg ? seg.clipId : null;
    }

    /**
     * @param {object} clip a clip of `clips`
     * @returns {string|null} the clip's scene, `null` when it names none
     */
    function sceneOf(clip) {
      return clip && clip.scene_id !== "" ? clip.scene_id : null;
    }

    /** @returns {object|null} the clip on one track and scene, if any. */
    function clipFor(trackId, sceneId) {
      for (const clip of clips.values()) {
        if (clip.track_id === trackId && clip.scene_id === sceneId) return clip;
      }
      return null;
    }

    /** @returns {boolean} whether the song has any soloed track. */
    function anySoloed() {
      for (const track of tracks) {
        if (track.solo) return true;
      }
      return false;
    }

    /** @returns {boolean} whether this track may sound under the mute/solo rules. */
    function audible(trackId, soloMode) {
      const at = trackIndex.get(trackId);
      if (at === undefined) return false;
      const track = tracks[at];
      if (!track || track.mute) return false;
      return soloMode ? track.solo === true : true;
    }

    /**
     * Frame first, then stops before starts (a note or a voice that ends where
     * the next begins must be released first — which is exactly what lets a
     * host crossfade one comp segment into the next), then the song's track
     * order, then the voice or the pitch.
     */
    function compareEvents(a, b) {
      if (a.frame !== b.frame) return a.frame - b.frame;
      const ar = eventRank(a.type);
      const br = eventRank(b.type);
      if (ar !== br) return ar - br;
      const at = trackIndex.has(a.track_id) ? trackIndex.get(a.track_id) : Number.MAX_SAFE_INTEGER;
      const bt = trackIndex.has(b.track_id) ? trackIndex.get(b.track_id) : Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      if (a.voice !== undefined || b.voice !== undefined) return (a.voice || 0) - (b.voice || 0);
      // Pads carry a pad index rather than a pitch; a note's pitch decides its
      // order, and two events that name neither keep their arrival order.
      if (a.p !== undefined || b.p !== undefined) return (a.p || 0) - (b.p || 0);
      return (a.index || 0) - (b.index || 0);
    }

    /** @returns {number} the order of an event type inside one frame. */
    function eventRank(type) {
      if (type === "off") return 0;
      if (type === "audio_stop") return 1;
      if (type === "on") return 2;
      // A pad trigger starts a voice of its own, like a note does; it follows
      // any stop at the same frame. A fade follows the start it belongs to: the
      // voice it names is opened by an "audio" event at the very same frame.
      if (type === "pad") return 3;
      if (type === "fade") return 4;
      return 3; // "audio"
    }

    /** @returns {number} the timeline beat the transport's beat 0 sits on. */
    function originBeat() {
      return mode === "arrangement" ? arrangementBeat : 0;
    }

    return {
      setSong: setSong,
      launchScene: launchScene,
      launchClip: launchClip,
      stopTrack: stopTrack,
      stopAll: stopAll,
      play: play,
      stop: stop,
      setMode: setMode,
      seek: seek,
      block: block,
      nextBarFrame: nextBarFrame,
      barLines: barLines,
      position: position,
      isPlaying: function isPlaying() {
        return playing;
      },
    };
  }

  /**
   * The next bar boundary at or after a frame, on a timeline whose beat 0 sits
   * at `originFrame`.
   *
   * This is the ONE place the boundary rounding lives: the launch quantizer
   * (`launchBeat`) and the `nextBarFrame` answer both come from it, so a host
   * asking where the next bar begins and the block that reports a launch
   * landing there can never disagree by a frame.
   *
   * It is found in frames, not in beats: at most tempos a bar is not a whole
   * number of frames, so a position one frame past the rounded boundary still
   * reads as slightly more than the bar and `ceil` would skip a whole bar. The
   * frame at or after the boundary is the first with `round(x) >= frame`, i.e.
   * `x >= frame - 0.5`.
   *
   * @param {number} frame the frame to start from (a block's first frame)
   * @param {number} originFrame the absolute frame of beat 0
   * @param {number} framesPerBeat how many frames one beat lasts
   * @returns {{bar: number, beat: number, frame: number}} the boundary, with a
   *   0-based `bar`, the boundary in `beat`s and its rounded `frame`
   */
  function nextBarFrom(frame, originFrame, framesPerBeat) {
    return nextBarInto({ bar: 0, beat: 0, frame: 0 }, frame, originFrame, framesPerBeat);
  }

  /**
   * The same answer as `nextBarFrom`, written into the caller's own object: the
   * performance bus asks for the bar lines on every block, and a block must not
   * make garbage on the audio thread.
   * @param {{bar: number, beat: number, frame: number}} target
   * @param {number} frame
   * @param {number} originFrame
   * @param {number} framesPerBeat
   * @returns {object} the same object, filled in
   */
  function nextBarInto(target, frame, originFrame, framesPerBeat) {
    const out = target && typeof target === "object" ? target : {};
    const barFrames = BEATS_PER_BAR * framesPerBeat;
    let bar = Math.max(0, Math.ceil((frame - 0.5 - originFrame) / barFrames - EPSILON_BEATS));
    let boundary = Math.round(originFrame + bar * barFrames);
    // A boundary the caller has already gone past is no boundary at all.
    if (boundary < frame) {
      bar += 1;
      boundary = Math.round(originFrame + bar * barFrames);
    }
    out.bar = bar;
    out.beat = bar * BEATS_PER_BAR;
    out.frame = boundary;
    return out;
  }

  /** @returns {number} launch reports in the order of their block frames. */
  function byLaunchFrame(a, b) {
    return a.frame - b.frame;
  }

  /**
   * The open-audio key for one track and voice.
   * @param {string} trackId
   * @param {number} voice
   * @returns {string}
   */
  function audioKey(trackId, voice) {
    return trackId + "\n" + voice;
  }

  /**
   * @param {object[]} notes a clip's notes, sorted by `t`
   * @param {number} t
   * @returns {number} the index of the first note starting at or after `t`
   */
  function lowerBound(notes, t) {
    let low = 0;
    let high = notes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (notes[middle].t < t) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** @returns {number} a stable order for notes that start together. */
  function byStartBeat(a, b) {
    return a.t - b.t;
  }

  /**
   * The order of two steps of one pattern: its position first, then the bank
   * and pad, so two pads on one position trigger in a fixed order that both
   * hosts agree on.
   * @returns {number}
   */
  function byStep(a, b) {
    if (a.at !== b.at) return a.at - b.at;
    if (a.bank_id !== b.bank_id) return a.bank_id < b.bank_id ? -1 : 1;
    return a.index - b.index;
  }

  /**
   * @param {unknown} value a pattern clip's `length_steps`
   * @returns {number} how many step positions its pattern has, at least 1
   */
  function stepPositionsOf(value) {
    const steps = Math.trunc(Number(value && value.length_steps));
    if (!Number.isFinite(steps) || steps < 1) return DEFAULT_STEP_POSITIONS;
    return Math.min(steps, MAX_STEP_POSITIONS);
  }

  /**
   * @param {unknown} value a pattern clip's `step_beats`
   * @returns {number} how many beats one step lasts, above zero
   */
  function stepBeatsOf(value) {
    const beats = Number(value && value.step_beats);
    if (!Number.isFinite(beats) || beats <= 0) return DEFAULT_STEP_BEATS;
    return beats;
  }

  /**
   * @param {unknown} value a pattern clip's `swing`
   * @returns {number} how far an odd step is delayed, in step lengths, from 0 to
   *   the document's own cap of 0.75
   */
  function swingOf(value) {
    const swing = Number(value && value.swing);
    if (!Number.isFinite(swing) || swing <= 0) return 0;
    return swing > MAX_SWING ? MAX_SWING : swing;
  }

  /**
   * @param {unknown} value a pattern clip's `chain`
   * @returns {string[]} the pattern ids it names, in order, duplicates kept (a
   *   chain may play one pattern more than once)
   */
  function chainOf(value) {
    const chain = value && Array.isArray(value.chain) ? value.chain : null;
    if (!chain || chain.length === 0) return EMPTY_STEPS;
    const out = [];
    for (let at = 0; at < chain.length; at += 1) {
      const patternId = chain[at];
      if (typeof patternId === "string" && patternId !== "") out.push(patternId);
    }
    return out.length === 0 ? EMPTY_STEPS : out;
  }

  /**
   * The patterns one cycle of a clip plays, in order. A pattern clip cycles on
   * its chain — a chain entry that names no pattern of the clip keeps its slot
   * and plays nothing there — and when no entry names one it falls back to its
   * own first pattern. Any other clip has no chain, and the caller cycles on
   * its length alone.
   * @param {object} clip a clip this song was read into
   * @returns {string[]} the pattern ids of one cycle (`EMPTY_STEPS` for none)
   */
  function cycleOf(clip) {
    return clip.chainPlays ? clip.chain : EMPTY_STEPS;
  }

  /** @returns {number} the beat order of two comp segments. */
  function byFromBeat(a, b) {
    return a.from_beat - b.from_beat;
  }
  /** @returns {number} the bar order of two placements. */
  function byStartBar(a, b) {
    return a.start_bar - b.start_bar;
  }

  /** @returns {number} the beat order of two fades. */
  function byFadeBeat(a, b) {
    return a.beat - b.beat;
  }

  /** @returns {number} `value` folded into `[0, length)`. */
  function wrapBeats(value, length) {
    if (!(length > 0)) return 0;
    return ((value % length) + length) % length;
  }

  /** @returns {number} a fade length in beats: a finite number, 0 or more. */
  function fadeBeats(value) {
    const beats = Number(value);
    return Number.isFinite(beats) && beats > 0 ? beats : 0;
  }

  /** @returns {number} frames one beat lasts at a tempo. */
  function framesPerBeatFor(sampleRate, bpm) {
    return (sampleRate * 60) / bpm;
  }

  /** @returns {number} the value when it is a finite number above zero, else 0. */
  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  const api = { create: create, nextBarFrom: nextBarFrom, BEATS_PER_BAR: BEATS_PER_BAR };

  if (typeof globalThis !== "undefined") globalThis.StudioSequencer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();