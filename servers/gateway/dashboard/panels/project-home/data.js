/**
 * The project home's data (R1.2): the project's bots and its lead, its
 * Needs-you rows and count, and its earlier Perch sessions. Read-only: the
 * home GET is prefetched by Turbo on hover, so nothing here writes.
 *
 *   bots     pi_bot_defs on this project that Perch can attach (GET /bots's
 *            filter: a complete perch gateway, never the voice bot), by name.
 *   lead     no storage yet: the only bot; else the first whose default model
 *            is role:coordinator; else the first by name; null with none.
 *   needsYou the project's Needs-you lane (needsYouItems, the Board's order),
 *            each with its kind and the Board's own link (cardHref: its
 *            conversation, else its drawer), then the project's waiting
 *            sessions that hold no such card; at most 3 rows in all.
 *            needsYouCount is the shell's count when the caller has it.
 *   sessions kind='perch-live' threads FILED to this project in shell_items
 *            (the filing, not the bot's home project), unarchived and not
 *            stopped (Perch can open only those), newest first, at most 10.
 *   allBots  EVERY non-voice bot on this project, by name (the Bots section;
 *            `bots` above stays the Perch-attachable list Start uses).
 *   canManage / movable / confirm  the Bots section's change controls (canManageProject; the other
 *            non-voice, non-custom-tracker bots, loaded only when canManage; the one ?move names, if movable).
 *   movedName the ?moved bot's name, only when it is on this project and canManage.
 *   conflictPath  for ?error=conflict&bot=<id>: <workspace_dir>/bots/<id>, only
 *            for a bot that exists (never a path taken from the URL).
 *   briefing "Where you left off" (R1.2 PR 4): perch/briefing.js's fragments,
 *            each fact with the Board's own card link; null when
 *            CROW_SESSION_BRIEFING=0 (read per request).
 */

import { CROW_VOICE_BOT_ID } from "../../../../shared/voice-bot.js";
import { perchAttached } from "../../../shared/perch-attached.js";
import { drawerHrefs } from "../../../board/card-link.js";
import { needsYouCounts, needsYouItems } from "../board/needs-you.js";
import { threadsByCard } from "../board.js";
import { cardHref } from "../board/html.js";
import { buildBriefing, briefingEnabled } from "../../../perch/briefing.js";
import { t } from "../../shared/i18n.js";

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
  return botRows(db, "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE project_id = ? AND bot_id != ?", [Number(projectId), CROW_VOICE_BOT_ID]);
}

