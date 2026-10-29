/**
 * The cloud door, /llm/c/<provider>/v1/... (roles phase 2, Task 16).
 *
 * Bots (pi) never hold a cloud key. They hold the per-boot cloud-door token
 * (local-token.js `rotateLlmCloudToken`) and post here; the gateway adds the
 * provider row's real key on the upstream leg only. So the door must never be
 * reachable by anything but a process on this box, must never forward to an
 * address the operator did not agree to, and must never let the key out.
 *
 * Who may call (`createCloudDoor().gate`), in this order:
 *   - never through Funnel (FUNNEL_REFUSED);
 *   - peer-class.js's "local" rule (`isLocalPeer`): a loopback socket, no
 *     forwarding header (X-Forwarded-For/-Host/-Proto, X-Real-IP, Forwarded)
 *     and no `tailscale-*` header. A same-box reverse proxy such as Tailscale
 *     Serve arrives as loopback and says so in those headers;
 *   - `Authorization: Bearer <token>` or `x-api-key: <token>` is the cloud-door
 *     token, checked against its own hash only (CLOUD_TOKEN_REFUSED).
 * The source checks come first, so an off-box caller never reaches the token
 * check. There is no --no-auth bypass: this module never reads that flag.
 * A same-box forwarder that adds none of those headers (`tailscale serve
 * --tcp` onto the gateway port, a host-network container, a proxy that only
 * sets Via or CF-Connecting-IP) looks exactly like a bot: there the token is
 * the only gate.
 * At most `maxConcurrent` (default 8) requests are in flight per gateway;
 * above that the door answers 429 DOOR_BUSY.
 *
 * Where it may go (`resolveCloudTarget`, re-run on EVERY request with a fresh
 * row and a fresh consent read, so a sync rewrite or a revoke takes effect on
 * the next request): the row's OWN base URL, over https only
 * (INSECURE_TARGET otherwise: the key would travel in clear), and only while
 * this box's consent entry still matches that URL and key (`consentVerdict`).
 * The host never comes from provider_type or any other column; provider_type
 * only picks the auth header and the op set. Ops are an allowlist, so the
 * path cannot be steered. The upstream call is `safeRequest` in cloud mode:
 * no redirect is followed (a 3xx answers 502 UPSTREAM_REDIRECT), and a name
 * that resolves to a non-public or own address is refused at connect time.
 *
 * What passes: request headers in REQUEST_HEADER_ALLOW (plus anthropic-version
 * and anthropic-beta for anthropic rows) and the real key; the body
 * re-serialised with a fresh content-length, minus the fields in
 * STRIPPED_BODY_FIELDS (all of them, whatever the row's auth style) (OpenRouter's `models`/`route`/`provider` would let a
 * bot pick models outside the row's list; anthropic's `mcp_servers` would make
 * the provider call URLs the bot chose). Provider server tools (web_search and
 * the like) are kept: they run on the provider, billed to the user's own key.
 * For anthropic, the `beta=true` query pi 0.85.1 adds, and no other query
 * parameter. Back to the caller: the status, the body and only the response
 * headers in RESPONSE_HEADER_ALLOW plus any `*-ratelimit-*` and the
 * content-encoding. The literal key and the caller's token are removed from
 * those header values and from non-2xx bodies (buffered, at most 1 MB sent;
 * redacted before the cut, so a secret straddling it never leaks a prefix).
 *
 * Timeouts (never an unbounded wait): `headersMs` (default 10 min) is the
 * budget for the upstream to start answering, because a non-streamed
 * completion sends its headers only when the whole answer is ready. Once the
 * body starts, a long stream is NOT cut by that budget: `idleMs` (default
 * 2 min without a byte, reset on every chunk and on client drain) and a total
 * cap `totalMs` (default 30 min) govern it. A cut stream destroys the
 * response, so the caller sees a broken stream, never a complete-looking one.
 * A client that goes away, before or after the upstream headers, aborts the
 * upstream request at once.
 *
 * The key is never logged: log lines name the provider, model, op, host and
 * status only, and errors carry `err.code` from safeRequest.
 */
