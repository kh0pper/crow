/**
 * Projects Panel — Browse, manage, and search research projects.
 *
 * List view: all projects with status badges, source/note/backend counts
 * Detail view: project overview, sources, notes, linked backends
 * Actions: create, change status, archive
 * Search: FTS across project sources and notes
 */

import { escapeHtml, section, badge, dataTable, formField, actionBar, formatDate } from "../shared/components.js";
import { t } from "../shared/i18n.js";
import { sanitizeFtsQuery, escapeLikePattern } from "../../../db.js";
import {
  AclError,
  ROLES,
  resolveCapabilities,
  assertLocalCapability,
  appendAudit,
} from "../../../shared/project-acl.js";

const PAGE_SIZE = 20;

const STATUS_BADGE_MAP = {
  active: "connected",
  paused: "draft",
  completed: "published",
  archived: "draft",
};

export default {
  id: "projects",
  name: "Projects",
  icon: "project",
  route: "/dashboard/projects",
  navOrder: 13,
  category: "content",

  async handler(req, res, { db, layout, lang }) {
    // --- POST Actions ---
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "create") {
        const { name, description, type, tags } = req.body;
        if (!name?.trim()) {
          return res.redirectAfterPost("/dashboard/projects?error=name_required");
        }
        await db.execute({
          sql: "INSERT INTO research_projects (name, description, type, tags) VALUES (?, ?, ?, ?)",
          args: [name.trim(), description?.trim() || null, type || "research", tags?.trim() || null],
        });
        return res.redirectAfterPost("/dashboard/projects");
      }

      if (action === "update_status") {
        const { id, status } = req.body;
        if (id && status) {
          await db.execute({
            sql: "UPDATE research_projects SET status = ?, updated_at = datetime('now') WHERE id = ?",
            args: [status, id],
          });
        }
        return res.redirectAfterPost(`/dashboard/projects?view=${id}`);
      }

      if (action === "update") {
        const { id, name, description, tags } = req.body;
        if (id && name?.trim()) {
          await db.execute({
            sql: "UPDATE research_projects SET name = ?, description = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
            args: [name.trim(), description?.trim() || null, tags?.trim() || null, id],
          });
        }
        return res.redirectAfterPost(`/dashboard/projects?view=${id}`);
      }

      // M2c: project members — add/update + remove. Both gated by ACL via the
      // project-acl helper so the panel can't bypass capability checks.
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
            sql: `SELECT id FROM project_members WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL`,
            args: [id, contactId],
          })).rows[0];
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

    // --- Detail View ---
    const viewId = req.query.view;
    if (viewId) {
      return await renderDetailView(db, viewId, layout, lang);
    }

    // --- List View ---
    return await renderListView(db, req.query, layout, lang);
  },
};

