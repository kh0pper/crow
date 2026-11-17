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
    /** Walk a count-in of `bars` bars from its start to its downbeat. */
    countBar(bars = 1, playFrame = 96000, beatFrames = 12000) {
      const beats = bars * 4;
      engine.countIn({ type: "count_in_start", play_frame: playFrame });
      for (let beat = 1; beat <= beats; beat += 1) {
        engine.countIn({
          type: "count_in",
          beat,
          beats,
          frame: playFrame - (beats - beat) * beatFrames,
          play_frame: playFrame,
        });
      }
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
 *          hold?: Promise<void>, confirm?: boolean, countIn?: number,
 *          storage?: object, clip?: boolean, failInput?: boolean,
 *          respond?: (url: string, init: object) => ({status: number, body: object}|null)}} [options]
 */
async function bootPanel(options = {}) {
  const { parseHTML } = await import("linkedom");
  const { pathToFileURL } = await import("node:url");
  const { encodeDocState } = await import("../bundles/studio/server/doc.js");
  const { CLIENT_SCRIPT } = await import("../bundles/studio/panel/client.js");
  const { TAKE_STORE_SCRIPT } = await import("../bundles/studio/panel/take-store.js");
  const { PUNCH_SCRIPT } = await import("../bundles/studio/panel/punch.js");

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

  // The punch rules are emitted before the client as well, and the page asks
  // window.StudioPunch for the comp splice a punched pass writes with.
  new Function("window", PUNCH_SCRIPT)(windowStub);
  assert.equal(typeof windowStub.StudioPunch.spliceComp, "function", "the punch rules are evaluated");

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

  return { document, doc, store, storage, engine, clock, mediaDevices, sent, requests, log, page, click, settle, frame, pushState, dropSocket, releaseFinish, timers };
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

test("R1: count-in 1 plays with countInBars 1 and arms on the announced play_frame", async () => {
  const ui = await bootPanel({ storage: makeStorage(), clock: 0.75 });
  const recorder = await pressRecord(ui);

  assert.equal(countInPlays(ui).length, 1, "Record asked for a count-in");
  assert.equal(countInPlays(ui)[0].countInBars, 1, "one bar of it");
  assert.deepEqual(ui.engine.launched, [SCENE], "the record scene's launch was queued for the downbeat");
  assert.equal(ui.engine.plays, 1, "the engine was started once, by the count-in");
  assert.equal(recorder.armFrame, null, "nothing is armed while the clicks run");

  // The engine announces the frame the song starts on, then one click per beat.
  ui.engine.countIn({ type: "count_in_start", play_frame: 96000 });
  await ui.settle();
  for (const beat of [1, 2, 3]) {
    ui.engine.countIn({ type: "count_in", beat, beats: 4, frame: 96000 - (4 - beat) * 12000, play_frame: 96000 });
    await ui.settle();
  }
  assert.equal(recorder.armFrame, null, "the take is not armed before the last click");

  // The last beat's click is a beat ahead of the downbeat: a true future frame.
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: 84000, play_frame: 96000 });
  await ui.settle(24);
  assert.equal(recorder.armFrame, 96000, "the recorder armed on the frame the count-in announced");
  assert.ok(recorder.armFrame >= recorder.armNow, "and that frame is ahead of the page's own now");
  assert.equal(recorder.splits[0], 96000 + Math.round(4 * 4 * ((48000 * 60) / 240)), "its first pass ends a loop after it");

  // The take holds none of the count-in: it begins on the downbeat, not before
  // it, and the clip is the record scene's slot.
  const added = ui.sent.filter((message) => message.command === "clip.add_audio");
  assert.equal(added.length, 1, "the empty slot got one audio clip");
  assert.equal(added[0].args.scene_id, SCENE, "in the record scene");
  assert.equal(
    ui.document.querySelector("[data-role=rec-status]").textContent,
    "Recording, pass 1",
    "the take is recording once it is armed",
  );
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
  assert.ok(recorder.armFrame >= recorder.armNow, "and that frame is ahead of the page's own now");
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
  const recorder = await pressRecord(ui);

  assert.equal(countInPlays(ui).length, 0, "a running transport counts nothing in");
  assert.equal(ui.engine.events.indexOf("count_in_start"), -1, "and no count-in message arrives");
  assert.equal(ui.engine.loopAsks.length, 1, "the loop start was asked for once");
  assert.equal(ui.engine.loopAsks[0].clip_id, CLIP, "about the clip the take records into");
  assert.equal(recorder.armFrame, 144000, "the recorder armed on the frame the engine named");
  assert.ok(recorder.armFrame >= recorder.armNow, "never on a frame the engine has already rendered");
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
    const recorder = await pressRecord(ui);
    if (how === "paused") {
      ui.engine.countBar(1, 192000);
      await ui.settle(24);
    }
    assert.ok(recorder.armFrame !== null, `${how}: the take was armed`);
    assert.ok(
      recorder.armFrame >= recorder.armNow,
      `${how}: the arm frame is ahead of the page's own now (${recorder.armFrame} vs ${recorder.armNow})`,
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
  assert.equal(status().textContent, "Recording, pass 1", "the take replaces the count-in");
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
  // that: the counting branch runs before the performance's own guard.
  const ui = await bootPanel({ storage: makeStorage() });
  const view = ui.page.__studioTest.view;
  view.recTimeline.on = true;
  await pressRecord(ui);

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
  // chosen there, from the slot the tap named.
  ui.engine.countIn({ type: "count_in", beat: 4, beats: 4, frame: 84000, play_frame: 96000 });
  await ui.settle(24);

  assert.equal(recorder.armFrame, 96000, "the take armed on the count-in's frame");
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

/** Three passes of one punched take, in the order they land. */
const T_A = "6f1c1f7a-0000-4000-8000-000000000002";
const T_B = "6f1c1f7a-0000-4000-8000-000000000003";
const T_C = "6f1c1f7a-0000-4000-8000-000000000004";

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
 * Arm the audio track, set the punch range (or none) and press Record.
 * @param {object} ui a booted panel
 * @param {number|null} from the range's first clip beat, or null for no punch
 * @param {number} [to] the range's end beat
 * @returns {Promise<object>} the recorder the page built
 */
async function recordWithPunch(ui, from, to) {
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
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

/**
 * A booted panel whose clip already holds a comp, for the comp-write cases: no
 * recording runs; a gated pass is handed over the way an upload hands it over.
 * @param {{takes?: string[]}} [options]
 * @returns {Promise<object>}
 */
async function compPanel(options = {}) {
  const ids = options.takes || [T_OLD, T_A, T_B, T_C];
  return bootPanel({
    clip: true,
    lengthBars: 1,
    takes: ids.map((id) => ({ id: id })),
  });
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

test("R11: the same clip-beat range applies on pass 0, 1 and 2", async () => {
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
  assert.equal(ui.requests.filter((request) => request.url.includes("/finish")).length, 1,
    "the first pass uploads as it ends");
  let sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "and writes its comp when it lands");
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  await chunkPass(ui, recorder, 2);
  assert.equal(ui.requests.filter((request) => request.url.includes("/finish")).length, 2,
    "the second pass uploads as it ends");
  sent = setCompCommands(ui);
  assert.equal(sent.length, 2, "with a comp write of its own");
  assert.equal(recorder.gates.length, 1, "still one gate: the range is periodic, not re-sent per pass");
});

test("R12: a range outside a shortened clip arms nothing, creates no pending row and says so", async () => {
  const ui = await bootPanel({ clip: true, takes: [{ id: T_OLD }], latency: CALIBRATED });
  ui.click(`[data-track-id=${AUDIO_TRACK}] [data-act=arm-audio]`);
  await ui.settle();
  // A range set against a four-bar clip...
  assert.equal(ui.page.__studioTest.setPunch(4, 6), true, "the range fits the clip as it stands");
  await ui.settle();
  // ...and the clip is shortened under it, the way another view can.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.set_length", { clip_id: CLIP, length_bars: 1 });
  await ui.pushState();
  assert.deepEqual(viewOf(ui).punch, { from: 4, to: 6 }, "the page still holds the range it was given");

  ui.click("[data-act=record]");
  await ui.settle(24);
  const recorder = ui.engine.recorders[ui.engine.recorders.length - 1];
  assert.ok(recorder, "the panel built a recorder");
  await reportLaunch(ui);

  assert.equal(viewOf(ui).rec, null, "nothing is armed");
  assert.equal(recorder.armFrame, null, "the recorder was never armed");
  assert.deepEqual(recorder.splits, [], "and no pass boundary was sent");
  assert.deepEqual(recorder.gates, [], "nor a gate");
  assert.equal(ui.store.pendings.size, 0, "no pending row exists for it");
  assert.equal(ui.sent.filter((message) => message.command === "clip.add_audio").length, 0,
    "and no clip was written");
  assert.equal(setCompCommands(ui).length, 0, "no comp either");
  const toast = String(ui.document.querySelector("[data-role=toast]").textContent || "");
  assert.ok(toast.includes("The punch range is outside this clip."), `the page says so (got: ${toast})`);
});

test("R12: a range set mid-take sends a gatePeriodic that applies from the next pass start", async () => {
  const ui = await bootPanel({ clip: true, lengthBars: 1, takes: [{ id: T_OLD }], latency: CALIBRATED });
  const recorder = await recordWithPunch(ui, null);
  await reportLaunch(ui);
  assert.deepEqual(recorder.gates, [], "a take with no range has no gate");
  assert.equal(viewOf(ui).rec.active, true, "the take is running");

  assert.equal(ui.page.__studioTest.setPunch(2, 3), true, "the operator sets a range while the take runs");
  await ui.settle();

  assert.equal(viewOf(ui).punchNext, true, "the pass already armed keeps the gate it started with");
  assert.equal(recorder.gates.length, 1, "the recorder is handed the new range once");
  const gate = recorder.gates[0];
  assert.equal(gate.anchorFrame, ARM_FRAME, "on the take's own anchor");
  assert.equal(gate.loopFrames, PASS_FRAMES, "and the same periodic pass");
  assert.equal(gate.fromFrames, 2 * BEAT_FRAMES, "the new range's first beat");
  assert.equal(gate.toFrames, 3 * BEAT_FRAMES, "and its end");
  assert.equal(
    gate.activeFrom,
    ARM_FRAME + Math.round(PASS_FRAMES) + ROUND_TRIP_FRAMES,
    "it takes over at the first frame of the next pass",
  );
  assert.equal(viewOf(ui).rec.punch.from, 2, "and the take records the rest of its passes with it");
  assert.equal(viewOf(ui).rec.punch.to, 3);
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
  assert.equal(ui.requests.filter((request) => request.url.includes("/finish")).length, 1,
    "the take landed");
  assert.equal(setCompCommands(ui).length, 0, "and no comp write follows it");
  assert.deepEqual(viewOf(ui).punchTakes, {}, "nothing is waiting to be written");
});

test("R13: a later gated take sends clip.set_comp whose segments equal spliceComp of the old comp", async () => {
  const ui = await compPanel();
  const before = [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }];
  assert.deepEqual(await docComp(ui), before, "the clip's comp is the take it already had");

  ui.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await ui.settle();

  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "one comp write for the landed pass");
  assert.equal(sent[0].args.clip_id, CLIP, "for the clip the pass was recorded into");
  assert.deepEqual(sent[0].args.segments, spliceComp(before, T_A, 1, 3, 4), "the one splice rule the comp drag uses");
  assert.deepEqual(sent[0].args.segments, [
    { take_id: T_OLD, from_beat: 0, to_beat: 1 },
    { take_id: T_A, from_beat: 1, to_beat: 3 },
    { take_id: T_OLD, from_beat: 3, to_beat: 4 },
  ], "the new take over the range, the old comp either side of it");

  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.equal(viewOf(ui).punchComped[CLIP], 0, "the pass is written");
  assert.equal(viewOf(ui).punchChain[CLIP], undefined, "and the chain is idle again");
});

test("R13: pass 2 landing before pass 1 writes pass 2 and pass 1 never overrides it (punchComped guard)", async () => {
  const ui = await compPanel();
  ui.page.__studioTest.punchLanded(CLIP, 2, T_B, { from: 1, to: 3 });
  await ui.settle();
  let sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "the pass that landed first is written");
  assert.ok(sent[0].args.segments.some((segment) => segment.take_id === T_B), "and it is pass 2's take");
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  assert.equal(viewOf(ui).punchComped[CLIP], 2, "the comp is written for pass 2");

  // The earlier pass lands on the page afterwards.
  ui.page.__studioTest.punchLanded(CLIP, 1, T_A, { from: 1, to: 3 });
  await ui.settle();
  sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "a lower pass never writes over a higher one");
  assert.equal(viewOf(ui).punchComped[CLIP], 2, "the comp stays what pass 2 made it");
  assert.equal(viewOf(ui).punchLanded[CLIP], undefined, "and nothing is left waiting");
});

