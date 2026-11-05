/**
 * Offline render — the ear the agent borrows.
 *
 * `renderSong()` runs the very same engine the dashboard plays (sequencer +
 * SunVox worklet, `engine/engine-client.js`) inside Node's
 * `OfflineAudioContext`, faster than real time and bit-identically to a
 * browser's render of the same song. `createRenderer()` wraps it in the
 * storage rail: an ACL gate, a small render queue, a 24-bit WAV, an object in
 * S3, a `storage_files` row, an audit line and a presigned download URL.
 *
 * ## No app modules
 *
 * This file imports nothing from the Crow app (`servers/…`). The MCP server
 * injects the database, the storage client and the project ACL, so the same
 * renderer runs under the stdio server, in a test with fakes, and inside the
 * gateway without dragging an app import into a bundle.
 *
 * ## The engine's assets
 *
 * The worklet is four sources concatenated plus the SunVox wasm binary. They
 * are read from the bundle (this file's neighbours `../engine` and
 * `../vendor/sunvox`) once per process and cached: an MCP process renders many
 * times, and re-reading ~5 MB of wasm per render would be the slowest part of
 * it. `node-web-audio-api` is resolved through `createRequire(import.meta.url)`
 * so the bundle's OWN `node_modules` supplies it — a bundle installed under
 * `~/.crow/bundles/studio` never resolves the app repo's tree.
 *
 * ## A render must flush before it starts
 *
 * Port messages are asynchronous: `engine.setSong()`/`play()` reach the
 * processor some time later, and `startRendering()` does not wait for them. So
 * every render `await engine.flush()` between its last command and
 * `startRendering()`, and a render that throws before that point releases the
 * worklet thread by hand (`startRendering()` is what normally releases it, and
 * a leaked worklet would keep the process alive).
 *
 * ## Takes and samples
 *
 * An audio clip plays recorded takes (see `server/commands/takes.js`), and
 * those are WAV files in storage, not part of the song document. A render
 * therefore has to load them before it starts: `renderSong()` works out which
 * takes the render can hear — every take in the comp of the audio clips the
 * scene (or the clip) plays, discarded ones aside — and asks `options.takeAudio`
 * for each one's decoded PCM. `createRenderer()` builds that function from the
 * storage client, refusing any take whose key is not exactly under the song's
 * own `studio/<song_id>/takes/` prefix: a render may read nothing of a song but
 * that song's own recordings.
 *
 * A sampler track's patterns play samples, which are WAV files in storage in
 * the same way. A render loads every sample its playing patterns' steps trigger
 * — through `options.sampleAudio`, built like `takeAudio` and pinned to the
 * song's own `studio/<song_id>/samples/` — and hands each one to the engine
 * (`engine.loadSample`). A sample a render cannot read is not fatal — a pad
 * whose sample is missing plays silence (the spec's Review Focus 1), and one
 * dangling pad must not turn into a failed render of the whole song — but it is
 * never silently dropped either: the render's answer carries
 * `missing_samples: [{id, reason}]`, the renderer repeats it in its result and
 * in the `studio.render` audit line, and `studio_render` hands it to the agent.
 * A pad that names a sample the song does not hold at all is reported the same
 * way. The key rule still holds — such an object is never read.
 *
 * A render's samples are never trimmed away. The browser panel's engine holds a
 * 256 MB cap and unloads its least-recently-played sample past it, reloading it
 * when a pattern asks again; an offline render has no reader to ask, so its
 * engine is built with a cap the size of every PCM byte its window's samples
 * take at the render's rate (`sampleCapFor`), and a window whose samples need
 * more than a render may hold (1 GiB) is refused before it starts.
 *
 * ## The instruments
 *
 * A soundfont track plays a preset of a library FONT (`{engine: "soundfont",
 * font_id, bank, program}`, plan 1d), and a font is a file outside the song
 * document. A render therefore loads every font its soundfont tracks name —
 * once each, muted tracks included, since a muted track is still the song's —
 * before Play: a bank the worklet has not parsed is silence, and a render has
 * no Stop to wait for (the engine defers a load until then). The bytes come
 * from where this instance keeps them: a catalog entry reads the verified
 * `<CROW_HOME>/studio/library/<sha256>.<ext>` copy, and only after the store
 * says it still hashes to that name; an upload reads the exact storage key its
 * upload wrote, under this song's own `studio/<song_id>/library/` — the same
 * own-prefix rule the sample and take readers keep, so a render may read
 * nothing of a song but that song's own files.
 *
 * A font that cannot be read — not on this device, a storage failure, a bank
 * the engine will not parse — is NOT fatal: its tracks render silent and the
 * answer carries `missing_library: [{id, reason}]`, with reason "not on this
 * device", "could not be read", or the engine's own words (Review Focus 5: a
 * song may name a file this device does not have, and nothing throws). The
 * font FILES a render will hold are summed before it starts, against the
 * plan's 1 GiB (`fontCapFor`, overridable through `fontCapBytes` as the sample
 * cap is), because the engine's own cap would otherwise evict a font in the
 * middle of a render that has no way to load it back.
 *
 * The answer also carries `credits`: the credit line of every library entry
 * the render heard, deduped, in the order the song first uses them. Every
 * CC-BY item shows its credit in the picker, the library list and here (plan
 * 1d, Global Constraints).
 *
 * ## The arrangement
 *
 * `{ mode: "arrangement", from_bar, seconds }` renders the song's timeline
 * instead of a scene: the engine is put in arrangement mode, seeked to
 * `from_bar` and played. The takes and samples it loads are the ones the audio
 * comps and the pattern clips placed inside the rendered window use — the
 * window in bars is `seconds` at the song's own tempo, four beats to the bar —
 * so a render of the third verse does not read the first verse's recordings.
 *
 * ## Renders are serialized, and there is no timeout
 *
 * Every render of one renderer runs alone: the queue holds one running job and
 * at most three waiting behind it, because the process has ONE worklet host and
 * one storage client. There is no render timeout in 1a — a wedged worklet holds
 * the slot (and refuses later calls until the queue's waiters are gone) until
 * the MCP process is restarted. Peak memory of a full 300 s render is a few
 * hundred MB: two 57 MB float channels for the audio itself, the 86 MB WAV, and
 * the filter copies the loudness and true-peak meters make. That is why the
 * channels are dropped as soon as they have been measured and encoded, and why
 * the WAV is handed to storage as a view rather than a copy.
 */

import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeWav, encodeWav24 } from "./wav.js";
import { integratedLufs, truePeakDb } from "./loudness.js";
// The instrument catalog and its one verified copy of each file. It is the
// bundle's own module (Node built-ins only), not a Crow app module: the same
// rule the renderer keeps for everything else it is handed.
import { createLibraryStore } from "./library-store.js";

/** The bundle's own dependency: the offline renderer and the worklet host. */
const require = createRequire(import.meta.url);
const { OfflineAudioContext } = require("node-web-audio-api");

/** This bundle's directory (bundles/studio). */
const BUNDLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The engine sources, in the names `engine-client.js` looks them up by. */
const ENGINE_DIR = join(BUNDLE_DIR, "engine");
const VENDOR_DIR = join(BUNDLE_DIR, "vendor", "sunvox");

/** The engine client, loaded as the CommonJS classic script the bundle ships. */
const studioEngine = require(join(ENGINE_DIR, "engine-client.js"));

/** Every render is 48 kHz stereo: the rate the engine and the meters assume. */
const SAMPLE_RATE = 48000;

/** Beats in a bar, phase 1b (the sequencer's own constant). */
const BEATS_PER_BAR = 4;

/** The tempo a song without a usable `meta.bpm` is measured at, in bpm. */
const DEFAULT_BPM = 120;

/** How long a render's presigned download URL lives, in seconds (one hour). */
const URL_EXPIRY_SECONDS = 3600;

/**
 * What a song id may look like: a UUID, or one of the short ids the registry
 * lets an agent choose. It becomes a storage key segment and an audit target,
 * so anything else is refused before the id is used anywhere.
 */
const SONG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The message a song id that fails `SONG_ID_PATTERN` gets. */
const INVALID_SONG_ID_MESSAGE = "That is not a valid song id.";

