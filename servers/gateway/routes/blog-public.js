/**
 * Public Blog Routes
 *
 * GET /blog              — Index page (published public posts)
 * GET /blog/:slug        — Individual post
 * GET /blog/tag/:tag     — Posts filtered by tag
 * GET /blog/feed.xml     — RSS 2.0
 * GET /blog/feed.atom    — Atom
 * GET /blog/podcast.xml  — iTunes-compatible podcast RSS
 * GET /blog/registry.json — Registry metadata (gated by blog_listed setting)
 * GET /blog/discover.json — Lightweight discovery payload (always available)
 */

import { Router } from "express";
import { createDbClient, escapeLikePattern } from "../../db.js";
import { renderMarkdown } from "../../blog/renderer.js";
import { isChordPro } from "../../blog/chordpro.js";
import { generateRss, generateAtom } from "../../blog/rss.js";
import { generatePodcastFeed } from "../../blog/podcast-rss.js";
import { FONT_IMPORT, designTokensCss } from "../dashboard/shared/design-tokens.js";
import { isAvailable, getObject } from "../../storage/s3-client.js";

// Slugs under /blog/* that other routers (or earlier routes in this
// router) handle. Guards /blog/:slug from swallowing them if the mount
// order is ever perturbed by a refactor.
const RESERVED_BLOG_SLUGS = new Set([
  "api",
  "figures",
  "feed.xml",
  "feed.atom",
  "podcast.xml",
  "sitemap.xml",
  "research",
]);

/**
 * Derive site URL from request (respects X-Forwarded-Host when behind proxy).
 * Falls back to CROW_GATEWAY_URL env var, then localhost.
 */
function getSiteUrl(req) {
  const forwardedHost = req.get('X-Forwarded-Host');
  if (forwardedHost) {
    const proto = req.get('X-Forwarded-Proto') || req.protocol;
    return `${proto}://${forwardedHost}`;
  }
  return process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
}

/**
 * Get blog settings from dashboard_settings table.
 */
export async function getBlogSettings(db) {
  const result = await db.execute({
    sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
    args: [],
  });
  const s = {};
  for (const r of result.rows) s[r.key.replace("blog_", "")] = r.value;
  return {
    title: s.title || "Crow Blog",
    tagline: s.tagline || "",
    author: s.author || "",
    theme: s.theme || "dark",
    customCss: s.custom_css || "",
    podcastCategory: s.podcast_category || "Society & Culture",
    podcastType: s.podcast_type || "episodic",
    podcastOwnerEmail: s.podcast_owner_email || "",
    podcastCoverUrl: s.podcast_cover_url || "",
    podcastLanguage: s.podcast_language || "en",
    songbookOnIndex: s.songbook_on_index !== "false",
    themeMode: s.theme_mode || "dark",
    themeGlass: s.theme_glass === "true",
    themeSerif: s.theme_serif !== "false",
    themeBlogMode: s.theme_blog_mode || "",
    themeDashboardMode: s.theme_dashboard_mode || "",
  };
}

/**
 * Dark Editorial design system CSS.
 */
