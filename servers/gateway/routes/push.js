/**
 * Push Subscription Routes — Register/unregister push subscriptions
 *
 * POST /api/push/register   — Save a push subscription
 * DELETE /api/push/register — Remove a push subscription
 * GET /api/push/vapid-key   — Get the VAPID public key for client-side use
 */

import { Router } from "express";
import { createDbClient } from "../../db.js";
import { getVapidPublicKey } from "../push/web-push.js";

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function pushRouter(authMiddleware) {
  const router = Router();

  // GET /api/push/vapid-key — public key for PushManager.subscribe()
  router.get("/api/push/vapid-key", authMiddleware, (req, res) => {
    const key = getVapidPublicKey();
    if (!key) {
      return res.status(404).json({ error: "Push notifications not configured" });
    }
    res.json({ vapidPublicKey: key });
  });

  // POST /api/push/register — save push subscription
  router.post("/api/push/register", authMiddleware, async (req, res) => {
    const { endpoint, keys, deviceName, platform } = req.body;

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: "Missing endpoint or keys (p256dh, auth)" });
    }

    const db = createDbClient();
    try {
      const keysJson = JSON.stringify(keys);
      await db.execute({
        sql: `INSERT INTO push_subscriptions (endpoint, keys_json, platform, device_name)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET
                keys_json = excluded.keys_json,
                platform = excluded.platform,
                device_name = excluded.device_name,
                last_seen = datetime('now')`,
        args: [endpoint, keysJson, platform || "web", deviceName || null],
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[push] Registration failed:", err.message);
      res.status(500).json({ error: "Failed to register subscription" });
    } finally {
      db.close();
    }
  });

  // DELETE /api/push/register — remove push subscription
  router.delete("/api/push/register", authMiddleware, async (req, res) => {
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: "Missing endpoint" });
    }

    const db = createDbClient();
    try {
      await db.execute({
        sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
        args: [endpoint],
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[push] Unregister failed:", err.message);
      res.status(500).json({ error: "Failed to unregister subscription" });
    } finally {
      db.close();
    }
  });

  // GET /api/push/notifications — poll for new notifications (used by Android app)
  router.get("/api/push/notifications", authMiddleware, async (req, res) => {
    const since = req.query.since || "1970-01-01T00:00:00Z";

    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: `SELECT id, title, body, type, source, action_url, priority, created_at
              FROM notifications
              WHERE created_at > ? AND is_dismissed = 0
              ORDER BY created_at DESC
              LIMIT 50`,
        args: [since],
      });
      res.json({ notifications: rows });
    } catch (err) {
      console.error("[push] Notification poll failed:", err.message);
      res.status(500).json({ error: "Failed to fetch notifications" });
    } finally {
      db.close();
    }
  });

  return router;
}
