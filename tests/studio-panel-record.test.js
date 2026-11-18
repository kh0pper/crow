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
import { passGateRanges, spliceComp } from "../bundles/studio/panel/punch.js";
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
  takes.forEach((take, pass) => {
    assert.ok(take.frames > 0, `pass ${pass} holds audio`);
  });
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

/**
 * The document the mock client draws: one audio track and one scene, and — when
 * a test asks for it — an audio clip in that scene's slot on the armed track,
 * with the takes it already holds. The first take of a clip becomes its
 * whole-clip comp (take.add), which is what a punch has to punch into.
 * @param {number} [bpm]
 * @param {{clip?: boolean, takes?: object[], clipId?: string, lengthBars?: number}} [options]
 */
async function recordingDoc(bpm = 240, options = {}) {
  const { newSongDoc } = await import("../bundles/studio/server/doc.js");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/core.js");
  await import("../bundles/studio/server/commands/takes.js");
  const doc = newSongDoc({ title: "Recording song", bpm });
  const clipId = options.clipId || CLIP;
  runCommand(doc, "track.add", { id: AUDIO_TRACK, name: "Guitar", kind: "audio" });
  runCommand(doc, "scene.add", { id: SCENE, name: "Verse" });
  if (options.clip === true) {
    runCommand(doc, "clip.add_audio", {
      clip_id: clipId,
      track_id: AUDIO_TRACK,
      scene_id: SCENE,
      length_bars: Number(options.lengthBars) || 4,
      name: "Guitar",
    });
  }
  // The takes the clip already holds, oldest first: one recorded pass each, so
  // the clip has a comp to punch into.
  const takes = Array.isArray(options.takes) ? options.takes : [];
  takes.forEach((row, at) => {
    const id = String(row.id);
    runCommand(doc, "take.add", {
      clip_id: clipId,
      take: {
        id: id,
        storage_key: "studio/song-1/takes/" + id + ".wav",
        rate: 48000,
        channels: 2,
        frames: Number(row.frames) || 48000,
        offset_frames: 0,
        compensated: false,
        bpm: bpm,
        recorded_at: new Date(Date.UTC(2026, 0, 1, 10, at)).toISOString(),
        author_label: "You",
        discarded: false,
      },
    });
  });
  return doc;
}

/** The audio clip `recordingDoc` can seed on the armed track. */
const CLIP = "c-guitar";

/**
 * A `localStorage` that keeps what it is given: the page's own settings
 * (the count-in, the click, the output pick) are read from it.
 * @param {Record<string, string>} [initial]
 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      const name = String(key);
      return map.has(name) ? map.get(name) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

/**
 * The stored count-in: this device's own setting, in bars.
 *
 * Every test here that records starts from the count-in Off, which is the path
 * recording has always had (R4); a test about the count-in asks for a number of
 * bars, and `makeStorage()` with nothing in it is the page's own default.
 * @param {number} bars
 */
function countInStorage(bars) {
  return makeStorage({ "crow.studio.countin.v1": String(bars) });
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

/**
 * A context stand-in: the three nodes the panel builds, and its clock.
 *
 * `clock` is a number of seconds or an object whose `seconds` a test moves, so
 * "now" on the page's own clock can be read at the moment a message is sent.
 * @param {number|{seconds: number}} [clock]
 */
function fakeContext(clock = 0) {
  const secondsOf = () => (typeof clock === "number" ? clock : Number(clock.seconds) || 0);
  const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
  return {
    sampleRate: 48000,
    state: "running",
    get currentTime() {
      return secondsOf();
    },
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

/**
 * The engine stand-in: one fake recorder the test drives by hand, the count-in's
 * own messages, and the loop start a take is anchored on.
 * @param {{seconds: number}} [clock] the page's own clock, so a recorder can
 *   report the frame the page's "now" stood on when it was armed
 */
function fakeEngine(clock = { seconds: 0 }) {
  const nowOf = () => Math.round((Number(clock.seconds) || 0) * 48000);
  const engine = {
    recorders: [],
    launches: [],
    launched: [],
    node: { connect() {} },
    setSong() {},
    plays: 0,
    /** Every `play` the page sent, with its options (`{countInBars}` or none). */
    playCalls: [],
    play(options) {
      engine.plays += 1;
      engine.playCalls.push(options || null);
    },
    stops: 0,
    stop() {
      engine.stops += 1;
    },
    stopAll() {},
    unloadAudio() {},
    async loadAudio() {},
    launchScene(sceneId) {
      engine.launched.push(String(sceneId));
    },
    /** Every mode the page put the engine in (`session`, `arrangement`). */
    modes: [],
    setMode(mode) {
      engine.modes.push(String(mode));
    },
    // The position reports the transport sends: a test hands one over the way the
    // engine does, so the page's own readers of it are the ones that react.
    positionListeners: [],
    onPosition(listener) {
      engine.positionListeners.push(listener);
      return () => {};
    },
    position(report) {
      for (const listener of engine.positionListeners) listener(report);
    },
    onError() {
      return () => {};
    },
    onLaunch(listener) {
      engine.launches.push(listener);
      return () => {};
    },
    // The count-in: the page starts it with `play({countInBars})` and follows
    // what the engine posts. A test posts the messages itself, in the order the
    // processor does, and `events` keeps that order beside the loop asks.
    countInListeners: [],
    events: [],
    onCountIn(listener) {
      engine.countInListeners.push(listener);
      return () => {};
    },
    countIn(event) {
      engine.events.push(event && event.type ? String(event.type) : "");
      for (const listener of engine.countInListeners) listener(event);
    },
    /**
     * Walk a count-in of `bars` bars from its start to its downbeat. Each click
     * is posted from the frame the engine had rendered when it rang it, so the
     * page's own clock stands there as the page hears it: an arm sent after a
     * click is on a frame that click led.
     */
    countBar(bars = 1, playFrame = 96000, beatFrames = 12000) {
      const beats = bars * 4;
      engine.countIn({ type: "count_in_start", play_frame: playFrame });
      for (let beat = 1; beat <= beats; beat += 1) {
        const at = playFrame - (beats - beat) * beatFrames;
        clock.seconds = at / 48000;
        engine.countIn({
          type: "count_in",
          beat,
          beats,
          frame: at,
          play_frame: playFrame,
        });
      }
      clock.seconds = playFrame / 48000;
      engine.countIn({ type: "count_in_done", frame: playFrame });
    },
    cancels: 0,
    cancelCountIn() {
      engine.cancels += 1;
    },
    pauses: 0,
    pause() {
      engine.pauses += 1;
    },
    // The loop start of the armed clip: `looping` false is the engine's own
    // answer for a track that is not playing that clip (the bar line instead).
    loopFrame: 96000,
    loopBar: 2,
    looping: false,
    loopAsks: [],
    async nextLoopFrame(trackId, clipId) {
      engine.loopAsks.push({ track_id: trackId, clip_id: clipId });
      engine.events.push("nextLoopFrame");
      return { frame: engine.loopFrame, bar: engine.loopBar, looping: engine.looping };
    },
    async nextBarFrame() {
      return { frame: 48000, bar: 1 };
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
    async calibrate() {
      return { latency_frames: 3408, rate: 48000, spread_frames: 0, clicks_heard: 14 };
    },
    async createRecorder() {
      // A case may hold the input open: a recorder that arrives after the frame
      // its take should have armed on.
      if (engine.holdRecorder) await engine.holdRecorder;
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
          // The frame the page's clock stood on as the arm was sent: an arm is
          // always in the future, so this is never past it (rule 9).
          recorder.armNow = nowOf();
        },
        stopAt(frame) {
          recorder.stopFrame = frame;
        },
        splitAt(frames) {
          recorder.splits = frames;
        },
        // The punch: the range the recorder keeps open on every pass, and the
        // frame a replacement range takes over from (see engine-client.js).
        gates: [],
        gatePeriodic(spec) {
          recorder.gates.push(spec);
        },
        gatedOff: 0,
        gateOff() {
          recorder.gatedOff += 1;
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
 *          hold?: Promise<void>, holdRecorder?: Promise<void>, confirm?: boolean,
 *          countIn?: number, storage?: object, clip?: boolean, failInput?: boolean,
 *          takes?: object[], lengthBars?: number,
 *          respond?: (url: string, init: object) => ({status: number, body: object}|null)}} [options]
 */
async function bootPanel(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");
  const { PUNCH_SCRIPT } = await import("../bundles/studio/panel/punch.js");
  const { SCENE_PLAN_SCRIPT } = await import("../bundles/studio/panel/scene-plan.js");

  const doc = await recordingDoc(options.bpm, {
    clip: options.clip === true,
    takes: options.takes,
    lengthBars: options.lengthBars,
  });
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
  const clock = { seconds: options.clock || 0 };
  const store = options.store || fakeTakeStore({ latency: options.latency || null, log });
  // A take the previous page left behind, and the chunks it kept: what a
  // resumed upload and an interrupted recording are made of.
  for (const row of options.pending || []) store.pendings.set(row.take_id, row);
  for (const [takeId, index, bytes] of options.chunks || []) store.chunks.set(takeId + ":" + index, bytes);
  const engine = fakeEngine(clock);
  // A case may hold the input open, so a recorder can arrive after the frame its
  // take should have armed on (see the late-recorder case).
  engine.holdRecorder = options.holdRecorder || null;
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
      if (options.failInput === true || mediaDevices.failNext === true) {
        throw new Error("The input could not be opened.");
      }
      return stream;
    },
    async enumerateDevices() {
      return [{ kind: "audioinput", deviceId: "test-input", label: "Test input" }];
    },
  };

  // This device's own settings: the count-in a test asks for, stored the way a
  // browser stores it. With none named, the page starts on the count-in Off —
  // the path recording has always had — and `makeStorage()` alone is the page's
  // own default of one bar.
  const storage = options.storage
    || countInStorage(options.countIn === undefined ? 0 : options.countIn);

  const windowStub = {
    crypto: globalThis.crypto,
    location: { protocol: "http:", host: "127.0.0.1:1", reload() {} },
    atob: globalThis.atob,
    localStorage: storage,
    confirm: () => options.confirm !== false,
    AudioContext: function AudioContextStub() {
      return fakeContext(clock);
    },
    StudioTakeStore: store,
    StudioEngine: { create: async () => engine },
    // The page's own window listeners, so a pointer drag can be finished the way
    // a browser finishes it (the comp bar's release is a window event).
    listeners: {},
    addEventListener(name, handler) {
      (windowStub.listeners[name] ||= []).push(handler);
    },
    removeEventListener(name, handler) {
      const list = windowStub.listeners[name] || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
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

  // The punch rules are emitted before the client as well, and the page asks
  // window.StudioPunch for the comp splice a punched pass writes with.
  new Function("window", PUNCH_SCRIPT)(windowStub);
  assert.equal(typeof windowStub.StudioPunch.spliceComp, "function", "the punch rules are evaluated");

  // So is the scene plan, which the page asks window.StudioScenePlan for the
  // blocks its strip and the lanes' bands draw.
  delete windowStub.StudioScenePlan;
  new Function("window", SCENE_PLAN_SCRIPT)(windowStub);
  assert.equal(typeof windowStub.StudioScenePlan.planOf, "function", "the plan rules are evaluated");

  // The transport bar's own reducer is what the page asks for the scene a launch
  // has queued for the next bar. The bar's layout and its controls are not what
  // this harness draws, so only its two readout helpers are handed over: a stub
  // that moves nothing and holds nothing, and the real rules the page reads.
  const transportBar = await import("../bundles/studio/panel/transport-bar.js");
  windowStub.StudioTransport = {
    mount: () => ({ refresh() {}, destroy() {} }),
    sceneLabel: transportBar.sceneLabel,
    nextQueued: transportBar.nextQueued,
  };

  const timers = [];
  // Everything the page says with console.warn: one case is about a comp write
  // the page gives up on, and the words it says so with.
  const warnings = [];
  const consoleStub = {
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
    warn: (text) => warnings.push(String(text)),
  };
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
    consoleStub,
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

  // The hub's own state frame for the song as it stands now: what an edit that
  // already landed looks like to a page that did not make it.
  const pushState = async () => {
    frame({
      type: "state",
      update: Buffer.from(encodeDocState(doc)).toString("base64"),
      history: [],
      presence: [],
    });
    await settle();
  };

  // The socket going away under the page: a browser's close, with no answer
  // coming for anything still on it.
  const dropSocket = async () => {
    for (const handler of socket.handlers.close || []) handler({ code: 1006 });
    await settle();
  };

  // The page coming back after a drop: its reconnect timer runs (the stub hands
  // it the same socket, open again) and the hub's state frame follows, which is
  // what rebuilds the document and re-flushes what the page still owes.
  const rejoin = async () => {
    for (const fn of timers.splice(0)) fn();
    await settle();
    await pushState();
  };

  /** One DOM event the way a browser sends it: bubbling, cancelable, with props. */
  const event = (type, props) => {
    const made = new domWindow.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props || {})) made[key] = value;
    return made;
  };
  /** Send one event to the window, as a pointer on the page would. */
  const fireWindow = (type, made) => {
    for (const handler of [...(windowStub.listeners[type] || [])]) handler(made);
  };

  return { document, doc, store, storage, engine, clock, mediaDevices, sent, requests, log, page, click, settle, frame, pushState, dropSocket, rejoin, releaseFinish, timers, event, fireWindow, warnings };
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
 * @param {{beforeLaunch?: function(object): void}} [options] `beforeLaunch` runs
 *   between the recorder being built and the launch that starts the take
 * @returns {Promise<object>} the fake recorder
 */
async function startFakeRecording(ui, frame = 48000, options = {}) {
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  if (options.beforeLaunch) await options.beforeLaunch(ui);
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

test("a mix delay the engine reports while the take is armed is the one it is cut by", async () => {
  // The recorder is built before the engine has said anything about the master
  // path, and the report arrives before the launch that starts the take: the
  // take is cut by what the engine says when it STARTS, not by what it said when
  // the recorder was built.
  const ui = await bootPanel({ latency: CALIBRATED, gateFinish: true });
  const recorder = await startFakeRecording(ui, 48000, {
    beforeLaunch(panel) {
      panel.engine.announceLatency({ ms: 1.5 });
    },
  });
  recorder.chunk(new Uint8Array(64).buffer, 0, 0);
  await ui.settle();
  recorder.done({ segments: [{ segment: 0, start_frame: 48000, frames: 48000 }], frames: 48000, start_frame: 48000 });
  await ui.settle(24);
  const rows = Array.from(ui.store.pendings.values());
  assert.equal(rows.length, 1, "the take is on this device");
  assert.equal(
    rows[0].offset_frames,
    3408 + framesOf(1.5),
    "the round trip and the delay the engine reported while the take was armed",
  );
  ui.releaseFinish();
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

test("monitor warning waits for the measurement instead of saying unmeasured", async () => {
  // The switch closes only once its delay is in hand: a monitor drawn while the
  // read is still on its way would tell the operator the measurement it already
  // has does not exist.
  const store = fakeTakeStore({ latency: CALIBRATED, log: [] });
  const read = store.getLatency.bind(store);
  let releaseRead = () => {};
  let holdNextRead = false;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  store.getLatency = async (key) => {
    if (holdNextRead) {
      holdNextRead = false;
      await readGate;
    }
    return read(key);
  };

  const ui = await bootPanel({ store });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(
    ui.document.querySelector('[data-role=latency]').textContent,
    "71 ms",
    "the armed track already holds its measurement",
  );

  // The next read — the monitor's own — is kept open, and the page is drawn
  // again while it is open (playing draws the panel, and plays nothing here).
  const chip = ui.document.querySelector('[data-role=latency]');
  holdNextRead = true;
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=monitor]`);
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle();

  assert.notEqual(
    ui.document.querySelector('[data-role=latency]'),
    chip,
    "the panel was drawn again while the measurement was still on its way",
  );
  const early = ui.document.querySelector('[data-role=monitor-warning]');
  assert.ok(
    !early || !early.textContent.includes("hasn't measured"),
    "a monitor whose measurement is still being read never says it has none",
  );

  releaseRead();
  await ui.settle(24);
  const warning = ui.document.querySelector('[data-role=monitor-warning]');
  assert.ok(warning, "the switch closes once the measurement is in hand");
  assert.equal(
    warning.textContent,
    "You'll hear yourself about 71 ms late. Your interface's direct-monitor knob has no delay.",
    "and the sentence states the measured delay",
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

// ---- the record flow as it stands, before count-in and punch-in -------------
//
// Characterisation: what Record does today, written down so a change to it is
// visible as a failing test. A stopped transport asks for a scene launch and
// waits; a launch report's frame is the take's first frame, with one pass per
// loop from there; a running transport arms on the bar frame the engine
// reports, not on the armed clip's loop grid; and Pause is off while a take
// runs.

test("today: Record while stopped with the count-in Off shows the launch-a-scene notice and waits", async () => {
  // The count-in is Off here (the rig's default), which is the path recording
  // has always had (R4): nothing is queued, no play is sent, and a launch report
  // is what starts the take.
  const ui = await bootPanel();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.engine.plays = 0;
  ui.engine.play = function () {
    ui.engine.plays += 1;
  };
  ui.click("[data-act=record]");
  await ui.settle(24);

  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder for the armed track");
  assert.equal(recorder.armFrame, null, "and left it unarmed, waiting for a launch");
  assert.deepEqual(recorder.splits, [], "with no pass boundary sent");
  assert.equal(recorder.stopFrame, null, "and nothing asked it to stop");

  const notice = String(ui.document.querySelector("[data-role=rec-notice]").textContent);
  assert.ok(
    notice.includes("Launch a scene on the armed track to start at its first bar."),
    `the page asks for a scene launch (got: ${notice})`,
  );

  const status = ui.document.querySelector("[data-role=rec-status]");
  assert.equal(
    status.textContent,
    "Waiting for a scene launch\u2026",
    "the status names what it waits for",
  );
  assert.equal(status.getAttribute("data-ready"), "1", "the recorder is built and ready");
  assert.equal(status.getAttribute("data-recording"), "0", "and nothing is being recorded");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "no clip was made for a take that has not begun",
  );
  assert.equal(ui.engine.plays, 0, "the transport was not started by itself");
});

test("today: a launch report arms the recorder on its frame and sends one split per pass", async () => {
  const ui = await bootPanel();
  const recorder = await startFakeRecording(ui, 48000);

  assert.equal(recorder.armFrame, 48000, "the recorder armed on the frame the launch reported");
  assert.equal(recorder.stopFrame, null, "nothing asked it to stop yet");
  // The slot is empty, so the clip made for it is as long as the scene: four
  // bars when the scene holds no clip. At 240 BPM one beat is 12,000 frames.
  const fpb = (48000 * 60) / 240;
  const loop = 4 * 4 * fpb;
  assert.ok(recorder.splits.length > 1, "the boundary of every pass is sent up front");
  for (let pass = 1; pass <= recorder.splits.length; pass += 1) {
    assert.equal(
      recorder.splits[pass - 1],
      48000 + Math.round(pass * loop),
      `pass ${pass} is cut on its own boundary`,
    );
  }

  const status = ui.document.querySelector("[data-role=rec-status]");
  assert.equal(status.textContent, "Recording, pass 1", "the status counts from the first pass");
  assert.equal(status.getAttribute("data-recording"), "1", "and says the take is running");

  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got one audio clip");
  assert.equal(added[0].args.track_id, AUDIO_TRACK, "on the armed track");
  assert.equal(added[0].args.scene_id, SCENE, "in the slot the launch named");
  assert.equal(added[0].args.length_bars, 4, "as long as the scene");
});

test("today: Record while playing arms on the bar frame when the armed slot is not the playing clip", async () => {
  const ui = await bootPanel();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();

  // The transport plays the scene. The take's own clip is four bars long, so
  // its loop grid repeats every four bars while the engine counts bars.
  ui.engine.plays = 0;
  ui.engine.play = function () {
    ui.engine.plays += 1;
  };
  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.plays, 1, "the transport was started");
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 48000 }),
  );
  await ui.settle();

  // The engine's own answer for a slot it is not playing: the next bar line, and
  // `looping` false (the clip this take belongs to is another one).
  let asked = 0;
  ui.engine.nextBarFrame = async () => {
    asked += 1;
    return { frame: 96000, bar: 2 };
  };
  ui.engine.nextLoopFrame = async () => {
    asked += 1;
    return { frame: 96000, bar: 2, looping: false };
  };

  ui.click("[data-act=record]");
  await ui.settle(24);

  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  assert.equal(asked, 1, "the take's frame was asked of the engine's own clock");
  assert.equal(ui.engine.plays, 1, "and the transport was not started a second time");
  assert.equal(ui.engine.playCalls.filter((options) => options && options.countInBars).length, 0, "no count-in was asked for while the transport runs");
  assert.equal(recorder.armFrame, 96000, "the recorder armed on exactly that frame");

  const fpb = (48000 * 60) / 240;
  const loop = 4 * 4 * fpb;
  assert.notEqual(recorder.armFrame, 48000 + loop, "one loop after the launch is not where it armed");
  const intoTheClip = recorder.armFrame - 48000;
  assert.equal(
    intoTheClip % Math.round(fpb),
    0,
    "it begins a whole number of beats into the playing clip",
  );
  assert.notEqual(intoTheClip % Math.round(loop), 0, "so the take's beat 0 is not the clip's beat 0");
  assert.equal(
    recorder.splits[0],
    96000 + Math.round(loop),
    "and its first pass ends one loop after that bar",
  );

  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the clip is in the slot the armed track is playing");
  assert.equal(added[0].args.scene_id, SCENE, "which is the scene the launch named");
});

test("today: Pause is disabled while a take runs", async () => {
  const ui = await bootPanel({ clock: 0.75 });
  ui.engine.paused = 0;
  ui.engine.pause = function () {
    ui.engine.paused += 1;
  };
  ui.engine.stopped = 0;
  ui.engine.stop = function () {
    ui.engine.stopped += 1;
  };
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle();

  const pause = ui.document.querySelector("[data-act=pause]");
  assert.ok(pause, "the transport bar carries Pause");
  assert.equal(pause.disabled, false, "Pause is offered while nothing is being recorded");

  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 48000 }),
  );
  await ui.settle();
  // The loop start the engine names for the armed slot's clip.
  ui.engine.loopFrame = 48000;
  ui.engine.looping = true;
  ui.click("[data-act=record]");
  await ui.settle(24);

  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  assert.equal(recorder.armFrame, 48000, "and armed it on the frame the engine named");
  assert.equal(pause.disabled, true, "Pause is disabled while the take runs");
  assert.equal(pause.getAttribute("title"), "Stop ends a recording", "and says Stop is what ends it");

  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(ui.engine.paused, 0, "pressing it leaves the transport alone");
  assert.equal(ui.engine.stopped, 0, "and stops nothing either");
  assert.equal(
    ui.document.querySelector("[data-role=rec-status]").getAttribute("data-recording"),
    "1",
    "and the take is still recording",
  );
});

// ---- the count-in and the anchor (R1-R4, R9) -------------------------------
//
// A take begins on a frame the ENGINE names, always in the future: the
// count-in's announced play frame when the transport is stopped, the loop start
// it names after a paused count-in or while the transport already runs, and the
// launch report a count-in-off take starts from. Nothing below reads a frame the
// page worked out for itself, and every arm is at or after the page's own
// "now" when it is sent.

/**
 * Put the page where the record scene is the one that launched: a launch report
 * on the armed track, which is what says so.
 * @param {object} ui a booted panel
 */
async function launchReported(ui) {
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 48000 }),
  );
  await ui.settle();
}

/**
 * Arm the fake panel's audio track and press Record.
 * @param {object} ui a booted panel
 * @returns {Promise<object>} the fake recorder, before anything armed it
 */
async function pressRecord(ui) {
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder for the armed track");
  return recorder;
}

/** @returns {object[]} the count-in `play` calls the page sent */
function countInPlays(ui) {
  return ui.engine.playCalls.filter((options) => options && options.countInBars);
}

/**
 * The frame a one-bar count-in's last click rings on: one beat before the song.
 */
const LAST_CLICK_FRAME = 84000;

/**
 * Stand the page's own clock on a frame, the way a browser's clock stands on the
 * last frame the engine rendered when a message reaches the page.
 * @param {object} ui a booted panel
 * @param {number} frame
 */
function clockAtFrame(ui, frame) {
  ui.clock.seconds = Number(frame) / 48000;
}

test("the count-in defaults to one bar on a device that has never chosen one", async () => {
  // The page reads the setting from this device's storage; with nothing stored
  // it counts one bar in, which is what a first Record press does.
  const ui = await bootPanel({ storage: makeStorage() });
  assert.equal(ui.page.__studioTest.view.countIn, 1, "the stored setting starts at one bar");

  await pressRecord(ui);
  assert.equal(countInPlays(ui).length, 1, "Record asked the engine to count in");
  assert.equal(countInPlays(ui)[0].countInBars, 1, "one bar of clicks");
});

// --- the scene plan's record options row (B6) -------------------------------

/** The four count-in choices the options row offers, in the order it draws them. */
const COUNT_IN_CHOICES = [
  [0, "Off"],
  [1, "1 bar"],
  [2, "2 bars"],
  [4, "4 bars"],
];

/** The options row's four buttons, in page order. */
function countInButtons(ui) {
  return Array.from(ui.document.querySelectorAll("[data-act=count-in]"));
}

/** The label of the one choice the row shows pressed. */
function pressedCountIn(ui) {
  const pressed = countInButtons(ui).filter((node) => node.getAttribute("aria-pressed") === "true");
  assert.equal(pressed.length, 1, "exactly one count-in choice reads as pressed");
  return String(pressed[0].textContent);
}

/** A localStorage that refuses every read and every write. */
function refusingStorage() {
  return {
    getItem() {
      throw new Error("this browser keeps nothing");
    },
    setItem() {
      throw new Error("this browser keeps nothing");
    },
    removeItem() {
      throw new Error("this browser keeps nothing");
    },
  };
}

test("the four count-in buttons set view.countIn and storage and show the pressed one", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  assert.deepEqual(
    countInButtons(ui).map((node) => String(node.textContent)),
    COUNT_IN_CHOICES.map((choice) => choice[1]),
    "Off, 1, 2 and 4 bars are offered, in that order",
  );
  assert.equal(pressedCountIn(ui), "1 bar", "a device that has never chosen one starts on one bar");
  assert.equal(
    String(ui.document.querySelector("[data-role=scene-plan-note]").textContent),
    "Counts in when you start from Stop or Pause.",
    "the row says when a count-in applies",
  );
  assert.match(
    String(ui.document.querySelector("[data-role=scene-plan-sampler]").textContent),
    /Sampler.*Resample records the sampler live/,
    "and points at the pads widget's own live recording",
  );

  for (const [bars, label] of [[0, "Off"], [2, "2 bars"], [4, "4 bars"], [1, "1 bar"]]) {
    ui.click(`[data-act=count-in][data-bars="${bars}"]`);
    await ui.settle();
    assert.equal(ui.page.__studioTest.view.countIn, bars, `${label} is the page's count-in now`);
    assert.equal(
      ui.storage.getItem("crow.studio.countin.v1"),
      String(bars),
      `${label} is what this browser keeps`,
    );
    assert.equal(pressedCountIn(ui), label, `and the row shows ${label} pressed`);
  }
});

test("a browser with blocked storage still changes the setting for the session", async () => {
  const ui = await bootPanel({ storage: refusingStorage() });
  assert.equal(ui.page.__studioTest.view.countIn, 1, "a store that refuses reads as the default");

  ui.click('[data-act=count-in][data-bars="4"]');
  await ui.settle();
  assert.equal(ui.page.__studioTest.view.countIn, 4, "the choice is the page's own for this session");
  assert.equal(pressedCountIn(ui), "4 bars", "and the row shows it");

  // The setting is what a take counts in: the next Record press asks for those
  // four bars even though this browser kept none of them.
  await pressRecord(ui);
  assert.equal(countInPlays(ui).length, 1, "Record asked for a count-in");
  assert.equal(countInPlays(ui)[0].countInBars, 4, "the four bars the operator just chose");
});

test("R4: count-in 0 sends exactly the arm and split messages of the characterisation test", async () => {
  // Off is the path recording always had, taken as a golden: the launch report's
  // frame is the take's first frame, one split per pass from there, the same
  // clip command, and the same offset on every pass that lands (nothing is
  // calibrated here, so it is zero).
  const ui = await bootPanel({ countIn: 0, gateFinish: true });
  await pressRecord(ui);
  assert.equal(countInPlays(ui).length, 0, "Off sends no count-in play");
  assert.deepEqual(ui.engine.launched, [], "and queues no launch");
  assert.equal(
    ui.engine.recorders[0].armFrame,
    null,
    "the take waits for the operator's own launch",
  );

  await launchReported(ui);
  const recorder = ui.engine.recorders[0];
  assert.equal(recorder.armFrame, 48000, "the launch report's frame is the take's first frame");

  const fpb = (48000 * 60) / 240;
  const bars = 4;
  assert.deepEqual(
    recorder.splits,
    Array.from({ length: recorder.splits.length }, (_unused, at) =>
      48000 + Math.round((at + 1) * bars * 4 * fpb)),
    "one split per pass, each rounded once on its own absolute position",
  );
  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got one audio clip");
  assert.deepEqual(
    added[0].args,
    {
      clip_id: added[0].args.clip_id,
      track_id: AUDIO_TRACK,
      scene_id: SCENE,
      length_bars: 4,
      name: "Guitar",
    },
    "in the slot the launch named, as long as the scene",
  );

  // The take's rows: one per pass, each cut by the offset of the moment it was
  // armed — zero here, which is what an uncalibrated input gives.
  recorder.chunk(new Uint8Array(64).buffer, 0, 0);
  recorder.chunk(new Uint8Array(64).buffer, 0, 1);
  await ui.settle(24);
  const rows = Array.from(ui.store.pendings.values());
  assert.equal(rows.length, 2, "both passes are on this device");
  for (const row of rows) assert.equal(row.offset_frames, 0, "an uncalibrated take carries no offset");
  ui.releaseFinish();
});

test("R4: a calibrated count-in-0 take stores its offset on pass 0 and offset 0 on every later pass", async () => {
  // Off (R4), with an input calibrated to a 3,408-frame round trip: the launch
  // report's frame is the take's first frame, so those frames sit in front of
  // pass 0's beat 0 and its row stores them. Passes 1 and 2 begin on their own
  // split frames, which already carry the round trip, so they store nothing.
  const ui = await bootPanel({ countIn: 0, latency: CALIBRATED, gateFinish: true });
  await pressRecord(ui);
  await launchReported(ui);
  const recorder = ui.engine.recorders[0];
  assert.equal(recorder.armFrame, 48000, "the launch report's frame is the take's first frame");

  // One chunk per pass, each holding more frames than the round trip pass 0 is
  // cut by: a pass holding no more than that would be dropped as silence.
  const passFrames = CALIBRATED.latency_frames + 1200;
  for (const pass of [0, 1, 2]) {
    recorder.chunk(new Uint8Array(passFrames * 3 * 2).buffer, 0, pass);
    await ui.settle(24);
  }

  const rows = Array.from(ui.store.pendings.values());
  assert.equal(rows.length, 3, `three passes are three rows on this device (got ${rows.length})`);
  const first = rows[0].offset_frames;
  assert.ok(first > 0, "pass 0 holds the calibrated round trip in front of its beat 0");
  assert.equal(first, CALIBRATED.latency_frames, "and stores exactly the round trip it was armed with");
  assert.equal(rows[1].offset_frames, 0, "pass 1 begins on its own split frame, so it stores no offset");
  assert.equal(rows[2].offset_frames, 0, "and pass 2 begins on its own beat 0 too");

  ui.releaseFinish();
  await ui.settle();
});

test("R1: count-in 1 plays with countInBars 1 and arms on the announced play_frame", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  const recorder = await pressRecord(ui);

  assert.equal(countInPlays(ui).length, 1, "Record asked for a count-in");
  assert.equal(countInPlays(ui)[0].countInBars, 1, "one bar of it");
  assert.deepEqual(ui.engine.launched, [SCENE], "the record scene's launch was queued for the downbeat");
  assert.equal(ui.engine.plays, 1, "the engine was started once, by the count-in");
  assert.equal(recorder.armFrame, null, "nothing is armed while the clicks run");

  // The engine announces the frame the song starts on, then one click per beat,
  // each posted from the frame the engine had rendered when it rang.
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  for (const beat of [1, 2, 3]) {
    const at = 96000 - (4 - beat) * 12000;
    clockAtFrame(ui, at);
    ui.engine.countIn({ type: "count_in", beat, beats: 4, frame: at, play_frame: 96000 });
    await ui.settle();
  }
  assert.equal(recorder.armFrame, null, "the take is not armed before the last click");

  // The last beat's click is a beat ahead of the downbeat: a true future frame,
  // and the frame the page's own clock stands on as the arm goes out.
  clockAtFrame(ui, LAST_CLICK_FRAME);
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: LAST_CLICK_FRAME, play_frame: 96000 });
  await ui.settle(24);
  assert.equal(recorder.armFrame, 96000, "the recorder armed on the frame the count-in announced");
  assert.ok(recorder.armFrame > LAST_CLICK_FRAME, "ahead of the frame the last click rang on");
  assert.ok(
    recorder.armFrame - LAST_CLICK_FRAME >= BEAT_FRAMES,
    "by at least the beat that click leads the song by",
  );
  assert.ok(
    recorder.armFrame > recorder.armNow,
    `and ahead of where the page's own clock stood as it armed (${recorder.armFrame} vs ${recorder.armNow})`,
  );
  assert.equal(recorder.splits[0], 96000 + Math.round(4 * 4 * ((48000 * 60) / 240)), "its first pass ends a loop after it");

  // The take holds none of the count-in: it begins on the downbeat, not before
  // it. The clip of the record scene's slot is written on that downbeat, and the
  // status keeps reading the count-in until then (S3).
  const status = () => ui.document.querySelector("[data-role=rec-status]");
  assert.equal(status().textContent, "Count-in 1", "the last beat's click is still the count-in");
  assert.equal(status().getAttribute("data-recording"), "0", "nothing is being recorded yet");
  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);
  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the downbeat writes the empty slot's one audio clip");
  assert.equal(added[0].args.scene_id, SCENE, "in the record scene");
  assert.equal(status().textContent, "Recording, pass 1", "the take replaces the count-in");
});

test("R2: from paused it counts in, resumes, and arms at nextLoopFrame asked after count_in_done", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75, clip: true });
  ui.click("[data-act=play]");
  await ui.settle();
  await launchReported(ui);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(ui.page.__studioTest.view.paused, true, "the transport stands paused where it was");

  ui.engine.loopFrame = 120000;
  ui.engine.looping = true;
  ui.engine.events.length = 0;
  const recorder = await pressRecord(ui);
  assert.deepEqual(ui.engine.launched, [], "the paused scene is the record scene, so nothing is queued");

  // A paused count-in arms nothing on its clicks: the downbeat resumes the
  // transport, and the take starts on the clip's loop grid from there.
  ui.engine.countBar(1, 96000);
  await ui.settle(24);

  assert.equal(recorder.armFrame, 120000, "the take armed on the loop start the engine named");
  assert.notEqual(recorder.armFrame, 96000, "and not on the beat-0 frame the resumed launch reports");
  assert.ok(recorder.armFrame > LAST_CLICK_FRAME, "ahead of the frame the count-in's last click rang on");
  assert.ok(
    recorder.armFrame - LAST_CLICK_FRAME >= BEAT_FRAMES,
    "by at least the beat that click leads the downbeat by",
  );
  assert.ok(
    recorder.armFrame > recorder.armNow,
    `and ahead of where the page's own clock stood as it armed (${recorder.armFrame} vs ${recorder.armNow})`,
  );
  assert.equal(ui.engine.loopAsks.length, 1, "the loop start was asked for once");
  assert.equal(ui.engine.loopAsks[0].track_id, AUDIO_TRACK, "about the armed track");
  assert.equal(ui.engine.loopAsks[0].clip_id, CLIP, "and the clip the take records into");
  assert.ok(
    ui.engine.events.indexOf("count_in_done") < ui.engine.events.indexOf("nextLoopFrame"),
    "the loop start was asked for after the count-in finished",
  );
});

