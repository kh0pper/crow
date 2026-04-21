/**
 * Crow Campaigns — Subreddit Crawler
 *
 * Crawls subreddit rules, flairs, and metadata via the Reddit API,
 * then stores/updates the result in campaigns_subreddits.
 */

import { getSubredditInfo } from "./reddit-client.js";

/**
 * Crawl a subreddit and upsert its data into the DB.
 * @param {object} db - @libsql/client instance
 * @param {Snoowrap} client - Authenticated snoowrap client
 * @param {string} subredditName - Subreddit name (no r/ prefix)
 * @returns {object} The upserted subreddit row
 */
export async function crawlSubreddit(db, client, subredditName) {
  const name = subredditName.replace(/^r\//, "").toLowerCase();

  const info = await getSubredditInfo(client, name);

  // Check if we already have this subreddit
  const existing = await db.execute({
    sql: "SELECT id FROM campaigns_subreddits WHERE name = ?",
    args: [info.name],
  });

  const rulesJson = JSON.stringify(info.rules);
  const flairJson = JSON.stringify(info.flairs);
  const now = new Date().toISOString();

  if (existing.rows.length > 0) {
    await db.execute({
      sql: `UPDATE campaigns_subreddits
            SET subscribers = ?, rules_json = ?, flair_json = ?,
                last_crawled_at = ?, updated_at = datetime('now')
            WHERE name = ?`,
      args: [info.subscribers, rulesJson, flairJson, now, info.name],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO campaigns_subreddits (name, subscribers, rules_json, flair_json, last_crawled_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [info.name, info.subscribers, rulesJson, flairJson, now],
    });
  }

  // Return the full row
  const row = await db.execute({
    sql: "SELECT * FROM campaigns_subreddits WHERE name = ?",
    args: [info.name],
  });

  return {
    ...row.rows[0],
    post_types: info.post_types,
    over18: info.over18,
    sidebar_preview: info.sidebar ? info.sidebar.substring(0, 500) : null,
  };
}
