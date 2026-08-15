/**
 * Board MCP server — Track 1 Task 6 (D-T1.1). The gateway's board_* verb
 * surface, thin over the Task 2/3 service layer (servers/gateway/board/
 * {card,plan,result}-service.js). Mounted at /board/mcp (+ /board/sse,
 * /board/messages) by boot/mcp-mounts.js on the same mountMcpServer rail as
 * every other core server. Auth is token-only (local token OR the board
 * token, both validated in local-token.js) — there is no cookie leg.
 *
 * ONE implementation serves three callers (Kevin's sessions, the dashboard's
 * shared service layer, and bots) — this file itself only needs to serve the
 * MCP wire protocol; the dashboard talks to the SAME services via its own
 * HTTP routes (bot-board-api.js), never through this mount.
 *
 * Card vs item dispatch (D-T1.8 merged-id-space guard): every verb that
 * takes a single `id`/`item_id` and could name either kind (get/update/move/
 * archive/unarchive) probes `tasks_items.board_id` ONCE (probeKind) and
 * dispatches to the card-service or item-service half accordingly — never a
 * bare-id write, per card-service.js's own invariant.
 *
 * Actor resolution (D-T1.3): resolveActor(extra) reads `extra.authInfo` (the
 * MCP SDK's alias for the mount's req.auth — see routes/mcp.js/local-token.js)
 * and `extra.requestInfo.headers` (verified: shared/protocol.js passes both
 * through to every tool handler; streamableHttp.js's underlying
 * webStandardStreamableHttp.js builds requestInfo.headers from the raw HTTP
 * headers, sse.js does the same). Default actor is 'session'. A caller whose
 * auth is token-based (authInfo.clientId === 'local-mcp' — true for BOTH the
 * full local token and the path-scoped board token, since both synthesize the
 * same req.auth via local-token.js's localOperatorAuth()) MAY override to a
 * 'bot' actor via X-Crow-Actor-Kind: bot + X-Crow-Actor-Id + X-Crow-Job-Id.
 * Any non-token caller (OAuth, peer-instance) always gets 'session' — headers
 * are never honored off the token rail.
 *
 * Error idiom: every service throws `Object.assign(new Error(msg), {code,
 * http})` (card-service.js's `fail()`). `tool()` below catches that and
 * returns an MCP `isError: true` result with text `[<http> <code>] <msg>` —
 * board_report_result's 409s MUST surface this way (Task 7's bridge-side
 * session-done detection scans pi.toolCalls() for a non-error
 * board_report_result call; a refused report must never look like a success).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../db.js";
import { tasksDbPath } from "../../scripts/pi-bots/instance-paths.mjs";
import {
  resolveBoardDef, resolveSlugBoardDef, isValidStatus,
} from "./routes/board-defs.js";
import {
  getCard, getItem, createCard, updateCard, moveCard,
  archiveCard, unarchiveCard, moveItem, updateItem, archiveItem, unarchiveItem,
  recordMutation,
} from "./board/card-service.js";
import { getCurrentPlan, listPlans, savePlan, approvePlan } from "./board/plan-service.js";
import { reportResult, decideResult, listResults } from "./board/result-service.js";

const TASKS_DB = tasksDbPath();

function fail(msg, code, http) {
  return Object.assign(new Error(msg), { code, http });
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data === undefined ? {} : data, null, 2) }] };
}

function errResult(e) {
  const http = e && e.http ? e.http : 500;
  const code = e && e.code ? e.code : "error";
  const msg = (e && e.message) || String(e);
  return { content: [{ type: "text", text: `[${http} ${code}] ${msg}` }], isError: true };
}

/** Register one board_* tool: `fn(args, extra)` returns plain data on success
 *  (wrapped in `ok()`) or throws a `{code,http}` error (wrapped in
 *  `errResult()` → MCP isError). Centralizes the try/catch so every verb
 *  below is a one-liner. */
function tool(server, name, description, schema, fn) {
  server.tool(name, description, schema, async (args, extra) => {
    try {
      return ok(await fn(args, extra));
    } catch (e) {
      return errResult(e);
    }
  });
}

// ---- actor resolution (D-T1.3) ----

function headerValue(headers, key) {
  const v = headers ? headers[key] : undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s == null ? null : String(s);
}

