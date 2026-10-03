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
 *     [--source-instance-id <grackle-instance-id>] \
 *     [--peer-max-id <table>:<instance-id>=<n> ...] [--peer-max-memory-id <instance-id>=<n> ...] \
 *     [--peer-exclude <instance-id> ...] [--ack-unclassified <t1,t2,...>] \
 *     [--import-media] [--import-data-dashboard] [--keep-scratch] [--requeue]
 *
 * Modes:
 *   plan      reads both DBs (the source as bytes, the target as an
 *             in-memory snapshot), runs the import against the snapshot and
 *             writes only the report (with its go/no-go section).
 *   rehearse  copies the target into os.tmpdir(), applies phases A and B to
 *             the copy, runs integrity_check / foreign_key_check / FTS
 *             checks, and diffs the counts against an in-memory plan. The
 *             real --target is never opened for writing.
 *   apply     the live run. Refuses (exit 2, nothing written) unless every
 *             preflight holds — see preflightApply().
 *   emit-only re-queues phase B from the report of a COMMITTED apply against
 *             the same target. Idempotent: an outbox row already holding the
 *             item's (table, key) is never queued twice.
 *
 * Phase A is ONE transaction on one better-sqlite3 handle: a crash, a kill
 * or a thrown error leaves the target unchanged. Phase B queues the synced
 * rows through emitOrQueue(null, …) into the #292 outbox; the gateway's
 * drain delivers them on its next boot. Phase B runs only when crow's row
 * for the source instance reads `revoked`, and only for id-keyed tables
 * whose every live peer has a supplied max id.
 *
 * Exit codes: 0 ok · 1 error · 2 refused (preflight) · 64 usage.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, statSync, renameSync, rmSync, mkdtempSync, realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
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
  ramble: { id: "ramble", module: "bundles/ramble/server/init-tables.js", fn: "initRambleTables", always: true },
  kb: { id: "knowledge-base", module: "bundles/knowledge-base/server/init-tables.js", fn: "initKbTables", always: true },
  media: { id: "media", module: "bundles/media/server/init-tables.js", fn: "initMediaTables", flag: "importMedia" },
  "data-dashboard": {
    id: "data-dashboard", module: "bundles/data-dashboard/server/init-tables.js", fn: "initDataDashboardTables",
    flag: "importDataDashboard",
  },
};

const fk = (parent, onMissing = "null") => ({ parent, onMissing });

/** Columns of the user's crow_id-keyed contact that are per-device judgments (instance-sync EXCLUDED_COLUMNS). */
const CONTACT_LOCAL_COLS = ["verified", "last_seen", "origin"];

/** A contact the live sync would replicate (mirrors shouldSyncRow('contacts')). */
const contactSyncable = (r) => r.origin !== "local-bot" && (r.request_status == null || r.request_status === "accepted");

/**
 * Import specs, in dependency order. Fields:
 *   pk        "id" (integer key, remappable) or an array of natural-key columns
 *   idPolicy  "keep-if-free": keep the source id when the target has no row
 *             there AND the id is above the target's sqlite_sequence (a
 *             lower free id may be a deleted crow row that something still
 *             points at); else a fresh id above every known id.
 *             "fresh-above-peers": the id-keyed SYNCED tables (memories,
 *             research_notes, glasses_note_sessions). Sync applies them by
 *             numeric id, so every inserted row gets a fresh id above the
 *             target, the source AND every peer's max id.
 *   dedupe    alternatives tried in order AFTER fk remap; a match maps the
 *             source row onto the existing target row (never updated).
 *               cols    columns compared null-safely (IS)
 *               strict  skip the alternative when any value is null
 *               when    (row) => bool — the alternative applies only if true
 *               where   extra SQL condition on the target row
 *               drift   on a match, columns compared; differences are
 *                       reported (crow's version is kept)
 *   fks       {col: {parent, onMissing: "null"|"skip"}}
 *   where     source-row filter; rows it rejects go to the extract
 *   transform (row, ctx) => {row} | {drop: reason}
 *   dropCols  columns never copied for this table (target default applies)
 *   singleton insert only when the target table is empty
 *   syncKey   an "already synced" table: inserted rows are reported as
 *             missing-on-crow under this key (spec I7)
 *   emit      "id" (id-keyed sync, peer-range gated) | "natural"
 */
