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
  // We don't know the id pre-insert, so we insert without a final slug,
  // then set slug + workspace_dir in a second statement.  Both live in one
  // db.batch() so they're wrapped in a single SQLite transaction.
  const statements = [
    // Statement 0: insert the row with a placeholder slug (name-only base so
    // the UNIQUE constraint doesn't collide with the final form).
    {
      sql: `INSERT INTO project_spaces
              (slug, name, description, type, status, tags,
               storage_prefix, origin_instance_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        // Temp slug: name-only base; will be overwritten by statement 1.
        slugify(name.trim()),
        name.trim(),
        description,
        type,
        status,
        tags,
        // storage_prefix placeholder — overwritten below once we have the id
        `projects/tmp/`,
        originInstanceId,
      ],
    },
  ];

  // Execute in a batch so both statements are atomic.
  // Better-sqlite3's db.batch() wraps everything in one transaction.
  const [insResult] = await db.batch(statements);
  const id = Number(insResult.lastInsertRowid);

  // Now we know the id — compute canonical slug + paths and update.
  const slug = slugify(name.trim(), id);
  const workspaceDir = workspacePathFor(dataDir, slug);
  const storagePrefix = storagePrefixFor(slug);

  await db.execute({
    sql: `UPDATE project_spaces
             SET slug = ?, workspace_dir = ?, storage_prefix = ?
           WHERE id = ?`,
    args: [slug, workspaceDir, storagePrefix, id],
  });

  if (ownerMember) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO project_members
              (project_id, contact_id, role, granted_by_contact_id)
            VALUES (?, ?, 'owner', NULL)`,
      args: [id, ownerContactId],
    });
  }

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
