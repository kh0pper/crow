#!/usr/bin/env node
/**
 * Crow Companion — model-routing proxy
 *
 * A tiny loopback OpenAI-compatible shim that the AI Companion (Open-LLM-VTuber)
 * points its LLM `base_url` at. It does ONE job: pick which local model answers
 * each turn, then forward the request verbatim and stream the response straight
 * back. OLVV keeps running its own tool loop, so MCP tools + the client-side
 * crow_wm window/media control + token streaming all keep working — the proxy
 * only chooses the upstream.
 *
 * Routing:
 *   - default            → fast model   (crow-voice / qwen3.5-4b, :8011)
 *   - leading "!escalate" → escalation model (crow-chat / qwen3.6-35b-a3b, :8003)
 *     The token is stripped from the message before forwarding so it never
 *     reaches the model. (Vision-bearing turns should also escalate, since the
 *     fast model is text-only — see ESCALATE_HINTS below.)
 *
 * NOT a pi gateway: it never spawns pi, never calls handleInbound. It is global
 * (no per-device scoping) because OLVV's base_url is fixed per container; the
 * model pair is shared across all devices on one companion container.
 *
 * Env:
 *   COMPANION_PROXY_PORT   (default 11435)         loopback port
 *   COMPANION_FAST_MODEL   (default crow-voice/qwen3.5-4b)
 *   COMPANION_ESCALATION_MODEL (default crow-chat/qwen3.6-35b-a3b)
 *   CROW_DB_PATH           (default ~/.crow/data/crow.db)
 */
import http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";
import { resolveProviderConfig } from "../../servers/gateway/ai/resolve-profile.js";

const PORT = parseInt(process.env.COMPANION_PROXY_PORT || "11435", 10);
const HOST = "127.0.0.1"; // loopback only — never exposed (network-exposure invariant)
const DB_PATH = process.env.CROW_DB_PATH || `${process.env.HOME}/.crow/data/crow.db`;

const FAST_KEY = process.env.COMPANION_FAST_MODEL || "crow-voice/qwen3.5-4b";
const ESC_KEY = process.env.COMPANION_ESCALATION_MODEL || "crow-chat/qwen3.6-35b-a3b";
// Disable visible chain-of-thought on the fast voice route (set "0" to keep it).
const FAST_DISABLE_THINKING = (process.env.COMPANION_FAST_DISABLE_THINKING || "1") !== "0";

// Leading tokens that force escalation to the big model. Stripped before forward.
const ESCALATE_RE = /^\s*!escalate\b[:,]?\s*/i;

function splitKey(key) {
  const i = key.indexOf("/");
  return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}

let _db = null;
function db() {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
    _db.pragma("busy_timeout = 5000");
  }
  return _db;
}

// Resolve a "provider/model" key → { baseUrl, model, apiKey }. Cached briefly so
// we don't hit the DB every request, but short enough to pick up registry edits.
const _cache = new Map(); // key -> { at, val }
const CACHE_MS = 15000;
async function resolveKey(key) {
  const hit = _cache.get(key);
  const now = nowMs();
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

// new Date()/Date.now() are fine in a long-lived service (no workflow journal here)
function nowMs() {
  return Date.now();
}

function authHeaders(apiKey) {
  return apiKey && apiKey !== "none" ? { Authorization: `Bearer ${apiKey}` } : {};
}

function wantsEscalation(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      const c = msgs[i].content;
      const text = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((p) => (typeof p === "string" ? p : p?.text || "")).join(" ")
          : "";
      return ESCALATE_RE.test(text);
    }
  }
  return false;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": buf.length });
  res.end(buf);
}

async function handleChat(req, res, raw) {
  let body;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: { message: "invalid JSON body" } });
  }

  const escalate = wantsEscalation(body);
  if (escalate) stripEscalate(body);
  const key = escalate ? ESC_KEY : FAST_KEY;

  // Voice quality: the fast model (Qwen3.5-4B) emits its chain-of-thought as
  // PLAIN text ("Thinking Process: ...") that the avatar would speak aloud, so
  // disable thinking on the fast route. Escalation keeps reasoning (agentic work;
  // its <think> output is separated by the model's template, not spoken).
  if (!escalate && FAST_DISABLE_THINKING) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
  }

  let up;
  try {
    up = await resolveKey(key);
  } catch (e) {
    return sendJson(res, 502, { error: { message: `model routing failed for ${key}: ${e.message}` } });
  }
  // Forward to the chosen upstream, rewriting the model field to its real id.
  body.model = up.model;
  const url = `${up.baseUrl}/chat/completions`;
  const t0 = nowMs();
  console.log(`[companion-proxy] route=${escalate ? "escalate" : "fast"} -> ${key} (${up.model}) stream=${!!body.stream}`);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders(up.apiKey) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return sendJson(res, 502, { error: { message: `upstream ${url} unreachable: ${e.message}` } });
  }

  // Mirror status + content-type; stream the body straight through (SSE or JSON).
  const headers = { "Content-Type": upstream.headers.get("content-type") || "application/json" };
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", reject);
      res.on("close", () => nodeStream.destroy());
      nodeStream.pipe(res);
      res.on("finish", resolve);
    });
  } catch (e) {
    console.error(`[companion-proxy] stream error: ${e.message}`);
    if (!res.writableEnded) res.end();
  } finally {
    console.log(`[companion-proxy] done ${key} in ${nowMs() - t0}ms`);
  }
}

async function handleModels(res) {
  // Advertise both ids so OLVV's startup/model-selector probe never 404s.
  const out = [];
  for (const key of [FAST_KEY, ESC_KEY]) {
    try {
      const up = await resolveKey(key);
      out.push({ id: up.model, object: "model", owned_by: "crow", created: 0 });
    } catch {
      /* skip unresolved */
    }
  }
  sendJson(res, 200, { object: "list", data: out });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";
  try {
    if (req.method === "GET" && /\/v1\/models\/?$/.test(url)) return await handleModels(res);
    if (req.method === "POST" && /\/v1\/chat\/completions\/?$/.test(url)) {
      const raw = await readBody(req);
      return await handleChat(req, res, raw);
    }
    if (req.method === "GET" && (url === "/" || url === "/health")) return sendJson(res, 200, { ok: true });
    sendJson(res, 404, { error: { message: `unsupported path ${req.method} ${url}` } });
  } catch (e) {
    console.error(`[companion-proxy] handler error: ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else if (!res.writableEnded) res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[companion-proxy] listening on http://${HOST}:${PORT}/v1  fast=${FAST_KEY}  escalate=${ESC_KEY}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[companion-proxy] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
