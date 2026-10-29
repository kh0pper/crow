/**
 * The shared loopback MCP mount: one door for the gateway's own bot-only tool
 * families (project services, satellite tools). A family is mounted once with
 * `mountLoopbackMcp(app, {...})` and every request runs the same fixed order
 * (the private engineering notes, loopback mount helper spec §3):
 *
 *   1. not a genuine same-box caller (isLocalPeer), or one that came through
 *      instance / cross-host auth -> 404, empty body, for EVERY method (a
 *      remote caller learns nothing about the route; the gate re-checks this
 *      as its step 2);
 *   2. a local caller's method other than POST/GET/DELETE -> 405;
 *   3. this family's bearer token only -> otherwise 401;
 *   4. a v3 (scope-bound) actor signature of exactly `actorKind` -> otherwise 403;
 *   5. the signed scope still live (resolveSignedScope) -> otherwise 403;
 *   6. a JSON-RPC batch -> 400 (-32600);
 *   7. the MCP session is bound to JSON [family, botId, scopeRef] (stored as
 *      its owner via req.auth.clientId; botId must match BOT_ID_RE): another
 *      bot's, or the same bot's under another scope -> 404, empty body;
 *   7a. ownerTurnOnly (default ON): the resolved scope must be the owner's own
 *      turn (servers/shared/turn-principal.js isOwnerTurnScope: a j: job with
 *      principal 'owner', or an s: Perch session the injected Perch engine
 *      calls live) -> otherwise 403 not_owner_turn, before authorize runs;
 *   8. `authorize` on EVERY request -> its code's status from the table;
 *   9. (tools/call) the in-flight cap per mount key, and each bot's share of
 *      it -> isError `busy`;
 *  10. on initialize only, `upstream.onInitialize(ctx)` -> 502 on failure;
 *  11. the request runs inside callerContext.run(...), so a tool handler reads
 *      the LIVE caller, never a closure from the request that opened the session.
 *
 * Steps 1 (source half) and 3-5 are loopbackActorGate. A throw inside any step is that step's
 * refusal, never a 500 with text. Every refusal happens before any upstream
 * work. Refusals are JSON-RPC shaped, except the 404s, which are empty. A throw
 * inside the MCP handler itself (step 11) gets the SDK handler's fixed
 * "Internal server error" (-32603), never any upstream text.
 *
 * The in-flight cap counts upstream calls that are still RUNNING: a slot is
 * released when the upstream's own promise settles, not when the caller gets
 * its answer, so calls abandoned at the timeout or on a disconnect (whose
 * upstream ignores the abort) keep their slot until they really end. Two
 * bounds on that: one bot holds at most `maxInFlightPerBot` of a key's
 * `maxInFlight` slots (default half, rounded up), so it cannot starve the
 * others; and a call still unsettled at the hard ceiling (`inFlightCeilingMs`,
 * default 5 x callTimeoutMs) is ABORTED: `ceilingSignal` (passed to callTool
 * beside `signal`) fires with a ceiling reason, and so does `signal` if the
 * timeout has not already aborted it (it always has, since the ceiling is
 * >= callTimeoutMs, and an AbortSignal aborts once), and the optional `upstream.cancelCall(ctx, name, { reason:
 * "ceiling" })` hook is called (a throw is swallowed); the event is logged.
 * The active slot is freed then, but the budget is not: a reclaimed call
 * still counts, per key and per bot, until its upstream promise really
 * settles, and new calls are `busy` while the bot's reclaimed count is at its
 * share or the key's is at maxInFlight. So never-settling calls cannot pile
 * up past the cap. Below the ceiling the slot is held until the upstream
 * settles. An upstream's callTool must settle when its child exits.
 *
 * MCP sessions here keep NO event store (nothing is replayable, so no result
 * stays in memory after it is sent). A session is closed when a request on it
 * is refused because its scope died (a verified signature whose job or
 * session ended), by the owner-turn check, or by authorize; and a sweep
 * closes sessions idle longer than `sessionIdleMs` (default 10 min).
 *
 * Text a caller sees comes ONLY from the fixed error table below: authorize and
 * the upstream return or throw a `code`, never text, and any userText / message
 * / thrown message is ignored. Results are shaped here: content types outside
 * `resultCap.contentTypes` (text and image only) are dropped with a one-line
 * note. Items are rebuilt from an allowlist: text -> {type, text} through the
 * shared redactSecrets with `ctx.secrets` (its default length floor);
 * image -> {type, mimeType, data} only for an allowed mimeType and a base64
 * string. Resource items and every other type are
 * dropped, and no other upstream field (_meta, annotations, structuredContent,
 * userText, ...) is ever copied. The whole result is capped at
 * `resultCap.maxBytes` (base64 images count). Only `content` + `isError` survive.
 * Text is redacted across item boundaries (the joined text, re-split), so a
 * secret split over two items is caught. A throw anywhere in the shaping is
 * "<tool> failed.". Tool descriptions, and the description / title / enum /
 * const / default / examples strings of an input schema, are redacted with the
 * same secrets and capped (2 KiB per string) before tools/list shows them. An
 * unknown tool name gets "Not available on this turn." and an audit event.
 *
 * One audit event per tools/call and per refusal, never arguments, results,
 * headers or tokens.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler } from "./routes/mcp.js";
import { isLocalPeer } from "../shared/peer-class.js";
import { loopbackActorGate, noteRefusedOnce, readActorHeaders } from "./loopback-gate.js";
import { callerContext } from "./caller-context.js";
import { recordToolCall } from "./session-logger.js";
import { redactAcross, redactSecrets } from "../shared/redact-secrets.js";
import { isOwnerTurnScope } from "../shared/turn-principal.js";
import { testTunableMs } from "../shared/test-timing.js";
import { BOT_ID_RE } from "../../scripts/pi-bots/bot-workspace-env.mjs";
import { jsonSchemaToZodObject, SOURCE_BUDGET } from "../shared/json-schema-to-zod.js";
import { resolveSignedScope } from "../shared/signed-session.js";
import { SCOPE_ACTOR_KINDS, verifyScopeActorSig } from "../../scripts/pi-bots/actor-sig.mjs";

// ---- the fixed error table (spec §5) ----
// {tool}, {kib}, {secs}, {n} are filled in by loopbackErrorText. bad_token,
// method_not_allowed, batch and dropped are this helper's own lines (the spec
// table names no text for them). not_found is always an empty body.
const NOT_THIS_TURN = { en: "Not available on this turn.", es: "No disponible en este turno." };
export const LOOPBACK_ERROR_TEXT = Object.freeze({
  en: Object.freeze({
    unattributed: "A signed bot is required.",
    not_owner_turn: NOT_THIS_TURN.en, scope_unknown: NOT_THIS_TURN.en, wrong_project: NOT_THIS_TURN.en,
    not_selected: NOT_THIS_TURN.en, owner_mismatch: NOT_THIS_TURN.en, not_granted: NOT_THIS_TURN.en,
    not_found: "",
    not_active: "This connection is turned off.",
    busy: "Busy, try again in a moment.",
    child_unavailable: "This service isn't running right now.",
    not_installed: "This service isn't running right now.",
    unreachable: "The server is unreachable.",
    tools_changed: "These tools changed; approve them on the Servers page.",
    timeout: "Timed out after {secs} s. It may still have finished; check before trying again.",
    too_large: "Result too large ({kib} KiB).",
    failed: "{tool} failed.",
    bad_token: "A valid token for this connection is required.",
    method_not_allowed: "Method not allowed.",
    batch: "Batch requests are not accepted.",
    dropped: "{n} item(s) of a type this connection does not return were left out.",
    invalid_args: "The arguments for {tool} are not valid.",
  }),
  es: Object.freeze({
    unattributed: "Se requiere un bot firmado.",
    not_owner_turn: NOT_THIS_TURN.es, scope_unknown: NOT_THIS_TURN.es, wrong_project: NOT_THIS_TURN.es,
    not_selected: NOT_THIS_TURN.es, owner_mismatch: NOT_THIS_TURN.es, not_granted: NOT_THIS_TURN.es,
    not_found: "",
    not_active: "Esta conexión está desactivada.",
    busy: "Ocupado, inténtalo de nuevo en un momento.",
    child_unavailable: "Este servicio no está en marcha ahora mismo.",
    not_installed: "Este servicio no está en marcha ahora mismo.",
    unreachable: "No se puede contactar con el servidor.",
    tools_changed: "Estas herramientas han cambiado; apruébalas en la página Servidores.",
    timeout: "Se agotó el tiempo tras {secs} s. Puede que haya terminado; compruébalo antes de volver a intentarlo.",
    too_large: "Resultado demasiado grande ({kib} KiB).",
    failed: "{tool} falló.",
    bad_token: "Se requiere un token válido para esta conexión.",
    method_not_allowed: "Método no permitido.",
    batch: "No se aceptan solicitudes por lotes.",
    dropped: "Se omitieron {n} elemento(s) de un tipo que esta conexión no devuelve.",
    invalid_args: "Los argumentos de {tool} no son válidos.",
  }),
});

/** The fixed text for a code (unknown codes read as "<tool> failed."). */
export function loopbackErrorText(code, { lang = "en", tool = "The tool", kib = 0, secs = 60, n = 0 } = {}) {
  const table = LOOPBACK_ERROR_TEXT[lang] || LOOPBACK_ERROR_TEXT.en;
  const raw = Object.hasOwn(table, code) ? table[code] : table.failed;
  return raw.replace("{tool}", String(tool)).replace("{kib}", String(kib)).replace("{secs}", String(secs)).replace("{n}", String(n));
}

