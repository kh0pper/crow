/**
 * F3b — bot-runtime self-gating. The dashboard toggle writes
 * feature_flags.bot_runtime; the long-lived runners poll it here and
 * start/stop their adapters in-process — so the toggle takes effect with NO
 * restart and NO privilege ("off" = idle process, not a stopped unit).
 *
 * Runners use better-sqlite3 (sync). The async panel reader
 * (bot-runtime-flag.js botRuntimeActive) mirrors this same resolve rule;
 * they're intentionally kept as two tiny readers (no cross-layer/async-sync
 * coupling) — the future mpa-detect.js dedup unifies isMpaHost.
 */
import { getOrCreateLocalInstanceId } from "../../servers/gateway/instance-registry.js";

/** Mirror of bot-runtime-flag.js isMpaHost() — auto-detect the MPA host. */
function isMpaHost() {
  const probe = `${process.env.CROW_HOME || ""}|${process.env.CROW_DATA_DIR || ""}`;
  return /\.crow-mpa(\/|\b|$)/.test(probe);
}

/** Resolve the rule from a parsed feature_flags object (shared with the panel). */
function resolveBotRuntime(flags) {
  if (flags && typeof flags.bot_runtime === "boolean") return flags.bot_runtime;
  return isMpaHost();
}

/**
 * Synchronous, scope-resolved read of feature_flags.bot_runtime over
 * better-sqlite3 (override-by-local-instance first, then global). Never throws.
 */
export function botRuntimeEnabledSync(conn) {
  try {
    let raw = null;
    let localId = null;
    try { localId = getOrCreateLocalInstanceId(); } catch {}
    if (localId) {
      const ov = conn.prepare("SELECT value FROM dashboard_settings_overrides WHERE key='feature_flags' AND instance_id=?").get(localId);
      if (ov && ov.value != null) raw = ov.value;
    }
    if (raw == null) {
      const gl = conn.prepare("SELECT value FROM dashboard_settings WHERE key='feature_flags'").get();
      if (gl && gl.value != null) raw = gl.value;
    }
    let flags = null;
    if (raw != null) { try { flags = JSON.parse(raw); } catch { flags = null; } }
    return resolveBotRuntime(flags);
  } catch {
    return false;
  }
}

/**
 * Drive start()/stop() on bot_runtime transitions. Returns { dispose() }.
 * @param {object} db better-sqlite3 connection (re-read each poll)
 * @param {object} o { start, stop, pollMs=30000, logTag, _isActive? }
 */
export function runtimeGate(db, { start, stop, pollMs = 30000, logTag = "runtime-gate", _isActive } = {}) {
  const isActive = _isActive || (() => botRuntimeEnabledSync(db));
  let running = false;
  const log = (m) => console.log(`[${logTag}] ${m}`);

  const tick = () => {
    let active;
    try { active = !!isActive(); } catch { active = false; }
    if (active && !running) {
      try { start(); running = true; log("bot_runtime ON — adapters started"); }
      catch (e) { log("start failed (will retry): " + ((e && e.message) || e)); }
    } else if (!active && running) {
      try { stop(); } catch (e) { log("stop error (non-fatal): " + ((e && e.message) || e)); }
      running = false; log("bot_runtime OFF — adapters stopped (idle)");
    }
  };

  tick(); // boot
  const timer = setInterval(tick, pollMs);
  if (timer.unref) timer.unref();
  return { dispose() { clearInterval(timer); } };
}
