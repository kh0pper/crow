/**
 * PM Workspace — deterministic Monday.com sync engine.
 *
 * Monday API v2 GraphQL (https://api.monday.com/v2, Authorization:
 * $MONDAY_TOKEN). Pull uses items_page/next_items_page cursor pagination
 * with column_values (id, text, value), group { id }, and updated_at.
 *
 * Modes:
 *   mirror — Monday → tasks_items (board_defs slug board) in the target
 *     tracker. Title = item name, data_json from column_map, status through
 *     status_map (or
 *     status_default for unmapped labels). Never pushes. Local drift is
 *     overwritten and logged.
 *   twoway — three-way merge against pm_sync_state per item:
 *     local change detection = content_hash of the local row's mapped
 *     shape vs the stored hash; remote change detection = Monday
 *     updated_at vs the stored monday_updated_at.
 *       remote-newer  → update the local kanban tasks_items row
 *       local-newer   → push change_multiple_column_values (team_visible
 *                       fields only; status via reverse status_map only
 *                       when the local status differs from remote)
 *       both-changed  → conflict: Monday wins on team_visible fields,
 *                       local wins on the rest; logged as 'conflict'
 *       unmapped local row (matching target project) → create_item on
 *                       the Monday board, then record the mapping
 *     Deletions are NEVER propagated in either direction — they are
 *     logged as 'delete_flagged' and left for a human.
 *
 * Optional per-board features (see sync/mapping.js):
 *   group_ids         — only pull items whose Monday group id is listed
 *   phase_from_status — kanban targets also store the raw Monday status
 *                       label in tasks_items.phase (never pushed back)
 *   status_default    — mirror targets use this local status for Monday
 *                       labels missing from status_map
 *
 * All writes go through plain SQL with busy_timeout=10000 (set by the
 * db client factories). Bot-board processing leases are advisory
 * conventions between bots; this engine's writes are idempotent upserts,
 * so a lost race simply re-converges on the next run.
 */

import { createHash } from "node:crypto";
import { createTasksDbClient } from "../db.js";
import { loadSyncConfig } from "./mapping.js";

const MONDAY_API = "https://api.monday.com/v2";
const MONDAY_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;

// tasks_items columns the column_map may address on kanban targets.
const KANBAN_FIELDS = new Set(["title", "description", "due_date", "priority", "owner", "tags", "phase"]);

// ── Monday API ──────────────────────────────────────────────────────────

async function mondayQuery(token, query, variables = {}) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(MONDAY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Monday API HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Monday API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data;
}

/** Pull every item on a board (cursor-paginated), filtered by group_ids when set. */
export async function pullBoardItems(token, boardId, groupIds = null) {
  const items = [];
  let cursor = null;
  let first = true;

  while (first || cursor) {
    let page;
    if (first) {
      const data = await mondayQuery(
        token,
        `query ($boardId: [ID!], $limit: Int) {
          boards(ids: $boardId) {
            items_page(limit: $limit) {
              cursor
              items { id name updated_at group { id } column_values { id text value } }
            }
          }
        }`,
        { boardId: [String(boardId)], limit: PAGE_SIZE }
      );
      page = data?.boards?.[0]?.items_page;
      if (!page) throw new Error(`board ${boardId} not found or not accessible`);
      first = false;
    } else {
      const data = await mondayQuery(
        token,
        `query ($cursor: String!, $limit: Int) {
          next_items_page(cursor: $cursor, limit: $limit) {
            cursor
            items { id name updated_at group { id } column_values { id text value } }
          }
        }`,
        { cursor, limit: PAGE_SIZE }
      );
      page = data?.next_items_page;
      if (!page) break;
    }
    items.push(...(page.items || []));
    cursor = page.cursor || null;
  }

  if (groupIds) {
    const allow = new Set(groupIds);
    return items.filter((it) => it.group?.id && allow.has(it.group.id));
  }
  return items;
}

// ── Mapping helpers ─────────────────────────────────────────────────────

