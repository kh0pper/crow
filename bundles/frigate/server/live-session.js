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
 *   - ffmpeg's stdout is parsed on the multipart boundary and only WHOLE frames are queued to a
 *     viewer: one that falls behind loses its oldest queued frame, and one that falls a long way
 *     behind is hung up, so no viewer ever receives half a JPEG;
 *   - the last viewer leaving kills the process group at once;
 *   - a hard timer set at session START — never renewed — kills it at `capMs` and ends every
 *     response, ffmpeg's own `-t` backing that up if this process dies. `remainingMs` reports
 *     what is left of it, and each viewer is told the same number in a response header;
 *   - any exit, error or spawn failure ends the viewers, records a cooldown and starts nothing;
 *   - a cooldown holds the next start off for `cooldownMs`. It is written when a session STARTS
 *     (start + cap + cooldown) as well as when it ends, so a gateway that dies mid-view is still
 *     followed by a cooldown. Cooldown reads and writes all go through the injected store, so a
 *     page reload or a gateway restart does not reset it (`createFileCooldownStore` is the
 *     production-shaped one).
 *
 * The session body runs through `runDetached`, which the host sets to `withoutWriteContext`: an
 * ffmpeg and its timers outlive the dashboard request that started them.
 *
 * Every setting arrives as an argument; nothing here reads the environment, and nothing is
 * logged. Error text that leaves the module — `lastError()`, an `attach()` message — is passed
 * through `scrubUrl`, so the stream URL, any `user:pass@` credential in it and the URL's own
 * username and password are never echoed. Stderr is published whole lines at a time: only text up
 * to the last newline of the raw buffer is reported, so a read that ends inside a URL cannot echo
 * the rest of the credential; the incomplete tail is published when the child is gone, and then
 * only up to a URL or the head of the URL's own credentials.
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
/**
 * Raw stderr kept per camera, and how much of it `lastError` reports. The raw buffer is several
 * times the reported window on purpose: it is scrubbed WHOLE and only then cut down to the
 * window, so a credential that straddles the cut point cannot survive as a fragment.
 */
const STDERR_RAW_CHARS = 8000;
const STDERR_KEEP_CHARS = 500;
const URL_PLACEHOLDER = "<stream-url>";
const BOUNDARY = "ffmpeg";
/** ffmpeg's mpjpeg framing: a boundary line, headers, the declared bytes, and a trailing CRLF. */
const BOUNDARY_LINE = Buffer.from(`--${BOUNDARY}\r\n`, "latin1");
const PART_HEADER_END = Buffer.from("\r\n\r\n", "latin1");
/** The CRLF ffmpeg writes after a part's body. */
const PART_CRLF = Buffer.from("\r\n", "latin1");
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/** A frame bigger than this, or a header block this long, means the stream is not mpjpeg. */
const MAX_PART_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
/** A buffer that grows past this without yielding a whole frame ends the session as an error. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Whole frames a viewer may hold while its response is backed up, and the ceiling that ends it. */
const MAX_VIEWER_PARTS = 3;
const MAX_VIEWER_BYTES = 1024 * 1024;

/**
 * Remove a stream URL and its credentials from text: the exact URL, any scheme-qualified URL
 * that carries `user:pass@` credentials, any bare `user:pass@host` fragment, and — given the
 * url — that URL's own username and password on their own (raw or percent-decoded), so a
 * message that echoes nothing but the credential, or a window that starts inside it, cannot leak
 * it either. Every replacement is `<stream-url>`. Non-string input reads as empty text.
 */