/** The `storage_files.reference_type` a Studio render is filed under. */
const REFERENCE_TYPE = "studio_song";

/** How many renders the queue lets run at the same time. */
const MAX_RUNNING = 1;

/** How many renders may wait behind the running one before calls are refused. */
const MAX_WAITING = 3;

/** The message a call past the queue's limit gets. */
const QUEUE_FULL_MESSAGE = "The render queue is full; try again when the current renders finish.";

/** The longest file-name stem a render may carry (before `.wav`). */
const MAX_NAME_LENGTH = 60;

/**
 * The most samples one take may hold (1200 s of 48 kHz stereo), the cap
 * `server/commands/takes.js` and the upload route enforce. A render refuses a
 * file bigger than this rather than reading it into memory.
 */
const MAX_TAKE_SAMPLES = 115200000;

/** The longest arrangement a song may have, in bars (bar 999 is its last). */
const MAX_FROM_BAR = 998;

/**
 * The largest a take's WAV file can be: its 44-byte header plus 3 bytes a sample.
 */
const MAX_TAKE_BYTES = 44 + MAX_TAKE_SAMPLES * 3;

/**
 * The most samples (frames × channels) one sample may hold: 60 s of 48 kHz
 * stereo, the cap `server/commands/sampler.js` and the upload route enforce.
 */
const MAX_SAMPLE_SAMPLES = 5760000;

/** The largest a sample's WAV file can be: its header plus 3 bytes a sample. */
const MAX_SAMPLE_BYTES = 44 + MAX_SAMPLE_SAMPLES * 3;

/**
 * The browser panel's own cap on the decoded samples one engine holds (see
 * `engine/studio-processor.js`). A render is not the panel: it raises its
 * engine's cap to fit the window it plays, and refuses to start past
 * `RENDER_SAMPLE_BUDGET_BYTES`. Tests lower this through `sampleCapBytes`, so a
 * handful of tiny samples can stand in for a window past the browser's cap.
 */
const BROWSER_SAMPLE_CAP_BYTES = 256 * 1024 * 1024;

/**
 * What one render may hold in decoded samples. Past this the render is refused
 * before it starts: the MCP host renders one song at a time and does not have
 * the memory for more, and a render that quietly dropped samples would be a
 * lie about the song.
 */
const RENDER_SAMPLE_BUDGET_BYTES = 1024 * 1024 * 1024;

/**
 * What one render may hold in instruments: the FONT FILES its soundfont tracks
 * name. The same 1 GiB the plan gives a render, refused the same way and before
 * the render starts (plan 1d, Global Constraints "Memory"). Tests lower it
 * through `fontCapBytes`, exactly as they lower the sample cap.
 */
const RENDER_FONT_BUDGET_BYTES = 1024 * 1024 * 1024;

/** The largest a bank file can be (plan 1d's limit table: 512 MB). */
const MAX_FONT_BYTES = 512 * 1024 * 1024;

/**
 * The device engine that marks a track as a SoundFont one. It is `doc.js`'s
 * `SOUNDFONT_DEVICE.engine`, spelled here so this file keeps importing no app
 * module of the song document.
 */
const SOUNDFONT_ENGINE = "soundfont";

/** Why a font this render does not hold is missing, in the plan's own words. */
const FONT_NOT_HERE = "not on this device";

/** Why a font this Crow should hold could not be read at all. */
const FONT_UNREADABLE = "could not be read";

/** Bytes in a megabyte, for the sentence a refused render gets. */
const BYTES_PER_MB = 1024 * 1024;

/** The asset map handed to `engine-client.create()`, read once per process. */
let cachedAssets = null;

/** The worklet-release symbol, once it has been looked up (null: unavailable). */
let cachedReleaseSymbol;

/**
 * Render one song offline, through the real engine.
 *
 * Exactly one of `scene_id` / `clip_id` may be given: a scene renders every
 * clip it holds on every track, a clip renders just that one. With neither, the
 * FIRST scene that holds at least one clip is launched — the same thing the
 * dashboard's first scene button does — and a song with no clips at all renders
 * the requested length of silence rather than throwing.
 *
 * `{ mode: "arrangement", from_bar }` renders the song's timeline instead: the
 * engine plays the song's placements from that bar, and the scene and clip ids
 * are not used. A mode that is neither `"session"` nor `"arrangement"`, or a
 * `from_bar` that is not a whole bar between 0 and 998, is refused by name
 * rather than quietly rendered as something else.
 *
 * Before the render starts, the takes and samples the render can hear are
 * loaded into the engine through `options.takeAudio` and `options.sampleAudio`,
 * so a song with recorded audio or a kit renders as it sounds rather than as
 * silence. A take that cannot be read stops the render with its id in the
 * sentence (`Take <id> could not be loaded for this render: …`): a render that
 * quietly dropped a performance would be a lie. A sample that cannot be read is
 * reported instead, in `missing_samples` (see "Takes and samples" above); the
 * render itself still happens.
 *
 * Every font the song's soundfont tracks name is loaded the same way, through
 * `options.libraryBytes`, before Play — and a font that cannot be read is
 * reported in `missing_library`, never thrown (see "The instruments" above).
 * The font files' own bytes are summed first, so a window past the render's
 * font budget is refused before its engine exists.
 *
 * @param {object} snapshot the song as the hub's `snapshot()` returns it
 * @param {{scene_id?: string|null, clip_id?: string|null, seconds?: number,
 *          sampleRate?: number, mode?: "session"|"arrangement", from_bar?: number,
 *          takeAudio?: (take: object) => Promise<{rate: number,
 *            channels: Float32Array[]}|null>,
 *          sampleAudio?: (sample: object) => Promise<{rate: number,
 *            channels: Float32Array[]}|null>,
 *          libraryBytes?: (entry: object) => Promise<Uint8Array|Buffer|null>,
 *          sampleCapBytes?: number, fontCapBytes?: number}} [options]
 *   `takeAudio` reads and decodes one take's WAV; it is only called for takes
 *   the render can hear, and only when the song has any. `sampleAudio` does the
 *   same for a sample the playing patterns' steps trigger. `libraryBytes` reads
 *   one library entry's FONT file, and answers null for one this device does not
 *   hold; it is only called for fonts the song's soundfont tracks name. `mode`
 *   and `from_bar` render the arrangement (see above). `sampleCapBytes` is the
 *   cap a render's engine is never built under (the browser's 256 MB unless a
 *   test lowers it): the engine's real cap is that or the window's own sample
 *   bytes, whichever is larger, so no sample a render loads is trimmed away
 *   under it. `fontCapBytes` is the same for the instrument budget (the plan's
 *   1 GiB unless a test lowers it)
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number,
 *                    seconds: number,
 *                    missing_samples: Array<{id: string, reason: string}>,
 *                    missing_library: Array<{id: string, reason: string}>,
 *                    credits: string[]}>}
 *   the rendered stereo channels, every sample the render could not load
 *   (empty when there was none, or the song plays no sampler track), every font
 *   it could not load (empty when it heard them all), and the credit lines of
 *   the library entries it heard
 * @throws {Error} when the window's samples or its font files need more than a
 *   render may hold
 */
