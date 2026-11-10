/**
 * How the gateway talks to a walled add-on child: an MCP stdio transport over
 * whatever command line the wall built, plus the stderr reader that keeps an
 * add-on's own output from flooding the gateway's log.
 *
 * Two pieces:
 *  - `createStderrPrefixer` turns a raw stderr stream into line-by-line
 *    `[addon:<id>] ` lines, one chunk at a time. A line never buffers more than
 *    `maxLineBytes`; the rest of an over-long line is dropped up to the next
 *    newline, and a per-second cap keeps the last `keep` lines in memory for a
 *    status surface.
 *  - `AddonStdioTransport` implements the MCP SDK `Transport` interface on top
 *    of `ReadBuffer`/`serializeMessage`, so a walled spawn's own stdout framing
 *    is the only difference from the SDK's own stdio transport. It carries the
 *    extra fds the wall hands the child (the seccomp program, the info pipe,
 *    the bind fds and the door token), and it closes the host's copies of those
 *    fds as soon as the child exists: a walled child that never starts must not
 *    leave a bind fd open in the gateway.
 *
 * The env is used exactly as given: the wall builds it, and the SDK's
 * "safe" default inheritance is not added on top of it.
 */
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { PassThrough } from "node:stream";

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

/** Appended to a line that ran past the per-line cap. */
const TRUNCATED_MARK = " …[truncated]";
/** One rate-limit window. */
const WINDOW_MS = 1000;
/** The most stderr a `stderr` reader may leave unread before chunks are dropped. */
const STDERR_COPY_LIMIT = 1024 * 1024;
/** Written once into the copy when a slow (or absent-minded) reader falls behind. */
const STDERR_TRUNCATED_LINE = "[stderr truncated]\n";

/**
 * A line-splitting, capping, rate-limited stderr reader.
 *
 * @param {object} o
 * @param {string} o.id                  the add-on id the prefix names
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.maxLineBytes=4096] the most of one line that is kept
 * @param {number} [o.maxLinesPerSec=200]
 * @param {number} [o.keep=50]           how many emitted lines `lines()` keeps
 * @param {() => number} [o.now]         test seam: the clock a window is measured on
 */
export function createStderrPrefixer({
  id,
  log = (line) => console.error(line),
  maxLineBytes = 4096,
  maxLinesPerSec = 200,
  keep = 50,
  now = Date.now,
} = {}) {
  const prefix = "[addon:" + String(id) + "] ";
  const lineCap = Number.isInteger(maxLineBytes) && maxLineBytes > 0 ? maxLineBytes : 4096;
  const perWindow = Number.isInteger(maxLinesPerSec) && maxLinesPerSec > 0 ? maxLinesPerSec : 200;
  const keepCount = Number.isInteger(keep) && keep > 0 ? keep : 50;

  let pending = Buffer.alloc(0); // the start of a line that has not ended yet
  let dropping = false; // inside an over-long line, past the cap, before its newline
  const kept = [];
  let windowStart = now();
  let windowLines = 0;
  let droppedTotal = 0;
  let droppedInWindow = 0;
  let ended = false;

  /** The raw text of one finished line, without the prefix. */
  function textOf(bytes, truncated) {
    let text = bytes.toString("utf8");
    if (truncated) {
      // A cap that fell inside a UTF-8 sequence leaves a replacement character.
      text = text.replace(/\uFFFD+$/, "");
      return text + TRUNCATED_MARK;
    }
    return text.endsWith("\r") ? text.slice(0, -1) : text;
  }

  /** One line `n` stderr lines dropped (rate limit)`, when a window left some behind. */
  function flushDropped() {
    if (droppedInWindow <= 0) return;
    const n = droppedInWindow;
    droppedInWindow = 0;
    log(prefix + n + " stderr lines dropped (rate limit)");
  }

  /** Emit one finished line: rate-limited, remembered, and prefixed on the log. */
  function emit(text) {
    const at = now();
    if (at - windowStart >= WINDOW_MS) {
      flushDropped();
      windowStart = at;
      windowLines = 0;
    }
    if (windowLines >= perWindow) {
      windowLines += 1;
      droppedTotal += 1;
      droppedInWindow += 1;
      return;
    }
    windowLines += 1;
    kept.push(text);
    while (kept.length > keepCount) kept.shift();
    log(prefix + text);
  }

  function write(chunk) {
    if (ended) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    let i = 0;
    while (i < data.length) {
      if (dropping) {
        const nl = data.indexOf(0x0a, i);
        if (nl < 0) return;
        dropping = false;
        i = nl + 1;
        continue;
      }
      const nl = data.indexOf(0x0a, i);
      const end = nl < 0 ? data.length : nl;
      const take = end - i;
      const room = lineCap - pending.length;
      if (take <= room) {
        pending = Buffer.concat([pending, data.subarray(i, end)]);
        if (nl < 0) return;
        const line = pending;
        pending = Buffer.alloc(0);
        emit(textOf(line, false));
        i = nl + 1;
        continue;
      }
      // This line ran past the cap: emit what was kept and drop the rest of it.
      pending = Buffer.concat([pending, data.subarray(i, i + room)]);
      const line = pending;
      pending = Buffer.alloc(0);
      emit(textOf(line, true));
      if (nl < 0) {
        dropping = true;
        return;
      }
      i = nl + 1;
    }
  }

  /** Flush a pending partial line and any drop summary. Idempotent. */
  function end() {
    if (ended) return;
    if (!dropping && pending.length > 0) {
      const line = pending;
      pending = Buffer.alloc(0);
      emit(textOf(line, false));
    }
    dropping = false;
    ended = true;
    flushDropped();
  }

  return {
    write,
    end,
    lines: () => kept.slice(),
    dropped: () => droppedTotal,
  };
}

