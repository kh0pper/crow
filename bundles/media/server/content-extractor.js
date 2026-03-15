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
    sql: "SELECT id, url, image_url FROM media_articles WHERE content_fetch_status = 'pending' AND url IS NOT NULL LIMIT ?",
    args: [limit],
  });

  let processed = 0;
  let errors = 0;

  for (const article of rows) {
    try {
      const result = await extractContent(article.url);

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
