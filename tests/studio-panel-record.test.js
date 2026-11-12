/**
 * Studio panel — arming, recording, uploading, resuming and monitoring, live.
 *
 * A private headless Chrome (tests/fixtures/headless-chrome.mjs) opens the
 * dashboard's Studio page against a gateway-shaped server: the panel handler
 * with the asset whitelist, the `/api/studio/ws` WebSocket, a real session hub
 * on a scratch database, and the real take-upload service (staging on a scratch
 * directory, the streamed WAV, the internal `take.add`) over an in-memory object
 * store. So the takes these tests measure travelled the gateway's own route.
 *
 * The microphone is faked, in the page, before it boots: a
 * `MediaStreamAudioDestinationNode` fed by a running oscillator stands in for
 * the interface, and `navigator.mediaDevices.getUserMedia` is overridden to
 * hand it back. That is the same MediaStream shape a real input hands the
 * recorder, so the recorder, the take store and the upload are the real ones.
 *
 * What the tests prove (plan Task 7, and the review fixes on it):
 *   1. an armed track, Record and a scene launch make an audio clip with a take;
 *   2. a one-bar loop recorded over three passes makes three takes;
 *   3. a take recorded while the take routes fail uploads once they answer;
 *   4. a take this device still owes resumes on the next page load;
 *   5. recording with no calibration says so first;
 *   6. the monitor toggle states the measured delay;
 *   7. a teardown mid-take still keeps and uploads the take;
 *   8. every loop pass uploads as soon as it ends;
 *   9. an interrupted recording is recovered on the next load, and one
 *      uploader per take wins a Web Lock race;
 *  10. a gone row is quiet, the counter never outruns the chunk count, a
 *      permanent refusal offers its two buttons, and a full take store stops
 *      the recording and uploads what was kept;
 *  11. loop splits land on the frames the sequencer's own rounding gives.
 *
 * No browser: the tests skip, unless CROW_REQUIRE_TEST_CHROME=1, which makes the
 * fixture throw instead.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createClient } from "@libsql/client";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AclError } from "../servers/shared/project-acl.js";
import { createHub } from "../bundles/studio/server/hub.js";
import { initStudioTables } from "../bundles/studio/server/init-tables.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import { createTakeUploads } from "../bundles/studio/server/takes-upload.js";
import studioPanel from "../bundles/studio/panel/studio.js";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

/** The project this file's songs live in. */
const PROJECT = 31;

/** The project's storage prefix, as `project_spaces.storage_prefix` holds it. */
const PREFIX = "projects/31/";

/** The author a browser command carries (server/web.js's own constant). */
const HUMAN = { kind: "human", id: "local", label: "You" };

/** The bundle directory the asset routes read from. */
const BUNDLE_DIR = new URL("../bundles/studio", import.meta.url).pathname.replace(/\/$/, "");

/** The audio track recordings go on. */
const AUDIO_TRACK = "gtr";

/** The SunVox track that gives the scene its one-bar length. */
const NOTE_TRACK = "bass";

/** The scene both tests launch. */
const SCENE = "verse";

/** The sentence a recording with no calibration says first (plan Task 7). */
const NOT_CALIBRATED_TEXT =
  "This input isn't calibrated, so the take may sit late. You can calibrate later and fix it.";

/** The row a take reads until its upload has begun (plan Task 7). */
const SAVED_LOCAL_TEXT = "Saved on this device — will upload.";

let chrome = null;
let server = null;
let upgrades = null;
let db = null;
let hub = null;
let base = "";
let songId = "";
let dir = "";
let crowHome = "";
/** When true, every take route answers 503: the network is down for uploads. */
let takesDown = false;

/** One session hub ACL: this project exists and needs no capability check. */
function fakeAcl() {
  const audits = [];
  async function assertProjectExists(_db, projectId) {
    if (Number(projectId) !== PROJECT) throw new AclError(`Project #${projectId} not found`, "not_found");
    return { id: PROJECT };
  }
  async function assertCapability(database, projectId) {
    return assertProjectExists(database, projectId);
  }
  async function appendAudit(_db, entry) {
    audits.push(entry);
  }
  return { audits, assertProjectExists, assertCapability, appendAudit };
}

/**
 * An object store in memory: what the finish route streams into, and what the
 * audio route reads back out.
 */
function fakeStorage() {
  /** @type {Map<string, Buffer>} */
  const objects = new Map();
  return {
    objects,
    async putObjectStream(key, stream) {
      const pieces = [];
      for await (const piece of stream) pieces.push(Buffer.from(piece));
      objects.set(key, Buffer.concat(pieces));
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async getBucketStats() {
      let totalSizeBytes = 0;
      for (const bytes of objects.values()) totalSizeBytes += bytes.length;
      return { fileCount: objects.size, totalSizeBytes };
    },
    defaultBucket() {
      return "crow-files";
    },
  };
}

/**
 * A database client with the statements the upload service runs: the
 * `storage_files` row, its deletion, and the project's storage prefix.
 */
function uploadDb() {
  return {
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (/storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: PREFIX }] };
      return { rows: [] };
    },
  };
}

/** @returns {string|null} one cookie's value out of a Cookie header. */
function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The stand-in dashboard layout: a bare document around the panel content. */
function minimalLayout({ title, content }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body>${content}</body></html>`;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "studio-panel-record-"));
  crowHome = join(dir, "home");
  db = createClient({ url: "file:" + join(dir, "crow.db") });
  await db.execute(
    "CREATE TABLE IF NOT EXISTS project_spaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT, archived_at TEXT, storage_prefix TEXT)",
  );
  await db.execute({
    sql: "INSERT INTO project_spaces (id, name, storage_prefix) VALUES (?, ?, ?)",
    args: [PROJECT, "Studio project", PREFIX],
  });
  await initStudioTables(db);

  const acl = fakeAcl();
  const storage = fakeStorage();
  const webRef = { web: null };
  hub = createHub({
    db,
    acl,
    onBroadcast: (id, payload) => webRef.web?.broadcast(id, payload),
  });

  // The real upload service: staging on disk, the streamed WAV into the store
  // above, the internal take.add through the hub.
  const takeUploads = createTakeUploads({
    stagingDir: join(crowHome, "studio-staging"),
    storage,
    db: uploadDb(),
    acl,
    hub,
    songs: { projectOf: async (id) => (id === songId ? PROJECT : null) },
    quotaMb: 5120,
  });

  // The playback adapter the audio route streams through.
  const takeStorage = {
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject(key) {
      const bytes = storage.objects.get(key);
      if (!bytes) throw new Error(`there is no object at ${key}`);
      return { stream: Readable.from([bytes]), stat: { size: bytes.length } };
    },
  };

  const web = createStudioWeb({
    hub,
    Router: express.Router,
    WebSocketServer,
    auth: {
      isAllowedNetwork: () => true,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === "csrf-ok",
      classifyPeer: () => ({ via: "local" }),
    },
    crowHome,
    bundleDir: BUNDLE_DIR,
    takeUploads,
    takeStorage,
    rawBody: (limit) => express.raw({ type: () => true, limit, inflate: false }),
  });
  webRef.web = web;

  const created = await hub.createSong({ project_id: PROJECT, title: "Recording song", author: HUMAN });
  assert.equal(created.ok, true, `createSong was refused: ${created.error}`);
  songId = created.song_id;

  for (const [command, args] of [
    ["song.set_meta", { bpm: 240 }],
    ["track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" }],
    ["track.add", { id: NOTE_TRACK, name: "Bass" }],
    ["scene.add", { id: SCENE, name: "Verse" }],
    [
      "clip.write",
      {
        clip_id: "c-bass",
        track_id: NOTE_TRACK,
        scene_id: SCENE,
        name: "Bass line",
        length_bars: 1,
        notes: [{ t: 0, d: 1, p: 60, v: 100 }],
      },
    ],
  ]) {
    const result = await hub.runCommand({ song_id: songId, cmd_id: null, command, args, author: HUMAN });
    assert.equal(result.ok, true, `${command} was refused: ${result.error}`);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The network being down for uploads: every take route refuses, which is
  // exactly what a browser offline sees.
  app.use((req, res, next) => {
    if (takesDown && req.path.startsWith("/api/studio/takes")) {
      return res.status(503).json({ error: "Studio cannot take recordings on this instance." });
    }
    return next();
  });
  // The gateway's own Content-Security-Policy for the Studio page and its
  // assets, so a worklet or WebAssembly the dashboard would allow loads here.
  app.use((req, res, next) => {
    if (req.path === "/dashboard/studio" || req.path.startsWith("/dashboard/studio/")) {
      res.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "img-src 'self' data: blob:",
        "media-src 'self' https: blob:",
        "connect-src 'self'",
        "frame-src 'self' https:",
      ].join("; "));
    }
    next();
  });
  const dashboardAuth = (req, res, next) => {
    if (!cookieOf(req.headers.cookie, "crow_session")) return res.status(401).json({ error: "unauthorized" });
    return next();
  };
  app.use(web.router(dashboardAuth));
  app.get("/dashboard/studio", async (req, res, next) => {
    try {
      await studioPanel.handler(req, res, { db, layout: minimalLayout });
    } catch (err) {
      next(err);
    }
  });

  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });

  server = createServer(app);
  upgrades = web.attachUpgrade(server);
  await new Promise((resolve) => server.listen(0, chrome?.bindHost ?? "127.0.0.1", resolve));
  base = `http://${chrome?.pageHost ?? "127.0.0.1"}:${server.address().port}`;
});

