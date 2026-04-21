/**
 * Crow Campaigns — Campaign Scheduler
 *
 * Poll loop (60s) that finds due posts and publishes them.
 * Same pattern as servers/orchestrator/pipeline-runner.js.
 *
 * On startup, checks for posts stuck in "publishing" status
 * (indicates a crash between Reddit submission and status update).
 */

import { publishPost } from "./post-publisher.js";

const POLL_INTERVAL_MS = 60 * 1000;

let timer = null;
let db = null;
let encryptionKey = null;

/** @type {Set<number>} Post IDs currently being published (prevent overlap) */
const publishing = new Set();

/**
 * Check for posts stuck in "publishing" status on startup.
 * These indicate a crash during the previous publish attempt.
 */
async function recoverStuckPosts() {
  if (!db) return;

  try {
    const { rows } = await db.execute({
      sql: "SELECT id, reddit_post_id, title, subreddit_name FROM campaigns_posts WHERE status = 'publishing'",
      args: [],
    });

    for (const post of rows) {
      if (post.reddit_post_id) {
        // Post may have been submitted to Reddit but status update failed.
        // Mark as published (optimistic) with a note to verify manually.
        await db.execute({
          sql: `UPDATE campaigns_posts
                SET status = 'published', published_at = datetime('now'),
                    error = 'Recovered from crash — verify this post was published correctly',
                    updated_at = datetime('now')
                WHERE id = ?`,
          args: [post.id],
        });
        await db.execute({
          sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                VALUES (?, 'publishing', 'published', 'Crash recovery: reddit_post_id was set, assumed published')`,
          args: [post.id],
        });
        console.log(`[campaign-scheduler] Recovered post #${post.id} "${post.title}" as published (had reddit_post_id)`);
      } else {
        // No reddit_post_id — mark as failed so user can retry
        await db.execute({
          sql: `UPDATE campaigns_posts
                SET status = 'failed',
                    error = 'Interrupted during publishing — verify manually and retry if needed',
                    updated_at = datetime('now')
                WHERE id = ?`,
          args: [post.id],
        });
        await db.execute({
          sql: `INSERT INTO campaigns_post_history (post_id, from_status, to_status, details)
                VALUES (?, 'publishing', 'failed', 'Crash recovery: no reddit_post_id, marked as failed')`,
          args: [post.id],
        });
        console.log(`[campaign-scheduler] Marked stuck post #${post.id} "${post.title}" as failed (no reddit_post_id)`);
      }
    }

    if (rows.length > 0) {
      console.log(`[campaign-scheduler] Recovered ${rows.length} stuck post(s)`);
    }
  } catch (err) {
    console.error("[campaign-scheduler] Stuck post recovery error:", err.message);
  }
}

/**
 * Find and publish due posts.
 */
async function tick() {
  if (!db || !encryptionKey) return;

  try {
    const now = new Date().toISOString();

    // Find approved posts with scheduled_at <= now, on active campaigns
    const { rows } = await db.execute({
      sql: `SELECT p.*, c.credential_id as campaign_credential_id, c.name as campaign_name
            FROM campaigns_posts p
            JOIN campaigns_campaigns c ON p.campaign_id = c.id
            WHERE p.status = 'approved'
              AND p.scheduled_at IS NOT NULL
              AND p.scheduled_at <= ?
              AND c.status = 'active'
            ORDER BY p.scheduled_at ASC`,
      args: [now],
    });

    for (const post of rows) {
      if (publishing.has(post.id)) continue;

      publishing.add(post.id);

      // Fetch full campaign row for publishPost
      const campaignResult = await db.execute({
        sql: "SELECT * FROM campaigns_campaigns WHERE id = ?",
        args: [post.campaign_id],
      });
      const campaign = campaignResult.rows[0];

      // Publish in background (don't block the loop)
      publishPost(db, post, campaign, encryptionKey)
        .then((result) => {
          if (result.success) {
            console.log(`[campaign-scheduler] Published post #${post.id} "${post.title}" to r/${post.subreddit_name}: ${result.redditUrl}`);
          } else {
            console.warn(`[campaign-scheduler] Failed to publish post #${post.id}: ${result.error}`);
          }
        })
        .catch((err) => {
          console.error(`[campaign-scheduler] Publish error for post #${post.id}:`, err.message);
        })
        .finally(() => {
          publishing.delete(post.id);
        });
    }
  } catch (err) {
    console.error("[campaign-scheduler] Poll error:", err.message);
  }
}

/**
 * Start the campaign scheduler.
 *
 * @param {object} database - libsql database client
 * @param {string} key - CROW_CAMPAIGNS_ENCRYPTION_KEY
 */
export async function startCampaignScheduler(database, key) {
  db = database;
  encryptionKey = key;

  if (!encryptionKey) {
    console.warn("[campaign-scheduler] No encryption key — scheduler won't start");
    return;
  }

  // Recover any stuck posts from a previous crash
  await recoverStuckPosts();

  // Start the poll loop
  timer = setInterval(() => tick(), POLL_INTERVAL_MS);
  timer.unref();

  console.log("[campaign-scheduler] Running — checking every 60s for due posts");
}

/**
 * Stop the campaign scheduler.
 */
export function stopCampaignScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
