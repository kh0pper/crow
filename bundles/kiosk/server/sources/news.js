/**
 * The news source: audio the media bundle has already made — the spoken briefing, and (only when
 * the request names the news source) an article that was read aloud. The bundle's own routes need
 * a dashboard session, which a display never has, so this reads the same rows and hands the
 * stored FILE to the relay. Read-only; it never makes a briefing.
 *
 * It follows the source contract, version 1 (written out in funkwhale.js), with two additions a
 * source of stored files needs:
 *   - a candidate may carry `refuse: { say, vars }`: the source knows what was meant and cannot
 *     play it. "Play the news" with no briefing, or only an old one, gets a spoken line — never a
 *     stream of nothing, and never last spring's briefing as today's news.
 *   - a playable's upstream is `{ file, root }`: an absolute path, already checked, and the
 *     directory it must stay inside; the relay checks both again at every request. A candidate never carries a path; queue() reads the row again and checks again.
 *
 * What may be served: only a regular `.mp3` file whose REAL path (links followed) is inside
 * `<dataDir>/media/audio/`. The data directory also holds the database; a row that points
 * anywhere else, or at a link out of that directory, is treated as having no audio.
 */
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { wordsOf, cleanName, choose } from "./music-match.js";

export const NEWS_MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;
const NEWS_WORDS = new Set(["news", "briefing", "headlines", "noticias", "noticiero", "titulares", "resumen", "boletin"]);
/** Words that may stand around a news word. Anything else in the request means it is not (only) about the news. */
const FILLERS = new Set(["the", "a", "an", "my", "our", "todays", "today", "latest", "me", "el", "la", "las", "los", "mi", "un", "una", "de", "del", "hoy", "ultimas", "ultimo"]);
const CANDIDATE_ID = /^news:(briefing|article):(\d{1,12})$/;
const TITLES = { en: "News briefing", es: "Resumen de noticias" };

/**
 * Is this a request for the news briefing? Only when every word left after the fillers is a news
 * word: "the news", "today's headlines", "las noticias de hoy". An album called "Good News" is not.
 */
export function asksForNews(what) {
  const rest = wordsOf(what).filter((x) => !FILLERS.has(x));
  return rest.length > 0 && rest.every((x) => NEWS_WORDS.has(x));
}

const likeText = (s) => String(s).replace(/[\\%_]/g, (ch) => `\\${ch}`);
/**
 * The rows the source reads, through the gateway's database client (openDb() → { execute, close }).
 * SELECT only, every value a bound argument.
 */
export function createMediaReader(openDb) {
  const rows = async (sql, args) => {
    const db = openDb();
    try { return (await db.execute({ sql, args })).rows || []; } finally { try { db.close?.(); } catch {} }
  };
  return {
    /** Do the media bundle's tables exist on this instance? */
    exists: async () => { try { await rows("SELECT 1 FROM media_briefings LIMIT 1", []); return true; } catch { return false; } },
    briefings: (limit) => rows("SELECT id, title, audio_path, created_at FROM media_briefings WHERE audio_path IS NOT NULL ORDER BY id DESC LIMIT ?", [limit]),
    briefing: async (id) => (await rows("SELECT id, title, audio_path, created_at FROM media_briefings WHERE id = ? AND audio_path IS NOT NULL", [id]))[0] || null,
    articles: (text, limit) => rows("SELECT c.article_id AS id, a.title AS title, c.audio_path AS audio_path FROM media_audio_cache c JOIN media_articles a ON a.id = c.article_id WHERE lower(a.title) LIKE ? ESCAPE '\\' ORDER BY c.last_accessed DESC LIMIT ?", [`%${likeText(text)}%`, limit]),
    article: async (id) => (await rows("SELECT c.article_id AS id, a.title AS title, c.audio_path AS audio_path FROM media_audio_cache c JOIN media_articles a ON a.id = c.article_id WHERE c.article_id = ?", [id]))[0] || null,
  };
}

