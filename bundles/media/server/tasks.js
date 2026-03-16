/**
 * Sequential Task Scheduler
 *
 * Runs background tasks one at a time with a priority queue.
 * Prevents memory spikes from overlapping HTTP fetches on Pi (1-4 GB RAM).
 *
 * Usage:
 *   const runner = createTaskRunner(db);
 *   runner.registerTask("feed-fetch", fetchAllFeeds, { intervalMs: 30 * 60000, priority: 1 });
 *   runner.start();
 *   runner.stop();
 */

import { fetchAndParseFeed, postProcessGoogleNewsItems, buildAuthHeaders } from "./feed-fetcher.js";

// Lazy-loaded notification helper (may not exist in standalone mode)
let _createNotification = null;
async function notifyIfAvailable(db, opts) {
  if (_createNotification === undefined) return;
  try {
    if (!_createNotification) {
      const mod = await import("../../../servers/shared/notifications.js");
      _createNotification = mod.createNotification;
    }
    await _createNotification(db, opts);
  } catch {
    _createNotification = undefined; // Don't retry on failure
  }
}

const CHECK_INTERVAL = 60_000; // Check for due tasks every 60s
const MAX_CONCURRENT_FETCHES = parseInt(process.env.CROW_MEDIA_MAX_FETCHES || "3", 10);

/**
 * Create a task runner instance.
 * @param {object} db - Database client
 * @returns {{ registerTask, start, stop, runNow }}
 */
