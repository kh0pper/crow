/**
 * Crow's Nest Panel — Media: news feed, article reader, source management
 */

import { escapeHtml, statCard, statGrid, section, badge, formatDate } from "../shared/components.js";

export default {
  id: "media",
  name: "Media",
  icon: "newspaper",
  route: "/dashboard/media",
  navOrder: 15,

  async handler(req, res, { db, layout }) {
    // --- POST actions ---
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "add_source") {
        const url = (req.body.url || "").trim();
        const name = (req.body.name || "").trim();
        const category = (req.body.category || "").trim();
        if (!url) return res.redirect("/dashboard/media?tab=sources&error=URL+required");

        try {
          const { fetchAndParseFeed } = await import("../../../media/feed-fetcher.js");
          const { feed, items } = await fetchAndParseFeed(url);
          const sourceName = name || feed.title || url;

          const result = await db.execute({
            sql: `INSERT INTO media_sources (source_type, name, url, category, last_fetched, config)
                  VALUES ('rss', ?, ?, ?, datetime('now'), ?)`,
            args: [sourceName, url, category || null, JSON.stringify({ image: feed.image })],
          });

          const sourceId = result.lastInsertRowid;
          for (const item of items.slice(0, 100)) {
            const guid = item.guid || item.link || item.title;
            if (!guid) continue;
            try {
              await db.execute({
                sql: `INSERT OR IGNORE INTO media_articles
                      (source_id, guid, url, title, author, pub_date, content_raw, summary,
                       content_fetch_status, ai_analysis_status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                args: [sourceId, guid, item.link || null, item.title, item.author || null,
                       item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null],
              });
            } catch {}
          }
        } catch (err) {
          return res.redirect(`/dashboard/media?tab=sources&error=${encodeURIComponent(err.message)}`);
        }
        return res.redirect("/dashboard/media?tab=sources");
      }

      if (action === "remove_source") {
        const id = parseInt(req.body.source_id, 10);
        if (id) {
          await db.execute({
            sql: "DELETE FROM media_article_states WHERE article_id IN (SELECT id FROM media_articles WHERE source_id = ?)",
            args: [id],
          });
          await db.execute({ sql: "DELETE FROM media_articles WHERE source_id = ?", args: [id] });
          await db.execute({ sql: "DELETE FROM media_sources WHERE id = ?", args: [id] });
        }
        return res.redirect("/dashboard/media?tab=sources");
      }

      if (action === "refresh_source") {
        const id = parseInt(req.body.source_id, 10);
        if (id) {
          try {
            const { rows } = await db.execute({ sql: "SELECT url FROM media_sources WHERE id = ?", args: [id] });
            if (rows[0]) {
              const { fetchAndParseFeed } = await import("../../../media/feed-fetcher.js");
              const { items } = await fetchAndParseFeed(rows[0].url);
              await db.execute({
                sql: "UPDATE media_sources SET last_fetched = datetime('now'), last_error = NULL WHERE id = ?",
                args: [id],
              });
              for (const item of items.slice(0, 100)) {
                const guid = item.guid || item.link || item.title;
                if (!guid) continue;
                try {
                  await db.execute({
                    sql: `INSERT OR IGNORE INTO media_articles
                          (source_id, guid, url, title, author, pub_date, content_raw, summary,
                           content_fetch_status, ai_analysis_status, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                    args: [id, guid, item.link || null, item.title, item.author || null,
                           item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null],
                  });
                } catch {}
              }
            }
          } catch {}
        }
        return res.redirect("/dashboard/media?tab=sources");
      }

      if (action === "toggle_star") {
        const id = parseInt(req.body.article_id, 10);
        if (id) {
          await db.execute({ sql: "INSERT OR IGNORE INTO media_article_states (article_id) VALUES (?)", args: [id] });
          await db.execute({
            sql: "UPDATE media_article_states SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END WHERE article_id = ?",
            args: [id],
          });
        }
        return res.redirect(`/dashboard/media${req.body.return_tab ? `?tab=${req.body.return_tab}` : ""}`);
      }
    }

    // --- GET: Determine tab ---
    const tab = req.query.tab || "feed";
    const errorMsg = req.query.error
      ? `<div class="alert alert-error" style="margin-bottom:1rem">${escapeHtml(req.query.error)}</div>`
      : "";

    // --- Stats ---
    const [sourcesCount, articlesCount, unreadCount, starredCount] = await Promise.all([
      db.execute("SELECT COUNT(*) as c FROM media_sources WHERE enabled = 1"),
      db.execute("SELECT COUNT(*) as c FROM media_articles"),
      db.execute("SELECT COUNT(*) as c FROM media_articles a LEFT JOIN media_article_states st ON st.article_id = a.id WHERE COALESCE(st.is_read, 0) = 0"),
      db.execute("SELECT COUNT(*) as c FROM media_article_states WHERE is_starred = 1"),
    ]);

    const stats = statGrid([
      statCard("Sources", String(sourcesCount.rows[0]?.c || 0), { delay: 0 }),
      statCard("Articles", String(articlesCount.rows[0]?.c || 0), { delay: 50 }),
      statCard("Unread", String(unreadCount.rows[0]?.c || 0), { delay: 100 }),
      statCard("Starred", String(starredCount.rows[0]?.c || 0), { delay: 150 }),
    ]);

    // --- Tab navigation ---
    const tabs = [
      { id: "feed", label: "Feed" },
      { id: "sources", label: "Sources" },
    ];
    const tabNav = `<div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;border-bottom:1px solid var(--crow-border);padding-bottom:0.5rem">
      ${tabs.map((t) => `<a href="/dashboard/media?tab=${t.id}" style="padding:0.4rem 0.75rem;border-radius:4px;text-decoration:none;font-size:0.85rem;${tab === t.id ? "background:var(--crow-accent);color:white" : "color:var(--crow-text-secondary)"}">${t.label}</a>`).join("")}
    </div>`;

    let tabContent = "";

    if (tab === "feed") {
      // Article feed
      const { rows: articles } = await db.execute({
        sql: `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary,
                     s.name as source_name, s.category as source_category,
                     COALESCE(st.is_read, 0) as is_read,
                     COALESCE(st.is_starred, 0) as is_starred
              FROM media_articles a
              JOIN media_sources s ON s.id = a.source_id
              LEFT JOIN media_article_states st ON st.article_id = a.id
              ORDER BY a.pub_date DESC NULLS LAST, a.created_at DESC
              LIMIT 30`,
        args: [],
      });

      if (articles.length === 0) {
        tabContent = `<div class="empty-state" style="text-align:center;padding:2rem;color:var(--crow-text-muted)">
          <h3>No articles yet</h3>
          <p>Add some RSS feeds in the Sources tab to get started.</p>
        </div>`;
      } else {
        tabContent = articles.map((a) => {
          const readClass = a.is_read ? "opacity:0.6" : "";
          const starIcon = a.is_starred ? "★" : "☆";
          const pubDate = a.pub_date ? formatDate(a.pub_date) : "";
          const categoryBadge = a.source_category ? badge(a.source_category, "connected") : "";
          const summary = a.summary ? escapeHtml(a.summary.slice(0, 200)) + (a.summary.length > 200 ? "..." : "") : "";

          return `<div class="card" style="padding:0.75rem;margin-bottom:0.5rem;${readClass}">
            <div style="display:flex;gap:0.5rem;align-items:start">
              <div style="flex:1;min-width:0">
                <div style="font-weight:500;margin-bottom:0.25rem">
                  ${a.url ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" style="color:var(--crow-text-primary);text-decoration:none">${escapeHtml(a.title)}</a>` : escapeHtml(a.title)}
                </div>
                <div style="font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.25rem">
                  ${escapeHtml(a.source_name)} · ${escapeHtml(pubDate)}${a.author ? ` · ${escapeHtml(a.author)}` : ""} ${categoryBadge}
                </div>
                ${summary ? `<div style="font-size:0.8rem;color:var(--crow-text-secondary);line-height:1.4">${summary}</div>` : ""}
              </div>
              <form method="POST" style="flex-shrink:0">
                <input type="hidden" name="action" value="toggle_star">
                <input type="hidden" name="article_id" value="${a.id}">
                <input type="hidden" name="return_tab" value="feed">
                <button type="submit" class="btn btn-sm btn-secondary" title="${a.is_starred ? "Unstar" : "Star"}" style="font-size:1.1rem;line-height:1">${starIcon}</button>
              </form>
            </div>
          </div>`;
        }).join("\n");
      }
    } else if (tab === "sources") {
      // Source management
      const addForm = `
        <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap;margin-bottom:1rem">
          <input type="hidden" name="action" value="add_source">
          <div style="flex:2;min-width:200px">
            <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">RSS Feed URL</label>
            <input type="url" name="url" placeholder="https://example.com/feed.xml" required
                   style="width:100%;padding:0.5rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          </div>
          <div style="flex:1;min-width:120px">
            <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">Name (optional)</label>
            <input type="text" name="name" placeholder="Auto-detected"
                   style="width:100%;padding:0.5rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          </div>
          <div style="flex:1;min-width:100px">
            <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">Category</label>
            <input type="text" name="category" placeholder="e.g. tech"
                   style="width:100%;padding:0.5rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          </div>
          <button type="submit" class="btn btn-primary">Add Source</button>
        </form>`;

      const { rows: sources } = await db.execute("SELECT * FROM media_sources ORDER BY name ASC");

      let sourcesList;
      if (sources.length === 0) {
        sourcesList = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No sources yet. Add an RSS feed above.</p>`;
      } else {
        sourcesList = sources.map((s) => {
          const config = s.config ? JSON.parse(s.config) : {};
          const img = config.image
            ? `<img src="${escapeHtml(config.image)}" alt="" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0">`
            : `<div style="width:40px;height:40px;border-radius:6px;background:var(--crow-accent-muted);display:flex;align-items:center;justify-content:center;color:var(--crow-accent);font-family:'Fraunces',serif;font-size:1rem;flex-shrink:0">${escapeHtml((s.name || "?").charAt(0))}</div>`;

          const statusBadge = s.last_error ? badge("Error", "error") : badge("Active", "connected");
          const lastFetched = s.last_fetched ? formatDate(s.last_fetched) : "Never";
          const cat = s.category ? ` · ${escapeHtml(s.category)}` : "";

          return `<div class="card" style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem;margin-bottom:0.5rem">
            ${img}
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name || s.url)}</div>
              <div style="font-size:0.8rem;color:var(--crow-text-muted)">Last fetched: ${escapeHtml(lastFetched)}${cat} ${statusBadge}</div>
            </div>
            <div style="display:flex;gap:0.25rem">
              <form method="POST" style="display:inline"><input type="hidden" name="action" value="refresh_source"><input type="hidden" name="source_id" value="${s.id}"><button type="submit" class="btn btn-sm btn-secondary" title="Refresh">↻</button></form>
              <form method="POST" style="display:inline" onsubmit="return confirm('Remove this source and all its articles?')"><input type="hidden" name="action" value="remove_source"><input type="hidden" name="source_id" value="${s.id}"><button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)" title="Remove">✕</button></form>
            </div>
          </div>`;
        }).join("\n");
      }

      tabContent = addForm + sourcesList;
    }

    const content = `
      ${errorMsg}
      ${stats}
      ${tabNav}
      ${tabContent}
    `;

    return layout({ title: "Media", content });
  },
};
