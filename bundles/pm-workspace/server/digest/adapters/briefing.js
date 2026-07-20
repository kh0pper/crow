/**
 * Digest adapter — stored briefing (week-ahead / daily).
 *
 * Renders the tasks bundle's stored briefing for the digest date
 * (tasks_briefings, written via tasks_store_briefing) so a
 * briefing-prep ritual can lead the morning email with distilled
 * follow-ups instead of raw feeds.
 *
 * Returns null when there is simply no briefing for the date — the
 * section is omitted rather than rendered as noise. Real failures
 * (db errors) degrade to an unavailable section.
 */

import { createTasksDbClient } from "../../db.js";

export async function briefingSection(config, date) {
  const section = { title: "Briefing", available: false };
  let tdb = null;
  try {
    tdb = createTasksDbClient(config);
    if (!tdb) return null;
    const { rows } = await tdb.execute({
      sql: "SELECT content, created_at FROM tasks_briefings WHERE briefing_date = ? LIMIT 1",
      args: [date],
    });
    if (!rows.length) return null;
    section.available = true;
    section.markdown = String(rows[0].content || "");
    section.note = `stored ${rows[0].created_at}`;
  } catch (err) {
    // Missing table (older tasks bundle) is a quiet omit; anything else surfaces.
    if (/no such table/i.test(err.message)) return null;
    section.reason = `briefing unavailable: ${err.message}`;
  } finally {
    try { tdb?.close?.(); } catch { /* ignore */ }
  }
  return section;
}