export async function renderSong(snapshot, options = {}) {
  const { scene_id = null, clip_id = null, seconds = 1, sampleRate = SAMPLE_RATE } = options;
  const mode = renderMode(options.mode);
  if (scene_id != null && clip_id != null) {
    throw new Error("A render takes a scene_id or a clip_id, not both.");
  }
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("A render needs a positive sample rate.");
  const span = Number(seconds);
  if (!Number.isFinite(span) || span <= 0) throw new Error("A render needs a positive number of seconds.");
  const fromBar = mode === "arrangement" ? renderFromBar(options.from_bar) : 0;
  const length = Math.max(1, Math.round(span * rate));

  // What this render can hear is worked out before anything is built: the
  // samples those clips play decide the engine's sample cap, and a window past
  // the render budget is refused before its engine exists at all.
  let launch = null;
  let takes;
  let samples;
  if (mode === "arrangement") {
    const toBar = fromBar + barsOf(span, snapshot);
    const windowed = windowClips(snapshot, fromBar, toBar);
    takes = takesOfClips(snapshot, windowed);
    samples = samplesOfClips(snapshot, windowed);
  } else {
    launch = pickLaunch(snapshot, scene_id, clip_id);
    const playing = playingClips(snapshot, launch);
    takes = takesOfClips(snapshot, playing);
    samples = samplesOfClips(snapshot, playing);
  }
  const askedCap = Number(options.sampleCapBytes);
  const baseCap = Number.isFinite(askedCap) && askedCap > 0 ? askedCap : BROWSER_SAMPLE_CAP_BYTES;
  const sampleCap = sampleCapFor(samples.samples, rate, baseCap);

  // The fonts those tracks play are files, and a render has no reader to load
  // one late: what the window will hold is summed before its engine exists, so
  // a window past the font budget is refused with its megabytes, never rendered
  // into a synth that would evict a bank it cannot get back.
  const fonts = fontsOfSong(snapshot);
  const askedFontCap = Number(options.fontCapBytes);
  const baseFontCap = Number.isFinite(askedFontCap) && askedFontCap > 0 ? askedFontCap : RENDER_FONT_BUDGET_BYTES;
  const fontBytes = fontCapFor(fonts, baseFontCap);

  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, {
      assetBytes: engineAssets(),
      maxSampleBytes: sampleCap,
      // Never below what this window's fonts take: a font the cap evicted could
      // not be loaded again, and the render has nowhere to ask.
      maxFontBytes: Math.max(baseFontCap, fontBytes),
    });
    engine.setSong(snapshot);
    if (mode === "arrangement") {
      engine.setMode("arrangement");
      engine.seek(fromBar);
    } else {
      if (launch.scene) engine.launchScene(launch.scene);
      if (launch.clip) engine.launchClip(launch.clip);
    }
    await loadTakes(engine, takes, options.takeAudio);
    const missingSamples = await loadSamples(engine, samples.samples, options.sampleAudio);
    // Banks are parsed only while the transport is stopped, and this render's
    // transport has not started yet: load every font now or its tracks are
    // silent for the whole render.
    const library = await loadFonts(engine, fonts, options.libraryBytes);
    engine.play();
    engine.node.connect(context.destination);
    // Without this the render can begin before the song reaches the processor.
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    // copyFromChannel into JS-owned arrays, never getChannelData():
    // node-web-audio-api 2.2.0's getChannelData() hands JS a view of the
    // buffer's native memory (an external array with a no-op finalizer), and
    // under CPU pressure a render read that way came back silent, holding
    // another render's audio, or full of 1e22-sized garbage.
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    return {
      left,
      right,
      sampleRate: rate,
      seconds: length / rate,
      // A pad whose sample is missing plays silence (Review Focus 1); this says
      // which one, and why, so the agent can name it rather than guess.
      missing_samples: [...samples.missing, ...missingSamples],
      // A font this device does not hold costs its own tracks and never the
      // render (Review Focus 5); this names each one and why.
      missing_library: library.missing,
      // Every instrument the render heard, credited the way its licence asks.
      credits: creditsOf(fonts, library.loaded),
    };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

/**
 * Build a renderer: the queue, the limits and the storage rail around
 * `renderSong()`.
 *
 * The renderer holds the shared state of every render this process makes, so
 * there is ONE per MCP process (the queue's limits are per renderer).
 *
 * @param {object} options
 * @param {object} options.db a libsql-compatible client (`execute({sql, args})`)
 * @param {{uploadObject: Function, getPresignedUrl: Function, deleteObject: Function,
 *          getObject?: Function}} options.storage
 *   the S3 client's calls, injected so this module imports no app code;
 *   `getObject(key, {bucket})` (returning `{stream, stat}`) is what a render
 *   plays recorded takes and samples through
 * @param {{assertLocalCapability: Function, appendAudit: Function}} options.acl
 *   the project ACL, injected for the same reason
 * @param {{holds: Function, fileForHash: Function}|null} [options.library]
 *   the instrument catalog and its one verified copy of each catalog file
 *   (`createLibraryStore`). A render reads a catalog entry's bank through it; a
 *   caller that injects none gets the store built over `options.crowHome` (or
 *   this instance's `<CROW_HOME>`), which is what the MCP server uses
 * @param {string} [options.crowHome] where the instrument store lives, when no
 *   `library` is injected
 * @param {number} [options.maxSeconds] the longest render allowed; defaults to
 *   `STUDIO_MAX_RENDER_SECONDS`, else 300
 * @param {string} [options.bucket] the S3 bucket renders go to
 * @param {() => (number|Date)} [options.now] the clock the key's timestamp uses
 * @param {Function} [options.renderAudio] the audio renderer (defaults to
 *   `renderSong`); tests and alternate hosts inject their own
 * @returns {{render: (request: object) => Promise<{storage_key: string, url: string,
 *            seconds: number, lufs: number, true_peak_db: number,
 *            missing_samples: Array<{id: string, reason: string}>,
 *            missing_library: Array<{id: string, reason: string}>,
 *            credits: string[]}>}}
 */
