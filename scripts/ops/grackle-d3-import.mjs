#!/usr/bin/env node
/**
 * grackle-d3-import — the one-shot D3 importer: grackle's Crow data into
 * crow main. Spec: docs/superpowers/specs/2026-10-02-grackle-decommission-
 * d3-d5-design.md §4 (+ §9 Kevin's decisions). Runbook: the plan's W3.
 *
 *   node scripts/ops/grackle-d3-import.mjs \
 *     --source <grackle-backup.db> --target <crow.db> \
 *     --mode plan|rehearse|apply|emit-only \
 *     --report <report.json> [--extract <grackle-d3-extract.db>] \
 *     [--expect-sha <sha256-of-source>] [--backup-ok <cold-backup-path>] \
 *     [--peer-max-memory-id <peer>=<n> ...] [--peer-max-id <table>:<peer>=<n> ...] \
 *     [--import-media] [--import-data-dashboard] [--keep-scratch]
 *
 * Modes:
 *   plan      reads both DBs (the source as bytes, the target read-only),
 *             runs the import against an IN-MEMORY copy of the target and
 *             writes only the report.
 *   rehearse  copies the target into os.tmpdir(), applies phases A and B to
 *             the copy, runs integrity_check / foreign_key_check / FTS
 *             checks, and diffs the counts against an in-memory plan. The
 *             real --target is never opened for writing.
 *   apply     the live run. Refuses (exit 2, nothing written) unless every
 *             preflight holds — see preflightApply().
 *   emit-only re-queues phase B from an existing report. Idempotent: an
 *             outbox row already holding the same (table, key, lamport) is
 *             never queued twice.
 *
 * Phase A is ONE transaction on one better-sqlite3 handle: a crash, a kill
 * or a thrown error leaves the target unchanged. Phase B queues the synced
 * rows through emitOrQueue(null, …) into the #292 outbox; the gateway's
 * drain delivers them on its next boot.
 *
 * Exit codes: 0 ok · 1 error · 2 refused (preflight) · 64 usage.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, statSync, renameSync, rmSync, mkdtempSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCHEMA_GENERATION } from "../../servers/shared/schema-version.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ================================================================ table map */

/**
 * Bundle-owned table groups. A group is imported only when selected; when a
 * selected group's tables are missing from the target they are created by
 * the BUNDLE'S OWN init function (never hand DDL), inside phase A.
 */
export const BUNDLE_GROUPS = {
  ramble: { module: "bundles/ramble/server/init-tables.js", fn: "initRambleTables", always: true },
  kb: { module: "bundles/knowledge-base/server/init-tables.js", fn: "initKbTables", always: true },
  media: { module: "bundles/media/server/init-tables.js", fn: "initMediaTables", flag: "importMedia" },
  "data-dashboard": {
    module: "bundles/data-dashboard/server/init-tables.js", fn: "initDataDashboardTables", flag: "importDataDashboard",
  },
};

const fk = (parent, onMissing = "null") => ({ parent, onMissing });

/**
 * Import specs, in dependency order. Fields:
 *   pk        "id" (integer key, remappable) or an array of natural-key columns
 *   idPolicy  "keep-if-free": keep the source id when the target has no row
 *             there, else allocate a fresh id above every known id.
 *             "fresh-above-peers": the id-keyed SYNCED tables (memories,
 *             research_notes, glasses_note_sessions). Sync applies them by
 *             numeric id, so every inserted row gets a fresh id above the
 *             target, the source AND every --peer-max-id: the phase-B
 *             range gate is then open by construction (a kept low id would
 *             land inside a peer's range and close it). Spec §4.2 deviation,
 *             recorded in the stream report.
 *   dedupe    alternatives [{cols, strict}] tried in order AFTER fk remap; a
 *             match maps the source row onto the existing target row (never
 *             updated). strict: skip the alternative when any value is null.
 *   fks       {col: {parent, onMissing: "null"|"skip"}}
 *   where     source-row filter; rows it rejects go to the extract
 *   transform (row, ctx) => row | null (null = filter to the extract)
 *   emit      "id" (id-keyed sync, peer-range gated) | "natural"
 */