// authorize's codes and their HTTP status; anything else it returns is a 403
// with "Not available on this turn." (fail closed).
const AUTHZ_STATUS = Object.freeze({
  not_owner_turn: 403, scope_unknown: 403, wrong_project: 403, not_selected: 403, owner_mismatch: 403, not_granted: 403,
  not_found: 404, not_active: 409,
});
// Codes an upstream may throw (or return as `{code}`) for a tool call. Any other
// value, or a thrown Error's own `code` (ECONNREFUSED, ...), is "<tool> failed.".
const TOOL_CODES = new Set([
  "busy", "child_unavailable", "not_installed", "unreachable", "tools_changed",
  "not_owner_turn", "scope_unknown", "wrong_project", "not_selected", "owner_mismatch", "not_granted", "not_active",
]);

const FAMILY_RE = /^[a-z][a-z0-9-]{1,40}$/;
const PARAMS_RE = /^:[a-z][A-Za-z0-9]*(?:\/:[a-z][A-Za-z0-9]*)*$/;
const CROW_DEV = "crow.dev/";
const CONTENT_KINDS = new Set(["text", "image"]);
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DESC_MAX = 2048;
const SCHEMA_MAX_DEPTH = 64;
const IDLE_DEFAULT_MS = 600_000;
// The SDK validated a tools/call's arguments and they failed (see buildServer).
const INVALID_ARGS = Symbol("loopback-mount.invalid-args");

