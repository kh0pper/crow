/**
 * Frigate panel routes — Express router proxying Frigate REST calls for the Nest panel.
 *
 * JWT Bearer pattern mirrors bundles/actual-budget/panel/routes.js:
 *   login once → cache token → refresh on 401
 *
 * All routes are protected by dashboardAuth. The panel browser-side fetches
 * these paths — NOT the raw :8971 endpoint — so Frigate's JWT never leaves
 * the gateway process.
 *
 * TLS: we assume Frigate is configured with `tls.enabled: false` (our
 * config.yml.example default). See server/frigate-api.js for the
 * re-enable-TLS caveat.
 *
 * Logins are serialised: Frigate rate-limits `POST /api/login` (one per second by
 * default), so a page view that fires several proxied reads at once produced one
 * login per read and a pile of 429s reported as bad credentials. One in-flight
 * login is shared by every caller, and a 429 is retried after a short pause.
 *
 * A failed login is remembered for five seconds: with wrong credentials every card,
 * event and still on the page would otherwise start its own login and hammer Frigate's
 * login endpoint. Inside that window the same error is reported without a request.
 *
 * Doorbell stills and the live view are served from here too, and neither of them asks Frigate
 * anything: the stills are files a sidecar writes (server/doorbell.js) and the live view is one
 * ffmpeg per camera fed by a stream address this process holds (server/live-session.js). The
 * folder and the addresses arrive from the gateway's environment and never appear in a response.
 *
 * Both of those modules live beside the bundle and this file is installed to
 * <CROW_HOME>/panels/frigate-routes.js, where a relative import out of the bundle does not
 * resolve, so they are loaded by path: this instance's installed copy first, the app's own
 * bundle after it.
 */

import { Router } from "express";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The snapshot name rule, kept here as well so a bad name is refused before a module loads. */
const SNAPSHOT_NAME_RE = /^[a-z0-9_-]{1,64}$/;
const SNAPSHOT_SUFFIX = ".jpg";
const RTSP_RE = /^rtsps?:\/\//i;

/** The folder a snapshot bridge writes `<name>.jpg` into; blank means no snapshot cameras. */
function snapshotDir() {
  const value = process.env.FRIGATE_SNAPSHOT_DIR;
  return typeof value === "string" ? value : "";
}

/** True for a string that is a usable snapshot name. */
function isSnapshotName(name) {
  return typeof name === "string" && SNAPSHOT_NAME_RE.test(name);
}

/**
 * `FRIGATE_LIVE_SOURCES` as `{ name: url }`: a JSON object whose keys are camera names and whose
 * values are the addresses ffmpeg pulls. Bad JSON, a non-object, a name that could never be a
 * snapshot camera and a value that is not an rtsp(s) address are all dropped. Never throws, and
 * never leaves this file.
 */
function liveSources() {
  const raw = process.env.FRIGATE_LIVE_SOURCES;
  if (typeof raw !== "string" || !raw.trim()) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [name, url] of Object.entries(data)) {
    if (!isSnapshotName(name)) continue;
    if (typeof url !== "string" || !RTSP_RE.test(url)) continue;
    out[name] = url;
  }
  return out;
}

/** Loaded server modules, per file name: a module is imported once per process. */
const serverModules = new Map();

/** One of this bundle's server modules, or null. Never throws. */
function serverModule(fileName) {
  if (!serverModules.has(fileName)) {
    serverModules.set(fileName, importServerModule(fileName).catch(() => null));
  }
  return serverModules.get(fileName);
}

async function importServerModule(fileName) {
  const home = process.env.CROW_HOME || join(homedir(), ".crow");
  const candidates = [join(home, "bundles", "frigate", "server", fileName)];
  const appRoot = process.env.CROW_APP_ROOT;
  if (typeof appRoot === "string" && appRoot) {
    candidates.push(join(appRoot, "bundles", "frigate", "server", fileName));
  }
  try {
    candidates.push(fileURLToPath(new URL(`../server/${fileName}`, import.meta.url)));
  } catch {
    // A module URL that cannot be read as a path: the two candidates above still stand.
  }
  for (const path of candidates) {
    try {
      return await import(pathToFileURL(path).href);
    } catch {
      // try the next copy
    }
  }
  return null;
}