after(async () => {
  if (upgrades) upgrades.close();
  if (server) {
    try {
      server.closeAllConnections?.();
    } catch {
      // Nothing left to close.
    }
    await new Promise((resolve) => server.close(resolve));
  }
  if (chrome) await chrome.close();
  try {
    db?.close?.();
  } catch {
    // Already gone.
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * The page-side input: a running oscillator into a MediaStream destination,
 * handed out by getUserMedia. Installed before the page's own scripts run, so
 * the panel never sees a real microphone.
 */
const INPUT_SCRIPT = `(function () {
  var ctx = new AudioContext();
  var osc = ctx.createOscillator();
  osc.frequency.value = 220;
  var gain = ctx.createGain();
  gain.gain.value = 0.2;
  var dest = ctx.createMediaStreamDestination();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  var stream = dest.stream;
  window.__studioTestStream = stream;
  var media = navigator.mediaDevices;
  if (!media) return;
  media.getUserMedia = function () { return Promise.resolve(stream); };
  media.enumerateDevices = function () {
    return Promise.resolve([
      { kind: 'audioinput', deviceId: 'test-input', label: 'Test input', groupId: 'test' },
    ]);
  };
})();`;

/** The studio page's URL for the seeded song. */
function studioUrl(id = songId) {
  return `${base}/dashboard/studio?song=${encodeURIComponent(id)}`;
}

/**
 * Open one page in the private browser with the fake input installed, and
 * return its CDP handle.
 * @param {string} url
 * @returns {Promise<{evaluate: Function, close: Function}>}
 */
async function openPage(url) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === "Runtime.exceptionThrown") {
      console.error(
        "PAGE exception:",
        JSON.stringify(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).slice(0, 500),
      );
    }
  });
  let nextId = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = (nextId += 1);
      const onMessage = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.id !== mine) return;
        socket.off("message", onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result || {});
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ id: mine, method, params }));
    });

  const evaluate = async (expression) => {
    const outcome = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (outcome.exceptionDetails) throw new Error(JSON.stringify(outcome.exceptionDetails));
    return outcome.result?.value;
  };

  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  for (const [name, value] of [["crow_session", "good"], ["crow_csrf", "csrf-ok"]]) {
    await send("Network.setCookie", { name, value, url: `${base}/` });
  }
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INPUT_SCRIPT });
  await send("Page.navigate", { url });

  return {
    evaluate,
    close: async () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      try {
        await fetch(chrome.cdp + "/json/close/" + tab.id);
      } catch {
        // The tab is going away either way.
      }
    },
  };
}

/**
 * Poll a page until `expression` is truthy.
 * @returns {Promise<any>} the last value, or false after the timeout
 */
async function waitFor(page, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = false;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(expression);
    } catch {
      last = false;
    }
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Wait until the page has its replica, its grid and the module catalogue. */
async function waitForStudio(page) {
  const ready = await waitFor(page, "!!document.querySelector('[data-role=grid] .st-corner')", 20000);
  assert.ok(ready, "the studio grid never rendered (the page's Yjs replica did not load)");
  await waitFor(
    page,
    `!!document.querySelector('[data-track-id=${NOTE_TRACK}] .st-device') && `
      + `document.querySelector('[data-track-id=${NOTE_TRACK}] .st-device').options.length > 0`,
    30000,
  );
}