const langOf = (req) => (/^\s*es\b/i.test(String(req.headers?.["accept-language"] ?? "")) ? "es" : "en");
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const secsOf = (ms) => Number((ms / 1000).toFixed(1));
const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

/** A copy of a _meta object without the crow.dev/* keys (only Crow sets those). */
function stripCrowDev(meta) {
  if (!isPlainObject(meta)) return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) if (!k.startsWith(CROW_DEV)) out[k] = v;
  return out;
}

// Per-request state the tool handlers read through the live caller store (the
// store object itself is the key; the ALS caller shape stays exactly §3 step 11).
const requestState = new WeakMap();

function normalize(opts) {
  const o = opts || {};
  const need = (ok, what) => { if (!ok) throw new TypeError(`mountLoopbackMcp: ${what}`); };
  need(typeof o.family === "string" && FAMILY_RE.test(o.family), "family must match /^[a-z][a-z0-9-]{1,40}$/");
  need(typeof o.params === "string" && PARAMS_RE.test(o.params), 'params must be a route tail of :params (e.g. ":uuid", ":sat/:bundle")');
  need(SCOPE_ACTOR_KINDS.includes(o.actorKind), `actorKind must be one of ${SCOPE_ACTOR_KINDS.join(", ")}`);
  const hasToken = o.token !== undefined && o.token !== null;
  const hasFn = o.validateToken !== undefined && o.validateToken !== null;
  need(hasToken !== hasFn, "pass exactly one of token or validateToken");
  need(hasFn ? typeof o.validateToken === "function" : typeof o.token?.validate === "function", "token needs validate(db, token)");
  need(typeof o.authorize === "function", "authorize is required");
  need(isPlainObject(o.upstream) && typeof o.upstream.listTools === "function" && typeof o.upstream.callTool === "function", "upstream needs listTools and callTool");
  need(o.upstream.onInitialize === undefined || typeof o.upstream.onInitialize === "function", "upstream.onInitialize must be a function");
  need(o.upstream.cancelCall === undefined || typeof o.upstream.cancelCall === "function", "upstream.cancelCall must be a function");
  need(typeof o.toolFilter === "function", "toolFilter is required");
  need(isPlainObject(o.resultCap) && Number.isInteger(o.resultCap.maxBytes) && o.resultCap.maxBytes > 0
    && Array.isArray(o.resultCap.contentTypes) && o.resultCap.contentTypes.length > 0 && o.resultCap.contentTypes.every((t) => CONTENT_KINDS.has(t)),
  'resultCap needs { maxBytes, contentTypes } (contentTypes from "text", "image")');
  need(Number.isInteger(o.callTimeoutMs) && o.callTimeoutMs > 0, "callTimeoutMs is required (a positive integer)");
  const maxInFlight = o.maxInFlight === undefined ? 4 : o.maxInFlight;
  need(Number.isInteger(maxInFlight) && maxInFlight > 0, "maxInFlight must be a positive integer");
  const maxInFlightPerBot = o.maxInFlightPerBot === undefined ? Math.ceil(maxInFlight / 2) : o.maxInFlightPerBot;
  need(Number.isInteger(maxInFlightPerBot) && maxInFlightPerBot > 0 && maxInFlightPerBot <= maxInFlight, "maxInFlightPerBot must be an integer from 1 to maxInFlight");
  const inFlightCeilingMs = o.inFlightCeilingMs === undefined ? 5 * (o.callTimeoutMs || 0) : o.inFlightCeilingMs;
  need(Number.isInteger(inFlightCeilingMs) && inFlightCeilingMs >= o.callTimeoutMs, "inFlightCeilingMs must be an integer >= callTimeoutMs");
  const sessionIdleMs = o.sessionIdleMs === undefined ? testTunableMs("CROW_TEST_LOOPBACK_IDLE_MS", IDLE_DEFAULT_MS) : o.sessionIdleMs;
  need(Number.isInteger(sessionIdleMs) && sessionIdleMs > 0, "sessionIdleMs must be a positive integer");
  const ownerTurnOnly = o.ownerTurnOnly === undefined ? true : o.ownerTurnOnly;
  need(typeof ownerTurnOnly === "boolean", "ownerTurnOnly must be a boolean");
  need(o.perchEngine == null || typeof o.perchEngine === "function" || typeof o.perchEngine === "object", "perchEngine must be an engine or a function returning one");
  need(o.onAudit === undefined || typeof o.onAudit === "function", "onAudit must be a function");
  need(typeof o.sessionManager?.getStore === "function", "sessionManager is required");
  need(typeof o.createDbClient === "function", "createDbClient is required");
  const deps = isPlainObject(o.deps) ? o.deps : {};
  return {
    family: o.family, params: o.params, actorKind: o.actorKind,
    validate: hasFn ? o.validateToken : (db, t) => o.token.validate(db, t),
    authorize: o.authorize, upstream: o.upstream, toolFilter: o.toolFilter,
    maxBytes: o.resultCap.maxBytes, contentTypes: new Set(o.resultCap.contentTypes),
    callTimeoutMs: o.callTimeoutMs, maxInFlight, maxInFlightPerBot, inFlightCeilingMs, sessionIdleMs, onAudit: o.onAudit,
    ownerTurnOnly, perchEngine: o.perchEngine ?? null,
    sessionManager: o.sessionManager, createDbClient: o.createDbClient,
    verifySig: deps.verifyScopeActorSig || verifyScopeActorSig,
    resolveScope: deps.resolveSignedScope || resolveSignedScope,
    now: deps.now || (() => Date.now()),
    inflight: new Map(),
    inflightBot: new Map(),
    reclaimed: new Map(),
    reclaimedBot: new Map(),
  };
}

