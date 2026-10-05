/**
 * The briefing object: a row in media_briefings plus an audio file. One builder for the tool, the
 * panel and the schedule.
 *
 * Row contract (what readers outside this bundle may rely on; a kiosk reads the table directly):
 *   1. audio_path is non-null only for a complete, non-empty .mp3 inside <data dir>/media/audio/.
 *      The file is renamed into place first, the row is updated second. A row whose file has gone
 *      is cleared by repairBriefingAudio at start.
 *   2. status 'ready' means the text is final. Audio may be absent; `error` then says why in a word.
 *   3. created_at is SQLite UTC ("YYYY-MM-DD HH:MM:SS"). A newer briefing has a higher id.
 *   4. The script's first paragraph states the day and date.
 *   5. kind 'daily' rows carry scheduled_for (UTC ISO of the occurrence); there is one per occurrence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeLikePattern } from "./db.js";
import { selectStories, spokenWhen, briefingTitle, buildScript } from "./briefing-text.js";
import { synthesizeToFile, insideAudioDir, resolveAudioDir } from "./speech.js";

/**
 * Site feeds are the only briefing text. Search feeds (google_news) are headline-only and can never
 * be in a briefing; video channels and shows are not read aloud either.
 */
export const BRIEFING_SOURCE_TYPES = Object.freeze(["rss"]);

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const fromSqlTime = (s) => Date.parse(`${String(s || "").replace(" ", "T")}Z`);
const json = (text, fallback) => { try { const v = JSON.parse(text); return v ?? fallback; } catch { return fallback; } };
const types = BRIEFING_SOURCE_TYPES.map(() => "?").join(", ");

/** A process's start time in clock ticks since boot (/proc/<pid>/stat field 22), or "?" off Linux. */
export function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || "?";
  } catch { return "?"; }
}

/** This process, as the owner of a claim: "<pid>:<start>". A recycled pid has another start. */
export const OWNER = `${process.pid}:${processStart(process.pid)}`;

/**
 * Is the process that wrote `owner` still running? Unknown or unreadable owners count as alive
 * (the 20-minute rule still applies to them); a gone pid, or a pid now held by a process that
 * started at another time, is dead.
 */
export function ownerAlive(owner, { kill = process.kill.bind(process), startOf = processStart } = {}) {
  const m = /^(\d{1,10}):(\S{1,24})$/.exec(String(owner || ""));
  if (!m) return true;
  const pid = Number(m[1]);
  try { kill(pid, 0); } catch (err) { if (err?.code === "ESRCH") return false; }
  const now = startOf(pid);
  return m[2] === "?" || now === "?" || now === m[2];
}

/**
 * Insert a 'generating' row. For a daily briefing this is the claim: the unique index on
 * scheduled_for lets exactly one caller, in any process, get an id. → id, or null when already claimed.
 */
export async function createBriefing(db, { kind = "manual", scheduledFor = null, lang = "en", title = null, createdMs = Date.now() } = {}) {
  const r = await db.execute({
    sql: "INSERT OR IGNORE INTO media_briefings (title, kind, status, scheduled_for, attempts, lang, voice, created_at, owner) VALUES (?, ?, 'generating', ?, 1, ?, NULL, ?, ?)",
    args: [title, kind, scheduledFor, lang, iso(createdMs).slice(0, 19).replace("T", " "), OWNER],
  });
  return Number(r.rowsAffected) === 1 ? Number(r.lastInsertRowid) : null;
}

/** Enabled site-feed sources: the ones a run refreshes first and may quote. */
export async function briefingSourceIds(db) {
  const { rows } = await db.execute({ sql: `SELECT id FROM media_sources WHERE enabled = 1 AND source_type IN (${types}) ORDER BY id`, args: [...BRIEFING_SOURCE_TYPES] });
  return rows.map((r) => Number(r.id));
}

async function candidateRows(db, { sinceMs, nowMs, topic }) {
  let sql = `SELECT a.id, a.title, a.url, a.pub_date, a.summary, a.content_full, a.source_id, s.name AS source_name
             FROM media_articles a JOIN media_sources s ON s.id = a.source_id
             WHERE s.enabled = 1 AND s.source_type IN (${types}) AND a.audio_url IS NULL
               AND a.pub_date IS NOT NULL AND julianday(a.pub_date) > julianday(?) AND julianday(a.pub_date) <= julianday(?)`;
  const args = [...BRIEFING_SOURCE_TYPES, iso(sinceMs), iso(nowMs + 10 * 60_000)];
  if (topic) {
    const like = `%${escapeLikePattern(String(topic).slice(0, 200))}%`;
    sql += " AND (s.category LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')";
    args.push(like, like);
  }
  sql += " ORDER BY julianday(a.pub_date) DESC, a.id DESC LIMIT 400";
  return (await db.execute({ sql, args })).rows;
}

/**
 * Text stage: refresh the site feeds, choose stories, write the script, store it with a snapshot of
 * its stories (items_json), so the briefing never depends on article rows staying alive.
 * opts: { kind, occurrenceMs?, topic?, maxStories?, perSource?, tz, lang, attachments?, refreshCapMs? }
 * deps: { now?, refresh?(db, sourceIds, capMs) }
 */
