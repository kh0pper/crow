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
import { resolveNtfyConfig, recordNtfyStatus } from "../push/ntfy-config.js";

// "A phone fetched the push settings" is the closest signal to "app subscribed" (ntfy has
// no subscriber listing). The app re-fetches often; persist at most every 10 minutes.
const APP_FETCH_RECORD_MS = 10 * 60 * 1000;
let _lastAppFetchRecorded = 0;
function noteAppFetch(req) {
  const now = Date.now();
  if (now - _lastAppFetchRecorded < APP_FETCH_RECORD_MS) return;
  _lastAppFetchRecorded = now;
  const ua = String(req.get?.("user-agent") || "");
  recordNtfyStatus({ appFetchedAt: new Date(now).toISOString(), appFetchedBy: /CrowAndroid|okhttp|Dalvik/i.test(ua) ? "android" : "other" });
}
/** Test hook. */
export function _resetAppFetchThrottleForTest() { _lastAppFetchRecorded = 0; }

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function pushRouter(authMiddleware) {
  const router = Router();

  // Every push route is private — auth the whole prefix (W2-1 tidy).
  router.use("/api/push", authMiddleware);

  // GET /api/push/vapid-key — public key for PushManager.subscribe()
  router.get("/api/push/vapid-key", (req, res) => {
    const key = getVapidPublicKey();
    if (!key) {
      return res.status(404).json({ error: "Push notifications not configured" });
    }
    res.json({ vapidPublicKey: key });
  });

  // POST /api/push/register — save push subscription
  router.post("/api/push/register", async (req, res) => {
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
  router.delete("/api/push/register", async (req, res) => {
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
  router.get("/api/push/notifications", async (req, res) => {
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

  // GET /api/push/ntfy-config — connection parameters for Android ntfy client.
  //
  // Returns:
  //   { enabled: true, url, topic, topics, authToken }
  //
  // `topic` is the primary topic (kept for old APK builds that expect a
  // single string). `topics` is the deduplicated array of every topic the
  // APK should subscribe to — primary + anything in NTFY_EXTRA_TOPICS. The
  // APK joins `topics` with commas in its stream URL; ntfy's server natively
  // handles multi-topic subscriptions on a single HTTP connection via the
  // `/topic1,topic2/json` syntax, so this does not multiply connections.
  //
  // NTFY_EXTRA_TOPICS is a comma-separated env list set on primary's systemd
  // (via a drop-in) to include paired-instance topics — e.g. MPA publishes
  // to `kevin-mpa`, so primary's response includes that in `topics` so the
  // phone paired to primary receives MPA pushes too without a per-instance
  // pairing rotation.
  //
  // Config comes from resolveNtfyConfig(): the NTFY_* env when NTFY_TOPIC is set
  // (unchanged), else the autowired ntfy-push.json. In auto mode `authToken` is the
  // READ-ONLY subscriber token — never the publisher token.
  router.get("/api/push/ntfy-config", (req, res) => {
    let cfg = null;
    try { cfg = resolveNtfyConfig(); } catch { cfg = null; }
    if (!cfg || !cfg.externalUrl) {
      return res.json({ enabled: false });
    }
    const url = cfg.externalUrl;
    noteAppFetch(req);
    res.json({ enabled: true, url, topic: cfg.topic, topics: cfg.topics, authToken: cfg.subscriberToken || null });
  });

  return router;
}