/** The default audit sink (spec §6): ok calls count on the session, refusals log once an hour. */
function defaultAudit(event, sid) {
  if (event.outcome === "ok" && event.method === "tools/call" && sid) recordToolCall(sid, event.tool);
  else if (event.outcome.startsWith("refused:")) noteRefusedOnce(event.family, event.outcome);
}

function emit(m, event, sid) {
  try {
    if (m.onAudit) m.onAudit(event);
    else defaultAudit(event, sid);
  } catch { /* an audit sink never affects the call */ }
}


const filterOk = (m, ctx, tool) => { try { return m.toolFilter(ctx, tool) === true; } catch { return false; } };

/** The Perch engine the owner-turn check asks (an object, or a function returning one). */
function perchEngineOf(m) {
  try { return typeof m.perchEngine === "function" ? m.perchEngine() : m.perchEngine; } catch { return null; }
}

/** The session-binding owner: JSON, so no field's separator can forge another tuple (M10). */
const clientIdFor = (family, botId, scopeRef) => JSON.stringify([family, botId, scopeRef]);

/**
 * One tools/call: the live caller, filter, _meta, in-flight cap, timeout, abort, shaping.
 * `tool.unknown` marks a name the session never registered (M5).
 */
async function runTool(m, tool, args, extra) {
  const t0 = m.now();
  const live = callerContext.getStore();
  const st = live ? requestState.get(live) : undefined;
  const lang = st?.lang || "en";
  const done = (outcome, result, bytes = 0) => {
    emit(m, {
      ts: new Date().toISOString(), family: m.family, key: st?.key ?? null, botId: live?.botId ?? null, scopeRef: live?.scopeRef ?? null,
      method: "tools/call", tool: tool.name, outcome, ms: m.now() - t0, bytes,
    }, st?.sid);
    return result;
  };
  const refuse = (code) => done(`refused:${code}`, errResult(loopbackErrorText(code, { lang })));
  const fail = (code, o = {}) => done(`error:${code}`, errResult(loopbackErrorText(code, { lang, tool: tool.name, ...o })));

  // 1. the LIVE caller (a store this mount made for this request), never a closure.
  if (!live || !st || live.family !== m.family) return refuse("unattributed");
  // A name this session never registered: the fixed text and an audit event.
  if (tool.unknown) return refuse("not_granted");
  // 2. the filter, again, on every call.
  if (!filterOk(m, live.ctx, tool)) return refuse("not_granted");
  if (args === INVALID_ARGS) return done("refused:invalid_args", errResult(loopbackErrorText("invalid_args", { lang, tool: tool.name })));
  // 3. crow.dev/* _meta is Crow's alone: never forwarded from the caller.
  const meta = stripCrowDev(extra?._meta);
  let callArgs = isPlainObject(args) ? args : {};
  if (Object.hasOwn(callArgs, "_meta")) callArgs = { ...callArgs, _meta: stripCrowDev(callArgs._meta) };
  // 4. the in-flight cap for this mount key, and this bot's share of it.
  const botKey = JSON.stringify([st.key, live.botId]);
  const n = m.inflight.get(st.key) || 0;
  const nb = m.inflightBot.get(botKey) || 0;
  // Reclaimed-but-unsettled calls (the ceiling) still spend the budget.
  const rk = m.reclaimed.get(st.key) || 0;
  const rb = m.reclaimedBot.get(botKey) || 0;
  if (n >= m.maxInFlight || nb >= m.maxInFlightPerBot || rk >= m.maxInFlight || rb >= m.maxInFlightPerBot) return refuse("busy");
  m.inflight.set(st.key, n + 1);
  m.inflightBot.set(botKey, nb + 1);
  // The slot is released when the upstream's OWN promise settles (header), or
  // at the hard ceiling for a call that never does.
  let released = false;
  let reclaimed = false;
  let ceiling = null;
  const ceilingAc = new AbortController();
  const dec = (map, k) => { const left = (map.get(k) || 1) - 1; if (left > 0) map.set(k, left); else map.delete(k); };
  const release = () => {
    if (released) return;
    released = true;
    if (ceiling) clearTimeout(ceiling);
    dec(m.inflight, st.key);
    dec(m.inflightBot, botKey);
  };
  // The raw upstream promise settled: free the active slot, or the budget a
  // reclaimed call was still holding.
  const settled = () => {
    if (reclaimed) { reclaimed = false; dec(m.reclaimed, st.key); dec(m.reclaimedBot, botKey); }
    release();
  };
  let raw;
  try {
    const timeout = AbortSignal.timeout(m.callTimeoutMs);
    const signal = AbortSignal.any([timeout, st.closed, ceilingAc.signal, ...(extra?.signal ? [extra.signal] : [])]);
    const aborted = new Promise((_, rej) => {
      if (signal.aborted) rej(signal.reason);
      else signal.addEventListener("abort", () => rej(signal.reason), { once: true });
    });
    let result;
    try {
      // 5. the upstream; an upstream that ignores the signal still loses the race.
      raw = Promise.resolve().then(() => m.upstream.callTool(live.ctx, tool.name, callArgs, { signal, meta, ceilingSignal: ceilingAc.signal }));
      raw.then(settled, settled);
      ceiling = setTimeout(() => {
        if (released) return;
        ceiling = null;
        reclaimed = true;
        m.reclaimed.set(st.key, (m.reclaimed.get(st.key) || 0) + 1);
        m.reclaimedBot.set(botKey, (m.reclaimedBot.get(botKey) || 0) + 1);
        release();
        ceilingAc.abort(new Error(`in-flight ceiling (${secsOf(m.inFlightCeilingMs)} s) reached`));
        try {
          Promise.resolve(m.upstream.cancelCall?.(live.ctx, tool.name, { reason: "ceiling" })).catch(() => { /* swallowed */ });
        } catch { /* swallowed */ }
        noteRefusedOnce(`${m.family}:inflight`, `a call that never settled was aborted and its slot reclaimed at the ${secsOf(m.inFlightCeilingMs)} s ceiling`);
      }, m.inFlightCeilingMs);
      ceiling.unref?.();
      result = await Promise.race([raw, aborted]);
    } catch (err) {
      if (timeout.aborted) return fail("timeout", { secs: secsOf(m.callTimeoutMs) });
      if (signal.aborted) return fail("aborted");
      let code = "failed";
      try { if (err !== null && typeof err === "object" && typeof err.code === "string" && TOOL_CODES.has(err.code)) code = err.code; } catch { code = "failed"; }
      return fail(code);
    }
    // 6. shaping, all of it inside one try: any throw is "<tool> failed." (M4).
    let out, bytes;
    try {
      if (!isPlainObject(result) || !Array.isArray(result.content)) {
        const code = isPlainObject(result) && typeof result.code === "string" && TOOL_CODES.has(result.code) ? result.code : "failed";
        return fail(code);
      }
      const secrets = Array.isArray(live.ctx?.secrets) ? live.ctx.secrets : [];
      const content = [];
      const texts = [];
      let dropped = 0;
      for (const item of result.content) {
        const kind = isPlainObject(item) && m.contentTypes.has(item.type) ? item.type : null;
        const text = kind === "text" ? item.text : undefined;
        if (kind === "text" && typeof text === "string") { texts.push(content.length); content.push({ type: "text", text }); }
        else if (kind === "image" && typeof item.mimeType === "string" && IMAGE_MIME.has(item.mimeType) && typeof item.data === "string" && BASE64_RE.test(item.data)) {
          content.push({ type: "image", mimeType: item.mimeType, data: item.data });
        } else dropped++;
      }
      // Redacted as one text, so a secret split across two items is caught (M3).
      const redacted = redactAcross(texts.map((i) => content[i].text), secrets);
      texts.forEach((i, k) => { content[i] = { type: "text", text: redacted[k] }; });
      if (dropped) {
        content.push({ type: "text", text: loopbackErrorText("dropped", { lang, n: dropped }) });
        noteRefusedOnce(`${m.family}:result`, "dropped content items outside the allowlist");
      }
      out = { content };
      if (result.isError === true) out.isError = true;
      bytes = Buffer.byteLength(JSON.stringify(out));
    } catch {
      return fail("failed");
    }
    if (bytes > m.maxBytes) return fail("too_large", { kib: Math.ceil(bytes / 1024) });
    return done(out.isError ? "error:upstream" : "ok", out, bytes);
  } finally {
    // Never got as far as the upstream (a throw building the signal): free it now.
    if (!raw) release();
  }
}