test("R2: a launch is queued for a paused count-in only when the record scene is another one", async () => {
  // The record scene is the one that last launched, so a paused transport that
  // is sitting on it has nothing to queue (R2).
  const same = await bootPanel({ storage: makeStorage(), clip: true });
  same.click("[data-act=play]");
  await same.settle();
  await launchReported(same);
  same.click("[data-act=pause]");
  await same.settle();
  await pressRecord(same);
  assert.deepEqual(same.engine.launched, [], "the paused scene is the record scene: no launch is queued");

  // A paused page that has no record scene of its own picks the first scene
  // holding a clip on the armed track, and queues it for the downbeat.
  const unknown = await bootPanel({ storage: makeStorage(), clip: true });
  unknown.click("[data-act=play]");
  await unknown.settle();
  unknown.click("[data-act=pause]");
  await unknown.settle();
  unknown.page.__studioTest.view.lastScene = "";
  await pressRecord(unknown);
  assert.deepEqual(unknown.engine.launched, [SCENE], "the record scene was queued for the downbeat");
});

test("R3: while playing there is no count-in and the arm frame is the engine's loop start", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75, clip: true });
  ui.click("[data-act=play]");
  await ui.settle();
  await launchReported(ui);

  ui.engine.loopFrame = 144000;
  ui.engine.looping = true;
  ui.engine.events.length = 0;
  // The page's clock stands one beat behind the frame the engine answers with, so
  // the arm has to be on a frame it has not rendered yet.
  clockAtFrame(ui, 144000 - BEAT_FRAMES);
  const recorder = await pressRecord(ui);

  assert.equal(countInPlays(ui).length, 0, "a running transport counts nothing in");
  assert.equal(ui.engine.events.indexOf("count_in_start"), -1, "and no count-in message arrives");
  assert.equal(ui.engine.loopAsks.length, 1, "the loop start was asked for once");
  assert.equal(ui.engine.loopAsks[0].clip_id, CLIP, "about the clip the take records into");
  assert.equal(recorder.armFrame, 144000, "the recorder armed on the frame the engine named");
  assert.ok(recorder.armFrame > recorder.armNow,
    `never on a frame the engine has already rendered (${recorder.armFrame} vs ${recorder.armNow})`);
  assert.ok(recorder.armFrame - recorder.armNow >= BEAT_FRAMES,
    "at least the beat the engine's own answer leads the page's clock by");
  assert.equal(recorder.splits[0], 144000 + Math.round(4 * 4 * ((48000 * 60) / 240)), "its first pass ends a loop after it");
});

test("R3: the anchor stays on the clip's loop grid after a stop, a pause and a tempo change", async () => {
  // view.launches keeps the last report a track ever made, so it says nothing
  // about where the transport is now: an anchor read from it would sit on a
  // frame the run left behind long ago. A Stop, a Pause and a tempo edit are the
  // three things that leave it behind.
  const scenarios = ["stop then play", "pause then resume", "tempo change"];
  for (const scenario of scenarios) {
    const ui = await bootPanel({ storage: makeStorage(), clock: 0.75, clip: true });
    ui.click("[data-act=play]");
    await ui.settle();
    await launchReported(ui);
    if (scenario === "stop then play") {
      ui.click("[data-act=stop]");
      await ui.settle();
      ui.click("[data-act=play]");
      await ui.settle();
    } else if (scenario === "pause then resume") {
      ui.click("[data-act=pause]");
      await ui.settle();
      ui.click("[data-act=play]");
      await ui.settle();
    }

    // A stale report, of the kind the page keeps after any of those: a frame the
    // song has long passed.
    ui.page.__studioTest.view.launches[AUDIO_TRACK] = {
      track_id: AUDIO_TRACK,
      clip_id: CLIP,
      scene_id: SCENE,
      bar: 0,
      frame: 48000,
    };
    ui.engine.loopFrame = 168000;
    ui.engine.looping = true;
    ui.engine.loopAsks.length = 0;

    const recorder = await pressRecord(ui);
    assert.equal(recorder.armFrame, 168000, `${scenario}: the anchor is the engine's loop start`);
    assert.notEqual(recorder.armFrame, 48000, `${scenario}: and never the stale report's frame`);
    assert.equal(ui.engine.loopAsks.length, 1, `${scenario}: the engine was asked, once`);
    assert.equal(ui.engine.loopAsks[0].clip_id, CLIP, `${scenario}: about the armed clip`);
  }
});

test("R3: an empty armed slot anchors on the next bar", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  ui.click("[data-act=play]");
  await ui.settle();
  await launchReported(ui);

  // The engine's own answer for a slot with no clip on it: the bar line, and
  // `looping` false.
  ui.engine.loopFrame = 48000;
  ui.engine.looping = false;
  const recorder = await pressRecord(ui);

  assert.equal(ui.engine.loopAsks.length, 1, "the anchor was asked for");
  assert.equal(ui.engine.loopAsks[0].clip_id, null, "with no clip, because the slot holds none");
  assert.equal(recorder.armFrame, 48000, "the recorder armed on the bar frame");
  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got its clip");
});

test("R3: a playing clip that is not the armed slot's clip anchors on the next bar", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75, clip: true });
  ui.click("[data-act=play]");
  await ui.settle();
  await launchReported(ui);

  // The engine says the armed clip's loop is not what plays: the bar line again.
  ui.engine.loopFrame = 72000;
  ui.engine.loopBar = 1;
  ui.engine.looping = false;
  const recorder = await pressRecord(ui);

  assert.equal(ui.engine.loopAsks[0].clip_id, CLIP, "the clip the take records into was named");
  assert.equal(recorder.armFrame, 72000, "and the answer was the bar frame it gave");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "the clip already there is recorded into, not replaced",
  );
});

test("R3 and R2: every arm is sent on a frame the engine has not rendered yet", async () => {
  const arms = [];
  for (const how of ["playing", "paused"]) {
    const ui = await bootPanel({ storage: makeStorage(), clock: 1.5, clip: true });
    ui.click("[data-act=play]");
    await ui.settle();
    await launchReported(ui);
    if (how === "paused") {
      ui.click("[data-act=pause]");
      await ui.settle();
    }
    ui.engine.loopFrame = 240000;
    ui.engine.looping = true;
    // The page's clock stands one beat behind the frame the engine answers with.
    const answeredAt = 240000 - BEAT_FRAMES;
    clockAtFrame(ui, answeredAt);
    const recorder = await pressRecord(ui);
    if (how === "paused") {
      ui.engine.countBar(1, answeredAt);
      await ui.settle(24);
    }
    assert.ok(recorder.armFrame !== null, `${how}: the take was armed`);
    assert.ok(
      recorder.armFrame > recorder.armNow,
      `${how}: the arm frame is ahead of the page's own clock (${recorder.armFrame} vs ${recorder.armNow})`,
    );
    assert.ok(
      recorder.armFrame - recorder.armNow >= BEAT_FRAMES,
      `${how}: by at least the beat the engine's answer leads it by`,
    );
    arms.push(recorder.armFrame);
  }
  assert.deepEqual(arms, [240000, 240000], "both paths armed on the frame the engine named");
});

test("R9: the anchor is the splitAt rounding of a later pass (anchor + round(k * loop))", async () => {
  const fpb = (48000 * 60) / 130;
  const ui = await bootPanel({ bpm: 130, storage: makeStorage() });
  const recorder = await pressRecord(ui);
  ui.engine.countBar(1, 96000);
  await ui.settle(24);
  assert.equal(recorder.armFrame, 96000, "the anchor is the count-in's play frame");

  const loop = 4 * 4 * fpb;
  for (let pass = 1; pass <= 10; pass += 1) {
    assert.equal(
      recorder.splits[pass - 1],
      96000 + Math.round(pass * loop),
      `pass ${pass} starts on the frame the sequencer gives that boundary`,
    );
  }
  const roundedLoop = Math.round(loop);
  let drifted = false;
  for (let pass = 1; pass <= 10; pass += 1) {
    if (96000 + pass * roundedLoop !== recorder.splits[pass - 1]) drifted = true;
  }
  assert.ok(drifted, "a rounded pass length would drift off the boundaries it should land on");
});

test("an input that fails to open during the count-in cancels it and stops the transport", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  // The arm's stream is gone (the interface was unplugged), so the input has to
  // be opened again when the take starts — and it refuses.
  ui.page.__studioTest.view.armed[AUDIO_TRACK].stream = null;
  ui.mediaDevices.failNext = true;

  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(countInPlays(ui).length, 1, "the count-in had begun");
  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled");
  assert.ok(ui.engine.stops > 0, "and the transport was stopped");
  assert.equal(ui.page.__studioTest.view.rec, null, "no take is left armed");
  assert.equal(ui.page.__studioTest.view.playing, false, "and nothing is playing");
  assert.equal(ui.document.querySelector("[data-role=rec-status]").hidden, true, "the status is gone");
  assert.equal(ui.store.pendings.size, 0, "no take row was made");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "and no clip was made for it",
  );
});

test("the rec status reads the count-in from the engine's clicks, then the take", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  await pressRecord(ui);
  const status = () => ui.document.querySelector("[data-role=rec-status]");
  assert.equal(status().textContent, "Count-in 4..3..2..1", "the beats still to come, before any click");
  assert.equal(status().getAttribute("data-recording"), "0", "nothing is being recorded yet");

  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  assert.equal(status().textContent, "Count-in 4..3..2..1", "the start alone does not move it");

  ui.engine.countIn({ type: "count_in", beat: 2, beats: 4, frame: 96000 - 2 * 12000, play_frame: 96000 });
  await ui.settle();
  assert.equal(status().textContent, "Count-in 3..2..1", "each click counts one beat off");

  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: 84000, play_frame: 96000 });
  await ui.settle(24);
  assert.equal(status().textContent, "Count-in 1", "the last beat's click is still the count-in");
  assert.equal(status().getAttribute("data-recording"), "0", "nothing is being recorded yet");

  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);
  assert.equal(status().textContent, "Recording, pass 1", "the take replaces the count-in on the downbeat");
  assert.equal(status().getAttribute("data-recording"), "1", "and says it is recording");
});

// ---- cancelling a count-in, and the transport bar while it runs (R7-R8) ----
//
// A count-in is not a take, so it can be given up: Stop ends it with the
// transport, Pause ends it and leaves the transport exactly where it stood, and
// either way there is no clip, no take row and no `view.rec` left behind. While
// it runs Pause is offered and the Record button reads pressed.

/** @param {object} ui a booted panel @returns {string} its notice text */
function noticeText(ui) {
  return String(ui.document.querySelector("[data-role=rec-notice]").textContent || "");
}

