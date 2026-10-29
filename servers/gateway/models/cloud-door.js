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
 *   - the TCP socket is loopback, and no forwarding header (X-Forwarded-For,
 *     X-Real-IP, Forwarded) is present at all: a same-box reverse proxy such
 *     as Tailscale Serve arrives as loopback and says so in those headers;
 *   - no Tailscale identity header (any `tailscale-*`: Serve adds
 *     Tailscale-User-Login / Tailscale-Headers-Info for a tailnet caller);
 *   - `Authorization: Bearer <token>` or `x-api-key: <token>` is the cloud-door
 *     token, checked against its own hash only (CLOUD_TOKEN_REFUSED).
 * The source checks come first, so an off-box caller never reaches the token
 * check. There is no --no-auth bypass: this module never reads that flag.
 *
 * Where it may go (`resolveCloudTarget`, re-run on EVERY request with a fresh
 * row and a fresh consent read, so a sync rewrite or a revoke takes effect on
 * the next request): the row's OWN base URL, and only while this box's
 * consent entry still matches that URL and key (`consentVerdict`). The host
 * never comes from provider_type or any other column; provider_type only
 * picks the auth header and the op set. Ops are an allowlist, so the path
 * cannot be steered. The upstream call is `safeRequest` in cloud mode: no
 * redirect is followed (a 3xx answers 502 UPSTREAM_REDIRECT), and a name that
 * resolves to a non-public or own address is refused at connect time.
 *
 * What passes: request headers in REQUEST_HEADER_ALLOW (plus anthropic-version
 * and anthropic-beta for anthropic rows) and the real key; the body
 * re-serialised with a fresh content-length; for anthropic, the `beta=true`
 * query pi 0.85.1 adds, and no other query parameter. Back to the caller: the
 * status, the body (an upstream error body included, as is) and only the
 * response headers in RESPONSE_HEADER_ALLOW plus any `*-ratelimit-*`.
 *
 * Timeouts (never an unbounded wait): `headersMs` (default 10 min) is the
 * budget for the upstream to start answering, because a non-streamed
 * completion sends its headers only when the whole answer is ready. Once the
 * body starts, a long stream is NOT cut by that budget: `idleMs` (default
 * 2 min without a byte, reset on every chunk and on client drain) and a total
 * cap `totalMs` (default 30 min) govern it. A cut stream destroys the
 * response, so the caller sees a broken stream, never a complete-looking one.
 *
 * The key is never logged: log lines name the provider, model, op, host and
 * status only, and errors carry `err.message` from safeRequest, which never
 * includes headers.
 */
import dns from "node:dns";
import { isIP } from "node:net";
import { isPublicIp } from "../../shared/ip-classify.js";
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
const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";

export const CLOUD_TIMEOUTS = Object.freeze({ headersMs: 10 * 60_000, idleMs: 2 * 60_000, totalMs: 30 * 60_000 });

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
 * → {kind:"forward", url, authStyle, apiKey, providerId, providerType, model, host}
 *   | {kind:"error", status, code, message}
 */
export function resolveCloudTarget({ providers = {}, consent = {}, salt = null, providerId, op, model, isCloudTarget: cloudCheck = isCloudTarget, beta = false } = {}) {
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

const isLoopback = (a) => {
  const s = String(a || "").replace(/^::ffff:/i, "");
  return s === "::1" || /^127\./.test(s);
};
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"];

function callerToken(headers) {
  const h = headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  const k = headers["x-api-key"];
  return typeof k === "string" ? k.trim() : "";
}

const send = (res, status, code, message) => res.status(status).json({ error: { code, message } });

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
    text() { return total <= head + tail ? start + end : `${start}\n${end}`; },
  };
}

/**
 * The gate and the handler, over `deps` (the router's seams):
 *   remoteAddressFn(req), cloudTokenAuthFn(token), cloudProvidersFn(id),
 *   consentFn() → {consent, salt}, isCloudTargetFn(url), requestFn (safeRequest),
 *   lookupFn, allowAddressFn (tests only), recordUsageFn(event), tenantIdFn(),
 *   cloudTimeouts {headersMs, idleMs, totalMs}.
 */
