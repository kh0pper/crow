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
 * ## Takes
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
 * ## The arrangement
 *
 * `{ mode: "arrangement", from_bar, seconds }` renders the song's timeline
 * instead of a scene: the engine is put in arrangement mode, seeked to
 * `from_bar` and played. The takes it loads are the ones the comps of the audio
 * clips placed inside the rendered window use — the window in bars is
 * `seconds` at the song's own tempo, four beats to the bar — so a render of the
 * third verse does not read the first verse's recordings.
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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeWav, encodeWav24 } from "./wav.js";
import { integratedLufs, truePeakDb } from "./loudness.js";

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

/** The largest a take's WAV file can be: its 44-byte header plus 3 bytes a sample. */
const MAX_TAKE_BYTES = 44 + MAX_TAKE_SAMPLES * 3;

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
 * are not used.
 *
 * Before the render starts, the takes the render can hear are loaded into the
 * engine through `options.takeAudio`, so a song with recorded audio renders as
 * it sounds rather than as silence. A take that cannot be read stops the render
 * with its id in the sentence (`Take <id> could not be loaded for this
 * render: …`): a render that quietly dropped a performance would be a lie.
 *
 * @param {object} snapshot the song as the hub's `snapshot()` returns it
 * @param {{scene_id?: string|null, clip_id?: string|null, seconds?: number,
 *          sampleRate?: number, mode?: "session"|"arrangement", from_bar?: number,
 *          takeAudio?: (take: object) => Promise<{rate: number,
 *            channels: Float32Array[]}|null>}} [options]
 *   `takeAudio` reads and decodes one take's WAV; it is only called for takes
 *   the render can hear, and only when the song has any; `mode` and `from_bar`
 *   render the arrangement (see above)
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number,
 *                    seconds: number}>} the rendered stereo channels
 */
export async function renderSong(snapshot, options = {}) {
  const { scene_id = null, clip_id = null, seconds = 1, sampleRate = SAMPLE_RATE } = options;
  const mode = options.mode === "arrangement" ? "arrangement" : "session";
  if (scene_id != null && clip_id != null) {
    throw new Error("A render takes a scene_id or a clip_id, not both.");
  }
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("A render needs a positive sample rate.");
  const span = Number(seconds);
  if (!Number.isFinite(span) || span <= 0) throw new Error("A render needs a positive number of seconds.");
  const fromBar = mode === "arrangement" ? wholeBar(options.from_bar) : 0;

  const length = Math.max(1, Math.round(span * rate));
  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: engineAssets() });
    engine.setSong(snapshot);
    let takes;
    if (mode === "arrangement") {
      engine.setMode("arrangement");
      engine.seek(fromBar);
      takes = takesInWindow(snapshot, fromBar, fromBar + barsOf(span, snapshot));
    } else {
      const launch = pickLaunch(snapshot, scene_id, clip_id);
      if (launch.scene) engine.launchScene(launch.scene);
      if (launch.clip) engine.launchClip(launch.clip);
      takes = takesToLoad(snapshot, launch);
    }
    await loadTakes(engine, takes, options.takeAudio);
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
    return { left, right, sampleRate: rate, seconds: length / rate };
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
 *   plays recorded takes through
 * @param {{assertLocalCapability: Function, appendAudit: Function}} options.acl
 *   the project ACL, injected for the same reason
 * @param {number} [options.maxSeconds] the longest render allowed; defaults to
 *   `STUDIO_MAX_RENDER_SECONDS`, else 300
 * @param {string} [options.bucket] the S3 bucket renders go to
 * @param {() => (number|Date)} [options.now] the clock the key's timestamp uses
 * @param {Function} [options.renderAudio] the audio renderer (defaults to
 *   `renderSong`); tests and alternate hosts inject their own
 * @returns {{render: (request: object) => Promise<{storage_key: string, url: string,
 *            seconds: number, lufs: number, true_peak_db: number}>}}
 */
