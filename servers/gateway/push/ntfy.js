/**
 * ntfy Push — Self-hosted push notification sender
 *
 * Publishes notifications to a local ntfy server instance.
 * Requires NTFY_TOPIC env var. NTFY_HOST defaults to localhost; NTFY_PORT defaults to 2586.
 * NTFY_AUTH_TOKEN is optional (for private topics).
 */

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

export async function sendNtfyNotification({ title, body, url, priority = "normal", type = "system" }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  const host = process.env.NTFY_HOST || "localhost";
  const port = process.env.NTFY_PORT || "2586";
  const authToken = process.env.NTFY_AUTH_TOKEN;
  const ntfyUrl = `http://${host}:${port}/${encodeURIComponent(topic)}`;

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

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  // Bound the send (2c follow-up F2/C2a): createNotification awaits this
  // sender from the instance-sync apply path — an unbounded hang on a
  // half-open socket wedges boot or the live apply loop. A timed-out send
  // lands in the same catch as any other failed send (already tolerated).
  const timeoutMs = parseInt(process.env.CROW_PUSH_SEND_TIMEOUT_MS, 10) || 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(ntfyUrl, {
      method: "POST",
      headers,
      body: body || title,
      signal: controller.signal,
    });
  } catch {
    // ntfy server not available or send timed out — fail silently
  } finally {
    clearTimeout(timer);
  }
}
