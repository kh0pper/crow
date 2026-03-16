/**
 * RSS/Atom Feed Fetcher
 *
 * Fetches and parses RSS 2.0 and Atom feeds. Uses lightweight regex-based
 * XML parsing (no external XML library required).
 */

const FETCH_TIMEOUT = 10000;
const USER_AGENT = "Crow/1.0 (RSS Reader; +https://github.com/kh0pp/crow)";

/**
 * Fetch a feed URL and return the raw XML text.
 * @param {string} url - Feed URL
 * @returns {Promise<string>} Raw XML
 */
export async function fetchFeedXml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse RSS 2.0 or Atom feed XML into a normalized structure.
 * @param {string} xml - Raw XML text
 * @returns {{ feed: { title, description, link, image }, items: Array<{ guid, title, link, author, pub_date, content, summary }> }}
 */
export function parseFeed(xml) {
  // Detect Atom vs RSS
  if (xml.includes("<feed") && xml.includes("xmlns=\"http://www.w3.org/2005/Atom\"")) {
    return parseAtom(xml);
  }
  return parseRss(xml);
}

/**
 * Fetch and parse a feed URL in one call.
 * @param {string} url
 * @returns {Promise<{ feed, items }>}
 */
export async function fetchAndParseFeed(url) {
  const xml = await fetchFeedXml(url);
  return parseFeed(xml);
}

// --- Image extraction ---

/**
 * Extract the best image URL from an RSS/Atom item's raw XML.
 * Priority: media:content → media:thumbnail → enclosure (image/*) → itunes:image
 * @param {string} itemXml - Raw XML of a single <item> or <entry>
 * @returns {string|null}
 */
function extractItemImage(itemXml) {
  // 1. <media:thumbnail url="..."> (always an image — check first)
  const mediaThumbnail = itemXml.match(/<media:thumbnail[^>]+url="([^"]+)"/);
  if (mediaThumbnail) return mediaThumbnail[1];

  // 2. <media:content> with image type only (YouTube uses type="application/x-shockwave-flash" here)
  const mediaContent = itemXml.match(/<media:content[^>]+type="image\/[^"]*"[^>]+url="([^"]+)"/) ||
                       itemXml.match(/<media:content[^>]+url="([^"]+)"[^>]+type="image\/[^"]*"/);
  if (mediaContent) return mediaContent[1];

  // 3. <enclosure> with type="image/..."
  const enclosure = itemXml.match(/<enclosure[^>]+type="image\/[^"]*"[^>]+url="([^"]+)"/);
  if (enclosure) return enclosure[1];
  // Also check reversed attribute order
  const enclosure2 = itemXml.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image\/[^"]*"/);
  if (enclosure2) return enclosure2[1];

  // 4. <itunes:image href="...">
  const itunesImage = itemXml.match(/<itunes:image[^>]+href="([^"]+)"/);
  if (itunesImage) return itunesImage[1];

  return null;
}

// --- YouTube ---

/**
 * Extract a YouTube channel ID from various URL formats.
 * Supports: /channel/UCxxx, /@handle, /c/name, /user/name, raw channel ID.
 * For @handle formats, fetches the page HTML to extract channelId.
 * @param {string} input - Channel URL, handle, or ID
 * @returns {Promise<string>} Channel ID (UC...)
 */
export async function extractYoutubeChannelId(input) {
  if (!input) throw new Error("No YouTube channel provided.");

  const trimmed = input.trim();

  // Raw channel ID
  if (/^UC[\w-]{22}$/.test(trimmed)) return trimmed;

  // URL parsing
  let url;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://www.youtube.com/${trimmed.startsWith("@") ? trimmed : `@${trimmed}`}`);
  } catch {
    throw new Error(`Invalid YouTube channel: "${input}"`);
  }

  const path = url.pathname;

  // /channel/UCxxx
  const channelMatch = path.match(/\/channel\/(UC[\w-]{22})/);
  if (channelMatch) return channelMatch[1];

  // /@handle, /c/name, /user/name — need to fetch page to get channel ID
  if (path.match(/^\/@[\w.-]+/) || path.match(/^\/c\//) || path.match(/^\/user\//)) {
    const pageUrl = `https://www.youtube.com${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(pageUrl, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      if (!res.ok) throw new Error(`YouTube returned HTTP ${res.status}`);
      const html = await res.text();

      // Look for channel ID in meta tags or page data
      const metaMatch = html.match(/(?:<meta[^>]+content="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})")|(?:"channelId":"(UC[\w-]{22})")/);
      if (metaMatch) return metaMatch[1] || metaMatch[2];

      // Try externalId pattern
      const extMatch = html.match(/"externalId":"(UC[\w-]{22})"/);
      if (extMatch) return extMatch[1];

      throw new Error("Could not find channel ID on page.");
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Could not parse YouTube channel from: "${input}"`);
}

/**
 * Build a YouTube RSS feed URL from a channel ID.
 * @param {string} channelId - YouTube channel ID (UC...)
 * @returns {string} RSS feed URL
 */
export function buildYoutubeRssUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// --- Google News ---