export const IMPORT_SPECS = [
  // ---- projects first: everything else points at them
  {
    table: "project_spaces", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["uuid"], strict: true }, { cols: ["slug", "workspace_dir"] }],
    fks: { owner_contact_id: fk("contacts") },
    onInsert: "renameClashingSlug",
  },
  {
    table: "project_members", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["uuid"], strict: true }, { cols: ["project_id", "contact_id", "role"], strict: true }],
    fks: { project_id: fk("project_spaces", "skip"), contact_id: fk("contacts"), granted_by_contact_id: fk("contacts") },
  },
  {
    table: "project_audit_log", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["project_id", "actor_type", "actor_id", "action", "target", "created_at"] }],
    fks: { project_id: fk("project_spaces", "skip") },
  },
  {
    table: "research_sources", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["uuid"], strict: true }, { cols: ["project_id", "title", "url", "created_at"] }],
    fks: { project_id: fk("project_spaces"), backend_id: fk("data_backends") },
  },
  { table: "source_embeddings", group: "core", pk: ["source_id"], fks: { source_id: fk("research_sources", "skip") } },
  {
    table: "research_notes", group: "core", pk: "id", idPolicy: "fresh-above-peers",
    dedupe: [{ cols: ["uuid"], strict: true }, { cols: ["content", "created_at"] }],
    fks: { project_id: fk("project_spaces"), source_id: fk("research_sources") },
    emit: "id",
  },
  { table: "note_embeddings", group: "core", pk: ["note_id"], fks: { note_id: fk("research_notes", "skip") } },
  {
    table: "glasses_note_sessions", group: "core", pk: "id", idPolicy: "fresh-above-peers",
    dedupe: [{ cols: ["device_id", "started_at"] }],
    fks: { project_id: fk("project_spaces"), note_id: fk("research_notes") },
    emit: "id",
  },
  {
    table: "memories", group: "core", pk: "id", idPolicy: "fresh-above-peers",
    dedupe: [{ cols: ["content"] }],
    fks: { project_id: fk("project_spaces") },
    emit: "id",
  },
  { table: "memory_embeddings_blob", group: "core", pk: ["memory_id"], fks: { memory_id: fk("memories", "skip") } },
  { table: "blog_posts", group: "core", pk: "id", idPolicy: "keep-if-free", dedupe: [{ cols: ["slug"] }] },
  { table: "blog_post_embeddings", group: "core", pk: ["post_id"], fks: { post_id: fk("blog_posts", "skip") } },
  {
    table: "chat_conversations", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["title", "provider", "model", "created_at"] }],
  },
  {
    table: "chat_messages", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["conversation_id", "role", "created_at", "content"] }],
    fks: { conversation_id: fk("chat_conversations", "skip") },
  },
  {
    table: "glasses_photos", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["device_id", "captured_at", "minio_key"] }],
  },
  {
    table: "storage_files", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["s3_key"] }],
    fks: { project_id: fk("project_spaces") },
  },
  {
    // Two bridges must never run one bot: always imported disabled (spec §4.2).
    table: "pi_bot_defs", group: "core", pk: ["bot_id"],
    fks: { project_id: fk("project_spaces") },
    transform: (row) => ({ ...row, enabled: 0 }),
  },

  // ---- ramble: natural keys, insert-or-ignore, crow's row always wins
  { table: "ramble_cells", group: "ramble", pk: ["cell"], emit: "natural" },
  { table: "ramble_wallet", group: "ramble", pk: ["kind", "key"], emit: "natural" },
  { table: "ramble_credits", group: "ramble", pk: ["kind", "key"] },
  { table: "ramble_nest_claims", group: "ramble", pk: ["cell", "week"] },

  // ---- knowledge base
  { table: "kb_collections", group: "kb", pk: "id", idPolicy: "keep-if-free", dedupe: [{ cols: ["slug"] }] },
  {
    table: "kb_categories", group: "kb", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["collection_id", "slug"] }], fks: { collection_id: fk("kb_collections", "skip") },
  },
  {
    table: "kb_category_names", group: "kb", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["category_id", "language"] }], fks: { category_id: fk("kb_categories", "skip") },
  },
  {
    table: "kb_articles", group: "kb", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["pair_id", "language"] }, { cols: ["collection_id", "slug", "language"] }],
    fks: { collection_id: fk("kb_collections", "skip"), category_id: fk("kb_categories") },
  },
  {
    table: "kb_resources", group: "kb", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["article_id", "name"] }], fks: { article_id: fk("kb_articles", "skip") },
  },
  {
    table: "kb_review_log", group: "kb", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["article_id", "resource_id", "action", "created_at"] }],
    fks: { article_id: fk("kb_articles"), resource_id: fk("kb_resources") },
  },

  // ---- media (only with --import-media). The rolling article feed is NOT
  // imported (map: 26k rows, mostly dead references) — it goes to the extract.
  { table: "media_sources", group: "media", pk: "id", idPolicy: "keep-if-free", dedupe: [{ cols: ["url"] }] },
  {
    table: "media_briefings", group: "media", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["title", "created_at"] }],
  },
  {
    table: "media_playlists", group: "media", pk: "id", idPolicy: "keep-if-free",
    where: (row) => !row.auto_generated, // manual playlists only
    dedupe: [{ cols: ["name", "created_at"] }],
  },
  {
    table: "media_playlist_items", group: "media", pk: "id", idPolicy: "keep-if-free",
    fks: { playlist_id: fk("media_playlists", "skip") },
    transform: "mediaPlaylistItem",
    dedupe: [{ cols: ["playlist_id", "item_type", "item_id"] }],
  },
  {
    table: "media_digest_preferences", group: "media", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["created_at"] }],
  },

  // ---- data dashboard (only with --import-data-dashboard). Ids are kept when
  // free: blog figure names embed section ids (map, 09-24).
  {
    table: "data_case_studies", group: "data-dashboard", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["title", "created_at"] }],
    fks: { project_id: fk("project_spaces"), blog_post_id: fk("blog_posts") },
    warnOnRemap: "figure names embed case-study/section ids",
  },
  {
    table: "data_case_study_sections", group: "data-dashboard", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["case_study_id", "sort_order", "title", "created_at"] }],
    fks: { case_study_id: fk("data_case_studies", "skip") },
    warnOnRemap: "figure names embed case-study/section ids",
  },
];

/** Tables read for lookups only (never imported): source id → natural key → target id. */
const LOOKUP_REMAPS = { contacts: "crow_id" };

/** Not imported; listed in the report with counts (and archived in the extract). */
export const SKIP_REASONS = {
  notifications: "noise",
  oauth_clients: "bound to grackle's issuer",
  oauth_tokens: "bound to grackle's issuer",
  mcp_sessions: "per-host session state",
  sync_conflicts: "grackle-local sync bookkeeping",
  audit_log: "grackle-local audit trail",
  cross_host_calls: "grackle-local bookkeeping",
  contacts: "already synced",
  messages: "already synced",
  crow_context: "already synced",
  providers: "already synced",
  data_backends: "keep crow's rows (map: grackle's point at ~/spring-2026)",
  crow_instances: "grackle is revoked; peer rows are per-instance",
  bot_sessions: "runtime state of grackle's bridge",
  dashboard_settings: "handled key-by-key (see report.settings)",
  dashboard_settings_overrides: "handled key-by-key (see report.settings)",
  ramble_marks: "already synced (SYNCED_TABLES)",
  ramble_settings: "already synced (SYNCED_TABLES)",
  ramble_blocks: "already synced (SYNCED_TABLES)",
  ramble_eggs: "already synced (SYNCED_TABLES)",
  ramble_pet: "already synced (SYNCED_TABLES)",
  ramble_trades: "already synced (SYNCED_TABLES)",
  ramble_tombstones: "grackle's outbound relay work items",
  ramble_outbox: "grackle's outbound delivery queue",
};

/** Never written to the extract: credentials / sync internals (the archived full backup keeps them). */
const NO_EXTRACT = new Set([
  "oauth_clients", "oauth_tokens", "mcp_sessions", "dashboard_pending_2fa", "push_subscriptions",
  "crow_instances", "sync_state", "sync_outbox", "rate_limit_buckets", "sqlite_sequence",
]);

/** Unowned / archive-only (spec §4.2, Kevin §9): extract only, NEVER created in the target. */
export const ARCHIVE_ONLY = [/^pir_requests$/, /^capstone_/, /^pipeline_runs$/, /^tax_/, /^crowclaw_/];

/** Settings: blog settings move to crow (Kevin, 09-22) — grackle wins. */
const SETTINGS_UPSERT = /^blog_/;
const SETTINGS_INSERT_IF_ABSENT = new Set(["tts_voice", "meta_glasses_devices"]);
const OVERRIDE_KEYS = { meta_glasses_default_project_id: "project_spaces" };

/** Columns never copied: per-instance lamport counters (phase B stamps the emitted rows). */
const NEVER_COPY = new Set(["lamport_ts"]);

/* ================================================================== helpers */

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

/**
 * Open a SQLite file from its bytes, in memory. No -wal/-shm is ever created
 * next to the file, and the sha of `buf` is exactly what was read. The WAL
 * flag in the header (bytes 18/19) is reset so the image opens in memory.
 */
export function openBytes(buf) {
  const copy = Buffer.from(buf);
  if (copy.length >= 20) { copy[18] = 1; copy[19] = 1; }
  return new Database(copy);
}

/**
 * The target as an in-memory snapshot. A target with a live -wal is read
 * through a read-only handle (so committed WAL pages are included);
 * otherwise straight from its bytes.
 */