import dns from "node:dns";
import zlib from "node:zlib";
import { isIP } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { isPublicIp } from "../../shared/ip-classify.js";
import { isLocalPeer } from "../../shared/peer-class.js";
import { isLocalClassTarget, isForbiddenTarget, isDoorUrl } from "./door-resolve.js";
import { consentVerdict } from "../../shared/cloud-consent.js";
import { safeRequest } from "./safe-upstream.js";
import { extractUsageFromOpenAIResponse, extractUsageFromAnthropicStream } from "../../shared/metering.js";

export const CLOUD_OPS = Object.freeze({
  openai: Object.freeze(["chat/completions", "completions", "embeddings"]),
  anthropic: Object.freeze(["messages"]),
});
export const REQUEST_HEADER_ALLOW = Object.freeze(["content-type", "accept"]);
const ANTHROPIC_REQUEST_HEADER_ALLOW = Object.freeze(["anthropic-version", "anthropic-beta"]);
export const RESPONSE_HEADER_ALLOW = Object.freeze(["content-type", "retry-after", "x-should-retry", "request-id", "x-request-id"]);
const RATELIMIT_HEADER = /(^|-)ratelimit-/;
export const STRIPPED_BODY_FIELDS = Object.freeze({
  openai: Object.freeze(["models", "route", "provider"]),
  anthropic: Object.freeze(["mcp_servers"]),
});
// Stripped by the body's shape, whatever the row's auth style: a router behind
// an anthropic-type row may honour models/route/provider too.
const STRIP_ALWAYS = Object.freeze([...STRIPPED_BODY_FIELDS.openai, ...STRIPPED_BODY_FIELDS.anthropic]);
const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";
export const ERROR_BODY_MAX = 1_000_000;
const REDACTED = "[redacted]";

export const CLOUD_TIMEOUTS = Object.freeze({ headersMs: 10 * 60_000, idleMs: 2 * 60_000, totalMs: 30 * 60_000 });
export const CLOUD_MAX_CONCURRENT = 8;

const err = (status, code, message) => ({ kind: "error", status, code, message });

/** A base URL the cloud door could dial: not loopback/LAN/tailnet, not a door. */
export function isCloudTarget(url) {
  return typeof url === "string" && !!url && !isLocalClassTarget(url) && !isDoorUrl(url);
}

const authStyleOf = (row) => (String(row?.provider_type ?? row?.providerType ?? "").toLowerCase() === "anthropic" ? "anthropic" : "bearer");
const keyOf = (row) => { const k = row?.apiKey ?? row?.api_key; return typeof k === "string" ? k.trim() : ""; };
const modelIdsOf = (row) => (Array.isArray(row?.models) ? row.models : []).map((m) => (typeof m === "string" ? m : m?.id)).filter((x) => typeof x === "string" && x);

/**
 * Where a cloud-door request goes, or why not. Pure. `providers` holds the
 * row (fresh), `consent` the consent map and `salt` this box's consent salt.
 * `allowInsecure(url)` is a tests-only seam (default: never) for a plain-http
 * fake upstream.
 * → {kind:"forward", url, authStyle, apiKey, providerId, providerType, model, host}
 *   | {kind:"error", status, code, message}
 */