/** Poll the song's document until `check` accepts its snapshot. */
async function waitForSong(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await hub.openSong(songId)).snapshot;
    try {
      if (check(last)) return last;
    } catch {
      // A snapshot mid-update is not an answer; look again.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

/** @returns {object[]} every take of one clip in a snapshot. */
function takesOfClip(snap, clipId) {
  const takes = snap && snap.takes ? snap.takes : {};
  return Object.values(takes).filter((take) => take && take.clip_id === clipId);
}

/** @returns {object|null} the audio clip on the recording track in the scene. */
function audioClipOf(snap) {
  const clips = snap && snap.clips ? snap.clips : {};
  return Object.values(clips).find((clip) => clip && clip.track_id === AUDIO_TRACK && clip.scene_id === SCENE) || null;
}

/**
 * Arm the audio track and wait for its input and its latency chip: an armed
 * track with a context is what enables Record.
 * @param {object} page
 */
async function armAudioTrack(page) {
  const armed = await page.evaluate(`(function () {
    var arm = document.querySelector('[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]');
    if (!arm) return false;
    arm.click();
    return true;
  })()`);
  assert.equal(armed, true, "the audio track header offers an Arm toggle");
  const key = await waitFor(
    page,
    `document.querySelector('[data-role=latency]') && document.querySelector('[data-role=latency]').getAttribute('data-latency-key')`,
    15000,
  );
  assert.ok(key, "arming the track opened an input and named its latency key");
  return key;
}

/**
 * Press Record and wait until the recorder is built and waiting for a launch:
 * the page says so with data-ready, so nothing is launched into a race.
 * @param {object} page
 */
async function armRecorder(page) {
  const clicked = await page.evaluate(`(function () {
    var button = document.querySelector('[data-act=record]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, "Record is enabled on an armed track");
  const ready = await waitFor(
    page,
    "document.querySelector('[data-role=rec-status]') && "
      + "document.querySelector('[data-role=rec-status]').getAttribute('data-ready') === '1'",
    30000,
  );
  assert.ok(ready, "the recorder was built and is waiting for a launch");
}

/**
 * Launch one scene from the grid and wait for the recorder to arm on the frame
 * the launch reported.
 * @param {object} page
 * @param {string} [scene]
 */
async function launchScene(page, scene = SCENE) {
  const clicked = await page.evaluate(`(function () {
    var button = document.querySelector('[data-scene-id=${scene}] [data-act=launch-scene]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, "the scene header offers its launch button");
  const armed = await waitFor(
    page,
    "document.querySelector('[data-role=rec-status]') && "
      + "document.querySelector('[data-role=rec-status]').getAttribute('data-recording') === '1'",
    20000,
  );
  assert.ok(armed, "the recorder armed on the launch frame");
}

/**
 * Wait until the take is in the given loop pass, then press Stop. Stop ends the
 * take at the end of the pass it is in, so the number of takes is the number of
 * passes up to that one.
 * @param {object} page
 * @param {number} pass
 */
async function stopInPass(page, pass) {
  const reached = await waitFor(
    page,
    `document.querySelector('[data-role=rec-status]') && `
      + `Number(document.querySelector('[data-role=rec-status]').getAttribute('data-passes')) >= ${pass}`,
    40000,
  );
  assert.ok(reached, `the recording never reached pass ${pass}`);
  await page.evaluate("document.querySelector('[data-act=stop]').click(), true");
}

/**
 * Record one take: Record, launch the scene, and Stop inside the pass named.
 * @param {object} page
 * @param {number} stopIn the pass number Stop is pressed in
 */
async function recordPasses(page, stopIn) {
  await armRecorder(page);
  await launchScene(page);
  await stopInPass(page, stopIn);
}

test("armed record into an empty slot creates an audio clip with one take", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  takesDown = false;

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);
  await armAudioTrack(page);

  await recordPasses(page, 1);

  const snap = await waitForSong((state) => {
    const clip = audioClipOf(state);
    return !!clip && takesOfClip(state, clip.id).length === 1;
  });
  const clip = audioClipOf(snap);
  assert.ok(clip, "recording into an empty slot made an audio clip in that slot");
  assert.equal(clip.kind, "audio", "the clip holds takes, not notes");
  assert.equal(clip.length_bars, 1, "its length is the scene's longest clip");
  const takes = takesOfClip(snap, clip.id);
  assert.equal(takes.length, 1, "the take is in the song");
  assert.ok(takes[0].frames > 0, "the take holds audio");
  assert.equal(takes[0].offset_frames, 0, "an uncalibrated take carries no offset");
  assert.equal(takes[0].compensated, false, "and says so");
  assert.equal(takes[0].discarded, false);
  assert.ok(Array.isArray(clip.comp) && clip.comp.length === 1, "the first take became the comp");
  assert.equal(clip.comp[0].take_id, takes[0].id, "over the whole clip");
});

test("loop-record of 3 passes makes 3 takes", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  takesDown = false;
  // Its own scene, so the earlier test's clip is not the slot this one fills.
  const added = await hub.runCommand({
    song_id: songId,
    cmd_id: null,
    command: "scene.add",
    args: { id: "loop-scene", name: "Loop scene" },
    author: HUMAN,
  });
  assert.equal(added.ok, true, `scene.add was refused: ${added.error}`);
  // A one-bar clip in it, so the recording's loop is one bar too: three passes
  // is three seconds, not three quarters of a minute.
  const seeded = await hub.runCommand({
    song_id: songId,
    cmd_id: null,
    command: "clip.write",
    args: {
      clip_id: "c-loop-bass",
      track_id: NOTE_TRACK,
      scene_id: "loop-scene",
      name: "Loop line",
      length_bars: 1,
      notes: [{ t: 0, d: 1, p: 60, v: 100 }],
    },
    author: HUMAN,
  });
  assert.equal(seeded.ok, true, `clip.write was refused: ${seeded.error}`);

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);
  await armAudioTrack(page);

  await armRecorder(page);
  await launchScene(page, "loop-scene");
  // Stop is pressed while the third loop pass is playing, so the take ends on
  // that pass's own end: three passes, three takes.
  await stopInPass(page, 3);

  const snap = await waitForSong((state) => {
    const clip = Object.values(state.clips || {}).find(
      (entry) => entry.track_id === AUDIO_TRACK && entry.scene_id === "loop-scene",
    );
    return !!clip && takesOfClip(state, clip.id).length === 3;
  });
  const clip = Object.values(snap.clips || {}).find(
    (entry) => entry.track_id === AUDIO_TRACK && entry.scene_id === "loop-scene",
  );
  assert.ok(clip, "the loop recording made one audio clip");
  const takes = takesOfClip(snap, clip.id);
  assert.equal(takes.length, 3, `three passes are three takes (got ${takes.length})`);
  const ids = new Set(takes.map((take) => take.id));
  assert.equal(ids.size, 3, "each pass is its own take");
  for (const take of takes) assert.ok(take.frames > 0, "every take holds audio");
});

test("a take recorded offline uploads after reconnect", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  // The slot already holds the first test's take, so what matters is that this
  // recording adds one more once the network answers.
  const firstSnap = (await hub.openSong(songId)).snapshot;
  const firstClip = audioClipOf(firstSnap);
  const takesBefore = firstClip ? takesOfClip(firstSnap, firstClip.id).length : 0;

  takesDown = true;
  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);
  await armAudioTrack(page);

  await recordPasses(page, 1);

  // The take is on this device before anything is sent: the row says so.
  const saved = await waitFor(
    page,
    `(function () {
      var rows = document.querySelectorAll('[data-role=recordings] .st-pending-text');
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].textContent === ${JSON.stringify(SAVED_LOCAL_TEXT)}) return true;
      }
      return false;
    })()`,
    20000,
  );
  assert.ok(saved, "the row reads that the take is saved on this device and will upload");

  takesDown = false;
  const snap = await waitForSong((state) => {
    const clip = audioClipOf(state);
    return !!clip && takesOfClip(state, clip.id).length > takesBefore;
  }, 30000);
  const clip = audioClipOf(snap);
  assert.ok(clip, "the clip is in the song");
  assert.ok(
    takesOfClip(snap, clip.id).length > takesBefore,
    "the take uploaded once the network answered",
  );
});

test("a pending take resumes after reload", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  takesDown = true;
  const first = await openPage(studioUrl());
  await waitForStudio(first);
  await armAudioTrack(first);
  await recordPasses(first, 1);
  const saved = await waitFor(
    first,
    `(function () {
      var rows = document.querySelectorAll('[data-role=recordings] .st-pending-text');
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].textContent === ${JSON.stringify(SAVED_LOCAL_TEXT)}) return true;
      }
      return false;
    })()`,
    20000,
  );
  assert.ok(saved, "the take is still on this device when the tab closes");
  await first.close();

  // The network is back, and this is a new page: the only copy of the take is
  // the one in this browser's IndexedDB.
  takesDown = false;
  const countBefore = Object.keys((await hub.openSong(songId)).snapshot.takes || {}).length;
  const second = await openPage(studioUrl());
  t.after(() => second.close());
  await waitForStudio(second);

  const snap = await waitForSong(
    (state) => Object.keys(state.takes || {}).length > countBefore,
    40000,
  );
  assert.ok(
    Object.keys(snap.takes || {}).length > countBefore,
    "the resumed upload put the take in the song",
  );
});

test("not-calibrated warning shows before recording", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);
  await armAudioTrack(page);

  await page.evaluate("document.querySelector('[data-act=record]').click(), true");
  const shown = await waitFor(
    page,
    `(function () {
      var host = document.querySelector('[data-role=rec-notice]');
      return !!host && host.textContent.indexOf(${JSON.stringify(NOT_CALIBRATED_TEXT)}) >= 0;
    })()`,
    20000,
  );
  assert.ok(shown, "the panel says the input is not calibrated before the take starts");
  // Leave nothing recording for the tests after this one.
  await page.evaluate("document.querySelector('[data-act=stop]').click(), true");
});

