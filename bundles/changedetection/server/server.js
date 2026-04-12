/**
 * Change Detection MCP Server
 *
 * Wraps the Change Detection REST API at /api/v1/. Auth is a single
 * `x-api-key` header — the API key is created under Settings > API in
 * the web UI.
 *
 * Tools:
 *   changedetection_list_watches   - list all tracked URLs
 *   changedetection_get_watch      - detail on one watch
 *   changedetection_create_watch   - add a new URL to watch
 *   changedetection_recheck        - trigger a recheck of one watch
 *   changedetection_list_changes   - list recent change events
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = () => (process.env.CHANGEDETECTION_URL || "http://localhost:5010").replace(/\/+$/, "");
const API_KEY = () => process.env.CHANGEDETECTION_API_KEY || "";

async function cdFetch(path, options = {}) {
  const url = BASE_URL() + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (!API_KEY()) throw new Error("CHANGEDETECTION_API_KEY is not set. Create one in the web UI under Settings > API.");
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "x-api-key": API_KEY(),
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("Authentication failed — check CHANGEDETECTION_API_KEY");
      if (res.status === 404) throw new Error("Not found: " + path);
      throw new Error("Change Detection API " + res.status + ": " + (text.slice(0, 200) || res.statusText));
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Change Detection request timed out after 15s: " + path);
    if (err.message && (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED"))) {
      throw new Error("Cannot reach Change Detection at " + BASE_URL() + " — is the container running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function formatTs(n) {
  if (!n || typeof n !== "number") return null;
  try {
    return new Date(n * 1000).toISOString();
  } catch {
    return null;
  }
}

function watchSummary(id, w) {
  return {
    id,
    url: w.url || null,
    title: w.title || null,
    paused: !!w.paused,
    last_checked: formatTs(w.last_checked),
    last_changed: formatTs(w.last_changed),
    last_error: w.last_error || null,
    tag: w.tag || null,
  };
}

export function createChangeDetectionServer(options = {}) {
  const server = new McpServer(
    { name: "crow-changedetection", version: "1.0.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "changedetection_list_watches",
    "List all configured watches (URLs being tracked) with their last-check and last-change timestamps.",
    {
      tag: z.string().max(200).optional().describe("Filter by tag/group name"),
    },
    async ({ tag }) => {
      try {
        const params = tag ? ("?tag=" + encodeURIComponent(tag)) : "";
        const data = await cdFetch("/api/v1/watch" + params);
        const entries = Object.entries(data || {}).map(([id, w]) => watchSummary(id, w));
        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? entries.length + " watch(es):\n" + JSON.stringify(entries, null, 2)
              : "No watches configured.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + err.message }] };
      }
    }
  );

  server.tool(
    "changedetection_get_watch",
    "Get full detail on a single watch, including configuration and last-check metadata.",
    {
      id: z.string().max(100).describe("Watch UUID (from list_watches)"),
    },
    async ({ id }) => {
      try {
        const w = await cdFetch("/api/v1/watch/" + encodeURIComponent(id));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id,
              url: w.url || null,
              title: w.title || null,
              paused: !!w.paused,
              last_checked: formatTs(w.last_checked),
              last_changed: formatTs(w.last_changed),
              last_error: w.last_error || null,
              tag: w.tag || null,
              time_between_check: w.time_between_check || null,
              fetch_backend: w.fetch_backend || null,
              include_filters: w.include_filters || null,
              notification_urls: w.notification_urls || null,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + err.message }] };
      }
    }
  );

  server.tool(
    "changedetection_create_watch",
    "Add a new URL to watch. Change Detection will begin polling it on its default schedule.",
    {
      url: z.string().url().max(2000).describe("URL to watch"),
      title: z.string().max(500).optional().describe("Friendly title (defaults to page title)"),
      tag: z.string().max(200).optional().describe("Tag/group name"),
    },
    async ({ url, title, tag }) => {
      try {
        const body = { url };
        if (title) body.title = title;
        if (tag) body.tag = tag;
        const result = await cdFetch("/api/v1/watch", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const id = result.uuid || result.id || (typeof result === "string" ? result : null);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              created: true,
              id,
              url,
              title: title || null,
              tag: tag || null,
              note: "The first check runs on the next scheduler tick; call changedetection_recheck to force an immediate fetch.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + err.message }] };
      }
    }
  );

  server.tool(
    "changedetection_recheck",
    "Trigger an immediate recheck of one watch. Returns once the request is queued (the fetch may still be running).",
    {
      id: z.string().max(100).describe("Watch UUID"),
    },
    async ({ id }) => {
      try {
        const result = await cdFetch("/api/v1/watch/" + encodeURIComponent(id) + "?recheck=1", { method: "GET" });
        // Some versions expose /recheck explicitly; fall back if the above is rejected.
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ id, recheck_queued: true, response: result }, null, 2),
          }],
        };
      } catch (err) {
        // Fall back to /api/v1/watch/<id>/recheck if the query-param form fails
        try {
          const result = await cdFetch("/api/v1/watch/" + encodeURIComponent(id) + "/recheck", { method: "GET" });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ id, recheck_queued: true, response: result }, null, 2),
            }],
          };
        } catch (err2) {
          return { content: [{ type: "text", text: "Error: " + err.message }] };
        }
      }
    }
  );

  server.tool(
    "changedetection_list_changes",
    "List recent change events across all watches. Useful for 'what changed overnight?' queries.",
    {
      limit: z.number().int().min(1).max(100).optional().default(20).describe("Max entries to return (default 20)"),
    },
    async ({ limit }) => {
      try {
        const data = await cdFetch("/api/v1/watch");
        const entries = Object.entries(data || {})
          .map(([id, w]) => watchSummary(id, w))
          .filter((w) => w.last_changed)
          .sort((a, b) => (b.last_changed || "").localeCompare(a.last_changed || ""))
          .slice(0, limit);
        return {
          content: [{
            type: "text",
            text: entries.length > 0
              ? entries.length + " recently-changed watch(es):\n" + JSON.stringify(entries, null, 2)
              : "No watches have recorded changes yet.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + err.message }] };
      }
    }
  );

  return server;
}
