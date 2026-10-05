/**
 * Shows that follow a briefing. An attachment is "today's episode of a show the operator
 * subscribes to", played after the narration as its own queue item, streamed from the publisher
 * as published. Nothing is downloaded, cut or re-encoded.
 *
 * A daily briefing is written before the episode may exist, so each attachment starts `pending`
 * and a watcher fills it in when the show's feed carries the episode (`ready`), or gives up at
 * `wait_until` (`missed`). If the episode is not out when the narration ends, playback stops and
 * the card says it is still being checked for; there is no other mode.
 */
import { fetchFeedIfChanged, parseFeed, buildAuthHeaders } from "./feed-fetcher.js";
import { insertFeedItems } from "./tasks.js";
import { cleanForSpeech, spokenWhen } from "./briefing-text.js";
import { notify } from "./notify.js";
import { tr } from "./strings.js";

const MIN = 60_000, HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const httpUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);

/** Attachments for one occurrence, from the schedule settings: each configured show whose days include that local weekday. */
export async function planAttachments(db, cfg, occMs) {
  const out = [];
  const when = spokenWhen(occMs, cfg.tz, "en");
  for (const a of cfg.attach || []) {
    if (!a.days.includes(when.dow)) continue;
    const { rows } = await db.execute({ sql: "SELECT id, name FROM media_sources WHERE id = ? AND enabled = 1", args: [a.source_id] });
    if (!rows[0]) continue;
    out.push({
      key: `show:${a.source_id}`, source_id: a.source_id, title: cleanForSpeech(rows[0].name).slice(0, 80) || "Show", status: "pending",
      expect: when.ymd, title_prefix: a.title_prefix || "", wait_until: iso(occMs + a.wait_hours * HOUR),
      article_id: null, url: null, duration_sec: null, first_seen_at: null,
    });
  }
  return out;
}

/**
 * The feed item that is this occurrence's episode: an audio enclosure at an http(s) address, a
 * publish stamp from 6 hours before to 18 hours after the occurrence, and, when the attachment
 * names one, a title that starts with `title_prefix` (a feed may carry extras with the same stamp).
 * With no prefix: when the feed titles its items with dates (any item's title carries YYYY-MM-DD, as
 * daily shows title their episodes), ONLY an item titled with the occurrence's local date (`expect`)
 * counts, so an undated extra with the same stamp is never taken for the episode. A feed with no
 * dated titles falls back to the first audio item in the window.
 * The prefix is compared as plain text; no pattern from settings is ever compiled.
 */
export function matchEpisode(att, occMs, items) {
  const prefix = String(att.title_prefix || "").toLowerCase();
  const expect = /^\d{4}-\d{2}-\d{2}$/.test(att.expect || "") ? att.expect : null;
  const dated = expect && (items || []).some((i) => /\b\d{4}-\d{2}-\d{2}\b/.test(String(i?.title || ""))) ? expect : null;
  let first = null;
  for (const item of items || []) {
    const t = Date.parse(item.pub_date || "");
    if (!httpUrl(item.enclosureAudio) || !Number.isFinite(t)) continue;
    if (t < occMs - 6 * HOUR || t > occMs + 18 * HOUR) continue;
    const title = String(item.title || "");
    if (prefix) { if (title.toLowerCase().startsWith(prefix)) return item; continue; }
    if (dated) { if (title.includes(dated)) return item; continue; }
    first ||= item;
  }
  return first;
}

/** Poll every minute for the first 20 minutes after the occurrence, every 5 minutes before and after. */
export function pollIntervalMs(nowMs, occMs) {
  return nowMs >= occMs && nowMs - occMs < 20 * MIN ? MIN : 5 * MIN;
}

const lastPoll = new Map();   // "<briefing id>:<key>" → ms of the last poll (per process)
const etags = new Map();      // source id → ETag of the last feed body this process parsed

async function swapAttachments(db, id, before, list) {
  const r = await db.execute({ sql: "UPDATE media_briefings SET attachments = ? WHERE id = ? AND attachments = ?", args: [JSON.stringify(list), id, before] });
  return Number(r.rowsAffected) === 1;
}