/** Redacted and capped: a string a tools/list reader sees (M2). */
const clip = (v, secrets) => redactSecrets(v, secrets).slice(0, DESC_MAX);

/**
 * A copy of an upstream input schema whose human-readable strings
 * (description, title, const, default, and the strings of enum / examples)
 * are redacted and capped. Keys and structure are kept; past
 * SCHEMA_MAX_DEPTH the subtree is dropped (it would not convert anyway).
 */
function sanitizeSchema(node, secrets, depth = 0) {
  if (depth > SCHEMA_MAX_DEPTH) return {};
  if (Array.isArray(node)) return node.map((v) => sanitizeSchema(v, secrets, depth + 1));
  if (!isPlainObject(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === "description" || k === "title" || k === "const" || k === "default") && typeof v === "string") out[k] = clip(v, secrets);
    else if ((k === "enum" || k === "examples") && Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? clip(x, secrets) : sanitizeSchema(x, secrets, depth + 1)));
    else out[k] = sanitizeSchema(v, secrets, depth + 1);
  }
  return out;
}

/**
 * The per-session McpServer: EVERY upstream tool is registered, and the filter
 * decides live (tools/list through the `enabled` getter below, tools/call in
 * runTool), so a hidden tool gets the fixed text and an audit event.
 *
 * Three reliances on @modelcontextprotocol/sdk 1.27.1 internals, all covered by
 * tests/loopback-tool-mount.test.js (re-run it on any SDK bump):
 *  - RegisteredTool.enabled is a plain property McpServer reads when it lists
 *    and when it calls; here it is a getter;
 *  - McpServer#validateToolInput (TS-private) is wrapped on the instance so a
 *    schema failure reaches runTool as INVALID_ARGS (fixed text + audit) and
 *    not as the SDK's own message. If the method is ever gone, the SDK's
 *    validation still runs unwrapped (its text, no audit): fail closed;
 *  - McpServer installs its tools/call handler through the (public)
 *    server.setRequestHandler(CallToolRequestSchema, ...); that call is
 *    wrapped on the instance so a name this session never registered reaches
 *    runTool (fixed text + audit) instead of the SDK's "Tool <x> not found".
 */
