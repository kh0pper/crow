/**
 * PM Workspace — sync config loader + validation.
 *
 * $SYNC_CONFIG_FILE is JSON:
 * {
 *   "boards": [
 *     {
 *       "board_id": "1234567890",
 *       "mode": "mirror" | "twoway",
 *       "target": { "kind": "tracker", "slug": "my-tracker" }
 *               | { "kind": "kanban", "project_id": 1 },
 *       "column_map": {
 *         "<monday_column_id>": { "field": "<local field>", "team_visible": true|false }
 *       },
 *       "status_map": { "<monday label>": "<local status>" },
 *       "status_column_id": "status",
 *       "group_ids": ["group_abc"],          // optional: only pull items in these Monday groups
 *       "phase_from_status": true,           // optional (twoway/kanban): also write raw label → tasks_items.phase
 *       "status_default": "other"            // optional (mirror): local status for unmapped Monday labels
 *     }
 *   ]
 * }
 *
 * Validation throws with a message naming every problem found —
 * a half-valid config never partially syncs.
 */

import { existsSync, readFileSync } from "node:fs";

export function loadSyncConfig(config) {
  const path = config.SYNC_CONFIG_FILE;
  if (!path) return { boards: [], reason: "SYNC_CONFIG_FILE not set" };
  if (!existsSync(path)) throw new Error(`sync config file not found: ${path}`);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`sync config is not valid JSON: ${err.message}`);
  }

  return validateSyncConfig(parsed);
}

export function validateSyncConfig(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.boards)) {
    throw new Error('sync config must be an object with a "boards" array');
  }

  parsed.boards.forEach((b, i) => {
    const at = `boards[${i}]`;
    if (!b || typeof b !== "object") {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (!b.board_id || !/^\d+$/.test(String(b.board_id))) {
      errors.push(`${at}.board_id: required, numeric Monday board id (string or number)`);
    }
    if (b.mode !== "mirror" && b.mode !== "twoway") {
      errors.push(`${at}.mode: must be "mirror" or "twoway"`);
    }
    const t = b.target;
    if (!t || typeof t !== "object") {
      errors.push(`${at}.target: required`);
    } else if (t.kind === "tracker") {
      if (!t.slug || typeof t.slug !== "string") errors.push(`${at}.target.slug: required for kind "tracker"`);
    } else if (t.kind === "kanban") {
      if (t.project_id !== undefined && !Number.isInteger(Number(t.project_id))) {
        errors.push(`${at}.target.project_id: must be an integer when present`);
      }
    } else {
      errors.push(`${at}.target.kind: must be "tracker" or "kanban"`);
    }
    if (b.mode === "twoway" && t?.kind !== "kanban") {
      errors.push(`${at}: twoway mode requires a kanban target (trackers are mirror-only)`);
    }

    if (b.column_map !== undefined) {
      if (!b.column_map || typeof b.column_map !== "object" || Array.isArray(b.column_map)) {
        errors.push(`${at}.column_map: must be an object of { monday_col_id: { field, team_visible } }`);
      } else {
        for (const [colId, spec] of Object.entries(b.column_map)) {
          if (!spec || typeof spec !== "object" || typeof spec.field !== "string" || !spec.field) {
            errors.push(`${at}.column_map["${colId}"]: needs a non-empty string "field"`);
          }
          if (spec && spec.team_visible !== undefined && typeof spec.team_visible !== "boolean") {
            errors.push(`${at}.column_map["${colId}"].team_visible: must be boolean`);
          }
        }
      }
    }

    if (b.status_map !== undefined) {
      if (!b.status_map || typeof b.status_map !== "object" || Array.isArray(b.status_map)) {
        errors.push(`${at}.status_map: must be an object of { monday_label: local_status }`);
      } else {
        for (const [label, local] of Object.entries(b.status_map)) {
          if (typeof local !== "string" || !local) {
            errors.push(`${at}.status_map["${label}"]: must map to a non-empty string`);
          }
        }
      }
    }

    if (b.status_map && !b.status_column_id) {
      errors.push(`${at}.status_column_id: required when status_map is set`);
    }

    if (b.group_ids !== undefined) {
      if (!Array.isArray(b.group_ids) || b.group_ids.some((g) => typeof g !== "string" || !g)) {
        errors.push(`${at}.group_ids: must be an array of non-empty strings (Monday group ids)`);
      }
    }

    if (b.phase_from_status !== undefined) {
      if (typeof b.phase_from_status !== "boolean") {
        errors.push(`${at}.phase_from_status: must be boolean`);
      } else if (b.phase_from_status && t?.kind !== "kanban") {
        errors.push(`${at}.phase_from_status: only valid for kanban targets (tasks_items.phase)`);
      }
    }

    if (b.status_default !== undefined) {
      if (typeof b.status_default !== "string" || !b.status_default) {
        errors.push(`${at}.status_default: must be a non-empty string`);
      }
    }
  });

  if (errors.length > 0) {
    throw new Error(`sync config invalid:\n  - ${errors.join("\n  - ")}`);
  }

  return {
    boards: parsed.boards.map((b) => ({
      board_id: String(b.board_id),
      mode: b.mode,
      target: b.target,
      column_map: b.column_map || {},
      status_map: b.status_map || {},
      status_column_id: b.status_column_id || null,
      group_ids: Array.isArray(b.group_ids) && b.group_ids.length > 0 ? b.group_ids : null,
      phase_from_status: b.phase_from_status === true,
      status_default: b.status_default || null,
    })),
  };
}
