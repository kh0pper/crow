/**
 * SearXNG MCP Server
 *
 * Tools:
 *   - searxng_search        Run a metasearch query; return top 10 results
 *   - searxng_list_engines  List engines configured in this instance
 *   - searxng_status        Check reachability + healthz
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SEARXNG_URL = () => (process.env.SEARXNG_BASE_URL || "http://localhost:8098/").replace(/\/+$/, "");

async function sxFetch(path, { timeoutMs = 15000 } = {}) {
  const url = `${SEARXNG_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`SearXNG ${res.status}: ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`SearXNG request timed out: ${path}`);
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach SearXNG at ${SEARXNG_URL()} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function createSearxngServer(options = {}) {
  const server = new McpServer(
    { name: "crow-searxng", version: "1.0.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "searxng_search",
    "Run a metasearch query via SearXNG and return the top results. SearXNG aggregates answers from multiple engines (Google, DuckDuckGo, Wikipedia, etc.) without tracking.",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
      categories: z.string().max(200).optional().describe("Comma-separated categories (e.g. 'general', 'it', 'science', 'news')"),
      engines: z.string().max(200).optional().describe("Comma-separated engine names to restrict the search to (e.g. 'duckduckgo,wikipedia')"),
      language: z.string().max(10).optional().default("en").describe("Language code (e.g. 'en', 'es', 'de')"),
      pageno: z.number().min(1).max(10).optional().default(1).describe("Page number"),
      limit: z.number().min(1).max(30).optional().default(10).describe("Max results to return"),
    },
    async ({ query, categories, engines, language, pageno, limit }) => {
      try {
        const params = new URLSearchParams({
          q: query,
          format: "json",
          language,
          pageno: String(pageno),
        });
        if (categories) params.set("categories", categories);
        if (engines) params.set("engines", engines);

        const data = await sxFetch(`/search?${params}`);
        const results = (Array.isArray(data?.results) ? data.results : []).slice(0, limit).map((r) => ({
          title: r.title || null,
          url: r.url || null,
          content: r.content ? r.content.slice(0, 500) : null,
          engine: r.engine || null,
          category: r.category || null,
          score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : null,
          publishedDate: r.publishedDate || null,
        }));
        const infoboxes = (Array.isArray(data?.infoboxes) ? data.infoboxes : []).slice(0, 2).map((i) => ({
          title: i.infobox || i.title || null,
          content: i.content ? i.content.slice(0, 500) : null,
          engine: i.engine || null,
        }));

        return {
          content: [{
            type: "text",
            text: results.length
              ? JSON.stringify({
                  query,
                  number_of_results: data?.number_of_results || results.length,
                  results,
                  infoboxes: infoboxes.length ? infoboxes : undefined,
                }, null, 2)
              : `No results for "${query}"`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "searxng_list_engines",
    "List the search engines configured in this SearXNG instance",
    {
      enabled_only: z.boolean().optional().default(true).describe("Return only engines that are currently enabled (default true)"),
    },
    async ({ enabled_only }) => {
      try {
        const data = await sxFetch("/config");
        const engines = Array.isArray(data?.engines) ? data.engines : [];
        const filtered = enabled_only ? engines.filter((e) => !e.disabled) : engines;
        const summary = filtered.map((e) => ({
          name: e.name,
          categories: e.categories || [],
          shortcut: e.shortcut || null,
          disabled: !!e.disabled,
        }));
        return {
          content: [{
            type: "text",
            text: summary.length
              ? `${summary.length} engine(s):\n${JSON.stringify(summary, null, 2)}`
              : "No engines returned by /config.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "searxng_status",
    "Check whether SearXNG is reachable and responding to healthz",
    {},
    async () => {
      try {
        const url = SEARXNG_URL();
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${url}/healthz`, { signal: controller.signal });
        clearTimeout(t);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ url, reachable: res.ok, http_status: res.status }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}
