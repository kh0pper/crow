/**
 * Live voice surfaces and the spoken heads-up (PR 5, Task 5.2). A surface that can speak right now (a kiosk, the
 * phone's Talk to Crow overlay, a pair of glasses) registers itself while its socket is open; `announce` then says a
 * short line on the one the operator is still talking to: "Writer finished research radio history. It's on your
 * phone." It is the one speaking entry point for work that ends outside a turn (the hand-off's completion and
 * start-failed reports; R1.2's late answers reuse it) [bc m3].
 *
 *   registerVoiceSurface(deviceId, { surface, speak, lastTurnAt, connected, busy }) → unregister()
 *     surface      "phone" | "kiosk" | "glasses"
 *     speak(text)  → Promise<boolean>: true only when the line was really handed to the surface's speech
 *     lastTurnAt() → epoch ms of the operator's last turn there, or null
 *     connected()  → boolean
 *     busy()       → boolean, REQUIRED (P27): a turn, speech or an open mic. A relay turn counts as busy.
 *   announce({ originDeviceId, lineFor, now = Date.now }) → Promise<{ spokenOn: deviceId|null, surface? }>
 *   trackTurn(deviceId) → done(): runVoiceTurn marks every turn it runs (a relay turn included), so a surface whose
 *     own busy() cannot see a turn run outside its hub is still busy while one runs.
 *
 * Who hears it: the origin (the device the hand-off was asked on) when it is connected and had a turn within
 * VOICE_MODE_WINDOW_MS; else the personal surface (never a kiosk) with the newest turn in that window; else nobody.
 * It speaks once at most. A busy target is asked again once after ANNOUNCE_RETRY_MS, and if it is still busy (or
 * gone) nothing is said (P27). Every surface callback is guarded: a throw never reaches the caller, and a busy()
 * that throws counts as busy.
 *
 * The registry lives on globalThis[Symbol.for("crow.voice.presence")] [rv1 S], so a bundle that loaded this file
 * under another APP_ROOT (a second module instance) registers into the same map the gateway announces from.
 */
import { VOICE_MODE_WINDOW_MS } from "./voice-memory.js";

export const PRESENCE_SURFACES = Object.freeze(["phone", "kiosk", "glasses"]);
/** A busy target is asked once more after this long. */
export const ANNOUNCE_RETRY_MS = 5000;

const REGISTRY = Symbol.for("crow.voice.presence");
const state = (globalThis[REGISTRY] ??= { surfaces: new Map(), turns: new Map() });
state.surfaces ??= new Map();   // deviceId → entry
state.turns ??= new Map();      // deviceId → turns running now
const { surfaces, turns } = state;

function defaultWait(ms) {
  return new Promise((res) => { const t = setTimeout(res, ms); if (t && typeof t.unref === "function") t.unref(); });
}

/**
 * Register (or replace) the live surface for `deviceId`. The returned unregister removes THIS registration only, so
 * a superseded socket closing late never drops the newer one.
 */
export function registerVoiceSurface(deviceId, impl) {
  if (typeof deviceId !== "string" || !deviceId) throw new Error("presence: a device id is required");
  if (!PRESENCE_SURFACES.includes(impl?.surface)) throw new Error(`presence: bad surface ${JSON.stringify(impl?.surface)}`);
  for (const fn of ["speak", "lastTurnAt", "connected", "busy"]) {
    if (typeof impl[fn] !== "function") throw new Error(`presence: surface ${deviceId} needs a ${fn} function`);
  }
  const entry = { deviceId, surface: impl.surface, speak: impl.speak, lastTurnAt: impl.lastTurnAt, connected: impl.connected, busy: impl.busy };
  surfaces.set(deviceId, entry);
  return () => { if (surfaces.get(deviceId) === entry) surfaces.delete(deviceId); };
}

/** A turn started on `deviceId` (turn.js runVoiceTurn); call the returned function once it ends. */
export function trackTurn(deviceId) {
  if (typeof deviceId !== "string" || !deviceId) return () => {};
  turns.set(deviceId, (turns.get(deviceId) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (turns.get(deviceId) || 0) - 1;
    if (n > 0) turns.set(deviceId, n); else turns.delete(deviceId);
  };
}

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/** Connected, with an operator turn within the voice-mode window. → that turn's time, or null. */
function activeAt(e, at) {
  if (safe(() => e.connected(), false) !== true) return null;
  const t = safe(() => e.lastTurnAt(), null);
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return at - t <= VOICE_MODE_WINDOW_MS ? t : null;
}

/** A turn running through runVoiceTurn, or the surface's own busy() (a throw counts as busy). */
function isBusy(e) {
  if ((turns.get(e.deviceId) || 0) > 0) return true;
  return safe(() => e.busy(), true) !== false;
}

/** The surface to speak on now, or null (see the header). */
function pickTarget(originDeviceId, at) {
  const origin = typeof originDeviceId === "string" ? surfaces.get(originDeviceId) : null;
  if (origin && activeAt(origin, at) != null) return origin;
  let best = null, bestAt = -Infinity;
  for (const e of surfaces.values()) {
    if (e.surface === "kiosk") continue;          // a shared display is spoken to only as the origin
    const t = activeAt(e, at);
    if (t != null && t > bestAt) { best = e; bestAt = t; }
  }
  return best;
}

/**
 * Say `lineFor(surface)` once, on the surface the operator is still talking to. → { spokenOn: the device id spoken
 * on, surface } or { spokenOn: null }. Never throws.
 */
export async function announce({ originDeviceId, lineFor, now = Date.now, wait = defaultWait, retryMs = ANNOUNCE_RETRY_MS, log = (m) => console.warn(m) } = {}) {
  const none = { spokenOn: null };
  if (typeof lineFor !== "function") return none;
  const clock = typeof now === "function" ? now : Date.now;
  const target = pickTarget(originDeviceId, clock());
  if (!target) return none;
  const text = safe(() => lineFor(target.surface), "");
  if (typeof text !== "string" || !text.trim()) return none;
  // P27: busy is checked right before speaking; a busy target gets one retry, and must still be live and idle then.
  const live = () => surfaces.get(target.deviceId) === target && activeAt(target, clock()) != null;
  if (isBusy(target)) {
    await wait(retryMs);
    if (!live() || isBusy(target)) return none;
  }
  let ok = false;
  try { ok = (await target.speak(text)) === true; }
  catch (err) { log(`[voice-presence] ${target.deviceId}: speak failed (${err?.message || err})`); ok = false; }
  return ok ? { spokenOn: target.deviceId, surface: target.surface } : none;
}

/** The registered surfaces, for diagnostics and tests: [{ deviceId, surface }]. */
export function voiceSurfaces() {
  return [...surfaces.values()].map((e) => ({ deviceId: e.deviceId, surface: e.surface }));
}

/** A fresh process: no surfaces and no running turns. */
export function _resetPresenceForTest() {
  surfaces.clear();
  turns.clear();
}
