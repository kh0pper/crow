/**
 * Pipeline Definitions
 *
 * Each pipeline is a predefined multi-agent workflow that can be run
 * immediately or on a schedule. Pipelines map to orchestrator presets
 * with a specific goal template.
 *
 * Fields:
 *   - name: Human-readable name
 *   - description: What this pipeline does
 *   - goal: The goal string passed to the orchestrator
 *   - preset: Which team preset to use (from presets.js)
 *   - defaultCron: Suggested cron expression (used by crow_schedule_pipeline)
 *   - storeResult: If true, store the final output as a Crow memory
 *   - resultCategory: Memory category for stored results
 */

export const pipelines = {
  "memory-consolidation": {
    name: "Memory Consolidation",
    description: "Review recent memories for duplicates, conflicts, and consolidation opportunities",
    goal:
      "Search all memories and analyze them for: (1) duplicate or near-duplicate entries that should be merged, " +
      "(2) conflicting information that needs resolution, (3) related memories that could be consolidated into " +
      "a single richer entry. Report your findings with specific memory IDs and recommended actions.",
    preset: "memory_ops",
    defaultCron: "0 3 * * *", // Daily at 3am
    storeResult: true,
    resultCategory: "process",
  },

  "daily-summary": {
    name: "Daily Summary",
    description: "Summarize today's activity: new memories, project updates, and notable events",
    goal:
      "Search recent memories and project activity from the last 24 hours. Produce a concise daily summary covering: " +
      "(1) new memories stored today with key themes, (2) project updates or new sources added, " +
      "(3) any notable patterns or insights. Keep the summary under 500 words.",
    preset: "research",
    defaultCron: "0 22 * * *", // Daily at 10pm
    storeResult: true,
    resultCategory: "learning",
  },

  "research-digest": {
    name: "Research Digest",
    description: "Review all active projects and summarize their current state and recent progress",
    goal:
      "List all research projects and for each one: check its sources, notes, and any related memories. " +
      "Produce a digest summarizing the current state of each project, recent additions, and suggested next steps.",
    preset: "research",
    defaultCron: "0 9 * * 1", // Weekly on Monday at 9am
    storeResult: true,
    resultCategory: "project",
  },

  "mpa-daily-briefing": {
    name: "MPA: Daily Briefing",
    description:
      "Maestro Press morning nudge — computes today's briefing from the tasks bundle, stores it in tasks_briefings, and pushes a ntfy notification that deep-links to the Tasks panel.",
    goal:
      "Compose Kevin's morning briefing by making exactly three tool calls in this order. " +
      "Substitute ${TODAY} below with today's date in America/Chicago in ISO format " +
      "(YYYY-MM-DD). Do not substitute any other values — the literals shown are mandatory.\n\n" +
      "CALL 1 — tasks_briefing_snapshot with these exact arguments:\n" +
      "  today = \"${TODAY}\"\n" +
      "  window_days = 3\n" +
      "The response is a JSON payload with a `content` field (pre-rendered markdown) and a " +
      "`counts` field. Capture the `content` string verbatim as ${BRIEFING_CONTENT}.\n\n" +
      "CALL 2 — tasks_store_briefing with these exact arguments:\n" +
      "  briefing_date = \"${TODAY}\"\n" +
      "  content = ${BRIEFING_CONTENT}\n" +
      "Capture the returned `id` field as ${BRIEFING_ID}.\n\n" +
      "CALL 3 — crow_create_notification with these exact arguments:\n" +
      "  title = \"MPA daily briefing - ${TODAY}\"\n" +
      "  body = <first 200 characters of ${BRIEFING_CONTENT}>\n" +
      "  type = \"briefing\"\n" +
      "  priority = \"normal\"\n" +
      "  action_url = \"/dashboard/tasks?briefing=${BRIEFING_ID}&instance=${INSTANCE_ID}\"\n\n" +
      "After all three tool calls have succeeded, respond with a single short confirmation " +
      "line containing ${BRIEFING_ID}. Do not describe what you would do — actually call " +
      "every tool listed above.",
    preset: "briefing",
    defaultCron: "0 7 * * 1-5",
    storeResult: false,
    resultCategory: null,
  },
};