/** @param {object} ui a booted panel @returns {number} how many commands it sent */
function commandsSent(ui) {
  return ui.sent.filter((message) => typeof message.command === "string").length;
}

/**
 * A second scene in the page's song, drawn the way the hub pushes one.
 * @param {object} ui a booted panel
 * @param {string} id
 * @param {string} name
 */
async function addScene(ui, id, name) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  runCommand(ui.doc, "scene.add", { id, name });
  ui.frame({ type: "update", update: Buffer.from(encodeDocState(ui.doc)).toString("base64") });
  await ui.settle();
}

test("R7: Stop during the count-in clears view.rec, creates no clip, sends no command, shows Count-in cancelled", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  const recorder = await pressRecord(ui);
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  const commandsBefore = commandsSent(ui);

  ui.click("[data-act=stop]");
  await ui.settle(24);

  const view = ui.page.__studioTest.view;
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(ui.engine.cancels, 1, "the engine's count-in was cancelled");
  assert.ok(ui.engine.stops > 0, "and the transport was stopped");
  assert.equal(view.playing, false, "nothing is playing");
  assert.equal(recorder.armFrame, null, "nothing was ever armed");
  assert.deepEqual(recorder.splits, [], "and no pass boundary was sent");
  assert.equal(commandsSent(ui), commandsBefore, "a take that never started sends nothing to the hub");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "no clip was made for it",
  );
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.ok(
    noticeText(ui).includes("Count-in cancelled"),
    `the notice says the count-in was cancelled (got: ${noticeText(ui)})`,
  );
  assert.equal(ui.document.querySelector("[data-role=rec-status]").hidden, true, "the status is gone");
});

test("R7: Pause during the count-in from stopped leaves the engine stopped and cancels the take", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  const recorder = await pressRecord(ui);
  const view = ui.page.__studioTest.view;
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();

  ui.click("[data-act=pause]");
  await ui.settle(24);

  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled on the audio thread");
  assert.equal(ui.engine.pauses, 0, "a stopped transport has nothing to pause");
  assert.equal(ui.engine.stops, 0, "and nothing was stopped: the engine is left as it was");
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(view.playing, false, "the page says nothing is playing");
  assert.equal(view.paused, false, "and nothing is paused");
  assert.equal(recorder.armFrame, null, "nothing was ever armed");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.ok(noticeText(ui).includes("Count-in cancelled"), "the notice says so");

  // The page is where it started: a Record press counts in again.
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.equal(countInPlays(ui).length, 2, "a second Record press asks for its own count-in");
  assert.equal(ui.engine.recorders.length, 2, "with a recorder of its own");
  assert.equal(ui.engine.recorders[1].armFrame, null, "that waits for the clicks it just asked for");
});

test("R7: Pause during the count-in from paused leaves it paused at the same position", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clip: true });
  ui.click("[data-act=play]");
  await ui.settle();
  await launchReported(ui);
  ui.click("[data-act=pause]");
  await ui.settle();
  const view = ui.page.__studioTest.view;
  assert.equal(view.paused, true, "the transport stands paused where it was");

  await pressRecord(ui);
  assert.equal(view.rec.started_paused, true, "the count-in carries the paused transport on (R2)");
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();

  ui.click("[data-act=pause]");
  await ui.settle(24);

  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled");
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(view.paused, true, "the transport is still paused");
  assert.equal(view.playing, false, "and nothing is playing");
  assert.equal(ui.engine.stops, 0, "nothing was stopped");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.ok(noticeText(ui).includes("Count-in cancelled"), "the notice says so");
});

test("R7: Pause cancels a count-in with view.recTimeline.on forced true (the By-hand case)", async () => {
  // By hand (C3) forces the performance collection on for the take, and a
  // performance being collected is only ever ended with Stop. A count-in is not
  // that: the counting branch runs before the performance's own guard. The
  // toggle is off at the press, which is the only way a by-hand take starts
  // (R15 fix 4): the take is what turns the collection on.
  const ui = await bootPanel({ storage: makeStorage() });
  const view = ui.page.__studioTest.view;
  await pressRecord(ui);
  assert.equal(view.recTimeline.on, true, "the take turned the collection on for its own duration");

  ui.click("[data-act=pause]");
  await ui.settle(24);

  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled");
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(view.playing, false, "nothing is playing");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.ok(noticeText(ui).includes("Count-in cancelled"), "the notice says so");
});

test("R7: Pause is enabled in the transport bar while counting and disabled once the take runs", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  const pause = () => ui.document.querySelector("[data-act=pause]");
  assert.equal(pause().disabled, false, "Pause is offered while nothing runs");

  await pressRecord(ui);
  assert.equal(pause().disabled, false, "counting is not recording: Pause is still offered");
  assert.equal(pause().getAttribute("aria-pressed"), "false", "and the transport is not paused");

  ui.engine.countBar(1, 96000);
  await ui.settle(24);
  assert.equal(ui.engine.recorders[0].armFrame, 96000, "the take it counted in is armed");
  assert.equal(pause().disabled, true, "and Pause goes with the take");
  assert.equal(pause().getAttribute("title"), "Stop ends a recording", "the title says what ends it");
});

test("R8: Pause stays disabled while a take runs", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  ui.engine.paused = 0;
  ui.engine.pause = function () {
    ui.engine.paused += 1;
  };
  const pause = () => ui.document.querySelector("[data-act=pause]");
  assert.equal(pause().disabled, false, "Pause is offered before the take starts");

  await pressRecord(ui);
  ui.engine.countBar(1, 96000);
  await ui.settle(24);
  assert.equal(pause().disabled, true, "a running take is what takes Pause away");

  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(ui.engine.paused, 0, "pressing it leaves the engine alone");
  assert.equal(pause().disabled, true, "and Pause stays disabled");
  assert.equal(
    ui.document.querySelector("[data-role=rec-status]").getAttribute("data-recording"),
    "1",
    "the take goes on recording",
  );
});

test("R7: the page leaving during the count-in leaves no take and no clip", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  const recorder = await pressRecord(ui);
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  const view = ui.page.__studioTest.view;
  const commandsBefore = commandsSent(ui);

  ui.document.dispatchEvent(new ui.document.defaultView.Event("turbo:before-cache"));
  await ui.settle(24);

  assert.equal(view.closed, true, "the page is torn down");
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(ui.engine.cancels, 1, "the count-in went with the page");
  assert.equal(recorder.armFrame, null, "nothing was ever armed");
  assert.equal(commandsSent(ui), commandsBefore, "nothing was sent for a take that never started");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.equal(ui.timers.length, 0, "and nothing was left scheduled");
});

test("a recorder error during the count-in cancels it and leaves no take row", async () => {
  // The interface went away between the click and the recorder being built: the
  // count-in it began cannot lead to a take, so it goes with the recorder.
  const ui = await bootPanel({ storage: makeStorage() });
  ui.engine.createRecorder = async () => {
    throw new Error("The input went away.");
  };
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  const view = ui.page.__studioTest.view;
  assert.equal(countInPlays(ui).length, 1, "the count-in had begun");
  assert.equal(ui.engine.cancels, 1, "and it was cancelled with the input");
  assert.ok(ui.engine.stops > 0, "the transport was stopped too");
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(view.playing, false, "and nothing is playing");
  assert.equal(ui.store.pendings.size, 0, "no take row was made");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "and no clip was made for it",
  );
});

// ---- a scene tapped during the count-in, and a Play that does nothing (R18, R19)

test("R18: a scene tap during the count-in sends launchScene and no play, and the launch applies at playFrame", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  await addScene(ui, "chorus", "Chorus");
  const recorder = await pressRecord(ui);
  assert.equal(ui.engine.plays, 1, "the count-in is what started the engine");
  assert.deepEqual(ui.engine.launched, [SCENE], "the record scene's launch is queued for the downbeat");

  // The operator taps another scene while the clicks run: it queues for the
  // downbeat and nothing else — a play from the page would reach a counting
  // engine.
  ui.click("[data-scene-id=chorus] [data-act=launch-scene]");
  await ui.settle(24);

  assert.equal(ui.engine.plays, 1, "the tap asked for no play");
  assert.deepEqual(ui.engine.launched, [SCENE, "chorus"], "the tapped scene was launched for the downbeat");
  assert.equal(ui.page.__studioTest.view.rec.scene_id, "chorus", "the take now records into that slot");

  // The engine starts on the announced frame, which is the only thing the take
  // is armed on.
  ui.engine.countBar(1, 96000);
  await ui.settle(24);
  assert.equal(recorder.armFrame, 96000, "the take armed on the frame the count-in announced");
  assert.equal(ui.engine.plays, 1, "and the engine was started once, by the count-in");
});

test("R18: a scene tapped during the count-in sets the take's clip when it changes the armed slot before the final-beat arm", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  await addScene(ui, "chorus", "Chorus");
  const recorder = await pressRecord(ui);
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();

  ui.click("[data-scene-id=chorus] [data-act=launch-scene]");
  await ui.settle();
  assert.equal(recorder.armFrame, null, "nothing is armed before the last click");

  // The last beat's click is a beat ahead of the downbeat: the take's clip is
  // chosen there, from the slot the tap named, and written on the downbeat.
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: 84000, play_frame: 96000 });
  await ui.settle(24);

  assert.equal(recorder.armFrame, 96000, "the take armed on the count-in's frame");
  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);
  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty tapped slot got one audio clip");
  assert.equal(added[0].args.scene_id, "chorus", "in the scene the tap named");
});

test("R19: the Play button during the count-in does nothing", async () => {
  const ui = await bootPanel({ storage: makeStorage() });
  const recorder = await pressRecord(ui);
  const view = ui.page.__studioTest.view;
  assert.equal(ui.engine.plays, 1, "the count-in asked for the transport once");
  assert.equal(view.rec.counting, true, "and the clicks are running");

  ui.click("[data-act=play]");
  await ui.settle(24);

  assert.equal(ui.engine.plays, 1, "Play reached no engine");
  assert.equal(view.rec.counting, true, "the count-in is neither restarted nor cut short");
  assert.equal(recorder.armFrame, null, "and nothing was armed by it");
});

// ---- a punch, from the arm to the comp write (R11-R13) ---------------------
//
// A punch is a stretch of the clip a take records into, in CLIP beats: the gate
// is open only inside it on every pass, and when the take lands it replaces the
// comp over that stretch. The range is this device's view state; what it writes
// goes to the song through clip.set_comp, one step for the whole recording.
//
// The fixture is a one-bar clip (four beats) at 240 BPM and 48 kHz, so a pass is
// 48,000 frames, a beat is 12,000, and a take cut by the calibrated 3,408-frame
// round trip carries that offset.

/** The take the fixture clip's comp already holds. */
const T_OLD = "6f1c1f7a-0000-4000-8000-000000000001";

/** A second audio clip on the recording track, in a scene of its own. */
const CLIP_B = "c-guitar-b";

/** A second take the fixture clip may hold: what a comp drag can be given. */
const T_OTHER = "6f1c1f7a-0000-4000-8000-000000000005";

/** The page clock the take's own pass 0 stands in: 52,800 frames, inside the pass
 * that begins on 48,000 (48,000 + the 3,408-frame round trip is its first frame).
 */
const PASS0_CLOCK = 1.1;

/** The frame one pass of the fixture take begins on. */
function passFrame(pass) {
  return ARM_FRAME + Math.round(pass * PASS_FRAMES) + ROUND_TRIP_FRAMES;
}

/**
 * The one run the page is holding for a recording.
 * @param {object} ui a booted panel
 * @returns {object} the run
 */
function onlyRun(ui) {
  const runs = Object.values(viewOf(ui).punchRuns);
  assert.equal(runs.length, 1, `one run is open (got ${runs.length})`);
  return runs[0];
}

/**
 * The passes a run has landed, in pass order.
 * @param {object} run
 * @returns {object[]}
 */
function landedPasses(run) {
  return Object.values(run.landed).sort((a, b) => Number(a.pass) - Number(b.pass));
}

/**
 * The pass one run has booked, or null.
 * @param {object} run
 * @param {number} pass
 * @returns {object|null} `{take_id, pass, from, to}`
 */
function bookedAt(run, pass) {
  for (const [takeId, entry] of Object.entries(run.booked)) {
    if (Number(entry.pass) === Number(pass)) return { take_id: takeId, ...entry };
  }
  return null;
}

/**
 * The takes a comp write put into the comp, other than the one the clip already
 * held.
 * @param {object[]} segments
 * @returns {string[]}
 */
function compTakeIds(segments) {
  const ids = new Set();
  for (const segment of segments) {
    if (String(segment.take_id) === T_OLD) continue;
    ids.add(String(segment.take_id));
  }
  return Array.from(ids);
}

/**
 * The song's own side of a comp write: the takes it names are in the song (the
 * gateway's `take.add` after an upload), and then `clip.set_comp` is applied.
 * @param {object} ui a booted panel
 * @param {object[]} segments the write's own segments
 */
async function landInDoc(ui, segments) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const takes = snapshot(ui.doc).takes || {};
  for (const takeId of compTakeIds(segments)) {
    if (takes[takeId]) continue;
    runCommand(ui.doc, "take.add", {
      clip_id: CLIP,
      take: {
        id: takeId,
        storage_key: "projects/31/studio/song-1/takes/" + takeId + ".wav",
        rate: 48000,
        channels: 2,
        frames: PASS_FRAMES,
        offset_frames: 0,
        compensated: false,
        bpm: 240,
        recorded_at: new Date(Date.UTC(2026, 0, 1, 10)).toISOString(),
        author_label: "You",
        discarded: false,
      },
    });
  }
  runCommand(ui.doc, "clip.set_comp", { clip_id: CLIP, segments });
  await ui.pushState();
}

/** A pass of the fixture clip: one bar of four beats at 240 BPM, 48 kHz. */
const PASS_FRAMES = 48000;

/** One beat at that tempo and rate. */
const BEAT_FRAMES = 12000;

/** The round trip the calibrated fixture input measures. */
const ROUND_TRIP_FRAMES = 3408;

/** The frame the launch report names: where the take begins (R9). */
const ARM_FRAME = 48000;

/** One whole pass as 24-bit stereo: what a pass's chunk holds. */
const PASS_CHUNK = new Uint8Array(PASS_FRAMES * 3 * 2).buffer;

/** @returns {object[]} every clip.set_comp the page sent, in order */
function setCompCommands(ui) {
  return ui.sent.filter((message) => message.type === "command" && message.command === "clip.set_comp");
}

/** @returns {object} the page's own view state */
function viewOf(ui) {
  return ui.page.__studioTest.view;
}

/**
 * The comp a clip holds in the song's own document.
 * @param {object} ui a booted panel
 * @param {string} [clipId]
 * @returns {object[]}
 */
async function docComp(ui, clipId = CLIP) {
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const clip = snapshot(ui.doc).clips[clipId];
  return clip && Array.isArray(clip.comp) ? clip.comp : [];
}

/**
 * Arm the audio track (unless a case already has), set the punch range (or none)
 * and press Record.
 * @param {object} ui a booted panel
 * @param {number|null} from the range's first clip beat, or null for no punch
 * @param {number} [to] the range's end beat
 * @param {{armed?: boolean}} [options] `armed` for a second take on a track that
 *   is still armed (the arm button is a toggle)
 * @returns {Promise<object>} the recorder the page built
 */
async function recordWithPunch(ui, from, to, options = {}) {
  if (options.armed !== true) {
    ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
    await ui.settle();
  }
  if (from !== null) {
    assert.equal(ui.page.__studioTest.setPunch(from, to), true, `a range of ${from} to ${to} fits the clip`);
    await ui.settle();
  }
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder for the armed track");
  return recorder;
}

/**
 * Report the launch that starts the take, the way the engine does.
 * @param {object} ui a booted panel
 * @param {number} [frame]
 */
async function reportLaunch(ui, frame = ARM_FRAME) {
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: frame }),
  );
  await ui.settle();
}

/**
 * Hand the recorder the first chunk of one pass: a whole pass of 24-bit stereo.
 * @param {object} ui a booted panel
 * @param {object} recorder
 * @param {number} pass
 */
async function chunkPass(ui, recorder, pass) {
  recorder.chunk(PASS_CHUNK, 0, pass);
  await ui.settle(10);
}

/**
 * End the take, one whole pass per segment.
 * @param {object} ui a booted panel
 * @param {object} recorder
 * @param {number} passes
 */
async function endTake(ui, recorder, passes) {
  const segments = [];
  for (let at = 0; at < passes; at += 1) {
    segments.push({ segment: at, start_frame: ARM_FRAME + at * PASS_FRAMES, frames: PASS_FRAMES });
  }
  recorder.done({ segments, frames: passes * PASS_FRAMES, start_frame: ARM_FRAME });
  await ui.settle(30);
}

test("R11: a range inside the clip sends one gatePeriodic whose per-pass frames equal passGateRanges (offset added), gated zeros outside, and takes of the full pass length", async () => {
  // The take routes refuse, so each pass's row stays on this device where its
  // frames can be read: a punch shortens no pass (the recorder counts a gated
  // frame, so every pass is whole).
  const ui = await bootPanel({
    clip: true,
    lengthBars: 1,
    takes: [{ id: T_OLD }],
    latency: CALIBRATED,
    respond: (url) =>
      String(url).includes("/api/studio/takes")
        ? { status: 503, body: { error: "Studio cannot take recordings on this instance." } }
        : null,
  });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);

  assert.equal(recorder.gates.length, 1, "one gate message serves every pass of the take");
  assert.equal(recorder.gatedOff, 0, "and nothing turns it off again");
  const gate = recorder.gates[0];
  assert.equal(gate.anchorFrame, ARM_FRAME, "the gate is anchored on the take's own anchor");
  assert.equal(gate.loopFrames, PASS_FRAMES, "one pass long");
  assert.equal(gate.fromFrames, 1 * BEAT_FRAMES, "it opens on the range's first beat");
  assert.equal(gate.toFrames, 3 * BEAT_FRAMES, "and closes on its end");
  assert.equal(gate.offsetFrames, ROUND_TRIP_FRAMES, "moved by the input delay the take is cut by");
  assert.equal("activeFrom" in gate, false, "the pass it starts in is the first one it covers");

  // Every pass's range is the one punch.js gives for that pass: the pass start on
  // the split grid plus the range in frames plus the delay, rounded once.
  for (let pass = 0; pass < 3; pass += 1) {
    const expected = passGateRanges({
      anchorFrame: ARM_FRAME,
      fpb: BEAT_FRAMES,
      loopBeats: 4,
      passIndex: pass,
      from: 1,
      to: 3,
      offsetFrames: ROUND_TRIP_FRAMES,
    });
    const start = ARM_FRAME + Math.round(pass * gate.loopFrames) + gate.offsetFrames;
    assert.equal(start + gate.fromFrames, expected[0], `pass ${pass} opens on the range's first beat`);
    assert.equal(start + gate.toFrames, expected[1], `pass ${pass} closes on its end`);
    // The gate's own pass start is the frame the take is split on.
    assert.equal(recorder.splits[pass], ARM_FRAME + Math.round((pass + 1) * PASS_FRAMES) + ROUND_TRIP_FRAMES,
      `pass ${pass + 1} starts where the gate's own pass ends`);
  }

  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  const rows = Array.from(ui.store.pendings.values());
  assert.equal(rows.length, 1, "the gated pass is a take of its own, kept on this device");
  assert.equal(rows[0].frames, PASS_FRAMES, "a whole pass long: the gate silences frames, it never drops them");
  assert.equal(rows[0].chunk_count, 1, "with the one chunk the pass was recorded in");
  assert.equal(setCompCommands(ui).length, 0, "a take this device still owes writes no comp yet");
});

test("R11: the same clip-beat range applies on pass 0, 1 and 2, and the recording writes ONE comp when it ends", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  const gate = recorder.gates[0];
  assert.ok(gate, "the punch sent its gate");

  const opens = [];
  const closes = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const start = ARM_FRAME + Math.round(pass * gate.loopFrames) + gate.offsetFrames;
    opens.push(start + gate.fromFrames);
    closes.push(start + gate.toFrames);
  }
  assert.deepEqual(opens, [
    ARM_FRAME + ROUND_TRIP_FRAMES + BEAT_FRAMES,
    ARM_FRAME + PASS_FRAMES + ROUND_TRIP_FRAMES + BEAT_FRAMES,
    ARM_FRAME + 2 * PASS_FRAMES + ROUND_TRIP_FRAMES + BEAT_FRAMES,
  ], "the range opens on the same beat of every pass");
  assert.deepEqual(closes, [
    opens[0] + 2 * BEAT_FRAMES,
    opens[1] + 2 * BEAT_FRAMES,
    opens[2] + 2 * BEAT_FRAMES,
  ], "and closes two beats later each time");
  for (let pass = 1; pass < 3; pass += 1) {
    assert.equal(opens[pass] - opens[pass - 1], PASS_FRAMES, `pass ${pass} opens one pass later`);
    assert.equal(closes[pass] - closes[pass - 1], PASS_FRAMES, `pass ${pass} closes one pass later`);
  }

  // Every pass records and uploads, and no pass sends a gate of its own.
  await chunkPass(ui, recorder, 0);
  await chunkPass(ui, recorder, 1);
  assert.equal(finishCount(ui), 1, "the first pass uploads as it ends");
  await ui.settle();
  assert.equal(viewOf(ui).rec.active, true, "the take is still running");
  assert.equal(setCompCommands(ui).length, 0, "and the comp is not written while it is");
  const run = onlyRun(ui);
  assert.deepEqual(landedPasses(run).map((pass) => pass.pass), [0], "the first pass has landed in its run");

  await chunkPass(ui, recorder, 2);
  assert.equal(finishCount(ui), 2, "the second pass uploads as it ends");
  await endTake(ui, recorder, 3);
  assert.equal(finishCount(ui), 3, "and the last one as the take ends");

  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `the whole recording writes one comp (got ${sent.length})`);
  assert.equal(recorder.gates.length, 1, "still one gate: the range is periodic, not re-sent per pass");
  assert.equal(sent[0].args.clip_id, CLIP, "against the clip the take recorded into");
  const last = sent[0].args.segments.find((segment) => segment.take_id !== T_OLD);
  assert.ok(last, "the comp names a punched take");
  assert.deepEqual(sent[0].args.segments, spliceComp(
    [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }], last.take_id, 1, 3, 4,
  ), "one splice over the range, its latest pass owning it");
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and the run is done once the hub has taken the write");
});

test("R12: a range outside a shortened clip arms nothing, creates no pending row and says so", async () => {
  const ui = await bootPanel({ clip: true, takes: [{ id: T_OLD }], latency: CALIBRATED });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  // A range set against a four-bar clip...
  assert.equal(ui.page.__studioTest.setPunch(4, 6), true, "the range fits the clip as it stands");
  await ui.settle();
  // ...and the clip is shortened under it, the way another view can. The range is
  // refused at the Record click, so nothing is started and nothing is written
  // (O8/S2); the arm is the backstop for a clip that changes while the clicks run.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.set_length", { clip_id: CLIP, length_bars: 1 });
  await ui.pushState();
  assert.deepEqual(viewOf(ui).punch, { from: 4, to: 6 }, "the page still holds the range it was given");

  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(viewOf(ui).rec, null, "nothing is armed");
  assert.equal(ui.engine.recorders.length, 0, "no recorder was built for it");
  assert.equal(ui.engine.plays, 0, "and the transport was never started");
  assert.deepEqual(ui.engine.launched, [], "nor was a scene queued for a downbeat");
  assert.equal(ui.store.pendings.size, 0, "no pending row exists for it");
  assert.equal(ui.sent.filter((message) => message.command === "clip.add_audio").length, 0,
    "and no clip was written");
  assert.equal(setCompCommands(ui).length, 0, "no comp either");
  assert.ok(
    noticeText(ui).includes("The punch range is outside this clip."),
    `the page says so (got: ${noticeText(ui)})`,
  );
});

