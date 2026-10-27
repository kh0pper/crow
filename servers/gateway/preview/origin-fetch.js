/**
 * The preview renderer's only way to the artifact (R4-C2). The preview browser has no
 * network: every request it makes is paused over CDP, and the gateway answers the
 * allowed ones itself with a GET to the artifact origin's own listener, over loopback.
 * This module is that GET, bounded so a hostile or broken artifact cannot hold the
 * gateway's memory or time:
 *
 *   - it connects to the listener's bind address (artifactOriginInfo().bindHost and
 *     port), never to the host in the paused URL, and sends only the path and query;
 *   - GET only, and no header from the browser is forwarded (no Cookie, Referer,
 *     Authorization, User-Agent or Origin);
 *   - a 3xx is `redirect` and is never followed;
 *   - one response may be at most 8 MB, one render 32 MB and 100 requests, with at most
 *     4 in flight; bytes are counted as they arrive and the read is cut the moment a
 *     cap is passed;
 *   - each request has 5 s, counted from when it is sent (not while it waits for a
 *     slot), and every request ends when the session's signal aborts (the render's end).
 *
 * A Session never rejects: every failure is a `reason`.
 */
import http from "node:http";

export const PREVIEW_LIMITS = Object.freeze({
  requestMs: 5000,
  renderMs: 15000,
  responseBytes: 8 * 1024 * 1024,
  renderBytes: 32 * 1024 * 1024,
  requests: 100,
  inFlight: 4,
});

/**
 * @param {{ host: string, port: number, limits?: typeof PREVIEW_LIMITS }} opts
 * @returns {{ session(o?: { signal?: AbortSignal }): {
 *   get(pathAndQuery: string): Promise<{ ok: true, status: number, headers: [string, string][], body: Buffer } | { ok: false, reason: "redirect"|"cap_response"|"cap_render"|"cap_requests"|"timeout"|"aborted"|"error" }>,
 *   stats(): { requests: number, bytes: number, maxInFlight: number } } }}
 */
export function createOriginFetcher({ host, port, limits = PREVIEW_LIMITS }) {
  const lim = { ...PREVIEW_LIMITS, ...limits };
  // node:http takes a bare IPv6 address as `host`; strip URL-style brackets.
  const bind = String(host).replace(/^\[|\]$/g, "");

  return {
    session({ signal } = {}) {
      const ended = signal || new AbortController().signal;
      let calls = 0;
      let requests = 0;
      let bytes = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      const queue = [];
      // One listener on the session's signal, whatever the number of requests: a
      // listener per request would pass Node's default of 10 and warn in the log.
      const onEnd = new Set();
      if (!ended.aborted) ended.addEventListener("abort", () => { for (const fn of [...onEnd]) fn(); }, { once: true });

      // A slot for one request; resolves false when the session ended while waiting.
      function slot() {
        if (inFlight < lim.inFlight) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); return Promise.resolve(true); }
        return new Promise((resolve) => {
          const entry = { resolve };
          entry.onAbort = () => { const i = queue.indexOf(entry); if (i !== -1) queue.splice(i, 1); onEnd.delete(entry.onAbort); resolve(false); };
          onEnd.add(entry.onAbort);
          queue.push(entry);
        });
      }
      function free() {
        const next = queue.shift();
        if (next) {
          onEnd.delete(next.onAbort);
          maxInFlight = Math.max(maxInFlight, inFlight);
          next.resolve(true);
        } else inFlight--;
      }

      function request(path) {
        return new Promise((resolve) => {
          // The session may have ended while this request waited for its slot.
          if (ended.aborted) return resolve({ ok: false, reason: "aborted" });
          let settled = false;
          let req = null;
          const parts = [];
          let got = 0;
          let timer = null;
          const done = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            onEnd.delete(onAbort);
            if (!v.ok && req) req.destroy();
            resolve(v);
          };
          const onAbort = () => done({ ok: false, reason: "aborted" });
          timer = setTimeout(() => done({ ok: false, reason: "timeout" }), lim.requestMs);
          onEnd.add(onAbort);
          requests++;
          try {
            req = http.request({
              host: bind, port, path, method: "GET",
              // Nothing from the paused request: the origin sees only what is written here.
              headers: { accept: "*/*" },
              agent: false,
            }, (res) => {
              const status = res.statusCode || 0;
              if (status >= 300 && status < 400) return done({ ok: false, reason: "redirect" });
              const declared = Number(res.headers["content-length"]);
              if (Number.isFinite(declared) && declared > lim.responseBytes) return done({ ok: false, reason: "cap_response" });
              res.on("data", (chunk) => {
                if (settled) return;
                got += chunk.length;
                bytes += chunk.length;
                if (got > lim.responseBytes) return done({ ok: false, reason: "cap_response" });
                if (bytes > lim.renderBytes) return done({ ok: false, reason: "cap_render" });
                parts.push(chunk);
              });
              res.on("end", () => {
                const headers = [];
                const raw = res.rawHeaders || [];
                for (let i = 0; i + 1 < raw.length; i += 2) headers.push([String(raw[i]).toLowerCase(), String(raw[i + 1])]);
                done({ ok: true, status, headers, body: Buffer.concat(parts, got) });
              });
              res.on("error", () => done({ ok: false, reason: "error" }));
              res.on("aborted", () => done({ ok: false, reason: "error" }));
            });
            req.on("error", () => done({ ok: false, reason: "error" }));
            req.end();
          } catch {
            // A path or option http.request refuses synchronously: never a rejection.
            done({ ok: false, reason: "error" });
          }
        });
      }

      return {
        async get(pathAndQuery) {
          if (ended.aborted) return { ok: false, reason: "aborted" };
          if (++calls > lim.requests) return { ok: false, reason: "cap_requests" };
          const path = String(pathAndQuery);
          if (!path.startsWith("/")) return { ok: false, reason: "error" };
          if (!(await slot())) return { ok: false, reason: "aborted" };
          try { return await request(path); } finally { free(); }
        },
        stats() { return { requests, bytes, maxInFlight }; },
      };
    },
  };
}