test("monitor toggle shows the measured delay", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);
  const key = await armAudioTrack(page);

  // A measurement for this very input, rate and hint: the panel finds it by
  // the key its own chip carries.
  const rate = Number(String(key).split("|")[2]);
  assert.ok(Number.isFinite(rate) && rate > 0, `the latency key names a rate (${key})`);
  const frames = Math.round(rate * 0.071);
  const stored = await page.evaluate(
    `window.StudioTakeStore.putLatency(${JSON.stringify(key)}, `
      + `{ latency_frames: ${frames}, rate: ${rate}, spread_frames: 0, measured_at: new Date().toISOString() })`
      + ".then(function () { return true; })",
  );
  assert.equal(stored, true, "a measurement was stored for this input");

  const toggled = await page.evaluate(`(function () {
    var button = document.querySelector('[data-track-id=${AUDIO_TRACK}] [data-act=monitor]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(toggled, true, "the audio track header offers the monitor toggle");

  const sentence = await waitFor(
    page,
    `(function () {
      var host = document.querySelector('[data-role=monitor-warning]');
      return host ? host.textContent : '';
    })()`,
    20000,
  );
  assert.ok(sentence, "turning monitoring on draws the warning sentence");
  assert.equal(
    sentence,
    "You'll hear yourself about 71 ms late. Your interface's direct-monitor knob has no delay.",
    "the sentence states the measured delay",
  );

  const chip = await page.evaluate(
    `document.querySelector('[data-role=latency]') ? document.querySelector('[data-role=latency]').textContent : ''`,
  );
  assert.equal(chip, "71 ms", "the latency chip shows the measurement in milliseconds");
});

// ---- the same panel script without a browser -------------------------------
//
// The six tests above need a real AudioContext, a real recorder worklet and a
// real upload. These three run everywhere: the emitted client script against a
// linkedom document, with a fake context, input stream, take store and engine.
// They cover what a broken stub would otherwise hide — the audio track header,
// the plan's sentences, and the local-first upload state machine (chunks kept
// before anything is sent, then the row's progress text).

/** A database fake for the panel handler: no projects to list. */
function panelDb() {
  return {
    async execute() {
      return { rows: [] };
    },
  };
}

/** The document the mock client draws: one audio track and one scene. */
async function recordingDoc(bpm = 240) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  const doc = newSongDoc({ title: "Recording song", bpm });
  runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  return doc;
}

/**
 * The panel's take store, in memory: the same API, and a log of what it was
 * asked to keep, so a test can prove chunks are kept before they are sent.
 * @param {{latency?: object, log?: string[]}} [options]
 */
function fakeTakeStore({ latency = null, log = [] } = {}) {
  const chunks = new Map();
  const pendings = new Map();
  const latencyRows = new Map();
  if (latency) latencyRows.set("any", latency);
  return {
    chunks,
    pendings,
    latencyRows,
    log,
    async putChunk(takeId, index, bytes) {
      log.push("putChunk");
      chunks.set(takeId + ":" + index, bytes);
      return true;
    },
    async getChunk(takeId, index) {
      return chunks.get(takeId + ":" + index) || null;
    },
    async countChunks(takeId) {
      let count = 0;
      let bytes = 0;
      for (;;) {
        const chunk = chunks.get(takeId + ":" + count);
        if (!chunk) break;
        bytes += typeof chunk.byteLength === "number" ? chunk.byteLength : 0;
        count += 1;
      }
      return { count, bytes };
    },
    async getPending(takeId) {
      return pendings.get(takeId) || null;
    },
    async listPending() {
      return Array.from(pendings.values());
    },
    async putPending(value) {
      pendings.set(value.take_id, value);
      return true;
    },
    async deletePending(takeId) {
      pendings.delete(takeId);
      for (const key of Array.from(chunks.keys())) {
        if (key.startsWith(takeId + ":")) chunks.delete(key);
      }
      return true;
    },
    async getLatency(key) {
      // A single measurement answers for whatever key the page asks about.
      return latencyRows.get(key) || latencyRows.get("any") || null;
    },
    async putLatency(key, value) {
      latencyRows.set(key, value);
      return true;
    },
    async getAudio() {
      return null;
    },
    async putAudio() {
      return true;
    },
    async clearAudio() {
      return true;
    },
  };
}

/** A context stand-in: the three nodes the panel builds, and its clock. */
function fakeContext(nowSeconds = 0) {
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: 48000,
    state: "running",
    currentTime: nowSeconds,
    destination: {},
    createGain: () => gain,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    resume: async () => {},
    close() {},
  };
}

/**
 * The Web Locks API, in memory: a name is either held or free, and an
 * `ifAvailable` request whose name is held runs its callback with null — the
 * same answer a real browser gives the second tab.
 * @returns {{request: Function, held: Set<string>}}
 */
function fakeLocks() {
  const held = new Set();
  return {
    held,
    async request(name, options, run) {
      const callback = typeof options === "function" ? options : run;
      const settings = typeof options === "function" ? {} : options || {};
      if (held.has(name)) {
        if (settings.ifAvailable && typeof callback === "function") return callback(null);
        return undefined;
      }
      held.add(name);
      try {
        return typeof callback === "function" ? await callback({ name }) : undefined;
      } finally {
        held.delete(name);
      }
    },
  };
}

/** A MediaStream stand-in whose one track calls itself "Test input". */
function fakeStream() {
  const track = {
    label: "Test input",
    getSettings: () => ({ deviceId: "test-input", echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
    stop() {},
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

/** The engine stand-in: one fake recorder the test drives by hand. */
function fakeEngine() {
  const engine = {
    recorders: [],
    launches: [],
    node: { connect() {} },
    setSong() {},
    play() {},
    stop() {},
    stopAll() {},
    unloadAudio() {},
    async loadAudio() {},
    onPosition() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    // The engine reports the whole master path's delay (the limiter's look-ahead
    // plus the mix delay a converted amp adds) whenever it changes. A test
    // announces one the way the engine does; a number announced before the page
    // listens is handed over as soon as it does, which is the order a page that
    // armed a track first sees it in.
    latencyListeners: [],
    latencyPending: null,
    onMasterLatency(listener) {
      engine.latencyListeners.push(listener);
      if (engine.latencyPending !== null) listener(engine.latencyPending);
      return () => {};
    },
    announceLatency(latency) {
      engine.latencyPending = latency;
      for (const listener of engine.latencyListeners) listener(latency);
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
    },
    async calibrate() {
      return { latency_frames: 3408, rate: 48000, spread_frames: 0, clicks_heard: 14 };
    },
    async createRecorder() {
      const recorder = {
        armFrame: null,
        stopFrame: null,
        splits: [],
        onChunk(listener) {
          recorder.chunk = listener;
        },
        onDone(listener) {
          recorder.done = listener;
        },
        armAt(frame) {
          recorder.armFrame = frame;
        },
        stopAt(frame) {
          recorder.stopFrame = frame;
        },
        splitAt(frames) {
          recorder.splits = frames;
        },
        dispose() {
          recorder.disposed = true;
        },
      };
      engine.recorders.push(recorder);
      return recorder;
    },
  };
  return engine;
}

/**
 * Boot the emitted client script against the page the handler renders, with a
 * fake browser around it.
 *
 * @param {{latency?: object, gateFinish?: boolean, bpm?: number,
 *          store?: object, locks?: object, pending?: object[],
 *          chunks?: Array<[string, number, ArrayBuffer]>, clock?: number,
 *          hold?: Promise<void>, confirm?: boolean,
 *          respond?: (url: string, init: object) => ({status: number, body: object}|null)}} [options]
 */
async function bootPanel(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");

  const doc = await recordingDoc(options.bpm);
  const res = {
    html: "",
    headersSent: false,
    send(body) {
      this.html = String(body);
      this.headersSent = true;
    },
  };
  await studioPanel.handler({ query: { song: "song-1" }, headers: {} }, res, {
    db: panelDb(),
    layout: minimalLayout,
  });
  assert.ok(res.html.includes("data-studio-song=\"song-1\""), "the handler rendered the song page");
  const { document, window: domWindow } = parseHTML(res.html);

  const log = [];
  const store = options.store || fakeTakeStore({ latency: options.latency || null, log });
  // A take the previous page left behind, and the chunks it kept: what a
  // resumed upload and an interrupted recording are made of.
  for (const row of options.pending || []) store.pendings.set(row.take_id, row);
  for (const [takeId, index, bytes] of options.chunks || []) store.chunks.set(takeId + ":" + index, bytes);
  const engine = fakeEngine();
  const sent = [];
  const requests = [];
  let releaseFinish = () => {};
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  });

  const fetchStub = async (url, init = {}) => {
    const target = String(url);
    requests.push({
      url: target,
      method: init.method || "GET",
      body: typeof init.body === "string" ? init.body : null,
    });
    log.push("fetch " + target);
    // A test may hold the take routes open to look at the panel mid-upload.
    if (options.hold && target.startsWith("/api/studio/takes")) await options.hold;
    if (typeof options.respond === "function") {
      const custom = options.respond(target, init);
      if (custom) return response(custom.status, custom.body);
    }
    if (target.includes("/finish")) {
      if (options.gateFinish) await finishGate;
      return response(200, { take: { id: "0a1b2c3d-0000-4000-8000-000000000000" } });
    }
    if (target.includes("/chunks/")) return response(200, { sha256: "0".repeat(64) });
    if (target.includes("/audio")) return response(404, { error: "not_found" });
    if (target.includes("/api/studio/takes")) return response(200, { begun: false, received: [], frames: 0 });
    if (target.includes("/api/studio/songs")) {
      return response(200, [{ id: "song-1", project_id: PROJECT, title: "Recording song" }]);
    }
    if (target.includes("/module-types")) return response(200, { generators: ["Analog generator"], modules: {} });
    if (target.includes("/project-bot")) return response(404, { error: "not_found" });
    return response(200, {});
  };

  const socket = { readyState: 1, handlers: {} };
  socket.addEventListener = (name, handler) => {
    (socket.handlers[name] ||= []).push(handler);
    if (name === "open") Promise.resolve().then(() => handler());
  };
  socket.send = (text) => sent.push(JSON.parse(text));
  socket.close = () => {
    socket.readyState = 3;
  };

  const stream = fakeStream();
  const mediaDevices = {
    async getUserMedia() {
      return stream;
    },
    async enumerateDevices() {
      return [{ kind: "audioinput", deviceId: "test-input", label: "Test input" }];
    },
  };

  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    confirm: () => options.confirm !== false,
    AudioContext: function AudioContextStub() {
      return fakeContext(options.clock || 0);
    },
    StudioTakeStore: store,
    StudioEngine: { create: async () => engine },
    addEventListener() {},
    removeEventListener() {},
  };

  const yjsUrl = pathToFileURL(
    new URL("../bundles/studio/node_modules/yjs/dist/yjs.mjs", import.meta.url).pathname,
  ).href;
  const scriptText = CLIENT_SCRIPT.replace("'/dashboard/studio/assets/yjs.mjs'", JSON.stringify(yjsUrl));
  assert.notEqual(scriptText, CLIENT_SCRIPT, "the test replaces the Yjs asset URL with the file on disk");

  // The take store travels as its own string in the page and is emitted before
  // the client. It is parsed and run here for that reason, and the fake above
  // then takes its place: a sandbox has no IndexedDB for it to use.
  new Function("window", "navigator", TAKE_STORE_SCRIPT)(windowStub, { mediaDevices });
  assert.equal(typeof windowStub.StudioTakeStore.putChunk, "function", "the take store installs its API");
  windowStub.StudioTakeStore = store;

  const timers = [];
  const run = new Function(
    "document",
    "window",
    "navigator",
    "WebSocket",
    "fetch",
    "crypto",
    "atob",
    "console",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    scriptText,
  );
  run(
    document,
    windowStub,
    { mediaDevices, locks: options.locks || null },
    function WebSocketStub() {
      return socket;
    },
    fetchStub,
    globalThis.crypto,
    globalThis.atob,
    console,
    (fn) => {
      timers.push(fn);
      return timers.length;
    },
    () => {},
    () => 0,
    () => {},
  );

  const settle = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const frame = (message) => {
    for (const handler of socket.handlers.message || []) handler({ data: JSON.stringify(message) });
  };

  await settle();
  frame({
    type: "state",
    update: Buffer.from(encodeDocState(doc)).toString("base64"),
    history: [],
    presence: [],
  });
  await settle();

  const page = document.querySelector(".studio");
  const click = (selector) => {
    const node = document.querySelector(selector);
    assert.ok(node, `nothing matches ${selector}`);
    node.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    return node;
  };

  return { document, store, engine, sent, requests, log, page, click, settle, frame, releaseFinish, timers };
}

/**
 * @param {object} ui a booted panel
 * @returns {number} how many finishes it asked the gateway for
 */
function finishCount(ui) {
  return ui.requests.filter((request) => request.url.includes("/finish")).length;
}

/**
 * @param {object} ui a booted panel
 * @returns {number} how many chunk PUTs it sent
 */
function chunkPuts(ui) {
  return ui.requests.filter((request) => request.url.includes("/chunks/")).length;
}

/**
 * Arm the fake panel's audio track, press Record, and report the launch that
 * arms the recorder — everything a take needs before its first chunk.
 * @param {object} ui a booted panel
 * @param {number} [frame] the frame the launch reports
 * @returns {Promise<object>} the fake recorder
 */
async function startFakeRecording(ui, frame = 48000) {
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: frame }),
  );
  await ui.settle();
  return recorder;
}

/**
 * The take store's latency fixture: an interface that measures a 3,408-frame
 * (71 ms) round trip at 48 kHz.
 */
const CALIBRATED = { latency_frames: 3408, rate: 48000, spread_frames: 0 };

/**
 * Record one pass and report the offset the take was given, from the row this
 * device kept for it.
 * @param {number|null} latencyMs the engine's reported master delay, or null
 * @returns {Promise<number>} the take's `offset_frames`
 */
async function recordedOffset(latencyMs) {
  const ui = await bootPanel({ latency: CALIBRATED, gateFinish: true });
  if (latencyMs !== null) ui.engine.announceLatency({ ms: latencyMs });
  const recorder = await startFakeRecording(ui, 48000);
  recorder.chunk(new Uint8Array(64).buffer, 0, 0);
  await ui.settle();
  recorder.done({ segments: [{ segment: 0, start_frame: 48000, frames: 48000 }], frames: 48000, start_frame: 48000 });
  await ui.settle(24);
  const rows = Array.from(ui.store.pendings.values());
  assert.equal(rows.length, 1, "the take is on this device");
  ui.releaseFinish();
  return rows[0].offset_frames;
}

/** @param {number} ms @returns {number} that delay in frames, at the engine's rate. */
function framesOf(ms) {
  return Math.round((ms / 1000) * 48000);
}

test("a new take's offset also carries the engine's own master delay", async () => {
  // A take must land where it was played, so it is cut by the interface's round
  // trip AND by the delay the whole master path has: the limiter's look-ahead,
  // and the mix delay a rate-converted amp's compensation adds. Only a take
  // armed now is offset this way.
  assert.equal(await recordedOffset(null), 3408, "no limiter and no amp: the round trip alone, as before");
  assert.equal(
    await recordedOffset(1.5),
    3408 + framesOf(1.5),
    "a limiter's look-ahead moves the take by its own frames",
  );
  assert.equal(
    await recordedOffset(0.7),
    3408 + framesOf(0.7),
    "a rate-bridged amp alone moves it by the mix delay, and by nothing else",
  );
  assert.equal(
    await recordedOffset(2.2),
    3408 + framesOf(2.2),
    "both together are their sum, rounded once",
  );
});

test("a take this device already holds keeps the offset it was recorded with", async () => {
  // A take from an earlier session was cut by the round trip alone. The song has
  // a limiter now, so a take recorded HERE carries both delays — but the take
  // already recorded is never re-offset or moved: what it was recorded with is
  // what it keeps.
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000ab";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-earlier",
    rate: 48000,
    channels: 2,
    offset_frames: 3408,
    compensated: true,
    bpm: 240,
    chunk_count: 1,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  /** @returns {object[]} every begin body the page sent, oldest first. */
  const begins = (ui) => ui.requests
    .filter((request) => request.method === "PUT" && request.url.includes("/api/studio/takes/") && request.body)
    .map((request) => JSON.parse(request.body));

  const ui = await bootPanel({
    latency: CALIBRATED,
    pending: [row],
    chunks: [[takeId, 0, new Uint8Array(24).buffer]],
  });
  await ui.settle(24);

  // The take this device still owed was begun with the offset it was recorded
  // with — the engine's delay of the moment does not reach back into it.
  ui.engine.announceLatency({ ms: 1.5 });
  await ui.settle();
  const resumed = begins(ui).find((body) => body.clip_id === "c-earlier");
  assert.ok(resumed, "the recovered take was begun");
  assert.equal(resumed.offset_frames, 3408, "with the offset it was recorded with");

  // A take armed now is cut by both delays.
  const recorder = await startFakeRecording(ui, 48000);
  recorder.chunk(new Uint8Array(64).buffer, 0, 0);
  await ui.settle();
  // The take reaches this device (and is begun) only once the recorder reports
  // its end, the way `recordedOffset` does it.
  recorder.done({ segments: [{ segment: 0, start_frame: 48000, frames: 48000 }], frames: 48000, start_frame: 48000 });
  await ui.settle(24);
  const armed = begins(ui).find((body) => body.clip_id !== "c-earlier");
  assert.ok(armed, "the new take was begun");
  assert.equal(armed.offset_frames, 3408 + framesOf(1.5), "and carries the round trip and the engine's delay");
  assert.equal(resumed.offset_frames, 3408, "while the one already recorded still carries its own");
});

test("the take store is a classic script the page inlines before the client", async () => {
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");

  assert.equal(TAKE_STORE_SCRIPT.includes("\u0060"), false, "no backtick: the panel rule");
  assert.equal(TAKE_STORE_SCRIPT.includes("$" + "{"), false, "no template interpolation");
  assert.equal(TAKE_STORE_SCRIPT.includes('"'), false, "no double quote in the emitted text");
  assert.equal(TAKE_STORE_SCRIPT.includes("\\"), false, "no backslash in the emitted text");
  assert.equal(TAKE_STORE_SCRIPT.includes("</script"), false, "it cannot close its own script tag");
  assert.doesNotThrow(() => new Function("window", "navigator", TAKE_STORE_SCRIPT), "it parses");
  assert.ok(TAKE_STORE_SCRIPT.length > 1000, "it is the whole store");

  const res = {
    html: "",
    send(body) {
      this.html = String(body);
    },
  };
  await studioPanel.handler({ query: { song: "song-1" }, headers: {} }, res, { db: panelDb(), layout: minimalLayout });
  const storeAt = res.html.indexOf(TAKE_STORE_SCRIPT);
  const clientAt = res.html.indexOf(CLIENT_SCRIPT);
  assert.ok(storeAt >= 0, "the song page carries the take store");
  assert.ok(clientAt > storeAt, "and emits it before the client, which asks it for the takes");
  assert.ok(
    res.html.includes("/dashboard/studio/assets/resample.js"),
    "and the resampler the engine converts a take with",
  );
});

test("the audio track header arms an input and enables Record", async () => {
  const ui = await bootPanel();
  assert.equal(
    ui.document.querySelector('[data-act=record]').disabled,
    true,
    "Record is disabled until a track is armed",
  );
  assert.ok(
    ui.document.querySelector(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`),
    "the audio track header offers an Arm toggle",
  );
  assert.equal(
    ui.document.querySelector('[data-role=latency]').textContent,
    "Not calibrated — Calibrate…",
    "an unmeasured input says so, as a button",
  );

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();

  assert.equal(
    ui.document.querySelector(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`).textContent,
    "Armed",
    "the toggle shows the track is armed",
  );
  assert.equal(ui.document.querySelector('[data-act=record]').disabled, false, "Record is enabled now");
  const key = ui.document.querySelector('[data-role=latency]').getAttribute("data-latency-key");
  assert.equal(key, "Test input||48000|interactive", "the latency key names the input, the rate and the hint");
  assert.ok(
    ui.document.querySelector(`[data-track-id=${AUDIO_TRACK}] [data-act=monitor]`),
    "and the header offers Monitor through Studio",
  );
});

test("a stored measurement shows in the header and in the monitor sentence", async () => {
  const ui = await bootPanel({ latency: { latency_frames: 3408, rate: 48000, spread_frames: 0 } });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();

  assert.equal(
    ui.document.querySelector('[data-role=latency]').textContent,
    "71 ms",
    "the chip shows the measured round trip in milliseconds",
  );

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=monitor]`);
  await ui.settle(24);

  const warning = ui.document.querySelector('[data-role=monitor-warning]');
  assert.ok(warning, "turning monitoring on draws the warning");
  assert.equal(
    warning.textContent,
    "You'll hear yourself about 71 ms late. Your interface's direct-monitor knob has no delay.",
    "the sentence states the measured delay",
  );

  // With no measurement the sentence says so, rather than printing a number it
  // does not have (an empty one would read as a measurement of zero).
  const unmeasured = await bootPanel();
  unmeasured.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await unmeasured.settle();
  unmeasured.click(`[data-track-id=${AUDIO_TRACK}] [data-act=monitor]`);
  await unmeasured.settle(24);
  const unmeasuredWarning = unmeasured.document.querySelector('[data-role=monitor-warning]');
  assert.ok(unmeasuredWarning, "monitoring an unmeasured input still draws the warning");
  assert.equal(
    unmeasuredWarning.textContent,
    "You'll hear yourself late by an amount Studio hasn't measured yet. "
      + "Your interface's direct-monitor knob has no delay.",
    "an unmeasured input is described in words",
  );
});

