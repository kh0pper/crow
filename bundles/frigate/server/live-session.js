/**
 * Frigate live view — one ffmpeg per camera, shared by every viewer.
 *
 * A battery doorbell allows one call at a time, so the server decides when it happens and how
 * long it lasts, not the browser. The route hands `attach()` a response and nothing else: the
 * camera's stream URL is held by the caller (from the gateway environment) and never leaves this
 * module. `attach()` answers 404 for an unknown name, 503 while ffmpeg is missing or a session is
 * cooling down, 429 when the session already has its viewers, and otherwise takes the response
 * over as one more viewer of the camera's single session.
 *
 * The rules that matter are all server-side, because a page that reconnects in a loop must not
 * become a continuous stream:
 *   - the first viewer starts ffmpeg; later viewers share that one process (max `maxViewers`);
 *   - the last viewer leaving kills the process group at once;
 *   - a hard timer set at session START — never renewed — kills it at `capMs` and ends every
 *     response, ffmpeg's own `-t` backing that up if this process dies;
 *   - any exit, error or spawn failure ends the viewers, records a cooldown and starts nothing;
 *   - a cooldown holds the next start off for `cooldownMs`. Cooldown reads and writes all go
 *     through the injected store, so a page reload or a gateway restart does not reset it
 *     (`createFileCooldownStore` is the production-shaped one).
 *
 * Every setting arrives as an argument; nothing here reads the environment, and nothing is
 * logged. Error text that leaves the module — `lastError()`, an `attach()` message — is passed
 * through `scrubUrl`, so the stream URL and any `user:pass@` credential in it are never echoed.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSnapshotName } from "./doorbell.js";

export const DEFAULT_CAP_MS = 120_000;
export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_VIEWERS = 3;
/** How long a killed group is given to leave on SIGTERM before SIGKILL. */
const KILL_ESCALATE_MS = 2000;
/** Raw stderr kept per camera, and how much of it `lastError` reports. */
const STDERR_TAIL_CHARS = 1000;
const STDERR_KEEP_CHARS = 500;
const URL_PLACEHOLDER = "<stream-url>";
const BOUNDARY = "ffmpeg";

/**
 * Remove a stream URL from text: the exact URL, any scheme-qualified URL that carries
 * `user:pass@` credentials, and any bare `user:pass@host` fragment become `<stream-url>`.
 * Non-string input reads as empty text.
 */
export function scrubUrl(text, url) {
  let out = typeof text === "string" ? text : text == null ? "" : String(text);
  if (typeof url === "string" && url.length > 0) out = out.split(url).join(URL_PLACEHOLDER);
  // Anything carrying credentials in a scheme-qualified URL, and the bare user:pass@ form.
  out = out.replace(/[a-z][a-z0-9+.\-]*:\/\/[^\s"'<>]*@[^\s"'<>]*/gi, URL_PLACEHOLDER);
  out = out.replace(/[^\s"'<>/@:]+:[^\s"'<>/@]*@[^\s"'<>]*/g, URL_PLACEHOLDER);
  return out;
}

/**
 * The ffmpeg argv for one camera.
 *
 * The URL is in argv, where same-user local processes can read it. ffmpeg accepts credentials
 * only inside the URL, so there is no other way to hand them over; those processes can read the
 * gateway's env file anyway, so this adds no reach to them.
 */
function buildArgv(url, capMs) {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", url,
    "-an",
    "-vf", "fps=5,scale=640:-2",
    "-q:v", "7",
    "-t", String(Math.ceil(capMs / 1000)),
    "-f", "mpjpeg",
    "-boundary_tag", BOUNDARY,
    "pipe:1",
  ];
}

/** A cooldown store that lives as long as the manager. */
function memoryCooldownStore() {
  const until = new Map();
  return {
    get(name) { return until.get(name); },
    set(name, at) { until.set(name, at); },
  };
}

/** SIGTERM/SIGKILL the child's whole process group, or the child itself when it has no pid. */
function defaultKillGroup(signal, child) {
  const pid = child && Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
  if (pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is already gone; fall through to the child, which is guarded too.
    }
  }
  try {
    if (child && typeof child.kill === "function") child.kill(signal);
  } catch {
    // Nothing left to signal.
  }
}