test("O2/S5: a range changed in pass 0 leaves pass 0 as it began and gives pass 1 the new one", async () => {
  // The page's clock stands inside pass 0, so the pass that is already running
  // keeps the range it started with and the new one takes over on the next pass.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED, clock: PASS0_CLOCK });
  const recorder = await recordWithPunch(ui, 0, 1);
  await reportLaunch(ui);
  assert.equal(recorder.gates.length, 1, "the range the take was armed with reached the recorder");
  assert.equal("activeFrom" in recorder.gates[0], false, "covering the take from its first pass");

  assert.equal(ui.page.__studioTest.setPunch(2, 3), true, "the operator sets another range while pass 0 runs");
  await ui.settle();

  assert.deepEqual(viewOf(ui).rec.punch_plan, [
    { from_pass: 0, from: 0, to: 1 },
    { from_pass: 1, from: 2, to: 3 },
  ], "the plan keeps pass 0's range and adds the new one from pass 1 on");
  assert.equal(viewOf(ui).punchNext, true, "the pass already armed keeps the gate it started with");
  assert.equal(recorder.gates.length, 2, "the recorder is handed the new range once");
  const gate = recorder.gates[1];
  assert.equal(gate.anchorFrame, ARM_FRAME, "on the take's own anchor");
  assert.equal(gate.loopFrames, PASS_FRAMES, "and the same periodic pass");
  assert.equal(gate.fromFrames, 2 * BEAT_FRAMES, "opening on the new range's first beat");
  assert.equal(gate.toFrames, 3 * BEAT_FRAMES, "and closing on its end");
  assert.equal(gate.activeFrom, passFrame(1), "it takes over at the first frame of the next pass");

  // Pass 0's first chunk arrives AFTER the change, the way a real take's does:
  // its range comes from the plan, by its own pass index.
  await chunkPass(ui, recorder, 0);
  const run = onlyRun(ui);
  const first = bookedAt(run, 0);
  assert.deepEqual({ from: first.from, to: first.to }, { from: 0, to: 1 },
    "pass 0 is booked with the range it began with");
  await chunkPass(ui, recorder, 1);
  const second = bookedAt(run, 1);
  assert.deepEqual({ from: second.from, to: second.to }, { from: 2, to: 3 },
    "and pass 1 is booked with the new one");

  await endTake(ui, recorder, 2);
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `the recording writes one comp (got ${sent.length})`);
  const before = [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }];
  assert.deepEqual(sent[0].args.segments, spliceComp(spliceComp(before, first.take_id, 0, 1, 4), second.take_id, 2, 3, 4),
    "each pass over its own range, pass 0's first");
});

test("O2/S5: a range set before the take began covers pass 0 and replaces the plan", async () => {
  // Nothing of the take has been captured yet on the page's clock, so the range
  // is the whole take's, from its first pass.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 0, 1);
  await reportLaunch(ui);
  assert.equal(ui.page.__studioTest.setPunch(2, 3), true, "another range, before a frame of the take is here");
  await ui.settle();

  assert.deepEqual(viewOf(ui).rec.punch_plan, [{ from_pass: 0, from: 2, to: 3 }],
    "the plan is the new range, from the first pass");
  assert.equal(viewOf(ui).punchNext, false, "nothing waits for a later pass");
  assert.equal(recorder.gates.length, 2, "the recorder is handed it");
  assert.equal("activeFrom" in recorder.gates[1], false, "from the take's own first frame");

  await chunkPass(ui, recorder, 0);
  const run = onlyRun(ui);
  assert.deepEqual({ from: bookedAt(run, 0).from, to: bookedAt(run, 0).to }, { from: 2, to: 3 },
    "pass 0 is booked with the range set before it began");
  await endTake(ui, recorder, 1);
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "and the recording writes it once");
  assert.deepEqual(sent[0].args.segments, spliceComp(
    [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }], sent[0].args.segments[1].take_id, 2, 3, 4,
  ), "over the range the plan gave");
});

test("F1: a range that can only reach the pass after next drops the skipped pass's plan entry", async () => {
  // Two range changes inside pass 0. The first books pass 1. The second arrives
  // inside the lead the engine needs to arm a recorder, so it can only reach pass
  // 2 — and the gate it arms for pass 2 overwrites the one waiting for pass 1. The
  // recorder judges pass 1 by the range it still holds ([0,1)), so pass 1's own
  // [2,3) entry goes: it is booked with the range its audio was recorded by, never
  // with beats it never played.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED, clock: PASS0_CLOCK });
  const recorder = await recordWithPunch(ui, 0, 1);
  await reportLaunch(ui);
  assert.equal(ui.page.__studioTest.setPunch(2, 3), true, "a second range, set while pass 0 runs");
  await ui.settle();
  assert.deepEqual(viewOf(ui).rec.punch_plan, [
    { from_pass: 0, from: 0, to: 1 },
    { from_pass: 1, from: 2, to: 3 },
  ], "which books pass 1");

  // The third range arrives with less than the arming lead to pass 1: it books
  // pass 2, and pass 1 falls back to the range the recorder's own slot holds.
  clockAtFrame(ui, passFrame(1) - 4000);
  assert.equal(ui.page.__studioTest.setPunch(3, 4), true, "a third, inside the lead to pass 1");
  await ui.settle();

  const plan = viewOf(ui).rec.punch_plan;
  assert.deepEqual(plan, [
    { from_pass: 0, from: 0, to: 1 },
    { from_pass: 2, from: 3, to: 4 },
  ], "pass 1's entry goes with the gate that was overwritten");
  assert.equal(plan.some((entry) => Number(entry.from_pass) === 1), false,
    "no plan entry books pass 1 a range of its own");
  assert.equal(recorder.gates.length, 3, "the recorder is handed the third range");
  assert.equal(recorder.gates[2].activeFrom, passFrame(2), "from pass 2's own first frame");

  await chunkPass(ui, recorder, 0);
  const run = onlyRun(ui);
  const first = bookedAt(run, 0);
  assert.deepEqual({ from: first.from, to: first.to }, { from: 0, to: 1 },
    "pass 0 keeps the range it began with");
  await chunkPass(ui, recorder, 1);
  const second = bookedAt(run, 1);
  assert.ok(second, "pass 1 is booked");
  assert.deepEqual({ from: second.from, to: second.to }, { from: 0, to: 1 },
    "with the range the recorder judged it by, never the one it could not hear");
  await chunkPass(ui, recorder, 2);
  const third = bookedAt(run, 2);
  assert.ok(third, "pass 2 is booked");
  assert.deepEqual({ from: third.from, to: third.to }, { from: 3, to: 4 }, "with the third range");

  await endTake(ui, recorder, 3);
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `the recording writes one comp (got ${sent.length})`);
  assert.deepEqual(sent[0].args.segments, [
    { take_id: second.take_id, from_beat: 0, to_beat: 1 },
    { take_id: T_OLD, from_beat: 1, to_beat: 3 },
    { take_id: third.take_id, from_beat: 3, to_beat: 4 },
  ], "each pass over the beats its own take holds audio for");
});

test("R12: a punch on a clip with no comp records the take whole, sends no gate and no set_comp, and shows the no-take-to-punch-into notice", async () => {
  // Nothing to punch into: a clip whose comp is empty. Its first take becomes the
  // whole-clip comp when it lands, and that comp is left alone.
  const ui = await bootPanel({ clip: true, lengthBars: 1, latency: CALIBRATED });
  assert.deepEqual(await docComp(ui), [], "the clip holds no comp");
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(ui.page.__studioTest.setPunch(1, 3), true, "the range itself fits the clip");
  await ui.settle();

  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  await reportLaunch(ui);

  assert.equal(viewOf(ui).rec.active, true, "the take records");
  assert.equal(viewOf(ui).rec.punch, null, "with no punch");
  assert.deepEqual(recorder.gates, [], "no gate was sent");
  assert.ok(noticeText(ui).includes("No take to punch into yet; recording the whole clip."),
    `the notice says the take records whole (got: ${noticeText(ui)})`);

  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  assert.equal(finishCount(ui), 1, "the take landed");
  assert.equal(setCompCommands(ui).length, 0, "and no comp write follows it");
  assert.deepEqual(viewOf(ui).punchRuns, {}, "nothing is waiting to be written");
});

test("O3: passes landing across a running take make ONE set_comp at the end, and the latest pass wins where they overlap", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED, clock: PASS0_CLOCK });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  // A second range while pass 0 runs: its passes overlap beats 2 and 3.
  assert.equal(ui.page.__studioTest.setPunch(2, 4), true, "a wider range, set while pass 0 runs");
  await ui.settle();

  await chunkPass(ui, recorder, 0);
  const run = onlyRun(ui);
  const first = bookedAt(run, 0);
  assert.deepEqual({ from: first.from, to: first.to }, { from: 1, to: 3 }, "pass 0 keeps the range it began with");
  await chunkPass(ui, recorder, 1);
  const second = bookedAt(run, 1);
  assert.deepEqual({ from: second.from, to: second.to }, { from: 2, to: 4 }, "pass 1 records the new one");

  // The first pass has landed while the take still runs, and nothing is written.
  await ui.settle();
  assert.equal(viewOf(ui).rec.active, true, "the take is still running");
  assert.deepEqual(landedPasses(run).map((pass) => pass.pass), [0], "its first pass has landed");
  assert.equal(setCompCommands(ui).length, 0, "and no comp is written while it is");

  // Stop: the last pass lands and the whole recording is written, once.
  await endTake(ui, recorder, 2);
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `one comp write for the whole recording (got ${sent.length})`);
  assert.deepEqual(sent[0].args.segments, [
    { take_id: T_OLD, from_beat: 0, to_beat: 1 },
    { take_id: first.take_id, from_beat: 1, to_beat: 2 },
    { take_id: second.take_id, from_beat: 2, to_beat: 4 },
  ], "each pass over its own range, the later one owning the beats both cover");
  assert.notEqual(second.take_id, first.take_id, "which is not the earlier pass's take");
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and the run is done once the hub has taken the write");
});

test("O1: a second punched recording on the same clip is comped too", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const first = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, first, 0);
  await endTake(ui, first, 1);
  let sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "the first recording writes its comp");
  // The song takes the write and the take it names, the way the hub does.
  await landInDoc(ui, sent[0].args.segments);
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and its run is done");

  // A SECOND recording on the same clip: its own number, its own run, and a comp
  // write of its own once it lands.
  const second = await recordWithPunch(ui, 1, 3, { armed: true });
  await reportLaunch(ui);
  await chunkPass(ui, second, 0);
  await endTake(ui, second, 1);
  sent = setCompCommands(ui);
  assert.equal(sent.length, 2, `the second recording is comped too (got ${sent.length})`);
  const before = await docComp(ui);
  const landed = sent[1].args.segments.find((segment) => segment.from_beat === 1 && segment.to_beat === 3);
  assert.ok(landed, "the second write puts its own take over the range");
  assert.deepEqual(sent[1].args.segments, spliceComp(before, landed.take_id, 1, 3, 4),
    "over the comp the first recording's write left");
});

test("O4/S4: a range for another clip gates nothing and books nothing, mid-take or at the arm", async () => {
  // Clip B is a second audio clip on the same track, in a scene of its own, with
  // a comp of its own: the range below is stored for clip A.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "scene.add", { id: "chorus", name: "Chorus" });
  runCommand(ui.doc, "clip.add_audio", {
    clip_id: CLIP_B,
    track_id: AUDIO_TRACK,
    scene_id: "chorus",
    length_bars: 1,
    name: "Guitar B",
  });
  await ui.pushState();

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(ui.page.__studioTest.setPunch(1, 3), true, "a range for the clip the record target holds");
  await ui.settle();
  assert.equal(viewOf(ui).punchClip, CLIP, "which is clip A");

  // Record: the launch names scene B, so the take records into clip B.
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: "chorus", bar: 0, frame: ARM_FRAME }),
  );
  await ui.settle();
  assert.equal(viewOf(ui).rec.clip_id, CLIP_B, "the take records into clip B");
  assert.deepEqual(recorder.gates, [], "the range set for clip A is not clip B's, so nothing is gated");
  assert.equal(viewOf(ui).rec.punch, null, "and the take records whole");
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "no comp write follows a take that was not punched");
});

test("O4/S4: a mid-take range for a clip the take is not recording into is stored, with no gate and nothing waiting", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED, clock: PASS0_CLOCK });
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "scene.add", { id: "chorus", name: "Chorus" });
  runCommand(ui.doc, "clip.add_audio", {
    clip_id: CLIP_B,
    track_id: AUDIO_TRACK,
    scene_id: "chorus",
    length_bars: 1,
    name: "Guitar B",
  });
  await ui.pushState();

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: "chorus", bar: 0, frame: ARM_FRAME }),
  );
  await ui.settle();
  assert.equal(viewOf(ui).rec.clip_id, CLIP_B, "the take records into clip B");

  // Clip B goes, the way another view can remove it: the page now reads the
  // record target's own clip (A) as the clip a range would be for.
  runCommand(ui.doc, "clip.remove", { clip_id: CLIP_B });
  await ui.pushState();
  assert.equal(ui.page.__studioTest.setPunch(2, 3), true, "a range for the clip the page now reads");
  await ui.settle();

  assert.equal(viewOf(ui).punchClip, CLIP, "stored for clip A");
  assert.deepEqual(viewOf(ui).punch, { from: 2, to: 3 }, "and the page holds it");
  assert.equal(viewOf(ui).punchNext, false, "nothing is waiting for a later pass");
  assert.equal(recorder.gates.length, 0, "the take recording into clip B is handed no gate");
  assert.equal(noticeText(ui).includes("applies from the next pass"), false,
    "and the page promises no pass");
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "nor does any comp write follow");
});

/**
 * One comp drag on the takes widget's comp bar, the way the operator does it: a
 * take row is clicked (it is the take the range is assigned to), then the
 * pointer goes down on the bar and up again beside it.
 * @param {object} ui a booted panel
 * @param {string} takeId the take the range is assigned to
 * @param {number} fromBeat the range's first clip beat
 * @param {number} toBeat its last
 */
async function dragComp(ui, takeId, fromBeat, toBeat) {
  ui.click(`[data-role=take][data-take-id=${takeId}]`);
  await ui.settle();
  const bar = ui.document.querySelector("[data-role=comp-bar]");
  assert.ok(bar, "the takes widget draws the clip's comp bar");
  bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 12, right: 400, bottom: 12 });
  const at = (beat) => Math.round((Number(beat) / 4) * 400);
  bar.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: at(fromBeat) }));
  ui.fireWindow("pointermove", ui.event("pointermove", { clientX: at(toBeat) }));
  ui.fireWindow("pointerup", ui.event("pointerup", { clientX: at(toBeat) }));
  await ui.settle();
}

test("O5: a comp drag's write waits for a punch write on the wire, and the punch write waits for a drag's", async () => {
  // The punch write first: its answer is held back, and a drag is released while
  // it is still out.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }, { id: T_OTHER }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  let sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "the recording's one comp write is on the wire");
  const punchSegments = sent[0].args.segments;

  // The song holds it, and the operator drags a comp while its answer is owed.
  await landInDoc(ui, punchSegments);
  const beforeDrag = await docComp(ui);
  await dragComp(ui, T_OTHER, 0, 2);
  assert.equal(setCompCommands(ui).length, 1, "the drag's write waits for the answer to the punch's");

  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  sent = setCompCommands(ui);
  assert.equal(sent.length, 2, "and goes out once that answer is here");
  assert.deepEqual(sent[1].args.segments, spliceComp(beforeDrag, T_OTHER, 0, 2, 4),
    "computed from the snapshot that holds the punch's write");

  // The other way round: a drag's write is out, and a punched pass lands behind
  // it.
  const other = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }, { id: T_OTHER }], latency: CALIBRATED });
  other.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await other.settle();
  await dragComp(other, T_OTHER, 1, 3);
  let dragSent = setCompCommands(other);
  assert.equal(dragSent.length, 1, "the drag's write went out");
  await landInDoc(other, dragSent[0].args.segments);
  const beforePunch = await docComp(other);

  const planned = await recordWithPunch(other, 1, 3, { armed: true });
  await reportLaunch(other);
  await chunkPass(other, planned, 0);
  await endTake(other, planned, 1);
  assert.equal(setCompCommands(other).length, 1, "the punch's write waits for the drag's answer");

  other.frame({ type: "result", cmd_id: dragSent[0].cmd_id, ok: true });
  await other.settle();
  const both = setCompCommands(other);
  assert.equal(both.length, 2, "and goes out once the drag's is answered");
  const landed = both[1].args.segments.find((segment) => segment.from_beat === 1 && segment.to_beat === 3);
  assert.ok(landed, "the punch put its pass over the range");
  assert.deepEqual(both[1].args.segments, spliceComp(beforePunch, landed.take_id, 1, 3, 4),
    "computed from the snapshot that holds the drag's write");
});

test("F3: an error frame for a comp write lets go of the clip's queue", async () => {
  // A command the hub answers with an error frame instead of a result: the write
  // will never be answered otherwise, and every later write for the clip is
  // chained behind it — the operator's own comp drag included.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }, { id: T_OTHER }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "the recording's comp write is on the wire");
  assert.ok(viewOf(ui).awaiting[sent[0].cmd_id], "and the page is waiting for its answer");

  ui.frame({ type: "error", cmd_id: sent[0].cmd_id, error: "storage refused" });
  await ui.settle();

  assert.deepEqual(viewOf(ui).awaiting, {}, "the wait is let go by the error frame");
  assert.ok(toastText(ui).includes("storage refused"), `the page says what went wrong (got: ${toastText(ui)})`);

  await dragComp(ui, T_OTHER, 0, 2);
  assert.equal(setCompCommands(ui).length, 2, "and the operator's own comp drag reaches the wire");
});

test("F3: a comp write the hub never answers is let go at its own timeout, so the clip is not wedged", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }, { id: T_OTHER }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 1, "the recording's comp write is on the wire");
  assert.equal(Object.keys(viewOf(ui).awaiting).length, 1, "with no answer for it");

  // The page's own timers run: the wait's own timeout is one of them.
  for (const fn of ui.timers.splice(0)) fn();
  await ui.settle();

  assert.deepEqual(viewOf(ui).awaiting, {}, "the wait is let go at its timeout");

  await dragComp(ui, T_OTHER, 0, 2);
  assert.equal(setCompCommands(ui).length, 2, "so the next comp drag goes out");
});

test("O6: a pass that lands while the socket is down is written once the page is back on it", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, recorder, 0);

  // The socket goes before the pass lands, and the take ends behind it.
  await ui.dropSocket();
  assert.equal(viewOf(ui).joined, false, "the page is off the wire");
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "the comp write had nowhere to go");
  assert.equal(Object.values(viewOf(ui).punchRuns).length, 1, "the run is kept, waiting for the page to be back");

  // The page comes back on the wire with its document rebuilt.
  await ui.rejoin();
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `the comp is written once the page is back (got ${sent.length})`);
  const landed = sent[0].args.segments.find((segment) => segment.take_id !== T_OLD);
  assert.ok(landed, "the write puts the pass over its range");
  assert.deepEqual([landed.from_beat, landed.to_beat], [1, 3], "the range it was recorded with");
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and the run is done once the hub has taken the write");
});

test("O7/S6: cancelling a second recording during its count-in leaves the first recording's comp write owed", async () => {
  // The take routes are held open, so the first recording's passes are on their
  // way when the second recording starts and is cancelled.
  const ui = await bootPanel({
    clip: true,
    lengthBars: 1,
    takes: [{ id: T_OLD }],
    latency: CALIBRATED,
    countIn: 1,
    gateFinish: true,
  });
  const recorder = await recordWithPunch(ui, 1, 3);
  ui.engine.countBar(1, 96000, 12000);
  await ui.settle(24);
  assert.equal(recorder.armFrame, 96000, "the take began on the count-in's frame");

  await chunkPass(ui, recorder, 0);
  await chunkPass(ui, recorder, 1);
  await endTake(ui, recorder, 2);
  assert.equal(setCompCommands(ui).length, 0, "the take is over and its passes are still landing");
  const runs = Object.values(viewOf(ui).punchRuns);
  assert.equal(runs.length, 1, "its run is waiting for them");
  assert.equal(runs[0].ended, true, "with the take itself ended");

  // A second recording is started and cancelled while it counts in.
  ui.click("[data-act=record]");
  await ui.settle(24);
  const second = viewOf(ui).rec;
  assert.ok(second, "a second recording exists");
  assert.equal(second.counting, true, "counting in");
  ui.click("[data-act=stop]");
  await ui.settle(24);
  assert.equal(viewOf(ui).rec, null, "and it is gone");
  assert.equal(Object.values(viewOf(ui).punchRuns).length, 1, "the first recording's run is untouched");

  // Its passes land: the comp is written once.
  ui.releaseFinish();
  await ui.settle(40);
  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `the first recording's comp is written exactly once (got ${sent.length})`);
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and nothing is left waiting");
});

test("O11a: a mid-take range on a clip with no comp says there is nothing to punch into, and promises no pass", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, latency: CALIBRATED, clock: PASS0_CLOCK });
  assert.deepEqual(await docComp(ui), [], "the clip holds no comp");
  const recorder = await recordWithPunch(ui, null);
  await reportLaunch(ui);
  assert.equal(viewOf(ui).rec.active, true, "the take is running");

  assert.equal(ui.page.__studioTest.setPunch(1, 3), true, "the range itself fits the clip");
  await ui.settle();

  assert.ok(noticeText(ui).includes("No take to punch into yet; recording the whole clip."),
    `the notice says there is nothing to punch into (got: ${noticeText(ui)})`);
  assert.equal(noticeText(ui).includes("applies from the next pass"), false,
    "and it does not promise the next pass");
  assert.equal(viewOf(ui).punchNext, false, "nothing waits for a later pass");
  assert.equal(recorder.gates.length, 0, "the recorder is handed no gate");
  assert.equal(viewOf(ui).rec.punch_plan, null, "and the take has no plan");
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "so no comp write follows it");
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and no run is made");
});

test("O11b: a punched pass that finishes uploading after a reload leaves the comp as it was, and says so", async () => {
  // The row a page left behind: it was a punched pass, and this page has no run
  // to book it in.
  const takeId = "0a1b2c3d-0000-4000-8000-0000000000bb";
  const ui = await bootPanel({
    clip: true,
    lengthBars: 1,
    takes: [{ id: T_OLD }],
    latency: CALIBRATED,
    pending: [{
      take_id: takeId,
      song_id: "song-1",
      clip_id: CLIP,
      rate: 48000,
      channels: 2,
      offset_frames: 0,
      compensated: false,
      bpm: 240,
      chunk_count: 1,
      begun: false,
      finished: false,
      punched: true,
      created_at: new Date(0).toISOString(),
    }],
    chunks: [[takeId, 0, new Uint8Array(24).buffer]],
  });
  await ui.settle(24);

  assert.equal(finishCount(ui), 1, "the pass finished uploading");
  assert.ok(noticeText(ui).includes("Punched passes were added as takes after a reload; the comp was left as it was."),
    `the page says the comp was left alone (got: ${noticeText(ui)})`);
  assert.equal(setCompCommands(ui).length, 0, "and no comp is written for it");
  assert.deepEqual(await docComp(ui), [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }], "the comp is untouched");
});