export function resolveActor(extra) {
  const tokenAuthed = extra?.authInfo?.clientId === "local-mcp";
  if (tokenAuthed) {
    const headers = extra?.requestInfo?.headers || {};
    const kind = headerValue(headers, "x-crow-actor-kind");
    if (kind === "bot") {
      return {
        kind: "bot",
        id: headerValue(headers, "x-crow-actor-id"),
        jobId: headerValue(headers, "x-crow-job-id"),
      };
    }
  }
  return { kind: "session", id: null, jobId: null };
}

// ---- card/item dispatch (D-T1.8) ----

async function probeKind(tdb, id) {
  if (!Number.isInteger(id)) return null;
  const row = (await tdb.execute({ sql: "SELECT board_id FROM tasks_items WHERE id=?", args: [id] })).rows[0];
  if (!row) return null;
  return row.board_id == null ? "card" : "item";
}

async function resolveDefForBoardId(tdb, boardId) {
  const row = (await tdb.execute({ sql: "SELECT slug FROM board_defs WHERE id=?", args: [boardId] })).rows[0];
  if (!row || !row.slug) return null;
  return resolveSlugBoardDef(tdb, row.slug);
}

async function dispatchUpdate(tdb, id, fields, actor) {
  const kind = await probeKind(tdb, id);
  if (kind === "card") return updateCard(tdb, id, fields, actor);
  if (kind === "item") return updateItem(tdb, id, fields, actor);
  throw fail(`not found: ${id}`, "not_found", 404);
}

async function dispatchMove(tdb, cdb, id, status, actor) {
  const kind = await probeKind(tdb, id);
  if (kind === "card") { await moveCard(tdb, cdb, id, status, actor); return { id, status }; }
  if (kind === "item") { await moveItem(tdb, id, status, actor); return { id, status }; }
  throw fail(`not found: ${id}`, "not_found", 404);
}

async function dispatchArchive(tdb, cdb, id, actor) {
  const kind = await probeKind(tdb, id);
  if (kind === "card") { await archiveCard(tdb, cdb, id, actor); return { id, archived: true }; }
  if (kind === "item") { await archiveItem(tdb, id, actor); return { id, archived: true }; }
  throw fail(`not found: ${id}`, "not_found", 404);
}

async function dispatchUnarchive(tdb, id, actor) {
  const kind = await probeKind(tdb, id);
  if (kind === "card") { await unarchiveCard(tdb, id, actor); return { id, archived: false }; }
  if (kind === "item") { await unarchiveItem(tdb, id, actor); return { id, archived: false }; }
  throw fail(`not found: ${id}`, "not_found", 404);
}

// ---- reads / listings ----

async function listBoardsImpl(tdb, cdb, includeArchived) {
  const archivedClause = includeArchived ? "" : " AND archived_at IS NULL";
  const boards = [];
  let projects = [];
  try {
    projects = (await cdb.execute({
      sql: "SELECT id, name, slug FROM project_spaces WHERE archived_at IS NULL ORDER BY id",
      args: [],
    })).rows || [];
  } catch { projects = []; }
  for (const p of projects) {
    const def = await resolveBoardDef(tdb, { projectId: p.id });
    const counts = (await tdb.execute({
      sql: `SELECT status, COUNT(*) AS n FROM tasks_items WHERE board_id IS NULL AND project_id=?${archivedClause} GROUP BY status`,
      args: [p.id],
    })).rows || [];
    boards.push({
      kind: "project", project_id: Number(p.id), name: p.name, slug: p.slug,
      display_name: def.display_name, status_values: def.status_values,
      terminal_values: def.terminal_values, builtin: def.builtin,
      counts: Object.fromEntries(counts.map((r) => [r.status, Number(r.n)])),
    });
  }
  const slugDefs = (await tdb.execute({
    sql: "SELECT id, slug, display_name, status_values, terminal_values FROM board_defs WHERE slug IS NOT NULL ORDER BY slug",
    args: [],
  })).rows || [];
  for (const d of slugDefs) {
    const counts = (await tdb.execute({
      sql: `SELECT status, COUNT(*) AS n FROM tasks_items WHERE board_id=?${archivedClause} GROUP BY status`,
      args: [d.id],
    })).rows || [];
    boards.push({
      kind: "tracker", board_id: Number(d.id), slug: d.slug, display_name: d.display_name,
      status_values: JSON.parse(d.status_values), terminal_values: JSON.parse(d.terminal_values),
      counts: Object.fromEntries(counts.map((r) => [r.status, Number(r.n)])),
    });
  }
  return boards;
}