/**
 * The MCP stdio transport for a wall-built command line.
 *
 * `stdioExtra` places an fd or a pipe at its `childFd`:
 *  - `{ childFd, fd }` an already-open host fd (a bind fd, the seccomp file);
 *  - `{ childFd, pipe: "read", role }` a pipe the child writes and the gateway
 *    reads (`extraStreams[role]`);
 *  - `{ childFd, pipe: "write", data, role }` a pipe the gateway writes once and
 *    then ends (the door token).
 * Whatever sits between those slots is `"ignore"`.
 */
export const _STDERR_COPY_LIMIT = STDERR_COPY_LIMIT;

export class AddonStdioTransport {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {string} o.command
   * @param {string[]} [o.args]
   * @param {object} o.env                 used as given, never merged with a default
   * @param {string} [o.cwd="/"]
   * @param {object[]} [o.stdioExtra=[]]
   * @param {(() => void)|null} [o.onExit] called once when the child closes, before `onclose`
   * @param {(line: string) => void} [o.log]
   */
  constructor({ id, command, args = [], env, cwd = "/", stdioExtra = [], onExit = null, log } = {}) {
    this.id = id;
    this.command = command;
    this.args = Array.isArray(args) ? args : [];
    this.env = env;
    this.cwd = cwd;
    this.stdioExtra = Array.isArray(stdioExtra) ? stdioExtra : [];
    this.onExit = typeof onExit === "function" ? onExit : null;
    this.sessionId = undefined;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
    /** Read-only pipes the wall handed the child, by role (the info pipe). */
    this.extraStreams = {};

    this._readBuffer = new ReadBuffer();
    // The raw stderr copy exists only once a reader asks for it (the getter):
    // with no reader, nothing is buffered beyond the prefixer's own line cap.
    this._stderrStream = null;
    this._stderrDropping = false;
    this._stderrEnded = false;
    this._prefixer = createStderrPrefixer(log ? { id, log } : { id });
    this._proc = null;
    this._exited = false;
    this._exitCode = null;
    this._started = false;
  }

  /** The spawned process's pid, or null. */
  get pid() {
    return this._proc?.pid ?? null;
  }

  /** The child's exit code, or null while it runs (and for a killed child). */
  get exitCode() {
    return Number.isInteger(this._exitCode) ? this._exitCode : null;
  }

  /**
   * A copy of the child's stderr, for existing readers, created on first use.
   * A reader that falls more than STDERR_COPY_LIMIT behind loses chunks (one
   * "[stderr truncated]" line marks the gap): the child and the prefixer never
   * wait on it, and the gateway never buffers more than that limit for it.
   */
  get stderr() {
    if (!this._stderrStream) {
      this._stderrStream = new PassThrough();
      if (this._stderrEnded) this._stderrStream.end();
    }
    return this._stderrStream;
  }

  /** Copy one stderr chunk to the reader, if there is one, within the limit. */
  _copyStderr(chunk) {
    const s = this._stderrStream;
    if (!s || s.writableEnded) return;
    if (s.writableLength + chunk.length > STDERR_COPY_LIMIT) {
      if (!this._stderrDropping) {
        this._stderrDropping = true;
        try { s.write(STDERR_TRUNCATED_LINE); } catch { /* a reader that went away */ }
      }
      return;
    }
    this._stderrDropping = false;
    try { s.write(chunk); } catch { /* a reader that went away */ }
  }