async function renderListView(db, query, layout, lang) {
  const page = parseInt(query.page) || 1;
  const offset = (page - 1) * PAGE_SIZE;
  const statusFilter = query.status || null;
  const searchQuery = query.q || null;

  // Count and fetch projects.
  // Exclude learner_profile rows — those are maker-lab learner profiles
  // and belong on the Maker Lab panel, not here.
  let countSql = "SELECT COUNT(*) as c FROM research_projects WHERE (type IS NULL OR type != 'learner_profile')";
  let fetchSql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM research_sources WHERE project_id = p.id) as source_count,
      (SELECT COUNT(*) FROM research_notes WHERE project_id = p.id) as note_count,
      (SELECT COUNT(*) FROM data_backends WHERE project_id = p.id) as backend_count
    FROM research_projects p
    WHERE (p.type IS NULL OR p.type != 'learner_profile')
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
    <input type="text" name="q" value="${escapeHtml(searchQuery || "")}" placeholder="Search projects..." style="flex:1;min-width:150px;padding:0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary)">
    <select name="status" style="padding:0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary)">
      <option value="">All statuses</option>
      ${statusOptions.map(s => `<option value="${s}"${statusFilter === s ? " selected" : ""}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join("")}
    </select>
    <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:white;cursor:pointer">Search</button>
  </form>`;

  // Project cards
  let projectsHtml;
  if (projects.length === 0) {
    projectsHtml = `<div style="text-align:center;padding:2rem;color:var(--crow-text-muted)">No projects found. Create one to get started.</div>`;
  } else {
    projectsHtml = projects.map((p, i) => {
      const statusBadge = badge(p.status, STATUS_BADGE_MAP[p.status] || "draft");
      const typeBadge = p.type !== "research" ? ` ${badge(p.type, "info")}` : "";
      const tags = p.tags ? `<div style="margin-top:0.25rem;font-size:0.75rem;color:var(--crow-text-muted)">${escapeHtml(p.tags)}</div>` : "";
      const counts = `<span style="font-size:0.75rem;color:var(--crow-text-secondary)">${p.source_count} sources · ${p.note_count} notes${p.backend_count > 0 ? ` · ${p.backend_count} backends` : ""}</span>`;
      const delay = i * 30;

      return `<a href="/dashboard/projects?view=${p.id}" class="project-card" style="animation:fadeInUp 0.3s ease-out ${delay}ms both">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:0.5rem">
          <div style="font-weight:600;font-size:0.95rem">${escapeHtml(p.name)}</div>
          <div>${statusBadge}${typeBadge}</div>
        </div>
        ${p.description ? `<div style="font-size:0.8rem;color:var(--crow-text-secondary);margin-top:0.25rem">${escapeHtml(p.description.substring(0, 120))}${p.description.length > 120 ? "..." : ""}</div>` : ""}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5rem">
          ${counts}
          <span style="font-size:0.7rem;color:var(--crow-text-muted)">${formatDate(p.updated_at, lang)}</span>
        </div>
        ${tags}
      </a>`;
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
  const createForm = `<details style="margin-bottom:1rem">
    <summary style="cursor:pointer;color:var(--crow-accent);font-weight:500;padding:0.5rem 0">+ New Project</summary>
    <form method="POST" style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.5rem;padding:1rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)">
      <input type="hidden" name="action" value="create">
      ${formField("Name", "name", { required: true, placeholder: "Project name" })}
      ${formField("Description", "description", { type: "textarea", rows: 2, placeholder: "Brief description" })}
      <div style="display:flex;gap:0.5rem">
        ${formField("Type", "type", { type: "select", options: [{ value: "research", label: "Research" }, { value: "data_connector", label: "Data Connector" }], value: "research" })}
        ${formField("Tags", "tags", { placeholder: "Comma-separated tags" })}
      </div>
      <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:white;cursor:pointer;align-self:flex-start">Create Project</button>
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

  const content = `${css}${createForm}${filterBar}${projectsHtml}${paginationHtml}`;
  return layout({ title: `Projects (${totalCount})`, content });
}

async function renderDetailView(db, projectId, layout, lang) {
  const { rows: projRows } = await db.execute({
    sql: "SELECT * FROM research_projects WHERE id = ? AND (type IS NULL OR type != 'learner_profile')",
    args: [projectId],
  });

  if (projRows.length === 0) {
    const content = section("Not Found", `<p>Project #${escapeHtml(String(projectId))} not found.</p>`);
    return layout({ title: "Project Not Found", content });
  }

  const project = projRows[0];

  // Fetch related data in parallel (incl. M2 project_spaces extras + members,
  // M5 audit log).
  const [sourcesResult, notesResult, backendsResult, spaceResult, membersResult, contactsResult, auditResult] = await Promise.all([
    db.execute({ sql: "SELECT id, title, source_type, url, verified, created_at FROM research_sources WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", args: [projectId] }),
    db.execute({ sql: "SELECT id, note_type, substr(content, 1, 200) as preview, created_at FROM research_notes WHERE project_id = ? ORDER BY created_at DESC LIMIT 50", args: [projectId] }),
    db.execute({ sql: "SELECT id, name, backend_type, status FROM data_backends WHERE project_id = ?", args: [projectId] }),
    db.execute({ sql: "SELECT slug, workspace_dir, storage_prefix, archived_at FROM project_spaces WHERE id = ?", args: [projectId] }),
    db.execute({
      sql: `SELECT pm.id, pm.contact_id, pm.role, pm.capabilities, pm.mode, pm.granted_at, pm.revoked_at,
                   c.display_name, c.crow_id
              FROM project_members pm LEFT JOIN contacts c ON c.id = pm.contact_id
             WHERE pm.project_id = ? AND pm.revoked_at IS NULL
             ORDER BY pm.granted_at ASC`,
      args: [projectId],
    }),
    db.execute({ sql: "SELECT id, display_name, crow_id FROM contacts WHERE is_blocked = 0 ORDER BY display_name, id LIMIT 200" }),
    db.execute({
      sql: `SELECT created_at, actor_type, actor_id, action, target, payload
              FROM project_audit_log WHERE project_id = ?
             ORDER BY created_at DESC LIMIT 50`,
      args: [projectId],
    }),
  ]);

  const sources = sourcesResult.rows;
  const notes = notesResult.rows;
  const backends = backendsResult.rows;
  const space = spaceResult.rows[0] || {};
  const members = membersResult.rows;
  const contacts = contactsResult.rows;
  const auditEntries = auditResult.rows;

  // Back link + status controls
  const backLink = `<a href="/dashboard/projects" style="color:var(--crow-accent);text-decoration:none;font-size:0.85rem">← All Projects</a>`;

  const statusBadge = badge(project.status, STATUS_BADGE_MAP[project.status] || "draft");
  const statusOptions = ["active", "paused", "completed", "archived"]
    .filter(s => s !== project.status)
    .map(s => `<form method="POST" style="display:inline"><input type="hidden" name="action" value="update_status"><input type="hidden" name="id" value="${project.id}"><input type="hidden" name="status" value="${s}"><button type="submit" style="padding:0.25rem 0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-secondary);cursor:pointer;font-size:0.75rem">${s}</button></form>`)
    .join(" ");

  // Overview section
  const overviewHtml = `
    <div style="margin-bottom:1rem">${backLink}</div>
    <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem">
      <div>
        <h2 style="font-family:'Fraunces',serif;margin:0">${escapeHtml(project.name)}</h2>
        ${project.description ? `<p style="color:var(--crow-text-secondary);margin:0.25rem 0">${escapeHtml(project.description)}</p>` : ""}
      </div>
      <div>${statusBadge}</div>
    </div>
    <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.5rem">
      Type: ${escapeHtml(project.type)} · Created: ${formatDate(project.created_at, lang)} · Updated: ${formatDate(project.updated_at, lang)}
      ${project.tags ? ` · Tags: ${escapeHtml(project.tags)}` : ""}
    </div>
    <div style="margin-bottom:1rem">Change status: ${statusOptions}</div>
  `;

  // Sources table
  let sourcesHtml;
  if (sources.length === 0) {
    sourcesHtml = `<p style="color:var(--crow-text-muted);font-size:0.85rem">No sources yet. Add sources via crow_add_source.</p>`;
  } else {
    const rows = sources.map(s => [
      escapeHtml(s.title),
      badge(s.source_type, "info"),
      s.verified ? badge("verified", "connected") : badge("unverified", "draft"),
      s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" style="color:var(--crow-accent);font-size:0.8rem">link</a>` : "",
      `<span style="font-size:0.75rem">${formatDate(s.created_at, lang)}</span>`,
    ]);
    sourcesHtml = dataTable(["Title", "Type", "Status", "URL", "Added"], rows);
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
    ]);
    backendsHtml = section(`Data Backends (${backends.length})`, dataTable(["Name", "Type", "Status"], rows), { delay: 300 });
  }

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
      const removeForm = m.contact_id == null
        ? `<span style="color:var(--crow-text-muted);font-size:0.75rem">—</span>`
        : `<form method="POST" style="display:inline" onsubmit="return confirm('Revoke ${escapeHtml(who).replace(/'/g, "&#39;")}?')">
             <input type="hidden" name="action" value="remove_member">
             <input type="hidden" name="id" value="${project.id}">
             <input type="hidden" name="contact_id" value="${m.contact_id}">
             <button type="submit" style="padding:0.2rem 0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-secondary);cursor:pointer;font-size:0.7rem">revoke</button>
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
        <select name="contact_id" required style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);min-width:180px">
          <option value="">— pick contact —</option>
          ${contactOptions}
        </select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary)">Role
        <select name="role" required style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary)">${roleOptions}</select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.75rem;color:var(--crow-text-secondary);flex:1;min-width:220px">Capability overrides (JSON, optional)
        <input type="text" name="capabilities" placeholder='{"invoke_bot":false}' style="padding:0.4rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);font-family:monospace;font-size:0.8rem">
      </label>
      <button type="submit" style="padding:0.5rem 1rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:white;cursor:pointer">Add</button>
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
    auditHtml = `<p style="color:var(--crow-text-muted);font-size:0.85rem">No audit entries yet. Member changes, source/note/file writes, bot turns, and shares will appear here.</p>`;
  } else {
    const actorBadge = (t) => {
      const colorMap = { local: "info", bot: "connected", contact: "info", system: "draft" };
      return badge(t, colorMap[t] || "draft");
    };
    auditHtml = `<table style="width:100%;border-collapse:collapse;font-size:0.85rem">
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
    </table>
    ${auditEntries.length === 50 ? `<p style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.5rem">Showing latest 50 entries. Use the <code>crow_audit_log</code> MCP tool for filtering / older entries.</p>` : ""}`;
  }

  // M5: soft-archive control — a banner when project is archived, plus an
  // "Archive" action on active projects. Archive writes status='archived'
  // via the existing update_status path; we add a corresponding "Unarchive"
  // action that reverses it. Sources/notes/files remain attached but
  // hidden from the active list (the existing list view filters on status).
  const archiveBanner = space.archived_at
    ? `<div style="margin-bottom:1rem;padding:0.5rem 0.75rem;background:var(--crow-bg-surface);border:1px solid var(--crow-accent-muted);border-radius:var(--crow-radius-card);font-size:0.85rem;color:var(--crow-text-secondary)">
         <b>Archived</b> ${escapeHtml(space.archived_at)} — content is preserved; the project no longer appears in the active list.
         <form method="POST" style="display:inline;margin-left:0.5rem">
           <input type="hidden" name="action" value="update_status">
           <input type="hidden" name="id" value="${project.id}">
           <input type="hidden" name="status" value="active">
           <button type="submit" style="padding:0.2rem 0.5rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);cursor:pointer;font-size:0.75rem">Unarchive</button>
         </form>
       </div>`
    : "";

  const content = `
    ${archiveBanner}
    ${section("Overview", overviewHtml + workspaceInfo)}
    ${section(`Members (${members.length})`, membersHtml + addMemberForm, { delay: 50 })}
    ${section(`Sources (${sources.length})`, sourcesHtml, { delay: 100 })}
    ${section(`Notes (${notes.length})`, notesHtml, { delay: 200 })}
    ${backendsHtml}
    ${section(`Audit log (${auditEntries.length})`, auditHtml, { delay: 350 })}
  `;

  return layout({ title: project.name, content });
}
