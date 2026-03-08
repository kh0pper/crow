/**
 * Blog Feed Generation — RSS 2.0 + Atom
 */

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate RSS 2.0 feed XML.
 * @param {object} opts
 * @param {string} opts.title - Blog title
 * @param {string} opts.description - Blog description
 * @param {string} opts.siteUrl - Base URL (e.g. https://example.com)
 * @param {string} opts.author - Default author
 * @param {Array} opts.posts - Array of { slug, title, excerpt, content_html, author, published_at, tags }
 * @returns {string} RSS XML
 */
export function generateRss(opts) {
  const { title, description, siteUrl, author, posts } = opts;
  const blogUrl = `${siteUrl}/blog`;

  const items = posts.map((post) => {
    const pubDate = post.published_at ? new Date(post.published_at).toUTCString() : "";
    const categories = (post.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `      <category>${escapeXml(t)}</category>`)
      .join("\n");

    return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${blogUrl}/${escapeXml(post.slug)}</link>
      <guid isPermaLink="true">${blogUrl}/${escapeXml(post.slug)}</guid>
      <description>${escapeXml(post.excerpt || "")}</description>
      <author>${escapeXml(post.author || author || "")}</author>
      <pubDate>${pubDate}</pubDate>
${categories}
    </item>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${blogUrl}</link>
    <description>${escapeXml(description || "")}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${blogUrl}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

/**
 * Generate Atom feed XML.
 * @param {object} opts - Same as generateRss
 * @returns {string} Atom XML
 */
export function generateAtom(opts) {
  const { title, description, siteUrl, author, posts } = opts;
  const blogUrl = `${siteUrl}/blog`;

  const entries = posts.map((post) => {
    const updated = post.published_at
      ? new Date(post.published_at).toISOString()
      : new Date().toISOString();
    const tags = (post.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `    <category term="${escapeXml(t)}"/>`)
      .join("\n");

    return `  <entry>
    <title>${escapeXml(post.title)}</title>
    <link href="${blogUrl}/${escapeXml(post.slug)}"/>
    <id>${blogUrl}/${escapeXml(post.slug)}</id>
    <updated>${updated}</updated>
    <summary>${escapeXml(post.excerpt || "")}</summary>
    <author><name>${escapeXml(post.author || author || "")}</name></author>
${tags}
  </entry>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(title)}</title>
  <subtitle>${escapeXml(description || "")}</subtitle>
  <link href="${blogUrl}"/>
  <link href="${blogUrl}/feed.atom" rel="self"/>
  <id>${blogUrl}</id>
  <updated>${new Date().toISOString()}</updated>
${entries}
</feed>`;
}