/**
 * reader   createMediaReader(openDb), or anything with the same five functions
 * dataDir  the instance's data directory (audio lives in <dataDir>/media/audio/)
 * now      () → ms
 */
export function createNewsSource({ reader, dataDir, now = Date.now, maxAgeDays = NEWS_MAX_AGE_DAYS } = {}) {
  const configured = !!reader && typeof dataDir === "string" && dataDir.length > 0;
  /** The file's real path when it may be served, else null. */
  function servable(p) {
    if (!configured || typeof p !== "string" || p.length > 1024 || !p.toLowerCase().endsWith(".mp3")) return null;
    try {
      const root = realpathSync(join(dataDir, "media", "audio")) + sep;
      const real = realpathSync(p);              // follows links: a link out of the directory resolves outside it
      return real.startsWith(root) && real.toLowerCase().endsWith(".mp3") && statSync(real).isFile() ? real : null;
    } catch { return null; }                     // no such directory, no such file
  }
  /** Whole days since the row was written ("YYYY-MM-DD HH:MM:SS", UTC); the file's own date when that cannot be read. */
  function ageDays(createdAt, file) {
    let t = Date.parse(`${String(createdAt || "").replace(" ", "T")}Z`);
    if (!Number.isFinite(t)) { try { t = statSync(file).mtimeMs; } catch { return null; } }
    return Math.max(0, Math.floor((now() - t) / DAY_MS));
  }
  const title = (row, lang) => cleanName(row?.title) || TITLES[lang === "es" ? "es" : "en"];

  async function search(what, { explicit = false, lang = "en" } = {}) {
    if (!configured) return [];
    const w = wordsOf(what);
    try {
      if (asksForNews(what) || (explicit && !w.length)) {
        const none = { id: "news:briefing:none", kind: "briefing", title: title(null, lang), subtitle: "", confident: true, refuse: { say: "say_news_none" } };
        // The newest briefing whose audio file is really there. A row whose file is gone has no audio.
        const hit = (await reader.briefings(5)).map((row) => ({ row, file: servable(row.audio_path) })).find((x) => x.file);
        if (!hit) return [none];
        const c = { id: `news:briefing:${Number(hit.row.id)}`, kind: "briefing", title: title(hit.row, lang), subtitle: "", confident: true };
        if (!CANDIDATE_ID.test(c.id)) return [none];
        const days = ageDays(hit.row.created_at, hit.file);
        return [days !== null && days > maxAgeDays ? { ...c, refuse: { say: "say_news_stale", vars: { days } } } : c];
      }
      // An article read aloud is found by its title only when the request named the news source.
      if (!explicit || !w.length) return [];
      const ok = (await reader.articles(w.join(" "), 4)).filter((row) => servable(row.audio_path) && CANDIDATE_ID.test(`news:article:${Number(row.id)}`));
      return ok.map((row) => ({ id: `news:article:${Number(row.id)}`, kind: "article", title: cleanName(row.title) || "Article", subtitle: "", confident: ok.length === 1 }));
    } catch { return []; }      // no media tables on this instance: there is no news here
  }

  async function queue(candidate) {
    const m = configured && !candidate?.refuse ? CANDIDATE_ID.exec(String(candidate?.id || "")) : null;
    if (!m) return [];
    let row = null;
    try { row = await (m[1] === "briefing" ? reader.briefing(Number(m[2])) : reader.article(Number(m[2]))); } catch { return []; }
    const file = servable(row?.audio_path);
    if (!file) return [];
    return [{ kind: m[1], id: candidate.id, title: cleanName(row.title) || cleanName(candidate.title) || TITLES.en, subtitle: "", form: "audio", codec: "mp3", source: "news", upstream: { file, root: join(dataDir, "media", "audio") } }];
  }

  return {
    kind: "news",
    contract: 1,
    available: () => configured,
    search,
    queue,
    async resolve(candidate) {
      const [one] = await queue(candidate);
      if (!one) throw new Error("audio file gone");
      return one;
    },
    choose: (candidates, utterance) => choose(candidates, utterance),
  };
}