function designCss(settings) {
  return `
<style>
  ${FONT_IMPORT}

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  ${designTokensCss()}

  body {
    font-family: var(--crow-body-font, 'DM Sans', sans-serif);
    background: var(--crow-bg-deep);
    color: var(--crow-text-primary);
    line-height: 1.7;
    min-height: 100vh;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  }

  a { color: var(--crow-accent); text-decoration: none; transition: color 0.2s; }
  a:hover { color: var(--crow-accent-hover); }

  .blog-header {
    max-width: 680px;
    margin: 0 auto;
    padding: 3rem 1.5rem 2rem;
    border-bottom: 1px solid var(--crow-border);
    margin-bottom: 2rem;
  }
  .blog-header h1 {
    font-family: 'Fraunces', serif;
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .blog-header h1 a { color: var(--crow-text-primary); }
  .blog-header p {
    color: var(--crow-text-secondary);
    margin-top: 0.25rem;
    font-size: 0.95rem;
  }
  .blog-header nav {
    margin-top: 0.75rem;
    font-size: 0.85rem;
    color: var(--crow-text-muted);
  }
  .blog-header nav a { margin-right: 1rem; }

  .blog-content {
    max-width: 680px;
    margin: 0 auto;
    padding: 0 1.5rem 4rem;
  }

  /* Index — magazine card grid */
  .post-grid {
    display: grid;
    gap: 1.5rem;
  }
  .post-card {
    background: var(--crow-bg-surface);
    border: 1px solid var(--crow-border);
    border-radius: 12px;
    padding: 1.5rem;
    transition: transform 0.2s ease-out, box-shadow 0.2s;
    animation: fadeInUp 0.4s ease-out both;
  }
  .post-card:hover {
    transform: scale(1.01);
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  }
  .post-card h2 {
    font-family: 'Fraunces', serif;
    font-size: 1.35rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    line-height: 1.3;
  }
  .post-card h2 a { color: var(--crow-text-primary); }
  .post-card h2 a:hover { color: var(--crow-accent); }
  .post-card .meta {
    font-size: 0.8rem;
    color: var(--crow-text-muted);
    font-family: 'JetBrains Mono', monospace;
    margin-bottom: 0.75rem;
  }
  .post-card .meta .date { color: var(--crow-accent); }
  .post-card .excerpt {
    color: var(--crow-text-secondary);
    font-size: 0.95rem;
    line-height: 1.6;
  }
  .post-card .tags { margin-top: 0.75rem; }
  .post-card .tags a {
    font-size: 0.75rem;
    color: var(--crow-accent);
    background: var(--crow-accent-muted);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    margin-right: 0.35rem;
  }

  /* Single post */
  .post-single h1 {
    font-family: 'Fraunces', serif;
    font-size: 2.25rem;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.02em;
    margin-bottom: 0.75rem;
  }
  .post-single .meta {
    font-size: 0.85rem;
    color: var(--crow-text-muted);
    font-family: 'JetBrains Mono', monospace;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--crow-border);
  }
  .post-single .meta .date { color: var(--crow-accent); }
  .post-single .body { font-size: 1.05rem; }
  .post-single .body h1, .post-single .body h2, .post-single .body h3,
  .post-single .body h4, .post-single .body h5, .post-single .body h6 {
    font-family: 'Fraunces', serif;
    margin-top: 2rem;
    margin-bottom: 0.75rem;
  }
  .post-single .body h2 { font-size: 1.5rem; border-bottom: 1px solid var(--crow-border); padding-bottom: 0.35rem; }
  .post-single .body h3 { font-size: 1.25rem; }
  .post-single .body p { margin-bottom: 1.25rem; }
  .post-single .body ul, .post-single .body ol { margin-bottom: 1.25rem; padding-left: 1.5rem; }
  .post-single .body li { margin-bottom: 0.35rem; }
  .post-single .body blockquote {
    border-left: 3px solid var(--crow-accent);
    padding-left: 1rem;
    color: var(--crow-text-secondary);
    margin: 1.25rem 0;
    font-style: italic;
  }
  .post-single .body pre {
    background: var(--crow-bg-elevated);
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 1rem;
    overflow-x: auto;
    margin: 1.25rem 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
  }
  .post-single .body code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9em;
    background: var(--crow-bg-elevated);
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
  }
  .post-single .body pre code { background: none; padding: 0; }
  .post-single .body img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    margin: 1.25rem 0;
  }
  .post-single .body table {
    width: 100%;
    border-collapse: collapse;
    margin: 1.25rem 0;
  }
  .post-single .body th, .post-single .body td {
    border: 1px solid var(--crow-border);
    padding: 0.5rem 0.75rem;
    text-align: left;
  }
  .post-single .body th { background: var(--crow-bg-elevated); font-weight: 600; }

  .post-footer {
    margin-top: 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--crow-border);
    color: var(--crow-text-muted);
    font-size: 0.85rem;
  }

  .empty-state {
    text-align: center;
    padding: 4rem 1rem;
    color: var(--crow-text-muted);
  }
  .empty-state h2 { font-family: 'Fraunces', serif; font-size: 1.5rem; margin-bottom: 0.5rem; color: var(--crow-text-secondary); }

  .pagination {
    margin-top: 2rem;
    text-align: center;
    font-size: 0.9rem;
  }
  .pagination a {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    margin: 0 0.25rem;
  }

  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Glass overrides for blog */
  .theme-glass .blog-header {
    backdrop-filter: var(--crow-glass-blur-heavy);
    -webkit-backdrop-filter: var(--crow-glass-blur-heavy);
    background: rgba(0,0,0,0.72);
    position: sticky;
    top: 0;
    z-index: 100;
    border-bottom: 0.5px solid var(--crow-border);
  }
  .theme-glass.theme-light .blog-header {
    background: rgba(245,245,247,0.72);
  }
  .theme-glass .post-card {
    backdrop-filter: var(--crow-glass-blur);
    -webkit-backdrop-filter: var(--crow-glass-blur);
    border-width: 0.5px;
  }
  .theme-glass .post-card .tags a {
    border-radius: var(--crow-radius-pill);
  }

  ${settings.customCss}
</style>`;
}

