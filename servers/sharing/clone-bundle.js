/**
 * Crow Sharing — Project Clone Bundle Helpers
 *
 * Factory: createCloneBundleHelpers(ctx) → { buildProjectCloneBundle, applyProjectCloneBundle }
 * ctx provides { db } — other dependencies are module-level imports.
 *
 * SECURITY: the slug-traversal hardening in applyProjectCloneBundle
 * (lines from W2-5B2 commit 27e7c77) must remain byte-identical — do not
 * edit logic or comments in that block.
 */

import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";
import {
  AclError,
  appendAudit,
} from "../shared/project-acl.js";
import { slugify, workspacePathFor, storagePrefixFor } from "../shared/slugify.js";
import { createProjectSpace } from "../shared/project-spaces.js";
import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { resolveDataDir } from "../db.js";

export function createCloneBundleHelpers(ctx) {
  const { db } = ctx;

  // Build a point-in-time clone bundle for a project. The bundle is the
  // entire payload that travels over Hyperswarm to the recipient. Includes:
  //   - project metadata (project_spaces row, minus instance-specific fields)
  //   - all research_sources + research_notes belonging to the project
  //   - data_backends MANIFESTS (env-var names only; secrets never leave the
  //     origin)
  //   - storage_files manifest (key + size + presigned URL valid 24h);
  //     receivers can pull these out-of-band if they want the blobs
  //   - audit log up to the snapshot timestamp
  // Note: subscription (per-project Hypercore feed) is deferred to a later
  // milestone. Clone is one-shot and stays a frozen snapshot on the receiver.
  async function buildProjectCloneBundle(projectId) {
    const project = (await db.execute({
      sql: `SELECT id, uuid, slug, name, description, type, tags, created_at, updated_at
              FROM project_spaces WHERE id = ?`,
      args: [projectId],
    })).rows[0];
    if (!project) throw new Error(`project #${projectId} not found in project_spaces`);

    const sources = (await db.execute({
      sql: `SELECT * FROM research_sources WHERE project_id = ?`,
      args: [projectId],
    })).rows;

    const notes = (await db.execute({
      sql: `SELECT * FROM research_notes WHERE project_id = ?`,
      args: [projectId],
    })).rows;

    const backends = (await db.execute({
      sql: `SELECT id, uuid, name, backend_type, connection_ref, tags FROM data_backends WHERE project_id = ?`,
      args: [projectId],
    })).rows;

    const auditLog = (await db.execute({
      sql: `SELECT actor_type, actor_id, action, target, payload, created_at
              FROM project_audit_log
             WHERE project_id = ?
             ORDER BY created_at ASC`,
      args: [projectId],
    })).rows;

    const files = (await db.execute({
      sql: `SELECT s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, uuid
              FROM storage_files WHERE project_id = ?`,
      args: [projectId],
    })).rows;

    return {
      bundle_version: 1,
      snapshot_at: new Date().toISOString(),
      origin_instance_id: getOrCreateLocalInstanceId(),
      project,        // includes uuid + slug
      sources,
      notes,
      backends,       // env var names only — no secrets
      audit_log: auditLog,
      file_manifest: files,
    };
  }

  // Apply an incoming clone bundle. Creates a new project_spaces row with a
  // distinct local id + a `-clone-N` slug suffix, then inserts the carried
  // sources/notes/audit with NEW local int IDs (UUIDs preserved). Does NOT
  // open data_backends or transfer files (manifests only — operator action
  // required for backends; files can be pulled out-of-band via the manifest).
  async function applyProjectCloneBundle(bundle, originContactId) {
    if (!bundle || bundle.bundle_version !== 1) {
      throw new Error("incompatible bundle version");
    }
    const orig = bundle.project;

    // Compute next -clone-N slug suffix.
    // SECURITY: never trust the peer's slug verbatim — it flows into a
    // filesystem path (workspacePathFor) and a storage key (storagePrefixFor),
    // so a hostile bundle with slug "../../etc/x" could escape the data dir.
    // Always re-derive locally via slugify (emits only [a-z0-9-]) and assert
    // the shape before using it.
    const baseSlug = slugify(orig.name || orig.slug || "imported");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(baseSlug) || baseSlug.length > 60) {
      throw new Error("invalid project slug derived from clone bundle");
    }
    let suffix = 1;
    let candidate = `${baseSlug}-clone-${suffix}`;
    while (true) {
      const hit = (await db.execute({
        sql: "SELECT 1 FROM project_spaces WHERE slug = ?",
        args: [candidate],
      })).rows[0];
      if (!hit) break;
      suffix += 1;
      candidate = `${baseSlug}-clone-${suffix}`;
    }
    const newSlug = candidate;

    // Compute workspace dir + storage prefix for the new clone
    const dataDir = process.env.CROW_DB_PATH
      ? resolvePath(process.env.CROW_DB_PATH, "..")
      : resolveDataDir();
    const workspaceDir = workspacePathFor(dataDir, newSlug);
    const storagePref = storagePrefixFor(newSlug);
    // Defense in depth: the derived slug is already sanitized, but confirm the
    // resolved workspace path stays inside dataDir before creating it.
    const resolvedRoot = resolvePath(dataDir);
    const resolvedWs = resolvePath(workspaceDir);
    if (resolvedWs !== resolvedRoot && !resolvedWs.startsWith(resolvedRoot + "/")) {
      throw new Error("clone workspace path escaped data dir");
    }
    try { mkdirSync(resolvedWs, { recursive: true }); } catch {}

    // Insert the new project_spaces row via the shared helper (explicitSlug
    // mode: we own the -clone-N slug + path-containment assertion above;
    // the helper computes workspace_dir/storage_prefix from the slug).
    // ownerMember:false — clone path supplies its own richer member row below
    // (role='owner', mode='clone', granted_by_contact_id=originContactId).
    const { id: newProjectId } = await createProjectSpace(db, {
      explicitSlug: newSlug,
      name: `${orig.name} (clone)`,
      description: orig.description ?? null,
      type: orig.type ?? "general",
      tags: orig.tags ?? null,
      originInstanceId: bundle.origin_instance_id ?? null,
      ownerMember: false,
    });

    // Owner row for the local user on this clone (richer than the helper default:
    // mode='clone' records provenance; granted_by_contact_id links to sender).
    await db.execute({
      sql: `INSERT INTO project_members (project_id, contact_id, role, mode, granted_by_contact_id)
            VALUES (?, NULL, 'owner', 'clone', ?)`,
      args: [newProjectId, originContactId ?? null],
    });

    // Source id remap so notes that reference a source still point at the
    // right (newly inserted) row.
    const sourceIdMap = new Map();
    for (const s of bundle.sources || []) {
      const r = await db.execute({
        sql: `INSERT INTO research_sources
                (project_id, title, source_type, url, authors, publication_date, publisher,
                 doi, isbn, abstract, content_summary, full_text, citation_apa,
                 retrieval_date, retrieval_method, verified, verification_notes,
                 tags, relevance_score, uuid, origin_instance_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newProjectId,
          s.title ?? "(untitled)",
          s.source_type ?? "other",
          s.url ?? null, s.authors ?? null, s.publication_date ?? null, s.publisher ?? null,
          s.doi ?? null, s.isbn ?? null, s.abstract ?? null, s.content_summary ?? null,
          s.full_text ?? null, s.citation_apa ?? "(no citation)",
          s.retrieval_date ?? null, s.retrieval_method ?? null,
          s.verified ?? 0, s.verification_notes ?? null,
          s.tags ?? null, s.relevance_score ?? 5,
          s.uuid ?? null, bundle.origin_instance_id ?? null,
        ],
      });
      if (s.id != null) sourceIdMap.set(s.id, Number(r.lastInsertRowid));
    }

    for (const n of bundle.notes || []) {
      const remappedSourceId = (n.source_id != null && sourceIdMap.has(n.source_id))
        ? sourceIdMap.get(n.source_id)
        : null;
      await db.execute({
        sql: `INSERT INTO research_notes
                (project_id, source_id, title, content, note_type, tags, uuid, origin_instance_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newProjectId, remappedSourceId,
          n.title ?? null, n.content ?? "",
          n.note_type ?? "note",
          n.tags ?? null,
          n.uuid ?? null, bundle.origin_instance_id ?? null,
        ],
      });
    }

    // Audit log entries from the origin's timeline, then append the local
    // share.received entry to mark the boundary.
    for (const a of bundle.audit_log || []) {
      await db.execute({
        sql: `INSERT INTO project_audit_log (project_id, actor_type, actor_id, action, target, payload, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newProjectId,
          a.actor_type ?? "system",
          a.actor_id ?? null,
          a.action ?? "(unknown)",
          a.target ?? null,
          a.payload ?? null,
          a.created_at ?? new Date().toISOString(),
        ],
      });
    }
    await appendAudit(db, {
      project_id: newProjectId, actor_type: "system",
      action: "share.received",
      target: originContactId ? `contact:${originContactId}` : null,
      payload: {
        bundle_version: bundle.bundle_version,
        snapshot_at: bundle.snapshot_at,
        origin_instance_id: bundle.origin_instance_id ?? null,
        backends_in_manifest: (bundle.backends || []).length,
        files_in_manifest: (bundle.file_manifest || []).length,
      },
    });

    return {
      project_id: newProjectId,
      slug: newSlug,
      sources_imported: bundle.sources?.length || 0,
      notes_imported: bundle.notes?.length || 0,
      audit_imported: bundle.audit_log?.length || 0,
      backends_in_manifest: bundle.backends?.length || 0,
      files_in_manifest: bundle.file_manifest?.length || 0,
    };
  }

  return { buildProjectCloneBundle, applyProjectCloneBundle };
}
