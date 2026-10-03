/**
 * ntfy Push — Self-hosted push notification sender
 *
 * Publishes notifications to a local ntfy server instance. Where it publishes comes from
 * resolveNtfyConfig() (ntfy-config.js): the NTFY_* environment when NTFY_TOPIC is set
 * (unchanged pre-autowire behavior), else the instance's autowired ntfy-push.json.
 * DB-free by design — the corruption/migration alerts call this directly.
 */
import { resolveNtfyConfig, recordNtfyStatus } from "./ntfy-config.js";

const PRIORITY_MAP = {
  low: "2",
  normal: "3",
  high: "5",
};

const TAG_MAP = {
  peer: "incoming_envelope",
  reminder: "alarm_clock",
  system: "gear",
  media: "musical_note",
  // Track 3 Task 8: perch-interactive turn-end / ask-card / gated-result pushes.
  attention: "bird",
};

/**
 * Send a notification via ntfy.
 *
 * @param {object} opts
 * @param {string} opts.title - Notification title
 * @param {string} [opts.body] - Notification body text
 * @param {string} [opts.url] - Click action URL (relative or absolute)
 * @param {string} [opts.priority='normal'] - 'low', 'normal', 'high'
 * @param {string} [opts.type='system'] - Notification type for tag mapping
 */
/**
 * HTTP headers can only carry ISO-8859-1 bytes. Node's fetch throws
 * `Cannot convert argument to a ByteString because the character at index
 * N has a value of <codepoint> which is greater than 255` if X-Title
 * contains anything outside that range — em-dashes, curly quotes, emoji,
 * etc. ntfy's server accepts RFC 2047-encoded headers (`=?utf-8?B?...?=`)
 * for full UTF-8 round-tripping, which is what this helper emits.
 */
function encodeNtfyHeader(value) {
  if (!value) return value;
  // Fast path: pure ASCII (most titles) — avoids base64 overhead.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?utf-8?B?${b64}?=`;
}

/**
 * @returns {Promise<{ok:boolean, status?:number, error?:string, skipped?:boolean}>} never throws
 */
export async function sendNtfyNotification({ title, body, url, priority = "normal", type = "system" }) {
  let cfg;
  try { cfg = resolveNtfyConfig(); } catch { cfg = null; }
  if (!cfg) return { ok: false, skipped: true };

  const ntfyUrl = `http://${cfg.publishHost}:${cfg.publishPort}/${encodeURIComponent(cfg.topic)}`;

  const headers = {
    "X-Title": encodeNtfyHeader(title),
    "X-Priority": PRIORITY_MAP[priority] || "3",
  };

  // Build full click URL. Satellite instances (e.g. MPA) should set
  // NTFY_CLICK_BASE_URL to the home-instance's gateway URL — that is where
  // the user's paired Android app and browser sessions actually live, so
  // the tap destination has to match. Without this override, an MPA push
  // gets `X-Click: https://…:8447/…` (MPA's own URL) and the paired-to-
  // primary APK sees the prefix mismatch and falls back to
  // `/dashboard/nest` instead of opening the intended page. Falls back to
  // CROW_GATEWAY_URL for single-instance deployments where the publishing
  // gateway is also the user's paired gateway.
  if (url) {
    const clickBase = process.env.NTFY_CLICK_BASE_URL || process.env.CROW_GATEWAY_URL || "";
    headers["X-Click"] = url.startsWith("http") ? url : clickBase + url;
  }

  const tag = TAG_MAP[type];
  if (tag) {
    headers["X-Tags"] = tag;
  }

  if (cfg.publishToken) {
    headers["Authorization"] = `Bearer ${cfg.publishToken}`;
  }

  // Bound the send (2c follow-up F2/C2a): createNotification awaits this
  // sender from the instance-sync apply path — an unbounded hang on a
  // half-open socket wedges boot or the live apply loop. A timed-out send
  // lands in the same catch as any other failed send (already tolerated).
  const timeoutMs = parseInt(process.env.CROW_PUSH_SEND_TIMEOUT_MS, 10) || 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let result;
  try {
    const res = await fetch(ntfyUrl, {
      method: "POST",
      headers,
      body: body || title,
      signal: controller.signal,
    });
    // A refused publish (401/403 from an auth-enabled server) used to vanish here.
    result = res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `ntfy answered HTTP ${res.status}` };
    try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
  } catch (err) {
    // ntfy server not available or send timed out — never propagate
    result = { ok: false, error: err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
  recordNtfyStatus({
    lastPushAt: new Date().toISOString(),
    lastPushOk: result.ok,
    lastPushStatus: result.status ?? null,
    lastPushError: result.ok ? null : String(result.error).slice(0, 200),
    lastPushSource: cfg.source,
  });
  return result;
}
