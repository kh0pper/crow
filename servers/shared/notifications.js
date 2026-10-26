/**
 * Notification Helper — Shared notification creation logic
 *
 * Used by scheduler, media tasks, peer messages, and MCP tools
 * to create notifications with preference-aware filtering.
 */

import bus from "./event-bus.js";
import { maskSecrets, maskDeep } from "./secret-mask.js";

const MAX_NOTIFICATIONS = 500;

/**
 * Approval-card secret masking (2026-10-26): a notification's text is display
 * text that is stored, shown and pushed (web push, ntfy, email), and a bot can
 * write one (crow_create_notification) or quote a command in one. Masked at
 * the row write AND at delivery, so no caller has to remember. Display-only.
 */
const maskText = (v) => (v == null ? v : maskSecrets(v));

/**
 * Create a notification, respecting user preferences.
 *
 * @param {object} db - Database client
 * @param {object} opts
 * @param {string} opts.title - Short headline (required)
 * @param {string} [opts.body] - Longer description
 * @param {string} [opts.type='system'] - 'reminder', 'media', 'peer', 'system',
 *   'attention' (Track 3 Task 8: a bot turn/ask-card/gated-result needs an
 *   operator's eyes — the gate below is data-driven off dashboard_settings,
 *   so this comment is documentation only, never enforced)
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
    title: rawTitle,
    body: rawBody = null,
    type = "system",
    source = null,
    priority = "normal",
    action_url = null,
    metadata = null,
    schedule_id = null,
    expires_in_minutes = null,
  } = opts;
  const title = maskText(rawTitle);
  const body = maskText(rawBody);

  if (!(await typeEnabled(db, type))) return null;

  const expiresAt = expires_in_minutes
    ? new Date(Date.now() + expires_in_minutes * 60000).toISOString()
    : null;

  const metadataJson = metadata ? JSON.stringify(maskDeep(metadata)) : null;

  const result = await db.execute({
    sql: `INSERT INTO notifications (type, source, title, body, priority, action_url, metadata, schedule_id, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [type, source, title, body, priority, action_url, metadataJson, schedule_id, expiresAt],
  });

  await broadcastUnread(db);
  await deliverNotification(db, { title, body, action_url, priority, type });

  return { id: Number(result.lastInsertRowid) };
}

/** The notification_prefs type gate: false when this type is switched off. */
async function typeEnabled(db, type) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
      args: [],
    });
    if (rows.length > 0) {
      const prefs = JSON.parse(rows[0].value);
      if (prefs.types_enabled && !prefs.types_enabled.includes(type)) return false;
    }
  } catch {
    // No prefs set — allow all types
  }
  return true;
}

/**
 * Broadcast a bell-badge refresh to any live Turbo Stream subscribers.
 * Compute the unread count here (not per-subscriber) so 5 open tabs don't
 * each hit the DB on every notification. Fail-open: a subscriber error must
 * never break the primary write or the push paths.
 */
async function broadcastUnread(db) {
  try {
    const { rows } = await db.execute({
      sql: `SELECT COUNT(*) AS count FROM notifications
            WHERE is_read = 0 AND is_dismissed = 0
              AND (snoozed_until IS NULL OR julianday(snoozed_until) <= julianday('now'))
              AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`,
      args: [],
    });
    const unreadCount = Number(rows?.[0]?.count ?? 0);
    bus.emit("notifications:changed", { unreadCount });
  } catch {
    // Logging/stream failure must not cascade. The row is already
    // written; polling fallback will reconcile within 5 min.
  }
}

/**
 * Fan a notification out to the off-dashboard channels (web push, ntfy,
 * email) WITHOUT writing a row. createNotification calls it for every new
 * row; a grouped notification's re-push calls it on its own. Every channel
 * is optional and fails silently.
 */
export async function deliverNotification(db, { title: rawTitle, body: rawBody = null, action_url = null, priority = "normal", type = "system" }) {
  const title = maskText(rawTitle);
  const body = maskText(rawBody);
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

  // Send email notification. The helper has its own predicate
  // (priority=high OR type=briefing) and a hard gate on RESEND_API_KEY +
  // MPA_EMAIL_FROM + MPA_EMAIL_TO, so primary and any non-MPA gateway
  // that inherits this code never sends unless explicitly configured.
  try {
    const { sendEmailNotification } = await import("../gateway/push/email.js");
    await sendEmailNotification({ title, body: body || title, url: action_url, priority, type });
  } catch {
    // email module not available or not configured — skip silently
  }
}

/** Newest items a grouped notification keeps in its metadata. */
export const GROUP_ITEMS_MAX = 50;

const OPEN_GROUP_SQL =
  "SELECT id, metadata, body, action_url, snoozed_until FROM notifications " +
  "WHERE source = ? AND is_read = 0 AND is_dismissed = 0 ORDER BY id DESC LIMIT 1";

function groupOf(metadataText, groupKey) {
  let meta = {};
  try { meta = JSON.parse(metadataText || "{}") || {}; } catch { meta = {}; }
  const g = meta.group && typeof meta.group === "object" ? meta.group : {};
  return {
    meta,
    group: {
      key: groupKey,
      count: Number(g.count) || 0,
      items: Array.isArray(g.items) ? g.items.slice() : [],
      items_dropped: Number(g.items_dropped) || 0,
      last_push_at: Number(g.last_push_at) || 0,
      pushed_count: Number(g.pushed_count) || 0,
    },
  };
}

