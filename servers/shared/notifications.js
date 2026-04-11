/**
 * Notification Helper — Shared notification creation logic
 *
 * Used by scheduler, media tasks, peer messages, and MCP tools
 * to create notifications with preference-aware filtering.
 */

const MAX_NOTIFICATIONS = 500;

/**
 * Create a notification, respecting user preferences.
 *
 * @param {object} db - Database client
 * @param {object} opts
 * @param {string} opts.title - Short headline (required)
 * @param {string} [opts.body] - Longer description
 * @param {string} [opts.type='system'] - 'reminder', 'media', 'peer', 'system'
 * @param {string} [opts.source] - Origin identifier (e.g. 'scheduler', 'media:briefing')
 * @param {string} [opts.priority='normal'] - 'low', 'normal', 'high'
 * @param {string} [opts.action_url] - Dashboard link
 * @param {object} [opts.metadata] - Structured data (stored as JSON)
 * @param {number} [opts.schedule_id] - FK to schedules table
 * @param {number} [opts.expires_in_minutes] - Auto-expire after N minutes
 * @returns {Promise<{id: number}|null>} Notification ID or null if filtered out
 */
export async function createNotification(db, opts) {
  const {
    title,
    body = null,
    type = "system",
    source = null,
    priority = "normal",
    action_url = null,
    metadata = null,
    schedule_id = null,
    expires_in_minutes = null,
  } = opts;

  // Check preferences — skip if this type is disabled
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
      args: [],
    });
    if (rows.length > 0) {
      const prefs = JSON.parse(rows[0].value);
      if (prefs.types_enabled && !prefs.types_enabled.includes(type)) {
        return null;
      }
    }
  } catch {
    // No prefs set — allow all types
  }

  const expiresAt = expires_in_minutes
    ? new Date(Date.now() + expires_in_minutes * 60000).toISOString()
    : null;

  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  const result = await db.execute({
    sql: `INSERT INTO notifications (type, source, title, body, priority, action_url, metadata, schedule_id, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [type, source, title, body, priority, action_url, metadataJson, schedule_id, expiresAt],
  });

  // Send web push notification (non-blocking, fails silently when not available)
  try {
    const { sendPushToAll } = await import("../gateway/push/web-push.js");
    await sendPushToAll(db, { title, body: body || title, url: action_url });
  } catch {
    // Push module not available (non-gateway context) — skip silently
  }

  // Send ntfy notification (non-blocking, fails silently when not configured)
  try {
    const { sendNtfyNotification } = await import("../gateway/push/ntfy.js");
    await sendNtfyNotification({ title, body: body || title, url: action_url, priority, type });
  } catch {
    // ntfy module not available or not configured — skip silently
  }

  return { id: Number(result.lastInsertRowid) };
}

/**
 * Clean up expired notifications and enforce retention limit.
 * Called periodically by the scheduler and on notification queries.
 *
 * @param {object} db - Database client
 */
export async function cleanupNotifications(db) {
  const now = new Date().toISOString();

  // Remove expired notifications
  await db.execute({
    sql: "DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at <= ?",
    args: [now],
  });

  // Enforce max retention: delete oldest dismissed notifications when over limit
  const { rows } = await db.execute("SELECT COUNT(*) as count FROM notifications");
  const total = rows[0].count;

  if (total > MAX_NOTIFICATIONS) {
    const excess = total - MAX_NOTIFICATIONS;
    await db.execute({
      sql: `DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications WHERE is_dismissed = 1 ORDER BY created_at ASC LIMIT ?
      )`,
      args: [excess],
    });

    // If still over limit after removing dismissed, remove oldest read
    const { rows: recheck } = await db.execute("SELECT COUNT(*) as count FROM notifications");
    if (recheck[0].count > MAX_NOTIFICATIONS) {
      const stillExcess = recheck[0].count - MAX_NOTIFICATIONS;
      await db.execute({
        sql: `DELETE FROM notifications WHERE id IN (
          SELECT id FROM notifications WHERE is_read = 1 ORDER BY created_at ASC LIMIT ?
        )`,
        args: [stillExcess],
      });
    }
  }
}