test("F2: a punch comp write dropped with the closed page leaves a marker, and the next load says the comp was left as it was", async () => {
  // The upload finishes after the page is closed: the pass lands, and its comp
  // write is dropped because there is no page to make it from. The device keeps
  // a marker for the song, so the next load says the comp was left as it was —
  // once (O11b).
  const storage = countInStorage(0);
  const ui = await bootPanel({
    clip: true,
    lengthBars: 1,
    takes: [{ id: T_OLD }],
    latency: CALIBRATED,
    gateFinish: true,
    storage,
  });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "the pass is still uploading");

  viewOf(ui).closed = true;
  ui.releaseFinish();
  await ui.settle(40);

  assert.equal(setCompCommands(ui).length, 0, "no comp write is made from a closed page");
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and its run is let go");
  assert.equal(ui.store.pendings.size, 0, "with the pending row");
  assert.equal(
    storage.getItem("crow.studio.punchdropped.v1.song-1"),
    "true",
    "the device keeps a marker for the song whose comp was left alone",
  );

  // The next load of that song says so.
  const again = await bootPanel({
    clip: true,
    lengthBars: 1,
    takes: [{ id: T_OLD }],
    latency: CALIBRATED,
    storage,
  });
  await again.settle(24);
  assert.ok(
    noticeText(again).includes("Punched passes were added as takes after a reload; the comp was left as it was."),
    `the next load says the comp was left as it was (got: ${noticeText(again)})`,
  );
  assert.equal(storage.getItem("crow.studio.punchdropped.v1.song-1"), null, "and the marker is gone");

  const later = await bootPanel({
    clip: true,
    lengthBars: 1,
    takes: [{ id: T_OLD }],
    latency: CALIBRATED,
    storage,
  });
  await later.settle(24);
  assert.equal(noticeText(later).includes("the comp was left as it was"), false,
    "a load after that says nothing: it was said once");
});

test("O11c: a flush for a clip that is gone from the song writes nothing and says so on the console", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  await chunkPass(ui, recorder, 0);

  // The clip goes, the way another view can remove it mid-take.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.remove", { clip_id: CLIP });
  await ui.pushState();
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  assert.equal(Boolean(snapshot(ui.doc).clips[CLIP]), false, "the song no longer holds the clip");

  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "no comp write goes out for a clip that is not there");
  assert.equal(ui.warnings.length, 1, `the page says so on the console (got ${ui.warnings.length})`);
  assert.match(ui.warnings[0], /clip/i, "naming what is missing");
  assert.deepEqual(viewOf(ui).punchRuns, {}, "and the run is not left waiting");
});

test("S1: a take that is not on the clip's own grid records whole, with no gate and no comp write", async () => {
  const OFF_GRID = "Punch needs the clip playing from its start; recording the whole clip.";

  // (a) the engine answers the next bar line instead of the clip's loop start.
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(ui.page.__studioTest.setPunch(1, 3), true, "a range is set on the clip");
  await ui.settle();
  ui.engine.looping = false;
  ui.click("[data-act=play]");
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.equal(ui.engine.loopAsks.length, 1, "the page asked the engine where the loop starts");
  assert.equal(recorder.armFrame, 96000, "and armed the take on the frame it named");
  assert.equal(viewOf(ui).rec.punch, null, "the take records whole");
  assert.deepEqual(recorder.gates, [], "no gate is sent for a take off the clip's grid");
  assert.ok(noticeText(ui).includes(OFF_GRID), `the page says why (got: ${noticeText(ui)})`);
  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);
  assert.equal(setCompCommands(ui).length, 0, "and nothing is comped");

  // (b) the engine has no loop start to name at all, so the next bar line is the
  // fallback: the same take, off the grid, records whole.
  const fallback = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  fallback.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await fallback.settle();
  assert.equal(fallback.page.__studioTest.setPunch(1, 3), true, "a range is set on the clip");
  await fallback.settle();
  delete fallback.engine.nextLoopFrame;
  fallback.click("[data-act=play]");
  await fallback.settle();
  fallback.click("[data-act=record]");
  await fallback.settle(24);
  const barRecorder = fallback.engine.recorders[fallback.engine.recorders.length - 1];
  assert.equal(barRecorder.armFrame, 48000, "the take armed on the bar line the engine answered");
  assert.deepEqual(barRecorder.gates, [], "no gate: the bar line is not the clip's first beat");
  assert.ok(noticeText(fallback).includes(OFF_GRID), "and the page says why");
  await chunkPass(fallback, barRecorder, 0);
  await endTake(fallback, barRecorder, 1);
  assert.equal(setCompCommands(fallback).length, 0, "nothing is comped here either");
});

test("S1: an arrangement record while the transport plays anchors on the next bar line, so it is not punched", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "arrangement.place", {
    id: "p-gtr",
    track_id: AUDIO_TRACK,
    clip_id: CLIP,
    start_bar: 0,
    bars: 1,
  });
  await ui.pushState();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(ui.page.__studioTest.setPunch(1, 3), true, "a range is set on the placement's clip");
  await ui.settle();
  viewOf(ui).mode = "arrangement";
  ui.click("[data-act=play]");
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.equal(viewOf(ui).rec.clip_id, CLIP, "the take records into the placement's clip");
  assert.equal(recorder.armFrame, 48000, "on the bar line the engine named");
  assert.deepEqual(recorder.gates, [], "a running transport is off the clip's grid: no gate");
  assert.equal(viewOf(ui).rec.punch, null, "and the take records whole");
  assert.ok(noticeText(ui).includes("Punch needs the clip playing from its start; recording the whole clip."),
    `the page says why (got: ${noticeText(ui)})`);
});

test("O10: the flush is measured against liveSongNow(), not the page's own song id", async () => {
  // The page starts showing another song than its own before the take lands: the
  // run was recorded in song-1, and this page is no longer that song.
  const moved = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const recorder = await recordWithPunch(moved, 1, 3);
  await reportLaunch(moved);
  await chunkPass(moved, recorder, 0);
  moved.page.__studioLiveSong = "song-2";
  await endTake(moved, recorder, 1);
  assert.equal(setCompCommands(moved).length, 0, "a page showing another song writes nothing");
  assert.deepEqual(viewOf(moved).punchRuns, {}, "and drops the run");

  // The other way: the run was made while the page was playing song-2, and it is
  // still song-2 now — though the page's own song id is song-1.
  const playing = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  playing.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await playing.settle();
  assert.equal(playing.page.__studioTest.setPunch(1, 3), true, "a range is set on the clip");
  await playing.settle();
  playing.page.__studioLiveSong = "song-2";
  playing.click("[data-act=record]");
  await playing.settle(24);
  const planned = playing.engine.recorders[playing.engine.recorders.length - 1];
  await reportLaunch(playing);
  assert.equal(onlyRun(playing).song_id, "song-2", "the run's song is the one the page is playing now");
  assert.equal(String(playing.page.getAttribute("data-studio-song")), "song-1", "which is not the page's own song id");
  await chunkPass(playing, planned, 0);
  await endTake(playing, planned, 1);
  const sent = setCompCommands(playing);
  assert.equal(sent.length, 1, "the run whose song is the one playing now is written");
  assert.equal(sent[0].args.clip_id, CLIP, "against its own clip");
});

// ---- the record flow around the count-in and the punch (O8/S2, S3, S7-S9, S12)
//
// A punch range is checked when Record is pressed — before a count-in is started
// and before the transport moves — and again at the arm as a backstop for a clip
// that changes under the clicks. The count-in's last beat arms the recorder for
// frame accuracy but commits nothing: the take's clip is written on the engine's
// downbeat, so a Stop or a Pause in that last beat still leaves the song exactly
// as it was.

/** The sentence a Record press while the arrangement plays gives. */
const ARRANGEMENT_PLAYING_TEXT =
  "Recording from the next bar; stop the transport first to line the take up with the clip.";

/** The sentence a recorder that arrived too late gives. */
const LATE_RECORDER_TEXT =
  "The input opened after the count-in began, so the start of this take may be silent.";

/** @returns {string} the toast the page is showing */
function toastText(ui) {
  return String(ui.document.querySelector("[data-role=toast]").textContent || "");
}

/**
 * Shorten the fixture clip the way another view can.
 * @param {object} ui a booted panel
 * @param {number} bars
 */
async function shortenClip(ui, bars) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.set_length", { clip_id: CLIP, length_bars: bars });
  await ui.pushState();
}

test("O8/S2: a punch range that no longer fits the clip refuses the Record click before any count-in", async () => {
  const ui = await bootPanel({ clip: true, takes: [{ id: T_OLD }], latency: CALIBRATED, countIn: 1 });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(ui.page.__studioTest.setPunch(4, 6), true, "the range fits the clip as it stands");
  await ui.settle();
  await shortenClip(ui, 1);
  assert.deepEqual(viewOf(ui).punch, { from: 4, to: 6 }, "the page still holds the range it was given");
  const commandsBefore = commandsSent(ui);

  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(viewOf(ui).rec, null, "no take was made");
  assert.equal(countInPlays(ui).length, 0, "and no count-in was started");
  assert.equal(ui.engine.plays, 0, "the transport was never started");
  assert.equal(ui.engine.recorders.length, 0, "and no recorder was built for it");
  assert.equal(commandsSent(ui), commandsBefore, "nothing was written");
  assert.equal(viewOf(ui).playing, false, "the page says nothing is playing");
  assert.ok(
    noticeText(ui).includes("The punch range is outside this clip."),
    `the page says why (got: ${noticeText(ui)})`,
  );
});

test("O8/S2: the arm-time backstop leaves no count-in, no transport and no clip behind it", async () => {
  const ui = await bootPanel({ clip: true, takes: [{ id: T_OLD }], latency: CALIBRATED, countIn: 1 });
  const recorder = await recordWithPunch(ui, 4, 6);
  assert.equal(countInPlays(ui).length, 1, "the count-in began at the click");
  // The clip is shortened while the clicks run, so the range no longer fits it: the
  // arm is where the take is refused this time.
  await shortenClip(ui, 1);
  const commandsBefore = commandsSent(ui);

  ui.engine.countBar(1, 96000);
  await ui.settle(24);

  assert.equal(viewOf(ui).rec, null, "nothing is armed and no take is left");
  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled on the audio thread");
  assert.ok(ui.engine.stops > 0, "and the transport this flow started was stopped");
  assert.equal(viewOf(ui).playing, false, "so the page says nothing is playing");
  assert.equal(recorder.armFrame, null, "the recorder was never armed");
  assert.deepEqual(recorder.splits, [], "and no pass boundary was sent");
  assert.equal(commandsSent(ui), commandsBefore, "nothing was written for it");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.ok(
    toastText(ui).includes("The punch range is outside this clip."),
    `the page says why (got: ${toastText(ui)})`,
  );
});

test("S3: Stop in the count-in's last beat cancels it and writes nothing", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  const recorder = await pressRecord(ui);
  const view = viewOf(ui);
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  for (const beat of [1, 2, 3]) {
    const at = 96000 - (4 - beat) * BEAT_FRAMES;
    ui.engine.countIn({ type: "count_in", beat, beats: 4, frame: at, play_frame: 96000 });
    await ui.settle();
  }
  const commandsBefore = commandsSent(ui);

  // The last click arms the recorder one beat before the downbeat.
  clockAtFrame(ui, LAST_CLICK_FRAME);
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: LAST_CLICK_FRAME, play_frame: 96000 });
  await ui.settle(24);
  assert.equal(recorder.armFrame, 96000, "the recorder is armed on the count-in's frame");
  assert.equal(view.rec.preroll, true, "but the take is not committed: the downbeat has not come");
  assert.equal(commandsSent(ui), commandsBefore, "and nothing is written for it yet");
  assert.equal(
    ui.document.querySelector("[data-act=pause]").disabled,
    false,
    "Pause is still offered in that last beat: the take has not begun",
  );

  ui.click("[data-act=stop]");
  await ui.settle(24);

  assert.equal(view.rec, null, "no take is left");
  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled on the audio thread");
  assert.ok(ui.engine.stops > 0, "and the transport was stopped");
  assert.equal(view.playing, false, "the page says nothing is playing");
  assert.equal(commandsSent(ui), commandsBefore, "no clip and no placement was written");
  assert.equal(ui.sent.filter((message) => message.command === "clip.add_audio").length, 0,
    "no clip was made for it");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
  assert.ok(noticeText(ui).includes("Count-in cancelled"), "the notice says the count-in was cancelled");

  // The downbeat of a count-in that was cancelled writes nothing either.
  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle();
  assert.equal(commandsSent(ui), commandsBefore, "and its downbeat writes nothing");
  assert.equal(view.rec, null, "no take is left by it either");

  // A Pause in that same last beat is the count-in's cancel too: the take that
  // never began goes, and no clip is written for it.
  const paused = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  const pauseRecorder = await pressRecord(paused);
  paused.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await paused.settle();
  clockAtFrame(paused, LAST_CLICK_FRAME);
  paused.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: LAST_CLICK_FRAME, play_frame: 96000 });
  await paused.settle(24);
  assert.equal(pauseRecorder.armFrame, 96000, "the take is armed on the last click");
  assert.equal(viewOf(paused).rec.preroll, true, "and not committed");
  const commandsBeforePause = commandsSent(paused);

  paused.click("[data-act=pause]");
  await paused.settle(24);

  assert.equal(viewOf(paused).rec, null, "no take is left");
  assert.equal(paused.engine.cancels, 1, "the count-in was cancelled on the audio thread");
  assert.equal(commandsSent(paused), commandsBeforePause, "and nothing was written");
  assert.equal(viewOf(paused).paused, false, "a stopped transport has nothing to pause");
  assert.ok(noticeText(paused).includes("Count-in cancelled"), "the notice says so");
});

test("S3: a count-in take writes its clip exactly once, on the engine's downbeat", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  const recorder = await pressRecord(ui);
  const view = viewOf(ui);
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  clockAtFrame(ui, LAST_CLICK_FRAME);
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: LAST_CLICK_FRAME, play_frame: 96000 });
  await ui.settle(24);

  assert.equal(recorder.armFrame, 96000, "the take is armed on the count-in's frame");
  assert.ok(view.rec.clip_id, "and already knows the clip its passes will land in");
  assert.equal(ui.sent.filter((message) => message.command === "clip.add_audio").length, 0,
    "but that clip is not written before the song starts");

  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);

  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the downbeat writes the clip, once");
  assert.equal(added[0].args.clip_id, view.rec.clip_id, "the very clip the take records into");
  assert.equal(view.rec.preroll, false, "and the take is committed");
  assert.equal(view.rec.active, true, "recording");
});

test("S3: an arrangement count-in with a new clip writes the clip and its placement on the downbeat, once", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  viewOf(ui).mode = "arrangement";
  const recorder = await pressRecord(ui);
  const view = viewOf(ui);
  assert.equal(view.rec.counting, true, "the arrangement counts in");
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  clockAtFrame(ui, LAST_CLICK_FRAME);
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: LAST_CLICK_FRAME, play_frame: 96000 });
  await ui.settle(24);

  assert.equal(recorder.armFrame, 96000, "the take is armed on the count-in's frame");
  assert.equal(ui.sent.filter((message) => message.command === "clip.add_audio").length, 0,
    "no clip is written on the last click");
  assert.equal(ui.sent.filter((message) => message.command === "arrangement.place").length, 0,
    "and no placement");

  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);

  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  const placed = ui.sent.filter((message) => message.command === "arrangement.place");
  assert.equal(added.length, 1, "the downbeat writes one clip");
  assert.equal(placed.length, 1, "and one placement");
  assert.equal(added[0].args.clip_id, view.rec.clip_id, "the clip the take records into");
  assert.equal(placed[0].args.clip_id, added[0].args.clip_id, "placing that very clip");
});

test("S7: Record while the arrangement plays says the take starts on the next bar", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "arrangement.place", {
    id: "p-gtr",
    track_id: AUDIO_TRACK,
    clip_id: CLIP,
    start_bar: 0,
    bars: 1,
  });
  await ui.pushState();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  viewOf(ui).mode = "arrangement";
  ui.click("[data-act=play]");
  await ui.settle();

  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(countInPlays(ui).length, 0, "a running transport counts nothing in");
  assert.ok(
    noticeText(ui).includes(ARRANGEMENT_PLAYING_TEXT),
    `the page says where the take starts (got: ${noticeText(ui)})`,
  );
  assert.equal(
    noticeText(ui).split(ARRANGEMENT_PLAYING_TEXT).length - 1,
    1,
    "and says it once",
  );
});

test("S8: the next-pass mark does not outlive the take", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED, clock: PASS0_CLOCK });
  const recorder = await recordWithPunch(ui, 1, 3);
  await reportLaunch(ui);
  assert.equal(ui.page.__studioTest.setPunch(2, 4), true, "another range, set while pass 0 runs");
  await ui.settle();
  assert.equal(viewOf(ui).punchNext, true, "the range applies from the next pass");

  await chunkPass(ui, recorder, 0);
  await endTake(ui, recorder, 1);

  assert.equal(viewOf(ui).punchNext, false, "the take that ended took the mark with it");
  await ui.pushState();
  assert.equal(
    ui.document.querySelector("[data-role=punch-next]"),
    null,
    "and the options row carries no next-pass label",
  );

  // A recording cancelled during its count-in leaves no mark behind either: the
  // label is about a pass of the take that is gone.
  const cancelled = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  await pressRecord(cancelled);
  viewOf(cancelled).punchNext = true;
  cancelled.click("[data-act=stop]");
  await cancelled.settle(24);
  assert.equal(viewOf(cancelled).punchNext, false, "a cancelled recording leaves none either");
});

test("S9: a Pause that cancels an arrangement count-in begun from a paused transport leaves the page paused", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED, countIn: 1 });
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "arrangement.place", {
    id: "p-gtr",
    track_id: AUDIO_TRACK,
    clip_id: CLIP,
    start_bar: 0,
    bars: 1,
  });
  await ui.pushState();
  viewOf(ui).mode = "arrangement";
  ui.click("[data-act=play]");
  await ui.settle();
  ui.click("[data-act=pause]");
  await ui.settle();
  const view = viewOf(ui);
  assert.equal(view.paused, true, "the transport stands paused where it was");

  await pressRecord(ui);
  assert.equal(countInPlays(ui).length, 1, "the arrangement counts in");
  assert.equal(view.rec.was_paused, true, "and remembers the paused transport it began from");
  assert.equal(view.rec.started_paused, false, "a plan count-in is never carried on from a paused slot");

  ui.click("[data-act=pause]");
  await ui.settle(24);

  assert.equal(view.rec, null, "the count-in and its take are gone");
  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled on the audio thread");
  assert.equal(view.paused, true, "and the page still reads paused");
  assert.equal(view.playing, false, "with nothing playing");

  // The next Play carries the transport on from where it stands.
  const plays = ui.engine.plays;
  ui.click("[data-act=play]");
  await ui.settle();
  assert.equal(ui.engine.plays, plays + 1, "Play reaches the engine");
  assert.equal(view.playing, true, "and the page reads playing");
  assert.equal(view.paused, false, "with nothing paused");
});

test("S12: an input that opens after the count-in began says the start of the take may be silent", async () => {
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const ui = await bootPanel({ storage: makeStorage(), holdRecorder: held });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.equal(ui.engine.recorders.length, 0, "the input is still opening");
  assert.equal(countInPlays(ui).length, 1, "the count-in began at the click");
  assert.equal(noticeText(ui).includes(LATE_RECORDER_TEXT), false, "nothing is said while it may still arrive");

  // The count-in runs to its last beat with no recorder to arm.
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  for (const beat of [1, 2, 3, 4]) {
    const at = 96000 - (4 - beat) * BEAT_FRAMES;
    clockAtFrame(ui, at);
    ui.engine.countIn({ type: "count_in", beat, beats: 4, frame: at, play_frame: 96000 });
    await ui.settle();
  }
  const view = viewOf(ui);
  assert.equal(view.rec.arm_at, 96000, "the count-in's arm frame waits for a recorder");
  assert.equal(view.rec.recorder, null, "which has not arrived");

  // The input opens long after the frame the take should have armed on.
  clockAtFrame(ui, 96000 + 48000);
  release();
  await ui.settle(24);

  const recorder = ui.engine.recorders[0];
  assert.ok(recorder, "the recorder arrived");
  assert.equal(recorder.armFrame, 96000, "and armed on the count-in's frame");
  assert.ok(
    noticeText(ui).includes(LATE_RECORDER_TEXT),
    `the page says the start may be silent (got: ${noticeText(ui)})`,
  );
  assert.equal(view.rec.notice_late, true, "said once for this take");
  assert.equal(noticeText(ui).split(LATE_RECORDER_TEXT).length - 1, 1, "and only once in the notices");

  // The downbeat still commits the take's clip.
  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    1,
    "the clip is written on the downbeat",
  );

  // An input that opens in time says nothing of it.
  const onTime = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  const onTimeRecorder = await pressRecord(onTime);
  onTime.engine.countBar(1, 96000);
  await onTime.settle(24);
  assert.equal(onTimeRecorder.armFrame, 96000, "an on-time recorder arms on the count-in's frame");
  assert.equal(
    noticeText(onTime).includes(LATE_RECORDER_TEXT),
    false,
    "and the page says nothing about a late input",
  );
});

// ---- the scene plan's blocks and Follow (C2, R14, R17) ---------------------
//
// The plan is the arrangement read as blocks (panel/scene-plan.js): sections,
// and the bars outside them gathered by the scene they play. The scene plan
// widget lists those blocks, outlines the one the transport is in, dashes the
// one after it, and the recording lanes draw the same blocks as bands under
// their ruler. Follow plays the plan from the playhead — the arrangement view,
// armed on the bar frame — and By hand plays scenes, where a block's tap
// launches its scene on the next bar. The choice is this device's own, per song,
// and it is fixed for the take.

/**
 * Give the fixture song a plan: the audio clip placed over bars 0 to 2, then a
 * section over bars 2 to 4. The plan is two blocks, "Verse" and "Chorus".
 * @param {object} ui a booted panel
 */
async function placeThePlan(ui) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "arrangement.place", {
    id: "p-plan",
    track_id: AUDIO_TRACK,
    clip_id: CLIP,
    start_bar: 0,
    bars: 2,
  });
  runCommand(ui.doc, "section.add", { id: "s-plan", start_bar: 2, end_bar: 4, name: "Chorus" });
  await ui.pushState();
}

/** @returns {object[]} the plan's block buttons, in page order */
function planBlockNodes(ui) {
  return Array.from(ui.document.querySelectorAll("[data-role=scene-plan-block]"));
}

/** @returns {string[]} their labels, in page order */
function planBlockLabels(ui) {
  return planBlockNodes(ui).map((node) => String(node.textContent));
}

/** @returns {string} the label of the plan-mode choice the row shows pressed */
function pressedPlanMode(ui) {
  const pressed = Array.from(ui.document.querySelectorAll("[data-act=plan-mode]"))
    .filter((node) => node.getAttribute("aria-pressed") === "true");
  assert.equal(pressed.length, 1, "exactly one plan choice reads as pressed");
  return String(pressed[0].textContent);
}

