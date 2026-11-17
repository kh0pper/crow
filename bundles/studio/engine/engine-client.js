/**
 * Studio engine client — builds the worklet and posts the song to it.
 *
 * The engine is one AudioWorklet node whose processor hosts SunVox and the
 * sequencer (`studio-processor.js`). A worklet cannot `import`, so this file
 * glues these sources into ONE module and hands it to
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + resample.js + sampler-voice.js + pad-events.js + roll-clock.js
 *       + perf-fx.js + sunvox.js + spessasynth.js + font-voice.js + dynamics.js
 *       + faust-host.js + meter.js + studio-processor.js
 *
 * `resample.js` rides along so the worklet scope has the very same resampler a
 * page does (`StudioResample`), even though the conversion itself happens on
 * the client side of the port, before the PCM is handed over. `sampler-voice.js`
 * is the sampler's voice DSP, `roll-clock.js` the ROLL's timing (the one frame a
 * rolling pad's next repeat stands on) and `perf-fx.js` the performance-effects
 * bus and its looper, which the processor uses in that same scope.
 * `spessasynth.js` is the vendored SoundFont synth: one import-free classic
 * script that defines
 * `globalThis.StudioSpessa` (see `vendor/spessasynth/`), which is the only shape
 * a worklet can load; `font-voice.js` is the host that drives it, one synth per
 * font with one MIDI channel per track (plan 1d). `dynamics.js` is Crow's own
 * compressor, limiter, gate and de-esser, `faust-host.js` instantiates the
 * compiled Faust effects (both plan 1d, Tasks 7 and 8) and `meter.js` is the
 * master meter that reads the master after its inserts (Task 9); all three are
 * classic scripts like the rest.
 *
 * The compiled Faust effects themselves arrive separately: their wasm and
 * factory JSON are read here (fetched in a page, read from disk in Node) and
 * POSTED to the processor as `{type:"faust-modules", modules}` — transferred,
 * then compiled once per page on the processor's port handler, never in
 * `process()`. A host that has no `vendor/faust/` output yet (a checkout that
 * has not run `tools/build-faust.mjs`) starts without effects instead of
 * failing: a chain that wants one finds it missing (see `faust-host.js`).
 *
 * The vendored `sunvox_lib_loader.js` is deliberately NOT one of them: it keeps
 * one SunVox instance in a module-scope `svlib` (plus scratch pointers into
 * that instance's heap), so it can back only one engine per realm, while the
 * processor needs one engine per track. It talks to the `_sv_*` exports
 * directly instead.
 *
 * ## One engine per context
 *
 * `addModule()` registers the processor name on a context, and a context that
 * has been given it cannot take it again. A second `create()` on the same
 * context is therefore refused with a clear error instead of failing later
 * inside `addModule()`: reuse the engine you already have.

 * In a browser that module is a `Blob` URL; in Node it is a file in
 * `os.tmpdir()`, because node-web-audio-api's `addModule()` takes a path (or an
 * http URL) and imports it. The sources come from `assetBase` (fetched, e.g.
 * `/dashboard/studio/assets/`) or from `assetBytes` (a map of name →
 * string/Uint8Array, which is how the MCP renderer feeds its own files in).
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioEngine` for the dashboard panel and `module.exports` when
 * a CommonJS `module` exists, so Node can `require()` the same file the browser
 * `<script>` tag loads. `engine/package.json` marks this directory
 * `"type": "commonjs"` for that reason.
 *
 * ## The graph
 *
 * `engine.node` has one stereo input and one stereo output, and it is NOT
 * connected to anything by this file: the caller connects it to the destination.
 * The input is for MONITORING THROUGH THE CHAIN (plan 1d, Task 13): the page
 * connects the armed track's live input to it, and `{type:"monitor"}` names the
 * track whose inserts — amps included — and fader that signal is heard through.
 * With nothing connected the input is empty and the engine is the source it has
 * always been. No Web Audio node shapes sound anywhere in Studio (spec §5.1) —
 * the worklet's output is the engine's mix, hard-clipped, and that is the whole
 * master bus.
 *
 * ## Ready
 *
 * The processor posts `{type:"ready"}` on its port once the wasm binary has
 * compiled. Each track's SunVox engine is created from that compiled module
 * when the song arrives (one engine per track, see `studio-processor.js`), and
 * `flush()` resolves only after that work is done, so an offline render that
 * waits for both and then calls `startRendering()` renders a deterministic
 * number of frames after the engine came up.
 *
 * ## The calibration, recording and metering worklets
 *
 * More AudioWorkletProcessors ride on the same context, each loaded from its own
 * file with its own `addModule()` (never as part of the engine module, so an
 * engine that failed to come up cannot take them with it):
 *
 * - `calibrate-emitter.js` (`studio-calibrate-emitter`) clicks a loopback cable;
 * - `calibrate-detector.js` (`studio-calibrate-detector`) finds those clicks by
 *   cross-correlation and reports each one's lag in frames;
 * - `recorder-processor.js` (`studio-recorder`) turns an input into 24-bit PCM
 *   chunks of a take;
 * - `input-level.js` is not a processor at all: it is the level core the meter
 *   measures with (`globalThis.StudioInputLevel`), loaded before the file that
 *   reads it;
 * - `input-meter-processor.js` (`studio-input-meter`) posts the armed input's
 *   level and waveform columns, which is the recording lane's meter.
 *
 * `loadStudioWorklets()` below adds them once per context and remembers the
 * promise in a WeakMap, so two recorders (or a recorder and a calibration) on
 * one context do not register the same processor twice. In a browser each is
 * fetched from `${assetBase}<file>`; in Node it is read from `assetBytes` or
 * from the files next to this module (the same fallback the engine sources
 * use) and handed to `addModule()` as a private temp file.
 *
 * ## Messages
 *
 * The client's side of the port protocol (the processor's header has the
 * whole list):
 *
 * - `onPosition(listener)` follows `{type:"position", bar, beat, sixteenth,
 *   patterns, frame}`, posted at most every 50 ms of audio; `frame` is the
 *   context frame of the block the report is for.
 * - `onLaunch(listener)` follows `{type:"launched", track_id, clip_id,
 *   scene_id, bar, frame}`: one report per launch or stop the sequencer
 *   APPLIED, `frame` being the frame of the whole AudioContext (the worklet's
 *   shared `currentFrame`) where it took effect and `bar` the 0-based bar. A
 *   recorder on the same context arms from that frame.
 * - `nextBarFrame()` asks for the next bar boundary on the same clock and
 *   resolves `{frame, bar}` (0-based bar; while the transport is stopped, the
 *   frame bar 0 would start at).
 * - `setMode("session" | "arrangement")` and `seek(bar)` choose what the
 *   transport plays: the session grid, where launches arm clips, or the song's
 *   arrangement, where its placements sound on their bars. Switching mode
 *   closes every sounding note and voice; `seek()` moves the arrangement
 *   playhead, and the next block plays from that bar. A bar is read at beat
 *   resolution, so `seek(2.25)` is bar 2 beat 2; a seek moves a paused
 *   transport with it, and a session seek leaves a paused session where it is.
 * - `play()`, `pause()` and `stop()` drive the transport. `play()` starts it, or
 *   carries on from a pause. `pause()` closes every sounding note and voice but
 *   keeps the position, the clips the song has armed and the launches already
 *   queued for a later bar, so the resumed run's beat counter, its click
 *   accents and its loops keep their phase; pausing a transport that is not
 *   running (or is already paused) does nothing. `stop()` puts the transport
 *   back to the start — bar 1 in the session, the seek bar on the timeline — and
 *   is what a load that waits for Stop lands on.
 * - `setMetronome(on)` turns the engine's metronome click on or off: while the
 *   transport plays, one short click (~25 ms of a sine with a fast decay) on
 *   every quarter-note beat, 1500 Hz and louder on the first beat of an engine
 *   bar and 1000 Hz on the others. The engine's bars are four beats whatever
 *   the song's `meta.meter` says — time-signature support in the engine is a
 *   separate gap — so the click follows what the engine really plays, and it
 *   follows a tempo change with the sequencer's own clock. It is a MONITOR
 *   signal: the processor adds it to its output after the master tap, so no
 *   mix, tap, meter reading, mixdown or render ever contains it. Off by
 *   default; `server/render.js` never sends it, so a render stays click-free.
 *   It never edits the song and is not a command.
 * - `flush()` resolves once every message posted before it has been applied.
 * - `loadAudio(take_id, channels, rate)` hands the processor one take's PCM,
 *   resampled here to the context's rate when the take was recorded at another
 *   one, and resolves when the processor has it. `unloadAudio(take_id)` drops
 *   it again.
 * - `loadSample(sample_id, channels, rate)` does the very same for one sampled
 *   pad's PCM, into the processor's own sample store, and
 *   `unloadSample(sample_id)` drops it again. The song may hold 256 MB of
 *   decoded samples at once (the browser's cap; `create()` takes
 *   `maxSampleBytes` for a host that knows how much its own song needs, which
 *   an offline render does): past that the engine drops the least-recently
 *   played one, and `onSampleNeeded(listener)` says which sample a trigger
 *   wanted so the page can load it back.
 * - `loadLibrary(id, kind, bytes, options)` hands the engine one library FILE —
 *   a SoundFont bank (`kind: "font"`), a NAM capture (`kind: "nam"`, the
 *   `.nam` file's own bytes) or a cabinet IR (`kind: "ir"`, whose decoded and
 *   resampled `Float32Array` channels are passed instead of a file, with
 *   `options.sourceRate`/`options.sourceFrames` naming the rate and length of
 *   the file they came from so the one-second rule is judged there and not on
 *   the longer resampled copy) — transferred rather than copied, and resolves
 *   with what became of it:
 *   `{status: "loaded" | "deferred" | "failed", reason?}`. There is no fetch on
 *   the audio thread, so the page (or a render) reads the file and posts it
 *   here. Banks and captures are parsed ONLY while the transport is stopped (the
 *   plan's loading rule): a load posted while the song plays is answered
 *   `deferred` and parsed on the next `stop()`, which is what the page's "Loads
 *   when you stop." says. A cabinet is not parsed: its PCM is built into
 *   partitions the moment it arrives. `unloadLibrary(id)` drops one file again
 *   (and cancels a load of it that has not been parsed yet), and
 *   `onLibraryNeeded(listener)` follows the files a track or an amp insert
 *   wanted but the engine does not hold, so the page can load them (or
 *   offer a download). The processor holds at most 1 GiB of banks per page
 *   (`maxFontBytes` on `create()` for a host that knows its own window), counted
 *   as the files plus their decoded sample data: past it the least recently
 *   played font no track of the song plays is dropped and requested again, and a
 *   load comes back `failed` with the
 *   reason to show. A font that did load answers with its `presets` too —
 *   `[{bank, program, name}]`, sorted by bank then program — which is what the
 *   instrument picker lists, and `onLibraryPresets(listener)` follows them for a
 *   bank that finished loading after its asker stopped waiting (a load that
 *   waited for Stop answers `deferred` first, and its presets arrive later).
 * - `faust-modules` is posted once, by `create()`, after the engine comes up: one
 *   entry per compiled Faust effect — `{<kind>: {wasm, json}}`, the wasm
 *   transferred rather than copied — which the processor compiles once per page
 *   and the chains then instantiate inserts from (plan 1d, Task 7). `nam-wasm`
 *   is the same for the NAM engine's binary (`vendor/nam/`, Task 13): one
 *   compile per page, one instance per amp insert inside it.
 * - `monitor(track_id, on, channels)` runs the signal connected to this node's
 *   own INPUT through that track's inserts (amps included) and its fader, so the
 *   operator hears themselves through the chain while the take is still recorded
 *   dry; `channels` is the armed track's 1b input selection (1 for a
 *   one-channel input, 2 for a stereo pair) and decides an amp's mono sum.
 *   `onMonitorLatency(listener)` follows `{track_id, ms}`, the delay the chain
 *   itself adds, for the page to add to the round trip it shows.
 * - `livePad(track_id, bank, index, v, locks, source_index)` and
 *   `liveRelease(track_id, bank, index, source_index)`
 *   audition a pad from the panel: straight to the voice, never through a
 *   command or a history step, and never quantized. `index` is the pad whose
 *   sample plays; `locks` overrides that one voice's fields exactly as a step's
 *   does (C5b's `pitch`), and `source_index` names the pad the finger is on when
 *   it is not this one (a chromatic or 16-velocity press sounds one sample pad
 *   from every pad of the grid). Both are optional and both are appended, so a
 *   call that names neither is the call it always was; a release that names a
 *   source pad lets go of that press alone. `holdPad(track_id, bank,
 *   index)` latches the Gate voices that pad is sounding — the HOLD key — and
 *   answers `false` when the song has no Gate pad there, so a HOLD on a pad of
 *   another mode is refused (M15); `releaseHeld(track, bank, index)` lets that
 *   latch go again, and with no argument every latch. HOLD is page state, never
 *   song data. `pauseVoices(on)` is Pause-all: it ramps every sounding pad voice
 *   down and freezes it where it stands, and ramps it back up on resume (M17); a
 *   start made while it is on is created paused and heard on resume (M22).
 *   `resetLive()` releases the pads' live state (every loop, every HOLD and
 *   every ROLL), and the page sends it when a DIFFERENT song opens — never on an
 *   ordinary song update, which runs on every edit. `rollStart(track_id, bank,
 *   index, interval, v)` repeats one pad at a straight interval (1/4, 1/8,
 *   1/16, 1/32, 1/64) until `rollStop(track_id, bank, index)` or `rollStopAll()`,
 *   the SP-404's ROLL key: at most four pads roll at once, its answer says
 *   whether this one does, and a pad whose Loop setting is on is refused (M19).
 *   Each repeat is a step-like start, so a Gate pad's repeats carry a gate of one
 *   interval and never pile up (M18), and a repeat made under Pause-all starts
 *   paused and is heard on resume (M21, M22). ROLL is live state: never a
 *   command, never a history step, never in the song.
 *   `liveNote(track_id, p, v, on)` sounds one note on a track's device from the
 *   page's own keyboard — a press or a release, straight to the engine and never
 *   quantized. A SunVox track keeps event track 0 for the sequencer and gives a
 *   live note one of its own (1..8, picked by the engine, kept off the tracks a
 *   held note stands on and remembered against the pitch), so a live note never
 *   cuts a sequenced one and a chord stays a chord; a soundfont track plays it
 *   on its channel. A press made while all eight are held steals the oldest
 *   live note, which the engine cuts and reports dark. A release for a pitch that
 *   is not held is a no-op, and Stop sends the note-offs of what is still held. A
 *   pitch that is not a number is dropped at the client and never posted.
 * - `tap(target, on)` turns a copy of the master (`"master"`) or of one track's
 *   own output (`track_id`) on, per block, as `{type:"tap_block", target, frame,
 *   channels}`: `frame` is the context frame the block's first sample sits on,
 *   the same clock `launched` and `nextBarFrame` report in. What record-into-pad
 *   and resampling listen to. Off by default. `onTap(listener)` follows those
 *   blocks as `{target, frame, channels}`; it resolves to an unsubscribe. A tap
 *   never changes the mix it copies, and a MASTER tap copies it after the
 *   performance bus, so what it records is what the room hears.
 * - `onPadEvent(listener)` follows the pads the engine STARTED, one message per
 *   block, as `{frame, track_id, bank_id, index, kind, v?, state?}`: `kind` is
 *   `"hit"` (`v` is the effective velocity the voice played at) and `frame` is
 *   the context frame the voice starts on, in the clock `launched`,
 *   `nextBarFrame` and a position report use. The engine pushes rather than the
 *   page polling, so a light can land on the frame the hit is heard. `kind`
 *   `"state"` (with a `state` code) is a pad whose stored state changed, and
 *   `kind` `"note"` (`p` and `on`) is a note a step or a live press started or
 *   ended, carrying the frame the note stands on in that same clock (for a step
 *   its own frame, for a live press the block's first frame) so the page can
 *   paint the key on the frame the note sounds. The engine only records while
 *   somebody listens: the first subscription posts
 *   `{type:"pad_events_on", on:true}`.
 * - `fxHold(name, amount)` and `fxRelease(name)` hold or let go one performance
 *   effect (`filter_sweep`, `lofi`, `stutter`, `tape_stop`, `reverb_throw`).
 *   They are live state, never a command or a history step, and they take effect
 *   at the next block's first frame. Nothing else releases them.
 * - `looper(action)` drives the master looper: `record`, `overdub`, `play`,
 *   `stop` or `clear`, all quantized to the sequencer's next bar line.
 *   `looperTake()` resolves with `{channels, rate, bars}` — whole bars of the
 *   master the looper recorded, clipped to [−1, 1], which record-into-pad turns
 *   into a pad's sample. The looper's buffers are this page's (the audio thread
 *   allocates none): eight bars at the song's tempo are sent before the first
 *   record, and handed back and forth around a take.
 * - `onMeter(listener)` follows the master meter: every 100 ms of audio while the
 *   song plays, and once when it stops, the processor posts
 *   `{type:"meter", momentary, short_term, integrated, true_peak_db, latency_ms}`
 *   — BS.1770-4 momentary (400 ms), short-term (3 s) and integrated (gated,
 *   reset on each Play) loudness in LUFS, the true peak since the last Play in
 *   dBTP, and the delay the master chain puts on the master path in ms. It is
 *   the same measurement `server/loudness.js` makes of a render, read after the
 *   master inserts. `lastMeter()` hands back the latest reading (or null).
 * - `onMasterLatency(listener)` follows `{type:"master_latency", ms}`, posted
 *   once per master chain build: the master limiter's lookahead, which the
 *   master strip shows as its own delay.
 * - `onInsertFault(listener)` follows `{type:"insert_fault", insert_id,
 *   message}`: an insert that produced a sample that is not a finite number. It
 *   is bypassed in the ENGINE (the document is never touched), and this is said
 *   once — the message names the effect and the track, return or master.
 * - `onInsertLoading(listener)` follows `{type:"insert_loading", insert_id,
 *   message}`: a Faust insert whose compiled module the page has not posted yet.
 *   It passes audio through until the module lands, and this arrives once per
 *   insert. It is not an error and never reaches `onError` or the console: it is
 *   a load in progress, and the message names the effect and its chain.
 */
