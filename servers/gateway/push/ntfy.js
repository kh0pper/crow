/**
 * ntfy Push — Self-hosted push notification sender
 *
 * Publishes notifications to a local ntfy server instance.
 * Requires NTFY_TOPIC env var. NTFY_PORT defaults to 2586.
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
export async function sendNtfyNotification({ title, body, url, priority = "normal", type = "system" }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  const port = process.env.NTFY_PORT || "2586";
  const authToken = process.env.NTFY_AUTH_TOKEN;
  const ntfyUrl = `http://localhost:${port}/${encodeURIComponent(topic)}`;

  const headers = {
    "X-Title": title,
    "X-Priority": PRIORITY_MAP[priority] || "3",
  };

  // Build full click URL if we have a gateway URL
  if (url) {
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    headers["X-Click"] = url.startsWith("http") ? url : gatewayUrl + url;
  }

  const tag = TAG_MAP[type];
  if (tag) {
    headers["X-Tags"] = tag;
  }

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    await fetch(ntfyUrl, {
      method: "POST",
      headers,
      body: body || title,
    });
  } catch {
    // ntfy server not available — fail silently
  }
}
