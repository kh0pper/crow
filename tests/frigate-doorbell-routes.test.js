/**
 * The Frigate bundle's doorbell stills and live view routes (panel/routes.js).
 *
 * Why these assertions: three of these routes take a camera name straight out of a URL, and two of
 * them are backed by something outside Frigate — a folder another process writes and one ffmpeg
 * per camera fed by an address only the gateway holds. So a name is checked before it can reach a
 * path, a refusal says why without saying where, and the stream addresses never appear in any
 * response body. The router is the one the gateway mounts, with `fetch` stubbed and the live
 * manager replaced by a stand-in, so no socket is opened and no camera is woken.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "crow-frigate-routes-home-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "crow-frigate-routes-outside-"));
const SNAP_DIR = mkdtempSync(join(tmpdir(), "crow-frigate-routes-snap-"));
const ENV_KEYS = ["CROW_HOME", "CROW_APP_ROOT", "FRIGATE_URL", "FRIGATE_USER", "FRIGATE_PASSWORD", "FRIGATE_SNAPSHOT_DIR", "FRIGATE_LIVE_SOURCES"];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// A CROW_HOME with no installed bundle: the routes then read this checkout's own server modules,
// so a copy installed in the developer's home cannot answer for them.
process.env.CROW_HOME = SCRATCH_HOME;
process.env.CROW_APP_ROOT = ROOT;
process.env.FRIGATE_URL = "http://frigate.invalid:8971";
delete process.env.FRIGATE_USER;
delete process.env.FRIGATE_PASSWORD;
process.env.FRIGATE_SNAPSHOT_DIR = SNAP_DIR;
process.env.FRIGATE_LIVE_SOURCES = JSON.stringify({
  front_door: "rtsp://someone:hunter2@100.64.20.7:8554/front_door_live",
  side_gate: "rtsps://someone:hunter2@100.64.20.7:8555/side_gate_live",
  "Not A Name": "rtsp://someone:hunter2@100.64.20.7:8554/bad_live",
  attic: "http://someone:hunter2@100.64.20.7:8554/attic_live",
});

const JPG = "jpeg-bytes-of-the-doorbell";
writeFileSync(join(SNAP_DIR, "front_door.jpg"), JPG);
writeFileSync(join(SNAP_DIR, "front_door.json"), JSON.stringify({ timestamp: 1_700_000_000, type: "ding" }));
writeFileSync(join(SNAP_DIR, "side_gate.jpg"), JPG);
writeFileSync(join(SNAP_DIR, "empty.jpg"), "");
writeFileSync(join(OUTSIDE, "elsewhere.jpg"), "not ours");
symlinkSync(join(OUTSIDE, "elsewhere.jpg"), join(SNAP_DIR, "linked.jpg"));

after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SCRATCH_HOME, { recursive: true, force: true });
  rmSync(SNAP_DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

const routesModule = await import("../bundles/frigate/panel/routes.js");
// The real manager, for the one case that must prove the ROUTES report what it knows.
const { createLiveManager } = await import("../bundles/frigate/server/live-session.js");

/** A response object shaped the way the routes and the live manager read one. */
function recordingResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    written: [],
    listeners: {},
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end(body) { if (body !== undefined) this.body = body; return this; },
    write(chunk) { this.written.push(chunk); return true; },
    on(type, handler) { (this.listeners[type] ||= []).push(handler); return this; },
    removeListener() { return this; },
  };
}

/** A response object shaped the way the Frigate client reads one. */
function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** Replace global fetch for one test. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return { restore() { globalThis.fetch = original; } };
}

const CONFIG_OK = () => jsonResponse({
  cameras: {
    front_door: { detect: { width: 640, height: 360 }, objects: { track: ["person"] } },
    driveway: { detect: { enabled: true } },
  },
});

/** The router the gateway mounts (a fresh one per case; the module itself is shared). */
function newRouter() {
  return routesModule.default((req, res, next) => next());
}

