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
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeWav24 } from "./wav.js";
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

/** MPEG-1 style "1 hour" for the presigned download URL, in seconds. */
const URL_EXPIRY_SECONDS = 3600;

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
 * @param {object} snapshot the song as the hub's `snapshot()` returns it
 * @param {{scene_id?: string|null, clip_id?: string|null, seconds?: number,
 *          sampleRate?: number}} [options]
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number,
 *                    seconds: number}>} the rendered stereo channels
 */
export async function renderSong(snapshot, options = {}) {
  const { scene_id = null, clip_id = null, seconds = 1, sampleRate = SAMPLE_RATE } = options;
  if (scene_id != null && clip_id != null) {
    throw new Error("A render takes a scene_id or a clip_id, not both.");
  }
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("A render needs a positive sample rate.");
  const span = Number(seconds);
  if (!Number.isFinite(span) || span <= 0) throw new Error("A render needs a positive number of seconds.");

  const length = Math.max(1, Math.round(span * rate));
  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: engineAssets() });
    engine.setSong(snapshot);
    const launch = pickLaunch(snapshot, scene_id, clip_id);
    if (launch.scene) engine.launchScene(launch.scene);
    if (launch.clip) engine.launchClip(launch.clip);
    engine.play();
    engine.node.connect(context.destination);
    // Without this the render can begin before the song reaches the processor.
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    return {
      left: buffer.getChannelData(0),
      right: buffer.getChannelData(1),
      sampleRate: rate,
      seconds: length / rate,
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
 * @param {{uploadObject: Function, getPresignedUrl: Function, deleteObject: Function}} options.storage
 *   the S3 client's three calls, injected so this module imports no app code
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
   * Order matters: the time limit is checked before anything is touched, then
   * the ACL, then the queue (a refused render must not hold a slot), and only
   * then is any audio rendered.
   *
   * @param {object} request
   * @param {string} request.song_id
   * @param {number|null} [request.project_id] the project the song lives in
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
    const span = checkSeconds(seconds, longest);

    await acl.assertLocalCapability(db, project_id, "write_files");
    await acquire();
    try {
      const audio = await renderAudio(snapshot, { scene_id, clip_id, seconds: span });
      const rate = Number(audio.sampleRate) || SAMPLE_RATE;
      const lufs = integratedLufs(audio.left, audio.right, rate);
      const truePeak = truePeakDb(audio.left, audio.right, rate);
      const wav = encodeWav24(audio.left, audio.right, rate);

      const prefix = await storagePrefixFor(db, project_id);
      const stem = renderName(snapshot, { scene_id, clip_id });
      const key = `${prefix}studio/${song_id}/${timestampOf(now)}-${stem}.wav`;

      await storage.uploadObject(key, Buffer.from(wav), { bucket, contentType: "audio/wav" });

      try {
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [key, `${stem}.wav`, "audio/wav", wav.byteLength, bucket, REFERENCE_TYPE, song_id, project_id ?? null],
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
        actor_type: author && author.kind === "human" ? "local" : "bot",
        actor_id: author && author.id != null ? author.id : null,
        action: "studio.render",
        target: `song:${song_id}`,
        payload: {
          scene_id,
          clip_id,
          seconds: audio.seconds,
          storage_key: key,
          lufs,
          true_peak_db: truePeak,
        },
      });

      const url = await storage.getPresignedUrl(key, { bucket, expiry: URL_EXPIRY_SECONDS });
      return { storage_key: key, url, seconds: audio.seconds, lufs, true_peak_db: truePeak };
    } finally {
      release();
    }
  }

  return { render };
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