export async function writeBriefing(db, id, opts = {}, deps = {}) {
  const now = (deps.now || Date.now)();
  const { kind = "manual", topic = null, tz = "UTC", lang = "en", attachments = [] } = opts;
  if (deps.refresh) await deps.refresh(db, await briefingSourceIds(db), opts.refreshCapMs ?? 90_000);

  let sinceMs = now - (topic ? 72 : 24) * HOUR;
  if (kind === "daily") {
    const prev = await db.execute({ sql: "SELECT scheduled_for FROM media_briefings WHERE kind = 'daily' AND status = 'ready' AND id != ? ORDER BY id DESC LIMIT 1", args: [id] });
    const prevMs = Date.parse(prev.rows[0]?.scheduled_for || "");
    if (Number.isFinite(prevMs)) sinceMs = Math.max(now - 36 * HOUR, prevMs);
  }
  const stories = selectStories(await candidateRows(db, { sinceMs, nowMs: now, topic }), { maxStories: opts.maxStories ?? 8, perSource: opts.perSource ?? 2 });
  const when = spokenWhen(opts.occurrenceMs ?? now, tz, lang);
  const title = briefingTitle({ kind, topic, when, lang });
  const { paragraphs, chapters } = buildScript({ stories, when, lang, show: attachments[0]?.title || null });
  await db.execute({
    sql: `UPDATE media_briefings SET title = ?, script = ?, article_ids = ?, items_json = ?, chapters = ?, attachments = ?, lang = ?
          WHERE id = ? AND status = 'generating'`,
    args: [
      title, paragraphs.join("\n\n"), JSON.stringify(stories.map((s) => s.article_id)),
      JSON.stringify(stories.map((s) => ({ title: s.title, link: s.link, source: s.source, article_id: s.article_id }))),
      JSON.stringify(chapters.map((t) => ({ title: t, start_sec: null }))), JSON.stringify(attachments), lang, id,
    ],
  });
  return { id, title, stories: stories.length };
}

/**
 * Voice stage: speak the stored script with the local voice, then publish. The text is published
 * whether or not there is audio. deps: { audio? (false = text only), voice?, speech? (passed to synthesizeToFile), now? }
 */
export async function voiceBriefing(db, id, deps = {}) {
  const { rows } = await db.execute({ sql: "SELECT id, script, lang, chapters, status FROM media_briefings WHERE id = ?", args: [id] });
  const row = rows[0];
  if (!row || row.status !== "generating" || !row.script) return { ok: false, error: "not_generating" };
  const outPath = join(resolveAudioDir(), `briefing-${id}.mp3`);
  const r = deps.audio === false
    ? { ok: false, error: "disabled" }
    : await synthesizeToFile(db, { segments: String(row.script).split("\n\n"), lang: row.lang || "en", outPath, voice: deps.voice || null }, deps.speech || {});
  const chapters = json(row.chapters, []).map((c, i) => ({ title: c.title, start_sec: r.ok ? r.offsets[i] ?? null : null }));
  await db.execute({
    sql: `UPDATE media_briefings SET status = 'ready', ready_at = ?, audio_path = ?, duration_sec = ?, file_size = ?, tts_provider = ?, voice = ?, chapters = ?, error = ?
          WHERE id = ? AND status = 'generating'`,
    args: [iso((deps.now || Date.now)()), r.ok ? r.path : null, r.ok ? r.duration_sec : null, r.ok ? r.file_size : null, r.ok ? r.provider : null, r.ok ? r.voice : null, JSON.stringify(chapters), r.ok ? null : r.error, id],
  });
  return r.ok ? { ok: true, duration_sec: r.duration_sec } : { ok: false, error: r.error };
}

/** Both stages. A thrown error is recorded on the row (still 'generating') and rethrown: the caller decides between retry and failure. */
export async function makeBriefing(db, id, opts = {}, deps = {}) {
  try {
    const written = await writeBriefing(db, id, opts, deps);
    const voiced = await voiceBriefing(db, id, deps);
    return { ...written, audio: voiced.ok, error: voiced.ok ? null : voiced.error };
  } catch (err) {
    await db.execute({ sql: "UPDATE media_briefings SET error = ? WHERE id = ? AND status = 'generating'", args: [String(err?.message || err).slice(0, 200), id] }).catch(() => {});
    throw err;
  }
}

/** → true when this call moved the row from 'generating' to 'failed'. */
export async function failBriefing(db, id, error) {
  const r = await db.execute({ sql: "UPDATE media_briefings SET status = 'failed', error = ? WHERE id = ? AND status = 'generating'", args: [String(error || "failed").slice(0, 200), id] });
  return Number(r.rowsAffected) === 1;
}

/**
 * A briefing asked for by hand whose maker went away (a tool-only copy of this server ends with its
 * turn; a gateway restart ends a panel request's background work) would stay 'generating' for ever.
 * Close those out. Daily briefings have their own retry rule and are not touched. → rows closed
 */
