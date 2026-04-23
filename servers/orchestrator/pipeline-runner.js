/**
 * Pipeline Runner — Timer-based executor for scheduled orchestration pipelines.
 *
 * Polls the schedules table every 60s for entries with a "pipeline:" prefix.
 * When a schedule is due, it runs the corresponding pipeline via the orchestrator
 * and optionally stores the result as a Crow memory.
 *
 * Design: The existing scheduler (servers/gateway/scheduler.js) is a cron-to-notification
 * system with no execution callback. Rather than adding execution dispatch there
 * (which would create a circular dependency), this runner handles orchestrator-type
 * schedules independently. The scheduler still updates last_run/next_run for all
 * schedules; this runner only triggers execution for pipeline: entries.
 */

import { CronExpressionParser } from "cron-parser";
import { pipelines } from "./pipelines.js";
import { substituteGoalPlaceholders } from "./pipeline-vars.js";

const POLL_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const PIPELINE_PREFIX = "pipeline:";

let timer = null;
let db = null;
let runOrchestrationFn = null;
let storeResultFn = null;

/** @type {Set<number>} Schedule IDs currently running (prevent overlap) */
const running = new Set();

/**
 * Compute the next occurrence from a cron expression.
 */
function computeNextRun(cronExpression, fromDate = new Date()) {
  try {
    const interval = CronExpressionParser.parse(cronExpression, { currentDate: fromDate });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

/**
 * Check for due pipeline schedules and execute them.
 */
async function tick() {
  if (!db || !runOrchestrationFn) return;

  try {
    const now = new Date().toISOString();

    // Find enabled pipeline schedules that are due
    const { rows } = await db.execute({
      sql: `SELECT id, task, cron_expression, description, next_run
            FROM schedules
            WHERE enabled = 1
              AND task LIKE ?
              AND next_run IS NOT NULL
              AND next_run <= ?`,
      args: [`${PIPELINE_PREFIX}%`, now],
    });

    for (const schedule of rows) {
      // Skip if already running (prevents overlap on long-running pipelines)
      if (running.has(schedule.id)) {
        console.log(`[pipeline-runner] Skipping #${schedule.id} — still running`);
        continue;
      }

      const pipelineName = schedule.task.slice(PIPELINE_PREFIX.length).trim();
      const pipeline = pipelines[pipelineName];

      if (!pipeline) {
        console.warn(`[pipeline-runner] Unknown pipeline: "${pipelineName}" (schedule #${schedule.id})`);
        // Still update next_run so we don't retry every tick
        const nextRun = computeNextRun(schedule.cron_expression);
        await db.execute({
          sql: "UPDATE schedules SET last_run = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?",
          args: [now, nextRun, schedule.id],
        });
        continue;
      }

      // Mark as running and update schedule timestamps
      running.add(schedule.id);
      const nextRun = computeNextRun(schedule.cron_expression);
      await db.execute({
        sql: "UPDATE schedules SET last_run = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?",
        args: [now, nextRun, schedule.id],
      });

      console.log(`[pipeline-runner] Starting pipeline "${pipelineName}" (schedule #${schedule.id})`);

      // Run in background — don't block the poll loop
      executePipeline(schedule.id, pipelineName, pipeline).catch((err) => {
        console.error(`[pipeline-runner] Pipeline "${pipelineName}" error:`, err.message);
      }).finally(() => {
        running.delete(schedule.id);
      });
    }
  } catch (err) {
    console.error("[pipeline-runner] Poll error:", err.message);
  }
}

/**
 * Execute a single pipeline: run orchestration and optionally store results.
 */
async function executePipeline(scheduleId, pipelineName, pipeline) {
  const goal = substituteGoalPlaceholders(pipeline.goal);
  const result = await runOrchestrationFn(goal, pipeline.preset);

  if (result.status === "completed" && result.result && pipeline.storeResult && storeResultFn) {
    try {
      const title = `[${pipeline.name}] ${new Date().toISOString().slice(0, 10)}`;
      await storeResultFn(title, result.result, pipeline.resultCategory);
      console.log(`[pipeline-runner] Stored result for "${pipelineName}" as memory`);
    } catch (err) {
      console.error(`[pipeline-runner] Failed to store result for "${pipelineName}":`, err.message);
    }
  }

  if (result.status === "failed") {
    console.error(`[pipeline-runner] Pipeline "${pipelineName}" failed: ${result.error}`);
  }

  console.log(
    `[pipeline-runner] Pipeline "${pipelineName}" finished — ` +
    `status=${result.status}, schedule=#${scheduleId}`
  );
}

/**
 * Start the pipeline runner.
 *
 * @param {object} database - libsql database client
 * @param {object} options
 * @param {Function} options.runOrchestration - (goal, presetName) => Promise<{ status, result?, error? }>
 * @param {Function} [options.storeResult] - (title, content, category) => Promise<void>
 */
export function startPipelineRunner(database, options = {}) {
  db = database;
  runOrchestrationFn = options.runOrchestration;
  storeResultFn = options.storeResult || null;

  if (!runOrchestrationFn) {
    console.error("[pipeline-runner] No runOrchestration function provided, not starting");
    return;
  }

  // Start the poll loop
  timer = setInterval(() => tick(), POLL_INTERVAL_MS);
  timer.unref(); // Don't prevent process exit

  console.log("[pipeline-runner] Running — checking every 60s for pipeline: schedules");
}

/**
 * Stop the pipeline runner.
 */
export function stopPipelineRunner() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Run a named pipeline immediately (not on schedule).
 * Returns the orchestration result.
 *
 * @param {string} pipelineName - Key from pipelines.js
 * @returns {{ status: string, result?: string, error?: string }}
 */
export async function runPipelineNow(pipelineName) {
  const pipeline = pipelines[pipelineName];
  if (!pipeline) {
    return { status: "failed", error: `Unknown pipeline: "${pipelineName}". Available: ${Object.keys(pipelines).join(", ")}` };
  }

  if (!runOrchestrationFn) {
    return { status: "failed", error: "Pipeline runner not initialized — no orchestration function available" };
  }

  console.log(`[pipeline-runner] Running pipeline "${pipelineName}" (manual trigger)`);

  const goal = substituteGoalPlaceholders(pipeline.goal);
  const result = await runOrchestrationFn(goal, pipeline.preset);

  if (result.status === "completed" && result.result && pipeline.storeResult && storeResultFn) {
    try {
      const title = `[${pipeline.name}] ${new Date().toISOString().slice(0, 10)}`;
      await storeResultFn(title, result.result, pipeline.resultCategory);
      console.log(`[pipeline-runner] Stored result for "${pipelineName}" as memory`);
    } catch (err) {
      console.error(`[pipeline-runner] Failed to store result for "${pipelineName}":`, err.message);
    }
  }

  return result;
}