function buildServer(m, tools, secrets = []) {
  const server = new McpServer({ name: `crow-${m.family}`, version: "1.0.0" });
  if (typeof server.validateToolInput === "function") {
    const validate = server.validateToolInput.bind(server);
    server.validateToolInput = async (...a) => { try { return await validate(...a); } catch { return INVALID_ARGS; } };
  }
  const seen = new Set();
  const inner = server.server;
  const setHandler = inner.setRequestHandler.bind(inner);
  inner.setRequestHandler = (schema, handler) => {
    if (schema !== CallToolRequestSchema) return setHandler(schema, handler);
    return setHandler(schema, (request, extra) => {
      const name = request?.params?.name;
      if (typeof name === "string" && seen.has(name)) return handler(request, extra);
      return runTool(m, { name: String(name ?? "").slice(0, 64), unknown: true }, undefined, extra);
    });
  };
  const sec = Array.isArray(secrets) ? secrets : [];
  const pool = { units: SOURCE_BUDGET };
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isPlainObject(tool) || typeof tool.name !== "string" || !tool.name || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const description = clip(typeof tool.description === "string" ? tool.description : tool.name, sec);
    const registered = server.registerTool(
      tool.name,
      { description, inputSchema: jsonSchemaToZodObject(sanitizeSchema(tool.inputSchema, sec), pool) },
      (args, extra) => runTool(m, tool, args, extra),
    );
    // tools/list follows the LIVE ctx too: a tool is listed only while the
    // filter passes for the request that lists. A call always reaches runTool,
    // which re-checks the filter itself and answers with the fixed text.
    Object.defineProperty(registered, "enabled", {
      configurable: true, enumerable: true,
      get() {
        const live = callerContext.getStore();
        const st = live ? requestState.get(live) : undefined;
        return st?.method === "tools/list" ? filterOk(m, live.ctx, tool) : true;
      },
      set() { /* fixed by the filter */ },
    });
  }
  return server;
}

