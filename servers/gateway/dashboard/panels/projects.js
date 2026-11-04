/**
 * Projects Panel — Browse, manage, and search research projects.
 *
 * List view: all projects with status badges, source/note/backend counts
 * Detail view: project overview, sources, notes, linked backends
 * Actions: create, change status, archive
 * Search: FTS across project sources and notes
 */

import { escapeHtml, section, badge, dataTable, formField, actionBar, formatDate } from "../shared/components.js";
import { t, tJs, fill } from "../shared/i18n.js";
import { sanitizeFtsQuery, escapeLikePattern } from "../../../db.js";
import {
  AclError,
  ROLES,
  resolveCapabilities,
  assertLocalCapability,
  appendAudit,
} from "../../../shared/project-acl.js";
import { createProjectSpace, updateProjectSpaceMeta } from "../../../shared/project-spaces.js";
import { approveBackend, revokeBackendApproval, hasApproval, refHash, parseStoredSpec, visibleText, pinnedFiles, backendEnvNames } from "../../../shared/data-backend-approval.js";
import { csrfInput } from "../shared/csrf.js";
import { canOwnProject } from "../../../shared/project-lifecycle.js";
import {
  handleLifecyclePost, deleteConfirmHtml, lifecycleRules, detailControlsHtml, archivedRowActionsHtml, resultBannerHtml,
} from "../shared/project-lifecycle-ui.js";
import { statSync } from "node:fs";
import { statusCode } from "../../../research/fetch-labels.js";
// Crow-to-Crow sharing (plan 1, task 7B). The owner's side lives in the sharing
// runtime (owner.js) and the visitor's in visitor.js; this panel only draws what
// those two read back, and its client posts to /dashboard/c2c-api (routes/c2c-api.js).
import { listLiveMembers } from "../../../sharing/c2c/owner.js";
import { listVisits } from "../../../sharing/c2c/visitor.js";
import { ROLES as C2C_ROLES } from "../../../sharing/c2c/frames.js";
import { isCbPinnedStrict } from "../../../sharing/contact-binding.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";

const PAGE_SIZE = 20;

// Fetch-status chips. The wording comes from servers/research/fetch-labels.js (shared with
// the research tools); the panel only maps each status CODE to a translation and a badge kind.
const FETCH_CHIP = {
  fetched: ["projects.fetch.fetched", "connected"],
  fetched_no_text: ["projects.fetch.noText", "draft"],
  failed: ["projects.fetch.failed", "error"],
  legacy: ["projects.fetch.legacy", "draft"],
  not_applicable: ["projects.fetch.notWeb", "draft"],
  unknown: ["projects.fetch.unknown", "draft"],
};

/** Whether the 0013 provenance columns exist (old DBs degrade to no status). */
async function provenanceReady(db) {
  try {
    const src = await db.execute("PRAGMA table_info(research_sources)");
    const notes = await db.execute("PRAGMA table_info(research_notes)");
    return src.rows.some((c) => c.name === "fetch_status") && notes.rows.some((c) => c.name === "quote_found");
  } catch {
    return false;
  }
}

/** Whether notes can be withdrawn (0015); old DBs list every note, as before. */
async function withdrawReady(db) {
  try {
    const notes = await db.execute("PRAGMA table_info(research_notes)");
    return notes.rows.some((c) => c.name === "withdrawn_at");
  } catch {
    return false;
  }
}

/** A link only for http(s) URLs; anything else (javascript:, data:, ...) is plain escaped text. */
export function sourceLinkHtml(url) {
  if (!url) return "";
  let ok = false;
  try { ok = ["http:", "https:"].includes(new URL(String(url)).protocol); } catch { /* not a URL */ }
  return ok
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--crow-accent);font-size:0.8rem">link</a>`
    : `<span style="font-size:0.8rem;color:var(--crow-text-muted)">${escapeHtml(url)}</span>`;
}

/** The compact fetch-status chip (+ quote check count) for one source row. */
export function fetchChipHtml(s, lang) {
  const [key, kind] = FETCH_CHIP[statusCode(s.fetch_status)];
  let html = badge(t(key, lang), kind);
  const total = Number(s.quote_total || 0);
  if (total > 0) {
    html += ` <span style="font-size:0.75rem;color:var(--crow-text-muted)">${escapeHtml(fill(t("projects.fetch.quotes", lang), { found: Number(s.quote_found_count || 0), total }))}</span>`;
  }
  return html;
}

const STATUS_BADGE_MAP = {
  active: "connected",
  paused: "draft",
  completed: "published",
  archived: "draft",
};