export function createRenderer({
  db,
  storage,
  acl,
  library = null,
  crowHome = null,
  maxSeconds = Number(process.env.STUDIO_MAX_RENDER_SECONDS) || 300,
  bucket = "crow-files",
  now = () => Date.now(),
  renderAudio = renderSong,
} = {}) {
  if (!db || typeof db.execute !== "function") throw new TypeError("createRenderer needs a database client");
  if (!storage || typeof storage.uploadObject !== "function" || typeof storage.getPresignedUrl !== "function") {
    throw new TypeError("createRenderer needs a storage client (uploadObject, getPresignedUrl, deleteObject)");
  }
  if (!acl || typeof acl.assertLocalCapability !== "function" || typeof acl.appendAudit !== "function") {
    throw new TypeError("createRenderer needs the project ACL (assertLocalCapability, appendAudit)");
  }
  const limit = Number(maxSeconds);
  const longest = Number.isFinite(limit) && limit > 0 ? limit : 300;

  // The instrument store, built on first use: a song with no font never touches
  // the instrument directory, and a caller that injected a store (a test with
  // its own catalog) keeps it.
  let ownLibrary = null;
  /** @returns {object} the store a catalog entry's bank is read through. */
  function libraryStore() {
    if (library) return library;
    if (ownLibrary === null) ownLibrary = createLibraryStore({ crowHome: crowHome || defaultCrowHome() });
    return ownLibrary;
  }

  // The queue: at most one render running, at most MAX_WAITING of them waiting.
  // A call's slot covers its whole job (audio, upload, row), so two renders
  // never fight over the same worklet host or the same storage client.
  let running = 0;
  const waiters = [];

  /** @returns {Promise<void>} resolves when this call may render */
  function acquire() {
    if (running < MAX_RUNNING) {
      running += 1;
      return Promise.resolve();
    }
    if (waiters.length >= MAX_WAITING) return Promise.reject(new Error(QUEUE_FULL_MESSAGE));
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  /** @returns {void} hand the slot to the next waiter, or free it */
  function release() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    running = Math.max(0, running - 1);
  }

  /**
   * Render a song and store it, returning where it landed and how it measures.
   *
   * Order matters: the song id and the project are validated, then the time
   * limit is checked, all before anything is touched; then the ACL, then the
   * queue (a refused render must not hold a slot), and only then is any audio
   * rendered.
   *
   * @param {object} request
   * @param {string} request.song_id
   * @param {number} request.project_id the project the song lives in (required)
   * @param {object} request.snapshot the song to render
   * @param {string|null} [request.scene_id] render this scene
   * @param {string|null} [request.clip_id] render this clip
   * @param {number} request.seconds how much to render
   * @param {"session"|"arrangement"} [request.mode] render the session grid
   *   (the default) or the song's timeline
   * @param {number} [request.from_bar] the bar an arrangement render starts at
   *   (a whole bar from 0 to 998; ignored for a session render)
   * @param {{kind?: string, id?: string, label?: string}|null} [request.author]
   *   who asked; a human author is audited as `local`, anything else as `bot`
   * @returns {Promise<{storage_key: string, url: string, seconds: number,
   *                    lufs: number, true_peak_db: number,
   *                    missing_samples: Array<{id: string, reason: string}>,
   *                    missing_library: Array<{id: string, reason: string}>,
   *                    credits: string[]}>}
   *   where the render landed, how it measures, every sample and every font it
   *   could not load (each plays silence; these name them), and the credit lines
   *   of the instruments it heard
   */
  async function render(request = {}) {
    const { song_id, project_id = null, snapshot, scene_id = null, clip_id = null, seconds, author = null } = request;
    if (typeof song_id !== "string" || song_id === "") throw new Error("A render needs the song's id.");
    // The id is a key segment and an audit target: refuse anything else here,
    // before any upload, row or audit line can carry it.
    if (!SONG_ID_PATTERN.test(song_id)) throw new Error(INVALID_SONG_ID_MESSAGE);
    // A render is always filed under the song's project: the ACL call and the
    // storage prefix both need it, so a render without one is refused clearly.
    if (project_id == null) throw new Error("A render needs the song's project.");
    const span = checkSeconds(seconds, longest);
    // Which view, and where in the timeline: refused here, before a slot is
    // taken, so a bad request never holds the render queue.
    const mode = renderMode(request.mode);
    const fromBar = renderFromBar(request.from_bar);

    await acl.assertLocalCapability(db, project_id, "write_files");
    await acquire();
    try {
      // The same prefix both puts the render and finds the song's takes; it is
      // read once, before anything is rendered.
      const prefix = await storagePrefixFor(db, project_id);
      const takeAudio = (take) => takeAudioFrom({ storage, bucket, prefix, songId: song_id, take });
      const sampleAudio = (sample) => sampleAudioFrom({ storage, bucket, prefix, songId: song_id, sample });
      // A bank comes from the instrument store (a catalog entry) or from the
      // upload's own storage key (an upload), never from anywhere else.
      const libraryBytes = (entry) =>
        fontBytesFrom({ library: libraryStore(), storage, bucket, prefix, songId: song_id, entry });
      const audio = await renderAudio(snapshot, {
        scene_id,
        clip_id,
        seconds: span,
        mode,
        from_bar: fromBar,
        takeAudio,
        sampleAudio,
        libraryBytes,
      });
      const rate = Number(audio.sampleRate) || SAMPLE_RATE;
      const renderedSeconds = audio.seconds;
      // A pad whose sample could not be loaded plays silence; this is the list
      // the agent is told about, in the result and in the audit line.
      const missingSamples = Array.isArray(audio.missing_samples) ? audio.missing_samples : [];
      // A bank this device does not hold plays silence too (Review Focus 5), and
      // so does one the engine will not parse: named the same way.
      const missingLibrary = Array.isArray(audio.missing_library) ? audio.missing_library : [];
      // Every CC-BY instrument the render heard, credited in the metadata.
      const credits = Array.isArray(audio.credits)
        ? audio.credits.filter((credit) => typeof credit === "string" && credit !== "")
        : [];
      const lufs = integratedLufs(audio.left, audio.right, rate);
      const truePeak = truePeakDb(audio.left, audio.right, rate);
      const wav = encodeWav24(audio.left, audio.right, rate);
      // Measured and quantised: the two float channels (~57 MB each for a
      // 300 s render) are never read again, so drop the last references to
      // them before the upload starts.
      audio.left = null;
      audio.right = null;

      const stem = renderName(snapshot, { scene_id, clip_id });
      const key = `${prefix}studio/${song_id}/${timestampOf(now)}-${stem}.wav`;

      // A view over the encoder's bytes, not a copy: the WAV is up to ~86 MB.
      const wavBytes = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
      await storage.uploadObject(key, wavBytes, { bucket, contentType: "audio/wav" });

      try {
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [key, `${stem}.wav`, "audio/wav", wav.byteLength, bucket, REFERENCE_TYPE, song_id, project_id],
        });
      } catch (error) {
        // A row that never landed must not leave an untracked object behind.
        try {
          await storage.deleteObject(key, bucket);
        } catch {
          /* the insert's error is the one the caller needs to see */
        }
        throw error;
      }

      await acl.appendAudit(db, {
        project_id,
        ...auditActor(author),
        action: "studio.render",
        target: `song:${song_id}`,
        payload: {
          scene_id,
          clip_id,
          seconds: renderedSeconds,
          storage_key: key,
          lufs,
          true_peak_db: truePeak,
          missing_samples: missingSamples,
          missing_library: missingLibrary,
          credits: credits,
        },
      });

      const url = await storage.getPresignedUrl(key, { bucket, expiry: URL_EXPIRY_SECONDS });
      return {
        storage_key: key,
        url,
        seconds: renderedSeconds,
        lufs,
        true_peak_db: truePeak,
        missing_samples: missingSamples,
        missing_library: missingLibrary,
        credits: credits,
      };
    } finally {
      release();
    }
  }

  return { render };
}

/**
 * Who gets the audit line: a human author is `local`, and anything else — an
 * agent, or no author at all (an internal call) — is `bot` with no id.
 * @param {{kind?: string, id?: string}|null} [author]
 * @returns {{actor_type: string, actor_id: (string|null)}}
 */
function auditActor(author) {
  if (author && author.kind === "human") {
    return { actor_type: "local", actor_id: author.id != null ? author.id : null };
  }
  return { actor_type: "bot", actor_id: author && author.id != null ? author.id : null };
}

/**
 * Refuse a render that is not a positive, in-limit number of seconds.
 * @param {unknown} seconds
 * @param {number} longest the renderer's limit
 * @returns {number} the same value as a number
 */
function checkSeconds(seconds, longest) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0 || value > longest) {
    throw new Error(`A render can be at most ${longest} seconds long.`);
  }
  return value;
}

/**
 * Hand the engine every take the render can hear.
 *
 * The engine plays a comp's segments by take id, so a take that was never
 * loaded is silence; loading them all before `flush()` is what makes an audio
 * clip render as it sounds. `takeAudio` is the caller's reader: it takes one
 * take of the snapshot and answers its decoded PCM, or `null` when there is
 * none. Its own refusals (a take stored outside the song's prefix) are passed
 * on unchanged, because they name what the operator has to fix.
 *
 * @param {object} engine the engine `studioEngine.create()` returned
 * @param {object[]} takes the takes this render hears (see `takesOfClips` and
 *   the clip helpers above)
 * @param {Function|undefined} takeAudio the caller's reader
 * @returns {Promise<void>}
 */
async function loadTakes(engine, takes, takeAudio) {
  for (const take of takes) {
    if (typeof takeAudio !== "function") {
      throw new Error(takeLoadFailure(take.id, "this render has no way to read takes"));
    }
    const audio = await takeAudio(take);
    if (!audio || !Array.isArray(audio.channels) || audio.channels.length === 0 || !(Number(audio.rate) > 0)) {
      throw new Error(takeLoadFailure(take.id, "its audio was not found"));
    }
    await engine.loadAudio(take.id, audio.channels, Number(audio.rate));
  }
}

/**
 * The clips a session render plays: that scene's clips, that one clip, or none
 * at all for a render that launches neither (silence).
 *
 * @param {object} snapshot the song
 * @param {{scene?: string, clip?: string}} launch what the render launches
 * @returns {object[]} the clips, as the snapshot holds them
 */
function playingClips(snapshot, launch) {
  const clips = snapshot && snapshot.clips && typeof snapshot.clips === "object" ? snapshot.clips : {};
  const playing = [];
  if (launch.clip) {
    const clip = clips[launch.clip];
    if (clip) playing.push(clip);
  } else if (launch.scene) {
    for (const clip of Object.values(clips)) {
      if (clip && clip.scene_id === launch.scene) playing.push(clip);
    }
  }
  return playing;
}

/**
 * The clips an arrangement render plays: every clip with a placement
 * intersecting the rendered window of bars.
 *
 * @param {object} snapshot the song
 * @param {number} fromBar the first bar the render plays
 * @param {number} toBar the bar it stops at (exclusive)
 * @returns {object[]} the clips, as the snapshot holds them
 */
