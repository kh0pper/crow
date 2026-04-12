/**
 * CrowClaw API Routes — Express router for Crow's Nest bot panel
 *
 * Bundle-compatible version: uses dynamic imports with path resolution.
 * Protected by dashboardAuth.
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

function resolveBundleServer() {
  const installed = join(homedir(), ".crow", "bundles", "crowclaw", "server");
  if (existsSync(installed)) return installed;
  return join(import.meta.dirname, "..", "server");
}

const serverDir = resolveBundleServer();

const { createDbClient } = await import(pathToFileURL(join(serverDir, "db.js")).href);

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function crowclawRouter(authMiddleware) {
  const router = Router();
  const db = createDbClient();

  // All routes require auth. SCOPE to /api/ so this router doesn't consume
  // unrelated traffic (e.g. /kiosk/, /maker-lab/*) when mounted at app root
  // alongside other panel routers. Without the path prefix, this middleware
  // intercepts EVERY unmatched request and 302s to /dashboard/login.
  router.use("/api", authMiddleware);

  // --- All bots status ---
  router.get("/api/status", async (req, res) => {
    try {
      const { rows } = await db.execute({ sql: "SELECT * FROM crowclaw_bots ORDER BY name" });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Bot logs (SSE) ---
  router.get("/api/:id/logs", async (req, res) => {
    try {
      const bot = await db.execute({ sql: "SELECT service_unit FROM crowclaw_bots WHERE id = ?", args: [Number(req.params.id)] });
      if (!bot.rows[0]) return res.status(404).json({ error: "Bot not found" });

      const { execFile } = await import("node:child_process");
      const lines = Number(req.query.lines) || 50;

      // Return as plain text (not SSE for simplicity — SSE can be added later)
      execFile("journalctl", [
        "--user", "-u", bot.rows[0].service_unit, "--no-pager", `-n`, String(lines),
      ], { timeout: 10_000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        res.type("text/plain").send(stdout);
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Start/Stop/Restart ---
  for (const action of ["start", "stop", "restart"]) {
    router.post(`/api/:id/${action}`, async (req, res) => {
      try {
        const bot = await db.execute({ sql: "SELECT service_unit FROM crowclaw_bots WHERE id = ?", args: [Number(req.params.id)] });
        if (!bot.rows[0]) return res.status(404).json({ error: "Bot not found" });

        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);

        if (action === "start") {
          await execFileAsync("systemctl", ["--user", "enable", "--now", bot.rows[0].service_unit]);
        } else {
          await execFileAsync("systemctl", ["--user", action, bot.rows[0].service_unit]);
        }

        const newStatus = action === "stop" ? "stopped" : "running";
        await db.execute({
          sql: "UPDATE crowclaw_bots SET status = ?, updated_at = datetime('now') WHERE id = ?",
          args: [newStatus, Number(req.params.id)],
        });

        res.json({ ok: true, action, status: newStatus });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  // --- Profiles ---
  router.get("/api/:id/profiles", async (req, res) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT * FROM crowclaw_user_profiles WHERE bot_id = ? ORDER BY is_owner DESC, display_name",
        args: [Number(req.params.id)],
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/api/:id/profiles", async (req, res) => {
    try {
      const { platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner } = req.body;
      const botId = Number(req.params.id);
      await db.execute({
        sql: `INSERT INTO crowclaw_user_profiles (bot_id, platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(bot_id, platform, platform_user_id) DO UPDATE SET
                display_name = ?, language = ?, tts_voice = ?, timezone = ?, persona_notes = ?, is_owner = ?`,
        args: [botId, platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner ? 1 : 0,
               display_name, language, tts_voice, timezone, persona_notes, is_owner ? 1 : 0],
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/api/:id/profiles/:pid", async (req, res) => {
    try {
      await db.execute({ sql: "DELETE FROM crowclaw_user_profiles WHERE id = ? AND bot_id = ?", args: [Number(req.params.pid), Number(req.params.id)] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Workspace files ---
  router.get("/api/:id/workspace", async (req, res) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT file_name, is_template, lamport_ts FROM crowclaw_workspace_files WHERE bot_id = ? ORDER BY file_name",
        args: [Number(req.params.id)],
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/api/:id/workspace/:fileName", async (req, res) => {
    try {
      const botId = Number(req.params.id);
      const fileName = req.params.fileName;
      const { content } = req.body;
      await db.execute({
        sql: `INSERT INTO crowclaw_workspace_files (bot_id, file_name, content, lamport_ts)
              VALUES (?, ?, ?, 1)
              ON CONFLICT(bot_id, file_name) DO UPDATE SET content = ?, lamport_ts = lamport_ts + 1`,
        args: [botId, fileName, content, content],
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Safety events ---
  router.get("/api/:id/safety", async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const { rows } = await db.execute({
        sql: "SELECT * FROM crowclaw_safety_events WHERE bot_id = ? ORDER BY timestamp DESC LIMIT ?",
        args: [Number(req.params.id), limit],
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Deployments ---
  router.get("/api/:id/deployments", async (req, res) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT * FROM crowclaw_deployments WHERE bot_id = ? ORDER BY started_at DESC LIMIT 20",
        args: [Number(req.params.id)],
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
