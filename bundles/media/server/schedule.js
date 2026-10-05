/**
 * The daily briefing schedule.
 *
 * WHEN lives in one row of the core `schedules` table (task "media:briefing"): its
 * cron_expression and `enabled` are what the operator, the assistant and the Briefings tab change.
 * Everything else is one per-instance setting, media_briefing_config.
 *
 * The gateway's scheduler is a clock, not a dispatcher: it advances last_run / next_run on this row
 * like any other and runs nothing. So this module never reads those two columns. Each minute it
 * computes the occurrences of the cron expression in the configured time zone itself and claims
 * the one that is due, `lead_min` early, so that "8:00" means ready at 8:00. The claim is a unique
 * index on media_briefings.scheduled_for: a restart, or a second copy of this server, cannot make
 * the same briefing twice. A run missed while nothing was running is made up to `catch_up_hours` late.
 */
import { occurrences, nextOccurrence, parseCron } from "./cron-tz.js";
import { validTimeZone, hostTimeZone } from "./zone.js";
import { CONFIG_KEY, JOB_STATE_KEY, readJsonSetting, writeLocalSetting, instanceLang } from "./settings.js";
import { createBriefing, makeBriefing, failBriefing, closeStuckBriefings, ownerAlive, OWNER } from "./briefing.js";
import { spokenWhen } from "./briefing-text.js";
import { planAttachments, watchAttachments } from "./attachments.js";
import { refreshSources, sqliteUtcMs } from "./tasks.js";
import { notify } from "./notify.js";
import { tr, reasonText } from "./strings.js";

