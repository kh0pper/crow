/**
 * Memory Panel — Browse, search, and view stored memories
 *
 * Federated single-memory view: when `?edit=<id>&instance=<instance-uuid>` is
 * passed and the instance UUID is not the local instance, this panel queries
 * the remote paired instance via the federation MCP client (populated by
 * proxy.js:loadRemoteInstances) and renders a read-only view. Used by MPA's
 * briefing notifications so primary can open `edit=184&instance=520a…`
 * without needing the memory to be synced locally. Local edit/delete paths
 * are unchanged.
 */

import { escapeHtml, section, badge, formatDate, dataTable, formField } from "../shared/components.js";
import { sanitizeFtsQuery } from "../../../db.js";
import { createDbClient } from "../../../db.js";
import { ICON_MEMORY } from "../shared/empty-state-icons.js";
import { t, tJs } from "../shared/i18n.js";
import { connectedServers } from "../../proxy.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";
import { renderMarkdown } from "../../../blog/renderer.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname as osHostname } from "node:os";

const PAGE_SIZE = 20;

/**
 * Look up an instance's registered metadata from the local crow_instances
 * row (primary stores one row per paired peer). Returns null if not found.
 */
async function getInstanceRow(localDb, instanceId) {
  const { rows } = await localDb.execute({
    sql: "SELECT id, name, hostname, data_dir FROM crow_instances WHERE id = ?",
    args: [instanceId],
  });
  return rows[0] || null;
}

/**
 * Fast path for same-host federated reads. When the target instance lives
 * on the same filesystem, we read its crow.db directly with a fresh
 * libsql client instead of routing through its MCP server. This is the
 * only reliable way to pull a memory off MPA right now — MPA's long-lived
 * libsql handle has a chronic WAL wedge (see Day 1 gotcha and
 * servers/sharing/peer-pull-sync.js:9-17) that makes its MCP-served reads
 * return `not_found` for any memory written by the pipeline subprocess
 * since the last MPA restart. A fresh-process read from primary has no
 * such state and always sees current on-disk data.
 *
 * Returns the memory payload or null if the file is unreachable / row
 * missing / shape wrong.
 */
async function fetchRemoteMemoryDirectDb(instance, memoryId) {
  if (!instance.data_dir) return null;
  if (instance.hostname && instance.hostname !== osHostname()) return null;
  const dbPath = join(instance.data_dir, "crow.db");
  if (!existsSync(dbPath)) return null;

  const peerDb = createDbClient(dbPath);
  try {
    const { rows } = await peerDb.execute({
      sql: "SELECT id, content, category, importance, tags, source, created_at, updated_at, accessed_at, access_count, context, instance_id, project_id FROM memories WHERE id = ?",
      args: [Number(memoryId)],
    });
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      memory: {
        id: Number(r.id),
        content: r.content,
        category: r.category,
        importance: Number(r.importance),
        tags: r.tags,
        source: r.source,
        context: r.context,
        instance_id: r.instance_id,
        project_id: r.project_id != null ? Number(r.project_id) : null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        accessed_at: r.accessed_at,
        access_count: Number(r.access_count || 0),
      },
      instanceName: instance.name,
    };
  } catch (err) {
    console.warn(`[memory-panel] direct-db read failed for ${instanceId(instance)}/#${memoryId}: ${err.message}`);
    return null;
  } finally {
    try { peerDb.close(); } catch {}
  }
}

function instanceId(inst) { return String(inst?.id || "").slice(0, 8) + "…"; }

/**
 * Fetch a single memory from a paired instance. Prefers direct DB access
 * for same-host peers (bypasses MPA's libsql-in-process wedge). Falls
 * back to federation MCP for cross-host peers or when direct read
 * returns nothing. Recovers from stale MCP sessions by dropping the
 * cached client and re-running loadRemoteInstances once.
 */