function columnText(item, colId) {
  const cv = (item.column_values || []).find((c) => c.id === colId);
  return cv ? (cv.text ?? "") : "";
}

/** Map a Monday item to local field values via the board's column_map. */
function mapRemoteFields(board, item) {
  const fields = {};
  for (const [colId, spec] of Object.entries(board.column_map)) {
    fields[spec.field] = columnText(item, colId);
  }
  return fields;
}

function remoteStatusLabel(board, item) {
  if (!board.status_column_id) return null;
  return columnText(item, board.status_column_id) || null;
}

/** Local status for a Monday label, honoring status_default. Returns {status, mapped}. */
function mapStatusLabel(board, label, fallback) {
  if (label != null && Object.prototype.hasOwnProperty.call(board.status_map, label)) {
    return { status: board.status_map[label], mapped: true };
  }
  if (board.status_default) return { status: board.status_default, mapped: false };
  return { status: fallback, mapped: false };
}

/** Reverse status_map lookup (first matching Monday label for a local status). */
function reverseStatus(board, localStatus) {
  for (const [label, local] of Object.entries(board.status_map)) {
    if (local === localStatus) return label;
  }
  return null;
}

/** Canonical hash of a local row's mapped shape (deterministic key order). */
export function contentHash(shape) {
  const keys = Object.keys(shape).sort();
  const canonical = JSON.stringify(keys.map((k) => [k, shape[k] ?? null]));
  return createHash("sha256").update(canonical).digest("hex");
}

function kanbanRowShape(board, row) {
  const shape = { title: row.title ?? "", status: row.status ?? "" };
  for (const spec of Object.values(board.column_map)) {
    if (spec.field === "title") continue;
    shape[spec.field] = row[spec.field] != null ? String(row[spec.field]) : "";
  }
  return shape;
}

function trackerRowShape(board, label, status, dataJson) {
  return { label: label ?? "", status: status ?? "", data: dataJson ?? "" };
}

/** Build the Monday column_values payload for a push (team_visible fields only). */
function buildPushColumns(board, row, remoteLabel) {
  const cols = {};
  for (const [colId, spec] of Object.entries(board.column_map)) {
    if (!spec.team_visible) continue;
    if (spec.field === "title" || spec.field === "phase") continue; // name is item_name; phase never pushes
    const value = row[spec.field];
    if (value == null || value === "") continue;
    if (spec.field === "due_date") {
      cols[colId] = { date: String(value).slice(0, 10) };
    } else {
      cols[colId] = String(value);
    }
  }
  // Status: only when the local status differs from what remote currently maps to.
  if (board.status_column_id) {
    const remoteLocal = mapStatusLabel(board, remoteLabel, null).status;
    if (row.status && row.status !== remoteLocal) {
      const label = reverseStatus(board, row.status);
      if (label) cols[board.status_column_id] = { label };
    }
  }
  return cols;
}

// ── Logging ─────────────────────────────────────────────────────────────

