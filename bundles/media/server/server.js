/**
 * Crow Media MCP Server
 *
 * Unified news + podcast hub. RSS feed aggregation, article management,
 * personalized feed, and full-text search.
 *
 * Factory function: createMediaServer(dbPath?, options?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient, sanitizeFtsQuery, escapeLikePattern } from "./db.js";
import { generateToken, validateToken, shouldSkipGates } from "./confirm.js";
import { fetchAndParseFeed, buildGoogleNewsUrl, postProcessGoogleNewsItems } from "./feed-fetcher.js";

export function createMediaServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-media", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const db = createDbClient(dbPath);

  // --- crow_media_add_source ---
  server.tool(
    "crow_media_add_source",
    "Subscribe to an RSS/Atom feed, Google News search, or YouTube channel.",
    {
      url: z.string().max(2000).optional().describe("RSS/Atom feed URL"),
      query: z.string().max(500).optional().describe("Google News search query"),
      youtube_channel: z.string().max(500).optional().describe("YouTube channel URL or ID (e.g. '@mkbhd', 'UCBcRF18a7Qf58cCRy5xuWwQ')"),
      name: z.string().max(500).optional().describe("Display name (auto-detected from feed if omitted)"),
      category: z.string().max(200).optional().describe("Category label (e.g. 'tech', 'politics')"),
      fetch_interval_min: z.number().min(5).max(1440).optional().describe("Fetch interval in minutes (default 30)"),
    },
    async ({ url, query, youtube_channel, name, category, fetch_interval_min }) => {
      // Validate: exactly one of url, query, or youtube_channel
      const provided = [url, query, youtube_channel].filter(Boolean).length;
      if (provided > 1) {
        return {
          content: [{ type: "text", text: "Provide only one of: url, query, or youtube_channel." }],
          isError: true,
        };
      }
      if (provided === 0) {
        return {
          content: [{ type: "text", text: "Provide url (RSS/Atom feed), query (Google News), or youtube_channel (YouTube channel URL/ID)." }],
          isError: true,
        };
      }

      // YouTube channel handling
      const isYouTube = !!youtube_channel;
      if (isYouTube) {
        try {
          const { extractYoutubeChannelId, buildYoutubeRssUrl } = await import("./feed-fetcher.js");
          const channelId = await extractYoutubeChannelId(youtube_channel);
          url = buildYoutubeRssUrl(channelId);
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to resolve YouTube channel: ${err.message}` }],
            isError: true,
          };
        }
      }

      // If query provided, build Google News URL
      const isGoogleNews = !!query;
      if (isGoogleNews) {
        url = buildGoogleNewsUrl(query);
      }
      // Check for duplicate
      const existing = await db.execute({
        sql: "SELECT id, name FROM media_sources WHERE url = ?",
        args: [url],
      });
      if (existing.rows.length > 0) {
        return {
          content: [{ type: "text", text: `Source already exists: "${existing.rows[0].name}" (ID: ${existing.rows[0].id})` }],
          isError: true,
        };
      }

      // Fetch and parse to validate + get metadata
      let feed, items;
      try {
        ({ feed, items } = await fetchAndParseFeed(url));
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to fetch feed: ${err.message}\nCheck the URL is a valid RSS/Atom feed.` }],
          isError: true,
        };
      }

      // Post-process Google News items
      if (isGoogleNews) {
        postProcessGoogleNewsItems(items);
      }

      const sourceName = name || (isGoogleNews ? `Google News: ${query}` : isYouTube ? feed.title || youtube_channel : feed.title) || url;
      const interval = fetch_interval_min || 30;
      const sourceType = isYouTube ? 'youtube' : isGoogleNews ? 'google_news' : (feed.isPodcast ? 'podcast' : 'rss');
      const configObj = { image: feed.image, link: feed.link };
      if (isGoogleNews) configObj.query = query;
      if (isYouTube) {
        try {
          const { extractYoutubeChannelId } = await import("./feed-fetcher.js");
          configObj.channel_id = await extractYoutubeChannelId(youtube_channel);
          configObj.channel_url = youtube_channel;
        } catch {}
      }

      const result = await db.execute({
        sql: `INSERT INTO media_sources (source_type, name, url, category, fetch_interval_min, last_fetched, config)
              VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
        args: [sourceType, sourceName, url, category || null, interval, JSON.stringify(configObj)],
      });

      const sourceId = result.lastInsertRowid;

      // Also write to podcast tables for backward compat if detected as podcast
      if (sourceType === 'podcast') {
        try {
          await db.execute({
            sql: `INSERT OR IGNORE INTO podcast_subscriptions (feed_url, title, description, image_url, last_fetched)
                  VALUES (?, ?, ?, ?, datetime('now'))`,
            args: [url, sourceName, feed.description || null, feed.image || null],
          });
        } catch {}
      }

      // Import articles
      let imported = 0;
      for (const item of items.slice(0, 100)) {
        const guid = item.guid || item.link || item.title;
        if (!guid) continue;
        try {
          await db.execute({
            sql: `INSERT OR IGNORE INTO media_articles
                  (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url, audio_url,
                   source_url, content_fetch_status, ai_analysis_status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
            args: [
              sourceId, guid, item.link || null, item.title,
              item.author || null, item.pub_date ? normalizeDate(item.pub_date) : null,
              item.content || null, item.summary ? item.summary.slice(0, 2000) : null,
              item.image || null, item.enclosureAudio || null, item.sourceUrl || null,
            ],
          });
          imported++;
        } catch {
          // Skip duplicates
        }
      }

      return {
        content: [{
          type: "text",
          text: `Added source: "${sourceName}"\nID: ${sourceId}\nCategory: ${category || "uncategorized"}\nFetch interval: ${interval} min\nImported: ${imported} article(s)\n\nUse crow_media_feed to browse articles.`,
        }],
      };
    }
  );

  // --- crow_media_list_sources ---
  server.tool(
    "crow_media_list_sources",
    "List subscribed news sources with status",
    {
      enabled_only: z.boolean().optional().describe("Only show enabled sources (default true)"),
      category: z.string().max(200).optional().describe("Filter by category"),
    },
    async ({ enabled_only, category }) => {
      let sql = "SELECT * FROM media_sources WHERE 1=1";
      const args = [];

      if (enabled_only !== false) {
        sql += " AND enabled = 1";
      }
      if (category) {
        const escaped = escapeLikePattern(category);
        sql += " AND category LIKE ? ESCAPE '\\'";
        args.push(`%${escaped}%`);
      }

      sql += " ORDER BY name ASC";

      const result = await db.execute({ sql, args });
      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No sources found. Use crow_media_add_source to subscribe to an RSS feed." }] };
      }

      const lines = result.rows.map((s) => {
        const status = s.enabled ? "active" : "disabled";
        const error = s.last_error ? ` [error: ${s.last_error.slice(0, 50)}]` : "";
        const cat = s.category ? ` (${s.category})` : "";
        const lastFetch = s.last_fetched || "never";
        return `- #${s.id} [${status}] ${s.name}${cat}\n  URL: ${s.url}\n  Last fetched: ${lastFetch}${error}`;
      });

      return { content: [{ type: "text", text: `${result.rows.length} source(s):\n\n${lines.join("\n\n")}` }] };
    }
  );

  // --- crow_media_remove_source ---
  server.tool(
    "crow_media_remove_source",
    "Remove a news source subscription. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      id: z.number().describe("Source ID"),
      delete_articles: z.boolean().optional().describe("Also delete all articles from this source (default false)"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ id, delete_articles, confirm_token }) => {
      const existing = await db.execute({ sql: "SELECT * FROM media_sources WHERE id = ?", args: [id] });
      if (existing.rows.length === 0) {
        return { content: [{ type: "text", text: `Source ${id} not found. Use crow_media_list_sources to see available sources.` }], isError: true };
      }
      const source = existing.rows[0];

      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "remove_source", id)) {
            return { content: [{ type: "text", text: 'Invalid or expired confirmation token. Pass confirm_token: "" to get a new preview.' }], isError: true };
          }
        } else {
          const articleCount = await db.execute({ sql: "SELECT COUNT(*) as c FROM media_articles WHERE source_id = ?", args: [id] });
          const count = articleCount.rows[0]?.c || 0;
          const token = generateToken("remove_source", id);
          return {
            content: [{
              type: "text",
              text: `⚠️ This will remove source:\n  #${source.id}: "${source.name}" (${source.url})\n  ${count} article(s) ${delete_articles ? "will be DELETED" : "will be kept (orphaned)"}\n\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      if (delete_articles) {
        // Delete article states first (FK constraint)
        await db.execute({
          sql: "DELETE FROM media_article_states WHERE article_id IN (SELECT id FROM media_articles WHERE source_id = ?)",
          args: [id],
        });
        await db.execute({ sql: "DELETE FROM media_articles WHERE source_id = ?", args: [id] });
      }
      await db.execute({ sql: "DELETE FROM media_sources WHERE id = ?", args: [id] });

      return { content: [{ type: "text", text: `Removed source "${source.name}".${delete_articles ? " Articles deleted." : ""}` }] };
    }
  );

  // --- crow_media_feed ---
  server.tool(
    "crow_media_feed",
    "Browse articles from your news feed. Supports chronological or personalized 'for_you' sorting.",
    {
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      offset: z.number().min(0).optional().describe("Pagination offset (default 0)"),
      category: z.string().max(200).optional().describe("Filter by source category"),
      source_id: z.number().optional().describe("Filter by source ID"),
      unread_only: z.boolean().optional().describe("Only unread articles"),
      starred_only: z.boolean().optional().describe("Only starred articles"),
      sort: z.enum(["chronological", "for_you"]).optional().describe("Sort order (default chronological)"),
    },
    async ({ limit, offset, category, source_id, unread_only, starred_only, sort }) => {
      // Use personalized scoring if sort === "for_you"
      if (sort === "for_you") {
        try {
          const { buildScoredFeedSql } = await import("./scorer.js");
          const scored = buildScoredFeedSql({
            limit: limit || 20, offset: offset || 0,
            category, sourceId: source_id, unreadOnly: unread_only, starredOnly: starred_only,
          });
          const result = await db.execute({ sql: scored.sql, args: scored.args });

          if (result.rows.length === 0) {
            return { content: [{ type: "text", text: "No articles found for your personalized feed. Add sources and interact with articles to build your profile." }] };
          }

          const lines = result.rows.map((a) => {
            const flags = [];
            if (a.is_starred) flags.push("★");
            if (a.is_saved) flags.push("saved");
            if (a.is_read) flags.push("read");
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            const date = a.pub_date ? formatShortDate(a.pub_date) : "";
            const summaryLine = a.summary ? `\n  ${a.summary.slice(0, 150)}${a.summary.length > 150 ? "..." : ""}` : "";
            const scoreStr = a.score !== undefined ? ` (score: ${a.score.toFixed(2)})` : "";
            return `- #${a.id}${flagStr} ${a.title}${scoreStr}\n  ${a.source_name}${a.source_category ? ` (${a.source_category})` : ""} · ${date}${summaryLine}`;
          });

          return { content: [{ type: "text", text: `${result.rows.length} article(s) — For You:\n\n${lines.join("\n\n")}` }] };
        } catch (err) {
          // Fall through to chronological if scorer fails
        }
      }

      let sql = `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
                        s.name as source_name, s.category as source_category,
                        COALESCE(st.is_read, 0) as is_read,
                        COALESCE(st.is_starred, 0) as is_starred,
                        COALESCE(st.is_saved, 0) as is_saved
                 FROM media_articles a
                 JOIN media_sources s ON s.id = a.source_id
                 LEFT JOIN media_article_states st ON st.article_id = a.id
                 WHERE 1=1`;
      const args = [];

      if (category) {
        const escaped = escapeLikePattern(category);
        sql += " AND s.category LIKE ? ESCAPE '\\'";
        args.push(`%${escaped}%`);
      }
      if (source_id) {
        sql += " AND a.source_id = ?";
        args.push(source_id);
      }
      if (unread_only) {
        sql += " AND COALESCE(st.is_read, 0) = 0";
      }
      if (starred_only) {
        sql += " AND COALESCE(st.is_starred, 0) = 1";
      }

      sql += " ORDER BY a.pub_date DESC NULLS LAST, a.created_at DESC";
      sql += " LIMIT ? OFFSET ?";
      args.push(limit || 20, offset || 0);

      const result = await db.execute({ sql, args });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No articles found. Add sources with crow_media_add_source, then wait for feeds to refresh or use crow_media_refresh." }] };
      }

      const lines = result.rows.map((a) => {
        const flags = [];
        if (a.is_starred) flags.push("★");
        if (a.is_saved) flags.push("saved");
        if (a.is_read) flags.push("read");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        const date = a.pub_date ? formatShortDate(a.pub_date) : "";
        const summaryLine = a.summary ? `\n  ${a.summary.slice(0, 150)}${a.summary.length > 150 ? "..." : ""}` : "";

        return `- #${a.id}${flagStr} ${a.title}\n  ${a.source_name}${a.source_category ? ` (${a.source_category})` : ""} · ${date} · ${a.author || ""}${summaryLine}`;
      });

      return {
        content: [{
          type: "text",
          text: `${result.rows.length} article(s):\n\n${lines.join("\n\n")}\n\nUse crow_media_get_article with an ID for full content.`,
        }],
      };
    }
  );

  // --- crow_media_get_article ---
  server.tool(
    "crow_media_get_article",
    "Get full article content by ID",
    {
      id: z.number().describe("Article ID"),
    },
    async ({ id }) => {
      const result = await db.execute({
        sql: `SELECT a.*, s.name as source_name, s.category as source_category,
                     COALESCE(st.is_read, 0) as is_read,
                     COALESCE(st.is_starred, 0) as is_starred,
                     COALESCE(st.is_saved, 0) as is_saved
              FROM media_articles a
              JOIN media_sources s ON s.id = a.source_id
              LEFT JOIN media_article_states st ON st.article_id = a.id
              WHERE a.id = ?`,
        args: [id],
      });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: `Article ${id} not found.` }], isError: true };
      }

      const a = result.rows[0];
      const content = a.content_full || a.content_raw || a.summary || "(no content)";
      const flags = [];
      if (a.is_starred) flags.push("★ starred");
      if (a.is_saved) flags.push("saved");
      if (a.is_read) flags.push("read");

      // Mark as read
      await db.execute({
        sql: `INSERT INTO media_article_states (article_id, is_read, read_at)
              VALUES (?, 1, datetime('now'))
              ON CONFLICT(article_id) DO UPDATE SET is_read = 1, read_at = datetime('now')`,
        args: [id],
      });

      return {
        content: [{
          type: "text",
          text: `# ${a.title}\n\nSource: ${a.source_name}${a.source_category ? ` (${a.source_category})` : ""}\nAuthor: ${a.author || "unknown"}\nDate: ${a.pub_date || "unknown"}\nURL: ${a.url || "none"}\nStatus: ${flags.join(", ") || "unread"}\n${a.summary ? `\nSummary: ${a.summary}` : ""}\n\n---\n\n${content}`,
        }],
      };
    }
  );

  // --- crow_media_search ---
  server.tool(
    "crow_media_search",
    "Full-text search across articles. Set discover_sources=true to also search the web for new RSS feeds when local results are thin.",
    {
      query: z.string().max(500).describe("Search query"),
      category: z.string().max(200).optional().describe("Filter by source category"),
      date_from: z.string().max(50).optional().describe("ISO date to filter from (e.g. '2025-01-01')"),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 20)"),
      discover_sources: z.boolean().optional().describe("Search web for RSS feeds if local results < 5 (requires BRAVE_API_KEY)"),
    },
    async ({ query, category, date_from, limit, discover_sources }) => {
      const safeQuery = sanitizeFtsQuery(query);
      if (!safeQuery) {
        return { content: [{ type: "text", text: "Invalid search query." }], isError: true };
      }

      let sql = `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
                        s.name as source_name, s.category as source_category
                 FROM media_articles a
                 JOIN media_articles_fts fts ON a.id = fts.rowid
                 JOIN media_sources s ON s.id = a.source_id
                 WHERE fts.media_articles_fts MATCH ?`;
      const args = [safeQuery];

      if (category) {
        const escaped = escapeLikePattern(category);
        sql += " AND s.category LIKE ? ESCAPE '\\'";
        args.push(`%${escaped}%`);
      }
      if (date_from) {
        sql += " AND a.pub_date >= ?";
        args.push(date_from);
      }

      sql += " ORDER BY rank LIMIT ?";
      args.push(limit || 20);

      const result = await db.execute({ sql, args });

      const lines = result.rows.map((a) => {
        const date = a.pub_date ? formatShortDate(a.pub_date) : "";
        const snippet = a.summary ? a.summary.slice(0, 120) + "..." : "";
        return `- #${a.id} ${a.title}\n  ${a.source_name} · ${date}\n  ${snippet}`;
      });

      let output = result.rows.length > 0
        ? `${result.rows.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`
        : `No articles found matching "${query}".`;

      // Web discovery via Brave Search if enabled and few local results
      if (discover_sources && result.rows.length < 5) {
        const braveKey = process.env.BRAVE_API_KEY;
        if (braveKey) {
          try {
            const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query + " RSS feed")}&count=10`;
            const braveRes = await fetch(searchUrl, {
              headers: { "X-Subscription-Token": braveKey, Accept: "application/json" },
            });
            if (braveRes.ok) {
              const data = await braveRes.json();
              const feedUrls = [];
              for (const r of (data.web?.results || [])) {
                const url = r.url || "";
                if (/\.(xml|rss|atom)$/i.test(url) || /\/feed\/?$/i.test(url) || /\/rss\/?$/i.test(url)) {
                  feedUrls.push({ title: r.title, url });
                }
              }
              if (feedUrls.length > 0) {
                output += `\n\nDiscovered ${feedUrls.length} potential RSS feed(s):\n`;
                output += feedUrls.map(f => `  - ${f.title}: ${f.url}`).join("\n");
                output += `\n\nUse crow_media_add_source to subscribe to any of these feeds.`;
              } else {
                output += `\n\nNo RSS feeds discovered via web search.`;
              }
            }
          } catch (err) {
            output += `\n\nWeb discovery failed: ${err.message}`;
          }
        } else {
          output += `\n\nSet BRAVE_API_KEY in .env to enable web source discovery.`;
        }
      }

      return { content: [{ type: "text", text: output }] };
    }
  );

  // --- crow_media_article_action ---
  server.tool(
    "crow_media_article_action",
    "Perform an action on an article: star, unstar, save, unsave, mark_read, mark_unread, thumbs_up, thumbs_down",
    {
      article_id: z.number().describe("Article ID"),
      action: z.enum(["star", "unstar", "save", "unsave", "mark_read", "mark_unread", "thumbs_up", "thumbs_down"]).describe("Action to perform"),
    },
    async ({ article_id, action }) => {
      // Verify article exists
      const exists = await db.execute({ sql: "SELECT id FROM media_articles WHERE id = ?", args: [article_id] });
      if (exists.rows.length === 0) {
        return { content: [{ type: "text", text: `Article ${article_id} not found.` }], isError: true };
      }

      // Ensure state row exists
      await db.execute({
        sql: "INSERT OR IGNORE INTO media_article_states (article_id) VALUES (?)",
        args: [article_id],
      });

      const actionMap = {
        star: { sql: "UPDATE media_article_states SET is_starred = 1 WHERE article_id = ?", msg: "Starred" },
        unstar: { sql: "UPDATE media_article_states SET is_starred = 0 WHERE article_id = ?", msg: "Unstarred" },
        save: { sql: "UPDATE media_article_states SET is_saved = 1 WHERE article_id = ?", msg: "Saved" },
        unsave: { sql: "UPDATE media_article_states SET is_saved = 0 WHERE article_id = ?", msg: "Unsaved" },
        mark_read: { sql: "UPDATE media_article_states SET is_read = 1, read_at = datetime('now') WHERE article_id = ?", msg: "Marked as read" },
        mark_unread: { sql: "UPDATE media_article_states SET is_read = 0, read_at = NULL WHERE article_id = ?", msg: "Marked as unread" },
      };

      if (action === "thumbs_up" || action === "thumbs_down") {
        await db.execute({
          sql: "INSERT INTO media_feedback (article_id, feedback) VALUES (?, ?)",
          args: [article_id, action === "thumbs_up" ? "up" : "down"],
        });
        // Update interest profiles
        try {
          const { updateInterestProfile } = await import("./scorer.js");
          await updateInterestProfile(db, article_id, action);
        } catch {}
        return { content: [{ type: "text", text: `Feedback recorded: ${action === "thumbs_up" ? "👍" : "👎"}` }] };
      }

      const entry = actionMap[action];
      await db.execute({ sql: entry.sql, args: [article_id] });

      // Update interest profiles for scoring
      try {
        const { updateInterestProfile } = await import("./scorer.js");
        await updateInterestProfile(db, article_id, action);
      } catch {}

      return { content: [{ type: "text", text: `${entry.msg} article ${article_id}.` }] };
    }
  );

  // --- crow_media_refresh ---
  server.tool(
    "crow_media_refresh",
    "Trigger an immediate feed refresh for one or all sources",
    {
      source_id: z.number().optional().describe("Source ID to refresh (omit to refresh all)"),
    },
    async ({ source_id }) => {
      let sources;
      if (source_id) {
        const result = await db.execute({ sql: "SELECT * FROM media_sources WHERE id = ? AND enabled = 1", args: [source_id] });
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `Source ${source_id} not found or disabled.` }], isError: true };
        }
        sources = result.rows;
      } else {
        const result = await db.execute({ sql: "SELECT * FROM media_sources WHERE enabled = 1", args: [] });
        sources = result.rows;
      }

      if (sources.length === 0) {
        return { content: [{ type: "text", text: "No enabled sources to refresh." }] };
      }

      let totalNew = 0;
      const errors = [];

      for (const source of sources) {
        try {
          const { feed, items } = await fetchAndParseFeed(source.url);

          await db.execute({
            sql: "UPDATE media_sources SET last_fetched = datetime('now'), last_error = NULL WHERE id = ?",
            args: [source.id],
          });

          let newCount = 0;
          for (const item of items.slice(0, 100)) {
            const guid = item.guid || item.link || item.title;
            if (!guid) continue;
            try {
              const ins = await db.execute({
                sql: `INSERT OR IGNORE INTO media_articles
                      (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                       audio_url, source_url, content_fetch_status, ai_analysis_status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                args: [
                  source.id, guid, item.link || null, item.title,
                  item.author || null, item.pub_date ? normalizeDate(item.pub_date) : null,
                  item.content || null, item.summary ? item.summary.slice(0, 2000) : null,
                  item.image || null, item.enclosureAudio || null, item.sourceUrl || null,
                ],
              });
              if (ins.rowsAffected > 0) newCount++;
            } catch {
              // Skip
            }
          }
          totalNew += newCount;
        } catch (err) {
          errors.push(`${source.name}: ${err.message}`);
          await db.execute({
            sql: "UPDATE media_sources SET last_error = ?, last_fetched = datetime('now') WHERE id = ?",
            args: [err.message.slice(0, 500), source.id],
          }).catch(() => {});
        }
      }

      let text = `Refreshed ${sources.length} source(s). New articles: ${totalNew}.`;
      if (errors.length > 0) {
        text += `\n\nErrors (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  // --- crow_media_stats ---
  server.tool(
    "crow_media_stats",
    "Get media statistics overview",
    {},
    async () => {
      const [sourcesResult, articlesResult, unreadResult, starredResult, savedResult] = await Promise.all([
        db.execute("SELECT COUNT(*) as c FROM media_sources WHERE enabled = 1"),
        db.execute("SELECT COUNT(*) as c FROM media_articles"),
        db.execute("SELECT COUNT(*) as c FROM media_articles a LEFT JOIN media_article_states st ON st.article_id = a.id WHERE COALESCE(st.is_read, 0) = 0"),
        db.execute("SELECT COUNT(*) as c FROM media_article_states WHERE is_starred = 1"),
        db.execute("SELECT COUNT(*) as c FROM media_article_states WHERE is_saved = 1"),
      ]);

      // Top categories
      const catResult = await db.execute(
        "SELECT category, COUNT(*) as c FROM media_sources WHERE category IS NOT NULL AND enabled = 1 GROUP BY category ORDER BY c DESC LIMIT 10"
      );
      const categories = catResult.rows.map((r) => `${r.category} (${r.c})`).join(", ");

      return {
        content: [{
          type: "text",
          text: `Media Statistics:\n  Active sources: ${sourcesResult.rows[0].c}\n  Total articles: ${articlesResult.rows[0].c}\n  Unread: ${unreadResult.rows[0].c}\n  Starred: ${starredResult.rows[0].c}\n  Saved: ${savedResult.rows[0].c}\n  Categories: ${categories || "none"}`,
        }],
      };
    }
  );

  // --- crow_media_listen ---
  server.tool(
    "crow_media_listen",
    "Generate or retrieve TTS audio for an article. Requires edge-tts package (npm install edge-tts).",
    {
      article_id: z.number().describe("Article ID"),
      voice: z.string().max(100).optional().describe("Edge TTS voice (default: en-US-AriaNeural)"),
    },
    async ({ article_id, voice }) => {
      try {
        const { isEdgeTtsAvailable, getOrGenerateAudio } = await import("./tts.js");
        if (!(await isEdgeTtsAvailable())) {
          return {
            content: [{ type: "text", text: "edge-tts is not installed. Run: npm install edge-tts" }],
            isError: true,
          };
        }
        const result = await getOrGenerateAudio(db, article_id, voice || "en-US-AriaNeural");
        const durationMin = result.duration ? `${Math.floor(result.duration / 60)}:${String(Math.round(result.duration % 60)).padStart(2, "0")}` : "unknown";
        return {
          content: [{
            type: "text",
            text: `Audio ${result.cached ? "retrieved from cache" : "generated"}.\nDuration: ~${durationMin}\nURL: /api/media/articles/${article_id}/audio`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `TTS error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_media_briefing ---
  server.tool(
    "crow_media_briefing",
    "Generate a news briefing: AI narration script from top articles, optionally with TTS audio.",
    {
      topic: z.string().max(500).optional().describe("Topic filter (matches categories or search)"),
      max_articles: z.number().min(1).max(20).optional().describe("Max articles to include (default 5)"),
      voice: z.string().max(100).optional().describe("TTS voice (omit to skip audio generation)"),
    },
    async ({ topic, max_articles, voice }) => {
      const limit = max_articles || 5;

      // Get top unread articles
      let sql = `SELECT a.id, a.title, a.url, a.pub_date, a.summary,
                        s.name as source_name, s.category as source_category
                 FROM media_articles a
                 JOIN media_sources s ON s.id = a.source_id
                 LEFT JOIN media_article_states st ON st.article_id = a.id
                 WHERE COALESCE(st.is_read, 0) = 0 AND s.enabled = 1`;
      const args = [];
      if (topic) {
        const escaped = escapeLikePattern(topic);
        sql += " AND (s.category LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')";
        args.push(`%${escaped}%`, `%${escaped}%`);
      }
      sql += " ORDER BY a.pub_date DESC NULLS LAST LIMIT ?";
      args.push(limit);

      const { rows: articles } = await db.execute({ sql, args });
      if (articles.length === 0) {
        return { content: [{ type: "text", text: "No unread articles found for briefing." }] };
      }

      // Build narration script
      const lines = [`Here's your ${topic ? `${topic} ` : ""}news briefing with ${articles.length} stories.\n`];
      for (let i = 0; i < articles.length; i++) {
        const a = articles[i];
        lines.push(`Story ${i + 1}: ${a.title}.`);
        if (a.summary) lines.push(a.summary.slice(0, 300));
        lines.push(`From ${a.source_name}.\n`);
      }
      const script = lines.join("\n");

      // Store briefing
      const articleIds = articles.map(a => a.id);
      let audioPath = null;
      let duration = null;

      if (voice) {
        try {
          const { isEdgeTtsAvailable, generateAudio, resolveAudioDir } = await import("./tts.js");
          if (await isEdgeTtsAvailable()) {
            const { join } = await import("node:path");
            const audioDir = resolveAudioDir();
            const ts = Date.now();
            audioPath = join(audioDir, `briefing-${ts}.mp3`);
            const result = await generateAudio(script, voice, audioPath);
            duration = result.duration;
          }
        } catch {}
      }

      const insertResult = await db.execute({
        sql: `INSERT INTO media_briefings (title, script, audio_path, article_ids, duration_sec, voice)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          topic ? `${topic} Briefing` : "News Briefing",
          script, audioPath, JSON.stringify(articleIds), duration, voice || null,
        ],
      });

      let text = `Briefing generated (ID: ${insertResult.lastInsertRowid})\n${articles.length} article(s) included.\n\n${script}`;
      if (audioPath) {
        text += `\nAudio: /api/media/briefings/${insertResult.lastInsertRowid}/audio`;
      }

      return { content: [{ type: "text", text }] };
    }
  );

  // --- crow_media_playlist ---
  server.tool(
    "crow_media_playlist",
    "Manage playlists: create, list, rename, or delete.",
    {
      action: z.enum(["create", "list", "rename", "delete"]).describe("Action"),
      id: z.number().optional().describe("Playlist ID (for rename/delete)"),
      name: z.string().max(500).optional().describe("Playlist name (for create/rename)"),
      description: z.string().max(2000).optional().describe("Playlist description"),
      confirm_token: z.string().max(100).optional().describe("Confirmation token for delete"),
    },
    async ({ action, id, name, description, confirm_token }) => {
      if (action === "create") {
        if (!name) return { content: [{ type: "text", text: "Name is required for creating a playlist." }], isError: true };
        const result = await db.execute({
          sql: "INSERT INTO media_playlists (name, description) VALUES (?, ?)",
          args: [name, description || null],
        });
        return { content: [{ type: "text", text: `Playlist created: "${name}" (ID: ${result.lastInsertRowid})` }] };
      }

      if (action === "list") {
        const { rows } = await db.execute(
          "SELECT p.*, (SELECT COUNT(*) FROM media_playlist_items pi WHERE pi.playlist_id = p.id) as item_count FROM media_playlists p ORDER BY p.updated_at DESC"
        );
        if (rows.length === 0) return { content: [{ type: "text", text: "No playlists yet." }] };
        const lines = rows.map(p => `- #${p.id} "${p.name}" (${p.item_count} items)${p.auto_generated ? " [auto]" : ""}`);
        return { content: [{ type: "text", text: `${rows.length} playlist(s):\n\n${lines.join("\n")}` }] };
      }

      if (action === "rename") {
        if (!id || !name) return { content: [{ type: "text", text: "id and name are required for rename." }], isError: true };
        await db.execute({
          sql: "UPDATE media_playlists SET name = ?, updated_at = datetime('now') WHERE id = ?",
          args: [name, id],
        });
        return { content: [{ type: "text", text: `Playlist ${id} renamed to "${name}".` }] };
      }

      if (action === "delete") {
        if (!id) return { content: [{ type: "text", text: "id is required for delete." }], isError: true };
        const existing = await db.execute({ sql: "SELECT * FROM media_playlists WHERE id = ?", args: [id] });
        if (existing.rows.length === 0) return { content: [{ type: "text", text: `Playlist ${id} not found.` }], isError: true };

        if (!shouldSkipGates()) {
          if (confirm_token) {
            if (!validateToken(confirm_token, "delete_playlist", id)) {
              return { content: [{ type: "text", text: "Invalid or expired token." }], isError: true };
            }
          } else {
            const token = generateToken("delete_playlist", id);
            return { content: [{ type: "text", text: `Delete playlist "${existing.rows[0].name}"?\nConfirm with token: "${token}"` }] };
          }
        }

        await db.execute({ sql: "DELETE FROM media_playlists WHERE id = ?", args: [id] });
        return { content: [{ type: "text", text: `Deleted playlist "${existing.rows[0].name}".` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );

  // --- crow_media_playlist_items ---
  server.tool(
    "crow_media_playlist_items",
    "Manage playlist items: add, remove, reorder, or list.",
    {
      action: z.enum(["add", "remove", "reorder", "list"]).describe("Action"),
      playlist_id: z.number().describe("Playlist ID"),
      item_type: z.string().max(50).optional().describe("Item type: article, briefing, episode"),
      item_id: z.number().optional().describe("Item ID to add/remove"),
      item_ids: z.array(z.number()).optional().describe("Ordered item IDs for reorder"),
    },
    async ({ action, playlist_id, item_type, item_id, item_ids }) => {
      // Verify playlist exists
      const pl = await db.execute({ sql: "SELECT id FROM media_playlists WHERE id = ?", args: [playlist_id] });
      if (pl.rows.length === 0) return { content: [{ type: "text", text: `Playlist ${playlist_id} not found.` }], isError: true };

      if (action === "add") {
        if (!item_type || !item_id) return { content: [{ type: "text", text: "item_type and item_id required." }], isError: true };
        const maxPos = await db.execute({
          sql: "SELECT COALESCE(MAX(position), 0) as m FROM media_playlist_items WHERE playlist_id = ?",
          args: [playlist_id],
        });
        await db.execute({
          sql: "INSERT INTO media_playlist_items (playlist_id, item_type, item_id, position) VALUES (?, ?, ?, ?)",
          args: [playlist_id, item_type, item_id, (maxPos.rows[0]?.m || 0) + 1],
        });
        await db.execute({ sql: "UPDATE media_playlists SET updated_at = datetime('now') WHERE id = ?", args: [playlist_id] });
        return { content: [{ type: "text", text: `Added ${item_type} #${item_id} to playlist.` }] };
      }

      if (action === "remove") {
        if (!item_id) return { content: [{ type: "text", text: "item_id required." }], isError: true };
        await db.execute({
          sql: "DELETE FROM media_playlist_items WHERE playlist_id = ? AND item_id = ?",
          args: [playlist_id, item_id],
        });
        return { content: [{ type: "text", text: `Removed item #${item_id} from playlist.` }] };
      }

      if (action === "reorder") {
        if (!item_ids || item_ids.length === 0) return { content: [{ type: "text", text: "item_ids array required." }], isError: true };
        for (let i = 0; i < item_ids.length; i++) {
          await db.execute({
            sql: "UPDATE media_playlist_items SET position = ? WHERE playlist_id = ? AND item_id = ?",
            args: [i + 1, playlist_id, item_ids[i]],
          });
        }
        return { content: [{ type: "text", text: `Reordered ${item_ids.length} items.` }] };
      }

      if (action === "list") {
        const { rows } = await db.execute({
          sql: `SELECT pi.*,
                  CASE pi.item_type
                    WHEN 'article' THEN (SELECT title FROM media_articles WHERE id = pi.item_id)
                    WHEN 'briefing' THEN (SELECT title FROM media_briefings WHERE id = pi.item_id)
                    ELSE 'Unknown'
                  END as item_title
                FROM media_playlist_items pi
                WHERE pi.playlist_id = ?
                ORDER BY pi.position ASC`,
          args: [playlist_id],
        });
        if (rows.length === 0) return { content: [{ type: "text", text: "Playlist is empty." }] };
        const lines = rows.map(r => `${r.position}. [${r.item_type}] ${r.item_title || `#${r.item_id}`}`);
        return { content: [{ type: "text", text: `${rows.length} item(s):\n\n${lines.join("\n")}` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );

  // --- crow_media_smart_folders ---
  server.tool(
    "crow_media_smart_folders",
    "Manage smart folders: saved filter presets that auto-populate with matching articles.",
    {
      action: z.enum(["create", "list", "view", "update", "delete"]).describe("Action"),
      id: z.number().optional().describe("Folder ID (for view/update/delete)"),
      name: z.string().max(500).optional().describe("Folder name"),
      description: z.string().max(2000).optional().describe("Folder description"),
      query: z.object({
        category: z.string().optional(),
        source_id: z.number().optional(),
        topics: z.array(z.string()).optional(),
        unread_only: z.boolean().optional(),
        fts_query: z.string().optional(),
      }).optional().describe("Filter query object"),
      limit: z.number().min(1).max(50).optional().describe("Max articles for view (default 20)"),
      offset: z.number().min(0).optional().describe("Pagination offset for view"),
      confirm_token: z.string().max(100).optional().describe("Confirmation token for delete"),
    },
    async ({ action, id, name, description, query, limit, offset, confirm_token }) => {
      if (action === "create") {
        if (!name || !query) return { content: [{ type: "text", text: "name and query required." }], isError: true };
        const result = await db.execute({
          sql: "INSERT INTO media_smart_folders (name, description, query_json) VALUES (?, ?, ?)",
          args: [name, description || null, JSON.stringify(query)],
        });
        return { content: [{ type: "text", text: `Smart folder created: "${name}" (ID: ${result.lastInsertRowid})` }] };
      }

      if (action === "list") {
        const { rows } = await db.execute("SELECT * FROM media_smart_folders ORDER BY name ASC");
        if (rows.length === 0) return { content: [{ type: "text", text: "No smart folders. Create one with action: 'create'." }] };
        const lines = rows.map(f => {
          const q = JSON.parse(f.query_json || "{}");
          const filters = [];
          if (q.category) filters.push(`category: ${q.category}`);
          if (q.fts_query) filters.push(`search: "${q.fts_query}"`);
          if (q.unread_only) filters.push("unread");
          return `- #${f.id} "${f.name}" [${filters.join(", ") || "all"}]`;
        });
        return { content: [{ type: "text", text: `${rows.length} folder(s):\n\n${lines.join("\n")}` }] };
      }

      if (action === "view") {
        if (!id) return { content: [{ type: "text", text: "id required for view." }], isError: true };
        const folder = await db.execute({ sql: "SELECT * FROM media_smart_folders WHERE id = ?", args: [id] });
        if (folder.rows.length === 0) return { content: [{ type: "text", text: `Folder ${id} not found.` }], isError: true };

        const q = JSON.parse(folder.rows[0].query_json || "{}");
        const maxResults = limit || 20;
        const offsetVal = offset || 0;

        // Build query from filter
        let sql = `SELECT a.id, a.title, a.pub_date, a.url, a.summary,
                          s.name as source_name, s.category as source_category,
                          COALESCE(st.is_read, 0) as is_read
                   FROM media_articles a
                   JOIN media_sources s ON s.id = a.source_id
                   LEFT JOIN media_article_states st ON st.article_id = a.id
                   WHERE s.enabled = 1`;
        const args = [];

        if (q.category) { sql += " AND s.category = ?"; args.push(q.category); }
        if (q.source_id) { sql += " AND a.source_id = ?"; args.push(q.source_id); }
        if (q.unread_only) sql += " AND COALESCE(st.is_read, 0) = 0";
        if (q.fts_query) {
          const safe = sanitizeFtsQuery(q.fts_query);
          if (safe) {
            sql = sql.replace("FROM media_articles a", "FROM media_articles a JOIN media_articles_fts fts ON a.id = fts.rowid");
            sql += " AND fts.media_articles_fts MATCH ?";
            args.push(safe);
          }
        }

        sql += " ORDER BY a.pub_date DESC NULLS LAST LIMIT ? OFFSET ?";
        args.push(maxResults, offsetVal);

        const { rows: articles } = await db.execute({ sql, args });
        if (articles.length === 0) return { content: [{ type: "text", text: `Folder "${folder.rows[0].name}": no matching articles.` }] };

        const lines = articles.map(a => {
          const date = a.pub_date ? formatShortDate(a.pub_date) : "";
          return `- #${a.id} ${a.title}\n  ${a.source_name} · ${date}`;
        });

        return { content: [{ type: "text", text: `Folder "${folder.rows[0].name}" — ${articles.length} article(s):\n\n${lines.join("\n\n")}` }] };
      }

      if (action === "update") {
        if (!id) return { content: [{ type: "text", text: "id required." }], isError: true };
        const updates = [];
        const args = [];
        if (name) { updates.push("name = ?"); args.push(name); }
        if (description !== undefined) { updates.push("description = ?"); args.push(description); }
        if (query) { updates.push("query_json = ?"); args.push(JSON.stringify(query)); }
        if (updates.length === 0) return { content: [{ type: "text", text: "Nothing to update." }] };
        updates.push("updated_at = datetime('now')");
        args.push(id);
        await db.execute({ sql: `UPDATE media_smart_folders SET ${updates.join(", ")} WHERE id = ?`, args });
        return { content: [{ type: "text", text: `Folder ${id} updated.` }] };
      }

      if (action === "delete") {
        if (!id) return { content: [{ type: "text", text: "id required." }], isError: true };
        const existing = await db.execute({ sql: "SELECT name FROM media_smart_folders WHERE id = ?", args: [id] });
        if (existing.rows.length === 0) return { content: [{ type: "text", text: `Folder ${id} not found.` }], isError: true };

        if (!shouldSkipGates()) {
          if (confirm_token) {
            if (!validateToken(confirm_token, "delete_smart_folder", id)) {
              return { content: [{ type: "text", text: "Invalid or expired token." }], isError: true };
            }
          } else {
            const token = generateToken("delete_smart_folder", id);
            return { content: [{ type: "text", text: `Delete folder "${existing.rows[0].name}"?\nConfirm with token: "${token}"` }] };
          }
        }

        await db.execute({ sql: "DELETE FROM media_smart_folders WHERE id = ?", args: [id] });
        return { content: [{ type: "text", text: `Deleted folder "${existing.rows[0].name}".` }] };
      }

      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );

  // --- crow_media_digest_preview ---
  server.tool(
    "crow_media_digest_preview",
    "Preview what a digest email would contain (top unread articles).",
    {
      smart_folder_id: z.number().optional().describe("Limit to articles matching a smart folder"),
      limit: z.number().min(1).max(30).optional().describe("Max articles (default 15)"),
    },
    async ({ smart_folder_id, limit }) => {
      const maxResults = limit || 15;
      let filterSql = "";
      const args = [];

      if (smart_folder_id) {
        const folder = await db.execute({ sql: "SELECT query_json FROM media_smart_folders WHERE id = ?", args: [smart_folder_id] });
        if (folder.rows.length > 0) {
          const q = JSON.parse(folder.rows[0].query_json || "{}");
          if (q.category) { filterSql += " AND s.category = ?"; args.push(q.category); }
          if (q.source_id) { filterSql += " AND a.source_id = ?"; args.push(q.source_id); }
        }
      }

      const { rows: articles } = await db.execute({
        sql: `SELECT a.id, a.title, a.url, a.pub_date, a.summary,
                     s.name as source_name
              FROM media_articles a
              JOIN media_sources s ON s.id = a.source_id
              LEFT JOIN media_article_states st ON st.article_id = a.id
              WHERE COALESCE(st.is_read, 0) = 0 AND s.enabled = 1 ${filterSql}
              ORDER BY a.pub_date DESC NULLS LAST LIMIT ?`,
        args: [...args, maxResults],
      });

      if (articles.length === 0) {
        return { content: [{ type: "text", text: "No unread articles for digest." }] };
      }

      const lines = articles.map((a, i) => {
        const date = a.pub_date ? formatShortDate(a.pub_date) : "";
        return `${i + 1}. ${a.title}\n   ${a.source_name} · ${date}\n   ${a.summary ? a.summary.slice(0, 120) + "..." : ""}`;
      });

      return { content: [{ type: "text", text: `Digest preview (${articles.length} articles):\n\n${lines.join("\n\n")}` }] };
    }
  );

  // --- crow_media_digest_settings ---
  server.tool(
    "crow_media_digest_settings",
    "Configure email digest delivery settings.",
    {
      schedule: z.enum(["daily_morning", "daily_evening", "weekly"]).optional().describe("Delivery schedule"),
      email: z.string().max(500).optional().describe("Recipient email address"),
      custom_instructions: z.string().max(2000).optional().describe("Custom instructions for digest content"),
      enabled: z.boolean().optional().describe("Enable/disable digest delivery"),
    },
    async ({ schedule, email, custom_instructions, enabled }) => {
      // Get or create preferences row
      let { rows } = await db.execute("SELECT * FROM media_digest_preferences LIMIT 1");

      if (rows.length === 0) {
        await db.execute({
          sql: "INSERT INTO media_digest_preferences (schedule, email, custom_instructions, enabled) VALUES (?, ?, ?, ?)",
          args: [schedule || "daily_morning", email || null, custom_instructions || null, enabled ? 1 : 0],
        });
        rows = (await db.execute("SELECT * FROM media_digest_preferences LIMIT 1")).rows;
      } else {
        const updates = [];
        const args = [];
        if (schedule !== undefined) { updates.push("schedule = ?"); args.push(schedule); }
        if (email !== undefined) { updates.push("email = ?"); args.push(email); }
        if (custom_instructions !== undefined) { updates.push("custom_instructions = ?"); args.push(custom_instructions); }
        if (enabled !== undefined) { updates.push("enabled = ?"); args.push(enabled ? 1 : 0); }
        if (updates.length > 0) {
          args.push(rows[0].id);
          await db.execute({ sql: `UPDATE media_digest_preferences SET ${updates.join(", ")} WHERE id = ?`, args });
          rows = (await db.execute("SELECT * FROM media_digest_preferences LIMIT 1")).rows;
        }
      }

      const pref = rows[0];
      return {
        content: [{
          type: "text",
          text: `Digest settings:\n  Schedule: ${pref.schedule}\n  Email: ${pref.email || "(not set)"}\n  Enabled: ${pref.enabled ? "yes" : "no"}\n  Custom instructions: ${pref.custom_instructions || "(none)"}\n  Last sent: ${pref.last_sent || "never"}\n\nRequires SMTP configured in .env (CROW_SMTP_HOST, etc.) and nodemailer installed.`,
        }],
      };
    }
  );

  // --- crow_media_schedule_briefing ---
  server.tool(
    "crow_media_schedule_briefing",
    "Schedule automatic briefing generation using Crow's scheduling system.",
    {
      cron: z.string().max(100).describe("Cron expression (e.g. '0 8 * * 1-5' for weekday mornings at 8am)"),
      topic: z.string().max(500).optional().describe("Topic filter for briefing articles"),
      max_articles: z.number().min(1).max(20).optional().describe("Max articles (default 5)"),
      voice: z.string().max(100).optional().describe("TTS voice (omit to skip audio)"),
      enabled: z.boolean().optional().describe("Enable or disable (default true)"),
    },
    async ({ cron, topic, max_articles, voice, enabled }) => {
      const config = JSON.stringify({
        topic: topic || null,
        max_articles: max_articles || 5,
        voice: voice || null,
      });

      // Check for existing schedule
      const existing = await db.execute({
        sql: "SELECT id FROM schedules WHERE task = 'media:briefing'",
        args: [],
      });

      if (existing.rows.length > 0) {
        // Update existing
        await db.execute({
          sql: "UPDATE schedules SET cron = ?, config = ?, enabled = ? WHERE id = ?",
          args: [cron, config, enabled !== false ? 1 : 0, existing.rows[0].id],
        });
        return {
          content: [{ type: "text", text: `Updated briefing schedule: ${cron}\nTopic: ${topic || "all"}\nArticles: ${max_articles || 5}\nVoice: ${voice || "none"}` }],
        };
      }

      // Create new
      await db.execute({
        sql: "INSERT INTO schedules (task, cron, config, enabled, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        args: ["media:briefing", cron, config, enabled !== false ? 1 : 0],
      });
      return {
        content: [{ type: "text", text: `Scheduled briefing: ${cron}\nTopic: ${topic || "all"}\nArticles: ${max_articles || 5}\nVoice: ${voice || "none"}\n\nThe media task runner checks for due schedules every 30 minutes.` }],
      };
    }
  );

  // --- Prompt ---
  server.prompt(
    "media-guide",
    "Media workflow — subscribing to feeds, browsing articles, and managing your news",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Crow Media Guide

1. Subscribe — Use crow_media_add_source with RSS/Atom URL, Google News query, or YouTube channel
2. Browse — crow_media_feed to see your personalized news feed
3. Read — crow_media_get_article for full article content
4. Search — crow_media_search for full-text search across all articles
5. Interact — crow_media_article_action to star, save, or give feedback
6. Listen — crow_media_listen to generate TTS audio for an article
7. Briefings — crow_media_briefing to generate an AI-narrated news briefing
8. Playlists — crow_media_playlist and crow_media_playlist_items to organize content
9. Smart Folders — crow_media_smart_folders to create saved filter presets
10. Digest — crow_media_digest_settings + crow_media_digest_preview for email digests
11. Refresh — crow_media_refresh to trigger immediate feed updates
12. Stats — crow_media_stats for an overview of your media library`,
        },
      }],
    })
  );

  return server;
}

// --- Helpers ---

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toISOString();
  } catch {
    return dateStr;
  }
}

function formatShortDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}
