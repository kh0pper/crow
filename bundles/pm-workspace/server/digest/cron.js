/**
 * PM Workspace — in-process schedulers.
 *
 * Only started when PM_RUN_CRON=1 (enable it on exactly one server
 * registration per host, or two gateways sharing a DB will double-send).
 *
 * A single 60s setInterval drives both jobs:
 *   - Digest: fires once the most recent $DIGEST_CRON occurrence for
 *     TODAY has passed and pm_digests has no row for today. Because the
 *     gate is "row exists", a server started after 07:00 still sends
 *     today's digest on its first tick (startup catch-up), and restarts
 *     never double-send.
 *   - Sync: fires when the most recent $SYNC_CRON occurrence is newer
 *     than the last run (in-memory, seeded from pm_sync_log on start).
 */

import parser from "cron-parser";
import { runDigest, localDate } from "./index.js";
import { runSync } from "../sync/monday.js";

const TICK_MS = 60_000;

/** Most recent occurrence of a cron expression at/before `now`, or null on a bad expression. */
function prevOccurrence(expr, now = new Date()) {
  try {
    return parser.parseExpression(expr, { currentDate: now }).prev().toDate();
  } catch (err) {
    console.warn(`[pm-workspace cron] bad cron expression "${expr}": ${err.message}`);
    return null;
  }
}

export function startCrons(db, loadConfig) {
  const state = {
    lastSyncRun: null, // Date
    digestRunning: false,
    syncRunning: false,
    timer: null,
  };

  // Seed lastSyncRun from pm_sync_log so a restart doesn't immediately re-fire.
  db.execute({
    sql: "SELECT MAX(run_at) AS last FROM pm_sync_log WHERE action = 'run_start'",
    args: [],
  })
    .then(({ rows }) => {
      if (rows[0]?.last) state.lastSyncRun = new Date(rows[0].last.replace(" ", "T") + "Z");
    })
    .catch(() => {});

  async function tick() {
    const config = loadConfig();
    const now = new Date();

    // ── Digest ──
    if (!state.digestRunning) {
      const prev = prevOccurrence(config.DIGEST_CRON, now);
      if (prev && localDate(prev) === localDate(now)) {
        state.digestRunning = true;
        try {
          const { rows } = await db.execute({
            sql: "SELECT id FROM pm_digests WHERE digest_date = ?",
            args: [localDate(now)],
          });
          if (rows.length === 0) {
            console.log("[pm-workspace cron] running daily digest");
            const result = await runDigest(db, config);
            console.log(`[pm-workspace cron] digest: ${JSON.stringify(result)}`);
          }
        } catch (err) {
          console.error(`[pm-workspace cron] digest failed: ${err.message}`);
        } finally {
          state.digestRunning = false;
        }
      }
    }

    // ── Sync ──
    if (!state.syncRunning) {
      const prev = prevOccurrence(config.SYNC_CRON, now);
      if (prev && (!state.lastSyncRun || prev > state.lastSyncRun)) {
        state.syncRunning = true;
        state.lastSyncRun = now;
        try {
          const result = await runSync(db, config);
          if (!result.skipped) {
            console.log(`[pm-workspace cron] sync: ${JSON.stringify(result.totals || result)}`);
          }
        } catch (err) {
          console.error(`[pm-workspace cron] sync failed: ${err.message}`);
        } finally {
          state.syncRunning = false;
        }
      }
    }
  }

  state.timer = setInterval(() => {
    tick().catch((err) => console.error(`[pm-workspace cron] tick error: ${err.message}`));
  }, TICK_MS);
  if (typeof state.timer.unref === "function") state.timer.unref();

  // First tick shortly after boot for startup catch-up.
  setTimeout(() => {
    tick().catch((err) => console.error(`[pm-workspace cron] first tick error: ${err.message}`));
  }, 5_000).unref?.();

  console.log("[pm-workspace] crons started (PM_RUN_CRON=1)");
  return state;
}