/** @returns {string} the sentence beside the Follow / By hand switch */
function planModeNoteText(ui) {
  return String(ui.document.querySelector("[data-role=scene-plan-mode-note]").textContent || "");
}

/** @returns {string} one rule's body out of the page's stylesheet */
function styleRule(html, selector) {
  const at = html.indexOf(selector + " {");
  assert.ok(at >= 0, `the page carries a rule for ${selector}`);
  const end = html.indexOf("}", at);
  return html.slice(at, end + 1);
}

test("the strip lists the song's plan blocks and outlines the current one as the position moves", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  // The engine the transport reports through exists once the page has asked for
  // it: Play is the plainest way to have one without recording anything.
  ui.click("[data-act=play]");
  await ui.settle();

  assert.deepEqual(planBlockLabels(ui), ["Verse", "Chorus"], "the plan's blocks are listed in bar order");
  const blocks = planBlockNodes(ui);
  assert.match(String(blocks[0].className), /st-plan-block-current/, "the block bar 1 is in is outlined");
  assert.doesNotMatch(String(blocks[0].className), /st-plan-block-next/, "and it is not the one after it");
  assert.match(String(blocks[1].className), /st-plan-block-next/, "the next block is dashed");
  assert.doesNotMatch(String(blocks[1].className), /st-plan-block-current/, "and is not the current one");

  // A section names no scene, so its block has nothing to launch and is inert.
  assert.equal(blocks[1].disabled, true, "a section block plays nothing of its own");
  assert.equal(blocks[1].getAttribute("aria-disabled"), "true", "and says so");
  assert.equal(blocks[0].getAttribute("data-scene-id"), SCENE, "the scene block names the scene it plays");

  // The lanes' ruler draws the plan's placement blocks as bands, and the
  // sections in their own row above them: a section is one band there, once.
  const bands = Array.from(ui.document.querySelectorAll("[data-role=rec-lanes] .st-lane-band"));
  assert.deepEqual(bands.map((node) => String(node.textContent)), ["Verse"],
    "the ruler carries the plan's placement blocks as bands");
  assert.deepEqual(
    Array.from(ui.document.querySelectorAll("[data-role=rec-lanes] [data-role=rec-section]")).map((node) => String(node.textContent)),
    ["Chorus"],
    "and the section sits in the section row, not again in the plan row",
  );
  const bars = viewOf(ui).recLanesBars;
  for (const band of bands) {
    assert.ok(String(band.style.width).endsWith("%"), "a band is placed by percentage of the ruler's bars");
    assert.ok(String(band.style.left).endsWith("%"), "from its own first bar");
  }
  assert.equal(Number.parseFloat(bands[0].style.left), 0, "the first band starts on the ruler's first bar");
  assert.equal(Number.parseFloat(bands[0].style.width), Math.round((2 / bars) * 100 * 1000) / 1000,
    "and spans the two bars its block covers on the ruler's own bar scale");

  // The transport moves into the second block: a position report redraws the
  // strip, and the count-in controls beside it are the very nodes they were.
  const countIn = countInButtons(ui)[0];
  ui.engine.position({ bar: 3, beat: 1, sixteenth: 1 });
  await ui.settle();
  const moved = planBlockNodes(ui);
  assert.match(String(moved[1].className), /st-plan-block-current/, "the block the transport is in is outlined now");
  assert.doesNotMatch(String(moved[0].className), /st-plan-block-current/, "and the one before it is not");
  assert.doesNotMatch(String(moved[1].className), /st-plan-block-next/, "nothing follows it in the plan");
  assert.equal(countInButtons(ui)[0], countIn, "a position report draws only the strip, not the controls beside it");

  // Back into the first block, from a bar inside it.
  ui.engine.position({ bar: 2, beat: 3, sixteenth: 1 });
  await ui.settle();
  assert.match(String(planBlockNodes(ui)[0].className), /st-plan-block-current/,
    "bar 2 belongs to the first block");
  assert.match(String(planBlockNodes(ui)[1].className), /st-plan-block-next/, "and the next one is dashed again");
});

test("Follow switches the engine to arrangement and Record arms through armArrangementRecording", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  assert.equal(viewOf(ui).planMode, "hand", "a device that has never chosen one plays scenes by hand");
  assert.equal(pressedPlanMode(ui), "By hand", "and the switch shows it");

  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();
  assert.equal(viewOf(ui).planMode, "follow", "Follow is the page's choice now");
  assert.equal(ui.storage.getItem("crow.studio.planmode.v1.song-1"), "follow", "and this browser keeps it");
  assert.equal(pressedPlanMode(ui), "Follow the plan", "the switch shows it");
  assert.match(planModeNoteText(ui), /does nothing/, "and says a part of the plan is not tapped while it plays");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.engine.modes.length = 0;
  ui.click("[data-act=record]");
  await ui.settle(24);

  const view = viewOf(ui);
  assert.equal(view.mode, "arrangement", "Record put the page on the plan");
  assert.equal(ui.engine.modes[ui.engine.modes.length - 1], "arrangement",
    "and the engine was moved with it, as the view switch does");
  assert.equal(countInPlays(ui).length, 0, "the count-in is Off: nothing counts in");
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  assert.equal(recorder.armFrame, 48000, "the take armed on the bar frame the engine named");
  assert.equal(view.rec.clip_id, CLIP, "it records into the placement's own clip");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "and makes no clip of its own",
  );
});

test("By hand leaves the view where it is, so an arrangement take records the plan as it always has", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(viewOf(ui).mode, "arrangement", "the page shows the plan");
  assert.equal(viewOf(ui).planMode, "hand", "with a By-hand take chosen");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  const view = viewOf(ui);
  assert.equal(view.mode, "arrangement", "a By-hand Record leaves the view alone");
  assert.equal(view.rec.clip_id, CLIP, "the take records into the placement's own clip");
  assert.equal(ui.engine.recorders[ui.engine.recorders.length - 1].armFrame, 48000,
    "and arms on the bar frame the engine names, as the arrangement always has");
});

test("By hand tap launches the block's scene (launchSceneAt) and the queued scene shows dashed", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);

  const before = ui.engine.launched.length;
  ui.click(`[data-act=plan-block][data-scene-id=${SCENE}]`);
  await ui.settle(24);
  assert.ok(ui.engine.launched.slice(before).includes(SCENE), "the block's scene was launched");
  assert.equal(String(viewOf(ui).queuedScene), SCENE, "and waits for the next bar");
  const queued = planBlockNodes(ui).find((node) => node.getAttribute("data-scene-id") === SCENE);
  assert.ok(queued, "the block is still listed");
  assert.match(String(queued.className), /st-plan-block-queued/, "the scene a tap queued is dashed");

  // Follow: a tap on a block is inert, because the plan is what plays.
  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();
  const launched = ui.engine.launched.length;
  ui.click(`[data-act=plan-block][data-scene-id=${SCENE}]`);
  await ui.settle(24);
  assert.equal(ui.engine.launched.length, launched, "a tap while the plan is followed launches nothing");
});

test("the switch is disabled while a take runs", async () => {
  const ui = await bootPanel();
  const switches = () => Array.from(ui.document.querySelectorAll("[data-act=plan-mode]"));
  assert.equal(switches().length, 2, "Follow and By hand are both offered");
  for (const node of switches()) assert.equal(node.disabled, false, "and both are offered before a take");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.ok(viewOf(ui).rec, "a take is open");
  for (const node of switches()) {
    assert.equal(node.disabled, true, "the switch is disabled while the take runs");
    assert.equal(node.getAttribute("aria-disabled"), "true", "and says so");
  }

  ui.click("[data-act=stop]");
  await ui.settle(24);
  assert.equal(viewOf(ui).rec, null, "the take is over");
  for (const node of switches()) assert.equal(node.disabled, false, "and the switch is offered again");
});

test("a song with no scenes shows the widget note", async () => {
  // A song with nothing placed has no plan: the widget says what to add rather
  // than drawing an empty strip nobody can act on.
  const ui = await bootPanel();
  const empty = ui.document.querySelector("[data-role=scene-plan-empty]");
  assert.ok(empty, "the widget carries the note");
  assert.equal(String(empty.textContent), "Add a scene to plan.", "in the words the design gives it");
  assert.equal(planBlockNodes(ui).length, 0, "and lists no blocks");
  assert.equal(
    ui.document.querySelectorAll("[data-role=rec-lanes] .st-lane-band").length,
    0,
    "the lanes' ruler draws no bands either",
  );
});

test("on a phone the strip scrolls horizontally and blocks are 44px high", async () => {
  const res = { html: "", send(body) { this.html = String(body); } };
  await studioPanel.handler({ query: { song: "song-1" }, headers: {} }, res, { db: panelDb(), layout: minimalLayout });

  const strip = styleRule(res.html, ".studio .st-plan-strip");
  assert.match(strip, /overflow-x: auto/, "a plan longer than the widget scrolls sideways");
  assert.match(strip, /flex-wrap: nowrap/, "and keeps its blocks on one row");
  const block = styleRule(res.html, ".studio .st-plan-block");
  assert.match(block, /min-height: 44px/, "every block is a 44 px target");
  assert.match(block, /flex: 0 0 auto/, "and never shrinks to fit");
  assert.match(styleRule(res.html, ".studio .st-plan-block-current"), /outline: 2px solid var\(--st-accent/,
    "the current block is outlined in the page's accent");
  assert.match(styleRule(res.html, ".studio .st-plan-block-next"), /border-style: dashed/,
    "the next block is dashed");
  assert.match(styleRule(res.html, ".studio .st-lane-band"), /position: absolute/,
    "a lane's band sits on the ruler's own bar axis");
});

test("Follow with nothing placed under the playhead behaves as today: it cancels and says why", async () => {
  // The only scene slot on the armed track is taken and the arrangement places
  // nothing, so a plan take has nowhere to record: the page cancels it with the
  // sentence it has always used, and leaves no take behind.
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(viewOf(ui).mode, "arrangement", "Follow put the page on the plan");
  assert.equal(viewOf(ui).rec, null, "and no take is left open");
  assert.ok(
    toastText(ui).includes("There is no free scene slot on this track for a new recording; add a scene first."),
    `the page says why (got: ${toastText(ui)})`,
  );
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
});

// ---- By hand: what the take played is written into the plan (C3, R15) ------
//
// A take that plays scenes by hand is collected the way the Record to timeline
// toggle collects a performance, with the toggle off: a press with it on is
// refused, because the take and the toggle write the plan from different bars.
// At Stop the launches the take heard become placements, shifted to the
// arrangement bar the playhead stood on when Record was pressed. The record
// clip's own launch is one of them, so the clip the empty slot got is placed
// over the passes it recorded. Overlaps are the existing command's refusal, and
// the existing notice is where the operator is offered what fits.

/** @returns {object[]} every record_performance the page sent, in order */
function performances(ui) {
  return ui.sent.filter(
    (message) => message.type === "command" && message.command === "arrangement.record_performance",
  );
}

/**
 * Apply every performance the page sent through the hub's own command registry,
 * on the panel's own document: what a performance places has to be a song the
 * timeline can hold. The document has to carry the tracks and clips the
 * placements name (the fixture booted with a clip, and any track a case added).
 *
 * A refusal is thrown on, so the hub's own sentence is what fails the case.
 * @param {object} ui a booted panel
 * @param {object[]} list the record_performance messages, in the order sent
 */
async function hubApply(ui, list) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  await import("../bundles/studio/server/commands/arrangement.js");
  for (const message of list) {
    runCommand(ui.doc, message.command, message.args);
  }
}

/**
 * Put the page's arrangement playhead on one bar: the ruler seeks on a whole
 * bar, and the playhead the operator leaves there is what a By-hand take writes
 * from.
 * @param {object} ui a booted panel
 * @param {number} bar the arrangement bar the playhead should stand on
 */
async function standPlayheadAt(ui, bar) {
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const strip = ui.document.querySelector("[data-role=bar-ruler]");
  assert.ok(strip, "the timeline draws the bar ruler");
  // 32 bars across 320 px: 10 px a bar, so the middle of a bar is 10 px in.
  strip.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 320, height: 18, right: 320, bottom: 18, x: 0, y: 0,
  });
  strip.dispatchEvent(ui.event("pointerdown", { button: 0, clientX: bar * 10 + 5 }));
  await ui.settle();
  ui.fireWindow("pointerup", ui.event("pointerup", {}));
  await ui.settle();
  ui.click("[data-act=mode-session]");
  await ui.settle();
}

test("R15: a by-hand take sends one record_performance at Stop with the launches made during the take, each bar shifted by the playhead bar at Record", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  // The arrangement's playhead is left standing in bar 5 — arrangement bar 4 —
  // and the take records from the Session view.
  await standPlayheadAt(ui, 4);
  const view = viewOf(ui);
  assert.equal(view.mode, "session", "the take records from the Session view");
  assert.equal(view.playhead, 4, "with the playhead left on arrangement bar 4");
  assert.equal(view.planMode, "hand", "and By hand chosen");

  await pressRecord(ui);
  assert.equal(view.recTimeline.on, true, "Record collected what the take plays for the plan");
  assert.equal(view.recTimeline.base_bar, 4, "from the bar the playhead stood on");

  // The record scene's own launch arms the take; a tap on the armed track's
  // scene two bars in closes its placement and opens the next one.
  await reportLaunch(ui);
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 2, frame: 144000 }),
  );
  await ui.settle();

  ui.engine.position({ bar: 5, beat: 1, sixteenth: 1 });
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the whole take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 2 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 6, bars: 2 },
    ],
    "each launch bar is shifted by the playhead's own bar, and the last one ends on the stop bar",
  );
});

test("R15: a launch posted BEFORE count_in_done but with frame >= play_frame is collected, and one with an earlier frame is not (both message orders)", async () => {
  /**
   * One bar of count-in, with an optional hook that runs between the announced
   * play frame and the first click.
   * @param {object} ui a booted panel
   * @param {number} playFrame
   * @param {function(): void} [between]
   */
  const countOneBar = (ui, playFrame, between) => {
    const beats = 4;
    ui.engine.countIn({ type: "count_in_start", play_frame: playFrame });
    if (between) between();
    for (let beat = 1; beat <= beats; beat += 1) {
      ui.engine.countIn({
        type: "count_in",
        beat,
        beats,
        frame: playFrame - (beats - beat) * 12000,
        play_frame: playFrame,
      });
    }
    ui.engine.countIn({ type: "count_in_done", frame: playFrame });
  };

  /** A launch of the armed track's scene at one session bar and frame. */
  const launchAt = (ui, bar, frame) => {
    ui.engine.launches.forEach((listener) =>
      listener({ track_id: AUDIO_TRACK, clip_id: CLIP, scene_id: SCENE, bar, frame }),
    );
  };

  const PLAY_FRAME = 96000;

  // The launches arrive while the count-in runs: the take's own downbeat launch
  // is collected even though the engine has not said the count is over, and the
  // one from before that frame is not.
  const early = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await pressRecord(early);
  assert.equal(countInPlays(early).length, 1, "Record counted one bar in");
  // The downbeat is session bar 0 at the announced play frame: a launch there
  // keeps its own bar, and the take stops on session bar 3.
  countOneBar(early, PLAY_FRAME, () => {
    launchAt(early, 0, 84000);
    launchAt(early, 0, PLAY_FRAME);
  });
  await early.settle();
  await transportOnBar(early, 3);
  early.click("[data-act=stop]");
  await early.settle(24);

  const before = performances(early);
  assert.equal(before.length, 1, "the take wrote one performance");
  assert.deepEqual(
    before[0].args.placements,
    [{ track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 0, bars: 3 }],
    "only the launch at or after the announced play frame is in it",
  );

  // The same two launches, posted after the count is over: the order they came
  // in decides nothing, only the frames they played at do.
  const late = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await pressRecord(late);
  countOneBar(late, PLAY_FRAME);
  await late.settle();
  launchAt(late, 0, 84000);
  launchAt(late, 0, PLAY_FRAME);
  await late.settle();
  await transportOnBar(late, 3);
  late.click("[data-act=stop]");
  await late.settle(24);

  const after = performances(late);
  assert.equal(after.length, 1, "the take wrote one performance");
  assert.deepEqual(
    after[0].args.placements,
    before[0].args.placements,
    "and it is the same performance, whichever order the messages arrived in",
  );
});

test("R15: the record clip (created at arm on an empty slot) is placed from its launch bar over the recorded passes", async () => {
  // Nothing is in the armed track's slot: the launch that arms the take names no
  // clip, because the clip is what the arm makes. The performance places that
  // clip from the bar its launch played, over the passes it recorded.
  const ui = await bootPanel();
  await pressRecord(ui);
  await reportLaunch(ui);

  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got one audio clip");
  const clipId = added[0].args.clip_id;
  assert.equal(typeof clipId, "string", "under the id the arm made for it");

  // Two four-bar passes: the take stops at the end of bar 8.
  ui.engine.position({ bar: 9, beat: 1, sixteenth: 1 });
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "Stop wrote one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [{ track_id: AUDIO_TRACK, clip_id: clipId, start_bar: 0, bars: 8 }],
    "the recorded clip is placed from its launch bar over the passes it recorded",
  );
});

test("R14: Follow writes no placement", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();
  assert.equal(viewOf(ui).planMode, "follow", "the take follows the plan");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.equal(viewOf(ui).mode, "arrangement", "which puts the page on the timeline");
  assert.equal(viewOf(ui).recTimeline.on, false, "nothing is collected for the plan");

  // A launch report, the kind the Session view's sequencer posts: the plan
  // launches no scene, and a following take writes nothing into the plan.
  await reportLaunch(ui);
  ui.engine.position({ bar: 3, beat: 1, sixteenth: 1 });
  ui.click("[data-act=stop]");
  await ui.settle(24);

  assert.equal(performances(ui).length, 0, "a Follow take writes no placement");
  assert.equal(
    ui.sent.filter((message) => message.command === "arrangement.place").length,
    0,
    "and no placement either",
  );
});

test("R15: a Stop during the count-in writes nothing", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await pressRecord(ui);
  assert.equal(viewOf(ui).recTimeline.on, true, "the By-hand take collects what it plays");

  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  // The downbeat's launch arrives before the count is over; the Stop comes
  // before the take's first frame, so nothing of it is written.
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: CLIP, scene_id: SCENE, bar: 0, frame: 96000 }),
  );
  await ui.settle();
  // A position report that reaches the page before the Stop names a bar the
  // count-in has not played: a take that never went active has no stop bar to
  // be written from, so this report invents nothing (R15 fix 8).
  await transportOnBar(ui, 3);

  ui.click("[data-act=stop]");
  await ui.settle(24);

  assert.equal(viewOf(ui).rec, null, "no take is left armed");
  assert.equal(performances(ui).length, 0, "a take that never began writes no performance");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "and no clip",
  );
  assert.equal(viewOf(ui).recTimeline.on, false, "the toggle goes back to what it was");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
});

test("R7: Pause during a By-hand count-in (recTimeline.on forced) cancels it", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  const view = viewOf(ui);
  const pause = () => ui.document.querySelector("[data-act=pause]");

  await pressRecord(ui);
  assert.equal(view.recTimeline.on, true, "the By-hand take forced the collection on");
  assert.equal(pause().disabled, false, "counting is not recording, so Pause is offered");

  ui.click("[data-act=pause]");
  await ui.settle(24);

  assert.equal(ui.engine.cancels, 1, "the count-in was cancelled on the audio thread");
  assert.equal(view.rec, null, "no take is left armed");
  assert.equal(view.playing, false, "nothing is playing");
  assert.equal(performances(ui).length, 0, "and nothing is written into the plan");
  assert.equal(view.recTimeline.on, false, "the toggle is back to what the operator had it at");
  assert.equal(pause().disabled, false, "Pause is offered again once nothing runs");
  assert.ok(noticeText(ui).includes("Count-in cancelled"), "the notice says so");
  assert.equal(ui.store.pendings.size, 0, "no take row exists");
});

test("a take with no launches sends no command", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await pressRecord(ui);
  assert.equal(viewOf(ui).recTimeline.on, true, "the By-hand take collects what it plays");
  assert.ok(
    noticeText(ui).includes("Launch a scene on the armed track to start at its first bar."),
    "the page waits for a scene launch",
  );

  const before = commandsSent(ui);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  assert.equal(performances(ui).length, 0, "a take that played nothing writes no performance");
  assert.equal(commandsSent(ui), before, "and nothing else either");
  assert.equal(viewOf(ui).rec, null, "the take is over");
  assert.equal(viewOf(ui).recTimeline.on, false, "and the toggle is back to what it was");
});

test("the By-hand undo note is on the page only while By hand is selected", async () => {
  const ui = await bootPanel();
  const note = () => ui.document.querySelector("[data-role=scene-plan-undo-note]");
  assert.ok(note(), "a device that plays scenes by hand says what one undo does");
  assert.equal(
    String(note().textContent),
    "A by-hand take is saved in parts. Its placements are one step in History; undoing that step "
      + "removes them and leaves the clip and every pass take, which are steps of their own.",
    "in two short sentences: the placements are one step, the clip and the takes are others",
  );

  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();
  assert.equal(note(), null, "Follow writes nothing into the plan, so the sentence is not there");

  ui.click("[data-act=plan-mode][data-mode=hand]");
  await ui.settle();
  assert.ok(note(), "and it is back with By hand");
});

// ---- the plan widget's own words in each view -------------------------------
//
// The Scene plan widget is on the page in every view, and what By hand means
// depends on the view: the Session view plays scenes (a tap plays one, and the
// take is written into the plan from the arrangement bar the playhead stands
// on), while the Timeline has Record play the plan itself. Follow plays the plan
// in both, so a block there says it plays nothing rather than offering a press.

/** The sentence the Timeline's options row carries while By hand is chosen. */
const PLAN_HAND_TIMELINE_NOTE =
  "In the Timeline, Record plays the plan. Switch to Session to play scenes by hand.";

/** The Session view's tap sentence, before the bar it is written from. */
const PLAN_HAND_NOTE = "Tap a block to play its scene on the next bar.";

test("Plan UI: By hand names the write bar in Session and one line in the Timeline", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);

  assert.equal(viewOf(ui).mode, "session", "the page opens in the Session view");
  assert.equal(viewOf(ui).planMode, "hand", "with By hand chosen");
  assert.equal(
    planModeNoteText(ui),
    PLAN_HAND_NOTE + " Writes into the plan from bar 1.",
    "the Session note says what a tap plays and the bar the take is written from",
  );
  assert.ok(ui.document.querySelector("[data-role=scene-plan-undo-note]"), "and one undo beside it");

  // The bar the note names is the arrangement playhead's, read as the note is
  // drawn: arrangement bar 4 is bar 5 of the note.
  await standPlayheadAt(ui, 4);
  assert.equal(viewOf(ui).planMode, "hand", "the take still plays scenes by hand");
  assert.equal(viewOf(ui).playhead, 4, "the playhead was left on arrangement bar 4");
  assert.equal(
    planModeNoteText(ui),
    PLAN_HAND_NOTE + " Writes into the plan from bar 5.",
    "and the note follows the playhead",
  );

  // The Timeline answers with one line about Record, and the undo note is gone.
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  assert.equal(planModeNoteText(ui), PLAN_HAND_TIMELINE_NOTE, "the Timeline says Record plays the plan there");
  assert.equal(ui.document.querySelector("[data-role=scene-plan-undo-note]"), null, "one line, not two");
  assert.equal(
    planModeNoteText(ui).indexOf("Switch to Session") > 0,
    true,
    "and names the view where a scene is played by hand",
  );

  // Back in Session the tap sentence and the undo note are back with it, and a
  // switch into the Timeline has put the playhead back on bar 1, which is the bar
  // the note reads there.
  ui.click("[data-act=mode-session]");
  await ui.settle();
  assert.equal(viewOf(ui).playhead, 0, "switching into the Timeline put the playhead back on bar 1");
  assert.equal(planModeNoteText(ui), PLAN_HAND_NOTE + " Writes into the plan from bar 1.", "the Session note is back");
  assert.ok(ui.document.querySelector("[data-role=scene-plan-undo-note]"), "and the undo note with it");
});

