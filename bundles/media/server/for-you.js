/**
 * Media Hub's picks for Crow's For You page (For You v1): a few good news stories, each with the
 * evidence for why it was picked, read from Media Hub's own tables. For You never reads these
 * tables itself; it imports this module from the installed bundle and renders what comes back.
 *
 *   forYouStories(db, opts)        -> [{ id, title, url, summary, sourceId, sourceName, publishedAt, score, why }]
 *   hiddenSources(db)              -> [{ id, name }]   (sources hidden from the picks)
 *   setSourceHidden(db, id, flag)  -> true when a source row matched
 *
 * Curation beats quantity: a story is picked only when it is fresh, unread, not thumbed down,
 * links to an http(s) page and scores at least MIN_SCORE. At most PER_SOURCE stories come from one
 * source and at most `limit` in all; fewer, or none, when there aren't good ones. No randomness
 * (Media Hub's own "For You" sort adds a random diversity term; a digest must not shuffle on reload).
 *
 * `why` is evidence, never prose: { kind: "topic" | "source" | "category", label, affinity } for a
 * liked interest-profile entry the story matches, else { kind: "new" } (fresh from a source you
 * follow). The page turns it into words. There is no popularity term: nothing in Media Hub writes
 * media_articles.popularity_score (it stays at its default 0), so it could never be a reason.
 * With no profile data a story passes MIN_SCORE up to about 20.6 h old.
 *
 * "Hide this source" sets media_sources.curation_hidden: the source keeps fetching and stays in
 * Media Hub's own feed; it is only left out of these picks, and can be shown again.
 */

export const PICK_MAX = 8;
export const MIN_SCORE = 0.45;
export const FRESH_HOURS = 48;
export const PER_SOURCE = 2;
/** An interest-profile affinity at or above this counts as "you like it" (neutral is 0.5). */
export const LIKED = 0.6;
const CANDIDATES = 400;
const PROFILE_ROWS = 5000;
/** News is read, not played: podcasts and videos belong to Listen, not this digest. */
const NEWS_TYPES = ["rss", "google_news"];

const httpUrl = (v) => {
  try { const u = new URL(String(v || "").trim()); return u.protocol === "http:" || u.protocol === "https:" ? u.href : ""; } catch { return ""; }
};
const list = (raw) => {
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v.map((x) => String(x).toLowerCase().trim()).filter(Boolean) : []; } catch { return []; }
};
/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) or an ISO string -> ms, or NaN. */
function timeOf(s) {
  const v = String(s || "");
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? v.replace(" ", "T") + "Z" : v);
}

/** Map "type:key" -> { affinity, key } for every interest-profile row (bounded). */
async function profiles(db) {
  const { rows } = await db.execute({
    sql: "SELECT profile_type, profile_key, affinity FROM media_interest_profiles ORDER BY interaction_count DESC LIMIT ?",
    args: [PROFILE_ROWS],
  });
  return new Map(rows.map((r) => [`${r.profile_type}:${String(r.profile_key).toLowerCase()}`, { key: String(r.profile_key), affinity: Number(r.affinity) }]));
}

/** The story's score and its best "why", from the profiles it matches. Pure. */
export function scoreStory(a, prof, now) {
  const ageH = (now - timeOf(a.pub_date || a.created_at)) / 3600000;
  const fresh = Number.isFinite(ageH) ? Math.max(0, Math.min(1, 1 - ageH / FRESH_HOURS)) : 0;
  const hits = { topic: [], source: [], category: [] };
  const src = prof.get(`source:${a.source_id}`);
  if (src) hits.source.push({ ...src, label: String(a.source_name || "") });
  for (const t of list(a.topics)) { const p = prof.get(`topic:${t}`); if (p) hits.topic.push({ ...p, label: t }); }
  for (const c of list(a.categories)) { const p = prof.get(`category:${c}`); if (p) hits.category.push({ ...p, label: c }); }
  const all = [...hits.topic, ...hits.source, ...hits.category];
  const interest = all.length ? all.reduce((s, h) => s + h.affinity, 0) / all.length : 0.5;
  const score = 0.35 * fresh + 0.5 * interest;
  // The most specific liked match wins: a topic, then the source, then a category.
  let why = null;
  for (const kind of ["topic", "source", "category"]) {
    const best = hits[kind].filter((h) => h.affinity >= LIKED).sort((x, y) => y.affinity - x.affinity)[0];
    if (best) { why = { kind, label: best.label, affinity: Math.round(best.affinity * 100) / 100 }; break; }
  }
  if (!why) why = { kind: "new" };
  return { score, why };
}

