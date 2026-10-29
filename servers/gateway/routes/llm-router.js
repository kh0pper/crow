/**
 * Gateway LLM-router route — folds the standalone companion model-proxy
 * (scripts/companion/model-proxy.mjs, formerly companion-model-proxy.service on
 * loopback :11435) INTO the gateway as an OpenAI-compatible route.
 *
 *   POST /llm/v1/chat/completions   pick fast vs escalate, forward + stream
 *                                   (or a door forward when explicitly addressed)
 *   POST /llm/v1/{completions,embeddings,rerank}   door forwards only
 *   POST /llm/p/<provider>/v1/...    the provider-scoped door
 *   POST /llm/c/<provider>/v1/...    the cloud door (consented cloud rows only)
 *   GET  /llm/v1/models             companion ids + forwardable door models
 *
 * It does ONE job: choose which local model answers each turn, then forward the
 * request verbatim and stream the response straight back. The companion
 * (Open-LLM-VTuber, host-networked) and the Meta Glasses both point their LLM
 * base_url here, so each keeps running its own tool loop — MCP tools, the
 * client-side crow_wm window/media control, and token streaming all keep
 * working; this route only chooses the upstream.
 *
 * Routing (ported verbatim from model-proxy.mjs):
 *   - default             → fast model  (crow-voice / qwen3.5-4b, :8011)
 *   - leading "!escalate"  → escalation model (crow-chat / qwen3.6-35b-a3b, :8003)
 *   - tool-intent / recent tool context → escalation (the fast 4B narrates tool
 *     use instead of calling; the 35B is the far better tool-caller).
 *
 * SECURITY: mounted WITHOUT dashboardAuth. isAllowedNetwork() rejects bare
 * loopback (auth.js), and the host-networked companion arrives as loopback, so
 * password/network auth here would 403 every legitimate turn. The gateway
 * listens on ALL interfaces (LAN + tailnet + loopback), so binding is not a
 * boundary. Every /llm/v1 and /llm/p request — the companion path included
 * (Casey decision 2026-10-02: every companion device is on Tailscale) — door
 * addressing (provider path /llm/p/<provider>/v1, the X-Crow-Provider header,
 * a qualified "<provider>/<model>" id, or a bare id that resolves to a
 * forwardable row) and /llm/acquire are limited to loopback and the tailnet
 * (100.64.0.0/10, fd7a:115c:a1e0::/48) or a bearer token. Funnel is refused
 * here (first middleware, so CROW_DASHBOARD_PUBLIC cannot bypass it) and by
 * the global rejectFunneledMiddleware (asserted in tests/auth-network.test.js).
 * Mirrors routes/companion-proxy.js. NOT a pi gateway: it never spawns pi.
 *
 * The cloud door /llm/c is stricter than the rest (roles phase 2, Task 16;
 * models/cloud-door.js): it adds a real provider key inside the gateway, so
 * the tailnet is NOT enough. Only a loopback socket with no forwarding header
 * and no Tailscale identity header, carrying the per-boot cloud-door token
 * (and no other token), reaches it; Funnel is refused by name. It forwards
 * only to the row's own base URL, only while this box's consent still matches
 * that URL and key (re-read every request), through safeRequest. No --no-auth
 * bypass exists: the router never reads that flag.
 */

import express from "express";
import { Readable } from "node:stream";
import { createDbClient } from "../../db.js";
import { resolveProviderConfig } from "../ai/resolve-profile.js";
import { maybeAcquireLocalProvider, warmProviderByName } from "../gpu-orchestrator.js";
import { requesterTag } from "../requester-tag.js";
import { ReservedError } from "../box-reservation.js";
import { ServingClassError } from "../models/serving-class.js";
import { connectTimeout, isTimeoutError, LLM_CONNECT_TIMEOUT_MS } from "../../shared/http-timeout.js";
import { extractUsageFromOpenAIResponse, recordUsageEvent } from "../../shared/metering.js";
import { resolveTenantId } from "../../shared/tenancy.js";
import { loadProviders } from "../../shared/providers.js";
import { validateLocalToken, validateModelsToken } from "../local-token.js";
import { resolveDoorTarget, listDoorModels, isTrustedDoorRequest, DOOR_PROVIDER_HEADER, DOOR_HOP_HEADER } from "../models/door-resolve.js";
import { providerDoorUrl } from "../models/door.js";
import { createCloudDoor, CLOUD_DOOR_DEFAULTS } from "../models/cloud-door.js";
import { validateLlmCloudToken } from "../local-token.js";
import { readCloudConsent, readCloudConsentSalt } from "../../shared/cloud-consent.js";
import { providerRowToObject } from "../../shared/provider-row.js";
import { nowContext, relativeDatesContext, mentionsRelativeDay } from "../../shared/relative-dates.js";
import { withTurnContext } from "../voice/context-echo.js";
import { createSseEchoFilter, stripJsonEcho } from "../voice/sse-echo.js";
import { VOICE_ROUTE_DEFAULTS } from "../../shared/voice-route-defaults.js";
import { resolveRole } from "../../shared/model-roles-store.js";
import { isRoleRef } from "../../shared/model-roles.js";

