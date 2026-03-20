/**
 * Podcast Player Panel — Subscribe to RSS feeds, browse episodes, playlists, audio player
 *
 * Third-party panel installed with the podcast add-on.
 * Uses dynamic imports to resolve gateway components at runtime via appRoot.
 */

import { join } from "node:path";

const FETCH_TIMEOUT = 5000;

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRSS(xml) {
  const getTag = (str, tag) => {
    const match = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return match ? match[1].trim() : null;
  };
  const getCDATA = (str) => {
    const m = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return m ? m[1] : str;
  };

  const channel = {
    title: getCDATA(getTag(xml, "title") || ""),
    description: getCDATA(getTag(xml, "description") || ""),
    image: null,
  };

  const itunesImg = xml.match(/<itunes:image\s+href="([^"]+)"/);
  if (itunesImg) channel.image = itunesImg[1];

  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    const item = m[1];
    const enclosure = item.match(/<enclosure[^>]+url="([^"]+)"/);
    const guid = getTag(item, "guid");
    const duration = item.match(/<itunes:duration>([^<]+)<\/itunes:duration>/);
    items.push({
      title: getCDATA(getTag(item, "title") || "Untitled"),
      description: getCDATA(getTag(item, "description") || ""),
      audio_url: enclosure ? enclosure[1] : null,
      pub_date: getTag(item, "pubDate"),
      guid: guid ? getCDATA(guid) : null,
      duration: duration ? duration[1] : null,
    });
  }
  return { channel, items };
}

let tablesInitialized = false;