export function scrubUrl(text, url) {
  let out = typeof text === "string" ? text : text == null ? "" : String(text);
  if (typeof url === "string" && url.length > 0) {
    out = out.split(url).join(URL_PLACEHOLDER);
    for (const secret of urlSecrets(url)) out = out.split(secret).join(URL_PLACEHOLDER);
  }
  // Anything carrying credentials in a scheme-qualified URL, and the bare user:pass@ form.
  out = out.replace(/[a-z][a-z0-9+.\-]*:\/\/[^\s"'<>]*@[^\s"'<>]*/gi, URL_PLACEHOLDER);
  out = out.replace(/[^\s"'<>/@:]+:[^\s"'<>/@]*@[^\s"'<>]*/g, URL_PLACEHOLDER);
  return out;
}

/**
 * The parts of a URL that are credentials on their own: the username, the password, and their
 * percent-decoded forms, longest first so a longer secret is replaced before a shorter one it
 * happens to contain. Anything under three characters is left alone: replacing it would rewrite
 * ordinary words in an ordinary error message.
 */
function urlSecrets(url) {
  const secrets = new Set();
  const add = (value) => {
    if (typeof value !== "string" || value.length < 3) return;
    secrets.add(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded !== value && decoded.length >= 3) secrets.add(decoded);
    } catch {
      // Not percent-encoded text: the raw form is all there is.
    }
  };
  try {
    const parsed = new URL(url);
    add(parsed.username);
    add(parsed.password);
  } catch {
    // Not a URL `new URL` understands; the exact-string and pattern replacements still apply.
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * The ffmpeg argv for one camera.
 *
 * ffmpeg takes credentials only inside the URL, so they have to be in argv — and argv is world
 * readable through `/proc/<pid>/cmdline`, which any local user can open unless `/proc` is mounted
 * with `hidepid` (the 0600 env file does not help there: a different local user, or a service
 * account, can read the credential out of `ps` while a view runs). That is an accepted residual of
 * this design, closed by either a scoped, view-only RTSP user — so a leaked credential can do
 * nothing else — or `hidepid=invisible` on a multi-user host. A loopback-only, credential-free
 * restream in front of ffmpeg would remove it entirely.
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
 * The part that ends at `bodyEnd`, always with a trailing CRLF.
 *
 * When the frame's own CRLF is already in the buffer it is taken with the part. When a read ended
 * exactly at the last body byte the CRLF is added here instead, so no part ever reaches a viewer
 * without it; the copy that arrives with the next read is then dropped as bytes before the next
 * boundary line, exactly like any other byte outside a part.
 */
function cutPart(buffer, bodyEnd) {
  if (bodyEnd + PART_CRLF.length <= buffer.length && buffer[bodyEnd] === 0x0d && buffer[bodyEnd + 1] === 0x0a) {
    return { part: buffer.subarray(0, bodyEnd + PART_CRLF.length), consumed: bodyEnd + PART_CRLF.length };
  }
  return { part: Buffer.concat([buffer.subarray(0, bodyEnd), PART_CRLF]), consumed: bodyEnd };
}

/**
 * Cut the next WHOLE multipart part off the front of `session.stdoutBuffer`.
 *
 * Returns `{ part }` — the part exactly as ffmpeg framed it, boundary line through the trailing
 * CRLF — `{ error }` when the stream cannot be mpjpeg, or null when more bytes are needed. Bytes
 * before the first boundary line belong to no frame and are dropped. The body is taken from
 * `Content-length` when the part declares one, and otherwise from the JPEG's own SOI/EOI markers.
 */
function takePart(session) {
  let buffer = session.stdoutBuffer;
  const at = buffer.indexOf(BOUNDARY_LINE);
  if (at < 0) return null; // the boundary line has not arrived in full yet
  if (at > 0) {
    buffer = buffer.subarray(at);
    session.stdoutBuffer = buffer;
  }

  const headerStart = BOUNDARY_LINE.length;
  const headerEnd = buffer.indexOf(PART_HEADER_END, headerStart);
  if (headerEnd < 0) {
    if (buffer.length > MAX_HEADER_BYTES) return { error: "a live frame's header never ended" };
    return null;
  }
  const bodyStart = headerEnd + PART_HEADER_END.length;
  const headers = buffer.subarray(headerStart, headerEnd).toString("latin1");
  const declared = /content-length:\s*(\d+)/i.exec(headers);

  if (declared) {
    const length = Number(declared[1]);
    if (!Number.isFinite(length) || length <= 0) return { error: "a live frame declared no usable size" };
    if (length > MAX_PART_BYTES) return { error: `a live frame was larger than ${MAX_PART_BYTES} bytes` };
    if (buffer.length < bodyStart + length) return null; // the body is still arriving
    const { part, consumed } = cutPart(buffer, bodyStart + length);
    session.stdoutBuffer = buffer.subarray(consumed);
    return { part };
  }

  // No Content-length: let the JPEG delimit its own body.
  const soi = buffer.indexOf(JPEG_SOI, bodyStart);
  if (soi < 0) {
    if (buffer.length - bodyStart > MAX_HEADER_BYTES) return { error: "a live frame carried no JPEG" };
    return null;
  }
  const eoi = buffer.indexOf(JPEG_EOI, soi + JPEG_SOI.length);
  if (eoi < 0) {
    if (buffer.length - soi > MAX_PART_BYTES) return { error: `a live frame was larger than ${MAX_PART_BYTES} bytes` };
    return null;
  }
  const { part, consumed } = cutPart(buffer, eoi + JPEG_EOI.length);
  session.stdoutBuffer = buffer.subarray(consumed);
  return { part };
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
  // The host passes `withoutWriteContext` here (an installed bundle copy cannot import from
  // servers/), so a session's ffmpeg and timers are not tied to the request that started them.
  const runDetached = typeof opts.runDetached === "function" ? opts.runDetached : (fn) => fn();

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
    // A running session keeps the guard it wrote at START (`start + cap + cooldown`) in the store.
    // That guard is for a restart, not for this process, and reporting it as a cooldown would tell
    // a viewer that was refused because the session is full to wait up to three minutes.
    const running = typeof name === "string" ? sessions.get(name) : undefined;
    if (running) return 0;
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

  function recordCooldown(name, untilMs) {
    try {
      cooldownStore.set(name, untilMs);
    } catch {
      // A store that cannot write still must not break a teardown.
    }
  }

  /** The milliseconds left before a running session's hard cap, or 0 when none runs. */
  function remainingFor(session) {
    if (!session || session.ended) return 0;
    const left = capMs - (clockMs() - session.startedAt);
    return left > 0 ? left : 0;
  }

  function remainingMs(name) {
    const session = typeof name === "string" ? sessions.get(name) : undefined;
    return session ? remainingFor(session) : 0;
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

  function writeHead(res, remaining) {
    const headers = {
      "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      // What is left of the cap, so a viewer that joins a running session counts down the time
      // this stream really has instead of a fresh 120 s.
      "x-live-remaining-seconds": String(Math.max(0, Math.ceil(remaining / 1000))),
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

  function makeViewer(res) {
    return { res, queue: [], waiting: false, retired: false, hungUp: false, onClose: null, onDrain: null };
  }

  function endViewer(viewer) {
    if (!viewer || viewer.hungUp) return;
    viewer.hungUp = true;
    try {
      if (typeof viewer.res.end === "function") viewer.res.end();
    } catch {
      // Already closed by the client.
    }
  }

  /**
   * Take a viewer out of the session and drop whatever it had queued. `hangUp` also ends its
   * response — a viewer we are disconnecting, rather than one that left on its own.
   */
  function retireViewer(session, viewer, hangUp) {
    if (!viewer || viewer.retired) return;
    viewer.retired = true;
    viewer.queue.length = 0;
    viewer.waiting = false;
    try {
      if (viewer.onClose && typeof viewer.res.removeListener === "function") {
        viewer.res.removeListener("close", viewer.onClose);
        viewer.res.removeListener("error", viewer.onClose);
        if (viewer.onDrain) viewer.res.removeListener("drain", viewer.onDrain);
      }
    } catch {
      // A response without listeners needs no cleanup.
    }
    viewer.onClose = null;
    viewer.onDrain = null;
    session.viewers.delete(viewer);
    if (hangUp) endViewer(viewer);
    if (session.viewers.size === 0) endSession(session, "last-viewer");
  }

  function detach(session, viewer) {
    retireViewer(session, viewer, false);
  }

  function attachViewer(session, viewer) {
    session.viewers.add(viewer);
    writeHead(viewer.res, remainingFor(session));
    const onClose = () => detach(session, viewer);
    viewer.onClose = onClose;
    try {
      viewer.res.on("close", onClose);
      viewer.res.on("error", onClose);
    } catch {
      // No event support: the viewer lives until the session ends.
    }
  }

  /** Bytes of whole frames still waiting for a viewer's response. */
  function queueBytes(viewer) {
    let total = 0;
    for (const part of viewer.queue) total += part.length;
    return total;
  }

  /** Write queued whole frames until the response asks for a pause, then wait for `drain`. */
  function flushViewer(session, viewer) {
    while (!viewer.retired && !viewer.waiting && viewer.queue.length > 0) {
      const part = viewer.queue.shift();
      let flushed;
      try {
        flushed = viewer.res.write(part);
      } catch {
        detach(session, viewer);
        return;
      }
      if (flushed !== false) continue;
      viewer.waiting = true;
      if (typeof viewer.res.once !== "function") {
        // No way to hear about `drain`: try again on the next frame rather than spin here.
        viewer.waiting = false;
        return;
      }
      viewer.onDrain = () => {
        viewer.onDrain = null;
        if (viewer.retired) return;
        viewer.waiting = false;
        flushViewer(session, viewer);
      };
      try {
        viewer.res.once("drain", viewer.onDrain);
      } catch {
        viewer.onDrain = null;
        viewer.waiting = false;
      }
      return;
    }
  }

  /**
   * Hand one WHOLE frame to one viewer. A viewer that is behind drops its OLDEST queued frame —
   * never half of one — and one that has fallen MAX_VIEWER_BYTES behind is hung up, so a stalled
   * phone cannot grow this process's memory without limit.
   */
  function deliverPart(session, viewer, part) {
    if (!viewer || viewer.retired || session.ended) return;
    viewer.queue.push(part);
    while (viewer.queue.length > MAX_VIEWER_PARTS) viewer.queue.shift();
    if (queueBytes(viewer) > MAX_VIEWER_BYTES) {
      retireViewer(session, viewer, true);
      return;
    }
    flushViewer(session, viewer);
  }

  /** End a session: rewrite the cooldown to run from now, then kill the group and hang up. */
  function endSession(session, reason) {
    if (!session || session.ended) return;
    session.ended = true;
    session.reason = reason;
    session.stdoutBuffer = Buffer.alloc(0);
    if (session.capTimer != null) {
      try {
        clearTimer(session.capTimer);
      } catch {
        // A timer that cannot be cleared is harmless: it checks `ended`.
      }
      session.capTimer = null;
    }
    sessions.delete(session.name);
    // Rewrite the guard written at start: from here the cooldown runs from the moment it ended.
    recordCooldown(session.name, clockMs() + cooldownMs);
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
    for (const viewer of [...session.viewers]) retireViewer(session, viewer, true);
    session.viewers.clear();
  }

  /** End the session because its byte stream is not a usable mpjpeg stream. */
  function failStream(session, message) {
    if (!session || session.ended) return;
    errors.set(session.name, scrubUrl(message, session.url).slice(-STDERR_KEEP_CHARS));
    session.stdoutBuffer = Buffer.alloc(0);
    endSession(session, "stream-error");
  }

  function wireStdout(session, child) {
    const stdout = child.stdout;
    if (!stdout || typeof stdout.on !== "function") return;
    stdout.on("data", (chunk) => {
      if (session.ended) return;
      let bytes;
      try {
        bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      } catch {
        return;
      }
      session.stdoutBuffer = session.stdoutBuffer.length === 0 ? bytes : Buffer.concat([session.stdoutBuffer, bytes]);
      for (;;) {
        const next = takePart(session);
        if (!next) break;
        if (next.error) {
          failStream(session, next.error);
          return;
        }
        // Only whole frames leave this module: every viewer gets the same, complete part.
        for (const viewer of [...session.viewers]) deliverPart(session, viewer, next.part);
        if (session.ended) return;
      }
      if (session.stdoutBuffer.length > MAX_BUFFER_BYTES) {
        failStream(session, `the live stream never yielded a whole frame within ${MAX_BUFFER_BYTES} bytes`);
      }
    });
  }

  /**
   * The incomplete last line of stderr, as much of it as is safe to publish: a tail that carries a
   * scheme-qualified URL, or the head of the URL's own username or password, is cut back to before
   * it. Nothing here echoes a fragment that could be the rest of a credential.
   */
  function safeStderrTail(tail, url) {
    if (typeof tail !== "string" || tail.length === 0) return "";
    let end = tail.length;
    const schemeAt = tail.lastIndexOf("://");
    if (schemeAt >= 0 && schemeAt < end) end = schemeAt;
    for (const secret of urlSecrets(url)) {
      for (let length = secret.length; length >= 3; length--) {
        const at = tail.lastIndexOf(secret.slice(0, length));
        if (at < 0) continue;
        if (at < end) end = at;
        break;
      }
    }
    return tail.slice(0, end);
  }

  /**
   * Publish stderr into the error text, whole lines only.
   *
   * The raw buffer is kept well past the reported window and scrubbed WHOLE, so a cut point that
   * lands inside a credential has nothing left to leak, and only text up to the last newline is
   * reported: a read that ended mid-URL (a chunk boundary ffmpeg does not write, but a pipe can
   * still produce) leaves no half-credential to echo. `includeTail` reports the last, incomplete
   * line as well, past a URL and the head of a known secret; it is passed when the child is gone
   * and its last line will never be finished.
   */
  function publishStderr(session, includeTail) {
    const raw = typeof session.stderrRaw === "string" ? session.stderrRaw : "";
    const newline = raw.lastIndexOf("\n");
    const complete = newline < 0 ? "" : raw.slice(0, newline + 1);
    const tail = includeTail ? safeStderrTail(raw.slice(newline + 1), session.url) : "";
    const text = scrubUrl(complete + tail, session.url).slice(-STDERR_KEEP_CHARS);
    // Nothing safe to publish yet (no complete line): leave a spawn error's message in place.
    if (text.length > 0) errors.set(session.name, text);
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
      session.stderrRaw = (session.stderrRaw + text).slice(-STDERR_RAW_CHARS);
      publishStderr(session, false);
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

  /**
   * Start the camera's one session. Returns the session, or null when it could not start.
   *
   * The body runs through `runDetached` — the host passes `withoutWriteContext` — because the
   * ffmpeg, its timers and the session itself outlive the dashboard request that asked for them
   * and must not keep that request's write context. The default runs the body directly.
   */
  function startSession(name) {
    let session = null;
    const returned = runDetached(() => {
      session = beginSession(name);
      return session;
    });
    if (session) return session;
    // A runner that defers has not opened the session yet: whatever it started, if anything, is
    // in the map, and there is nothing to attach to here.
    if (returned && typeof returned.then === "function") return sessions.get(name) || null;
    return null;
  }

  function beginSession(name) {
    const url = urlFor(name);
    if (!url) return null;
    installExitHook();
    const startedAt = clockMs();
    const session = {
      name,
      url,
      startedAt,
      child: null,
      viewers: new Set(),
      ended: false,
      reason: "",
      capTimer: null,
      killTimer: null,
      stderrRaw: "",
      stdoutBuffer: Buffer.alloc(0),
    };
    sessions.set(name, session);
    // The cooldown is written NOW, for the whole time this session may run: if this process is
    // killed mid-view, the next tab still cannot start a fresh call. `endSession` rewrites it to
    // end + cooldown.
    recordCooldown(name, startedAt + capMs + cooldownMs);
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
      // ffmpeg is gone, so its last line will never be finished: report it too, without a URL.
      publishStderr(session, true);
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

  function tooManyViewers() {
    return { ok: false, status: 429, message: "Live view already has all of its viewers" };
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
    // A running session already holds the cooldown it wrote when it started — that guard is for a
    // restart, not for this process — so only a START has to wait one out.
    const running = sessions.get(name);
    if (running) {
      if (running.viewers.size >= maxViewers) return tooManyViewers();
    } else {
      const cooling = cooldownLeftMs(name);
      if (cooling > 0) return cooldownRefusal(cooling);
    }

    const ok = await available();
    if (!ok) return { ok: false, status: 503, message: "Live view needs ffmpeg" };

    // The probe was awaited: another viewer may have started or ended the session meanwhile.
    let session = sessions.get(name);
    if (session) {
      if (session.viewers.size >= maxViewers) return tooManyViewers();
    } else {
      const coolingAgain = cooldownLeftMs(name);
      if (coolingAgain > 0) return cooldownRefusal(coolingAgain);
      session = startSession(name);
      if (!session) return { ok: false, status: 503, message: "Live view could not start" };
    }
    attachViewer(session, makeViewer(res));
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

  return { has, available, attach, lastError, stopAll, cooldownLeftMs, remainingMs };
}