/**
 * Public Knowledge Base Routes
 *
 * GET /kb/                              — Index (all published collections)
 * GET /kb/:collection                   — Collection page (categories + articles)
 * GET /kb/:collection/search?q=         — Search within collection
 * GET /kb/:collection/category/:category — Articles by category
 * GET /kb/:collection/:slug             — Article (auto-detect language)
 * GET /kb/:collection/:slug/:lang       — Explicit language version
 * GET /kb/api/discover.json             — Machine-readable discovery
 *
 * WCAG 2.1 Level AA compliant. All pages use semantic HTML, skip navigation,
 * proper ARIA landmarks, keyboard-accessible controls, and 4.5:1 contrast ratios.
 */

import { Router } from "express";
import { renderSkipLink, skipLinkCss, focusCss, ensureTableHeaders, linkPhoneNumbers, languageToggle } from "./a11y.js";

// Resolve design tokens and markdown renderer from the main repo
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic imports for shared modules (may be at different paths depending on install location)
let FONT_IMPORT, designTokensCss, renderMarkdown, sanitizeFtsQuery;

async function loadSharedModules() {
  // Try repo-relative paths first, then installed bundle paths
  const repoRoot = resolve(__dirname, "../../../");

  try {
    const tokens = await import(pathToFileURL(resolve(repoRoot, "servers/gateway/dashboard/shared/design-tokens.js")).href);
    FONT_IMPORT = tokens.FONT_IMPORT;
    designTokensCss = tokens.designTokensCss;
  } catch {
    // Minimal fallback
    FONT_IMPORT = "";
    designTokensCss = () => `:root { --crow-bg-deep: #0f0f17; --crow-bg-surface: #1a1a2e; --crow-text-primary: #fafaf9; --crow-text-secondary: #a8a29e; --crow-text-muted: #78716c; --crow-accent: #6366f1; --crow-accent-hover: #818cf8; --crow-border: #3d3d4d; --crow-success: #22c55e; --crow-error: #ef4444; }`;
  }

  try {
    const renderer = await import(pathToFileURL(resolve(repoRoot, "servers/blog/renderer.js")).href);
    renderMarkdown = renderer.renderMarkdown;
  } catch {
    // Basic markdown fallback — just escape HTML
    renderMarkdown = (md) => md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }

  try {
    const dbMod = await import(pathToFileURL(resolve(repoRoot, "servers/db.js")).href);
    sanitizeFtsQuery = dbMod.sanitizeFtsQuery;
  } catch {
    const localDb = await import("../server/db.js");
    sanitizeFtsQuery = localDb.sanitizeFtsQuery;
  }
}

/**
 * Check if a request originates from a private/LAN IP range.
 * Proxy-aware: uses req.ip which Express resolves via trust proxy.
 */
function isLanRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress || "";
  const normalized = ip.replace(/^::ffff:/, "");
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(normalized)
    || normalized === "::1";
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(dateStr, lang = "en") {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(lang === "es" ? "es-US" : "en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return dateStr;
  }
}

/**
 * Detect preferred language from Accept-Language header.
 */
function detectLanguage(req, availableLanguages) {
  const langParam = req.query.lang;
  if (langParam && availableLanguages.includes(langParam)) return langParam;

  const accept = req.headers["accept-language"] || "";
  for (const part of accept.split(",")) {
    const code = part.trim().split(";")[0].split("-")[0].toLowerCase();
    if (availableLanguages.includes(code)) return code;
  }
  return availableLanguages[0] || "en";
}

/**
 * WCAG 2.1 AA compliant page shell with proper landmarks, skip nav, and language.
 */