  /** The last emitted stderr lines, without the prefix. */
  stderrLines() {
    return this._prefixer.lines();
  }

  async start() {
    if (this._started) throw new Error("AddonStdioTransport already started");
    this._started = true;

    const stdio = ["pipe", "pipe", "pipe"];
    const writes = [];
    const reads = [];
    for (const entry of this.stdioExtra) {
      if (!entry || typeof entry !== "object") continue;
      const childFd = Number(entry.childFd);
      if (!Number.isInteger(childFd) || childFd < 3) continue;
      while (stdio.length < childFd) stdio.push("ignore");
      if (Number.isInteger(entry.fd)) {
        stdio[childFd] = entry.fd;
      } else if (entry.pipe === "read") {
        stdio[childFd] = "pipe";
        reads.push({ childFd, role: typeof entry.role === "string" ? entry.role : String(childFd) });
      } else if (entry.pipe === "write") {
        stdio[childFd] = "pipe";
        writes.push({ childFd, data: entry.data });
      }
    }

    return new Promise((resolve, reject) => {
      let proc;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      try {
        proc = spawn(this.command, this.args, {
          env: this.env,
          cwd: this.cwd,
          stdio,
          detached: false,
          shell: false,
        });
      } catch (err) {
        settle(reject, err);
        try { this.onerror?.(err); } catch { /* a throwing handler is the caller's */ }
        return;
      } finally {
        // R7: the child holds these now; the gateway's copies go immediately.
        // The number is dropped first, so a later cleanup never closes it twice.
        for (const entry of this.stdioExtra) {
          if (!Number.isInteger(entry.fd)) continue;
          const fd = entry.fd;
          entry.fd = null;
          try { closeSync(fd); } catch { /* already closed */ }
        }
      }

      this._proc = proc;

      proc.on("error", (err) => {
        try { this.onerror?.(err); } catch { /* the caller's handler */ }
        settle(reject, err);
      });
      proc.on("spawn", () => settle(resolve, undefined));
      proc.on("close", (code) => {
        this._proc = undefined;
        this._exitCode = Number.isInteger(code) ? code : null;
        if (!this._exited) {
          this._exited = true;
          if (this.onExit) {
            try { this.onExit(); } catch { /* cleanup must not depend on it */ }
          }
        }
        // A tail line without a newline is still worth logging, and a reader of
        // the PassThrough must see the end.
        try { this._prefixer.end(); } catch { /* nothing left to flush */ }
        this._stderrEnded = true;
        try { this._stderrStream?.end(); } catch { /* already ended */ }
        this.onclose?.();
      });

      proc.stdin?.on("error", (err) => {
        try { this.onerror?.(err); } catch { /* the caller's handler */ }
      });
      proc.stdout?.on("data", (chunk) => {
        this._readBuffer.append(chunk);
        this._processReadBuffer();
      });
      proc.stdout?.on("error", (err) => {
        try { this.onerror?.(err); } catch { /* the caller's handler */ }
      });
      proc.stderr?.on("data", (chunk) => {
        this._copyStderr(chunk);
        this._prefixer.write(chunk);
      });
      proc.stderr?.on("error", (err) => {
        try { this.onerror?.(err); } catch { /* the caller's handler */ }
      });

      for (const { childFd, data } of writes) {
        const stream = proc.stdio?.[childFd];
        if (!stream) continue;
        stream.on("error", () => { /* the child may be gone already */ });
        stream.end(data == null ? "" : String(data));
      }
      for (const { childFd, role } of reads) {
        const stream = proc.stdio?.[childFd];
        if (stream) this.extraStreams[role] = stream;
      }
    });
  }

  _processReadBuffer() {
    while (true) {
      let message;
      try {
        message = this._readBuffer.readMessage();
      } catch (err) {
        try { this.onerror?.(err); } catch { /* the caller's handler */ }
        return;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  send(message) {
    return new Promise((resolve) => {
      const stdin = this._proc?.stdin;
      if (!stdin) throw new Error("Not connected");
      const json = serializeMessage(message);
      if (stdin.write(json)) resolve();
      else stdin.once("drain", resolve);
    });
  }

  /** The SDK's own close sequence: stdin end, then SIGTERM, then SIGKILL. */
  async close() {
    const proc = this._proc;
    if (proc) {
      this._proc = undefined;
      const closePromise = new Promise((resolve) => {
        proc.once("close", () => resolve());
      });
      try {
        proc.stdin?.end();
      } catch { /* ignore */ }
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      if (proc.exitCode === null) {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      }
      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
    this._readBuffer.clear();
  }
}