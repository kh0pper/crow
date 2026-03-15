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

import { fetchAndParseFeed } from "./feed-fetcher.js";

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
    sql: `SELECT id, url, fetch_interval_min, last_fetched FROM media_sources
          WHERE enabled = 1 AND source_type = 'rss'`,
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
    const { feed, items } = await fetchAndParseFeed(source.url);

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
                 content_fetch_status, ai_analysis_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
          args: [
            source.id,
            guid,
            item.link || null,
            item.title,
            item.author || null,
            item.pub_date ? normalizeDate(item.pub_date) : null,
            item.content || null,
            item.summary ? item.summary.slice(0, 2000) : null,
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
}