async function fetchRemoteMemory(localDb, instanceId, memoryId, { allowRetry = true } = {}) {
  // Same-host direct read — preferred path.
  const inst = await getInstanceRow(localDb, instanceId);
  if (inst) {
    const direct = await fetchRemoteMemoryDirectDb(inst, memoryId);
    if (direct) return direct;
  }

  // Fall back to federation MCP (for cross-host peers).
  const key = `instance-${instanceId}`;
  const entry = connectedServers.get(key);
  if (!entry || entry.status !== "connected" || !entry.client) {
    if (allowRetry) {
      const { loadRemoteInstances } = await import("../../proxy.js");
      await loadRemoteInstances();
      return fetchRemoteMemory(localDb, instanceId, memoryId, { allowRetry: false });
    }
    return null;
  }
  try {
    const result = await entry.client.callTool({
      name: "crow_get_memory",
      arguments: { id: Number(memoryId) },
    });
    const text = result?.content?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (parsed.error) return null;
    return { memory: parsed, instanceName: entry.instanceName };
  } catch (err) {
    const msg = err?.message || "";
    if (allowRetry && /No valid session ID|session.*expired|Bad Request/i.test(msg)) {
      console.warn(`[memory-panel] federation session stale for ${instanceId.slice(0, 8)}…, reconnecting`);
      try { await entry.client.close?.(); } catch {}
      connectedServers.delete(key);
      const { loadRemoteInstances } = await import("../../proxy.js");
      await loadRemoteInstances();
      return fetchRemoteMemory(localDb, instanceId, memoryId, { allowRetry: false });
    }
    console.warn(`[memory-panel] federation lookup failed for ${instanceId.slice(0, 8)}…/#${memoryId}: ${msg}`);
    return null;
  }
}

