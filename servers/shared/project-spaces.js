/**
 * Shared project-spaces creation helper.
 *
 * Two call sites today (bot-board-api, sharing/server) each hand-rolled
 * their own INSERT — producing slug drift and missing owner member rows.
 * This module is the single authoritative path for writing a new
 * project_spaces row.
 *
 * Exported functions:
 *   createProjectSpace(db, opts)      — insert ps row + owner member row, one batch
 *   updateProjectSpaceMeta(db, id, patch) — update meta columns, no re-slug
 */

import { slugify, workspacePathFor, storagePrefixFor } from "./slugify.js";
import { resolveDataDir } from "../db.js";
import { resolve } from "node:path";

/**
 * Create a new project_spaces row and its owner project_members row in one
 * atomic db.batch() call.
 *
 * Default slug mode:
 *   The insert goes in first without a slug, then slug + workspace_dir are
 *   set via a second statement that reads the auto-assigned id — all inside
 *   the same batch transaction, so no other writer can observe the temp state.
 *
 * Explicit slug mode (pass opts.explicitSlug):
 *   The caller supplies the final slug (e.g. the "-clone-N" form from the
 *   sharing clone path). workspace_dir and storage_prefix are still computed
 *   here from that slug. The path-containment assertion STAYS in the caller.
 *
 * Owner member row:
 *   Inserted with INSERT OR IGNORE so callers that already have their own
 *   member-insertion logic (or the trigger) can't cause a conflict. Pass
 *   opts.ownerMember = false to skip the member row entirely.
 *
 * @param {object} db       — a createDbClient()-shaped DB handle
 * @param {object} opts
 *   @param {string}  opts.name
 *   @param {string}  [opts.description]
 *   @param {string}  [opts.type]              default 'general'
 *   @param {string}  [opts.status]            default 'active'
 *   @param {string}  [opts.tags]
 *   @param {number|null} [opts.ownerContactId]  null = local user
 *   @param {string}  [opts.originInstanceId]
 *   @param {string}  [opts.explicitSlug]      skip slug derivation, use as-is
 *   @param {boolean} [opts.ownerMember]       default true; false to omit member row
 * @returns {{ id: number, slug: string, workspaceDir: string, storagePrefix: string }}
 */
