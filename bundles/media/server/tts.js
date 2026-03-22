/**
 * TTS (Text-to-Speech) Module
 *
 * Uses node-edge-tts (optional dependency) to generate audio from article text.
 * Caches results by content hash to avoid re-generation.
 * Rate-limited: max 1 concurrent, daily cap via CROW_MEDIA_TTS_DAILY_LIMIT.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "./db.js";

const DAILY_LIMIT = parseInt(process.env.CROW_MEDIA_TTS_DAILY_LIMIT || "50", 10);
const MAX_CACHE_MB = parseInt(process.env.CROW_MEDIA_AUDIO_MAX_MB || "500", 10);

// In-memory rate limiting
let dailyCount = 0;
let dailyResetTime = Date.now() + 86400000;
let generating = false;

function resetDailyIfNeeded() {
  if (Date.now() > dailyResetTime) {
    dailyCount = 0;
    dailyResetTime = Date.now() + 86400000;
  }
}

/**
 * Check if node-edge-tts is available.
 * @returns {Promise<boolean>}
 */
export async function isEdgeTtsAvailable() {
  try {
    await import("node-edge-tts");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the audio cache directory, creating it if needed.
 * @returns {string}
 */
export function resolveAudioDir() {
  const dataDir = resolveDataDir();
  const audioDir = join(dataDir, "media", "audio");
  mkdirSync(audioDir, { recursive: true });
  return audioDir;
}

/**
 * Generate audio from text using edge-tts.
 * @param {string} text - Text to speak
 * @param {string} voice - Edge TTS voice name
 * @param {string} outputPath - File path for output MP3
 * @returns {Promise<{ duration: number, fileSize: number }>}
 */
export async function generateAudio(text, voice, outputPath) {
  const { EdgeTTS } = await import("node-edge-tts");
  const tts = new EdgeTTS({ voice, lang: "en-US" });
  await tts.ttsPromise(text, outputPath);

  const stat = statSync(outputPath);
  // Estimate duration: ~150 words/min for TTS, ~5 chars/word
  const estimatedDuration = Math.round((text.length / 5 / 150) * 60);

  return { duration: estimatedDuration, fileSize: stat.size };
}

/**
 * Get or generate audio for an article.
 * @param {object} db - Database client
 * @param {number} articleId - Article ID
 * @param {string} [voice] - TTS voice name
 * @returns {Promise<{ audioPath: string, duration: number, cached: boolean }>}
 */
export async function getOrGenerateAudio(db, articleId, voice = "en-US-AriaNeural") {
  // Check cache
  const cached = await db.execute({
    sql: "SELECT * FROM media_audio_cache WHERE article_id = ?",
    args: [articleId],
  });

  if (cached.rows.length > 0) {
    const row = cached.rows[0];
    if (existsSync(row.audio_path)) {
      // Update last accessed
      await db.execute({
        sql: "UPDATE media_audio_cache SET last_accessed = datetime('now') WHERE id = ?",
        args: [row.id],
      });
      return { audioPath: row.audio_path, duration: row.duration_sec, cached: true };
    }
    // File missing — remove stale cache entry
    await db.execute({ sql: "DELETE FROM media_audio_cache WHERE id = ?", args: [row.id] });
  }

  // Rate limit checks
  resetDailyIfNeeded();
  if (dailyCount >= DAILY_LIMIT) {
    throw new Error(`Daily TTS limit reached (${DAILY_LIMIT}). Try again tomorrow or increase CROW_MEDIA_TTS_DAILY_LIMIT.`);
  }
  if (generating) {
    throw new Error("Another TTS generation is in progress. Please wait.");
  }

  // Get article content
  const article = await db.execute({
    sql: "SELECT title, content_full, content_raw, summary FROM media_articles WHERE id = ?",
    args: [articleId],
  });
  if (article.rows.length === 0) {
    throw new Error(`Article ${articleId} not found.`);
  }

  const a = article.rows[0];
  const textContent = a.content_full || a.content_raw || a.summary || a.title;
  if (!textContent || textContent.length < 10) {
    throw new Error("Article has insufficient text content for TTS.");
  }

  // Strip HTML for TTS
  const plainText = textContent.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  // Truncate to ~10k chars (~15 min of speech)
  const truncated = plainText.length > 10000 ? plainText.slice(0, 10000) + "..." : plainText;

  const contentHash = createHash("sha256").update(truncated).digest("hex");

  // Check if same content already cached (e.g. article updated but hash matches)
  const hashMatch = await db.execute({
    sql: "SELECT * FROM media_audio_cache WHERE content_hash = ? AND article_id = ?",
    args: [contentHash, articleId],
  });
  if (hashMatch.rows.length > 0 && existsSync(hashMatch.rows[0].audio_path)) {
    return { audioPath: hashMatch.rows[0].audio_path, duration: hashMatch.rows[0].duration_sec, cached: true };
  }

  // Generate
  generating = true;
  try {
    const audioDir = resolveAudioDir();
    const outputPath = join(audioDir, `article-${articleId}-${contentHash.slice(0, 8)}.mp3`);

    const { duration, fileSize } = await generateAudio(
      `${a.title}. ${truncated}`,
      voice,
      outputPath
    );

    await db.execute({
      sql: `INSERT INTO media_audio_cache (article_id, content_hash, audio_path, voice, duration_sec, file_size)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(article_id) DO UPDATE SET
              content_hash = ?, audio_path = ?, voice = ?, duration_sec = ?, file_size = ?,
              last_accessed = datetime('now')`,
      args: [articleId, contentHash, outputPath, voice, duration, fileSize,
             contentHash, outputPath, voice, duration, fileSize],
    });

    dailyCount++;
    return { audioPath: outputPath, duration, cached: false };
  } finally {
    generating = false;
  }
}

/**
 * Clean up audio cache using LRU eviction when over size limit.
 * @param {object} db - Database client
 * @param {number} [maxMb] - Max cache size in MB
 */
export async function cleanupAudioCache(db, maxMb = MAX_CACHE_MB) {
  const maxBytes = maxMb * 1024 * 1024;

  // Sum current cache size
  const sizeResult = await db.execute("SELECT COALESCE(SUM(file_size), 0) as total FROM media_audio_cache");
  let totalSize = sizeResult.rows[0].total;

  if (totalSize <= maxBytes) return;

  // Evict LRU entries until under limit
  const { rows } = await db.execute(
    "SELECT id, audio_path, file_size FROM media_audio_cache ORDER BY last_accessed ASC"
  );

  for (const row of rows) {
    if (totalSize <= maxBytes) break;
    try {
      if (existsSync(row.audio_path)) unlinkSync(row.audio_path);
    } catch {}
    await db.execute({ sql: "DELETE FROM media_audio_cache WHERE id = ?", args: [row.id] });
    totalSize -= row.file_size || 0;
  }
}
