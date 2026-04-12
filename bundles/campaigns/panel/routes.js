/**
 * Campaigns API Routes — Express router for Crow's Nest campaigns panel
 *
 * Direct DB queries (same pattern as CrowClaw's panel/routes.js).
 * Protected by dashboardAuth.
 */

import { Router } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

function resolveBundleServer() {
  const installed = join(homedir(), ".crow", "bundles", "campaigns", "server");
  if (existsSync(installed)) return installed;
  return join(import.meta.dirname, "..", "server");
}

const serverDir = resolveBundleServer();

const { createDbClient } = await import(pathToFileURL(join(serverDir, "db.js")).href);
const { encrypt, decrypt } = await import(pathToFileURL(join(serverDir, "crypto.js")).href);
const { createRedditClient, testAuth } = await import(pathToFileURL(join(serverDir, "reddit-client.js")).href);

const ENCRYPTION_KEY = process.env.CROW_CAMPAIGNS_ENCRYPTION_KEY;

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function campaignsRouter(authMiddleware) {
  const router = Router();
  const db = createDbClient();

  // All routes require auth. SCOPE to /api/ so this router doesn't consume
  // unrelated traffic (e.g. /kiosk/, /maker-lab/*) when mounted at app root
  // alongside other panel routers. Without the path prefix, this middleware
  // intercepts EVERY unmatched request and 302s to /dashboard/login.
  router.use("/api", authMiddleware);

  // --- List campaigns with stats ---
  router.get("/api/campaigns", async (req, res) => {
    try {
      const status = req.query.status;
      let sql = `
        SELECT c.*,
          (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id) as total_posts,
          (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'draft') as draft_posts,
          (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status IN ('scheduled','pending_approval')) as scheduled_posts,
          (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'published') as published_posts,
          (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'failed') as failed_posts,
          (SELECT COUNT(*) FROM campaigns_posts WHERE campaign_id = c.id AND status = 'pending_approval') as pending_posts
        FROM campaigns_campaigns c
      `;
      const args = [];
      if (status) { sql += " WHERE c.status = ?"; args.push(status); }
      sql += " ORDER BY c.updated_at DESC";
      const { rows } = await db.execute({ sql, args });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Campaign detail with posts ---
  router.get("/api/campaigns/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const campaign = await db.execute({ sql: "SELECT * FROM campaigns_campaigns WHERE id = ?", args: [id] });
      if (!campaign.rows[0]) return res.status(404).json({ error: "Campaign not found" });

      const posts = await db.execute({
        sql: "SELECT * FROM campaigns_posts WHERE campaign_id = ? ORDER BY scheduled_at ASC, created_at DESC",
        args: [id],
      });

      res.json({ campaign: campaign.rows[0], posts: posts.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Bulk approve posts ---
  router.post("/api/campaigns/:id/approve", async (req, res) => {
    try {
      const postIds = req.body.post_ids;
      if (!Array.isArray(postIds) || postIds.length === 0) {
        return res.status(400).json({ error: "post_ids array required" });
      }

      let approved = 0;
      for (const postId of postIds) {
        const post = await db.execute({ sql: "SELECT status FROM campaigns_posts WHERE id = ? AND campaign_id = ?", args: [postId, Number(req.params.id)] });
        if (!post.rows[0]) continue;
        const oldStatus = post.rows[0].status;
        if (oldStatus === "published" || oldStatus === "publishing" || oldStatus === "approved") continue;

        await db.execute({ sql: "UPDATE campaigns_posts SET status = 'approved', updated_at = datetime('now') WHERE id = ?", args: [postId] });
        await db.execute({
          sql: "INSERT INTO campaigns_post_history (post_id, from_status, to_status, details) VALUES (?, ?, 'approved', 'Approved via dashboard')",
          args: [postId, oldStatus],
        });
        approved++;
      }

      res.json({ ok: true, approved });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Update post ---
  router.put("/api/posts/:id", async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const { title, body, flair_id, flair_text, status, scheduled_at } = req.body;

      const existing = await db.execute({ sql: "SELECT * FROM campaigns_posts WHERE id = ?", args: [postId] });
      if (!existing.rows[0]) return res.status(404).json({ error: "Post not found" });

      const oldPost = existing.rows[0];
      if (oldPost.status === "published" || oldPost.status === "publishing") {
        return res.status(400).json({ error: `Cannot edit a ${oldPost.status} post` });
      }

      const updates = [];
      const args = [];
      if (title !== undefined) { updates.push("title = ?"); args.push(title); }
      if (body !== undefined) { updates.push("body = ?"); args.push(body); }
      if (flair_id !== undefined) { updates.push("flair_id = ?"); args.push(flair_id); }
      if (flair_text !== undefined) { updates.push("flair_text = ?"); args.push(flair_text); }
      if (scheduled_at !== undefined) { updates.push("scheduled_at = ?"); args.push(scheduled_at); }
      if (status !== undefined && status !== oldPost.status) {
        updates.push("status = ?"); args.push(status);
        await db.execute({
          sql: "INSERT INTO campaigns_post_history (post_id, from_status, to_status, details) VALUES (?, ?, ?, 'Updated via dashboard')",
          args: [postId, oldPost.status, status],
        });
      }

      if (updates.length === 0) return res.json({ ok: true, unchanged: true });

      updates.push("updated_at = datetime('now')");
      args.push(postId);
      await db.execute({ sql: `UPDATE campaigns_posts SET ${updates.join(", ")} WHERE id = ?`, args });

      const updated = await db.execute({ sql: "SELECT * FROM campaigns_posts WHERE id = ?", args: [postId] });
      res.json(updated.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Delete post ---
  router.delete("/api/posts/:id", async (req, res) => {
    try {
      const postId = Number(req.params.id);
      await db.execute({ sql: "DELETE FROM campaigns_posts WHERE id = ?", args: [postId] });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Retry failed post (reset to approved) ---
  router.post("/api/posts/:id/retry", async (req, res) => {
    try {
      const postId = Number(req.params.id);
      const post = await db.execute({ sql: "SELECT * FROM campaigns_posts WHERE id = ?", args: [postId] });
      if (!post.rows[0]) return res.status(404).json({ error: "Post not found" });
      if (post.rows[0].status !== "failed") return res.status(400).json({ error: "Only failed posts can be retried" });

      await db.execute({
        sql: "UPDATE campaigns_posts SET status = 'approved', error = NULL, updated_at = datetime('now') WHERE id = ?",
        args: [postId],
      });
      await db.execute({
        sql: "INSERT INTO campaigns_post_history (post_id, from_status, to_status, details) VALUES (?, 'failed', 'approved', 'Retried via dashboard')",
        args: [postId],
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- All pending posts across campaigns ---
  router.get("/api/pending", async (req, res) => {
    try {
      const { rows } = await db.execute({
        sql: `SELECT p.*, c.name as campaign_name
              FROM campaigns_posts p
              JOIN campaigns_campaigns c ON p.campaign_id = c.id
              WHERE p.status = 'pending_approval'
              ORDER BY p.scheduled_at ASC, p.created_at DESC`,
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- List cached subreddits ---
  router.get("/api/subreddits", async (req, res) => {
    try {
      const { rows } = await db.execute({ sql: "SELECT * FROM campaigns_subreddits ORDER BY name" });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Credentials: list (redacted) ---
  router.get("/api/credentials", async (req, res) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT id, platform, username, is_active, created_at, updated_at FROM campaigns_credentials ORDER BY is_active DESC, created_at DESC",
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Credentials: save (encrypt + validate) ---
  router.post("/api/credentials", async (req, res) => {
    try {
      if (!ENCRYPTION_KEY) return res.status(500).json({ error: "CROW_CAMPAIGNS_ENCRYPTION_KEY not set" });

      const { platform, username, client_id, client_secret, password } = req.body;
      if (!username || !client_id || !client_secret || !password) {
        return res.status(400).json({ error: "All fields required" });
      }

      const platformName = platform || "reddit";

      // Validate credentials
      try {
        const client = createRedditClient({ username, clientId: client_id, clientSecret: client_secret, password });
        await testAuth(client);
      } catch (authErr) {
        return res.status(400).json({ error: `Validation failed: ${authErr.message}` });
      }

      // Encrypt and store
      const clientIdEnc = encrypt(client_id, ENCRYPTION_KEY);
      const clientSecretEnc = encrypt(client_secret, ENCRYPTION_KEY);
      const passwordEnc = encrypt(password, ENCRYPTION_KEY);

      await db.execute({
        sql: "UPDATE campaigns_credentials SET is_active = 0, updated_at = datetime('now') WHERE platform = ? AND username = ? AND is_active = 1",
        args: [platformName, username],
      });

      const result = await db.execute({
        sql: "INSERT INTO campaigns_credentials (platform, username, client_id_enc, client_secret_enc, password_enc) VALUES (?, ?, ?, ?, ?)",
        args: [platformName, username, clientIdEnc, clientSecretEnc, passwordEnc],
      });

      res.json({ ok: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Post history ---
  router.get("/api/posts/:id/history", async (req, res) => {
    try {
      const { rows } = await db.execute({
        sql: "SELECT * FROM campaigns_post_history WHERE post_id = ? ORDER BY created_at DESC",
        args: [Number(req.params.id)],
      });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
