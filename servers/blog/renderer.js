/**
 * Blog Renderer — Markdown to sanitized HTML
 *
 * Uses marked for Markdown parsing and sanitize-html for XSS prevention.
 */

import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// Configure marked for GFM
marked.setOptions({ gfm: true, breaks: true });

/**
 * Render Markdown to sanitized HTML.
 * @param {string} markdown
 * @returns {string} Safe HTML
 */
export function renderMarkdown(markdown) {
  if (!markdown) return "";
  const raw = marked.parse(markdown);
  // Rewrite storage: URLs to public blog media route
  const processed = raw.replace(
    /(<img\s[^>]*src=")storage:([^"]+)(")/g,
    '$1/blog/media/$2$3'
  );
  return sanitizeHtml(processed, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img", "h1", "h2", "h3", "h4", "h5", "h6",
      "details", "summary", "figure", "figcaption",
      "pre", "code", "span", "del", "ins", "sup", "sub",
      "table", "thead", "tbody", "tr", "th", "td",
      "input", // for checkboxes in GFM task lists
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ["src", "alt", "title", "width", "height", "loading"],
      a: ["href", "title", "target", "rel"],
      code: ["class"],
      span: ["class"],
      pre: ["class"],
      input: ["type", "checked", "disabled"],
      th: ["align"],
      td: ["align"],
      // Phase 8: case-study figure wrappers carry class + data-* that
      // blog-hydrate.js reads to swap the static PNG for a live widget,
      // and schema.org microdata for SEO.
      figure: ["class", "data-section-id", "data-backend-id", "data-metric", "data-field"],
      article: ["class", "itemscope", "itemtype"],
      h1: ["itemprop"],
      h2: ["itemprop"],
      p: ["itemprop"],
    },
    allowedClasses: {
      code: ["language-*"],
      span: ["*"],
      pre: ["*"],
      figure: ["crow-chart", "crow-map", "crow-hydrated"],
      article: ["*"],
    },
    selfClosing: ["img", "br", "hr", "input"],
  });
}

/**
 * Generate a URL-safe slug from a title.
 * @param {string} title
 * @returns {string}
 */
// Slugs reserved for sub-routes (songbook index, etc.)
const RESERVED_SLUGS = new Set(["songbook"]);

export function generateSlug(title) {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (RESERVED_SLUGS.has(slug)) {
    slug = `${slug}-post`;
  }
  return slug;
}

/**
 * Generate a text excerpt from markdown content.
 * @param {string} markdown
 * @param {number} [maxLength=200]
 * @returns {string}
 */
export function generateExcerpt(markdown, maxLength = 200) {
  if (!markdown) return "";
  // Strip markdown syntax for plain text excerpt
  const plain = markdown
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/^[-*+]\s/gm, "")
    .replace(/^\d+\.\s/gm, "")
    .replace(/\n+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength).replace(/\s\S*$/, "") + "…";
}