export const SCHEDULE_TASK = "media:briefing";
export const DEFAULT_CRON = "0 8 * * *";
export const STUCK_MS = 20 * 60_000;
const DESCRIPTION = "Daily news briefing (News)";
const MIN = 60_000, HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** Settings with every field present and in range. Unknown fields are dropped. */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const attach = [];
  for (const a of Array.isArray(c.attach) ? c.attach.slice(0, 3) : []) {
    const source_id = Number(a?.source_id);
    if (!Number.isInteger(source_id) || source_id < 1 || attach.some((x) => x.source_id === source_id)) continue;
    const days = [...new Set((Array.isArray(a.days) ? a.days : [1, 2, 3, 4, 5]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    attach.push({ source_id, days, title_prefix: String(a.title_prefix ?? "").slice(0, 80), wait_hours: clamp(a.wait_hours, 0.25, 12, 3.5) });
  }
  return {
    tz: validTimeZone(c.tz) ? String(c.tz) : hostTimeZone(),
    lead_min: Math.round(clamp(c.lead_min, 0, 120, 15)),
    max_stories: Math.round(clamp(c.max_stories, 1, 20, 8)),
    catch_up_hours: clamp(c.catch_up_hours, 0, 24, 4),
    attach,
    notify: c.notify !== false,
    // Occurrences at or before this instant are never made up: a schedule created at 10:00 does
    // not produce "this morning's" 8:00 briefing.
    active_from: Number.isFinite(Date.parse(c.active_from)) ? new Date(Date.parse(c.active_from)).toISOString() : null,
  };
}

/** → { row (the schedules row, or null), cfg } */
export async function readSchedule(db) {
  let rows = [];
  try {
    ({ rows } = await db.execute({ sql: "SELECT id, cron_expression, enabled, next_run FROM schedules WHERE task = ? ORDER BY id LIMIT 1", args: [SCHEDULE_TASK] }));
  } catch (err) {
    if (!/no such table: schedules/.test(String(err?.message))) throw err;   // a database without the core schema: no schedule
  }
  return { row: rows[0] || null, cfg: normalizeConfig(await readJsonSetting(db, CONFIG_KEY)) };
}

/** What the tab and the tool show: { state: "unset" | "off" | "on" | "bad_cron", cron, tz, time, next } */
export function scheduleView(row, cfg, now = Date.now()) {
  if (!row) return { state: "unset", cron: null, tz: cfg.tz, time: null, next: null };
  const view = { state: Number(row.enabled) === 1 ? "on" : "off", cron: row.cron_expression, tz: cfg.tz, time: null, next: null };
  try {
    parseCron(row.cron_expression);
    const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(row.cron_expression).trim());
    if (m) view.time = `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
    if (view.state === "on") view.next = nextOccurrence(row.cron_expression, cfg.tz, now);
  } catch { view.state = "bad_cron"; }
  return view;
}

/**
 * Create or change the one schedule row and the settings. Only the fields given are changed.
 * input: { time? "HH:MM", cron?, enabled?, tz?, max_stories?, lead_min?, catch_up_hours?, notify?, attach? (array; [] removes) }
 * Throws { code: "bad_cron" | "bad_time" | "bad_tz" | "bad_source" } on input it cannot run.
 */
export async function saveSchedule(db, input = {}, { now = Date.now() } = {}) {
  const { row, cfg: current } = await readSchedule(db);
  const fail = (code, message) => Object.assign(new Error(message), { code });
  let cron = row?.cron_expression || DEFAULT_CRON;
  if (input.time !== undefined) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(input.time).trim());
    if (!m) throw fail("bad_time", "Give the time as HH:MM, for example 08:00.");
    cron = `${Number(m[2])} ${Number(m[1])} * * *`;
  } else if (input.cron !== undefined) {
    cron = String(input.cron).trim();
  }
  parseCron(cron);
  if (input.tz !== undefined && !validTimeZone(input.tz)) throw fail("bad_tz", `"${input.tz}" is not a time zone name.`);
  const merged = { ...current };
  for (const k of ["tz", "max_stories", "lead_min", "catch_up_hours", "notify", "attach"]) if (input[k] !== undefined) merged[k] = input[k];
  // An attachment saved without a title_prefix keeps the one already stored for that show: the
  // Briefings tab has no prefix field, so its Save must not wipe one set through the tool.
  if (Array.isArray(input.attach)) {
    merged.attach = input.attach.map((a) => {
      if (a?.title_prefix !== undefined) return a;
      const prev = current.attach.find((x) => x.source_id === Number(a?.source_id));
      return prev ? { ...a, title_prefix: prev.title_prefix } : a;
    });
  }
  const cfg = normalizeConfig(merged);
  for (const a of cfg.attach) {
    const s = (await db.execute({
      sql: `SELECT s.id, s.enabled, s.source_type, (SELECT COUNT(*) FROM media_articles a WHERE a.source_id = s.id AND a.audio_url IS NOT NULL) AS episodes
            FROM media_sources s WHERE s.id = ?`,
      args: [a.source_id],
    })).rows[0];
    if (!s || Number(s.enabled) !== 1 || !(s.source_type === "podcast" || Number(s.episodes) > 0)) throw fail("bad_source", `Source ${a.source_id} is not an enabled show with audio episodes.`);
  }
  const enabled = input.enabled === undefined ? (row ? Number(row.enabled) === 1 : true) : !!input.enabled;
  // A new start point whenever WHEN changes (row, time, on/off, zone): a save never makes up an
  // occurrence that only became "past" because of the change itself.
  if (!row || cron !== row.cron_expression || enabled !== (Number(row.enabled) === 1) || cfg.tz !== current.tz || !cfg.active_from) cfg.active_from = iso(now);
  const next = enabled ? nextOccurrence(cron, cfg.tz, now) : null;
  await writeLocalSetting(db, CONFIG_KEY, JSON.stringify(cfg));
  if (row) {
    await db.execute({ sql: "UPDATE schedules SET cron_expression = ?, enabled = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?", args: [cron, enabled ? 1 : 0, next ? iso(next) : null, row.id] });
  } else {
    await db.execute({ sql: "INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?, ?, ?, ?, ?)", args: [SCHEDULE_TASK, cron, DESCRIPTION, enabled ? 1 : 0, next ? iso(next) : null] });
  }
  const after = await readSchedule(db);
  return { ...after, view: scheduleView(after.row, after.cfg, now) };
}

async function generate(db, id, occMs, cfg, lang, deps) {
  try {
    const attachments = await planAttachments(db, cfg, occMs);
    await makeBriefing(db, id, { kind: "daily", occurrenceMs: occMs, tz: cfg.tz, lang, maxStories: cfg.max_stories, attachments },
      { now: deps.now, refresh: deps.refresh === undefined ? refreshSources : deps.refresh, speech: deps.speech, audio: deps.audio });
  } catch (err) {
    console.error(`[media] daily briefing ${id}: attempt failed (${String(err.message || err).slice(0, 160)})`);   // on the row; the next tick retries once, then fails it
  }
}

async function runOccurrence(db, occMs, cfg, now, deps, out) {
  const at = iso(occMs);
  const lang = await instanceLang(db);
  const existing = (await db.execute({ sql: "SELECT id, status, attempts, error, created_at, owner FROM media_briefings WHERE scheduled_for = ?", args: [at] })).rows[0];
  if (!existing) {
    const id = await createBriefing(db, { kind: "daily", scheduledFor: at, lang, createdMs: now });
    if (id === null) return;                       // another runner claimed it between the read and the insert
    out.claimed = id;
    console.error(`[media] daily briefing ${id} claimed for ${at}`);
    return generate(db, id, occMs, cfg, lang, deps);
  }
  if (existing.status !== "generating") return;
  const attempts = Number(existing.attempts) || 1;
  // Its maker is gone (a restart between the claim and the finish): retry now, not in 20 minutes.
  const orphaned = existing.owner !== OWNER && !(deps.ownerAlive || ownerAlive)(existing.owner);
  const stuck = orphaned || now - sqliteUtcMs(existing.created_at) > STUCK_MS * attempts;
  if (!existing.error && !stuck) return;           // someone is working on it
  if (attempts < 2) {
    const r = await db.execute({ sql: "UPDATE media_briefings SET attempts = 2, error = NULL, owner = ? WHERE id = ? AND status = 'generating' AND attempts = ?", args: [OWNER, existing.id, existing.attempts] });
    if (Number(r.rowsAffected) !== 1) return;
    out.retried = Number(existing.id);
    console.error(`[media] daily briefing ${existing.id}: retrying once`);
    return generate(db, Number(existing.id), occMs, cfg, lang, deps);
  }
  if (await failBriefing(db, existing.id, existing.error || "stuck")) out.failed = Number(existing.id);
}

/** Tell the operator, once, at the occurrence (or as soon as the briefing is finished, if that is later). */
async function announce(db, cfg, now, deps, out) {
  const send = deps.notify || notify;
  const { rows } = await db.execute({
    sql: `SELECT id, status, scheduled_for, audio_path, duration_sec, items_json, error, lang FROM media_briefings
          WHERE kind = 'daily' AND announced_at IS NULL AND status IN ('ready', 'failed') AND scheduled_for IS NOT NULL
            AND julianday(scheduled_for) <= julianday(?) AND julianday(scheduled_for) > julianday(?)`,
    args: [iso(now), iso(now - 24 * HOUR)],
  });
  for (const b of rows) {
    const won = await db.execute({ sql: "UPDATE media_briefings SET announced_at = ? WHERE id = ? AND announced_at IS NULL", args: [iso(now), b.id] });
    if (Number(won.rowsAffected) !== 1) continue;
    out.announced.push(Number(b.id));
    if (!cfg.notify) continue;
    const lang = b.lang || "en";
    if (b.status === "failed") {
      await send(db, { title: tr("n_failed_title", lang), body: reasonText(b.error, lang), action_url: "/dashboard/media?tab=briefings", source: "media:briefing" });
    } else if (b.audio_path) {
      let n = 0;
      try { n = JSON.parse(b.items_json).length; } catch {}
      const daypart = spokenWhen(Date.parse(b.scheduled_for), cfg.tz, lang).daypart;
      await send(db, { title: tr(`n_ready_${daypart}`, lang), body: tr("n_ready_body", lang, { n, min: Math.max(1, Math.round((Number(b.duration_sec) || 0) / 60)) }), action_url: `/dashboard/media?play=briefing:${b.id}`, source: "media:briefing" });
    } else {
      await send(db, { title: tr("n_text_title", lang), body: tr("n_text_body", lang, { reason: reasonText(b.error, lang) }), action_url: `/dashboard/media?open=briefing:${b.id}`, source: "media:briefing" });
    }
  }
}

/**
 * One pass, run every minute. Never throws.
 * deps: { now?, refresh? (null = no refresh), notify?, speech?, audio? }
 * → { state, claimed, retried, failed, announced: [ids], watched, error }
 */
export async function runScheduleTick(db, deps = {}) {
  const now = (deps.now || Date.now)();
  const out = { state: "unset", claimed: null, retried: null, failed: null, announced: [], watched: null, error: null };
  let cfg = normalizeConfig(null);
  try {
    const s = await readSchedule(db);
    cfg = s.cfg;
    out.state = !s.row ? "unset" : Number(s.row.enabled) === 1 ? "on" : "off";
    if (out.state === "on") {
      const from = Math.max(now - cfg.catch_up_hours * HOUR, Date.parse(cfg.active_from || "") || 0);
      const due = occurrences(s.row.cron_expression, cfg.tz, from, now + cfg.lead_min * MIN);
      if (due.length) await runOccurrence(db, due.at(-1), cfg, now, deps, out);
    }
  } catch (err) {
    out.error = err.code || String(err.message || err).slice(0, 160);
    if (err.code === "bad_cron") out.state = "bad_cron";
    else console.error(`[media] schedule check failed: ${out.error}`);
  }
  try {
    await closeStuckBriefings(db, { now, olderThanMs: STUCK_MS });
    await announce(db, cfg, now, deps, out);
  } catch (err) { console.error(`[media] announce failed: ${err.message}`); }
  try { out.watched = await watchAttachments(db, { now: () => now, notify: deps.notify, notifyEnabled: cfg.notify }); } catch (err) { console.error(`[media] show check failed: ${err.message}`); }
  await writeLocalSetting(db, JOB_STATE_KEY, JSON.stringify({ tick_at: iso(now), state: out.state, error: out.error })).catch(() => {});
  return out;
}

/**
 * The minute loop, outside the bundle's one-at-a-time task queue: a long feed cycle never delays the
 * claim, the announcement or the show watcher. A tick that is still running (a briefing being
 * voiced) makes the next one wait; nothing overlaps. → stop()
 */
export function startScheduleLoop(db, { intervalMs = 60_000, firstDelayMs = 5_000, tick = runScheduleTick } = {}) {
  let busy = false;
  const once = async () => {
    if (busy) return;
    busy = true;
    try { await tick(db); } catch (err) { console.error(`[media] schedule loop: ${String(err?.message || err).slice(0, 160)}`); } finally { busy = false; }
  };
  const first = setTimeout(once, firstDelayMs);
  const timer = setInterval(once, intervalMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}
