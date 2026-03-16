/**
 * Crow's Nest Panel — Media: news feed, For You, article cards with images, source management
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 */

const ARTICLES_PER_PAGE = 24;

export default {
  id: "media",
  name: "Media",
  icon: "newspaper",
  route: "/dashboard/media",
  navOrder: 15,

  async handler(req, res, { db, layout, appRoot }) {
    // --- Dynamic imports (replaces static ESM import) ---
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, statCard, statGrid, badge, formatDate } = await import(pathToFileURL(componentsPath).href);

    // Resolve bundle server directory (installed vs repo)
    const installedServerDir = join(process.env.HOME || "", ".crow", "bundles", "media", "server");
    const repoServerDir = join(appRoot, "bundles", "media", "server");
    const bundleServerDir = existsSync(installedServerDir) ? installedServerDir : repoServerDir;

    // Resolve shared db.js (for sanitizeFtsQuery)
    const dbModulePath = join(appRoot, "servers", "db.js");

    /** Helper to import a module from the bundle's server directory */
    async function importBundleModule(name) {
      return import(pathToFileURL(join(bundleServerDir, name)).href);
    }

    /** Build a query string preserving existing params */
    function buildQs(base, overrides) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...base, ...overrides })) {
        if (v !== undefined && v !== null && v !== "" && v !== "false") params.set(k, v);
      }
      const qs = params.toString();
      return qs ? `?${qs}` : "";
    }

    /** Render a single article card */
    function renderArticleCard(a, returnTab) {
      const starIcon = a.is_starred ? "\u2605" : "\u2606";
      const starColor = a.is_starred ? "color:#fbbf24" : "";
      const pubDate = a.pub_date ? formatDate(a.pub_date) : "";
      const readOpacity = a.is_read ? "opacity:0.7;" : "";
      const summary = a.summary ? escapeHtml(a.summary.slice(0, 180)) + (a.summary.length > 180 ? "..." : "") : "";
      const readTime = a.estimated_read_time ? `${a.estimated_read_time} min` : "";

      // Topics pills
      let topicsHtml = "";
      if (a.topics) {
        try {
          const topics = typeof a.topics === "string" ? JSON.parse(a.topics) : a.topics;
          if (Array.isArray(topics) && topics.length > 0) {
            topicsHtml = `<div style="display:flex;gap:0.25rem;flex-wrap:wrap;margin-top:0.4rem">${
              topics.slice(0, 3).map(t =>
                `<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:9px;background:var(--crow-accent-muted);color:var(--crow-accent)">${escapeHtml(t)}</span>`
              ).join("")
            }</div>`;
          }
        } catch {}
      }

      // Detect YouTube source
      const isYouTube = a.source_type === "youtube" || (a.url && a.url.includes("youtube.com/watch"));
      const youtubeOverlay = isYouTube
        ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;background:rgba(255,0,0,0.85);border-radius:12px;display:flex;align-items:center;justify-content:center"><span style="color:white;font-size:1.4rem;margin-left:3px">&#9654;</span></a>`
        : "";

      // Image section
      let imageHtml;
      if (a.image_url) {
        imageHtml = `<div style="position:relative;padding-top:56.25%;background:var(--crow-bg-deep);border-radius:6px 6px 0 0;overflow:hidden">
      <img src="${escapeHtml(a.image_url)}" alt="" loading="lazy" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover">
      ${youtubeOverlay}
    </div>`;
      } else if (a.source_type === "google_news" && a.author) {
        // Google News: publisher masthead template
        const publisher = a.author;
        const hue = Math.abs(hashCode(publisher)) % 360;
        imageHtml = `<div style="position:relative;padding-top:56.25%;background:linear-gradient(160deg, hsl(${hue},25%,14%), hsl(${hue + 30},20%,10%));border-radius:6px 6px 0 0;overflow:hidden">
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:start;justify-content:end;padding:0.75rem 1rem">
        <div style="font-size:0.6rem;letter-spacing:0.08em;text-transform:uppercase;color:hsl(${hue},50%,65%);margin-bottom:0.25rem">via</div>
        <div style="font-family:'Fraunces',serif;font-size:1.15rem;font-weight:600;color:hsl(${hue},40%,80%);line-height:1.2;text-shadow:0 1px 3px rgba(0,0,0,0.4)">${escapeHtml(publisher)}</div>
      </div>
      <div style="position:absolute;top:0.6rem;right:0.75rem;font-size:0.55rem;letter-spacing:0.06em;text-transform:uppercase;color:hsl(${hue},30%,45%);border:1px solid hsl(${hue},20%,25%);padding:0.15rem 0.4rem;border-radius:3px">news</div>
    </div>`;
      } else {
        // Generic fallback with source initial
        const initial = (a.source_name || "?").charAt(0).toUpperCase();
        const hue = Math.abs(hashCode(a.source_name || "")) % 360;
        imageHtml = `<div style="position:relative;padding-top:56.25%;background:linear-gradient(135deg, hsl(${hue},40%,20%), hsl(${hue + 40},30%,15%));border-radius:6px 6px 0 0;overflow:hidden">
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:'Fraunces',serif;font-size:2rem;color:hsla(${hue},60%,70%,0.4)">${escapeHtml(initial)}</div>
    </div>`;
      }

      return `<div class="media-card" style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:6px;overflow:hidden;display:flex;flex-direction:column;${readOpacity}">
    ${imageHtml}
    <div style="padding:0.75rem;flex:1;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem">
        <span style="font-size:0.7rem;color:var(--crow-accent);font-weight:500;text-transform:uppercase;letter-spacing:0.03em">${escapeHtml(a.source_name)}</span>
        <span style="font-size:0.7rem;color:var(--crow-text-muted)">${escapeHtml(pubDate)}${readTime ? ` \u00b7 ${readTime}` : ""}</span>
      </div>
      <h4 style="margin:0 0 0.3rem;font-size:0.9rem;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
        ${a.url ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" style="color:var(--crow-text-primary);text-decoration:none">${escapeHtml(a.title)}</a>` : escapeHtml(a.title)}
      </h4>
      ${summary ? `<p style="margin:0;font-size:0.78rem;color:var(--crow-text-secondary);line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;flex:1">${summary}</p>` : '<div style="flex:1"></div>'}
      ${topicsHtml}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5rem;padding-top:0.4rem;border-top:1px solid var(--crow-border)">
        <div style="display:flex;gap:0.25rem;align-items:center">
          ${a.source_category ? `<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:9px;background:var(--crow-bg-elevated);color:var(--crow-text-muted)">${escapeHtml(a.source_category)}</span>` : ""}
          ${a.is_read ? '<span style="font-size:0.65rem;color:var(--crow-text-muted)">read</span>' : ""}
          ${a.audio_url ? `<button onclick="window.crowPlayer&&window.crowPlayer.load('${escapeHtml(a.audio_url)}','${escapeHtml(a.title.replace(/'/g, ""))}')" class="btn btn-sm btn-secondary" title="Play audio" style="font-size:0.8rem;padding:0.1rem 0.3rem">&#9654;</button>` : ""}
        </div>
        <div style="display:flex;gap:0.2rem">
          <button onclick="window.crowPlayer&&window.crowPlayer.load('/api/media/articles/${a.id}/audio','${escapeHtml(a.title.replace(/'/g, ""))}')" class="btn btn-sm btn-secondary" title="Listen (TTS)" style="font-size:0.8rem;padding:0.1rem 0.3rem">&#127911;</button>
          <form method="POST" style="display:inline">
            <input type="hidden" name="action" value="toggle_star">
            <input type="hidden" name="article_id" value="${a.id}">
            <input type="hidden" name="return_tab" value="${returnTab}">
            <button type="submit" class="btn btn-sm btn-secondary" title="${a.is_starred ? "Unstar" : "Star"}" style="font-size:1.1rem;line-height:1;padding:0.15rem 0.35rem;${starColor}">${starIcon}</button>
          </form>
        </div>
      </div>
    </div>
  </div>`;
    }

    function hashCode(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return hash;
    }

    /** Standard chronological feed query with filters */
    async function buildChronologicalQuery(db, { filterCategory, filterSource, filterUnread, filterStarred, pageOffset }) {
      let sql = `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
                        a.topics, a.estimated_read_time, a.audio_url,
                        s.name as source_name, s.category as source_category, s.source_type,
                        COALESCE(st.is_read, 0) as is_read,
                        COALESCE(st.is_starred, 0) as is_starred
                 FROM media_articles a
                 JOIN media_sources s ON s.id = a.source_id
                 LEFT JOIN media_article_states st ON st.article_id = a.id
                 WHERE s.enabled = 1`;
      const args = [];

      if (filterCategory) { sql += " AND s.category = ?"; args.push(filterCategory); }
      if (filterSource) { sql += " AND a.source_id = ?"; args.push(parseInt(filterSource, 10)); }
      if (filterUnread) sql += " AND COALESCE(st.is_read, 0) = 0";
      if (filterStarred) sql += " AND COALESCE(st.is_starred, 0) = 1";

      sql += ` ORDER BY a.pub_date DESC NULLS LAST, a.created_at DESC LIMIT ${ARTICLES_PER_PAGE} OFFSET ${pageOffset}`;

      return db.execute({ sql, args });
    }

    // --- POST actions ---
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "add_source") {
        const url = (req.body.url || "").trim();
        const name = (req.body.name || "").trim();
        const category = (req.body.category || "").trim();
        if (!url) return res.redirect("/dashboard/media?tab=sources&error=URL+required");

        try {
          const { fetchAndParseFeed } = await importBundleModule("feed-fetcher.js");
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
                      (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                       content_fetch_status, ai_analysis_status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                args: [sourceId, guid, item.link || null, item.title, item.author || null,
                       item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null,
                       item.image || null],
              });
            } catch {}
          }
        } catch (err) {
          return res.redirect(`/dashboard/media?tab=sources&error=${encodeURIComponent(err.message)}`);
        }
        return res.redirect("/dashboard/media?tab=sources");
      }

      if (action === "add_google_news") {
        const query = (req.body.query || "").trim();
        const category = (req.body.category || "").trim();
        if (!query) return res.redirect("/dashboard/media?tab=sources&error=Query+required");

        try {
          const { fetchAndParseFeed, buildGoogleNewsUrl, postProcessGoogleNewsItems } = await importBundleModule("feed-fetcher.js");
          const url = buildGoogleNewsUrl(query);
          const { feed, items } = await fetchAndParseFeed(url);
          postProcessGoogleNewsItems(items);

          const result = await db.execute({
            sql: `INSERT INTO media_sources (source_type, name, url, category, last_fetched, config)
                  VALUES ('google_news', ?, ?, ?, datetime('now'), ?)`,
            args: [`Google News: ${query}`, url, category || null, JSON.stringify({ query })],
          });

          const sourceId = result.lastInsertRowid;
          for (const item of items.slice(0, 100)) {
            const guid = item.guid || item.link || item.title;
            if (!guid) continue;
            try {
              await db.execute({
                sql: `INSERT OR IGNORE INTO media_articles
                      (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                       content_fetch_status, ai_analysis_status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                args: [sourceId, guid, item.link || null, item.title, item.author || null,
                       item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null,
                       item.image || null],
              });
            } catch {}
          }
        } catch (err) {
          return res.redirect(`/dashboard/media?tab=sources&error=${encodeURIComponent(err.message)}`);
        }
        return res.redirect("/dashboard/media?tab=sources");
      }

      if (action === "add_youtube") {
        const ytChannel = (req.body.youtube_channel || "").trim();
        const category = (req.body.category || "").trim();
        if (!ytChannel) return res.redirect("/dashboard/media?tab=sources&error=Channel+required");

        try {
          const { fetchAndParseFeed, extractYoutubeChannelId, buildYoutubeRssUrl } = await importBundleModule("feed-fetcher.js");
          const channelId = await extractYoutubeChannelId(ytChannel);
          const url = buildYoutubeRssUrl(channelId);
          const { feed, items } = await fetchAndParseFeed(url);

          const result = await db.execute({
            sql: `INSERT INTO media_sources (source_type, name, url, category, last_fetched, config)
                  VALUES ('youtube', ?, ?, ?, datetime('now'), ?)`,
            args: [feed.title || ytChannel, url, category || null, JSON.stringify({ channel_id: channelId, channel_url: ytChannel })],
          });

          const sourceId = result.lastInsertRowid;
          for (const item of items.slice(0, 100)) {
            const guid = item.guid || item.link || item.title;
            if (!guid) continue;
            try {
              await db.execute({
                sql: `INSERT OR IGNORE INTO media_articles
                      (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                       content_fetch_status, ai_analysis_status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                args: [sourceId, guid, item.link || null, item.title, item.author || null,
                       item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null,
                       item.image || null],
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
            const { rows } = await db.execute({ sql: "SELECT url, source_type FROM media_sources WHERE id = ?", args: [id] });
            if (rows[0]) {
              const { fetchAndParseFeed, postProcessGoogleNewsItems } = await importBundleModule("feed-fetcher.js");
              let { items } = await fetchAndParseFeed(rows[0].url);
              if (rows[0].source_type === "google_news") postProcessGoogleNewsItems(items);
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
                          (source_id, guid, url, title, author, pub_date, content_raw, summary, image_url,
                           content_fetch_status, ai_analysis_status, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', datetime('now'))`,
                    args: [id, guid, item.link || null, item.title, item.author || null,
                           item.pub_date || null, item.content || null, item.summary?.slice(0, 2000) || null,
                           item.image || null],
                  });
                } catch {}
              }
            }
          } catch {}
        }
        return res.redirect("/dashboard/media?tab=sources");
      }

      if (action === "create_playlist") {
        const plName = (req.body.playlist_name || "").trim();
        if (plName) {
          await db.execute({ sql: "INSERT INTO media_playlists (name) VALUES (?)", args: [plName] });
        }
        return res.redirect("/dashboard/media?tab=playlists");
      }

      if (action === "delete_playlist") {
        const id = parseInt(req.body.playlist_id, 10);
        if (id) await db.execute({ sql: "DELETE FROM media_playlists WHERE id = ?", args: [id] });
        return res.redirect("/dashboard/media?tab=playlists");
      }

      if (action === "create_smart_folder") {
        const folderName = (req.body.folder_name || "").trim();
        if (folderName) {
          const queryObj = {};
          if (req.body.folder_category) queryObj.category = req.body.folder_category.trim();
          if (req.body.folder_fts_query) queryObj.fts_query = req.body.folder_fts_query.trim();
          if (req.body.folder_unread_only === "true") queryObj.unread_only = true;
          await db.execute({
            sql: "INSERT INTO media_smart_folders (name, query_json) VALUES (?, ?)",
            args: [folderName, JSON.stringify(queryObj)],
          });
        }
        return res.redirect("/dashboard/media?tab=folders");
      }

      if (action === "delete_smart_folder") {
        const id = parseInt(req.body.folder_id, 10);
        if (id) await db.execute({ sql: "DELETE FROM media_smart_folders WHERE id = ?", args: [id] });
        return res.redirect("/dashboard/media?tab=folders");
      }

      if (action === "save_digest_settings") {
        const email = (req.body.digest_email || "").trim();
        const schedule = req.body.digest_schedule || "daily_morning";
        const enabled = req.body.digest_enabled === "1" ? 1 : 0;

        const { rows } = await db.execute("SELECT id FROM media_digest_preferences LIMIT 1");
        if (rows.length > 0) {
          await db.execute({
            sql: "UPDATE media_digest_preferences SET email = ?, schedule = ?, enabled = ? WHERE id = ?",
            args: [email || null, schedule, enabled, rows[0].id],
          });
        } else {
          await db.execute({
            sql: "INSERT INTO media_digest_preferences (email, schedule, enabled) VALUES (?, ?, ?)",
            args: [email || null, schedule, enabled],
          });
        }
        return res.redirect("/dashboard/media?tab=folders");
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
        const returnTab = req.body.return_tab || "feed";
        return res.redirect(`/dashboard/media?tab=${returnTab}`);
      }
    }

    // --- GET: Parse query params ---
    const tab = req.query.tab || "feed";
    const searchQuery = req.query.q || "";
    const filterCategory = req.query.category || "";
    const filterSource = req.query.source_id || "";
    const filterUnread = req.query.unread_only === "true";
    const filterStarred = req.query.starred_only === "true";
    const pageOffset = parseInt(req.query.offset || "0", 10);
    const currentParams = { tab, q: searchQuery, category: filterCategory, source_id: filterSource, unread_only: filterUnread ? "true" : "", starred_only: filterStarred ? "true" : "" };

    const errorMsg = req.query.error
      ? `<div class="alert alert-error" style="margin-bottom:1rem">${escapeHtml(req.query.error)}</div>`
      : "";

    // --- Tab navigation ---
    const tabs = [
      { id: "feed", label: "Feed" },
      { id: "foryou", label: "For You" },
      { id: "playlists", label: "Playlists" },
      { id: "briefings", label: "Briefings" },
      { id: "podcasts", label: "Podcasts" },
      { id: "folders", label: "Folders" },
      { id: "sources", label: "Sources" },
    ];
    const tabNav = `<div style="display:flex;gap:0.5rem;margin-bottom:1rem;border-bottom:1px solid var(--crow-border);padding-bottom:0.5rem">
      ${tabs.map((t) => `<a href="/dashboard/media?tab=${t.id}" style="padding:0.4rem 0.75rem;border-radius:4px;text-decoration:none;font-size:0.85rem;${tab === t.id ? "background:var(--crow-accent);color:white" : "color:var(--crow-text-secondary)"}">${t.label}</a>`).join("")}
    </div>`;

    // --- Grid CSS (injected once) ---
    const gridCss = `<style>
      .media-grid { display:grid; grid-template-columns:1fr; gap:1rem; }
      @media(min-width:640px) { .media-grid { grid-template-columns:repeat(2,1fr); } }
      @media(min-width:1024px) { .media-grid { grid-template-columns:repeat(3,1fr); } }
      .media-card:hover { border-color:var(--crow-accent) !important; }
      .media-toolbar { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; align-items:end; }
      .media-toolbar input, .media-toolbar select { padding:0.4rem 0.5rem; background:var(--crow-bg-deep); border:1px solid var(--crow-border); border-radius:4px; color:var(--crow-text); font-size:0.8rem; }
      .media-toolbar select { min-width:100px; }
      .filter-btn { padding:0.35rem 0.6rem; border-radius:4px; font-size:0.75rem; text-decoration:none; border:1px solid var(--crow-border); }
      .filter-btn.active { background:var(--crow-accent); color:white; border-color:var(--crow-accent); }
      .filter-btn:not(.active) { color:var(--crow-text-secondary); }
    </style>`;

    let tabContent = "";

    if (tab === "feed" || tab === "foryou") {
      const isForyou = tab === "foryou";
      const returnTab = tab;

      // --- Filter toolbar ---
      const { rows: categoriesRows } = await db.execute("SELECT DISTINCT category FROM media_sources WHERE category IS NOT NULL AND category != '' ORDER BY category");
      const { rows: sourcesRows } = await db.execute("SELECT id, name FROM media_sources WHERE enabled = 1 ORDER BY name");

      const categoryOptions = categoriesRows.map(r =>
        `<option value="${escapeHtml(r.category)}" ${filterCategory === r.category ? "selected" : ""}>${escapeHtml(r.category)}</option>`
      ).join("");
      const sourceOptions = sourcesRows.map(r =>
        `<option value="${r.id}" ${filterSource == r.id ? "selected" : ""}>${escapeHtml(r.name)}</option>`
      ).join("");

      const toolbar = `<form method="GET" class="media-toolbar">
        <input type="hidden" name="tab" value="${tab}">
        <div style="flex:2;min-width:150px">
          <input type="search" name="q" value="${escapeHtml(searchQuery)}" placeholder="Search articles..." style="width:100%;box-sizing:border-box">
        </div>
        <select name="category"><option value="">All categories</option>${categoryOptions}</select>
        <select name="source_id"><option value="">All sources</option>${sourceOptions}</select>
        <button type="submit" class="btn btn-sm btn-primary">Filter</button>
      </form>
      <div style="display:flex;gap:0.35rem;margin-bottom:1rem">
        <a href="/dashboard/media?tab=${tab}" class="filter-btn ${!filterUnread && !filterStarred ? "active" : ""}">All</a>
        <a href="/dashboard/media${buildQs(currentParams, { unread_only: filterUnread ? "" : "true", starred_only: "" })}" class="filter-btn ${filterUnread ? "active" : ""}">Unread</a>
        <a href="/dashboard/media${buildQs(currentParams, { starred_only: filterStarred ? "" : "true", unread_only: "" })}" class="filter-btn ${filterStarred ? "active" : ""}">Starred</a>
      </div>`;

      // --- Build query ---
      let articles;

      if (searchQuery) {
        // FTS search
        const { sanitizeFtsQuery } = await import(pathToFileURL(dbModulePath).href);
        const safeQ = sanitizeFtsQuery(searchQuery);
        if (safeQ) {
          let sql = `SELECT a.id, a.title, a.author, a.pub_date, a.url, a.summary, a.image_url,
                            a.topics, a.estimated_read_time, a.audio_url,
                            s.name as source_name, s.category as source_category, s.source_type,
                            COALESCE(st.is_read, 0) as is_read,
                            COALESCE(st.is_starred, 0) as is_starred
                     FROM media_articles a
                     JOIN media_articles_fts fts ON a.id = fts.rowid
                     JOIN media_sources s ON s.id = a.source_id
                     LEFT JOIN media_article_states st ON st.article_id = a.id
                     WHERE fts.media_articles_fts MATCH ?`;
          const args = [safeQ];
          if (filterCategory) { sql += " AND s.category = ?"; args.push(filterCategory); }
          if (filterSource) { sql += " AND a.source_id = ?"; args.push(parseInt(filterSource, 10)); }
          if (filterUnread) sql += " AND COALESCE(st.is_read, 0) = 0";
          if (filterStarred) sql += " AND COALESCE(st.is_starred, 0) = 1";
          sql += ` ORDER BY rank LIMIT ${ARTICLES_PER_PAGE} OFFSET ${pageOffset}`;
          const result = await db.execute({ sql, args });
          articles = result.rows;
        } else {
          articles = [];
        }
      } else if (isForyou) {
        // For You — scored query
        try {
          const { buildScoredFeedSql } = await importBundleModule("scorer.js");
          const scored = buildScoredFeedSql({
            limit: ARTICLES_PER_PAGE, offset: pageOffset,
            category: filterCategory || undefined,
            sourceId: filterSource ? parseInt(filterSource, 10) : undefined,
            unreadOnly: filterUnread,
            starredOnly: filterStarred,
          });
          const result = await db.execute({ sql: scored.sql, args: scored.args });
          articles = result.rows;
        } catch {
          // Fallback to chronological
          articles = (await buildChronologicalQuery(db, { filterCategory, filterSource, filterUnread, filterStarred, pageOffset })).rows;
        }
      } else {
        // Chronological feed
        const result = await buildChronologicalQuery(db, { filterCategory, filterSource, filterUnread, filterStarred, pageOffset });
        articles = result.rows;
      }

      // --- Render cards ---
      let cardsHtml;
      if (articles.length === 0) {
        cardsHtml = `<div style="text-align:center;padding:2rem;color:var(--crow-text-muted)">
          <h3 style="font-family:'Fraunces',serif">${searchQuery ? "No results" : "No articles yet"}</h3>
          <p>${searchQuery ? `No articles found matching "${escapeHtml(searchQuery)}"` : "Add some RSS feeds in the Sources tab to get started."}</p>
        </div>`;
      } else {
        cardsHtml = `<div class="media-grid">${articles.map(a => renderArticleCard(a, returnTab)).join("\n")}</div>`;
      }

      // --- Pagination ---
      let paginationHtml = "";
      if (articles.length >= ARTICLES_PER_PAGE) {
        const nextOffset = pageOffset + ARTICLES_PER_PAGE;
        paginationHtml = `<div style="text-align:center;margin-top:1.5rem">
          <a href="/dashboard/media${buildQs(currentParams, { offset: String(nextOffset) })}" class="btn btn-secondary" style="text-decoration:none">Load more</a>
        </div>`;
      }
      if (pageOffset > 0) {
        const prevOffset = Math.max(0, pageOffset - ARTICLES_PER_PAGE);
        paginationHtml = `<div style="display:flex;justify-content:center;gap:0.5rem;margin-top:1.5rem">
          <a href="/dashboard/media${buildQs(currentParams, { offset: prevOffset > 0 ? String(prevOffset) : "" })}" class="btn btn-secondary" style="text-decoration:none">Previous</a>
          ${articles.length >= ARTICLES_PER_PAGE ? `<a href="/dashboard/media${buildQs(currentParams, { offset: String(pageOffset + ARTICLES_PER_PAGE) })}" class="btn btn-secondary" style="text-decoration:none">Next</a>` : ""}
        </div>`;
      }

      tabContent = toolbar + cardsHtml + paginationHtml;

    } else if (tab === "sources") {
      // --- Source management ---
      const addRssForm = `
        <div class="card" style="padding:1rem;margin-bottom:1rem">
          <h4 style="margin:0 0 0.75rem;font-family:'Fraunces',serif;font-size:0.95rem">Add RSS Feed</h4>
          <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
            <input type="hidden" name="action" value="add_source">
            <div style="flex:2;min-width:200px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Feed URL</label>
              <input type="url" name="url" placeholder="https://example.com/feed.xml" required
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <div style="flex:1;min-width:100px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Name</label>
              <input type="text" name="name" placeholder="Auto-detect"
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <div style="flex:1;min-width:80px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Category</label>
              <input type="text" name="category" placeholder="e.g. tech"
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <button type="submit" class="btn btn-primary">Add</button>
          </form>
        </div>`;

      const addGoogleNewsForm = `
        <div class="card" style="padding:1rem;margin-bottom:1rem">
          <h4 style="margin:0 0 0.75rem;font-family:'Fraunces',serif;font-size:0.95rem">Add Google News Search</h4>
          <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
            <input type="hidden" name="action" value="add_google_news">
            <div style="flex:2;min-width:200px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Search Query</label>
              <input type="text" name="query" placeholder="e.g. artificial intelligence" required
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <div style="flex:1;min-width:80px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Category</label>
              <input type="text" name="category" placeholder="e.g. ai"
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <button type="submit" class="btn btn-primary">Add</button>
          </form>
        </div>`;

      const { rows: sources } = await db.execute("SELECT * FROM media_sources ORDER BY name ASC");

      let sourcesList;
      if (sources.length === 0) {
        sourcesList = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No sources yet. Add an RSS feed or Google News search above.</p>`;
      } else {
        sourcesList = `<div style="display:flex;flex-direction:column;gap:0.5rem">${sources.map((s) => {
          const config = s.config ? JSON.parse(s.config) : {};
          const img = config.image
            ? `<img src="${escapeHtml(config.image)}" alt="" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0">`
            : `<div style="width:40px;height:40px;border-radius:6px;background:var(--crow-accent-muted);display:flex;align-items:center;justify-content:center;color:var(--crow-accent);font-family:'Fraunces',serif;font-size:1rem;flex-shrink:0">${escapeHtml((s.name || "?").charAt(0))}</div>`;

          const typeBadge = { google_news: badge("Google News", "draft"), youtube: badge("YouTube", "published"), podcast: badge("Podcast", "connected") }[s.source_type] || badge("RSS", "draft");
          const statusBadge = s.last_error ? badge("Error", "error") : badge("Active", "connected");
          const lastFetched = s.last_fetched ? formatDate(s.last_fetched) : "Never";
          const cat = s.category ? ` \u00b7 ${escapeHtml(s.category)}` : "";

          return `<div class="card" style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem">
            ${img}
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name || s.url)}</div>
              <div style="font-size:0.8rem;color:var(--crow-text-muted)">Last fetched: ${escapeHtml(lastFetched)}${cat} ${typeBadge} ${statusBadge}</div>
            </div>
            <div style="display:flex;gap:0.25rem">
              <form method="POST" style="display:inline"><input type="hidden" name="action" value="refresh_source"><input type="hidden" name="source_id" value="${s.id}"><button type="submit" class="btn btn-sm btn-secondary" title="Refresh">\u21bb</button></form>
              <form method="POST" style="display:inline" onsubmit="return confirm('Remove this source and all its articles?')"><input type="hidden" name="action" value="remove_source"><input type="hidden" name="source_id" value="${s.id}"><button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)" title="Remove">\u2715</button></form>
            </div>
          </div>`;
        }).join("\n")}</div>`;
      }

      const addYoutubeForm = `
        <div class="card" style="padding:1rem;margin-bottom:1rem">
          <h4 style="margin:0 0 0.75rem;font-family:'Fraunces',serif;font-size:0.95rem">Add YouTube Channel</h4>
          <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
            <input type="hidden" name="action" value="add_youtube">
            <div style="flex:2;min-width:200px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Channel URL or ID</label>
              <input type="text" name="youtube_channel" placeholder="@mkbhd or UCBcRF18a7Qf58cCRy5xuWwQ" required
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <div style="flex:1;min-width:80px">
              <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Category</label>
              <input type="text" name="category" placeholder="e.g. tech"
                     style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
            </div>
            <button type="submit" class="btn btn-primary">Add YouTube</button>
          </form>
        </div>`;

      // --- Stats (clickable, Sources tab only) ---
      const [sourcesCount, articlesCount, unreadCount, starredCount] = await Promise.all([
        db.execute("SELECT COUNT(*) as c FROM media_sources WHERE enabled = 1"),
        db.execute("SELECT COUNT(*) as c FROM media_articles"),
        db.execute("SELECT COUNT(*) as c FROM media_articles a LEFT JOIN media_article_states st ON st.article_id = a.id WHERE COALESCE(st.is_read, 0) = 0"),
        db.execute("SELECT COUNT(*) as c FROM media_article_states WHERE is_starred = 1"),
      ]);
      const statsHtml = `<div class="card-grid" style="margin-bottom:1.5rem">
        ${statCard("Sources", String(sourcesCount.rows[0]?.c || 0), { delay: 0 })}
        ${statCard("Articles", String(articlesCount.rows[0]?.c || 0), { delay: 50 })}
        <a href="/dashboard/media?tab=feed&unread_only=true" style="text-decoration:none">${statCard("Unread", String(unreadCount.rows[0]?.c || 0), { delay: 100 })}</a>
        <a href="/dashboard/media?tab=feed&starred_only=true" style="text-decoration:none">${statCard("Starred", String(starredCount.rows[0]?.c || 0), { delay: 150 })}</a>
      </div>`;

      tabContent = statsHtml + addRssForm + addGoogleNewsForm + addYoutubeForm + sourcesList;
    }

    // --- Playlists tab ---
    if (tab === "playlists") {
      const { rows: playlists } = await db.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM media_playlist_items pi WHERE pi.playlist_id = p.id) as item_count FROM media_playlists p ORDER BY p.updated_at DESC"
      );

      const createForm = `<div class="card" style="padding:1rem;margin-bottom:1rem">
        <h4 style="margin:0 0 0.75rem;font-family:'Fraunces',serif;font-size:0.95rem">Create Playlist</h4>
        <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
          <input type="hidden" name="action" value="create_playlist">
          <div style="flex:2;min-width:200px">
            <input type="text" name="playlist_name" placeholder="Playlist name" required
                   style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
          </div>
          <button type="submit" class="btn btn-primary">Create</button>
        </form>
      </div>`;

      let listHtml;
      if (playlists.length === 0) {
        listHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No playlists yet.</p>`;
      } else {
        listHtml = `<div style="display:flex;flex-direction:column;gap:0.5rem">${playlists.map(p => {
          const autoLabel = p.auto_generated ? ' <span style="font-size:0.65rem;padding:0.1rem 0.3rem;border-radius:4px;background:var(--crow-accent-muted);color:var(--crow-accent)">auto</span>' : "";
          return `<div class="card" style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem">
            <div style="width:40px;height:40px;border-radius:6px;background:var(--crow-accent-muted);display:flex;align-items:center;justify-content:center;color:var(--crow-accent);font-size:1.2rem;flex-shrink:0">&#9835;</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500">${escapeHtml(p.name)}${autoLabel}</div>
              <div style="font-size:0.8rem;color:var(--crow-text-muted)">${p.item_count} item(s) \u00b7 ${formatDate(p.updated_at)}</div>
            </div>
            <form method="POST" style="display:inline" onsubmit="return confirm('Delete this playlist?')">
              <input type="hidden" name="action" value="delete_playlist">
              <input type="hidden" name="playlist_id" value="${p.id}">
              <button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)">&#10005;</button>
            </form>
          </div>`;
        }).join("\n")}</div>`;
      }

      tabContent = createForm + listHtml;
    }

    // --- Briefings tab ---
    if (tab === "briefings") {
      const { rows: briefings } = await db.execute("SELECT * FROM media_briefings ORDER BY created_at DESC LIMIT 20");

      let listHtml;
      if (briefings.length === 0) {
        listHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No briefings yet. Use crow_media_briefing via AI to generate one.</p>`;
      } else {
        listHtml = `<div style="display:flex;flex-direction:column;gap:0.5rem">${briefings.map(b => {
          const articleCount = b.article_ids ? JSON.parse(b.article_ids).length : 0;
          const durationStr = b.duration_sec ? `${Math.floor(b.duration_sec / 60)}:${String(Math.round(b.duration_sec % 60)).padStart(2, "0")}` : "";
          const hasAudio = !!b.audio_path;
          return `<div class="card" style="padding:0.75rem">
            <div style="display:flex;justify-content:space-between;align-items:start;gap:0.5rem">
              <div>
                <div style="font-weight:500">${escapeHtml(b.title || "Untitled Briefing")}</div>
                <div style="font-size:0.8rem;color:var(--crow-text-muted)">${articleCount} articles${durationStr ? ` \u00b7 ${durationStr}` : ""} \u00b7 ${formatDate(b.created_at)}</div>
              </div>
              ${hasAudio ? `<button onclick="document.getElementById('briefing-audio-${b.id}').play()" class="btn btn-sm btn-primary" style="font-size:0.8rem">&#9654; Play</button>` : ""}
            </div>
            ${hasAudio ? `<audio id="briefing-audio-${b.id}" controls preload="none" style="width:100%;height:32px;margin-top:0.5rem"><source src="/api/media/briefings/${b.id}/audio" type="audio/mpeg"></audio>` : ""}
          </div>`;
        }).join("\n")}</div>`;
      }

      tabContent = listHtml;
    }

    // --- Podcasts tab ---
    if (tab === "podcasts") {
      const { rows: podcastSources } = await db.execute(
        "SELECT * FROM media_sources WHERE source_type = 'podcast' AND enabled = 1 ORDER BY name ASC"
      );

      const { rows: episodes } = await db.execute({
        sql: `SELECT a.id, a.title, a.pub_date, a.audio_url, a.url,
                     s.name as source_name, s.config,
                     COALESCE(st.is_read, 0) as is_read
              FROM media_articles a
              JOIN media_sources s ON s.id = a.source_id
              LEFT JOIN media_article_states st ON st.article_id = a.id
              WHERE a.audio_url IS NOT NULL AND s.enabled = 1
              ORDER BY a.pub_date DESC NULLS LAST LIMIT 30`,
        args: [],
      });

      const { rows: legacySubs } = await db.execute("SELECT * FROM podcast_subscriptions ORDER BY title ASC");

      let subsHtml;
      if (podcastSources.length === 0 && legacySubs.length === 0) {
        subsHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No podcast subscriptions. Add a podcast RSS feed in the Sources tab \u2014 it will be auto-detected.</p>`;
      } else {
        const allSubs = [
          ...podcastSources.map(s => ({ name: s.name, image: JSON.parse(s.config || "{}").image })),
          ...legacySubs.map(s => ({ name: s.title, image: s.image_url })),
        ];
        subsHtml = `<div style="display:flex;gap:0.75rem;overflow-x:auto;padding:0.5rem 0">${allSubs.map(s => {
          const img = s.image
            ? `<img src="${escapeHtml(s.image)}" alt="" style="width:60px;height:60px;border-radius:8px;object-fit:cover">`
            : `<div style="width:60px;height:60px;border-radius:8px;background:var(--crow-accent-muted);display:flex;align-items:center;justify-content:center;color:var(--crow-accent);font-size:1.5rem">&#127911;</div>`;
          return `<div style="text-align:center;flex-shrink:0;width:80px">${img}<div style="font-size:0.7rem;margin-top:0.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.name)}</div></div>`;
        }).join("")}</div>`;
      }

      let episodesHtml;
      if (episodes.length === 0) {
        episodesHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No podcast episodes yet.</p>`;
      } else {
        episodesHtml = episodes.map(ep => {
          const pubDate = ep.pub_date ? formatDate(ep.pub_date) : "";
          return `<div class="card" style="padding:0.75rem;margin-bottom:0.5rem">
            <div style="font-weight:500">${escapeHtml(ep.title)}</div>
            <div style="font-size:0.8rem;color:var(--crow-text-muted)">${escapeHtml(ep.source_name)} \u00b7 ${escapeHtml(pubDate)}</div>
            <audio controls preload="none" style="width:100%;height:32px;margin-top:0.5rem"><source src="${escapeHtml(ep.audio_url)}" type="audio/mpeg"></audio>
          </div>`;
        }).join("\n");
      }

      tabContent = `<h4 style="font-family:'Fraunces',serif;font-size:0.95rem;margin:0 0 0.5rem">Subscriptions</h4>${subsHtml}
        <h4 style="font-family:'Fraunces',serif;font-size:0.95rem;margin:1rem 0 0.5rem">Recent Episodes</h4>${episodesHtml}`;
    }

    // --- Folders tab ---
    if (tab === "folders") {
      const { rows: folders } = await db.execute("SELECT * FROM media_smart_folders ORDER BY name ASC");

      const createForm = `<div class="card" style="padding:1rem;margin-bottom:1rem">
        <h4 style="margin:0 0 0.75rem;font-family:'Fraunces',serif;font-size:0.95rem">Create Smart Folder</h4>
        <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
          <input type="hidden" name="action" value="create_smart_folder">
          <div style="flex:2;min-width:150px">
            <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Name</label>
            <input type="text" name="folder_name" placeholder="e.g. Tech News" required
                   style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
          </div>
          <div style="flex:1;min-width:100px">
            <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Category filter</label>
            <input type="text" name="folder_category" placeholder="e.g. tech"
                   style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
          </div>
          <div style="flex:1;min-width:100px">
            <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Search query</label>
            <input type="text" name="folder_fts_query" placeholder="Optional"
                   style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
          </div>
          <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.8rem;color:var(--crow-text-secondary)">
            <input type="checkbox" name="folder_unread_only" value="true"> Unread only
          </label>
          <button type="submit" class="btn btn-primary">Create</button>
        </form>
      </div>`;

      let listHtml;
      if (folders.length === 0) {
        listHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No smart folders yet.</p>`;
      } else {
        const folderCards = [];
        for (const f of folders) {
          const q = JSON.parse(f.query_json || "{}");
          let countSql = "SELECT COUNT(*) as c FROM media_articles a JOIN media_sources s ON s.id = a.source_id LEFT JOIN media_article_states st ON st.article_id = a.id WHERE s.enabled = 1";
          const countArgs = [];
          if (q.category) { countSql += " AND s.category = ?"; countArgs.push(q.category); }
          if (q.unread_only) countSql += " AND COALESCE(st.is_read, 0) = 0";
          const { rows: countRows } = await db.execute({ sql: countSql, args: countArgs });
          const count = countRows[0]?.c || 0;
          const filters = [];
          if (q.category) filters.push(q.category);
          if (q.fts_query) filters.push(`"${q.fts_query}"`);
          if (q.unread_only) filters.push("unread");

          folderCards.push(`<div class="card" style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem">
            <div style="width:40px;height:40px;border-radius:6px;background:var(--crow-accent-muted);display:flex;align-items:center;justify-content:center;color:var(--crow-accent);font-size:1.2rem;flex-shrink:0">&#128193;</div>
            <a href="/dashboard/media?tab=feed&${q.category ? `category=${encodeURIComponent(q.category)}&` : ""}${q.unread_only ? "unread_only=true&" : ""}" style="flex:1;text-decoration:none;color:inherit">
              <div style="font-weight:500">${escapeHtml(f.name)}</div>
              <div style="font-size:0.8rem;color:var(--crow-text-muted)">${filters.join(" \u00b7 ") || "all"} \u00b7 ${count} article(s)</div>
            </a>
            <form method="POST" style="display:inline" onsubmit="return confirm('Delete this folder?')">
              <input type="hidden" name="action" value="delete_smart_folder">
              <input type="hidden" name="folder_id" value="${f.id}">
              <button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)">&#10005;</button>
            </form>
          </div>`);
        }
        listHtml = `<div style="display:flex;flex-direction:column;gap:0.5rem">${folderCards.join("\n")}</div>`;
      }

      // Digest settings
      const { rows: digestRows } = await db.execute("SELECT * FROM media_digest_preferences LIMIT 1");
      const digest = digestRows[0] || {};
      const digestForm = `<div class="card" style="padding:1rem;margin-top:1.5rem">
        <h4 style="margin:0 0 0.75rem;font-family:'Fraunces',serif;font-size:0.95rem">Email Digest Settings</h4>
        <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
          <input type="hidden" name="action" value="save_digest_settings">
          <div style="flex:1;min-width:150px">
            <label style="display:block;font-size:0.75rem;color:var(--crow-text-muted);margin-bottom:4px">Email</label>
            <input type="email" name="digest_email" value="${escapeHtml(digest.email || "")}" placeholder="your@email.com"
                   style="width:100%;padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem;box-sizing:border-box">
          </div>
          <select name="digest_schedule" style="padding:0.45rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.8rem">
            <option value="daily_morning" ${digest.schedule === "daily_morning" ? "selected" : ""}>Daily (morning)</option>
            <option value="daily_evening" ${digest.schedule === "daily_evening" ? "selected" : ""}>Daily (evening)</option>
            <option value="weekly" ${digest.schedule === "weekly" ? "selected" : ""}>Weekly (Monday)</option>
          </select>
          <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.8rem;color:var(--crow-text-secondary)">
            <input type="checkbox" name="digest_enabled" value="1" ${digest.enabled ? "checked" : ""}> Enabled
          </label>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
        <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0.5rem 0 0">Requires SMTP configuration and nodemailer. See .env.example.</p>
      </div>`;

      tabContent = createForm + listHtml + digestForm;
    }

    // Persistent audio player bar
    const playerBar = `<div id="crow-player-bar" style="display:none;position:fixed;bottom:0;left:0;right:0;background:var(--crow-bg-surface);border-top:2px solid var(--crow-accent);padding:0.5rem 1rem;z-index:1000;align-items:center;gap:0.75rem">
      <button onclick="window.crowPlayer.toggle()" id="crow-play-btn" style="background:var(--crow-accent);color:white;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center">&#9654;</button>
      <div style="flex:1;min-width:0">
        <div id="crow-player-title" style="font-size:0.8rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        <audio id="crow-audio" preload="none" style="width:100%;height:28px;margin-top:2px" controls></audio>
      </div>
      <button onclick="window.crowPlayer.close()" style="background:none;border:none;color:var(--crow-text-muted);cursor:pointer;font-size:1.2rem">&times;</button>
    </div>
    <script>
      window.crowPlayer = {
        load: function(src, title) {
          var bar = document.getElementById('crow-player-bar');
          var audio = document.getElementById('crow-audio');
          var titleEl = document.getElementById('crow-player-title');
          bar.style.display = 'flex';
          titleEl.textContent = title || 'Playing...';
          audio.src = src;
          audio.play().catch(function() {});
        },
        toggle: function() {
          var audio = document.getElementById('crow-audio');
          if (audio.paused) audio.play(); else audio.pause();
        },
        close: function() {
          var audio = document.getElementById('crow-audio');
          audio.pause(); audio.src = '';
          document.getElementById('crow-player-bar').style.display = 'none';
        }
      };
    </script>`;

    const content = `
      ${errorMsg}
      ${gridCss}
      ${tabNav}
      ${tabContent}
      ${playerBar}
    `;

    return layout({ title: "Media", content });
  },
};