test("a recorded chunk is kept on this device before it is uploaded", async () => {
  const ui = await bootPanel({ gateFinish: true });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.ok(
    ui.document.querySelector('[data-role=rec-notice]').textContent === "",
    "no warning before a recording starts",
  );

  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.ok(
    String(ui.document.querySelector('[data-role=rec-notice]').textContent).includes(NOT_CALIBRATED_TEXT),
    "the not-calibrated sentence comes before the take starts",
  );
  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "the panel built a recorder");

  // The engine reports the launch the take starts on.
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 48000 }),
  );
  await ui.settle();
  assert.equal(recorder.armFrame, 48000, "the recorder armed on the launch frame");
  assert.ok(recorder.splits.length > 1, "every loop boundary is a split, sent before it can pass");
  assert.ok(
    ui.sent.some((message) => message.command === "clip.add_audio"),
    "an empty slot gets an audio clip",
  );

  // One pass: one chunk, then the recorder's end.
  recorder.chunk(new Uint8Array(64).buffer, 0, 0);
  await ui.settle();
  recorder.done({ segments: [{ segment: 0, start_frame: 48000, frames: 48000 }], frames: 48000, start_frame: 48000 });
  await ui.settle(24);

  const stored = Array.from(ui.store.pendings.values());
  assert.equal(stored.length, 1, "one take became one pending row on this device");
  assert.equal(stored[0].chunk_count, 1, "with its chunk count");
  assert.equal(stored[0].compensated, false, "uncompensated, with no offset");
  assert.equal(stored[0].offset_frames, 0);

  // Everything the gateway was told came after the chunk was on this device.
  const keptAt = ui.log.indexOf("putChunk");
  const sentAt = ui.log.findIndex((entry) => entry.startsWith("fetch /api/studio/takes"));
  assert.ok(keptAt >= 0, "the chunk was written to the take store");
  assert.ok(sentAt > keptAt, "and only then was anything sent");

  const row = ui.document.querySelector('[data-role=recordings] [data-take-id]');
  assert.ok(row, "the take has a row while it uploads");
  assert.equal(row.textContent, "Uploading 1 of 1", "which counts the chunks it has sent");
  assert.ok(
    ui.requests.some((request) => request.url.includes("/finish")),
    "the upload finished with the chunk's hash",
  );

  ui.releaseFinish();
  await ui.settle(24);
  assert.equal(ui.store.pendings.size, 0, "a finished take leaves nothing pending on this device");
});