const FAST_KEY = process.env.COMPANION_FAST_MODEL || VOICE_ROUTE_DEFAULTS.fast;
const ESC_KEY = process.env.COMPANION_ESCALATION_MODEL || VOICE_ROUTE_DEFAULTS.escalate;
// Disable visible chain-of-thought on the fast voice route (set "0" to keep it).
const FAST_DISABLE_THINKING = (process.env.COMPANION_FAST_DISABLE_THINKING || "1") !== "0";

// Leading tokens that force escalation to the big model. Stripped before forward.
const ESCALATE_RE = /^\s*!escalate\b[:,]?\s*/i;

// Smart tool-intent escalation. The fast 4B reliably chats but tends to NARRATE
// tool use ("I'll search your music") instead of emitting a tool call, and
// !escalate can't survive speech-to-text. So when tools are on the table and the
// user's message reads like an action request, route to the big model (a far
// better tool-caller). Set COMPANION_TOOL_ESCALATION=0 to disable.
const TOOL_ESCALATION = (process.env.COMPANION_TOOL_ESCALATION || "1") !== "0";
// Action verbs/targets that map to the companion's crow_wm + storage tools
// (open/play media, transport control, search, files, image gen, calls). Word-
// boundary, case-insensitive. False positives only cost a slower (still-correct)
// turn; false negatives look like a hang — so this leans toward escalating.
const TOOL_INTENT_RE = new RegExp(
  "\\b(" +
    [
      "open", "launch", "play", "pause", "unpause", "resume", "stop",
      "mute", "unmute", "skip", "rewind", "volume", "louder", "quieter",
      "turn it (up|down)", "turn (up|down)",
      "watch", "show me", "pull up", "bring up", "go to", "navigate", "browse",
      "search", "look up", "look for", "find me", "google",
      "youtube", "jellyfin", "plex", "playlist",
      "upload", "download", "list (my )?files",
      "wallpaper", "background", "generate (an? )?(image|picture|background)",
      "video call", "start a call", "set (the )?background",
    ].join("|") +
    ")\\b",
  "i"
);

// How many trailing messages count as "recent" for sticky escalation. A tool turn
// leaves an assistant{tool_calls} + tool-result + assistant-reply in history (~3
// msgs); a plain turn adds ~2. A window of 8 keeps the next ~2-3 conversational
// follow-ups on the big model, then reverts to the fast model for pure chat.
const TOOL_CONTEXT_LOOKBACK = parseInt(process.env.COMPANION_TOOL_CONTEXT_LOOKBACK || "8", 10);

function splitKey(key) {
  const i = key.indexOf("/");
  return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}

// Resolve a "provider/model" key → { baseUrl, model, apiKey }. Cached briefly so
// we don't hit the DB every request, but short enough to pick up registry edits.
const _cache = new Map(); // key -> { at, val }
const CACHE_MS = 15000;
let _db = null;
function db() {
  if (!_db) _db = createDbClient();
  return _db;
}
async function resolveKey(key) {
  const hit = _cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.val;
  const [providerId, modelId] = splitKey(key);
  const r = await resolveProviderConfig(db(), providerId, modelId);
  const val = {
    baseUrl: (r.baseUrl || r.base_url || "").replace(/\/$/, ""),
    model: r.model || r.modelId || r.model_id || modelId,
    apiKey: r.apiKey || r.api_key || "none",
  };
  _cache.set(key, { at: now, val });
  return val;
}

function authHeaders(apiKey) {
  return apiKey && apiKey !== "none" ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * The model id the AI Companion's generated config sends (bundles/companion/scripts/generate-config.py). Only a
 * request naming exactly this id gets the turn context below: a request with no model, an unknown id or a bare
 * fast/escalate id (a peer, pi-lab, an outside client) is forwarded as it came.
 */
export const COMPANION_TURN_MODEL = "crow-companion";

/**
 * The bare model ids a request may name and still get the companion heuristics: the resolved fast and escalate
 * ids, the raw constants' ids (a client configured before a role was chosen keeps working) and
 * COMPANION_TURN_MODEL. With the raw keys this is exactly the old constant list.
 */
export function companionModelIds(keys) {
  const ids = [keys?.fast, keys?.escalate, FAST_KEY, ESC_KEY]
    .map((k) => (typeof k === "string" ? splitKey(k)[1] : undefined))
    .filter(Boolean);
  return [...new Set([...ids, COMPANION_TURN_MODEL])];
}

/** The cloud door's token check: the cloud-door hash only (never the local or models token). */
async function defaultCloudTokenAuth(token) {
  if (!token) return false;
  try { return await validateLlmCloudToken(db(), token); } catch { return false; }
}

/** One row, read fresh from the providers table (never the 30 s providers cache). */
async function defaultCloudProviders(id) {
  const { rows } = await db().execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] ? { [id]: providerRowToObject(rows[0]) } : {};
}

/** This box's consent map and salt, read fresh on every request. */
async function defaultCloudConsent() {
  const [consent, salt] = await Promise.all([readCloudConsent(db()), readCloudConsentSalt(db())]);
  return { consent, salt };
}

async function defaultDoorAuth(token) {
  if (!token) return false;
  try { return (await validateLocalToken(db(), token)) || (await validateModelsToken(db(), token)); } catch { return false; }
}

