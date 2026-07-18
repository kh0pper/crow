/**
 * migration-expectations.js — the expected-changes manifest for the runtime
 * migration guard (servers/shared/migration-guard.js).
 *
 * Every destructive statement in scripts/init-db.js must be declared here, and
 * every declaration must still exist in init-db — both directions are enforced
 * by the static rot-guard test (tests/migration-guard.test.js). A destructive
 * migration cannot merge without declaring itself.
 *
 * Spec: crow-engineering specs/2026-07-18-a3-migration-guard-design.md §3.2.
 */

// Tables init-db may legitimately make DISAPPEAR (guarded drops, no rebuild).
export const EXPECTED_DROPS = [
  "research_projects",
  "orchestrator_events",
  "orchestrator_role_overrides",
];

// Prunes init-db itself performs. Each is BOUNDED: the guard evaluates the
// predicate against snapshot A and excuses at most that many lost rows — a
// buggy variant that deletes more than its own predicate matches still trips.
export const EXPECTED_PRUNES = [
  {
    table: "schedules",
    predicate: "task LIKE 'pipeline:%' AND task NOT LIKE 'pipeline:botcron:%'",
  },
  {
    table: "project_spaces",
    predicate: "type = 'learner_profile' AND archived_at IS NOT NULL",
  },
];

// Row MOVES: a decrease in `from` is excused up to the observed increase in
// `to` (the dashboard_settings PK-restore migration relocates instance-scoped
// rows into dashboard_settings_overrides).
export const EXPECTED_MOVES = [
  { from: "dashboard_settings", to: "dashboard_settings_overrides" },
];

// High-churn queue/cache tables where routine runtime activity (retention
// prunes, queue drains, fetch-and-delete stores, session sweeps) legitimately
// drains rows — including to zero — while a guarded run is in flight. Their
// losses alert (SUSPECT) but never fail closed.
export const VOLATILE_TABLES = [
  "cross_host_calls",
  "notifications",
  "message_retry_queue",
  "bot_message_seen",
  "relay_blobs",
  "mcp_sessions",
  "crowdsec_decisions_cache",
];

// Rebuild sources (DROP TABLE + recreate + copy) with per-table loss policy:
//   "strict"         → any unexcused loss on a FIRED rebuild = high-confidence loss
//   "dedup-tolerant" → the rebuild dedups by design (INSERT OR IGNORE); loss on
//                      a fired rebuild classifies SUSPECT, not loss
// dashboard_settings is strict but its loss is excusable via its EXPECTED_MOVE.
export const REBUILD_TABLES = {
  // generic TABLE_SPECS rebuilds (rebuildMainFKsToProjectSpaces):
  research_sources: "strict",
  research_notes: "strict",
  data_backends: "strict",
  // standalone state-conditional rebuilds:
  shared_items: "strict",
  crow_context: "dedup-tolerant",
  dashboard_settings: "strict",
};

// sqlite_master objects init-db removes WITHOUT recreating (legacy trigger and
// index cleanup). Glob patterns on the object name. Objects belonging to an
// excused table drop/rebuild are excused automatically by the guard.
export const EXPECTED_OBJECT_REMOVALS = [
  "tr_rp_to_ps_*", // legacy research_projects mirror triggers
  "idx_dashboard_settings_*", // dropped by the dashboard_settings PK restore
  "idx_crow_context_*", // dropped/replaced by the scope-index migration
];

// Classification thresholds (env-overridable for emergencies only).
export const LOSS_FLOOR = Number(process.env.CROW_MIGRATION_LOSS_FLOOR || 10);
export const LOSS_FRACTION = Number(process.env.CROW_MIGRATION_LOSS_FRACTION || 0.5);
