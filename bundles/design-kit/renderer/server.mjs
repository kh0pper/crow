// Design kit renderer — the HTTP core (spec §3.3). POST /render {engine, source}
// → 200 {svg} | {error: {code, category?, line?}}; GET /health. One render at a
// time (CPU stays bounded), a queue cap (busy → 503, retryable), a wall-clock
// limit per render (timeout → the engine is reset), input and output caps.
// node: imports only, so the suite tests it with fake engines.
import { createServer } from "node:http";
import { shortError } from "./errors.mjs";

export const DEFAULT_LIMITS = Object.freeze({ requestBytes: 96 * 1024, specBytes: 64 * 1024, svgBytes: 2 * 1024 * 1024, renderMs: 15000, queue: 4 });
// The door relays bytes, so the caller's Host arrives unchanged: only the
// loopback names are accepted (DNS-rebinding defence, review M5).
export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["127.0.0.1:8018", "localhost:8018"]);

export function createRenderServer({ engines, clean = (s) => s, limits = DEFAULT_LIMITS, log = () => {}, allowedHosts = new Set(DEFAULT_ALLOWED_HOSTS) }) {
  let chain = Promise.resolve();
  let pending = 0;
  const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
  const fail = (res, status, code, category = null, line = null) =>
    send(res, status, { error: { code, ...(category ? { category } : {}), ...(Number.isInteger(line) ? { line } : {}) } });

  async function runOne(engine, source) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { crowTimeout: true })), limits.renderMs); });
    try { return await Promise.race([engines[engine].render(source, { timeoutMs: limits.renderMs }), timeout]); }
    catch (e) { if (e && e.crowTimeout && engines[engine].reset) await bounded(engines[engine].reset()); throw e; }
    finally { clearTimeout(timer); }
  }

  // A reset gets the same wall-clock limit as a render: one that never settles
  // must not wedge the serial queue behind it.
  async function bounded(p) {
    let timer;
    try { await Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => { timer = setTimeout(r, limits.renderMs); })]); }
    finally { clearTimeout(timer); }
  }

  const server = createServer((req, res) => {
    if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) return fail(res, 403, "bad_host");
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, engines: Object.keys(engines) });
    if (req.method !== "POST" || req.url !== "/render") return fail(res, 404, "not_found");
    // Only application/json: a simple cross-site POST (text/plain, form) never reaches the queue.
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) { req.resume(); return fail(res, 415, "bad_content_type"); }
    const chunks = [];
    let size = 0;
    req.on("error", () => {});   // a client that hangs up mid-body is not a crash
    req.on("data", (c) => { size += c.length; if (size <= limits.requestBytes) chunks.push(c); });
    req.on("end", async () => {
      if (size > limits.requestBytes) return fail(res, 413, "too_large", "input");
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(res, 400, "bad_request"); }
      const engine = body && body.engine;
      const source = body && body.source;
      if (typeof engine !== "string" || !Object.hasOwn(engines, engine)) return fail(res, 400, "bad_engine");
      if (typeof source !== "string") return fail(res, 400, "bad_request");
      if (Buffer.byteLength(source) > limits.specBytes) return fail(res, 413, "too_large", "input");
      if (pending >= limits.queue) return fail(res, 503, "busy");
      pending++;
      const job = chain.then(() => runOne(engine, source));
      chain = job.catch(() => {});
      try {
        const raw = await job;
        if (typeof raw !== "string") throw new Error("render error");
        if (Buffer.byteLength(raw) > limits.svgBytes * 4) return fail(res, 422, "too_large", "output");
        const svg = await clean(raw);
        if (Buffer.byteLength(svg) > limits.svgBytes) return fail(res, 422, "too_large", "output");
        send(res, 200, { svg });
      } catch (e) {
        const s = shortError(engine, e);
        log(`[render] ${engine}: ${s.category}`);   // never the spec, never a stack
        fail(res, 422, "render_failed", s.category, s.line);
      } finally { pending--; }
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