export default {
  id: "projects",
  name: "Projects",
  icon: "folder",
  route: "/dashboard/projects",
  navOrder: 13,
  category: "content",

  async handler(req, res, { db, layout, lang }) {
    // --- POST Actions ---
    if (req.method === "POST") {
      const { action } = req.body;

      // Archive, Restore, Delete (§15): owner-only, re-checked on the server, named options only.
      if (["archive_project", "restore_project", "delete_project"].includes(action)) {
        const pid = Number(req.body.id);
        const handled = await handleLifecyclePost(req, res, {
          db, lang, layout, projectId: pid, forbiddenHtml: `<p role="alert">${escapeHtml(t("projectHome.forbidden", lang))}</p>`,
          urls: { post: "/dashboard/projects", confirm: (extra) => `/dashboard/projects?delete=${pid}&${extra}` },
        });
        if (handled) return handled.page;
      }

      if (action === "create") {
        const { name, description, type, tags } = req.body;
        if (!name?.trim()) {
          return res.redirectAfterPost("/dashboard/projects?error=name_required");
        }
        await createProjectSpace(db, {
          name: name.trim(),
          description: description?.trim() || null,
          type: type || "research",
          tags: tags?.trim() || null,
        });
        return res.redirectAfterPost("/dashboard/projects");
      }

      // Owner approval of an mcp_server data backend — a command the gateway
      // will run. Only reachable through this session-authed, CSRF-checked
      // dashboard POST; the MCP tool can only create pending rows.
      if (action === "approve_backend" || action === "revoke_backend") {
        const projectId = Number(req.body.id);
        const backendId = Number(req.body.backend_id);
        const back = Number.isInteger(projectId) && projectId > 0 ? `/dashboard/projects?view=${projectId}` : "/dashboard/projects";
        const sep = back.includes("?") ? "&" : "?";
        if (!Number.isInteger(backendId) || backendId <= 0) return res.redirectAfterPost(`${back}${sep}error=backend_not_found`);
        if (action === "approve_backend") {
          const r = await approveBackend(db, backendId, String(req.body.ref_sha256 || ""));
          if (!r.ok) return res.redirectAfterPost(`${back}${sep}error=backend_not_approved`);
          import("../../proxy.js").then((m) => m.loadDynamicBackends()).catch(() => {});
        } else {
          await revokeBackendApproval(db, backendId);
          import("../../proxy.js").then((m) => m.disconnectDynamicBackend(backendId)).catch(() => {});
        }
        return res.redirectAfterPost(back);
      }

      if (action === "update_status") {
        const { id, status } = req.body;
        if (id && status) {
          const rowsAffected = await updateProjectSpaceMeta(db, Number(id), { status });
          if (rowsAffected === 0) {
            return res.redirectAfterPost(`/dashboard/projects?error=project_not_found`);
          }
        }
        return res.redirectAfterPost(`/dashboard/projects?view=${id}`);
      }

      if (action === "update") {
        const { id, name, description, tags } = req.body;
        if (id && name?.trim()) {
          const rowsAffected = await updateProjectSpaceMeta(db, Number(id), {
            name: name.trim(),
            description: description?.trim() || null,
            tags: tags?.trim() || null,
          });
          if (rowsAffected === 0) {
            return res.redirectAfterPost(`/dashboard/projects?view=${id}&error=project_not_found`);
          }
        }
        return res.redirectAfterPost(`/dashboard/projects?view=${id}`);
      }

      // M2c: project members — add/update + remove. Both gated by ACL via the
      // project-acl helper so the panel can't bypass capability checks.
      // W4: a Crow-to-Crow membership (`mode='live'`) belongs to the c2c controls.
      // This editor must never write role/capabilities (or revoke) a live row, or
      // the owner would silently fight the sharing controls.
      if (action === "add_member") {
        const id = parseInt(req.body.id, 10);
        const contactId = req.body.contact_id ? parseInt(req.body.contact_id, 10) : null;
        const role = req.body.role;
        const capabilities = req.body.capabilities?.trim() || null;
        if (!id || !contactId || !role) {
          return res.redirectAfterPost(`/dashboard/projects?view=${id || ""}&error=add_member_missing_fields`);
        }
        try {
          await assertLocalCapability(db, id, "manage_members");
          if (capabilities) JSON.parse(capabilities);
          const existing = (await db.execute({
            sql: `SELECT id, mode FROM project_members WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL`,
            args: [id, contactId],
          })).rows[0];
          if (existing?.mode === "live") {
            return res.redirectAfterPost(`/dashboard/projects?view=${id}&error=live_member`);
          }
          if (existing) {
            await db.execute({
              sql: `UPDATE project_members SET role = ?, capabilities = ? WHERE id = ?`,
              args: [role, capabilities, existing.id],
            });
            await appendAudit(db, { project_id: id, actor_type: "local", action: "member.update", target: `member:${existing.id}`, payload: { role, contact_id: contactId, capabilities_set: !!capabilities } });
          } else {
            const r = await db.execute({
              sql: `INSERT INTO project_members (project_id, contact_id, role, capabilities) VALUES (?, ?, ?, ?)`,
              args: [id, contactId, role, capabilities],
            });
            await appendAudit(db, { project_id: id, actor_type: "local", action: "member.add", target: `member:${Number(r.lastInsertRowid)}`, payload: { role, contact_id: contactId, capabilities_set: !!capabilities } });
          }
        } catch (err) {
          const msg = err instanceof AclError ? err.message : (err instanceof SyntaxError ? "invalid_capabilities_json" : err.message);
          return res.redirectAfterPost(`/dashboard/projects?view=${id}&error=${encodeURIComponent(msg)}`);
        }
        return res.redirectAfterPost(`/dashboard/projects?view=${id}&tab=members`);
      }

      if (action === "remove_member") {
        const id = parseInt(req.body.id, 10);
        const contactId = parseInt(req.body.contact_id, 10);
        if (!id || !contactId) {
          return res.redirectAfterPost(`/dashboard/projects?view=${id || ""}&error=remove_member_missing_fields`);
        }
        try {
          await assertLocalCapability(db, id, "manage_members");
          // W4: the c2c controls own a live row; refusing here keeps this path from
          // revoking a Crow-to-Crow membership behind their back.
          const live = (await db.execute({
            sql: `SELECT 1 AS present FROM project_members
                   WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL AND mode = 'live' LIMIT 1`,
            args: [id, contactId],
          })).rows[0];
          if (live) return res.redirectAfterPost(`/dashboard/projects?view=${id}&error=live_member`);
          await db.execute({
            sql: `UPDATE project_members SET revoked_at = datetime('now')
                  WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL`,
            args: [id, contactId],
          });
          await appendAudit(db, { project_id: id, actor_type: "local", action: "member.revoke", target: `contact:${contactId}` });
        } catch (err) {
          const msg = err instanceof AclError ? err.message : err.message;
          return res.redirectAfterPost(`/dashboard/projects?view=${id}&error=${encodeURIComponent(msg)}`);
        }
        return res.redirectAfterPost(`/dashboard/projects?view=${id}&tab=members`);
      }
    }

    // --- Delete confirm ---
    if (typeof req.query.delete === "string" && req.query.delete) {
      return await renderDeleteConfirm(db, req, layout, lang);
    }

    // --- Detail View ---
    const viewId = req.query.view;
    if (viewId) {
      return await renderDetailView(db, viewId, layout, lang, req);
    }

    // --- List View ---
    return await renderListView(db, req.query, layout, lang, req);
  },
};

/** The delete confirm page for /dashboard/projects?delete=<id> (owner only; a live or archived project). */
async function renderDeleteConfirm(db, req, layout, lang) {
  const id = Number(req.query.delete);
  const { rows } = Number.isInteger(id)
    ? await db.execute({ sql: "SELECT id, slug, name, status FROM project_spaces WHERE id = ? AND archived_at IS NULL", args: [id] })
    : { rows: [] };
  const p = rows[0];
  if (!p || !(await canOwnProject(db, id))) {
    return layout({ title: "Project Not Found", content: section("Not Found", `<p>Project #${escapeHtml(String(req.query.delete))} not found.</p>`) });
  }
  const project = { id: Number(p.id), slug: String(p.slug), name: String(p.name || p.slug), status: String(p.status || "") };
  const view = await deleteConfirmHtml(db, req, project, lang, {
    urls: { post: "/dashboard/projects", cancel: `/dashboard/projects?view=${id}` },
    error: typeof req.query.error === "string" ? req.query.error : "",
    disconnected: typeof req.query.disconnected === "string" ? req.query.disconnected : "",
  });
  if (view.forbidden) return layout({ title: "Project Not Found", content: section("Not Found", `<p>Project #${id} not found.</p>`) });
  return layout({ title: project.name, content: `<style>${lifecycleRules()}</style>${view.html}` });
}

