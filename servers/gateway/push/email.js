/**
 * Email Push — Resend API sender
 *
 * Fallback channel for notifications when the phone's NtfyListenerService
 * stream is paused by Android Doze. Only fires for high-priority or
 * briefing-type notifications to keep the inbox quiet.
 *
 * Requires RESEND_API_KEY, MPA_EMAIL_FROM, MPA_EMAIL_TO. Skipped silently
 * if any are missing, so non-MPA instances of this gateway code never send.
 */

function shouldEmail({ priority, type }) {
  return priority === "high" || type === "briefing";
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal markdown-ish → HTML so briefing bodies render as something
 * better than a wall of text in the email client. Only handles the
 * constructs MPA pipelines emit: `# heading`, `## heading`, `- bullet`,
 * bare paragraphs, and links of the form `[text](url)`. Anything else
 * passes through HTML-escaped.
 */
function renderBodyHtml(body) {
  if (!body) return "";
  const lines = body.split("\n");
  const out = [];
  let inList = false;
  const flushList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const linkify = (s) =>
    escapeHtml(s).replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, text, href) => `<a href="${href}">${text}</a>`,
    );
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      out.push(`<h3>${linkify(line.slice(3))}</h3>`);
    } else if (line.startsWith("# ")) {
      flushList();
      out.push(`<h2>${linkify(line.slice(2))}</h2>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${linkify(line.slice(2))}</li>`);
    } else {
      flushList();
      out.push(`<p>${linkify(line)}</p>`);
    }
  }
  flushList();
  return out.join("\n");
}

export async function sendEmailNotification({
  title,
  body,
  url,
  priority = "normal",
  type = "system",
}) {
  if (!shouldEmail({ priority, type })) return;

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MPA_EMAIL_FROM;
  const to = process.env.MPA_EMAIL_TO;
  if (!apiKey || !from || !to) return;

  const clickBase = process.env.NTFY_CLICK_BASE_URL || process.env.CROW_GATEWAY_URL || "";
  const clickUrl = url ? (url.startsWith("http") ? url : clickBase + url) : null;

  const subject = priority === "high" ? `[MPA] ${title}` : title;
  const bodyHtml = renderBodyHtml(body);
  const footerHtml = clickUrl
    ? `<p style="margin-top:24px;color:#666;font-size:13px">Open in Crow: <a href="${clickUrl}">${escapeHtml(clickUrl)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:640px">${bodyHtml}${footerHtml}</body></html>`;

  const text =
    (body || title) + (clickUrl ? `\n\nOpen in Crow: ${clickUrl}` : "");

  // Bound the send (2c follow-up F2/C2a): createNotification awaits this
  // sender from the instance-sync apply path — an unbounded hang on a
  // half-open socket wedges boot or the live apply loop. A timed-out send
  // lands in the same catch as any other failed send (already tolerated).
  const timeoutMs = parseInt(process.env.CROW_PUSH_SEND_TIMEOUT_MS, 10) || 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        html,
        text,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[push/email] Resend ${res.status}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[push/email] fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