test("R13: three landed passes produce ONE set_comp, for the highest", async () => {
  const ui = await compPanel();
  const before = [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }];

  // Three passes land together: only the highest of them is worth writing, and
  // the page is still in the same turn for all three.
  ui.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  ui.page.__studioTest.punchLanded(CLIP, 1, T_B, { from: 1, to: 3 });
  ui.page.__studioTest.punchLanded(CLIP, 2, T_C, { from: 1, to: 3 });
  await ui.settle();

  const sent = setCompCommands(ui);
  assert.equal(sent.length, 1, `three landed passes make one comp write (got ${sent.length})`);
  assert.deepEqual(sent[0].args.segments, spliceComp(before, T_C, 1, 3, 4), "for the highest pass's take");
  assert.equal(viewOf(ui).punchLanded[CLIP], undefined, "the passes it replaced are not written afterwards");
});

test("R13: with two punched passes the later pass owns the range and the earlier stays a listed take", async () => {
  const ui = await compPanel({ takes: [T_OLD, T_A, T_B] });
  const before = [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }];

  ui.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await ui.settle();
  let sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "the first pass is written");
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.set_comp", { clip_id: CLIP, segments: sent[0].args.segments });
  await ui.pushState();
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();

  // The second pass lands over the same range: the later one owns it.
  ui.page.__studioTest.punchLanded(CLIP, 1, T_B, { from: 1, to: 3 });
  await ui.settle();
  sent = setCompCommands(ui);
  assert.equal(sent.length, 2, "a second pass makes a second write");
  const afterFirst = spliceComp(before, T_A, 1, 3, 4);
  assert.deepEqual(sent[1].args.segments, spliceComp(afterFirst, T_B, 1, 3, 4), "over the comp the first write made");
  assert.deepEqual(sent[1].args.segments, [
    { take_id: T_OLD, from_beat: 0, to_beat: 1 },
    { take_id: T_B, from_beat: 1, to_beat: 3 },
    { take_id: T_OLD, from_beat: 3, to_beat: 4 },
  ], "the later pass's take where the earlier one was");

  runCommand(ui.doc, "clip.set_comp", { clip_id: CLIP, segments: sent[1].args.segments });
  await ui.pushState();
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  const song = snapshot(ui.doc);
  assert.deepEqual(Object.keys(song.takes).sort(), [T_A, T_B, T_OLD].sort(), "both punched passes stay listed as takes");
  assert.equal(song.clips[CLIP].comp.some((segment) => segment.take_id === T_A), false,
    "and the comp no longer names the earlier pass over the range");
});