/**
 * A JSON file of `{ name: untilMs }` behind the same two methods a Map has, written atomically
 * (temp file next to it, then rename, mode 0600). The file is read lazily and once; a corrupt or
 * unreadable file reads as empty, expired entries read as no cooldown, and a write that cannot
 * happen leaves the in-memory answer in place. Nothing here throws.
 */
export function createFileCooldownStore(filePath, options = {}) {
  const now = options && typeof options.now === "function" ? options.now : Date.now;
  if (typeof filePath !== "string" || !filePath) {
    return { get() { return undefined; }, set() {} };
  }
  let loaded = null;
  let sequence = 0;

  function clockMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function load() {
    if (loaded) return loaded;
    loaded = new Map();
    let text = null;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      return loaded;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return loaded;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return loaded;
    const at = clockMs();
    for (const [name, until] of Object.entries(data)) {
      const ms = Number(until);
      if (isSnapshotName(name) && Number.isFinite(ms) && ms > at) loaded.set(name, ms);
    }
    return loaded;
  }

  function persist(entries) {
    const at = clockMs();
    const out = {};
    for (const [name, until] of entries) if (Number.isFinite(until) && until > at) out[name] = until;
    const tmp = `${filePath}.${process.pid}.${++sequence}.tmp`;
    try {
      try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      } catch {
        // A directory already there, or one we cannot make: the write below is the real test.
      }
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      renameSync(tmp, filePath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
    }
  }

  return {
    get(name) {
      if (typeof name !== "string") return undefined;
      const entries = load();
      const until = entries.get(name);
      if (!Number.isFinite(until)) return undefined;
      if (until <= clockMs()) {
        entries.delete(name);
        return undefined;
      }
      return until;
    },
    set(name, untilMs) {
      if (!isSnapshotName(name)) return;
      const until = Number(untilMs);
      if (!Number.isFinite(until)) return;
      load().set(name, until);
      persist(loaded);
    },
  };
}

/**
 * Build a live-view manager. Everything it touches — the clock, the timers, the spawn, the kill
 * and the cooldown store — is injectable, so the whole lifecycle runs on fakes.
 */
