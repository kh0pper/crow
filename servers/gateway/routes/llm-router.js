/**
 * Gateway LLM-router route — folds the standalone companion model-proxy
 * (scripts/companion/model-proxy.mjs, formerly companion-model-proxy.service on
 * loopback :11435) INTO the gateway as an OpenAI-compatible route.
 *
 *   POST /llm/v1/chat/completions   pick fast vs escalate, forward + stream
 *   GET  /llm/v1/models             advertise both model ids (probe-safe)
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
 * password/network auth here would 403 every legitimate turn. This route is
 * instead protected by (1) the global rejectFunneledMiddleware (it is NOT in
 * PUBLIC_FUNNEL_PREFIXES, so any Tailscale-Funnel request 403s — asserted in
 * tests/auth-network.test.js) and (2) binding/exposure: the gateway is only
 * reachable on the tailnet + loopback, never funneled. Mirrors
 * routes/companion-proxy.js. NOT a pi gateway: it never spawns pi.
 */

import express from "express";
import { Readable } from "node:stream";
import { createDbClient } from "../../db.js";
import { resolveProviderConfig } from "../ai/resolve-profile.js";
import { maybeAcquireLocalProvider, warmProviderByName } from "../gpu-orchestrator.js";
import { connectTimeout, isTimeoutError, LLM_CONNECT_TIMEOUT_MS } from "../../shared/http-timeout.js";
import { extractUsageFromOpenAIResponse, recordUsageEvent } from "../../shared/metering.js";
import { resolveTenantId } from "../../shared/tenancy.js";

const FAST_KEY = process.env.COMPANION_FAST_MODEL || "crow-voice/qwen3.5-4b";
const ESC_KEY = process.env.COMPANION_ESCALATION_MODEL || "crow-chat/qwen3.6-35b-a3b";
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

async function handleChat(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : null;
  if (!body) return res.status(400).json({ error: { message: "invalid JSON body" } });

  const manualEsc = wantsEscalation(body);
  if (manualEsc) stripEscalate(body); // only the typed token is stripped
  const toolEsc = !manualEsc && wantsToolEscalation(body);
  const escalate = manualEsc || toolEsc;
  const escReason = manualEsc ? "manual" : toolEsc ? "tool-intent" : null;
  const key = escalate ? ESC_KEY : FAST_KEY;

  // Voice quality: the fast model (Qwen3.5-4B) emits its chain-of-thought as
  // PLAIN text ("Thinking Process: ...") that the avatar would speak aloud, so
  // disable thinking on the fast route. Escalation keeps reasoning (agentic work;
  // its <think> output is separated by the model's template, not spoken).
  if (!escalate && FAST_DISABLE_THINKING) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
  }

  // Warm before forward (N3): bring up a cold / swapped-out local provider (e.g.
  // the on-demand 35B) before forwarding. No-op for non-local / no-bundle
  // providers; never throws.
  const [providerId] = splitKey(key);
  await maybeAcquireLocalProvider(providerId);

  let up;
  try {
    up = await resolveKey(key);
  } catch (e) {
    return res.status(502).json({ error: { message: `model routing failed for ${key}: ${e.message}` } });
  }
  // Forward to the chosen upstream, rewriting the model field to its real id.
  body.model = up.model;
  const url = `${up.baseUrl}/chat/completions`;
  const t0 = Date.now();
  console.log(`[llm-router] route=${escalate ? `escalate(${escReason})` : "fast"} -> ${key} (${up.model}) stream=${!!body.stream}`);

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
  let captured = "";
  const CAP = 64 * 1024;
  try {
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", reject);
      nodeStream.on("data", (chunk) => {
        captured += chunk.toString("utf8");
        if (captured.length > CAP) captured = captured.slice(-CAP);
      });
      res.on("close", () => nodeStream.destroy());
      nodeStream.pipe(res);
      res.on("finish", resolve);
    });
    // Metering: best-effort, never affects the proxied response.
    if (upstream.ok) {
      try {
        const usage = extractUsageFromOpenAIResponse(captured);
        if (usage) {
          await recordUsageEvent(db(), {
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

async function handleModels(res) {
  // Advertise both ids so a client's startup/model-selector probe never 404s.
  const out = [];
  for (const key of [FAST_KEY, ESC_KEY]) {
    try {
      const up = await resolveKey(key);
      out.push({ id: up.model, object: "model", owned_by: "crow", created: 0 });
    } catch {
      /* skip unresolved */
    }
  }
  res.json({ object: "list", data: out });
}

/**
 * Build the LLM-router express Router. Mount in index.js with `app.use(...)`,
 * WITHOUT dashboardAuth (see the security note at the top of this file).
 *
 * @returns {import('express').Router}
 */
export default function llmRouterRouter() {
  const router = express.Router();
  // Route-scoped 10mb JSON limit: the global parser is 1mb and a multi-turn
  // companion/glasses transcript (with tool history + base64 image parts) can
  // exceed that and 413.
  router.use("/llm", express.json({ limit: "10mb" }));
  router.get("/llm/v1/models", (req, res) => handleModels(res));
  router.post("/llm/v1/chat/completions", (req, res) => handleChat(req, res));
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
      const warmed = await warmProviderByName(provider);
      res.json({ ok: warmed !== false, warmed, provider });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  // Probe-friendly health (matches the old proxy's GET / and /health).
  router.get("/llm", (req, res) => res.json({ ok: true }));
  router.get("/llm/health", (req, res) => res.json({ ok: true }));
  return router;
}