test("an interrupted recording is recovered on the next load", async () => {
  // A page that closed mid-take left a row with no chunk count and the chunks it
  // kept. The next load makes a take of them: audio the operator played.
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000aa";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-recovered",
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 240,
    chunk_count: null,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  const store = fakeTakeStore({ log: [] });
  const put = store.putPending.bind(store);
  const saved = [];
  store.putPending = async (value) => {
    saved.push({ chunk_count: value.chunk_count, frames: value.frames, recovered: value.recovered === true });
    return put(value);
  };
  // The take routes are held open, so the row can be read before the upload
  // starts — the state the sentence describes.
  let releaseUpload = () => {};
  const heldOpen = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const ui = await bootPanel({
    store,
    hold: heldOpen,
    pending: [row],
    chunks: [
      [takeId, 0, new Uint8Array(24).buffer],
      [takeId, 1, new Uint8Array(24).buffer],
    ],
  });
  await ui.settle(24);

  const text = ui.document.querySelector("[data-role=recordings] .st-pending-text");
  assert.ok(text, "the recovered take has a row while it uploads");
  assert.equal(
    text.textContent,
    "Recovered from an interrupted recording \u2014 will upload.",
    "the row says where the take came from",
  );

  releaseUpload();
  await ui.settle(24);

  const stored = saved.find((entry) => entry.recovered === true);
  assert.ok(stored, "the recovered row was written back to this device");
  assert.equal(stored.chunk_count, 2, "the chunks it kept became its chunk count");
  assert.equal(stored.frames, 8, "48 bytes of 24-bit stereo is eight frames");
  assert.equal(chunkPuts(ui), 2, "both kept chunks were sent");
  assert.equal(finishCount(ui), 1, "and the recovered take was finished");
  assert.equal(ui.store.pendings.size, 0, "a finished take leaves nothing on this device");
});