test("Plan UI: a plan of sections alone does not invite a tap", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "section.add", { id: "s-only", start_bar: 0, end_bar: 4, name: "Chorus" });
  await ui.pushState();

  assert.deepEqual(planBlockLabels(ui), ["Chorus"], "the plan is the section alone");
  const text = planModeNoteText(ui);
  assert.doesNotMatch(text, /Tap a block/, "no scene block is on the plan, so nothing says to tap one");
  assert.match(text, /Sections are only marks/, "it says what a section is");
  assert.match(text, /a scene is what a tap plays/, "and that a scene is what plays");
  assert.match(text, /from bar 1/, "and still names the bar the take is written from");

  // A placement outside the section puts a scene block on the plan, and the tap
  // sentence comes back with it.
  runCommand(ui.doc, "arrangement.place", {
    id: "p-late",
    track_id: AUDIO_TRACK,
    clip_id: CLIP,
    start_bar: 8,
    bars: 2,
  });
  await ui.pushState();
  assert.deepEqual(planBlockLabels(ui), ["Chorus", "Verse"], "the plan has a scene block now");
  assert.equal(planModeNoteText(ui), PLAN_HAND_NOTE + " Writes into the plan from bar 1.",
    "and the note invites the tap again");
});

test("Plan UI: a refused Record click in Follow leaves the view where it was", async () => {
  const ui = await bootPanel({ clip: true, takes: [{ id: T_OLD }], latency: CALIBRATED, countIn: 1 });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  assert.equal(ui.page.__studioTest.setPunch(4, 6), true, "the range fits the clip as it stands");
  await ui.settle();
  await shortenClip(ui, 1);
  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();
  assert.equal(viewOf(ui).planMode, "follow", "the take follows the plan");
  assert.equal(viewOf(ui).mode, "session", "from the Session view");
  const modes = ui.engine.modes.length;
  const commandsBefore = commandsSent(ui);

  ui.click("[data-act=record]");
  await ui.settle(24);

  assert.equal(viewOf(ui).mode, "session", "the refused click left the view where the operator put it");
  assert.equal(ui.engine.modes.length, modes, "and moved no voice with it");
  assert.equal(viewOf(ui).rec, null, "no take was made");
  assert.equal(ui.engine.plays, 0, "the transport was never started");
  assert.equal(ui.engine.recorders.length, 0, "and no recorder was built");
  assert.equal(commandsSent(ui), commandsBefore, "nothing was written");
  assert.ok(
    noticeText(ui).includes("The punch range is outside this clip."),
    `the page says why (got: ${noticeText(ui)})`,
  );
});

test("Plan UI: the Session view outlines the scene that is playing, not the transport's bar", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  // A block that is scrolled into view says so, so the strip's own scroll is
  // visible to the case: the phone strip is the one thing that scrolls sideways.
  const scrolled = [];
  Object.getPrototypeOf(planBlockNodes(ui)[0]).scrollIntoView = function scrollIntoView() {
    scrolled.push(String(this.getAttribute("data-start-bar")));
  };
  ui.click("[data-act=play]");
  await ui.settle();

  // No scene has played yet, so the transport's bar is all the strip has.
  ui.engine.position({ bar: 3, beat: 1, sixteenth: 1 });
  await ui.settle();
  assert.match(String(planBlockNodes(ui)[1].className), /st-plan-block-current/,
    "with nothing playing the bar the transport is in is outlined");
  assert.deepEqual(scrolled, ["2"], "and the block it moved to is scrolled into view");

  // A launch says which scene is playing: the strip outlines ITS block, wherever
  // the transport's own bar stands.
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: null, scene_id: SCENE, bar: 0, frame: 0 }),
  );
  await ui.settle();
  const blocks = planBlockNodes(ui);
  assert.match(String(blocks[0].className), /st-plan-block-current/, "the block of the scene playing is outlined");
  assert.doesNotMatch(String(blocks[1].className), /st-plan-block-current/,
    "not the block the transport's bar falls in");
  assert.match(String(blocks[1].className), /st-plan-block-next/, "and the block after the playing one is dashed");
  assert.deepEqual(scrolled, ["2", "0"], "the block the outline moved to is scrolled into view");

  // A second position report inside the section does not move the outline: the
  // session's bar is not a bar of the plan, and the strip is not scrolled again.
  ui.engine.position({ bar: 4, beat: 1, sixteenth: 1 });
  await ui.settle();
  assert.match(String(planBlockNodes(ui)[0].className), /st-plan-block-current/, "the playing scene keeps the outline");
  assert.deepEqual(scrolled, ["2", "0"], "and the operator's own scroll is left where it is");

  // The Timeline reads the transport's own bar again.
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  const moved = planBlockNodes(ui);
  assert.match(String(moved[1].className), /st-plan-block-current/,
    "in the Timeline the block under the transport's bar is the current one");
  assert.doesNotMatch(String(moved[0].className), /st-plan-block-current/, "and the playing scene's is not");
});

test("Plan UI: Follow marks the plan's scene blocks aria-disabled and leaves the sections disabled", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  const sceneBlock = () => planBlockNodes(ui).find((node) => node.getAttribute("data-scene-id"));
  const sectionBlock = () => planBlockNodes(ui).find((node) => !node.getAttribute("data-scene-id"));
  assert.equal(sceneBlock().getAttribute("aria-disabled"), null, "a By-hand block can be tapped");

  const launched = ui.engine.launched.length;
  ui.click("[data-act=plan-mode][data-mode=follow]");
  await ui.settle();

  assert.equal(sceneBlock().getAttribute("aria-disabled"), "true", "a block that plays nothing in Follow says so");
  assert.equal(sceneBlock().disabled, false, "and is not a disabled control");
  assert.equal(sectionBlock().disabled, true, "a section keeps its disabled attribute");
  assert.equal(sectionBlock().getAttribute("aria-disabled"), "true", "and its own aria-disabled");

  ui.click(`[data-act=plan-block][data-scene-id=${SCENE}]`);
  await ui.settle(24);
  assert.equal(ui.engine.launched.length, launched, "and a press on it plays nothing");
});

test("Plan UI: in the Timeline a block tap plays nothing while a take runs", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  ui.click("[data-act=mode-arrangement]");
  await ui.settle();
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.ok(viewOf(ui).rec, "a take is open in the Timeline");
  assert.equal(viewOf(ui).planMode, "hand", "with By hand chosen");

  const launched = ui.engine.launched.length;
  ui.click(`[data-act=plan-block][data-scene-id=${SCENE}]`);
  await ui.settle(24);

  assert.equal(ui.engine.launched.length, launched, "the plan is what Record plays there, so a tap launches no scene");
  assert.ok(viewOf(ui).rec, "and the take is left exactly as it was");
  assert.equal(
    ui.document.querySelector(`[data-act=plan-block][data-scene-id=${SCENE}]`).getAttribute("aria-disabled"),
    "true",
    "the block says it plays nothing there",
  );
});

test("Plan UI: a section is one band on the lanes' ruler", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await placeThePlan(ui);
  const ruler = ui.document.querySelector("[data-role=rec-lanes]");
  assert.ok(ruler, "the lanes draw a ruler");

  const sections = Array.from(ruler.querySelectorAll("[data-role=rec-section]")).map((node) => String(node.textContent));
  const bands = Array.from(ruler.querySelectorAll(".st-lane-band")).map((node) => String(node.textContent));
  assert.deepEqual(sections, ["Chorus"], "the section is drawn in the section row");
  assert.equal(bands.indexOf("Chorus"), -1, "and not again in the plan row");
  assert.deepEqual(bands, ["Verse"], "which carries the placement's own block");
  assert.equal(
    sections.concat(bands).filter((label) => label === "Chorus").length,
    1,
    "so a section appears once on the ruler",
  );
});

// ---- R15 review fixes: the take's own origin, its seeds and its notice ------
//
// A by-hand take is written from the arrangement bar the playhead stood on, but
// the bars it HEARS are the session's: counted from play(), and carried on
// across a pause. The two axes line up only while the take begins on session bar
// 0. A take pressed while the transport already runs, or carried on from a
// pause, begins on whatever loop start the engine names — so every bar it hears
// has to be measured from that one, and the tracks that were already playing
// (the take's own included) have to be placed from there.

/** One bar of the fixture song in frames: 240 bpm, four beats, 48 kHz. */
const BAR_FRAMES = PASS_FRAMES;

/** @returns {number} the first frame of one session bar, counting from play(). */
function frameOfBar(bar) {
  return Math.round(Number(bar) * BAR_FRAMES);
}

/**
 * Point the fake engine's next loop start — where a take pressed on a running
 * transport arms — at one session bar.
 * @param {object} ui a booted panel
 * @param {number} bar
 * @param {{looping?: boolean}} [options] `{looping: false}` for the answer the
 *   engine gives when the armed slot names no loop start (an empty slot, or
 *   another clip playing): the next bar line instead, off the clip's grid.
 */
function loopStartOnBar(ui, bar, options = {}) {
  ui.engine.loopBar = Math.round(Number(bar));
  ui.engine.loopFrame = frameOfBar(bar);
  ui.engine.looping = options.looping !== false;
}

/**
 * Move the transport's reported position onto one session bar. A position
 * report counts its bars from 1, so session bar 3 is the report's bar 4.
 * @param {object} ui a booted panel
 * @param {number} bar
 */
async function transportOnBar(ui, bar) {
  ui.engine.position({ bar: Math.round(Number(bar)) + 1, beat: 1, sixteenth: 1 });
  await ui.settle();
}

/**
 * Report one launch at one session bar, the way the sequencer does when a scene
 * or a clip takes over there.
 * @param {object} ui a booted panel
 * @param {number} bar
 * @param {{track?: string, clip?: string|null, scene?: string}} [options]
 */
async function launchOnBar(ui, bar, options = {}) {
  ui.engine.launches.forEach((listener) =>
    listener({
      track_id: options.track || AUDIO_TRACK,
      clip_id: options.clip === undefined ? CLIP : options.clip,
      scene_id: options.scene === undefined ? SCENE : options.scene,
      bar: Math.round(Number(bar)),
      frame: frameOfBar(bar),
    }),
  );
  await ui.settle();
}

/**
 * Placements in a stable order, for a comparison that does not depend on the
 * order the page happened to group the tracks in.
 * @param {object[]} list
 * @returns {object[]}
 */
function placementsInOrder(list) {
  return (list || []).slice(0).sort((a, b) => {
    if (String(a.track_id) !== String(b.track_id)) return String(a.track_id) < String(b.track_id) ? -1 : 1;
    return Number(a.start_bar) - Number(b.start_bar);
  });
}

/**
 * A second track in the page's song, with an audio clip in the fixture's scene,
 * drawn the way the hub pushes one.
 * @param {object} ui a booted panel
 * @param {string} trackId
 * @param {string} clipId
 */
async function addTrackWithClip(ui, trackId, clipId) {
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "track.add", { id: trackId, name: "Keys", kind: "audio" });
  runCommand(ui.doc, "clip.add_audio", {
    clip_id: clipId,
    track_id: trackId,
    scene_id: SCENE,
    length_bars: 4,
    name: "Keys",
  });
  await ui.pushState();
}

test("R15 fix 1: a take pressed while the transport runs writes its launches from the bar it began on", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  // The session is thirteen bars in when Record is pressed, and the take arms on
  // the clip's next loop start: session bar 16.
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  await ui.settle(24);
  const view = viewOf(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed on the loop start the engine named");
  assert.equal(view.rec.anchor, frameOfBar(16), "which is session bar 16's frame");
  assert.equal(view.playhead, 4, "with the playhead still standing on arrangement bar 4");

  // One tap plays before the take's first frame (session bar 14) and another
  // four bars into it (session bar 20); Stop lands on session bar 24.
  await launchOnBar(ui, 14);
  await launchOnBar(ui, 20);
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 8, bars: 4 },
    ],
    "the take lands on the playhead's bar 4, and the tap at session bar 20 is four bars into it",
  );
  await hubApply(ui, sent);
});

test("R15 fix 1: a take carried on from a pause writes its launches from the bar it began on, not from play()", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(viewOf(ui).paused, true, "the transport stands paused on session bar 13");

  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  // One bar of clicks from where the transport stood, then the downbeat the
  // paused take carries on from: the loop start the engine names.
  ui.engine.countBar(1, frameOfBar(13));
  await ui.settle(24);
  const view = viewOf(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed after the count-in");
  assert.equal(view.rec.anchor, frameOfBar(16), "on the loop start's own frame");

  await launchOnBar(ui, 14);
  await launchOnBar(ui, 20);
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 8, bars: 4 },
    ],
    "the carried-on take lands on the playhead's bar 4, not thirteen bars past it",
  );
});

test("R15 fix 1 (pin): a take that begins on session bar 0 still writes its launches unchanged", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await pressRecord(ui);
  assert.equal(viewOf(ui).recTimeline.base_bar, 4, "the take writes from the playhead's bar");

  // The take is armed by the launch at session bar 0, and the taps after it are
  // measured from there: exactly what the page wrote before any of this.
  await reportLaunch(ui);
  await launchOnBar(ui, 2);
  await launchOnBar(ui, 6);
  await transportOnBar(ui, 9);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 2 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 6, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 10, bars: 3 },
    ],
    "each launch keeps its own bar, shifted by the playhead's bar",
  );
});

test("R15 fix 2: a take with no taps still writes the tracks that were playing when it began", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await addTrackWithClip(ui, "keys", "c-keys");
  ui.click("[data-act=play]");
  await ui.settle(24);
  // The keys are already playing when Record is pressed, and the take arms on
  // the clip's loop start at session bar 16.
  await launchOnBar(ui, 0, { track: "keys", clip: "c-keys" });
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  await ui.settle(24);
  assert.ok(viewOf(ui).rec, "the take is open");
  assert.equal(viewOf(ui).rec.active, true, "and armed on the loop start");

  // No tap at all: Stop lands two passes after the take began.
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "a take that played nothing new is still one record_performance");
  assert.deepEqual(
    placementsInOrder(sent[0].args.placements),
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 8 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 4, bars: 8 },
    ],
    "the take's own clip and the clip already playing are placed from the playhead over its two passes",
  );

  // The armed track is placed with the clip the arm made, even when its slot was
  // empty and nothing on it was playing: the take recorded it, so it lands.
  const empty = await bootPanel();
  await standPlayheadAt(empty, 4);
  empty.click("[data-act=play]");
  await empty.settle(24);
  loopStartOnBar(empty, 16);
  await pressRecord(empty);
  await empty.settle(24);
  const added = empty.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got one clip when the take armed");
  await transportOnBar(empty, 24);
  empty.click("[data-act=stop]");
  await empty.settle(24);

  const only = performances(empty);
  assert.equal(only.length, 1, "the take is one record_performance");
  assert.deepEqual(
    only[0].args.placements,
    [{ track_id: AUDIO_TRACK, clip_id: added[0].args.clip_id, start_bar: 4, bars: 8 }],
    "placed from the playhead over its passes, under the clip the arm made",
  );
});

test("R15 fix 3: a scene tapped just before Record that plays before the anchor seeds one placement at the anchor", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  await ui.settle(24);
  assert.ok(viewOf(ui).rec, "the take is open");
  assert.equal(viewOf(ui).rec.active, true, "and armed on session bar 16's loop start");

  // A scene tapped a moment before Record fires on the next bar, session bar 14:
  // it is what plays when the take begins, so it seeds a placement AT the anchor
  // and never one of its own before it.
  await launchOnBar(ui, 14);
  await launchOnBar(ui, 20);
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 8, bars: 4 },
    ],
    "the scene that was playing starts at the playhead's bar, not four bars before it",
  );
  assert.equal(
    sent[0].args.placements.some((placement) => Number(placement.start_bar) === 18),
    false,
    "session bar 14 is not written as a placement of its own",
  );
});

test("R15 fix 4: a take cancelled while the transport runs leaves the operator's own collection whole", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  ui.click("[data-act=rec-timeline]");
  await ui.settle();
  ui.click("[data-act=play]");
  await ui.settle(24);
  await launchOnBar(ui, 0);
  await launchOnBar(ui, 4);
  assert.equal(viewOf(ui).recTimeline.launches.length, 2, "the toggle collected the two launches");

  // The recorder cannot be built: the take is cancelled, and the transport it
  // was pressed against keeps running.
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  ui.engine.createRecorder = async () => {
    throw new Error("The input could not be opened.");
  };
  loopStartOnBar(ui, 16);
  const before = commandsSent(ui);
  const playsBefore = ui.engine.plays;
  ui.click("[data-act=record]");
  await ui.settle(24);
  assert.equal(viewOf(ui).rec, null, "the take was cancelled");
  assert.equal(viewOf(ui).playing, true, "and the transport keeps running");
  assert.equal(ui.engine.plays, playsBefore, "the click started no transport of its own");
  assert.equal(commandsSent(ui), before, "and sent no command");
  assert.equal(
    ui.sent.filter((message) => message.command === "clip.add_audio").length,
    0,
    "so no clip was made for it",
  );
  assert.ok(
    toastText(ui).includes("Turn off Record to timeline to record a performance by hand."),
    `the page says why (got: ${toastText(ui)})`,
  );

  // The clip keeps sounding after the press, so Stop lands six bars later, and
  // the toggle's own collection is written whole on its own bars.
  await transportOnBar(ui, 10);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "Stop wrote the operator's own collection, once");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 0, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 6 },
    ],
    "the two launches closed by the next launch and by the bar the transport stopped on",
  );
});

test("R15 fix 6: a performance the wire could not carry is held, and Place what fits sends it once it is back", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await pressRecord(ui);
  await reportLaunch(ui);
  await launchOnBar(ui, 2);
  await transportOnBar(ui, 4);

  // The socket is gone when Stop is pressed.
  await ui.dropSocket();
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const held = viewOf(ui).performance;
  assert.ok(held, "the performance is kept on the page");
  assert.equal(held.message, "Not sent: the connection dropped.", "with what went wrong");
  const notice = ui.document.querySelector("[data-role=performance-notice]");
  assert.equal(notice.hidden, false, "and the notice stays up with it");
  assert.ok(
    String(notice.textContent).includes("Not sent: the connection dropped."),
    "saying the performance was not sent",
  );

  // The wire comes back: the held performance can still be placed.
  await ui.rejoin();
  ui.click("[data-act=performance-fit]");
  await ui.settle(24);
  const sent = performances(ui);
  assert.equal(sent.length, 1, "Place what fits sends it once the socket is back");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 2 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 6, bars: 2 },
    ],
    "every placement of it, nothing on the timeline being in the way",
  );
});

test("R15 fix 7: a page torn down or unloaded mid-take still writes one record_performance", async () => {
  /** @returns {Promise<object>} a page with a by-hand take running, one tap in. */
  const started = async () => {
    const ui = await bootPanel({ clip: true, lengthBars: 4 });
    await standPlayheadAt(ui, 4);
    await pressRecord(ui);
    await reportLaunch(ui);
    await launchOnBar(ui, 2);
    await transportOnBar(ui, 4);
    assert.equal(viewOf(ui).rec.active, true, "the take is recording");
    return ui;
  };

  // Turbo caches the page (or a visit starts) with the take still running.
  const leaving = await started();
  leaving.document.dispatchEvent(new leaving.document.defaultView.Event("turbo:before-cache"));
  await leaving.settle();
  leaving.engine.recorders[0].done({ segments: [] });
  await leaving.settle(24);
  assert.equal(performances(leaving).length, 1, "the take's launches are written once, on the way out");

  // The browser's own leave-page path.
  const unloading = await started();
  unloading.fireWindow("beforeunload", unloading.event("beforeunload", {}));
  await unloading.settle();
  unloading.engine.recorders[0].done({ segments: [] });
  await unloading.settle(24);
  assert.equal(performances(unloading).length, 1, "and once from onBeforeUnload");
});

test("R15 fix 9: Place what fits keeps only what the timeline can take and says how many it placed", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await addTrackWithClip(ui, "keys", "c-keys");
  // A third track whose clip the song does not hold: a launch can name one the
  // snapshot has never had.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "track.add", { id: "pad", name: "Pad", kind: "audio" });
  await ui.pushState();

  await pressRecord(ui);
  await reportLaunch(ui);
  await launchOnBar(ui, 6, { track: "keys", clip: "c-keys" });
  await launchOnBar(ui, 6, { track: "pad", clip: "c-pad" });
  // A placement that ends past bar 999, and the same take's plain one.
  await launchOnBar(ui, 994);
  await launchOnBar(ui, 998);
  await launchOnBar(ui, 1000);
  await transportOnBar(ui, 9);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const first = performances(ui);
  assert.equal(first.length, 1, "the take is one record_performance");
  assert.deepEqual(
    placementsInOrder(first[0].args.placements),
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 994 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 998, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 1002, bars: 2 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 10, bars: 3 },
      { track_id: "pad", clip_id: "c-pad", start_bar: 10, bars: 3 },
    ],
    "the performance holds the placements past bar 999 and the one whose clip is gone",
  );

  // The hub refuses the whole performance for the bar it would end past.
  ui.frame({
    type: "result",
    cmd_id: first[0].cmd_id,
    ok: false,
    error: "Placement at bar 998 would end past bar 999.",
  });
  await ui.settle();
  assert.equal(
    ui.document.querySelector("[data-role=performance-notice]").hidden,
    false,
    "the refusal is held on the page",
  );

  ui.click("[data-act=performance-fit]");
  await ui.settle(24);
  const again = performances(ui);
  assert.equal(again.length, 2, "Place what fits is one more record_performance");
  assert.deepEqual(
    placementsInOrder(again[1].args.placements),
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 994 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 10, bars: 3 },
    ],
    "only the placements inside the arrangement whose clip the song holds",
  );
  assert.equal(
    toastText(ui),
    "Sending 2 of 5; the rest overlap or do not fit.",
    `the page says what it is sending (got: ${toastText(ui)})`,
  );
});

test("R15 fix 10: the performance notice is hidden until a refusal gives it a reason", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await pressRecord(ui);
  await reportLaunch(ui);
  await transportOnBar(ui, 2);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "Stop sent the performance");
  // Nothing has come back yet: the page has no reason to give, so it says
  // nothing rather than "The performance was not placed: ".
  const notice = ui.document.querySelector("[data-role=performance-notice]");
  assert.equal(notice.hidden, true, "the notice is not up before the hub answers");
  assert.equal(
    String(notice.textContent).includes("The performance was not placed: "),
    false,
    "and it carries no refusal without a reason",
  );

  // The hub refuses it: now the notice is up, with the server's own words.
  ui.frame({
    type: "result",
    cmd_id: sent[0].cmd_id,
    ok: false,
    error: "Placement at bar 4 overlaps the one there.",
  });
  await ui.settle();
  assert.equal(notice.hidden, false, "a refusal puts the notice up");
  assert.ok(
    String(notice.textContent).includes("Placement at bar 4 overlaps the one there."),
    "with the reason it gave",
  );
});