/** Non-companion door addressing: loopback/tailnet source, or a valid bearer. */
async function doorCallerAllowed(req, deps) {
  // Socket AND every forwarded address must be loopback/tailnet (final review I1).
  if (isTrustedDoorRequest(deps.remoteAddressFn(req), req.headers)) return true;
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? !!(await deps.doorAuthFn(h.slice(7))) : false;
}

function incomingHop(req) {
  const n = Number.parseInt(String(req.headers[DOOR_HOP_HEADER] || "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Forward one door request and stream the response back. */
async function forwardDoor(req, res, target, op, deps) {
  if (target.doorKind === "native-owned" || target.doorKind === "bundle") {
    await deps.acquireFn(target.providerId, { requester: requesterTag(req) });
  }
  const body = { ...(req.body || {}), model: target.modelId };
  const headers = { "Content-Type": "application/json", Accept: req.headers.accept || "application/json", ...authHeaders(target.apiKey) };
  let base = target.url;
  if (target.doorKind === "native-foreign") {
    headers[DOOR_PROVIDER_HEADER] = target.providerId;
    // Final review minor 5: a pre-plan-2 row stores the BARE /llm/v1 door. A
    // peer on an old router ignores X-Crow-Provider and would answer with its
    // companion heuristics (the wrong model, silently); the provider-scoped
    // path makes an old peer answer 404 instead (loud), a new one routes it.
    if (/\/llm\/v1$/i.test(base)) base = providerDoorUrl(base.replace(/\/llm\/v1$/i, "/llm/v1"), target.providerId);
  }
  // Every door forward carries hop+1 (upstream model servers ignore it); the
  // receiving door refuses a forward to another door at hop >= 1 and anything
  // at hop >= 2 (508), so even a non-door-shaped self-loop terminates.
  headers[DOOR_HOP_HEADER] = String(incomingHop(req) + 1);
  const url = `${base}/${op}`;
  let upstream;
  try {
    const t = connectTimeout(LLM_CONNECT_TIMEOUT_MS);
    upstream = t.disarm(await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: t.signal }));
  } catch (e) {
    const msg = isTimeoutError(e) ? `upstream connect timeout after ${Math.round(LLM_CONNECT_TIMEOUT_MS / 1000)}s` : `upstream ${target.providerId} unreachable: ${e.message}`;
    return res.status(502).json({ error: { code: "UPSTREAM_UNREACHABLE", message: msg } });
  }
  console.log(`[llm-router] door ${op} -> ${target.providerId}/${target.modelId} (${target.doorKind}) requester=${requesterTag(req)}`);
  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
  if (!upstream.body) return res.end();
  await new Promise((resolve) => {
    const s = Readable.fromWeb(upstream.body);
    s.on("error", (e) => { console.error(`[llm-router] door stream error: ${e.message}`); if (!res.writableEnded) res.end(); resolve(); });
    // A client abort destroys the stream with "close", not "error", and res never
    // emits "finish": resolve on close too, or one promise leaks per aborted stream.
    res.on("close", () => { s.destroy(); resolve(); });
    res.on("finish", resolve);
    s.pipe(res);
  });
}

function doorTargetFor(req, deps, keys) {
  const cfg = deps.loadProvidersFn() || { providers: {} };
  return resolveDoorTarget({
    providers: cfg.providers || {},
    providerHeader: (req.params && req.params.provider) || req.headers[DOOR_PROVIDER_HEADER] || null,
    model: req.body && req.body.model,
    companionModelIds: companionModelIds(keys),
    hop: incomingHop(req),
  });
}

function sendDoorError(res, t) {
  return res.status(t.status).json({ error: { code: t.code, message: t.message, ...(t.candidates ? { candidates: t.candidates } : {}) } });
}

/** Program-facing door: orchestrator refusals answer 409, as /llm/acquire does. */
function sendAcquireError(res, err) {
  if (err instanceof ReservedError) {
    return res.status(409).json({ error: { code: "box_reserved", message: err.message, owner: err.owner, expires_at: err.expires_at } });
  }
  if (err instanceof ServingClassError) {
    return res.status(409).json({ error: { code: "serving_class_refused", message: err.message, serving_class: err.servingClass } });
  }
  return res.status(502).json({ error: { code: "router_error", message: err?.message || String(err) } });
}

/** One door request: resolve, gate the caller, forward. */
async function handleDoor(req, res, op, deps, door) {
  if (!(await doorCallerAllowed(req, deps))) {
    return res.status(403).json({ error: { code: "DOOR_SOURCE_REFUSED", message: "door addressing is limited to loopback and the tailnet, or a bearer token" } });
  }
  if (door.kind === "error") return sendDoorError(res, door);
  try { await forwardDoor(req, res, door, op, deps); }
  catch (err) { if (!res.headersSent) sendAcquireError(res, err); }
}

// Flatten the latest user message to plain text (string or multi-part content).
function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      const c = msgs[i].content;
      return typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ")
          : "";
    }
  }
  return "";
}

function wantsEscalation(body) {
  return ESCALATE_RE.test(lastUserText(body));
}

