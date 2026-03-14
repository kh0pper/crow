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
import { generateRss, generateAtom } from "../../blog/rss.js";
import { generatePodcastFeed } from "../../blog/podcast-rss.js";
import { isAvailable, getObject } from "../../storage/s3-client.js";

/**
 * Get blog settings from dashboard_settings table.
 */
async function getBlogSettings(db) {
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
  };
}

/**
 * Dark Editorial design system CSS.
 */
function designCss(settings) {
  const themeClass = settings.theme === "light" ? "theme-light" : settings.theme === "serif" ? "theme-serif" : "";
  return `
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --crow-bg-deep: #0f0f17;
    --crow-bg-surface: #1a1a2e;
    --crow-bg-elevated: #2d2d3d;
    --crow-border: #3d3d4d;
    --crow-text-primary: #fafaf9;
    --crow-text-secondary: #a8a29e;
    --crow-text-muted: #78716c;
    --crow-accent: #6366f1;
    --crow-accent-hover: #818cf8;
    --crow-accent-muted: #2d2854;
    --crow-success: #22c55e;
    --crow-error: #ef4444;
    --crow-info: #38bdf8;
  }

  .theme-light {
    --crow-bg-deep: #fafaf9;
    --crow-bg-surface: #ffffff;
    --crow-bg-elevated: #f5f5f4;
    --crow-border: #e7e5e4;
    --crow-text-primary: #1c1917;
    --crow-text-secondary: #57534e;
    --crow-text-muted: #a8a29e;
    --crow-accent: #4f46e5;
    --crow-accent-hover: #6366f1;
    --crow-accent-muted: #e0e7ff;
  }

  .theme-serif { --crow-body-font: 'Fraunces', serif; }

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

  ${settings.customCss}
</style>`;
}

/**
 * HTML page shell.
 */
function pageShell(settings, { title, content, ogMeta }) {
  const themeClass = settings.theme === "light" ? "theme-light" : settings.theme === "serif" ? "theme-serif" : "";
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

      const posts = await db.execute({
        sql: "SELECT id, slug, title, excerpt, author, tags, published_at, cover_image_key FROM blog_posts WHERE status = 'published' AND visibility = 'public' ORDER BY published_at DESC LIMIT ? OFFSET ?",
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
      const siteUrl = process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
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
      const siteUrl = process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
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

      const siteUrl = process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;
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
      const siteUrl = process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;

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
      const siteUrl = process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;

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
      const siteUrl = process.env.CROW_GATEWAY_URL || `http://localhost:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`;

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

  // GET /blog/:slug — Single post (must be last to avoid matching feed/tag routes)
  router.get("/blog/:slug", async (req, res) => {
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
      const html = renderMarkdown(post.content);
      const tags = (post.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      const tagsHtml = tags.length > 0
        ? `<div class="tags" style="margin-top:0.5rem">${tags.map((t) => `<a href="/blog/tag/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`).join(" ")}</div>`
        : "";

      const coverHtml = post.cover_image_key
        ? `<figure style="margin:-0.5rem 0 2rem"><img src="/blog/media/${encodeURIComponent(post.cover_image_key)}" alt="${escapeHtml(post.title)}" style="width:100%;border-radius:12px;max-height:400px;object-fit:cover"></figure>`
        : "";

      const siteUrl = process.env.CROW_GATEWAY_URL || "";
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
  <div class="post-footer">
    <a href="/blog">← Back to all posts</a>
  </div>
</article>`;

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
