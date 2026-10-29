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
 *   7. the MCP session is bound to `${family}:${botId}:${scopeRef}` (stored as
 *      its owner via req.auth.clientId): another bot's, or the same bot's under
 *      another scope -> 404, empty body;
 *   8. `authorize` on EVERY request -> its code's status from the table;
 *   9. (tools/call) the in-flight cap per mount key -> isError `busy`;
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
 * upstream ignores the abort) keep their slot until they really end.
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
 *
 * One audit event per tools/call and per refusal, never arguments, results,
 * headers or tokens.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler } from "./routes/mcp.js";
import { isLocalPeer } from "../shared/peer-class.js";
import { loopbackActorGate, noteRefusedOnce, readActorHeaders } from "./loopback-gate.js";
import { callerContext } from "./caller-context.js";
import { recordToolCall } from "./session-logger.js";
import { redactSecrets } from "../shared/redact-secrets.js";
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
  need(typeof o.toolFilter === "function", "toolFilter is required");
  need(isPlainObject(o.resultCap) && Number.isInteger(o.resultCap.maxBytes) && o.resultCap.maxBytes > 0
    && Array.isArray(o.resultCap.contentTypes) && o.resultCap.contentTypes.length > 0 && o.resultCap.contentTypes.every((t) => CONTENT_KINDS.has(t)),
  'resultCap needs { maxBytes, contentTypes } (contentTypes from "text", "image")');
  need(Number.isInteger(o.callTimeoutMs) && o.callTimeoutMs > 0, "callTimeoutMs is required (a positive integer)");
  const maxInFlight = o.maxInFlight === undefined ? 4 : o.maxInFlight;
  need(Number.isInteger(maxInFlight) && maxInFlight > 0, "maxInFlight must be a positive integer");
  need(o.onAudit === undefined || typeof o.onAudit === "function", "onAudit must be a function");
  need(typeof o.sessionManager?.getStore === "function", "sessionManager is required");
  need(typeof o.createDbClient === "function", "createDbClient is required");
  const deps = isPlainObject(o.deps) ? o.deps : {};
  return {
    family: o.family, params: o.params, actorKind: o.actorKind,
    validate: hasFn ? o.validateToken : (db, t) => o.token.validate(db, t),
    authorize: o.authorize, upstream: o.upstream, toolFilter: o.toolFilter,
    maxBytes: o.resultCap.maxBytes, contentTypes: new Set(o.resultCap.contentTypes),
    callTimeoutMs: o.callTimeoutMs, maxInFlight, onAudit: o.onAudit,
    sessionManager: o.sessionManager, createDbClient: o.createDbClient,
    verifySig: deps.verifyScopeActorSig || verifyScopeActorSig,
    resolveScope: deps.resolveSignedScope || resolveSignedScope,
    now: deps.now || (() => Date.now()),
    inflight: new Map(),
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

/** One tools/call: the live caller, filter, _meta, in-flight cap, timeout, abort, shaping. */
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
  // 2. the filter, again, on every call.
  if (!filterOk(m, live.ctx, tool)) return refuse("not_granted");
  if (args === INVALID_ARGS) return done("refused:invalid_args", errResult(loopbackErrorText("invalid_args", { lang, tool: tool.name })));
  // 3. crow.dev/* _meta is Crow's alone: never forwarded from the caller.
  const meta = stripCrowDev(extra?._meta);
  let callArgs = isPlainObject(args) ? args : {};
  if (Object.hasOwn(callArgs, "_meta")) callArgs = { ...callArgs, _meta: stripCrowDev(callArgs._meta) };
  // 4. the in-flight cap for this mount key.
  const n = m.inflight.get(st.key) || 0;
  if (n >= m.maxInFlight) return refuse("busy");
  m.inflight.set(st.key, n + 1);
  // The slot is released when the upstream's OWN promise settles (header).
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (m.inflight.get(st.key) || 1) - 1;
    if (left > 0) m.inflight.set(st.key, left); else m.inflight.delete(st.key);
  };
  let raw;
  try {
    const timeout = AbortSignal.timeout(m.callTimeoutMs);
    const signal = AbortSignal.any([timeout, st.closed, ...(extra?.signal ? [extra.signal] : [])]);
    const aborted = new Promise((_, rej) => {
      if (signal.aborted) rej(signal.reason);
      else signal.addEventListener("abort", () => rej(signal.reason), { once: true });
    });
    let result;
    try {
      // 5. the upstream; an upstream that ignores the signal still loses the race.
      raw = Promise.resolve().then(() => m.upstream.callTool(live.ctx, tool.name, callArgs, { signal, meta }));
      raw.then(release, release);
      result = await Promise.race([raw, aborted]);
    } catch (err) {
      if (timeout.aborted) return fail("timeout", { secs: secsOf(m.callTimeoutMs) });
      if (signal.aborted) return fail("aborted");
      const code = err !== null && typeof err === "object" && typeof err.code === "string" && TOOL_CODES.has(err.code) ? err.code : "failed";
      return fail(code);
    }
    if (!isPlainObject(result) || !Array.isArray(result.content)) {
      const code = isPlainObject(result) && typeof result.code === "string" && TOOL_CODES.has(result.code) ? result.code : "failed";
      return fail(code);
    }
    // 6. shaping: allowed content types only, redacted text, content + isError only.
    const secrets = Array.isArray(live.ctx?.secrets) ? live.ctx.secrets : [];
    const content = [];
    let dropped = 0;
    for (const item of result.content) {
      const kind = isPlainObject(item) && m.contentTypes.has(item.type) ? item.type : null;
      if (kind === "text" && typeof item.text === "string") content.push({ type: "text", text: redactSecrets(item.text, secrets) });
      else if (kind === "image" && typeof item.mimeType === "string" && IMAGE_MIME.has(item.mimeType) && typeof item.data === "string" && BASE64_RE.test(item.data)) {
        content.push({ type: "image", mimeType: item.mimeType, data: item.data });
      } else dropped++;
    }
    if (dropped) {
      content.push({ type: "text", text: loopbackErrorText("dropped", { lang, n: dropped }) });
      noteRefusedOnce(`${m.family}:result`, "dropped content items outside the allowlist");
    }
    const out = { content };
    if (result.isError === true) out.isError = true;
    const bytes = Buffer.byteLength(JSON.stringify(out));
    if (bytes > m.maxBytes) return fail("too_large", { kib: Math.ceil(bytes / 1024) });
    return done(out.isError ? "error:upstream" : "ok", out, bytes);
  } finally {
    // Never got as far as the upstream (a throw building the signal): free it now.
    if (!raw) release();
  }
}