export function snapshotTarget(path) {
  const wal = `${path}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    const ro = new Database(path, { readonly: true, fileMustExist: true });
    try { return openBytes(ro.serialize()); } finally { ro.close(); }
  }
  return openBytes(readFileSync(path));
}

/** A libsql-shaped client over one better-sqlite3 handle (bundle inits + emitOrQueue). */
export function libsqlAdapter(raw) {
  const one = (sql, args) => {
    const stmt = raw.prepare(sql);
    const a = args == null ? [] : Array.isArray(args) ? args : [args];
    if (stmt.reader) {
      const rows = stmt.all(...a);
      return { rows, columns: rows.length ? Object.keys(rows[0]) : [], rowsAffected: 0, lastInsertRowid: 0 };
    }
    const info = stmt.run(...a);
    return { rows: [], columns: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
  };
  return {
    async execute(arg) { return typeof arg === "string" ? one(arg, []) : one(arg.sql, arg.args); },
    async batch(stmts) {
      const txn = raw.transaction((list) => list.map((s) => (typeof s === "string" ? one(s, []) : one(s.sql, s.args))));
      return txn(stmts);
    },
    async executeMultiple(sql) { raw.exec(sql); return []; },
    close() {},
  };
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name);
}

function isShadowOrVirtual(db, name) {
  if (name === "sqlite_sequence" || name.startsWith("sqlite_")) return true;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name);
  if (row?.sql && /CREATE VIRTUAL TABLE/i.test(row.sql)) return true;
  // FTS5 shadow tables: <fts>_data/_idx/_docsize/_config/_content
  const m = name.match(/^(.*)_(data|idx|docsize|config|content)$/);
  if (m) {
    const base = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(m[1]);
    if (base?.sql && /CREATE VIRTUAL TABLE/i.test(base.sql)) return true;
  }
  return false;
}

export function userTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((r) => r.name).filter((n) => !isShadowOrVirtual(db, n));
}

export function countAll(db) {
  const out = {};
  for (const t of userTables(db)) out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n;
  return out;
}

function walletBalances(db) {
  if (!tableExists(db, "ramble_wallet")) return {};
  const out = {};
  for (const r of db.prepare("SELECT kind, SUM(delta) AS bal FROM ramble_wallet GROUP BY kind").all()) out[r.kind] = r.bal;
  return out;
}

function ftsTables(db) {
  const out = [];
  for (const r of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all()) {
    const m = r.sql.match(/content\s*=\s*['"]?(\w+)['"]?/i);
    if (m && /fts5/i.test(r.sql)) out.push({ fts: r.name, content: m[1] });
  }
  return out;
}

/* ============================================================ classification */

function groupSelected(group, opts) {
  if (group === "core") return true;
  const g = BUNDLE_GROUPS[group];
  return g.always || !!opts[g.flag];
}

/**
 * Classify every source table. Returns {imports: spec[], skipped: {t:{reason,count}},
 * extract: {t: reason}} — every source user table lands in exactly one bucket.
 */
export function classify(src, tgt, opts) {
  const specByTable = new Map(IMPORT_SPECS.map((s) => [s.table, s]));
  const imports = [];
  const skipped = {};
  const extract = {};
  for (const t of userTables(src)) {
    const n = src.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n;
    const spec = specByTable.get(t);
    if (spec) {
      if (groupSelected(spec.group, opts)) { imports.push(spec); continue; }
      extract[t] = `bundle '${spec.group}' not selected for import`;
      continue;
    }
    if (ARCHIVE_ONLY.some((re) => re.test(t))) { extract[t] = "archive-only (unowned or sensitive; spec §4.2)"; continue; }
    if (SKIP_REASONS[t]) {
      skipped[t] = { reason: SKIP_REASONS[t], count: n };
      if (!NO_EXTRACT.has(t) && !t.startsWith("dashboard_settings")) extract[t] = `skipped: ${SKIP_REASONS[t]}`;
      continue;
    }
    if (NO_EXTRACT.has(t)) { skipped[t] = { reason: "credential / sync internals (kept only in the archived full backup)", count: n }; continue; }
    if (tableExists(tgt, t)) {
      skipped[t] = { reason: "unclassified (exists on crow; not in the D3 map)", count: n };
      extract[t] = "unclassified";
      continue;
    }
    extract[t] = "unowned / not on crow";
  }
  // keep spec order
  imports.sort((a, b) => IMPORT_SPECS.indexOf(a) - IMPORT_SPECS.indexOf(b));
  return { imports, skipped, extract };
}

/* ================================================================== phase A */

class Remaps {
  constructor() { this.maps = new Map(); }
  for(table) { if (!this.maps.has(table)) this.maps.set(table, new Map()); return this.maps.get(table); }
  has(table) { return this.maps.has(table); }
  get(table, srcId) { return this.maps.get(table)?.get(srcId); }
}

function buildLookupRemaps(src, tgt, remaps) {
  for (const [table, natural] of Object.entries(LOOKUP_REMAPS)) {
    if (!tableExists(src, table) || !tableExists(tgt, table)) continue;
    const m = remaps.for(table);
    const find = tgt.prepare(`SELECT id FROM ${q(table)} WHERE ${q(natural)} = ? LIMIT 1`);
    for (const r of src.prepare(`SELECT id, ${q(natural)} AS k FROM ${q(table)}`).all()) {
      if (r.k == null) continue;
      const hit = find.get(r.k);
      if (hit) m.set(r.id, hit.id);
    }
  }
}

function maxId(db, table) {
  const a = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(table)}`).get().m;
  let b = 0;
  if (tableExists(db, "sqlite_sequence")) {
    b = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM sqlite_sequence WHERE name = ?").get(table)?.m ?? 0;
  }
  return Math.max(Number(a), Number(b));
}

const TRANSFORMS = {
  mediaPlaylistItem(row, ctx) {
    if (row.item_type === "article") return { drop: "article items point at the rolling feed (not imported)" };
    if (row.item_type === "briefing") {
      const t = ctx.remaps.get("media_briefings", row.item_id);
      if (t === undefined) return { drop: "briefing not imported" };
      return { row: { ...row, item_id: t } };
    }
    ctx.warn(`media_playlist_items id=${row.id}: unknown item_type '${row.item_type}' kept with its raw item_id`);
    return { row };
  },
};

function applyTransform(spec, row, ctx) {
  if (!spec.transform) return { row };
  if (typeof spec.transform === "function") return { row: spec.transform(row, ctx) };
  return TRANSFORMS[spec.transform](row, ctx);
}

/**
 * Import one table. Synchronous; runs inside phase A's transaction.
 */