async function handler(req, res, { db, layout, appRoot }) {
  const { pathToFileURL } = await import("node:url");
  const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
  const { escapeHtml, section, badge, dataTable, formField } = await import(pathToFileURL(componentsPath).href);

  // Initialize podcast tables on first call
  if (!tablesInitialized) {
    let initPath = join(import.meta.dirname, "..", "server", "init-tables.js");
    try {
      await import(pathToFileURL(initPath).href);
    } catch {
      // Fallback to ~/.crow/bundles/podcast/server/init-tables.js
      const os = await import("node:os");
      initPath = join(os.default.homedir(), ".crow", "bundles", "podcast", "server", "init-tables.js");
    }
    const { initPodcastTables } = await import(pathToFileURL(initPath).href);
    await initPodcastTables(db);
    tablesInitialized = true;
  }

  // --- POST actions ---
  if (req.method === "POST") {
    const { action } = req.body;

    if (action === "subscribe") {
      const feedUrl = (req.body.feed_url || "").trim();
      if (!feedUrl) return res.redirect("/dashboard/podcast-player?error=empty");

      try {
        const xml = await fetchFeed(feedUrl);
        const { channel, items } = parseRSS(xml);

        await db.execute({
          sql: `INSERT INTO podcast_subscriptions (feed_url, title, description, image_url, last_fetched)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(feed_url) DO UPDATE SET title = ?, description = ?, image_url = ?, last_fetched = datetime('now')`,
          args: [feedUrl, channel.title, channel.description, channel.image, channel.title, channel.description, channel.image],
        });

        const { rows: subRows } = await db.execute({ sql: "SELECT id FROM podcast_subscriptions WHERE feed_url = ?", args: [feedUrl] });
        const subId = subRows[0]?.id;

        if (subId && items.length > 0) {
          for (const ep of items.slice(0, 50)) {
            await db.execute({
              sql: `INSERT OR IGNORE INTO podcast_episodes (subscription_id, guid, title, description, audio_url, duration, pub_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
              args: [subId, ep.guid || ep.title, ep.title, ep.description?.substring(0, 5000), ep.audio_url, ep.duration, ep.pub_date],
            });
          }
        }
      } catch (err) {
        return res.redirect(`/dashboard/podcast-player?error=${encodeURIComponent(err.message)}`);
      }
      return res.redirect("/dashboard/podcast-player");
    }

    if (action === "unsubscribe") {
      const id = parseInt(req.body.subscription_id, 10);
      if (id) {
        await db.execute({ sql: "DELETE FROM podcast_subscriptions WHERE id = ?", args: [id] });
      }
      return res.redirect("/dashboard/podcast-player");
    }

    if (action === "toggle_listened") {
      const id = parseInt(req.body.episode_id, 10);
      if (id) {
        await db.execute({ sql: "UPDATE podcast_episodes SET listened = CASE WHEN listened = 1 THEN 0 ELSE 1 END WHERE id = ?", args: [id] });
      }
      return res.redirect("/dashboard/podcast-player");
    }

    if (action === "refresh") {
      const id = parseInt(req.body.subscription_id, 10);
      if (id) {
        const { rows } = await db.execute({ sql: "SELECT feed_url FROM podcast_subscriptions WHERE id = ?", args: [id] });
        if (rows[0]) {
          try {
            const xml = await fetchFeed(rows[0].feed_url);
            const { channel, items } = parseRSS(xml);
            await db.execute({
              sql: "UPDATE podcast_subscriptions SET title = ?, description = ?, image_url = ?, last_fetched = datetime('now') WHERE id = ?",
              args: [channel.title, channel.description, channel.image, id],
            });
            for (const ep of items.slice(0, 50)) {
              await db.execute({
                sql: `INSERT OR IGNORE INTO podcast_episodes (subscription_id, guid, title, description, audio_url, duration, pub_date)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [id, ep.guid || ep.title, ep.title, ep.description?.substring(0, 5000), ep.audio_url, ep.duration, ep.pub_date],
              });
            }
          } catch {
            // Refresh failed — silently continue
          }
        }
      }
      return res.redirect("/dashboard/podcast-player");
    }
  }

  // --- GET: Build page ---
  const errorMsg = req.query.error
    ? `<div class="alert alert-error" style="margin-bottom:1rem">${req.query.error === "empty" ? "Please enter a feed URL." : `Error: ${escapeHtml(req.query.error)}`}</div>`
    : "";

  const [subsResult, episodeCountResult] = await Promise.all([
    db.execute("SELECT * FROM podcast_subscriptions ORDER BY title ASC"),
    db.execute("SELECT COUNT(*) as c FROM podcast_episodes"),
  ]);

  const subs = subsResult.rows;
  const totalEpisodes = episodeCountResult.rows[0]?.c || 0;

  // Subscribe form
  const subscribeForm = `
    <form method="POST" style="display:flex;gap:0.5rem;align-items:end;flex-wrap:wrap">
      <input type="hidden" name="action" value="subscribe">
      <div style="flex:1;min-width:250px">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:4px">RSS Feed URL</label>
        <input type="url" name="feed_url" placeholder="https://example.com/feed.xml" required
               style="width:100%;padding:0.5rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
      </div>
      <button type="submit" class="btn btn-primary">Subscribe</button>
    </form>`;

  // Subscriptions list
  let subsHtml;
  if (subs.length === 0) {
    subsHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No subscriptions yet. Add an RSS feed above to get started.</p>`;
  } else {
    const subCards = subs.map((s) => {
      const img = s.image_url
        ? `<img src="${escapeHtml(s.image_url)}" alt="" style="width:48px;height:48px;border-radius:6px;object-fit:cover;flex-shrink:0">`
        : `<div style="width:48px;height:48px;border-radius:6px;background:var(--crow-accent-muted);display:flex;align-items:center;justify-content:center;color:var(--crow-accent);font-family:'Fraunces',serif;font-size:1.2rem;flex-shrink:0">${escapeHtml((s.title || "?").charAt(0))}</div>`;

      const lastFetched = s.last_fetched ? new Date(s.last_fetched).toLocaleDateString() : "Never";

      return `<div class="card" style="display:flex;gap:0.75rem;align-items:center;padding:0.75rem">
        ${img}
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.title || s.feed_url)}</div>
          <div style="font-size:0.8rem;color:var(--crow-text-muted)">Last fetched: ${escapeHtml(lastFetched)}</div>
        </div>
        <div style="display:flex;gap:0.25rem">
          <form method="POST" style="display:inline"><input type="hidden" name="action" value="refresh"><input type="hidden" name="subscription_id" value="${s.id}"><button type="submit" class="btn btn-sm btn-secondary" title="Refresh">&#8635;</button></form>
          <form method="POST" style="display:inline" onsubmit="return confirm('Unsubscribe from this podcast?')"><input type="hidden" name="action" value="unsubscribe"><input type="hidden" name="subscription_id" value="${s.id}"><button type="submit" class="btn btn-sm btn-secondary" style="color:var(--crow-error)" title="Unsubscribe">&#10005;</button></form>
        </div>
      </div>`;
    }).join("\n");

    subsHtml = `<div style="display:flex;flex-direction:column;gap:0.5rem">${subCards}</div>`;
  }

  // Recent episodes (latest 20)
  let episodesHtml;
  if (totalEpisodes === 0) {
    episodesHtml = `<p style="color:var(--crow-text-muted);text-align:center;padding:1rem">No episodes yet. Subscribe to a podcast to see episodes here.</p>`;
  } else {
    const { rows: episodes } = await db.execute({
      sql: `SELECT e.*, s.title as podcast_title FROM podcast_episodes e
            JOIN podcast_subscriptions s ON s.id = e.subscription_id
            ORDER BY e.pub_date DESC LIMIT 20`,
      args: [],
    });

    episodesHtml = episodes.map((ep) => {
      const listenedBadge = ep.listened ? badge("Played", "draft") : badge("New", "connected");
      const durationStr = ep.duration || "";
      const pubDate = ep.pub_date ? new Date(ep.pub_date).toLocaleDateString() : "";
      const audioPlayer = ep.audio_url
        ? `<audio controls preload="none" style="width:100%;height:32px;margin-top:0.5rem"><source src="${escapeHtml(ep.audio_url)}" type="audio/mpeg">Your browser does not support audio.</audio>`
        : "";

      return `<div class="card" style="padding:0.75rem;margin-bottom:0.5rem">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:0.5rem">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500">${escapeHtml(ep.title)}</div>
            <div style="font-size:0.8rem;color:var(--crow-text-muted)">${escapeHtml(ep.podcast_title)} &middot; ${escapeHtml(pubDate)} ${durationStr ? `&middot; ${escapeHtml(durationStr)}` : ""}</div>
          </div>
          <div style="display:flex;gap:0.25rem;align-items:center">
            ${listenedBadge}
            <form method="POST" style="display:inline"><input type="hidden" name="action" value="toggle_listened"><input type="hidden" name="episode_id" value="${ep.id}"><button type="submit" class="btn btn-sm btn-secondary">${ep.listened ? "&#8617;" : "&#10003;"}</button></form>
          </div>
        </div>
        ${audioPlayer}
      </div>`;
    }).join("\n");
  }

  const content = `
    ${errorMsg}
    ${section("Subscribe", subscribeForm, { delay: 200 })}
    ${section("Subscriptions", subsHtml, { delay: 250 })}
    ${section("Recent Episodes", episodesHtml, { delay: 300 })}
  `;

  return layout({ title: "Podcast Player", content });
}

export default {
  id: "podcast-player",
  name: "Podcast Player",
  icon: "mic",
  route: "/dashboard/podcast-player",
  navOrder: 22,
  handler,
};
