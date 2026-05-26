// Project-space ACL helper.
//
// Used by:
//   - servers/research/server.js  (M2 — new project tools + source/note write gates)
//   - servers/storage/server.js   (M2 — upload write gate when project_id is set)
//   - servers/gateway/routes/storage-http.js (M2 — upload route ACL)
//   - bot bridge / panels (M3+)
//
// Phase 1 design (see ~/.claude/plans/yeah-let-s-do-some-shimmering-key.md):
//   - Five roles set DEFAULT capability bundles.
//   - `project_members.capabilities` JSON column overrides defaults PER MEMBER
//     (mirrors the per-bot permission_policy shape in pi_bot_defs).
//   - Bots are NOT members — they're actors recorded in project_audit_log; their
//     capabilities live in pi_bot_defs.permission_policy. Never look bot up here.
//   - `contact_id IS NULL` means the local user. Partial UNIQUE indexes in M1
//     ensure exactly one active local-owner row per project.
//   - "Active" = `revoked_at IS NULL`. Revoked members do not have capabilities.
//   - `query_backend` capability boolean acts as a gate; `query_backend:<id>`
//     overrides specifically allow/deny a particular backend.

export class AclError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AclError";
    this.code = code || "forbidden";
  }
}

export const ROLES = ["owner", "editor", "viewer", "guest"];

// All Phase 1 capability keys. Booleans default false unless the role grants them.
// `query_backend:<id>` is a free-form per-backend override; see resolveCapabilities.
export const CAPABILITY_KEYS = [
  "read_sources", "read_notes", "read_files", "read_tasks",
  "write_sources", "write_notes", "write_files", "write_tasks",
  "invoke_bot",
  "query_backend",
  "manage_members", "delete_project",
];

const ALL_TRUE = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, true]));
const ALL_FALSE = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]));

const READ_ALL = {
  ...ALL_FALSE,
  read_sources: true, read_notes: true, read_files: true, read_tasks: true,
};
const READ_WRITE_ALL = {
  ...READ_ALL,
  write_sources: true, write_notes: true, write_files: true, write_tasks: true,
};

export const DEFAULT_CAPABILITIES_BY_ROLE = Object.freeze({
  owner: { ...ALL_TRUE },
  editor: { ...READ_WRITE_ALL, invoke_bot: true, query_backend: true },
  viewer: { ...READ_ALL },
  guest: { ...ALL_FALSE, read_sources: true, read_notes: true },
});

// Merge a role's defaults with per-member overrides. Overrides may include
// the boolean `query_backend` master gate AND backend-specific
// `query_backend:<id>: true|false` overrides — both are preserved in the
// returned object so callers can check `caps["query_backend:tea-data"]`.
export function resolveCapabilities(role, overridesJson) {
  const base = DEFAULT_CAPABILITIES_BY_ROLE[role] || ALL_FALSE;
  if (!overridesJson) return { ...base };
  let overrides;
  try {
    overrides = typeof overridesJson === "string" ? JSON.parse(overridesJson) : overridesJson;
  } catch {
    return { ...base };
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides || {})) {
    out[k] = !!v;
  }
  return out;
}

// Find an active membership row for (project_id, contact_id) where contact_id
// matches the convention: pass `null` (or the string "local") for the local user.
async function findMembership(db, projectId, contactId) {
  const isLocal = contactId == null || contactId === "local";
  const sql = isLocal
    ? `SELECT id, project_id, contact_id, role, capabilities, granted_at, revoked_at
         FROM project_members
        WHERE project_id = ? AND contact_id IS NULL AND revoked_at IS NULL
        LIMIT 1`
    : `SELECT id, project_id, contact_id, role, capabilities, granted_at, revoked_at
         FROM project_members
        WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL
        LIMIT 1`;
  const args = isLocal ? [projectId] : [projectId, contactId];
  const { rows } = await db.execute({ sql, args });
  return rows[0] || null;
}

export async function assertProjectExists(db, projectId, { allowArchived = false } = {}) {
  const { rows } = await db.execute({
    sql: "SELECT id, slug, name, archived_at FROM project_spaces WHERE id = ? LIMIT 1",
    args: [projectId],
  });
  const project = rows[0];
  if (!project) throw new AclError(`Project #${projectId} not found`, "not_found");
  if (!allowArchived && project.archived_at) {
    throw new AclError(`Project #${projectId} is archived`, "archived");
  }
  return project;
}

export async function effectiveCapabilities(db, projectId, contactId) {
  const m = await findMembership(db, projectId, contactId);
  if (!m) return null;
  return {
    role: m.role,
    member_id: m.id,
    capabilities: resolveCapabilities(m.role, m.capabilities),
  };
}

export async function assertCapability(db, projectId, contactId, capability) {
  await assertProjectExists(db, projectId);
  const eff = await effectiveCapabilities(db, projectId, contactId);
  if (!eff) {
    const who = contactId == null || contactId === "local" ? "local user" : `contact #${contactId}`;
    throw new AclError(`${who} is not a member of project #${projectId}`, "not_member");
  }
  if (!eff.capabilities[capability]) {
    throw new AclError(
      `${eff.role} role on project #${projectId} lacks capability '${capability}'`,
      "missing_capability"
    );
  }
  return eff;
}

// Convenience for source/note/file write paths: returns true if the caller can
// proceed, else throws AclError. Tools call this as the first thing inside
// their handler when project_id is set.
export async function assertLocalCapability(db, projectId, capability) {
  return assertCapability(db, projectId, null, capability);
}

// Audit-log helper. Tools call this on successful mutating operations so the
// project's timeline reflects what happened.
export async function appendAudit(db, { project_id, actor_type, actor_id = null, action, target = null, payload = null }) {
  try {
    await db.execute({
      sql: `INSERT INTO project_audit_log (project_id, actor_type, actor_id, action, target, payload)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        project_id,
        actor_type,
        actor_id,
        action,
        target,
        payload == null ? null : (typeof payload === "string" ? payload : JSON.stringify(payload)),
      ],
    });
  } catch (err) {
    // Audit failures must never break the primary action.
    console.warn(`Warning: project_audit_log append failed (project=${project_id}, action=${action}): ${err.message}`);
  }
}
