/**
 * Notification REST API Routes
 *
 * Dashboard-facing endpoints for notification management.
 * Protected by dashboard session auth (cookie-based).
 *
 * Routes:
 *   GET  /api/notifications        — List notifications (query: unread_only, type, limit, offset)
 *   GET  /api/notifications/count  — Lightweight count + health data (for polling)
 *   POST /api/notifications/:id/dismiss — Dismiss or snooze
 *   POST /api/notifications/:id/read   — Mark as read
 *   POST /api/notifications/dismiss-all — Bulk dismiss
 */

import { Router } from "express";
import { createDbClient } from "../../db.js";
import { cleanupNotifications } from "../../shared/notifications.js";

export default function notificationsRouter(dashboardAuth) {
  const router = Router();

  // All notification routes require dashboard auth
  router.use("/api/notifications", dashboardAuth);

  // --- List notifications ---
  router.get("/api/notifications", async (req, res) => {
    const db = createDbClient();
    try {
      await cleanupNotifications(db);

      const unreadOnly = req.query.unread_only !== "false";
      const type = req.query.type || null;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = parseInt(req.query.offset) || 0;
      const now = new Date().toISOString();

      let sql = "SELECT * FROM notifications WHERE 1=1";
      const params = [];

      if (unreadOnly) {
        sql += " AND is_read = 0 AND is_dismissed = 0";
        sql += " AND (snoozed_until IS NULL OR snoozed_until <= ?)";
        params.push(now);
      }
      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }

      sql += " ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const { rows } = await db.execute({ sql, args: params });

      // Parse metadata JSON
      const notifications = rows.map((r) => ({
        ...r,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
      }));

      res.json({ notifications, count: notifications.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Lightweight count + health (for polling) ---
  router.get("/api/notifications/count", async (req, res) => {
    const db = createDbClient();
    try {
      const now = new Date().toISOString();
      const { rows } = await db.execute({
        sql: `SELECT COUNT(*) as count FROM notifications
              WHERE is_read = 0 AND is_dismissed = 0
              AND (snoozed_until IS NULL OR snoozed_until <= ?)
              AND (expires_at IS NULL OR expires_at > ?)`,
        args: [now, now],
      });

      // Piggyback health data to reduce polling requests
      let health = null;
      try {
        const os = await import("node:os");
        const fs = await import("node:fs");
        const totalMem = Math.round(os.totalmem() / 1048576);
        const freeMem = Math.round(os.freemem() / 1048576);
        const cpuCount = os.cpus().length;

        // CPU: 1-min load average normalized to core count
        const cpuPct = Math.min(100, Math.round((os.loadavg()[0] / cpuCount) * 100));

        // Disk: async statfs (Node 18.15+)
        let diskPct = 0, diskUsedGb = 0, diskTotalGb = 0;
        try {
          const stats = await fs.promises.statfs("/");
          const totalBytes = stats.blocks * stats.bsize;
          const freeBytes = stats.bfree * stats.bsize;
          const usedBytes = totalBytes - freeBytes;
          diskTotalGb = Math.round(totalBytes / 1073741824);
          diskUsedGb = Math.round(usedBytes / 1073741824);
          diskPct = diskTotalGb > 0 ? Math.round((diskUsedGb / diskTotalGb) * 100) : 0;
        } catch {
          // statfs not available
        }

        health = {
          ram_used_mb: totalMem - freeMem,
          ram_total_mb: totalMem,
          ram_pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
          cpu_pct: cpuPct,
          cpus: cpuCount,
          disk_pct: diskPct,
          disk_used_gb: diskUsedGb,
          disk_total_gb: diskTotalGb,
          uptime_seconds: Math.round(os.uptime()),
        };
      } catch {
        // Health data optional
      }

      res.json({ count: rows[0].count, health });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Dismiss or snooze ---
  router.post("/api/notifications/:id/dismiss", async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid ID" });

      const snoozeMinutes = parseInt(req.body?.snooze_minutes) || 0;

      if (snoozeMinutes > 0) {
        const snoozedUntil = new Date(Date.now() + snoozeMinutes * 60000).toISOString();
        await db.execute({
          sql: "UPDATE notifications SET snoozed_until = ?, updated_at = datetime('now') WHERE id = ?",
          args: [snoozedUntil, id],
        });
        return res.json({ ok: true, snoozed_until: snoozedUntil });
      }

      await db.execute({
        sql: "UPDATE notifications SET is_dismissed = 1, updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Mark as read ---
  router.post("/api/notifications/:id/read", async (req, res) => {
    const db = createDbClient();
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid ID" });

      await db.execute({
        sql: "UPDATE notifications SET is_read = 1, updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // --- Bulk dismiss ---
  router.post("/api/notifications/dismiss-all", async (req, res) => {
    const db = createDbClient();
    try {
      let sql = "UPDATE notifications SET is_dismissed = 1, updated_at = datetime('now') WHERE is_dismissed = 0";
      const params = [];

      const type = req.body?.type;
      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }

      const result = await db.execute({ sql, args: params });
      res.json({ ok: true, dismissed: result.rowsAffected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  return router;
}