test("R13: each set_comp is computed from the snapshot that holds the previous one, with the echo of the first DELAYED (sendAwait waits for it)", async () => {
  const ui = await compPanel();
  const before = [{ take_id: T_OLD, from_beat: 0, to_beat: 4 }];

  ui.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await ui.settle();
  let sent = setCompCommands(ui);
  assert.equal(sent.length, 1, "the first pass is on the wire");
  const first = sent[0].args.segments;

  // The song holds the first write, and the second pass lands before the hub has
  // answered it.
  const { runCommand } = await import("../bundles/studio/server/commands/registry.js");
  runCommand(ui.doc, "clip.set_comp", { clip_id: CLIP, segments: first });
  await ui.pushState();
  ui.page.__studioTest.punchLanded(CLIP, 1, T_B, { from: 1, to: 3 });
  await ui.settle();
  assert.equal(setCompCommands(ui).length, 1, "the chain waits for the answer to the write on the wire");

  // The answer arrives: the next write is spliced onto the comp that holds it.
  ui.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await ui.settle();
  sent = setCompCommands(ui);
  assert.equal(sent.length, 2, "and then the second pass is written");
  assert.deepEqual(sent[1].args.segments, spliceComp(first, T_B, 1, 3, 4), "from the snapshot the first write left");
  assert.deepEqual(sent[1].args.segments, spliceComp(before, T_B, 1, 3, 4),
    "which is the same comp as writing the later pass once");
});