test("two uploaders for one take: only one runs", async () => {
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000bb";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-shared",
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 240,
    chunk_count: 1,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  const store = fakeTakeStore({ log: [] });
  store.pendings.set(takeId, row);
  store.chunks.set(takeId + ":0", new Uint8Array(12).buffer);
  const locks = fakeLocks();

  const first = await bootPanel({ store, locks, gateFinish: true, pending: [row] });
  await first.settle(24);
  assert.equal(finishCount(first), 1, "the first view is uploading the take");
  assert.equal(locks.held.has("studio-take-" + takeId), true, "and it holds the take's lock");

  const second = await bootPanel({ store, locks, pending: [row] });
  await second.settle(24);
  assert.equal(finishCount(second), 0, "the second view leaves the upload alone");
  assert.equal(finishCount(first), 1, "so the take is finished once, not twice");

  first.releaseFinish();
  await first.settle(24);
  assert.equal(store.pendings.size, 0, "the finished take left nothing on this device");
});

test("a take held by another view is retried and finished once that view lets go", async () => {
  // A Turbo visit tears a view down mid-upload while the tab lives on: its lock
  // can outlast it for a moment, and the next view of the song must not give
  // the take up when it finds the lock taken.
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000dd";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-held",
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 240,
    chunk_count: 1,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  const store = fakeTakeStore({ log: [] });
  store.pendings.set(takeId, row);
  store.chunks.set(takeId + ":0", new Uint8Array(12).buffer);
  const locks = fakeLocks();
  locks.held.add("studio-take-" + takeId);

  const ui = await bootPanel({ store, locks, pending: [row] });
  await ui.settle(24);
  assert.equal(finishCount(ui), 0, "the take is not sent while another view holds it");
  assert.ok(ui.timers.length > 0, "but a retry is scheduled");

  locks.held.delete("studio-take-" + takeId);
  for (const fn of ui.timers.splice(0)) fn();
  await ui.settle(24);
  assert.equal(finishCount(ui), 1, "once the lock is free the take is finished");
  assert.equal(store.pendings.size, 0, "and nothing is left on this device");
});

test("a vanished pending row ends the upload quietly", async () => {
  // Another view finished the take and deleted the row: the chunks are gone
  // with it, and this view must not report a missing piece or retry.
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000cc";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-gone",
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 240,
    chunk_count: 1,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  const store = fakeTakeStore({ log: [] });
  store.pendings.set(takeId, row);
  store.getPending = async () => null;

  const ui = await bootPanel({ store });
  await ui.settle(24);

  assert.equal(
    ui.document.querySelector(`[data-role=recordings] [data-take-id=${takeId}]`),
    null,
    "the row is gone, not stuck on an error",
  );
  assert.equal(
    ui.document.querySelector("[data-role=rec-notice]").textContent,
    "",
    "and nothing is reported to the operator",
  );
  assert.equal(finishCount(ui), 0, "nothing was finished twice");
  assert.equal(ui.timers.length, 0, "and no retry was scheduled");
});

test("loop splits follow the sequencer's absolute rounding at 130 bpm", async () => {
  // 130 bpm at 48 kHz is 22153.846… frames a beat, so a split computed from a
  // rounded pass length drifts off the sequencer's bars. Every split is
  // rounded once, on its own absolute position.
  const ui = await bootPanel({ bpm: 130 });
  const recorder = await startFakeRecording(ui, 48000);
  const fpb = (48000 * 60) / 130;
  const bars = 4;

  assert.ok(recorder.splits.length > 10, "every loop boundary is a split");
  for (let pass = 1; pass <= 10; pass += 1) {
    assert.equal(
      recorder.splits[pass - 1],
      48000 + Math.round(pass * bars * 4 * fpb),
      `pass ${pass} starts on the frame the sequencer gives that bar`,
    );
  }

  const roundedLoop = Math.round(bars * 4 * fpb);
  let drifted = false;
  for (let pass = 1; pass <= 10; pass += 1) {
    if (48000 + pass * roundedLoop !== recorder.splits[pass - 1]) drifted = true;
  }
  assert.ok(drifted, "a rounded pass length would drift off the bars it should land on");
});

test("the upload counter never exceeds the chunk count on resume", async () => {
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000dd";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-counter",
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 240,
    chunk_count: 1,
    begun: true,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  // The gateway says it holds three indexes, but the take has one chunk: the
  // row must never read "Uploading 3 of 1".
  const ui = await bootPanel({
    gateFinish: true,
    pending: [row],
    chunks: [[takeId, 0, new Uint8Array(12).buffer]],
    respond: (target) =>
      target.endsWith(takeId)
        ? {
            status: 200,
            body: {
              begun: true,
              frames: 6,
              "received": [
                { index: 0, sha256: "0".repeat(64) },
                { index: 1, sha256: "1".repeat(64) },
                { index: 2, sha256: "2".repeat(64) },
              ],
            },
          }
        : null,
  });
  await ui.settle(24);

  const text = ui.document.querySelector("[data-role=recordings] .st-pending-text");
  assert.ok(text, "the resumed take has a row");
  assert.equal(text.textContent, "Uploading 1 of 1", "the count stops at the take's own chunk count");

  ui.releaseFinish();
  await ui.settle(24);
});

test("a permanent refusal stops retrying and offers Try again and Remove", async () => {
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000ee";
  const row = {
    take_id: takeId,
    song_id: "song-1",
    clip_id: "c-refused",
    rate: 48000,
    channels: 2,
    offset_frames: 0,
    compensated: false,
    bpm: 240,
    chunk_count: 1,
    begun: false,
    finished: false,
    created_at: new Date(0).toISOString(),
  };
  let asks = 0;
  const ui = await bootPanel({
    pending: [row],
    chunks: [[takeId, 0, new Uint8Array(12).buffer]],
    respond: (target) => {
      if (!target.endsWith(takeId)) return null;
      asks += 1;
      return { status: 422, body: { error: "That take was refused." } };
    },
  });
  await ui.settle(24);

  const text = ui.document.querySelector(`[data-role=recordings] [data-take-id=${takeId}] .st-pending-text`);
  assert.ok(text, "the refused take keeps its row");
  assert.equal(
    text.textContent,
    "This take could not be uploaded: That take was refused.",
    "the row carries the gateway's own words",
  );
  const retry = ui.document.querySelector("[data-act=take-retry]");
  const remove = ui.document.querySelector("[data-act=take-remove]");
  assert.ok(retry, "the row offers Try again");
  assert.ok(remove, "the row offers Remove from this device");
  assert.equal(retry.textContent, "Try again");
  assert.equal(remove.textContent, "Remove from this device");

  const asked = asks;
  await ui.settle(24);
  assert.equal(asks, asked, "a refusal this firm is not retried by itself");
  assert.equal(ui.timers.length, 0, "and no retry timer was left behind");

  ui.click("[data-act=take-retry]");
  await ui.settle(24);
  assert.ok(asks > asked, "Try again asks the gateway once more");

  ui.click("[data-act=take-remove]");
  await ui.settle(24);
  assert.equal(ui.store.pendings.has(takeId), false, "Remove from this device gave the space back");
  assert.equal(
    ui.document.querySelector(`[data-role=recordings] [data-take-id=${takeId}]`),
    null,
    "and its row is gone",
  );
});