/**
 * HTML page shell.
 */
export function pageShell(settings, { title, content, ogMeta }) {
  const effectiveMode = settings.themeBlogMode || settings.themeMode || "dark";
  const themeClass = [
    effectiveMode === "light" ? "theme-light" : "",
    settings.themeGlass ? "theme-glass" : "",
    settings.themeSerif ? "theme-serif" : "",
  ].filter(Boolean).join(" ");
  const og = ogMeta || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — ${escapeHtml(settings.title)}</title>
  ${og}
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(settings.title)} RSS" href="/blog/feed.xml">
  <link rel="alternate" type="application/atom+xml" title="${escapeHtml(settings.title)} Atom" href="/blog/feed.atom">
  ${designCss(settings)}
</head>
<body class="${themeClass}">
  <header class="blog-header">
    <h1><a href="/blog">${escapeHtml(settings.title)}</a></h1>
    ${settings.tagline ? `<p>${escapeHtml(settings.tagline)}</p>` : ""}
    <nav>
      <a href="/blog">Posts</a>
      <a href="/blog/research">Research</a>
      <a href="/blog/songbook">Songbook</a>
      <a href="/blog/feed.xml">RSS</a>
    </nav>
  </header>
  <main class="blog-content">
    ${content}
  </main>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return dateStr;
  }
}

/**
 * @returns {Router}
 */
