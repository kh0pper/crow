/**
 * Article Content Extractor
 *
 * Fetches article URLs and extracts full text content, images, and reading time
 * using @mozilla/readability + linkedom (lightweight, no jsdom).
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const FETCH_TIMEOUT = 15000;
const USER_AGENT = "Mozilla/5.0 (compatible; Crow/1.0; +https://github.com/kh0pper/crow)";
const WORDS_PER_MINUTE = 200;

/** Returns true if this image URL is a generic Google/platform logo, not article-specific */
function isGenericLogo(imageUrl) {
  if (!imageUrl) return false;
  // Google News logo served from lh3.googleusercontent.com (always the same image)
  if (imageUrl.includes("lh3.googleusercontent.com") && !imageUrl.includes("/p/")) return true;
  return false;
}

/**
 * Resolve a Google News redirect URL to the real publisher article URL.
 * Google News encrypts article URLs in JS-only redirects, so we search the
 * publisher's site (from `source_url`) for the article by title.
 * @param {string} title - Article title
 * @param {string} sourceUrl - Publisher domain URL (e.g. "https://apnews.com")
 * @returns {Promise<string|null>} Resolved article URL, or null
 */
async function resolveGoogleNewsArticle(title, sourceUrl) {
  if (!title || !sourceUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    // Fetch the publisher's homepage and search for a link matching the title
    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html, */*" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Build keyword search — use first few significant words from the title
    const keywords = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (keywords.length < 2) return null;

    // Find all links and score them by keyword overlap with the title
    const linkPattern = /href="(https?:\/\/[^"]+)"/g;
    let bestUrl = null;
    let bestScore = 0;

    for (const match of html.matchAll(linkPattern)) {
      const href = match[1];
      // Only consider links on the same domain
      try {
        const linkHost = new URL(href).hostname;
        const sourceHost = new URL(sourceUrl).hostname;
        if (!linkHost.endsWith(sourceHost.replace(/^www\./, "")) &&
            !sourceHost.endsWith(linkHost.replace(/^www\./, ""))) continue;
      } catch { continue; }

      // Score by how many title keywords appear in the URL slug
      const hrefLower = href.toLowerCase();
      const score = keywords.filter(kw => hrefLower.includes(kw)).length;
      if (score > bestScore && score >= 2) {
        bestScore = score;
        bestUrl = href;
      }
    }

    return bestUrl;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract full content from an article URL.
 * @returns {{ text, html, image, wordCount, readTime }}
 */
export async function extractContent(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  let rawHtml;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html, */*" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rawHtml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const { document } = parseHTML(rawHtml);

  // Extract og:image or twitter:image
  let image = null;
  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage) image = ogImage.getAttribute("content");
  if (!image) {
    const twImage = document.querySelector('meta[name="twitter:image"]');
    if (twImage) image = twImage.getAttribute("content");
  }

  // Filter out generic platform logos (e.g. Google News logo)
  if (isGenericLogo(image)) image = null;

  // Run Readability
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article || !article.textContent) {
    return { text: null, html: null, image, wordCount: 0, readTime: 0 };
  }

  const text = article.textContent.trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const readTime = Math.ceil(wordCount / WORDS_PER_MINUTE);

  return { text, html: article.content, image, wordCount, readTime };
}

/**
 * Process a batch of articles with pending content extraction.
 * @param {object} db - Database client
 * @param {number} limit - Max articles to process (default 5)
 */
export async function extractContentBatch(db, limit = 5) {
  const { rows } = await db.execute({
    sql: `SELECT a.id, a.url AS url, a.image_url, a.title, a.source_url, s.source_type
          FROM media_articles a
          JOIN media_sources s ON s.id = a.source_id
          WHERE a.content_fetch_status = 'pending' AND a.url IS NOT NULL
          LIMIT ?`,
    args: [limit],
  });

  let processed = 0;
  let errors = 0;

  for (const article of rows) {
    try {
      let fetchUrl = article.url;

      // Google News articles have unresolvable redirect URLs — resolve via publisher site
      if (article.source_type === "google_news" && article.source_url) {
        const resolved = await resolveGoogleNewsArticle(article.title, article.source_url);
        if (resolved) {
          // Update the article's URL to the real one
          await db.execute({
            sql: "UPDATE media_articles SET url = ? WHERE id = ?",
            args: [resolved, article.id],
          });
          fetchUrl = resolved;
        }
      }

      const result = await extractContent(fetchUrl);

      if (result.text) {
        await db.execute({
          sql: `UPDATE media_articles SET
                  content_full = ?,
                  image_url = COALESCE(image_url, ?),
                  estimated_read_time = ?,
                  content_fetch_status = 'done'
                WHERE id = ?`,
          args: [result.text, result.image || null, result.readTime, article.id],
        });
        processed++;
      } else {
        // Text extraction failed but we may still have an og:image — save it
        await db.execute({
          sql: `UPDATE media_articles SET
                  image_url = COALESCE(image_url, ?),
                  content_fetch_status = 'skipped'
                WHERE id = ?`,
          args: [result.image || null, article.id],
        });
      }
    } catch (err) {
      await db.execute({
        sql: "UPDATE media_articles SET content_fetch_status = 'failed' WHERE id = ?",
        args: [article.id],
      }).catch(() => {});
      errors++;
    }
  }

  return { processed, errors };
}
