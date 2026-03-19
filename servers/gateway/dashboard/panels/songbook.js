/**
 * Songbook Panel — Song list, stats, add song form, setlist manager
 */

import { escapeHtml, statCard, statGrid, dataTable, section, formField, badge, formatDate } from "../shared/components.js";
import { parseSongMeta } from "../../../blog/chordpro.js";
import { generateSlug } from "../../../blog/renderer.js";

export default {
  id: "songbook",
  name: "Songbook",
  icon: "music",
  route: "/dashboard/songbook",
  navOrder: 21,

  async handler(req, res, { db, layout, lang }) {
    const view = req.query.view || "songs";

    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "create_song") {
        const { title, content, tags, visibility } = req.body;
        if (!title || !content) {
          return layout({
            title: "Songbook",
            content: `<div class="alert alert-error">Title and ChordPro content are required.</div>`,
          });
        }
        let slug = generateSlug(title);
        // Ensure uniqueness
        let suffix = 2;
        while (true) {
          const existing = await db.execute({ sql: "SELECT id FROM blog_posts WHERE slug = ?", args: [slug] });
          if (existing.rows.length === 0) break;
          slug = `${generateSlug(title)}-${suffix++}`;
        }
        const tagList = new Set((tags || "").split(",").map((t) => t.trim()).filter(Boolean));
        tagList.add("songbook");
        const finalTags = [...tagList].join(",");

        // Author fallback from blog settings
        let author = null;
        const authorSetting = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_author'", args: [] });
        if (authorSetting.rows.length > 0 && authorSetting.rows[0].value) {
          author = authorSetting.rows[0].value;
        }

        await db.execute({
          sql: "INSERT INTO blog_posts (slug, title, content, visibility, tags, author) VALUES (?, ?, ?, ?, ?, ?)",
          args: [slug, title, content, visibility || "private", finalTags, author],
        });
        res.redirect("/dashboard/songbook");
        return;
      }

      if (action === "delete_song") {
        await db.execute({ sql: "DELETE FROM blog_posts WHERE id = ?", args: [req.body.id] });
        res.redirect("/dashboard/songbook");
        return;
      }

      if (action === "create_setlist") {
        const { name, description, visibility } = req.body;
        if (!name) {
          res.redirect("/dashboard/songbook?view=setlists");
          return;
        }
        await db.execute({
          sql: "INSERT INTO songbook_setlists (name, description, visibility) VALUES (?, ?, ?)",
          args: [name, description || null, visibility || "private"],
        });
        res.redirect("/dashboard/songbook?view=setlists");
        return;
      }

      if (action === "delete_setlist") {
        await db.execute({ sql: "DELETE FROM songbook_setlists WHERE id = ?", args: [req.body.id] });
        res.redirect("/dashboard/songbook?view=setlists");
        return;
      }
    }

    // --- Stats ---
    const songCount = await db.execute(
      "SELECT COUNT(*) as c FROM blog_posts WHERE tags LIKE '%songbook%'"
    );
    const publishedCount = await db.execute(
      "SELECT COUNT(*) as c FROM blog_posts WHERE tags LIKE '%songbook%' AND status = 'published'"
    );
    const setlistCount = await db.execute(
      "SELECT COUNT(*) as c FROM songbook_setlists"
    );

    const stats = statGrid([
      statCard("Songs", songCount.rows[0]?.c || 0, { delay: 0 }),
      statCard("Published", publishedCount.rows[0]?.c || 0, { delay: 50 }),
      statCard("Setlists", setlistCount.rows[0]?.c || 0, { delay: 100 }),
    ]);

    // --- View tabs ---
    const tabs = `<div style="display:flex;gap:4px;margin-bottom:1.5rem">
      <a href="/dashboard/songbook" class="btn btn-sm ${view === "songs" ? "btn-primary" : "btn-secondary"}">Songs</a>
      <a href="/dashboard/songbook?view=setlists" class="btn btn-sm ${view === "setlists" ? "btn-primary" : "btn-secondary"}">Setlists</a>
    </div>`;

    if (view === "setlists") {
      return renderSetlistsView(db, layout, stats, tabs);
    }

    return renderSongsView(db, layout, stats, tabs, lang);
  },
};

