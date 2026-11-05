/**
 * Studio font voice — the SoundFont hosts, one synth per font.
 *
 * A soundfont track's device is `{engine: "soundfont", font_id, bank, program}`
 * (see `server/doc.js`): the instrument is a library entry plus a preset inside
 * it. The engine plays it with spessasynth_core, vendored as ONE import-free
 * classic script (`vendor/spessasynth/spessasynth.js`, which sets
 * `globalThis.StudioSpessa`), because a worklet cannot import anything.
 *
 * ## One synth per FONT, one channel per TRACK
 *
 * `SpessaSynthProcessor` mixes every channel of its bank into one stereo pair,
 * and its only per-channel tap is `channelOutputs` — a `[left, right]` pair per
 * channel that `process()` writes the channel's DRY signal into. So a font is
 * parsed ONCE however many tracks play it, and every track still gets a stereo
 * pair of its own to fade, pan, mute, solo and (from PR B) insert over:
 *
 *     StudioFontVoice.create(sampleRate).process(frames)
 *       → Map track id → {left, right}   (that track's channel, dry)
 *
 * **The main L/R is discarded.** `process()` is handed a scratch pair this file
 * owns and never reads: the mix is the channels, and the synth's own reverb,
 * chorus and insertion are off (`effectsEnabled: false`), so nothing a track
 * hears comes from the bank's own effects.
 *
 * ## Channels are assigned deterministically
 *
 * `assign(tracks)` takes the song's soundfont tracks IN SNAPSHOT ORDER and hands
 * the tracks of a font channels 0, 1, 2 … — the order the document lists the
 * tracks in, which is the order both hosts agree on, so a rendered page and a
 * rendered file put the same track on the same channel. A song has at most 16
 * tracks (`MAX_TRACKS`), so a font never needs more than 16 channels and no
 * track is ever left without one. The GM drum bank is `setDrums(true)` on that
 * track's own channel: channel 9 is NOT reserved for drums, so a song with 16
 * tracks still gets 16 channels.
 *
 * A preset is applied when its channel, its (font, bank, program) or the parsed
 * font itself changed since the last assignment — a program change therefore
 * takes effect at the next block's first frame, because `assign` runs on the
 * message path between two blocks and never inside one.
 *
 * ## Loading while stopped; the memory cap
 *
 * Parsing a bank is the processor's business: `load(id, bytes)` is only ever
 * called while the transport is stopped (see `studio-processor.js`, which queues
 * a load that arrives while playing and parses it on the next stop). `load` is
 * async because an SF3 bank's Ogg samples need the vendored Vorbis decoder,
 * which compiles on first use (`BasicSoundBank.ready`); that decoder failing is
 * NOT a failed load — an uncompressed SF2 bank parses and plays without it.
 *
 * The fonts loaded here are held to `maxBytes` (1 GiB by default, by byte
 * length of the files). Past it the least recently PLAYED font — the one whose
 * last note is oldest, so a font nothing plays goes first — is unloaded and
 * reported through `takeEvicted()`, which the processor turns into another
 * `library_needed` for the page.
 *
 * ## Nothing here throws on the audio thread
 *
 * `load` throws only to its caller (the processor, which reports it), and
 * `process()` catches a synth that throws mid-block: that font is dropped, its
 * tracks go silent, and the failure is handed back through `takeFailures()` to
 * be reported once. `noteOn`/`noteOff` are guarded the same way. A bank that
 * cannot play therefore costs its own tracks, never the song.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioFontVoice` for the worklet scope and `module.exports` when a
 * CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"`, so a Node `require()` of this file works inside the bundle's
 * ESM tree; `engine-client.js` also concatenates it into the worklet module
 * (after the vendored synth and before the processor that hosts it).
 */