export default function blogPublicRouter() {
  const router = Router();

  // POST /blog/preview — Render markdown to HTML (auth-required via dashboard auth)
  router.post("/blog/preview", async (req, res) => {
    // Only allow authenticated requests (dashboard session)
    if (!req.headers.cookie?.includes("crow_session")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const { markdown } = req.body;
    if (!markdown) {
      return res.status(400).json({ error: "Missing markdown field" });
    }
    try {
      const html = renderMarkdown(markdown);
      res.json({ html });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /blog — Index
  router.get("/blog", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const page = parseInt(req.query.page || "1", 10);
      const perPage = 10;
      const offset = (page - 1) * perPage;

      const songbookFilter = settings.songbookOnIndex ? "" : " AND (tags IS NULL OR tags NOT LIKE '%songbook%')";
      const posts = await db.execute({
        sql: `SELECT id, slug, title, excerpt, author, tags, published_at, cover_image_key FROM blog_posts WHERE status = 'published' AND visibility = 'public'${songbookFilter} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
        args: [perPage + 1, offset],
      });

      const hasMore = posts.rows.length > perPage;
      const display = posts.rows.slice(0, perPage);

      let content;
      if (display.length === 0) {
        content = `<div class="empty-state"><h2>No posts yet</h2><p>Check back soon.</p></div>`;
      } else {
        const cards = display.map((p, i) => {
          const tags = (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
          const tagsHtml = tags.length > 0
            ? `<div class="tags">${tags.map((t) => `<a href="/blog/tag/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`).join("")}</div>`
            : "";
          const coverHtml = p.cover_image_key
            ? `<img src="/blog/media/${encodeURIComponent(p.cover_image_key)}" alt="" loading="lazy" style="width:100%;height:200px;object-fit:cover;border-radius:8px 8px 0 0;margin:-1.5rem -1.5rem 1rem;width:calc(100% + 3rem)">`
            : "";
          return `<article class="post-card" style="animation-delay: ${i * 50}ms">
  ${coverHtml}
  <h2><a href="/blog/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></h2>
  <div class="meta"><span class="date">${formatDate(p.published_at)}</span>${p.author ? ` · ${escapeHtml(p.author)}` : ""}</div>
  <p class="excerpt">${escapeHtml(p.excerpt || "")}</p>
  ${tagsHtml}
</article>`;
        }).join("\n");

        let pagination = "";
        if (page > 1 || hasMore) {
          pagination = `<div class="pagination">`;
          if (page > 1) pagination += `<a href="/blog?page=${page - 1}">← Newer</a>`;
          if (hasMore) pagination += `<a href="/blog?page=${page + 1}">Older →</a>`;
          pagination += `</div>`;
        }

        content = `<div class="post-grid">${cards}</div>${pagination}`;
      }

      res.type("html").send(pageShell(settings, { title: "Posts", content }));
    } catch (err) {
      console.error("[blog] Index error:", err);
      res.status(500).send("Error loading blog");
    } finally {
      db.close();
    }
  });

  // GET /blog/feed.xml — RSS 2.0
  router.get("/blog/feed.xml", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const posts = await db.execute({
        sql: "SELECT slug, title, excerpt, author, published_at, tags FROM blog_posts WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC LIMIT 50",
        args: [],
      });
      const siteUrl = getSiteUrl(req);
      const xml = generateRss({ title: settings.title, description: settings.tagline, siteUrl, author: settings.author, posts: posts.rows });
      res.type("application/rss+xml").send(xml);
    } finally {
      db.close();
    }
  });

  // GET /blog/feed.atom — Atom
  router.get("/blog/feed.atom", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const posts = await db.execute({
        sql: "SELECT slug, title, excerpt, author, published_at, tags FROM blog_posts WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC LIMIT 50",
        args: [],
      });
      const siteUrl = getSiteUrl(req);
      const xml = generateAtom({ title: settings.title, description: settings.tagline, siteUrl, author: settings.author, posts: posts.rows });
      res.type("application/atom+xml").send(xml);
    } finally {
      db.close();
    }
  });

  // GET /blog/podcast.xml — iTunes-compatible podcast RSS feed
  router.get("/blog/podcast.xml", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const posts = await db.execute({
        sql: "SELECT slug, title, excerpt, content, author, published_at, tags, cover_image_key FROM blog_posts WHERE status = 'published' AND visibility = 'public' AND tags LIKE '%podcast%' ORDER BY published_at DESC LIMIT 200",
        args: [],
      });

      if (posts.rows.length === 0) {
        res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${escapeHtml(settings.title)}</title><description>No episodes yet.</description></channel></rss>`);
        return;
      }

      const siteUrl = getSiteUrl(req);
      const xml = await generatePodcastFeed(posts.rows, {
        title: settings.title,
        tagline: settings.tagline,
        author: settings.author,
        siteUrl,
        coverImageUrl: settings.podcastCoverUrl,
        ownerEmail: settings.podcastOwnerEmail,
        category: settings.podcastCategory,
        showType: settings.podcastType,
        language: settings.podcastLanguage,
      });
      res.type("application/xml").send(xml);
    } catch (err) {
      console.error("[blog] Podcast feed error:", err);
      res.status(500).send("Error generating podcast feed");
    } finally {
      db.close();
    }
  });

  // GET /blog/sitemap.xml — XML Sitemap
  router.get("/blog/sitemap.xml", async (req, res) => {
    const db = createDbClient();
    try {
      const posts = await db.execute({
        sql: "SELECT slug, updated_at, published_at FROM blog_posts WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC",
        args: [],
      });
      const siteUrl = getSiteUrl(req);

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
      xml += `  <url>\n    <loc>${escapeHtml(siteUrl)}/blog</loc>\n  </url>\n`;
      for (const post of posts.rows) {
        const lastmod = post.updated_at || post.published_at;
        xml += `  <url>\n`;
        xml += `    <loc>${escapeHtml(siteUrl)}/blog/${escapeHtml(post.slug)}</loc>\n`;
        if (lastmod) {
          xml += `    <lastmod>${new Date(lastmod).toISOString().split("T")[0]}</lastmod>\n`;
        }
        xml += `  </url>\n`;
      }
      xml += `</urlset>\n`;

      res.set("Cache-Control", "public, max-age=3600");
      res.type("application/xml").send(xml);
    } catch (err) {
      console.error("[blog] Sitemap error:", err);
      res.status(500).send("Error generating sitemap");
    } finally {
      db.close();
    }
  });

  // GET /blog/registry.json — Registry payload (gated by blog_listed setting)
  router.get("/blog/registry.json", async (req, res) => {
    const db = createDbClient();
    try {
      // Check if blog owner has opted into registry listing
      const listedResult = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_listed'",
        args: [],
      });
      const listed = listedResult.rows.length > 0 && listedResult.rows[0].value === "true";
      if (!listed) {
        res.status(404).json({ error: "not_listed" });
        return;
      }

      const settings = await getBlogSettings(db);
      const siteUrl = getSiteUrl(req);

      const countResult = await db.execute({
        sql: "SELECT COUNT(*) as cnt FROM blog_posts WHERE status = 'published' AND visibility = 'public'",
        args: [],
      });
      const postCount = Number(countResult.rows[0].cnt);

      const lastResult = await db.execute({
        sql: "SELECT published_at FROM blog_posts WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC LIMIT 1",
        args: [],
      });
      const lastPublished = lastResult.rows.length > 0 ? lastResult.rows[0].published_at : null;

      res.set("Cache-Control", "public, max-age=3600");
      res.json({
        title: settings.title,
        tagline: settings.tagline || null,
        author: settings.author || null,
        url: `${siteUrl}/blog`,
        post_count: postCount,
        last_published: lastPublished,
      });
    } catch (err) {
      console.error("[blog] Registry endpoint error:", err);
      res.status(500).json({ error: "internal" });
    } finally {
      db.close();
    }
  });

  // GET /blog/discover.json — Lightweight discovery payload (always available)
  router.get("/blog/discover.json", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const siteUrl = getSiteUrl(req);

      const countResult = await db.execute({
        sql: "SELECT COUNT(*) as cnt FROM blog_posts WHERE status = 'published' AND visibility = 'public'",
        args: [],
      });
      const postCount = Number(countResult.rows[0].cnt);

      res.set("Cache-Control", "public, max-age=3600");
      res.json({
        crow_blog: true,
        title: settings.title,
        rss_url: `${siteUrl}/blog/feed.xml`,
        atom_url: `${siteUrl}/blog/feed.atom`,
        post_count: postCount,
      });
    } catch (err) {
      console.error("[blog] Discover endpoint error:", err);
      res.status(500).json({ error: "internal" });
    } finally {
      db.close();
    }
  });

  // GET /blog/tag/:tag — Posts by tag
  router.get("/blog/tag/:tag", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const tag = req.params.tag;
      const escaped = escapeLikePattern(tag);

      const posts = await db.execute({
        sql: "SELECT id, slug, title, excerpt, author, tags, published_at FROM blog_posts WHERE status = 'published' AND visibility = 'public' AND tags LIKE ? ESCAPE '\\' ORDER BY published_at DESC LIMIT 50",
        args: [`%${escaped}%`],
      });

      let content;
      if (posts.rows.length === 0) {
        content = `<div class="empty-state"><h2>No posts tagged "${escapeHtml(tag)}"</h2><p><a href="/blog">← All posts</a></p></div>`;
      } else {
        const cards = posts.rows.map((p, i) => {
          const tags = (p.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
          const tagsHtml = tags.length > 0
            ? `<div class="tags">${tags.map((t) => `<a href="/blog/tag/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`).join("")}</div>`
            : "";
          return `<article class="post-card" style="animation-delay: ${i * 50}ms">
  <h2><a href="/blog/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></h2>
  <div class="meta"><span class="date">${formatDate(p.published_at)}</span>${p.author ? ` · ${escapeHtml(p.author)}` : ""}</div>
  <p class="excerpt">${escapeHtml(p.excerpt || "")}</p>
  ${tagsHtml}
</article>`;
        }).join("\n");

        content = `<h2 style="font-family:'Fraunces',serif;margin-bottom:1.5rem">Tagged: ${escapeHtml(tag)}</h2>
<div class="post-grid">${cards}</div>
<div class="pagination"><a href="/blog">← All posts</a></div>`;
      }

      res.type("html").send(pageShell(settings, { title: `Tag: ${tag}`, content }));
    } catch (err) {
      console.error("[blog] Tag page error:", err);
      res.status(500).send("Error loading blog");
    } finally {
      db.close();
    }
  });

  // GET /blog/media/:key — Public media files linked to blog posts
  router.get("/blog/media/:key(*)", async (req, res) => {
    const db = createDbClient();
    try {
      const s3Key = req.params.key;

      // Security: only serve files linked to published public blog posts
      const allowed = await db.execute({
        sql: `SELECT sf.mime_type FROM storage_files sf
              WHERE sf.s3_key = ? AND sf.reference_type = 'blog_post'
              UNION
              SELECT sf2.mime_type FROM blog_posts bp
              JOIN storage_files sf2 ON sf2.s3_key = bp.cover_image_key
              WHERE bp.cover_image_key = ? AND bp.status = 'published' AND bp.visibility = 'public'`,
        args: [s3Key, s3Key],
      });

      if (allowed.rows.length === 0) {
        return res.status(404).send("Not found");
      }

      if (!(await isAvailable())) {
        return res.status(503).send("Storage unavailable");
      }

      const { stream, stat } = await getObject(s3Key);
      const contentType = allowed.rows[0].mime_type || stat.metaData?.["content-type"] || "application/octet-stream";

      res.set("Content-Type", contentType);
      res.set("Content-Length", String(stat.size));
      res.set("Cache-Control", "public, max-age=86400");
      stream.pipe(res);
    } catch (err) {
      console.error("[blog] Media error:", err);
      res.status(404).send("Not found");
    } finally {
      db.close();
    }
  });

  // GET /blog/research — Capstone research publications landing page
  router.get("/blog/research", async (req, res) => {
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      // Chapters are ordered by data_case_studies.display_order (1..9) so
      // the reader navigates Ch 1 → Ch 5 regardless of published_at order
      // on the main /blog index.
      const { rows } = await db.execute({
        sql: `
          SELECT cs.id AS cs_id, cs.title AS cs_title, cs.description, cs.display_order,
                 bp.slug, bp.title AS bp_title, bp.excerpt, bp.published_at
          FROM data_case_studies cs
          JOIN blog_posts bp ON bp.id = cs.blog_post_id
          WHERE cs.project_id = 6
            AND bp.status = 'published'
            AND bp.visibility = 'public'
          ORDER BY cs.display_order ASC, cs.id ASC
        `,
      });

      const reportTitle = `An "Efficient System"? Constitutional Analysis of Charter School Duplication, Bond Election Dependence, and Needs-Based Funding in the Texas School Finance System`;
      const reportBlurb = `Capstone research for INSD 5940-41 (UNT). Constitutional evaluation of post-${'’'}16 Texas school finance against <em>Edgewood v. Kirby</em> (1989) and <em>Morath v. Texas Taxpayer and Student Fairness Coalition</em> (2016), with an original campus-level At-Risk Coefficient (ARC) regression model (8,674 campuses, 1,203 districts).`;

      const chaptersHtml = rows.map((r) => `
        <li style="margin:1rem 0;">
          <a href="/blog/${escapeHtml(r.slug)}" style="font-weight:600;font-size:1.05em;text-decoration:none;">
            ${escapeHtml(r.bp_title)}
          </a>
          ${r.excerpt ? `<div style="color:var(--crow-text-secondary,#64748b);font-size:0.9em;margin-top:0.2rem">${escapeHtml(r.excerpt)}</div>` : ""}
        </li>
      `).join("");

      const content = `
<article class="post-single" style="max-width:48rem;margin:0 auto;">
  <h1>Research Publications</h1>
  <p style="color:var(--crow-text-secondary,#64748b);font-size:0.95em;">
    Long-form research from the Maestro Press capstone.
  </p>

  <section style="margin-top:2rem;padding:1.5rem;border-radius:8px;background:var(--crow-bg-elevated,#f8fafc);border:1px solid var(--crow-border,#e2e8f0);">
    <h2 style="margin-top:0;font-size:1.25em;">${escapeHtml(reportTitle)}</h2>
    <p style="margin-bottom:0;">${reportBlurb}</p>
  </section>

  <h2 style="margin-top:2rem;">Chapters</h2>
  <ol style="list-style:none;padding-left:0;">
    ${chaptersHtml || "<li><em>No chapters published yet.</em></li>"}
  </ol>
</article>`;

      res.type("html").send(pageShell(settings, { title: "Research", content }));
    } catch (err) {
      console.error("[blog] /research error:", err);
      res.status(500).send("Error loading research page");
    } finally {
      db.close();
    }
  });

  // GET /blog/:slug — Single post (must be last to avoid matching feed/tag routes)
  router.get("/blog/:slug", async (req, res, next) => {
    // Belt-and-suspenders guard: /blog/api/* and /blog/figures/* are
    // handled by blogEmbedApiRouter which mounts BEFORE this router.
    // The guard protects against a future refactor that reorders app.use.
    if (RESERVED_BLOG_SLUGS.has(req.params.slug)) return next();
    const db = createDbClient();
    try {
      const settings = await getBlogSettings(db);
      const slug = req.params.slug;

      const result = await db.execute({
        sql: "SELECT * FROM blog_posts WHERE slug = ? AND status = 'published' AND visibility = 'public'",
        args: [slug],
      });

      if (result.rows.length === 0) {
        res.status(404).type("html").send(pageShell(settings, {
          title: "Not Found",
          content: `<div class="empty-state"><h2>Post not found</h2><p><a href="/blog">← Back to blog</a></p></div>`,
        }));
        return;
      }

      const post = result.rows[0];

      // Songbook posts redirect to their canonical songbook URL
      if (post.tags?.includes("songbook") && isChordPro(post.content)) {
        const qs = req.url.includes("?") ? "?" + req.url.split("?")[1] : "";
        return res.redirect(301, `/blog/songbook/${post.slug}${qs}`);
      }

      const html = renderMarkdown(post.content);
      // Phase 8.5: inject blog-hydrate.js on posts that contain
      // case-study figures, so static <img> fallbacks become live
      // Chart.js/Leaflet widgets. Inspected on the rendered content to
      // avoid loading the hydrate script + vendored Chart.js/Leaflet on
      // non-case-study posts. Served from the tea-maps bundle's shared
      // mount so everything (vendored deps + shared renderer) resolves
      // off a single origin.
      const hasFigures = /<figure\s+class="crow-(chart|map)"/i.test(html);
      const hydrateScript = hasFigures
        ? `\n<script defer data-hydrate-entry="1" data-bundle-version="1" src="/blog/assets/shared/blog-hydrate.js"></script>`
        : "";
      const tags = (post.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      const tagsHtml = tags.length > 0
        ? `<div class="tags" style="margin-top:0.5rem">${tags.map((t) => `<a href="/blog/tag/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`).join(" ")}</div>`
        : "";

      // Chapter navigation for case-study posts. Looks up neighbors by
      // data_case_studies.display_order within project 6 so the reader
      // can walk Ch 1 → Ch 5 without returning to the index.
      let chapterNavHtml = "";
      if (tags.includes("case-study")) {
        const { rows: selfRow } = await db.execute({
          sql: "SELECT cs.display_order FROM data_case_studies cs WHERE cs.blog_post_id = ? AND cs.project_id = 6",
          args: [post.id],
        });
        const order = selfRow[0]?.display_order;
        if (order != null) {
          const prevQ = await db.execute({
            sql: `SELECT cs.display_order, bp.slug, bp.title
                    FROM data_case_studies cs JOIN blog_posts bp ON bp.id = cs.blog_post_id
                   WHERE cs.project_id = 6 AND cs.display_order < ?
                     AND bp.status = 'published' AND bp.visibility = 'public'
                   ORDER BY cs.display_order DESC LIMIT 1`,
            args: [order],
          });
          const nextQ = await db.execute({
            sql: `SELECT cs.display_order, bp.slug, bp.title
                    FROM data_case_studies cs JOIN blog_posts bp ON bp.id = cs.blog_post_id
                   WHERE cs.project_id = 6 AND cs.display_order > ?
                     AND bp.status = 'published' AND bp.visibility = 'public'
                   ORDER BY cs.display_order ASC LIMIT 1`,
            args: [order],
          });
          const prev = prevQ.rows[0];
          const next = nextQ.rows[0];
          if (prev || next) {
            chapterNavHtml = `
  <nav class="chapter-nav" style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid var(--crow-border,#e2e8f0);display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
    ${prev ? `<a href="/blog/${escapeHtml(prev.slug)}" style="flex:1 1 45%;text-decoration:none;padding:0.75rem 1rem;border-radius:6px;border:1px solid var(--crow-border,#e2e8f0);">
      <div style="font-size:0.75em;color:var(--crow-text-secondary,#64748b);text-transform:uppercase;letter-spacing:0.05em">← Previous</div>
      <div style="font-weight:600;margin-top:0.15rem">${escapeHtml(prev.title)}</div>
    </a>` : '<span style="flex:1 1 45%"></span>'}
    ${next ? `<a href="/blog/${escapeHtml(next.slug)}" style="flex:1 1 45%;text-decoration:none;padding:0.75rem 1rem;border-radius:6px;border:1px solid var(--crow-border,#e2e8f0);text-align:right;">
      <div style="font-size:0.75em;color:var(--crow-text-secondary,#64748b);text-transform:uppercase;letter-spacing:0.05em">Next →</div>
      <div style="font-weight:600;margin-top:0.15rem">${escapeHtml(next.title)}</div>
    </a>` : '<span style="flex:1 1 45%"></span>'}
  </nav>
  <div style="text-align:center;margin-top:1rem;">
    <a href="/blog/research" style="font-size:0.85em;color:var(--crow-text-secondary,#64748b);">All chapters →</a>
  </div>`;
          }
        }
      }

      const coverHtml = post.cover_image_key
        ? `<figure style="margin:-0.5rem 0 2rem"><img src="/blog/media/${encodeURIComponent(post.cover_image_key)}" alt="${escapeHtml(post.title)}" style="width:100%;border-radius:12px;max-height:400px;object-fit:cover"></figure>`
        : "";

      const siteUrl = getSiteUrl(req);
      const ogImage = post.cover_image_key
        ? `\n  <meta property="og:image" content="${siteUrl}/blog/media/${encodeURIComponent(post.cover_image_key)}">`
        : "";
      const ogMeta = `
  <meta property="og:title" content="${escapeHtml(post.title)}">
  <meta property="og:description" content="${escapeHtml(post.excerpt || "")}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${siteUrl}/blog/${escapeHtml(post.slug)}">
  <meta name="author" content="${escapeHtml(post.author || settings.author || "")}">${ogImage}`;

      const content = `<article class="post-single">
  <h1>${escapeHtml(post.title)}</h1>
  ${coverHtml}
  <div class="meta">
    <span class="date">${formatDate(post.published_at)}</span>${post.author ? ` · ${escapeHtml(post.author)}` : ""}
    ${tagsHtml}
  </div>
  <div class="body">${html}</div>
  ${chapterNavHtml}
  <div class="post-footer">
    <a href="/blog">← Back to all posts</a>
  </div>
</article>${hydrateScript}`;

      res.type("html").send(pageShell(settings, { title: post.title, content, ogMeta }));
    } catch (err) {
      console.error("[blog] Post error:", err);
      res.status(500).send("Error loading post");
    } finally {
      db.close();
    }
  });

  return router;
}