export function createLiveManager(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const sources = opts.sources && typeof opts.sources === "object" ? opts.sources : {};
  const spawn = typeof opts.spawn === "function" ? opts.spawn : nodeSpawn;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const setTimer = typeof opts.setTimer === "function" ? opts.setTimer : setTimeout;
  const clearTimer = typeof opts.clearTimer === "function" ? opts.clearTimer : clearTimeout;
  const capMs = Number.isFinite(opts.capMs) && opts.capMs > 0 ? opts.capMs : DEFAULT_CAP_MS;
  const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
  const maxViewers = Number.isInteger(opts.maxViewers) && opts.maxViewers > 0 ? opts.maxViewers : DEFAULT_MAX_VIEWERS;
  const ffmpegPath = typeof opts.ffmpegPath === "string" && opts.ffmpegPath ? opts.ffmpegPath : "ffmpeg";
  const cooldownStore = opts.cooldownStore && typeof opts.cooldownStore.get === "function" && typeof opts.cooldownStore.set === "function"
    ? opts.cooldownStore
    : memoryCooldownStore();
  const killGroup = typeof opts.killGroup === "function" ? opts.killGroup : defaultKillGroup;

  const sessions = new Map(); // name → session
  const errors = new Map(); // name → scrubbed, last STDERR_KEEP_CHARS of stderr
  const liveGroups = new Set(); // { child } still running, for the process-exit sweep
  let availability = null;
  let exitHookInstalled = false;

  function clockMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function urlFor(name) {
    return typeof sources[name] === "string" ? sources[name] : "";
  }

  /** True when `name` is one of this manager's own usable sources. */
  function has(name) {
    if (!isSnapshotName(name)) return false;
    if (!Object.hasOwn(sources, name)) return false;
    const url = sources[name];
    return typeof url === "string" && url.length > 0;
  }

  function cooldownLeftMs(name) {
    let until = NaN;
    try {
      until = Number(cooldownStore.get(name));
    } catch {
      return 0;
    }
    if (!Number.isFinite(until)) return 0;
    const left = until - clockMs();
    return left > 0 ? left : 0;
  }

  function cooldownRefusal(leftMs) {
    const retryAfterSec = Math.max(1, Math.ceil(leftMs / 1000));
    return {
      ok: false,
      status: 503,
      retryAfterSec,
      message: `Live view is cooling down; try again in ${retryAfterSec} s`,
    };
  }

  function recordCooldown(name) {
    try {
      cooldownStore.set(name, clockMs() + cooldownMs);
    } catch {
      // A store that cannot write still must not break a teardown.
    }
  }

  /** True when ffmpeg can be run at all; the probe happens once and its answer is kept. */
  function available() {
    if (availability) return availability;
    availability = new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value === true);
      };
      let child = null;
      try {
        child = spawn(ffmpegPath, ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        done(false);
        return;
      }
      if (!child || typeof child.once !== "function") {
        done(false);
        return;
      }
      try {
        child.once("error", () => done(false));
        child.once("exit", (code) => done(code === 0));
        child.once("close", (code) => done(code === 0));
      } catch {
        done(false);
      }
    });
    return availability;
  }

  function writeHead(res) {
    const headers = {
      "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    };
    try {
      if (typeof res.writeHead === "function") {
        res.writeHead(200, headers);
        return;
      }
      if (typeof res.setHeader === "function") {
        for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      }
      res.statusCode = 200;
    } catch {
      // The response may already be gone; the viewer's close event will detach it.
    }
  }

  function endViewer(viewer) {
    if (!viewer || viewer.ended) return;
    viewer.ended = true;
    try {
      if (typeof viewer.res.end === "function") viewer.res.end();
    } catch {
      // Already closed by the client.
    }
  }

  function detach(session, viewer) {
    if (!viewer || viewer.ended) return;
    viewer.ended = true;
    try {
      if (viewer.onClose && typeof viewer.res.removeListener === "function") {
        viewer.res.removeListener("close", viewer.onClose);
        viewer.res.removeListener("error", viewer.onClose);
      }
    } catch {
      // A response without listeners needs no cleanup.
    }
    session.viewers.delete(viewer);
    if (session.viewers.size === 0) endSession(session, "last-viewer");
  }

  function attachViewer(session, viewer) {
    session.viewers.add(viewer);
    writeHead(viewer.res);
    const onClose = () => detach(session, viewer);
    viewer.onClose = onClose;
    try {
      viewer.res.on("close", onClose);
      viewer.res.on("error", onClose);
    } catch {
      // No event support: the viewer lives until the session ends.
    }
  }

  /** End a session: cooldown first (its start is the moment it ends), then kill and hang up. */
  function endSession(session, reason) {
    if (!session || session.ended) return;
    session.ended = true;
    session.reason = reason;
    if (session.capTimer != null) {
      try {
        clearTimer(session.capTimer);
      } catch {
        // A timer that cannot be cleared is harmless: it checks `ended`.
      }
      session.capTimer = null;
    }
    sessions.delete(session.name);
    recordCooldown(session.name);
    if (session.child) {
      killGroup("SIGTERM", session.child);
      try {
        session.killTimer = setTimer(() => {
          session.killTimer = null;
          killGroup("SIGKILL", session.child);
        }, KILL_ESCALATE_MS);
        if (session.killTimer && typeof session.killTimer.unref === "function") session.killTimer.unref();
      } catch {
        session.killTimer = null;
      }
    }
    for (const viewer of [...session.viewers]) endViewer(viewer);
    session.viewers.clear();
  }

  function wireStdout(session, child) {
    const stdout = child.stdout;
    if (!stdout || typeof stdout.on !== "function") return;
    stdout.on("data", (chunk) => {
      let frame;
      try {
        frame = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      } catch {
        return;
      }
      for (const viewer of [...session.viewers]) {
        if (viewer.ended || viewer.dropping) continue;
        let flushed = true;
        try {
          flushed = viewer.res.write(frame);
        } catch {
          detach(session, viewer);
          continue;
        }
        // A viewer that cannot keep up drops frames instead of growing a buffer without limit.
        if (flushed === false) {
          viewer.dropping = true;
          if (typeof viewer.res.once === "function") {
            viewer.res.once("drain", () => { viewer.dropping = false; });
          } else {
            viewer.dropping = false;
          }
        }
      }
    });
  }

  function wireStderr(session, child) {
    const stderr = child.stderr;
    if (!stderr || typeof stderr.on !== "function") return;
    stderr.on("data", (chunk) => {
      let text;
      try {
        text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      } catch {
        return;
      }
      session.stderrTail = (session.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      errors.set(session.name, scrubUrl(session.stderrTail, session.url).slice(-STDERR_KEEP_CHARS));
    });
  }

  function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    try {
      // One handler for the manager's whole life: a gateway exit must not orphan an ffmpeg.
      process.once("exit", () => {
        for (const entry of liveGroups) {
          if (!entry || !entry.child) continue;
          try {
            killGroup("SIGKILL", entry.child);
          } catch {
            // Nothing left to signal.
          }
        }
      });
    } catch {
      exitHookInstalled = false;
    }
  }

  /** Start the camera's one session. Returns the session, or null when it could not start. */
  function startSession(name) {
    const url = urlFor(name);
    if (!url) return null;
    installExitHook();
    const session = {
      name,
      url,
      child: null,
      viewers: new Set(),
      ended: false,
      reason: "",
      capTimer: null,
      killTimer: null,
      stderrTail: "",
    };
    sessions.set(name, session);
    // The cap runs from START and is never renewed: a viewer joining later inherits what is left.
    try {
      session.capTimer = setTimer(() => endSession(session, "cap"), capMs);
      if (session.capTimer && typeof session.capTimer.unref === "function") session.capTimer.unref();
    } catch {
      session.capTimer = null;
    }

    let child = null;
    try {
      child = spawn(ffmpegPath, buildArgv(url, capMs), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      errors.set(name, scrubUrl(String(err && err.message ? err.message : err), url).slice(-STDERR_KEEP_CHARS));
      endSession(session, "spawn-error");
      return null;
    }
    if (!child || typeof child !== "object") {
      errors.set(name, "ffmpeg did not start");
      endSession(session, "spawn-error");
      return null;
    }
    session.child = child;

    const entry = { child };
    liveGroups.add(entry);
    let gone = false;
    const onGone = (reason) => {
      if (gone) return;
      gone = true;
      liveGroups.delete(entry);
      if (session.killTimer != null) {
        try {
          clearTimer(session.killTimer);
        } catch {
          // Leaving it to fire is harmless.
        }
        session.killTimer = null;
      }
      endSession(session, reason);
    };
    try {
      if (typeof child.once === "function") {
        child.once("exit", () => onGone("ffmpeg-exit"));
        child.once("close", () => onGone("ffmpeg-exit"));
        child.once("error", (err) => {
          errors.set(name, scrubUrl(String(err && err.message ? err.message : err), url).slice(-STDERR_KEEP_CHARS));
          onGone("ffmpeg-error");
        });
      }
    } catch {
      // A child without events: the cap timer still ends the session.
    }
    wireStdout(session, child);
    wireStderr(session, child);
    return session;
  }

  /**
   * The only entry point a route calls. On success it has taken `res` over and streams the
   * camera's pictures into it; on refusal `res` is untouched.
   */
  async function attach(name, res) {
    if (!has(name)) return { ok: false, status: 404, message: "Unknown camera" };
    if (!res || typeof res.write !== "function" || typeof res.on !== "function") {
      return { ok: false, status: 500, message: "Live view needs a writable response" };
    }
    const cooling = cooldownLeftMs(name);
    if (cooling > 0) return cooldownRefusal(cooling);

    const ok = await available();
    if (!ok) return { ok: false, status: 503, message: "Live view needs ffmpeg" };

    // The probe was awaited: another viewer may have started or ended the session meanwhile.
    const coolingAgain = cooldownLeftMs(name);
    if (coolingAgain > 0) return cooldownRefusal(coolingAgain);
    let session = sessions.get(name);
    if (session && session.viewers.size >= maxViewers) {
      return { ok: false, status: 429, message: "Live view already has all of its viewers" };
    }
    if (!session) {
      session = startSession(name);
      if (!session) return { ok: false, status: 503, message: "Live view could not start" };
    }
    attachViewer(session, { res, dropping: false, ended: false, onClose: null });
    return { ok: true };
  }

  /** The scrubbed tail of the last session's stderr for `name`, or "". */
  function lastError(name) {
    const text = typeof name === "string" ? errors.get(name) : undefined;
    return typeof text === "string" ? text : "";
  }

  /** End every session and hang up every viewer now. */
  function stopAll() {
    for (const session of [...sessions.values()]) endSession(session, "stop");
  }

  return { has, available, attach, lastError, stopAll };
}