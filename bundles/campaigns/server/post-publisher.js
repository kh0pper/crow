/**
 * Crow Campaigns — Post Publisher
 *
 * Orchestrates post publishing: decrypt credentials, enforce rate limits,
 * submit to Reddit, update status and history.
 */

import { decrypt } from "./crypto.js";
import { createRedditClient, submitTextPost, submitLinkPost } from "./reddit-client.js";

const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes per subreddit

/**
 * Check if we can post to a subreddit (10-min cooldown per sub).
 * Uses DB-based tracking so it survives restarts.
 */
export async function checkRateLimit(db, subredditName) {
  const result = await db.execute({
    sql: `SELECT published_at FROM campaigns_posts
          WHERE LOWER(subreddit_name) = LOWER(?) AND published_at IS NOT NULL
          ORDER BY published_at DESC LIMIT 1`,
    args: [subredditName],
  });

  if (result.rows.length === 0) return { allowed: true };

  const lastPublished = new Date(result.rows[0].published_at).getTime();
  const elapsed = Date.now() - lastPublished;

  if (elapsed < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
    return {
      allowed: false,
      waitSeconds: waitSec,
      lastPublishedAt: result.rows[0].published_at,
    };
  }

  return { allowed: true };
}

/**
 * Record a status change in the post history table.
 */
async function recordHistory(db, postId, fromStatus, toStatus, details) {
  await db.execute({
    sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
          VALUES (?, ?, ?, ?)`,
    args: [postId, fromStatus, toStatus, details || null],
  });
}

/**
 * Publish a single post to Reddit.
 *
 * @param {object} db - libsql client
 * @param {object} post - Row from campaigns_posts
 * @param {object} campaign - Row from campaigns_campaigns
 * @param {string} encryptionKey - CROW_CAMPAIGNS_ENCRYPTION_KEY
 * @returns {{ success: boolean, redditPostId?: string, redditUrl?: string, error?: string }}
 */
export async function publishPost(db, post, campaign, encryptionKey) {
  const previousStatus = post.status;

  // Set intermediate "publishing" status
  await db.execute({
    sql: "UPDATE campaigns_posts SET status = 'publishing', updated_at = datetime('now') WHERE id = ?",
    args: [post.id],
  });
  await recordHistory(db, post.id, previousStatus, "publishing", null);

  try {
    // Rate limit check
    const rateCheck = await checkRateLimit(db, post.subreddit_name);
    if (!rateCheck.allowed) {
      // Revert to previous status
      await db.execute({
        sql: "UPDATE campaigns_posts SET status = ?, updated_at = datetime('now') WHERE id = ?",
        args: [previousStatus, post.id],
      });
      await recordHistory(db, post.id, "publishing", previousStatus, `Rate limited: wait ${rateCheck.waitSeconds}s`);
      return { success: false, error: `Rate limited on r/${post.subreddit_name}: wait ${rateCheck.waitSeconds}s` };
    }

    // Get credentials
    if (!campaign.credential_id) {
      throw new Error("Campaign has no credential_id assigned");
    }

    const cred = await db.execute({
      sql: "SELECT * FROM campaigns_credentials WHERE id = ? AND is_active = 1",
      args: [campaign.credential_id],
    });
    if (cred.rows.length === 0) {
      throw new Error(`Active credential ID ${campaign.credential_id} not found`);
    }

    const row = cred.rows[0];
    const client = createRedditClient({
      username: row.username,
      clientId: decrypt(row.client_id_enc, encryptionKey),
      clientSecret: decrypt(row.client_secret_enc, encryptionKey),
      password: decrypt(row.password_enc, encryptionKey),
    });

    // Submit post
    let result;
    if (post.post_type === "link") {
      result = await submitLinkPost(client, {
        subreddit: post.subreddit_name,
        title: post.title,
        url: post.body,
        flairId: post.flair_id || undefined,
        flairText: post.flair_text || undefined,
      });
    } else {
      result = await submitTextPost(client, {
        subreddit: post.subreddit_name,
        title: post.title,
        body: post.body,
        flairId: post.flair_id || undefined,
        flairText: post.flair_text || undefined,
      });
    }

    // Update post as published
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE campaigns_posts
            SET status = 'published', published_at = ?, reddit_post_id = ?, reddit_url = ?,
                error = NULL, updated_at = datetime('now')
            WHERE id = ?`,
      args: [now, result.id, result.url, post.id],
    });
    await recordHistory(db, post.id, "publishing", "published", `Reddit: ${result.url}`);

    return { success: true, redditPostId: result.id, redditUrl: result.url };

  } catch (err) {
    // Mark as failed
    await db.execute({
      sql: "UPDATE campaigns_posts SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?",
      args: [err.message, post.id],
    });
    await recordHistory(db, post.id, "publishing", "failed", err.message);

    return { success: false, error: err.message };
  }
}
