/**
 * Memory Panel — Browse, search, and view stored memories
 */

import { escapeHtml, statCard, statGrid, section, badge, formatDate, dataTable, formField } from "../shared/components.js";
import { sanitizeFtsQuery } from "../../../db.js";
import { ICON_MEMORY } from "../shared/empty-state-icons.js";

const PAGE_SIZE = 20;

export default {
  id: "memory",
  name: "Memory",
  icon: "memory",
  route: "/dashboard/memory",
  navOrder: 15,

  async handler(req, res, { db, layout }) {
    // Handle POST actions (edit, delete)
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "delete") {
        await db.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [req.body.id] });
        res.redirect("/dashboard/memory");
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
        res.redirect("/dashboard/memory");
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
        ${formField("Category", "category", { value: mem.category || "general", placeholder: "general" })}
        ${formField("Importance", "importance", { type: "select", value: String(mem.importance || 5), options: [
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
        ${formField("Content", "content", { type: "textarea", value: mem.content || "", rows: 10, required: true })}
        <div style="display:flex;gap:0.5rem;margin-top:1rem">
          <button type="submit" class="btn btn-primary">Save</button>
          <a href="/dashboard/memory" class="btn btn-secondary">Cancel</a>
        </div>
      </form>`;

      const content = section(`Edit Memory #${escapeHtml(String(mem.id))}`, editForm);
      return layout({ title: "Edit Memory", content });
    }

    const query = req.query.q || "";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    // Stats
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM memories");
    const totalCount = totalResult.rows[0]?.c || 0;

    const categoryResult = await db.execute(
      "SELECT category, COUNT(*) as c FROM memories GROUP BY category ORDER BY c DESC"
    );

    const categoryCards = categoryResult.rows.map((row, i) =>
      statCard(escapeHtml(row.category || "uncategorized"), row.c, { delay: 50 + i * 50 })
    );

    const stats = statGrid([
      statCard("Total Memories", totalCount, { delay: 0 }),
      ...categoryCards,
    ]);

    // Search form
    const searchForm = `<form method="GET" action="/dashboard/memory" style="display:flex;gap:0.5rem;margin-bottom:1.5rem">
      <input type="text" name="q" value="${escapeHtml(query)}" placeholder="Search memories..." style="flex:1">
      <button type="submit" class="btn btn-primary">Search</button>
      ${query ? `<a href="/dashboard/memory" class="btn btn-secondary">Clear</a>` : ""}
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
        memoryList = `<div class="empty-state"><h3>No memories matching "${escapeHtml(query)}".</h3></div>`;
      } else {
        memoryList = `<div class="empty-state">
          <div style="margin-bottom:1rem">${ICON_MEMORY}</div>
          <h3>No memories yet</h3>
          <p>Ask your AI to remember something to get started.</p>
        </div>`;
      }
    } else {
      const rows = memories.map((m) => {
        const content = String(m.content || "");
        const preview = content.length > 200 ? escapeHtml(content.slice(0, 200)) + "..." : escapeHtml(content);
        const categoryBadge = badge(m.category || "general", "draft");
        const importanceIndicator = renderImportance(m.importance);
        const editBtn = `<a href="/dashboard/memory?edit=${m.id}" class="btn btn-sm btn-secondary">Edit</a>`;
        const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('Delete this memory?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${m.id}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`;
        return [
          categoryBadge,
          importanceIndicator,
          `<span style="font-size:0.9rem">${preview}</span>`,
          `<span class="mono">${formatDate(m.updated_at)}</span>`,
          `${editBtn} ${deleteBtn}`,
        ];
      });
      memoryList = dataTable(["Category", "Importance", "Content", "Updated", "Actions"], rows);
    }

    // Pagination
    const totalPages = Math.ceil(matchCount / PAGE_SIZE);
    let pagination = "";
    if (totalPages > 1) {
      const baseUrl = query ? `/dashboard/memory?q=${encodeURIComponent(query)}` : "/dashboard/memory?";
      const sep = query ? "&" : "";
      const links = [];
      if (page > 1) {
        links.push(`<a href="${baseUrl}${sep}page=${page - 1}" class="btn btn-sm btn-secondary">Previous</a>`);
      }
      links.push(`<span style="color:var(--crow-text-muted);font-size:0.85rem">Page ${page} of ${totalPages} (${matchCount} ${query ? "matches" : "memories"})</span>`);
      if (page < totalPages) {
        links.push(`<a href="${baseUrl}${sep}page=${page + 1}" class="btn btn-sm btn-secondary">Next</a>`);
      }
      pagination = `<div style="display:flex;align-items:center;justify-content:center;gap:1rem;margin-top:1rem">${links.join("")}</div>`;
    }

    const content = `
      ${stats}
      ${searchForm}
      ${section(query ? `Search Results` : "Recent Memories", memoryList + pagination, { delay: 150 })}
    `;

    return layout({ title: "Memory", content });
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
