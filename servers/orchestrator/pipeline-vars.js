/**
 * Shared placeholder substitution for pipeline goal strings.
 *
 * Local LLMs (qwen3.6-35b-a3b and similar) will happily ignore an explicit
 * "substitute ${X} with …" instruction in the goal and leave the literal
 * placeholder in tool arguments, or worse, hallucinate a value from
 * training-data defaults (e.g. today's date becoming "2025-06-18"). Doing
 * the substitution server-side before dispatch guarantees every tool call
 * carries the right value.
 *
 * Both the in-process pipeline runner (pipeline-runner.js) and the
 * standalone subprocess dispatcher (scripts/run-pipeline-subprocess.mjs)
 * must pass their goal strings through this helper, otherwise the two
 * execution paths drift.
 *
 * Supported placeholders:
 *   ${TODAY}       today's date in America/Chicago as YYYY-MM-DD
 *   ${INSTANCE_ID} this gateway's local instance UUID
 *
 * LLM-scoped capture variables like ${EVENTS}, ${THREADS}, ${BRIEFING_ID}
 * are deliberately NOT substituted — those are transcript-scoped
 * references the LLM tracks across tool calls within one orchestration.
 */

import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";
import { createDbClient } from "../db.js";

/**
 * Aggregate pipeline_runs into a compact markdown table for the reliability
 * tracker pipeline. Returns "(no pipeline_runs yet)" before the runner has
 * written any rows. Shape is stable across ticks so the memory-reviewer
 * update path is a no-op for unchanged pipelines.
 */
async function buildReliabilitySummary() {
  try {
    const db = createDbClient();
    const { rows } = await db.execute(`
      SELECT pipeline_name, status, ended_at
      FROM pipeline_runs
      WHERE ended_at >= datetime('now', '-30 days')
      ORDER BY ended_at DESC
    `);
    if (rows.length === 0) return "(no pipeline_runs yet — runner has not logged a complete tick)";

    const byPipeline = new Map();
    for (const r of rows) {
      if (!byPipeline.has(r.pipeline_name)) byPipeline.set(r.pipeline_name, []);
      byPipeline.get(r.pipeline_name).push(r);
    }

    const lines = ["| Pipeline | Last 20 (newest→oldest) | Consecutive clean | Total runs | Last failure |",
                   "|---|---|---|---|---|"];
    const promotions = [];
    for (const [name, runs] of [...byPipeline.entries()].sort()) {
      const recent = runs.slice(0, 20);
      const symbols = recent.map((r) => (r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "?"))
        .join("");
      let consec = 0;
      for (const r of recent) {
        if (r.status === "completed") consec++;
        else break;
      }
      const lastFailure = runs.find((r) => r.status === "failed");
      const lastFailureStr = lastFailure ? lastFailure.ended_at : "—";
      lines.push(`| ${name} | ${symbols} | ${consec} | ${runs.length} | ${lastFailureStr} |`);
      if (consec >= 10) promotions.push(name);
    }
    if (promotions.length > 0) {
      lines.push("");
      lines.push(`**Promotion candidates (≥10 consecutive clean):** ${promotions.join(", ")}`);
    }
    return lines.join("\n");
  } catch (err) {
    return `(pipeline_runs summary failed: ${err.message})`;
  }
}

/** Substitute only the sync placeholders (${TODAY}, ${INSTANCE_ID}). */
export function substituteGoalPlaceholders(goal) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const instanceId = getOrCreateLocalInstanceId();

  return goal
    .replaceAll("${TODAY}", today)
    .replaceAll("${INSTANCE_ID}", instanceId);
}

/**
 * Async variant that additionally materializes ${RELIABILITY_SUMMARY} by
 * querying pipeline_runs. Called by pipeline-runner.js if a goal references
 * the placeholder. Kept separate so the fast sync path is unchanged for
 * pipelines that don't need DB access.
 */
export async function substituteGoalPlaceholdersAsync(goal) {
  let out = substituteGoalPlaceholders(goal);
  if (out.includes("${RELIABILITY_SUMMARY}")) {
    const summary = await buildReliabilitySummary();
    out = out.replaceAll("${RELIABILITY_SUMMARY}", summary);
  }
  return out;
}
