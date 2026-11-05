/**
 * The eval's sampling proxy: a loopback, single-model stand-in for the arm's endpoint, between pi
 * and the model server the operator brought up.
 *
 * Why it exists: pi (pi-ai/dist/api/openai-completions.js) sends only `temperature`, so an arm's
 * rows would record a sampling setting nobody enforced. The proxy pins the pre-registered
 * sampling (score.mjs SAMPLING plus seed 1000+rep) on every chat request, records what it put on
 * the wire (so a row's `sampling` is an observation, not the constant) and records the tool names
 * pi offered on each request (the runner aborts a unit whose surface is not exactly the granted
 * set).
 *
 * It is not a sandbox and it starts nothing: it forwards to one already-running base URL that the
 * preflight checked, and only on the two routes below. When pi's request closes (a killed turn)
 * the upstream request is destroyed, so a dead turn never leaves the arm's model generating; and
 * both the connect and the idle wait are bounded.
 *
 * Rows read: `requests` (count), `observedSampling()`, `summary()`.
 */
import http from "node:http";
import https from "node:https";
import { SAMPLING, seedFor } from "./score.mjs";

export const SAMPLING_KEYS = Object.freeze(["temperature", "top_p", "top_k", "min_p", "seed"]);
/** How long a connect may take, and how long the upstream may stay silent mid-response. */
export const CONNECT_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 120_000;
const MAX_BODY = 8 * 1024 * 1024;

const readBody = (req) => new Promise((resolve, reject) => {
  const parts = [];
  let n = 0;
  req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error("request body too large")); req.destroy(); return; } parts.push(c); });
  req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  req.on("error", reject);
});

const sendJson = (res, status, obj) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

/** The tool names pi offered on one request: OpenAI's tools[].function.name. */
const toolNamesOf = (body) => (Array.isArray(body?.tools) ? body.tools : [])
  .map((t) => (t && t.function && typeof t.function.name === "string" ? t.function.name : null)).filter(Boolean);

/**
 * The pre-registered sampling for one rep, as the proxy pins it.
 * @param {number} rep
 */
export const samplingFor = (rep) => Object.freeze({ ...SAMPLING, seed: seedFor(rep) });

/**
 * @param {{upstream: string, model: string, rep: number, expectedTools?: string[]|null, host?: string,
 *   connectTimeoutMs?: number, idleTimeoutMs?: number}} opts
 *   upstream: the arm's checked base URL, e.g. http://127.0.0.1:<port>/v1
 *   expectedTools: the exact set pi must offer (null = not checked)
 * @returns {Promise<{baseUrl: string, port: number, requests: object[], observedSampling: () => (object|null),
 *   summary: () => {requests: number, overrode_keys: string[], tools_ok: boolean|null}, close: () => Promise<void>}>}
 */
