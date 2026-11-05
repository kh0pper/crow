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
 * ## Channels are STICKY
 *
 * A track keeps its channel for as long as it stays on that font. Adding or
 * deleting another track never moves it: a new track takes the LOWEST FREE
 * channel of its font, and the channels the tracks that stay already hold are
 * reserved first, so a channel a later track keeps is never handed out to an
 * earlier new one. A song has at most 16 tracks (`MAX_TRACKS`), so one font
 * never needs more than 16 channels and no track is ever left without one. The
 * GM drum bank is `setDrums(true)` on that track's own channel: channel 9 is
 * NOT reserved for drums, so a song with 16 tracks still gets 16 channels.
 *
 * ## A freed channel DRAINS; a removed track's tail is dropped
 *
 * A channel that a track leaves (the track changed font, or left the song) is
 * released — every note this file started on it gets a note-off — and then it
 * DRAINS: the font keeps rendering it (a font with any active voice is
 * rendered), so the release envelope the note started with is heard, and the
 * channel is not handed to another track until its voices have all ended. A
 * track that changes font keeps reading its OLD channel, mixed into its own
 * pair, until those voices end, so the release is heard on the same track. A
 * track that LEFT the song has no pair left to read: its tail is dropped (it is
 * still rendered while draining, but nothing routes it into the mix). If a new
 * track needs a channel and every other one is free -- all 16 are owned or
 * draining -- the lowest draining one is taken after an all-sound-off on that
 * channel (a forced cut, the only one this file ever makes).
 *
 * `stopAllNotes(true)` is otherwise never used: it would cut a tail dead.
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
 * a load that arrives while playing, and does not even start one until the
 * decoder is ready and the transport was re-checked). `ready()` awaits the
 * vendored Vorbis decoder that an SF3 bank's Ogg samples need (it compiles on
 * first use, `BasicSoundBank.ready`); a decoder that will not compile is NOT a
 * failed load — an uncompressed SF2 bank parses and plays without it.
 *
 * **Every sample is decoded here, at load.** `load` walks the whole bank and
 * calls `sample.getAudioData()` on each sample before it returns (that is the
 * call that decodes an SF3 sample's Ogg data, and an SF2 sample's 16-bit data),
 * so nothing decodes on the audio thread while the song plays. The synth is
 * given NO `decodedSampleBudget`: a finite budget turns on its own per-note
 * decode cache bookkeeping, and this file already bounds the bank itself. The
 * cap is enforced here instead — the file's bytes are checked BEFORE the bank
 * is parsed or one sample decoded, the decoded Float32 data is checked again
 * before the font is installed, and a reload of an id releases the copy it
 * replaces before decoding the new one.
 *
 * The fonts loaded here are held to `maxBytes` (1 GiB by default), counted as
 * the FILES' bytes PLUS the decoded Float32 sample data (`stats(id).decodedBytes`)
 * — that is what the host really occupies. Past the cap, the least recently
 * PLAYED font that NO current track plays is unloaded and reported through
 * `takeEvicted()`, which the processor turns into another `library_needed` for
 * the page. A font a track of the current song uses is NEVER evicted: a load
 * that would push the song's own fonts past the cap is refused instead, and the
 * refusal's reason is what the page shows ("This song's instruments need more
 * than 1024 MB; remove an instrument or use a smaller bank.").
 *
 * ## Nothing here throws on the audio thread
 *
 * `load` throws only to its caller (the processor, which reports it), and
 * `process()` catches a synth that throws mid-block: that font is dropped, its
 * tracks go silent, and the failure is handed back through `takeFailures()` to
 * be reported once. `noteOn`/`noteOff` are guarded the same way. A bank that
 * cannot play therefore costs its own tracks, never the song.
 *
 * ## The per-run path allocates nothing
 *
 * `process()` walks arrays rebuilt by `assign()`: the fonts the song's tracks
 * actually read (`renderFonts` — a loaded font no track plays is not rendered
 * at all), each font's active channels, the track entries and their buffers. It
 * sums each track's channels into that track's own pair (a channel freed by a
 * font change is one of them, for as long as it drains). No Map or Set iterator
 * is created per run and no array is built per run.
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

  /** Why a bank nothing can be played out of is refused. */
  const NO_INSTRUMENTS = "This bank has no instruments.";

  /**
   * Why a load the song's own fonts leave no room for is refused. The cap is
   * spelled in whole megabytes (or in tenths of one for a tiny cap, which only a
   * test uses).
   * @param {number} maxBytes the cap the fonts are held under
   * @returns {string}
   */
  function capMessage(maxBytes) {
    const megabytes = maxBytes / (1024 * 1024);
    const shown = megabytes >= 1 ? String(Math.round(megabytes)) : megabytes.toFixed(1);
    return "This song's instruments need more than " + shown + " MB; remove an instrument or use a smaller bank.";
  }

  /**
   * The error a cap refusal carries: its `code` lets the processor tell a font
   * that was refused for ROOM from one that would not parse, so it can try the
   * refused one again when the room comes back.
   * @param {number} maxBytes
   * @returns {Error}
   */
  function capError(maxBytes) {
    const error = new Error(capMessage(maxBytes));
    error.code = "font_cap";
    return error;
  }

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
   * Whether a parsed bank carries a preset at all: a bank with none can play
   * nothing, whatever program a track asks for, so it is refused up front and
   * named for what it is.
   * @param {object} bank
   * @returns {boolean}
   */
  function hasInstruments(bank) {
    const presets = bank && bank.presets;
    return !!presets && typeof presets.length === "number" && presets.length > 0;
  }

  /**
   * Decode every sample of a parsed bank NOW, so nothing decodes on the audio
   * thread while the song plays.
   *
   * `getAudioData()` is the call that decodes: an SF3 sample's Ogg data through
   * the vendored Vorbis decoder, an SF2 sample's 16-bit data into Float32. Each
   * decoded array is cached on the sample itself, so after this pass a note can
   * never trigger a decode. A sample that carries no data (a bank loaded without
   * sample data) is skipped — it is silent, not a failed load.
   * @param {object} bank the parsed bank
   * @returns {{samples: number, decoded: number, bytes: number}}
   */
  function decodeSamples(bank) {
    const list = bank && bank.samples;
    const total = list && typeof list.length === "number" ? list.length : 0;
    let decoded = 0;
    let bytes = 0;
    for (let index = 0; index < total; index += 1) {
      const sample = list[index];
      if (!sample || typeof sample.getAudioData !== "function") continue;
      let data = null;
      try {
        data = sample.getAudioData();
      } catch {
        // No data, or a decoder that could not read it: the sample plays
        // silence, which is the synth's own answer for it too.
        continue;
      }
      if (!data || typeof data.byteLength !== "number") continue;
      decoded += 1;
      bytes += data.byteLength;
    }
    return { samples: total, decoded: decoded, bytes: bytes };
  }

  /**
   * One font's synth, built on first use.
   *
   * Its effects are OFF: reverb, chorus, delay, insertion and the GS equaliser
   * all belong to the mixer from PR B on, and a bank's own effects would be
   * baked into one track's output where nothing could undo them. It is given no
   * `decodedSampleBudget`: a finite budget makes the synth track (and evict)
   * decoded samples per note, and this file already decodes everything at load
   * and holds the whole bank under its own cap.
   * @param {number} sampleRate
   * @returns {object} a `SpessaSynthProcessor`
   */
  function makeSynth(sampleRate) {
    const Spessa = spessa();
    if (!Spessa || typeof Spessa.SpessaSynthProcessor !== "function") {
      throw new Error("the SoundFont synth is not loaded");
    }
    const options = {
      effectsEnabled: false,
      eventsEnabled: false,
      maxBufferSize: RENDER_BLOCK,
    };
    const synth = new Spessa.SpessaSynthProcessor(sampleRate, options);
    // A smaller pool than a player's: the cap is per FONT, and a song has at
    // most 16 tracks on it.
    try {
      synth.setSystemParameter("voiceCap", VOICE_CAP);
    } catch {
      /* a synth whose cap cannot be lowered keeps its own; nothing breaks */
    }
    return synth;
  }

  /** @param {object} synth @returns {void} free a synth that never took a bank. */
  function destroySynth(synth) {
    if (!synth || typeof synth.destroy !== "function") return;
    try {
      synth.destroy();
    } catch {
      /* the synth is going away; a failed teardown has nothing left to do */
    }
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
     * font id → `{id, synth, bank, rawBytes, decodedBytes, bytes, samples,
     * decoded, serial, lastPlayed, capacity, channelOutputs, mainLeft,
     * mainRight, owners, draining, drainingSince, activeChannels, held, epoch}`.
     *
     * `bank` is the parsed bank itself, kept so `presets()` can name the
     * instruments it holds for the page's picker; it is only read on the message
     * path, never in `process()`.
     *
     * `bytes` is what that font counts against the cap: the file's own bytes
     * plus its decoded Float32 sample data. `serial` counts the parses of that
     * font id, so a font that is loaded again re-applies every preset that plays
     * it; `owners` is the track entry holding each of its channels right now,
     * `draining` the channels a track left whose voices have not ended yet, and
     * `activeChannels` every channel to clear and render (the two together, the
     * only list the per-run path walks). `held` is the notes this file started
     * on each channel, which a channel that changes hands gets a note-off for.
     */
    const fonts = new Map();

    /** The same fonts, in load order: what the per-run path walks, no iterators. */
    let fontList = [];

    /**
     * track id → `{track_id, font_id, channel, key, serial, drains, output}`. An
     * entry with a `channel` of null is a track whose font is not loaded: it is
     * silent, and named in `missing()` so the processor can ask the page for it.
     * `drains` holds the old font channels still ringing out into this track
     * after a font change, until their voices end.
     */
    const tracks = new Map();

    /** The same entries as an array, rebuilt by `bind()`: no iterator per run. */
    const trackEntries = [];

    /** The tracks of the last `assign()`, in snapshot order: the song's own. */
    let specs = [];

    /** The fonts at least one of those tracks reads, rebuilt by `bind()`. */
    let renderFonts = [];

    /** The font ids `specs` names: never evicted to make room, rebuilt by `bind()`. */
    let neededFonts = new Set();

    /** The last stereo pair handed out per track, rebuilt by `assign()`. */
    const outputs = new Map();

    /** How many bytes of fonts are held (files plus decoded samples), against `maxBytes`. */
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
     * before.
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
      }
      font.mainLeft = new Float32Array(capacity);
      font.mainRight = new Float32Array(capacity);
      font.capacity = capacity;
    }

    /**
     * Give one track entry a stereo pair of its own, big enough for `frames`:
     * the sum of every channel it reads (its own, and any old font channel still
     * draining into it).
     * @param {object} entry
     * @param {number} frames
     * @returns {void}
     */
    function ensureEntryOutput(entry, frames) {
      if (entry.output && entry.output.left.length >= frames) return;
      const capacity = Math.max(RENDER_BLOCK, Math.trunc(frames));
      entry.output = { left: new Float32Array(capacity), right: new Float32Array(capacity) };
      // The map a caller reads after `process()` has to point at the new pair.
      outputs.set(entry.track_id, entry.output);
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
      const at = fontList.indexOf(font);
      if (at >= 0) fontList.splice(at, 1);
      totalBytes -= font.bytes;
      if (totalBytes < 0) totalBytes = 0;
      destroySynth(font.synth);
      font.synth = null;
      font.owners.fill(null);
      font.draining.length = 0;
      font.activeChannels.length = 0;
      return font;
    }

    /** @returns {boolean} whether one font's channel is still draining. */
    function isDraining(font, channel) {
      const list = font.draining;
      for (let index = 0; index < list.length; index += 1) {
        if (list[index] === channel) return true;
      }
      return false;
    }

    /**
     * Mark a channel as draining: it is released, but its voices are still
     * sounding and it may not be handed to another track until they end.
     * @param {object} font
     * @param {number} channel
     * @returns {void}
     */
    function markDraining(font, channel) {
      if (isDraining(font, channel)) return;
      font.draining.push(channel);
      font.drainingSince[channel] = font.epoch;
    }

    /** @param {object} font @param {number} channel @returns {void} */
    function clearDraining(font, channel) {
      const at = font.draining.indexOf(channel);
      if (at >= 0) font.draining.splice(at, 1);
      font.drainingSince[channel] = -1;
    }

    /** @param {object} font @param {number} channel @returns {void} */
    function removeActiveChannel(font, channel) {
      const at = font.activeChannels.indexOf(channel);
      if (at >= 0) font.activeChannels.splice(at, 1);
    }

    /**
     * A drain that has finished stops routing into its track; the channel is
     * then free again (and the next `bind()` gives it to a new track).
     * @param {string} fontId
     * @param {number} serial
     * @param {number} channel
     * @returns {void}
     */
    function dropDrainRoutes(fontId, serial, channel) {
      for (const entry of tracks.values()) {
        const drains = entry.drains;
        for (let index = drains.length - 1; index >= 0; index -= 1) {
          const drain = drains[index];
          if (drain.channel === channel && drain.font_id === fontId && drain.serial === serial) drains.splice(index, 1);
        }
      }
    }

    /**
     * Free every drain of one font whose voices have ended. A drain only
     * counts once the font has rendered a block since it began: `voiceCount` is
     * written by `process()`, so before that it still describes an older block.
     * @param {object} font
     * @returns {void}
     */
    function settleFont(font) {
      const list = font.draining;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const channel = list[index];
        if (font.epoch <= font.drainingSince[channel]) continue;
        const midi = font.synth && font.synth.midiChannels[channel];
        const voices = midi && typeof midi.voiceCount === "number" ? midi.voiceCount : 0;
        if (voices > 0) continue;
        list.splice(index, 1);
        font.drainingSince[channel] = -1;
        removeActiveChannel(font, channel);
        dropDrainRoutes(font.id, font.serial, channel);
      }
    }

    /** Forget any drain whose font is gone, was parsed again, or has ended. */
    function pruneDrains() {
      for (const entry of tracks.values()) {
        const drains = entry.drains;
        for (let index = drains.length - 1; index >= 0; index -= 1) {
          const drain = drains[index];
          const font = fonts.get(drain.font_id);
          if (!font || !font.synth || font.serial !== drain.serial || !isDraining(font, drain.channel)) {
            drains.splice(index, 1);
          }
        }
      }
    }

    /**
     * Release every note this file is holding on one channel: a note-off each,
     * so the release envelope the note started with plays out. Never
     * `stopAllNotes(true)` — that would cut the tail dead.
     * @param {string} fontId
     * @param {number|null} channel
     * @returns {boolean} whether anything is still sounding on that channel (so
     *   it has to drain before another track may take it)
     */
    function releaseChannel(fontId, channel) {
      if (channel === null || channel === undefined) return false;
      const font = fonts.get(fontId);
      if (!font || !font.synth) return false;
      let sounding = false;
      const held = font.held[channel];
      if (held && held.size > 0) {
        sounding = true;
        const notes = Array.from(held);
        held.clear();
        for (let at = 0; at < notes.length; at += 1) {
          try {
            font.synth.noteOff(channel, notes[at]);
          } catch {
            /* a channel that will not release is not worth a failed block */
          }
        }
      }
      const midi = font.synth.midiChannels[channel];
      if (midi && typeof midi.voiceCount === "number" && midi.voiceCount > 0) sounding = true;
      return sounding;
    }

    /**
     * A track leaves a font channel: release it, and keep it ringing into this
     * track (as a drain) while its voices last. A channel with nothing left on
     * it is simply free.
     * @param {object} entry
     * @returns {void}
     */
    function detach(entry) {
      const channel = entry.channel;
      const fontId = entry.font_id;
      if (channel === null || fontId === "") return;
      const font = fonts.get(fontId);
      const sounding = releaseChannel(fontId, channel);
      if (!font || !font.synth) return;
      if (!sounding) {
        clearDraining(font, channel);
        return;
      }
      markDraining(font, channel);
      const drains = entry.drains;
      for (let index = 0; index < drains.length; index += 1) {
        const drain = drains[index];
        if (drain.font_id === fontId && drain.channel === channel && drain.serial === font.serial) return;
      }
      drains.push({ font_id: fontId, channel: channel, serial: font.serial });
    }

    /**
     * The lowest channel of a font that no track holds and that is not
     * draining. When every one is owned or draining, the lowest draining one is
     * taken after an all-sound-off on that channel — the only forced cut this
     * file makes, and only because a track would otherwise have no channel.
     * @param {object} font
     * @returns {number|null}
     */
    function claimChannel(font) {
      for (let channel = 0; channel < MAX_CHANNELS; channel += 1) {
        if (font.owners[channel] === null && !isDraining(font, channel)) return channel;
      }
      for (let channel = 0; channel < MAX_CHANNELS; channel += 1) {
        if (font.owners[channel] !== null || !isDraining(font, channel)) continue;
        const midi = font.synth && font.synth.midiChannels[channel];
        if (midi && typeof midi.stopAllNotes === "function") {
          try {
            midi.stopAllNotes(true);
          } catch {
            /* a channel that will not stop is not worth a failed block */
          }
        }
        const held = font.held[channel];
        if (held) held.clear();
        clearDraining(font, channel);
        removeActiveChannel(font, channel);
        dropDrainRoutes(font.id, font.serial, channel);
        return channel;
      }
      return null;
    }

    /** @param {object} font @param {number} channel @returns {void} */
    function ensureHeld(font, channel) {
      if (!font.held[channel]) font.held[channel] = new Set();
    }

    /**
     * Hand the tracks of the last `assign()` their channels and presets again,
     * after anything moved under them (a font parsed, unloaded, evicted or
     * failed), and rebuild the arrays the per-run path walks.
     *
     * Channels are sticky: a track that stays on its font keeps its channel
     * whatever else the song does, and only a genuinely new channel claim moves
     * a track. Called on the message path and after a failure, never mid-block.
     * @returns {void}
     */
    function bind() {
      const needed = new Set();
      const bound = new Map();

      // A drain that has finished is a free channel again: settle them before
      // any channel is handed out, and forget routes whose font is gone.
      for (let index = 0; index < fontList.length; index += 1) settleFont(fontList[index]);
      pruneDrains();

      // The channels a track keeps are reserved first, so a new track earlier
      // in the song never takes one a later track is still holding.
      for (let index = 0; index < fontList.length; index += 1) {
        const font = fontList[index];
        for (let channel = 0; channel < MAX_CHANNELS; channel += 1) font.owners[channel] = null;
      }

      const orders = [];
      for (let at = 0; at < specs.length; at += 1) {
        const spec = specs[at];
        const trackId = asId(spec && spec.track_id);
        if (trackId === "") continue;
        const fontId = asId(spec && spec.font_id);
        if (fontId !== "") needed.add(fontId);
        orders.push({
          track_id: trackId,
          font_id: fontId,
          bank: clampInt(spec && spec.bank, 0, GM_DRUM_BANK, 0),
          program: clampInt(spec && spec.program, 0, MAX_PROGRAM, 0),
        });
      }

      for (let at = 0; at < orders.length; at += 1) {
        const order = orders[at];
        const previous = tracks.get(order.track_id);
        if (!previous || previous.font_id !== order.font_id || previous.channel === null) continue;
        const font = fonts.get(order.font_id);
        const channel = previous.channel;
        if (!font || !font.synth || channel < 0 || channel >= MAX_CHANNELS || font.owners[channel] !== null) {
          previous.channel = null;
          previous.key = "";
          continue;
        }
        font.owners[channel] = previous;
        ensureHeld(font, channel);
      }

      for (let at = 0; at < orders.length; at += 1) {
        const order = orders[at];
        const fontId = order.font_id;
        const font = fontId === "" ? null : fonts.get(fontId) || null;
        let entry = tracks.get(order.track_id);
        if (entry && entry.font_id !== fontId) {
          // The track changed font: the old font keeps that channel, routed
          // into this same track, until its release has rung out.
          detach(entry);
          entry.font_id = fontId;
          entry.channel = null;
          entry.key = "";
          entry.serial = -1;
        } else if (!entry) {
          // A new track: its own pair, and the lowest free channel of its font.
          entry = { track_id: order.track_id, font_id: fontId, channel: null, key: "", serial: -1, drains: [], output: null };
        }
        if (!entry.output) ensureEntryOutput(entry, RENDER_BLOCK);

        if (!font || !font.synth) {
          // Its font is not loaded: release what it held, and stay silent.
          if (entry.channel !== null) {
            detach(entry);
            entry.channel = null;
            entry.key = "";
          }
          bound.set(order.track_id, entry);
          continue;
        }

        if (entry.channel === null || font.owners[entry.channel] !== entry) {
          const channel = claimChannel(font);
          if (channel !== null) {
            if (entry.channel !== null) detach(entry);
            entry.channel = channel;
            entry.key = "";
            font.owners[channel] = entry;
            ensureHeld(font, channel);
          } else if (entry.channel !== null) {
            detach(entry);
            entry.channel = null;
            entry.key = "";
          }
        }

        if (entry.channel !== null) {
          const key = fontId + "|" + order.bank + "|" + order.program;
          // A preset change and a font that was parsed again both make the
          // preset that channel holds meaningless: apply it once more. A held
          // note is released BEFORE the change, so the release it plays is the
          // one it started with.
          if (entry.key !== key || entry.serial !== font.serial) {
            releaseChannel(fontId, entry.channel);
            applyPreset(font.synth, entry.channel, order.bank, order.program);
            entry.key = key;
            entry.serial = font.serial;
          }
        }
        bound.set(order.track_id, entry);
      }

      // A track that left the song (or became a non-font track) must not keep
      // sounding: its channel is released (and drains, unrouted), its entry and
      // its own tail are dropped.
      for (const [trackId, entry] of tracks) {
        if (bound.has(trackId)) continue;
        detach(entry);
      }
      tracks.clear();
      for (const [trackId, entry] of bound) tracks.set(trackId, entry);

      // The per-run arrays: one pass over the entries, and no allocation at all
      // until the song (or a font) changes again.
      trackEntries.length = 0;
      for (const entry of bound.values()) trackEntries.push(entry);

      outputs.clear();
      for (let index = 0; index < trackEntries.length; index += 1) {
        const entry = trackEntries[index];
        if (entry.output) outputs.set(entry.track_id, entry.output);
      }

      for (let index = 0; index < fontList.length; index += 1) {
        const font = fontList[index];
        const active = font.activeChannels;
        active.length = 0;
        for (let channel = 0; channel < MAX_CHANNELS; channel += 1) {
          if (font.owners[channel] !== null) active.push(channel);
        }
        const draining = font.draining;
        for (let at = 0; at < draining.length; at += 1) {
          if (active.indexOf(draining[at]) < 0) active.push(draining[at]);
        }
      }
      const rendered = [];
      for (let index = 0; index < fontList.length; index += 1) {
        if (fontList[index].activeChannels.length > 0) rendered.push(fontList[index]);
      }
      // A fresh array: a `process()` already walking the old one keeps walking
      // it safely (a dropped font's `synth` is null, and is skipped).
      renderFonts = rendered;
      neededFonts = needed;
    }

    /**
     * The bytes a font of `bytes` could take under the cap if every font that
     * may be evicted were dropped: what is left for it. Negative when the load
     * would push the song's own fonts past the cap.
     * @param {string} fontId the font being loaded or replaced
     * @param {number} bytes the file's own bytes
     * @returns {number}
     */
    function roomFor(fontId, bytes) {
      let held = 0;
      for (let index = 0; index < fontList.length; index += 1) {
        const font = fontList[index];
        if (font.id === fontId) continue;
        if (neededFonts.has(font.id)) held += font.bytes;
      }
      return maxBytes - held - bytes;
    }

    /**
     * Bring the held fonts back under the cap, least recently played first.
     *
     * Only a font NO current track plays may go: the song's own instruments stay
     * loaded, exactly as a song's own samples do. The font that was just loaded
     * is never a candidate either.
     * @param {string} keepId
     * @returns {void}
     */
    function trim(keepId) {
      if (totalBytes <= maxBytes) return;
      let dropped = false;
      while (totalBytes > maxBytes) {
        let victim = null;
        for (let index = 0; index < fontList.length; index += 1) {
          const font = fontList[index];
          if (font.id === keepId) continue;
          if (neededFonts.has(font.id)) continue;
          if (!victim || font.lastPlayed < victim.lastPlayed) victim = font;
        }
        if (!victim) break;
        dropFont(victim.id);
        evicted.push(victim.id);
        dropped = true;
      }
      if (dropped) bind();
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

    /**
     * Sum one channel's dry pair into a track's pair.
     * @param {string} fontId
     * @param {number|null} channel
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @param {number} total
     * @returns {void}
     */
    function addChannel(fontId, channel, left, right, total) {
      if (channel === null || channel === undefined) return;
      const font = fonts.get(fontId);
      if (!font || !font.synth) return;
      const pair = font.channelOutputs[channel];
      if (!pair) return;
      const sourceLeft = pair[0];
      const sourceRight = pair[1];
      const count = Math.min(total, sourceLeft.length);
      for (let at = 0; at < count; at += 1) {
        left[at] += sourceLeft[at];
        right[at] += sourceRight[at];
      }
    }

    return {
      /**
       * Await the decoder an SF3 bank's Ogg samples need. Resolves at once for a
       * host that has no such decoder (an SF2 bank plays without it), and never
       * rejects: a decoder that will not compile is not a failed load.
       * @returns {Promise<void>}
       */
      async ready() {
        const Spessa = spessa();
        const bank = Spessa && Spessa.BasicSoundBank;
        const pending = bank && bank.ready;
        if (!pending || typeof pending.then !== "function") return;
        try {
          await pending;
        } catch {
          /* no Ogg decoder: SF2 banks are unaffected */
        }
      },

      /**
       * Parse one bank, decode every one of its samples, and give it to a synth.
       * Resolves when the synth holds it and nothing is left to decode.
       *
       * Throws (to this caller only: the processor reports it as
       * `library_failed`) when the bytes are not a bank it can read, when the
       * bank carries no preset at all, and when the song's own fonts leave no
       * room for it under the cap. A cap refusal carries `code: "font_cap"`, so
       * the processor can tell it from a broken bank. Nothing is left behind when
       * it throws (except that a reload of the same id has already released the
       * copy it replaces).
       * @param {string} fontId
       * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
       * @returns {Promise<void>}
       */
      async load(fontId, bytes) {
        const id = asId(fontId);
        if (id === "") throw new Error("a font needs an id");
        const data = readBytes(bytes);
        const rawBytes = data.byteLength;

        // The file alone past the room left under the cap: refused BEFORE the
        // bank is parsed or one sample decoded. There is no point reading bytes
        // that could never fit.
        const room = roomFor(id, rawBytes);
        if (room < 0) throw capError(maxBytes);

        const bank = parseBank(data);
        if (!hasInstruments(bank)) throw new Error(NO_INSTRUMENTS);

        // A reload of the same id releases the copy it replaces before the new
        // one is decoded, so the two never sit in memory together.
        dropFont(id);

        const synth = makeSynth(rateHz);
        // An SF3 bank's samples are decoded below, through the vendored Vorbis
        // decoder, which compiles on first use. Awaiting it here means the
        // decode pass can read them; a host without a decoder still plays an
        // uncompressed SF2, and an SF3 sample it cannot read is silent.
        try {
          await synth.ready;
        } catch {
          /* no Ogg decoder: SF2 banks are unaffected */
        }

        // Every sample, now: nothing may decode on the audio thread later.
        const decoded = decodeSamples(bank);
        if (decoded.bytes > room) {
          destroySynth(synth);
          throw capError(maxBytes);
        }

        fontSerial += 1;
        const font = {
          id: id,
          synth: synth,
          bank: bank,
          rawBytes: rawBytes,
          decodedBytes: decoded.bytes,
          bytes: rawBytes + decoded.bytes,
          samples: decoded.samples,
          decoded: decoded.decoded,
          serial: fontSerial,
          lastPlayed: 0,
          capacity: 0,
          channelOutputs: new Array(MAX_CHANNELS),
          mainLeft: null,
          mainRight: null,
          owners: new Array(MAX_CHANNELS).fill(null),
          draining: [],
          drainingSince: new Array(MAX_CHANNELS).fill(-1),
          activeChannels: [],
          held: new Array(MAX_CHANNELS),
          epoch: 0,
        };
        ensureBuffers(font, RENDER_BLOCK);
        // The bank is in the synth before the first track asks for a preset: the
        // preset list a program change resolves against is the one this call
        // rebuilds, and it resets every channel of that synth.
        synth.soundBankManager.addSoundBank(bank, id);
        fonts.set(id, font);
        fontList.push(font);
        totalBytes += font.bytes;
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

      /** @returns {number} the bytes of fonts held right now (files plus decoded data). */
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
       * What one loaded font occupies, and whether its samples were all decoded
       * at load (they always are — `decoded` < `samples` means a sample carried
       * no data). For the host's own reporting and for the engine's tests.
       * @param {string} fontId
       * @returns {{samples: number, decoded: number, rawBytes: number,
       *   decodedBytes: number}|null}
       */
      stats(fontId) {
        const font = fonts.get(asId(fontId));
        if (!font) return null;
        return {
          samples: font.samples,
          decoded: font.decoded,
          rawBytes: font.rawBytes,
          decodedBytes: font.decodedBytes,
        };
      },

      /**
       * The presets one loaded bank carries, as `{bank, program, name}`, sorted by
       * bank and then program: what the page's instrument picker lists. The GM
       * drum bank is 128, whatever bank word the file wrote its kit with.
       *
       * This walks the parsed bank, so it belongs on the message path (a load's
       * own answer), never in `process()`.
       * @param {string} fontId
       * @returns {Array<{bank: number, program: number, name: string}>}
       */
      presets(fontId) {
        const font = fonts.get(asId(fontId));
        if (!font || !font.bank) return [];
        const source = Array.isArray(font.bank.presets) ? font.bank.presets : [];
        const list = [];
        for (let index = 0; index < source.length; index += 1) {
          const preset = source[index];
          if (!preset) continue;
          list.push({
            bank: preset.isGMGSDrum ? GM_DRUM_BANK : clampInt(preset.bankMSB, 0, GM_DRUM_BANK - 1, 0),
            program: clampInt(preset.program, 0, MAX_PROGRAM, 0),
            name: preset.name === undefined || preset.name === null ? "" : String(preset.name),
          });
        }
        list.sort((a, b) => a.bank - b.bank || a.program - b.program || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return list;
      },

      /**
       * The synth one font's bank is parsed into, or null. The host's own sound
       * is made of its channels; this is here so a caller can inspect or bound
       * the synth itself (the engine's effects tests do).
       * @param {string} fontId
       * @returns {object|null}
       */
      fontSynth(fontId) {
        const font = fonts.get(asId(fontId));
        return font && font.synth ? font.synth : null;
      },

      /**
       * Give the song's soundfont tracks their channels and presets, in snapshot
       * order. Cheap enough to run on every song: a track that stays on its font
       * keeps its channel and, while its (font, bank, program) is unchanged, its
       * preset untouched.
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
       * The stereo pair a track reads after the last `process()`: its own
       * channels summed, dry, `frames` samples of it.
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
        // Remember the note, so a channel that changes hands is RELEASED rather
        // than cut (see `releaseChannel`). The Set is allocated when the channel
        // is assigned, never here.
        const held = font.held[entry.channel];
        if (held) held.add(note);
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
        const held = font.held[entry.channel];
        if (held) held.delete(note);
        try {
          font.synth.noteOff(entry.channel, note);
        } catch (error) {
          fail(font, error);
        }
      },

      /**
       * Render `frames` of every font the song's tracks read, and hand back the
       * per-track pairs. A font no track reads and that has no draining channel
       * is not rendered at all.
       *
       * The map is the host's own and is valid until the next call: the track's
       * pair holds at least `frames` samples, and the caller reads only those.
       * Nothing here allocates: the fonts, their active channels, the track
       * entries and their buffers are all rebuilt by `assign()`.
       * @param {number} frames
       * @returns {Map<string, {left: Float32Array, right: Float32Array}>}
       */
      process(frames) {
        const total = Math.max(0, Math.trunc(Number(frames) || 0));
        if (total === 0) return outputs;
        const list = renderFonts;
        for (let index = 0; index < list.length; index += 1) {
          const font = list[index];
          const synth = font.synth;
          if (!synth) continue;
          // A longer block than any before grows the buffers.
          if (font.capacity < total) ensureBuffers(font, total);
          // The synth ADDS into every buffer it is handed, so a run starts from
          // silence — and only the channels in use (held or draining) are worth
          // clearing.
          const active = font.activeChannels;
          for (let at = 0; at < active.length; at += 1) {
            const pair = font.channelOutputs[active[at]];
            if (!pair) continue;
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
          font.epoch += 1;
        }

        // Each track's pair is the sum of the channels it reads: its own, plus
        // any old font channel still ringing out after a font change.
        for (let index = 0; index < trackEntries.length; index += 1) {
          const entry = trackEntries[index];
          if (!entry.output) continue;
          if (entry.output.left.length < total) ensureEntryOutput(entry, total);
          const left = entry.output.left;
          const right = entry.output.right;
          left.fill(0, 0, total);
          right.fill(0, 0, total);
          addChannel(entry.font_id, entry.channel, left, right, total);
          const drains = entry.drains;
          for (let at = 0; at < drains.length; at += 1) {
            const drain = drains[at];
            const font = fonts.get(drain.font_id);
            if (!font || font.serial !== drain.serial) continue;
            addChannel(drain.font_id, drain.channel, left, right, total);
          }
        }

        // A drain whose voices have ended frees its channel, and a font nothing
        // reads any more stops being rendered at all.
        for (let index = list.length - 1; index >= 0; index -= 1) {
          const font = list[index];
          if (!font.synth) {
            list.splice(index, 1);
            continue;
          }
          settleFont(font);
          if (font.activeChannels.length === 0) list.splice(index, 1);
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
        fontList = [];
        tracks.clear();
        trackEntries.length = 0;
        outputs.clear();
        specs = [];
        renderFonts = [];
        neededFonts = new Set();
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