function windowClips(snapshot, fromBar, toBar) {
  const clips = snapshot && snapshot.clips && typeof snapshot.clips === "object" ? snapshot.clips : {};
  const placements = placementsOf(snapshot);
  const playing = [];
  const seen = new Set();
  for (const placement of placements) {
    const start = Number(placement.start_bar);
    const bars = Number(placement.bars);
    if (!Number.isFinite(start) || !Number.isFinite(bars)) continue;
    // Half-open on both sides: a placement that ends where the window starts is
    // behind it, and one that starts where it ends is past it.
    if (!(start < toBar && fromBar < start + bars)) continue;
    const clip = clips[placement.clip_id];
    if (!clip || seen.has(clip.id)) continue;
    seen.add(clip.id);
    playing.push(clip);
  }
  return playing;
}

/**
 * The takes the comps of some clips name, without the discarded ones, each once.
 * @param {object} snapshot the song
 * @param {object[]} clips the clips being played
 * @returns {object[]}
 */
function takesOfClips(snapshot, clips) {
  const takes = snapshot && snapshot.takes && typeof snapshot.takes === "object" ? snapshot.takes : {};
  const wanted = [];
  const seen = new Set();
  for (const clip of clips) {
    if (!clip || clip.kind !== "audio" || !Array.isArray(clip.comp)) continue;
    for (const segment of clip.comp) {
      const id = segment && typeof segment.take_id === "string" ? segment.take_id : "";
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      const take = takes[id];
      // A discarded take is out of the song as far as its sound goes, even if
      // a comp still names it (the document refuses that, a mid-edit song may
      // not have caught up yet).
      if (!take || take.discarded === true) continue;
      wanted.push(take);
    }
  }
  return wanted;
}

/**
 * The samples the pads of some pattern clips' playing steps trigger, each once,
 * and the ids a pad plays that the song does not hold at all.
 *
 * A pattern clip plays its chain, or — with no chain — its first pattern. Every
 * step of those patterns names a pad of the clip's track, the pad names a
 * sample, and that sample has to be in the engine before the steps can sound.
 * The order is the song's own: clips as the snapshot holds them, patterns in
 * chain order, steps in the map's order; nothing is read twice.
 *
 * @param {object} snapshot the song
 * @param {object[]} clips the clips being played
 * @returns {{samples: object[], missing: Array<{id: string, reason: string}>}}
 *   the samples as the snapshot holds them, and the sample ids a pad plays that
 *   the song has no sample object for (a dangling pad, reported not skipped)
 */
function samplesOfClips(snapshot, clips) {
  const pads = snapshot && snapshot.pads && typeof snapshot.pads === "object" ? snapshot.pads : {};
  const samples = snapshot && snapshot.samples && typeof snapshot.samples === "object" ? snapshot.samples : {};
  const patterns = snapshot && snapshot.patterns && typeof snapshot.patterns === "object" ? snapshot.patterns : {};
  const steps = snapshot && snapshot.steps && typeof snapshot.steps === "object" ? snapshot.steps : {};

  // One walk of the steps, grouped by the pattern they belong to, so a clip's
  // chain does not have to scan every step of the song once per pattern.
  const stepsByPattern = new Map();
  for (const step of Object.values(steps)) {
    if (!step || typeof step.pattern_id !== "string") continue;
    const key = `${step.clip_id}\n${step.pattern_id}`;
    const list = stepsByPattern.get(key);
    if (list) list.push(step);
    else stepsByPattern.set(key, [step]);
  }

  const wanted = [];
  const seen = new Set();
  const missing = [];
  for (const clip of clips) {
    if (!clip || clip.kind !== "pattern") continue;
    for (const pattern of patternsPlaying(clip, patterns)) {
      for (const step of stepsByPattern.get(`${clip.id}\n${pattern.id}`) ?? []) {
        const pad = pads[`${clip.track_id}/${step.bank_id}/${step.index}`];
        const sampleId = pad && typeof pad.sample_id === "string" ? pad.sample_id : "";
        if (sampleId === "" || seen.has(sampleId)) continue;
        seen.add(sampleId);
        const sample = samples[sampleId];
        if (sample) {
          wanted.push(sample);
          continue;
        }
        // A pad that names a sound the song does not hold: nothing to read, and
        // nothing to guess — it is reported as missing.
        missing.push({ id: sampleId, reason: "the song has no such sample" });
      }
    }
  }
  return { samples: wanted, missing };
}

/**
 * The PCM bytes one sample takes in the engine at a render's rate.
 *
 * The processor holds decoded float32 frames, one array per channel, and the
 * engine client resamples a sample recorded at another rate to the context's
 * rate before it loads it, so the bytes are counted at the render's rate. One
 * extra frame is allowed per sample for the resampler's own rounding: a cap is
 * only useful if it is never smaller than what the engine really holds.
 *
 * @param {object} sample a sample as the snapshot carries it
 * @param {number} rate the render's sample rate
 * @returns {number} bytes, or 0 for a sample with no frames
 */
function sampleBytesAt(sample, rate) {
  const frames = Number(sample && sample.frames);
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  const channels = Math.max(1, Math.trunc(Number(sample && sample.channels)) || 1);
  const source = Number(sample && sample.rate);
  const from = Number.isFinite(source) && source > 0 ? source : rate;
  const held = Math.ceil((frames * rate) / from) + 1;
  return held * channels * 4;
}

/**
 * The sample cap a render's engine is built with: every byte the window's
 * samples take at the render's rate, so nothing the render loads is trimmed
 * away under it, and never below `base` (the browser's own cap, or the smaller
 * one a test passes as `sampleCapBytes`).
 *
 * A window that needs more than `RENDER_SAMPLE_BUDGET_BYTES` is refused here,
 * with the megabytes it would need — before a context, an engine or a read.
 *
 * @param {object[]} samples the samples this render hears (see `samplesOfClips`)
 * @param {number} rate the render's sample rate
 * @param {number} base the cap a render is never built under
 * @returns {number} the cap, in bytes
 * @throws {Error} when the samples need more than a render may hold
 */
function sampleCapFor(samples, rate, base) {
  let bytes = 0;
  for (const sample of samples) bytes += sampleBytesAt(sample, rate);
  if (bytes > RENDER_SAMPLE_BUDGET_BYTES) {
    throw new Error(
      `This render needs ${Math.ceil(bytes / BYTES_PER_MB)} MB of samples; a render holds at most ${RENDER_SAMPLE_BUDGET_BYTES / BYTES_PER_MB} MB.`,
    );
  }
  return Math.max(base, bytes);
}

/**
 * The fonts a render has to load: every library entry a soundfont track names,
 * once each, in the song's own track order.
 *
 * Muted and soloed-out tracks count. A muted track is still the song's, and a
 * render that quietly left its instrument out would report a mix nobody can
 * reproduce: unmute the track in the panel and the bank has to be there.
 * A track whose `font_id` the song's library does not hold is included too, with
 * `entry: null`, so it is REPORTED as missing rather than passed over.
 *
 * @param {object} snapshot the song
 * @returns {Array<{id: string, entry: object|null}>} the fonts, first use first
 */
function fontsOfSong(snapshot) {
  const tracks = snapshot && Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
  const library = snapshot && snapshot.library && typeof snapshot.library === "object" ? snapshot.library : {};
  const fonts = [];
  const seen = new Set();
  for (const track of tracks) {
    const device = track && track.device && typeof track.device === "object" ? track.device : null;
    if (!device || device.engine !== SOUNDFONT_ENGINE) continue;
    const id = typeof device.font_id === "string" ? device.font_id : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const entry = library[id] && typeof library[id] === "object" ? library[id] : null;
    fonts.push({ id, entry });
  }
  return fonts;
}

/**
 * The bytes one font's file takes, as the song's own library entry says: the
 * size the server measured when it stored or verified the file.
 * @param {{entry?: object|null}} font
 * @returns {number} bytes, or 0 for an entry that says nothing useful
 */