/** The live-view cooldown file: one per instance, beside the rest of its state. */
function cooldownFilePath() {
  const home = process.env.CROW_HOME || join(homedir(), ".crow");
  return join(home, "frigate-live-cooldown.json");
}

/** Set by a test to stand in for the real live manager; null restores it. */
let liveManagerOverride = null;
/**
 * The manager built for one reading of the environment, rebuilt when that reading changes:
 * `{ key, manager, pending }`. The key is the raw sources value, so an edited address
 * produces a fresh manager with a fresh view of its own sessions.
 */
let liveManagerState = { key: null, manager: null, pending: null };

/** Test seam: a stand-in live manager (or null to go back to the real one). */
export function _setLiveManagerForTest(manager) {
  liveManagerOverride = manager && typeof manager === "object" ? manager : null;
  liveManagerState = { key: null, manager: null, pending: null };
}

/** The process-wide live-view manager, built lazily from this instance's own modules. */
async function liveManager() {
  if (liveManagerOverride) return liveManagerOverride;
  const key = typeof process.env.FRIGATE_LIVE_SOURCES === "string" ? process.env.FRIGATE_LIVE_SOURCES : "";
  if (liveManagerState.key === key) {
    if (liveManagerState.manager) return liveManagerState.manager;
    if (liveManagerState.pending) return liveManagerState.pending;
  }
  const pending = (async () => {
    const live = await serverModule("live-session.js");
    if (!live || typeof live.createLiveManager !== "function") return null;
    const options = { sources: liveSources() };
    if (typeof live.createFileCooldownStore === "function") {
      options.cooldownStore = live.createFileCooldownStore(cooldownFilePath());
    }
    return live.createLiveManager(options);
  })().catch(() => null);
  liveManagerState = { key, manager: null, pending };
  const manager = await pending;
  if (liveManagerState.pending === pending) liveManagerState = { key, manager, pending: null };
  return manager;
}

/** True when this instance can show `name` live (it is a key of FRIGATE_LIVE_SOURCES). */
async function isLiveSource(name) {
  const manager = await liveManager();
  return !!(manager && typeof manager.has === "function" && manager.has(name) === true);
}

const FRIGATE_URL = () => (process.env.FRIGATE_URL || "http://localhost:8971").replace(/\/+$/, "");
const FRIGATE_USER = () => process.env.FRIGATE_USER || "";
const FRIGATE_PASSWORD = () => process.env.FRIGATE_PASSWORD || "";

const BAD_CREDENTIALS_MESSAGE = "Frigate login failed — check FRIGATE_USER / FRIGATE_PASSWORD";
const RATE_LIMIT_MESSAGE = "Frigate is rate-limiting logins; try again in a moment";
/** Frigate allows one login per second; wait past that window before trying again. */
const LOGIN_RETRY_MS = 1100;
const LOGIN_MAX_RETRIES = 3;
/** How long a failed login is replayed instead of asking Frigate again. */
const LOGIN_FAILURE_HOLD_MS = 5000;