export async function closeStuckBriefings(db, { now = Date.now(), olderThanMs = 20 * 60_000 } = {}) {
  const r = await db.execute({
    sql: "UPDATE media_briefings SET status = 'failed', error = 'stuck' WHERE status = 'generating' AND COALESCE(kind, 'manual') != 'daily' AND julianday(created_at) < julianday(?)",
    args: [iso(now - olderThanMs)],
  });
  return Number(r.rowsAffected) || 0;
}

/** A briefing as the API and the tab show it. `audio_url` is set only when the file passes the row contract. */
export function presentBriefing(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const createdMs = fromSqlTime(row.created_at);
  const audio = insideAudioDir(row.audio_path);
  const whenMs = Date.parse(row.scheduled_for || "") || createdMs;
  return {
    id: Number(row.id),
    kind: row.kind || "manual",
    status: row.status || "ready",
    title: row.title || "",
    lang: row.lang || "en",
    date: Number.isFinite(whenMs) ? iso(whenMs) : null,
    created_at: Number.isFinite(createdMs) ? iso(createdMs) : null,
    scheduled_for: row.scheduled_for || null,
    ready_at: row.ready_at || null,
    late: !!(row.scheduled_for && row.ready_at && Date.parse(row.ready_at) > Date.parse(row.scheduled_for) + 60_000),
    age_hours: Number.isFinite(createdMs) ? Math.max(0, Math.round(((now - createdMs) / HOUR) * 100) / 100) : null,
    script: row.script || "",
    duration_sec: audio ? row.duration_sec ?? null : null,
    audio_url: audio ? `/api/media/briefings/${Number(row.id)}/audio` : null,
    chapters: json(row.chapters, []),
    items: json(row.items_json, []),
    attachments: json(row.attachments, []),
    error: row.error || null,
  };
}

export async function getBriefing(db, id, opts) {
  const { rows } = await db.execute({ sql: "SELECT * FROM media_briefings WHERE id = ?", args: [Number(id) || 0] });
  return presentBriefing(rows[0], opts);
}

export async function listBriefings(db, { limit = 20, now } = {}) {
  const { rows } = await db.execute({ sql: "SELECT * FROM media_briefings ORDER BY id DESC LIMIT ?", args: [Math.min(Math.max(1, Number(limit) || 20), 50)] });
  return rows.map((r) => presentBriefing(r, { now }));
}

/**
 * The newest finished briefing, or null.
 *   withAudio   (default true)  only a briefing whose audio file is present
 *   maxAgeHours (default none)  only when it was created less than this many hours ago (strictly)
 *   kind        (default any)   "daily" for the scheduled one
 * "Newest" is by id. When the newest one that qualifies on audio and kind is too old, the answer is
 * null: an older briefing is never offered in its place.
 */
export async function getLatestBriefing(db, { withAudio = true, maxAgeHours = null, kind = null, now = Date.now() } = {}) {
  const args = [];
  let sql = "SELECT * FROM media_briefings WHERE COALESCE(status, 'ready') = 'ready'";
  if (withAudio) sql += " AND audio_path IS NOT NULL";
  if (kind) { sql += " AND COALESCE(kind, 'manual') = ?"; args.push(String(kind)); }
  sql += " ORDER BY id DESC LIMIT 10";
  const { rows } = await db.execute({ sql, args });
  const row = withAudio ? rows.find((r) => insideAudioDir(r.audio_path)) : rows[0];
  if (!row) return null;
  if (maxAgeHours !== null && maxAgeHours !== undefined) {
    const ageMs = now - fromSqlTime(row.created_at);
    if (!(ageMs < Number(maxAgeHours) * HOUR)) return null;   // also null when created_at cannot be read
  }
  return presentBriefing(row, { now });
}

/**
 * Start-up repair for row contract 1: clear audio_path where the file is missing, empty, or outside
 * the audio directory, and drop article-audio rows in the same state. The text is never touched.
 */
export async function repairBriefingAudio(db) {
  let cleared = 0, dropped = 0;
  const b = await db.execute("SELECT id, audio_path FROM media_briefings WHERE audio_path IS NOT NULL");
  for (const row of b.rows) {
    if (insideAudioDir(row.audio_path)) continue;
    const r = await db.execute({ sql: "UPDATE media_briefings SET audio_path = NULL, duration_sec = NULL, file_size = NULL, error = COALESCE(error, 'audio_missing') WHERE id = ? AND audio_path = ?", args: [row.id, row.audio_path] });
    cleared += Number(r.rowsAffected) || 0;
  }
  const c = await db.execute("SELECT id, audio_path FROM media_audio_cache");
  for (const row of c.rows) {
    if (insideAudioDir(row.audio_path)) continue;
    const r = await db.execute({ sql: "DELETE FROM media_audio_cache WHERE id = ? AND audio_path = ?", args: [row.id, row.audio_path] });
    dropped += Number(r.rowsAffected) || 0;
  }
  if (cleared || dropped) console.error(`[media] audio repair: cleared ${cleared} briefing path(s), dropped ${dropped} article audio row(s) with no file`);
  return { cleared, dropped };
}