function fontFileBytes(font) {
  const bytes = Number(font && font.entry ? font.entry.bytes : NaN);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/**
 * The bytes a render's fonts take together, refused when past the budget — the
 * same refusal, before the same start, as the sample cap.
 *
 * The sum is arithmetic over the sizes the song's library carries, so a window
 * past the budget is refused before a file is opened, a context is built or a
 * bank is parsed.
 *
 * @param {Array<{id: string, entry: object|null}>} fonts this render's fonts
 * @param {number} cap the most it may hold, in bytes
 * @returns {number} the bytes they take, for the engine's own cap
 * @throws {Error} when they need more than `cap`
 */
function fontCapFor(fonts, cap) {
  let bytes = 0;
  for (const font of fonts) bytes += fontFileBytes(font);
  if (bytes > cap) {
    const limit = Math.max(1, Math.ceil(cap / BYTES_PER_MB));
    throw new Error(
      `This render's instruments need ${Math.ceil(bytes / BYTES_PER_MB)} MB; a render takes up to ${limit} MB of instruments.`,
    );
  }
  return bytes;
}

/**
 * Hand the engine every font the render's soundfont tracks play, and name the
 * ones it cannot hear.
 *
 * `libraryBytes` is the caller's reader: it takes one library entry and answers
 * the bank file's bytes, or `null` when this device does not hold the file at
 * all. Its own refusals (a storage key outside the song's own `library/`, a
 * disk that failed) are never read. A font it cannot produce is reported, not
 * thrown: a track that names a bank this device does not have plays silence
 * (Review Focus 5), and one missing bank must not turn into a failed render of
 * a whole song. A render with no reader at all reports every font it wanted the
 * same way, exactly as `loadSamples` does for samples.
 *
 * The engine's answer is reported too: a bank that will not parse carries the
 * engine's own reason, which is what the operator has to read, and only a load
 * that came back `loaded` counts as heard (a `deferred` load waits for a Stop
 * an offline render never reaches, so its tracks are silent).
 *
 * @param {object} engine the engine `studioEngine.create()` returned
 * @param {Array<{id: string, entry: object|null}>} fonts this render's fonts
 * @param {Function|undefined} libraryBytes the caller's reader
 * @returns {Promise<{missing: Array<{id: string, reason: string}>,
 *                    loaded: Set<string>}>} what could not be heard, and what was
 */
async function loadFonts(engine, fonts, libraryBytes) {
  const missing = [];
  const loaded = new Set();
  for (const font of fonts) {
    const id = font.id;
    if (!font.entry) {
      // A track that names a font the song's library does not hold: there is no
      // file to look for, so it is a font this device does not have.
      missing.push({ id, reason: FONT_NOT_HERE });
      continue;
    }
    if (typeof libraryBytes !== "function" || typeof engine.loadLibrary !== "function") {
      missing.push({ id, reason: FONT_NOT_HERE });
      continue;
    }
    let bytes = null;
    try {
      bytes = await libraryBytes(font.entry);
    } catch {
      missing.push({ id, reason: FONT_UNREADABLE });
      continue;
    }
    if (!bytes) {
      missing.push({ id, reason: FONT_NOT_HERE });
      continue;
    }
    let answer = null;
    try {
      answer = await engine.loadLibrary(id, "font", bytes);
    } catch (error) {
      missing.push({ id, reason: engineReasonOf(error) });
      continue;
    }
    const status = answer && typeof answer.status === "string" ? answer.status : "";
    if (status === "loaded") {
      loaded.add(id);
      continue;
    }
    missing.push({ id, reason: engineReasonOf(answer) });
  }
  return { missing, loaded };
}

/**
 * The engine's own words for a font that did not load, or the plain sentence
 * when it gave none.
 * @param {unknown} source the load's answer, or the error it threw
 * @returns {string}
 */
function engineReasonOf(source) {
  const reason = source && typeof source.reason === "string" ? source.reason.trim() : "";
  if (reason !== "") return reason;
  const message = source && typeof source.message === "string" ? source.message.trim() : "";
  return message !== "" ? message : FONT_UNREADABLE;
}

/**
 * The credit line of every font the render heard that carries one, deduped, in
 * the song's own first-use order — what a CC-BY bank asks the render's metadata
 * to show (plan 1d, Global Constraints "Credits").
 * @param {Array<{id: string, entry: object|null}>} fonts this render's fonts
 * @param {Set<string>} loaded the font ids the engine really loaded
 * @returns {string[]}
 */
function creditsOf(fonts, loaded) {
  const credits = [];
  for (const font of fonts) {
    if (!loaded.has(font.id)) continue;
    const credit = font.entry && typeof font.entry.credit === "string" ? font.entry.credit.trim() : "";
    if (credit === "" || credits.includes(credit)) continue;
    credits.push(credit);
  }
  return credits;
}

/**
 * The patterns of one pattern clip that actually play: its chain in order, or
 * its first pattern when no entry names one.
 *
 * A chain is followed exactly as the sequencer follows it — an entry that names
 * no pattern of this clip keeps its slot and plays silence, and the entries that
 * do name one are played in their order — and, like the sequencer, a chain that
 * names no pattern of the clip at all falls back to the clip's own first
 * pattern (an empty chain, or one whose patterns are gone).
 *
 * @param {object} clip the pattern clip
 * @param {Object<string, object>} patterns the song's patterns, keyed by ref id
 * @returns {object[]}
 */
function patternsPlaying(clip, patterns) {
  const own = Object.values(patterns).filter((pattern) => pattern && pattern.clip_id === clip.id);
  const chain = Array.isArray(clip.chain) ? clip.chain : [];
  const playing = [];
  for (const id of chain) {
    const pattern = own.find((candidate) => candidate.id === id);
    if (pattern) playing.push(pattern);
  }
  if (playing.length > 0) return playing;
  const first = own.sort((left, right) => Number(left.order) - Number(right.order))[0];
  return first ? [first] : [];
}

/**
 * Hand the engine every sample the render can hear, and name the ones it cannot.
 *
 * `sampleAudio` is the caller's reader (built like the take one), and its own
 * refusals — a key outside the song's own `samples/` directory — are never read.
 * A sample it cannot produce is reported as missing, not thrown: a pad whose
 * sample is missing plays silence (the same answer the audio thread gives), and
 * one dangling pad does not fail a whole render. A render with no reader at all
 * reports every sample it wanted the same way. `engine.loadSample` arrives with
 * the sampler voices; an engine without it simply does not take the audio.
 *
 * @param {object} engine the engine `studioEngine.create()` returned
 * @param {object[]} samples the samples this render hears (see `samplesOfClips`)
 * @param {Function|undefined} sampleAudio the caller's reader
 * @returns {Promise<Array<{id: string, reason: string}>>} what could not be loaded
 */
async function loadSamples(engine, samples, sampleAudio) {
  const missing = [];
  for (const sample of samples) {
    const id = typeof sample.id === "string" ? sample.id : "";
    if (typeof sampleAudio !== "function") {
      missing.push({ id, reason: "this render cannot read samples" });
      continue;
    }
    let audio = null;
    try {
      audio = await sampleAudio(sample);
    } catch (error) {
      missing.push({ id, reason: sampleMissingReason(error) });
      continue;
    }
    if (!audio || !Array.isArray(audio.channels) || audio.channels.length === 0 || !(Number(audio.rate) > 0)) {
      missing.push({ id, reason: "the file could not be read" });
      continue;
    }
    if (typeof engine.loadSample === "function") {
      await engine.loadSample(sample.id, audio.channels, Number(audio.rate));
    }
  }
  return missing;
}

/**
 * The song's placements, in the order the snapshot holds them (an empty list
 * for a song with no arrangement).
 * @param {object} snapshot
 * @returns {object[]}
 */
function placementsOf(snapshot) {
  const arrangement = snapshot && snapshot.arrangement;
  const placements = arrangement && arrangement.placements;
  return placements && typeof placements === "object" ? Object.values(placements) : [];
}

/**
 * How many bars a render of this many seconds covers, at the song's own tempo
 * and four beats to the bar.
 * @param {number} seconds
 * @param {object} snapshot
 * @returns {number}
 */
function barsOf(seconds, snapshot) {
  const meta = snapshot && snapshot.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
  const bpm = Number(meta.bpm);
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  return (Number(seconds) * tempo) / (60 * BEATS_PER_BAR);
}

/**
 * A `from_bar` option as a whole bar. A bar the engine cannot have is refused
 * here, before any audio is rendered: bar 0 is the first one and 999 bars is
 * the longest arrangement a song may have.
 * @param {unknown} value
 * @returns {number}
 */
function renderFromBar(value) {
  if (value === undefined || value === null) return 0;
  const bar = Number(value);
  if (!Number.isInteger(bar) || bar < 0 || bar > MAX_FROM_BAR) {
    throw new Error(`A render can start at a whole bar from 0 to ${MAX_FROM_BAR}.`);
  }
  return bar;
}

/**
 * The view a render plays: the session grid or the song's timeline. A mode the
 * engine does not have is refused rather than rendered as the session.
 * @param {unknown} value
 * @returns {"session"|"arrangement"}
 */
function renderMode(value) {
  if (value === undefined || value === null) return "session";
  if (value === "session" || value === "arrangement") return value;
  throw new Error('A render plays "session" or "arrangement".');
}

/**
 * The one sentence a take that could not be read fails a render with.
 * @param {string} id the take's id
 * @param {unknown} reason why, in plain English
 * @returns {string}
 */
function takeLoadFailure(id, reason) {
  const text = String(reason ?? "").trim().replace(/[.\s]+$/, "");
  return `Take ${id} could not be loaded for this render: ${text === "" ? "the file could not be read" : text}.`;
}

/**
 * The one sentence a sample that could not be loaded fails with.
 * @param {string} id the sample's id
 * @param {unknown} reason why, in plain English
 * @returns {string}
 */
function sampleLoadFailure(id, reason) {
  const text = String(reason ?? "").trim().replace(/[.\s]+$/, "");
  return `Sample ${id} could not be loaded for this render: ${text === "" ? "the file could not be read" : text}.`;
}

/**
 * Why one sample is missing from a render, in a reader's own words when it has
 * any: the sentence `sampleLoadFailure` wrote, or a plain one.
 * @param {unknown} error
 * @returns {string}
 */
function sampleMissingReason(error) {
  const text = error && typeof error.message === "string" ? error.message.trim() : "";
  return text === "" ? "the file could not be read" : text;
}

/**
 * Read one take's WAV back out of storage and decode it, refusing anything
 * that is not exactly where Studio keeps this song's takes.
 *
 * The key is built here, from the song's project prefix and the song's own id,
 * and the take's `storage_key` has to equal it: a document that named some
 * other object — another song's take, a render, a file outside the project —
 * is refused by name rather than read.
 *
 * @param {object} options
 * @param {object} options.storage the S3 client (needs `getObject`)
 * @param {string} options.bucket the bucket takes live in
 * @param {string} options.prefix the song's project storage prefix
 * @param {string} options.songId the song the render is of
 * @param {object} options.take the take, as the snapshot holds it
 * @returns {Promise<{rate: number, channels: Float32Array[]}>}
 */
async function takeAudioFrom({ storage, bucket, prefix, songId, take }) {
  const id = take && typeof take.id === "string" ? take.id : "";
  const key = `${prefix}studio/${songId}/takes/${id}.wav`;
  if (!take || take.storage_key !== key) {
    throw new Error(`Take ${id} is not stored where Studio keeps this song's takes.`);
  }
  return readStoredWav({
    storage,
    bucket,
    key,
    maxBytes: MAX_TAKE_BYTES,
    tooBig: "its file is larger than a take can be",
    fail: (reason) => takeLoadFailure(id, reason),
  });
}

/**
 * Read one library entry's FONT file, the way this instance keeps it.
 *
 * A catalog entry is read from the one verified copy at
 * `<CROW_HOME>/studio/library/<sha256>.<ext>`, and only after the store says
 * those bytes still hash to the name: a file whose name is not what it says is
 * no bank any song may play (`library-store.js`). An uploaded entry is read from
 * the exact storage key its upload wrote, and only when that key sits under
 * this song's own `studio/<song_id>/library/`, named for this very entry — the
 * same own-prefix rule the library file route keeps, so a render can read
 * nothing of a song but that song's own files. A bundled file ships inside the
 * bundle and nothing serves one yet, so it reads as a file this Crow does not
 * have.
 *
 * `null` means "this device does not hold it" (nothing stored, a key that is
 * not this song's, a storage object that is gone), which the render reports as
 * "not on this device". A read that fails any other way throws, and the render
 * reports "could not be read".
 *
 * @param {object} options
 * @param {object|null} options.library the instrument store (`createLibraryStore`)
 * @param {object} options.storage the S3 client (needs `getObject`)
 * @param {string} options.bucket the bucket uploads live in
 * @param {string} options.prefix the song's project storage prefix
 * @param {string} options.songId the song the render is of
 * @param {object} options.entry the library entry, as the snapshot holds it
 * @returns {Promise<Uint8Array|Buffer|null>} the file's bytes, or null
 */
async function fontBytesFrom({ library, storage, bucket, prefix, songId, entry }) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.kind !== "font") return null;
  if (entry.source === "bundled") return null;

  const catalogId = typeof entry.catalog_id === "string" ? entry.catalog_id : "";
  if (catalogId !== "") {
    if (!library || typeof library.holds !== "function" || typeof library.fileForHash !== "function") return null;
    const sha256 = String(entry.sha256 ?? "").toLowerCase();
    // Verify ON READ: a stored file that no longer hashes to the name its entry
    // trusts is not this instrument, whatever it is called.
    if (!(await library.holds(sha256))) return null;
    const path = await library.fileForHash(sha256);
    if (!path) return null;
    const info = statSync(path);
    if (!info.isFile()) return null;
    if (info.size > MAX_FONT_BYTES) throw new Error("its file is larger than a bank can be");
    return readFileSync(path);
  }

  const id = typeof entry.id === "string" ? entry.id : "";
  const storedKey = typeof entry.storage_key === "string" ? entry.storage_key : "";
  if (id === "" || storedKey === "") return null;
  if (!storage || typeof storage.getObject !== "function") return null;
  // An uploaded bank: the exact key its finish wrote, under this song's own
  // `library/` directory, named for this entry. A key anywhere else — another
  // song's, another project's, or one with a `..` in it — is not this song's.
  const ownPrefix = `${prefix}studio/${songId}/library/${id}.`;
  if (!storedKey.startsWith(ownPrefix) || storedKey.slice(ownPrefix.length).includes("/")) return null;
  return readStoredFile({ storage, bucket, key: storedKey, maxBytes: MAX_FONT_BYTES });
}