export function resolveCloudTarget({
  providers = {}, consent = {}, salt = null, providerId, op, model,
  isCloudTarget: cloudCheck = isCloudTarget, allowInsecure = () => false, beta = false,
} = {}) {
  const row = typeof providerId === "string" && Object.hasOwn(providers, providerId) ? providers[providerId] : null;
  if (!row || row.disabled) return err(404, "UNKNOWN_PROVIDER", "no such cloud provider");
  if (row.gpuPolicy?.local_only === true || row.gpu_policy?.local_only === true) return err(400, "LOCAL_ONLY", "this provider is local only");
  const base = row.baseUrl ?? row.base_url;
  if (typeof base !== "string" || !cloudCheck(base)) return err(400, "NOT_CLOUD", "the cloud door serves cloud providers only");
  let u;
  try { u = new URL(base); } catch { return err(400, "FORBIDDEN_TARGET", "Crow will not contact that address"); }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isForbiddenTarget(base) || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password
    || (isIP(host) && !isPublicIp(host))) {
    return err(400, "FORBIDDEN_TARGET", "Crow will not contact that address");
  }
  if (u.protocol !== "https:" && !allowInsecure(base)) return err(400, "INSECURE_TARGET", "the cloud door sends keys over https only");
  const entry = consent && typeof consent === "object" && Object.hasOwn(consent, providerId) ? consent[providerId] : null;
  const verdict = consentVerdict(row, entry, { salt });
  if (verdict === "not_consented") return err(403, "NOT_CONSENTED", "this box has not agreed to let bots use this provider");
  if (verdict === "host_changed") return err(403, "HOST_CHANGED", "this provider's address changed since this box agreed to it");
  if (verdict !== "ok") return err(403, "KEY_CHANGED", "this provider's key changed since this box agreed to it");
  const authStyle = authStyleOf(row);
  if (!CLOUD_OPS[authStyle === "anthropic" ? "anthropic" : "openai"].includes(op)) return err(400, "OP_NOT_ALLOWED", "that operation is not served by the cloud door");
  if (typeof model !== "string" || !modelIdsOf(row).includes(model)) return err(404, "MODEL_NOT_SERVED", "this provider does not list that model");
  const apiKey = keyOf(row);
  if (!apiKey || apiKey === "none") return err(400, "NO_KEY", "this provider has no key");
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "") + (authStyle === "anthropic" ? `/v1/${op}` : `/${op}`);
  if (authStyle === "anthropic" && beta) u.searchParams.set("beta", "true");
  return {
    kind: "forward", url: u.href, authStyle, apiKey, providerId,
    providerType: row.provider_type ?? row.providerType ?? null, model, host,
  };
}

function callerToken(headers) {
  const h = headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  const k = headers["x-api-key"];
  return typeof k === "string" ? k.trim() : "";
}

const send = (res, status, code, message) => res.status(status).json({ error: { code, message } });

/** Replaces every literal secret (8+ characters, so a short key cannot shred the text). */
function redactor(secrets) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  const redact = (text) => {
    let out = String(text);
    for (const s of list) out = out.split(s).join(REDACTED);
    return out;
  };
  redact.maxLen = list.reduce((m, s) => Math.max(m, Buffer.byteLength(s)), 0);
  return redact;
}

/** A decompressor for one content-encoding, or null (identity) / undefined (unsupported). */
function decoderFor(encoding) {
  const e = String(encoding || "").trim().toLowerCase();
  if (!e || e === "identity") return null;
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "deflate") return zlib.createInflate();
  if (e === "br") return zlib.createBrotliDecompress();
  return undefined;
}

/** Keeps the start (anthropic's message_start) and a bounded tail (the usage frames). */
function captureTap({ head = 32 * 1024, tail = 64 * 1024 } = {}) {
  let start = "";
  let end = "";
  let total = 0;
  return {
    push(text) {
      total += text.length;
      if (start.length < head) {
        const room = head - start.length;
        start += text.slice(0, room);
        text = text.slice(room);
      }
      if (text) { end += text; if (end.length > tail) end = end.slice(-tail); }
    },
    whole() { return total <= head + tail; },
    text() { return total <= head + tail ? start + end : `${start}\n${end}`; },
    tail() { return end || start; },
    head() { return start; },
  };
}

/** The last balanced JSON object that follows a `"usage":` key in `text`, or null. */
export function lastUsageObject(text) {
  const s = String(text || "");
  let at = s.lastIndexOf('"usage"');
  while (at >= 0) {
    const m = /^"usage"\s*:\s*\{/.exec(s.slice(at));
    if (m) {
      const open = at + m[0].length - 1;
      let depth = 0;
      let inStr = false;
      for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          try { return JSON.parse(s.slice(open, i + 1)); } catch { break; }
        }
      }
    }
    at = at > 0 ? s.lastIndexOf('"usage"', at - 1) : -1;
  }
  return null;
}