(function () {
  "use strict";

  /** The files that make up the worklet module, in concatenation order. */
  const SOURCE_FILES = [
    "sequencer.js",
    "resample.js",
    "sampler-voice.js",
    // The pad-event ring: the hits the processor records for the page's lights,
    // drained once per block (see "Pad events" in studio-processor.js). Before
    // the processor that fills it. A source file named here is also served from
    // the gateway's engine-asset whitelist (`server/web.js`, `ASSET_FILES`),
    // which is what composes the module a browser page loads.
    "pad-events.js",
    // The ROLL clock: when each rolling pad's next repeat stands, in frames (see
    // `roll-clock.js`). Before the processor that steps it.
    "roll-clock.js",
    "perf-fx.js",
    "sunvox.js",
    // The vendored SoundFont synth, before the processor that hosts it: it is
    // one import-free classic script that defines globalThis.StudioSpessa.
    "spessasynth.js",
    // The SoundFont hosts: one synth per font, one MIDI channel per track (see
    // font-voice.js). Before the processor that hosts them.
    "font-voice.js",
    // Crow's own dynamics (plan 1d, Task 8), the host for the compiled Faust
    // effects (Task 7) and the master meter that reads the master after its
    // inserts (Task 9). All classic scripts, before the processor that drives
    // them.
    "dynamics.js",
    "faust-host.js",
    "meter.js",
    // The vendored NAM engine (one import-free script defining
    // globalThis.StudioNam), the host that drives it — one compiled module and
    // one instance per amp insert (plan 1d, Task 13) — and the cabinet
    // convolver those inserts play through.
    "nam.js",
    "nam-host.js",
    "convolver.js",
    "studio-processor.js",
  ];

  /**
   * The engine sources that live outside this directory: the vendored scripts
   * `SOURCE_FILES` names, as paths from here. A Node caller that supplies no
   * `assetBytes` for one of them (a test that predates it passes only the files
   * it knows) is still handed the very same file a browser is served.
   * @type {Readonly<Object<string, string[]>>}
   */
  const VENDORED_SOURCES = Object.freeze({
    "sunvox.js": ["..", "vendor", "sunvox", "sunvox.js"],
    "spessasynth.js": ["..", "vendor", "spessasynth", "spessasynth.js"],
    "nam.js": ["..", "vendor", "nam", "nam.js"],
  });

  /**
   * The sources this engine can be built WITHOUT. `vendor/nam/` is a checked-in
   * build output (`tools/build-vendor.mjs`); a checkout that has not built it
   * still starts an engine — one whose amp inserts play silence and say so —
   * instead of failing to load at all.
   * @type {ReadonlySet<string>}
   */
  const OPTIONAL_SOURCES = new Set(["nam.js"]);

  /** What a missing optional source is replaced with, so the module still composes. */
  const OPTIONAL_SOURCE_STUB = "/* not built: see tools/build-vendor.mjs */\n";

  /**
   * The audio contexts that already have the Studio processor registered. A
   * WeakSet, so a discarded context is not kept alive by this bookkeeping.
   */
  const ENGINE_CONTEXTS = new WeakSet();

  /** What a second `create()` on the same context is told. */
  const ONE_ENGINE_ERROR = "StudioEngine: one engine per audio context; reuse the existing engine.";

  /** The wasm binary, passed to the processor as `processorOptions.wasmBinary`. */
  const WASM_FILE = "sunvox.wasm";

  /**
   * The Faust effects whose compiled wasm and factory JSON the engine loads
   * (`bundles/studio/vendor/faust/`, built by `tools/build-faust.mjs`). Their
   * names are the bundle's effect kinds; each is posted to the processor once
   * the engine is up, and compiled there (see `faust-host.js`).
   */
  const FAUST_KINDS = Object.freeze([
    "eq",
    "filter",
    "delay",
    "reverb",
    "chorus",
    "phaser",
    "saturation",
  ]);

  /** The processor name `studio-processor.js` registers. */
  const PROCESSOR_NAME = "studio-processor";

  /**
   * The worklet files loaded separately from the engine module, in load order.
   * Each is a classic script with one `registerProcessor()` call.
   */
  const WORKLET_FILES = Object.freeze([
    "calibrate-emitter.js",
    "calibrate-detector.js",
    "recorder-processor.js",
    // The level core comes before the meter that reads it: each file is its own
    // module, and `input-level.js` hands the next one its global.
    "input-level.js",
    "input-meter-processor.js",
  ]);

  /** The processor names those files register. */
  const CALIBRATE_EMITTER_PROCESSOR = "studio-calibrate-emitter";
  const CALIBRATE_DETECTOR_PROCESSOR = "studio-calibrate-detector";
  const RECORDER_PROCESSOR = "studio-recorder";
  const INPUT_METER_PROCESSOR = "studio-input-meter";

  /**
   * The audio contexts whose calibration and recording worklets are added. The
   * value is the promise of that work, so concurrent callers share one load and
   * a failed load can be retried. A WeakMap, so a discarded context is not kept
   * alive by this bookkeeping.
   * @type {WeakMap<BaseAudioContext, Promise<void>>}
   */
  const WORKLET_CONTEXTS = new WeakMap();

  /**
   * The resampling workers this page has, one per asset base. A worker keeps
   * its own copy of `resample.js`, so a long take is converted off the page's
   * main thread (a frozen panel is a frozen transport and a frozen history).
   * @type {Map<string, {worker: Worker, pending: Map<number, object>}>}
   */
  const RESAMPLE_WORKERS = new Map();

  /** The id of the last conversion sent to a worker. */
  let RESAMPLE_SEQ = 0;

  /** How many clicks a calibration plays when the caller names none. */
  const DEFAULT_CALIBRATION_CLICKS = 16;

  /** The first clicks of a calibration are not measured: a cold chain is noisy. */
  const IGNORED_CALIBRATION_CLICKS = 2;

  /** Fewer heard clicks than this and there is no measurement to trust. */
  const MIN_CALIBRATION_CLICKS = 10;

  /** The gap between calibration clicks when the caller names none, in seconds. */
  const DEFAULT_CALIBRATION_INTERVAL_SECONDS = 0.5;

  /** A loopback whose lags spread wider than this (in seconds) is not stable. */
  const MAX_CALIBRATION_SPREAD_SECONDS = 0.002;

  /** What a calibration that measured nothing usable is refused with. */
  const CALIBRATION_REFUSAL = "Check the loopback cable and the input gain.";

  /** How long to wait for the worklet to report ready. */
  const READY_TIMEOUT_MS = 20000;

  /** A song can have at most this many SunVox tracks (one engine each). */
  const MAX_TRACKS = 16;

  /** Four beats to the bar, everywhere in Studio. */
  const BEATS_PER_BAR = 4;

  /** The tempo a song without a usable `meta.bpm` is measured at. */
  const DEFAULT_BPM = 120;

  /** How many bars the looper's buffers hold: the longest take it records. */
  const LOOPER_BARS = 8;

  /**
   * How many pads may ROLL at once: the engine's own limit, worked out here too so
   * the page can be answered without a round trip to the audio thread.
   */
  const MAX_ROLLS = 4;

  /**
   * The key one pad lives under in a song's `pads` container — the very key
   * `server/doc.js` writes and `studio-processor.js` looks a pad up with. This
   * side of the port builds the same one, so `holdPad` can answer whether a pad
   * is a Gate pad without waiting for the audio thread.
   * @param {unknown} trackId
   * @param {unknown} bankId
   * @param {unknown} index
   * @returns {string}
   */
  function padKeyOf(trackId, bankId, index) {
    const track = trackId === undefined || trackId === null ? "" : String(trackId);
    const bank = bankId === undefined || bankId === null ? "" : String(bankId);
    return track + "/" + bank + "/" + Math.trunc(Number(index) || 0);
  }

  /**
   * The page's own copy of one looper-take channel, clipped to [−1, 1].
   *
   * The looper taps the master BEFORE the clip, so a take can hold values past
   * full scale; what the page keeps is clipped, so a pad made from a take is
   * never louder than full scale. The copy is the page's: the processor's buffers
   * are handed straight back, and the looper plays on from them.
   * @param {Float32Array|ArrayBufferView|null} buffer the transferred channel
   * @param {number} frames how many frames of it to copy
   * @returns {Float32Array} the clipped copy (empty when there is no buffer)
   */
  function copyLooperChannel(buffer, frames) {
    const length = Math.max(0, Math.trunc(Number(frames) || 0));
    const copy = new Float32Array(length);
    if (!buffer || typeof buffer.length !== "number") return copy;
    const count = Math.min(length, buffer.length);
    for (let at = 0; at < count; at += 1) {
      const value = buffer[at];
      copy[at] = value > 1 ? 1 : value < -1 ? -1 : value;
    }
    return copy;
  }

  /**
   * The presets a loaded bank announced, kept to the three fields the instrument
   * picker needs: `{bank, program, name}`, with whole numbers inside MIDI's range.
   * Anything else in a message is dropped rather than trusted.
   * @param {unknown[]} list what the processor posted
   * @returns {Array<{bank: number, program: number, name: string}>}
   */
  function presetsOf(list) {
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const bank = Math.trunc(Number(item.bank));
      const program = Math.trunc(Number(item.program));
      if (!Number.isFinite(bank) || !Number.isFinite(program)) continue;
      out.push({
        bank: Math.min(128, Math.max(0, bank)),
        program: Math.min(127, Math.max(0, program)),
        name: item.name === undefined || item.name === null ? "" : String(item.name),
      });
    }
    return out;
  }

  /** @returns {boolean} whether this script runs in Node rather than a browser. */
  function isNode() {
    return typeof process !== "undefined" && !!(process && process.versions && process.versions.node);
  }

  /**
   * The cores this PAGE reports, for a NAM capture's slim size (plan 1d,
   * Task 13). A page with four cores or fewer plays the smallest submodel of an
   * A2 capture; everything else plays the full one, and a NODE host reports 0 — a
   * render must not depend on the machine it runs on. The worklet scope has no
   * `navigator`, which is why this is measured here and handed down.
   * @returns {number}
   */
  function pageCores() {
    if (isNode()) return 0;
    try {
      const cores = Number(globalThis.navigator && globalThis.navigator.hardwareConcurrency);
      return Number.isFinite(cores) && cores > 0 ? Math.round(cores) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * The core count the engine is built with: a caller's own `namCores` when it
   * names one (a render and a parity test pin it, so neither depends on the
   * machine), else this page's.
   * @param {{namCores?: number}} options
   * @returns {number}
   */
  function namCoresOf(options) {
    const asked = Number(options && options.namCores);
    if (Number.isFinite(asked) && asked >= 0) return Math.round(asked);
    return pageCores();
  }

  /** @returns {Function|null} Node's `require`, when this script has one. */
  function nodeRequire() {
    return typeof require === "function" ? require : null;
  }

  /** @returns {string} a URL for one asset under a base, with one separator. */
  function joinUrl(base, name) {
    const text = String(base);
    return text.endsWith("/") ? text + name : text + "/" + name;
  }

  /** @returns {string} text from a string, ArrayBuffer or typed array. */
  function textOf(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.textContent === "string") return value.textContent;
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
    }
    throw new Error("StudioEngine: expected text or bytes");
  }

  /** @returns {Uint8Array} bytes from bytes, an ArrayBuffer or text. */
  function bytesOf(value) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error("StudioEngine: expected bytes");
  }

  /**
   * Read one source file as text, from `assetBytes` when the caller supplied
   * bytes, else from `assetBase` over fetch.
   *
   * A Node caller that names neither (the offline renderer predates
   * `resample.js` and passes only the files it knows) is served the copy that
   * sits next to this module: the engine sources are its own neighbours, so the
   * file it left out is still the same file the render is meant to run.
   * @param {string} name
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<string>}
   */
  async function readText(name, options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[name] !== undefined) return textOf(supplied[name]);
    if (!options.assetBase) {
      const local = readLocalText(name);
      if (local !== null) return local;
      if (OPTIONAL_SOURCES.has(name)) return OPTIONAL_SOURCE_STUB;
      throw new Error(`StudioEngine: no ${name} in assetBytes and no assetBase`);
    }
    const response = await fetch(joinUrl(options.assetBase, name));
    if (!response.ok) {
      if (OPTIONAL_SOURCES.has(name) && response.status === 404) return OPTIONAL_SOURCE_STUB;
      throw new Error(`StudioEngine: could not load ${name} (${response.status})`);
    }
    return response.text();
  }

  /**
   * One engine source file from the directory this module lives in, in Node.
   * @param {string} name
   * @returns {string|null} the text, or null when this host has no such file
   */
  function readLocalText(name) {
    const req = nodeRequire();
    if (!req || typeof __dirname !== "string" || __dirname === "") return null;
    try {
      const fs = req("node:fs");
      const path = req("node:path");
      // Only a plain file name: a caller's name is never turned into a path
      // outside this module's own directory. A vendored source's path is fixed
      // here, never taken from the caller.
      if (name !== path.basename(name)) return null;
      const file = VENDORED_SOURCES[name]
        ? path.join(__dirname, ...VENDORED_SOURCES[name])
        : path.join(__dirname, name);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Read the wasm binary.
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<ArrayBuffer>}
   */
  async function readWasm(options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[WASM_FILE] !== undefined) {
      const bytes = bytesOf(supplied[WASM_FILE]);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (!options.assetBase) throw new Error(`StudioEngine: no ${WASM_FILE} in assetBytes and no assetBase`);
    const response = await fetch(joinUrl(options.assetBase, WASM_FILE));
    if (!response.ok) throw new Error(`StudioEngine: could not load ${WASM_FILE} (${response.status})`);
    return response.arrayBuffer();
  }

  /**
   * The NAM engine's binary (`vendor/nam/nam-engine.wasm`), or null when this
   * checkout has not built it. It is transferred to the processor through the
   * port — a worklet has no fetch — and compiled there once per page (plan 1d,
   * Task 13).
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<ArrayBuffer|null>}
   */
  async function readNamEngine(options) {
    return readOptionalBytes("nam-engine.wasm", ["..", "vendor", "nam", "nam-engine.wasm"], options);
  }

  /**
   * The file one vendored asset sits at, in Node: a path built from this
   * module's own directory, or null in a host with no filesystem (a browser or a
   * worklet scope).
   * @param {string[]} parts the path segments, relative to this directory
   * @returns {string|null}
   */
  function localPathOf(parts) {
    const req = nodeRequire();
    if (!req || typeof __dirname !== "string" || __dirname === "") return null;
    try {
      return req("node:path").join(__dirname, ...parts);
    } catch {
      return null;
    }
  }

  /**
   * One OPTIONAL asset's bytes: whatever the host has, or null. The Faust
   * effects are optional in the sense that a checkout without the build output
   * still starts an engine — it just has no Faust inserts (see the file header).
   * @param {string} name the asset name (what `assetBytes` and `assetBase` use)
   * @param {string[]} localParts where `build-faust.mjs` wrote it, from here
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<ArrayBuffer|null>}
   */
  async function readOptionalBytes(name, localParts, options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[name] !== undefined) {
      const bytes = bytesOf(supplied[name]);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (options.assetBase) {
      try {
        const response = await fetch(joinUrl(options.assetBase, name));
        if (response.ok) return await response.arrayBuffer();
      } catch {
        /* no such asset on this host: the engine starts without it */
      }
      return null;
    }
    const file = localPathOf(localParts);
    const req = nodeRequire();
    if (!file || !req) return null;
    try {
      const fs = req("node:fs");
      if (!fs.existsSync(file)) return null;
      const bytes = new Uint8Array(fs.readFileSync(file));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } catch {
      return null;
    }
  }

  /**
   * One OPTIONAL asset as text — the factory JSON that goes with a compiled
   * effect.
   * @param {string} name the asset name
   * @param {string[]} localParts where `build-faust.mjs` wrote it, from here
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<string|null>}
   */
  async function readOptionalText(name, localParts, options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[name] !== undefined) return textOf(supplied[name]);
    if (options.assetBase) {
      try {
        const response = await fetch(joinUrl(options.assetBase, name));
        if (response.ok) return await response.text();
      } catch {
        /* no such asset on this host */
      }
      return null;
    }
    const file = localPathOf(localParts);
    const req = nodeRequire();
    if (!file || !req) return null;
    try {
      const fs = req("node:fs");
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * The compiled Faust effects this host can hand the processor: one entry per
   * effect whose wasm AND factory JSON are both here. A checkout that has not run
   * `tools/build-faust.mjs` has none, and the engine starts anyway.
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<Object<string, {wasm: ArrayBuffer, json: string}>>}
   */
  async function readFaustModules(options) {
    const modules = {};
    for (const kind of FAUST_KINDS) {
      const wasm = await readOptionalBytes(
        `faust-${kind}.wasm`,
        ["..", "vendor", "faust", `${kind}.wasm`],
        options,
      );
      if (!wasm) continue;
      const json = await readOptionalText(
        `faust-${kind}.json`,
        ["..", "vendor", "faust", `${kind}.json`],
        options,
      );
      if (!json) continue;
      modules[kind] = { wasm: wasm, json: json };
    }
    return modules;
  }

  /** A counter so two engines in one Node process never share a temp path. */
  /**
   * Write the glue module to a temp file and return its path.
   *
   * node-web-audio-api imports the path it is given, so the file has to exist
   * for the whole `addModule()` call. The name ends in `.mjs` so Node treats it
   * as an ES module whatever is above `os.tmpdir()`.
   * @param {string} source
   * @returns {{path: string, remove: () => void}}
   */
  function writeTempModule(source) {
    const fs = nodeRequire()("node:fs");
    const os = nodeRequire()("node:os");
    const path = nodeRequire()("node:path");
    // A private 0700 directory per module and an exclusive 0600 create: a
    // predictable name in the shared tmp dir could be pre-created or swapped
    // by another local user, and this file is imported as code.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-engine-"));
    const file = path.join(dir, "engine.mjs");
    fs.writeFileSync(file, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      path: file,
      remove: function remove() {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* the module is imported; a leftover private dir in tmp is harmless */
        }
      },
    };
  }

  /**
   * Whether a value is a `MediaStream` (a microphone or interface input).
   * @param {unknown} value
   * @returns {boolean}
   */
  function isMediaStream(value) {
    if (!value || typeof value !== "object") return false;
    if (typeof MediaStream !== "undefined" && value instanceof MediaStream) return true;
    // node-web-audio-api's MediaStream is not a DOM global, but it is shaped
    // the same way; an AudioNode has `connect` and no tracks.
    return typeof value.getAudioTracks === "function";
  }

  /**
   * @param {unknown} value a caller's number
   * @param {number} fallback the value to use when it is not a number
   * @param {number} minimum the smallest value allowed
   * @returns {number} a whole number, at least `minimum`
   */
  function wholeAtLeast(value, fallback, minimum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const whole = Math.round(number);
    return whole < minimum ? minimum : whole;
  }

  /**
   * @param {unknown} value a frame a caller asked for
   * @param {string} what the method's name, for the error
   * @returns {number} a whole frame number
   */
  function frameNumber(value, what) {
    const frame = Number(value);
    if (!Number.isFinite(frame)) throw new Error(`StudioEngine: ${what} needs a frame number`);
    return Math.trunc(frame);
  }

  /**
   * The median of an ascending list of whole frames.
   * @param {number[]} sorted
   * @returns {number}
   */
  function medianOf(sorted) {
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  /**
   * Add one of `WORKLET_FILES` to a context: a URL in a browser, a private temp
   * file in Node (where `addModule()` takes a path).
   * @param {BaseAudioContext} context
   * @param {string} name
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<void>}
   */
  async function addWorkletFile(context, name, options) {
    const opts = options || {};
    if (isNode()) {
      const source = await readText(name, opts);
      const temp = writeTempModule(source);
      try {
        await context.audioWorklet.addModule(temp.path);
      } finally {
        temp.remove();
      }
      return;
    }
    if (!opts.assetBase) throw new Error(`StudioEngine: loading ${name} needs an assetBase in this host`);
    await context.audioWorklet.addModule(joinUrl(opts.assetBase, name));
  }

  /**
   * Add the calibration and recording worklets to a context, once. A second
   * call on the same context (a recorder after a calibration, two recorders)
   * waits for the first load instead of registering anything again.
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} [options]
   * @returns {Promise<void>}
   */
  function loadStudioWorklets(context, options) {
    if (!context || !context.audioWorklet) {
      throw new Error("StudioEngine: a context with audioWorklet is required");
    }
    const loading = WORKLET_CONTEXTS.get(context);
    if (loading) return loading;
    const pending = (async () => {
      for (const name of WORKLET_FILES) await addWorkletFile(context, name, options);
    })();
    WORKLET_CONTEXTS.set(context, pending);
    // A failed load registered nothing, so a retry on this context is honest.
    pending.catch(() => WORKLET_CONTEXTS.delete(context));
    return pending;
  }

  /**
   * The resampler this host has: the page (or worklet) global in a browser,
   * this module's neighbour in Node. It is the same arithmetic either way — see
   * `resample.js`.
   * @returns {{toRate: function(Float32Array[], number, number): Float32Array[]}}
   */
  function resamplerOf() {
    const shared = typeof globalThis !== "undefined" ? globalThis.StudioResample : null;
    if (shared && typeof shared.toRate === "function") return shared;
    const req = nodeRequire();
    if (req) {
      try {
        const local = req("./resample.js");
        if (local && typeof local.toRate === "function") return local;
      } catch {
        /* fall through to the error below */
      }
    }
    throw new Error("StudioEngine: resampling needs StudioResample (engine/resample.js) in this host");
  }

  /**
   * This host's resampling worker, built on first use.
   *
   * A worker is the only way to keep a long take's conversion off the page's
   * main thread. A host without `Worker` (Node), a refusal to construct one,
   * or a failed error are all answered with null, and the caller converts
   * inline instead.
   * @param {string} assetBase the URL prefix the worker's own script is at
   * @returns {{worker: Worker, pending: Map<number, object>}|null}
   */
  function resampleWorker(assetBase) {
    const url = joinUrl(assetBase, "resample-worker.js");
    const held = RESAMPLE_WORKERS.get(url);
    if (held) return held;
    if (typeof Worker !== "function") return null;
    let worker = null;
    try {
      worker = new Worker(url);
    } catch {
      return null;
    }
    const entry = { worker: worker, pending: new Map() };
    worker.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object" || message.id === undefined) return;
      const settle = entry.pending.get(message.id);
      if (!settle) return;
      entry.pending.delete(message.id);
      if (message.error) settle.reject(new Error("StudioEngine: " + String(message.error)));
      else settle.resolve(message.channels);
    };
    // A worker that never loads (a 404, a policy refusal) rejects the loads
    // waiting on it and is forgotten, so the next one converts inline.
    worker.onerror = () => {
      const waiting = Array.from(entry.pending.values());
      entry.pending.clear();
      RESAMPLE_WORKERS.delete(url);
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      for (const settle of waiting) settle.reject(new Error("StudioEngine: the resampling worker failed"));
    };
    RESAMPLE_WORKERS.set(url, entry);
    return entry;
  }

  /**
   * Convert one take's channels in the page's resampling worker.
   *
   * The input arrays are copied by the port rather than transferred: a worker
   * that fails after it has received them would otherwise leave the caller's
   * fallback with detached buffers. The worker's own output IS transferred.
   * @param {string} assetBase
   * @param {Float32Array[]} channels
   * @param {number} from the rate they are at, in Hz
   * @param {number} to the rate they are wanted at, in Hz
   * @returns {Promise<Float32Array[]>}
   */
  function resampleInWorker(assetBase, channels, from, to) {
    const entry = resampleWorker(assetBase);
    if (!entry) return Promise.reject(new Error("StudioEngine: this host has no resampling worker"));
    const id = (RESAMPLE_SEQ += 1);
    return new Promise((resolve, reject) => {
      entry.pending.set(id, { resolve: resolve, reject: reject });
      try {
        entry.worker.postMessage({ id: id, channels: channels, from: from, to: to });
      } catch (error) {
        entry.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * `addModule()` with a Blob URL in a browser and a temp file in Node.
   * @param {BaseAudioContext} context
   * @param {string} source
   * @returns {Promise<void>}
   */
  async function addEngineModule(context, source) {
    if (isNode()) {
      const temp = writeTempModule(source);
      try {
        await context.audioWorklet.addModule(temp.path);
      } finally {
        temp.remove();
      }
      return;
    }
    if (typeof Blob !== "function" || typeof URL === "undefined" || !URL.createObjectURL) {
      throw new Error("StudioEngine: this host has neither require() nor Blob URLs");
    }
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** @returns {Function} the AudioWorkletNode constructor of this host. */
  function workletNodeClass() {
    if (typeof globalThis.AudioWorkletNode === "function") return globalThis.AudioWorkletNode;
    const req = nodeRequire();
    if (req) {
      const module = req("node-web-audio-api");
      if (module && typeof module.AudioWorkletNode === "function") return module.AudioWorkletNode;
    }
    throw new Error("StudioEngine: no AudioWorkletNode in this host");
  }

  /**
   * Wait for the processor's `ready`, failing on `error` or a timeout.
   * @param {AudioWorkletNode} node
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  function awaitReady(node, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (settle, value) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        // `onmessage` is used rather than addEventListener because it starts
        // the port on both hosts (Node's MessagePort does not auto-start an
        // addEventListener subscriber).
        node.port.onmessage = null;
        settle(value);
      };
      timer = setTimeout(() => {
        done(reject, new Error(`StudioEngine: the engine was not ready within ${timeoutMs} ms`));
      }, timeoutMs);
      node.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") done(resolve, undefined);
        else if (message.type === "error") done(reject, new Error("StudioEngine: " + message.error));
      };
      if (typeof node.port.start === "function") node.port.start();
    });
  }

  /**
   * Build the engine's worklet module and wait for the engine to come up.
   *
   * @param {BaseAudioContext} context an AudioContext or OfflineAudioContext
   * @param {{assetBase?: string, assetBytes?: object, readyTimeoutMs?: number,
   *          testHooks?: boolean, maxSampleBytes?: number, maxFontBytes?: number}} options
   *   `assetBase` is a URL prefix the engine files are fetched from;
   *   `assetBytes` is a map of file name → string/Uint8Array, which wins over
   *   `assetBase` for the names it holds (Node callers read the files
   *   themselves); `testHooks` arms the processor's test-only faults;
   *   `maxSampleBytes` is the song-wide cap on decoded samples, the browser's
   *   256 MB when omitted (an offline render passes the bytes its window needs);
   *   `maxFontBytes` is the cap on the library banks parsed in the engine, the
   *   plan's 1 GiB when omitted (an offline render passes its own font window)
   * @returns {Promise<{node: AudioWorkletNode,
   *                    setSong: function(object): void,
   *                    launchScene: function(string): void,
   *                    launchClip: function(string): void,
   *                    stopTrack: function(string): void,
   *                    stopAll: function(): void,
   *                    play: function(): void,
   *                    stop: function(): void,
   *                    resetLive: function(): void,
   *                    pauseVoices: function(boolean): void,
   *                    rollStart: function(string, string, number, string, number): boolean,
   *                    rollStop: function(string, string, number): void,
   *                    rollStopAll: function(): void,
   *                    setMode: function(string): void,
   *                    seek: function(number): void,
   *                    setMetronome: function(boolean): void,
   *                    flush: function(): Promise<void>,
   *                    onPosition: function(function): function,
   *                    onLaunch: function(function): function,
   *                    nextBarFrame: function(): Promise<{frame: number, bar: number}>,
   *                    onTap: function(function): function,
   *                    onPadEvent: function(function): function,
 *                    onMeter: function(function): function,
 *                    lastMeter: function(): (object|null),
 *                    onMasterLatency: function(function): function,
 *                    onInsertFault: function(function): function,
 *                    onInsertLoading: function(function): function,
  *                    loadLibrary: function(string, string, Uint8Array): Promise<{status: string, reason?: string}>,
 *                    unloadLibrary: function(string): void,
 *                    onLibraryNeeded: function(function): function,
 *                    monitor: function(string, boolean): void,
 *                    onMonitorLatency: function(function): function,
   *                    fxHold: function(string, number): void,
   *                    fxRelease: function(string): void,
   *                    looper: function(string): void,
   *                    looperTake: function(): Promise<{channels: Float32Array[],
   *                      rate: number, bars: number}>,
   *                    onError: function(function): function,
   *                    calibrate: function(object): Promise<object>,
   *                    createRecorder: function(object): Promise<object>,
   *                    createInputMeter: function(object): Promise<object>,
   *                    throwForTest: function(): void,
   *                    dispose: function(): void}>}
   */
  /**
   * The worklet module: the source files joined in order. One blank line and a
   * semicolon between files: every one of them is a classic script that relies
   * on its own final expression, and the SunVox glue ends without a trailing
   * semicolon.
   * @param {string[]} texts - the SOURCE_FILES contents, in order
   * @returns {string}
   */
  function composeEngineModule(texts) {
    return texts.join("\n;\n");
  }

  /**
   * A loopback calibration: click out of the destination, listen on `input`,
   * and measure the lag of each click the detector finds.
   *
   * `options.input` is a MediaStream (wrapped in a MediaStreamAudioSourceNode —
   * allowed as an input source only) or, in a Node test, an AudioNode. The
   * clicks go out through the emitter on frame `first_frame` and every
   * `interval_frames` after that; the first two are ignored, and the rest give
   * the median lag, the spread and how many were heard.
   *
   * An offline context renders nothing on its own, so this starts
   * `startRendering()` itself in that case (and waits for it). A realtime
   * context just plays.
   *
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} engineOptions
   * @param {{input?: MediaStream|AudioNode, clicks?: number, latencyHint?: string,
   *          sinkId?: string, interval?: number,
   *          onEmitter?: function(AudioWorkletNode): void}} [options]
   *   `interval` is the gap between clicks in milliseconds; `onEmitter` is
   *   handed the emitter node so a host without a cable (a Node test) can route
   *   it through a stand-in delay. `latencyHint` and `sinkId` are only reported
   *   back in the result: they describe the context the caller made, which is
   *   what the panel stores the measurement under
   * @param {(text: string) => void} notifyError
   * @returns {Promise<{latency_frames: number, rate: number, spread_frames: number,
   *                    clicks_heard: number, latencyHint: string|null,
   *                    sinkId: string|null}>}
   */
  async function runCalibration(context, engineOptions, options, notifyError) {
    const settings = options || {};
    const input = settings.input;
    if (!input) throw new Error("StudioEngine: calibrate needs an input (a MediaStream or an AudioNode)");

    const clicks = wholeAtLeast(settings.clicks, DEFAULT_CALIBRATION_CLICKS, 1);
    const intervalFrames = wholeAtLeast(
      settings.interval === undefined || settings.interval === null
        ? undefined
        : (Number(settings.interval) * context.sampleRate) / 1000,
      Math.round(context.sampleRate * DEFAULT_CALIBRATION_INTERVAL_SECONDS),
      1,
    );
    // Only the clicks after the first two are measured; a caller asking for 2 or
    // fewer has nothing counted at all.
    const counted = Math.max(0, clicks - IGNORED_CALIBRATION_CLICKS);

    await loadStudioWorklets(context, engineOptions);
    const Node = workletNodeClass();
    const emitter = new Node(context, CALIBRATE_EMITTER_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { interval_frames: intervalFrames, first_frame: intervalFrames, clicks: clicks },
    });
    const detector = new Node(context, CALIBRATE_DETECTOR_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    let source = null;
    let alone = null;
    let rendering = null;
    let renderError = null;
    let timer = null;
    const responses = new Map();
    let resolveResponses = null;
    const allAnswered = new Promise((resolve) => {
      resolveResponses = resolve;
    });
    const checkAnswers = () => {
      if (responses.size >= counted) resolveResponses(undefined);
    };

    try {
      if (typeof input.connect === "function") {
        input.connect(detector);
      } else if (isMediaStream(input)) {
        if (typeof context.createMediaStreamSource !== "function") {
          throw new Error("StudioEngine: this host cannot read a MediaStream");
        }
        source = context.createMediaStreamSource(input);
        source.connect(detector);
      } else {
        throw new Error("StudioEngine: calibrate needs a MediaStream or an AudioNode as its input");
      }

      // The detector outputs silence; the gain of 0 is only there so the graph
      // pulls the detector on a host that runs nothing unreachable.
      alone = context.createGain();
      alone.gain.value = 0;
      detector.connect(alone);
      alone.connect(context.destination);

      emitter.connect(context.destination);
      if (typeof settings.onEmitter === "function") settings.onEmitter(emitter);

      let seen = 0;
      emitter.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "error") {
          notifyError(String(message.error));
          return;
        }
        if (message.type !== "click") return;
        seen += 1;
        if (seen <= IGNORED_CALIBRATION_CLICKS) return;
        detector.port.postMessage({ type: "expect", frame: message.frame });
      };
      detector.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "error") {
          notifyError(String(message.error));
          return;
        }
        if (message.type !== "heard" && message.type !== "missed") return;
        if (responses.has(message.frame)) return;
        responses.set(
          message.frame,
          message.type === "heard"
            ? { heard: true, lag: Math.round(Number(message.lag_frames)) }
            : { heard: false },
        );
        checkAnswers();
      };
      if (typeof emitter.port.start === "function") emitter.port.start();
      if (typeof detector.port.start === "function") detector.port.start();

      // An offline context renders nothing until it is told to; a realtime one
      // is already running. Either way, a realtime calibration that never
      // finishes gets a wall-clock guard instead of hanging for ever.
      const offline = typeof context.startRendering === "function";
      if (offline) {
        rendering = context
          .startRendering()
          .then(
            () => undefined,
            (error) => {
              renderError = error;
            },
          )
          .then(() => {
            // Let the reports posted before the render ended reach this thread,
            // then settle with what arrived: the rest were never measured.
            setTimeout(() => resolveResponses(undefined), 0);
          });
      } else {
        const schedule = (clicks * intervalFrames * 1000) / context.sampleRate;
        timer = setTimeout(() => resolveResponses(undefined), Math.round(schedule * 1.5) + 1000);
      }
      if (counted === 0) resolveResponses(undefined);

      await allAnswered;
      if (rendering) await rendering;
      if (renderError) throw renderError;

      const lags = [];
      for (const answer of responses.values()) if (answer.heard) lags.push(answer.lag);
      lags.sort((left, right) => left - right);
      const result = {
        latency_frames: medianOf(lags),
        rate: context.sampleRate,
        spread_frames: lags.length > 1 ? lags[lags.length - 1] - lags[0] : 0,
        clicks_heard: lags.length,
        latencyHint: settings.latencyHint === undefined || settings.latencyHint === null ? null : settings.latencyHint,
        sinkId: settings.sinkId === undefined || settings.sinkId === null ? null : settings.sinkId,
      };
      if (lags.length < MIN_CALIBRATION_CLICKS || result.spread_frames > Math.round(MAX_CALIBRATION_SPREAD_SECONDS * context.sampleRate)) {
        throw new Error(CALIBRATION_REFUSAL);
      }
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
      try {
        emitter.port.onmessage = null;
      } catch {
        /* nothing to drop */
      }
      try {
        detector.port.onmessage = null;
      } catch {
        /* nothing to drop */
      }
      try {
        emitter.disconnect();
      } catch {
        /* never connected */
      }
      try {
        detector.disconnect();
      } catch {
        /* never connected */
      }
      if (alone) {
        try {
          alone.disconnect();
        } catch {
          /* never connected */
        }
      }
      if (source) {
        try {
          source.disconnect();
        } catch {
          /* never connected */
        }
      }
    }
  }

  /**
   * A recorder on this context: an input in, 24-bit take chunks out.
   *
   * The caller arms it on a frame the engine reported (`onLaunch`, Task 2) and
   * stops it on a frame it computes itself (a take's `offset_frames` included,
   * so the compensated take keeps its tail). `splitAt` cuts one recording into
   * one take segment per loop pass.
   *
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} engineOptions
   * @param {{input?: MediaStream|AudioNode, channels?: number}} [options]
   * @param {(text: string) => void} notifyError
   * @returns {Promise<{node: AudioWorkletNode,
   *                    armAt: function(number): void,
   *                    stopAt: function(number): void,
   *                    splitAt: function(number[]): void,
   *                    onChunk: function(function): function,
   *                    onDone: function(function): function,
   *                    dispose: function(): void}>}
   */
  async function runRecorder(context, engineOptions, options, notifyError) {
    const settings = options || {};
    const input = settings.input;
    if (!input) throw new Error("StudioEngine: createRecorder needs an input (a MediaStream or an AudioNode)");
    const channels = Number(settings.channels) === 2 ? 2 : 1;

    await loadStudioWorklets(context, engineOptions);
    const Node = workletNodeClass();
    const node = new Node(context, RECORDER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: "explicit",
      processorOptions: { channels: channels },
    });

    let source = null;
    // The recorder writes silence to its output, but a host only runs the
    // processors the destination can reach, so it is connected through a gain of
    // 0. A gain node is plumbing (it shapes nothing), which the parity rule
    // allows.
    const alone = context.createGain();
    alone.gain.value = 0;
    if (typeof input.connect === "function") {
      input.connect(node);
    } else if (isMediaStream(input)) {
      if (typeof context.createMediaStreamSource !== "function") {
        throw new Error("StudioEngine: this host cannot read a MediaStream");
      }
      source = context.createMediaStreamSource(input);
      source.connect(node);
    } else {
      throw new Error("StudioEngine: createRecorder needs a MediaStream or an AudioNode as its input");
    }
    node.connect(alone);
    alone.connect(context.destination);

    const chunkListeners = new Set();
    const doneListeners = new Set();
    node.port.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "chunk") {
        for (const listener of chunkListeners) {
          try {
            listener(message.bytes, message.index, message.segment);
          } catch {
            /* one bad listener must not lose the chunk for the others */
          }
        }
        return;
      }
      if (message.type === "done") {
        const segments = Array.isArray(message.segments) ? message.segments : [];
        let frames = 0;
        for (const segment of segments) frames += Number(segment.frames) || 0;
        const done = {
          segments: segments,
          frames: frames,
          start_frame: segments.length > 0 ? segments[0].start_frame : null,
        };
        for (const listener of doneListeners) {
          try {
            listener(done);
          } catch {
            /* one bad listener must not hide the end from the others */
          }
        }
        return;
      }
      if (message.type === "error") notifyError(String(message.error));
    };
    if (typeof node.port.start === "function") node.port.start();

    const post = (message) => node.port.postMessage(message);

    return {
      node: node,

      /** @param {number} frame the context frame to start capturing at @returns {void} */
      armAt(frame) {
        post({ type: "arm", frame: frameNumber(frame, "armAt") });
      },

      /** @param {number} frame the context frame to stop at (exclusive) @returns {void} */
      stopAt(frame) {
        post({ type: "stop", frame: frameNumber(frame, "stopAt") });
      },

      /**
       * Start a new take segment at each of these context frames (loop record).
       * @param {number[]} frames
       * @returns {void}
       */
      splitAt(frames) {
        const list = [];
        for (const value of Array.isArray(frames) ? frames : []) list.push(frameNumber(value, "splitAt"));
        post({ type: "split", frames: list });
      },

      /**
       * Follow the take's chunks: `listener(bytes, index, segment)`, where
       * `bytes` is a transferred ArrayBuffer of 24-bit little-endian interleaved
       * PCM covering whole frames, at most 1 MiB.
       * @param {(bytes: ArrayBuffer, index: number, segment: number) => void} listener
       * @returns {() => void} unsubscribe
       */
      onChunk(listener) {
        if (typeof listener !== "function") return function noop() {};
        chunkListeners.add(listener);
        return function unsubscribe() {
          chunkListeners.delete(listener);
        };
      },

      /**
       * Follow the end of the take: `listener({segments, frames, start_frame})`.
       * @param {(done: {segments: object[], frames: number,
       *                start_frame: number|null}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onDone(listener) {
        if (typeof listener !== "function") return function noop() {};
        doneListeners.add(listener);
        return function unsubscribe() {
          doneListeners.delete(listener);
        };
      },

      /**
       * Leave the graph and drop this recorder's callbacks. The caller owns the
       * input stream and the context.
       * @returns {void}
       */
      dispose() {
        chunkListeners.clear();
        doneListeners.clear();
        node.port.onmessage = null;
        try {
          node.disconnect();
        } catch {
          /* never connected */
        }
        try {
          alone.disconnect();
        } catch {
          /* never connected */
        }
        if (source) {
          try {
            source.disconnect();
          } catch {
            /* never connected */
          }
        }
      },
    };
  }

  /**
   * An input meter on this context: the armed input in, level payloads out.
   *
   * The reading is the DRY input (a take is the dry signal), so the recording
   * lane's meter, peak hold and live waveform all come from one node on the
   * record target's input and nowhere else. The page turns it on while the
   * lanes widget is shown and off otherwise, so a hidden lane — or one on a
   * track that is not the record target — costs only `process()`.
   *
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} engineOptions
   * @param {{input?: MediaStream|AudioNode, channels?: number}} [options]
   * @param {(text: string) => void} notifyError
   * @returns {Promise<{node: AudioWorkletNode,
   *                    onLevel: function(function): function,
   *                    setActive: function(boolean): void,
   *                    clearClip: function(): void,
   *                    dispose: function(): void}>}
   */
  async function runInputMeter(context, engineOptions, options, notifyError) {
    const settings = options || {};
    const input = settings.input;
    if (!input) throw new Error("StudioEngine: createInputMeter needs an input (a MediaStream or an AudioNode)");
    const channels = Number(settings.channels) === 2 ? 2 : 1;

    await loadStudioWorklets(context, engineOptions);
    const Node = workletNodeClass();
    const node = new Node(context, INPUT_METER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: "explicit",
      processorOptions: { channels: channels },
    });

    let source = null;
    // The meter reads an input and writes silence, but a host only runs the
    // processors the destination can reach, so it is connected through a gain of
    // 0 — the same plumbing, and the same reason, as the recorder's.
    const alone = context.createGain();
    alone.gain.value = 0;
    if (typeof input.connect === "function") {
      input.connect(node);
    } else if (isMediaStream(input)) {
      if (typeof context.createMediaStreamSource !== "function") {
        throw new Error("StudioEngine: this host cannot read a MediaStream");
      }
      source = context.createMediaStreamSource(input);
      source.connect(node);
    } else {
      throw new Error("StudioEngine: createInputMeter needs a MediaStream or an AudioNode as its input");
    }
    node.connect(alone);
    alone.connect(context.destination);

    const levelListeners = new Set();
    node.port.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "level") {
        const level = {
          frame: message.frame,
          peak: message.peak,
          rms: message.rms,
          clipped: message.clipped,
          cols: message.cols,
        };
        for (const listener of levelListeners) {
          try {
            listener(level);
          } catch {
            /* one bad listener must not stop the meter for the others */
          }
        }
        return;
      }
      if (message.type === "error") notifyError(String(message.error));
    };
    if (typeof node.port.start === "function") node.port.start();

    const post = (message) => node.port.postMessage(message);

    return {
      node: node,

      /**
       * Follow the level: `listener({frame, peak, rms, clipped, cols})`, once
       * per post, about thirty times a second of rendered audio. `frame` and
       * every column's frame are CONTEXT frames; `cols` is a `Float32Array` of
       * `3 * n` values `frame, min, max`.
       * @param {(level: {frame: number, peak: number, rms: number,
       *                 clipped: boolean, cols: Float32Array}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onLevel(listener) {
        if (typeof listener !== "function") return function noop() {};
        levelListeners.add(listener);
        return function unsubscribe() {
          levelListeners.delete(listener);
        };
      },

      /**
       * Post readings (`true`) or stop posting (`false`). It posts nothing
       * before the first `true`, and a window in progress is dropped on `false`
       * so no reading spans the two.
       * @param {boolean} on
       * @returns {void}
       */
      setActive(on) {
        post({ type: on ? "on" : "off" });
      },

      /** Let the CLIP latch go: the meter can latch it again on a later sample. */
      clearClip() {
        post({ type: "clear" });
      },

      /**
       * Leave the graph and drop this meter's callbacks. The caller owns the
       * input stream and the context.
       * @returns {void}
       */
      dispose() {
        levelListeners.clear();
        node.port.onmessage = null;
        try {
          node.disconnect();
        } catch {
          /* never connected */
        }
        try {
          alone.disconnect();
        } catch {
          /* never connected */
        }
        if (source) {
          try {
            source.disconnect();
          } catch {
            /* never connected */
          }
        }
      },
    };
  }

  async function createStudioEngine(context, options) {
    if (!context || !context.audioWorklet) throw new Error("StudioEngine: a context with audioWorklet is required");
    const opts = options || {};

    if (ENGINE_CONTEXTS.has(context)) throw new Error(ONE_ENGINE_ERROR);

    // A browser page under a Content-Security-Policy cannot load a worklet
    // from a blob: URL, so it passes `moduleUrl`: the same composed module,
    // served same-origin by the gateway (bundles/studio/server/web.js).
    const texts = [];
    if (!opts.moduleUrl) {
      for (const name of SOURCE_FILES) {
        texts.push(await readText(name, opts));
      }
    }
    const wasmBinary = await readWasm(opts);
    // The compiled Faust effects: optional, and posted (transferred) once the
    // engine is up. See `readFaustModules`.
    const faustModules = await readFaustModules(opts);
    // The NAM engine's binary: optional too (a checkout that has not run
    // `tools/build-vendor.mjs` has none), posted once the engine is up.
    const namEngine = await readNamEngine(opts);

    // Claimed synchronously before the registration (and checked again, since
    // the reads above awaited), so two concurrent calls cannot both get as far
    // as `addModule()` and a failure to read an asset does not leave the
    // context unusable.
    if (ENGINE_CONTEXTS.has(context)) throw new Error(ONE_ENGINE_ERROR);
    ENGINE_CONTEXTS.add(context);

    try {
      // One blank line and a semicolon between files: every one of them is a
      // classic script that relies on its own final expression, and the SunVox
      // glue in particular ends without a trailing semicolon.
      if (opts.moduleUrl) await context.audioWorklet.addModule(opts.moduleUrl);
      else await addEngineModule(context, composeEngineModule(texts));
    } catch (error) {
      // Nothing was registered, so a retry on this context is honest.
      ENGINE_CONTEXTS.delete(context);
      throw error;
    }

    const Node = workletNodeClass();
    const node = new Node(context, PROCESSOR_NAME, {
      // ONE input: the monitored signal. The page connects the armed track's live
      // input to it when the operator turns Monitor through Studio on, and the
      // processor runs it through that track's inserts (plan 1d, Task 13). With
      // nothing connected the input is empty, and the engine is the source it
      // always was.
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // `testHooks` is off unless a caller asks for it; it arms the processor's
      // two test-only faults (see `throwForTest`). `maxSampleBytes` is left out
      // when the caller names none, so the processor keeps its own 256 MB cap.
      processorOptions: {
        wasmBinary: wasmBinary,
        testHooks: opts.testHooks === true,
        // The NAM captures' slim size is chosen per PAGE (plan 1d, Task 13): the
        // worklet scope has no `navigator`, so the count is measured here — or
        // taken from the caller, which is what makes a render deterministic.
        namCores: namCoresOf(opts),
        ...(Number(opts.maxSampleBytes) > 0 ? { maxSampleBytes: Number(opts.maxSampleBytes) } : {}),
        ...(Number(opts.maxFontBytes) > 0 ? { maxFontBytes: Number(opts.maxFontBytes) } : {}),
      },
    });

    const listeners = new Set();
    const launchListeners = new Set();
    const errorListeners = new Set();
    const sampleNeededListeners = new Set();
    const libraryNeededListeners = new Set();
    const libraryPresetsListeners = new Set();
    const tapListeners = new Set();
    /** Followers of the pads the engine started (see `onPadEvent`). */
    const padEventListeners = new Set();
    /** Whether the engine was already asked to record pad events. */
    let padEventsAsked = false;
    const meterListeners = new Set();
    const masterLatencyListeners = new Set();
    const insertFaultListeners = new Set();
    const insertLoadingListeners = new Set();
    /** Followers of the monitored track's own chain delay (Task 13). */
    const monitorLatencyListeners = new Set();
    /**
     * The latest meter reading, kept so a panel that draws after the fact (or a
     * test that asks once) can read it without waiting for the next 100 ms. A
     * reused object: the listeners get their own copy of the numbers.
     */
    let lastMeter = null;
    /**
     * Hand one failure to the error listeners and the console: a fault after
     * start-up has no caller to throw to.
     * @param {string} text
     * @returns {void}
     */
    const notifyError = (text) => {
      for (const listener of errorListeners) {
        try {
          listener(text);
        } catch {
          /* one bad listener must not hide the failure from the others */
        }
      }
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error("StudioEngine: " + text);
      }
    };
    const flushes = new Map();
    let flushSeq = 0;
    const barRequests = new Map();
    let barSeq = 0;
    /** take id → resolvers waiting for the processor's `audio_loaded`. */
    const pendingAudio = new Map();
    /** sample id → resolvers waiting for the processor's `sample_loaded`. */
    const pendingSamples = new Map();
    /** request id → the resolver waiting for that load's `library_loaded` / `library_deferred`. */
    const pendingLibrary = new Map();
    let librarySeq = 0;
    /** request id → the resolver waiting for the processor's `looper_buffer`. */
    const pendingLooper = new Map();
    let looperSeq = 0;
    /**
     * The frames the looper's buffers hold in the processor; 0 before the page has
     * sent any. The processor allocates none of its own, so the page keeps this
     * pair sized for eight bars at the song's tempo.
     */
    let looperBufferFrames = 0;
    /** The tempo the song is at, as the last `setSong` read it. */
    let looperSongBpm = DEFAULT_BPM;
    /**
     * The keys of the pads the last song handed to `setSong` says are Gate pads.
     * A HOLD is for Gate pads only (M15), and that is song data this side of the
     * port may be asked about at once — `holdPad` answers from here instead of
     * waiting for the audio thread to hear the message.
     * @type {Set<string>}
     */
    const gatePads = new Set();
    /**
     * The keys of the pads the last song says loop (`loop` is `"loop"` or
     * `"pingpong"`). A ROLL is refused on one of them (M19), which is song data
     * `rollStart` answers from here rather than waiting for the audio thread.
     * @type {Set<string>}
     */
    const loopPads = new Set();
    /**
     * Every pad the last song has, by its own pad key, with the sample it names.
     * `rollStart` reads it to refuse a pad the song does not have and one with no
     * sample at all: the audio thread enforces the same thing, and this is the
     * answer the page gets at once.
     * @type {Map<string, string>}
     */
    const padSamples = new Map();
    /**
     * The pads rolling right now, by pad key, with the sample each one was asked
     * to roll. The engine cannot answer `rollStart` (a port cannot round-trip), so
     * the count and the refusals the page is told about are kept here, and the
     * processor keeps the very same limits for itself.
     * @type {Map<string, string>}
     */
    const rollPads = new Map();
    const post = (message, transfer) => {
      if (transfer && transfer.length > 0) {
        try {
          node.port.postMessage(message, transfer);
          return;
        } catch {
          // A host whose port will not take a transfer list still gets the
          // message, just by copying it.
        }
      }
      node.port.postMessage(message);
    };

    /**
     * Hand the processor a fresh pair of looper buffers, transferred rather than
     * copied.
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @returns {void}
     */
    const sendLooperBuffers = (left, right) => {
      post({ type: "looper_buffers", left: left, right: right }, [left.buffer, right.buffer]);
    };

    /**
     * Make sure the processor's looper buffers hold eight bars at the song's
     * current tempo: they are sent before anything records into them, and again,
     * larger, when the song slows down far enough that eight bars no longer fit.
     * Never while a take is out — the looper is detached from its buffers then,
     * and the take hands the same pair back.
     * @param {number} bpm
     * @returns {void}
     */
    const ensureLooperBuffers = (bpm) => {
      const tempo = Number(bpm);
      const usable = Number.isFinite(tempo) && tempo > 0 ? tempo : DEFAULT_BPM;
      if (pendingLooper.size > 0) return;
      const needed = Math.ceil((context.sampleRate * 60 * BEATS_PER_BAR * LOOPER_BARS) / usable);
      if (needed <= looperBufferFrames) return;
      looperBufferFrames = needed;
      sendLooperBuffers(new Float32Array(needed), new Float32Array(needed));
    };

    try {
      await awaitReady(node, opts.readyTimeoutMs || READY_TIMEOUT_MS);
    } catch (error) {
      try {
        node.disconnect();
      } catch {
        /* never connected */
      }
      throw error;
    }

    /**
     * Hand the processor the compiled Faust effects, transferred rather than
     * copied. The processor compiles each once, on its port handler: compiling
     * is asynchronous, so it never happens inside `process()`. Nothing is posted
     * when this host has no built effects, and a chain that asks for one then
     * reports it missing.
     * @returns {void}
     */
    const postFaustModules = () => {
      const kinds = Object.keys(faustModules);
      if (kinds.length === 0) return;
      const modules = {};
      const transfer = [];
      for (const kind of kinds) {
        modules[kind] = faustModules[kind];
        transfer.push(faustModules[kind].wasm);
      }
      post({ type: "faust-modules", modules: modules }, transfer);
    };
    postFaustModules();

    /**
     * Hand the processor the NAM engine's binary, transferred rather than copied.
     * The processor compiles it once, on its port handler — never inside
     * `process()` — and every amp insert then owns one instance in that one
     * module. Nothing is posted when this host has no build output, and an amp
     * insert then plays silence and says so.
     * @returns {void}
     */
    const postNamEngine = () => {
      if (!namEngine) return;
      post({ type: "nam-wasm", bytes: namEngine }, [namEngine]);
    };
    postNamEngine();

    node.port.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "flushed") {
        const resolveFlush = flushes.get(message.id);
        if (resolveFlush) {
          flushes.delete(message.id);
          resolveFlush();
        }
        return;
      }
      if (message.type === "position") {
        const position = {
          bar: message.bar,
          beat: message.beat,
          sixteenth: message.sixteenth,
          // The context frame of the block this position is for, so a caller can
          // time a light (a pad event carries the same clock) against the grid.
          frame: message.frame === undefined || message.frame === null ? null : message.frame,
        };
        for (const listener of listeners) {
          try {
            listener(position);
          } catch {
            /* one bad listener must not stop the transport's clock */
          }
        }
        return;
      }
      if (message.type === "launched") {
        const launch = {
          track_id: message.track_id,
          clip_id: message.clip_id === null || message.clip_id === undefined ? null : message.clip_id,
          scene_id: message.scene_id === null || message.scene_id === undefined ? null : message.scene_id,
          bar: message.bar,
          frame: message.frame,
        };
        for (const listener of launchListeners) {
          try {
            listener(launch);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "nextBarFrame") {
        const resolveFrame = barRequests.get(message.id);
        if (resolveFrame) {
          barRequests.delete(message.id);
          resolveFrame({ frame: message.frame, bar: message.bar });
        }
        return;
      }
      if (message.type === "audio_loaded") {
        // One ack per `audio` message, in order: resolve the oldest load of
        // that take still waiting, so a re-load never strands an earlier one.
        const waiting = pendingAudio.get(message.take_id);
        if (waiting && waiting.length > 0) {
          const resolveTake = waiting.shift();
          if (waiting.length === 0) pendingAudio.delete(message.take_id);
          resolveTake();
        }
        return;
      }
      if (message.type === "sample_loaded") {
        const waiting = pendingSamples.get(message.sample_id);
        if (waiting && waiting.length > 0) {
          const resolveSample = waiting.shift();
          if (waiting.length === 0) pendingSamples.delete(message.sample_id);
          resolveSample();
        }
        return;
      }
      if (message.type === "library_loaded" || message.type === "library_deferred") {
        // One ack per library message, matched by the request id the load was
        // posted with: a later load of the same font never answers an earlier
        // one. A load resolves with what became of it — `loaded`, `deferred` (it
        // waits for Stop) or `failed` (with the reason the processor gave, which
        // is also posted once per font id as `library_failed`). A font that
        // loaded also carries the presets of the bank it parsed, which is what
        // the page's instrument picker lists.
        const presets = Array.isArray(message.presets) ? presetsOf(message.presets) : null;
        if (presets) {
          // Handed to the listeners whoever asked: a load answered `deferred`
          // resolves at once, and its presets arrive here when it is parsed on
          // Stop, with no request left waiting for them.
          for (const listener of libraryPresetsListeners) {
            try {
              listener(String(message.library_id), presets);
            } catch {
              /* one bad listener must not stop the others hearing about it */
            }
          }
        }
        const waiting = pendingLibrary.get(message.request_id);
        if (waiting === undefined) return;
        pendingLibrary.delete(message.request_id);
        if (message.type === "library_deferred") {
          waiting({ status: "deferred" });
          return;
        }
        if (message.ok === false) {
          const reason = message.reason === undefined ? "" : String(message.reason);
          waiting({ status: "failed", reason: reason });
          return;
        }
        waiting(presets ? { status: "loaded", presets: presets } : { status: "loaded" });
        return;
      }
      if (message.type === "library_failed") {
        // A bank that will not parse (or that failed while rendering): its tracks
        // are silent and the processor reports it once per font id.
        notifyError(`The instrument ${message.library_id} could not be read: ${message.reason}`);
        return;
      }
      if (message.type === "library_needed") {
        // A track's font is not loaded on this device (never fetched, still
        // uploading, or dropped by the engine's font cap), or an amp insert's
        // capture or cabinet is not: the page owns the bytes, so it loads them —
        // or offers the download.
        const id = String(message.library_id);
        for (const listener of libraryNeededListeners) {
          try {
            listener(id);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "monitor_latency") {
        // The delay the monitored track's own chain adds (plan 1d, Task 13): the
        // page adds it to the round trip it measured and shows the total.
        const latency = {
          track_id: String(message.track_id === undefined || message.track_id === null ? "" : message.track_id),
          ms: Number(message.ms),
        };
        for (const listener of monitorLatencyListeners) {
          try {
            listener(latency);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "looper_buffer") {
        // The looper's whole bars of the master, for a take this client asked for.
        // The buffers arrive transferred and go straight back: the page keeps only
        // its own copy of the loop's frames (clipped to [−1, 1]), so the looper
        // keeps playing from what it had once they return.
        const left = message.left instanceof Float32Array ? message.left : null;
        const right = message.right instanceof Float32Array ? message.right : null;
        const frames = Math.max(0, Math.trunc(Number(message.frames) || 0));
        const channelFrames = left && right ? Math.min(frames, left.length, right.length) : 0;
        const channels = [
          copyLooperChannel(left, channelFrames),
          copyLooperChannel(right, channelFrames),
        ];
        const rate = Number(message.rate);
        const bars = Number(message.bars);
        if (left && right) {
          try {
            sendLooperBuffers(left, right);
            // A tempo that dropped while the take was out needs its larger buffers
            // now: the looper copies what it holds into the bigger pair.
            ensureLooperBuffers(looperSongBpm);
          } catch {
            // A host that will not take them back leaves the looper silent rather
            // than taking the message path down; the page's copy is already made.
          }
        }
        const waiting = pendingLooper.get(message.id);
        if (waiting) {
          pendingLooper.delete(message.id);
          waiting({
            channels: channels,
            rate: Number.isFinite(rate) ? rate : context.sampleRate,
            bars: Number.isFinite(bars) ? bars : 0,
          });
        }
        return;
      }
      if (message.type === "meter") {
        // The master meter (plan 1d, Task 9): BS.1770-4 momentary, short-term
        // and integrated loudness, the true peak since the last Play, and the
        // master chain's own latency. One reading every 100 ms of audio while
        // the song plays, and one when it stops.
        const reading = {
          momentary: Number(message.momentary),
          short_term: Number(message.short_term),
          integrated: Number(message.integrated),
          true_peak_db: Number(message.true_peak_db),
          latency_ms: Number(message.latency_ms),
        };
        lastMeter = reading;
        for (const listener of meterListeners) {
          try {
            listener(reading);
          } catch {
            /* one bad listener must not stop the meter for the others */
          }
        }
        return;
      }
      if (message.type === "master_latency") {
        // Once per master chain build: the delay the master chain (the limiter's
        // lookahead) puts on the master path, which the master strip shows as
        // its own delay.
        const ms = Number(message.ms);
        const latency = { ms: Number.isFinite(ms) ? ms : 0 };
        for (const listener of masterLatencyListeners) {
          try {
            listener(latency);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "insert_fault") {
        // An insert produced a sample that is not a finite number: the processor
        // replaced that block with the insert's input and bypassed it in the
        // ENGINE. The document is untouched, and this is said once.
        const fault = {
          insert_id: String(message.insert_id),
          message: String(message.message),
        };
        for (const listener of insertFaultListeners) {
          try {
            listener(fault);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "insert_loading") {
        // A Faust insert whose compiled module has not arrived: it passes audio
        // through until the module lands, and this is said once. It is a load in
        // progress, not an engine error, so it never reaches `onError` — the
        // console — and the panel can show it as the insert warming up.
        const loading = {
          insert_id: String(message.insert_id),
          message: String(message.message),
        };
        for (const listener of insertLoadingListeners) {
          try {
            listener(loading);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "tap_block") {
        // A tap's copy of one block, for record-into-pad and resampling. The
        // frame is the context frame of the block's first sample: a resample
        // cuts what it keeps on that frame, never by counting blocks.
        const frame = Number(message.frame);
        const tap = {
          target: String(message.target),
          frame: Number.isFinite(frame) ? Math.trunc(frame) : 0,
          channels: Array.isArray(message.channels) ? message.channels : [],
        };
        for (const listener of tapListeners) {
          try {
            listener(tap);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "pad_events") {
        // The pads the engine started in one block, in the order they started —
        // a step, a live press and a controller press arrive in exactly this
        // shape. Each carries the context frame its voice begins on, so a light
        // is timed against the audible hit rather than against the message.
        const entries = Array.isArray(message.events) ? message.events : [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const frame = Math.trunc(Number(entry.frame)) || 0;
          const trackId = entry.track_id === undefined || entry.track_id === null ? "" : String(entry.track_id);
          let event;
          if (entry.kind === "note") {
            // A note a step started or ended, or one the page's own keyboard
            // played: its pitch, whether it started, and the frame it stands on
            // (the step's own, or the block's first frame for a live press), so a
            // page can paint the key on the frame the note is heard.
            event = {
              frame: frame,
              track_id: trackId,
              kind: "note",
              p: Math.trunc(Number(entry.p)) || 0,
              on: entry.on === true,
            };
          } else {
            event = {
              frame: frame,
              track_id: trackId,
              bank_id: entry.bank_id === undefined || entry.bank_id === null ? "" : String(entry.bank_id),
              index: Math.trunc(Number(entry.index)) || 0,
              kind: entry.kind === "state" ? "state" : "hit",
            };
            if (event.kind === "state") event.state = Math.trunc(Number(entry.state)) || 0;
            else event.v = Math.trunc(Number(entry.v)) || 0;
          }
          for (const listener of padEventListeners) {
            try {
              listener(event);
            } catch {
              /* one bad listener must not stop the others hearing about it */
            }
          }
        }
        return;
      }
      if (message.type === "sample_needed") {
        // A trigger wanted a sample the engine does not have (it was unloaded
        // to stay inside the song's byte cap, or it never arrived): the page
        // owns the decoded PCM, so it loads it again.
        const id = String(message.sample_id);
        for (const listener of sampleNeededListeners) {
          try {
            listener(id);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      // A failure after start-up (a device that cannot be built, a refused
      // song) has no caller to throw to; it is handed to whoever registered an
      // error listener and logged, instead of stopping the audio thread.
      if (message.type === "error") {
        // A failure after start-up (a device that cannot be built, a refused
        // song) has no caller to throw to; it is handed to whoever registered
        // an error listener and logged, instead of stopping the audio thread.
        notifyError(String(message.error));
      }
    };

    /**
     * Hand the processor one object's channels, resampled to the context's rate
     * when they are at another one, and resolve when it acknowledges them.
     *
     * The conversion is `resample.js`'s (the parity rule: no Web Audio node and
     * no `decodeAudioData` ever resamples), in the page's worker when there is
     * one and inline otherwise. `type`/`field` name the port message and the
     * field that carries the id, so takes and samples take the very same path.
     * @param {string} type the port message type ("audio" or "sample")
     * @param {string} field the message field naming the object
     * @param {string} id the take or sample id
     * @param {Map<string, Function[]>} pending the acks still waited for
     * @param {Float32Array[]} channels
     * @param {number} rate the rate those channels are at, in Hz
     * @returns {Promise<void>}
     */
    const sendPcm = (type, field, id, pending, channels, rate) => {
      const list = [];
      for (const channel of Array.isArray(channels) ? channels : []) {
        // A view into a larger buffer is copied: transferring it would hand
        // the processor (and detach here) the whole underlying buffer.
        if (channel instanceof Float32Array) {
          list.push(channel.byteLength === channel.buffer.byteLength ? channel : channel.slice());
        } else {
          list.push(Float32Array.from(channel));
        }
      }
      const from = Number(rate);

      const deliver = (pcm) => {
        // One transfer per underlying buffer: two views of one buffer would ask
        // the port to transfer it twice.
        const transfer = [];
        for (const channel of pcm) {
          if (channel.buffer instanceof ArrayBuffer && transfer.indexOf(channel.buffer) === -1) {
            transfer.push(channel.buffer);
          }
        }
        return new Promise((resolve) => {
          const waiting = pending.get(id) || [];
          waiting.push(resolve);
          pending.set(id, waiting);
          const message = { type: type, channels: pcm };
          message[field] = id;
          post(message, transfer);
        });
      };

      if (!Number.isFinite(from) || from <= 0 || from === context.sampleRate) return deliver(list);

      const convert =
        opts.assetBase && !isNode()
          ? resampleInWorker(opts.assetBase, list, from, context.sampleRate).catch(() =>
              resamplerOf().toRate(list, from, context.sampleRate),
            )
          : Promise.resolve(resamplerOf().toRate(list, from, context.sampleRate));
      return convert.then(deliver);
    };

    return {
      node: node,

      /**
       * Replace the song. The processor refuses more than 16 tracks; so does
       * this, before anything is posted.
       * @param {object} snapshot
       * @returns {void}
       */
      setSong(snapshot) {
        const tracks = snapshot && Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
        if (tracks.length > MAX_TRACKS) throw new Error(`A song can have at most ${MAX_TRACKS} tracks.`);
        post({ type: "song", snapshot: snapshot });
        // Which pads a HOLD may latch, which ones loop and which ones have a
        // sample is song data, so it is read here, once per song: `holdPad` and
        // `rollStart` answer from it without a round trip.
        gatePads.clear();
        loopPads.clear();
        padSamples.clear();
        const pads = snapshot && typeof snapshot.pads === "object" && snapshot.pads ? snapshot.pads : {};
        for (const key of Object.keys(pads)) {
          const item = pads[key];
          if (!item || typeof item !== "object") continue;
          const padKey = padKeyOf(item.track_id, item.bank_id, item.index);
          if (item.mode === "gate") gatePads.add(padKey);
          if (item.loop === "loop" || item.loop === "pingpong") loopPads.add(padKey);
          const sampleId = item.sample_id === undefined || item.sample_id === null ? "" : String(item.sample_id);
          padSamples.set(padKey, sampleId);
        }
        // A roll whose pad or sample this song no longer has ends with it; every
        // other roll plays on through an ordinary edit (`setSong` runs on every
        // one of them). The engine prunes the same way, so neither side lies.
        for (const [key, sampleId] of Array.from(rollPads)) {
          if (padSamples.get(key) === sampleId) continue;
          rollPads.delete(key);
        }
        // The looper's buffers are the page's, so they are sized off this song's
        // tempo before anything can record into them.
        const meta = snapshot && typeof snapshot.meta === "object" && snapshot.meta ? snapshot.meta : {};
        const bpm = Number(meta.bpm);
        looperSongBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
        // Only a looper that is in use holds buffers: an engine that just plays (an
        // offline render, say) never allocates eight bars of them. They are sent
        // before the first record instead, and grown here if the song slowed down.
        if (looperBufferFrames > 0) ensureLooperBuffers(looperSongBpm);
      },

      /** @param {string} id @returns {void} */
      launchScene(id) {
        post({ type: "launchScene", id: id });
      },

      /** @param {string} id @returns {void} */
      launchClip(id) {
        post({ type: "launchClip", id: id });
      },

      /** @param {string} id @returns {void} */
      stopTrack(id) {
        post({ type: "stopTrack", id: id });
      },

      /** @returns {void} */
      stopAll() {
        post({ type: "stopAll" });
      },

      /** @returns {void} */
      play() {
        post({ type: "play" });
      },

      /**
       * Stop the transport where it stands: every sounding note and voice is
       * closed as `stop()` closes them, but the position is kept together with
       * the clips the song has armed and the launches already queued for a
       * later bar. The next `play()` carries on from the beat the pause
       * recorded, so the run's beat counter, its click accents and its loops
       * keep their phase. A pause while the transport is not running, or is
       * already paused, does nothing.
       * @returns {void}
       */
      pause() {
        post({ type: "pause" });
      },

      /** @returns {void} */
      stop() {
        // Stop clears the engine's rolls (and its loops and holds), so the page's
        // own count follows it: a roll is not latched, it ends with the Stop.
        rollPads.clear();
        post({ type: "stop" });
      },

      /**
       * Release the pads' live state: every loop, every HOLD and every ROLL the
       * engine is holding ends through the normal release. The page sends this
       * when a DIFFERENT song
       * opens — the live state belongs to the one going away — and never on an
       * ordinary song update, which runs on every edit and must leave what still
       * exists playing.
       * @returns {void}
       */
      resetLive() {
        rollPads.clear();
        post({ type: "reset_live" });
      },

      /**
       * Choose what the transport plays: the session grid (`"session"`, the
       * default, where `launchScene`/`launchClip` arm clips) or the song's
       * arrangement (`"arrangement"`, where its placements sound on their
       * bars and launches are ignored). Switching closes every sounding note
       * and voice and resets what each track plays.
       * @param {"session"|"arrangement"} mode anything else means `"session"`
       * @returns {void}
       */
      setMode(mode) {
        post({ type: "setMode", mode: mode === "arrangement" ? "arrangement" : "session" });
      },

      /**
       * Move the arrangement playhead to a bar. The next block plays from that
       * bar — the takes the timeline holds there start at that very frame —
       * and the notes and voices that were sounding are closed first.
       *
       * The bar is at beat resolution: a quarter of a bar is one beat, so
       * `2.25` is bar 2 beat 2 (0-based), not bar 2. While the transport is
       * playing the jump happens at the next block and playback carries on;
       * while it is stopped or paused it only moves the place `play()` starts
       * from, and a paused transport is moved with it. A seek in the session
       * view only stores the bar a later switch to the arrangement starts at: it
       * never moves a session transport, paused or not.
       * @param {number} bar the 0-based bar; anything below 0 is bar 0
       * @returns {void}
       */
      seek(bar) {
        post({ type: "seek", bar: Number(bar) });
      },

      /**
       * Turn the engine's metronome click on or off.
       *
       * While the transport plays it clicks once per quarter-note beat, at
       * 1500 Hz and louder on the first beat of an engine bar and 1000 Hz on
       * the rest. It is the engine's own monitor signal: the processor adds it
       * to its output AFTER the master tap, so a master tap, the meter, a
       * mixdown or a render never carries it — and `server/render.js` never
       * sends this message, so renders are click-free. The engine's bars are
       * four beats whatever the song's `meta.meter` says (time-signature
       * support in the engine is a separate gap). Off until this says
       * otherwise; stopping the transport or turning it off starts no new
       * click, and the one already ringing is left to finish.
       * @param {boolean} on anything but `true` turns it off
       * @returns {void}
       */
      setMetronome(on) {
        post({ type: "metronome", on: on === true });
      },

      /**
       * Resolve once the processor has applied every message posted before
       * this call. Port messages are asynchronous, so an offline render must
       * await this between its last command and startRendering(), or the
       * render can begin before the song arrives (a browser's
       * OfflineAudioContext does).
       * @returns {Promise<void>}
       */
      flush() {
        const id = ++flushSeq;
        return new Promise((resolve) => {
          flushes.set(id, resolve);
          post({ type: "flush", id: id });
        });
      },

      /**
       * Follow the transport position.
       * @param {(position: {bar: number, beat: number, sixteenth: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onPosition(listener) {
        if (typeof listener !== "function") return function noop() {};
        listeners.add(listener);
        return function unsubscribe() {
          listeners.delete(listener);
        };
      },

      /**
       * Follow the launches the engine applied: one report per launch or stop,
       * with the AudioContext frame it took effect at and its 0-based bar. This
       * is what a recorder arms from, so it is never rounded or resequenced
       * here.
       * @param {(launch: {track_id: string, clip_id: string|null,
       *                   scene_id: string|null, bar: number, frame: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onLaunch(listener) {
        if (typeof listener !== "function") return function noop() {};
        launchListeners.add(listener);
        return function unsubscribe() {
          launchListeners.delete(listener);
        };
      },

      /**
       * The next bar boundary, on the engine's clock: `frame` is an
       * AudioContext frame and `bar` is the 0-based bar it belongs to. While
       * the transport is stopped this is the frame bar 0 would start at. It is
       * the same boundary the sequencer quantizes launches to, so a recorder
       * that arms here and a launch report name the very same frame.
       *
       * Resolves when the processor answers; a processor that has failed never
       * does, so callers should not depend on it after an error.
       * @returns {Promise<{frame: number, bar: number}>}
       */
      nextBarFrame() {
        const id = ++barSeq;
        return new Promise((resolve) => {
          barRequests.set(id, resolve);
          post({ type: "nextBarFrame", id: id });
        });
      },

      /**
       * Hand the processor one object's PCM, already decoded.
       *
       * The processor plays takes and samples at the context's own rate, so
       * PCM recorded (or imported) at another rate is converted here first, on
       * the client, with `resample.js` — never by the context or by
       * `decodeAudioData` (the parity rule). In a browser the conversion runs in
       * the page's resampling worker (`${assetBase}resample-worker.js`), so a
       * long take does not block the panel; a host without one (Node, a worker
       * that would not load) converts inline with the very same file.
       *
       * The converted channels are transferred to the processor rather copied,
       * so the caller must not use the arrays it passed after the promise
       * resolves.
       * @param {string} takeId
       * @param {Float32Array[]} channels the take's decoded samples, one per channel
       * @param {number} rate the rate those samples are at, in Hz
       * @returns {Promise<void>} resolves when the processor has the PCM
       */
      loadAudio(takeId, channels, rate) {
        return sendPcm("audio", "take_id", String(takeId), pendingAudio, channels, rate);
      },

      /**
       * Hand the engine one sampled pad's PCM, resampled to the context's rate
       * exactly as `loadAudio` does, into the processor's sample store. The
       * promise resolves when the processor has it.
       *
       * The channels are transferred, so the caller must not use the arrays it
       * passed once this resolves (the page keeps its own copy, which is what a
       * reload after a `sample_needed` needs).
       * @param {string} sampleId
       * @param {Float32Array[]} channels the sample's decoded PCM, one per channel
       * @param {number} rate the rate those samples are at, in Hz
       * @returns {Promise<void>} resolves when the processor has the PCM
       */
      loadSample(sampleId, channels, rate) {
        return sendPcm("sample", "sample_id", String(sampleId), pendingSamples, channels, rate);
      },

      /**
       * Drop one take's PCM from the engine (a comp that no longer uses it).
       * @param {string} takeId
       * @returns {void}
       */
      unloadAudio(takeId) {
        post({ type: "audio_unload", take_id: String(takeId) });
      },

      /**
       * Drop one sampled pad's PCM from the engine.
       * @param {string} sampleId
       * @returns {void}
       */
      unloadSample(sampleId) {
        post({ type: "sample_unload", sample_id: String(sampleId) });
      },

      /**
       * Follow the samples a trigger wanted but the engine did not have: the
       * song holds at most 256 MB of decoded samples, so the least-recently
       * played one is unloaded and the page loads it back when a pattern asks
       * for it again.
       * @param {(sampleId: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      onSampleNeeded(listener) {
        if (typeof listener !== "function") return function noop() {};
        sampleNeededListeners.add(listener);
        return function unsubscribe() {
          sampleNeededListeners.delete(listener);
        };
      },

      /**
       * Hand the processor one library FILE, already read (there is no fetch in
       * the worklet): a SoundFont bank today (`kind: "font"`). The bytes are
       * transferred, so the caller must not use the array it passed once this
       * resolves.
       *
       * A bank is parsed only while the transport is stopped (the plan's loading
       * rule). A load posted while the song plays is parked and parsed on the
       * next `stop()`, and resolves `{status: "deferred"}` at once — the page
       * shows "Loads when you stop." in the meantime. Each load carries its own
       * request id, so its promise settles for THAT load and never for another
       * load of the same font.
       * @param {string} libraryId
       * @param {string} kind `"font"` (a capture or cabinet is acknowledged and
       *   left to the host that reads them)
       * @param {Uint8Array|ArrayBuffer|ArrayBufferView|Float32Array[]} bytes the
       *   file itself, or a cabinet's decoded PCM
       * @param {{sourceRate?: number, sourceFrames?: number}} [options] for a
       *   cabinet: the rate and the length of the file the PCM came from, so the
       *   engine applies the one-second rule once, at that file's own rate
       * @returns {Promise<{status: "loaded"|"deferred"|"failed", reason?: string,
       *   presets?: Array<{bank: number, program: number, name: string}>}>}
       *   `failed` carries why: a bank that will not parse, one with no
       *   instruments, or one the song's own fonts have left no room for; a font
       *   that loaded carries the `presets` of the bank it parsed; an
       *   empty id is refused here, before anything is posted
       */
      loadLibrary(libraryId, kind, bytes, options) {
        // An empty id names nothing: answer at once, without posting a message
        // the processor would only have to ignore.
        if (libraryId === undefined || libraryId === null || String(libraryId) === "") {
          return Promise.resolve({ status: "failed", reason: "A library load needs an id." });
        }
        const id = String(libraryId);
        const what = String(kind || "font");
        librarySeq += 1;
        const requestId = librarySeq;
        // A cabinet arrives as decoded PCM, not as a file: `bytes` may be the
        // channel array the page (or a render) decoded and resampled the stored
        // WAV to. It is transferred, so the processor builds its partitions
        // without ever seeing the WAV. `options.sourceRate`/`sourceFrames` say
        // what that file held, so the one-second rule is judged where it belongs
        // — at the file's own rate — instead of on the length resampling gave it
        // at a higher context rate.
        if (Array.isArray(bytes) && bytes.length > 0 && bytes[0] instanceof Float32Array) {
          const channels = bytes.slice(0, 2);
          const sourceRate = Number(options && options.sourceRate);
          const sourceFrames = Number(options && options.sourceFrames);
          const message = {
            type: "library",
            request_id: requestId,
            library_id: id,
            kind: what,
            channels: channels,
            rate: context.sampleRate,
          };
          if (Number.isFinite(sourceRate) && sourceRate > 0) message.source_rate = sourceRate;
          if (Number.isFinite(sourceFrames) && sourceFrames > 0) message.source_frames = sourceFrames;
          return new Promise((resolve) => {
            pendingLibrary.set(requestId, resolve);
            post(message, channels.map((channel) => channel.buffer));
          });
        }
        const data = bytesOf(bytes);
        // A view into a larger buffer is copied: transferring it would hand the
        // processor (and detach here) the whole underlying buffer.
        const payload = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
        return new Promise((resolve) => {
          pendingLibrary.set(requestId, resolve);
          post(
            { type: "library", request_id: requestId, library_id: id, kind: what, bytes: payload },
            [payload.buffer],
          );
        });
      },

      /**
       * Drop one library file's bytes from the engine (a font the song no longer
       * plays). A track that still names it asks for it again, exactly as an
       * evicted font does.
       * @param {string} libraryId
       * @returns {void}
       */
      unloadLibrary(libraryId) {
        post({ type: "library_unload", library_id: String(libraryId) });
      },

      /**
       * Turn monitoring through the chain on or off for one track (plan 1d,
       * Task 13). While it is on, the signal connected to `node`'s own input is
       * summed into that track's source, so it is heard through the track's
       * inserts — amps included — and its fader. The take is still recorded dry:
       * the recorder taps the input, not this engine.
       * @param {string} trackId
       * @param {boolean} on
       * @param {number} [channels] the armed track's 1b input selection: 1 for a
       *   one-channel input, anything else (or nothing) for a stereo pair. An
       *   amp's mono sum is decided from this, never from the signal's peaks.
       * @returns {void}
       */
      monitor(trackId, on, channels) {
        post({
          type: "monitor",
          track_id: String(trackId),
          on: on === true,
          channels: Number(channels) === 1 ? 1 : 2,
        });
      },

      /**
       * Follow the delay the monitored track's own chain adds, in ms
       * (`{track_id, ms}`), posted whenever it changes. The page adds it to the
       * round trip it measured.
       * @param {(latency: {track_id: string, ms: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onMonitorLatency(listener) {
        if (typeof listener !== "function") return function noop() {};
        monitorLatencyListeners.add(listener);
        return function unsubscribe() {
          monitorLatencyListeners.delete(listener);
        };
      },

      /**
       * Follow the fonts a track wanted but the engine does not hold: one per
       * font id, once — the page loads the file it has, or offers the download
       * for one it does not.
       * @param {(libraryId: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      onLibraryNeeded(listener) {
        if (typeof listener !== "function") return function noop() {};
        libraryNeededListeners.add(listener);
        return function unsubscribe() {
          libraryNeededListeners.delete(listener);
        };
      },

      /**
       * Follow the presets a bank announced once it loaded: `(library_id,
       * [{bank, program, name}])`, sorted by bank then program. A load that waits
       * for Stop answers `deferred` to its asker, so this is how a page hears
       * about the presets that arrive when the bank is finally parsed.
       * @param {(libraryId: string, presets: Array<{bank: number, program: number, name: string}>) => void} listener
       * @returns {() => void} unsubscribe
       */
      onLibraryPresets(listener) {
        if (typeof listener !== "function") return function noop() {};
        libraryPresetsListeners.add(listener);
        return function unsubscribe() {
          libraryPresetsListeners.delete(listener);
        };
      },

      /**
       * Audition one pad: a live trigger that goes straight to a voice, never
       * through a command or a history step, and is never quantized to the bar.
       * A `oneshot` pad plays to its end; a `gate` pad holds until
       * `liveRelease`.
       *
       * `index` is the pad whose sample plays. `locks` overrides that one
       * voice's fields the way a step's locks do, and `sourceIndex` is the pad
       * the finger is on when the press sounds another pad's sample (a chromatic
       * or 16-velocity press). Both are optional and both are appended, so the
       * four-argument call sends the message it always did.
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad whose sample plays, 0-15
       * @param {number} velocity 1-127
       * @param {object} [locks] one voice's overrides, as a step's
       * @param {number} [sourceIndex] the pad that was pressed, 0-15
       * @returns {void}
       */
      livePad(trackId, bankId, index, velocity, locks, sourceIndex) {
        const v = Number(velocity);
        const message = {
          type: "live",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
          v: Number.isFinite(v) ? v : 127,
          on: true,
        };
        if (locks && typeof locks === "object") message.locks = locks;
        if (sourceIndex !== undefined && sourceIndex !== null) {
          message.source_index = Math.trunc(Number(sourceIndex) || 0);
        }
        post(message);
      },

      /**
       * Release the `gate` voices one pad's live presses started. A `oneshot`
       * voice is left alone: a one-shot pad plays to the end of its range, as
       * `livePad` says.
       *
       * A `sourceIndex` lets go of only the press on that pad: one sample pad
       * can carry a chord of chromatic presses, and a lifted finger ends its own
       * note. A call that names none releases every Gate voice of the pad, which
       * is what it always did.
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad whose sample plays, 0-15
       * @param {number} [sourceIndex] the pad that was let go of, 0-15
       * @returns {void}
       */
      liveRelease(trackId, bankId, index, sourceIndex) {
        const message = {
          type: "live",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
          v: 0,
          on: false,
        };
        if (sourceIndex !== undefined && sourceIndex !== null) {
          message.source_index = Math.trunc(Number(sourceIndex) || 0);
        }
        post(message);
      },

      /**
       * Sound one live note on a track's device, straight to the engine: a press
       * (`on` true) or a release. This is the page's own keyboard — and the MIDI
       * keys that reach the engine through it — so it is never quantized and
       * never touches the song.
       *
       * A SunVox track sends its sequenced notes on event track 0, so the engine
       * gives a live note one of its own (1..8, the next track no held note stands
       * on, remembered against the pitch): a live note never cuts a sequenced one,
       * and two live notes are two notes rather than one. A soundfont track plays
       * it on its own MIDI channel. An unknown track is a no-op, the pitch is held
       * between 0 and 127 and the velocity between 1 and 127, and a release for a
       * pitch that is not held is a no-op. Stop sends the note-offs of what is
       * still held.
       *
       * A pitch that is not a finite number is dropped here and nothing is
       * posted: the engine would take it as pitch 0 and play C-1.
       * @param {string} trackId
       * @param {number} p the MIDI pitch, 0..127
       * @param {number} v the velocity, 1..127
       * @param {boolean} on whether this is a press (true) or a release (false)
       * @returns {void}
       */
      liveNote(trackId, p, v, on) {
        const pitch = Number(p);
        if (!Number.isFinite(pitch)) return;
        const velocity = Number(v);
        post({
          type: "live_note",
          track_id: String(trackId),
          p: pitch,
          v: Number.isFinite(velocity) ? velocity : 127,
          on: on !== false,
        });
      },

      /**
       * Latch the `gate` voices one pad is sounding right now: the HOLD key.
       *
       * A held voice keeps sounding after the operator lets go and ignores its
       * own gate countdown, so a Gate pad goes on by itself (M13) and a
       * Gate+Loop pad's loop keeps turning (M14). Several pads may be held at
       * once, and the SECOND tap of a latched pad is `releaseHeld` for that pad,
       * not another call here.
       *
       * HOLD is page state, not engine state: while the page's HOLD key is armed
       * it sends `livePad` and then this for each press. It works on Gate pads
       * only (M15), and that is what the answer says: `false` means the song the
       * engine was last handed has no Gate pad at this place, so nothing was
       * asked of the engine and the page shows its note. A Gate pad that is not
       * sounding has nothing to latch and still says `true` — the answer is about
       * the pad's kind, never about what happens to be sounding.
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad, 0-15
       * @returns {boolean} whether a HOLD was asked of the engine
       */
      holdPad(trackId, bankId, index) {
        if (!gatePads.has(padKeyOf(trackId, bankId, index))) return false;
        post({
          type: "hold",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
        });
        return true;
      },

      /**
       * Let HOLD go: every latched voice when no pad is named (Stop and
       * `resetLive` do this in the engine anyway), one track's when only it is
       * named, and one pad's when the pad is. The latch is cleared and the
       * voice's ordinary release runs from where it stands.
       * @param {string} [trackId]
       * @param {string} [bankId]
       * @param {number} [index] the pad, 0-15
       * @returns {void}
       */
      releaseHeld(trackId, bankId, index) {
        if (trackId === undefined || trackId === null) {
          post({ type: "release_held" });
          return;
        }
        if (bankId === undefined || bankId === null) {
          post({ type: "release_held", track_id: String(trackId) });
          return;
        }
        post({
          type: "release_held",
          track_id: String(trackId),
          bank_id: String(bankId),
          index: Math.trunc(Number(index) || 0),
        });
      },

      /**
       * Pause everything the pads are playing, or let it go (the SP-404's
       * SHIFT+HOLD Pause-all).
       *
       * A voice ducks to silence over 64 frames and then stands frozen where it
       * reached: its read position, its envelope and its gate countdown stop
       * with it, and resuming ramps it back up over the same 64 frames from that
       * very frame (M17). Nothing is cut at full level, and a voice that is
       * already ending or fading is not paused; it finishes.
       *
       * While the pause is on, every new start — a live press, a step, a roll
       * repeat — is created paused: silent and frozen from its own first frame,
       * and heard (ramping up) on resume (M22). Its hit and its light still land
       * at the frame it starts on, because the voice really did start.
       *
       * It is live state: never a command, never a history step, never in the
       * song. Stop and `resetLive` clear it in the engine.
       * @param {boolean} on
       * @returns {void}
       */
      pauseVoices(on) {
        post({ type: "pause_voices", on: on === true });
      },

      /**
       * Repeat one pad at a straight interval: the SP-404's ROLL key.
       *
       * Each repeat is a step-like start of that pad, so it flashes on the page,
       * obeys the mute group and follows the pad's own mode — a Normal pad
       * restarts on every repeat, a One-shot pad overlaps them (M20) — and a
       * Gate pad's repeat carries a gate of one interval, so its repeats release
       * themselves and never pile up (M18). The first hit of a roll is the press
       * the operator made; the first REPEAT is one interval after that.
       *
       * At most four pads roll at once. Three things are refused, and this answer
       * says so (the engine enforces the very same limits for itself): a fifth
       * pad while four roll, a pad the song has no sample for, and a pad whose
       * Loop setting is on (M19) — its loop is already what the operator hears.
       * A pad that is already rolling is not refused and is not a fifth: it keeps
       * its one roll and follows the interval it is given now.
       *
       * ROLL is live state: never a command, never a history step, never in the
       * song. Stop and `resetLive` end every roll, and a roll made under Pause-all
       * keeps its clock — each of its repeats starts paused and is heard on resume
       * (M21, M22).
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad, 0-15
       * @param {"1/4"|"1/8"|"1/16"|"1/32"|"1/64"} interval the gap between repeats
       * @param {number} velocity 1-127
       * @returns {boolean} whether that pad is rolling now
       */
      rollStart(trackId, bankId, index, interval, velocity) {
        const key = padKeyOf(trackId, bankId, index);
        // A looping pad rolls nothing (M19): its loop is what the operator
        // hears, so the page says so instead of stacking repeats on it.
        if (loopPads.has(key)) return false;
        // Nothing to repeat without a sample: a pad the song does not have, or
        // one it has cleared.
        const sampleId = padSamples.get(key);
        if (sampleId === undefined || sampleId === "") return false;
        // Four pads, no more — a pad already rolling keeps its own slot.
        if (!rollPads.has(key) && rollPads.size >= MAX_ROLLS) return false;
        rollPads.set(key, sampleId);
        const v = Number(velocity);
        post({
          type: "roll_start",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
          interval: typeof interval === "string" ? interval : "",
          v: Number.isFinite(v) ? v : 127,
        });
        return true;
      },

      /**
       * End one pad's roll. The voices its repeats already started are left
       * alone, as a press's voice is when the finger lifts.
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad, 0-15
       * @returns {void}
       */
      rollStop(trackId, bankId, index) {
        rollPads.delete(padKeyOf(trackId, bankId, index));
        post({
          type: "roll_stop",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
        });
      },

      /**
       * End every roll at once.
       * @returns {void}
       */
      rollStopAll() {
        rollPads.clear();
        post({ type: "roll_stop_all" });
      },

      /**
       * Turn a tap on or off: `"master"` for the mix, or a track's id for that
       * track's own output. While a tap is on the processor posts one
       * `{type:"tap_block", target, frame, channels}` per block, which is what
       * record-into-pad and resampling record. Off by default, and off costs
       * nothing.
       * @param {string} target "master" or a track id
       * @param {boolean} on
       * @returns {void}
       */
      tap(target, on) {
        post({ type: "tap", target: String(target), on: on === true });
      },

      /**
       * Hold one performance effect on the master bus. The effect is live state:
       * it never enters the song, never becomes a history step, and nothing but
       * `fxRelease` (a scene launch, a transport stop, a pattern change) ends it.
       *
       * `amount` is 0..1 and means what the effect makes of it; a `fxHold` on an
       * effect that is already held follows the amount, which is how a knob
       * sweeps the filter.
       * @param {"filter_sweep"|"lofi"|"stutter"|"tape_stop"|"reverb_throw"} name
       * @param {number} amount 0..1
       * @returns {void}
       */
      fxHold(name, amount) {
        const value = Number(amount);
        post({ type: "fx", name: String(name), amount: Number.isFinite(value) ? value : 0, on: true });
      },

      /**
       * Let one performance effect go: it crossfades back to the dry master over
       * 64 frames (the reverb throw closes its send and rings out).
       * @param {string} name
       * @returns {void}
       */
      fxRelease(name) {
        post({ type: "fx", name: String(name), amount: 0, on: false });
      },

      /**
       * One looper command on the master bus, quantized to the sequencer's next bar
       * line: `record` starts there, the next `play`/`overdub`/`record` ends the
       * take on the bar line after it, `play` loops it into the master, `overdub`
       * adds the live master into it, `clear` empties it.
       *
       * The looper's buffers are this page's (the audio thread allocates none), so a
       * command that records sends a pair sized for eight bars at the song's tempo
       * first — before the bar line it is quantized to, on the same port.
       * @param {"record"|"overdub"|"play"|"stop"|"clear"} action
       * @returns {void}
       */
      looper(action) {
        const what = String(action);
        if (what === "record" || what === "overdub") ensureLooperBuffers(looperSongBpm);
        post({ type: "looper", action: what });
      },

      /**
       * The looper's take: whole bars of the master it recorded, in two channels
       * at the context's rate, clipped to [−1, 1]. Record-into-pad turns it into a
       * sample.
       *
       * The processor transfers its looper buffers here; this copies the loop's
       * frames out of them and transfers the same buffers straight back, so the
       * looper plays on from where it was. While they are away (a moment, and only
       * for a take) the looper contributes silence.
       *
       * Resolves when the processor answers, with a snapshot of the take at the
       * moment it read the request: a take that is still recording answers the
       * whole bars it has captured so far, and a looper that has recorded nothing
       * answers no bars.
       * @returns {Promise<{channels: Float32Array[], rate: number, bars: number}>}
       */
      looperTake() {
        const id = ++looperSeq;
        return new Promise((resolve) => {
          pendingLooper.set(id, resolve);
          post({ type: "looper_take", id: id });
        });
      },

      /**
       * Follow a tap: one `{target, frame, channels}` per block while one is on,
       * `target` being "master" or the tapped track's id, `frame` the context
       * frame of the block's first sample, and `channels` the block's own copies
       * (the tap never shares its mix's buffers).
       * @param {(tap: {target: string, frame: number, channels: Float32Array[]}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onTap(listener) {
        if (typeof listener !== "function") return function noop() {};
        tapListeners.add(listener);
        return function unsubscribe() {
          tapListeners.delete(listener);
        };
      },

      /**
       * Follow the pads the engine started: `{frame, track_id, bank_id, index,
       * kind, v, state?}`, one message per block while something started, in the
       * order the voices began. `frame` is the AudioContext frame the voice
       * starts on — the same clock `onLaunch` and `nextBarFrame` report in — and
       * `v` is the EFFECTIVE velocity the voice played at, so a light can land on
       * the frame the hit is heard instead of the page asking again and again.
       * The engine records nothing until the first subscription posts
       * `pad_events_on`, and then records each block's hits into a preallocated
       * ring. A note rides the same channel as `{frame, track_id, kind: "note",
       * p, on}`: a note a step started or ended, or one the page played, with the
       * frame it stands on in the same clock a hit carries.
       * @param {(event: {frame: number, track_id: string, bank_id?: string,
       *                  index?: number, kind: string, v?: number,
       *                  state?: number, p?: number, on?: boolean}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onPadEvent(listener) {
        if (typeof listener !== "function") return function noop() {};
        padEventListeners.add(listener);
        if (!padEventsAsked) {
          padEventsAsked = true;
          post({ type: "pad_events_on", on: true });
        }
        return function unsubscribe() {
          padEventListeners.delete(listener);
        };
      },

      /**
       * Follow the master meter: `{momentary, short_term, integrated,
       * true_peak_db, latency_ms}`, one reading every 100 ms of audio while the
       * song plays and one when it stops. The loudness readings are BS.1770-4
       * LUFS, measured after the master inserts on the very K-weighting and
       * gating `server/loudness.js` measures a render with; `true_peak_db` is the
       * true peak since the last `play()` (a hold), and `latency_ms` is the delay
       * the master chain puts on the master path (the limiter's lookahead).
       * @param {(reading: {momentary: number, short_term: number,
       *                    integrated: number, true_peak_db: number,
       *                    latency_ms: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onMeter(listener) {
        if (typeof listener !== "function") return function noop() {};
        meterListeners.add(listener);
        return function unsubscribe() {
          meterListeners.delete(listener);
        };
      },

      /**
       * The latest meter reading, or null before the first one. A copy, so a
       * caller cannot move the reading another listener sees.
       * @returns {{momentary: number, short_term: number, integrated: number,
       *            true_peak_db: number, latency_ms: number}|null}
       */
      lastMeter() {
        return lastMeter === null ? null : { ...lastMeter };
      },

      /**
       * Follow the master chain's own latency: `{ms}`, posted once per chain
       * build. The master limiter's 1.5 ms lookahead is the whole of it — every
       * track and return insert is zero-latency — and the master strip shows it
       * as the delay it is.
       * @param {(latency: {ms: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onMasterLatency(listener) {
        if (typeof listener !== "function") return function noop() {};
        masterLatencyListeners.add(listener);
        return function unsubscribe() {
          masterLatencyListeners.delete(listener);
        };
      },

      /**
       * Follow an insert that produced an invalid sample: `{insert_id, message}`.
       * The processor replaced that block with the insert's input and bypassed the
       * insert in the ENGINE — the song is never edited — and says so once.
       * @param {(fault: {insert_id: string, message: string}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onInsertFault(listener) {
        if (typeof listener !== "function") return function noop() {};
        insertFaultListeners.add(listener);
        return function unsubscribe() {
          insertFaultListeners.delete(listener);
        };
      },

      /**
       * Follow an insert that is waiting for its compiled Faust module:
       * `{insert_id, message}`. It passes audio through until the module lands and
       * says so once — a load in progress, never an error. It never reaches
       * `onError` or the console.
       * @param {(loading: {insert_id: string, message: string}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onInsertLoading(listener) {
        if (typeof listener !== "function") return function noop() {};
        insertLoadingListeners.add(listener);
        return function unsubscribe() {
          insertLoadingListeners.delete(listener);
        };
      },

      /**
       * Follow the engine's failures (a device that could not be built, a song
       * the processor refused, a fault it survived). They are also logged.
       * @param {(text: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      onError(listener) {
        if (typeof listener !== "function") return function noop() {};
        errorListeners.add(listener);
        return function unsubscribe() {
          errorListeners.delete(listener);
        };
      },

      /**
       * Test hook: ask the processor to throw inside its next `process()`, to
       * prove the block body's guard reports once and goes silent instead of
       * taking the host's audio thread down. Refused unless the engine was
       * created with `{testHooks: true}`, because the processor ignores the
       * message in that case and a silent no-op would be a lie.
       * @returns {void}
       */
      throwForTest() {
        if (opts.testHooks !== true) throw new Error("StudioEngine: test hooks are not enabled on this engine");
        post({ type: "__throw" });
      },

      /**
       * Measure the round trip of a loopback cable, in context frames.
       *
       * The emitter clicks, the detector finds each click by cross-correlation
       * and reports its lag; the first two clicks are ignored and the median of
       * the rest is the answer. Fewer than 10 heard clicks, or lags spread over
       * more than 2 ms, is refused with "Check the loopback cable and the input
       * gain." Both nodes are cleaned up either way.
       *
       * `latencyHint` and `sinkId` are echoed into the result rather than applied
       * here: they belong to the context the caller created, and the panel keys
       * the stored measurement on them.
       * @param {{input: MediaStream|AudioNode, clicks?: number, latencyHint?: string,
       *          sinkId?: string, interval?: number,
       *          onEmitter?: function(AudioWorkletNode): void}} options
       * @returns {Promise<{latency_frames: number, rate: number,
       *                    spread_frames: number, clicks_heard: number,
       *                    latencyHint: string|null, sinkId: string|null}>}
       */
      calibrate(options) {
        return runCalibration(context, opts, options, notifyError);
      },

      /**
       * Build a recorder on this context: `{armAt, stopAt, splitAt, onChunk,
       * onDone, dispose}` (see `runRecorder` above for the whole contract).
       * @param {{input: MediaStream|AudioNode, channels?: number}} options
       * @returns {Promise<object>}
       */
      createRecorder(options) {
        return runRecorder(context, opts, options, notifyError);
      },

      /**
       * Build an input meter on this context: `{node, onLevel, setActive,
       * clearClip, dispose}` (see `runInputMeter` above for the whole contract).
       * @param {{input: MediaStream|AudioNode, channels?: number}} options
       * @returns {Promise<object>}
       */
      createInputMeter(options) {
        return runInputMeter(context, opts, options, notifyError);
      },

      /**
       * Stop listening and leave the graph. The caller owns the context and the
       * node's connections; this only drops this client's port handler.
       * @returns {void}
       */
      dispose() {
        listeners.clear();
        launchListeners.clear();
        errorListeners.clear();
        sampleNeededListeners.clear();
        libraryNeededListeners.clear();
        libraryPresetsListeners.clear();
        tapListeners.clear();
        padEventListeners.clear();
        meterListeners.clear();
        masterLatencyListeners.clear();
        insertFaultListeners.clear();
        insertLoadingListeners.clear();
        pendingAudio.clear();
        pendingSamples.clear();
        pendingLibrary.clear();
        pendingLooper.clear();
        rollPads.clear();
        node.port.onmessage = null;
      },
    };
  }

  const api = {
    create: createStudioEngine,
    createStudioEngine: createStudioEngine,
    copyLooperChannel: copyLooperChannel,
    SOURCE_FILES: SOURCE_FILES,
    WORKLET_FILES: WORKLET_FILES,
    composeEngineModule: composeEngineModule,
    PROCESSOR_NAME: PROCESSOR_NAME,
    CALIBRATE_EMITTER_PROCESSOR: CALIBRATE_EMITTER_PROCESSOR,
    CALIBRATE_DETECTOR_PROCESSOR: CALIBRATE_DETECTOR_PROCESSOR,
    RECORDER_PROCESSOR: RECORDER_PROCESSOR,
    INPUT_METER_PROCESSOR: INPUT_METER_PROCESSOR,
    CALIBRATION_REFUSAL: CALIBRATION_REFUSAL,
    loadWorklets: loadStudioWorklets,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();