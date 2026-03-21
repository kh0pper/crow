/**
 * Crow's Nest Panel — IPTV: channel grid, group filters, favorites
 *
 * Bundle-compatible version: uses dynamic imports with appRoot instead of
 * static ESM imports, so this panel works both from the repo and when
 * installed to ~/.crow/panels/.
 */

const CHANNELS_PER_PAGE = 48;

export default {
  id: "iptv",
  name: "IPTV",
  icon: "tv",
  route: "/dashboard/iptv",
  navOrder: 25,
  category: "media",

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    // Query params
    const search = req.query.search || "";
    const group = req.query.group || "";
    const favOnly = req.query.favorites === "true";
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const offset = (page - 1) * CHANNELS_PER_PAGE;

    // Build query
    const conditions = [];
    const args = [];

    if (search) {
      conditions.push("c.name LIKE ?");
      args.push(`%${search}%`);
    }
    if (group) {
      conditions.push("c.group_title = ?");
      args.push(group);
    }
    if (favOnly) {
      conditions.push("c.is_favorite = 1");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch channels
    const channelsResult = await db.execute({
      sql: `SELECT c.id, c.name, c.stream_url, c.logo_url, c.group_title, c.tvg_id, c.is_favorite,
                   p.name as playlist_name
            FROM iptv_channels c
            LEFT JOIN iptv_playlists p ON c.playlist_id = p.id
            ${where}
            ORDER BY c.is_favorite DESC, c.group_title, c.name
            LIMIT ? OFFSET ?`,
      args: [...args, CHANNELS_PER_PAGE, offset],
    });

    // Total count
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as total FROM iptv_channels c ${where}`,
      args,
    });
    const total = countResult.rows[0]?.total ?? 0;
    const totalPages = Math.ceil(total / CHANNELS_PER_PAGE);

    // Fetch groups for filter dropdown
    const groupsResult = await db.execute({
      sql: "SELECT DISTINCT group_title FROM iptv_channels WHERE group_title IS NOT NULL ORDER BY group_title",
    });
    const groups = groupsResult.rows.map(r => r.group_title);

    // Playlist count
    const playlistCount = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM iptv_playlists",
    });

    // Build channel cards
    let cardsHtml = "";
    if (channelsResult.rows.length === 0) {
      cardsHtml = `<div style="text-align:center;padding:3rem;color:var(--crow-text-secondary)">
        ${total === 0 && !search && !group && !favOnly
          ? "No channels yet. Add a playlist via AI or the IPTV settings."
          : "No channels match your filters."}
      </div>`;
    } else {
      cardsHtml = channelsResult.rows.map(ch => {
        const name = escapeHtml(ch.name || "Unnamed");
        const groupBadge = ch.group_title
          ? `<span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:9px;background:var(--crow-accent-muted);color:var(--crow-accent)">${escapeHtml(ch.group_title)}</span>`
          : "";
        const favStar = ch.is_favorite ? '<span style="color:#fbbf24;font-size:1.1rem" title="Favorite">&#9733;</span>' : "";
        const logo = ch.logo_url
          ? `<img src="${escapeHtml(ch.logo_url)}" alt="" style="width:48px;height:48px;object-fit:contain;border-radius:6px;background:var(--crow-surface)" loading="lazy" onerror="this.style.display='none'">`
          : `<div style="width:48px;height:48px;border-radius:6px;background:var(--crow-surface);display:flex;align-items:center;justify-content:center;font-size:1.4rem;color:var(--crow-text-secondary)">&#128250;</div>`;

        return `<div style="background:var(--crow-card-bg);border:1px solid var(--crow-border);border-radius:10px;padding:0.75rem;display:flex;gap:0.75rem;align-items:center">
          ${logo}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:0.4rem">
              <span style="font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
              ${favStar}
            </div>
            <div style="display:flex;gap:0.3rem;margin-top:0.25rem;flex-wrap:wrap">${groupBadge}</div>
          </div>
          <div style="display:flex;gap:0.3rem;flex-shrink:0">
            <form method="POST" action="/dashboard/iptv/favorite" style="margin:0">
              <input type="hidden" name="channel_id" value="${ch.id}">
              <input type="hidden" name="action" value="${ch.is_favorite ? "remove" : "add"}">
              <button type="submit" title="${ch.is_favorite ? "Remove from favorites" : "Add to favorites"}" style="background:none;border:1px solid var(--crow-border);border-radius:6px;padding:0.25rem 0.5rem;cursor:pointer;font-size:0.8rem;color:var(--crow-text-secondary)">${ch.is_favorite ? "&#9733;" : "&#9734;"}</button>
            </form>
            <a href="/api/iptv/stream/${ch.id}" target="_blank" rel="noopener" title="Open stream" style="display:inline-flex;align-items:center;justify-content:center;background:var(--crow-accent);color:white;border:none;border-radius:6px;padding:0.25rem 0.5rem;font-size:0.75rem;text-decoration:none">&#9654;</a>
          </div>
        </div>`;
      }).join("");
    }

    // Group filter options
    const groupOptions = groups.map(g =>
      `<option value="${escapeHtml(g)}"${g === group ? " selected" : ""}>${escapeHtml(g)}</option>`
    ).join("");

    // Pagination
    let paginationHtml = "";
    if (totalPages > 1) {
      const prevPage = page > 1 ? page - 1 : 1;
      const nextPage = page < totalPages ? page + 1 : totalPages;
      const buildUrl = (p) => {
        const params = new URLSearchParams();
        if (search) params.set("search", search);
        if (group) params.set("group", group);
        if (favOnly) params.set("favorites", "true");
        params.set("page", String(p));
        return `?${params.toString()}`;
      };
      paginationHtml = `<div style="display:flex;justify-content:center;gap:0.5rem;margin-top:1rem">
        <a href="${buildUrl(prevPage)}" style="padding:0.3rem 0.7rem;border:1px solid var(--crow-border);border-radius:6px;text-decoration:none;color:var(--crow-text-secondary);font-size:0.8rem">&laquo; Prev</a>
        <span style="padding:0.3rem 0.5rem;font-size:0.8rem;color:var(--crow-text-secondary)">Page ${page} of ${totalPages}</span>
        <a href="${buildUrl(nextPage)}" style="padding:0.3rem 0.7rem;border:1px solid var(--crow-border);border-radius:6px;text-decoration:none;color:var(--crow-text-secondary);font-size:0.8rem">Next &raquo;</a>
      </div>`;
    }

    const content = `
      <div style="max-width:960px;margin:0 auto;padding:1rem">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem">
          <h2 style="margin:0;font-size:1.2rem">IPTV Channels</h2>
          <span style="font-size:0.8rem;color:var(--crow-text-secondary)">${total} channel${total !== 1 ? "s" : ""} &middot; ${playlistCount.rows[0]?.cnt ?? 0} playlist${(playlistCount.rows[0]?.cnt ?? 0) !== 1 ? "s" : ""}</span>
        </div>

        <form method="GET" action="/dashboard/iptv" style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap">
          <input type="text" name="search" placeholder="Search channels..." value="${escapeHtml(search)}"
                 style="flex:1;min-width:160px;padding:0.4rem 0.6rem;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-surface);color:var(--crow-text);font-size:0.85rem">
          <select name="group" style="padding:0.4rem 0.6rem;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-surface);color:var(--crow-text);font-size:0.85rem">
            <option value="">All Groups</option>
            ${groupOptions}
          </select>
          <label style="display:flex;align-items:center;gap:0.3rem;font-size:0.8rem;color:var(--crow-text-secondary)">
            <input type="checkbox" name="favorites" value="true"${favOnly ? " checked" : ""}> Favorites
          </label>
          <button type="submit" style="padding:0.4rem 0.8rem;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-accent);color:white;font-size:0.8rem;cursor:pointer">Filter</button>
        </form>

        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0.5rem">
          ${cardsHtml}
        </div>

        ${paginationHtml}
      </div>
    `;

    return res.send(layout({ title: "IPTV", content }));
  },
};