/** One handler off the router, by its route path. */
function handlerFor(router, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(layer, `the router serves ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Calls a route handler with a recording response and returns it. */
async function callRoute(handler, req = {}) {
  const res = recordingResponse();
  // The live route only takes a request that comes from the panel itself, so a case that says
  // nothing about where its request came from is a same-origin one unless it says otherwise.
  await handler({ query: {}, params: {}, headers: { "sec-fetch-site": "same-origin" }, ...req }, res);
  return res;
}

/** Everything this file has seen a route answer with, for the "no secrets anywhere" check. */
const everyBody = [];

function remember(res) {
  if (res.body !== null && res.body !== undefined) everyBody.push(res.body);
  return res;
}

/** A stand-in live manager: `sources` is the set of live cameras, as `has()` reports it. */
function stubManager(overrides = {}) {
  const calls = [];
  return {
    sources: new Set(["front_door", "side_gate"]),
    has(name) { return this.sources.has(name); },
    async available() { return true; },
    async attach(name, res) {
      calls.push({ name, res });
      if (!this.has(name)) return { ok: false, status: 404, message: "Unknown camera" };
      return { ok: true };
    },
    calls,
    ...overrides,
  };
}

/** Mount a manager for one case, and go back to the real one afterwards. */
async function withManager(manager, run) {
  routesModule._setLiveManagerForTest(manager);
  try {
    return await run();
  } finally {
    routesModule._setLiveManagerForTest(null);
  }
}

/** A spawner stand-in for the REAL manager: the -version probe answers, a session child sits still. */
function fakeSpawner() {
  const calls = [];
  function spawn(cmd, args, options) {
    const isProbe = Array.isArray(args) && args[0] === "-version";
    const child = new EventEmitter();
    child.pid = 6000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    calls.push({ cmd, args, options, isProbe, child });
    if (isProbe) setImmediate(() => child.emit("exit", 0));
    return child;
  }
  return { calls, spawn };
}

/** A clock whose timers never fire: these cases only need the manager's numbers to hold still. */
function stillClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    setTimer: () => null,
    clearTimer: () => {},
    advance(ms) { current += ms; },
  };
}

/** An in-memory cooldown store: where the real manager keeps its cooldown for these cases. */
function memoryStore() {
  const backing = new Map();
  return {
    backing,
    get(name) { return backing.get(name); },
    set(name, until) { backing.set(name, until); },
  };
}

// ─── every route is behind the gate ───────────────────────────────────────

// A route that lost its `authMiddleware` would still pass every other test in this file (the
// helper takes the route's LAST handler), so the gate is checked directly: it is the first handle
// on the route, it is the very function the router was built with, and it refuses without next().

test("every new route is gated by the auth middleware the router was built with", async () => {
  const manager = stubManager();
  const refused = [];
  const middleware = (req, res, next) => {
    refused.push(req.path);
    res.status(401).json({ error: "Sign in first" });
  };
  const router = routesModule.default(middleware);

  await withManager(manager, async () => {
    const paths = [
      "/api/frigate/snap/:file",
      "/api/frigate/live/:name/stream.mjpg",
      "/api/frigate/live/:name/status",
      "/api/frigate/cameras",
    ];
    for (const path of paths) {
      const layer = router.stack.find((l) => l.route && l.route.path === path);
      assert.ok(layer, `the router serves ${path}`);
      assert.ok(layer.route.stack.length > 1, `${path} has a handler behind its gate`);
      assert.equal(layer.route.stack[0].handle, middleware,
        `${path} is gated by the middleware passed to frigateRouter`);

      const res = recordingResponse();
      let nexted = false;
      await layer.route.stack[0].handle({ path, query: {}, params: {}, headers: {} }, res, () => { nexted = true; });
      assert.equal(nexted, false, `${path}: the middleware answers instead of passing the request on`);
      assert.equal(res.statusCode, 401, `${path}: an unauthenticated request is refused`);
      assert.deepEqual(res.body, { error: "Sign in first" });
    }
    assert.deepEqual(refused, paths, "each gate was the one that answered");
    assert.equal(manager.calls.length, 0, "nothing behind the gate ran, so no camera was attached");
  });
});

// ─── the still route ──────────────────────────────────────────────────────

test("the still route serves the jpg from the folder, never cached", async () => {
  const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/snap/:file"), { params: { file: "front_door.jpg" } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.headers["cache-control"], "no-store", "the still changes; nothing may store it");
  assert.ok(Buffer.isBuffer(res.body), "the bytes are the body");
  assert.equal(res.body.toString(), JPG);
});

test("the still route refuses every bad name and every file that is not a plain still", async () => {
  const handler = handlerFor(newRouter(), "/api/frigate/snap/:file");

  const badNames = ["..", "%2e%2e", "a%2fb", "x".repeat(65), "Front_door", "front.door", "", "linked", "empty", "missing"];
  for (const name of badNames) {
    // Both the form a client sends and the form Express hands the handler after decoding.
    for (const file of [`${name}.jpg`, `${encodeURIComponent(name)}.jpg`]) {
      const res = remember(await callRoute(handler, { params: { file } }));
      assert.equal(res.statusCode, 404, `refused: ${file}`);
      assert.deepEqual(res.body, { error: "Unknown snapshot" }, `a fixed error for ${file}, nothing echoed`);
    }
  }

  // A path that is not a jpg at all, and a request with no param.
  for (const file of ["front_door", "front_door.png", "front_door.jpg.txt"]) {
    const res = remember(await callRoute(handler, { params: { file } }));
    assert.equal(res.statusCode, 404, `refused: ${file}`);
  }
  const junk = remember(await callRoute(handler, { params: {} }));
  assert.equal(junk.statusCode, 404, "no param at all is not a still either");
});

test("a still that is a symlink or empty is refused, even with a name the folder has", async () => {
  const handler = handlerFor(newRouter(), "/api/frigate/snap/:file");
  for (const file of ["linked.jpg", "empty.jpg"]) {
    const res = remember(await callRoute(handler, { params: { file } }));
    assert.equal(res.statusCode, 404, `${file} is not a still of ours`);
    assert.deepEqual(res.body, { error: "Unknown snapshot" });
  }
});

test("with no snapshot folder configured the still route answers 404, not a read", async () => {
  const saved = process.env.FRIGATE_SNAPSHOT_DIR;
  process.env.FRIGATE_SNAPSHOT_DIR = "";
  try {
    const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/snap/:file"), { params: { file: "front_door.jpg" } }));
    assert.equal(res.statusCode, 404);
  } finally {
    process.env.FRIGATE_SNAPSHOT_DIR = saved;
  }
});

// ─── the live route ───────────────────────────────────────────────────────

test("the live route refuses a name that could never be a camera, before asking the manager", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const handler = handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg");
    for (const name of ["..", "%2e%2e", "a%2fb", "x".repeat(65), "Front_door", ""]) {
      const res = remember(await callRoute(handler, { params: { name } }));
      assert.equal(res.statusCode, 404, `refused: ${name}`);
      assert.deepEqual(res.body, { error: "Unknown camera" }, `a fixed error for ${name}`);
    }
    assert.equal(manager.calls.length, 0, "a bad name never reaches the manager");
  });
});

test("the live route hands the response to the manager on success", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const res = await callRoute(handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg"), { params: { name: "front_door" } });
    assert.equal(manager.calls.length, 1, "the manager was asked once");
    assert.equal(manager.calls[0].name, "front_door");
    assert.equal(manager.calls[0].res, res, "it was handed this very response");
    assert.equal(res.body, null, "the route wrote nothing: the manager owns the response");
    assert.equal(res.statusCode, 200, "and nothing changed its status");
  });
});

// Starting a view is a GET that wakes a battery doorbell, so a page from another site must not be
// able to do it by embedding the URL. The browser's `Sec-Fetch-Site` decides when it is there; when
// it is not (a dashboard on plain HTTP gets no fetch metadata) the Referer has to be this origin.

test("the live route refuses a cross-site request before the manager is touched", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const handler = handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg");

    for (const site of ["cross-site", "same-site", "none", "Cross-Site"]) {
      const res = remember(await callRoute(handler, {
        params: { name: "front_door" },
        headers: { "sec-fetch-site": site },
      }));
      assert.equal(res.statusCode, 403, `refused: ${site}`);
      assert.deepEqual(res.body, { error: "Live view must be started from this page" });
    }

    // A Referer for this very host does not talk the browser's own cross-site word around.
    const spoofed = remember(await callRoute(handler, {
      params: { name: "front_door" },
      headers: { "sec-fetch-site": "cross-site", host: "nest.invalid", referer: "http://nest.invalid/dashboard/frigate" },
    }));
    assert.equal(spoofed.statusCode, 403, "Sec-Fetch-Site decides whenever it is there");
    assert.equal(manager.calls.length, 0, "the manager was never asked, so nothing was spawned");

    // Our own page still starts a view.
    const res = await callRoute(handler, { params: { name: "front_door" }, headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(manager.calls.length, 1, "allowed: same-origin");
    assert.equal(res.statusCode, 200, "the manager owns the response");
    assert.equal(res.body, null, "and the route wrote nothing itself");
  });
});

test("with no Sec-Fetch-Site the live route needs a Referer from this very origin", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const handler = handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg");
    const host = "nest.invalid:8443";

    // Another site, another port of this host, an opaque page, a missing Referer and an empty
    // fetch-site are all refused: the header a plain-HTTP dashboard never gets cannot be missed.
    const refusals = [
      { "sec-fetch-site": "", host },
      { host },
      { host, referer: "http://elsewhere.invalid:8443/dashboard/frigate" },
      { host, referer: "http://nest.invalid:3000/dashboard/frigate" },
      { host, referer: "https://nest.invalid:8444/dashboard/frigate" },
      { host, referer: "not a url" },
      { referer: "http://nest.invalid:8443/dashboard/frigate" },
    ];
    for (const headers of refusals) {
      const res = remember(await callRoute(handler, { params: { name: "front_door" }, headers }));
      assert.equal(res.statusCode, 403, `refused: ${JSON.stringify(headers)}`);
      assert.deepEqual(res.body, { error: "Live view must be started from this page" });
    }
    assert.equal(manager.calls.length, 0, "no camera was woken by any of them");

    // The panel's own page sends this host and port, over whichever scheme it is served on.
    for (const referer of ["http://nest.invalid:8443/dashboard/frigate", "https://nest.invalid:8443/dashboard/frigate?x=1"]) {
      const before = manager.calls.length;
      const res = await callRoute(handler, { params: { name: "front_door" }, headers: { host, referer } });
      assert.equal(manager.calls.length, before + 1, `allowed: ${referer}`);
      assert.equal(res.statusCode, 200, "the manager owns the response");
      assert.equal(res.body, null, "and the route wrote nothing itself");
    }
  });
});

test("an unknown but well-formed camera is a 404 from the manager, passed through", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg"), { params: { name: "attic" } }));
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Unknown camera" });
  });
});

test("a refusal keeps its status, its Retry-After and its message", async () => {
  const cases = [
    { refusal: { ok: false, status: 503, retryAfterSec: 42, message: "Live view is cooling down; try again in 42 s" }, status: 503, retry: "42" },
    { refusal: { ok: false, status: 429, message: "Live view already has all of its viewers" }, status: 429, retry: null },
    { refusal: { ok: false, status: 503, message: "Live view needs ffmpeg" }, status: 503, retry: null },
  ];
  for (const c of cases) {
    const manager = stubManager({ async attach() { return c.refusal; } });
    await withManager(manager, async () => {
      const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg"), { params: { name: "front_door" } }));
      assert.equal(res.statusCode, c.status, c.refusal.message);
      assert.equal(res.body.error, c.refusal.message, "the manager's own words, unchanged");
      if (c.retry) assert.equal(res.headers["retry-after"], c.retry, "how long to wait");
      else assert.equal(res.headers["retry-after"], undefined, "no invented wait");
    });
  }
});

// ─── the live status route ────────────────────────────────────────────────

test("the status route answers for a live camera only", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const handler = handlerFor(newRouter(), "/api/frigate/live/:name/status");

    const known = remember(await callRoute(handler, { params: { name: "front_door" } }));
    assert.equal(known.statusCode, 200);
    assert.equal(known.body.available, true);
    assert.equal(known.body.cooldown_seconds, undefined,
      "a manager that cannot report a cooldown says nothing rather than inventing a zero");
    assert.equal(known.body.remaining_seconds, undefined,
      "and one that cannot report its remaining time stays silent too");

    for (const name of ["attic", "nope", ".."]) {
      const res = remember(await callRoute(handler, { params: { name } }));
      assert.equal(res.statusCode, 404, `${name} is not a live camera`);
      assert.deepEqual(res.body, { error: "Unknown camera" });
    }
  });
});

test("the status route reports ffmpeg's absence as not available", async () => {
  const manager = stubManager({ async available() { return false; } });
  await withManager(manager, async () => {
    const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/live/:name/status"), { params: { name: "side_gate" } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.available, false);
  });
});

test("the status route reports a remaining cooldown when the manager knows one", async () => {
  const manager = stubManager({ cooldownLeftMs() { return 31_000; } });
  await withManager(manager, async () => {
    const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/live/:name/status"), { params: { name: "front_door" } }));
    assert.equal(res.body.cooldown_seconds, 31);
  });
});

// A viewer that joins a session already running must count down what is left of it, not a fresh
// two minutes: the route reports the manager's remaining time rounded up.

test("the status route reports what is left of a running session, and 0 when none runs", async () => {
  let left = 29_800;
  const manager = stubManager({ remainingMs() { return left; } });
  await withManager(manager, async () => {
    const handler = handlerFor(newRouter(), "/api/frigate/live/:name/status");

    const running = remember(await callRoute(handler, { params: { name: "front_door" } }));
    assert.equal(running.body.remaining_seconds, 30, "29.8 s left is reported as 30 s");

    left = 0;
    const ended = remember(await callRoute(handler, { params: { name: "front_door" } }));
    assert.equal(ended.body.remaining_seconds, 0, "no session left, so no time left");

    left = Number.NaN;
    const junk = remember(await callRoute(handler, { params: { name: "front_door" } }));
    assert.equal(junk.body.remaining_seconds, 0, "a number the manager cannot give is 0, never NaN");
  });
});

// The cooldown the panel shows comes from the REAL manager, so this case builds one (fake spawn,
// fake clock, in-memory store) and drives it through the routes the gateway mounts.

test("a real manager's cooldown and remaining time reach the status route", async () => {
  const clock = stillClock();
  const store = memoryStore();
  const spawner = fakeSpawner();
  const manager = createLiveManager({
    sources: { front_door: "rtsp://someone:hunter2@100.64.20.7:8554/front_door_live" },
    spawn: spawner.spawn,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    killGroup: () => {},
    cooldownStore: store,
  });

  await withManager(manager, async () => {
    const stream = handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg");
    const status = handlerFor(newRouter(), "/api/frigate/live/:name/status");

    const viewer = await callRoute(stream, { params: { name: "front_door" } });
    assert.equal(viewer.statusCode, 200, "the real manager took the response over");
    assert.equal(spawner.calls.filter((call) => !call.isProbe).length, 1, "one session started");

    const running = remember(await callRoute(status, { params: { name: "front_door" } }));
    assert.equal(running.statusCode, 200);
    assert.equal(running.body.available, true);
    assert.equal(running.body.remaining_seconds, 120, "the running session has its whole cap left");
    assert.equal(running.body.cooldown_seconds, 0,
      "a running session is not cooling down: its restart guard is for the next process, not this one");

    // The tab goes away: the manager ends the session and records a cooldown from now.
    for (const onClose of viewer.listeners.close || []) onClose();
    assert.equal(manager.remainingMs("front_door"), 0, "the session is over");

    const cooling = remember(await callRoute(status, { params: { name: "front_door" } }));
    assert.equal(cooling.statusCode, 200);
    assert.ok(cooling.body.cooldown_seconds > 0, "the panel's 'Try again in a minute' branch has a number");
    assert.equal(cooling.body.cooldown_seconds, 60, "the manager's own cooldown, in seconds");
    assert.equal(cooling.body.remaining_seconds, 0, "and no session is left to count down");
  });
});

// ─── the camera list ──────────────────────────────────────────────────────

test("the camera list flags snapshot and live cameras and appends the snapshot-only ones", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const stub = stubFetch(() => CONFIG_OK());
    let res;
    try {
      res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/cameras")));
    } finally {
      stub.restore();
    }

    assert.equal(res.body.error, undefined, "Frigate answered");
    const byName = new Map(res.body.cameras.map((camera) => [camera.name, camera]));
    assert.equal(byName.get("front_door").snapshot, true, "the folder has a still for it");
    assert.equal(byName.get("front_door").live, true, "and a live source");
    assert.equal(byName.get("front_door").width, 640, "Frigate's own detail is kept");
    assert.equal(byName.get("driveway").snapshot, false);
    assert.equal(byName.get("driveway").live, false);

    const gate = byName.get("side_gate");
    assert.ok(gate, "a still with no Frigate entry is still a camera");
    assert.equal(gate.snapshot, true);
    assert.equal(gate.live, true);
    assert.equal(gate.enabled, true);
    assert.equal(gate.detect_enabled, false);
    assert.equal(gate.width, null);
    assert.equal(gate.height, null);
    assert.deepEqual(gate.tracked_objects, [], "a snapshot camera tracks nothing");
  });
});

test("a camera that is not a snapshot camera is never live", async () => {
  const manager = stubManager({ sources: new Set(["front_door", "side_gate", "attic"]) });
  await withManager(manager, async () => {
    const stub = stubFetch(() => CONFIG_OK());
    try {
      const res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/cameras")));
      const byName = new Map(res.body.cameras.map((camera) => [camera.name, camera]));
      assert.equal(byName.get("driveway").live, false);
    } finally {
      stub.restore();
    }
  });
});

test("Frigate down still lists the snapshot cameras, and says nothing about an error", async () => {
  const manager = stubManager();
  await withManager(manager, async () => {
    const stub = stubFetch(() => jsonResponse({ error: "bad things" }, { status: 500 }));
    let res;
    try {
      res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/cameras")));
    } finally {
      stub.restore();
    }
    assert.equal(res.body.error, undefined, "the stills do not depend on Frigate");
    assert.deepEqual(res.body.cameras.map((camera) => camera.name), ["front_door", "side_gate"]);
    assert.ok(res.body.cameras.every((camera) => camera.snapshot === true));
  });
});

test("Frigate down with an empty folder is still an error, as before", async () => {
  const emptyDir = join(SCRATCH_HOME, "empty-snapshots");
  mkdirSync(emptyDir, { recursive: true });
  const saved = process.env.FRIGATE_SNAPSHOT_DIR;
  process.env.FRIGATE_SNAPSHOT_DIR = emptyDir;
  try {
    await withManager(stubManager(), async () => {
      const stub = stubFetch(() => jsonResponse({ error: "bad things" }, { status: 500 }));
      let res;
      try {
        res = remember(await callRoute(handlerFor(newRouter(), "/api/frigate/cameras")));
      } finally {
        stub.restore();
      }
      assert.equal(typeof res.body.error, "string", "nothing to draw, so the error is reported");
      assert.deepEqual(res.body.cameras, []);
    });
  } finally {
    process.env.FRIGATE_SNAPSHOT_DIR = saved;
  }
});

// ─── the manager is built with the gateway's own write-context runner ──────

// A live session's ffmpeg and timers outlive the dashboard request that started them, so the body
// that creates them must run through `withoutWriteContext`. The route loads that module by path
// (an installed copy cannot import from servers/), which also means a test can stand in for it:
// the seam is the same one an installed instance uses.

/** A scratch instance whose own bundle carries a stand-in live-session.js. */
function fakeInstance() {
  const home = mkdtempSync(join(tmpdir(), "crow-frigate-detached-home-"));
  const appRoot = mkdtempSync(join(tmpdir(), "crow-frigate-detached-root-"));
  mkdirSync(join(home, "bundles", "frigate", "server"), { recursive: true });
  writeFileSync(join(home, "bundles", "frigate", "server", "live-session.js"), [
    "export function createLiveManager(options) {",
    "  globalThis.__fgManagerOptions = options;",
    "  return { has: () => true, available: async () => true, attach: async () => ({ ok: true }) };",
    "}",
  ].join("\n"));
  return { home, appRoot };
}

/** A stand-in write-context module under `appRoot`; `source` is its ESM body. */
function writeContextModule(appRoot, source) {
  mkdirSync(join(appRoot, "servers", "shared", "history"), { recursive: true });
  writeFileSync(join(appRoot, "servers", "shared", "history", "write-context.js"), source);
}

/** Point this instance at the stand-in bundle and module, and build its manager through a route. */
async function buildManagerThroughRoute({ home, appRoot }) {
  const savedHome = process.env.CROW_HOME;
  const savedRoot = process.env.CROW_APP_ROOT;
  process.env.CROW_HOME = home;
  if (appRoot) process.env.CROW_APP_ROOT = appRoot;
  else delete process.env.CROW_APP_ROOT;
  routesModule._setLiveManagerForTest(null);
  try {
    const res = await callRoute(handlerFor(newRouter(), "/api/frigate/live/:name/stream.mjpg"),
      { params: { name: "front_door" } });
    assert.equal(res.body, null, "the stand-in manager took the response over");
    return globalThis.__fgManagerOptions;
  } finally {
    if (savedHome === undefined) delete process.env.CROW_HOME;
    else process.env.CROW_HOME = savedHome;
    if (savedRoot === undefined) delete process.env.CROW_APP_ROOT;
    else process.env.CROW_APP_ROOT = savedRoot;
    routesModule._setLiveManagerForTest(null);
  }
}

test("the live manager is built with the app root's withoutWriteContext as runDetached", async () => {
  const instance = fakeInstance();
  writeContextModule(instance.appRoot, [
    "globalThis.__fgFakeWithoutWriteContext = withoutWriteContext;",
    "export function withoutWriteContext(fn) {",
    "  globalThis.__fgDetachedCalls = (globalThis.__fgDetachedCalls || 0) + 1;",
    "  return fn();",
    "}",
  ].join("\n"));
  delete globalThis.__fgManagerOptions;
  globalThis.__fgDetachedCalls = 0;
  try {
    const options = await buildManagerThroughRoute(instance);
    assert.ok(options, "the route built the manager");
    assert.deepEqual(Object.keys(options.sources).sort(), ["front_door", "side_gate"],
      "from the instance's own live sources");
    assert.equal(typeof options.runDetached, "function", "the manager was given a runner to start sessions in");
    assert.equal(options.runDetached, globalThis.__fgFakeWithoutWriteContext,
      "and it is that module's own withoutWriteContext");

    // It is the real article: a session body handed to it runs, counted as detached.
    let ran = 0;
    options.runDetached(() => { ran += 1; });
    assert.equal(ran, 1, "the body still runs, exactly once");
    assert.equal(globalThis.__fgDetachedCalls, 1, "through withoutWriteContext, not a plain call");
  } finally {
    delete globalThis.__fgManagerOptions;
    delete globalThis.__fgFakeWithoutWriteContext;
    delete globalThis.__fgDetachedCalls;
    rmSync(instance.home, { recursive: true, force: true });
    rmSync(instance.appRoot, { recursive: true, force: true });
  }
});

test("with no app root the manager is built without a runDetached runner", async () => {
  const instance = fakeInstance();
  delete globalThis.__fgManagerOptions;
  try {
    const options = await buildManagerThroughRoute({ home: instance.home });
    assert.ok(options, "the route built the manager");
    assert.equal(Object.hasOwn(options, "runDetached"), false,
      "the option is left out rather than loaded from a path that resolves outside the app");
  } finally {
    delete globalThis.__fgManagerOptions;
    rmSync(instance.home, { recursive: true, force: true });
    rmSync(instance.appRoot, { recursive: true, force: true });
  }
});

// ─── no stream address ever leaves the process ────────────────────────────

test("no response this file saw carries a stream address or a credential", () => {
  assert.ok(everyBody.length > 0, "the routes were driven");
  const serialized = JSON.stringify(everyBody.map((body) => (Buffer.isBuffer(body) ? "<bytes>" : body)));
  for (const secret of ["rtsp://", "rtsps://", "hunter2", "user:pass", "100.64.20.7", "someone:"]) {
    assert.ok(!serialized.includes(secret), `no body carries ${secret}`);
  }
});