/** Test seam: the per-session server for an ctx, outside any request (no caller store). */
export async function _buildLoopbackServerForTest(opts, ctx) {
  const m = normalize(opts);
  return buildServer(m, await m.upstream.listTools(ctx), ctx?.secrets);
}

/**
 * Mount one loopback tool family: `POST|GET|DELETE /<family>/<params>/mcp`.
 * See the header for the fixed order. Throws TypeError on a bad option.
 * Returns `{ sweepIdle(), stop() }`: the idle sweep runs on its own unref'd
 * timer; sweepIdle runs it now (tests), stop ends the timer.
 */
export function mountLoopbackMcp(app, opts) {
  const m = normalize(opts);
  const handlersByStore = new Map();
  const lastSeen = new Map(); // JSON [storeName, sid] -> ms of its last request
  const handlersFor = (storeName) => {
    let h = handlersByStore.get(storeName);
    if (!h) {
      const store = m.sessionManager.getStore(storeName, "streamable");
      h = { store, ...createMcpHandler(store, () => {
        const live = callerContext.getStore();
        const st = live ? requestState.get(live) : undefined;
        return buildServer(m, st ? st.tools : [], live?.ctx?.secrets);
      }, storeName, { resumable: false }) };
      handlersByStore.set(storeName, h);
    }
    return h;
  };
  const seenKey = (storeName, sid) => JSON.stringify([storeName, sid]);
  const closeEntry = (store, storeName, sid, entry) => {
    store.delete(sid);
    lastSeen.delete(seenKey(storeName, sid));
    Promise.resolve().then(() => entry.transport.close()).catch(() => { /* already closed */ });
  };
  /** Close the stored session `sid` if (and only if) `clientId` owns it. */
  const closeOwned = (storeName, sid, clientId) => {
    const store = handlersByStore.get(storeName)?.store;
    const entry = sid && store ? store.get(sid) : undefined;
    if (entry && entry.owner === clientId) closeEntry(store, storeName, sid, entry);
  };
  const sweepIdle = () => {
    const now = m.now();
    const live = new Set();
    for (const [storeName, { store }] of handlersByStore) {
      for (const [sid, entry] of [...store.entries()]) {
        const k = seenKey(storeName, sid);
        const at = lastSeen.get(k);
        if (at === undefined) { lastSeen.set(k, now); live.add(k); continue; }
        if (now - at > m.sessionIdleMs) closeEntry(store, storeName, sid, entry);
        else live.add(k);
      }
    }
    for (const k of [...lastSeen.keys()]) if (!live.has(k)) lastSeen.delete(k);
  };
  const timer = setInterval(sweepIdle, Math.min(60_000, m.sessionIdleMs));
  timer.unref?.();

  app.all(`/${m.family}/${m.params}/mcp`, async (req, res) => {
    const t0 = m.now();
    const lang = langOf(req);
    const body = req.body;
    const single = isPlainObject(body) ? body : null;
    const id = single && single.id !== undefined ? single.id : null;
    const method = single && typeof single.method === "string" ? single.method.slice(0, 64) : req.method;
    // Each value encoded, so "a/b" + "c" and "a" + "b/c" are different keys.
    const key = Object.values(req.params || {}).map((v) => encodeURIComponent(String(v))).join("/");
    const sidRaw = req.headers["mcp-session-id"];
    const sid = typeof sidRaw === "string" && sidRaw ? sidRaw : undefined;
    const storeName = `${m.family}-${key}`;
    let botId = null, scopeRef = null;

    let db = null;
    let dbClosed = false;
    const getDb = () => { if (!db) db = m.createDbClient(); return db; };
    const closed = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) closed.abort(new Error("client closed"));
      if (db && !dbClosed) { dbClosed = true; try { db.close(); } catch { /* already closed */ } }
    });

    const refuse = (status, code, rpcCode = -32001) => {
      emit(m, { ts: new Date().toISOString(), family: m.family, key, botId, scopeRef, method, outcome: `refused:${code}`, ms: m.now() - t0, bytes: 0 }, sid);
      if (res.headersSent) return;
      if (status === 404) { res.status(404).end(); return; }
      res.status(status).json({ jsonrpc: "2.0", error: { code: rpcCode, message: loopbackErrorText(code, { lang }) }, id });
    };

    // 1. Source before method: a non-local caller gets the empty 404 for any
    //    method, before any DB work (which is why the general rate limiter can
    //    skip these paths: middleware/rate-limit.js).
    if (!isLocalPeer(req.socket?.remoteAddress, req.headers) || req.instanceAuth || req.crossHostAuth) return refuse(404, "not_found");
    // 2.
    if (!["POST", "GET", "DELETE"].includes(req.method)) return refuse(405, "method_not_allowed");

    // 2-5. The gate (each step's throw is that step's refusal). `verified` is
    // the actor whose signature checked out, kept for a step-5 refusal: its
    // own session (only) is closed when its scope has died.
    let verified = null;
    const gate = await loopbackActorGate(req, {
      validateToken: async (t) => (await m.validate(getDb(), t)) === true,
      verify: async (headers) => {
        const a = readActorHeaders(headers);
        if (a.kind !== m.actorKind) return null;
        if (typeof a.botId !== "string" || !BOT_ID_RE.test(a.botId)) return null;
        const ok = m.verifySig({ kind: a.kind, botId: a.botId, scope: a.scopeRef, threadId: a.threadId, gatewayType: a.gatewayType, sig: a.sig });
        if (ok !== true) return null;
        return { kind: a.kind, botId: a.botId, scopeRef: a.scopeRef, threadId: a.threadId, gatewayType: a.gatewayType };
      },
      resolve: async (a) => {
        verified = a;
        const r = await m.resolveScope(getDb(), { botId: a.botId, scopeRef: a.scopeRef, threadId: a.threadId, gatewayType: a.gatewayType });
        return isPlainObject(r) ? r : null;
      },
    });
    if (!gate.ok) {
      if (verified && gate.status === 403) closeOwned(storeName, sid, clientIdFor(m.family, verified.botId, verified.scopeRef));
      return refuse(gate.status, gate.code);
    }
    const actor = gate.actor;
    botId = actor.botId;
    scopeRef = actor.scopeRef;

    // 6.
    if (Array.isArray(body)) return refuse(400, "batch", -32600);

    // 7. The session belongs to this bot under this scope.
    const clientId = clientIdFor(m.family, botId, scopeRef);
    req.auth = { clientId, token: "loopback-tool-mount", scopes: [] };
    // Peek only: a store is created after authorize passes, never before.
    const known = handlersByStore.get(storeName)?.store;
    if (sid && known?.has(sid) && known.get(sid)?.owner !== clientId) return refuse(404, "not_found");

    // 7a. The owner's own turn only, unless the family opted out.
    if (m.ownerTurnOnly && !isOwnerTurnScope(actor, { engine: perchEngineOf(m) })) {
      closeOwned(storeName, sid, clientId);
      return refuse(403, "not_owner_turn");
    }

    // 8. authorize, on every request.
    let az = null;
    try { az = await m.authorize({ db: getDb(), req, params: req.params, actor }); } catch { az = null; }
    if (!isPlainObject(az) || az.ok !== true) {
      const code = isPlainObject(az) && az.ok === false && typeof az.code === "string" && Object.hasOwn(AUTHZ_STATUS, az.code) ? az.code : "not_granted";
      closeOwned(storeName, sid, clientId);
      return refuse(AUTHZ_STATUS[code], code);
    }
    const ctx = isPlainObject(az.ctx) ? az.ctx : {};

    // 10. initialize only: the upstream is up, and its tools for this ctx.
    let tools = [];
    if (!sid && isInitializeRequest(body)) {
      try {
        const r = await m.upstream.onInitialize?.(ctx);
        if (isPlainObject(r) && r.code !== undefined) return refuse(502, "child_unavailable");
        tools = await m.upstream.listTools(ctx);
        if (!Array.isArray(tools)) return refuse(502, "child_unavailable");
      } catch { return refuse(502, "child_unavailable"); }
    }

    // 11. Run the request inside the caller context.
    const h = handlersFor(storeName);
    if (sid && h.store.has(sid)) lastSeen.set(seenKey(storeName, sid), m.now());
    const store = { caller: `bot:${botId}`, botId, peer: false, crossHost: false, family: m.family, scopeRef, projectId: actor.defProjectId ?? null, ctx };
    requestState.set(store, { lang, method, sid, key, tools, closed: closed.signal });
    const handler = req.method === "POST" ? h.postHandler : req.method === "GET" ? h.getHandler : h.deleteHandler;
    try {
      await callerContext.run(store, () => handler(req, res));
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id });
    }
    // A session this request just opened starts its idle clock now.
    if (!sid) {
      let opened;
      try { opened = res.getHeader("mcp-session-id"); } catch { opened = undefined; }
      if (typeof opened === "string" && h.store.has(opened)) lastSeen.set(seenKey(storeName, opened), m.now());
    }
  });

  return { sweepIdle, stop: () => clearInterval(timer) };
}