function importTable(spec, src, tgt, ctx) {
  const { table } = spec;
  const stat = {
    group: spec.group, classification: "import", source_rows: 0, inserted: 0, matched_existing: 0,
    filtered: 0, fk_skipped: 0, kept_ids: 0, remapped_ids: 0,
  };
  ctx.perTable[table] = stat;
  if (!tableExists(src, table)) { stat.note = "absent in source"; return; }
  if (!tableExists(tgt, table)) throw new Error(`target lacks table ${table} (group ${spec.group})`);

  const srcCols = columnsOf(src, table);
  const tgtCols = new Set(columnsOf(tgt, table));
  const cols = srcCols.filter((c) => tgtCols.has(c) && !NEVER_COPY.has(c));
  const sourceOnly = srcCols.filter((c) => !tgtCols.has(c));
  if (sourceOnly.length) ctx.sourceOnly[table] = { columns: sourceOnly, rows_with_values: 0 };

  const isIntPk = spec.pk === "id";
  const naturalPk = isIntPk ? null : spec.pk;
  const remap = isIntPk ? ctx.remaps.for(table) : null;
  let nextFresh = 0;
  if (isIntPk) {
    const srcMax = src.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(table)}`).get().m;
    const peerMax = Math.max(0, ...Object.values(ctx.peerMax[table] || {}));
    nextFresh = Math.max(maxId(tgt, table), Number(srcMax), peerMax) + 1;
  }

  const insertCols = cols;
  const insertStmt = tgt.prepare(
    `INSERT ${naturalPk ? "OR IGNORE " : ""}INTO ${q(table)} (${insertCols.map(q).join(", ")}) VALUES (${insertCols.map(() => "?").join(", ")})`,
  );
  const existsById = isIntPk ? tgt.prepare(`SELECT 1 FROM ${q(table)} WHERE id = ?`) : null;
  const dedupeStmts = (spec.dedupe || []).map((d) => ({
    ...d,
    stmt: tgt.prepare(`SELECT ${isIntPk ? "id" : "1 AS id"} FROM ${q(table)} WHERE ${d.cols.map((c) => `${q(c)} IS ?`).join(" AND ")} LIMIT 1`),
  }));
  const naturalExists = naturalPk
    ? tgt.prepare(`SELECT 1 FROM ${q(table)} WHERE ${naturalPk.map((c) => `${q(c)} IS ?`).join(" AND ")}`)
    : null;

  const rows = src.prepare(`SELECT * FROM ${q(table)}${isIntPk ? " ORDER BY id" : ""}`).all();
  stat.source_rows = rows.length;
  for (const original of rows) {
    if (sourceOnly.length && sourceOnly.some((c) => original[c] != null)) ctx.sourceOnly[table].rows_with_values++;
    if (spec.where && !spec.where(original)) { stat.filtered++; ctx.notImported(table, original, "filtered"); continue; }

    // fk remap
    let row = { ...original };
    let skip = null;
    for (const [col, rule] of Object.entries(spec.fks || {})) {
      const v = row[col];
      if (v == null) continue;
      const mapped = ctx.remaps.get(rule.parent, v);
      if (mapped !== undefined) { row[col] = mapped; continue; }
      if (rule.onMissing === "skip") { skip = `${col}=${v} has no imported ${rule.parent} row`; break; }
      row[col] = null;
    }
    if (skip) { stat.fk_skipped++; ctx.notImported(table, original, skip); continue; }

    const t = applyTransform(spec, row, ctx);
    if (t.drop) { stat.filtered++; ctx.notImported(table, original, t.drop); continue; }
    row = t.row;

    // dedupe onto an existing target row
    let matched;
    for (const d of dedupeStmts) {
      const vals = d.cols.map((c) => row[c] ?? null);
      if (d.strict && vals.some((v) => v == null)) continue;
      const hit = d.stmt.get(...vals);
      if (hit) { matched = hit.id; break; }
    }
    if (naturalPk && naturalExists.get(...naturalPk.map((c) => row[c] ?? null))) matched = true;
    if (matched !== undefined) {
      stat.matched_existing++;
      if (isIntPk) remap.set(original.id, matched);
      continue;
    }

    if (isIntPk) {
      let id = original.id;
      if (spec.idPolicy === "fresh-above-peers" || existsById.get(id)) {
        id = nextFresh++;
        stat.remapped_ids++;
        if (spec.warnOnRemap) ctx.warn(`${table} id ${original.id} → ${id}: ${spec.warnOnRemap}`);
      } else {
        stat.kept_ids++;
      }
      row.id = id;
      if (spec.onInsert === "renameClashingSlug") row = renameClashingSlug(tgt, row, ctx);
      remap.set(original.id, id);
      ctx.inserted(table, { id });
    } else {
      ctx.inserted(table, Object.fromEntries(naturalPk.map((c) => [c, row[c]])));
    }
    const info = insertStmt.run(...insertCols.map((c) => row[c] ?? null));
    if (info.changes) stat.inserted++;
    if (table === "ramble_wallet" && info.changes) {
      ctx.wallet.inserted_sum[row.kind] = (ctx.wallet.inserted_sum[row.kind] || 0) + Number(row.delta || 0);
    }
  }
}

function renameClashingSlug(tgt, row, ctx) {
  const taken = tgt.prepare("SELECT 1 FROM project_spaces WHERE slug = ?");
  if (!taken.get(row.slug)) return row;
  let slug = `${row.slug}-grackle`;
  for (let i = 2; taken.get(slug); i++) slug = `${row.slug}-grackle-${i}`;
  ctx.warn(`project_spaces id ${row.id}: slug '${row.slug}' is taken on crow by a different project → '${slug}'`);
  return { ...row, slug };
}

function importSettings(src, tgt, ctx) {
  const out = { upserted: [], inserted: [], kept_crow: [], skipped_keys: 0, overrides: [] };
  ctx.settings = out;
  if (tableExists(src, "dashboard_settings")) {
    const get = tgt.prepare("SELECT value FROM dashboard_settings WHERE key = ?");
    const upsert = tgt.prepare(`INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    const insert = tgt.prepare(`INSERT OR IGNORE INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
    for (const r of src.prepare("SELECT key, value FROM dashboard_settings ORDER BY key").all()) {
      const cur = get.get(r.key);
      if (SETTINGS_UPSERT.test(r.key)) {
        if (cur && cur.value === r.value) { out.kept_crow.push(r.key); continue; }
        upsert.run(r.key, r.value);
        out.upserted.push({ key: r.key, had_crow_value: !!cur, length: String(r.value ?? "").length });
      } else if (SETTINGS_INSERT_IF_ABSENT.has(r.key)) {
        if (cur) { out.kept_crow.push(r.key); continue; }
        insert.run(r.key, r.value);
        out.inserted.push(r.key);
      } else {
        out.skipped_keys++;
      }
    }
  }
  if (tableExists(src, "dashboard_settings_overrides") && ctx.sourceInstanceId && ctx.targetInstanceId) {
    const ins = tgt.prepare(`INSERT OR IGNORE INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))`);
    for (const [key, parent] of Object.entries(OVERRIDE_KEYS)) {
      const r = src.prepare("SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?")
        .get(key, ctx.sourceInstanceId);
      if (!r) continue;
      const mapped = ctx.remaps.get(parent, Number(r.value));
      const value = mapped !== undefined ? String(mapped) : r.value;
      const info = ins.run(key, ctx.targetInstanceId, value);
      out.overrides.push({ key, value, inserted: info.changes > 0 });
    }
  }
}

async function ensureBundleTables(imports, tgt, adapter, ctx) {
  const created = [];
  const groups = [...new Set(imports.map((s) => s.group))].filter((g) => g !== "core");
  for (const g of groups) {
    const missing = imports.filter((s) => s.group === g && !tableExists(tgt, s.table)).map((s) => s.table);
    if (!missing.length) continue;
    const def = BUNDLE_GROUPS[g];
    const mod = await import(pathToFileURL(join(REPO, def.module)).href);
    await mod[def.fn](adapter);
    created.push({ group: g, via: `${def.module}#${def.fn}`, missing_before: missing });
  }
  ctx.bundleTablesCreated = created;
}

/**
 * Phase A on `tgt` (a better-sqlite3 handle). ONE transaction; any throw
 * rolls the whole thing back. `failAfterTables` is a test seam.
 */