// True when there's tool activity in the recent message window: a mid-loop tool
// result, OR a prior assistant turn that called a tool. The latter catches
// conversational FOLLOW-UPS that continue an action ("Josh Johnson stand-up
// comedy" after "play Josh Johnson on YouTube") which carry no action verb of
// their own and would otherwise fall back to the tool-weak fast model.
function recentToolContext(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const start = Math.max(0, msgs.length - TOOL_CONTEXT_LOOKBACK);
  for (let i = msgs.length - 1; i >= start; i--) {
    const m = msgs[i];
    if (m?.role === "tool") return true;
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
  }
  return false;
}

// Escalate when tools are available AND either there's recent tool context or the
// user's message reads like an action request the fast model would only narrate.
function wantsToolEscalation(body) {
  if (!TOOL_ESCALATION) return false;
  const tools = body?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  if (recentToolContext(body)) return true;
  return TOOL_INTENT_RE.test(lastUserText(body));
}

// Strip the !escalate token from the latest user message in-place (so the model
// and the transcript the model sees never contain it).
function stripEscalate(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      const c = msgs[i].content;
      if (typeof c === "string") {
        msgs[i] = { ...msgs[i], content: c.replace(ESCALATE_RE, "") };
      } else if (Array.isArray(c)) {
        msgs[i] = {
          ...msgs[i],
          content: c.map((p) =>
            typeof p === "object" && typeof p?.text === "string"
              ? { ...p, text: p.text.replace(ESCALATE_RE, "") }
              : p
          ),
        };
      }
      return;
    }
  }
}

/**
 * The companion's turn context (dates follow-up to queue item 17a). Open-LLM-VTuber sends a static system prompt and
 * no date, so "add a dentist appointment Monday" had nothing to count from. On a request naming COMPANION_TURN_MODEL,
 * the LAST user message gets [Now] (every turn) and [Dates] (when the user's words name a relative day), closed by
 * the [Note] line (context-echo.js withTurnContext). Never the system message or an earlier message: OLVV keeps the
 * raw text in its memory, so history (and the prefix cache over it) matches turn to turn. Server zone (OLVV sends
 * none). Skipped when the message already carries a [Now]/[Dates] line or a dashboard-style "Current date and
 * time:" stamp. COMPANION_TURN_CONTEXT=0 turns it off (read per request).
 * → the injected context text (for the echo guard), or null when nothing was added.
 */