export async function createProjectSpace(db, opts = {}) {
  const {
    name,
    description = null,
    type = "general",
    status = "active",
    tags = null,
    ownerContactId = null,
    originInstanceId = null,
    explicitSlug = null,
    ownerMember = true,
  } = opts;

  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("createProjectSpace: name is required");
  }

  // Resolve data dir the same way the rest of the codebase does.
  const dataDir = process.env.CROW_DB_PATH
    ? resolve(process.env.CROW_DB_PATH, "..")
    : resolveDataDir();

  if (explicitSlug) {
    // --- Explicit slug mode ---
    // Caller owns slug derivation; we own workspace_dir / storage_prefix.
    const workspaceDir = workspacePathFor(dataDir, explicitSlug);
    const storagePrefix = storagePrefixFor(explicitSlug);

    const stmts = [
      {
        sql: `INSERT INTO project_spaces
                (slug, name, description, type, status, tags,
                 workspace_dir, storage_prefix, origin_instance_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          explicitSlug,
          name.trim(),
          description,
          type,
          status,
          tags,
          workspaceDir,
          storagePrefix,
          originInstanceId,
        ],
      },
      // Keep rp's AUTOINCREMENT sequence ≥ max(ps.id) so that a subsequent
      // legacy INSERT INTO research_projects cannot collide with a ps-only id.
      // Seed MUST use WHERE NOT EXISTS — sqlite_sequence has no unique constraint
      // so INSERT OR IGNORE would accumulate duplicate rows (undefined behavior).
      // Guard is last: the seed INSERT resets last_insert_rowid(); placing it
      // before any statement that consumes that value would silently corrupt it.
      {
        sql: `INSERT INTO sqlite_sequence(name, seq)
              SELECT 'research_projects', 0
              WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'research_projects')`,
        args: [],
      },
      {
        sql: `UPDATE sqlite_sequence
                 SET seq = MAX(seq, COALESCE((SELECT MAX(id) FROM project_spaces), 0))
               WHERE name = 'research_projects'`,
        args: [],
      },
    ];

    const [insResult] = await db.batch(stmts);
    const id = Number(insResult.lastInsertRowid);

    if (ownerMember) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO project_members
                (project_id, contact_id, role, granted_by_contact_id)
              VALUES (?, ?, 'owner', NULL)`,
        args: [id, ownerContactId],
      });
    }

    return { id, slug: explicitSlug, workspaceDir, storagePrefix };
  }

  // --- Default slug mode ---
  // We don't know the id pre-insert, so the slug/workspace_dir/storage_prefix
  // are composed IN SQL via last_insert_rowid() — all three statements run
  // inside ONE db.batch() transaction, so no temp-slug state is ever visible
  // to other connections and concurrent same-name creates cannot collide.
  const base = slugify(name.trim());
  const statements = [
    // Statement 0: insert with the name-only base as a placeholder slug.
    // It is finalized by statement 1 before the transaction commits.
    {
      sql: `INSERT INTO project_spaces
              (slug, name, description, type, status, tags,
               storage_prefix, origin_instance_id)
            VALUES (?, ?, ?, ?, ?, ?, 'projects/tmp/', ?)`,
      args: [base, name.trim(), description, type, status, tags, originInstanceId],
    },
    // Statement 1: finalize slug + paths using the new row's id.
    {
      sql: `UPDATE project_spaces
               SET slug = ? || '-' || id,
                   workspace_dir = ? || '/projects/' || ? || '-' || id || '/workspace',
                   storage_prefix = 'projects/' || ? || '-' || id || '/'
             WHERE id = last_insert_rowid()`,
      args: [base, dataDir, base, base],
    },
  ];
  if (ownerMember) {
    statements.push({
      sql: `INSERT OR IGNORE INTO project_members
              (project_id, contact_id, role, granted_by_contact_id)
            VALUES (last_insert_rowid(), ?, 'owner', NULL)`,
      args: [ownerContactId],
    });
  }

  // Keep rp's AUTOINCREMENT sequence ≥ max(ps.id) so that a subsequent
  // legacy INSERT INTO research_projects cannot collide with a ps-only id.
  // Seed MUST use WHERE NOT EXISTS — sqlite_sequence has no unique constraint
  // so INSERT OR IGNORE would accumulate duplicate rows (undefined behavior).
  // Guard is last: the seed INSERT resets last_insert_rowid(); placing it
  // before the slug-finalize UPDATE or member INSERT above would silently
  // corrupt the ids those statements consume.
  statements.push(
    {
      sql: `INSERT INTO sqlite_sequence(name, seq)
            SELECT 'research_projects', 0
            WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'research_projects')`,
      args: [],
    },
    {
      sql: `UPDATE sqlite_sequence
               SET seq = MAX(seq, COALESCE((SELECT MAX(id) FROM project_spaces), 0))
             WHERE name = 'research_projects'`,
      args: [],
    }
  );

  const results = await db.batch(statements);
  const id = Number(results[0].lastInsertRowid);
  const slug = `${base}-${id}`;
  const workspaceDir = workspacePathFor(dataDir, slug);
  const storagePrefix = storagePrefixFor(slug);

  return { id, slug, workspaceDir, storagePrefix };
}

/**
 * Update metadata columns on an existing project_spaces row.
 * Does NOT re-slug — slug is stable after creation for helper-created rows.
 * Accepts any subset of { name, description, status, tags }.
 *
 * @param {object} db
 * @param {number} id
 * @param {object} patch  — { name?, description?, status?, tags? }
 * @returns {number} rowsAffected
 */
export async function updateProjectSpaceMeta(db, id, patch = {}) {
  const sets = [];
  const args = [];

  if (patch.name != null) {
    const trimmed = String(patch.name).trim();
    if (!trimmed) throw new Error("updateProjectSpaceMeta: name cannot be empty");
    sets.push("name = ?");
    args.push(trimmed);
  }
  if ("description" in patch) {
    sets.push("description = ?");
    args.push(patch.description ?? null);
  }
  if (patch.status != null) {
    sets.push("status = ?");
    args.push(String(patch.status));
  }
  if (patch.tags != null) {
    sets.push("tags = ?");
    args.push(String(patch.tags));
  }

  if (sets.length === 0) return 0;

  sets.push("updated_at = datetime('now')");
  args.push(id);

  const result = await db.execute({
    sql: `UPDATE project_spaces SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });

  return result.rowsAffected;
}