async function logSync(db, { direction, board_id, action, item_ref, detail, ok }) {
  try {
    await db.execute({
      sql: `INSERT INTO pm_sync_log (direction, board_id, action, item_ref, detail, ok)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [direction || null, board_id || null, action, item_ref || null, detail || null, ok ? 1 : 0],
    });
  } catch (err) {
    console.warn(`[pm-workspace sync] log write failed: ${err.message}`);
  }
}

async function getSyncState(db, boardId, itemId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM pm_sync_state WHERE board_id = ? AND item_id = ?",
    args: [String(boardId), String(itemId)],
  });
  return rows[0] || null;
}

async function upsertSyncState(db, { source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at }) {
  await db.execute({
    sql: `INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at, last_synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(board_id, item_id) DO UPDATE SET
            content_hash = excluded.content_hash,
            monday_updated_at = excluded.monday_updated_at,
            local_kind = excluded.local_kind,
            local_id = excluded.local_id,
            last_synced_at = datetime('now')`,
    args: [source || "monday", String(board_id), String(item_id), local_kind, local_id, content_hash, monday_updated_at],
  });
}

// D-T1.6: archived cards are pull-only. Column-guarded (PRAGMA probe, the
// idiom scripts/pi-bots/tracker.mjs's archivedClause / digest/adapters/
// boards.js hasArchivedAtColumn use) — an installed-bundle tasks.db may not
// have converged through migration 0004 yet, so an unguarded reference to
// tasks_items.archived_at in a WHERE clause would throw on that store.
// Row-level archived checks elsewhere in this file don't need this probe:
// they read `row.archived_at` off a `SELECT *` result, which is undefined
// (falsy) on a store lacking the column — naturally guarded already.
async function hasArchivedAtColumn(tdb) {
  try {
    const rows = (await tdb.execute("PRAGMA table_info(tasks_items)")).rows || [];
    return rows.some((r) => r.name === "archived_at");
  } catch {
    return false;
  }
}

// ── Mirror mode (Monday → tasks_items, Track 0 Phase B unified store) ───
//
// pm_sync_state/pm_sync_log stay on `cdb` (crow.db); board_defs/tasks_items
// (the converged tracker_defs/tracker_items) live on `tdb` (tasks.db).
// local_kind stays 'tracker'; local_id now addresses a tasks_items row.

export async function syncMirrorBoard(cdb, tdb, board, items, totals) {
  const def = (
    await tdb.execute({ sql: "SELECT id, slug FROM board_defs WHERE slug = ?", args: [board.target.slug] })
  ).rows[0];
  if (!def) {
    await logSync(cdb, {
      direction: "pull", board_id: board.board_id, action: "error",
      detail: `tracker "${board.target.slug}" not found`, ok: false,
    });
    totals.errors++;
    return;
  }

  const archivedAtCol = await hasArchivedAtColumn(tdb);
  const seen = new Set();
  for (const item of items) {
    seen.add(String(item.id));
    const fields = mapRemoteFields(board, item);
    const rawLabel = remoteStatusLabel(board, item);
    const { status, mapped } = mapStatusLabel(board, rawLabel, rawLabel || "pending");
    if (rawLabel && !mapped && !board.status_default) {
      await logSync(cdb, {
        direction: "pull", board_id: board.board_id, action: "status_unmapped",
        item_ref: item.name, detail: `Monday label "${rawLabel}" has no status_map entry; using raw label`, ok: true,
      });
    }
    const dataJson = JSON.stringify(fields);
    const state = await getSyncState(cdb, board.board_id, item.id);

    if (state && state.local_id != null) {
      // F4: tasks_items is a MERGED id space post Track 0 Phase B (card ids
      // and tracker-item ids share one AUTOINCREMENT sequence). A stale
      // pm_sync_state row whose local_id has come to collide with a plain
      // BOARD CARD's id must never let this mirror UPDATE-in-place onto that
      // card — scope the lookup to THIS def's board_id so a mismatch falls
      // through to the create-new branch below instead.
      const existing = (
        await tdb.execute({
          sql: `SELECT id, status, title, data_json${archivedAtCol ? ", archived_at" : ""} FROM tasks_items WHERE id = ? AND board_id = ?`,
          args: [state.local_id, def.id],
        })
      ).rows[0];
      if (existing) {
        const localHash = contentHash(trackerRowShape(board, existing.title, existing.status, existing.data_json));
        if (state.content_hash && localHash !== state.content_hash) {
          await logSync(cdb, {
            direction: "pull", board_id: board.board_id, action: "overwrite_local_drift",
            item_ref: item.name, detail: "local tasks_items edits overwritten by mirror pull", ok: true,
          });
        }
        await tdb.execute({
          sql: `UPDATE tasks_items SET title = ?, status = ?, data_json = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [item.name, status, dataJson, existing.id],
        });
        await upsertSyncState(cdb, {
          source: "monday", board_id: board.board_id, item_id: item.id,
          local_kind: "tracker", local_id: existing.id,
          content_hash: contentHash(trackerRowShape(board, item.name, status, dataJson)),
          monday_updated_at: item.updated_at,
        });
        // D-T1.6: a by-id pull still writes an archived row in place (never
        // re-INSERTs) — but that's local-visible-only drift against a live
        // Monday item, so it's logged under a distinct, greppable action
        // rather than folded into the normal "this converged silently" case.
        if (existing.archived_at) {
          await logSync(cdb, {
            direction: "pull", board_id: board.board_id, action: "pull_archived_update",
            item_ref: item.name, detail: `tasks_items id ${existing.id} is archived; updated in place (still archived)`, ok: true,
          });
        }
        totals.updated++;
        continue;
      }
    }

    const result = await tdb.execute({
      sql: `INSERT INTO tasks_items (board_id, status, priority, title, data_json)
            VALUES (?, ?, 3, ?, ?)`,
      args: [def.id, status, item.name, dataJson],
    });
    const localId = Number(result.lastInsertRowid);
    await upsertSyncState(cdb, {
      source: "monday", board_id: board.board_id, item_id: item.id,
      local_kind: "tracker", local_id: localId,
      content_hash: contentHash(trackerRowShape(board, item.name, status, dataJson)),
      monday_updated_at: item.updated_at,
    });
    await logSync(cdb, {
      direction: "pull", board_id: board.board_id, action: "create_local",
      item_ref: item.name, detail: `tasks_items id ${localId}`, ok: true,
    });
    totals.created++;
  }

  await flagRemoteDeletions(cdb, board, seen, totals);
}

