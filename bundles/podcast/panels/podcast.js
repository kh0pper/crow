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

  // Check if storage is available for file uploads
  let storageOnline = false;
  try {
    const { isAvailable } = await import(pathToFileURL(join(appRoot, "servers/storage/s3-client.js")).href);
    storageOnline = await isAvailable();
  } catch { /* storage not configured */ }

  // Handle POST actions
  if (req.method === "POST") {
    const { action } = req.body;

    if (action === "create") {
      const { title, audio_url, duration, episode_number, season_number, show_notes, visibility, artwork_url } = req.body;
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
      if (artwork_url) content += `**Artwork:** ${artwork_url}\n`;
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
  const countResult = await db.execute({
    sql: "SELECT COUNT(*) as total, SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) as published FROM blog_posts WHERE tags LIKE ?",
    args: ["%podcast%"],
  });
  const totalCount = countResult.rows[0]?.total || 0;
  const publishedCount = countResult.rows[0]?.published || 0;
  const draftCount = totalCount - publishedCount;

  const episodes = await db.execute({
    sql: "SELECT * FROM blog_posts WHERE tags LIKE ? ORDER BY created_at DESC LIMIT 50",
    args: ["%podcast%"],
  });

  const stats = statGrid([
    statCard("Episodes", totalCount, { delay: 0 }),
    statCard("Published", publishedCount, { delay: 50 }),
    statCard("Drafts", draftCount, { delay: 100 }),
  ]);

  // RSS feed URL — prefer public URL for podcast directories
  const siteUrl = process.env.CROW_GATEWAY_URL || `${req.protocol}://${req.get("host")}`;
  const feedUrl = `${siteUrl}/blog/podcast.xml`;
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

  // Audio upload section — file upload when storage is online, URL fallback otherwise
  const audioField = storageOnline
    ? `<div class="form-group" style="margin-bottom:1rem">
        <label style="display:block;font-weight:500;margin-bottom:0.5rem">Audio File</label>
        <div id="audio-upload-zone" style="border:2px dashed var(--crow-border);border-radius:8px;padding:1.25rem;text-align:center;cursor:pointer;transition:border-color 0.2s,background 0.2s">
          <div style="margin-bottom:0.5rem">Drop audio file here or click to browse</div>
          <div style="color:var(--crow-text-muted);font-size:0.85rem">MP3, M4A, OGG, WAV</div>
          <input type="file" id="audio-file-input" accept="audio/*" style="display:none">
          <div id="audio-upload-status" style="margin-top:0.75rem;display:none"></div>
        </div>
        <input type="hidden" name="audio_url" id="audio-url-hidden">
        <div style="margin-top:0.5rem;font-size:0.85rem;color:var(--crow-text-muted)">
          Or enter a URL directly: <input type="text" id="audio-url-manual" placeholder="https://example.com/episode.mp3" style="margin-left:0.25rem;padding:0.3rem 0.5rem;border:1px solid var(--crow-border);border-radius:4px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem;width:60%">
        </div>
      </div>`
    : formField("Audio URL", "audio_url", { required: true, placeholder: "https://example.com/episode.mp3" });

  // Artwork upload — only when storage is online
  const artworkField = storageOnline
    ? `<div class="form-group" style="margin-bottom:1rem">
        <label style="display:block;font-weight:500;margin-bottom:0.5rem">Episode Artwork <span style="color:var(--crow-text-muted);font-weight:400">(optional)</span></label>
        <div style="display:flex;align-items:center;gap:1rem">
          <div id="artwork-preview" style="width:64px;height:64px;border-radius:6px;background:var(--crow-bg-elevated,#1a1a2e);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
            <span style="opacity:0.3;font-size:1.5rem">&#127912;</span>
          </div>
          <div style="flex:1">
            <button type="button" id="artwork-upload-btn" class="btn btn-sm btn-secondary">Upload Image</button>
            <input type="file" id="artwork-file-input" accept="image/jpeg,image/png" style="display:none">
            <span id="artwork-upload-status" style="margin-left:0.5rem;font-size:0.85rem"></span>
          </div>
        </div>
        <input type="hidden" name="artwork_url" id="artwork-url-hidden">
      </div>`
    : "";

  // Create form
  const createForm = `<form method="POST" id="create-episode-form">
    <input type="hidden" name="action" value="create">
    ${formField("Title", "title", { required: true, placeholder: "Episode title" })}
    ${audioField}
    ${artworkField}
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
    <button type="submit" class="btn btn-primary" id="create-episode-btn">Create Episode</button>
  </form>`;

  // Upload scripts — only when storage is online
  const uploadScript = storageOnline ? `<script>
(function() {
  // --- Audio upload ---
  var audioZone = document.getElementById('audio-upload-zone');
  var audioInput = document.getElementById('audio-file-input');
  var audioStatus = document.getElementById('audio-upload-status');
  var audioUrlHidden = document.getElementById('audio-url-hidden');
  var audioUrlManual = document.getElementById('audio-url-manual');

  audioZone.addEventListener('click', function(e) { if (e.target.tagName !== 'INPUT') audioInput.click(); });
  audioZone.addEventListener('dragover', function(e) { e.preventDefault(); audioZone.style.borderColor = 'var(--crow-accent)'; audioZone.style.background = 'var(--crow-accent-muted,rgba(99,102,241,0.08))'; });
  audioZone.addEventListener('dragleave', function() { audioZone.style.borderColor = ''; audioZone.style.background = ''; });
  audioZone.addEventListener('drop', function(e) {
    e.preventDefault();
    audioZone.style.borderColor = '';
    audioZone.style.background = '';
    if (e.dataTransfer.files.length > 0) uploadAudio(e.dataTransfer.files[0]);
  });
  audioInput.addEventListener('change', function() { if (this.files.length > 0) uploadAudio(this.files[0]); });

  // Manual URL overrides uploaded file
  audioUrlManual.addEventListener('input', function() { audioUrlHidden.value = this.value; });

  function uploadAudio(file) {
    if (!file.type.startsWith('audio/')) {
      audioStatus.style.display = 'block';
      audioStatus.style.color = 'var(--crow-error,#ef4444)';
      audioStatus.textContent = 'Please select an audio file';
      return;
    }
    audioStatus.style.display = 'block';
    audioStatus.style.color = '';
    audioStatus.textContent = 'Uploading ' + file.name + '...';

    var fd = new FormData();
    fd.append('file', file);
    fd.append('reference_type', 'podcast_episode');

    fetch('/storage/upload', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) throw new Error(d.error);
        var fileUrl = location.origin + '/storage/file/' + encodeURIComponent(d.key);
        audioUrlHidden.value = fileUrl;
        audioUrlManual.value = '';
        audioStatus.style.color = 'var(--crow-success,#22c55e)';
        audioStatus.textContent = '\\u2713 ' + d.name + ' (' + (d.size / 1024 / 1024).toFixed(1) + ' MB)';
        audioZone.style.borderColor = 'var(--crow-success,#22c55e)';
      })
      .catch(function(err) {
        audioStatus.style.color = 'var(--crow-error,#ef4444)';
        audioStatus.textContent = 'Upload failed: ' + (err.message || err);
      });
  }

  // --- Artwork upload ---
  var artworkBtn = document.getElementById('artwork-upload-btn');
  var artworkInput = document.getElementById('artwork-file-input');
  var artworkStatus = document.getElementById('artwork-upload-status');
  var artworkUrlHidden = document.getElementById('artwork-url-hidden');
  var artworkPreview = document.getElementById('artwork-preview');

  if (artworkBtn) {
    artworkBtn.addEventListener('click', function() { artworkInput.click(); });
    artworkInput.addEventListener('change', function() { if (this.files.length > 0) uploadArtwork(this.files[0]); });
  }

  function uploadArtwork(file) {
    if (!file.type.startsWith('image/')) {
      artworkStatus.style.color = 'var(--crow-error,#ef4444)';
      artworkStatus.textContent = 'Please select a JPEG or PNG image';
      return;
    }
    artworkStatus.style.color = '';
    artworkStatus.textContent = 'Uploading...';

    var fd = new FormData();
    fd.append('file', file);
    fd.append('reference_type', 'podcast_artwork');

    fetch('/storage/upload', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) throw new Error(d.error);
        var fileUrl = location.origin + '/storage/file/' + encodeURIComponent(d.key);
        artworkUrlHidden.value = fileUrl;
        artworkPreview.textContent = '';
        var img = document.createElement('img');
        img.src = fileUrl;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover';
        artworkPreview.appendChild(img);
        artworkStatus.style.color = 'var(--crow-success,#22c55e)';
        artworkStatus.textContent = '\\u2713 Uploaded';
      })
      .catch(function(err) {
        artworkStatus.style.color = 'var(--crow-error,#ef4444)';
        artworkStatus.textContent = 'Failed: ' + (err.message || err);
      });
  }

  // --- Form validation ---
  document.getElementById('create-episode-form').addEventListener('submit', function(e) {
    if (!audioUrlHidden.value && !audioUrlManual.value) {
      e.preventDefault();
      audioStatus.style.display = 'block';
      audioStatus.style.color = 'var(--crow-error,#ef4444)';
      audioStatus.textContent = 'Please upload an audio file or enter a URL';
      audioZone.style.borderColor = 'var(--crow-error,#ef4444)';
    } else if (audioUrlManual.value && !audioUrlHidden.value) {
      audioUrlHidden.value = audioUrlManual.value;
    }
  });
})();
<\\/script>` : "";

  const content = `
    ${stats}
    ${feedSection}
    ${section("Episodes", episodeTable, { delay: 150 })}
    ${section("New Episode", createForm, { delay: 200 })}
    ${uploadScript}
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
