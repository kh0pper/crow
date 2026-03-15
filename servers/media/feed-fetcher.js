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
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    const item = m[1];
    const guid = getTag(item, "guid");
    const link = getTag(item, "link");

    items.push({
      guid: guid ? getCDATA(guid) : link || null,
      title: getCDATA(getTag(item, "title") || "Untitled"),
      link: link || "",
      author: getCDATA(getTag(item, "dc:creator") || getTag(item, "author") || ""),
      pub_date: getTag(item, "pubDate") || getTag(item, "dc:date") || null,
      content: getCDATA(getTag(item, "content:encoded") || ""),
      summary: stripHtml(getCDATA(getTag(item, "description") || "")),
    });
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
    });
  }

  return { feed, items };
}