export async function phaseA(src, tgt, opts, ctx) {
  const adapter = libsqlAdapter(tgt);
  tgt.exec("BEGIN IMMEDIATE");
  try {
    const { imports } = ctx.classification;
    await ensureBundleTables(imports, tgt, adapter, ctx);
    buildLookupRemaps(src, tgt, ctx.remaps);
    let n = 0;
    for (const spec of imports) {
      if (opts.failAfterTables != null && n >= opts.failAfterTables) {
        throw new Error(`injected failure after ${n} tables (test seam)`);
      }
      importTable(spec, src, tgt, ctx);
      n++;
    }
    importSettings(src, tgt, ctx);
    tgt.exec("COMMIT");
  } catch (err) {
    if (tgt.inTransaction) tgt.exec("ROLLBACK");
    throw err;
  }
}

/* ================================================================== phase B */

const EMIT_KEY = {
  ramble_cells: ["cell"],
  ramble_wallet: ["kind", "key"],
};

function keyCols(table) { return EMIT_KEY[table] || ["id"]; }

/** Peer-range gate for id-keyed emits (spec §4.2). Returns null (open) or a reason. */
export function idGate(table, ids, peerMax) {
  if (!ids.length) return null;
  const peers = peerMax[table] || {};
  if (!Object.keys(peers).length) return "peer-id-range-unknown";
  const lowest = Math.min(...ids);
  for (const [peer, max] of Object.entries(peers)) {
    if (Number(max) >= lowest) return `peer-id-overlap (${peer} max ${max} >= lowest imported id ${lowest})`;
  }
  return null;
}

/** The list of phase-B items (status pending) from the inserted keys. */
export function planEmits(ctx) {
  const items = [];
  const gates = {};
  for (const spec of IMPORT_SPECS) {
    if (!spec.emit) continue;
    const keys = ctx.insertedKeys[spec.table] || [];
    if (!keys.length) continue;
    let gate = null;
    if (spec.emit === "id") gate = idGate(spec.table, keys.map((k) => k.id), ctx.peerMax);
    gates[spec.table] = gate ? { open: false, reason: gate } : { open: true };
    for (const key of keys) {
      items.push({ table: spec.table, key, status: gate ? "gated" : "pending", reason: gate || undefined, lamport: null });
    }
  }
  return { items, gates };
}

async function outboxHas(adapter, table, key, lamport) {
  const conds = Object.keys(key).map((c) => `json_extract(row_json, '$.${c}') IS ?`);
  const { rows } = await adapter.execute({
    sql: `SELECT 1 FROM sync_outbox WHERE table_name = ? AND lamport_ts = ? AND ${conds.join(" AND ")} LIMIT 1`,
    args: [table, lamport, ...Object.values(key)],
  });
  return rows.length > 0;
}

/**
 * Phase B: queue each pending item through emitOrQueue(null, …). Items that
 * already carry a lamport are re-queued with that lamport ONLY when the
 * outbox no longer holds (table, key, lamport) — the emit-only idempotency.
 */
export async function phaseB(tgt, emits, { emitOrQueue }) {
  const adapter = libsqlAdapter(tgt);
  const hasOutbox = tableExists(tgt, "sync_outbox");
  for (const item of emits.items) {
    if (item.status === "gated") continue;
    if (item.lamport != null && hasOutbox && (await outboxHas(adapter, item.table, item.key, item.lamport))) {
      item.status = "queued";
      continue;
    }
    const cols = Object.keys(item.key);
    const row = tgt.prepare(`SELECT * FROM ${q(item.table)} WHERE ${cols.map((c) => `${q(c)} IS ?`).join(" AND ")}`)
      .get(...Object.values(item.key));
    if (!row) { item.status = "failed"; item.reason = "row not found in target"; continue; }
    const opts = item.lamport != null ? { lamportTs: item.lamport } : {};
    const res = await emitOrQueue(null, adapter, item.table, "insert", row, opts);
    if (res && res.queued) { item.status = "queued"; item.lamport = res.lamport; item.reason = undefined; }
    else { item.status = "not-queued"; item.reason = "emitOrQueue returned null (ineligible deployment or unsyncable row)"; }
  }
}

/* ================================================================== extract */