export function createRenderer({
  db,
  storage,
  acl,
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
   * @param {{kind?: string, id?: string, label?: string}|null} [request.author]
   *   who asked; a human author is audited as `local`, anything else as `bot`
   * @returns {Promise<{storage_key: string, url: string, seconds: number,
   *                    lufs: number, true_peak_db: number}>}
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

    await acl.assertLocalCapability(db, project_id, "write_files");
    await acquire();
    try {
      // The same prefix both puts the render and finds the song's takes; it is
      // read once, before anything is rendered.
      const prefix = await storagePrefixFor(db, project_id);
      const takeAudio = (take) => takeAudioFrom({ storage, bucket, prefix, songId: song_id, take });
      const audio = await renderAudio(snapshot, { scene_id, clip_id, seconds: span, takeAudio });
      const rate = Number(audio.sampleRate) || SAMPLE_RATE;
      const renderedSeconds = audio.seconds;
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
        },
      });

      const url = await storage.getPresignedUrl(key, { bucket, expiry: URL_EXPIRY_SECONDS });
      return { storage_key: key, url, seconds: renderedSeconds, lufs, true_peak_db: truePeak };
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
 * @param {object[]} takes the takes this render hears (see `takesToLoad` and
 *   `takesInWindow`)
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
 * The takes a session render can hear: every take named by the comp of an audio
 * clip the launch plays, without the discarded ones, each once.
 *
 * A scene launch plays that scene's clips, a clip launch just that clip, and a
 * render that launches neither (silence) hears no takes at all.
 *
 * @param {object} snapshot the song
 * @param {{scene?: string, clip?: string}} launch what the render launches
 * @returns {object[]} the takes, as the snapshot holds them
 */
function takesToLoad(snapshot, launch) {
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
  return takesOfClips(snapshot, playing);
}

/**
 * The takes an arrangement render can hear: every take named by the comp of an
 * audio clip that has a placement intersecting the rendered window of bars.
 *
 * @param {object} snapshot the song
 * @param {number} fromBar the first bar the render plays
 * @param {number} toBar the bar it stops at (exclusive)
 * @returns {object[]} the takes, as the snapshot holds them
 */
function takesInWindow(snapshot, fromBar, toBar) {
  const clips = snapshot && snapshot.clips && typeof snapshot.clips === "object" ? snapshot.clips : {};
  const placements = placementsOf(snapshot);
  const playing = [];
  for (const placement of placements) {
    const start = Number(placement.start_bar);
    const bars = Number(placement.bars);
    if (!Number.isFinite(start) || !Number.isFinite(bars)) continue;
    // Half-open on both sides: a placement that ends where the window starts is
    // behind it, and one that starts where it ends is past it.
    if (!(start < toBar && fromBar < start + bars)) continue;
    const clip = clips[placement.clip_id];
    if (clip) playing.push(clip);
  }
  return takesOfClips(snapshot, playing);
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
 * A `from_bar` option as a whole bar: 0 when it is missing or not a number.
 * @param {unknown} value
 * @returns {number}
 */
function wholeBar(value) {
  const bar = Number(value);
  return Number.isFinite(bar) && bar > 0 ? Math.trunc(bar) : 0;
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
 * Read one take's WAV back out of storage and decode it, refusing anything
 * that is not exactly where Studio keeps this song's takes.
 *
 * The key is built here, from the song's project prefix and the song's own id,
 * and the take's `storage_key` has to equal it: a document that named some
 * other object — another song's take, a render, a file outside the project —
 * is refused by name rather than read. The file is read whole, but only after
 * its size is known, and a file past the take cap is refused unread.
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
  if (!storage || typeof storage.getObject !== "function") {
    throw new Error(takeLoadFailure(id, "this Studio cannot read files from storage"));
  }

  let opened;
  try {
    opened = await storage.getObject(key, { bucket });
  } catch (error) {
    throw new Error(takeLoadFailure(id, reasonText(error)));
  }

  const size = Number(opened && opened.stat ? opened.stat.size : NaN);
  if (Number.isFinite(size) && size > MAX_TAKE_BYTES) {
    throw new Error(takeLoadFailure(id, "its file is larger than a take can be"));
  }

  let bytes;
  try {
    bytes = await streamBytes(opened && opened.stream);
  } catch (error) {
    throw new Error(takeLoadFailure(id, reasonText(error)));
  }
  if (bytes.length > MAX_TAKE_BYTES) {
    throw new Error(takeLoadFailure(id, "its file is larger than a take can be"));
  }

  try {
    return decodeWav(bytes);
  } catch (error) {
    throw new Error(takeLoadFailure(id, reasonText(error)));
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
 * The engine's sources and wasm binary, read once per process.
 * @returns {Object<string, string|Uint8Array>} name → text or bytes
 */
function engineAssets() {
  if (cachedAssets) return cachedAssets;
  cachedAssets = {
    "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
    "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
    "sunvox_lib_loader.js": readFileSync(join(VENDOR_DIR, "sunvox_lib_loader.js"), "utf8"),
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