function kbPageShell({ title, lang, content, collection, breadcrumbs }) {
  const pageTitle = collection
    ? `${escapeHtml(title)} — ${escapeHtml(collection.name)}`
    : escapeHtml(title);

  return `<!DOCTYPE html>
<html lang="${lang || "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <style>
    ${FONT_IMPORT || ""}

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    ${designTokensCss()}

    ${skipLinkCss()}
    ${focusCss()}

    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--crow-bg-deep);
      color: var(--crow-text-primary);
      line-height: 1.7;
      min-height: 100vh;
    }

    /* Header */
    .kb-header {
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem 1.5rem 1.5rem;
      border-bottom: 1px solid var(--crow-border);
    }
    .kb-header h1 {
      font-family: 'Fraunces', serif;
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .kb-header h1 a { color: var(--crow-text-primary); text-decoration: none; }
    .kb-header h1 a:hover { color: var(--crow-accent); }
    .kb-header .tagline {
      color: var(--crow-text-secondary);
      margin-top: 0.25rem;
      font-size: 0.95rem;
    }

    /* Breadcrumbs */
    .breadcrumbs {
      font-size: 0.85rem;
      color: var(--crow-text-muted);
      margin-top: 0.75rem;
    }
    .breadcrumbs a { color: var(--crow-accent); text-decoration: none; }
    .breadcrumbs a:hover { text-decoration: underline; }
    .breadcrumbs [aria-current="page"] { color: var(--crow-text-secondary); }

    /* Main content */
    .kb-main {
      max-width: 800px;
      margin: 0 auto;
      padding: 1.5rem 1.5rem 4rem;
    }

    /* Card grid */
    .card-grid {
      display: grid;
      gap: 1rem;
    }
    .card {
      background: var(--crow-bg-surface);
      border: 1px solid var(--crow-border);
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .card:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .card h2, .card h3 {
      font-family: 'Fraunces', serif;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .card h2 { font-size: 1.2rem; }
    .card h3 { font-size: 1.1rem; }
    .card h2 a, .card h3 a { color: var(--crow-text-primary); text-decoration: none; }
    .card h2 a:hover, .card h3 a:hover { color: var(--crow-accent); }
    .card .meta {
      font-size: 0.8rem;
      color: var(--crow-text-muted);
      margin-bottom: 0.5rem;
    }
    .card .excerpt {
      color: var(--crow-text-secondary);
      font-size: 0.95rem;
      line-height: 1.6;
    }

    /* Language toggle */
    .lang-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.75rem;
      background: var(--crow-bg-elevated);
      border: 1px solid var(--crow-border);
      border-radius: 6px;
      font-size: 0.85rem;
      color: var(--crow-accent);
      text-decoration: none;
      transition: background 0.15s;
    }
    .lang-toggle:hover { background: var(--crow-bg-surface); }

    /* Tags */
    .tag {
      display: inline-block;
      font-size: 0.75rem;
      padding: 0.15rem 0.5rem;
      background: var(--crow-accent-muted);
      color: var(--crow-accent);
      border-radius: 4px;
      margin: 0.15rem 0.15rem 0 0;
      text-decoration: none;
    }
    .tag:hover { background: var(--crow-accent); color: #fff; }

    /* Category pills */
    .category-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      list-style: none;
    }
    .category-pill {
      padding: 0.35rem 0.85rem;
      background: var(--crow-bg-surface);
      border: 1px solid var(--crow-border);
      border-radius: 20px;
      font-size: 0.85rem;
      color: var(--crow-text-secondary);
      text-decoration: none;
      transition: background 0.15s, color 0.15s;
    }
    .category-pill:hover, .category-pill[aria-current="true"] {
      background: var(--crow-accent);
      color: #fff;
      border-color: var(--crow-accent);
    }

    /* Search */
    .search-form {
      margin-bottom: 1.5rem;
    }
    .search-input {
      width: 100%;
      padding: 0.6rem 1rem;
      background: var(--crow-bg-surface);
      border: 1px solid var(--crow-border);
      border-radius: 8px;
      color: var(--crow-text-primary);
      font-size: 0.95rem;
      font-family: inherit;
    }
    .search-input::placeholder { color: var(--crow-text-muted); }

    /* Article body */
    .article-body {
      font-size: 1rem;
      line-height: 1.8;
    }
    .article-body h1, .article-body h2, .article-body h3 {
      font-family: 'Fraunces', serif;
      margin-top: 2rem;
      margin-bottom: 0.75rem;
    }
    .article-body h1 { font-size: 1.75rem; }
    .article-body h2 { font-size: 1.4rem; border-bottom: 1px solid var(--crow-border); padding-bottom: 0.5rem; }
    .article-body h3 { font-size: 1.15rem; }
    .article-body p { margin-bottom: 1rem; }
    .article-body ul, .article-body ol { margin: 0.5rem 0 1rem 1.5rem; }
    .article-body li { margin-bottom: 0.25rem; }
    .article-body a { color: var(--crow-accent); text-decoration: underline; }
    .article-body a:hover { color: var(--crow-accent-hover); }
    .article-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      font-size: 0.9rem;
    }
    .article-body th, .article-body td {
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--crow-border);
      text-align: left;
    }
    .article-body th {
      background: var(--crow-bg-elevated);
      font-weight: 600;
    }
    .article-body code {
      background: var(--crow-bg-elevated);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .article-body blockquote {
      border-left: 3px solid var(--crow-accent);
      padding: 0.5rem 1rem;
      margin: 1rem 0;
      color: var(--crow-text-secondary);
      background: var(--crow-bg-surface);
      border-radius: 0 8px 8px 0;
    }
    .article-body img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
    }

    /* Article header */
    .article-header {
      margin-bottom: 2rem;
    }
    .article-header h1 {
      font-family: 'Fraunces', serif;
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    .article-header .article-meta {
      font-size: 0.85rem;
      color: var(--crow-text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      align-items: center;
    }

    /* Footer */
    .kb-footer {
      max-width: 800px;
      margin: 0 auto;
      padding: 1.5rem;
      border-top: 1px solid var(--crow-border);
      font-size: 0.8rem;
      color: var(--crow-text-muted);
      text-align: center;
    }

    /* Responsive */
    @media (max-width: 600px) {
      .kb-header, .kb-main { padding-left: 1rem; padding-right: 1rem; }
      .article-header h1 { font-size: 1.5rem; }
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--crow-text-muted);
    }

    /* Search results live region */
    .search-results[aria-live] { min-height: 2rem; }
  </style>
</head>
<body>
  ${renderSkipLink("main-content")}
  <header class="kb-header" role="banner">
    <h1><a href="/kb">${collection ? escapeHtml(collection.name) : "Knowledge Base"}</a></h1>
    ${collection?.description ? `<p class="tagline">${escapeHtml(collection.description)}</p>` : ""}
    ${breadcrumbs ? `<nav class="breadcrumbs" aria-label="Breadcrumb">${breadcrumbs}</nav>` : ""}
  </header>
  <main id="main-content" class="kb-main" role="main">
    ${content}
  </main>
  <footer class="kb-footer" role="contentinfo">
    <p>Powered by <a href="https://github.com/kh0pp/crow">Crow</a></p>
  </footer>
</body>
</html>`;
}

