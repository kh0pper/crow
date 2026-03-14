/**
 * Podcast RSS Feed Generation — iTunes-compatible
 *
 * Generates an RSS feed with iTunes namespace extensions for podcast
 * directory submission (Apple Podcasts, Spotify, etc.).
 */

import https from "https";
import http from "http";

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
 * Parse podcast metadata from post content.
 *
 * Looks for lines like:
 *   **Audio:** https://example.com/ep1.mp3
 *   **Duration:** 45:32
 *   **Episode:** 12
 *   **Season:** 2
 *   **Artwork:** https://example.com/ep1-cover.jpg
 *
 * @param {string} content - Post markdown content
 * @returns {{ audioUrl: string|null, duration: string|null, episodeNumber: number|null, season: number|null, artworkUrl: string|null, showNotes: string|null }}
 */
export function parsePodcastMeta(content) {
  if (!content) return { audioUrl: null, duration: null, episodeNumber: null, season: null, artworkUrl: null, showNotes: null };

  const audioMatch = content.match(/\*\*Audio:\*\*\s*(.+)/i);
  const durationMatch = content.match(/\*\*Duration:\*\*\s*(.+)/i);
  const episodeMatch = content.match(/\*\*Episode:\*\*\s*(\d+)/i);
  const seasonMatch = content.match(/\*\*Season:\*\*\s*(\d+)/i);
  const artworkMatch = content.match(/\*\*Artwork:\*\*\s*(.+)/i);

  // Show notes = everything after the metadata block (lines not starting with **)
  const lines = content.split("\n");
  const noteLines = [];
  let pastMeta = false;
  for (const line of lines) {
    if (pastMeta) {
      noteLines.push(line);
    } else if (line.trim() && !line.trim().startsWith("**")) {
      pastMeta = true;
      noteLines.push(line);
    } else if (!line.trim()) {
      // Blank line after metadata block signals start of show notes
      if (noteLines.length === 0 && lines.indexOf(line) > 0) {
        pastMeta = true;
      }
    }
  }
  const showNotes = noteLines.join("\n").trim() || null;

  return {
    audioUrl: audioMatch ? audioMatch[1].trim() : null,
    duration: durationMatch ? durationMatch[1].trim() : null,
    episodeNumber: episodeMatch ? parseInt(episodeMatch[1], 10) : null,
    season: seasonMatch ? parseInt(seasonMatch[1], 10) : null,
    artworkUrl: artworkMatch ? artworkMatch[1].trim() : null,
    showNotes,
  };
}

/**
 * Guess MIME type from audio URL.
 */
function audioMimeType(url) {
  if (!url) return "audio/mpeg";
  const lower = url.toLowerCase();
  if (lower.endsWith(".m4a") || lower.endsWith(".aac")) return "audio/x-m4a";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "audio/mpeg";
}

/**
 * Fetch Content-Length of a URL via HEAD request.
 * Returns the size in bytes, or 0 if unavailable.
 * Timeout after 5 seconds per request.
 */
function fetchContentLength(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(0); return; }
    try {
      const mod = url.startsWith("https") ? https : http;
      const req = mod.request(url, { method: "HEAD", timeout: 5000 }, (res) => {
        const len = parseInt(res.headers["content-length"], 10);
        resolve(isNaN(len) ? 0 : len);
      });
      req.on("error", () => resolve(0));
      req.on("timeout", () => { req.destroy(); resolve(0); });
      req.end();
    } catch {
      resolve(0);
    }
  });
}

/**
 * Parse iTunes category string into XML.
 * Supports subcategories with " > " delimiter.
 * e.g. "Society & Culture > Philosophy" → nested XML
 */
function buildCategoryXml(categoryStr) {
  if (!categoryStr) return `    <itunes:category text="Society &amp; Culture"/>`;
  const parts = categoryStr.split(">").map((s) => s.trim());
  if (parts.length === 1) {
    return `    <itunes:category text="${escapeXml(parts[0])}"/>`;
  }
  return `    <itunes:category text="${escapeXml(parts[0])}">
      <itunes:category text="${escapeXml(parts[1])}"/>
    </itunes:category>`;
}

/**
 * Generate an iTunes-compatible podcast RSS feed.
 *
 * @param {Array} posts - Array of published blog posts with tag "podcast".
 *   Each post should have: { slug, title, excerpt, content, author, published_at, tags, cover_image_key? }
 * @param {object} settings - Podcast/blog settings.
 *   { title, tagline, author, siteUrl, coverImageUrl?, ownerEmail?, category?, showType?, language? }
 * @returns {Promise<string>} RSS XML with iTunes namespace
 */