export const IMPORT_SPECS = [
  // ---- contacts first: members, messages and comments point at them.
  // Already synced; grackle-only, syncable contacts are imported by crow_id.
  {
    table: "contacts", group: "core", pk: "id", idPolicy: "keep-if-free",
    where: contactSyncable,
    dedupe: [{ cols: ["crow_id"], strict: true }],
    dropCols: CONTACT_LOCAL_COLS,
    syncKey: ["crow_id"],
    transform: "contactTombstone",
  },
  // ---- projects: everything else points at them
  {
    table: "project_spaces", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["uuid"], strict: true }, { cols: ["slug", "workspace_dir"] }],
    fks: { owner_contact_id: fk("contacts", "skip") },
    onInsert: "renameClashingSlug",
  },
  {
    // Identity is the partial unique indexes (init-db): ONE active local-owner
    // row per project (contact_id IS NULL), ONE active row per (project,
    // contact). A NULL contact means "the local user", so an unmatched
    // contact never becomes NULL — the row goes to the extract (C1).
    table: "project_members", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [
      { cols: ["uuid"], strict: true },
      { cols: ["project_id"], where: "contact_id IS NULL AND revoked_at IS NULL", when: (r) => r.contact_id == null && r.revoked_at == null },
      { cols: ["project_id", "contact_id"], where: "revoked_at IS NULL", when: (r) => r.contact_id != null && r.revoked_at == null },
    ],
    fks: { project_id: fk("project_spaces", "skip"), contact_id: fk("contacts", "skip"), granted_by_contact_id: fk("contacts", "skip") },
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
    dedupe: [
      { cols: ["uuid"], strict: true, drift: ["content", "title", "tags"] },
      { cols: ["id", "created_at"], drift: ["content", "title", "tags"] },
      { cols: ["content", "created_at"] },
    ],
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
    // (id, created_at) first: a memory that replicated by id and was later
    // edited on one side is the SAME memory, not a new one (I2). Crow's
    // version is kept; the difference goes to the go/no-go report.
    table: "memories", group: "core", pk: "id", idPolicy: "fresh-above-peers",
    dedupe: [
      { cols: ["id", "created_at"], drift: ["content", "context", "tags", "category", "importance"] },
      { cols: ["content"] },
    ],
    fks: { project_id: fk("project_spaces") },
    emit: "id",
  },
  { table: "memory_embeddings_blob", group: "core", pk: ["memory_id"], fks: { memory_id: fk("memories", "skip") } },
  {
    // Already synced. Messages with a nostr_event_id key on it; synthetic
    // ids (group/room rows) fall back to content + time.
    table: "messages", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["nostr_event_id"], strict: true }, { cols: ["contact_id", "direction", "created_at", "content"] }],
    fks: { contact_id: fk("contacts", "skip") },
    syncKey: ["nostr_event_id"],
  },
  {
    // Already synced; keyed by (section_key, device_id, project_id) — the four
    // partial unique indexes. Crow's section always wins.
    table: "crow_context", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["section_key", "device_id", "project_id"] }],
    fks: { project_id: fk("project_spaces", "skip") },
    syncKey: ["section_key", "device_id", "project_id"],
  },
  {
    // a slug match whose title differs is a DIFFERENT post: no remap, so its
    // children never attach to crow's post (minor d) — reported in go_no_go
    table: "blog_posts", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["slug"], conflictIf: ["title"] }],
  },
  { table: "blog_post_embeddings", group: "core", pk: ["post_id"], fks: { post_id: fk("blog_posts", "skip") } },
  {
    table: "blog_comments", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["nostr_event_id"], strict: true }, { cols: ["post_id", "content", "created_at"] }],
    // ON DELETE SET NULL + author_name carries the display: an unknown contact
    // keeps the comment (minor c). A TOMBSTONED contact still sends it to the extract.
    fks: { post_id: fk("blog_posts", "skip"), contact_id: fk("contacts", "null") },
  },
  {
    table: "songbook_setlists", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["name", "created_at"] }],
  },
  {
    table: "songbook_setlist_items", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["setlist_id", "post_id"] }], // the unique index (minor b)
    fks: { setlist_id: fk("songbook_setlists", "skip"), post_id: fk("blog_posts", "skip") },
  },
  {
    // imported INACTIVE and listed: Kevin confirms the target integration exists on crow (minor e)
    table: "crosspost_rules", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["source_app", "source_trigger", "target_app"] }],
    transform: (row) => ({ row: { ...row, active: 0 } }),
    goNoGo: (row, original) => ({ id: row.id, source_app: row.source_app, source_trigger: row.source_trigger, target_app: row.target_app, active_on_grackle: original.active }),
  },
  {
    // nothing grackle-scheduled runs on crow until someone switches it on (N2):
    // pipeline:botcron rows would otherwise fire every overdue run at once
    table: "schedules", group: "core", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["task", "cron_expression"] }],
    transform: (row) => ({ row: { ...row, enabled: 0, next_run: null } }),
    goNoGo: (row, original) => ({ id: row.id, task: row.task, cron_expression: row.cron_expression, enabled_on_grackle: original.enabled }),
  },
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
    transform: "storageReference",
  },
  {
    // Two bridges must never run one bot: always imported disabled (spec §4.2).
    table: "pi_bot_defs", group: "core", pk: ["bot_id"],
    fks: { project_id: fk("project_spaces") },
    transform: (row) => ({ row: { ...row, enabled: 0 } }),
  },

  // ---- ramble: natural keys, insert-or-ignore, crow's row always wins.
  // The synced tables (marks … trades) are imported only where crow lacks
  // the row (I7); cells and wallet are also emitted.
  {
    table: "ramble_marks", group: "ramble", pk: "id", idPolicy: "keep-if-free",
    dedupe: [{ cols: ["mark_id"], strict: true }, { cols: ["nostr_event_id"], strict: true }],
    syncKey: ["mark_id"],
  },
  { table: "ramble_settings", group: "ramble", pk: ["key"], syncKey: ["key"] },
  { table: "ramble_blocks", group: "ramble", pk: ["persona"], syncKey: ["persona"] },
  { table: "ramble_eggs", group: "ramble", pk: ["egg_id"], syncKey: ["egg_id"], transform: "oneIncubatingEgg" },
  { table: "ramble_pet", group: "ramble", pk: ["owner"], syncKey: ["owner"] },
  { table: "ramble_trades", group: "ramble", pk: ["trade_id"], syncKey: ["trade_id"] },
  { table: "ramble_groups", group: "ramble", pk: ["group_id"] },
  { table: "ramble_cells", group: "ramble", pk: ["cell"], emit: "natural", syncKey: ["cell"] },
  { table: "ramble_wallet", group: "ramble", pk: ["kind", "key"], emit: "natural", syncKey: ["kind", "key"], naturalDrift: ["delta"] },
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
    // digest.js mails EVERY enabled row: never add a second one (minor 9)
    table: "media_digest_preferences", group: "media", pk: "id", idPolicy: "keep-if-free", singleton: true,
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

/** Not imported; listed in the report with counts (and archived in the extract). */
export const SKIP_REASONS = {
  notifications: "noise",
  oauth_clients: "bound to grackle's issuer",
  oauth_tokens: "bound to grackle's issuer",
  mcp_sessions: "per-host session state",
  sync_conflicts: "grackle-local sync bookkeeping",
  audit_log: "grackle-local audit trail",
  crow_keychain: "machine-local passwords sealed with that machine's own keychain key (move them with Settings → Passwords → Export / Import)",
  cross_host_calls: "grackle-local bookkeeping",
  providers: "already synced (grackle's provider rows are being retired)",
  data_backends: "keep crow's rows (map: grackle's point at ~/spring-2026)",
  crow_instances: "grackle is revoked; peer rows are per-instance",
  tenants: "per-instance tenancy seed",
  dashboard_settings: "handled key-by-key (see report.settings)",
  dashboard_settings_overrides: "handled key-by-key (see report.settings)",
};

/** Never written to the extract: credentials / sync internals (the archived full backup keeps them). */
const NO_EXTRACT = new Set([
  "oauth_clients", "oauth_tokens", "mcp_sessions", "dashboard_pending_2fa", "push_subscriptions",
  "crow_keychain",
  "crow_instances", "sync_state", "sync_outbox", "rate_limit_buckets", "sqlite_sequence",
  "dashboard_settings", "dashboard_settings_overrides",
]);

/**
 * Explicitly archive-only (spec §4.2, Kevin §9, fix-round rulings): extract
 * only, NEVER created in the target, and not part of --ack-unclassified.
 */
export const ARCHIVE_ONLY = [
  [/^pir_requests$/, "unowned (grackle's untracked scripts/bots)"],
  [/^capstone_/, "unowned (grackle's untracked scripts)"],
  [/^pipeline_runs$/, "unowned (grackle's untracked scripts)"],
  [/^tax_/, "sensitive personal documents (archive private/)"],
  [/^crowclaw_/, "dormant; bundle not in the repo"],
  [/^bot_/, "Bot Builder session/run history of grackle's bridge"],
  [/^ramble_(tombstones|outbox)$/, "grackle's outbound relay work items"],
  [/^media_/, "media rolling feed and derived state (not imported)"],
  [/^data_dashboard_items$/, "points at grackle's data_backends (not imported)"],
];

/** Settings: blog settings move to crow (Kevin, 09-22) — grackle wins. */
const SETTINGS_UPSERT = /^blog_/;
const SETTINGS_INSERT_IF_ABSENT = new Set(["tts_voice", "meta_glasses_devices"]);
const OVERRIDE_KEYS = { meta_glasses_default_project_id: "project_spaces" };
const SECRETISH = /(token|secret|password|passwd|api_?key|apikey|credential|private|cookie|session)/i;

/** Columns never copied: per-instance lamport counters / origins (phase B stamps the emitted rows). */
const NEVER_COPY = new Set(["lamport_ts", "lamport_origin"]);

/** Id-keyed synced tables: their emits need every live peer's max id. */
export const ID_EMIT_TABLES = IMPORT_SPECS.filter((s) => s.emit === "id").map((s) => s.table);

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

function seqOf(db, table) {
  if (!tableExists(db, "sqlite_sequence")) return 0;
  return Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ?? 0);
}