/**
 * Read one stored object whole, under a cap on its size, without decoding it.
 *
 * A storage object that is simply not there answers `null` (the key does not
 * exist, which is a file this device does not hold); every other failure throws,
 * because a disk that broke is not the same answer as a file nobody fetched.
 *
 * @param {object} options
 * @param {object} options.storage the S3 client (needs `getObject`)
 * @param {string} options.bucket
 * @param {string} options.key the object's exact key
 * @param {number} options.maxBytes the kind's own cap on a file
 * @returns {Promise<Uint8Array|null>}
 */
async function readStoredFile({ storage, bucket, key, maxBytes }) {
  let opened;
  try {
    opened = await storage.getObject(key, { bucket });
  } catch (error) {
    const code = String(error && error.code ? error.code : "");
    if (code === "NotFound" || code === "NoSuchKey") return null;
    throw error;
  }
  const size = Number(opened && opened.stat ? opened.stat.size : NaN);
  if (Number.isFinite(size) && size > maxBytes) throw new Error("its file is larger than a bank can be");
  const bytes = await streamBytes(opened && opened.stream);
  if (bytes.length > maxBytes) throw new Error("its file is larger than a bank can be");
  return bytes;
}

/**
 * Read one sample's WAV back out of storage and decode it, on the take reader's
 * terms and with the same exact-key rule: only an object under this song's own
 * `studio/<song_id>/samples/`, named for this exact sample, is read.
 *
 * @param {object} options
 * @param {object} options.storage the S3 client (needs `getObject`)
 * @param {string} options.bucket the bucket samples live in
 * @param {string} options.prefix the song's project storage prefix
 * @param {string} options.songId the song the render is of
 * @param {object} options.sample the sample, as the snapshot holds it
 * @returns {Promise<{rate: number, channels: Float32Array[]}>}
 */
async function sampleAudioFrom({ storage, bucket, prefix, songId, sample }) {
  const id = sample && typeof sample.id === "string" ? sample.id : "";
  const key = `${prefix}studio/${songId}/samples/${id}.wav`;
  if (!sample || sample.storage_key !== key) {
    throw new Error(`Sample ${id} is not stored where Studio keeps this song's samples.`);
  }
  return readStoredWav({
    storage,
    bucket,
    key,
    maxBytes: MAX_SAMPLE_BYTES,
    tooBig: "its file is larger than a sample can be",
    fail: (reason) => sampleLoadFailure(id, reason),
  });
}