async function renderListView(db, query, layout, lang, req) {
  const live = (await withdrawReady(db)) ? " AND withdrawn_at IS NULL" : "";
  const page = parseInt(query.page) || 1;
  const offset = (page - 1) * PAGE_SIZE;
  const statusFilter = query.status || null;
  const searchQuery = query.q || null;

  // Count and fetch projects.
  // Exclude learner_profile rows — those are maker-lab learner profiles
  // and belong on the Maker Lab panel, not here.
  // archived_at IS NULL excludes trigger-archived (deleted) rows.
  let countSql = "SELECT COUNT(*) as c FROM project_spaces WHERE (type IS NULL OR type != 'learner_profile') AND archived_at IS NULL";
  let fetchSql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM research_sources WHERE project_id = p.id) as source_count,
      (SELECT COUNT(*) FROM research_notes WHERE project_id = p.id${live}) as note_count,
      (SELECT COUNT(*) FROM data_backends WHERE project_id = p.id) as backend_count
    FROM project_spaces p
    WHERE (p.type IS NULL OR p.type != 'learner_profile') AND p.archived_at IS NULL
  `;
  const countArgs = [];
  const fetchArgs = [];

  if (statusFilter) {
    countSql += " AND status = ?";
    fetchSql += " AND p.status = ?";
    countArgs.push(statusFilter);
    fetchArgs.push(statusFilter);
  }

  if (searchQuery) {
    const safe = sanitizeFtsQuery(searchQuery);
    if (safe) {
      countSql += ` AND name LIKE ? ESCAPE '\\'`;
      fetchSql += ` AND p.name LIKE ? ESCAPE '\\'`;
      const pattern = `%${escapeLikePattern(searchQuery)}%`;
      countArgs.push(pattern);
      fetchArgs.push(pattern);
    }
  }

  fetchSql += " ORDER BY p.updated_at DESC LIMIT ? OFFSET ?";
  fetchArgs.push(PAGE_SIZE, offset);

  const [{ rows: countRows }, { rows: projects }] = await Promise.all([
    db.execute({ sql: countSql, args: countArgs }),
    db.execute({ sql: fetchSql, args: fetchArgs }),
  ]);
  const totalCount = countRows[0]?.c || 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // --- Render ---
  const statusOptions = ["active", "paused", "completed", "archived"];

  // Search + filter bar
  const filterBar = `<form method="GET" action="/dashboard/projects" style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;align-items:center">
    <input type="text" name="q" value="${escapeHtml(searchQuery || "")}" placeholder="Search projects..." style="flex:1;min-width:150px;padding:0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary)">
    <select name="status" style="padding:0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary)">
      <option value="">All statuses</option>
      ${statusOptions.map(s => `<option value="${s}"${statusFilter === s ? " selected" : ""}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join("")}
    </select>
    <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-control);color:var(--crow-accent-contrast);cursor:pointer">Search</button>
  </form>`;

  // Project cards
  let projectsHtml;
  // Archived rows the local owner may Restore or Delete (§15).
  const ownsById = new Set();
  for (const p of projects) if (p.status === "archived" && (await canOwnProject(db, Number(p.id)))) ownsById.add(Number(p.id));
  if (projects.length === 0) {
    projectsHtml = `<div style="text-align:center;padding:2rem;color:var(--crow-text-muted)">No projects found. Create one to get started.</div>`;
  } else {
    projectsHtml = projects.map((p, i) => {
      const statusBadge = badge(p.status, STATUS_BADGE_MAP[p.status] || "draft");
      const typeBadge = p.type !== "research" ? ` ${badge(p.type, "info")}` : "";
      const tags = p.tags ? `<div style="margin-top:0.25rem;font-size:0.75rem;color:var(--crow-text-muted)">${escapeHtml(p.tags)}</div>` : "";
      const counts = `<span style="font-size:0.75rem;color:var(--crow-text-secondary)">${p.source_count} sources · ${p.note_count} notes${p.backend_count > 0 ? ` · ${p.backend_count} backends` : ""}</span>`;
      const delay = i * 30;

      const card = `<a href="/dashboard/projects?view=${p.id}" class="project-card" style="animation:fadeInUp 0.3s ease-out ${delay}ms both">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:0.5rem">
          <div style="font-weight:600;font-size:0.95rem">${escapeHtml(p.name)}</div>
          <div style="flex-shrink:0">${statusBadge}${typeBadge}</div>
        </div>
        ${p.description ? `<div style="font-size:0.8rem;color:var(--crow-text-secondary);margin-top:0.25rem">${escapeHtml(p.description.substring(0, 120))}${p.description.length > 120 ? "..." : ""}</div>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5rem">
          ${counts}
          <span style="font-size:0.7rem;color:var(--crow-text-muted)">${formatDate(p.updated_at, lang)}</span>
        </div>
        ${tags}
      </a>`;
      return p.status === "archived" && ownsById.has(Number(p.id)) ? card + archivedRowActionsHtml(req, p, lang) : card;
    }).join("");
  }

  // Pagination
  let paginationHtml = "";
  if (totalPages > 1) {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (searchQuery) params.set("q", searchQuery);

    const links = [];
    if (page > 1) {
      params.set("page", page - 1);
      links.push(`<a href="/dashboard/projects?${params}" style="color:var(--crow-accent)">← Prev</a>`);
    }
    links.push(`<span style="color:var(--crow-text-muted)">Page ${page} of ${totalPages}</span>`);
    if (page < totalPages) {
      params.set("page", page + 1);
      links.push(`<a href="/dashboard/projects?${params}" style="color:var(--crow-accent)">Next →</a>`);
    }
    paginationHtml = `<div style="display:flex;justify-content:center;gap:1rem;margin-top:1rem">${links.join("")}</div>`;
  }

  // Create project form (collapsible)
  const createForm = `<details style="margin-bottom:1rem"${query && query.new ? " open" : ""}>
    <summary style="cursor:pointer;color:var(--crow-accent);font-weight:500;padding:0.5rem 0">+ New Project</summary>
    <form method="POST" style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.5rem;padding:1rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)">
      <input type="hidden" name="action" value="create">
      ${formField("Name", "name", { required: true, placeholder: "Project name" })}
      ${formField("Description", "description", { type: "textarea", rows: 2, placeholder: "Brief description" })}
      <div style="display:flex;gap:0.5rem">
        ${formField("Type", "type", { type: "select", options: [{ value: "research", label: "Research" }, { value: "data_connector", label: "Data Connector" }], value: "research" })}
        ${formField("Tags", "tags", { placeholder: "Comma-separated tags" })}
      </div>
      <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-control);color:var(--crow-accent-contrast);cursor:pointer;align-self:flex-start">Create Project</button>
    </form>
  </details>`;

  const css = `<style>
    .project-card {
      display:block;
      padding:1rem;
      background:var(--crow-bg-surface);
      border:1px solid var(--crow-border);
      border-radius:var(--crow-radius-card);
      text-decoration:none;
      color:var(--crow-text-primary);
      transition:all 0.15s ease;
      margin-bottom:0.5rem;
    }
    .project-card:hover {
      border-color:var(--crow-accent);
      background:var(--crow-bg-elevated);
    }
    @keyframes fadeInUp {
      from { opacity:0; transform:translateY(8px); }
      to { opacity:1; transform:translateY(0); }
    }
  </style>`;

  // Crow-to-Crow (task 7B): the visitor's side lives here, on the projects list,
  // because a visit is not a local project (visitor.js keeps it in c2c_visits, never
  // a project_spaces row) and the invite notification links to this panel.
  const visits = await c2cSafe("visits", () => listVisits(db), []);
  const visitsSection = section(
    t("projects.c2c.sharedTitle", lang),
    c2cVisitsHtml(visits, lang),
    { delay: 25 },
  );

  const content = `${css}<style>${lifecycleRules()}</style>${resultBannerHtml(query, lang)}${visitsSection}${createForm}${filterBar}${projectsHtml}${paginationHtml}${c2cClientJs(lang)}`;
  return layout({ title: `Projects (${totalCount})`, content });
}

async function renderDetailView(db, projectId, layout, lang, req = {}) {
  // Read from project_spaces; archived_at IS NULL ensures trigger-archived rows
  // are treated as Not Found exactly as a missing rp row was.
  const { rows: projRows } = await db.execute({
    sql: "SELECT * FROM project_spaces WHERE id = ? AND (type IS NULL OR type != 'learner_profile') AND archived_at IS NULL",
    args: [projectId],
  });

  if (projRows.length === 0) {
    const content = section("Not Found", `<p>Project #${escapeHtml(String(projectId))} not found.</p>`);
    return layout({ title: "Project Not Found", content });
  }

  const project = projRows[0];

  // Fetch related data in parallel (incl. M2 project_spaces extras + members,
  // M5 audit log). The ps row is already in `project` — no second fetch needed.
  const provReady = await provenanceReady(db);
  const live = (await withdrawReady(db)) ? " AND withdrawn_at IS NULL" : "";
  const [sourcesResult, sourceCountResult, notesResult, backendsResult, membersResult, contactsResult, auditResult] = await Promise.all([
    db.execute({
      // fetched_text is deliberately not selected (large).
      sql: provReady
        ? `SELECT s.id, s.title, s.source_type, s.url, s.verified, s.created_at, s.fetch_status, s.verification_method,
                  (SELECT COUNT(*) FROM research_notes n WHERE n.source_id = s.id AND n.note_type = 'quote'${live}) AS quote_total,
                  (SELECT COUNT(*) FROM research_notes n WHERE n.source_id = s.id AND n.note_type = 'quote' AND n.quote_found = 1${live}) AS quote_found_count
             FROM research_sources s WHERE s.project_id = ? ORDER BY s.created_at DESC LIMIT 50`
        : "SELECT id, title, source_type, url, verified, created_at FROM research_sources WHERE project_id = ? ORDER BY created_at DESC LIMIT 50",
      args: [projectId],
    }),
    db.execute({ sql: "SELECT COUNT(*) AS c FROM research_sources WHERE project_id = ?", args: [projectId] }),
    db.execute({ sql: `SELECT id, note_type, substr(content, 1, 200) as preview, created_at FROM research_notes WHERE project_id = ?${live} ORDER BY created_at DESC LIMIT 50`, args: [projectId] }),
    db.execute({ sql: "SELECT * FROM data_backends WHERE project_id = ?", args: [projectId] }),
    db.execute({
      sql: `SELECT pm.id, pm.contact_id, pm.role, pm.capabilities, pm.mode, pm.granted_at, pm.revoked_at,
                   c.display_name, c.crow_id
              FROM project_members pm LEFT JOIN contacts c ON c.id = pm.contact_id
             WHERE pm.project_id = ? AND pm.revoked_at IS NULL
             ORDER BY pm.granted_at ASC`,
      args: [projectId],
    }),
    db.execute({ sql: "SELECT id, display_name, crow_id FROM contacts WHERE is_blocked = 0 AND request_status IS NULL ORDER BY display_name, id LIMIT 200" }),
    db.execute({
      sql: `SELECT created_at, actor_type, actor_id, action, target, payload
              FROM project_audit_log WHERE project_id = ?
             ORDER BY created_at DESC LIMIT 50`,
      args: [projectId],
    }),
  ]);

  const sources = sourcesResult.rows;
  const sourceTotal = Number(sourceCountResult.rows[0]?.c ?? sources.length);
  const notes = notesResult.rows;
  const backends = backendsResult.rows;
  // slug/workspace_dir/storage_prefix/archived_at are now in the ps row itself
  const space = project;
  const members = membersResult.rows;
  const contacts = contactsResult.rows;
  const auditEntries = auditResult.rows;

  // Crow-to-Crow (task 7B): only a contact whose Crow has proved the bound key on
  // THIS instance may be offered a live share (owner.js O4 reads the same strict
  // pin), and the live-member list is the sharing runtime's own read — role, state
  // and the legacy-proof flag. An old DB without 0016 renders neither.
  const c2cContacts = await c2cSafe("bound contacts", () => c2cBoundContacts(db), []);
  const c2cMembers = await c2cSafe("live members", () => listLiveMembers(db, Number(project.id)), []);

  // Back link + status controls
  const backLink = `<a href="/dashboard/projects" style="color:var(--crow-accent);text-decoration:none;font-size:0.85rem">← All Projects</a>`;

  const statusBadge = badge(project.status, STATUS_BADGE_MAP[project.status] || "draft");
  const statusOptions = ["active", "paused", "completed", "archived"]
    .filter(s => s !== project.status)
    .map(s => `<form method="POST" style="display:inline"><input type="hidden" name="action" value="update_status"><input type="hidden" name="id" value="${project.id}"><input type="hidden" name="status" value="${s}"><button type="submit" style="padding:0.25rem 0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-secondary);cursor:pointer;font-size:0.75rem">${s}</button></form>`)
    .join(" ");

  // Overview section
  const overviewHtml = `
    <div style="margin-bottom:1rem">${backLink}</div>
    <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem">
      <div>
        <h2 style="font-family:var(--crow-body-font);margin:0">${escapeHtml(project.name)}</h2>
        ${project.description ? `<p style="color:var(--crow-text-secondary);margin:0.25rem 0">${escapeHtml(project.description)}</p>` : ""}
      </div>
      <div>${statusBadge}</div>
    </div>
    <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.5rem">
      Type: ${escapeHtml(project.type)} · Created: ${formatDate(project.created_at, lang)} · Updated: ${formatDate(project.updated_at, lang)}
      ${project.tags ? ` · Tags: ${escapeHtml(project.tags)}` : ""}
    </div>
    <div style="margin-bottom:1rem">Change status: ${statusOptions}</div>
    ${(await canOwnProject(db, Number(project.id))) ? `<style>${lifecycleRules()}</style>${detailControlsHtml(req, project, lang)}` : ""}
  `;

  // Sources table
  let sourcesHtml;
  if (sources.length === 0) {
    sourcesHtml = `<p style="color:var(--crow-text-muted);font-size:0.85rem">${escapeHtml(t("projects.fetch.empty", lang))}</p>`;
  } else {
    const rows = sources.map(s => {
      // A peer row (NULL status) or a legacy-flag verification never reads as verified.
      const trusted = !provReady || (s.fetch_status != null && s.verification_method !== "legacy_flag");
      return [
        provReady ? `${escapeHtml(s.title)}<div style="margin-top:0.25rem">${fetchChipHtml(s, lang)}</div>` : escapeHtml(s.title),
        badge(s.source_type, "info"),
        s.verified && trusted ? badge("verified", "connected") : badge("unverified", "draft"),
        sourceLinkHtml(s.url),
        `<span style="font-size:0.75rem">${formatDate(s.created_at, lang)}</span>`,
      ];
    });
    sourcesHtml = dataTable(["Title", "Type", "Status", "URL", "Added"], rows, { stack: true });
    if (sourceTotal > sources.length) {
      sourcesHtml += `<p style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.5rem">${escapeHtml(fill(t("projects.fetch.showing", lang), { shown: sources.length, total: sourceTotal }))}</p>`;
    }
  }

  // Notes list
  let notesHtml;
  if (notes.length === 0) {
    notesHtml = `<p style="color:var(--crow-text-muted);font-size:0.85rem">No notes yet. Add notes via crow_add_note.</p>`;
  } else {
    notesHtml = notes.map(n =>
      `<div style="padding:0.5rem;border-left:3px solid var(--crow-accent-muted);margin-bottom:0.5rem;font-size:0.85rem">
        <div style="display:flex;justify-content:space-between;margin-bottom:0.25rem">
          ${badge(n.note_type, "info")}
          <span style="font-size:0.7rem;color:var(--crow-text-muted)">${formatDate(n.created_at, lang)}</span>
        </div>
        ${escapeHtml(n.preview)}${n.preview.length >= 200 ? "..." : ""}
      </div>`
    ).join("");
  }

  // Backends
  let backendsHtml = "";
  if (backends.length > 0) {
    const rows = backends.map(b => [
      escapeHtml(b.name),
      badge(b.backend_type, "info"),
      badge(b.status, b.status === "connected" ? "connected" : "draft"),
      renderBackendApproval(project.id, b, req),
    ]);
    backendsHtml = section(`Data Backends (${backends.length})`, dataTable(["Name", "Type", "Status", "Runs"], rows, { stack: true }), { delay: 300 });
  }

  // W4: the member editor refused a live row; the redirect says why, translated
  // (the query string carries the code, never the message).
  const memberNotice = req.query?.error === "live_member"
    ? `<div class="alert alert-error" role="alert">${escapeHtml(t("projects.members.liveRefused", lang))}</div>`
    : "";

  // M2c: Members section. Shows active members with role + resolved capabilities,
  // plus a small "Add member" form (contacts dropdown + role select).
  // Per-member capability override JSON is rendered as a textarea — M5 will
  // promote this to a proper editor.
  let membersHtml;
  if (members.length === 0) {
    membersHtml = `<p style="color:var(--crow-text-muted);font-size:0.85rem">No members yet. Add one below.</p>`;
  } else {
    const rows = members.map(m => {
      const who = m.contact_id == null
        ? "<i>local user</i>"
        : escapeHtml(m.display_name || m.crow_id || `contact #${m.contact_id}`);
      const caps = resolveCapabilities(m.role, m.capabilities);
      const granted = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
      const capLabel = granted.length === Object.keys(caps).length
        ? `<span style="color:var(--crow-text-muted);font-size:0.75rem">all (${granted.length})</span>`
        : `<span style="font-size:0.75rem;color:var(--crow-text-secondary)" title="${escapeHtml(granted.join(', '))}">${granted.length} of ${Object.keys(caps).length}</span>`;
      // Build the confirm() text from the RAW name, JS-escape it for the
      // single-quoted JS string, then HTML-attribute-escape the WHOLE thing —
      // the attribute context is what matters here (a raw `"` would break out).
      const rawWho = m.display_name || m.crow_id || `contact #${m.contact_id}`;
      const confirmAttr = escapeHtml(
        t("projects.confirmRevoke", lang).replace("{who}", rawWho).replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
      );
      const removeForm = m.contact_id == null
        ? `<span style="color:var(--crow-text-muted);font-size:0.75rem">—</span>`
        : `<form method="POST" style="display:inline" onsubmit="return confirm('${confirmAttr}')">
             <input type="hidden" name="action" value="remove_member">
             <input type="hidden" name="id" value="${project.id}">
             <input type="hidden" name="contact_id" value="${m.contact_id}">
             <button type="submit" style="padding:0.2rem 0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-secondary);cursor:pointer;font-size:0.7rem">revoke</button>
           </form>`;
      return [
        who,
        badge(m.role, "info"),
        capLabel,
        m.mode ? badge(m.mode, "draft") : `<span style="color:var(--crow-text-muted);font-size:0.75rem">local</span>`,
        `<span style="font-size:0.75rem">${formatDate(m.granted_at, lang)}</span>`,
        removeForm,
      ];
    });
    membersHtml = dataTable(["Who", "Role", "Capabilities", "Mode", "Since", ""], rows);
  }

  const contactOptions = contacts.map(c =>
    `<option value="${c.id}">${escapeHtml(c.display_name || c.crow_id || `contact #${c.id}`)}</option>`
  ).join("");
  const roleOptions = ROLES.map(r => `<option value="${r}"${r === "viewer" ? " selected" : ""}>${r}</option>`).join("");

  const addMemberForm = `
    <form method="POST" style="margin-top:0.75rem;padding:0.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);display:flex;gap:0.5rem;flex-wrap:wrap;align-items:end">
      <input type="hidden" name="action" value="add_member">
      <input type="hidden" name="id" value="${project.id}">
      <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary)">Contact
        <select name="contact_id" required style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary);min-width:180px">
          <option value="">— pick contact —</option>
          ${contactOptions}
        </select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary)">Role
        <select name="role" required style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary)">${roleOptions}</select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary);flex:1;min-width:220px">Capability overrides (JSON, optional)
        <input type="text" name="capabilities" placeholder='{"invoke_bot":false}' style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary);font-family:monospace;font-size:0.8rem">
      </label>
      <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-control);color:var(--crow-accent-contrast);cursor:pointer">Add</button>
    </form>`;

  // Workspace info (slug, dir, prefix) from project_spaces — shown next to overview.
  const workspaceInfo = (space.slug || space.workspace_dir) ? `
    <div style="margin-bottom:1rem;padding:0.5rem 0.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);font-size:0.8rem;color:var(--crow-text-secondary)">
      ${space.slug ? `<div><span style="color:var(--crow-text-muted)">slug:</span> <code style="font-size:0.8rem">${escapeHtml(space.slug)}</code></div>` : ""}
      ${space.workspace_dir ? `<div><span style="color:var(--crow-text-muted)">workspace:</span> <code style="font-size:0.8rem">${escapeHtml(space.workspace_dir)}</code></div>` : ""}
      ${space.storage_prefix ? `<div><span style="color:var(--crow-text-muted)">storage prefix:</span> <code style="font-size:0.8rem">${escapeHtml(space.storage_prefix)}</code></div>` : ""}
    </div>` : "";

  // M5: audit log viewer. Read-only timeline (newest first). Each row shows
  // when, who (local / bot / contact / system), what action, and which target.
  // Payload is rendered as a small <details> when present so the row stays scannable.
  let auditHtml;
  if (auditEntries.length === 0) {
    auditHtml = `<p style="color:var(--crow-text-muted);font-size:0.85rem">No audit entries yet. Member changes, source/note/file writes, agent turns, and shares will appear here.</p>`;
  } else {
    const actorBadge = (t) => {
      const colorMap = { local: "info", bot: "connected", contact: "info", system: "draft" };
      return badge(t, colorMap[t] || "draft");
    };
    auditHtml = `<div class="table-scroll"><table style="width:100%;border-collapse:collapse;font-size:0.85rem">
      <thead><tr style="color:var(--crow-text-muted);text-align:left;border-bottom:1px solid var(--crow-border)">
        <th style="padding:0.25rem 0.5rem;width:170px">When</th>
        <th style="padding:0.25rem 0.5rem;width:90px">Actor</th>
        <th style="padding:0.25rem 0.5rem">Action</th>
        <th style="padding:0.25rem 0.5rem">Target</th>
      </tr></thead>
      <tbody>
      ${auditEntries.map((a) => {
        const actorLabel = a.actor_id
          ? `<span title="${escapeHtml(String(a.actor_id))}">${actorBadge(a.actor_type)}<br><span style="font-size:0.7rem;color:var(--crow-text-muted)">${escapeHtml(String(a.actor_id).slice(0, 18))}</span></span>`
          : actorBadge(a.actor_type);
        const detail = a.payload
          ? `<details style="display:inline-block;margin-left:0.5rem"><summary style="cursor:pointer;font-size:0.7rem;color:var(--crow-text-muted)">payload</summary><pre style="margin:0.25rem 0 0 0;font-size:0.7rem;background:var(--crow-bg-elevated);padding:0.25rem 0.5rem;border-radius:4px;max-width:400px;overflow:auto">${escapeHtml(String(a.payload).slice(0, 600))}</pre></details>`
          : "";
        return `<tr style="border-bottom:1px solid var(--crow-border)">
          <td style="padding:0.4rem 0.5rem;color:var(--crow-text-muted);font-family:monospace;font-size:0.75rem">${escapeHtml(a.created_at)}</td>
          <td style="padding:0.4rem 0.5rem">${actorLabel}</td>
          <td style="padding:0.4rem 0.5rem"><code style="font-size:0.8rem">${escapeHtml(a.action)}</code>${detail}</td>
          <td style="padding:0.4rem 0.5rem;color:var(--crow-text-secondary);font-family:monospace;font-size:0.75rem">${escapeHtml(a.target || "")}</td>
        </tr>`;
      }).join("")}
      </tbody>
    </table></div>
    ${auditEntries.length === 50 ? `<p style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.5rem">Showing latest 50 entries. Use the <code>crow_audit_log</code> MCP tool for filtering / older entries.</p>` : ""}`;
  }

  const content = `
    ${memberNotice}
    ${section("Overview", overviewHtml + workspaceInfo)}
    ${section(`Members (${members.length})`, membersHtml + addMemberForm + c2cOwnerSectionHtml(project.id, c2cContacts, c2cMembers, lang), { delay: 50 })}
    ${section(`Sources (${sourceTotal})`, sourcesHtml, { delay: 100 })}
    ${section(`Notes (${notes.length})`, notesHtml, { delay: 200 })}
    ${backendsHtml}
    ${section(`Audit log (${auditEntries.length})`, auditHtml, { delay: 350 })}
  `;

  return layout({ title: project.name, content: content + c2cClientJs(lang) });
}

/**
 * The approval cell for one data backend. An mcp_server backend is a command
 * the gateway runs, so the owner sees the EXACT launch spec that is stored,
 * hashed and spawned: the command, every arg on its own line, the exact
 * environment variable names it gets, each with every character visible
 * (visibleText: spaces as ␣, control, zero-width, bidi and non-ASCII
 * characters as \u{hex}), never truncated. A spec that is malformed, carries
 * keys that are never spawned, or is too long to show in full cannot be
 * approved.
 *
 * Rendering reads no file contents (stat only): the launcher check and the
 * file pins run when the owner presses Approve and again at every start.
 * The requester's free-text name comes last, in a distinct box, marked
 * unverified. The approval form carries the hash of the stored text the
 * owner saw and the CSRF token.
 */
export function renderBackendApproval(projectId, b, req = {}) {
  if (b.backend_type !== "mcp_server") {
    return `<span style="font-size:0.75rem;color:var(--crow-text-muted)">read-only dataset</span>`;
  }
  const show = (v) => escapeHtml(visibleText(v));
  const prose = (v) => escapeHtml(visibleText(v, { keepSpaces: true }));
  const code = "display:block;white-space:pre-wrap;word-break:break-all;margin:0.1rem 0;padding:0.1rem 0.3rem;background:var(--crow-bg-elevated);border-radius:4px;font-family:monospace";
  const warn = "color:var(--crow-error)";
  const label = `<div style="margin-top:0.4rem;padding:0.2rem 0.4rem;border:1px dashed var(--crow-border);border-radius:4px;color:var(--crow-text-muted);font-style:italic">Name typed by whoever registered it — unverified, not part of what runs: ${escapeHtml(String(b.name ?? ""))}</div>`;
  const parsed = parseStoredSpec(b.connection_ref);
  if (!parsed.ok) {
    return `<div style="font-size:0.75rem"><div style="${warn}">Cannot be approved: ${prose(parsed.reason)}. Remove it and register it again.</div>${label}</div>`;
  }
  const { command, args, envVars } = parsed.spec;
  const approved = hasApproval(b);
  const csrf = csrfInput(req);
  const btn = "padding:0.25rem 0.5rem;border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);cursor:pointer;font-size:0.75rem";
  const hidden = `${csrf}<input type="hidden" name="id" value="${Number(projectId)}"><input type="hidden" name="backend_id" value="${Number(b.id)}">`;
  const form = approved
    ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="revoke_backend">${hidden}<button type="submit" style="${btn};background:var(--crow-bg-elevated);color:var(--crow-text-secondary)">Stop running it</button></form>`
    : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="approve_backend">${hidden}<input type="hidden" name="ref_sha256" value="${refHash(b.connection_ref)}"><button type="submit" style="${btn};background:var(--crow-accent);color:var(--crow-bg)">Approve and run exactly this</button></form>`;
  const argsHtml = args.length
    ? `<ol start="1" style="margin:0.1rem 0;padding-left:1.5rem">${args.map((a) => `<li><code style="${code}">${show(a)}</code></li>`).join("")}</ol>`
    : `<div style="color:var(--crow-text-muted)">(no arguments)</div>`;

  // Launcher notes from stat only (never a read).
  const notes = [];
  if (command.includes("/")) {
    let owner = null;
    try { owner = statSync(command).uid; } catch {}
    if (owner === null) notes.push(`The launcher file does not exist right now.`);
    else if (owner !== 0) notes.push(`The launcher file is not owned by root (owner uid ${owner}): anyone with that account can change it.`);
  }
  if (parsed.spec.command_sha256) {
    notes.push(`The launcher SHA-256 <code>${show(parsed.spec.command_sha256)}</code> was supplied by whoever registered it, not computed by Crow. It only proves the file has not changed since that hash was taken, not that the file is what its name says.`);
  }
  const pins = pinnedFiles(parsed.spec);
  const pinsHtml = pins.length
    ? `<div>Approval also pins the current contents of these files; editing one stops it from starting until you approve again:</div><ul style="margin:0.1rem 0;padding-left:1.5rem">${pins.map((f) => `<li><code>${show(f.real)}</code></li>`).join("")}</ul>`
    : "";
  const envNames = backendEnvNames(envVars);
  const declared = new Set(envVars);

  return `<div style="font-size:0.75rem">
    <div>${approved ? "Approved (checked again every time it starts). It runs:" : "Waiting for your approval. It would run:"}</div>
    <div>Command:</div><code style="${code}">${show(command)}</code>
    <div>Arguments (${args.length}), each passed exactly as shown:</div>${argsHtml}
    ${notes.map((n) => `<div style="${warn}">${n}</div>`).join("")}
    ${pinsHtml}
    <div>Working directory: the gateway's own (not settable)</div>
    <div>Environment it gets — exactly these names, values from the gateway: ${envNames.map((v) => `<code>${show(v)}</code>${declared.has(v) ? " (declared by the registration)" : ""}`).join(", ")}</div>
    <div style="color:var(--crow-text-muted)">Approval covers this command line and the pinned files. It does not cover code the command downloads when it starts (for example npx or uvx packages) or other files a script opens on its own.</div>
    <div style="color:var(--crow-text-muted)">␣ is a space; \\u{…} is a character that is invisible or not plain ASCII.</div>
    ${b.last_error ? `<div style="${warn}">Last check: ${prose(b.last_error)}</div>` : ""}
    <div style="margin-top:0.25rem">${form}</div>
    ${label}
  </div>`;
}

/* ---------------------------------------------------------------- Crow-to-Crow */

/**
 * Read one of the sharing runtime's lists, or `fallback` when it cannot be read.
 *
 * A host whose 0016 migration was deferred (or an old DB) has no c2c tables and no
 * `accepted_at` column: the panel must still render, so a failed read costs that
 * section and never the page. The reason is logged with ids only.
 */
async function c2cSafe(label, read, fallback) {
  try {
    return await read();
  } catch (err) {
    console.warn(`[projects] ${label} could not be read: ${err?.message || err}`);
    return fallback;
  }
}

/**
 * The contacts the "Share with a contact's Crow" picker may offer: a full, unblocked
 * contact that has proved the bound key on THIS instance.
 *
 * That is exactly the pair of checks owner.js's `inviteContact` makes (O4) — the
 * contact's pinned Ed25519 key (`lookupPinnedContactKey`'s predicate, spelled as the
 * query below) and this instance's PT-3 pin (`isCbPinnedStrict`: false on a read
 * error, false on a missing table, so a broken DB can never read as "bound"). The
 * strict variants are used deliberately: a picker that offered a contact the invite
 * would then refuse, or a pin that read as bound on an unreadable DB, is worse than
 * an empty picker.
 */
async function c2cBoundContacts(db) {
  const localId = getOrCreateLocalInstanceId();
  const { rows } = await db.execute({
    sql: `SELECT id, display_name, crow_id FROM contacts
           WHERE is_blocked = 0 AND request_status IS NULL
             AND ed25519_pubkey IS NOT NULL AND ed25519_pubkey != ''
           ORDER BY display_name, id LIMIT 200`,
    args: [],
  });
  const out = [];
  for (const row of rows) {
    if (await isCbPinnedStrict(db, localId, row.crow_id)) out.push(row);
  }
  return out;
}

/** The three Crow-to-Crow roles, as option elements ("Can view" / "Can comment" / "Can edit"). */
function c2cRoleOptionsHtml(selected, lang) {
  return C2C_ROLES.map((role) =>
    `<option value="${role}"${role === selected ? " selected" : ""}>${escapeHtml(t(`projects.c2c.role.${role}`, lang))}</option>`
  ).join("");
}

const C2C_BTN = "padding:0.25rem 0.5rem;border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);cursor:pointer;font-size:0.75rem;background:var(--crow-bg-elevated);color:var(--crow-text-secondary)";
const C2C_SELECT = "padding:0.3rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-control);color:var(--crow-text-primary);font-size:0.8rem";
const C2C_ROW = "display:flex;justify-content:space-between;align-items:start;gap:0.5rem;flex-wrap:wrap;padding:0.5rem;border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);margin-top:0.4rem";

/** One live member: who, the state, the update-required line, and the two controls. */
function c2cMemberRowHtml(projectId, member, lang) {
  const role = C2C_ROLES.includes(member.role) ? member.role : "viewer";
  const active = member.state === "active";
  const stateLabel = t(active ? "projects.c2c.state.active" : "projects.c2c.state.invited", lang);
  // The receive pipeline records this when the contact's Crow still proves itself
  // with the legacy signature (receive.js R5/S10): until they update, frames are
  // held, so the owner is told why nothing is moving.
  const updateRequired = member.updateRequired
    ? `<div data-c2c-update-required style="font-size:0.75rem;color:var(--crow-warning,var(--crow-text-secondary));margin-top:0.2rem">${escapeHtml(t("projects.c2c.updateRequired", lang))}</div>`
    : "";
  return `<div data-c2c-member="${Number(member.contactId)}" data-project="${Number(projectId)}" style="${C2C_ROW}">
    <div>
      <div style="font-weight:600;font-size:0.85rem">${escapeHtml(member.displayName)}</div>
      <div style="margin-top:0.15rem">${badge(stateLabel, active ? "connected" : "draft")}</div>
      ${updateRequired}
    </div>
    <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
      <select data-c2c-member-role aria-label="${escapeHtml(t("projects.c2c.roleLabel", lang))}" style="${C2C_SELECT}">${c2cRoleOptionsHtml(role, lang)}</select>
      <button type="button" data-c2c-member-save style="${C2C_BTN}">${escapeHtml(t("projects.c2c.updateRole", lang))}</button>
      <button type="button" data-c2c-unshare style="${C2C_BTN}">${escapeHtml(t("projects.c2c.unshare", lang))}</button>
      <span data-c2c-member-status role="status" style="font-size:0.75rem;color:var(--crow-text-muted)"></span>
    </div>
  </div>`;
}

/**
 * The owner's half of the Members area: the live members, then the invite form.
 *
 * The form offers ONLY the bound contacts (`c2cBoundContacts`); when there are none
 * it says so instead of printing a picker that cannot succeed. Every action posts
 * to /dashboard/c2c-api with the dashboard's CSRF token (`c2cClientJs`).
 */
function c2cOwnerSectionHtml(projectId, contacts, members, lang) {
  const title = `<div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--crow-border);font-size:0.85rem;font-weight:600">${escapeHtml(t("projects.c2c.membersTitle", lang))}</div>`;
  const list = members.length === 0
    ? `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin:0.4rem 0">${escapeHtml(t("projects.c2c.noMembers", lang))}</p>`
    : members.map((m) => c2cMemberRowHtml(projectId, m, lang)).join("");

  const form = contacts.length === 0
    ? `<p style="color:var(--crow-text-muted);font-size:0.8rem;margin:0.6rem 0 0 0">${escapeHtml(t("projects.c2c.noBoundContacts", lang))}</p>`
    : `<form data-c2c-invite data-project="${Number(projectId)}" style="margin-top:0.6rem;padding:0.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);display:flex;gap:0.5rem;flex-wrap:wrap;align-items:end">
        <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary)">${escapeHtml(t("projects.c2c.contact", lang))}
          <select name="contact_id" data-c2c-contact required style="${C2C_SELECT};min-width:180px">
            ${contacts.map((c) => `<option value="${Number(c.id)}">${escapeHtml(c.display_name || c.crow_id || `contact #${c.id}`)}</option>`).join("")}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary)">${escapeHtml(t("projects.c2c.roleLabel", lang))}
          <select name="role" data-c2c-role style="${C2C_SELECT}">${c2cRoleOptionsHtml("viewer", lang)}</select>
        </label>
        <button type="submit" style="padding:0.45rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-control);color:var(--crow-accent-contrast);cursor:pointer;font-size:0.8rem">${escapeHtml(t("projects.c2c.share", lang))}</button>
        <span data-c2c-status role="status" style="font-size:0.75rem;color:var(--crow-text-muted)"></span>
      </form>`;

  return `${title}${list}${form}`;
}

/**
 * The visitor's "Shared with you" list: one row per live visit (an invitation still
 * to answer, or one already accepted), with the buttons that state allows.
 *
 * Ended visits (declined / left / unshared) are not drawn — there is nothing to do
 * with them — but the route returns them all, so a caller that wants the history
 * has it. The project name is the owner's text and the owner's name is a remote
 * display name; visitor.js sanitizes both, and escapeHtml is the last word here.
 */
function c2cVisitsHtml(visits, lang) {
  const live = visits.filter((v) => v.state === "invited" || v.state === "active");
  if (live.length === 0) {
    return `<p style="color:var(--crow-text-muted);font-size:0.85rem">${escapeHtml(t("projects.c2c.noneShared", lang))}</p>`;
  }
  return live.map((v) => {
    const active = v.state === "active";
    const state = active ? "active" : "invited";
    const role = C2C_ROLES.includes(v.role) ? v.role : "viewer";
    const button = (act, text, hidden) =>
      `<button type="button" data-c2c-act="${act}"${hidden ? " hidden" : ""} style="${C2C_BTN}">${escapeHtml(text)}</button>`;
    const from = fill(t("projects.c2c.sharedBy", lang), { name: v.ownerName || "" });
    return `<div data-c2c-visit="${Number(v.id)}" style="${C2C_ROW}">
      <div>
        <div style="font-weight:600;font-size:0.85rem">${escapeHtml(v.projectName || t("projects.c2c.untitled", lang))}</div>
        <div style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.15rem">${escapeHtml(from)} · ${escapeHtml(t(`projects.c2c.role.${role}`, lang))} · <span data-c2c-visit-state>${escapeHtml(t(`projects.c2c.state.${state}`, lang))}</span></div>
      </div>
      <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
        ${button("accept", t("projects.c2c.accept", lang), active)}
        ${button("decline", t("projects.c2c.decline", lang), active)}
        ${button("leave", t("projects.c2c.leave", lang), !active)}
        <span data-c2c-visit-status role="status" style="font-size:0.75rem;color:var(--crow-text-muted)"></span>
      </div>
    </div>`;
  }).join("");
}

/**
 * The panel's Crow-to-Crow client: the invite form, each member's role/unshare, and
 * the visitor's accept/decline/leave.
 *
 * Emitted inside a template literal, so it carries NO backtick and no dollar-brace of
 * its own (every interpolation below is the build's, through `tJs`), and every string
 * that reaches the page at runtime goes through `textContent` — never a markup sink.
 * Listeners bind to the elements of the run that bound them, so a Turbo swap cannot
 * leave a stale handler behind, and the page is reloaded after an owner mutation (the
 * server draws the members and their state). A visitor's answer updates its own row
 * in place, because nothing else on the page depends on it.
 *
 * Exported so the client can be read and parsed on its own (tests/c2c-api.test.js).
 */
export function c2cClientJs(lang) {
  return `<script>
(function () {
  var T = {
    working: '${tJs("projects.c2c.working", lang)}',
    failed: '${tJs("projects.c2c.failed", lang)}',
    unshareConfirm: '${tJs("projects.c2c.unshareConfirm", lang)}',
    state: {
      invited: '${tJs("projects.c2c.state.invited", lang)}',
      active: '${tJs("projects.c2c.state.active", lang)}',
      declined: '${tJs("projects.c2c.state.declined", lang)}',
      left: '${tJs("projects.c2c.state.left", lang)}',
      unshared: '${tJs("projects.c2c.state.unshared", lang)}'
    }
  };
  /* The actions each visit state offers. Anything else hides every button. */
  var VISIT_ACTS = { invited: ['accept', 'decline'], active: ['leave'] };
  var API = '/dashboard/c2c-api';

  function csrf() {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].trim().split('=');
      if (kv[0] === 'crow_csrf') return decodeURIComponent(kv.slice(1).join('='));
    }
    return '';
  }
  function say(el, text) { if (el) el.textContent = text || ''; }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Crow-Csrf': csrf() }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d }; });
      });
  }
  function reload() { window.location.reload(); }
  function failure(status) { return function () { say(status, T.failed); }; }

  /* The owner's invite form: one contact, one role. */
  var invite = document.querySelector('[data-c2c-invite]');
  if (invite) {
    var inviteStatus = invite.querySelector('[data-c2c-status]');
    invite.addEventListener('submit', function (e) {
      e.preventDefault();
      var contactSel = invite.querySelector('[data-c2c-contact]');
      var roleSel = invite.querySelector('[data-c2c-role]');
      if (!contactSel || !roleSel) return;
      say(inviteStatus, T.working);
      var url = API + '/projects/' + encodeURIComponent(invite.getAttribute('data-project')) + '/invite';
      post(url, { contact_id: Number(contactSel.value), role: roleSel.value })
        .then(function (r) { if (r.ok) reload(); else say(inviteStatus, T.failed); })
        .catch(failure(inviteStatus));
    });
  }

  /* One row per shared member: change the role, or stop sharing. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-c2c-member]'), function (row) {
    var status = row.querySelector('[data-c2c-member-status]');
    var base = API + '/projects/' + encodeURIComponent(row.getAttribute('data-project'))
      + '/members/' + encodeURIComponent(row.getAttribute('data-c2c-member'));
    var save = row.querySelector('[data-c2c-member-save]');
    if (save) save.addEventListener('click', function () {
      var roleSel = row.querySelector('[data-c2c-member-role]');
      if (!roleSel) return;
      say(status, T.working);
      post(base + '/role', { role: roleSel.value })
        .then(function (r) { if (r.ok) reload(); else say(status, T.failed); })
        .catch(failure(status));
    });
    var unshare = row.querySelector('[data-c2c-unshare]');
    if (unshare) unshare.addEventListener('click', function () {
      if (!window.confirm(T.unshareConfirm)) return;
      say(status, T.working);
      post(base + '/unshare', {})
        .then(function (r) { if (r.ok) reload(); else say(status, T.failed); })
        .catch(failure(status));
    });
  });

  /* The visitor's list: accept, decline, or leave, then redraw just this row. */
  function applyState(row, state) {
    var stateEl = row.querySelector('[data-c2c-visit-state]');
    if (stateEl) stateEl.textContent = T.state[state] || state;
    var allowed = VISIT_ACTS[state] || [];
    Array.prototype.forEach.call(row.querySelectorAll('[data-c2c-act]'), function (b) {
      if (allowed.indexOf(b.getAttribute('data-c2c-act')) >= 0) b.removeAttribute('hidden');
      else b.setAttribute('hidden', '');
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-c2c-visit]'), function (row) {
    var status = row.querySelector('[data-c2c-visit-status]');
    var url = API + '/visits/' + encodeURIComponent(row.getAttribute('data-c2c-visit'));
    Array.prototype.forEach.call(row.querySelectorAll('[data-c2c-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-c2c-act');
        say(status, T.working);
        post(url + '/' + act, {})
          .then(function (r) {
            if (!r.ok) { say(status, T.failed); return; }
            say(status, '');
            applyState(row, (r.data && r.data.state) || (act === 'accept' ? 'active' : 'declined'));
          })
          .catch(failure(status));
      });
    });
  });
})();
</script>`;
}
