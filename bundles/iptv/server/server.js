/**
 * Crow IPTV MCP Server
 *
 * IPTV channel management — M3U playlists, EPG, favorites.
 *
 * Factory function: createIptvServer(db, options?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseM3U } from "./m3u-parser.js";
import { parseXMLTV } from "./epg-parser.js";

/**
 * Fetch a URL with a 10s timeout.
 * Returns { ok, text, error }.
 */
async function safeFetch(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { ok: false, text: null, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const text = await res.text();
    return { ok: true, text, error: null };
  } catch (err) {
    return { ok: false, text: null, error: err.name === "AbortError" ? "Request timed out (10s)" : err.message };
  }
}

export function createIptvServer(db, options = {}) {
  const server = new McpServer(
    { name: "crow-iptv", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- crow_iptv_add_playlist ---
  server.tool(
    "crow_iptv_add_playlist",
    "Add an M3U playlist by URL. Fetches, parses, and imports all channels.",
    {
      url: z.string().max(2000).describe("URL of the M3U/M3U8 playlist"),
      name: z.string().max(500).describe("Display name for this playlist"),
      auto_refresh: z.boolean().optional().default(false).describe("Automatically refresh this playlist periodically"),
    },
    async ({ url, name, auto_refresh }) => {
      // Fetch the playlist
      const result = await safeFetch(url);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to fetch playlist: ${result.error}` }],
          isError: true,
        };
      }

      // Parse channels
      const channels = parseM3U(result.text);
      if (channels.length === 0) {
        return {
          content: [{ type: "text", text: "No channels found in the playlist. Check that the URL points to a valid M3U file." }],
          isError: true,
        };
      }

      // Insert playlist
      const playlistResult = await db.execute({
        sql: `INSERT INTO iptv_playlists (name, url, auto_refresh, channel_count, last_refreshed_at)
              VALUES (?, ?, ?, ?, datetime('now'))`,
        args: [name, url, auto_refresh ? 1 : 0, channels.length],
      });
      const playlistId = Number(playlistResult.lastInsertRowid);

      // Insert channels
      for (const ch of channels) {
        await db.execute({
          sql: `INSERT INTO iptv_channels (playlist_id, name, stream_url, logo_url, group_title, tvg_id, tvg_name)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [playlistId, ch.name, ch.streamUrl, ch.logoUrl, ch.groupTitle, ch.tvgId, ch.tvgName],
        });
      }

      // Collect unique groups
      const groups = [...new Set(channels.map(c => c.groupTitle).filter(Boolean))];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            playlist_id: playlistId,
            name,
            url,
            channel_count: channels.length,
            groups,
            auto_refresh,
          }, null, 2),
        }],
      };
    }
  );

  // --- crow_iptv_list_playlists ---
  server.tool(
    "crow_iptv_list_playlists",
    "List all IPTV playlists with channel counts.",
    {},
    async () => {
      const result = await db.execute({
        sql: "SELECT id, name, url, auto_refresh, last_refreshed_at, channel_count, created_at FROM iptv_playlists ORDER BY created_at DESC",
      });
      return {
        content: [{
          type: "text",
          text: result.rows.length === 0
            ? "No playlists added yet. Use crow_iptv_add_playlist to add one."
            : JSON.stringify(result.rows, null, 2),
        }],
      };
    }
  );

  // --- crow_iptv_channels ---
  server.tool(
    "crow_iptv_channels",
    "Browse IPTV channels with optional filters. Returns current EPG info when available.",
    {
      playlist_id: z.number().optional().describe("Filter by playlist ID"),
      group: z.string().max(500).optional().describe("Filter by group/category"),
      search: z.string().max(500).optional().describe("Search channels by name"),
      favorites_only: z.boolean().optional().default(false).describe("Show only favorited channels"),
      limit: z.number().min(1).max(200).optional().default(50).describe("Max results"),
      offset: z.number().min(0).optional().default(0).describe("Pagination offset"),
    },
    async ({ playlist_id, group, search, favorites_only, limit, offset }) => {
      const conditions = [];
      const args = [];

      if (playlist_id !== undefined) {
        conditions.push("c.playlist_id = ?");
        args.push(playlist_id);
      }
      if (group) {
        conditions.push("c.group_title = ?");
        args.push(group);
      }
      if (search) {
        conditions.push("c.name LIKE ?");
        args.push(`%${search}%`);
      }
      if (favorites_only) {
        conditions.push("c.is_favorite = 1");
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT c.id, c.name, c.stream_url, c.logo_url, c.group_title, c.tvg_id, c.is_favorite,
                     c.playlist_id, p.name as playlist_name
              FROM iptv_channels c
              LEFT JOIN iptv_playlists p ON c.playlist_id = p.id
              ${where}
              ORDER BY c.is_favorite DESC, c.group_title, c.name
              LIMIT ? OFFSET ?`,
        args: [...args, limit, offset],
      });

      // Enrich with current EPG info
      const now = new Date().toISOString();
      const enriched = [];
      for (const ch of result.rows) {
        const row = { ...ch };
        if (ch.tvg_id) {
          const epg = await db.execute({
            sql: `SELECT title, start_time, end_time FROM iptv_epg
                  WHERE channel_tvg_id = ? AND start_time <= ? AND end_time > ?
                  LIMIT 1`,
            args: [ch.tvg_id, now, now],
          });
          if (epg.rows.length > 0) {
            row.now_playing = epg.rows[0].title;
            row.now_playing_end = epg.rows[0].end_time;
          }
        }
        enriched.push(row);
      }

      // Get total count
      const countResult = await db.execute({
        sql: `SELECT COUNT(*) as total FROM iptv_channels c ${where}`,
        args: args,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            channels: enriched,
            total: countResult.rows[0]?.total ?? 0,
            limit,
            offset,
          }, null, 2),
        }],
      };
    }
  );

  // --- crow_iptv_epg ---
  server.tool(
    "crow_iptv_epg",
    "Get EPG (Electronic Program Guide) for a channel.",
    {
      channel_id: z.number().describe("Channel ID"),
      hours_ahead: z.number().min(1).max(48).optional().default(6).describe("Hours of programming to show (default 6)"),
    },
    async ({ channel_id, hours_ahead }) => {
      // Look up the channel's tvg_id
      const channel = await db.execute({
        sql: "SELECT id, name, tvg_id FROM iptv_channels WHERE id = ?",
        args: [channel_id],
      });
      if (channel.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Channel not found (ID: ${channel_id})` }],
          isError: true,
        };
      }
      const ch = channel.rows[0];
      if (!ch.tvg_id) {
        return {
          content: [{ type: "text", text: `Channel "${ch.name}" has no EPG ID (tvg_id). EPG data is unavailable.` }],
        };
      }

      const now = new Date().toISOString();
      const endTime = new Date(Date.now() + hours_ahead * 60 * 60 * 1000).toISOString();

      const epg = await db.execute({
        sql: `SELECT title, description, start_time, end_time, category, icon_url
              FROM iptv_epg
              WHERE channel_tvg_id = ? AND end_time > ? AND start_time < ?
              ORDER BY start_time`,
        args: [ch.tvg_id, now, endTime],
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            channel: ch.name,
            tvg_id: ch.tvg_id,
            programs: epg.rows,
            hours_ahead,
          }, null, 2),
        }],
      };
    }
  );

  // --- crow_iptv_stream_url ---
  server.tool(
    "crow_iptv_stream_url",
    "Get the stream URL for a channel.",
    {
      channel_id: z.number().describe("Channel ID"),
    },
    async ({ channel_id }) => {
      const result = await db.execute({
        sql: "SELECT id, name, stream_url, logo_url, group_title FROM iptv_channels WHERE id = ?",
        args: [channel_id],
      });
      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Channel not found (ID: ${channel_id})` }],
          isError: true,
        };
      }
      const ch = result.rows[0];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            channel_id: ch.id,
            name: ch.name,
            stream_url: ch.stream_url,
            logo_url: ch.logo_url,
            group: ch.group_title,
          }, null, 2),
        }],
      };
    }
  );

  // --- crow_iptv_favorite ---
  server.tool(
    "crow_iptv_favorite",
    "Add or remove a channel from favorites.",
    {
      channel_id: z.number().describe("Channel ID"),
      action: z.enum(["add", "remove"]).describe("Add or remove from favorites"),
    },
    async ({ channel_id, action }) => {
      const channel = await db.execute({
        sql: "SELECT id, name, is_favorite FROM iptv_channels WHERE id = ?",
        args: [channel_id],
      });
      if (channel.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Channel not found (ID: ${channel_id})` }],
          isError: true,
        };
      }

      const newVal = action === "add" ? 1 : 0;
      await db.execute({
        sql: "UPDATE iptv_channels SET is_favorite = ? WHERE id = ?",
        args: [newVal, channel_id],
      });

      const ch = channel.rows[0];
      return {
        content: [{
          type: "text",
          text: `${action === "add" ? "Added" : "Removed"} "${ch.name}" ${action === "add" ? "to" : "from"} favorites.`,
        }],
      };
    }
  );

  return server;
}
