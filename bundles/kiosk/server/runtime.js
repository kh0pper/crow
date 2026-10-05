/**
 * Kiosk runtime: routes + WS upgrade + announce/show. Every gateway/framework
 * dependency is injected (Router/json from express, WebSocketServer from ws,
 * isAllowedNetwork, csrfMiddleware, the db, the device store, the voice turn),
 * so this file imports no bare package and runs in tests on fakes.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createPairingStore } from "./pairing.js";
import { createSessionHub } from "./session.js";
import { createMetricsStore } from "./metrics.js";
import { createWmStore, createWmTool, matchWmFastPath, kioskPromptSuffix, kioskTurnContext, contentBlocks, wantsNewDisplay } from "./wm.js";
import { createDisplayTools, cardUpdate } from "./display-tools.js";
import { matchSpoken } from "./tiers.js";
import { displayPromptSuffix, displayTurnContext } from "./prompt.js";
import { ensureKioskSttProfile, pickKioskTtsProfile, kioskSttModel } from "./profiles.js";
import { resolveSessionBot, sameOriginUpgrade, sessionDisplayId, SESSION_BOT_SETTING } from "./session-display.js";
import { STRINGS } from "./strings.js";
import { createBotFit } from "./fit.js";
import { kioskNowContext, matchClockFastPath } from "./clock.js";
import { wantsMemory } from "./memory-intent.js";

export const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "media-src 'self' blob:", "connect-src 'self' ws://127.0.0.1:8770", "frame-src https://www.youtube-nocookie.com",
  "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");
/**
 * Session mode (the dashboard's Talk to Crow overlay): the same page at
 * /display/session for a user who is already logged in to the dashboard. The
 * only CSP difference is that the dashboard itself (same origin) may frame it.
 */
export const SESSION_PAGE_PATH = "/display/session";
export const SESSION_WS_PATH = "/api/kiosk/session/dashboard";
export const SESSION_PAGE_CSP = PAGE_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
/** How long a closed session display keeps its windows/timers/conversation (a phone's network blip reconnects well inside it). */
export const SESSION_DISPLAY_GRACE_MS = 2 * 60 * 1000;
export const ASSETS = {
  "kiosk.js": "text/javascript", "state.js": "text/javascript", "audio.js": "text/javascript",
  "resample.js": "text/javascript", "pcm-worklet.js": "text/javascript", "vad.js": "text/javascript",
  "wm-view.js": "text/javascript", "bird-view.js": "text/javascript", "metrics.js": "text/javascript",
  "kiosk.css": "text/css",
};

/**
 * Never on a shared display (review C3, ruling F4): crow_delegate's `bot` arg
 * reaches ANY enabled bot, and the bot-schedule tools are the same cross-bot
 * escape (schedule work under another bot's identity).
 * crow_discover (smoke 2026-10-04): schema discovery returns whole schemas into the
 * prompt — one multi-round discover loop took a 4B turn from 817 to 5.6k prompt
 * tokens and 21.5 s to first audio. A voice display calls its tools directly.
 */
export const KIOSK_DENY_TOOLS = Object.freeze([
  "crow_delegate", "crow_job_status",
  "crow_schedule_bot", "crow_list_bot_schedules", "crow_delete_bot_schedule",
  "crow_discover",
]);

/**
 * Voice-turn guards (smoke 2026-10-04 #19: the 4B called a tool for 10 rounds, 24.5 s, and said
 * nothing). Three tool rounds cover every K1 flow (a timer is one crow_wm call, then its spoken
 * confirmation); the budget is from end of speech to the first ANSWER audio — past it the display
 * says the fallback line instead of going silent.
 */
export const KIOSK_MAX_TOOL_ROUNDS = 3;
export const KIOSK_FIRST_AUDIO_BUDGET_MS = 12_000;

/** The fallback line in the display's language. */
export function kioskFallbackText(lang) {
  return STRINGS[lang === "es" ? "es" : "en"].fallback_stuck;
}

/** Spoken + captioned when the bound assistant's prompt cannot fit the quick voice model (no model call is made). */
export function kioskTooLargeText(lang) {
  return STRINGS[lang === "es" ? "es" : "en"].err_bot_too_large;
}

/** Spoken + captioned when a turn that asked for something on the screen ends with nothing put there. */
export function kioskDisplayMissedText(lang) {
  return STRINGS[lang === "es" ? "es" : "en"].display_missed_say;
}

