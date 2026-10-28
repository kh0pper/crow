/**
 * The project home's data (R1.2): the project's bots and its lead, its
 * Needs-you rows and count, and its earlier Perch sessions. Read-only: the
 * home GET is prefetched by Turbo on hover, so nothing here writes.
 *
 *   bots     pi_bot_defs on this project that Perch can attach (GET /bots's
 *            filter: a complete perch gateway, never the voice bot), by name.
 *   lead     no storage yet: the only bot; else the first whose default model
 *            is role:coordinator; else the first by name; null with none.
 *   needsYou the project's Needs-you lane (needsYouCards, the Board's order),
 *            each with its kind and its card link (drawerHrefs).
 *   sessions kind='perch-live' threads FILED to this project in shell_items
 *            (the filing, not the bot's home project), unarchived, stopped
 *            ones included, newest first, at most 10.
 */

import { CROW_VOICE_BOT_ID } from "../../../../shared/voice-bot.js";
import { perchAttached } from "../../../shared/perch-attached.js";
import { drawerHrefs } from "../../../board/card-link.js";
import { needsYouCounts, needsYouCards } from "../board/needs-you.js";

export const SESSION_LIMIT = 10;
const COORDINATOR = "role:coordinator";
const ABSENT_RE = /no such (table|column)/i;

function parseDef(raw) {
  try {
    const d = JSON.parse(raw || "{}");
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

/** [{ id, name, coordinator }] for the project's Perch-attachable bots, by display name. */
export async function projectBots(db, projectId) {
  let rows = [];
  try {
    rows = (await db.execute({
      sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE project_id = ? AND bot_id != ?",
      args: [Number(projectId), CROW_VOICE_BOT_ID],
    })).rows || [];
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
  }
  return rows
    .map((r) => ({ r, def: parseDef(r.definition) }))
    .filter(({ def }) => perchAttached(def))
    .map(({ r, def }) => ({
      id: String(r.bot_id),
      name: String(r.display_name || r.bot_id),
      coordinator: !!(def.models && def.models.default === COORDINATOR),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** The lead rule over projectBots' list (already in name order). */
export function leadOf(bots) {
  if (!bots || !bots.length) return null;
  if (bots.length === 1) return bots[0];
  return bots.find((b) => b.coordinator) || bots[0];
}

/** The project's filed perch-live threads, newest first: [{ threadId, label, botName, lastAt }]. */
export async function earlierSessions(db, projectId, { limit = SESSION_LIMIT } = {}) {
  const query = (archived) => `
    SELECT b.gateway_thread_id AS thread_id, b.label, d.display_name, b.bot_id,
           MAX(COALESCE(b.updated_at, b.created_at)) AS last_at
      FROM bot_sessions b
      JOIN shell_items s ON s.item_kind = 'perch_thread' AND s.item_ref = b.gateway_thread_id
      LEFT JOIN pi_bot_defs d ON d.bot_id = b.bot_id
     WHERE b.kind = 'perch-live' AND s.project_id = ?
       AND b.gateway_thread_id IS NOT NULL AND b.gateway_thread_id != ''
       ${archived ? "AND b.archived_at IS NULL" : ""}
     GROUP BY b.gateway_thread_id
     ORDER BY last_at DESC, b.gateway_thread_id
     LIMIT ?`;
  const args = [Number(projectId), Number(limit)];
  let rows;
  try {
    rows = (await db.execute({ sql: query(true), args })).rows || [];
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
    // A store without bot_sessions.archived_at (pre-0006) has nothing archived;
    // without bot_sessions or shell_items there are no sessions.
    try { rows = (await db.execute({ sql: query(false), args })).rows || []; }
    catch (err2) { if (!ABSENT_RE.test(String(err2 && err2.message))) throw err2; rows = []; }
  }
  return rows.map((r) => ({
    threadId: String(r.thread_id),
    label: r.label != null && String(r.label).trim() !== "" ? String(r.label) : null,
    botName: String(r.display_name || r.bot_id || ""),
    lastAt: r.last_at == null ? null : String(r.last_at),
  }));
}

/**
 * Everything the home draws.
 * @param project { id, slug, name, tasks_db_uri }
 */
export async function loadProjectHome(db, project, { engine = null, tasksDbPath } = {}) {
  const id = Number(project.id);
  const bots = await projectBots(db, id);
  const lead = leadOf(bots);

  const opts = tasksDbPath ? { tasksDbPath } : {};
  const counts = await needsYouCounts(db, [project], { engine, ...opts });
  const needsYouCount = counts.has(id) ? counts.get(id) : null;
  const cards = await needsYouCards(db, project, { ...opts, limit: 3 });
  let hrefs = new Map();
  try { hrefs = await drawerHrefs(db, cards); } catch (err) { console.warn("[project-home] card links failed:", err && err.message); }
  const needsYou = cards.map((c) => ({
    id: Number(c.id),
    title: String(c.title || ""),
    kind: c.kind,
    href: hrefs.get(Number(c.id)) || `/dashboard/bot-board?card=${Number(c.id)}`,
  }));

  const sessions = await earlierSessions(db, id);
  return { lead, bots, needsYou, needsYouCount, sessions };
}

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or an ISO string → Date, or null. */
function parseWhen(s) {
  if (!s) return null;
  const v = String(s);
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? v.replace(" ", "T") + "Z" : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A relative day in this gateway's local time: "today", "yesterday", a
 * weekday within the last week, else a short date (with the year when it
 * isn't this year). Returns { key } for today/yesterday, else { text }.
 */
export function relativeDay(when, { now = new Date(), lang = "en" } = {}) {
  const d = parseWhen(when);
  if (!d) return null;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return { key: "shell.today" };
  if (diff === 1) return { key: "shell.yesterday" };
  const loc = lang === "es" ? "es" : "en";
  if (diff < 7) return { text: d.toLocaleDateString(loc, { weekday: "long" }) };
  const o = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return { text: d.toLocaleDateString(loc, o) };
}
