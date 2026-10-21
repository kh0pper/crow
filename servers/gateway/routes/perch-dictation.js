/**
 * Perch composer dictation — the one-shot speech-to-text route behind the
 * composer's "Dictate" button (perch-hub/dictation.js is the client).
 *
 *   GET  /dashboard/perch-api/dictation   capability probe
 *   POST /dashboard/perch-api/dictation   raw audio body → { text, language, duration }
 *
 * MOUNT — inside dashboard/index.js, right after perchInteractiveApiRouter:
 * dashboardAuth and the real csrfMiddleware apply there, and Funnel is refused
 * upstream (rejectFunneledMiddleware, then isAllowedNetwork). The router also
 * installs dashboardAuth on its own prefix (the bot-board-api idiom), so it is
 * closed wherever it is mounted. Like every dashboard route,
 * CROW_DASHBOARD_PUBLIC=true / GATEWAY_FUNNEL_PUBLIC_PREFIXES would expose it.
 *
 * WHICH SPEECH-TO-TEXT: exactly the instance's configured default profile
 * (ai/stt/index.js, imported read-only), resolved again on EVERY request —
 * cloud providers included. There is no fallback: when the configured profile
 * is unusable, dictation is unavailable or fails; another profile is never
 * tried, and a profile id is never taken from the client. The probe hands out
 * an opaque profileTag; a POST whose freshly resolved profile has a different
 * tag gets 409 profile_changed before any upstream request, so audio never goes
 * somewhere the operator was not shown ("Transcribed by …" for a cloud one).
 *
 * MODEL: for faster-whisper, a turbo model only when the server's /api/ps
 * already lists it, else large-v3 when listed, else the profile's own model.
 * faster-whisper-server 0.5.0 downloads and loads any unknown model id on
 * request, so dictation never names one /api/ps did not list.
 *
 * LOCKS: a local profile is one dictation at a time for this whole gateway
 * process (the whisper box is shared and same-model calls serialize); a cloud
 * profile is one at a time per dashboard session. A local job is NOT aborted
 * when the client goes away (the sync whisper job would keep running anyway):
 * the lock stays held until it settles, so ✕ + Retry cannot stack a second
 * full-length job. A hard ceiling keeps the lock from ever leaking.
 *
 * PRIVACY: the gateway never writes or logs audio or transcript text. The only
 * log line is bytes/elapsed/status/cloud. The 1 MB cap keeps a local whisper
 * container's multipart parser in memory (Starlette spools over 1 MiB). For a
 * cloud profile the clip goes to that provider under its own retention terms.
 */
import { Router } from "express";
import express from "express";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createDbClient } from "../../db.js";
import { getDefaultSttProfile, createSttAdapter, PROVIDER_INFO } from "../ai/stt/index.js";
import { fixedWindowLimit } from "../middleware/rate-limit.js";
import { jsonError } from "./_error.js";

const P = "/dashboard/perch-api/dictation";

/** The adapters' own fallbacks for an empty baseUrl (ai/stt/adapters/*.js).
 *  Repeated here because the adapters do not export them and this lane does
 *  not edit ai/stt: the EFFECTIVE url decides local vs cloud. */
const ADAPTER_DEFAULT_URL = {
  fasterwhisper: "http://localhost:8000/v1",
  whispercpp: "http://localhost:9000",
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
  deepgram: "https://api.deepgram.com",
};

export const TURBO_MODEL_IDS = [
  "deepdml/faster-whisper-large-v3-turbo-ct2",
  "dropbox-dash/faster-whisper-large-v3-turbo",
];
export const LARGE_V3 = "Systran/faster-whisper-large-v3";

/** Upload types MediaRecorder actually emits, → the filename extension. */
const AUDIO_TYPES = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/x-m4a": "m4a" };
export const MAX_BYTES = 1_000_000;

const PROBE_TTL_OK_MS = 30_000;
const PROBE_TTL_BAD_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1_500;
const CEILING_MS = 10 * 60_000;

