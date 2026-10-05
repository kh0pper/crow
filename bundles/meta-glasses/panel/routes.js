/**
 * Meta Glasses Panel — REST API + /session WebSocket.
 *
 * REST (Express, dashboardAuth-gated under /api/meta-glasses):
 *   GET    /api/meta-glasses/devices            — list paired devices (no tokens)
 *   POST   /api/meta-glasses/pair               — pair a device, returns { device, token }
 *   DELETE /api/meta-glasses/devices/:id        — unpair a device
 *   POST   /api/meta-glasses/devices/:id        — update per-device overrides
 *   POST   /api/meta-glasses/say                — queue text for TTS broadcast
 *
 * WebSocket (no Express middleware — token-authed at upgrade):
 *   wss://.../api/meta-glasses/session?device_id=X
 *     Authorization: Bearer <token>
 *
 * Session protocol:
 *   client→server text:   { type: hello | turn_start | turn_end | audio_stream_done | media_control | photo_error }
 *   client→server binary: 16 kHz mono PCM frames during a turn
 *   server→client text:   { type: ready | transcript_final | caption_delta | tts_start | tts_end | error |
 *                           capture_photo | remote_turn | media_control | audio_stream_start | audio_stream_end }
 *   server→client binary: speech (raw PCM) between tts_start and tts_end; library audio between
 *                         audio_stream_start and audio_stream_end. The two never overlap.
 *
 * The voice turn itself is the gateway's shared one (servers/gateway/voice/turn.js), driven by
 * ../server/session.js.
 */

import express, { Router } from "express";
import { join, resolve, dirname, sep } from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

// glassesBus (resolved below) pushes glasses media-state changes to the Nest player bar
// via /dashboard/streams/glasses (see servers/gateway/routes/streams.js).

function emitGlassesMediaState(deviceId) {
  if (!deviceId) return;
  try {
    const state = _devicePlaybackState.get(deviceId) || "idle";
    const np = _nowPlaying.get(deviceId);
    glassesBus.emit("glasses:media", {
      deviceId,
      state,
      title: np?.title || null,
      artist: np?.artist || null,
      queueLength: np?.queueLength || 0,
    });
  } catch {
    // Never break the mutation path on a broken subscriber.
  }
}

/* ---------- Bundle + app path resolution ----------
 * Installed, this file is a COPY at <crow-home>/panels/meta-glasses-routes.js, so nothing is
 * reached by a relative path: the bundle dir (installed copy first) and the app root
 * (CROW_APP_ROOT) are resolved the way the kiosk bundle resolves them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const isBundle = (p) => !!p && existsSync(join(p, "manifest.json")) && existsSync(join(p, "server", "app-root.js"));
const BUNDLE_DIR = [
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "meta-glasses"),
  process.env.CROW_APP_ROOT ? join(process.env.CROW_APP_ROOT, "bundles", "meta-glasses") : null,
  resolve(here, ".."),
].filter(Boolean).find(isBundle);
if (!BUNDLE_DIR) throw new Error("meta-glasses: bundle directory not found");
const bImport = (rel) => import(pathToFileURL(join(BUNDLE_DIR, rel)).href);
const { APP_ROOT, appImport } = await bImport("server/app-root.js");
export { appImport };
const serverDir = join(BUNDLE_DIR, "server");
const gatewayDir = join(APP_ROOT, "servers", "gateway");
const glassesBus = (await appImport("servers/shared/event-bus.js")).default;

// The device registry is core's (servers/shared/device-store.js), never an installed copy's.
async function loadDeviceStore() { return appImport("servers/shared/device-store.js"); }
async function loadTts()         { return import(pathToFileURL(join(gatewayDir, "ai/tts/index.js")).href); }
async function loadDb()          { return import(pathToFileURL(join(gatewayDir, "..", "db.js")).href); }
async function loadVision()       { return import(pathToFileURL(join(gatewayDir, "ai/vision.js")).href); }
async function loadResolveProv()  { return import(pathToFileURL(join(gatewayDir, "ai/resolve-provider.js")).href); }
async function loadSettingsReg()  { return import(pathToFileURL(join(gatewayDir, "dashboard/settings/registry.js")).href); }
async function loadS3()           { return import(pathToFileURL(join(gatewayDir, "..", "storage", "s3-client.js")).href); }

const { isAllowedNetwork } = await appImport("servers/gateway/dashboard/auth.js");
const { csrfMiddleware } = await appImport("servers/gateway/dashboard/shared/csrf.js");
const { musicUpstreamConfig, openPinnedUpstream, UpstreamRefused } = await appImport("servers/gateway/media/pinned-upstream.js");
const { registerSchedulerHook } = await appImport("servers/gateway/scheduler-hooks.js");
const { readEnvelope } = await bImport("server/envelope.js");
const { createLimiter } = await bImport("server/limits.js");
const { fetchImagePinned, FetchRefused } = await bImport("server/net-guard.js");
const { createDbClient: openAppDb } = await appImport("servers/db.js");
const { createVoiceTurnRunner, defaultVoiceDeps } = await appImport("servers/gateway/voice/turn.js");
const { wrapPcmAsWav } = await appImport("servers/gateway/voice/turn-helpers.js");
const { createGlassesTurns, playableTtsProfile, GLASSES_DENY_TOOLS } = await bImport("server/session.js");
const { stringsFor } = await bImport("server/strings.js");

/* ---------- Device-token routes: who may call, and how often ----------
 * These routes are reached with a device token, not a dashboard session, and sit outside the
 * gateway's general rate limiter. They are tailnet-only like everything else here.
 */
const GLASSES_KIND = "glasses";
const isGlassesRecord = (d) => !!d && (d.device_kind || GLASSES_KIND) === GLASSES_KIND;
// Failed tokens are counted per caller AND device id: behind Tailscale Serve every request comes
// from 127.0.0.1, so an address alone would let one stale phone lock out every device. The caller
// is the tailnet identity Serve adds (else the socket address). A token that verifies is never
// refused; the global ceiling only stops a flood of bad tokens from all callers together.
const _authFailures = createLimiter({ max: 20, windowMs: 60_000 });      // per caller + device id
const _authFailuresAll = createLimiter({ max: 300, windowMs: 60_000 });  // every caller together
const failKey = (req, deviceId) => `${String(req.headers["tailscale-user-login"] || clientAddr(req)).slice(0, 200)}|${String(deviceId || "").slice(0, 128)}`;
/** A bad token: 429 once this caller (or everyone) is over the limit, else counted and 401. */
function badTokenStatus(req, deviceId) {
  const key = failKey(req, deviceId);
  if (_authFailures.blocked(key) || _authFailuresAll.blocked("all")) return 429;
  _authFailures.take(key);
  _authFailuresAll.take("all");
  return 401;
}
const _photoUploads = createLimiter({ max: 30, windowMs: 60_000 });   // per device
const clientAddr = (req) => String(req.socket?.remoteAddress || "?");

/** Verify a glasses device token (header only). → the device record without hashes, or null. */
async function verifyGlassesToken(deviceId, token) {
  if (!deviceId || !token) return null;
  const { createDbClient } = await loadDb();
  const { verifyToken } = await loadDeviceStore();
  const db = createDbClient();
  try {
    const device = await verifyToken(db, deviceId, token);
    return isGlassesRecord(device) ? device : null;
  } finally { try { db.close(); } catch {} }
}

/** Express gate for device-token routes. Runs BEFORE any body is read. Sets req.glassesDevice. */
async function deviceTokenAuth(req, res, next) {
  if (req.headers["tailscale-funnel-request"] || !isAllowedNetwork(req)) return res.status(403).json({ ok: false, error: "network_refused" });
  const deviceId = typeof req.query.device_id === "string" ? req.query.device_id : "";
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  let device = null;
  try { device = await verifyGlassesToken(deviceId, token); } catch { device = null; }
  if (!device) {
    const status = badTokenStatus(req, deviceId);
    return res.status(status).json({ ok: false, error: status === 429 ? "too_many_attempts" : "bad_token" });
  }
  req.glassesDevice = device;
  return next();
}

/** Apply a transport action to a device's audio: server state, the chained queue and the phone. */
function applyMediaControl(deviceId, action) {
  if (action === "stop") {
    clearAudioQueue(deviceId);
    sendMediaControl(deviceId, "stop");
    _devicePlaybackState.set(deviceId, "idle");
    _nowPlaying.delete(deviceId);
  } else if (action === "next") {
    // Stop the current track, then wake the queue chain; a throwaway waiter absorbs the stale
    // audio_stream_done of the track that was cut.
    sendMediaControl(deviceId, "stop");
    const w = _streamDoneWaiters.get(deviceId);
    if (w) {
      clearTimeout(w.timer);
      _streamDoneWaiters.delete(deviceId);
      const absorb = setTimeout(() => _streamDoneWaiters.delete(deviceId), 2000);
      _streamDoneWaiters.set(deviceId, {
        resolve: () => { clearTimeout(absorb); _streamDoneWaiters.delete(deviceId); },
        reject: () => { clearTimeout(absorb); _streamDoneWaiters.delete(deviceId); },
        timer: absorb,
      });
      w.resolve();
    }
  } else {
    sendMediaControl(deviceId, action);
    _devicePlaybackState.set(deviceId, action === "pause" ? "paused" : "playing");
  }
  emitGlassesMediaState(deviceId);
}

/* ---------- Shared session state ---------- */

const _sessions = new Map();
// Outstanding capture_photo requests: request_id → { resolve, reject, timer }
const _pendingCaptures = new Map();

/** Send a capture_photo command to a session and await upload. */
function triggerCapture(sess) {
  const reqId = randomUUID();
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingCaptures.delete(reqId);
      reject(new Error("capture timeout"));
    }, 20_000);
    _pendingCaptures.set(reqId, { resolve, reject, timer, deviceId: sess.device?.id || null });
  });
  sendText(sess.ws, { type: "capture_photo", request_id: reqId });
  return p;
}
// Where uploaded photos live. Crow data dir has a "uploads" convention.
// CROW_HOME-aware so an alternate instance (MPA, CROW_HOME=~/.crow-mpa) writes
// captures into ITS OWN data dir instead of the primary's. Matches the
// resolveCrowHome() convention in proxy.js / ext_registry.mjs.
const _photoDir = join(process.env.CROW_HOME || join(homedir(), ".crow"), "data", "glasses-photos");
try { mkdirSync(_photoDir, { recursive: true }); } catch {}
/** A stored disk_path the gateway may read or delete: it must resolve inside the photo folder.
 * Rows written before server-made names (or imported from another host) can name any path. */