/**
 * Everything a display turn passes to the voice turn besides the audio, from the display's executor
 * context (display-tools.js). Pure, and the ONE place these options are built: the real turn, the
 * post-deploy turn check and the evaluation harness all call it, so they cannot drift apart.
 *   ctx  { store, deviceId, caps (effective), lang, sources, items, emit, media?, … }
 *   o    { now() → ms, tz, settings (the display's kiosk_settings, or a function returning them: the STT
 *          model is read when the turn transcribes), mediaLine() → "Playing: …" | "",
 *          wrapTools(tools) → tools (the evaluation records calls through it) }
 */
export function displayTurnOptions(ctx, { now = Date.now, tz = null, settings = {}, mediaLine = () => "", wrapTools = null } = {}) {
  const tools = createDisplayTools(ctx);
  const cfg = () => (typeof settings === "function" ? settings() : settings) || {};
  const lang = cfg().lang;
  return {
    extraTools: typeof wrapTools === "function" ? wrapTools(tools) : tools,
    // T0 and T1 (the tier framework), then the K1 fast path and the clock, unchanged, behind them.
    fastPaths: async (t) => (await matchSpoken(t, ctx)) || matchWmFastPath(t, ctx.store, ctx.deviceId, ctx.caps) || matchClockFastPath(t, { now: now(), tz }),
    // Built from the tools this display really has: a display with nothing to play is never told it can play.
    promptSuffix: displayPromptSuffix(ctx.caps, tools.map((x) => x.definition.name)),
    // A turn that asks for NEW content sees kinds and counts only (no open card's title to copy); a turn
    // that asks to CHANGE the open card sees its words.
    turnContext: (t) => `${kioskNowContext(now(), tz)}\n${displayTurnContext(ctx.store, ctx.deviceId, { countsOnly: wantsNewDisplay(t), media: mediaLine(), card: cardUpdate(t, ctx.store, ctx.deviceId) !== null })}`,
    familiesOnIntent: true,
    denyTools: KIOSK_DENY_TOOLS,
    sttModel: (p) => kioskSttModel(p, cfg()),
    maxToolRounds: KIOSK_MAX_TOOL_ROUNDS,
    firstAudioBudgetMs: KIOSK_FIRST_AUDIO_BUDGET_MS,
    fallbackText: kioskFallbackText(lang),
    tooLargeText: kioskTooLargeText(lang),
    displayMissedText: kioskDisplayMissedText(lang),
    memoryWhen: wantsMemory,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who is asking to pair (Task 7 carry). The rate-limit key is the Tailscale
 * login ONLY when the request arrived over the loopback socket — i.e. through
 * Tailscale Serve, which asserts that header. A direct tailnet/LAN hit on the
 * gateway port could forge it, so there the key is the raw socket address
 * (never req.ip, which may trust X-Forwarded-For).
 */
export function pairRequester(req) {
  const ip = String(req?.socket?.remoteAddress || "") || "?";
  const login = LOOPBACK.has(ip) ? (String(req?.headers?.["tailscale-user-login"] || "").slice(0, 128) || null) : null;
  return { ip, login };
}

/**
 * STT warm-up (ruling R13): one 1-s silent transcription per STT profile AND
 * model (a display on tiny.en warms tiny.en) at most every 10 minutes. The smoke
 * measured 8.2 s for the first inference after a whisper start even with the
 * model preloaded, so this runs on hello, at gateway boot (retried until whisper
 * answers), after a display's voice settings change, and from the runtime's
 * minute sweep for idle connected displays (bounds a whisper restart's cold
 * window to ~10 min). A FAILED warm-up is forgotten, so the next call retries.
 * Resolves true (warmed), false (failed) or null (nothing to do). Never throws.
 */
const SELF_HOSTED_STT = new Set(["fasterwhisper", "whispercpp"]);
export function createSttWarmup({ openDb, getSttProfile, createSttAdapter, wrapPcmAsWav, now = Date.now, log = (m) => console.warn(m), everyMs = 10 * 60 * 1000 }) {
  const warmedAt = new Map();
  return async function sttWarmup(device) {
    const db = openDb();
    let key = null;
    try {
      const p = await getSttProfile(db, device);
      // Self-hosted only: the keep-warm must never bill a cloud STT API every 10 minutes.
      if (!p || !SELF_HOSTED_STT.has(p.provider)) return null;
      const model = kioskSttModel(p, device?.kiosk_settings);
      key = `${p.id}|${model || ""}`;
      if (now() - (warmedAt.get(key) || 0) < everyMs) return null;
      warmedAt.set(key, now());
      const stt = await createSttAdapter(p);
      await stt.transcribe(wrapPcmAsWav(Buffer.alloc(32000), 16000), { filename: "warm.wav", contentType: "audio/wav", language: p.language || undefined, signal: AbortSignal.timeout(30_000), ...(model ? { model } : {}) });
      return true;
    } catch (err) {
      if (key) warmedAt.delete(key);
      log(`[kiosk] STT warm-up failed: ${err.message}`);
      return false;
    } finally { try { db.close?.(); } catch {} }
  };
}

/**
 * What the display says when a timer ends, in the display's language. The
 * unnamed timer (wm.js names it "Timer") gets a plain "Time's up." instead of
 * "Timer timer is done."
 */
export function timerDoneSpeech(name, lang) {
  const S = STRINGS[lang === "es" ? "es" : "en"];
  const n = String(name || "").trim();
  if (!n || n.toLowerCase() === "timer") return S.timer_done_say;
  return S.timer_done_named_say.replace("{name}", n);
}

export function kioskThemeCss(T) {
  const vars = (o) => Object.entries(o).map(([k, v]) => `--k-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v};`).join("");
  return `:root{${vars(T.light)}}:root[data-theme="dark"]{${vars({ ...T.light, ...T.dark })}}`;
}

function directLoopback(req) {
  const a = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (a !== "127.0.0.1" && a !== "::1") return false;
  return !Object.keys(req.headers).some((h) => h.startsWith("tailscale-") || h === "x-forwarded-for" || h === "forwarded" || h === "x-forwarded-host");
}

export function createKioskRuntime(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.log(m));
  const pairing = createPairingStore({ now });
  const metrics = createMetricsStore();
  let hub = null;
  const wm = createWmStore({
    now,
    onTimerDone: (id, w) => {
      hub?.sendTo(id, { type: "wm", action: "timer_done", id: w.id });
      hub?.speak(id, timerDoneSpeech(w.name, hub?.deviceOf?.(id)?.kiosk_settings?.lang));
    },
  });
  const withDb = async (fn) => { const db = deps.openDb(); try { return await fn(db); } finally { try { db.close?.(); } catch {} } };
  // Bind-time fit: the voice turn's own ladder, with this bundle's tool list (crow_wm on, the deny list, the suffix).
  const botFit = createBotFit({
    now, log,
    assess: async (db, botId, memoryOn) => (deps.voice.assessBot ? deps.voice.assessBot({
      db, botId, memoryOn, denyTools: KIOSK_DENY_TOOLS, promptSuffix: kioskPromptSuffix(),
      extraTools: [createWmTool({ store: wm, deviceId: "", caps: null, emit: () => {} })],
    }) : null),
  });

  hub = createSessionHub({
    verifyKiosk: (id, token) => withDb((db) => deps.deviceStore.verifyToken(db, id, token, { kind: "kiosk" })),
    // The pairing guess for a display with no type set (session.js); a later panel choice replaces it.
    storeProfile: (id, profile) => withDb((db) => deps.deviceStore.updateDeviceProfiles(db, id, { kiosk_settings: { profile, profile_source: "guessed" } })),
    displayConfig: (d) => withDb(async (db) => ({ name: d.name, ...(d.kiosk_settings || {}), bird: await deps.resolveDisplayBird(db) })),
    runTurn: ({ device, audio, sink, signal, caps, tz, transcript, startedAt, sttEarly }) => withDb((db) => deps.voice.runVoiceTurn({
      db, device, audio, sink, signal, transcript: transcript ?? undefined, startedAt, sttEarly,
      extraTools: [createWmTool({ store: wm, deviceId: device.id, caps, emit: (ev) => sink.event(ev) })],
      fastPaths: async (t) => matchWmFastPath(t, wm, device.id, caps) || matchClockFastPath(t, { now: now(), tz }),
      promptSuffix: kioskPromptSuffix(),
      turnContext: `${kioskNowContext(now(), tz)}\n${kioskTurnContext(wm, device.id)}`,
      denyTools: KIOSK_DENY_TOOLS,
      sttModel: (p) => kioskSttModel(p, device.kiosk_settings),
      maxToolRounds: KIOSK_MAX_TOOL_ROUNDS,
      firstAudioBudgetMs: KIOSK_FIRST_AUDIO_BUDGET_MS,
      fallbackText: kioskFallbackText(device.kiosk_settings?.lang),
      tooLargeText: kioskTooLargeText(device.kiosk_settings?.lang),
      displayMissedText: kioskDisplayMissedText(device.kiosk_settings?.lang),
      memoryWhen: wantsMemory,
    })),
    // Early STT (lever D): same profile + per-display model as the turn's own STT.
    transcribe: deps.voice.transcribe
      ? ({ device, audio, signal }) => withDb((db) => deps.voice.transcribe({ db, device, audio, signal, sttModel: (p) => kioskSttModel(p, device.kiosk_settings) }))
      : null,
    speak: ({ device, text, sink, signal }) => withDb((db) => deps.voice.speakText({ db, device, text, sink, signal })),
    wm, metrics,
    wrapPcmAsWav: deps.wrapPcmAsWav,
    warmup: (d) => deps.sttWarmup(d),
    helloTimeoutMs: deps.helloTimeoutMs,
    now, log,
  });

  const warm = (d) => Promise.resolve().then(() => deps.sttWarmup?.(d)).catch(() => false);
  // Sweep keep-warm: at most one attempt per display per 10 min, success or not (no per-minute DB
  // reads or failure-log spam while whisper is down; hello/boot/admin saves still warm at once).
  const sweepWarmAt = new Map();
  const sweepWarm = (d) => {
    const t = now();
    if (t - (sweepWarmAt.get(d.id) || 0) < 10 * 60 * 1000) return;
    sweepWarmAt.set(d.id, t);
    warm(d);
  };
  const sweep = (deps.setInterval || setInterval)(() => {
    for (const id of hub.connectedIds()) {
      for (const w of wm.sweepIdle(id)) hub.sendTo(id, { type: "wm", action: "close", id: w.id });
      // Keep STT warm for an idle connected display (throttled to 10 min inside sttWarmup).
      const d = hub.deviceOf(id);
      if (d && !hub.isBusy(id)) sweepWarm(d);
    }
    // Session displays: a login that ended closes its display within a minute even when idle,
    // and a display closed for longer than the grace period leaves nothing behind.
    hub.revalidateSessions().catch((err) => log(`[kiosk] session sweep: ${err.message}`));
    expireSessionDisplays();
  }, 60_000);
  sweep.unref?.();

  // ── Session mode (dashboard Talk to Crow) ─────────────────────────────────
  // Off entirely unless the gateway provides the core session helpers.
  const sessionMode = typeof deps.sessionFromRequest === "function" && typeof deps.verifySession === "function" && typeof deps.csrfTokenAccepted === "function";
  const closedSessionDisplays = new Map();   // device id → closed-at (ms)
  function expireSessionDisplays(at = now()) {
    for (const [id, closedAt] of closedSessionDisplays) {
      if (hub.isConnected(id)) { closedSessionDisplays.delete(id); continue; }
      if (at - closedAt < SESSION_DISPLAY_GRACE_MS) continue;
      closedSessionDisplays.delete(id);
      wm.closeAll(id);
      try { deps.voice.convo?.clear?.(id); } catch {}
      sweepWarmAt.delete(id);
    }
  }
  /**
   * The display a logged-in dashboard user talks through. It exists only in
   * memory, for the life of the socket: nothing is written to the device
   * store, so it is never listed, announced to, or pairable. Its id is a
   * domain-separated hash of the session token (stable across reconnects of
   * the same login, useless as a credential).
   */
  async function sessionDevice(db, sessionToken, botId) {
    const stt = await ensureKioskSttProfile(db, deps.settings);
    const tts = await pickKioskTtsProfile(db, deps.settings);
    let lang = "en";
    try { lang = (await deps.settings.readSetting(db, "language")) === "es" ? "es" : "en"; } catch {}
    return {
      id: sessionDisplayId(sessionToken),
      name: "Dashboard",
      device_kind: "kiosk",
      bound_bot_id: botId,
      stt_profile_id: stt.id,
      tts_profile_id: tts ? tts.id : null,
      kiosk_settings: deps.deviceStore.normalizeKioskSettings({ lang }, null),
    };
  }
  /** The session display's assistant; Automatic only picks one that fits (a session display starts with memories off). */
  const sessionBot = (db) => resolveSessionBot(db, deps.settings, (id) => botFit(db, id, false));
  /** hello on the session socket: CSRF double-submit, then the assistant. `req` is the verified upgrade request. */
  async function authorizeSessionHello(req, sessionToken, msg) {
    if (!deps.csrfTokenAccepted(req, msg?.csrf)) return null;
    return withDb(async (db) => {
      const botId = await sessionBot(db);
      if (!botId) return { close: { code: 4403, reason: "no_bot" } };
      return { device: await sessionDevice(db, sessionToken, botId) };
    });
  }

  /**
   * Gateway boot: warm every paired display's STT once whisper answers. Retried
   * every `everyMs` (whisper may still be starting) up to `tries` times; stops at
   * the first round where no warm-up failed. Never throws.
   */
  function bootWarmup({ tries = 20, everyMs = 30_000 } = {}) {
    const setT = deps.setTimeout || setTimeout;
    let left = tries;
    const round = async () => {
      left--;
      let failed = false, warmed = 0;
      try {
        for (const d of await withDb(kioskDevices)) {
          const r = await warm(d);
          if (r === false) failed = true; else if (r === true) warmed++;
        }
      } catch (err) { failed = true; log(`[kiosk] boot STT warm-up: ${err.message}`); }
      if (failed && left > 0) { const t = setT(round, everyMs); t?.unref?.(); }
      else if (warmed) log(`[kiosk] STT warm (${warmed} model${warmed === 1 ? "" : "s"})`);
    };
    return round();
  }

  async function kioskDevices(db) { return (await deps.deviceStore.listDevices(db)).filter((d) => d.device_kind === "kiosk"); }
  async function targets(db, display) {
    const all = await kioskDevices(db);
    if (!display) return all;
    const q = String(display).toLowerCase();
    return all.filter((d) => d.id === display || String(d.name || "").toLowerCase() === q);
  }
  async function announce(display, { text, speak = true }) {
    return withDb(async (db) => {
      const out = { delivered: [], offline: [] };
      for (const d of await targets(db, display)) {
        if (hub.sendTo(d.id, { type: "announce", text })) { if (speak) hub.speak(d.id, text); out.delivered.push(d.name); }
        else out.offline.push(d.name);
      }
      return out;
    });
  }
  async function show(display, { title, body }) {
    return withDb(async (db) => {
      const out = { delivered: [], offline: [] };
      for (const d of await targets(db, display)) {
        const { window, evicted } = wm.open(d.id, { kind: "content", title, blocks: contentBlocks(title, body) });
        for (const e of evicted) hub.sendTo(d.id, { type: "wm", action: "close", id: e.id });
        (hub.sendTo(d.id, { type: "wm", action: "open", window }) ? out.delivered : out.offline).push(d.name);
      }
      return out;
    });
  }

  function router(dashboardAuth) {
    const r = deps.Router();
    // In the gateway the global 1 MB JSON parser runs first, so this limit only
    // applies in tests; every handler caps its own fields (slice) regardless.
    const json = deps.json({ limit: "64kb" });
    const gate = (req, res, next) => {
      if (req.headers["tailscale-funnel-request"]) return res.status(403).json({ error: "funnel_refused" });
      if (!deps.isAllowedNetwork(req)) return res.status(403).json({ error: "network_refused" });
      next();
    };
    const internal = async (req, res, next) => {
      if (!directLoopback(req)) return res.status(403).json({ error: "loopback_only" });
      const auth = String(req.headers.authorization || "");
      const ok = await withDb((db) => deps.announceToken.validate(db, auth.startsWith("Bearer ") ? auth.slice(7) : ""));
      if (!ok) return res.status(401).json({ error: "unauthorized" });
      next();
    };
    const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { log(`[kiosk] ${req.method} ${req.path}: ${err.message}`); if (!res.headersSent) res.status(500).json({ error: "internal" }); });

    // The page lives at /display (ruling F1): the installed maker-lab bundle owns /kiosk/*.
    r.use("/display", gate);
    r.use("/api/kiosk/pair", gate);
    r.use("/api/kiosk/admin", gate, dashboardAuth, deps.csrfMiddleware);
    r.use("/api/kiosk/internal", internal);

    r.get("/display", (req, res) => {
      res.setHeader("Content-Security-Policy", PAGE_CSP);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
      res.type("html").send(readFileSync(join(deps.files.publicDir, "kiosk.html"), "utf8"));
    });
    // Session mode: the page for a logged-in dashboard user. Same network gate as /display, then the
    // dashboard session itself (401, not a redirect: it is shown inside the dashboard's own frame).
    r.get(SESSION_PAGE_PATH, wrap(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!sessionMode) return res.status(404).type("text/plain").send("Not found");
      if (!(await deps.sessionFromRequest(req))) return res.status(401).type("text/plain").send("Sign in to Crow to talk here.");
      res.setHeader("Content-Security-Policy", SESSION_PAGE_CSP);
      res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
      const html = readFileSync(join(deps.files.publicDir, "kiosk.html"), "utf8");
      res.type("html").send(html.replace("<html ", '<html data-mode="session" '));
    }));
    r.get("/display/assets/:file", (req, res) => {
      const f = req.params.file;
      res.setHeader("Cache-Control", "no-cache");
      if (f === "theme.css") return res.type("text/css").send(deps.themeCss());
      if (f === "strings.js") return res.type("text/javascript").send(`export const STRINGS = ${JSON.stringify(STRINGS)};\n`);
      if (f === "bird-svg.js") return res.type("text/javascript").send(readFileSync(deps.files.birdSvgPath, "utf8"));
      if (!Object.hasOwn(ASSETS, f)) return res.status(404).type("text/plain").send("Not found");
      const p = resolve(deps.files.publicDir, f);
      if (!p.startsWith(resolve(deps.files.publicDir)) || !existsSync(p)) return res.status(404).type("text/plain").send("Not found");
      res.type(ASSETS[f]).send(readFileSync(p, "utf8"));
    });

    r.post("/api/kiosk/pair/start", json, (req, res) => {
      const { ip, login } = pairRequester(req);
      const out = pairing.start({ ip, ua: req.headers["user-agent"], login, nameHint: req.body?.name_hint });
      res.setHeader("Cache-Control", "no-store");
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    });
    r.get("/api/kiosk/pair/status", (req, res) => {
      const out = pairing.status(String(req.query.pair_id || ""), String(req.headers["x-kiosk-poll"] || ""));
      res.setHeader("Cache-Control", "no-store");
      res.status(out.status).json(out.body);
    });

    r.get("/api/kiosk/admin/displays", wrap(async (req, res) => {
      const body = await withDb(async (db) => {
        const devices = (await kioskDevices(db)).map((d) => ({ ...d, connected: hub.isConnected(d.id), latency: metrics.summary(d.id) }));
        const bots = (await db.execute({ sql: "SELECT bot_id, display_name FROM pi_bot_defs WHERE enabled = 1 ORDER BY display_name", args: [] })).rows.map((x) => ({ bot_id: x.bot_id, display_name: x.display_name }));
        // fit / fit_memory: "full" | "no_skills" | "too_large" | null (unknown), with memories off / on.
        for (const b of bots) { b.fit = await botFit(db, b.bot_id, false); b.fit_memory = await botFit(db, b.bot_id, true); }
        const prof = async (k) => { try { return JSON.parse((await deps.settings.readSetting(db, k)) || "[]").map((p) => ({ id: p.id, name: p.name || p.id, provider: p.provider })); } catch { return []; } };
        const chosen = String((await deps.settings.readSetting(db, SESSION_BOT_SETTING)) || "") || null;
        const dashboard_voice = { available: sessionMode, bot_id: chosen, effective_bot_id: await sessionBot(db) };
        return { devices, bots, pending: pairing.listPending(), stt_profiles: await prof("stt_profiles"), tts_profiles: await prof("tts_profiles"), dashboard_voice };
      });
      res.json(body);
    }));
    r.post("/api/kiosk/admin/approve", json, wrap(async (req, res) => {
      const code = String(req.body?.code || "");
      const name = String(req.body?.name || "").trim().slice(0, 64) || "Display";
      const botId = String(req.body?.bot_id || "");
      await withDb(async (db) => {
        const bot = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [botId] })).rows[0];
        if (!bot) return res.status(400).json({ error: "bot_required" });
        // A new display starts with memories off. Checked BEFORE the code is claimed.
        if ((await botFit(db, botId, false, { fresh: true })) === "too_large") return res.status(400).json({ error: "bot_too_large" });
        const c = pairing.claim(code);
        if (c.error) return res.status(c.status).json({ error: c.error, retry_after_s: c.retry_after_s });
        let created = null;
        try {
          const stt = await ensureKioskSttProfile(db, deps.settings);
          const tts = await pickKioskTtsProfile(db, deps.settings);
          const id = "kiosk-" + randomBytes(6).toString("hex");
          created = id;
          const { token } = await deps.deviceStore.pairDevice(db, { id, name, device_kind: "kiosk", stt_profile_id: stt.id, tts_profile_id: tts ? tts.id : null });
          await deps.deviceStore.updateDeviceProfiles(db, id, { bound_bot_id: botId });
          if (!pairing.complete(c.pending.pair_id, { device_id: id, token })) {
            await deps.deviceStore.unpairDevice(db, id);          // expired between claim and complete: no orphan device
            return res.status(410).json({ error: "pairing_expired" });
          }
          created = null;                                          // delivered: never clean it up after this
          log(`[kiosk] paired ${id} "${name}" → bot ${botId} (requester ${c.pending.ip})`);
          res.json({ ok: true, device_id: id, tts: tts ? tts.name || tts.id : null });
        } catch (err) {
          // Never leave a paired device whose token is never delivered (e.g. the bot bind failed).
          if (created) { try { await deps.deviceStore.unpairDevice(db, created); } catch (e) { log(`[kiosk] orphan cleanup ${created} failed: ${e.message}`); } }
          pairing.release(c.pending.pair_id);
          throw err;
        }
      });
    }));
    // Which assistant answers the dashboard's Talk to Crow ("" = automatic: the first enabled one that fits).
    r.post("/api/kiosk/admin/dashboard-voice", json, wrap(async (req, res) => {
      const botId = String(req.body?.bot_id || "").slice(0, 128);
      await withDb(async (db) => {
        if (botId) {
          const ok = (await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [botId] })).rows[0];
          if (!ok) return res.status(400).json({ error: "bot_required" });
          if ((await botFit(db, botId, false, { fresh: true })) === "too_large") return res.status(400).json({ error: "bot_too_large" });
        }
        await deps.settings.writeSetting(db, SESSION_BOT_SETTING, botId);
        res.json({ ok: true, bot_id: botId || null, effective_bot_id: await sessionBot(db) });
      });
    }));
    r.post("/api/kiosk/admin/displays/:id", json, wrap(async (req, res) => {
      await withDb(async (db) => {
        const cur = await deps.deviceStore.findDevice(db, req.params.id);
        if (!cur || cur.device_kind !== "kiosk") return res.status(404).json({ error: "not_found" });
        const b = req.body || {};
        const patch = {};
        if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 64);
        if (typeof b.bound_bot_id === "string") {
          const ok = (await db.execute({ sql: "SELECT 1 FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [b.bound_bot_id] })).rows[0];
          if (!ok) return res.status(400).json({ error: "bot_required" });
          // Only a CHANGE of assistant is checked: a display already on a too-large one can still save its other settings.
          const memoryOn = (b.kiosk_settings?.memory_integration ?? cur.kiosk_settings?.memory_integration) === true;
          if (b.bound_bot_id !== cur.bound_bot_id && (await botFit(db, b.bound_bot_id, memoryOn, { fresh: true })) === "too_large") return res.status(400).json({ error: "bot_too_large" });
          patch.bound_bot_id = b.bound_bot_id;
        }
        for (const k of ["stt_profile_id", "tts_profile_id"]) if (typeof b[k] === "string") patch[k] = b[k] || null;
        if (b.kiosk_settings && typeof b.kiosk_settings === "object") patch.kiosk_settings = b.kiosk_settings;
        const d = await deps.deviceStore.updateDeviceProfiles(db, req.params.id, patch);
        hub.refreshDevice(d.id, d);
        // A new STT profile/model pays its first-inference cost now, not on the next question.
        if ("stt_profile_id" in patch || patch.kiosk_settings?.stt_model !== undefined) warm(d);
        // An open page only reads display_config in `ready`: push a fresh one so the save applies now.
        try { await hub.pushConfig(d.id); } catch (err) { log(`[kiosk] config push to ${d.id} failed: ${err.message}`); }
        res.json({ ok: true, device: d });
      });
    }));
    r.delete("/api/kiosk/admin/displays/:id", wrap(async (req, res) => {
      await withDb(async (db) => {
        const cur = await deps.deviceStore.findDevice(db, req.params.id);
        if (!cur || cur.device_kind !== "kiosk") return res.status(404).json({ error: "not_found" });
        await deps.deviceStore.unpairDevice(db, cur.id);
        hub.closeDevice(cur.id, 4401, "unpaired");
        wm.closeAll(cur.id);
        res.json({ ok: true });
      });
    }));
    r.get("/api/kiosk/admin/displays/:id/metrics", (req, res) => res.json({ turns: metrics.list(req.params.id), summary: metrics.summary(req.params.id) }));

    r.get("/api/kiosk/internal/displays", wrap(async (req, res) => {
      res.json({ displays: await withDb(async (db) => (await kioskDevices(db)).map((d) => ({ id: d.id, name: d.name, connected: hub.isConnected(d.id) }))) });
    }));
    r.post("/api/kiosk/internal/announce", json, wrap(async (req, res) => {
      const text = String(req.body?.text || "").trim().slice(0, 500);
      if (!text) return res.status(400).json({ error: "text_required" });
      res.json(await announce(req.body?.display, { text, speak: req.body?.speak !== false }));
    }));
    r.post("/api/kiosk/internal/show", json, wrap(async (req, res) => {
      const title = String(req.body?.title || "").trim().slice(0, 80);
      const body = String(req.body?.body || "").slice(0, 4000);
      if (!title || !body) return res.status(400).json({ error: "title_and_body_required" });
      res.json(await show(req.body?.display, { title, body }));
    }));
    return r;
  }

  function attachUpgrade(server) {
    const wss = new deps.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
    const refuse = (socket, status, text) => { try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch {} socket.destroy(); };
    const accept = (req, socket, head, attachOpts) => wss.handleUpgrade(req, socket, head, (ws) => {
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; try { ws.ping(); } catch {} }, 15_000);
      ws.on("close", () => clearInterval(ping));
      hub.attach(ws, attachOpts);
    });
    server.on("upgrade", (req, socket, head) => {
      const path = String(req.url || "").split("?")[0];
      if (path !== "/api/kiosk/session" && path !== SESSION_WS_PATH) return;
      if (req.headers["tailscale-funnel-request"] || !deps.isAllowedNetwork(req)) return refuse(socket, 403, "Forbidden");
      if (path === "/api/kiosk/session") return accept(req, socket, head);   // paired displays: the token arrives in hello
      // Session mode. Everything is decided BEFORE the upgrade: a browser page on another site can
      // make the browser send the cookie, so the handshake must come from this origin, and the
      // cookie must be a live dashboard session. hello then has to echo the CSRF cookie.
      if (!sessionMode) return refuse(socket, 404, "Not Found");
      if (!sameOriginUpgrade(req)) {
        log(`[kiosk] session display refused: Origin ${String(req.headers.origin || "(none)").slice(0, 120)} is not this host (${String(req.headers.host || "").slice(0, 120)}); a reverse proxy must forward Host or X-Forwarded-Host`);
        return refuse(socket, 403, "Forbidden");
      }
      socket.on("error", () => {});
      Promise.resolve().then(() => deps.sessionFromRequest(req)).then((token) => {
        if (socket.destroyed) return;
        if (!token) return refuse(socket, 401, "Unauthorized");
        accept(req, socket, head, {
          authorize: (msg) => authorizeSessionHello(req, token, msg),
          revalidate: () => deps.verifySession(token),
          onClose: (d) => { closedSessionDisplays.set(d.id, now()); },
        });
      }).catch((err) => { log(`[kiosk] session upgrade failed: ${err?.message}`); refuse(socket, 401, "Unauthorized"); });
    });
    return { openSessionCount: () => hub.connectedIds().length };
  }

  return { router, attachUpgrade, hub, pairing, wm, metrics, announce, show, bootWarmup, expireSessionDisplays, stop: () => clearInterval(sweep) };
}
