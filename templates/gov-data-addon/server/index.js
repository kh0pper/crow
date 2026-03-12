#!/usr/bin/env node

/**
 * {{NAME}} Government Data MCP Server
 *
 * Template for building government data MCP servers as Crow add-ons.
 * Provides tools for searching and retrieving public government datasets.
 *
 * Usage: node server/index.js (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  {
    name: "{{STATE_OR_FED}}-gov-data",
    version: "1.0.0",
  },
  {
    instructions: "Government data server for {{NAME}}. Provides tools to search and retrieve public datasets.",
  }
);

// --- Data Source Registry ---
// Add your government data sources here. Each source has:
// - id: unique identifier
// - name: human-readable name
// - baseUrl: API endpoint
// - description: what data this source provides
// - rateLimit: requests per minute (respect API limits)

const DATA_SOURCES = [
  // Example:
  // {
  //   id: "education",
  //   name: "Department of Education",
  //   baseUrl: "https://api.example.gov/v1",
  //   description: "K-12 and higher education statistics",
  //   rateLimit: 60,
  // },
];

// --- Rate Limiter ---
const requestCounts = new Map();

function checkRateLimit(sourceId, limit) {
  const now = Date.now();
  const key = sourceId;
  const entry = requestCounts.get(key) || { count: 0, resetAt: now + 60000 };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }

  if (entry.count >= limit) {
    throw new Error(`Rate limit exceeded for ${sourceId}. Try again in ${Math.ceil((entry.resetAt - now) / 1000)}s.`);
  }

  entry.count++;
  requestCounts.set(key, entry);
}

// --- Cache ---
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
  // Prune old entries
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].time - b[1].time);
    for (let i = 0; i < 20; i++) cache.delete(oldest[i][0]);
  }
}

// --- Tools ---

server.tool(
  "list_sources",
  "List available government data sources",
  {},
  async () => {
    const sources = DATA_SOURCES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    }));
    return { content: [{ type: "text", text: JSON.stringify(sources, null, 2) }] };
  }
);

server.tool(
  "search_datasets",
  "Search for datasets across government sources",
  {
    query: z.string().max(200).describe("Search query"),
    source_id: z.string().max(50).optional().describe("Filter by source ID"),
    limit: z.number().min(1).max(50).default(10).describe("Number of results"),
  },
  async ({ query, source_id, limit }) => {
    // Template: implement search against your data sources
    // Example pattern:
    //
    // const sources = source_id
    //   ? DATA_SOURCES.filter((s) => s.id === source_id)
    //   : DATA_SOURCES;
    //
    // const results = [];
    // for (const source of sources) {
    //   checkRateLimit(source.id, source.rateLimit);
    //   const cacheKey = `search:${source.id}:${query}`;
    //   let data = getCached(cacheKey);
    //   if (!data) {
    //     const resp = await fetch(`${source.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    //     data = await resp.json();
    //     setCache(cacheKey, data);
    //   }
    //   results.push(...data.results);
    // }
    //
    // return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };

    return {
      content: [{ type: "text", text: "Template: implement search_datasets for your government data sources." }],
    };
  }
);

server.tool(
  "get_dataset",
  "Retrieve a specific dataset by ID",
  {
    source_id: z.string().max(50).describe("Data source ID"),
    dataset_id: z.string().max(200).describe("Dataset identifier"),
  },
  async ({ source_id, dataset_id }) => {
    // Template: implement dataset retrieval
    return {
      content: [{ type: "text", text: "Template: implement get_dataset for your government data sources." }],
    };
  }
);

// --- Start Server ---
const transport = new StdioServerTransport();
await server.connect(transport);
