/**
 * Blog Panel — List, create, edit, preview, publish posts
 */

import { escapeHtml, statCard, statGrid, dataTable, section, formField, badge, actionBar, formatDate } from "../shared/components.js";

export default {
  id: "blog",
  name: "Blog",
  icon: "edit",
  route: "/dashboard/blog",
  navOrder: 20,

  async handler(req, res, { db, layout }) {
    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "create") {
        const { title, content, tags, visibility } = req.body;
        if (!title || !content) {
          return layout({
            title: "Blog",
            content: `<div class="alert alert-error">Title and content are required.</div>`,
          });
        }
        const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
        await db.execute({
          sql: "INSERT INTO blog_posts (slug, title, content, visibility, tags) VALUES (?, ?, ?, ?, ?)",
          args: [slug, title, content, visibility || "private", tags || null],
        });
        res.redirect("/dashboard/blog");
        return;
      }

      if (action === "publish") {
        await db.execute({
          sql: "UPDATE blog_posts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
          args: [req.body.id],
        });
        res.redirect("/dashboard/blog");
        return;
      }

      if (action === "unpublish") {
        await db.execute({
          sql: "UPDATE blog_posts SET status = 'draft', updated_at = datetime('now') WHERE id = ?",
          args: [req.body.id],
        });
        res.redirect("/dashboard/blog");
        return;
      }

      if (action === "delete") {
        await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [req.body.id] });
        res.redirect("/dashboard/blog");
        return;
      }
    }

    // GET — show post list
    const totalResult = await db.execute("SELECT COUNT(*) as c FROM blog_posts");
    const publishedResult = await db.execute("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'published'");
    const draftResult = await db.execute("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'draft'");

    const stats = statGrid([
      statCard("Total", totalResult.rows[0]?.c || 0, { delay: 0 }),
      statCard("Published", publishedResult.rows[0]?.c || 0, { delay: 50 }),
      statCard("Drafts", draftResult.rows[0]?.c || 0, { delay: 100 }),
    ]);

    // Post list
    const posts = await db.execute({
      sql: "SELECT id, slug, title, status, visibility, tags, published_at, created_at FROM blog_posts ORDER BY created_at DESC LIMIT 50",
      args: [],
    });

    let postTable;
    if (posts.rows.length === 0) {
      postTable = `<div class="empty-state"><h3>No posts yet</h3><p>Create your first post below.</p></div>`;
    } else {
      const rows = posts.rows.map((p) => {
        const statusBadge = badge(p.status, p.status === "published" ? "published" : "draft");
        const visBadge = p.visibility !== "private" ? ` ${badge(p.visibility, "connected")}` : "";
        const actions = p.status === "published"
          ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="unpublish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-secondary" type="submit">Unpublish</button></form>`
          : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="publish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-primary" type="submit">Publish</button></form>`;
        const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('Delete this post?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`;

        return [
          `${escapeHtml(p.title)}`,
          `${statusBadge}${visBadge}`,
          `<span class="mono">${escapeHtml(p.slug)}</span>`,
          `<span class="mono">${formatDate(p.published_at || p.created_at)}</span>`,
          `${actions} ${deleteBtn}`,
        ];
      });
      postTable = dataTable(["Title", "Status", "Slug", "Date", "Actions"], rows);
    }

    // Create form
    const createForm = `<form method="POST">
      <input type="hidden" name="action" value="create">
      ${formField("Title", "title", { required: true, placeholder: "Post title" })}
      ${formField("Content", "content", { type: "textarea", required: true, placeholder: "Write in Markdown...", rows: 8 })}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        ${formField("Tags", "tags", { placeholder: "tag1, tag2, tag3" })}
        ${formField("Visibility", "visibility", { type: "select", options: [
          { value: "private", label: "Private" },
          { value: "public", label: "Public" },
          { value: "peers", label: "Peers Only" },
        ]})}
      </div>
      <button type="submit" class="btn btn-primary">Create Draft</button>
    </form>`;

    const content = `
      ${stats}
      ${section("Posts", postTable, { delay: 150 })}
      ${section("New Post", createForm, { delay: 200 })}
    `;

    return layout({ title: "Blog", content });
  },
};
