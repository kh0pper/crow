/**
 * Dozzle MCP Server
 *
 * Dozzle is primarily a web UI; its HTTP surface is a mix of template-rendered
 * pages and WebSocket log streams, not a clean JSON API. This bundle therefore
 * exposes only the minimum tools that work without reverse-engineering the
 * WebSocket protocol: liveness, URL, and a container-log shortcut.
 *
 * For programmatic log access the operator shells into the target container
 * (`docker logs <name>`) or uses Netdata's log collection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DOZZLE_URL = () =>
  (process.env.DOZZLE_URL || "http://localhost:8095").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

async function checkHealth() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${DOZZLE_URL()}/healthcheck`, { signal: ctl.signal });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out");
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Dozzle at ${DOZZLE_URL()} — is the container running?`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function createDozzleServer(options = {}) {
  const server = new McpServer(
    { name: "crow-dozzle", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- dozzle_status ---
  server.tool(
    "dozzle_status",
    "Check whether the Dozzle log viewer is running and reachable",
    {},
    async () => {
      try {
        const { ok, status } = await checkHealth();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              url: DOZZLE_URL(),
              reachable: ok,
              http_status: status,
              web_ui: DOZZLE_URL() + "/",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- dozzle_container_url ---
  server.tool(
    "dozzle_container_url",
    "Build a Dozzle URL that deep-links straight to a container's live log stream. Returns the URL for the operator to open in a browser.",
    {
      container: z.string().min(1).max(200).describe('Container name or ID (e.g., "crow-caddy", "crow-netdata")'),
    },
    async ({ container }) => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(container)) {
        return { content: [{ type: "text", text: "Error: container name may only contain letters, numbers, ., _ and -" }] };
      }
      const url = `${DOZZLE_URL()}/container/${encodeURIComponent(container)}`;
      return {
        content: [{
          type: "text",
          text: `Open in your browser:\n${url}\n\nDozzle will stream this container's logs live.`,
        }],
      };
    }
  );

  return server;
}
