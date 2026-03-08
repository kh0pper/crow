/**
 * Crow Blog MCP Server
 *
 * Lightweight blogging platform with Markdown rendering, RSS feeds,
 * theme customization, and export to static site generators.
 *
 * Factory function: createBlogServer(dbPath?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient, sanitizeFtsQuery, escapeLikePattern } from "../db.js";
import { generateSlug, generateExcerpt } from "./renderer.js";

export function createBlogServer(dbPath) {
  const server = new McpServer({
    name: "crow-blog",
    version: "0.1.0",
  });

  const db = createDbClient(dbPath);

  /**
   * Ensure slug is unique, appending -2, -3, etc. if needed.
   */
  async function uniqueSlug(slug, excludeId) {
    let candidate = slug;
    let suffix = 2;
    while (true) {
      const existing = await db.execute({
        sql: excludeId
          ? "SELECT id FROM blog_posts WHERE slug = ? AND id != ?"
          : "SELECT id FROM blog_posts WHERE slug = ?",
        args: excludeId ? [candidate, excludeId] : [candidate],
      });
      if (existing.rows.length === 0) return candidate;
      candidate = `${slug}-${suffix++}`;
    }
  }

  // --- crow_create_post ---
  server.tool(
    "crow_create_post",
    "Create a new blog post draft",
    {
      title: z.string().max(500).describe("Post title"),
      content: z.string().max(50000).describe("Markdown content"),
      slug: z.string().max(100).optional().describe("Custom URL slug (auto-generated from title if omitted)"),
      excerpt: z.string().max(1000).optional().describe("Short excerpt (auto-generated if omitted)"),
      author: z.string().max(200).optional().describe("Author name"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
      cover_image_key: z.string().max(500).optional().describe("S3 key for cover image"),
      visibility: z.enum(["private", "public", "peers"]).optional().describe("Post visibility (default: private)"),
    },
    async ({ title, content, slug, excerpt, author, tags, cover_image_key, visibility }) => {
      const baseSlug = slug || generateSlug(title);
      const finalSlug = await uniqueSlug(baseSlug);
      const finalExcerpt = excerpt || generateExcerpt(content);

      const result = await db.execute({
        sql: `INSERT INTO blog_posts (slug, title, content, excerpt, author, tags, cover_image_key, visibility)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [finalSlug, title, content, finalExcerpt, author || null, tags || null, cover_image_key || null, visibility || "private"],
      });

      return {
        content: [{
          type: "text",
          text: `Created draft: "${title}"\nID: ${result.lastInsertRowid}\nSlug: ${finalSlug}\nVisibility: ${visibility || "private"}\n\nUse crow_publish_post to make it live.`,
        }],
      };
    }
  );

  // --- crow_edit_post ---
  server.tool(
    "crow_edit_post",
    "Update an existing blog post",
    {
      id: z.number().describe("Post ID"),
      title: z.string().max(500).optional().describe("New title"),
      content: z.string().max(50000).optional().describe("New markdown content"),
      slug: z.string().max(100).optional().describe("New slug"),
      excerpt: z.string().max(1000).optional().describe("New excerpt"),
      author: z.string().max(200).optional().describe("Author name"),
      tags: z.string().max(500).optional().describe("Comma-separated tags"),
      cover_image_key: z.string().max(500).optional().describe("S3 key for cover image"),
      visibility: z.enum(["private", "public", "peers"]).optional(),
    },
    async ({ id, title, content, slug, excerpt, author, tags, cover_image_key, visibility }) => {
      const existing = await db.execute({ sql: "SELECT * FROM blog_posts WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found.` }], isError: true };
      }

      const updates = [];
      const args = [];

      if (title !== undefined) { updates.push("title = ?"); args.push(title); }
      if (content !== undefined) {
        updates.push("content = ?");
        args.push(content);
        if (!excerpt) {
          updates.push("excerpt = ?");
          args.push(generateExcerpt(content));
        }
      }
      if (slug !== undefined) {
        const finalSlug = await uniqueSlug(slug, id);
        updates.push("slug = ?");
        args.push(finalSlug);
      }
      if (excerpt !== undefined) { updates.push("excerpt = ?"); args.push(excerpt); }
      if (author !== undefined) { updates.push("author = ?"); args.push(author); }
      if (tags !== undefined) { updates.push("tags = ?"); args.push(tags); }
      if (cover_image_key !== undefined) { updates.push("cover_image_key = ?"); args.push(cover_image_key); }
      if (visibility !== undefined) { updates.push("visibility = ?"); args.push(visibility); }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No changes provided." }] };
      }

      updates.push("updated_at = datetime('now')");
      args.push(id);

      await db.execute({
        sql: `UPDATE blog_posts SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });

      return { content: [{ type: "text", text: `Updated post ${id}.` }] };
    }
  );

  // --- crow_publish_post ---
  server.tool(
    "crow_publish_post",
    "Publish a blog post (sets status to published and records timestamp)",
    {
      id: z.number().describe("Post ID"),
    },
    async ({ id }) => {
      const result = await db.execute({
        sql: "UPDATE blog_posts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
      if (result.rowsAffected === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found.` }], isError: true };
      }

      const post = await db.execute({ sql: "SELECT slug, visibility FROM blog_posts WHERE id = ?", args: [id] });
      const slug = post.rows[0]?.slug;
      const vis = post.rows[0]?.visibility;
      return {
        content: [{ type: "text", text: `Published! ${vis === "public" ? `View at /blog/${slug}` : `Visibility: ${vis} (change to "public" to make it accessible at /blog/${slug})`}` }],
      };
    }
  );

  // --- crow_unpublish_post ---
  server.tool(
    "crow_unpublish_post",
    "Revert a published post to draft status",
    {
      id: z.number().describe("Post ID"),
    },
    async ({ id }) => {
      const result = await db.execute({
        sql: "UPDATE blog_posts SET status = 'draft', updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
      if (result.rowsAffected === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Post ${id} reverted to draft.` }] };
    }
  );

  // --- crow_list_posts ---
  server.tool(
    "crow_list_posts",
    "List blog posts with filtering",
    {
      status: z.enum(["draft", "published", "archived"]).optional().describe("Filter by status"),
      tag: z.string().max(200).optional().describe("Filter by tag"),
      search: z.string().max(500).optional().describe("Full-text search"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20)"),
    },
    async ({ status, tag, search, limit }) => {
      let sql, args;

      if (search) {
        const safeQuery = sanitizeFtsQuery(search);
        if (!safeQuery) {
          return { content: [{ type: "text", text: "Invalid search query." }], isError: true };
        }
        sql = `SELECT p.id, p.slug, p.title, p.status, p.visibility, p.tags, p.published_at, p.created_at
               FROM blog_posts p JOIN blog_posts_fts fts ON p.id = fts.rowid
               WHERE fts.blog_posts_fts MATCH ?`;
        args = [safeQuery];
        if (status) { sql += " AND p.status = ?"; args.push(status); }
      } else {
        sql = "SELECT id, slug, title, status, visibility, tags, published_at, created_at FROM blog_posts WHERE 1=1";
        args = [];
        if (status) { sql += " AND status = ?"; args.push(status); }
      }

      if (tag) {
        const escaped = escapeLikePattern(tag);
        sql += " AND tags LIKE ? ESCAPE '\\'";
        args.push(`%${escaped}%`);
      }

      sql += " ORDER BY created_at DESC LIMIT ?";
      args.push(limit || 20);

      const result = await db.execute({ sql, args });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No posts found." }] };
      }

      const lines = result.rows.map((r) => {
        const statusIcon = r.status === "published" ? "[published]" : `[${r.status}]`;
        const vis = r.visibility !== "private" ? ` (${r.visibility})` : "";
        const date = r.published_at || r.created_at;
        return `- #${r.id} ${statusIcon}${vis} ${r.title}\n  /${r.slug} | ${r.tags || "no tags"} | ${date}`;
      });

      return { content: [{ type: "text", text: `${result.rows.length} post(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // --- crow_get_post ---
  server.tool(
    "crow_get_post",
    "Get full blog post by ID or slug",
    {
      id: z.number().optional().describe("Post ID"),
      slug: z.string().max(100).optional().describe("Post slug"),
    },
    async ({ id, slug }) => {
      if (!id && !slug) {
        return { content: [{ type: "text", text: "Provide either id or slug." }], isError: true };
      }

      const result = await db.execute({
        sql: id ? "SELECT * FROM blog_posts WHERE id = ?" : "SELECT * FROM blog_posts WHERE slug = ?",
        args: [id || slug],
      });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "Post not found." }], isError: true };
      }

      const p = result.rows[0];
      return {
        content: [{
          type: "text",
          text: `# ${p.title}\n\nID: ${p.id} | Slug: ${p.slug} | Status: ${p.status} | Visibility: ${p.visibility}\nAuthor: ${p.author || "unset"} | Tags: ${p.tags || "none"}\nCreated: ${p.created_at} | Published: ${p.published_at || "not yet"}\n\n---\n\n${p.content}`,
        }],
      };
    }
  );

  // --- crow_delete_post ---
  server.tool(
    "crow_delete_post",
    "Delete a blog post",
    {
      id: z.number().describe("Post ID"),
    },
    async ({ id }) => {
      const result = await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [id] });
      if (result.rowsAffected === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Deleted post ${id}.` }] };
    }
  );

  // --- crow_share_post ---
  server.tool(
    "crow_share_post",
    "Share a blog post with a Crow peer via P2P",
    {
      id: z.number().describe("Post ID to share"),
      contact: z.string().max(200).describe("Crow ID or display name of recipient"),
    },
    async ({ id, contact }) => {
      const post = await db.execute({ sql: "SELECT id, title FROM blog_posts WHERE id = ?", args: [id] });
      if (post.rows.length === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found.` }], isError: true };
      }

      // Look up contact
      const contactResult = await db.execute({
        sql: "SELECT id FROM contacts WHERE crow_id = ? OR display_name = ?",
        args: [contact, contact],
      });
      if (contactResult.rows.length === 0) {
        return { content: [{ type: "text", text: `Contact "${contact}" not found.` }], isError: true };
      }

      const contactId = contactResult.rows[0].id;
      await db.execute({
        sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
              VALUES (?, 'blog_post', ?, 'read', 'sent', 'pending')`,
        args: [contactId, id],
      });

      return {
        content: [{ type: "text", text: `Shared "${post.rows[0].title}" with ${contact}. Delivery: pending.` }],
      };
    }
  );

  // --- crow_export_blog ---
  server.tool(
    "crow_export_blog",
    "Export published posts as Hugo or Jekyll-compatible markdown files",
    {
      format: z.enum(["hugo", "jekyll"]).optional().describe("Export format (default: hugo)"),
    },
    async ({ format }) => {
      const fmt = format || "hugo";
      const posts = await db.execute({
        sql: "SELECT * FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC",
        args: [],
      });

      if (posts.rows.length === 0) {
        return { content: [{ type: "text", text: "No published posts to export." }] };
      }

      const files = posts.rows.map((p) => {
        const date = (p.published_at || p.created_at).split(" ")[0];
        const tags = (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);

        let frontmatter;
        if (fmt === "hugo") {
          frontmatter = `---\ntitle: "${p.title}"\ndate: ${p.published_at || p.created_at}\nslug: "${p.slug}"\ntags: [${tags.map(t => `"${t}"`).join(", ")}]\nauthor: "${p.author || ""}"\ndraft: false\n---\n\n`;
        } else {
          frontmatter = `---\nlayout: post\ntitle: "${p.title}"\ndate: ${p.published_at || p.created_at}\ntags: [${tags.map(t => `"${t}"`).join(", ")}]\nauthor: "${p.author || ""}"\n---\n\n`;
        }

        const filename = fmt === "jekyll" ? `${date}-${p.slug}.md` : `${p.slug}.md`;
        const dir = fmt === "hugo" ? "content/posts/" : "_posts/";

        return `### ${dir}${filename}\n\`\`\`markdown\n${frontmatter}${p.content}\n\`\`\``;
      });

      return {
        content: [{
          type: "text",
          text: `Exported ${posts.rows.length} post(s) for ${fmt}:\n\n${files.join("\n\n")}`,
        }],
      };
    }
  );

  // --- crow_blog_settings ---
  server.tool(
    "crow_blog_settings",
    "Get or update blog settings (title, tagline, author, theme)",
    {
      action: z.enum(["get", "set"]).describe("Get or set settings"),
      title: z.string().max(200).optional().describe("Blog title"),
      tagline: z.string().max(500).optional().describe("Blog tagline/description"),
      author: z.string().max(200).optional().describe("Default author name"),
      theme: z.enum(["dark", "light", "serif"]).optional().describe("Blog theme"),
    },
    async ({ action, title, tagline, author, theme }) => {
      if (action === "get") {
        const result = await db.execute({
          sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
          args: [],
        });
        const settings = {};
        for (const r of result.rows) {
          settings[r.key.replace("blog_", "")] = r.value;
        }
        return {
          content: [{
            type: "text",
            text: `Blog Settings:\n  Title: ${settings.title || "Crow Blog"}\n  Tagline: ${settings.tagline || ""}\n  Author: ${settings.author || ""}\n  Theme: ${settings.theme || "dark"}`,
          }],
        };
      }

      const updates = [];
      if (title !== undefined) updates.push(["blog_title", title]);
      if (tagline !== undefined) updates.push(["blog_tagline", tagline]);
      if (author !== undefined) updates.push(["blog_author", author]);
      if (theme !== undefined) updates.push(["blog_theme", theme]);

      for (const [key, value] of updates) {
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [key, value, value],
        });
      }

      return { content: [{ type: "text", text: `Updated ${updates.length} blog setting(s).` }] };
    }
  );

  // --- crow_blog_customize_theme ---
  server.tool(
    "crow_blog_customize_theme",
    "Apply custom CSS overrides to the blog theme",
    {
      css: z.string().max(10000).describe("Custom CSS to apply as overrides"),
    },
    async ({ css }) => {
      await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('blog_custom_css', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
        args: [css, css],
      });
      return { content: [{ type: "text", text: `Custom CSS saved (${css.length} chars). Changes are live immediately.` }] };
    }
  );

  // --- crow_blog_stats ---
  server.tool(
    "crow_blog_stats",
    "Get blog statistics",
    {},
    async () => {
      const total = await db.execute("SELECT COUNT(*) as c FROM blog_posts");
      const published = await db.execute("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'published'");
      const drafts = await db.execute("SELECT COUNT(*) as c FROM blog_posts WHERE status = 'draft'");

      const tags = await db.execute("SELECT tags FROM blog_posts WHERE tags IS NOT NULL AND tags != ''");
      const tagCounts = {};
      for (const row of tags.rows) {
        for (const tag of row.tags.split(",").map((t) => t.trim()).filter(Boolean)) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
      const topTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag, count]) => `${tag} (${count})`)
        .join(", ");

      return {
        content: [{
          type: "text",
          text: `Blog Statistics:\n  Total posts: ${total.rows[0].c}\n  Published: ${published.rows[0].c}\n  Drafts: ${drafts.rows[0].c}\n  Top tags: ${topTags || "none"}`,
        }],
      };
    }
  );

  return server;
}
