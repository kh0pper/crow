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
 * kind?, comp?}}` with `t`/`d` in beats, `p` a MIDI pitch and `v` a velocity,
 * and `takes{id: {id, clip_id, rate, offset_frames, discarded}}` for the takes
 * an audio clip's comp plays.
 */
(function () {
  "use strict";

  /** 1a is four beats to the bar, in every song. */
  const BEATS_PER_BAR = 4;

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
   *            block: function(number, number): Array<object>,
   *            nextBarFrame: function(): {bar: number, beat: number, frame: number},
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
    let framesPerBeat = framesPerBeatFor(sampleRate, DEFAULT_BPM);

    /** Transport state. */
    let playing = false;
    let originFrame = null; // absolute frame of beat 0 for this transport run
    let currentFrame = null; // absolute frame just past the last processed block
    let lastFrame = null; // absolute frame of the last processed frame

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

      tracks = next.tracks;
      trackIndex = next.trackIndex;
      clips = next.clips;
      takes = next.takes;
      framesPerBeat = next.framesPerBeat;
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

      return {
        bpm: bpm,
        framesPerBeat: framesPerBeatFor(sampleRate, bpm),
        tracks: list,
        trackIndex: index,
        clips: byId,
        takes: takesById,
      };
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
     * @returns {{id: string, track_id: string, scene_id: string, lengthBeats: number, notes: object[]}|null}
     */
    function readClip(id, value) {
      if (!value || typeof value !== "object") return null;
      const bars = positive(value.length_bars);
      const lengthBeats = (bars || 1) * BEATS_PER_BAR;

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
      const sceneId = scene_id === null || scene_id === undefined ? "" : String(scene_id);
      if (sceneId === "") return;
      const at = launchBeat();
      for (const track of tracks) {
        const clip = clipFor(track.id, sceneId);
        applyLaunch(track.id, clip ? clip.id : null, sceneId, at);
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
      const trackId = track_id === null || track_id === undefined ? "" : String(track_id);
      if (!trackIndex.has(trackId)) return;
      // No scene is named: the report falls back to the scene of the clip the
      // stop replaces (see `applyLaunch`).
      applyLaunch(trackId, null, undefined, launchBeat());
      reconcile(frameNow());
    }

    /** Stop every track at the next bar, with offs for their sounding notes. */
    function stopAll() {
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
     * Stop the transport: every sounding note gets its off at the current
     * frame, the position returns to 1.1.1, and the sounding clips stay armed
     * for the next `play()`.
     */
    function stop() {
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
    function applyLaunch(trackId, clipId, sceneId, atBeat) {
      const segs = segments.get(trackId);
      const replaced = segs ? clipAtBeat(segs, atBeat) : null;
      scheduleAt(trackId, clipId, atBeat);
      const applied = clipAtBeat(segmentsOf(trackId), atBeat);
      if (applied === replaced) return;

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
      return { bar: 0, beat: 0, frame: frameNow() };
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
        if (originFrame === null) originFrame = start;
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
      const frameEnd = frameStart + frames;

      emitForced();

      if (playing && originFrame !== null) {
        pruneEndedSegments(frameStart);

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
          const startBeat = loopStart + part.from_beat;
          if (startBeat >= segEndBeat) continue;
          const startFrame = beatToFrame(startBeat);
          if (startFrame < frameStart || startFrame >= frameEnd) continue;
          const stopBeat = Math.min(loopStart + part.to_beat, segEndBeat);
          if (!(stopBeat > startBeat)) continue;
          startAudio(seg, clip, part, loopStart, startFrame, stopBeat, frameStart);
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
     * @param {number} startFrame the absolute frame the segment starts sounding at
     * @param {number} stopBeat the beat its stop is owed at
     * @param {number} frameStart the block's first frame
     */
    function startAudio(seg, clip, part, loopStart, startFrame, stopBeat, frameStart) {
      const trackId = seg.track_id;
      const take = takes.get(part.take_id);
      if (take && take.discarded) return;

      const takeFrame = Math.round(part.from_beat * framesPerBeat) + (take ? take.offsetFrames : 0);
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
      });

      events.push({
        frame: startFrame - frameStart,
        track_id: trackId,
        type: "audio",
        take_id: part.take_id,
        take_frame: takeFrame,
        voice: voice,
      });
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
        if (seg.startBeat <= beat && (seg.endBeat === null || seg.endBeat > beat)) found = seg;
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
      return a.p - b.p;
    }

    /** @returns {number} the order of an event type inside one frame. */
    function eventRank(type) {
      if (type === "off") return 0;
      if (type === "audio_stop") return 1;
      if (type === "on") return 2;
      return 3; // "audio"
    }

    return {
      setSong: setSong,
      launchScene: launchScene,
      launchClip: launchClip,
      stopTrack: stopTrack,
      stopAll: stopAll,
      play: play,
      stop: stop,
      block: block,
      nextBarFrame: nextBarFrame,
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
    const barFrames = BEATS_PER_BAR * framesPerBeat;
    let bar = Math.max(0, Math.ceil((frame - 0.5 - originFrame) / barFrames - EPSILON_BEATS));
    let boundary = Math.round(originFrame + bar * barFrames);
    // A boundary the caller has already gone past is no boundary at all.
    if (boundary < frame) {
      bar += 1;
      boundary = Math.round(originFrame + bar * barFrames);
    }
    return { bar: bar, beat: bar * BEATS_PER_BAR, frame: boundary };
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

  /** @returns {number} the beat order of two comp segments. */
  function byFromBeat(a, b) {
    return a.from_beat - b.from_beat;
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