(function () {
  "use strict";

  /** The MIDI channels one synth has, and so the most tracks one font can carry. */
  const MAX_CHANNELS = 16;

  /** The bank a soundfont track's drum kits live in (the GM drum bank). */
  const GM_DRUM_BANK = 128;

  /** The highest program a preset can name inside a bank. */
  const MAX_PROGRAM = 127;

  /** The highest MIDI pitch and the lowest velocity a note can carry. */
  const MAX_NOTE = 127;
  const MIN_VELOCITY = 1;

  /**
   * A processor holds at most this many bytes of fonts at once, when the caller
   * names no other cap: 1 GiB, the plan's page and render cap.
   */
  const DEFAULT_MAX_FONT_BYTES = 1024 * 1024 * 1024;

  /**
   * The longest stretch of frames one `SpessaSynthProcessor.process()` call may
   * render: the `maxBufferSize` its own voice buffer is allocated with. A run
   * longer than this (a host with a huge block) is rendered in chunks, which is
   * the same work in the same order.
   */
  const RENDER_BLOCK = 512;

  /**
   * The voices one font's synth keeps: enough for sixteen tracks of held chords
   * and their releases, and nothing like the 350 a standalone player allocates.
   */
  const VOICE_CAP = 128;

  /** @returns {string} an id in the form a Map is keyed by. */
  function asId(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  /** @returns {number} a whole number held inside [low, high]. */
  function clampInt(value, low, high, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const whole = Math.round(number);
    if (whole < low) return low;
    if (whole > high) return high;
    return whole;
  }

  /** @returns {Uint8Array} the bytes of a transferred bank, as a JS-owned copy. */
  function readBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(0);
  }

  /** @returns {object|null} the vendored synth's exports, when they are loaded. */
  function spessa() {
    const loaded = typeof globalThis !== "undefined" ? globalThis.StudioSpessa : null;
    return loaded && typeof loaded === "object" ? loaded : null;
  }

  /**
   * Parse a bank file into spessasynth's own representation.
   *
   * The bytes are handed over as a `Uint8Array`; the parser copies what it
   * keeps, so the caller's buffer is not held alive by the bank.
   * @param {Uint8Array} bytes
   * @returns {object} the parsed sound bank
   */
  function parseBank(bytes) {
    const Spessa = spessa();
    const loader = Spessa && Spessa.SoundBankLoader;
    if (!loader || typeof loader.fromArrayBuffer !== "function") {
      throw new Error("the SoundFont synth is not loaded");
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error("the bank is empty");
    }
    return loader.fromArrayBuffer(bytes);
  }

  /**
   * One font's synth, built on first use.
   *
   * Its effects are OFF: reverb, chorus, delay, insertion and the GS equaliser
   * all belong to the mixer from PR B on, and a bank's own effects would be
   * baked into one track's output where nothing could undo them.
   * @param {number} sampleRate
   * @returns {object} a `SpessaSynthProcessor`
   */
  function makeSynth(sampleRate) {
    const Spessa = spessa();
    if (!Spessa || typeof Spessa.SpessaSynthProcessor !== "function") {
      throw new Error("the SoundFont synth is not loaded");
    }
    const synth = new Spessa.SpessaSynthProcessor(sampleRate, {
      effectsEnabled: false,
      eventsEnabled: false,
      maxBufferSize: RENDER_BLOCK,
    });
    // A smaller pool than a player's: the cap is per FONT, and a song has at
    // most 16 tracks on it.
    try {
      synth.setSystemParameter("voiceCap", VOICE_CAP);
    } catch {
      /* a synth whose cap cannot be lowered keeps its own; nothing breaks */
    }
    return synth;
  }

  /**
   * Set one channel's preset: the GM drum bank with `setDrums`, a melodic bank
   * with a bank select and a program change.
   *
   * `setDrums` re-sends the program change itself (to make the change audible),
   * so the program is set AFTER it; the bank select goes first for a melodic
   * bank, because a program change resolves against the bank the channel
   * currently holds.
   * @param {object} synth
   * @param {number} channel 0-15
   * @param {number} bank 0-127 melodic, 128 the GM drums
   * @param {number} program 0-127
   * @returns {void}
   */
  function applyPreset(synth, channel, bank, program) {
    const midi = synth.midiChannels[channel];
    if (!midi || typeof midi.programChange !== "function") return;
    if (bank >= GM_DRUM_BANK) {
      if (typeof midi.setDrums === "function") midi.setDrums(true);
      midi.programChange(program);
      return;
    }
    if (typeof midi.setDrums === "function") midi.setDrums(false);
    midi.controllerChange(0, bank);
    midi.controllerChange(32, 0);
    midi.programChange(program);
  }

  /**
   * One font host for one processor: the parsed banks, the channels its tracks
   * hold, and the per-track stereo output of the last `process()` call.
   *
   * @param {number} rate the context's sample rate, in Hz
   * @param {{maxBytes?: number}} [options] `maxBytes` is the cap on the fonts
   *   held at once (the plan's 1 GiB when omitted)
   * @returns {object} the host (`load`, `unload`, `assign`, `channelFor`,
   *   `noteOn`, `noteOff`, `process`, `takeEvicted`, `takeFailures`, …)
   */
  function create(rate, options) {
    const settings = options && typeof options === "object" ? options : {};
    const sampleRate = Number(rate);
    const rateHz = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const askedCap = Number(settings.maxBytes);
    const maxBytes = Number.isFinite(askedCap) && askedCap > 0 ? askedCap : DEFAULT_MAX_FONT_BYTES;

    /**
     * font id → `{id, synth, bytes, serial, lastPlayed, capacity,
     * channelOutputs, outputs, mainLeft, mainRight, used, assigned}`.
     *
     * `serial` counts the parses of that font id, so a font that is loaded again
     * re-applies every preset that plays it; `used` is the channels assigned to
     * tracks right now (only those are cleared before a render); `assigned` is
     * how many channels have been handed out, which is what keeps the next track
     * on the next channel.
     */
    const fonts = new Map();

    /**
     * track id → `{font_id, channel, key, serial, output}`. An entry with a
     * `channel` of null is a track whose font is not loaded: it is silent, and
     * named in `missing()` so the processor can ask the page for it.
     */
    const tracks = new Map();

    /** The tracks of the last `assign()`, in snapshot order: the song's own. */
    let specs = [];

    /** The last stereo pair handed out per track, rebuilt by `assign()`. */
    const outputs = new Map();

    /** How many bytes of fonts are held, against `maxBytes`. */
    let totalBytes = 0;

    /** A counter every note bumps, so "least recently played" is the oldest. */
    let playClock = 0;

    /** A counter every parse of one font id bumps (`font.serial`). */
    let fontSerial = 0;

    /** Font ids the cap pushed out since the last `takeEvicted()`. */
    let evicted = [];

    /** `{id, reason}` for fonts that failed to render since `takeFailures()`. */
    let failures = [];

    /**
     * Make sure one font's per-channel buffers can hold `frames` frames, growing
     * them (and the scratch main pair) when a host hands a longer block than any
     * before. Growing re-points every track entry at its channel's new pair.
     * @param {object} font
     * @param {number} frames
     * @returns {void}
     */
    function ensureBuffers(font, frames) {
      if (font.capacity >= frames) return;
      const capacity = Math.max(RENDER_BLOCK, Math.trunc(frames));
      for (let channel = 0; channel < MAX_CHANNELS; channel += 1) {
        const left = new Float32Array(capacity);
        const right = new Float32Array(capacity);
        font.channelOutputs[channel] = [left, right];
        font.outputs[channel] = { left: left, right: right };
      }
      font.mainLeft = new Float32Array(capacity);
      font.mainRight = new Float32Array(capacity);
      font.capacity = capacity;
      for (const [trackId, entry] of tracks) {
        if (entry.font_id !== font.id || entry.channel === null) continue;
        entry.output = font.outputs[entry.channel];
        // The map a caller reads after `process()` has to point at the new pair
        // too: it is the same object `outputFor` hands back.
        outputs.set(trackId, entry.output);
      }
    }

    /**
     * Drop one font's synth and its memory, and forget the tracks that read it.
     * @param {string} fontId
     * @returns {object|null} the font record that was dropped, if any
     */
    function dropFont(fontId) {
      const font = fonts.get(fontId);
      if (!font) return null;
      fonts.delete(fontId);
      totalBytes -= font.bytes;
      if (totalBytes < 0) totalBytes = 0;
      if (font.synth && typeof font.synth.destroy === "function") {
        try {
          font.synth.destroy();
        } catch {
          /* the synth is going away; a failed teardown has nothing left to do */
        }
      }
      font.synth = null;
      return font;
    }

    /**
     * Stop whatever a channel is sounding, so a channel handed to another track
     * (or rebuilt) cannot play a stale note.
     * @param {string} fontId
     * @param {number|null} channel
     * @returns {void}
     */
    function silenceChannel(fontId, channel) {
      if (channel === null || channel === undefined) return;
      const font = fonts.get(fontId);
      const midi = font && font.synth ? font.synth.midiChannels[channel] : null;
      if (!midi || typeof midi.stopAllNotes !== "function") return;
      try {
        midi.stopAllNotes(true);
      } catch {
        /* a channel that will not stop is not worth a failed block */
      }
    }

    /**
     * Hand the tracks of the last `assign()` their channels and presets again,
     * after anything moved under them (a font parsed, unloaded, evicted or
     * failed). Called on the message path and after a failure, never mid-block.
     * @returns {void}
     */
    function bind() {
      /** font id → the next channel to hand out. */
      const next = new Map();
      const bound = new Map();

      for (const spec of specs) {
        const trackId = asId(spec && spec.track_id);
        if (trackId === "") continue;
        const fontId = asId(spec && spec.font_id);
        const bank = clampInt(spec && spec.bank, 0, GM_DRUM_BANK, 0);
        const program = clampInt(spec && spec.program, 0, MAX_PROGRAM, 0);
        const font = fontId === "" ? null : fonts.get(fontId) || null;

        let channel = null;
        if (font && font.synth) {
          const used = next.get(fontId) || 0;
          if (used < MAX_CHANNELS) {
            channel = used;
            next.set(fontId, used + 1);
          }
        }

        const previous = tracks.get(trackId);
        let entry = previous;
        if (!previous || previous.font_id !== fontId) {
          // A track whose font changed (or a track that is new): its old channel
          // is released before the new one is claimed, so nothing keeps sounding
          // on a channel this font no longer owns.
          if (previous) silenceChannel(previous.font_id, previous.channel);
          entry = { font_id: fontId, channel: null, key: "", serial: -1, output: null };
        }
        if (entry.channel !== channel) {
          silenceChannel(entry.font_id, entry.channel);
          entry.channel = channel;
          entry.key = "";
        }
        if (channel !== null) {
          const key = `${fontId}|${bank}|${program}`;
          // A channel change and a font that was parsed again both make the
          // preset that channel holds meaningless: apply it once more.
          if (entry.key !== key || entry.serial !== font.serial) {
            silenceChannel(fontId, channel);
            applyPreset(font.synth, channel, bank, program);
            entry.key = key;
            entry.serial = font.serial;
          }
          entry.output = font.outputs[channel];
        } else {
          entry.output = null;
        }
        bound.set(trackId, entry);
      }

      // A track that left the song (or became a non-font track) must not keep
      // sounding: its channel goes quiet and its entry is dropped.
      for (const [trackId, entry] of tracks) {
        if (bound.has(trackId)) continue;
        silenceChannel(entry.font_id, entry.channel);
      }
      tracks.clear();
      for (const [trackId, entry] of bound) tracks.set(trackId, entry);

      outputs.clear();
      for (const font of fonts.values()) font.used = new Set();
      for (const [trackId, entry] of tracks) {
        if (entry.channel === null || !entry.output) continue;
        const font = fonts.get(entry.font_id);
        if (font) font.used.add(entry.channel);
        outputs.set(trackId, entry.output);
      }
    }

    /**
     * Bring the held fonts back under the cap, least recently played first. The
     * font that was just loaded is never a candidate: a song that would need the
     * whole cap for one font keeps it, exactly as the sample store does.
     * @param {string} keepId
     * @returns {void}
     */
    function trim(keepId) {
      if (totalBytes <= maxBytes) return;
      while (totalBytes > maxBytes) {
        let victim = null;
        for (const font of fonts.values()) {
          if (font.id === keepId) continue;
          if (!victim || font.lastPlayed < victim.lastPlayed) victim = font;
        }
        if (!victim) return;
        dropFont(victim.id);
        evicted.push(victim.id);
        bind();
      }
    }

    /**
     * A font that threw while rendering (or starting a note) is dropped: its
     * tracks go silent, the mix keeps playing, and the processor reports it once.
     * @param {object} font
     * @param {unknown} error
     * @returns {void}
     */
    function fail(font, error) {
      const reason = error && error.message ? error.message : String(error);
      if (!fonts.has(font.id)) return;
      dropFont(font.id);
      failures.push({ id: font.id, reason: reason });
      bind();
    }

    return {
      /**
       * Parse one bank and give it to a synth. Resolves when the synth holds it.
       *
       * Throws (to this caller only: the processor reports it as
       * `library_failed`) when the bytes are not a bank it can read, and leaves
       * nothing behind when it does.
       * @param {string} fontId
       * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
       * @returns {Promise<void>}
       */
      async load(fontId, bytes) {
        const id = asId(fontId);
        if (id === "") throw new Error("a font needs an id");
        const data = readBytes(bytes);
        const bank = parseBank(data);
        const size = data.byteLength;

        const synth = makeSynth(rateHz);
        // An SF3 bank's Ogg samples are decoded on the first note, through the
        // vendored Vorbis decoder, which compiles on first use. Awaiting it here
        // means no note is dropped for want of a decoder; a host without one
        // (a scope with no base64 support) still plays an uncompressed SF2.
        try {
          await synth.ready;
        } catch {
          /* no Ogg decoder: SF2 banks are unaffected */
        }

        const previous = fonts.get(id);
        if (previous) {
          totalBytes -= previous.bytes;
          if (previous.synth && typeof previous.synth.destroy === "function") {
            try {
              previous.synth.destroy();
            } catch {
              /* the replaced synth is going away; nothing left to clean */
            }
          }
        }
        fontSerial += 1;
        const font = {
          id: id,
          synth: synth,
          bytes: size,
          serial: fontSerial,
          lastPlayed: 0,
          capacity: 0,
          channelOutputs: new Array(MAX_CHANNELS),
          outputs: new Array(MAX_CHANNELS),
          mainLeft: null,
          mainRight: null,
          used: new Set(),
        };
        ensureBuffers(font, RENDER_BLOCK);
        // The bank is in the synth before the first track asks for a preset: the
        // preset list a program change resolves against is the one this call
        // rebuilds, and it resets every channel of that synth.
        synth.soundBankManager.addSoundBank(bank, id);
        fonts.set(id, font);
        totalBytes += size;
        trim(id);
        bind();
      },

      /**
       * Drop one font and free what it holds. Its tracks go silent until it is
       * loaded again (and are named in `missing()`).
       * @param {string} fontId
       * @returns {void}
       */
      unload(fontId) {
        if (!dropFont(asId(fontId))) return;
        bind();
      },

      /** @param {string} fontId @returns {boolean} whether that font is loaded. */
      isLoaded(fontId) {
        const font = fonts.get(asId(fontId));
        return !!(font && font.synth);
      },

      /** @returns {number} the bytes of fonts held right now, against `maxBytes`. */
      get bytes() {
        return totalBytes;
      },

      /** @returns {number} the cap those bytes are held under. */
      get maxBytes() {
        return maxBytes;
      },

      /** @returns {number} how many fonts are held. */
      get fontCount() {
        return fonts.size;
      },

      /**
       * Give the song's soundfont tracks their channels and presets, in snapshot
       * order. Cheap enough to run on every song: a track whose (font, bank,
       * program) has not changed keeps its channel and its preset untouched.
       * @param {object[]} list one `{track_id, font_id, bank, program}` per
       *   soundfont track, in the song's own track order
       * @returns {void}
       */
      assign(list) {
        specs = Array.isArray(list) ? list : [];
        bind();
      },

      /**
       * @param {string} trackId
       * @returns {number|null} the channel that track holds, or null while its
       *   font is not loaded (or the track plays no font at all)
       */
      channelFor(trackId) {
        const entry = tracks.get(asId(trackId));
        return entry && entry.channel !== null ? entry.channel : null;
      },

      /**
       * The stereo pair a track reads after the last `process()`: the track's own
       * channel, dry, `frames` samples of it.
       * @param {string} trackId
       * @returns {{left: Float32Array, right: Float32Array}|null}
       */
      outputFor(trackId) {
        return outputs.get(asId(trackId)) || null;
      },

      /**
       * Start one note on a track's channel. A track whose font is not loaded,
       * or has no channel, is silent — the caller has already said why.
       * @param {string} trackId
       * @param {number} pitch MIDI note, 0-127
       * @param {number} velocity 1-127
       * @returns {void}
       */
      noteOn(trackId, pitch, velocity) {
        const entry = tracks.get(asId(trackId));
        if (!entry || entry.channel === null) return;
        const font = fonts.get(entry.font_id);
        if (!font || !font.synth) return;
        const note = clampInt(pitch, 0, MAX_NOTE, 0);
        const level = clampInt(velocity, MIN_VELOCITY, MAX_NOTE, MAX_NOTE);
        font.lastPlayed = playClock += 1;
        try {
          font.synth.noteOn(entry.channel, note, level);
        } catch (error) {
          fail(font, error);
        }
      },

      /**
       * Release one note on a track's channel.
       * @param {string} trackId
       * @param {number} pitch MIDI note, 0-127
       * @returns {void}
       */
      noteOff(trackId, pitch) {
        const entry = tracks.get(asId(trackId));
        if (!entry || entry.channel === null) return;
        const font = fonts.get(entry.font_id);
        if (!font || !font.synth) return;
        const note = clampInt(pitch, 0, MAX_NOTE, 0);
        try {
          font.synth.noteOff(entry.channel, note);
        } catch (error) {
          fail(font, error);
        }
      },

      /**
       * Render `frames` of every loaded font and hand back the per-track pairs.
       *
       * The map is the host's own and is valid until the next call: the track's
       * pair holds at least `frames` samples, and the caller reads only those.
       * @param {number} frames
       * @returns {Map<string, {left: Float32Array, right: Float32Array}>}
       */
      process(frames) {
        const total = Math.max(0, Math.trunc(Number(frames) || 0));
        if (total === 0 || fonts.size === 0) return outputs;
        for (const font of fonts.values()) {
          const synth = font.synth;
          if (!synth) continue;
          // A longer block than any before grows the buffers; every entry of
          // this font is re-pointed at its channel's new pair there.
          if (font.capacity < total) ensureBuffers(font, total);
          // The synth ADDS into every buffer it is handed, so a run starts from
          // silence — and only the channels a track holds are worth clearing.
          for (const channel of font.used) {
            const pair = font.channelOutputs[channel];
            pair[0].fill(0, 0, total);
            pair[1].fill(0, 0, total);
          }
          for (let start = 0; start < total; start += RENDER_BLOCK) {
            const count = Math.min(RENDER_BLOCK, total - start);
            try {
              synth.process(font.mainLeft, font.mainRight, start, count, font.channelOutputs);
            } catch (error) {
              fail(font, error);
              break;
            }
          }
        }
        return outputs;
      },

      /**
       * The font ids the last `assign()` wanted but does not hold, sorted — what
       * the processor reports as `library_needed`.
       * @returns {string[]}
       */
      missing() {
        const ids = new Set();
        for (const entry of tracks.values()) {
          if (entry.channel === null && entry.font_id !== "") ids.add(entry.font_id);
        }
        return Array.from(ids).sort();
      },

      /** @returns {string[]} the font ids the cap pushed out since the last call. */
      takeEvicted() {
        if (evicted.length === 0) return evicted;
        const ids = evicted;
        evicted = [];
        return ids;
      },

      /** @returns {Array<{id: string, reason: string}>} render failures since the last call. */
      takeFailures() {
        // Called once per block, so it allocates nothing while there is nothing
        // to say (the usual case on the audio thread).
        if (failures.length === 0) return failures;
        const list = failures;
        failures = [];
        return list;
      },

      /** @returns {string[]} the font ids held right now, sorted. */
      loadedIds() {
        return Array.from(fonts.keys()).sort();
      },

      /**
       * Drop every synth and forget every track. The processor calls this from
       * `dispose()`; nothing here allocates anything back.
       * @returns {void}
       */
      destroy() {
        for (const id of Array.from(fonts.keys())) dropFont(id);
        tracks.clear();
        outputs.clear();
        specs = [];
        evicted = [];
        failures = [];
        totalBytes = 0;
      },
    };
  }

  const api = {
    create: create,
    MAX_CHANNELS: MAX_CHANNELS,
    DEFAULT_MAX_FONT_BYTES: DEFAULT_MAX_FONT_BYTES,
    RENDER_BLOCK: RENDER_BLOCK,
    GM_DRUM_BANK: GM_DRUM_BANK,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioFontVoice = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();