function ipv4Octets(h) {
  if (isIP(h) !== 4) return null;
  return h.split(".").map(Number);
}

/** Strict "is this speech-to-text endpoint on this machine or its private
 *  network": hostname exactly `localhost`, 127/8, ::1, RFC1918, 100.64/10
 *  (tailnet CGNAT) or fc00::/7. CROW_ALLOWED_IPS is never consulted (it may
 *  hold public addresses). Decides the hint, the lock and the abort rule —
 *  not availability. */
export function isLocalSttUrl(url) {
  if (!url || typeof url !== "string") return false;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost") return true;
  const o = ipv4Octets(host);
  if (o) {
    if (o[0] === 127 || o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  if (isIP(host) === 6) {
    if (host === "::1") return true;
    const first = parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00;
  }
  return false;
}

/** The model dictation asks for. See the header's MODEL paragraph. */
export function pickDictationModel(profile, loadedModels) {
  const own = (profile && profile.defaultModel) || "";
  if (!profile || profile.provider !== "fasterwhisper" || !Array.isArray(loadedModels)) return own;
  for (const id of TURBO_MODEL_IDS) if (loadedModels.includes(id)) return id;
  if (loadedModels.includes(LARGE_V3)) return LARGE_V3;
  return own;
}

export function profileTagFor(provider, effectiveUrl, model) {
  return createHash("sha256").update(`${provider}|${effectiveUrl}|${model}`).digest("hex").slice(0, 16);
}

/** Magic bytes must match the declared container. */
export function sniffMatches(baseType, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (baseType === "audio/webm") return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (baseType === "audio/ogg") return buf.subarray(0, 4).toString("latin1") === "OggS";
  if (baseType === "audio/mp4" || baseType === "audio/x-m4a") return buf.subarray(4, 8).toString("latin1") === "ftyp";
  return false;
}

function effectiveUrlOf(profile) {
  const raw = profile.baseUrl || ADAPTER_DEFAULT_URL[profile.provider] || "";
  return String(raw).replace(/\/+$/, "");
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function defaultHealthCheck(origin, fetchImpl) {
  try {
    await fetchImpl(origin + "/health", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return true;                                     // any HTTP status: the server is there
  } catch { return false; }
}

async function defaultLoadedModels(origin, fetchImpl) {
  try {
    const r = await fetchImpl(origin + "/api/ps", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.models) ? j.models : null);
    if (!list) return null;
    return list.map((m) => (typeof m === "string" ? m : (m && (m.id || m.model || m.name)) || "")).filter(Boolean);
  } catch { return null; }
}

const sha256 = (s) => createHash("sha256").update(String(s || "")).digest("hex");

/**
 * @param {Function} dashboardAuth the session gate (same middleware as the rest of /dashboard)
 * @param {object} [opts] test seams
 * @param {()=>number} [opts.now]               injectable clock (probe cache)
 * @param {(maxSeconds:number)=>number} [opts.timeoutMs]  T, default 30 s + 2 × maxSeconds
 * @param {number} [opts.ceilingMs]             hard upstream ceiling for a local job (10 min)
 * @param {(url:string)=>boolean} [opts.isLocalUrl]
 * @param {(origin:string)=>Promise<boolean>} [opts.healthCheck]
 * @param {(origin:string)=>Promise<string[]|null>} [opts.loadedModels]
 * @param {(line:string)=>void} [opts.log]
 * @param {()=>object} [opts.dbFactory]
 */
export default function perchDictationRouter(dashboardAuth, opts = {}) {
  const now = opts.now || Date.now;
  const timeoutMs = opts.timeoutMs || ((maxSeconds) => 30_000 + 2 * maxSeconds * 1000);
  const ceilingMs = opts.ceilingMs || CEILING_MS;
  const isLocalUrl = opts.isLocalUrl || isLocalSttUrl;
  const fetchImpl = (...a) => fetch(...a);
  const healthCheck = opts.healthCheck || ((origin) => defaultHealthCheck(origin, fetchImpl));
  const loadedModels = opts.loadedModels || ((origin) => defaultLoadedModels(origin, fetchImpl));
  const log = opts.log || ((line) => console.log(line));
  const dbFactory = opts.dbFactory || (() => createDbClient());

  const router = Router();
  router.use(P, dashboardAuth);

  /** tag → { at, ttl, reachable, loaded } */
  const probeCache = new Map();
  let localBusy = false;                 // process-wide: one local dictation at a time
  const cloudBusy = new Set();           // sha256(session) of in-flight cloud dictations

  const limiter = fixedWindowLimit({
    max: 10, windowMs: 60_000,
    keyGenerator: (req) => sha256(req.dashboardSession),
    message: { error: "too_many" },
  });

  /** The configured default profile, resolved fresh, plus everything the
   *  route needs to know about it. Never returns a different profile. */
  async function resolve() {
    let profile;
    const db = dbFactory();
    try { profile = await getDefaultSttProfile(db, { includeKeys: true }); }
    finally { try { db.close(); } catch {} }
    if (!profile) return { usable: false, reason: "no_profile" };
    let adapter;
    try { ({ adapter } = await createSttAdapter(profile)); }
    catch (err) {
      return { usable: false, reason: err && err.code === "missing_key" ? "missing_key" : "unknown_provider" };
    }
    const effectiveUrl = effectiveUrlOf(profile);
    const cloud = !isLocalUrl(effectiveUrl);
    const tag = profileTagFor(profile.provider, effectiveUrl, profile.defaultModel || "");

    let entry = probeCache.get(tag);
    if (!entry || now() - entry.at >= entry.ttl) {
      let reachable = true, loaded = null;
      const origin = originOf(effectiveUrl);
      // A cloud endpoint is never contacted by the probe: no cost, and nothing
      // leaves the box until the operator records.
      if (!cloud) {
        reachable = origin ? await healthCheck(origin) : false;
        if (reachable && profile.provider === "fasterwhisper") loaded = await loadedModels(origin);
      }
      entry = { at: now(), ttl: reachable ? PROBE_TTL_OK_MS : PROBE_TTL_BAD_MS, reachable, loaded };
      probeCache.set(tag, entry);
      for (const [k, v] of probeCache) if (now() - v.at >= v.ttl && k !== tag) probeCache.delete(k);
    }
    if (!entry.reachable) return { usable: false, reason: "unreachable", tag, cloud };

    const model = pickDictationModel(profile, entry.loaded);
    let maxSeconds = 60;
    if (cloud) maxSeconds = 120;
    else if (profile.provider === "fasterwhisper" && TURBO_MODEL_IDS.includes(model)) maxSeconds = 120;
    return {
      usable: true, profile, adapter, cloud, tag, model, maxSeconds,
      providerName: (PROVIDER_INFO[profile.provider] && PROVIDER_INFO[profile.provider].name) || profile.provider,
    };
  }

  router.get(P, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const r = await resolve();
      if (!r.usable) return res.json({ available: false, reason: r.reason, maxSeconds: 60, cloud: !!r.cloud });
      const out = { available: true, maxSeconds: r.maxSeconds, cloud: r.cloud, profileTag: r.tag };
      if (r.cloud) out.provider = r.providerName;
      return res.json(out);
    } catch {
      return res.json({ available: false, reason: "unreachable", maxSeconds: 60, cloud: false });
    }
  });

  /* express.raw, with its errors turned into JSON: the gateway has no error
     middleware, so a bare next(err) would land in finalhandler's HTML (with a
     stack trace outside production). Taken BEFORE any lock (review C2). */
  const rawParser = express.raw({ type: () => true, limit: MAX_BYTES, inflate: false });
  function parseBody(req, res, next) {
    rawParser(req, res, (err) => {
      if (!err) return next();
      if (res.headersSent || res.destroyed) return;
      if (err.type === "entity.too.large") return jsonError(res, 413, "too_large");
      if (err.type === "encoding.unsupported") return jsonError(res, 415, "unsupported_encoding");
      return jsonError(res, 400, "bad_body");
    });
  }

  function checkType(req, res, next) {
    if (req.headers["content-encoding"]) return jsonError(res, 415, "unsupported_encoding");
    const base = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES[base]) return jsonError(res, 415, "unsupported_type");
    req.dictationType = base;
    next();
  }

  router.post(P, (req, res, next) => limiter(req, res, next), checkType, parseBody, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const started = now();
    const buf = req.body;
    const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
    let cloudFlag = false;
    const finish = (status, payload) => {
      log(`[perch-dictation] bytes=${bytes} elapsed=${Math.max(0, now() - started)}ms status=${status} cloud=${cloudFlag}`);
      if (res.headersSent || res.destroyed || res.writableEnded) return;
      res.status(status).json(payload);
    };

    if (!bytes) return finish(400, { error: "empty" });
    const type = req.dictationType;
    if (!sniffMatches(type, buf)) return finish(415, { error: "type_mismatch" });

    let r;
    try { r = await resolve(); } catch { return finish(503, { error: "unreachable" }); }
    if (!r.usable) return finish(503, { error: r.reason });
    cloudFlag = r.cloud;
    if (String(req.headers["x-crow-dictation-profile"] || "") !== r.tag) return finish(409, { error: "profile_changed" });

    // A client that left while the profile resolved: its 'close' has already
    // fired (the listener below would miss it), so send nothing anywhere.
    if (res.destroyed || (req.socket && req.socket.destroyed)) return finish(400, { error: "client_gone" });

    // Only now take the lock (review C2): every earlier exit is lock-free.
    const sessKey = sha256(req.dashboardSession);
    if (r.cloud) {
      if (cloudBusy.has(sessKey)) return finish(409, { error: "dictation_busy" });
      cloudBusy.add(sessKey);
    } else {
      if (localBusy) return finish(409, { error: "dictation_busy" });
      localBusy = true;
    }
    const release = () => { if (r.cloud) cloudBusy.delete(sessKey); else localBusy = false; };

    const T = timeoutMs(r.maxSeconds);
    const ac = new AbortController();
    // res, never req: req emits 'close' as soon as express.raw has read the
    // body (review C1), which would abort every transcription at once.
    res.on("close", () => {
      if (res.writableEnded) return;
      if (r.cloud) ac.abort();       // a local job runs on regardless; its result is dropped
    });
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(r.cloud ? T : Math.max(T, ceilingMs))]);

    const job = (async () => {
      try {
        return await r.adapter.transcribe(buf, {
          filename: "dictation." + AUDIO_TYPES[type],
          contentType: type,
          model: r.model || undefined,
          language: r.profile.language || undefined,
          signal,
        });
      } finally { release(); }
    })();
    job.catch(() => {});

    const TIMEOUT = Symbol("timeout");
    let timer;
    const timeout = new Promise((resolveT) => { timer = setTimeout(() => resolveT(TIMEOUT), T); });
    const out = await Promise.race([job.then((v) => ({ v }), (e) => ({ e })), timeout]);
    clearTimeout(timer);

    if (out === TIMEOUT) return finish(504, { error: "stt_timeout" });
    if (out.e) {
      const name = out.e && out.e.name;
      if (name === "TimeoutError" || (name === "AbortError" && !ac.signal.aborted)) return finish(504, { error: "stt_timeout" });
      return finish(502, { error: "stt_failed" });
    }
    const v = out.v || {};
    return finish(200, {
      text: typeof v.text === "string" ? v.text.trim() : "",
      language: v.language || null,
      duration: typeof v.duration === "number" ? v.duration : null,
    });
  });

  router._dictation = { limiter };      // test introspection only
  return router;
}