/**
 * One pass over pending attachments of recent daily briefings. Safe to run from more than one
 * process: an attachment is filled by a compare-and-swap on the stored text, and only the process
 * that wins it sends the "is ready" notice (sent only when the episode lands more than 10 minutes
 * after the briefing was announced). deps: { now?, notify?, notifyEnabled?, lang? }
 * → { polled, ready, missed }
 */
export async function watchAttachments(db, deps = {}) {
  const now = (deps.now || Date.now)();
  const send = deps.notify || notify;
  const out = { polled: 0, ready: 0, missed: 0 };
  const { rows } = await db.execute({
    sql: `SELECT id, scheduled_for, attachments, announced_at, lang FROM media_briefings
          WHERE kind = 'daily' AND scheduled_for IS NOT NULL AND attachments LIKE '%"pending"%' AND julianday(scheduled_for) > julianday(?)`,
    args: [iso(now - 24 * HOUR)],
  });
  for (const row of rows) {
    const occMs = Date.parse(row.scheduled_for);
    let list;
    try { list = JSON.parse(row.attachments); } catch { continue; }
    if (!Array.isArray(list) || !Number.isFinite(occMs)) continue;
    let text = row.attachments;
    for (let i = 0; i < list.length; i++) {
      const att = list[i];
      if (att?.status !== "pending") continue;
      const pollKey = `${row.id}:${att.key}`;
      if (now > Date.parse(att.wait_until)) {
        const next = list.map((a, j) => (j === i ? { ...a, status: "missed" } : a));
        if (await swapAttachments(db, row.id, text, next)) { out.missed++; list = next; text = JSON.stringify(next); console.error(`[media] show "${att.title}" was not published by ${att.wait_until}`); }
        lastPoll.delete(pollKey);
        continue;
      }
      if (now - (lastPoll.get(pollKey) ?? -Infinity) < pollIntervalMs(now, occMs) - 5000) continue;
      lastPoll.set(pollKey, now);
      out.polled++;
      try {
        const src = (await db.execute({ sql: "SELECT id, name, url, source_type, auth_config FROM media_sources WHERE id = ? AND enabled = 1", args: [att.source_id] })).rows[0];
        if (!src) continue;
        const res = await fetchFeedIfChanged(src.url, etags.get(src.id) || null, buildAuthHeaders(src.auth_config));
        if (!res.changed) continue;
        const { items } = parseFeed(res.xml);
        await insertFeedItems(db, src, items);
        const hit = matchEpisode(att, occMs, items);
        if (!hit) { etags.set(src.id, res.etag); continue; }   // remembered only when there was nothing to find
        const guid = hit.guid || hit.link || hit.title;
        const article = (await db.execute({ sql: "SELECT id FROM media_articles WHERE source_id = ? AND guid = ?", args: [src.id, guid] })).rows[0];
        const filled = { ...att, status: "ready", article_id: article ? Number(article.id) : null, url: hit.enclosureAudio, episode_title: cleanForSpeech(hit.title).slice(0, 120), duration_sec: hit.duration ?? null, first_seen_at: iso(now) };
        const next = list.map((a, j) => (j === i ? filled : a));
        if (!(await swapAttachments(db, row.id, text, next))) break;   // another runner changed this row; it will finish it
        list = next; text = JSON.stringify(next); out.ready++;
        lastPoll.delete(pollKey);
        console.error(`[media] show "${att.title}" first seen ${filled.first_seen_at} (${Math.round((now - occMs) / MIN)} min after the occurrence)`);
        const announcedMs = Date.parse(row.announced_at || "");
        if (deps.notifyEnabled !== false && Number.isFinite(announcedMs) && now - announcedMs > 10 * MIN) {
          const lang = row.lang || deps.lang || "en";
          await send(db, { title: tr("n_show_title", lang, { show: att.title }), action_url: filled.article_id ? `/dashboard/media?play=episode:${filled.article_id}` : `/dashboard/media?play=briefing:${row.id}`, source: "media:show", priority: "low" });
        }
      } catch (err) {
        console.error(`[media] show "${att.title}" could not be checked: ${String(err.message || err).slice(0, 160)}`);
      }
    }
  }
  return out;
}

/** For tests: forget this process's poll times and saved ETags. */
export function resetWatcherState() { lastPoll.clear(); etags.clear(); }