test("a store failure mid-record stops and uploads what was kept", async () => {
  const store = fakeTakeStore({ log: [] });
  const kept = store.putChunk.bind(store);
  store.putChunk = async (takeId, index, bytes) => {
    if (index === 1) throw new Error("The take store is full.");
    return kept(takeId, index, bytes);
  };
  const put = store.putPending.bind(store);
  const saved = [];
  store.putPending = async (value) => {
    saved.push({ chunk_count: value.chunk_count, frames: value.frames, partial: value.partial === true });
    return put(value);
  };

  // The context's clock reads 0.75 s, so "stop on this frame" has a frame.
  const ui = await bootPanel({ store, clock: 0.75 });
  const recorder = await startFakeRecording(ui, 48000);

  recorder.chunk(new Uint8Array(12).buffer, 0, 0);
  await ui.settle();
  recorder.chunk(new Uint8Array(12).buffer, 1, 0);
  await ui.settle(24);

  const notice = ui.document.querySelector("[data-role=rec-notice]").textContent;
  assert.ok(
    notice.includes(
      "This device could not keep the recording (its storage may be full). What was kept will upload.",
    ),
    `the panel says what happened (got: ${notice})`,
  );
  assert.equal(recorder.stopFrame, 36000, "the recording stops on the frame the audio thread is on");

  // The recorder posts what it had; the pass uploads up to its last kept chunk.
  recorder.done({ segments: [{ segment: 0, start_frame: 48000, frames: 96000 }], frames: 96000, start_frame: 48000 });
  await ui.settle(24);

  const partial = saved.find((entry) => entry.partial === true);
  assert.ok(partial, "the take was counted from what this device kept");
  assert.equal(partial.chunk_count, 1, "up to the last chunk that was kept");
  assert.equal(partial.frames, 2, "and described by the bytes it kept");
  assert.equal(chunkPuts(ui), 1, "the kept chunk was uploaded");
  const finished = ui.requests.filter((request) => request.url.includes("/finish"));
  assert.equal(finished.length, 1, "and the partial take was finished");
  assert.equal(
    JSON.parse(finished[0].body).chunk_hashes.length,
    1,
    "finish was given one hash: the chunk that was kept",
  );
  assert.equal(ui.store.pendings.size, 0, "a finished take leaves nothing on this device");
});

test("leaving the page just after a take starts keeps its round trip", async () => {
  // A calibrated interface cuts 3,408 frames (71 ms) from every take's start.
  // The page goes away 1,632 frames into the take: stopping on that very frame
  // would make a take shorter than its own offset, which the gateway refuses,
  // so the take would be lost. The stop keeps the round trip after it instead,
  // as Stop does.
  const latency = { latency_frames: 3408, rate: 48000, spread_frames: 0 };
  const store = fakeTakeStore({ latency, log: [] });
  const put = store.putPending.bind(store);
  const saved = [];
  store.putPending = async (value) => {
    saved.push({ chunk_count: value.chunk_count, frames: value.frames, offset_frames: value.offset_frames });
    return put(value);
  };
  const ui = await bootPanel({ store, clock: 0.75 });
  const recorder = await startFakeRecording(ui, 34368);
  recorder.chunk(new Uint8Array(1632 * 6).buffer, 0, 0);
  await ui.settle();

  ui.document.dispatchEvent(new ui.document.defaultView.Event("turbo:before-cache"));
  await ui.settle();
  assert.equal(recorder.stopFrame, 36000 + 3408, "the stop keeps the round trip after the frame it was asked on");

  const frames = recorder.stopFrame - 34368;
  recorder.chunk(new Uint8Array((frames - 1632) * 6).buffer, 1, 0);
  recorder.done({ segments: [{ segment: 0, start_frame: 34368, frames }], frames, start_frame: 34368 });
  await ui.settle(24);

  const finished = ui.requests.filter((request) => request.url.includes("/finish"));
  assert.equal(finished.length, 1, "the take was finished");
  const counted = saved.find((entry) => entry.chunk_count === 2);
  assert.ok(counted, "the take was counted");
  assert.equal(counted.offset_frames, 3408, "it carries the interface's round trip");
  assert.equal(counted.frames, 1632 + 3408, "and holds the round trip after the stop as well");
});

test("a pass that holds no more than its round trip is dropped, not refused", async () => {
  // Nothing past the cut: no played audio is in it. It leaves this device
  // instead of being sent to a gateway that would refuse it for good.
  const latency = { latency_frames: 3408, rate: 48000, spread_frames: 0 };
  const ui = await bootPanel({ latency, clock: 0.75 });
  const recorder = await startFakeRecording(ui, 34368);
  recorder.chunk(new Uint8Array(1000 * 6).buffer, 0, 0);
  await ui.settle();
  ui.click("[data-act=stop]");
  await ui.settle();
  recorder.done({ segments: [{ segment: 0, start_frame: 34368, frames: 1000 }], frames: 1000, start_frame: 34368 });
  await ui.settle(24);

  assert.equal(ui.requests.filter((request) => request.url.includes("/takes/")).length, 0, "nothing was sent");
  assert.equal(ui.store.pendings.size, 0, "and nothing is left on this device");
});

test("each loop pass uploads as soon as it ends", async () => {
  const ui = await bootPanel({ gateFinish: true });
  const recorder = await startFakeRecording(ui, 48000);

  recorder.chunk(new Uint8Array(12).buffer, 0, 0);
  await ui.settle();
  assert.equal(finishCount(ui), 0, "one chunk of a pass is not a finished pass");

  // The first chunk of the second pass closes the first one.
  recorder.chunk(new Uint8Array(12).buffer, 0, 1);
  await ui.settle(24);

  const stored = Array.from(ui.store.pendings.values());
  assert.equal(stored.length, 2, "each pass has its own take on this device");
  assert.equal(stored[0].chunk_count, 1, "the first pass is counted the moment it ends");
  assert.equal(stored[0].frames, 2, "with the frame count its own bytes give");
  assert.equal(stored[1].chunk_count, null, "the second pass is still being recorded");
  assert.equal(finishCount(ui), 1, "and the first pass is already uploading");

  ui.releaseFinish();
  await ui.settle(24);
});

test("teardown mid-record keeps every chunk and uploads the take", async (t) => {
  if (!chrome) return t.skip("no headless Chrome available");
  takesDown = false;

  const beforeSnap = (await hub.openSong(songId)).snapshot;
  const beforeClip = audioClipOf(beforeSnap);
  const takesBefore = beforeClip ? takesOfClip(beforeSnap, beforeClip.id).length : 0;

  const page = await openPage(studioUrl());
  t.after(() => page.close());
  await waitForStudio(page);
  await armAudioTrack(page);
  await armRecorder(page);
  await launchScene(page);

  // The take is on this device before the page goes away.
  const kept = await waitFor(
    page,
    "window.StudioTakeStore.listPending().then(function (rows) { return rows.length > 0; })",
    20000,
  );
  assert.ok(kept, "the recording has a pending row on this device");

  // The dashboard leaves the page: Turbo caches it, which tears the session
  // down in the middle of the take.
  await page.evaluate("document.dispatchEvent(new Event('turbo:before-cache')), true");

  // The torn-down page stops the recorder and keeps every chunk; whether it
  // also gets the upload out before it closes depends on how fast this machine
  // is. What is guaranteed is that the take is not lost: the next time the
  // song is open, the pending take is finished. So open it again (after the
  // teardown's 3 s cap) and require the take.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const again = await openPage(studioUrl());
  t.after(() => again.close());
  await waitForStudio(again);

  const snap = await waitForSong((state) => {
    const clip = audioClipOf(state);
    return !!clip && takesOfClip(state, clip.id).length > takesBefore;
  }, 30000);
  const clip = audioClipOf(snap);
  assert.ok(clip, "the clip is in the song");
  const takes = takesOfClip(snap, clip.id);
  assert.ok(
    takes.length > takesBefore,
    `leaving the page mid-take still made a take (was ${takesBefore}, is ${takes.length})`,
  );
  const newest = takes[takes.length - 1];
  assert.ok(newest.frames > 0, "and the take holds audio");
});