async function botRows(db, sql, args) {
  let rows = [];
  try {
    rows = (await db.execute({ sql, args })).rows || [];
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
  }
  return rows
    .map((r) => ({ r, def: parseDef(r.definition) }))
    .filter(({ r, def }) => r.bot_id != null && perchAttached(def))
    .map(({ r, def }) => ({
      id: String(r.bot_id),
      name: String(r.display_name || r.bot_id),
      coordinator: !!(def.models && def.models.default === COORDINATOR),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** [{ id, name, coordinator }] for every Perch-attachable bot (GET /bots's
 *  filter: a complete perch gateway, never the voice bot), by display name.
 *  The Chat tab's start control outside a project (Everything, Unassigned). */
export async function attachableBots(db) {
  return botRows(db, "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE bot_id != ?", [CROW_VOICE_BOT_ID]);
}

/** [{ id, name }] for EVERY non-voice bot on the project (Perch or not), by display name. */
export async function allProjectBots(db, projectId) {
  let rows = [];
  try {
    rows = (await db.execute({
      sql: "SELECT bot_id, display_name FROM pi_bot_defs WHERE project_id = ? AND bot_id != ?",
      args: [Number(projectId), CROW_VOICE_BOT_ID],
    })).rows || [];
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
  }
  return rows
    .map((r) => ({ id: String(r.bot_id), name: String(r.display_name || r.bot_id) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/**
 * The other bots Move can take here: every non-voice bot not already on this
 * project, by name: [{ id, name, fromName }]. fromName is the project it is in
 * now (its name), or "No project" in `lang`. A bot with a custom tracker is
 * left out (moveBotToProject refuses it, as "Turn on a board" does). Read-only.
 */
export async function movableBots(db, projectId, lang = "en") {
  let rows = [];
  try {
    rows = (await db.execute({
      sql: `SELECT d.bot_id, d.display_name, d.definition, p.name AS project_name, p.slug AS project_slug
              FROM pi_bot_defs d LEFT JOIN project_spaces p ON p.id = d.project_id
             WHERE d.bot_id != ? AND (d.project_id IS NULL OR d.project_id != ?)`,
      args: [CROW_VOICE_BOT_ID, Number(projectId)],
    })).rows || [];
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
  }
  return rows
    .filter((r) => (parseDef(r.definition).tracker_config || {}).type !== "custom")
    .map((r) => ({
      id: String(r.bot_id),
      name: String(r.display_name || r.bot_id),
      fromName: r.project_name || r.project_slug ? String(r.project_name || r.project_slug) : t("projectHome.noProject", lang),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** { name, projectId } of one bot, or null. */
async function botInfo(db, botId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT display_name, project_id FROM pi_bot_defs WHERE bot_id = ?", args: [String(botId)] });
    return rows[0] ? { name: String(rows[0].display_name || botId), projectId: rows[0].project_id == null ? null : Number(rows[0].project_id) } : null;
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
    return null;
  }
}

/** The lead rule over projectBots' list (already in name order). */
export function leadOf(bots) {
  if (!bots || !bots.length) return null;
  if (bots.length === 1) return bots[0];
  return bots.find((b) => b.coordinator) || bots[0];
}

/** The start control's data: the lead (a wanted bot when it is offered, else
 *  leadOf) and the bots with the lead first. */
export function startData(bots, wantId = null) {
  const list = Array.isArray(bots) ? bots : [];
  const lead = (wantId && list.find((b) => b.id === String(wantId))) || leadOf(list);
  return { lead, bots: lead ? [lead, ...list.filter((b) => b !== lead)] : list };
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
       AND b.status != 'stopped'
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

/** Map<threadId, label> for the given perch-live threads (the newest row's label; none when unset). */
async function sessionLabels(db, sids) {
  const out = new Map();
  if (!sids.length) return out;
  try {
    const { rows } = await db.execute({
      sql: `SELECT gateway_thread_id, label FROM bot_sessions WHERE kind = 'perch-live'
              AND gateway_thread_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      args: [JSON.stringify(sids)],
    });
    for (const r of rows) {
      const l = r.label != null && String(r.label).trim() !== "" ? String(r.label) : null;
      if (l) out.set(String(r.gateway_thread_id), l);
    }
  } catch (err) {
    if (!ABSENT_RE.test(String(err && err.message))) throw err;
  }
  return out;
}

/**
 * Everything the home draws.
 * @param project { id, slug, name, tasks_db_uri }
 */
export async function loadProjectHome(db, project, { engine = null, tasksDbPath, counts = null, canManage = false, moveId = null, movedId = null, conflictBotId = null, lang = "en" } = {}) {
  const id = Number(project.id);
  const bots = await projectBots(db, id);
  const allBots = await allProjectBots(db, id);
  const lead = leadOf(bots);

  const opts = tasksDbPath ? { tasksDbPath } : {};
  let needsYouCount;
  if (counts instanceof Map && counts.has(id)) needsYouCount = counts.get(id);
  else {
    const m = await needsYouCounts(db, [project], { engine, ...opts });
    needsYouCount = m.has(id) ? m.get(id) : null;
  }
  const items = await needsYouItems(db, project, { engine, ...opts, limit: 3 });
  const links = await cardLinks(db, project, items.cards);
  const needsYou = items.cards.map((c) => ({ title: String(c.title || ""), kind: c.kind, ...links(c) }));
  const labels = await sessionLabels(db, items.waiting.map((w) => w.sid));
  for (const w of items.waiting) {
    needsYou.push({ title: labels.get(w.sid) || null, kind: null, waiting: true, href: `/dashboard/perch?project=${encodeURIComponent(project.slug)}#${encodeURIComponent(w.sid)}` });
  }

  const sessions = await earlierSessions(db, id);

  let briefing = null;
  if (briefingEnabled()) {
    try {
      briefing = await buildBriefing(db, project, opts);
      const factLinks = await cardLinks(db, project, briefing.facts.map((f) => ({ id: f.cardId, project_id: id })));
      briefing.facts = briefing.facts.map((f) => ({ ...f, ...factLinks({ id: f.cardId }) }));
    } catch (err) {
      console.warn("[project-home] briefing failed:", err && err.message);
      briefing = { project: null, summaries: [], facts: [], memories: [], empty: true };
    }
  }
  // Bots section (§14): the move picker and confirm load only for a viewer who may change the project.
  const movable = canManage ? await movableBots(db, id, lang) : [];
  const confirm = canManage && moveId ? movable.find((b) => b.id === String(moveId)) || null : null;
  // The success line only for a bot that is really here now, for a viewer who may change the project.
  let movedName = null;
  if (canManage && movedId) {
    const b = await botInfo(db, movedId);
    if (b && b.projectId === id) movedName = b.name;
  }
  // The conflict path is rebuilt here from the project's own workspace, never read from the URL.
  let conflictPath = null;
  if (conflictBotId && project.workspace_dir && await botInfo(db, conflictBotId)) {
    conflictPath = `${project.workspace_dir}/bots/${String(conflictBotId)}`;
  }
  return { lead, bots, allBots, needsYou, needsYouCount, sessions, briefing, canManage: !!canManage, movable, confirm, movedName, conflictPath };
}

/**
 * The Board's card-link rule for this page: (card) -> { href, conversation }.
 * A card that opens its conversation carries the project like a session row
 * does (Perch scopes to it) and is never prefetched (the visit writes the
 * scope cookie); otherwise its drawer (board/card-link.js).
 */
async function cardLinks(db, project, cards) {
  let threads = new Map();
  let hrefs = new Map();
  try {
    threads = await threadsByCard(db, cards.map((c) => Number(c.id)));
    hrefs = await drawerHrefs(db, cards);
  } catch (err) { console.warn("[project-home] card links failed:", err && err.message); }
  return (c) => {
    const href = cardHref(c, threads, hrefs);
    const conversation = href.startsWith("/dashboard/perch#");
    return {
      conversation,
      href: conversation ? `/dashboard/perch?project=${encodeURIComponent(project.slug)}#${href.slice("/dashboard/perch#".length)}` : href,
    };
  };
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
