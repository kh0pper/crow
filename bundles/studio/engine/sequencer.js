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
 * ## Session view
 *
 * One clip sounds per track at a time. `launchClip` / `launchScene` /
 * `stopTrack` / `stopAll` are quantized to the next bar while the transport
 * runs, and take effect at the first bar when it does not. A launch replaces
 * the track's sounding clip at that boundary; the notes still sounding from
 * the replaced clip get their off at the boundary frame.
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

    /** track id → [{clipId, startBeat, endBeat}] in beat order. */
    const segments = new Map();

    /** Offs owed to notes cut short by a stop or a clip switch. */
    const pendingOffs = [];

    // --- song ------------------------------------------------------------

    /**
     * Replace the song. While the transport runs, clips that still exist keep
     * playing and a clip the new snapshot no longer has stops at the next bar,
     * with offs for its sounding notes. A tempo change re-maps beats to frames
     * from `originFrame` on; the offs already queued for a boundary keep the
     * frames they were computed at.
     * @param {object} snapshot the song as `doc.js`'s `snapshot()` returns it
     */
    function setSong(snapshot) {
      const next = readSong(snapshot);

      if (playing && originFrame !== null) {
        const boundary = launchBeat();
        for (const entry of Array.from(segments.entries())) {
          const trackId = entry[0];
          const segs = entry[1];
          const orphaned =
            !next.trackIndex.has(trackId) || segs.some((seg) => seg.clipId !== null && !next.clips.has(seg.clipId));
          if (orphaned) scheduleAt(trackId, null, boundary);
        }
      } else {
        for (const entry of Array.from(segments.entries())) {
          const trackId = entry[0];
          const segs = entry[1];
          if (!next.trackIndex.has(trackId)) {
            segments.delete(trackId);
            continue;
          }
          const kept = segs.filter((seg) => seg.clipId === null || next.clips.has(seg.clipId));
          if (kept.length > 0) segments.set(trackId, kept);
          else segments.delete(trackId);
        }
      }

      tracks = next.tracks;
      trackIndex = next.trackIndex;
      clips = next.clips;
      framesPerBeat = next.framesPerBeat;
    }

    /** @returns {{bpm: number, framesPerBeat: number, tracks: object[], trackIndex: Map, clips: Map}} */
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

    /** @returns {{id: string, track_id: string, scene_id: string, lengthBeats: number, notes: object[]}|null} */
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
    }

    /** Stop every track at the next bar, with offs for their sounding notes. */
    function stopAll() {
      if (!playing) {
        segments.clear();
        return;
      }
      const at = launchBeat();
      for (const track of tracks) {
        if (!segments.has(track.id)) continue;
        scheduleAt(track.id, null, at);
      }
    }

    /**
     * Start the transport from its beginning, playing the clips that were
     * sounding, from beat 0. The position resets to 1.1.1.
     */
    function play() {
      if (playing) {
        pendingOffs.length = 0;
        queueSoundingOffs();
      }
      const keep = currentClips();
      segments.clear();
      for (const entry of keep) {
        segments.set(entry[0], [{ clipId: entry[1], startBeat: 0, endBeat: null }]);
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
      pendingOffs.length = 0;
      queueSoundingOffs();
      const keep = currentClips();
      segments.clear();
      for (const entry of keep) {
        segments.set(entry[0], [{ clipId: entry[1], startBeat: 0, endBeat: null }]);
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
      if (last && (last.endBeat === null || last.endBeat > atBeat)) closeSegment(trackId, last, atBeat);
      segs.push({ clipId: clipId === null ? null : String(clipId), startBeat: atBeat, endBeat: null });
    }

    /** End one segment at `atBeat`, queueing offs for what it still sounds. */
    function closeSegment(trackId, seg, atBeat) {
      seg.endBeat = atBeat;
      if (!playing || originFrame === null) return;
      if (seg.clipId === null) return;
      if (!audible(trackId, anySoloed())) return;

      const frame = beatToFrame(atBeat);
      for (const note of soundingAt(seg.clipId, seg.startBeat, atBeat)) {
        pendingOffs.push({ frame: frame, track_id: trackId, p: note.p, v: note.v });
      }
    }

    /**
     * Queue an off at the current frame for every note still sounding — the
     * transport stopping, or restarting, cuts them all.
     */
    function queueSoundingOffs() {
      if (!playing || originFrame === null || currentFrame === null) return;
      const atFrame = currentFrame;
      const atBeat = (atFrame - originFrame) / framesPerBeat;
      const soloMode = anySoloed();

      for (const entry of segments) {
        const trackId = entry[0];
        const segs = entry[1];
        if (!audible(trackId, soloMode)) continue;
        for (const seg of segs) {
          if (seg.clipId === null) continue;
          if (seg.startBeat > atBeat) continue;
          if (seg.endBeat !== null && seg.endBeat <= atBeat) continue;
          for (const note of soundingAt(seg.clipId, seg.startBeat, atBeat)) {
            pendingOffs.push({ frame: atFrame, track_id: trackId, p: note.p, v: note.v });
          }
        }
      }
    }

    /**
     * The notes of one clip that are sounding at `atBeat`, in the loop
     * iteration that covers it. A note is sounding when it started strictly
     * before that beat and its off is at or after it.
     * @param {string} clipId
     * @param {number} segStartBeat
     * @param {number} atBeat
     * @returns {object[]} the clip's own note objects
     */
    function soundingAt(clipId, segStartBeat, atBeat) {
      const clip = clips.get(clipId);
      if (!clip || clip.lengthBeats <= 0) return [];

      const length = clip.lengthBeats;
      const atFrame = beatToFrame(atBeat);
      const rel = atBeat - segStartBeat;
      const last = Math.floor(rel / length);
      const first = Math.max(0, last - 1);
      const out = [];

      for (let loop = first; loop <= last; loop += 1) {
        const loopStart = segStartBeat + loop * length;
        for (const note of clip.notes) {
          const onFrame = beatToFrame(loopStart + note.t);
          const offFrame = beatToFrame(Math.min(loopStart + note.t + note.d, loopStart + length));
          if (onFrame < atFrame && offFrame >= atFrame) out.push(note);
        }
      }
      return out;
    }

    /** @returns {number} the bar boundary a launch takes effect at, in beats. */
    function launchBeat() {
      if (!playing || originFrame === null) return 0;
      const beat = currentBeat();
      if (beat <= 0) return 0;
      return Math.ceil(beat / BEATS_PER_BAR) * BEATS_PER_BAR;
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

      const events = emitBlock(start, count);
      currentFrame = start + count;
      lastFrame = start + count - 1;
      return events;
    }

    /** @returns {object[]} the events inside [frameStart, frameStart + frames). */
    function emitBlock(frameStart, frames) {
      const events = [];
      const frameEnd = frameStart + frames;

      if (originFrame !== null) {
        const beatStart = (frameStart - originFrame) / framesPerBeat;
        const beatEnd = (frameEnd - originFrame) / framesPerBeat;
        pruneSegments(beatStart);

        const soloMode = anySoloed();
        for (const entry of segments) {
          const trackId = entry[0];
          const segs = entry[1];
          if (!audible(trackId, soloMode)) continue;
          for (const seg of segs) {
            if (seg.clipId === null) continue;
            const clip = clips.get(seg.clipId);
            if (!clip || clip.lengthBeats <= 0) continue;

            const length = clip.lengthBeats;
            const segEndBeat = seg.endBeat === null ? Infinity : seg.endBeat;
            const winStart = beatStart > seg.startBeat ? beatStart : seg.startBeat;
            const winEnd = beatEnd < segEndBeat ? beatEnd : segEndBeat;
            if (!(winEnd > winStart)) continue;

            const segEndFrame = seg.endBeat === null ? Infinity : beatToFrame(seg.endBeat);
            // One iteration either side of the window: the window is measured
            // in beats and the events in rounded frames.
            const first = Math.max(0, Math.floor((winStart - seg.startBeat) / length) - 1);
            const last = Math.floor((winEnd - seg.startBeat) / length) + 1;

            for (let loop = first; loop <= last; loop += 1) {
              const loopStart = seg.startBeat + loop * length;
              if (loopStart >= segEndBeat) break;
              const loopEnd = loopStart + length;

              for (const note of clip.notes) {
                if (loopStart + note.t >= segEndBeat) continue;

                const onFrame = beatToFrame(loopStart + note.t);
                if (onFrame >= frameStart && onFrame < frameEnd) {
                  events.push({ frame: onFrame - frameStart, track_id: trackId, type: "on", p: note.p, v: note.v });
                }

                // A note crossing the loop end, or the segment's end, is cut
                // there; an off exactly on the segment end is one of the
                // queued offs instead, so it is never emitted twice.
                const offFrame = beatToFrame(Math.min(loopEnd, loopStart + note.t + note.d));
                if (offFrame < segEndFrame && offFrame >= frameStart && offFrame < frameEnd) {
                  events.push({ frame: offFrame - frameStart, track_id: trackId, type: "off", p: note.p, v: note.v });
                }
              }
            }
          }
        }
      }

      // Offs queued for a stop or a switch land at their own frame, on the
      // one block that covers it.
      for (let at = pendingOffs.length - 1; at >= 0; at -= 1) {
        const off = pendingOffs[at];
        if (off.frame < frameStart) {
          pendingOffs.splice(at, 1);
          continue;
        }
        if (off.frame >= frameEnd) continue;
        pendingOffs.splice(at, 1);
        events.push({ frame: off.frame - frameStart, track_id: off.track_id, type: "off", p: off.p, v: off.v });
      }

      events.sort(compareEvents);
      return events;
    }

    /** Drop segments that finished before this block: nothing reads them. */
    function pruneSegments(beatStart) {
      for (const entry of Array.from(segments.entries())) {
        const trackId = entry[0];
        const segs = entry[1];
        const kept = segs.filter((seg) => seg.endBeat === null || seg.endBeat > beatStart);
        if (kept.length === 0) segments.delete(trackId);
        else if (kept.length !== segs.length) segments.set(trackId, kept);
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
      const frame = currentFrame === null ? originFrame : currentFrame;
      return Math.max(0, (frame - originFrame) / framesPerBeat);
    }

    /** @returns {number} the absolute frame of a beat of the transport. */
    function beatToFrame(beat) {
      return Math.round((originFrame === null ? 0 : originFrame) + beat * framesPerBeat);
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
      for (const entry of segments) {
        const seg = audibleSegment(entry[1], beat);
        if (seg && seg.clipId !== null) out.set(entry[0], seg.clipId);
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