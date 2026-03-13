/**
 * Podcast Panel — List, create, publish, preview podcast episodes
 *
 * Third-party panel installed with the podcast add-on.
 * Episodes are blog posts tagged "podcast" with audio metadata in content.
 */

import { join } from "node:path";

async function handler(req, res, { db, layout, appRoot }) {
  const { pathToFileURL } = await import("node:url");
  const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
  const { escapeHtml, statCard, statGrid, dataTable, formField, badge, actionBar, section, formatDate } = await import(pathToFileURL(componentsPath).href);

  const podcastRssPath = join(appRoot, "servers/blog/podcast-rss.js");
  const { parsePodcastMeta } = await import(pathToFileURL(podcastRssPath).href);

  // Handle POST actions
  if (req.method === "POST") {
    const { action } = req.body;

    if (action === "create") {
      const { title, audio_url, duration, episode_number, season_number, show_notes, visibility } = req.body;
      if (!title || !audio_url) {
        return layout({
          title: "Podcast",
          content: `<div class="alert alert-error">Title and Audio URL are required.</div>`,
        });
      }
      const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);

      // Build content in the format podcast-rss.js expects
      let content = `**Audio:** ${audio_url}\n`;
      if (duration) content += `**Duration:** ${duration}\n`;
      if (episode_number) content += `**Episode:** ${episode_number}\n`;
      if (season_number) content += `**Season:** ${season_number}\n`;
      content += `\n${show_notes || ""}`;

      await db.execute({
        sql: "INSERT INTO blog_posts (slug, title, content, visibility, tags) VALUES (?, ?, ?, ?, ?)",
        args: [slug, title, content, visibility || "public", "podcast"],
      });
      res.redirect("/dashboard/podcast");
      return;
    }

    if (action === "publish") {
      await db.execute({
        sql: "UPDATE blog_posts SET status = 'published', published_at = datetime('now') WHERE id = ?",
        args: [req.body.id],
      });
      res.redirect("/dashboard/podcast");
      return;
    }

    if (action === "unpublish") {
      await db.execute({
        sql: "UPDATE blog_posts SET status = 'draft', published_at = NULL WHERE id = ?",
        args: [req.body.id],
      });
      res.redirect("/dashboard/podcast");
      return;
    }

    if (action === "delete") {
      await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [req.body.id] });
      res.redirect("/dashboard/podcast");
      return;
    }
  }

  // GET — show episode list
  const episodes = await db.execute({
    sql: "SELECT * FROM blog_posts WHERE tags LIKE ? ORDER BY created_at DESC LIMIT 50",
    args: ["%podcast%"],
  });

  const totalCount = episodes.rows.length;
  const publishedCount = episodes.rows.filter((r) => r.status === "published").length;
  const draftCount = episodes.rows.filter((r) => r.status === "draft").length;

  const stats = statGrid([
    statCard("Episodes", totalCount, { delay: 0 }),
    statCard("Published", publishedCount, { delay: 50 }),
    statCard("Drafts", draftCount, { delay: 100 }),
  ]);

  // RSS feed URL
  const feedUrl = `${req.protocol}://${req.get("host")}/blog/podcast.xml`;
  const feedSection = `<div style="background:var(--crow-surface);border:1px solid var(--crow-border);border-radius:8px;padding:1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
    <span style="font-weight:600;color:var(--crow-text)">RSS Feed</span>
    <code id="podcast-feed-url" style="flex:1;min-width:200px;padding:0.4rem 0.6rem;background:var(--crow-bg);border-radius:4px;font-size:0.85rem;word-break:break-all">${escapeHtml(feedUrl)}</code>
    <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText(document.getElementById('podcast-feed-url').textContent).then(function(){this.textContent='Copied!'}.bind(this)).catch(function(){})">Copy</button>
    <a href="${escapeHtml(feedUrl)}" target="_blank" class="btn btn-sm btn-secondary">Open</a>
  </div>`;

  // Episode table
  let episodeTable;
  if (episodes.rows.length === 0) {
    episodeTable = `<div class="empty-state">
      <div style="margin-bottom:1rem;font-size:3rem;opacity:0.5">&#127908;</div>
      <h3>No episodes yet</h3>
      <p>Create your first podcast episode below.</p>
    </div>`;
  } else {
    const rows = episodes.rows.map((p) => {
      const meta = parsePodcastMeta(p.content);
      const statusBadge = badge(p.status, p.status === "published" ? "published" : "draft");

      const epNum = meta.episodeNumber !== null ? String(meta.episodeNumber) : "-";
      const dur = meta.duration || "-";

      let audioPreview = "-";
      if (meta.audioUrl) {
        audioPreview = `<audio controls preload="none" style="height:32px;width:200px"><source src="${escapeHtml(meta.audioUrl)}"></audio>`;
      }

      const actions = p.status === "published"
        ? `<form method="POST" style="display:inline"><input type="hidden" name="action" value="unpublish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-secondary" type="submit">Unpublish</button></form>`
        : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="publish"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-primary" type="submit">Publish</button></form>`;
      const deleteBtn = `<form method="POST" style="display:inline;margin-left:0.25rem" onsubmit="return confirm('Delete this episode?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`;

      return [
        escapeHtml(epNum),
        escapeHtml(p.title),
        escapeHtml(dur),
        statusBadge,
        `<span class="mono">${formatDate(p.published_at || p.created_at)}</span>`,
        audioPreview,
        `${actions} ${deleteBtn}`,
      ];
    });
    episodeTable = dataTable(["Ep#", "Title", "Duration", "Status", "Date", "Audio Preview", "Actions"], rows);
  }

  // Create form
  const createForm = `<form method="POST">
    <input type="hidden" name="action" value="create">
    ${formField("Title", "title", { required: true, placeholder: "Episode title" })}
    ${formField("Audio URL", "audio_url", { required: true, placeholder: "https://example.com/episode.mp3" })}
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem">
      ${formField("Duration", "duration", { placeholder: "45:32" })}
      ${formField("Episode #", "episode_number", { placeholder: "1" })}
      ${formField("Season #", "season_number", { placeholder: "1" })}
    </div>
    ${formField("Show Notes", "show_notes", { type: "textarea", placeholder: "Episode description and show notes (Markdown supported)...", rows: 6 })}
    ${formField("Visibility", "visibility", { type: "select", options: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" },
      { value: "peers", label: "Peers Only" },
    ]})}
    <button type="submit" class="btn btn-primary">Create Episode</button>
  </form>`;

  const content = `
    ${stats}
    ${feedSection}
    ${section("Episodes", episodeTable, { delay: 150 })}
    ${section("New Episode", createForm, { delay: 200 })}
  `;

  return layout({ title: "Podcast", content });
}

export default {
  id: "podcast",
  name: "Podcast",
  icon: "mic",
  route: "/dashboard/podcast",
  navOrder: 25,
  handler,
};
