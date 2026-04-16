/**
 * Memory Panel — Browse, search, and view stored memories
 */

import { escapeHtml, section, badge, formatDate, dataTable, formField } from "../shared/components.js";
import { sanitizeFtsQuery } from "../../../db.js";
import { ICON_MEMORY } from "../shared/empty-state-icons.js";
import { t, tJs } from "../shared/i18n.js";

const PAGE_SIZE = 20;

export default {
  id: "memory",
  name: "Memory",
  icon: "memory",
  route: "/dashboard/memory",
  navOrder: 15,
  category: "core",

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
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    // Stats
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM memories");
    const totalCount = totalResult.rows[0]?.c || 0;

    // Search form
    const searchForm = `<form method="GET" action="/dashboard/memory" style="display:flex;gap:0.5rem;margin-bottom:1.5rem">
      <input type="text" name="q" value="${escapeHtml(query)}" placeholder="${t("memory.searchPlaceholder", lang)}" style="flex:1">
      <button type="submit" class="btn btn-primary">${t("memory.search", lang)}</button>
      ${query ? `<a href="/dashboard/memory" class="btn btn-secondary">${t("memory.clear", lang)}</a>` : ""}
    </form>`;

    // Fetch memories
    let memories = [];
    let matchCount = 0;

    if (query) {
      const ftsQuery = sanitizeFtsQuery(query);
      if (ftsQuery) {
        // Count matches
        const countResult = await db.execute({
          sql: "SELECT COUNT(*) as c FROM memories_fts WHERE memories_fts MATCH ?",
          args: [ftsQuery],
        });
        matchCount = countResult.rows[0]?.c || 0;

        // Fetch page
        const result = await db.execute({
          sql: `SELECT m.id, m.content, m.category, m.importance, m.created_at, m.updated_at
                FROM memories_fts f
                JOIN memories m ON m.rowid = f.rowid
                WHERE memories_fts MATCH ?
                ORDER BY m.updated_at DESC
                LIMIT ? OFFSET ?`,
          args: [ftsQuery, PAGE_SIZE, offset],
        });
        memories = result.rows;
      }
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
      if (query) {
        memoryList = `<div class="empty-state"><h3>0 ${t("memory.matches", lang)}: "${escapeHtml(query)}"</h3></div>`;
      } else {
        memoryList = `<div class="empty-state">
          <div style="margin-bottom:1rem">${ICON_MEMORY}</div>
          <h3>${t("memory.noMemoriesYet", lang)}</h3>
          <p>${t("memory.askAiToRemember", lang)}</p>
        </div>`;
      }
    } else {
      const rows = memories.map((m) => {
        const content = String(m.content || "");
        const preview = content.length > 200 ? escapeHtml(content.slice(0, 200)) + "..." : escapeHtml(content);
        const categoryBadge = badge(m.category || "general", "draft");
        const importanceIndicator = renderImportance(m.importance);
        const editBtn = `<a href="/dashboard/memory?edit=${m.id}" class="btn btn-sm btn-secondary">${t("memory.edit", lang)}</a>`;
        const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('${tJs("memory.deleteConfirm", lang)}')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${m.id}"><button class="btn btn-sm btn-danger" type="submit">${t("memory.delete", lang)}</button></form>`;
        return [
          categoryBadge,
          importanceIndicator,
          `<span style="font-size:0.9rem">${preview}</span>`,
          `<span class="mono">${formatDate(m.updated_at, lang)}</span>`,
          `${editBtn} ${deleteBtn}`,
        ];
      });
      memoryList = dataTable([t("memory.categoryLabel", lang), t("memory.importanceLabel", lang), t("memory.contentLabel", lang), t("memory.updatedLabel", lang), t("memory.actionsLabel", lang)], rows);
    }

    // Pagination
    const totalPages = Math.ceil(matchCount / PAGE_SIZE);
    let pagination = "";
    if (totalPages > 1) {
      const baseUrl = query ? `/dashboard/memory?q=${encodeURIComponent(query)}` : "/dashboard/memory?";
      const sep = query ? "&" : "";
      const links = [];
      if (page > 1) {
        links.push(`<a href="${baseUrl}${sep}page=${page - 1}" class="btn btn-sm btn-secondary">${t("memory.previous", lang)}</a>`);
      }
      links.push(`<span style="color:var(--crow-text-muted);font-size:0.85rem">${page} / ${totalPages} (${matchCount} ${query ? t("memory.matches", lang) : t("memory.memoriesCount", lang)})</span>`);
      if (page < totalPages) {
        links.push(`<a href="${baseUrl}${sep}page=${page + 1}" class="btn btn-sm btn-secondary">${t("memory.next", lang)}</a>`);
      }
      pagination = `<div style="display:flex;align-items:center;justify-content:center;gap:1rem;margin-top:1rem">${links.join("")}</div>`;
    }

    const content = `
      ${searchForm}
      ${section(query ? t("memory.searchResults", lang) : t("memory.recentMemories", lang), memoryList + pagination, { delay: 150 })}
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