/** Write the archive extract (every table/column/row not imported) atomically. */
export function writeExtract(path, src, ctx, meta) {
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const ex = new Database(tmp);
  ex.pragma("foreign_keys = OFF"); // an archive: parents may live in crow, not here
  try {
    ex.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
    const m = ex.prepare("INSERT INTO _meta (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(meta)) m.run(k, typeof v === "string" ? v : JSON.stringify(v));
    ex.exec(`CREATE TABLE _source_only_columns (table_name TEXT, source_pk TEXT, target_pk TEXT, column_name TEXT, value)`);
    ex.exec(`CREATE TABLE _not_imported_rows (table_name TEXT, source_pk TEXT, reason TEXT)`);
    const ddlOf = (t) => src.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t)?.sql;
    const copyRows = (t, rows) => {
      if (!rows.length) return;
      const cols = Object.keys(rows[0]);
      const ins = ex.prepare(`INSERT INTO ${q(t)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      for (const r of rows) ins.run(...cols.map((c) => r[c]));
    };
    const ensureTable = (t) => {
      if (tableExists(ex, t)) return;
      const ddl = ddlOf(t);
      ex.exec(ddl.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS "));
    };
    ex.exec("BEGIN");
    for (const t of Object.keys(ctx.classification.extract)) {
      if (NO_EXTRACT.has(t)) continue;
      ensureTable(t);
      copyRows(t, src.prepare(`SELECT * FROM ${q(t)}`).all());
    }
    const nir = ex.prepare("INSERT INTO _not_imported_rows (table_name, source_pk, reason) VALUES (?, ?, ?)");
    for (const { table, row, reason } of ctx.notImportedRows) {
      ensureTable(table);
      copyRows(table, [row]);
      nir.run(table, JSON.stringify(pkOf(table, row)), reason);
    }
    const soc = ex.prepare("INSERT INTO _source_only_columns VALUES (?, ?, ?, ?, ?)");
    for (const [table, info] of Object.entries(ctx.sourceOnly)) {
      const spec = IMPORT_SPECS.find((s) => s.table === table);
      for (const r of src.prepare(`SELECT * FROM ${q(table)}`).all()) {
        for (const c of info.columns) {
          if (r[c] == null) continue;
          const srcPk = pkOf(table, r);
          const tgtPk = spec?.pk === "id" ? ctx.remaps.get(table, r.id) ?? null : null;
          soc.run(table, JSON.stringify(srcPk), tgtPk == null ? null : JSON.stringify({ id: tgtPk }), c, r[c]);
        }
      }
    }
    ex.exec("COMMIT");
  } finally {
    ex.close();
  }
  renameSync(tmp, path);
}

function pkOf(table, row) {
  const spec = IMPORT_SPECS.find((s) => s.table === table);
  if (spec && Array.isArray(spec.pk)) return Object.fromEntries(spec.pk.map((c) => [c, row[c]]));
  if ("id" in row) return { id: row.id };
  return row;
}

/* ================================================================ preflight */

export const defaultProbes = {
  /** 'active' | 'inactive' | … | null when systemctl can't answer */
  gatewayState() {
    const r = spawnSync("systemctl", ["is-active", "crow-gateway"], { encoding: "utf8" });
    if (r.error) return null;
    return (r.stdout || "").trim() || null;
  },
  /** PIDs (other than ours) holding any of the paths; throws when lsof is unavailable. */
  holders(paths) {
    const existing = paths.filter((p) => existsSync(p));
    if (!existing.length) return [];
    const r = spawnSync("lsof", ["-t", ...existing], { encoding: "utf8" });
    if (r.error) throw new Error(`lsof unavailable: ${r.error.message}`);
    return (r.stdout || "").split(/\s+/).filter(Boolean).map(Number).filter((p) => p !== process.pid);
  },
};

const BUSY_STATES = new Set(["active", "activating", "reloading", "deactivating", "refreshing"]);

function userVersionOfBytes(buf) {
  // header offset 60, big-endian u32
  return buf.length >= 64 ? buf.readUInt32BE(60) : null;
}

/**
 * Every apply refusal, collected (the operator sees all of them at once).
 * Nothing here writes anything.
 */
export function preflightApply(opts, { srcBuf, probes }) {
  const fails = [];
  // source identity
  if (!opts.expectSha) fails.push("--expect-sha is required for apply");
  else if (sha256Buffer(srcBuf) !== String(opts.expectSha).toLowerCase()) {
    fails.push(`source sha256 mismatch: expected ${opts.expectSha}, got ${sha256Buffer(srcBuf)}`);
  }
  if (!opts.extract) fails.push("--extract is required for apply");
  // versions
  const sv = userVersionOfBytes(srcBuf);
  let tv = null;
  try {
    const t = snapshotTarget(opts.target);
    tv = t.pragma("user_version", { simple: true });
    t.close();
  } catch (err) {
    fails.push(`target unreadable: ${err.message}`);
  }
  if (sv !== tv) fails.push(`user_version mismatch: source ${sv}, target ${tv}`);
  if (sv !== SCHEMA_GENERATION) fails.push(`source user_version ${sv} != SCHEMA_GENERATION ${SCHEMA_GENERATION}`);
  if (tv !== SCHEMA_GENERATION) fails.push(`target user_version ${tv} != SCHEMA_GENERATION ${SCHEMA_GENERATION}`);
  // cold backup
  fails.push(...checkBackup(opts));
  // single writer
  const state = probes.gatewayState();
  if (state == null) fails.push("cannot determine crow-gateway state (systemctl unavailable)");
  else if (BUSY_STATES.has(state)) fails.push(`crow-gateway is ${state} — stop it first`);
  try {
    const pids = probes.holders([opts.target, `${opts.target}-wal`, `${opts.target}-shm`]);
    if (pids.length) fails.push(`target is held by other process(es): ${pids.join(", ")} — end them first (spec §5.3)`);
  } catch (err) {
    fails.push(`cannot verify target holders: ${err.message}`);
  }
  return fails;
}

function checkBackup(opts) {
  const fails = [];
  if (!opts.backupOk) return ["--backup-ok <cold-backup-path> is required for apply"];
  if (!existsSync(opts.backupOk)) return [`--backup-ok file not found: ${opts.backupOk}`];
  let bk;
  try {
    bk = openBytes(readFileSync(opts.backupOk));
    const ic = bk.pragma("integrity_check", { simple: true });
    if (ic !== "ok") fails.push(`--backup-ok failed integrity_check: ${ic}`);
  } catch (err) {
    return [`--backup-ok is not a readable SQLite database: ${err.message}`];
  }
  try {
    // it must be a backup OF THIS TARGET, taken after its last write
    const t = snapshotTarget(opts.target);
    const a = countAll(t);
    const b = countAll(bk);
    t.close();
    const diff = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    if (diff.length) fails.push(`--backup-ok does not match the target (row counts differ in: ${diff.slice(0, 8).join(", ")})`);
    const bm = statSync(opts.backupOk).mtimeMs;
    // An EMPTY -wal is not a write: a read-only open (sqlite3 -readonly, a
    // verification query) creates one with a fresh mtime.
    for (const p of [opts.target, `${opts.target}-wal`]) {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (p.endsWith("-wal") && st.size === 0) continue;
      if (st.mtimeMs > bm) fails.push(`--backup-ok is older than the target's last write (${p})`);
    }
  } catch (err) {
    fails.push(`could not compare --backup-ok with the target: ${err.message}`);
  } finally {
    bk.close();
  }
  return fails;
}

/* ===================================================================== run */

function newCtx(opts, peerMax) {
  const ctx = {
    remaps: new Remaps(),
    perTable: {},
    sourceOnly: {},
    insertedKeys: {},
    notImportedRows: [],
    warnings: [],
    wallet: { inserted_sum: {} },
    peerMax,
    settings: null,
    bundleTablesCreated: [],
  };
  ctx.warn = (m) => ctx.warnings.push(m);
  ctx.inserted = (table, key) => { (ctx.insertedKeys[table] ||= []).push(key); };
  ctx.notImported = (table, row, reason) => ctx.notImportedRows.push({ table, row, reason });
  return ctx;
}

export function parsePeerMax(opts) {
  const out = {};
  for (const v of opts.peerMaxMemoryId || []) {
    const m = String(v).match(/^([^=]+)=(\d+)$/);
    if (!m) throw new UsageError(`bad --peer-max-memory-id '${v}' (want <peer>=<n>)`);
    (out.memories ||= {})[m[1]] = Number(m[2]);
  }
  for (const v of opts.peerMaxId || []) {
    const m = String(v).match(/^([a-z_]+):([^=]+)=(\d+)$/);
    if (!m) throw new UsageError(`bad --peer-max-id '${v}' (want <table>:<peer>=<n>)`);
    (out[m[1]] ||= {})[m[2]] = Number(m[3]);
  }
  return out;
}

class UsageError extends Error {}

function sourceInstanceIdOf(src) {
  if (!tableExists(src, "crow_instances")) return null;
  try { return src.prepare("SELECT id FROM crow_instances WHERE is_home = 1 LIMIT 1").get()?.id ?? null; } catch { return null; }
}

function localInstanceIdFile() {
  const dir = process.env.CROW_DATA_DIR ? resolve(process.env.CROW_DATA_DIR) : join(process.env.HOME || "", ".crow", "data");
  const p = join(dir, "instance-id");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

function buildReport(base, ctx, extra) {
  return {
    ...base,
    per_table: ctx.perTable,
    remaps: Object.fromEntries([...ctx.remaps.maps.entries()]
      .filter(([t]) => !LOOKUP_REMAPS[t])
      .map(([t, m]) => [t, Object.fromEntries([...m.entries()].filter(([a, b]) => a !== b))])),
    extract_tables: ctx.classification.extract,
    skipped: ctx.classification.skipped,
    source_only_columns: ctx.sourceOnly,
    not_imported_rows: ctx.notImportedRows.reduce((acc, r) => { acc[r.table] = (acc[r.table] || 0) + 1; return acc; }, {}),
    bundle_tables_created: ctx.bundleTablesCreated,
    settings: ctx.settings,
    warnings: ctx.warnings,
    ...extra,
  };
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, path);
}

/** In-memory dry import: what apply would do to the target as it is now. */
async function dryRun(src, opts, peerMax) {
  const mem = snapshotTarget(opts.target);
  try {
    const ctx = newCtx(opts, peerMax);
    ctx.classification = classify(src, mem, opts);
    ctx.sourceInstanceId = sourceInstanceIdOf(src);
    ctx.targetInstanceId = localInstanceIdFile();
    const before = countAll(mem);
    const walletBefore = walletBalances(mem);
    await phaseA(src, mem, opts, ctx);
    const after = countAll(mem);
    const emits = planEmits(ctx);
    return { ctx, before, after, walletBefore, walletAfter: walletBalances(mem), emits };
  } finally {
    mem.close();
  }
}

function walletReport(before, after, insertedSum) {
  const kinds = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(insertedSum)]);
  const per_kind = {};
  for (const k of kinds) {
    per_kind[k] = {
      wallet_balance_before: before[k] ?? 0,
      wallet_balance_after: after[k] ?? 0,
      inserted_sum: insertedSum[k] ?? 0,
    };
  }
  return { per_kind };
}