async function listItemsImpl(tdb, f) {
  const clauses = [];
  const args = [];
  let boardId = null;
  if (f.slug) {
    const row = (await tdb.execute({ sql: "SELECT id FROM board_defs WHERE slug=?", args: [f.slug] })).rows[0];
    if (!row) throw fail(`tracker not found: ${f.slug}`, "not_found", 404);
    boardId = Number(row.id);
  } else if (f.board_id != null) {
    boardId = Number(f.board_id);
  }
  if (boardId != null) {
    clauses.push("board_id = ?"); args.push(boardId);
  } else {
    clauses.push("board_id IS NULL");
    if (f.project_id != null) { clauses.push("project_id = ?"); args.push(Number(f.project_id)); }
  }
  if (f.status) { clauses.push("status = ?"); args.push(String(f.status)); }
  if (f.tag) { clauses.push("tags LIKE ?"); args.push(`%${String(f.tag)}%`); }
  if (f.search) {
    clauses.push("(title LIKE ? OR description LIKE ?)");
    const s = `%${String(f.search)}%`; args.push(s, s);
  }
  if (!f.include_archived) clauses.push("archived_at IS NULL");
  const limit = Number.isInteger(f.limit) && f.limit > 0 ? Math.min(f.limit, 500) : 200;
  const rows = (await tdb.execute({
    sql: `SELECT * FROM tasks_items WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`,
    args,
  })).rows || [];
  return { count: rows.length, items: rows };
}

async function getItemFullImpl(tdb, id) {
  let row = await getCard(tdb, id);
  let kind = "card";
  if (!row) { row = await getItem(tdb, id); kind = "item"; }
  if (!row) throw fail(`not found: ${id}`, "not_found", 404);
  const plan = await getCurrentPlan(tdb, id);
  const results = await listResults(tdb, id);
  const mutations = (await tdb.execute({
    sql: "SELECT * FROM board_mutations WHERE item_id=? ORDER BY id DESC LIMIT 10",
    args: [id],
  })).rows || [];
  return { kind, item: row, plan, results, mutations };
}

/** Tracker-item creation: card-service.js exports no createItem (only its
 *  card half is a Task-2 contract) — this mirrors bot-board-api.js's
 *  POST /tracker-item INSERT, def-validated, with a recordMutation call this
 *  new verb surface owns (the legacy route does not record one; not this
 *  file's job to retrofit it there). */
