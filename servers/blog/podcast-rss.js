/**
 * Podcast RSS Feed Generation — iTunes-compatible
 *
 * Generates an RSS feed with iTunes namespace extensions for podcast
 * directory submission (Apple Podcasts, Spotify, etc.).
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
 * Parse podcast metadata from post content.
 *
 * Looks for lines like:
 *   **Audio:** https://example.com/ep1.mp3
 *   **Duration:** 45:32
 *   **Episode:** 12
 *   **Season:** 2
 *
 * @param {string} content - Post markdown content
 * @returns {{ audioUrl: string|null, duration: string|null, episodeNumber: number|null, season: number|null }}
 */
function parsePodcastMeta(content) {
  if (!content) return { audioUrl: null, duration: null, episodeNumber: null, season: null };

  const audioMatch = content.match(/\*\*Audio:\*\*\s*(.+)/i);
  const durationMatch = content.match(/\*\*Duration:\*\*\s*(.+)/i);
  const episodeMatch = content.match(/\*\*Episode:\*\*\s*(\d+)/i);
  const seasonMatch = content.match(/\*\*Season:\*\*\s*(\d+)/i);

  return {
    audioUrl: audioMatch ? audioMatch[1].trim() : null,
    duration: durationMatch ? durationMatch[1].trim() : null,
    episodeNumber: episodeMatch ? parseInt(episodeMatch[1], 10) : null,
    season: seasonMatch ? parseInt(seasonMatch[1], 10) : null,
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
 * Generate an iTunes-compatible podcast RSS feed.
 *
 * @param {Array} posts - Array of published blog posts with tag "podcast".
 *   Each post should have: { slug, title, excerpt, content, author, published_at, tags }
 * @param {object} settings - Podcast/blog settings.
 *   { title, tagline, author, siteUrl, coverImageUrl? }
 * @returns {string} RSS XML with iTunes namespace
 */
export function generatePodcastFeed(posts, settings) {
  const {
    title = "Podcast",
    tagline = "",
    author = "",
    siteUrl = "",
    coverImageUrl = "",
  } = settings;

  const blogUrl = `${siteUrl}/blog`;
  const feedUrl = `${siteUrl}/blog/podcast.xml`;

  const items = posts.map((post) => {
    const meta = parsePodcastMeta(post.content);
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
      enclosure = `      <enclosure url="${escapeXml(meta.audioUrl)}" type="${mime}" length="0"/>`;
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
${categories}
    </item>`;
  }).join("\n");

  let itunesImage = "";
  if (coverImageUrl) {
    itunesImage = `    <itunes:image href="${escapeXml(coverImageUrl)}"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:itunes="http://www.itunes.apple.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${blogUrl}</link>
    <description>${escapeXml(tagline)}</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <itunes:author>${escapeXml(author)}</itunes:author>
    <itunes:summary>${escapeXml(tagline)}</itunes:summary>
${itunesImage}
    <itunes:category text="Society &amp; Culture"/>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>`;
}