function photoPathOk(p) {
  if (typeof p !== "string" || !p) return false;
  const root = resolve(_photoDir) + sep;
  return resolve(p).startsWith(root);
}
/** Delete a photo's disk copy, only inside the photo folder; anything else is skipped and logged. */
function removePhotoFile(p, rowId) {
  if (!p) return;
  if (!photoPathOk(p)) { console.warn(`[meta-glasses] photo ${rowId}: disk_path is outside the photo folder; file left alone`); return; }
  try { unlinkSync(p); } catch { /* already gone */ }
}

/* ---------- Per-device turn mutex (Phase 2) ----------
 * Prevents overlapping voice turns on the same device. A rapid second PTT
 * while the first is still drafting TTS would corrupt the adapter state.
 * The lock is released in finally, on ws close, or by the 60s watchdog.
 */
const _turnLocks = new Map(); // deviceId → { acquiredAt, ws, watchdog }
const TURN_WATCHDOG_MS = 100_000;   // longer than TURN_CAP_MS: the cap ends a turn first

function acquireTurnLock(deviceId, ws) {
  const existing = _turnLocks.get(deviceId);
  if (existing) {
    // Re-entrant: if the SAME WebSocket already holds the lock, allow re-entry.
    // This is the case when an in-progress voice turn calls pushAudioStream as
    // part of intercepting an `_audio_stream` envelope from a tool result —
    // the turn already owns the lock, so we shouldn't return busy. A different
    // ws still gets refused (genuine concurrent-turn case).
    if (existing.ws === ws) return true;
    return false;
  }
  const watchdog = setTimeout(() => {
    const e = _turnLocks.get(deviceId);
    if (e && e.ws === ws) {
      _turnLocks.delete(deviceId);
      try { sendText(ws, { type: "error", code: "turn_timeout", recoverable: true }); } catch {}
    }
  }, TURN_WATCHDOG_MS);
  _turnLocks.set(deviceId, { acquiredAt: Date.now(), ws, watchdog });
  return true;
}
function releaseTurnLock(deviceId, ws) {
  const entry = _turnLocks.get(deviceId);
  if (entry && (!ws || entry.ws === ws)) {
    clearTimeout(entry.watchdog);
    _turnLocks.delete(deviceId);
  }
}

/**
 * Resolve the active vision-model provider config for a voice turn.
 *
 * Precedence:
 *   1. device.vision_profile_id (override)
 *   2. aiProfile.vision_profile_id (default)
 *   3. First profile marked isDefault in vision_profiles (platform default)
 *
 * If any pointer profile is selected, resolves via models.json. Direct-mode
 * profiles return their stored baseUrl/model/apiKey. On any miss (no profile,
 * missing provider, etc.) returns null so the caller skips vision.
 */
async function resolveVisionProfileConfig(db, device, aiProfile) {
  try {
    const { readSetting } = await loadSettingsReg();
    const raw = await readSetting(db, "vision_profiles");
    if (!raw) return null;
    let profiles = [];
    try { profiles = JSON.parse(raw); } catch { return null; }
    const targetId = device?.vision_profile_id || aiProfile?.vision_profile_id;
    const profile = targetId
      ? profiles.find(p => p.id === targetId)
      : (profiles.find(p => p.isDefault) || profiles[0]);
    if (!profile) return null;
    if (profile.provider_id) {
      // Ask the GPU orchestrator to make the provider resident before we
      // resolve + call it. Silent best-effort — if orchestrator isn't
      // wired or docker control fails, we fall through to the direct
      // provider call and surface whatever error that produces.
      try {
        const { acquireProvider } = await import(pathToFileURL(join(gatewayDir, "gpu-orchestrator.js")).href);
        await acquireProvider(profile.provider_id);
      } catch (err) {
        // Host switch (CROW_DISABLE_MODEL_ORCHESTRATION): the provider is not
        // ours to start — dial it as-is, quietly.
        if (err?.code !== "model_orchestration_disabled") {
          console.warn(`[meta-glasses] gpu-orchestrator acquire(${profile.provider_id}) failed: ${err.message}`);
        }
      }
      const { resolveProvider } = await loadResolveProv();
      return await resolveProvider(profile.provider_id, profile.model_id);
    }
    if (profile.baseUrl && profile.model) {
      return { baseUrl: profile.baseUrl, apiKey: profile.apiKey || "none", model: profile.model };
    }
    return null;
  } catch (err) {
    console.warn(`[meta-glasses] vision profile resolve failed: ${err.message}`);
    return null;
  }
}

function sendText(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}
function sendBinary(ws, chunk) {
  if (ws.readyState !== 1) return;
  ws.send(chunk);
}

/* ---------- Phase 6 C.2 helpers: capture-and-attach + caption backfill + remint ---------- */