export function createTaskRunner(db) {
  const tasks = new Map(); // name → { fn, intervalMs, lastRun, priority }
  let timer = null;
  let running = false;

  function registerTask(name, fn, { intervalMs, priority = 5 }) {
    tasks.set(name, { fn, intervalMs, lastRun: 0, priority });
  }

  async function tick() {
    if (running) return;
    running = true;

    try {
      const now = Date.now();
      // Find due tasks sorted by priority (lower = higher priority)
      const due = [...tasks.entries()]
        .filter(([, t]) => now - t.lastRun >= t.intervalMs)
        .sort((a, b) => a[1].priority - b[1].priority);

      for (const [name, task] of due) {
        try {
          await task.fn(db);
          task.lastRun = Date.now();
        } catch (err) {
          console.error(`[media-tasks] ${name} failed:`, err.message);
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, CHECK_INTERVAL);
    // Run first tick after a short delay (let gateway finish booting)
    setTimeout(tick, 5000);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * Run a specific task immediately (e.g. for manual refresh).
   */
  async function runNow(name) {
    const task = tasks.get(name);
    if (!task) throw new Error(`Unknown task: ${name}`);
    await task.fn(db);
    task.lastRun = Date.now();
  }

  return { registerTask, start, stop, runNow };
}

/**
 * Fetch all enabled RSS sources and insert new articles.
 * Respects per-source fetch intervals and limits concurrent fetches.
 */
export async function fetchAllFeeds(db) {
  const { rows: sources } = await db.execute({
    sql: `SELECT id, url, source_type, fetch_interval_min, last_fetched FROM media_sources
          WHERE enabled = 1 AND source_type IN ('rss', 'google_news', 'youtube', 'podcast')`,
    args: [],
  });

  const now = new Date();
  const due = sources.filter((s) => {
    if (!s.last_fetched) return true;
    const elapsed = (now - new Date(s.last_fetched)) / 60000;
    return elapsed >= (s.fetch_interval_min || 30);
  });

  if (due.length === 0) return;

  // Process in batches to limit concurrency
  for (let i = 0; i < due.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = due.slice(i, i + MAX_CONCURRENT_FETCHES);
    await Promise.allSettled(batch.map((source) => fetchSingleSource(db, source)));
  }
}

async function fetchSingleSource(db, source) {
  try {
    const authHeaders = buildAuthHeaders(source.auth_config);
    let { feed, items } = await fetchAndParseFeed(source.url, authHeaders);

    // Post-process Google News titles
    if (source.source_type === 'google_news') {
      postProcessGoogleNewsItems(items);
    }

    // Update source metadata
    await db.execute({
      sql: `UPDATE media_sources SET last_fetched = datetime('now'), last_error = NULL WHERE id = ?`,
      args: [source.id],
    });

    // Insert new articles (skip duplicates via UNIQUE(source_id, guid))
    for (const item of items.slice(0, 100)) {
      const guid = item.guid || item.link || item.title;
      if (!guid) continue;

      try {
        await db.execute({
          sql: `INSERT OR IGNORE INTO media_articles
                (source_id, guid, url, title, author, pub_date, content_raw, summary,
                 image_url, audio_url, source_url, content_fetch_status, ai_analysis_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
          args: [
            source.id,
            guid,
            item.link || null,
            item.title,
            item.author || null,
            item.pub_date ? normalizeDate(item.pub_date) : null,
            item.content || null,
            item.summary ? item.summary.slice(0, 2000) : null,
            item.image || null,
            item.enclosureAudio || null,
            item.sourceUrl || null,
          ],
        });
      } catch {
        // Duplicate or constraint violation — skip
      }
    }
  } catch (err) {
    // Record error on source
    await db.execute({
      sql: `UPDATE media_sources SET last_error = ?, last_fetched = datetime('now') WHERE id = ?`,
      args: [err.message.slice(0, 500), source.id],
    }).catch(() => {});
    // Notify on fetch error
    await notifyIfAvailable(db, {
      title: `Feed error: ${source.name || source.url}`,
      body: err.message.slice(0, 200),
      type: "system",
      source: "media:feed-error",
      priority: "high",
      expires_in_minutes: 1440, // auto-dismiss after 24h
    }).catch(() => {});
  }
}

/**
 * Normalize various date formats to ISO 8601.
 */
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toISOString();
  } catch {
    return dateStr;
  }
}

/**
 * Register all Phase 1 tasks on a task runner.
 */
export function registerMediaTasks(runner, db) {
  runner.registerTask("feed-fetch", fetchAllFeeds, {
    intervalMs: 30 * 60_000, // 30 minutes
    priority: 1,
  });

  // Content extraction (readability + linkedom)
  runner.registerTask("content-extract", async (db) => {
    const { extractContentBatch } = await import("./content-extractor.js");
    await extractContentBatch(db, 5);
  }, {
    intervalMs: 15 * 60_000, // 15 minutes
    priority: 2,
  });

  // AI analysis (BYOAI — skips if no provider configured or LITE mode)
  runner.registerTask("ai-analysis", async (db) => {
    const { analyzeArticleBatch } = await import("./ai-analyzer.js");
    await analyzeArticleBatch(db, 5);
  }, {
    intervalMs: 30 * 60_000, // 30 minutes
    priority: 3,
  });

  // Interest profile decay (daily)
  runner.registerTask("interest-decay", async (db) => {
    const { decayAllProfiles } = await import("./scorer.js");
    await decayAllProfiles(db);
  }, {
    intervalMs: 24 * 60 * 60_000, // 24 hours
    priority: 5,
  });

  // Article cleanup — delete old non-saved/non-starred articles (daily)
  runner.registerTask("article-cleanup", async (db) => {
    await db.execute({
      sql: `DELETE FROM media_articles WHERE id NOT IN (
        SELECT article_id FROM media_article_states WHERE is_saved = 1 OR is_starred = 1
      ) AND created_at < datetime('now', '-30 days')`,
      args: [],
    });
  }, {
    intervalMs: 24 * 60 * 60_000, // 24 hours
    priority: 6,
  });

  // Audio cache cleanup — evict LRU entries when over size limit (daily)
  runner.registerTask("audio-cache-cleanup", async (db) => {
    try {
      const { cleanupAudioCache } = await import("./tts.js");
      await cleanupAudioCache(db);
    } catch {}
  }, {
    intervalMs: 24 * 60 * 60_000, // 24 hours
    priority: 7,
  });

  // Daily Mix playlist — auto-generate from top scored unread articles (daily)
  runner.registerTask("daily-mix", async (db) => {
    try {
      const { buildScoredFeedSql } = await import("./scorer.js");
      const scored = buildScoredFeedSql({ limit: 10, offset: 0, unreadOnly: true });
      const { rows: articles } = await db.execute({ sql: scored.sql, args: scored.args });
      if (articles.length < 3) return; // Not enough for a mix

      // Create or replace today's daily mix
      const today = new Date().toISOString().slice(0, 10);
      const mixName = `Daily Mix — ${today}`;

      // Check if already exists
      const existing = await db.execute({
        sql: "SELECT id FROM media_playlists WHERE name = ? AND auto_generated = 1",
        args: [mixName],
      });
      if (existing.rows.length > 0) return;

      const result = await db.execute({
        sql: "INSERT INTO media_playlists (name, description, auto_generated) VALUES (?, ?, 1)",
        args: [mixName, `Auto-generated daily mix with ${articles.length} top articles`],
      });
      const playlistId = result.lastInsertRowid;

      for (let i = 0; i < articles.length; i++) {
        await db.execute({
          sql: "INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (?, 'article', ?, ?)",
          args: [playlistId, articles[i].id, i + 1],
        });
      }
    } catch {}
  }, {
    intervalMs: 24 * 60 * 60_000, // 24 hours
    priority: 4,
  });

  // Email digest sender — check schedule and send if due (30 min)
  runner.registerTask("digest-sender", async (db) => {
    if (process.env.CROW_MEDIA_LITE === "1") return;
    try {
      const { checkAndSendDigests } = await import("./digest.js");
      await checkAndSendDigests(db);
    } catch {}
  }, {
    intervalMs: 30 * 60_000, // 30 minutes
    priority: 8,
  });

  // Scheduled briefing generation — polls schedules table for media:briefing tasks
  runner.registerTask("scheduled-briefings", async (db) => {
    try {
      const { rows: due } = await db.execute({
        sql: `SELECT * FROM schedules
              WHERE task = 'media:briefing' AND enabled = 1
                AND (next_run IS NULL OR next_run <= datetime('now'))`,
        args: [],
      });
      if (due.length === 0) return;

      for (const schedule of due) {
        try {
          const config = schedule.config ? JSON.parse(schedule.config) : {};
          const topic = config.topic || null;
          const maxArticles = config.max_articles || 5;

          // Get top unread articles
          let sql = `SELECT a.id, a.title, a.summary, a.content_full, a.content_raw,
                            s.name as source_name
                     FROM media_articles a
                     JOIN media_sources s ON s.id = a.source_id
                     LEFT JOIN media_article_states st ON st.article_id = a.id
                     WHERE COALESCE(st.is_read, 0) = 0 AND s.enabled = 1`;
          const args = [];
          if (topic) {
            sql += " AND (s.category LIKE ? OR a.title LIKE ?)";
            args.push(`%${topic}%`, `%${topic}%`);
          }
          sql += " ORDER BY a.pub_date DESC NULLS LAST LIMIT ?";
          args.push(maxArticles);

          const { rows: articles } = await db.execute({ sql, args });
          if (articles.length === 0) continue;

          // Build briefing
          const title = topic ? `Scheduled: ${topic}` : "Scheduled Briefing";
          const script = articles.map((a, i) => {
            const text = a.summary || (a.content_full || a.content_raw || "").slice(0, 500);
            return `${i + 1}. ${a.title} (${a.source_name})\n${text}`;
          }).join("\n\n");

          let audioPath = null;
          let durationSec = null;

          if (config.voice) {
            try {
              const { isEdgeTtsAvailable, generateAudio, resolveAudioDir } = await import("./tts.js");
              if (await isEdgeTtsAvailable()) {
                const { join } = await import("node:path");
                const { createHash } = await import("node:crypto");
                const audioDir = resolveAudioDir();
                const hash = createHash("sha256").update(script).digest("hex").slice(0, 12);
                const outPath = join(audioDir, `briefing-${hash}.mp3`);
                const result = await generateAudio(`${title}. ${script}`, config.voice, outPath);
                audioPath = outPath;
                durationSec = result.duration;
              }
            } catch {}
          }

          await db.execute({
            sql: "INSERT INTO media_briefings (title, script, audio_path, article_ids, duration_sec) VALUES (?, ?, ?, ?, ?)",
            args: [title, script, audioPath, JSON.stringify(articles.map(a => a.id)), durationSec],
          });

          // Compute next_run from cron (simple next-minute calculation)
          // Use a basic approach: set next_run to now + interval based on cron pattern
          const cronParts = (schedule.cron || "").split(" ");
          let intervalMs = 24 * 60 * 60_000; // default: daily
          if (cronParts[4] && cronParts[4] !== "*") {
            // Has day-of-week constraint — weekly-ish, set next to +24h (runner will re-check)
            intervalMs = 24 * 60 * 60_000;
          }
          const nextRun = new Date(Date.now() + intervalMs).toISOString().replace("T", " ").slice(0, 19);
          await db.execute({
            sql: "UPDATE schedules SET last_run = datetime('now'), next_run = ? WHERE id = ?",
            args: [nextRun, schedule.id],
          });

          console.log(`[media] Generated scheduled briefing: ${title} (${articles.length} articles)`);
          await notifyIfAvailable(db, {
            title: `Briefing ready: ${title}`,
            body: `${articles.length} article(s) summarized`,
            type: "media",
            source: "media:briefing",
            action_url: "/dashboard/media",
          });
        } catch (err) {
          console.warn(`[media] Scheduled briefing failed:`, err.message);
        }
      }
    } catch {}
  }, {
    intervalMs: 30 * 60_000, // 30 minutes (same as digest-sender)
    priority: 9,
  });
}
