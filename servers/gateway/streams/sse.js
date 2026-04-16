/**
 * Server-Sent Events primitive for Turbo Streams and chat streaming.
 *
 * Produces a small { send, sendRaw, close } interface over an Express
 * response. Heartbeats (30s `: keepalive`) keep the connection alive
 * through intermediate proxies (Tailscale Serve, Caddy, nginx). The
 * 'error' handler on the response is critical on Node 18+: without it,
 * an EPIPE from a dropped client crashes the process.
 *
 * Funnel safety: this primitive has no knowledge of paths. Stream
 * routes that use it MUST be mounted under a prefix that is omitted
 * from `PUBLIC_FUNNEL_PREFIXES` in `servers/gateway/index.js`
 * (currently `/dashboard/streams/*`). See also `authed-stream.js` for
 * session-aware streaming.
 */

export function openStream(res, { heartbeatMs = 30000 } = {}) {
  if (res.headersSent) {
    throw new Error("openStream: response headers already sent");
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  let closed = false;

  const sendRaw = (line) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(line);
    } catch {
      // Broken pipe; close idempotently. 'error' handler below also fires.
      close();
    }
  };

  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    sendRaw(`event: ${event}\ndata: ${payload}\n\n`);
  };

  const heartbeat = setInterval(() => {
    sendRaw(": keepalive\n\n");
  }, heartbeatMs);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Already torn down; swallow.
      }
    }
  };

  res.on("close", close);
  res.on("error", close);

  return { send, sendRaw, close };
}