export default {
  id: "memory",
  name: "Memory",
  icon: "memory",
  route: "/dashboard/memory",
  navOrder: 15,
  category: "core",
  preload: true,

  async handler(req, res, { db, layout, lang }) {
    // Handle POST actions (edit, delete)
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "delete") {
        await db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [req.body.id] });
        res.redirectAfterPost("/dashboard/memory");
        return;
      }

      if (action === "edit") {
        const { id, content, category, importance } = req.body;
        if (id && content) {
          await db.execute({
            sql: "UPDATE memories SET content = ?, category = ?, importance = ?, updated_at = datetime('now') WHERE id = ?",
            args: [content, category || "general", parseInt(importance, 10) || 5, id],
          });
        }
        res.redirectAfterPost("/dashboard/memory");
        return;
      }
    }

    // Handle single memory view/edit
    const editId = req.query.edit;
    if (editId) {
      // If caller pointed us at a specific instance and that instance isn't
      // local, try federation before falling through. Local-instance IDs
      // pass through to the normal local-DB path so stale `?instance=`
      // params don't break existing flows.
      const requestedInstance = req.query.instance;
      const localInstanceId = getOrCreateLocalInstanceId();
      if (requestedInstance && requestedInstance !== localInstanceId) {
        const remote = await fetchRemoteMemory(db, requestedInstance, editId);
        if (remote) {
          const m = remote.memory;
          const contentHtml = `<div class="crow-memory-federated-body" style="background:var(--crow-bg-elevated);padding:1rem 1.25rem;border-radius:0.5rem;margin:0;line-height:1.55">${renderMarkdown(String(m.content || ""))}</div>`;
          const metaRows = [
            ["ID", `#${escapeHtml(String(m.id))}`],
            ["Category", escapeHtml(m.category || "general")],
            ["Importance", `${escapeHtml(String(m.importance ?? ""))} / 10`],
            ["Tags", escapeHtml(m.tags || "—")],
            ["Created", escapeHtml(m.created_at || "")],
            ["Updated", escapeHtml(m.updated_at || "")],
            ["Origin", `${escapeHtml(remote.instanceName)} <span style="color:var(--crow-text-muted)">(federated — read-only)</span>`],
          ];
          const metaHtml = `<div style="display:grid;grid-template-columns:max-content 1fr;gap:0.5rem 1rem;margin-bottom:1rem;font-size:0.9rem">
            ${metaRows.map(([k, v]) => `<div style="color:var(--crow-text-muted)">${k}</div><div>${v}</div>`).join("")}
          </div>`;
          const backBtn = `<a href="/dashboard/memory" class="btn btn-secondary" style="margin-top:1rem">${t("memory.cancel", lang)}</a>`;
          const content = section(`${t("memory.viewPageTitle", lang)} #${escapeHtml(String(m.id))}`, metaHtml + contentHtml + backBtn);
          return layout({ title: t("memory.viewPageTitle", lang), content });
        }
        // Federation failed — fall through to local lookup so user at least
        // sees a useful "not found" redirect rather than a blank page.
      }

      const result = await db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [editId] });
      const mem = result.rows[0];
      if (!mem) {
        res.redirect("/dashboard/memory");
        return;
      }

      const editForm = `<form method="POST">
        <input type="hidden" name="action" value="edit">
        <input type="hidden" name="id" value="${escapeHtml(String(mem.id))}">
        ${formField(t("memory.categoryLabel", lang), "category", { value: mem.category || "general", placeholder: "general" })}
        ${formField(t("memory.importanceLabel", lang), "importance", { type: "select", value: String(mem.importance || 5), options: [
          { value: "1", label: "1 — Low" },
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
          { value: "5", label: "5 — Normal" },
          { value: "6", label: "6" },
          { value: "7", label: "7" },
          { value: "8", label: "8 — High" },
          { value: "9", label: "9" },
          { value: "10", label: "10 — Critical" },
        ]})}
        ${formField(t("memory.contentLabel", lang), "content", { type: "textarea", value: mem.content || "", rows: 10, required: true })}
        <div style="display:flex;gap:0.5rem;margin-top:1rem">
          <button type="submit" class="btn btn-primary">${t("memory.save", lang)}</button>
          <a href="/dashboard/memory" class="btn btn-secondary">${t("memory.cancel", lang)}</a>
        </div>
      </form>`;

      const content = section(`${t("memory.editPageTitle", lang)} #${escapeHtml(String(mem.id))}`, editForm);
      return layout({ title: t("memory.editPageTitle", lang), content });
    }

    const query = req.query.q || "";
    const categoryFilter = (req.query.category || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    // Stats
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM memories");
    const totalCount = totalResult.rows[0]?.c || 0;

    // Distinct categories for filter dropdown. Empty strings and nulls
    // collapse into the "All" option via the empty-value <option> below.
    const categoriesResult = await db.execute(
      "SELECT category, COUNT(*) as c FROM memories WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY category"
    );
    const categoryOptions = categoriesResult.rows
      .map((r) => {
        const value = escapeHtml(r.category);
        const selected = r.category === categoryFilter ? " selected" : "";
        return `<option value="${value}"${selected}>${value} (${r.c})</option>`;
      })
      .join("");

    // Search form — targets the memory-results frame so submissions swap
    // only the results list (+ pagination) without a full-page reload.
    // Turbo updates the URL via data-turbo-action="advance" on the frame.
    const searchForm = `<form method="GET" action="/dashboard/memory" data-turbo-frame="memory-results" style="display:flex;gap:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap">
      <input type="text" name="q" value="${escapeHtml(query)}" placeholder="${t("memory.searchPlaceholder", lang)}" style="flex:1;min-width:220px">
      <select name="category" style="min-width:180px" onchange="this.form.requestSubmit()">
        <option value="">${t("memory.allCategories", lang)}</option>
        ${categoryOptions}
      </select>
      <button type="submit" class="btn btn-primary">${t("memory.search", lang)}</button>
      ${query || categoryFilter ? `<a href="/dashboard/memory" data-turbo-frame="memory-results" class="btn btn-secondary">${t("memory.clear", lang)}</a>` : ""}
    </form>`;

    // Fetch memories
    let memories = [];
    let matchCount = 0;

    if (query) {
      const ftsQuery = sanitizeFtsQuery(query);
      if (ftsQuery) {
        const countSql = categoryFilter
          ? "SELECT COUNT(*) as c FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND m.category = ?"
          : "SELECT COUNT(*) as c FROM memories_fts WHERE memories_fts MATCH ?";
        const countArgs = categoryFilter ? [ftsQuery, categoryFilter] : [ftsQuery];
        const countResult = await db.execute({ sql: countSql, args: countArgs });
        matchCount = countResult.rows[0]?.c || 0;

        const pageSql = categoryFilter
          ? `SELECT m.id, m.content, m.category, m.importance, m.created_at, m.updated_at
             FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.category = ?
             ORDER BY m.updated_at DESC LIMIT ? OFFSET ?`
          : `SELECT m.id, m.content, m.category, m.importance, m.created_at, m.updated_at
             FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ?
             ORDER BY m.updated_at DESC LIMIT ? OFFSET ?`;
        const pageArgs = categoryFilter
          ? [ftsQuery, categoryFilter, PAGE_SIZE, offset]
          : [ftsQuery, PAGE_SIZE, offset];
        const result = await db.execute({ sql: pageSql, args: pageArgs });
        memories = result.rows;
      }
    } else if (categoryFilter) {
      const countResult = await db.execute({
        sql: "SELECT COUNT(*) as c FROM memories WHERE category = ?",
        args: [categoryFilter],
      });
      matchCount = countResult.rows[0]?.c || 0;
      const result = await db.execute({
        sql: `SELECT id, content, category, importance, created_at, updated_at
              FROM memories
              WHERE category = ?
              ORDER BY updated_at DESC
              LIMIT ? OFFSET ?`,
        args: [categoryFilter, PAGE_SIZE, offset],
      });
      memories = result.rows;
    } else {
      matchCount = totalCount;
      const result = await db.execute({
        sql: `SELECT id, content, category, importance, created_at, updated_at
              FROM memories
              ORDER BY updated_at DESC
              LIMIT ? OFFSET ?`,
        args: [PAGE_SIZE, offset],
      });
      memories = result.rows;
    }

    // Render memory cards
    let memoryList;
    if (memories.length === 0) {
      if (query || categoryFilter) {
        const filterLabel = [
          query ? `"${escapeHtml(query)}"` : null,
          categoryFilter ? `${t("memory.categoryLabel", lang)}: ${escapeHtml(categoryFilter)}` : null,
        ].filter(Boolean).join(" + ");
        memoryList = `<div class="empty-state"><h3>0 ${t("memory.matches", lang)}: ${filterLabel}</h3></div>`;
      } else {
        memoryList = `<div class="empty-state">
          <div style="margin-bottom:1rem">${ICON_MEMORY}</div>
          <h3>${t("memory.noMemoriesYet", lang)}</h3>
          <p>${t("memory.askAiToRemember", lang)}</p>
        </div>`;
      }
    } else {
      // Each row wraps its preview in a <details>; clicking the summary
      // expands to show the full memory inline without leaving the list
      // or triggering a navigation. The collapsed state still keeps all
      // the row controls (edit/delete) visible in the Actions column.
      const rows = memories.map((m) => {
        const content = String(m.content || "");
        const categoryBadge = badge(m.category || "general", "draft");
        const importanceIndicator = renderImportance(m.importance);
        const editBtn = `<a href="/dashboard/memory?edit=${m.id}" data-turbo-frame="_top" class="btn btn-sm btn-secondary">${t("memory.edit", lang)}</a>`;
        const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('${tJs("memory.deleteConfirm", lang)}')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${m.id}"><button class="btn btn-sm btn-danger" type="submit">${t("memory.delete", lang)}</button></form>`;

        const isLong = content.length > 200;
        const previewText = isLong ? content.slice(0, 200) + "…" : content;
        const contentCell = isLong
          ? `<details style="font-size:0.9rem">
               <summary style="cursor:pointer;list-style:none;outline:none">
                 <span style="font-size:0.9rem">${escapeHtml(previewText)}</span>
                 <span style="color:var(--crow-text-muted);font-size:0.8rem;margin-left:0.5rem" class="expand-label">(show more)</span>
               </summary>
               <pre style="white-space:pre-wrap;font-family:inherit;line-height:1.5;margin:0.5rem 0 0;padding:0.75rem;background:var(--crow-bg-elevated);border-radius:0.25rem">${escapeHtml(content)}</pre>
             </details>`
          : `<span style="font-size:0.9rem">${escapeHtml(content)}</span>`;

        return [
          categoryBadge,
          importanceIndicator,
          contentCell,
          `<span class="mono">${formatDate(m.updated_at, lang)}</span>`,
          `${editBtn} ${deleteBtn}`,
        ];
      });
      memoryList = dataTable([t("memory.categoryLabel", lang), t("memory.importanceLabel", lang), t("memory.contentLabel", lang), t("memory.updatedLabel", lang), t("memory.actionsLabel", lang)], rows);
    }

    // Pagination — page links preserve q + category params.
    const totalPages = Math.ceil(matchCount / PAGE_SIZE);
    let pagination = "";
    if (totalPages > 1) {
      const buildPageUrl = (p) => {
        const ps = new URLSearchParams();
        if (query) ps.set("q", query);
        if (categoryFilter) ps.set("category", categoryFilter);
        ps.set("page", String(p));
        return `/dashboard/memory?${ps.toString()}`;
      };
      const countLabel = (query || categoryFilter) ? t("memory.matches", lang) : t("memory.memoriesCount", lang);
      const links = [];
      if (page > 1) {
        links.push(`<a href="${buildPageUrl(page - 1)}" class="btn btn-sm btn-secondary">${t("memory.previous", lang)}</a>`);
      }
      links.push(`<span style="color:var(--crow-text-muted);font-size:0.85rem">${page} / ${totalPages} (${matchCount} ${countLabel})</span>`);
      if (page < totalPages) {
        links.push(`<a href="${buildPageUrl(page + 1)}" class="btn btn-sm btn-secondary">${t("memory.next", lang)}</a>`);
      }
      pagination = `<div style="display:flex;align-items:center;justify-content:center;gap:1rem;margin-top:1rem">${links.join("")}</div>`;
    }

    // Results + pagination live inside a Turbo Frame so form submits and
    // page-link clicks swap only the list, preserving search-form focus
    // and scroll position. data-turbo-action="advance" pushes the URL
    // so back/forward and bookmarks work as usual. A GET to this route
    // always includes the frame in its full-page response, so Turbo can
    // extract and swap it cleanly.
    const framedResults = `
      <turbo-frame id="memory-results" data-turbo-action="advance">
        ${memoryList + pagination}
      </turbo-frame>
    `;

    const content = `
      ${searchForm}
      ${section(query ? t("memory.searchResults", lang) : t("memory.recentMemories", lang), framedResults, { delay: 150 })}
    `;

    return layout({ title: t("memory.pageTitle", lang), content });
  },
};

/**
 * Render importance as a visual indicator (filled dots).
 */
function renderImportance(importance) {
  const level = Math.min(Math.max(parseInt(importance, 10) || 0, 0), 5);
  const filled = "\u25CF".repeat(level);
  const empty = "\u25CB".repeat(5 - level);
  return `<span title="Importance: ${level}/5" style="letter-spacing:0.1em;color:var(--crow-accent)">${filled}</span><span style="letter-spacing:0.1em;color:var(--crow-text-muted)">${empty}</span>`;
}
