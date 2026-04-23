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