async function loadEmitter(injected) {
  if (injected) return injected;
  const mod = await import(pathToFileURL(join(REPO, "servers/shared/sync-emit.js")).href);
  return { emitOrQueue: mod.emitOrQueue };
}

function rehearseChecks(db, baselineFk) {
  const integrity = db.pragma("integrity_check", { simple: true });
  const fkNow = db.prepare("PRAGMA foreign_key_check").all();
  const key = (r) => `${r.table}|${r.rowid}|${r.parent}|${r.fkid}`;
  const base = new Set(baselineFk.map(key));
  const newFk = fkNow.filter((r) => !base.has(key(r)));
  const fts = {};
  for (const { fts: f, content } of ftsTables(db)) {
    if (!tableExists(db, content)) continue;
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${q(content)}`).get().n;
    const docs = tableExists(db, `${f}_docsize`) ? db.prepare(`SELECT COUNT(*) AS n FROM ${q(`${f}_docsize`)}`).get().n : null;
    let check = "ok";
    try { db.prepare(`INSERT INTO ${q(f)}(${q(f)}) VALUES ('integrity-check')`).run(); } catch (err) { check = err.message; }
    fts[f] = { content_rows: rows, fts_docs: docs, ok: docs === rows && check === "ok", integrity: check };
  }
  return { integrity, new_fk_violations: newFk, fts };
}

/**
 * Run one mode. Returns {exitCode, report}. Never throws for refusals.
 * @param {object} opts parsed options (see parseArgs)
 * @param {object} [deps] test seams: {probes, emitter, failAfterTables}
 */
export async function run(opts, deps = {}) {
  const probes = deps.probes || defaultProbes;
  const mode = opts.mode;
  if (!["plan", "rehearse", "apply", "emit-only"].includes(mode)) throw new UsageError(`unknown --mode '${mode}'`);
  if (!opts.target) throw new UsageError("--target is required");
  if (!opts.report) throw new UsageError("--report is required");
  const peerMax = parsePeerMax(opts);

  if (mode === "emit-only") return runEmitOnly(opts, deps, peerMax);
  if (!opts.source) throw new UsageError("--source is required");

  if (existsSync(`${opts.source}-wal`) && statSync(`${opts.source}-wal`).size > 0) {
    throw new Error(`source has a non-empty -wal next to it; its sha would not cover the data. Use the API backup file.`);
  }
  const srcBuf = readFileSync(opts.source);
  const sourceSha = sha256Buffer(srcBuf);

  const preWarnings = [];
  if (mode === "apply") {
    const fails = preflightApply(opts, { srcBuf, probes });
    if (fails.length) return { exitCode: 2, refused: fails, report: null };
  } else {
    // plan/rehearse read the target; they must never read the LIVE crow.db
    // under a running gateway (the WAL lesson). Point them at an API backup.
    try {
      const pids = probes.holders([opts.target, `${opts.target}-wal`, `${opts.target}-shm`]);
      if (pids.length) {
        return {
          exitCode: 2,
          refused: [`target is open by process(es) ${pids.join(", ")}: run ${mode} against an API backup copy ` +
            `(POST /api/admin/backup), never the live crow.db`],
          report: null,
        };
      }
    } catch (err) {
      preWarnings.push(`could not check target holders: ${err.message}`);
    }
  }
  if (mode !== "apply" && opts.expectSha && opts.expectSha.toLowerCase() !== sourceSha) {
    throw new Error(`source sha256 mismatch: expected ${opts.expectSha}, got ${sourceSha}`);
  }

  const src = openBytes(srcBuf);
  try {
    const versions = {
      source: src.pragma("user_version", { simple: true }),
      schema_generation: SCHEMA_GENERATION,
    };
    const optFlags = { importMedia: !!opts.importMedia, importDataDashboard: !!opts.importDataDashboard };

    // the plan (in memory) — every mode computes it
    const plan = await dryRun(src, { ...opts, ...optFlags }, peerMax);
    versions.target = (() => { const t = snapshotTarget(opts.target); try { return t.pragma("user_version", { simple: true }); } finally { t.close(); } })();
    const base = {
      mode,
      generated_at: new Date().toISOString(),
      source_path: resolve(opts.source),
      target_path: resolve(opts.target),
      source_sha: sourceSha,
      versions,
      options: { ...optFlags, peer_max_ids: peerMax },
      preflight_warnings: preWarnings,
    };

    if (mode === "plan") {
      const report = buildReport({ ...base, target_before_counts: plan.before, target_after_counts: plan.after }, plan.ctx, {
        emits: { instance_id: null, planned: true, gates: plan.emits.gates, items: plan.emits.items },
        wallet: walletReport(plan.walletBefore, plan.walletAfter, plan.ctx.wallet.inserted_sum),
      });
      writeJsonAtomic(opts.report, report);
      return { exitCode: 0, report };
    }

    // rehearse → scratch copy; apply → the real target
    let workPath = opts.target;
    let scratchDir = null;
    let extractPath = opts.extract;
    if (mode === "rehearse") {
      scratchDir = mkdtempSync(join(tmpdir(), "grackle-d3-rehearse-"));
      workPath = join(scratchDir, "crow.db");
      const snap = snapshotTarget(opts.target);
      try { writeFileSync(workPath, snap.serialize()); } finally { snap.close(); }
      extractPath = join(scratchDir, "grackle-d3-extract.db");
    }

    const tgt = new Database(workPath, { fileMustExist: true });
    try {
      tgt.pragma("busy_timeout = 30000");
      const ctx = newCtx(opts, peerMax);
      ctx.classification = classify(src, tgt, optFlags);
      ctx.sourceInstanceId = sourceInstanceIdOf(src);
      ctx.targetInstanceId = localInstanceIdFile();
      const baselineFk = mode === "rehearse" ? tgt.prepare("PRAGMA foreign_key_check").all() : [];
      const before = countAll(tgt);
      const walletBefore = walletBalances(tgt);

      // extract first: it reads only the source (plan ctx carries the row lists)
      const extractMeta = { source_sha: sourceSha, generated_at: base.generated_at, mode };
      writeExtract(extractPath, src, plan.ctx, extractMeta);

      await phaseA(src, tgt, { ...optFlags, failAfterTables: deps.failAfterTables }, ctx);
      const after = countAll(tgt);
      const emits = planEmits(ctx);
      emits.instance_id = null;
      const report = buildReport({ ...base, target_before_counts: before, target_after_counts: after }, ctx, {
        extract_path: mode === "apply" ? resolve(extractPath) : null,
        emits,
        wallet: walletReport(walletBefore, walletBalances(tgt), ctx.wallet.inserted_sum),
        phase_a: "committed",
      });
      // report BEFORE phase B, so emit-only can recover from a phase-B crash
      if (mode === "apply") writeJsonAtomic(opts.report, report);

      const emitter = await loadEmitter(deps.emitter);
      await phaseB(tgt, emits, emitter);
      emits.instance_id = await instanceIdForReport();
      report.emits = emits;
      report.target_after_counts = countAll(tgt);
      report.phase_b = summarizeEmits(emits);

      if (mode === "rehearse") {
        const checks = rehearseChecks(tgt, baselineFk);
        const diffs = [];
        for (const [t, s] of Object.entries(ctx.perTable)) {
          const p = plan.ctx.perTable[t];
          if (!p || p.inserted !== s.inserted || p.matched_existing !== s.matched_existing) {
            diffs.push({ table: t, plan: p && { inserted: p.inserted, matched: p.matched_existing }, rehearse: { inserted: s.inserted, matched: s.matched_existing } });
          }
        }
        for (const t of Object.keys(after)) {
          if (after[t] !== plan.after[t]) diffs.push({ table: t, plan_after: plan.after[t], rehearse_after: after[t] });
        }
        report.rehearse = {
          scratch_dir: opts.keepScratch ? scratchDir : null,
          integrity: checks.integrity,
          new_fk_violations: checks.new_fk_violations,
          fts: checks.fts,
          count_diffs_vs_plan: diffs,
          ok: checks.integrity === "ok" && !checks.new_fk_violations.length && !diffs.length &&
            Object.values(checks.fts).every((f) => f.ok),
        };
      }
      writeJsonAtomic(opts.report, report);
      return { exitCode: 0, report };
    } finally {
      tgt.close();
      if (scratchDir && !opts.keepScratch) rmSync(scratchDir, { recursive: true, force: true });
    }
  } finally {
    src.close();
  }
}

async function instanceIdForReport() {
  const mod = await import(pathToFileURL(join(REPO, "servers/gateway/instance-registry.js")).href);
  return mod.getOrCreateLocalInstanceId();
}

function summarizeEmits(emits) {
  const out = {};
  for (const i of emits.items) {
    const s = (out[i.table] ||= {});
    s[i.status] = (s[i.status] || 0) + 1;
  }
  return out;
}

async function runEmitOnly(opts, deps, peerMax) {
  const prev = JSON.parse(readFileSync(opts.report, "utf8"));
  if (!prev.emits || !Array.isArray(prev.emits.items)) throw new Error("report has no emits section");
  const effectivePeers = Object.keys(peerMax).length ? peerMax : (prev.options?.peer_max_ids || {});
  // re-evaluate the id-range gate for id-keyed tables
  const byTable = {};
  for (const it of prev.emits.items) (byTable[it.table] ||= []).push(it);
  const gates = {};
  for (const [table, items] of Object.entries(byTable)) {
    const spec = IMPORT_SPECS.find((s) => s.table === table);
    const gate = spec?.emit === "id" ? idGate(table, items.map((i) => i.key.id), effectivePeers) : null;
    gates[table] = gate ? { open: false, reason: gate } : { open: true };
    for (const it of items) {
      if (gate) { it.status = "gated"; it.reason = gate; }
      else if (it.status === "gated") { it.status = "pending"; it.reason = undefined; }
    }
  }
  const tgt = new Database(opts.target, { fileMustExist: true });
  try {
    tgt.pragma("busy_timeout = 30000");
    const v = tgt.pragma("user_version", { simple: true });
    if (v !== SCHEMA_GENERATION) {
      return { exitCode: 2, refused: [`target user_version ${v} != SCHEMA_GENERATION ${SCHEMA_GENERATION}`], report: null };
    }
    const emits = { ...prev.emits, gates };
    const emitter = await loadEmitter(deps.emitter);
    await phaseB(tgt, emits, emitter);
    emits.instance_id = await instanceIdForReport();
    const report = { ...prev, emits, phase_b: summarizeEmits(emits), emit_only_at: new Date().toISOString(),
      options: { ...(prev.options || {}), peer_max_ids: effectivePeers } };
    writeJsonAtomic(opts.report, report);
    return { exitCode: 0, report };
  } finally {
    tgt.close();
  }
}

/* ===================================================================== CLI */

export function parseArgs(argv) {
  const opts = { peerMaxMemoryId: [], peerMaxId: [] };
  const val = (i, name) => {
    if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source": opts.source = val(i, a); i++; break;
      case "--target": opts.target = val(i, a); i++; break;
      case "--mode": opts.mode = val(i, a); i++; break;
      case "--report": opts.report = val(i, a); i++; break;
      case "--extract": opts.extract = val(i, a); i++; break;
      case "--expect-sha": opts.expectSha = val(i, a); i++; break;
      case "--backup-ok": opts.backupOk = val(i, a); i++; break;
      case "--peer-max-memory-id": opts.peerMaxMemoryId.push(val(i, a)); i++; break;
      case "--peer-max-id": opts.peerMaxId.push(val(i, a)); i++; break;
      case "--import-media": opts.importMedia = true; break;
      case "--import-data-dashboard": opts.importDataDashboard = true; break;
      case "--keep-scratch": opts.keepScratch = true; break;
      default: throw new UsageError(`unknown argument '${a}'`);
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const res = await run(opts);
    if (res.exitCode === 2) {
      console.error(`[grackle-d3] apply REFUSED — nothing was written:\n  - ${res.refused.join("\n  - ")}`);
      process.exit(2);
    }
    const r = res.report;
    console.log(`[grackle-d3] ${opts.mode} ok → ${opts.report}`);
    if (r?.per_table) {
      for (const [t, s] of Object.entries(r.per_table)) {
        console.log(`  ${t.padEnd(28)} src ${String(s.source_rows).padStart(6)}  +${s.inserted}  =${s.matched_existing}  filtered ${s.filtered}  fk-skip ${s.fk_skipped}  remapped ${s.remapped_ids}`);
      }
    }
    if (r?.phase_b) console.log(`  phase B: ${JSON.stringify(r.phase_b)}`);
    if (r?.rehearse) console.log(`  rehearse ok: ${r.rehearse.ok}`);
    if (r?.warnings?.length) console.log(`  warnings:\n    ${r.warnings.join("\n    ")}`);
    process.exit(0);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[grackle-d3] usage: ${err.message}`);
      process.exit(64);
    }
    console.error(`[grackle-d3] FAILED: ${err?.stack || err}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { UsageError };