export async function startSamplingProxy({
  upstream, model, rep, expectedTools = null, host = "127.0.0.1",
  connectTimeoutMs = CONNECT_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS,
} = {}) {
  if (typeof upstream !== "string" || !/^https?:\/\//.test(upstream)) throw new Error("sampling proxy: upstream must be an http(s) base URL");
  if (typeof model !== "string" || !model) throw new Error("sampling proxy: model is required");
  if (!Number.isInteger(rep) || rep < 0) throw new Error("sampling proxy: rep must be a non-negative integer");
  const plan = samplingFor(rep);
  const base = upstream.replace(/\/+$/, "");
  const up = new URL(base);
  const agentLib = up.protocol === "https:" ? https : http;

  const requests = [];
  const sockets = new Set();
  const inflight = new Set();

  /** Forwards one request upstream; resolves to {status, headers, stream} or rejects. */
  const forward = (method, path, headers, body) => new Promise((resolve, reject) => {
    const req = agentLib.request({
      protocol: up.protocol, hostname: up.hostname, port: up.port, method, path: `${up.pathname.replace(/\/$/, "")}${path}`,
      headers: { ...headers, host: up.host },
    }, (res) => { resolve({ status: res.statusCode, headers: res.headers, stream: res }); });
    inflight.add(req);
    // A connect that never completes is bounded here (no infinite hang before pi's own timeout).
    const connectTimer = setTimeout(() => { req.destroy(new Error(`upstream connect timed out after ${connectTimeoutMs} ms`)); }, connectTimeoutMs);
    req.on("socket", (s) => { s.once("connect", () => clearTimeout(connectTimer)); });
    req.on("error", (err) => { clearTimeout(connectTimer); inflight.delete(req); reject(err); });
    req.on("close", () => { clearTimeout(connectTimer); inflight.delete(req); });
    if (body !== null && body !== undefined) req.end(body); else req.end();
  });

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    // Only the two read/write routes, and nothing else: this is not a general proxy.
    if (!(req.method === "GET" && path === "/v1/models") && !(req.method === "POST" && path === "/v1/chat/completions")) {
      sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
      return;
    }
    let body = null;
    if (req.method === "POST") {
      let raw;
      try { raw = await readBody(req); } catch (err) { sendJson(res, 413, { error: { message: err.message } }); return; }
      try { body = JSON.parse(raw || "{}"); } catch { sendJson(res, 400, { error: { message: "invalid JSON body" } }); return; }
      if (body.model !== model) {
        // A request for any other model must never reach the arm's endpoint.
        sendJson(res, 400, { error: { message: `sampling proxy serves only ${model}` } });
        return;
      }
      const overrode = [];
      for (const k of SAMPLING_KEYS) if (body[k] !== plan[k]) overrode.push(k);
      const pinned = { ...body, model, ...plan };
      requests.push({ path, sampling: { ...plan }, overrode_keys: overrode, tools: toolNamesOf(pinned) });
      body = pinned;
    } else {
      requests.push({ path, sampling: null, overrode_keys: [], tools: null });
    }
    const headers = { ...req.headers };
    delete headers.host;
    if (body !== null) headers["content-length"] = String(Buffer.byteLength(JSON.stringify(body)));
    else delete headers["content-length"];

    let upstreamRes;
    try {
      upstreamRes = await forward(req.method, path.replace(/^\/v1/, ""), headers, body === null ? null : JSON.stringify(body));
    } catch (err) {
      sendJson(res, 502, { error: { message: String(err && err.message) } });
      return;
    }
    // Idle bound: a model that accepts the request and then says nothing is cut off, not waited on.
    let idle = null;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => upstreamRes.stream.destroy(new Error("upstream idle timeout")), idleTimeoutMs); };
    touch();
    // pi's request closing (a killed or timed-out turn) must not leave the model generating.
    req.on("close", () => { clearTimeout(idle); upstreamRes.stream.destroy(); });
    res.writeHead(upstreamRes.status, (() => {
      const h = { ...upstreamRes.headers };
      delete h["content-length"]; // streamed through, possibly re-chunked
      delete h["transfer-encoding"];
      return h;
    })());
    // Flush the status line now: a silent upstream still gives pi a live response to abort.
    res.flushHeaders();
    upstreamRes.stream.on("data", (chunk) => { touch(); res.write(chunk); });
    upstreamRes.stream.on("end", () => { clearTimeout(idle); res.end(); });
    upstreamRes.stream.on("error", () => { clearTimeout(idle); res.destroy(); });
    res.on("close", () => { clearTimeout(idle); upstreamRes.stream.destroy(); });
  });

  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const { port } = server.address();
  return {
    baseUrl: `http://${host}:${port}/v1`,
    port,
    requests,
    /** The sampling the proxy actually put on the wire, or null when no chat request went through. */
    observedSampling() {
      const seen = requests.filter((r) => r.sampling !== null).map((r) => r.sampling);
      if (!seen.length) return null;
      const last = seen.at(-1);
      // A different setting on any request would make the row's sampling a lie: say so.
      const same = seen.every((s) => SAMPLING_KEYS.every((k) => s[k] === last[k]));
      return { ...last, uniform: same };
    },
    summary() {
      const chats = requests.filter((r) => r.sampling !== null);
      const overrode = [...new Set(chats.flatMap((r) => r.overrode_keys))].sort();
      if (expectedTools === null || expectedTools === undefined) return { requests: chats.length, overrode_keys: overrode, tools_ok: null };
      const want = [...expectedTools].sort();
      const ok = chats.length > 0 && chats.every((r) => JSON.stringify([...r.tools].sort()) === JSON.stringify(want));
      return { requests: chats.length, overrode_keys: overrode, tools_ok: ok };
    },
    close() {
      for (const r of inflight) { try { r.destroy(); } catch { /* gone */ } }
      return new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
    },
  };
}