/**
 * Items known to sync_state but missing from this pull → flag, never delete.
 * Only touches pm_sync_state/pm_sync_log (`db` = cdb) — it never has to look
 * up the local row itself, so it stays DB-agnostic even though, post Track 0
 * Phase B, local_id for BOTH local_kind values ('tracker' and 'kanban')
 * addresses a tasks_items row on tdb.
 */
async function flagRemoteDeletions(db, board, seenItemIds, totals) {
  const { rows } = await db.execute({
    sql: "SELECT item_id, local_kind, local_id FROM pm_sync_state WHERE board_id = ?",
    args: [board.board_id],
  });
  for (const row of rows) {
    if (seenItemIds.has(String(row.item_id))) continue;
    await logSync(db, {
      direction: "pull", board_id: board.board_id, action: "delete_flagged",
      item_ref: `monday:${row.item_id}`,
      detail: `Monday item ${row.item_id} no longer in pull (deleted, archived, or moved out of group_ids); local ${row.local_kind} ${row.local_id} kept`,
      ok: true,
    });
    totals.flagged++;
  }
}

// ── Twoway mode (Monday ↔ tasks_items) ──────────────────────────────────

async function applyRemoteToKanban(tdb, board, item, row, { teamVisibleOnly = false } = {}) {
  const fields = mapRemoteFields(board, item);
  const rawLabel = remoteStatusLabel(board, item);
  const { status } = mapStatusLabel(board, rawLabel, row?.status || "pending");

  const sets = [];
  const args = [];
  const apply = (field, value) => {
    if (!KANBAN_FIELDS.has(field)) return;
    if (field === "priority") {
      const n = Math.min(5, Math.max(1, parseInt(value, 10) || 3));
      sets.push("priority = ?"); args.push(n);
    } else {
      sets.push(`${field} = ?`); args.push(value === "" ? null : value);
    }
  };

  for (const [colId, spec] of Object.entries(board.column_map)) {
    if (teamVisibleOnly && !spec.team_visible) continue;
    if (spec.field === "title") {
      sets.push("title = ?"); args.push(item.name);
    } else {
      apply(spec.field, fields[spec.field]);
    }
  }
  if (!Object.values(board.column_map).some((s) => s.field === "title")) {
    sets.push("title = ?"); args.push(item.name);
  }
  if (board.status_column_id) {
    sets.push("status = ?"); args.push(status);
    if (status === "done") { sets.push("completed_at = COALESCE(completed_at, datetime('now'))"); }
  }
  if (board.phase_from_status && rawLabel != null) {
    sets.push("phase = ?"); args.push(rawLabel);
  }
  sets.push("updated_at = datetime('now')");
  args.push(row.id);
  await tdb.execute({ sql: `UPDATE tasks_items SET ${sets.join(", ")} WHERE id = ?`, args });

  return (await tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id = ?", args: [row.id] })).rows[0];
}

async function createKanbanFromRemote(tdb, board, item) {
  const fields = mapRemoteFields(board, item);
  const rawLabel = remoteStatusLabel(board, item);
  const { status } = mapStatusLabel(board, rawLabel, "pending");
  const priority = Math.min(5, Math.max(1, parseInt(fields.priority, 10) || 3));

  const result = await tdb.execute({
    sql: `INSERT INTO tasks_items (title, description, status, priority, due_date, phase, owner, tags, project_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      item.name,
      fields.description || null,
      status,
      priority,
      fields.due_date || null,
      board.phase_from_status && rawLabel != null ? rawLabel : (fields.phase || null),
      fields.owner || null,
      fields.tags || null,
      board.target.project_id != null ? Number(board.target.project_id) : null,
    ],
  });
  const id = Number(result.lastInsertRowid);
  return (await tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id = ?", args: [id] })).rows[0];
}

async function pushLocalToMonday(token, board, row, item) {
  const cols = buildPushColumns(board, row, remoteStatusLabel(board, item));
  const ops = [];
  if (row.title && row.title !== item.name) {
    // Item name is pushed via the dedicated name column.
    cols.name = row.title;
  }
  if (Object.keys(cols).length === 0) return { pushed: false };
  await mondayQuery(
    token,
    `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
    }`,
    { boardId: String(board.board_id), itemId: String(item.id), values: JSON.stringify(cols) }
  );
  return { pushed: true, columns: Object.keys(cols) };
}

async function createMondayFromLocal(token, board, row) {
  const cols = {};
  for (const [colId, spec] of Object.entries(board.column_map)) {
    if (!spec.team_visible) continue;
    if (spec.field === "title" || spec.field === "phase") continue;
    const value = row[spec.field];
    if (value == null || value === "") continue;
    cols[colId] = spec.field === "due_date" ? { date: String(value).slice(0, 10) } : String(value);
  }
  if (board.status_column_id && row.status) {
    const label = reverseStatus(board, row.status);
    if (label) cols[board.status_column_id] = { label };
  }
  const data = await mondayQuery(
    token,
    `mutation ($boardId: ID!, $name: String!, $values: JSON) {
      create_item(board_id: $boardId, item_name: $name, column_values: $values) { id updated_at }
    }`,
    { boardId: String(board.board_id), name: row.title || "Untitled", values: JSON.stringify(cols) }
  );
  return data.create_item;
}

export async function syncTwowayBoard(db, tdb, board, items, token, totals) {
  const archivedAtCol = await hasArchivedAtColumn(tdb);
  const seen = new Set();

  for (const item of items) {
    seen.add(String(item.id));
    const state = await getSyncState(db, board.board_id, item.id);

    let row = null;
    if (state && state.local_id != null) {
      row = (await tdb.execute({ sql: "SELECT * FROM tasks_items WHERE id = ?", args: [state.local_id] })).rows[0] || null;
    }

    if (!state || !row) {
      if (state && !row) {
        // Local row deleted — never propagate; keep flagging until resolved.
        await logSync(db, {
          direction: "push", board_id: board.board_id, action: "delete_flagged",
          item_ref: item.name,
          detail: `local tasks_items ${state.local_id} deleted; Monday item ${item.id} kept`,
          ok: true,
        });
        totals.flagged++;
        continue;
      }
      // New remote item → create locally, record mapping.
      const created = await createKanbanFromRemote(tdb, board, item);
      await upsertSyncState(db, {
        source: "monday", board_id: board.board_id, item_id: item.id,
        local_kind: "kanban", local_id: created.id,
        content_hash: contentHash(kanbanRowShape(board, created)),
        monday_updated_at: item.updated_at,
      });
      await logSync(db, {
        direction: "pull", board_id: board.board_id, action: "create_local",
        item_ref: item.name, detail: `tasks_items id ${created.id}`, ok: true,
      });
      totals.created++;
      continue;
    }

    const localHash = contentHash(kanbanRowShape(board, row));
    const localChanged = state.content_hash != null && localHash !== state.content_hash;
    const remoteChanged = state.monday_updated_at !== item.updated_at;

    if (!localChanged && !remoteChanged) {
      await upsertSyncState(db, {
        source: "monday", board_id: board.board_id, item_id: item.id,
        local_kind: "kanban", local_id: row.id,
        content_hash: localHash, monday_updated_at: item.updated_at,
      });
      continue;
    }

    if (remoteChanged && !localChanged) {
      // D-T1.6: an archived row is still a valid by-id pull TARGET — it
      // updates in place (never re-INSERTs) so a live Monday item never
      // silently drifts from a hidden local row. The distinct action makes
      // that drift greppable instead of folding into the ordinary case.
      const archived = Boolean(row.archived_at);
      const updated = await applyRemoteToKanban(tdb, board, item, row);
      await upsertSyncState(db, {
        source: "monday", board_id: board.board_id, item_id: item.id,
        local_kind: "kanban", local_id: row.id,
        content_hash: contentHash(kanbanRowShape(board, updated)),
        monday_updated_at: item.updated_at,
      });
      await logSync(db, {
        direction: "pull", board_id: board.board_id,
        action: archived ? "pull_archived_update" : "update_local",
        item_ref: item.name,
        detail: archived
          ? "remote-newer → archived local row updated in place (still archived)"
          : "remote-newer → local updated",
        ok: true,
      });
      totals.updated++;
      continue;
    }

    if (localChanged && !remoteChanged) {
      // D-T1.6: an archived card is not a change to publish — including one
      // with a pre-archive unsynced edit. That edit stays local; a later
      // pull may overwrite it (logged separately, above). Sync state is
      // deliberately left untouched so the mismatch keeps landing here
      // (harmlessly re-skipped) rather than being silently resolved.
      if (row.archived_at) {
        continue;
      }
      try {
        const result = await pushLocalToMonday(token, board, row, item);
        await upsertSyncState(db, {
          source: "monday", board_id: board.board_id, item_id: item.id,
          local_kind: "kanban", local_id: row.id,
          content_hash: localHash, monday_updated_at: item.updated_at,
        });
        await logSync(db, {
          direction: "push", board_id: board.board_id, action: "push_remote",
          item_ref: row.title,
          detail: result.pushed ? `pushed columns: ${result.columns.join(", ")}` : "no team_visible changes to push",
          ok: true,
        });
        totals.pushed++;
      } catch (err) {
        await logSync(db, {
          direction: "push", board_id: board.board_id, action: "error",
          item_ref: row.title, detail: `push failed: ${err.message}`, ok: false,
        });
        totals.errors++;
      }
      continue;
    }

    // Both changed → conflict. Monday wins on team_visible fields; local wins on the rest.
    const updated = await applyRemoteToKanban(tdb, board, item, row, { teamVisibleOnly: true });
    await upsertSyncState(db, {
      source: "monday", board_id: board.board_id, item_id: item.id,
      local_kind: "kanban", local_id: row.id,
      content_hash: contentHash(kanbanRowShape(board, updated)),
      monday_updated_at: item.updated_at,
    });
    await logSync(db, {
      direction: "both", board_id: board.board_id,
      action: row.archived_at ? "pull_archived_update" : "conflict",
      item_ref: item.name,
      detail: "both sides changed; Monday kept team_visible fields, local kept the rest",
      ok: true,
    });
    totals.conflicts++;
  }

  // Local rows in the target project with no mapping → create on Monday.
  // D-T1.6: archived-but-unmapped rows are excluded — without this an
  // archived done card gets RE-CREATED on Monday at every scan, resurrecting
  // the backlog remotely. Column-guarded: an installed-bundle tasks.db may
  // not have converged through migration 0004 yet.
  if (board.target.project_id != null) {
    const archivedClause = archivedAtCol ? " AND archived_at IS NULL" : "";
    const { rows: candidates } = await tdb.execute({
      sql: `SELECT * FROM tasks_items
            WHERE project_id = ? AND parent_id IS NULL AND status != 'cancelled'${archivedClause}`,
      args: [Number(board.target.project_id)],
    });
    const { rows: mapped } = await db.execute({
      sql: "SELECT local_id FROM pm_sync_state WHERE board_id = ? AND local_kind = 'kanban'",
      args: [board.board_id],
    });
    const mappedIds = new Set(mapped.map((r) => Number(r.local_id)));

    for (const row of candidates) {
      if (mappedIds.has(Number(row.id))) continue;
      try {
        const created = await createMondayFromLocal(token, board, row);
        await upsertSyncState(db, {
          source: "monday", board_id: board.board_id, item_id: created.id,
          local_kind: "kanban", local_id: row.id,
          content_hash: contentHash(kanbanRowShape(board, row)),
          monday_updated_at: created.updated_at || null,
        });
        await logSync(db, {
          direction: "push", board_id: board.board_id, action: "create_remote",
          item_ref: row.title, detail: `Monday item ${created.id}`, ok: true,
        });
        totals.created++;
      } catch (err) {
        await logSync(db, {
          direction: "push", board_id: board.board_id, action: "error",
          item_ref: row.title, detail: `create_item failed: ${err.message}`, ok: false,
        });
        totals.errors++;
      }
    }
  }

  await flagRemoteDeletions(db, board, seen, totals);
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Run one full sync pass over every configured board.
 * Returns { ok, skipped?, reason?, totals?, boards? }.
 */
export async function runSync(db, config) {
  let syncConfig;
  try {
    syncConfig = loadSyncConfig(config);
  } catch (err) {
    await logSync(db, { action: "error", detail: `config: ${err.message}`, ok: false });
    return { ok: false, error: err.message };
  }
  if (!syncConfig.boards || syncConfig.boards.length === 0) {
    return { ok: true, skipped: true, reason: syncConfig.reason || "no boards configured" };
  }
  const token = config.MONDAY_TOKEN;
  if (!token) {
    return { ok: true, skipped: true, reason: "MONDAY_TOKEN not set" };
  }

  await logSync(db, { action: "run_start", detail: `${syncConfig.boards.length} board(s)`, ok: true });

  const totals = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };
  const boardResults = [];
  let tdb = null;

  try {
    for (const board of syncConfig.boards) {
      try {
        const items = await pullBoardItems(token, board.board_id, board.group_ids);
        if (board.target.kind === "tracker") {
          if (!tdb) tdb = createTasksDbClient(config);
          if (!tdb) throw new Error("tasks.db not found (tracker target needs the tasks bundle)");
          await syncMirrorBoard(db, tdb, board, items, totals);
        } else {
          if (!tdb) tdb = createTasksDbClient(config);
          if (!tdb) throw new Error("tasks.db not found (kanban target needs the tasks bundle)");
          await syncTwowayBoard(db, tdb, board, items, token, totals);
        }
        boardResults.push({ board_id: board.board_id, mode: board.mode, items: items.length, ok: true });
      } catch (err) {
        await logSync(db, {
          direction: "pull", board_id: board.board_id, action: "error",
          detail: err.message, ok: false,
        });
        totals.errors++;
        boardResults.push({ board_id: board.board_id, mode: board.mode, ok: false, error: err.message });
      }
    }
  } finally {
    try { tdb?.close?.(); } catch { /* ignore */ }
  }

  await logSync(db, { action: "run_end", detail: JSON.stringify(totals), ok: totals.errors === 0 });
  return { ok: totals.errors === 0, totals, boards: boardResults };
}