export async function generatePodcastFeed(posts, settings) {
  const {
    title = "Podcast",
    tagline = "",
    author = "",
    siteUrl = "",
    coverImageUrl = "",
    ownerEmail = "",
    category = "Society & Culture",
    showType = "episodic",
    language = "en",
  } = settings;

  const blogUrl = `${siteUrl}/blog`;
  const feedUrl = `${siteUrl}/blog/podcast.xml`;

  // Fetch content lengths for all audio URLs in parallel
  const metas = posts.map((post) => parsePodcastMeta(post.content));
  const audioUrls = metas.map((m) => m.audioUrl);
  const contentLengths = await Promise.all(audioUrls.map(fetchContentLength));

  const items = posts.map((post, i) => {
    const meta = metas[i];
    const pubDate = post.published_at ? new Date(post.published_at).toUTCString() : "";
    const postUrl = `${blogUrl}/${escapeXml(post.slug)}`;
    const postAuthor = post.author || author;

    const categories = (post.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t && t.toLowerCase() !== "podcast")
      .map((t) => `      <category>${escapeXml(t)}</category>`)
      .join("\n");

    let enclosure = "";
    if (meta.audioUrl) {
      const mime = audioMimeType(meta.audioUrl);
      const fileSize = contentLengths[i] || 0;
      enclosure = `      <enclosure url="${escapeXml(meta.audioUrl)}" type="${mime}" length="${fileSize}"/>`;
    }

    let itunesEpisode = "";
    if (meta.episodeNumber !== null) {
      itunesEpisode = `      <itunes:episode>${meta.episodeNumber}</itunes:episode>`;
    }

    let itunesSeason = "";
    if (meta.season !== null) {
      itunesSeason = `      <itunes:season>${meta.season}</itunes:season>`;
    }

    let itunesDuration = "";
    if (meta.duration) {
      itunesDuration = `      <itunes:duration>${escapeXml(meta.duration)}</itunes:duration>`;
    }

    // Per-episode artwork (from **Artwork:** metadata or post cover image)
    let itunesImage = "";
    const artworkUrl = meta.artworkUrl || (post.cover_image_key ? `${siteUrl}/blog/media/${encodeURIComponent(post.cover_image_key)}` : "");
    if (artworkUrl) {
      itunesImage = `      <itunes:image href="${escapeXml(artworkUrl)}"/>`;
    }

    // Show notes as content:encoded (HTML)
    let contentEncoded = "";
    if (meta.showNotes) {
      contentEncoded = `      <content:encoded><![CDATA[${meta.showNotes.replace(/]]>/g, "]]]]><![CDATA[>")}]]></content:encoded>`;
    }

    return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <description>${escapeXml(post.excerpt || "")}</description>
      <author>${escapeXml(postAuthor)}</author>
      <pubDate>${pubDate}</pubDate>
${enclosure}
      <itunes:author>${escapeXml(postAuthor)}</itunes:author>
      <itunes:summary>${escapeXml(post.excerpt || "")}</itunes:summary>
      <itunes:explicit>false</itunes:explicit>
${itunesEpisode}
${itunesSeason}
${itunesDuration}
${itunesImage}
${contentEncoded}
${categories}
    </item>`;
  }).join("\n");

  let channelImage = "";
  if (coverImageUrl) {
    channelImage = `    <itunes:image href="${escapeXml(coverImageUrl)}"/>`;
  }

  let ownerBlock = "";
  if (ownerEmail || author) {
    ownerBlock = `    <itunes:owner>
      <itunes:name>${escapeXml(author)}</itunes:name>
      <itunes:email>${escapeXml(ownerEmail)}</itunes:email>
    </itunes:owner>`;
  }

  const categoryXml = buildCategoryXml(category);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:itunes="http://www.itunes.apple.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${blogUrl}</link>
    <description>${escapeXml(tagline)}</description>
    <language>${escapeXml(language)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <itunes:author>${escapeXml(author)}</itunes:author>
    <itunes:summary>${escapeXml(tagline)}</itunes:summary>
    <itunes:type>${escapeXml(showType)}</itunes:type>
${channelImage}
${ownerBlock}
${categoryXml}
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>`;
}