const ALREADY_STAMPED = /^\[(Now|Dates)\] |Current date and time:/m;
function injectCompanionTurnContext(body, now) {
  if (process.env.COMPANION_TURN_CONTEXT === "0") return null;
  if (body?.model !== COMPANION_TURN_MODEL) return null;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i]?.role !== "user") i--;
  if (i < 0) return null;
  const text = lastUserText(body);
  if (ALREADY_STAMPED.test(text)) return null;
  const ctx = nowContext(now, null) + (mentionsRelativeDay(text) ? `\n${relativeDatesContext(now, null)}` : "");
  const c = msgs[i].content;
  if (typeof c === "string") {
    msgs[i] = { ...msgs[i], content: withTurnContext(ctx, c) };
  } else if (Array.isArray(c)) {
    const k = c.findIndex((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string");
    const content = c.slice();
    if (k >= 0) content[k] = { ...c[k], text: withTurnContext(ctx, c[k].text) };
    else content.unshift({ type: "text", text: withTurnContext(ctx, "") });
    msgs[i] = { ...msgs[i], content };
  } else {
    return null;
  }
  return ctx;
}

/** The reply-side echo guard for an injected turn: SSE by content-type, else a whole JSON body. */
function echoTransform(contentType, ctx) {
  if (/text\/event-stream/i.test(contentType || "")) return createSseEchoFilter([ctx]);
  const decoder = new TextDecoder("utf-8");
  let all = "";
  return {
    write(chunk) { all += decoder.decode(chunk, { stream: true }); return ""; },
    end() { all += decoder.decode(); return stripJsonEcho(all, [ctx]); },
  };
}

/** The fast/escalate keys the router and the kiosk voice turn share. */
export const VOICE_ROUTE_KEYS = Object.freeze({ fast: FAST_KEY, escalate: ESC_KEY });
/** COMPANION_TOOL_ESCALATION: may a voice turn escalate on tool/action intent at all? (The Bot Builder's ability line asks.) */
export function toolEscalationEnabled() { return TOOL_ESCALATION; }

/**
 * THE voice routing policy (kiosk spec §7.2): the same decision /llm/v1 makes,
 * callable in-process so the kiosk needs no HTTP hop. `messages` is the full
 * OpenAI-style list; `hasTools` says whether the turn advertises any tools.
 * `actionIntent` (the in-process voice turn only; /llm/v1 never sets it): the user
 * asked for an action and the assistant has tools the quick model was not offered,
 * so the quick model could only pretend (queue item 29) — escalate.
 */
export function chooseVoiceRoute(messages, { hasTools = false, actionIntent = false, keys = VOICE_ROUTE_KEYS } = {}) {
  const body = { messages: Array.isArray(messages) ? messages : [], tools: hasTools ? [{}] : [] };
  if (wantsEscalation(body)) return { route: "escalate", reason: "manual", key: keys.escalate };
  // COMPANION_TOOL_ESCALATION=0 turns this off too (the same switch as the tool-intent regex).
  if (actionIntent === true && TOOL_ESCALATION) return { route: "escalate", reason: "action-intent", key: keys.escalate };
  if (wantsToolEscalation(body)) return { route: "escalate", reason: "tool-intent", key: keys.escalate };
  return { route: "fast", reason: null, key: keys.fast };
}

const loggedRoleMisses = new Set();
function logRoleMiss(what, r) {
  const msg = `${what}: ${r?.reason || "unknown"}`;
  if (loggedRoleMisses.has(msg)) return;
  loggedRoleMisses.add(msg);
  console.warn(`[llm-router] role ${msg}; using the consumer default`);
}

/**
 * The voice route's keys for THIS request. Per side: the env var (read now), else the CHOSEN role binding
 * (role:voice for fast, role:everyday for escalate; a seeded or missing binding is not chosen), else the raw
 * constant. A chosen role that resolves to nothing (its model not configured; voice has no fallback chain) falls
 * to the raw constant, never to another role's model. Never throws.
 * → { fast, escalate, fastRole, escalateRole } (a *Role is the role id when the role gave the key, else null)
 */
export async function resolveVoiceKeys(dbc, { env = process.env, resolveRoleFn = resolveRole } = {}) {
  const side = async (envName, roleId, raw) => {
    const e = env?.[envName];
    if (typeof e === "string" && e) return { key: e, role: null };
    try {
      const r = await resolveRoleFn(dbc, `role:${roleId}`, { need: "chat", chosenOnly: true });
      if (r && typeof r.key === "string" && r.key) return { key: r.key, role: roleId };
      if (r?.reason !== "not_chosen") logRoleMiss(roleId, r);
    } catch (err) {
      logRoleMiss(roleId, { reason: err?.message || String(err) });
    }
    return { key: raw, role: null };
  };
  const [f, e] = await Promise.all([
    side("COMPANION_FAST_MODEL", "voice", FAST_KEY),
    side("COMPANION_ESCALATION_MODEL", "everyday", ESC_KEY),
  ]);
  return { fast: f.key, escalate: e.key, fastRole: f.role, escalateRole: e.role };
}

/**
 * A bot's fast voice model key: a raw key comes back unchanged; a `role:` ref resolves by the full walk (an
 * explicit ref, so a seeded binding serves it); a missing key or an unresolvable role gives `fallback`.
 */
export async function resolveBotVoiceKey(dbc, key, { fallback } = {}) {
  if (typeof key !== "string" || !key) return fallback;
  if (!isRoleRef(key)) return key;
  try {
    const r = await resolveRole(dbc, key, { need: "chat" });
    if (r && typeof r.key === "string" && r.key) return r.key;
    logRoleMiss(`bot ${key}`, r);
  } catch (err) {
    logRoleMiss(`bot ${key}`, { reason: err?.message || String(err) });
  }
  return fallback;
}

/** deps.resolveVoiceKeysFn(db()) with the raw constants on any failure (the db client itself included). */
async function voiceKeysFor(deps) {
  try {
    const k = await deps.resolveVoiceKeysFn(db());
    if (k && typeof k.fast === "string" && typeof k.escalate === "string") return k;
  } catch (err) {
    logRoleMiss("voice keys", { reason: err?.message || String(err) });
  }
  return { fast: FAST_KEY, escalate: ESC_KEY, fastRole: null, escalateRole: null };
}

export const resolveVoiceKey = (key) => resolveKey(key);
export const probeVoiceReady = (baseUrl) => defaultProbeReady(baseUrl);

/** Is the fast model answering right now? A 2 s GET on its models list —
 *  same shape as the orchestrator's readiness probe, kept local so the
 *  router's degrade decision has no orchestrator dependency. */
async function defaultProbeReady(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch { return false; }
}

async function handleChat(req, res, deps) {
  const body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body) return res.status(400).json({ error: { message: "invalid JSON body" } });

  const keys = await voiceKeysFor(deps);
  const door = doorTargetFor(req, deps, keys);
  if (door.kind !== "companion") return handleDoor(req, res, "chat/completions", deps, door);
  // door.kind === "companion": fall through to the fast/escalate heuristics, unchanged.

  const decision = chooseVoiceRoute(body.messages, { hasTools: Array.isArray(body.tools) && body.tools.length > 0, keys });
  if (decision.reason === "manual") stripEscalate(body); // only the typed token is stripped
  // After the route decision (it reads the user's own words) and before any degrade note is appended.
  const injected = injectCompanionTurnContext(body, deps.nowFn());
  const escalate = decision.route === "escalate";
  const escReason = decision.reason;
  let key = escalate ? keys.escalate : keys.fast;
  let routeLabel = escalate ? `escalate(${escReason})` : "fast";
  // Only a role-resolved key is labelled, so an unedited instance logs exactly what it did before.
  const roleOf = () => (key === keys.fast ? keys.fastRole : key === keys.escalate ? keys.escalateRole : null);

  // Voice quality: the fast model (Qwen3.5-4B) emits its chain-of-thought as
  // PLAIN text ("Thinking Process: ...") that the avatar would speak aloud, so
  // disable thinking on the fast route. Escalation keeps reasoning (agentic work;
  // its <think> output is separated by the model's template, not spoken).
  if (!escalate && FAST_DISABLE_THINKING) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
  }

  // Warm before forward (N3): bring up a cold / swapped-out local provider (e.g.
  // the on-demand 35B) before forwarding. No-op for non-local / no-bundle
  // providers; never throws. Native (llama.cpp, gateway-supervised) providers
  // warm through this EXACT SAME call as chat.js's SSE route — Item G, Task 10
  // needed no change here: `maybeAcquireLocalProvider` already branches into
  // the native acquire path (proven by
  // tests/gpu-orchestrator-native.test.js's "maybeAcquireLocalProvider does
  // not early-out on a native provider's null bundleId"). What this route
  // does NOT have is chat.js's `provider_warming`/`error` SSE events — this
  // is a raw OpenAI-compat proxy for the companion/glasses LLM loop, which
  // forwards the upstream body verbatim and never authors its own SSE
  // frames, so there is no event channel to put a "warming" notice on. The
  // companion sees a warm-up simply as this await taking longer, same as
  // before this task.
  let [providerId] = splitKey(key);
  const requester = requesterTag(req);
  try {
    await deps.acquireFn(providerId, { requester });
  } catch (err) {
    if (err instanceof ServingClassError) {
      // serving.class refusal (the private engineering notes
      // §3.3): DEGRADE like a box reservation — an escalation falls back to
      // the resident fast model with a note; anything else gets a fast 409
      // (never a retry: this class of model never becomes available on its
      // own, so there is nothing to wait on).
      const fast = escalate ? await deps.resolveKeyFn(keys.fast).catch(() => null) : null;
      if (fast && await deps.probeReadyFn(fast.baseUrl)) {
        key = keys.fast;
        [providerId] = splitKey(key);
        routeLabel = "degraded(serving_class)";
        body.messages = [
          ...(Array.isArray(body.messages) ? body.messages : []),
          { role: "system", content: `Note: ${err.provider || "the larger model"} is a ${err.servingClass} model that only runs in an operator window; answer with what you have.` },
        ];
      } else {
        console.log(`[llm-router] route=refused(serving_class) -> ${key} requester=${requester} class=${err.servingClass}`);
        return res.status(409).json({ error: { code: "serving_class_refused", message: err.message, serving_class: err.servingClass } });
      }
    } else if (!(err instanceof ReservedError)) {
      throw err;
    } else {
      // Box reserved (docs/architecture/box-reservation.md): DEGRADE, never
      // stall and never retry — a retry is exactly what turned one refused
      // start into a second ownership strike on 2026-08-29. An escalation
      // falls back to the resident fast model with a note; anything else (or
      // a cold fast model) gets a fast 503 the client can show or wait on.
      const fast = escalate ? await deps.resolveKeyFn(keys.fast).catch(() => null) : null;
      if (fast && await deps.probeReadyFn(fast.baseUrl)) {
        key = keys.fast;
        [providerId] = splitKey(key);
        routeLabel = "degraded(box_reserved)";
        body.messages = [
          ...(Array.isArray(body.messages) ? body.messages : []),
          { role: "system", content: `Note: the box is reserved (by ${err.owner} until ${err.expires_at || "?"}); the larger model is unavailable, answer with what you have.` },
        ];
      } else {
        const secs = Math.round((Date.parse(err.expires_at || 0) - Date.now()) / 1000);
        const retryAfter = Math.max(60, Number.isFinite(secs) ? secs : 60);
        console.log(`[llm-router] route=refused(box_reserved) -> ${key} requester=${requester} owner=${err.owner}`);
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(503).json({ error: { code: "box_reserved", message: err.message, owner: err.owner, expires_at: err.expires_at, retry_after: retryAfter } });
      }
    }
  }

  let up;
  try {
    up = await deps.resolveKeyFn(key);
  } catch (e) {
    return res.status(502).json({ error: { message: `model routing failed for ${key}: ${e.message}` } });
  }
  // Forward to the chosen upstream, rewriting the model field to its real id.
  body.model = up.model;
  const url = `${up.baseUrl}/chat/completions`;
  const t0 = Date.now();
  const role = roleOf();
  console.log(`[llm-router] route=${routeLabel} -> ${key} (${up.model})${role ? ` role=${role}` : ""} stream=${!!body.stream} requester=${requester}`);

  let upstream;
  try {
    const t = connectTimeout(LLM_CONNECT_TIMEOUT_MS);
    upstream = t.disarm(await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders(up.apiKey) },
      body: JSON.stringify(body),
      signal: t.signal,
    }));
  } catch (e) {
    const msg = isTimeoutError(e)
      ? `upstream connect timeout after ${Math.round(LLM_CONNECT_TIMEOUT_MS / 1000)}s`
      : `upstream ${url} unreachable: ${e.message}`;
    return res.status(502).json({ error: { message: msg } });
  }

  // Mirror status + content-type; stream the body straight through (SSE or JSON).
  res.status(upstream.status);
  res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
  if (!upstream.body) return res.end();
  // Tap the pass-through to meter usage (companion/glasses). Bytes are forwarded
  // unchanged; we keep only a bounded tail because the OpenAI usage block rides
  // the final include_usage SSE frame (or is the whole non-streaming JSON body).
  // An injected companion turn goes through the echo guard (not an error body: that passes as it came); the
  // metering tap then reads the filtered bytes (the usage frame passes the filter untouched).
  let captured = "";
  const CAP = 64 * 1024;
  const tap = (text) => { captured += text; if (captured.length > CAP) captured = captured.slice(-CAP); };
  const xf = injected && upstream.ok ? echoTransform(upstream.headers.get("content-type"), injected) : null;
  try {
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", reject);
      // A client abort destroys the stream with "close", not "error", and res never emits "finish": resolve on
      // close too (as forwardDoor does), or the turn never settles.
      res.on("close", () => { nodeStream.destroy(); resolve(); });
      res.on("finish", resolve);
      if (!xf) {
        nodeStream.on("data", (chunk) => tap(chunk.toString("utf8")));
        nodeStream.pipe(res);
        return;
      }
      nodeStream.on("data", (chunk) => {
        const out = xf.write(chunk);
        if (!out) return;
        tap(out);
        if (!res.write(out)) { nodeStream.pause(); res.once("drain", () => nodeStream.resume()); }
      });
      nodeStream.on("end", () => { const out = xf.end(); if (out) tap(out); res.end(out); });
    });
    // Metering: best-effort, never affects the proxied response.
    if (upstream.ok) {
      try {
        const usage = extractUsageFromOpenAIResponse(captured);
        if (usage) {
          await deps.recordUsageFn({
            tenantId: resolveTenantId(),
            surface: "llm",
            providerId,
            providerType: null,
            modelId: up.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
          });
        }
      } catch (meterErr) {
        console.warn(`[metering] /llm usage record failed: ${meterErr.message}`);
      }
    }
  } catch (e) {
    console.error(`[llm-router] stream error: ${e.message}`);
    if (!res.writableEnded) res.end();
  } finally {
    console.log(`[llm-router] done ${key} in ${Date.now() - t0}ms`);
  }
}