/**
 * The per-session McpServer: EVERY upstream tool is registered, and the filter
 * decides live (tools/list through the `enabled` getter below, tools/call in
 * runTool), so a hidden tool gets the fixed text and an audit event.
 *
 * Two reliances on @modelcontextprotocol/sdk 1.27.1 internals, both covered by
 * tests/loopback-tool-mount.test.js (re-run it on any SDK bump):
 *  - RegisteredTool.enabled is a plain property McpServer reads when it lists
 *    and when it calls; here it is a getter;
 *  - McpServer#validateToolInput (TS-private) is wrapped on the instance so a
 *    schema failure reaches runTool as INVALID_ARGS (fixed text + audit) and
 *    not as the SDK's own message. If the method is ever gone, the SDK's
 *    validation still runs unwrapped (its text, no audit): fail closed.
 */
function buildServer(m, tools) {
  const server = new McpServer({ name: `crow-${m.family}`, version: "1.0.0" });
  if (typeof server.validateToolInput === "function") {
    const validate = server.validateToolInput.bind(server);
    server.validateToolInput = async (...a) => { try { return await validate(...a); } catch { return INVALID_ARGS; } };
  }
  const pool = { units: SOURCE_BUDGET };
  const seen = new Set();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isPlainObject(tool) || typeof tool.name !== "string" || !tool.name || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const registered = server.registerTool(
      tool.name,
      { description: typeof tool.description === "string" ? tool.description : tool.name, inputSchema: jsonSchemaToZodObject(tool.inputSchema, pool) },
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
  return buildServer(m, await m.upstream.listTools(ctx));
}

/**
 * Mount one loopback tool family: `POST|GET|DELETE /<family>/<params>/mcp`.
 * See the header for the fixed order. Throws TypeError on a bad option.
 */
export function mountLoopbackMcp(app, opts) {
  const m = normalize(opts);
  const handlersByStore = new Map();
  const handlersFor = (storeName) => {
    let h = handlersByStore.get(storeName);
    if (!h) {
      const store = m.sessionManager.getStore(storeName, "streamable");
      h = { store, ...createMcpHandler(store, () => {
        const live = callerContext.getStore();
        return buildServer(m, live ? requestState.get(live)?.tools : []);
      }, storeName) };
      handlersByStore.set(storeName, h);
    }
    return h;
  };

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

    // 1. Source before method: a non-local caller gets the empty 404 for any method.
    if (!isLocalPeer(req.socket?.remoteAddress, req.headers) || req.instanceAuth || req.crossHostAuth) return refuse(404, "not_found");
    // 2.
    if (!["POST", "GET", "DELETE"].includes(req.method)) return refuse(405, "method_not_allowed");

    // 2-5. The gate (each step's throw is that step's refusal).
    const gate = await loopbackActorGate(req, {
      validateToken: async (t) => (await m.validate(getDb(), t)) === true,
      verify: async (headers) => {
        const a = readActorHeaders(headers);
        if (a.kind !== m.actorKind) return null;
        const ok = m.verifySig({ kind: a.kind, botId: a.botId, scope: a.scopeRef, threadId: a.threadId, gatewayType: a.gatewayType, sig: a.sig });
        if (ok !== true) return null;
        return { kind: a.kind, botId: a.botId, scopeRef: a.scopeRef, threadId: a.threadId, gatewayType: a.gatewayType };
      },
      resolve: async (a) => {
        const r = await m.resolveScope(getDb(), { botId: a.botId, scopeRef: a.scopeRef, threadId: a.threadId, gatewayType: a.gatewayType });
        return isPlainObject(r) ? r : null;
      },
    });
    if (!gate.ok) return refuse(gate.status, gate.code);
    const actor = gate.actor;
    botId = actor.botId;
    scopeRef = actor.scopeRef;

    // 6.
    if (Array.isArray(body)) return refuse(400, "batch", -32600);

    // 7. The session belongs to this bot under this scope.
    const clientId = `${m.family}:${botId}:${scopeRef}`;
    req.auth = { clientId, token: "loopback-tool-mount", scopes: [] };
    // Peek only: a store is created after authorize passes, never before.
    const storeName = `${m.family}-${key}`;
    const known = handlersByStore.get(storeName)?.store;
    if (sid && known?.has(sid) && known.get(sid)?.owner !== clientId) return refuse(404, "not_found");

    // 8. authorize, on every request.
    let az = null;
    try { az = await m.authorize({ db: getDb(), req, params: req.params, actor }); } catch { az = null; }
    if (!isPlainObject(az) || az.ok !== true) {
      const code = isPlainObject(az) && az.ok === false && typeof az.code === "string" && Object.hasOwn(AUTHZ_STATUS, az.code) ? az.code : "not_granted";
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
    const store = { caller: `bot:${botId}`, botId, peer: false, crossHost: false, family: m.family, scopeRef, projectId: actor.defProjectId ?? null, ctx };
    requestState.set(store, { lang, method, sid, key, tools, closed: closed.signal });
    const handler = req.method === "POST" ? h.postHandler : req.method === "GET" ? h.getHandler : h.deleteHandler;
    try {
      await callerContext.run(store, () => handler(req, res));
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id });
    }
  });
}