function maxId(db, table) {
  const a = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(table)}`).get().m;
  return Math.max(Number(a), seqOf(db, table));
}

/** Where getOrCreateLocalInstanceId() reads the id — read here, NEVER created. */
export function instanceIdPath() {
  const dir = process.env.CROW_DATA_DIR ? resolve(process.env.CROW_DATA_DIR) : resolve(homedir(), ".crow", "data");
  return join(dir, "instance-id");
}

function readLocalInstanceId() {
  const p = instanceIdPath();
  if (!existsSync(p)) return null;
  const id = readFileSync(p, "utf8").trim();
  return id || null;
}

function instanceRows(db) {
  if (!tableExists(db, "crow_instances")) return [];
  return db.prepare("SELECT id, name, status FROM crow_instances").all();
}

/* ============================================================ classification */

function groupSelected(group, opts) {
  if (group === "core") return true;
  const g = BUNDLE_GROUPS[group];
  return g.always || !!opts[g.flag];
}

/**
 * Classify every source table. Returns {imports, skipped: {t:{reason,count}},
 * extract: {t: reason}, unclassified: {t: count}} — every source user table
 * lands in exactly one of import / skip / archive / unclassified.
 * `unclassified` = not in the map AND holding rows: apply needs them acked.
 */
export function classify(src, tgt, opts) {
  const specByTable = new Map(IMPORT_SPECS.map((s) => [s.table, s]));
  const imports = [];
  const skipped = {};
  const extract = {};
  const unclassified = {};
  for (const t of userTables(src)) {
    const n = src.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n;
    const spec = specByTable.get(t);
    if (spec) {
      if (groupSelected(spec.group, opts)) { imports.push(spec); continue; }
      extract[t] = `bundle '${spec.group}' not selected for import`;
      continue;
    }
    const arch = ARCHIVE_ONLY.find(([re]) => re.test(t));
    if (arch) { extract[t] = `archive-only: ${arch[1]}`; continue; }
    if (SKIP_REASONS[t]) {
      skipped[t] = { reason: SKIP_REASONS[t], count: n };
      if (!NO_EXTRACT.has(t)) extract[t] = `skipped: ${SKIP_REASONS[t]}`;
      continue;
    }
    if (NO_EXTRACT.has(t)) { skipped[t] = { reason: "credential / sync internals (kept only in the archived full backup)", count: n }; continue; }
    extract[t] = tableExists(tgt, t) ? "unclassified (exists on crow; not in the D3 map)" : "unclassified (not on crow)";
    if (n > 0) unclassified[t] = n;
  }
  imports.sort((a, b) => IMPORT_SPECS.indexOf(a) - IMPORT_SPECS.indexOf(b));
  return { imports, skipped, extract, unclassified };
}

/* ================================================================== phase A */

class Remaps {
  constructor() { this.maps = new Map(); }
  for(table) { if (!this.maps.has(table)) this.maps.set(table, new Map()); return this.maps.get(table); }
  get(table, srcId) { return this.maps.get(table)?.get(srcId); }
}

const TRANSFORMS = {
  /** A contact Kevin deleted on crow stays deleted (N1); its children follow it to the extract. */
  contactTombstone(row, ctx) {
    if (tableExists(ctx.tgt, "contact_tombstones") &&
        ctx.tgt.prepare("SELECT 1 FROM contact_tombstones WHERE crow_id = ?").get(row.crow_id)) {
      ctx.tombstonedContacts.add(row.id);
      ctx.tombstonedList.push({ crow_id: row.crow_id });
      return { drop: "tombstoned" };
    }
    return { row };
  },
  /** One incubating egg (N3): mirror applyRambleEgg's loser rule — shelve, origin 'sync'. */
  oneIncubatingEgg(row, ctx) {
    if (row.status !== "incubating") return { row };
    if (ctx.tgt.prepare("SELECT 1 FROM ramble_eggs WHERE egg_id = ?").get(row.egg_id)) return { row }; // crow has it: matched below
    const cur = ctx.tgt.prepare("SELECT egg_id FROM ramble_eggs WHERE status = 'incubating' LIMIT 1").get();
    if (!cur) return { row };
    ctx.eggsShelved.push({ egg_id: row.egg_id, kept_incubating: cur.egg_id });
    return { row: { ...row, status: "shelf", shelf_origin: "sync" } };
  },
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
  /** storage_files.reference_id is polymorphic: remap the types we import (minor 3). */
  storageReference(row, ctx) {
    const parent = { blog_post: "blog_posts", message: "messages" }[row.reference_type];
    if (!parent || row.reference_id == null) {
      if (row.reference_type && row.reference_id != null) {
        ctx.warn(`storage_files id=${row.id}: reference_type '${row.reference_type}' kept with its raw reference_id`);
      }
      return { row };
    }
    const t = ctx.remaps.get(parent, row.reference_id);
    if (t === undefined) {
      ctx.warn(`storage_files id=${row.id}: ${row.reference_type} ${row.reference_id} not imported — reference cleared`);
      return { row: { ...row, reference_id: null } };
    }
    return { row: { ...row, reference_id: t } };
  },
};

function applyTransform(spec, row, ctx) {
  if (!spec.transform) return { row };
  if (typeof spec.transform === "function") return spec.transform(row, ctx);
  return TRANSFORMS[spec.transform](row, ctx);
}

function driftOf(tgt, table, keyWhere, keyArgs, row, cols) {
  const existing = tgt.prepare(`SELECT * FROM ${q(table)} WHERE ${keyWhere} LIMIT 1`).get(...keyArgs);
  if (!existing) return null;
  const fields = cols.filter((c) => c in row && c in existing && (row[c] ?? null) !== (existing[c] ?? null));
  if (!fields.length) return null;
  return { fields, source_updated_at: row.updated_at ?? null, crow_updated_at: existing.updated_at ?? null };
}

/**
 * Import one table. Synchronous; runs inside phase A's transaction.
 */
function importTable(spec, src, tgt, ctx) {
  const { table } = spec;
  ctx.tgt = tgt;
  const stat = {
    group: spec.group, classification: "import", source_rows: 0, inserted: 0, matched_existing: 0,
    filtered: 0, fk_skipped: 0, kept_ids: 0, remapped_ids: 0,
  };
  ctx.perTable[table] = stat;
  if (!tableExists(src, table)) { stat.note = "absent in source"; return; }
  if (!tableExists(tgt, table)) throw new Error(`target lacks table ${table} (group ${spec.group})`);

  const srcCols = columnsOf(src, table);
  const tgtCols = new Set(columnsOf(tgt, table));
  const drop = new Set([...(spec.dropCols || []), ...NEVER_COPY]);
  const cols = srcCols.filter((c) => tgtCols.has(c) && !drop.has(c));
  const sourceOnly = srcCols.filter((c) => !tgtCols.has(c));
  if (sourceOnly.length) ctx.sourceOnly[table] = { columns: sourceOnly, rows_with_values: 0 };

  const isIntPk = spec.pk === "id";
  const naturalPk = isIntPk ? null : spec.pk;
  const remap = isIntPk ? ctx.remaps.for(table) : null;
  let nextFresh = 0;
  const seq = isIntPk ? seqOf(tgt, table) : 0;
  if (isIntPk) {
    const srcMax = src.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(table)}`).get().m;
    const peerMax = Math.max(0, ...Object.values(ctx.peerMax[table] || {}));
    nextFresh = Math.max(maxId(tgt, table), Number(srcMax), peerMax) + 1;
  }
  if (spec.singleton && tgt.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n > 0) {
    const n = src.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get().n;
    stat.source_rows = n;
    stat.matched_existing = n;
    stat.note = "singleton: crow already has a row; grackle's goes to the extract";
    for (const r of src.prepare(`SELECT * FROM ${q(table)}`).all()) ctx.notImported(table, r, "singleton: crow already has a row");
    return;
  }

  const insertStmt = tgt.prepare(
    `INSERT ${naturalPk ? "OR IGNORE " : ""}INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  );
  const existsById = isIntPk ? tgt.prepare(`SELECT 1 FROM ${q(table)} WHERE id = ?`) : null;
  const dedupeStmts = (spec.dedupe || []).map((d) => {
    const where = [...d.cols.map((c) => `${q(c)} IS ?`), ...(d.where ? [`(${d.where})`] : [])].join(" AND ");
    return { ...d, whereSql: where, stmt: tgt.prepare(`SELECT ${isIntPk ? "id" : "1 AS id"} FROM ${q(table)} WHERE ${where} LIMIT 1`) };
  });
  const naturalWhere = naturalPk ? naturalPk.map((c) => `${q(c)} IS ?`).join(" AND ") : null;
  const naturalExists = naturalPk ? tgt.prepare(`SELECT 1 FROM ${q(table)} WHERE ${naturalWhere}`) : null;

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
      if (rule.parent === "contacts" && ctx.tombstonedContacts.has(v)) { skip = "tombstoned"; break; }
      const mapped = ctx.remaps.get(rule.parent, v);
      if (mapped !== undefined) { row[col] = mapped; continue; }
      if (rule.onMissing === "skip") { skip = `${col}=${v} has no imported/matched ${rule.parent} row`; break; }
      row[col] = null;
    }
    if (skip) { stat.fk_skipped++; ctx.notImported(table, original, skip); continue; }


    const t = applyTransform(spec, row, ctx);
    if (t.drop) { stat.filtered++; ctx.notImported(table, original, t.drop); continue; }
    row = t.row;

    // dedupe onto an existing target row
    let matched;
    let conflict = null;
    for (const d of dedupeStmts) {
      if (d.when && !d.when(row)) continue;
      const vals = d.cols.map((c) => row[c] ?? null);
      if (d.strict && vals.some((v) => v == null)) continue;
      const hit = d.stmt.get(...vals);
      if (hit && d.conflictIf) {
        const ex = tgt.prepare(`SELECT * FROM ${q(table)} WHERE ${d.whereSql} LIMIT 1`).get(...vals);
        const diff = d.conflictIf.filter((c) => (row[c] ?? null) !== (ex[c] ?? null));
        if (diff.length) { matched = null; conflict = { on: d.cols, differs: diff, crow_id: hit.id }; break; }
      }
      if (hit) {
        matched = hit.id;
        if (d.drift) {
          const dr = driftOf(tgt, table, d.whereSql, vals, row, d.drift);
          if (dr) ctx.drift(table, { source_id: original.id, crow_id: hit.id, matched_on: d.cols, ...dr });
        }
        break;
      }
    }
    if (naturalPk && naturalExists.get(...naturalPk.map((c) => row[c] ?? null))) {
      matched = true;
      if (spec.naturalDrift) {
        const dr = driftOf(tgt, table, naturalWhere, naturalPk.map((c) => row[c] ?? null), row, spec.naturalDrift);
        if (dr) ctx.drift(table, { key: Object.fromEntries(naturalPk.map((c) => [c, row[c]])), ...dr });
      }
    }
    if (conflict) {
      stat.conflicts = (stat.conflicts || 0) + 1;
      ctx.conflicts(table, { source_id: original.id, ...Object.fromEntries(conflict.on.map((c) => [c, row[c]])), crow_id: conflict.crow_id, differs: conflict.differs });
      ctx.notImported(table, original, `${conflict.on.join(",")} taken on crow by a different row (${conflict.differs.join(",")} differ)`);
      continue;
    }
    if (matched !== undefined) {
      stat.matched_existing++;
      if (isIntPk) remap.set(original.id, matched);
      continue;
    }

    let key;
    if (isIntPk) {
      let id = original.id;
      const fresh = spec.idPolicy === "fresh-above-peers" || existsById.get(id) || id <= seq;
      if (fresh) {
        id = nextFresh++;
        stat.remapped_ids++;
        if (spec.warnOnRemap) ctx.warn(`${table} id ${original.id} → ${id}: ${spec.warnOnRemap}`);
      } else {
        stat.kept_ids++;
      }
      row.id = id;
      if (spec.onInsert === "renameClashingSlug") row = renameClashingSlug(tgt, row, ctx);
      remap.set(original.id, id);
      key = { id };
    } else {
      key = Object.fromEntries(naturalPk.map((c) => [c, row[c]]));
    }
    const info = insertStmt.run(...cols.map((c) => row[c] ?? null));
    if (!info.changes) continue;
    stat.inserted++;
    ctx.inserted(table, key);
    if (spec.syncKey) ctx.syncedMissing(table, Object.fromEntries(spec.syncKey.map((c) => [c, row[c] ?? null])));
    if (spec.goNoGo) ctx.listed(table, spec.goNoGo(row, original));
    if (table === "ramble_wallet") {
      ctx.wallet.inserted_sum[row.kind] = (ctx.wallet.inserted_sum[row.kind] || 0) + Number(row.delta || 0);
    }
  }
}

function renameClashingSlug(tgt, row, ctx) {
  const taken = tgt.prepare("SELECT 1 FROM project_spaces WHERE slug = ?");
  if (!taken.get(row.slug)) return row;
  let slug = `${row.slug}-grackle`;
  for (let i = 2; taken.get(slug); i++) slug = `${row.slug}-grackle-${i}`;
  const shared = row.workspace_dir != null &&
    !!tgt.prepare("SELECT 1 FROM project_spaces WHERE workspace_dir = ?").get(row.workspace_dir);
  ctx.renamed.push({ source_id: row.id, from: row.slug, to: slug, workspace_dir: row.workspace_dir, shares_workspace_with_crow_project: shared });
  ctx.warn(`project_spaces id ${row.id}: slug '${row.slug}' is taken on crow by a different project → '${slug}'` +
    (shared ? ` — ⚠ its workspace_dir ${row.workspace_dir} is ALSO another crow project's` : ""));
  return { ...row, slug };
}