// ---- R15 review round 3: the origin of every arm, the collections, the wire ----
//
// A take armed on a bar line (an empty slot, another clip playing, a paused
// resume) heard its launches on the same session axis as one armed on a loop
// start, so it has to be written from that bar too. The launches the toggle had
// already collected belong to the toggle's own axis, so a take never moves them
// to its base bar: the toggle keeps them, and a Stop writes them as it always
// has.

test("R15 r3 fix 1: a take armed on the next bar line writes from the session bar it began on", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  // Thirteen bars into the song, Record is pressed on a track whose slot is not
  // the clip playing: the engine answers the next bar line (looping false),
  // which is session bar 14.
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 14, { looping: false });
  await pressRecord(ui);
  await ui.settle(24);
  const view = viewOf(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed on the bar line the engine named");
  assert.equal(view.rec.anchor, frameOfBar(14), "which is session bar 14's frame");
  assert.equal(view.playhead, 4, "with the playhead still standing on arrangement bar 4");

  // One tap at session bar 20, and Stop on session bar 24.
  await launchOnBar(ui, 20);
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 6 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 10, bars: 4 },
    ],
    "the take begins on the playhead's bar 4, so the tap at session bar 20 lands six bars in",
  );
});

test("R15 r3 fix 1: a take carried on from a pause onto a bar line writes from that session bar", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(viewOf(ui).paused, true, "the transport stands paused on session bar 13");

  // The clip it records into is not the one playing, so the loop question is
  // answered with the next bar line: session bar 14, off the clip's grid.
  loopStartOnBar(ui, 14, { looping: false });
  await pressRecord(ui);
  ui.engine.countBar(1, frameOfBar(13));
  await ui.settle(24);
  const view = viewOf(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed on the bar line the engine named");
  assert.equal(view.rec.anchor, frameOfBar(14), "on session bar 14's own frame");

  await launchOnBar(ui, 14);
  await launchOnBar(ui, 20);
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 6 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 10, bars: 4 },
    ],
    "each launch is measured from the bar the take began on, not from play()",
  );
});

test("R15 r3 fix 1: a paused count-in with no loop answer measures from the bar it resumes on", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(viewOf(ui).paused, true, "the transport stands paused on session bar 13");

  // No loop start to ask the engine for: the arm falls back to the count-in's
  // own downbeat, and the bar the transport carried on from is where the take's
  // launches are measured from.
  delete ui.engine.nextLoopFrame;
  await pressRecord(ui);
  ui.engine.countBar(1, frameOfBar(13));
  await ui.settle(24);
  const view = viewOf(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed on the count-in's downbeat");
  assert.equal(view.rec.anchor, frameOfBar(13), "which is session bar 13's frame");
  assert.equal(
    view.recTimeline.origin_bar,
    13,
    "and the session bar the transport resumed on is the origin its launches are written from",
  );
});

test("R15 r3 fix 2: a take into an empty slot on a bar line writes the recorded clip's placement", async () => {
  const ui = await bootPanel();
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 14, { looping: false });
  await pressRecord(ui);
  await ui.settle(24);
  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got one clip when the take armed");
  assert.equal(viewOf(ui).rec.active, true, "and the take is recording into it");

  // No tap at all: Stop lands at session bar 24, ten bars after the take began.
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "a take that played nothing new is still one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [{ track_id: AUDIO_TRACK, clip_id: added[0].args.clip_id, start_bar: 4, bars: 10 }],
    "the recorded clip is placed from the playhead over the take's own passes",
  );
});

test("R15 r3 fix 3: a view switch leaves no launch behind to seed a take", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await addTrackWithClip(ui, "keys", "c-keys");
  ui.click("[data-act=play]");
  await ui.settle(24);
  await launchOnBar(ui, 0, { track: "keys", clip: "c-keys" });
  ui.click("[data-act=stop]");
  await ui.settle(24);

  // The operator visits the Timeline to leave the playhead on bar 4 and comes
  // back: the switch empties the session, so the keys are not playing any more
  // when Record is pressed.
  await standPlayheadAt(ui, 4);
  assert.equal(viewOf(ui).playhead, 4, "the playhead stands on arrangement bar 4");
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  await ui.settle(24);
  assert.equal(viewOf(ui).rec.active, true, "the take is armed");

  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    placementsInOrder(sent[0].args.placements),
    [{ track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 8 }],
    "only the armed track is placed: the keys were silent for the whole take",
  );
  assert.equal(
    sent[0].args.placements.some((placement) => String(placement.track_id) === "keys"),
    false,
    "so nothing of the keys is written into the plan",
  );
});

test("R15 r4: Record by hand with the toggle on is refused at the click and writes nothing", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await addTrackWithClip(ui, "keys", "c-keys");
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=rec-timeline]");
  await ui.settle();
  assert.equal(viewOf(ui).recTimeline.on, true, "the operator turned the toggle on");
  ui.click("[data-act=play]");
  await ui.settle(24);
  // The keys are played by hand while the toggle collects performances, so its
  // own collection has bars of its own and the take would write on another axis.
  await launchOnBar(ui, 0, { track: "keys", clip: "c-keys" });
  await launchOnBar(ui, 4, { track: "keys", clip: "c-keys" });
  const collected = JSON.parse(JSON.stringify(viewOf(ui).recTimeline.launches));
  assert.equal(collected.length, 2, "the toggle collected the two launches");

  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  loopStartOnBar(ui, 16);
  const before = commandsSent(ui);
  const playsBefore = ui.engine.plays;

  ui.click("[data-act=record]");
  await ui.settle(24);

  const view = viewOf(ui);
  assert.equal(view.rec, null, "no take was started");
  assert.equal(view.playing, true, "and the transport the operator runs is left running");
  assert.equal(ui.engine.recorders.length, 0, "no recorder was built for a take");
  assert.equal(countInPlays(ui).length, 0, "and no count-in was started");
  assert.equal(ui.engine.plays, playsBefore, "the click moved no transport of its own");
  assert.equal(commandsSent(ui), before, "it wrote nothing");
  assert.equal(performances(ui).length, 0, "and no performance went on the wire");
  assert.ok(
    toastText(ui).includes("Turn off Record to timeline to record a performance by hand."),
    `the page says why (got: ${toastText(ui)})`,
  );
  assert.equal(view.recTimeline.on, true, "the toggle is left where the operator put it");
  assert.deepEqual(view.recTimeline.launches, collected, "and its collection is still whole");

  // Stop is the toggle's own stop: the whole collection is written once, from
  // the first launch to the bar the transport stopped on.
  await transportOnBar(ui, 10);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "Stop wrote the toggle's collection, once");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: "keys", clip_id: "c-keys", start_bar: 0, bars: 4 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 4, bars: 6 },
    ],
    "each launch closed by the next one, the last by the stop bar",
  );
  await hubApply(ui, sent);
});

test("R15 r4: a take pressed on a running transport is written on its own axis, and the hub takes it", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await addTrackWithClip(ui, "keys", "c-keys");
  assert.equal(viewOf(ui).recTimeline.on, false, "the operator left the toggle off");
  ui.click("[data-act=play]");
  await ui.settle(24);
  // The keys are launched from session bar 0 while the toggle is off, so nothing
  // collected them: they are what plays across the press.
  await launchOnBar(ui, 0, { track: "keys", clip: "c-keys" });
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  await ui.settle(24);
  const view = viewOf(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed on the loop start the engine named");
  assert.equal(view.rec.anchor, frameOfBar(16), "which is session bar 16's frame");
  assert.equal(view.playhead, 4, "with the playhead still standing on arrangement bar 4");

  // A tap on the keys four bars into the take (session bar 20), and Stop on
  // session bar 24.
  await launchOnBar(ui, 20, { track: "keys", clip: "c-keys" });
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: "keys", clip_id: "c-keys", start_bar: 4, bars: 4 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 8, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 8 },
    ],
    "the take begins on arrangement bar 4, the tap at session bar 20 is eight, and Stop is twelve",
  );
  // The recorded clip and the keys are placed on tracks of their own, so the
  // song holds both: the hub's own command is what says so.
  await hubApply(ui, sent);
});

test("R15 r4: a take over a clip that keeps sounding is written from its own bar, and the hub takes it", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  assert.equal(viewOf(ui).recTimeline.on, false, "the operator left the toggle off");
  assert.equal(viewOf(ui).playhead, 0, "the arrangement playhead stands on bar 1");
  ui.click("[data-act=play]");
  await ui.settle(24);
  // The armed track's own clip is playing when Record is pressed, and keeps
  // playing across the press.
  await launchOnBar(ui, 0);
  await transportOnBar(ui, 6);
  loopStartOnBar(ui, 8);
  await pressRecord(ui);
  await ui.settle(24);
  assert.ok(viewOf(ui).rec, "the take is open");
  assert.equal(viewOf(ui).rec.active, true, "and armed on the loop start the engine named");
  assert.equal(viewOf(ui).rec.anchor, frameOfBar(8), "which is session bar 8's frame");

  await transportOnBar(ui, 12);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [{ track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 0, bars: 4 }],
    "the clip that played across the press is placed from the playhead's bar, four bars of it",
  );
  await hubApply(ui, sent);
});

test("R15 r5 fix 1: a toggle click mid-take takes nothing away from the take's own collection", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  const toggle = () => ui.document.querySelector("[data-act=rec-timeline]");
  const view = viewOf(ui);
  await standPlayheadAt(ui, 4);
  await addTrackWithClip(ui, "keys", "c-keys");
  assert.equal(view.recTimeline.on, false, "the operator left the toggle off");
  assert.equal(toggle().disabled, false, "and it is a live control");
  ui.click("[data-act=play]");
  await ui.settle(24);
  // The keys are launched from session bar 0 while the toggle is off, so nothing
  // collected them: they are what plays across the press.
  await launchOnBar(ui, 0, { track: "keys", clip: "c-keys" });
  await transportOnBar(ui, 13);
  loopStartOnBar(ui, 16);
  await pressRecord(ui);
  await ui.settle(24);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.active, true, "and armed on the loop start the engine named");
  assert.equal(view.recTimeline.on, true, "the take collects what it plays");
  assert.equal(view.recTimeline.forced, true, "because the take is what turned the toggle on");
  assert.equal(view.recTimeline.base_bar, 4, "from the bar the playhead stood on");
  assert.equal(toggle().getAttribute("aria-pressed"), "true", "and the toggle shows it");
  assert.equal(toggle().disabled, true, "while it is drawn disabled for the take");
  assert.ok(
    String(toggle().title).includes("stop the take first"),
    `its title says what has to happen first (got: ${toggle().title})`,
  );

  const collected = JSON.parse(JSON.stringify(view.recTimeline.launches));
  ui.click("[data-act=rec-timeline]");
  await ui.settle();

  assert.equal(view.recTimeline.on, true, "a click mid-take leaves the collection on");
  assert.equal(view.recTimeline.forced, true, "still the take's own");
  assert.deepEqual(view.recTimeline.launches, collected, "and takes nothing it collected away");
  assert.equal(toggle().getAttribute("aria-pressed"), "true", "the button still shows the collection");
  assert.ok(
    toastText(ui).includes("Stop the take first."),
    `and the page says why (got: ${toastText(ui)})`,
  );

  // The take carries on: a tap on the keys four bars in, and Stop on session
  // bar 24.
  await launchOnBar(ui, 20, { track: "keys", clip: "c-keys" });
  await transportOnBar(ui, 24);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the whole take is one record_performance");
  assert.deepEqual(
    placementsInOrder(sent[0].args.placements),
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 8 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 4, bars: 4 },
      { track_id: "keys", clip_id: "c-keys", start_bar: 8, bars: 4 },
    ],
    "nothing the click could have dropped is missing from it",
  );
  await hubApply(ui, sent);

  // Stop puts the toggle back where the operator had it, and the button is a
  // live control again.
  assert.equal(view.recTimeline.on, false, "the toggle is off again");
  assert.equal(view.recTimeline.forced, false, "with no take holding it");
  assert.equal(toggle().disabled, false, "so the button is live again");
  assert.equal(toggle().getAttribute("aria-pressed"), "false", "with nothing pressed");
  assert.ok(
    String(toggle().title).includes("Collect the scene launches"),
    `and its own title back (got: ${toggle().title})`,
  );
});

test("R15 r5 fix 1: a toggle click during the count-in takes nothing away, and Stop still writes the take", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  const toggle = () => ui.document.querySelector("[data-act=rec-timeline]");
  const view = viewOf(ui);
  await standPlayheadAt(ui, 4);
  await pressRecord(ui);
  assert.ok(view.rec, "the take is open");
  assert.equal(view.rec.counting, true, "and counting in");
  assert.equal(view.recTimeline.on, true, "the take turned the collection on");
  assert.equal(view.recTimeline.forced, true, "for its own duration");
  assert.equal(toggle().disabled, true, "so the toggle is drawn disabled, the count-in included");

  // The clicks run; a click on the toggle while they do changes nothing.
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  const collected = JSON.parse(JSON.stringify(view.recTimeline.launches));
  ui.click("[data-act=rec-timeline]");
  await ui.settle();
  assert.equal(view.recTimeline.on, true, "a click while the clicks run leaves the collection on");
  assert.equal(view.recTimeline.forced, true, "still the take's own");
  assert.deepEqual(view.recTimeline.launches, collected, "and holds what it held");
  assert.ok(
    toastText(ui).includes("Stop the take first."),
    `and the page says why (got: ${toastText(ui)})`,
  );

  // The last click arms the take on the count-in's downbeat, and the launch the
  // downbeat plays is the one the plan gets.
  clockAtFrame(ui, LAST_CLICK_FRAME);
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: LAST_CLICK_FRAME, play_frame: 96000 });
  await ui.settle(24);
  assert.equal(view.rec.active, true, "the take is armed on the downbeat the count-in announced");
  ui.engine.launches.forEach((listener) =>
    listener({ track_id: AUDIO_TRACK, clip_id: CLIP, scene_id: SCENE, bar: 0, frame: 96000 }),
  );
  await ui.settle();
  ui.engine.countIn({ type: "count_in_done", frame: 96000 });
  await ui.settle(24);
  assert.equal(view.rec.preroll, false, "the take begins on the downbeat");

  // A tap four bars in, and Stop on session bar 10.
  await launchOnBar(ui, 4);
  await transportOnBar(ui, 10);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 4 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 8, bars: 6 },
    ],
    "the take begins on the playhead's bar 4, so the tap at session bar 4 lands on bar 8",
  );
  await hubApply(ui, sent);

  assert.equal(view.recTimeline.on, false, "Stop puts the toggle back to off");
  assert.equal(view.recTimeline.forced, false, "with no take holding it");
  assert.equal(toggle().disabled, false, "so it is a live control again");
  assert.equal(toggle().getAttribute("aria-pressed"), "false", "with nothing pressed");
});

test("R15 r4: the Session note says it writes into the plan from a bar only while the toggle is off", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  assert.equal(viewOf(ui).mode, "session", "the page opens in the Session view");
  assert.equal(viewOf(ui).planMode, "hand", "with By hand chosen");
  assert.equal(viewOf(ui).recTimeline.on, false, "and the toggle off");
  assert.ok(
    planModeNoteText(ui).includes("Writes into the plan from bar"),
    `the note names the bar the take is written from (got: ${planModeNoteText(ui)})`,
  );

  // With the toggle on, a take never runs, so the note stops promising a
  // performance written from a bar.
  ui.click("[data-act=rec-timeline]");
  await ui.settle();
  assert.equal(viewOf(ui).recTimeline.on, true, "the operator turned the toggle on");
  assert.equal(
    planModeNoteText(ui).includes("Writes into the plan from bar"),
    false,
    `the note no longer promises a write from a bar (got: ${planModeNoteText(ui)})`,
  );

  ui.click("[data-act=rec-timeline]");
  await ui.settle();
  assert.equal(viewOf(ui).recTimeline.on, false, "and turning it off again");
  assert.ok(
    planModeNoteText(ui).includes("Writes into the plan from bar"),
    `brings the note back (got: ${planModeNoteText(ui)})`,
  );

  // A by-hand take turns the collection on for its own duration, and what it
  // writes is written from the playhead's bar: the note names it while the take
  // runs, and once it is over.
  await pressRecord(ui);
  assert.equal(viewOf(ui).recTimeline.forced, true, "the take turned the toggle on");
  assert.ok(
    planModeNoteText(ui).includes("Writes into the plan from bar"),
    `the note names the bar the take writes from (got: ${planModeNoteText(ui)})`,
  );
  ui.click("[data-act=stop]");
  await ui.settle(24);
  assert.equal(viewOf(ui).rec, null, "the take is over");
  assert.ok(
    planModeNoteText(ui).includes("Writes into the plan from bar"),
    `and it still names it (got: ${planModeNoteText(ui)})`,
  );
});

/**
 * A by-hand take whose performance holds three placements, only one of which
 * the timeline can take: the armed track's own seed is the one that fits, the
 * rest run past the arrangement's last bar, and the pad names a clip the song
 * does not hold.
 *
 * The take arms from a scene launch on session bar 0, so its bars are measured
 * the same way before and after the round-3 fixes: the set is stable and the
 * refusal is about the arrangement's room, not about a take's origin.
 *
 * @returns {Promise<{ui: object, refused: object}>} the panel, and the one
 *   record_performance the hub refused
 */
async function refusedThreePlacementPerformance() {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "track.add", { id: "pad", name: "Pad", kind: "audio" });
  await ui.pushState();

  await pressRecord(ui);
  await reportLaunch(ui);
  await launchOnBar(ui, 6, { track: "pad", clip: "c-pad" });
  await launchOnBar(ui, 990);
  await transportOnBar(ui, 1000);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    placementsInOrder(sent[0].args.placements),
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 990 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 994, bars: 10 },
      { track_id: "pad", clip_id: "c-pad", start_bar: 10, bars: 994 },
    ],
    "the performance holds one placement the arrangement can take and two it cannot",
  );

  // The hub refuses the whole performance for the bar it would end past.
  ui.frame({
    type: "result",
    cmd_id: sent[0].cmd_id,
    ok: false,
    error: "Placement at bar 994 would end past bar 999.",
  });
  await ui.settle();
  assert.equal(
    ui.document.querySelector("[data-role=performance-notice]").hidden,
    false,
    "the refusal is held on the page",
  );
  return { ui, refused: sent[0] };
}

test("R15 r3 fix 6: Place what fits says nothing was placed while the wire is down", async () => {
  const { ui } = await refusedThreePlacementPerformance();
  await ui.dropSocket();

  ui.click("[data-act=performance-fit]");
  await ui.settle(24);

  assert.equal(performances(ui).length, 1, "nothing of it went on the wire");
  assert.equal(
    /^(Placed|Sending)/.test(toastText(ui)),
    false,
    `the page claims nothing was placed or sent (got: ${toastText(ui)})`,
  );
  const held = viewOf(ui).performance;
  assert.ok(held, "the part that fits is kept on the page");
  assert.equal(held.message, "Not sent: the connection dropped.", "with what went wrong");
  assert.ok(
    String(ui.document.querySelector("[data-role=performance-notice]").textContent).includes(
      "Not sent: the connection dropped.",
    ),
    "and the notice says it was not sent",
  );
});

test("R15 r3 fix 6: Place what fits says what it is sending, not what was placed", async () => {
  const { ui } = await refusedThreePlacementPerformance();

  ui.click("[data-act=performance-fit]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 2, "Place what fits is one more record_performance");
  assert.deepEqual(
    sent[1].args.placements,
    [{ track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 990 }],
    "only the placement the timeline has room for",
  );
  assert.equal(
    toastText(ui),
    "Sending 1 of 3; the rest overlap or do not fit.",
    `the page words the toast as what it sent (got: ${toastText(ui)})`,
  );
});

test("R15 r3 fix 8: a performance sent before the socket dropped says the hub never answered", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  await pressRecord(ui);
  await reportLaunch(ui);
  await launchOnBar(ui, 2);
  await transportOnBar(ui, 4);

  // Stop sends the performance and the socket goes away before the answer.
  ui.click("[data-act=stop]");
  await ui.settle(24);
  const sent = performances(ui);
  assert.equal(sent.length, 1, "Stop sent the performance");
  await ui.dropSocket();

  const notice = ui.document.querySelector("[data-role=performance-notice]");
  assert.equal(notice.hidden, false, "the notice is up after the drop");
  assert.ok(
    String(notice.textContent).includes("The connection dropped before the hub answered."),
    `with the reason it never came back (got: ${String(notice.textContent)})`,
  );

  // The wire comes back: the held performance can still be placed, once.
  await ui.rejoin();
  ui.click("[data-act=performance-fit]");
  await ui.settle(24);
  const again = performances(ui);
  assert.equal(again.length, 2, "Place what fits sends it once the socket is back");
  assert.deepEqual(
    again[1].args.placements,
    sent[0].args.placements,
    "every placement of it, nothing on the timeline being in the way",
  );
});

test("R15 r3 fix 9: a paused count-in whose loop question fails cancels the take and says so", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4, countIn: 1 });
  await standPlayheadAt(ui, 4);
  ui.click("[data-act=play]");
  await ui.settle(24);
  await transportOnBar(ui, 13);
  ui.click("[data-act=pause]");
  await ui.settle();
  assert.equal(viewOf(ui).paused, true, "the transport stands paused on session bar 13");

  // The engine cannot say where the clip's loop starts: the arm's own question
  // is refused, and the take it was arming goes with it.
  ui.engine.nextLoopFrame = () => Promise.reject(new Error("The engine could not answer."));
  await pressRecord(ui);
  ui.engine.countBar(1, frameOfBar(13));
  await ui.settle(24);

  assert.equal(viewOf(ui).rec, null, "the take is cancelled, not left waiting for an arm");
  assert.equal(viewOf(ui).playing, false, "and the transport it started is stopped");
  assert.ok(
    toastText(ui).includes("The engine could not answer."),
    `the page says what went wrong (got: ${toastText(ui)})`,
  );
});

// ---- R15 review round 4: one write per run, and the song takes it -----------
//
// A take that plays scenes by hand and the operator's own Record to timeline
// toggle write the plan from different bars, so a Record press that would have
// to do both asks for the toggle to be turned off first. One press is one
// performance, and every performance is applied through the hub's own command
// here: a set of placements the song cannot hold fails the case that sent it.

test("R15 r4: by-hand take placements are applied through the hub in the existing launch flow", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 4 });
  await standPlayheadAt(ui, 4);
  assert.equal(viewOf(ui).recTimeline.on, false, "the take is pressed with the toggle off");

  await pressRecord(ui);
  await reportLaunch(ui);
  await launchOnBar(ui, 2);
  await transportOnBar(ui, 4);
  ui.click("[data-act=stop]");
  await ui.settle(24);

  const sent = performances(ui);
  assert.equal(sent.length, 1, "the take is one record_performance");
  assert.deepEqual(
    sent[0].args.placements,
    [
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 4, bars: 2 },
      { track_id: AUDIO_TRACK, clip_id: CLIP, start_bar: 6, bars: 2 },
    ],
    "the record scene's launch and the tap, each closed by the next one and by the stop bar",
  );
  await hubApply(ui, sent);
});