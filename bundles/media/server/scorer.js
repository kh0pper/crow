/**
 * Personalization Scorer
 *
 * Updates interest profiles based on user actions and computes
 * personalized feed scores at query time via SQL.
 */

/** Affinity deltas per action type */
const ACTION_DELTAS = {
  star: 0.10,
  unstar: -0.05,
  save: 0.10,
  unsave: -0.05,
  thumbs_up: 0.15,
  thumbs_down: -0.20,
  mark_read: 0.05,
};

/**
 * Update interest profiles based on a user action on an article.
 */
export async function updateInterestProfile(db, articleId, action) {
  const delta = ACTION_DELTAS[action];
  if (!delta) return;

  // Look up the article's topics, categories, source_id
  const { rows } = await db.execute({
    sql: "SELECT source_id, topics, categories FROM media_articles WHERE id = ?",
    args: [articleId],
  });
  if (rows.length === 0) return;

  const article = rows[0];
  const updates = [];

  // Source profile
  updates.push({ type: "source", key: String(article.source_id) });

  // Topic profiles
  if (article.topics) {
    try {
      const topics = JSON.parse(article.topics);
      if (Array.isArray(topics)) {
        for (const topic of topics) updates.push({ type: "topic", key: String(topic).toLowerCase() });
      }
    } catch {}
  }

  // Category profiles
  if (article.categories) {
    try {
      const categories = JSON.parse(article.categories);
      if (Array.isArray(categories)) {
        for (const cat of categories) updates.push({ type: "category", key: String(cat).toLowerCase() });
      }
    } catch {}
  }

  // UPSERT each profile entry
  for (const { type, key } of updates) {
    await db.execute({
      sql: `INSERT INTO media_interest_profiles (profile_type, profile_key, affinity, interaction_count, updated_at)
            VALUES (?, ?, MAX(0, MIN(1, 0.5 + ?)), 1, datetime('now'))
            ON CONFLICT(profile_type, profile_key) DO UPDATE SET
              affinity = MAX(0, MIN(1, affinity + ?)),
              interaction_count = interaction_count + 1,
              updated_at = datetime('now')`,
      args: [type, key, delta, delta],
    });
  }
}

/**
 * Decay all interest profiles (daily task). Moves affinities toward neutral (0.5).
 */
export async function decayAllProfiles(db) {
  await db.execute({
    sql: `UPDATE media_interest_profiles
          SET affinity = 0.5 + (affinity - 0.5) * 0.95,
              updated_at = datetime('now')
          WHERE ABS(affinity - 0.5) > 0.01`,
    args: [],
  });
}

/**
 * Build a SQL query for the personalized "For You" feed.
 * Uses a scoring formula computed in SQL.
 */
export function buildScoredFeedSql({ limit = 20, offset = 0, category, sourceId, unreadOnly, starredOnly } = {}) {
  // Check if we're in cold start (< 10 total interactions)
  // This is checked at call time by the caller — if cold start, we use a simpler query

  let sql = `
    SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
           a.topics, a.categories, a.estimated_read_time,
           s.name as source_name, s.category as source_category,
           COALESCE(st.is_read, 0) as is_read,
           COALESCE(st.is_starred, 0) as is_starred,
           COALESCE(st.is_saved, 0) as is_saved,
           (
             -- Freshness (30%): decays over 48 hours
             0.30 * MAX(0, 1.0 - (julianday('now') - julianday(COALESCE(a.pub_date, a.created_at))) / 2.0)
             -- Interest match (40%): avg affinity from matching profiles
             + 0.40 * COALESCE((
               SELECT AVG(ip.affinity) FROM media_interest_profiles ip
               WHERE (ip.profile_type = 'source' AND ip.profile_key = CAST(a.source_id AS TEXT))
                  OR (ip.profile_type = 'category' AND ip.profile_key IN (
                    SELECT value FROM json_each(COALESCE(a.categories, '[]'))
                  ))
                  OR (ip.profile_type = 'topic' AND ip.profile_key IN (
                    SELECT LOWER(value) FROM json_each(COALESCE(a.topics, '[]'))
                  ))
             ), 0.5)
             -- Popularity (15%)
             + 0.15 * MIN(1.0, COALESCE(a.popularity_score, 0) / 10.0)
             -- Diversity bonus (15%): slight random factor to prevent same-source clusters
             + 0.15 * (0.5 + 0.5 * (ABS(RANDOM()) % 100) / 100.0)
           ) as score
    FROM media_articles a
    JOIN media_sources s ON s.id = a.source_id AND s.enabled = 1
    LEFT JOIN media_article_states st ON st.article_id = a.id
    WHERE 1=1`;

  const args = [];

  if (category) {
    sql += " AND s.category = ?";
    args.push(category);
  }
  if (sourceId) {
    sql += " AND a.source_id = ?";
    args.push(sourceId);
  }
  if (unreadOnly) {
    sql += " AND COALESCE(st.is_read, 0) = 0";
  }
  if (starredOnly) {
    sql += " AND COALESCE(st.is_starred, 0) = 1";
  }

  sql += " ORDER BY score DESC LIMIT ? OFFSET ?";
  args.push(limit, offset);

  return { sql, args };
}