test("R13: sendAwait rejects when the socket drops or the song changes and the chain writes nothing", async () => {
  // A socket that goes away under a write.
  const ui = await compPanel();
  ui.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await ui.settle();
  assert.equal(setCompCommands(ui).length, 1, "the first pass went out");
  await ui.dropSocket();
  assert.deepEqual(viewOf(ui).awaiting, {}, "the command it waited on was let go with the socket");
  ui.page.__studioTest.punchLanded(CLIP, 1, T_B, { from: 1, to: 3 });
  await ui.settle();
  assert.equal(setCompCommands(ui).length, 1, "nothing more is written after the drop");
  assert.equal(viewOf(ui).punchChain[CLIP], undefined, "and the chain is not left running");

  // A page whose song moved on under a write.
  const other = await compPanel();
  other.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await other.settle();
  let sent = setCompCommands(other);
  assert.equal(sent.length, 1, "the write went out");
  other.page.__studioLiveSong = "song-2";
  other.frame({ type: "result", cmd_id: sent[0].cmd_id, ok: true });
  await other.settle();
  assert.equal(viewOf(other).punchComped[CLIP], undefined, "an answer for another song writes nothing");
  other.page.__studioTest.punchLanded(CLIP, 1, T_B, { from: 1, to: 3 });
  await other.settle();
  assert.equal(setCompCommands(other).length, 1, "and neither does a pass landing after it");
});

test("R13: no clip.set_comp is sent when view.closed or the song changed; the take is listed", async () => {
  const closed = await compPanel();
  const before = await docComp(closed);
  viewOf(closed).closed = true;
  closed.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await closed.settle();
  assert.equal(setCompCommands(closed).length, 0, "a page that is closed writes nothing");
  assert.deepEqual(await docComp(closed), before, "the comp is left as it was");
  const { snapshot } = await import("../bundles/studio/server/doc.js");
  assert.deepEqual(Object.keys(snapshot(closed.doc).takes).sort(), [T_A, T_B, T_C, T_OLD].sort(),
    "and the takes the song holds are still listed");

  const moved = await compPanel();
  moved.page.__studioLiveSong = "song-2";
  moved.page.__studioTest.punchLanded(CLIP, 0, T_A, { from: 1, to: 3 });
  await moved.settle();
  assert.equal(setCompCommands(moved).length, 0, "a page showing another song writes nothing");
  assert.deepEqual(await docComp(moved), before, "and leaves the comp alone");
});