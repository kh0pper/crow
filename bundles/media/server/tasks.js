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
 * Background work (feeds, cleanup, the daily briefing) runs only in the copy of this server that
 * the gateway starts and supervises (it sets CROW_ADDON_HOST=gateway), and only when the add-on's
 * own setting allows it. A bot's private copy, started from the same add-on entry for one turn and
 * then stopped, never runs a job: it could claim the 7:45 briefing and die with it.
 */
export function shouldRunBackgroundTasks(env = process.env) {
  return env.CROW_MEDIA_TASKS === "1" && env.CROW_ADDON_HOST === "gateway";
}

/** SQLite's datetime('now') is UTC with no zone marker; `new Date()` would read it as local time. */
export function sqliteUtcMs(value) {
  return Date.parse(`${String(value || "").replace(" ", "T")}Z`);
}

/** Is this source due for a fetch? Never fetched, or its interval (default 30 minutes) has passed. */
export function sourceIsDue(source, nowMs = Date.now()) {
  const last = sqliteUtcMs(source.last_fetched);
  if (!Number.isFinite(last)) return true;
  return (nowMs - last) / 60000 >= (source.fetch_interval_min || 30);
}

const SOURCE_COLUMNS = "id, name, url, source_type, fetch_interval_min, last_fetched, auth_config";

/**
 * Fetch all enabled feed sources that are due and insert new articles.
 * Respects per-source fetch intervals and limits concurrent fetches.
 */
export async function fetchAllFeeds(db) {
  const { rows: sources } = await db.execute({
    sql: `SELECT ${SOURCE_COLUMNS} FROM media_sources
          WHERE enabled = 1 AND source_type IN ('rss', 'google_news', 'youtube', 'podcast')`,
    args: [],
  });
  const due = sources.filter((s) => sourceIsDue(s));
  for (let i = 0; i < due.length; i += MAX_CONCURRENT_FETCHES) {
    await Promise.allSettled(due.slice(i, i + MAX_CONCURRENT_FETCHES).map((source) => fetchSingleSource(db, source)));
  }
}

/**
 * Fetch the given sources now, whatever their interval says (a briefing run starts with this).
 * Batches of MAX_CONCURRENT_FETCHES; no new batch starts after `capMs`. Never throws.
 * → { fetched, failed, skipped }
 */
export async function refreshSources(db, ids, capMs = 90_000) {
  const out = { fetched: 0, failed: 0, skipped: 0 };
  const wanted = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (wanted.length === 0) return out;
  const started = Date.now();
  try {
    const { rows } = await db.execute({
      sql: `SELECT ${SOURCE_COLUMNS} FROM media_sources WHERE enabled = 1 AND id IN (${wanted.map(() => "?").join(", ")}) ORDER BY id`,
      args: wanted,
    });
    for (let i = 0; i < rows.length; i += MAX_CONCURRENT_FETCHES) {
      const batch = rows.slice(i, i + MAX_CONCURRENT_FETCHES);
      if (Date.now() - started >= capMs) { out.skipped += batch.length; continue; }
      const results = await Promise.all(batch.map((source) => fetchSingleSource(db, source)));
      for (const r of results) r.ok ? out.fetched++ : out.failed++;
    }
  } catch (err) {
    console.error(`[media] refresh before a briefing failed: ${err.message}`);
  }
  return out;
}

/** Insert a feed's items (duplicates are skipped by UNIQUE(source_id, guid)). → number of new rows */
export async function insertFeedItems(db, source, items) {
  let added = 0;
  for (const item of (items || []).slice(0, 100)) {
    const guid = item.guid || item.link || item.title;
    if (!guid) continue;
    try {
      const ins = await db.execute({
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
      if (Number(ins.rowsAffected) > 0) added++;
    } catch {
      // Constraint violation: skip
    }
  }
  return added;
}

/** Fetch one source and store what is new. Never throws. → { ok, added } or { ok: false, error } */
export async function fetchSingleSource(db, source) {
  try {
    const authHeaders = buildAuthHeaders(source.auth_config);
    const { items } = await fetchAndParseFeed(source.url, authHeaders);
    if (source.source_type === "google_news") postProcessGoogleNewsItems(items);
    await db.execute({
      sql: `UPDATE media_sources SET last_fetched = datetime('now'), last_error = NULL WHERE id = ?`,
      args: [source.id],
    });
    return { ok: true, added: await insertFeedItems(db, source, items) };
  } catch (err) {
    // The error is kept on the source. No notification here: one per failing source per cycle
    // would be a flood. A once-per-failure-streak notice is planned with the source health view.
    await db.execute({
      sql: `UPDATE media_sources SET last_error = ?, last_fetched = datetime('now') WHERE id = ?`,
      args: [String(err.message || err).slice(0, 500), source.id],
    }).catch(() => {});
    return { ok: false, error: String(err.message || err) };
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
  // The daily briefing is NOT in this queue: it has its own minute loop (schedule.js
  // startScheduleLoop), so a long feed cycle never delays the 7:45 claim, the 8:00 notice or the
  // show watcher's 60-second cadence.

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
}
