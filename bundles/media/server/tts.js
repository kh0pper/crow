/**
 * Article audio ("Listen"): the local voice reads a stored article aloud. One file per article,
 * cached until the article's text changes. The voice is the same local-only path the briefing
 * uses (speech.js); there is no cloud voice here.
 *
 * Rate limits are per process: one synthesis at a time (speech.js), and a daily cap
 * (CROW_MEDIA_TTS_DAILY_LIMIT) on newly made files.
 */
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { synthesizeToFile, resolveAudioDir, insideAudioDir } from "./speech.js";
import { cleanForSpeech } from "./briefing-text.js";
import { reasonText } from "./strings.js";

export { resolveAudioDir };

const DAILY_LIMIT = parseInt(process.env.CROW_MEDIA_TTS_DAILY_LIMIT || "50", 10);
const MAX_CACHE_MB = parseInt(process.env.CROW_MEDIA_AUDIO_MAX_MB || "500", 10);

let dailyCount = 0;
let dailyResetTime = Date.now() + 86400000;

/**
 * Get or make the audio for an article.
 * @returns {Promise<{ audioPath: string, duration: number, cached: boolean }>}
 * Throws an Error whose message can be shown as is ("No audio: the local voice did not answer.").
 */
export async function getOrGenerateAudio(db, articleId, voice = null, deps = {}) {
  const cached = await db.execute({ sql: "SELECT * FROM media_audio_cache WHERE article_id = ?", args: [articleId] });
  const article = await db.execute({ sql: "SELECT title, content_full, content_raw, summary FROM media_articles WHERE id = ?", args: [articleId] });
  if (article.rows.length === 0) throw new Error(`Article ${articleId} not found.`);
  const a = article.rows[0];
  const title = cleanForSpeech(a.title);
  const body = cleanForSpeech(a.content_full || a.content_raw || a.summary || "").slice(0, 10_000);
  if ((title + body).length < 10) throw new Error("Article has too little text to read aloud.");
  const contentHash = createHash("sha256").update(`${title}\n${body}`).digest("hex");

  const row = cached.rows[0];
  if (row) {
    if (row.content_hash === contentHash && insideAudioDir(row.audio_path)) {
      await db.execute({ sql: "UPDATE media_audio_cache SET last_accessed = datetime('now') WHERE id = ?", args: [row.id] });
      return { audioPath: row.audio_path, duration: row.duration_sec, cached: true };
    }
    await db.execute({ sql: "DELETE FROM media_audio_cache WHERE id = ?", args: [row.id] });
  }

  if (Date.now() > dailyResetTime) { dailyCount = 0; dailyResetTime = Date.now() + 86400000; }
  if (dailyCount >= DAILY_LIMIT) throw new Error(`Daily audio limit reached (${DAILY_LIMIT}). Try again tomorrow or raise CROW_MEDIA_TTS_DAILY_LIMIT.`);

  const outPath = join(resolveAudioDir(), `article-${Number(articleId)}-${contentHash.slice(0, 8)}.mp3`);
  const r = await synthesizeToFile(db, { segments: [/[.!?…]$/.test(title) ? title : `${title}.`, body], outPath, voice }, deps.speech || {});
  if (!r.ok) throw Object.assign(new Error(`No audio: ${reasonText(r.error)}`), { code: r.error });

  await db.execute({
    sql: `INSERT INTO media_audio_cache (article_id, content_hash, audio_path, voice, duration_sec, file_size, provider)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(article_id) DO UPDATE SET
            content_hash = excluded.content_hash, audio_path = excluded.audio_path, voice = excluded.voice,
            duration_sec = excluded.duration_sec, file_size = excluded.file_size, provider = excluded.provider,
            last_accessed = datetime('now')`,
    args: [articleId, contentHash, r.path, r.voice, r.duration_sec, r.file_size, r.provider],
  });
  dailyCount++;
  return { audioPath: r.path, duration: r.duration_sec, cached: false };
}

/**
 * Clean up audio cache using LRU eviction when over size limit.
 * @param {object} db - Database client
 * @param {number} [maxMb] - Max cache size in MB
 */
export async function cleanupAudioCache(db, maxMb = MAX_CACHE_MB) {
  const maxBytes = maxMb * 1024 * 1024;
  const sizeResult = await db.execute("SELECT COALESCE(SUM(file_size), 0) as total FROM media_audio_cache");
  let totalSize = sizeResult.rows[0].total;
  if (totalSize <= maxBytes) return;

  const { rows } = await db.execute("SELECT id, audio_path, file_size FROM media_audio_cache ORDER BY last_accessed ASC");
  for (const row of rows) {
    if (totalSize <= maxBytes) break;
    try {
      if (insideAudioDir(row.audio_path) && existsSync(row.audio_path)) unlinkSync(row.audio_path);
    } catch {}
    await db.execute({ sql: "DELETE FROM media_audio_cache WHERE id = ?", args: [row.id] });
    totalSize -= row.file_size || 0;
  }
}