export function createCloudDoor(deps) {
  const timeouts = { ...CLOUD_TIMEOUTS, ...(deps.cloudTimeouts || {}) };

  async function gate(req, res, next) {
    const h = req.headers || {};
    if (h["tailscale-funnel-request"]) return send(res, 403, "FUNNEL_REFUSED", "/llm/c is never reachable through Funnel");
    const sourceOk = isLoopback(deps.remoteAddressFn(req))
      && !FORWARDING_HEADERS.some((k) => h[k] !== undefined)
      && !Object.keys(h).some((k) => k.startsWith("tailscale-"));
    if (!sourceOk) return send(res, 403, "CLOUD_SOURCE_REFUSED", "the cloud door is limited to processes on this box");
    let ok = false;
    try { ok = !!(await deps.cloudTokenAuthFn(callerToken(h))); } catch { ok = false; }
    if (!ok) return send(res, 401, "CLOUD_TOKEN_REFUSED", "the cloud door needs this box's cloud-door token");
    next();
  }

  async function handle(req, res) {
    const providerId = req.params.provider;
    const op = req.params[0];
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, "BAD_BODY", "the body must be a JSON object");
    const [providers, { consent, salt } = {}] = await Promise.all([deps.cloudProvidersFn(providerId), deps.consentFn()]);
    const target = resolveCloudTarget({
      providers: providers || {}, consent: consent || {}, salt, providerId, op, model: body.model,
      isCloudTarget: deps.isCloudTargetFn, beta: req.query?.beta === "true",
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
    const payload = JSON.stringify(body);
    const label = `${target.providerId}/${target.model}`;
    const op = req.params[0];
    let up;
    try {
      up = await deps.requestFn(target.url, {
        mode: "cloud", method: "POST", headers, body: payload, timeoutMs: timeouts.headersMs,
        lookupFn: deps.lookupFn, allowAddressFn: deps.allowAddressFn,
      });
    } catch (e) {
      const code = e?.code;
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
    res.status(up.status);
    for (const [k, v] of Object.entries(up.headers || {})) {
      if (v === undefined) continue;
      if (RESPONSE_HEADER_ALLOW.includes(k) || RATELIMIT_HEADER.test(k)) res.setHeader(k, v);
    }
    if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");
    const tap = captureTap();
    const okStatus = up.status >= 200 && up.status < 300;
    const completed = await new Promise((resolve) => {
      const s = up.stream;
      let idle = null;
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
      const cap = setTimeout(() => cut(`longer than ${timeouts.totalMs} ms`), timeouts.totalMs);
      arm();
      s.on("data", (c) => { arm(); if (okStatus) tap.push(c.toString("utf8")); });
      res.on("drain", arm);
      s.on("error", (e) => cut(`stream error ${e?.code || ""}`.trim()));
      s.on("end", () => { clearTimeout(idle); });
      res.on("finish", () => finish(true));
      // A client abort: stop reading the upstream.
      res.on("close", () => { if (!res.writableFinished) { s.destroy(); finish(false); } });
      s.pipe(res);
    });
    if (!completed || !okStatus) return;
    try {
      let usage = null;
      if (target.authStyle === "anthropic") {
        const u = extractUsageFromAnthropicStream(tap.text());
        if (u) usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedTokens: 0 };
      } else {
        usage = extractUsageFromOpenAIResponse(tap.text());
      }
      if (usage) {
        await deps.recordUsageFn({
          tenantId: deps.tenantIdFn(), surface: "llm", providerId: target.providerId, providerType: target.providerType,
          modelId: target.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens || 0,
        });
      }
    } catch (meterErr) {
      console.warn(`[metering] /llm/c usage record failed: ${meterErr.message}`);
    }
  }

  return { gate, handle };
}

/** The router's real defaults for the cloud-door seams that are not db-bound. */
export const CLOUD_DOOR_DEFAULTS = Object.freeze({
  requestFn: safeRequest,
  lookupFn: dns.lookup,
  allowAddressFn: () => false,
  isCloudTargetFn: isCloudTarget,
});