async function renderSongsView(db, layout, stats, tabs, lang) {
  const songs = await db.execute({
    sql: "SELECT id, slug, title, status, visibility, tags, content, published_at, created_at FROM blog_posts WHERE tags LIKE '%songbook%' ORDER BY created_at DESC LIMIT 50",
    args: [],
  });

  let songTable;
  if (songs.rows.length === 0) {
    songTable = `<div class="empty-state"><h3>No songs yet</h3><p>Add your first song below.</p></div>`;
  } else {
    const rows = songs.rows.map((p) => {
      const meta = parseSongMeta(p.content);
      const statusBadge = badge(p.status, p.status === "published" ? "published" : "draft");
      const deleteBtn = `<form method="POST" style="display:inline" onsubmit="return confirm('Delete this song?')"><input type="hidden" name="action" value="delete_song"><input type="hidden" name="id" value="${p.id}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`;
      return [
        `<a href="/blog/songbook/${escapeHtml(p.slug)}" target="_blank" style="color:var(--crow-text-primary);text-decoration:none">${escapeHtml(p.title)}</a>`,
        escapeHtml(meta.artist || ""),
        `<span class="mono">${escapeHtml(meta.key || "")}</span>`,
        statusBadge,
        `<span class="mono">${formatDate(p.created_at, lang)}</span>`,
        deleteBtn,
      ];
    });
    songTable = dataTable(["Title", "Artist", "Key", "Status", "Created", ""], rows);
  }

  // Add song form
  const addForm = `<details style="margin-top:1.5rem">
    <summary style="cursor:pointer;font-weight:600;color:var(--crow-accent);padding:0.5rem 0">+ Add Song</summary>
    <form method="POST" style="margin-top:1rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:12px;padding:1.5rem">
      <input type="hidden" name="action" value="create_song">
      ${formField("Title", "title", { required: true, placeholder: "Song title" })}
      ${formField("ChordPro Content", "content", { type: "textarea", required: true, rows: 12, placeholder: "{title: My Song}\\n{key: Am}\\n\\n{sov}\\n[Am]First line [C]of the [G]song\\n{eov}" })}
      ${formField("Tags", "tags", { placeholder: "folk, jazz (songbook auto-added)" })}
      ${formField("Visibility", "visibility", {
        type: "select",
        value: "private",
        options: [
          { value: "private", label: "Private" },
          { value: "public", label: "Public" },
          { value: "peers", label: "Peers" },
        ],
      })}
      <button type="submit" class="btn btn-primary">Create Song</button>
    </form>
  </details>`;

  return layout({
    title: "Songbook",
    content: `${stats}${tabs}${songTable}${addForm}`,
  });
}

async function renderSetlistsView(db, layout, stats, tabs) {
  const setlists = await db.execute({
    sql: `SELECT s.*, COUNT(si.id) as song_count
          FROM songbook_setlists s
          LEFT JOIN songbook_setlist_items si ON si.setlist_id = s.id
          GROUP BY s.id
          ORDER BY s.updated_at DESC LIMIT 50`,
    args: [],
  });

  let setlistTable;
  if (setlists.rows.length === 0) {
    setlistTable = `<div class="empty-state"><h3>No setlists yet</h3><p>Create your first setlist below.</p></div>`;
  } else {
    const rows = setlists.rows.map((s) => {
      const visBadge = badge(s.visibility, s.visibility === "public" ? "published" : "draft");
      const viewLink = s.visibility !== "private"
        ? `<a href="/blog/songbook/setlist/${s.id}" target="_blank" class="btn btn-sm btn-secondary">View</a> `
        : "";
      const deleteBtn = `<form method="POST" style="display:inline" onsubmit="return confirm('Delete this setlist?')"><input type="hidden" name="action" value="delete_setlist"><input type="hidden" name="id" value="${s.id}"><button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`;
      return [
        escapeHtml(s.name),
        String(s.song_count),
        visBadge,
        `<span class="mono">${escapeHtml(s.updated_at || "")}</span>`,
        `${viewLink}${deleteBtn}`,
      ];
    });
    setlistTable = dataTable(["Name", "Songs", "Visibility", "Updated", ""], rows);
  }

  // Add setlist form
  const addForm = `<details style="margin-top:1.5rem">
    <summary style="cursor:pointer;font-weight:600;color:var(--crow-accent);padding:0.5rem 0">+ Create Setlist</summary>
    <form method="POST" style="margin-top:1rem;background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:12px;padding:1.5rem">
      <input type="hidden" name="action" value="create_setlist">
      ${formField("Name", "name", { required: true, placeholder: "Friday Night Set" })}
      ${formField("Description", "description", { placeholder: "Optional description" })}
      ${formField("Visibility", "visibility", {
        type: "select",
        value: "private",
        options: [
          { value: "private", label: "Private" },
          { value: "public", label: "Public" },
          { value: "peers", label: "Peers" },
        ],
      })}
      <button type="submit" class="btn btn-primary">Create Setlist</button>
    </form>
  </details>`;

  return layout({
    title: "Songbook — Setlists",
    content: `${stats}${tabs}${setlistTable}${addForm}`,
  });
}