function importSettings(src, tgt, ctx) {
  const out = { upserted: [], inserted: [], kept_crow: [], skipped_keys: [], overrides: [], override_keys_skipped: [] };
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
        out.skipped_keys.push(r.key);
        ctx.skippedSettings.push(r);
      }
    }
  }
  if (!tableExists(src, "dashboard_settings_overrides")) return;
  if (!ctx.sourceInstanceId || !ctx.targetInstanceId) {
    ctx.warn("dashboard_settings_overrides: source or crow instance id unknown — overrides NOT re-homed (pass --source-instance-id)");
    return;
  }
  const ins = tgt.prepare(`INSERT OR IGNORE INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))`);
  for (const r of src.prepare("SELECT key, value FROM dashboard_settings_overrides WHERE instance_id = ? ORDER BY key").all(ctx.sourceInstanceId)) {
    const parent = OVERRIDE_KEYS[r.key];
    if (!parent) { out.override_keys_skipped.push(r.key); continue; }
    const mapped = ctx.remaps.get(parent, Number(r.value));
    const value = mapped !== undefined ? String(mapped) : r.value;
    const info = ins.run(r.key, ctx.targetInstanceId, value);
    out.overrides.push({ key: r.key, value, inserted: info.changes > 0 });
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

/** Peer-range gate for one id-keyed table (spec §4.2). Returns null (open) or a reason. */
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

/**
 * Which live peers must have a max id for the id-keyed emits (I3): every
 * crow_instances row with status active/offline that is not crow itself, not
 * the source, and not explicitly --peer-exclude'd. Returns the coverage
 * problems (empty = covered).
 */
export function peerCoverage(target, { selfId, sourceId, peerMax, excludes }) {
  const rows = instanceRows(target);
  const ids = new Set(rows.map((r) => r.id));
  const required = rows.filter((r) => ["active", "offline"].includes(r.status) && r.id !== selfId && r.id !== sourceId && !excludes.includes(r.id));
  const problems = [];
  for (const x of excludes) if (!ids.has(x)) problems.push(`--peer-exclude ${x} is not a crow_instances row`);
  for (const table of ID_EMIT_TABLES) {
    const given = peerMax[table] || {};
    for (const p of Object.keys(given)) {
      if (!required.some((r) => r.id === p)) problems.push(`--peer-max-id ${table}:${p} is not a live peer (unknown id, self, source or excluded)`);
    }
    for (const r of required) {
      if (!(r.id in given)) problems.push(`no --peer-max-id ${table}:${r.id}=<n> for peer '${r.name}' (${r.status}); pass it or --peer-exclude ${r.id}`);
    }
  }
  return { required: required.map((r) => ({ id: r.id, name: r.name, status: r.status })), problems };
}

/** The source instance's status on crow ('revoked' is required for any emit; I4). */
function sourceStatusOn(target, sourceId) {
  if (!sourceId) return null;
  return instanceRows(target).find((r) => r.id === sourceId)?.status ?? null;
}

/** The phase-B items (status pending/gated) from the inserted keys. */
export function planEmits(ctx, { sourceStatus, coverageProblems = [] }) {
  const items = [];
  const gates = {};
  for (const spec of IMPORT_SPECS) {
    if (!spec.emit) continue;
    const keys = ctx.insertedKeys[spec.table] || [];
    if (!keys.length) continue;
    let gate = null;
    if (sourceStatus !== "revoked") gate = `source-not-revoked (crow's row for the source reads '${sourceStatus ?? "missing"}')`;
    else if (spec.emit === "id" && coverageProblems.length) gate = "peer-coverage-incomplete";
    else if (spec.emit === "id") gate = idGate(spec.table, keys.map((k) => k.id), ctx.peerMax);
    gates[spec.table] = gate ? { open: false, reason: gate } : { open: true };
    for (const key of keys) {
      items.push({ table: spec.table, key, status: gate ? "gated" : "pending", reason: gate || undefined, lamport: null });
    }
  }
  return { items, gates };
}

function outboxLamport(tgt, table, key) {
  if (!tableExists(tgt, "sync_outbox")) return null;
  const conds = Object.keys(key).map((c) => `json_extract(row_json, '$.${c}') IS ?`);
  const r = tgt.prepare(`SELECT MAX(lamport_ts) AS l FROM sync_outbox WHERE table_name = ? AND ${conds.join(" AND ")}`)
    .get(table, ...Object.values(key));
  return r?.l ?? null;
}

/**
 * Phase B: queue each pending item through emitOrQueue(null, …). An item
 * whose (table, key) already sits in the outbox (whatever lamport) is
 * recorded as queued, never queued twice. `persist()` is called after every
 * item so a crash leaves an accurate report for emit-only (I8).
 */
export async function phaseB(tgt, emits, { emitOrQueue }, persist = () => {}, { requeue = false } = {}) {
  const adapter = libsqlAdapter(tgt);
  for (const item of emits.items) {
    // already queued once: the drain may have delivered and removed it (minor a)
    if (item.status === "queued" && item.lamport != null && !requeue) continue;
    // a closed gate queues nothing — not even a re-queue of an already-queued item
    if (item.status === "gated" || emits.gates?.[item.table]?.open === false) continue;
    const existing = outboxLamport(tgt, item.table, item.key);
    if (existing != null) { item.status = "queued"; item.lamport = existing; item.reason = undefined; persist(); continue; }
    const cols = Object.keys(item.key);
    const row = tgt.prepare(`SELECT * FROM ${q(item.table)} WHERE ${cols.map((c) => `${q(c)} IS ?`).join(" AND ")}`)
      .get(...Object.values(item.key));
    if (!row) { item.status = "failed"; item.reason = "row not found in target"; persist(); continue; }
    const opts = item.lamport != null ? { lamportTs: item.lamport } : {};
    const res = await emitOrQueue(null, adapter, item.table, "insert", row, opts);
    if (res && res.queued) { item.status = "queued"; item.lamport = res.lamport; item.reason = undefined; }
    else { item.status = "not-queued"; item.reason = "emitOrQueue returned null (ineligible deployment or unsyncable row)"; }
    persist();
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
    ex.exec(`CREATE TABLE _settings_not_imported (key TEXT PRIMARY KEY, value TEXT, redacted INTEGER NOT NULL)`);
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
    // non-imported settings: values only for non-secret-looking keys (minor 5)
    const sni = ex.prepare("INSERT OR REPLACE INTO _settings_not_imported (key, value, redacted) VALUES (?, ?, ?)");
    for (const r of ctx.skippedSettings) {
      const secret = SECRETISH.test(r.key);
      sni.run(r.key, secret ? null : r.value, secret ? 1 : 0);
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
  /** {load, active} from systemd, or null when systemctl can't answer. */
  gatewayState() {
    const r = spawnSync("systemctl", ["show", "-p", "LoadState", "-p", "ActiveState", "crow-gateway"], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    const kv = Object.fromEntries((r.stdout || "").split("\n").filter(Boolean).map((l) => l.split("=")));
    return { load: kv.LoadState || null, active: kv.ActiveState || null };
  },
  /** PIDs (other than ours) holding any of the paths; throws when lsof is unavailable. */
  holders(paths) {
    const existing = paths.filter((p) => existsSync(p));
    if (!existing.length) return [];
    const r = spawnSync("lsof", ["-t", ...existing], { encoding: "utf8" });
    if (r.error) throw new Error(`lsof unavailable: ${r.error.message}`);
    return (r.stdout || "").split(/\s+/).filter(Boolean).map(Number).filter((p) => p !== process.pid);
  },
  uid() { return typeof process.getuid === "function" ? process.getuid() : null; },
};

function userVersionOfBytes(buf) {
  // header offset 60, big-endian u32
  return buf.length >= 64 ? buf.readUInt32BE(60) : null;
}

/** Single-writer checks; run FIRST, before the target is read at all (minor 2). */
function writerChecks(opts, probes) {
  const fails = [];
  const st = probes.gatewayState();
  if (st == null) fails.push("cannot determine crow-gateway state (systemctl unavailable)");
  else if (st.load !== "loaded") fails.push(`crow-gateway unit LoadState=${st.load} — wrong host or unit name? refusing`);
  else if (!["inactive", "failed"].includes(st.active)) fails.push(`crow-gateway is ${st.active} — stop it first`);
  try {
    const pids = probes.holders([opts.target, `${opts.target}-wal`, `${opts.target}-shm`]);
    if (pids.length) fails.push(`target is held by other process(es): ${pids.join(", ")} — end them first (spec §5.3)`);
  } catch (err) {
    fails.push(`cannot verify target holders: ${err.message}`);
  }
  return fails;
}

/** Ownership / identity checks shared by apply and emit-only (I5). */
function identityChecks(opts, probes, target, sourceId) {
  const fails = [];
  const uid = probes.uid();
  if (uid === 0) fails.push("running as root: the gateway (kh0pp) could not open root-owned -wal/-shm afterwards. Run as the target's owner");
  try {
    const owner = statSync(opts.target).uid;
    if (uid != null && owner !== uid) fails.push(`target is owned by uid ${owner} but this process runs as uid ${uid}`);
  } catch (err) {
    fails.push(`cannot stat target: ${err.message}`);
  }
  fails.push(...instanceIdChecks(target, sourceId));
  return fails;
}

function instanceIdChecks(target, sourceId) {
  const fails = [];
  const p = instanceIdPath();
  const self = readLocalInstanceId();
  if (!self) { fails.push(`instance-id file missing at ${p} (set CROW_DATA_DIR to crow's data dir; it is never created here)`); return fails; }
  if (!instanceRows(target).some((r) => r.id === self)) fails.push(`instance id ${self} (${p}) is not a row in the target's crow_instances — wrong CROW_DATA_DIR?`);
  if (sourceId && self === sourceId) fails.push(`instance id ${self} is the SOURCE's id — this is grackle's data dir`);
  return fails;
}

/**
 * Every apply refusal. Writer checks run first and stop the preflight, so a
 * held/live target is never read. Nothing here writes anything.
 */
export function preflightApply(opts, { srcBuf, src, probes }) {
  const first = writerChecks(opts, probes);
  if (first.length) return first;
  const fails = [];
  if (!opts.expectSha) fails.push("--expect-sha is required for apply");
  else if (sha256Buffer(srcBuf) !== String(opts.expectSha).toLowerCase()) {
    fails.push(`source sha256 mismatch: expected ${opts.expectSha}, got ${sha256Buffer(srcBuf)}`);
  }
  if (!opts.extract) fails.push("--extract is required for apply");
  const sv = userVersionOfBytes(srcBuf);
  let target = null;
  try { target = snapshotTarget(opts.target); } catch (err) { fails.push(`target unreadable: ${err.message}`); }
  try {
    const tv = target ? target.pragma("user_version", { simple: true }) : null;
    if (sv !== tv) fails.push(`user_version mismatch: source ${sv}, target ${tv}`);
    if (sv !== SCHEMA_GENERATION) fails.push(`source user_version ${sv} != SCHEMA_GENERATION ${SCHEMA_GENERATION}`);
    if (tv !== SCHEMA_GENERATION) fails.push(`target user_version ${tv} != SCHEMA_GENERATION ${SCHEMA_GENERATION}`);
    fails.push(...checkBackup(opts, target));
    if (target) {
      const sourceId = resolveSourceId(src, opts, fails);
      fails.push(...identityChecks(opts, probes, target, sourceId));
      const cov = peerCoverage(target, { selfId: readLocalInstanceId(), sourceId, peerMax: parsePeerMax(opts), excludes: opts.peerExclude || [] });
      fails.push(...cov.problems);
      const cls = classify(src, target, { importMedia: !!opts.importMedia, importDataDashboard: !!opts.importDataDashboard });
      fails.push(...ackProblems(cls.unclassified, opts.ackUnclassified));
    }
  } finally {
    target?.close();
  }
  return fails;
}

/** --ack-unclassified must list EXACTLY the unmapped tables that hold rows (I6). */
export function ackProblems(unclassified, ack) {
  const want = Object.keys(unclassified).sort();
  const got = [...new Set((ack || []).flatMap((a) => String(a).split(",")).map((s) => s.trim()).filter(Boolean))].sort();
  if (JSON.stringify(want) === JSON.stringify(got)) return [];
  const missing = want.filter((t) => !got.includes(t));
  const extra = got.filter((t) => !want.includes(t));
  return [`--ack-unclassified must list exactly the unmapped tables with rows (they go to the extract only): ` +
    `want [${want.join(",")}]` + (missing.length ? `; missing [${missing.join(",")}]` : "") + (extra.length ? `; not unclassified [${extra.join(",")}]` : "")];
}

function checkBackup(opts, target) {
  const fails = [];
  if (!opts.backupOk) return ["--backup-ok <cold-backup-path> is required for apply"];
  if (!existsSync(opts.backupOk)) return [`--backup-ok file not found: ${opts.backupOk}`];
  // the target itself, a symlink or a hardlink to it, is not a backup (I1)
  try {
    const a = statSync(opts.backupOk);
    const b = statSync(opts.target);
    if (realpathSync(opts.backupOk) === realpathSync(opts.target) || (a.dev === b.dev && a.ino === b.ino)) {
      return ["--backup-ok resolves to the target itself (same path or inode) — that is not a backup"];
    }
  } catch (err) {
    return [`cannot stat --backup-ok/target: ${err.message}`];
  }
  let bk;
  try {
    bk = openBytes(readFileSync(opts.backupOk));
    const ic = bk.pragma("integrity_check", { simple: true });
    if (ic !== "ok") fails.push(`--backup-ok failed integrity_check: ${ic}`);
  } catch (err) {
    return [`--backup-ok is not a readable SQLite database: ${err.message}`];
  }
  try {
    if (target) {
      // it must be a backup OF THIS TARGET, taken after its last write
      const a = countAll(target);
      const b = countAll(bk);
      const diff = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
      if (diff.length) fails.push(`--backup-ok does not match the target (row counts differ in: ${diff.slice(0, 8).join(", ")})`);
    }
    const bm = statSync(opts.backupOk).mtimeMs;
    // An EMPTY -wal is not a write: a read-only open creates one with a fresh mtime.
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

function newCtx(peerMax) {
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
    skippedSettings: [],
    bundleTablesCreated: [],
    driftRows: {},
    synced: {},
    renamed: [],
    listedRows: {},
    tombstonedContacts: new Set(),
    tombstonedList: [],
    eggsShelved: [],
    conflictRows: {},
  };
  ctx.conflicts = (table, c) => { (ctx.conflictRows[table] ||= []).push(c); };
  ctx.warn = (m) => ctx.warnings.push(m);
  ctx.inserted = (table, key) => { (ctx.insertedKeys[table] ||= []).push(key); };
  ctx.notImported = (table, row, reason) => ctx.notImportedRows.push({ table, row, reason });
  ctx.drift = (table, d) => { (ctx.driftRows[table] ||= []).push(d); };
  ctx.syncedMissing = (table, key) => {
    const s = (ctx.synced[table] ||= { missing_on_crow: 0, keys: [] });
    s.missing_on_crow++;
    if (s.keys.length < 200) s.keys.push(key);
  };
  ctx.listed = (table, r) => { (ctx.listedRows[table] ||= []).push(r); };
  return ctx;
}

export function parsePeerMax(opts) {
  const out = {};
  for (const v of opts.peerMaxMemoryId || []) {
    const m = String(v).match(/^([^=]+)=(\d+)$/);
    if (!m) throw new UsageError(`bad --peer-max-memory-id '${v}' (want <instance-id>=<n>)`);
    (out.memories ||= {})[m[1]] = Number(m[2]);
  }
  for (const v of opts.peerMaxId || []) {
    const m = String(v).match(/^([a-z_]+):([^=]+)=(\d+)$/);
    if (!m) throw new UsageError(`bad --peer-max-id '${v}' (want <table>:<instance-id>=<n>)`);
    if (!ID_EMIT_TABLES.includes(m[1])) throw new UsageError(`--peer-max-id table must be one of ${ID_EMIT_TABLES.join(", ")}`);
    (out[m[1]] ||= {})[m[2]] = Number(m[3]);
  }
  return out;
}

class UsageError extends Error {}

/** The source's own instance id: its is_home row, or --source-instance-id (they must agree). */
function resolveSourceId(src, opts, fails = null) {
  let home = null;
  if (tableExists(src, "crow_instances")) {
    try { home = src.prepare("SELECT id FROM crow_instances WHERE is_home = 1 LIMIT 1").get()?.id ?? null; } catch { home = null; }
  }
  const flag = opts.sourceInstanceId || null;
  if (home && flag && home !== flag) {
    fails?.push(`--source-instance-id ${flag} disagrees with the source's is_home row ${home}`);
    return flag;
  }
  if (!home && !flag) fails?.push("cannot tell the source's instance id (no is_home row): pass --source-instance-id");
  return flag || home;
}

function repoSha() {
  const r = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function bundleVersions() {
  const out = {};
  for (const g of Object.values(BUNDLE_GROUPS)) {
    try { out[g.id] = JSON.parse(readFileSync(join(REPO, "bundles", g.id, "manifest.json"), "utf8")).version ?? null; } catch { out[g.id] = null; }
  }
  return out;
}

function buildGoNoGo(ctx, emits, extra = {}) {
  const extractOnly = {};
  for (const t of Object.keys(ctx.classification.extract)) extractOnly[t] = ctx.sourceCounts[t] ?? 0;
  const rowsNotImported = ctx.notImportedRows.reduce((acc, r) => { acc[r.table] = (acc[r.table] || 0) + 1; return acc; }, {});
  return {
    unclassified_with_rows: ctx.classification.unclassified,
    extract_only_tables: extractOnly,
    rows_sent_to_extract: rowsNotImported,
    content_drift: Object.fromEntries(Object.entries(ctx.driftRows).map(([t, l]) => [t, { count: l.length, rows: l }])),
    synced_tables_missing_on_crow: ctx.synced,
    renamed_project_slugs: ctx.renamed,
    imported_schedules: ctx.listedRows.schedules || [],
    imported_crosspost_rules: ctx.listedRows.crosspost_rules || [],
    tombstoned_contacts: ctx.tombstonedList,
    eggs_shelved: ctx.eggsShelved,
    blog_slug_conflicts: ctx.conflictRows.blog_posts || [],
    phase_b_gates: emits?.gates ?? null,
    warnings: ctx.warnings.length,
    ...extra,
  };
}

function buildReport(base, ctx, extra) {
  return {
    ...base,
    per_table: ctx.perTable,
    remaps: Object.fromEntries([...ctx.remaps.maps.entries()]
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

function setupCtx(src, target, opts, peerMax) {
  const ctx = newCtx(peerMax);
  ctx.classification = classify(src, target, opts);
  ctx.sourceInstanceId = resolveSourceId(src, opts);
  ctx.targetInstanceId = readLocalInstanceId();
  ctx.sourceCounts = countAll(src);
  return ctx;
}

/** In-memory dry import: what apply would do to the target as it is now. */
async function dryRun(src, opts, peerMax) {
  const mem = snapshotTarget(opts.target);
  try {
    const ctx = setupCtx(src, mem, opts, peerMax);
    const coverage = peerCoverage(mem, { selfId: ctx.targetInstanceId, sourceId: ctx.sourceInstanceId, peerMax, excludes: opts.peerExclude || [] });
    const sourceStatus = sourceStatusOn(mem, ctx.sourceInstanceId);
    const before = countAll(mem);
    const walletBefore = walletBalances(mem);
    await phaseA(src, mem, opts, ctx);
    const after = countAll(mem);
    const emits = planEmits(ctx, { sourceStatus, coverageProblems: coverage.problems });
    return { ctx, before, after, walletBefore, walletAfter: walletBalances(mem), emits, coverage, sourceStatus };
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
  const probes = { ...defaultProbes, ...(deps.probes || {}) };
  const mode = opts.mode;
  if (!["plan", "rehearse", "apply", "emit-only"].includes(mode)) throw new UsageError(`unknown --mode '${mode}'`);
  if (!opts.target) throw new UsageError("--target is required");
  if (!opts.report) throw new UsageError("--report is required");
  const peerMax = parsePeerMax(opts);
  opts = { ...opts, peerExclude: opts.peerExclude || [] };

  if (mode === "emit-only") return runEmitOnly(opts, deps, peerMax, probes);
  if (!opts.source) throw new UsageError("--source is required");

  if (existsSync(`${opts.source}-wal`) && statSync(`${opts.source}-wal`).size > 0) {
    throw new Error(`source has a non-empty -wal next to it; its sha would not cover the data. Use the API backup file.`);
  }
  const srcBuf = readFileSync(opts.source);
  const sourceSha = sha256Buffer(srcBuf);
  const src = openBytes(srcBuf);
  try {
    const preWarnings = [];
    if (mode === "apply") {
      const fails = preflightApply(opts, { srcBuf, src, probes });
      if (fails.length) return { exitCode: 2, refused: fails, report: null };
    } else {
      // plan/rehearse must never read the LIVE crow.db under a running
      // gateway (the WAL lesson). Point them at an API backup copy.
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
      if (opts.expectSha && opts.expectSha.toLowerCase() !== sourceSha) {
        throw new Error(`source sha256 mismatch: expected ${opts.expectSha}, got ${sourceSha}`);
      }
      if (mode === "rehearse") {
        // rehearse runs phase B for real (on the copy): the instance id must exist and belong to the target
        const snap = snapshotTarget(opts.target);
        try {
          const fails = instanceIdChecks(snap, resolveSourceId(src, opts));
          if (fails.length) return { exitCode: 2, refused: fails, report: null };
        } finally { snap.close(); }
      } else if (!readLocalInstanceId()) {
        preWarnings.push(`instance-id file missing at ${instanceIdPath()} — settings overrides and peer coverage are approximate`);
      }
    }

    const optFlags = { importMedia: !!opts.importMedia, importDataDashboard: !!opts.importDataDashboard };
    const ctxOpts = { ...opts, ...optFlags };

    // the plan (in memory) — every mode computes it
    const plan = await dryRun(src, ctxOpts, peerMax);
    const versions = {
      source: src.pragma("user_version", { simple: true }),
      target: (() => { const t = snapshotTarget(opts.target); try { return t.pragma("user_version", { simple: true }); } finally { t.close(); } })(),
      schema_generation: SCHEMA_GENERATION,
      repo_sha: repoSha(),
      bundles: bundleVersions(),
    };
    const base = {
      mode,
      generated_at: new Date().toISOString(),
      source_path: resolve(opts.source),
      target_path: resolve(opts.target),
      source_sha: sourceSha,
      source_instance_id: plan.ctx.sourceInstanceId,
      target_instance_id: plan.ctx.targetInstanceId,
      versions,
      options: { ...optFlags, peer_max_ids: peerMax, peer_exclude: opts.peerExclude, ack_unclassified: opts.ackUnclassified || [] },
      peers: plan.coverage,
      preflight_warnings: preWarnings,
    };

    if (mode === "plan") {
      const report = buildReport({ ...base, target_before_counts: plan.before, target_after_counts: plan.after }, plan.ctx, {
        emits: { instance_id: null, planned: true, gates: plan.emits.gates, items: plan.emits.items },
        wallet: walletReport(plan.walletBefore, plan.walletAfter, plan.ctx.wallet.inserted_sum),
        go_no_go: buildGoNoGo(plan.ctx, plan.emits, { source_status_on_crow: plan.sourceStatus, peer_coverage_problems: plan.coverage.problems }),
      });
      writeJsonAtomic(opts.report, report);
      return { exitCode: 0, report };
    }

    // rehearse → scratch copy; apply → the real target
    let workPath = opts.target;
    let scratchDir = null;
    let extractPath = opts.extract;
    let simulatedRevoke = false;
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
      if (mode === "rehearse" && plan.ctx.sourceInstanceId && plan.sourceStatus && plan.sourceStatus !== "revoked") {
        // W3 revokes grackle before the import; simulate it on the COPY so
        // phase B is exercised. Reported, never done to a real target.
        tgt.prepare("UPDATE crow_instances SET status = 'revoked' WHERE id = ?").run(plan.ctx.sourceInstanceId);
        simulatedRevoke = true;
      }
      const ctx = setupCtx(src, tgt, ctxOpts, peerMax);
      const coverage = peerCoverage(tgt, { selfId: ctx.targetInstanceId, sourceId: ctx.sourceInstanceId, peerMax, excludes: opts.peerExclude });
      const baselineFk = mode === "rehearse" ? tgt.prepare("PRAGMA foreign_key_check").all() : [];
      const before = countAll(tgt);
      const walletBefore = walletBalances(tgt);

      // extract first: it reads only the source (plan ctx carries the row lists)
      writeExtract(extractPath, src, plan.ctx, { source_sha: sourceSha, generated_at: base.generated_at, mode });

      await phaseA(src, tgt, { ...optFlags, failAfterTables: deps.failAfterTables }, ctx);
      const after = countAll(tgt);
      const sourceStatus = sourceStatusOn(tgt, ctx.sourceInstanceId);
      const emits = planEmits(ctx, { sourceStatus, coverageProblems: coverage.problems });
      emits.instance_id = ctx.targetInstanceId;
      const report = buildReport({ ...base, target_before_counts: before, target_after_counts: after }, ctx, {
        extract_path: mode === "apply" ? resolve(extractPath) : null,
        emits,
        wallet: walletReport(walletBefore, walletBalances(tgt), ctx.wallet.inserted_sum),
        phase_a: "committed",
        go_no_go: buildGoNoGo(ctx, emits, { source_status_on_crow: sourceStatus, peer_coverage_problems: coverage.problems }),
      });
      if (sourceStatus !== "revoked") {
        report.phase_b_refused = `crow's row for the source instance reads '${sourceStatus ?? "missing"}', not 'revoked' — nothing queued. ` +
          "Revoke it (and confirm it sticks), then run --mode emit-only.";
      }
      const persist = mode === "apply" ? () => writeJsonAtomic(opts.report, report) : () => {};
      // report BEFORE phase B, then after every item, so emit-only resumes exactly
      persist();

      const emitter = await loadEmitter(deps.emitter);
      await phaseB(tgt, emits, emitter, persist);
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
          simulated_source_revoke: simulatedRevoke,
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

function summarizeEmits(emits) {
  const out = {};
  for (const i of emits.items) {
    const s = (out[i.table] ||= {});
    s[i.status] = (s[i.status] || 0) + 1;
  }
  return out;
}

/**
 * emit-only: only from a committed apply against THIS target (I8), with the
 * same writer/identity gates as apply and the same revoke + peer gates.
 */
async function runEmitOnly(opts, deps, peerMax, probes) {
  if (!existsSync(opts.report)) return { exitCode: 2, refused: [`report not found: ${opts.report}`], report: null };
  const prev = JSON.parse(readFileSync(opts.report, "utf8"));
  const fails = [];
  if (prev.mode !== "apply") fails.push(`report is from mode '${prev.mode}', not apply`);
  if (prev.phase_a !== "committed") fails.push("report's phase A is not committed");
  if (prev.target_path !== resolve(opts.target)) fails.push(`report is for target ${prev.target_path}, not ${resolve(opts.target)}`);
  if (!opts.expectSha) fails.push("--expect-sha (the source sha of the apply) is required");
  else if (String(opts.expectSha).toLowerCase() !== prev.source_sha) fails.push(`--expect-sha ${opts.expectSha} != the report's source_sha ${prev.source_sha}`);
  if (!prev.emits || !Array.isArray(prev.emits.items)) fails.push("report has no emits section");
  if (fails.length) return { exitCode: 2, refused: fails, report: null };

  const effectivePeers = Object.keys(peerMax).length ? peerMax : (prev.options?.peer_max_ids || {});
  const excludes = opts.peerExclude.length ? opts.peerExclude : (prev.options?.peer_exclude || []);
  const sourceId = opts.sourceInstanceId || prev.source_instance_id;
  const snap = snapshotTarget(opts.target);
  let coverage, sourceStatus;
  try {
    const v = snap.pragma("user_version", { simple: true });
    if (v !== SCHEMA_GENERATION) fails.push(`target user_version ${v} != SCHEMA_GENERATION ${SCHEMA_GENERATION}`);
    fails.push(...identityChecks(opts, probes, snap, sourceId));
    coverage = peerCoverage(snap, { selfId: readLocalInstanceId(), sourceId, peerMax: effectivePeers, excludes });
    sourceStatus = sourceStatusOn(snap, sourceId);
  } finally {
    snap.close();
  }
  if (fails.length) return { exitCode: 2, refused: fails, report: null };

  // re-evaluate every gate (revoke, coverage, range)
  const byTable = {};
  for (const it of prev.emits.items) (byTable[it.table] ||= []).push(it);
  const gates = {};
  for (const [table, items] of Object.entries(byTable)) {
    const spec = IMPORT_SPECS.find((s) => s.table === table);
    let gate = null;
    if (sourceStatus !== "revoked") gate = `source-not-revoked (crow's row for the source reads '${sourceStatus ?? "missing"}')`;
    else if (spec?.emit === "id" && coverage.problems.length) gate = "peer-coverage-incomplete";
    else if (spec?.emit === "id") gate = idGate(table, items.map((i) => i.key.id), effectivePeers);
    gates[table] = gate ? { open: false, reason: gate } : { open: true };
    for (const it of items) {
      if (it.status === "queued") continue;
      if (gate) { it.status = "gated"; it.reason = gate; } else if (it.status === "gated") { it.status = "pending"; it.reason = undefined; }
    }
  }
  const tgt = new Database(opts.target, { fileMustExist: true });
  try {
    tgt.pragma("busy_timeout = 30000");
    const emits = { ...prev.emits, gates };
    const report = {
      ...prev, emits, emit_only_at: new Date().toISOString(),
      peers: coverage,
      options: { ...(prev.options || {}), peer_max_ids: effectivePeers, peer_exclude: excludes },
    };
    delete report.phase_b_refused;
    if (sourceStatus !== "revoked") report.phase_b_refused = `crow's row for the source reads '${sourceStatus ?? "missing"}', not 'revoked'`;
    const persist = () => writeJsonAtomic(opts.report, report);
    const emitter = await loadEmitter(deps.emitter);
    await phaseB(tgt, emits, emitter, persist, { requeue: !!opts.requeue });
    report.phase_b = summarizeEmits(emits);
    persist();
    return { exitCode: 0, report };
  } finally {
    tgt.close();
  }
}

/* ===================================================================== CLI */

export function parseArgs(argv) {
  const opts = { peerMaxMemoryId: [], peerMaxId: [], peerExclude: [], ackUnclassified: [] };
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
      case "--source-instance-id": opts.sourceInstanceId = val(i, a); i++; break;
      case "--peer-max-memory-id": opts.peerMaxMemoryId.push(val(i, a)); i++; break;
      case "--peer-max-id": opts.peerMaxId.push(val(i, a)); i++; break;
      case "--peer-exclude": opts.peerExclude.push(val(i, a)); i++; break;
      case "--ack-unclassified": opts.ackUnclassified.push(val(i, a)); i++; break;
      case "--import-media": opts.importMedia = true; break;
      case "--import-data-dashboard": opts.importDataDashboard = true; break;
      case "--keep-scratch": opts.keepScratch = true; break;
      case "--requeue": opts.requeue = true; break;
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
      console.error(`[grackle-d3] ${opts.mode} REFUSED — nothing was written:\n  - ${res.refused.join("\n  - ")}`);
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
    if (r?.phase_b_refused) console.log(`  ⚠ PHASE B REFUSED: ${r.phase_b_refused}`);
    const g = r?.go_no_go;
    if (g) {
      console.log(`  go/no-go: unclassified-with-rows ${JSON.stringify(g.unclassified_with_rows)}`);
      console.log(`            content drift ${JSON.stringify(Object.fromEntries(Object.entries(g.content_drift).map(([t, d]) => [t, d.count])))}`);
      console.log(`            synced rows missing on crow ${JSON.stringify(Object.fromEntries(Object.entries(g.synced_tables_missing_on_crow).map(([t, d]) => [t, d.missing_on_crow])))}`);
      if (g.peer_coverage_problems?.length) console.log(`            peer coverage:\n              ${g.peer_coverage_problems.join("\n              ")}`);
    }
    if (r?.rehearse) console.log(`  rehearse ok: ${r.rehearse.ok}${r.rehearse.simulated_source_revoke ? " (source revoke simulated on the copy)" : ""}`);
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
