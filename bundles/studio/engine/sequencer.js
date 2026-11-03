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
 * `tracks[{id, mute, solo}]`, `scenes[{id}]`, and
 * `clips{id: {id, track_id, scene_id, length_bars, notes[{t, d, p, v}]}}` with
 * `t`/`d` in beats, `p` a MIDI pitch and `v` a velocity.
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

    /** The events of the block being built. Reused; a block allocates nothing. */
    const events = [];

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
      framesPerBeat = next.framesPerBeat;

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

      return { bpm: bpm, framesPerBeat: framesPerBeatFor(sampleRate, bpm), tracks: list, trackIndex: index, clips: byId };
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
        notes: notes,
      };
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
        scheduleAt(track.id, clip ? clip.id : null, at);
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
      scheduleAt(clip.track_id, clip.id, launchBeat());
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
      scheduleAt(trackId, null, launchBeat());
      reconcile(frameNow());
    }

    /** Stop every track at the next bar, with offs for their sounding notes. */
    function stopAll() {
      const at = launchBeat();
      if (!playing || originFrame === null) {
        forceCloseAll(frameNow());
        segments.clear();
        return;
      }
      for (const track of tracks) {
        if (!segments.has(track.id)) continue;
        scheduleAt(track.id, null, at);
      }
      // A note whose segment was already gone still stops here.
      for (const entry of open.values()) capOff(entry, at);
      reconcile(frameNow());
    }

    /**
     * Start the transport from its beginning, playing the clips that were
     * sounding, from beat 0. The position resets to 1.1.1.
     */
    function play() {
      const keep = currentClips();
      forceCloseAll(frameNow());
      segments.clear();
      for (const [trackId, clipId] of keep) {
        segments.set(trackId, [{ track_id: trackId, clipId: clipId, startBeat: 0, endBeat: null }]);
      }
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
      segments.clear();
      for (const [trackId, clipId] of keep) {
        segments.set(trackId, [{ track_id: trackId, clipId: clipId, startBeat: 0, endBeat: null }]);
      }
      playing = false;
      originFrame = null;
      lastFrame = null;
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
      const beat = currentBeat();
      if (beat <= 0) return 0;

      // Found in frames, not in beats: at most tempos a bar is not a whole
      // number of frames, so a position one frame past the rounded boundary
      // still reads as slightly more than the bar and `ceil` would skip a
      // whole bar. The frame at or after the boundary is the first with
      // `round(x) >= frame`, i.e. `x >= frame - 0.5`.
      const barFrames = BEATS_PER_BAR * framesPerBeat;
      const bar = Math.max(1, Math.ceil((frameNow() - 0.5 - originFrame) / barFrames - EPSILON_BEATS));
      const at = bar * BEATS_PER_BAR;
      // A boundary the next block has already passed is no boundary at all.
      return beatToFrame(at) < frameNow() ? at + BEATS_PER_BAR : at;
    }

    // --- block -----------------------------------------------------------

    /**
     * One block of audio: the note events whose frame falls inside it.
     * @param {number} frameStart absolute frame of the block's first frame
     * @param {number} frames how many frames the block holds
     * @returns {Array<{frame: number, track_id: string, type: "on"|"off",
     *                  p: number, v: number}>} events in block-relative
     *   frames, sorted by frame with offs before ons at one frame
     */
    function block(frameStart, frames) {
      const start = Math.trunc(Number(frameStart));
      const count = Math.trunc(Number(frames));
      if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) return [];

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

      events.sort(compareEvents);
      return events;
    }

    /**
     * Emit the offs a state change owes, at frame 0 of this block.
     */
    function emitForced() {
      if (forced.length === 0) return;
      for (const entry of forced) {
        events.push({ frame: 0, track_id: entry.track_id, type: "off", p: entry.p, v: entry.v });
      }
      forced.length = 0;
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
     * Frame first, then offs before ons (a note that ends where the next
     * begins must be released first), then the song's track order, then pitch.
     */
    function compareEvents(a, b) {
      if (a.frame !== b.frame) return a.frame - b.frame;
      if (a.type !== b.type) return a.type === "off" ? -1 : 1;
      const at = trackIndex.has(a.track_id) ? trackIndex.get(a.track_id) : Number.MAX_SAFE_INTEGER;
      const bt = trackIndex.has(b.track_id) ? trackIndex.get(b.track_id) : Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      return a.p - b.p;
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
      position: position,
      isPlaying: function isPlaying() {
        return playing;
      },
    };
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

  const api = { create: create, BEATS_PER_BAR: BEATS_PER_BAR };

  if (typeof globalThis !== "undefined") globalThis.StudioSequencer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();