async function handleModels(res, deps) {
  const keys = await voiceKeysFor(deps);
  const out = [];
  for (const key of [keys.fast, keys.escalate]) {
    try {
      const up = await deps.resolveKeyFn(key);
      out.push({ id: up.model, object: "model", owned_by: "crow", created: 0 });
    } catch { /* skip unresolved */ }
  }
  try {
    for (const m of listDoorModels((deps.loadProvidersFn() || {}).providers || {})) out.push({ id: m.id, object: "model", owned_by: "crow", created: 0 });
  } catch { /* the companion ids alone are still a valid listing */ }
  res.json({ object: "list", data: out });
}

/**
 * Build the LLM-router express Router. Mount in index.js with `app.use(...)`,
 * WITHOUT dashboardAuth (see the security note at the top of this file).
 *
 * @returns {import('express').Router}
 */
export default function llmRouterRouter(opts = {}) {
  // Seams (tests): acquireFn/resolveKeyFn/probeReadyFn/warmFn default to the
  // real orchestrator + providers table.
  const deps = {
    acquireFn: maybeAcquireLocalProvider,
    resolveKeyFn: resolveKey,
    probeReadyFn: defaultProbeReady,
    warmFn: warmProviderByName,
    loadProvidersFn: loadProviders,
    remoteAddressFn: (req) => req.socket?.remoteAddress || "",
    doorAuthFn: defaultDoorAuth,
    nowFn: Date.now,
    recordUsageFn: (event) => recordUsageEvent(db(), event),
    // The voice keys per request (m6): a seam, so router tests never need the db() singleton.
    resolveVoiceKeysFn: (dbc) => resolveVoiceKeys(dbc),
    // The cloud door (/llm/c). lookupFn/allowAddressFn are tests-only seams.
    cloudTokenAuthFn: defaultCloudTokenAuth,
    cloudProvidersFn: defaultCloudProviders,
    consentFn: defaultCloudConsent,
    tenantIdFn: resolveTenantId,
    ...CLOUD_DOOR_DEFAULTS,
    ...opts,
  };
  const cloudDoor = createCloudDoor(deps);
  const router = express.Router();
  // Defense in depth (review C4): the global rejectFunneledMiddleware can be
  // bypassed by CROW_DASHBOARD_PUBLIC=true; /llm never is.
  router.use("/llm", (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: { code: "FUNNEL_REFUSED", message: "/llm is never reachable through Funnel" } });
    next();
  });
  // Casey decision 2026-10-02: every device that uses the voice companion is
  // on Tailscale, and r4 reaches the gateway over loopback, so the WHOLE
  // model surface (/llm/v1 — the companion path included — and the
  // provider-scoped door /llm/p) gets the door's source check: loopback or
  // the tailnet, or a valid bearer. LAN and container-bridge sources get 403
  // before anything is acquired or forwarded. /llm and /llm/health (probes)
  // stay open; /llm/acquire has its own identical check below.
  const sourceGate = async (req, res, next) => {
    try {
      if (await doorCallerAllowed(req, deps)) return next();
    } catch { /* fall through to the refusal */ }
    res.status(403).json({ error: { code: "DOOR_SOURCE_REFUSED", message: "/llm is limited to loopback and the tailnet, or a bearer token" } });
  };
  router.use("/llm/v1", sourceGate);
  router.use("/llm/p", sourceGate);
  // The cloud door's own gate: loopback socket, no forwarding or Tailscale
  // header, the cloud-door token. Before the body parser, so a refused caller's
  // body is never parsed.
  router.use("/llm/c", (req, res, next) => {
    cloudDoor.gate(req, res, next).catch(() => {
      if (!res.headersSent) res.status(403).json({ error: { code: "CLOUD_SOURCE_REFUSED", message: "the cloud door refused this request" } });
    });
  });
  // Route-scoped 10mb JSON limit: the global parser is 1mb and a multi-turn
  // companion/glasses transcript (with tool history + base64 image parts) can
  // exceed that and 413.
  router.use("/llm", express.json({ limit: "10mb" }));
  router.get("/llm/v1/models", (req, res) => handleModels(res, deps));
  router.post("/llm/v1/chat/completions", (req, res) => {
    handleChat(req, res, deps).catch((err) => {
      console.error(`[llm-router] chat handler failed: ${err?.stack || err}`);
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      res.status(502).json({ error: { code: "router_error", message: `model routing failed: ${err?.message || err}` } });
    });
  });
  // /llm/acquire starts (and evicts) any local model. Its only caller, the
  // pi-bots host, comes over loopback, so it gets the door's source check too
  // (re-review hardening). Register this BEFORE the existing /llm/acquire
  // handler so it runs first.
  router.post("/llm/acquire", async (req, res, next) => {
    if (await doorCallerAllowed(req, deps)) return next();
    res.status(403).json({ ok: false, error: "DOOR_SOURCE_REFUSED", message: "/llm/acquire is limited to loopback and the tailnet, or a bearer token" });
  });

  // Provider-scoped door: the path names the provider (native rows, alias rows
  // such as crow-local, and pi's managed entries point here).
  for (const op of ["chat/completions", "completions", "embeddings", "rerank"]) {
    router.post(`/llm/p/:provider/v1/${op}`, (req, res) => {
      voiceKeysFor(deps)
        .then((keys) => handleDoor(req, res, op, deps, doorTargetFor(req, deps, keys)))
        .catch((err) => {
          if (!res.headersSent) res.status(502).json({ error: { code: "router_error", message: err.message } });
        });
    });
  }
  router.post("/llm/c/:provider/v1/*", (req, res) => {
    cloudDoor.handle(req, res).catch((err) => {
      console.error(`[llm-router] cloud door failed: ${err?.message || err}`);
      if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
      res.status(502).json({ error: { code: "router_error", message: "the cloud door failed" } });
    });
  });
  // Nothing else under /llm/c is served, and nothing falls through to later routes.
  router.all("/llm/c/*", (req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "the cloud door serves POST /llm/c/<provider>/v1/<op> only" } }));
  router.get("/llm/p/:provider/v1/models", (req, res) => {
    const p = ((deps.loadProvidersFn() || {}).providers || {})[req.params.provider];
    const listed = p ? listDoorModels({ [req.params.provider]: p }) : [];
    if (!listed.length) return res.status(404).json({ error: { code: "UNKNOWN_PROVIDER", message: `no forwardable provider "${req.params.provider}"` } });
    res.json({ object: "list", data: listed.map((m) => ({ id: m.id.slice(req.params.provider.length + 1), object: "model", owned_by: "crow", created: 0 })) });
  });
  for (const op of ["completions", "embeddings", "rerank"]) {
    router.post(`/llm/v1/${op}`, (req, res) => {
      voiceKeysFor(deps).then((keys) => {
        const door = doorTargetFor(req, deps, keys);
        if (door.kind === "companion") {
          return res.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: `no forwardable local model "${req.body?.model ?? ""}" for /${op}` } });
        }
        return handleDoor(req, res, op, deps, door);
      }).catch((err) => {
        if (!res.headersSent) res.status(502).json({ error: { code: "router_error", message: err.message } });
      });
    });
  }

  // POST /llm/acquire { provider } — warm a local model bundle and wait until it's
  // ready. The gateway chat path warms inline before a turn; this gives the same
  // capability to the pi-bots host (background jobs + bridge) which runs in a
  // SEPARATE process and must not run its own gpu-orchestrator. Resolves a
  // bundle-less alias (e.g. crow-local) to its bundled sibling. Loopback/tailnet
  // only (never funnel-exposed), same as the rest of /llm.
  router.post("/llm/acquire", async (req, res) => {
    const provider = req.body && (req.body.provider || req.body.providerId);
    if (!provider) return res.status(400).json({ ok: false, error: "provider required" });
    try {
      const warmed = await deps.warmFn(provider, { requester: requesterTag(req) });
      res.json({ ok: warmed !== false, warmed, provider });
    } catch (err) {
      if (err instanceof ReservedError) {
        return res.status(409).json({ ok: false, error: "box_reserved", owner: err.owner, expires_at: err.expires_at, message: err.message });
      }
      if (err instanceof ServingClassError) {
        return res.status(409).json({ ok: false, error: "serving_class_refused", serving_class: err.servingClass, message: err.message });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  // Probe-friendly health (matches the old proxy's GET / and /health).
  router.get("/llm", (req, res) => res.json({ ok: true }));
  router.get("/llm/health", (req, res) => res.json({ ok: true }));
  return router;
}