/**
 * Render a breadcrumb trail.
 */
function breadcrumb(items) {
  return items.map((item, i) => {
    if (i === items.length - 1) {
      return `<span aria-current="page">${escapeHtml(item.label)}</span>`;
    }
    return `<a href="${item.href}">${escapeHtml(item.label)}</a>`;
  }).join(" / ");
}

/**
 * @returns {Router}
 */
export default function kbPublicRouter() {
  const router = Router();

  // Lazy-init: load shared modules and create DB client on first request
  let modulesLoaded = false;
  let db;

  async function getDb() {
    if (db) return db;
    try {
      const { createDbClient } = await import("../server/db.js");
      db = createDbClient();
    } catch {
      // Fallback: try repo-relative path
      const { resolve } = await import("path");
      const { pathToFileURL } = await import("url");
      const repoDb = resolve(__dirname, "../../../servers/db.js");
      const mod = await import(pathToFileURL(repoDb).href);
      db = mod.createDbClient();
    }
    return db;
  }

  router.use(async (req, res, next) => {
    if (!modulesLoaded) {
      await loadSharedModules();
      modulesLoaded = true;
    }
    try {
      await getDb();
    } catch (err) {
      console.error("[knowledge-base] DB init failed:", err.message);
      return res.status(500).send("Knowledge base database unavailable");
    }
    next();
  });

  // --- GET /kb/api/discover.json ---
  router.get("/kb/api/discover.json", async (req, res) => {
    try {
      const isLan = isLanRequest(req);
      let sql = "SELECT id, slug, name, description, languages, visibility FROM kb_collections WHERE visibility = 'public'";
      if (isLan) sql = "SELECT id, slug, name, description, languages, visibility FROM kb_collections WHERE visibility IN ('public', 'lan')";

      const collections = await db.execute({ sql, args: [] });
      res.json({
        type: "crow-knowledge-base",
        version: "1.0.0",
        collections: collections.rows.map(c => ({
          slug: c.slug,
          name: c.name,
          description: c.description,
          languages: c.languages?.split(",") || ["en"],
          url: `/kb/${c.slug}`,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to load discovery data" });
    }
  });

  // --- GET /kb/media/:filename — Serve KB media files (images extracted from guides) ---
  router.get("/kb/media/:filename", async (req, res) => {
    const { existsSync: fileExists } = await import("fs");
    const { resolve: resolvePath } = await import("path");
    const { homedir } = await import("os");

    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
    const mediaDir = resolvePath(homedir(), ".crow", "data", "kb-media");
    const filePath = resolvePath(mediaDir, filename);

    // Security: ensure resolved path is within kb-media dir
    if (!filePath.startsWith(mediaDir) || !fileExists(filePath)) {
      return res.status(404).end();
    }

    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeMap = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const { createReadStream } = await import("fs");
    createReadStream(filePath).pipe(res);
  });

  // --- GET /kb/ — Index ---
  router.get("/kb", async (req, res) => {
    try {
      const isLan = isLanRequest(req);
      const visibilities = isLan ? ["public", "lan"] : ["public"];
      const placeholders = visibilities.map(() => "?").join(",");

      const collections = await db.execute({
        sql: `SELECT id, slug, name, description, languages, visibility FROM kb_collections WHERE visibility IN (${placeholders}) ORDER BY name`,
        args: visibilities,
      });

      if (collections.rows.length === 0) {
        return res.send(kbPageShell({
          title: "Knowledge Base",
          lang: "en",
          content: `<div class="empty-state"><p>No knowledge bases published yet.</p></div>`,
        }));
      }

      // If only one collection, redirect to it
      if (collections.rows.length === 1) {
        return res.redirect(`/kb/${collections.rows[0].slug}`);
      }

      const cards = collections.rows.map(c => {
        const langs = (c.languages || "en").split(",").map(l => `<span class="tag">${l.toUpperCase()}</span>`).join(" ");
        return `
          <article class="card">
            <h2><a href="/kb/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a></h2>
            ${c.description ? `<p class="excerpt">${escapeHtml(c.description)}</p>` : ""}
            <div class="meta">${langs}</div>
          </article>`;
      }).join("\n");

      res.send(kbPageShell({
        title: "Knowledge Base",
        lang: "en",
        content: `<section class="card-grid" aria-label="Knowledge base collections">${cards}</section>`,
      }));
    } catch (err) {
      console.error("KB index error:", err);
      res.status(500).send(kbPageShell({ title: "Error", lang: "en", content: "<p>Failed to load knowledge base.</p>" }));
    }
  });

  // --- GET /kb/:collection — Collection page ---
  router.get("/kb/:collection", async (req, res) => {
    try {
      const col = await getCollection(db, req.params.collection, req);
      if (!col) return res.status(404).send(kbPageShell({ title: "Not Found", lang: "en", content: "<p>Collection not found.</p>" }));

      const availableLangs = (col.languages || "en").split(",");
      const lang = detectLanguage(req, availableLangs);

      // Get categories with localized names
      const categories = await db.execute({
        sql: `SELECT c.id, c.slug, c.icon,
              COALESCE(n.name, n2.name, c.slug) AS name
              FROM kb_categories c
              LEFT JOIN kb_category_names n ON c.id = n.category_id AND n.language = ?
              LEFT JOIN kb_category_names n2 ON c.id = n2.category_id AND n2.language = ?
              WHERE c.collection_id = ?
              ORDER BY c.sort_order, c.slug`,
        args: [lang, col.default_language || "en", col.id],
      });

      // Get published articles
      const articles = await db.execute({
        sql: `SELECT id, title, slug, language, excerpt, tags, published_at, pair_id, category_id
              FROM kb_articles
              WHERE collection_id = ? AND status = 'published' AND language = ?
              ORDER BY title`,
        args: [col.id, lang],
      });

      let content = "";

      // Search form
      const searchLabel = lang === "es" ? "Buscar en la base de conocimiento" : "Search the knowledge base";
      const searchPlaceholder = lang === "es" ? "Buscar..." : "Search...";
      content += `
        <form class="search-form" action="/kb/${escapeHtml(col.slug)}/search" method="get" role="search" aria-label="${searchLabel}">
          <label for="kb-search" class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">${searchLabel}</label>
          <input id="kb-search" class="search-input" type="search" name="q" placeholder="${searchPlaceholder}" aria-label="${searchLabel}">
        </form>`;

      // Category pills
      if (categories.rows.length > 0) {
        const allLabel = lang === "es" ? "Todos" : "All";
        const pills = [`<li><a href="/kb/${escapeHtml(col.slug)}" class="category-pill" aria-current="true">${allLabel}</a></li>`];
        pills.push(...categories.rows.map(c =>
          `<li><a href="/kb/${escapeHtml(col.slug)}/category/${escapeHtml(c.slug)}" class="category-pill">${escapeHtml(c.name)}</a></li>`
        ));
        content += `<nav aria-label="Categories"><ul class="category-list">${pills.join("")}</ul></nav>`;
      }

      // Language toggle
      const otherLangs = availableLangs.filter(l => l !== lang);
      if (otherLangs.length > 0) {
        content += `<div style="margin-bottom:1rem">${otherLangs.map(l => languageToggle(lang, l, `/kb/${col.slug}?lang=${l}`)).join(" ")}</div>`;
      }

      // Article cards
      if (articles.rows.length === 0) {
        const emptyMsg = lang === "es" ? "No hay art\u00edculos publicados todav\u00eda." : "No published articles yet.";
        content += `<div class="empty-state"><p>${emptyMsg}</p></div>`;
      } else {
        const cards = articles.rows.map(a => {
          const tagHtml = a.tags
            ? a.tags.split(",").map(t => `<a href="/kb/${escapeHtml(col.slug)}/search?q=${encodeURIComponent(t.trim())}" class="tag">${escapeHtml(t.trim())}</a>`).join(" ")
            : "";
          return `
            <article class="card">
              <h3><a href="/kb/${escapeHtml(col.slug)}/${escapeHtml(a.slug)}">${escapeHtml(a.title)}</a></h3>
              <div class="meta">${formatDate(a.published_at, lang)}</div>
              ${a.excerpt ? `<p class="excerpt">${escapeHtml(a.excerpt)}</p>` : ""}
              ${tagHtml ? `<div>${tagHtml}</div>` : ""}
            </article>`;
        }).join("\n");

        content += `<section class="card-grid" aria-label="${lang === "es" ? "Art\u00edculos" : "Articles"}">${cards}</section>`;
      }

      res.send(kbPageShell({
        title: col.name,
        lang,
        content,
        collection: col,
        breadcrumbs: breadcrumb([
          { label: "Knowledge Base", href: "/kb" },
          { label: col.name },
        ]),
      }));
    } catch (err) {
      console.error("KB collection error:", err);
      res.status(500).send(kbPageShell({ title: "Error", lang: "en", content: "<p>Failed to load collection.</p>" }));
    }
  });

  // --- GET /kb/:collection/search ---
  router.get("/kb/:collection/search", async (req, res) => {
    try {
      const col = await getCollection(db, req.params.collection, req);
      if (!col) return res.status(404).send(kbPageShell({ title: "Not Found", lang: "en", content: "<p>Collection not found.</p>" }));

      const query = (req.query.q || "").trim();
      const availableLangs = (col.languages || "en").split(",");
      const lang = detectLanguage(req, availableLangs);

      let resultsHtml = "";

      if (query) {
        const safeQuery = sanitizeFtsQuery(query);
        if (safeQuery) {
          const results = await db.execute({
            sql: `SELECT a.id, a.title, a.slug, a.language, a.excerpt, a.published_at
                  FROM kb_articles a
                  JOIN kb_articles_fts f ON a.id = f.rowid
                  WHERE kb_articles_fts MATCH ? AND a.collection_id = ? AND a.status = 'published'
                  ORDER BY rank LIMIT 50`,
            args: [safeQuery, col.id],
          });

          if (results.rows.length === 0) {
            const noResults = lang === "es" ? "No se encontraron resultados." : "No results found.";
            resultsHtml = `<p>${noResults}</p>`;
          } else {
            const cards = results.rows.map(a => `
              <article class="card">
                <h3><a href="/kb/${escapeHtml(col.slug)}/${escapeHtml(a.slug)}">${escapeHtml(a.title)}</a></h3>
                <div class="meta">${a.language.toUpperCase()} · ${formatDate(a.published_at, lang)}</div>
                ${a.excerpt ? `<p class="excerpt">${escapeHtml(a.excerpt)}</p>` : ""}
              </article>`).join("\n");
            resultsHtml = `<p style="color:var(--crow-text-muted);margin-bottom:1rem">${results.rows.length} result${results.rows.length !== 1 ? "s" : ""}</p>
              <section class="card-grid">${cards}</section>`;
          }
        } else {
          resultsHtml = `<p>Invalid search query.</p>`;
        }
      }

      const searchLabel = lang === "es" ? "Buscar" : "Search";
      const content = `
        <form class="search-form" action="/kb/${escapeHtml(col.slug)}/search" method="get" role="search" aria-label="${searchLabel}">
          <label for="kb-search" class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">${searchLabel}</label>
          <input id="kb-search" class="search-input" type="search" name="q" value="${escapeHtml(query)}" placeholder="${lang === "es" ? "Buscar..." : "Search..."}" aria-label="${searchLabel}">
        </form>
        <div class="search-results" aria-live="polite">${resultsHtml}</div>`;

      res.send(kbPageShell({
        title: `${searchLabel}: ${query || ""}`,
        lang,
        content,
        collection: col,
        breadcrumbs: breadcrumb([
          { label: "Knowledge Base", href: "/kb" },
          { label: col.name, href: `/kb/${col.slug}` },
          { label: searchLabel },
        ]),
      }));
    } catch (err) {
      console.error("KB search error:", err);
      res.status(500).send(kbPageShell({ title: "Error", lang: "en", content: "<p>Search failed.</p>" }));
    }
  });

  // --- GET /kb/:collection/category/:category ---
  router.get("/kb/:collection/category/:category", async (req, res) => {
    try {
      const col = await getCollection(db, req.params.collection, req);
      if (!col) return res.status(404).send(kbPageShell({ title: "Not Found", lang: "en", content: "<p>Collection not found.</p>" }));

      const availableLangs = (col.languages || "en").split(",");
      const lang = detectLanguage(req, availableLangs);

      const category = await db.execute({
        sql: `SELECT c.id, c.slug, COALESCE(n.name, c.slug) AS name
              FROM kb_categories c
              LEFT JOIN kb_category_names n ON c.id = n.category_id AND n.language = ?
              WHERE c.collection_id = ? AND c.slug = ?`,
        args: [lang, col.id, req.params.category],
      });
      if (category.rows.length === 0) {
        return res.status(404).send(kbPageShell({ title: "Not Found", lang, content: "<p>Category not found.</p>", collection: col }));
      }
      const cat = category.rows[0];

      // All categories for nav
      const allCategories = await db.execute({
        sql: `SELECT c.id, c.slug, COALESCE(n.name, c.slug) AS name
              FROM kb_categories c
              LEFT JOIN kb_category_names n ON c.id = n.category_id AND n.language = ?
              WHERE c.collection_id = ? ORDER BY c.sort_order`,
        args: [lang, col.id],
      });

      const articles = await db.execute({
        sql: `SELECT id, title, slug, language, excerpt, tags, published_at
              FROM kb_articles
              WHERE collection_id = ? AND category_id = ? AND status = 'published' AND language = ?
              ORDER BY title`,
        args: [col.id, cat.id, lang],
      });

      // Category pills
      const allLabel = lang === "es" ? "Todos" : "All";
      const pills = [`<li><a href="/kb/${escapeHtml(col.slug)}" class="category-pill">${allLabel}</a></li>`];
      pills.push(...allCategories.rows.map(c => {
        const current = c.slug === cat.slug ? ' aria-current="true"' : "";
        return `<li><a href="/kb/${escapeHtml(col.slug)}/category/${escapeHtml(c.slug)}" class="category-pill"${current}>${escapeHtml(c.name)}</a></li>`;
      }));

      let content = `<nav aria-label="Categories"><ul class="category-list">${pills.join("")}</ul></nav>`;

      if (articles.rows.length === 0) {
        content += `<div class="empty-state"><p>${lang === "es" ? "No hay art\u00edculos en esta categor\u00eda." : "No articles in this category."}</p></div>`;
      } else {
        const cards = articles.rows.map(a => `
          <article class="card">
            <h3><a href="/kb/${escapeHtml(col.slug)}/${escapeHtml(a.slug)}">${escapeHtml(a.title)}</a></h3>
            <div class="meta">${formatDate(a.published_at, lang)}</div>
            ${a.excerpt ? `<p class="excerpt">${escapeHtml(a.excerpt)}</p>` : ""}
          </article>`).join("\n");
        content += `<section class="card-grid" aria-label="${escapeHtml(cat.name)}">${cards}</section>`;
      }

      res.send(kbPageShell({
        title: cat.name,
        lang,
        content,
        collection: col,
        breadcrumbs: breadcrumb([
          { label: "Knowledge Base", href: "/kb" },
          { label: col.name, href: `/kb/${col.slug}` },
          { label: cat.name },
        ]),
      }));
    } catch (err) {
      console.error("KB category error:", err);
      res.status(500).send(kbPageShell({ title: "Error", lang: "en", content: "<p>Failed to load category.</p>" }));
    }
  });

  // --- Article pages ---
  async function handleArticle(req, res) {
    try {
      // Skip if slug matches reserved routes
      if (["search", "category", "api"].includes(req.params.slug)) return res.status(404).end();

      const col = await getCollection(db, req.params.collection, req);
      if (!col) return res.status(404).send(kbPageShell({ title: "Not Found", lang: "en", content: "<p>Collection not found.</p>" }));

      const availableLangs = (col.languages || "en").split(",");
      const requestedLang = req.params.lang || detectLanguage(req, availableLangs);

      // Find the article
      let article = await db.execute({
        sql: `SELECT * FROM kb_articles WHERE collection_id = ? AND slug = ? AND language = ? AND status = 'published'`,
        args: [col.id, req.params.slug, requestedLang],
      });

      // If not found in requested language, try any language
      if (article.rows.length === 0) {
        article = await db.execute({
          sql: `SELECT * FROM kb_articles WHERE collection_id = ? AND slug = ? AND status = 'published' LIMIT 1`,
          args: [col.id, req.params.slug],
        });
      }

      if (article.rows.length === 0) {
        return res.status(404).send(kbPageShell({
          title: "Not Found", lang: requestedLang, content: "<p>Article not found.</p>", collection: col,
        }));
      }

      const a = article.rows[0];

      // Find paired translations
      const translations = await db.execute({
        sql: "SELECT id, language, slug FROM kb_articles WHERE pair_id = ? AND id != ? AND status = 'published'",
        args: [a.pair_id, a.id],
      });

      // Get category name and slug
      let categoryName = "";
      let categorySlug = "";
      if (a.category_id) {
        const cat = await db.execute({
          sql: `SELECT COALESCE(n.name, c.slug) AS name, c.slug
                FROM kb_categories c
                LEFT JOIN kb_category_names n ON c.id = n.category_id AND n.language = ?
                WHERE c.id = ?`,
          args: [a.language, a.category_id],
        });
        if (cat.rows.length > 0) {
          categoryName = cat.rows[0].name;
          categorySlug = cat.rows[0].slug;
        }
      }

      // Render markdown content with accessibility post-processing
      let bodyHtml = renderMarkdown(a.content);
      bodyHtml = ensureTableHeaders(bodyHtml);
      bodyHtml = linkPhoneNumbers(bodyHtml);

      // Language toggles
      const langLinks = translations.rows.map(t =>
        languageToggle(a.language, t.language, `/kb/${col.slug}/${t.slug}/${t.language}`)
      ).join(" ");

      // Tags
      const tagHtml = a.tags
        ? a.tags.split(",").map(t => `<a href="/kb/${escapeHtml(col.slug)}/search?q=${encodeURIComponent(t.trim())}" class="tag">${escapeHtml(t.trim())}</a>`).join(" ")
        : "";

      const content = `
        <article>
          <header class="article-header">
            <h1>${escapeHtml(a.title)}</h1>
            <div class="article-meta">
              ${a.published_at ? `<span>${formatDate(a.published_at, a.language)}</span>` : ""}
              ${a.author ? `<span>${escapeHtml(a.author)}</span>` : ""}
              ${categoryName ? `<a href="/kb/${escapeHtml(col.slug)}/category/${escapeHtml(categorySlug)}" class="tag">${escapeHtml(categoryName)}</a>` : ""}
              ${langLinks}
            </div>
            ${tagHtml ? `<div style="margin-top:0.5rem">${tagHtml}</div>` : ""}
          </header>
          <div class="article-body">
            ${bodyHtml}
          </div>
        </article>`;

      const bcItems = [
        { label: "Knowledge Base", href: "/kb" },
        { label: col.name, href: `/kb/${col.slug}` },
      ];
      if (categoryName) {
        bcItems.push({ label: categoryName, href: `/kb/${col.slug}/category/${escapeHtml(categorySlug)}` });
      }
      bcItems.push({ label: a.title });

      res.send(kbPageShell({
        title: a.title,
        lang: a.language,
        content,
        collection: col,
        breadcrumbs: breadcrumb(bcItems),
      }));
    } catch (err) {
      console.error("KB article error:", err);
      res.status(500).send(kbPageShell({ title: "Error", lang: "en", content: "<p>Failed to load article.</p>" }));
    }
  }

  router.get("/kb/:collection/:slug/:lang", handleArticle);
  router.get("/kb/:collection/:slug", handleArticle);

  return router;
}

/**
 * Get a collection by slug, checking visibility against request origin.
 */
async function getCollection(db, slug, req) {
  const result = await db.execute({
    sql: "SELECT * FROM kb_collections WHERE slug = ?",
    args: [slug],
  });
  if (result.rows.length === 0) return null;
  const col = result.rows[0];

  // Check visibility
  if (col.visibility === "private" || col.visibility === "peers") return null;
  if (col.visibility === "lan" && !isLanRequest(req)) return null;

  return col;
}