/**
 * Build a Google News RSS search URL.
 * @param {string} query - Search query
 * @param {object} [opts] - Options: hl, gl, ceid
 * @returns {string}
 */
export function buildGoogleNewsUrl(query, { hl = "en-US", gl = "US", ceid = "US:en" } = {}) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

/**
 * Post-process Google News items: strip source name suffix from titles.
 * @param {Array} items - Parsed feed items
 * @returns {Array} Same items array, mutated
 */
export function postProcessGoogleNewsItems(items) {
  for (const item of items) {
    if (item.title && item.title.includes(' - ')) {
      const lastDash = item.title.lastIndexOf(' - ');
      if (lastDash > 0) {
        const sourceName = item.title.slice(lastDash + 3).trim();
        item.title = item.title.slice(0, lastDash).trim();
        if (!item.author) item.author = sourceName;
      }
    }
  }
  return items;
}

// --- Internal parsers ---

function getTag(str, tag) {
  const match = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : null;
}

function getCDATA(str) {
  if (!str) return "";
  const m = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : str;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function parseRss(xml) {
  const channel = xml.match(/<channel>([\s\S]*?)<\/channel>/);
  const channelContent = channel ? channel[1] : xml;

  // Extract channel info (stop at first <item> to avoid picking up item titles)
  const preItems = channelContent.split(/<item>/)[0];

  const feed = {
    title: getCDATA(getTag(preItems, "title") || ""),
    description: getCDATA(getTag(preItems, "description") || ""),
    link: getTag(preItems, "link") || "",
    image: null,
    isPodcast: false,
  };

  // Image: itunes:image or <image><url>
  const itunesImg = preItems.match(/<itunes:image\s+href="([^"]+)"/);
  if (itunesImg) {
    feed.image = itunesImg[1];
  } else {
    const imgUrl = preItems.match(/<image>[\s\S]*?<url>([^<]+)<\/url>/);
    if (imgUrl) feed.image = imgUrl[1].trim();
  }

  const items = [];
  let hasAudioEnclosures = false;
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    const item = m[1];
    const guid = getTag(item, "guid");
    const link = getTag(item, "link");

    // Detect audio enclosures for podcast detection
    const audioEnclosure = item.match(/<enclosure[^>]+type="audio\/[^"]*"[^>]+url="([^"]+)"/) ||
                           item.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="audio\/[^"]*"/);
    if (audioEnclosure) hasAudioEnclosures = true;

    // <source url="https://apnews.com">AP News</source> (Google News provides this)
    const sourceUrlMatch = item.match(/<source\s+url="([^"]+)"/);

    items.push({
      guid: guid ? getCDATA(guid) : link || null,
      title: getCDATA(getTag(item, "title") || "Untitled"),
      link: link || "",
      author: getCDATA(getTag(item, "dc:creator") || getTag(item, "author") || ""),
      pub_date: getTag(item, "pubDate") || getTag(item, "dc:date") || null,
      content: getCDATA(getTag(item, "content:encoded") || ""),
      summary: stripHtml(getCDATA(getTag(item, "description") || "")),
      image: extractItemImage(item),
      enclosureAudio: audioEnclosure ? audioEnclosure[1] : null,
      sourceUrl: sourceUrlMatch ? sourceUrlMatch[1] : null,
    });
  }

  // If most items have audio enclosures, mark as podcast
  if (hasAudioEnclosures && items.length > 0) {
    const audioCount = items.filter(i => i.enclosureAudio).length;
    feed.isPodcast = audioCount / items.length >= 0.5;
  }

  return { feed, items };
}

function parseAtom(xml) {
  const feed = {
    title: getCDATA(getTag(xml, "title") || ""),
    description: getCDATA(getTag(xml, "subtitle") || ""),
    link: "",
    image: null,
  };

  // Atom links: <link rel="alternate" href="..."/>
  const linkMatch = xml.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/);
  if (linkMatch) feed.link = linkMatch[1];

  const logoMatch = getTag(xml, "logo") || getTag(xml, "icon");
  if (logoMatch) feed.image = logoMatch;

  const items = [];
  const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g);
  for (const m of entryMatches) {
    const entry = m[1];
    const id = getTag(entry, "id");
    const entryLink = entry.match(/<link[^>]+href="([^"]+)"/);

    // Content: prefer <content>, fall back to <summary>
    const content = getCDATA(getTag(entry, "content") || "");
    const summary = stripHtml(getCDATA(getTag(entry, "summary") || ""));

    // Author
    const authorBlock = getTag(entry, "author");
    const authorName = authorBlock ? getCDATA(getTag(authorBlock, "name") || "") : "";

    items.push({
      guid: id || (entryLink ? entryLink[1] : null),
      title: getCDATA(getTag(entry, "title") || "Untitled"),
      link: entryLink ? entryLink[1] : "",
      author: authorName,
      pub_date: getTag(entry, "published") || getTag(entry, "updated") || null,
      content,
      summary: summary || stripHtml(content).slice(0, 500),
      image: extractItemImage(entry),
    });
  }

  return { feed, items };
}