/**
 * The picks, best first. Reads at most CANDIDATES articles (newest first, within FRESH_HOURS) and
 * the interest profiles; no model, no network.
 */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Feed HTML to plain text: tags dropped, the common entities decoded, spaces collapsed. */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, n) => {
      const k = n.toLowerCase();
      if (k.startsWith("#")) {
        // Feed text is untrusted: an out-of-range code point would throw.
        const cp = k.startsWith("#x") ? parseInt(k.slice(2), 16) : Number(k.slice(1));
        return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
      }
      return ENTITIES[k] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A story's summary and publisher, from the feed's summary field. Google News
 * feeds put "<a href>Title</a>&nbsp;&nbsp;<font>Publisher</font>" there: the
 * publisher is lifted out and the rest dropped (it is only the title again).
 * A summary that just repeats the title is no summary.
 */
export function storySummary(summary, title) {
  const raw = String(summary ?? "");
  const pub = raw.match(/<font\b[^>]*>([^<]{1,120})<\/font>/i);
  const publisher = pub ? htmlToText(pub[1]) || null : null;
  let text = htmlToText(pub ? raw.replace(pub[0], " ") : raw);
  const t = htmlToText(title).toLowerCase();
  const lower = text.toLowerCase();
  if (t && (lower === t || (lower.startsWith(t) && lower.length - t.length < 20))) text = "";
  return { summary: text || null, publisher };
}

export async function forYouStories(db, { limit = PICK_MAX, now = Date.now() } = {}) {
  const cap = Math.max(0, Math.min(PICK_MAX, Number(limit) || 0));
  if (!cap) return [];
  const since = new Date(now - FRESH_HOURS * 3600000).toISOString();
  const { rows } = await db.execute({
    sql: `SELECT a.id, a.title, a.url, a.summary, a.pub_date, a.created_at, a.topics, a.categories, a.source_id, s.name AS source_name
            FROM media_articles a
            JOIN media_sources s ON s.id = a.source_id
            LEFT JOIN media_article_states st ON st.article_id = a.id
           WHERE s.enabled = 1 AND COALESCE(s.curation_hidden, 0) = 0
             AND s.source_type IN (${NEWS_TYPES.map(() => "?").join(",")})
             AND COALESCE(st.is_read, 0) = 0
             AND a.url IS NOT NULL AND a.url != ''
             AND julianday(COALESCE(a.pub_date, a.created_at)) >= julianday(?)
             AND NOT EXISTS (SELECT 1 FROM media_feedback f WHERE f.article_id = a.id AND f.feedback = 'down')
           ORDER BY COALESCE(a.pub_date, a.created_at) DESC
           LIMIT ?`,
    args: [...NEWS_TYPES, since, CANDIDATES],
  });
  const prof = await profiles(db);
  const scored = [];
  for (const a of rows) {
    const url = httpUrl(a.url);
    const title = String(a.title || "").replace(/\s+/g, " ").trim();
    if (!url || !title) continue;
    const { score, why } = scoreStory(a, prof, now);
    if (score < MIN_SCORE) continue;
    let summary = null, publisher = null;
    try { ({ summary, publisher } = storySummary(a.summary, title)); } catch { /* one bad item never sinks the list */ }
    scored.push({
      id: Number(a.id), title, url, summary,
      sourceId: Number(a.source_id),
      sourceName: publisher || String(a.source_name || ""),
      publishedAt: String(a.pub_date || a.created_at || ""),
      score: Math.round(score * 1000) / 1000, why,
    });
  }
  scored.sort((x, y) => y.score - x.score || y.id - x.id);
  const out = [];
  const perSource = new Map();
  const titles = new Set();
  for (const s of scored) {
    const key = s.title.toLowerCase();
    const n = perSource.get(s.sourceId) || 0;
    if (titles.has(key) || n >= PER_SOURCE) continue;
    titles.add(key);
    perSource.set(s.sourceId, n + 1);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Sources hidden from the picks, by name. */
export async function hiddenSources(db) {
  const { rows } = await db.execute("SELECT id, name FROM media_sources WHERE COALESCE(curation_hidden, 0) = 1 ORDER BY name COLLATE NOCASE, id");
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name || "") }));
}

/** Hide a source from the picks, or show it again. True when the source exists. */
export async function setSourceHidden(db, sourceId, hidden) {
  const id = Number(sourceId);
  if (!Number.isInteger(id) || id < 1) return false;
  const r = await db.execute({ sql: "UPDATE media_sources SET curation_hidden = ? WHERE id = ?", args: [hidden ? 1 : 0, id] });
  return Number(r.rowsAffected) > 0;
}