/**
 * One notification per open GROUP instead of one per event (a bot asking
 * for approval again and again in one session, 2026-10-20).
 *
 * The group is open while a row with `source = groupKey` is unread and
 * undismissed. The first item INSERTs that row and pushes; every later item
 * UPDATEs it in place (title/body/priority from the caller, the count and
 * the item list in metadata.group) and does NOT push. `created_at` is left
 * alone on purpose: the Android app polls `created_at > since`, so moving it
 * would alert the phone again on every update. Reading, dismissing or
 * closing (closeNotificationGroup) the row closes the group. Nothing is
 * dropped: the count covers every item, the newest GROUP_ITEMS_MAX are
 * listed, and `items_dropped` counts the older ones. metadata.group also
 * records `last_push_at` (ms) and `pushed_count`, so a re-push decision
 * survives a gateway restart.
 *
 * Callers that can race (two items at once for the same key) must serialise
 * per key; this function does a read-then-write.
 *
 * @param {object} db
 * @param {object} opts createNotification's fields plus:
 * @param {string} opts.groupKey   stored in `source`
 * @param {string|Function} opts.title  a string, or (count) => string
 * @param {object} [opts.item]     small JSON-able record of this event
 * @param {number} [opts.nowMs]    clock seam
 * @param {Function} [opts.deliver] push fan-out seam (tests): (db, notification)
 * @returns {Promise<{id, count, created, lastPushAt, pushedCount, snoozed}|null>} null when the type is switched off
 */
export async function upsertGroupedNotification(db, opts) {
  const {
    title, body: rawBody = null, type = "system", priority = "normal", action_url = null,
    groupKey, item = null, nowMs = Date.now(), deliver = deliverNotification,
  } = opts;
  if (!groupKey) throw new Error("upsertGroupedNotification: groupKey is required");
  if (!(await typeEnabled(db, type))) return null;
  const body = maskText(rawBody);
  const titleFor = (n) => maskText(typeof title === "function" ? title(n) : title);
  const entry = Object.assign({ at: new Date(nowMs).toISOString() }, maskDeep(item || {}));

  const open = (await db.execute({ sql: OPEN_GROUP_SQL, args: [groupKey] })).rows[0];

  if (!open) {
    const group = { key: groupKey, count: 1, items: [entry], items_dropped: 0, last_push_at: nowMs, pushed_count: 1 };
    const t = titleFor(1);
    const result = await db.execute({
      sql: `INSERT INTO notifications (type, source, title, body, priority, action_url, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [type, groupKey, t, body, priority, action_url, JSON.stringify({ group })],
    });
    await broadcastUnread(db);
    await deliver(db, { title: t, body, action_url, priority, type });
    return { id: Number(result.lastInsertRowid), count: 1, created: true, lastPushAt: nowMs, pushedCount: 1, snoozed: false };
  }

  const { meta, group } = groupOf(open.metadata, groupKey);
  group.items.push(entry);
  while (group.items.length > GROUP_ITEMS_MAX) { group.items.shift(); group.items_dropped += 1; }
  group.count = Math.max(group.count, group.items.length - 1) + 1;
  meta.group = group;
  await db.execute({
    sql: `UPDATE notifications SET title = ?, body = ?, priority = ?, action_url = ?, metadata = ?,
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [titleFor(group.count), body, priority, action_url, JSON.stringify(meta), open.id],
  });
  await broadcastUnread(db);
  return {
    id: Number(open.id), count: group.count, created: false,
    lastPushAt: group.last_push_at, pushedCount: group.pushed_count,
    snoozed: isSnoozed(open.snoozed_until, nowMs),
  };
}

/** snoozed_until as epoch ms (SQLite "YYYY-MM-DD HH:MM:SS" is UTC), or NaN. */
function snoozeEndMs(snoozedUntil) {
  if (!snoozedUntil) return NaN;
  const v = String(snoozedUntil);
  return Date.parse(v.includes("T") ? v : v.replace(" ", "T") + "Z");
}

function isSnoozed(snoozedUntil, nowMs) {
  const t = snoozeEndMs(snoozedUntil);
  return Number.isFinite(t) && t > nowMs;
}

/**
 * Re-push an open group (no new row) when its count grew since the last
 * push and it is not snoozed. Records the push in metadata.group.
 * @returns {Promise<{pushed:boolean, count?:number, snoozedUntilMs?:number}>}
 */
export async function repushNotificationGroup(db, { groupKey, title, priority = "high", type = "system", nowMs = Date.now(), deliver = deliverNotification }) {
  const open = (await db.execute({ sql: OPEN_GROUP_SQL, args: [groupKey] })).rows[0];
  if (!open) return { pushed: false };
  if (isSnoozed(open.snoozed_until, nowMs)) return { pushed: false, snoozedUntilMs: snoozeEndMs(open.snoozed_until) };
  const { meta, group } = groupOf(open.metadata, groupKey);
  if (group.count <= group.pushed_count) return { pushed: false, count: group.count };
  const t = maskText(typeof title === "function" ? title(group.count) : title);
  await deliver(db, { title: t, body: maskText(open.body) || t, action_url: open.action_url || null, priority, type });
  group.last_push_at = nowMs;
  group.pushed_count = group.count;
  meta.group = group;
  await db.execute({ sql: "UPDATE notifications SET metadata = ?, updated_at = datetime('now') WHERE id = ?", args: [JSON.stringify(meta), open.id] });
  return { pushed: true, count: group.count };
}

/**
 * Close a group because what it announced was dealt with (the operator
 * answered or cancelled the question, or stopped the session): its open row
 * is marked read, so the next item starts a new group and pushes again.
 */
export async function closeNotificationGroup(db, groupKey) {
  await db.execute({
    sql: "UPDATE notifications SET is_read = 1, updated_at = datetime('now') WHERE source = ? AND is_read = 0 AND is_dismissed = 0",
    args: [groupKey],
  });
  await broadcastUnread(db);
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