export async function runCaptionBackfill(db) {
  const MAX_ATTEMPTS = 5;
  const { rows } = await db.execute({
    sql: `SELECT note_id, photo_id, attempts FROM glasses_caption_backfill`,
    args: [],
  });
  let replaced = 0;
  let dropped = 0;
  for (const row of rows) {
    // Look up the photo's caption (set by _enrichGlassesPhoto).
    const { rows: pr } = await db.execute({
      sql: `SELECT caption FROM glasses_photos WHERE id = ?`,
      args: [row.photo_id],
    });
    const caption = pr[0]?.caption;
    if (caption) {
      // Find the `![\[caption pending\]](photo://<id>)` placeholder and replace.
      const noteRow = await db.execute({ sql: `SELECT content FROM research_notes WHERE id = ?`, args: [row.note_id] });
      const content = String(noteRow.rows[0]?.content || "");
      // Regex: ![<anything>](photo://<id>) — the caption field may be
      // literally "[caption pending]" (square brackets are pre-stripped
      // in handleCaptureAndAttach) or any other placeholder. Replace only
      // the first match targeting this photo_id.
      const re = new RegExp(`!\\[[^\\]]*\\]\\(photo://${row.photo_id}\\b([^)]*)\\)`, "g");
      let found = false;
      const safeCaption = String(caption).replace(/[\]\[]/g, "");
      const newContent = content.replace(re, (match, tail) => {
        if (found) return match;
        found = true;
        return `![${safeCaption}](photo://${row.photo_id}${tail})`;
      });
      if (found) {
        await db.execute({
          sql: `UPDATE research_notes SET content = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [newContent, row.note_id],
        });
        replaced++;
      }
      await db.execute({
        sql: `DELETE FROM glasses_caption_backfill WHERE note_id = ? AND photo_id = ?`,
        args: [row.note_id, row.photo_id],
      });
    } else if (Number(row.attempts || 0) + 1 >= MAX_ATTEMPTS) {
      await db.execute({
        sql: `DELETE FROM glasses_caption_backfill WHERE note_id = ? AND photo_id = ?`,
        args: [row.note_id, row.photo_id],
      });
      dropped++;
    } else {
      await db.execute({
        sql: `UPDATE glasses_caption_backfill SET attempts = attempts + 1 WHERE note_id = ? AND photo_id = ?`,
        args: [row.note_id, row.photo_id],
      });
    }
  }
  return { replaced, dropped };
}

/**
 * Phase 6 C.2: rewrite `photo://<id>` markdown refs to freshly-minted
 * presigned URLs at render time. Notes store the sentinel; the renderer
 * swaps in real URLs with a 1 h TTL so opening a note days later still
 * shows working images. The regex requires digit-only IDs + a word
 * boundary so a literal `photo://xyz` in operator-typed text is
 * preserved verbatim. Caps at 200 unique IDs per render (SQLite's
 * default SQLITE_MAX_VARIABLE_NUMBER is 999; 200 gives headroom).
 */
export async function remintPhotoRefs(db, content) {
  const matches = [...String(content || "").matchAll(/photo:\/\/(\d+)\b/g)];
  if (matches.length === 0) return content;
  const ids = [...new Set(matches.map(m => Number(m[1])))].slice(0, 200);
  if (matches.length > ids.length) {
    console.warn(`[meta-glasses] remintPhotoRefs: note has ${matches.length} refs; capped to ${ids.length}`);
  }
  const { rows } = await db.execute({
    sql: `SELECT id, minio_key, disk_path FROM glasses_photos WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  let s3Ready = false;
  let getPresignedUrl = null;
  try {
    const s3 = await loadS3();
    s3Ready = await s3.isAvailable();
    getPresignedUrl = s3.getPresignedUrl;
  } catch {}
  const PLACEHOLDER = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20fill%3D%22%23888%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2234%22%20text-anchor%3D%22middle%22%20font-size%3D%2210%22%20fill%3D%22%23fff%22%3Emissing%3C%2Ftext%3E%3C%2Fsvg%3E";
  const resolved = new Map();
  for (const id of ids) {
    const row = byId.get(id);
    let url = PLACEHOLDER;
    if (row?.minio_key && s3Ready && getPresignedUrl) {
      try { url = await getPresignedUrl(row.minio_key, { expiry: 3600 }); } catch {}
    } else if (row?.disk_path) {
      url = `/api/meta-glasses/photo/${encodeURIComponent(String(row.disk_path).split("/").pop())}`;
    }
    resolved.set(id, url);
  }
  return String(content).replace(/photo:\/\/(\d+)\b/g, (_, idStr) => resolved.get(Number(idStr)) || PLACEHOLDER);
}

/* ---------- The voice turn: the shared runner, driven by the glasses session adapter ---------- */

const TURN_CAP_MS = 90_000;                 // a turn is aborted here whatever it is doing
const TURN_LOCK_WAIT_MS = 8_000;            // how long a new turn waits for a library relay to finish sending
const _turnAborts = new Map();              // deviceId → AbortController of the turn in flight
const _voiceDeps = await defaultVoiceDeps();
const _voice = createVoiceTurnRunner(_voiceDeps);

/** Describe a just-captured photo with the device's (or the default) vision profile. → text | null when no profile resolves. */
async function describePhoto({ db, device, shot, question }) {
  const visionConfig = await resolveVisionProfileConfig(db, device, null);
  if (!visionConfig) return null;
  const { readFileSync } = await import("node:fs");
  const basename = decodeURIComponent(String(shot?.url || "").split("/").pop() || "").replace(/[^\w.\-]/g, "");
  if (!basename) return null;
  const imageBytes = readFileSync(join(_photoDir, basename));
  const mime = basename.endsWith(".png") ? "image/png" : basename.endsWith(".heic") ? "image/heic" : "image/jpeg";
  const { analyzeImage } = await loadVision();
  const { description } = await analyzeImage({
    providerConfig: visionConfig,
    prompt: `Answer in one to three short sentences that will be read aloud. The user asks: ${question}`,
    imageBytes, mime, timeoutMs: 30_000, maxTokens: 300,
  });
  // The turn's answer is the library caption: the photo is never sent to the vision model twice.
  if (description && shot?.photo_id) {
    try { await db.execute({ sql: "UPDATE glasses_photos SET caption = ? WHERE id = ?", args: [String(description).slice(0, 1000), shot.photo_id] }); }
    catch (err) { console.warn(`[meta-glasses] caption write failed for photo ${shot.photo_id}: ${err.message}`); }
  }
  return description || null;
}

/** Start relaying a library stream (and its queue) that a music tool's envelope asked for. */
function startEnvelopePlayback(deviceId, e) {
  setAudioQueue(deviceId, e.queue);
  _devicePlaybackState.set(deviceId, "playing");
  _nowPlaying.set(deviceId, { title: e.item.title, artist: e.item.artist, artworkUrl: e.item.artworkUrl, queueLength: e.queue.length + 1 });
  emitGlassesMediaState(deviceId);
  const idle = () => { _devicePlaybackState.set(deviceId, "idle"); _nowPlaying.delete(deviceId); emitGlassesMediaState(deviceId); };
  pushAudioStream(deviceId, {
    url: e.item.url, codec: e.item.codec, sampleRate: e.item.sample_rate, channels: e.item.channels, auth: e.item.auth,
    title: e.item.title, artist: e.item.artist, artworkUrl: e.item.artworkUrl,
  }).then((outcome) => { if (!outcome?.delivered) idle(); }).catch(idle);
}

const glassesTurns = createGlassesTurns({
  voice: _voice,
  openDb: () => openAppDb(),
  findDevice: async (db, id) => (await loadDeviceStore()).findDevice(db, id),
  listTtsProfiles: async (db) => (await loadTts()).getTtsProfiles(db, { includeKeys: false }),
  botToolNames: async (db, device) => {
    let def = null;
    try { const row = await _voiceDeps.loadBotRow(db, device.bound_bot_id); def = row && row.enabled ? JSON.parse(row.definition) : null; } catch { def = null; }
    return def ? _voiceDeps.getChatTools({ botDef: def }).map((t) => t.name) : [];
  },
  capture: (deviceId) => {
    const sess = _sessions.get(deviceId);
    return sess ? triggerCapture(sess) : Promise.reject(new Error("no connected session"));
  },
  describePhoto,
  readEnvelope,
  playback: { state: (id) => _devicePlaybackState.get(id) || "idle", control: applyMediaControl, start: startEnvelopePlayback },
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

/** A turn never runs beside another turn or a library relay on the same socket: wait briefly for the lock, never re-enter it. */
async function waitForTurnLock(deviceId, ws, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (!_turnLocks.has(deviceId) && acquireTurnLock(deviceId, ws)) return true;
    if (Date.now() >= end || ws.readyState !== 1) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** One spoken turn for a connected device, from the end of speech to the last byte of its reply. */
async function runSessionTurn(ws, deviceId, audio) {
  const startedAt = Date.now();
  if (!(await waitForTurnLock(deviceId, ws, TURN_LOCK_WAIT_MS))) {
    sendText(ws, { type: "error", code: "turn_busy", recoverable: true });
    return;
  }
  const ac = new AbortController();
  _turnAborts.set(deviceId, ac);
  const cap = setTimeout(() => ac.abort(), TURN_CAP_MS);
  let entry = null;
  try {
    entry = await glassesTurns.runTurn({
      deviceId, audio, startedAt, signal: ac.signal,
      send: { text: (o) => sendText(ws, o), binary: (b) => sendBinary(ws, b) },
    });
  } finally {
    clearTimeout(cap);
    if (_turnAborts.get(deviceId) === ac) _turnAborts.delete(deviceId);
    releaseTurnLock(deviceId, ws);
  }
  // Library audio starts only after the turn's speech went out and its lock is free.
  if (entry?.playback && ws.readyState === 1) startEnvelopePlayback(deviceId, entry.playback);
}

/** Would the bound assistant's voice prompt fit its quick model? Cached for a minute per device and assistant. */
const _fitCache = new Map();
async function botFit(db, d) {
  if (!d.bound_bot_id) return null;
  const key = `${d.id}|${d.bound_bot_id}`;
  const hit = _fitCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.fit;
  let fit = null;
  try {
    const r = await _voice.assessBot({ db, botId: d.bound_bot_id, memoryOn: d.voice_settings?.memory !== false, denyTools: GLASSES_DENY_TOOLS, promptSuffix: stringsFor(d.voice_settings?.lang).prompt_suffix });
    fit = r ? { level: r.level, model: r.model } : { level: "no_bot", model: null };
  } catch { fit = null; }
  _fitCache.set(key, { at: Date.now(), fit });
  return fit;
}

/** No browser signal says this request came from another site (see the /pair rule). */
function pairLooksSameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  // Host only (a forwarded-host header is caller-supplied). A mismatch falls back to the CSRF check.
  try { return new URL(origin).host === String(req.headers.host || ""); } catch { return false; }
}

/* ---------- Express router ---------- */

export default function metaGlassesRouter(dashboardAuth) {
  const router = Router();
  // Two kinds of caller. Device-token routes (the phone app) authenticate themselves in
  // deviceTokenAuth. Everything else needs the dashboard session, and every state-changing
  // call also needs the CSRF token the dashboard's own fetch wrapper adds.
  const DEVICE_TOKEN_ROUTES = new Set(["POST /photo", "GET /artwork"]);
  router.use("/api/meta-glasses", (req, res, next) => {
    if (DEVICE_TOKEN_ROUTES.has(`${req.method} ${req.path}`)) return next();
    return dashboardAuth(req, res, () => {
      // Pairing is called by the phone app's native code with the dashboard's cookie and no CSRF
      // header (and no Origin). Without the CSRF token it is accepted only as a JSON body that no
      // browser marked cross-site: Sec-Fetch-Site absent or same-origin, and an Origin, when
      // present, equal to this host. That holds even if CORS_ALLOWED_ORIGINS is configured.
      if (req.method === "POST" && req.path === "/pair") {
        if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "json_required" });
        if (pairLooksSameOrigin(req)) return next();
        return csrfMiddleware(req, res, next);
      }
      return csrfMiddleware(req, res, next);
    });
  });

  router.get("/api/meta-glasses/devices", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { listDevices } = await loadDeviceStore();
    const db = createDbClient();
    try {
      const devices = await listDevices(db);
      let ttsProfiles = [];
      try { ttsProfiles = await (await loadTts()).getTtsProfiles(db, { includeKeys: false }); } catch { ttsProfiles = []; }
      // Only glasses records: the registry is shared with kiosk displays and companions.
      // fit = the bound assistant against its quick voice model; voice = whether any profile gives
      // the raw PCM the app plays; recent_turns = outcome codes and timings only.
      const annotated = [];
      for (const d of devices.filter(isGlassesRecord)) {
        annotated.push({
          ...d, connected: _sessions.has(d.id), fit: await botFit(db, d),
          voice: playableTtsProfile(d, ttsProfiles) === false ? "none" : "ok",
          recent_turns: glassesTurns.recentTurns(d.id),
        });
      }
      let sttProfiles = [];
      try { sttProfiles = await (await appImport("servers/gateway/ai/stt/index.js")).getSttProfiles(db, { includeKeys: false }); } catch { sttProfiles = []; }
      // Names and ids only, for the per-device voice pickers.
      const profiles = {
        stt: sttProfiles.map((p) => ({ id: p.id, name: p.name || p.id })),
        tts: ttsProfiles.map((p) => ({ id: p.id, name: p.name || p.id, playable: playableTtsProfile({ tts_profile_id: p.id }, [p]) === p.id })),
      };
      res.json({ devices: annotated, connected_count: annotated.filter(d => d.connected).length, profiles });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/pair", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { pairDevice } = await loadDeviceStore();
    const { id, name, generation, household_profile, stt_profile_id, ai_profile_slug, tts_profile_id } = req.body || {};
    if (!id || typeof id !== "string" || id.length > 128) {
      return res.status(400).json({ ok: false, error: "id required (string, ≤128 chars)" });
    }
    if (generation && !["gen1", "gen2", "unknown"].includes(generation)) {
      return res.status(400).json({ ok: false, error: "generation must be gen1|gen2|unknown" });
    }
    if (generation === "gen1") {
      return res.status(400).json({
        ok: false,
        error: "Gen 1 (Ray-Ban Stories) is not supported. Only Gen 2 (Ray-Ban Meta) exposes the DAT camera primitives we need.",
      });
    }
    const db = createDbClient();
    try {
      // Never re-pair over a record of another kind (a kiosk display, a companion).
      const { findDevice } = await loadDeviceStore();
      const prior = await findDevice(db, id);
      if (prior && !isGlassesRecord(prior)) return res.status(409).json({ ok: false, error: "id_in_use" });
      const result = await pairDevice(db, {
        id, name, generation: generation || "unknown",
        photo_retention: prior ? prior.photo_retention : "30d",
        household_profile: household_profile || null,
        stt_profile_id: stt_profile_id || null,
        ai_profile_slug: ai_profile_slug || null,
        tts_profile_id: tts_profile_id || null,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/meta-glasses/devices/:id", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { unpairDevice, findDevice } = await loadDeviceStore();
    const db = createDbClient();
    try {
      if (!isGlassesRecord(await findDevice(db, req.params.id))) return res.status(404).json({ ok: false, error: "device not found" });
      const result = await unpairDevice(db, req.params.id);
      const sess = _sessions.get(req.params.id);
      if (sess?.ws) { try { sess.ws.close(1000, "device_unpaired"); } catch {} _sessions.delete(req.params.id); }
      res.json({ ok: true, ...result });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/devices/:id", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { updateDeviceProfiles, findDevice } = await loadDeviceStore();
    const db = createDbClient();
    try {
      if (!isGlassesRecord(await findDevice(db, req.params.id))) return res.status(404).json({ ok: false, error: "device not found" });
      // The kind is not editable here.
      const { device_kind: _ignored, kiosk_settings: _ignored2, ...patch } = req.body || {};
      const updated = await updateDeviceProfiles(db, req.params.id, patch);
      if (!updated) return res.status(404).json({ ok: false, error: "device not found" });
      res.json({ ok: true, device: updated });
    } finally {
      db.close();
    }
  });

  // Library: delete a photo by id. Removes the MinIO object (if any),
  // unlinks the disk file (if any), then deletes the DB row. Redirect
  // back to the library tab so Turbo can re-extract the
  // mg-library-results frame from the full-page response.
  router.post("/dashboard/meta-glasses/library/delete", dashboardAuth, async (req, res) => {
    const id = parseInt(req.body?.id, 10);
    if (!id) return res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: `SELECT minio_key, disk_path FROM glasses_photos WHERE id = ?`,
        args: [id],
      });
      const row = rows[0];
      if (row?.minio_key) {
        try {
          const { deleteObject } = await loadS3();
          await deleteObject(row.minio_key);
        } catch (err) {
          console.warn(`[meta-glasses] library delete: MinIO removeObject failed for ${row.minio_key}: ${err.message}`);
        }
      }
      if (row?.disk_path) removePhotoFile(row.disk_path, id);
      await db.execute({ sql: `DELETE FROM glasses_photos WHERE id = ?`, args: [id] });
    } catch (err) {
      console.warn(`[meta-glasses] library delete for ${id} failed: ${err.message}`);
    } finally {
      try { db.close(); } catch {}
    }
    res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
  });

  // Library: delete all photos for a single device. Per-device scope
  // is explicit — cross-device wipe is out of scope this phase.
  router.post("/dashboard/meta-glasses/library/delete-all", dashboardAuth, async (req, res) => {
    const deviceId = String(req.body?.device_id || "").trim();
    if (!deviceId) return res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    let removed = 0;
    try {
      const { rows } = await db.execute({
        sql: `SELECT id, minio_key, disk_path FROM glasses_photos WHERE device_id = ?`,
        args: [deviceId],
      });
      let s3;
      try { s3 = await loadS3(); } catch {}
      for (const row of rows) {
        if (s3 && row.minio_key) {
          try { await s3.deleteObject(row.minio_key); } catch {}
        }
        removePhotoFile(row.disk_path, row.id);
      }
      const del = await db.execute({
        sql: `DELETE FROM glasses_photos WHERE device_id = ?`,
        args: [deviceId],
      });
      removed = Number(del.rowsAffected || 0);
      console.log(`[meta-glasses] library delete-all: removed ${removed} photos for device=${deviceId}`);
    } catch (err) {
      console.warn(`[meta-glasses] library delete-all for device=${deviceId} failed: ${err.message}`);
    } finally {
      try { db.close(); } catch {}
    }
    res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
  });

  // Notes: delete a session + its backing research_notes row.
  router.post("/dashboard/meta-glasses/notes/delete", dashboardAuth, async (req, res) => {
    const sid = parseInt(req.body?.session_id, 10);
    if (!sid) return res.redirectAfterPost("/dashboard/meta-glasses?tab=notes");
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    try {
      const { rows } = await db.execute({ sql: `SELECT note_id FROM glasses_note_sessions WHERE id = ?`, args: [sid] });
      const noteId = rows[0]?.note_id;
      await db.execute({ sql: `DELETE FROM glasses_note_sessions WHERE id = ?`, args: [sid] });
      if (noteId) {
        await db.execute({ sql: `DELETE FROM research_notes WHERE id = ?`, args: [noteId] });
        await db.execute({ sql: `DELETE FROM glasses_caption_backfill WHERE note_id = ?`, args: [noteId] });
      }
    } catch (err) {
      console.warn(`[meta-glasses] notes delete for session=${sid} failed: ${err.message}`);
    } finally {
      try { db.close(); } catch {}
    }
    res.redirectAfterPost("/dashboard/meta-glasses?tab=notes");
  });

  // Library: run the daily retention pipeline now (operator-triggered).
  // Useful for verifying the cron without waiting until 03:00. Returns a
  // JSON summary so the UI can show what changed.
  router.post("/dashboard/meta-glasses/library/retention-run", dashboardAuth, async (req, res) => {
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    try {
      const summary = await runPhotoRetention(db);
      res.json({ ok: true, summary });
    } catch (err) {
      console.warn(`[meta-glasses] retention-run failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // Operator endpoint: push an audio stream (compressed media) to a paired
  // device. Useful for diagnostics, testing the Phase 4 MediaCodec path, or
  // playing arbitrary content from the Nest without going through the LLM.
  //
  // Body: { device_id, url, codec, sample_rate?, channels?, auth? }
  //   auth must be one of the allow-listed sentinels (see pushAudioStream).
  router.post("/api/meta-glasses/stream", async (req, res) => {
    const { device_id, url, codec, sample_rate, channels, auth, title, artist, artwork_url, queue } = req.body || {};
    if (!device_id || !url || !codec) {
      return res.status(400).json({ ok: false, error: "device_id, url, codec required" });
    }
    // The address rule (which host, which path, which credential) is enforced in
    // pushAudioStream for every caller, this endpoint included.
    // If a queue is provided, seed it before pushing the first track so the
    // existing chain logic picks up tracks 2..N via audio_stream_done ack.
    if (Array.isArray(queue) && queue.length > 0) {
      setAudioQueue(device_id, queue);
    }
    const outcome = await pushAudioStream(device_id, {
      url, codec, sampleRate: sample_rate, channels, auth, title, artist, artworkUrl: artwork_url,
    });
    return res.json({ ok: outcome?.delivered === true, ...outcome });
  });

  router.post("/api/meta-glasses/say", async (req, res) => {
    const { text, device_id } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ ok: false, error: "text required" });
    }
    const targetIds = device_id ? [String(device_id)] : [..._sessions.keys()];
    let delivered = 0;
    for (const id of targetIds) {
      const r = await pushTtsToDevice(id, text);
      if (r.delivered) delivered++;
    }
    res.json({ ok: true, delivered, targeted: targetIds.length });
  });

  /* ---------- Media control REST endpoints ---------- */

  const ALLOWED_MEDIA_ACTIONS = new Set(["stop", "pause", "resume", "next"]);

  router.get("/api/meta-glasses/media/status", (req, res) => {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.status(400).json({ error: "device_id required" });
    const state = _devicePlaybackState.get(deviceId) || "idle";
    const np = _nowPlaying.get(deviceId);
    res.json({
      state,
      title: np?.title || null,
      artist: np?.artist || null,
      queue_length: np?.queueLength || 0,
    });
  });

  router.post("/api/meta-glasses/media/control", (req, res) => {
    const { device_id, action } = req.body || {};
    if (!device_id || !action) return res.status(400).json({ error: "device_id and action required" });
    if (!ALLOWED_MEDIA_ACTIONS.has(action)) return res.status(400).json({ error: "unknown action" });
    if (!_sessions.get(device_id)?.ws) return res.status(404).json({ error: "device not connected" });
    applyMediaControl(device_id, action);
    res.json({ ok: true, state: _devicePlaybackState.get(device_id) || "idle" });
  });

  /**
   * Artwork proxy: the phone fetches album art through the gateway (../server/net-guard.js):
   * public addresses only (resolved once, connected as resolved), the music server's own origin
   * excepted; images only, 5 MB, no redirects.
   */
  router.get("/api/meta-glasses/artwork", deviceTokenAuth, async (req, res) => {
    const src = typeof req.query.src === "string" ? req.query.src : "";
    if (!src || src.length > 2048) return res.status(400).json({ error: "src required" });
    let srcUrl;
    try { srcUrl = new URL(src); } catch { return res.status(400).json({ error: "invalid url" }); }
    if (srcUrl.protocol !== "http:" && srcUrl.protocol !== "https:") return res.status(400).json({ error: "unsupported scheme" });
    if (srcUrl.username || srcUrl.password) return res.status(400).json({ error: "invalid url" });
    // The configured music server's exact origin may be private and gets its credential; anything
    // else must resolve only to public addresses, and is fetched from the address that was checked.
    const music = musicUpstreamConfig();
    const isMusic = !!music && srcUrl.origin === music.origin;
    const ac = new AbortController();
    req.on("close", () => { try { ac.abort(); } catch {} });
    try {
      const got = await fetchImagePinned(srcUrl.toString(), {
        allowPrivate: isMusic,
        headers: isMusic ? { Authorization: `Bearer ${music.token}` } : {},
        signal: ac.signal,
      });
      res.setHeader("Content-Type", got.contentType);
      res.setHeader("Content-Length", String(got.body.length));
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(got.body);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof FetchRefused) return res.status(err.status).json({ error: err.code });
      res.status(502).json({ error: "upstream_error" });
    }
  });

  /**
   * Photo upload: the phone app POSTs the captured bytes here.
   * Order matters: the device token is checked (deviceTokenAuth) and the per-device rate is
   * counted BEFORE the body is read. The file name is made here from nothing the caller sent.
   */
  const PHOTO_EXT = new Map([["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"], ["heic", "image/heic"]]);
  const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  router.post("/api/meta-glasses/photo",
    deviceTokenAuth,
    (req, res, next) => (_photoUploads.take(req.glassesDevice.id) ? next() : res.status(429).json({ ok: false, error: "too_many_uploads" })),
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req, res) => {
      const device = req.glassesDevice;
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ ok: false, error: "empty_body" });
      const wanted = String(req.query.ext || "jpg").toLowerCase();
      const ext = PHOTO_EXT.has(wanted) ? wanted : "jpg";
      // request_id only pairs this upload with a pending capture; it is never part of a path.
      const reqId = REQUEST_ID_RE.test(String(req.query.request_id || "")) ? String(req.query.request_id).toLowerCase() : null;

      const fname = `${Date.now()}_${randomUUID()}.${ext}`;
      const diskPath = join(_photoDir, fname);
      try { writeFileSync(diskPath, req.body, { flag: "wx" }); } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      const url = `/api/meta-glasses/photo/${encodeURIComponent(fname)}`;
      res.json({ ok: true, url, size: req.body.length });

      // The library INSERT is awaited so a pending capture gets the photo id. A photo that
      // answers a look turn is described once, by that turn (describePhoto stores the answer
      // as its caption); any other upload is captioned in the background.
      // A request id answers only the capture this same device was asked for.
      const candidate = reqId ? _pendingCaptures.get(reqId) : null;
      const pending = candidate && candidate.deviceId === device.id ? candidate : null;
      let photoMeta = null;
      try {
        photoMeta = await recordGlassesPhoto({ deviceId: device.id, diskPath, fname, mime: PHOTO_EXT.get(ext), size: req.body.length, enrich: !pending });
      } catch (err) {
        console.warn(`[meta-glasses] library insert failed: ${err.message}`);
      }

      if (pending && _pendingCaptures.get(reqId) === pending) {
        clearTimeout(pending.timer);
        _pendingCaptures.delete(reqId);
        pending.resolve({
          ok: true,
          url,
          size: req.body.length,
          photo_id: photoMeta?.photoId || null,
          minio_key: photoMeta?.minioKey || null,
        });
      }
    });

  /** Serve a stored photo. Authed (so only the Nest / authed LLM callers can read). */
  router.get("/api/meta-glasses/photo/:name", async (req, res) => {
    const name = req.params.name.replace(/[^\w.\-]/g, "");
    const p = join(_photoDir, name);
    if (!existsSync(p)) return res.status(404).json({ ok: false, error: "not found" });
    res.sendFile(p);
  });

  /**
   * Remote push-to-talk: tells the paired device to begin/end a voice turn
   * over its existing /session WebSocket. Lets the Crow's Nest panel
   * (and any other dashboard surface) drive the voice loop without the
   * user having to hold a physical button on the phone.
   */
  router.post("/api/meta-glasses/turn", async (req, res) => {
    const { action, device_id } = req.body || {};
    if (action !== "begin" && action !== "end") {
      return res.status(400).json({ ok: false, error: "action must be 'begin' or 'end'" });
    }
    const targetIds = device_id ? [device_id] : [..._sessions.keys()];
    let delivered = 0;
    for (const id of targetIds) {
      const sess = _sessions.get(id);
      if (!sess?.ws) continue;
      sendText(sess.ws, { type: "remote_turn", action });
      delivered++;
    }
    res.json({ ok: true, delivered, targeted: targetIds.length });
  });

  return router;
}

/* ---------- WebSocket upgrade handler ---------- */

/**
 * Attach /api/meta-glasses/session WebSocket handler.
 * Call once at gateway startup with the HTTP server instance.
 */
export function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on("upgrade", async (req, socket, head) => {
    const url = req.url || "";
    if (!url.startsWith("/api/meta-glasses/session")) return;

    const refuse = (status, reason) => { try { socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`); } catch {} socket.destroy(); };
    // An upgrade never passes through Express, so the gateway's Funnel refusal and network
    // rule are applied here, before anything else is looked at.
    if (req.headers["tailscale-funnel-request"] || !isAllowedNetwork(req)) return refuse(403, "Forbidden");

    const params = new URL(url, "http://localhost").searchParams;
    const deviceId = params.get("device_id");
    // Header only: a token in the query string would end up in access logs.
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!deviceId || !token) return refuse(400, "Bad Request");

    let device = null;
    try { device = await verifyGlassesToken(deviceId, token); } catch { device = null; }
    if (!device) return badTokenStatus(req, deviceId) === 429 ? refuse(429, "Too Many Requests") : refuse(401, "Unauthorized");

    wss.handleUpgrade(req, socket, head, (ws) => {
      const prior = _sessions.get(deviceId);
      if (prior?.ws && prior.ws !== ws) {
        try { prior.ws.close(1000, "superseded"); } catch {}
      }
      _sessions.set(deviceId, { ws, device, openedAt: Date.now(), lastPingAt: Date.now() });

      sendText(ws, { type: "ready", session_id: `${deviceId}:${Date.now()}` });

      let inTurn = false;
      let turnBuffer = [];
      let turnBytes = 0;
      let micSampleRate = 16000;
      let micIsPcm = true;
      const MAX_TURN_BYTES = 16000 * 2 * 120;   // two minutes of 16 kHz mono PCM

      let alive = true;
      ws.on("pong", () => {
        alive = true;
        const s = _sessions.get(deviceId);
        if (s && s.ws === ws) s.lastPingAt = Date.now();
      });
      const pinger = setInterval(() => {
        if (!alive) { try { ws.terminate(); } catch {} clearInterval(pinger); return; }
        alive = false;
        try { ws.ping(); } catch {}
      }, 15000);

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          if (!inTurn) return;
          turnBytes += raw.length;
          if (turnBytes <= MAX_TURN_BYTES) turnBuffer.push(raw);
          return;
        }
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
        switch (msg.type) {
          case "hello":
            micIsPcm = msg.codec === "pcm" || msg.codec == null;
            micSampleRate = Number.isFinite(msg.sample_rate) && msg.sample_rate >= 8000 && msg.sample_rate <= 48000 ? msg.sample_rate : 16000;
            break;
          case "turn_start":
            inTurn = true;
            turnBuffer = [];
            turnBytes = 0;
            break;
          case "turn_end": {
            if (!inTurn) return;
            inTurn = false;
            const pcm = Buffer.concat(turnBuffer);
            turnBuffer = [];
            if (!micIsPcm) {
              // The shared turn takes PCM. The phone app has always sent PCM; anything else is refused, not guessed at.
              sendText(ws, { type: "error", code: "unsupported_codec", recoverable: false });
              break;
            }
            runSessionTurn(ws, device.id, wrapPcmAsWav(pcm, micSampleRate))
              .catch((err) => { console.warn(`[meta-glasses] ${device.id} turn error: ${err?.message || err}`); });
            break;
          }
          case "audio_stream_done": {
            const w = _streamDoneWaiters.get(device.id);
            if (w) {
              clearTimeout(w.timer);
              _streamDoneWaiters.delete(device.id);
              w.resolve();
            } else {
              // No waiter = last track finished naturally (single or end of album)
              _devicePlaybackState.set(device.id, "idle");
              _nowPlaying.delete(device.id);
              emitGlassesMediaState(device.id);
            }
            break;
          }
          case "media_control": {
            // The phone already acted (notification button, headset key): mirror the state, never echo it back.
            const mcAction = msg.action;
            if (mcAction === "stop") {
              clearAudioQueue(device.id);
              _devicePlaybackState.set(device.id, "idle");
              _nowPlaying.delete(device.id);
              emitGlassesMediaState(device.id);
            } else if (mcAction === "pause") {
              _devicePlaybackState.set(device.id, "paused");
              emitGlassesMediaState(device.id);
            } else if (mcAction === "resume") {
              _devicePlaybackState.set(device.id, "playing");
              emitGlassesMediaState(device.id);
            } else if (mcAction === "next") {
              const w2 = _streamDoneWaiters.get(device.id);
              if (w2) {
                clearTimeout(w2.timer);
                _streamDoneWaiters.delete(device.id);
                const absorb = setTimeout(() => _streamDoneWaiters.delete(device.id), 2000);
                _streamDoneWaiters.set(device.id, {
                  resolve: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
                  reject:  () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
                  timer: absorb,
                });
                w2.resolve();
              }
            }
            break;
          }
          case "photo_error": {
            // The phone reports a capture failure: the waiting turn hears about it now, not after a timeout.
            const pending = _pendingCaptures.get(msg.request_id);
            if (pending && pending.deviceId === device.id) {
              clearTimeout(pending.timer);
              _pendingCaptures.delete(msg.request_id);
              pending.reject(new Error(`${String(msg.code || "capture_failed").slice(0, 40)}`));
            }
            break;
          }
        }
      });

      ws.on("close", () => {
        clearInterval(pinger);
        // A turn in flight for this socket stops: its model call and its speech are aborted.
        const ac = _turnAborts.get(deviceId);
        if (ac && _turnLocks.get(deviceId)?.ws === ws) ac.abort();
        // Playback state belongs to the device's CURRENT socket: a superseded one leaves it alone.
        if (_sessions.get(deviceId)?.ws === ws) {
          _sessions.delete(deviceId);
          clearAudioQueue(deviceId);
          _devicePlaybackState.delete(deviceId);
          _nowPlaying.delete(deviceId);
          emitGlassesMediaState(deviceId);
        }
        releaseTurnLock(deviceId, ws);
      });
      ws.on("error", () => { /* close follows */ });
    });
  });

  return { openSessionCount: () => _sessions.size };
}

/* ---------- Phase 5: photo library insert + caption + OCR ---------- */

// Per-device daily OCR cap. Guards against unbounded vision spend on a
// device that captures continuously. At 200 OCRs/device/day, even a
// 3-device household stays under ~600 vision calls/day. Exceeding the
// cap silently skips OCR for the remainder of the day; the caption
// pipeline still runs. Tuned conservatively; raise if real usage
// warrants it. There's a known micro-race: two concurrent captures at
// count 199 can both pass the check and produce 201 writes. Acceptable
// slop — the cap is a budget guard, not a billing-strict limit.
const OCR_DAILY_CAP_PER_DEVICE = 200;

// PII redaction patterns applied to OCR text before it lands in the
// FTS index. Best-effort by design: the settings disclaimer makes
// clear we can't redact names, addresses, account numbers, or any
// format that doesn't match one of these four. The CC regex is Luhn-
// loose — it false-positives on long digit runs (timestamps, CSV
// numeric columns) which is the safe direction for privacy but a
// minor search-quality cost.
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g,                                   // SSN
  /\b(?:\d[ -]*?){13,19}\b/g,                                 // CC (Luhn-loose)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,      // email
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // US phone
];

function redactPII(text) {
  let t = text;
  for (const re of PII_PATTERNS) t = t.replace(re, "[REDACTED]");
  return t;
}

// Vision models don't reliably honor the literal "." sentinel prompt —
// they emit "No text.", "There is no text in this image.", "I can't
// read this.", etc. Anything under 3 characters (just "." or stray
// whitespace) or matching one of the common no-text/refusal phrases is
// treated as empty. Downside of a false-empty is a missing search
// hit; downside of a false-positive-text is searchable garbage, so we
// err toward dropping.
const EMPTY_OCR_PATTERNS = [
  /^[\s.,\-–—]*$/,                                        // whitespace/punct only
  /^\s*(no[\s_-]?text|none|empty|n\/a)\s*\.?\s*$/i,
  /^\s*there\s+is\s+no\s+text/i,
  /^\s*the\s+image\s+(contains|has)\s+no\s+(legible\s+)?text/i,
  /^\s*i\s+(can'?t|cannot|am\s+unable)/i,                 // refusals
  /^\s*i'?m\s+(sorry|unable)/i,
];

function cleanOcrResponse(raw) {
  const t = (raw || "").trim();
  if (t.length < 3) return "";
  for (const re of EMPTY_OCR_PATTERNS) if (re.test(t)) return "";
  return t;
}

async function recordGlassesPhoto({ deviceId, diskPath, fname, mime, size, enrich = true }) {
  const { createDbClient } = await loadDb();
  const { readFileSync } = await import("node:fs");

  // 1. Best-effort MinIO upload BEFORE the DB insert. If MinIO isn't
  //    configured, we fall straight through to disk-only. If upload
  //    throws, we log and keep disk as the authoritative source. The
  //    resulting `minioKey` is either a real key or null; the INSERT
  //    records both.
  let minioKey = null;
  try {
    const { isAvailable, uploadObject } = await loadS3();
    if (await isAvailable()) {
      const ext = (mime?.split("/")[1] || "jpg").split("+")[0];
      const candidate = `meta-glasses/${deviceId}/${Date.now()}-${randomUUID()}.${ext}`;
      try {
        await uploadObject(candidate, readFileSync(diskPath), { contentType: mime });
        minioKey = candidate;
      } catch (err) {
        console.warn(`[meta-glasses] MinIO upload failed for photo (device=${deviceId}); keeping disk copy only: ${err.message}`);
        minioKey = null;
      }
    }
  } catch (err) {
    // loadS3 itself failed (module missing, etc) — stay on disk path.
    console.warn(`[meta-glasses] S3 client unavailable: ${err.message}`);
  }

  // 2. DB insert. If this fails after a successful MinIO upload, the
  //    MinIO object would be orphaned — compensate by deleting it.
  //    (minio-js removeObject is idempotent on 404.)
  const db = createDbClient();
  let photoId;
  try {
    const ins = await db.execute({
      sql: `INSERT INTO glasses_photos (device_id, disk_path, minio_key, mime, size_bytes)
            VALUES (?, ?, ?, ?, ?)`,
      args: [deviceId, diskPath, minioKey, mime, size],
    });
    photoId = Number(ins.lastInsertRowid);
  } catch (err) {
    if (minioKey) {
      try {
        const { deleteObject } = await loadS3();
        await deleteObject(minioKey);
      } catch {}
    }
    throw err;
  } finally {
    try { db.close(); } catch {}
  }
  if (!photoId) return null;
  // NOTE: the disk file at `diskPath` is intentionally NOT unlinked in
  // this session. A future retention cron (Phase 5 B.4) prunes disk
  // copies once MinIO has served them successfully or after a grace
  // period. Keeps the system recoverable if MinIO is briefly down.

  // Phase 6 C.2: fire-and-forget the enrichment pipeline so the caller
  // gets photoId back synchronously. The capture-and-attach tool needs
  // the id immediately to write a `photo://<id>` markdown ref; waiting
  // for the 5-30s vision call would time out the MCP tool.
  if (enrich) _enrichGlassesPhoto({ photoId, deviceId, diskPath, mime }).catch(err =>
    console.warn(`[meta-glasses] enrich pipeline error for photo ${photoId}: ${err.message}`)
  );
  return { photoId, minioKey };
}

async function _enrichGlassesPhoto({ photoId, deviceId, diskPath, mime }) {
  const { createDbClient } = await loadDb();
  // Fire-and-forget: resolve the default vision profile (no device/AI profile
  // plumbing here — library captions use the platform default). Skip silently
  // if no vision profile is set.
  try {
    const { readSetting } = await loadSettingsReg();
    const db2 = createDbClient();
    try {
      const raw = await readSetting(db2, "vision_profiles");
      if (!raw) return;
      let profiles = [];
      try { profiles = JSON.parse(raw); } catch { return; }
      const profile = profiles.find(p => p.isDefault) || profiles[0];
      if (!profile) return;
      let providerConfig;
      if (profile.provider_id) {
        const { resolveProvider } = await loadResolveProv();
        providerConfig = await resolveProvider(profile.provider_id, profile.model_id);
      } else if (profile.baseUrl && profile.model) {
        providerConfig = { baseUrl: profile.baseUrl, apiKey: profile.apiKey || "none", model: profile.model };
      } else { return; }

      const { analyzeImage } = await loadVision();
      const { readFileSync } = await import("node:fs");
      const imageBytes = readFileSync(diskPath);
      const { description } = await analyzeImage({
        providerConfig,
        prompt: "Briefly describe what's in this image (1 sentence). This is a searchable library caption.",
        imageBytes,
        mime,
        timeoutMs: 30_000,
        maxTokens: 100,
      });
      await db2.execute({
        sql: `UPDATE glasses_photos SET caption = ? WHERE id = ?`,
        args: [description || null, photoId],
      });

      // Phase 5 B.2: opt-in OCR with per-device daily cap + PII redaction.
      // Off by default. Enabling runs a SECOND analyzeImage call with an
      // OCR prompt; the response passes through cleanOcrResponse (to
      // reject model hallucinations / refusals / empty sentinels) and
      // then through redactPII (a small regex set) before it's written
      // to the FTS-indexed ocr_text column.
      try {
        const { findDevice } = await loadDeviceStore();
        const device = await findDevice(db2, deviceId);
        if (device?.ocr_enabled) {
          const today = new Date().toISOString().slice(0, 10);
          const { rows: cap } = await db2.execute({
            sql: `SELECT COUNT(*) AS n FROM glasses_photos
                  WHERE device_id = ? AND DATE(captured_at) = ? AND ocr_text IS NOT NULL`,
            args: [deviceId, today],
          });
          const used = Number(cap?.[0]?.n ?? 0);
          if (used < OCR_DAILY_CAP_PER_DEVICE) {
            const { description: rawOcr } = await analyzeImage({
              providerConfig,
              prompt: "Extract all legible text from this image verbatim, line by line. If no legible text is present, respond with a single period character '.'",
              imageBytes,
              mime,
              timeoutMs: 30_000,
              maxTokens: 500,
            });
            const cleaned = cleanOcrResponse(rawOcr);
            if (cleaned) {
              const redacted = redactPII(cleaned);
              await db2.execute({
                sql: `UPDATE glasses_photos SET ocr_text = ? WHERE id = ?`,
                args: [redacted, photoId],
              });
            }
          } else {
            console.log(`[meta-glasses] OCR daily cap reached for device=${deviceId} (${used}/${OCR_DAILY_CAP_PER_DEVICE}); skipping photo ${photoId}`);
          }
        }
      } catch (err) {
        console.warn(`[meta-glasses] OCR pipeline error for photo ${photoId}: ${err.message}`);
      }
    } finally {
      try { db2.close(); } catch {}
    }
  } catch (err) {
    console.warn(`[meta-glasses] caption pipeline error for photo ${photoId}: ${err.message}`);
  }
}

/**
 * Search the glasses photo library by caption/OCR.
 * Returns [{ id, url, caption, ocr_text, captured_at }, ...].
 *
 * URLs resolve in the following order: if `minio_key` is present AND
 * MinIO is available, a per-row presigned GET is minted with a 1-hour
 * TTL. Otherwise we fall back to the legacy disk-backed
 * /api/meta-glasses/photo/:name route. Presigned-URL minting is async,
 * so the map is wrapped in Promise.all — bare .map(async r => ...)
 * would hand back an array of unresolved Promises.
 */
export async function searchGlassesPhotos(query, { limit = 10 } = {}) {
  const { createDbClient, sanitizeFtsQuery } = await loadDb();
  const db = createDbClient();
  try {
    const q = sanitizeFtsQuery ? sanitizeFtsQuery(query || "") : (query || "").replace(/['"]/g, " ");
    if (!q.trim()) return [];
    const { rows } = await db.execute({
      sql: `SELECT g.id, g.disk_path, g.minio_key, g.caption, g.ocr_text, g.captured_at
            FROM glasses_photos g JOIN glasses_photos_fts f ON g.id = f.rowid
            WHERE glasses_photos_fts MATCH ?
            ORDER BY g.captured_at DESC LIMIT ?`,
      args: [q, limit],
    });
    let s3Ready = false;
    let getPresignedUrl = null;
    try {
      const s3 = await loadS3();
      s3Ready = await s3.isAvailable();
      getPresignedUrl = s3.getPresignedUrl;
    } catch {}
    return Promise.all(rows.map(async (r) => {
      let url;
      if (s3Ready && r.minio_key && getPresignedUrl) {
        try {
          url = await getPresignedUrl(r.minio_key, { expiry: 3600 });
        } catch {
          url = `/api/meta-glasses/photo/${encodeURIComponent(String(r.disk_path || "").split("/").pop())}`;
        }
      } else {
        url = `/api/meta-glasses/photo/${encodeURIComponent(String(r.disk_path || "").split("/").pop())}`;
      }
      return {
        id: r.id,
        url,
        caption: r.caption,
        ocr_text: r.ocr_text,
        captured_at: r.captured_at,
      };
    }));
  } finally {
    try { db.close(); } catch {}
  }
}

/* ---------- Phase 5 B.4: photo retention cron + disk backfill ----------
 *
 * Three helpers + one public entry point:
 *   - backfillGlassesPhoto(db, row)          — migrate one disk-only row into MinIO
 *   - reclaimBackfilledDiskCopies(db)        — unlink disk copies past the grace window
 *   - pruneGlassesPhotos(db)                 — per-device retention + orphan sweep
 *   - runPhotoRetention(db, { budgetMs })    — exported, called by scheduler/admin
 *
 * Disk-only rows are NEVER pruned — doing so during a MinIO outage is
 * unrecoverable data loss. Orphan sweep TTL is measured from the unpair
 * timestamp recorded in `dashboard_settings` (keyed
 * `meta_glasses_device_unpaired.<device_id>` by unpairDevice).
 */

async function backfillGlassesPhoto(db, row) {
  const { isAvailable, uploadObject, deleteObject } = await loadS3();
  if (!(await isAvailable())) return { skipped: "no-storage" };
  const { existsSync, readFileSync } = await import("node:fs");
  if (!row.disk_path || !photoPathOk(row.disk_path) || !existsSync(row.disk_path)) {
    return { skipped: "disk-missing" };
  }
  const ext = (row.mime?.split("/")[1] || "jpg").split("+")[0];
  const key = `meta-glasses/${row.device_id}/backfill-${row.id}-${Date.now()}.${ext}`;
  try {
    await uploadObject(key, readFileSync(row.disk_path), { contentType: row.mime });
    const upd = await db.execute({
      sql: `UPDATE glasses_photos SET minio_key = ? WHERE id = ? AND minio_key IS NULL`,
      args: [key, row.id],
    });
    if (Number(upd.rowsAffected || 0) === 0) {
      // Lost a race — the row was updated/deleted between SELECT and UPDATE.
      // Remove the orphan we just uploaded (idempotent on 404).
      try { await deleteObject(key); } catch {}
      return { skipped: "already-migrated" };
    }
    return { migrated: key };
  } catch (err) {
    try { await deleteObject(key); } catch {}
    return { failed: err.message };
  }
}

async function reclaimBackfilledDiskCopies(db) {
  const DISK_GRACE_DAYS = 7;
  const { rows } = await db.execute({
    sql: `SELECT id, disk_path FROM glasses_photos
          WHERE minio_key IS NOT NULL AND disk_path IS NOT NULL
            AND captured_at < datetime('now', ?)`,
    args: [`-${DISK_GRACE_DAYS} days`],
  });
  let reclaimed = 0;
  for (const row of rows) {
    removePhotoFile(row.disk_path, row.id);
    await db.execute({
      sql: `UPDATE glasses_photos SET disk_path = NULL WHERE id = ?`,
      args: [row.id],
    });
    reclaimed++;
  }
  return { reclaimed };
}

async function pruneGlassesPhotos(db) {
  const { listDevices } = await loadDeviceStore();
  const { deleteObject } = await loadS3();
  const devices = await listDevices(db);
  const activeIds = new Set(devices.map(d => d.id));
  let prunedTotal = 0;

  // Per-device retention prune: every row past the device's rule, wherever its bytes live
  // (object storage, the disk copy, or both). On an instance without object storage every
  // photo is disk-only, and those must age out too.
  for (const d of devices) {
    const retention = d.photo_retention || "never";
    if (retention === "never") continue;
    const days = retention === "30d" ? 30 : retention === "1y" ? 365 : 0;
    if (!days) continue;
    const { rows } = await db.execute({
      sql: `SELECT id, minio_key, disk_path FROM glasses_photos
            WHERE device_id = ? AND captured_at < datetime('now', ?)`,
      args: [d.id, `-${days} days`],
    });
    for (const row of rows) {
      if (row.minio_key) { try { await deleteObject(row.minio_key); } catch {} }
      removePhotoFile(row.disk_path, row.id);
      await db.execute({ sql: `DELETE FROM glasses_photos WHERE id = ?`, args: [row.id] });
      prunedTotal++;
    }
  }

  // Orphan sweep. TTL measured from unpair time, not captured_at.
  const ORPHAN_GRACE_DAYS = 7;
  const { rows: unpairRows } = await db.execute({
    sql: `SELECT key, value FROM dashboard_settings
          WHERE key LIKE 'meta_glasses_device_unpaired.%'`,
    args: [],
  });
  for (const urow of unpairRows) {
    const unpairedDeviceId = String(urow.key).replace(/^meta_glasses_device_unpaired\./, "");
    if (activeIds.has(unpairedDeviceId)) {
      // Re-paired — clear the marker. (pairDevice also clears it; this is
      // a belt-and-suspenders cleanup for markers that pre-dated the
      // pair-side delete.)
      await db.execute({
        sql: `DELETE FROM dashboard_settings WHERE key = ?`,
        args: [urow.key],
      });
      continue;
    }
    const unpairedAt = new Date(urow.value).getTime();
    if (Number.isNaN(unpairedAt)) continue;
    const ageDays = (Date.now() - unpairedAt) / 86_400_000;
    if (ageDays < ORPHAN_GRACE_DAYS) continue;
    const { rows: orphanRows } = await db.execute({
      sql: `SELECT id, minio_key, disk_path FROM glasses_photos
            WHERE device_id = ?`,
      args: [unpairedDeviceId],
    });
    for (const row of orphanRows) {
      if (row.minio_key) { try { await deleteObject(row.minio_key); } catch {} }
      removePhotoFile(row.disk_path, row.id);
      await db.execute({ sql: `DELETE FROM glasses_photos WHERE id = ?`, args: [row.id] });
      prunedTotal++;
    }
    const { rows: rem } = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM glasses_photos WHERE device_id = ?`,
      args: [unpairedDeviceId],
    });
    if (Number(rem?.[0]?.n ?? 0) === 0) {
      await db.execute({
        sql: `DELETE FROM dashboard_settings WHERE key = ?`,
        args: [urow.key],
      });
    }
  }

  return { prunedTotal };
}

export async function runPhotoRetention(db, { budgetMs = 60_000 } = {}) {
  const started = Date.now();
  const summary = { backfilled: 0, backfill_skipped: 0, backfill_failed: 0, reclaimed: 0, pruned: 0 };
  const BATCH_SIZE = 50;
  // 1. Backfill disk-only rows in batches until queue drains OR budget exhausts.
  // Pre-flight: skip the entire backfill loop if MinIO is unavailable.
  // Without this guard the SELECT keeps re-finding the same skipped rows
  // forever, burning the time budget on no-ops.
  let s3Ready = false;
  try {
    const { isAvailable } = await loadS3();
    s3Ready = await isAvailable();
  } catch {}
  if (!s3Ready) {
    summary.backfill_skipped_no_storage = true;
  } else {
    // Track IDs that returned a non-fatal skip (e.g. disk-missing ghost
    // rows) so the next SELECT doesn't re-fetch them and stall the loop.
    const skippedIds = new Set();
    while (Date.now() - started < budgetMs) {
      const placeholders = skippedIds.size > 0 ? `AND id NOT IN (${[...skippedIds].map(() => "?").join(",")})` : "";
      const { rows: pending } = await db.execute({
        sql: `SELECT id, device_id, disk_path, mime FROM glasses_photos
              WHERE minio_key IS NULL AND disk_path IS NOT NULL ${placeholders} LIMIT ?`,
        args: [...skippedIds, BATCH_SIZE],
      });
      if (pending.length === 0) break;
      for (const row of pending) {
        try {
          const r = await backfillGlassesPhoto(db, row);
          if (r.migrated) summary.backfilled++;
          else if (r.failed) { summary.backfill_failed++; skippedIds.add(row.id); }
          else { summary.backfill_skipped++; skippedIds.add(row.id); }
        } catch {
          summary.backfill_failed++;
          skippedIds.add(row.id);
        }
      }
    }
  }
  // 2. Reclaim disk copies past the grace window.
  try {
    const r = await reclaimBackfilledDiskCopies(db);
    summary.reclaimed = r.reclaimed || 0;
  } catch (err) {
    console.warn(`[meta-glasses] reclaim failed: ${err.message}`);
  }
  // 3. Prune per-device retention + orphan sweep.
  try {
    const r = await pruneGlassesPhotos(db);
    summary.pruned = r.prunedTotal || 0;
  } catch (err) {
    console.warn(`[meta-glasses] prune failed: ${err.message}`);
  }
  // 4. Phase 6 C.2: caption backfill. Piggybacks on the daily run; the
  //    scheduler also calls runCaptionBackfill directly every tick so
  //    fill-in lag is typically seconds, not hours.
  try {
    const r = await runCaptionBackfill(db);
    summary.caption_replaced = r.replaced || 0;
    summary.caption_dropped = r.dropped || 0;
  } catch (err) {
    console.warn(`[meta-glasses] caption backfill failed: ${err.message}`);
  }
  summary.elapsed_ms = Date.now() - started;
  return summary;
}

/* ---------- Phase 4: audio_stream proxy (Android MediaCodec pending) ----------
 *
 * Outbound WebSocket protocol, already ratified in this bundle:
 *   server → client text:   { type: "audio_stream_start", codec: "mp3"|"ogg"|"aac",
 *                             sample_rate, channels, content_length? }
 *   server → client binary: compressed audio bytes for the duration of the stream
 *   server → client text:   { type: "audio_stream_end", ok: true|false, error? }
 *
 * Tool-result shape for producers (funkwhale, podcast bundles, etc.):
 *   { _audio_stream: { url, codec, sample_rate?, channels? } }
 *   — the voice-turn loop proxies the URL to the device and never surfaces
 *   the tool result to the LLM as text.
 *
 * pushAudioStream below implements the server side. The Android client must
 * add a MediaCodec decoder + separate AudioTrack (Phase 4 Android PR). Until
 * that APK lands, this helper is callable but ineffective on phone.
 *
 * Backpressure: chunked at 64KB with WebSocket drain awaits, total in-flight
 * bounded at 1MB (bufferedAmount check).
 */
// Which credential rule an `auth` value names. "funkwhale" = this instance's own music server
// (servers/gateway/media/pinned-upstream.js decides what may be requested and where the
// credential goes). "crow-peer:<id>" = a paired instance's /audio/stream, with that peer's
// bearer and only at its registered gateway host. Anything else is refused: the gateway does
// not fetch arbitrary addresses for a device.
export async function pushAudioStream(deviceId, { url, codec, sampleRate, channels, auth, title, artist, artworkUrl } = {}) {
  if (!deviceId || !url || !codec) return { delivered: false, reason: "bad_args" };
  const sess = _sessions.get(deviceId);
  if (!sess?.ws) return { delivered: false, reason: "absent" };
  // Detect whether we'd be acquiring a fresh lock or reusing one already held
  // by the same ws (the case when this is called from inside a voice-turn
  // intercepting an `_audio_stream` envelope). If we acquired fresh, we must
  // release in finally; if we reused, the outer turn handler still owns it.
  const lockReentrant = _turnLocks.get(deviceId)?.ws === sess.ws;
  if (!acquireTurnLock(deviceId, sess.ws)) return { delivered: false, reason: "lock_busy" };
  try {
    const refuseStream = (reason) => {
      sendText(sess.ws, { type: "audio_stream_end", ok: false, error: reason });
      return { delivered: false, reason };
    };
    let resp;
    if (auth === "funkwhale") {
      try {
        resp = await openPinnedUpstream(url, musicUpstreamConfig());
      } catch (err) {
        if (!(err instanceof UpstreamRefused)) throw err;
        console.warn(`[meta-glasses] library stream refused for ${deviceId}: ${err.code}`);
        return refuseStream(err.code);
      }
    } else if (typeof auth === "string" && auth.startsWith("crow-peer:")) {
      // A paired instance's stream proxy. The peer's bearer goes only to that peer's REGISTERED
      // gateway host, and a redirect is never followed with or without it.
      const instId = auth.slice("crow-peer:".length);
      let bearer = null;
      try {
        let gwHost = null;
        const dbc = (await loadDb()).createDbClient();
        try {
          const { rows } = await dbc.execute({ sql: "SELECT gateway_url FROM crow_instances WHERE id = ?", args: [instId] });
          if (rows[0]?.gateway_url) gwHost = new URL(rows[0].gateway_url).host;
        } finally { try { dbc.close(); } catch {} }
        let targetHost = null;
        try { targetHost = new URL(url).host; } catch {}
        if (gwHost && targetHost && gwHost === targetHost) {
          const { getPeerCreds } = await import(pathToFileURL(join(gatewayDir, "..", "shared", "peer-credentials.js")).href);
          bearer = getPeerCreds(instId)?.auth_token || null;
        }
      } catch (err) {
        console.warn(`[meta-glasses] crow-peer auth resolve failed for ${instId}: ${err.message}`);
      }
      if (!bearer) return refuseStream("peer_not_recognised");
      // Ten seconds to response headers; the stream itself may run as long as the track.
      const headersAc = new AbortController();
      const headersTimer = setTimeout(() => headersAc.abort(), 10_000);
      try { resp = await fetch(url, { redirect: "manual", headers: { Authorization: `Bearer ${bearer}` }, signal: headersAc.signal }); }
      catch (err) { if (headersAc.signal.aborted) return refuseStream("peer_timeout"); throw err; }
      finally { clearTimeout(headersTimer); }
      if (resp.status >= 300 && resp.status < 400) {
        try { await resp.body?.cancel(); } catch {}
        return refuseStream("redirect_refused");
      }
      if (!resp.ok || !resp.body) return refuseStream(`http_${resp.status}`);
    } else {
      return refuseStream("auth_required");
    }
    const contentLength = Number(resp.headers.get("content-length")) || undefined;
    // Resolve title/artist/artwork_url: explicit args win, fall back to _nowPlaying
    // (set by the envelope interceptor for the head-of-album track).
    const np = _nowPlaying.get(deviceId) || {};
    sendText(sess.ws, {
      type: "audio_stream_start",
      codec, sample_rate: sampleRate || null, channels: channels || null,
      content_length: contentLength,
      title:  title  ?? np.title  ?? null,
      artist: artist ?? np.artist ?? null,
      artwork_url: artworkUrl ?? np.artworkUrl ?? null,
    });
    const reader = resp.body.getReader();
    while (true) {
      // Backpressure: 1MB cap
      if (sess.ws.bufferedAmount > 1_000_000) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) break;
      sendBinary(sess.ws, Buffer.from(value));
    }
    // If there's a next track queued, register the done-waiter BEFORE sending
    // audio_stream_end so we don't race with the phone's ack.
    const next = popAudioQueue(deviceId);
    if (next) {
      const donePromise = waitForStreamDone(deviceId);
      sendText(sess.ws, { type: "audio_stream_end", ok: true });
      // Release the lock while the phone plays. This lets voice turns
      // ("stop", "skip", questions) run in the inter-track gap.
      if (!lockReentrant) releaseTurnLock(deviceId, sess.ws);
      try {
        await donePromise;
      } catch (err) {
        console.warn(`[meta-glasses] queue chain for ${deviceId}: ${err.message}`);
        clearAudioQueue(deviceId);
        return { delivered: true, queueAborted: true };
      }
      // Re-acquire for next track. If a voice turn is in progress, spin
      // until it completes. Queue check on each spin prevents spinning
      // forever if fw_stop_playback was called.
      while (!acquireTurnLock(deviceId, sess.ws)) {
        await new Promise(r => setTimeout(r, 200));
        if (!sess.ws || sess.ws.readyState !== 1) return { delivered: true, queueAborted: true };
      }
      // Update _nowPlaying for the next queue item so audio_stream_start gets
      // per-track metadata (album artwork usually stays the same across an album).
      if (next.title || next.artist || next.artworkUrl) {
        const prev = _nowPlaying.get(deviceId) || {};
        _nowPlaying.set(deviceId, {
          title: next.title || null,
          artist: next.artist || prev.artist || null,
          artworkUrl: next.artworkUrl || prev.artworkUrl || null,
          queueLength: Math.max((prev.queueLength || 1) - 1, 1),
        });
        emitGlassesMediaState(deviceId);
      }
      return await pushAudioStream(deviceId, next);
    }
    sendText(sess.ws, { type: "audio_stream_end", ok: true });
    return { delivered: true };
  } catch (err) {
    sendText(sess.ws, { type: "audio_stream_end", ok: false, error: err.message });
    clearAudioQueue(deviceId); // an error mid-album halts the rest
    return { delivered: false, reason: err.message };
  } finally {
    // Only release the lock if WE acquired it. When reentrant (parent voice
    // turn already owns it), the outer handler is responsible for releasing.
    if (!lockReentrant) releaseTurnLock(deviceId, sess.ws);
  }
}

/**
 * Per-device server-side audio queue. Used by fw_play_album (and any future
 * "playlist"-style envelope) to play multiple tracks back-to-back without
 * needing a phone-side queue or each track being a separate AI tool call.
 *
 * Each entry is the same shape pushAudioStream takes: {url, codec, auth?, ...}.
 */
const _audioQueues = new Map(); // deviceId → array of stream descriptors
const _streamDoneWaiters = new Map(); // deviceId → { resolve, reject, timer }
const _devicePlaybackState = new Map(); // deviceId → "idle" | "playing" | "paused"
const _nowPlaying = new Map(); // deviceId → { title, artist, queueLength }

function sendMediaControl(deviceId, action) {
  const sess = _sessions.get(deviceId);
  if (!sess?.ws) return false;
  sendText(sess.ws, { type: "media_control", action });
  return true;
}

function setAudioQueue(deviceId, queue) {
  if (Array.isArray(queue) && queue.length > 0) {
    _audioQueues.set(deviceId, [...queue]);
  } else {
    _audioQueues.delete(deviceId);
  }
}
function popAudioQueue(deviceId) {
  const q = _audioQueues.get(deviceId);
  if (!q || q.length === 0) return null;
  const next = q.shift();
  if (q.length === 0) _audioQueues.delete(deviceId);
  return next;
}
function clearAudioQueue(deviceId) {
  _audioQueues.delete(deviceId);
  const w = _streamDoneWaiters.get(deviceId);
  if (w) {
    clearTimeout(w.timer);
    _streamDoneWaiters.delete(deviceId);
    w.reject(new Error("queue cleared"));
  }
}

function waitForStreamDone(deviceId, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _streamDoneWaiters.delete(deviceId);
      reject(new Error("audio_stream_done timeout"));
    }, timeoutMs);
    _streamDoneWaiters.set(deviceId, { resolve, reject, timer });
  });
}

/* ---------- Server-initiated TTS (Phase 3) ---------- */

const DEVICE_PRESENCE_MS = 60_000;
const MUTEX_DEFER_MS = 30_000;

function deviceIsPresent(deviceId) {
  const s = _sessions.get(deviceId);
  if (!s) return false;
  if (!s.lastPingAt) return (Date.now() - (s.openedAt || 0)) < DEVICE_PRESENCE_MS;
  return (Date.now() - s.lastPingAt) < DEVICE_PRESENCE_MS;
}

export function isQuietHours(quietHoursStr, date = new Date()) {
  // "HH:MM-HH:MM" in local time. Wrap-around supported.
  if (!quietHoursStr || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(quietHoursStr)) return false;
  const [start, end] = quietHoursStr.split("-");
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = date.getHours() * 60 + date.getMinutes();
  const sMins = sh * 60 + sm, eMins = eh * 60 + em;
  return sMins <= eMins
    ? (mins >= sMins && mins < eMins)
    : (mins >= sMins || mins < eMins);
}

/**
 * Deliver `text` to device `deviceId` as TTS, subject to policy.
 * Policy is enforced by the caller (scheduler) or opt-in here via opts.
 *
 * Returns { delivered: boolean, reason?: string }.
 */
export async function pushTtsToDevice(deviceId, text) {
  if (!deviceId || !text) return { delivered: false, reason: "bad_args" };
  if (!deviceIsPresent(deviceId)) return { delivered: false, reason: "absent" };
  const sess = _sessions.get(deviceId);
  if (!sess?.ws) return { delivered: false, reason: "absent" };
  // Never beside a turn or a relay on the same socket: wait for the lock, give up after MUTEX_DEFER_MS.
  if (!(await waitForTurnLock(deviceId, sess.ws, MUTEX_DEFER_MS))) return { delivered: false, reason: "mutex_timeout" };
  try {
    return await glassesTurns.speak({
      deviceId, text,
      send: { text: (o) => sendText(sess.ws, o), binary: (b) => sendBinary(sess.ws, b) },
    });
  } catch (err) {
    return { delivered: false, reason: err.message };
  } finally {
    releaseTurnLock(deviceId, sess.ws);
  }
}

/* ---------- Scheduler hooks ----------
 * The gateway's scheduler calls these through servers/gateway/scheduler-hooks.js; it never
 * imports this file. They run only in a gateway that loaded this bundle, whatever its port.
 */

/** Every tick: caption fill-in. Once a day in the 03:00 hour: photo retention, claimed in the database. */
async function glassesSchedulerTick(db) {
  try { await runCaptionBackfill(db); } catch { /* next tick retries */ }
  const now = new Date();
  if (now.getHours() !== 3) return;
  const today = now.toISOString().slice(0, 10);
  // Compare-and-set on the day: any tick in the hour can win, two gateways on one database
  // cannot both win, and a non-date value is never overwritten.
  const claim = await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value, updated_at)
          VALUES ('meta_glasses_last_retention_run', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
          WHERE value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND value < excluded.value`,
    args: [today],
  });
  if (Number(claim.rowsAffected || 0) < 1) return;
  const summary = await runPhotoRetention(db);
  console.log(`[meta-glasses] retention: ${JSON.stringify(summary)}`);
}

/** A scheduled reminder fired: speak it on connected glasses when the operator opted in and it is not quiet hours. */
async function glassesReminder(db, { type, text } = {}) {
  if (!type || !text) return;
  const { readSetting } = await loadSettingsReg();
  const toggle = await readSetting(db, `meta_glasses_voice_notify_${type}`);
  if (toggle !== "1" && toggle !== "true") return;
  if (isQuietHours((await readSetting(db, "meta_glasses_voice_quiet_hours")) || "")) return;
  const { listDevices } = await loadDeviceStore();
  for (const d of (await listDevices(db)).filter(isGlassesRecord)) {
    const res = await pushTtsToDevice(d.id, text);
    if (res?.delivered) console.log(`[meta-glasses] reminder spoken on ${d.id}`);
  }
}

registerSchedulerHook("meta-glasses", { tick: glassesSchedulerTick, reminder: glassesReminder });
