/**
 * A CDP client over a pipe: Chromium's --remote-debugging-pipe framing, JSON messages
 * each terminated by a NUL byte, in both directions. The preview renderer wraps the
 * `docker compose run` child's stdin (input) and stdout (output) in it; the test
 * fixture's Chrome uses the same client over its fds 3 and 4.
 *
 * Anything on output that is not a CDP frame closes the client with `bad_frame`: a frame
 * that does not start with "{" (caught at its first byte, so a CLI that prints
 * "Creating…" fails at once instead of waiting for a NUL), one that is not valid JSON,
 * or one longer than maxFrameBytes. Every pending send then rejects.
 */

/**
 * @param {{ input: import("node:stream").Writable, output: import("node:stream").Readable, maxFrameBytes?: number }} opts
 */
export function createPipeCdp({ input, output, maxFrameBytes = 16 * 1024 * 1024 }) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let parts = [];
  let size = 0;
  let done = false;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });

  function finish(reason) {
    if (done) return;
    done = true;
    output.off("data", onData);
    output.off("end", onEnd);
    output.off("close", onEnd);
    parts = [];
    for (const { reject } of pending.values()) reject(new Error(`CDP pipe closed (${reason})`));
    pending.clear();
    resolveClosed({ reason });
  }

  function dispatch(msg) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`CDP ${p.method}: ${msg.error.message || "error"}`), { code: msg.error.code }));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      for (const fn of [...(listeners.get(msg.method) || [])]) {
        try { fn(msg.params || {}, msg); } catch { /* a listener's throw is its own */ }
      }
    }
  }

  // Appends bytes to the current frame; false (and closed) when they can't be a frame.
  function take(bytes) {
    if (!bytes.length) return true;
    if (size === 0 && bytes[0] !== 0x7b) { finish("bad_frame"); return false; }
    size += bytes.length;
    if (size > maxFrameBytes) { finish("bad_frame"); return false; }
    parts.push(bytes);
    return true;
  }

  function onData(chunk) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let start = 0;
    while (!done) {
      const nul = buf.indexOf(0, start);
      if (nul === -1) { take(buf.subarray(start)); return; }
      if (!take(buf.subarray(start, nul))) return;
      start = nul + 1;
      const frame = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      size = 0;
      let msg;
      try { msg = JSON.parse(frame.toString("utf8")); } catch { finish("bad_frame"); return; }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) { finish("bad_frame"); return; }
      dispatch(msg);
    }
  }

  // EOF mid-frame is a broken frame; a clean EOF is "eof".
  function onEnd() { finish(size > 0 ? "bad_frame" : "eof"); }

  output.on("data", onData);
  output.once("end", onEnd);
  output.once("close", onEnd);
  output.on("error", () => finish("eof"));
  input.on("error", () => finish("eof"));

  return {
    send(method, params = {}, sessionId) {
      if (done) return Promise.reject(new Error("CDP pipe closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        try {
          input.write(JSON.stringify(msg) + "\0");
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    close() { finish("closed"); },
    closed,
  };
}
