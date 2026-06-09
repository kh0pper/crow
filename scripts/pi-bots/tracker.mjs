#!/usr/bin/env node
/**
 * Crow Bot Builder — pluggable tracker context (S3).
 *
 * Replaces the bridge's inline kanbanText()/cardStatus() with a
 * tracker_config-aware dispatch. The bridge calls getTrackerContext()
 * once per turn and splices the result into the prompt template.
 *
 * tracker_config.type:
 *   "kanban"    — existing tasks_items board (default when absent)
 *   "task-list" — same data as kanban, flat checklist render
 *   "custom"    — tracker_defs + tracker_items in crow.db
 *   "none"      — no tracker context injected
 */
import Database from "better-sqlite3";
import { botsDbPath, tasksDbPath } from "./instance-paths.mjs";

const HOME = "/home/kh0pp";
const CROW_DB = botsDbPath();
const TASKS_DB = tasksDbPath();

function db(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

// ── kanban (existing tasks_items) ──────────────────────────────────

export function kanbanText(projectId, tasksDbPath) {
  if (projectId == null) return "(no project linked)";
  const path = tasksDbPath || TASKS_DB;
  const t = db(path);
  const rows = t.prepare("SELECT id,title,status FROM tasks_items WHERE project_id=? AND parent_id IS NULL ORDER BY id").all(projectId);
  t.close();
  return rows.length ? rows.map((r) => "  #" + r.id + " [" + r.status + "] " + r.title).join("\n") : "  (no cards)";
}

export function cardStatus(cardId, tasksDbPath) {
  const path = tasksDbPath || TASKS_DB;
  const t = db(path);
  const r = t.prepare("SELECT status FROM tasks_items WHERE id=?").get(cardId);
  t.close();
  return r ? r.status : null;
}

function kanbanContext(projectId, tasksDbPath) {
  return "Kanban:\n" + kanbanText(projectId, tasksDbPath);
}

// ── task-list (same data, flat checklist) ──────────────────────────

function taskListContext(projectId, tasksDbPath) {
  if (projectId == null) return "Task list: (no project linked)";
  const path = tasksDbPath || TASKS_DB;
  const t = db(path);
  const rows = t.prepare(
    "SELECT id,title,status,priority FROM tasks_items WHERE project_id=? ORDER BY priority ASC, id ASC"
  ).all(projectId);
  t.close();
  if (!rows.length) return "Task list: (empty)";
  const lines = rows.map((r) => {
    const check = r.status === "done" ? "[x]" : "[ ]";
    return "  " + check + " #" + r.id + " " + r.title + (r.status === "in_progress" ? " (in progress)" : "");
  });
  return "Task list:\n" + lines.join("\n");
}

// ── custom tracker (tracker_defs + tracker_items in crow.db) ───────

function customTrackerContext(trackerSlug, contextFields, queueFilter) {
  const c = db(CROW_DB);
  const def = c.prepare("SELECT id, display_name, columns_json, status_values FROM tracker_defs WHERE slug=?").get(trackerSlug);
  if (!def) { c.close(); return "(tracker '" + trackerSlug + "' not found)"; }

  let rows = c.prepare(
    "SELECT id, status, priority, label, data_json, action_needed, processing_lease_status FROM tracker_items WHERE tracker_id=? ORDER BY priority ASC, id ASC"
  ).all(def.id);
  c.close();

  if (queueFilter && typeof queueFilter === "object") {
    rows = rows.filter((r) => {
      for (const [k, v] of Object.entries(queueFilter)) {
        if (k === "processing_lease_status" && r.processing_lease_status !== v) return false;
        if (k === "status" && r.status !== v) return false;
      }
      return true;
    });
  }

  if (!rows.length) return def.display_name + " tracker: (no items" + (queueFilter ? " matching filter" : "") + ")";

  const fields = Array.isArray(contextFields) ? contextFields : ["label", "status", "action_needed"];

  const lines = rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.data_json || "{}"); } catch {}
    const parts = fields.map((f) => {
      if (f === "label") return r.label;
      if (f === "status") return "[" + r.status + "]";
      if (f === "action_needed") return r.action_needed ? "action: " + r.action_needed : null;
      if (f === "priority") return "P" + (r.priority || 3);
      if (f === "processing_lease_status") return r.processing_lease_status ? "lease: " + r.processing_lease_status : null;
      return data[f] != null ? f + ": " + data[f] : null;
    }).filter(Boolean);
    return "  #" + r.id + " " + parts.join(" | ");
  });

  return def.display_name + " tracker:\n" + lines.join("\n");
}

// ── public dispatch ────────────────────────────────────────────────

/**
 * Returns a text block for the bot prompt describing the current tracker state.
 * @param {object} def  pi_bot_defs.definition (parsed)
 * @param {number|null} projectId  pi_bot_defs.project_id column
 * @param {string} [tasksDbPath]  override for tasks.db location
 * @returns {string}
 */
export function getTrackerContext(def, projectId, tasksDbPath) {
  const tc = (def && def.tracker_config) || {};
  const type = tc.type || "kanban";

  switch (type) {
    case "none":
      return "";
    case "task-list":
      return taskListContext(tc.project_id != null ? tc.project_id : projectId, tasksDbPath);
    case "custom":
      if (!tc.tracker_slug) return "(tracker_config.type=custom but no tracker_slug set)";
      return customTrackerContext(tc.tracker_slug, tc.context_fields, tc.queue_filter);
    case "kanban":
    default:
      return kanbanContext(tc.project_id != null ? tc.project_id : projectId, tasksDbPath);
  }
}

/**
 * Resolve the tracker type for a bot definition, with default fallback.
 * @param {object} def
 * @returns {"kanban"|"task-list"|"custom"|"none"}
 */
export function resolveTrackerType(def) {
  const tc = (def && def.tracker_config) || {};
  return tc.type || "kanban";
}

// CLI: test tracker context for a bot
if (import.meta.url === "file://" + process.argv[1]) {
  const a = process.argv.slice(2);
  if (!a[0]) { console.error("usage: tracker.mjs <botId>"); process.exit(2); }
  const botId = a[0];
  const c = db(CROW_DB);
  const row = c.prepare("SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?").get(botId);
  c.close();
  if (!row) { console.error("unknown bot " + botId); process.exit(1); }
  const def = JSON.parse(row.definition || "{}");
  const projectId = row.project_id == null ? null : Number(row.project_id);
  console.log(getTrackerContext(def, projectId));
  process.exit(0);
}