/**
 * Read one stored WAV whole and decode it, but only after its size is known and
 * under the kind's cap. `fail` writes the sentence a caller gets, so each kind
 * names what it could not load.
 *
 * @param {object} options
 * @param {object} options.storage the S3 client (needs `getObject`)
 * @param {string} options.bucket
 * @param {string} options.key the object's exact key
 * @param {number} options.maxBytes the kind's own cap on a file
 * @param {string} options.tooBig why a file past the cap cannot be read
 * @param {(reason: unknown) => string} options.fail the sentence to throw
 * @returns {Promise<{rate: number, channels: Float32Array[]}>}
 */
async function readStoredWav({ storage, bucket, key, maxBytes, tooBig, fail }) {
  if (!storage || typeof storage.getObject !== "function") {
    throw new Error(fail("this Studio cannot read files from storage"));
  }

  let opened;
  try {
    opened = await storage.getObject(key, { bucket });
  } catch (error) {
    throw new Error(fail(reasonText(error)));
  }

  const size = Number(opened && opened.stat ? opened.stat.size : NaN);
  if (Number.isFinite(size) && size > maxBytes) throw new Error(fail(tooBig));

  let bytes;
  try {
    bytes = await streamBytes(opened && opened.stream);
  } catch (error) {
    throw new Error(fail(reasonText(error)));
  }
  if (bytes.length > maxBytes) throw new Error(fail(tooBig));

  try {
    return decodeWav(bytes);
  } catch (error) {
    throw new Error(fail(reasonText(error)));
  }
}

/**
 * Read a whole object stream into one buffer.
 *
 * The stream is a Node `Readable` from minio, or any other async iterable; a
 * web `ReadableStream` (which answers `getReader()`) is read the same way. It
 * is not assembled by any other means, so a caller's fake storage only has to
 * hand over something iterable.
 * @param {object} stream the object's stream
 * @returns {Promise<Buffer>}
 */
async function streamBytes(stream) {
  if (!stream || typeof stream !== "object") throw new Error("storage answered with no file");
  const chunks = [];
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error("storage answered with something that is not a stream");
}

/**
 * An error's own sentence, for a take that could not be read.
 * @param {unknown} error
 * @returns {string}
 */
function reasonText(error) {
  const message = error && typeof error.message === "string" ? error.message.trim() : "";
  return message === "" ? "storage could not read it" : message;
}

/**
 * What to launch for a render: the caller's clip, the caller's scene, or the
 * song's first scene that actually holds a clip.
 * @param {object} snapshot
 * @param {string|null} sceneId
 * @param {string|null} clipId
 * @returns {{scene?: string, clip?: string}} the launch, or `{}` for silence
 */
function pickLaunch(snapshot, sceneId, clipId) {
  if (clipId != null) return { clip: clipId };
  if (sceneId != null) return { scene: sceneId };

  const scenes = snapshot && Array.isArray(snapshot.scenes) ? snapshot.scenes : [];
  const clipList = snapshot && snapshot.clips && typeof snapshot.clips === "object" ? Object.values(snapshot.clips) : [];
  for (const scene of scenes) {
    const id = scene && typeof scene.id === "string" ? scene.id : null;
    if (id === null) continue;
    if (clipList.some((clip) => clip && clip.scene_id === id)) return { scene: id };
  }
  return {};
}

/**
 * The file-name stem for a render: the song's title plus the scene's or clip's
 * name, reduced to characters a key and a file system both accept.
 * @param {object} snapshot
 * @param {{scene_id: string|null, clip_id: string|null}} target
 * @returns {string} at most 60 characters, never empty
 */
function renderName(snapshot, { scene_id, clip_id }) {
  const parts = [];
  const title = snapshot && snapshot.meta && typeof snapshot.meta.title === "string" ? snapshot.meta.title : "";
  parts.push(title.trim() === "" ? "song" : title.trim());

  const chosen = clip_id != null ? findById(snapshot, "clips", clip_id) : findById(snapshot, "scenes", scene_id);
  const name = chosen && typeof chosen.name === "string" ? chosen.name.trim() : "";
  if (name !== "") parts.push(name);

  const safe = parts.join("-").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, MAX_NAME_LENGTH);
  return safe === "" ? "render" : safe;
}

/**
 * One scene (from the array) or clip (from the map) of a snapshot by id.
 * @param {object} snapshot
 * @param {"scenes"|"clips"} container
 * @param {string|null} id
 * @returns {object|null}
 */
function findById(snapshot, container, id) {
  if (id == null) return null;
  if (container === "scenes") {
    const scenes = snapshot && Array.isArray(snapshot.scenes) ? snapshot.scenes : [];
    return scenes.find((scene) => scene && scene.id === id) || null;
  }
  const clips = snapshot && snapshot.clips && typeof snapshot.clips === "object" ? snapshot.clips : {};
  return clips[id] || null;
}

/**
 * The project's storage prefix, which every object of that project is filed
 * under (the same prefix `servers/storage` uses for its uploads).
 * @param {object} db
 * @param {number|null} projectId
 * @returns {Promise<string>} "" when the render belongs to no project
 */
async function storagePrefixFor(db, projectId) {
  if (projectId == null) return "";
  const { rows } = await db.execute({
    sql: "SELECT storage_prefix FROM project_spaces WHERE id = ?",
    args: [projectId],
  });
  const prefix = rows && rows[0] ? rows[0].storage_prefix : null;
  return typeof prefix === "string" ? prefix : "";
}

/**
 * The key's timestamp, from the injected clock.
 * @param {() => (number|Date)} now
 * @returns {number} milliseconds since the epoch
 */
function timestampOf(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) ? milliseconds : Date.now();
}

/**
 * The Crow home the instrument store lives under: the instance's own, or the
 * same `<CROW_HOME>` / `~/.crow` default the rest of the bundle uses.
 * @returns {string}
 */
function defaultCrowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/**
 * The engine's sources and wasm binary, read once per process.
 * @returns {Object<string, string|Uint8Array>} name → text or bytes
 */
function engineAssets() {
  if (cachedAssets) return cachedAssets;
  cachedAssets = {
    "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
    "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
    "sunvox_lib_loader.js": readFileSync(join(VENDOR_DIR, "sunvox_lib_loader.js"), "utf8"),
    // The vendored SoundFont synth is part of the worklet module
    // (engine-client.js's SOURCE_FILES), so a render loads it like any other
    // engine source.
    "spessasynth.js": readFileSync(join(BUNDLE_DIR, "vendor", "spessasynth", "spessasynth.js"), "utf8"),
    // The SoundFont hosts (one synth per font, one channel per track) ride in the
    // worklet module with the synth they drive.
    "font-voice.js": readFileSync(join(ENGINE_DIR, "font-voice.js"), "utf8"),
    "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
    "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
  };
  return cachedAssets;
}

/**
 * `startRendering()` is what releases the worklet thread; a render that throws
 * before it gets there must release it by hand, or the process stays alive.
 * @param {BaseAudioContext} context
 * @returns {Promise<void>}
 */
async function releaseWorklet(context) {
  try {
    if (cachedReleaseSymbol === undefined) cachedReleaseSymbol = await workletReleaseSymbol();
    if (!cachedReleaseSymbol) return;
    const worklet = context && context.audioWorklet;
    if (worklet && typeof worklet[cachedReleaseSymbol] === "function") await worklet[cachedReleaseSymbol]();
  } catch {
    /* nothing to release */
  }
}

/**
 * node-web-audio-api's `kWorkletRelease` symbol. It is not part of the
 * package's public exports, so it is loaded from the file the public entry sits
 * next to, by path.
 * @returns {Promise<symbol|null>} null when this build does not have it
 */
async function workletReleaseSymbol() {
  try {
    const entry = require.resolve("node-web-audio-api");
    const module = await import(pathToFileURL(join(dirname(entry), "js", "lib", "symbols.js")).href);
    return module.kWorkletRelease || null;
  } catch {
    return null;
  }
}