/** Usage from the captured body: the extractor on what was kept, else (a large
 * non-streamed body, cut in the middle) the last usage object in the tail. */
function usageFrom(tap, authStyle) {
  const extract = authStyle === "anthropic"
    ? (t) => { const u = extractUsageFromAnthropicStream(t); return u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedTokens: 0 } : null; }
    : extractUsageFromOpenAIResponse;
  const found = extract(tap.text());
  if (found) return found;
  if (tap.whole()) return null;
  // Usage normally sits last (the tail); some servers put it first (the head).
  const obj = lastUsageObject(tap.tail()) || lastUsageObject(tap.head());
  return obj ? extract(JSON.stringify({ usage: obj })) : null;
}

/**
 * The gate and the handler, over `deps` (the router's seams):
 *   remoteAddressFn(req), cloudTokenAuthFn(token), cloudProvidersFn(id),
 *   consentFn() → {consent, salt}, isCloudTargetFn(url), requestFn (safeRequest),
 *   lookupFn, allowAddressFn, allowInsecureFn (the last three tests only),
 *   recordUsageFn(event), tenantIdFn(), cloudTimeouts {headersMs, idleMs,
 *   totalMs}, cloudMaxConcurrent.
 */
export function createCloudDoor(deps) {
  const timeouts = { ...CLOUD_TIMEOUTS, ...(deps.cloudTimeouts || {}) };
  const maxConcurrent = Number.isInteger(deps.cloudMaxConcurrent) && deps.cloudMaxConcurrent > 0 ? deps.cloudMaxConcurrent : CLOUD_MAX_CONCURRENT;
  let inFlight = 0;

  async function gate(req, res, next) {
    const h = req.headers || {};
    if (h["tailscale-funnel-request"]) return send(res, 403, "FUNNEL_REFUSED", "/llm/c is never reachable through Funnel");
    if (!isLocalPeer(deps.remoteAddressFn(req), h)) return send(res, 403, "CLOUD_SOURCE_REFUSED", "the cloud door is limited to processes on this box");
    let ok = false;
    try { ok = !!(await deps.cloudTokenAuthFn(callerToken(h))); } catch { ok = false; }
    if (!ok) return send(res, 401, "CLOUD_TOKEN_REFUSED", "the cloud door needs this box's cloud-door token");
    next();
  }

  async function handle(req, res) {
    if (inFlight >= maxConcurrent) {
      res.setHeader("retry-after", "5");
      return send(res, 429, "DOOR_BUSY", `the cloud door is already serving ${maxConcurrent} requests`);
    }
    inFlight++;
    try { await handleOne(req, res); } finally { inFlight--; }
  }

  async function handleOne(req, res) {
    const providerId = req.params.provider;
    const op = req.params[0];
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, "BAD_BODY", "the body must be a JSON object");
    const [providers, { consent, salt } = {}] = await Promise.all([deps.cloudProvidersFn(providerId), deps.consentFn()]);
    const target = resolveCloudTarget({
      providers: providers || {}, consent: consent || {}, salt, providerId, op, model: body.model,
      isCloudTarget: deps.isCloudTargetFn, allowInsecure: deps.allowInsecureFn, beta: req.query?.beta === "true",
    });
    if (target.kind === "error") return send(res, target.status, target.code, target.message);
    await forward(req, res, target, body);
  }

  async function forward(req, res, target, body) {
    const headers = {};
    const allow = target.authStyle === "anthropic" ? [...REQUEST_HEADER_ALLOW, ...ANTHROPIC_REQUEST_HEADER_ALLOW] : REQUEST_HEADER_ALLOW;
    for (const k of allow) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
    headers["content-type"] = "application/json";
    headers["accept-encoding"] = "identity";
    if (target.authStyle === "anthropic") {
      headers["x-api-key"] = target.apiKey;
      if (!headers["anthropic-version"]) headers["anthropic-version"] = ANTHROPIC_DEFAULT_VERSION;
    } else {
      headers.authorization = `Bearer ${target.apiKey}`;
    }
    const sent = { ...body };
    for (const f of STRIP_ALWAYS) delete sent[f];
    const payload = JSON.stringify(sent);
    const redact = redactor([target.apiKey, callerToken(req.headers)]);
    const label = `${target.providerId}/${target.model}`;
    const op = req.params[0];

    // A client that goes away aborts the upstream, before or after its headers.
    const ac = new AbortController();
    const onGone = () => { if (!res.writableFinished) ac.abort(); };
    res.on("close", onGone);
    if (res.destroyed || req.socket?.destroyed) return;

    let up;
    try {
      up = await deps.requestFn(target.url, {
        mode: "cloud", method: "POST", headers, body: payload, timeoutMs: timeouts.headersMs,
        lookupFn: deps.lookupFn, allowAddressFn: deps.allowAddressFn, signal: ac.signal,
      });
    } catch (e) {
      const code = e?.code;
      if (code === "ABORTED" || ac.signal.aborted) {
        console.warn(`[llm-router] cloud ${op} -> ${label} host=${target.host} aborted: the caller went away`);
        return;
      }
      console.warn(`[llm-router] cloud ${op} -> ${label} host=${target.host} refused: ${code || "error"}`);
      if (code === "UPSTREAM_ADDRESS_REFUSED") return send(res, 502, code, "the provider's address resolves somewhere Crow will not contact");
      if (code === "FORBIDDEN_TARGET" || code === "BAD_URL") return send(res, 400, "FORBIDDEN_TARGET", "Crow will not contact that address");
      if (code === "TIMEOUT") return send(res, 504, "UPSTREAM_TIMEOUT", "the provider did not answer in time");
      return send(res, 502, "UPSTREAM_UNREACHABLE", `the provider could not be reached (${code || "error"})`);
    }
    if (up.status >= 300 && up.status < 400) {
      up.stream.destroy();
      console.warn(`[llm-router] cloud ${op} -> ${label} host=${target.host} redirect ${up.status} not followed`);
      return send(res, 502, "UPSTREAM_REDIRECT", "the provider answered with a redirect, which Crow does not follow");
    }
    console.log(`[llm-router] cloud ${op} -> ${label} host=${target.host} status=${up.status}`);
    const okStatus = up.status >= 200 && up.status < 300;
    const encoding = up.headers?.["content-encoding"];
    const passHeaders = () => {
      res.status(up.status);
      for (const [k, v] of Object.entries(up.headers || {})) {
        if (v === undefined) continue;
        if (RESPONSE_HEADER_ALLOW.includes(k) || RATELIMIT_HEADER.test(k)) res.setHeader(k, Array.isArray(v) ? v.map(redact) : redact(v));
      }
      if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");
    };
    if (!okStatus) return sendErrorBody(res, up, encoding, redact, passHeaders, label, op);

    passHeaders();
    if (encoding) res.setHeader("content-encoding", redact(Array.isArray(encoding) ? encoding.join(", ") : encoding));
    // Metering reads a decompressed COPY; the caller gets the bytes as they came.
    const tap = captureTap();
    const text = new StringDecoder("utf8");
    let meter = true;
    let undecodable = false;
    let dec = null;
    let decDone = Promise.resolve();
    if (encoding) {
      dec = decoderFor(encoding);
      if (!dec) {
        meter = false;
        console.debug?.(`[metering] /llm/c ${label}: content-encoding ${encoding} not metered`);
      } else {
        const out = new StringDecoder("utf8");
        dec.on("data", (c) => tap.push(out.write(c)));
        decDone = new Promise((resolve) => {
          dec.on("end", resolve);
          dec.on("error", () => { undecodable = true; resolve(); });
        });
      }
    }
    const completed = await pump(up.stream, res, (c) => {
      if (!meter) return;
      if (dec) { if (!undecodable) dec.write(c); }
      else tap.push(text.write(c));
    }, label, op);
    if (dec && !undecodable) {
      dec.end();
      await Promise.race([decDone, new Promise((r) => setTimeout(r, 2000).unref?.())]);
    }
    if (!completed || !meter) return;
    try {
      // A body the copy could not decode is still a completed (billed) call: counts unknown.
      const usage = undecodable ? null : usageFrom(tap, target.authStyle);
      await deps.recordUsageFn({
        tenantId: deps.tenantIdFn(), surface: "llm", providerId: target.providerId, providerType: target.providerType,
        modelId: target.model,
        // No usage in the answer (an openai stream without include_usage): the call is recorded, counts unknown.
        inputTokens: usage ? usage.inputTokens : null,
        outputTokens: usage ? usage.outputTokens : null,
        cachedTokens: usage ? usage.cachedTokens || 0 : null,
      });
    } catch (meterErr) {
      console.warn(`[metering] /llm/c usage record failed: ${meterErr.message}`);
    }
  }

  /** Stream `s` into `res` under the idle and total timers. → true when it finished. */
  function pump(s, res, onChunk, label, op) {
    return new Promise((resolve) => {
      let idle = null;
      let cap = null;
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(idle); clearTimeout(cap); resolve(ok); };
      const cut = (why) => {
        if (done) return;
        console.warn(`[llm-router] cloud ${op} -> ${label} cut: ${why}`);
        s.destroy();
        res.destroy();
        finish(false);
      };
      const arm = () => { clearTimeout(idle); idle = setTimeout(() => cut(`no data for ${timeouts.idleMs} ms`), timeouts.idleMs); };
      cap = setTimeout(() => cut(`longer than ${timeouts.totalMs} ms`), timeouts.totalMs);
      arm();
      s.on("data", (c) => { arm(); onChunk(c); });
      res.on("drain", arm);
      s.on("error", (e) => cut(`stream error ${e?.code || ""}`.trim()));
      s.on("end", () => { clearTimeout(idle); });
      res.on("finish", () => finish(true));
      res.on("close", () => { if (!res.writableFinished) { s.destroy(); finish(false); } });
      s.pipe(res);
    });
  }

  /** A non-2xx answer: buffered (at most ERROR_BODY_MAX, decompressed), redacted, sent whole. */
  async function sendErrorBody(res, up, encoding, redact, passHeaders, label, op) {
    const chunks = [];
    let size = 0;
    const dec = decoderFor(encoding);
    if (dec === undefined) {
      up.stream.destroy();
      return send(res, 502, "UPSTREAM_BAD_ENCODING", "the provider's error answer used an encoding Crow cannot read");
    }
    const src = dec ? up.stream.pipe(dec) : up.stream;
    if (dec) up.stream.on("error", (e) => dec.destroy(e));
    // Keep enough past the cap that a secret straddling it is still whole when redacted.
    const keep = ERROR_BODY_MAX + redact.maxLen;
    const ok = await new Promise((resolve) => {
      let fin = false;
      const end = (v) => { if (!fin) { fin = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => { up.stream.destroy(); end(chunks.length > 0); }, timeouts.idleMs);
      src.on("data", (c) => {
        if (size >= keep) return;
        chunks.push(c);
        size += c.length;
        if (size >= keep) { up.stream.destroy(); end(true); }
      });
      src.on("end", () => end(true));
      // A body that fails to decode: stop reading the upstream too.
      src.on("error", () => { up.stream.destroy(); end(false); });
      res.on("close", () => { if (!res.writableFinished) { up.stream.destroy(); end(false); } });
    });
    if (res.destroyed) return;
    if (!ok) return send(res, 502, "UPSTREAM_UNREACHABLE", "the provider's error answer could not be read");
    console.log(`[llm-router] cloud ${op} -> ${label} error body ${size} bytes`);
    passHeaders();
    const whole = redact(Buffer.concat(chunks).subarray(0, keep).toString("utf8"));
    res.end(Buffer.from(whole, "utf8").subarray(0, ERROR_BODY_MAX));
  }

  return { gate, handle };
}

/** The router's real defaults for the cloud-door seams that are not db-bound. */
export const CLOUD_DOOR_DEFAULTS = Object.freeze({
  requestFn: safeRequest,
  lookupFn: dns.lookup,
  allowAddressFn: () => false,
  allowInsecureFn: () => false,
  isCloudTargetFn: isCloudTarget,
});