let authToken = null;
/** The login every waiting caller shares, cleared as soon as it settles. */
let loginInFlight = null;
/** { error, until }: the last failed login, replayed within LOGIN_FAILURE_HOLD_MS. */
let loginFailure = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST /api/login once, retrying a 429 a few times before giving up. */
async function login() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${FRIGATE_URL()}/api/login`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: FRIGATE_USER(), password: FRIGATE_PASSWORD() }),
      });
      if (res.status === 429) {
        if (attempt >= LOGIN_MAX_RETRIES) throw new Error(RATE_LIMIT_MESSAGE);
        await sleep(LOGIN_RETRY_MS);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(BAD_CREDENTIALS_MESSAGE);
      if (!res.ok) throw new Error(`Frigate login failed: HTTP ${res.status}`);

      const data = await res.json().catch(() => ({}));
      let token = data.access_token || data.token || null;
      if (!token) {
        const setCookie = res.headers.get("set-cookie") || "";
        const match = setCookie.match(/frigate_token=([^;]+)/);
        if (match) token = match[1];
      }
      if (!token) throw new Error("Frigate /api/login returned no token");
      return token;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function getToken() {
  if (authToken) return authToken;
  if (!FRIGATE_USER() || !FRIGATE_PASSWORD()) return null;

  // A login that just failed is replayed, not repeated: wrong credentials must cost one
  // request, not one per card on the page.
  if (loginFailure) {
    if (loginFailure.until > Date.now()) throw loginFailure.error;
    loginFailure = null;
  }

  if (!loginInFlight) {
    loginInFlight = login()
      .then((token) => {
        authToken = token;
        loginFailure = null;
        return token;
      })
      .catch((err) => {
        loginFailure = { error: err, until: Date.now() + LOGIN_FAILURE_HOLD_MS };
        throw err;
      })
      .finally(() => {
        loginInFlight = null;
      });
  }
  return loginInFlight;
}

async function frFetch(path, opts = {}) {
  const token = await getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${FRIGATE_URL()}${path}`, { ...opts, signal: controller.signal, headers });
    if (res.status === 401) {
      authToken = null;
      throw new Error("Authentication expired — refresh the page");
    }
    if (!res.ok) throw new Error(`Frigate ${res.status}: ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stream bytes from Frigate to the client (for stills, snapshots + clips).
 * Preserves Content-Type and Content-Length when present.
 *
 * Cache-Control is the caller's call: a still is replaced every couple of seconds, so it
 * must never be stored; an event thumbnail or snapshot is immutable and may be.
 */
async function streamFromFrigate(req, res, path, cacheControl = "private, max-age=300") {
  try {
    const upstream = await frFetch(path);
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("content-type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("content-length", cl);
    res.set("cache-control", cacheControl);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function frigateRouter(authMiddleware) {
  const router = Router();

  router.get("/api/frigate/cameras", authMiddleware, async (req, res) => {
    const doorbell = await serverModule("doorbell.js");
    const snapshots = doorbell && typeof doorbell.listSnapshotCameras === "function"
      ? await doorbell.listSnapshotCameras(snapshotDir()).catch(() => [])
      : [];
    const snapshotNames = new Set(snapshots.map((entry) => entry.name));
    const liveFlags = new Map();
    for (const name of snapshotNames) liveFlags.set(name, await isLiveSource(name));

    let cameras = [];
    let frigateError = null;
    try {
      const upstream = await frFetch("/api/config");
      const config = await upstream.json();
      cameras = Object.entries(config.cameras || {}).map(([name, cam]) => ({
        name,
        enabled: cam.enabled !== false,
        detect_enabled: cam.detect?.enabled !== false,
        width: cam.detect?.width || null,
        height: cam.detect?.height || null,
        tracked_objects: cam.objects?.track || [],
        snapshot: snapshotNames.has(name),
        live: liveFlags.get(name) === true,
      }));
    } catch (err) {
      frigateError = err.message;
    }

    // A camera that only exists as a still in the snapshot folder is still a camera to the page.
    const known = new Set(cameras.map((camera) => camera.name));
    for (const entry of snapshots) {
      if (known.has(entry.name)) continue;
      known.add(entry.name);
      cameras.push({
        name: entry.name,
        enabled: true,
        detect_enabled: false,
        width: null,
        height: null,
        tracked_objects: [],
        snapshot: true,
        live: liveFlags.get(entry.name) === true,
      });
    }

    // Frigate being down costs its own cameras only: the stills in the folder still list.
    if (frigateError !== null && snapshots.length === 0) res.json({ cameras, error: frigateError });
    else res.json({ cameras });
  });

  router.get("/api/frigate/stats", authMiddleware, async (req, res) => {
    try {
      const upstream = await frFetch("/api/stats");
      const stats = await upstream.json();
      res.json(stats);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/frigate/events", authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
      const params = new URLSearchParams({ limit: String(limit) });
      if (req.query.camera) params.set("cameras", String(req.query.camera));
      if (req.query.label) params.set("labels", String(req.query.label));
      if (req.query.has_clip) params.set("has_clip", "1");
      const upstream = await frFetch(`/api/events?${params}`);
      const events = await upstream.json();
      const out = (Array.isArray(events) ? events : []).map((e) => ({
        id: e.id,
        camera: e.camera,
        label: e.label,
        sub_label: e.sub_label || null,
        score: e.top_score ?? e.score ?? null,
        start_time: e.start_time,
        end_time: e.end_time,
        has_snapshot: !!e.has_snapshot,
        has_clip: !!e.has_clip,
      }));
      res.json({ events: out });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // One still from the snapshot folder (server/doorbell.js). The name is checked before any path
  // is built, so a request can only ever read a plain `.jpg` sitting in that folder.
  router.get("/api/frigate/snap/:file", authMiddleware, async (req, res) => {
    const file = typeof req.params.file === "string" ? req.params.file : "";
    const name = file.endsWith(SNAPSHOT_SUFFIX) ? file.slice(0, -SNAPSHOT_SUFFIX.length) : "";
    if (!isSnapshotName(name)) return res.status(404).json({ error: "Unknown snapshot" });
    const doorbell = await serverModule("doorbell.js");
    if (!doorbell || typeof doorbell.readSnapshot !== "function") {
      return res.status(404).json({ error: "Unknown snapshot" });
    }
    const still = await doorbell.readSnapshot(snapshotDir(), name);
    if (!still) return res.status(404).json({ error: "Unknown snapshot" });
    res.set("content-type", "image/jpeg");
    res.set("cache-control", "no-store");
    res.status(200).end(still.bytes);
  });

  // The live view: the manager takes the response over and streams into it, and owns its close
  // handling. A refusal is answered here, before anything has been written.
  router.get("/api/frigate/live/:name/stream.mjpg", authMiddleware, async (req, res) => {
    const name = req.params.name;
    if (!isSnapshotName(name)) return res.status(404).json({ error: "Unknown camera" });
    const manager = await liveManager();
    if (!manager || typeof manager.attach !== "function") {
      return res.status(404).json({ error: "Unknown camera" });
    }
    const answer = await manager.attach(name, res);
    if (answer && answer.ok === true) return; // the manager owns res from here
    const status = answer && Number.isInteger(answer.status) ? answer.status : 404;
    const retryAfter = answer ? Number(answer.retryAfterSec) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) res.set("retry-after", String(Math.ceil(retryAfter)));
    const message = answer && typeof answer.message === "string" && answer.message
      ? answer.message
      : "Unknown camera";
    res.status(status).json({ error: message });
  });

  router.get("/api/frigate/live/:name/status", authMiddleware, async (req, res) => {
    const name = req.params.name;
    if (!isSnapshotName(name)) return res.status(404).json({ error: "Unknown camera" });
    const manager = await liveManager();
    if (!manager || typeof manager.has !== "function" || manager.has(name) !== true) {
      return res.status(404).json({ error: "Unknown camera" });
    }
    let available = false;
    try {
      available = typeof manager.available === "function" ? (await manager.available()) === true : false;
    } catch {
      available = false;
    }
    // A manager that can say how much cooldown is left is the only one that reports it.
    const cooldown = typeof manager.cooldownLeftMs === "function" ? Number(manager.cooldownLeftMs(name)) : NaN;
    const body = { available };
    if (Number.isFinite(cooldown)) body.cooldown_seconds = cooldown > 0 ? Math.ceil(cooldown / 1000) : 0;
    res.json(body);
  });

  // Thumbnail + clip bytes proxied through the gateway so Frigate's JWT stays server-side.
  router.get("/api/frigate/events/:id/thumbnail.jpg", authMiddleware, (req, res) =>
    streamFromFrigate(req, res, `/api/events/${encodeURIComponent(req.params.id)}/thumbnail.jpg`),
  );
  router.get("/api/frigate/events/:id/snapshot.jpg", authMiddleware, (req, res) =>
    streamFromFrigate(req, res, `/api/events/${encodeURIComponent(req.params.id)}/snapshot.jpg`),
  );
  router.get("/api/frigate/:camera/latest.jpg", authMiddleware, (req, res) =>
    streamFromFrigate(req, res, `/api/${encodeURIComponent(req.params.camera)}/latest.jpg`, "no-store"),
  );

  return router;
}