async function createItemImpl(tdb, boardId, fields, actor) {
  const def = await resolveDefForBoardId(tdb, boardId);
  if (!def) throw fail(`tracker not found for board_id ${boardId}`, "not_found", 404);
  const status = fields.status != null ? String(fields.status) : def.status_values[0];
  if (!isValidStatus(def, status)) throw fail(`invalid status: ${status}`, "bad_status", 400);
  const dataJson = fields.data && typeof fields.data === "object" ? JSON.stringify(fields.data) : "{}";
  const r = await tdb.execute({
    sql: `INSERT INTO tasks_items (board_id, bot_id, status, priority, title, data_json, action_needed)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      boardId,
      fields.bot_id ?? null,
      status,
      fields.priority != null ? Number(fields.priority) : 3,
      String(fields.title ?? ""),
      dataJson,
      fields.action_needed ?? null,
    ],
  });
  const id = Number(r.lastInsertRowid);
  await recordMutation(tdb, { itemId: id, verb: "create", actor, detail: {} });
  return { id };
}

async function briefingSnapshotImpl(tdb) {
  const statusRows = (await tdb.execute({
    sql: "SELECT status, COUNT(*) AS n FROM tasks_items WHERE board_id IS NULL AND archived_at IS NULL GROUP BY status",
    args: [],
  })).rows || [];
  const dueSoon = (await tdb.execute({
    sql: "SELECT COUNT(*) AS n FROM tasks_items WHERE board_id IS NULL AND archived_at IS NULL AND due_date IS NOT NULL AND due_date <= date('now', '+7 days')",
    args: [],
  })).rows[0] || { n: 0 };
  let awaiting = { n: 0 };
  try {
    awaiting = (await tdb.execute({
      sql: "SELECT COUNT(*) AS n FROM board_results WHERE status='recorded'",
      args: [],
    })).rows[0] || { n: 0 };
  } catch { /* board_results absent on a pre-0004 store — snapshot degrades */ }
  return {
    by_status: Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)])),
    due_within_7_days: Number(dueSoon.n),
    awaiting_review: Number(awaiting.n),
  };
}

export function createBoardMcpServer(options = {}) {
  const tdb = options.tdb || createDbClient(TASKS_DB);
  const cdb = options.cdb || createDbClient();

  const server = new McpServer(
    { name: "crow-board", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined,
  );

  tool(server, "board_list_boards",
    "List all boards (the project cards board(s) plus every slug/tracker board) with per-status item counts.",
    { include_archived: z.boolean().optional().describe("Include archived items in the counts") },
    async ({ include_archived }) => ({ boards: await listBoardsImpl(tdb, cdb, !!include_archived) }));

  tool(server, "board_list_items",
    "List cards or tracker items with optional filters. Pass board_id or slug to list a tracker board's items; otherwise lists the project cards board (optionally scoped by project_id). Excludes archived items unless include_archived is true.",
    {
      project_id: z.number().int().optional(),
      board_id: z.number().int().optional(),
      slug: z.string().optional(),
      status: z.string().optional(),
      tag: z.string().optional(),
      search: z.string().optional(),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    (args) => listItemsImpl(tdb, args || {}));

  tool(server, "board_get_item",
    "Get one card or tracker item by id, including its current plan head, latest results (with plan version + superseded flag), and the last 10 mutations.",
    { id: z.number().int() },
    ({ id }) => getItemFullImpl(tdb, id));

  tool(server, "board_create_item",
    "Create a card (default) or a tracker item (pass board_id or slug). parent_id creates a subtask that inherits the parent card's project.",
    {
      title: z.string().min(1),
      description: z.string().optional(),
      status: z.string().optional(),
      priority: z.number().int().optional(),
      due_date: z.string().optional(),
      phase: z.string().optional(),
      owner: z.string().optional(),
      tags: z.string().optional(),
      project_id: z.number().int().optional(),
      parent_id: z.number().int().optional(),
      autonomy: z.enum(["gated", "auto"]).optional(),
      board_id: z.number().int().optional(),
      slug: z.string().optional(),
      bot_id: z.string().optional(),
      action_needed: z.string().optional(),
      data: z.record(z.any()).optional(),
    },
    async (fields, extra) => {
      const actor = resolveActor(extra);
      if (fields.board_id != null || fields.slug) {
        let boardId = fields.board_id != null ? Number(fields.board_id) : null;
        if (boardId == null) {
          const def = await resolveSlugBoardDef(tdb, fields.slug);
          if (!def) throw fail(`tracker not found: ${fields.slug}`, "not_found", 404);
          boardId = def.id;
        }
        return createItemImpl(tdb, boardId, fields, actor);
      }
      return createCard(tdb, fields, actor);
    });

  tool(server, "board_update_item",
    "Edit fields on a card or tracker item (dispatches by id across both kinds).",
    {
      id: z.number().int(),
      title: z.string().optional(),
      description: z.string().optional(),
      due_date: z.string().optional(),
      phase: z.string().optional(),
      owner: z.string().optional(),
      tags: z.string().optional(),
      priority: z.number().int().optional(),
      autonomy: z.enum(["gated", "auto"]).optional(),
      action_needed: z.string().optional(),
      next_followup_date: z.string().optional(),
      processing_lease: z.string().nullable().optional(),
      processing_lease_status: z.string().nullable().optional(),
      data: z.record(z.any()).optional(),
    },
    async ({ id, ...fields }, extra) => dispatchUpdate(tdb, id, fields, resolveActor(extra)));

  tool(server, "board_move_item",
    "Move a card or tracker item to a new status (def-validated; stamps completed_at on terminal transitions).",
    { id: z.number().int(), status: z.string() },
    async ({ id, status }, extra) => dispatchMove(tdb, cdb, id, status, resolveActor(extra)));

  tool(server, "board_archive_item",
    "Archive a card or tracker item (present-but-hidden; refuses a locked card).",
    { id: z.number().int() },
    async ({ id }, extra) => dispatchArchive(tdb, cdb, id, resolveActor(extra)));

  tool(server, "board_unarchive_item",
    "Unarchive a previously archived card or tracker item.",
    { id: z.number().int() },
    async ({ id }, extra) => dispatchUnarchive(tdb, id, resolveActor(extra)));

  tool(server, "board_get_plan",
    "Get an item's current plan (latest approved, else latest draft) plus every version.",
    { item_id: z.number().int() },
    async ({ item_id }) => ({ current: await getCurrentPlan(tdb, item_id), versions: await listPlans(tdb, item_id) }));

  tool(server, "board_save_plan",
    "Save a new plan draft version for an item.",
    { item_id: z.number().int(), body_md: z.string().min(1) },
    async ({ item_id, body_md }, extra) => savePlan(tdb, item_id, body_md, resolveActor(extra)));

  tool(server, "board_approve_plan",
    "Approve a draft plan version (supersedes the item's previously-approved version).",
    { item_id: z.number().int(), version: z.number().int(), via: z.enum(["chat", "dashboard"]).optional() },
    async ({ item_id, version, via }, extra) => approvePlan(tdb, item_id, version, resolveActor(extra), via || "chat"));

  tool(server, "board_report_result",
    "Report an explicit outcome for an item (success/failure/partial) — the bot's terminal-state signal, never inferred from a process exit. 409s on a terminal-status or archived item.",
    {
      item_id: z.number().int(),
      outcome: z.enum(["success", "failure", "partial"]),
      summary_md: z.string().optional(),
      plan_id: z.number().int().optional(),
    },
    async ({ item_id, outcome, summary_md, plan_id }, extra) =>
      reportResult(tdb, cdb, item_id, { outcome, summaryMd: summary_md, planId: plan_id }, resolveActor(extra)));

  tool(server, "board_decide_result",
    "Approve or reject a recorded result. Never moves the card.",
    {
      item_id: z.number().int(),
      result_id: z.number().int(),
      decision: z.enum(["approved", "rejected"]),
      via: z.enum(["chat", "dashboard"]).optional(),
    },
    async ({ item_id, result_id, decision, via }, extra) =>
      decideResult(tdb, item_id, result_id, decision, resolveActor(extra), via || "chat"));

  tool(server, "board_store_briefing",
    "Persist a briefing snapshot. UNIQUE on briefing_date — re-runs for the same day overwrite the prior content.",
    { briefing_date: z.string(), content: z.string().min(1).max(100000) },
    async ({ briefing_date, content }) => {
      await tdb.execute({
        sql: `INSERT INTO tasks_briefings (briefing_date, content) VALUES (?, ?)
              ON CONFLICT(briefing_date) DO UPDATE SET content = excluded.content, created_at = datetime('now')`,
        args: [briefing_date, content],
      });
      const row = (await tdb.execute({
        sql: "SELECT id, briefing_date, content, created_at FROM tasks_briefings WHERE briefing_date = ?",
        args: [briefing_date],
      })).rows[0];
      return row;
    });

  tool(server, "board_list_briefings",
    "List stored briefings newest-first (id, briefing_date, created_at, and a content preview).",
    { limit: z.number().int().min(1).max(365).optional() },
    async ({ limit }) => {
      const rows = (await tdb.execute({
        sql: `SELECT id, briefing_date, substr(content, 1, 200) AS preview, created_at
              FROM tasks_briefings ORDER BY briefing_date DESC LIMIT ?`,
        args: [limit || 30],
      })).rows || [];
      return { count: rows.length, items: rows.map((r) => ({ ...r, id: Number(r.id) })) };
    });

  tool(server, "board_get_briefing",
    "Fetch one stored briefing by briefing_date, or the most recent one when briefing_date is omitted.",
    { briefing_date: z.string().optional() },
    async ({ briefing_date }) => {
      const row = (await tdb.execute(
        briefing_date
          ? { sql: "SELECT id, briefing_date, content, created_at FROM tasks_briefings WHERE briefing_date = ?", args: [briefing_date] }
          : { sql: "SELECT id, briefing_date, content, created_at FROM tasks_briefings ORDER BY briefing_date DESC LIMIT 1", args: [] },
      )).rows[0];
      if (!row) throw fail("briefing not found", "not_found", 404);
      return { ...row, id: Number(row.id) };
    });

  tool(server, "board_briefing_snapshot",
    "Compute a summary of current board state without storing it: card counts by status, due-within-7-days count, and awaiting-review results count.",
    {},
    () => briefingSnapshotImpl(tdb));

  return server;
}
