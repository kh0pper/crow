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
import { createWmStore, createWmTool, matchWmFastPath, kioskPromptSuffix, kioskTurnContext, contentBlocks } from "./wm.js";
import { ensureKioskSttProfile, pickKioskTtsProfile } from "./profiles.js";
import { STRINGS } from "./strings.js";

export const PAGE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "media-src 'self' blob:", "connect-src 'self' ws://127.0.0.1:8770", "frame-src https://www.youtube-nocookie.com",
  "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");
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
 */
export const KIOSK_DENY_TOOLS = Object.freeze([
  "crow_delegate", "crow_job_status",
  "crow_schedule_bot", "crow_list_bot_schedules", "crow_delete_bot_schedule",
]);

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
 * STT warm-up (ruling R13): one tiny transcription per STT profile at most
 * every 10 minutes, kicked on hello so the first real turn skips the model
 * load. Never throws.
 */
export function createSttWarmup({ openDb, getSttProfile, createSttAdapter, wrapPcmAsWav, now = Date.now, log = (m) => console.warn(m), everyMs = 10 * 60 * 1000 }) {
  const warmedAt = new Map();
  return async function sttWarmup(device) {
    const db = openDb();
    try {
      const p = await getSttProfile(db, device);
      if (!p || now() - (warmedAt.get(p.id) || 0) < everyMs) return;
      warmedAt.set(p.id, now());
      const stt = await createSttAdapter(p);
      await stt.transcribe(wrapPcmAsWav(Buffer.alloc(32000), 16000), { filename: "warm.wav", contentType: "audio/wav", language: p.language || undefined, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      log(`[kiosk] STT warm-up failed: ${err.message}`);
    } finally { try { db.close?.(); } catch {} }
  };
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
      hub?.speak(id, `${w.name} timer is done.`);
    },
  });
  const withDb = async (fn) => { const db = deps.openDb(); try { return await fn(db); } finally { try { db.close?.(); } catch {} } };

  hub = createSessionHub({
    verifyKiosk: (id, token) => withDb((db) => deps.deviceStore.verifyToken(db, id, token, { kind: "kiosk" })),
    displayConfig: (d) => withDb(async (db) => ({ name: d.name, ...(d.kiosk_settings || {}), bird: await deps.resolveDisplayBird(db) })),
    runTurn: ({ device, audio, sink, signal, caps }) => withDb((db) => deps.voice.runVoiceTurn({
      db, device, audio, sink, signal,
      extraTools: [createWmTool({ store: wm, deviceId: device.id, caps, emit: (ev) => sink.event(ev) })],
      fastPaths: async (t) => matchWmFastPath(t, wm, device.id, caps),
      promptSuffix: kioskPromptSuffix(),
      turnContext: kioskTurnContext(wm, device.id),
      denyTools: KIOSK_DENY_TOOLS,
    })),
    speak: ({ device, text, sink, signal }) => withDb((db) => deps.voice.speakText({ db, device, text, sink, signal })),
    wm, metrics,
    wrapPcmAsWav: deps.wrapPcmAsWav,
    warmup: (d) => deps.sttWarmup(d),
    helloTimeoutMs: deps.helloTimeoutMs,
    now, log,
  });

  const sweep = (deps.setInterval || setInterval)(() => {
    for (const id of hub.connectedIds()) for (const w of wm.sweepIdle(id)) hub.sendTo(id, { type: "wm", action: "close", id: w.id });
  }, 60_000);
  sweep.unref?.();

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
        const prof = async (k) => { try { return JSON.parse((await deps.settings.readSetting(db, k)) || "[]").map((p) => ({ id: p.id, name: p.name || p.id, provider: p.provider })); } catch { return []; } };
        return { devices, bots, pending: pairing.listPending(), stt_profiles: await prof("stt_profiles"), tts_profiles: await prof("tts_profiles") };
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
        const c = pairing.claim(code);
        if (c.error) return res.status(c.status).json({ error: c.error, retry_after_s: c.retry_after_s });
        try {
          const stt = await ensureKioskSttProfile(db, deps.settings);
          const tts = await pickKioskTtsProfile(db, deps.settings);
          const id = "kiosk-" + randomBytes(6).toString("hex");
          const { token } = await deps.deviceStore.pairDevice(db, { id, name, device_kind: "kiosk", stt_profile_id: stt.id, tts_profile_id: tts ? tts.id : null });
          await deps.deviceStore.updateDeviceProfiles(db, id, { bound_bot_id: botId });
          if (!pairing.complete(c.pending.pair_id, { device_id: id, token })) {
            await deps.deviceStore.unpairDevice(db, id);          // expired between claim and complete: no orphan device
            return res.status(410).json({ error: "pairing_expired" });
          }
          log(`[kiosk] paired ${id} "${name}" → bot ${botId} (requester ${c.pending.ip})`);
          res.json({ ok: true, device_id: id, tts: tts ? tts.name || tts.id : null });
        } catch (err) { pairing.release(c.pending.pair_id); throw err; }
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
          patch.bound_bot_id = b.bound_bot_id;
        }
        for (const k of ["stt_profile_id", "tts_profile_id"]) if (typeof b[k] === "string") patch[k] = b[k] || null;
        if (b.kiosk_settings && typeof b.kiosk_settings === "object") patch.kiosk_settings = b.kiosk_settings;
        const d = await deps.deviceStore.updateDeviceProfiles(db, req.params.id, patch);
        hub.refreshDevice(d.id, d);
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
    server.on("upgrade", (req, socket, head) => {
      if (String(req.url || "").split("?")[0] !== "/api/kiosk/session") return;
      if (req.headers["tailscale-funnel-request"] || !deps.isAllowedNetwork(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        let alive = true;
        ws.on("pong", () => { alive = true; });
        const ping = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; try { ws.ping(); } catch {} }, 15_000);
        ws.on("close", () => clearInterval(ping));
        hub.attach(ws);
      });
    });
    return { openSessionCount: () => hub.connectedIds().length };
  }

  return { router, attachUpgrade, hub, pairing, wm, metrics, announce, show, stop: () => clearInterval(sweep) };
}
