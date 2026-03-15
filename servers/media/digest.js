/**
 * Email Digest Module
 *
 * Sends digest emails of top articles using nodemailer (optional dependency).
 * Supports scheduled delivery: daily_morning, daily_evening, weekly.
 */

/**
 * Check if nodemailer is available.
 * @returns {Promise<boolean>}
 */
export async function isNodemailerAvailable() {
  try {
    await import("nodemailer");
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a nodemailer transport from env vars.
 */
async function createTransport() {
  const nodemailer = await import("nodemailer");
  return nodemailer.default.createTransport({
    host: process.env.CROW_SMTP_HOST,
    port: parseInt(process.env.CROW_SMTP_PORT || "587", 10),
    secure: process.env.CROW_SMTP_PORT === "465",
    auth: {
      user: process.env.CROW_SMTP_USER,
      pass: process.env.CROW_SMTP_PASS,
    },
  });
}

/**
 * Render digest HTML from articles.
 * @param {Array} articles - Article rows
 * @param {string} [customInstructions] - Custom summary instructions
 * @returns {string} HTML email body
 */
export function renderDigestHtml(articles, customInstructions) {
  const header = customInstructions
    ? `<p style="color:#666;font-style:italic;margin-bottom:1rem">${escapeHtml(customInstructions)}</p>`
    : "";

  const articleCards = articles.map((a) => {
    const date = a.pub_date ? new Date(a.pub_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    const summary = a.summary ? escapeHtml(a.summary.slice(0, 200)) : "";
    return `<div style="margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:1px solid #eee">
      <h3 style="margin:0 0 0.25rem;font-size:1rem"><a href="${escapeHtml(a.url || "#")}" style="color:#1a1a1a;text-decoration:none">${escapeHtml(a.title)}</a></h3>
      <div style="font-size:0.8rem;color:#888;margin-bottom:0.35rem">${escapeHtml(a.source_name || "")} · ${date}</div>
      ${summary ? `<p style="margin:0;font-size:0.9rem;color:#444;line-height:1.4">${summary}</p>` : ""}
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:1rem;color:#1a1a1a">
  <h2 style="font-size:1.3rem;margin-bottom:0.5rem">Your Crow Media Digest</h2>
  <p style="color:#666;font-size:0.85rem;margin-bottom:1.5rem">${articles.length} article${articles.length !== 1 ? "s" : ""} curated for you</p>
  ${header}
  ${articleCards}
  <p style="color:#999;font-size:0.75rem;margin-top:2rem;text-align:center">Sent by Crow Media · Manage in your Crow's Nest settings</p>
</body></html>`;
}

/**
 * Send a digest email.
 * @param {string} email - Recipient email
 * @param {Array} articles - Article rows
 * @param {object} [options] - { customInstructions }
 */
export async function sendDigest(email, articles, options = {}) {
  if (!process.env.CROW_SMTP_HOST) {
    throw new Error("SMTP not configured. Set CROW_SMTP_HOST, CROW_SMTP_USER, CROW_SMTP_PASS in .env");
  }

  const transport = await createTransport();
  const html = renderDigestHtml(articles, options.customInstructions);
  const from = process.env.CROW_SMTP_FROM || process.env.CROW_SMTP_USER || "crow@localhost";

  await transport.sendMail({
    from,
    to: email,
    subject: `Crow Media Digest — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`,
    html,
  });
}

/**
 * Check digest preferences and send if schedule is due.
 * @param {object} db - Database client
 */
export async function checkAndSendDigests(db) {
  if (!(await isNodemailerAvailable())) return;
  if (!process.env.CROW_SMTP_HOST) return;

  const { rows: prefs } = await db.execute(
    "SELECT * FROM media_digest_preferences WHERE enabled = 1 AND email IS NOT NULL"
  );

  for (const pref of prefs) {
    if (!isDue(pref.schedule, pref.last_sent)) continue;

    try {
      // Get top unread articles
      const { rows: articles } = await db.execute({
        sql: `SELECT a.id, a.title, a.url, a.pub_date, a.summary,
                     s.name as source_name
              FROM media_articles a
              JOIN media_sources s ON s.id = a.source_id
              LEFT JOIN media_article_states st ON st.article_id = a.id
              WHERE COALESCE(st.is_read, 0) = 0 AND s.enabled = 1
              ORDER BY a.pub_date DESC NULLS LAST
              LIMIT 15`,
        args: [],
      });

      if (articles.length === 0) continue;

      await sendDigest(pref.email, articles, {
        customInstructions: pref.custom_instructions,
      });

      await db.execute({
        sql: "UPDATE media_digest_preferences SET last_sent = datetime('now') WHERE id = ?",
        args: [pref.id],
      });
    } catch (err) {
      console.error(`[digest] Failed to send to ${pref.email}:`, err.message);
    }
  }
}

/**
 * Check if a digest is due based on schedule and last_sent.
 */
function isDue(schedule, lastSent) {
  const now = new Date();
  const hour = now.getHours();

  if (lastSent) {
    const last = new Date(lastSent);
    const hoursSince = (now - last) / 3600000;

    switch (schedule) {
      case "daily_morning":
        return hoursSince >= 20 && hour >= 7 && hour <= 10;
      case "daily_evening":
        return hoursSince >= 20 && hour >= 17 && hour <= 20;
      case "weekly":
        return hoursSince >= 144 && now.getDay() === 1 && hour >= 7 && hour <= 10; // Monday morning
      default:
        return hoursSince >= 20 && hour >= 7 && hour <= 10;
    }
  }

  // Never sent — check time window
  switch (schedule) {
    case "daily_morning":
      return hour >= 7 && hour <= 10;
    case "daily_evening":
      return hour >= 17 && hour <= 20;
    case "weekly":
      return now.getDay() === 1 && hour >= 7 && hour <= 10;
    default:
      return hour >= 7 && hour <= 10;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
