/**
 * Immich MCP Server
 *
 * Provides tools to interact with an Immich photo library:
 * - Search photos by text, date, or location
 * - List and browse albums
 * - Get photo metadata and thumbnails
 * - Manage albums (create, add/remove assets)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const IMMICH_URL = process.env.IMMICH_URL || "http://localhost:2283";
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || "";

async function immichFetch(path, options = {}) {
  const url = `${IMMICH_URL}/api${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": IMMICH_API_KEY,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Immich API error ${res.status}: ${text}`);
  }
  return res.json();
}

export function createImmichServer() {
  const server = new McpServer({
    name: "crow-immich",
    version: "1.0.0",
  });

  // Search photos
  server.tool(
    "immich_search_photos",
    "Search photos by text query, date range, or location",
    {
      query: z.string().max(500).optional().describe("Text search query (searches CLIP embeddings and metadata)"),
      startDate: z.string().max(30).optional().describe("Start date (ISO 8601, e.g. 2024-01-01)"),
      endDate: z.string().max(30).optional().describe("End date (ISO 8601)"),
      city: z.string().max(100).optional().describe("Filter by city name"),
      country: z.string().max(100).optional().describe("Filter by country"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Max results (default 20)"),
    },
    async ({ query, startDate, endDate, city, country, limit }) => {
      if (!IMMICH_API_KEY) {
        return { content: [{ type: "text", text: "Immich not configured. Set IMMICH_URL and IMMICH_API_KEY." }] };
      }

      const body = {
        type: "IMAGE",
        ...(query && { query }),
        ...(startDate && { takenAfter: new Date(startDate).toISOString() }),
        ...(endDate && { takenBefore: new Date(endDate).toISOString() }),
        ...(city && { city }),
        ...(country && { country }),
      };

      // Use smart search for text queries, metadata search otherwise
      const endpoint = query ? "/search/smart" : "/search/metadata";
      const searchBody = query
        ? { query, type: "IMAGE", ...(limit && { size: limit }) }
        : { ...body, size: limit };

      const data = await immichFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(searchBody),
      });

      const assets = query ? (data.items || []) : (data.assets?.items || []);
      const results = assets.slice(0, limit).map((a) => ({
        id: a.id,
        filename: a.originalFileName,
        date: a.localDateTime || a.fileCreatedAt,
        city: a.exifInfo?.city,
        country: a.exifInfo?.country,
        description: a.exifInfo?.description,
        width: a.exifInfo?.exifImageWidth,
        height: a.exifInfo?.exifImageHeight,
      }));

      return {
        content: [{
          type: "text",
          text: results.length > 0
            ? `Found ${results.length} photo(s):\n${JSON.stringify(results, null, 2)}`
            : "No photos found matching your search.",
        }],
      };
    }
  );

  // List albums
  server.tool(
    "immich_list_albums",
    "List all photo albums",
    {},
    async () => {
      if (!IMMICH_API_KEY) {
        return { content: [{ type: "text", text: "Immich not configured. Set IMMICH_URL and IMMICH_API_KEY." }] };
      }

      const albums = await immichFetch("/albums");
      const list = albums.map((a) => ({
        id: a.id,
        name: a.albumName,
        assetCount: a.assetCount,
        startDate: a.startDate,
        endDate: a.endDate,
      }));

      return {
        content: [{
          type: "text",
          text: list.length > 0
            ? `${list.length} album(s):\n${JSON.stringify(list, null, 2)}`
            : "No albums found.",
        }],
      };
    }
  );

  // Get album details
  server.tool(
    "immich_get_album",
    "Get album details including asset list",
    {
      albumId: z.string().max(100).describe("Album ID"),
    },
    async ({ albumId }) => {
      if (!IMMICH_API_KEY) {
        return { content: [{ type: "text", text: "Immich not configured. Set IMMICH_URL and IMMICH_API_KEY." }] };
      }

      const album = await immichFetch(`/albums/${encodeURIComponent(albumId)}`);
      const assets = (album.assets || []).map((a) => ({
        id: a.id,
        filename: a.originalFileName,
        date: a.localDateTime || a.fileCreatedAt,
        type: a.type,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            name: album.albumName,
            description: album.description,
            assetCount: album.assetCount,
            startDate: album.startDate,
            endDate: album.endDate,
            assets: assets.slice(0, 50),
          }, null, 2),
        }],
      };
    }
  );

  // Get photo metadata
  server.tool(
    "immich_get_photo",
    "Get detailed metadata for a specific photo",
    {
      assetId: z.string().max(100).describe("Asset/photo ID"),
    },
    async ({ assetId }) => {
      if (!IMMICH_API_KEY) {
        return { content: [{ type: "text", text: "Immich not configured. Set IMMICH_URL and IMMICH_API_KEY." }] };
      }

      const asset = await immichFetch(`/assets/${encodeURIComponent(assetId)}`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: asset.id,
            filename: asset.originalFileName,
            date: asset.localDateTime || asset.fileCreatedAt,
            type: asset.type,
            isFavorite: asset.isFavorite,
            exif: asset.exifInfo ? {
              make: asset.exifInfo.make,
              model: asset.exifInfo.model,
              city: asset.exifInfo.city,
              state: asset.exifInfo.state,
              country: asset.exifInfo.country,
              description: asset.exifInfo.description,
              width: asset.exifInfo.exifImageWidth,
              height: asset.exifInfo.exifImageHeight,
              latitude: asset.exifInfo.latitude,
              longitude: asset.exifInfo.longitude,
            } : null,
          }, null, 2),
        }],
      };
    }
  );

  // Create album
  server.tool(
    "immich_create_album",
    "Create a new photo album",
    {
      name: z.string().max(200).describe("Album name"),
      description: z.string().max(1000).optional().describe("Album description"),
    },
    async ({ name, description }) => {
      if (!IMMICH_API_KEY) {
        return { content: [{ type: "text", text: "Immich not configured. Set IMMICH_URL and IMMICH_API_KEY." }] };
      }

      const album = await immichFetch("/albums", {
        method: "POST",
        body: JSON.stringify({
          albumName: name,
          ...(description && { description }),
        }),
      });

      return {
        content: [{
          type: "text",
          text: `Created album "${album.albumName}" (ID: ${album.id})`,
        }],
      };
    }
  );

  return server;
}
