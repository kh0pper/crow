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
import { createHash, randomBytes } from "node:crypto";
import { createDbClient, sanitizeFtsQuery, escapeLikePattern } from "../db.js";
import { generateSlug, generateExcerpt } from "./renderer.js";
import { generateToken, peekToken, validateToken, shouldSkipGates } from "../shared/confirm.js";
import { createNotification } from "../shared/notifications.js";
import { parseChordPro, transposeAst, renderChordProHtml, extractChords, isChordPro, parseSongMeta } from "./chordpro.js";
import { getChordDiagram } from "./chord-diagrams.js";
import { actorFromEnv } from "../research/actor.js";
import { guardBlogServer, draftOnlyEditRefusal, draftOnlyCoverRefusal } from "./bot-owner-only.js";

/**
 * The fixed refusal a confirmation gets when the row is not in the state the preview showed — the
 * post was edited (by a bot, or anyone) between the preview and the confirm. Nothing is published or
 * deleted: the operator's confirmation is for what they were shown, not for whatever is there now.
 * One text for both confirms, asking for a fresh preview rather than saying what changed.
 */
export const STALE_PREVIEW_REFUSAL =
  "The post changed since that preview, so nothing was done. Pass confirm_token: \"\" to get a fresh preview.";

export function createBlogServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-blog", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const db = createDbClient(dbPath);

  // Who is calling, exactly as the projects, memory, storage and sharing servers resolve it: the
  // construction-time base actor (a stdio server's process env, or the actor the gateway built the
  // server with) is fixed here, and each call may only narrow it.
  const baseActor = options.baseActor || actorFromEnv(process.env);
  // Read by tests (and the callers that build this server): who is calling.
  server.blog = { actor: baseActor };

  // A bot may reach four of these tools — create, edit, list and get — but only ever on DRAFTS
  // (servers/blog/bot-owner-only.js, class `bot_draft`). The wrapper is installed on `server.tool`
  // BEFORE the registrations below, so each handler checks the call's actor first, a bot never
  // reaches an owner-only tool, and a draft-only call is told so by the guard's third argument (a
  // frozen per-call context, never a field the model can send). It does not move a registration, so
  // the order below stays the contract it is.
  guardBlogServer(server, { baseActor, onCallActor: options.onCallActor });

  /**
   * Is this call from a bot held to the draft-only rule? The guard resolves the actor and passes
   * this per-call context (never the call's own arguments); a handler that ignores it is unaffected.
   */
  const draftOnly = (call) => !!(call && call.draftOnly);

  /**
   * Ensure slug is unique.
   *
   * The owner's form appends -2, -3, etc. A draft-only bot gets a random 6-hex-character suffix once
   * the base slug is taken instead: `-2` answers "is this slug already in use?" for the whole
   * shared slug space (drafts, published, archived — `blog_posts.slug` is UNIQUE across all of
   * them), so it would hand a bot a lookup oracle on slugs it may not read. A random suffix keeps
   * the slug unique and says nothing. A free slug is used as-is, exactly as before.
   */
  async function uniqueSlug(slug, excludeId, { randomSuffix = false } = {}) {
    const taken = async (candidate) => (await db.execute({
      sql: excludeId
        ? "SELECT id FROM blog_posts WHERE slug = ? AND id != ?"
        : "SELECT id FROM blog_posts WHERE slug = ?",
      args: excludeId ? [candidate, excludeId] : [candidate],
    })).rows.length > 0;

    if (!(await taken(slug))) return slug;

    if (randomSuffix) {
      // Retried on a collision so the answer is always a free slug, never a guessable walk.
      for (;;) {
        const candidate = `${slug}-${randomBytes(3).toString("hex")}`;
        if (!(await taken(candidate))) return candidate;
      }
    }

    let candidate = slug;
    let suffix = 2;
    while (true) {
      candidate = `${slug}-${suffix++}`;
      if (!(await taken(candidate))) return candidate;
    }
  }

  /**
   * The row state a confirmation token commits to (never shown to anyone, never stored anywhere but
   * in the token itself): a sha256 over the fields the preview shows or that decide where the post
   * goes — title, content, slug, visibility, cover_image_key — plus `updated_at`.
   *
   * A token bound to the post id alone is answerable: a bot may rewrite a draft between the
   * operator's preview and their confirm, and the operator would then publish (or delete) something
   * they never saw. With this in the token, that edit changes the hash, the confirm does not match,
   * and the confirm is refused rather than acted on.
   */
  function postState(post) {
    const sha = createHash("sha256");
    for (const field of [post.title, post.content, post.slug, post.visibility, post.cover_image_key, post.updated_at]) {
      sha.update(`${field ?? ""}\u0000`);
    }
    return sha.digest("hex");
  }

  /**
   * Was this token minted against a DIFFERENT state of this row than the one now on disk?
   *
   * `validateToken` answers only "no", and "the row changed" deserves its own fixed answer. The
   * token is peeked here (read, not consumed) and the `validateToken` call that follows still
   * consumes it, so a token stays single-use whichever way the confirm goes.
   */
  function confirmIsStale(confirm_token, action, id, state) {
    const pinned = peekToken(confirm_token);
    return !!pinned
      && pinned.action === action
      && pinned.itemId === String(id)
      && pinned.fingerprint !== state;
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
    async ({ title, content, slug, excerpt, author, tags, cover_image_key, visibility }, _extra, call) => {
      const botDraft = draftOnly(call);
      // A draft-only bot may not set a cover image at all: the key names a private storage object,
      // and publishing the post would serve it publicly at /blog/media/<key>. Decided from the
      // call's own argument before anything is read or written, so nothing changes and the answer
      // says nothing about any row.
      if (botDraft && cover_image_key !== undefined) return draftOnlyCoverRefusal();

      const baseSlug = slug || generateSlug(title);
      // A bot's collision gets a random suffix (the readable `-2` would be a slug oracle); a slug no
      // post holds is used exactly as asked, for a bot and the owner alike.
      const finalSlug = await uniqueSlug(baseSlug, undefined, { randomSuffix: botDraft });
      const finalExcerpt = excerpt || generateExcerpt(content);

      // Author fallback: explicit param > blog_author setting > null
      let finalAuthor = author || null;
      if (!finalAuthor) {
        const authorSetting = await db.execute({
          sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_author'",
          args: [],
        });
        if (authorSetting.rows.length > 0 && authorSetting.rows[0].value) {
          finalAuthor = authorSetting.rows[0].value;
        }
      }

      // A draft-only bot's post is ALWAYS a draft: the status is written explicitly (rather than
      // left to the column default) and then read back, so a later default change, or a change
      // here, cannot put a bot's words on the public site. Visibility is still recorded — it only
      // means anything at publish time, and a bot cannot publish.
      const insertSql = botDraft
        ? `INSERT INTO blog_posts (slug, title, content, excerpt, author, tags, cover_image_key, visibility, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
        : `INSERT INTO blog_posts (slug, title, content, excerpt, author, tags, cover_image_key, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      const result = await db.execute({
        sql: insertSql,
        args: [finalSlug, title, content, finalExcerpt, finalAuthor, tags || null, cover_image_key || null, visibility || "private"],
      });

      if (botDraft) {
        const written = await db.execute({
          sql: "SELECT status FROM blog_posts WHERE id = ?",
          args: [result.lastInsertRowid],
        });
        if (written.rows[0]?.status !== "draft") {
          // Never expected: the INSERT above pins the status. Refusing loudly beats leaving a live
          // post behind that this tool promised would be a draft.
          throw new Error("blog: a bot's new post is not a draft");
        }
      }

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
    async ({ id, title, content, slug, excerpt, author, tags, cover_image_key, visibility }, _extra, call) => {
      const botDraft = draftOnly(call);
      // A draft-only bot cannot set a cover image on any post: the key is a private storage object
      // that publishing would put on /blog/media/. Refused on the argument alone, before the row is
      // read, so nothing changes and a live id answers exactly like a draft one.
      if (botDraft && cover_image_key !== undefined) return draftOnlyCoverRefusal();

      const existing = await db.execute({ sql: "SELECT * FROM blog_posts WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        // A draft-only bot gets the one draft refusal here too: a missing id and a post it may not
        // touch must read the same, so neither reveals that a row exists.
        if (botDraft) return draftOnlyEditRefusal();
        return { content: [{ type: "text", text: `Post ${id} not found. Use crow_list_posts to see available posts.` }], isError: true };
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
        // Same rule as crow_create_post: a bot's taken slug gets a random suffix, never `-2`, so the
        // shared slug space cannot be probed through this tool either.
        const finalSlug = await uniqueSlug(slug, id, { randomSuffix: botDraft });
        updates.push("slug = ?");
        args.push(finalSlug);
      }
      if (excerpt !== undefined) { updates.push("excerpt = ?"); args.push(excerpt); }
      if (author !== undefined) { updates.push("author = ?"); args.push(author); }
      if (tags !== undefined) { updates.push("tags = ?"); args.push(tags); }
      if (cover_image_key !== undefined) { updates.push("cover_image_key = ?"); args.push(cover_image_key); }
      if (visibility !== undefined) { updates.push("visibility = ?"); args.push(visibility); }

      if (updates.length === 0) {
        // Nothing to write — but for a draft-only bot the draft rule is still applied, so "no changes
        // provided" is never an oracle telling it that a live post with that id exists.
        if (botDraft && existing.rows[0].status !== "draft") return draftOnlyEditRefusal();
        return { content: [{ type: "text", text: "No changes provided. Pass at least one field to update (title, content, tags, slug, excerpt, author, visibility, cover_image_key)." }] };
      }

      updates.push("updated_at = datetime('now')");
      args.push(id);

      // crow_edit_post has no status field at all (see the schema above), so no argument can change
      // a post's status here. For a draft-only bot the draft rule is enforced by the UPDATE itself
      // — `AND status = 'draft'` — never by a check followed by a write: a post that goes live
      // between the two stays untouched. A non-draft row and a missing id both change nothing and
      // get the same one refusal.
      const result = await db.execute({
        sql: botDraft
          ? `UPDATE blog_posts SET ${updates.join(", ")} WHERE id = ? AND status = 'draft'`
          : `UPDATE blog_posts SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });
      if (botDraft && result.rowsAffected === 0) return draftOnlyEditRefusal();

      const changedFields = [];
      if (title !== undefined) changedFields.push("title");
      if (content !== undefined) changedFields.push("content");
      if (slug !== undefined) changedFields.push("slug");
      if (excerpt !== undefined) changedFields.push("excerpt");
      if (author !== undefined) changedFields.push("author");
      if (tags !== undefined) changedFields.push("tags");
      if (cover_image_key !== undefined) changedFields.push("cover_image_key");
      if (visibility !== undefined) changedFields.push("visibility");

      return { content: [{ type: "text", text: `Updated post ${id}: ${changedFields.join(", ")}.` }] };
    }
  );

  // --- crow_publish_post ---
  server.tool(
    "crow_publish_post",
    "Publish a blog post (sets status to published and records timestamp). Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      id: z.number().describe("Post ID"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ id, confirm_token }) => {
      const existing = await db.execute({ sql: "SELECT * FROM blog_posts WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found. Use crow_list_posts to see available posts.` }], isError: true };
      }
      const post = existing.rows[0];
      // What this preview shows, and what the token commits to. A post edited between the preview
      // and the confirm hashes differently, so the confirm is refused (STALE_PREVIEW_REFUSAL) rather
      // than publishing text the operator never saw.
      const state = postState(post);

      if (!shouldSkipGates()) {
        if (confirm_token) {
          const stale = confirmIsStale(confirm_token, "publish_post", id, state);
          if (!validateToken(confirm_token, "publish_post", id, state)) {
            if (stale) return { content: [{ type: "text", text: STALE_PREVIEW_REFUSAL }], isError: true };
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          const token = generateToken("publish_post", id, state);
          // A cover image is part of what the operator is agreeing to: publishing makes
          // /blog/media/<key> public, so the key is shown in the preview, not left to be discovered.
          const coverLine = post.cover_image_key ? `\n  Cover image: ${post.cover_image_key}` : "";
          return {
            content: [{
              type: "text",
              text: `⚠️ This will publish:\n  Post #${post.id}: "${post.title}" (${post.visibility})${coverLine}\n\nThis will make the post ${post.visibility === "public" ? `publicly accessible at /blog/${post.slug}` : `visible to ${post.visibility} audience`}.\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      await db.execute({
        sql: "UPDATE blog_posts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });

      try {
        await createNotification(db, {
          title: `Published: ${post.title}`,
          type: "media",
          source: "blog",
          action_url: `/blog/${post.slug}`,
        });
      } catch {}

      return {
        content: [{ type: "text", text: `Published! ${post.visibility === "public" ? `View at /blog/${post.slug}` : `Visibility: ${post.visibility} (change to "public" to make it accessible at /blog/${post.slug})`}` }],
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
        return { content: [{ type: "text", text: `Post ${id} not found. Use crow_list_posts to see available posts.` }], isError: true };
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
    async ({ status, tag, search, limit }, _extra, call) => {
      // A draft-only bot sees drafts and nothing else: the status filter is forced, whatever the
      // call asked for, on the plain path and on the tag/FTS join path alike.
      const filterStatus = draftOnly(call) ? "draft" : status;
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
        if (filterStatus) { sql += " AND p.status = ?"; args.push(filterStatus); }
      } else {
        sql = "SELECT id, slug, title, status, visibility, tags, published_at, created_at FROM blog_posts WHERE 1=1";
        args = [];
        if (filterStatus) { sql += " AND status = ?"; args.push(filterStatus); }
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
    async ({ id, slug }, _extra, call) => {
      if (!id && !slug) {
        return { content: [{ type: "text", text: "Provide either id or slug." }], isError: true };
      }

      // A draft-only bot reads a draft and nothing else. The predicate is in the query, so a
      // published post (or a published-private one) falls through to the very same "not found" an
      // unknown id or slug gets — nothing here reveals that the post exists.
      const result = await db.execute({
        sql: `${id ? "SELECT * FROM blog_posts WHERE id = ?" : "SELECT * FROM blog_posts WHERE slug = ?"}`
          + (draftOnly(call) ? " AND status = 'draft'" : ""),
        args: [id || slug],
      });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: `Post not found. Use crow_list_posts to see available posts.` }], isError: true };
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
    "Permanently delete a blog post. This cannot be undone — use crow_unpublish_post to revert to draft instead. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      id: z.number().describe("Post ID"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ id, confirm_token }) => {
      const existing = await db.execute({ sql: "SELECT * FROM blog_posts WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found. Use crow_list_posts to see available posts.` }], isError: true };
      }
      const post = existing.rows[0];
      // Same state binding as crow_publish_post: deleting a post a bot rewrote between the preview
      // and the confirm would be the operator confirming something they never saw.
      const state = postState(post);

      if (!shouldSkipGates()) {
        if (confirm_token) {
          const stale = confirmIsStale(confirm_token, "delete_post", id, state);
          if (!validateToken(confirm_token, "delete_post", id, state)) {
            if (stale) return { content: [{ type: "text", text: STALE_PREVIEW_REFUSAL }], isError: true };
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          const token = generateToken("delete_post", id, state);
          return {
            content: [{
              type: "text",
              text: `⚠️ This will permanently delete:\n  Post #${post.id}: "${post.title}" (${post.status}, ${post.visibility})\n\nThis cannot be undone. Use crow_unpublish_post to revert to draft instead.\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [id] });
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
        return { content: [{ type: "text", text: `Post ${id} not found. Use crow_list_posts to see available posts.` }], isError: true };
      }

      // Look up contact
      const contactResult = await db.execute({
        sql: "SELECT id FROM contacts WHERE crow_id = ? OR display_name = ?",
        args: [contact, contact],
      });
      if (contactResult.rows.length === 0) {
        return { content: [{ type: "text", text: `Contact "${contact}" not found. Use crow_list_contacts to see available peers.` }], isError: true };
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

      // Look up default author for posts without an explicit author
      let defaultAuthor = "";
      const authorSetting = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_author'",
        args: [],
      });
      if (authorSetting.rows.length > 0 && authorSetting.rows[0].value) {
        defaultAuthor = authorSetting.rows[0].value;
      }

      const files = posts.rows.map((p) => {
        const date = (p.published_at || p.created_at).split(" ")[0];
        const tags = (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
        const exportAuthor = p.author || defaultAuthor;

        let frontmatter;
        if (fmt === "hugo") {
          frontmatter = `---\ntitle: "${p.title}"\ndate: ${p.published_at || p.created_at}\nslug: "${p.slug}"\ntags: [${tags.map(t => `"${t}"`).join(", ")}]\nauthor: "${exportAuthor}"\ndraft: false\n---\n\n`;
        } else {
          frontmatter = `---\nlayout: post\ntitle: "${p.title}"\ndate: ${p.published_at || p.created_at}\ntags: [${tags.map(t => `"${t}"`).join(", ")}]\nauthor: "${exportAuthor}"\n---\n\n`;
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
    "Get or update blog settings (title, tagline, author, theme, podcast config)",
    {
      action: z.enum(["get", "set"]).describe("Get or set settings"),
      title: z.string().max(200).optional().describe("Blog title"),
      tagline: z.string().max(500).optional().describe("Blog tagline/description"),
      author: z.string().max(200).optional().describe("Default author name"),
      theme: z.enum(["dark", "light", "serif"]).optional().describe("Blog theme (deprecated — use theme_mode/theme_serif instead)"),
      theme_mode: z.enum(["dark", "light"]).optional().describe("Global color mode"),
      theme_serif: z.boolean().optional().describe("Enable serif headings (Fraunces font)"),
      theme_blog_mode: z.enum(["dark", "light", ""]).optional().describe("Blog color mode override (empty = use global)"),
      podcast_category: z.string().max(200).optional().describe("iTunes category (e.g. 'Technology', 'Society & Culture > Philosophy')"),
      podcast_type: z.enum(["episodic", "serial"]).optional().describe("iTunes show type: episodic (newest first) or serial (oldest first)"),
      podcast_owner_email: z.string().max(200).optional().describe("Podcast owner email (required by Apple Podcasts)"),
      podcast_cover_url: z.string().max(1000).optional().describe("Podcast cover image URL (1400x1400 to 3000x3000 JPEG/PNG)"),
      podcast_language: z.string().max(10).optional().describe("Podcast language code (e.g. 'en', 'es', 'fr')"),
      songbook_on_index: z.boolean().optional().describe("Show songbook posts on the main blog index (default: true)"),
    },
    async ({ action, title, tagline, author, theme, theme_mode, theme_serif, theme_blog_mode, podcast_category, podcast_type, podcast_owner_email, podcast_cover_url, podcast_language, songbook_on_index }) => {
      if (action === "get") {
        const result = await db.execute({
          sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
          args: [],
        });
        const settings = {};
        for (const r of result.rows) {
          settings[r.key.replace("blog_", "")] = r.value;
        }
        const effectiveMode = settings.theme_mode || "dark";
        const serif = settings.theme_serif !== "false";
        let text = `Blog Settings:\n  Title: ${settings.title || "Crow Blog"}\n  Tagline: ${settings.tagline || ""}\n  Author: ${settings.author || ""}\n  Songbook on index: ${settings.songbook_on_index !== "false" ? "yes" : "no"}`;
        text += `\n\nTheme:\n  Mode: ${effectiveMode}\n  Serif: ${serif ? "on" : "off"}`;
        if (settings.theme_blog_mode) text += `\n  Blog override: ${settings.theme_blog_mode}`;
        if (settings.podcast_category || settings.podcast_type || settings.podcast_owner_email || settings.podcast_cover_url || settings.podcast_language) {
          text += `\n\nPodcast Settings:\n  Category: ${settings.podcast_category || "Society & Culture"}\n  Type: ${settings.podcast_type || "episodic"}\n  Owner Email: ${settings.podcast_owner_email || "(not set)"}\n  Cover Image: ${settings.podcast_cover_url || "(not set)"}\n  Language: ${settings.podcast_language || "en"}`;
        }
        return { content: [{ type: "text", text }] };
      }

      const updates = [];
      if (title !== undefined) updates.push(["blog_title", title]);
      if (tagline !== undefined) updates.push(["blog_tagline", tagline]);
      if (author !== undefined) updates.push(["blog_author", author]);

      // Handle deprecated `theme` param as alias
      if (theme !== undefined) {
        if (theme === "light") {
          updates.push(["blog_theme_mode", "light"]);
        } else if (theme === "dark") {
          updates.push(["blog_theme_mode", "dark"]);
        } else if (theme === "serif") {
          updates.push(["blog_theme_serif", "true"]);
        }
      }

      // New theme params
      if (theme_mode !== undefined) updates.push(["blog_theme_mode", theme_mode]);
      if (theme_serif !== undefined) updates.push(["blog_theme_serif", String(theme_serif)]);
      if (theme_blog_mode !== undefined) updates.push(["blog_theme_blog_mode", theme_blog_mode]);

      if (podcast_category !== undefined) updates.push(["blog_podcast_category", podcast_category]);
      if (podcast_type !== undefined) updates.push(["blog_podcast_type", podcast_type]);
      if (podcast_owner_email !== undefined) updates.push(["blog_podcast_owner_email", podcast_owner_email]);
      if (podcast_cover_url !== undefined) updates.push(["blog_podcast_cover_url", podcast_cover_url]);
      if (podcast_language !== undefined) updates.push(["blog_podcast_language", podcast_language]);
      if (songbook_on_index !== undefined) updates.push(["blog_songbook_on_index", String(songbook_on_index)]);

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

  // --- Songbook Tools ---

  // --- crow_create_song ---
  server.tool(
    "crow_create_song",
    "Create a song in the songbook (stored as a blog post tagged 'songbook' with ChordPro content)",
    {
      title: z.string().max(500).describe("Song title"),
      content: z.string().max(50000).describe("ChordPro content (metadata block + chord chart)"),
      key: z.string().max(10).optional().describe("Musical key (e.g. Am, D, Bb)"),
      artist: z.string().max(200).optional().describe("Artist/composer name"),
      tags: z.string().max(500).optional().describe("Additional comma-separated tags (songbook is auto-added)"),
      audio_key: z.string().max(500).optional().describe("S3 key for audio file"),
      sunvox_key: z.string().max(500).optional().describe("S3 key for a SunVox project file (.sunvox/.xm/.mod) — renders an interactive practice player on the song page"),
      visibility: z.enum(["private", "public", "peers"]).optional().describe("Visibility (default: private)"),
    },
    async ({ title, content, key, artist, tags, audio_key, sunvox_key, visibility }) => {
      // Validate ChordPro content
      if (!isChordPro(content)) {
        return { content: [{ type: "text", text: "Content does not appear to be in ChordPro format. Include [Chord]lyric notation or ChordPro directives ({title:}, {key:}, {sov}/{eov}, etc.)." }], isError: true };
      }

      // Build tag string ensuring "songbook" is included
      const tagList = new Set((tags || "").split(",").map((t) => t.trim()).filter(Boolean));
      tagList.add("songbook");
      const finalTags = [...tagList].join(",");

      const baseSlug = generateSlug(title);
      const finalSlug = await uniqueSlug(baseSlug);
      const finalExcerpt = generateExcerpt(content);

      // Author fallback
      let finalAuthor = artist || null;
      if (!finalAuthor) {
        const authorSetting = await db.execute({
          sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_author'",
          args: [],
        });
        if (authorSetting.rows.length > 0 && authorSetting.rows[0].value) {
          finalAuthor = authorSetting.rows[0].value;
        }
      }

      // Build metadata header if key/artist provided but not in content
      let finalContent = content;
      if (key && !content.match(/\*\*Key:\*\*/i)) {
        finalContent = `**Key:** ${key}\n` + finalContent;
      }
      if (artist && !content.match(/\*\*Artist:\*\*/i)) {
        finalContent = `**Artist:** ${artist}\n` + finalContent;
      }
      if (audio_key && !content.match(/\*\*Audio:\*\*/i)) {
        finalContent = `**Audio:** storage:${String(audio_key).replace(/[\r\n]+/g, "")}\n` + finalContent;
      }
      if (sunvox_key && !content.match(/\*\*SunVox:\*\*/i)) {
        finalContent = `**SunVox:** storage:${String(sunvox_key).replace(/[\r\n]+/g, "")}\n` + finalContent;
      }

      const result = await db.execute({
        sql: `INSERT INTO blog_posts (slug, title, content, excerpt, author, tags, cover_image_key, visibility)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [finalSlug, title, finalContent, finalExcerpt, finalAuthor, finalTags, null, visibility || "private"],
      });

      return {
        content: [{
          type: "text",
          text: `Created song: "${title}"\nID: ${result.lastInsertRowid}\nSlug: ${finalSlug}\nKey: ${key || "(not set)"}\nTags: ${finalTags}\n\nView at /blog/songbook/${finalSlug}\nUse crow_publish_post to make it live.`,
        }],
      };
    }
  );

  // --- crow_transpose_song ---
  server.tool(
    "crow_transpose_song",
    "Transpose a song to a different key (non-destructive — returns transposed content without modifying the post)",
    {
      id: z.number().describe("Post ID of the song"),
      target_key: z.string().max(10).describe("Target key (e.g. C, Am, Bb, F#m)"),
    },
    async ({ id, target_key }) => {
      const result = await db.execute({ sql: "SELECT * FROM blog_posts WHERE id = ?", args: [id] });
      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: `Post ${id} not found.` }], isError: true };
      }
      const post = result.rows[0];
      if (!isChordPro(post.content)) {
        return { content: [{ type: "text", text: `Post ${id} is not a ChordPro song.` }], isError: true };
      }

      const ast = parseChordPro(post.content);
      const songMeta = parseSongMeta(post.content);
      if (!ast.meta.key && songMeta.key) {
        ast.meta.key = songMeta.key;
      }
      if (!ast.meta.key) {
        return { content: [{ type: "text", text: "No key found in song metadata. Add {key: X} directive or **Key:** X header." }], isError: true };
      }

      const transposed = transposeAst(ast, target_key);

      // Reconstruct ChordPro text from transposed AST (readable, saveable)
      const lines = [];
      if (transposed.meta.title) lines.push(`{title: ${transposed.meta.title}}`);
      if (transposed.meta.key) lines.push(`{key: ${transposed.meta.key}}`);
      if (transposed.meta.tempo) lines.push(`{tempo: ${transposed.meta.tempo}}`);
      if (transposed.meta.time) lines.push(`{time: ${transposed.meta.time}}`);
      if (transposed.meta.capo) lines.push(`{capo: ${transposed.meta.capo}}`);
      lines.push("");

      for (const section of transposed.sections) {
        if (section.type === "comment") {
          lines.push(`{comment: ${section.label}}`);
          continue;
        }
        const sectionType = section.type;
        if (section.label) {
          lines.push(`{start_of_${sectionType}: ${section.label}}`);
        } else {
          lines.push(`{start_of_${sectionType}}`);
        }
        for (const line of section.lines) {
          if (line.type === "empty") { lines.push(""); continue; }
          if (line.type === "comment") { lines.push(`{comment: ${line.text}}`); continue; }
          if (line.type !== "lyric") continue;
          let text = "";
          for (const seg of line.segments) {
            if (seg.chord) text += `[${seg.chord}]`;
            text += seg.lyric || "";
          }
          lines.push(text);
        }
        lines.push(`{end_of_${sectionType}}`);
        lines.push("");
      }

      const chordProText = lines.join("\n").trimEnd();

      return {
        content: [{
          type: "text",
          text: `"${post.title}" transposed from ${ast.meta.key} to ${target_key}:\n\n${chordProText}`,
        }],
      };
    }
  );

  // --- crow_list_songs ---
  server.tool(
    "crow_list_songs",
    "List songs in the songbook",
    {
      search: z.string().max(500).optional().describe("Full-text search"),
      key: z.string().max(10).optional().describe("Filter by musical key"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20)"),
    },
    async ({ search, key, limit }) => {
      let sql, args;

      if (search) {
        const safeQuery = sanitizeFtsQuery(search);
        if (!safeQuery) {
          return { content: [{ type: "text", text: "Invalid search query." }], isError: true };
        }
        sql = `SELECT p.id, p.slug, p.title, p.status, p.visibility, p.tags, p.content, p.published_at, p.created_at
               FROM blog_posts p JOIN blog_posts_fts fts ON p.id = fts.rowid
               WHERE fts.blog_posts_fts MATCH ? AND p.tags LIKE '%songbook%'`;
        args = [safeQuery];
      } else {
        sql = `SELECT id, slug, title, status, visibility, tags, content, published_at, created_at
               FROM blog_posts WHERE tags LIKE '%songbook%'`;
        args = [];
      }

      sql += " ORDER BY created_at DESC LIMIT ?";
      args.push(limit || 20);

      const result = await db.execute({ sql, args });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No songs found." }] };
      }

      const lines = result.rows.map((r) => {
        const meta = parseSongMeta(r.content);
        if (key && meta.key && meta.key.toLowerCase() !== key.toLowerCase()) return null;
        const statusIcon = r.status === "published" ? "[published]" : `[${r.status}]`;
        return `- #${r.id} ${statusIcon} ${r.title}${meta.artist ? ` — ${meta.artist}` : ""}\n  Key: ${meta.key || "?"} | /${r.slug} | ${r.published_at || r.created_at}`;
      }).filter(Boolean);

      if (lines.length === 0) {
        return { content: [{ type: "text", text: key ? `No songs found in key ${key}.` : "No songs found." }] };
      }

      return { content: [{ type: "text", text: `${lines.length} song(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // --- crow_get_chord_diagram ---
  server.tool(
    "crow_get_chord_diagram",
    "Get an SVG chord diagram for a chord name",
    {
      chord: z.string().max(20).describe("Chord name (e.g. Am7, F#m7b5, Cmaj7)"),
      instrument: z.enum(["guitar", "piano"]).optional().describe("Instrument (default: guitar)"),
    },
    async ({ chord, instrument }) => {
      const result = getChordDiagram(chord, instrument || "guitar");
      if (!result || !result.svg) {
        return { content: [{ type: "text", text: `Could not generate diagram for "${chord}". Try a standard chord name.` }] };
      }
      return {
        content: [{
          type: "text",
          text: `${chord} (${instrument || "guitar"}):\n\n${result.svg}\n\nVoicing: ${JSON.stringify(result.voicing)}`,
        }],
      };
    }
  );

  // --- crow_create_setlist ---
  server.tool(
    "crow_create_setlist",
    "Create a setlist of songs",
    {
      name: z.string().max(200).describe("Setlist name"),
      description: z.string().max(1000).optional().describe("Description"),
      song_ids: z.array(z.number()).optional().describe("Song post IDs to add (in order)"),
      visibility: z.enum(["private", "public", "peers"]).optional().describe("Visibility (default: private)"),
    },
    async ({ name, description, song_ids, visibility }) => {
      const result = await db.execute({
        sql: "INSERT INTO songbook_setlists (name, description, visibility) VALUES (?, ?, ?)",
        args: [name, description || null, visibility || "private"],
      });
      const setlistId = result.lastInsertRowid;

      if (song_ids && song_ids.length > 0) {
        for (let i = 0; i < song_ids.length; i++) {
          await db.execute({
            sql: "INSERT OR IGNORE INTO songbook_setlist_items (setlist_id, post_id, position) VALUES (?, ?, ?)",
            args: [setlistId, song_ids[i], i],
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: `Created setlist: "${name}" (ID: ${setlistId})${song_ids ? ` with ${song_ids.length} song(s)` : ""}`,
        }],
      };
    }
  );

  // --- crow_add_to_setlist ---
  server.tool(
    "crow_add_to_setlist",
    "Add a song to a setlist",
    {
      setlist_id: z.number().describe("Setlist ID"),
      post_id: z.number().describe("Song post ID"),
      position: z.number().optional().describe("Position in setlist (auto-appended if omitted)"),
      key_override: z.string().max(10).optional().describe("Override key for this song in this setlist"),
      notes: z.string().max(1000).optional().describe("Performance notes"),
    },
    async ({ setlist_id, post_id, position, key_override, notes }) => {
      // Verify setlist exists
      const setlist = await db.execute({ sql: "SELECT id FROM songbook_setlists WHERE id = ?", args: [setlist_id] });
      if (setlist.rows.length === 0) {
        return { content: [{ type: "text", text: `Setlist ${setlist_id} not found.` }], isError: true };
      }

      // Auto-append position
      if (position === undefined) {
        const maxPos = await db.execute({
          sql: "SELECT MAX(position) as max_pos FROM songbook_setlist_items WHERE setlist_id = ?",
          args: [setlist_id],
        });
        position = (maxPos.rows[0]?.max_pos ?? -1) + 1;
      }

      try {
        await db.execute({
          sql: "INSERT INTO songbook_setlist_items (setlist_id, post_id, position, key_override, notes) VALUES (?, ?, ?, ?, ?)",
          args: [setlist_id, post_id, position, key_override || null, notes || null],
        });
      } catch (err) {
        if (err.message?.includes("UNIQUE")) {
          return { content: [{ type: "text", text: `Song ${post_id} is already in setlist ${setlist_id}.` }], isError: true };
        }
        throw err;
      }

      return { content: [{ type: "text", text: `Added song ${post_id} to setlist ${setlist_id} at position ${position}.` }] };
    }
  );

  // --- crow_remove_from_setlist ---
  server.tool(
    "crow_remove_from_setlist",
    "Remove a song from a setlist",
    {
      setlist_id: z.number().describe("Setlist ID"),
      post_id: z.number().describe("Song post ID"),
    },
    async ({ setlist_id, post_id }) => {
      const result = await db.execute({
        sql: "DELETE FROM songbook_setlist_items WHERE setlist_id = ? AND post_id = ?",
        args: [setlist_id, post_id],
      });
      if (result.rowsAffected === 0) {
        return { content: [{ type: "text", text: `Song ${post_id} not found in setlist ${setlist_id}.` }], isError: true };
      }
      return { content: [{ type: "text", text: `Removed song ${post_id} from setlist ${setlist_id}.` }] };
    }
  );

  // --- crow_update_setlist ---
  server.tool(
    "crow_update_setlist",
    "Update setlist metadata or reorder songs",
    {
      id: z.number().describe("Setlist ID"),
      name: z.string().max(200).optional().describe("New name"),
      description: z.string().max(1000).optional().describe("New description"),
      visibility: z.enum(["private", "public", "peers"]).optional(),
      reorder: z.string().max(5000).optional().describe("JSON array of {post_id, position, key_override?} to reorder songs"),
    },
    async ({ id, name, description, visibility, reorder }) => {
      const setlist = await db.execute({ sql: "SELECT id FROM songbook_setlists WHERE id = ?", args: [id] });
      if (setlist.rows.length === 0) {
        return { content: [{ type: "text", text: `Setlist ${id} not found.` }], isError: true };
      }

      const updates = [];
      const args = [];
      if (name !== undefined) { updates.push("name = ?"); args.push(name); }
      if (description !== undefined) { updates.push("description = ?"); args.push(description); }
      if (visibility !== undefined) { updates.push("visibility = ?"); args.push(visibility); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        args.push(id);
        await db.execute({ sql: `UPDATE songbook_setlists SET ${updates.join(", ")} WHERE id = ?`, args });
      }

      if (reorder) {
        let items;
        try { items = JSON.parse(reorder); } catch {
          return { content: [{ type: "text", text: "Invalid reorder JSON. Expected array of {post_id, position, key_override?}." }], isError: true };
        }
        for (const item of items) {
          const setClauses = ["position = ?"];
          const setArgs = [item.position];
          if (item.key_override !== undefined) {
            setClauses.push("key_override = ?");
            setArgs.push(item.key_override || null);
          }
          setArgs.push(id, item.post_id);
          await db.execute({
            sql: `UPDATE songbook_setlist_items SET ${setClauses.join(", ")} WHERE setlist_id = ? AND post_id = ?`,
            args: setArgs,
          });
        }
      }

      return { content: [{ type: "text", text: `Updated setlist ${id}.` }] };
    }
  );

  // --- crow_list_setlists ---
  server.tool(
    "crow_list_setlists",
    "List setlists",
    {
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
    },
    async ({ limit }) => {
      const result = await db.execute({
        sql: `SELECT s.*, COUNT(si.id) as song_count
              FROM songbook_setlists s
              LEFT JOIN songbook_setlist_items si ON si.setlist_id = s.id
              GROUP BY s.id
              ORDER BY s.updated_at DESC
              LIMIT ?`,
        args: [limit || 20],
      });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No setlists found." }] };
      }

      const lines = result.rows.map((r) =>
        `- #${r.id} "${r.name}" (${r.song_count} songs, ${r.visibility}) — ${r.updated_at}`
      );

      return { content: [{ type: "text", text: `${result.rows.length} setlist(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // --- crow_get_setlist ---
  server.tool(
    "crow_get_setlist",
    "Get setlist details with songs",
    {
      id: z.number().describe("Setlist ID"),
    },
    async ({ id }) => {
      const setlist = await db.execute({ sql: "SELECT * FROM songbook_setlists WHERE id = ?", args: [id] });
      if (setlist.rows.length === 0) {
        return { content: [{ type: "text", text: `Setlist ${id} not found.` }], isError: true };
      }
      const s = setlist.rows[0];

      const items = await db.execute({
        sql: `SELECT si.*, bp.title, bp.slug, bp.content
              FROM songbook_setlist_items si
              JOIN blog_posts bp ON bp.id = si.post_id
              WHERE si.setlist_id = ?
              ORDER BY si.position`,
        args: [id],
      });

      const songLines = items.rows.map((item, i) => {
        const meta = parseSongMeta(item.content);
        const keyInfo = item.key_override
          ? `${item.key_override} (from ${meta.key || "?"})`
          : (meta.key || "?");
        return `  ${i + 1}. ${item.title} — Key: ${keyInfo}${item.notes ? ` [${item.notes}]` : ""}`;
      });

      return {
        content: [{
          type: "text",
          text: `# ${s.name}\n${s.description || ""}\nVisibility: ${s.visibility} | ${items.rows.length} song(s)\n\n${songLines.join("\n")}`,
        }],
      };
    }
  );

  // --- crow_delete_setlist ---
  server.tool(
    "crow_delete_setlist",
    "Permanently delete a setlist. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      id: z.number().describe("Setlist ID"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ id, confirm_token }) => {
      const setlist = await db.execute({ sql: "SELECT * FROM songbook_setlists WHERE id = ?", args: [id] });
      if (setlist.rows.length === 0) {
        return { content: [{ type: "text", text: `Setlist ${id} not found.` }], isError: true };
      }
      const s = setlist.rows[0];

      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "delete_setlist", id)) {
            return { content: [{ type: "text", text: 'Invalid or expired confirmation token. Pass confirm_token: "" to get a new preview.' }], isError: true };
          }
        } else {
          const token = generateToken("delete_setlist", id);
          const itemCount = await db.execute({
            sql: "SELECT COUNT(*) as c FROM songbook_setlist_items WHERE setlist_id = ?",
            args: [id],
          });
          return {
            content: [{
              type: "text",
              text: `⚠️ This will permanently delete:\n  Setlist #${s.id}: "${s.name}" (${itemCount.rows[0].c} songs)\n\nThis cannot be undone. Songs themselves are not deleted.\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      await db.execute({ sql: "DELETE FROM songbook_setlists WHERE id = ?", args: [id] });
      return { content: [{ type: "text", text: `Deleted setlist ${id}.` }] };
    }
  );

  // --- Prompts ---

  server.prompt(
    "blog-guide",
    "Blog publishing workflow — creating posts, themes, RSS feeds, and export",
    async () => {
      const text = `Crow Blog Publishing Guide

1. Creating Posts
   - Use crow_create_post with title and markdown content
   - Posts start as drafts — they won't appear publicly until published
   - Slugs are auto-generated from titles (or specify a custom slug)
   - Add tags, excerpt, and cover_image_url for richer metadata

2. Editing & Publishing
   - Edit drafts with crow_edit_post (update content, title, tags, etc.)
   - Publish with crow_publish_post — makes the post visible at /blog/:slug
   - Unpublish with crow_unpublish_post to revert to draft
   - Set visibility: "public" (anyone), "unlisted" (link only), or "private"

3. Themes & Customization
   - Use crow_blog_customize_theme to set colors, fonts, and layout
   - Configure blog name, tagline, and author via crow_blog_settings
   - Themes are applied globally to all published posts

4. Feeds & Sharing
   - RSS 2.0 feed at /blog/feed.xml, Atom feed at /blog/feed.atom
   - Share individual posts with crow_share_post to get shareable URLs
   - Export entire blog with crow_export_blog (markdown or HTML format)

5. Best Practices
   - Write in Markdown — it's rendered to clean HTML automatically
   - Use tags consistently for navigation and discovery
   - Set excerpts for better feed and listing appearances
   - Preview posts before publishing by checking them as drafts`;

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  return server;
}
